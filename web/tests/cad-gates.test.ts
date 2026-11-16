/** cad gates (src/cad/cadGates.ts): can it be cut / printed, and what blocks which button. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { meshScene } from '../src/cad/mesh.ts';
import { cadGates, cadMaySend } from '../src/cad/cadGates.ts';

const gatesOf = (src: string, printers?: { name: string; build: [number, number, number] }[]) => {
  const parse = parseScad(src);
  return cadGates({ parse, mesh: meshScene(parse.scene), building: false, printers });
};
const st = (g: ReturnType<typeof gatesOf>, id: string) => g.find((x) => x.id === id)!.state;
const X2D = [{ name: 'Bambu Lab X2D', build: [256, 256, 260] as [number, number, number] }];

test('a flat 18 mm panel: cuttable; too big for the X2D -> print FAIL, cnc still allowed', () => {
  const g = gatesOf('cube([400, 240, 18]);', X2D);
  assert.equal(st(g, 'cnc'), 'PASS');
  assert.equal(st(g, 'print'), 'FAIL');
  assert.equal(cadMaySend(g, 'cnc'), true);
  assert.equal(cadMaySend(g, '3d'), false);
});

test('a 60 mm block: not a flat part -> cnc FAIL; fits the X2D -> 3d allowed', () => {
  const g = gatesOf('cube([100, 80, 60]);', X2D);
  assert.equal(st(g, 'cnc'), 'FAIL');
  assert.equal(st(g, 'print'), 'PASS');
  assert.equal(cadMaySend(g, 'cnc'), false);
  assert.equal(cadMaySend(g, '3d'), true);
});

test('no printer declared: print PENDING, which does not block Open in 3d', () => {
  const g = gatesOf('cube([10, 10, 10]);');
  assert.equal(st(g, 'print'), 'PENDING');
  assert.equal(cadMaySend(g, '3d'), true);
});

test('a source error blocks both', () => {
  const g = gatesOf('cube([10, 10, 10]');
  assert.equal(st(g, 'parse'), 'FAIL');
  assert.equal(cadMaySend(g, 'cnc'), false);
  assert.equal(cadMaySend(g, '3d'), false);
});
