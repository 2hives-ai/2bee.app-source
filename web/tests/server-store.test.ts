// Server document store client (src/serverStore.ts).
//
// 🔴 What these guard: a save that did not reach the server must never come
// back `ok: true`. Each failure the contract in
// software/backend/functions/api/app_docs.py names gets its own reason, and
// anything outside the contract (API Gateway's 403 for a route that is not
// deployed, HTML, an empty body) is `unexpected`, never success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerStore, INLINE_LIMIT, saveStatusText, type DocMeta } from '../src/serverStore.ts';

type Call = { url: string; init: RequestInit | undefined };

function resp(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}

function mock(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers.shift();
    if (!a) throw new Error('unexpected extra fetch');
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const meta = (v: number, p: Partial<DocMeta> = {}): DocMeta => ({
  kind: 'drawing', doc_id: 'd1', version: v, size: 10, has_body: false, created_at: 1, updated_at: 2, ...p,
});

const store = (f: typeof fetch, token: string | null = 'ID.TOKEN.X') =>
  createServerStore({ base: 'https://api.test/app/docs/', fetchImpl: f, getIdToken: () => token });

test('put sends the ID token, base_version and data, and is ok only on the confirmed next version', async () => {
  const { f, calls } = mock([resp(200, meta(4))]);
  const r = await store(f).put('drawing', 'd1', { a: 1 }, 3);
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://api.test/app/docs/drawing/d1');
  assert.equal(calls[0].init?.method, 'PUT');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'ID.TOKEN.X');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { data: { a: 1 }, base_version: 3 });
  assert.equal(saveStatusText(r), 'Saved to server (version 4).');
});

test('a 2xx that does not confirm version base+1 is NOT saved', async () => {
  const { f } = mock([resp(200, meta(3))]);
  const r = await store(f).put('drawing', 'd1', { a: 1 }, 3);
  assert.equal(r.ok, false);
  assert.match(saveStatusText(r), /^NOT saved/);
});

test('no token: refused before any request', async () => {
  const { f, calls } = mock([]);
  const r = await store(f, null).put('drawing', 'd1', {}, 0);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'unauthenticated');
  assert.equal(calls.length, 0);
});

test('network failure is offline, not saved', async () => {
  const { f } = mock([new TypeError('Failed to fetch')]);
  const r = await store(f).put('drawing', 'd1', {}, 0);
  assert.equal(!r.ok && r.reason, 'offline');
  assert.match(saveStatusText(r), /NOT saved: .*Nothing was stored/);
});

test('409 version_conflict carries the current version', async () => {
  const { f } = mock([resp(409, { error: 'version_conflict', current_version: 7 })]);
  const r = await store(f).put('drawing', 'd1', {}, 5);
  assert.equal(!r.ok && r.reason, 'conflict');
  assert.equal(!r.ok && r.currentVersion, 7);
});

test('contract errors map to their reasons; anything else is unexpected', async () => {
  const cases: Array<[Response, string]> = [
    [resp(401, { error: 'unauthenticated' }), 'unauthenticated'],
    [resp(413, { error: 'too_large', limit_bytes: 307200 }), 'too_large'],
    [resp(400, { error: 'bad_request', detail: 'x' }), 'bad_request'],
    [resp(404, { error: 'not_found' }), 'not_found'],
    [resp(503, { error: 'unavailable' }), 'unavailable'],
    // API Gateway, route not deployed: 403 {"message":"Missing Authentication Token"}
    [resp(403, { message: 'Missing Authentication Token' }), 'unexpected'],
    [resp(502, '<html>bad gateway</html>'), 'unexpected'],
    [resp(200, ''), 'unexpected'],
  ];
  for (const [a, want] of cases) {
    const { f } = mock([a]);
    const r = await store(f).put('drawing', 'd1', {}, 0);
    assert.equal(r.ok, false, `status ${a.status} must not be ok`);
    assert.equal(!r.ok && r.reason, want, `status ${a.status}`);
  }
});

test('a bad doc id is refused before any request', async () => {
  const { f, calls } = mock([]);
  const r = await store(f).put('drawing', 'a/b', {}, 0);
  assert.equal(!r.ok && r.reason, 'bad_request');
  assert.equal(calls.length, 0);
});

test('a body over the inline limit goes upload -> S3 PUT -> PUT body_key', async () => {
  const big = { s: 'x'.repeat(INLINE_LIMIT + 10) };
  const { f, calls } = mock([
    resp(200, { upload_url: 'https://s3.test/put?sig', body_key: 'sub/drawing/d1/abc', headers: { 'Content-Type': 'application/json' } }),
    resp(200, ''),
    resp(200, meta(1, { has_body: true })),
  ]);
  const r = await store(f).put('drawing', 'd1', big, 0, { name: 'n' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://api.test/app/docs/drawing/d1/upload');
  assert.equal(JSON.parse(String(calls[0].init?.body)).size > INLINE_LIMIT, true);
  assert.equal(calls[1].url, 'https://s3.test/put?sig');
  assert.equal(calls[1].init?.method, 'PUT');
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, undefined, 'the token never goes to S3');
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { body_key: 'sub/drawing/d1/abc', base_version: 0, meta: { name: 'n' } });
});

test('a failed S3 upload is NOT saved and the record is never written', async () => {
  const { f, calls } = mock([
    resp(200, { upload_url: 'https://s3.test/put', body_key: 'k' }),
    resp(403, '<Error/>'),
  ]);
  const r = await store(f).put('drawing', 'd1', { s: 'x'.repeat(INLINE_LIMIT + 1) }, 0);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 2);
});

test('get fetches an S3 body through download_url', async () => {
  const { f, calls } = mock([
    resp(200, { ...meta(2, { has_body: true }), download_url: 'https://s3.test/get' }),
    resp(200, { hello: 'world' }),
  ]);
  const r = await store(f).get('drawing', 'd1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.value.data, { hello: 'world' });
  assert.equal(calls[1].url, 'https://s3.test/get');
});

test('list rejects a malformed answer instead of showing an empty list', async () => {
  const { f } = mock([resp(200, { nope: [] })]);
  const r = await store(f).list('drawing');
  assert.equal(!r.ok && r.reason, 'unexpected');
  const { f: f2, calls } = mock([resp(200, { items: [meta(1)], next: 'T' })]);
  const r2 = await store(f2).list('drawing', { includeData: true });
  assert.equal(r2.ok && r2.value.items.length, 1);
  assert.equal(r2.ok && r2.value.next, 'T');
  assert.equal(calls[0].url, 'https://api.test/app/docs/drawing?include=data');
});

test('remove is ok only when the server confirms deleted:true', async () => {
  const { f } = mock([resp(200, { deleted: true })]);
  assert.equal((await store(f).remove('drawing', 'd1')).ok, true);
  const { f: f2 } = mock([resp(200, {})]);
  assert.equal((await store(f2).remove('drawing', 'd1')).ok, false);
});
