// `offset()` over a REGION — overlapping children unioned first, holes, necks
// that pinch off — computed exactly as OpenSCAD computes it, or refused by name.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT (2026-10-14, the follow-up named in 252d0d763a)
// ─────────────────────────────────────────────────────────────────────────────
//
// `2bee_hive_brood_panel_wcnc.scad` — a CNC cut file — DIVERGED on the mesh
// leg because the sensor-pod slot it cuts through 19 mm of ply,
// `enc_pcb_slot_2d()` = `offset(r=0.8) offset(delta=-0.8) union(){ 37 rects }`,
// was REFUSED: "offset of overlapping children — no exact 2D union". OpenSCAD
// unions an offset's children first and offsets the union. Three things were
// missing, and each is pinned below:
//
//   1. an exact 2D union that returns DISJOINT regions with holes;
//   2. an offset of a region whose raw outline self-intersects (a neck pinches
//      off, a notch closes) or that has holes — Clipper's positive-fill
//      construction, which `offsetFlat` had refused;
//   3. the ARC PLACEMENT: Clipper puts round-join points at FIXED 360°/n steps
//      from the start, the last segment short; this kernel split every turn
//      evenly with at least two pieces. Equal at a 90° corner with n % 4 == 0 —
//      every case measured before today — and wrong at the sensor-pod slot's
//      15° corners: `offset(r=3,$fn=24)` of the slot drew 1209.962 mm² where
//      openscad draws 1209.246, and the slot is offset twice before the ply.
//
// Every expected number was measured on openscad 2026.08.07 (2026-10-14); the
// last test re-measures them where the binary is installed and SKIPS (never
// passes) where it is not. Tolerances are 1e-3 mm²: OpenSCAD runs Clipper on an
// integer grid, and the residuals measured here are ≤ 3e-4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

function measure(src: string): { area: number; flats: number; volume: number; refusals: string[] } {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  let area = 0;
  let volume = 0;
  let flats = 0;
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
  return { area, flats, volume, refusals };
}

const near = (got: number, want: number, tol = 1e-3) => Math.abs(got - want) <= tol;

/** A small stand-in for the sensor-pod slot: a spine with five overlapping
 *  bodies of different widths, two of them thinner than 1.6 mm (eaten by the
 *  inward delta) — the same construction as `enc_pcb_slot_2d`. */
const SLOT_U =
  'union(){ square([2,40]); translate([-3,5]) square([8,6]); translate([-1,14]) square([4,1.2]); ' +
  'translate([-4,20]) square([10,1.5]); translate([0.5,30]) square([3,0.9]); translate([1.5,33]) square([4,4]); }';
const SLOT = `offset(r=0.8,$fn=24) offset(delta=-0.8) ${SLOT_U}`;
const NECK = 'polygon([[0,0],[10,0],[10,4],[6,4],[6,6],[10,6],[10,10],[0,10],[0,6],[4,6],[4,4],[0,4]])';
const HOLED = 'difference(){square(10); translate([3,3]) square(4);}';

// ── 1. overlapping children are UNIONED, then offset ─────────────────────────

test('offset over OVERLAPPING children: the union is offset, not refused — the L of 1-wide arms, 17 mm²', () => {
  const m = measure('offset(delta=-0.5) union(){ square([10,2]); square([2,10]); }');
  assert.deepEqual(m.refusals, [], 'this used to be refused as "no exact 2D union"');
  assert.equal(m.flats, 1);
  assert.ok(near(m.area, 17), `area ${m.area}, openscad 17`);
});

test('an inward offset keeps the OVERLAP corner neither child keeps alone — 28 mm², not two 16 mm² bars', () => {
  // Offsetting each 10×4 arm alone gives two 8×2 bars (32 mm², overlapping);
  // the union's offset is one L whose corner is 2×2 — 28.
  const m = measure('offset(delta=-1) union(){ square([10,4]); square([4,10]); }');
  assert.equal(m.flats, 1);
  assert.ok(near(m.area, 28), `area ${m.area}, openscad 28`);
});

test('an inward offset that consumes every arm draws NOTHING, and is not a refusal', () => {
  const m = measure('offset(delta=-1) union(){ square([10,2]); square([2,10]); }');
  assert.equal(m.flats, 0);
  assert.deepEqual(m.refusals, [], 'openscad: "not a 2D object" — an empty answer, not an error');
});

test('OUTWARD offsets of separate children that come to overlap are ONE outline — 61.967 mm²', () => {
  const m = measure('offset(r=1, $fn=12) union(){ square(4); translate([4.5,0]) square(4); }');
  assert.equal(m.flats, 1, 'two overlapping flats drawn at the top level are two overlapping parts');
  assert.ok(near(m.area, 61.966513), `area ${m.area}, openscad 61.966513 (70 = the two offsets double-counted)`);
});

// ── 2. the sensor-pod slot construction ──────────────────────────────────────

test('the slot construction offset(r) offset(delta) union(6 overlapping rects) — 128.569 mm², as openscad', () => {
  const m = measure(SLOT);
  assert.deepEqual(m.refusals, []);
  assert.equal(m.flats, 1);
  assert.ok(near(m.area, 128.569289), `area ${m.area}, openscad 128.569289`);
});

test('…and widened again for the cutter, offset(r=3) — 443.293 mm²', () => {
  const m = measure(`offset(r=3,$fn=24) ${SLOT}`);
  assert.deepEqual(m.refusals, []);
  assert.ok(near(m.area, 443.29324), `area ${m.area}, openscad 443.29324`);
});

test('…with the DEFAULT $fa/$fs (5 fragments at r = 0.8 — an ODD count) — 127.632 mm²', () => {
  // The old arc unit was per HALF-turn, round(5/2) = 3 ⇒ 6 per circle.
  const m = measure(`offset(r=0.8) offset(delta=-0.8) ${SLOT_U}`);
  assert.ok(near(m.area, 127.632167), `area ${m.area}, openscad 127.632167`);
});

test('an inward ROUND offset of the overlapping union — 62.056 mm²', () => {
  const m = measure(`offset(r=-0.7,$fn=24) ${SLOT_U}`);
  assert.ok(near(m.area, 62.055886), `area ${m.area}, openscad 62.055886`);
});

// ── 3. raw offsets that pinch off, and regions with holes ────────────────────

test('a neck that PINCHES OFF is computed: two pieces, 24.32 mm² (was refused)', () => {
  const m = measure(`offset(delta=-1.2) ${NECK};`);
  assert.deepEqual(m.refusals, []);
  assert.equal(m.flats, 2, 'openscad answers in TWO contours');
  assert.ok(near(m.area, 24.32), `area ${m.area}, openscad 24.32`);
  assert.ok(near(measure(`offset(r=-1.2,$fn=24) ${NECK};`).area, 24.989491));
});

test('an outward offset that CLOSES a notch is one outline — delta 169, r 219.078', () => {
  assert.ok(near(measure(`offset(delta=1.5) ${NECK};`).area, 169));
  assert.ok(near(measure(`offset(r=2.5,$fn=24) ${NECK};`).area, 219.077761));
});

test('a region with a HOLE is offset — the hole shrinks outward and grows inward (was refused)', () => {
  const out = measure(`offset(r=1,$fn=16) ${HOLED}`);
  assert.deepEqual(out.refusals, []);
  assert.equal(out.flats, 1);
  assert.ok(near(out.area, 139.061499), `outward ${out.area}, openscad 139.061499`);
  assert.ok(near(measure(`offset(r=-1,$fn=16) ${HOLED}`).area, 28.938528));
  assert.ok(near(measure(`offset(delta=1) ${HOLED}`).area, 140));
  // A slot cut INTO the region from outside: the notch, inward-offset.
  assert.ok(near(measure('offset(delta=-0.3) difference(){square(10); translate([4.5,-1]) square([1,8]);}').area, 77.16));
});

test('extruded, the offset holed plate is ONE closed solid with its hole — 3 × 28.939', () => {
  const m = measure(`linear_extrude(3) offset(r=-1,$fn=16) ${HOLED}`);
  assert.ok(near(m.volume, 3 * 28.938528, 3e-3), `volume ${m.volume}`);
});

// ── 4. Clipper's arc placement at corners that are not 90° ───────────────────

test('round joins at 15°, 51°, 114° … corners are placed at FIXED 360°/n steps, as Clipper places them', () => {
  assert.ok(near(measure('offset(r=1,$fn=24) polygon([[0,0],[10,0],[3,7]]);').area, 65.622201));
  assert.ok(near(measure('offset(r=2,$fn=7) square(5);').area, 76.24256));
  assert.ok(near(measure('offset(r=1,$fn=12) circle(5, $fn=7);').area, 101.810804));
  assert.ok(near(measure('offset(r=-0.6,$fn=10) polygon([[0,0],[10,0],[10,2],[5,1],[0,6]]);').area, 8.923015));
});

// ── what is still refused, by name ───────────────────────────────────────────

test('an offset child whose outline crosses itself so that its lobes cancel is still REFUSED, nothing drawn', () => {
  const m = measure('offset(delta=1) union(){ square(2); polygon([[3,3],[7,7],[7,3],[3,7]]); }');
  assert.equal(m.flats, 0);
  assert.ok(m.refusals.some((r) => r.startsWith('offset():') && r.includes('crosses itself')), JSON.stringify(m.refusals));
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const ROWS: { src: string; area: number | null }[] = [
  { src: 'offset(delta=-0.5) union(){ square([10,2]); square([2,10]); }', area: 17 },
  { src: 'offset(delta=-1) union(){ square([10,4]); square([4,10]); }', area: 28 },
  { src: 'offset(delta=-1) union(){ square([10,2]); square([2,10]); }', area: null },
  { src: 'offset(r=1, $fn=12) union(){ square(4); translate([4.5,0]) square(4); }', area: 61.966513 },
  { src: SLOT, area: 128.569289 },
  { src: `offset(r=3,$fn=24) ${SLOT}`, area: 443.29324 },
  { src: `offset(r=0.8) offset(delta=-0.8) ${SLOT_U}`, area: 127.632167 },
  { src: `offset(r=-0.7,$fn=24) ${SLOT_U}`, area: 62.055886 },
  { src: `offset(delta=-1.2) ${NECK};`, area: 24.32 },
  { src: `offset(r=-1.2,$fn=24) ${NECK};`, area: 24.989491 },
  { src: `offset(delta=1.5) ${NECK};`, area: 169 },
  { src: `offset(r=2.5,$fn=24) ${NECK};`, area: 219.077761 },
  { src: `offset(r=1,$fn=16) ${HOLED}`, area: 139.061499 },
  { src: `offset(r=-1,$fn=16) ${HOLED}`, area: 28.938528 },
  { src: `offset(delta=1) ${HOLED}`, area: 140 },
  { src: 'offset(delta=-0.3) difference(){square(10); translate([4.5,-1]) square([1,8]);}', area: 77.16 },
  { src: 'offset(r=1,$fn=24) polygon([[0,0],[10,0],[3,7]]);', area: 65.622201 },
  { src: 'offset(r=2,$fn=7) square(5);', area: 76.24256 },
  { src: 'offset(r=1,$fn=12) circle(5, $fn=7);', area: 101.810804 },
  { src: 'offset(r=-0.6,$fn=10) polygon([[0,0],[10,0],[10,2],[5,1],[0,6]]);', area: 8.923015 },
];

function openscadArea(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `r${i}.scad`);
  const svg = join(dir, `r${i}.svg`);
  writeFileSync(scad, src);
  spawnSync('openscad', ['-o', svg, scad], { encoding: 'utf8', timeout: 60_000 });
  if (!existsSync(svg)) return null;
  let total = 0;
  for (const m of readFileSync(svg, 'utf8').matchAll(/\sd="([^"]*)"/g)) {
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
  const dir = mkdtempSync(join(tmpdir(), 'cad-offset-region-'));
  try {
    ROWS.forEach((row, i) => {
      const got = openscadArea(row.src, dir, i);
      if (row.area === null) {
        assert.equal(got, null, `${row.src}: recorded EMPTY, binary now draws ${got}`);
        return;
      }
      assert.ok(got !== null, `${row.src}: recorded ${row.area}, binary produced no 2D object`);
      assert.ok(Math.abs(got! - row.area) < 1e-4, `${row.src}: recorded ${row.area}, binary now ${got!.toFixed(6)}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
