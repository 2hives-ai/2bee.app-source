// The spoilboard as a SLAB, and the two things you can now hover — TODO #71/#74.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// `npm run test:node`. No browser, no WebGL, no bundler, no wasm.
//
// 🔴 NOBODY HAS SEEN ANY OF THIS DRAWN. There is no WebGL and no browser on the
// machine this was written on, so *"the board looks like a slab"* is not a claim
// this file makes or could make. What it asserts instead is STRUCTURAL, and it
// is chosen so that the three states cannot collapse into each other silently:
//
//   ✅ the GEOMETRY the scene builder is given — which of the three board states
//      `boardSlab` returns, the two Z faces it puts them at, and the fact that
//      an unknown thickness yields NO underside to build a box from;
//   ✅ the STRINGS the hover panel would render, taken from the same three pure
//      functions the panel calls — `boardSlab`, `readBoardDepth`/`boardDepthText`
//      and `bareReachText`;
//   ✅ the TONE each of those rows carries, which is what decides whether a
//      PENDING answer is painted like a clear one.
//
//   🔴 NOT EXERCISED, stated rather than implied:
//     · Any three.js object. That a `BoxGeometry` is built for `'slab'` and a
//       `PlaneGeometry` for `'unknown-thickness'` is asserted by READING the one
//       branch that decides it, not by running it — the branch lives inside a
//       `useEffect` that needs a canvas.
//     · `describe()` — the hover branch itself is closed over the scene effect
//       and is not exported. Every string and every tone it puts in a row comes
//       from the functions below, and those are exercised; the assembly is not.
//     · The palette. That `--bad`/`--muted` reach the board's material is a
//       three.js call in the same effect.
//     · The core. The Z arithmetic below is the core's, and the expected numbers
//       are typed out from `core/src/types.rs`'s own tests (`top_face_z_mm(18)
//       == -18`, `underside_z_mm(18) == Some(-36)`, and the 12mm pair) rather
//       than imported — a test that re-derived them from the same expression
//       would assert only that the module agrees with itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const vp = await import('../src/Viewport.tsx');
const { boardSlab, readBoardDepth, boardDepthText, bareReachText, layerTitle } = vp;

/** A declared rectangle. The thickness is the variable under test. */
const rect = (thickness_mm?: number | null) => ({
  name: 'MDF 1200 x 600',
  x_mm: 40,
  y_mm: 25,
  size_x_mm: 1200,
  size_y_mm: 600,
  ...(thickness_mm === undefined ? {} : { thickness_mm }),
});

/* ═══ Where the board sits in Z ═════════════════════════════════════════════ */

test('a declared thickness makes a slab, at the core\'s two faces', () => {
  // `core/src/types.rs::the_thickness_travels_with_the_board_and_is_never_invented`
  const s = boardSlab(rect(18), 18);
  assert.equal(s.state, 'slab');
  assert.equal(s.topZMm, -18);
  assert.equal(s.undersideZMm, -36);
  assert.equal(s.thicknessMm, 18);
  assert.equal(s.why, '');

  // The same board under a THINNER workpiece. The top face follows the
  // workpiece, not the board — the workpiece rests on the board — so both
  // faces move together.
  const t = boardSlab(rect(18), 12);
  assert.equal(t.topZMm, -12);
  assert.equal(t.undersideZMm, -30);
});

test('🔴 PLANT — an unknown thickness must NEVER be drawn as a slab', () => {
  // Absent, and the four ways a present value can fail to be a slab. Every one
  // of them keeps the flat plane and refuses an underside. If any of these ever
  // returns `'slab'`, the picture has invented a depth nobody measured — which
  // is the defect this whole item exists to prevent.
  for (const bad of [undefined, null, 0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const s = boardSlab(rect(bad as number | null | undefined), 18);
    assert.equal(s.state, 'unknown-thickness', `thickness ${String(bad)} produced ${s.state}`);
    assert.equal(s.undersideZMm, null, `thickness ${String(bad)} invented an underside`);
    assert.equal(s.thicknessMm, null, `thickness ${String(bad)} reached the picture as a number`);
    // The top face is still known: the workpiece still rests on the board, and
    // that is the fact the plane is drawn from.
    assert.equal(s.topZMm, -18);
  }
});

test('absent and present-but-unusable are DIFFERENT reasons, not one', () => {
  // The core keeps these apart (`thickness_faults` vs an absent `Option`) and so
  // does the sentence: "nobody said" and "somebody typed a thickness and it is
  // not one" are different facts about the setup, and only the first is a
  // question the operator has not been asked yet.
  const absent = boardSlab(rect(undefined), 18);
  const typed = boardSlab(rect(0), 18);
  assert.notEqual(absent.why, typed.why);
  assert.match(absent.why, /UNKNOWN/);
  // 🔴 The reading the field exists to refuse, refused in terms.
  assert.match(absent.why, /NOT read as "thick enough"/);
  assert.match(typed.why, /is not a slab/);
  assert.match(typed.why, /NOT read as "unknown"/);
});

test('nothing is drawn for an absent board, a bad rectangle, or a workpiece with no thickness', () => {
  for (const [why, s] of [
    ['no board', boardSlab(null, 18)],
    ['undefined board', boardSlab(undefined, 18)],
    ['no size', boardSlab({ x_mm: 0, y_mm: 0, size_x_mm: 0, size_y_mm: 600 }, 18)],
    ['NaN corner', boardSlab({ x_mm: Number.NaN, y_mm: 0, size_x_mm: 1200, size_y_mm: 600 }, 18)],
    // A non-finite workpiece thickness gives the stack no height. The core
    // refuses an underside for exactly this input; drawing it would put a board
    // at the world origin, which is a rectangle in a place nobody declared.
    ['no workpiece thickness', boardSlab(rect(18), Number.NaN)],
  ] as [string, ReturnType<typeof boardSlab>][]) {
    assert.equal(s.state, 'none', why);
    assert.equal(s.topZMm, null, why);
    assert.equal(s.undersideZMm, null, why);
    assert.notEqual(s.why, '', `${why} gave no reason`);
  }
});

/* ═══ The depth limb's verdict ══════════════════════════════════════════════ */

test('🔴 PLANT — the verdict is READ, never derived from the count', () => {
  // The mutation: `through_board > 0 ? 'through-board' : 'inside-board'`. It
  // renders PENDING as the safe answer, and it is one of the three the core's
  // own tests plant. Both directions are checked, because the derivation is
  // wrong in both.
  const pendingWithCells = readBoardDepth({ board_depth: 'board-depth-unknown', through_board: 7 });
  assert.equal(pendingWithCells.verdict, 'board-depth-unknown');
  assert.equal(pendingWithCells.ran, false);

  const clearWithNone = readBoardDepth({ board_depth: 'inside-board', through_board: 0 });
  assert.equal(clearWithNone.verdict, 'inside-board');
  assert.equal(clearWithNone.ran, true);
});

test('🔴 PLANT — `through_board: 0` with an unknown verdict must not render as clean', () => {
  const pending = boardDepthText(readBoardDepth({ board_depth: 'board-depth-unknown', through_board: 0 }));
  const measuredClear = boardDepthText(readBoardDepth({ board_depth: 'inside-board', through_board: 0 }));

  // Same integer, and they must not be the same row.
  assert.equal(pending.tone, 'pending');
  assert.notEqual(measuredClear.tone, 'pending');
  assert.notEqual(pending.text, measuredClear.text);
  assert.match(pending.text, /PENDING/);
  // 🔴 The count is deliberately absent from the PENDING sentence. A `0` beside
  // a word nobody reads carefully is the pair that reads as a measurement.
  assert.doesNotMatch(pending.text, /\b0\b/);
});

test('a verdict that did not arrive, or that this file does not recognise, is PENDING', () => {
  for (const c of [
    undefined,
    null,
    {},
    { through_board: 0 },
    { board_depth: null },
    // 🔴 The core's own warning: a three-way match must not fall through its
    // arms into whatever the `_` case says, "which on every UI written so far
    // is the harmless one".
    { board_depth: 'inside_board' },
    { board_depth: 'ok' },
    { board_depth: '' },
  ]) {
    const d = readBoardDepth(c as never);
    assert.equal(d.verdict, 'board-depth-unknown', JSON.stringify(c));
    assert.equal(d.ran, false, JSON.stringify(c));
    assert.notEqual(d.reason, null, `${JSON.stringify(c)} gave no reason`);
    assert.equal(boardDepthText(d).tone, 'pending', JSON.stringify(c));
  }
});

test('a through-board verdict is BAD, and it carries the count it was given', () => {
  const d = readBoardDepth({ board_depth: 'through-board', through_board: 4995 });
  assert.equal(d.verdict, 'through-board');
  assert.equal(d.throughCells, 4995);
  assert.equal(d.ran, true);
  const t = boardDepthText(d);
  assert.equal(t.tone, 'bad');
  assert.match(t.text, /4995/);
  assert.match(t.text, /into whatever the machine is built of/);
});

test('a count that never arrived is "not reported", not zero', () => {
  const d = readBoardDepth({ board_depth: 'inside-board' });
  assert.equal(d.throughCells, null);
  assert.match(boardDepthText(d).text, /not reported/);
});

test('the core\'s pending REASON is passed through, not reworded', () => {
  const why = 'no thickness is declared for spoilboard ‘MDF’, so there is no underside to compare against';
  const d = readBoardDepth({ board_depth: 'board-depth-unknown', board_depth_pending_reason: why });
  assert.equal(d.reason, why);
});

/* ═══ The uncovered reach — the number an operator most wants ═══════════════ */

test('🔴 PLANT — `null` and `[0,0,0,0]` are DIFFERENT facts and only one is safe', () => {
  const noBoard = bareReachText(null);
  const coversEverything = bareReachText([0, 0, 0, 0]);
  assert.notEqual(noBoard.text, coversEverything.text);
  assert.notEqual(noBoard.tone, coversEverything.tone);
  // Nobody asked ⇒ PENDING. A board that covers the whole reach ⇒ a measured
  // answer, and the only case in which "inside the travel" and "over the
  // spoilboard" are the same question.
  assert.equal(noBoard.tone, 'pending');
  assert.match(noBoard.text, /not reported/);
  assert.equal(coversEverything.tone, undefined);
  assert.match(coversEverything.text, /covers the whole reach/);
});

test('the strips are named and sided, in the core\'s own wording', () => {
  // `core/src/types.rs::BareReach::describe` — "{mm:.1}mm on {side}", joined
  // with ", ". Mirrored rather than reinvented so two surfaces do not describe
  // one subtraction two ways.
  const r = bareReachText([12, 0, 0, 30]);
  assert.equal(r.text, '12.0mm on X-, 30.0mm on Y+');
  assert.equal(r.tone, 'warn');

  assert.equal(bareReachText([1.25, 2, 3, 4]).text, '1.3mm on X-, 2.0mm on X+, 3.0mm on Y-, 4.0mm on Y+');
});

test('four numbers that are not numbers report PENDING, never a strip of NaN', () => {
  const r = bareReachText([Number.NaN, 0, 0, 0] as [number, number, number, number]);
  assert.equal(r.tone, 'pending');
  assert.doesNotMatch(r.text, /NaN/);
});

/* ═══ The layer's own sentence ══════════════════════════════════════════════ */

const layerScene = (spoilboard: unknown) =>
  ({
    clamps: [],
    moves: [],
    travel: [1250, 670] as [number, number],
    stock: [600, 900, 18] as [number, number, number],
    spoilboard,
  }) as never;

test('the spoilboard layer says which of the three states it is drawing', () => {
  const known = layerTitle('spoilboard', layerScene(rect(18)), true);
  const unknown = layerTitle('spoilboard', layerScene(rect(null)), true);
  const none = layerTitle('spoilboard', layerScene(null), true);

  assert.match(known, /SLAB 18\.0mm thick/);
  assert.match(unknown, /THICKNESS IS UNKNOWN/);
  assert.match(unknown, /dashed edge/);
  // 🔴 The two must not read alike, and the one with no board must not claim
  // either.
  assert.notEqual(known, unknown);
  assert.doesNotMatch(none, /SLAB/);
  assert.doesNotMatch(none, /THICKNESS IS UNKNOWN/);
  // The sentence that survives all three: hiding the picture does not switch
  // off the check.
  for (const s of [known, unknown, none]) assert.match(s, /the position check still runs/);
});
