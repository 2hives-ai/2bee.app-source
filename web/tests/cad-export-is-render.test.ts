// 2026-11-12, P1: 2bee.cad's File → Export STL wrote the PREVIEW. `cnc_gland_plate_3d.scad:345` says
// `if ($preview) _viz();` — 13 mm connector stubs for the picture — so the exported STL was 12 parts, 17 mm tall,
// where OpenSCAD's `-o stl` gives 1 part, 4 mm. Every path that writes a file for a machine now builds with
// `render: true` (src/cad/machine.ts); the viewport stays a preview. Asserted on the EMITTED STL bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScad } from '../src/cad/scad';
import { meshScene } from '../src/cad/mesh';
import { buildMachineRecord, machineMeasure, scadOptionsFor } from '../src/cad/machine';
import { parseStl } from '../src/print3d/model';

const GLAND = new URL('../../../../hardware/cad/2bee_cnc_table/cnc_gland_plate_3d.scad', import.meta.url);
const src = readFileSync(GLAND, 'utf8');

/** Solids and Z extent of a binary STL, read off the bytes. */
function stlFacts(bytes: Uint8Array): { triangles: number; height: number } {
  const tri = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < tri.length; i += 3) { lo = Math.min(lo, tri[i]); hi = Math.max(hi, tri[i]); }
  return { triangles: tri.length / 9, height: hi - lo };
}

test('the gland plate source still draws its display stubs under $preview (the case this test needs)', () => {
  assert.match(src, /if\s*\(\s*\$preview\s*\)\s*_viz\(\)/);
});

test('Export / Save: the record a machine reads is the RENDER — 1 solid, about 4 mm', () => {
  const out = buildMachineRecord({ name: 'gland', source: src, now: 0 });
  assert.ok(out.ok, `refused: ${!out.ok ? out.refusal.headline : ''}`);
  const rec = out.record;
  const f = stlFacts(rec.bytes);
  console.log(`export: solids ${rec.cad.solids}, height ${f.height.toFixed(2)} mm, triangles ${f.triangles}`);
  assert.equal(rec.cad.solids, 1, 'the exported STL carries the preview-only connector stubs');
  assert.ok(Math.abs(f.height - 4) < 0.5, `exported STL is ${f.height.toFixed(2)} mm tall, expected about 4`);
});

test('viewport: the same source on screen is the PREVIEW — the stubs are drawn, 17 mm', () => {
  const m = meshScene(parseScad(src, scadOptionsFor('view')).scene);
  let lo = Infinity, hi = -Infinity;
  for (const p of m.parts) for (let i = 2; i < p.positions.length; i += 3) { lo = Math.min(lo, p.positions[i]); hi = Math.max(hi, p.positions[i]); }
  console.log(`viewport: parts ${m.parts.length}, height ${(hi - lo).toFixed(2)} mm`);
  assert.ok(m.parts.length > 1, 'viewport lost the preview geometry');
  assert.ok(hi - lo > 15, `viewport is ${(hi - lo).toFixed(2)} mm tall`);
});

test('catalogue numbers are the render: 1 part, about 4 mm tall', () => {
  const m = machineMeasure(src);
  assert.ok(m && m.exhausted === null && m.sizeMm);
  assert.equal(m.resolution, 'print');
  assert.equal(m.parts, 1);
  assert.ok(Math.abs(m.sizeMm[2] - 4) < 0.5, `sizeMm z = ${m.sizeMm[2]}`);
});

test('every machine-file writer goes through the render (source check)', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cad = read('../src/cad/CadTab.tsx');
  const exp = cad.slice(cad.indexOf("case 'file.export.stl'"), cad.indexOf("case 'file.export.stl'") + 1500);
  assert.match(exp, /machineRecord\(/, 'File → Export STL does not build through the machine record');
  assert.match(cad, /parseScad\(deferredMeshSrc, \{ host: makeLibraryHost\(library\), path: selfPath \}\)/, 'the viewport mesh is no longer the plain preview parse');
  assert.doesNotMatch(cad, /writeCadModel\(\{[^}]*parse: meshParse/, 'a save still writes the viewport parse');
  assert.match(read('../src/shop/toCnc.ts'), /recordName: name, layFlat: true, forMachine: true/, 'designToCnc builds a preview');
  assert.match(read('../src/make/printJob/file.ts'), /evaluateForMachine\(/, 'the print job file is a preview');
  assert.match(read('../src/cncjob/plan.ts'), /evaluateForMachine\(/, 'the router plan is a preview');
  assert.doesNotMatch(read('../src/make/MakeFlow.tsx'), /evaluate\(design\.source/, 'MakeFlow plans/measures a preview');
  assert.match(read('../scripts/build-shop-catalogue.ts'), /machineMeasure\(/, 'the catalogue measures the preview');
});
