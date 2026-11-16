// 2bee.cad stage 1 — the OpenSCAD language, tokenized, parsed and evaluated to
// an explicit scene tree. Pure TypeScript, no React, no DOM, no dependency.
//
// 🔴 WHAT THIS IS NOT. There is NO geometry kernel here. `difference()` is
// PARSED and REPRESENTED as a node with children; nothing subtracts anything.
// No mesh is produced, no face, no vertex, no volume. A caller that treats the
// output of this module as geometry is wrong, and the physical failure that
// guards against is the obvious one: a part cut to a shape the code never
// described, because a boolean the user believed had been applied never was.
//
// 🔴 THE REFUSAL RULE, which is the whole design. Every construct this subset
// does not implement is reported BY NAME WITH ITS LINE and contributes NOTHING
// to the scene tree. It is never approximated, never treated as a group, never
// skipped quietly. The tree is therefore always a SUBSET of what the source
// says, never a guess at it — the same contract the DXF importer holds when it
// names an entity it cannot read instead of dropping it. A silently ignored
// `minkowski()` is a part missing a feature and nobody finds out until it is
// cut.
//
// Units are millimetres and degrees, matching OpenSCAD and matching the core.

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A construct that exists in the source and is not implemented here. */
export interface Unsupported {
  /** What it is, by its OpenSCAD name. `minkowski()`, `$fa`, `list comprehension`. */
  name: string;
  /** 1-based source line. */
  line: number;
  /** Why it is refused, and what happened to it (always: nothing was emitted). */
  detail: string;
}

/** A syntax or evaluation failure. Not a refusal: a refusal is understood, this is not. */
export interface ScadError {
  line: number;
  message: string;
}

/**
 * A construct that IS implemented, behaves exactly as OpenSCAD behaves, and
 * about which OpenSCAD itself emits a `WARNING:` line. Not an error (nothing
 * failed) and not a refusal (nothing was dropped) — the third thing OpenSCAD
 * says, and the one this file had no channel for until 2026-08-11.
 *
 * 🔴 NOTHING RENDERS THIS TODAY. `CadTab.tsx` draws `errors` and `unsupported`
 * and knows nothing about this list; it is owned by another lane and was not
 * edited by the change that added this field. So: the warnings are produced,
 * they are counted into `GroupNode.diagnostics`, they are asserted by
 * `scad-divergence.test.ts`, and they are INVISIBLE in the tab. That is stated
 * here rather than implied, because a channel whose non-consumption is not
 * written down reads as a control.
 */
export interface ScadWarning {
  line: number;
  /** The OpenSCAD wording where OpenSCAD has one, so the two can be diffed. */
  message: string;
}

/** One line of `echo()` output. Side-effecting — does not affect geometry. */
export interface ScadEchoLine {
  /** 1-based source line of the `echo()` call. */
  line: number;
  /** The formatted output, matching OpenSCAD's `ECHO:` line (without the prefix). */
  message: string;
}

export type Vec3 = [number, number, number];

/**
 * A colour as OpenSCAD models one, INCLUDING the part that looks like an
 * implementation detail and is not.
 *
 * 🔴 THE TWO HALVES ARE INDEPENDENTLY PRESENT-OR-ABSENT, AND THAT IS OPENSCAD'S
 * OWN MODEL, NOT A CONVENIENCE HERE. `Color4f` (`src/geometry/linalg.h` of
 * OpenSCAD 2026.08.07) initialises every channel to `-1` and answers three
 * separate questions about itself — `isValid()` (all four set), `hasRgb()` (the
 * first three) and `hasAlpha()` (the fourth). `Renderer.cc:141-150` then applies
 * whichever half is set over the base colour, so `color(alpha = 0.5) cube(3)`
 * really is "the default colour at half alpha" and not "black at half alpha".
 * Collapsing this to a single `[r,g,b,a]` with defaults would make an unstated
 * channel indistinguishable from one stated as its default value, and the
 * INHERITANCE RULE below keys on exactly that difference.
 */
export interface Colour {
  /** sRGB, each 0..1. `null` ⇒ this node stated no rgb at all. */
  rgb: Vec3 | null;
  /** 0..1. `null` ⇒ this node stated no alpha at all. */
  alpha: number | null;
}

/**
 * OpenSCAD's `Color4f::isValid()` — all four channels stated.
 *
 * 🔴 THIS PREDICATE IS THE INHERITANCE RULE, WHICH IS WHY IT IS EXPORTED RATHER
 * THAN INLINED. `CSGTreeEvaluator::visit(ColorNode)` is one line —
 * `if (!state.color().isValid()) state.setColor(node.color);` — so the
 * OUTERMOST `color()` wins and an inner one is ignored, which is the opposite of
 * what almost everyone assumes CSS-style nesting does. An outer colour that is
 * only PARTIALLY stated (alpha alone) is *not* valid, so an inner one replaces
 * it **whole**, alpha included. Both behaviours were read at the source, not
 * guessed.
 */
export function colourIsComplete(c: Colour | null | undefined): boolean {
  return !!c && c.rgb !== null && c.alpha !== null;
}

/** Nothing stated. The value `color()` and `color(7)` both produce. */
export const NO_COLOUR: Colour = { rgb: null, alpha: null };

/**
 * The CSS Color Module Level 4 names, as OpenSCAD ships them.
 *
 * Transcribed from `src/core/WebColors.h` of the checkout at
 * `/home/gbacs/apps/openscad` (148 names, the same count the header holds).
 * Lookup is case-insensitive there (`boost::to_lower_copy`) and here.
 *
 * ⚠ THE `xkcd:` PREFIX IS NOT HERE AND IS REFUSED BY NAME. OpenSCAD also
 * accepts ~950 XKCD names behind that prefix; carrying them would be ~30 kB of
 * table in a bundle that has no other data of that size. A name we cannot
 * resolve must not silently become "no colour", so `parseColourString` returns
 * `null` for it and the caller says which of the two reasons applied.
 */
export const WEB_COLOURS: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
  azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd',
  blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0',
  chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed',
  cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b',
  darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9',
  darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00',
  darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
  darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f',
  darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff',
  dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222',
  floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc',
  ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000',
  greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4',
  indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
  lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
  lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899',
  lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00',
  limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000',
  mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
  mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
  midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
  navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
  olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
  palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f',
  pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080',
  rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1',
  saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57',
  seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb',
  slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa',
  springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080',
  thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee',
  wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00',
  yellowgreen: '9acd32',
};

/**
 * A colour string — a CSS Color 4 NAME or a `#` hex form — or `null`.
 *
 * The hex grammar is OpenSCAD's `parse_hex_color` exactly: `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, alpha defaulting to 1 when the form carries none.
 * A name that resolves carries alpha 1, because `Color4f(int,int,int)` defaults
 * its fourth argument to 255.
 */
export function parseColourString(text: string): Colour | null {
  const named = WEB_COLOURS[text.toLowerCase()];
  if (named !== undefined) {
    return {
      rgb: [
        parseInt(named.slice(0, 2), 16) / 255,
        parseInt(named.slice(2, 4), 16) / 255,
        parseInt(named.slice(4, 6), 16) / 255,
      ],
      alpha: 1,
    };
  }
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return null;
  const body = text.slice(1);
  const stride = body.length <= 4 ? 1 : 2;
  const max = stride === 1 ? 15 : 255;
  const ch = (i: number): number =>
    parseInt(body.slice(i * stride, (i + 1) * stride), 16) / max;
  const n = body.length / stride;
  return { rgb: [ch(0), ch(1), ch(2)], alpha: n > 3 ? ch(3) : 1 };
}

/** OpenSCAD's `ColorNode::toString()`, for the scene-tree label. */
export function colourLabel(c: Colour): string {
  const f = (v: number | null): string => (v === null ? '—' : String(Math.round(v * 1000) / 1000));
  const rgb = c.rgb;
  return `color([${rgb ? `${f(rgb[0])}, ${f(rgb[1])}, ${f(rgb[2])}` : '—, —, —'}, ${f(c.alpha)}])`;
}

export interface CubeParams {
  kind: 'cube';
  size: Vec3;
  center: boolean;
}
/**
 * The three tessellation controls, carried TOGETHER on every curved primitive.
 *
 * 🔴 They travel as a triple on purpose. From stage 1 until 2026-08-11 only
 * `$fn` was carried, `$fa`/`$fs` were hard-coded in `mesh.ts`, and a source
 * that set them got a different number of facets than it asked for with no
 * diagnostic at all — because the refusal that was supposed to name them sat
 * behind an allowlist that always matched first. A partial triple is what made
 * that possible: a primitive that carries one of the three and lets the
 * tessellator invent the other two cannot be wrong out loud.
 */
export interface Facets {
  /** `$fn` at this call site, or null when it is 0/absent and $fa/$fs govern. */
  fn: number | null;
  /** `$fa` in degrees. OpenSCAD's default is 12 and it clamps below 0.01. */
  fa: number;
  /** `$fs` in mm. OpenSCAD's default is 2 and it clamps below 0.01. */
  fs: number;
}

export interface SphereParams extends Facets {
  kind: 'sphere';
  r: number;
}
export interface CylinderParams extends Facets {
  kind: 'cylinder';
  h: number;
  r1: number;
  r2: number;
  center: boolean;
}
export interface SquareParams {
  kind: 'square';
  size: [number, number];
  center: boolean;
}
export interface CircleParams extends Facets {
  kind: 'circle';
  r: number;
}
export interface PolygonParams {
  kind: 'polygon';
  points: [number, number][];
  /**
   * `paths=` — each a loop of indices into `points`. Absent ⇔ the points in
   * order are the one loop. 🔴 UNTIL 2026-10-14 THIS WAS PARSED AND THROWN
   * AWAY ("For now, ignore paths"), so a plate with a hole came out as one
   * loop zig-zagging through both rings. The loops are filled EVEN-ODD, which
   * is what openscad 2026.08.07 does — measured: two overlapping 10×10 squares
   * as two paths enclose 150 mm², not 175; a hole's winding does not matter
   * (64 either way); the same square twice encloses nothing. Every index here
   * is an in-range integer — anything else was refused in the parser.
   */
  paths?: number[][];
}
/**
 * ⚠ `extends Facets` SINCE 2026-09-03, AND IT DID NOT BEFORE.
 *
 * `text()` already ACCEPTED `$fn` — it is in the parser's accept list — and then
 * never read it, so the value was consumed and discarded. Measured against
 * OpenSCAD 2026.08.07 on `hardware/cad/2bee_cnc_table/cnc_gland_plate_3d.scad`,
 * where the two trees differed in exactly one character:
 *
 *   openscad  text(text="FLOW",…,$fn=24,$fa=12,$fs=2)
 *   ours      text(text="FLOW",…,$fn=0, $fa=12,$fs=2)
 *
 * Everything else matched byte for byte. This is the SAME dropped-`$fn` family
 * this lane has now closed three times — `rotate_extrude`, `linear_extrude`,
 * and `offset()` (found 2026-09-02) — and it is the reason `text()` looked like
 * a font-rendering job. It was not: no glyph is involved in the disagreement.
 *
 * ⚠ AND THE FIX DOES NOT MAKE US DRAW TEXT. `mesh.ts` still refuses `text()` at
 * the kernel stage and emits nothing. What changes is that the TREE stops lying
 * about a parameter it was given.
 */
export interface TextParams extends Facets {
  kind: 'text';
  text: string;
  size: number;
  font: string;
  halign: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'baseline' | 'bottom';
  spacing: number;
  direction: 'ltr' | 'rtl';
  language: string;
  script: 'latin' | 'cyrillic' | 'greek' | 'arabic' | 'chinese' | 'japanese' | 'korean';
}
export interface PolyhedronParams {
  kind: 'polyhedron';
  points: [number, number, number][];
  faces: number[][];
}

export type PrimitiveParams =
  | CubeParams
  | SphereParams
  | CylinderParams
  | SquareParams
  | CircleParams
  | PolygonParams
  | TextParams
  | PolyhedronParams;

export interface PrimitiveNode {
  kind: 'primitive';
  params: PrimitiveParams;
  line: number;
}

export interface TransformNode {
  kind: 'transform';
  op: 'translate' | 'rotate' | 'scale';
  /** translate/scale: [x,y,z]. rotate: [x,y,z] degrees. */
  v: Vec3;
  children: SceneNode[];
  line: number;
}

export interface BooleanNode {
  kind: 'boolean';
  /** 🔴 REPRESENTED, NEVER COMPUTED. See the header. */
  op: 'union' | 'difference' | 'intersection';
  children: SceneNode[];
  line: number;
}

/**
 * What the PARSER found, carried ON the scene tree's root node.
 *
 * 🔴 WHY IT RIDES ON THE TREE RATHER THAN BEING A SECOND ARGUMENT SOMEWHERE.
 * `mesh.ts` audits a mesh; it can answer *"is this solid closed and
 * orientable"* and it cannot answer *"is this the solid the source described"*.
 * Until 2026-08-11 it did not even know the second question existed: a source
 * whose only cut was refused by the parser came back `trust: 'trusted'`, a
 * correct answer about a 1 mm cube. Making the mesher take a separate argument
 * would have put the fix in the callee and left arming it to the caller, which
 * is the shape this lane has been bitten by before. Attaching it to the root
 * node means the ONLY way to hand `meshScene` a tree is to hand it this too,
 * and a tree that arrives without it is audited as *unknown*, never as clean.
 */
export interface ParseDiagnostics {
  /** Constructs refused by name. Each one is geometry the source has and the tree does not. */
  refusals: number;
  /** Syntax or evaluation failures. Each one discarded a span of the source. */
  errors: number;
  /** Things OpenSCAD warns about. Informational: the tree matches OpenSCAD anyway. */
  warnings: number;
}

/**
 * Which corner an `offset()` draws — the ONE thing that separates `r` from `delta`.
 *
 * `'round'` is `offset(r = k)`: convex corners become arcs of radius `k`.
 * `'miter'` is `offset(delta = k)`: the two offset edges are extended to their
 * intersection, so a 90° corner lands `k·√2` from the original vertex.
 *
 * ⚠ THERE IS A THIRD, `chamfer = true`, AND WE REFUSE IT RATHER THAN PICK ONE OF
 * THESE. Clipper's square join cuts the corner on a line whose position is not
 * derivable from `delta` alone, and both joins here are visibly wrong for it:
 * measured on `square([10,10])` at `delta = 2`, openscad 2026.08.07 gives
 * **193.255** against miter's 196.000 and round's 191.243. No file in
 * `hardware/cad/` uses it (checked 2026-09-21), so the cost of refusing is zero
 * and the cost of guessing is a part cut to the wrong outline.
 */
export type OffsetJoin = 'round' | 'miter';

export interface GroupNode {
  kind: 'group';
  /** `{ }`, a `for` body, a user module body, or the program root. */
  label: string;
  children: SceneNode[];
  line: number;
  /** Set on the PROGRAM ROOT only, by `parseScad`. See `ParseDiagnostics`. */
  diagnostics?: ParseDiagnostics;
  /**
   * Set by `color()` and by nothing else. Absent ⇒ this group states no colour
   * and its children inherit whatever is in force; present-but-empty
   * (`NO_COLOUR`) ⇒ a `color()` was written and resolved to nothing, which is a
   * different fact and is why it is not collapsed to absent.
   *
   * ⚠ IT IS DELIBERATELY NOT A NODE KIND OF ITS OWN. `color()` unions its
   * children exactly as a group does — measured at OpenSCAD 2026.08.07 and
   * recorded in `tools/scad_oracle/canon.mjs` — so a separate kind would force
   * every existing walker (`mesh.ts`, the oracle's canon, the tree pane) to
   * learn a node that behaves identically to one they already handle, and the
   * first walker that forgot it would DROP THE SUBTREE. An optional field is
   * ignored by an unaware reader; a new kind is not.
   */
  colour?: Colour;
  /** Set by `linear_extrude()`. The mesh kernel extrudes the children's flats.
   *  `fn` is the `$fn` in effect at the call site, carried for the tree
   *  marker's parity with OpenSCAD's `.csg` print (carried since 2026-08-27);
   *  without `twist` it has no geometric effect of its own — the children
   *  already tessellated against it through the dynamic scope. A call with
   *  `twist`/`scale` is REFUSED at the evaluator and never produces this. */
  extrude?: { height: number; center: boolean; fn: number | null };
  /** Set by `offset()`. The mesh kernel offsets the children's flat outlines. */
  /** Set by `offset()`. `f` is the `$fn`/`$fa`/`$fs` in force at the call site —
   *  carried since 2026-09-18 (TODO #169), because `offsetOutline` had been
   *  tessellating every arc at a hardcoded 16 regardless of what the source asked.
   *
   *  `join` is which corner OpenSCAD draws, and it is NOT a styling choice:
   *  `r` rounds convex corners with an arc, `delta` runs the two offset edges out
   *  to their intersection (a miter). They enclose different area — measured on
   *  `square([10,10])` at 2 mm, openscad 2026.08.07: **round 191.243, miter
   *  196.000**. Carried since 2026-09-21; before that `delta` was DISCARDED and
   *  the call was executed as `offset(r = 0)`, i.e. as no offset at all. */
  offset?: { r: number; f: Facets; join: OffsetJoin };
  /** Set by `rotate_extrude()`. The mesh kernel revolves the children's flats.
   *  `fn` is the `$fn` in effect at the call site (same semantics as
   *  {@link Facets.fn}: NaN kept — OpenSCAD reads it as "no answer" = 3; a
   *  negative warns and zeroes; null = unspecified and $fa/$fs govern).
   *  Dropped until 2026-08-27, which corpus/refuse_rotate_extrude measured as a
   *  tree DIVERGES ($fn=32 in the source, $fn=0 in the marker). `start` is the
   *  arc's beginning in degrees (OpenSCAD default 180 since the 2025 dev line)
   *  — silently starting at 0 instead misplaces every partial arc. */
  rotateExtrude?: { angle: number; fn: number | null; start: number };
  /** Set by `hull()`. The mesh kernel computes the convex hull. */
  hull?: boolean;
  /** Set by `minkowski()`. The mesh kernel computes the Minkowski sum. */
  minkowski?: boolean;
  /** Set by `resize()`. The mesh kernel scales children to fit the target size. */
  resize?: { newsize: Vec3; auto: [boolean, boolean, boolean] };
  /** Set by `projection()`. The mesh kernel projects onto XY plane. */
  projection?: { cut: boolean };
  /** Set by `multmatrix()`. The mesh kernel applies the 4×4 transform. */
  multmatrix?: { m: [number, number, number, number, number, number, number, number, number]; t: [number, number, number] };
  /** Set by `import()`. The mesh kernel parses the file content. */
  importFile?: { name: string; source: string; path: string };
  /** Set by `surface()`. The mesh kernel parses the heightmap. */
  surfaceFile?: { name: string; source: string; path: string; center: boolean; invert: boolean };
}

export type SceneNode = PrimitiveNode | TransformNode | BooleanNode | GroupNode;

/**
 * How `use <...>` and `include <...>` reach a second file.
 *
 * 🔴 THE BROWSER HAS NO FILE SYSTEM, AND THAT IS A DESIGN CONSTRAINT, NOT A
 * TEMPORARY ONE. `openscad` resolves a library path against the including
 * file's directory and then against `OPENSCADPATH`; a tab has neither. So this
 * file does not resolve anything — it asks a HOST, and the host is whatever
 * surface actually holds the sources (an opened folder, a virtual file map, a
 * Node harness). `parseScad` with no host resolves NOTHING, by construction.
 *
 * ⚠ WHAT HAPPENS WHEN IT CANNOT RESOLVE IS THE PART THAT MATTERS. The import
 * is REFUSED BY NAME, and the name contains the path that was asked for — so
 * the diagnostic says `use <../lib/brand_corner.scad>` and not `use <...>`.
 * The alternative — treating an unresolvable import as an empty file — would
 * make every module it defines an "unknown module", which reads to the user as
 * a typo in their own source rather than as a file we could not open. A
 * refusal that names the missing file is the only version of this that tells
 * the truth about whose problem it is.
 */
export interface ScadFileHost {
  /**
   * Resolve the text inside the angle brackets.
   *
   * @param spec  exactly what was written between `<` and `>`, trimmed.
   * @param from  the path of the file doing the importing. For the root parse
   *              this is `ScadOptions.path` (or `''` when none was given), so a
   *              host that resolves relatively always knows the base.
   * @returns     the resolved path (used for cycle detection and for
   *              attributing diagnostics) and the source, or `null` when the
   *              file is not available. `null` is a refusal, never an empty file.
   */
  read(spec: string, from: string): { path: string; source: string } | null;
}

export interface ScadOptions {
  /** Where `use`/`include` get their sources. Absent ⇒ every import refuses. */
  host?: ScadFileHost;
  /** The path of `src` itself, passed to `host.read` as `from`. */
  path?: string;
  /**
   * The animation step bound to `$t`. Default 0, which is what OpenSCAD binds
   * at every non-animated invocation — so omitting it reproduces this reader's
   * behaviour exactly as it was before the option existed.
   *
   * ⚠ A source that never reads `$t` produces identical geometry at every
   * value, and that identity is the SIGNAL the verifier uses: "mentions `$t`"
   * and "moves when `$t` moves" are different facts, and only the second is an
   * animation.
   */
  t?: number;
  /**
   * Evaluate for a PRINT, not a picture (2026-11-12: the pot saucer printed as visible flats — 48 segments of 9.15 mm
   * on a 140 mm rim, 0.15 mm off the circle — because the STL sent to the 3d tab was built with `$preview` true and the
   * source says `$fn = $preview ? 48 : 160`). When set: `$preview` is FALSE, as in OpenSCAD's own `-o stl`, and the
   * root binds `$fa = PRINT_FA` / `$fs = PRINT_FS` instead of OpenSCAD's coarse 12 / 2, which give 30 flats on any
   * large circle. A source that sets its own `$fn`/`$fa`/`$fs` still wins: those bind below the root.
   * ⚠ The sibling-union rule in `mesh.ts` is NOT moved with it (see `rootEnv`): top-level siblings stay separate
   * solids in the STL, which the slicer reads as overlapping shells. Absent ⇒ behaviour exactly as before.
   */
  render?: boolean;
  /**
   * With `render`, the root `$fa`/`$fs` (default `PRINT_FA`/`PRINT_FS`). `cad/machine.ts`'s resolution ladder passes
   * OpenSCAD's own 12 / 2 here as its second tier. A source's own `$fn`/`$fa`/`$fs` still win, exactly as with the
   * default. Ignored without `render` (the preview's root never bound them).
   */
  renderFaFs?: { fa: number; fs: number };
  /**
   * An UPPER BOUND on fragments per full circle, applied where this evaluator resolves `$fn`/`$fa`/`$fs` for a curve
   * (`facetsFrom`, `rotate_extrude`, `linear_extrude`). It overrides even the source's own `$fn` — but only
   * downwards: a source asking for fewer than the cap keeps what it asked for, and nothing is ever raised.
   *
   * 🔴 USED ONLY BY `cad/machine.ts`'s RESOLUTION LADDER (2026-11-13), as its last two tiers, when a machine build
   * at a finer resolution ran out of the kernel's polygon/work budget. The SHAPE is unchanged (same `$preview`, same
   * tree); only the circles are coarser, and the ladder reports which tier was used so the coarsening is stated,
   * never silent.
   *
   * ⚠ A source that builds its own circle out of `polygon()` points (a `for` over `$fn`) is NOT capped: those are
   * the source's coordinates, not a tessellation this evaluator chose.
   *
   * Absent ⇒ no cap (the viewport, and every caller before the ladder). Must be an integer ≥ 5 — the `$fa`/`$fs`
   * path never draws fewer than 5 (OpenSCAD's own floor), so a smaller cap could not be honoured; it is refused.
   */
  maxFragments?: number;
}

/** Print defaults for `render`: a 70 mm radius gets 180 segments (0.011 mm off the circle), a 1.5 mm hole (r 0.75) 16, from max(5, ceil(min(360/$fa, 2πr/$fs))). */
export const PRINT_FA = 2;
export const PRINT_FS = 0.3;

export interface ScadResult {
  /** Always present. Empty children means nothing was understood, not "nothing was drawn". */
  scene: GroupNode;
  unsupported: Unsupported[];
  errors: ScadError[];
  /** See `ScadWarning` — produced, counted, and rendered by nothing today. */
  warnings: ScadWarning[];
  /** Lines produced by `echo()`. Ordered by source line. */
  console: ScadEchoLine[];
  counts: {
    primitives: number;
    transforms: number;
    booleans: number;
    groups: number;
  };
}

// ---------------------------------------------------------------------------
// Limits. A browser tab that hangs is a defect, and an infinite `for` is one
// keystroke away in any language with loops. Every limit reports itself as an
// error rather than returning a truncated tree that looks complete.
// ---------------------------------------------------------------------------

const MAX_NODES = 20000;
const MAX_CALL_DEPTH = 64;
/**
 * Nesting depth of BUILT-IN statements (`translate`, `union`, `difference`, …).
 *
 * 🔴 `MAX_CALL_DEPTH` DOES NOT COVER THIS AND ITS NAME SAYS IT DOES. (#163,
 * 2026-09-17.) That counter is incremented only for USER module and function
 * calls; `Evaluator.exec` ⇄ `Evaluator.execCall` recurses once per nested
 * built-in and touches it never. **Measured:** `translate([0,0,1])` nested 616
 * deep threw a raw `RangeError: Maximum call stack size exceeded` out of
 * `parseScad`, with `MAX_CALL_DEPTH` sitting at 64 the whole way down.
 *
 * ⚠ A GUARD WHOSE NAME DESCRIBES THE DEFECT IT DOES NOT CATCH IS WORSE THAN NO
 * GUARD. Anyone auditing this file for unbounded recursion finds `MAX_CALL_DEPTH`,
 * reads "call depth", and stops looking.
 *
 * **200, and it MUST STAY BELOW `MAX_DEPTH` in `mesh.ts` (256).** The deepest
 * design in `hardware/cad` is **21** (389 of 389 files, median 3, p99 13); the
 * measured ceiling here is **616**; and a stack limit belongs to the RUNTIME, so
 * the browser's is not node's.
 *
 * 🔴 THE GAP BETWEEN THE TWO IS THE POINT, NOT SLACK. Setting both to 256 was
 * tried and was wrong: `meshScene` walks the parser's tree **plus the root group
 * the parser adds**, so source nested 255 deep arrives as a scene of depth 256
 * and was refused by the mesher after the parser had accepted it. ⇒ **A file the
 * reader accepted then drew nothing, with two different limits both reading 256
 * and neither obviously at fault.** Two counters that count different things must
 * not be given the same number just because the number looks tidy.
 */
const MAX_NEST_DEPTH = 200;
const MAX_LOOP_ITERATIONS = 200000;
/**
 * User FUNCTIONS get their own, deeper budget than modules.
 *
 * A recursive module is almost always a mistake; a recursive function is the
 * ordinary way OpenSCAD expresses a fold over a list, and 64 would refuse
 * working code. It is still bounded, and hitting it is an ERROR that names
 * recursion — never a value.
 */
const MAX_FN_DEPTH = 256;
/** `include` inside `include` inside … A cycle is caught by name; this catches a chain. */
const MAX_IMPORT_DEPTH = 16;
/** Total files pulled in by one parse, cycles excluded. A tab must not fan out forever. */
const MAX_IMPORTS = 128;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'num' | 'str' | 'ident' | 'op' | 'eof';

interface Token {
  kind: TokKind;
  text: string;
  num: number;
  line: number;
  /**
   * Half-open character range in the source this token was lexed from.
   *
   * 🔴 IT EXISTS FOR ONE CONSTRUCT: `use <../lib/brand_corner.scad>`. A library
   * path is NOT a token — the lexer sees `.` `.` `/` `lib` `/` `brand_corner`
   * `.` `scad`, and rebuilding the path by concatenating token TEXT loses every
   * character the lexer does not keep (a space, a `+`, anything it reported as
   * unexpected). Reconstructing "close enough" would open a file next to the
   * one the source names, which is the same class of failure as reading the
   * wrong branch of a database. The range lets the parser take the path from
   * the SOURCE, byte for byte, between the brackets.
   */
  pos: number;
  end: number;
}

const TWO_CHAR_OPS = ['<=', '>=', '==', '!=', '&&', '||'];
// `^` is OpenSCAD's exponentiation operator, not a stray character. Until
// 2026-08-11 it was absent from this string, so `2^3` was reported as
// `unexpected character "^"` and the parser's recovery then DISCARDED the rest
// of the statement — a missing operator diagnosed as a typing accident, with a
// second construct able to hide inside the skipped span.
const ONE_CHAR_OPS = '+-*/%^()[]{},;=<>?:.!#&|';

const NUM_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^\$?[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Optional sink for {@link highlightSpans}. Called once per lexeme the tokenizer
 * consumes, with the HALF-OPEN character range it consumed.
 *
 * 🔴 IT EXISTS SO THE EDITOR CANNOT HAVE A SECOND IDEA OF WHAT A TOKEN IS. The
 * highlighter is driven by THIS function — the same one the parser is driven by
 * — so a colour and a parse can never disagree about where a token starts or
 * ends. A regex approximation next to a real lexer is this lane's recurring
 * defect wearing a syntax-highlighter costume: it agrees for a week and then
 * colours something the parser reads differently, and the user believes the
 * colour.
 *
 * ⚠ The sink is told about COMMENTS too, which the token stream itself drops.
 * A highlighter that cannot see a comment cannot colour one, and gap-filling
 * them as plain text would make `// difference()` look like code.
 */
type SpanSink = (start: number, end: number, kind: HighlightKind) => void;

/**
 * The largest value OpenSCAD's INTEGER token rule can produce, and it is not an
 * error there. `{D}+` (`src/core/lexer.l:309-322`) runs `strtoull`, which
 * saturates at `ULLONG_MAX` and sets `errno`; the fallback
 * `boost::lexical_cast<double>` then throws for a digit string past the double
 * range, leaving `parserlval.number` at the saturated `ULLONG_MAX` — and the
 * rule `return`s a token regardless. Measured 2026-08-11, `echo(<400 nines>)`:
 * `WARNING: Integer "999…" cannot be represented precisely`, then
 * `ECHO: 1.84467e+19`. `parseFloat` gives `Infinity` for the same text, so
 * without this the two lexers disagree on a value that goes straight into
 * geometry.
 */
const LEX_ULLONG_MAX = 18446744073709551616; // 2^64, ULLONG_MAX as a double

function tokenize(
  src: string,
  errors: ScadError[],
  sink?: SpanSink,
  warnings: ScadWarning[] = [],
): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;

  const push = (kind: TokKind, text: string, num: number, pos: number, end: number) => {
    out.push({ kind, text, num, line, pos, end });
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const from = i;
      while (i < src.length && src[i] !== '\n') i++;
      sink?.(from, i, 'comment');
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const opened = line;
      const from = i;
      i += 2;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (src[i] === '\n') line++;
        i++;
      }
      if (!closed) {
        errors.push({ line: opened, message: 'block comment opened with /* is never closed' });
      }
      sink?.(from, i, 'comment');
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) {
          text += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          closed = true;
          j++;
          break;
        }
        if (src[j] === '\n') break;
        text += src[j];
        j++;
      }
      if (!closed) {
        errors.push({ line, message: 'string literal is never closed' });
      }
      push('str', text, 0, i, j);
      sink?.(i, j, 'string');
      i = j;
      continue;
    }

    const rest = src.slice(i);

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = NUM_RE.exec(rest);
      if (m) {
        const value = parseFloat(m[0]);
        // 🔴 A LITERAL THAT OVERFLOWS TO INFINITY IS NOT A NUMBER IN OPENSCAD,
        // AND THE TWO TOKEN RULES DO DIFFERENT THINGS WITH IT. Measured against
        // openscad 2026.08.07 on 2026-08-11, and read at `src/core/lexer.l`:
        //
        //   FLOAT FORM (has a `.` or an exponent) — `{D}+{E}` and friends,
        //   `lexer.l:301-308`. The action is a `try { … return TOK_NUMBER; }`
        //   around `boost::lexical_cast<double>`, and `bad_lexical_cast` is
        //   caught with an EMPTY handler — no diagnostic, no token. So the
        //   literal is DELETED from the stream and whatever surrounds it has to
        //   parse without it:
        //       `echo(1e400);`         → `ECHO: ` — echo() with no argument
        //       `circle(r=10,$fn=1e400);` → `ERROR: Parser error: syntax error`,
        //                                    exit 1, nothing exported
        //   The SAME literal is fatal in one place and invisible in the other.
        //   Dropping the token is what reproduces both, so that is what happens
        //   here — with a warning, because a silent deletion in a file whose
        //   whole job is to say what it could not read is the defect this lane
        //   keeps filing.
        //
        //   INTEGER FORM (digits only) — `lexer.l:309-322`. That rule always
        //   returns a token; overflow saturates at `ULLONG_MAX` and warns. See
        //   `LEX_ULLONG_MAX`. `1e400` and `<400 nines>` therefore have entirely
        //   different fates in OpenSCAD, and `parseFloat` gives `Infinity` for
        //   both.
        if (!Number.isFinite(value)) {
          if (/[.eE]/.test(m[0])) {
            warnings.push({
              line,
              message:
                `the numeric literal ${m[0]} overflows to infinity. OpenSCAD's lexer cannot convert it and ` +
                'drops the token entirely, with no message (src/core/lexer.l:301-308) — so the surrounding ' +
                'text must parse without it, and where a value was required that is a syntax error and the ' +
                'whole file exports nothing. The token is dropped here too; any parse error below is that.',
            });
            sink?.(i, i + m[0].length, 'number');
            i += m[0].length;
            continue;
          }
          // OpenSCAD's own wording (`lexer.l:314-316`), with its own value.
          warnings.push({
            line,
            message:
              `Integer "${m[0]}" cannot be represented precisely — OpenSCAD saturates it at ULLONG_MAX ` +
              '(2^64 once it is a double) and carries on (src/core/lexer.l:309-322). It is NOT infinity, and ' +
              'it is not the number that was written.',
          });
          push('num', m[0], LEX_ULLONG_MAX, i, i + m[0].length);
          sink?.(i, i + m[0].length, 'number');
          i += m[0].length;
          continue;
        }
        push('num', m[0], value, i, i + m[0].length);
        sink?.(i, i + m[0].length, 'number');
        i += m[0].length;
        continue;
      }
    }

    const im = IDENT_RE.exec(rest);
    if (im) {
      push('ident', im[0], 0, i, i + im[0].length);
      sink?.(i, i + im[0].length, classifyIdent(im[0]));
      i += im[0].length;
      continue;
    }

    const two = rest.slice(0, 2);
    if (TWO_CHAR_OPS.includes(two)) {
      push('op', two, 0, i, i + 2);
      sink?.(i, i + 2, 'op');
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(c)) {
      push('op', c, 0, i, i + 1);
      sink?.(i, i + 1, c === '#' ? classifyIdent('#') : 'op');
      i++;
      continue;
    }

    errors.push({ line, message: `unexpected character ${JSON.stringify(c)}` });
    i++;
  }

  out.push({ kind: 'eof', text: '', num: 0, line, pos: src.length, end: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Expr =
  | { t: 'num'; v: number; line: number }
  | { t: 'str'; v: string; line: number }
  | { t: 'bool'; v: boolean; line: number }
  | { t: 'undef'; line: number }
  | { t: 'var'; name: string; line: number }
  | { t: 'vec'; items: Expr[]; line: number }
  /**
   * `each x` in ELEMENT POSITION — a vector literal's item, or a list
   * comprehension's body. It is not a general expression: `a + each b` is
   * meaningless, so a stray one is refused by name at evaluation.
   */
  | { t: 'each'; value: Expr; line: number }
  | { t: 'range'; start: Expr; step: Expr | null; end: Expr; line: number }
  | { t: 'unary'; op: string; e: Expr; line: number }
  | { t: 'binary'; op: string; l: Expr; r: Expr; line: number }
  | { t: 'ternary'; c: Expr; a: Expr; b: Expr; line: number }
  | { t: 'index'; e: Expr; i: Expr; line: number }
  | { t: 'call'; name: string; args: Arg[]; line: number }
  /** `let (a = 1, b = a + 1) <expr>` — bindings are SEQUENTIAL (probed). */
  | { t: 'let'; binds: { name: string; value: Expr }[]; body: Expr; line: number }
  /* `assert(cond, msg) expr` — OpenSCAD's EXPRESSION form, distinct from the
   * statement/module form the evaluator already had. It checks, then yields the
   * trailing expression (undef if there is none). ⚠ There is NO comma before that
   * expression, which is why a parser that only knew the call form reported
   * `expected ")"` and dropped the whole file. */
  | { t: 'assertexpr'; args: Arg[]; body: Expr | null; line: number }
  /** `function(x) x * 2` — a function literal, evaluates to a callable value. */
  | { t: 'fndef'; params: Param[]; body: Expr; line: number }
  /**
   * `[for (i = range) expr]`, `[for (i = range) if (cond) expr else alt]`,
   * `[let (x = expr) body]`, etc. — evaluates to a list value, not geometry.
   */
  | { t: 'listcomp'; clauses: LCompClause[]; body: Expr; elseBody: Expr | null; line: number }
  /** A construct that parsed but is refused. Evaluates to undef and reports itself once. */
  | { t: 'refused'; name: string; detail: string; line: number };

/** A clause in a list comprehension: `for (…)`, `let (…)`, or `if (…)`. */
type LCompClause =
  | { t: 'for'; bindings: { name: string; value: Expr }[] }
  | { t: 'let'; binds: { name: string; value: Expr }[] }
  | { t: 'if'; cond: Expr };

interface Arg {
  name: string | null;
  value: Expr;
}

interface Param {
  name: string;
  def: Expr | null;
}

type Stmt =
  | { t: 'assign'; name: string; value: Expr; line: number }
  | { t: 'moduledef'; name: string; params: Param[]; body: Stmt; line: number }
  | { t: 'functiondef'; name: string; params: Param[]; body: Expr; line: number }
  | { t: 'block'; body: Stmt[]; line: number }
  | { t: 'call'; name: string; args: Arg[]; child: Stmt | null; disabled: boolean; line: number }
  | { t: 'for'; bindings: { name: string; value: Expr }[]; body: Stmt; line: number }
  | { t: 'intersection_for'; bindings: { name: string; value: Expr }[]; body: Stmt; line: number }
  | { t: 'if'; cond: Expr; then: Stmt; else: Stmt | null; line: number }
  /** `let (a = 1) <statement>` — a scope, and OpenSCAD wraps it in a `group()`. */
  | { t: 'letstmt'; binds: { name: string; value: Expr }[]; body: Stmt; line: number }
  /**
   * A resolved `include <...>`, and it is DELIBERATELY NOT A SCOPE.
   *
   * 🔴 `include` IS TEXTUAL AND `use` IS NOT, AND GETTING THAT BACKWARDS ADDS OR
   * DROPS GEOMETRY SILENTLY (probed on 2026.08.07): a file containing
   * `shared = 7; module libm(s=2) cube(s); cube(1);` gives, under `include`, a
   * top-level `cube(1)` AND `shared == 7`; under `use`, NO `cube(1)` and
   * `shared` undefined. Both import the module and the function.
   *
   * So an `include` body is SPLICED into the statement list of whatever scope
   * the `include` was written in, before that scope's own hoisting and
   * last-assignment-wins pass runs — which is what makes an included assignment
   * participate in the including scope, exactly as if the text were pasted.
   */
  | { t: 'inline'; body: Stmt[]; path: string; line: number }
  /** A resolved `use <...>`: its modules and functions only, closing over ITS OWN scope. */
  | {
      t: 'use';
      body: Stmt[];
      path: string;
      line: number;
      /** 🔴 THIS BODY CAME FROM A DEFINITIONS-ONLY RE-READ OF A CYCLED FILE.
       *  Its top-level assignments are BOUND (so a module's default parameter can
       *  name its own file's variables — TODO #165) but their failures are NOT
       *  REPORTED, because the file is mid-cycle and names it imports may not
       *  exist yet in that re-read. See `bindScope`'s `quiet` branch. */
      defsOnly?: true;
    }
  /** The `!` root modifier: this subtree BECOMES the whole model. */
  | { t: 'root'; body: Stmt; line: number }
  /**
   * The `%` background modifier. Contributes NO geometry — which is what
   * OpenSCAD's render and export do with it — but the body is KEPT rather than
   * thrown away, because a `!` written inside a `%` subtree still governs the
   * whole model in OpenSCAD. See `case 'background'` in `exec`.
   */
  | { t: 'background'; body: Stmt; line: number }
  | { t: 'refused'; name: string; detail: string; line: number }
  | { t: 'empty'; line: number };

// ---------------------------------------------------------------------------
// Constructs this subset implements, and the ones it knows by name and refuses.
//
// The refusal table is explicit rather than "anything not in the supported set",
// because a NAMED refusal tells the user what the tool would have to grow,
// while "unknown module" tells them they might have typed it wrong. Both are
// reported; they are different facts.
// ---------------------------------------------------------------------------

const PRIMITIVES = new Set(['cube', 'sphere', 'cylinder', 'square', 'circle', 'polygon', 'text', 'polyhedron']);
const TRANSFORMS = new Set(['translate', 'rotate', 'scale', 'mirror']);
const BOOLEANS = new Set(['union', 'difference', 'intersection']);

/**
 * 🔴 MODULES THAT ARE PURE APPEARANCE OR PURE SCHEDULING, AND THEREFORE HAVE
 * NO GEOMETRY OF THEIR OWN. They wrap their children and change nothing about
 * the solid, so the only honest implementation is to become their children.
 *
 * Refusing them was not a conservative choice, it was the expensive one: **a
 * refused node takes its whole subtree with it**, so `color("red") part();`
 * did not lose the colour, it deleted the part. Measured 2026-08-11 by
 * `tools/scad_oracle` over `hardware/cad/` — the 68 `.scad` files this company
 * actually cuts — where `color()` alone accounted for **198 of 360 refusal
 * sites across 36 files**, and NOT ONE of the 68 produced a solid the oracle
 * could compare.
 *
 * ⚠ `color()` WAS A PASS-THROUGH FOR GEOMETRY ONLY UNTIL 2026-08-11, AND THE
 * SENTENCE THAT SAID SO IS KEPT HERE BECAUSE IT NAMES THE DEFECT THAT FOLLOWED
 * FROM IT. It read *"nothing here renders colour and nothing downstream carries
 * it, so the appearance argument is discarded"* — true of the code, and it made
 * `color()` the one construct that was **accepted, changed nothing, and warned
 * nobody**, which is precisely the class `docs/audit/2026-08-11-scad-silent-
 * divergence.md` exists to enumerate and the one it did not hold. The colour is
 * now carried: `execCall` resolves it onto `GroupNode.colour`, `mesh.ts`
 * inherits it down the tree onto each part, and `preview.tsx` paints it.
 */
// The value is the SCENE-TREE LABEL, because the scene tree is a surface the
// tab actually renders — a node that says what was discarded is visible, and a
// warning in a list nothing draws is not.
//
// · `color()`  — carries a colour now. It stays in this table so `classifyIdent`
//   still colours it as a builtin and so `execCall` still routes it through the
//   group-building branch; the label here is only the one used when the
//   arguments resolved to no colour at all, and every other case gets a label
//   built by `colourLabel()`.
// · `render()` — forces OpenSCAD to evaluate a subtree eagerly rather than
//   previewing it. The resulting geometry is identical and this file has one
//   evaluation path, so there is nothing to do.
// · `#`        — the highlight modifier, which is real geometry in OpenSCAD's
//   own export. See the note in `parseStatement`.
const PASSTHROUGH_MODULES: Record<string, string> = {
  color: 'color() (no colour resolved — the geometry passes through)',
  render: 'render() (pass-through — one evaluation path here, so nothing to force)',
  '#': '# highlight (pass-through — real geometry, drawn WITHOUT the highlight)',
};

/**
 * ⚠ THE REASONS BELOW ARE PART OF THE REFUSAL, NOT DECORATION. A refusal whose
 * stated reason stopped being true reads as a bigger gap than we have, and it
 * is the sentence a reader uses to decide what would have to be built.
 *
 * Six of these said *"needs a geometry kernel"*. They were written for stage 1,
 * **before `mesh.ts` existed**, and by 2026-08-11 the CSG kernel, the affine
 * stack and the bounding boxes they were waiting for had all been built. What
 * each one actually still needs is now named specifically.
 */
const KNOWN_REFUSED_MODULES: Record<string, string> = {
  // minkowski is now handled — see the evaluator and mesh.ts.
  // hull is now handled — see the evaluator and mesh.ts.
  // offset is now handled — see the evaluator.
  // linear_extrude is now handled — see the evaluator.
  // rotate_extrude is now handled — see the evaluator and mesh.ts.
  // polygon is now handled — see the evaluator.
  // polyhedron is now handled — see the evaluator and mesh.ts.
  // mirror is now handled — the transform evaluator flips winding on negative determinant.
  // multmatrix is now handled — see the evaluator.
  // resize is now handled — see the evaluator and mesh.ts.
  // import is now handled — see the evaluator and mesh.ts.
  // surface is now handled — see the evaluator and mesh.ts.
  // text is now handled — see the evaluator and mesh.ts.
  // projection is now handled — see the evaluator and mesh.ts.
  // echo is now handled — see the evaluator.
  // assert is now handled — see the evaluator.
  // intersection_for is now handled — see the evaluator.

  hulls: 'not an OpenSCAD module',
};

/**
 * The type predicates. Implemented, and `is_undef` carries a SPECIAL FORM — see
 * `Evaluator.predicate`.
 */
const IS_PREDICATES = new Set(['is_undef', 'is_bool', 'is_num', 'is_string', 'is_list', 'is_function']);

const MATH_FNS = new Set([
  'abs',
  'sign',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sqrt',
  'pow',
  'exp',
  'ln',
  'log',
  'min',
  'max',
  'floor',
  'ceil',
  'round',
  'len',
  'norm',
  'concat',
  'str',
]);

/**
 * Words the language itself owns. Not a geometry list — `parseStatement` and
 * `parseModuleDef` branch on these by literal text, so they are keywords in the
 * only sense that matters here: the parser treats them specially.
 */
const KEYWORDS = new Set([
  'module',
  'function',
  'if',
  'else',
  'for',
  'true',
  'false',
  'undef',
  'include',
  'use',
  'let',
]);

/**
 * What a lexeme should be COLOURED as.
 *
 * 🔴 `refused` IS A CATEGORY ON PURPOSE, and it is the one that earns this
 * feature. The tab's whole contract is that an unsupported construct is named
 * with its line and contributes nothing — so the editor colouring
 * `minkowski()` differently from `cube()` tells the user, at the moment they
 * type it, what the diagnostics list will tell them a keystroke later. It is
 * the same fact arriving earlier, not a second opinion: the set below IS
 * `KNOWN_REFUSED_MODULES`, so a construct that stops being refused stops being
 * coloured as refused in the same edit.
 */
export type HighlightKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  /** `$fn`, `$fa`, `$fs` and any other `$`-prefixed name. */
  | 'special'
  | 'keyword'
  /** A module or function this evaluator genuinely implements. */
  | 'builtin'
  /** A module we know by name and REFUSE — see `KNOWN_REFUSED_MODULES`. */
  | 'refused'
  | 'ident'
  | 'op';

/** A half-open `[start, end)` character range of the source, and its colour. */
export interface HighlightSpan {
  start: number;
  end: number;
  kind: HighlightKind;
}

function classifyIdent(text: string): HighlightKind {
  if (text.startsWith('$')) return 'special';
  if (KEYWORDS.has(text)) return 'keyword';
  if (Object.prototype.hasOwnProperty.call(KNOWN_REFUSED_MODULES, text)) return 'refused';
  if (Object.prototype.hasOwnProperty.call(PASSTHROUGH_MODULES, text)) return 'builtin';
  if (PRIMITIVES.has(text) || TRANSFORMS.has(text) || BOOLEANS.has(text) || MATH_FNS.has(text)) {
    return 'builtin';
  }
  if (IS_PREDICATES.has(text) || text === 'children' || text === 'echo' || text === 'assert') return 'builtin';
  return 'ident';
}

/**
 * Every character of `src`, in order, partitioned into coloured spans.
 *
 * 🔴 THE CONTRACT THE EDITOR DEPENDS ON, and the one the test asserts:
 * concatenating `src.slice(s.start, s.end)` over the returned spans reproduces
 * `src` EXACTLY — same characters, same order, nothing added, nothing dropped.
 * The highlighter renders these spans underneath a transparent `<textarea>`,
 * so any span set that did not reproduce the text would put the caret
 * somewhere other than where it appears to be. A highlighter is allowed to be
 * wrong about a COLOUR; it is never allowed to be wrong about a CHARACTER.
 *
 * Whitespace and anything the lexer could not classify come back as `plain`,
 * which is why the gaps are filled rather than skipped.
 *
 * ⚠ Lexical only. It knows `difference` is a builtin word; it does not know
 * whether this particular `difference()` was refused for having a 2D operand.
 * The diagnostics list is the authority on what happened; this is the
 * authority on where the words are.
 */
export function highlightSpans(src: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  // Thrown away: a highlighter must never surface a diagnostic. `parseScad` is
  // the one place errors are reported from, and reporting them twice from two
  // callers is how two lists start disagreeing about a count.
  const discard: ScadError[] = [];
  const lexed: HighlightSpan[] = [];
  tokenize(src, discard, (start, end, kind) => lexed.push({ start, end, kind }));

  let at = 0;
  for (const s of lexed) {
    // The tokenizer walks forward and never revisits, so this only ever fills
    // whitespace and unclassifiable characters. Guarded anyway: a span that
    // went backwards would duplicate text, which is the one failure that
    // silently misaligns the caret.
    if (s.start > at) spans.push({ start: at, end: s.start, kind: 'plain' });
    if (s.start >= at) {
      spans.push(s);
      at = s.end;
    }
  }
  if (at < src.length) spans.push({ start: at, end: src.length, kind: 'plain' });
  return spans;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class ParseFailure extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

/**
 * Everything one `parseScad` call shares with every file it pulls in: the host,
 * the running import budget, and the chain of paths currently open (which is
 * what makes `a includes b includes a` a NAMED refusal rather than a hang).
 */
interface ImportCtx {
  host: ScadFileHost | undefined;
  /** Files opened so far this parse, cycles excluded. Guards `MAX_IMPORTS`. */
  count: number;
  /**
   * 🔴 DEFINITIONS-ONLY READS, MEMOISED BY RESOLVED PATH FOR THE LIFE OF ONE
   * PARSE. TODO #165.
   *
   * **Why this is sound, stated because a wrong memo key is how a cache becomes
   * a correctness bug:** a definitions-only read keeps only `function` and
   * `module` definitions and now follows its own imports IN THE SAME MODE. Its
   * result is therefore a function of the resolved path and nothing else — not
   * of `openPaths`, not of who asked. ⚠ That was NOT true before this change,
   * when defs-only reads refused their imports: a result then depended on where
   * the refusal landed, which is exactly the shape that makes a path-keyed cache
   * return one caller's answer to another. **A first attempt at memoising was
   * reverted for regressing `2bee_hive_super_panel_wcnc.scad` from clean to 26
   * errors** — same key, but caching a context-dependent value.
   *
   * **And it is the memo that makes following imports affordable at all.**
   * Without it, `2bee_hive/2bee_hive_panels_18mm.scad` burned the 128-file budget
   * on re-reads of the same handful of files and refused
   * `use <2bee_hive_floor_wcnc.scad>`, reporting `bb_floor_flat()` as unknown
   * while it was defined one file away. `count` is incremented on a MISS ONLY —
   * charging the budget per encounter instead of per file is the same defect
   * wearing a counter.
   */
  /**
   * 🔴 RESOLVED PATHS ALREADY CHARGED TO `count`. TODO #165, 2026-09-17.
   *
   * `MAX_IMPORTS` exists to bound how much of a tree one parse pulls in. It was
   * charging **per ENCOUNTER**, so a file imported by ten siblings cost ten.
   * **Measured on `2bee_hive/2bee_hive_panels_18mm_inner_wcnc.scad`: 146 host
   * reads for 33 DISTINCT files**, and the 128 budget ran out before
   * `2bee_hive_floor_wcnc.scad` was ever read — which is why `bb_floor_flat()`
   * was reported as *"not a module this subset knows"* while sitting in a file
   * the source names on line 18.
   *
   * ⚠ THE BUDGET IS UNCHANGED AND DELIBERATELY SO. Raising it was tried and
   * produced **154 evaluation errors** on this same file; the fan-out was the
   * disease. This charges the same 128 against the quantity the limit was always
   * describing — *files pulled into one parse* — rather than the number of times
   * they were mentioned.
   *
   * ⚠ AND IT IS NOT A PARSE CACHE. The body is still parsed per site, because a
   * file's parse depends on `openPaths` — the same file is a cycle from one
   * importer and not from another — and reusing one caller's tree for another is
   * precisely what regressed `2bee_hive_super_panel_wcnc.scad` from clean to 26
   * errors when a memo was last attempted here. **Only the ACCOUNTING is shared.**
   */
  charged: Set<string>;
  defsMemo: Map<string, Stmt[]>;
  /** Paths whose defs-only read is on the stack right now. A second encounter
   *  returns no definitions rather than recursing — the cycle's base case. */
  defsOpen: Set<string>;
}

class Parser {
  private p = 0;
  /** Statement nesting while BUILDING the tree. See `MAX_NEST_DEPTH`. */
  private nest = 0;

  constructor(
    private toks: Token[],
    private errors: ScadError[],
    /** The exact source these tokens came from. Used ONLY to slice import paths. */
    private src: string,
    /** Shared across the whole parse, including every imported file. */
    private imports: ImportCtx,
    /** This file's own path, handed to `host.read` as `from`. */
    private selfPath: string,
    /** Resolved paths currently open, innermost last. `selfPath` is its last entry. */
    private openPaths: readonly string[],
    /** Lexer-level warnings for this file. An imported file gets its own and the
     *  entries are re-attributed to the `include` line on the way out — the same
     *  rule `subErrors` follows, for the same reason: a line number that indexes
     *  a different file is worse than no line number. */
    private warnings: ScadWarning[] = [],
    /**
     * Definitions-only mode: every nested `include`/`use` is REFUSED by name.
     *
     * 🔴 IT EXISTS FOR ONE CASE — a `use` whose target is already open, i.e. a
     * cycle. See `parseIncludeLike`. It is what stops that re-read from
     * recursing forever, and it is why the refusal it emits is a real refusal
     * with a sentence rather than a silent empty body.
     */
    private defsOnly = false,
  ) {}

  private peek(k = 0): Token {
    return this.toks[Math.min(this.p + k, this.toks.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.p++;
    return t;
  }
  private isOp(text: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'op' && t.text === text;
  }
  private isIdent(text: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === 'ident' && t.text === text;
  }
  private eatOp(text: string): boolean {
    if (this.isOp(text)) {
      this.p++;
      return true;
    }
    return false;
  }
  private expectOp(text: string): void {
    if (!this.eatOp(text)) {
      const t = this.peek();
      throw new ParseFailure(t.line, `expected ${JSON.stringify(text)}, found ${describe(t)}`);
    }
  }

  parseProgram(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek().kind !== 'eof') {
      const before = this.p;
      try {
        body.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseFailure)) throw e;
        this.errors.push({ line: e.line, message: e.message });
        // Recover at the next statement boundary so ONE typo does not erase the
        // rest of the file. Be clear about the cost: the tokens between the
        // failure and that boundary are DISCARDED and are not reported one by
        // one, so a file with an error can hide a second construct inside the
        // skipped span. That is why an error is an error and not a refusal, and
        // why the UI shows the error count next to the tree.
        this.recover();
      }
      if (this.p === before) this.p++; // never spin
    }
    return body;
  }

  private recover(): void {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      if (this.isOp('{')) depth++;
      if (this.isOp('}')) {
        if (depth === 0) return;
        depth--;
      }
      const wasSemi = this.isOp(';');
      this.p++;
      if (wasSemi && depth === 0) return;
    }
  }

  private parseStatement(): Stmt {
    const t = this.peek();
    const line = t.line;

    if (this.isOp(';')) {
      this.p++;
      return { t: 'empty', line };
    }
    if (this.isOp('{')) {
      this.p++;
      const body: Stmt[] = [];
      while (!this.isOp('}') && this.peek().kind !== 'eof') {
        const before = this.p;
        try {
          body.push(this.parseStatement());
        } catch (e) {
          if (!(e instanceof ParseFailure)) throw e;
          this.errors.push({ line: e.line, message: e.message });
          this.recover();
        }
        if (this.p === before) this.p++;
      }
      this.expectOp('}');
      return { t: 'block', body, line };
    }

    // ---- the four modifier characters ------------------------------------
    //
    // 🔴 THEY ARE LANGUAGE, NOT EDITOR CHROME, AND THREE OF THE FOUR WERE
    // HANDLED THE SAME WAY: refused, subtree dropped. That was written when
    // "this tab shows no geometry" was true. It is not true now, and the shared
    // treatment made `!` produce the EXACT INVERSE of the model — OpenSCAD
    // renders only the marked subtree, and we dropped the marked subtree and
    // kept everything else. `!cube(); sphere();` drew the sphere here and draws
    // the cube in OpenSCAD: not a missing feature, the opposite object.
    //
    // Each is now settled on what it does to the EXPORTED GEOMETRY, measured
    // against OpenSCAD 2026.08.07 (`-o csg` and `-o stl`):
    if (this.isOp('*')) {
      // disable — the subtree is absent from OpenSCAD's tree and from ours.
      this.p++;
      const inner = this.parseStatement();
      return disableStatement(inner, line);
    }
    if (this.isOp('!')) {
      // show-only — probed: the marked subtree becomes the ROOT, and its
      // ancestors go with everything else (`translate([50,0,0]) !cube(5);`
      // emits a bare `cube`, no `multmatrix`). A second `!` warns and the FIRST
      // one wins.
      this.p++;
      const inner = this.parseStatement();
      // 🔴 `*` ANNIHILATES A `!` WRITTEN ON THE SAME STATEMENT, AND THE GUARD
      // IS THE WHOLE RULE. `src/core/parser.y` is three lines:
      //
      //     '*' module_instantiation  { delete $2; $$ = NULL; }
      //     '!' module_instantiation  { $$ = $2; if ($$) $$->tag_root = true; }
      //
      // `*` deletes the instantiation, so the `!` has nothing to tag and the
      // file ends up with NO root modifier at all — the rest of it renders
      // normally. Measured on 2026.08.07: `!*cube(5); sphere(20,$fn=16);`
      // exports the **sphere** (252 facets); this file exported **nothing**,
      // with no error, no warning and no refusal. Same for `!*union(){...}`.
      if (inner.t === 'empty' || (inner.t === 'call' && inner.disabled)) return inner;
      // `!!cube(5)` is ONE instantiation tagged twice, not two roots: the
      // production above re-runs on the same `$2`. OpenSCAD renders the cube
      // and does NOT warn (the "more than one" check compares `modinst`
      // pointers). Collapsing here is what makes both true.
      if (inner.t === 'root') return inner;
      return { t: 'root', body: inner, line };
    }
    if (this.isOp('#')) {
      // highlight — probed: present in the CSG tree AND in the exported STL. It
      // is REAL GEOMETRY, and dropping it removed a feature: `difference() {
      // cube(20); #cylinder(...); }` is 80 facets in OpenSCAD and was 12 here,
      // an uncut block. The only thing we cannot do is draw it in a different
      // colour, so it passes through and the scene tree says it was not
      // highlighted.
      this.p++;
      return { t: 'call', name: '#', args: [], child: this.parseStatement(), disabled: false, line };
    }
    if (this.isOp('%')) {
      // background — probed: kept in the CSG tree, EXCLUDED from the render and
      // absent from the exported STL. Contributing no geometry therefore
      // matches OpenSCAD's geometry exactly. What is genuinely not implemented
      // is drawing it as a ghost, and that is what the refusal names.
      //
      // ⚠ THE BODY IS NO LONGER THROWN AWAY, AND THE REASON IS `!`. A root
      // modifier written INSIDE a `%` subtree still governs the whole model in
      // OpenSCAD — `find_root_tag` walks the instantiated tree and does not
      // care what its ancestors are tagged with. Measured 2026.08.07:
      // `%union(){ !cube(5); } sphere(20,$fn=16);` exports the **cube**; this
      // file discarded the `%` body at parse time, never saw the `!`, and
      // exported the **sphere** — a different object, silently. See
      // `case 'background'` in `exec` for what is done with the body and what
      // is deliberately NOT done with it.
      this.p++;
      return { t: 'background', body: this.parseStatement(), line };
    }

    if (t.kind === 'ident') {
      if (t.text === 'module') return this.parseModuleDef();
      if (t.text === 'function') return this.parseFunctionDef();
      if (t.text === 'include' || t.text === 'use') return this.parseIncludeLike();
      if (t.text === 'for') return this.parseFor();
      if (t.text === 'if') return this.parseIf();
      if (t.text === 'let') {
        this.p++;
        const binds = this.parseLetBindings();
        return { t: 'letstmt', binds, body: this.parseStatement(), line };
      }
      if (t.text === 'intersection_for') {
        this.p++;
        this.expectOp('(');
        const bindings: { name: string; value: Expr }[] = [];
        while (!this.isOp(')') && this.peek().kind !== 'eof') {
          const nameTok = this.next();
          if (nameTok.kind !== 'ident') {
            throw new ParseFailure(nameTok.line, `intersection_for needs a variable name, found ${describe(nameTok)}`);
          }
          this.expectOp('=');
          bindings.push({ name: nameTok.text, value: this.parseExpr() });
          if (!this.eatOp(',')) break;
        }
        this.expectOp(')');
        const body = this.parseStatement();
        return { t: 'intersection_for', bindings, body, line };
      }

      // assignment vs module call
      if (this.peek(1).kind === 'op' && this.peek(1).text === '=') {
        const name = this.next().text;
        this.p++; // '='
        const value = this.parseExpr();
        this.expectOp(';');
        return { t: 'assign', name, value, line };
      }
      if (this.peek(1).kind === 'op' && this.peek(1).text === '(') {
        const name = this.next().text;
        const args = this.parseArgs();
        const child = this.parseChildStatement();
        return { t: 'call', name, args, child, disabled: false, line };
      }
    }

    throw new ParseFailure(line, `cannot start a statement with ${describe(t)}`);
  }

  private parseChildStatement(): Stmt | null {
    if (this.isOp(';')) {
      this.p++;
      return null;
    }
    // 🔴 THE THIRD RECURSION, AND IT IS THE ONE I NEARLY SHIPPED AS FIXED (#163).
    // Guarding `Mesher.evalNode` and `Evaluator.execCall` left this one — the AST
    // BUILD, before any evaluation happens — and the raw `RangeError` simply moved
    // from depth 616 to depth ~5000. `parseStatement` ⇄ `parseChildStatement` is
    // the pair; it was found by counting repeated frames with
    // `Error.stackTraceLimit = 200`, because the default 10 frames showed only the
    // expression parser that happened to be on top when the stack ran out.
    //
    // ⚠ THE LESSON IS IN THE FIRST TWO FIXES, NOT THIS ONE: both were correct,
    // both raised the depth at which the crash happens, and neither removed it.
    // A guard on one of several recursions over the same input converts a
    // reproducible crash into a rarer one.
    if (this.nest >= MAX_NEST_DEPTH) {
      throw new ParseFailure(this.peek().line, `statements nest deeper than ${MAX_NEST_DEPTH} levels`);
    }
    this.nest++;
    try {
      return this.parseStatement();
    } finally {
      this.nest--;
    }
  }

  private parseModuleDef(): Stmt {
    const line = this.next().line; // 'module'
    const nameTok = this.next();
    if (nameTok.kind !== 'ident') {
      throw new ParseFailure(nameTok.line, `module needs a name, found ${describe(nameTok)}`);
    }
    const params = this.parseParams();
    const body = this.parseStatement();
    return { t: 'moduledef', name: nameTok.text, params, body, line };
  }

  private parseFunctionDef(): Stmt {
    const line = this.next().line; // 'function'
    const nameTok = this.next();
    if (nameTok.kind !== 'ident') {
      throw new ParseFailure(nameTok.line, `function needs a name, found ${describe(nameTok)}`);
    }
    const params = this.parseParams();
    this.expectOp('=');
    const body = this.parseExpr();
    this.expectOp(';');
    return { t: 'functiondef', name: nameTok.text, params, body, line };
  }

  /**
   * `let (a = 1, b = a + 1)` — the binding list only, shared by both forms.
   *
   * ⚠ AN UNNAMED BINDING IS NOT A VALUE, IT IS A MISTAKE, and OpenSCAD says so:
   * `let(3)` gives `WARNING: Assignment without variable name 3` and binds
   * nothing (probed). Parsing it as a positional argument and silently ignoring
   * it would leave the body evaluated against whatever the name meant OUTSIDE
   * the `let`, which is the shape of a dimension arriving from the wrong scope.
   */
  private parseLetBindings(): { name: string; value: Expr }[] {
    const binds: { name: string; value: Expr }[] = [];
    for (const a of this.parseArgs()) {
      if (a.name === null) {
        this.errors.push({
          line: a.value.line,
          message: 'let(...) needs "name = value"; this binding has no variable name and binds nothing',
        });
        continue;
      }
      binds.push({ name: a.name, value: a.value });
    }
    return binds;
  }

  /**
   * `include <path>` and `use <path>`, resolved through the host — or refused
   * BY PATH when there is no host, no such file, a cycle, or a budget.
   *
   * 🔴 THE TWO ARE DIFFERENT AND THE DIFFERENCE IS GEOMETRY. Probed against
   * OpenSCAD 2026.08.07 rather than remembered, on a library holding
   * `shared = 7; function libf(x) = x*3; module libm(s=2) cube(s); cube(1);`:
   *
   *   include → emits the library's own `cube(1)`, `shared` is 7, `libm`/`libf` usable
   *   use     → does NOT emit `cube(1)`, `shared` is undefined, `libm`/`libf` usable
   *
   * and a second probe settled the half that is easy to get wrong in the other
   * direction: a `use`d module still sees ITS OWN file's variables. A library
   * with `base = 11; module usesbase() cube(base);`, used from a file that sets
   * `base = 3`, draws an **11 mm** cube. So `use` is not "hoist the definitions
   * into my scope" — the definitions keep their own scope and only the NAMES
   * cross. That is why a `use` body is evaluated into its own environment (§
   * `execUse`) instead of being spliced like an `include`.
   */
  private parseIncludeLike(): Stmt {
    const kw = this.next(); // 'include' | 'use'
    const line = kw.line;

    const refuse = (name: string, detail: string): Stmt => ({ t: 'refused', name, detail, line });

    if (!this.isOp('<')) {
      // Not an import at all. `include` and `use` are not otherwise legal here,
      // so this is a syntax error and is reported as one.
      throw new ParseFailure(line, `${kw.text} must be followed by <path>, found ${describe(this.peek())}`);
    }
    const open = this.next(); // '<'
    while (this.peek().kind !== 'eof' && !this.isOp('>')) this.p++;
    const closed = this.isOp('>');
    const endPos = closed ? this.peek().pos : this.src.length;
    this.eatOp('>');
    // Taken from the SOURCE, not rebuilt from tokens. See `Token.pos`.
    const spec = this.src.slice(open.end, endPos).trim();
    const label = `${kw.text} <${spec}>`;

    if (!closed) {
      throw new ParseFailure(line, `${kw.text} <${spec} is missing its closing ">"`);
    }
    if (spec === '') {
      return refuse(`${kw.text} <>`, 'the path between the angle brackets is empty, so nothing was read');
    }

    if (this.defsOnly) {
      /* 🔴 FOLLOW IT — IN THE SAME MODE, THROUGH THE MEMO. TODO #165, 2026-09-17.
       * This used to refuse outright, which is why a name imported BY a cycled
       * file stayed undefined and `2bee_hive_panels_18mm_*_wcnc.scad` plus
       * `cnc_nest/nest_flat.scad` were dropped reporting `bb_floor_flat()` as a
       * construct this reader does not implement — a maximally misleading
       * message, since it named a function defined one file away.
       *
       * ⚠ THE REFUSAL WAS NOT WRONG WHEN IT WAS WRITTEN. Following these imports
       * without a memo re-reads the same files once per encounter, burns
       * `MAX_IMPORTS`, and raising the budget then produced 154 evaluation
       * errors — the fan-out was the disease. The memo is what changes the cost
       * from per-encounter to per-file; see `ImportCtx.defsMemo`. */
      const resolvedDefs = this.imports.host ? this.imports.host.read(spec, this.selfPath) : null;
      if (resolvedDefs && kw.text === 'use') {
        const memo = this.imports.defsMemo.get(resolvedDefs.path);
        if (memo) return { t: 'use', body: memo, path: resolvedDefs.path, line };
        if (this.imports.defsOpen.has(resolvedDefs.path)) {
          // Already being read defs-only further up this stack: the cycle's base
          // case. Empty rather than a refusal — the definitions ARE being
          // collected by the frame that opened it, and a refusal here would
          // report a loss that is not happening.
          return { t: 'use', body: [], path: resolvedDefs.path, line };
        }
        if (this.imports.count >= MAX_IMPORTS) {
          return refuse(label, `more than ${MAX_IMPORTS} files pulled into one parse; <${spec}> was not read`);
        }
        this.imports.count++;
        this.imports.defsOpen.add(resolvedDefs.path);
        const dErrors: ScadError[] = [];
        const dWarnings: ScadWarning[] = [];
        const dParser = new Parser(
          tokenize(resolvedDefs.source, dErrors, undefined, dWarnings),
          dErrors,
          resolvedDefs.source,
          this.imports,
          resolvedDefs.path,
          [...this.openPaths, resolvedDefs.path],
          dWarnings,
          true,
        );
        const dBody = dParser.parseProgram();
        this.imports.defsOpen.delete(resolvedDefs.path);
        /* ⚠ ERRORS FROM A DEFS-ONLY READ ARE DROPPED, AND THAT IS THE EXISTING
         * SEMANTIC, NOT A NEW SILENCE. `use` keeps a file's definitions and
         * discards its geometry and its top-level statements; an error raised by
         * material this read is throwing away would redden a design for a
         * problem in a part of a file it never uses. The reporting gap already
         * named in #165 — `execUse` never walks a `use` body for refusals — is
         * unchanged by this and is still open. */
        const dDefs = dBody.filter(
          (st) => st.t === 'functiondef' || st.t === 'moduledef' || st.t === 'assign',
        );
        this.imports.defsMemo.set(resolvedDefs.path, dDefs);
        return { t: 'use', body: dDefs, path: resolvedDefs.path, line, defsOnly: true };
      }

      // 🔴 A DEFINITIONS-ONLY RE-READ DOES NOT FOLLOW ITS OWN IMPORTS, and the
      // alternative was measured rather than assumed. Letting it descend (with
      // the flag propagated) recovered a few more names and multiplied the
      // re-reads: `2bee_hive/2bee_hive_panels_18mm.scad` then burned the
      // 128-file budget and refused `use <2bee_hive_floor_wcnc.scad>`, so
      // `bb_floor_flat()` was reported as an unknown module while being defined
      // one file away — and raising the budget to remove that symptom produced
      // **154 evaluation errors** on the same file, because the fan-out was the
      // disease and the budget was the only thing containing it.
      //
      // ⚠ SO THIS IS A DELIBERATE PARTIAL FIX, AND THE PART IT DOES NOT REACH IS
      // NAMED: a name that is imported BY a cycled file is still undefined.
      // `2bee_hive_panels_18mm_*_wcnc.scad` and `cnc_nest/nest_flat.scad` remain
      // dropped for exactly that reason. Shipping the fan-out to fix them would
      // trade a legible refusal for a page of plausible errors.
      return refuse(
        label,
        `this file is being re-read for DEFINITIONS ONLY because it is part of an import cycle, so <${spec}> ` +
          'was not followed. Names it would have provided are undefined in this re-read — a smaller and more ' +
          'legible loss than the cycle, and stated here rather than left to be discovered.',
      );
    }

    const host = this.imports.host;
    if (!host) {
      return refuse(
        label,
        `no file source is available to this parse, so <${spec}> was NOT read. Every module, function ` +
          'and variable that file defines is undefined below — a name from it will be reported as an ' +
          'unknown module, which is this line\'s fault and not a typo in your source.',
      );
    }
    if (this.openPaths.length > MAX_IMPORT_DEPTH) {
      return refuse(label, `imports nested deeper than ${MAX_IMPORT_DEPTH}; <${spec}> was not read`);
    }
    /* ⚠ THE BUDGET IS CHARGED AFTER RESOLUTION, NOT BEFORE. It used to be tested
     * here, where the resolved path is not yet known, so it could only count
     * ENCOUNTERS — and an encounter of a file already pulled in costs nothing.
     * See `ImportCtx.charged`. */

    let resolved: { path: string; source: string } | null;
    try {
      resolved = host.read(spec, this.selfPath);
    } catch (e) {
      return refuse(label, `the file source threw while resolving <${spec}>: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resolved) {
      return refuse(
        label,
        `<${spec}> could not be resolved from ${this.selfPath === '' ? 'this source' : this.selfPath} and was NOT read. ` +
          'Nothing was substituted for it: an unresolved import is never treated as an empty file, because an ' +
          'empty file would turn every module it defines into an "unknown module" and blame your source.',
      );
    }
    /* Charge the budget ONCE per distinct file. See `ImportCtx.charged` for the
     * measurement that produced this (146 reads, 33 files, budget 128). */
    if (!this.imports.charged.has(resolved.path)) {
      if (this.imports.charged.size >= MAX_IMPORTS) {
        return refuse(label, `more than ${MAX_IMPORTS} files pulled into one parse; <${spec}> was not read`);
      }
      this.imports.charged.add(resolved.path);
      this.imports.count = this.imports.charged.size;
    }

    if (this.openPaths.includes(resolved.path)) {
      // 🔴 `include` STILL REFUSES, AND `use` NO LONGER DOES. Corrected
      // 2026-09-09, and the cost of the old behaviour was measurable: it took
      // out THE HIVE PANELS.
      //
      // `hardware/cad/` has a real, intentional cycle —
      // `2bee_hive/inwall_panel_cut.scad` uses the v3 pod's enclosure, whose
      // params file uses `inwall_panel_cut.scad` back for the two functions that
      // say where the pod sits (`brood_pod_l_yc()` / `brood_pod_l_zbot()`). That
      // is not a mistake in cad's tree: OpenSCAD parses each file's definitions
      // once and a circular `use` resolves, because `use` imports NAMES and does
      // not splice or execute anything.
      //
      // Refusing it wholesale left those two functions undefined, so every file
      // downstream reported *"not a function this subset knows"* and was dropped
      // from the catalogue. MEASURED 2026-09-09 on the shop build: **12 designs
      // in `2bee_hive` alone**, including `2bee_hive_super_panel_wcnc.scad`,
      // `2bee_hive_brood_panel_wcnc.scad`, both `panels_18mm_*_wcnc` and the
      // `cnc_nest` files — ***the sheet-cut panels are the most product-shaped
      // thing this company has, and none of them reached the Designs tab.***
      // ⚠ And the failure was maximally misleading: the message named a
      // FUNCTION, so a reader goes looking for a missing definition that is
      // right there in the file the message names.
      //
      // What happens instead: the file is re-read with `defsOnly`, which refuses
      // its own imports — terminating the recursion — and only its `function`
      // and `module` definitions are kept. Its top-level assignments and any
      // geometry are dropped, which is exactly what `use` already does with a
      // non-cyclic file, so this is not a new semantic; it is the existing one
      // reaching a case it used to abandon.
      if (kw.text === 'include') {
        return refuse(
          label,
          `circular import: ${[...this.openPaths, resolved.path].join(' -> ')}. \`include\` is TEXTUAL — splicing ` +
            'it again would duplicate the file into itself without end, so the second opening was refused. ' +
            '(A circular `use` is read for its definitions; `include` cannot be.)',
        );
      }
      const cycErrors: ScadError[] = [];
      const cycWarnings: ScadWarning[] = [];
      const cyc = new Parser(
        tokenize(resolved.source, cycErrors, undefined, cycWarnings),
        cycErrors,
        resolved.source,
        this.imports,
        resolved.path,
        [...this.openPaths, resolved.path],
        cycWarnings,
        true,
      );
      const cycBody = cyc.parseProgram();
      for (const e of cycErrors) this.errors.push({ line, message: `in ${resolved.path} line ${e.line}: ${e.message}` });
      for (const w of cycWarnings) this.warnings.push({ line, message: `in ${resolved.path} line ${w.line}: ${w.message}` });
      // ⚠ ONLY DEFINITIONS, AND A KNOWN REPORTING GAP RIDES WITH THAT.
      // `refused` nodes were briefly kept here so the re-read's own refusal
      // would be visible — and they are INERT, because `execUse` binds a `use`
      // body's scope and never executes its statements, so nothing in a `use`
      // body reaches `unsupported`. The line was removed rather than left
      // looking like it did something. ⇒ The consequence, stated because it is
      // the kind of silence this file exists to refuse: a name that only a
      // cycled file's OWN imports would have provided is missing, and this parse
      // reports no reason for it. Surfacing it means teaching `execUse` to walk
      // for refusals, which would newly redden every design whose `use`d files
      // refuse anything — a real change with a large blast radius, and not one
      // to make in the same commit as the cycle fix.
      /* 🔴 ASSIGNMENTS ARE KEPT — TODO #165, 2026-09-17. `inwall_panel_cut.scad`
       * assigns `inwall_cut_pilots_default` at file level and uses it as a
       * DEFAULT PARAMETER of a module it defines; dropping the assignment left
       * the default undefined and cost two designs.
       * ⚠ THE FIRST ATTEMPT KEPT THEM AND REPORTED THEIR FAILURES, which broke
       * `tests/scad-circular-use.test.ts`: a cycled file's own `x = b_zbot()` is
       * evaluated in a re-read where `b_zbot` does not exist yet, so a function
       * that IS defined became an unsupported construct — the exact failure the
       * circular-`use` fix was written to remove. `defsOnly` marks the body so
       * `bindScope` binds them QUIETLY instead. */
      const defs = cycBody.filter(
        (st) => st.t === 'functiondef' || st.t === 'moduledef' || st.t === 'assign',
      );
      return { t: 'use', body: defs, path: resolved.path, line, defsOnly: true };
    }

    const subErrors: ScadError[] = [];
    const subWarnings: ScadWarning[] = [];
    const sub = new Parser(
      tokenize(resolved.source, subErrors, undefined, subWarnings),
      subErrors,
      resolved.source,
      this.imports,
      resolved.path,
      [...this.openPaths, resolved.path],
      subWarnings,
    );
    const body = sub.parseProgram();
    // A syntax error inside an imported file points at THIS line, because that
    // is the line the reader can see; the imported file and its own line number
    // are in the message. A line number that indexes a different file is worse
    // than no line number.
    for (const e of subErrors) {
      this.errors.push({ line, message: `in ${resolved.path} line ${e.line}: ${e.message}` });
    }
    // Same rule for the imported file's LEXER warnings — an overflowing literal
    // inside a library is exactly the case nobody would find by reading the
    // source they opened.
    for (const w of subWarnings) {
      this.warnings.push({ line, message: `in ${resolved.path} line ${w.line}: ${w.message}` });
    }
    return kw.text === 'include'
      ? { t: 'inline', body, path: resolved.path, line }
      : { t: 'use', body, path: resolved.path, line };
  }

  private parseFor(): Stmt {
    const line = this.next().line; // 'for'
    this.expectOp('(');
    const bindings: { name: string; value: Expr }[] = [];
    while (!this.isOp(')') && this.peek().kind !== 'eof') {
      const nameTok = this.next();
      if (nameTok.kind !== 'ident') {
        throw new ParseFailure(nameTok.line, `for needs a variable name, found ${describe(nameTok)}`);
      }
      this.expectOp('=');
      bindings.push({ name: nameTok.text, value: this.parseExpr() });
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')');
    const body = this.parseStatement();
    return { t: 'for', bindings, body, line };
  }

  private parseIf(): Stmt {
    const line = this.next().line; // 'if'
    this.expectOp('(');
    const cond = this.parseExpr();
    this.expectOp(')');
    const then = this.parseStatement();
    let els: Stmt | null = null;
    if (this.isIdent('else')) {
      this.p++;
      els = this.parseStatement();
    }
    return { t: 'if', cond, then, else: els, line };
  }

  private parseParams(): Param[] {
    this.expectOp('(');
    const params: Param[] = [];
    while (!this.isOp(')') && this.peek().kind !== 'eof') {
      const nameTok = this.next();
      if (nameTok.kind !== 'ident') {
        throw new ParseFailure(nameTok.line, `parameter name expected, found ${describe(nameTok)}`);
      }
      let def: Expr | null = null;
      if (this.eatOp('=')) def = this.parseExpr();
      params.push({ name: nameTok.text, def });
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')');
    return params;
  }

  private parseArgs(): Arg[] {
    this.expectOp('(');
    const args: Arg[] = [];
    while (!this.isOp(')') && this.peek().kind !== 'eof') {
      if (
        this.peek().kind === 'ident' &&
        this.peek(1).kind === 'op' &&
        this.peek(1).text === '=' &&
        !(this.peek(2).kind === 'op' && this.peek(2).text === '=')
      ) {
        const name = this.next().text;
        this.p++; // '='
        args.push({ name, value: this.parseExpr() });
      } else {
        args.push({ name: null, value: this.parseExpr() });
      }
      if (!this.eatOp(',')) break;
    }
    this.expectOp(')');
    return args;
  }

  private skipParens(): void {
    if (!this.isOp('(')) return;
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      if (this.isOp('(')) depth++;
      if (this.isOp(')')) {
        depth--;
        this.p++;
        if (depth === 0) return;
        continue;
      }
      this.p++;
    }
  }

  // --- expressions, lowest precedence first -------------------------------

  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const c = this.parseOr();
    if (this.isOp('?')) {
      const line = this.next().line;
      const a = this.parseTernary();
      this.expectOp(':');
      const b = this.parseTernary();
      return { t: 'ternary', c, a, b, line };
    }
    return c;
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.isOp('||')) {
      const line = this.next().line;
      l = { t: 'binary', op: '||', l, r: this.parseAnd(), line };
    }
    return l;
  }
  private parseAnd(): Expr {
    let l = this.parseEquality();
    while (this.isOp('&&')) {
      const line = this.next().line;
      l = { t: 'binary', op: '&&', l, r: this.parseEquality(), line };
    }
    return l;
  }
  private parseEquality(): Expr {
    let l = this.parseCompare();
    while (this.isOp('==') || this.isOp('!=')) {
      const op = this.next();
      l = { t: 'binary', op: op.text, l, r: this.parseCompare(), line: op.line };
    }
    return l;
  }
  private parseCompare(): Expr {
    let l = this.parseAdd();
    while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
      const op = this.next();
      l = { t: 'binary', op: op.text, l, r: this.parseAdd(), line: op.line };
    }
    return l;
  }
  private parseAdd(): Expr {
    let l = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next();
      l = { t: 'binary', op: op.text, l, r: this.parseMul(), line: op.line };
    }
    return l;
  }
  private parseMul(): Expr {
    let l = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next();
      l = { t: 'binary', op: op.text, l, r: this.parseUnary(), line: op.line };
    }
    return l;
  }
  private parseUnary(): Expr {
    if (this.isOp('-') || this.isOp('+') || this.isOp('!')) {
      const op = this.next();
      return { t: 'unary', op: op.text, e: this.parseUnary(), line: op.line };
    }
    return this.parsePower();
  }

  /** `^`, right-associative and binding TIGHTER than unary minus.
   *  Both properties measured against OpenSCAD 2026.08.07, not assumed:
   *  `-2^2` → −4 (so the minus applies to the power, not to the base) and
   *  `2^3^2` → 512 (so it groups to the right). The right operand goes through
   *  `parseUnary`, which is what makes `2^-1` → 0.5 parse at all. */
  private parsePower(): Expr {
    const l = this.parsePostfix();
    if (this.isOp('^')) {
      const op = this.next();
      return { t: 'binary', op: '^', l, r: this.parseUnary(), line: op.line };
    }
    return l;
  }
  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('[')) {
        const line = this.next().line;
        const i = this.parseExpr();
        this.expectOp(']');
        e = { t: 'index', e, i, line };
        continue;
      }
      if (this.isOp('.') && this.peek(1).kind === 'ident') {
        const line = this.next().line;
        const member = this.next().text;
        const idx = { x: 0, y: 1, z: 2 }[member];
        if (idx === undefined) {
          e = {
            t: 'refused',
            name: `.${member}`,
            detail: 'only .x, .y and .z are implemented as vector members',
            line,
          };
          continue;
        }
        e = { t: 'index', e, i: { t: 'num', v: idx, line }, line };
        continue;
      }
      return e;
    }
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const line = t.line;

    /* `each` reaching HERE is `each` outside ELEMENT position — `x = each ys`.
     * Invalid OpenSCAD, and the point of catching it is the DIAGNOSTIC: parsed
     * as an ordinary identifier it became a variable named `each` with `[…]`
     * read as an index, and the reader blamed a comma.
     *
     * 🔴 IT RETURNS A `refused` NODE AND NEVER AN `each` NODE, and that is the
     * whole reason this branch and {@link parseElement} are not one function.
     * `each` binds LOOSELY — measured against OpenSCAD 2026.08.07:
     * `[each [1,2] + [3,4]]` is `[4, 6]`, i.e. `each ([1,2] + [3,4])`. Only
     * `parseElement` is entitled to consume a whole `parseExpr()` that way. A
     * primary that produced a real `each` node here would have to pick a
     * precedence for a position where the construct is meaningless, and would
     * make {@link parseElement} redundant — which it briefly did, silently
     * disarming the negative control for the very defect this fixes. */
    if (this.isIdent('each')) {
      this.p++;
      this.parseExpr(); // consume the operand so parsing continues cleanly
      return {
        t: 'refused',
        name: 'each outside a vector or list comprehension',
        detail: '`each` splices into a list; it has no meaning as a plain value',
        line,
      };
    }

    if (t.kind === 'num') {
      this.p++;
      return { t: 'num', v: t.num, line };
    }
    if (t.kind === 'str') {
      this.p++;
      return { t: 'str', v: t.text, line };
    }
    if (this.isOp('(')) {
      this.p++;
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    if (this.isOp('[')) return this.parseBracket();
    if (t.kind === 'ident') {
      if (t.text === 'true' || t.text === 'false') {
        this.p++;
        return { t: 'bool', v: t.text === 'true', line };
      }
      if (t.text === 'undef') {
        this.p++;
        return { t: 'undef', line };
      }
      if (t.text === 'let') {
        this.p++;
        const binds = this.parseLetBindings();
        // The body binds looser than `?:` on purpose: `let(a=1) a ? b : c` is
        // `let(a=1) (a ? b : c)` in OpenSCAD, not `(let(a=1) a) ? b : c`.
        return { t: 'let', binds, body: this.parseTernary(), line };
      }
      /* `assert(...) expr`, in the same family as `let(...) expr` above and
       * binding the same way. Recognised ONLY when a `(` follows, so a variable
       * or module named `assert` is untouched; the trailing expression is
       * optional because `f(assert(c))` is legal and yields undef. */
      if (t.text === 'assert' && this.peek(1).kind === 'op' && this.peek(1).text === '(') {
        this.p++;
        const args = this.parseArgs();
        const next = this.peek(0);
        const ends =
          next.kind === 'eof' ||
          (next.kind === 'op' && (next.text === ')' || next.text === ']' || next.text === ',' || next.text === ';'));
        return { t: 'assertexpr', args, body: ends ? null : this.parseTernary(), line };
      }
      if (t.text === 'function') {
        this.p++;
        const params = this.parseParams();
        const body = this.parseExpr();
        return { t: 'fndef', params, body, line };
      }
      if (t.text === 'each') {
        this.p++;
        this.skipParens();
        return {
          t: 'refused',
          name: 'each(...) in an expression',
          detail: 'not implemented; the expression evaluates to undef',
          line,
        };
      }
      if (this.peek(1).kind === 'op' && this.peek(1).text === '(') {
        const name = this.next().text;
        const args = this.parseArgs();
        return { t: 'call', name, args, line };
      }
      this.p++;
      return { t: 'var', name: t.text, line };
    }

    throw new ParseFailure(line, `expected a value, found ${describe(t)}`);
  }

  private parseBracket(): Expr {
    const line = this.next().line; // '['
    if (this.isOp(']')) {
      this.p++;
      return { t: 'vec', items: [], line };
    }
    // A list comprehension: `[for (…) if (…) expr]`, `[let (…) expr]`, etc.
    // Distinguished from a plain vector by a clause keyword followed by `(`.
    if (this.isLCompStart()) return this.parseListComp(line);
    // 🔴 A LEADING `each` ALSO SETTLES THE SHAPE. `[each a : b]` is not a range,
    // so range detection below is skipped rather than reached with a spliced
    // first element. This branch used to REFUSE `each` outright, and refused it
    // in the ONE position almost nobody writes — see {@link parseElement}.
    if (this.isIdent('each')) {
      const items = [this.parseElement()];
      while (this.eatOp(',')) {
        if (this.isOp(']')) break; // trailing comma
        items.push(this.parseElement());
      }
      this.expectOp(']');
      return { t: 'vec', items, line };
    }

    const first = this.parseExpr();
    if (this.isOp(':')) {
      this.p++;
      const second = this.parseExpr();
      if (this.isOp(':')) {
        this.p++;
        const third = this.parseExpr();
        this.expectOp(']');
        return { t: 'range', start: first, step: second, end: third, line };
      }
      this.expectOp(']');
      return { t: 'range', start: first, step: null, end: second, line };
    }
    const items = [first];
    while (this.eatOp(',')) {
      if (this.isOp(']')) break; // trailing comma
      items.push(this.parseElement());
    }
    this.expectOp(']');
    return { t: 'vec', items, line };
  }

  /**
   * One ELEMENT of a vector literal or the body of a list comprehension —
   * `expr`, or `each expr` which splices.
   *
   * 🔴 THIS EXISTS BECAUSE THE OLD `each` GUARD ONLY FIRED IN THE FIRST
   * POSITION AFTER `[`. Every real use in `hardware/cad/` is
   * `[for (p = ps) each [p, p + 1]]` — where `isLCompStart()` has already
   * dispatched to {@link parseListComp}, whose body was a bare `parseExpr()`.
   * So `each` parsed as a VARIABLE, `[p, p + 1]` became an index on it, and the
   * reader reported `expected "]", found ","` — a syntax error blaming a comma
   * in a file that is correct OpenSCAD, followed by `variable v is not defined`
   * blaming a downstream name for our missing operator. Two invented causes,
   * both pointing away from the real one. A construct this reader cannot handle
   * is NAMED; it does not get reported as the author's typo.
   */
  private parseElement(): Expr {
    /* 🔴 A GENERATOR IN ANY POSITION — `[0, for (t = ts) t[3]/2]`. OpenSCAD lets
     * every element of a vector be a comprehension; this reader only accepted
     * one as the WHOLE vector, so the `for` after a comma parsed as a call and
     * failed with `expected "]", found "t"`. One such line in
     * 2bee_sensor_pod_v3/sensor_pod_v3_enclosure_3d.scad:138, pulled in through
     * inwall_panel_cut.scad, made SIX cut files (hive brood/super/fan-box/18 mm
     * panels, feeder box panel) unreadable — gate CAD1H, 2026-10-14. The element
     * is the comprehension spliced in: `each [for (…) …]`, which the evaluator
     * already handles. */
    if (this.isLCompStart()) {
      const line = this.peek().line;
      return { t: 'each', value: this.parseGenerator(line), line };
    }
    if (!this.isIdent('each')) return this.parseExpr();
    const line = this.next().line; // 'each'
    return { t: 'each', value: this.parseExpr(), line };
  }

  /** Is the current token a list-comprehension clause keyword followed by `(`? */
  private isLCompStart(): boolean {
    return (
      (this.isIdent('for') || this.isIdent('let') || this.isIdent('if')) &&
      this.peek(1).kind === 'op' &&
      this.peek(1).text === '('
    );
  }

  /**
   * Parse a list comprehension from inside `[...]`. The opening `[` has
   * already been consumed; this method consumes up to and including `]`.
   *
   * Grammar (matching OpenSCAD):
   *   listcomp ::= clause+ body [ 'else' body ] ']'
   *   clause   ::= 'for' '(' bindings ')'
   *              | 'let' '(' bindings ')'
   *              | 'if'  '(' expr ')'
   */
  private parseListComp(line: number): Expr {
    const gen = this.parseGenerator(line);
    if (this.isOp(',')) {
      /* More elements follow: `[for (…) x, 5]`. The first becomes a spliced
       * element like any other generator. */
      const items: Expr[] = [{ t: 'each', value: gen, line }];
      while (this.eatOp(',')) {
        if (this.isOp(']')) break; // trailing comma
        items.push(this.parseElement());
      }
      this.expectOp(']');
      return { t: 'vec', items, line };
    }
    this.expectOp(']');
    return gen;
  }

  /** Clauses + body (+ else) of one comprehension, WITHOUT the closing `]`. */
  private parseGenerator(line: number): Expr {
    const clauses: LCompClause[] = [];
    while (true) {
      if (this.isIdent('for') && this.peek(1).kind === 'op' && this.peek(1).text === '(') {
        this.p++; // 'for'
        this.expectOp('(');
        const bindings: { name: string; value: Expr }[] = [];
        while (!this.isOp(')') && this.peek().kind !== 'eof') {
          const nameTok = this.next();
          if (nameTok.kind !== 'ident') {
            throw new ParseFailure(nameTok.line, `for needs a variable name, found ${describe(nameTok)}`);
          }
          this.expectOp('=');
          bindings.push({ name: nameTok.text, value: this.parseExpr() });
          if (!this.eatOp(',')) break;
        }
        this.expectOp(')');
        clauses.push({ t: 'for', bindings });
      } else if (this.isIdent('let') && this.peek(1).kind === 'op' && this.peek(1).text === '(') {
        this.p++; // 'let'
        clauses.push({ t: 'let', binds: this.parseLetBindings() });
      } else if (this.isIdent('if') && this.peek(1).kind === 'op' && this.peek(1).text === '(') {
        this.p++; // 'if'
        this.expectOp('(');
        const cond = this.parseExpr();
        this.expectOp(')');
        clauses.push({ t: 'if', cond });
      } else {
        break;
      }
    }
    const body = this.parseElement();
    let elseBody: Expr | null = null;
    if (this.isIdent('else')) {
      this.p++;
      // Element position, exactly like `body` — `if (c) x else each ys` splices.
      elseBody = this.parseElement();
    }
    return { t: 'listcomp', clauses, body, elseBody, line };
  }
}

function describe(t: Token): string {
  if (t.kind === 'eof') return 'end of file';
  if (t.kind === 'str') return `string ${JSON.stringify(t.text)}`;
  return JSON.stringify(t.text);
}

/** A statement, and which file it was written in. See `Origin`. */
interface Placed {
  s: Stmt;
  origin: Origin | null;
}

/**
 * Nest an import inside whatever import is already open.
 *
 * The PATH is the innermost file — that is where the code actually is. The LINE
 * stays the outermost import's, because that is the only line the reader has on
 * screen; A includes B at line 3, B includes C at line 7, and a refusal in C is
 * reported at line 3 of A with C's own line in the text.
 */
function nestOrigin(current: Origin | null, path: string, line: number): Origin {
  return { path, importLine: current ? current.importLine : line };
}

/**
 * Splice every resolved `include` into the statement list, recursively, keeping
 * each statement's file with it.
 *
 * 🔴 IT HAS TO HAPPEN BEFORE HOISTING AND BEFORE THE LAST-ASSIGNMENT-WINS PASS,
 * because `include` is TEXTUAL: an included `w = 50;` has to compete for the
 * name `w` with the including file's own assignments, exactly as if the text had
 * been pasted. Running the included body as its own scope would give it its own
 * `w` and leave the including file reading the other one.
 */
function flattenIncludes(body: Stmt[], origin: Origin | null): Placed[] {
  const out: Placed[] = [];
  for (const s of body) {
    if (s.t === 'inline') out.push(...flattenIncludes(s.body, nestOrigin(origin, s.path, s.line)));
    else out.push({ s, origin });
  }
  return out;
}

/** `*` disables a subtree. Keep the statement so the line is still accounted for. */
function disableStatement(inner: Stmt, line: number): Stmt {
  if (inner.t === 'call') return { ...inner, disabled: true, line };
  return { t: 'empty', line };
}

/**
 * Is there a `!` anywhere in this program?
 *
 * Syntactic and total: it looks inside module bodies, `include`d and `use`d
 * files, and `%` subtrees, because all three can hold the `!` that governs the
 * model. It answers "is there one to find", never "which one wins" — the second
 * question is OpenSCAD's depth-first order and is answered by evaluation.
 *
 * ⚠ A statement carrying a child MUST be listed here. A missed arm would make
 * this quietly answer `false` and switch off the `%` search on exactly the file
 * that needed it, which is the failure mode this whole change exists to remove.
 * So the switch is EXHAUSTIVE against `Stmt` and the `never` at the end makes a
 * new arm a compile error rather than a silent `false` — a comment asking the
 * next author to remember is the weaker half of that pair, not a substitute for
 * it. (`functiondef`'s body is an `Expr`, which cannot contain a statement.)
 */
function containsRootModifier(program: Stmt[]): boolean {
  const seenBody = new Set<Stmt>();
  const walk = (s: Stmt | null): boolean => {
    if (!s || seenBody.has(s)) return false;
    seenBody.add(s);
    switch (s.t) {
      case 'root':
        return true;
      case 'background':
      case 'moduledef':
      case 'for':
      case 'intersection_for':
      case 'letstmt':
        return walk(s.body);
      case 'if':
        return walk(s.then) || walk(s.else);
      case 'call':
        return walk(s.child);
      case 'block':
      case 'inline':
      case 'use':
        return s.body.some((c) => walk(c));
      case 'assign':
      case 'functiondef':
      case 'refused':
      case 'empty':
        return false;
      default: {
        const unreachable: never = s;
        return Boolean(unreachable) && false;
      }
    }
  };
  return program.some((s) => walk(s));
}

// ---------------------------------------------------------------------------
// Values and environment
// ---------------------------------------------------------------------------

interface RangeValue {
  __range: true;
  start: number;
  step: number;
  end: number;
}

/** A function literal value: captures the environment at the point of definition. */
interface FnValue {
  __fn: true;
  params: Param[];
  body: Expr;
  env: Env;
}

/**
 * 🔴 THE VALUE A REFUSED OR FAILED EXPRESSION EVALUATES TO, AND THE REASON IT
 * IS NOT `undefined`.
 *
 * `undef` is a value the OpenSCAD language HAS. A user can write it, it flows
 * through arithmetic, and at a primitive it is indistinguishable from *"this
 * argument was not supplied"* — which is exactly what `named.get('size') ??
 * pos[0] ?? 1` is asking. So while a refused expression returned `undefined`, a
 * refusal did not REMOVE a node from the tree, it RESIZED it: `cube(sq(3))`
 * with `sq` refused came out as `cube(1)`, one cubic millimetre where the
 * source says twenty-seven, audited `closed`, reported `trust: trusted`.
 * Measured in five separate forms (`docs/openscad-feature-inventory.md` §3).
 *
 * ⚠ THE FIX IS NOT AT THE FIVE CALL SITES. Patching `cube` and leaving
 * `sphere` is how this comes back, and the next parameter anyone adds arrives
 * with the defect already in it. A distinct sentinel cannot be absorbed by
 * `??`, cannot be read as a number by `num()`, cannot be read as a vector by
 * `vec3()`, and is refused wholesale by `guardArgs()` before any primitive or
 * transform gets to apply a default to it — so a NEW default is forced to deal
 * with it whether or not its author thought about this.
 *
 * It is deliberately a symbol: no arithmetic, no coercion, no equality with
 * anything a user can write, and it cannot be produced by the language.
 */
export const FAILED: unique symbol = Symbol('2bee.cad: refused or failed expression');

type Value = number | boolean | string | undefined | Value[] | RangeValue | FnValue | typeof FAILED;

/** True if this value IS, or CONTAINS anywhere, a refused/failed expression. */
function carriesFailed(v: Value): boolean {
  if (v === FAILED) return true;
  if (Array.isArray(v)) return v.some(carriesFailed);
  return false;
}

/**
 * Where a definition came from, when it did not come from the file the user has
 * open. `null` for the open file itself.
 *
 * 🔴 IT IS CARRIED ON THE DEFINITION, NOT ON A PARSE-TIME REWRITE OF THE TREE.
 * A module defined in an imported file is CALLED long after the import finished,
 * so a diagnostic raised inside it has no other way to know which file it is in.
 * Without this, `hull()` refused on line 44 of an imported library would be
 * reported as line 44 of the source on screen — a real line, in the wrong file,
 * which is the most convincing kind of wrong.
 */
interface Origin {
  path: string;
  /** The line of the `include`/`use` statement, in the file the user can see. */
  importLine: number;
}

interface ModuleDef {
  name: string;
  params: Param[];
  body: Stmt;
  env: Env;
  origin: Origin | null;
}

interface FunctionDef {
  name: string;
  params: Param[];
  body: Expr;
  env: Env;
  origin: Origin | null;
}

/** The child block of a user-module call, and the scope it must be evaluated in. */
interface ChildCtx {
  /** The TOP-LEVEL children, in order. `$children` is this array's length. */
  body: Stmt[];
  /** 🔴 The CALLER's environment. A child is written at the call site and means what it means there. */
  env: Env;
  /** Which file the child block was WRITTEN in, so its diagnostics land there. */
  origin: Origin | null;
}

interface Env {
  vars: Map<string, Value>;
  modules: Map<string, ModuleDef>;
  functions: Map<string, FunctionDef>;
  /** Where non-`$` names, module names and function names are looked up. */
  lexical: Env | null;
  /** Where `$fn` and friends are looked up. OpenSCAD scopes `$` names dynamically. */
  dynamic: Env | null;
  /**
   * What `children()` means here. `undefined` = inherit from the lexical parent;
   * `null` = explicitly none.
   *
   * 🔴 EVERY MODULE FRAME SETS IT, INCLUDING TO `null`. If a module with no
   * children left it `undefined`, the lookup would walk out through `lexical`
   * into the scope the module was DEFINED in and could find the children of a
   * completely unrelated call — instantiating geometry the source never asked
   * for at that point.
   */
  childCtx?: ChildCtx | null;
}

function newEnv(lexical: Env | null, dynamic: Env | null): Env {
  return { vars: new Map(), modules: new Map(), functions: new Map(), lexical, dynamic };
}

function lookup(env: Env, name: string): Value {
  if (name.startsWith('$')) {
    for (let e: Env | null = env; e; e = e.dynamic) {
      if (e.vars.has(name)) return e.vars.get(name);
    }
    return undefined;
  }
  for (let e: Env | null = env; e; e = e.lexical) {
    if (e.vars.has(name)) return e.vars.get(name);
  }
  return undefined;
}

function lookupModule(env: Env, name: string): ModuleDef | null {
  for (let e: Env | null = env; e; e = e.lexical) {
    const m = e.modules.get(name);
    if (m) return m;
  }
  return null;
}

function lookupFunction(env: Env, name: string): FunctionDef | null {
  for (let e: Env | null = env; e; e = e.lexical) {
    const f = e.functions.get(name);
    if (f) return f;
  }
  return null;
}

/**
 * Is `name` BOUND here — as opposed to bound to `undef`?
 *
 * 🔴 `lookup()` CANNOT ANSWER THIS AND THAT IS THE WHOLE POINT. It returns
 * `undefined` for "no such name" and for "a name whose value is undef", and
 * `is_undef()` has to say `true` for both while the ERROR path must fire only
 * for the first. Deciding it by walking the same two chains `lookup` walks is
 * what keeps the two answers about one name from being computed two ways.
 */
function hasBinding(env: Env, name: string): boolean {
  if (name.startsWith('$')) {
    for (let e: Env | null = env; e; e = e.dynamic) if (e.vars.has(name)) return true;
    return false;
  }
  for (let e: Env | null = env; e; e = e.lexical) if (e.vars.has(name)) return true;
  return false;
}

/** The nearest enclosing module frame's children. See `Env.childCtx`. */
function findChildCtx(env: Env): ChildCtx | null {
  for (let e: Env | null = env; e; e = e.lexical) {
    if (e.childCtx !== undefined) return e.childCtx;
  }
  return null;
}

class Halt extends Error {}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

class Evaluator {
  unsupported: Unsupported[] = [];
  errors: ScadError[] = [];
  warnings: ScadWarning[] = [];
  console: ScadEchoLine[] = [];
  private nodes = 0;
  private iterations = 0;
  private depth = 0;
  /** Built-in statement nesting. See `MAX_NEST_DEPTH`. */
  private nest = 0;
  private fnDepth = 0;
  private seenRefusal = new Set<string>();
  private rootEnv: Env | null = null;
  /** The file host, for resolving `import()` calls. Set by `parseScad`. */
  host: ScadFileHost | undefined;
  /** The path of the root file being parsed. Set by `parseScad`. */
  path: string | undefined;
  /** `ScadOptions.maxFragments`. Set by `parseScad`. */
  maxFragments: number | undefined;

  /**
   * Which imported file the code being executed came from, innermost last.
   * Empty ⇒ the source the user has open. See `Origin`.
   */
  private origins: (Origin | null)[] = [];

  /** The innermost frame governs. `null` on top means "the file the user has open". */
  private get origin(): Origin | null {
    return this.origins.length ? this.origins[this.origins.length - 1] : null;
  }

  /**
   * Rewrite a diagnostic raised inside an imported file so it points at a line
   * the reader can actually see, and says where it really is.
   */
  private place(name: string, line: number): { name: string; line: number } {
    const o = this.origin;
    if (!o) return { name, line };
    return { name: `${o.path}:${line} ${name}`, line: o.importLine };
  }

  private refuse(name: string, line: number, detail: string): void {
    const at = this.place(name, line);
    // One entry per name+line. A `for` that calls `hull()` 400 times is one
    // refusal, not four hundred; a list nobody can read is a list nobody reads.
    const key = `${at.name}@${at.line}`;
    if (this.seenRefusal.has(key)) return;
    this.seenRefusal.add(key);
    this.unsupported.push({ name: at.name, line: at.line, detail });
  }

  /**
   * 🔴 REPORT, THEN SAY THAT NOTHING AFTER THIS WAS CHECKED.
   *
   * Every `Halt` stops evaluation of the whole program — the top-level catch
   * builds a scene from what ran and reports the errors collected so far. Only
   * the MAX_NODES message said so; the loop cap, the call-depth cap and both
   * assert paths reported their own problem and stopped silently.
   *
   * ⇒ A reader then sees ONE error, fixes it, and has no way to know the rest of
   * the file was never evaluated. That is the same shape as this lane's drop
   * list: *"what we could not assess"* reading as *"what was assessed and found
   * fine"* — and a single error is exactly the case where it is most convincing.
   * Swept 2026-09-06 on ceo's owed-check note for `web/src/cad/` runtime.
   */
  private haltAfter(line: number, message: string): never {
    this.fail(line, `${message} ⚠ EVALUATION STOPPED HERE — nothing after this line was checked, so this may not be the only problem.`);
    throw new Halt();
  }

  private fail(line: number, message: string): void {
    const o = this.origin;
    if (o) {
      this.errors.push({ line: o.importLine, message: `in ${o.path} line ${line}: ${message}` });
      return;
    }
    this.errors.push({ line, message });
  }

  /** OpenSCAD said `WARNING:` here and so do we, in its wording where it has one. */
  private warn(line: number, message: string): void {
    const o = this.origin;
    if (o) {
      this.warnings.push({ line: o.importLine, message: `in ${o.path} line ${line}: ${message}` });
      return;
    }
    this.warnings.push({ line, message });
  }

  /**
   * The one place a refused/failed expression is stopped from being read as an
   * omitted argument. Every node builder calls it BEFORE applying any default,
   * so a parameter added later is covered without its author knowing this
   * exists. Returns true when the node must not be built.
   */
  private guardArgs(what: string, line: number, values: Iterable<Value>): boolean {
    for (const v of values) {
      if (!carriesFailed(v)) continue;
      this.refuse(
        what,
        line,
        'an argument here came from an expression that was REFUSED or FAILED. A refused expression is not an ' +
          'omitted argument, so no default was applied to it and nothing was drawn for this line. The reason ' +
          'is on its own line above.',
      );
      return true;
    }
    return false;
  }

  private countNode(line: number): void {
    this.nodes++;
    if (this.nodes > MAX_NODES) {
      this.fail(line, `stopped: more than ${MAX_NODES} scene nodes. Nothing after this line was evaluated.`);
      throw new Halt();
    }
  }

  /** The `!` subtree, once one has been seen. `null` means none; an EMPTY
   *  array still means one was seen and produced nothing, which is a model with
   *  no geometry — not a licence to fall back on the rest of the file. */
  private rootOnly: SceneNode[] | null = null;

  /**
   * True while the body of the `!` currently being built is executing.
   *
   * 🔴 IT IS NOT THE SAME QUESTION AS `rootOnly !== null`, AND CONFLATING THEM
   * DELETED THE MODEL. A second `!` that is a SIBLING of the first is outside
   * the chosen root and OpenSCAD drops it; a second `!` NESTED INSIDE the first
   * is part of the chosen root and OpenSCAD keeps it, as an ordinary child.
   * `rootOnly` is still `null` while the outer body runs, so the nested one used
   * to be taken for the first root — it stole its own subtree out of the outer
   * body's sink and was then overwritten by that now-empty sink. Measured
   * 2026.08.07: `!union(){ !cube(5); translate([20,0,0]) sphere(3,$fn=16); }`
   * exports **both** children (264 facets); this file exported the sphere alone
   * and the cube vanished, with no diagnostic.
   */
  private inRootBody = false;

  /**
   * Does the program contain a `!` ANYWHERE — including inside a module body,
   * an `include`d file or a `%` subtree?
   *
   * The one thing this gates is the search described in `case 'background'`.
   * ⚠ It is a deliberate no-op switch: a file with no root modifier in it gets
   * byte-identical behaviour to before this was added, and every one of the 68
   * files in `hardware/cad/` is such a file (93 `%` sites, zero `!`). The
   * machinery only wakes up for a file that actually has a `!` to find.
   */
  private programHasRoot = false;

  run(program: Stmt[], root: Env): GroupNode {
    this.rootEnv = root;
    this.programHasRoot = containsRootModifier(program);
    const scene: GroupNode = { kind: 'group', label: 'program', children: [], line: 1 };
    /* 🔴 THE MAIN FILE GETS ITS OWN SCOPE, A CHILD OF THE BUILTINS — NOT THE
     * BUILTINS' SCOPE ITSELF (2026-10-14).
     *
     * This used to run the program directly in `root`, so the main file's
     * top-level assignments landed in the SAME env that `execUse` parents every
     * `use`d file to. `execUse`'s header promised "nothing of the caller's" and
     * the code delivered the opposite for any name the library did not define
     * itself: the caller's value leaked into the library's module bodies AND
     * into its default-argument expressions.
     *
     * ⚠ MEASURED against openscad 2026.08.07 — `lib.scad` defines
     * `module m(w = is_undef(W) ? 19 : W)` and `module inner() echo(W)`;
     * `main.scad` is `W = 18; use <lib.scad>; m(); inner();`:
     *
     *     openscad   default_w = 19 · inner_W = undef   (W is NOT visible)
     *     ours, old  default_w = 18 · inner_W = 18      (W leaked)
     *
     * and with `include <lib.scad>` instead both tools give 18, because include
     * is textual. OpenSCAD evaluates a default argument in the module's
     * DEFINING scope, and a `use`d file's defining scope is that file plus the
     * builtins. ⇒ The physical case: `hardware/cad/2bee_hive/
     * 2bee_hive_panels_4mm_wcnc.scad` sets `W = 18` and `use`s
     * `nuc_divider(w = is_undef(W) ? 19 : W)` — OpenSCAD cuts the 19 mm
     * divider, we drew an 18 mm one (oracle tree line 2, `cube(size=[19,4,28])`
     * vs ours `[18,4,28]`). A 1 mm wrong slot in a part that is never told so.
     * (The source's own comment, "nest the REAL divider (not the w=19
     * default)", describes the behaviour we HAD, not OpenSCAD's — that is cad's
     * to correct, and it is reported to them rather than honoured here.)
     *
     * `$`-variables are unaffected: they resolve through the DYNAMIC chain, so a
     * top-level `$fn = 32` still reaches a `use`d module called from here. */
    const programEnv = newEnv(root, root);
    try {
      this.execBlock(program, programEnv, scene);
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    if (this.rootOnly !== null) {
      scene.label = 'program (only the ! subtree)';
      scene.children = this.rootOnly;
    }
    return scene;
  }

  /**
   * A scope, evaluated the way OpenSCAD evaluates one: `include`s spliced in,
   * then definitions, then ALL of the assignments, then the geometry. The first
   * three are `bindScope`, which `use` needs on its own; see its header for why
   * the order is what it is.
   */
  private execBlock(body0: Stmt[], env: Env, out: SceneNode[] | GroupNode): void {
    const sink = Array.isArray(out) ? out : out.children;
    const body = flattenIncludes(body0, this.origin);
    this.bindScope(body, env);

    for (const p of body) {
      const t = p.s.t;
      if (t === 'assign' || t === 'moduledef' || t === 'functiondef' || t === 'use') continue;
      this.origins.push(p.origin);
      try {
        this.exec(p.s, env, sink);
      } finally {
        this.origins.pop();
      }
    }
  }

  /**
   * The DEFINITIONS and ASSIGNMENTS of a scope, without its geometry.
   *
   * Shared by `execBlock` and by `use`, and they need exactly the same thing for
   * different reasons: a scope binds its names before any of its geometry runs,
   * and a `use`d file binds its names and runs NONE of its geometry.
   *
   * 🔴 OPENSCAD IS NOT IMPERATIVE, AND THIS FILE USED TO BE. Assignments were
   * executed in the same top-to-bottom sweep as the geometry, so the FIRST
   * assignment to a name governed every line above the second one. OpenSCAD
   * does the opposite: the LAST assignment in a scope wins for the WHOLE scope,
   * including the lines textually above it. Measured: `w = 10; module part() {
   * cube([w,w,w]); } part(); w = 50;` is a **50 mm cube in OpenSCAD and was a
   * 10 mm cube here** — a dimension that appears nowhere in the file the user
   * is reading, with no diagnostic, in every scope (file, module body, `{}`
   * block, and the condition of an `if`).
   *
   * ⚠ IT IS NOT "EVALUATE THE LAST ONE" EITHER, AND THAT DISTINCTION IS THE
   * WHOLE IMPLEMENTATION. Measured against OpenSCAD 2026.08.07:
   *
   *     a = 1;  b = a + 1;  a = 5;   →  b == 6     (not 2)
   *     b = a + 1;  a = 1;  a = 5;   →  b == undef (not 6)
   *
   * So a re-assignment does not move the name to the bottom of the scope and it
   * does not stay put with its first value: **the name keeps the POSITION of
   * its first assignment and takes the EXPRESSION of its last.** Everything is
   * then evaluated once, in that order. Both probes above are regression tests.
   */
  private bindScope(body: Placed[], env: Env, quiet = false): void {
    /* 🔴 `use`s ARE BOUND FIRST, THEN THE SCOPE'S OWN DEFINITIONS — SO AN OWN
     * DEFINITION ALWAYS WINS, WHEREVER THE `use` SITS (2026-10-14).
     *
     * This was one sweep in source order, so a `use` written BELOW a module
     * definition overwrote it with the library's same-named one. Measured
     * against openscad 2026.08.07 (`l1.scad`/`l2.scad` each define `m()` and
     * `f()`):
     *
     *     module m() echo("own"); use <l1.scad>; m();   openscad "own"   ours "from l1"
     *     use <l1.scad>; use <l2.scad>; m();            openscad "from l2" (last use wins) — unchanged
     *
     * ⚠ The hive panels hit exactly this: `inwall_panel_cut.scad` defines its
     * modules and then, 400 lines down, `use`s the v3 pod, whose cycle back
     * into `inwall_panel_cut.scad` is a DEFS-ONLY re-read without its imports.
     * Source order let that crippled copy replace the real one. */
    const ordered = [
      ...body.filter((p) => p.s.t === 'use'),
      ...body.filter((p) => p.s.t === 'moduledef' || p.s.t === 'functiondef'),
    ];
    for (const p of ordered) {
      const s = p.s;
      if (s.t !== 'moduledef' && s.t !== 'functiondef' && s.t !== 'use') continue;
      this.origins.push(p.origin);
      try {
        if (s.t === 'moduledef') {
          env.modules.set(s.name, { name: s.name, params: s.params, body: s.body, env, origin: p.origin });
        } else if (s.t === 'functiondef') {
          // Hoisted exactly like a module, and for the same probed reason:
          // `cube(g(2)); function g(x) = x*4;` is an 8 mm cube in OpenSCAD.
          env.functions.set(s.name, { name: s.name, params: s.params, body: s.body, env, origin: p.origin });
        } else {
          // A `use` contributes NAMES to this scope and nothing else, and it has
          // to do so before the scope's assignments run — a `use`d function is
          // callable from a top-level assignment.
          this.execUse(s, env);
        }
      } finally {
        this.origins.pop();
      }
    }

    const slots: { name: string; value: Expr; line: number; origin: Origin | null }[] = [];
    const slotOf = new Map<string, number>();
    for (const p of body) {
      const s = p.s;
      if (s.t !== 'assign') continue;
      const at = slotOf.get(s.name);
      if (at === undefined) {
        slotOf.set(s.name, slots.length);
        slots.push({ name: s.name, value: s.value, line: s.line, origin: p.origin });
        continue;
      }
      // OpenSCAD's own wording, so the two tools' output can be diffed line for
      // line. It names BOTH lines because the surprise is which one won.
      this.origins.push(p.origin);
      try {
        this.warn(
          s.line,
          `"${s.name}" was assigned on line ${slots[at].line} but was overwritten on line ${s.line}. ` +
            'In OpenSCAD the last assignment in a scope governs the whole scope, including the lines above it.',
        );
      } finally {
        this.origins.pop();
      }
      slots[at] = { name: s.name, value: s.value, line: s.line, origin: p.origin };
    }
    for (const slot of slots) {
      this.origins.push(slot.origin);
      /* 🔴 `quiet` IS NOT "IGNORE ERRORS". It is only ever set for the top-level
       * assignments of a DEFINITIONS-ONLY re-read of a cycled file, which before
       * 2026-09-17 were not evaluated AT ALL — so nothing that was previously
       * reported becomes silent here. What changes is that the bindings now
       * exist; what does not change is the diagnostics.
       *
       * ⚠ `seenRefusal` IS SNAPSHOTTED TOO, AND THAT IS DEFENSIVE RATHER THAN A
       * PROVEN CONTROL — said plainly because the reverse would be a claim I
       * could not back. The worry was that truncating the arrays alone leaves the
       * dedupe key set poisoned, so a LATER genuine refusal of the same name and
       * line is swallowed. **I could not construct a case where it matters:** the
       * key is built from `this.origin`, and a quiet refusal inside the cycled
       * re-read and the outer parse's own refusal of the same source line get
       * DIFFERENT keys. Removing the snapshot changed no test and no measured
       * output. It is kept because restoring state you truncated is cheap and the
       * key's composition is not something this code should depend on — but the
       * next reader should know it guards a hazard nobody has demonstrated. */
      const mark = quiet
        ? { e: this.errors.length, u: this.unsupported.length, w: this.warnings.length, seen: new Set(this.seenRefusal) }
        : null;
      try {
        env.vars.set(slot.name, this.eval(slot.value, env));
      } finally {
        if (mark) {
          this.errors.length = mark.e;
          this.unsupported.length = mark.u;
          this.warnings.length = mark.w;
          this.seenRefusal = mark.seen;
        }
        this.origins.pop();
      }
    }
  }

  /**
   * `use <file>`: the file's MODULES and FUNCTIONS enter this scope; its
   * variables and its top-level geometry do not.
   *
   * 🔴 THE DEFINITIONS KEEP THEIR OWN SCOPE. Probed: a library with
   * `base = 11; module usesbase() cube(base);`, used from a file that sets
   * `base = 3`, draws an **11 mm** cube. So the file gets its own environment
   * (parented to the ROOT env, not to the importing scope — it must see `PI`
   * and `$preview` and nothing of the caller's), that environment is bound, and
   * only the two NAME MAPS are copied out.
   *
   * ⚠ Its geometry statements are never executed at all — not executed into a
   * discarded sink. Running them would raise this file's refusals and errors
   * against a model the user did not ask for, and would cost the time of a
   * whole second evaluation for output that is thrown away.
   */
  private execUse(s: Extract<Stmt, { t: 'use' }>, into: Env): void {
    const fileEnv = newEnv(this.rootEnv, this.rootEnv);
    fileEnv.childCtx = null;
    const origin = nestOrigin(this.origin, s.path, s.line);
    const placed = flattenIncludes(s.body, origin);
    this.origins.push(origin);
    try {
      this.bindScope(placed, fileEnv, s.defsOnly === true);
    } finally {
      this.origins.pop();
    }
    /* 🔴 ONLY THE FILE'S OWN DEFINITIONS ARE EXPORTED — `use` IS NOT TRANSITIVE
     * (2026-10-14). This copied EVERY name in `fileEnv`, including the ones the
     * file had itself imported with its own `use`. Measured against openscad
     * 2026.08.07 — `c.scad` defines `mc()`/`fc()`, `b.scad` is `use <c.scad>`
     * plus `module mb()`, `a.scad` is `use <b.scad>; mb(); mc(); echo(fc());`:
     *
     *     openscad   mb() runs; mc() "Ignoring unknown module"; fc() undef
     *     ours, old  all three resolved
     *
     * ⚠ IT WAS HIDING BEHIND THE ROOT-SCOPE LEAK FIXED IN `run()`, AND THE TWO
     * HAD TO MOVE TOGETHER. With the leak closed alone, three hive panels lost
     * their serial/QR recesses: `inwall_panel_cut.scad` `use`s the v3 pod, the
     * pod `use`s `inwall_panel_cut.scad` back (a cycle, re-read defs-only and
     * WITHOUT its imports), and the transitive copy then OVERWROTE the full
     * read's `serial_zone_front` with the defs-only one — whose
     * `serial_qr_provision()` had only ever resolved because the main file's
     * scope (holding a second transitive copy) was the root every library saw.
     * Two wrong scoping rules cancelling to a right answer, on those files. A
     * name defined by an `include`d file IS the file's own (include is
     * textual), which is why the own-set is taken from the flattened body. */
    const ownModules = new Set<string>();
    const ownFunctions = new Set<string>();
    for (const p of placed) {
      if (p.s.t === 'moduledef') ownModules.add(p.s.name);
      else if (p.s.t === 'functiondef') ownFunctions.add(p.s.name);
    }
    for (const [k, v] of fileEnv.modules) if (ownModules.has(k)) into.modules.set(k, v);
    for (const [k, v] of fileEnv.functions) if (ownFunctions.has(k)) into.functions.set(k, v);
  }

  /**
   * `let (a = 1, b = a + 1)` — one new scope, bindings applied IN ORDER.
   *
   * 🔴 SEQUENTIAL, NOT SIMULTANEOUS, AND IT WAS PROBED. `a = 1;
   * let(a = 5, b = a + 1) [a, b, 3]` is `[5, 6, 3]` in OpenSCAD, not `[5, 2, 3]`
   * — so `b` sees the `a` bound one binding earlier, not the `a` outside. Doing
   * it the other way would give a number that exists nowhere in the source.
   */
  private bindLet(binds: { name: string; value: Expr }[], env: Env): Env {
    const inner = newEnv(env, env);
    for (const b of binds) inner.vars.set(b.name, this.eval(b.value, inner));
    return inner;
  }

  private exec(s: Stmt, env: Env, sink: SceneNode[]): void {
    switch (s.t) {
      case 'empty':
      case 'moduledef':
      case 'functiondef':
      case 'use':
        // All three are handled by `bindScope`, which every scope runs first.
        return;
      case 'inline': {
        // An `include` reached here rather than through `flattenIncludes` —
        // i.e. it is the lone child of something, `translate(...) include <x>`.
        // No new scope: `include` is textual.
        this.origins.push(nestOrigin(this.origin, s.path, s.line));
        try {
          this.execBlock(s.body, env, sink);
        } finally {
          this.origins.pop();
        }
        return;
      }
      case 'letstmt': {
        const inner = this.bindLet(s.binds, env);
        const group: GroupNode = { kind: 'group', label: 'let', children: [], line: s.line };
        this.exec(s.body, inner, group.children);
        if (group.children.length) {
          this.countNode(s.line);
          sink.push(group);
        }
        return;
      }
      case 'refused':
        this.refuse(s.name, s.line, s.detail);
        return;
      case 'assign':
        // Reached only for an assignment that is NOT a member of a block —
        // `if (c) a = 1;` and nothing else. Every assignment inside a scope is
        // bound by `execBlock` before any geometry runs; see the note there.
        env.vars.set(s.name, this.eval(s.value, env));
        return;
      case 'block': {
        const inner = newEnv(env, env);
        const group: GroupNode = { kind: 'group', label: 'block', children: [], line: s.line };
        this.execBlock(s.body, inner, group);
        if (group.children.length) {
          this.countNode(s.line);
          sink.push(group);
        }
        return;
      }
      case 'if': {
        const c = this.eval(s.cond, env);
        // 🔴 A FAILED CONDITION MUST NOT SILENTLY PICK THE `else` BRANCH. That
        // is how `a = "a" < "b" ? 3 : 7; cube(a);` drew a 7 mm cube where
        // OpenSCAD draws a 3 mm one: the comparison errored, the error became a
        // falsy value, and the wrong branch was taken as though the user had
        // written it. Neither branch is the source's answer when the question
        // could not be asked.
        if (this.guardArgs('if (...)', s.line, [c])) return;
        const branch = truthy(c) ? s.then : s.else;
        if (branch) this.exec(branch, newEnv(env, env), sink);
        return;
      }
      case 'for':
        this.execFor(s, env, sink);
        return;
      case 'intersection_for': {
        // `intersection_for(i = [0:5]) { ... }` is equivalent to
        // `intersection() { for(i = [0:5]) { ... } }` in OpenSCAD (probed).
        // Evaluate the loop, collect all iteration children, and emit a
        // BooleanNode with op 'intersection'.
        this.execIntersectionFor(s, env, sink);
        return;
      }
      case 'root': {
        // Evaluated into its OWN sink, never into the caller's. That is what
        // strips the ancestors: nothing this subtree produces is attached to
        // the transform or boolean it was written inside, which is exactly what
        // OpenSCAD does (probed — `translate(...) !cube(5)` emits a bare cube).
        //
        // The two "second root" cases are NOT the same case; see `inRootBody`.
        if (this.rootOnly !== null) {
          // A sibling of, or a follower of, the root already chosen. OpenSCAD's
          // `find_root_tag` took the first one; this subtree is outside it and
          // is not in the tree at all.
          this.warn(s.line, 'More than one Root Modifier (!). The first one governs; this one is ignored.');
          return;
        }
        if (this.inRootBody) {
          // Nested INSIDE the root being built. OpenSCAD warns and renders the
          // outer subtree whole, so this one is an ordinary child of it: it
          // goes into the caller's sink, keeping every transform between them.
          this.warn(s.line, 'More than one Root Modifier (!). The first one governs; this one is ignored.');
          this.exec(s.body, env, sink);
          return;
        }
        const only: SceneNode[] = [];
        // 🔴 `%` ON THE NODE THAT BECOMES THE ROOT IS IGNORED BY OPENSCAD, and
        // this line is the whole of it. `GeometryEvaluator` skips a background
        // CHILD; nothing skips the background flag on the root node itself, so
        // `!%cube(5);` exports 12 facets of cube. Measured 2026.08.07 — this
        // file exported nothing. (`%!cube(5);` needs no special case: the `%`
        // wrapper evaluates its body, and `case 'root'` uses its own sink.)
        const body = s.body.t === 'background' ? s.body.body : s.body;
        this.inRootBody = true;
        try {
          this.exec(body, env, only);
        } finally {
          this.inRootBody = false;
        }
        this.rootOnly = only;
        return;
      }
      case 'background': {
        // The geometry answer is unchanged and is the measured one: OpenSCAD's
        // render and export leave a `%` subtree out, so contributing nothing
        // matches the exported solid exactly. The refusal names what IS missing
        // — the ghost in the preview.
        //
        // ⚠ WHAT IS NEW IS THE SEARCH, AND ITS LIMITS ARE DELIBERATE. A `!`
        // inside a `%` subtree still governs the whole model in OpenSCAD, and
        // it can be reachable only through a module call (`module m(){ !cube(5);
        // } %m();` exports the cube), so a syntactic scan of the body is not
        // enough — the body has to be EVALUATED to find it. It is therefore
        // evaluated into a throwaway sink, and:
        //
        //   · only when the program contains a `!` at all (`programHasRoot`),
        //     so a file without one is untouched — that is every real file we
        //     have;
        //   · with every diagnostic it raises ROLLED BACK, because none of that
        //     geometry is drawn either way and reporting it would change what
        //     93 existing `%` sites say the moment anyone adds a `!`;
        //   · with the node and iteration budgets rolled back too, so a search
        //     cannot push the real model over `MAX_NODES`;
        //   · and with a `Halt` swallowed, because a search that ran out of
        //     budget has failed to answer, which must not abort the model.
        //
        // 🔴 THE RESIDUAL, NAMED RATHER THAN LEFT TO BE DISCOVERED: if the
        // search halts on budget before reaching a `!` buried in the `%`
        // subtree, that `!` is not honoured and nothing says so. It cannot cut
        // a wrong part on any file we hold (no `!` exists in `hardware/cad/`),
        // but it is a gap, not an impossibility.
        const rootBefore = this.rootOnly;
        if (this.programHasRoot) {
          const errs = this.errors.length;
          const warns = this.warnings.length;
          const unsup = this.unsupported.length;
          const con = this.console.length;
          const seen = new Set(this.seenRefusal);
          const nodes = this.nodes;
          const iters = this.iterations;
          try {
            this.exec(s.body, env, []);
          } catch (e) {
            if (!(e instanceof Halt)) throw e;
          } finally {
            this.errors.length = errs;
            this.warnings.length = warns;
            this.unsupported.length = unsup;
            this.console.length = con;
            this.seenRefusal = seen;
            // The budgets are rolled back only when the search KEPT nothing. If
            // it found the root, those nodes are in the model that will be
            // drawn, and a cap they do not count against is not a cap.
            if (this.rootOnly === rootBefore) {
              this.nodes = nodes;
              this.iterations = iters;
            }
          }
        }
        // If the search is what produced the root, OpenSCAD draws that subtree
        // and NO ghost — the `%` ancestor is not in its tree either — so the
        // refusal would be describing something neither side shows.
        if (rootBefore !== null || this.rootOnly === null) {
          this.refuse(
            'modifier %',
            s.line,
            '% marks a subtree as BACKGROUND: OpenSCAD shows it as a ghost in the preview and leaves it out of ' +
              'the render and the export. Contributing nothing here matches the geometry OpenSCAD exports — what ' +
              'is not implemented is the ghost, so the picture is missing a reference shape OpenSCAD would show ' +
              'you.',
          );
        }
        return;
      }
      case 'call':
        this.execCall(s, env, sink);
        return;
    }
  }

  private execFor(s: Extract<Stmt, { t: 'for' }>, env: Env, sink: SceneNode[]): void {
    const group: GroupNode = { kind: 'group', label: 'for', children: [], line: s.line };
    const loop = (idx: number, bound: Env): void => {
      if (idx >= s.bindings.length) {
        this.exec(s.body, newEnv(bound, bound), group.children);
        return;
      }
      const b = s.bindings[idx];
      const v = this.eval(b.value, bound);
      // 🔴 A LOOP OVER A REFUSED EXPRESSION IS A REFUSAL, NOT A SECOND ERROR.
      // `for (h = [for (i = [0:3]) i*5])` — a list comprehension, still refused —
      // used to report the refusal AND then an error saying the `for` needed a
      // vector. The reason was already on its own line; the second diagnostic
      // only buries it, which is the rule `binary` already states for operands
      // and `if` already applies to its condition. Nothing is iterated either
      // way; only the wording changes.
      if (this.guardArgs(`for (${b.name} = ...)`, s.line, [v])) return;
      const items = iterableOf(v);
      if (items === null) {
        this.fail(s.line, `for (${b.name} = ...) needs a vector or a range, got ${typeName(v)}`);
        return;
      }
      for (const item of items) {
        this.iterations++;
        if (this.iterations > MAX_LOOP_ITERATIONS) {
          this.haltAfter(s.line, `stopped: more than ${MAX_LOOP_ITERATIONS} loop iterations.`);
        }
        const e = newEnv(bound, bound);
        e.vars.set(b.name, item);
        loop(idx + 1, e);
      }
    };
    loop(0, env);
    if (group.children.length) {
      this.countNode(s.line);
      sink.push(group);
    }
  }

  /**
   * `intersection_for(i = [0:5]) { ... }` — evaluates like `for` but wraps
   * the collected children in a `BooleanNode` with `op: 'intersection'` rather
   * than a `GroupNode`. The mesh kernel already handles `intersection` on
   * `BooleanNode`; this method only needs to assemble that node.
   */
  private execIntersectionFor(
    s: Extract<Stmt, { t: 'intersection_for' }>,
    env: Env,
    sink: SceneNode[],
  ): void {
    const children: SceneNode[] = [];
    const loop = (idx: number, bound: Env): void => {
      if (idx >= s.bindings.length) {
        this.exec(s.body, newEnv(bound, bound), children);
        return;
      }
      const b = s.bindings[idx];
      const v = this.eval(b.value, bound);
      if (this.guardArgs(`intersection_for (${b.name} = ...)`, s.line, [v])) return;
      const items = iterableOf(v);
      if (items === null) {
        this.fail(s.line, `intersection_for (${b.name} = ...) needs a vector or a range, got ${typeName(v)}`);
        return;
      }
      for (const item of items) {
        this.iterations++;
        if (this.iterations > MAX_LOOP_ITERATIONS) {
          this.haltAfter(s.line, `stopped: more than ${MAX_LOOP_ITERATIONS} loop iterations.`);
        }
        const e = newEnv(bound, bound);
        e.vars.set(b.name, item);
        loop(idx + 1, e);
      }
    };
    loop(0, env);
    if (children.length) {
      this.countNode(s.line);
      sink.push({ kind: 'boolean', op: 'intersection', children, line: s.line });
    }
  }

  private execCall(s: Extract<Stmt, { t: 'call' }>, env: Env, sink: SceneNode[]): void {
    if (s.disabled) return; // `*` modifier: exact, and nothing is emitted

    // 🔴 THE BUILT-IN NESTING GUARD (#163). `exec` ⇄ `execCall` is the recursion
    // that a chain of nested `translate()`s walks, and nothing counted it: a raw
    // `RangeError` came out of `parseScad`, which `CadTab` runs synchronously on
    // the main thread, so the tab went blank with no message. `haltAfter` is the
    // existing refusal path — an answer the reader can render.
    if (this.nest >= MAX_NEST_DEPTH) {
      this.haltAfter(s.line, `stopped: built-in statements nest deeper than ${MAX_NEST_DEPTH} levels.`);
    }
    this.nest++;
    try {
      this.execCallInner(s, env, sink);
    } finally {
      this.nest--;
    }
  }

  /** The body of {@link execCall}. Split out ONLY so the nesting guard has one
   *  exit to decrement on. */
  private execCallInner(s: Extract<Stmt, { t: 'call' }>, env: Env, sink: SceneNode[]): void {

    const name = s.name;

    // Before the user-module lookup: `children` is the language's, and a user
    // module of that name would silently take over child passing everywhere.
    if (name === 'children') {
      this.execChildren(s, env, sink);
      return;
    }

    // echo(): side-effecting statement — evaluates args, formats them, and
    // appends to the console output. Children are evaluated as pass-through.
    // OpenSCAD: `echo("Hello", x, y)` → `ECHO: "Hello", 5, [1, 2, 3]`
    if (name === 'echo') {
      const parts: string[] = [];
      for (const a of s.args) {
        const v = this.eval(a.value, env);
        parts.push(a.name ? `${a.name} = ${formatValue(v)}` : formatValue(v));
      }
      this.console.push({ line: s.line, message: parts.join(', ') });
      if (s.child) {
        if (s.child.t === 'block') this.execBlock(s.child.body, env, sink);
        else this.exec(s.child, env, sink);
      }
      return;
    }

    // assert(condition, "message"): if condition is false, halts with an error
    // (matching OpenSCAD, which emits NOTHING on assertion failure). If true,
    // evaluates children as pass-through.
    if (name === 'assert') {
      const pos = s.args.filter((a) => !a.name);
      if (pos.length === 0) {
        this.fail(s.line, 'assert() needs at least a condition argument');
        return;
      }
      const condition = this.eval(pos[0].value, env);
      if (this.guardArgs('assert()', s.line, [condition])) return;
      if (!truthy(condition)) {
        let msg = 'assertion failed';
        const msgArg = s.args.find((a) => a.name === 'message') ?? pos[1];
        if (msgArg) {
          const msgVal = this.eval(msgArg.value, env);
          if (typeof msgVal === 'string') msg = msgVal;
          else if (msgVal !== undefined) msg = formatValue(msgVal);
        }
        this.haltAfter(s.line, msg);
      }
      if (s.child) {
        if (s.child.t === 'block') this.execBlock(s.child.body, env, sink);
        else this.exec(s.child, env, sink);
      }
      return;
    }

    if (PRIMITIVES.has(name)) {
      const node = this.primitive(s, env);
      if (node) {
        this.countNode(s.line);
        sink.push(node);
      }
      if (s.child) {
        this.refuse(`${name}() { ... }`, s.line, 'a primitive takes no children; the child block was not evaluated');
      }
      return;
    }

    const passthrough = PASSTHROUGH_MODULES[name];
    if (TRANSFORMS.has(name) || BOOLEANS.has(name) || name === 'group' || passthrough !== undefined) {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        // 🔴 `$`-PREFIXED ARGUMENTS ARE DYNAMICALLY SCOPED AND REACH THE
        // CHILDREN. `translate([0,0,0], $fn=6) cylinder(...)` and
        // `union($fn=6) { cylinder(...) }` both give the cylinder `$fn = 6` in
        // OpenSCAD (probed). Until 2026-08-11 this environment was created
        // empty and the arguments were never inspected, so a hexagonal boss
        // came out round — silently, because a lower facet count is a
        // plausible-looking shape. The same argument on a USER module call was
        // already honoured, which is what made the gap so easy to miss.
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      let node: SceneNode | null;
      if (name === 'color') {
        const colour = this.colourOf(s, env);
        node = {
          kind: 'group',
          label: colourIsComplete(colour) || colour.rgb || colour.alpha !== null
            ? colourLabel(colour)
            : passthrough,
          children,
          line: s.line,
          colour,
        } satisfies GroupNode;
      } else if (passthrough !== undefined) {
        node = { kind: 'group', label: passthrough, children, line: s.line } satisfies GroupNode;
      } else {
        node = this.grouping(name, s, env, children);
      }
      if (node) {
        this.countNode(s.line);
        sink.push(node);
      }
      return;
    }

    // linear_extrude: evaluate children (which produce flats), then extrude.
    // The mesh kernel handles the actual extrusion.
    if (name === 'linear_extrude') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      // Parse height and center from args
      const toNum = (v: Value): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const pos = s.args.filter((a) => !a.name);
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));
      // 🔴 `twist` and `scale` CHANGE the geometry, and until 2026-08-27 they
      // were accepted and silently IGNORED — `linear_extrude(10, twist=90)`
      // emitted the straight extrusion, a plausible-looking wrong part that
      // posts clean. Refuse rather than approximate: the node is not emitted.
      // (`convexity`/`slices` are preview/tessellation hints with no geometric
      // effect without twist; `$fn` reaches the children through the dynamic
      // scope and is carried onto the node for the tree marker.)
      const twistExpr = named.get('twist') ?? pos[2]?.value;
      const twist = twistExpr ? (toNum(this.eval(twistExpr, env)) ?? 0) : 0;
      const scaleV = named.has('scale') ? this.eval(named.get('scale')!, env) : 1;
      const scaleIsIdentity =
        typeof scaleV === 'number' ? scaleV === 1 : Array.isArray(scaleV) && scaleV.length === 2 && scaleV[0] === 1 && scaleV[1] === 1;
      if (twist !== 0 || !scaleIsIdentity) {
        this.refuse(
          'linear_extrude(twist/scale)',
          s.line,
          'twist and scale sweep the outline as it rises; this kernel extrudes straight only. Emitting anyway ' +
            'would produce the untwisted part with no visible difference until it does not fit — refuse rather ' +
            'than approximate.',
        );
        return;
      }
      const heightExpr = named.get('height') ?? pos[0]?.value ?? { t: 'num' as const, v: 1, line: s.line };
      const centerExpr = named.get('center') ?? pos[1]?.value ?? { t: 'bool' as const, v: false, line: s.line };
      const height = toNum(this.eval(heightExpr, env)) ?? 1;
      const center = this.eval(centerExpr, env) === true;
      // `$fn` in effect at the call site (same semantics as rotate_extrude):
      // carried for the tree marker; the children already tessellate against
      // it through the dynamic scope above.
      const fnV = named.get('$fn') !== undefined ? this.eval(named.get('$fn')!, env) : lookup(env, '$fn');
      let fn: number | null = null;
      if (typeof fnV === 'number') {
        if (Number.isNaN(fnV)) fn = fnV;
        else if (fnV < 0) {
          this.warn(s.line, '$fn negative - setting to 0');
          fn = null;
        } else if (fnV > 0) fn = fnV;
      }
      fn = capFn(fn, this.maxFragments, null);
      const node: GroupNode = {
        kind: 'group',
        label: 'linear_extrude',
        children,
        line: s.line,
        extrude: { height, center, fn },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // offset: evaluate children (which produce flats), then offset the outlines.
    // The mesh kernel handles the actual offset.
    if (name === 'offset') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const pos = s.args.filter((a) => !a.name);
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));

      /* 🔴 `offset(delta = …)` WAS SILENTLY DISCARDED UNTIL 2026-09-21 — TODO #169.
       *
       * The old chain read `r = rVal ?? deltaVal ?? 0`, with `{v: 0}` standing in
       * for an absent `r`. **`0` is not nullish**, so `??` never reached `delta`,
       * and every `offset(delta = k)` in the corpus executed as `offset(r = 0)` —
       * NO OFFSET AT ALL, with no refusal, no warning, and a part that still
       * meshed, still posted and still drew a plausible picture. Two files in
       * `hardware/cad/` use it, both via the fillet idiom
       * `offset(r = k) offset(delta = -k)`, and one of them
       * (`2bee_hive/2bee_hive_joinery.scad:69`) is included by the whole hive
       * family.
       *
       * ⚠ EVERY RULE BELOW WAS PUT TO THE BINARY, NOT READ OFF THE MANUAL —
       * openscad 2026.08.07, 2026-09-21, each on `square([10,10])`, area
       * integrated from the exported SVG:
       *
       *   offset(r=2)                  12 pts  191.243  round
       *   offset(2)                    12 pts  191.243  1st positional IS r
       *   offset(delta=2)               4 pts  196.000  miter, exact
       *   offset(2,-1)                 12 pts  191.243  2nd positional IS delta,
       *                                                 and r WINS with a warning
       *   offset(r=2,delta=-1)         12 pts  191.243  `Ignoring "delta" argument
       *                                                  as "r" is defined too.`
       *   offset()                     12 pts  142.520  DEFAULT IS r = 1, ROUNDED
       *   offset(r="x") / (delta="x")  12 pts  142.520  non-numeric → that default
       *   offset(r=1/0) / (delta=1/0)     —    nothing  "not a 2D object"
       *   offset(delta=2,chamfer=true)  8 pts  193.255  a THIRD join
       *   offset(r=2,chamfer=true)     12 pts  191.243  chamfer ignored on r
       *
       * ⇒ The default is `r = 1` and NOT `0`: an argument-less `offset()` moves the
       * outline by a millimetre. Reading it as a no-op is the same error as
       * dropping `delta`. */
      const rExpr = named.get('r') ?? pos[0]?.value;
      const deltaExpr = named.get('delta') ?? pos[1]?.value;
      const chamferExpr = named.get('chamfer') ?? pos[2]?.value;
      const rV = rExpr === undefined ? undefined : this.eval(rExpr, env);
      const deltaV = deltaExpr === undefined ? undefined : this.eval(deltaExpr, env);
      const chamferV = chamferExpr === undefined ? undefined : this.eval(chamferExpr, env);
      if (this.guardArgs('offset()', s.line, [rV, deltaV, chamferV].filter((v) => v !== undefined) as Value[])) {
        return;
      }

      // OpenSCAD's own defaults, in OpenSCAD's own order: `r` first, `delta`
      // second, and `r = 1` ROUNDED when neither answers.
      let r = 1;
      let join: OffsetJoin = 'round';
      if (rExpr !== undefined && typeof rV === 'number') {
        if (deltaExpr !== undefined) {
          // OpenSCAD's wording, quoted from the binary rather than paraphrased.
          this.warn(s.line, 'Ignoring "delta" argument as "r" is defined too.');
        }
        if (!Number.isFinite(rV)) {
          this.refuse(
            'offset()',
            s.line,
            `r = ${Number.isNaN(rV) ? 'nan' : 'infinite'}. OpenSCAD produces NO 2D OBJECT here ` +
              '("Current top level object is not a 2D object"), so nothing is drawn for this node ' +
              'rather than an outline offset by a made-up amount.',
          );
          return;
        }
        r = rV;
      } else if (deltaExpr !== undefined && typeof deltaV === 'number') {
        if (!Number.isFinite(deltaV)) {
          this.refuse(
            'offset()',
            s.line,
            `delta = ${Number.isNaN(deltaV) ? 'nan' : 'infinite'}. OpenSCAD produces NO 2D OBJECT here, ` +
              'so nothing is drawn for this node.',
          );
          return;
        }
        if (chamferV === true) {
          /* 🔴 REFUSED, NOT APPROXIMATED. See `OffsetJoin` for the three measured
           * areas that make the mitre the WRONG answer to this call rather than a
           * near one. */
          this.refuse(
            'offset(chamfer = true)',
            s.line,
            "a chamfered offset cuts the corner on Clipper's square join, which is neither the " +
              'rounded nor the mitred corner this reader can draw. Measured on square([10,10]) at ' +
              'delta = 2, openscad 2026.08.07: chamfer 193.255 vs miter 196.000 vs round 191.243. ' +
              'Nothing is drawn for this node; drawing the mitre instead would be a part cut to the ' +
              'wrong outline with no warning.',
          );
          return;
        }
        r = deltaV;
        join = 'miter';
      }
      /* Anything else — no arguments at all, or an `r`/`delta` that is not a
       * number — keeps `r = 1, round`. That is not a tolerance: it is what the
       * binary does, measured above, and it is silent there too. */
      /* 🔴 THE TESSELLATION THE SOURCE ASKED FOR, NOT A CONSTANT — TODO #169.
       * `mesh.ts` called `offsetOutline(outline, r)` and that function's `fn`
       * parameter defaults to **16**, so every rounded offset used a fixed arc
       * density no matter what `$fn`/`$fa`/`$fs` said. ⚠ Built from the same
       * EVALUATED named map the primitives feed `facetsFrom`, so `offset(r=…,
       * $fn=…)` and `sphere(r=…, $fn=…)` cannot disagree about what `$fn` means. */
      const f = this.facetsFrom(
        new Map(s.args.filter((a) => a.name).map((a) => [a.name!, this.eval(a.value, env)])),
        env,
        s.line,
      );
      const node: GroupNode = {
        kind: 'group',
        label: 'offset',
        children,
        line: s.line,
        offset: { r, f, join },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // rotate_extrude: evaluate children (which produce flats), then revolve.
    // The mesh kernel handles the actual revolution.
    if (name === 'rotate_extrude') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const toNum = (v: Value): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const pos = s.args.filter((a) => !a.name);
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));
      const angleExpr = named.get('angle') ?? pos[0]?.value;
      let angle = angleExpr ? (toNum(this.eval(angleExpr, env)) ?? 360) : 360;
      // OpenSCAD resets an angle outside (-360, 360] to a full turn.
      if (angle <= -360 || angle > 360) angle = 360;
      // `start`: where the arc BEGINS, degrees. 🔴 OpenSCAD's default is 180 ONLY
      // WHEN NO `angle` IS GIVEN (a full turn, kept where it always was); with an
      // `angle` it is 0 — every partial arc starts at +X and sweeps CCW. This read
      // 180 for both, so every partial revolve landed 180° out (the hard-stop
      // groove in 2bee_autoframe_automation/enclosure.scad on the wrong side of the
      // lid), trusted, no diagnostic (bughunt 2026-11-15).
      const startExpr = named.get('start');
      const startDefault = angleExpr ? 0 : 180;
      let start = startExpr ? (toNum(this.eval(startExpr, env)) ?? startDefault) : startDefault;
      // A NEGATIVE angle sweeps clockwise: the same region as |angle| swept CCW
      // from `start + angle`. It used to fall through `angle > 0` in the mesher and
      // return the flat 2D profile, volume 0, no issue raised.
      if (angle < 0) {
        start += angle;
        angle = -angle;
      }
      // `$fn` at the call site or from the dynamic scope — the SAME semantics
      // as the `facets()` helper on the curved primitives (NaN is kept because
      // OpenSCAD reads it as "no answer" = 3; a negative warns and zeroes).
      // Dropped until 2026-08-27: the revolution ran at a fixed 48/turn and a
      // source that passed $fn got a different surface with no diagnostic.
      const fnV = named.get('$fn') !== undefined ? this.eval(named.get('$fn')!, env) : lookup(env, '$fn');
      let fn: number | null = null;
      if (typeof fnV === 'number') {
        if (Number.isNaN(fnV)) fn = fnV;
        else if (fnV < 0) {
          this.warn(s.line, '$fn negative - setting to 0');
          fn = null;
        } else if (fnV > 0) fn = fnV;
      }
      // `null` here is NOT the `$fa`/`$fs` path: `mesh.ts`'s `rotateExtrudeOutline` revolves a `null` at a fixed
      // 48 per turn (ROTATE_EXTRUDE_DEFAULT_FN), so the cap has to know that number to bound it.
      fn = capFn(fn, this.maxFragments, ROTATE_EXTRUDE_DEFAULT_FN);
      const node: GroupNode = {
        kind: 'group',
        label: 'rotate_extrude',
        children,
        line: s.line,
        rotateExtrude: { angle, fn, start },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // hull: evaluate children, then compute convex hull in the mesh kernel.
    if (name === 'hull') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const node: GroupNode = {
        kind: 'group',
        label: 'hull',
        children,
        line: s.line,
        hull: true,
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // minkowski: evaluate children, then compute Minkowski sum in the mesh kernel.
    if (name === 'minkowski') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const node: GroupNode = {
        kind: 'group',
        label: 'minkowski',
        children,
        line: s.line,
        minkowski: true,
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // projection: evaluate children, then project onto XY plane in the mesh kernel.
    if (name === 'projection') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));
      const cutVal = named.get('cut');
      const cut = cutVal ? (this.eval(cutVal, env) === true) : false;
      const node: GroupNode = {
        kind: 'group',
        label: 'projection',
        children,
        line: s.line,
        projection: { cut },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // multmatrix: apply an arbitrary 4×4 transform matrix to children.
    if (name === 'multmatrix') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const pos = s.args.filter((a) => !a.name);
      const mVal = pos[0]?.value;
      if (!mVal || mVal.t !== 'vec') {
        this.fail(s.line, 'multmatrix() needs a 4×4 matrix');
        return;
      }
      // Parse the 4×4 matrix: [[m00,m01,m02,tx],[m10,m11,m12,ty],[m20,m21,m22,tz],[0,0,0,1]]
      const rows = mVal.items;
      if (rows.length < 3) {
        this.fail(s.line, 'multmatrix() needs at least 3 rows');
        return;
      }
      const m: number[] = [];
      const t: [number, number, number] = [0, 0, 0];
      for (let r = 0; r < 3; r++) {
        const row = rows[r];
        if (!row || row.t !== 'vec' || row.items.length < 4) {
          this.fail(s.line, `multmatrix() row ${r} needs 4 values`);
          return;
        }
        for (let c = 0; c < 3; c++) {
          const v = this.eval(row.items[c], env);
          m.push(typeof v === 'number' ? v : 0);
        }
        const tv = this.eval(row.items[3], env);
        t[r] = typeof tv === 'number' ? tv : 0;
      }
      const node: GroupNode = {
        kind: 'group',
        label: 'multmatrix',
        children,
        line: s.line,
        multmatrix: { m: m as [number, number, number, number, number, number, number, number, number], t },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // resize: scale children to fit a target bounding-box size.
    // `resize([10, 20, 0]) cube([5,5,5])` → scale X to 10, Y to 20, Z unchanged.
    // `resize([10, 0, 0], auto=true) sphere(r=5)` → scale X to 10, Y and Z auto.
    if (name === 'resize') {
      const children: SceneNode[] = [];
      if (s.child) {
        const inner = newEnv(env, env);
        for (const a of s.args) {
          if (a.name && a.name.startsWith('$')) inner.vars.set(a.name, this.eval(a.value, env));
        }
        if (s.child.t === 'block') this.execBlock(s.child.body, inner, children);
        else this.exec(s.child, inner, children);
      }
      const pos = s.args.filter((a) => !a.name);
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));
      // `newsize=` named or first positional: the named form used to be ignored, the
      // size fell back to 0 ("unchanged") and the part kept its old size, trusted.
      const sizeExpr = named.get('newsize') ?? pos[0]?.value;
      const rawNewsize = sizeExpr ? this.eval(sizeExpr, env) : undefined;
      const newsize = this.vec3(rawNewsize ?? 0, 0);
      if (!newsize) {
        this.fail(s.line, 'resize() needs a vector of numbers for the new size');
        return;
      }
      // Parse `auto`: can be boolean or [bool, bool, bool].
      const autoRaw = named.has('auto') ? this.eval(named.get('auto')!, env) : false;
      let auto: [boolean, boolean, boolean];
      if (Array.isArray(autoRaw)) {
        auto = [
          autoRaw[0] === true || autoRaw[0] === 1,
          autoRaw[1] === true || autoRaw[1] === 1,
          autoRaw[2] === true || autoRaw[2] === 1,
        ];
      } else {
        const flag = autoRaw === true || autoRaw === 1;
        auto = [flag, flag, flag];
      }
      const node: GroupNode = {
        kind: 'group',
        label: 'resize',
        children,
        line: s.line,
        resize: { newsize, auto },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // import: load an external file (DXF, SVG, STL) and bring its geometry
    // into the scene. The file is resolved through the ScadFileHost.
    if (name === 'import') {
      const pos = s.args.filter((a) => !a.name);
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));
      const fileExpr = named.get('file') ?? pos[0]?.value;
      const fileVal = fileExpr ? this.eval(fileExpr, env) : '';
      const fileName = typeof fileVal === 'string' ? fileVal : String(fileVal ?? '');
      if (!fileName) {
        this.fail(s.line, 'import() needs a filename');
        return;
      }

      // Try to read the file through the host
      const host = this.host;
      if (!host) {
        this.refuse(`import("${fileName}")`, s.line,
          'no library folder is mounted — use File → Open to mount one first');
        return;
      }

      const resolved = host.read(fileName, this.path ?? '');
      if (!resolved) {
        this.refuse(`import("${fileName}")`, s.line,
          `file not found in the mounted library`);
        return;
      }

      // Create an import node — the mesh kernel will parse the file content
      // based on its extension and produce geometry.
      const node: GroupNode = {
        kind: 'group',
        label: `import(${fileName})`,
        children: [],
        line: s.line,
        importFile: { name: fileName, source: resolved.source, path: resolved.path },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    // surface: read a heightmap file and create a 3D surface.
    // Supports text-based heightmaps (rows of space-separated numbers).
    if (name === 'surface') {
      const pos = s.args.filter((a) => !a.name);
      const named = new Map(s.args.filter((a) => a.name).map((a) => [a.name!, a.value]));
      const fileExpr = named.get('file') ?? pos[0]?.value;
      const fileVal = fileExpr ? this.eval(fileExpr, env) : '';
      const fileName = typeof fileVal === 'string' ? fileVal : String(fileVal ?? '');
      const centerVal = named.get('center');
      const center = centerVal ? this.eval(centerVal, env) === true : false;
      const invertVal = named.get('invert');
      const invert = invertVal ? this.eval(invertVal, env) === true : false;

      if (!fileName) {
        this.fail(s.line, 'surface() needs a filename');
        return;
      }

      const host = this.host;
      if (!host) {
        this.refuse(`surface("${fileName}")`, s.line,
          'no library folder is mounted — use File → Open to mount one first');
        return;
      }

      const resolved = host.read(fileName, this.path ?? '');
      if (!resolved) {
        this.refuse(`surface("${fileName}")`, s.line,
          'file not found in the mounted library');
        return;
      }

      const node: GroupNode = {
        kind: 'group',
        label: `surface(${fileName})`,
        children: [],
        line: s.line,
        surfaceFile: { name: fileName, source: resolved.source, path: resolved.path, center, invert },
      };
      this.countNode(s.line);
      sink.push(node);
      return;
    }

    const user = lookupModule(env, name);
    if (user) {
      this.callUserModule(user, s, env, sink);
      return;
    }

    const known = KNOWN_REFUSED_MODULES[name];
    this.refuse(
      `${name}()`,
      s.line,
      known
        ? `${known}. Nothing was added to the scene for it, and its children were not evaluated.`
        : 'not a module this subset knows. If it is your own module, check the spelling and that it is defined in scope.',
    );
  }

  private callUserModule(
    def: ModuleDef,
    s: Extract<Stmt, { t: 'call' }>,
    callerEnv: Env,
    sink: SceneNode[],
  ): void {
    if (this.depth >= MAX_CALL_DEPTH) {
      this.haltAfter(s.line, `stopped: module calls nested deeper than ${MAX_CALL_DEPTH}. Recursive module?`);
    }
    // Lexical parent is where the module was DEFINED; dynamic parent is the
    // caller, so `$fn` set at the call site reaches inside, as in OpenSCAD.
    const env = newEnv(def.env, callerEnv);
    const positional = s.args.filter((a) => a.name === null);

    // 🔴 A POSITIONAL ARGUMENT OCCUPIES ITS SLOT WHETHER OR NOT A NAMED
    // ARGUMENT LATER OVERRIDES IT. The old loop advanced the positional cursor
    // only when a parameter was NOT satisfied by name, so a named argument did
    // not consume the slot it shadows and the positional slid down onto the
    // NEXT parameter: `module m(a=1,b=2,c=3){...} m(10, a=99)` bound
    // `a=99, b=10` here and binds `a=99, b=2` in OpenSCAD. A number written for
    // one parameter silently arriving at a different one is the shape of a wall
    // thickness that becomes a depth.
    for (let i = 0; i < def.params.length && i < positional.length; i++) {
      env.vars.set(def.params[i].name, this.eval(positional[i].value, callerEnv));
    }
    if (positional.length > def.params.length) {
      this.warn(
        s.line,
        `${def.name}() was given ${positional.length} positional arguments and takes ${def.params.length}; ` +
          'the surplus were ignored.',
      );
    }
    for (const a of s.args) {
      if (!a.name) continue;
      if (a.name.startsWith('$')) {
        env.vars.set(a.name, this.eval(a.value, callerEnv));
        continue;
      }
      if (!def.params.some((p) => p.name === a.name)) {
        this.refuse(
          `${def.name}(${a.name}=)`,
          s.line,
          `module ${def.name} has no parameter named ${a.name}; the argument was not applied`,
        );
        continue;
      }
      if (env.vars.has(a.name)) {
        this.warn(s.line, `argument "${a.name}" overrides positional argument in ${def.name}().`);
      }
      env.vars.set(a.name, this.eval(a.value, callerEnv));
    }
    // Defaults last, and evaluated in the environment where the module was
    // DEFINED — not in the half-filled call frame.
    //
    // 🔴 `module n(a, b = a*2)` used to see `a` here, because the frame already
    // held it. OpenSCAD does not: it evaluates a default where the module was
    // written, where `a` is not a variable at all, and reports
    // `Ignoring unknown variable "a"` (probed). `n(4)` therefore produced a
    // part 8 mm deep here and a 1 mm one there. Ours was the more USEFUL
    // behaviour and that is exactly why it had to go — a file written against
    // OpenSCAD carries OpenSCAD's meaning, not the nicer one.
    for (const p of def.params) {
      if (env.vars.has(p.name)) continue;
      env.vars.set(p.name, p.def ? this.eval(p.def, def.env) : undefined);
    }
    // 🔴 THE CHILD BLOCK, AND `$children`, SET ON EVERY FRAME — INCLUDING WHEN
    // THERE ARE NONE. `childCtx = null` is not the same as leaving it unset:
    // unset means "inherit from the lexical parent", and a module that inherited
    // would instantiate an ENCLOSING call's children, which is geometry the
    // source never asked for at that point. Probed: `pick() { a; b; c; }` sees
    // `$children == 3`; `none();` sees 0; a `for` handed as one child counts as
    // ONE child, not as its iterations.
    const childBody: Stmt[] = s.child === null ? [] : s.child.t === 'block' ? s.child.body : [s.child];
    env.childCtx = { body: childBody, env: callerEnv, origin: this.origin };
    env.vars.set('$children', childBody.length);

    const group: GroupNode = { kind: 'group', label: `module ${def.name}`, children: [], line: s.line };
    this.depth++;
    this.origins.push(def.origin);
    try {
      if (def.body.t === 'block') this.execBlock(def.body.body, env, group);
      else this.exec(def.body, env, group.children);
    } finally {
      this.origins.pop();
      this.depth--;
    }
    if (group.children.length) {
      this.countNode(s.line);
      sink.push(group);
    }
  }

  /**
   * `children()`, `children(i)`, `children([a:b])`, `children([i, j])`.
   *
   * Every behaviour below was probed against OpenSCAD 2026.08.07, because this
   * is the mechanism most library modules are built on and a subtle error here
   * drops or duplicates a whole part:
   *
   *   `module ring(n){for(i=[0:n-1]) translate([i*10,0,0]) children();} ring(3) cube(2);`
   *       → three cubes, each under its own transform
   *   `module pick(){children(1);} pick(){cube(1);sphere(2);cyl;}` → the SPHERE
   *   `module sub(){children([0:1]);}`                            → the first two
   *   `module oob(){children(5);} oob() cube(1);`
   *       → `WARNING: Children index (5) out of bounds (1 children)`, nothing emitted
   *   `children()` at the top level → nothing emitted, and `$children` is undef
   *
   * 🔴 THE CHILD IS EVALUATED IN THE CALLER'S ENVIRONMENT, NOT THE MODULE'S.
   * A child block is written at the call site and every name in it means what it
   * means there. Evaluating it inside the module's frame would let a module
   * parameter shadow a variable in the caller's own child expression and change
   * a dimension the caller can read on their own screen.
   */
  private execChildren(s: Extract<Stmt, { t: 'call' }>, env: Env, sink: SceneNode[]): void {
    const line = s.line;
    if (s.child) {
      this.refuse(
        'children() { ... }',
        line,
        'children() instantiates the children of the enclosing module call; it takes no child block of its own',
      );
    }

    const ctx = findChildCtx(env);
    if (!ctx) {
      // Matches OpenSCAD's emitted geometry exactly (nothing), so this is a
      // WARNING and not a refusal — nothing here is unimplemented.
      this.warn(
        line,
        'children() outside a module call has no children to instantiate; nothing was emitted, which is what OpenSCAD does.',
      );
      return;
    }

    const n = ctx.body.length;
    const pos = s.args.filter((a) => a.name === null).map((a) => this.eval(a.value, env));
    if (this.guardArgs('children()', line, pos)) return;
    for (const a of s.args) {
      if (a.name !== null) {
        this.refuse(
          `children(${a.name}=)`,
          line,
          'children() takes one positional index, an index vector or a range; it has no named parameters',
        );
        return;
      }
    }

    let picked: number[];
    if (pos.length === 0) {
      picked = ctx.body.map((_, i) => i);
    } else {
      const sel = pos[0];
      let want: Value[] | null;
      if (typeof sel === 'number') want = [sel];
      else want = iterableOf(sel);
      if (want === null) {
        this.fail(line, `children() needs a number, a vector of numbers or a range, got ${typeName(sel)}`);
        return;
      }
      picked = [];
      for (const v of want) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= n) {
          // OpenSCAD's own wording, so the two tools' output can be diffed.
          this.warn(line, `Children index (${typeof v === 'number' ? v : typeName(v)}) out of bounds (${n} children)`);
          continue;
        }
        picked.push(v);
      }
    }

    const group: GroupNode = { kind: 'group', label: `children of ${n}`, children: [], line };
    if (this.depth >= MAX_CALL_DEPTH) {
      this.haltAfter(line, `stopped: module calls nested deeper than ${MAX_CALL_DEPTH}. Recursive module?`);
    }
    this.depth++;
    // The child came from the caller's file, so any diagnostic inside it belongs
    // to the caller's origin — not to the module's. Captured at the call, because
    // by the time we are here the module's own origin is on top of the stack.
    this.origins.push(ctx.origin);
    try {
      for (const i of picked) this.exec(ctx.body[i], newEnv(ctx.env, ctx.env), group.children);
    } finally {
      this.origins.pop();
      this.depth--;
    }
    if (group.children.length) {
      this.countNode(line);
      sink.push(group);
    }
  }

  /**
   * `color(c, alpha)` — resolved here, carried on the node, painted by
   * `preview.tsx`.
   *
   * 🔴 EVERY BRANCH BELOW IS `builtin_color` IN `src/core/ColorNode.cc` OF
   * OPENSCAD 2026.08.07, READ RATHER THAN GUESSED, and three of them are
   * surprising enough that guessing would have got them wrong:
   *
   *   · A SHORT VECTOR PADS WITH 1, NOT WITH THE DEFAULT. `color([1,0,0])` is
   *     `[1,0,0,1]` — so a three-vector STATES an alpha of 1 and therefore
   *     completes the colour, which decides whether a nested `color()` can
   *     override it. `color([1,0])` really is `[1,0,1,1]`, magenta, not "red
   *     with two channels missing".
   *   · A NAME AND A HEX STRING GO THROUGH THE SAME DOOR, and an unresolvable
   *     one is a WARNING with the colour left UNSET — not an error, and never a
   *     dropped subtree.
   *   · `alpha` IS APPLIED AFTER `c` AND INDEPENDENTLY OF IT. `color(alpha=0.5)`
   *     leaves rgb unset, which is a colour that is *partial*, and a partial
   *     colour loses to an inner `color()` under the inheritance rule.
   *
   * ⚠ OUT-OF-RANGE VALUES ARE WARNED ABOUT AND KEPT, exactly as OpenSCAD keeps
   * them. Clamping here would silently disagree with the tool the file was
   * written for; `preview.tsx` clamps at the point of painting, where the clamp
   * is a property of the renderer and not of the model.
   */
  private colourOf(s: Extract<Stmt, { t: 'call' }>, env: Env): Colour {
    const line = s.line;
    const named = new Map<string, Expr>();
    const pos: Expr[] = [];
    for (const a of s.args) {
      if (a.name === null) {
        pos.push(a.value);
        continue;
      }
      if (a.name.startsWith('$')) continue; // dynamically scoped; handled by the caller
      if (a.name !== 'c' && a.name !== 'alpha') {
        this.refuse(
          `color(${a.name}=)`,
          line,
          'color() takes c and alpha and nothing else; the argument was not applied. The geometry under it ' +
            'is UNAFFECTED — a colour this tab cannot read is a lost appearance, never a lost part.',
        );
        continue;
      }
      named.set(a.name, a.value);
    }

    const cExpr = named.get('c') ?? pos[0];
    const aExpr = named.get('alpha') ?? pos[1];
    const c = cExpr === undefined ? undefined : this.eval(cExpr, env);
    const alphaV = aExpr === undefined ? undefined : this.eval(aExpr, env);

    if (this.guardArgs('color()', line, [c, alphaV])) return { ...NO_COLOUR };

    const out: Colour = { rgb: null, alpha: null };
    if (Array.isArray(c)) {
      const chan: number[] = [];
      for (let i = 0; i < 4; i++) {
        const v = i < c.length ? c[i] : 1;
        const n = typeof v === 'number' ? v : Number.NaN;
        if (!Number.isFinite(n)) {
          this.fail(line, `color() needs numbers in its vector, got ${typeName(c[i] as Value)}`);
          return { ...NO_COLOUR };
        }
        if (n > 1 || n < 0) {
          this.warn(line, `color() expects numbers between 0.0 and 1.0. Value of ${n.toFixed(1)} is out of range`);
        }
        chan.push(n);
      }
      out.rgb = [chan[0], chan[1], chan[2]];
      out.alpha = chan[3];
    } else if (typeof c === 'string') {
      const parsed = parseColourString(c);
      if (parsed) {
        out.rgb = parsed.rgb;
        out.alpha = parsed.alpha;
      } else if (c.toLowerCase().startsWith('xkcd:')) {
        this.refuse(
          'color("xkcd:…")',
          line,
          'the XKCD colour list (~950 names) is not carried in this bundle; only the 148 CSS Color 4 names ' +
            'and the # hex forms resolve. The geometry is UNAFFECTED and is drawn in the default colour.',
        );
      } else {
        this.warn(line, `Unable to parse color "${c}"`);
      }
    }

    if (typeof alphaV === 'number') {
      out.alpha = alphaV;
      if (alphaV < 0 || alphaV > 1) {
        this.warn(line, `color() expects alpha between 0.0 and 1.0. Value of ${alphaV.toFixed(1)} is out of range`);
      }
    }
    return out;
  }

  private grouping(
    name: string,
    s: Extract<Stmt, { t: 'call' }>,
    env: Env,
    children: SceneNode[],
  ): SceneNode | null {
    if (BOOLEANS.has(name)) {
      // 🔴 REPRESENTED, NOT COMPUTED. No subtraction happens anywhere below.
      return { kind: 'boolean', op: name as BooleanNode['op'], children, line: s.line };
    }
    if (name === 'group') {
      return { kind: 'group', label: 'group', children, line: s.line };
    }

    const first = s.args.find((a) => a.name === null) ?? s.args.find((a) => a.name === 'v' || a.name === 'a');
    if (!first) {
      this.fail(s.line, `${name}() needs a vector argument`);
      return null;
    }
    const raw = this.eval(first.value, env);
    if (this.guardArgs(`${name}()`, s.line, [raw])) return null;

    // 🔴 `translate(5)` IS A NO-OP IN OPENSCAD, NOT `[5,5,5]`. Probed:
    // `WARNING: Unable to convert translate(5) parameter to a vec3 or vec2 of
    // numbers`, and the emitted matrix is the IDENTITY with the children kept.
    // `vec3()` expands a scalar for all three transforms, which is right for
    // `scale(2)` (uniform in both) and right for `rotate(45)` (about Z in
    // both) and wrong for exactly this one: the part was displaced diagonally
    // on all three axes from a line the reference implementation ignores.
    if (name === 'translate' && typeof raw === 'number') {
      this.refuse(
        'translate(scalar)',
        s.line,
        'OpenSCAD cannot convert a scalar to a vec3 or vec2 and translates by NOTHING. The subtree is kept ' +
          'and is NOT translated, which is what OpenSCAD does — write translate([x, y, z]).',
      );
      return { kind: 'transform', op: 'translate', v: [0, 0, 0], children, line: s.line };
    }

    if (name === 'rotate') {
      // rotate(a) with a scalar is a rotation about Z. rotate(a, v) is an
      // axis-angle form, and refusing it is deliberate: storing it as an Euler
      // triple would be a DIFFERENT rotation, and a part rotated wrongly is
      // scrap that looks correct on screen.
      const axis = s.args.find((a) => a.name === 'v') ?? s.args.filter((a) => a.name === null)[1];
      if (axis) {
        this.refuse(
          'rotate(a, v)',
          s.line,
          'axis-angle rotation is not implemented; the subtree is kept but UNROTATED, so treat this tree as wrong until it is',
        );
        return { kind: 'transform', op: 'rotate', v: [0, 0, 0], children, line: s.line };
      }
      if (typeof raw === 'number') {
        return { kind: 'transform', op: 'rotate', v: [0, 0, raw], children, line: s.line };
      }
    }

    const v = this.vec3(raw, name === 'scale' ? 1 : 0);
    if (!v) {
      this.fail(s.line, `${name}() needs a number or a vector of numbers, got ${typeName(raw)}`);
      return null;
    }

    if (name === 'mirror') {
      /**
       * 🔴 A REFLECTION IS A MATRIX, SO IT REUSES `multmatrix` RATHER THAN
       * BECOMING A FOURTH `TransformNode['op']`. The mesher, the canon
       * serialiser and the oracle all already carry `multmatrix`; a new op
       * would have to be taught to each, and the one that forgot would be the
       * one that silently drew an unmirrored part.
       *
       * `mirror(v)` reflects in the plane THROUGH THE ORIGIN whose NORMAL is
       * `v` — the Householder reflection `I - 2·n·nᵀ / (n·n)`. Measured against
       * OpenSCAD 2026.08.07 by reading the `.csg` it emits:
       *
       *   mirror([1,0,0]) -> [[-1,0,0],[0,1,0],[0,0,1]]
       *   mirror([1,1,0]) -> [[ 0,-1,0],[-1,0,0],[0,0,1]]   (normalised)
       *   mirror([2,0,0]) -> same as [1,0,0]                (magnitude ignored)
       *   mirror([1,0])   -> same as [1,0,0]                (short vector padded)
       *   mirror([0,0,0]) -> IDENTITY, and NOT an error
       *
       * ⚠ THE ZERO VECTOR IS THE ONE WORTH STATING. `n·n` is 0, the formula
       * divides by it, and the honest-looking move is to refuse. OpenSCAD
       * returns the identity and draws the children unmirrored, so refusing
       * would make us STRICTER on a construct the binary accepts — this lane's
       * ledger calls that a capability gap, not safety. We match the binary and
       * the children survive.
       *
       * ⚠ A REFLECTION REVERSES ORIENTATION: it flips triangle winding, and a
       * mesh wound inside-out has no defensible inside. `mesh.ts` audits
       * winding per part, so a determinant-negative transform that broke it
       * would surface as `non-manifold`/`untrusted` rather than silently — that
       * audit is the check, and it is not re-implemented here.
       */
      const nn = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      const m: number[] =
        nn === 0
          ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
          : [
              1 - (2 * v[0] * v[0]) / nn, -(2 * v[0] * v[1]) / nn, -(2 * v[0] * v[2]) / nn,
              -(2 * v[1] * v[0]) / nn, 1 - (2 * v[1] * v[1]) / nn, -(2 * v[1] * v[2]) / nn,
              -(2 * v[2] * v[0]) / nn, -(2 * v[2] * v[1]) / nn, 1 - (2 * v[2] * v[2]) / nn,
            ];
      return {
        kind: 'group',
        label: 'mirror',
        children,
        line: s.line,
        multmatrix: {
          m: m as [number, number, number, number, number, number, number, number, number],
          t: [0, 0, 0],
        },
      };
    }

    return { kind: 'transform', op: name as TransformNode['op'], v, children, line: s.line };
  }

  private vec3(v: Value, fill: number): Vec3 | null {
    if (typeof v === 'number') return [v, v, v];
    if (Array.isArray(v)) {
      const nums = v.map((x) => (typeof x === 'number' ? x : NaN));
      if (nums.some((n) => Number.isNaN(n))) return null;
      return [nums[0] ?? fill, nums[1] ?? fill, nums[2] ?? fill];
    }
    return null;
  }

  /**
   * `cube`/`square` size coercion, OpenSCAD's way.
   *
   * 🔴 THE OLD RULE PADDED SHORT VECTORS AND TRUNCATED LONG ONES, SILENTLY.
   * `cube([10,20])` became a `[10, 20, 1]` blank and `cube([a,b,c,d])` quietly
   * dropped its fourth component. OpenSCAD refuses both and falls back to
   * `cube(1)` with a warning (probed, and the same for `square([10,20,30])`).
   * Note the DIRECTION: OpenSCAD's fallback is loud and tiny — a 1 mm cube is
   * obviously wrong on a screen — and ours was quiet and plausible, which is
   * the only one of the two that reaches material.
   */
  private sizeVector(who: string, want: 2 | 3, v: Value, line: number): Vec3 | null {
    if (typeof v === 'number') return [v, v, v];
    if (Array.isArray(v)) {
      if (v.length !== want) {
        this.refuse(
          `${who}(size = a ${v.length}-component vector)`,
          line,
          `${who}() takes a scalar or a vector of exactly ${want} numbers. OpenSCAD cannot convert this one ` +
            `and falls back to a 1 mm ${who}; so does this file. Nothing was padded and nothing was ` +
            'truncated — what is drawn is the fallback, not your dimensions.',
        );
        return [1, 1, 1];
      }
      const nums = v.map((x) => (typeof x === 'number' ? x : NaN));
      if (nums.some((n) => Number.isNaN(n))) {
        this.fail(
          line,
          `${who}() size has a non-numeric component. OpenSCAD substitutes 1 for it and warns; this file ` +
            'draws nothing rather than a dimension you did not write.',
        );
        return null;
      }
      return [nums[0], nums[1] ?? 1, nums[2] ?? 1];
    }
    this.fail(line, `${who}() size must be a number or a vector of ${want} numbers, got ${typeName(v)}`);
    return null;
  }


  /**
   * `$fn`/`$fa`/`$fs` in force at a call site, as OpenSCAD reads them.
   *
   * 🔴 LIFTED OUT OF `primitive()` 2026-09-18 FOR TODO #169. `offset()` never had
   * access to this — `mesh.ts` called `offsetOutline(outline, r)` and that
   * function's `fn` defaults to **16**, so every rounded offset tessellated at a
   * fixed density no matter what the source asked for. **Measured on
   * `2bee_hive/2bee_hive_panels_18mm_inner_wcnc.scad`, a file this company CUTS:**
   * at `r = 0.8`, `$fa = 12`, `$fs = 2`, OpenSCAD uses **5 fragments per circle**
   * (~2 per 90° corner) and we used the equivalent of **32** (8 per corner) —
   * **4× the points at every convex corner.**
   *
   * ⚠ AND THAT IS ALL IT IS — A CORRECTNESS FIX, NOT THE CAUSE OF THE 9%.
   * TODO #169 called this "the dominant cause" of `inner_wcnc`'s abandoned
   * `difference()` and **that claim was WRONG, retracted 2026-09-18 by counting
   * the geometry**: the file instantiates ~920 cylinders (766 of them at
   * `$fn = 24`), so its polygon count is FASTENER HOLES, not offset arcs. Honouring
   * the source here moves it 237,056 → 218,864 triangles (−7.7%), the
   * `difference()` at `:104` is **still refused** for exceeding `MAX_POLYS`, and the
   * oracle ledger is **unchanged** (`DIVERGES 7 · STRICTER 4`, same four files).
   * ⇒ ***The inference was "4× at every convex corner" → "therefore the dominant
   * term", made without ever asking what fraction of the geometry is offset arcs.***
   *
   * ⚠ THE BODY IS UNCHANGED — this is a move, not a rewrite. Every `$fn` subtlety
   * it documents (NaN kept as "no answer" = 3, `fn < 0` warned and zeroed, the
   * `$fa`/`$fs` clamp at 0.01) is the same code the primitives have always run,
   * and `primitive()` now delegates to it so the two cannot drift.
   *
   * @param named  already-EVALUATED named arguments at the call site.
   */
  private facetsFrom(named: Map<string, Value>, env: Env, line: number): Facets {
    const fnV = named.get('$fn') ?? lookup(env, '$fn');
    let fn: number | null = null;
    if (typeof fnV === 'number') {
      if (Number.isNaN(fnV)) {
        // Kept, not nulled: `isnan(fn)` is a "no answer" in OpenSCAD, and a
        // no-answer is 3 — it is NOT the `$fa`/`$fs` path.
        fn = fnV;
      } else if (fnV < 0) {
        // OpenSCAD's own wording, `CurveDiscretizer.cc:37`. It sets fn = 0,
        // which is our `null`: both then fall to `$fa`/`$fs`. The warning is
        // the part we were missing — the geometry already agreed.
        this.warn(line, '$fn negative - setting to 0');
        fn = null;
      } else if (fnV > 0) {
        fn = fnV;
      }
    }
    const special = (key: string, dflt: number): number => {
      const v = named.get(key) ?? lookup(env, key);
      if (typeof v !== 'number') return dflt;
      if (!Number.isFinite(v)) {
        // 🔴 DELIBERATELY NOT MATCHED, AND SAID OUT LOUD RATHER THAN LEFT
        // SILENT. OpenSCAD's `fa < F_MINIMUM` and `fs < F_MINIMUM` clamps are
        // both false for NaN, so the NaN reaches the arithmetic and the
        // result is `static_cast<int>(NaN)` — undefined behaviour. Measured
        // 2026-08-11 on openscad 2026.08.07: `circle(r=10,$fa=sqrt(-1))` is
        // **1** SVG point, `$fs=sqrt(-1)` is 30, and either of `$fa`/`$fs` at
        // `1e308*10` is 5. A one-point circle is not a shape to port. We use
        // the default and NAME the substitution, because a silent one is
        // indistinguishable from having read the source correctly.
        this.warn(
          line,
          `${key} is ${Number.isNaN(v) ? 'nan' : 'infinite'}; OpenSCAD's own answer here is undefined ` +
            `(its clamp does not fire and the count is cast from a non-finite double), so ${key} = ${dflt} ` +
            'was used instead. The tessellation is this tool\'s choice, not OpenSCAD\'s.',
        );
        return dflt;
      }
      if (v < 0.01) {
        // OpenSCAD's own wording, probed: `$fs too small - clamping to 0.010000`.
        this.warn(line, `${key} too small - clamping to 0.010000`);
        return 0.01;
      }
      return v;
    };
    return capFacets({ fn, fa: special('$fa', 12), fs: special('$fs', 2) }, this.maxFragments);
  }

  private primitive(s: Extract<Stmt, { t: 'call' }>, env: Env): PrimitiveNode | null {
    const line = s.line;
    const pos = s.args.filter((a) => a.name === null).map((a) => this.eval(a.value, env));
    const named = new Map<string, Value>();
    for (const a of s.args) {
      if (a.name) named.set(a.name, this.eval(a.value, env));
    }

    // Before ANY default is applied to ANY argument. See `FAILED`.
    if (this.guardArgs(`${s.name}()`, line, [...pos, ...named.values()])) return null;

    const accept = (allowed: string[]): void => {
      for (const key of named.keys()) {
        if (allowed.includes(key)) continue;
        this.refuse(
          `${s.name}(${key}=)`,
          line,
          `${s.name}() has no parameter named ${key} in this subset; the argument was NOT applied`,
        );
      }
    };

    /** OpenSCAD warns about surplus positional arguments; so do we now. */
    const arity = (n: number): void => {
      if (pos.length > n) {
        this.warn(line, `${s.name}() takes ${n} positional argument(s) and was given ${pos.length}; the surplus were ignored.`);
      }
    };

    /**
     * All three tessellation controls, resolved together.
     *
     * 🔴 `$fa`/`$fs` WERE NEITHER IMPLEMENTED NOR REFUSED, IN EITHER FORM.
     * As ARGUMENTS the refusal branch that named them sat *below* the
     * allowlist's `continue` and every call site passed `'$fa','$fs'` in its
     * allowed list, so it was unreachable from anywhere in the file — while
     * `mesh.ts` and `scad.test-notes.md` both asserted the refusal existed. As
     * ASSIGNMENTS (`$fa = 1;`, the form people actually write) they were stored
     * by `case 'assign'` and read by nothing. Measured cost:
     * `$fa=1;$fs=0.2;cylinder(h=10,r=5)` is **158 sides in OpenSCAD and was 16
     * here**, a bore ~0.1 mm undersize against what the source specifies; and
     * `$fa=1;$fs=0.1;sphere(5)` was **6.2 % light on volume, with no
     * diagnostic**. They are implemented now, in both forms, and the dead
     * branch is gone rather than left to read as a guard.
     *
     * 🔴 A NaN `$fn` USED TO BE MAPPED TO `null` HERE, AND THAT IS A REAL
     * DIVERGENCE, NOT A THEORETICAL ONE. The old line was
     * `typeof fnV === 'number' && fnV > 0 ? fnV : null`, and `NaN > 0` is
     * false — so a NaN `$fn` fell through to `$fa`/`$fs` and tessellated
     * normally. OpenSCAD does the opposite: `CurveDiscretizer`'s constructor
     * clamps only `fn < 0` (`CurveDiscretizer.cc:36`, and `NaN < 0` is false
     * too), so the NaN survives into `getCircularSegmentCount`, where
     * `isnan(fn)` returns **no answer at all** (`:104`) and every primitive
     * call site spells the default `.value_or(3)`.
     *
     * ⚠ THE NOTE THAT SAID THIS WAS UNREACHABLE WAS WRONG, and it was wrong in
     * the way that matters: it named the ONE route that is blocked. `0/0` is a
     * hard parse error here, so `$fn = 0/0` never produces a NaN — but
     * `$fn = sqrt(-1)` and `$fn = acos(2)` do, today, with no diagnostic.
     * Measured 2026-08-11: `circle(r=10,$fn=sqrt(-1))` is **3** SVG points in
     * openscad 2026.08.07 and was **30** here. A guard whose only reason is a
     * refusal somewhere else stops holding the moment that refusal moves, and
     * this one had already stopped.
     *
     * So `fn` now carries the value OpenSCAD carries — including `NaN` and
     * `Infinity`, which `fragmentsRequested` in `mesh.ts` turns into 3 by the
     * same `isinf || isnan` rule — and only the cases OpenSCAD really zeroes
     * (`fn < 0`, with its warning) or leaves at 0 fall through to `$fa`/`$fs`.
     */
    const facets = (): Facets => this.facetsFrom(named, env, line);

    const num = (v: Value): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    switch (s.name) {
      case 'cube': {
        accept(['size', 'center', '$fn', '$fa', '$fs']);
        arity(2);
        const size = this.sizeVector('cube', 3, named.get('size') ?? pos[0] ?? 1, line);
        if (!size) return null;
        const center = truthy(named.get('center') ?? pos[1] ?? false);
        return { kind: 'primitive', params: { kind: 'cube', size, center }, line };
      }
      case 'sphere': {
        accept(['r', 'd', 'center', '$fn', '$fa', '$fs']);
        arity(1);
        const d = num(named.get('d') ?? undefined);
        const r = d !== null ? d / 2 : num(named.get('r') ?? pos[0] ?? 1);
        if (r === null) {
          this.fail(line, 'sphere() needs a numeric r or d');
          return null;
        }
        return { kind: 'primitive', params: { kind: 'sphere', r, ...facets() }, line };
      }
      case 'cylinder': {
        accept(['h', 'r', 'r1', 'r2', 'd', 'd1', 'd2', 'center', '$fn', '$fa', '$fs']);
        arity(4);
        const h = num(named.get('h') ?? pos[0] ?? undefined);
        if (h === null) {
          this.fail(line, 'cylinder() needs a numeric h');
          return null;
        }
        // 🔴 POSITIONAL ORDER IS `h, r1, r2, center` — ALL FOUR OF THEM.
        // The old code filled one `rAll` from `pos[1]` and then checked it
        // BEFORE `pos[2]`, so `pos[2]` was unreachable whenever a second
        // positional existed — which is the only situation in which a third can
        // be written. `cylinder(20,10,4)` therefore came out r1 10 / r2 10: a
        // cone drawn as a cylinder, a countersink as a straight bore, a draft
        // angle silently removed. `pos[3]` (`center`) was not read at all, so a
        // centred cylinder sat `h/2` off datum. `scad.test-notes.md` documented
        // the correct order while the code did something else.
        //
        // ⚠ AND A FIFTH CASE THE AUDIT DID NOT FIND: an unspecified radius
        // defaults to **1, not to the other radius**. Probed:
        // `cylinder(10,5)` → `r1 = 5, r2 = 1` — a cone. We drew 5/5.
        // The resolution order below is OpenSCAD's own, measured: the general
        // pair first (`r`, then `d` overriding it), then each side's specific
        // (`r1`/`r2`, then `d1`/`d2`). Checked against `cylinder(h=10,r=5,r1=2)`
        // → 2/5, `cylinder(h=10,r1=2,d=8)` → 2/4, `cylinder(h=20,r=10,d=4)` → 2/2.
        const nOf = (key: string, fallback?: Value): number | null => num(named.get(key) ?? fallback ?? undefined);
        const rV = nOf('r');
        const dV = nOf('d');
        const r1V = nOf('r1', pos[1]);
        const r2V = nOf('r2', pos[2]);
        const d1V = nOf('d1');
        const d2V = nOf('d2');
        if ((rV !== null || dV !== null) && (r1V !== null || r2V !== null || d1V !== null || d2V !== null)) {
          this.warn(line, 'Cylinder parameters ambiguous: a general radius (r/d) and a per-side one (r1/r2/d1/d2) were both given.');
        }
        if (rV === null && dV === null && r1V === null && r2V === null && d1V === null && d2V === null) {
          this.fail(line, 'cylinder() needs r, or d, or r1/r2 (or d1/d2), as numbers');
          return null;
        }
        let r1 = 1;
        let r2 = 1;
        if (rV !== null) { r1 = rV; r2 = rV; }
        if (dV !== null) { r1 = dV / 2; r2 = dV / 2; }
        if (r1V !== null) r1 = r1V;
        if (r2V !== null) r2 = r2V;
        if (d1V !== null) r1 = d1V / 2;
        if (d2V !== null) r2 = d2V / 2;
        const center = truthy(named.get('center') ?? pos[3] ?? false);
        return { kind: 'primitive', params: { kind: 'cylinder', h, r1, r2, center, ...facets() }, line };
      }
      case 'square': {
        accept(['size', 'center', '$fn', '$fa', '$fs']);
        arity(2);
        const s2 = this.sizeVector('square', 2, named.get('size') ?? pos[0] ?? 1, line);
        if (!s2) return null;
        const center = truthy(named.get('center') ?? pos[1] ?? false);
        return { kind: 'primitive', params: { kind: 'square', size: [s2[0], s2[1]], center }, line };
      }
      case 'circle': {
        accept(['r', 'd', '$fn', '$fa', '$fs']);
        arity(1);
        const d = num(named.get('d') ?? undefined);
        const r = d !== null ? d / 2 : num(named.get('r') ?? pos[0] ?? 1);
        if (r === null) {
          this.fail(line, 'circle() needs a numeric r or d');
          return null;
        }
        return { kind: 'primitive', params: { kind: 'circle', r, ...facets() }, line };
      }
      case 'polygon': {
        accept(['points', 'paths', 'convexity']);
        // OpenSCAD's signature is polygon(points, paths, convexity): `paths` is
        // legal POSITIONALLY. `arity(1)` warned it away as a surplus argument.
        arity(3);
        // points = [[x1,y1], [x2,y2], ...] — an array of 2-element arrays.
        const pointsVal = named.get('points') ?? pos[0];
        if (!Array.isArray(pointsVal)) {
          this.fail(line, 'polygon() needs a points array');
          return null;
        }
        const pathsVal = named.has('paths') ? named.get('paths') : pos[1];
        /* 🔴 `paths` IS READ, NOT IGNORED (2026-10-14). An absent, `undef` or
         * EMPTY `paths` means "the points in order" — openscad answers the same
         * 55.5 mm² for all three on a two-ring point list. Anything else is
         * either taken exactly or REFUSED by name; openscad's own handling of
         * the rest (a non-list, a fractional or out-of-range index) is a
         * WARNING and a silently different shape — `paths=[[0,-1,2,3]]` draws a
         * triangle, `[[0,1.5,2,3]]` truncates to index 1 — and a reader that
         * guessed along would cut one of those without a word. */
        let paths: number[][] | undefined;
        if (pathsVal !== undefined && pathsVal !== null && !(Array.isArray(pathsVal) && pathsVal.length === 0)) {
          const bad = (why: string): null => {
            this.refuse(
              'polygon(paths=)',
              line,
              `${why}. openscad warns and draws a DIFFERENT shape from the one written (it skips or truncates ` +
                'the index); nothing is drawn for this node rather than guessing which.',
            );
            return null;
          };
          if (!Array.isArray(pathsVal)) return bad('paths is not a list of index lists');
          paths = [];
          for (let k = 0; k < pathsVal.length; k++) {
            const path = pathsVal[k];
            if (!Array.isArray(path)) return bad(`paths[${k}] is not a list of point indices`);
            const loop: number[] = [];
            for (let m = 0; m < path.length; m++) {
              const ix = path[m];
              if (typeof ix !== 'number' || !Number.isInteger(ix)) return bad(`paths[${k}][${m}] is not an integer point index`);
              if (ix < 0 || ix >= pointsVal.length) {
                return bad(`paths[${k}][${m}] = ${ix} is outside the ${pointsVal.length} points`);
              }
              const pt = pointsVal[ix];
              if (!Array.isArray(pt) || pt.length < 2 || num(pt[0]) === null || num(pt[1]) === null) {
                return bad(`paths[${k}][${m}] names point ${ix}, which is not a numeric [x, y]`);
              }
              loop.push(ix);
            }
            paths.push(loop);
          }
        }
        if (paths) {
          // Indices address the ORIGINAL list, so it is kept whole: every point
          // a path names was checked above, and unnamed ones are never read.
          const all = pointsVal.map((pt) =>
            Array.isArray(pt) && pt.length >= 2 && num(pt[0]) !== null && num(pt[1]) !== null
              ? ([num(pt[0])!, num(pt[1])!] as [number, number])
              : ([NaN, NaN] as [number, number]),
          );
          return { kind: 'primitive', params: { kind: 'polygon', points: all, paths }, line };
        }
        const pts: [number, number][] = [];
        for (const pt of pointsVal) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          const x = num(pt[0]);
          const y = num(pt[1]);
          if (x !== null && y !== null) pts.push([x, y]);
        }
        if (pts.length < 3) {
          this.fail(line, `polygon() needs at least 3 points, got ${pts.length}`);
          return null;
        }
        return { kind: 'primitive', params: { kind: 'polygon', points: pts }, line };
      }
      case 'text': {
        accept(['text', 'size', 'font', 'halign', 'valign', 'spacing', 'direction', 'language', 'script', '$fn', '$fa', '$fs']);
        arity(1);
        // pos[] and named are already evaluated Values (see the primitive method).
        const textVal = named.get('text') ?? pos[0] ?? '';
        const text = typeof textVal === 'string' ? textVal : String(textVal ?? '');
        const size = num(named.get('size') ?? pos[1]) ?? 10;
        const fontVal = named.get('font');
        const fontStr = typeof fontVal === 'string' ? fontVal : '';
        const halignRaw = named.get('halign');
        const valignRaw = named.get('valign');
        const halignVal = typeof halignRaw === 'string' ? halignRaw : 'left';
        const valignVal = typeof valignRaw === 'string' ? valignRaw : 'baseline';
        const halign = (['left', 'center', 'right'].includes(halignVal) ? halignVal : 'left') as 'left' | 'center' | 'right';
        const valign = (['top', 'center', 'baseline', 'bottom'].includes(valignVal) ? valignVal : 'baseline') as 'top' | 'center' | 'baseline' | 'bottom';
        const spacing = num(named.get('spacing')) ?? 1;
        return {
          kind: 'primitive',
          params: {
            kind: 'text',
            text,
            size,
            font: fontStr,
            halign,
            valign,
            spacing,
            direction: 'ltr',
            language: 'en',
            script: 'latin',
            ...facets(),
          },
          line,
        };
      }
      case 'polyhedron': {
        accept(['points', 'faces', 'convexity']);
        arity(1);
        // points = [[x,y,z], ...] — array of 3-element arrays
        const pointsVal = named.get('points') ?? pos[0];
        if (!Array.isArray(pointsVal)) {
          this.fail(line, 'polyhedron() needs a points array');
          return null;
        }
        const pts: [number, number, number][] = [];
        for (const pt of pointsVal) {
          if (!Array.isArray(pt) || pt.length < 3) continue;
          const x = num(pt[0]);
          const y = num(pt[1]);
          const z = num(pt[2]);
          if (x !== null && y !== null && z !== null) pts.push([x, y, z]);
        }
        if (pts.length < 3) {
          this.fail(line, `polyhedron() needs at least 3 points, got ${pts.length}`);
          return null;
        }
        // faces = [[0,1,2], [3,4,5], ...] — array of index arrays
        const facesVal = named.get('faces');
        const faces: number[][] = [];
        if (Array.isArray(facesVal)) {
          for (const f of facesVal) {
            if (Array.isArray(f)) {
              const indices = f.map((i) => typeof i === 'number' ? i : -1).filter((i) => i >= 0);
              if (indices.length >= 3) faces.push(indices);
            }
          }
        }
        if (faces.length === 0) {
          this.fail(line, 'polyhedron() needs at least one face');
          return null;
        }
        return { kind: 'primitive', params: { kind: 'polyhedron', points: pts, faces }, line };
      }
    }
    return null;
  }

  // --- expression evaluation ----------------------------------------------

  eval(e: Expr, env: Env): Value {
    switch (e.t) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'bool':
        return e.v;
      case 'undef':
        return undefined;
      case 'refused':
        this.refuse(e.name, e.line, e.detail);
        return FAILED;
      case 'var': {
        const v = lookup(env, e.name);
        if (v === undefined && !env.vars.has(e.name)) {
          // OpenSCAD warns and continues with undef. We report it, because a
          // dimension that silently became undef is a part of the wrong size —
          // and we return FAILED rather than undef so the report cannot be
          // followed by a primitive quietly applying its default.
          this.fail(e.line, `variable ${e.name} is not defined here; it evaluates to undef`);
          return FAILED;
        }
        return v;
      }
      case 'vec': {
        const out: Value[] = [];
        for (const i of e.items) this.pushElement(out, i, env);
        return out;
      }
      case 'each':
        // Element position is handled by `pushElement`; reaching `eval` means
        // `each` was written somewhere it cannot splice into anything.
        this.refuse(
          'each outside a vector or list comprehension',
          e.line,
          '`each` splices into a list; it has no meaning as a plain value',
        );
        return FAILED;
      case 'range': {
        const start = this.eval(e.start, env);
        const end = this.eval(e.end, env);
        const step = e.step ? this.eval(e.step, env) : 1;
        if (carriesFailed(start) || carriesFailed(step) || carriesFailed(end)) return FAILED;
        if (typeof start !== 'number' || typeof end !== 'number' || typeof step !== 'number') {
          this.fail(e.line, 'a range needs numeric start, step and end');
          return FAILED;
        }
        // 🔴 `[b:e]` with b > e and NO step: OpenSCAD SWAPS the ends (with a
        // "deprecated" warning) and iterates. This returned an empty range, so
        // `for (i = [0 : n-1])` with n = 0 and `[3:1]` dropped every part the author
        // saw in OpenSCAD's preview, with no word (bughunt 2026-11-15). With an
        // explicit step the wrong direction is still empty, as in OpenSCAD.
        if (!e.step && start > end) {
          this.warn(e.line, `DEPRECATED: Using ranges of the form [begin:end] with begin value greater than the end value is deprecated. [${start}:${end}] is read as [${end}:${start}], as OpenSCAD does`);
          return { __range: true, start: end, step, end: start };
        }
        return { __range: true, start, step, end };
      }
      case 'unary': {
        const v = this.eval(e.e, env);
        if (v === FAILED) return FAILED;
        if (e.op === '!') return !truthy(v);
        if (typeof v !== 'number') {
          if (Array.isArray(v) && e.op === '-') return v.map((x) => (typeof x === 'number' ? -x : x));
          this.fail(e.line, `cannot apply unary ${e.op} to ${typeName(v)}`);
          return FAILED;
        }
        return e.op === '-' ? -v : v;
      }
      case 'ternary': {
        const c = this.eval(e.c, env);
        // A question that could not be asked has no answer, and the `false`
        // branch is not it. See the same rule at the `if` statement.
        if (carriesFailed(c)) return FAILED;
        return truthy(c) ? this.eval(e.a, env) : this.eval(e.b, env);
      }
      case 'index': {
        const base = this.eval(e.e, env);
        const idx = this.eval(e.i, env);
        if (carriesFailed(base) || carriesFailed(idx)) return FAILED;
        // Out of range stays `undef`, which is what OpenSCAD returns and what
        // the language means by it. Only a REFUSED index is poisoned.
        //
        // 🔴 STRINGS INDEX TOO, AND NOT SUPPORTING THEM WAS NOT A GAP — IT WAS
        // A SILENTLY WRONG ANSWER. This read `Array.isArray(base) && …`, so
        // `"abc"[0]` fell through to `undef` with no error and no `unsupported`
        // entry. Measured consequence in `cad`'s own tree, 2026-09-02:
        //
        //   function _enc_sub(s,i,n) = [for (k=[i:i+n-1]) s[k]];
        //   function enc_has(hay,needle) = … _enc_sub(hay,i,n) == _enc_sub(needle,0,n) …
        //
        // Every character came back `undef`, `undef == undef` is TRUE, so
        // `enc_has` answered **true for every string** — a substring predicate
        // that matches everything. `enc_junction`'s filter then passed every
        // row, took `m[0]`, and bound the SoC junction to the camera connector.
        // `ENC_soc_edge_in_io_x` came out 30.734 where pcb's independently
        // derived figure is 42.220, and `cad`'s own assert — written to catch
        // exactly that — fired. OpenSCAD renders the same file with no error.
        //
        // ⚠ A MISSING FEATURE THAT RETURNS A PLAUSIBLE VALUE IS WORSE THAN ONE
        // THAT REFUSES. Nothing was named, so nothing could be looked up; the
        // defect surfaced only because a downstream assertion happened to exist.
        //
        // Indexing is by CODE POINT, not UTF-16 unit — `"héllo"[1]` is `"é"` —
        // and a fractional index TRUNCATES toward zero: `[10,20,30][1.5]` is
        // 20 and `[-0.5]` is 10. All measured against OpenSCAD 2026.08.07.
        if (typeof idx !== 'number' || !Number.isFinite(idx)) return undefined;
        const i = Math.trunc(idx);
        if (i < 0) return undefined;
        if (Array.isArray(base)) return i < base.length ? base[i] : undefined;
        if (typeof base === 'string') {
          const points = [...base];
          return i < points.length ? points[i] : undefined;
        }
        return undefined;
      }
      case 'let':
        return this.eval(e.body, this.bindLet(e.binds, env));
      /* Expression-form assert. Same condition/message semantics as the
       * statement form (see the `name === 'assert'` branch in exec), so a file
       * cannot get one answer from a check and another from the same check
       * written in the other position. ⚠ It HALTS on failure exactly as the
       * statement does: an assert that evaluated to undef and let the caller
       * continue would be a check that reports and does not stop, which is the
       * whole reason cad moved theirs into expression position — a statement
       * assert fires only after undef has already propagated.
       *
       * 🔴 THAT REASON IS RETRACTED (cad, 2026-09-06, refuted by their own
       * plant): statement-form and expression-form asserts behave IDENTICALLY,
       * and a statement assert placed above its operand renders cleanly with no
       * warning. The real rule they measured is different and sharper — a
       * STATEMENT sees the final value of every top-level variable in its scope,
       * while an ASSIGNMENT sees only what is defined ABOVE it — so the hazard is
       * a DERIVED CONSTANT placed above its inputs, which is silent in the value
       * (undef) and loud only in a warning nobody reads.
       *
       * ⚠ The support below is UNAFFECTED and stands on its own: real OpenSCAD
       * accepts `assert(cond, msg) expr`, and a reader that rejects it produced
       * 13 parse errors on a file that renders at rc=0. ⇒ A correct fix reached
       * through a wrong mechanism gets GENERALISED using the wrong mechanism —
       * the next reader hitting an undef would move an assert instead of looking
       * at where a constant sits. The feature is right; the story was not. */
      case 'assertexpr': {
        const pos = e.args.filter((a) => !a.name);
        if (pos.length === 0) {
          this.fail(e.line, 'assert() needs at least a condition argument');
          return undefined;
        }
        const condition = this.eval(pos[0].value, env);
        if (!truthy(condition)) {
          let msg = 'assertion failed';
          const msgArg = e.args.find((a) => a.name === 'message') ?? pos[1];
          if (msgArg) {
            const msgVal = this.eval(msgArg.value, env);
            if (typeof msgVal === 'string') msg = msgVal;
            else if (msgVal !== undefined) msg = formatValue(msgVal);
          }
          this.haltAfter(e.line, msg);
        }
        return e.body === null ? undefined : this.eval(e.body, env);
      }
      case 'binary':
        return this.binary(e, env);
      case 'call':
        return this.fnCall(e, env);
      case 'fndef':
        return { __fn: true, params: e.params, body: e.body, env };
      case 'listcomp':
        return this.evalListComp(e, env);
    }
  }

  /**
   * Evaluate a list comprehension: `[for (…) if (…) expr]` and variants.
   *
   * Works like `execFor` but collects expression values into a list instead
   * of producing geometry.  Clauses are processed left-to-right: each `for`
   * iterates its bindings (nested when multiple), `let` binds sequentially,
   * and `if` filters (or, with `else`, selects an alternative body).
   */
  /**
   * Append ONE element to a list being built, splicing when it is `each`.
   *
   * Vector and range splice. Scalar yields a one-element splice. `undef` is
   * REFUSED BY NAME, and that one is a deliberate divergence — see below.
   *
   * 🔴 MEASURED AGAINST OPENSCAD 2026.08.07 ON THIS BOX, not recalled:
   *
   *     [for (p = [0,2,5]) each [p, p+1]]  ->  [0, 1, 2, 3, 5, 6]   match
   *     [for (p = [[1,2],[3,4]]) each p]   ->  [1, 2, 3, 4]         match
   *     [1, each [2,3], 4]                 ->  [1, 2, 3, 4]         match
   *     [each [7,8], 9]                    ->  [7, 8, 9]            match
   *     [each [0:2], 9]                    ->  [0, 1, 2, 9]         match
   *     [for(i=[0:2]) if(i==1) i else each [8,9]] -> [8,9,1,8,9]    match
   *     [each 5]                           ->  [5]                  match
   *     [each undef]                       ->  []                   WE REFUSE
   *
   * ⚠ THE LAST ROW IS A RULING, NOT AN OMISSION. OpenSCAD splices `undef` to
   * NOTHING, silently. That is the one `each` operand where the wrong answer is
   * invisible: a mistyped variable is `undef`, `undef` contributes no elements,
   * and a list of pilot-hole centres comes back SHORTER with no diagnostic — the
   * model still draws, still posts, still gates green, and the part comes out
   * with holes missing. Refusing cannot produce a wrong part; accepting can. So
   * this reader diverges on the conservative side and says which side it took.
   *
   * ⚠ The cost of the divergence is bounded and was checked: NO file in
   * `hardware/cad/` uses `each` on anything but a vector literal (2 uses, both
   * `each [p, p + 1]`, in `2bee_hive/`). If a design ever needs OpenSCAD's
   * empty-splice it should write `each []`, which this reader already accepts
   * and which says what it means.
   */
  private pushElement(out: Value[], e: Expr, env: Env): void {
    if (e.t !== 'each') {
      out.push(this.eval(e, env));
      return;
    }
    const v = this.eval(e.value, env);
    if (carriesFailed(v)) {
      out.push(FAILED);
      return;
    }
    if (v === undefined || v === null) {
      this.refuse(
        'each undef',
        e.line,
        'OpenSCAD splices undef to nothing, silently — a mistyped name would ' +
          'shorten the list and draw a part with elements missing. Write `each []` ' +
          'if an empty splice is what you mean.',
      );
      out.push(FAILED);
      return;
    }
    const items = iterableOf(v);
    if (items === null) {
      // A scalar splices as one element — matches OpenSCAD, measured above.
      out.push(v);
      return;
    }
    for (const item of items) out.push(item);
  }

  private evalListComp(e: Extract<Expr, { t: 'listcomp' }>, env: Env): Value {
    const result: Value[] = [];

    const collect = (idx: number, bound: Env): void => {
      if (idx >= e.clauses.length) {
        this.pushElement(result, e.body, bound);
        return;
      }
      const clause = e.clauses[idx];
      switch (clause.t) {
        case 'for': {
          // Multiple bindings in one `for` clause nest like `execFor`.
          const forLoop = (bi: number, benv: Env): void => {
            if (bi >= clause.bindings.length) {
              collect(idx + 1, benv);
              return;
            }
            const b = clause.bindings[bi];
            const v = this.eval(b.value, benv);
            if (this.guardArgs(`for (${b.name} = ...) in list comprehension`, e.line, [v])) return;
            const items = iterableOf(v);
            if (items === null) {
              this.fail(
                e.line,
                `for (${b.name} = ...) needs a vector or a range, got ${typeName(v)}`,
              );
              return;
            }
            for (const item of items) {
              this.iterations++;
              if (this.iterations > MAX_LOOP_ITERATIONS) {
                this.haltAfter(e.line, `stopped: more than ${MAX_LOOP_ITERATIONS} loop iterations.`);
              }
              const inner = newEnv(benv, benv);
              inner.vars.set(b.name, item);
              forLoop(bi + 1, inner);
            }
          };
          forLoop(0, bound);
          break;
        }
        case 'let': {
          collect(idx + 1, this.bindLet(clause.binds, bound));
          break;
        }
        case 'if': {
          const cv = this.eval(clause.cond, bound);
          if (carriesFailed(cv)) return;
          if (truthy(cv)) {
            collect(idx + 1, bound);
          } else if (e.elseBody) {
            this.pushElement(result, e.elseBody, bound);
          }
          // Without elseBody the iteration is skipped (filter).
          break;
        }
      }
    };

    collect(0, env);
    return result;
  }

  private binary(e: Extract<Expr, { t: 'binary' }>, env: Env): Value {
    if (e.op === '&&' || e.op === '||') {
      // 🔴 SHORT-CIRCUIT, AND IT IS NOT AN OPTIMISATION. Probed:
      // `x = is_undef(nosuch) || nosuch;` evaluates clean in OpenSCAD, with NO
      // warning about `nosuch` — the right operand is never evaluated. Both
      // operands used to be evaluated here, so the standing idiom
      // `if (is_undef(_x) || _x)` reported an undefined variable, poisoned the
      // condition, and the whole `if` was refused: a library file that draws
      // itself when opened alone drew NOTHING, for a name the source is
      // deliberately asking about rather than reading.
      const a = this.eval(e.l, env);
      if (carriesFailed(a)) return FAILED;
      const ta = truthy(a);
      if (e.op === '&&' && !ta) return false;
      if (e.op === '||' && ta) return true;
      const b = this.eval(e.r, env);
      if (carriesFailed(b)) return FAILED;
      return truthy(b);
    }

    const l = this.eval(e.l, env);
    const r = this.eval(e.r, env);

    // A refused operand poisons the expression WITHOUT a second diagnostic —
    // the reason was already reported where it happened, and a cascade of
    // consequential errors buries it.
    if (carriesFailed(l) || carriesFailed(r)) return FAILED;

    if (e.op === '==') return same(l, r);
    if (e.op === '!=') return !same(l, r);

    if (Array.isArray(l) && Array.isArray(r) && (e.op === '+' || e.op === '-')) {
      const n = Math.max(l.length, r.length);
      const out: Value[] = [];
      for (let i = 0; i < n; i++) {
        const a = l[i];
        const b = r[i];
        out.push(typeof a === 'number' && typeof b === 'number' ? (e.op === '+' ? a + b : a - b) : undefined);
      }
      return out;
    }
    if (Array.isArray(l) && typeof r === 'number' && (e.op === '*' || e.op === '/')) {
      return l.map((x) => (typeof x === 'number' ? (e.op === '*' ? x * r : x / r) : undefined));
    }
    if (typeof l === 'number' && Array.isArray(r) && e.op === '*') {
      return r.map((x) => (typeof x === 'number' ? x * l : undefined));
    }
    if (typeof l === 'string' && typeof r === 'string' && e.op === '+') return l + r;

    if (typeof l !== 'number' || typeof r !== 'number') {
      this.fail(e.line, `cannot apply ${e.op} to ${typeName(l)} and ${typeName(r)}`);
      return FAILED;
    }
    if ((e.op === '/' || e.op === '%') && r === 0) {
      // 🔴 THIS WAS THE ONE CASE WITH NO DIAGNOSTIC AT ALL. `a = 1/0; cube(a);`
      // returned `undefined`, which `?? 1` then absorbed, and a 1 mm cube was
      // drawn from an expression OpenSCAD evaluates to `inf` — silently, and
      // audited `closed`. We do not have `inf`; we say so.
      this.fail(
        e.line,
        `division by zero. OpenSCAD evaluates this to ${e.op === '/' ? 'inf/nan' : 'nan'} and carries it into ` +
          'the geometry; this file has no such value, so nothing is drawn for whatever used it.',
      );
      return FAILED;
    }
    switch (e.op) {
      case '+':
        return l + r;
      case '-':
        return l - r;
      case '*':
        return l * r;
      case '/':
        return l / r;
      case '%':
        return l % r;
      case '^':
        // Probed against OpenSCAD 2026.08.07: `2^10` → 1024, `2^-1` → 0.5,
        // `-2^2` → −4 (precedence), `2^3^2` → 512 (associativity).
        return Math.pow(l, r);
      case '<':
        return l < r;
      case '<=':
        return l <= r;
      case '>':
        return l > r;
      case '>=':
        return l >= r;
    }
    return undefined;
  }

  /**
   * A user-defined function call.
   *
   * The binding rules are the MODULE rules, deliberately, and they were probed
   * as a set rather than assumed to match:
   *
   *   `function fact(n) = n <= 1 ? 1 : n * fact(n-1); fact(5)` → 120 (recursion)
   *   `function add(a, b = 10) = a + b; add(1)`               → 11  (defaults)
   *   `cube(g(2)); function g(x) = x*4;`                      → 8   (hoisted)
   *   `function h(a, b = a*2) = a + b; h(3)`                  → a default does
   *       NOT see an earlier parameter: OpenSCAD warns `Ignoring unknown
   *       variable "a"` and the call comes out `undef`, exactly as for a module
   *   `k = 5; function q() = k; module m(){ k = 100; cube(q()); } m();` → 5,
   *       so the closure is the DEFINING scope, not the call site
   *
   * 🔴 THE DEPTH LIMIT IS AN ERROR, NEVER A VALUE. A recursion with no base case
   * must not come back as `undef` and then be absorbed by a primitive's default;
   * it stops the whole evaluation and says why, the same as a runaway `for`.
   */
  private callUserFunction(def: FunctionDef, e: Extract<Expr, { t: 'call' }>, callerEnv: Env): Value {
    if (this.fnDepth >= MAX_FN_DEPTH) {
      this.fail(
        e.line,
        `stopped: function calls nested deeper than ${MAX_FN_DEPTH} (in ${def.name}()). ` +
          'A recursive function with no base case? Nothing after this line was evaluated.',
      );
      throw new Halt();
    }

    const env = newEnv(def.env, callerEnv);
    const positional = e.args.filter((a) => a.name === null);
    for (let i = 0; i < def.params.length && i < positional.length; i++) {
      env.vars.set(def.params[i].name, this.eval(positional[i].value, callerEnv));
    }
    if (positional.length > def.params.length) {
      this.warn(
        e.line,
        `${def.name}() was given ${positional.length} positional arguments and takes ${def.params.length}; ` +
          'the surplus were ignored.',
      );
    }
    for (const a of e.args) {
      if (!a.name) continue;
      if (a.name.startsWith('$')) {
        env.vars.set(a.name, this.eval(a.value, callerEnv));
        continue;
      }
      if (!def.params.some((p) => p.name === a.name)) {
        this.refuse(
          `${def.name}(${a.name}=)`,
          e.line,
          `function ${def.name} has no parameter named ${a.name}; the argument was not applied`,
        );
        continue;
      }
      if (env.vars.has(a.name)) {
        this.warn(e.line, `argument "${a.name}" overrides positional argument in ${def.name}().`);
      }
      env.vars.set(a.name, this.eval(a.value, callerEnv));
    }
    // Defaults last, evaluated where the function was DEFINED — see the probe above.
    for (const p of def.params) {
      if (env.vars.has(p.name)) continue;
      env.vars.set(p.name, p.def ? this.eval(p.def, def.env) : undefined);
    }

    this.fnDepth++;
    this.origins.push(def.origin);
    try {
      return this.eval(def.body, env);
    } finally {
      this.origins.pop();
      this.fnDepth--;
    }
  }

  /**
   * `is_undef` and its siblings.
   *
   * 🔴 THE INTERACTION THIS METHOD EXISTS TO SETTLE, AND THE ANSWER IS A SPECIAL
   * FORM RATHER THAN A WEAKER SENTINEL.
   *
   * `FAILED` (see its own header) is the value a REFUSED or FAILED expression
   * takes, and nothing can absorb it — that is what stops `cube(sq(3))` with
   * `sq` refused from quietly becoming a 1 mm cube. An unbound VARIABLE also
   * evaluates to `FAILED` here, deliberately: OpenSCAD warns and carries `undef`
   * into the geometry, and this file draws nothing instead.
   *
   * That collision is what makes the single most common idiom in
   * `hardware/cad/` — `X = is_undef(X) ? 1 : X;` and
   * `if (is_undef(_lib_only) || !_lib_only)`, in 27 of the 68 files — unable to
   * work by simply implementing the predicate: the self-reference is a FAILED
   * value, not an `undef`, so the predicate would be asked about a value it is
   * not allowed to look at.
   *
   * ⚠ THE FIX IS NOT TO MAKE AN UNBOUND NAME EVALUATE TO `undef`. That is the
   * one change that WOULD re-open the defect: `undef` is exactly what
   * `named.get('size') ?? pos[0] ?? 1` reads as "the argument was omitted", so
   * `cube(typo)` would come back as a 1 mm cube with the same green audit as
   * before. The sentinel is not weakened by a single character here.
   *
   * ✅ Instead `is_undef(<a bare name>)` is a SPECIAL FORM: it asks the
   * ENVIRONMENT whether the name is bound, and never evaluates it. That is what
   * OpenSCAD itself does — probed: `is_undef(nosuchname)` emits NO warning,
   * while `b = nosuchname;` emits `WARNING: Ignoring unknown variable`. So the
   * question "is this name defined" and the act "read this name" are different
   * operations in the reference implementation too, and only the second one is
   * an error here.
   *
   * ⚠ WHAT IS THEREFORE STILL REFUSED, NAMED SO IT IS NOT DISCOVERED LATER:
   * `is_undef(<any other expression>)` evaluates that expression, so
   * `is_undef(some_refused_call())` is a refusal rather than `true`. That is
   * correct — we do not know what the value would have been, so we cannot say it
   * is not undef — and it is not a case any file in `hardware/cad/` writes:
   * every one of the 32 sites measured passes a bare name.
   */
  private predicate(e: Extract<Expr, { t: 'call' }>, env: Env): Value {
    const pos = e.args.filter((a) => a.name === null);
    if (pos.length !== 1 || pos.length !== e.args.length) {
      this.refuse(
        `${e.name}()`,
        e.line,
        `${e.name}() takes exactly one positional argument; nothing is drawn for whatever used its result`,
      );
      return FAILED;
    }
    const arg = pos[0].value;

    // The special form. See the header.
    if (e.name === 'is_undef' && arg.t === 'var') {
      if (!hasBinding(env, arg.name)) return true;
      const v = lookup(env, arg.name);
      if (v === FAILED) return FAILED; // bound, but to a refusal — unknowable
      return v === undefined;
    }

    const v = this.eval(arg, env);
    if (carriesFailed(v)) return FAILED;
    switch (e.name) {
      case 'is_undef':
        return v === undefined;
      case 'is_bool':
        return typeof v === 'boolean';
      case 'is_num':
        return typeof v === 'number';
      case 'is_string':
        return typeof v === 'string';
      case 'is_list':
        return Array.isArray(v);
      case 'is_function':
        return typeof v === 'object' && v !== null && '__fn' in v;
    }
    return undefined;
  }

  private fnCall(e: Extract<Expr, { t: 'call' }>, env: Env): Value {
    // 🔴 USER FUNCTIONS ARE LOOKED UP FIRST, AND SHADOW A BUILTIN. Probed:
    // `function sin(x) = 999; cube(sin(30));` is a 999 mm cube in OpenSCAD.
    // Checking the builtin table first would silently run OUR sine over a name
    // the source redefined.
    const user = lookupFunction(env, e.name);
    if (user) return this.callUserFunction(user, e, env);

    // A function literal stored as a variable value: `f = function(x) x * 2; f(5);`
    const fnVal = lookup(env, e.name);
    if (fnVal !== undefined && fnVal !== null && typeof fnVal === 'object' && '__fn' in (fnVal as object)) {
      const fv = fnVal as unknown as FnValue;
      const synthetic: FunctionDef = { name: e.name, params: fv.params, body: fv.body, env: fv.env, origin: null };
      return this.callUserFunction(synthetic, e, env);
    }

    if (IS_PREDICATES.has(e.name)) return this.predicate(e, env);

    const args = e.args.map((a) => this.eval(a.value, env));
    const n = (i: number): number => (typeof args[i] === 'number' ? (args[i] as number) : NaN);
    const D = Math.PI / 180;

    if (!MATH_FNS.has(e.name)) {
      this.refuse(
        `${e.name}()`,
        e.line,
        KNOWN_REFUSED_MODULES[e.name]
          ? `${KNOWN_REFUSED_MODULES[e.name]}. Used as a function, nothing is drawn for whatever used its result.`
          : 'not a function this subset knows. Nothing is drawn for whatever used its result — a refused ' +
            'function call is not an omitted argument.',
      );
      return FAILED;
    }
    if (args.some(carriesFailed)) return FAILED;

    switch (e.name) {
      case 'abs':
        return Math.abs(n(0));
      case 'sign':
        return Math.sign(n(0));
      case 'sin':
        return Math.sin(n(0) * D);
      case 'cos':
        return Math.cos(n(0) * D);
      case 'tan':
        return Math.tan(n(0) * D);
      case 'asin':
        return Math.asin(n(0)) / D;
      case 'acos':
        return Math.acos(n(0)) / D;
      case 'atan':
        return Math.atan(n(0)) / D;
      case 'atan2':
        return Math.atan2(n(0), n(1)) / D;
      case 'sqrt':
        return Math.sqrt(n(0));
      case 'pow':
        return Math.pow(n(0), n(1));
      case 'exp':
        return Math.exp(n(0));
      case 'ln':
        return Math.log(n(0));
      case 'log':
        return Math.log10(n(0));
      case 'floor':
        return Math.floor(n(0));
      case 'ceil':
        return Math.ceil(n(0));
      case 'round': {
        // 🔴 NOT `Math.round`. JS rounds a half toward +∞ (`round(-0.5)` → 0);
        // C's `round()`, which OpenSCAD uses, rounds a half AWAY FROM ZERO
        // (`round(-0.5)` → −1). Probed: −1, −2, −3 against our 0, −1, −2. The
        // `round(-x/2)` centring idiom is a full millimetre out on the negative
        // side, and only on the negative side, which is why nobody notices.
        const x = n(0);
        return Math.sign(x) * Math.round(Math.abs(x));
      }
      case 'len':
        return Array.isArray(args[0]) ? (args[0] as Value[]).length : typeof args[0] === 'string' ? (args[0] as string).length : undefined;
      case 'norm': {
        const v = args[0];
        if (!Array.isArray(v)) return undefined;
        let sum = 0;
        for (const x of v) if (typeof x === 'number') sum += x * x;
        return Math.sqrt(sum);
      }
      case 'str':
        /* Every argument concatenated. TOP-LEVEL strings are unquoted and
         * nested ones are not — measured, see {@link strJoin}. */
        return args.map((a) => (typeof a === 'string' ? a : strFormat(a))).join('');
      case 'concat': {
        const out: Value[] = [];
        for (const a of args) {
          if (Array.isArray(a)) out.push(...a);
          else out.push(a);
        }
        return out;
      }
      case 'min':
      case 'max': {
        const flat: number[] = [];
        for (const a of args) {
          if (Array.isArray(a)) {
            for (const x of a) if (typeof x === 'number') flat.push(x);
          } else if (typeof a === 'number') flat.push(a);
        }
        if (!flat.length) return undefined;
        return e.name === 'min' ? Math.min(...flat) : Math.max(...flat);
      }
    }
    return undefined;
  }
}

function truthy(v: Value): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function same(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  return a === b;
}

function typeName(v: Value): string {
  if (v === FAILED) return 'a refused or failed expression';
  if (v === undefined) return 'undef';
  if (Array.isArray(v)) return 'a vector';
  if (typeof v === 'object' && v !== null && '__range' in v) return 'a range';
  if (typeof v === 'object' && v !== null && '__fn' in v) return 'a function';
  if (typeof v === 'number') return 'a number';
  if (typeof v === 'boolean') return 'a boolean';
  return 'a string';
}

/**
 * OpenSCAD-compatible value formatter for `echo()` output.
 *
 * OpenSCAD's `ECHO:` line uses this format: strings in quotes, `undef` as a
 * word, numbers as-is, booleans as `true`/`false`, vectors as `[...]`, ranges
 * as `[start : step : end]`, functions as `function`.
 */
/**
 * A number as `str()` renders it — SIX SIGNIFICANT DIGITS, fixed or scientific.
 *
 * 🔴 MEASURED AGAINST OPENSCAD 2026.08.07 ON THIS BOX, not derived from a
 * printf format. `%g` is the obvious guess and it is WRONG in the direction
 * that matters: `%g` switches to scientific below 1e-4, so it would render
 * `str(0.000012345678)` as `1.23457e-05` where OpenSCAD gives
 * `0.0000123457`. OpenSCAD uses double-conversion's precision mode, whose
 * fixed/scientific choice is about padding zeroes rather than magnitude.
 *
 * JavaScript's own `toPrecision(6)` happens to make the SAME choice at both
 * ends — it goes exponential at exponent >= 6 and < -6 — so this is
 * `toPrecision(6)` with trailing zeroes stripped. That is a coincidence of two
 * specifications agreeing, not a derivation, so it is pinned by a table of 17
 * measured values in `tests/cad-str-builtin.test.ts` rather than trusted.
 */
function strNumber(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (v === 0) return '0'; // covers -0, which OpenSCAD prints as "0"
  const s = v.toPrecision(6);
  const strip = (m: string) => (m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return `${strip(m)}e${e}`;
  }
  return strip(s);
}

/**
 * One value as it appears INSIDE a `str()` result.
 *
 * ⚠ NOT {@link formatValue}, and the three differences are all measured:
 *   · a nested string IS quoted — `str(["a"])` is `["a"]` — while a TOP-LEVEL
 *     string argument is not: `str("a", 1)` is `a1`. That asymmetry is why the
 *     caller handles the top level and this handles the rest.
 *   · numbers carry six significant digits, not JavaScript's full precision.
 *   · a range always prints its step: `str([0:2])` is `[0 : 1 : 2]`, where
 *     `echo` prints `[0 : 2]`.
 */
function strFormat(v: Value): string {
  if (v === FAILED) return 'FAILED';
  if (v === undefined) return 'undef';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return strNumber(v);
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map(strFormat).join(', ')}]`;
  if (typeof v === 'object' && v !== null && '__range' in v) {
    const r = v as RangeValue;
    return `[${strNumber(r.start)} : ${strNumber(r.step)} : ${strNumber(r.end)}]`;
  }
  if (typeof v === 'object' && v !== null && '__fn' in v) return 'function';
  return String(v);
}

function formatValue(v: Value): string {
  if (v === FAILED) return 'FAILED';
  if (v === undefined) return 'undef';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    // OpenSCAD prints integers without a decimal point.
    return String(v);
  }
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (typeof v === 'object' && v !== null && '__range' in v) {
    const r = v as RangeValue;
    return r.step === 1 ? `[${r.start} : ${r.end}]` : `[${r.start} : ${r.step} : ${r.end}]`;
  }
  if (typeof v === 'object' && v !== null && '__fn' in v) return 'function';
  return String(v);
}

/** The next double above `x`. Used by `iterableOf` and by nothing else. */
function nextUp(x: number): number {
  if (!Number.isFinite(x)) return x;
  const buf = new Float64Array(1);
  buf[0] = x;
  const bits = new BigInt64Array(buf.buffer);
  bits[0] += x >= 0 ? 1n : -1n;
  return buf[0];
}

/**
 * A range, expanded the way OpenSCAD expands one.
 *
 * 🔴 THE OLD LOOP ACCUMULATED (`x += step`) AND ALLOWED A 1e-12 SLACK, WHICH
 * PRODUCED ONE EXTRA ITEM. `for (i = [1:0.05:1.2])` ran 5 times here and runs 4
 * times in OpenSCAD — one extra hole or boss at the end of a patterned row,
 * easy to miss on a preview and impossible to miss in the material. OpenSCAD
 * does not accumulate: it computes a COUNT and then evaluates `begin + i*step`.
 *
 * ⚠ THE COUNT'S TOLERANCE WAS MEASURED, NOT ASSUMED, AND IT IS EXACTLY ONE ULP.
 * `(end−begin)/step` lands just under an integer for most decimal steps, so the
 * rule decides whether the last item exists. Probed against OpenSCAD 2026.08.07
 * with ranges constructed to sit 1 and 2 ulps below the integers 3, 4, 5, 8, 9,
 * 16, 17 and 33: **1 ulp below always rounds up, 2 ulps below never does**, at
 * every one of those magnitudes. That distinguishes the two cases no simpler
 * rule can separate — `[0:0.1:0.3]` (1 ulp below 3, and OpenSCAD emits 4
 * values) from `[1:0.05:1.2]` (2 ulps below 4, and OpenSCAD emits 4 values, not
 * 5). A plain `Math.trunc` gets the first wrong; a plain `Math.round` gets the
 * second wrong; an absolute or relative epsilon fitted to one breaks the other.
 */
function iterableOf(v: Value): Value[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && v !== null && '__range' in v) {
    const r = v as RangeValue;
    const out: Value[] = [];
    if (!Number.isFinite(r.step) || r.step === 0) return out;
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) return out;
    if (r.step > 0 ? r.start > r.end : r.start < r.end) return out;

    const span = r.step > 0 ? (r.end - r.start) / r.step : (r.start - r.end) / -r.step;
    const n = Math.trunc(nextUp(span));
    // The loop budget is enforced by `execFor`, which reports it. This cap only
    // stops the ARRAY from being built before that check can run.
    const last = Math.min(n, MAX_LOOP_ITERATIONS);
    for (let i = 0; i <= last; i++) out.push(r.start + i * r.step);
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Constants OpenSCAD predefines. A user assignment to the same name wins,
 *  because `execBlock` binds into this very environment.
 *
 *  ⚠ `PI` was not here, so `cube([PI,1,1])` reported *"variable PI is not
 *  defined here"* — blaming the user for a typo where the truth is that a
 *  language builtin was missing. That lands on the wrong side of the very
 *  distinction this file's header draws between a NAMED refusal and an unknown
 *  name. Probed: OpenSCAD gives `cube(size = [3.14159, 1, 1])`. */
function rootEnv(t = 0, render = false, faFs: { fa: number; fs: number } = { fa: PRINT_FA, fs: PRINT_FS }): Env {
  const env = newEnv(null, null);
  env.vars.set('PI', Math.PI);
  // `$t` is the animation step and is 0 at every non-animated invocation (probed).
  //
  // 🔴 IT IS A PARAMETER RATHER THAN A CONSTANT SINCE 2026-09-09, AND THE
  // DEFAULT IS UNCHANGED. Every existing caller passes nothing and gets 0, so no
  // geometry this lane already produces moves. What it buys is that a source
  // which animates can be evaluated at more than one step — which is the only
  // way to tell an animated design from one that merely MENTIONS `$t`, and the
  // difference matters here: a card claiming an animation that does not move is
  // the same class of defect as a thumbnail of a part the app will not produce.
  //
  // ⚠ IT DOES NOT MAKE THIS AN ANIMATION PLAYER. Nothing in the UI scrubs `$t`;
  // the frames are driven by the external-design verifier, one evaluation per
  // step. Wiring a scrubber is a separate decision and is not implied by this.
  env.vars.set('$t', t);
  // 🔴 `$preview` IS A CHOICE, AND IT IS THE LANE'S EXISTING ONE WRITTEN DOWN.
  // OpenSCAD sets it TRUE in preview (F5, and in `-o csg`) and FALSE in a full
  // render (F6, and in `-o stl`) — probed both ways on 2026.08.07, and the same
  // file exports different geometry through the two. This tab already decided
  // which of the two it is: `mesh.ts`'s entry point does NOT union top-level
  // siblings, *"the same as OpenSCAD preview"*. Choosing `false` here would put
  // one half of this file in F5 and the other in F6.
  //
  // ⚠ The consequence, so it is not discovered later: a source that writes
  // `if ($preview) stand_in(); else real_part();` gets the STAND-IN. In every
  // use of it in `hardware/cad/` today the idiom is `$fn = $preview ? 16 : 48`
  // — resolution, not shape — but that is a fact about today's corpus, not a
  // property of the language. One line to reverse, and the reversal must move
  // the sibling-union rule with it.
  env.vars.set('$preview', !render);
  if (render) {
    env.vars.set('$fa', faFs.fa);
    env.vars.set('$fs', faFs.fs);
  }
  // ⚠ `$vpr`/`$vpt`/`$vpd`/`$vpf`/`$children` are deliberately NOT defined.
  // They describe a camera and a call site this file does not have, and
  // inventing plausible values would silently change any geometry derived from
  // them. Left undefined, they raise an error and draw nothing, which is the
  // direction that cannot cut the wrong part.
  return env;
}

/** What `mesh.ts`'s `rotateExtrudeOutline` revolves a `rotate_extrude` with no `$fn` at (fixed, per full turn). */
export const ROTATE_EXTRUDE_DEFAULT_FN = 48;

/**
 * A `$fn` under `ScadOptions.maxFragments`: lowered to the cap when it asks for more, NEVER raised. A non-finite
 * `$fn` (OpenSCAD's "no answer" = 3) and a `$fn` below the cap pass unchanged. `nullMeans` is what the consumer draws
 * for `null`: `null` for a `$fa`/`$fs` call site (bounded through `$fa` instead, see `capFacets`), or a fixed count.
 */
export function capFn(fn: number | null, cap: number | undefined, nullMeans: number | null): number | null {
  if (cap === undefined) return fn;
  if (fn === null) return nullMeans !== null && nullMeans > cap ? cap : null;
  if (Number.isFinite(fn) && fn > cap) return cap;
  return fn;
}

/**
 * `Facets` under `ScadOptions.maxFragments`. `$fn` is lowered by `capFn`; the `$fa`/`$fs` path
 * (`max(5, ceil(min(360/$fa, 2πr/$fs)))`) is bounded by RAISING `$fa` to just over `360/cap`, which caps the angle
 * term at every radius and only ever removes fragments. The `(1 + 1e-12)` keeps `ceil(360/$fa)` at the cap where
 * `360/cap` is not exact in binary (it is exact for 64 and 32).
 */
export function capFacets(f: Facets, cap: number | undefined): Facets {
  if (cap === undefined) return f;
  return { fn: capFn(f.fn, cap, null), fa: Math.max(f.fa, (360 / cap) * (1 + 1e-12)), fs: f.fs };
}

export function parseScad(src: string, opts: ScadOptions = {}): ScadResult {
  const errors: ScadError[] = [];
  // The lexer has warnings of its own now — a literal that overflows to
  // infinity is dropped or saturated rather than carried, and both are things
  // the reader has to be told. They are collected here and merged with the
  // evaluator's below; the parser gets the same array so an imported file's
  // lexer warnings can be re-attributed to the `include` line.
  const lexWarnings: ScadWarning[] = [];
  const toks = tokenize(src, errors, undefined, lexWarnings);
  const selfPath = opts.path ?? '';
  const parser = new Parser(toks, errors, src, { host: opts.host, count: 0, charged: new Set(), defsMemo: new Map(), defsOpen: new Set() }, selfPath, [selfPath], lexWarnings);
  const program = parser.parseProgram();

  if (opts.maxFragments !== undefined && !(Number.isInteger(opts.maxFragments) && opts.maxFragments >= 5)) {
    // Refused, not rounded: a cap the evaluator cannot honour would be a resolution reported but not drawn.
    throw new RangeError(`maxFragments must be an integer >= 5, got ${opts.maxFragments}`);
  }
  const root = rootEnv(opts.t ?? 0, opts.render ?? false, opts.renderFaFs);
  const ev = new Evaluator();
  ev.host = opts?.host;
  ev.path = opts?.path;
  ev.maxFragments = opts.maxFragments;
  const scene = ev.run(program, root);

  const all = [...errors, ...ev.errors].sort((a, b) => a.line - b.line);
  const unsupported = [...ev.unsupported].sort((a, b) => a.line - b.line);
  const warnings = [...lexWarnings, ...ev.warnings].sort((a, b) => a.line - b.line);
  const console_ = [...ev.console].sort((a, b) => a.line - b.line);

  // Stamped on the ROOT NODE, not merely returned beside it — this is the only
  // copy `meshScene` can reach, and it must not be possible to hand it a tree
  // without it. See `ParseDiagnostics`.
  scene.diagnostics = {
    refusals: unsupported.length,
    errors: all.length,
    warnings: warnings.length,
  };

  return {
    scene,
    unsupported,
    errors: all,
    warnings,
    console: console_,
    counts: countNodes(scene),
  };
}

function countNodes(node: SceneNode): ScadResult['counts'] {
  const counts = { primitives: 0, transforms: 0, booleans: 0, groups: 0 };
  const walk = (n: SceneNode): void => {
    if (n.kind === 'primitive') counts.primitives++;
    else if (n.kind === 'transform') counts.transforms++;
    else if (n.kind === 'boolean') counts.booleans++;
    else counts.groups++;
    if (n.kind !== 'primitive') for (const c of n.children) walk(c);
  };
  walk(node);
  counts.groups--; // the program root is not a construct the user wrote
  return counts;
}

// ---------------------------------------------------------------------------
// Rendering helpers for the UI. Text, not geometry.
// ---------------------------------------------------------------------------

export interface SceneLine {
  depth: number;
  text: string;
  line: number;
  kind: SceneNode['kind'];
}

const fmt = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const fmtVec = (v: number[]): string => `[${v.map(fmt).join(', ')}]`;

/** Whichever of the three controls actually governs this primitive's facets.
 *  `$fa`/`$fs` are shown only when they are doing the work AND are not the
 *  defaults — a tree that prints `$fa 12, $fs 2` on every curve teaches the
 *  reader to skip the field, and then the one line that matters is invisible. */
const facetText = (p: Facets): string => {
  // `!== null` and not truthiness: `$fn` can now be `NaN` (OpenSCAD carries a
  // NaN `$fn` into a 3-segment answer rather than falling to `$fa`/`$fs`), and
  // `NaN` is falsy — so a truthiness test printed the `$fa`/`$fs` line for a
  // primitive whose facets `$fn` had actually decided. `0` cannot reach here:
  // the intake maps it to `null`.
  if (p.fn !== null) return `, $fn ${fmt(p.fn)}`;
  if (p.fa === 12 && p.fs === 2) return '';
  return `, $fa ${fmt(p.fa)}, $fs ${fmt(p.fs)}`;
};

/** One text line per scene node, deepest-last, ready to print with indentation. */
export function sceneLines(node: SceneNode, depth = 0, out: SceneLine[] = []): SceneLine[] {
  out.push({ depth, text: describeNode(node), line: node.line, kind: node.kind });
  if (node.kind !== 'primitive') {
    for (const c of node.children) sceneLines(c, depth + 1, out);
  }
  return out;
}

export function describeNode(n: SceneNode): string {
  switch (n.kind) {
    case 'primitive': {
      const p = n.params;
      switch (p.kind) {
        case 'cube':
          return `cube size ${fmtVec(p.size)} mm${p.center ? ', centered' : ''}`;
        case 'sphere':
          return `sphere r ${fmt(p.r)} mm${facetText(p)}`;
        case 'cylinder':
          return `cylinder h ${fmt(p.h)} mm, r1 ${fmt(p.r1)} mm, r2 ${fmt(p.r2)} mm${
            p.center ? ', centered' : ''
          }${facetText(p)}`;
        case 'square':
          return `square size ${fmtVec(p.size)} mm${p.center ? ', centered' : ''} (2D)`;
        case 'circle':
          return `circle r ${fmt(p.r)} mm${facetText(p)} (2D)`;
      }
      return 'primitive';
    }
    case 'transform':
      return n.op === 'rotate'
        ? `rotate ${fmtVec(n.v)} deg`
        : `${n.op} ${fmtVec(n.v)}${n.op === 'translate' ? ' mm' : ''}`;
    case 'boolean':
      return `${n.op} of ${n.children.length} (represented, NOT computed)`;
    case 'group':
      return `${n.label} of ${n.children.length}`;
  }
}
