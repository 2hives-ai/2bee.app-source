// ONE WORKPIECE THICKNESS FOR BOTH CNC SURFACES (e2e audit 2026-11-12, P0).
//
// The Hive cleat is `cube([reg_w=18, len, reg_h=14])`
// (hardware/cad/2bee_hive/hive_lid_cleats.scad). The three-step Make screen
// planned it on a 14 mm workpiece. Expert tools → Designs → Open in cnc planned
// the SAME design on the cnc tab's remembered thickness (cncStore default 18),
// and its material gate passed "Plywood, 18 mm". Measured from the emitted
// programs (same laid-flat STL, section z = 7, the core's `import`):
//   Make  thickness 14 → deepest G1 Z-14.000
//   cnc   thickness 18 → deepest G1 Z-18.000
// With Z0 on top of the 14 mm sheet the Make step asks for, the cnc program
// goes 4.0 mm into the spoilboard; on the 18 mm sheet the cnc gate names, the
// Make program leaves 4.0 mm uncut. Whether the cleat is cut from 14 or 18 mm
// stock is cad's/bom's call. This test only holds that both surfaces derive the
// thickness from ONE function (`workpieceFor`) and the cnc tab plans on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAMP_MARGIN_MM, flatStl, jobFor, layFlat, workpieceFor } from '../src/make/autoPlan.ts';
import { cncHandoffFor, recordStandsUp, takeHandoffWorkpiece, workpieceOfRecord } from '../src/shop/toCnc.ts';
import { mineCnc, toMineItem } from '../src/shop/mine.ts';
import { useCncStore } from '../src/store/cncStore.ts';

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

const TOOL = ['End Mill - Down-cut 6mm 2F'];
const cleat = () => box(18, 369, 14);
/** A saved record as the design worker writes it: the solids LAID FLAT, no margin. */
const recordOf = (solid: ReturnType<typeof box>) => {
  const f = layFlat([solid])!;
  return {
    bytes: flatStl(f, 'Hive cleat'),
    format: 'stl' as const,
    name: 'Hive cleat',
    cad: { kind: '2bee.cad model', complete: true, unsupported: [], issues: [], mid_height_z_mm: f.size[2] / 2, source: 'cube(1);' },
  } as never;
};
const record = recordOf(cleat());

test('the cleat is a 14 mm workpiece, and the Make plan is planned on exactly that', () => {
  const flat = layFlat([cleat()], CLAMP_MARGIN_MM)!;
  const wp = workpieceFor(flat);
  assert.deepEqual(wp, { x: 18 + 2 * CLAMP_MARGIN_MM, y: 369 + 2 * CLAMP_MARGIN_MM, t: 14 });
  const j = jobFor(flat, TOOL);
  assert.ok(j.ok);
  if (j.ok) {
    assert.equal(j.config.stock!.thickness_mm, wp!.t);
    assert.equal(j.config.stock!.size_x_mm, wp!.x);
    assert.equal(j.config.stock!.size_y_mm, wp!.y);
    assert.equal(j.sectionZ, wp!.t / 2);
  }
});

test('Open in cnc carries the SAME workpiece the Make step plans on, read off the bytes it cuts', () => {
  const h = cncHandoffFor('Hive cleat', record);
  assert.ok(h.ok, h.ok ? '' : h.why);
  if (h.ok) {
    assert.deepEqual(h.cnc.workpiece, workpieceFor(layFlat([cleat()], CLAMP_MARGIN_MM)!));
    assert.match(h.cnc.note, /14 mm thick workpiece/, 'the note names the thickness the cnc tab will plan on');
  }
});

test('the cnc tab plans on the handed-over thickness, not its remembered 18 mm', () => {
  useCncStore.setState({ thickness: 18 });
  const h = cncHandoffFor('Hive cleat', record);
  assert.ok(h.ok);
  if (h.ok) takeHandoffWorkpiece(h.cnc);
  assert.equal(useCncStore.getState().thickness, 14);
});

test('My designs → Open in cnc carries it too; a plain drawing says the tab\'s thickness stands', () => {
  const cad = mineCnc(toMineItem({ name: 'Hive cleat', saved_at: 1, data: record }));
  assert.equal(cad.workpiece?.t, 14);
  const dxf = mineCnc(toMineItem({ name: 'plate', saved_at: 1, data: { bytes: new Uint8Array(), format: 'dxf', name: 'plate' } }));
  assert.equal(dxf.workpiece, undefined);
  assert.match(dxf.note, /thickness stands/);
});

test('a record saved AS MODELLED (on edge) is planned on its thinnest side and is flagged to be laid flat (bughunt 2026-11-13)', () => {
  // 2bee.cad's own Save stores the model as modelled: the Hive box panel stands 19 x 407 x 80, Z = 80.
  const panel = box(19, 407, 80);
  const asModelled = { bytes: flatStl({ solids: [panel], size: [19, 407, 80], upAxis: 2 }, 'panel'), format: 'stl', name: 'panel' } as never;
  assert.equal(recordStandsUp(asModelled), true, 'the cnc tab would section it through its edge');
  assert.deepEqual(workpieceOfRecord(asModelled), workpieceFor(layFlat([panel], CLAMP_MARGIN_MM)!), 'same workpiece as the Make step');
  assert.equal(workpieceOfRecord(asModelled)?.t, 19);
  assert.equal(recordStandsUp(record), false, 'a laid-flat record goes straight to cnc');
  // A cube ties on every axis: Z wins the tie, so a flat record keeps its footprint.
  assert.equal(recordStandsUp(recordOf(box(10, 10, 10))), false);
});

test('no thickness: the hand-off REFUSES instead of letting the remembered thickness stand', () => {
  const empty = { ...(record as object), bytes: new Uint8Array(84) } as never;
  assert.equal(cncHandoffFor('x', empty).ok, false);
  assert.equal(workpieceFor({ size: [10, 10, 0] }), null);
});

test('App takes the workpiece where it takes the cnc hand-off (wiring)', () => {
  const src = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const at = src.indexOf('const name = pendingCnc.cnc.drawingName;');
  assert.ok(at > 0, 'the cnc hand-off effect was not found');
  const effect = src.slice(at, src.indexOf('}, [pendingCnc', at));
  assert.match(effect, /takeHandoffWorkpiece\(pendingCnc\.cnc\)/, 'the hand-off effect must set the thickness from the hand-off');
});

test('the design worker lays flat the SAME solids the Make step does', () => {
  const src = readFileSync(new URL('../src/shop/viewer.worker.ts', import.meta.url), 'utf8');
  assert.match(src, /const solids = cutSolids\(m\.parts\);\s*const f = layFlat\(solids\)/, 'viewer.worker must lay flat cutSolids(parts), as MakeFlow and cncjob/plan do');
});
