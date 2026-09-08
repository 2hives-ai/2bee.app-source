// Circles, cylinders and spheres — tessellated in DEGREES, like OpenSCAD's.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE EXISTS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// `mesh.ts` built every ring with `Math.cos(2π·j/n)`. OpenSCAD builds it with
// `cos_degrees((360·i)/n)` — `generate_circle`, `src/core/primitives.cc:59-66`,
// which is the ONE function behind `circle`, `cylinder` AND `sphere`. At
// `$fn=4` the vertex at 90° came out `(r·6.123233995736766e-17, r)` where
// OpenSCAD emits `(0, r)`; at `$fn=100` the vertex at 180° carried
// `−1.2246e-16·r` instead of a zero.
//
// ⚠ IT IS THE SAME FAMILY AS #97 AND A DIFFERENT SIZE OF PROBLEM. #97 was one
// rotation matrix. This was every vertex of every curved primitive, and it
// landed **on the silhouette** — a cylinder's flat quadrant vertex sitting at a
// micro-angle to the axis it is supposed to be on.
//
// 🔴 AND UNLIKE #97, THE PRODUCT-LEVEL LEG DOES FIRE — do not inherit that
// caveat, it is wrong here. `cad-degree-trig.test.ts` records that
// `MeshPart.positions` is a `Float32Array` at ~1.2e-7 RELATIVE resolution and a
// ~1e-16 RELATIVE residue is nine orders below it, so the rotation defect was
// invisible at the product's own output. **That reasoning does not transfer**:
// there the residue rode on a coordinate of magnitude ~100, here it rides on a
// coordinate whose true value is ZERO. `Math.fround(5 * 6.123233995736766e-17)`
// is `3.0616e-16`, not `0` — float32 carries values down to ~1e-38, and it is
// only ratios to a large neighbour that it cannot carry. So the vertices that
// reach the viewport really do change, and test 1 below really is a control.
// (Measured: plant 1's transcript.)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE EVERY NUMBER IN THIS FILE CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 EVERY EXPECTED VERTEX WAS EXPORTED FROM **OpenSCAD 2026.08.07**. Nothing
// was read off our own output — an expectation taken from the code under test
// agrees with the defect it is supposed to catch.
//
//     $ echo 'cylinder(h=10,r=5,$fn=13);' > cyl13.scad
//     $ openscad --export-format asciistl -o cyl13.stl cyl13.scad
//     $ grep vertex cyl13.stl | sed 's/^ *vertex //' | sort -u
//
// ASCII STL, not `binstl`, for the same reason `tools/scad_oracle` uses it: the
// ascii writer emits full double precision (`-4.85470908713026`), binary STL is
// float32 and would round the ground truth before we ever saw it.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · OpenSCAD does not run here. These are FROZEN measurements with a date on
//     them; `tools/scad_oracle/` is the harness that runs the binary live.
//   · The comparison is at FLOAT32, not double, because `MeshPart.positions` is
//     where our vertices actually arrive. A last-ulp double difference that
//     survives `Math.fround` on both sides would pass here. Test 3 covers the
//     double-precision layer directly, on the exported scalar helpers.
//   · SIGNED ZEROS ARE NOT COMPARED AT THE MESH SURFACE, and neither side keeps
//     them there. `5 * sinDegrees(180)` is `-0` in our ring, exactly as
//     OpenSCAD's `5 * sin_degrees(180)` is `-0.0` in C++ — but by the time each
//     side reaches its output surface both read `0` (`vertex -5 0 10` in the
//     STL; `+0` in `positions`, normalised by the summation in welding). The
//     one place the sign IS visible in an OpenSCAD artefact is the 2D SVG
//     writer, and test 6 pins it there.
//   · `$fa`/`$fs` fragment COUNTS. `fragments()` is a separate port with its own
//     divergences from `CurveDiscretizer::getCircularSegmentCount` — `$fn=4.5`
//     is one, `floor` here against OpenSCAD's `ceil` — and the oracle already
//     reports them (`corpus/fn_clamped`, `corpus/partial_fa_fs_*`). This file
//     changes none of that and asserts none of it: every case below pins `$fn`
//     to an integer so the count is not what is under test.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROLS — three plants, transcripts pasted from the real runs
// (2026-08-11). Each was applied to a THROWAWAY COPY of `mesh.ts` in a sibling
// tree, never to the shared working tree, and the live file's sha256 was
// checked unchanged either side.
// ─────────────────────────────────────────────────────────────────────────────
//
//   PLANT 1 — the fix removed: `circlePoints` back to
//   `Math.cos((2 * Math.PI * i) / n)`, and the sphere's latitude back to
//   `Math.PI * (i + 0.5) / rings`.
//
//       not ok 1 - every vertex OpenSCAD emits for these six curved primitives
//         error: 'cylinder(h=10,r=5,$fn=4);: we emit no vertex at -5,0,0 —
//                 nearest of ours is -5,6.123233998228043e-16,0'
//       ok 2 - the sphere ring latitudes are OpenSCAD's, in degrees
//       not ok 3 - the ring angle is (360*i)/n and it is in DEGREES
//       not ok 4 - the ring sweeps positive and starts on +X
//         error: 'expected [0, 5, 10], actual [3.0616169991140216e-16, 5, 10]'
//       ok 5 - no tessellation angle is ever NEAR a quadrant
//       not ok 6 - the 2D circle is the same ring, signed zero included
//         error: "+ '-5,6.123233998228043e-16,0'  - '-5,0,0'"
//       # pass 2  # fail 4
//
//   🔴 `ok 2` IS THE SURPRISE AND IT IS RECORDED RATHER THAN TIDIED AWAY. I
//   predicted the sphere test would fire and it did not. Every latitude of
//   `$fn=12` is at 15°/45°/75°/105°/135°/165°, none of them a quadrant, so the
//   radian and degree forms differ only in the last ulp of a double — and
//   `Math.fround` absorbs that. **The sphere's LATITUDE expression is covered by
//   test 1 (whose `$fn=4` sphere has rings at 45° and 135°) and by nothing in
//   test 2.** Test 2 still earns its place: it is the control for the OTHER
//   sphere defect, a `(180·i)/rings` off-by-one that would put a ring on a pole,
//   and its last assertion says so. A test that fires for a defect it was not
//   aimed at is a different fact from one that fires for the defect it names.
//
//   PLANT 2 — the loop-invariant "optimisation": `const step = 360 / n` hoisted
//   out and `phi = i * step` inside. Every quadrant vertex is still exact; only
//   non-quadrant angles move, in the last ulp.
//
//       not ok 3 - the ring angle is (360*i)/n and it is in DEGREES
//         error: |- every vertex of the $fn=13 ring, at double precision
//           + '-4.854709087130259 -1.1965783214377907'
//           - '-4.85470908713026 -1.196578321437788'
//       # pass 5  # fail 1
//
//   🔴 TESTS 1, 4 AND 6 ALL STAYED GREEN UNDER PLANT 2, AND THAT IS WHY
//   `circlePoints` IS EXPORTED. Every one of them reads `MeshPart.positions`,
//   which is a `Float32Array`; a last-ulp double change does not survive
//   `Math.fround`, so the entire mesh surface is blind to this defect class. The
//   first draft of this file asserted the argument form on `cosDegrees` alone —
//   which the plant does not touch, so test 3 was green too and NOTHING caught
//   it. The fix was to reach the product's own ring at double precision, not to
//   write a cleverer assertion about a scalar.
//
//   PLANT 3 — the fix written the WRONG WAY, snapping a near-axis vertex:
//   `const snap = (v) => Math.abs(v) < 1e-9 ? 0 : v` around both coordinates.
//
//       # pass 6  # fail 0
//
//   🔴 **THE SNAPPING PLANT DOES NOT FIRE HERE, AND THAT IS A FINDING RATHER
//   THAN A GAP IN THE TESTS.** Test 5 proves why: the tessellation angles are
//   `{360i/n}`, and for every `n ≤ MAX_FN` the smallest NON-ZERO distance from
//   one of them to a multiple of 90° is `360/(4·256) = 0.3515625°` — 351× any
//   tolerance a snapping fix would plausibly carry. There is no near-quadrant
//   tessellation angle for a snap to corrupt, so this file cannot be the control
//   for that wrong fix. The control for it is
//   `cad-degree-trig.test.ts`'s "a near-quadrant angle stays near-quadrant",
//   which asserts it on `cosDegrees` — **the same helper this file's rings call**
//   — where a user-written `rotate([89.9999,0,0])` does reach it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene, circlePoints, sinDegrees, cosDegrees } = await import('../src/cad/mesh.ts');

/** `String(-0)` is `'0'`, so a signed-zero failure would report "expected 0,
 *  got 0" and read as a harness bug rather than a result. */
const show = (x: number): string => (Object.is(x, -0) ? '-0' : String(x));

const key = (v: readonly number[]): string => v.map(show).join(',');

/** Every distinct vertex our pipeline puts into `MeshPart.positions`, in
 *  first-seen order. Order is preserved because test 4 needs it; test 1 only
 *  needs the set. */
function ourVertices(src: string): number[][] {
  const parsed = parseScad(src);
  assert.deepEqual(parsed.errors, [], `${src}: parsed without errors`);
  assert.deepEqual(parsed.unsupported, [], `${src}: nothing refused`);
  const meshed = meshScene(parsed.scene);
  const parts = meshed.parts.filter((p) => p.triangles > 0);
  assert.equal(parts.length, 1, `${src}: exactly one part with geometry`);
  const pos = parts[0].positions;
  const seen = new Map<string, number[]>();
  for (let i = 0; i < pos.length; i += 3) {
    const v = [pos[i], pos[i + 1], pos[i + 2]];
    const k = key(v);
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()];
}

interface Case {
  src: string;
  /** `sort -u` of the `vertex` lines of OpenSCAD's own ascii STL, verbatim. */
  openscad: string[];
}

// openscad 2026.08.07, `--export-format asciistl`, 2026-08-11.
const CASES: Case[] = [
  {
    // n=3. Nothing lands on an axis except vertex 0; the 120°/240° vertices
    // exercise the `=== 60` constant branch of `cosDegrees` rather than a
    // quadrant.
    src: 'cylinder(h=10,r=5,$fn=3);',
    openscad: [
      '-2.5 -4.330127018922193 0',
      '-2.5 -4.330127018922193 10',
      '-2.5 4.330127018922193 0',
      '-2.5 4.330127018922193 10',
      '5 0 0',
      '5 0 10',
    ],
  },
  {
    // n=4. The ticket's case: every vertex is on an axis, so every one of them
    // carried the epsilon in exactly one coordinate.
    src: 'cylinder(h=10,r=5,$fn=4);',
    openscad: [
      '-5 0 0',
      '-5 0 10',
      '0 -5 0',
      '0 -5 10',
      '0 5 0',
      '0 5 10',
      '5 0 0',
      '5 0 10',
    ],
  },
  {
    // n=8. Half on the axes, half at 45° — the `M_SQRT1_2` constant branch.
    src: 'cylinder(h=10,r=5,$fn=8);',
    openscad: [
      '-3.5355339059327378 -3.5355339059327378 0',
      '-3.5355339059327378 -3.5355339059327378 10',
      '-3.5355339059327378 3.5355339059327378 0',
      '-3.5355339059327378 3.5355339059327378 10',
      '-5 0 0',
      '-5 0 10',
      '0 -5 0',
      '0 -5 10',
      '0 5 0',
      '0 5 10',
      '3.5355339059327378 -3.5355339059327378 0',
      '3.5355339059327378 -3.5355339059327378 10',
      '3.5355339059327378 3.5355339059327378 0',
      '3.5355339059327378 3.5355339059327378 10',
      '5 0 0',
      '5 0 10',
    ],
  },
  {
    // n=13. A prime, so only vertex 0 is exact and the other twelve are pure
    // reduce-and-evaluate. 🔴 NOTE `0.6026834012766138` AND `0.6026834012766149`
    // — the same magnitude as two DIFFERENT doubles, and likewise
    // `2.8403237336557785`/`2.8403237336557807` and
    // `2.3236158602188417`/`2.323615860218843`. OpenSCAD computes each vertex
    // from its own angle and does not mirror one quadrant into the others; a
    // "symmetric" tessellation would be tidier and would not reproduce this.
    src: 'cylinder(h=10,r=5,$fn=13);',
    openscad: [
      '-1.7730244352126783 -4.675081213427074 0',
      '-1.7730244352126783 -4.675081213427074 10',
      '-1.7730244352126783 4.675081213427074 0',
      '-1.7730244352126783 4.675081213427074 10',
      '-3.742553740855505 -3.3156132912039764 0',
      '-3.742553740855505 -3.3156132912039764 10',
      '-3.742553740855505 3.3156132912039764 0',
      '-3.742553740855505 3.3156132912039764 10',
      '-4.85470908713026 -1.196578321437788 0',
      '-4.85470908713026 -1.196578321437788 10',
      '-4.85470908713026 1.196578321437788 0',
      '-4.85470908713026 1.196578321437788 10',
      '0.6026834012766138 -4.96354437049027 0',
      '0.6026834012766138 -4.96354437049027 10',
      '0.6026834012766149 4.96354437049027 0',
      '0.6026834012766149 4.96354437049027 10',
      '2.8403237336557785 4.114919329468282 0',
      '2.8403237336557785 4.114919329468282 10',
      '2.8403237336557807 -4.114919329468281 0',
      '2.8403237336557807 -4.114919329468281 10',
      '4.42728012826605 -2.3236158602188417 0',
      '4.42728012826605 -2.3236158602188417 10',
      '4.42728012826605 2.323615860218843 0',
      '4.42728012826605 2.323615860218843 10',
      '5 0 0',
      '5 0 10',
    ],
  },
  {
    // A cone: one ring plus an apex, so the `flat2` branch is exercised too.
    src: 'cylinder(h=10,r1=5,r2=0,$fn=4);',
    openscad: ['-5 0 0', '0 -5 0', '0 0 10', '0 5 0', '5 0 0'],
  },
  {
    // A sphere: the meridians go through the same `generate_circle`, and the
    // ring LATITUDE is its own degree expression. At $fn=4 there are 2 rings, at
    // 45° and 135°, so `8 · sin(45°) = 5.656854249492381` appears in all three
    // coordinates and any radian slip shows up in every one of them.
    src: 'sphere(r=8,$fn=4);',
    openscad: [
      '-5.656854249492381 0 -5.656854249492381',
      '-5.656854249492381 0 5.656854249492381',
      '0 -5.656854249492381 -5.656854249492381',
      '0 -5.656854249492381 5.656854249492381',
      '0 5.656854249492381 -5.656854249492381',
      '0 5.656854249492381 5.656854249492381',
      '5.656854249492381 0 -5.656854249492381',
      '5.656854249492381 0 5.656854249492381',
    ],
  },
];

test('every vertex OpenSCAD emits for these six curved primitives, reproduced exactly', () => {
  for (const c of CASES) {
    const want = new Map<string, number[]>();
    for (const line of c.openscad) {
      const v = line.split(/\s+/).map((t) => Math.fround(Number(t)));
      assert.equal(v.length, 3, `${c.src}: "${line}" is a 3-vector`);
      want.set(key(v), v);
    }
    const got = ourVertices(c.src);
    const gotKeys = new Set(got.map(key));

    for (const [k, v] of want) {
      if (gotKeys.has(k)) continue;
      // Name the nearest vertex we DID emit. "missing 0,5,10" alone would not
      // say whether the ring is offset, reversed, or carrying an epsilon, and
      // those need different fixes.
      let best = got[0];
      let bestD = Infinity;
      for (const g of got) {
        const d = Math.hypot(g[0] - v[0], g[1] - v[1], g[2] - v[2]);
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
      assert.fail(`${c.src}: we emit no vertex at ${k} — nearest of ours is ${key(best)}`);
    }
    assert.equal(
      got.length,
      want.size,
      `${c.src}: ${got.length} distinct vertices, OpenSCAD emits ${want.size}` +
        ` (extra: ${got.filter((g) => !want.has(key(g))).map(key).join(' ')})`,
    );
  }
});

test('the sphere ring latitudes are OpenSCAD\'s, in degrees', () => {
  // `primitives.cc:196-198`: phi = (180·(i+0.5))/rings, radius = r·sin(phi),
  // z = r·cos(phi). Asserted on the SET OF z VALUES rather than on whole
  // vertices, because that isolates the latitude expression from the meridian
  // one — a case that fails both would otherwise not say which.
  //
  // 🔴 WHAT THIS TEST DOES **NOT** CATCH, measured rather than assumed: the
  // radian/degree slip in the latitude itself. None of `$fn=12`'s six latitudes
  // is a quadrant, so the two forms differ in the last ulp of a double and
  // `Math.fround` erases it — plant 1 left this test GREEN. The degree form of
  // the latitude is covered by test 1's `sphere(r=8,$fn=4)`, whose rings ARE at
  // 45° and 135°. What this test is the control for is the off-by-one below.
  //
  // sphere(r=8,$fn=12): rings = (12+1)/2 = 6, so phi ∈ {15,45,75,105,135,165}.
  // openscad 2026.08.07, ascii STL, distinct z values, 2026-08-11:
  const wantZ = [
    -7.7274066103125465, -5.656854249492381, -2.070552360820166,
    2.070552360820166, 5.656854249492381, 7.7274066103125465,
  ].map(Math.fround);

  const gotZ = [...new Set(ourVertices('sphere(r=8,$fn=12);').map((v) => v[2]))].sort(
    (a, b) => a - b,
  );
  assert.deepEqual(gotZ, wantZ, 'the six ring latitudes of sphere(r=8,$fn=12)');

  // And the half-step placement itself: no ring sits at a pole, and none sits on
  // the equator for an even ring count. A `(180·i)/rings` slip — the obvious
  // off-by-one — would put one at z = +8 and is what this line refuses.
  assert.ok(
    gotZ.every((z) => Math.abs(z) < 8),
    `no ring is at a pole; got ${gotZ.map(show).join(' ')}`,
  );
});

test('the ring angle is (360*i)/n and it is in DEGREES — at double precision', () => {
  // 🔴 THE DOUBLE-PRECISION LAYER, AND IT IS NOT A LUXURY. Test 1 compares at
  // float32, which is where our vertices actually arrive — and `Math.fround`
  // absorbs a last-ulp double change, so test 1 goes GREEN on an argument-form
  // defect (measured: plant 2). `circlePoints` is exported so this layer is
  // reachable at all; it is the only door doubles leave `mesh.ts` through.

  // (a) The ring OpenSCAD emits for `cylinder(h=10,r=5,$fn=13)`, every vertex,
  //     at the full precision its ascii STL carries. A prime n, so exactly one
  //     vertex is exact and the other twelve are pure reduce-and-evaluate.
  //     `sort -u` of the STL's `vertex` lines at z=0, x/y only:
  const N13 = [
    '-1.7730244352126783 -4.675081213427074',
    '-1.7730244352126783 4.675081213427074',
    '-3.742553740855505 -3.3156132912039764',
    '-3.742553740855505 3.3156132912039764',
    '-4.85470908713026 -1.196578321437788',
    '-4.85470908713026 1.196578321437788',
    '0.6026834012766138 -4.96354437049027',
    '0.6026834012766149 4.96354437049027',
    '2.8403237336557785 4.114919329468282',
    '2.8403237336557807 -4.114919329468281',
    '4.42728012826605 -2.3236158602188417',
    '4.42728012826605 2.323615860218843',
    '5 0',
  ];
  // ⚠ `+ 0` normalises `-0` to `+0`. Our ring carries OpenSCAD's own signed
  // zeros (`5 * sinDegrees(180)` is `-0`, as in C++), but OpenSCAD's STL writer
  // prints them as `0`, so the ground truth cannot distinguish them here. The
  // sign is pinned in test 6 against the SVG writer, which does print it.
  const xy = (v: readonly number[]): string => `${v[0] + 0} ${v[1] + 0}`;
  assert.deepEqual(
    new Set(circlePoints(5, 0, 13).map(xy)),
    new Set(N13),
    'every vertex of the $fn=13 ring, at double precision',
  );

  // (b) Which discriminates `(360·i)/n` from the hoisted `i · (360/n)`. Both are
  //     the same real number; as doubles they differ on 7766 of the (n,i) pairs
  //     with 3 ≤ n ≤ 256, the first being n=13 i=7 — which is why n=13 is the
  //     case pinned above rather than a rounder one.
  let disagree = 0;
  let first: string | null = null;
  for (let n = 3; n <= 256; n++) {
    for (let i = 0; i < n; i++) {
      if ((360 * i) / n === i * (360 / n)) continue;
      disagree++;
      first ??= `n=${n} i=${i}`;
    }
  }
  assert.equal(first, 'n=13 i=7', 'the first (n,i) where the two forms differ');
  assert.equal(disagree, 7766, 'how many (n,i) pairs with 3 ≤ n ≤ 256 differ');
  //     …and the hoisted form really does miss OpenSCAD's value. Asserted as a
  //     NEGATIVE so that (a) cannot be satisfied by an implementation that
  //     happens to agree anyway — if this line ever goes green the discriminator
  //     is dead and (a) has stopped testing what it says it tests.
  assert.notEqual(
    5 * cosDegrees(7 * (360 / 13)),
    -4.85470908713026,
    'the hoisted form must NOT reproduce OpenSCAD vertex 7 of $fn=13',
  );

  // (c) Degrees rather than radians, as a PROPERTY over n rather than the
  //     `$fn=4` example: every quadrant vertex of every n that has one sits
  //     exactly on its axis, at every n a user can reach.
  for (const n of [4, 8, 12, 20, 36, 100, 200, 256]) {
    const ring = circlePoints(5, 0, n);
    for (let i = 0; i < n; i++) {
      const phi = (360 * i) / n;
      if (phi % 90 !== 0) continue;
      const [x, y] = ring[i];
      assert.ok(
        Math.abs(x) === 0 || Math.abs(x) === 5,
        `n=${n} i=${i} (${phi}°): x is ${show(x)}, want exactly 0 or ±5`,
      );
      assert.ok(
        Math.abs(y) === 0 || Math.abs(y) === 5,
        `n=${n} i=${i} (${phi}°): y is ${show(y)}, want exactly 0 or ±5`,
      );
    }
  }
});

test('the ring sweeps positive and starts on +X', () => {
  // ⚠ THIS IS HERE FOR THE OTHER HALF OF THE TICKET, not for the degrees: a
  // tessellation that is numerically exact but starts at a different vertex, or
  // runs the other way, produces a mesh that is CORRECT and compares as
  // DIFFERENT, and nothing else in this file would say so. It happens to fire
  // under plant 1 as well, because it pins coordinates rather than only an
  // order — that is a bonus, not its purpose, and it stayed green under plant 2
  // like every other assertion that reads `positions`.
  //
  // `generate_circle` runs i = 0 … n-1 with phi = (360·i)/n, so vertex 0 is at
  // 0° — on +X, not offset by half a step — and the sweep is towards +Y.
  const ring = ourVertices('cylinder(h=10,r=5,$fn=8);').filter((v) => v[2] === 10);
  assert.equal(ring.length, 8, 'eight vertices on the top ring');
  assert.deepEqual(ring[0], [5, 0, 10], 'vertex 0 is at 0°, on +X');
  const s = Math.fround(5 * Math.SQRT1_2);
  assert.deepEqual(ring[1], [s, s, 10], 'vertex 1 is at +45°, so the sweep is positive');
  assert.deepEqual(ring[2], [0, 5, 10], 'vertex 2 is at 90°');
});

test('no tessellation angle is ever NEAR a quadrant, so a snap cannot be caught here', () => {
  // 🔴 THIS TEST EXISTS TO STOP A FUTURE READER TRUSTING THIS FILE FOR
  // SOMETHING IT CANNOT SEE. The wrong-fix shape #97 caught — snap anything
  // within a tolerance of a quadrant — is invisible at these call sites, and
  // plant 3 confirmed it: all six tests stayed green with a 1e-9 snap in the
  // ring. The reason is structural rather than lucky, so it is measured here.
  //
  // The tessellation angles are {360i/n}. `|i/n − k/4| = |4i − kn|/(4n)`, so a
  // non-exact approach is at least `1/(4n)` — 360/(4n) degrees — and it only
  // REACHES that when `|4i − kn|` can be 1, i.e. when n is odd. ⚠ The tightest
  // case is therefore n=255, NOT n=256: at n=256 every `4i − 256k` is a multiple
  // of 4, so its nearest miss is four times wider. The first draft of this test
  // asserted 360/(4·256) from that reasoning and the run corrected it.
  let worst = Infinity;
  let worstAt = '';
  for (let n = 3; n <= 256; n++) {
    for (let i = 0; i < n; i++) {
      const phi = (360 * i) / n;
      const d = Math.abs(phi - 90 * Math.round(phi / 90));
      if (d > 0 && d < worst) {
        worst = d;
        worstAt = `n=${n} i=${i}`;
      }
    }
  }
  assert.equal(worstAt, 'n=255 i=64', 'where the closest non-exact approach happens');
  assert.ok(
    Math.abs(worst - 360 / (4 * 255)) < 1e-12,
    `closest approach ${worst}°, want 360/(4·255) = ${360 / (4 * 255)}°`,
  );
  assert.ok(worst > 0.35, `${worst}° of headroom — a snapping fix has nothing to corrupt here`);
  // ⇒ The control for the snapping wrong fix is `cad-degree-trig.test.ts`'s
  // "a near-quadrant angle stays near-quadrant and is NEVER snapped", asserted
  // on `cosDegrees` — the same helper these rings call, reached with a real
  // near-quadrant argument by a user-written `rotate([89.9999,0,0])`.
});

test('the 2D circle is the same ring, signed zero included', () => {
  // `circle` writes the loop out again in OpenSCAD (`primitives.cc:556-561`)
  // rather than calling `generate_circle`; the expression is identical, so here
  // it is one function and the 2D path cannot drift from the 3D one.
  //
  // Ground truth is the SVG writer, because it is the one OpenSCAD artefact that
  // PRINTS the sign of a zero. `openscad -o circ8.svg circ8.scad`, 2026-08-11,
  // with `circle(r=5,$fn=8);` — note SVG flips y:
  //
  //     M 5,-0 L 3.53553,-3.53553 L 0,-5 L -3.53553,-3.53553 L -5,0
  //           L -3.53553,3.53553 L -0,5 L 3.53553,3.53553 z
  //
  // `M 5,-0` is sin(0°) = +0 negated by the flip; `L -0,5` is the vertex at
  // 270°, whose x is cos(270°) = **-0** in OpenSCAD and in our helper.
  assert.ok(Object.is(5 * cosDegrees(270), -0), `cos(270°)·5 is -0, got ${show(5 * cosDegrees(270))}`);
  assert.ok(Object.is(5 * sinDegrees(0), 0), `sin(0°)·5 is +0, got ${show(5 * sinDegrees(0))}`);
  // ⚠ …and the sign does NOT survive to `positions` on either side: welding sums
  // coordinates and `-0 + 0` is `+0`, exactly as OpenSCAD's own STL writer emits
  // `vertex -5 0 10` for a coordinate whose C++ value is `-0.0`. So the mesh
  // surface below is compared as values, and the sign is pinned above, at the
  // only layer that still carries it.
  const s = Math.fround(5 * Math.SQRT1_2);
  const got = ourVertices('circle(r=5,$fn=8);');
  assert.deepEqual(
    new Set(got.map(key)),
    new Set(
      [
        [5, 0, 0], [s, s, 0], [0, 5, 0], [-s, s, 0],
        [-5, 0, 0], [-s, -s, 0], [0, -5, 0], [s, -s, 0],
      ].map(key),
    ),
    'the eight outline vertices of circle(r=5,$fn=8)',
  );
});
