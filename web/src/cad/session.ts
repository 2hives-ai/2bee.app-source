// 2bee.cad — what a browser refresh puts back.
//
// Founder 2026-08-11: *"when I refresh the browser the 2bee.cad should come back
// what has been changed (zoom, FOV, edited code)"*.
//
// 🔴 IT IS ITS OWN MODULE FOR THE REASON `replace.ts` IS: every rule here is a
// pure function over one string, so every rule can be watched going red without
// a browser, a renderer or a React tree. The failures this guards are all SILENT
// ones — a restore that quietly hands back the wrong text, a write that quietly
// does nothing, a dirty buffer that quietly looks saved — and a silent failure
// asserted only through a component is a failure nobody can arm a plant for.
//
// ⚠ WHAT THIS IS NOT: a save. It holds ONE buffer, ONE put-back step and a
// camera, in `localStorage`, in one browser. It is not a record in the drawings
// list, it is not something the CNC tab can cut, and it does not leave the
// machine. `CadTab.tsx`'s leave guard stays exactly where it was, and its note
// says what it now means.

import { readCamera, type CadCamera } from './preview';
import type { Snapshot } from './replace';

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT ALREADY SURVIVED, AND WHAT DID NOT
   ═══════════════════════════════════════════════════════════════════════════

   🔴 MEASURED BEFORE ANYTHING WAS BUILT, because the founder named three things
   and may have been missing one of them:

     ✅ the pane geometry — the editor/3D split, the dock height, which bottom
        tab is showing ({@link LAYOUT_KEY}, since the dock was built);
     ✅ the two ruler toggles, axes and scale markers (same blob);
     ✅ the PROJECTION, perspective or orthographic — added by `540bab9d66`, in
        that same blob, beside the toggles, exactly where OpenSCAD keeps it;
     ✅ the Ask endpoint and model id (`readAskConfig`, its own key; the API key
        only if `rememberKey` is on);
     ✅ every SAVED model — those are records in IndexedDB and always were.

     🔴 THE EDITOR'S TEXT — no. A refresh installed `EXAMPLE`.
     🔴 THE DOCUMENT HISTORY — no, and this is the one that loses work. See below.
     🔴 THE CAMERA — no. Orbit, pan and zoom were reconstructed by an automatic
        `Fit` on the first mesh.

   ⇒ **Two of his three were already there and he was reporting the third.**
   "FOV" is the zoom: there is ONE scalar (the orbit distance) and the
   orthographic half-height is derived from it — `540bab9d66`, read at OpenSCAD's
   source. What is stored is that scalar, never a projection-specific extent.

   🔴 THE ENTRY THAT MATTERS MOST IS THE PUT-BACK, and it is not obvious. A
   model's reply now replaces the editor with NO press anywhere in the chain
   (founder: *"when request sent automatically change the code (no extra click
   needed)"*), and `replace.ts` is the only route back from that. Restoring the
   buffer without it would mean an auto-applied rewrite became PERMANENT at the
   next refresh — the original source gone, with the tab looking like it had
   simply always said this. So the put-back is stored even though the rest of the
   history is not.

   ⚠ ONE ENTRY, NOT TWENTY, AND THE REASON IS ARITHMETIC. Every entry is a full
   copy of the buffer; `replace.ts` measures the largest `.scad` in
   `hardware/cad/` at 338 KB and caps each stack at 20, i.e. ~7 MB worst case per
   stack. `localStorage` is ~5 MB per ORIGIN, shared with the layout blob, the
   Ask config and the CNC tab's own keys. Storing the whole history is therefore a
   quota failure waiting for a big file — and a quota failure is not a smaller
   restore, it is NO restore, because the write is all-or-nothing. One entry is
   the one that is load-bearing.

   ⚠ AND `future` IS NOT STORED AT ALL. Typing clears redo anyway
   (`replace.ts`'s `typed`), so a redo restored across a refresh would be offered
   from a state the operator has since edited — the destructive-control case that
   module already refuses. */
export const SESSION_KEY = '2bee.app.cad.session';

/**
 * 🔴 THIS IS NOT `store.ts`'s `SESSION_VERSION` AND IT DOES NOT MOVE IT.
 *
 * That constant guards the MACHINING session blob — the plan, the tools, the
 * workholding — and exists to protect meanings a plan depends on. Nothing about
 * that blob changes here; this is a new key with its own reader, its own
 * validator and its own number. A build that predates this key simply never
 * looks for it, and a build that postdates a meaning change must refuse the old
 * shape, which is what this field is for.
 *
 * ⚠ THE RULE FOR MOVING IT: a new OPTIONAL field that reads as absent costs
 * nothing and does not move it. A field whose MEANING changes under an unchanged
 * name does — because then a stored blob is silently misread, which is the one
 * failure a version number can catch and a validator cannot.
 */
export const SESSION_SHAPE = 1;

/** What a refresh puts back. Everything in it is the operator's own text. */
export interface CadSession {
  v: number;
  /** The editor's text. */
  src: string;
  /** What is stored under {@link CadSession.savedName}, so `dirty` survives too. */
  baseline: string;
  savedName: string | null;
  /**
   * The top of `replace.ts`'s undo stack — what the put-back control puts back.
   * `null` if nothing has been replaced yet. See the note above for why it is
   * one entry and not twenty.
   *
   * ⚠ IT IS DELIBERATELY NOT CALLED `putBack`. That was the name of the OLD
   * one-slot stash that `replace.ts` replaced, and `tests/cad-menu.test.ts`
   * bans the identifier here to prove no second history mechanism has grown
   * back beside the real one. This is a serialised entry OF that history, not a
   * second one — so it takes a name that says so and leaves the guard armed.
   */
  undoStep: Snapshot | null;
  camera: CadCamera | null;
}

/**
 * Validate a session that came back out of the store.
 *
 * 🔴 THE DOCUMENT IS ALL-OR-NOTHING AND EVERYTHING ELSE DEGRADES, and the split
 * is not stylistic. `src` and `baseline` together ARE the document: `dirty` is
 * `src !== baseline`, so a `src` that survived while `baseline` did not would
 * make a restored dirty buffer look SAVED — the marker gone, the leave guard
 * unregistered, and the operator one `File → New` from losing work the tab had
 * just told them was safe. There is no honest half of that pair, so a bad one
 * discards both.
 *
 * ⚠ THE CAMERA, THE NAME AND THE UNDO STEP EACH FALL BACK TO `null` INSTEAD, and
 * that is the safer direction for all three:
 *   · no camera ⇒ frame the model as usual;
 *   · no name ⇒ `File → Save` asks for one instead of silently replacing a
 *     record it can no longer identify;
 *   · no undo step ⇒ one fewer recovery.
 * Discarding the whole session over any of them would throw the SOURCE away to
 * protect an accessory — and worse, the next debounced write would then overwrite
 * the still-good text in storage with the example file. Losing the view is a
 * nuisance; losing the source is the thing this exists to prevent.
 */
export function readSession(raw: string | null | undefined): CadSession | null {
  try {
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CadSession> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (v.v !== SESSION_SHAPE) return null;
    if (typeof v.src !== 'string' || typeof v.baseline !== 'string') return null;
    const p = (v.undoStep ?? null) as Partial<Snapshot> | null;
    const undoStep: Snapshot | null =
      p && typeof p.source === 'string' && typeof p.what === 'string'
        ? { source: p.source, what: p.what }
        : null;
    return {
      v: SESSION_SHAPE,
      src: v.src,
      baseline: v.baseline,
      savedName: typeof v.savedName === 'string' ? v.savedName : null,
      undoStep,
      camera: readCamera(v.camera),
    };
  } catch {
    return null;
  }
}

export function readStoredSession(): CadSession | null {
  try {
    return readSession(globalThis.localStorage?.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

/**
 * Store the session, and say whether it was stored.
 *
 * 🔴 A FAILED WRITE DELETES THE KEY, AND THAT IS THE WHOLE POINT OF THE RETURN
 * VALUE. `localStorage.setItem` throws on quota — and the blob that was already
 * there is left untouched by a throw. Without the delete, an operator whose
 * source has grown past the quota keeps a session from an hour ago and gets it
 * back on the next refresh: text that looks like their work, is not, and says
 * nothing about the difference. **No restore is recoverable; a stale restore is
 * not.** The boolean is what lets the tab say so on screen, because a
 * persistence step that can silently do nothing must announce that it did
 * something.
 */
export function writeSession(s: CadSession): boolean {
  try {
    globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(s));
    return true;
  } catch {
    try {
      globalThis.localStorage?.removeItem(SESSION_KEY);
    } catch {
      /* Storage is gone entirely. Nothing was written and nothing is stale. */
    }
    return false;
  }
}

/** Long enough that a burst of typing is one write of a possibly-large string. */
export const SESSION_SAVE_MS = 600;
