// The two local bridges the 3D print tab talks to, and how it talks to them.
//
//   · ENGINE  — `tools/print3d-bridge/`: slices with 2bee.fdm, this app's own
//               Rust engine (fdm/src/bin/fdmslice.rs), by default; the
//               OrcaSlicer CLI only when the bridge is started with
//               `--engine orca` (founder 2026-10-16: "no orcaslicer anymore!").
//               127.0.0.1 only, bearer token. It never talks to a printer.
//   · PRINTER — `tools/printer-bridge/`: copies a G-code job onto the X2D over
//               LAN FTPS, and (founder 2026-10-20: "add remote start",
//               "remote pause, remote stop"; supersedes 2026-10-14 "Upload
//               only") starts, pauses, resumes and stops it over the printer's
//               LAN MQTT, and reads its state. The MQTT routes need the bridge
//               started with --serial; without it they refuse.
//
// The AI is neither of these: it is the app's own Ask path (`cad/ask.tsx`,
// `readAskConfig` + `fetchTransport` → `tools/claude-bridge`).
//
// 🔴 TOKENS ARE NOT REMEMBERED UNLESS ASKED. Same rule as `cad/ask.tsx`
// `askConfigForStorage`: a token is written to this browser's storage only
// when the person ticked "remember", and a stored token is only read back when
// the stored record ALSO says it was meant to be remembered.
//
// ⚠ THE URLS ARE EMPTY BY DEFAULT, AND ONLY DISCOVERY FILLS ONE (founder
// 2026-11-19: "add auto-discovery of the bridges on loopback"). Discovery asks
// each default port on 127.0.0.1 for `GET /v1/hello` — no token, no body — and
// fills an EMPTY address only when the reply names the bridge kind that
// address is for. The port number alone is never trusted: a printer bridge
// started on the engine's port is put in the printer row, and anything else
// listening there is ignored. Discovery never fills or reads a key, never
// replaces an address the person typed, and sends nothing authenticated: the
// first request carrying a token still goes only where the person pasted it.

export interface BridgeConfig {
  url: string;
  token: string;
  remember: boolean;
}

export interface Bridges {
  engine: BridgeConfig;
  printer: BridgeConfig;
}

export const NO_BRIDGE: BridgeConfig = { url: '', token: '', remember: false };
export const NO_BRIDGES: Bridges = { engine: NO_BRIDGE, printer: NO_BRIDGE };

export const BRIDGES_KEY = '2bee.app.print3d.bridges';

/** The ports each bridge prints when it starts. Placeholders only. */
export const ENGINE_PORT = 8789;
export const PRINTER_PORT = 8788;

export interface KvStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function readOne(v: unknown): BridgeConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return NO_BRIDGE;
  const r = v as Record<string, unknown>;
  const remember = r.remember === true;
  return { url: cleanUrl(str(r.url)), token: remember ? str(r.token) : '', remember };
}

/**
 * 🔴 DEV SERVER ⇒ THE LOCAL BRIDGES THROUGH SAME-ORIGIN ROUTES (2026-10-15, as for the
 * AI in cad/ask.tsx LOCAL_CLAUDE_CONFIG). vite.config.ts forwards `/__print3d` and
 * `/__printer` to the bridges on 127.0.0.1 and adds their tokens server-side; the
 * token here is a placeholder the proxy replaces. Production reads the stored config.
 */
export const DEV_BRIDGES: Bridges = {
  engine: { url: '/__print3d', token: 'dev-server-proxy-token', remember: false },
  printer: { url: '/__printer', token: 'dev-server-proxy-token', remember: false },
};
export function devBridges(): boolean {
  try {
    return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
}

export function readBridges(store?: KvStore | null): Bridges {
  if (devBridges()) return DEV_BRIDGES;
  try {
    const raw = store?.getItem(BRIDGES_KEY);
    if (!raw) return NO_BRIDGES;
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return NO_BRIDGES;
    return { engine: readOne(v.engine), printer: readOne(v.printer) };
  } catch {
    return NO_BRIDGES;
  }
}

const forStorage = (b: BridgeConfig) => ({ url: b.url, remember: b.remember, ...(b.remember && b.token ? { token: b.token } : {}) });

export function bridgesForStorage(b: Bridges): Record<string, unknown> {
  return { engine: forStorage(b.engine), printer: forStorage(b.printer) };
}

export function writeBridges(b: Bridges, store?: KvStore | null): void {
  try {
    store?.setItem(BRIDGES_KEY, JSON.stringify(bridgesForStorage(b)));
  } catch {
    /* storage disabled: the setting lasts for this page only */
  }
}

/**
 * A bridge URL is accepted only as `http://127.0.0.1:<port>` or
 * `http://localhost:<port>` (or `[::1]`). Both bridges bind loopback only, so
 * anything else is a typo or a different machine — and the printer bridge's
 * token must never be sent to one. Returns '' for anything else.
 */
export function cleanUrl(u: string): string {
  const t = u.trim().replace(/\/+$/, '');
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(t) ? t : '';
}

export const configured = (b: BridgeConfig) => !!b.url && b.token.length >= 16;

/* ════════════════════════════════════════════════════════════════════════════
 * Discovery on loopback
 * ══════════════════════════════════════════════════════════════════════════ */

export type BridgeKind = keyof Bridges;

/** What each bridge says it is in its `/v1/hello` reply. Must match tools/*-bridge/bridge.mjs. */
export const HELLO_ID: Record<BridgeKind, string> = { engine: '2bee.print3d-bridge', printer: '2bee.printer-bridge' };

/**
 * The ports discovery asks first: the two defaults. Every other bridge is found through the
 * `peers` each bridge lists in its hello (tools/bridge-registry.mjs), never by blind probing:
 * each port that is not a bridge logs a red net::ERR_CONNECTION_REFUSED in the console that page
 * code cannot silence (the first version asked 8780-8799 and logged 18 of them; founder 2026-11-19).
 * A bridge on another port whose registry entry is missing is typed in by hand.
 */
export const DISCOVERY_PORTS = [ENGINE_PORT, PRINTER_PORT];
/** At most this many ports learnt from peers are asked: a corrupt registry cannot make the page probe hundreds. */
export const MAX_PEER_PORTS = 16;
export const DISCOVERY_MS = 1500;

export interface Discovery {
  /** Address found per kind, '' when none (or more than one) answered as that kind. */
  found: Record<BridgeKind, string>;
  /** Every bridge that answered, in port order. More than one of a kind is listed here for the person to pick. */
  all: { kind: BridgeKind; url: string }[];
  /** One sentence per thing the person should know: what was found, what was not, what was ambiguous. */
  notes: string[];
}

const KIND_NAME: Record<BridgeKind, string> = { engine: 'slicer bridge', printer: 'printer bridge' };

interface Hello {
  kind: BridgeKind | null;
  /** Loopback ports of the other bridges this one says are running. */
  peerPorts: number[];
}

/** Ask one loopback port what it is. kind null for silence, a refusal or anything else. */
async function hello(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Hello> {
  const none: Hello = { kind: null, peerPorts: [] };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url + '/v1/hello', { method: 'GET', credentials: 'omit', signal: ac.signal });
    if (!res.ok) return none;
    const j = (await res.json()) as { bridge?: unknown; peers?: unknown } | null;
    if (!j || typeof j !== 'object') return none;
    const kind = (Object.keys(HELLO_ID) as BridgeKind[]).find((k) => HELLO_ID[k] === j.bridge) ?? null;
    if (!kind) return none;
    const peerPorts = Array.isArray(j.peers)
      ? j.peers.map((p) => (p && typeof p === 'object' ? (p as { port?: unknown }).port : null)).filter((p): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536)
      : [];
    return { kind, peerPorts };
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverBridges(fetchImpl: FetchLike = (u, i) => fetch(u, i), ports: number[] = DISCOVERY_PORTS, timeoutMs = DISCOVERY_MS): Promise<Discovery> {
  const asked = new Map<number, BridgeKind | null>();
  const ask = async (list: number[]) => {
    const fresh = [...new Set(list)].filter((p) => !asked.has(p));
    fresh.forEach((p) => asked.set(p, null));
    const replies = await Promise.all(fresh.map((p) => hello(`http://127.0.0.1:${p}`, fetchImpl, timeoutMs)));
    fresh.forEach((p, i) => asked.set(p, replies[i].kind));
    return replies.flatMap((r) => r.peerPorts);
  };
  // Round 1: the defaults. Round 2: whatever they named and was not asked yet. A peer's own peers are
  // the same registry, so two rounds reach every registered bridge.
  const learnt = await ask(ports);
  await ask(learnt.filter((p) => !asked.has(p)).slice(0, MAX_PEER_PORTS));
  const all = [...asked.entries()]
    .filter((e): e is [number, BridgeKind] => e[1] !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([p, kind]) => ({ kind, url: `http://127.0.0.1:${p}` }));
  const found: Record<BridgeKind, string> = { engine: '', printer: '' };
  const notes: string[] = [];
  for (const k of Object.keys(HELLO_ID) as BridgeKind[]) {
    const at = all.filter((a) => a.kind === k).map((a) => a.url);
    if (at.length === 1) {
      found[k] = at[0];
      notes.push(`Found the ${KIND_NAME[k]} at ${at[0]}. Paste the key it printed when it started.`);
    } else if (at.length > 1) {
      notes.push(`More than one ${KIND_NAME[k]} answered (${at.join(', ')}); pick the one you mean.`);
    } else {
      notes.push(`No ${KIND_NAME[k]} answered on this computer. Start it, or type its address.`);
    }
  }
  return { found, all, notes };
}

/** Fill only the EMPTY addresses from a discovery. Keys and typed addresses are never touched. */
export function applyDiscovery(b: Bridges, d: Discovery): Bridges {
  const fill = (cfg: BridgeConfig, url: string): BridgeConfig => (cfg.url || !cleanUrl(url) ? cfg : { ...cfg, url: cleanUrl(url) });
  const engine = fill(b.engine, d.found.engine);
  const printer = fill(b.printer, d.found.printer);
  return engine === b.engine && printer === b.printer ? b : { engine, printer };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Client
 * ══════════════════════════════════════════════════════════════════════════ */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Every failure is a sentence. `status` 0 = the bridge did not answer at all. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Client {
  json<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, timeoutMs?: number): Promise<T>;
  bytes(method: 'GET' | 'POST', path: string, body?: ArrayBuffer, timeoutMs?: number): Promise<ArrayBuffer>;
  text(path: string, timeoutMs?: number): Promise<string>;
  postRaw<T = Record<string, unknown>>(path: string, body: ArrayBuffer, timeoutMs?: number): Promise<T>;
}

/** A slice of several plates with candidates can take minutes; the engine runs one job at a time. */
export const LONG_MS = 15 * 60 * 1000;
export const SHORT_MS = 20 * 1000;

export function client(cfg: BridgeConfig, name: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Client {
  const call = async (method: string, path: string, body: BodyInit | undefined, type: string | null, timeoutMs: number): Promise<Response> => {
    if (!cfg.url) throw new BridgeError(`The ${name} is not set up: add its address under Connections.`, 0);
    if (cfg.token.length < 16) throw new BridgeError(`The ${name} needs its key (the token it printed when it started).`, 0);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(cfg.url + path, {
        method,
        headers: { authorization: `Bearer ${cfg.token}`, ...(type ? { 'content-type': type } : {}) },
        body,
        signal: ac.signal,
      });
    } catch (e) {
      const aborted = ac.signal.aborted;
      throw new BridgeError(
        aborted
          ? `The ${name} did not answer within ${Math.round(timeoutMs / 1000)} s.`
          : `The ${name} at ${cfg.url} did not answer (${e instanceof Error ? e.message : String(e)}). Is it running?`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new BridgeError(`The ${name} refused the key (401). Paste the token it printed when it started.`, 401);
    if (res.status === 403) {
      const msg = await errText(res);
      throw new BridgeError(`The ${name} refused this page (403): ${msg}`, 403);
    }
    return res;
  };
  const errText = async (res: Response) => {
    const t = await res.text().catch(() => '');
    try {
      const j = JSON.parse(t) as { error?: unknown };
      const e = j.error;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
    } catch {
      /* not JSON */
    }
    return t.slice(0, 300) || `HTTP ${res.status}`;
  };
  const asJson = async <T>(res: Response): Promise<T> => {
    const t = await res.text();
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      throw new BridgeError(`The ${name} answered something that is not JSON (HTTP ${res.status}).`, res.status);
    }
    if (!res.ok) {
      const e = (j as { error?: unknown }).error;
      const msg = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : `HTTP ${res.status}`;
      throw new BridgeError(msg, res.status);
    }
    return j as T;
  };
  return {
    async json(method, path, body, timeoutMs = SHORT_MS) {
      const res = await call(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? null : 'application/json', timeoutMs);
      return asJson(res);
    },
    async bytes(method, path, body, timeoutMs = SHORT_MS) {
      const res = await call(method, path, body, body ? 'application/octet-stream' : null, timeoutMs);
      if (!res.ok) throw new BridgeError(await errText(res), res.status);
      return res.arrayBuffer();
    },
    async text(path, timeoutMs = SHORT_MS) {
      const res = await call('GET', path, undefined, null, timeoutMs);
      if (!res.ok) throw new BridgeError(await errText(res), res.status);
      return res.text();
    },
    async postRaw(path, body, timeoutMs = SHORT_MS) {
      const res = await call('POST', path, body, 'application/octet-stream', timeoutMs);
      return asJson(res);
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * What the engine bridge answers (pnp's shapes, through tools/print3d-bridge)
 * ══════════════════════════════════════════════════════════════════════════ */

export interface Health {
  ok: boolean;
  /** The engine this bridge slices with. `printed` is the bridge's own statement; it is false for every engine today. */
  engine: { id: string; label: string; bin: string; found: boolean; printed: boolean; defaults?: string; defaultsFound?: boolean };
  machine: { name: string; found: boolean };
}

/** What the person reads for an engine id the bridge reports. */
export function engineName(id: string | null | undefined): string {
  if (id === 'twobee-fdm') return '2bee.fdm (this app’s own engine)';
  if (id === 'orca') return 'the OrcaSlicer CLI (bridge started with --engine orca)';
  return 'an engine the bridge did not name';
}

/** Why the bridge cannot slice, in words, or '' when it can. */
export function healthProblems(h: Health): string[] {
  const e = h.engine;
  if (!e || typeof e !== 'object') return ['the bridge did not say which engine it slices with (an older bridge: restart it)'];
  return [
    !e.found ? `${engineName(e.id)} is not at ${e.bin}` : '',
    e.defaultsFound === false ? `its settings defaults file ${e.defaults ?? ''} is missing` : '',
    !h.machine.found ? `the ${h.machine.name} profile is missing` : '',
  ].filter(Boolean);
}

export interface Profiles {
  process: { name: string; source: string }[];
  filament: { name: string; source: string }[];
  bedTypes: string[];
  defaultBed: string;
  bed: { area: string[]; height: number; extruderAreas?: string[]; extruderHeights?: number[] } | null;
}

export interface SlotsReply {
  ok: boolean;
  bedPlate: string;
  slots: { id: string; label: string; type: string; color: string }[];
  types: string[];
  bedTypes: string[];
}

export interface UploadReply {
  ok: boolean;
  sha256: string;
  name: string;
  size: number;
  triangles: number;
  size3d: { x: number; y: number; z: number };
}

export interface PlanReply {
  ok: boolean;
  strategy: string;
  packNote?: string;
  beds: { index: number; objects: number[]; placements: ({ object: number } & { x: number; y: number; rot: number; tilt?: [number, number] })[] }[];
  tooBig: { index: number; name: string; size?: { x: number; y: number; z: number }; bed?: { w: number; d: number; h: number }; reason: string }[];
  assignment: { object: number; bed: number | null }[];
  bed: { w: number; d: number; h: number };
  summary: string;
  error?: string;
}

export interface SliceReply {
  ok: boolean;
  id: string;
  /** Which engine sliced it ('twobee-fdm' or 'orca'). Absent from an older bridge: the gates then refuse. */
  engine?: string;
  /** What this engine did not compute, by name (absent, never estimated). */
  notComputed?: string[];
  error?: string;
  log?: string;
  seconds?: string;
  bedIndex?: number;
  objects: { index: number; name: string; slot: string; placement: { x: number; y: number; rot: number; tilt?: [number, number] } }[];
  filaments: { id: number; slot: string; slotLabel: string; type: string; color: string; preset: string }[];
  slotChecks: { slot: string; slotType: string; preset: string; presetType: string; ok: boolean }[];
  warnings: string[];
  multiFilament: boolean;
  stats: { totalTime: string | null; printTime: string | null; layers: string | null; filamentG: string | null; filamentMm: string | null; bedType: string | null; nozzleTemp: string | null; layerHeight: string | null };
  analysis: { toolChanges: number; filaments: { grams?: number; mm?: number; towerGrams?: number }[] };
  wipeTower?: { bbox: [number, number, number, number] };
  optimise?: { objective: string; label: string; kept: boolean; chosen: { id: string; label: string }; tried: number; reason: string };
  bedRequested?: string;
  reusedSlice?: boolean;
}

export interface PrinterCheck {
  reachable: boolean;
  haveCode: boolean;
  printer: string;
  /** True when the bridge was started with --serial, so start/pause/stop/status can reach the printer. Absent from an older bridge. */
  haveSerial?: boolean;
}

export interface PrinterUpload {
  ok: boolean;
  remote?: string;
  bytes?: number;
  remoteBytes?: number;
  md5?: string;
  /** Always false: an upload never starts a print. Starting is its own call, /v1/start. */
  started: false;
}

/** The printer's own state, read over its LAN MQTT (`/v1/status`). */
export interface PrinterStatus {
  ok: boolean;
  /** Bambu gcode_state: IDLE, PREPARE, RUNNING, PAUSE, FINISH, FAILED, SLICING, ... */
  state: string;
  task: string;
  percent: number | null;
  layer: number | null;
  layers: number | null;
  remainMin: number | null;
  nozzle: number | null;
  nozzleTarget: number | null;
  bed: number | null;
  bedTarget: number | null;
  error: number;
  /** print_error in Bambu's HMS form, e.g. "0500-4046"; null when 0. */
  errorCode?: string | null;
  /** The chamber light as the printer reports it ('on' | 'off' | 'flashing'), null when not reported. */
  light?: string | null;
  /** The fan mode the printer reports ('Strong Cooling' | 'Heating'), null when it reports no airduct. */
  fanMode?: string | null;
  /** Each fan as the printer reports it. control: 'set' = settable from here, 'auto' = the printer runs it in this mode, 'off'. */
  fans?: PrinterFan[] | null;
  /** The fan mode id the printer reports, and the modes it lists (switchable). */
  fanModeId?: number | null;
  fanModes?: { id: number; name: string }[] | null;
  /** print_error described from Bambu's X2D table; null when 0 or not in the table. */
  errorText?: string | null;
  /** The printer's HMS messages. text null = Bambu's table has no description for that code. */
  hms?: { code: string; level: string; text: string | null }[];
  /** What the printer is doing now (stg_cur), named from Bambu Studio's table; null when idle. */
  stage?: { id: number; name: string } | null;
  /** Print speed level 1-4 (Silent, Standard, Sport, Ludicrous). */
  speed?: { level: number; name: string } | null;
  /** Label ids the printer reports as skipped. */
  skipped?: number[];
  /** Objects of the running file, when this printer bridge uploaded it; null otherwise. */
  /**
   * `hull`: the object's top-view footprint in bed mm, read off the file's own extrusion (convex
   * hull of the extruding moves). Absent when none was read; never guessed.
   */
  objects?: { id: number; name: string; hull?: [number, number][] }[] | null;
  /** The file's own `printable_area` polygon, bed mm; null when the file does not state it. */
  printableArea?: [number, number][] | null;
  slots: { id: string; type: string }[];
}

export interface PrinterFan {
  id: number;
  name: string;
  percent: number | null;
  control: 'set' | 'auto' | 'off';
}

/** `/v1/start`, `/v1/pause`, `/v1/resume`, `/v1/stop`, `/v1/light` and `/v1/fan` reply with the state the printer reported after the command. */
export interface PrinterStart {
  ok: boolean;
  started?: boolean;
  state: string;
  task?: string;
  light?: string | null;
  fans?: PrinterFan[] | null;
  fanMode?: string | null;
  speed?: { level: number; name: string } | null;
  skipped?: number[];
}
