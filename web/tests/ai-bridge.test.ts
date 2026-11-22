// The AI found on this computer like the printer (src/ai/aiBridge.ts).
//
// Founder 2026-11-22: "why it has connect to ai first? fix it!" / "It should be
// automatically connected via bridge like the printer?"
//
// 🔴 What these guard: discovery fills ONLY an empty address, NEVER a key, believes only a
// hello that names the claude-bridge, and never runs on the dev server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAiDiscovery, discoverAiBridge, isAiBridgeEndpoint, primeAiBridge } from '../src/ai/aiBridge.ts';
import { ASK_CONFIG_KEY, NO_ASK_CONFIG, readAskConfig } from '../src/cad/ask.tsx';

type Replies = Record<string, unknown>;
function fakeFetch(replies: Replies) {
  const asked: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    asked.push(url);
    assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, undefined, 'a hello must carry no token');
    const port = new URL(url).port;
    if (!(port in replies)) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(replies[port]), { status: 200 });
  };
  return { f, asked };
}
function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const CLAUDE = { bridge: '2bee.claude-bridge', models: ['claude-sonnet', 'claude-opus'], peers: [] };

test('finds the bridge on its default port and fills endpoint + model, no key', async () => {
  const { f } = fakeFetch({ '8787': CLAUDE });
  const found = await discoverAiBridge(f, 50);
  assert.deepEqual(found, { base: 'http://127.0.0.1:8787', model: 'claude-sonnet' });
  const cfg = applyAiDiscovery(NO_ASK_CONFIG, found);
  assert.equal(cfg.endpoint, 'http://127.0.0.1:8787/v1/chat/completions');
  assert.equal(cfg.model, 'claude-sonnet');
  assert.equal(cfg.apiKey, '', 'discovery never fills a key');
  assert.equal(isAiBridgeEndpoint(cfg.endpoint), true);
});

test('a port answering as some other bridge is not believed', async () => {
  const { f } = fakeFetch({ '8787': { bridge: '2bee.printer-bridge', peers: [] } });
  assert.equal(await discoverAiBridge(f, 50), null);
});

test('a bridge on another port is found through the printer bridge peers, and confirmed by its own hello', async () => {
  const { f, asked } = fakeFetch({
    '8788': { bridge: '2bee.printer-bridge', peers: [{ bridge: '2bee.claude-bridge', port: 8797 }] },
    '8797': CLAUDE,
  });
  assert.deepEqual(await discoverAiBridge(f, 50), { base: 'http://127.0.0.1:8797', model: 'claude-sonnet' });
  assert.ok(asked.includes('http://127.0.0.1:8797/v1/hello'));
});

test('a typed address is never replaced', () => {
  const typed = { ...NO_ASK_CONFIG, endpoint: 'https://gw.example.com/v1/chat/completions', model: 'm' };
  assert.equal(applyAiDiscovery(typed, { base: 'http://127.0.0.1:8787', model: 'claude-sonnet' }), typed);
});

test('primeAiBridge stores the address only when none is stored, never a key, and not on the dev server', async () => {
  const { f } = fakeFetch({ '8787': CLAUDE });
  const s = mem();
  assert.equal(await primeAiBridge(s, f, false), 'filled');
  const stored = JSON.parse(s.m.get(ASK_CONFIG_KEY)!);
  assert.equal(stored.endpoint, 'http://127.0.0.1:8787/v1/chat/completions');
  assert.equal('apiKey' in stored, false, 'no key written');
  assert.equal(readAskConfig(s).endpoint, stored.endpoint);

  const kept = mem({ [ASK_CONFIG_KEY]: JSON.stringify({ endpoint: 'https://gw.example.com/v1/x', model: 'm' }) });
  assert.equal(await primeAiBridge(kept, f, false), 'kept');
  assert.equal(JSON.parse(kept.m.get(ASK_CONFIG_KEY)!).endpoint, 'https://gw.example.com/v1/x');

  const dev = mem();
  assert.equal(await primeAiBridge(dev, f, true), 'dev');
  assert.equal(dev.m.size, 0);

  const none = mem();
  assert.equal(await primeAiBridge(none, fakeFetch({}).f, false), 'none');
  assert.equal(none.m.size, 0, 'nothing found, nothing stored');
});
