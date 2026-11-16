// THE CORNER GIZMO'S GEOMETRY, AND THE ONE NUMBER IT SHARES WITH THE VIEWPORT.
//
// 🔴 THE ASSERTIONS ARE ON DIRECTIONS A HUMAN CAN CHECK, not on the algebra
// being self-consistent. `gizmoAxes` could return a beautifully orthogonal
// basis that is rotated 90° from the picture and every internal-consistency
// test would pass — which is the whole class of "the gizmo points the wrong way
// and nothing notices". So each case names a camera position and asserts where
// an axis has to APPEAR from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gizmoAxes,
  NAMED_VIEWS,
  POLE_EPS,
  viewForAxis,
  viewTitle,
  type GizmoAxis,
} from '../src/cad/gizmo.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

function pick(axes: GizmoAxis[], axis: 'x' | 'y' | 'z', sign: 1 | -1): GizmoAxis {
  const a = axes.find((c) => c.axis === axis && c.sign === sign);
  assert.ok(a, `no ${sign === 1 ? '+' : '-'}${axis} end`);
  return a;
}

const near = (got: number, want: number, what: string, tol = 1e-6) =>
  assert.ok(Math.abs(got - want) < tol, `${what}: ${got} is not ~${want}`);

test('from the FRONT, +Z is up and +Y points away from the viewer', () => {
  const axes = gizmoAxes(NAMED_VIEWS.front);
  const z = pick(axes, 'z', 1);
  near(z.x, 0, '+Z x');
  near(z.y, 1, '+Z y (screen-up)');
  near(z.depth, 0, '+Z depth');

  // Front = looking along +Y, so +Y goes INTO the screen. A gizmo that had this
  // backwards would be exactly 180° wrong and still look plausible.
  const y = pick(axes, 'y', 1);
  assert.ok(y.depth < -0.99, `+Y must point away from the viewer, got depth ${y.depth}`);

  // ...and +X to the right, which is what makes it a right-handed picture.
  const x = pick(axes, 'x', 1);
  near(x.x, 1, '+X x');
  assert.ok(Math.abs(x.depth) < 1e-6, '+X must be edge-on from the front');
});

test('from the RIGHT, +X faces the viewer and +Y goes right', () => {
  const axes = gizmoAxes(NAMED_VIEWS.right);
  assert.ok(pick(axes, 'x', 1).depth > 0.99, '+X must face the viewer');
  near(pick(axes, 'y', 1).x, 1, '+Y x');
  near(pick(axes, 'z', 1).y, 1, '+Z y');
});

test('from the TOP, +Z faces the viewer and the picture does not collapse', () => {
  const axes = gizmoAxes(NAMED_VIEWS.top);
  const z = pick(axes, 'z', 1);
  assert.ok(z.depth > 0.999, `+Z must face the viewer from the top, got ${z.depth}`);

  // 🔴 THE POLE IS WHERE A NAIVE BASIS DIVIDES BY ZERO. Every coordinate must be
  // finite, and X and Y must still be distinguishable — a top view in which both
  // in-plane axes collapsed onto one point is a gizmo that has stopped working
  // in precisely the view most likely to be asked for.
  for (const a of axes) {
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.depth), `${a.axis}${a.sign} is not finite`);
  }
  const x = pick(axes, 'x', 1);
  const y = pick(axes, 'y', 1);
  assert.ok(Math.hypot(x.x - y.x, x.y - y.y) > 1, 'X and Y must not coincide in the top view');
});

test('every end is a unit vector projected — length never exceeds 1', () => {
  for (let t = -Math.PI; t <= Math.PI; t += 0.37) {
    for (let p = 0.01; p < Math.PI; p += 0.29) {
      for (const a of gizmoAxes({ theta: t, phi: p })) {
        const r = Math.hypot(a.x, a.y);
        assert.ok(r <= 1 + 1e-9, `|(${a.x},${a.y})| = ${r} > 1 at theta=${t} phi=${p}`);
        // The projected length and the depth are two legs of the same unit
        // vector, so this also catches a basis that has quietly stopped being
        // orthonormal — the failure that makes a gizmo drift as you orbit.
        near(r * r + a.depth * a.depth, 1, `unit at theta=${t} phi=${p}`, 1e-9);
      }
    }
  }
});

test('the negative ends are the positive ones mirrored, and unlabelled', () => {
  const axes = gizmoAxes({ theta: 0.7, phi: 1.1 });
  for (const ax of ['x', 'y', 'z'] as const) {
    const p = pick(axes, ax, 1);
    const n = pick(axes, ax, -1);
    near(n.x, -p.x, `${ax} mirror x`);
    near(n.y, -p.y, `${ax} mirror y`);
    near(n.depth, -p.depth, `${ax} mirror depth`);
    assert.equal(p.label, ax.toUpperCase());
    assert.equal(n.label, '', 'the negative end carries no letter — six letters at 64px is a wall of text');
  }
});

test('top and bottom are NUDGED off the pole, not set to it', () => {
  // 🔴 A test that only asserted "phi is small" would pass on `phi = 0`, which
  // is the degenerate value this exists to avoid.
  assert.notEqual(NAMED_VIEWS.top.phi, 0);
  assert.equal(NAMED_VIEWS.top.phi, POLE_EPS);
  assert.notEqual(NAMED_VIEWS.bottom.phi, Math.PI);
  assert.equal(NAMED_VIEWS.bottom.phi, Math.PI - POLE_EPS);
  // Small enough to read as square-on: under a tenth of a degree.
  assert.ok((POLE_EPS * 180) / Math.PI < 0.1);
});

test('front/back and left/right are opposite, and each axis end maps to one view', () => {
  assert.equal(Math.abs(NAMED_VIEWS.front.theta - NAMED_VIEWS.back.theta), Math.PI);
  assert.equal(Math.abs(NAMED_VIEWS.left.theta - NAMED_VIEWS.right.theta), Math.PI);

  assert.equal(viewForAxis('x', 1), 'right');
  assert.equal(viewForAxis('x', -1), 'left');
  assert.equal(viewForAxis('y', -1), 'front');
  assert.equal(viewForAxis('y', 1), 'back');
  assert.equal(viewForAxis('z', 1), 'top');
  assert.equal(viewForAxis('z', -1), 'bottom');

  // Clicking an axis end must put the eye ON that axis: the view it names has
  // that end pointing straight at the viewer. This is the property that makes
  // the widget mean anything, and it ties the two tables together.
  for (const ax of ['x', 'y', 'z'] as const) {
    for (const sign of [1, -1] as const) {
      const v = viewForAxis(ax, sign);
      const end = pick(gizmoAxes(NAMED_VIEWS[v]), ax, sign);
      assert.ok(end.depth > 0.999, `clicking ${sign === 1 ? '+' : '-'}${ax} must look down it, got depth ${end.depth} via ${v}`);
    }
  }
});

test('every view has a sentence, and it does not restate the button', () => {
  for (const v of Object.keys(NAMED_VIEWS) as (keyof typeof NAMED_VIEWS)[]) {
    const t = viewTitle(v);
    assert.ok(t.length > 10, `${v} has no real title`);
  }
  // The one that most needs saying: the camera moves, not the model. An
  // operator who thinks a view button rotated the PART will read every
  // coordinate on the next screen wrong.
  assert.match(viewTitle('front'), /the camera moves, the model does not/);
});

test('`iso` IS the tab’s opening camera, read out of preview.tsx rather than restated', () => {
  /* 🔴 THE POINT OF READING THE SOURCE. `iso` and the viewport's initial
   * `theta`/`phi` are the same fact in two files. A test that hard-coded both
   * would go green while they drifted, and the symptom — "Home" moving the
   * camera on a freshly-opened tab — is one nobody would trace back to a
   * constant. */
  const src = readFileSync(join(WEB, 'src/cad/preview.tsx'), 'utf8');
  const theta = /let theta = (-?Math\.PI \/ [\d.]+);/.exec(src);
  const phi = /let phi = (Math\.PI \/ [\d.]+);/.exec(src);
  assert.ok(theta && phi, 'could not find the viewport’s initial theta/phi — this test has gone blind, which is not a pass');

  const evalPi = (s: string): number => {
    const m = /^(-?)Math\.PI \/ ([\d.]+)$/.exec(s);
    assert.ok(m, `unexpected form: ${s}`);
    return (m[1] === '-' ? -1 : 1) * (Math.PI / Number.parseFloat(m[2]));
  };
  near(NAMED_VIEWS.iso.theta, evalPi(theta[1]), 'iso theta matches the viewport');
  near(NAMED_VIEWS.iso.phi, evalPi(phi[1]), 'iso phi matches the viewport');
});
