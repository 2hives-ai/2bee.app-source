// THE WIRING BETWEEN THE GESTURE AND THE MATHS — asserted on the source.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY THIS EXISTS, AND WHAT IT IS A SUBSTITUTE FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `tests/zoom-to-cursor.test.ts` proves the arithmetic: the world point under
// the pointer stays under the pointer. It cannot prove the handler PASSES THE
// POINTER — a call that sent the viewport centre instead satisfies every one of
// those tests and zooms to the middle of the screen forever. Same for the pivot:
// the raycast can be perfect and the listener never attached.
//
// 🟢 CORRECTED 2026-09-17 — THE E2E NOW RUNS, SO THIS FILE IS NO LONGER A
// SUBSTITUTE FOR NOTHING. `e2e/designs-multi-open.spec.ts` completed for the
// first time on this box: `8 passed (1.5m)`, including `the wheel zooms toward
// the pointer, not toward the middle` and `double-click re-centres on what is
// under the pointer, and says which`. ⚠ THE PARAGRAPH THIS REPLACES SAID THOSE
// TESTS HAD "never completed a run on this box" AND BLAMED A "~10-minute
// `webServer` build" — the run history was right for its date and the build
// figure was WRONG WHEN WRITTEN (measured: ~64 s against a 180 s cap; it came
// from timing a different command). Both are withdrawn. See TODO #166 / #168.
//
// KEEP THIS FILE ANYWAY, and not out of sentiment: the e2e is slow, needs a
// browser, and stopped running for four days without anything going red. These
// checks run in `node --test` in under a second, so the seam stays guarded on
// every ordinary run and the browser proves it on the runs that can afford one.
//
// ⚠ AND WHAT IT DOES **NOT** PROVE, said plainly so nobody reads it as the e2e:
// that a real wheel event reaches the handler, that `getBoundingClientRect`
// returns what the layout says, or that the listener survives a re-render. It
// proves the ARGUMENTS ARE THE POINTER'S and the listeners are registered and
// removed. A browser is still owed; this is not it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const preview = readFileSync(join(WEB, 'src/cad/preview.tsx'), 'utf8');
const viewport = readFileSync(join(WEB, 'src/Viewport.tsx'), 'utf8');

for (const [name, src] of [['cad/preview.tsx', preview], ['Viewport.tsx', viewport]] as const) {
  test(`${name}: the wheel passes the POINTER, not the viewport centre`, () => {
    /* 🔴 THE `e.clientX` IS THE WHOLE ASSERTION. A handler that computed the
     * offset from anything else — 0, the canvas centre, a stale coordinate —
     * would still call the right function with the right shape, and the zoom
     * would silently be the old zoom-to-middle. */
    assert.match(
      src,
      /offsetX:\s*e\.clientX\s*-\s*r\.left\s*-\s*r\.width\s*\/\s*2,/,
      'the horizontal offset is no longer measured from the pointer',
    );
    assert.match(
      src,
      /offsetY:\s*e\.clientY\s*-\s*r\.top\s*-\s*r\.height\s*\/\s*2,/,
      'the vertical offset is no longer measured from the pointer',
    );
    /* The rectangle must be read INSIDE the handler. A `rect` captured once at
     * setup is correct until the pane is resized or the dock is dragged, and
     * then it is wrong in a way that only shows up as the zoom drifting. */
    assert.match(src, /const r = dom\.getBoundingClientRect\(\);\s*\n\s*const z = zoomTowardCursor\(/, 'the viewport rectangle is not read at the moment of the wheel');
  });

  test(`${name}: the shift is applied to the orbit centre, on both axes`, () => {
    // A call whose result is computed and dropped is the defect that looks most
    // like working code: every unit test green, nothing moves.
    assert.match(src, /target\.x \+= z\.x;\s*\n\s*target\.y \+= z\.y;/, 'the zoom shift is computed and never applied');
  });

  test(`${name}: the radius still changes before the shift is computed`, () => {
    /* `before` is captured, THEN `radius` is reassigned, THEN the shift uses
     * both. Reversing those makes `after === before`, the factor `1 - after/
     * before` becomes 0, and zoom-to-cursor silently does nothing — with the
     * zoom itself still working, so nothing looks broken. */
    const beforeAt = src.indexOf('const before = radius;');
    const radiusAt = src.indexOf('radius = Math.min(', beforeAt);
    const shiftAt = src.indexOf('const z = zoomTowardCursor(', radiusAt);
    assert.ok(beforeAt > 0, 'the pre-zoom radius is no longer captured');
    assert.ok(radiusAt > beforeAt, 'the radius is reassigned before it is captured — the shift would be zero');
    assert.ok(shiftAt > radiusAt, 'the shift is computed before the radius moves — the shift would be zero');
  });
}

test('cad/preview.tsx: double-click is registered AND removed', () => {
  assert.match(preview, /dom\.addEventListener\('dblclick', recentre\);/, 'the re-centre gesture is not wired to anything');
  /* 🔴 THE REMOVAL IS NOT SYMMETRY FOR ITS OWN SAKE. This effect tears down a
   * WebGL renderer; a listener left on a detached canvas holds the whole closure
   * — scene, meshes, camera — alive. Every other listener in this file is
   * removed, and one that is not is the leak nobody looks for. */
  assert.match(preview, /dom\.removeEventListener\('dblclick', recentre\);/, 'the re-centre listener is never removed — it pins the renderer');
});

test('cad/preview.tsx: the re-centre moves the pivot ONLY', () => {
  const at = preview.indexOf('const recentre = (e: MouseEvent) => {');
  assert.ok(at > 0, 'the re-centre handler is gone — this test has gone blind, not green');
  const body = preview.slice(at, preview.indexOf('\n    const ctx =', at));
  assert.ok(body.length > 200, 'the re-centre handler body could not be sliced — blind, not green');

  // 🔴 IT MUST NOT TOUCH THE ANGLES OR THE ZOOM. A re-centre that also re-framed
  // is `Fit` wearing a different gesture, and this lane keeps those apart on
  // purpose: looking from above and looking at the whole model are two requests.
  for (const forbidden of ['radius =', 'theta =', 'phi ='] as const) {
    assert.ok(!body.includes(forbidden), `the re-centre writes \`${forbidden}\` — it has become a re-frame`);
  }
  assert.ok(body.includes('target.copy('), 'the re-centre never sets the pivot');
});

test('cad/preview.tsx: a miss is reported, not swallowed', () => {
  const at = preview.indexOf('const recentre = (e: MouseEvent) => {');
  const body = preview.slice(at, preview.indexOf('\n    const ctx =', at));
  /* Three outcomes — a part, the fallback plane, or nothing — and the DOM says
   * which. A control that sometimes does nothing and never says so teaches that
   * the app is unreliable, and a test that only checked "the pivot moved" would
   * pass on a raycast that never hits and falls through every single time. */
  assert.match(body, /data-pivot-from/, 'the re-centre no longer publishes which answer it used');
  for (const state of ["'part'", "'plane'", "'none'"]) {
    assert.ok(body.includes(state), `the ${state} outcome is gone — three states have collapsed into fewer`);
  }
  // Only the part meshes are pickable: re-centring on the triad that MARKS the
  // centre would be a gesture that reports success and does nothing.
  assert.match(body, /startsWith\('part:'\)/, 'the raycast is no longer restricted to the part meshes');
});
