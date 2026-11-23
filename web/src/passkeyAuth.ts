// Passkey sign-in for 2bee.app: the browser half of docs/design-local-auth.md (v2).
//
// Founder 2026-11-23: "go on local auth" (no Cognito for 2bee.app). cyber signed v2 off the
// same day (ticket 2026-11-23-11-36-29). The server half is backend's: the routes below, a
// Lambda authorizer, DynamoDB tables and an operator CLI that mints enrolment codes.
//
// WHAT THIS FILE DOES, AND WHAT IT NEVER DOES
//   · Talks only to same-origin /api/auth/* (CloudFront rewrites it to the API). The session
//     is an HttpOnly cookie this code never sees; nothing here reads or stores a token.
//   · Sends no identifier to sign in: the passkey is discoverable, so the server never learns
//     an email or user name from this page.
//   · Never creates a user, never sends a role. Enrolment needs an operator's one-time code.
//   · Says "sign-in failed" for every server refusal, as the server does. It does not guess why.
//
// The passkey button shows only when GET /api/auth/session answers JSON (200 or 401). Until
// backend ships the routes, /api/* falls through to the static site and answers something
// else, so `probeSession` returns 'absent' and the page stays as it was.

export const AUTH_BASE = '/api/auth';
const HEADERS = { 'X-2bee': '1' } as const;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Session {
  userId: string;
  expiresAt: number;
}

/** 'signed-in' with a live admin session · 'signed-out' (server present, no session) ·
 *  'absent' (no passkey server at this origin yet, or it answered something unreadable). */
export type Probe = { state: 'signed-in'; session: Session } | { state: 'signed-out' } | { state: 'absent' };

// ── base64url <-> bytes ──────────────────────────────────────────────────────

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── RP ID: exactly this page's host, never a parent domain ───────────────────
// cyber 2026-11-23-11-50-59: WebAuthn lets a page on stage.2bee.app ask for the parent RP ID
// `2bee.app`, which would let staging request assertions for PRODUCTION passkeys. The server
// must never send that; this page also refuses it, so one misconfigured server is not enough.

function pageHost(): string {
  return typeof location !== 'undefined' ? location.hostname : '';
}

/** The rpId the server sent, if it is exactly `host`. Anything else throws, so no prompt is shown. */
export function checkRpId(rpId: unknown, host: string): string {
  if (typeof rpId !== 'string' || rpId === '' || rpId !== host) {
    throw new Error(`refused: rpId ${JSON.stringify(rpId)} is not this page's host ${JSON.stringify(host)}`);
  }
  return rpId;
}

// ── W3C JSON shapes -> the objects navigator.credentials wants ───────────────
// Written out rather than PublicKeyCredential.parse*FromJSON, which older Safari lacks.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

function descriptors(v: unknown): PublicKeyCredentialDescriptor[] {
  return (Array.isArray(v) ? v : []).map((d) => {
    const o = obj(d);
    return {
      type: 'public-key',
      id: b64urlToBytes(String(o.id ?? '')),
      ...(Array.isArray(o.transports) ? { transports: o.transports as AuthenticatorTransport[] } : {}),
    };
  });
}

export function requestOptionsFromJSON(j: unknown, host: string = pageHost()): PublicKeyCredentialRequestOptions {
  const o = obj(j);
  if (typeof o.challenge !== 'string') throw new Error('no challenge');
  return {
    challenge: b64urlToBytes(o.challenge),
    rpId: checkRpId(o.rpId, host),
    ...(typeof o.timeout === 'number' ? { timeout: o.timeout } : {}),
    allowCredentials: descriptors(o.allowCredentials),
    // The server asks for 'required'; this page never weakens it.
    userVerification: 'required',
  };
}

export function creationOptionsFromJSON(j: unknown, host: string = pageHost()): PublicKeyCredentialCreationOptions {
  const o = obj(j);
  const user = obj(o.user);
  const rp = obj(o.rp);
  if (typeof o.challenge !== 'string' || typeof user.id !== 'string') throw new Error('no challenge or user');
  return {
    challenge: b64urlToBytes(o.challenge),
    rp: { name: String(rp.name ?? '2bee.app'), id: checkRpId(rp.id, host) },
    user: { id: b64urlToBytes(user.id), name: String(user.name ?? ''), displayName: String(user.displayName ?? '') },
    pubKeyCredParams: (Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams : []).map((p) => ({
      type: 'public-key' as const,
      alg: Number(obj(p).alg),
    })),
    ...(typeof o.timeout === 'number' ? { timeout: o.timeout } : {}),
    excludeCredentials: descriptors(o.excludeCredentials),
    // cyber condition B: a discoverable credential with user verification, whatever the server sent.
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
  };
}

/** A PublicKeyCredential as the W3C JSON the server parses (py_webauthn parse_*_credential_json). */
export function credentialToJSON(c: PublicKeyCredential): Json {
  const r = c.response as AuthenticatorResponse & Partial<AuthenticatorAssertionResponse & AuthenticatorAttestationResponse>;
  const response: Json = { clientDataJSON: bytesToB64url(r.clientDataJSON) };
  if (r.authenticatorData) response.authenticatorData = bytesToB64url(r.authenticatorData);
  if (r.signature) response.signature = bytesToB64url(r.signature);
  if (r.userHandle) response.userHandle = bytesToB64url(r.userHandle);
  if (r.attestationObject) response.attestationObject = bytesToB64url(r.attestationObject);
  if (typeof r.getTransports === 'function') response.transports = r.getTransports();
  return {
    id: c.id,
    rawId: bytesToB64url(c.rawId),
    type: c.type,
    response,
    clientExtensionResults: typeof c.getClientExtensionResults === 'function' ? c.getClientExtensionResults() : {},
    ...(c.authenticatorAttachment ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
  };
}

// ── calls ────────────────────────────────────────────────────────────────────

async function post(fetchImpl: FetchLike, path: string, body: unknown): Promise<Response> {
  return fetchImpl(`${AUTH_BASE}/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(r: Response): Promise<unknown> {
  if (!(r.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return undefined;
  try {
    return await r.json();
  } catch {
    return undefined;
  }
}

const defaultFetch: FetchLike = (u, i) => fetch(u, i);

/** Is there a passkey server here, and a session? Never throws. */
export async function probeSession(fetchImpl: FetchLike = defaultFetch): Promise<Probe> {
  let r: Response;
  try {
    r = await fetchImpl(`${AUTH_BASE}/session`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { ...HEADERS } });
  } catch {
    return { state: 'absent' };
  }
  const j = obj(await json(r));
  if (r.status === 200 && typeof j.userId === 'string' && j.userId !== '' && j.admin === true) {
    return { state: 'signed-in', session: { userId: j.userId, expiresAt: Number(j.expiresAt) || 0 } };
  }
  // Only the contract's own 401 shape proves a server is here. A 200 without an admin session
  // (the static site's index.html, or a malformed answer) is NOT a session.
  if (r.status === 401 && j.error === 'unauthenticated') return { state: 'signed-out' };
  return { state: 'absent' };
}

export type Outcome = 'ok' | 'failed' | 'cancelled' | 'unsupported' | 'offline' | 'rate-limited';

/** What to tell the person for each outcome. One message per outcome, none of them guesses. */
export const OUTCOME_TEXT: Record<Exclude<Outcome, 'ok'>, string> = {
  failed: 'Sign-in failed.',
  cancelled: 'Cancelled. Nothing was sent.',
  unsupported: 'This browser cannot use passkeys.',
  offline: 'Could not reach the server.',
  'rate-limited': 'Too many tries. Wait a few minutes.',
};

function hasWebAuthn(creds: CredentialsContainer | undefined): creds is CredentialsContainer {
  return !!creds && typeof PublicKeyCredential !== 'undefined';
}

function refused(r: Response): Outcome {
  return r.status === 429 ? 'rate-limited' : 'failed';
}

/** A browser "no" (NotAllowedError/AbortError) is the person cancelling or timing out. */
function browserNo(e: unknown): Outcome {
  const n = (e as { name?: unknown } | null)?.name;
  return n === 'NotAllowedError' || n === 'AbortError' ? 'cancelled' : 'failed';
}

/** Sign in with a discoverable passkey. On 'ok' the server has set the session cookie. */
export async function signInWithPasskey(
  fetchImpl: FetchLike = defaultFetch,
  creds: CredentialsContainer | undefined = typeof navigator !== 'undefined' ? navigator.credentials : undefined,
  host: string = pageHost(),
): Promise<Outcome> {
  if (!hasWebAuthn(creds)) return 'unsupported';
  let opts: PublicKeyCredentialRequestOptions;
  try {
    const r = await post(fetchImpl, 'challenge', {});
    if (!r.ok) return refused(r);
    opts = requestOptionsFromJSON(obj(await json(r)).publicKey, host);
  } catch (e) {
    return e instanceof TypeError ? 'offline' : 'failed';
  }
  let cred: PublicKeyCredential | null;
  try {
    cred = (await creds.get({ publicKey: opts })) as PublicKeyCredential | null;
  } catch (e) {
    return browserNo(e);
  }
  if (!cred) return 'cancelled';
  try {
    const r = await post(fetchImpl, 'assert', { credential: credentialToJSON(cred) });
    return r.status === 204 || r.status === 200 ? 'ok' : refused(r);
  } catch {
    return 'offline';
  }
}

/** Register a passkey with an operator's one-time code. Starts no session: sign in after. */
export async function enrolPasskey(
  code: string,
  label: string,
  fetchImpl: FetchLike = defaultFetch,
  creds: CredentialsContainer | undefined = typeof navigator !== 'undefined' ? navigator.credentials : undefined,
  host: string = pageHost(),
): Promise<Outcome> {
  const c = code.trim();
  if (!c) return 'failed';
  if (!hasWebAuthn(creds)) return 'unsupported';
  let opts: PublicKeyCredentialCreationOptions;
  try {
    const r = await post(fetchImpl, 'enrol/options', { code: c });
    if (!r.ok) return refused(r);
    opts = creationOptionsFromJSON(obj(await json(r)).publicKey, host);
  } catch (e) {
    return e instanceof TypeError ? 'offline' : 'failed';
  }
  let cred: PublicKeyCredential | null;
  try {
    cred = (await creds.create({ publicKey: opts })) as PublicKeyCredential | null;
  } catch (e) {
    return browserNo(e);
  }
  if (!cred) return 'cancelled';
  try {
    const r = await post(fetchImpl, 'enrol/finish', { code: c, credential: credentialToJSON(cred), label: label.trim().slice(0, 40) });
    return r.status === 204 || r.status === 200 ? 'ok' : refused(r);
  } catch {
    return 'offline';
  }
}

/** End this session (everywhere = every session of this user). Never throws. */
export async function signOutPasskey(everywhere = false, fetchImpl: FetchLike = defaultFetch): Promise<boolean> {
  try {
    const r = await post(fetchImpl, everywhere ? 'signout-all' : 'signout', {});
    return r.status === 204 || r.status === 200;
  } catch {
    return false;
  }
}

/** The page opened at #enrol: the operator handed out a code. */
export function isEnrolRoute(hash: string): boolean {
  return /^#enrol\b/.test(hash);
}
