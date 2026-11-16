// 2026-11-12: the pot saucer printed as visible flats. The STL sent to the 3d tab was built with `$preview` TRUE,
// so `$fn = $preview ? 48 : 160` gave 48 segments (9.15 mm flats, 0.15 mm off the circle), and a source with no
// `$fn` at all got OpenSCAD's coarse `$fa = 12` / `$fs = 2` (30 flats on a 140 mm rim). `ScadOptions.render` is the
// print path: `$preview` false and fine `$fa`/`$fs` at the root. The viewer (render absent) is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad, PRINT_FA, PRINT_FS } from '../src/cad/scad';
import { meshScene } from '../src/cad/mesh';

/** Distinct angles of the vertices on the outermost radius. */
function rimSegments(src: string, render: boolean | undefined): number {
  const m = meshScene(parseScad(src, render === undefined ? {} : { render }).scene);
  let rmax = 0;
  for (const p of m.parts) for (let i = 0; i < p.positions.length; i += 3) rmax = Math.max(rmax, Math.hypot(p.positions[i], p.positions[i + 1]));
  const angles = new Set<number>();
  for (const p of m.parts) for (let i = 0; i < p.positions.length; i += 3) {
    if (Math.abs(Math.hypot(p.positions[i], p.positions[i + 1]) - rmax) < 1e-3) angles.add(Math.round(Math.atan2(p.positions[i + 1], p.positions[i]) * 1e3));
  }
  return angles.size;
}

test('$preview is false for a print and true otherwise', () => {
  const src = 'if ($preview) cube(1); else cube(10);';
  const size = (o: { render?: boolean }) => { const m = meshScene(parseScad(src, o).scene); let mx = 0; for (const p of m.parts) for (const v of p.positions) mx = Math.max(mx, v); return mx; };
  assert.equal(size({}), 1, 'the viewer keeps preview semantics');
  assert.equal(size({ render: true }), 10, 'a print is a render');
});

test('a source that picks $fn by $preview gets its render value', () => {
  const src = '$fn = $preview ? 48 : 160; cylinder(d = 140, h = 5);';
  assert.equal(rimSegments(src, undefined), 48);
  assert.equal(rimSegments(src, true), 160);
});

test('a source with no $fn gets the print defaults, not 30 flats', () => {
  const src = 'cylinder(d = 140, h = 5);';
  assert.equal(rimSegments(src, undefined), 30, 'OpenSCAD default $fa=12 on a big circle');
  assert.equal(rimSegments(src, true), Math.ceil(360 / PRINT_FA));
  assert.ok(PRINT_FS > 0 && PRINT_FS <= 0.5);
});

test("a source's own $fa/$fs/$fn still wins in a print", () => {
  assert.equal(rimSegments('$fa = 12; $fs = 2; cylinder(d = 140, h = 5);', true), 30);
  assert.equal(rimSegments('cylinder(d = 140, h = 5, $fn = 6);', true), 6);
});
