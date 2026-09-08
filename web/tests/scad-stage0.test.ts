// =============================================================================
// `scad.ts` Stage 0 — `use`/`include`, user functions, `is_*`, `let`, `children`
//
// Run: npm run test:node   (node --experimental-transform-types --test)
//
// WHY THESE FIVE, TOGETHER: measured over the 68 `.scad` files in
// `hardware/cad/` that this company cuts, they are what makes 10 of the 13
// `*_wcnc.scad` cut files stop at line 1 and what leaves 27 of the 68 refused on
// `is_undef` alone. None of them is geometry — this file adds no kernel, no
// primitive and no boolean.
//
// ✅ EXERCISED: the real `web/src/cad/scad.ts` and the real `web/src/cad/mesh.ts`,
// imported directly. Nothing is re-implemented here.
//
// 🔴 EVERY EXPECTATION BELOW CAME OUT OF THE OPENSCAD BINARY, NOT OUT OF OUR
// OWN OUTPUT. Probed against **OpenSCAD 2026.08.07** on 2026-08-11 with
// `openscad -o out.csg <file>` (and `-o out.stl` where a volume is asserted).
// The transcript for each is quoted at the test that uses it, because a number
// with no provenance is a number that agrees with whatever produced it. These
// are FROZEN measurements with a date: `tools/scad_oracle/` is the harness that
// re-runs the binary live.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · Any host that reads a real file system. `ScadFileHost` is exercised with
//     an in-memory map, which is what the browser will have; a Node or
//     File-System-Access implementation of it is not tested here and does not
//     exist yet.
//   · Anything in `CadTab.tsx`. The tab passes no host today, so in the SHIPPED
//     app every `use`/`include` still refuses — the refusal is what is
//     exercised there, and it is asserted below.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE NEGATIVE CONTROLS — four plants, and each was watched go red
// ─────────────────────────────────────────────────────────────────────────────
//
// A suite that has only ever been green is not evidence. Each defect was put
// into `scad.ts` in place, the suite re-run, and the output pasted below
// verbatim. Note the SECOND number on each line as well as the first: a plant
// that reddened everything would be telling you about the harness, not the code.
// Transcripts, 2026-08-11, baseline `# pass 23  # fail 0`:
//
//   PLANT A — `use` behaves like `include`: `parseIncludeLike` returns
//   `{ t: 'inline' }` for both keywords. This is the failure the construct's
//   own header calls out — it ADDS the library's top-level geometry to the
//   model and leaks its variables into the importing scope.
//       not ok 2 - `use` imports modules and functions and NOT variables, and runs no top-level geometry
//       not ok 4 - the SAME library through `use` and through `include` gives DIFFERENT geometry
//       not ok 5 - a `use`d module keeps ITS OWN file scope, not the importing one
//       # pass 20  # fail 3
//
//   PLANT B — recursion bottoms out silently: `callUserFunction` returns
//   `undefined` whenever `this.fnDepth > 0`, so `fact(5)` comes back `undef`
//   instead of 120 and the primitive that used it applies a default.
//       not ok 9  - a user function is hoisted, takes defaults, shadows a builtin, and RECURSES
//       not ok 11 - runaway recursion is an ERROR that names recursion, never a value
//       # pass 21  # fail 2
//
//   PLANT C — `children()` drops a child: `picked.slice(1)` in `execChildren`.
//       not ok 18 - children() instantiates ALL the children, in the caller's scope
//       not ok 19 - children(i), children(range) and an out-of-bounds index
//       not ok 21 - a module with NO children never reaches an enclosing call's children
//       # pass 20  # fail 3
//
//   PLANT D — 🔴 THE ONE THAT MATTERS MOST, because it is the shortcut this
//   change was explicitly not allowed to take: `eval`'s `case 'var'` returns
//   real `undef` for an unbound name instead of `FAILED`. That WOULD make the
//   `is_undef` idiom work, and it would re-open the defect where a refusal
//   falls through `?? 1` and builds a 1 mm cube where the source says 27. Run
//   together with `scad-openscad-divergence.test.ts` (baseline 60 passing):
//       not ok 2  - EVERY route to a failed value is probed, not just the one that was reported
//       not ok 51 - 🔴 THE SENTINEL IS NOT WEAKENED: a REFUSED value is still not an `undef`
//       # pass 58  # fail 2
//
// All four were removed and the suite returned to 23 passing (60 with the
// divergence suite).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad, sceneLines } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
type ScadFileHost = import('../src/cad/scad.ts').ScadFileHost;

/** A library used by several tests, so one probe transcript covers them all. */
const LIB = 'shared = 7;\nfunction libf(x) = x * 3;\nmodule libm(s = 2) cube(s);\ncube(1);\n';

/** The in-memory host. Exact keys only: a near-miss must MISS, not resolve. */
function hostOf(files: Record<string, string>): ScadFileHost {
  return {
    read(spec: string) {
      return Object.prototype.hasOwnProperty.call(files, spec)
        ? { path: spec, source: files[spec] }
        : null;
    },
  };
}

/** Total signed volume of every 3D part, the same measure the divergence suite uses. */
function volumeOf(src: string, opts?: { host?: ScadFileHost; path?: string }): number {
  const mesh = meshScene(parseScad(src, opts).scene);
  let v = 0;
  for (const p of mesh.parts) {
    if (p.dim !== 3) continue;
    const a = p.positions;
    for (let i = 0; i < p.triangles * 9; i += 9) {
      v +=
        (a[i] * (a[i + 4] * a[i + 8] - a[i + 5] * a[i + 7]) -
          a[i + 1] * (a[i + 3] * a[i + 8] - a[i + 5] * a[i + 6]) +
          a[i + 2] * (a[i + 3] * a[i + 7] - a[i + 4] * a[i + 6])) /
        6;
    }
  }
  return v;
}

/** Every `cube size [...]` in the tree, in order — the leaf text, not a re-derivation. */
function cubes(src: string, opts?: { host?: ScadFileHost; path?: string }): string[] {
  return sceneLines(parseScad(src, opts).scene)
    .filter((l) => l.text.startsWith('cube size'))
    .map((l) => l.text);
}

const near = (got: number, want: number, tol = 1e-4): void =>
  assert.ok(Math.abs(got - want) <= tol, `expected ${want} (OpenSCAD), got ${got}`);

// ---------------------------------------------------------------------------
// 1. `use` and `include` — and the difference between them is geometry
// ---------------------------------------------------------------------------

test('with NO host nothing resolves, and the refusal NAMES THE FILE', () => {
  // This is the state the shipped tab is in today: `CadTab.tsx` passes no host.
  // openscad, for comparison, WARNS and carries on:
  //   `use <nope/missing.scad> cube(3);` → `WARNING: Can't open library
  //   'nope/missing.scad'` and a 3 mm cube. We also keep the cube; what we add
  //   is that the import is a NAMED refusal rather than a warning nobody reads.
  const p = parseScad('use <../lib/brand_corner.scad>\nbrand_corner("front");');
  const names = p.unsupported.map((u) => u.name);
  assert.ok(
    names.includes('use <../lib/brand_corner.scad>'),
    `the refusal must carry the path that was asked for, got ${JSON.stringify(names)}`,
  );
  assert.equal(p.unsupported[0].line, 1);
  // 🔴 AND THE CONSEQUENCE IS NAMED SEPARATELY. `brand_corner()` is reported as
  // an unknown module, which is TRUE and reads as the user's typo — so the
  // import's own detail has to say that the missing module is this line's fault.
  assert.ok(names.some((n) => n.startsWith('brand_corner(')));
  assert.match(p.unsupported[0].detail, /unknown module/i);
});

test('`use` imports modules and functions and NOT variables, and runs no top-level geometry', () => {
  // openscad -o out.csg, on a main that does `use <sub/lib.scad>; libm(4);`
  // over LIB above:
  //     ECHO: "shared NOT imported"
  //     ECHO: 6
  //     group() { cube(size = [4, 4, 4], center = false); }
  // — note what is ABSENT: the library's own `cube(1)`.
  const host = hostOf({ 'sub/lib.scad': LIB });
  const src = 'use <sub/lib.scad>\nlibm(4);\ncube(is_undef(shared) ? 5 : shared);\ncube(libf(2));';
  assert.deepEqual(cubes(src, { host, path: 'main.scad' }), [
    'cube size [4, 4, 4] mm', // libm(4) — the module crossed
    'cube size [5, 5, 5] mm', // `shared` is UNDEFINED, so the ternary took 5
    'cube size [6, 6, 6] mm', // libf(2) — the function crossed
  ]);
});

test('`include` runs the library top-level geometry AND imports its variables', () => {
  // The same probe with `include`:
  //     ECHO: 7
  //     ECHO: 6
  //     cube(size = [1, 1, 1], center = false);
  //     group() { cube(size = [4, 4, 4], center = false); }
  const host = hostOf({ 'sub/lib.scad': LIB });
  const src = 'include <sub/lib.scad>\nlibm(4);\ncube(is_undef(shared) ? 5 : shared);\ncube(libf(2));';
  assert.deepEqual(cubes(src, { host, path: 'main.scad' }), [
    'cube size [1, 1, 1] mm', // the library's OWN top-level geometry
    'cube size [4, 4, 4] mm',
    'cube size [7, 7, 7] mm', // `shared` IS 7 here
    'cube size [6, 6, 6] mm',
  ]);
});

test('the SAME library through `use` and through `include` gives DIFFERENT geometry', () => {
  // 🔴 THE WHOLE POINT, ASSERTED AS A DIFFERENCE RATHER THAN AS TWO ABSOLUTES.
  // Two tests that each happen to be right can both pass while the keywords are
  // wired to the same code path; this one cannot.
  const host = hostOf({ 'sub/lib.scad': LIB });
  const withUse = volumeOf('use <sub/lib.scad>\nlibm(4);', { host, path: 'm.scad' });
  const withInclude = volumeOf('include <sub/lib.scad>\nlibm(4);', { host, path: 'm.scad' });
  near(withUse, 64); // 4³
  near(withInclude, 65); // 4³ + the library's own 1 mm cube
  assert.notEqual(withUse, withInclude, '`use` and `include` must not be the same operation');
});

test('a `use`d module keeps ITS OWN file scope, not the importing one', () => {
  // openscad: a library with `base = 11; module usesbase() cube(base);`, used
  // from a file that sets `base = 3`, emits `cube(size = [11,11,11])`.
  // Getting this backwards is the quiet half of `use`: the module still
  // resolves, and it resolves against the wrong number.
  const host = hostOf({ 'sub/lib2.scad': 'base = 11;\nmodule usesbase() cube(base);\n' });
  assert.deepEqual(cubes('use <sub/lib2.scad>\nbase = 3;\nusesbase();', { host, path: 'm.scad' }), [
    'cube size [11, 11, 11] mm',
  ]);
});

test('an included assignment competes with the including file for the name', () => {
  // `include` is TEXTUAL, so an included `w = 50;` and the host's own `w = 10;`
  // are two assignments in ONE scope — and OpenSCAD's rule is that the last one
  // in the scope governs the whole scope. Splicing is what makes that fall out;
  // running the included body as its own scope would give it its own `w`.
  const host = hostOf({ 'w.scad': 'w = 50;\n' });
  const p = parseScad('w = 10;\ninclude <w.scad>\ncube(w);', { host, path: 'm.scad' });
  assert.deepEqual(
    sceneLines(p.scene).filter((l) => l.text.startsWith('cube size')).map((l) => l.text),
    ['cube size [50, 50, 50] mm'],
  );
  assert.ok(p.warnings.some((x) => /overwritten/.test(x.message)), 'and the overwrite is reported');
});

test('a circular include is refused BY NAME and does not hang', () => {
  const host = hostOf({ 'a.scad': 'include <b.scad>\ncube(2);\n', 'b.scad': 'include <a.scad>\n' });
  const p = parseScad('include <a.scad>', { host, path: 'root.scad' });
  const names = p.unsupported.map((u) => u.name);
  assert.ok(names.some((n) => n.includes('include <a.scad>')), JSON.stringify(names));
  assert.ok(
    p.unsupported.some((u) => /circular import/.test(u.detail)),
    'the refusal must say it is a cycle, and name the chain',
  );
  // The non-circular half still evaluates: refusing the second opening is not
  // refusing the file.
  near(volumeOf('include <a.scad>', { host, path: 'root.scad' }), 8);
});

test('a diagnostic raised inside an imported file points at a line the reader can SEE', () => {
  // 🔴 A LINE NUMBER THAT INDEXES A DIFFERENT FILE IS WORSE THAN NO LINE NUMBER.
  // The library refuses `hulls()` on ITS line 2; the open file is 3 lines long.
  // Reporting "line 2" unqualified would point at a real, innocent line here.
  const host = hostOf({ 'lib.scad': '// a comment\nmodule bad() hulls() cube(1);\n' });
  const p = parseScad('use <lib.scad>\n\nbad();', { host, path: 'm.scad' });
  const refused = p.unsupported.find((u) => u.name.includes('hulls'));
  assert.ok(refused, `expected a hulls refusal, got ${JSON.stringify(p.unsupported.map((u) => u.name))}`);
  assert.equal(refused!.line, 1, 'the line of the `use`, which is the line on screen');
  assert.match(refused!.name, /^lib\.scad:2 /, 'and the real file and line are in the name');
});

// ---------------------------------------------------------------------------
// 2. User-defined functions
// ---------------------------------------------------------------------------

test('a user function is hoisted, takes defaults, shadows a builtin, and RECURSES', () => {
  // openscad -o out.csg, four separate probes:
  //   `function fact(n) = n<=1 ? 1 : n*fact(n-1); function add(a,b=10)=a+b;
  //    cube([fact(5), add(1), add(1,2)]);`  → cube(size = [120, 11, 3])
  //   `cube(g(2)); function g(x) = x*4;`    → cube(size = [8, 8, 8])
  //   `function sin(x) = 999; cube(sin(30));` → cube(size = [999, 999, 999])
  assert.deepEqual(
    cubes('function fact(n) = n <= 1 ? 1 : n * fact(n-1);\nfunction add(a, b = 10) = a + b;\ncube([fact(5), add(1), add(1, 2)]);'),
    ['cube size [120, 11, 3] mm'],
  );
  assert.deepEqual(cubes('cube(g(2));\nfunction g(x) = x*4;'), ['cube size [8, 8, 8] mm']);
  assert.deepEqual(cubes('function sin(x) = 999;\ncube(sin(30));'), ['cube size [999, 999, 999] mm']);
});

test('a function default is evaluated where the function was DEFINED', () => {
  // openscad: `function h(a, b = a*2) = a + b; cube(h(3));`
  //   → `WARNING: Ignoring unknown variable "a"` ×1, two undefined-operation
  //     warnings, and `cube(size = [1,1,1])`.
  // So a default does NOT see an earlier parameter — the same rule modules
  // already follow here. Ours is the standing divergence in the safe direction:
  // the failed value cannot become a 1 mm cube, so nothing is drawn.
  const p = parseScad('function h(a, b = a*2) = a + b;\ncube(h(3));');
  assert.equal(cubes('function h(a, b = a*2) = a + b;\ncube(h(3));').length, 0);
  assert.ok(p.errors.some((e) => /variable a is not defined/.test(e.message)));
});

test('runaway recursion is an ERROR that names recursion, never a value', () => {
  // 🔴 IT MUST NOT COME BACK AS `undef`, because `undef` is what an omitted
  // argument looks like and the primitive would then apply its default. The
  // whole evaluation stops and says why.
  const p = parseScad('function boom(n) = boom(n + 1);\ncube(boom(0));');
  assert.equal(cubes('function boom(n) = boom(n + 1);\ncube(boom(0));').length, 0);
  assert.ok(
    p.errors.some((e) => /nested deeper than \d+/.test(e.message) && /recursive/i.test(e.message)),
    `expected a depth error naming recursion, got ${JSON.stringify(p.errors)}`,
  );
});

// ---------------------------------------------------------------------------
// 3. `is_undef` and the sibling predicates — and the idiom
// ---------------------------------------------------------------------------

test('the standing hardware/cad idiom evaluates, in all three of its written forms', () => {
  // 🔴 THIS IS THE MEASURED BLOCKER: `is_undef` appears at 32 sites in 27 of the
  // 68 files, and at EVERY ONE of them the argument is a bare name.
  // openscad -o out.csg, three probes:
  //   `SCALE = is_undef(SCALE) ? 1.0 : SCALE; cube(SCALE*10);` → cube([10,10,10])
  //   `x = is_undef(nosuch2) || nosuch2; cube(x ? 6 : 2);`     → cube([6,6,6])
  //   `a = is_undef(nosuchname) ? 3 : 7; cube(a);`             → cube([3,3,3])
  assert.deepEqual(cubes('SCALE = is_undef(SCALE) ? 1.0 : SCALE;\ncube(SCALE*10);'), [
    'cube size [10, 10, 10] mm',
  ]);
  assert.deepEqual(cubes('if (is_undef(_lib_only) || !_lib_only) cube(6);'), ['cube size [6, 6, 6] mm']);
  assert.deepEqual(cubes('a = is_undef(nosuchname) ? 3 : 7;\ncube(a);'), ['cube size [3, 3, 3] mm']);

  // And it is CLEAN: asking whether a name is defined is not reading it, in
  // OpenSCAD either — `is_undef(nosuchname)` emits no warning there, while
  // `b = nosuchname;` emits `WARNING: Ignoring unknown variable "nosuchname"`.
  const p = parseScad('a = is_undef(nosuchname) ? 3 : 7;\ncube(a);');
  assert.equal(p.errors.length, 0, JSON.stringify(p.errors));
  assert.equal(p.unsupported.length, 0);
});

test('`&&` and `||` SHORT-CIRCUIT, which is what keeps the idiom clean', () => {
  // openscad: `x = is_undef(nosuch2) || nosuch2;` warns about NOTHING — the
  // right operand is never evaluated. Both operands used to be evaluated here,
  // which reported an undefined variable and refused the whole condition.
  const p = parseScad('if (is_undef(_x) || _x) cube(4);');
  assert.equal(p.errors.length, 0, `the right operand must not be evaluated: ${JSON.stringify(p.errors)}`);
  assert.deepEqual(cubes('if (is_undef(_x) || _x) cube(4);'), ['cube size [4, 4, 4] mm']);
  // The other direction, so this is not just "|| always returns true":
  assert.deepEqual(cubes('if (false && _x) cube(4); else cube(9);'), ['cube size [9, 9, 9] mm']);
  assert.equal(parseScad('if (false && _x) cube(4); else cube(9);').errors.length, 0);
});

test('🔴 THE SENTINEL IS NOT WEAKENED: a REFUSED value is still not an `undef`', () => {
  // The idiom works because `is_undef(<bare name>)` asks the ENVIRONMENT
  // whether the name is bound. It does NOT work by making an unbound name
  // evaluate to `undef` — that single change would re-open the defect this
  // lane's refusal sentinel exists to close, because `undef` is exactly what
  // `named.get('size') ?? pos[0] ?? 1` reads as "argument omitted".
  //
  // Both halves are asserted, because only the pair distinguishes the fix that
  // was made from the fix that must not be:
  //   (a) READING an unbound name is still an error and still draws nothing
  assert.equal(cubes('cube(nosuchname);').length, 0, 'a typo must not become a 1 mm cube');
  assert.ok(parseScad('cube(nosuchname);').errors.length >= 1);
  //   (b) a name bound to a REFUSED expression is not reported as undef —
  //       we do not know what it was, so `is_undef` cannot answer `true`
  //
  // ⚠ THE EXAMPLE MOVED ON 2026-09-02, THE PROPERTY DID NOT. This used
  // `y = str(1)`, because `str()` was unsupported. `str()` is now IMPLEMENTED
  // (it was the single cause under 65 of 73 live CAD1H divergences), so that
  // line binds "1", `is_undef` answers false, and the test drew a 7 mm cube —
  // failing on its own fixture rather than on the property it guards.
  //
  // 🔴 A TEST WHOSE FIXTURE IS "SOMETHING WE HAVE NOT IMPLEMENTED" HAS A
  // BUILT-IN EXPIRY, and the right repair is to re-point it, never to delete
  // it: the sentinel it defends — a refused value must not read as `undef`,
  // because `undef` is what `named.get('size') ?? 1` treats as "argument
  // omitted" — is exactly as load-bearing as it was. `chr()` is refused today;
  // if it is ever implemented this comment is the instruction for the next
  // person, and the assertion below names what it needs rather than assuming.
  const REFUSED_EXPR = 'chr(65)';
  const src = `y = ${REFUSED_EXPR};\ncube(is_undef(y) ? 3 : 7);`;
  const p = parseScad(src);
  assert.ok(
    p.unsupported.some((u) => u.name.startsWith('chr(')),
    `${REFUSED_EXPR} is no longer refused — re-point this test at a construct that is, ` +
      'and do NOT delete it: the sentinel is the property, not the example'
  );
  assert.equal(cubes(src).length, 0, 'neither 3 nor 7 is the answer');
});

test('the sibling predicates answer the way the binary answers', () => {
  // openscad: `echo(is_undef(undef), is_undef(1), is_num(1), is_string("a"),
  //            is_bool(true), is_list([1]), is_function(function(x)x));`
  //   → ECHO: true, false, true, true, true, true, true
  // ⚠ `is_function` is the one row we answer differently, and honestly: this
  // subset has no function literals, so no value it can produce is a function.
  assert.deepEqual(cubes('cube([is_undef(undef)?2:9, is_undef(1)?9:3, is_num(1)?4:9]);'), [
    'cube size [2, 3, 4] mm',
  ]);
  assert.deepEqual(cubes('cube([is_string("a")?2:9, is_bool(true)?3:9, is_list([1])?4:9]);'), [
    'cube size [2, 3, 4] mm',
  ]);
  assert.deepEqual(cubes('cube([is_num("a")?9:2, is_list(3)?9:3, is_function(1)?9:4]);'), [
    'cube size [2, 3, 4] mm',
  ]);
  // A parameter bound to undef is undef — the `exs = is_undef(xs) ? … : xs`
  // form, which is `lib/fleet_front_mount.scad`'s.
  assert.deepEqual(cubes('module m(xs) { cube(is_undef(xs) ? 5 : 9); }\nm();'), ['cube size [5, 5, 5] mm']);
  assert.deepEqual(cubes('module m(xs) { cube(is_undef(xs) ? 5 : 9); }\nm(1);'), ['cube size [9, 9, 9] mm']);
});

// ---------------------------------------------------------------------------
// 4. `let()`
// ---------------------------------------------------------------------------

test('let() binds SEQUENTIALLY, in both the expression and the statement form', () => {
  // openscad -o out.csg:
  //   `a = 1; cube(let(a = 5, b = a + 1) [a, b, 3]);` → cube(size = [5, 6, 3])
  //     — `b` sees the `a` bound one binding earlier, not the outer `a`
  //   `w = 2; let (w = 9, h = w * 2) { cube([w, h, 1]); } cube(w);`
  //     → group() { cube(size = [9, 18, 1]) }  then  cube(size = [2, 2, 2])
  assert.deepEqual(cubes('a = 1;\ncube(let(a = 5, b = a + 1) [a, b, 3]);'), ['cube size [5, 6, 3] mm']);
  assert.deepEqual(cubes('w = 2;\nlet (w = 9, h = w * 2) { cube([w, h, 1]); }\ncube(w);'), [
    'cube size [9, 18, 1] mm',
    'cube size [2, 2, 2] mm', // 🔴 the binding does NOT escape the let
  ]);
  assert.deepEqual(cubes('let (n = 3) cube(n);'), ['cube size [3, 3, 3] mm']);
});

test('let() with a binding that has no name binds nothing, and says so', () => {
  // openscad: `cube(let(3) 5);` → `WARNING: Assignment without variable name 3`.
  // Parsing it as a positional argument and ignoring it would leave the body
  // reading whatever the name meant OUTSIDE the let.
  const p = parseScad('cube(let(3) 5);');
  assert.ok(
    p.errors.some((e) => /no variable name/.test(e.message)),
    `expected the unnamed binding to be reported, got ${JSON.stringify(p.errors)}`,
  );
});

// ---------------------------------------------------------------------------
// 5. `children()` / `$children`
// ---------------------------------------------------------------------------

test('children() instantiates ALL the children, in the caller\'s scope', () => {
  // openscad -o out.csg:
  //   `module ring(n=3){ for(i=[0:n-1]) translate([i*10,0,0]) children(); }
  //    ring(3) cube(2);`
  //   → three `multmatrix` nodes at x = 0, 10, 20, each wrapping a 2 mm cube,
  //     and `echo($children)` inside reports 1.
  const lines = sceneLines(
    parseScad('module ring(n = 3) { for (i = [0:n-1]) translate([i*10,0,0]) children(); }\nring(3) cube(2);').scene,
  );
  assert.equal(lines.filter((l) => l.text === 'cube size [2, 2, 2] mm').length, 3, 'three cubes, one per iteration');
  assert.deepEqual(
    lines.filter((l) => l.text.startsWith('translate')).map((l) => l.text),
    ['translate [0, 0, 0] mm', 'translate [10, 0, 0] mm', 'translate [20, 0, 0] mm'],
  );
  near(volumeOf('module ring(n = 3) { for (i = [0:n-1]) translate([i*10,0,0]) children(); }\nring(3) cube(2);'), 24);

  // The child is evaluated where it was WRITTEN. `s` here is the caller's, and
  // the module's own `s` must not shadow it.
  assert.deepEqual(cubes('module m(s = 99) { children(); }\ns = 4;\nm() cube(s);'), ['cube size [4, 4, 4] mm']);
});

test('children(i), children(range) and an out-of-bounds index', () => {
  // openscad -o out.csg:
  //   `module pick(){children(1);} pick(){cube(1);sphere(2);cylinder(h=3,r=1);}`
  //     → the SPHERE only, and `echo("n=", $children)` reports 3
  //   `module sub(){children([0:1]);} sub(){…}` → the cube and the sphere
  //   `module oob(){children(5);} oob() cube(1);`
  //     → `WARNING: Children index (5) out of bounds (1 children)`, `group();`
  const three = '{ cube(1); sphere(2); cylinder(h = 3, r = 1); }';
  const pick = sceneLines(parseScad(`module pick() { children(1); }\npick() ${three}`).scene).map((l) => l.text);
  assert.ok(pick.some((t) => t.startsWith('sphere')), JSON.stringify(pick));
  assert.ok(!pick.some((t) => t.startsWith('cube')), 'children(1) must not also take child 0');
  assert.ok(!pick.some((t) => t.startsWith('cylinder')));

  const sub = sceneLines(parseScad(`module sub() { children([0:1]); }\nsub() ${three}`).scene).map((l) => l.text);
  assert.ok(sub.some((t) => t.startsWith('cube')) && sub.some((t) => t.startsWith('sphere')));
  assert.ok(!sub.some((t) => t.startsWith('cylinder')), 'the range is [0:1], not [0:2]');

  const oob = parseScad('module oob() { children(5); }\noob() cube(1);');
  assert.equal(sceneLines(oob.scene).filter((l) => l.kind === 'primitive').length, 0);
  assert.ok(
    oob.warnings.some((w) => w.message === 'Children index (5) out of bounds (1 children)'),
    `OpenSCAD's own wording, so the two can be diffed: ${JSON.stringify(oob.warnings)}`,
  );
});

test('$children counts the TOP-LEVEL children, and a module with none sees 0', () => {
  // openscad: a `for` handed as one child is ONE child, not its iterations —
  //   `module m(){echo("children=", $children); children();} m() for(i=[0:1]) cube(1);`
  //   → ECHO: "children=", 1
  // ⚠ AND A CHILD BLOCK THAT IS NEVER INSTANTIATED EMITS NOTHING. Probed:
  //   `module c(){ cube($children); } c(){ cube(1); sphere(2); cylinder(h=1,r=1); }`
  //   → `group() { cube(size = [3,3,3]) }` and NOTHING else. A module that
  //   counts its children without calling `children()` drops them, which is
  //   the correct half of "a refused wrapper takes its subtree with it".
  assert.deepEqual(cubes('module c() { cube($children); }\nc() { cube(1); sphere(2); cylinder(h=1,r=1); }'), [
    'cube size [3, 3, 3] mm',
  ]);
  assert.deepEqual(cubes('module c() { cube($children + 1); }\nc();'), ['cube size [1, 1, 1] mm']);
  assert.deepEqual(cubes('module c() { cube($children + 1); }\nc() for (i = [0:1]) sphere(1);'), [
    'cube size [2, 2, 2] mm',
  ]);
});

test('a module with NO children never reaches an enclosing call\'s children', () => {
  // 🔴 THE FAILURE THIS GUARDS: if a frame with no children left `childCtx`
  // unset, the lookup would walk out through the DEFINING scope and instantiate
  // some other call's children — geometry the source never asked for, at a
  // point it never asked for it. `inner()` below takes no children and must
  // draw nothing for its `children()`.
  const src =
    'module inner() { children(); }\n' +
    'module outer() { inner(); children(); }\n' +
    'outer() cube(3);';
  // Exactly ONE cube: outer's own children(), never a second from inner().
  assert.deepEqual(cubes(src), ['cube size [3, 3, 3] mm']);
  near(volumeOf(src), 27);
});

test('children() outside a module emits nothing and is not called a refusal', () => {
  // openscad: `children();` at the top level emits no CSG at all and warns only
  // about `$children` being unknown. Our geometry matches exactly, so this is a
  // WARNING — calling it a refusal would claim a gap this subset does not have.
  const p = parseScad('children();\ncube(2);');
  assert.deepEqual(cubes('children();\ncube(2);'), ['cube size [2, 2, 2] mm']);
  assert.equal(p.unsupported.length, 0, JSON.stringify(p.unsupported));
  assert.ok(p.warnings.some((w) => /children\(\) outside a module/.test(w.message)));
});

// ---------------------------------------------------------------------------
// 6. What Stage 0 did NOT do — the refusal rule, still intact
// ---------------------------------------------------------------------------

test('everything Stage 0 did not implement is STILL named, and still emits nothing', () => {
  // A construct that starts HALF working is worse than one that is refused, so
  // the neighbours of this change are asserted to be untouched by it.
  for (const [src, needle] of [
    // hull is now handled — removed from refused list.
    // linear_extrude is now handled — removed from refused list.
    // resize is now handled — removed from refused list.
    // offset is now handled — removed from refused list.
    // polygon is now handled — removed from refused list.
    // text is now handled — removed from refused list.
    // intersection_for is now handled — removed from refused list.
    // list comprehension is now handled — removed from refused list.
    // echo is now handled — removed from refused list.
    // mirror is now handled — removed from refused list.
    ['hulls() cube(3);', 'hulls()'],
  ] as [string, string][]) {
    const p = parseScad(src);
    assert.ok(
      p.unsupported.some((u) => u.name.includes(needle)),
      `${needle} must still be refused by name — got ${JSON.stringify(p.unsupported.map((u) => u.name))}`,
    );
    assert.equal(meshScene(p.scene).stats.triangles, 0, `${src} emitted geometry`);
  }
});
