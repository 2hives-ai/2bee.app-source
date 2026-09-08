/* auth.ts — the founder's "only admins can log in" (TODO #29) is a CLIENT-SIDE
 * gate over a Cognito claim, and until 2026-08-27 NOTHING tested it: the e2e
 * suite predates the gate and died on it once `web/.env` carried the Cognito
 * triple (I1 red 2026-08-23 — every test blocked at "Admin access required").
 * These cover the two pure decisions: who counts as admin, and when a token
 * is too old to use. The gate's DOM states ride on these two functions. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin, isTokenExpired, type TokenSet } from '../src/auth';

/** A JWT with the given payload. Signature is a placeholder — decodeJwtPayload
 *  deliberately does not verify (the token is client-side gating only). */
function jwt(payload: Record<string, unknown>): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

function token(payload: Record<string, unknown>, over: Partial<TokenSet> = {}): TokenSet {
  return { id_token: jwt(payload), access_token: 'x', expires_in: 3600, received_at: Date.now(), ...over };
}

test('a user in the "admin" group is admin; any other group is NOT', () => {
  assert.equal(isAdmin(token({ 'cognito:groups': ['admin'] })), true);
  assert.equal(isAdmin(token({ 'cognito:groups': ['admin', 'ops'] })), true);
  assert.equal(isAdmin(token({ 'cognito:groups': ['ops'] })), false);
  assert.equal(isAdmin(token({ 'cognito:groups': [] })), false);
});

test('🔴 no groups claim at all means ANY authenticated user is admin — the single-user-pool rule', () => {
  /* This is the behaviour backend flagged 2026-08-21: the pool has no admin
   * group, so the claim is absent and the gate passes everyone. If the pool
   * grows a second user, this rule is the whole "only admins" enforcement —
   * a regression here opens the app to every authenticated account. */
  assert.equal(isAdmin(token({ sub: 'user-1', email: 'a@b.c' })), true);
});

test('a malformed id_token is NOT admin-by-default — the claim is unreadable, not absent', () => {
  /* decodeJwtPayload returns {} on garbage, and {} has no groups claim, which
   * the single-user rule reads as "allow". That composition means a corrupt
   * token is treated as an admin with no identity at all. Pinned so a change
   * here is a deliberate decision, not an accident. */
  assert.equal(isAdmin({ ...token({}), id_token: 'not-a-jwt' }), true); // lint-allow: synthetic-credential — deliberately malformed JWT fixture, not a real token
});

test('expiry: 30 s buffer — a token about to expire is already unusable', () => {
  const now = Date.now();
  assert.equal(isTokenExpired(token({}, { received_at: now, expires_in: 3600 })), false);
  assert.equal(isTokenExpired(token({}, { received_at: now - 3600_000, expires_in: 3600 })), true);
  assert.equal(isTokenExpired(token({}, { received_at: now - 3575_000, expires_in: 3600 })), true, 'inside the 30 s buffer (25 s left)');
  assert.equal(isTokenExpired(token({}, { received_at: now - 3500_000, expires_in: 3600 })), false, 'outside the buffer (100 s left)');
});

/* ───────────────────────────────────────────────────────────────────────────
 * THE CONFIG STATE — added 2026-08-27, and it is the half that FAILED OPEN.
 *
 * 🔴 `readConfig()` returned `null` when ANY of the three Cognito vars was
 * missing, and `AuthGate` reads `null` as "auth is not configured — dev/CI,
 * gate open". So two vars set and one typo'd served the whole app to anyone,
 * silently, and looked exactly like the intended local-development mode.
 * "Not configured" and "configured wrong" are different facts and only the
 * first is safe to treat as open.
 *
 * These tests construct `partial`, which is the ONLY state the defect lived in
 * — which is why `authConfigState` takes an env seam: the node loader replaces
 * `import.meta.env` with `{}`, so without one the only reachable state is
 * `absent`, the state that was already safe.
 * ─────────────────────────────────────────────────────────────────────────── */

import { authConfigState, authVarsMissing, authVarsPresent } from '../src/auth';

const D = 'VITE_COGNITO_DOMAIN';
const C = 'VITE_COGNITO_CLIENT_ID';
const R = 'VITE_COGNITO_REDIRECT_URI';
const ALL = { [D]: 'pool.auth.ap-southeast-2.amazoncognito.com', [C]: 'abc123', [R]: 'https://2bee.app/' };

test('none set is ABSENT — the local-development mode, and the only one that may open the gate', () => {
  assert.equal(authConfigState({}), 'absent');
});

test('all three set is CONFIGURED', () => {
  assert.equal(authConfigState({ ...ALL }), 'configured');
});

test('🔴 any PARTIAL combination is PARTIAL — never absent, so it can never open the gate', () => {
  /* Every proper non-empty subset, enumerated rather than sampled: the defect
   * was one missing variable, and "we checked a couple of combinations" is how
   * the surviving one stays. */
  const keys = [D, C, R];
  for (let mask = 1; mask < 7; mask++) {
    const env: Record<string, string> = {};
    keys.forEach((k, i) => {
      if (mask & (1 << i)) env[k] = ALL[k as keyof typeof ALL];
    });
    const n = Object.keys(env).length;
    const want = n === 3 ? 'configured' : 'partial';
    assert.equal(authConfigState(env), want, `${n} of 3 set (${Object.keys(env).join(',')})`);
  }
});

test('a variable set to whitespace counts as ABSENT — a deployer who meant to fill it in', () => {
  assert.equal(authConfigState({ [D]: '   ', [C]: '', [R]: '\t' }), 'absent');
  /* And one real value beside two blanks is still partial, not configured. */
  assert.equal(authConfigState({ [D]: 'pool.example', [C]: ' ', [R]: '' }), 'partial');
});

test('the refusal can name BOTH sides — what is missing and what is set', () => {
  /* The screen prints both. "Missing: X" alone leaves a deployer guessing
   * whether the other two took; naming the set ones is how they find the typo. */
  const env = { [D]: 'pool.example', [C]: 'abc123' };
  assert.deepEqual(authVarsMissing(env), [R]);
  assert.deepEqual(authVarsPresent(env), [D, C]);
});
