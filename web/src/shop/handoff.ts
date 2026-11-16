// HANDING A DESIGN FROM THE SHOP TO 2bee.cad — WITHOUT WRITING BEHIND ITS BACK.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY THIS IS A SUBSCRIPTION AND NOT A WRITE TO THE SESSION STORE
// ═══════════════════════════════════════════════════════════════════════════
//
// The obvious implementation is to write the chosen design into
// `2bee.app.cad.session` and switch tabs. It is also the one that loses work.
//
// `CadTab` reads that key EXACTLY ONCE, at mount (`readSession`), and is mounted
// lazily and then kept. So the store route has two failure modes and they are
// opposite: with the tab already mounted the write is IGNORED and the user is
// dropped into their old model wondering what the click did; with it not yet
// mounted the write LANDS — on top of whatever unsaved text the session held,
// with no undo, because the tab's history lives in `replace.ts` and a storage
// write never touches it.
//
// So nothing here writes storage. The shop publishes a request; the tab
// consumes it through `replaceEditor`, the same door `File -> Open` uses, which
// pushes onto the undo stack. The consequence that matters: **a user who picks
// a design with unsaved work in the editor can put it back.**
//
// ⚠ THE PENDING SLOT EXISTS BECAUSE THE TAB MAY NOT BE MOUNTED YET, which is
// the NORMAL case — the shop is the first page, so on a first visit nothing has
// mounted `CadTab` at all. A request made then is held and claimed by the tab
// when it mounts. It holds ONE request: a second click before the tab mounts is
// the user changing their mind, and replaying both would open the first design
// and then immediately replace it.

import { markLoaded } from '../loaded';

/** A design, with everything needed to open and PARSE it. */
export interface PendingDesign {
  /** Catalogue id, for tests and for the tab's "what" label. */
  id: string;
  /** Human title, as the card showed it. */
  title: string;
  /**
   * The entry file's path INSIDE the library below — e.g.
   * `2bee_hive/2bee_hive_quilt.scad`.
   *
   * 🔴 IT IS NOT DECORATION. `parseScad` resolves every `use`/`include` RELATIVE
   * TO THE IMPORTING FILE, so a design opened with the wrong `path` resolves
   * `../lib/langstroth_box.scad` against the wrong directory and refuses imports
   * that are present. It becomes `CadTab`'s `selfPath`.
   */
  path: string;
  /** The entry file's source — what lands in the editor. */
  source: string;
  /**
   * The entry file AND its whole import closure, keyed by normalised path.
   *
   * ⚠ THE CLOSURE TRAVELS WITH THE DESIGN because a production build has no
   * library at all: the `/__cad-library` route that fills one is DEV-ONLY. A
   * handoff carrying only the entry source would open a model whose every
   * import refuses — in the built app, and nowhere else, which is the worst
   * place for a difference to live.
   */
  files: Record<string, string>;
}

/**
 * Which tab a design is being opened in. Founder 2026-10-15: *"in the design
 * able to open every item in cad , cnc or 3d"*.
 *
 * ⚠ ONE SLOT PER TARGET, not one shared slot: "open in cnc" and "open in cad"
 * are two different requests for two different tabs, and a cnc click must not
 * be claimed by the cad tab (it would replace the editor's text — the exact
 * loss this file exists to prevent — for a click that never asked for it).
 */
export type HandoffTarget = 'cad' | 'cnc' | '3d';
export const HANDOFF_TARGETS: readonly HandoffTarget[] = ['cad', 'cnc', '3d'];
/** Every tab the design page can send the user to. `pnp` carries a board id
 *  through `pnp/pnpHandoff.ts`, not through this file. */
export type OpenTarget = HandoffTarget | 'pnp' | 'pcb';

/**
 * What the CNC tab receives on top of the design: the name under which the
 * design's mesh was saved into the DRAWINGS list (`shop/toCnc.ts`), and the
 * sentence that says it will be cut as ONE SECTION at one Z.
 */
export interface CncHandoff {
  /** The `drawings` collection key. Load it as row `drawingRowId('saved', name)`. */
  drawingName: string;
  /** Always says *section* and the Z — see `cad/record.ts` header. Show it. */
  note: string;
  /**
   * 🔴 The workpiece the part is planned on, from `make/autoPlan.ts`
   * `workpieceFor` — the SAME function the Make step plans with — applied to
   * the saved record's own STL (`toCnc.ts` `workpieceOfRecord`). The cnc tab
   * sets its thickness from `t` on arrival (`takeHandoffWorkpiece`); without
   * it the tab planned on whatever thickness it remembered (default 18 mm)
   * while the Make step said 14 mm for the same Hive cleat.
   *
   * ABSENT only for a plain saved drawing (DXF/SVG) with no thickness of its
   * own: the operator's stock thickness stands, and the note says so. The
   * design hand-off (`cncHandoffFor`) REFUSES rather than omit it.
   */
  workpiece?: { x: number; y: number; t: number };
}

/**
 * What the CNC tab claims. NOT a `PendingDesign`: the CNC tab cuts the saved
 * DRAWING, never source text, and a user's own saved drawing (a DXF, say) has
 * no source at all.
 */
export interface PendingCnc {
  id: string;
  title: string;
  cnc: CncHandoff;
}

/**
 * What the 3d tab claims: the design PLUS a binary STL of its solids, because the
 * 3d tab slices STL files (OrcaSlicer, through its bridge) and has no SCAD reader.
 * The STL is the one `cad/record.ts` writes — the same refusals (no solid, a solid
 * whose audit is not `closed`) stop it before it is handed over.
 */
export interface Pending3d extends PendingDesign {
  stl: { name: string; bytes: Uint8Array; note: string };
}

export type PendingFor<T extends HandoffTarget> = T extends 'cnc' ? PendingCnc : T extends '3d' ? Pending3d : PendingDesign;

type Listener<T extends HandoffTarget> = (d: PendingFor<T>) => void;

const pendingBy: { [T in HandoffTarget]: PendingFor<T> | null } = { cad: null, cnc: null, '3d': null };
const listenersBy: { [T in HandoffTarget]: Set<Listener<T>> } = { cad: new Set(), cnc: new Set(), '3d': new Set() };

/** The shop asks for a design to be opened in `target`'s tab. */
export function requestOpenIn<T extends HandoffTarget>(target: T, d: PendingFor<T>): void {
  markLoaded(target === '3d' ? 'print3d' : target);
  const ls = listenersBy[target] as Set<Listener<T>>;
  if (ls.size === 0) {
    (pendingBy as Record<HandoffTarget, unknown>)[target] = d; // held until the tab mounts and claims it
    return;
  }
  (pendingBy as Record<HandoffTarget, unknown>)[target] = null;
  for (const fn of ls) fn(d);
}

/**
 * Claim a request made for `target` before anything was listening.
 *
 * 🔴 IT CLEARS THE SLOT. A "peek" would re-open the same design on every
 * remount — tabs are mounted lazily and a remount is an ordinary event, so a
 * non-destructive read would silently overwrite the tab's state again later,
 * which is exactly the class of loss the header refuses.
 */
export function claimPendingFor<T extends HandoffTarget>(target: T): PendingFor<T> | null {
  const d = pendingBy[target] as PendingFor<T> | null;
  (pendingBy as Record<HandoffTarget, unknown>)[target] = null;
  return d;
}

export function subscribeHandoffFor<T extends HandoffTarget>(target: T, fn: Listener<T>): () => void {
  const ls = listenersBy[target] as Set<Listener<T>>;
  ls.add(fn);
  return () => {
    ls.delete(fn);
  };
}

/* ── The original cad-only API, kept as the 'cad' target (CadTab uses it). ── */

/** The shop asks for a design to be opened in 2bee.cad. */
export function requestOpen(d: PendingDesign): void {
  requestOpenIn('cad', d);
}

/** Claim a cad request made before anything was listening. Clears the slot. */
export function claimPending(): PendingDesign | null {
  return claimPendingFor('cad');
}

export function subscribeHandoff(fn: (d: PendingDesign) => void): () => void {
  return subscribeHandoffFor('cad', fn);
}

/** Tests only — the module holds process-wide state. */
export function resetHandoff(): void {
  for (const t of HANDOFF_TARGETS) {
    (pendingBy as Record<HandoffTarget, unknown>)[t] = null;
    listenersBy[t].clear();
  }
}
