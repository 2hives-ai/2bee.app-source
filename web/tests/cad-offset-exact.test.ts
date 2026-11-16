// `offset()` computed EXACTLY or refused — and the two winding defects that let a
// wrong offset reach a cut file as a part that looked finished.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT, AS IT REACHED A CUT FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// The scad_oracle (cut-only) had `2bee_hive_brood_panel_wcnc.scad` at
// **openscad 1 647 657 mm³ vs ours 39.5 mm³** — the whole panel had evaluated
// to a sliver, audited `closed`, with no refusal and no warning. Four separate
// mechanisms, each tested below by the GEOMETRY it emits:
//
//   1. an inward offset that consumes an outline INVERTED it instead of
//      emptying it, and an inverted subtrahend intersects;
//   2. `offset()` read every outline as CCW, so a mirrored one was offset the
//      wrong way (`offset(r=3)` shrank it);
//   3. `linear_extrude` read every outline as CCW, so a mirrored one became an
//      INSIDE-OUT solid (negative volume) — the brood panel's node openings;
//   4. a 2D `union()` kept its first two operands and dropped the rest (35 of
//      the sensor-pod slot's 37 rectangles), and `offset()` then offset each
//      child separately, which an inward offset does not allow.
//
// Every expected number was measured on the binary — openscad 2026.08.07,
// 2026-10-14 — and the last test re-measures the ledger where `openscad` is
// installed, and SKIPS (never passes) where it is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

interface Measured {
  /** Summed area of every 2D part (triangles, winding-agnostic). */
  area: number;
  flats: number;
  /** SIGNED volume of every 3D part — an inside-out solid reads negative. */
  volume: number;
  solids: number;
  refusals: string[];
}

function measure(src: string): Measured {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  let area = 0;
  let volume = 0;
  let flats = 0;
  let solids = 0;
  for (const p of meshed.parts) {
    if (!p.triangles) continue;
    const q = p.positions;
    if (p.dim === 2) {
      flats++;
      for (let i = 0; i < q.length; i += 9) {
        const ax = q[i + 3] - q[i], ay = q[i + 4] - q[i + 1];
        const bx = q[i + 6] - q[i], by = q[i + 7] - q[i + 1];
        area += Math.abs(ax * by - ay * bx) / 2;
      }
    } else {
      solids++;
      for (let i = 0; i < q.length; i += 9) {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = [q[i], q[i + 1], q[i + 2], q[i + 3], q[i + 4], q[i + 5], q[i + 6], q[i + 7], q[i + 8]];
        volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
    }
  }
  const refusals = [
    ...parsed.unsupported.map((u) => `${u.name}: ${u.detail}`),
    ...meshed.issues.filter((i) => i.severity === 'refused').map((i) => `${i.name}: ${i.detail}`),
  ];
  return { area, flats, volume, solids, refusals };
}

const L = 'polygon([[0,0],[10,0],[10,2],[2,2],[2,10],[0,10]])';
const NECK = 'polygon([[0,0],[10,0],[10,4],[6,4],[6,6],[10,6],[10,10],[0,10],[0,6],[4,6],[4,4],[0,4]])';

// ── 1. an inward offset that consumes the outline is EMPTY ───────────────────

test('offset(delta=-0.8) of a 1.4 mm-wide square is EMPTY — not an inverted 0.2 mm sliver', () => {
  const m = measure('offset(delta=-0.8) square([1.4,4.7]);');
  assert.equal(m.flats, 0, `openscad: "not a 2D object"; we drew ${m.flats} part(s) of area ${m.area}`);
  assert.deepEqual(m.refusals, [], 'an empty offset is an ANSWER, not a refusal');
});

test('subtracting that empty offset leaves the minuend WHOLE — 1000 mm³, as openscad', () => {
  const m = measure(
    'difference(){ cube(10); translate([2,2,-1]) linear_extrude(12) offset(delta=-0.8) square([1.4,4.7]); }',
  );
  assert.equal(m.solids, 1);
  assert.ok(
    Math.abs(m.volume - 1000) < 1e-6,
    `volume ${m.volume.toFixed(4)}, openscad 1000. 993.8 means the INVERTED 0.2 mm outline was kept ` +
      'and cut as a slot; ~6.2 means it was also extruded inside-out and the difference INTERSECTED.',
  );
});

test('a convex inward offset is the half-plane intersection — exact, including a circle', () => {
  // 32-gon of circumradius 5, apothem moved in by 1: n·a²·tan(π/n).
  const m = measure('offset(r=-1, $fn=32) circle(5, $fn=32);');
  assert.equal(m.flats, 1);
  assert.ok(Math.abs(m.area - 49.822432) < 2e-4, `area ${m.area.toFixed(6)}, openscad 49.822432`);
  // A short edge the offset consumes simply stops contributing; the whole triangle can vanish.
  assert.equal(measure('offset(delta=-2) polygon([[0,0],[10,0],[5,3]]);').flats, 0);
  assert.equal(measure('offset(delta=-1) polygon([[0,0],[10,0],[10,1.5],[0,1.5]]);').flats, 0);
});

// ── 2. the outline's winding is READ ─────────────────────────────────────────

test('offset(r=3) of a MIRRORED square grows it (248.093), it does not shrink it', () => {
  const m = measure('offset(r=3, $fn=32) mirror([1,0]) square(10);');
  assert.equal(m.flats, 1);
  assert.ok(Math.abs(m.area - 248.093030) < 1e-3, `area ${m.area.toFixed(6)}, openscad 248.093030`);
  const d = measure('offset(delta=3) mirror([1,0]) square(10);');
  assert.ok(Math.abs(d.area - 256) < 1e-9, `delta area ${d.area}, openscad 256 (16×16, mitred)`);
});

test('an offset under scale() is computed in the LOCAL frame, then scaled', () => {
  const m = measure('scale([2,1]) offset(r=1,$fn=8) square(1);');
  assert.ok(Math.abs(m.area - 15.656854) < 1e-5, `area ${m.area.toFixed(6)}, openscad 15.656854`);
});

// ── 3. linear_extrude reads the winding too ──────────────────────────────────

test('linear_extrude of a mirrored square is +500 mm³ — not an inside-out −500', () => {
  const m = measure('linear_extrude(5) mirror([1,0]) square(10);');
  assert.ok(Math.abs(m.volume - 500) < 1e-9, `signed volume ${m.volume}; negative means inside-out`);
});

test('and subtracting it CUTS the pocket: 1752 mm³, as openscad (was 48)', () => {
  const m = measure(
    'difference(){ translate([-20,-5,0]) cube([30,20,3]); translate([0,0,-1]) linear_extrude(5) mirror([1,0]) square(4); }',
  );
  assert.ok(Math.abs(m.volume - 1752) < 1e-6, `volume ${m.volume.toFixed(4)}, openscad 1752`);
});

// ── non-convex outlines: exact when the raw offset is simple, refused when not ─

test('non-convex L: delta ±0.5 is exact, and an inward ROUND offset rounds the reflex corner', () => {
  assert.ok(Math.abs(measure(`offset(delta=-0.5) ${L};`).area - 17) < 1e-9);
  assert.ok(Math.abs(measure(`offset(delta=0.5) ${L};`).area - 57) < 1e-9);
  const r = measure(`offset(r=-0.5, $fn=64) ${L};`).area;
  assert.ok(
    Math.abs(r - 17.053966) < 1e-4,
    `offset(r=-0.5) enclosed ${r.toFixed(6)}, openscad 17.053966. 17.000 is the MITRE — the reflex ` +
      'corner was not rounded, i.e. r was executed as delta.',
  );
});

// ⚠ CHANGED 2026-10-14: this was a REFUSAL test. The 2D fill (fillRegion, see
// cad-offset-union-region.test.ts) now computes OpenSCAD's answer exactly, so
// the refusal became a measured value. Full coverage lives in that file.
test('a raw offset that SELF-INTERSECTS (a neck pinched off) is computed: two pieces, 24.32 mm² as openscad', () => {
  const m = measure(`offset(delta=-1.2) ${NECK};`);
  assert.deepEqual(m.refusals, []);
  assert.equal(m.flats, 2, 'openscad answers in TWO contours');
  assert.ok(Math.abs(m.area - 24.32) < 24.32 * 1e-5, `area ${m.area}, openscad 24.32 (oracle REL_TOL 1e-5)`);
});

// ── 4. the 2D union keeps every operand; offset refuses overlapping children ─

test('a 2D union of THREE disjoint squares keeps all three — then offsets each', () => {
  const m = measure('offset(delta=1) union(){ square(2); translate([5,0]) square(2); translate([10,0]) square(2); }');
  assert.equal(m.flats, 3, 'the third operand used to be dropped');
  assert.ok(Math.abs(m.area - 48) < 1e-9, `area ${m.area}, openscad 48 (3 × 4×4)`);
});

// ⚠ CHANGED 2026-10-14: was a refusal ("no exact 2D union"). The children are now
// unioned EXACTLY first, as openscad does, then offset — offset(union), never
// union(offsets). Full coverage: cad-offset-union-region.test.ts.
test('an offset over OVERLAPPING children unions them first: the L of 1-wide arms, 17 mm² as openscad', () => {
  const m = measure('offset(delta=-0.5) union(){ square([10,2]); square([2,10]); }');
  assert.deepEqual(m.refusals, []);
  assert.equal(m.flats, 1);
  assert.ok(Math.abs(m.area - 17) < 1e-6, `area ${m.area}, openscad 17`);
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const ROWS: { src: string; area: number | null }[] = [
  { src: 'offset(delta=-0.8) square([1.4,4.7]);', area: null },
  { src: 'offset(r=3, $fn=32) mirror([1,0]) square(10);', area: 248.09303 },
  { src: 'offset(delta=3) mirror([1,0]) square(10);', area: 256 },
  { src: 'offset(delta=-0.5) union(){ square([10,2]); square([2,10]); }', area: 17 }, // what the union-then-offset gives; we refuse it
  { src: `offset(delta=-0.5) ${L};`, area: 17 },
  { src: `offset(r=-0.5, $fn=64) ${L};`, area: 17.053966 },
  { src: `offset(delta=0.5) ${L};`, area: 57 },
  { src: `offset(delta=-1.2) ${NECK};`, area: 24.32 },
  { src: 'offset(delta=1) union(){square(2); translate([5,0]) square(2); translate([10,0]) square(2);}', area: 48 },
  { src: 'offset(r=-1, $fn=32) circle(5, $fn=32);', area: 49.822432 },
  { src: 'offset(delta=-2) polygon([[0,0],[10,0],[5,3]]);', area: null },
  { src: 'scale([2,1]) offset(r=1,$fn=8) square(1);', area: 15.656854 },
];

function openscadArea(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `r${i}.scad`);
  const svg = join(dir, `r${i}.svg`);
  writeFileSync(scad, src);
  spawnSync('openscad', ['-o', svg, scad], { encoding: 'utf8', timeout: 60_000 });
  if (!existsSync(svg)) return null;
  const text = readFileSync(svg, 'utf8');
  let total = 0;
  for (const m of text.matchAll(/\sd="([^"]*)"/g)) {
    for (const sub of m[1].split(/[Mm]/)) {
      const nums = (sub.match(/-?\d+\.?\d*(?:e-?\d+)?/g) ?? []).map(Number);
      const pts: [number, number][] = [];
      for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
      if (pts.length < 3) continue;
      let a = 0;
      for (let k = 0; k < pts.length; k++) {
        const [x1, y1] = pts[k];
        const [x2, y2] = pts[(k + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
      }
      total += a / 2;
    }
  }
  return Math.abs(total);
}

test('the recorded OpenSCAD column still matches the binary', (t) => {
  const probe = spawnSync('openscad', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error) {
    t.skip('openscad not on PATH — the recorded column stands undated rather than falsely confirmed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cad-offset-exact-'));
  try {
    ROWS.forEach((row, i) => {
      const got = openscadArea(row.src, dir, i);
      if (row.area === null) {
        assert.equal(got, null, `${row.src}: recorded as no 2D object, binary gave ${got}`);
        return;
      }
      assert.ok(got !== null, `${row.src}: recorded ${row.area}, binary produced no 2D object`);
      assert.ok(Math.abs(got! - row.area) < 2e-3, `${row.src}: recorded ${row.area}, binary now ${got!.toFixed(6)}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
