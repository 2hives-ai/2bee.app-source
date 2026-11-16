// `projection()` returns REGIONS — an outline with its holes — computed exactly
// for both `cut = true` and `cut = false`, or refused by name.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECTS (2026-10-14, the follow-up named in 252d0d763a, and one found
// while fixing it)
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. `cut = true` chained the section into loops and returned EVERY loop as
//      a filled flat. A list of flats is a union, so a tube cut across came
//      back as two filled discs — the hole refilled itself (312.15 mm² against
//      openscad's 234.11).
//   2. `cut = false` returned the CONVEX HULL of every vertex. An L-shaped plate
//      projected as a filled triangle-cornered square. `cnc_nest/cut_outline.scad`
//      takes a CNC cut outline from exactly this call: openscad 91 041.75 mm²
//      in 30 contours, this reader 82 862.46 (now 91 041.84).
//   3. The cut was taken AFTER the enclosing transform, so
//      `translate([0,0,5]) projection(cut=true) …` cut the solid 5 mm above
//      where the source put the plane, and drew nothing.
//
// Every expected number was measured on openscad 2026.08.07 (2026-10-14); the
// last test re-measures them where the binary is installed and SKIPS (never
// passes) where it is not.

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

const TUBE = 'difference(){ cylinder(r=10,h=2,center=true,$fn=32); cylinder(r=5,h=4,center=true,$fn=32); }';
const LPLATE = 'linear_extrude(3) polygon([[0,0],[10,0],[10,2],[2,2],[2,10],[0,10]])';

// ── 1. a section through a tube is a RING ────────────────────────────────────

test('projection(cut=true) of a tube is ONE ring with its hole — 234.108 mm² (was 312.15, the hole refilled)', () => {
  const m = measure(`projection(cut=true) ${TUBE}`);
  assert.deepEqual(m.refusals, []);
  assert.equal(m.flats, 1, 'one region with a hole — not an outer disc and an inner disc');
  assert.ok(near(m.area, 234.10839), `area ${m.area}, openscad 234.10839`);
});

test('and extruded again, the ring is a TUBE — 2 × 234.108 mm³, the bore is empty', () => {
  const m = measure(`linear_extrude(2) projection(cut=true) ${TUBE}`);
  assert.ok(near(m.volume, 2 * 234.10839, 2e-3), `volume ${m.volume}`);
});

test('overlapping solids are sectioned as their UNION — 46 mm², each overlap counted once', () => {
  const m = measure('projection(cut=true) union(){ translate([0,0,-1]) cube(5); translate([3,3,-2]) cube(5); }');
  assert.equal(m.flats, 1);
  assert.ok(near(m.area, 46), `area ${m.area}, openscad 46`);
});

// ── 2. the silhouette is the shape, not its convex hull ──────────────────────

test('projection(cut=false) of an L plate is the L — 36 mm², not its convex hull', () => {
  const m = measure(`projection(cut=false) ${LPLATE};`);
  assert.deepEqual(m.refusals, []);
  assert.ok(near(m.area, 36), `area ${m.area}, openscad 36 (the hull encloses 82)`);
});

test('projection(cut=false) keeps a THROUGH-hole open — the tube is 234.108 mm²', () => {
  const m = measure(`projection(cut=false) ${TUBE}`);
  assert.equal(m.flats, 1);
  assert.ok(near(m.area, 234.10839), `area ${m.area}`);
});

test('projection(cut=false) of a tilted cube and a sphere — 40.642 and 76.323 mm²', () => {
  assert.ok(near(measure('projection(cut=false) rotate([30,20,10]) cube(5);').area, 40.641609));
  assert.ok(near(measure('projection(cut=false) sphere(5,$fn=24);').area, 76.322806, 1e-4));
  assert.ok(near(measure('projection(cut=false) union(){cube(5); translate([3,3,2]) cube(5);}').area, 46));
});

// ── 3. the cut is at the projection's OWN z = 0 ──────────────────────────────

test('a transform ABOVE projection() moves the outline, not the cutting plane — 4 mm² (drew nothing)', () => {
  assert.ok(near(measure('translate([0,0,5]) projection(cut=true) translate([0,0,-1]) cube(2);').area, 4));
  assert.ok(near(measure('translate([3,0,0]) scale([2,1,1]) projection(cut=true) translate([0,0,-1]) cube(2);').area, 8));
});

// ── 4. what cannot be answered is REFUSED, by name ───────────────────────────

test('a section through an OPEN surface is refused by name — no outline is guessed across the gap', () => {
  const m = measure(
    'projection(cut=true) polyhedron(points=[[0,0,-1],[10,0,-1],[0,10,-1],[0,0,1]], faces=[[0,2,1],[0,1,3],[0,3,2]]);',
  );
  assert.equal(m.flats, 0);
  assert.ok(m.refusals.some((r) => r.startsWith('projection():') && r.includes('not closed')), JSON.stringify(m.refusals));
});

test('an INSIDE-OUT solid is refused by name, not answered as "nothing at this height"', () => {
  const m = measure(
    'projection(cut=true) polyhedron(points=[[0,0,-1],[10,0,-1],[0,10,-1],[0,0,1]], faces=[[0,1,2],[0,3,1],[0,2,3],[1,3,2]]);',
  );
  assert.equal(m.flats, 0);
  assert.ok(m.refusals.some((r) => r.startsWith('projection():') && r.includes('INSIDE OUT')), JSON.stringify(m.refusals));
});

test('a plane that misses the solid is an empty answer and NOT a refusal', () => {
  const m = measure('projection(cut=true) translate([0,0,5]) cube(2);');
  assert.equal(m.flats, 0);
  assert.deepEqual(m.refusals, []);
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const ROWS: { src: string; area: number | null }[] = [
  { src: `projection(cut=true) ${TUBE}`, area: 234.10839 },
  { src: `projection(cut=false) ${TUBE}`, area: 234.10839 },
  { src: 'projection(cut=true) union(){ translate([0,0,-1]) cube(5); translate([3,3,-2]) cube(5); }', area: 46 },
  { src: `projection(cut=false) ${LPLATE};`, area: 36 },
  { src: 'projection(cut=false) rotate([30,20,10]) cube(5);', area: 40.641609 },
  { src: 'projection(cut=false) sphere(5,$fn=24);', area: 76.322806 },
  { src: 'projection(cut=false) union(){cube(5); translate([3,3,2]) cube(5);}', area: 46 },
  { src: 'translate([0,0,5]) projection(cut=true) translate([0,0,-1]) cube(2);', area: 4 },
  { src: 'translate([3,0,0]) scale([2,1,1]) projection(cut=true) translate([0,0,-1]) cube(2);', area: 8 },
  { src: 'projection(cut=true) translate([0,0,5]) cube(2);', area: null },
];

function openscadArea(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `p${i}.scad`);
  const svg = join(dir, `p${i}.svg`);
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
  const dir = mkdtempSync(join(tmpdir(), 'cad-projection-'));
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
