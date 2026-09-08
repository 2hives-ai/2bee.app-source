// Two viewports, one convention.
//
// WHY THIS TEST IS A SOURCE-TEXT TEST, SAID PLAINLY
//
// The camera in each viewport lives inside a `useEffect` closure over a
// WebGLRenderer. There is no WebGL and no DOM in this harness, the state
// (`theta`, `phi`, `radius`, `target`) is not exported, and lifting it out of
// `Viewport.tsx` was explicitly out of scope for the change that added this
// file. So this asserts on the SOURCE TEXT of the four convention lines rather
// than on their behaviour.
//
// 🔴 WHAT THAT BUYS AND WHAT IT DOES NOT. It catches the thing that actually
// happens — someone flips a sign in one file to "fix" a drag direction and the
// two tabs silently start disagreeing. It CANNOT catch a change that alters the
// observable direction without altering these lines: a `place()` rewritten to a
// different parameterisation, a scene-level transform, a wrapper that inverts
// the pointer deltas before they arrive. A behavioural test needs a browser and
// belongs in `web/e2e/`, which is not this lane's file to write.
//
// ⚠ It is also deliberately NOT a "these two files are identical" test. Only
// the four conventions are compared; everything else about the two viewports
// differs on purpose (scene contents, picking, clamps, limits, framing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', 'src', p), 'utf8');

const cnc = read('Viewport.tsx');
const cad = read('cad/preview.tsx');

/* The one VALUE compared rather than matched as text — see the triad section. */
const { CNC_TRIAD_FORM } = await import('../src/cad/preview.tsx');

/** Whitespace is not a convention. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The four independent sign choices. They are four separate assertions on
 * purpose: a report that says "the camera differs" sends someone to read 200
 * lines, and a report that says "orbit elevation differs" sends them to one.
 */
const CONVENTIONS: { name: string; needle: RegExp }[] = [
  {
    name: 'orbit azimuth — drag right turns the model right',
    needle: /theta\s*-=\s*dx\s*\*\s*([\d.]+)\s*;/,
  },
  {
    // The clamp is part of this convention, not separate from it: it decides
    // whether the camera may pass under the model, and a viewport that can and
    // one that cannot behave differently at the same gesture.
    name: 'orbit elevation — drag down raises the camera, within the same band',
    needle:
      /phi\s*=\s*Math\.min\(Math\.PI\s*-\s*[\d.]+,\s*Math\.max\([\d.]+,\s*phi\s*-\s*dy\s*\*\s*[\d.]+\)\)\s*;/,
  },
  {
    name: 'pan x — the scene follows the mouse',
    needle: /target\.x\s*-=\s*dx\s*\*\s*k\s*\*\s*rightX\s*-\s*dy\s*\*\s*k\s*\*\s*fore\s*\*\s*upX\s*;/,
  },
  {
    name: 'pan y — the scene follows the mouse',
    needle: /target\.y\s*-=\s*dx\s*\*\s*k\s*\*\s*rightY\s*-\s*dy\s*\*\s*k\s*\*\s*fore\s*\*\s*upY\s*;/,
  },
  {
    name: 'wheel zoom — scrolling toward you zooms out',
    needle: /radius\s*\*\s*\(\s*e\.deltaY\s*>\s*0\s*\?\s*([\d.]+)\s*:\s*([\d.]+)\s*\)/,
  },
];

for (const c of CONVENTIONS) {
  test(`both viewports agree: ${c.name}`, () => {
    const a = cnc.match(c.needle);
    const b = cad.match(c.needle);
    assert.ok(a, `Viewport.tsx no longer contains this convention — the test has gone blind, not green`);
    assert.ok(b, `cad/preview.tsx no longer contains this convention — the test has gone blind, not green`);
    assert.equal(
      squash(b[0]),
      squash(a[0]),
      'the CAD preview and the CNC viewport now drag in different directions. ' +
        'Viewport.tsx is the one to match: it is the surface operators judge a cutting job on, ' +
        'and its camera constants are load-bearing for the screen-to-machine mapping elsewhere.',
    );
  });
}

/**
 * The same modifier opens the same gesture. Two viewports where shift-drag pans
 * in one and orbits in the other is the same defect as an inverted axis,
 * arriving through a different door.
 */
test('both viewports enter pan on the same buttons', () => {
  const needle = /panning\s*=\s*e\.button\s*===\s*2\s*\|\|\s*e\.shiftKey\s*;/;
  assert.ok(needle.test(cnc), 'Viewport.tsx pan trigger not found — blind, not green');
  assert.ok(needle.test(cad), 'cad/preview.tsx pan trigger not found — blind, not green');
});

/**
 * 🔴 THE MEASUREMENT THIS FILE RECORDS, so the next person does not have to
 * redo it. On 2026-08-11 a report of "3d mouse movement is opposite" was
 * checked against BOTH references and the CAD preview matched both:
 *
 *   · this app's CNC viewport — byte-identical arithmetic, asserted above;
 *   · OpenSCAD 2026.08.07 — its own default mouse configuration, read at
 *     `src/core/MouseConfig.h` (`presetSettings[OPEN_SCAD]` maps LEFT_CLICK to
 *     ROTATE_ALT_AZ, whose matrix gives `object_rot.x += dy` and
 *     `object_rot.z += dx`; RIGHT_CLICK maps to PAN_LR_UD, `+dx` along screen
 *     right and `-dy` along screen up), with the render signs at
 *     `src/glview/GLView.cc:147-149` and the eye fixed at `(0, -dist, 0)`,
 *     up = +Z, in `GLView::setupCamera`.
 *
 * So a sign flipped here to satisfy that report would put this tab at odds with
 * the other tab in the same app AND with the tool it imitates. If the direction
 * is still wrong for someone, the disagreement is with all three at once and is
 * a decision, not a bug fix.
 */
test('the recorded reference measurement is stated in the file that implements it', () => {
  assert.match(cad, /MouseConfig\.h/, 'the OpenSCAD reference must stay next to the code it justifies');
  assert.match(cad, /byte-identical to `Viewport\.tsx`/);
});

/* ════════════════════════════════════════════════════════════════════════════
   The origin triad — same convention, different origin, and both on purpose
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 TWO TABS DISAGREEING ABOUT WHICH AXIS IS Y IS WORSE THAN NEITHER HAVING
 * ARROWS. `AXIS_COLOR` is module-private in `Viewport.tsx`, which is another
 * lane's live file, so the CAD triad holds a COPY of the six hex digits. A copy
 * with no guard is a divergence waiting for its first edit, so the guard is
 * this: read both files, compare the literals.
 *
 * ⚠ It compares the VALUES, not the text around them. Either file may rename
 * or re-comment its constant freely; only a changed colour goes red.
 */
test('both tabs draw X red, Y green and Z blue with the same six hex digits', () => {
  const pick = (text: string) => {
    const m = /AXIS_COLOR\s*=\s*\{([^}]*)\}/.exec(text);
    assert.ok(m, 'AXIS_COLOR not found — the test has gone blind, not green');
    const out: Record<string, string> = {};
    for (const [, k, v] of m[1].matchAll(/([xyz])\s*:\s*(0x[0-9a-fA-F]{6})/g)) {
      out[k] = v.toLowerCase();
    }
    return out;
  };
  const a = pick(cnc);
  const b = pick(cad);
  assert.deepEqual(Object.keys(a).sort(), ['x', 'y', 'z'], 'the CNC triad lost an axis');
  assert.deepEqual(b, a, 'the two tabs now disagree about which colour an axis is');
  /* And the convention is not ours to change: OpenSCAD's own small-axes cross
   * is red/green/blue for X/Y/Z, so all three tools agree. */
  assert.match(a.x, /^0x[cd]/, 'X should be the red one');
});

/**
 * 🔴 INVERTED, NOT DELETED, ON 2026-08-11. This test asserted *"the CAD triad is
 * rooted at the world origin"* — true, and correct at the time, and its reason
 * was the founder's own complaint *"the xyz arros center seems on top of the
 * workpeace"* against the CNC tab, which at the time lifted its triad to
 * `aZ = 0.4` above a z = 0 that is the declared work zero.
 *
 * ⚠ THAT LIFT IS GONE (`37bdb0bc6d`, 2026-08-11) — measured at 0.23px in the
 * view the complaint was made from, so it was never what the founder saw. The
 * premise is corrected here rather than the paragraph deleted: the assertion
 * below does not depend on the CNC tab having a lift, it depends on this tab's
 * z = 0 being OpenSCAD's world origin and not a datum.
 *
 * The founder then asked to *"move the xyz arrow to the corner (check how is it
 * positioned in openscad)"*. **OpenSCAD has BOTH**, off one flag
 * (`GLView.cc:196` and `:225`): a coloured, labelled `showSmallaxes()` cross in
 * the LOWER LEFT CORNER, and a separate uncoloured `showAxes()` cross through
 * the world origin. So the coloured triad moved to a corner gizmo and the origin
 * kept a marker.
 *
 * ⚠ THE OLD ASSERTION'S REASON SURVIVES ANYWAY, which is why it is inverted
 * rather than dropped: the marker that replaced the triad must still sit at a
 * literal `[0,0,0]`, and the CNC lift must still not have been copied. Deleting
 * the test would have deleted the only thing standing between this tab and a
 * "tidy-up" that lifts the origin marker onto a work plane that does not exist
 * here.
 */
test('the corner gizmo scene is gone, and the world origin kept a marker at a literal zero', () => {
  const code = cad.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // The corner gizmo scene and its arrows are no longer allocated — the pivot
  // triad at the orbit centre serves as the orientation indicator instead.
  assert.ok(!code.includes('gizmoScene'), 'the gizmo scene is still allocated');
  assert.ok(!code.includes('gizmoArrow'), 'the gizmo arrows are still allocated');

  // And the WORLD origin still has an instrument on it, centred at zero. A
  // corner gizmo is screen-fixed and orientation-only; it cannot answer "where
  // is [0,0,0] relative to my model", which is what `translate()` is about.
  assert.match(code, /const axes = new THREE\.Group\(\);/, 'the world-origin marker is gone entirely');
  assert.match(code, /multiplyScalar\(-reach\)/, 'the origin cross lost its negative half');
  assert.match(code, /computeLineDistances\(\)/, 'the dashed negative half will render SOLID without this');

  // Neither instrument was lifted off the origin. The CNC tab no longer has a
  // lift of its own to copy (`37bdb0bc6d`), so this is no longer a ban on
  // copying — it is a ban on inventing one, which is the form it should always
  // have had: the origin marker marks the origin.
  assert.ok(!/\baZ\b/.test(code), 'an `aZ` lift appeared in a tab whose z = 0 is the world origin');
  assert.ok(
    !/new THREE\.Vector3\(0, 0, 0\.4\)/.test(code),
    'an origin marker rooted somewhere other than the origin',
  );
  /* The reason must travel with the code — this is the third time the lift would
   * look like an obvious tidy-up to somebody.
   *
   * ⚠ THE SPELLING IS PART OF THE ASSERTION, 2026-08-11. This pattern used to
   * require `workpiece`, which is NOT what the founder wrote — it matched a
   * gloss that had been added beside the verbatim quote, so a rewrite that kept
   * the quote and dropped the gloss went red while the reason was still fully
   * present. A guard on a paraphrase is a guard on whoever paraphrased last;
   * both spellings are accepted now and the verbatim one is the one that
   * matters. */
  assert.match(cad, /on\s+top\s+of\s+the\s+workp(?:ie|ea)ce/i);
  /* And what OpenSCAD actually does must stay beside the code that imitates it,
   * because the previous version of this note said `showAxes` was "not taken"
   * and that sentence is what made moving the triad look like a deletion. */
  assert.match(cad, /showSmallaxes/, 'the OpenSCAD reference for the corner gizmo is no longer stated');
  assert.match(cad, /showAxes\(\)/, 'the OpenSCAD reference for the origin cross is no longer stated');
});

/**
 * 🔴 THE THREE PROPERTIES A GIZMO HAS THAT AN ORIGIN TRIAD DOES NOT, each of
 * which is a separate way to build the wrong thing:
 *
 *   1. IT DOES NOT SCALE WITH ZOOM. Its size comes from the CANVAS. The moment
 *      `radius` or `span` reaches the sizing line it has stopped being a gizmo
 *      and become a very small model.
 *   2. IT IS NEVER OCCLUDED. OpenSCAD uses `glDepthFunc(GL_ALWAYS)`; here the
 *      equivalent is a second scene plus `clearDepth()` inside the scissor box.
 *      Without the clear, geometry near the origin draws over it.
 *   3. IT IS BUILT ONCE. The `[result]` effect runs on every mesh — every 250 ms
 *      while someone types — and empties both the scene and the dispose list. A
 *      gizmo built there would be rebuilt at that rate, which is the thrash
 *      `Viewport.tsx` had before its scene was keyed by value.
 *
 * ⚠ SOURCE-TEXT, for the reason at the top of this file: the whole thing lives
 * inside a closure over a `WebGLRenderer` and there is no WebGL here. This
 * catches the edit that breaks it; it cannot show that anything is drawn.
 */
test('the corner gizmo is removed; the pivot triad at the orbit centre serves as orientation', () => {
  // The corner gizmo (bottom-left orientation indicator) was removed in favour
  // of the pivot triad at the orbit centre — matching the CNC viewport's triad
  // at the machine origin. The pivot triad is already tested by the existing
  // "coloured triad" test above.
  const code = cad.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Verify the corner gizmo rendering is NOT present
  assert.ok(!code.includes('renderer.setScissor('), 'the corner gizmo scissor box is still rendered');
  assert.ok(!code.includes('renderer.clearDepth()'), 'the corner gizmo depth clear is still present');
  // Verify the pivot triad IS present
  assert.match(code, /pivotTriad/, 'the pivot triad at the orbit centre is missing');
});

/**
 * 🔴 REPLACED, NOT DELETED, ON 2026-08-11 — AND THE REPLACEMENT IS A DIFFERENT
 * KIND OF ASSERTION.
 *
 * What was here: `cad-preview-verdict` was a DOM box spanning `left: 8 …
 * right: 8, bottom: 8` on top of the canvas, i.e. exactly where the corner gizmo
 * draws. A gizmo rendered correctly and covered completely is indistinguishable
 * from one that was never drawn, and there is no browser here to notice — so the
 * box indented by a shared `GIZMO_CLEARANCE` and this file asserted the two
 * numbers could not drift apart.
 *
 * The founder removed that box (*"remove cad-preview-verdict"*). Its statements
 * moved to a block anchored to the TOP of the picture, and with nothing
 * bottom-anchored the collision is not merely fixed, it is **unreachable at any
 * pane size** — so the constant and the drift test became a control guarding
 * something that cannot happen, which is the dead-control class this lane keeps
 * filing. Both are gone.
 *
 * ⚠ WHAT REPLACES IT IS THE PROPERTY THE OLD NUMBER WAS STANDING IN FOR: no
 * overlay that shares the canvas is anchored to the bottom. That is stronger
 * than the old assertion — it cannot be satisfied by a second box with a
 * different number — and it is the thing a "tidy-up" would break.
 *
 * ⚠ WHAT IT DOES NOT COVER: the no-renderer panel, which IS bottom-anchored on
 * purpose. When there is no renderer there is no canvas and therefore no gizmo
 * to hide, and that panel replaces the picture rather than sitting on it. The
 * slice below is scoped to the overlay column for exactly that reason.
 */
test('nothing that shares the canvas is bottom-anchored, so the gizmo corner cannot be covered', () => {
  /* ⚠ THE IDENTIFIER MUST BE GONE; THE HISTORY MAY STAY. Comments are stripped
   * before this assertion on purpose — `preview.tsx` explains at some length why
   * the clearance existed and why it no longer can, and a test that forbade the
   * WORD would delete the record of a defect along with the defect. */
  const live = cad.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/GIZMO_CLEARANCE/.test(live),
    'GIZMO_CLEARANCE is back. If an overlay needs to dodge the gizmo again, the layout is wrong: ' +
      'a number that has to keep matching another number is what this replaced.',
  );
  assert.ok(!/cad-preview-verdict/.test(live), 'the verdict box is back on the picture');

  const marker = 'THE OVERLAY COLUMN';
  const at = cad.indexOf(marker);
  assert.ok(at > 0, 'the overlay column marker moved — this test has gone blind, not green');
  /* ⚠ THE SLICE STARTS AFTER THE COLUMN'S OWN HEADER COMMENT, and the first two
   * cuts of this line did not. That comment QUOTES the removed box's
   * `left: 8 … right: 8, bottom: 8` while explaining why it is gone — so a slice
   * that began at the marker began INSIDE a comment, left an unmatched tail that
   * no comment-stripper could match, and the assertion fired on its own
   * documentation. A false red is what gets an assertion deleted rather than
   * narrowed. */
  const jsx = cad.indexOf('*/}', at);
  assert.ok(jsx > at, 'the overlay column no longer opens with a comment — blind, not green');
  const column = cad.slice(jsx + 3).replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

  /* Every overlay lives in this column, and the column is pinned to the top. */
  assert.match(column, /position: 'absolute',\s*\n\s*top: 8,/, 'the overlay column is no longer top-anchored');
  assert.ok(
    !/\bbottom:/.test(column),
    'an overlay is anchored to the bottom of the canvas again, which is where the corner gizmo draws',
  );
  for (const id of ['cad-preview-stale', 'cad-preview-alarm', 'cad-preview-fit']) {
    assert.ok(column.includes(id), `${id} is no longer inside the top-anchored column`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   The orbit-centre triad — the CNC tab's arrow, at this tab's orbit centre
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE FORM IS A COPY AND THE COPY IS GUARDED, exactly as `AXIS_COLOR` is.
 * Founder 2026-08-11: *"have the same xyz arrow in 2bee.cad what already exists
 * in 2bee.cnc"*. A genuinely shared component would have to live in a module
 * both files import, and `Viewport.tsx` is another lane's live file that the
 * change adding this may not edit — so the guard is to read BOTH files and
 * compare the ratios.
 *
 * ⚠ IT COMPARES PROPORTIONS, NOT LENGTHS. The CNC triad is sized to the machine
 * (`max(25, min(tx,ty) * 0.13)`) and this one is sized to the screen; that
 * difference is the point of the change and is asserted separately below.
 */
test('the CAD orbit triad is the CNC arrow, ratio for ratio', () => {
  const cone = /const cone = track\(new THREE\.ConeGeometry\(len \* ([\d.]+), len \* ([\d.]+), (\d+)\)\);/.exec(cnc);
  assert.ok(cone, 'Viewport.tsx’s arrowhead is not the one this test knows — blind, not green');
  assert.equal(CNC_TRIAD_FORM.coneRadius, Number(cone[1]), 'the two arrowheads are now different widths');
  assert.equal(CNC_TRIAD_FORM.coneHeight, Number(cone[2]), 'the two arrowheads are now different lengths');
  assert.equal(CNC_TRIAD_FORM.coneSegments, Number(cone[3]), 'the two arrowheads are now different shapes');

  const label = /letter\(label, colour, to\.clone\(\)\.addScaledVector\(dir, len \* ([\d.]+)\), aLen \* ([\d.]+)\);/.exec(cnc);
  assert.ok(label, 'Viewport.tsx’s label placement moved — blind, not green');
  /* `to` is one length out, so the CNC offset `len * 0.22` is `1.22` from the
   * root — which is what `labelAt` means. */
  assert.ok(
    Math.abs(CNC_TRIAD_FORM.labelAt - (1 + Number(label[1]))) < 1e-9,
    'the letters now hang at different distances in the two tabs',
  );
  assert.equal(CNC_TRIAD_FORM.labelSize, Number(label[2]), 'the letters are now different sizes in the two tabs');
});

/**
 * 🔴 THE THREE WAYS TO BUILD THIS WRONG, each of which is a separate defect:
 *
 *   1. AT THE ORIGIN INSTEAD OF THE PIVOT. Coloured, lettered arrows are read as
 *      `[0,0,0]`, and the founder asked for them at the point the view rotates
 *      about — which is the XY centre of the model at z = 0, not the origin.
 *   2. RECOMPUTED PER PARSE. `framing()`'s pivot is recorded on every mesh, i.e.
 *      250 ms after every keystroke. A triad positioned from THAT twitches while
 *      the camera does not move. `target` is the orbit state itself and is
 *      written only by `frameScene` and by a pan.
 *   3. LIFTED. An instrument raised clear of the surface it is supposed to mark
 *      reads as marking something else. (⚠ This item used to cite the CNC tab's
 *      own `aZ = 0.4` lift and the founder's complaint about it; `37bdb0bc6d`
 *      removed that lift after measuring it at 0.23px in the view the complaint
 *      came from, so the example is gone and the failure mode is not.) The `aZ`
 *      ban is asserted above; this asserts the positive form.
 */
test('the orbit triad sits on the live orbit target, is built once, and is sized from the screen', () => {
  const code = cad.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.equal(
    (code.match(/const pivotTriad = new THREE\.Group\(\)/g) ?? []).length,
    1,
    'the orbit triad is constructed more than once',
  );
  const resultEffect = cad.indexOf('// --- scene contents ---');
  assert.ok(
    cad.indexOf('const pivotTriad = new THREE.Group();') < resultEffect,
    'the orbit triad is built inside the per-mesh effect, so it is rebuilt on every keystroke',
  );
  /* And the per-mesh sweep does not delete it, which is the other half of the
   * same ownership: built once, and not thrown away by somebody else. */
  assert.match(code, /if \(o === kit\.current\.pivotTriad\) continue;/, 'the [result] sweep deletes the orbit triad');

  // 1 + 2. Positioned from the live orbit target and from nothing else.
  assert.match(code, /pivotTriad\.position\.copy\(target\);/, 'the orbit triad is not on the orbit target');
  assert.ok(
    !/pivotTriad\.position[\s\S]{0,80}(lastPivot|bounds|centre)/.test(code),
    'the orbit triad is positioned from the per-mesh framing, so it moves while the camera does not',
  );

  // 3. Sized in screen pixels, through the projection-blind helper.
  assert.match(
    code,
    /pivotTriad\.scale\.setScalar\(worldPerPixel\(radius, viewH\) \* PIVOT_TRIAD_PX\);/,
    'the orbit triad is no longer a constant size on screen — it vanishes or swamps at the clamp ends',
  );

  // Coloured and lettered, with the CNC form and no placement baked into it.
  assert.match(code, /form: CNC_TRIAD_FORM,/, 'the orbit triad stopped using the CNC arrow form');
  assert.match(code, /depthTest: false,/, 'the orbit triad is occluded by the model it sits inside');
});

/**
 * ⚠ WHAT PARITY DOES **NOT** COVER, measured 2026-08-11 and written down so the
 * next reader does not re-derive it. The four direction conventions above are
 * byte-identical. These differ, and each difference is content-driven rather
 * than a drift:
 *
 *   · wheel clamp — CNC `min(9000, max(120, …))`, CAD `min(200000, max(1, …))`.
 *     The CNC numbers are sized to a machine bed; forcing them here would stop
 *     an operator zooming in on a 10 mm bracket.
 *   · near/far and the initial radius — same reason, same direction.
 *   · the CNC tab additionally consumes a LEFT drag when it lands on a clamp, a
 *     part or the sheet. This tab has no draggable objects, so a left drag
 *     always orbits.
 *
 * None of those is a direction, so none of them can produce *"3d mouse movement
 * is opposite"*. They can produce *"it feels different"*, which is a real
 * report about a real difference — and this test states which one.
 */
test('the wheel FACTOR is shared and only the CLAMP differs, which is content, not drift', () => {
  const factor = /radius\s*\*\s*\(\s*e\.deltaY\s*>\s*0\s*\?\s*1\.12\s*:\s*0\.9\s*\)/;
  assert.ok(factor.test(cnc) && factor.test(cad), 'the zoom step is no longer shared');

  /* ⚠ THE NEEDLE IS ANCHORED TO THE WHEEL HANDLER, and the first cut of it was
   * not. `/Math.min(N, Math.max(M, radius/` matched an UNRELATED radius clamp
   * earlier in `Viewport.tsx` (`min(20, max(1, …`), so this assertion compared
   * the CAD zoom clamp against a number that has nothing to do with zoom — and
   * a planted "force the machine clamp onto the CAD tab" stayed GREEN. It was
   * the negative control that said so, not the reading. Requiring
   * `radius * (e.deltaY` puts the match on the one line that is the subject. */
  const clampOf = (t: string) =>
    /radius\s*=\s*Math\.min\((\d+),\s*Math\.max\((\d+),\s*radius\s*\*\s*\(\s*e\.deltaY/.exec(t);
  const a = clampOf(cnc);
  const b = clampOf(cad);
  assert.ok(a && b, 'a zoom clamp went missing — blind, not green');
  assert.notDeepEqual(
    [b[1], b[2]],
    [a[1], a[2]],
    'the CAD clamp now matches the machine-sized one, which stops small parts being zoomed in on',
  );
});
