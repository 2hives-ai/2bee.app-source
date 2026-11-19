import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscovery, discoverBridges, HELLO_ID, NO_BRIDGES, type Bridges, type FetchLike } from '../src/print3d/bridges.ts';

/** A fake loopback: port -> what answers there. */
function loopback(ports: Record<number, unknown | 'refused' | 'hang' | 401>): { f: FetchLike; seen: { url: string; init?: RequestInit }[] } {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = (url, init) => {
    seen.push({ url, init });
    const port = Number(new URL(url).port);
    const a = ports[port];
    if (a === undefined || a === 'refused') return Promise.reject(new TypeError('Failed to fetch'));
    if (a === 'hang')
      return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    if (a === 401) return Promise.resolve(new Response('{"ok":false}', { status: 401 }));
    return Promise.resolve(new Response(typeof a === 'string' ? a : JSON.stringify(a), { status: 200 }));
  };
  return { f, seen };
}

const engineHello = { ok: true, bridge: HELLO_ID.engine, api: 1, needsToken: true };
const printerHello = { ok: true, bridge: HELLO_ID.printer, api: 1, needsToken: true };

test('discovery: finds both on their default ports, sends no token, asks only /v1/hello', async () => {
  const { f, seen } = loopback({ 8789: engineHello, 8788: printerHello });
  const d = await discoverBridges(f);
  assert.deepEqual(d.found, { engine: 'http://127.0.0.1:8789', printer: 'http://127.0.0.1:8788' });
  for (const s of seen) {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/v1\/hello$/);
    assert.equal(s.init?.method, 'GET');
    assert.equal(s.init?.headers, undefined, 'no authorization header, no custom header (no preflight)');
    assert.equal(s.init?.credentials, 'omit');
  }
});

test('discovery: the reply names the kind, not the port (swapped ports land in the right rows)', async () => {
  const { f } = loopback({ 8789: printerHello, 8788: engineHello });
  const d = await discoverBridges(f);
  assert.deepEqual(d.found, { engine: 'http://127.0.0.1:8788', printer: 'http://127.0.0.1:8789' });
});

test('discovery: silence, a refusal, a hang, a stranger or non-JSON on the port finds nothing', async () => {
  for (const a of ['refused', 401, { ok: true, bridge: 'something-else' }, 'not json', { ok: true }] as const) {
    const d = await discoverBridges(loopback({ 8789: a, 8788: a }).f);
    assert.deepEqual(d.found, { engine: '', printer: '' }, `answer ${JSON.stringify(a)}`);
    assert.equal(d.notes.length, 2);
  }
  const t0 = Date.now();
  const d = await discoverBridges(loopback({ 8789: 'hang', 8788: printerHello }).f, undefined, 50);
  assert.deepEqual(d.found, { engine: '', printer: 'http://127.0.0.1:8788' });
  assert.ok(Date.now() - t0 < 1000, 'a hung port is abandoned at the timeout');
});

test('discovery: two bridges of one kind is ambiguous and fills neither', async () => {
  const d = await discoverBridges(loopback({ 8789: engineHello, 8788: engineHello }).f);
  assert.equal(d.found.engine, '');
  assert.ok(d.notes.some((n) => /More than one slicer bridge/.test(n)));
});

test('applyDiscovery: fills only EMPTY addresses, never a key, never a typed address', () => {
  const found = { found: { engine: 'http://127.0.0.1:8789', printer: 'http://127.0.0.1:8788' }, notes: [] };
  const filled = applyDiscovery(NO_BRIDGES, found);
  assert.equal(filled.engine.url, 'http://127.0.0.1:8789');
  assert.equal(filled.printer.url, 'http://127.0.0.1:8788');
  assert.equal(filled.engine.token, '');
  const typed: Bridges = { engine: { url: 'http://127.0.0.1:9999', token: 'k'.repeat(20), remember: true }, printer: NO_BRIDGES.printer };
  const kept = applyDiscovery(typed, found);
  assert.equal(kept.engine, typed.engine, 'a typed address and its key are untouched');
  assert.equal(kept.printer.url, 'http://127.0.0.1:8788');
  // Nothing found: the same object back, so no write.
  assert.equal(applyDiscovery(typed, { found: { engine: '', printer: '' }, notes: [] }), typed);
  // A non-loopback address can never be filled, even if a fake discovery returned one.
  assert.equal(applyDiscovery(NO_BRIDGES, { found: { engine: 'http://10.0.0.5:8789', printer: '' }, notes: [] }).engine.url, '');
});
