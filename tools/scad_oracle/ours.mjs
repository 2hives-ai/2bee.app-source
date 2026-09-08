// Our half: `web/src/cad/scad.ts` + `web/src/cad/mesh.ts`, run headless, and
// the planted defects that prove the comparison can go red — FOUR declared here
// (tree / mesh / both / refusal) plus `mesh.ts`'s own three `MESH_PLANTS`,
// imported rather than copied, which prove the AUDIT leg.
//
// 🔴 THIS FILE IMPORTS THE PRODUCT'S OWN TYPESCRIPT, NOT A COPY OF IT.
// `web/src/cad/*.ts` is imported directly and unmodified, so the harness
// exercises the same code the browser loads. A re-implementation here, or a
// build step that could drift, would make this a test of the harness. That is
// what forces the `--experimental-transform-types` flag on the command line:
// Node's default strip-only TypeScript mode cannot handle `scad.ts`'s parameter
// properties (`constructor(private toks: Token[])`), and full transform mode
// can. The flag is the price of testing the real file; see the README.

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { parseScad } from '../../web/src/cad/scad.ts';
import { makeLibraryHost, normalisePath } from '../../web/src/cad/library.ts';
import { meshScene, MESH_PLANTS } from '../../web/src/cad/mesh.ts';
// ⚠ `OUR_FA` IS DELIBERATELY NOT IMPORTED. It was, and it was used to fill an
// override on every run — see the note at the `sceneToCanon` call. Removing the
// import is what stops it being reached for again out of habit.
import { sceneToCanon } from './canon.mjs';
import { invariants, boxesOverlap, boxesTouch, touchEps } from './invariants.mjs';

/**
 * Deliberate defects, injected into OUR side only.
 *
 * 🔴 THESE EXIST FOR ONE REASON: a comparison nobody has watched go red is not
 * evidence of agreement, it is evidence of nothing. Each plant is aimed at ONE
 * leg of the comparison so the two legs are proved independently — a single
 * plant that reddened both would leave it unknown whether either leg works on
 * its own.
 */
export const PLANTS = {
  /** MESH leg only. Scale our triangles by 1.01 after the kernel has run.
   *  Volume moves 3.0e-2, three orders past REL_TOL; the tree is untouched, so
   *  any case that diverges under this plant diverged on geometry alone. */
  'mesh-scale': 'scale our mesh by 1.01 — MESH leg only, tree untouched',
  /** TREE leg only. Our canonical primitives claim $fa=11 instead of the 12
   *  `mesh.ts` actually assumes. Every curved primitive's leaf text changes;
   *  no vertex moves, so the mesh comparison is unaffected. */
  'tree-fa': 'our canonical leaves claim $fa=11 — TREE leg only, mesh untouched',
  /** BOTH legs. Drop the last child of the first boolean in our scene tree —
   *  the un-subtracted pocket, which is the defect this whole lane exists to
   *  stop reaching a spindle. Only cases containing a boolean can move. */
  'drop-child': 'drop the last child of the first boolean — BOTH legs, boolean cases only',
  /** 🔴 THE REFUSAL LEG. Drop every 2D operand out of a boolean before meshing,
   *  so `mesh.ts` stops refusing the node and hands back the 3D operand — the
   *  "match OpenSCAD" change, which is RIGHT for `union`/`difference` and
   *  EMITS A SOLID OPENSCAD DOES NOT for `intersection` and for a 2D-first
   *  boolean.
   *
   *  This plant exists because the previous agent made exactly this change in
   *  `web/src/cad/mesh.ts`, ran the full hardware leg over 103 real files, and
   *  the harness output was BYTE-IDENTICAL: a case that emits nothing scored
   *  `REFUSED` before either leg was compared, so nothing downstream of that
   *  branch ever ran. It is the negative control for the split that replaced
   *  it. */
  'drop-2d-operand':
    'drop 2D operands out of booleans so we stop refusing — the REFUSAL leg, `bool_2d_*` cases only',

  // 🔴 THE AUDIT LEG. These three are not this file's plants at all: they are
  // `mesh.ts`'s own `MESH_PLANTS`, exported by the product for exactly this and
  // NEVER PASSED BY ANYTHING until 2026-08-12. `meshScene(scene, plant)` has
  // always taken the second argument; `ours.mjs` has always called it with one.
  //
  // 🔴 WHAT THEY PROVE IS NOT "THE AUDIT WORKS", IT IS THAT THE HARNESS READS
  // IT. `ours.mjs` computed `audits` and `trust` on every run and `oracle.mjs`
  // consulted neither, so a solid our own kernel called `open` was compared on
  // volume and area and reported `SAME — tree and solid both agree`. Measured:
  // one face dropped from `prim_sphere_default_fn` moves volume rel 8.18e-6 and
  // from `partial_fa_fs_{args,global}` rel 5.03e-8 — under `REL_TOL`, and the
  // second pair under the float32 quantisation floor as well, so no tolerance
  // this harness could defend would have caught them.
  // `mesh-scale` cannot reach this state (it moves every vertex and the surface
  // stays closed), so no plant that existed before today could redden the new
  // consumer, and a consumer nobody has watched go red is not a consumer.
  //
  // ⚠ THE NAMES ARE THE PRODUCT'S, DELIBERATELY, AND ARE NOT RE-DECLARED HERE.
  // `MESH_PLANTS` is imported and asserted against this table below, so a plant
  // added to or removed from `mesh.ts` cannot leave this list silently stale —
  // which is the failure mode of every second copy in this harness's history.
  'drop-face':
    'delete one triangle after the kernel and before the audit — the AUDIT leg: `mesh.ts` must audit `open`, ' +
    'and the harness must refuse to compare a volume that has no referent',
  'duplicate-face':
    'duplicate one triangle — the AUDIT leg: three faces on one edge, audited `non-manifold`; volume is ' +
    'double-counted on that face and the invariants still cannot see it',
  'flip-face':
    "reverse one triangle's winding — the AUDIT leg: two faces traversing an edge the same way, audited " +
    '`non-manifold`. ⚠ The only one of the three that moves NO AREA AT ALL (measured: rel 0, exactly — the ' +
    'triangle is still there and still the same size), so half the invariants are blind to it by construction',
};

/**
 * The audit plants come from `mesh.ts` and are not re-declared here. If the
 * product adds or renames one, this fails LOUD at import rather than leaving a
 * plant name in the table that no longer corrupts anything.
 */
{
  const declared = new Set(Object.keys(PLANTS));
  const missing = MESH_PLANTS.filter((p) => !declared.has(p));
  if (missing.length) {
    throw new Error(
      `mesh.ts exports MESH_PLANTS this harness does not drive: ${missing.join(', ')} — ` +
        'a negative control the product provides and nobody runs is the exact defect these close',
    );
  }
}

const MESH_PLANT_SET = new Set(MESH_PLANTS);

/**
 * Where each plant's cases are ALLOWED to land, and the one verdict it must
 * reach. Consumed by `oracle.mjs`; a plant missing from here is fatal there.
 *
 * 🔴 THIS IS NOT A LOOSENING OF THE OLD "-> DIVERGES OR THE PLANT IS BROKEN"
 * RULE, IT IS THE SAME RULE MADE SAYABLE. The three geometry plants corrupt a
 * solid we were already emitting, so every case they touch can only get worse
 * and `DIVERGES` is the whole target set. `drop-2d-operand` corrupts whether we
 * emit AT ALL, and OpenSCAD's own answer differs by operator — so it moves
 * `bool_2d_operand_{difference,union}` to `SAME` (that edit really does match
 * the binary there) and `bool_2d_{operand_intersection,first_operand}` to
 * `DIVERGES` (that edit invents a solid). Both movements are the measurement.
 * `mustHit` is what stops a plant declaring its way out of firing.
 */
export const PLANT_TARGETS = {
  'mesh-scale': { targets: ['DIVERGES'], mustHit: 'DIVERGES' },
  'tree-fa': { targets: ['DIVERGES'], mustHit: 'DIVERGES' },
  'drop-child': { targets: ['DIVERGES'], mustHit: 'DIVERGES' },
  'drop-2d-operand': { targets: ['DIVERGES', 'SAME'], mustHit: 'DIVERGES' },
  // 🔴 `PENDING`, NOT `DIVERGES`, AND THAT IS THE ASSERTION RATHER THAN A
  // WEAKENING OF IT. An unclosed mesh does not disagree with the oracle, it
  // makes the comparison undecidable — volume and area are defined on a closed
  // orientable surface and on nothing else. A plant that landed these on
  // `DIVERGES` would be asserting that the harness measured a disagreement it
  // cannot measure. `PENDING` is also a verdict NO EXISTING PLANT CAN PRODUCE,
  // so a `SAME -> PENDING` movement cannot be confused with any other control.
  'drop-face': { targets: ['PENDING'], mustHit: 'PENDING' },
  'duplicate-face': { targets: ['PENDING'], mustHit: 'PENDING' },
  'flip-face': { targets: ['PENDING'], mustHit: 'PENDING' },
};

const SCALE_FACTOR = 1.01;
const PLANT_FA = 11;

/**
 * Run our pipeline over one source string.
 *
 * Returns a plain object; it never throws for a source-level problem, because
 * "our parser reported an error" and "our parser crashed" are different facts
 * and only the second one is a harness event. A crash propagates.
 */
/**
 * The library a case's `use`/`include` resolve against, built once per root.
 *
 * 🔴 WITHOUT THIS, THE COMPARISON NEVER HAPPENED FOR ANY REAL MODEL.
 * `runOurs` called `parseScad(src)` with no host, and `scad.ts`'s contract is
 * explicit: *"host — Absent ⇒ every import refuses."* So for any file carrying
 * `use <...>` — which is every product design in `hardware/cad/` — our side
 * refused all of them, emitted nothing, and the harness scored that
 * **`STRICTER`**: its word for *"we safely refuse where OpenSCAD emits."*
 *
 * ⚠ IT WAS RECORDED AS SAFETY AND IT WAS A MISSING LIBRARY. Measured
 * 2026-09-02 on `2bee_hive/2bee_hive_fan_box_panel_wcnc.scad`, the same source
 * both ways: with no host, **12 refusals, 0 primitives → STRICTER**; with a
 * host, **0 unsupported, 56 primitives**, and a solid that is 41.2 × 41.2 × 1
 * where OpenSCAD's is 121.5 × 407 × 18. One file, two verdicts, decided by an
 * argument the harness never passed.
 *
 * ⚠ AND IT COMPOUNDED WITH THE NON-RECURSIVE SCAN. That set was 93% `lib/` —
 * leaf files with few or no imports, the exact subset a no-host parse handles
 * correctly. Scan the files that need no library, parse without a library, and
 * the gate reads clean. Neither fix alone is honest: recursion without a host
 * multiplies files that refuse everything and calls it strictness.
 */
const LIBRARIES = new Map();
function libraryFor(root) {
  let lib = LIBRARIES.get(root);
  if (lib) return lib;
  const files = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__pycache__' || e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.scad')) {
        const key = normalisePath(relative(root, p));
        if (key) files.set(key, readFileSync(p, 'utf8'));
      }
    }
  };
  walk(root);
  lib = { files, rootName: basename(root), pickedAt: 0, skipped: [] };
  LIBRARIES.set(root, lib);
  return lib;
}

/**
 * @param ctx `{ root, path }` — the library root and the case's path RELATIVE
 *   to it. `path` is not decoration: `parseScad` resolves every spec against
 *   the directory of the importing file, so a case parsed with the wrong path
 *   resolves `../lib/box.scad` against the wrong folder and refuses imports
 *   that are present.
 */
export function runOurs(src, plant = null, ctx = null) {
  const parsed = ctx
    ? parseScad(src, { host: makeLibraryHost(libraryFor(ctx.root)), path: ctx.path })
    : parseScad(src);

  let scene = parsed.scene;
  // 🔴 TWO SCENES, AND THE SPLIT IS THE POINT OF `drop-2d-operand`. The canon is
  // built from `scene` and the mesh from `meshInput`; they are the same object
  // for every plant except this one. A change made in `mesh.ts` cannot move the
  // tree leg — `scad.ts` still parses the same program — so a plant that
  // corrupted BOTH would move the tree, land as `DIVERGES` for the wrong
  // reason, and prove nothing about whether the refusal leg can see anything.
  // The corpus's `bool_2d_*` cases have `tree same` precisely because the
  // refusal is a KERNEL refusal; that is the property under test.
  let meshInput = scene;
  if (plant === 'drop-child') {
    scene = structuredClone(scene);
    meshInput = scene;
    if (!dropFirstBooleanChild(scene)) {
      // Nothing to corrupt in this case. Say so rather than silently returning
      // an unplanted result that would read as "the plant did not fire".
      return { ...runOurs(src, null, ctx), plantApplied: false, plant };
    }
  }
  if (plant === 'drop-2d-operand') {
    meshInput = structuredClone(scene);
    if (!dropTwoDimensionalOperands(meshInput)) {
      return { ...runOurs(src, null, ctx), plantApplied: false, plant };
    }
  }

  // 🔴 THE AUDIT PLANTS ARE APPLIED BY `mesh.ts` ITSELF, NOT HERE. They corrupt
  // a WELDED mesh after the kernel and before the audit, which is a place this
  // file cannot reach and must not try to model — a plant re-implemented here
  // would be a control agreeing with the thing it controls. The scene tree is
  // untouched, so the TREE leg cannot move: every case these reach reads
  // `tree same`, and whatever they do to the verdict is the mesh side alone.
  const meshPlant = MESH_PLANT_SET.has(plant) ? plant : undefined;
  const meshed = meshScene(meshInput, meshPlant);

  const solids = meshed.parts.filter((p) => p.dim === 3 && p.triangles > 0);
  const flats = meshed.parts.filter((p) => p.dim === 2 && p.triangles > 0);

  // 🔴 OUR MODEL DOES NOT UNION TOP-LEVEL SIBLINGS, ON PURPOSE (mesh.ts header:
  // it matches OpenSCAD's F5 preview, not F6 render). OpenSCAD's STL export IS
  // the F6 union. So summing our parts' volumes equals the union's volume ONLY
  // when the parts do not overlap. When they do, the two sides are answering
  // different questions and the honest answer is that the mesh leg cannot
  // decide — not a pass, and not a failure of the kernel.
  //
  // ⚠ TOUCHING IS THE SAME DEFECT ONE NOTCH DOWN, AND IT IS NOT THE OVERLAP
  // CASE. `boxesOverlap` answers `<=`, so two solids in face contact are NOT
  // "overlapping" — and their summed VOLUME still equals the union's, because
  // contact has no volume. What the CGAL union deletes is the pair of
  // coincident CONTACT FACES, so the summed AREA counts them twice where the
  // oracle's STL counts them not at all. Measured against the binary
  // (2026-08-14, stacked cubes): union STL area 1000, summed area 1200; a
  // partial contact removes exactly 2x the contact area, volume untouched.
  // Ten hardware files sat in DIVERGES on exactly this — tree same, volume to
  // <= 5e-8 rel, bbox and centroid fine, ONLY area high on our side. So a
  // touching pair is reported separately (`touchingSolids`), and `oracle.mjs`
  // treats AREA as undecidable for that file while still comparing volume,
  // bbox and centroid — which is what stops this becoming a blanket amnesty
  // for any area that disagrees.
  const boxes = solids.map((p) => p.bounds).filter(Boolean);
  let overlapping = false;
  let touching = false;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) {
        overlapping = true;
      } else if (boxesTouch(boxes[i], boxes[j], touchEps(boxes[i], boxes[j]))) {
        touching = true;
      }
      if (overlapping && touching) break;
    }
    if (overlapping && touching) break;
  }

  let total = concatPositions(solids);
  if (plant === 'mesh-scale') {
    for (let i = 0; i < total.length; i++) total[i] *= SCALE_FACTOR;
  }

  // 🔴 THE UNPLANTED RUN PASSES NOTHING, AND PASSING `OUR_FA` HERE WAS HALF THE
  // DEFECT. `sceneToCanon` now reads `$fa`/`$fs` off each primitive — `scad.ts`
  // resolves them per call site — so an override supplied on every run pinned
  // the whole tree to 12 and made `corpus/partial_fa_fs_{args,global}` report a
  // tessellation our own kernel had stopped using. The override is what the
  // `tree-fa` plant needs and it exists for nothing else, so it is supplied for
  // nothing else. ⚠ `undefined` and not `null`: `sceneToCanon` uses `??`.
  const canon = sceneToCanon(scene, plant === 'tree-fa' ? { fa: PLANT_FA } : {});

  // 🔴 A REFUSAL CAN COME FROM EITHER STAGE, AND ONLY COUNTING THE PARSER'S
  // WOULD MISCLASSIFY THE KERNEL'S. `scad.ts` names what it cannot PARSE;
  // `mesh.ts` names what it cannot MESH — a determinant <= 0 transform, a 2D
  // operand inside a boolean, a node over the polygon or time budget. Those are
  // refusals under the same rule and by the same contract (nothing emitted,
  // named with its line), so the harness has to see both or it scores a correct
  // refusal as a divergence. The plant's own marker issue is excluded: it is a
  // label on a corrupted run, not a construct anybody refused.
  const meshRefusals = meshed.issues.filter(
    (i) => i.severity === 'refused' && !i.name.startsWith('PLANTED DEFECT'),
  );

  return {
    plant,
    // ⚠ AN AUDIT PLANT CORRUPTS SOLIDS, SO A CASE WITH NO SOLID HAD NOTHING
    // CORRUPTED — and that is most of the corpus, which is refusals. Reported
    // the same way `drop-child` reports it, because "the plant fired and the
    // verdict did not move" and "the plant had nothing to bite on" are
    // different facts and only the first one is a finding.
    plantApplied: meshPlant ? solids.length > 0 : plant !== null,
    errors: parsed.errors,
    unsupported: parsed.unsupported,
    meshRefusals,
    counts: parsed.counts,
    canon,
    tris: total,
    inv: invariants(total),
    solidParts: solids.length,
    flatParts: flats.length,
    overlappingSolids: overlapping,
    touchingSolids: touching,
    issues: meshed.issues,
    trust: meshed.trust,
    trustDetail: meshed.trustDetail,
    audits: solids.map((p) => ({ id: p.id, verdict: p.audit ? p.audit.verdict : null, line: p.line })),
    stats: meshed.stats,
  };
}

function concatPositions(parts) {
  let n = 0;
  for (const p of parts) n += p.positions.length;
  const out = new Float64Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p.positions, o);
    o += p.positions.length;
  }
  return out;
}

/**
 * The dimension of a subtree, in OpenSCAD's sense: 2 if it can only ever be an
 * outline, 3 if anything under it is a solid, 0 if it holds no geometry at all.
 *
 * ⚠ THIS IS THE PLANT'S APPROXIMATION OF `mesh.ts`'s `OperandDim`, NOT A COPY OF
 * IT, and it is deliberately cruder: a plant only has to be a faithful model of
 * the EDIT ("drop the 2D operand"), and importing the product's own dimension
 * logic here would make the control agree with the thing it is controlling.
 */
function subtreeDim(node) {
  if (node.kind === 'primitive') {
    const k = node.params && node.params.kind;
    return k === 'square' || k === 'circle' ? 2 : 3;
  }
  let dim = 0;
  for (const c of node.children ?? []) {
    const d = subtreeDim(c);
    if (d === 3) return 3;
    if (d === 2) dim = 2;
  }
  return dim;
}

/**
 * Drop every operand of every boolean whose subtree is 2D. Returns true if any
 * operand was actually removed — an unplanted case must say so rather than
 * silently returning a clean result that reads as "the plant did not fire".
 */
function dropTwoDimensionalOperands(node) {
  let hit = false;
  if (node.kind === 'boolean') {
    const before = node.children.length;
    node.children = node.children.filter((c) => subtreeDim(c) !== 2);
    if (node.children.length !== before) hit = true;
  }
  if (node.kind !== 'primitive') {
    for (const c of node.children ?? []) if (dropTwoDimensionalOperands(c)) hit = true;
  }
  return hit;
}

/** Depth-first: find the first boolean with >= 2 children and drop the last. */
function dropFirstBooleanChild(node) {
  if (node.kind === 'boolean' && node.children.length >= 2) {
    node.children.pop();
    return true;
  }
  if (node.kind !== 'primitive') {
    for (const c of node.children) if (dropFirstBooleanChild(c)) return true;
  }
  return false;
}
