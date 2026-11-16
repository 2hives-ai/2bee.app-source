// ZOOM TOWARD THE POINTER — asserted on what an operator would SEE.
//
// 🔴 THE PROPERTY, NOT THE FORMULA. The only thing that matters about this
// function is that the world point under the cursor stays under the cursor. A
// test that re-derived the algebra would agree with the implementation by
// construction and would still pass if both were rotated 90°, which is exactly
// how a viewport ends up "fighting you" with every unit test green.
//
// So the checks below SIMULATE the screen: project a world point through the
// same basis the viewport uses, zoom, apply the shift, project again, and
// require the pixel position to be unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldPerPixel, zoomTowardCursor } from '../src/projection.ts';

/**
 * Where a world XY point lands on screen, relative to the centre, under the
 * viewport's own basis. ⚠ Deliberately the SAME projection the pan uses —
 * including `fore` — because that is the mapping this function has to invert;
 * a "more correct" projection here would test a viewport we do not have.
 */
function toScreen(
  p: { x: number; y: number },
  c: { x: number; y: number },
  radius: number,
  viewH: number,
  theta: number,
  phi: number,
): { x: number; y: number } {
  const k = worldPerPixel(radius, viewH);
  const rightX = -Math.sin(theta);
  const rightY = Math.cos(theta);
  const cz = Math.cos(phi);
  const upX = -Math.sign(cz) * Math.cos(theta);
  const upY = -Math.sign(cz) * Math.sin(theta);
  const fore = 1 / Math.max(0.2, Math.abs(cz));
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  // Invert the 2×2 basis [right, up*fore] to get pixel offsets.
  const a = rightX;
  const b = upX * fore;
  const cc = rightY;
  const d = upY * fore;
  const det = a * d - b * cc;
  const px = (d * dx - b * dy) / det / k;
  const py = (-cc * dx + a * dy) / det / k;
  // `py` came out along screen-UP; the caller's convention is screen-DOWN.
  return { x: px, y: -py };
}

const CAMERAS = [
  { name: 'the opening iso view', theta: -Math.PI / 4, phi: Math.PI / 3.2 },
  { name: 'front', theta: -Math.PI / 2, phi: Math.PI / 2 },
  { name: 'near the top pole', theta: 0.3, phi: 0.12 },
  { name: 'below the model', theta: 1.1, phi: Math.PI - 0.3 },
];

for (const cam of CAMERAS) {
  for (const [dir, factor] of [['in', 0.9], ['out', 1.12]] as const) {
    test(`the point under the cursor stays there — ${cam.name}, zooming ${dir}`, () => {
      const viewH = 400;
      const before = 250;
      const after = before * factor;
      const centre = { x: 12, y: -7 };
      // A pointer well off-centre: the whole effect is zero at the centre, so a
      // test that sampled the middle would pass on a function that does nothing.
      const offsetX = 137;
      const offsetY = -84;

      // The world point that is under the cursor BEFORE the zoom.
      const k = worldPerPixel(before, viewH);
      const rightX = -Math.sin(cam.theta);
      const rightY = Math.cos(cam.theta);
      const cz = Math.cos(cam.phi);
      const upX = -Math.sign(cz) * Math.cos(cam.theta);
      const upY = -Math.sign(cz) * Math.sin(cam.theta);
      const fore = 1 / Math.max(0.2, Math.abs(cz));
      const world = {
        x: centre.x + offsetX * k * rightX - offsetY * k * fore * upX,
        y: centre.y + offsetX * k * rightY - offsetY * k * fore * upY,
      };

      // Sanity: the harness agrees with itself before anything is zoomed. If
      // this fails the test is measuring its own projection, not the function.
      const s0 = toScreen(world, centre, before, viewH, cam.theta, cam.phi);
      assert.ok(Math.abs(s0.x - offsetX) < 1e-6 && Math.abs(s0.y - offsetY) < 1e-6, `harness disagrees with itself: ${JSON.stringify(s0)}`);

      const shift = zoomTowardCursor({ offsetX, offsetY, viewH, before, after, theta: cam.theta, phi: cam.phi });
      const moved = { x: centre.x + shift.x, y: centre.y + shift.y };
      const s1 = toScreen(world, moved, after, viewH, cam.theta, cam.phi);

      assert.ok(
        Math.abs(s1.x - offsetX) < 1e-6 && Math.abs(s1.y - offsetY) < 1e-6,
        `the point moved on screen: was (${offsetX}, ${offsetY}), now (${s1.x.toFixed(3)}, ${s1.y.toFixed(3)})`,
      );
    });
  }
}

test('a cursor exactly at the centre moves nothing', () => {
  const z = zoomTowardCursor({ offsetX: 0, offsetY: 0, viewH: 400, before: 200, after: 180, theta: 0.4, phi: 1.1 });
  assert.equal(z.x, 0);
  assert.equal(z.y, 0);
});

test('zooming IN pulls the centre toward the cursor, and OUT pushes it away', () => {
  // 🔴 THE DIRECTION, STATED AS A DIRECTION. The round-trip tests above would
  // pass on a function with both signs flipped IF the projection were flipped
  // to match. This one is independent of the harness.
  const base = { offsetX: 100, offsetY: 0, viewH: 400, theta: 0, phi: Math.PI / 2 };
  const zin = zoomTowardCursor({ ...base, before: 200, after: 180 });
  const zout = zoomTowardCursor({ ...base, before: 200, after: 224 });
  // theta = 0 ⇒ screen-right is +Y in world.
  assert.ok(zin.y > 0, 'zooming in must move the centre toward a cursor on the right');
  assert.ok(zout.y < 0, 'zooming out must move the centre away from it');
});

test('a degenerate camera moves nothing rather than producing NaN', () => {
  // 🔴 `target` IS THE ORBIT CENTRE. A `NaN` here is a black screen with nothing
  // on it to say why — the same failure the pan had when it read `camera.fov` in
  // orthographic. Refusing to move is the only safe answer.
  for (const bad of [
    { before: 0, after: 10 },
    { before: -5, after: 10 },
    { before: 10, after: Number.NaN },
  ]) {
    const z = zoomTowardCursor({ offsetX: 50, offsetY: 50, viewH: 400, theta: 0.5, phi: 1.2, ...bad });
    assert.equal(z.x, 0, `before=${bad.before} after=${bad.after} moved x`);
    assert.equal(z.y, 0, `before=${bad.before} after=${bad.after} moved y`);
  }
  const tiny = zoomTowardCursor({ offsetX: 50, offsetY: 50, viewH: 0, before: 10, after: 9, theta: 0.5, phi: 1.2 });
  assert.equal(tiny.x, 0, 'a zero-height viewport must not move the centre');
});

test('the shift scales with how far the wheel actually moved', () => {
  const base = { offsetX: 90, offsetY: 30, viewH: 400, theta: 0.7, phi: 1.0, before: 300 };
  const one = zoomTowardCursor({ ...base, after: 300 * 0.9 });
  const two = zoomTowardCursor({ ...base, after: 300 * 0.9 * 0.9 });
  assert.ok(Math.hypot(two.x, two.y) > Math.hypot(one.x, one.y), 'two notches must move the centre further than one');
  // And a notch that changes nothing must move nothing — the identity case that
  // a `1 - after/before` formula gets right and a hard-coded step does not.
  const none = zoomTowardCursor({ ...base, after: 300 });
  assert.equal(none.x, 0);
  assert.equal(none.y, 0);
});
