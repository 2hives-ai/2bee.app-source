// The machine registry for 2bee.cnc: which routers this shop has, how each is
// reached, what each is known to be, and which cutters each one holds.
//
// Founder 2026-10-14 (docs/plan-2bee-cnc-redesign.md): *"manage multiple cnc
// machines"*, *"a network bridge per router"*. So the registry is built for
// several machines from the start, and a machine is reached through a
// CONNECTION that names what it is:
//
//   · `{ kind: 'bridge', url }` — the per-router network bridge. 🔴 IT DOES NOT
//     EXIST YET (plan phase 3). A bridge machine can be registered, so the
//     shape is real, but nothing in this app opens a connection to it. Every
//     screen says so rather than showing a status it never read.
//   · `{ kind: 'simulated' }` — `run/fake.ts`'s healthy grblHAL persona, in this
//     page. The only machine anything can run on today, and it says SIMULATED
//     everywhere it is shown.
//
// Pure functions plus a localStorage read/write, the same shape as
// `inventory.ts`: nothing is restored that cannot be validated, and an entry
// that fails is DROPPED BY NAME, never repaired. A machine record is a claim
// about a physical shop; a repaired one is a claim nobody made.
//
// 🔴 TOOLS PER MACHINE ARE A SUBSET OF THE REGISTERED TOOLS. A machine cannot
// "hold" a cutter the shop has not registered (Expert tools → Tools), because
// the planner may only choose registered cutters and a machine list that
// disagreed with the registry would plan with a cutter nobody owns.
//
// 🔴 NOTHING HERE WRITES CONTROLLER SETTINGS. The router profile is READ from
// the Analyse step (`run/routerProfile.ts`, read-only commands) and stored as
// what it read.

import type { RouterProfile } from '../run/routerProfile';

export type Connection = { kind: 'bridge'; url: string } | { kind: 'simulated' };

/** What the Analyse step read, reduced to what the cards and the planner show. */
export interface MachineProfile {
  firmware: string | null;
  /** Configured travel, mm, as the controller states it. NOT measured. */
  travel: { X: number | null; Y: number | null; Z: number | null };
  spindleMaxRpm: number | null;
  /** How many `stop`/`check` flags the analysis raised. */
  flags: number;
  analysedAt: number;
}

export interface Machine {
  /** Stable id. Equal to the hostname for machines added here. */
  id: string;
  /** `cnc-NN` (proposed by pcb/ops 2026-10-15), or `cnc-sim`. */
  hostname: string;
  connection: Connection;
  /** `null` until the Analyse step has read this machine. */
  profile: MachineProfile | null;
  /** Registered cutter ids this machine holds. A subset of the Tools registry. */
  toolIds: string[];
  /** The cutter the operator says is in the collet now, or `null` if unknown. */
  inCollet: string | null;
  /**
   * 🔴 A physical e-stop is installed on THIS machine. Default false, NO UI
   * sets it, and a stored value is IGNORED on read: it comes only from
   * {@link ESTOP_INSTALLED} in this file, changed in a commit when ops closes
   * depot SOP item H5 for that machine (pcb 2026-10-15-01-20-26).
   */
  estopInstalled: boolean;
  /** Host facts as pcb/ops stated them, where known. */
  host: { mdns: string; os: string } | null;
  addedAt: number;
}

/**
 * Machines with a physical e-stop installed (ops depot SOP item H5 closed).
 * EMPTY as of 2026-10-15: no e-stop was ever ordered. Add a hostname here only
 * in the commit that cites ops closing H5 for it.
 */
export const ESTOP_INSTALLED: readonly string[] = [];

/**
 * The first real machine, from pcb/ops host facts (2026-10-15): `cnc-01`,
 * reached as `cnc-01.local`, Raspberry Pi OS Lite 64-bit. Its bridge is NOT
 * BUILT: the URL is the address it will have, and nothing connects to it.
 */
export const KNOWN_MACHINES: readonly Omit<Machine, 'addedAt'>[] = [
  {
    id: 'cnc-01',
    hostname: 'cnc-01',
    connection: { kind: 'bridge', url: 'http://cnc-01.local' },
    profile: null,
    toolIds: [],
    inCollet: null,
    estopInstalled: false,
    host: { mdns: 'cnc-01.local', os: 'Raspberry Pi OS Lite 64-bit' },
  },
];

export interface MachineRegistry {
  version: 1;
  machines: Machine[];
}

export const EMPTY_REGISTRY: MachineRegistry = { version: 1, machines: [] };

export const SIM_ID = 'cnc-sim';
export const MACHINES_KEY = '2bee.app.cncjob.machines';

/** `cnc-01` … `cnc-99`. The proposal from pcb/ops, 2026-10-15. */
export const HOSTNAME_RE = /^cnc-\d{2}$/;

export function isSimulated(m: Pick<Machine, 'connection'>): boolean {
  return m.connection.kind === 'simulated';
}

/** The name a person reads. SIMULATED is part of the name, so it cannot be dropped by a layout. */
export function displayName(m: Pick<Machine, 'hostname' | 'connection'>): string {
  return isSimulated(m) ? `${m.hostname} (SIMULATED)` : m.hostname;
}

export function simulatedMachine(now: number): Machine {
  return { id: SIM_ID, hostname: SIM_ID, connection: { kind: 'simulated' }, profile: null, toolIds: [], inCollet: null, estopInstalled: false, host: null, addedAt: now };
}

/** A registry always carries the simulated machine (the one thing that can run) and the known real ones. */
export function withSimulated(reg: MachineRegistry, now: number): MachineRegistry {
  let machines = reg.machines;
  if (!machines.some((m) => m.id === SIM_ID)) machines = [simulatedMachine(now), ...machines];
  for (const k of KNOWN_MACHINES) if (!machines.some((m) => m.id === k.id)) machines = [...machines, { ...k, addedAt: now }];
  return machines === reg.machines ? reg : { ...reg, machines };
}

/** The next free `cnc-NN`. */
export function proposeHostname(reg: MachineRegistry): string {
  const taken = new Set(reg.machines.map((m) => m.hostname));
  for (let n = 1; n < 100; n++) {
    const h = `cnc-${String(n).padStart(2, '0')}`;
    if (!taken.has(h)) return h;
  }
  return 'cnc-99';
}

/** A bridge URL: http(s), a host, no credentials in it. */
export function bridgeUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `"${url}" is not a URL.`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The bridge URL must start with http:// or https://.';
  if (u.username || u.password) return 'Do not put a password in the bridge URL.';
  if (!u.hostname) return 'The bridge URL has no host.';
  return null;
}

export type RegistryOutcome = { ok: true; reg: MachineRegistry; id: string } | { ok: false; problem: string };

/** Add a router reached through its (future) network bridge. */
export function addBridgeMachine(reg: MachineRegistry, hostname: string, url: string, now: number): RegistryOutcome {
  const h = hostname.trim();
  if (!HOSTNAME_RE.test(h)) return { ok: false, problem: `"${h}" is not a machine name of the form cnc-01.` };
  if (reg.machines.some((m) => m.hostname === h || m.id === h)) return { ok: false, problem: `${h} is already registered.` };
  const bad = bridgeUrlProblem(url.trim());
  if (bad) return { ok: false, problem: bad };
  const m: Machine = { id: h, hostname: h, connection: { kind: 'bridge', url: url.trim() }, profile: null, toolIds: [], inCollet: null, estopInstalled: ESTOP_INSTALLED.includes(h), host: null, addedAt: now };
  return { ok: true, reg: { ...reg, machines: [...reg.machines, m] }, id: h };
}

export function removeMachine(reg: MachineRegistry, id: string): MachineRegistry {
  return { ...reg, machines: reg.machines.filter((m) => m.id !== id) };
}

export function machineById(reg: MachineRegistry, id: string): Machine | null {
  return reg.machines.find((m) => m.id === id) ?? null;
}

function patch(reg: MachineRegistry, id: string, f: (m: Machine) => Machine): MachineRegistry {
  return { ...reg, machines: reg.machines.map((m) => (m.id === id ? f(m) : m)) };
}

/**
 * Set the cutters a machine holds. 🔴 Refuses an id the shop has not
 * registered, by name; nothing is matched to a similar cutter.
 */
export function setMachineTools(reg: MachineRegistry, id: string, toolIds: readonly string[], registered: readonly string[]): RegistryOutcome {
  if (!machineById(reg, id)) return { ok: false, problem: `No machine ${id}.` };
  const unknown = toolIds.filter((t) => !registered.includes(t));
  if (unknown.length) return { ok: false, problem: `Not registered under Tools: ${unknown.join(', ')}.` };
  const uniq = [...new Set(toolIds)];
  return { ok: true, reg: patch(reg, id, (m) => ({ ...m, toolIds: uniq, inCollet: m.inCollet && uniq.includes(m.inCollet) ? m.inCollet : null })), id };
}

/** Which cutter is in the collet. Must be one the machine holds, or `null`. */
export function setInCollet(reg: MachineRegistry, id: string, toolId: string | null): RegistryOutcome {
  const m = machineById(reg, id);
  if (!m) return { ok: false, problem: `No machine ${id}.` };
  if (toolId !== null && !m.toolIds.includes(toolId)) return { ok: false, problem: `${toolId} is not one of ${m.hostname}'s cutters.` };
  return { ok: true, reg: patch(reg, id, (x) => ({ ...x, inCollet: toolId })), id };
}

/**
 * The collet record after a TOOL CHANGE stop is resumed. The comment names the
 * cutter now in the spindle; when that name is not one of this machine's
 * cutters (a name the post cut to fit the line buffer ends in `...`) the record
 * must not keep naming the OLD cutter — the next job's loaded check would pass
 * on it. It becomes "nothing recorded", which that check refuses until a person
 * says what is fitted.
 */
export function colletAfterChange(reg: MachineRegistry, id: string, named: string): RegistryOutcome {
  const r = setInCollet(reg, id, named);
  return r.ok ? r : setInCollet(reg, id, null);
}

/** The Analyse step's reading, reduced. Stored as read; nothing is written back. */
export function profileSummary(p: RouterProfile, now: number): MachineProfile {
  return { firmware: p.firmware, travel: { ...p.travel }, spindleMaxRpm: p.spindleRpm.max, flags: p.flags.length, analysedAt: now };
}

export function setProfile(reg: MachineRegistry, id: string, profile: MachineProfile): MachineRegistry {
  return patch(reg, id, (m) => ({ ...m, profile }));
}

/**
 * "Loaded" check: does this machine hold every cutter the job needs, and is
 * the first one in the collet? Each gap is a sentence, never a boolean alone.
 */
export function loadedCheck(m: Pick<Machine, 'toolIds' | 'inCollet' | 'hostname'>, jobTools: readonly string[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const missing = jobTools.filter((t) => !m.toolIds.includes(t));
  if (missing.length) problems.push(`${m.hostname} does not hold: ${missing.join(', ')}.`);
  const first = jobTools[0];
  if (first && m.inCollet !== first) {
    problems.push(m.inCollet ? `${m.inCollet} is in the collet; the job starts with ${first}.` : `Nothing is recorded in the collet; the job starts with ${first}.`);
  }
  return { ok: problems.length === 0, problems };
}

function isConn(c: unknown): c is Connection {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  if (o.kind === 'simulated') return true;
  return o.kind === 'bridge' && typeof o.url === 'string' && bridgeUrlProblem(o.url) === null;
}

function readProfile(p: unknown): MachineProfile | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const t = (o.travel ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (typeof o.analysedAt !== 'number') return null;
  return {
    firmware: typeof o.firmware === 'string' ? o.firmware : null,
    travel: { X: n(t.X), Y: n(t.Y), Z: n(t.Z) },
    spindleMaxRpm: n(o.spindleMaxRpm),
    flags: n(o.flags) ?? 0,
    analysedAt: o.analysedAt,
  };
}

/** Validate a stored registry. Bad entries are dropped BY NAME into `dropped`. */
export function validateRegistry(raw: unknown, dropped: string[] = []): MachineRegistry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const machines: Machine[] = [];
  if (Array.isArray(r.machines)) {
    for (const item of r.machines as Record<string, unknown>[]) {
      const e = item ?? {};
      const label = typeof e.hostname === 'string' ? e.hostname : JSON.stringify(e).slice(0, 40);
      if (typeof e.id !== 'string' || typeof e.hostname !== 'string' || !e.id) {
        dropped.push(`${label}: no id or name`);
        continue;
      }
      if (!isConn(e.connection)) {
        dropped.push(`${label}: its connection is not one this build knows`);
        continue;
      }
      const simulated = (e.connection as Connection).kind === 'simulated';
      if (simulated !== (e.id === SIM_ID)) {
        dropped.push(`${label}: only ${SIM_ID} may be simulated`);
        continue;
      }
      if (!simulated && !HOSTNAME_RE.test(e.hostname)) {
        dropped.push(`${label}: not a cnc-NN name`);
        continue;
      }
      if (machines.some((m) => m.id === e.id)) {
        dropped.push(`${label}: listed twice`);
        continue;
      }
      const toolIds = Array.isArray(e.toolIds) ? (e.toolIds as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      const inCollet = typeof e.inCollet === 'string' && toolIds.includes(e.inCollet) ? e.inCollet : null;
      machines.push({
        id: e.id,
        hostname: e.hostname,
        connection: e.connection as Connection,
        profile: readProfile(e.profile),
        toolIds,
        inCollet,
        /* 🔴 Never read from storage: a stored `true` is not ops closing H5. */
        estopInstalled: ESTOP_INSTALLED.includes(e.hostname),
        host: KNOWN_MACHINES.find((k) => k.id === e.id)?.host ?? null,
        addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
      });
    }
  }
  return { version: 1, machines };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readMachines(storage: StorageLike | null, now: number): { reg: MachineRegistry; dropped: string[] } {
  const dropped: string[] = [];
  let raw: unknown = null;
  try {
    const s = storage?.getItem(MACHINES_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    dropped.push('the saved machine list could not be read');
  }
  return { reg: withSimulated(validateRegistry(raw, dropped), now), dropped };
}

/** Returns why it could not be saved, or `null`. */
export function writeMachines(storage: StorageLike | null, reg: MachineRegistry): string | null {
  try {
    if (!storage) return 'No storage in this browser: the machine list holds for this page only.';
    storage.setItem(MACHINES_KEY, JSON.stringify(reg));
    return null;
  } catch (e) {
    return `The machine list could not be saved: ${String((e as Error).message ?? e)}`;
  }
}

/**
 * The operator's OWN probe setting and touch-plate thickness, from the same store the expert
 * cnc tab sends them from (App.tsx: `probe_enabled`, and `touch_plate_mm` only when stated).
 *
 * 🔴 The Make step and 2bee.cnc sent NEITHER, so the core's import job probed with the
 * reference-fixture machine's 1.6 mm plate: `G10 L20 P1 Z1.600` in every router program they
 * planned, while setup reported it as a fact. With a real 15 mm plate every Z is 13.4 mm too
 * deep — through-cuts into the spoilboard, "safe" Z5 rapids through the workpiece (bughunt
 * 2026-11-15). The core no longer supplies a plate for imports; a host that probes must state it.
 */
export function probeFields(s: { probeEnabled: boolean; touchPlateMm: string }): Record<string, unknown> {
  const t = s.touchPlateMm.trim();
  return { probe_enabled: s.probeEnabled, ...(t === '' ? {} : { touch_plate_mm: Number(t) }) };
}

/**
 * The collets a small shop owns beyond the one in the spindle (1/8", 1/4", 8 mm). A cutter that
 * needs one is SELECTABLE and the plan says which collet to fit: a router tool change is routinely
 * a collet change too. ⚠ An ASSUMPTION about the shop, stated here once and SENT to the core, so the
 * core plans with the same drawer the UI shows (`App.tsx` lists cutters with it).
 * 🔴 bughunt 2026-11-15: 411b33a0f3 rightly stopped the core's import job borrowing the reference
 * fixture's drawer, and no host sent one: 2bee.cnc and the Make step refused every cutter but 6 mm
 * ("the shop's collets are 6mm") while the expert tab offered the 3.175 mm one. E2E J9 caught it.
 */
export const SPARE_COLLETS_MM: readonly number[] = [3.175, 6.35, 8.0];

/** `MachineCfg` keys every host sends for the router: the operator's probe setting and plate, and the collet drawer. */
export function shopFields(s: { probeEnabled: boolean; touchPlateMm: string }): Record<string, unknown> {
  return { ...probeFields(s), spare_collets_mm: [...SPARE_COLLETS_MM] };
}

/** The router's own limits as the core's `MachineCfg` keys: only what its profile STATES (a null is left out, so the
 *  core's default applies and the plan says so). 🔴 Until 2026-11-14 nothing of the machine was sent: every 2bee.cnc
 *  plan used the core's generic 600x900x100 mm travel and 24000 rpm spindle, so a part that fits 600x900 was accepted
 *  for a smaller router (a soft-limit alarm mid-cut) and S words were not held to its real spindle. */
export function machineConfig(m: { hostname: string; profile: MachineProfile | null } | null | undefined): { machine?: Record<string, unknown>; note: string } {
  if (!m) return { note: 'Machine: none selected; planned on the core\'s generic machine (600 × 900 mm travel).' };
  const p = m.profile;
  const cfg: Record<string, unknown> = { name: m.hostname };
  const said: string[] = [];
  const missing: string[] = [];
  for (const [k, v, label] of [['travel_x_mm', p?.travel.X, 'X travel'], ['travel_y_mm', p?.travel.Y, 'Y travel'], ['travel_z_mm', p?.travel.Z, 'Z travel'], ['spindle_max_rpm', p?.spindleMaxRpm, 'max spindle rpm']] as const) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) { cfg[k] = v; said.push(`${label} ${v}`); } else missing.push(label);
  }
  const note = !p
    ? `Machine: ${m.hostname} has not been analysed; planned on the core's generic machine (600 × 900 mm travel). Analyse it before cutting.`
    : missing.length
      ? `Machine: ${m.hostname} — ${said.join(', ') || 'nothing stated'}; not stated by its controller: ${missing.join(', ')} (the core's generic value is used).`
      : `Machine: ${m.hostname} — ${said.join(', ')}, from its controller.`;
  return { machine: cfg, note };
}
