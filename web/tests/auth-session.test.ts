// The sign-in survives a page refresh (founder 2026-10-20) through sessionStorage,
// and nothing malformed or absent is ever trusted as a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveTokens, loadTokens, clearTokens, type TokenSet } from '../src/auth.ts';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
}

const T: TokenSet = { id_token: 'a.b.c', access_token: 'x.y.z', expires_in: 3600, received_at: 1 };

test('saved tokens come back after a "refresh"; cleared tokens do not', () => {
  const s = fakeStorage();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = s;
  saveTokens(T);
  assert.deepEqual(loadTokens(), T);
  clearTokens();
  assert.equal(loadTokens(), null);
});

test('malformed stored value is removed and not trusted', () => {
  const s = fakeStorage();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = s;
  s.setItem('2bee.app.auth.tokens', '{"id_token":42}');
  assert.equal(loadTokens(), null);
  assert.equal(s.map.size, 0);
  s.setItem('2bee.app.auth.tokens', 'not json');
  assert.equal(loadTokens(), null);
});

test('no storage at all (blocked) is signed out, not a crash', () => {
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = undefined;
  assert.equal(loadTokens(), null);
  saveTokens(T);
  clearTokens();
});

test('never localStorage: the token key is not written there', () => {
  const ls = fakeStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = ls;
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = fakeStorage();
  saveTokens(T);
  assert.equal(ls.map.size, 0);
});
