// 2D `difference()` and `intersection()` over ALL of their operands — computed
// exactly, or refused by name.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT (found 2026-10-14 by the CAD1H triage, listed "found, not fixed"
// in 187f6a74ec)
// ─────────────────────────────────────────────────────────────────────────────
//
// `boolean2D` in `mesh.ts` read `flats[0]` and `flats[1]` and nothing else:
//
//   1. a THIRD operand of a 2D difference or intersection was dropped, silently;
//   2. the operands were flattened first, so `difference(){ union(){a;b} c }`
//      computed `a − b` and dropped `c` — the union's second member was used
//      as the subtrahend;
//   3. the intersection was Sutherland–Hodgman, correct only for a CONVEX clip:
//      `intersection(){ square(5); L }` gave 4 mm², openscad 16;
//   4. the difference returned the subject PLUS the removed piece as a second
//      flat called `hole(...)`. A list of flats is a UNION downstream, so the
//      "hole" filled itself back in: extruded, a 10×10 plate with a 4×4 hole
//      was 348 mm³ (openscad 252) — two solids, both audited `closed`.
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
  /** SIGNED volume of every 3D part. */
  volume: number;
  solids: number;
  verdicts: string[];
  refusals: string[];
}

function measure(src: string): Measured {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  let area = 0;
  let volume = 0;
  let flats = 0;
  let solids = 0;
  const verdicts: string[] = [];
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
      verdicts.push(p.audit?.verdict ?? 'none');
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
  return { area, flats, volume, solids, verdicts, refusals };
}

const L = 'polygon([[10,0],[10,2],[2,2],[2,10],[0,10],[0,0]])';
const DIFF4 = 'difference(){ square(10); translate([1,1]) square(2); translate([5,5]) square(3); translate([1,6]) square([2,3]); }';
const CROSS = 'difference(){ square(10); translate([-1,4]) square([12,2]); translate([4,-1]) square([2,12]); }';
const INT3 = 'intersection(){ square(10); translate([3,0]) square(10); translate([0,4]) square(10); }';
const HOLED = 'difference(){ square(10); translate([3,3]) square(4); }';

// ── 1. every operand of a difference is subtracted ───────────────────────────

test('a 2D difference with FOUR operands subtracts all three subtrahends — 81 mm², as openscad', () => {
  const m = measure(`${DIFF4}`);
  assert.deepEqual(m.refusals, []);
  assert.ok(
    Math.abs(m.area - 81) < 1e-9,
    `area ${m.area}, openscad 81. 104 is the old answer: the third and fourth operands dropped, and the ` +
      'second drawn as a filled "hole" flat on top of the plate.',
  );
  assert.equal(m.flats, 1, 'one plate with three holes is ONE region');
});

test('subtrahends that cut the plate apart leave the four separate pieces — 64 mm²', () => {
  const m = measure(CROSS);
  assert.ok(Math.abs(m.area - 64) < 1e-9, `area ${m.area}, openscad 64`);
  assert.equal(m.flats, 4, 'four 4×4 corners, each its own region');
});

test('the hole is a HOLE: extruded, the plate is 252 mm³ in ONE closed solid (was 348 in two)', () => {
  const m = measure(`linear_extrude(3) ${HOLED}`);
  assert.equal(m.solids, 1);
  assert.deepEqual(m.verdicts, ['closed']);
  assert.ok(Math.abs(m.volume - 252) < 1e-9, `volume ${m.volume}, openscad 252`);
});

test('and subtracting that holed plate from a block cuts only the RING — 180 mm³ (was 132)', () => {
  const m = measure(
    `difference(){ translate([-1,-1,0]) cube([12,12,3]); translate([0,0,-1]) linear_extrude(5) ${HOLED} }`,
  );
  assert.deepEqual(m.verdicts, ['closed']);
  assert.ok(Math.abs(m.volume - 180) < 1e-6, `volume ${m.volume.toFixed(6)}, openscad 180`);
});

test('a grouped operand stays grouped: difference(){ union(){a;b} c } subtracts c from BOTH — 28 mm²', () => {
  const m = measure('difference(){ union(){ square(4); translate([6,0]) square(4);} translate([1,1]) square(2); }');
  assert.ok(
    Math.abs(m.area - 28) < 1e-9,
    `area ${m.area}, openscad 28. 16 means the operands were flattened and the union's second member was ` +
      'used as the subtrahend.',
  );
});

// ── 2. every operand of an intersection is intersected ───────────────────────

test('a 2D intersection with THREE operands intersects all three — 42 mm² (was 70)', () => {
  assert.ok(Math.abs(measure(INT3).area - 42) < 1e-9, `area ${measure(INT3).area}, openscad 42`);
  const ex = measure(`linear_extrude(2) ${INT3}`);
  assert.ok(Math.abs(ex.volume - 84) < 1e-9, `extruded ${ex.volume}, openscad 84`);
});

test('a NON-CONVEX operand is intersected exactly — square ∩ L is 16 mm² (Sutherland–Hodgman said 4)', () => {
  assert.ok(Math.abs(measure(`intersection(){ square(5); ${L}; }`).area - 16) < 1e-9);
});

test('a circle ∩ two bars is the 3×3 centre — 9 mm² (was 35.57: the third operand dropped)', () => {
  const m = measure('intersection(){ circle(6,$fn=48); square([20,3],center=true); square([3,20],center=true); }');
  assert.ok(Math.abs(m.area - 9) < 1e-9, `area ${m.area}, openscad 9`);
});

// ── 3. what cannot be computed exactly is REFUSED by name ────────────────────

test('an operand whose outline crosses itself REFUSES the whole difference, by name — nothing drawn', () => {
  const m = measure('difference(){ square(10); translate([1,1]) square(2); polygon([[3,3],[7,7],[7,3],[3,7]]); }');
  assert.equal(m.flats, 0, 'a refused boolean draws NOTHING — not the plate, not a partial result');
  assert.ok(
    m.refusals.some((r) => r.startsWith('difference():') && r.includes('polygon') && r.includes('could not be computed exactly')),
    JSON.stringify(m.refusals),
  );
});

test('an intersection with an EMPTY operand is refused, as the 3D one is — never the larger answer', () => {
  const m = measure('intersection(){ square(10); translate([2,2]) square(4); offset(delta=-5) square(2); }');
  assert.equal(m.flats, 0);
  assert.ok(m.refusals.some((r) => r.startsWith('intersection():') && r.includes('no geometry')), JSON.stringify(m.refusals));
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const AREA_ROWS: { src: string; area: number }[] = [
  { src: DIFF4, area: 81 },
  { src: CROSS, area: 64 },
  { src: INT3, area: 42 },
  { src: `intersection(){ square(5); ${L}; }`, area: 16 },
  { src: 'difference(){ union(){ square(4); translate([6,0]) square(4);} translate([1,1]) square(2); }', area: 28 },
  { src: 'intersection(){ circle(6,$fn=48); square([20,3],center=true); square([3,20],center=true); }', area: 9 },
];
const VOLUME_ROWS: { src: string; volume: number }[] = [
  { src: `linear_extrude(3) ${HOLED}`, volume: 252 },
  { src: `difference(){ translate([-1,-1,0]) cube([12,12,3]); translate([0,0,-1]) linear_extrude(5) ${HOLED} }`, volume: 180 },
  { src: `linear_extrude(2) ${INT3}`, volume: 84 },
];

function openscadArea(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `a${i}.scad`);
  const svg = join(dir, `a${i}.svg`);
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

function openscadVolume(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `v${i}.scad`);
  const stl = join(dir, `v${i}.stl`);
  writeFileSync(scad, src);
  spawnSync('openscad', ['--export-format', 'asciistl', '-o', stl, scad], { encoding: 'utf8', timeout: 60_000 });
  if (!existsSync(stl)) return null;
  const v = [...readFileSync(stl, 'utf8').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => m.slice(1).map(Number));
  let vol = 0;
  for (let k = 0; k + 2 < v.length; k += 3) {
    const [a, b, c] = [v[k], v[k + 1], v[k + 2]];
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return vol;
}

test('the recorded OpenSCAD column still matches the binary', (t) => {
  const probe = spawnSync('openscad', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error) {
    t.skip('openscad not on PATH — the recorded column stands undated rather than falsely confirmed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cad-2d-boolean-'));
  try {
    AREA_ROWS.forEach((row, i) => {
      const got = openscadArea(row.src, dir, i);
      assert.ok(got !== null, `${row.src}: recorded ${row.area}, binary produced no 2D object`);
      assert.ok(Math.abs(got! - row.area) < 2e-3, `${row.src}: recorded ${row.area}, binary now ${got!.toFixed(6)}`);
    });
    VOLUME_ROWS.forEach((row, i) => {
      const got = openscadVolume(row.src, dir, i);
      assert.ok(got !== null, `${row.src}: recorded ${row.volume}, binary produced no solid`);
      assert.ok(Math.abs(got! - row.volume) < 1e-3, `${row.src}: recorded ${row.volume}, binary now ${got!.toFixed(6)}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
