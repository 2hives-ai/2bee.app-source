// `mirror()`, AND THE DEFECT IT WAS ABOUT TO BE BUILT ON TOP OF.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT — AND IT WAS ALREADY SHIPPING, WITHOUT `mirror()`
// ═══════════════════════════════════════════════════════════════════════════
//
// An orientation-reversing transform (negative determinant) turns every face
// inside-out. The CSG kernel decides inside from outside by winding, so a
// boolean whose operands arrive inside-out computes a DIFFERENT SOLID — and
// flipping the result afterwards only makes the wrong solid outward-wound.
//
// Both transform paths did exactly that: evaluate the children, then flip. The
// comment even cited OpenSCAD — *"csgNode.cc flips normals on mirrored
// operands"* — which is right about OpenSCAD and wrong about WHERE: OpenSCAD
// flips the OPERANDS, before the boolean consumes them.
//
// 🔴 MEASURED 2026-09-02, on `difference(){cube(10); translate([2,2,-1]) cube(3);}`:
//
//     plain                        982.00 mm³   52 triangles
//     scale([-1,1,1]) of it         -9.00 mm³   12 triangles   ← SHIPPED
//     multmatrix(reflection)        -9.00 mm³   12 triangles
//
// …and every one reported `trust: 'trusted'`. **`scale([-1,1,1])` is the
// ordinary OpenSCAD idiom for a mirrored part** — left- and right-hand versions
// of an enclosure are exactly what it is written for — and it was turning a
// 982 mm³ solid into a 9 mm³ inside-out fragment, silently, before `mirror()`
// existed at all. Implementing `mirror()` on top of that would have added a
// third entrance to the same broken path.
//
// The fix is one place: `transformPolys`, where a primitive's polygons receive
// the accumulated transform. Flip there and every boolean sees consistently
// wound operands.
//
// ⚠ DOING BOTH DOUBLE-FLIPS, and that is how the second half was caught: with
// the creation-time flip added and the post-hoc flips still in place, the shape
// was right and the solid was inside-out (-982). A sign is easy to miss; the
// signed-volume assertions below exist so it cannot be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { meshScene } from '../src/cad/mesh.ts';

/** Signed volume of everything drawn. Sign is the point: negative = inside-out. */
function signedVolume(src: string): { vol: number; tris: number; trust: string } {
  const r = parseScad(src, {});
  const m = meshScene(r.scene);
  let vol = 0;
  let tris = 0;
  for (const p of m.parts) {
    const q = p.positions;
    tris += q.length / 9;
    for (let i = 0; i < q.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [q[i], q[i + 1], q[i + 2], q[i + 3], q[i + 4], q[i + 5], q[i + 6], q[i + 7], q[i + 8]];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
  }
  return { vol: Number(vol.toFixed(3)), tris, trust: m.trust };
}

const D = 'difference(){cube(10); translate([2,2,-1]) cube(3);}';

test('🔴 a boolean under an orientation-reversing transform keeps its SHAPE', () => {
  // The regression: 52 triangles became 12, and 982 mm³ became 9.
  const plain = signedVolume(D);
  assert.equal(plain.vol, 982);
  assert.equal(plain.tris, 52);

  for (const wrap of [
    'scale([-1,1,1])',
    'mirror([1,0,0])',
    'multmatrix([[-1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])',
  ]) {
    const got = signedVolume(`${wrap} ${D}`);
    assert.equal(got.tris, 52, `${wrap}: the boolean lost triangles`);
    // 🔴 POSITIVE, not just |982|. A double flip gives the right shape
    // inside-out, and that is a defect a magnitude check cannot see.
    assert.equal(got.vol, 982, `${wrap}: wrong volume or inside-out`);
  }
});

test('an orientation-PRESERVING transform is untouched by the fix', () => {
  // The control. If the flip fired on det > 0 these would go negative.
  /* ⚠ THE EXPECTED VOLUME IS PER-WRAP, and the first draft of this test got it
   * wrong: it asserted 982 for `scale([2,1,1])`, which legitimately DOUBLES the
   * volume to 1964. The control caught my assertion, not the code — which is
   * the right way round, and worth leaving written down. */
  const preserving: [wrap: string, vol: number][] = [
    ['translate([50,0,0])', 982],
    ['rotate([0,0,90])', 982],
    ['scale([2,1,1])', 1964], // det = +2: volume doubles, orientation kept
    ['multmatrix([[0,-1,0,0],[1,0,0,0],[0,0,1,0],[0,0,0,1]])', 982],
    ['mirror([0,0,0])', 982], // OpenSCAD: identity, NOT an error
    ['scale([-1,-1,1])', 982], // TWO negatives — determinant is POSITIVE
  ];
  for (const [wrap, vol] of preserving) {
    const got = signedVolume(`${wrap} ${D}`);
    assert.equal(got.vol, vol, `${wrap} must not flip anything`);
    assert.equal(got.tris, 52, `${wrap}`);
  }
});

test('a mirrored part is actually moved to the other side', () => {
  const m = meshScene(parseScad('mirror([1,0,0]) translate([5,0,0]) cube([2,2,2]);', {}).scene);
  const b = m.parts[0]?.bounds;
  assert.ok(b, 'a part must be drawn');
  assert.equal(b.min[0], -7);
  assert.equal(b.max[0], -5);
});

/** Measured from OpenSCAD 2026.08.07 by reading the `multmatrix` it emits. */
const MATRICES: [src: string, m: number[]][] = [
  ['mirror([1,0,0])', [-1, 0, 0, 0, 1, 0, 0, 0, 1]],
  ['mirror([0,0,1])', [1, 0, 0, 0, 1, 0, 0, 0, -1]],
  // Normalised: the Householder reflection I - 2nnᵀ/(n·n).
  ['mirror([1,1,0])', [0, -1, 0, -1, 0, 0, 0, 0, 1]],
  // Magnitude is ignored, and a short vector is padded with zeroes.
  ['mirror([2,0,0])', [-1, 0, 0, 0, 1, 0, 0, 0, 1]],
  ['mirror([1,0])', [-1, 0, 0, 0, 1, 0, 0, 0, 1]],
  // 🔴 The zero vector is the IDENTITY and NOT an error. Refusing would make us
  // STRICTER than the binary on a construct it accepts — a capability gap, not
  // safety, by this lane's own ledger.
  ['mirror([0,0,0])', [1, 0, 0, 0, 1, 0, 0, 0, 1]],
];

for (const [src, want] of MATRICES) {
  test(`${src} builds OpenSCAD's matrix`, () => {
    const r = parseScad(`${src} cube(1);`, {});
    assert.deepEqual(r.unsupported.map((u) => u.name), [], 'mirror must not be refused');
    const find = (n: unknown): { multmatrix?: { m: number[] } } | undefined => {
      const node = n as { multmatrix?: { m: number[] }; children?: unknown[] };
      if (node?.multmatrix) return node;
      for (const ch of node?.children ?? []) {
        const hit = find(ch);
        if (hit) return hit;
      }
      return undefined;
    };
    const m = find(r.scene)?.multmatrix?.m;
    assert.ok(m, 'mirror must produce a multmatrix node');
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(m[i] - want[i]) < 1e-12, `entry ${i}: ${m[i]} != ${want[i]}`);
  });
}
