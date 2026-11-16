// `linear_extrude` end caps — triangulated and PROVED, not fanned.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT (found 2026-10-14 by the CAD1H triage, listed "found, not fixed"
// in 187f6a74ec)
// ─────────────────────────────────────────────────────────────────────────────
//
// `extrudeOutline` capped every outline with a FAN from vertex 0, and the 2D
// preview drew every outline the same way. A fan is right only for an outline
// that is star-shaped about that vertex. On a comb, an L entered at the wrong
// corner, or anything with a hole, the fan's triangles fold over and poke
// outside the outline.
//
// ⚠ WHY NOBODY SAW IT: the fan's SIGNED areas still sum to the outline's, so
// `linear_extrude(3) comb` read 132 mm³ — exactly right — and audited
// `closed`. The wrong triangles only bite when the solid meets another one:
// a union with a pin standing in one of the comb's gaps came out 136 mm³ and
// `non-manifold` (openscad 135), and the preview showed 92 mm² of triangles
// for a 44 mm² comb. So these tests assert on the EMITTED CAP — every
// triangle wound up, inside the outline, the areas summing exactly — and not
// on the volume alone, which a fan passes.
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

type P2 = [number, number];
const COMB_PTS: P2[] = [[0, 0], [10, 0], [10, 6], [8, 6], [8, 2], [6, 2], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]];
// The L entered at a corner a fan from vertex 0 cannot see the whole of.
const L_PTS: P2[] = [[10, 0], [10, 2], [2, 2], [2, 10], [0, 10], [0, 0]];
const poly = (pts: P2[]) => `polygon(${JSON.stringify(pts)})`;
const COMB = poly(COMB_PTS);
const L = poly(L_PTS);
const HOLED = 'difference(){ square(10); translate([3,3]) square(4); }';
const HOLED_OUTER: P2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
const HOLED_HOLE: P2[] = [[3, 3], [7, 3], [7, 7], [3, 7]];

function inRing(p: P2, ring: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > p[1]) !== (by > p[1]) && p[0] < ax + ((p[1] - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside;
}

interface Solid {
  volume: number;
  verdict: string;
  /** Triangles lying in the plane z = zTop, as [ax,ay,bx,by,cx,cy]. */
  cap: (zTop: number) => number[][];
}

function solidsOf(src: string): { solids: Solid[]; refusals: string[] } {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  const solids: Solid[] = [];
  for (const p of meshed.parts) {
    if (p.dim !== 3 || !p.triangles) continue;
    const q = p.positions;
    let volume = 0;
    for (let i = 0; i < q.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [q[i], q[i + 1], q[i + 2], q[i + 3], q[i + 4], q[i + 5], q[i + 6], q[i + 7], q[i + 8]];
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    solids.push({
      volume,
      verdict: p.audit?.verdict ?? 'none',
      cap: (z) => {
        const out: number[][] = [];
        for (let i = 0; i < q.length; i += 9) {
          if (Math.abs(q[i + 2] - z) < 1e-9 && Math.abs(q[i + 5] - z) < 1e-9 && Math.abs(q[i + 8] - z) < 1e-9) {
            out.push([q[i], q[i + 1], q[i + 3], q[i + 4], q[i + 6], q[i + 7]]);
          }
        }
        return out;
      },
    });
  }
  const refusals = [
    ...parsed.unsupported.map((u) => `${u.name}: ${u.detail}`),
    ...meshed.issues.filter((i) => i.severity === 'refused').map((i) => `${i.name}: ${i.detail}`),
  ];
  return { solids, refusals };
}

/** The cap at z: every triangle wound the right way (CCW seen from +Z on the
 *  top, CW on the bottom), every centroid inside the region, and the areas
 *  summing to the region's area. Positive winding + exact sum ⇒ no overlap. */
function assertCap(s: Solid, z: number, up: boolean, outer: P2[], holes: P2[][], area: number, what: string): void {
  const tris = s.cap(z);
  assert.ok(tris.length > 0, `${what}: no cap triangles at z=${z}`);
  let sum = 0;
  tris.forEach(([ax, ay, bx, by, cx, cy], k) => {
    const signed = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    assert.ok(
      up ? signed > 1e-12 : signed < -1e-12,
      `${what}: cap triangle ${k} at z=${z} is wound ${signed > 0 ? 'CCW' : 'CW'} (signed area ${signed}) — ` +
        'a folded-over fan triangle',
    );
    const c: P2 = [(ax + bx + cx) / 3, (ay + by + cy) / 3];
    assert.ok(
      inRing(c, outer) && !holes.some((h) => inRing(c, h)),
      `${what}: cap triangle ${k} has its centroid (${c[0].toFixed(3)}, ${c[1].toFixed(3)}) OUTSIDE the region`,
    );
    sum += Math.abs(signed);
  });
  assert.ok(Math.abs(sum - area) < 1e-9, `${what}: cap triangles cover ${sum} mm², the region is ${area} — they overlap`);
}

// ── 1. the cap is inside the outline and covers it exactly once ──────────────

test('a COMB is capped inside its outline — top and bottom, every triangle wound right', () => {
  const { solids, refusals } = solidsOf(`linear_extrude(3) ${COMB};`);
  assert.deepEqual(refusals, []);
  assert.equal(solids.length, 1);
  assertCap(solids[0], 3, true, COMB_PTS, [], 44, 'comb top');
  assertCap(solids[0], 0, false, COMB_PTS, [], 44, 'comb bottom');
  assert.ok(Math.abs(solids[0].volume - 132) < 1e-9, `signed volume ${solids[0].volume}, area × height = 132`);
  assert.equal(solids[0].verdict, 'closed');
});

test('an L entered at the corner a fan cannot see from is capped inside it', () => {
  const { solids } = solidsOf(`linear_extrude(3) ${L};`);
  assertCap(solids[0], 3, true, L_PTS, [], 36, 'L top');
  assertCap(solids[0], 0, false, L_PTS, [], 36, 'L bottom');
  assert.ok(Math.abs(solids[0].volume - 108) < 1e-9);
  assert.equal(solids[0].verdict, 'closed');
});

test('a square with a HOLE is capped around the hole — 252 mm³ = 84 × 3, one closed solid', () => {
  const { solids, refusals } = solidsOf(`linear_extrude(3) ${HOLED}`);
  assert.deepEqual(refusals, []);
  assert.equal(solids.length, 1, 'the hole used to come back as a second, FILLED solid');
  assertCap(solids[0], 3, true, HOLED_OUTER, [HOLED_HOLE], 84, 'holed top');
  assertCap(solids[0], 0, false, HOLED_OUTER, [HOLED_HOLE], 84, 'holed bottom');
  assert.ok(Math.abs(solids[0].volume - 252) < 1e-9, `signed volume ${solids[0].volume}, openscad 252`);
  assert.equal(solids[0].verdict, 'closed');
});

test('center=true caps at ±h/2, same proof', () => {
  const { solids } = solidsOf(`linear_extrude(4, center=true) ${COMB};`);
  assertCap(solids[0], 2, true, COMB_PTS, [], 44, 'centred top');
  assertCap(solids[0], -2, false, COMB_PTS, [], 44, 'centred bottom');
});

// ── 2. where it bit: a boolean with another solid ────────────────────────────

test('comb ∪ a pin standing in its gap is 135 mm³ and CLOSED (the fan gave 136, non-manifold)', () => {
  const { solids } = solidsOf(`union(){ linear_extrude(3) ${COMB}; translate([6.5,3,0]) cube([1,1,3]); }`);
  assert.equal(solids.length, 1);
  assert.equal(solids[0].verdict, 'closed');
  assert.ok(Math.abs(solids[0].volume - 135) < 1e-6, `volume ${solids[0].volume.toFixed(6)}, openscad 135`);
});

test('L ∪ a pin in its empty quadrant is 111 mm³ and CLOSED (the fan gave 111.6, non-manifold)', () => {
  const { solids } = solidsOf(`union(){ linear_extrude(3) ${L}; translate([5,5,0]) cube([1,1,3]); }`);
  assert.equal(solids[0].verdict, 'closed');
  assert.ok(Math.abs(solids[0].volume - 111) < 1e-6, `volume ${solids[0].volume.toFixed(6)}, openscad 111`);
});

test('comb minus a block over its right half is 98 mm³ and CLOSED (the fan: right volume, non-manifold)', () => {
  const { solids } = solidsOf(`difference(){ linear_extrude(3) ${COMB}; translate([5,1,1]) cube([10,10,10]); }`);
  assert.equal(solids[0].verdict, 'closed');
  assert.ok(Math.abs(solids[0].volume - 98) < 1e-6, `volume ${solids[0].volume.toFixed(6)}, openscad 98`);
});

// ── 3. the 2D preview draws the same proven triangulation ────────────────────

test('the 2D preview of a comb draws 44 mm² of triangles, not the fan\'s 92', () => {
  const parsed = parseScad(`${COMB};`);
  const meshed = meshScene(parsed.scene);
  let area = 0;
  for (const p of meshed.parts) {
    const q = p.positions;
    for (let i = 0; i < q.length; i += 9) {
      area += Math.abs((q[i + 3] - q[i]) * (q[i + 7] - q[i + 1]) - (q[i + 4] - q[i + 1]) * (q[i + 6] - q[i])) / 2;
    }
  }
  assert.ok(Math.abs(area - 44) < 1e-9, `drew ${area} mm² for a 44 mm² comb`);
});

// ── 4. a cap that cannot be proved is REFUSED by name ────────────────────────

// ⚠ CHANGED 2026-10-14: a self-crossing polygon is now FILLED EVEN-ODD as openscad
// does ([[0,0],[4,4],[4,0],[0,6]] = 10.4 mm², cad-polygon-paths.test.ts). Only the
// bow-tie whose lobes cancel is still refused by name.
test('a self-crossing outline is filled even-odd (10.4 × 2 mm³); a cancelling bow-tie is REFUSED by name', () => {
  {
    const { solids, refusals } = solidsOf('linear_extrude(2) polygon([[0,0],[4,4],[4,0],[0,6]]);');
    assert.deepEqual(refusals, []);
    const vol = solids.reduce((s, x) => s + x.volume, 0);
    assert.ok(Math.abs(vol - 20.8) < 1e-6, `volume ${vol}, openscad 10.4 × 2`);
  }
  for (const pts of ['[[3,3],[7,7],[7,3],[3,7]]']) {
    const { solids, refusals } = solidsOf(`linear_extrude(2) polygon(${pts});`);
    assert.equal(solids.length, 0, `${pts}: drew ${solids.length} solid(s)`);
    assert.ok(
      refusals.some((r) => r.startsWith('linear_extrude():') && r.includes('could not be triangulated exactly')),
      `${pts}: ${JSON.stringify(refusals)}`,
    );
  }
});

// ── the ledger, re-measured against the binary ───────────────────────────────

const ROWS: { src: string; volume: number }[] = [
  { src: `linear_extrude(3) ${COMB};`, volume: 132 },
  { src: `linear_extrude(3) ${L};`, volume: 108 },
  { src: `linear_extrude(3) ${HOLED}`, volume: 252 },
  { src: `union(){ linear_extrude(3) ${COMB}; translate([6.5,3,0]) cube([1,1,3]); }`, volume: 135 },
  { src: `union(){ linear_extrude(3) ${L}; translate([5,5,0]) cube([1,1,3]); }`, volume: 111 },
  { src: `difference(){ linear_extrude(3) ${COMB}; translate([5,1,1]) cube([10,10,10]); }`, volume: 98 },
];

test('the recorded OpenSCAD column still matches the binary', (t) => {
  const probe = spawnSync('openscad', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error) {
    t.skip('openscad not on PATH — the recorded column stands undated rather than falsely confirmed');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cad-extrude-caps-'));
  try {
    ROWS.forEach((row, i) => {
      const scad = join(dir, `r${i}.scad`);
      const stl = join(dir, `r${i}.stl`);
      writeFileSync(scad, row.src);
      spawnSync('openscad', ['--export-format', 'asciistl', '-o', stl, scad], { encoding: 'utf8', timeout: 60_000 });
      assert.ok(existsSync(stl), `${row.src}: recorded ${row.volume}, binary produced no solid`);
      const v = [...readFileSync(stl, 'utf8').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) => m.slice(1).map(Number));
      let vol = 0;
      for (let k = 0; k + 2 < v.length; k += 3) {
        const [a, b, c] = [v[k], v[k + 1], v[k + 2]];
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      }
      assert.ok(Math.abs(vol - row.volume) < 1e-3, `${row.src}: recorded ${row.volume}, binary now ${vol.toFixed(6)}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
