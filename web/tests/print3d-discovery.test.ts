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
  assert.equal(seen.length, 2, 'only the two defaults when no peers are named');
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
  const found = { all: [], found: { engine: 'http://127.0.0.1:8789', printer: 'http://127.0.0.1:8788' }, notes: [] };
  const filled = applyDiscovery(NO_BRIDGES, found);
  assert.equal(filled.engine.url, 'http://127.0.0.1:8789');
  assert.equal(filled.printer.url, 'http://127.0.0.1:8788');
  assert.equal(filled.engine.token, '');
  const typed: Bridges = { engine: { url: 'http://127.0.0.1:9999', token: 'k'.repeat(20), remember: true }, printer: NO_BRIDGES.printer };
  const kept = applyDiscovery(typed, found);
  assert.equal(kept.engine, typed.engine, 'a typed address and its key are untouched');
  assert.equal(kept.printer.url, 'http://127.0.0.1:8788');
  // Nothing found: the same object back, so no write.
  assert.equal(applyDiscovery(typed, { all: [], found: { engine: "", printer: "" }, notes: [] }), typed);
  // A non-loopback address can never be filled, even if a fake discovery returned one.
  assert.equal(applyDiscovery(NO_BRIDGES, { all: [], found: { engine: "http://10.0.0.5:8789", printer: "" }, notes: [] }).engine.url, '');
});

test('discovery asks ONLY the two defaults, then the peers they name; every bridge is listed, a second printer is not guessed', async () => {
  const peers = [{ bridge: HELLO_ID.printer, port: 8788 }, { bridge: HELLO_ID.engine, port: 8789 }, { bridge: HELLO_ID.printer, port: 8795 }];
  const { f, seen } = loopback({ 8789: { ...engineHello, peers }, 8788: { ...printerHello, peers }, 8795: { ...printerHello, peers } });
  const d = await discoverBridges(f);
  assert.deepEqual(seen.map((s) => Number(new URL(s.url).port)).sort((a, b) => a - b), [8788, 8789, 8795], 'no blind probing: one request per real bridge');
  assert.deepEqual(d.all, [
    { kind: 'printer', url: 'http://127.0.0.1:8788' },
    { kind: 'engine', url: 'http://127.0.0.1:8789' },
    { kind: 'printer', url: 'http://127.0.0.1:8795' },
  ]);
  assert.deepEqual(d.found, { engine: 'http://127.0.0.1:8789', printer: '' }, 'two printer bridges: the person picks');
});

test('a peer is believed only by its own hello: a listed port that is dead or a stranger is not a bridge', async () => {
  const peers = [{ port: 8790 }, { port: 8791 }, { port: 'x' }, { port: 99999 }, null];
  const d = await discoverBridges(loopback({ 8789: { ...engineHello, peers }, 8791: { ok: true, bridge: 'other' } }).f);
  assert.deepEqual(d.all, [{ kind: 'engine', url: 'http://127.0.0.1:8789' }]);
});

test('peer ports are capped, so a corrupt registry cannot make the page probe hundreds', async () => {
  const peers = Array.from({ length: 200 }, (_, i) => ({ port: 9000 + i }));
  const { f, seen } = loopback({ 8789: { ...engineHello, peers } });
  await discoverBridges(f);
  assert.equal(seen.length, 2 + 16);
});
