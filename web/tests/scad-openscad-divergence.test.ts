// Regression tests for the silent divergences between `web/src/cad/scad.ts` +
// `mesh.ts` and real OpenSCAD — the class of defect where a construct is
// ACCEPTED and then interpreted differently, with no diagnostic.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE EVERY NUMBER IN THIS FILE CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 EVERY EXPECTATION BELOW WAS TAKEN FROM **OpenSCAD 2026.08.07** AT
// `/usr/local/bin/openscad`, NOT FROM READING OUR OWN CODE. The commands are
// recorded per case so any of them can be re-run:
//
//   openscad -o out.csg  probe.scad     # the evaluated tree, every default resolved
//   openscad -o out.stl  probe.scad     # the solid; volume by signed-tetrahedron sum
//   openscad -o out.echo probe.scad     # expression semantics
//
// A test whose expectation was derived from our own output would agree with the
// defect it is supposed to catch. Where our answer legitimately differs from
// OpenSCAD's — three cases, all in `describes the divergences that REMAIN` —
// the OpenSCAD result is written down beside ours so the difference stays a
// decision rather than becoming an assumption.
//
// ✅ EXERCISED: the real `scad.ts` and the real `mesh.ts`, through `parseScad`
// and `meshScene`, on real sources. No scene tree is hand-written, because a
// hand-written one lets a wrong expectation agree with a wrong implementation.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · OpenSCAD itself does not run here. These are FROZEN measurements with a
//     date on them, and a future OpenSCAD could move one. `tools/scad_oracle/`
//     is the harness that runs the binary live; this file is the fast check
//     that does not need it installed.
//   · Nothing in `CadTab.tsx`. In particular `ScadResult.warnings`, asserted
//     here in nine places, IS RENDERED BY NOTHING — see the type's own note.
//   · The three-dimensional correctness of the CSG kernel. Volume is compared,
//     which is an invariant, not a proof of shape.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROL — four plants, and the first one came back GREEN
// ─────────────────────────────────────────────────────────────────────────────
//
// A suite that has only ever been green is not evidence. Each fix was reverted
// in place, the suite re-run, and the output recorded. Transcripts, 2026-08-11:
//
//   PLANT 1 — `eval`'s `case 'refused'` returns `undefined` again (the pre-fix
//   line, in place of `return FAILED`):
//
//       # pass 36  # fail 0        ← 🔴 THE PLANT DID NOT FIRE
//
//   🔴 THIS IS THE MOST USEFUL LINE IN THE FILE. Thirty-six tests covering the
//   sentinel, and not one of them reached the `refused` EXPRESSION node: every
//   probe got to `FAILED` through `fnCall` (an unknown function), so a whole
//   producer of the sentinel — `let()`, list comprehensions, swizzles — was
//   asserted by nothing while the suite read as covering it. The test named
//   `EVERY route to a failed value is probed` was written in response, one row
//   per producer, and only then:
//
//       not ok 2 - EVERY route to a failed value is probed, not just the one that was reported
//       # pass 36  # fail 1
//
//   PLANT 2 — `cylinder` reads `center` from the named map only again:
//       not ok 16 - cylinder(h, r1, r2, center) — the fourth positional is center
//       # pass 36  # fail 1
//
//   PLANT 3 — `execBlock`'s assignment pre-pass removed, assignments execute in
//   source order again:
//       not ok 19 - the LAST assignment in a scope governs the whole scope, in every scope
//       not ok 20 - a re-assigned name keeps its FIRST position and takes its LAST expression
//       # pass 35  # fail 2
//
//   PLANT 4 — `mesh.ts` counts kernel refusals only, as it did before:
//       not ok 7  - a model with a parser refusal in it is not trusted, whatever the triangles say
//       not ok 37 - describes the divergences that REMAIN, with what OpenSCAD does instead
//       # pass 35  # fail 2
//
// All four were removed and the suite returned to 37 passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad, sceneLines } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

// --- helpers ---------------------------------------------------------------

/** The scene tree as flat text, one node per line, root dropped. */
function tree(src: string): string[] {
  return sceneLines(parseScad(src).scene)
    .slice(1)
    .map((l) => `${'  '.repeat(l.depth - 1)}${l.text}`);
}

/** Signed volume of every 3D part, in mm³ — the invariant compared against
 *  OpenSCAD's exported STL. Triangle COUNT is deliberately not the assertion
 *  after a boolean: BSP splitting produces a different triangulation of the
 *  same solid, and asserting the count would fail on a correct result. */
function solid(src: string): {
  triangles: number;
  volume: number;
  trust: string;
  refusals: number;
  errors: number;
  warnings: number;
  issues: string[];
} {
  const parsed = parseScad(src);
  const mesh = meshScene(parsed.scene);
  let volume = 0;
  for (const p of mesh.parts) {
    if (p.dim !== 3) continue;
    const a = p.positions;
    for (let i = 0; i < p.triangles * 9; i += 9) {
      volume +=
        (a[i] * (a[i + 4] * a[i + 8] - a[i + 5] * a[i + 7]) -
          a[i + 1] * (a[i + 3] * a[i + 8] - a[i + 5] * a[i + 6]) +
          a[i + 2] * (a[i + 3] * a[i + 7] - a[i + 4] * a[i + 6])) /
        6;
    }
  }
  return {
    triangles: mesh.stats.triangles,
    volume,
    trust: mesh.trust,
    refusals: parsed.unsupported.length,
    errors: parsed.errors.length,
    warnings: parsed.warnings.length,
    issues: mesh.issues.map((i) => `${i.severity}:${i.name}`),
  };
}

const near = (got: number, want: number, tol = 1e-4): void => {
  assert.ok(
    Math.abs(got - want) <= tol,
    `expected ${want} (OpenSCAD), got ${got} — difference ${Math.abs(got - want)}`,
  );
};

// ---------------------------------------------------------------------------
// 1. A refused expression REMOVES the node. It does not resize it.
//    `docs/openscad-feature-inventory.md` §3 — five measured forms.
// ---------------------------------------------------------------------------

test('a refused expression REMOVES the node, it does not resize it', () => {
  // `undef` is what an OMITTED argument looks like to `??`. A refusal must not
  // be able to look like one, or a named refusal quietly becomes a 1 mm part.
  //
  // ⚠ THE EXAMPLE MOVED ON 2026-08-11 AND THE PROPERTY DID NOT. This test used
  // to use `function sq(x) = x*x; cube(sq(3));`, which is now IMPLEMENTED and
  // agrees with OpenSCAD at 27 mm³ — see `scad-stage0.test.ts`. Deleting the
  // test would have taken the property with the example; it is re-anchored on
  // `hull()`, which is still refused and still has a subtree.
  const s = solid('cube(hull(3));');
  assert.equal(s.triangles, 0, 'a 1 mm cube here is the defect: a refused call is not an omitted argument');
  assert.ok(s.refusals >= 2, 'the refused call and the primitive that could not be built are both named');
  assert.equal(s.trust, 'nothing');
});

test('EVERY route to a failed value is probed, not just the one that was reported', () => {
  // ⚠ THIS TEST EXISTS BECAUSE THE FIRST PLANT CAME BACK GREEN. Restoring the
  // pre-fix `return undefined` in `eval`'s `case 'refused'` changed nothing in
  // this suite, because every probe above reaches `FAILED` through `fnCall`
  // (an unknown function) and none of them reached the `refused` EXPRESSION
  // node at all. The rows below are one per producer, so a plant on any single
  // one of them turns this file red.
  //
  // ⚠ TWO ROWS WERE RETIRED ON 2026-08-11 BECAUSE THEY STOPPED BEING REFUSALS:
  // `let()` and a user function call are implemented. They are NOT simply
  // deleted — a producer with no row is exactly the hole this test was written
  // to close — they moved to `scad-stage0.test.ts` as agreement assertions, and
  // `each(...)` took `let()`'s place as the still-refused expression node.
  const routes: [string, string][] = [
    ['refused expression node — each()', 'cube(each([1,2,3]));'],
    ['refused expression node — list comprehension', 'cube([for (i = [0:2]) i]);'],
    ['refused expression node — multi-component swizzle', 'v = [1,2,3];\ncube(v.xy);'],
    ['refused module used as a function', 'cube(hull(3));'],
    ['unknown function', 'cube(str(3));'],
    ['undefined variable', 'cube(q);'],
    ['binary type failure', 'cube("a" + 1);'],
    ['division by zero', 'cube(1/0);'],
    ['failed range', 'cube([1,2,3][q]);'],
  ];
  for (const [why, src] of routes) {
    assert.equal(solid(src).triangles, 0, `${why}: a 1 mm cube here is the defect (${JSON.stringify(src)})`);
  }
});

test('a refused FUNCTION result does not reach a primitive default', () => {
  // Every primitive, not just `cube` — patching one call site is how this
  // comes back through the next parameter anyone adds.
  //
  // ⚠ The refused function used to be a USER function (`function f(x) = x;`),
  // which is implemented now. `str()` is a real OpenSCAD function this subset
  // does not have, so it is refused BY NAME and is the same shape of input.
  for (const src of [
    'sphere(str(5));',
    'cylinder(h = str(5), r = 2);',
    'square(str(5));',
    'circle(str(5));',
    'cube([str(5), 1, 1]);',
  ]) {
    assert.equal(solid(src).triangles, 0, `drew geometry for a refused argument: ${src}`);
  }
});

test('an arithmetic failure does not reach a primitive default', () => {
  // openscad: `a = 1/0; cube(a);` → cube(size = [inf, inf, inf]).
  // Ours has no `inf`, so it draws NOTHING and says so. What it must never do
  // again is draw a 1 mm cube with no diagnostic at all, which is what it did.
  const s = solid('a = 1 / 0;\ncube(a);');
  assert.equal(s.triangles, 0);
  assert.ok(s.errors >= 1, 'division by zero must be reported, it used to be silent');

  // openscad: `d = [1,2,3] * [1,2,3];` → 14 (dot product) → a 14 mm cube.
  // Ours refuses the operator; it must not fall back to 1 mm.
  assert.equal(solid('d = [1,2,3] * [1,2,3];\ncube(d);').triangles, 0);
});

test('a failed expression does not silently pick the other branch of a ternary', () => {
  // openscad -o out.stl: `a = "a" < "b" ? 3 : 7; cube(a);` → 27 mm³ (string
  // comparison is lexical there). Ours cannot compare strings — so the answer
  // is "no answer", and it must NOT be 343 mm³, which is what silently taking
  // the false branch produced.
  const s = solid('a = "a" < "b" ? 3 : 7;\ncube(a);');
  assert.equal(s.volume, 0);
  assert.notEqual(s.volume, 343);
});

test('a failed condition does not silently pick the else branch of an if', () => {
  const s = solid('if ("a" < "b") cube(3); else cube(7);');
  assert.equal(s.volume, 0);
});

// ---------------------------------------------------------------------------
// 2. `trust` is a function of the PARSE as well as the mesh.
// ---------------------------------------------------------------------------

test('a model with a parser refusal in it is not trusted, whatever the triangles say', () => {
  // 🔴 HULL AND MINKOWSKI ARE NOW IMPLEMENTED (2026-08-17). The old test
  // expected 1 refusal (hull refused) and volume = 1000 (just the cube).
  // Now both produce geometry. The test uses `hulls()` as the refused
  // construct instead.
  const s = solid('hulls() cube(5);\ncube(10);');
  near(s.volume, 1000);
  assert.equal(s.refusals, 1);
  assert.equal(s.trust, 'suspect');
});

test('a parse ERROR also blocks `trusted` — a discarded span can hide a construct', () => {
  const s = solid('cube(10);\nthis is not scad;\n');
  near(s.volume, 1000);
  assert.ok(s.errors >= 1);
  assert.equal(s.trust, 'suspect');
});

test('a tree with no parse report is audited as UNKNOWN, never as clean', () => {
  // The fix must not be arm-able-or-not by the caller. A hand-built tree — the
  // only way to reach `meshScene` without the parser's report — is capped at
  // `suspect`, and the result says which input was missing.
  const hand = {
    kind: 'group' as const,
    label: 'hand-built',
    line: 1,
    children: [
      {
        kind: 'primitive' as const,
        line: 1,
        params: { kind: 'cube' as const, size: [10, 10, 10] as [number, number, number], center: false },
      },
    ],
  };
  const m = meshScene(hand);
  assert.equal(m.parts[0].audit!.verdict, 'closed', 'the MESH is fine — that is the point');
  assert.equal(m.trust, 'suspect');
  assert.equal(m.sourceDiagnostics, null);
  assert.match(m.trustDetail, /UNKNOWN/);
});

test('a clean model still reaches `trusted`, so the gate can go green as well as red', () => {
  const m = meshScene(parseScad('difference() { cube(20); translate([5,5,-1]) cube(10); }').scene);
  assert.equal(m.trust, 'trusted');
  assert.deepEqual(m.sourceDiagnostics, { refusals: 0, errors: 0, warnings: 0 });
});

// ---------------------------------------------------------------------------
// 3. `$fa` / `$fs` — implemented, in BOTH forms.
// ---------------------------------------------------------------------------

test('$fa/$fs govern tessellation as arguments AND as assignments', () => {
  // openscad -o out.stl, both forms: 628 facets, volume 785.1912.
  // Before: 60 triangles / 16 sides, silently, in both forms — a bore ~0.1 mm
  // undersize against what the source specifies.
  for (const src of [
    'cylinder(h = 10, r = 5, $fa = 1, $fs = 0.2);',
    '$fa = 1;\n$fs = 0.2;\ncylinder(h = 10, r = 5);',
  ]) {
    const s = solid(src);
    assert.equal(s.triangles, 628, src);
    near(s.volume, 785.1912, 1e-3);
    assert.equal(s.refusals, 0, '$fa/$fs are implemented now, not refused');
  }

  // openscad -o out.stl: `sphere(r=10,$fa=5,$fs=0.5)` → 5180 facets, 4175.5179.
  const sph = solid('sphere(r = 10, $fa = 5, $fs = 0.5);');
  assert.equal(sph.triangles, 5180);
  near(sph.volume, 4175.5179, 1e-3);
});

test('$fa/$fs are dynamically scoped, like $fn', () => {
  const inner = solid('module ring() { cylinder(h = 10, r = 5); }\nring($fa = 1, $fs = 0.2);');
  assert.equal(inner.triangles, 628);
});

test('$fa/$fs below 0.01 are clamped and the clamp is reported, as OpenSCAD does', () => {
  // openscad: `WARNING: $fs too small - clamping to 0.010000`.
  const p = parseScad('$fa = 0.001;\n$fs = 0.001;\nsphere(1);');
  assert.equal(p.warnings.filter((w) => /too small - clamping/.test(w.message)).length, 2);
});

test('a facet count clamped by MAX_FN is reported whichever control produced it', () => {
  // ⚠ THE POINT OF THIS TEST IS THE SECOND HALF. `$fa`/`$fs` opened a second
  // route to a huge facet count, and the clamp note used to fire only on an
  // explicit `$fn` — so the new route would have been clamped in silence.
  const byFn = solid('sphere(5, $fn = 400);');
  assert.ok(byFn.issues.some((i) => i.startsWith('warning:sphere()')));
  const byFa = solid('$fa = 1;\n$fs = 0.1;\nsphere(5);'); // asks for 315 facets
  assert.ok(
    byFa.issues.some((i) => i.startsWith('warning:sphere()')),
    'a clamp reported on one path and silent on the other reads as coverage',
  );
});

// ---------------------------------------------------------------------------
// 4-5. `cylinder` positional arguments.
// ---------------------------------------------------------------------------

test('cylinder(h, r1, r2) is a cone — the third positional is r2, not r1', () => {
  // openscad -o out.csg: `cylinder(20,10,4)` → h=20, r1=10, r2=4.
  // openscad -o out.stl: 116 facets, volume 3243.4224. Ours drew r1=10, r2=10.
  assert.deepEqual(tree('cylinder(20, 10, 4);'), ['cylinder h 20 mm, r1 10 mm, r2 4 mm']);
  near(solid('cylinder(20, 10, 4);').volume, 3243.4224, 1e-3);
});

test('cylinder(h, r1, r2, center) — the fourth positional is center', () => {
  // openscad -o out.csg: `cylinder(20,10,4,true)` → center = true, Z −10…+10.
  // Ours read `center` from the NAMED map only, so the part sat h/2 off datum.
  assert.deepEqual(tree('cylinder(20, 10, 4, true);'), ['cylinder h 20 mm, r1 10 mm, r2 4 mm, centered']);
  const m = meshScene(parseScad('cylinder(20, 10, 4, true);').scene);
  near(m.parts[0].bounds!.min[2], -10);
  near(m.parts[0].bounds!.max[2], 10);
});

test('an unspecified cylinder radius defaults to 1, NOT to the other radius', () => {
  // ⚠ Not in the divergence audit — found while probing it.
  // openscad -o out.csg: `cylinder(10,5)` → r1 = 5, **r2 = 1**. A cone.
  // Ours drew r1 = 5, r2 = 5: a straight cylinder, silently.
  assert.deepEqual(tree('cylinder(10, 5);'), ['cylinder h 10 mm, r1 5 mm, r2 1 mm']);
  assert.deepEqual(tree('cylinder(h = 10, r1 = 5);'), ['cylinder h 10 mm, r1 5 mm, r2 1 mm']);
  assert.deepEqual(tree('cylinder(h = 10, d1 = 8);'), ['cylinder h 10 mm, r1 4 mm, r2 1 mm']);
  // openscad -o out.stl: `cylinder(10,5,$fn=8)` → 28 facets, volume 292.2708.
  near(solid('cylinder(10, 5, $fn = 8);').volume, 292.2708, 1e-3);
});

test('cylinder radius precedence: general first, then per-side, and d beats r', () => {
  // All four probed with `openscad -o out.csg`.
  assert.deepEqual(tree('cylinder(h = 10, r = 5, r1 = 2);'), ['cylinder h 10 mm, r1 2 mm, r2 5 mm']);
  assert.deepEqual(tree('cylinder(h = 10, r1 = 2, d = 8);'), ['cylinder h 10 mm, r1 2 mm, r2 4 mm']);
  assert.deepEqual(tree('cylinder(h = 20, r = 10, d = 4);'), ['cylinder h 20 mm, r1 2 mm, r2 2 mm']);
  assert.deepEqual(tree('cylinder(h = 20, d1 = 10, d2 = 4);'), ['cylinder h 20 mm, r1 5 mm, r2 2 mm']);
  // OpenSCAD warns `Cylinder parameters ambiguous` on the first two.
  assert.equal(parseScad('cylinder(h = 10, r = 5, r1 = 2);').warnings.length, 1);
  assert.equal(parseScad('cylinder(h = 20, d1 = 10, d2 = 4);').warnings.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Assignment order — the last assignment in a scope wins for the whole scope.
// ---------------------------------------------------------------------------

test('the LAST assignment in a scope governs the whole scope, in every scope', () => {
  // Each row probed with `openscad -o out.csg`; ours took the first assignment
  // and produced the number in the comment.
  const cases: [string, string[]][] = [
    // was `cube size [1,1,1]`
    ['x = 1;\ncube(x);\nx = 2;', ['cube size [2, 2, 2] mm']],
    // was `cube size [10,10,10]` — a 50 mm cube read as a 10 mm cube
    [
      'w = 10;\nmodule part() { cube([w,w,w]); }\npart();\nw = 50;',
      ['module part of 1', '  cube size [50, 50, 50] mm'],
    ],
    // was `cube size [1,1,1]`
    ['{ u = 1; cube([u,1,1]); u = 7; }', ['block of 1', '  cube size [7, 1, 1] mm']],
    // was `cube size [1,1,1]` — the `if` took the wrong branch
    ['d = 4;\nif (d > 5) cube(100); else cube(1);\nd = 9;', ['cube size [100, 100, 100] mm']],
  ];
  for (const [src, want] of cases) assert.deepEqual(tree(src), want, src);
});

test('a re-assigned name keeps its FIRST position and takes its LAST expression', () => {
  // 🔴 This is the pair that rules out both simpler implementations.
  // openscad -o out.csg on each:
  assert.deepEqual(tree('a = 1;\nb = a + 1;\na = 5;\ncube([b,1,1]);'), ['cube size [6, 1, 1] mm']);
  //   ↑ 6, not 2: `b` sees the final value of `a`, so "evaluate in source order"
  //     is wrong. ↓ undef, not 6: `b` is evaluated where it was FIRST written,
  //     before `a` exists, so "move re-assignments to the bottom" is wrong too.
  assert.equal(solid('b = a + 1;\na = 1;\na = 5;\ncube([b,1,1]);').triangles, 0);
  assert.deepEqual(tree('a = 1;\nb = a + 1;\na = 5;\nc = a + b;\ncube([c,1,1]);'), ['cube size [11, 1, 1] mm']);
});

test('an overwritten assignment is reported per line, naming the variable and both lines', () => {
  // OpenSCAD: `WARNING: "w" was assigned on line 1 but was overwritten in file
  // a2.scad, line 4`. We said nothing at all; the tab carried only a standing
  // sentence about the tool, which tells the user the class and never the
  // instance.
  const w = parseScad('w = 10;\nmodule part() { cube([w,w,w]); }\npart();\nw = 50;').warnings;
  assert.equal(w.length, 1);
  assert.equal(w[0].line, 4);
  assert.match(w[0].message, /"w" was assigned on line 1 but was overwritten on line 4/);
});

// ---------------------------------------------------------------------------
// 7-8. Coercions.
// ---------------------------------------------------------------------------

test('translate(scalar) is a no-op, as in OpenSCAD, and says so', () => {
  // openscad -o out.csg: `translate(5) cube(1);` →
  //   WARNING: Unable to convert translate(5) parameter to a vec3 or vec2
  //   multmatrix([[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]) { cube(...) }
  // Ours translated by [5,5,5]: a diagonal displacement from a line OpenSCAD
  // ignores.
  assert.deepEqual(tree('translate(5) cube(1);'), ['translate [0, 0, 0] mm', '  cube size [1, 1, 1] mm']);
  assert.equal(parseScad('translate(5) cube(1);').unsupported.length, 1);
  // `scale(2)` and `rotate(45)` DO take a scalar in OpenSCAD — probed — so the
  // fix must be specific to `translate`.
  assert.deepEqual(tree('scale(2) cube(1);'), ['scale [2, 2, 2]', '  cube size [1, 1, 1] mm']);
  assert.deepEqual(tree('rotate(45) cube(1);'), ['rotate [0, 0, 45] deg', '  cube size [1, 1, 1] mm']);
  assert.deepEqual(tree('translate([1,2]) cube(1);'), ['translate [1, 2, 0] mm', '  cube size [1, 1, 1] mm']);
});

test('a size vector of the wrong length falls back to 1 mm and is named', () => {
  // openscad: `cube([10,20])` and `cube([10,20,30,40])` both →
  //   WARNING: Unable to convert … → cube(size = [1,1,1]).
  // Ours padded to [10,20,1] and truncated to [10,20,30]: quiet and plausible,
  // where OpenSCAD's fallback is loud and obviously wrong on a screen.
  for (const src of ['cube([10,20]);', 'cube([10,20,30,40]);']) {
    assert.deepEqual(tree(src), ['cube size [1, 1, 1] mm'], src);
    assert.equal(parseScad(src).unsupported.length, 1, src);
  }
  // `square([10,20,30])` → square(size = [1,1]) (probed).
  assert.deepEqual(tree('square([10,20,30]);'), ['square size [1, 1] mm (2D)']);
  assert.deepEqual(tree('square([10,20]);'), ['square size [10, 20] mm (2D)']);
  assert.deepEqual(tree('cube([10,20,30]);'), ['cube size [10, 20, 30] mm']);
});

// ---------------------------------------------------------------------------
// 9-10. Module argument binding.
// ---------------------------------------------------------------------------

test('a named argument consumes the positional slot it overrides', () => {
  // openscad -o out.csg: `module m(a=1,b=2,c=3){cube([a,b,c]);} m(10, a=99);`
  //   WARNING: argument "a" overrides positional argument
  //   cube(size = [99, 2, 3])
  // Ours bound [99, 10, 3]: the 10 was written for `a`, was overridden, and
  // then slid down onto `b`.
  const src = 'module m(a=1,b=2,c=3) { cube([a,b,c]); }\nm(10, a=99);';
  assert.deepEqual(tree(src), ['module m of 1', '  cube size [99, 2, 3] mm']);
  assert.match(parseScad(src).warnings[0].message, /overrides positional argument/);
});

test('the binding forms that already agreed still agree', () => {
  const body = 'module m(a=1,b=2,c=3) { cube([a,b,c]); }\n';
  const want = (v: string) => ['module m of 1', `  cube size ${v} mm`];
  assert.deepEqual(tree(body + 'm(10,20,30);'), want('[10, 20, 30]'));
  assert.deepEqual(tree(body + 'm(b=20);'), want('[1, 20, 3]'));
  assert.deepEqual(tree(body + 'm(10,c=30);'), want('[10, 2, 30]'));
  assert.deepEqual(tree(body + 'm(c=30,10);'), want('[10, 2, 30]'));
  assert.deepEqual(tree(body + 'm(10,20,30,40);'), want('[10, 20, 30]'));
});

test('a module default that names a sibling parameter is undef, as in OpenSCAD', () => {
  // openscad: `module n(a, b=a*2) { cube([a,b,1]); } n(4);` →
  //   WARNING: Ignoring unknown variable "a" … undefined operation …
  //   cube(size = [4, 1, 1])   ← undef substituted with 1
  // Ours evaluated the default in the half-filled call frame and drew
  // [4, 8, 1] — 8× in Y, from the more USEFUL reading of a file that carries
  // OpenSCAD's meaning. See `describes the divergences that REMAIN` for what
  // ours does now.
  const p = parseScad('module n(a, b=a*2) { cube([a,b,1]); }\nn(4);');
  assert.ok(p.errors.some((e) => /variable a is not defined/.test(e.message)));
  assert.equal(meshScene(p.scene).stats.triangles, 0, 'anything but 0 means the default was evaluated in the frame');
});

// ---------------------------------------------------------------------------
// 11-13. round, $fn scoping, ranges, and the two missing builtins.
// ---------------------------------------------------------------------------

test('round() rounds a half AWAY FROM ZERO, as C does, not toward +infinity', () => {
  // openscad -o out.echo: `echo(round(-0.5), round(-1.5), round(2.5), round(-2.5));`
  //   ECHO: -1, -2, 3, -3        ← ours was 0, -1, 3, -2
  const got = [-0.5, -1.5, 2.5, -2.5, 0.5, 1.5, -0.4, 0.4].map(
    (n) => (tree(`cube([round(${n}) + 100, 1, 1]);`)[0].match(/\[(-?[\d.]+)/) ?? [])[1],
  );
  assert.deepEqual(got, ['99', '98', '103', '97', '101', '102', '100', '100']);
});

test('$fn on a transform or a boolean reaches the children', () => {
  // openscad -o out.stl, both: 20 facets, volume 116.9134. Ours dropped the
  // argument and drew the default 16 sides — a hex boss coming out round.
  for (const src of [
    'translate([0,0,0], $fn = 6) cylinder(h = 5, r = 3);',
    'union($fn = 6) { cylinder(h = 5, r = 3); }',
  ]) {
    const s = solid(src);
    assert.equal(s.triangles, 20, src);
    near(s.volume, 116.9134, 1e-3);
  }
});

test('a for-range yields OpenSCAD\'s item count, to the last ulp', () => {
  // Counts from `openscad -o out.echo` with `for (i = R) echo(i);`.
  // The first row is the one that used to produce a 5th iteration: one extra
  // hole at the end of a patterned row.
  const counts: [string, number][] = [
    ['[1:0.05:1.2]', 4],
    ['[0:0.1:0.3]', 4],
    ['[0:0.1:1]', 11],
    ['[0:0.3:1]', 4],
    ['[0:2:5]', 3],
    ['[10:-2:4]', 4],
    ['[0:3]', 4],
    ['[0.1:0.1:0.5]', 5],
    ['[1:0.1:1.3]', 4],
    ['[0:-1:5]', 0],
    ['[5:1:0]', 0],
    ['[1000:0.3:1300]', 1001],
  ];
  for (const [range, want] of counts) {
    const p = parseScad(`for (i = ${range}) cube(1);`);
    const got = p.scene.children.length ? (p.scene.children[0] as { children: unknown[] }).children.length : 0;
    assert.equal(got, want, `for (i = ${range})`);
  }
});

test('PI is a builtin, not an undefined user variable', () => {
  // openscad -o out.csg: `cube([PI,1,1])` → cube(size = [3.14159, 1, 1]).
  // Ours reported `variable PI is not defined here`, blaming the user for a
  // typo where the truth was a missing builtin — and then drew a 1 mm cube.
  assert.deepEqual(tree('cube([PI,1,1]);'), ['cube size [3.142, 1, 1] mm']);
  assert.equal(parseScad('cube([PI,1,1]);').errors.length, 0);
  assert.deepEqual(tree('PI = 2;\ncube([PI,1,1]);'), ['cube size [2, 1, 1] mm'], 'a user assignment still wins');
});

test('^ is exponentiation, with OpenSCAD\'s precedence and associativity', () => {
  // openscad -o out.echo: `echo(2^3, -2^2, 2^3^2, 2^-1);` → 8, -4, 512, 0.5.
  // Ours reported `unexpected character "^"` and then DISCARDED the rest of the
  // statement, which can hide a second construct in the skipped span.
  assert.deepEqual(tree('cube([2^3,1,1]);'), ['cube size [8, 1, 1] mm']);
  assert.deepEqual(tree('cube([-2^2 + 100,1,1]);'), ['cube size [96, 1, 1] mm']);
  assert.deepEqual(tree('cube([2^3^2,1,1]);'), ['cube size [512, 1, 1] mm']);
  assert.deepEqual(tree('cube([2^-1,1,1]);'), ['cube size [0.5, 1, 1] mm']);
  assert.equal(parseScad('cube([2^3,1,1]);').errors.length, 0);
});

// ---------------------------------------------------------------------------
// 14-15. The four modifier characters and the pass-through modules.
// ---------------------------------------------------------------------------

test('! renders ONLY the marked subtree — it used to render everything else', () => {
  // openscad -o out.stl: `!cube(5); sphere(1);` → 12 facets, volume 125 (the
  // CUBE). Ours dropped the cube and drew the sphere: the opposite object.
  const s = solid('!cube(5);\nsphere(1);');
  assert.equal(s.triangles, 12);
  near(s.volume, 125);
  // Probed: the marked subtree loses its ANCESTORS too — `translate([50,0,0])
  // !cube(5);` emits a bare `cube`, with no multmatrix.
  assert.deepEqual(tree('translate([50,0,0]) !cube(5);\nsphere(1);'), ['cube size [5, 5, 5] mm']);
  // Probed: `WARNING: More than one Root Modifier (!)`, and the FIRST wins.
  const many = parseScad('!cube(5);\n!sphere(3);\ncylinder(h=2,r=1);');
  assert.deepEqual(sceneLines(many.scene).slice(1).map((l) => l.text), ['cube size [5, 5, 5] mm']);
  assert.match(many.warnings[0].message, /More than one Root Modifier/);
});

test('# is real geometry — it cuts the hole it is written on', () => {
  // openscad -o out.stl: `difference(){cube(20); #translate([10,10,-1])
  // cylinder(h=30,r=4,$fn=16);}` → 80 facets, volume 7020.3304.
  // Ours refused the modifier, dropped the subtree, and produced 12 facets: an
  // UNCUT block. Triangle count is not asserted — the BSP triangulates a
  // correct solid differently — the volume is.
  const s = solid('difference() { cube(20); #translate([10,10,-1]) cylinder(h=30,r=4,$fn=16); }');
  near(s.volume, 7020.3304, 1e-3);
  assert.equal(s.refusals, 0);
});

test('% is excluded from the geometry, which is what OpenSCAD exports', () => {
  const s = solid('difference() { cube(20); %translate([10,10,-1]) cylinder(h=30,r=4); }');
  near(s.volume, 8000, 1e-3);
  assert.equal(s.refusals, 1, 'the ghost OpenSCAD would show in preview is what is missing, and it is named');
});

test('* disables the subtree exactly, in both tools', () => {
  assert.deepEqual(tree('*cube(5);\nsphere(1, $fn=8);'), ['sphere r 1 mm, $fn 8']);
});

test('color() and render() pass their geometry through instead of deleting it', () => {
  // 🔴 The highest-yield row in this file. Measured by `tools/scad_oracle` over
  // `hardware/cad/` — the 68 .scad files this company cuts — `color()` was 198
  // of 360 refusal sites across 36 files, and a refused node takes its whole
  // subtree with it: `color("red") part();` did not lose the colour, it deleted
  // the part.
  // openscad -o out.stl: `color("red") cube(3);` → 12 facets, volume 27.
  const c = solid('color("red") cube(3);');
  near(c.volume, 27);
  assert.equal(c.refusals, 0);
  near(solid('render() cube(4);').volume, 64);
  near(solid('color([0,1,0,0.5]) render() color("blue") cube(2);').volume, 8);
});

// ---------------------------------------------------------------------------
// The divergences that REMAIN. Written down so they stay decisions.
// ---------------------------------------------------------------------------

test('describes the divergences that REMAIN, with what OpenSCAD does instead', () => {
  // 1. `undef` inside a size vector. OpenSCAD substitutes 1 and warns:
  //    `cube([20,20,undef])` → cube(size = [20,20,1]). We draw NOTHING and say
  //    why. Deliberate: a dimension the user did not write is the one thing
  //    that must not reach a spindle quietly.
  assert.equal(solid('cube([20,20,undef]);').triangles, 0);

  // 2. An undefined variable. OpenSCAD warns and continues with undef;
  //    we raise an error and draw nothing. Same reason.
  assert.equal(solid('cube([q,1,1]);').triangles, 0);

  // 3. `1/0` and `[1,2,3]*[1,2,3]`. OpenSCAD has `inf` and a dot product; we
  //    have neither, and refuse rather than substitute. Covered above.

  // 4. `rotate(a, v)` is REFUSED AND THE SUBTREE IS STILL EMITTED, UNROTATED.
  //    ⚠ This one is not safe in the way the others are: the volume and the
  //    surface area are correct to 1.6e-16, so no volume-based check can ever
  //    see it — only the tree and the bounding box can. It is named in the
  //    refusal list and nowhere else. NOT fixed here; out of this change's
  //    scope, and recorded so the next reader does not take the passing volume
  //    for agreement.
  const p = parseScad('rotate(a = 90, v = [1,0,0]) cube([20,6,6]);');
  assert.equal(p.unsupported.length, 1);
  near(meshScene(p.scene).parts[0].bounds!.max[1], 6, 1e-9); // OpenSCAD: 6 in Z, not in Y
  assert.equal(meshScene(p.scene).trust, 'suspect', 'at least it is no longer `trusted`');

  // 5. `$fn` above 256 is clamped by `mesh.ts`; OpenSCAD does not clamp.
  //    Disclosed by a warning issue, asserted above.
});
