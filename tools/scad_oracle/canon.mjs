// The canonical CSG form both sides are reduced to, and the reductions.
//
// THE QUESTION THIS FILE ANSWERS: does our evaluator understand the same
// PROGRAM that OpenSCAD understands? Not "does it draw the same picture" — that
// is the mesh leg, and it can hide a wrong tree whenever two different trees
// happen to bound similar solids (a subtrahend that misses the minuend, an
// arithmetic slip inside a `for` that lands the same total volume, a default
// argument taken from the wrong place on a symmetric part).
//
// 🔴 THE CANONICAL FORM IS OPENSCAD'S OWN VOCABULARY, NOT OURS. Both sides are
// rewritten into the shape the oracle emits — `multmatrix` for every transform,
// `group()` for every container, `$fn/$fa/$fs` spelled out on every curved
// primitive. Choosing OUR vocabulary would have made the comparison test
// whether OpenSCAD can be expressed in our subset, which is the question we
// already know the answer to.
//
// 🔴 NUMBERS ARE COMPARED AT SIX SIGNIFICANT FIGURES BECAUSE THAT IS ALL THE
// ORACLE EMITS. OpenSCAD's CSG writer is `%g` at default precision — verified
// against the binary: `1234.56789` comes back as `1234.57`, `1/3` as
// `0.333333`, `cos(30)` as `0.866025`. Comparing more finely than the oracle
// can speak is not a stricter test, it is a test of the printf format. This is
// a MEASURED property of the tool, not a tolerance anybody chose, which is why
// it is not in the tolerance table with the mesh numbers.
//
// ⚠ 2026-08-14 — AND SIX FIGURES IS *NOT* WHAT THE ORACLE'S OWN ARITHMETIC
// CARRIES. The .csg writes each `multmatrix` pre-rounded to those six figures,
// and `normalise` then COMPOSES parent·child matrices from the rounded values,
// while our side composes from full doubles and is rounded once, at the leaf.
// Where the two roundings straddle a %g boundary the serialised trees differ
// by one last digit — measured: `fan_40mm` prints `7.0822` against our
// `7.08221`, `vent_fan` `5.96591` against `5.9659` — and an exact-string
// compare reads the instrument's own rounding as "the trees differ". The
// composition error is bounded by a few times the %g rounding (5e-7 relative
// per value), so the comparison is numeric at TREE_REL_TOL below, with the
// NON-numeric structure still compared byte for byte. What this cannot absorb,
// by construction: a $fn disagreement (400 vs 256 is rel 3.6e-1), a structural
// difference (different node, different text), and the quadrant-epsilon
// regression (`6.12323e-17` vs an exact `0` fails the relative test, because
// the tolerance scales with the larger magnitude).

// 🔴 THIS ONE IMPORT REACHES INTO THE PRODUCT, AND IT IS NOT THE SIN IT LOOKS
// LIKE. Read the long note above `rotateM` before touching it, and read it
// before adding a second one: it is the argument for why exactly this class of
// import is required, and it is also the argument for why most others are
// forbidden. The route is the one `ours.mjs` already established — a direct
// import of the unmodified `.ts` under `--experimental-transform-types`.
import { rotationMatrixDegrees } from '../../web/src/cad/mesh.ts';

// ---------------------------------------------------------------------------
// %g at precision 6, reimplemented, because that is the oracle's own format
// ---------------------------------------------------------------------------

const G_PRECISION = 6;

/** C's `%g` with precision 6, including its trailing-zero stripping. */
export function g6(x) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0'; // also folds -0, which OpenSCAD prints as 0
  const exp = Math.floor(Math.log10(Math.abs(x)));
  let s;
  if (exp < -4 || exp >= G_PRECISION) {
    s = x.toExponential(G_PRECISION - 1);
    const [m, e] = s.split('e');
    s = `${strip(m)}e${e}`;
  } else {
    s = strip(x.toFixed(Math.max(0, G_PRECISION - 1 - exp)));
  }
  return s === '-0' ? '0' : s;
}

function strip(s) {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

const gv = (a) => `[${a.map(g6).join(',')}]`;
const gb = (b) => (b ? 'true' : 'false');

// ---------------------------------------------------------------------------
// Matrices. 3x4 affine, row-major: [m00 m01 m02 tx  m10 ... m22 tz].
// ---------------------------------------------------------------------------

export const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function matMul(a, b) {
  const out = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    }
    out[r * 4 + 3] =
      a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return out;
}

export function translateM(v) {
  return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2]];
}

export function scaleM(v) {
  return [v[0], 0, 0, 0, 0, v[1], 0, 0, 0, 0, v[2], 0];
}

/**
 * OpenSCAD's `rotate([x,y,z])` is Rz . Ry . Rx, confirmed against the binary.
 *
 * 🔴 THIS IS AN ADAPTER, NOT AN IMPLEMENTATION. The matrix comes from the
 * product — `mesh.ts`'s `rotationMatrixDegrees` — and all this function does is
 * lift its 3x3 into the 3x4 affine shape the canonical form uses. It is called
 * from `sceneToCanon` and from nowhere else, and `sceneToCanon` runs on OUR side
 * only: the oracle's side of the comparison is parsed out of the `.csg` the real
 * binary wrote and never passes through here. So this function's ONE job is to
 * state what our product computes.
 *
 * 🔴 IT USED TO STATE SOMETHING ELSE, AND THAT IS THE WHOLE REASON FOR THE
 * IMPORT. Until 2026-08-11 this file built the matrix itself from
 * `Math.cos(deg * PI/180)`. That is a faithful second copy of what `mesh.ts`
 * used to do — and when `mesh.ts` was fixed to OpenSCAD's degree trig, the copy
 * did not move with it. The harness went on printing `6.12323e-17` where the
 * product now computes an exact `0`, so the rows attributed to our evaluator
 * were describing the instrument. Worse than wrong: UNFALSIFIABLE. No change to
 * the product could move them, so the oracle number was byte-identical before
 * and after a real fix, which is indistinguishable from a fix that did nothing.
 *
 * ⚠ CONSUMING THE PRODUCT'S IMPLEMENTATION IS NOT THE SAME AS TEACHING THE
 * HARNESS TO AGREE, AND THE NEXT READER WILL REASONABLY SUSPECT IT IS.
 * `TODO.md` #97 deliberately REFUSED to give this file exact quadrant trig, on
 * the grounds that it would print a matrix our product does not compute — an
 * instrument agreeing with us by construction. That reasoning was right, and it
 * is the reason for this change rather than an objection to it: after the
 * product fix, the NAIVE `rotateM` is the one printing a matrix our product does
 * not compute. Same sin, mirrored.
 *
 * The distinction that keeps it honest is which side moved. The comparison this
 * harness performs is untouched: our tree is still compared against the tree the
 * real `openscad` binary emitted, at the oracle's own six significant figures,
 * with no tolerance added anywhere. What changed is only that OUR side of that
 * comparison is now actually ours. If `mesh.ts` regresses, this file regresses
 * with it and the oracle goes red — which is exactly what a second copy here
 * would prevent.
 *
 * ⚠ AND THE FIRST VERSION OF THAT SENTENCE SAID "THE CORPUS GOES RED", WHICH WAS
 * FALSE WHEN WRITTEN. The corpus rotated by `[15,25,35]` and `[0,0,30]` and by
 * nothing else — no quadrant multiple anywhere — so the epsilon this whole item
 * is about could not appear in it, and CAD1 would have stayed green through a
 * regression. `corpus/xform_rotate_quadrant.scad` was added to close that, and
 * it was watched go red TWICE before being believed: once with the naive matrix
 * restored, and once with the snapping quadrant test #97 refused — the second of
 * which reddens on the 89.9999 child specifically, which is the point of it.
 *
 * 🔴 SO: CONSUME, NEVER PORT. A second faithful copy is what produced this
 * defect; re-porting the degree trig into this file would rebuild it under a new
 * name and the divergence would return the next time `mesh.ts` moves. If this
 * import is ever inconvenient, the fix is to make it work, not to inline it.
 *
 * ⚠ ONE COMPARISON CORNER THIS IMPORT MAKES REACHABLE, NAMED RATHER THAN
 * GUESSED AT. `rotationMatrixDegrees` returns NaN past OpenSCAD's
 * `TRIG_HUGE_VAL` — deliberately, because the reduction has no significant bits
 * left there — where the old naive path returned a confident finite number. So
 * a `rotate([1e30,0,0])` now reaches `g6` as NaN, and `g6` prints `NaN` while
 * the oracle's `%g` prints `nan`. That would read as a tree divergence for a
 * case where both sides in fact agree the answer is meaningless. NO CASE IN THE
 * CORPUS OR IN `hardware/cad/` REACHES IT — checked 2026-08-11 the only way that
 * is worth anything, by grepping the two full runs for `NaN`/`nan` and getting
 * zero, not by reading the sources for big literals. So no fix is guessed at
 * here; but the day a case does reach it, it is a formatting difference in `g6`,
 * not a disagreement about the program.
 */
export function rotateM(v) {
  // 3x3 row-major from the product -> the 3x4 affine this file's matrices use.
  // Rotation contributes no translation, so the fourth column is zero.
  const m = rotationMatrixDegrees(v);
  return [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0];
}

// ---------------------------------------------------------------------------
// The canonical node types
// ---------------------------------------------------------------------------
//   { k:'union',  ch:[...] }        commutative, associative, flattened
//   { k:'inter',  ch:[...] }        commutative, associative, flattened
//   { k:'diff',   ch:[minuend, subtrahend] }   subtrahend is a union
//   { k:'prim',   m:[12], text:'cube(...)' }
//   { k:'other',  m:[12], name, args, ch:[...] }   opaque node, in OpenSCAD's
//        own module spelling. TWO kinds of construct land here: ones NEITHER
//        side models (compared by name+args+children, so a construct one side
//        dropped diverges by the wrapper), and — since the kernel gained them
//        in 2026-08 (hull, minkowski, the extrudes, offset, projection,
//        resize, polygon, polyhedron, text) — ones BOTH sides apply, where the
//        agreement that matters is that the wrapper and its operands match.
//   { k:'empty' }
// ---------------------------------------------------------------------------

export const EMPTY = { k: 'empty' };

export const U = (ch) => ({ k: 'union', ch });
export const I = (ch) => ({ k: 'inter', ch });
export const D = (a, b) => ({ k: 'diff', ch: [a, b] });

// ---------------------------------------------------------------------------
// Primitive leaf text — built the SAME WAY from both sides, from the same five
// fields OpenSCAD prints. Anything OpenSCAD prints that our scene tree cannot
// carry stays in the string, so a difference in it is a difference in the tree.
// ---------------------------------------------------------------------------

export function primCube(size, center) {
  return `cube(size=${gv(size)},center=${gb(center)})`;
}
export function primSphere(r, fn, fa, fs) {
  return `sphere(r=${g6(r)},$fn=${g6(fn)},$fa=${g6(fa)},$fs=${g6(fs)})`;
}
export function primCylinder(h, r1, r2, center, fn, fa, fs) {
  return `cylinder(h=${g6(h)},r1=${g6(r1)},r2=${g6(r2)},center=${gb(center)},$fn=${g6(fn)},$fa=${g6(fa)},$fs=${g6(fs)})`;
}
export function primSquare(size, center) {
  return `square(size=${gv(size)},center=${gb(center)})`;
}
export function primCircle(r, fn, fa, fs) {
  return `circle(r=${g6(r)},$fn=${g6(fn)},$fa=${g6(fa)},$fs=${g6(fs)})`;
}

// ---------------------------------------------------------------------------
// Normalisation
//
// Three rewrites, each of which is a THEOREM about the CSG algebra rather than
// a convenience:
//
//   1. An affine transform distributes over union, difference and intersection:
//      M(A - B) = M(A) - M(B) for any invertible affine M. So every transform is
//      pushed down to the leaves and the tree above them becomes transform-free.
//      It does NOT distribute over `hull`, `minkowski` or `offset`, so those
//      keep their matrix and stay opaque.
//   2. Union and intersection are associative and commutative, so nested unions
//      flatten into their parent and the children are sorted. This is what makes
//      `for` (which OpenSCAD wraps in a group per iteration) comparable with our
//      single group, and what makes sibling order irrelevant on both sides.
//   3. `difference(a, b, c)` == `difference(a, union(b, c))`, so every diff is
//      binary and the subtrahend is a union that the other two rules then reach.
//
// 🔴 WHAT IS DELIBERATELY NOT DONE: no distribution of intersection over union,
// no de-duplication of identical children, no dropping of a subtrahend that
// cannot reach the minuend. Each of those would make more programs compare
// equal, and every one of them would do it by REASONING about geometry — which
// is the thing under test. The normal form is syntactic on purpose.
// ---------------------------------------------------------------------------

export function normalise(node, m = IDENT4) {
  switch (node.k) {
    case 'empty':
      return EMPTY;
    case 'prim':
      return { k: 'prim', m: matMul(m, node.m ?? IDENT4), text: node.text };
    case 'xform':
      return normalise(node.ch, matMul(m, node.m));
    case 'other':
      return {
        k: 'other',
        m: matMul(m, node.m ?? IDENT4),
        name: node.name,
        args: node.args,
        ch: (node.ch ?? []).map((c) => normalise(c, IDENT4)).filter((c) => c.k !== 'empty'),
      };
    case 'union':
    case 'inter': {
      const ch = [];
      for (const c of node.ch) {
        const n = normalise(c, m);
        if (n.k === 'empty') continue;
        // 🔴 A LOOP, NOT `push(...n.ch)`. The spread passes EVERY element as a
        // function ARGUMENT, and the argument count is bounded by the call
        // stack — so it throws `Maximum call stack size exceeded` on a large
        // array regardless of how shallow the recursion is. That is what killed
        // `2bee_pnp/pnp_drum_3d.scad`, and it is why the failure LOOKED like a
        // depth problem and was not: measured 2026-09-04, that model's canonical
        // tree is 671,847 nodes but only **36** deep, with 457,897 unions — and
        // this very line FLATTENS them, so `n.ch` here is an already-flattened
        // list of hundreds of thousands even though no single input list exceeds
        // 47. `push(...200_000)` throws on its own, with no recursion at all.
        if (n.k === node.k) for (const x of n.ch) ch.push(x);
        else ch.push(n);
      }
      if (ch.length === 0) return EMPTY;
      if (ch.length === 1) return ch[0];
      ch.sort((a, b) => (serialise(a) < serialise(b) ? -1 : 1));
      return { k: node.k, ch };
    }
    case 'diff': {
      const a = normalise(node.ch[0], m);
      if (a.k === 'empty') return EMPTY; // nothing to cut away from
      const rest = [];
      for (const c of node.ch.slice(1)) {
        const n = normalise(c, m);
        if (n.k === 'empty') continue;
        if (n.k === 'union') for (const x of n.ch) rest.push(x); // same argument-count bound as above
        else rest.push(n);
      }
      if (rest.length === 0) return a;
      rest.sort((x, y) => (serialise(x) < serialise(y) ? -1 : 1));
      return { k: 'diff', ch: [a, rest.length === 1 ? rest[0] : { k: 'union', ch: rest }] };
    }
    default:
      throw new Error(`normalise: unknown node kind ${node.k}`);
  }
}

/** A deterministic, line-per-node rendering. Equal strings == equal programs. */
export function serialise(node, depth = 0, out = []) {
  const pad = '  '.repeat(depth);
  switch (node.k) {
    case 'empty':
      out.push(`${pad}<nothing>`);
      break;
    case 'prim':
      out.push(`${pad}${mstr(node.m)} ${node.text}`);
      break;
    case 'other':
      out.push(`${pad}${mstr(node.m)} OPAQUE ${node.name}(${node.args})`);
      for (const c of node.ch) serialise(c, depth + 1, out);
      break;
    case 'union':
    case 'inter':
      out.push(`${pad}${node.k}`);
      for (const c of node.ch) serialise(c, depth + 1, out);
      break;
    case 'diff':
      out.push(`${pad}diff`);
      serialise(node.ch[0], depth + 1, out);
      out.push(`${pad}  -`);
      serialise(node.ch[1], depth + 1, out);
      break;
    default:
      out.push(`${pad}?${node.k}`);
  }
  return depth === 0 ? out.join('\n') : out;
}

const mstr = (m) => (isIdent(m) ? 'I' : `M${gv(m)}`);

function isIdent(m) {
  for (let i = 0; i < 12; i++) if (g6(m[i]) !== g6(IDENT4[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Numeric-tolerant comparison of two serialisations — see the dated note at
// the top of this file. The STRUCTURE (everything that is not a number) is
// still compared byte for byte; only the numbers carry tolerance, and the
// tolerance is relative to the larger magnitude, so `0` vs `6.12323e-17`
// still fails.
// ---------------------------------------------------------------------------

/** Relative agreement required of two serialised numbers. See the header. */
export const TREE_REL_TOL = 1e-5;

const NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

const numEq = (x, y) => x === y || Math.abs(x - y) <= TREE_REL_TOL * Math.max(Math.abs(x), Math.abs(y));

/** One serialised line: same non-numeric text, numbers within TREE_REL_TOL. */
export function serialisedLineEq(a, b) {
  if (a === b) return true;
  const spansA = a.split(NUM_RE);
  const spansB = b.split(NUM_RE);
  const numsA = a.match(NUM_RE) ?? [];
  const numsB = b.match(NUM_RE) ?? [];
  if (spansA.length !== spansB.length || numsA.length !== numsB.length) return false;
  for (let i = 0; i < spansA.length; i++) if (spansA[i] !== spansB[i]) return false;
  for (let i = 0; i < numsA.length; i++) if (!numEq(Number(numsA[i]), Number(numsB[i]))) return false;
  return true;
}

/**
 * Two serialised trees, compared line by line with `serialisedLineEq`.
 *
 * ⚠ A LIMIT, NAMED: `normalise` sorts union children by the serialised text,
 * so in principle a rounding straddle could change a SORT KEY and swap two
 * children, and a line-by-line compare would then read aligned-but-different
 * lines as a divergence — a false red. It is the SAFE direction (never a
 * false green), no case in the corpus or hardware leg has produced it (the
 * straddles measured 2026-08-14 sit inside one leaf's matrix, with distinct
 * siblings), and the fix — comparing as sorted multisets of lines — would
 * weaken `diff`'s operand order, which is not syntactic. Left as it is on
 * purpose.
 */
export function serialiseEq(a, b) {
  if (a === b) return true;
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) if (!serialisedLineEq(la[i], lb[i])) return false;
  return true;
}

/** The first GENUINELY differing line of two serialisations, with context.
 *  Tolerated rounding straddles are skipped, so the line reported is the one
 *  the comparison actually failed on — not an earlier line the tolerance
 *  absorbed. */
export function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== undefined && lb[i] !== undefined && serialisedLineEq(la[i], lb[i])) continue;
    if (la[i] !== lb[i]) {
      return {
        line: i + 1,
        openscad: la[i] === undefined ? '(end of tree)' : la[i].trim(),
        ours: lb[i] === undefined ? '(end of tree)' : lb[i].trim(),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The oracle's .csg file -> canonical form
// ---------------------------------------------------------------------------

const PRIMS = new Set(['cube', 'sphere', 'cylinder', 'square', 'circle']);

/** Tokenizer for the CSG dialect: it is small and total, so it is written out. */
function lexCsg(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num && (/[-0-9.]/.test(c))) {
      toks.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      toks.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    toks.push({ t: 'p', v: c });
    i++;
  }
  toks.push({ t: 'eof', v: '' });
  return toks;
}

class CsgParser {
  constructor(toks) {
    this.t = toks;
    this.p = 0;
  }
  peek(k = 0) {
    return this.t[Math.min(this.p + k, this.t.length - 1)];
  }
  eat(v) {
    if (this.peek().t === 'p' && this.peek().v === v) {
      this.p++;
      return true;
    }
    return false;
  }
  expect(v) {
    if (!this.eat(v)) throw new Error(`csg: expected '${v}' near ${JSON.stringify(this.peek().v)}`);
  }
  nodes(stopBrace) {
    const out = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'eof') break;
      if (stopBrace && t.t === 'p' && t.v === '}') break;
      if (this.eat(';')) continue;
      out.push(this.node());
    }
    return out;
  }
  node() {
    // Modifier characters survive into the .csg. They are NOT decoration:
    //   `#` highlight — drawn AND rendered, so transparent here
    //   `!` root      — already resolved by the evaluator (only that subtree is
    //                   emitted at all), so transparent here
    //   `%` background— drawn and NOT rendered. Verified against the binary:
    //                   `%sphere(20); cube(1);` exports 12 triangles, the cube
    //                   alone. So it contributes NOTHING to the solid.
    //
    // 🔴 "CONTRIBUTES NOTHING" IS NOT "IS AN EMPTY OPERAND", AND THE DIFFERENCE
    // SCORED A CORRECT RESULT AS `DIVERGES`. `__background__` used to be built
    // into `EMPTY` and left IN ITS PARENT'S CHILD LIST; `normalise`'s `diff` arm
    // then read an empty FIRST operand and returned `EMPTY` ("nothing to cut
    // away from"), so `difference(){ %cube(20); cylinder(h=40,r=5,center=true,
    // $fn=16); }` canonicalised to `<nothing>` on the oracle's side while the
    // binary's own STL — and ours — is the cylinder at 3061.4675 mm³.
    //
    // OpenSCAD REMOVES the child instead. `GeometryEvaluator::collectChildren3D`
    // (and `collectChildren2D`) open with `if (chnode->modinst->isBackground())
    // continue;`, so the list handed to the operator never contains it and THE
    // NEXT OPERAND IS PROMOTED TO FIRST; `applyToChildren3D` then hits its
    // `children.size() == 1 -> this is a noop` early return. A genuinely empty
    // but NON-background first operand is a different case and still yields
    // nothing (`manifold-applyops.cc`: `if (op == DIFFERENCE && !foundFirst) {
    // geom = nullptr; break; }`), which is what `normalise`'s rule is for — so
    // the two must not be conflated, and the removal is what separates them.
    //
    // ⚠ THE REMOVAL HAPPENS AT THE IMMEDIATE PARENT AND NOWHERE ELSE. Wrap the
    // same `%` in a transform and the transform node is not itself background:
    // it stays in the list, evaluates to nothing, and the difference DOES return
    // nothing. Measured at 2026.08.07 — `difference(){ translate([0,0,0])
    // %cube(20); cylinder(...); }` prints "Current top level object is empty".
    // So this is a child-list edit, never a "drop anything that came out empty".
    //
    // ⚠ `*` IS IN THIS LIST AND CANNOT REACH IT. `src/core/parser.y` deletes the
    // instantiation, so a disabled node is never in the tree the `.csg` is
    // written from — measured: `*cube(5); sphere(20,$fn=16);` emits the sphere
    // alone, with no `*` anywhere in the file. It is grouped with `%` because if
    // the writer ever did emit one, "not in the parent's child list" is the same
    // right answer for both. Nothing here relies on that; it is a defensive
    // default, and it is written down so it is not mistaken for coverage.
    let background = false;
    while (this.peek().t === 'p' && ['#', '!', '%', '*'].includes(this.peek().v)) {
      if (this.peek().v === '%' || this.peek().v === '*') background = true;
      this.p++;
    }
    const t = this.peek();
    if (t.t !== 'id') throw new Error(`csg: expected a module name, found ${JSON.stringify(t.v)}`);
    this.p++;
    const name = t.v;
    if (background) {
      this.args();
      if (this.eat('{')) {
        this.nodes(true);
        this.expect('}');
      } else {
        this.eat(';');
      }
      return { name: '__background__', args: { named: new Map(), pos: [] }, ch: [] };
    }
    const args = this.args();
    let ch = [];
    if (this.eat('{')) {
      ch = this.nodes(true);
      this.expect('}');
    } else {
      this.eat(';');
    }
    return { name, args, ch };
  }
  args() {
    this.expect('(');
    const named = new Map();
    const pos = [];
    while (!(this.peek().t === 'p' && this.peek().v === ')')) {
      if (this.peek().t === 'eof') throw new Error('csg: unterminated argument list');
      if (this.peek().t === 'id' && this.peek(1).t === 'p' && this.peek(1).v === '=') {
        const k = this.peek().v;
        this.p += 2;
        named.set(k, this.value());
      } else {
        pos.push(this.value());
      }
      if (!this.eat(',')) break;
    }
    this.expect(')');
    return { named, pos };
  }
  value() {
    const t = this.peek();
    if (t.t === 'num' || t.t === 'str') {
      this.p++;
      return t.v;
    }
    if (t.t === 'id') {
      this.p++;
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'undef') return undefined;
      return { sym: t.v };
    }
    if (t.t === 'p' && t.v === '[') {
      this.p++;
      const items = [];
      while (!(this.peek().t === 'p' && this.peek().v === ']')) {
        if (this.peek().t === 'eof') throw new Error('csg: unterminated vector');
        items.push(this.value());
        if (!this.eat(',')) break;
      }
      this.expect(']');
      return items;
    }
    // Anything else (a stray operator) is consumed so the parse cannot spin.
    this.p++;
    return { raw: t.v };
  }
}

const num = (v, d = 0) => (typeof v === 'number' ? v : d);
const bool = (v) => v === true;
const vec = (v, n, d) => {
  if (typeof v === 'number') return new Array(n).fill(v);
  if (!Array.isArray(v)) return new Array(n).fill(d);
  return Array.from({ length: n }, (_, i) => num(v[i], d));
};

/**
 * Parse a `.csg` file into the canonical (un-normalised) tree.
 * Throws on a malformed file — the caller turns that into PENDING, not a pass.
 */
export function csgToCanon(text) {
  const nodes = new CsgParser(lexCsg(text)).nodes(false);
  const built = rendered(nodes).map(buildCsg);
  return built.length === 0 ? EMPTY : U(built);
}

/**
 * The child list as the operator above it actually receives it — background
 * children REMOVED, not emptied.
 *
 * This is `GeometryEvaluator::collectChildren3D`'s opening `continue`, and the
 * whole reason it is a separate function is that it must be the ONLY place a
 * `__background__` can be consumed. Miss one call site and the node reaches
 * `buildCsg`, which throws rather than quietly rebuilding the defect: an
 * unparseable oracle tree is `PENDING`, and a `PENDING` fails `CAD1`. A `return
 * EMPTY` there would have been the silent form, and the silent form is what this
 * fix removes.
 */
const rendered = (ch) => ch.filter((c) => c.name !== '__background__');

function buildCsg(n) {
  const { name, args, ch } = n;
  const kids = rendered(ch).map(buildCsg);
  const A = (k, i, d) => (args.named.has(k) ? args.named.get(k) : args.pos[i] !== undefined ? args.pos[i] : d);

  switch (name) {
    case '__background__':
      throw new Error('csg: a background (%) node reached buildCsg — it must be removed from its parent\'s child list');
    case 'group':
    case 'union':
      return U(kids);
    // 🔴 `color()` IS A CONTAINER, NOT AN OPERATION, AND THAT IS A MEASURED
    // PROPERTY OF THE BINARY RATHER THAN A CONCESSION TO OUR IMPLEMENTATION.
    // Mapping it to `other` made every colour-wrapped model diverge on the tree
    // leg BY CONSTRUCTION — 46 of the 51 hardware divergences had their first
    // tree difference at an `OPAQUE color(...)` node — which is the harness
    // reporting its own vocabulary, not a defect in the thing measured.
    //
    // The evidence is `openscad 2026.08.07` itself, taken four ways, and none of
    // it is "our code does this":
    //   · `color("red") cube(3);` and `cube(3);` export BYTE-IDENTICAL ASCII STL
    //     (12 facets each) — colour contributes nothing to the solid.
    //   · as a DIFFERENCE OPERAND: `difference(){ color([0,0,0,1]) cube(10);
    //     translate([0,0,5]) cube(4); }` is byte-identical to the same program
    //     with the `color()` removed (28 facets) — so it does not change which
    //     operand is the minuend, and the transform distribution above is safe
    //     across it.
    //   · with ALPHA ZERO: `color("red", 0) cube(3);` still exports 12 facets —
    //     alpha is appearance, so there is no "invisible therefore absent" case
    //     that a pass-through would wrongly resurrect.
    //   · with MULTIPLE CHILDREN it behaves as a group: `color("blue"){ cube(3);
    //     translate([10,0,0]) cube(3); }` exports 24 facets, and an EMPTY
    //     `color("blue"){}` emits `color([0,0,1,1]);` with no children and no
    //     geometry — which `U([])` normalises to `EMPTY`, as it should.
    //
    // ⚠ WHAT THIS DOES NOT DO: it does not make a model that DROPS a colour-
    // wrapped subtree compare equal. A refusal that takes the subtree with it
    // still shows up as missing children under this union, on the same tree leg.
    // The only thing removed is the wrapper asymmetry.
    case 'color':
      return U(kids);
    // `render()` is the SAME DEFECT ONE MODULE ALONG, and it is mapped here
    // rather than left for the first file that trips it. It forces OpenSCAD to
    // evaluate a subtree eagerly instead of previewing it; on the EXPORT path
    // the whole tree is CGAL-evaluated anyway, so it changes nothing. Measured
    // at openscad 2026.08.07: `render() cube(3);` and `cube(3);` export
    // BYTE-IDENTICAL ASCII STL. OpenSCAD still writes it into the .csg, as
    // `render(convexity = 1)`, so leaving it opaque made every model that used
    // it diverge on the tree leg for the wrapper alone.
    //
    // ⚠ NOT covered by that measurement, and named because it is the limit of
    // it: `render()` genuinely changes the PREVIEW of self-intersecting
    // geometry. This harness only ever compares the export, so the mapping is
    // faithful to what it measures — and would not be to a preview comparison.
    // `hardware/cad/2bee_hive/2bee_hive_panels_18mm.scad` uses `render()` and is
    // outside the 68 files this harness reads, so this was latent, not idle.
    case 'render':
      return U(kids);
    case 'intersection':
      return I(kids);
    case 'difference':
      return kids.length ? { k: 'diff', ch: kids } : EMPTY;
    case 'multmatrix': {
      const rows = args.pos[0] ?? args.named.get('m') ?? [];
      const m = [];
      for (let r = 0; r < 3; r++) {
        const row = Array.isArray(rows[r]) ? rows[r] : [];
        for (let c = 0; c < 4; c++) m.push(num(row[c], r === c ? 1 : 0));
      }
      return { k: 'xform', m, ch: U(kids) };
    }
    case 'cube':
      return { k: 'prim', m: IDENT4, text: primCube(vec(A('size', 0, 1), 3, 1), bool(A('center', 1, false))) };
    case 'sphere':
      return {
        k: 'prim',
        m: IDENT4,
        text: primSphere(num(A('r', 0, 1), 1), num(A('$fn', -1, 0)), num(A('$fa', -1, 12), 12), num(A('$fs', -1, 2), 2)),
      };
    case 'cylinder':
      return {
        k: 'prim',
        m: IDENT4,
        text: primCylinder(
          num(A('h', -1, 1), 1),
          num(A('r1', -1, 1), 1),
          num(A('r2', -1, 1), 1),
          bool(A('center', -1, false)),
          num(A('$fn', -1, 0)),
          num(A('$fa', -1, 12), 12),
          num(A('$fs', -1, 2), 2),
        ),
      };
    case 'square':
      return { k: 'prim', m: IDENT4, text: primSquare(vec(A('size', 0, 1), 2, 1), bool(A('center', 1, false))) };
    case 'circle':
      return {
        k: 'prim',
        m: IDENT4,
        text: primCircle(num(A('r', 0, 1), 1), num(A('$fn', -1, 0)), num(A('$fa', -1, 12), 12), num(A('$fs', -1, 2), 2)),
      };
    default:
      // Everything else is OPAQUE. It is never approximated into a group, and
      // never dropped: an unmodelled `hull()` that silently became its children
      // would let a case compare equal on a shape we cannot compute.
      return {
        k: 'other',
        m: IDENT4,
        name,
        args: argSummary(args),
        ch: kids,
      };
  }
}

function argSummary(args) {
  const parts = [];
  for (const v of args.pos) parts.push(valStr(v));
  for (const [k, v] of args.named) parts.push(`${k}=${valStr(v)}`);
  return parts.join(',');
}

function valStr(v) {
  if (Array.isArray(v)) {
    // Point lists in `polygon`/`polyhedron` are unbounded; summarise by length
    // so an opaque node stays comparable without printing a megabyte.
    if (v.length > 8) return `[${v.length} items]`;
    return `[${v.map(valStr).join(',')}]`;
  }
  if (typeof v === 'number') return g6(v);
  if (typeof v === 'boolean') return String(v);
  if (v === undefined) return 'undef';
  if (v && typeof v === 'object' && 'sym' in v) return v.sym;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Our scene tree -> canonical form
//
// 🔴 `$fa` AND `$fs` ARE READ FROM THE PRIMITIVE, AND THIS PARAGRAPH USED TO SAY
// THE OPPOSITE. Until 2026-08-11 both were emitted as a hard-coded 12 and 2,
// justified here by a comment that read *"AND THAT IS NOT A CHEAT — `scad.ts`
// refuses `$fa`/`$fs` as primitive arguments and never reads them as
// variables"*. That premise died the same day it was written: `scad.ts` now
// carries `{fn, fa, fs}` as a triple on every curved primitive and `mesh.ts`
// tessellates with it. The comment outlived it and went on vouching for the
// constant — ⚠ *a comment explaining why a control is right is the least-audited
// thing in the repo*, and this one was the whole argument for two of `CAD1`'s
// four accepted divergences.
//
// The cost was two rows of `corpus/partial_fa_fs_{args,global}` reading
// `DIVERGES` with `TREE differs / MESH same`, on a defect the product did not
// have. 🔴 THE HARNESS WAS DIVERGING FROM ITSELF: it printed a tessellation our
// kernel had stopped using, then reported the difference as ours. Measured
// before the fix, and it is a RECORD-LEVEL match rather than an aggregate one —
// `sphere(r=10,$fa=5,$fs=0.5)` is **5180 triangles on BOTH sides** (840 is what
// 12/2 would give), volume 4175.517851 vs 4175.517816 (rel 8.4e-9), area rel
// 5.6e-9, and the bounding box is ±9.990482 on both sides, which is the
// 72-fragment inradius and not the 30-fragment 9.945.
//
// ⚠ WHAT IS NOT WEAKENED: a model whose tessellation genuinely differs still
// diverges, because both sides now print what they actually used. The
// `opts.fa`/`opts.fs` override is kept ahead of the primitive's own values so
// the `tree-fa` PLANT still has something to corrupt — a negative control that
// stopped being able to fire would be the expensive half of this change.
// ---------------------------------------------------------------------------

/** OpenSCAD's defaults, and ours. Used only where a primitive carries none. */
export const OUR_FA = 12;
export const OUR_FS = 2;

export function sceneToCanon(node, opts = {}) {
  // Per-primitive, NOT per-run: `p.fa`/`p.fs` are resolved at each call site by
  // `scad.ts`, so one file can legitimately hold several values.
  const faOf = (p) => opts.fa ?? p.fa ?? OUR_FA;
  const fsOf = (p) => opts.fs ?? p.fs ?? OUR_FS;
  // 🔴 THE GROUP-FLAG MARKERS BELOW ARE SPELLED AS THE ORACLE'S OWN `.csg`
  // WRITES THEM, MEASURED AGAINST openscad 2026.08.07 ON 2026-08-22 — field set,
  // field ORDER, and default values included, because `argSummary` prints the
  // oracle's side in source order and the comparison is byte-for-byte on
  // everything that is not a number. `scad.ts` carries these constructs as
  // optional flags on a `GroupNode` (extrude / offset / rotateExtrude / hull /
  // minkowski / resize / projection) and as three new primitive kinds
  // (polygon / polyhedron / text). Rendering them as the same `other` node
  // `buildCsg`'s default arm produces is what makes "both sides applied the
  // same operation" read as AGREEMENT and "our side dropped the wrapper" read
  // as a DIVERGENCE — the marker is never collapsed into its children, so a
  // hull we stopped computing cannot compare equal to its operands.
  //
  // ⚠ ONE NAMED LIMIT OF WHAT THE MARKER CAN STATE, IN THE SAFE
  // (false-red, never false-green) DIRECTION:
  //   · `rotateExtrude` carries `{angle, fn}` (the `$fn` in effect at the call
  //     site; carried since 2026-08-27 — before that it was dropped, which
  //     corpus/refuse_rotate_extrude measured as a tree DIVERGES). OpenSCAD
  //     also prints `start` (default 180 since the 2025 dev line); our kernel
  //     revolves from 0. For angle < 360 the start difference is invisible to
  //     this marker; no corpus or hardware case reaches it (checked 2026-08-22:
  //     the only `rotate_extrude` in either leg is `corpus/refuse_rotate_extrude`,
  //     at angle 360). A `$fa`/`$fs`-governed rotate_extrude still prints
  //     `$fn=0` against OpenSCAD's resolved count — false red, safe direction.
  //   · `text` resolves `halign`/`valign` EAGERLY where OpenSCAD's `.csg`
  //     prints the pre-resolution token. The map back is total on what our
  //     parser can store: 'left' -> "default" and 'baseline' -> "default"
  //     (OpenSCAD's documented default resolutions), everything else verbatim.
  //     An EXPLICIT `halign="left"` then prints "default" against OpenSCAD's
  //     "left" — a false red, the safe direction. `script` is printed as
  //     OpenSCAD's token ("Latn" for our hardcoded 'latin'); an explicit
  //     `script=`/`language=`/`direction=` in the source is DROPPED by scad.ts
  //     (they are accepted and ignored), and the divergence that produces is a
  //     true red naming a parser gap, not harness noise.
  const other = (name, namedEntries, ch) => ({
    k: 'other',
    m: IDENT4,
    name,
    args: argSummary({ named: new Map(namedEntries), pos: [] }),
    ch,
  });
  const fafss = () => [
    ['$fn', 0],
    ['$fa', opts.fa ?? OUR_FA],
    ['$fs', opts.fs ?? OUR_FS],
  ];
  const rec = (n) => {
    switch (n.kind) {
      case 'group': {
        const ch = n.children.map(rec);
        if (n.extrude) {
          const e = [['height', n.extrude.height]];
          if (n.extrude.center) e.push(['center', true]); // the .csg omits center=false (measured)
          // `$fn` carried on the node since 2026-08-27 (marker parity with the
          // .csg print); 0 = unspecified. No twist/scale reaches here — the
          // evaluator refuses those calls.
          return other('linear_extrude', [...e, ['$fn', n.extrude.fn ?? 0], ['$fa', opts.fa ?? OUR_FA], ['$fs', opts.fs ?? OUR_FS]], ch);
        }
        if (n.offset) return other('offset', [['r', n.offset.r], ...fafss()], ch);
        if (n.rotateExtrude) {
          return other(
            'rotate_extrude',
            // `$fn`/`start` are what the call site carried (carried since
            // 2026-08-27); `$fn: 0` = unspecified (OpenSCAD's own spelling),
            // matching the oracle's print of a `$fa`/`$fs`-only source.
            [['angle', n.rotateExtrude.angle], ['start', n.rotateExtrude.start ?? 180], ['convexity', 2], ['$fn', n.rotateExtrude.fn ?? 0], ['$fa', opts.fa ?? OUR_FA], ['$fs', opts.fs ?? OUR_FS]],
            ch,
          );
        }
        /* 🔴 `multmatrix` WAS MISSING FROM THIS LIST AND THE MATRIX WAS BEING
         * DROPPED. The group case fell through to `U(ch)`, so OUR side
         * serialised a `multmatrix()` node as a plain union — every source
         * using one has been tree-compared with its transform silently absent.
         * Caught 2026-09-02 when `mirror()` (which builds a multmatrix group)
         * reported `the trees differ (the solids happen to agree)`: openscad
         * had `M[-1,0,0,-5]`, we had `M[1,0,0,5]` — no reflection at all —
         * while the MESH was correct, because the mesher reads the field this
         * serialiser was ignoring.
         *
         * ⚠ THE SOLIDS AGREEING IS WHY IT SURVIVED. A harness comparing only
         * geometry would have called this file green; the tree leg is the only
         * thing that could see it, which is the argument for running both that
         * the oracle's own header makes. */
        if (n.multmatrix) {
          const { m: mm, t } = n.multmatrix;
          return {
            k: 'xform',
            m: [mm[0], mm[1], mm[2], t[0], mm[3], mm[4], mm[5], t[1], mm[6], mm[7], mm[8], t[2]],
            ch: U(ch),
          };
        }
        if (n.hull) return other('hull', [], ch); // the .csg prints hull() with no arguments
        if (n.minkowski) return other('minkowski', [['convexity', 0]], ch);
        if (n.projection) return other('projection', [['cut', n.projection.cut], ['convexity', 0]], ch);
        if (n.resize) {
          // OpenSCAD's writer prints the `auto` booleans as 0/1 (measured:
          // `auto=true` comes back as `[1,1,1]`), so our booleans are mapped
          // to numbers before they reach valStr's true/false spelling.
          return other(
            'resize',
            [
              ['newsize', [...n.resize.newsize]],
              ['auto', n.resize.auto.map((b) => (b ? 1 : 0))],
              ['convexity', 0],
            ],
            ch,
          );
        }
        return U(ch);
      }
      case 'boolean':
        if (n.op === 'union') return U(n.children.map(rec));
        if (n.op === 'intersection') return I(n.children.map(rec));
        return n.children.length ? { k: 'diff', ch: n.children.map(rec) } : EMPTY;
      case 'transform': {
        const m = n.op === 'translate' ? translateM(n.v) : n.op === 'scale' ? scaleM(n.v) : rotateM(n.v);
        return { k: 'xform', m, ch: U(n.children.map(rec)) };
      }
      case 'primitive': {
        const p = n.params;
        switch (p.kind) {
          case 'cube':
            return { k: 'prim', m: IDENT4, text: primCube(p.size, p.center) };
          case 'sphere':
            return { k: 'prim', m: IDENT4, text: primSphere(p.r, p.fn ?? 0, faOf(p), fsOf(p)) };
          case 'cylinder':
            return {
              k: 'prim',
              m: IDENT4,
              text: primCylinder(p.h, p.r1, p.r2, p.center, p.fn ?? 0, faOf(p), fsOf(p)),
            };
          case 'square':
            return { k: 'prim', m: IDENT4, text: primSquare(p.size, p.center) };
          case 'circle':
            return { k: 'prim', m: IDENT4, text: primCircle(p.r, p.fn ?? 0, faOf(p), fsOf(p)) };
          // The three primitives that ARE leaves in OpenSCAD's vocabulary too:
          // the .csg prints them as module calls, so both sides land on the
          // same `other` node. Our parser drops `paths` (polygon) and resolves
          // `convexity` away; the markers print OpenSCAD's defaults for those
          // fields, so a source that WRITES paths= diverges — true red, we
          // really do ignore it.
          case 'polygon':
            return other(
              'polygon',
              [
                ['points', p.points.map((pt) => [...pt])],
                ['paths', undefined],
                ['convexity', 1],
              ],
              [],
            );
          case 'polyhedron':
            return other(
              'polyhedron',
              [
                ['points', p.points.map((pt) => [...pt])],
                ['faces', p.faces.map((f) => [...f])],
                ['convexity', 1],
              ],
              [],
            );
          case 'text':
            return other(
              'text',
              [
                ['text', p.text],
                ['size', p.size],
                ['spacing', p.spacing],
                ['font', p.font],
                ['direction', p.direction],
                ['language', p.language],
                ['script', p.script === 'latin' ? 'Latn' : p.script],
                ['halign', p.halign === 'left' ? 'default' : p.halign],
                ['valign', p.valign === 'baseline' ? 'default' : p.valign],
                /* `p.fn`, NOT `fafss()`'s hardcoded 0 — `text()` carries `$fn`
                 * like every other faceted primitive since 2026-09-03. The
                 * hardcode was the serialiser half of the same drop; fixing
                 * only `scad.ts` would have left the tree still printing 0. */
                ['$fn', p.fn ?? 0],
                ['$fa', faOf(p)],
                ['$fs', fsOf(p)],
              ],
              [],
            );
        }
        throw new Error(`sceneToCanon: unknown primitive ${p.kind}`);
      }
      default:
        throw new Error(`sceneToCanon: unknown node kind ${n.kind}`);
    }
  };
  return rec(node);
}
