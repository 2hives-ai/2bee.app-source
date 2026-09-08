// `color()` in 2bee.cad — from the source text to the pixel, and the three
// places it is deliberately NOT obeyed.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 UNTIL 2026-08-11, `color()` WAS THE ONE CONSTRUCT THAT WAS ACCEPTED,
// CHANGED NOTHING, AND WARNED NOBODY. The parser took it, passed the geometry
// through, discarded the colour, and emitted no refusal, no warning and no
// error — which is exactly the class `docs/audit/2026-08-11-scad-silent-
// divergence.md` was written to enumerate, and the one construct it did not
// hold. Nothing in this repository could have told you.
//
// It was found the expensive way. The founder asked a model to *"change the
// objects to red"*; `ask.tsx`'s system instruction told the model `color` was
// "NOT implemented and refused by name", the model obeyed and returned the file
// unchanged, and every control downstream agreed there was no problem.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE NUMBERS CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 EVERY EXPECTED COLOUR AND EVERY WARNING STRING BELOW WAS TAKEN FROM
// **OpenSCAD 2026.08.07** AT `/usr/local/bin/openscad`, by running
//
//     openscad -o out.csg probe.scad
//
// and reading the `color([r, g, b, a])` line it writes, plus its own stderr.
// Not one of them was derived from our output. The inheritance rule and the
// alpha rule were read at the source — `src/core/ColorNode.cc`,
// `src/core/CSGTreeEvaluator.cc` and `src/geometry/linalg.h` of the checkout at
// `/home/gbacs/apps/openscad` — because both are counter-intuitive enough that
// a plausible guess gets them backwards.
//
// ✅ EXERCISED: the real `parseScad`, the real `meshScene`, and `materialFor`
// from the real `preview.tsx`.
//
// 🔴 NOT EXERCISED, stated rather than implied. **Nothing here has seen anything
// turn red.** `materialFor` is a pure function and this file asserts what it
// RETURNS; the three.js material it is handed to, the shader, the canvas and the
// operator's eye are all downstream of the last line asserted here. No claim is
// made that a coloured part renders, only that the decision handed to the
// renderer is the one the source asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad, parseColourString, colourIsComplete, WEB_COLOURS } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
const { materialFor, MIN_VISIBLE_OPACITY } = await import('../src/cad/preview.tsx');
const { encodeBinaryStl } = await import('../src/cad/record.ts');

type Colour = { rgb: [number, number, number] | null; alpha: number | null };

/** The colour on the group node `color()` produced, or `undefined`. */
const colourOf = (src: string): Colour | undefined =>
  (parseScad(src).scene.children[0] as { colour?: Colour }).colour;

const meshOf = (src: string) => meshScene(parseScad(src).scene);

/** Compare against OpenSCAD's own printed precision, which is 6 significant figures. */
const near = (a: number | null, b: number | null, what: string): void => {
  if (a === null || b === null) {
    assert.equal(a, b, what);
    return;
  }
  assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} is not ${b}`);
};

const sameColour = (got: Colour | undefined, want: Colour, what: string): void => {
  assert.ok(got, `${what}: no colour on the node at all`);
  if (want.rgb === null) assert.equal(got!.rgb, null, `${what}: rgb should be unset`);
  else {
    assert.ok(got!.rgb, `${what}: rgb is unset and should be [${want.rgb}]`);
    for (let i = 0; i < 3; i++) near(got!.rgb![i], want.rgb[i], `${what} channel ${i}`);
  }
  near(got!.alpha, want.alpha, `${what} alpha`);
};

/* ════════════════════════════════════════════════════════════════════════════
   1. Resolution — every argument form, against the binary
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THREE OF THESE ROWS ARE THE ONES A REASONABLE PERSON WOULD GET WRONG, and
 * they are here because guessing them WAS the alternative:
 *
 *   · `color([1,0])` is MAGENTA. `builtin_color` pads a short vector with 1.0,
 *     not with the default colour — so the missing blue channel becomes full
 *     blue. OpenSCAD prints `color([1, 0, 1, 1])`.
 *   · `color([1,0,0])` STATES an alpha of 1. It is not "rgb given, alpha
 *     unstated", and that decides whether a nested `color()` can override it.
 *   · `color(alpha=0.25)` leaves rgb at `-1,-1,-1` — genuinely unset, printed by
 *     OpenSCAD as `color([-1, -1, -1, 0.25])`. Alpha is applied independently of
 *     `c` and after it.
 */
test('every color() argument form resolves to the value OpenSCAD 2026.08.07 prints', () => {
  // openscad -o c.csg  →  the `color([...])` line, verbatim, per row.
  sameColour(colourOf('color("red") cube(3);'), { rgb: [1, 0, 0], alpha: 1 }, 'color([1, 0, 0, 1])');
  sameColour(colourOf('color("RED") cube(3);'), { rgb: [1, 0, 0], alpha: 1 }, 'names are case-insensitive');
  sameColour(colourOf('color([1,0,0]) cube(3);'), { rgb: [1, 0, 0], alpha: 1 }, 'a 3-vector states alpha 1');
  sameColour(colourOf('color([1,0]) cube(3);'), { rgb: [1, 0, 1], alpha: 1 }, 'color([1, 0, 1, 1]) — padded with 1');
  sameColour(colourOf('color([0,1,0,0.5]) cube(3);'), { rgb: [0, 1, 0], alpha: 0.5 }, 'a 4-vector carries alpha');
  sameColour(colourOf('color("red", 0.5) cube(3);'), { rgb: [1, 0, 0], alpha: 0.5 }, 'positional alpha');
  sameColour(colourOf('color(c="lime", alpha=0.5) cube(3);'), { rgb: [0, 1, 0], alpha: 0.5 }, 'named c and alpha');
  sameColour(colourOf('color("#0f0") cube(3);'), { rgb: [0, 1, 0], alpha: 1 }, '#rgb');
  sameColour(colourOf('color("#00ff00") cube(3);'), { rgb: [0, 1, 0], alpha: 1 }, '#rrggbb');
  // openscad: color([0, 1, 0, 0.501961])
  sameColour(colourOf('color("#00ff0080") cube(3);'), { rgb: [0, 1, 0], alpha: 0x80 / 255 }, '#rrggbbaa');
  sameColour(colourOf('color(alpha=0.25) cube(3);'), { rgb: null, alpha: 0.25 }, 'color([-1, -1, -1, 0.25])');
  sameColour(colourOf('color() cube(3);'), { rgb: null, alpha: null }, 'color() states nothing');

  // The table itself. 148 names in `src/core/WebColors.h`, transcribed whole —
  // a partial table would resolve some names and silently drop others, and
  // "unable to parse" is indistinguishable from "we did not carry that one".
  assert.equal(Object.keys(WEB_COLOURS).length, 148, 'the CSS Color 4 table is not the size OpenSCAD ships');
  assert.equal(parseColourString('rebeccapurple')?.rgb?.[0], 0x66 / 255, 'the CSS4 late addition is present');

  // Out of range is KEPT and WARNED, exactly as OpenSCAD keeps it. Clamping in
  // the parser would silently disagree with the tool the file was written for.
  const oor = parseScad('color([2,-1,0]) cube(3);');
  sameColour(
    (oor.scene.children[0] as { colour?: Colour }).colour,
    { rgb: [2, -1, 0], alpha: 1 },
    'color([2, -1, 0, 1]) — kept, not clamped',
  );
  assert.deepEqual(
    oor.warnings.map((w) => w.message),
    [
      'color() expects numbers between 0.0 and 1.0. Value of 2.0 is out of range',
      'color() expects numbers between 0.0 and 1.0. Value of -1.0 is out of range',
    ],
    'OpenSCAD prints exactly these two lines; ours are compared word for word so the two can be diffed',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   2. Inheritance — the outermost wins, and the boundary case that proves it
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE OUTERMOST `color()` WINS. `CSGTreeEvaluator::visit(ColorNode)` is one
 * line: `if (!state.color().isValid()) state.setColor(node.color);`. Anyone
 * reasoning from CSS, from SVG, or from "the nearest wrapper obviously wins"
 * gets this backwards, and a wrong answer here is a part drawn in a colour the
 * source never asked for with nothing to say so.
 *
 * 🔴 AND THE SECOND ASSERTION IS THE GUARD ON A DELIBERATE DUPLICATION.
 * `Mesher.inherit` in `mesh.ts` re-derives `colourIsComplete` rather than
 * importing it — `mesh.ts` may only import TYPES from `scad.ts`, or
 * `tools/scad_oracle` fails to resolve the specifier. `color(alpha=0.5)
 * color("blue")` is the ONLY program whose result differs if the two predicates
 * disagree: the outer colour is partial, therefore not complete, therefore
 * replaced WHOLE — alpha and all. If someone "fixes" either predicate to treat a
 * partial colour as complete, or to merge the halves, this row goes red.
 */
test('the OUTERMOST color() wins, and a partially-stated one is replaced whole', () => {
  const red = meshOf('color("red") color("blue") cube(3);').parts[0];
  assert.deepEqual(red.colour?.rgb, [1, 0, 0], 'a nested color() overrode its parent — OpenSCAD ignores it');

  // The boundary. `colourIsComplete` says the outer is not complete...
  assert.equal(colourIsComplete({ rgb: null, alpha: 0.5 }), false, 'alpha alone is not a complete colour');
  assert.equal(colourIsComplete({ rgb: [0, 0, 1], alpha: null }), false, 'rgb alone is not a complete colour');
  assert.equal(colourIsComplete({ rgb: [0, 0, 1], alpha: 1 }), true);
  assert.equal(colourIsComplete(null), false);

  // ...and `mesh.ts`, which cannot call it, must agree: blue at alpha 1, with
  // the outer 0.5 LOST rather than merged.
  const inner = meshOf('color(alpha=0.5) color("blue") cube(3);').parts[0];
  assert.deepEqual(inner.colour?.rgb, [0, 0, 1], 'a partial outer colour did not give way to the inner one');
  assert.equal(inner.colour?.alpha, 1, 'the halves were merged; OpenSCAD replaces the whole colour');

  // A colour crosses a transform and a plain group untouched, and a sibling
  // outside the color() is left alone — "in force" is not "in the file".
  const across = meshOf('color("red") translate([1,0,0]) { cube(3); } cube(4);');
  assert.deepEqual(across.parts[0].colour?.rgb, [1, 0, 0], 'the colour did not survive a transform');
  assert.equal(across.parts[1].colour, null, 'a part outside the color() was coloured anyway');
});

/* ════════════════════════════════════════════════════════════════════════════
   3. Through the kernel — one boolean is one part, so one colour
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠ A BOOLEAN DESTROYS THE PER-OPERAND COLOUR AND THE KERNEL IS WHY, not the
 * choice made here: `csgSubtract` returns one polygon soup with no memory of
 * which operand each face came from. The first operand's colour is used — the
 * minuend is the material a `difference()` leaves behind — and the loss is
 * announced as a WARNING rather than resolved silently in the flattering
 * direction.
 */
test('a boolean takes its first operand’s colour and SAYS SO when the operands disagreed', () => {
  const outside = meshOf('color("red") difference(){ cube(20); cylinder(h=30,r=4); }');
  assert.deepEqual(outside.parts[0].colour?.rgb, [1, 0, 0], 'a colour outside the boolean reached the result');
  assert.equal(
    outside.issues.filter((i) => /different colours/.test(i.detail)).length,
    0,
    'one colour over the whole boolean is not a disagreement and must not warn',
  );

  const mixed = meshOf('difference(){ color("red") cube(20); color("blue") cylinder(h=30,r=4); }');
  assert.deepEqual(mixed.parts[0].colour?.rgb, [1, 0, 0], 'the minuend’s colour is the one kept');
  const warned = mixed.issues.filter((i) => i.severity === 'warning' && /different colours/.test(i.detail));
  assert.equal(warned.length, 1, 'the colour thrown away by the kernel was not reported');
  assert.match(warned[0].detail, /appearance only/, 'the warning must not read as a shape problem');
});

/* ════════════════════════════════════════════════════════════════════════════
   4. What the renderer is told — and the two places the source is overruled
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 AN UNSOUND PART IS NOT PAINTABLE FROM THE SOURCE. A part whose audit is not
 * `closed` is meant to be the loudest thing in the viewport; if a `color()` in
 * the file could repaint it, the source could switch off the one signal that
 * says "do not cut this". The override is silent from the picture's point of
 * view, so `materialFor` reports it and the overlay prints it.
 *
 * 🔴 AND ALPHA HAS A FLOOR. `color("red", 0) cube(3)` is a solid that exports 12
 * facets; drawn at opacity 0 it would be indistinguishable from a REFUSED
 * construct, which is the one thing this tab draws as nothing. A named
 * divergence from OpenSCAD, not an oversight.
 */
test('materialFor obeys the source except where obeying it would hide a defect', () => {
  const [plain] = meshOf('cube(3);').parts;
  assert.deepEqual(materialFor(plain), { colour: null, opacity: 1, transparent: false, overridden: null });

  const [red] = meshOf('color("red") cube(3);').parts;
  assert.equal(materialFor(red).colour, '#ff0000', 'the source colour did not reach the material');
  assert.equal(materialFor(red).transparent, false, 'an opaque colour must not turn on blending');

  const [half] = meshOf('color("red", 0.5) cube(3);').parts;
  assert.equal(materialFor(half).opacity, 0.5);
  assert.equal(materialFor(half).transparent, true);

  const [invisible] = meshOf('color("red", 0) cube(3);').parts;
  assert.equal(materialFor(invisible).opacity, MIN_VISIBLE_OPACITY, 'alpha 0 would draw a present part as absent');
  assert.ok(MIN_VISIBLE_OPACITY > 0, 'the floor is the whole point of the constant');

  // Out-of-range rgb is clamped HERE, at the renderer, and not in the parser.
  const [oor] = meshOf('color([2,-1,0]) cube(3);').parts;
  assert.equal(materialFor(oor).colour, '#ff0000', 'an out-of-range channel must clamp at the point of painting');

  // A 2D plate keeps its annotation translucency; colour tints it, alpha may
  // only make it MORE transparent, never less.
  const [flat] = meshOf('color("red") square(4);').parts;
  assert.equal(materialFor(flat).colour, '#ff0000');
  assert.ok(materialFor(flat).opacity < 1, 'a 2D plate must not become an opaque slab because it was coloured');

  // The override, reached through the kernel's own negative control. `drop-face`
  // deletes one triangle, so the audit returns `open` — a real failed verdict on
  // a real coloured part, rather than a hand-built `MeshPart` that would let a
  // wrong expectation agree with a wrong implementation.
  const planted = meshScene(parseScad('color("red") cube(20);').scene, 'drop-face');
  const unsound = planted.parts.find((p) => p.dim === 3 && p.audit?.verdict !== 'closed');
  assert.ok(unsound, 'the plant did not produce an unsound part, so this row asserted nothing');
  assert.deepEqual(unsound!.colour?.rgb, [1, 0, 0], 'the part under test is not carrying a colour to override');
  const plan = materialFor(unsound!);
  assert.equal(plan.colour, null, 'a part that failed its audit was repainted from the source');
  assert.equal(plan.overridden, 'unsound', 'the override happened and nothing carried the fact out');
  assert.equal(plan.opacity, 1, 'an unsound part must not be made translucent from the source either');
});

/* ════════════════════════════════════════════════════════════════════════════
   5. Colour is appearance and NOTHING else
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE PROPERTY THAT MATTERS MOST IN A LANE WHERE A DEFECT IS PHYSICAL. Adding
 * `color()` to a source must not move a vertex, change a triangle count, change
 * an audit verdict, or change one byte of the exported STL. This is asserted by
 * comparing the two runs rather than by reading the code, because "it only sets
 * a field" is exactly the sort of claim that stops being true when someone
 * later makes the colour node a scope.
 *
 * ⚠ AND THE STL GENUINELY LOSES IT. Binary STL is a triangle soup; the 16-bit
 * per-face attribute that some tools abuse for colour is a vendor extension our
 * own reader ignores. Nothing is written, `CadTab.tsx` says so at export, and
 * the equality below is the assertion that "says so" is TRUE rather than
 * defensive.
 */
test('color() changes no vertex, no verdict and no exported byte', () => {
  const SRC = 'difference(){ cube([20,10,30]); translate([5,-1,5]) cube([6,12,6]); } sphere(4);';
  const bare = meshOf(SRC);
  const painted = meshOf(`color("red", 0.5) { ${SRC} }`);

  assert.equal(painted.parts.length, bare.parts.length, 'colouring changed how many parts there are');
  assert.equal(painted.stats.triangles, bare.stats.triangles, 'colouring changed the triangle count');
  for (let i = 0; i < bare.parts.length; i++) {
    assert.deepEqual(
      Array.from(painted.parts[i].positions),
      Array.from(bare.parts[i].positions),
      `part ${i}: colouring moved a vertex`,
    );
    assert.equal(painted.parts[i].audit?.verdict, bare.parts[i].audit?.verdict, `part ${i}: verdict moved`);
    assert.ok(painted.parts[i].colour?.rgb, `part ${i}: the colour did not actually reach it, so this proves nothing`);
    assert.equal(bare.parts[i].colour, null, `part ${i}: the uncoloured control was coloured`);
  }

  const stlOf = (m: typeof bare): string =>
    Array.from(encodeBinaryStl(m.parts.filter((p) => p.dim === 3), 'x')).join(',');
  assert.equal(stlOf(painted), stlOf(bare), 'the STL differs between a coloured and an uncoloured model');
});
