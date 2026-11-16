// 2026-11-13: building every machine file as a RENDER (8e212f9ed9, 74f2160259) made 8 catalogue designs exceed the
// kernel's 200,000-polygon budget, so "Open in 3d", the CAD export and the catalogue lost them. `cad/machine.ts` now
// walks a RESOLUTION LADDER — print → openscad-default → cap64 → cap32 → refuse — stepping down ONLY on a budget
// refusal. These tests pin: a real design lands on the tier it needs; a design that fits stays at `print`; a
// non-budget refusal is NOT retried (with a plant: a ladder that retries everything must turn that test red); and
// the fragment cap never RAISES a source's own lower `$fn`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScad, PRINT_FA, PRINT_FS, type ScadOptions, type ScadResult } from '../src/cad/scad';
import { meshScene, type MeshIssue, type MeshResult } from '../src/cad/mesh';
import { makeLibraryHost } from '../src/cad/library';
import {
  budgetRefusals,
  buildMachineRecord,
  evaluateForMachine,
  RESOLUTION_LADDER,
  tessellationPrint,
  type MachineEvaluation,
} from '../src/cad/machine';
import { RESOLUTION_ORDER, RESOLUTION_SAYS, resolutionSentence } from '../src/cad/resolution';

const CAD = (p: string) => readFileSync(new URL(`../../../../hardware/cad/${p}`, import.meta.url), 'utf8');

/** Distinct angles of the vertices on the outermost radius (as in cad-render-for-print.test.ts). */
function rimSegments(m: MeshResult): number {
  let rmax = 0;
  for (const p of m.parts) for (let i = 0; i < p.positions.length; i += 3) rmax = Math.max(rmax, Math.hypot(p.positions[i], p.positions[i + 1]));
  const angles = new Set<number>();
  for (const p of m.parts) for (let i = 0; i < p.positions.length; i += 3) {
    if (Math.abs(Math.hypot(p.positions[i], p.positions[i + 1]) - rmax) < 1e-3) angles.add(Math.round(Math.atan2(p.positions[i + 1], p.positions[i]) * 1e3));
  }
  return angles.size;
}
const segs = (src: string, o: ScadOptions) => rimSegments(meshScene(parseScad(src, o).scene));

/** A ladder that retries on ANY refusal — the plant the non-retry test must catch. */
const retryEverything = (_p: ScadResult, m: MeshResult): MeshIssue[] | null => {
  const r = m.issues.filter((i) => i.severity === 'refused');
  return r.length ? r : null;
};

// --- a real design -----------------------------------------------------------------------------------------------

/** hardware/cad/2bee_honey_tank/outlet_adapter.scad: `$fn = $preview ? 24 : 96` — exceeds the budget at print AND at
 *  OpenSCAD's defaults (its own $fn is 96 either way), fits at cap64. ~0.7 s. */
function outletAdapter(ladder?: Parameters<typeof evaluateForMachine>[2]): MachineEvaluation {
  const path = '2bee_honey_tank/outlet_adapter.scad';
  const files = new Map([
    [path, CAD(path)],
    ['2bee_honey_tank/params.scad', CAD('2bee_honey_tank/params.scad')],
  ]);
  const host = makeLibraryHost({ files, rootName: 'cad', pickedAt: 0, skipped: [] });
  return evaluateForMachine(files.get(path)!, { host, path }, ladder);
}

test('outlet_adapter (real design) builds at cap64, after two budget refusals', () => {
  const ev = outletAdapter();
  assert.equal(ev.exhausted, null);
  assert.equal(ev.resolution, 'cap64');
  assert.deepEqual(ev.tried.map((t) => t.resolution), ['print', 'openscad-default', 'cap64']);
  for (const t of ev.tried.slice(0, 2)) assert.match(t.steppedDownBecause ?? '', /exceeded 200,000 polygons/);
  // Its own `$fn = 96` wins over both root $fa/$fs, so openscad-default is the SAME tessellation as print: not re-meshed.
  assert.deepEqual(ev.tried.map((t) => t.meshed), [true, false, true]);
  assert.equal(ev.mesh.issues.filter((i) => i.severity === 'refused').length, 0);
  assert.equal(ev.mesh.trust, 'trusted');
  assert.equal(ev.parse.scene.kind, 'group');
});

test('NEGATIVE CONTROL: without the ladder (print tier only) outlet_adapter is refused for budget', () => {
  const ev = outletAdapter({ tiers: [RESOLUTION_LADDER[0]] });
  assert.equal(ev.resolution, 'print');
  assert.match(ev.exhausted ?? '', /exceeded 200,000 polygons/);
});

// --- a design that fits stays at tier 1 --------------------------------------------------------------------------

test('the tessellation fingerprint: same draw ⇒ same print; any drawn change ⇒ a different one', () => {
  const fp = (src: string, o: ScadOptions) => tessellationPrint(parseScad(src, { render: true, ...o }).scene);
  // $fn given: root $fa/$fs are not read on that path, so they do not count.
  assert.equal(fp('cylinder(d = 9, h = 1, $fn = 56);', {}), fp('cylinder(d = 9, h = 1, $fn = 56);', { renderFaFs: { fa: 12, fs: 2 } }));
  // no $fn: root $fa/$fs ARE the tessellation.
  assert.notEqual(fp('cylinder(d = 9, h = 1);', {}), fp('cylinder(d = 9, h = 1);', { renderFaFs: { fa: 12, fs: 2 } }));
  assert.notEqual(fp('cylinder(d = 9, h = 1, $fn = 56);', {}), fp('cylinder(d = 9, h = 1, $fn = 56);', { maxFragments: 32 }));
  // a source that reads $fa into its own coordinates is a different scene.
  assert.notEqual(fp('cube($fa);', {}), fp('cube($fa);', { renderFaFs: { fa: 12, fs: 2 } }));
});

test('a design that fits the budget stays at print resolution', () => {
  const ev = evaluateForMachine('cylinder(d = 140, h = 5);');
  assert.equal(ev.resolution, 'print');
  assert.equal(ev.tried.length, 1);
  assert.equal(rimSegments(ev.mesh), Math.ceil(360 / PRINT_FA), 'still the fine print tessellation');
  const rec = buildMachineRecord({ name: 'c', source: 'cylinder(d = 140, h = 5);', now: 0 });
  assert.equal(rec.resolution, 'print');
  assert.equal(resolutionSentence('print'), '', 'nothing to disclose at print');
});

// --- a non-budget refusal is not retried -------------------------------------------------------------------------

/** A source whose only refusal is NOT a budget one: an intersection with an empty operand. */
const NON_BUDGET = 'cube(10); intersection() { cube(5); union() {} }';

function notRetried(ev: MachineEvaluation): boolean {
  return ev.resolution === 'print' && ev.tried.length === 1 && ev.exhausted === null;
}

test('a non-budget refusal is reported at print, not retried at a lower tier', () => {
  const ev = evaluateForMachine(NON_BUDGET);
  const refused = ev.mesh.issues.filter((i) => i.severity === 'refused');
  assert.equal(refused.length, 1, 'the source really does carry a refusal');
  assert.equal(refused[0].limit, undefined, 'and it is not a budget refusal');
  assert.ok(notRetried(ev), `tried ${ev.tried.map((t) => t.resolution).join(' > ')}`);
});

test('PLANT: a ladder that retries everything turns the non-retry check red', () => {
  const ev = evaluateForMachine(NON_BUDGET, {}, { stepDown: retryEverything });
  assert.equal(notRetried(ev), false, 'the check cannot see a retry-everything ladder');
  assert.equal(ev.resolution, 'cap32');
});

test('budgetRefusals: steps down only on a polygon/work/clock budget refusal; others never trigger it', () => {
  const parse = parseScad('cube(1);');
  const mesh = (issues: MeshIssue[]) => ({ ...meshScene(parse.scene), issues });
  const poly: MeshIssue = { severity: 'refused', name: 'difference()', line: 1, detail: 'x', limit: 'polygons' };
  const other: MeshIssue = { severity: 'refused', name: 'intersection()', line: 2, detail: 'empty operand' };
  assert.ok(budgetRefusals(parse, mesh([poly])));
  assert.ok(budgetRefusals(parse, mesh([{ ...poly, limit: 'work' }])));
  assert.ok(budgetRefusals(parse, mesh([{ ...poly, limit: 'clock' }])));
  assert.equal(budgetRefusals(parse, mesh([{ ...poly, limit: 'depth' }])), null, 'depth is the same at any resolution');
  assert.deepEqual(budgetRefusals(parse, mesh([poly, other])), [poly], 'mixed: the budget one may clear, so it steps down');
  assert.equal(budgetRefusals(parse, mesh([other])), null);
  assert.equal(budgetRefusals(parse, mesh([])), null);
});

// --- the cap -----------------------------------------------------------------------------------------------------

test("the cap lowers a source's higher $fn and NEVER raises a lower one", () => {
  const r = { render: true };
  assert.equal(segs('cylinder(d = 140, h = 5, $fn = 100);', { ...r, maxFragments: 32 }), 32, 'lowered to the cap');
  assert.equal(segs('cylinder(d = 140, h = 5, $fn = 6);', { ...r, maxFragments: 32 }), 6, 'never raised');
  assert.equal(segs('$fn = 20; cylinder(d = 140, h = 5);', { ...r, maxFragments: 64 }), 20, 'never raised (assignment)');
  assert.equal(segs('cylinder(d = 140, h = 5);', { ...r, maxFragments: 64 }), 64, '$fa/$fs path capped (180 uncapped)');
  assert.equal(segs('cylinder(d = 140, h = 5, $fa = 30);', { ...r, maxFragments: 64 }), 12, '$fa path below the cap kept');
  assert.equal(segs('rotate_extrude() translate([70, 0]) square(5);', { maxFragments: 32 }), 32, 'revolve default 48 capped');
  assert.equal(segs('rotate_extrude() translate([70, 0]) square(5);', { maxFragments: 64 }), 48, 'revolve default 48 not raised');
  assert.equal(segs('cylinder(d = 140, h = 5);', { render: true }), 180, 'absent cap: unchanged');
});

test('a cap the evaluator cannot honour is refused, not rounded', () => {
  assert.throws(() => parseScad('cube(1);', { maxFragments: 4 }), RangeError);
  assert.throws(() => parseScad('cube(1);', { maxFragments: 32.5 }), RangeError);
});

test('the ladder and the light vocabulary list the same tiers in the same order', () => {
  assert.deepEqual(RESOLUTION_LADDER.map((t) => t.resolution), [...RESOLUTION_ORDER]);
});

test('the tier sentence for print names the real PRINT_FA/PRINT_FS', () => {
  assert.ok(RESOLUTION_SAYS.print.includes(`$fa=${PRINT_FA}`) && RESOLUTION_SAYS.print.includes(`$fs=${PRINT_FS}`));
  assert.match(resolutionSentence('cap64'), /COARSER.*64 segments/);
});
