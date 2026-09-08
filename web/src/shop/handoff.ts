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

type Listener = (d: PendingDesign) => void;

let pending: PendingDesign | null = null;
const listeners = new Set<Listener>();

/** The shop asks for a design to be opened. */
export function requestOpen(d: PendingDesign): void {
  if (listeners.size === 0) {
    pending = d; // held until the tab mounts and claims it
    return;
  }
  pending = null;
  for (const fn of listeners) fn(d);
}

/**
 * Claim a request made before anything was listening.
 *
 * 🔴 IT CLEARS THE SLOT. A "peek" would re-open the same design on every
 * remount — the tab is mounted lazily and a remount is an ordinary event, so a
 * non-destructive read would silently overwrite the editor again later, which
 * is exactly the class of loss the header refuses.
 */
export function claimPending(): PendingDesign | null {
  const d = pending;
  pending = null;
  return d;
}

export function subscribeHandoff(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only — the module holds process-wide state. */
export function resetHandoff(): void {
  pending = null;
  listeners.clear();
}
