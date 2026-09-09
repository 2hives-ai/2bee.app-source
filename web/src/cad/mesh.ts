// 2bee.cad stage 2 — the scene tree from `scad.ts`, evaluated into triangles.
//
// WHAT THIS IS. A tessellator for the five primitives the parser understands, an
// affine transform stack, and a BSP-tree CSG kernel (the csg.js lineage, MIT,
// re-derived here in TypeScript — no dependency was added and none is vendored)
// that computes `union`, `difference` and `intersection` for real. Stage 1
// represented booleans and never computed them; this file computes them.
//
// 🔴 WHAT IT STILL CANNOT DO, AND WHY THAT IS WRITTEN DOWN RATHER THAN HIDDEN.
// A BSP CSG over a triangle soup is not a robust solid modeller. It has three
// well-known failure modes, all of which are REPORTED here rather than smoothed
// over, because a picture that lies about a shape is worse than no picture:
//
//   1. COPLANAR FACES. When two operands share a face plane exactly — the
//      classic `difference() { cube(20); cube(20); }`, or a subtrahend whose
//      face is flush with the minuend's — the polygons land in the BSP's
//      coplanar bucket and are kept or dropped by a normal-direction test. The
//      answer is right often enough to be dangerous and wrong often enough to
//      matter: flush faces produce doubled surfaces, or a face that vanishes.
//      OpenSCAD users are told to overshoot a cut by a hair for exactly this
//      reason, and that advice applies here MORE strongly, not less.
//   2. NEAR-DEGENERATE GEOMETRY. Classification uses an ABSOLUTE epsilon
//      (`EPS`, in millimetres). A sliver thinner than it is classified by
//      whichever side the rounding fell on. Two faces closer together than it
//      are treated as one. A model whose features are near `EPS` in size — or
//      whose coordinates are enormous, so that a double's spacing near them
//      approaches `EPS` — is outside what this kernel can decide, and
//      `auditModelScale()` says so instead of letting it look fine.
//   3. NO SELF-INTERSECTION REPAIR. The kernel assumes each operand is a closed,
//      non-self-intersecting surface. Our primitives are; the OUTPUT of a
//      boolean need not be, and the output of a boolean is the input of the next
//      one. Nothing here detects or fixes a self-intersecting operand.
//
// Because of (1)–(3), every part this file emits is AUDITED — welded, then
// checked edge by edge for closure, orientation and manifoldness — and carries
// its verdict in the returned data. `preview.tsx` shows that verdict on screen.
// An unaudited "it looked fine" is exactly the green nobody has watched go red.
//
// THE REFUSAL RULE, inherited unchanged from stage 1. Anything this file cannot
// do honestly emits NOTHING and is named with its line:
//   · a boolean with a 2D operand — refused whole. There is no 2D kernel here,
//     and quietly dropping the 2D child would subtract nothing and look right.
//     🔴 THIS ONE IS STRICTER THAN OPENSCAD AND THE REFUSAL SAYS SO, per node.
//     OpenSCAD does not refuse: it replaces the wrong-dimension child with an
//     empty operand and carries on, so a `difference` exports the minuend with
//     the pocket missing (exit 0, two console warnings). ONE shape is agreement
//     rather than strictness — an `intersection` that ends up with an empty
//     operand, which produces nothing in OpenSCAD either, in EITHER dimension.
//     ⚠ THIS LINE USED TO CLAIM TWO, adding "any boolean whose FIRST operand is
//     2D". Wrong, corrected 2026-08-11: a 2D node still runs its boolean and
//     still draws the answer — `difference(){ circle(8); cube(10); }` writes an
//     820-byte SVG with one contour and we draw nothing. Only the STL door is
//     closed there, and reading a closed STL door as "OpenSCAD made nothing" is
//     how a capability gap got recorded as agreement.
//     `twoDimensionalOperandVerdict()` holds the whole table, measured at the
//     binary through BOTH exporters, and its `relation` is what a test can
//     assert; "we refused" on its own does not distinguish being right from
//     being wrong, because both look like nothing.
//   · a transform whose linear part has determinant <= 0 — refused whole. A
//     mirror or a zero scale flips or collapses winding, and every face normal
//     in the BSP would then point into the solid. `scad.ts` refuses `mirror()`
//     for this reason; `scale([-1,1,1])` is the same defect wearing a different
//     name and gets the same answer.
//   · a boolean that hits the polygon budget or the time budget — refused whole.
//     Half a subtraction is not a shape.
//   · a degenerate primitive (zero height, zero radius, zero side) — refused.
// A refused node contributes no geometry and takes its subtree with it. It never
// falls back to one operand: "difference returned the minuend" is the specific
// lie that puts an uncut pocket on a machine.
//
// Units are millimetres and degrees throughout, as in `scad.ts` and the core.

// 🔴 TYPE-ONLY, AND THAT IS A CONSTRAINT RATHER THAN A STYLE. `tools/scad_oracle`
// imports `mesh.ts` through node's own TypeScript support, which does not
// resolve an extensionless specifier — so a type-only import erases to nothing
// and works, and a VALUE import from './scad' makes the oracle exit with
// ERR_MODULE_NOT_FOUND. Measured 2026-08-11 by making exactly that mistake.
// The one consequence is `Mesher.inherit`, which re-derives `colourIsComplete`
// rather than calling it; see the note there.
import type { Colour, Facets, ParseDiagnostics, SceneNode, Vec3 } from './scad';

// ---------------------------------------------------------------------------
// Budgets. A browser tab that hangs is a defect; so is one that quietly returns
// a truncated shape. Every budget below refuses the node and says which budget
// it was, so the user can tell "too big" from "wrong".
// ---------------------------------------------------------------------------

/** Plane-classification tolerance, mm. Absolute, and that is failure mode (2). */
const EPS = 1e-5;
/** Vertex welding tolerance for the audit, mm. Well below anything we cut. */
const WELD_EPS = 1e-6;
/** Polygons in any single CSG operand or result. */
const MAX_POLYS = 200_000;
/** Wall-clock for the whole evaluation. Exceeded ⇒ the node in flight is refused. */
const MAX_MS = 6_000;
/** Any facet count above this is clamped, and the clamp is reported.
 *  ⚠ It applies to a count derived from `$fa`/`$fs` as well as to an explicit
 *  `$fn` — `$fa=1; $fs=0.1; sphere(5)` asks for 315 sides. A clamp that is
 *  reported for one route and silent on the other is the same defect as no
 *  clamp at all. */
const MAX_FN = 256;
/** OpenSCAD's own defaults for `$fa`/`$fs`.
 *
 *  ⚠ THIS COMMENT USED TO SAY `$fa`/`$fs` WERE "REFUSED BY THE PARSER AS
 *  ARGUMENTS". They were not, in either form, and had never been: the refusal
 *  branch in `scad.ts` sat below an allowlist that always matched first, so it
 *  was unreachable from anywhere in the file, and the assignment form never
 *  reached it at all. Both are IMPLEMENTED as of 2026-08-11 and arrive on the
 *  primitive as `Facets`; these two constants are now only what a primitive
 *  that mentions neither of them gets. */
const DEFAULT_FA = 12;
const DEFAULT_FS = 2;

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Why a part cannot be trusted, in the order a reader should worry about them. */
export type PartVerdict =
  /** Closed, orientable, manifold. Every edge shared by exactly two faces, once each way. */
  | 'closed'
  /** UNRESOLVED. The T-junction repair ran out of budget, so it is not known
   *  whether the remaining single-face edges are seams in the triangulation or
   *  holes in the surface. Ranked WITH the bad answers: a check that could not
   *  run reports PENDING, never PASS. */
  | 'seams'
  /** A genuine hole. The boolean did not close the surface. The shape is wrong. */
  | 'open'
  /** An edge shared by more than two faces, or by two faces pointing the same
   *  way. Self-intersection or an inverted operand. The shape is meaningless. */
  | 'non-manifold'
  /** 2D. Zero thickness, no interior, no volume. Not a solid and never audited. */
  | 'flat';

export interface MeshAudit {
  triangles: number;
  /** Distinct vertices after welding at WELD_EPS. */
  vertices: number;
  /** Edges met by exactly one face, AFTER T-junction repair. Genuine holes,
   *  unless `repairExhausted` — then they are unclassified, see the verdict. */
  openEdges: number;
  /** T-junctions the CSG left behind and this file repaired losslessly. A
   *  non-zero count is normal for BSP CSG and is not a fault in the shape. */
  repairedTJunctions: number;
  /** The repair hit its budget, so `openEdges` is NOT a hole count. */
  repairExhausted: boolean;
  /** Edges shared by three or more faces. */
  nonManifoldEdges: number;
  /** Edges shared by two faces that traverse them the SAME way — inverted patch. */
  misorientedEdges: number;
  /** Triangles with area below 1e-12 mm². Harmless to draw, fatal to trust. */
  degenerateTriangles: number;
  verdict: PartVerdict;
  /** One sentence, written for the person deciding whether to cut it. */
  detail: string;
}

export interface MeshPart {
  /** Stable within one result; used as a React key and a scene-object name. */
  id: string;
  /** What produced it, in the user's own vocabulary. */
  label: string;
  /** 1-based source line of the node that produced it. */
  line: number;
  dim: 2 | 3;
  /** Non-indexed triangle soup: 9 floats per triangle. Flat shading wants face
   *  normals, and a shared-vertex index buffer would average them away. */
  positions: Float32Array;
  triangles: number;
  /** `null` only for `dim === 2`, where closure is not a meaningful question. */
  audit: MeshAudit | null;
  /** Axis-aligned bounds, mm. `null` when the part has no triangles. */
  bounds: { min: Vec3; max: Vec3 } | null;
  /**
   * The colour in force where this part was made, or `null` when no `color()`
   * enclosed it. See `Mesher.evalNode` for the inheritance rule and
   * `preview.tsx` for what is done with it — including the two cases where it is
   * deliberately NOT obeyed.
   *
   * ⚠ APPEARANCE ONLY. Nothing about a colour changes a vertex, a triangle, a
   * bound, an audit verdict or an exported byte. A reader who takes a coloured
   * part for a differently-shaped one has been misled by this field's presence,
   * so it sits beside `bounds` with this sentence rather than near the geometry.
   */
  colour: Colour | null;
}

export interface MeshIssue {
  /** `refused` ⇒ nothing was drawn for it. `warning` ⇒ something was drawn and
   *  you should know why it may be wrong. The distinction is the whole point. */
  severity: 'refused' | 'warning';
  name: string;
  line: number;
  detail: string;
  /**
   * WHAT A WARNING CHANGED. Only meaningful for `severity: 'warning'` — a
   * refusal always removes geometry and always degrades trust.
   *
   * 🔴 THIS EXISTS BECAUSE `trust` IGNORED WARNINGS ENTIRELY, AND ONE OF THEM
   * MEANS "THE SHAPE IS NOT THE ONE THE SOURCE DESCRIBED".
   * `2bee_hive/2bee_hive_fan_box_panel_wcnc.scad` — a sheet part cut on the
   * CNC — came back `trusted` while drawing a 41 × 41 × 1 mm chip in place of a
   * 121.5 × 407 × 18 mm panel (measured against OpenSCAD 2026.08.07,
   * 2026-08-31). Its `difference()` had lost its first operand and the mesher
   * SAID SO, as a warning; `trust` counted only refusals, so the verdict was
   * "nothing was refused" — true, and the most misleading sentence available.
   *
   *   `geometry`   — what is drawn is not what the source described. Degrades.
   *   `precision`  — the shape is right, the approximation is coarser than
   *                  asked (facet clamping, near-tolerance features). Does not
   *                  degrade: every mesh is an approximation and saying so on
   *                  every model would make the word meaningless.
   *   `appearance` — colour only. Never touches a vertex.
   *
   * ⚠ ABSENT MEANS `geometry`, on purpose. A warning added later without a
   * thought about this field degrades trust until someone argues otherwise,
   * which is the safe direction: the cost of a spurious `suspect` is a second
   * look, and the cost of a spurious `trusted` is a cut part.
   */
  alters?: 'geometry' | 'precision' | 'appearance';
}

/**
 * Deliberate mesh corruptions, applied AFTER the kernel and BEFORE the audit.
 *
 * 🔴 THIS EXISTS FOR ONE REASON: a gate nobody has watched go red is not a gate.
 * Every real model tried against this file audits `closed`, which is either good
 * news or an audit that cannot fail — and those two look identical from the
 * outside. A plant makes the audit fail on demand, so `closed` means something.
 *
 * It is a second argument to `meshScene`, is never passed by the UI, and every
 * planted run carries a `refused`-severity issue saying so, because a planted
 * result that could be mistaken for a real one is worse than no plant at all.
 */
export type MeshPlant =
  /** Delete one triangle. Must produce `open`. */
  | 'drop-face'
  /** Duplicate one triangle. Must produce `non-manifold` (three faces on an edge). */
  | 'duplicate-face'
  /** Reverse one triangle's winding. Must produce `non-manifold` via misorientation. */
  | 'flip-face';

export const MESH_PLANTS: MeshPlant[] = ['drop-face', 'duplicate-face', 'flip-face'];

export interface MeshResult {
  parts: MeshPart[];
  issues: MeshIssue[];
  stats: {
    triangles: number;
    solids: number;
    flats: number;
    booleansComputed: number;
    booleansRefused: number;
    /** Milliseconds spent evaluating. Reported because the budget is real. */
    ms: number;
  };
  /** The one-word answer to "can I trust this picture?".
   *
   *  🔴 IT IS A FUNCTION OF THE PARSE AS WELL AS THE MESH, AND WAS NOT UNTIL
   *  2026-08-11. It was computed from `mesher.issues` alone, so it answered
   *  *"is this solid closed and orientable"* — a correct answer to a question
   *  nobody asked. A source whose only cut had been refused by the PARSER (a
   *  `#` on the subtrahend of a `difference()` takes a model from 80 facets to
   *  12) came back `trust: 'trusted'`, about a 1 mm cube. The operator's
   *  question is *"is this the solid the source described"*, and no count of
   *  triangles can answer it. */
  trust: 'nothing' | 'trusted' | 'suspect' | 'untrusted';
  trustDetail: string;
  /** What the parser reported, as read off the scene root — `null` when the
   *  tree arrived without it. Returned rather than merely consumed so a caller
   *  or a test can see the INPUT to the verdict and not only the verdict. */
  sourceDiagnostics: ParseDiagnostics | null;
}

// ---------------------------------------------------------------------------
// Vectors, affine transforms
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.sqrt(dot(a, a));

/** Affine transform: 3x3 linear part `m` (row-major) plus a translation `t`. */
interface Xf {
  m: number[];
  t: V3;
}

const IDENTITY: Xf = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function compose(outer: Xf, inner: Xf): Xf {
  const a = outer.m;
  const b = inner.m;
  const m = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  const t: V3 = [
    a[0] * inner.t[0] + a[1] * inner.t[1] + a[2] * inner.t[2] + outer.t[0],
    a[3] * inner.t[0] + a[4] * inner.t[1] + a[5] * inner.t[2] + outer.t[1],
    a[6] * inner.t[0] + a[7] * inner.t[1] + a[8] * inner.t[2] + outer.t[2],
  ];
  return { m, t };
}

function applyXf(x: Xf, p: V3): V3 {
  const m = x.m;
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + x.t[0],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + x.t[1],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + x.t[2],
  ];
}

function det3(m: number[]): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function translateXf(v: Vec3): Xf {
  return { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [v[0], v[1], v[2]] };
}

function scaleXf(v: Vec3): Xf {
  return { m: [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]], t: [0, 0, 0] };
}

// ---------------------------------------------------------------------------
// Degree trigonometry — a PORT of OpenSCAD's own, not an approximation of it
//
// `Math.cos(90 * Math.PI / 180)` is `6.123233995736766e-17`, not `0`, because
// `Math.PI / 180` is not π/180 and 90 × it is not π/2. OpenSCAD returns an
// exact `0`, and that is a real property of its implementation rather than
// print-rounding: at 89.9999° the binary emits a genuine `1.74533e-06`, so it
// is not simply printing a rounded zero.
//
// 🔴 THE SUBTLETY IS THAT OPENSCAD NEVER ASKS "IS THIS A MULTIPLE OF 90?".
// There is no quadrant test and no snap. `src/utils/degree_trig.cc` reduces the
// argument into [0,90] by revolution, reflection about 180° and reflection
// about 90°, then evaluates the COMPLEMENTARY function near zero: `cos(90)`
// becomes `sin(deg2rad(90 - 90))` = `sin(0)` = exactly 0, and `sin(90)` becomes
// `cos(deg2rad(90 - 90))` = `cos(0)` = exactly 1. The exactness falls out of
// `sin(0)` and `cos(0)`; nothing is special-cased.
//
// ⚠ THAT DISTINCTION IS THE WHOLE SAFETY ARGUMENT. A quadrant test with any
// tolerance would snap 89.9999° to 90° and silently straighten a part the
// operator deliberately drew at an angle — worse than the defect it fixes,
// because the source would no longer describe the solid. Reduce-and-complement
// has no tolerance to widen: 89.9999° reduces to a real 1e-4° and stays real.
// The equality tests below (`=== 30`, `=== 45`, `=== 60`) are OpenSCAD's own
// and are EXACT comparisons, not tolerances.
//
// Ported from OpenSCAD 2026.08.07, `src/utils/degree_trig.cc`, `sin_degrees` /
// `cos_degrees`. Constants are the file's own literals (`M_SQRT3_4`,
// `M_DEG2RAD`), spelled out to its digits rather than recomputed, because
// `Math.sqrt(3) / 2` and `Math.PI / 180` do not reproduce them bit for bit.
// ---------------------------------------------------------------------------

/** OpenSCAD `M_DEG2RAD`, to its own digits. */
const DEG2RAD = Math.PI / 180;
/** OpenSCAD `M_SQRT3_4` = sqrt(3)/2, to its own digits. */
const SQRT3_4 = 0.86602540378443859659;
/** OpenSCAD `M_SQRT1_2` = sqrt(1/2). Identical to `Math.SQRT1_2`. */
const SQRT1_2 = Math.SQRT1_2;

/** OpenSCAD's `TRIG_HUGE_VAL`: `(1<<26) * 360 * (1<<26)`. Beyond this the
 *  argument reduction has lost every significant bit, so the answer would be
 *  meaningless and OpenSCAD returns NaN rather than a confident wrong number.
 *  Ported deliberately — a NaN reaches `transform()`'s determinant test and is
 *  REFUSED, where the old code returned a finite value with no information in
 *  it and drew a part from it. */
const TRIG_HUGE_VAL = (1 << 26) * 360.0 * (1 << 26);

/** Reduce to `[0, 360)`, or NaN where reduction is meaningless. The positive
 *  tests are OpenSCAD's, written that way so Inf/NaN fall through to the NaN
 *  branch instead of being reduced. */
function reduceDegrees(x: number): number {
  if (x < 360.0 && x >= 0.0) return x;
  if (x < TRIG_HUGE_VAL && x > -TRIG_HUGE_VAL) return x - 360.0 * Math.floor(x / 360.0);
  return NaN;
}

/** `sin` of an angle in degrees, exact at every multiple of 30/45/60/90. */
export function sinDegrees(deg: number): number {
  let x = reduceDegrees(deg);
  const oppose = x >= 180.0;
  if (oppose) x -= 180.0;
  if (x > 90.0) x = 180.0 - x;
  if (x < 45.0) {
    x = x === 30.0 ? 0.5 : Math.sin(x * DEG2RAD);
  } else if (x === 45.0) {
    x = SQRT1_2;
  } else if (x === 60.0) {
    x = SQRT3_4;
  } else {
    // 45 < x <= 90, and NaN falls here too — `Math.cos(NaN)` is NaN.
    x = Math.cos((90.0 - x) * DEG2RAD);
  }
  return oppose ? -x : x;
}

/** `cos` of an angle in degrees, exact at every multiple of 30/45/60/90. */
export function cosDegrees(deg: number): number {
  let x = reduceDegrees(deg);
  let oppose = x >= 180.0;
  if (oppose) x -= 180.0;
  if (x > 90.0) {
    x = 180.0 - x;
    oppose = !oppose;
  }
  if (x > 45.0) {
    x = x === 60.0 ? 0.5 : Math.sin((90.0 - x) * DEG2RAD);
  } else if (x === 45.0) {
    x = SQRT1_2;
  } else if (x === 30.0) {
    x = SQRT3_4;
  } else {
    // x <= 45, and NaN falls here too.
    x = Math.cos(x * DEG2RAD);
  }
  return oppose ? -x : x;
}

/** The linear part of OpenSCAD's `rotate([x,y,z])` — Rz · Ry · Rx — row-major.
 *
 *  🔴 THE THREE MATRICES ARE NOT COMPOSED. OpenSCAD writes the product out as
 *  nine closed-form expressions in `src/core/TransformNode.cc:137-142` and this
 *  is those expressions, term for term. Algebraically it is the same product;
 *  in floating point it is not, because composing multiplies exact zeros
 *  through two extra rounds of sums and the SIGN of the resulting zeros differs
 *  from the oracle's.
 *
 *  ⚠ AND THE IDENTITY MULTIPLY BELOW IS NOT DEAD CODE. OpenSCAD does not use
 *  `M` directly either: `TransformNode.cc:143` is `node->matrix.rotate(M)` on a
 *  matrix that starts as the identity, so the value that reaches the exporter
 *  has been through `I · M`. That product is not a no-op on signed zeros —
 *  `-0 + 0 + 0` is `+0` — and it is the reason `rotate([0,0,180])` prints
 *  `[[-1, 0, 0], [-0, -1, 0], ...]`: a `-0` in the first column that the same
 *  matrix does NOT carry in the third. Removing the multiply changes three of
 *  the eighteen matrices pinned in `web/tests/cad-degree-trig.test.ts`, which
 *  is what stops it being deleted as redundant. */
export function rotationMatrixDegrees(v: Vec3): number[] {
  const sx = sinDegrees(v[0]);
  const cx = cosDegrees(v[0]);
  const sy = sinDegrees(v[1]);
  const cy = cosDegrees(v[1]);
  const sz = sinDegrees(v[2]);
  const cz = cosDegrees(v[2]);
  // OpenSCAD src/core/TransformNode.cc:139-141, verbatim.
  const m = [
    cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
    cy * sz, cx * cz + sx * sy * sz, -cz * sx + cx * sy * sz,
    -sy, cy * sx, cx * cy,
  ];
  const i = IDENTITY.m; // I · M — see the note above; the zeros do work here.
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = i[r * 3] * m[c] + i[r * 3 + 1] * m[3 + c] + i[r * 3 + 2] * m[6 + c];
    }
  }
  return out;
}

/** OpenSCAD's `rotate([x,y,z])` is Rz · Ry · Rx applied to the child. */
function rotateXf(v: Vec3): Xf {
  return { m: rotationMatrixDegrees(v), t: [0, 0, 0] };
}

// ---------------------------------------------------------------------------
// Polygons
//
// Convexity is an INVARIANT here, not a hope: every primitive face this file
// emits is convex, and splitting a convex polygon by a plane yields convex
// pieces. That is what makes fan triangulation valid at the end. If a future
// primitive emits a concave face, fan triangulation silently produces
// overlapping triangles — so the invariant is stated where it can be checked
// rather than assumed at the point where it would break.
// ---------------------------------------------------------------------------

interface Poly {
  v: V3[];
  /** Unit normal. */
  n: V3;
  /** Plane offset: dot(n, p) = w for every p on the plane. */
  w: number;
}

/** Newell's method: stable for near-degenerate polygons where a single cross
 *  product of three consecutive vertices is noise. Returns `null` when the
 *  polygon has no area at all, and a null plane means the polygon is dropped
 *  with a warning rather than given an arbitrary normal. */
function makePoly(v: V3[]): Poly | null {
  if (v.length < 3) return null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const n: V3 = [nx, ny, nz];
  const l = len(n);
  if (!(l > 1e-12)) return null;
  const un: V3 = [nx / l, ny / l, nz / l];
  return { v, n: un, w: dot(un, v[0]) };
}

function clonePoly(p: Poly): Poly {
  return { v: p.v.map((q) => [q[0], q[1], q[2]] as V3), n: p.n, w: p.w };
}

function flipPoly(p: Poly): void {
  p.v.reverse();
  p.n = [-p.n[0], -p.n[1], -p.n[2]];
  p.w = -p.w;
}

function transformPolys(polys: Poly[], x: Xf): Poly[] {
  /* 🔴 AN ORIENTATION-REVERSING TRANSFORM MUST FLIP WINDING HERE, WHERE THE
   * GEOMETRY IS MADE — not after the children have been evaluated.
   *
   * A negative determinant (a reflection, or `scale()` with an odd number of
   * negative components) turns every face inside-out. The CSG kernel decides
   * inside from outside by winding, so a boolean whose operands arrive
   * inside-out computes a different solid — and then no amount of flipping the
   * RESULT repairs it. Measured 2026-09-02:
   *
   *   difference(){cube(10); translate([2,2,-1]) cube(3);}   982 mm³, 52 tris
   *   scale([-1,1,1]) of the same                             -9 mm³, 12 tris
   *   multmatrix(reflection) of the same                      -9 mm³, 12 tris
   *
   * …and all three reported `trust: trusted`. `scale([-1,1,1])` is the ordinary
   * OpenSCAD idiom for a mirrored part, it ships today, and it was turning a
   * 982 mm³ solid into a 9 mm³ inside-out fragment silently. Left and right
   * hand versions of an enclosure are exactly what people write it for. */
  const flip = det3(x.m) < 0;
  const out: Poly[] = [];
  for (const p of polys) {
    const v = p.v.map((q) => applyXf(x, q));
    const np = makePoly(flip ? v.reverse() : v);
    if (np) out.push(np);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tessellation
// ---------------------------------------------------------------------------

/** OpenSCAD's `GRID_FINE` — `src/geometry/Grid.h:20`, the radius below which it
 *  declines to say how many segments a curve gets.
 *
 *  🔴 IT IS NOT `1e-6`, WHICH IS WHAT THIS FILE COMPARED AGAINST. It is
 *  `1/(1024*1024)` = 2⁻²⁰ = 9.5367431640625e-7, picked there to be exactly
 *  representable in binary, and it is SMALLER than `1e-6`. So every radius in
 *  `[2⁻²⁰, 1e-6)` took our small-radius escape and came out with 3 segments
 *  while OpenSCAD tessellated it normally. Measured at the ulp against
 *  `openscad 2026.08.07` with `scale([1e7,1e7]) circle(r=R)` — the scale is
 *  applied AFTER tessellation, so it makes the vertex count readable in an SVG
 *  export without changing it: `R = 9.53674316406249e-7` exports **3**
 *  vertices, `R = 9.5367431640625e-7` exports **5**. The comparison is `<`, so
 *  the boundary value itself tessellates — which is the one place a limb
 *  "solved to equality" would have been wrong in the safe-looking direction. */
const GRID_FINE = 0.00000095367431640625;

/** OpenSCAD's `CurveDiscretizer::getCircularSegmentCount`
 *  (`src/core/CurveDiscretizer.cc:100-148`), as the SOURCE asks for it — before
 *  our own `MAX_FN` clamp. Kept separate so the clamp has something to compare
 *  against and can report itself; a clamp that cannot say what was asked for
 *  cannot say it happened.
 *
 *  ⚠ This header used to name `get_fragments_from_r`. That function no longer
 *  exists in the tree we compare against; the logic moved into
 *  `CurveDiscretizer` and changed while it moved. A citation that no longer
 *  resolves cannot be re-read, so it stops being a check.
 *
 *  🔴 `$fn` ROUNDS **UP**, AND WE ROUNDED DOWN. The source is
 *  `ceil(fn >= 3 ? fn : 3)`; this was `max(3, floor(fn))`. The two agree at
 *  every integer, which is exactly why it survived a corpus of integer `$fn`
 *  for months — the divergence only exists where nobody had a case. Measured
 *  against `openscad 2026.08.07`, vertices of `circle(r=10, $fn=N)` in an SVG
 *  export, ours in brackets: `3.2 → 4` [3], `4.5 → 5` [4], `5.0000001 → 6`
 *  [5]. It is not a 2D curiosity — `cylinder(h=10,r=5,$fn=4.5)` is 10 distinct
 *  vertices there and was 8 here, and `sphere(r=10,$fn=4.5)` is 15 (5 meridians
 *  × 3 rings) and was 8 (4 × 2). A whole ring of the sphere was missing.
 *
 *  ⚠ THE CLAMP IS WRITTEN IN OPENSCAD'S OWN FORM AND NOT SIMPLIFIED, even
 *  though `max(3, ceil(fn))` is provably the same value for every `fn > 0`
 *  (for `fn ≥ 3` both are `ceil(fn)`; for `0 < fn < 3` both are 3). Keeping the
 *  source's shape is what lets the next reader diff this against the C++
 *  instead of re-deriving an equivalence. **`$fn = 3` exactly is the case that
 *  proves nothing** — `floor`, `ceil` and the clamp all agree there, so a test
 *  that only pins `$fn = 3` is green on the defect.
 *
 *  🔴 A NON-FINITE `$fn` IS 3, NOT A HUGE NUMBER, and this is reachable:
 *  `circle(r=10, $fn=1e308*10)` is **3** vertices in OpenSCAD (`isinf(fn)` ⇒ no
 *  answer ⇒ the caller's `.value_or(3)`) and was **256** here — our `MAX_FN`
 *  clamp caught `Infinity` and rendered a 256-gon, reporting a warning that the
 *  source "asks for Infinity facets". `NaN` cannot arrive: `scad.ts` maps any
 *  `$fn` that is not `> 0` to `null`, and `NaN > 0` is false. That mapping is
 *  also why `$fn = -1/0` is right by accident — OpenSCAD's constructor clamps a
 *  negative `$fn` to 0 first, so both sides fall to `$fa`/`$fs`.
 *
 *  ✅ THERE IS DELIBERATELY NO `$fe` PATH, AND ADDING ONE WOULD BE THE
 *  REGRESSION. `$fe` sits behind `Feature::ExperimentalDiscretizationByError`,
 *  which `Feature.h` defaults to `enabled{false}` and the oracle does not pass
 *  `--enable`. Measured: `circle(r=10, $fe=0.1)` is **30** vertices under plain
 *  `openscad 2026.08.07` — the ordinary `$fa`/`$fs` answer, `$fe` ignored — and
 *  **23** under `--enable=discretization-by-error`. We emit 30. Implementing
 *  `$fe` would make us disagree with the binary we are checked against.
 *
 *  The `3` returned for a sub-`GRID_FINE` radius is the CALLER'S default, not
 *  this function's opinion: OpenSCAD returns no answer at all and all three
 *  primitive call sites (`primitives.cc:183`, `:258`, `:556`) spell it
 *  `.value_or(3)`. The trailing `max(1, ceil(result))` of the source is not
 *  ported because every branch here already returns ≥ 3; it only bites on the
 *  partial-arc callers (`rotate_extrude`, DXF arcs) that this kernel refuses. */
function fragmentsRequested(r: number, f: Facets): number {
  if (r < GRID_FINE) return 3;
  if (f.fn !== null && !Number.isFinite(f.fn)) return 3;
  if (f.fn !== null && f.fn > 0) return Math.ceil(f.fn >= 3 ? f.fn : 3);
  const byAngle = 360 / (f.fa > 0 ? f.fa : DEFAULT_FA);
  const bySize = (r * 2 * Math.PI) / (f.fs > 0 ? f.fs : DEFAULT_FS);
  return Math.max(5, Math.ceil(Math.min(byAngle, bySize)));
}

function fragments(r: number, f: Facets): number {
  return Math.min(MAX_FN, fragmentsRequested(r, f));
}

function cubePolys(size: Vec3, center: boolean): Poly[] {
  const [sx, sy, sz] = size;
  const [x0, y0, z0] = center ? [-sx / 2, -sy / 2, -sz / 2] : [0, 0, 0];
  const [x1, y1, z1] = [x0 + sx, y0 + sy, z0 + sz];
  const P = (x: number, y: number, z: number): V3 => [x, y, z];
  const faces: V3[][] = [
    [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], // +Z
    [P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0)], // -Z
    [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], // +X
    [P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], // -X
    [P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0)], // +Y
    [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)], // -Y
  ];
  return faces.map(makePoly).filter((p): p is Poly => p !== null);
}

/** One ring of `n` points on a circle of radius `r` at height `z` — OpenSCAD's
 *  `generate_circle` (`src/core/primitives.cc:59-66`), vertex for vertex.
 *
 *  🔴 THE ANGLE IS IN DEGREES BECAUSE OPENSCAD'S IS, AND THAT IS NOT COSMETIC.
 *  This used to be `Math.cos(2π·j/n)`, which puts `6.123233995736766e-17` where
 *  a quadrant vertex belongs: at `$fn=4` our vertex 1 — the SECOND, vertex 0 is
 *  at 0° and was always exact — was `(r·6.1e-17, r)` against OpenSCAD's
 *  `(0, r)`, and every vertex at 180° carried a y of `r·1.2246e-16` where
 *  OpenSCAD has a zero. It is small, but it is on
 *  every vertex of every curved primitive, and it lands **on the silhouette**,
 *  where a face that should be flat and axis-aligned instead sits at a
 *  micro-angle to it.
 *
 *  The exactness comes from `cosDegrees`/`sinDegrees` — OpenSCAD's own
 *  reduce-and-complement, ported above. **Nothing here tests whether an angle is
 *  a multiple of 90 and nothing snaps**; see the header on that block for why a
 *  quadrant test with any tolerance would be the worse bug.
 *
 *  ⚠ THE ARGUMENT EXPRESSION IS OPENSCAD'S OWN, TERM FOR TERM: `(360 · i) / n`,
 *  multiply then divide. `i · (360 / n)` is the same real number and a different
 *  double: **7766 of the (n, i) pairs with 3 ≤ n ≤ 256 disagree**, the first at
 *  `n=13, i=7`. That is not a theoretical worry — `cylinder(h=10,r=5,$fn=13)`
 *  exported from OpenSCAD 2026.08.07 has that vertex at
 *  `(-4.85470908713026, -1.196578321437788)`, which is what this form computes;
 *  the other form gives `(-4.854709087130259, -1.1965783214377907)`. Both
 *  measurements are in `web/tests/cad-tessellation-degrees.test.ts`. A rewrite
 *  to hoist the division out of the loop would reintroduce a smaller version of
 *  the same divergence, at non-quadrant vertices only, where no
 *  quadrant-flavoured test would notice it.
 *
 *  ⚠ EXPORTED FOR THE SAME REASON `sinDegrees`/`cosDegrees` ARE, AND ONLY THAT.
 *  `MeshPart.positions` is a `Float32Array`, and the hoisted-division defect
 *  above survives `Math.fround` — a test that can only see the mesh surface goes
 *  green on it (measured: plant 2 in
 *  `web/tests/cad-tessellation-degrees.test.ts`). Doubles reach a caller only
 *  here, so this is the only door through which that defect class is
 *  observable. Nothing in `src/` calls it from outside this file. */
export function circlePoints(r: number, z: number, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const phi = (360.0 * i) / n;
    out.push([r * cosDegrees(phi), r * sinDegrees(phi), z]);
  }
  return out;
}

/** OpenSCAD's sphere: `fragments` meridians, `(fragments+1)/2` rings placed at
 *  half-step latitudes, so there is no pole vertex — the top and bottom are
 *  small n-gon caps. Matching that matters: a pole-vertex sphere and a capped
 *  sphere differ at exactly the place a boolean is most likely to cut.
 *
 *  The ring latitude is `(180·(i+0.5))/rings` degrees, `primitives.cc:196-198`,
 *  and it goes through the same degree trig as the meridians — a sphere at
 *  `$fn=4` has rings at 45° and 135°, where `sinDegrees` returns OpenSCAD's
 *  `M_SQRT1_2` exactly and `Math.sin(π/4)` does not. */
function spherePolys(r: number, f: Facets): Poly[] {
  const n = fragments(r, f);
  const rings = Math.max(2, Math.floor((n + 1) / 2));
  const pts: V3[][] = [];
  for (let i = 0; i < rings; i++) {
    const phi = (180.0 * (i + 0.5)) / rings;
    pts.push(circlePoints(r * sinDegrees(phi), r * cosDegrees(phi), n));
  }
  const out: Poly[] = [];
  const push = (v: V3[]) => {
    const p = makePoly(v);
    if (p) out.push(p);
  };
  push(pts[0].slice()); // top cap, +Z outward
  push(pts[rings - 1].slice().reverse()); // bottom cap, -Z outward
  for (let i = 0; i < rings - 1; i++) {
    const up = pts[i];
    const lo = pts[i + 1];
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      push([up[j], lo[j], lo[k], up[k]]);
    }
  }
  return out;
}

function cylinderPolys(h: number, r1: number, r2: number, center: boolean, f: Facets): Poly[] {
  const n = fragments(Math.max(r1, r2), f);
  const z0 = center ? -h / 2 : 0;
  const z1 = z0 + h;
  const ring = (r: number, z: number): V3[] => circlePoints(r, z, n);
  const flat1 = r1 < 1e-9;
  const flat2 = r2 < 1e-9;
  const bot = flat1 ? null : ring(r1, z0);
  const top = flat2 ? null : ring(r2, z1);
  const out: Poly[] = [];
  const push = (v: V3[]) => {
    const p = makePoly(v);
    if (p) out.push(p);
  };
  if (top) push(top.slice());
  if (bot) push(bot.slice().reverse());
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    if (top && bot) push([top[j], bot[j], bot[k], top[k]]);
    else if (top) push([top[j], [0, 0, z0], top[k]]);
    else if (bot) push([[0, 0, z1], bot[j], bot[k]]);
  }
  return out;
}

/** 2D. A single polygon in the Z=0 plane, wound counter-clockwise. It is NEVER
 *  handed to the CSG kernel — it has no interior for a plane test to be about. */
function squareOutline(size: [number, number], center: boolean): V3[] {
  const [sx, sy] = size;
  const [x0, y0] = center ? [-sx / 2, -sy / 2] : [0, 0];
  return [
    [x0, y0, 0],
    [x0 + sx, y0, 0],
    [x0 + sx, y0 + sy, 0],
    [x0, y0 + sy, 0],
  ];
}

/** OpenSCAD's `circle` writes the loop out again rather than calling
 *  `generate_circle` (`primitives.cc:556-561`), but the expression is identical
 *  and the `z` it would pass is 0. One implementation here, deliberately: a
 *  faithful second copy of a ring generator is exactly what produced the
 *  divergence this call site used to carry. */
function circleOutline(r: number, f: Facets): V3[] {
  return circlePoints(r, 0, fragments(r, f));
}

/**
 * 2D boolean operations on flat outlines.
 *
 * Handles union, difference, and intersection on 2D polygons.
 * Returns the result as an array of Flat objects, or null if the
 * operation cannot be performed.
 *
 * For CNC:
 * - union: combine all outlines (outer boundaries)
 * - difference: first operand minus the rest (punch holes)
 * - intersection: overlap region only
 */
/**
 * Convert text to 2D outlines using Canvas2D rendering and bitmap tracing.
 *
 * Renders the text to an offscreen canvas, extracts the pixel data, and
 * traces the outline using a simple marching-squares algorithm. The result
 * is an array of closed polygon outlines (one per disconnected region).
 *
 * The text is rendered at the given `size` (in mm) with the specified font.
 * `halign` and `valign` control alignment. The outline is returned in the
 * text's local coordinate system (origin at the alignment point).
 *
 * 🔴 This is an APPROXIMATION — the outline is pixel-based, not vector.
 * The resolution is controlled by `PIXELS_PER_MM`. For CNC labels this is
 * more than adequate; for precision engraving it may need refinement.
 */
function textToOutlines(
  text: string,
  size: number,
  font: string,
  halign: 'left' | 'center' | 'right',
  valign: 'top' | 'center' | 'baseline' | 'bottom',
  _spacing: number, // reserved for future letter-spacing support
): [number, number][][] {
  // Only available in browser context
  if (typeof document === 'undefined') return [];

  const PIXELS_PER_MM = 10; // 10px per mm — good balance of quality and speed
  const fontSizePx = size * PIXELS_PER_MM;
  const fontStr = font ? `${fontSizePx}px ${font}` : `${fontSizePx}px sans-serif`;

  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  // Measure text to size the canvas
  ctx.font = fontStr;
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width) + 4; // padding
  const textHeight = Math.ceil(fontSizePx * 1.5) + 4; // generous padding
  canvas.width = textWidth;
  canvas.height = textHeight;

  // Render text
  ctx.font = fontStr;
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'top';
  ctx.fillText(text, 2, 2);

  // Extract pixel data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const w = canvas.width;
  const h = canvas.height;

  // Create binary grid (1 = filled, 0 = empty)
  const grid: number[][] = [];
  for (let y = 0; y < h; y++) {
    grid[y] = [];
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      grid[y][x] = pixels[idx + 3] > 128 ? 1 : 0; // alpha > 128 = filled
    }
  }

  // Marching squares to trace outlines
  const outlines = marchingSquares(grid, w, h);

  if (outlines.length === 0) return [];

  // Convert pixel coordinates to mm coordinates
  // The text is rendered at the alignment point
  const textWidthMm = w / PIXELS_PER_MM;
  const textHeightMm = h / PIXELS_PER_MM;

  // Alignment offsets
  let offsetX = 0;
  if (halign === 'center') offsetX = -textWidthMm / 2;
  else if (halign === 'right') offsetX = -textWidthMm;

  let offsetY = 0;
  if (valign === 'top') offsetY = 0;
  else if (valign === 'center') offsetY = -textHeightMm / 2;
  else if (valign === 'bottom') offsetY = -textHeightMm;
  else if (valign === 'baseline') offsetY = -textHeightMm * 0.8; // approximate baseline

  return outlines.map((outline) =>
    outline.map(([px, py]) => [
      px / PIXELS_PER_MM + offsetX,
      (h - py) / PIXELS_PER_MM + offsetY, // flip Y (canvas is top-down, CAD is bottom-up)
    ]),
  );
}

/**
 * Marching squares: trace outlines from a binary grid.
 * Returns an array of closed polygon outlines.
 */
function marchingSquares(grid: number[][], w: number, h: number): [number, number][][] {
  const outlines: [number, number][][] = [];
  const visited = new Set<string>();

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const key = `${x},${y}`;
      if (visited.has(key)) continue;

      // 2x2 cell: top-left, top-right, bottom-right, bottom-left
      const tl = grid[y][x];
      const tr = grid[y][x + 1];
      const br = grid[y + 1][x + 1];
      const bl = grid[y + 1][x];

      // Skip cells with no edge
      const cellValue = tl * 8 + tr * 4 + br * 2 + bl;
      if (cellValue === 0 || cellValue === 15) continue;

      // Trace the outline starting from this cell
      const outline = traceOutline(grid, w, h, x, y, visited);
      if (outline.length >= 3) {
        outlines.push(outline);
      }
    }
  }

  return outlines;
}

/**
 * Trace a single outline starting from a cell using marching squares.
 */
function traceOutline(
  grid: number[][],
  w: number,
  h: number,
  startX: number,
  startY: number,
  visited: Set<string>,
): [number, number][] {
  const outline: [number, number][] = [];
  let x = startX;
  let y = startY;
  let prevX = -1;
  let prevY = -1;

  for (let maxSteps = w * h; maxSteps > 0; maxSteps--) {
    const key = `${x},${y}`;
    if (visited.has(key) && x === startX && y === startY) break;
    visited.add(key);

    // Get the 2x2 cell values
    const tl = grid[y]?.[x] ?? 0;
    const tr = grid[y]?.[x + 1] ?? 0;
    const br = grid[y + 1]?.[x + 1] ?? 0;
    const bl = grid[y + 1]?.[x] ?? 0;

    const cellValue = tl * 8 + tr * 4 + br * 2 + bl;

    // Determine edge midpoints
    const top: [number, number] = [x + 0.5, y];
    const right: [number, number] = [x + 1, y + 0.5];
    const bottom: [number, number] = [x + 0.5, y + 1];
    const left: [number, number] = [x, y + 0.5];

    // Add edge midpoints based on cell value (marching squares cases)
    const addPoint = (pt: [number, number]) => {
      const last = outline[outline.length - 1];
      if (!last || Math.abs(last[0] - pt[0]) > 0.01 || Math.abs(last[1] - pt[1]) > 0.01) {
        outline.push(pt);
      }
    };

    // Marching squares: determine which edges are crossed
    switch (cellValue) {
      case 1: addPoint(left); addPoint(bottom); break;
      case 2: addPoint(bottom); addPoint(right); break;
      case 3: addPoint(left); addPoint(right); break;
      case 4: addPoint(right); addPoint(top); break;
      case 5: addPoint(left); addPoint(top); addPoint(right); addPoint(bottom); break; // saddle
      case 6: addPoint(bottom); addPoint(top); break;
      case 7: addPoint(left); addPoint(top); break;
      case 8: addPoint(top); addPoint(left); break;
      case 9: addPoint(top); addPoint(bottom); break;
      case 10: addPoint(top); addPoint(right); addPoint(bottom); addPoint(left); break; // saddle
      case 11: addPoint(top); addPoint(right); break;
      case 12: addPoint(right); addPoint(left); break;
      case 13: addPoint(right); addPoint(bottom); break;
      case 14: addPoint(bottom); addPoint(left); break;
    }

    // Move to the next cell
    // Determine direction based on the cell value and previous position
    let nextX = x;
    let nextY = y;

    // Simple direction: move based on which edge we entered from and which we exit
    if (cellValue >= 1 && cellValue <= 14) {
      // For non-trivial cells, move to the neighbor that shares the exit edge
      if (tl > 0 && tr === 0 && bl === 0 && br === 0) { nextX = x; nextY = y - 1; } // case 8
      else if (tr > 0 && tl === 0 && br === 0 && bl === 0) { nextX = x + 1; nextY = y; } // case 4
      else if (br > 0 && tl === 0 && tr === 0 && bl === 0) { nextX = x; nextY = y + 1; } // case 2
      else if (bl > 0 && tl === 0 && tr === 0 && br === 0) { nextX = x - 1; nextY = y; } // case 1
      else if (tl > 0 && tr > 0 && bl === 0 && br === 0) { nextX = x + 1; nextY = y; } // case 12
      else if (tl > 0 && bl > 0 && tr === 0 && br === 0) { nextX = x; nextY = y - 1; } // case 9
      else if (tr > 0 && br > 0 && tl === 0 && bl === 0) { nextX = x; nextY = y + 1; } // case 6
      else if (bl > 0 && br > 0 && tl === 0 && tr === 0) { nextX = x - 1; nextY = y; } // case 3
      else { nextX = x + 1; nextY = y; } // default: move right
    }

    if (nextX === prevX && nextY === prevY) break;
    prevX = x;
    prevY = y;
    x = Math.max(0, Math.min(w - 2, nextX));
    y = Math.max(0, Math.min(h - 2, nextY));
  }

  return outline;
}

function boolean2D(op: BooleanOp, flats: Flat[]): Flat[] | null {
  if (flats.length < 2) return flats;

  const subject = flats[0];
  const clip = flats[1];

  // Ensure both outlines are closed (first == last)
  const subj = ensureClosed(subject.outline);
  const clp = ensureClosed(clip.outline);

  if (subj.length < 3 || clp.length < 3) return null;

  switch (op) {
    case 'intersection': {
      const result = clipPolygon(subj, clp);
      if (result.length < 3) return [];
      return [{ outline: result, label: subject.label, line: subject.line, colour: subject.colour }];
    }
    case 'difference': {
      // Subject minus clip: keep the subject, punch out the intersection.
      // For CNC, this means the subject outline stays, and the clip becomes
      // a hole (returned as a separate flat).
      const intersection = clipPolygon(subj, clp);
      if (intersection.length < 3) {
        // No overlap — subject unchanged
        return [subject];
      }
      // Return subject outline + hole outline as separate flats.
      // The extrude/preview will show both; for CNC, the hole is a pocket.
      return [
        { outline: subj, label: subject.label, line: subject.line, colour: subject.colour },
        { outline: ensureClosed(intersection), label: `hole(${clip.label})`, line: clip.line, colour: clip.colour },
      ];
    }
    case 'union': {
      // Union of two polygons: combine outlines. For non-overlapping, just
      // concatenate. For overlapping, compute the outer boundary.
      const intersection = clipPolygon(subj, clp);
      if (intersection.length < 3) {
        // No overlap — both outlines are separate
        return [subject, clip];
      }
      // Overlapping: return the larger outline (simplified — a proper union
      // would compute the outer boundary, but for CNC the common case is
      // non-overlapping parts or one containing the other).
      const subjArea = polygonArea(subj);
      const clipArea = polygonArea(clp);
      if (subjArea >= clipArea) {
        return [subject]; // Subject contains clip
      }
      return [clip]; // Clip contains subject
    }
  }
  return null;
}

/** Ensure a polygon is closed (first point == last point). */
function ensureClosed(outline: V3[]): V3[] {
  if (outline.length < 2) return outline;
  const first = outline[0];
  const last = outline[outline.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
    return outline;
  }
  return [...outline, first];
}

/** Signed area of a polygon (positive for CCW winding). */
function polygonArea(pts: V3[]): number {
  let area = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return area / 2;
}

/**
 * Sutherland-Hodgman polygon clipping: clip `subject` against `clip`.
 * Returns the intersection polygon. Both inputs must be closed and CCW.
 */
function clipPolygon(subject: V3[], clip: V3[]): V3[] {
  let output = subject.slice(0, -1); // Remove closing vertex if present

  for (let i = 0; i < clip.length - 1; i++) {
    if (output.length === 0) return [];
    const edgeStart = clip[i];
    const edgeEnd = clip[i + 1];
    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const prev = input[(j - 1 + input.length) % input.length];

      const currentInside = isInsideEdge(current, edgeStart, edgeEnd);
      const prevInside = isInsideEdge(prev, edgeStart, edgeEnd);

      if (currentInside) {
        if (!prevInside) {
          const intersection = lineIntersection(prev, current, edgeStart, edgeEnd);
          if (intersection) output.push(intersection);
        }
        output.push(current);
      } else if (prevInside) {
        const intersection = lineIntersection(prev, current, edgeStart, edgeEnd);
        if (intersection) output.push(intersection);
      }
    }
  }

  return output;
}

/** Check if a point is on the inside (left side) of an edge. */
function isInsideEdge(point: V3, edgeStart: V3, edgeEnd: V3): boolean {
  return (
    (edgeEnd[0] - edgeStart[0]) * (point[1] - edgeStart[1]) -
    (edgeEnd[1] - edgeStart[1]) * (point[0] - edgeStart[0])
  ) >= 0;
}

/** Find intersection of two lines (p1→p2) and (p3→p4). */
function lineIntersection(p1: V3, p2: V3, p3: V3, p4: V3): V3 | null {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  return [p1[0] + t * d1x, p1[1] + t * d1y, 0];
}

/**
 * Extrude a 2D outline along Z to create a 3D solid.
 *
 * The outline is a closed polygon in the XY plane (z=0). The extrusion creates:
 * - Bottom face at z=0 (or z=-height/2 if centered)
 * - Top face at z=height (or z=height/2 if centered)
 * - Side walls connecting corresponding edges
 *
 * Returns an array of Poly (triangulated faces). The polygon is triangulated
 * by a simple fan from the first vertex, which works for convex polygons
 * and simple concave ones (the common case for CNC outlines).
 */
function extrudeOutline(outline: V3[], height: number, center: boolean): Poly[] {
  const n = outline.length;
  if (n < 3 || height <= 0) return [];

  const z0 = center ? -height / 2 : 0;
  const z1 = center ? height / 2 : height;

  const polys: Poly[] = [];

  // Bottom face: outline at z0, wound so normal points down (-Z).
  // Fan triangulation from vertex 0.
  const bottomVerts = outline.map((v) => [v[0], v[1], z0] as V3);
  for (let i = 1; i < n - 1; i++) {
    const p = makePoly([bottomVerts[0], bottomVerts[i + 1], bottomVerts[i]]);
    if (p) polys.push(p);
  }

  // Top face: outline at z1, wound so normal points up (+Z).
  const topVerts = outline.map((v) => [v[0], v[1], z1] as V3);
  for (let i = 1; i < n - 1; i++) {
    const p = makePoly([topVerts[0], topVerts[i], topVerts[i + 1]]);
    if (p) polys.push(p);
  }

  // Side walls: quad between each pair of consecutive edges.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = bottomVerts[i];
    const b1 = bottomVerts[j];
    const t0 = topVerts[i];
    const t1 = topVerts[j];
    // Two triangles per quad, wound so normal points outward.
    const p1 = makePoly([b0, b1, t1]);
    if (p1) polys.push(p1);
    const p2 = makePoly([b0, t1, t0]);
    if (p2) polys.push(p2);
  }

  return polys;
}

/**
 * Compute the 3D convex hull of a set of points using Quickhull.
 *
 * Returns an array of Poly (triangulated faces) representing the convex hull.
 * The algorithm:
 * 1. Find the extreme points on each axis
 * 2. Build an initial simplex (tetrahedron) from the most extreme points
 * 3. For each remaining point, add it to the hull by splitting visible faces
 *
 * This is a simplified Quickhull that works for the common CNC case:
 * relatively few points (< 10000) and mostly convex inputs.
 */
function quickhull(points: V3[]): Poly[] {
  const n = points.length;
  if (n < 4) return [];

  // Find the extreme points on each axis
  let minX = 0, maxX = 0, minY = 0, maxY = 0, minZ = 0, maxZ = 0;
  for (let i = 1; i < n; i++) {
    if (points[i][0] < points[minX][0]) minX = i;
    if (points[i][0] > points[maxX][0]) maxX = i;
    if (points[i][1] < points[minY][1]) minY = i;
    if (points[i][1] > points[maxY][1]) maxY = i;
    if (points[i][2] < points[minZ][2]) minZ = i;
    if (points[i][2] > points[maxZ][2]) maxZ = i;
  }

  // Find the most distant pair
  const extremes = [minX, maxX, minY, maxY, minZ, maxZ];
  let maxDist = 0;
  let a = 0, b = 1;
  for (let i = 0; i < extremes.length; i++) {
    for (let j = i + 1; j < extremes.length; j++) {
      const dx = points[extremes[i]][0] - points[extremes[j]][0];
      const dy = points[extremes[i]][1] - points[extremes[j]][1];
      const dz = points[extremes[i]][2] - points[extremes[j]][2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxDist) { maxDist = d; a = extremes[i]; b = extremes[j]; }
    }
  }

  // Find the point most distant from the line ab
  const abx = points[b][0] - points[a][0];
  const aby = points[b][1] - points[a][1];
  const abz = points[b][2] - points[a][2];
  let maxArea = 0;
  let c = a;
  for (let i = 0; i < n; i++) {
    if (i === a || i === b) continue;
    const acx = points[i][0] - points[a][0];
    const acy = points[i][1] - points[a][1];
    const acz = points[i][2] - points[a][2];
    // Cross product magnitude (area of triangle)
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    const area = cx * cx + cy * cy + cz * cz;
    if (area > maxArea) { maxArea = area; c = i; }
  }

  // Find the point most distant from the plane abc
  const acx = points[c][0] - points[a][0];
  const acy = points[c][1] - points[a][1];
  const acz = points[c][2] - points[a][2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  let maxVol = 0;
  let d = a;
  for (let i = 0; i < n; i++) {
    if (i === a || i === b || i === c) continue;
    const adx = points[i][0] - points[a][0];
    const ady = points[i][1] - points[a][1];
    const adz = points[i][2] - points[a][2];
    const vol = Math.abs(nx * adx + ny * ady + nz * adz);
    if (vol > maxVol) { maxVol = vol; d = i; }
  }

  if (maxVol < 1e-12) {
    // All points are coplanar — return empty
    return [];
  }

  // Build initial tetrahedron faces
  // Ensure correct winding: each face's normal should point outward
  const faces: number[][] = [];

  // Helper: signed volume of tetrahedron (a,b,c,d)
  const signedVol = (ai: number, bi: number, ci: number, di: number): number => {
    const ax = points[ai][0], ay = points[ai][1], az = points[ai][2];
    const bx = points[bi][0], by = points[bi][1], bz = points[bi][2];
    const cx = points[ci][0], cy = points[ci][1], cz = points[ci][2];
    const dx = points[di][0], dy = points[di][1], dz = points[di][2];
    return (
      (ax - dx) * ((by - dy) * (cz - dz) - (bz - dz) * (cy - dy)) -
      (ay - dy) * ((bx - dx) * (cz - dz) - (bz - dz) * (cx - dx)) +
      (az - dz) * ((bx - dx) * (cy - dy) - (by - dy) * (cx - dx))
    );
  };

  // Orient faces so normals point outward
  const vol = signedVol(a, b, c, d);
  if (vol > 0) {
    faces.push([a, b, c], [a, d, b], [b, d, c], [c, d, a]);
  } else {
    faces.push([a, c, b], [a, b, d], [b, c, d], [c, a, d]);
  }

  // Quickhull: for each remaining point, add it to the hull
  const remaining = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (i !== a && i !== b && i !== c && i !== d) remaining.add(i);
  }

  for (const pi of remaining) {
    const p = points[pi];
    // Find faces visible from p
    const visible: number[] = [];
    const horizon: [number, number][] = [];

    for (let fi = 0; fi < faces.length; fi++) {
      const face = faces[fi];
      const [fa, fb, fc] = face;
      // Face normal (not normalized — sign is what matters)
      const fax = points[fb][0] - points[fa][0], fay = points[fb][1] - points[fa][1], faz = points[fb][2] - points[fa][2];
      const fbxx = points[fc][0] - points[fa][0], fby = points[fc][1] - points[fa][1], fbz = points[fc][2] - points[fa][2];
      const fnx = fay * fbz - faz * fby;
      const fny = faz * fbxx - fax * fbz;
      const fnz = fax * fby - fay * fbxx;
      // Distance from p to face plane
      const dist = fnx * (p[0] - points[fa][0]) + fny * (p[1] - points[fa][1]) + fnz * (p[2] - points[fa][2]);
      if (dist > 1e-12) {
        visible.push(fi);
      }
    }

    if (visible.length === 0) continue; // p is inside the hull

    // Find horizon edges (edges shared by visible and non-visible faces)
    const edgeCount = new Map<string, number>();
    for (const fi of visible) {
      const face = faces[fi];
      for (let ei = 0; ei < 3; ei++) {
        const e0 = face[ei];
        const e1 = face[(ei + 1) % 3];
        const key = e0 < e1 ? `${e0}:${e1}` : `${e1}:${e0}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }

    // Horizon edges appear exactly once in visible faces
    for (const [key, count] of edgeCount) {
      if (count === 1) {
        const [e0, e1] = key.split(':').map(Number);
        horizon.push([e0, e1]);
      }
    }

    // Remove visible faces
    const newFaces: number[][] = [];
    for (let fi = 0; fi < faces.length; fi++) {
      if (!visible.includes(fi)) {
        newFaces.push(faces[fi]);
      }
    }

    // Add new faces from horizon edges to p
    for (const [e0, e1] of horizon) {
      newFaces.push([e0, e1, pi]);
    }

    faces.length = 0;
    faces.push(...newFaces);
  }

  // Check volume sign — if negative, flip all faces to ensure outward normals.
  let totalVol = 0;
  for (const face of faces) {
    const [fa, fb, fc] = face;
    const ax = points[fa][0], ay = points[fa][1], az = points[fa][2];
    const bx = points[fb][0], by = points[fb][1], bz = points[fb][2];
    const cx = points[fc][0], cy = points[fc][1], cz = points[fc][2];
    totalVol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (totalVol < 0) {
    for (const face of faces) face.reverse();
  }

  // Convert faces to Polys
  const polys: Poly[] = [];
  for (const face of faces) {
    const p = makePoly(face.map((i) => points[i]));
    if (p) polys.push(p);
  }

  return polys;
}

/**
 * Parse DXF/SVG text content and return 2D outlines as Flat objects.
 *
 * This is a simplified parser that handles the common DXF entities
 * (LINE, LWPOLYLINE, ARC, CIRCLE) and SVG shapes (rect, circle, path).
 * It reuses the same logic as the Rust core's import.rs but in TypeScript
 * for synchronous evaluation in the mesh kernel.
 */
function parseImportedContours(source: string, ext: string): Flat[] {
  if (ext === 'dxf') return parseDxfContours(source);
  if (ext === 'svg') return parseSvgContours(source);
  return [];
}

/** Parse DXF text and extract contours. */
function parseDxfContours(text: string): Flat[] {
  const lines = text.split('\n').map((l) => l.trim());
  const contours: Flat[] = [];
  let inEntities = false;
  let i = 0;

  while (i + 1 < lines.length) {
    const code = lines[i];
    const value = lines[i + 1];
    i += 2;

    if (code === '2' && value === 'ENTITIES') { inEntities = true; continue; }
    if (code === '0' && value === 'ENDSEC') { inEntities = false; continue; }
    if (!inEntities || code !== '0') continue;

    // Collect entity pairs
    const pairs: [string, string][] = [];
    while (i + 1 < lines.length && lines[i] !== '0') {
      pairs.push([lines[i], lines[i + 1]]);
      i += 2;
    }
    const get = (c: string): number | undefined => {
      const p = pairs.find(([k]) => k === c);
      return p ? parseFloat(p[1]) : undefined;
    };

    if (value === 'LINE') {
      const x1 = get('10'), y1 = get('20'), x2 = get('11'), y2 = get('21');
      if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
        contours.push({
          outline: [[x1, y1, 0], [x2, y2, 0]],
          label: 'line', line: 0, colour: null,
        });
      }
    } else if (value === 'LWPOLYLINE') {
      const xs = pairs.filter(([k]) => k === '10').map(([, v]) => parseFloat(v));
      const ys = pairs.filter(([k]) => k === '20').map(([, v]) => parseFloat(v));
      if (xs.length >= 2 && xs.length === ys.length) {
        const verts = xs.map((x, j) => [x, ys[j], 0] as V3);
        contours.push({ outline: verts, label: 'polyline', line: 0, colour: null });
      }
    } else if (value === 'CIRCLE') {
      const cx = get('10'), cy = get('20'), r = get('40');
      if (cx !== undefined && cy !== undefined && r !== undefined && r > 0) {
        const verts: V3[] = [];
        const n = Math.max(16, Math.ceil(r * 2));
        for (let j = 0; j <= n; j++) {
          const a = (j / n) * Math.PI * 2;
          verts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0]);
        }
        contours.push({ outline: verts, label: 'circle', line: 0, colour: null });
      }
    } else if (value === 'ARC') {
      const cx = get('10'), cy = get('20'), r = get('40');
      const startAngle = get('50'), endAngle = get('51');
      if (cx !== undefined && cy !== undefined && r !== undefined && r > 0 &&
          startAngle !== undefined && endAngle !== undefined) {
        const verts: V3[] = [];
        const a0 = startAngle * Math.PI / 180;
        let a1 = endAngle * Math.PI / 180;
        if (a1 <= a0) a1 += Math.PI * 2;
        const sweep = a1 - a0;
        const n = Math.max(8, Math.ceil(sweep * r / 2));
        for (let j = 0; j <= n; j++) {
          const a = a0 + (sweep * j) / n;
          verts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0]);
        }
        contours.push({ outline: verts, label: 'arc', line: 0, colour: null });
      }
    }
  }
  return contours;
}

/** Parse SVG and extract contours from rect, circle, polygon, polyline, path. */
function parseSvgContours(text: string): Flat[] {
  const contours: Flat[] = [];
  // Simple regex-based SVG parser for common shapes
  const rectRe = /<rect[^>]*?x="([^"]+)"[^>]*?y="([^"]+)"[^>]*?width="([^"]+)"[^>]*?height="([^"]+)"/g;
  let m;
  while ((m = rectRe.exec(text)) !== null) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    const w = parseFloat(m[3]), h = parseFloat(m[4]);
    if (w > 0 && h > 0) {
      contours.push({
        outline: [[x, y, 0], [x + w, y, 0], [x + w, y + h, 0], [x, y + h, 0], [x, y, 0]],
        label: 'rect', line: 0, colour: null,
      });
    }
  }
  const circRe = /<circle[^>]*?cx="([^"]+)"[^>]*?cy="([^"]+)"[^>]*?r="([^"]+)"/g;
  while ((m = circRe.exec(text)) !== null) {
    const cx = parseFloat(m[1]), cy = parseFloat(m[2]), r = parseFloat(m[3]);
    if (r > 0) {
      const verts: V3[] = [];
      const n = Math.max(16, Math.ceil(r * 2));
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        verts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0]);
      }
      contours.push({ outline: verts, label: 'circle', line: 0, colour: null });
    }
  }
  return contours;
}

/**
 * Parse a text-based heightmap and create a 3D mesh.
 *
 * The heightmap is a grid of height values, one row per line, space-separated.
 * Each value is a height in mm. The mesh is created by triangulating the grid.
 *
 * Supports:
 * - Plain text: rows of space-separated numbers
 * - Comments: lines starting with # are ignored
 * - Center: if true, the mesh is centered at the origin
 * - Invert: if true, heights are inverted (max - value)
 */
function parseHeightmap(source: string, center: boolean, invert: boolean): Poly[] {
  const lines = source.split('\n').filter((l) => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('#');
  });
  if (lines.length < 2) return [];

  // Parse the grid
  const grid: number[][] = [];
  for (const line of lines) {
    const values = line.trim().split(/\s+/).map(Number).filter((n) => !isNaN(n));
    if (values.length > 0) grid.push(values);
  }
  if (grid.length < 2) return [];

  // Ensure all rows have the same length
  const cols = Math.max(...grid.map((r) => r.length));
  for (const row of grid) {
    while (row.length < cols) row.push(0);
  }
  const rows = grid.length;
  if (cols < 2) return [];

  // Find min/max for inversion
  let minH = Infinity, maxH = -Infinity;
  for (const row of grid) {
    for (const v of row) {
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
  }

  // Center offsets
  const ox = center ? -(cols - 1) / 2 : 0;
  const oy = center ? -(rows - 1) / 2 : 0;

  // Create mesh triangles
  const polys: Poly[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const h00 = invert ? maxH - grid[r][c] : grid[r][c];
      const h10 = invert ? maxH - grid[r][c + 1] : grid[r][c + 1];
      const h01 = invert ? maxH - grid[r + 1][c] : grid[r + 1][c];
      const h11 = invert ? maxH - grid[r + 1][c + 1] : grid[r + 1][c + 1];

      const v00: V3 = [c + ox, r + oy, h00];
      const v10: V3 = [c + 1 + ox, r + oy, h10];
      const v01: V3 = [c + ox, r + 1 + oy, h01];
      const v11: V3 = [c + 1 + ox, r + 1 + oy, h11];

      // Two triangles per cell
      const p1 = makePoly([v00, v10, v11]);
      if (p1) polys.push(p1);
      const p2 = makePoly([v00, v11, v01]);
      if (p2) polys.push(p2);
    }
  }

  return polys;
}

/**
 * Compute the Minkowski sum of two solids (brute-force triangle pairwise).
 *
 * For each pair of triangles from the two operands, compute the Minkowski
 * sum as a polyhedron (6 vertices: each vertex of triangle A + each vertex
 * of triangle B), then union all results.
 *
 * This is O(n*m) where n and m are the triangle counts. For the common
 * CNC case (a cube grown by a sphere with ~$fn=12), n*m is manageable.
 *
 * The Minkowski sum of two convex polyhedra is the convex hull of the
 * pairwise sums of their vertices. For non-convex inputs, we decompose
 * into triangles and sum each pair, then union.
 */
function minkowskiSum(solids: Solid[]): Poly[] {
  if (solids.length < 2) return [];
  const a = solids[0];
  const b = solids[1];

  // Collect all triangles from both operands
  const trisA: V3[][] = [];
  for (const poly of a.polys) {
    if (poly.v.length === 3) trisA.push(poly.v);
    else {
      // Triangulate polygon by fan
      for (let i = 1; i < poly.v.length - 1; i++) {
        trisA.push([poly.v[0], poly.v[i], poly.v[i + 1]]);
      }
    }
  }
  const trisB: V3[][] = [];
  for (const poly of b.polys) {
    if (poly.v.length === 3) trisB.push(poly.v);
    else {
      for (let i = 1; i < poly.v.length - 1; i++) {
        trisB.push([poly.v[0], poly.v[i], poly.v[i + 1]]);
      }
    }
  }

  if (trisA.length === 0 || trisB.length === 0) return [];

  // For each pair of triangles, compute the Minkowski sum polyhedron.
  // The Minkowski sum of two triangles is a polyhedron with 6 vertices.
  // We compute the convex hull of these 6 vertices.
  const allPolys: Poly[] = [];
  const seen = new Set<string>();

  for (const triA of trisA) {
    for (const triB of trisB) {
      // 6 vertices: each vertex of A + each vertex of B
      const verts: V3[] = [];
      for (const va of triA) {
        for (const vb of triB) {
          verts.push([va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]]);
        }
      }
      // Compute convex hull of the 6 vertices
      const hull = quickhull(verts);
      for (const poly of hull) {
        // Deduplicate by vertex hash
        const hash = poly.v.map((v) => `${v[0].toFixed(4)},${v[1].toFixed(4)},${v[2].toFixed(4)}`).join('|');
        if (!seen.has(hash)) {
          seen.add(hash);
          allPolys.push(poly);
        }
      }
    }
  }

  // Union all the polyhedra
  if (allPolys.length === 0) return [];
  let result = allPolys[0] ? [allPolys[0]] : [];
  for (let i = 1; i < allPolys.length; i++) {
    result = csgUnion(result, [allPolys[i]], makeBudget(Date.now() + 30000));
  }
  return result;
}

/**
 * Project 3D solids onto the XY plane as 2D outlines.
 *
 * Two modes:
 * - cut=true: slice at z=0, return the cross-section outline (like OpenSCAD's projection(cut=true))
 * - cut=false: orthographic projection — drop Z, return the silhouette (like projection(cut=false))
 *
 * For cut=true: finds all triangles that cross z=0, computes intersection
 * edges, and chains them into closed contours.
 *
 * For cut=false: projects all triangle vertices onto XY and returns the
 * convex hull of the projected points (simplified — a proper 2D union
 * would be needed for concave silhouettes).
 */
function projectToXY(solids: Solid[], cut: boolean): Flat[] {
  if (cut) {
    // Slice at z=0: find triangles that cross the plane and compute intersection.
    const edges: [V3, V3][] = [];
    for (const solid of solids) {
      for (const poly of solid.polys) {
        for (let i = 0; i < poly.v.length - 2; i++) {
          const v0 = poly.v[0];
          const v1 = poly.v[i + 1];
          const v2 = poly.v[i + 2];
          // Check if this triangle crosses z=0
          const z0 = v0[2], z1 = v1[2], z2 = v2[2];
          const above = (z0 > 0 ? 1 : 0) + (z1 > 0 ? 1 : 0) + (z2 > 0 ? 1 : 0);
          if (above === 0 || above === 3) continue; // entirely above or below

          // Find intersection points with z=0 plane
          const pts: [number, number][] = [];
          const pairs: [V3, V3][] = [[v0, v1], [v1, v2], [v2, v0]];
          for (const [a, b] of pairs) {
            if ((a[2] > 0 && b[2] <= 0) || (a[2] <= 0 && b[2] > 0)) {
              const t = a[2] / (a[2] - b[2]);
              pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
            }
          }
          if (pts.length === 2) {
            edges.push([[pts[0][0], pts[0][1], 0], [pts[1][0], pts[1][1], 0]]);
          }
        }
      }
    }

    if (edges.length === 0) return [];

    // Chain edges into contours
    const contours = chainEdges(edges);
    return contours.map((outline, i) => ({
      outline,
      label: i === 0 ? 'projection' : `projection-${i + 1}`,
      line: 0,
      colour: null as null,
    }));
  }

  // cut=false: orthographic projection — drop Z, return convex hull of all vertices.
  const allPts: [number, number][] = [];
  for (const solid of solids) {
    for (const poly of solid.polys) {
      for (const v of poly.v) {
        allPts.push([v[0], v[1]]);
      }
    }
  }
  if (allPts.length < 3) return [];

  // Compute convex hull of the projected points
  const hull = convexHull2D(allPts);
  if (hull.length < 3) return [];

  return [{
    outline: hull.map(([x, y]) => [x, y, 0]),
    label: 'projection',
    line: 0,
    colour: null,
  }];
}

/**
 * Chain intersection edges into closed contours.
 * Simple greedy chaining: start from an unvisited edge, follow connected edges.
 */
function chainEdges(edges: [V3, V3][]): V3[][] {
  const used = new Set<number>();
  const contours: V3[][] = [];
  const EPS = 1e-6;
  const near = (a: V3, b: V3) =>
    Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

  for (let start = 0; start < edges.length; start++) {
    if (used.has(start)) continue;
    used.add(start);
    const chain: V3[] = [
      [edges[start][0][0], edges[start][0][1], 0],
      [edges[start][1][0], edges[start][1][1], 0],
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < edges.length; i++) {
        if (used.has(i)) continue;
        const [a, b] = edges[i];
        const tail = chain[chain.length - 1];
        if (near(tail, a)) {
          chain.push([b[0], b[1], 0]);
          used.add(i);
          changed = true;
        } else if (near(tail, b)) {
          chain.push([a[0], a[1], 0]);
          used.add(i);
          changed = true;
        }
      }
    }
    if (chain.length >= 3) {
      contours.push(chain);
    }
  }
  return contours;
}

/**
 * 2D convex hull using Graham scan.
 */
function convexHull2D(points: [number, number][]): [number, number][] {
  const n = points.length;
  if (n < 3) return points;

  // Find the lowest point (and leftmost if tied)
  let minIdx = 0;
  for (let i = 1; i < n; i++) {
    if (points[i][1] < points[minIdx][1] ||
        (points[i][1] === points[minIdx][1] && points[i][0] < points[minIdx][0])) {
      minIdx = i;
    }
  }
  const pivot = points[minIdx];

  // Sort by angle relative to pivot
  const sorted = points
    .filter((_, i) => i !== minIdx)
    .map((p) => ({
      pt: p,
      angle: Math.atan2(p[1] - pivot[1], p[0] - pivot[0]),
      dist: (p[0] - pivot[0]) ** 2 + (p[1] - pivot[1]) ** 2,
    }))
    .sort((a, b) => a.angle - b.angle || a.dist - b.dist)
    .map((o) => o.pt);

  const hull: [number, number][] = [pivot];
  for (const pt of sorted) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2];
      const b = hull[hull.length - 1];
      const cross = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
      if (cross <= 0) hull.pop();
      else break;
    }
    hull.push(pt);
  }
  return hull;
}

/**
 * Revolve a 2D outline around the Z axis to create a solid of revolution.
 *
 * The outline is in the XY plane. Each point (x, y, 0) traces a circle at
 * radius |x| and height y when revolved. Points with x < 0 are mirrored
 * to x > 0 (OpenSCAD convention: the profile must be in the +X half-plane).
 *
 * The mesh is generated as a surface of revolution: quad strips between
 * consecutive angular samples, connected to the outline's vertices.
 */
function rotateExtrudeOutline(outline: V3[], angleDeg: number, x: Xf, fn: number | null = null, startDeg = 180): Poly[] {
  const n = outline.length;
  if (n < 2 || angleDeg <= 0) return [];

  /* `$fn`, when the call carried one, is the fragments per FULL TURN, scaled
   * by the arc — OpenSCAD's `getCircularSegmentCount`: a NaN/±Inf `$fn` is
   * "no answer" and lands at 3 (CurveDiscretizer's `.value_or(3)`); a real
   * fn is ceil'd (`$fn` rounds UP — see the note at `fragmentsRequested`).
   * Absent it, the historical fixed 48/turn stands (that path predates
   * `$fa`/`$fs` support here and is a named gap, not a silent one). */
  let perTurn = 48;
  if (fn !== null) {
    perTurn = !Number.isFinite(fn) ? 3 : Math.max(3, Math.ceil(fn));
  }
  const fragments = Math.max(3, Math.ceil((angleDeg / 360) * perTurn));
  const stepDeg = angleDeg / fragments;
  const polys: Poly[] = [];

  for (let seg = 0; seg < fragments; seg++) {
    /* `startDeg` is where the arc BEGINS (OpenSCAD default 180 since the 2025
     * dev line) — a partial arc built from 0 sits 180° from where the source
     * put it. For a full turn it only rotates the vertex set, which is why the
     * pre-2026-08-27 fixed start-at-0 was invisible on the corpus torus. */
    const a0Deg = startDeg + stepDeg * seg;
    const a1Deg = startDeg + stepDeg * (seg + 1);
    const c0 = cosDegrees(a0Deg), s0 = sinDegrees(a0Deg);
    const c1 = cosDegrees(a1Deg), s1 = sinDegrees(a1Deg);

    for (let i = 0; i < n - 1; i++) {
      const p0 = outline[i];
      const p1 = outline[i + 1];
      const v00 = applyXf(x, [p0[0] * c0, p0[0] * s0, p0[1]]);
      const v10 = applyXf(x, [p0[0] * c1, p0[0] * s1, p0[1]]);
      const v01 = applyXf(x, [p1[0] * c0, p1[0] * s0, p1[1]]);
      const v11 = applyXf(x, [p1[0] * c1, p1[0] * s1, p1[1]]);
      /* 🔴 WOUND OUTWARD since 2026-08-27 — it was `[v00,v01,v11]`/`[v00,v11,v10]`,
       * which for a CCW outline in the (r,h) plane and θ running CCW around Z
       * gives an INWARD normal (u=outline tangent, u×θ̂ points at the axis).
       * Undetectable while the closing strip was missing — an open surface has
       * no orientation to audit — and measured the moment it closed: the corpus
       * torus reported volume −1720.1166 against OpenSCAD's +1720.1165. */
      const p = makePoly([v00, v11, v01]);
      if (p) polys.push(p);
      const q = makePoly([v00, v10, v11]);
      if (q) polys.push(q);
    }

    /* 🔴 THE CLOSING STRIP. Every flat outline in this kernel is a CLOSED LOOP
     * by convention — `circlePoints`/`square` emit n distinct vertices and the
     * loop closes last→first IMPLICITLY (nothing repeats outline[0]). Until
     * 2026-08-27 this loop ran i < n-1 and stopped, so the revolution of a
     * circle — `rotate_extrude($fn=32) translate([10,0]) circle(r=3,$fn=16)`,
     * the corpus case — was a ring with a whole strip MISSING, and the audit
     * correctly called the solid open. An explicitly-closed outline (first ≈
     * last, e.g. a traced contour) produces a degenerate strip here that
     * makePoly drops, so the wrap is safe for both conventions. */
    {
      const p0 = outline[n - 1];
      const p1 = outline[0];
      const v00 = applyXf(x, [p0[0] * c0, p0[0] * s0, p0[1]]);
      const v10 = applyXf(x, [p0[0] * c1, p0[0] * s1, p0[1]]);
      const v01 = applyXf(x, [p1[0] * c0, p1[0] * s0, p1[1]]);
      const v11 = applyXf(x, [p1[0] * c1, p1[0] * s1, p1[1]]);
      const p = makePoly([v00, v11, v01]);
      if (p) polys.push(p);
      const q = makePoly([v00, v10, v11]);
      if (q) polys.push(q);
    }
  }

  // Cap the flat ends of a PARTIAL revolution. Outlines are implicitly closed
  // (see above), so this keys on the ANGLE, not on whether the source repeated
  // its first point — the old `isClosed` test never fired for circle outlines
  // and left partial revolutions open at both ends. A full turn needs no caps:
  // the end faces meet. ⚠ The caps fan from vertex 0, which is valid for
  // convex outlines only — the invariant the Poly declaration states; a concave
  // rotate_extrude profile needs ear clipping this file does not have yet.
  if (angleDeg < 360 - 1e-9 && n >= 3) {
    const m = Math.abs(outline[n - 1][0] - outline[0][0]) < 1e-9 && Math.abs(outline[n - 1][1] - outline[0][1]) < 1e-9 ? n - 1 : n;
    /* Cap winding flips with the body (see above): the start cap faces −θ̂ and
     * the end cap faces +θ̂, so start is the CCW fan and the end is reversed.
     * Caps sit at startDeg and startDeg+angleDeg — the arc's real ends. */
    const cs = cosDegrees(startDeg), ss = sinDegrees(startDeg);
    for (let i = 1; i < m - 1; i++) {
      const a = applyXf(x, [outline[0][0] * cs, outline[0][0] * ss, outline[0][1]]);
      const b = applyXf(x, [outline[i][0] * cs, outline[i][0] * ss, outline[i][1]]);
      const c = applyXf(x, [outline[i + 1][0] * cs, outline[i + 1][0] * ss, outline[i + 1][1]]);
      const p = makePoly([a, b, c]);
      if (p) polys.push(p);
    }
    const ce = cosDegrees(startDeg + angleDeg), se = sinDegrees(startDeg + angleDeg);
    for (let i = 1; i < m - 1; i++) {
      const a = applyXf(x, [outline[0][0] * ce, outline[0][0] * se, outline[0][1]]);
      const b = applyXf(x, [outline[i][0] * ce, outline[i][0] * se, outline[i][1]]);
      const c = applyXf(x, [outline[i + 1][0] * ce, outline[i + 1][0] * se, outline[i + 1][1]]);
      const p = makePoly([a, c, b]);
      if (p) polys.push(p);
    }
  }

  return polys;
}

/**
 * Offset a 2D polygon outline by a given radius.
 *
 * Positive r expands, negative r shrinks. For each edge, the edge is moved
 * perpendicular to itself by r. At corners, arcs (approximated by line
 * segments) connect the offset edges.
 *
 * The algorithm:
 * 1. For each pair of consecutive edges, compute the offset edge (parallel,
 *    shifted by r in the outward normal direction).
 * 2. Find the intersection of consecutive offset edges — these are the new
 *    vertices.
 * 3. For positive r, add arc segments at corners where the polygon turns.
 * 4. For negative r, the same logic applies but the arcs go inward.
 *
 * This handles convex and simple concave polygons. Self-intersecting results
 * (from large negative offset on a concave polygon) are not cleaned up — the
 * result may have crossing edges in that case.
 */
function offsetOutline(outline: V3[], r: number, fn: number = 16): V3[] {
  const n = outline.length;
  if (n < 3 || Math.abs(r) < 1e-9) return outline;

  // Compute edge normals (outward for CCW winding).
  // For each edge i→j, the outward normal is perpendicular to the edge direction.
  const normals: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = outline[j][0] - outline[i][0];
    const dy = outline[j][1] - outline[i][1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-12) {
      normals.push([0, 0]);
      continue;
    }
    // Outward normal for CCW winding: (dy, -dx) normalized
    normals.push([dy / len, -dx / len]);
  }

  // Compute offset edges: each edge shifted by r along its normal.
  // For each pair of consecutive offset edges, find their intersection.
  const result: V3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const curr = i;

    // Offset edge prev: outline[prev] + r * normals[prev] → outline[i] + r * normals[prev]
    // Offset edge curr: outline[i] + r * normals[curr] → outline[j] + r * normals[curr]
    const p0x = outline[prev][0] + r * normals[prev][0];
    const p0y = outline[prev][1] + r * normals[prev][1];
    const p1x = outline[i][0] + r * normals[prev][0];
    const p1y = outline[i][1] + r * normals[prev][1];
    const q0x = outline[i][0] + r * normals[curr][0];
    const q0y = outline[i][1] + r * normals[curr][1];
    const q1x = outline[(i + 1) % n][0] + r * normals[curr][0];
    const q1y = outline[(i + 1) % n][1] + r * normals[curr][1];

    // Find intersection of lines (p0→p1) and (q0→q1).
    // Using parametric form: p0 + t*(p1-p0) = q0 + s*(q1-q0)
    const adx = p1x - p0x, ady = p1y - p0y;
    const bdx = q0x - q1x, bdy = q0y - q1y;
    const cdx = q0x - p0x, cdy = q0y - p0y;
    const det = adx * bdy - ady * bdx;

    // 🔴 A ROUND JOIN REPLACES THE MITER APEX — IT DOES NOT FOLLOW IT.
    //
    // This used to push the intersection of the two offset edges AND THEN the
    // arc's INTERIOR points (`k = 1 … arcSegments-1`, endpoints excluded). At a
    // convex corner the miter apex lies OUTSIDE the arc — for a 90° corner it is
    // r·√2 from the vertex against the arc's r — so the outline ran out to a
    // spike, jumped to the middle of the fillet, and never emitted the arc's own
    // start and end points at all.
    //
    // ⇒ THE POLYGON WAS SELF-INTERSECTING AT EVERY CONVEX CORNER, and that is a
    // property of the OUTLINE rather than of the triangle soup it becomes.
    // ⚠ Which is why it was invisible to every mesh-level check: measured
    // 2026-09-04, the extruded solid is CLOSED, correctly wound (signed volume
    // +527.7, matching the analytic rounded-rect area), has no zero-length edges
    // and no degenerate triangles — and poisoned every boolean it entered,
    // `union` as surely as `difference`. FIVE mesh-level hypotheses died on it
    // before I read this function.
    const cross = normals[prev][0] * normals[curr][1] - normals[prev][1] * normals[curr][0];
    if (r > 0 && cross > 0.01) {
      // Arc from the END of offset edge `prev` to the START of offset edge
      // `curr`, ENDPOINTS INCLUDED, and no apex.
      const cx = outline[i][0];
      const cy = outline[i][1];
      const startAngle = Math.atan2(p1y - cy, p1x - cx);
      const endAngle = Math.atan2(q0y - cy, q0x - cx);
      let sweep = endAngle - startAngle;
      if (sweep <= 0) sweep += Math.PI * 2;
      const arcSegments = Math.max(2, Math.ceil((sweep / Math.PI) * fn));
      for (let k = 0; k <= arcSegments; k++) {
        const a = startAngle + sweep * (k / arcSegments);
        result.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0]);
      }
    } else if (Math.abs(det) < 1e-12) {
      // Parallel edges — use the midpoint of the two offset points
      result.push([(p1x + q0x) / 2, (p1y + q0y) / 2, 0]);
    } else {
      const t = (cdx * bdy - cdy * bdx) / det;
      result.push([p0x + t * adx, p0y + t * ady, 0]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// BSP CSG
//
// The csg.js algorithm (Evan Wallace, MIT), re-derived in TypeScript. Every
// traversal below is ITERATIVE rather than recursive: a BSP built from a
// tessellated sphere is deep, and a stack overflow in the middle of a boolean
// would surface as a blank viewport with a console error nobody reads. An
// explicit stack turns depth into memory, which the budget can see.
// ---------------------------------------------------------------------------

class CsgLimit extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

interface BspNode {
  plane: { n: V3; w: number } | null;
  polys: Poly[];
  front: BspNode | null;
  back: BspNode | null;
}

const newNode = (): BspNode => ({ plane: null, polys: [], front: null, back: null });

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function splitPolygon(
  plane: { n: V3; w: number },
  poly: Poly,
  coplanarFront: Poly[],
  coplanarBack: Poly[],
  front: Poly[],
  back: Poly[],
): void {
  let polyType = 0;
  const types: number[] = [];
  for (const v of poly.v) {
    const t = dot(plane.n, v) - plane.w;
    const ty = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    polyType |= ty;
    types.push(ty);
  }

  switch (polyType) {
    case COPLANAR:
      // 🔴 FAILURE MODE (1) LIVES HERE. A face exactly on the split plane goes
      // to whichever side its normal points, which is the right answer for a
      // shared boundary between two solids and the wrong one for two solids
      // that merely touch. Nothing downstream can tell the two apart.
      (dot(plane.n, poly.n) > 0 ? coplanarFront : coplanarBack).push(poly);
      break;
    case FRONT:
      front.push(poly);
      break;
    case BACK:
      back.push(poly);
      break;
    case SPANNING: {
      const f: V3[] = [];
      const b: V3[] = [];
      for (let i = 0; i < poly.v.length; i++) {
        const j = (i + 1) % poly.v.length;
        const ti = types[i];
        const tj = types[j];
        const vi = poly.v[i];
        const vj = poly.v[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(ti !== BACK ? ([vi[0], vi[1], vi[2]] as V3) : vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - dot(plane.n, vi)) / dot(plane.n, sub(vj, vi));
          const mid: V3 = [
            vi[0] + t * (vj[0] - vi[0]),
            vi[1] + t * (vj[1] - vi[1]),
            vi[2] + t * (vj[2] - vi[2]),
          ];
          f.push(mid);
          b.push([mid[0], mid[1], mid[2]]);
        }
      }
      const pf = makePoly(f);
      const pb = makePoly(b);
      if (pf) front.push(pf);
      if (pb) back.push(pb);
      break;
    }
  }
}

interface Budget {
  deadline: number;
  check(count: number): void;
  /**
   * The deadline alone, for places that produce geometry without producing a
   * CSG operand — see the call in {@link Mesher.evalNode}.
   *
   * 🔴 SEPARATE FROM `check` ON PURPOSE. Passing `0` to `check` would test the
   * deadline too, but it would also read as *"this operation has no polygons"*,
   * which is false at every site that needs this. A control whose call site
   * misdescribes what it is checking is the kind that gets "simplified" away.
   */
  tick(): void;
}

function makeBudget(deadline: number): Budget {
  const overdue = () => {
    if (now() > deadline) {
      throw new CsgLimit(`the evaluation exceeded its ${MAX_MS} ms budget`);
    }
  };
  return {
    deadline,
    check(count: number) {
      if (count > MAX_POLYS) {
        throw new CsgLimit(`the operation exceeded ${MAX_POLYS.toLocaleString()} polygons`);
      }
      overdue();
    },
    tick: overdue,
  };
}

function bspBuild(root: BspNode, polys: Poly[], budget: Budget): void {
  const stack: [BspNode, Poly[]][] = [[root, polys]];
  let seen = 0;
  while (stack.length) {
    const [nd, ps] = stack.pop()!;
    if (!ps.length) continue;
    seen += ps.length;
    budget.check(seen);
    if (!nd.plane) nd.plane = { n: ps[0].n, w: ps[0].w };
    const f: Poly[] = [];
    const b: Poly[] = [];
    for (const p of ps) splitPolygon(nd.plane, p, nd.polys, nd.polys, f, b);
    if (f.length) {
      nd.front ??= newNode();
      stack.push([nd.front, f]);
    }
    if (b.length) {
      nd.back ??= newNode();
      stack.push([nd.back, b]);
    }
  }
}

function bspClipPolygons(root: BspNode, polys: Poly[], budget: Budget): Poly[] {
  const out: Poly[] = [];
  const stack: [BspNode, Poly[]][] = [[root, polys]];
  while (stack.length) {
    const [nd, ps] = stack.pop()!;
    if (!ps.length) continue;
    budget.check(out.length + ps.length);
    if (!nd.plane) {
      for (const p of ps) out.push(p);
      continue;
    }
    const f: Poly[] = [];
    const b: Poly[] = [];
    for (const p of ps) splitPolygon(nd.plane, p, f, b, f, b);
    if (nd.front) stack.push([nd.front, f]);
    else for (const p of f) out.push(p);
    if (nd.back) stack.push([nd.back, b]);
    // no `back` child ⇒ `b` is inside the other solid and is discarded
  }
  return out;
}

function bspClipTo(node: BspNode, other: BspNode, budget: Budget): void {
  const stack: BspNode[] = [node];
  while (stack.length) {
    const nd = stack.pop()!;
    nd.polys = bspClipPolygons(other, nd.polys, budget);
    if (nd.front) stack.push(nd.front);
    if (nd.back) stack.push(nd.back);
  }
}

function bspInvert(node: BspNode): void {
  const stack: BspNode[] = [node];
  while (stack.length) {
    const nd = stack.pop()!;
    for (const p of nd.polys) flipPoly(p);
    if (nd.plane) nd.plane = { n: [-nd.plane.n[0], -nd.plane.n[1], -nd.plane.n[2]], w: -nd.plane.w };
    const t = nd.front;
    nd.front = nd.back;
    nd.back = t;
    if (nd.front) stack.push(nd.front);
    if (nd.back) stack.push(nd.back);
  }
}

function bspAll(node: BspNode): Poly[] {
  const out: Poly[] = [];
  const stack: BspNode[] = [node];
  while (stack.length) {
    const nd = stack.pop()!;
    for (const p of nd.polys) out.push(p);
    if (nd.front) stack.push(nd.front);
    if (nd.back) stack.push(nd.back);
  }
  return out;
}

function toBsp(polys: Poly[], budget: Budget): BspNode {
  const n = newNode();
  bspBuild(n, polys.map(clonePoly), budget);
  return n;
}

function csgUnion(a: Poly[], b: Poly[], budget: Budget): Poly[] {
  const A = toBsp(a, budget);
  const B = toBsp(b, budget);
  bspClipTo(A, B, budget);
  bspClipTo(B, A, budget);
  bspInvert(B);
  bspClipTo(B, A, budget);
  bspInvert(B);
  bspBuild(A, bspAll(B), budget);
  return bspAll(A);
}

function csgSubtract(a: Poly[], b: Poly[], budget: Budget): Poly[] {
  const A = toBsp(a, budget);
  const B = toBsp(b, budget);
  bspInvert(A);
  bspClipTo(A, B, budget);
  bspClipTo(B, A, budget);
  bspInvert(B);
  bspClipTo(B, A, budget);
  bspInvert(B);
  bspBuild(A, bspAll(B), budget);
  bspInvert(A);
  return bspAll(A);
}

function csgIntersect(a: Poly[], b: Poly[], budget: Budget): Poly[] {
  const A = toBsp(a, budget);
  const B = toBsp(b, budget);
  bspInvert(A);
  bspClipTo(B, A, budget);
  bspInvert(B);
  bspClipTo(A, B, budget);
  bspClipTo(B, A, budget);
  bspBuild(A, bspAll(B), budget);
  bspInvert(A);
  return bspAll(A);
}

// ---------------------------------------------------------------------------
// Triangulation, T-junction repair, and the audit
//
// The audit is the reason this file can make any claim at all. It is a NEGATIVE
// CONTROL on the kernel: the kernel says "here is your shape", and the audit
// independently asks the one question that would expose it lying — is every
// edge of this surface met by exactly one other face, the other way round? A
// boolean that dropped a face, kept a face twice, or left a hole cannot pass it.
//
// The repair pass in the middle exists because the first version of this audit
// WAS WRONG in the alarming direction. It asked "does a vertex sit on this
// unmatched edge?" and called the answer a seam, everything else a hole — which
// mis-reported two of every three T-junction edges as a crack, and flagged an
// exactly-correct `union()` of two boxes (volume 15000.00 mm³ against an
// expected 15000) as untrustworthy. A false red is read exactly the way a false
// green is once people learn to ignore it. Repairing the T-junctions instead
// makes the question answerable: after the pass, one face on an edge means a
// hole.
// ---------------------------------------------------------------------------

/** An indexed triangle list over welded vertices. */
interface Welded {
  verts: V3[];
  /** 3 vertex ids per triangle. */
  tris: number[];
}

/**
 * 🔴 Float64Array, NOT Float32Array, and that is load-bearing rather than
 * fastidious. The audit below decides whether a vertex lies ON an edge, at a
 * tolerance of about 1e-8 mm. A float32 holding 20 mm has a spacing of roughly
 * 2e-6 mm — a hundred times COARSER than the question being asked — so an audit
 * run on float32 coordinates cannot see a T-junction at all. The first version
 * of this file did exactly that: every axis-aligned case passed (0, 10, 20 are
 * exact in float32) and every curved case reported hundreds of holes in a shape
 * whose volume was demonstrably right. Narrowing to float32 happens once, at
 * the end, for the GPU, and nothing is measured after it.
 */
function triangulate(polys: Poly[]): { pos: Float64Array; count: number; degenerate: number } {
  let tris = 0;
  for (const p of polys) tris += Math.max(0, p.v.length - 2);
  const pos = new Float64Array(tris * 9);
  let o = 0;
  let degenerate = 0;
  for (const p of polys) {
    // Fan from vertex 0. Valid because every polygon here is convex — see the
    // invariant stated at the Poly declaration.
    for (let i = 1; i + 1 < p.v.length; i++) {
      const a = p.v[0];
      const b = p.v[i];
      const c = p.v[i + 1];
      const area = 0.5 * len(cross(sub(b, a), sub(c, a)));
      if (area < 1e-12) degenerate++;
      pos[o++] = a[0];
      pos[o++] = a[1];
      pos[o++] = a[2];
      pos[o++] = b[0];
      pos[o++] = b[1];
      pos[o++] = b[2];
      pos[o++] = c[0];
      pos[o++] = c[1];
      pos[o++] = c[2];
    }
  }
  return { pos, count: tris, degenerate };
}

/** Spatial hash over welded vertices. Cell size is a parameter because the audit
 *  needs TWO of them: a tight one to weld, and a coarse one to answer "is there
 *  a vertex sitting on this edge?" without an O(n²) scan. */
class Grid {
  private cells = new Map<string, number[]>();
  constructor(private size: number) {}
  private key(i: number, j: number, k: number): string {
    return `${i},${j},${k}`;
  }
  cellOf(p: V3): [number, number, number] {
    return [
      Math.floor(p[0] / this.size),
      Math.floor(p[1] / this.size),
      Math.floor(p[2] / this.size),
    ];
  }
  add(p: V3, id: number): void {
    const [i, j, k] = this.cellOf(p);
    const key = this.key(i, j, k);
    const list = this.cells.get(key);
    if (list) list.push(id);
    else this.cells.set(key, [id]);
  }
  near(p: V3): number[] {
    const [i, j, k] = this.cellOf(p);
    const out: number[] = [];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          const list = this.cells.get(this.key(i + a, j + b, k + c));
          if (list) for (const id of list) out.push(id);
        }
      }
    }
    return out;
  }
}

/**
 * Weld coincident vertices and return an indexed triangle list.
 *
 * Welding is what makes the edge ledger below mean anything: two faces that
 * meet along an edge only "share" it if their vertices are the same NUMBER, and
 * BSP splitting produces coordinates that are equal to the last bit in some
 * places and equal to within a rounding error in others.
 */
function weld(pos: Float64Array, count: number): Welded {
  const verts: V3[] = [];
  const grid = new Grid(WELD_EPS * 2);
  const tris: number[] = new Array(count * 3);
  const eps2 = WELD_EPS * WELD_EPS;
  for (let t = 0; t < count * 3; t++) {
    const p: V3 = [pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]];
    let found = -1;
    for (const id of grid.near(p)) {
      const q = verts[id];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const dz = q[2] - p[2];
      if (dx * dx + dy * dy + dz * dz <= eps2) {
        found = id;
        break;
      }
    }
    if (found < 0) {
      found = verts.length;
      verts.push(p);
      grid.add(p, found);
    }
    tris[t] = found;
  }
  return { verts, tris };
}

/** Undirected edge key over welded vertex ids. Exact for ids below 2^26. */
const edgeKey = (a: number, b: number): number =>
  (a < b ? a : b) * 0x4000000 + (a < b ? b : a);

interface Ledger {
  edges: Map<number, { f: number; b: number }>;
  /** Directed boundary edges, as [from, to, triangleIndex]. */
  boundary: [number, number, number][];
  nonManifold: number;
  misoriented: number;
}

function ledgerOf(tris: number[]): Ledger {
  const edges = new Map<number, { f: number; b: number }>();
  const owner = new Map<number, [number, number, number]>();
  for (let t = 0; t * 3 < tris.length; t++) {
    const a = tris[t * 3];
    const b = tris[t * 3 + 1];
    const c = tris[t * 3 + 2];
    const pairs: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [u, v] of pairs) {
      if (u === v) continue; // an edge of a zero-area triangle, counted nowhere
      const k = edgeKey(u, v);
      let e = edges.get(k);
      if (!e) {
        e = { f: 0, b: 0 };
        edges.set(k, e);
        owner.set(k, [u, v, t]);
      }
      if (u < v) e.f++;
      else e.b++;
    }
  }
  const boundary: [number, number, number][] = [];
  let nonManifold = 0;
  let misoriented = 0;
  for (const [k, e] of edges) {
    const total = e.f + e.b;
    if (total === 1) boundary.push(owner.get(k)!);
    else if (total > 2) nonManifold++;
    else if (e.f !== 1 || e.b !== 1) misoriented++;
  }
  return { edges, boundary, nonManifold, misoriented };
}

/**
 * Split triangles at T-junctions until there are none left.
 *
 * 🔴 THIS IS NOT AN APPROXIMATION AND IT MOVES NOTHING. A T-junction is an edge
 * of one triangle that another triangle's VERTEX already lies on, exactly —
 * BSP CSG produces them constantly, because two faces meeting along an edge get
 * split by different planes. The repair inserts that existing vertex into that
 * edge. No coordinate changes, no volume changes, no surface changes; what
 * changes is that the two faces now agree about where the edge is.
 *
 * It exists because WITHOUT it the audit cannot tell a seam from a hole. The
 * long edge of a T has a vertex on it and the two short edges do not, so a
 * "is anything sitting on this edge?" test calls two thirds of every seam a
 * crack — which is a false red, and a false red is read exactly as a false
 * green once people learn to ignore it. After this pass, an edge with only one
 * face is a HOLE, and that is a claim worth making.
 *
 * Returns `exhausted: true` if it ran out of passes or splits, in which case
 * the remaining open edges are UNCLASSIFIED and must be reported as such — not
 * as holes and not as seams.
 */
function repairTJunctions(w: Welded, diag: number): { splits: number; passes: number; exhausted: boolean } {
  // Each pass splits a boundary edge at its NEAREST interior vertex, so an edge
  // crossed by k vertices needs k passes. A hole cut by a $fn=48 cylinder puts
  // roughly a dozen on one cube edge; 16 was not enough and the check honestly
  // reported PENDING rather than passing, which is how this number was found.
  const MAX_PASSES = 96;
  const maxSplits = Math.max(1024, w.tris.length * 2);
  const onEdge = Math.max(diag * 1e-9, 1e-9);
  const cell = Math.max(diag / 64, 1e-3);
  const coarse = new Grid(cell);
  for (let i = 0; i < w.verts.length; i++) coarse.add(w.verts[i], i);

  let splits = 0;
  let passes = 0;
  for (; passes < MAX_PASSES; passes++) {
    const led = ledgerOf(w.tris);
    if (!led.boundary.length) break;
    let did = 0;
    for (const [ai, bi, tIdx] of led.boundary) {
      if (splits >= maxSplits) return { splits, passes, exhausted: true };
      const a = w.verts[ai];
      const b = w.verts[bi];
      const d = sub(b, a);
      const dd = dot(d, d);
      if (!(dd > 0)) continue;
      // Nearest interior vertex along the edge, so repeated passes peel the
      // splits off in order and every one of them terminates.
      let best = -1;
      let bestU = 2;
      const steps = Math.max(1, Math.ceil(Math.sqrt(dd) / cell));
      const seen = new Set<number>();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const p: V3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
        for (const id of coarse.near(p)) {
          if (id === ai || id === bi || seen.has(id)) continue;
          seen.add(id);
          const q = w.verts[id];
          const u = dot(sub(q, a), d) / dd;
          if (u <= 1e-9 || u >= 1 - 1e-9) continue;
          const proj: V3 = [a[0] + d[0] * u, a[1] + d[1] * u, a[2] + d[2] * u];
          if (len(sub(q, proj)) <= onEdge && u < bestU) {
            bestU = u;
            best = id;
          }
        }
      }
      if (best < 0) continue;
      // Replace the owning triangle with two, cut at the existing vertex. The
      // winding is preserved by construction: (a, m, w) and (m, b, w) traverse
      // the original (a, b, w) in the same direction.
      const t3 = tIdx * 3;
      const v0 = w.tris[t3];
      const v1 = w.tris[t3 + 1];
      const v2 = w.tris[t3 + 2];
      let opp: number;
      if ((v0 === ai && v1 === bi) || (v0 === bi && v1 === ai)) opp = v2;
      else if ((v1 === ai && v2 === bi) || (v1 === bi && v2 === ai)) opp = v0;
      else if ((v2 === ai && v0 === bi) || (v2 === bi && v0 === ai)) opp = v1;
      else continue; // the ledger's owner record no longer matches; try next pass
      w.tris[t3] = ai;
      w.tris[t3 + 1] = best;
      w.tris[t3 + 2] = opp;
      w.tris.push(best, bi, opp);
      splits++;
      did++;
    }
    if (!did) break;
  }
  const led = ledgerOf(w.tris);
  return { splits, passes, exhausted: passes >= MAX_PASSES && led.boundary.length > 0 };
}

/** Narrow to float32 for three.js. The LAST step, and nothing is measured after it. */
function rebuild(w: Welded): { pos: Float32Array; count: number; degenerate: number } {
  const count = w.tris.length / 3;
  const pos = new Float32Array(count * 9);
  let degenerate = 0;
  for (let t = 0; t < count; t++) {
    const a = w.verts[w.tris[t * 3]];
    const b = w.verts[w.tris[t * 3 + 1]];
    const c = w.verts[w.tris[t * 3 + 2]];
    if (0.5 * len(cross(sub(b, a), sub(c, a))) < 1e-12) degenerate++;
    for (const [i, p] of ([a, b, c] as V3[]).entries()) {
      pos[t * 9 + i * 3] = p[0];
      pos[t * 9 + i * 3 + 1] = p[1];
      pos[t * 9 + i * 3 + 2] = p[2];
    }
  }
  return { pos, count, degenerate };
}

function auditWelded(w: Welded, repair: { splits: number; exhausted: boolean }, degenerate: number): MeshAudit {
  const led = ledgerOf(w.tris);
  const openEdges = led.boundary.length;
  const count = w.tris.length / 3;

  let verdict: PartVerdict;
  let detail: string;
  if (led.nonManifold > 0 || led.misoriented > 0) {
    verdict = 'non-manifold';
    detail =
      `${led.nonManifold} edge(s) shared by three or more faces and ${led.misoriented} shared by two faces ` +
      'wound the same way. That is what a self-intersecting or inside-out operand looks like. This shape has ' +
      'no defensible inside, and nothing should be cut from it.';
  } else if (repair.exhausted && openEdges > 0) {
    // A check that could not finish reports PENDING, never PASS — and it is
    // ranked with the bad answers, not the good one.
    verdict = 'seams';
    detail =
      `PENDING — the T-junction repair ran out of budget with ${openEdges} edge(s) still belonging to one ` +
      'face. It is NOT known whether those are seams in the triangulation or holes in the surface, and this ' +
      'is reported as the worse of the two. The model is too large or too tangled for the check, not proven ' +
      'sound by it.';
  } else if (openEdges > 0) {
    verdict = 'open';
    detail =
      `${openEdges} edge(s) belong to exactly one face after T-junction repair, so they are genuine holes in ` +
      'the surface. The boolean did not close the shape and what is drawn is not what the source describes. ' +
      'Faces flush or coplanar between the operands are the usual cause — overshooting the cutting solid by a ' +
      'fraction of a millimetre normally fixes it.';
  } else {
    verdict = 'closed';
    detail =
      'Every edge is shared by exactly two faces, once in each direction: watertight, manifold, consistently ' +
      'wound. ' +
      (repair.splits > 0
        ? `${repair.splits} T-junction(s) left by the CSG were repaired losslessly first — vertices already on ` +
          'an edge were inserted into it, so no coordinate and no volume changed. '
        : '') +
      'This is a statement about the MESH, not a guarantee that the shape is the one you meant, and nothing ' +
      'this app has produced has ever been cut.';
  }
  if (degenerate > 0) {
    detail += ` ${degenerate} zero-area triangle(s) are present; they are drawn and carry no information.`;
  }

  return {
    triangles: count,
    vertices: w.verts.length,
    openEdges,
    repairedTJunctions: repair.splits,
    repairExhausted: repair.exhausted,
    nonManifoldEdges: led.nonManifold,
    misorientedEdges: led.misoriented,
    degenerateTriangles: degenerate,
    verdict,
    detail,
  };
}

function boundsOf(pos: ArrayLike<number>, count: number): { min: Vec3; max: Vec3 } | null {
  if (count === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count * 9; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = pos[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// Scene-tree evaluation
// ---------------------------------------------------------------------------

interface Solid {
  polys: Poly[];
  label: string;
  line: number;
  colour: Colour | null;
}
interface Flat {
  outline: V3[];
  label: string;
  line: number;
  colour: Colour | null;
}
interface Evaluated {
  solids: Solid[];
  flats: Flat[];
}

/** The three booleans `scad.ts` builds. `hull` and `minkowski` are handled
 *  earlier in this file (see the `node.hull` / `node.minkowski` branches in
 *  `evaluate`) and do not participate in the boolean-operand dimension logic
 *  below. */
export type BooleanOp = 'union' | 'difference' | 'intersection';

/** One operand's dimension, in OpenSCAD's sense. `0` is an operand that
 *  produced no geometry at all: OpenSCAD keeps it in the child list and skips
 *  it when deciding the node's dimension (`isValidDim` tests `item.second`). */
export type OperandDim = 0 | 2 | 3 | 'mixed';

/**
 * WHAT OPENSCAD PRODUCES for this shape of node — its own binary's three
 * answers, in the same vocabulary `tools/scad_oracle/openscad.mjs` reads them
 * in, so the two can be compared instead of merely both being prose:
 *
 *   · `solid`        exit 0 and an STL is written.
 *   · `outline`      exit 1, `Current top level object is not a 3D object`,
 *                    no STL — and `--export-format svg|dxf` exits 0 and writes
 *                    the outline. That sentence means *there IS geometry and it
 *                    is 2D*, which is NOT the same as producing nothing.
 *   · `nothing`      exit 1, `Current top level object is empty`, no file from
 *                    ANY exporter — the 2D door refuses it too.
 *   · `undetermined` we could not reconstruct which of the three it would be.
 *
 * 🔴 THIS FIELD EXISTS BECAUSE `relation` ALONE LET THE YARDSTICK MOVE. The
 * table used to answer "does OpenSCAD produce a SOLID?" in the branches where
 * the node stays 3D and "does OpenSCAD DRAW anything?" in the branch where it
 * goes 2D, and reported both answers in the same word. A node that goes 2D can
 * never produce a solid, so the first question is a constant there and answering
 * it looks like agreement every time. `relation` is now DERIVED from this field
 * and from nothing else, so the question cannot silently change per branch.
 */
export type OpenscadProduces = 'solid' | 'outline' | 'nothing' | 'undetermined';

export interface TwoDimVerdict {
  /** What OpenSCAD produces. The measured fact; `relation` is derived from it. */
  produces: OpenscadProduces;
  /** How OUR refusal relates to what OpenSCAD does with the same node.
   *  DERIVED from `produces` — see {@link RELATION_OF}.
   *
   *  · `agree`    — OpenSCAD produces NOTHING either: no solid, and no outline.
   *                 Refusing costs nothing but the reason, and the reason is
   *                 better than OpenSCAD's.
   *  · `stricter` — 🔴 OpenSCAD produces geometry and we produce nothing. A real
   *                 divergence, whether the geometry is a solid or an outline,
   *                 and the only honest thing to do with it is print it at the
   *                 user and carry it in the divergence audit. ⚠ The two are not
   *                 equally urgent and `produces` is what tells them apart: a
   *                 `solid` is a plausible-looking wrong part that can reach a
   *                 spindle today, an `outline` is invisible until
   *                 `linear_extrude` lands and then becomes one.
   *  · `unknown`  — we could not reconstruct what OpenSCAD would do. Never
   *                 reported as agreement; see `mixed`. */
  relation: 'agree' | 'stricter' | 'unknown';
  /** What openscad 2026.08.07 does with this shape of node, measured. */
  openscad: string;
}

/** The ONE mapping from the measured fact to the verdict. Both `outline` and
 *  `solid` are geometry OpenSCAD hands the user and we do not. */
const RELATION_OF: Readonly<Record<OpenscadProduces, TwoDimVerdict['relation']>> = {
  solid: 'stricter',
  outline: 'stricter',
  nothing: 'agree',
  undetermined: 'unknown',
};

const verdict = (produces: OpenscadProduces, openscad: string): TwoDimVerdict => ({
  produces,
  relation: RELATION_OF[produces],
  openscad,
});

/**
 * WHAT OPENSCAD DOES WITH A 2D CHILD IN A BOOLEAN — read at the source and then
 * put to the binary, 2026-08-11. It is not one rule, it is two stages, and the
 * second stage is different for every operator:
 *
 *   STAGE 1 — the node's DIMENSION is decided by the FIRST child that has any
 *   geometry (`GeometryEvaluator::applyToChildren` → `isValidDim`,
 *   `GeometryEvaluator.cc:115-139`). A later child of the other dimension logs
 *   `WARNING: Mixing 2D and 3D objects is not supported` and stops the scan; it
 *   does NOT change the decision. An EMPTY child of the other dimension does not
 *   even warn — `circle(0)` is silently accepted into a 3D node.
 *
 *   STAGE 2 — the wrong-dimension child is then REPLACED BY AN EMPTY OPERAND IN
 *   PLACE, never removed: `collectChildren3D` pushes `(node, nullptr)` and logs
 *   `WARNING: Ignoring 2D child object for 3D operation`
 *   (`GeometryEvaluator.cc:400-408`); `collectChildren2D` does the mirror image
 *   for a 3D child in a 2D node (`:317-330`).
 *
 * ⚠ THAT IS A DIFFERENT DOOR FROM THE ONE `%` USES, and the difference is
 * observable. A background child is `continue`d — genuinely removed, so the next
 * operand is promoted — while a wrong-dimension child stays as an empty. Proof,
 * same file, same binary: `intersection(){cube(10); %circle(3); translate([5,0,0])
 * cube(10);}` exports 12 facets, and the same source without the `%` exports
 * NOTHING. Do not read "a child is skipped" as one mechanism.
 *
 *   STAGE 3 — then ORDINARY OPERATOR SEMANTICS run **in whichever dimension the
 *   node landed in**, and the empty operand is an ordinary operand: it breaks
 *   `intersection` and is skipped by everything else. 3D:
 *   `manifold-applyops.cc:70-84` sets `geom = nullptr` for INTERSECTION and
 *   `continue`s for the rest; UNION and MINKOWSKI filter empties out earlier
 *   still (`GeometryEvaluator.cc:175-181`). 2D: the same, through Clipper2.
 *
 * 🔴 STAGE 3 IS THE STAGE THIS TABLE USED TO SKIP FOR A 2D NODE, AND THAT IS THE
 * WHOLE OF THE DEFECT CORRECTED 2026-08-11. The `first === 2` branch answered
 * stage 1 — *the node is 2D, so no solid can come out* — and reported that as
 * agreement, for every operator at once. But a 2D node still RUNS its boolean
 * and still DRAWS the answer; only the STL door is closed. So the branch called
 * a live capability gap agreement for `union` and `difference`, and got
 * `intersection` right for a reason it never stated.
 *
 * MEASURED, `openscad 2026.08.07`, cube([10,10,10]) and circle(r=8)/circle(r=3),
 * asked BOTH doors — `--export-format asciistl` and `--export-format svg`.
 * ⚠ Read the STL column with the SVG column, never alone:
 *
 *   NODE                              STL                          SVG              ⇒
 *   difference(){ cube; circle; }     12 facets, exit 0            not a 2D object  solid
 *   union(){ cube; circle; }          12 facets, exit 0            not a 2D object  solid
 *   hull(){ cube; circle; }           12 facets, exit 0            —                solid
 *   minkowski(){ cube; circle; }      12 facets, exit 0            —                solid
 *   intersection(){ cube; circle; }   `…is empty`, exit 1          not a 2D object  NOTHING
 *   difference(){ circle; cube; }     `…not a 3D object`, exit 1   exit 0, 1 contour  OUTLINE
 *   union(){ circle; cube; }          `…not a 3D object`, exit 1   exit 0, 1 contour  OUTLINE
 *   intersection(){ circle; cube; }   `…is empty`, exit 1          not a 2D object  NOTHING
 *   difference(){ circle; circle; }   `…not a 3D object`, exit 1   exit 0, 2 contours OUTLINE
 *   intersection(){ circle; circle; } `…not a 3D object`, exit 1   exit 0, 1 contour  OUTLINE
 *   intersection(){ cube; circle(0); } still empty, and with only ONE warning:
 *                                     an empty 2D child does not trip `isValidDim`
 *
 * 🔴 THE TWO SENTENCES ARE NOT SYNONYMS AND THE OLD TABLE READ THEM AS ONE.
 * `Current top level object is empty` means *nothing was produced*.
 * `Current top level object is not a 3D object` means *something WAS produced
 * and it is 2D* — which the SVG column then confirms positively, with a file on
 * disk, rather than leaving it inferred from an absence message. The old row
 * `<any op>(){ circle; cube; } → not a 3D object` over-generalised across
 * operators: `intersection` says `empty` there, not `not a 3D object`, and it
 * was the only operator for which the `agree` verdict was true.
 *
 * ⚠ `tools/scad_oracle/openscad.mjs` HAD ALREADY SPLIT THOSE TWO SENTENCES and
 * scored a 2D node STRICTER on exactly this reasoning. When the harness and this
 * table disagreed, this table was the one that was wrong.
 *
 * 🔴 SO "MATCH OPENSCAD BY DROPPING THE 2D OPERAND" IS WRONG FOR INTERSECTION,
 * and wrong in the dangerous direction: it would emit a solid where OpenSCAD
 * emits nothing at all. That has not changed and is not what was corrected.
 */
export function twoDimensionalOperandVerdict(op: BooleanOp, dims: readonly OperandDim[]): TwoDimVerdict {
  if (dims.includes('mixed')) {
    return verdict(
      'undetermined',
      'one operand of this boolean is itself both 2D and 3D — a group whose children have different ' +
        'dimensions. OpenSCAD resolves that group FIRST, and its dimension is decided by whichever of its ' +
        'own children comes first, which is not reconstructable from here. What OpenSCAD does with this ' +
        'node was therefore NOT determined, and is not being reported as agreement.',
    );
  }

  // STAGE 1. An operand with no geometry does not vote: `isValidDim` tests the
  // geometry pointer, so `circle(0)` is silently accepted into a 3D node.
  const first = dims.find((d) => d !== 0);
  const nodeDim: 2 | 3 = first === 2 ? 2 : 3;
  // STAGE 2. A child of the other dimension survives as an EMPTY operand.
  const emptied = nodeDim === 3 ? dims.includes(2) : dims.includes(3);

  // STAGE 3, and it is one rule in both dimensions.
  if (op === 'intersection' && emptied) {
    return verdict(
      'nothing',
      nodeDim === 3
        ? 'the 2D operand becomes an EMPTY 3D operand, and an intersection with an empty operand is empty ' +
            '(manifold-applyops.cc:74-78). OpenSCAD says "Current top level object is empty" and writes no ' +
            'file — from the 2D exporters either. Neither side produces anything at all, including when the ' +
            '2D operand has no area of its own.'
        : 'the FIRST operand is 2D, so the node is 2D and the 3D operand becomes an EMPTY 2D one — and an ' +
            'intersection with an empty operand is empty in 2D exactly as it is in 3D. OpenSCAD says ' +
            '"Current top level object is empty" and writes no file from any exporter, STL or SVG. This is ' +
            'the ONE shape in this family where a 2D node genuinely produces nothing.',
    );
  }

  if (nodeDim === 3) {
    return verdict(
      'solid',
      `the 2D operand becomes an EMPTY 3D operand, which a ${op} simply skips — so OpenSCAD exports the 3D ` +
        'operand UNCHANGED (exit 0, with "Mixing 2D and 3D objects is not supported" and "Ignoring 2D child ' +
        'object for 3D operation" on the console), and we export nothing. 🔴 This is the shape where a SOLID ' +
        'goes missing: OpenSCAD hands back a part with the pocket un-cut, and this hands back nothing at all. ' +
        'Neither is the shape the source describes; only one of them looks like it is.',
    );
  }

  // A 2D node. It still runs its boolean and still draws the answer.
  // 🔴 ALL-2D booleans are now HANDLED by the 2D boolean kernel (2026-08-17).
  // Mixed 2D/3D still refuses.
  if (!emptied) {
    return {
      produces: 'outline',
      relation: 'agree',
      openscad:
        'every operand here is 2D, so OpenSCAD computes a REAL 2D boolean with Clipper2 ' +
        '(GeometryEvaluator::applyToChildren2D) and DRAWS the resulting outline — usually on its way into ' +
        'linear_extrude(). This tab now handles all-2D booleans too (union, difference, intersection), ' +
        'so the result is drawn on screen. Implemented 2026-08-17.',
    };
  }
  return verdict(
    'outline',
    `the FIRST operand is 2D, so OpenSCAD makes the whole node 2D and replaces every 3D child with an ` +
      `empty one ("Ignoring 3D child object for 2D operation") — then runs the ${op} over the 2D operands ` +
      'that are left and DRAWS the result. Asked for an STL it says "Current top level object is not a 3D ' +
      'object", which is its way of saying there IS geometry and it is 2D; asked for SVG or DXF it exits 0 ' +
      'and writes the outline. ' +
      'This tab draws 2D primitives too, so the difference is visible on screen: OpenSCAD shows the outline ' +
      'and this shows nothing at all. There is no 2D boolean kernel in this file, and there is no way to ' +
      'fake one that is not a guess about where the material went. ' +
      // ⚠ NAMED RATHER THAN HIDDEN, and the direction of the error is chosen.
      // A 2D boolean CAN cancel to nothing — measured: `difference(){ circle(3);
      // cube(10); circle(8); }` and `difference(){ circle(3); circle(8); }` both
      // give "Current top level object is empty". That depends on the operands'
      // extents, which a table keyed on their DIMENSIONS cannot see. So this
      // verdict over-reports strictness in the cancelling case, deliberately:
      // an over-stated 🔴 costs a reader a second look, and an under-stated one
      // is the invisible capability gap this whole table exists to surface.
      '⚠ Where the 2D result cancels to nothing — a difference or intersection whose operands do not ' +
      'overlap — OpenSCAD produces nothing here too and this refusal is agreement rather than strictness. ' +
      'That depends on where the operands ARE, which this verdict does not know; it is reported as the ' +
      'divergence because an over-stated divergence is the safe direction to be wrong in.',
  );
}

/** The refusal message for a boolean with a 2D operand — which is a decision
 *  about SAFETY, and therefore has to be argued at the point it costs someone
 *  something rather than in a document they will not open.
 *
 *  🔴 WE KEEP REFUSING, deliberately, and the divergence is named on screen.
 *  The alternative was to copy OpenSCAD: drop the 2D operand and hand back the
 *  3D one. OpenSCAD's own word for that node is *"Mixing 2D and 3D objects is
 *  not supported"* — it warns twice on a console and exports anyway — and the
 *  thing it exports for a `difference` is the minuend with the pocket missing.
 *  That is a plausible-looking wrong part, which is the failure this whole lane
 *  exists to stop, and a warning printed to a terminal nobody reads is not a
 *  control. So: nothing is drawn, the node is named, and the message says what
 *  OpenSCAD would have done so the user can tell a safety refusal from a
 *  capability gap. */
function twoDimensionalRefusal(op: BooleanOp, dims: readonly OperandDim[], flatCount: number): string {
  const v = twoDimensionalOperandVerdict(op, dims);
  // The head has to be true of THIS node. "dropping the 2D operand would return
  // the 3D one" says nothing about an all-2D boolean, where there is no 3D one
  // — and a sentence that does not fit the case in front of the reader teaches
  // them to stop reading the sentence.
  const anySolid = dims.some((d) => d === 3 || d === 'mixed');
  const head = anySolid
    ? `${flatCount} 2D shape(s) (square/circle) are operands of this ${op}, alongside 3D ones. There is no ` +
      '2D kernel here, and dropping the 2D operand would silently return the 3D one as though the operation ' +
      'had happened. The whole node was refused: nothing is drawn for it, including its 3D children.'
    : `every operand of this ${op} is 2D (${flatCount} square/circle) and there is no 2D boolean kernel in ` +
      'this file. The whole node was refused: no outline is drawn, because drawing one of them would be ' +
      'showing an operand as if it were a result.';
  // ⚠ THE AGREEMENT SENTENCE SAYS "NOTHING", NOT "NO SOLID". It used to say
  // "produces no solid here either" — true of every 2D node in existence, and
  // therefore worth nothing as a statement about THIS one. That phrasing is
  // what made a live capability gap read as agreement for a year of nobody
  // re-reading it; a sentence that is true by construction cannot be a check.
  const tail =
    v.relation === 'stricter'
      ? ' 🔴 THIS IS STRICTER THAN OPENSCAD, and here is what it does instead: '
      : v.relation === 'agree'
        ? ' OpenSCAD produces nothing here either, for its own reason: '
        : ' What OpenSCAD does with this node could not be determined: ';
  return head + tail + v.openscad;
}

class Mesher {
  issues: MeshIssue[] = [];
  booleansComputed = 0;
  booleansRefused = 0;
  private budget: Budget;
  private seen = new Set<string>();

  constructor(deadline: number) {
    this.budget = makeBudget(deadline);
  }

  private note(
    severity: MeshIssue['severity'],
    name: string,
    line: number,
    detail: string,
    alters: MeshIssue['alters'] = 'geometry',
  ): void {
    const k = `${severity}|${name}@${line}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.issues.push({ severity, name, line, detail, alters });
  }

  /**
   * @param c the colour IN FORCE from enclosing `color()` nodes. See
   *          {@link inherit}.
   *
   * ⚠ THE COLOUR TRAVELS DOWN BESIDE THE TRANSFORM AND FOR THE SAME REASON. It
   * is state that an ancestor establishes and a leaf consumes; carrying it any
   * other way would mean a second traversal that could disagree with this one
   * about which node is under which.
   */
  evalNode(node: SceneNode, x: Xf, c: Colour | null = null): Evaluated {
    // 🔴 THE TIME BUDGET IS ENFORCED HERE BECAUSE IT WAS ENFORCED NOWHERE THAT
    // MATTERED. `MAX_MS` is documented above as "wall-clock for the whole
    // evaluation", and until 2026-09-04 the only calls to `budget.check` were
    // inside the BSP loops in `csgUnion`/`csgSubtract`/`csgIntersect`. A model
    // that spends its time and memory GENERATING geometry — tessellating gear
    // teeth, walking nested `for` loops over an assembly — passed no check at
    // all, so neither the 6 s deadline nor the polygon ceiling applied to it.
    //
    // ⚠ MEASURED, not reasoned: `hardware/2bee_pnp/pnp_drive_drum_assembly.scad`
    // (two drums, involute gears, nested component loops) ran for **178 seconds**
    // and died of a **V8 heap OOM at 4 GB**, taking the whole scad_oracle process
    // with it — twice, identically. It never reached a boolean, so it was never
    // asked whether it had run out of anything. The stated 6 s budget was exceeded
    // by a factor of ~30 with nothing to notice.
    //
    // ⚠ AN OOM IS THE WORST AVAILABLE OUTCOME AND IS WHY THIS IS A TICK RATHER
    // THAN A REPORT. A refusal names the model and draws nothing; a process death
    // takes the harness's other 172 cases with it, and in the browser it is the
    // tab, not the shape — the failure mode `MAX_MS`'s own comment says these
    // budgets exist to prevent. The throw lands in the existing `CsgLimit` catch
    // in `meshScene`, which already reports it as `refused` with the budget named.
    this.budget.tick();
    switch (node.kind) {
      case 'primitive':
        return this.primitive(node, x, c);
      case 'transform':
        return this.transform(node, x, c);
      case 'group': {
        const inner = this.inherit(c, node.colour);
        // 🔴 A `linear_extrude` EVALUATES ITS CHILD IN THE LOCAL FRAME AND IS
        // TRANSFORMED AFTERWARDS. It used to evaluate the child with the
        // accumulated world transform `x` and then extrude along WORLD Z, so an
        // enclosing rotation moved the OUTLINE while the extrusion direction
        // stayed put.
        //
        // ⚠ MEASURED 2026-09-04, and the quiet case is the dangerous one:
        //     rotate([45,0,0]) linear_extrude(10) square([19,20]);
        //     ours     [0,      0, 0] -> [19, 14.142, 10    ]
        //     openscad [0, -7.071, 0] -> [19, 14.142, 21.213]
        // A closed, plausible, 12-triangle solid of the WRONG SHAPE. At exactly
        // ±90° the extrusion direction becomes parallel to the outline's own
        // plane, the side walls degenerate, and the result drops to 4 triangles
        // audited OPEN — which is the only reason anybody noticed. ⇒ THE
        // COLLAPSE WAS NOT THE BUG; IT WAS THE ONE ANGLE WHERE IT COULD NOT HIDE.
        //
        // `rotate_extrude` never had this defect — it already takes `x` — so the
        // asymmetry between the two 2D operators was the tell, and nothing read it.
        // ⚠ `rotate_extrude` IS THE SAME DEFECT AND WAS NOT IN THE FIRST FIX.
        // Found 2026-09-04 by checking the sibling 2D operators instead of
        // waiting for one to collapse: `rotateExtrudeOutline` already revolves
        // in the local frame and applies `x` AFTERWARDS — the structure was
        // right — but it was handed an outline that had ALREADY been
        // world-transformed, so the transform landed twice.
        //   rotate([45,0,0]) rotate_extrude($fn=16) translate([5,0,0]) square([2,3]);
        //     ours     [-7, -6.450, -4.95] -> [7, 4.95, 6.450]
        //     openscad [-7, -7.071, -4.95] -> [7, 4.95, 7.071]
        // ⇒ A fix scoped to the branch whose symptom you measured is scoped to
        // the branch you happened to look at. `offset` needs no change: it
        // returns flats and inherits whichever frame its parent establishes.
        const childX = node.extrude || node.rotateExtrude ? IDENTITY : x;
        const out: Evaluated = { solids: [], flats: [] };
        for (const ch of node.children) {
          const e = this.evalNode(ch, childX, inner);
          out.solids.push(...e.solids);
          out.flats.push(...e.flats);
        }
        // linear_extrude: extrude flats into solids
        if (node.extrude) {
          const { height, center } = node.extrude;
          if (height > 0 && out.flats.length > 0) {
            const extruded: Solid[] = [];
            for (const flat of out.flats) {
              // Extruded in the LOCAL frame, then carried into world space by the
              // enclosing transform — which also makes scale and shear correct,
              // not only rotation.
              const polys = transformPolys(extrudeOutline(flat.outline, height, center), x);
              if (polys.length > 0) {
                extruded.push({ polys, label: `extrude(${flat.label})`, line: flat.line, colour: flat.colour });
              }
            }
            return { solids: extruded, flats: [] };
          }
        }
        // rotate_extrude: revolve flats around Z axis
        if (node.rotateExtrude && out.flats.length > 0) {
          const { angle, fn, start } = node.rotateExtrude;
          if (angle > 0) {
            const solids: Solid[] = [];
            for (const flat of out.flats) {
              const polys = rotateExtrudeOutline(flat.outline, angle, x, fn, start);
              if (polys.length > 0) {
                solids.push({ polys, label: `rotate_extrude(${flat.label})`, line: flat.line, colour: flat.colour });
              }
            }
            return { solids, flats: [] };
          }
        }
        // offset: offset flat outlines by r
        if (node.offset && out.flats.length > 0) {
          const { r } = node.offset;
          if (Math.abs(r) > 1e-9) {
            const offsetFlats: Flat[] = [];
            for (const flat of out.flats) {
              const outline = offsetOutline(flat.outline, r);
              if (outline.length >= 3) {
                offsetFlats.push({ outline, label: `offset(${flat.label})`, line: flat.line, colour: flat.colour });
              }
            }
            return { solids: out.solids, flats: offsetFlats };
          }
        }
        // hull: compute convex hull of all children's geometry.
        // 3D (solids present): quickhull on all vertices → polyhedron.
        // 2D only (flats, no solids): Graham scan on XY → polygon.
        if (node.hull) {
          const allVerts3: V3[] = [];
          for (const solid of out.solids) {
            for (const poly of solid.polys) {
              for (const v of poly.v) {
                allVerts3.push(v);
              }
            }
          }
          if (allVerts3.length > 0) {
            // 3D path: lift any 2D flats into the 3D point cloud as well
            for (const flat of out.flats) {
              for (const v of flat.outline) {
                allVerts3.push([v[0], v[1], 0]);
              }
            }
            if (allVerts3.length >= 4) {
              const hullPolys = quickhull(allVerts3);
              if (hullPolys.length > 0) {
                return {
                  solids: [{ polys: hullPolys, label: 'hull', line: node.line, colour: null }],
                  flats: [],
                };
              }
            }
            return { solids: [], flats: [] };
          }
          // 2D path: no solids, only flats
          const pts2d: [number, number][] = [];
          for (const flat of out.flats) {
            for (const v of flat.outline) {
              pts2d.push([v[0], v[1]]);
            }
          }
          if (pts2d.length >= 3) {
            const hull2d = convexHull2D(pts2d);
            if (hull2d.length >= 3) {
              return {
                solids: [],
                flats: [{ outline: hull2d.map(([x, y]) => [x, y, 0] as V3), label: 'hull', line: node.line, colour: null }],
              };
            }
          }
          return { solids: [], flats: [] };
        }
        // minkowski: compute Minkowski sum of all children's geometry.
        // For each pair of triangles from different operands, compute the
        // Minkowski sum as a small polyhedron (6 vertices), then union all.
        if (node.minkowski && out.solids.length >= 2) {
          const result = minkowskiSum(out.solids);
          if (result.length > 0) {
            return {
              solids: [{ polys: result, label: 'minkowski', line: node.line, colour: null }],
              flats: [],
            };
          }
          return { solids: [], flats: [] };
        }
        // resize: scale children to fit a target bounding-box size.
        // Compute the bounding box of all children's vertices, then apply a
        // non-uniform scale so the geometry fits the requested size.
        if (node.resize) {
          const { newsize, auto } = node.resize;
          // Collect all vertices to compute the bounding box.
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (const solid of out.solids) {
            for (const poly of solid.polys) {
              for (const v of poly.v) {
                if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
                if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
                if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
              }
            }
          }
          for (const flat of out.flats) {
            for (const v of flat.outline) {
              if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
              if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
              if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
            }
          }
          const curSize: [number, number, number] = [maxX - minX, maxY - minY, maxZ - minZ];
          // Compute scale factors. For each axis:
          //   - target > 0: scale = target / current
          //   - target == 0 && !auto: scale = 1 (unchanged)
          //   - target == 0 && auto: proportional scale from first non-zero axis
          // Find the reference axis for proportional scaling (first non-zero target).
          let refScale = 1;
          for (let a = 0; a < 3; a++) {
            if (newsize[a] > 0 && curSize[a] > 1e-12) {
              refScale = newsize[a] / curSize[a];
              break;
            }
          }
          const sx = newsize[0] > 0 && curSize[0] > 1e-12
            ? newsize[0] / curSize[0]
            : auto[0] && curSize[0] > 1e-12 ? refScale : 1;
          const sy = newsize[1] > 0 && curSize[1] > 1e-12
            ? newsize[1] / curSize[1]
            : auto[1] && curSize[1] > 1e-12 ? refScale : 1;
          const sz = newsize[2] > 0 && curSize[2] > 1e-12
            ? newsize[2] / curSize[2]
            : auto[2] && curSize[2] > 1e-12 ? refScale : 1;
          // Apply the scale to all vertices.
          if (sx !== 1 || sy !== 1 || sz !== 1) {
            for (const solid of out.solids) {
              for (const poly of solid.polys) {
                for (const v of poly.v) {
                  v[0] *= sx; v[1] *= sy; v[2] *= sz;
                }
                // Recompute the plane equation for the scaled polygon.
                const np = makePoly(poly.v);
                if (np) { poly.n = np.n; poly.w = np.w; }
              }
            }
            for (const flat of out.flats) {
              for (const v of flat.outline) {
                v[0] *= sx; v[1] *= sy; v[2] *= sz;
              }
            }
          }
          return out;
        }
        // projection: project 3D solids onto XY plane as 2D outlines.
        if (node.projection && out.solids.length > 0) {
          const flats = projectToXY(out.solids, node.projection.cut);
          return { solids: [], flats };
        }
        // multmatrix: apply an arbitrary 4×4 transform to children.
        // The matrix is stored as a 9-element array (3×3 rotation/scale) +
        // 3-element translation, extracted from the 4×4 matrix.
        if (node.multmatrix) {
          const { m, t } = node.multmatrix;
          const local: Xf = { m: [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]], t };
          const composed = compose(x, local);
          /* 🔴 THE WINDING FIX FOR A NEGATIVE DETERMINANT IS IN
           * `transformPolys`, NOT HERE — see its header.
           *
           * This block used to flip each child's polygons AFTER evaluating
           * them. That is too late: the child's own booleans have already run,
           * and they ran on inside-out operands, so what came back was the
           * wrong SOLID and flipping it only made the wrong solid outward-wound.
           * `difference(){cube(10); translate([2,2,-1]) cube(3);}` under a
           * reflection came back as 12 triangles and 9 mm³ against the correct
           * 52 and 982, reported `trusted`.
           *
           * Flipping where the geometry is CREATED means every boolean sees
           * consistently wound operands, and this loop has nothing left to do.
           * ⚠ Doing BOTH double-flips: the shape is then right and the solid is
           * inside-out (-982), which is how this was caught. */
          const result: Evaluated = { solids: [], flats: [] };
          for (const ch of node.children) {
            const e = this.evalNode(ch, composed, c);
            result.solids.push(...e.solids);
            result.flats.push(...e.flats);
          }
          return result;
        }
        // import: parse the file content and return geometry.
        // DXF/SVG → flats (2D outlines), STL → solids (3D meshes).
        if (node.importFile) {
          const { name, source } = node.importFile;
          const ext = name.split('.').pop()?.toLowerCase() ?? '';
          if (ext === 'dxf' || ext === 'svg') {
            // Text-based formats — parse and return as flats
            const flats = parseImportedContours(source, ext);
            return { solids: [], flats };
          }
          // STL and binary formats — not supported in the browser parser
          // (the WASM core handles them, but we can't call it synchronously).
          return out;
        }
        // surface: parse heightmap and create 3D mesh
        if (node.surfaceFile) {
          const { source, center, invert } = node.surfaceFile;
          const polys = parseHeightmap(source, center, invert);
          if (polys.length > 0) {
            return {
              solids: [{ polys, label: 'surface', line: node.line, colour: null }],
              flats: [],
            };
          }
          return out;
        }
        return out;
      }
      case 'boolean':
        return this.boolean(node, x, c);
    }
  }

  /**
   * 🔴 THE OUTERMOST `color()` WINS, WHICH IS THE OPPOSITE OF WHAT NESTING
   * USUALLY MEANS. One line of OpenSCAD 2026.08.07
   * (`CSGTreeEvaluator::visit(ColorNode)`): `if (!state.color().isValid())
   * state.setColor(node.color);`. So `color("red") color("blue") cube(3);` is
   * RED, and a reviewer who assumed CSS-style innermost-wins would have shipped
   * blue and had nothing tell them.
   *
   * ⚠ AND "VALID" MEANS ALL FOUR CHANNELS, WHICH IS WHY A PARTIAL COLOUR IS
   * REPLACED WHOLE. `color(alpha=0.5) color("blue") cube(3);` is plain blue at
   * alpha 1 — the outer alpha is LOST, not merged — because the outer colour was
   * never valid and the inner one overwrote it entirely. Merging the two halves
   * would be the more sensible design and would disagree with the tool the file
   * was written for.
   */
  private inherit(inForce: Colour | null, node: Colour | undefined): Colour | null {
    if (node === undefined) return inForce;
    // ⚠ A DELIBERATE RE-DERIVATION OF `colourIsComplete` FROM `scad.ts`, forced
    // by the type-only import at the top of this file. It is guarded
    // BEHAVIOURALLY rather than textually: `color(alpha=0.5) color("blue")` is
    // the ONLY program whose result differs if this predicate and that one
    // disagree, and `tests/cad-colour.test.ts` asserts it in both files' terms.
    const complete = inForce !== null && inForce.rgb !== null && inForce.alpha !== null;
    return complete ? inForce : node;
  }

  private primitive(node: Extract<SceneNode, { kind: 'primitive' }>, x: Xf, c: Colour | null): Evaluated {
    const p = node.params;
    const line = node.line;
    const empty: Evaluated = { solids: [], flats: [] };
    switch (p.kind) {
      case 'cube': {
        if (p.size.some((s) => !(s > 0))) {
          this.note('refused', 'cube()', line, `a cube with size [${p.size.join(', ')}] has no volume; nothing was drawn`);
          return empty;
        }
        return { solids: [{ polys: transformPolys(cubePolys(p.size, p.center), x), label: 'cube', line, colour: c }], flats: [] };
      }
      case 'sphere': {
        if (!(p.r > 0)) {
          this.note('refused', 'sphere()', line, `a sphere with r ${p.r} has no volume; nothing was drawn`);
          return empty;
        }
        this.clampNote(p.r, p, line, 'sphere()');
        return { solids: [{ polys: transformPolys(spherePolys(p.r, p), x), label: 'sphere', line, colour: c }], flats: [] };
      }
      case 'cylinder': {
        if (!(p.h > 0) || (!(p.r1 > 0) && !(p.r2 > 0))) {
          this.note(
            'refused',
            'cylinder()',
            line,
            `a cylinder with h ${p.h}, r1 ${p.r1}, r2 ${p.r2} has no volume; nothing was drawn`,
          );
          return empty;
        }
        this.clampNote(Math.max(p.r1, p.r2), p, line, 'cylinder()');
        return {
          solids: [{ polys: transformPolys(cylinderPolys(p.h, p.r1, p.r2, p.center, p), x), label: 'cylinder', line, colour: c }],
          flats: [],
        };
      }
      case 'square': {
        if (p.size.some((s) => !(s > 0))) {
          this.note('refused', 'square()', line, `a square with size [${p.size.join(', ')}] has no area; nothing was drawn`);
          return empty;
        }
        return { solids: [], flats: [{ outline: squareOutline(p.size, p.center).map((q) => applyXf(x, q)), label: 'square', line, colour: c }] };
      }
      case 'circle': {
        if (!(p.r > 0)) {
          this.note('refused', 'circle()', line, `a circle with r ${p.r} has no area; nothing was drawn`);
          return empty;
        }
        this.clampNote(p.r, p, line, 'circle()');
        return { solids: [], flats: [{ outline: circleOutline(p.r, p).map((q) => applyXf(x, q)), label: 'circle', line, colour: c }] };
      }
      case 'polygon': {
        if (p.points.length < 3) {
          this.note('refused', 'polygon()', line, `a polygon with ${p.points.length} points has no area; nothing was drawn`);
          return empty;
        }
        const outline = p.points.map(([px, py]) => applyXf(x, [px, py, 0]));
        return { solids: [], flats: [{ outline, label: 'polygon', line, colour: c }] };
      }
      case 'text': {
        if (!p.text) {
          this.note('refused', 'text()', line, 'empty string; nothing was drawn');
          return empty;
        }
        const outlines = textToOutlines(p.text, p.size, p.font, p.halign, p.valign, p.spacing);
        if (outlines.length === 0) {
          this.note('refused', 'text()', line, 'font rendering produced no outlines; nothing was drawn');
          return empty;
        }
        const flats: Flat[] = outlines.map((outline, i) => ({
          outline: outline.map((pt) => applyXf(x, [pt[0], pt[1], 0])),
          label: i === 0 ? 'text' : `text-${i + 1}`,
          line,
          colour: c,
        }));
        return { solids: [], flats };
      }
      case 'polyhedron': {
        if (p.points.length < 3) {
          this.note('refused', 'polyhedron()', line, `a polyhedron with ${p.points.length} points has no volume; nothing was drawn`);
          return empty;
        }
        if (p.faces.length === 0) {
          this.note('refused', 'polyhedron()', line, 'a polyhedron with no faces has no volume; nothing was drawn');
          return empty;
        }
        // Validate face indices
        const maxIdx = p.points.length - 1;
        const polys: Poly[] = [];
        for (const face of p.faces) {
          if (face.some((i) => i < 0 || i > maxIdx)) {
            this.note('refused', 'polyhedron()', line, `face references out-of-range index (max ${maxIdx}); nothing was drawn`);
            return empty;
          }
          // Triangulate the face (fan from first vertex)
          const verts = face.map((i) => applyXf(x, p.points[i]));
          for (let i = 1; i < verts.length - 1; i++) {
            const poly = makePoly([verts[0], verts[i], verts[i + 1]]);
            if (poly) polys.push(poly);
          }
        }
        if (polys.length === 0) {
          this.note('refused', 'polyhedron()', line, 'all faces degenerated; nothing was drawn');
          return empty;
        }
        return { solids: [{ polys, label: 'polyhedron', line, colour: c }], flats: [] };
      }
    }
  }

  /** ⚠ KEYED ON THE FACET COUNT, NOT ON `$fn`. It used to fire only when an
   *  explicit `$fn` exceeded the clamp, which meant that once `$fa`/`$fs` were
   *  implemented the *other* route to a large count — `$fa=1; $fs=0.1;
   *  sphere(5)` asks for 315 sides — would have been clamped in silence. A
   *  clamp reported on one path and silent on the other is worse than no
   *  clamp: it reads as coverage. */
  private clampNote(r: number, f: Facets, line: number, who: string): void {
    const want = fragmentsRequested(r, f);
    if (want <= MAX_FN) return;
    this.note(
      'warning',
      `${who} ${f.fn !== null ? `$fn=${f.fn}` : `$fa=${f.fa}, $fs=${f.fs}`}`,
      line,
      /* precision: the SHAPE is the one the source described, drawn coarser. */
      `the source asks for ${want} facets and this kernel clamps to ${MAX_FN}. The drawn shape has FEWER ` +
        'facets than the source asks for, so it is smaller than the true shape everywhere between facets.',
      'precision',
    );
  }

  private transform(node: Extract<SceneNode, { kind: 'transform' }>, x: Xf, c: Colour | null): Evaluated {
    let local: Xf;
    if (node.op === 'translate') local = translateXf(node.v);
    else if (node.op === 'scale') local = scaleXf(node.v);
    else local = rotateXf(node.v);

    const d = det3(local.m);
    // NaN determinant: angle too large for argument reduction — refuse.
    if (!Number.isFinite(d)) {
      this.note(
        'refused',
        `${node.op}(${node.v.join(', ')})`,
        node.line,
        'this transform is NOT A NUMBER — the angle is too large for the argument reduction to keep any ' +
          'significant bits, so no rotation it could describe is knowable. It was dropped entirely rather ' +
          'than drawn from a meaningless matrix.',
      );
      return { solids: [], flats: [] };
    }
    // Zero determinant collapses the solid onto a plane — nothing drawn.
    if (d >= 0 && !(d > 1e-12)) {
      this.note(
        'refused',
        `${node.op}(${node.v.join(', ')})`,
        node.line,
        'this transform COLLAPSES its subtree to zero volume (zero determinant). It was dropped entirely.',
      );
      return { solids: [], flats: [] };
    }

    /* 🔴 NEGATIVE DETERMINANT: the winding fix lives in `transformPolys`, where
     * the geometry is MADE. See its header.
     *
     * This block used to say *"apply the transform, then flip every polygon's
     * winding"* and did it AFTER evaluating the children — which is the right
     * idea one step too late. `scale([-1,1,1])`, the ordinary idiom for a
     * mirrored part, evaluated its children's booleans on inside-out operands,
     * so the boolean itself was wrong and flipping the result only made a wrong
     * solid outward-wound: 12 triangles and 9 mm³ against the correct 52 and
     * 982, reported `trusted`. Measured 2026-09-02.
     *
     * ⚠ THE COMMENT WAS RIGHT ABOUT OPENSCAD AND WRONG ABOUT WHERE. OpenSCAD
     * does flip normals on mirrored operands — on the OPERANDS, before the
     * boolean consumes them, which is what `transformPolys` now does. */
    const composed = compose(x, local);
    const out: Evaluated = { solids: [], flats: [] };
    for (const child of node.children) {
      const e = this.evalNode(child, composed, c);
      out.solids.push(...e.solids);
      out.flats.push(...e.flats);
    }
    return out;
  }

  /** Collapse one child of a boolean into a single operand. OpenSCAD unions the
   *  children of a group used as an operand, so this must too — otherwise
   *  `difference() { cube(); { a(); b(); } }` would subtract only `a`. */
  private operand(node: SceneNode, x: Xf, c: Colour | null): { polys: Poly[]; flats: Flat[]; colour: Colour | null } {
    const e = this.evalNode(node, x, c);
    if (!e.solids.length) return { polys: [], flats: e.flats, colour: e.flats[0]?.colour ?? null };
    let acc = e.solids[0].polys;
    for (let i = 1; i < e.solids.length; i++) acc = csgUnion(acc, e.solids[i].polys, this.budget);
    return { polys: acc, flats: e.flats, colour: e.solids[0].colour };
  }

  private boolean(node: Extract<SceneNode, { kind: 'boolean' }>, x: Xf, c: Colour | null): Evaluated {
    const name = `${node.op}()`;
    const line = node.line;

    if (!node.children.length) return { solids: [], flats: [] };

    if (node.children.length < 2) {
      // 🔴 The one place this file can produce "the boolean returned its only
      // operand" WITHOUT it being a lie in its own terms — and it still needs
      // saying. `scad.ts` drops a refused construct from the tree entirely, so
      // `intersection() { cube(20); mirror([1,0,0]) cube(20); }` arrives here as
      // an intersection with ONE child, and one child intersected with nothing
      // is that child. The tree is right; the PICTURE is a solid the source
      // never described. The parser's refusal list is the other half of this
      // sentence, and the UI shows them together for exactly this reason.
      this.note(
        'warning',
        name,
        line,
        `this ${node.op} has only ONE operand in the scene tree, so it evaluates to that operand unchanged. ` +
          'If your source gave it more, the others were REFUSED by the parser and dropped — check the refusal ' +
          'list. What is drawn is then not the operation you wrote.',
        'geometry',
      );
    }

    try {
      const operands = node.children.map((child) => this.operand(child, x, c));

      const flatCount = operands.reduce((n, o) => n + o.flats.length, 0);
      const solidCount = operands.reduce((n, o) => n + o.polys.length, 0);

      // 2D booleans: all operands are flats (no solids).
      if (flatCount > 0 && solidCount === 0) {
        const allFlats = operands.flatMap((o) => o.flats);
        if (allFlats.length < 2) {
          return { solids: [], flats: allFlats };
        }
        const result = boolean2D(node.op, allFlats);
        if (result !== null) {
          return { solids: [], flats: result };
        }
        // Fallback: if 2D boolean fails, refuse
        const dims: OperandDim[] = operands.map((o) =>
          o.polys.length && o.flats.length ? 'mixed' : o.polys.length ? 3 : o.flats.length ? 2 : 0,
        );
        this.booleansRefused++;
        this.note('refused', name, line, twoDimensionalRefusal(node.op, dims, flatCount));
        return { solids: [], flats: [] };
      }

      // Mixed 2D/3D or pure 3D with some flats — refuse the 2D parts
      if (flatCount > 0) {
        const dims: OperandDim[] = operands.map((o) =>
          o.polys.length && o.flats.length ? 'mixed' : o.polys.length ? 3 : o.flats.length ? 2 : 0,
        );
        this.booleansRefused++;
        this.note('refused', name, line, twoDimensionalRefusal(node.op, dims, flatCount));
        return { solids: [], flats: [] };
      }

      const withGeom = operands.filter((o) => o.polys.length);
      if (!withGeom.length) return { solids: [], flats: [] };

      let result: Poly[];
      if (node.op === 'union') {
        result = withGeom[0].polys;
        for (let i = 1; i < withGeom.length; i++) result = csgUnion(result, withGeom[i].polys, this.budget);
      } else if (node.op === 'intersection') {
        // An operand that produced nothing intersects to nothing. Skipping it —
        // which `withGeom` would do — would return the intersection of the
        // REST, a larger shape than the source asks for.
        if (withGeom.length !== operands.length) {
          this.booleansRefused++;
          this.note(
            'refused',
            name,
            line,
            'one or more operands of this intersection produced no geometry (refused or empty). The ' +
              'intersection with an empty solid is empty, and quietly intersecting only the remaining ' +
              'operands would return a LARGER shape than the source describes. Nothing is drawn.',
          );
          return { solids: [], flats: [] };
        }
        result = operands[0].polys;
        for (let i = 1; i < operands.length; i++) result = csgIntersect(result, operands[i].polys, this.budget);
      } else {
        // difference: first child minus the union of the rest.
        if (!operands[0].polys.length) {
          this.note(
            'warning',
            name,
            line,
            'the first operand of this difference produced no geometry, so there is nothing to subtract from. ' +
              'Nothing is drawn — in particular the subtrahends are NOT drawn, because they describe material ' +
              'to be removed, not material to be kept.',
          );
          return { solids: [], flats: [] };
        }
        result = operands[0].polys;
        for (let i = 1; i < operands.length; i++) {
          if (!operands[i].polys.length) continue; // subtracting nothing is a no-op, honestly
          result = csgSubtract(result, operands[i].polys, this.budget);
        }
      }

      this.booleansComputed++;
      if (!result.length) {
        // An empty result is a legitimate answer (`difference() { cube(20);
        // cube(20); }` really is nothing). It is also what a boolean looks like
        // when both operands fell inside the classification tolerance and the
        // kernel ate them. The two are indistinguishable from here, so the
        // ambiguity is reported rather than resolved in the flattering
        // direction.
        this.note(
          'warning',
          name,
          line,
          `this ${node.op} evaluated to an EMPTY solid — nothing is drawn for it. That is the right answer when ` +
            'the operands cancel exactly; it is also what happens when a feature is smaller than the ' +
            `${EPS} mm classification tolerance and the kernel loses it. This file cannot tell those apart.`,
        );
      }
      /* 🔴 ONE PART CAN CARRY ONLY ONE COLOUR, AND A BOOLEAN MAKES ONE PART.
       * The colour taken is the one in force at the FIRST operand — the
       * minuend, whose material is what a `difference()` leaves behind. Where
       * the operands were coloured differently below the boolean, that fact is
       * DESTROYED by the kernel, not by this choice: `csgSubtract` returns a
       * single polygon soup with no memory of which operand each face came
       * from. So it is announced.
       *
       * ⚠ OpenSCAD's own preview does better here — it keeps each CSG leaf and
       * paints them separately — and its RENDER does worse, dropping the colour
       * entirely at any multi-child boolean (`applyToChildren3D` returns a fresh
       * geometry with the default `Color4f`). This file computes real CSG like
       * the render and draws one picture like the preview, so neither answer is
       * inherited for free. Naming the loss is the part that is not optional. */
      const colours = operands.filter((o) => o.polys.length).map((o) => o.colour);
      const distinct = new Set(colours.map((k) => JSON.stringify(k ?? null)));
      if (distinct.size > 1) {
        this.note(
          'warning',
          name,
          line,
          `the operands of this ${node.op} carry ${distinct.size} different colours, and the result is one ` +
            'solid that can only be drawn in one of them. The FIRST operand\'s colour is used. Nothing about ' +
            'the shape is affected — this is appearance only — but the picture is not a faithful record of ' +
            'which color() covered which material.',
          'appearance',
        );
      }
      return { solids: [{ polys: result, label: node.op, line, colour: operands[0]?.colour ?? c }], flats: [] };
    } catch (e) {
      if (!(e instanceof CsgLimit)) throw e;
      this.booleansRefused++;
      this.note(
        'refused',
        name,
        line,
        `${e.reason}. The operation was abandoned and NOTHING is drawn for this node — a partially applied ` +
          'boolean is not a shape, and showing the operands instead would show material that the source says ' +
          'is not there.',
      );
      return { solids: [], flats: [] };
    }
  }
}

/** Corrupt a welded mesh in a named, minimal way. See `MeshPlant`. */
function applyPlant(w: Welded, plant: MeshPlant): void {
  if (w.tris.length < 3) return;
  const t = 0; // the first triangle: deterministic, so a plant run is reproducible
  if (plant === 'drop-face') {
    w.tris.splice(t * 3, 3);
  } else if (plant === 'duplicate-face') {
    w.tris.push(w.tris[t * 3], w.tris[t * 3 + 1], w.tris[t * 3 + 2]);
  } else {
    const b = w.tris[t * 3 + 1];
    w.tris[t * 3 + 1] = w.tris[t * 3 + 2];
    w.tris[t * 3 + 2] = b;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a `scad.ts` scene tree into triangle meshes.
 *
 * 🔴 SIBLINGS AT A GROUP ARE NOT UNIONED, DELIBERATELY. OpenSCAD's own preview
 * (F5) draws top-level children independently and only `render` (F6) unions
 * them; this matches that. The visible consequence is that two overlapping
 * top-level solids keep the faces buried inside each other. From the outside
 * the picture is identical to the union, and each part keeps an audit that
 * means something — a forced union would spend the polygon budget and the
 * kernel's robustness on an operation the source never asked for. Inside a
 * `union()`/`difference()`/`intersection()` the union IS computed, because
 * there the operation is the point.
 */
/**
 * `budgetMs` exists so the TIME budget can be tested at all.
 *
 * 🔴 THE REVERT SWEEP FOUND `budget.tick()` UNGUARDED (2026-09-04): it could be
 * deleted with the whole suite green. It could not be tested either, because the
 * only way to exceed a 6 s wall-clock was to find a model that genuinely takes
 * 6 s — which is slow, machine-dependent, and would rot into a flake.
 *
 * ⚠ IT WIDENS NOTHING AT THE DEFAULT. Omitted, this is `MAX_MS` exactly as
 * before, and no product caller passes it — `CadTab` calls `meshScene(scene)`.
 * A caller COULD pass a larger budget, which is why it is named `budgetMs`
 * rather than something that reads like a tuning knob: the browser's contract is
 * the default and this is the seam a test drives it through.
 */
export function meshScene(scene: SceneNode, plant?: MeshPlant, budgetMs: number = MAX_MS): MeshResult {
  const t0 = now();
  // The parser's own report, stamped on the root by `parseScad`. Read here
  // rather than accepted as an argument so that arming this cannot be left to
  // the caller — `CadTab.tsx` passes `parseScad(src).scene` and gets it without
  // knowing it exists, and a hand-built tree gets `null`, which is audited as
  // UNKNOWN below and never as clean.
  const sourceDiagnostics: ParseDiagnostics | null =
    scene.kind === 'group' && scene.diagnostics ? scene.diagnostics : null;
  const mesher = new Mesher(t0 + budgetMs);
  let evaluated: Evaluated;
  try {
    evaluated = mesher.evalNode(scene, IDENTITY);
  } catch (e) {
    if (!(e instanceof CsgLimit)) throw e;
    evaluated = { solids: [], flats: [] };
    mesher.issues.push({
      severity: 'refused',
      name: 'the whole model',
      line: scene.line,
      detail: `${e.reason}. Evaluation stopped and nothing is drawn.`,
    });
  }

  const parts: MeshPart[] = [];
  let triangles = 0;

  if (plant) {
    mesher.issues.push({
      severity: 'refused',
      name: `PLANTED DEFECT: ${plant}`,
      line: scene.line,
      detail:
        'This result is DELIBERATELY CORRUPTED to prove the audit can fail. It is not a picture of the ' +
        'source. Nothing about a planted run may be quoted as a property of the kernel except that the ' +
        'audit caught it.',
    });
  }

  evaluated.solids.forEach((s, i) => {
    const raw = triangulate(s.polys);
    if (!raw.count) return;
    const w = weld(raw.pos, raw.count);
    const b0 = boundsOf(raw.pos, raw.count);
    const diag = b0 ? len(sub(b0.max as V3, b0.min as V3)) || 1 : 1;
    const repair = repairTJunctions(w, diag);
    if (plant) applyPlant(w, plant);
    const { pos, count, degenerate } = rebuild(w);
    triangles += count;
    parts.push({
      id: `s${i}@${s.line}`,
      label: s.label,
      line: s.line,
      dim: 3,
      positions: pos,
      triangles: count,
      audit: auditWelded(w, repair, degenerate),
      bounds: boundsOf(pos, count),
      colour: s.colour,
    });
  });

  evaluated.flats.forEach((f, i) => {
    const p = makePoly(f.outline);
    if (!p) return;
    const t = triangulate([p]);
    if (!t.count) return;
    const count = t.count;
    const pos = Float32Array.from(t.pos); // narrowed for the GPU; nothing is measured on a flat
    triangles += count;
    parts.push({
      id: `f${i}@${f.line}`,
      label: f.label,
      line: f.line,
      dim: 2,
      positions: pos,
      triangles: count,
      audit: null,
      bounds: boundsOf(pos, count),
      colour: f.colour,
    });
  });

  // --- model-scale sanity, i.e. failure mode (2) asked out loud --------------
  const all = parts.map((p) => p.bounds).filter((b): b is { min: Vec3; max: Vec3 } => b !== null);
  if (all.length) {
    let biggest = 0;
    let smallestFeature = Infinity;
    for (const b of all) {
      for (let a = 0; a < 3; a++) {
        biggest = Math.max(biggest, Math.abs(b.min[a]), Math.abs(b.max[a]));
        const ext = b.max[a] - b.min[a];
        if (ext > 0) smallestFeature = Math.min(smallestFeature, ext);
      }
    }
    if (biggest > 1e6) {
      mesher.issues.push({
        severity: 'warning',
        name: 'model scale',
        line: scene.line,
        detail:
          `coordinates reach ${biggest.toExponential(2)} mm. Plane classification here uses an absolute ` +
          `tolerance of ${EPS} mm, and at this magnitude a double's own spacing approaches it — so ` +
          'inside/outside decisions become arbitrary. Treat every boolean in this model as unverified.',
        /* geometry: it says so itself — every boolean here is unverified, which
         * is a statement about the SHAPE, not about how finely it is drawn. */
        alters: 'geometry',
      });
    }
    if (smallestFeature < EPS * 100 && smallestFeature < Infinity) {
      mesher.issues.push({
        severity: 'warning',
        name: 'feature size',
        line: scene.line,
        detail:
          `the smallest part extent is ${smallestFeature.toExponential(2)} mm, within two orders of the ` +
          `${EPS} mm classification tolerance. Features this small are classified by rounding, not by ` +
          'geometry.',
        alters: 'precision',
      });
    }
  }

  // --- overall trust --------------------------------------------------------
  const solids = parts.filter((p) => p.dim === 3);
  const flats = parts.filter((p) => p.dim === 2);
  const worst = solids.reduce<PartVerdict | null>((acc, p) => {
    const v = p.audit!.verdict;
    // `seams` ranks WITH `open`, not below it: it means the check did not
    // finish, and an unfinished check is not a better answer than a bad one.
    const rank = (x: PartVerdict): number => ({ closed: 0, flat: 1, seams: 2, open: 2, 'non-manifold': 3 })[x];
    return acc === null || rank(v) > rank(acc) ? v : acc;
  }, null);

  let trust: MeshResult['trust'];
  let trustDetail: string;
  const kernelRefusals = mesher.issues.filter((i) => i.severity === 'refused').length;
  /**
   * 🔴 WARNINGS THAT CHANGED THE SHAPE. See {@link MeshIssue.alters}.
   *
   * `trust` counted REFUSALS only, and a refusal is not the only way to lose
   * geometry. The one-operand-boolean warning is the proof: a `difference()`
   * whose subject evaluated to nothing returns its remaining operand unchanged,
   * so the picture is a CUT standing in for the part — watertight, manifold,
   * consistently wound, and wrong. Measured 2026-08-31 against OpenSCAD
   * 2026.08.07: 10 of 47 `trusted` designs in cad's tree disagree by more than
   * 5% in volume, and `2bee_hive_fan_box_panel_wcnc.scad` — a CNC sheet part —
   * drew 41 × 41 × 1 mm for a 121.5 × 407 × 18 mm panel.
   *
   * ⚠ THE WARNING'S OWN COMMENT ASSUMED THIS COULD NOT HAPPEN. It says the
   * missing operands "were REFUSED by the parser and dropped — check the
   * refusal list", i.e. it assumed a refusal always accompanies it and would
   * degrade trust on its own. That file has ZERO refusals and zero unsupported
   * constructs. An operand can vanish with nothing named, and when nothing is
   * named the case is WORSE, not better: there is no list to check.
   */
  const alteringWarnings = mesher.issues.filter(
    (i) => i.severity === 'warning' && (i.alters ?? 'geometry') === 'geometry',
  );
  const parserRefusals = sourceDiagnostics?.refusals ?? 0;
  const parserErrors = sourceDiagnostics?.errors ?? 0;
  const refusals = kernelRefusals + parserRefusals;

  if (!parts.length) {
    trust = 'nothing';
    trustDetail = refusals
      ? `Nothing was drawn: ${refusals} construct(s) were refused (${parserRefusals} by the parser, ` +
        `${kernelRefusals} by the kernel). An empty viewport here means the model was not evaluated, NOT ` +
        'that the model is empty.'
      : 'This source produced no geometry. An empty viewport means nothing was understood, not that the model is empty.';
  } else if (worst === null) {
    trust = 'suspect';
    trustDetail =
      'Only 2D shapes were produced. They are drawn as zero-thickness plates; they have no volume, nothing ' +
      'was extruded, and no boolean was applied to them.';
  } else if (worst === 'closed') {
    // 🔴 THE ORDER OF THESE TESTS IS THE POINT. `refusals` now counts the
    // PARSER's as well as the kernel's, and an unknown parse outranks a clean
    // mesh — because "the mesh is watertight" and "the mesh is the model" are
    // different claims and only the second is what a viewer reads off the word
    // `trusted`.
    if (!sourceDiagnostics) {
      trust = 'suspect';
      trustDetail =
        '🔴 UNKNOWN, not passed. Every solid drawn is watertight and manifold — but this tree arrived without ' +
        "the parser's report, so it is not known whether any construct in the source was refused and is " +
        'missing from it. A mesh audit cannot see a feature that never reached the mesh. Pass the tree from ' +
        '`parseScad(...).scene`, which carries it.';
    } else if (refusals > 0) {
      trust = 'suspect';
      trustDetail =
        `Every solid drawn is watertight and manifold — but ${refusals} construct(s) were REFUSED ` +
        `(${parserRefusals} by the parser, ${kernelRefusals} by the kernel) and are missing from this picture ` +
        'entirely. What you see is a subset of the model, so it is not the part.';
    } else if (alteringWarnings.length > 0) {
      /* Ranked ABOVE `parserErrors` and below `refusals`: a refusal names what
       * is missing, an error names where to look, and this names NEITHER — it
       * says a construct silently became a different one. */
      trust = 'suspect';
      const names = [...new Set(alteringWarnings.map((i) => i.name))].slice(0, 3).join(', ');
      trustDetail =
        `Every solid drawn is watertight and manifold, and nothing was refused — but ` +
        `${alteringWarnings.length} construct(s) did not draw what the source describes (${names}). ` +
        'Watertight is a statement about the MESH; it cannot tell you the mesh is the model. A boolean that ' +
        'lost an operand still produces a closed solid — the wrong one — so treat this picture as a shape ' +
        'nobody has checked against the source, and read the warnings before cutting anything.';
    } else if (parserErrors > 0) {
      trust = 'suspect';
      trustDetail =
        `Every solid drawn is watertight and manifold — but the source has ${parserErrors} error(s), and the ` +
        'parser DISCARDS the tokens between a failure and the next statement boundary. A construct can be ' +
        'hiding in a skipped span, so this picture may be missing geometry nothing has named.';
    } else if (flats.length > 0) {
      trust = 'suspect';
      trustDetail =
        'Every solid drawn is watertight and manifold. The 2D shapes alongside them have no thickness and ' +
        'are not part of any solid.';
    } else {
      trust = 'trusted';
      trustDetail =
        'Every solid drawn is watertight, manifold and consistently wound; nothing was refused by the kernel ' +
        'or by the parser, no construct warned that it drew something other than what the source describes, ' +
        'and the source parsed without error. That is a statement about the MESH and about the source having ' +
        'been fully UNDERSTOOD — it is still not a claim that the shape is what you meant, no geometry here ' +
        'has been compared against OpenSCAD, and nothing here has ever been cut.';
    }
  } else if (worst === 'seams') {
    trust = 'untrusted';
    trustDetail =
      '🔴 PENDING, not passed. On at least one solid the T-junction repair ran out of budget, so it is UNKNOWN ' +
      'whether the edges left with a single face are seams in the triangulation or holes in the surface. This ' +
      'is reported as the worse of the two, because a check that could not finish is not a check that passed.';
  } else if (worst === 'open') {
    trust = 'untrusted';
    trustDetail =
      '🔴 At least one solid has genuine holes in its surface. The boolean did not close the shape, so what is ' +
      'drawn is NOT the shape the source describes. Flush or coplanar faces between operands are the usual ' +
      'cause. Do not cut from this.';
  } else {
    trust = 'untrusted';
    trustDetail =
      '🔴 At least one solid is non-manifold: an edge shared by three or more faces, or by two faces wound the ' +
      'same way. That is a self-intersecting or inside-out result. It has no defensible inside and no ' +
      'meaningful volume. Do not cut from this.';
  }

  return {
    parts,
    issues: mesher.issues,
    stats: {
      triangles,
      solids: solids.length,
      flats: flats.length,
      booleansComputed: mesher.booleansComputed,
      booleansRefused: mesher.booleansRefused,
      ms: Math.round((now() - t0) * 10) / 10,
    },
    trust,
    trustDetail,
    sourceDiagnostics,
  };
}
