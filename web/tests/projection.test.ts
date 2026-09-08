// Perspective ↔ orthographic, in both 3D canvases — `web/src/projection.ts`,
// `web/src/Viewport.tsx`, `web/src/cad/preview.tsx`.
//
// Founder 2026-08-11: *"add perspective / orthogonal view change capability in
// all 3d canvas."*
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS FILE CANNOT SEE, SAID FIRST
// ═══════════════════════════════════════════════════════════════════════════
//
// **THERE IS NO BROWSER AND NO WEBGL HERE, AND A PROJECTION CHANGE IS A PURELY
// VISUAL CAPABILITY.** Nothing below shows that the picture became orthographic.
// It cannot: the camera lives inside a `useEffect` closure over a
// `WebGLRenderer`, `canvas.getContext('webgl')` returns `null` on this box, and
// "parallel edges no longer converge" is a fact about pixels.
//
// What is asserted instead, and it is chosen to be the set that would actually
// go wrong:
//
//   · the ARITHMETIC, as pure functions — the ortho frustum, the shared
//     world-per-pixel, the depth range, the validator, the two defaults;
//   · the BRANCH each handler takes, as source text — which is how the "wheel
//     dead in ortho" and "Fit frames the wrong volume" defects would arrive;
//   · the things that must NOT have changed — the corner gizmo, the ruler's
//     rebuild key, the two tabs' different zoom clamps.
//
// ⚠ SOURCE-TEXT ASSERTIONS GO BLIND RATHER THAN GREEN when the code they read
// is rewritten. Every one below therefore asserts the needle was FOUND before it
// asserts anything about it — a `doesNotMatch` on a file whose shape has moved is
// a test that passes by looking at nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAD_DEFAULT_PROJECTION,
  CAMERA_FOV_DEG,
  CNC_DEFAULT_PROJECTION,
  ORTHO_DEPTH_REACH,
  orthoFrustum,
  orthoHalfHeight,
  readProjection,
  worldPerPixel,
} from '../src/projection.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...p: string[]) => readFileSync(join(HERE, '..', 'src', ...p), 'utf8');

const cnc = source('Viewport.tsx');
const cad = source('cad', 'preview.tsx');

/** Comments removed, so a needle cannot match the prose that discusses it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/[^\n]*$/gm, ' ');
const cncCode = code(cnc);
const cadCode = code(cad);

/* ════════════════════════════════════════════════════════════════════════════
   1. THE TRAP: the wheel must not be dead in orthographic
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE WHOLE FEATURE RESTS ON THIS ONE PROPERTY. In an orthographic camera,
 * moving the eye closer changes nothing — so a port that keeps the perspective
 * dolly and adds an ortho camera with a fixed frustum leaves the wheel visibly
 * dead. It is not dead here because the frustum is DERIVED from the same orbit
 * distance the wheel multiplies.
 */
test('the orthographic frustum is strictly monotone in the orbit distance — the wheel is alive', () => {
  const radii = [1, 10, 120, 200, 1400, 9000, 200000];
  for (let i = 1; i < radii.length; i++) {
    assert.ok(
      orthoHalfHeight(radii[i]) > orthoHalfHeight(radii[i - 1]),
      `zooming from ${radii[i - 1]} to ${radii[i]} did not change the visible extent`,
    );
  }
  /* And the app's own wheel STEP moves it by the same ratio it moves the
   * perspective view: the factor is on `radius` and the half-height is linear in
   * `radius`, so a notch is a 12%/10% change in BOTH modes. */
  const r = 1400;
  assert.ok(Math.abs(orthoHalfHeight(r * 1.12) / orthoHalfHeight(r) - 1.12) < 1e-12);
  assert.ok(Math.abs(orthoHalfHeight(r * 0.9) / orthoHalfHeight(r) - 0.9) < 1e-12);
});

/**
 * 🔴 THE PLANT THIS FILE EXISTS FOR, EXPRESSED AS A SOURCE ASSERTION. The way
 * the wheel goes dead is not an arithmetic slip — it is `applyProjection()` being
 * called on the mode change and NOT on the zoom. `place()` is what every gesture
 * ends in, so `place()` must rebuild the frustum.
 *
 * ⚠ WATCHED RED: deleting `applyProjection()` from either `place()` fails this,
 * and was confirmed to fail before the line was restored byte-identical.
 */
test('both viewports rebuild the frustum inside place(), so a wheel notch reaches it', () => {
  for (const [name, src] of [
    ['Viewport.tsx', cncCode],
    ['cad/preview.tsx', cadCode],
  ] as const) {
    const place = /const place = \(\) => \{([\s\S]*?)\n    \};/.exec(src);
    assert.ok(place, `${name}: place() not found — the test has gone blind, not green`);
    assert.match(
      place[1],
      /applyProjection\(\);/,
      `${name}: place() no longer rebuilds the projection, so the wheel is dead in orthographic`,
    );
  }
});

/**
 * ⚠ AND THE WHEEL HANDLER ITSELF IS UNTOUCHED AND UNBRANCHED. If it ever grows a
 * projection branch, there are two zoom scales and switching mode jumps the view.
 * OpenSCAD's `Camera::zoom` has no branch either (`Camera.cc:117`).
 */
test('neither wheel handler knows the projection exists', () => {
  for (const [name, src] of [
    ['Viewport.tsx', cncCode],
    ['cad/preview.tsx', cadCode],
  ] as const) {
    const wheel = /const wheel = \(e: WheelEvent\) => \{([\s\S]*?)\n    \};/.exec(src);
    assert.ok(wheel, `${name}: the wheel handler moved — blind, not green`);
    assert.doesNotMatch(
      wheel[1],
      /projection|ortho|Ortho/,
      `${name}: the wheel now branches on the projection, so the two modes have two zoom scales`,
    );
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   2. Fit frames the same volume in both, and nothing was re-derived for ortho
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE INVARIANT THAT MAKES `Fit` PROJECTION-BLIND. `orthoHalfHeight(r)` is BY
 * CONSTRUCTION the half-height a perspective frustum of the same fov subtends at
 * distance `r`. So whatever radius the existing framing maths produces — and it
 * is `dcf4adeea6`'s framing, re-derived about the base-area pivot with the z
 * half-extent as `max(|z_max|,|z_min|)` — is correct for both projections, and
 * there is nothing to re-derive for the orthographic path.
 */
test('the ortho half-height IS the perspective half-height at the same distance', () => {
  for (const r of [1, 120, 200, 1400, 9000]) {
    const perspective = r * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
    assert.ok(
      Math.abs(orthoHalfHeight(r) - perspective) < 1e-9 * Math.max(1, r),
      `at radius ${r} the two projections frame different volumes`,
    );
  }
});

/**
 * 🔴 AND `framing()` IS UNTOUCHED. It is the one piece of framing arithmetic in
 * this app that was carefully derived — pivot at the XY centre at z = 0, half-
 * extent `max(|z_max|,|z_min|)` because the model may stand entirely above the
 * pivot — and re-deriving it "for ortho" is the named way to get it wrong. The
 * assertion is on the arithmetic, not on the file: it must still contain no
 * projection term.
 */
test('the framing maths has no projection term in it', () => {
  const fn = /export function framing\(bounds: SceneBounds \| null\): Framing \| null \{([\s\S]*?)\n\}/.exec(
    cad,
  );
  assert.ok(fn, 'framing() not found — blind, not green');
  assert.doesNotMatch(
    fn[1],
    /projection|ortho|Ortho|fov/i,
    'framing() now depends on the projection, so the two modes frame different volumes',
  );
  // The two properties `dcf4adeea6` established, still present.
  assert.match(fn[1], /Math\.abs\(bz\)/, 'the z half-extent is no longer measured about the pivot');
  assert.match(fn[1], /Math\.abs\(az\)/, 'a model built downward from the origin is no longer framed');
});

/* ════════════════════════════════════════════════════════════════════════════
   3. The two zoom clamps stay different — CNC is machine-sized, CAD is not
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠ `cad-camera-parity.test.ts` already asserts the two clamps differ. What THIS
 * asserts is the thing that change could have introduced: a SECOND clamp, on the
 * frustum rather than on the radius. A frustum clamp would be a second zoom
 * limit that the tab-specific radius clamps do not know about — and it would
 * apply the same numbers to both tabs, which is exactly the collapse the clamps
 * exist to prevent.
 */
test('the projection code introduces no second zoom limit', () => {
  for (const [name, src] of [
    ['Viewport.tsx', cncCode],
    ['cad/preview.tsx', cadCode],
  ] as const) {
    const fn = /const applyProjection = \(\) => \{([\s\S]*?)\n    \};/.exec(src);
    assert.ok(fn, `${name}: applyProjection not found — blind, not green`);
    /* ⚠ THE NEEDLE IS ANCHORED TO `radius`, AND THE FIRST CUT WAS NOT. It read
     * `Math.min(<digit>|Math.max(<digit>` and matched `Math.max(1, viewH)` — the
     * ASPECT floor, which exists so a zero-height canvas cannot produce an
     * infinite frustum and has nothing to do with zoom. A needle that fires on
     * the guard beside the subject is a false red, and a false red is what gets
     * an assertion deleted rather than narrowed. What must not appear is a clamp
     * on the orbit distance. */
    assert.doesNotMatch(
      fn[1],
      /Math\.(min|max)\([^)]*radius/,
      `${name}: applyProjection clamps the orbit distance, so there is a zoom limit outside the wheel`,
    );
  }
  /* And the frustum builder itself clamps nothing but the degenerate cases. */
  assert.equal(orthoFrustum(9000, 1.5).top, orthoHalfHeight(9000));
  assert.equal(orthoFrustum(200000, 1).top, orthoHalfHeight(200000));
  assert.equal(orthoFrustum(1, 1).top, orthoHalfHeight(1));
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The corner gizmo has its own camera and the main mode must not reach it
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE GIZMO IS SCREEN-FIXED AND FIXED-SCALE BY DESIGN (`fbfe2738f1`). It has
 * its own scene, its own `OrthographicCamera` built from CONSTANTS, and its own
 * scissor box. If the main camera's mode ever reached it, the one instrument
 * whose size never moves would start moving.
 *
 * ⚠ The failure would be invisible from every other angle: the gizmo would still
 * draw, still rotate, still be un-occluded, and simply be the wrong size.
 */
test('the corner gizmo is removed; orientation is via the pivot triad at orbit centre', () => {
  // The corner gizmo was removed in favour of the pivot triad at the orbit
  // centre — matching the CNC viewport's triad at the machine origin.
  assert.ok(!cadCode.includes('gizmoCamera'), 'the corner gizmo camera is still present');
  assert.ok(!cadCode.includes('renderer.setScissor('), 'the corner gizmo scissor box is still rendered');
});

/* ════════════════════════════════════════════════════════════════════════════
   5. The rulers still rebuild on the decade, not on the frame
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 IN ORTHO, "ZOOM" IS A FRUSTUM WIDTH RATHER THAN A DISTANCE — which is
 * exactly why the ruler could have frozen or started rebuilding every frame. It
 * does neither, because there is only ONE zoom scalar: `rulerSignature` is fed
 * `radius` in both modes, and `radius` means the same on-screen scale in both by
 * the invariant in §2.
 *
 * ⚠ THE DEFECT THIS GUARDS IS THE ONE `dcf4adeea6` ALREADY FIXED ONCE — a
 * rebuild key that is a function of a CONTINUOUS quantity rebuilds a
 * `BufferGeometry` and a `CanvasTexture` per number, per frame.
 */
test('the ruler is still keyed on the orbit distance, not on a frustum extent', () => {
  const call = /const want = `\$\{rulerSignature\(([^)]*)\)\}/.exec(cadCode);
  assert.ok(call, 'the ruler rebuild key moved — blind, not green');
  assert.equal(
    call[1].split(',')[0].trim(),
    'radius',
    'the ruler is keyed on something other than the orbit distance, so the decade has changed meaning',
  );
  assert.doesNotMatch(
    call[1],
    /ortho|frustum|projection/i,
    'the ruler key now depends on the projection',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   6. The frustum itself
   ════════════════════════════════════════════════════════════════════════════ */

test('the frustum is symmetric, aspect-corrected, and centred on the target', () => {
  const f = orthoFrustum(1000, 16 / 9);
  assert.equal(f.right, -f.left);
  assert.equal(f.top, -f.bottom);
  assert.ok(Math.abs(f.right / f.top - 16 / 9) < 1e-12, 'the frustum is not aspect-corrected');
});

/**
 * 🔴 THE NEAR PLANE IS NEGATIVE, WHICH IS OPENSCAD'S (`GLView.cc:136`,
 * `glOrtho(..., -100*dist, +100*dist)`). A positive near plane — the reflex, by
 * analogy with the perspective camera — slices the front off the model, and a
 * part with its near face missing is the picture an operator must not be shown
 * while judging whether a cutter clears a hold-down.
 */
test('nothing between the eye and the target can be clipped', () => {
  for (const r of [120, 1400, 9000, 200000]) {
    const f = orthoFrustum(r, 1);
    assert.ok(f.near < 0, `near plane is not behind the eye at radius ${r}`);
    assert.equal(f.far, -f.near, 'the depth range is no longer symmetric about the eye');
    assert.equal(f.far, ORTHO_DEPTH_REACH * r);
    /* The eye sits `r` from the target, so the target plane is well inside. */
    assert.ok(f.far > r, 'the target itself would be clipped');
  }
});

test('a degenerate canvas or radius produces a buildable frustum rather than infinities', () => {
  for (const f of [orthoFrustum(0, 1), orthoFrustum(-5, 1), orthoFrustum(NaN, NaN), orthoFrustum(100, 0)]) {
    for (const v of Object.values(f)) assert.ok(Number.isFinite(v) && v !== 0);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   7. The pan step is one expression for both modes
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 `camera.fov` DOES NOT EXIST ON AN `OrthographicCamera`. Both pan handlers
 * read it until this change, so the first pan after a switch would have produced
 * `NaN` — and a `NaN` written into `target` corrupts the camera with nothing on
 * screen to say why. The replacement is the same number in perspective.
 */
test('neither pan handler reads fov off the camera any more', () => {
  for (const [name, src] of [
    ['Viewport.tsx', cncCode],
    ['cad/preview.tsx', cadCode],
  ] as const) {
    assert.match(src, /const k = worldPerPixel\(radius, viewH\);/, `${name}: the pan step is not the shared one`);
    assert.doesNotMatch(src, /camera\.fov/, `${name}: still reads fov off a camera that may not have one`);
  }
});

test('the shared pan step is unchanged from what the perspective camera gave', () => {
  for (const [r, h] of [
    [1400, 700],
    [200, 360],
    [9000, 1080],
  ]) {
    const was = (2 * Math.tan((45 * Math.PI) / 360) * r) / Math.max(1, h);
    assert.ok(Math.abs(worldPerPixel(r, h) - was) < 1e-12, `the pan step changed at radius ${r}`);
  }
  // The floor on the canvas height survives, so a zero-height canvas cannot
  // divide by zero and fling the target to infinity.
  assert.ok(Number.isFinite(worldPerPixel(1000, 0)));
});

/* ════════════════════════════════════════════════════════════════════════════
   8. Both canvases construct both cameras, at one fov
   ════════════════════════════════════════════════════════════════════════════ */

test('both viewports build both cameras and select between them', () => {
  for (const [name, src] of [
    ['Viewport.tsx', cncCode],
    ['cad/preview.tsx', cadCode],
  ] as const) {
    assert.match(
      src,
      /const perspectiveCamera = new THREE\.PerspectiveCamera\(CAMERA_FOV_DEG,/,
      `${name}: the perspective camera no longer takes the shared fov, so the pan step and the ortho frustum can describe different frustums`,
    );
    assert.match(src, /const orthographicCamera = new THREE\.OrthographicCamera\(/, `${name}: no ortho camera`);
    assert.match(
      src,
      /let camera: THREE\.PerspectiveCamera \| THREE\.OrthographicCamera = perspectiveCamera;/,
      `${name}: the camera binding is not reassignable, so a switch cannot move the raycaster with it`,
    );
    // Exactly one construction of each — a second would be a camera nothing renders.
    assert.equal((src.match(/new THREE\.PerspectiveCamera\(/g) ?? []).length, 1, `${name}: two perspective cameras`);
  }
  assert.equal(CAMERA_FOV_DEG, 45, 'the fov changed; both tabs previously shipped 45');
});

/* ════════════════════════════════════════════════════════════════════════════
   9. The choice survives a reload, and only the two words are honoured
   ════════════════════════════════════════════════════════════════════════════ */

test('only the two words are accepted; everything else falls back to the default', () => {
  assert.equal(readProjection('perspective', 'orthographic'), 'perspective');
  assert.equal(readProjection('orthographic', 'perspective'), 'orthographic');
  for (const bad of [null, undefined, '', 'ortho', 'Perspective', true, false, 0, 1, {}, []]) {
    assert.equal(readProjection(bad, 'orthographic'), 'orthographic', `accepted ${JSON.stringify(bad)}`);
    assert.equal(readProjection(bad, 'perspective'), 'perspective', `accepted ${JSON.stringify(bad)}`);
  }
});

/**
 * 🔴 THE CHOICE IS PERSISTED IN EACH TAB'S OWN STORE, ALONGSIDE THE OTHER VIEW
 * TOGGLES — the CAD tab in `2bee.app.cad.layout` with the axes and the scale
 * markers, the CNC tab under its own key. Asserted at the code that reads and
 * writes it: a control that changes the view and is forgotten on reload is one
 * the founder reports as not working.
 */
test('each tab persists its projection where its other view settings live', () => {
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /const LAYOUT_KEY = '2bee\.app\.cad\.layout';/);
  assert.match(tab, /projection: readProjection\(v\.projection, DEFAULT_LAYOUT\.projection\)/);
  assert.match(tab, /projection: CAD_DEFAULT_PROJECTION,/);

  const app = source('App.tsx');
  /* The CNC half moved twice and both moves are the same fact stated at its new
   * address: the read/write pair is `panels/viewPersistence.ts` (`06c89b1ac7`),
   * and the seeding is the Zustand store's INITIAL STATE in
   * `store/cncStore.ts` — which runs at module load, before any paint, so the
   * lazy-initialiser property this test exists for is kept. */
  const persist = source('panels', 'viewPersistence.ts');
  assert.match(persist, /const CNC_PROJECTION_KEY = '2bee\.app\.cnc\.projection';/);
  assert.match(persist, /localStorage\.setItem\(CNC_PROJECTION_KEY, p\)/, 'the CNC choice is never written');
  assert.match(app, /rememberCncProjection\(/, 'App.tsx no longer writes the CNC choice at all');
  /* Seeded AT STORE CREATION from storage, not from the constant plus an
   * effect — the first frame on this tab is the one an operator glances at to
   * judge a fit, and a frame drawn in the wrong projection then corrected is
   * worse than a delay. */
  const store = source('store', 'cncStore.ts');
  assert.match(
    store,
    /projection: storedCncProjection\(\),/,
    'the CNC choice is not restored before first paint',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   10. The two tabs default differently, on purpose
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THIS ASSERTION EXISTS TO MAKE A TIDY-UP ARGUE WITH A RED TEST.
 *
 *   · CAD defaults PERSPECTIVE because that is OpenSCAD's (`Camera.h:29`, and an
 *     unset `view/orthogonalProjection` reads `false`), and this tab exists to be
 *     OpenSCAD-shaped.
 *   · CNC defaults ORTHOGRAPHIC because the operator is judging whether a part
 *     fits and whether a toolpath clears a hold-down, and perspective converges
 *     parallel edges — a part that fits can be made to look like it overhangs.
 *
 * Making them match for tidiness means either giving the CAD tab a non-OpenSCAD
 * default or giving the CNC tab a projection that misleads about fit.
 */
test('the CNC tab and the CAD tab default to different projections, and that is deliberate', () => {
  assert.equal(CAD_DEFAULT_PROJECTION, 'perspective', 'the CAD tab no longer matches OpenSCAD');
  assert.equal(CNC_DEFAULT_PROJECTION, 'orthographic', 'the CNC tab now defaults to a view that misleads about fit');
  assert.notEqual(CAD_DEFAULT_PROJECTION, CNC_DEFAULT_PROJECTION);
  /* And the reason travels with the constant, because this is the third time in
   * this tree a stated divergence has looked like an inconsistency to somebody. */
  const mod = source('projection.ts');
  assert.match(mod, /parallel edges converge/i);
  assert.match(mod, /Camera\.h:29/);
});

/**
 * ⚠ AND THE OPERATOR IS TOLD, ON SCREEN, WHILE PERSPECTIVE IS SELECTED. A
 * tooltip is something you find after you already believe the picture.
 */
test('the CNC tab says on screen that perspective is not the view to measure from', () => {
  const app = source('App.tsx');
  assert.match(app, /data-testid="projection-warning"/);
  /* ⚠ THE ELEMENT CHANGED WHEN THE CONTROL MOVED — TODO #108. The warning was a
   * `<p>` inside the sidebar `Projection` panel; it is now a `<span>` in a strip
   * at the top of the tab, because the control it belonged to became two menu
   * items and a menu note is visible only while the menu is open. The needle is
   * widened to either element rather than deleted: what this test is for is the
   * SENTENCE being on screen and conditional, not the tag it is in. */
  const warn = /data-testid="projection-warning"[\s\S]{0,600}?<\/(p|span)>/.exec(app);
  assert.ok(warn, 'the warning moved — blind, not green');
  assert.match(warn[0], /converges parallel edges/i);
  assert.match(warn[0], /can look clear/i);
  /* It is conditional on the mode, not always on — a warning shown while it is
   * untrue is one the operator learns to ignore. */
  assert.match(app, /projection === 'perspective' \? \(/);
});

/* ════════════════════════════════════════════════════════════════════════════
   11. Pan basis — the sign flip that fought the mouse
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE DEFECT: the old code used `(cosθ, sinθ)` as screen-right. That is
 * the NEGATIVE of screen-up-on-the-bed — right and up were swapped — so the
 * two axes disagreed about sign and the pan fought the mouse. Its vertical
 * term was also `* 0` on x and `* -1` on y: half the basis vector,
 * sign-corrected by hand. The fix derives both from three.js's own `lookAt`
 * basis.
 *
 * The derivation, from `up = +Z` and `z = eye − target`:
 *   screen right = x = up × z = (−sinθ, cosθ, 0)          ← horizontal
 *   screen up    = y = z  × x = (−cosφ·cosθ, −cosφ·sinθ, sinφ)
 *   screen up projected onto bed = −sign(cosφ) · (cosθ, sinθ)
 *
 * These tests are source-text: the pan lives inside a `useEffect` closure and
 * is not an exported function. A rewrite that re-flips the sign would have to
 * rewrite the trig to pass these.
 */
test('pan screen-right is (−sinθ, cosθ), not the old (cosθ, sinθ)', () => {
  const code = cncCode;
  // The right-vector derivation must use −sin for X and cos for Y.
  assert.match(code, /rightX\s*=\s*-Math\.sin\s*\(\s*theta\s*\)/,
    'pan rightX is not −sin(θ) — the sign flip that fought the mouse is back');
  assert.match(code, /rightY\s*=\s*Math\.cos\s*\(\s*theta\s*\)/,
    'pan rightY is not cos(θ) — right and up are swapped again');
  // The OLD bug: these would be cos/sin instead of −sin/cos.
  assert.doesNotMatch(code, /rightX\s*=\s*Math\.cos\s*\(\s*theta\s*\)/,
    'pan rightX is cos(θ) — the old bug, right and up swapped');
  assert.doesNotMatch(code, /rightY\s*=\s*Math\.sin\s*\(\s*theta\s*\)/,
    'pan rightY is sin(θ) — the old bug, right and up swapped');
});

test('pan screen-up uses −sign(cosφ) to flip below the bed', () => {
  const code = cncCode;
  // The up-on-bed vector must carry the sign of cos(φ), negated.
  assert.match(code, /upX\s*=\s*-Math\.sign\s*\(\s*cz\s*\)\s*\*\s*Math\.cos\s*\(\s*theta\s*\)/,
    'pan upX does not carry −sign(cosφ)·cosθ');
  assert.match(code, /upY\s*=\s*-Math\.sign\s*\(\s*cz\s*\)\s*\*\s*Math\.sin\s*\(\s*theta\s*\)/,
    'pan upY does not carry −sign(cosφ)·sinθ');
  // `cz` must be cos(φ), not a hardcoded constant.
  assert.match(code, /cz\s*=\s*Math\.cos\s*\(\s*phi\s*\)/,
    'the tilt factor cz is not cos(φ) — a hardcoded 1 would skip the flip');
});

/* ════════════════════════════════════════════════════════════════════════════
   12. It is drawing only
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE PROJECTION MAY NOT REACH THE PROGRAM. It is a camera setting, exactly
 * like `layers`: not an input to `plan()`, not exported, not in the G-code. This
 * lane's standing rule is to assert on the emitted program rather than on the
 * setting — the cheap structural half of that is that the word never appears in
 * the planning path at all.
 */
test('the projection is not an input to the plan', () => {
  const app = source('App.tsx');
  /* `sceneDeps` is the viewport's scene-rebuild key. The projection is NOT in it:
   * it changes the camera, not the scene, and putting it there would rebuild
   * every mesh in the scene on a view toggle. */
  const deps = /function sceneDeps\(p: ViewportProps\)[\s\S]*?\n\}/.exec(cnc);
  assert.ok(deps, 'sceneDeps moved — blind, not green');
  assert.doesNotMatch(deps[0], /projection/, 'a view toggle now rebuilds the whole scene');

  /* And it is not gathered into anything the core is called with. */
  for (const m of app.matchAll(/projection/g)) {
    const line = app.slice(app.lastIndexOf('\n', m.index) + 1, app.indexOf('\n', m.index));
    assert.doesNotMatch(
      line,
      /\bplan\(|config|job\.|toCore|postConfig/,
      `the projection reached the planning path: ${line.trim()}`,
    );
  }
});
