// The 2bee.cad axis ruler and the orbit pivot — `web/src/cad/rulers.ts` and the
// two pure functions `web/src/cad/preview.tsx` exports for exactly this reason.
//
// WHAT THIS FILE EXERCISES
//
//   · 🔴 THAT TICK SPACING IS A STEP FUNCTION OF THE ZOOM, NOT A FUNCTION OF IT.
//     This is the whole feature. OpenSCAD's own comment says why —
//     *"the tick denominations change every time the viewport gets 10x bigger or
//     smaller, but stays constant in-between"* — and it is also the only thing
//     that makes the geometry cheap enough to build in three.js at all: a ruler
//     whose spacing moved with the zoom would have to be rebuilt every frame,
//     which is a `BufferGeometry` and a `CanvasTexture` per number, per frame.
//     Asserted BOTH ways: constant across a decade, changed across a boundary.
//   · 🔴 THAT THE REBUILD KEY AGREES WITH THAT. `rulerSignature` is what the
//     render loop compares, and it is the one place where "cheap" is decided. A
//     signature that varied continuously would be a per-frame rebuild wearing a
//     cache's clothes.
//   · 🔴 THAT THE WORK IS BOUNDED WHATEVER THE MODEL. OpenSCAD needs no cap
//     because `divs = l / tick_width` is between 10 and 100 by construction. Our
//     extent is capped by `reach`, which comes from the MESH, so the invariant
//     has to be re-established rather than inherited.
//     ⚠ The first draft of this module wrote that extent as `min(zoom, reach)` —
//     the obvious reading of OpenSCAD — and the signature test above went red
//     because it makes the rebuild key CONTINUOUS on every zoomed-in view. The
//     extent is the top of the decade instead. That failure is the reason these
//     two properties are asserted separately rather than as one "it is cheap".
//   · 🔴 THAT THE PIVOT IS THE BASE, AND THAT AN EMPTY SCENE MOVES NOTHING. The
//     second is the dangerous one: this tab parses on every keystroke and a
//     refusal cascade renders the tree minus every subtree, so the bounds can go
//     empty in the middle of an edit. A framing computed from empty bounds is a
//     camera move caused by a keystroke.
//   · That the scale markers cannot be drawn while the axes are off — the `&&`
//     from `GLView.cc:198`, which is otherwise a line inside a render loop no
//     harness can reach.
//
// ⚠ NOT EXERCISED: nothing here renders. There is no browser on this box, no
// WebGL context, and nobody has seen a tick mark. What is asserted is the PLAN —
// the decision handed to the renderer, as a pure function — plus, where the
// decision is structural rather than computable, the shape of the code that
// carries it, said as such at the assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...parts: string[]) => readFileSync(join(HERE, '..', 'src', ...parts), 'utf8');

const {
  AXES,
  AXIS_DIRECTION,
  MAJOR_EVERY,
  MAX_TICKS_PER_AXIS,
  OPENSCAD_MAJOR_DIV,
  OPENSCAD_MINOR_DIV,
  TICK_DIRECTION,
  formatTick,
  rulerPlan,
  rulerSignature,
  tickDecade,
} = await import('../src/cad/rulers.ts');

const { framing, rulersDrawn } = await import('../src/cad/preview.tsx');

/* ════════════════════════════════════════════════════════════════════════════
   1. The arithmetic is OpenSCAD's
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Transcribed from `src/glview/GLView.cc:515-519` of OpenSCAD 2026.08.07:
 *
 *   const int log_l = (int) floor(log10(l));
 *   const double l_adjusted = pow(10, log_l);
 *   const double tick_width = l_adjusted / 10.0;
 *
 * Written out here rather than imported so the test computes the reference
 * independently of the thing it is testing. A test that calls the same helper it
 * is checking measures nothing.
 */
const openscadTickWidth = (l: number) => Math.pow(10, Math.floor(Math.log10(l))) / 10;

test('tick width is OpenSCAD’s decade arithmetic, over four decades of zoom', () => {
  for (const l of [1.2, 3, 9.99, 10, 25, 99.9, 100, 480, 999, 1000, 7500, 0.4, 0.05]) {
    const plan = rulerPlan(l, 1e9);
    assert.ok(plan, `no plan at zoom ${l}`);
    assert.equal(plan.tickWidth, openscadTickWidth(l), `tick width at zoom ${l}`);
    assert.equal(plan.decade, Math.floor(Math.log10(l)));
  }
});

/**
 * 🔴 `divs = l / tick_width` IS BETWEEN 10 AND 100 BY CONSTRUCTION, and this is
 * the invariant that makes OpenSCAD's loop safe without a cap. Asserted here
 * because ours borrows the safety and not the construction — see the extent
 * test below.
 */
test('the decade construction always yields between 10 and 100 divisions', () => {
  for (let e = -3; e <= 5; e++) {
    for (const m of [1, 1.7, 3, 5.5, 9.9]) {
      const l = m * Math.pow(10, e);
      const divs = l / openscadTickWidth(l);
      assert.ok(divs >= 10 && divs < 100, `divs=${divs} at l=${l}`);
    }
  }
});

/**
 * 🔴 THE STEP FUNCTION, BOTH WAYS. Constant inside a decade is the property that
 * makes the rebuild rare; changing at the boundary is the property that makes
 * the ruler readable at all. A defect in either direction passes the other test.
 */
test('spacing is CONSTANT across a decade and STEPS at the boundary', () => {
  const inside = [10, 17, 42, 88, 99.99].map((z) => rulerPlan(z, 1e9)!.tickWidth);
  assert.deepEqual(new Set(inside), new Set([1]), 'spacing moved inside one decade');

  const below = rulerPlan(9.99, 1e9)!.tickWidth;
  const above = rulerPlan(10.01, 1e9)!.tickWidth;
  assert.equal(below, 0.1);
  assert.equal(above, 1);
  assert.notEqual(below, above);
});

/**
 * 🔴 THE REBUILD KEY. This is what the render loop compares every frame, and a
 * signature that moved with the zoom would be a per-frame rebuild with a cache
 * in front of it doing nothing.
 *
 * ⚠ `reach` is held constant here on purpose: it comes from the MESH, so it
 * moves at the debounce cadence and not at the frame cadence. Its presence in
 * the key is asserted separately below.
 */
test('the rebuild signature does not move while the zoom stays inside one decade', () => {
  const keys = [100, 137, 250, 611, 999.9].map((z) => rulerSignature(z, 1e9, true));
  assert.equal(new Set(keys).size, 1, `signature moved within a decade: ${keys.join(' ')}`);
  assert.notEqual(rulerSignature(999.9, 1e9, true), rulerSignature(1000.1, 1e9, true));
});

test('the signature moves when the axis length moves, because the ticks stop there', () => {
  assert.notEqual(rulerSignature(500, 300, true), rulerSignature(500, 400, true));
});

/**
 * ⚠ OFF RETURNS A SIGNATURE RATHER THAN THE CALLER SKIPPING THE COMPARISON. A
 * caller that skipped it while off would leave the last ruler on screen — the
 * toggle would look broken rather than off, which is the harder bug to report.
 */
test('turning it off is itself a signature change, so the ruler is torn down', () => {
  assert.equal(rulerSignature(500, 1000, false), 'off');
  assert.notEqual(rulerSignature(500, 1000, false), rulerSignature(500, 1000, true));
});

/* ════════════════════════════════════════════════════════════════════════════
   2. Where the ticks stop, and how many there can be
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 TICKS NEVER RUN PAST THE END OF THE AXIS THEY ANNOTATE. OpenSCAD's axes are
 * literally infinite (`w = 0` homogeneous vertices in `showAxes()`), so it can
 * run its ticks out to `l` freely. Ours are finite — `THREE.Line` has no point
 * at infinity — so a tick past `reach` would be an instrument marking a line
 * that is not there.
 */
test('the ticks stop at the end of the axis line, not at the zoom distance', () => {
  const plan = rulerPlan(1000, 250)!;
  assert.equal(plan.extent, 250);
  assert.ok(plan.ticks.every((t) => t.at <= 250));
  assert.ok(plan.ticks[plan.ticks.length - 1].at > 250 - plan.tickWidth);
});

/**
 * 🔴 THE BOUND, RE-ESTABLISHED RATHER THAN INHERITED. `reach` comes from the
 * mesh and is not derived from the zoom, so a large model viewed from close up
 * asks for a number of ticks OpenSCAD's construction cannot produce: 75 000 mm
 * of axis at a 1 mm zoom is 750 000 ticks at 0.1 mm spacing. Clamping the extent
 * to the zoom is what puts the invariant back.
 */
test('a huge model seen from close up is still bounded, in ticks and in numbers', () => {
  const plan = rulerPlan(1, 75000)!;
  assert.ok(plan.ticks.length <= MAX_TICKS_PER_AXIS, `${plan.ticks.length} ticks`);
  assert.ok(plan.ticks.filter((t) => t.label !== null).length <= MAJOR_EVERY);
});

test('no plan at all when the first tick would already be past the end of the axis', () => {
  // 0.1 mm of visible axis, ticks 100 mm apart.
  assert.equal(rulerPlan(1000, 0.1), null);
});

test('a zoom of zero or less is NO ruler, never a decade of zero', () => {
  assert.equal(tickDecade(0), null);
  assert.equal(tickDecade(-5), null);
  assert.equal(tickDecade(Number.NaN), null);
  assert.equal(tickDecade(Number.POSITIVE_INFINITY), null);
  assert.equal(rulerPlan(0, 100), null);
  assert.equal(rulerPlan(100, 0), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. Which ticks are major, and what their numbers say
   ════════════════════════════════════════════════════════════════════════════ */

test('every tenth tick is major, carries a number, and no other tick does', () => {
  const plan = rulerPlan(100, 1e9)!;
  for (const [i, t] of plan.ticks.entries()) {
    const n = i + 1; // ticks start at n = 1
    assert.equal(t.major, n % MAJOR_EVERY === 0, `tick ${n}`);
    assert.equal(t.label === null, !t.major, `label on tick ${n}`);
  }
  /* Ten, not nine: the extent is the TOP of the decade (a hundred ticks), so
   * the last major sits exactly on it. OpenSCAD's own `divs` stops one short of
   * that because it runs to the live `l`; see the extent note in `rulers.ts`. */
  assert.equal(plan.ticks.filter((t) => t.major).length, MAJOR_EVERY);
});

/**
 * 🔴 THE NUMBER IS FORMATTED FROM THE DECADE, NOT FROM THE ACCUMULATED PRODUCT.
 * `tickWidth` is `10^decade / 10`, which is not representable in binary for any
 * negative decade — `30 * 0.01` is `0.30000000000000004` — and the ruler would
 * print exactly that beside a tick. This is the one defect in this module a
 * screenshot would catch and no other test would.
 */
test('printed numbers carry no floating-point residue at any decade', () => {
  /* 0.03, not 0.30 — the FIRST draft of this test asserted the latter and was
   * wrong about the module it was checking: a major tick's value is
   * `(n / 10) * 10^decade`, so `n = 30` at decade −2 is three hundredths. Left
   * as a comment because an expected value nobody can re-derive is the kind that
   * gets "fixed" to match whatever the code happens to print. */
  assert.equal(formatTick(30, -2), '0.03');
  assert.equal(formatTick(70, -1), '0.7');
  assert.equal(formatTick(10, 0), '1');
  assert.equal(formatTick(90, 3), '9000');
  for (const decade of [-3, -2, -1, 0, 1, 2, 3]) {
    for (let n = MAJOR_EVERY; n < 100; n += MAJOR_EVERY) {
      assert.ok(!/\d{6,}/.test(formatTick(n, decade)), `${formatTick(n, decade)} at decade ${decade}`);
    }
  }
});

test('a major tick’s number equals its position, to the decade’s precision', () => {
  const plan = rulerPlan(100, 1e9)!;
  for (const t of plan.ticks) {
    if (t.label === null) continue;
    assert.ok(Math.abs(Number(t.label) - t.at) < plan.tickWidth * 1e-6, `${t.label} vs ${t.at}`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   4. Tick geometry stays inside the band OpenSCAD's own arms occupy
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE ONE DELIBERATE DIVERGENCE, BOUNDED RATHER THAN ASSERTED AWAY. OpenSCAD
 * sizes its arms from the LIVE zoom — `l/60` minor, `l/30` major — which is a
 * per-frame quantity, and per-frame geometry is exactly what this module exists
 * not to build. Ours are constant multiples of the SPACING, so what has to be
 * shown is that they never leave the range OpenSCAD's own arms sweep out within
 * a decade. If a future edit reaches for a "nicer" ratio, this goes red.
 */
test('tick and label sizes sit inside the range OpenSCAD sweeps within a decade', () => {
  for (const decade of [-1, 0, 2]) {
    const lo = Math.pow(10, decade); // the smallest l in this decade
    const hi = lo * 10; // the largest
    const plan = rulerPlan(lo * 3, 1e9)!;

    for (const [ours, div] of [
      [plan.minorLength, OPENSCAD_MINOR_DIV],
      [plan.majorLength, OPENSCAD_MAJOR_DIV],
      [plan.labelHeight, OPENSCAD_MINOR_DIV], // font_size is l/60 — its minor tick
    ] as const) {
      assert.ok(ours >= lo / div, `${ours} below OpenSCAD's smallest ${lo / div}`);
      assert.ok(ours <= hi / div, `${ours} above OpenSCAD's largest ${hi / div}`);
    }
  }
});

/**
 * ⚠ THE ASYMMETRY IS OPENSCAD'S AND IS NOT A SLIP. `GLView.cc:562-578`: the X
 * tick arm runs toward −Y, and BOTH the Y and Z arms run toward −X. Copied
 * rather than tidied, because "tidying" it would put Z ticks in a plane OpenSCAD
 * deliberately does not use.
 */
test('tick arm directions are OpenSCAD’s, including the Y/Z asymmetry', () => {
  assert.deepEqual([...TICK_DIRECTION.x], [0, -1, 0]);
  assert.deepEqual([...TICK_DIRECTION.y], [-1, 0, 0]);
  assert.deepEqual([...TICK_DIRECTION.z], [-1, 0, 0]);
  // And a tick arm is never along its own axis, which would draw it as a gap.
  for (const a of AXES) {
    const dot = AXIS_DIRECTION[a].reduce((s, v, i) => s + v * TICK_DIRECTION[a][i], 0);
    assert.equal(dot, 0, `tick on ${a} is not perpendicular to it`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   5. The AND from GLView.cc:198
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 SCALE MARKERS CANNOT SURVIVE THE AXES BEING OFF. `MainWindow.cc:2761`
 * disables the control and `GLView.cc:198` ANDs the flags — two places, one
 * rule. The menu carries the first (`cad-menu.test.ts`); this is the second, and
 * it is the one whose failure is silent: ticks floating with no axis under them
 * while the menu says the axes are off.
 */
test('scale markers are ANDed with axes, not merely disabled in the menu', () => {
  assert.equal(rulersDrawn(true, true), true);
  assert.equal(rulersDrawn(false, true), false);
  assert.equal(rulersDrawn(true, false), false);
  assert.equal(rulersDrawn(false, false), false);
});

/**
 * ⚠ A SOURCE-SHAPE ASSERTION, AND IT IS NAMED AS THE WEAKER THING IT IS. The
 * render loop is unreachable from this harness — there is no WebGL context — so
 * what is checked is that the loop asks {@link rulersDrawn} rather than
 * re-deriving the rule inline. It proves the call site exists; it does not prove
 * the frame ran.
 */
test('the render loop asks the shared rule rather than re-deriving it', () => {
  const src = source('cad', 'preview.tsx');
  assert.match(src, /rulersDrawn\(kit\.current\.view\.axes, kit\.current\.view\.scale\)/);
  assert.doesNotMatch(src, /view\.axes\s*&&\s*kit\.current\.view\.scale/);
});

/* ════════════════════════════════════════════════════════════════════════════
   6. The orbit pivot
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Founder 2026-08-11: *"the center (mouse rotation) should be in the middle of
 * the base area"*. What it WAS: the three-axis midpoint of the bounds, so a box
 * standing on the bed orbited about a point half its height in the air.
 */
test('the pivot is the XY centre of the bounds at z = 0', () => {
  const f = framing({ min: [10, -30, 0], max: [110, 70, 40] })!;
  assert.deepEqual(f.pivot, [60, 20, 0]);
});

/**
 * 🔴 AND THE FRAMING RADIUS IS RE-DERIVED ABOUT THAT PIVOT. This is the half
 * that is easy to miss: moving the pivot down to z = 0 pushes the model
 * off-centre in the view by exactly the height it stands, so the old span — the
 * largest EDGE of the box — no longer contains it. `Fit` has to frame the thing
 * the camera orbits, or the button that exists to give the model back stops
 * doing so.
 */
test('a tall model standing on z = 0 is framed by its height ABOVE the pivot, not by half of it', () => {
  // 20 x 20 footprint, 500 tall, sitting on the bed. Half the height is 250;
  // the distance from the pivot to the top is 500.
  const f = framing({ min: [-10, -10, 0], max: [10, 10, 500] })!;
  assert.equal(f.span, 1000);
});

test('a model built downward from the origin is the same case mirrored', () => {
  const f = framing({ min: [-10, -10, -500], max: [10, 10, 0] })!;
  assert.equal(f.span, 1000);
});

/**
 * ⚠ THE OLD ANSWER AND THE NEW ONE AGREE EXACTLY FOR A MODEL ALREADY CENTRED ON
 * z = 0. Worth stating: this change is not a re-scaling of every view, it is a
 * correction to the case where the model does not straddle the origin.
 */
test('for a model centred on z = 0 the new framing equals the largest edge', () => {
  const f = framing({ min: [-50, -20, -15], max: [50, 20, 15] })!;
  assert.deepEqual(f.pivot, [0, 0, 0]);
  assert.equal(f.span, 100); // the X edge, exactly as before
});

/**
 * 🔴 AN EMPTY SCENE MOVES NOTHING. This tab parses on every keystroke, and a
 * refusal cascade renders the tree minus every subtree — a half-typed
 * `difference(` empties the bounds. `null` is the instruction to leave the
 * camera where it is; a pivot invented from empty bounds would be a camera move
 * caused by a keystroke, which is precisely what this whole change must not
 * introduce.
 */
test('empty or unmeasurable bounds produce NO framing at all', () => {
  assert.equal(framing(null), null);
  assert.equal(framing({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }), null);
  assert.equal(framing({ min: [0, 0, Number.NaN], max: [1, 1, 1] }), null);
});

/** A zero-extent model — one point, or a 2D plate at z = 0 — still frames. */
test('a degenerate model gets a usable span rather than a zero one', () => {
  const f = framing({ min: [5, 5, 0], max: [5, 5, 0] })!;
  assert.deepEqual(f.pivot, [5, 5, 0]);
  assert.ok(f.span >= 1);
});

/**
 * ⚠ A SOURCE-SHAPE ASSERTION AGAIN, AND THE SAME CAVEAT. The property that
 * matters — *the camera does not move on a parse* — is a statement about when an
 * effect calls `frameScene`, and the effect needs a renderer this harness does
 * not have. So: the `[result]` effect's call is inside the `framedOnce` guard,
 * and the per-frame `tick()` contains no call at all. That is the structure the
 * property rests on; it is not the property observed.
 */
test('framing is reached from exactly two places, and neither is the render loop', () => {
  const src = source('cad', 'preview.tsx');
  const calls = src.match(/frameScene\?\.\(/g) ?? [];
  assert.equal(calls.length, 2, 'a third caller of frameScene appeared');

  // The `[result]` effect's call is guarded by framedOnce, on the line before.
  assert.match(src, /if \(!kit\.current\.framedOnce\) \{\s*\n\s*kit\.current\.framedOnce = true;\s*\n\s*kit\.current\.frameScene\?\.\(/);

  // And the render loop does not touch it. `tick` runs from requestAnimationFrame.
  const tickBody = src.slice(src.indexOf('const tick = () => {'), src.indexOf('    tick();'));
  assert.ok(tickBody.length > 500, 'the render loop was not located');
  assert.doesNotMatch(tickBody, /frameScene/);
  assert.doesNotMatch(tickBody, /framing\(/);
});
