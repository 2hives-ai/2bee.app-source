// Auth gate — wraps the app and shows a login screen when unauthenticated.
//
// 🔴 THERE ARE THREE CONFIG STATES, NOT TWO, AND THIS HEADER SAID TWO.
//
// It read: "When Cognito is not configured (env vars missing), the gate is
// OPEN". That was the contract a reader took from the top of the file, and it
// was true only of ALL THREE vars being absent. With SOME set, `readConfig()`
// also returned null and the gate ALSO opened — so a deployment with one typo'd
// variable name served the whole app unauthenticated, silently, looking exactly
// like the intended local-development mode. Corrected 2026-08-27; the rule now
// reads the same here as it does in the mount effect below, which is the point
// of correcting it rather than fixing only the code.
//
//   absent      no var set     -> gate OPEN. Local dev, CI and the e2e suite.
//   partial     some set       -> REFUSES, names what is missing. Never opens.
//   configured  all three set  -> the Cognito flow below.
//
// When Cognito IS configured:
//   - On load, check for a callback (?code=...) and exchange it for tokens.
//   - If no valid token, show the landing page (`Landing.tsx`, 2026-11-17) whose
//     "Sign in" button redirects to Cognito. Until 2026-11-17 this was a bare card.
//   - If token exists but is expired, show "Session expired — sign in again".
//   - If token exists and user is not admin, show "Admin access required".
//   - If all checks pass, render children (the real app).
//
// Tokens live in component state only — no localStorage, no sessionStorage
// for the tokens themselves. PKCE verifier/state use sessionStorage (they
// must survive the redirect round-trip but nothing longer).

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  authConfigState,
  authVarsMissing,
  authVarsPresent,
  handleCallback,
  isAdmin,
  isTokenExpired,
  loadTokens,
  saveTokens,
  clearTokens,
  login,
  logout,
  type TokenSet,
} from './auth';
import Landing from './Landing';
import { OUTCOME_TEXT, enrolPasskey, isEnrolRoute, probeSession, signInWithPasskey } from './passkeyAuth';

/** Auth state machine:
 *  'checking'  — initial load, checking URL for callback
 *  'unauth'    — no token, show login
 *  'not-admin' — authenticated but not in the admin group
 *  'expired'   — token expired
 *  'authed'    — valid admin token, show the app */
type AuthState =
  | 'checking'
  | 'unauth'
  | 'not-admin'
  | 'expired'
  | 'authed'
  /** Some Cognito vars set and some not — see the mount effect. Never opens. */
  | 'misconfigured'
  /** Opened at #enrol with an operator's one-time code (docs/design-local-auth.md §5). Never opens the app. */
  | 'enrol';

interface AuthGateProps {
  children: ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<AuthState>('checking');
  const [token, setToken] = useState<TokenSet | null>(null);
  // Passkey sign-in (founder 2026-11-23, "go on local auth"; design v2 signed off by cyber).
  // `passkeyReady` is true only once the server's own /api/auth/session answered JSON, so the
  // button never appears before backend ships the routes.
  const [passkeyReady, setPasskeyReady] = useState(false);
  const [passkeyExpiresAt, setPasskeyExpiresAt] = useState(0);
  const [passkeyMsg, setPasskeyMsg] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [enrolCode, setEnrolCode] = useState('');
  const [enrolLabel, setEnrolLabel] = useState('');

  /* On mount: check for callback code, then check for existing token. */
  useEffect(() => {
    // 🔴 `absent` OPENS THE GATE. `partial` MUST NOT, AND USED TO.
    //
    // This read `if (!authIsConfigured())`, and `authIsConfigured()` was false
    // for BOTH "no Cognito vars at all" (local dev, CI, the e2e suite) and "two
    // of the three set" — so one typo'd variable name in a deploy served the
    // whole app to anyone, silently, looking exactly like intended dev
    // behaviour. TODO #29's rule is "only admins can log in"; the failure mode
    // of a misconfiguration was "everyone can".
    const cfg = authConfigState();
    if (cfg === 'absent') {
      setState('authed');
      return;
    }
    if (cfg === 'partial') {
      setState('misconfigured');
      return;
    }

    let alive = true;

    if (isEnrolRoute(window.location.hash)) {
      setState('enrol');
      return () => { alive = false; };
    }

    // A passkey session (an HttpOnly cookie this page cannot read) is asked of the server.
    // Only the server's own 200 with an admin session opens the gate; see passkeyAuth.ts.
    void probeSession().then((p) => {
      if (!alive) return;
      if (p.state === 'absent') return;
      setPasskeyReady(true);
      if (p.state === 'signed-in') {
        setPasskeyExpiresAt(p.session.expiresAt);
        setState('authed');
      }
    });

    // Check if the URL contains an authorization code from Cognito.
    const url = new URL(window.location.href);
    if (url.searchParams.has('code')) {
      handleCallback()
        .then((tokens) => {
          if (!alive) return;
          if (!tokens) {
            setState('unauth');
            return;
          }
          if (isTokenExpired(tokens)) {
            setState('expired');
            return;
          }
          if (!isAdmin(tokens)) {
            setToken(tokens);
            setState('not-admin');
            return;
          }
          saveTokens(tokens);
          setToken(tokens);
          setState('authed');
        })
        .catch((err) => {
          console.error('[auth] Callback handling failed:', err);
          if (alive) setState('unauth');
        });
    } else {
      // No callback: a token this TAB stored before a refresh, re-checked, or sign in.
      const stored = loadTokens();
      if (stored && !isTokenExpired(stored) && isAdmin(stored)) {
        setToken(stored);
        setState('authed');
      } else {
        clearTokens();
        setState(stored ? 'expired' : 'unauth');
      }
    }

    return () => { alive = false; };
  }, []);

  /* Passkey session expiry: the server's absolute limit, read once at sign-in. The server
   * also refuses an expired cookie; this only stops the page pretending it is still signed in. */
  useEffect(() => {
    if (token || state !== 'authed' || passkeyExpiresAt <= 0) return;
    const remaining = passkeyExpiresAt * 1000 - Date.now();
    if (remaining <= 0) { setState('expired'); return; }
    const timer = setTimeout(() => setState('expired'), Math.min(remaining, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [token, state, passkeyExpiresAt]);

  /* Token expiry timer: if the token expires while the app is open, transition
   * to 'expired' rather than silently losing auth. */
  useEffect(() => {
    if (!token || state !== 'authed') return;
    const remaining = token.received_at + token.expires_in * 1000 - Date.now();
    if (remaining <= 30_000) {
      clearTokens();
      setState('expired');
      return;
    }
    const timer = setTimeout(() => { clearTokens(); setState('expired'); }, remaining - 30_000);
    return () => clearTimeout(timer);
  }, [token, state]);

  const handleLogin = useCallback(() => { login(); }, []);
  const handlePasskey = useCallback(async () => {
    setPasskeyBusy(true);
    setPasskeyMsg('');
    const out = await signInWithPasskey();
    if (out === 'ok') {
      const p = await probeSession();
      if (p.state === 'signed-in') {
        setPasskeyExpiresAt(p.session.expiresAt);
        setState('authed');
      } else {
        setPasskeyMsg(OUTCOME_TEXT.failed);
      }
    } else {
      setPasskeyMsg(OUTCOME_TEXT[out]);
    }
    setPasskeyBusy(false);
  }, []);
  const handleEnrol = useCallback(async () => {
    setPasskeyBusy(true);
    setPasskeyMsg('');
    const out = await enrolPasskey(enrolCode, enrolLabel);
    setPasskeyBusy(false);
    if (out === 'ok') {
      setEnrolCode('');
      setPasskeyMsg('Passkey added. Sign in with it now.');
      window.history.replaceState(null, '', window.location.pathname);
      setPasskeyReady(true);
      setState('unauth');
    } else {
      setPasskeyMsg(out === 'failed' ? 'That code did not work. Ask for a new one.' : OUTCOME_TEXT[out]);
    }
  }, [enrolCode, enrolLabel]);
  const handleLogout = useCallback(() => {
    setToken(null);
    clearTokens();
    logout();
  }, []);

  // Gate is open — render the app.
  if (state === 'authed') {
    return <>{children}</>;
  }

  // Not configured AT ALL — gate is open (dev/CI mode).
  //
  // ⚠ THE SAFETY NET IS NOW NARROWER THAN THE EFFECT ABOVE, DELIBERATELY. It
  // used to call `authIsConfigured()`, which is ALSO false for a partial
  // config — so even after the mount effect refused, this net would have
  // rendered the app anyway. A second copy of a safety decision is a second
  // place to be wrong, and this one disagreed with the first.
  if (authConfigState() === 'absent') {
    return <>{children}</>;
  }

  // Logged out: the landing page (founder 2026-11-17, "create a landing page").
  // It renders no app and opens nothing; its only way forward is the same
  // `login()` redirect the card's button used.
  if (state === 'unauth') {
    return (
      <Landing
        onSignIn={handleLogin}
        onPasskey={passkeyReady ? () => void handlePasskey() : undefined}
        passkeyBusy={passkeyBusy}
        passkeyMsg={passkeyMsg}
      />
    );
  }

  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <div className="auth-gate-brand">
          <strong>2bee.app</strong>
        </div>

        {state === 'checking' && (
          <p className="auth-gate-status">Checking credentials&hellip;</p>
        )}

        {/* 🔴 NO SIGN-IN BUTTON HERE, AND THAT IS THE POINT. There is nothing
            the viewer can do: the deployment is wrong, not their session. A
            button would send them to a Cognito domain that is half-specified
            and return them to this same screen, which reads as "auth is
            broken" rather than "this build was deployed wrong". */}
        {state === 'misconfigured' && (
          <>
            <p className="auth-gate-status" data-testid="auth-misconfigured">
              This build is deployed with an incomplete sign-in configuration, so
              it will not open. Missing: {authVarsMissing().join(', ')}. Set:{' '}
              {authVarsPresent().join(', ')}.
            </p>
            <p className="auth-gate-status">
              Set all three, or none of them — none is the local-development
              mode and runs without sign-in. A partly-configured build refuses
              rather than serving the app unauthenticated.
            </p>
          </>
        )}

        {state === 'enrol' && (
          <form
            className="auth-gate-enrol"
            data-testid="auth-enrol"
            onSubmit={(e) => { e.preventDefault(); void handleEnrol(); }}
          >
            <p className="auth-gate-status">Add a passkey with the one-time code you were given.</p>
            <label>
              Code
              <input value={enrolCode} onChange={(e) => setEnrolCode(e.target.value)} autoComplete="one-time-code" required />
            </label>
            <label>
              Name for this device
              <input value={enrolLabel} onChange={(e) => setEnrolLabel(e.target.value)} maxLength={40} placeholder="Laptop" />
            </label>
            <button className="auth-gate-btn" type="submit" disabled={passkeyBusy || enrolCode.trim() === ''}>
              {passkeyBusy ? 'Waiting for the passkey…' : 'Add passkey'}
            </button>
            {passkeyMsg && <p className="auth-gate-status" role="status">{passkeyMsg}</p>}
          </form>
        )}

        {state === 'expired' && (
          <>
            <p className="auth-gate-status">Session expired.</p>
            {passkeyReady && (
              <button className="auth-gate-btn" onClick={() => void handlePasskey()} type="button" disabled={passkeyBusy}>
                Sign in with passkey
              </button>
            )}
            {passkeyMsg && <p className="auth-gate-status" role="status">{passkeyMsg}</p>}
            <button className="auth-gate-btn" onClick={handleLogin} type="button">
              Sign in again
            </button>
          </>
        )}

        {state === 'not-admin' && (
          <>
            <p className="auth-gate-status">
              Signed in, but admin access is required.
            </p>
            <button className="auth-gate-btn" onClick={handleLogout} type="button">
              Sign out
            </button>
          </>
        )}

        {/* 🔴 AGPL §13 SOURCE OFFER — and this is the ONLY link an anonymous
            visitor ever sees. The whole app sits behind this gate, so the offer
            is not a footer under the tool: it is the first thing a stranger
            meets, before authentication.
            ⚠ It pointed at `github.com/2bee-farm/2bee.slicer` until 2026-09-09,
            which 404'd — a dead offer on the public face of the domain. The
            mirror `legal` ruled is now published and the founder has given the
            go-word; VERIFIED FROM THIS SEAT before the edit, anonymously and
            with no auth header: repo 200, LICENSE 200 whose first lines read
            "GNU AFFERO GENERAL PUBLIC LICENSE Version 3" (checked by CONTENT,
            not by the filename existing), MIRROR.md 200, and the tag
            `src-8483971c40` resolving — a tag whose bound monorepo commit
            exists in this tree. */}
        <p className="auth-gate-licence">
          AGPL-3.0-or-later &middot;{' '}
          <a href="https://github.com/2hives-ai/2bee.app-source" rel="noreferrer">
            source
          </a>
        </p>
      </div>
    </div>
  );
}
