// Cognito OIDC auth — Authorization Code + PKCE, entirely client-side.
//
// 2bee.app has no server. The Cognito Hosted UI handles the login form,
// MFA, password reset — everything that would need a backend. The browser
// redirects there, receives an authorization code at the callback URL,
// and exchanges it for tokens using PKCE (no client secret needed).
//
// Tokens are held in MEMORY ONLY — never localStorage, never sessionStorage.
// A page refresh loses the session and sends the user back to Cognito. This
// is deliberate: .app TLD is HSTS-preloaded (HTTPS mandatory), and a token
// in storage is a token that survives a tab close the operator did not intend
// to survive. The Cognito session cookie on the Hosted UI domain handles
// "remember me" — that is Cognito's job, not ours.
//
// ─────────────────────────────────────────────────────────────────────────────
// CROSS-DOMAIN NOTE
// ─────────────────────────────────────────────────────────────────────────────
//
// 2bee.app and 2bee.farm are different origins. No cookie, localStorage, or
// sessionStorage crosses between them. The login UI lives on 2bee.farm;
// 2bee.app receives the redirect. Cognito's own session on the Hosted UI
// domain is the only bridge.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
//
// Every value comes from VITE_ environment variables (Vite bakes these into
// the bundle at build time — they are NOT runtime env vars, because there is
// no server to read them from). See .env.example for the required set.
//
// The Cognito User Pool is the existing one from 2bee.farm. The App Client
// must be registered with:
//   - callback URL: https://2bee.app/ (or http://localhost:5178/ for dev)
//   - Allowed OAuth flows: Authorization code grant
//   - Allowed OAuth scopes: openid, email, profile
//   - NO client secret (public client — this is a SPA)

/** Base64url-encode an ArrayBuffer. Used for PKCE challenge and state. */
function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a cryptographically random string of `len` bytes, base64url-encoded. */
function randomBase64url(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return base64url(buf.buffer);
}

/** SHA-256 → base64url, for PKCE code_challenge. */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64url(hash);
}

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthConfig {
  /** Cognito domain, e.g. "2beefarm.auth.us-east-1.amazoncognito.com" */
  cognitoDomain: string;
  /** App client ID — registered in the Cognito User Pool */
  clientId: string;
  /** Where Cognito redirects back to. Must match the app client's callback URL. */
  redirectUri: string;
}

/** The three env vars, by the name a deployer types them under. */
const AUTH_VARS = [
  'VITE_COGNITO_DOMAIN',
  'VITE_COGNITO_CLIENT_ID',
  'VITE_COGNITO_REDIRECT_URI',
] as const;

/**
 * Which of the three are set, by name. Whitespace-only counts as absent — an
 * env var set to `" "` is a deployer who meant to fill it in.
 */
export function authVarsPresent(env?: Record<string, string | undefined>): string[] {
  /* ⚠ THE PARAMETER IS A TEST SEAM AND IS NOT OPTIONAL DECORATION. The node
   * suite runs these modules through a loader that replaces `import.meta.env`
   * with the literal `{}` (Vite owns it; Node does not have it), so WITHOUT a
   * seam the only reachable state from a unit test is `absent` — which is the
   * one state that was already safe. The bug being guarded here lives entirely
   * in `partial`, so a test that cannot construct `partial` cannot see it.
   * Production callers pass nothing and read the real env. */
  const e = (env ?? (import.meta.env as unknown as Record<string, string | undefined>) ?? {});
  return AUTH_VARS.filter((k) => String(e[k] ?? '').trim() !== '');
}

/**
 * 🔴 THREE STATES, NOT TWO, AND THE THIRD ONE USED TO FAIL OPEN.
 *
 * `readConfig` returned `null` when ANY of the three vars was missing, and
 * `AuthGate` reads `null` as *"auth is not configured — dev/CI, gate open"*.
 * So a deployment that set two of the three — one typo in a var name, one
 * value dropped by a secrets step — served the whole app **with no
 * authentication at all, silently, and looking exactly like the intended
 * local-dev behaviour.** The founder's rule for TODO #29 is *"only admins can
 * log in"*; the failure mode of a misconfiguration was *everyone can*.
 *
 * `absent` and `partial` are different facts and only the first is safe to
 * treat as open. `partial` is the one state this file must NOT resolve on its
 * own — it cannot know whether the operator meant to configure auth and
 * fumbled it, so it refuses and names the vars.
 */
export type AuthConfigState = 'absent' | 'partial' | 'configured';

export function authConfigState(env?: Record<string, string | undefined>): AuthConfigState {
  const present = authVarsPresent(env);
  if (present.length === 0) return 'absent';
  return present.length === AUTH_VARS.length ? 'configured' : 'partial';
}

/** The vars a `partial` config is MISSING — what the refusal must name. */
export function authVarsMissing(env?: Record<string, string | undefined>): string[] {
  const present = new Set(authVarsPresent(env));
  return AUTH_VARS.filter((k) => !present.has(k));
}

function readConfig(): AuthConfig | null {
  if (authConfigState() !== 'configured') return null;
  const env = (import.meta.env ?? {}) as unknown as Record<string, string | undefined>;
  return {
    cognitoDomain: String(env.VITE_COGNITO_DOMAIN).trim(),
    clientId: String(env.VITE_COGNITO_CLIENT_ID).trim(),
    redirectUri: String(env.VITE_COGNITO_REDIRECT_URI).trim(),
  };
}

/**
 * True when all three env vars are set — auth is configured and active.
 *
 * ⚠ THIS IS NOT THE SAME QUESTION AS *"may the gate open?"* — a `partial`
 * config answers `false` here and must NOT open the gate. Callers deciding
 * whether to serve the app read {@link authConfigState}; this one answers only
 * whether a login flow can be driven.
 */
export function authIsConfigured(): boolean {
  return readConfig() !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PKCE + STATE
// ─────────────────────────────────────────────────────────────────────────────
//
// PKCE prevents an attacker who intercepts the authorization code from
// exchanging it for tokens. The `code_verifier` never leaves the browser;
// only its SHA-256 `code_challenge` goes to Cognito. On the callback, the
// verifier is sent back so Cognito can confirm the same party initiated
// and completed the flow.
//
// The `state` parameter is a CSRF nonce: a random value sent in the redirect
// and checked on the callback. If it does not match, the callback was forged.

const PKCE_VERIFIER_KEY = 'auth_pkce_verifier';
const STATE_KEY = 'auth_state';

/** Store PKCE verifier and state in sessionStorage. Session-scoped, cleared on tab close. */
function storeAuthParams(verifier: string, state: string): void {
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
}

function consumeAuthParams(): { verifier: string; state: string } | null {
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  const state = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!verifier || !state) return null;
  return { verifier, state };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenSet {
  /** JWT ID token — identity claims */
  id_token: string;
  /** JWT Access token — API authorization */
  access_token: string;
  /** Seconds until expiry (from the token response, not from the JWT) */
  expires_in: number;
  /** When the token was received, in epoch ms */
  received_at: number;
}

/** Decode the payload of a JWT without verifying the signature.
 *  Signature verification is not needed here: we received this token directly
 *  from Cognito over HTTPS (the .app TLD is HSTS-preloaded), and the token
 *  is used only for client-side gating — it is never sent to a backend as
 *  proof of identity. If we ever add a backend, verify the signature there. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

export function isTokenExpired(token: TokenSet): boolean {
  const expiresAt = token.received_at + token.expires_in * 1000;
  // 30-second buffer: do not use a token that is about to expire.
  return Date.now() >= expiresAt - 30_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN CHECK
// ─────────────────────────────────────────────────────────────────────────────
//
// "Only admins can log in" — founder, TODO #29.
//
// Cognito can enforce this server-side (Pre Token Generation Lambda trigger,
// or a custom authoriser), but the task says CLIENT-SIDE check. The id_token
// carries a `cognito:groups` claim when the user belongs to a Cognito group.
// We check for an "admin" group membership.
//
// If the Cognito User Pool is set up without groups (e.g. only one user),
// ANY authenticated user is treated as admin. This is the "only admins can
// log in" constraint applied at the client — the pool itself should restrict
// membership to admins only.

export function isAdmin(token: TokenSet): boolean {
  const payload = decodeJwtPayload(token.id_token);
  const groups = payload['cognito:groups'];
  // If no groups claim exists, the pool might have a single admin user — allow it.
  // If groups DO exist, require "admin" membership.
  if (Array.isArray(groups)) {
    return groups.includes('admin');
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN: REDIRECT TO COGNITO HOSTED UI
// ─────────────────────────────────────────────────────────────────────────────

export async function login(): Promise<void> {
  const cfg = readConfig();
  if (!cfg) {
    console.error('[auth] Cognito not configured — set VITE_COGNITO_DOMAIN, VITE_COGNITO_CLIENT_ID, VITE_COGNITO_REDIRECT_URI');
    return;
  }

  const codeVerifier = randomBase64url(32);
  const codeChallenge = await sha256(codeVerifier);
  const state = randomBase64url(16);

  storeAuthParams(codeVerifier, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'openid email profile',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });

  window.location.href = `https://${cfg.cognitoDomain}/oauth2/authorize?${params}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT: REDIRECT TO COGNITO LOGOUT ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

export function logout(): void {
  const cfg = readConfig();
  if (!cfg) return;

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: cfg.redirectUri,
    response_type: 'code',
  });

  // Clear our in-memory tokens (handled by the caller via clearToken).
  window.location.href = `https://${cfg.cognitoDomain}/oauth2/logout?${params}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACK: EXCHANGE AUTHORIZATION CODE FOR TOKENS
// ─────────────────────────────────────────────────────────────────────────────
//
// Called on page load when the URL contains `?code=...&state=...` (the
// redirect from Cognito). Exchanges the code for tokens via the
// /oauth2/token endpoint and returns them. Clears the URL hash/query
// so the tokens are not visible in the address bar.

export async function handleCallback(): Promise<TokenSet | null> {
  const cfg = readConfig();
  if (!cfg) return null;

  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code) return null;

  const stored = consumeAuthParams();
  if (!stored) {
    console.error('[auth] No stored PKCE verifier — callback without a prior login redirect?');
    return null;
  }

  if (returnedState !== stored.state) {
    console.error('[auth] State mismatch — possible CSRF. Ignoring callback.');
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: stored.verifier,
  });

  const resp = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('[auth] Token exchange failed:', resp.status, text);
    return null;
  }

  const data = await resp.json();

  // Clean the URL — remove ?code=...&state=... so a reload does not re-attempt.
  window.history.replaceState({}, '', url.origin + url.pathname);

  return {
    id_token: data.id_token,
    access_token: data.access_token,
    expires_in: data.expires_in,
    received_at: Date.now(),
  };
}
