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
//   - If no valid token, show a "Sign in" button that redirects to Cognito.
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
  login,
  logout,
  type TokenSet,
} from './auth';

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
  | 'misconfigured';

interface AuthGateProps {
  children: ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<AuthState>('checking');
  const [token, setToken] = useState<TokenSet | null>(null);

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
          setToken(tokens);
          setState('authed');
        })
        .catch((err) => {
          console.error('[auth] Callback handling failed:', err);
          if (alive) setState('unauth');
        });
    } else {
      // No callback — user needs to log in.
      setState('unauth');
    }

    return () => { alive = false; };
  }, []);

  /* Token expiry timer: if the token expires while the app is open, transition
   * to 'expired' rather than silently losing auth. */
  useEffect(() => {
    if (!token || state !== 'authed') return;
    const remaining = token.received_at + token.expires_in * 1000 - Date.now();
    if (remaining <= 30_000) {
      setState('expired');
      return;
    }
    const timer = setTimeout(() => setState('expired'), remaining - 30_000);
    return () => clearTimeout(timer);
  }, [token, state]);

  const handleLogin = useCallback(() => { login(); }, []);
  const handleLogout = useCallback(() => {
    setToken(null);
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

        {state === 'unauth' && (
          <>
            <p className="auth-gate-status">Admin access required.</p>
            <button className="auth-gate-btn" onClick={handleLogin} type="button">
              Sign in
            </button>
          </>
        )}

        {state === 'expired' && (
          <>
            <p className="auth-gate-status">Session expired.</p>
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
