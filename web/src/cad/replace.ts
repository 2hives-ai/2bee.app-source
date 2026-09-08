// 2bee.cad — the document history: undo, redo, and the one control that puts
// back what an action replaced.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY THIS EXISTS: THE CONFIRM WAS STANDING IN FOR A RECOVERY WE DID NOT HAVE
// ═══════════════════════════════════════════════════════════════════════════
//
// `New`, `Example`, `Open` and a model's reply all replace every character in
// the editor, and this tab has no autosave and no server copy. Until 2026-08-11
// the guard against a mis-click was an inline two-press confirm on
// `New`/`Example` and a second one inside `CadOpen`.
//
// A confirm costs a press EVERY time and recovers nothing ONCE you have pressed
// through it — and a press that almost always says yes is exactly how an
// operator learns to press through the one that matters. So the interruption
// went and a one-step put-back replaced it.
//
// 🔴 AND THEN THE PRESS WENT TOO. Founder, 2026-08-11: *"when request sent
// automatically change the code (no extra click needed)"*. A model's reply now
// overwrites the editor with **no press anywhere in the chain**, which makes
// this module the only route back from a network response. That is what
// promoted it from a convenience to a control.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 IT IS A DOCUMENT HISTORY, AND IT IS DELIBERATELY NOT AN UNDO FOR TYPING
// ═══════════════════════════════════════════════════════════════════════════
//
// Founder, 2026-08-11: *"2bee.cad: Have an undo, redo option"*. There were two
// shapes available and only one of them is honest here:
//
//   (a) **BUILT — a history over BUFFER-REPLACING OPERATIONS.** `New`, `Example`,
//       `Open`, a file from the library folder, an applied proposal. Each pushes
//       one entry; {@link typed} pushes none. Exposed as `Edit → Undo` and
//       `Edit → Redo`, and as the toolbar button, which is the same mechanism
//       through a third door rather than a second mechanism.
//   (b) **NOT BUILT — one stack that also captures typing.** The editor is a
//       plain `<textarea>`, and the browser ALREADY gives it per-keystroke-group
//       undo with native granularity, a granularity nothing here can match: the
//       browser groups by word, by pause and by operation, using state it does
//       not expose. Building (b) means taking `Ctrl+Z` and replacing something
//       good with something worse. **A worse undo is not an undo.**
//
// 🔴 SO `Ctrl+Z` STAYS UNBOUND, and that is a decision this module depends on.
// Inside the focused textarea it is the browser's typing-undo, which
// `menu.tsx`'s omission list explicitly delegates. Binding it to (a) would trade
// a whole typing history for a handful of document steps AND make that
// delegation claim false. The menu items carry no accelerator for the same
// reason: an accelerator may only be printed for a key this bar actually binds.
//
// ⚠ WHAT THAT COSTS, SAID PLAINLY RATHER THAN LEFT TO BE DISCOVERED: `Edit →
// Undo` will not take back a keystroke, and `Ctrl+Z` will not take back an
// `Open`. Two recoveries, two gestures, and each one's control says which it is.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE BOUND, AND THE NUMBER
// ═══════════════════════════════════════════════════════════════════════════
//
// Every entry is a FULL COPY of the buffer. The largest `.scad` file in
// `hardware/cad/` is 338 KB (`archive/legacy/BOSL2/skin.scad`, measured
// 2026-08-11); the founder's own assemblies are 10–40 KB. At
// {@link HISTORY_LIMIT} entries that is ~7 MB worst case and a few hundred KB in
// practice, per stack, and there are two stacks. Bounded is not the same as
// small, so the limit is a named constant, the oldest entry is dropped rather
// than the newest refused, and the drop is silent — a history that stopped
// recording after twenty steps without saying so would be the worse failure, and
// telling an operator "your twenty-first undo was discarded" is noise about a
// state they have already left.
//
// Pure and exported so every rule can be watched going red. The failures this
// guards are all SILENT ones: a replacement that records nothing looks exactly
// like one that did until undo is pressed; a control offered when there is
// nothing to undo looks live and is not; and a redo that survives a new
// replacement restores a document the operator has since abandoned.

/** One buffer state, and the action that displaced it. */
export interface Snapshot {
  /** The exact text. */
  source: string;
  /**
   * What displaced it, in the words the control will use — `New`, `Example`,
   * `opening "bracket"`, `the model proposal`. It names the ACTION, so the
   * button can say what it is about to reverse rather than just "undo".
   */
  what: string;
}

/**
 * How many document states are kept, in each direction.
 *
 * See the header for the arithmetic. Twenty is chosen because the operations
 * this records are deliberate ones — a session with twenty `Open`s in it is a
 * long session — and because the memory is a multiple of the source, not of the
 * number of keystrokes.
 */
export const HISTORY_LIMIT = 20;

/** The editor's text, what is stored, and the two stacks. */
export interface EditorState {
  /** What is in the editor right now. */
  src: string;
  /**
   * The text that is on disk, so "unsaved" is a fact rather than a guess.
   * `src !== baseline` is the whole definition of dirty.
   */
  baseline: string;
  /** States an undo would return to. Oldest first; the last is the next undo. */
  past: Snapshot[];
  /**
   * States a redo would return to. Oldest first; the last is the next redo.
   *
   * 🔴 CLEARED BY ANY NEW REPLACEMENT **AND BY TYPING**. See {@link typed}.
   */
  future: Snapshot[];
}

export function initialEditor(src: string): EditorState {
  return { src, baseline: src, past: [], future: [] };
}

/** Drop the oldest entries so a stack can never grow without bound. */
function capped(stack: Snapshot[]): Snapshot[] {
  return stack.length <= HISTORY_LIMIT ? stack : stack.slice(stack.length - HISTORY_LIMIT);
}

/**
 * Typing.
 *
 * 🔴 IT RECORDS NOTHING. See the header — this history is over ACTIONS, and a
 * keystroke is not one. A per-keystroke entry would be shape (b) with a
 * twenty-character memory, which is worse than not having it.
 *
 * 🔴 BUT IT DOES CLEAR THE REDO STACK, AND THAT IS NOT AN OVERSIGHT IN THE OTHER
 * DIRECTION. After an undo, `future` holds the document the undo stepped back
 * from. If the operator then types, that document is no longer anywhere in the
 * lineage of what they are editing, and a `Redo` offered from there would throw
 * away their new work to restore an abandoned state — a destructive action
 * behind a control everybody expects to be safe. Every editor invalidates redo
 * on a new edit for exactly this reason, and typing is a new edit even though it
 * is not recorded.
 */
export function typed(s: EditorState, text: string): EditorState {
  if (s.src === text) return s;
  return { ...s, src: text, future: [] };
}

/** A save moved what is on disk. The editor text and both stacks are untouched. */
export function stored(s: EditorState, storedSource: string): EditorState {
  return s.baseline === storedSource ? s : { ...s, baseline: storedSource };
}

export interface Replacement {
  /** The text to install. */
  next: string;
  /** {@link Snapshot.what} — the action, named for the undo control. */
  what: string;
  /**
   * True ⇒ `next` is also what is stored, so the editor is NOT dirty
   * afterwards. Only an open sets this: `New`, `Example` and an applied
   * proposal leave text nobody has stored anywhere, and calling that "saved"
   * would let the next open discard it without a word.
   */
  isStored?: boolean;
}

/**
 * Replace everything in the editor, keeping what was there.
 *
 * ⚠ A replacement with IDENTICAL text records nothing — there is nothing to undo
 * to, and an entry for it would be a step that visibly does nothing when taken.
 *
 * 🔴 AND IT CLEARS `future`, which is the ordinary redo rule: a new action from
 * the middle of a history makes everything after it a branch nobody can reach.
 */
export function replaceWith(s: EditorState, r: Replacement): EditorState {
  if (r.next === s.src) return r.isStored ? stored(s, r.next) : s;
  return {
    src: r.next,
    baseline: r.isStored ? r.next : s.baseline,
    past: capped([...s.past, { source: s.src, what: r.what }]),
    future: [],
  };
}

/** Whether the undo control may be offered at all. */
export function canUndo(s: EditorState): boolean {
  return s.past.length > 0;
}

/** Whether the redo control may be offered at all. */
export function canRedo(s: EditorState): boolean {
  return s.future.length > 0;
}

/**
 * Step back one document state.
 *
 * ⚠ THE TEXT IT DISPLACES GOES ON `future`, INCLUDING ANY TYPING DONE SINCE.
 * That is what makes the pair non-destructive: pressing undo can never lose
 * work, because the work becomes the next redo — right up until a new edit
 * invalidates it, which is the one case the operator caused deliberately.
 *
 * ⚠ `what` ON THE FUTURE ENTRY NAMES THE ACTION THAT IS BEING UNDONE, not a new
 * one. Redo re-performs that action, so that is what its label should say.
 */
export function undo(s: EditorState): EditorState {
  if (s.past.length === 0) return s;
  const step = s.past[s.past.length - 1];
  return {
    ...s,
    src: step.source,
    past: s.past.slice(0, -1),
    future: capped([...s.future, { source: s.src, what: step.what }]),
  };
}

/** Step forward again. The exact inverse of {@link undo}. */
export function redo(s: EditorState): EditorState {
  if (s.future.length === 0) return s;
  const step = s.future[s.future.length - 1];
  return {
    ...s,
    src: step.source,
    future: s.future.slice(0, -1),
    past: capped([...s.past, { source: s.src, what: step.what }]),
  };
}

/**
 * The undo control's own words. One place, so the button, the menu item and a
 * test agree.
 *
 * 🔴 IT NAMES THE ACTION, NEVER JUST "Undo". This history holds document states,
 * not keystrokes, and *"Undo"* on its own is read as an undo for typing by
 * everyone who has ever used an editor. *"Put back what opening "bracket"
 * replaced"* cannot be.
 */
export function undoLabel(s: EditorState): string | null {
  const step = s.past[s.past.length - 1];
  return step ? `Put back what ${step.what} replaced` : null;
}

/** The redo control's words, same rule. */
export function redoLabel(s: EditorState): string | null {
  const step = s.future[s.future.length - 1];
  return step ? `Redo ${step.what}` : null;
}
