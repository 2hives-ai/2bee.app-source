// A comprehension as ANY element of a vector literal (OpenSCAD allows it).
// Regression for sensor_pod_v3_enclosure_3d.scad:138 `max([0, for (t = ts) t[3]/2])`,
// which made six cut files unreadable (gate CAD1H, 2026-10-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

/** Evaluate `expr`, return the X size of `cube([expr, 1, 1])` — the value as the evaluator computed it. */
function x(prelude: string, expr: string): number {
  const r = parseScad(`${prelude}\ncube([${expr}, 1, 1]);`);
  assert.deepEqual(r.errors.map((e) => e.message), [], 'no parse/eval errors');
  const cube = (r.scene.children as { params?: { kind: string; size: number[] } }[]).find((c) => c.params?.kind === 'cube');
  assert.ok(cube, 'a cube was emitted');
  return cube!.params!.size[0];
}

test('the real line: max([0, for (t = ts) t[3]/2])', () => {
  assert.equal(x('ts = [[0,0,0,4],[0,0,0,6]];', 'max([0, for (t = ts) t[3]/2])'), 3);
  assert.equal(x('ts = [];', 'max([0, for (t = ts) t[3]/2])'), 0, 'empty generator leaves the plain element');
});

test('generator first then more elements, and in the middle, keep element order', () => {
  assert.equal(x('v = [for (i = [1:3]) i, 9];', 'len(v)'), 4);
  assert.equal(x('v = [for (i = [1:3]) i, 9];', 'v[3]'), 9);
  assert.equal(x('v = [7, for (i = [1:2]) i, 8];', 'len(v)'), 4);
  assert.equal(x('v = [7, for (i = [1:2]) i, 8];', 'v[2]'), 2);
});

test('a single comprehension, and if/else inside it, are unchanged', () => {
  assert.equal(x('v = [for (i = [0:4]) if (i % 2 == 0) i else -1];', 'len(v)'), 5);
  assert.equal(x('v = [for (i = [0:4]) if (i % 2 == 0) i else -1];', 'v[1]'), -1);
});
