// `offset(delta = …)` — the argument this reader discarded for as long as it has
// had an `offset()`, and the corner it draws.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT
// ─────────────────────────────────────────────────────────────────────────────
//
// `scad.ts` read its arguments as:
//
//     const rVal     = toNum(eval(named.get('r') ?? pos[0]?.value ?? {v: 0}));
//     const deltaVal = toNum(eval(named.get('delta')             ?? {v: 0}));
//     const r = rVal ?? deltaVal ?? 0;
//
// An absent `r` produced `0`, `0` is not nullish, and `??` therefore never
// reached `delta`. **Every `offset(delta = k)` in the corpus executed as
// `offset(r = 0)` — no offset at all** — with no refusal, no warning, and a part
// that still meshed, still posted and still drew a plausible picture. That is
// the failure class this lane's mission names: not a crash, a wrong part.
//
// Two files in `hardware/cad/` use it, both via the fillet idiom
// `offset(r = k) offset(delta = -k)`:
//   · 2bee_hive/2bee_hive_joinery.scad:69        (included by the whole hive family)
//   · 2bee_sensor_pod_v3/sensor_pod_v3_enclosure_3d.scad:124
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ASSERTIONS ARE AREAS
// ─────────────────────────────────────────────────────────────────────────────
//
// `r` and `delta` are not two spellings of one operation. `r` rounds a convex
// corner with an arc; `delta` runs the two offset edges out to their
// intersection. **They enclose different area**, and area is a number this test
// can hold OpenSCAD to without caring how either of us tessellates.
//
// Every figure below was measured on the binary — openscad 2026.08.07,
// 2026-09-21 — never read off the manual:
//
//     $ echo 'offset(delta=2){square([10,10]);}' > b.scad
//     $ openscad -o b.svg b.scad          # then integrate the path
//
//     offset(r=2)                   12 pts  191.243   round
//     offset(2)                     12 pts  191.243   1st positional IS r
//     offset(delta=2)                4 pts  196.000   miter, exact
//     offset(2,-1)                  12 pts  191.243   2nd positional IS delta,
//                                                     and r wins with a warning
//     offset()                      12 pts  142.520   DEFAULT IS r = 1, ROUNDED
//     offset(r="x") / (delta="x")   12 pts  142.520   non-numeric → that default
//     offset(r=1/0) / (delta=1/0)     —     nothing   "not a 2D object"
//     offset(delta=2,chamfer=true)   8 pts  193.255   a THIRD join — refused here
//     offset(r=2) offset(delta=-2)  12 pts   95.243   the fillet idiom
//
// ⚠ THE RECORDED COLUMN IS RE-MEASURED WHERE THE BINARY IS PRESENT. The last
// test re-runs those rows against `openscad` and goes red if the ledger has
// drifted; where the binary is absent it SKIPS, because a check that cannot run
// is not a check that passed.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THIS TEST CANNOT MAKE
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 It asserts the CORNER and the AREA. It does not assert that closing this
// moves `2bee_hive_panels_18mm_inner_wcnc.scad`'s 9.0% volume divergence — it
// does not, measured, and the earlier belief that it would was retracted in
// TODO #169. The polygons there are fastener holes (766 cylinders at `$fn = 24`),
// not offset arcs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

/** Area of the one 2D part, summed over its triangles. Winding-agnostic. */
function flatArea(src: string): number {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  const flats = meshed.parts.filter((p) => p.dim === 2 && p.triangles > 0);
  assert.equal(flats.length, 1, `${src}: expected exactly one 2D part, got ${flats.length}`);
  const p = flats[0].positions;
  let a = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1];
    a += Math.abs(ax * by - ay * bx) / 2;
  }
  return a;
}

function diagnostics(src: string): { warnings: string[]; refusals: string[]; flats: number } {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  return {
    warnings: parsed.warnings.map((w) => w.message),
    refusals: parsed.unsupported.map((u) => `${u.name}: ${u.detail}`),
    flats: meshed.parts.filter((p) => p.dim === 2 && p.triangles > 0).length,
  };
}

const SQUARE = 'square([10,10]);';

// ── the defect itself ────────────────────────────────────────────────────────

test('offset(delta=2) offsets by 2 — it is not read as offset(r=0)', () => {
  const area = flatArea(`offset(delta=2) ${SQUARE}`);
  // The mitre is exact geometry, not a tessellation: 14×14 with square corners.
  assert.ok(
    Math.abs(area - 196) < 1e-6,
    `offset(delta=2) enclosed ${area.toFixed(3)}, OpenSCAD encloses 196.000. ` +
      'An area of 100 means delta was discarded and the call was executed as offset(r=0).',
  );
});

test('the corner delta draws is MITRED, not rounded — they differ by 4.757 mm²', () => {
  const miter = flatArea(`offset(delta=2) ${SQUARE}`);
  const round = flatArea(`offset(r=2) ${SQUARE}`);
  assert.ok(miter > round, `miter ${miter.toFixed(3)} should exceed round ${round.toFixed(3)}`);
  // Ours is a polygon inscribed in OpenSCAD's arc, so round is allowed to sit a
  // little UNDER 191.243 — but not by the 4.757 that separates the two joins.
  assert.ok(
    round > 188 && round < 192.6,
    `offset(r=2) enclosed ${round.toFixed(3)}; OpenSCAD 191.243, analytic limit 192.566`,
  );
});

test('the fillet idiom rounds the corners instead of growing the part', () => {
  // `offset(r=k) offset(delta=-k)` is the ONLY way both hardware files use delta.
  const filleted = flatArea(`offset(r=2) offset(delta=-2) ${SQUARE}`);
  assert.ok(
    filleted > 93 && filleted < 97,
    `fillet idiom enclosed ${filleted.toFixed(3)}, OpenSCAD 95.243. ` +
      'About 191 means the inner offset(delta=-2) was dropped and only the outer r=2 ran — ' +
      'a part 2 mm oversize on every edge.',
  );
});

// ── precedence, defaults and the arguments OpenSCAD ignores ──────────────────

test('r wins over delta, and the reader says so in OpenSCAD\'s own words', () => {
  const d = diagnostics(`offset(r=2, delta=-1) ${SQUARE}`);
  assert.ok(
    d.warnings.some((w) => w.includes('Ignoring "delta" argument as "r" is defined too.')),
    `expected OpenSCAD's warning, got: ${JSON.stringify(d.warnings)}`,
  );
  const area = flatArea(`offset(r=2, delta=-1) ${SQUARE}`);
  assert.ok(area > 188 && area < 192.6, `r should have won; enclosed ${area.toFixed(3)}`);
});

test('positional arguments are (r, delta) in that order', () => {
  const first = flatArea(`offset(2) ${SQUARE}`);
  assert.ok(first > 188 && first < 192.6, `offset(2) should be ROUND r=2; enclosed ${first.toFixed(3)}`);
  const both = flatArea(`offset(2,-1) ${SQUARE}`);
  assert.ok(
    Math.abs(both - first) < 1e-9,
    `offset(2,-1) must equal offset(2) — r wins; got ${both.toFixed(3)} vs ${first.toFixed(3)}`,
  );
});

test('an argument-less offset() is r = 1 ROUNDED, not a no-op', () => {
  const area = flatArea(`offset() ${SQUARE}`);
  assert.ok(
    area > 140 && area < 143.2,
    `offset() enclosed ${area.toFixed(3)}, OpenSCAD 142.520 (analytic limit 143.142). ` +
      '100 means it was read as no offset at all.',
  );
});

test('a non-numeric r or delta falls to that same default, silently — as the binary does', () => {
  for (const src of [`offset(r="x") ${SQUARE}`, `offset(delta="x") ${SQUARE}`]) {
    const area = flatArea(src);
    assert.ok(area > 140 && area < 143.2, `${src} enclosed ${area.toFixed(3)}, expected ~142.520`);
  }
});

// ── what is REFUSED rather than approximated ─────────────────────────────────

test('chamfer=true is REFUSED by name — the mitre is the wrong answer, not a near one', () => {
  const d = diagnostics(`offset(delta=2, chamfer=true) ${SQUARE}`);
  assert.equal(d.flats, 0, 'a refused offset must draw NOTHING, not the mitre');
  assert.ok(
    d.refusals.some((r) => r.startsWith('offset(chamfer = true)')),
    `expected a named refusal, got: ${JSON.stringify(d.refusals)}`,
  );
  assert.ok(
    d.refusals.some((r) => r.includes('193.255')),
    'the refusal must carry the measured area it declines to draw',
  );
});

test('chamfer is IGNORED on the r path, exactly as OpenSCAD ignores it', () => {
  const area = flatArea(`offset(r=2, chamfer=true) ${SQUARE}`);
  assert.ok(area > 188 && area < 192.6, `enclosed ${area.toFixed(3)}, expected the plain round r=2`);
});

test('a non-finite r or delta draws nothing, because OpenSCAD has no 2D object there', () => {
  for (const src of [`offset(r=1/0) ${SQUARE}`, `offset(delta=1/0) ${SQUARE}`]) {
    const d = diagnostics(src);
    assert.equal(d.flats, 0, `${src} drew a part; OpenSCAD produces no 2D object`);
    assert.ok(d.refusals.some((r) => r.startsWith('offset()')), `${src}: ${JSON.stringify(d.refusals)}`);
  }
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const ROWS: { src: string; area: number | null }[] = [
  { src: 'offset(r=2){square([10,10]);}', area: 191.243 },
  { src: 'offset(2){square([10,10]);}', area: 191.243 },
  { src: 'offset(delta=2){square([10,10]);}', area: 196.0 },
  { src: 'offset(2,-1){square([10,10]);}', area: 191.243 },
  { src: 'offset(){square([10,10]);}', area: 142.52 },
  { src: 'offset(r="x"){square([10,10]);}', area: 142.52 },
  { src: 'offset(delta="x"){square([10,10]);}', area: 142.52 },
  { src: 'offset(delta=2,chamfer=true){square([10,10]);}', area: 193.255 },
  { src: 'offset(r=2,chamfer=true){square([10,10]);}', area: 191.243 },
  { src: 'offset(r=2) offset(delta=-2) square([10,10]);', area: 95.243 },
  { src: 'offset(r=1/0){square([10,10]);}', area: null },
  { src: 'offset(delta=1/0){square([10,10]);}', area: null },
];

function openscadArea(src: string, dir: string, i: number): number | null {
  const scad = join(dir, `r${i}.scad`);
  const svg = join(dir, `r${i}.svg`);
  writeFileSync(scad, src);
  spawnSync('openscad', ['-o', svg, scad], { encoding: 'utf8', timeout: 60_000 });
  if (!existsSync(svg)) return null; // "Current top level object is not a 2D object"
  const text = readFileSync(svg, 'utf8');
  const path = /points="([^"]+)"/.exec(text)?.[1] ?? /\sd="([^"]*)"/s.exec(text)?.[1];
  if (!path) return null;
  const nums = (path.match(/-?\d+\.?\d*(?:e-?\d+)?/g) ?? []).map(Number);
  const pts: [number, number][] = [];
  for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  let a = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x1, y1] = pts[k];
    const [x2, y2] = pts[(k + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

test('the recorded OpenSCAD column still matches the binary', (t) => {
  const probe = spawnSync('openscad', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error) {
    t.skip('openscad not on PATH — the recorded column stands undated rather than falsely confirmed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'offset-ledger-'));
  try {
    ROWS.forEach((row, i) => {
      const got = openscadArea(row.src, dir, i);
      if (row.area === null) {
        assert.equal(got, null, `${row.src}: recorded as producing no 2D object, binary gave ${got}`);
        return;
      }
      assert.ok(got !== null, `${row.src}: recorded ${row.area}, binary produced no 2D object`);
      assert.ok(
        Math.abs(got - row.area) < 0.002,
        `${row.src}: recorded ${row.area}, binary now ${got!.toFixed(3)}`,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
