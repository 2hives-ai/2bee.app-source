// The AI found on this computer, the same way the printer is.
//
// Founder 2026-11-22, on the live 2bee.app CAD page: "why it has connect to ai first? fix
// it!" and "It should be automatically connected via bridge like the printer?"
//
// The printer card finds its bridges by asking loopback ports for GET /v1/hello
// (print3d/bridges.ts). This does the same for tools/claude-bridge: it asks
// 127.0.0.1:8787, and if nothing answers there, the peers the printer/slicer bridges list
// (tools/bridge-registry.mjs). It believes only a hello that names '2bee.claude-bridge'.
//
// 🔴 WHAT IT FILLS, AND WHAT IT NEVER DOES (same rules as the printer's discovery):
//   · Only an EMPTY address. An endpoint the person typed is never replaced.
//   · Never a key. The hello carries none, and nothing here reads or writes one. The key
//     is pasted once in "Set up AI" (and stored only if "Remember" is ticked).
//   · Nothing authenticated is sent: the hello has no token and no body.
//   · Never on the dev server. There the AI already goes through vite's /__claude proxy
//     (cad/ask.tsx LOCAL_CLAUDE_CONFIG).
// So the safety property of cad/ask.tsx NO_ASK_CONFIG still holds: no endpoint is ever
// shipped in the bundle. One is used only after a bridge on THIS computer said what it is.

import { ASK_CONFIG_KEY, readAskConfig, askConfigForStorage, type AskConfig, type AskStore } from '../cad/ask';

export const AI_BRIDGE_PORT = 8787;
/** What tools/claude-bridge/bridge.mjs HELLO_ID says. */
export const AI_HELLO_ID = '2bee.claude-bridge';
/** The bridges whose hello lists peers (print3d/bridges.ts ENGINE_PORT, PRINTER_PORT). */
export const PEER_SOURCE_PORTS = [8789, 8788];
export const AI_DISCOVERY_MS = 1500;
/** The model alias the bridge serves (tools/claude-bridge MODELS) and the dev proxy uses. */
export const AI_BRIDGE_MODEL = 'claude-sonnet';
/** How long the page waits for an answer from the bridge (cad/ask.tsx LOCAL_CLAUDE_CONFIG uses the same). */
export const AI_BRIDGE_TIMEOUT_MS = 180000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const loop = (port: number) => `http://127.0.0.1:${port}`;

interface Hello {
  bridge: string;
  models: string[];
  peers: { bridge: string; port: number }[];
}

async function hello(base: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Hello | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(base + '/v1/hello', { method: 'GET', credentials: 'omit', signal: ac.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object' || typeof j.bridge !== 'string') return null;
    const models = Array.isArray(j.models) ? j.models.filter((m): m is string => typeof m === 'string') : [];
    const peers = Array.isArray(j.peers)
      ? j.peers
          .map((p) => (p && typeof p === 'object' ? (p as { bridge?: unknown; port?: unknown }) : {}))
          .filter((p): p is { bridge: string; port: number } => typeof p.bridge === 'string' && Number.isInteger(p.port) && (p.port as number) > 0 && (p.port as number) < 65536)
      : [];
    return { bridge: j.bridge, models, peers };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface AiBridgeFound {
  /** e.g. http://127.0.0.1:8787 */
  base: string;
  model: string;
}

/** Find the claude-bridge on this computer, or null. A port is believed only from its own hello. */
export async function discoverAiBridge(fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs = AI_DISCOVERY_MS): Promise<AiBridgeFound | null> {
  const confirm = async (port: number): Promise<AiBridgeFound | null> => {
    const h = await hello(loop(port), fetchImpl, timeoutMs);
    if (!h || h.bridge !== AI_HELLO_ID) return null;
    return { base: loop(port), model: h.models.includes(AI_BRIDGE_MODEL) ? AI_BRIDGE_MODEL : h.models[0] || AI_BRIDGE_MODEL };
  };
  const direct = await confirm(AI_BRIDGE_PORT);
  if (direct) return direct;
  const listed = await Promise.all(PEER_SOURCE_PORTS.map((p) => hello(loop(p), fetchImpl, timeoutMs)));
  const ports = [...new Set(listed.flatMap((h) => (h ? h.peers.filter((p) => p.bridge === AI_HELLO_ID).map((p) => p.port) : [])))].filter((p) => p !== AI_BRIDGE_PORT);
  for (const p of ports.slice(0, 4)) {
    const f = await confirm(p);
    if (f) return f;
  }
  return null;
}

/** Fill an EMPTY endpoint from a discovery. Everything else, the key above all, is kept as it was. */
export function applyAiDiscovery(cfg: AskConfig, found: AiBridgeFound | null): AskConfig {
  if (!found || cfg.endpoint.trim() !== '') return cfg;
  // The bridge runs claude with a 180 s limit; a CAD rewrite routinely takes over a minute, so the
  // page must not give up first (NO_ASK_CONFIG's 60 s). Same value as the dev proxy's config.
  return { ...cfg, endpoint: found.base + '/v1/chat/completions', model: cfg.model.trim() || found.model, timeoutMs: Math.max(cfg.timeoutMs, AI_BRIDGE_TIMEOUT_MS) };
}

/** True when this endpoint is a claude-bridge on loopback, so its missing key can be asked for by name. */
export function isAiBridgeEndpoint(endpoint: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/v1\/chat\/completions$/.test(endpoint.trim());
}

function isDev(): boolean {
  try {
    return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
}

/**
 * Run once before the app renders: if no AI address is stored, look for the bridge and store
 * the address it gave. Every panel then reads it through readAskConfig as usual.
 * Returns what happened, for the test and the console. Never throws.
 */
export async function primeAiBridge(store: AskStore | null, fetchImpl?: FetchLike, dev = isDev()): Promise<'dev' | 'kept' | 'filled' | 'none'> {
  try {
    if (dev || !store) return 'dev';
    const cfg = readAskConfig(store);
    if (cfg.endpoint.trim() !== '') return 'kept';
    const next = applyAiDiscovery(cfg, await discoverAiBridge(fetchImpl));
    if (next === cfg) return 'none';
    store.setItem(ASK_CONFIG_KEY, JSON.stringify(askConfigForStorage(next)));
    return 'filled';
  } catch {
    return 'none';
  }
}
