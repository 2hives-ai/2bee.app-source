// Passkey sign-in, browser half (src/passkeyAuth.ts; docs/design-local-auth.md v2 §9).
//
// 🔴 What these guard:
//   · Only the server's own JSON opens anything. The static site's index.html (what /api/*
//     answers before backend ships) must read as 'absent', never as a session.
//   · No identifier, role or user id ever leaves this page. Sign-in sends `{}` then a credential.
//   · Discoverable credential + user verification are REQUIRED whatever the server sent
//     (cyber condition B).
//   · Every call is same-origin under /api/auth/ with X-2bee: 1 (cyber condition D, CSRF header).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64urlToBytes,
  bytesToB64url,
  creationOptionsFromJSON,
  enrolPasskey,
  isEnrolRoute,
  probeSession,
  requestOptionsFromJSON,
  signInWithPasskey,
  signOutPasskey,
} from '../src/passkeyAuth.ts';

(globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential ??= class {};

type Call = { url: string; init: RequestInit; body: unknown };
const J = { 'content-type': 'application/json' };

function server(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const h = routes[url];
    if (!h) throw new TypeError('Failed to fetch');
    return h();
  };
  return { f, calls };
}

const bytes = (...n: number[]) => new Uint8Array(n);
const CHAL = bytesToB64url(bytes(1, 2, 3, 250, 251, 252));

function fakeCred(kind: 'get' | 'create') {
  const response: Record<string, unknown> = { clientDataJSON: bytes(9, 9).buffer };
  if (kind === 'get') {
    response.authenticatorData = bytes(7).buffer;
    response.signature = bytes(8).buffer;
    response.userHandle = bytes(5, 5).buffer;
  } else {
    response.attestationObject = bytes(6).buffer;
    response.getTransports = () => ['internal'];
  }
  return { id: 'cred-1', rawId: bytes(4, 2).buffer, type: 'public-key', response, getClientExtensionResults: () => ({}) };
}

function creds(opts: { fail?: string } = {}) {
  const seen: { get?: CredentialRequestOptions; create?: CredentialCreationOptions } = {};
  const c = {
    async get(o: CredentialRequestOptions) {
      seen.get = o;
      if (opts.fail) throw Object.assign(new Error('no'), { name: opts.fail });
      return fakeCred('get');
    },
    async create(o: CredentialCreationOptions) {
      seen.create = o;
      if (opts.fail) throw Object.assign(new Error('no'), { name: opts.fail });
      return fakeCred('create');
    },
  } as unknown as CredentialsContainer;
  return { c, seen };
}

test('base64url round-trips and refuses padding/garbage', () => {
  const b = bytes(0, 255, 62, 63, 251);
  assert.deepEqual(b64urlToBytes(bytesToB64url(b)), b);
  assert.throws(() => b64urlToBytes('ab+/'));
});

test('probe: only the contract shapes count; the static site\'s index.html is ABSENT, never a session', async () => {
  const ok = server({ '/api/auth/session': () => new Response(JSON.stringify({ userId: 'u1', admin: true, expiresAt: 99 }), { status: 200, headers: J }) });
  assert.deepEqual(await probeSession(ok.f), { state: 'signed-in', session: { userId: 'u1', expiresAt: 99 } });

  const out = server({ '/api/auth/session': () => new Response('{"error":"unauthenticated"}', { status: 401, headers: J }) });
  assert.deepEqual(await probeSession(out.f), { state: 'signed-out' });

  const html = server({ '/api/auth/session': () => new Response('<!doctype html><div id=root>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.deepEqual(await probeSession(html.f), { state: 'absent' }, 'SPA fallback 200 must not open the gate');

  const notAdmin = server({ '/api/auth/session': () => new Response(JSON.stringify({ userId: 'u1', admin: false }), { status: 200, headers: J }) });
  assert.deepEqual(await probeSession(notAdmin.f), { state: 'absent' });

  const s3 = server({ '/api/auth/session': () => new Response('<Error>AccessDenied</Error>', { status: 403, headers: { 'content-type': 'application/xml' } }) });
  assert.deepEqual(await probeSession(s3.f), { state: 'absent' });

  assert.deepEqual(await probeSession(server({}).f), { state: 'absent' }, 'network error');
  assert.equal(ok.calls[0].init.credentials, 'same-origin');
  assert.equal((ok.calls[0].init.headers as Record<string, string>)['X-2bee'], '1');
});

test('sign-in: sends no identifier, demands user verification, posts the W3C JSON credential', async () => {
  const s = server({
    '/api/auth/challenge': () => new Response(JSON.stringify({ publicKey: { challenge: CHAL, rpId: '2bee.app', timeout: 60000, allowCredentials: [], userVerification: 'preferred' } }), { status: 200, headers: J }),
    '/api/auth/assert': () => new Response(null, { status: 204 }),
  });
  const { c, seen } = creds();
  assert.equal(await signInWithPasskey(s.f, c, '2bee.app'), 'ok');
  assert.deepEqual(s.calls[0].body, {}, 'the challenge request carries no email, user or role');
  const pk = seen.get!.publicKey!;
  assert.deepEqual(new Uint8Array(pk.challenge as ArrayBuffer), b64urlToBytes(CHAL));
  assert.equal(pk.userVerification, 'required', 'a server asking "preferred" must not weaken it');
  assert.equal(pk.rpId, '2bee.app');
  const sent = s.calls[1].body as { credential: Record<string, unknown> };
  assert.deepEqual(Object.keys(s.calls[1].body as object), ['credential'], 'nothing but the credential is sent');
  assert.equal(sent.credential.rawId, bytesToB64url(bytes(4, 2)));
  assert.equal((sent.credential.response as Record<string, string>).userHandle, bytesToB64url(bytes(5, 5)));
  for (const call of s.calls) {
    assert.ok(call.url.startsWith('/api/auth/'), call.url);
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal((call.init.headers as Record<string, string>)['X-2bee'], '1');
  }
});

test('sign-in outcomes: refused, rate-limited, cancelled, unsupported, offline', async () => {
  const chal = () => new Response(JSON.stringify({ publicKey: { challenge: CHAL, rpId: '2bee.app' } }), { status: 200, headers: J });
  const refused = server({ '/api/auth/challenge': chal, '/api/auth/assert': () => new Response('{"error":"sign_in_failed"}', { status: 401, headers: J }) });
  assert.equal(await signInWithPasskey(refused.f, creds().c, '2bee.app'), 'failed');
  const limited = server({ '/api/auth/challenge': () => new Response('{"error":"rate_limited"}', { status: 429, headers: J }) });
  assert.equal(await signInWithPasskey(limited.f, creds().c), 'rate-limited');
  const s = server({ '/api/auth/challenge': chal });
  assert.equal(await signInWithPasskey(s.f, creds({ fail: 'NotAllowedError' }).c, '2bee.app'), 'cancelled');
  assert.equal(s.calls.length, 1, 'a cancelled passkey sends nothing further');
  assert.equal(await signInWithPasskey(s.f, undefined), 'unsupported');
  assert.equal(await signInWithPasskey(server({}).f, creds().c), 'offline');
  const garbage = server({ '/api/auth/challenge': () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(await signInWithPasskey(garbage.f, creds().c), 'failed', 'no challenge, no prompt');
});

test('enrol: needs a code, forces a discoverable user-verified credential, sends only code+credential+label', async () => {
  const s = server({
    '/api/auth/enrol/options': () => new Response(JSON.stringify({ publicKey: {
      challenge: CHAL, rp: { id: '2bee.app', name: '2bee.app' }, user: { id: bytesToB64url(bytes(5, 5)), name: 'founder', displayName: 'Founder' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ type: 'public-key', id: bytesToB64url(bytes(1)) }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'discouraged' },
    } }), { status: 200, headers: J }),
    '/api/auth/enrol/finish': () => new Response(null, { status: 204 }),
  });
  const { c, seen } = creds();
  assert.equal(await enrolPasskey('  CODE-1  ', '  ' + 'L'.repeat(60), s.f, c, '2bee.app'), 'ok');
  const sel = seen.create!.publicKey!.authenticatorSelection!;
  assert.equal(sel.residentKey, 'required');
  assert.equal(sel.userVerification, 'required');
  assert.equal(seen.create!.publicKey!.excludeCredentials!.length, 1);
  assert.deepEqual(s.calls[0].body, { code: 'CODE-1' });
  const fin = s.calls[1].body as Record<string, unknown>;
  assert.deepEqual(Object.keys(fin).sort(), ['code', 'credential', 'label'], 'no role, user id or email is ever sent');
  assert.equal((fin.label as string).length, 40);

  const none = server({});
  assert.equal(await enrolPasskey('   ', 'x', none.f, c), 'failed');
  assert.equal(none.calls.length, 0, 'an empty code sends nothing');
  const bad = server({ '/api/auth/enrol/options': () => new Response('{"error":"enrol_failed"}', { status: 401, headers: J }) });
  assert.equal(await enrolPasskey('used', 'x', bad.f, c), 'failed');
});

test('options parsing refuses a missing challenge rather than prompting', () => {
  assert.throws(() => requestOptionsFromJSON({}, '2bee.app'));
  assert.throws(() => creationOptionsFromJSON({ challenge: CHAL }, '2bee.app'));
});

test('🔴 RP ID must be exactly this page\'s host: staging never asks for production passkeys (cyber 11-50-59)', async () => {
  // A page on stage.2bee.app handed the parent RP ID `2bee.app` would prompt for the founder's
  // PRODUCTION passkey. The page refuses before any prompt, whatever the server sent.
  const parent = server({ '/api/auth/challenge': () => new Response(JSON.stringify({ publicKey: { challenge: CHAL, rpId: '2bee.app' } }), { status: 200, headers: J }) });
  const { c, seen } = creds();
  assert.equal(await signInWithPasskey(parent.f, c, 'stage.2bee.app'), 'failed');
  assert.equal(seen.get, undefined, 'no passkey prompt was shown');
  const missing = server({ '/api/auth/challenge': () => new Response(JSON.stringify({ publicKey: { challenge: CHAL } }), { status: 200, headers: J }) });
  assert.equal(await signInWithPasskey(missing.f, creds().c, '2bee.app'), 'failed', 'a missing rpId is refused, not defaulted');
  assert.throws(() => creationOptionsFromJSON({ challenge: CHAL, rp: { id: '2bee.app' }, user: { id: 'AQ' } }, 'stage.2bee.app'));
  assert.equal(requestOptionsFromJSON({ challenge: CHAL, rpId: 'stage.2bee.app' }, 'stage.2bee.app').rpId, 'stage.2bee.app');
});

test('sign-out posts to signout or signout-all, never throws', async () => {
  const s = server({ '/api/auth/signout': () => new Response(null, { status: 204 }), '/api/auth/signout-all': () => new Response(null, { status: 204 }) });
  assert.equal(await signOutPasskey(false, s.f), true);
  assert.equal(await signOutPasskey(true, s.f), true);
  assert.deepEqual(s.calls.map((c) => c.url), ['/api/auth/signout', '/api/auth/signout-all']);
  assert.equal(await signOutPasskey(false, server({}).f), false);
});

test('#enrol route', () => {
  assert.equal(isEnrolRoute('#enrol'), true);
  assert.equal(isEnrolRoute('#enrolment-x'), false);
  assert.equal(isEnrolRoute('#cad'), false);
});
