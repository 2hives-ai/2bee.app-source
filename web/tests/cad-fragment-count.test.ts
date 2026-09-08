// How many segments a curve gets — `fragmentsRequested()` against OpenSCAD's
// `CurveDiscretizer::getCircularSegmentCount`.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE EXISTS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// `mesh.ts` decided the count with `Math.max(3, Math.floor(fn))`. OpenSCAD
// decides it with `ceil(fn >= 3 ? fn : 3)` — `src/core/CurveDiscretizer.cc:110`.
// It rounds **up**; we rounded **down**.
//
// 🔴 THE TWO AGREE AT EVERY INTEGER, WHICH IS WHY IT SURVIVED. Every `$fn` in
// `tools/scad_oracle/corpus/` is an integer, every `$fn` pinned by
// `cad-tessellation-degrees.test.ts` is an integer, and `hardware/cad/` writes
// integers. The defect exists only where nobody had a case, so the whole
// apparatus was green over it. **`$fn = 3` exactly is the worst case to test
// with**: `floor`, `ceil` and the `< 3` clamp all give 3 there, so a suite that
// pins `$fn = 3` is green on the defect *and* on its opposite.
//
// Two more differences went with it, both read at the source rather than
// inferred:
//
//   · The small-radius escape compared `r < 1e-6`. OpenSCAD compares
//     `r < GRID_FINE`, and `GRID_FINE` is `1/(1024*1024)` = 2⁻²⁰ =
//     9.5367431640625e-7 (`src/geometry/Grid.h:20`), which is SMALLER. Every
//     radius in `[2⁻²⁰, 1e-6)` fell to our escape and came out a triangle while
//     OpenSCAD tessellated it normally.
//
//   · A non-finite `$fn` is 3 in OpenSCAD (`isinf(fn) || isnan(fn)` ⇒ no
//     answer ⇒ the caller's `.value_or(3)`) and was **256** here — `Infinity`
//     went straight through the `fn > 0` test and hit the `MAX_FN` clamp, which
//     then warned that the source "asks for Infinity facets". Reachable without
//     trying: `$fn = 1e308*10`.
//
// ⚠ AND ONE NAMED DIFFERENCE THAT IS **NOT** A DEFECT — `$fe`. The brief that
// started this work listed "no `$fe` path at all" as the third divergence. It
// is not one, and implementing `$fe` would have CREATED a divergence. `$fe`
// sits behind `Feature::ExperimentalDiscretizationByError`, which `Feature.h`
// declares `enabled{false}`, and nothing in `tools/scad_oracle/openscad.mjs`
// passes `--enable`. Measured both ways on 2026-08-11 (test 5 below): plain
// `openscad 2026.08.07` ignores `$fe` completely; only
// `--enable=discretization-by-error` honours it. Doing nothing is the correct
// port. See `assert-on-the-emitted-program`: the flag's existence in the source
// is not its behaviour in the binary.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE EVERY NUMBER IN THIS FILE CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 EVERY EXPECTATION IS AN EXPORT FROM **openscad 2026.08.07**, taken on
// 2026-08-11. Nothing was read off our own output — an expectation taken from
// the code under test agrees with the defect it is supposed to catch, which is
// the sin `tools/scad_oracle/README.md` names.
//
//     # 3D — count DISTINCT vertices of the ascii STL (full double precision;
//     # `binstl` is float32 and would round the ground truth before we saw it)
//     $ echo 'cylinder(h=10,r=5,$fn=4.5);' > c.scad
//     $ openscad --export-format asciistl -o c.stl c.scad
//     $ grep vertex c.stl | sed 's/^ *vertex //' | sort -u | wc -l
//
//     # 2D — count the points of the SVG path
//     $ echo 'circle(r=10,$fn=4.5);' > c.scad
//     $ openscad -o c.svg c.scad
//
// 🔴 AND THE 2D READING NEEDS A STALE-FILE GUARD, because I got two wrong
// numbers before adding one. `openscad` leaves the PREVIOUS `out.svg` in place
// when it exits non-zero, so a loop that reads the file without checking the
// exit status reports the previous case's count as this one's. That is how
// `$fn = 1e400` first read as "3" and then as "30" in the same session: it is
// neither — the literal is out of range for OpenSCAD's lexer and the run is
// `ERROR: Parser error: syntax error`, exit 1, no file written. Every reading
// below was retaken with `rm -f out.svg` before the run and an existence check
// after it.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · OpenSCAD does not run here. These are FROZEN measurements with a date on
//     them; `tools/scad_oracle/` is the harness that runs the binary live.
//   · THE ORACLE CORPUS DOES NOT COVER THIS DEFECT AND DID NOT REPORT IT. The
//     brief said it was already visible there as `corpus/fn_clamped` and
//     `corpus/partial_fa_fs_{args,global}`; measured, none of the three is this
//     defect (`fn_clamped` is the `MAX_FN` clamp at an integer `$fn = 400`; the
//     two `partial_fa_fs` cases are a TREE-leg artefact in
//     `tools/scad_oracle/canon.mjs`, which prints our `$fa`/`$fs` as a
//     hard-coded 12/2 while their SOLIDS already agree). This file is the only
//     control that exists for the rounding direction.
//   · The comparison is at FLOAT32 in test 2 because `MeshPart.positions` is
//     where our vertices actually arrive. That does not weaken the COUNT
//     assertions: a fragment-count change alters the NUMBER of vertices, not
//     their precision, so `Math.fround` cannot absorb it — the trap that left
//     two of `cad-tessellation-degrees.test.ts`'s plants green does not exist
//     here, and the plant transcripts below are what say so rather than this
//     sentence.
//   · Partial arcs. OpenSCAD scales the count by `|angle|/360` and floors the
//     result at 1 for `rotate_extrude` and DXF arcs. This kernel refuses both,
//     so that limb is unported and untested — named here so the next reader
//     does not read this file as covering it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROLS — four plants, transcripts pasted from the real runs
// (2026-08-11). Each was applied to a THROWAWAY COPY of the tree in
// `/tmp`, never to the shared working tree, and the live `mesh.ts` sha256 was
// checked unchanged either side.
// ─────────────────────────────────────────────────────────────────────────────
//
//   PLANT 1 — `floor` restored: `Math.ceil(f.fn >= 3 ? f.fn : 3)` back to
//   `Math.max(3, Math.floor(f.fn))`. This is the defect itself.
//
//       not ok 1 - $fn rounds UP: the vertex count OpenSCAD gives, at every rung
//         error: |-
//           circle(r=10,$fn=3.0001);: 3 distinct vertices, OpenSCAD gives 4
//             (smallest fraction above the clamp)
//           3 !== 4
//       not ok 2 - the ring at $fn=4.5 is OpenSCAD's ring, vertex for vertex
//         error: 'cylinder(h=10,r=5,$fn=4.5);: we emit no vertex at
//                 -4.0450849533081055,-2.9389262199401855,0 — nearest of ours
//                 is -5,0,0'
//       ok 3 - the small-radius escape is at GRID_FINE, not at 1e-6
//       ok 4 - a non-finite $fn is 3, not a 256-gon
//       ok 5 - $fe is inert, and that is what the binary does too
//       ok 6 - the $fa/$fs path is unchanged
//       # pass 4  # fail 2
//
//   ⚠ THE RUNG THAT FIRES FIRST IS `$fn = 3.0001`, NOT the brief's `4.5`, and
//   that ordering is deliberate: the ladder is written from the clamp upwards
//   so the FIRST failure names the smallest fraction that separates the two
//   roundings. A failure reported at `4.5` would leave open whether everything
//   below it was fine.
//
//   PLANT 2 — the radius guard reverted: `r < GRID_FINE` back to `r < 1e-6`.
//
//       ok 1 - $fn rounds UP: the vertex count OpenSCAD gives, at every rung
//       ok 2 - the ring at $fn=4.5 is OpenSCAD's ring, vertex for vertex
//       not ok 3 - the small-radius escape is at GRID_FINE, not at 1e-6
//         error: |-
//           r=9.5367431640625e-7 (GRID_FINE EXACTLY — tessellates, because the
//             test is `<` not `<=`): 3 vertices, OpenSCAD gives 5
//           3 !== 5
//       ok 4 - a non-finite $fn is 3, not a 256-gon
//       ok 5 - $fe is inert, and that is what the binary does too
//       ok 6 - the $fa/$fs path is unchanged
//       # pass 5  # fail 1
//
//   PLANT 3 — the plausible WRONG FIX: `Math.round` instead of `Math.ceil`.
//   It is right at `$fn = 4.5` (`round(4.5) = 5`) and wrong everywhere the
//   fraction is below a half, which is why the rung ladder in test 1 is a
//   ladder and not the single case the brief named.
//
//       not ok 1 - $fn rounds UP: the vertex count OpenSCAD gives, at every rung
//         error: |-
//           circle(r=10,$fn=3.0001);: 3 distinct vertices, OpenSCAD gives 4
//             (smallest fraction above the clamp)
//           3 !== 4
//       ok 2 - the ring at $fn=4.5 is OpenSCAD's ring, vertex for vertex
//       ok 3 - the small-radius escape is at GRID_FINE, not at 1e-6
//       ok 4 - a non-finite $fn is 3, not a 256-gon
//       ok 5 - $fe is inert, and that is what the binary does too
//       ok 6 - the $fa/$fs path is unchanged
//       # pass 5  # fail 1
//
//   🔴 PLANT 3 LEAVES TEST 2 — THE WHOLE-RING TEST — GREEN, AND THAT IS THE
//   FINDING THE BRIEF'S SINGLE CASE WOULD HAVE MISSED. `$fn = 4.5` is the one
//   value the ticket named and the one value at which `round` and `ceil` agree,
//   so a file that pinned only the brief's example would have certified the
//   wrong fix as confidently as the right one.
//
//   PLANT 4 — the non-finite guard deleted: the
//   `if (f.fn !== null && !Number.isFinite(f.fn)) return 3;` line removed.
//
//       ok 1 - $fn rounds UP: the vertex count OpenSCAD gives, at every rung
//       ok 2 - the ring at $fn=4.5 is OpenSCAD's ring, vertex for vertex
//       ok 3 - the small-radius escape is at GRID_FINE, not at 1e-6
//       not ok 4 - a non-finite $fn is 3, not a 256-gon
//         error: |-
//           circle(r=10,$fn=1e308*10);: 256 distinct vertices, OpenSCAD gives 3
//           256 !== 3
//       ok 5 - $fe is inert, and that is what the binary does too
//       ok 6 - the $fa/$fs path is unchanged
//       # pass 5  # fail 1
//
// All four ran in a THROWAWAY COPY at `/tmp/.../plantcopy`; the live
// `web/src/cad/mesh.ts` read
// `18bb11367717a4beed0ef5329a92af990ea075732145cf58b75368e880509d26` before the
// first plant and after the last.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

const show = (x: number): string => (Object.is(x, -0) ? '-0' : String(x));
const key = (v: readonly number[]): string => v.map(show).join(',');

/** Every distinct vertex our pipeline puts into `MeshPart.positions`.
 *
 *  ⚠ DISTINCT VERTICES, NOT TRIANGLES, IS THE RIGHT INSTRUMENT HERE. A
 *  triangle count also moves with the fragment count, but it moves with the
 *  triangulation strategy too — the 2D fan and the 3D cap are different
 *  functions of `n` — so a triangle assertion would go red on a change that is
 *  not this one. The vertex count is `n` for a 2D circle, `2n` for a cylinder
 *  and `n · rings` for a sphere, and each of those is stated where it is used. */
function ourVertices(src: string): number[][] {
  const parsed = parseScad(src);
  assert.deepEqual(parsed.errors, [], `${src}: parsed without errors`);
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

const ourCount = (src: string): number => ourVertices(src).length;

// ---------------------------------------------------------------------------

test('$fn rounds UP: the vertex count OpenSCAD gives, at every rung', () => {
  // openscad 2026.08.07, 2026-08-11. `circle` counts are SVG path points;
  // `cylinder`/`sphere` counts are distinct ascii-STL vertices.
  //
  // The `was` column is what this file's own code produced BEFORE the fix,
  // recorded so a future reader can tell which rungs are load-bearing. It is
  // not asserted — asserting a historical wrong answer would pin the defect.
  const rungs: Array<{ src: string; openscad: number; was: number; why: string }> = [
    // ── the clamp region: `fn < 3` is 3 on both sides, in both roundings ──
    { src: 'circle(r=10,$fn=0.5);', openscad: 3, was: 3, why: 'below the clamp' },
    { src: 'circle(r=10,$fn=1);', openscad: 3, was: 3, why: 'below the clamp' },
    { src: 'circle(r=10,$fn=2);', openscad: 3, was: 3, why: 'below the clamp' },
    { src: 'circle(r=10,$fn=2.5);', openscad: 3, was: 3, why: 'below the clamp, non-integer' },
    {
      src: 'circle(r=10,$fn=2.9999);',
      openscad: 3,
      was: 3,
      // `ceil(2.9999)` is 3 and `floor` gives 2, but the `>= 3` test sends both
      // to the literal 3 first. The rounding never runs here.
      why: 'just below the clamp — the clamp answers, not the rounding',
    },
    {
      src: 'circle(r=10,$fn=3);',
      openscad: 3,
      was: 3,
      // 🔴 The case the brief warned about, kept BECAUSE it proves nothing:
      // floor, ceil and the clamp all agree at exactly 3. Its job in this
      // ladder is to be the rung that stays green under every plant, so a
      // reader can see that a green here is not evidence.
      why: 'exactly 3 — floor, ceil and the clamp all agree; proves nothing',
    },
    // ── above the clamp, where the rounding is the whole answer ──
    { src: 'circle(r=10,$fn=3.0001);', openscad: 4, was: 3, why: 'smallest fraction above the clamp' },
    { src: 'circle(r=10,$fn=3.2);', openscad: 4, was: 3, why: 'fraction below a half — kills Math.round' },
    { src: 'circle(r=10,$fn=4);', openscad: 4, was: 4, why: 'integer — control' },
    { src: 'circle(r=10,$fn=4.5);', openscad: 5, was: 4, why: "the brief's case; round and ceil AGREE here" },
    { src: 'circle(r=10,$fn=5.0000001);', openscad: 6, was: 5, why: 'a hair above an integer' },
    { src: 'circle(r=10,$fn=7.9);', openscad: 8, was: 7, why: 'fraction above a half' },
    // ── the same rounding, through the other two primitives ──
    // cylinder: 2 rings of n. 4.5 → n=5 → 10 vertices; floor gave n=4 → 8.
    { src: 'cylinder(h=10,r=5,$fn=4.5);', openscad: 10, was: 8, why: 'cylinder, 2 rings of n' },
    // sphere: rings = (n+1)/2 by integer division. 4.5 → n=5, rings=3 → 15;
    // floor gave n=4, rings=2 → 8. A WHOLE RING was missing, not just a facet.
    { src: 'sphere(r=10,$fn=4.5);', openscad: 15, was: 8, why: 'sphere, n × (n+1)/2 rings' },
    { src: 'sphere(r=10,$fn=7.1);', openscad: 32, was: 28, why: 'sphere, n=8 rings=4 against n=7 rings=4' },
  ];

  for (const r of rungs) {
    assert.equal(
      ourCount(r.src),
      r.openscad,
      `${r.src}: ${ourCount(r.src)} distinct vertices, OpenSCAD gives ${r.openscad} (${r.why})`,
    );
  }
});

test("the ring at $fn=4.5 is OpenSCAD's ring, vertex for vertex", () => {
  // A count can be right for the wrong reason — n segments placed at the wrong
  // angles is the same count. These are the exact `sort -u` vertex lines of
  // openscad 2026.08.07's ascii STL, verbatim, 2026-08-11.
  const cases: Array<{ src: string; openscad: string[] }> = [
    {
      src: 'cylinder(h=10,r=5,$fn=4.5);',
      openscad: [
        '-4.045084971874737 -2.938926261462366 0',
        '-4.045084971874737 -2.938926261462366 10',
        '-4.045084971874737 2.938926261462366 0',
        '-4.045084971874737 2.938926261462366 10',
        '1.545084971874737 -4.755282581475767 0',
        '1.545084971874737 -4.755282581475767 10',
        '1.545084971874737 4.755282581475767 0',
        '1.545084971874737 4.755282581475767 10',
        '5 0 0',
        '5 0 10',
      ],
    },
    {
      // The middle ring (phi = 90°) is the one `floor` deleted entirely.
      src: 'sphere(r=10,$fn=4.5);',
      openscad: [
        '-4.045084971874737 -2.938926261462366 -8.660254037844386',
        '-4.045084971874737 -2.938926261462366 8.660254037844386',
        '-4.045084971874737 2.938926261462366 -8.660254037844386',
        '-4.045084971874737 2.938926261462366 8.660254037844386',
        '-8.090169943749475 -5.877852522924732 0',
        '-8.090169943749475 5.877852522924732 0',
        '1.545084971874737 -4.755282581475767 -8.660254037844386',
        '1.545084971874737 -4.755282581475767 8.660254037844386',
        '1.545084971874737 4.755282581475767 -8.660254037844386',
        '1.545084971874737 4.755282581475767 8.660254037844386',
        '10 0 0',
        '3.090169943749474 -9.510565162951535 0',
        '3.090169943749474 9.510565162951535 0',
        '5 0 -8.660254037844386',
        '5 0 8.660254037844386',
      ],
    },
  ];

  for (const c of cases) {
    const want = new Map<string, number[]>();
    for (const line of c.openscad) {
      const v = line.split(/\s+/).map((t) => Math.fround(Number(t)));
      want.set(key(v), v);
    }
    const got = ourVertices(c.src);
    const gotKeys = new Set(got.map(key));
    for (const [k, v] of want) {
      if (gotKeys.has(k)) continue;
      // Name the nearest vertex we DID emit: "missing X" alone would not say
      // whether the ring is short, offset or rotated, and those need different
      // fixes.
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

test('the small-radius escape is at GRID_FINE, not at 1e-6', () => {
  // 🔴 THE RADIUS IS SCALED UP BY 1e7 AFTER TESSELLATION, AND THAT IS NOT A
  // TRICK. `scale()` transforms the polygon OpenSCAD has already built, so the
  // vertex count is decided at the true radius and only then made readable in
  // an SVG export. Without it the SVG writer rounds every coordinate to the
  // same string and the points cannot be counted at all.
  //
  // openscad 2026.08.07, `scale([1e7,1e7]) circle(r=R)`, SVG path points,
  // 2026-08-11. GRID_FINE = 1/(1024*1024) = 9.5367431640625e-7.
  const rungs: Array<{ r: string; openscad: number; why: string }> = [
    { r: '9.0e-7', openscad: 3, why: 'clearly below GRID_FINE — both sides escape' },
    {
      r: '9.53674316406249e-7',
      openscad: 3,
      why: 'ONE ULP BELOW GRID_FINE — the last radius that escapes',
    },
    {
      r: '9.5367431640625e-7',
      openscad: 5,
      // 🔴 The comparison is `<`, so the boundary value itself tessellates.
      // "A limit solved to equality is the first value that does not work":
      // an escape written `r <= GRID_FINE` would be wrong HERE and nowhere
      // else, and the ulp rung above is what separates the two.
      why: 'GRID_FINE EXACTLY — tessellates, because the test is `<` not `<=`',
    },
    { r: '9.6e-7', openscad: 5, why: 'inside the [GRID_FINE, 1e-6) band the old guard swallowed' },
    { r: '9.9e-7', openscad: 5, why: 'inside the band' },
    { r: '1.0e-6', openscad: 5, why: 'the old guard boundary — right by luck, `<` excluded it' },
    { r: '1.1e-6', openscad: 5, why: 'above both' },
  ];

  for (const g of rungs) {
    const src = `scale([1e7,1e7]) circle(r=${g.r});`;
    assert.equal(
      ourCount(src),
      g.openscad,
      `r=${g.r} (${g.why}): ${ourCount(src)} vertices, OpenSCAD gives ${g.openscad}`,
    );
  }
});

test('a non-finite $fn is 3, not a 256-gon', () => {
  // `CurveDiscretizer.cc:104` — `isinf(fn) || isnan(fn)` returns no answer at
  // all, and all three primitive call sites spell the default `.value_or(3)`.
  //
  // ⚠ THE ROUTE MATTERS, AND `1e400` IS A DIFFERENT ROUTE — see the intake test
  // below. Overflow by ARITHMETIC is the route both implementations carry all
  // the way to this function, and it is the one pinned here. Measured:
  // `circle(r=10,$fn=1e308*10)` exports 3 SVG points.
  for (const src of ['circle(r=10,$fn=1e308*10);', 'circle(r=10,$fn=1e200*1e200);']) {
    assert.equal(ourCount(src), 3, `${src}: ${ourCount(src)} distinct vertices, OpenSCAD gives 3`);
  }

  // 🔴 NaN REACHES THIS FUNCTION, AND THE NOTE THAT SAID IT COULD NOT WAS WRONG
  // IN THE MOST EXPENSIVE WAY: it named the ONE route that is blocked. It read
  // *"NaN cannot reach this function: `scad.ts` maps any `$fn` that is not
  // `> 0` to `null`, and `NaN > 0` is false … it is moot anyway"*. `0/0` really
  // is refused outright (asserted below, and it is why nobody noticed), but
  // `sqrt(-1)` and `acos(2)` are not refused and produce a NaN with no
  // diagnostic at all. Measured 2026-08-11 on openscad 2026.08.07:
  // `circle(r=10,$fn=sqrt(-1))` is **3** SVG points; before the intake fix this
  // gave **30**, because the NaN fell through to $fa/$fs. A guard whose only
  // justification is a refusal made somewhere else has already stopped holding
  // by the time anyone re-reads it.
  for (const src of ['circle(r=10,$fn=sqrt(-1));', 'circle(r=10,$fn=acos(2));', 'circle(r=10,$fn=log(-1));']) {
    assert.equal(ourCount(src), 3, `${src}: ${ourCount(src)} distinct vertices, OpenSCAD gives 3`);
  }

  // The blocked route, kept as the control: a literal division by zero is a
  // hard parse error here, so it never becomes a NaN in the first place.
  const nan = parseScad('circle(r=10,$fn=0/0);');
  assert.equal(nan.errors.length, 1, '$fn=0/0 is refused by the parser, not tessellated');

  // A NEGATIVE $fn falls to $fa/$fs on both sides: OpenSCAD's constructor
  // clamps `fn < 0` to 0 with a warning (`CurveDiscretizer.cc:36-39`) and
  // `scad.ts` maps it to `null` — and now emits OpenSCAD's warning verbatim,
  // which is the half that was missing. Measured: `circle(r=10,$fn=-3)` is 30
  // points, with `WARNING: $fn negative - setting to 0`.
  assert.equal(ourCount('circle(r=10,$fn=-3);'), 30, '$fn=-3 falls to $fa/$fs, as OpenSCAD does');
  assert.deepEqual(
    parseScad('circle(r=10,$fn=-3);').warnings.map((w) => w.message),
    ['$fn negative - setting to 0'],
    'the negative-$fn clamp happens silently — OpenSCAD says it out loud',
  );
  // -Infinity is the same branch, not the `isinf` one: OpenSCAD clamps it to 0
  // BEFORE `getCircularSegmentCount` ever sees it, so it is 30 and not 3.
  assert.equal(ourCount('circle(r=10,$fn=-1e308*10);'), 30, '-inf $fn is clamped to 0, not treated as non-finite');
});

/**
 * The `$fn` INTAKE — `scad.ts`, not `fragmentsRequested`. Two divergences that
 * were latent when they were filed and are pinned here at the point they enter,
 * so the reason does not depend on an unrelated refusal staying where it is.
 *
 * 🔴 A NUMERIC LITERAL THAT OVERFLOWS IS NOT ONE BEHAVIOUR IN OPENSCAD, IT IS
 * TWO, AND THEY ARE IN DIFFERENT FLEX RULES (`src/core/lexer.l`):
 *
 *   FLOAT FORM (`1e400`, `1.0e400`) — `lexer.l:301-308` wraps
 *   `boost::lexical_cast<double>` in a try whose catch block is EMPTY, so the
 *   rule returns no token and the literal is deleted from the stream with no
 *   message. Whether that is fatal depends entirely on where it sat, and the
 *   answers are not the ones a reader would guess. Measured 2026-08-11,
 *   openscad 2026.08.07:
 *       cube(1e400);              → the DEFAULT 1mm cube, 12 facets, exit 0
 *                                   (`cube()` with no argument still parses)
 *       echo(1e400);              → `ECHO: `   exit 0   (echo of nothing)
 *       circle(r=10,$fn=1e400);   → `ERROR: Parser error: syntax error`, exit 1,
 *                                   nothing exported
 *       x = 1e400;                → the same syntax error: `x = ;` does not
 *                                   parse, and OpenSCAD refuses the WHOLE FILE
 *
 *   INTEGER FORM (a 400-digit run of nines) — `lexer.l:309-322` always returns
 *   a token; `strtoull` saturates and the value becomes ULLONG_MAX. Measured:
 *       echo(<400 nines>); → `WARNING: Integer "999…" cannot be represented
 *                             precisely` then `ECHO: 1.84467e+19`
 *
 * `parseFloat` returns `Infinity` for both, so before this fix `$fn=1e400`
 * tessellated a circle in a file OpenSCAD refuses to parse at all.
 */
test('the $fn intake: an overflowing literal is not a number, and the two forms differ', () => {
  // Float form, in a position where the missing token is fatal — as it is in
  // OpenSCAD. The refusal must be a PARSE error, not a tessellated shape.
  const fatal = parseScad('circle(r=10,$fn=1e400);');
  assert.equal(fatal.errors.length, 1, '$fn=1e400 parsed as if it were a number');
  assert.equal(meshScene(fatal.scene).parts.filter((p) => p.triangles > 0).length, 0, 'geometry from a refused parse');
  assert.match(
    fatal.warnings.map((w) => w.message).join('\n'),
    /overflows to infinity/,
    'the token vanished with no explanation — the one thing this file bans',
  );

  // An assignment is fatal too, for the same reason — `x = ;`.
  assert.equal(parseScad('x = 1e400;\ncube(10);').errors.length, 1, 'x = 1e400 must not parse');

  // Float form, in a position where the deletion still parses. OpenSCAD emits
  // the DEFAULT 1mm cube here (`cube()` takes no required argument), exit 0 —
  // so we must too, and a refusal would be its own divergence.
  const survivable = parseScad('cube(1e400);');
  assert.deepEqual(survivable.errors, [], 'a dropped literal in an optional position must not fail the file');
  const unit = meshScene(survivable.scene).parts.filter((p) => p.triangles > 0);
  assert.equal(unit.length, 1, 'the default cube was lost');
  assert.equal(unit[0].bounds!.max[0], 1, `openscad exports the unit cube here; we exported ${unit[0].bounds!.max[0]}`);
  assert.equal(survivable.warnings.length, 1, 'the dropped literal was not reported');

  // Integer form: a token, a warning, and NOT infinity.
  const big = parseScad(`cube(${'9'.repeat(400)});`);
  assert.deepEqual(big.errors, [], 'an integer literal past the double range is not a parse error in OpenSCAD');
  assert.match(big.warnings.map((w) => w.message).join('\n'), /cannot be represented precisely/);
  const cube = meshScene(big.scene).parts.filter((p) => p.triangles > 0);
  assert.equal(cube.length, 1, 'the saturated integer produced no cube');
  assert.ok(
    Number.isFinite(cube[0].bounds!.max[0]) && cube[0].bounds!.max[0] === 2 ** 64,
    `the integer form must saturate at ULLONG_MAX (2^64), got ${cube[0].bounds!.max[0]}`,
  );
});

/**
 * ⚠ A NON-FINITE `$fa`/`$fs` IS DELIBERATELY NOT MATCHED, and the reason is that
 * OpenSCAD's own answer there is undefined behaviour rather than a rule.
 * `fa < F_MINIMUM` and `fs < F_MINIMUM` are both false for NaN, so the NaN
 * survives into the arithmetic and the count is `static_cast<int>` of a
 * non-finite double. Measured 2026-08-11, SVG path points:
 *     circle(r=10,$fa=sqrt(-1));  →  1     ← a one-point circle
 *     circle(r=10,$fs=sqrt(-1));  → 30
 *     circle(r=10,$fa=1e308*10);  →  5
 *     circle(r=10,$fs=1e308*10);  →  5
 * A one-point circle is not a behaviour to port. We use the documented default
 * and SAY SO on the warning line, because a silent substitution is
 * indistinguishable from having read the source correctly.
 */
test('a non-finite $fa/$fs uses the default AND names the substitution', () => {
  for (const [src, key] of [
    ['circle(r=10,$fa=sqrt(-1));', '$fa'],
    ['circle(r=10,$fs=sqrt(-1));', '$fs'],
    ['circle(r=10,$fa=1e308*10);', '$fa'],
  ] as const) {
    const parsed = parseScad(src);
    assert.equal(ourCount(src), 30, `${src}: the defaults must govern, giving the ordinary 30-point circle`);
    assert.match(
      parsed.warnings.map((w) => w.message).join('\n'),
      new RegExp(`\\${key} is (nan|infinite)`),
      `${src}: the default was substituted silently`,
    );
    assert.match(
      parsed.warnings.map((w) => w.message).join('\n'),
      /OpenSCAD's own answer here is undefined/,
      `${src}: the warning does not say this is OUR choice rather than OpenSCAD's`,
    );
  }
});

test('$fe is inert, and that is what the binary does too', () => {
  // 🔴 THIS TEST ASSERTS THE ABSENCE OF A FEATURE, ON PURPOSE. `$fe` is real in
  // OpenSCAD's source and unreachable in its default build:
  // `Feature::ExperimentalDiscretizationByError` is declared `enabled{false}`
  // (`src/Feature.h:50`), the `$fe` read in `CurveDiscretizer`'s
  // Parameters+Location constructor is gated on `is_enabled()`, and
  // `tools/scad_oracle/openscad.mjs` passes no `--enable`.
  //
  // Measured 2026-08-11, `circle(r=10, $fe=0.1)`, SVG path points:
  //     openscad -o out.svg c.scad                            → 30
  //     openscad --enable=discretization-by-error -o out.svg  → 23
  //
  // 30 is the plain $fa/$fs answer with `$fe` ignored. So porting `$fe` would
  // move us from agreement to disagreement with the binary we are checked
  // against. If this test ever goes red because someone implemented `$fe`, the
  // question to answer FIRST is whether the oracle now passes `--enable` —
  // and if it does not, the implementation is the regression, not this test.
  for (const src of ['circle(r=10,$fe=0.1);', '$fe=0.1;\ncircle(r=10);', 'circle(r=10,$fe=0.001);']) {
    assert.equal(ourCount(src), 30, `${src}: $fe must not change the count while the feature is off`);
  }
});

test('the $fa/$fs path is unchanged', () => {
  // The `$fn` branch is not the only one that was touched: the small-radius
  // escape sits above BOTH branches, so this is the regression control for the
  // half of the function that was already right.
  //
  // ⚠ THE SOURCE'S FORM IS `ceil(max(min(a,b), 5))` AND OURS IS
  // `max(5, ceil(min(a,b)))`. They are the same value for every input — if
  // `x >= 5` then `ceil(x) >= 5` and both give `ceil(x)`; if `x < 5` both give
  // 5 — and this test is what keeps that claim from being only an argument.
  //
  // openscad 2026.08.07, 2026-08-11. `circle` = SVG points; the 3D rows =
  // distinct ascii-STL vertices.
  const rungs: Array<{ src: string; openscad: number; why: string }> = [
    { src: 'circle(r=10);', openscad: 30, why: 'defaults: min(360/12, 10·2π/2) = 30' },
    { src: 'circle(r=10,$fa=5,$fs=0.5);', openscad: 72, why: '$fa governs: 360/5' },
    {
      src: 'circle(r=10,$fa=0);',
      openscad: 32,
      // OpenSCAD clamps `$fa < 0.01` to 0.01 with a warning
      // (`CurveDiscretizer.cc:47`); `scad.ts` already does the same at parse
      // time, in OpenSCAD's own wording. 360/0.01 = 36000, so $fs wins at 32.
      why: '$fa clamped to F_MINIMUM, so $fs governs: ceil(10·2π/2) = 32',
    },
    { src: 'circle(r=10,$fs=0.005);', openscad: 30, why: '$fs clamped to F_MINIMUM, $fa governs' },
    { src: 'circle(r=1,$fs=0.1);', openscad: 30, why: 'small r, $fa still governs' },
    // 316 = 2 rings × 158. The number `scad.ts`'s own header cites for the
    // defect that made $fa/$fs work at all — pinned here so it stays a fact.
    { src: '$fa=1;$fs=0.2;\ncylinder(h=10,r=5);', openscad: 316, why: 'globals, $fs governs: 158 sides' },
    // 2592 = 72 meridians × 36 rings.
    { src: 'sphere(r=10,$fa=5,$fs=0.5);', openscad: 2592, why: 'sphere, n=72 rings=36' },
  ];

  for (const g of rungs) {
    assert.equal(
      ourCount(g.src),
      g.openscad,
      `${g.src}: ${ourCount(g.src)} distinct vertices, OpenSCAD gives ${g.openscad} (${g.why})`,
    );
  }
});
