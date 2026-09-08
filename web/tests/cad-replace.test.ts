// The 2bee.cad document history — `web/src/cad/replace.ts`.
//
// WHAT THIS FILE EXERCISES
//
//   · 🔴 THAT EVERY BUFFER-REPLACING ACTION IS RECORDED. This is the rule the
//     two-press confirms on `New`, `Example` and `Open` were removed in favour
//     of, and since 2026-08-11 it is also the only route back from a model's
//     reply, which now lands with NO press anywhere in the chain. Its failure is
//     SILENT: a replacement that recorded nothing looks identical to one that
//     did, right up until undo is pressed and does nothing.
//   · 🔴 THAT THE CONTROLS ARE NOT OFFERED WHEN THEY WOULD DO NOTHING. The other
//     silent half: a control that looks live and reverses nothing.
//   · 🔴 THAT REDO DOES NOT SURVIVE A NEW EDIT — by a replacement OR by typing.
//     A redo offered after the operator has typed would discard their work to
//     restore a document they have moved away from: a destructive action behind
//     a control everybody expects to be safe.
//   · 🔴 THAT TYPING IS NOT IN THIS HISTORY AT ALL, because the browser's own
//     per-keystroke undo is better than anything this could build and `Ctrl+Z`
//     is deliberately left to it. A history that captured keystrokes would be a
//     worse undo replacing a good one.
//   · That the history is BOUNDED, since every entry is a full copy of the
//     buffer.
//
// ⚠ WHAT THIS FILE USED TO BE, 2026-08-11. It tested a ONE-SLOT put-back —
// `mayPutBack` / `putBack` / `putBackLabel` over a single `replaced` field. The
// founder asked for undo and redo (*"2bee.cad: Have an undo, redo option"*), so
// the slot became two bounded stacks. **Every assertion below is the old one
// generalised, not a fresh set**: the put-back was folded INTO the history
// rather than left beside it, because two undo mechanisms — one a menu item and
// one a button — is a confusion the operator pays for, and with a model's reply
// landing unpressed it is load-bearing.
//
// THE PLANTS, each watched red:
//   1. `replaceWith` returns `{ ...s, src: r.next }` — no `past` entry.
//   2. `canUndo` returns `true` unconditionally.
//   3. `typed` does not clear `future`, so redo survives a new edit.
//   4. `undo` drops the displaced text instead of pushing it to `future`.
//   5. `capped` is the identity, so the history is unbounded.
//
// ⚠ NOT EXERCISED: nothing here renders `CadTab`. What is asserted is the RULE
// the tab calls, which is why the rule is a module of pure functions rather
// than four `useState` calls inside a component this harness cannot mount.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  initialEditor,
  redo,
  redoLabel,
  replaceWith,
  stored,
  typed,
  undo,
  undoLabel,
} = await import('../src/cad/replace.ts');

const MINE = 'cube([10, 10, 10]); // the operator typed this\n';
const OTHER = 'sphere(4);\n';
const THIRD = 'cylinder(h = 3, r = 2);\n';

// ---------------------------------------------------------------------------
// Nothing to undo
// ---------------------------------------------------------------------------

/** 🔴 PLANT TARGET 2. Make `canUndo` always true and this goes red. */
test('a fresh editor has nothing to undo, and does not offer to', () => {
  const s = initialEditor(MINE);
  assert.deepEqual(s.past, []);
  assert.deepEqual(s.future, []);
  assert.equal(canUndo(s), false);
  assert.equal(canRedo(s), false);
  assert.equal(undoLabel(s), null, 'a label with no history is a live-looking dead control');
  assert.equal(redoLabel(s), null);
});

test('and pressing either anyway changes nothing, so the offer cannot be made harmless instead of removed', () => {
  const s = initialEditor(MINE);
  assert.equal(undo(s).src, MINE);
  assert.equal(redo(s).src, MINE);
  assert.deepEqual(undo(s).past, []);
  assert.deepEqual(redo(s).future, []);
});

// ---------------------------------------------------------------------------
// Every replacement is recorded
// ---------------------------------------------------------------------------

/** 🔴 PLANT TARGET 1. Drop the `past` push from `replaceWith` and this goes red. */
test('a replacement records the exact text it displaced, and says what displaced it', () => {
  const after = replaceWith(initialEditor(MINE), { next: OTHER, what: 'New' });
  assert.equal(after.src, OTHER);
  assert.equal(after.past.at(-1)?.source, MINE, 'without this the undo has nothing to go back to');
  assert.equal(after.past.at(-1)?.what, 'New');
  assert.equal(canUndo(after), true);
  assert.equal(undoLabel(after), 'Put back what New replaced');
});

/**
 * The five actions that replace the editor, named. The confirms that used to
 * guard `New`, `Example` and `Open` were removed on the strength of this, and
 * the model's reply now arrives with no press at all, so each one is asserted
 * rather than assumed to follow from the first.
 */
test('every action that replaces the editor is recorded — New, Example, Open, a library file, a reply', () => {
  for (const what of [
    'New',
    'Example',
    'opening "bracket"',
    'opening "2bee_hive/2bee_hive_brood_assembly.scad"',
    'the model proposal',
  ]) {
    const after = replaceWith(initialEditor(MINE), { next: OTHER, what });
    assert.equal(after.past.at(-1)?.source, MINE, `${what} replaced the editor and recorded nothing`);
    assert.equal(undo(after).src, MINE, `${what} cannot be undone`);
  }
});

test('undo restores the operator’s own text exactly', () => {
  const after = replaceWith(initialEditor(MINE), { next: OTHER, what: 'Example' });
  assert.equal(undo(after).src, MINE);
});

test('a replacement with identical text records nothing — there is nothing to reverse', () => {
  const after = replaceWith(initialEditor(MINE), { next: MINE, what: 'Example' });
  assert.deepEqual(after.past, []);
  assert.equal(canUndo(after), false);
});

// ---------------------------------------------------------------------------
// More than one step — the thing the one-slot put-back could not do
// ---------------------------------------------------------------------------

/**
 * 🔴 THE WHOLE POINT OF THE CHANGE. The old mechanism held ONE string: a second
 * replacement overwrote the first, so `New` then `Example` left the operator's
 * own source unreachable. That was defensible while it was called a put-back for
 * one action; it is not an undo, and the founder asked for one.
 */
test('two replacements are two steps back, in order', () => {
  let s = initialEditor(MINE);
  s = replaceWith(s, { next: OTHER, what: 'New' });
  s = replaceWith(s, { next: THIRD, what: 'Example' });

  assert.equal(undoLabel(s), 'Put back what Example replaced');
  s = undo(s);
  assert.equal(s.src, OTHER);
  assert.equal(undoLabel(s), 'Put back what New replaced');
  s = undo(s);
  assert.equal(s.src, MINE, 'the operator’s own source was unreachable');
  assert.equal(canUndo(s), false);
});

test('redo walks the same path forward, exactly', () => {
  let s = initialEditor(MINE);
  s = replaceWith(s, { next: OTHER, what: 'New' });
  s = replaceWith(s, { next: THIRD, what: 'Example' });
  s = undo(undo(s));

  assert.equal(canRedo(s), true);
  assert.equal(redoLabel(s), 'Redo New');
  s = redo(s);
  assert.equal(s.src, OTHER);
  s = redo(s);
  assert.equal(s.src, THIRD);
  assert.equal(canRedo(s), false);
});

/**
 * 🔴 PLANT TARGET 4. `undo` must push what it displaces onto `future`, INCLUDING
 * anything typed since. That is what makes the pair non-destructive: pressing
 * undo can never lose work, because the work becomes the next redo.
 */
test('undo never loses work — what it displaces becomes the redo', () => {
  let s = replaceWith(initialEditor(MINE), { next: OTHER, what: 'the model proposal' });
  s = undo(s);
  assert.equal(s.src, MINE);
  assert.equal(s.future.at(-1)?.source, OTHER, 'the reply is gone and cannot be got back');
  assert.equal(redo(s).src, OTHER);
});

// ---------------------------------------------------------------------------
// Redo must not survive a new edit
// ---------------------------------------------------------------------------

/**
 * 🔴 PLANT TARGET 3, AND THE MOST DANGEROUS RULE IN THIS FILE. After an undo,
 * `future` holds the document the undo stepped back FROM. If the operator then
 * edits, that document is no longer in the lineage of what they are working on —
 * and a `Redo` offered from there would throw away their new work to restore an
 * abandoned state. A destructive action behind a control everyone expects to be
 * safe.
 *
 * ⚠ ASSERTED FOR BOTH KINDS OF EDIT. Typing is the subtle one, because typing is
 * NOT otherwise in this history at all — it is easy to write a `typed` that
 * correctly records nothing and incorrectly leaves the redo standing.
 */
test('typing clears the redo, even though typing is not recorded', () => {
  let s = replaceWith(initialEditor(MINE), { next: OTHER, what: 'Example' });
  s = undo(s);
  assert.equal(canRedo(s), true, 'the fixture is vacuous without something to lose');

  const after = typed(s, `${MINE}// and then I typed\n`);
  assert.equal(canRedo(after), false, 'Redo would now discard what was just typed');
  assert.deepEqual(after.past, s.past, 'typing must not add a history step either');
});

test('a new replacement clears the redo too', () => {
  let s = replaceWith(initialEditor(MINE), { next: OTHER, what: 'Example' });
  s = undo(s);
  s = replaceWith(s, { next: THIRD, what: 'New' });
  assert.equal(canRedo(s), false);
  assert.equal(undo(s).src, MINE, 'and the new branch is still undoable');
});

test('typing the same text is not an edit and changes nothing', () => {
  let s = replaceWith(initialEditor(MINE), { next: OTHER, what: 'Example' });
  s = undo(s);
  assert.equal(typed(s, MINE), s, 'a no-op keystroke path must not clear the redo');
});

// ---------------------------------------------------------------------------
// Typing, and what this history deliberately is not
// ---------------------------------------------------------------------------

/**
 * 🔴 TYPING IS NOT A STEP. The browser owns per-keystroke undo with a
 * granularity nothing here can match — it groups by word, by pause and by
 * operation, from state it does not expose. `Ctrl+Z` is left to it, and a
 * history that recorded keystrokes would be a worse undo replacing a good one.
 */
test('typing never adds a step, so this cannot be mistaken for an undo for typing', () => {
  let s = initialEditor(MINE);
  for (const text of ['c', 'cu', 'cub', 'cube', 'cube(']) s = typed(s, text);
  assert.deepEqual(s.past, []);
  assert.equal(canUndo(s), false);
  assert.equal(s.src, 'cube(');
});

test('typing after a replacement does not disturb the history', () => {
  const after = replaceWith(initialEditor(MINE), { next: OTHER, what: 'New' });
  const later = typed(after, `${OTHER}// then some typing\n`);
  assert.equal(later.past.at(-1)?.source, MINE, 'typing moved the history');
  assert.equal(undo(later).src, MINE);
  assert.equal(
    undo(later).future.at(-1)?.source,
    `${OTHER}// then some typing\n`,
    'the typing done since is what the redo restores',
  );
});

/**
 * ⚠ THE LABELS NAME THE ACTION, NEVER JUST "Undo". A bare *"Undo"* is read as an
 * undo for typing by everybody who has ever used an editor, and this one is not.
 */
test('both labels name the action they reverse', () => {
  const after = replaceWith(initialEditor(MINE), { next: OTHER, what: 'opening "bracket"' });
  assert.equal(undoLabel(after), 'Put back what opening "bracket" replaced');
  assert.equal(redoLabel(undo(after)), 'Redo opening "bracket"');
});

// ---------------------------------------------------------------------------
// Bounded
// ---------------------------------------------------------------------------

/**
 * 🔴 PLANT TARGET 5. Every entry is a FULL COPY of the buffer, and the largest
 * `.scad` in `hardware/cad/` is 338 KB — so an unbounded history is a real
 * memory leak, not a theoretical one.
 *
 * ⚠ THE OLDEST IS DROPPED, NOT THE NEWEST REFUSED. A history that silently
 * stopped recording after twenty steps would make the twenty-first undo restore
 * the wrong document, which is worse than not being able to reach the first.
 */
test('the history is bounded, and drops the OLDEST step', () => {
  let s = initialEditor('v0');
  for (let i = 1; i <= HISTORY_LIMIT + 5; i++) s = replaceWith(s, { next: `v${i}`, what: `step ${i}` });

  assert.equal(s.past.length, HISTORY_LIMIT);
  assert.equal(s.past[0].source, `v${5}`, 'the wrong end of the history was dropped');
  assert.equal(s.past.at(-1)?.source, `v${HISTORY_LIMIT + 4}`);

  // Undoing all the way back stops at the oldest kept state, not at v0.
  while (canUndo(s)) s = undo(s);
  assert.equal(s.src, 'v5');
});

test('the redo stack is bounded by the same limit', () => {
  let s = initialEditor('v0');
  for (let i = 1; i <= HISTORY_LIMIT + 5; i++) s = replaceWith(s, { next: `v${i}`, what: `step ${i}` });
  while (canUndo(s)) s = undo(s);
  assert.ok(s.future.length <= HISTORY_LIMIT);
});

// ---------------------------------------------------------------------------
// The baseline is not part of the history
// ---------------------------------------------------------------------------

test('undoing an opened model leaves the editor dirty again, which is the truth', () => {
  const opened = replaceWith(initialEditor(MINE), {
    next: OTHER,
    what: 'opening "bracket"',
    isStored: true,
  });
  const back = undo(opened);
  assert.equal(back.src, MINE);
  assert.notEqual(back.src, back.baseline, 'the text put back is not the text on disk');
});

test('a save moves the baseline and leaves the editor and the history alone', () => {
  const after = replaceWith(initialEditor(MINE), { next: OTHER, what: 'New' });
  const s = stored(after, OTHER);
  assert.equal(s.src, OTHER);
  assert.equal(s.baseline, OTHER);
  assert.equal(s.past.at(-1)?.source, MINE, 'saving is not a reason to lose the history');
  assert.deepEqual(s.future, after.future);
});

/* ════════════════════════════════════════════════════════════════════════════
   🔴 THE AUTO-APPLIED PATH — where the put-back stopped being a convenience
   ════════════════════════════════════════════════════════════════════════════

   Founder 2026-08-11: *"when request sent automatically change the code (no
   extra click needed)"*. Until then a model's reply reached the editor only
   after a press, and the put-back was a recovery from a mis-click. Now the
   editor is overwritten by a network reply with NO press at all, and this
   control is **the only route back**. So it is exercised through the real chain
   — `askReducer` → `applicationOf` → `replaceWith` — rather than by calling
   `replaceWith` with a string this file made up. A test that skips the reducer
   would still pass if the reducer stopped handing the text over.
   ════════════════════════════════════════════════════════════════════════════ */

const { askReducer, applicationOf, reviewProposal, evaluate, INITIAL_ASK_STATE } = await import(
  '../src/cad/ask.tsx'
);

/** Drive the real path: a reply arrives, applies itself, lands in the editor. */
function autoApplied(mine: string, reply: string) {
  const review = reviewProposal(evaluate(mine), reply);
  const next = askReducer(INITIAL_ASK_STATE, { t: 'reply', source: reply, raw: reply, review });
  const app = applicationOf(next);
  return { review, state: next, app };
}

test('a reply that applied itself is undoable, exactly, through the real chain', () => {
  const mine = 'cube([20, 10, 5]);\n';
  const reply = 'cube([40, 10, 5]);\n';
  const { app } = autoApplied(mine, reply);
  assert.ok(app, 'the reply did not apply itself — this test is measuring the wrong thing');

  const editor = replaceWith(initialEditor(mine), { next: app!.next, what: 'the model proposal' });
  assert.equal(editor.src, reply, 'the reply is not in the editor');
  assert.ok(canUndo(editor), 'an overwrite nobody clicked left nothing to undo');

  const back = undo(editor);
  assert.equal(back.src, mine, 'the operator’s own source did not come back, character for character');
});

/**
 * ⚠ AND IT IS STILL A TOGGLE ON THIS PATH. Pressing the put-back after an
 * automatic overwrite must not destroy the reply — the operator may want to
 * compare, and this is the one control they have.
 */
test('undoing an auto-applied reply keeps the reply as the redo, so the press is never destructive', () => {
  const mine = 'cube([20, 10, 5]);\n';
  const reply = 'cube([40, 10, 5]);\n';
  const { app } = autoApplied(mine, reply);
  const back = undo(replaceWith(initialEditor(mine), { next: app!.next, what: 'the model proposal' }));
  assert.equal(back.future.at(-1)?.source, reply, 'the reply is gone and cannot be got back');
  assert.equal(redo(back).src, reply);
});

/**
 * 🔴 AND AN AUTO-APPLIED REPLY LEAVES THE EDITOR **DIRTY**, which is what it is:
 * text nobody has stored anywhere. Calling it saved would let the next open
 * discard a model's work without a word — and with no press in the chain, the
 * operator may not even know it arrived.
 */
test('an auto-applied reply is unsaved work, and the tab’s dirty marker says so', () => {
  const mine = 'cube([20, 10, 5]);\n';
  const { app } = autoApplied(mine, 'cube([40, 10, 5]);\n');
  const editor = replaceWith(initialEditor(mine), { next: app!.next, what: 'the model proposal' });
  assert.notEqual(editor.src, editor.baseline);
  assert.equal(editor.baseline, mine, 'the baseline moved — the tab would call this saved');
});

/** A blocked reply hands back nothing, so there is nothing to stash or restore. */
test('a blocked reply never reaches this mechanism at all', () => {
  const { app, state } = autoApplied('cube([20, 10, 5]);\n', 'this is prose, not scad');
  assert.equal(app, null);
  assert.equal(state.phase, 'proposed');
});
