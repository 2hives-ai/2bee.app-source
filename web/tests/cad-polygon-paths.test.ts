// `polygon(points, paths)` — every path a loop, filled EVEN-ODD as openscad
// fills them, or refused by name. Never ignored.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECTS (2026-10-14, the follow-up named in 252d0d763a, and two found
// while fixing it)
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. `scad.ts` parsed `paths=` and dropped it ("For now, ignore paths and
//      use all points in order"). A plate with a hole written as two paths
//      came out as ONE loop zig-zagging through both rings — 132 mm² where
//      openscad draws 64 — with no diagnostic.
//   2. `paths` given POSITIONALLY (`polygon(pts, [[…]])`, legal in openscad)
//      was warned away as a surplus argument by `arity(1)`.
//   3. Without `paths`, a ring that crosses itself WITHOUT its lobes cancelling
//      passed the cap triangulation's check and was drawn counting the
//      doubly-wound area twice: the same zig-zag, 132 mm² (openscad 55.5). A
//      bow-tie whose lobes cancel at the TOP LEVEL drew nothing with no word.
//
// What openscad 2026.08.07 does, measured 2026-10-14 (SVG export areas):
//   · paths are filled EVEN-ODD: two overlapping 10×10 squares → 150, not 175;
//     a hole's winding does not matter (64 either way); the same square twice
//     → no 2D object; a square three times → 100;
//   · `paths = []`, `undef` and absent all mean "the points in order";
//   · a path of fewer than three points encloses nothing and changes nothing;
//   · `paths=5`, `[[0,1.5,2,3]]` (truncated to 1), `[[0,-1,2,3]]` (skipped) are
//     a WARNING and a different shape — refused here, by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

function measure(src: string): { area: number; flats: number; volume: number; refusals: string[]; warnings: string[] } {
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
  const warnings = [
    ...parsed.errors.map((e) => e.message),
    ...parsed.warnings.map((w) => w.message),
    ...meshed.issues.filter((i) => i.severity === 'warning').map((i) => `${i.name}: ${i.detail}`),
  ];
  return { area, flats, volume, refusals, warnings };
}

const near = (got: number, want: number, tol = 1e-6) => Math.abs(got - want) <= tol;

const PLATE = '[[0,0],[10,0],[10,10],[0,10],[2,2],[8,2],[8,8],[2,8]]';
const OVER = '[[0,0],[10,0],[10,10],[0,10],[5,5],[15,5],[15,15],[5,15]]';

// ── 1. paths are READ ────────────────────────────────────────────────────────

test('two paths, outer + inner, are a plate with a HOLE — 64 mm² in ONE region (was 132, paths ignored)', () => {
  const m = measure(`polygon(${PLATE}, paths=[[0,1,2,3],[4,5,6,7]]);`);
  assert.deepEqual(m.refusals, []);
  assert.equal(m.flats, 1);
  assert.ok(near(m.area, 64), `area ${m.area}, openscad 64`);
});

test('the hole does not depend on its winding — reversed inner path, still 64', () => {
  assert.ok(near(measure(`polygon(${PLATE}, paths=[[0,1,2,3],[7,6,5,4]]);`).area, 64));
});

test('paths given POSITIONALLY are read too — 64, and no "surplus argument" warning', () => {
  const m = measure(`polygon(${PLATE}, [[0,1,2,3],[4,5,6,7]]);`);
  assert.ok(near(m.area, 64), `area ${m.area}`);
  assert.ok(!m.warnings.some((w) => w.includes('positional')), JSON.stringify(m.warnings));
});

test('extruded, the plate is ONE closed solid with a through-hole — 192 mm³', () => {
  assert.ok(near(measure(`linear_extrude(3) polygon(${PLATE}, paths=[[0,1,2,3],[4,5,6,7]]);`).volume, 192, 1e-6));
});

test('a repeated closing index is harmless — [[0,1,2,3,0],…] is 64', () => {
  assert.ok(near(measure(`polygon(${PLATE}, paths=[[0,1,2,3,0],[4,5,6,7]]);`).area, 64));
});

// ── 2. the fill is EVEN-ODD ──────────────────────────────────────────────────

test('overlapping paths are even-odd: 150 mm² in two pieces, not the 175 of a union', () => {
  const m = measure(`polygon(${OVER}, paths=[[0,1,2,3],[4,5,6,7]]);`);
  assert.ok(near(m.area, 150), `area ${m.area}, openscad 150`);
  assert.equal(m.flats, 2);
});

test('the same square twice encloses NOTHING; three times, the square — and neither is a refusal', () => {
  const twice = measure('polygon([[0,0],[10,0],[10,10],[0,10]], paths=[[0,1,2,3],[0,1,2,3]]);');
  assert.equal(twice.flats, 0);
  assert.deepEqual(twice.refusals, []);
  assert.ok(near(measure(`polygon(${PLATE}, paths=[[0,1,2,3],[4,5,6,7],[4,5,6,7]]);`).area, 100));
});

test('a two-point path encloses nothing and changes nothing — 100', () => {
  assert.ok(near(measure(`polygon(${PLATE}, paths=[[0,1,2,3],[4,5]]);`).area, 100));
});

test('two triangles sharing a diagonal are the square — 100', () => {
  const m = measure(`polygon(${PLATE}, paths=[[0,1,2],[0,2,3]]);`);
  assert.ok(near(m.area, 100));
  assert.equal(m.flats, 1);
});

test('a single path that crosses itself is filled even-odd — the bow-tie-with-tail is 10.4 in two pieces', () => {
  const m = measure('polygon([[0,0],[4,4],[4,0],[0,6]], paths=[[0,1,2,3]]);');
  assert.ok(near(m.area, 10.4), `area ${m.area}, openscad 10.4`);
});

// ── 3. WITHOUT paths: the same even-odd fill for a ring that crosses itself ─

test('the two rings written as ONE loop are 55.5 mm² (was 132 — the doubly-wound area counted twice)', () => {
  const m = measure(`polygon(${PLATE});`);
  assert.deepEqual(m.refusals, []);
  assert.ok(near(m.area, 55.5), `area ${m.area}, openscad 55.5`);
  assert.ok(near(measure(`polygon(${PLATE}, paths=[]);`).area, 55.5), 'paths=[] means the points in order');
  assert.ok(near(measure(`linear_extrude(1) polygon(${PLATE});`).volume, 55.5));
});

test('a SIMPLE ring without paths is untouched — the L is 36', () => {
  assert.ok(near(measure('polygon([[0,0],[10,0],[10,2],[2,2],[2,10],[0,10]]);').area, 36));
});

test('a bow-tie whose lobes cancel is REFUSED by name at the top level — it used to vanish without a word', () => {
  const m = measure('polygon([[0,0],[10,0],[0,10],[10,10]]);');
  assert.equal(m.flats, 0);
  assert.ok(m.refusals.some((r) => r.startsWith('polygon:') && r.includes('crosses itself')), JSON.stringify(m.refusals));
});

// ── 4. what openscad only warns about is REFUSED here, by name ───────────────

for (const [paths, says] of [
  ['5', 'not a list'],
  ['[[0,1.5,2,3]]', 'not an integer'],
  ['[[0,-1,2,3]]', 'outside the 8 points'],
  ['[[0,1,2,8]]', 'outside the 8 points'],
  ['[[0,1,2,3],7]', 'paths[1] is not a list'],
] as const) {
  test(`paths=${paths} is REFUSED by name ("${says}") — nothing drawn, no guessed shape`, () => {
    const m = measure(`polygon(${PLATE}, paths=${paths});`);
    assert.equal(m.flats, 0);
    assert.ok(m.refusals.some((r) => r.startsWith('polygon(paths=):') && r.includes(says)), JSON.stringify(m.refusals));
  });
}

test('a path that names a NON-NUMERIC point is refused; one that does not name it is fine', () => {
  const bad = measure('polygon(points=[[0,0],[10,0],[10,10],[0,10],["a",1]], paths=[[0,1,4,3]]);');
  assert.ok(bad.refusals.some((r) => r.includes('not a numeric')), JSON.stringify(bad.refusals));
  assert.ok(near(measure('polygon(points=[[0,0],[10,0],[10,10],[0,10],["a",1]], paths=[[0,1,2,3]]);').area, 100));
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const ROWS: { src: string; area: number | null }[] = [
  { src: `polygon(${PLATE}, paths=[[0,1,2,3],[4,5,6,7]]);`, area: 64 },
  { src: `polygon(${PLATE}, paths=[[0,1,2,3],[7,6,5,4]]);`, area: 64 },
  { src: `polygon(${PLATE}, [[0,1,2,3],[4,5,6,7]]);`, area: 64 },
  { src: `polygon(${PLATE}, paths=[[0,1,2,3,0],[4,5,6,7]]);`, area: 64 },
  { src: `polygon(${OVER}, paths=[[0,1,2,3],[4,5,6,7]]);`, area: 150 },
  { src: 'polygon([[0,0],[10,0],[10,10],[0,10]], paths=[[0,1,2,3],[0,1,2,3]]);', area: null },
  { src: `polygon(${PLATE}, paths=[[0,1,2,3],[4,5,6,7],[4,5,6,7]]);`, area: 100 },
  { src: `polygon(${PLATE}, paths=[[0,1,2,3],[4,5]]);`, area: 100 },
  { src: `polygon(${PLATE}, paths=[[0,1,2],[0,2,3]]);`, area: 100 },
  { src: 'polygon([[0,0],[4,4],[4,0],[0,6]], paths=[[0,1,2,3]]);', area: 10.4 },
  { src: `polygon(${PLATE});`, area: 55.5 },
  { src: `polygon(${PLATE}, paths=[]);`, area: 55.5 },
  { src: 'polygon([[0,0],[10,0],[0,10],[10,10]]);', area: 50 },
  // What openscad draws for the refused rows — a DIFFERENT shape from the one written:
  { src: `polygon(${PLATE}, paths=[[0,1.5,2,3]]);`, area: 100 },
  { src: `polygon(${PLATE}, paths=[[0,-1,2,3]]);`, area: 50 },
  { src: `polygon(${PLATE}, paths=5);`, area: 55.5 },
];

function openscadArea(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `q${i}.scad`);
  const svg = join(dir, `q${i}.svg`);
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
  const dir = mkdtempSync(join(tmpdir(), 'cad-polygon-paths-'));
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
