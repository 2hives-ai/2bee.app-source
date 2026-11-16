// 2bee.3d inside 2bee.app: the print job the tab holds, as pure functions.
//
// SOURCE: pnp's 2bee.3d page, `/home/gbacs/build/web-slicer/public/app.js`
// (commit 65227d3 + working tree of 2026-10-15) and its contract
// `CONTRACT-chat-job.md` §1–§1a2. The job shape, the placement convention, the
// per-plate fingerprint and the STL shell split are ported from there; the
// server half (OrcaSlicer CLI, arrange, multi-plate planning) is
// `tools/print3d-bridge/`, which vendors pnp's modules.
//
// 🔴 WORDS. Orca and the printer call one build surface a PLATE, and this file
// does too in everything a person reads. The bridge's JSON keeps pnp's field
// names (`bed`, `bedIndex`, `beds`) because they are a wire contract; they are
// identifiers here, never text on screen.
//
// 🔴 NOTHING HERE HAS PRINTED. These functions describe a job; whether the X2D
// prints it the way the numbers say has never been checked from this code.

/** A filament slot as the slicer bridge stores it. When the printer bridge can read the printer, every slot the printer
 *  reports is overwritten from that report (`syncSlots`); otherwise it is what the person declared. */
export interface SlotDecl {
  id: string;
  label: string;
  /** Filament type ("PETG"), or '' when nothing is declared in the slot. */
  type: string;
  color: string;
}

export interface FileRec {
  name: string;
  size: number;
  sha256: string;
  size3d?: { x: number; y: number; z: number };
  triangles?: number;
}

/** pnp's convention: x,y = world centre of the part's own XY box after `rot` (deg, CCW about Z); tilt = [rx, ry] in 90° steps. */
export interface Placement {
  x: number;
  y: number;
  rot: number;
  tilt?: [number, number];
}

export interface Obj {
  /** One per copy. */
  uid: number;
  /** One per row in the list: copies of a row share it. */
  gid: number;
  /** Index into `JobState.files`. */
  file: number;
  slot: string;
  placement: Placement | null;
  /** 1-based plate number, or null while not yet arranged. */
  plate: number | null;
  /** This part's own settings (OBJECT_KEYS only), shared by the copies of its row. Absent = the plate's settings. */
  overrides?: Record<string, string>;
}

/**
 * Settings a single part can have on its own (founder 2026-11-13: "the variables should be assigned to 1 object").
 * The same list as the slicer bridge's OBJECT_KEYS (tools/print3d-bridge/engine.cjs) and 2bee.fdm's `--oset`: the keys
 * its per-object planning reads. Everything else is plate-wide.
 */
export const OBJECT_KEYS: readonly string[] = ['wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density'];

/** Plain names for OBJECT_KEYS, for the row line. */
export const OBJECT_KEY_LABEL: Record<string, string> = { wall_loops: 'walls', top_shell_layers: 'top layers', bottom_shell_layers: 'bottom layers', sparse_infill_density: 'infill' };

/** Split a full settings map into the part's own keys and the plate's. */
export function splitObjectKeys(all: Record<string, string>): { object: Record<string, string>; plate: Record<string, string> } {
  const object: Record<string, string> = {};
  const plate: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) (OBJECT_KEYS.includes(k) ? object : plate)[k] = v;
  return { object, plate };
}

/** Set one row's own settings (every copy of it). Empty = back to the plate's. */
export function withRowOverrides(job: JobState, gid: number, ov: Record<string, string>): JobState {
  const clean = Object.fromEntries(Object.entries(ov).filter(([k]) => OBJECT_KEYS.includes(k)));
  const has = Object.keys(clean).length > 0;
  return {
    ...job,
    objects: job.objects.map((o) => {
      if (o.gid !== gid) return o;
      const { overrides: _old, ...rest } = o;
      return has ? { ...rest, overrides: { ...clean } } : rest;
    }),
  };
}

/** Clone a row as a NEW row (founder 2026-11-13: "the clone should clone the same object so I can set different
 *  variables for"): same file, slot and own settings, one copy, unplaced, its settings changed apart from the original. */
export function withClonedRow(job: JobState, gid: number, nextUid: () => number, newGid: number): JobState {
  const src = job.objects.find((o) => o.gid === gid);
  if (!src) return job;
  const last = job.objects.map((o) => o.gid).lastIndexOf(gid);
  const add: Obj = { uid: nextUid(), gid: newGid, file: src.file, slot: src.slot, placement: null, plate: null, ...(src.overrides ? { overrides: { ...src.overrides } } : {}) };
  const objects = job.objects.slice();
  objects.splice(last + 1, 0, add);
  return { ...job, objects };
}

export type Objective = 'fastest' | 'quality' | 'balanced';
export type Strategy = 'fit' | 'filament' | 'balance' | 'tall';

export const OBJECTIVES: readonly { id: Objective; label: string }[] = [
  { id: 'fastest', label: 'Fastest' },
  { id: 'quality', label: 'Best quality' },
  { id: 'balanced', label: 'Balanced' },
];
/** pnp's strategy ids, with labels in plate words. */
export const STRATEGIES: readonly { id: Strategy; label: string }[] = [
  { id: 'fit', label: 'Fit as many as possible on plate 1' },
  { id: 'filament', label: 'Group by filament' },
  { id: 'balance', label: 'Balance print time across plates' },
  { id: 'tall', label: 'Keep tall parts apart' },
];

export interface JobState {
  name: string;
  files: FileRec[];
  objects: Obj[];
  /** Explicit filament preset per slot. A slot without one gets the bridge's Generic preset of its type. */
  slotPresets: Record<string, string>;
  /** Orca keys, already through `validateOverrides`. */
  overrides: Record<string, string>;
  process: string;
  objective: Objective;
  allowTilt: boolean;
  strategy: Strategy;
  /**
   * Who placed the parts. 'app' (the default, founder 2026-10-16): this tab's own
   * `layout3d.ts` arranged them and the bridge slices exactly there (optimise off).
   * 'bridge': the person asked for a bridge strategy or objective, so the bridge
   * arranges and its optimiser may move parts within a plate.
   */
  layout: 'app' | 'bridge';
}

export const EMPTY_JOB: JobState = {
  name: 'job',
  files: [],
  objects: [],
  slotPresets: {},
  overrides: {},
  process: '',
  objective: 'balanced',
  allowTilt: true,
  strategy: 'fit',
  layout: 'app',
};

/** Rows of the object list: one per `gid`, in first-seen order. */
export function rows(job: JobState): { gid: number; first: Obj; copies: Obj[] }[] {
  const out: { gid: number; first: Obj; copies: Obj[] }[] = [];
  for (const o of job.objects) {
    const r = out.find((x) => x.gid === o.gid);
    if (r) r.copies.push(o);
    else out.push({ gid: o.gid, first: o, copies: [o] });
  }
  return out;
}

export const baseName = (n: string) => String(n).replace(/\.stl$/i, '');

export const usedSlots = (job: JobState): string[] => [...new Set(job.objects.map((o) => o.slot))];

export const plateNumbers = (job: JobState): number[] =>
  [...new Set(job.objects.map((o) => o.plate).filter((p): p is number => typeof p === 'number' && p >= 1))].sort((a, b) => a - b);

export const plateObjects = (job: JobState, plate: number): Obj[] => job.objects.filter((o) => o.plate === plate);

/**
 * The body every job route takes (pnp `jobBody`). With `forArrange` every
 * placement is dropped so the bridge arranges from scratch.
 */
export function jobBody(job: JobState, buildPlate: string, forArrange = false) {
  const placed = !forArrange && job.objects.length > 0 && job.objects.every((o) => o.placement);
  const slotPresets: Record<string, string> = {};
  for (const id of usedSlots(job)) if (job.slotPresets[id]) slotPresets[id] = job.slotPresets[id];
  return {
    version: 1 as const,
    name: job.name,
    bed: buildPlate,
    process: job.process,
    files: job.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
    objects: job.objects.map((o) => ({
      file: o.file,
      slot: o.slot,
      placement: placed ? o.placement : null,
      ...(o.plate && !forArrange ? { bed: o.plate } : {}),
      ...(o.overrides && Object.keys(o.overrides).length ? { overrides: { ...o.overrides } } : {}),
    })),
    slotPresets,
    overrides: { ...job.overrides },
    objective: job.objective,
    allowTilt: job.allowTilt,
  };
}

/** What a SAVED job holds: a row with copies is ONE entry with qty (pnp `saveBody`). */
export function saveBody(job: JobState, buildPlate: string) {
  const b = jobBody(job, buildPlate);
  const objects = rows(job).map((r) => {
    const i = job.objects.indexOf(r.first);
    return r.copies.length > 1
      ? { file: r.first.file, slot: r.first.slot, placement: null, qty: r.copies.length, ...(r.first.overrides ? { overrides: { ...r.first.overrides } } : {}) }
      : b.objects[i];
  });
  return { ...b, objects };
}

/** djb2-xor, as pnp's page. A change detector, not a security hash. */
export function hash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Everything one plate's G-code depends on. Equal fingerprint = the last slice still describes this plate. */
export function plateFp(job: JobState, plate: number, buildPlate: string, slots: readonly SlotDecl[]): string {
  const os = plateObjects(job, plate);
  const ids = [...new Set(os.map((o) => o.slot))].sort();
  return hash(
    JSON.stringify([
      job.objective,
      job.allowTilt,
      job.layout,
      os.map((o) => [job.files[o.file]?.sha256, o.slot, o.placement, o.overrides ?? null]),
      job.overrides,
      job.process,
      buildPlate,
      ids.map((id) => [id, job.slotPresets[id] ?? '', slots.find((s) => s.id === id)?.type ?? '']),
    ]),
  );
}

/** Why a plate cannot be sliced yet, or ''. */
export function waitingReason(job: JobState, plate: number, slots: readonly SlotDecl[]): string {
  const missing = [...new Set(plateObjects(job, plate).map((o) => o.slot))].filter((id) => !slots.find((s) => s.id === id)?.type);
  if (!missing.length) return '';
  const names = missing.map((id) => slots.find((s) => s.id === id)?.label ?? id);
  return `Waiting: no filament in ${names.join(', ')}`;
}

/** A slot as the printer reports it over the printer bridge (`/v1/status`). color null = not reported. */
export interface ReportedSlot {
  id: string;
  type: string;
  color?: string | null;
}

/** Stored slots brought in line with what the printer reports (founder 2026-10-22: the spool was changed on the printer
 *  and the app could not follow). A reported slot wins over a declared one. A reported type the slicer does not know
 *  is REFUSED: the slot becomes empty and is named in `unknown`, never mapped to the nearest known type, because the
 *  slicer picks temperatures from it. Slots the printer does not report keep their declaration. */
export function syncSlots(
  stored: readonly SlotDecl[],
  reported: readonly ReportedSlot[],
  known: readonly string[],
): { slots: SlotDecl[]; changed: boolean; unknown: { id: string; label: string; type: string }[]; live: string[] } {
  const unknown: { id: string; label: string; type: string }[] = [];
  const live: string[] = [];
  let changed = false;
  const slots = stored.map((s) => {
    const r = reported.find((x) => x.id === s.id);
    if (!r) return s;
    live.push(s.id);
    const type = r.type === '' || known.includes(r.type) ? r.type : '';
    if (type !== r.type) unknown.push({ id: s.id, label: s.label, type: r.type });
    // An empty tray reports a colour too (often black): keep the stored one rather than repaint an empty slot.
    const color = type && r.color ? r.color : s.color;
    if (type === s.type && color === s.color) return s;
    changed = true;
    return { ...s, type, color };
  });
  return { slots, changed, unknown, live };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Quantities
 * ══════════════════════════════════════════════════════════════════════════ */

/** Set a row's copy count. New copies are unplaced and unassigned; the arrange that follows places them. */
export function withQty(job: JobState, gid: number, n: number, nextUid: () => number): JobState {
  const copies = job.objects.filter((o) => o.gid === gid);
  if (!copies.length) return job;
  const want = Math.max(1, Math.min(999, Math.round(Number(n)) || 1));
  if (want === copies.length) return job;
  if (want < copies.length) {
    const drop = new Set(copies.slice(want).map((o) => o.uid));
    return { ...job, objects: job.objects.filter((o) => !drop.has(o.uid)) };
  }
  const at = job.objects.indexOf(copies[copies.length - 1]) + 1;
  const added: Obj[] = [];
  for (let k = copies.length; k < want; k++)
    added.push({ uid: nextUid(), gid, file: copies[0].file, slot: copies[0].slot, placement: null, plate: null, ...(copies[0].overrides ? { overrides: { ...copies[0].overrides } } : {}) });
  const objects = job.objects.slice();
  objects.splice(at, 0, ...added);
  return { ...job, objects };
}

/** Remove a row (every copy) and any file nobody uses any more, re-indexing the rest. */
export function withoutRow(job: JobState, gid: number): JobState {
  const objects = job.objects.filter((o) => o.gid !== gid);
  const used = new Set(objects.map((o) => o.file));
  const map = new Map<number, number>();
  const files: FileRec[] = [];
  job.files.forEach((f, k) => {
    if (used.has(k)) {
      map.set(k, files.length);
      files.push(f);
    }
  });
  return { ...job, files, objects: objects.map((o) => ({ ...o, file: map.get(o.file)! })), ...(objects.length ? {} : { name: 'job' }) };
}

/* ════════════════════════════════════════════════════════════════════════════
 * STL
 * ══════════════════════════════════════════════════════════════════════════ */

/** Triangle vertices, 9 floats per triangle. Binary (size matches 84+50n) or ASCII. Empty when unreadable. */
export function parseStl(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (n > 0 && buf.byteLength === 84 + 50 * n) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + 50 * i + 12;
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(o + 4 * k, true);
      }
      return out;
    }
  }
  const txt = new TextDecoder('latin1').decode(buf);
  if (!/^\s*solid/.test(txt)) return new Float32Array(0);
  const v: number[] = [];
  for (const m of txt.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) v.push(+m[1], +m[2], +m[3]);
  return v.length % 9 ? new Float32Array(0) : Float32Array.from(v);
}

/** A binary STL from triangle vertices. Normals are left 0: the slicer recomputes them. */
export function writeBinaryStl(tri: Float32Array): ArrayBuffer {
  const n = Math.floor(tri.length / 9);
  const out = new ArrayBuffer(84 + 50 * n);
  const o = new DataView(out);
  o.setUint32(80, n, true);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o.setFloat32(84 + 50 * t + 12 + 4 * k, tri[9 * t + k], true);
  return out;
}

/**
 * Split one STL into its separate parts (pnp `splitStlShells`): vertices welded
 * at 1e-4 mm, then a union-find over triangles that share a vertex. Largest
 * first. Parts that touch or overlap stay together — this is geometry, not a
 * guess about what the person meant.
 */
export function splitShells(buf: ArrayBuffer): Float32Array[] {
  const tri = parseStl(buf);
  const T = Math.floor(tri.length / 9);
  if (!T) return [];
  const ids = new Map<string, number>();
  const par: number[] = [];
  const vid = new Array<number>(T * 3);
  const find = (a: number) => {
    while (par[a] !== a) {
      par[a] = par[par[a]];
      a = par[a];
    }
    return a;
  };
  for (let i = 0; i < T * 3; i++) {
    const key = `${tri[3 * i].toFixed(4)},${tri[3 * i + 1].toFixed(4)},${tri[3 * i + 2].toFixed(4)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = par.length;
      ids.set(key, id);
      par.push(id);
    }
    vid[i] = id;
  }
  for (let t = 0; t < T; t++) {
    const a = find(vid[3 * t]);
    par[find(vid[3 * t + 1])] = a;
    par[find(vid[3 * t + 2])] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    const r = find(vid[3 * t]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(t);
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((ts) => {
      const out = new Float32Array(ts.length * 9);
      ts.forEach((t, i) => out.set(tri.subarray(9 * t, 9 * t + 9), 9 * i));
      return out;
    });
}

/* ════════════════════════════════════════════════════════════════════════════
 * Time and text
 * ══════════════════════════════════════════════════════════════════════════ */

/** Orca's "1h 2m 3s" / "1d 2h" → seconds. */
export function secsOf(t: unknown): number {
  const m = String(t ?? '').match(/(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}

export function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** "done 14:25" / "done tomorrow 02:10" / "done Sat 09:00", if it were started now. */
/** Minutes left as the person reads them (founder 2026-11-13: "show the remaining time in hours, minutes"):
 *  228 -> "3 h 48 min", 45 -> "45 min", 120 -> "2 h 0 min". Not a number -> "–". */
export function hoursMin(min: number | null | undefined): string {
  if (typeof min !== 'number' || !Number.isFinite(min) || min < 0) return '–';
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function finishAt(secs: number, now: Date = new Date()): string {
  if (!(secs > 0)) return '';
  const e = new Date(now.getTime() + secs * 1000);
  const hm = `${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`;
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d1 = new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime();
  const dd = Math.round((d1 - d0) / 86400000);
  const day = dd <= 0 ? '' : dd === 1 ? 'tomorrow ' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][e.getDay()]} `;
  return `done ${day}${hm}`;
}

/** Orca writes grams per filament as "1.23, 4.56". */
export const gramsTotal = (g: unknown): number => String(g ?? '').split(',').reduce((t, v) => t + (Number(v) || 0), 0);

/** The pnp preset-name type guess (used only to warn, never to choose). */
export function typeOfPreset(n: string): string {
  const m = String(n).toUpperCase().match(/PETG-CF|PLA-CF|PA-CF|PETG|PLA|ASA|ABS|TPU|PVA|HIPS|PC|PA\b/);
  return m ? m[0] : '';
}
