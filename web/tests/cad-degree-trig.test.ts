// `rotate()` in degrees — and whether a quarter turn is exactly a quarter turn.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE EXISTS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// `mesh.ts` built the rotation matrix with `Math.cos(deg * Math.PI / 180)`. At
// 90° that is `6.123233995736766e-17`, not `0`. OpenSCAD returns an exact `0`.
//
// It is silent and it is cumulative: a part rotated four times by 90° does not
// return to where it started, and nothing prints a warning.
//
// ⚠ THE MAGNITUDE WAS MEASURED, NOT ASSUMED, because "every boolean inherits
// it" is a claim and the number decides what kind of claim it is. With the
// defect in place, four quarter turns move a point at 100 mm by **2.45e-14 mm**
// and one at 1000 mm by **4.55e-13 mm**. A `difference()` between a cube and a
// four-times-turned copy of itself was byte-identical either way (48 triangles
// both). So the honest reading is: **this is not a dimensional defect at any
// scale this lane cuts, and no boolean has been shown to change.** What it IS
// is a divergence from the oracle's evaluated tree — four `hardware/cad/`
// files carry a literal `6.12323e-17` where OpenSCAD prints `0` — and the loss
// of an exact algebraic identity that a CAM kernel should have.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE EVERY NUMBER IN THIS FILE CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE 18 MATRICES BELOW ARE COPIED OUT OF **OpenSCAD 2026.08.07**, NOT
// COMPUTED BY US. Re-runnable, and the source file is included so the
// expectations can be regenerated rather than trusted:
//
//     $ cat probe.scad
//     rotate([90,0,0]) cube(1);           …one line per case, in this order…
//     $ openscad -o probe.csg probe.scad
//     $ cat probe.csg
//     multmatrix([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]]) {
//     …
//
// The `printed` field of each case is the nine linear-part tokens of that
// `multmatrix`, **as text**, including the sign of every zero. Text rather than
// numbers because `-0` and `0` are indistinguishable once parsed, and three of
// these eighteen matrices turn on exactly that difference.
//
// ⚠ AN EXPECTATION TAKEN FROM OUR OWN OUTPUT WOULD AGREE WITH THE DEFECT IT IS
// SUPPOSED TO CATCH. Nothing here was read off `rotationMatrixDegrees`.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · OpenSCAD does not run here. These are FROZEN measurements with a date on
//     them. `tools/scad_oracle/` is the harness that runs the binary live.
//   · Only the tokens OpenSCAD prints at full precision are pinned exactly.
//     `%g` at six significant figures prints `-0.99999999999847` as `-1`, so a
//     token of `1`/`-1`/`0`/`-0` is asserted with `Object.is` **only** on the
//     cases whose angles are exact multiples of 90°, where OpenSCAD's own
//     reduce-and-complement makes the value exact by construction. The other
//     five cases are compared numerically at six significant figures, which is
//     all the oracle emitted.
//   · The 2D `rotate(a)` path and the axis-angle `rotate(a, v)` path. `scad.ts`
//     refuses axis-angle by name; that refusal is asserted elsewhere.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROLS — three plants, transcripts pasted from the real runs
// (2026-08-11). Each was applied to `mesh.ts`, the suite run, the file restored.
// ─────────────────────────────────────────────────────────────────────────────
//
//   PLANT 1 — the fix removed: `rotationMatrixDegrees` back to
//   `Math.cos(v[i] * Math.PI / 180)` and a composed Rz·Ry·Rx.
//
//       not ok 1 - the 18 matrices OpenSCAD prints, reproduced exactly
//         error: 'rotate([90,0,0]) entry 4: expected 0, got 6.123233995736766e-17'
//       not ok 4 - four 90 degree turns return a point exactly to its start
//         error: four turns of [17.5,-3.25,8] landed at [17.5,-3.2500000000000036,8]
//       ok 5 - four 90 degree turns return a real part, byte for byte
//       not ok 6 - a rotation too large to reduce is REFUSED, and says why
//         error: nothing is drawn from a meaningless matrix / 1 !== 0
//       # pass 3  # fail 3
//
//   🔴 **`ok 5` IS THE MOST USEFUL LINE HERE, AND IT IS A GREEN.** The
//   product-level leg — real `parseScad` + `meshScene`, comparing the vertices
//   that reach the viewport — DID NOT FIRE. `MeshPart.positions` is a
//   `Float32Array` (~1.2e-7 relative resolution) and the residue is ~1e-16
//   relative: nine orders below what the output surface can represent. So this
//   defect is **structurally invisible at the product's own output**, and any
//   future claim that the mesh output proves the conversion is wrong. Test 5 is
//   kept, retitled to say what it can and cannot see, because deleting it would
//   remove a guard against a GROSS composition error; it is not, and cannot be,
//   the control for this one.
//
//   PLANT 2 — the `I · M` product in `rotationMatrixDegrees` removed as the
//   redundant-looking no-op it resembles (`return m` directly).
//
//       not ok 1 - the 18 matrices OpenSCAD prints, reproduced exactly
//         error: 'rotate([90,0,0]) entry 6: expected exactly 0 (Object.is), got -0'
//       # pass 5  # fail 1
//
//   ⚠ Its first run reported `expected exactly 0 … got 0`, because `String(-0)`
//   is `'0'` — a real red that read as a broken assertion. `show()` below exists
//   for that and nothing else.
//
//   PLANT 3 — the fix written the WRONG WAY, as a quadrant test with a
//   tolerance: `const q = 90 * Math.round(deg / 90); if (Math.abs(deg - q) <
//   1e-3) return TABLE[k];`. This is the plant that matters most: it produces
//   exact quadrant matrices and an exact round trip, so it satisfies the two
//   properties the ticket asked for while being worse than the defect.
//
//       not ok 1 - the 18 matrices OpenSCAD prints, reproduced exactly
//         error: 'rotate([0,0,180]) entry 3: expected exactly -0 (Object.is), got 0'
//       not ok 2 - sin and cos in degrees are exact where OpenSCAD is exact
//         error: 'sin(180°) = 0, want -0'
//       not ok 3 - a near-quadrant angle stays near-quadrant and is NEVER snapped
//         error: 'cos(89.9999°) must be a real 1.74533e-06, not 0 — a tolerance
//                 that snaps it silently straightens a part the operator
//                 deliberately drew at an angle'
//       ok 4 - four 90 degree turns return a point exactly to its start
//       not ok 6 - a rotation too large to reduce is REFUSED, and says why
//       # pass 2  # fail 4
//
//   ⇒ `ok 4` under plant 3 is the reason test 3 exists. The round-trip property
//   is satisfied by a fix that silently straightens parts; asserting it alone
//   would have blessed exactly the wrong implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene, rotationMatrixDegrees, sinDegrees, cosDegrees } = await import(
  '../src/cad/mesh.ts'
);

/** Agreement with a token the oracle printed at SIX SIGNIFICANT FIGURES — all
 *  the `.csg` writer emits (`%g` at default precision), so comparing more finely
 *  would be a test of a printf format rather than of the geometry. The bound is
 *  half an ulp of the printed representation: at that precision `0.353553` is
 *  every value within 5e-7 of itself, and `0.3535533905932738` is one of them. */
function closeAt6sf(got: number, want: number): boolean {
  if (want === 0) return got === 0;
  const halfUlp = 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(want))) - 5);
  return Math.abs(got - want) <= halfUlp;
}

const EXACT_TOKENS = new Set(['0', '-0', '1', '-1']);

/** `String(-0)` is `'0'`, so a signed-zero failure would report "expected 0,
 *  got 0" and read as a harness bug. Three of the pinned matrices turn on that
 *  sign; the message has to be able to say so. */
const show = (x: number): string => (Object.is(x, -0) ? '-0' : String(x));

interface Probe {
  a: [number, number, number];
  /** The nine linear-part tokens of the `multmatrix`, row-major, verbatim. */
  printed: string[];
  /** True when the angles are exact multiples of 90°, so every `0`/`±1` token
   *  is an exact value rather than a six-figure rounding of a near-one. */
  exact: boolean;
}

// openscad 2026.08.07, `openscad -o probe.csg probe.scad`, 2026-08-11.
const PROBES: Probe[] = [
  { a: [90, 0, 0], printed: ['1', '0', '0', '0', '0', '-1', '0', '1', '0'], exact: true },
  { a: [-90, 0, 0], printed: ['1', '0', '0', '0', '0', '1', '0', '-1', '0'], exact: true },
  { a: [0, 90, 0], printed: ['0', '0', '1', '0', '1', '0', '-1', '0', '0'], exact: true },
  { a: [0, 0, 90], printed: ['0', '-1', '0', '1', '0', '0', '0', '0', '1'], exact: true },
  { a: [180, 0, 0], printed: ['1', '0', '0', '0', '-1', '0', '0', '0', '-1'], exact: true },
  // 🔴 The three signed-zero cases. `-0` in the first column and `0` in the
  // third, from the same matrix — that asymmetry is what the `I · M` product
  // produces and is why it is not a no-op.
  { a: [0, 0, 180], printed: ['-1', '0', '0', '-0', '-1', '0', '-0', '0', '1'], exact: true },
  { a: [270, 0, 0], printed: ['1', '0', '0', '0', '0', '1', '0', '-1', '0'], exact: true },
  { a: [360, 0, 0], printed: ['1', '0', '0', '0', '1', '0', '0', '0', '1'], exact: true },
  { a: [0, 0, -180], printed: ['-1', '0', '0', '-0', '-1', '0', '-0', '0', '1'], exact: true },
  { a: [90, 90, 90], printed: ['0', '0', '1', '0', '1', '0', '-1', '0', '0'], exact: true },
  { a: [0, 0, -90], printed: ['-0', '1', '0', '-1', '0', '0', '-0', '0', '1'], exact: true },
  { a: [-180, 0, 0], printed: ['1', '0', '0', '0', '-1', '0', '0', '0', '-1'], exact: true },
  // 450° = 360 + 90: the revolution reduction has to run before the quadrant
  // reflection, or this comes out as a near-miss like every other big angle.
  { a: [450, 0, 0], printed: ['1', '0', '0', '0', '0', '-1', '0', '1', '0'], exact: true },
  // Not quadrant multiples — six-significant-figure comparison only.
  {
    a: [30, 45, 60],
    printed: [
      '0.353553', '-0.573223', '0.739199',
      '0.612372', '0.739199', '0.28033',
      '-0.707107', '0.353553', '0.612372',
    ],
    exact: false,
  },
  {
    a: [89.9999, 0, 0],
    printed: ['1', '0', '0', '0', '1.74533e-06', '-1', '0', '1', '1.74533e-06'],
    exact: false,
  },
  {
    a: [0, 0, 89.9999],
    printed: ['1.74533e-06', '-1', '0', '1', '1.74533e-06', '0', '0', '0', '1'],
    exact: false,
  },
  {
    a: [0, 0, 0.0001],
    printed: ['1', '-1.74533e-06', '0', '1.74533e-06', '1', '0', '0', '0', '1'],
    exact: false,
  },
  { a: [45, 0, 0], printed: ['1', '0', '0', '0', '0.707107', '-0.707107', '0', '0.707107', '0.707107'], exact: false },
];

test('the 18 matrices OpenSCAD prints, reproduced exactly', () => {
  for (const p of PROBES) {
    const m = rotationMatrixDegrees(p.a);
    const who = `rotate([${p.a.join(',')}])`;
    assert.equal(m.length, 9, `${who}: nine entries`);
    for (let i = 0; i < 9; i++) {
      const want = Number(p.printed[i]);
      assert.ok(
        closeAt6sf(m[i], want),
        `${who} entry ${i}: expected ${p.printed[i]}, got ${show(m[i])}`,
      );
      if (p.exact && EXACT_TOKENS.has(p.printed[i])) {
        assert.ok(
          Object.is(m[i], want),
          `${who} entry ${i}: expected exactly ${p.printed[i]} (Object.is), got ${show(m[i])}`,
        );
      }
    }
  }
});

test('sin and cos in degrees are exact where OpenSCAD is exact', () => {
  // Not a restatement of the matrices: these are the scalar identities the
  // matrix happens to be built from, and they are the ones a future caller
  // (a 2D `rotate`, a polygon, an extrude) would reuse.
  //
  // 🔴 THE SIGNED ZEROS HERE WERE MEASURED, NOT REASONED. `echo(sin(180))`
  // prints `0` for both `+0` and `-0`, so the binary was asked a question that
  // can tell them apart:
  //
  //     $ echo 'echo(signtest=[1/sin(180), 1/cos(270), 1/cos(90), 1/sin(0), 1/sin(360)]);' > t.scad
  //     $ openscad -o t.echo t.scad && cat t.echo
  //     ECHO: signtest = [-inf, -inf, inf, inf, inf]
  //
  // ⇒ `sin(180) = -0` and `cos(270) = -0`, while `cos(90)`, `sin(0)` and
  // `sin(360)` are `+0`. My first guess had `cos(270)` as `+0` and this test
  // caught it before the reciprocal probe was written.
  const exactSin: [number, number][] = [
    [0, 0], [30, 0.5], [90, 1], [150, 0.5], [180, -0], [270, -1], [360, 0], [-90, -1],
  ];
  for (const [deg, want] of exactSin) {
    assert.ok(
      Object.is(sinDegrees(deg), want),
      `sin(${deg}°) = ${show(sinDegrees(deg))}, want ${show(want)}`,
    );
  }
  const exactCos: [number, number][] = [
    [0, 1], [60, 0.5], [90, 0], [120, -0.5], [180, -1], [270, -0], [360, 1], [-180, -1],
  ];
  for (const [deg, want] of exactCos) {
    assert.ok(
      Object.is(cosDegrees(deg), want),
      `cos(${deg}°) = ${show(cosDegrees(deg))}, want ${show(want)}`,
    );
  }
  // 30/45/60 come from written-out constants, not from `Math.sqrt`.
  assert.equal(sinDegrees(45), Math.SQRT1_2);
  assert.equal(cosDegrees(45), Math.SQRT1_2);
  assert.equal(sinDegrees(60), 0.86602540378443859659);
  assert.equal(cosDegrees(30), 0.86602540378443859659);
});

test('a near-quadrant angle stays near-quadrant and is NEVER snapped', () => {
  // 🔴 THE OPPOSITE DIRECTION, and the one that makes the fix safe rather than
  // merely tidy. A quadrant test with any tolerance would round 89.9999° to 90°
  // and silently straighten a part the operator deliberately drew at an angle —
  // a wrong part that no diagnostic mentions. OpenSCAD emits a real
  // `1.74533e-06` here, which is how we know its exactness is a property of the
  // argument reduction and not a printed rounding of zero.
  const c = cosDegrees(89.9999);
  assert.ok(
    c !== 0,
    'cos(89.9999°) must be a real 1.74533e-06, not 0 — a tolerance that snaps it silently ' +
      'straightens a part the operator deliberately drew at an angle',
  );
  assert.ok(closeAt6sf(c, 1.74533e-6), `cos(89.9999°) = ${c}, OpenSCAD says 1.74533e-06`);
  assert.ok(cosDegrees(90.0001) !== 0, 'cos(90.0001°) must be real too');
  assert.ok(sinDegrees(0.0001) !== 0, 'sin(0.0001°) must be real');
  assert.ok(cosDegrees(44.9999) !== Math.SQRT1_2, '44.9999° must not become 45°');
  assert.ok(sinDegrees(29.9999) !== 0.5, '29.9999° must not become 30°');
  // And the matrices genuinely differ, not just the scalars.
  const near = rotationMatrixDegrees([89.9999, 0, 0]);
  const at = rotationMatrixDegrees([90, 0, 0]);
  assert.ok(near.some((x, i) => x !== at[i]), '89.9999° and 90° must not produce the same matrix');
});

test('four 90 degree turns return a point exactly to its start', () => {
  const m = rotationMatrixDegrees([0, 0, 90]);
  const apply = (p: number[]): number[] => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
  for (const start of [
    [17.5, -3.25, 8],
    [1, 1, 1],
    [-101.375, 62.5, -0.5],
  ]) {
    let p = start;
    for (let i = 0; i < 4; i++) p = apply(p);
    // Exact equality, not a tolerance: with `6.12e-17` in the matrix this drifts
    // by ~1e-15 per axis and no tolerance would be honest about it.
    assert.deepEqual(p, start, `four turns of [${start}] landed at [${p}]`);
  }
  // The same property on the other two axes, so this is a fact about the
  // conversion and not about the one matrix that happens to be tested.
  for (const axis of [
    [90, 0, 0],
    [0, 90, 0],
  ] as [number, number, number][]) {
    const r = rotationMatrixDegrees(axis);
    let p = [3, -7, 11];
    for (let i = 0; i < 4; i++) {
      p = [
        r[0] * p[0] + r[1] * p[1] + r[2] * p[2],
        r[3] * p[0] + r[4] * p[1] + r[5] * p[2],
        r[6] * p[0] + r[7] * p[1] + r[8] * p[2],
      ];
    }
    assert.deepEqual(p, [3, -7, 11], `four turns about [${axis}] landed at [${p}]`);
  }
});

test('four 90 degree turns return a real part, byte for byte', () => {
  // 🔴 THIS TEST CANNOT SEE THE DEFECT THE FILE IS ABOUT, AND THE PLANT PROVED
  // IT — plant 1 (the naive `Math.cos` restored) left this green. It runs the
  // real `parseScad` + `meshScene`, with the transform stack composed the way
  // the evaluator composes it, and compares the vertices that reach the
  // viewport. But `MeshPart.positions` is a `Float32Array`, and the residue is
  // ~1e-16 relative — nine orders below float32's ~1.2e-7. It rounds away.
  //
  // ⇒ What it DOES guard is a gross composition error: a wrong multiplication
  // order, a transposed matrix, a translation lost in the stack. Read as the
  // control for quadrant exactness it would be a green that means nothing;
  // that control is `four 90 degree turns return a point exactly to its start`,
  // which works in doubles.
  const still = meshScene(parseScad('translate([3,7,0]) cube([2,4,6]);\n').scene);
  const turned = meshScene(
    parseScad(
      'rotate([0,0,90]) rotate([0,0,90]) rotate([0,0,90]) rotate([0,0,90])\n' +
        '  translate([3,7,0]) cube([2,4,6]);\n',
    ).scene,
  );
  assert.equal(still.parts.length, 1);
  assert.equal(turned.parts.length, 1);
  const a = Array.from(still.parts[0].positions);
  const b = Array.from(turned.parts[0].positions);
  assert.equal(b.length, a.length, 'same triangle count');
  assert.deepEqual(b, a, 'four quarter turns must be the identity, to the last bit');
});

test('a rotation too large to reduce is REFUSED, and says why', () => {
  // Past OpenSCAD's `TRIG_HUGE_VAL` the argument reduction has no significant
  // bits left. OpenSCAD returns NaN; the old naive path returned a confident
  // finite number and a part was drawn from it. The refusal must name the real
  // reason, not the zero-determinant one it would otherwise inherit.
  const huge = 1e30;
  assert.ok(Number.isNaN(cosDegrees(huge)), 'cos of an unreducible angle is NaN');
  const r = meshScene(parseScad(`rotate([${huge},0,0]) cube(10);\n`).scene);
  assert.equal(r.parts.length, 0, 'nothing is drawn from a meaningless matrix');
  const refusal = r.issues.find((i) => i.severity === 'refused');
  assert.ok(refusal, 'the transform is refused');
  assert.match(refusal!.detail, /NOT A NUMBER/);
  assert.doesNotMatch(refusal!.detail, /zero determinant/);
});
