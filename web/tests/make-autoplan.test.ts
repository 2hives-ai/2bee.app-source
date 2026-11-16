// The Make step's automatic plan inputs (src/make/autoPlan.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layFlat, jobFor, ownedToolIds, measuredOnlyTools, CLAMP_MARGIN_MM } from '../src/make/autoPlan.ts';

/** An axis-aligned box as 12 triangles. */
function box(sx: number, sy: number, sz: number) {
  const v = (x: number, y: number, z: number) => [x * sx, y * sy, z * sz];
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  const p = [
    ...q(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)), ...q(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)),
    ...q(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)), ...q(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)),
    ...q(v(1, 1, 0), v(0, 1, 0), v(0, 1, 1), v(1, 1, 1)), ...q(v(0, 1, 0), v(0, 0, 0), v(0, 0, 1), v(0, 1, 1)),
  ];
  return { positions: new Float32Array(p), triangles: 12 };
}

test('a panel modelled standing on edge is laid flat: thickness becomes Z', () => {
  const f = layFlat([box(19, 407, 80)])!;
  assert.equal(f.upAxis, 0);
  assert.deepEqual(f.size.map(Math.round), [407, 80, 19]);
  const zs = [...f.solids[0].positions].filter((_, i) => i % 3 === 2);
  assert.equal(Math.min(...zs), 0);
  assert.equal(Math.round(Math.max(...zs)), 19);
});

test('the clamp margin is in the mesh coordinates, not in a config offset', () => {
  const f = layFlat([box(100, 60, 18)], CLAMP_MARGIN_MM)!;
  const xs = [...f.solids[0].positions].filter((_, i) => i % 3 === 0);
  assert.equal(Math.min(...xs), CLAMP_MARGIN_MM);
  const j = jobFor(f, ['End Mill - Down-cut 6mm 2F']);
  assert.ok(j.ok);
  if (j.ok) {
    assert.equal(j.config.stock!.size_x_mm, 100 + 2 * CLAMP_MARGIN_MM);
    assert.equal(j.config.stock!.thickness_mm, 18);
    assert.equal(j.sectionZ, 9);
    assert.equal((j.config as Record<string, unknown>).drawing_offset, undefined);
    assert.equal((j.config as Record<string, unknown>).material, undefined, 'material is the operator\'s, never chosen here');
  }
});

test('no registered cutters: nothing is planned, and the reason says where to register', () => {
  const j = jobFor(layFlat([box(100, 60, 18)])!, []);
  assert.equal(j.ok, false);
  if (!j.ok) assert.match(j.why, /Tools/);
});

test('owned = registered tools whose id is in the core list, whatever `definition` says', () => {
  // Both registration doors write a LIST cutter with definition 'operator'.
  const doc = {
    entries: [
      { kind: 'tool', id: 'End Mill - Down-cut 6mm 2F', definition: 'operator' },
      { kind: 'tool', id: 'op-1', definition: 'operator', label: '3 mm flat, measured' },
      { kind: 'machine', id: 'End Mill - Down-cut 6mm 2F', definition: 'catalogue' },
    ],
  } as never;
  const lib = ['End Mill - Down-cut 6mm 2F', 'V-bit 90'];
  assert.deepEqual(ownedToolIds(doc, lib), ['End Mill - Down-cut 6mm 2F']);
  assert.deepEqual(measuredOnlyTools(doc, lib), ['3 mm flat, measured']);
  assert.deepEqual(ownedToolIds(null, lib), []);
});
