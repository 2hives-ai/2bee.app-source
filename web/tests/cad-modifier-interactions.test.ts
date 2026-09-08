// The four OpenSCAD modifier characters WHERE THEY MEET EACH OTHER — `*`, `!`,
// `#`, `%` combined on one statement, nested inside one another, and reached
// through a module call.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS SEPARATELY FROM `scad-openscad-divergence.test.ts`
// ─────────────────────────────────────────────────────────────────────────────
//
// That file asserts each modifier ALONE, and every one of its four modifier
// tests stayed green through all four defects fixed here. So did the oracle:
// `tools/scad_oracle/corpus/edge_modifier_{disable,root,highlight,background}
// .scad` are one modifier each, on one statement, and all four scored SAME
// before and after. 🔴 A CORPUS THAT COVERS EVERY CHARACTER AND NO COMBINATION
// OF THEM IS NOT COVERAGE OF THE CHARACTERS — the whole defect class lived in
// the combinations, and nothing could see it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE EVERY NUMBER CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 EVERY EXPECTATION WAS TAKEN FROM **OpenSCAD 2026.08.07** (the binary at
// `/usr/local/bin/openscad`, source at `/home/gbacs/apps/openscad` @ `2328d12c3a`)
// ON 2026-08-11, by running each source twice:
//
//   openscad -o out.csg  probe.scad     # the evaluated tree
//   openscad -o out.stl  probe.scad     # the solid; volume by signed-tetrahedron sum
//
// and comparing against our own `parseScad` → `meshScene`. Reading our code and
// writing down what it does would have produced a suite that agrees with the
// defect. Where OpenSCAD's stderr matters it is quoted verbatim.
//
// The three source rules behind all of it, read rather than inferred:
//
//   src/core/parser.y:236-252
//     '!' module_instantiation { $$ = $2; if ($$) $$->tag_root = true; }
//     '#' module_instantiation { $$ = $2; if ($$) $$->tag_highlight = true; }
//     '%' module_instantiation { $$ = $2; if ($$) $$->tag_background = true; }
//     '*' module_instantiation { delete $2; $$ = NULL; }
//   ⇒ `*` DELETES the instantiation, so a `!`/`#`/`%` on the same statement has
//     nothing to tag. The `if ($$)` guard is the entire interaction rule.
//   ⇒ the other three MUTATE one instantiation, so `!!x` is one node tagged
//     twice, not two roots.
//
//   src/core/node.cc:184 `find_root_tag`
//     depth-first over the INSTANTIATED tree; the FIRST tagged node wins; a
//     second one on a DIFFERENT `modinst` sets `nextLocation`, which
//     src/openscad.cc:437 turns into `WARNING: More than one Root Modifier (!)`.
//   ⇒ an ancestor's `%` or `#` is not consulted at all: a `!` inside a `%`
//     subtree still becomes the model.
//
//   src/geometry/GeometryEvaluator.cc:309,392,577,893
//     `if (chnode->modinst->isBackground()) continue;` — a background CHILD is
//     skipped. Nothing checks the flag on the ROOT node.
//   ⇒ `%` on the node `find_root_tag` selects is ignored, and `!%cube(5);`
//     exports the cube.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROL — four plants, each reverting one fix, all watched red
// ─────────────────────────────────────────────────────────────────────────────
//
// Each fix was reverted in place in `scad.ts`, nothing else changed, and the
// suite re-run. Transcripts, 2026-08-11, verbatim `not ok` lines only:
//
//   PLANT 1 — the `!` branch wraps unconditionally again (both guards removed):
//       not ok 1 - `*` annihilates a `!` written on the same statement …
//       not ok 2 - `!!x` is ONE instantiation tagged twice, not two roots …
//       # tests 13  # pass 11  # fail 2
//
//   PLANT 2 — `case 'root'` drops its `inRootBody` branch, so a nested `!` is
//   taken for the first one again:
//       not ok 3 - a `!` nested inside a `!` keeps the OUTER subtree, whole …
//       not ok 4 - a nested `!` deeper than one level keeps the transforms …
//       # tests 13  # pass 11  # fail 2
//
//   PLANT 3 — `%` discards its body at parse time again:
//       not ok 6 - a `!` inside a `%` subtree still governs the whole model
//       not ok 7 - a `!` reached only through a module call inside `%` …
//       not ok 8 - `%` on the node that BECOMES the root is ignored …
//       # tests 13  # pass 10  # fail 3
//   ⚠ Plant 3 reddens THREE, not the two it aims at: with the body gone,
//   `!%cube(5)` has nothing left to unwrap either. Recorded rather than tidied
//   — a plant that fires wider than predicted is telling you the two fixes
//   share a dependency, and that is worth knowing before either is changed.
//
//   PLANT 4 — `case 'root'` stops unwrapping a `background` body:
//       not ok 8 - `%` on the node that BECOMES the root is ignored …
//       # tests 13  # pass 12  # fail 1
//
// ⚠ Tests 5, 9, 10, 11, 12 and 13 stayed GREEN under all four plants, which is
// the point of listing them: they are the ones asserting that nothing MOVED,
// and a plant that reddened them would mean a fix had reached further than its
// own case.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · OpenSCAD does not run here. These are FROZEN measurements with a date.
//     `tools/scad_oracle/` is the harness that runs the binary live.
//   · Nothing in `CadTab.tsx`. `ScadResult.warnings` is asserted below in four
//     places and IS RENDERED BY NOTHING — see the type's own note. A warning
//     this file proves correct is still a warning no operator sees.
//   · The `%` search's budget residual: if `MAX_NODES`/`MAX_LOOP_ITERATIONS`
//     halts the search before it reaches a `!` buried inside a `%` subtree,
//     that `!` is not honoured and nothing says so. No file in `hardware/cad/`
//     contains a `!` at all, so this cannot cut a wrong part today.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad, sceneLines } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');

// --- helpers ---------------------------------------------------------------

/** The scene tree as flat text, one node per line, program root dropped. */
function tree(src: string): string[] {
  return sceneLines(parseScad(src).scene)
    .slice(1)
    .map((l) => `${'  '.repeat(l.depth - 1)}${l.text}`);
}

/**
 * Signed volume of every 3D part, in mm³ — the invariant compared against
 * OpenSCAD's exported STL. Triangle COUNT is deliberately not asserted after a
 * boolean: the BSP triangulates the same solid differently and a count
 * assertion would fail on a correct result.
 */
function solid(src: string): {
  volume: number;
  parts: number;
  refusals: string[];
  warnings: string[];
  errors: number;
} {
  const parsed = parseScad(src);
  const mesh = meshScene(parsed.scene);
  let volume = 0;
  let parts = 0;
  for (const p of mesh.parts) {
    if (p.dim !== 3 || p.triangles === 0) continue;
    parts++;
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
    volume,
    parts,
    refusals: parsed.unsupported.map((u) => `${u.line}:${u.name}`),
    warnings: parsed.warnings.map((w) => w.message),
    errors: parsed.errors.length,
  };
}

const near = (got: number, want: number, tol = 1e-4): void => {
  assert.ok(
    Math.abs(got - want) <= tol,
    `expected ${want} (OpenSCAD), got ${got} — difference ${Math.abs(got - want)}`,
  );
};

// A 20 mm sphere at $fn=16 — the "rest of the file", chosen because its volume
// (31418.6836) cannot be confused with any cube in this file.
const REST = 'sphere(20, $fn=16);';
const REST_VOLUME = 31418.6836;

// ---------------------------------------------------------------------------
// 1. `*` beats `!`, on either side, because it deletes the instantiation
// ---------------------------------------------------------------------------

test('`*` annihilates a `!` written on the same statement — the rest of the file renders', () => {
  // openscad -o out.stl `!*cube(5); sphere(20,$fn=16);` → 252 facets, volume
  // 31418.6836: the SPHERE. `*` deleted the instantiation, so `if ($$)` was
  // false and no root tag exists anywhere in the file.
  //
  // 🔴 THIS FILE USED TO EXPORT NOTHING AT ALL — no error, no warning, no
  // refusal, an empty viewport — because `!` wrapped the disabled statement and
  // an empty root subtree is still a root subtree.
  const a = solid(`!*cube(5);\n${REST}`);
  near(a.volume, REST_VOLUME, 1e-3);
  assert.deepEqual(a.refusals, []);
  assert.deepEqual(a.warnings, []);

  // Same the other way round (`*!x`), which already agreed, and on a group
  // rather than a primitive — probed as four separate files.
  near(solid(`* !cube(5);\n${REST}`).volume, REST_VOLUME, 1e-3);
  near(solid(`!*union() { cube(5); }\n${REST}`).volume, REST_VOLUME, 1e-3);
  near(solid(`*!union() { cube(5); }\n${REST}`).volume, REST_VOLUME, 1e-3);

  // And a `!` INSIDE a `*` subtree goes with it: the whole instantiation, scope
  // included, is deleted before any tag can be found.
  near(solid(`*union() { !cube(5); }\n${REST}`).volume, REST_VOLUME, 1e-3);
  // Including when the `!` is in a module body the `*`'d call would have run.
  near(solid(`module m() { !cube(5); }\n*m();\n${REST}`).volume, REST_VOLUME, 1e-3);
});

test('`!!x` is ONE instantiation tagged twice, not two roots — and OpenSCAD does not warn', () => {
  // openscad: `!!cube(5); sphere(20,$fn=16);` → 12 facets, volume 125, and
  // stderr is EMPTY. The "more than one" check compares `modinst` pointers and
  // both `!`s re-ran the same production on the same `$2`.
  const s = solid(`!!cube(5);\n${REST}`);
  near(s.volume, 125);
  assert.deepEqual(s.warnings, [], 'OpenSCAD emits no warning here, so neither does this');
  assert.deepEqual(tree(`!!cube(5);\n${REST}`), ['cube size [5, 5, 5] mm']);
  // `**x` likewise: the second `*` deletes an already-null instantiation.
  near(solid(`**cube(5);\n${REST}`).volume, REST_VOLUME, 1e-3);
});

// ---------------------------------------------------------------------------
// 2. A `!` nested inside another `!`
// ---------------------------------------------------------------------------

test('a `!` nested inside a `!` keeps the OUTER subtree, whole, and warns', () => {
  // openscad -o out.csg:
  //   union() { cube(size = [5,5,5], …); multmatrix([…20…]) { sphere(r = 3, …); } }
  // stderr: WARNING: More than one Root Modifier (!) in file …, line 1
  // openscad -o out.stl: 264 facets, volume 231.0381 — BOTH children.
  //
  // 🔴 THIS FILE USED TO EXPORT THE SPHERE ALONE (volume 106.0381) AND THE CUBE
  // VANISHED. `rootOnly` was still `null` while the outer body ran, so the
  // nested `!` was taken for the first root: it pulled its own subtree out of
  // the outer body's sink and the outer then overwrote it with that now-empty
  // sink. A missing feature in a part, from a file with no diagnostic on it.
  const src = `!union() { !cube(5); translate([20,0,0]) sphere(3,$fn=16); }\ncube(30);`;
  const s = solid(src);
  near(s.volume, 231.0381, 1e-3);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /More than one Root Modifier/);
  assert.deepEqual(tree(src), [
    'union of 2 (represented, NOT computed)',
    '  cube size [5, 5, 5] mm',
    '  translate [20, 0, 0] mm',
    '    sphere r 3 mm, $fn 16',
  ]);
});

test('a nested `!` deeper than one level keeps the transforms between it and the root', () => {
  // openscad -o out.csg: union() { multmatrix([…20…]) { cube(size=[5,5,5],…); } }
  // openscad -o out.stl: 12 facets, volume 125, bbox [20,0,0]…[25,5,5].
  // The inner `!` is an ordinary child of the chosen root, so its ancestors
  // INSIDE that root are kept — only the ancestors ABOVE the root are stripped.
  const src = `!union() { translate([20,0,0]) !cube(5); }\ncube(30);`;
  near(solid(src).volume, 125);
  assert.deepEqual(tree(src), [
    'union of 1 (represented, NOT computed)',
    '  translate [20, 0, 0] mm',
    '    cube size [5, 5, 5] mm',
  ]);
});

test('a `!` that is a SIBLING of the chosen root is still dropped — the two cases differ', () => {
  // The distinction the fix turns on. Nested ⇒ inside the chosen root ⇒ kept.
  // Sibling / later ⇒ outside it ⇒ not in OpenSCAD's tree at all.
  // openscad `!cube(5); !sphere(3,$fn=16); cylinder(h=2,r=1,$fn=16);` → 12
  // facets, volume 125, stderr `WARNING: More than one Root Modifier (!) … line 2`.
  const s = solid('!cube(5);\n!sphere(3,$fn=16);\ncylinder(h=2,r=1,$fn=16);');
  near(s.volume, 125);
  assert.equal(s.warnings.length, 1);

  // And DEPTH-FIRST ORDER decides, not source order: a `!` nested one level
  // down beats a later top-level one, because `find_root_tag` recurses into
  // each child before moving to the next sibling.
  // openscad `union(){ !cube(5); } !sphere(3,$fn=16);` → volume 125 (the cube),
  // warning on line 2.
  const d = solid('union() { !cube(5); }\n!sphere(3,$fn=16);');
  near(d.volume, 125);
  assert.equal(d.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// 3. A `!` inside a `%` subtree
// ---------------------------------------------------------------------------

test('a `!` inside a `%` subtree still governs the whole model', () => {
  // openscad -o out.csg `%union(){ !cube(5); } sphere(20,$fn=16);`:
  //   cube(size = [5, 5, 5], center = false);
  // openscad -o out.stl: 12 facets, volume 125.
  // `find_root_tag` walks the instantiated tree and never asks what a node's
  // ancestors are tagged with.
  //
  // 🔴 THIS FILE USED TO EXPORT THE SPHERE (31418.6836) — a different object,
  // silently, because the `%` body was thrown away at parse time and the `!`
  // was never seen. Two shapes, one wrong part each.
  near(solid(`%union() { !cube(5); }\n${REST}`).volume, 125);
  near(solid(`%translate([9,0,0]) union() { !cube(5); }\n${REST}`).volume, 125);
  assert.deepEqual(tree(`%union() { !cube(5); }\n${REST}`), ['cube size [5, 5, 5] mm']);
});

test('a `!` reached only through a module call inside `%` governs the model too', () => {
  // openscad `module m() { !cube(5); } %m(); sphere(20,$fn=16);` → 12 facets,
  // volume 125. The tag is on the instantiation INSIDE the module body, so no
  // syntactic scan of the `%` subtree can find it — the body has to be
  // evaluated. That is the whole reason `case 'background'` evaluates rather
  // than inspecting.
  near(solid(`module m() { !cube(5); }\n%m();\n${REST}`).volume, 125);
});

test('`%` on the node that BECOMES the root is ignored, in both writing orders', () => {
  // openscad `!%cube(5); sphere(20,$fn=16);` → 12 facets, volume 125, and
  // `%!cube(5); …` likewise. `GeometryEvaluator` skips a background CHILD;
  // nothing checks the flag on the root node itself.
  //
  // 🔴 `!%cube(5);` USED TO EXPORT NOTHING and `%!cube(5);` used to export the
  // sphere. Neither said anything.
  near(solid(`!%cube(5);\n${REST}`).volume, 125);
  near(solid(`%!cube(5);\n${REST}`).volume, 125);
  // No `%` refusal in either: OpenSCAD shows no ghost either, because the whole
  // rest of the tree — the `%` ancestor included — is not in its tree at all.
  assert.deepEqual(solid(`!%cube(5);\n${REST}`).refusals, []);
  assert.deepEqual(solid(`%!cube(5);\n${REST}`).refusals, []);
});

// ---------------------------------------------------------------------------
// 4. The `%` search must be invisible to every file that has no `!`
// ---------------------------------------------------------------------------

test('`%` alone is unchanged: no geometry, one named refusal, and nothing from inside it', () => {
  // The 93 `%` sites in `hardware/cad/` are all of this shape, and the search
  // added for the tests above must not have changed a single thing about them.
  // openscad `%sphere(20,$fn=16); cube(10);` → 12 facets, volume 1000.
  const s = solid(`%sphere(20,$fn=16);\ncube(10);`);
  near(s.volume, 1000);
  assert.deepEqual(s.refusals, ['1:modifier %']);
  assert.deepEqual(s.warnings, []);
  assert.equal(s.errors, 0);

  // A construct this subset refuses, written INSIDE a `%` body, is still not
  // reported — the subtree is not drawn either way, and reporting it would
  // change what every existing `%` site says. Asserted in both directions:
  // with no `!` in the file (search off) and with one (search on, rolled back).
  const off = solid('%linear_extrude(3) square(4);\ncube(1);');
  const on = solid('%linear_extrude(3) square(4);\n!cube(1);');
  assert.deepEqual(off.refusals, ['1:modifier %']);
  assert.deepEqual(on.refusals, ['1:modifier %'], 'the search reports nothing it finds on the way');
  assert.equal(off.errors, 0);
  assert.equal(on.errors, 0);

  // An error inside a `%` body is likewise not reported, in both states.
  assert.equal(solid('%cube(nosuchvar);\ncube(1);').errors, 0);
  assert.equal(solid('%cube(nosuchvar);\n!cube(1);').errors, 0);
});

test('`%` still excludes its subtree from a boolean, and from the export', () => {
  // openscad `difference(){ cube(20); %cylinder(h=40,r=5,center=true,$fn=16); }`
  // → 12 facets, volume 8000: an UNCUT block, because the background operand is
  // skipped by `GeometryEvaluator`.
  near(solid('difference() { cube(20); %cylinder(h=40,r=5,center=true,$fn=16); }').volume, 8000, 1e-3);

  // 🔴 AND WHEN `%` IS THE FIRST OPERAND, THE NEXT ONE BECOMES IT. OpenSCAD
  // `difference(){ %cube(20); cylinder(h=40,r=5,center=true,$fn=16); }` → 60
  // facets, volume 3061.4675: the CYLINDER, not an empty result. The background
  // child is removed from the child list before the operation is applied, so a
  // difference whose subtrahend has been promoted subtracts nothing.
  near(
    solid('difference() { %cube(20); cylinder(h=40,r=5,center=true,$fn=16); }').volume,
    3061.4675,
    1e-3,
  );
  // Same with a third operand, which then becomes the subtrahend.
  near(
    solid(
      'difference() { %cube(20); cylinder(h=40,r=5,center=true,$fn=16); ' +
        'translate([15,15,0]) cylinder(h=40,r=3,center=true,$fn=16); }',
    ).volume,
    3061.4675,
    1e-3,
  );

  // `%cube(10);` alone: openscad exits 1 with `Current top level object is
  // empty.` — the background subtree is not in the export at all.
  const alone = solid('%cube(10);');
  assert.equal(alone.parts, 0);
  assert.deepEqual(alone.refusals, ['1:modifier %']);
});

// ---------------------------------------------------------------------------
// 5. `#` and `*` in combination — measured, and already correct
// ---------------------------------------------------------------------------

test('`#` carries real geometry through every combination probed, and never suppresses', () => {
  // openscad `difference(){ cube(20); #cylinder(h=40,r=5,center=true,$fn=16); }`
  // → 28 facets, volume 7617.3166: the hole IS cut. `#` is a preview
  // annotation; it changes nothing about the exported solid.
  near(solid('difference() { cube(20); #cylinder(h=40,r=5,center=true,$fn=16); }').volume, 7617.3166, 1e-3);
  // `#!x` and `!#x` both render the marked subtree: two tags, one instantiation.
  near(solid(`#!cube(5);\n${REST}`).volume, 125);
  near(solid(`!#cube(5);\n${REST}`).volume, 125);
  // `#%x` and `%#x` are both background: `%` decides the geometry, `#` does not.
  // openscad prints `%#cube(...)` for both and exports only the 1 mm cube.
  near(solid('#%cube(10);\ncube([1,1,1]);').volume, 1);
  near(solid('%#cube(10);\ncube([1,1,1]);').volume, 1);
});

test('`*` disables exactly, on every statement form OpenSCAD accepts it on', () => {
  // Each probed as its own file against `-o out.stl`; all four leave only the
  // sphere (31418.6836).
  near(solid(`*if (true) cube(10);\n${REST}`).volume, REST_VOLUME, 1e-3);
  near(solid(`*for (i=[0:2]) translate([i*20,0,0]) cube(5);\n${REST}`).volume, REST_VOLUME, 1e-3);
  near(solid(`module m() { cube(5); }\n*m();\n${REST}`).volume, REST_VOLUME, 1e-3);
  near(solid(`*union() { %cube(5); }\n${REST}`).volume, REST_VOLUME, 1e-3);
  // As a boolean operand: openscad `difference(){ cube(10); *sphere(5,$fn=16); }`
  // → 12 facets, volume 1000 — the subtrahend is gone from the tree, so the
  // difference has one operand and evaluates to it.
  near(solid('difference() { cube(10); *sphere(5,$fn=16); }').volume, 1000);
  near(solid('intersection() { cube(10); *translate([5,0,0]) cube(10); }').volume, 1000);
});

// ---------------------------------------------------------------------------
// 6. The divergence that REMAINS, with what OpenSCAD does instead
// ---------------------------------------------------------------------------

test('describes the modifier divergence that REMAINS, and it is an acceptance, not a wrong part', () => {
  // `*{ cube(10); }` — a `*` on a bare block.
  //
  // OpenSCAD 2026.08.07: `Can't parse file` and exit 1. `module_instantiation`
  // has no bare-block production, so this is a SYNTAX ERROR there.
  // Ours: accepted, the block is dropped, the rest of the file renders.
  //
  // Left as it is, deliberately: the direction is ours accepting a file
  // OpenSCAD rejects outright, which cannot produce geometry a valid OpenSCAD
  // file would not. Refusing it would name a construct that has no meaning to
  // name. Recorded here so it is a decision and not an assumption.
  const s = solid(`*{ cube(10); }\n${REST}`);
  near(s.volume, REST_VOLUME, 1e-3);
  assert.equal(s.errors, 0, 'we accept it; OpenSCAD cannot parse the file at all');
});
