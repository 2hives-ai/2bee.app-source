#!/usr/bin/env node
// =============================================================================
// scad_oracle — measure our OpenSCAD subset against real OpenSCAD.
//
// RUN IT:
//
//   node --experimental-transform-types --disable-warning=ExperimentalWarning \
//     tools/scad_oracle/oracle.mjs
//
//   ... --hardware              also run hardware/cad/ (READ ONLY — the run
//                               PRINTS its own population; no count here, see below)
//   ... --cut-only              only the _wcnc CNC cut files
//   ... --hardware-root <dir>   scan this tree instead of the working tree —
//                               typically an extracted commit, for reproducibility
//   ... --hardware-ref <hash>   the CONTENT id of that tree, for the provenance line
//   ... --progress              one stderr line per case: index, rss, heap, name
//   ... --timeout <ms>          per-invocation limit for the openscad binary
//   ... --plant mesh-scale      negative control: prove the comparison can go red
//   ... --list-plants           what each plant corrupts and which leg it proves
//   ... --only <substring>      filter cases by name
//   ... --json <path>           write the full result, every number, machine-readable
//
// 🔴 THIS BLOCK WAS STALE IN BOTH WAYS, FOUND 2026-09-04 BY ceo's QUESTION VIA
// `ml`: does the code's SELF-DESCRIPTION match its BEHAVIOUR? It listed five of
// the ten flags this file reads — `--cut-only` and `--timeout` predate me,
// `--hardware-root`, `--hardware-ref` and `--progress` I ADDED THE SAME DAY AND
// DID NOT DOCUMENT — and it said "68 real files" when the population is 303.
//
// ⚠ `ml`'s finding is why this matters more than tidiness: a DOCUMENT copied
// faithfully from a stale help string MATCHES it, and a doc-vs-code check reads
// that as clean. A gate-doc sweep compares prose to DEFINITIONS; this drift is
// in the code's own prose ABOUT ITSELF, which neither side of that check touches.
//
// ⚠ AND NO COUNT LIVES HERE ANY MORE. The run prints its own `population:` line;
// a number in a comment is a second copy that rots, which is what "68" was.
//
// (The flag is not decoration. `ours.mjs` imports `web/src/cad/*.ts` directly so
// the harness tests the product's own file rather than a copy; Node's default
// strip-only TypeScript mode rejects `scad.ts`'s constructor parameter
// properties, and full transform mode accepts them. Without the flag the
// harness exits 2 and says so — it does not fall back to anything.)
//
// WHAT IT MEASURES — two legs, and neither substitutes for the other:
//
//   TREE  Does our evaluator understand the same PROGRAM? Both sides are
//         reduced to OpenSCAD's own CSG vocabulary and compared as text. This
//         is what catches wrong scoping, wrong `for` ranges, wrong defaults and
//         wrong `$fn` resolution — errors a mesh comparison can mask whenever
//         two different trees happen to bound similar solids.
//   MESH  Does our kernel produce the same SOLID? Never by comparing STL bytes
//         (vertex order, triangulation and formatting all differ legitimately)
//         but by comparing volume, surface area, bounds and centroid against a
//         derived tolerance. See `invariants.mjs` for where the number is from.
//
// VERDICTS — exactly one per case:
//
//   SAME      both legs agree within tolerance
//   REFUSED-BOTH  we named the construct and emitted nothing, AND OPENSCAD
//             PRODUCES NOTHING HERE EITHER. The refusal costs nothing but the
//             reason. This is the only half of the old `REFUSED` that was ever
//             safe, and until 2026-08-11 it was the only half that was reported.
//   STRICTER  we named the construct and emitted nothing, AND OPENSCAD PRODUCES
//             GEOMETRY — a solid it exports, or a 2D outline it draws. 🔴 A
//             capability we do not have, which scored as safety for as long as
//             the verdict was awarded before the oracle was consulted. Every one
//             is a named, dated `STRICTER_LEDGER` entry; unlisted is a NO-GO.
//   DIVERGES  we produced geometry and it does not match. 🔴 the serious one.
//   ERROR     our evaluator reported errors, or our code threw
//   PENDING   could not be decided — and PENDING IS NOT A PASS. The overall
//             verdict of a run containing one is INCOMPLETE, never GO. Includes
//             the case where OUR OWN KERNEL audits a solid as open / seams /
//             non-manifold: volume and area have no referent on a surface that
//             is not closed, so the invariant comparison is undecidable rather
//             than disagreeing. See `meshLeg`.
//
// EXIT: 0 GO · 1 NO-GO (a DIVERGES or an ERROR) · 3 INCOMPLETE (a PENDING) ·
//       2 the harness itself could not start.
// =============================================================================

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 🔴 EVERY LOCAL IMPORT IS DYNAMIC, AND THAT IS LOAD-BEARING — see the guard below.
// These were `import ... from` and a static import is hoisted above all module
// code, so the try/catch that exists to explain a missing flag COULD NOT RUN.
let exportCsg, exportStl, openscadVersion, DEFAULT_TIMEOUT_MS;
let csgToCanon, normalise, serialise, serialiseEq, firstDiff, EMPTY;
let invariants, compareInvariants, quantisationFloor, ngonDeficit, REL_TOL;

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = resolve(HERE, '../..');
const REPO = resolve(LANE, '../..');

/**
 * WHAT TREE STATE THIS RUN ACTUALLY READ.
 *
 * 🔴 THIS GATE SCANS THE WORKING TREE, AND THE FLEET SHARES ONE. So it can
 * observe a state that never existed in git and cannot be replayed from it —
 * which is worse than a wrong answer, because it is UNREPRODUCIBLE BY
 * CONSTRUCTION.
 *
 * Not hypothetical. On 2026-09-02 this leg reported
 * `2bee_pnp/pnp_drum_housing_3d.scad` erroring on an undefined
 * `D_MOTOR_CLOCK`, and I logged it as a defect in our reader. `cad` measured
 * both endpoints and showed no COMMITTED state ever had that reference: at
 * `0f643fa769` the constant was `RETIRED_D_MOTOR_CLOCK` and its only consumer
 * did not exist; a later founder-override commit restored both. **We had read
 * the middle of a seven-file rename.** Verified here: 0 matches in the housing
 * file at that commit, and `hardware/cad/` dirty at the time of writing.
 *
 * ⇒ So every run records the SHA and whether the scanned subtree was DIRTY, and
 * says so beside its findings. It does not make the scan reproducible — that
 * would mean scanning a committed ref, which is a bigger change and `cad`'s
 * suggestion — but it makes an anomaly ATTRIBUTABLE, which is the difference
 * between "chase this in our reader" and "re-run it when the tree settles".
 */
function treeState() {
  // 🔴 DESCRIBES THE TREE THAT WAS ACTUALLY SCANNED, NOT THE ONE THIS FILE SITS
  // IN. Both `git` calls used to run with `cwd: REPO` unconditionally, so a run
  // redirected by `--hardware-root` printed the WORKING tree's SHA and dirty
  // count beside results measured from somewhere else entirely — a provenance
  // line that is confidently about the wrong artefact. Caught 2026-09-04 on the
  // first redirected run, in this tool's own header, one command after the flag
  // was added: the line read `hardware/cad DIRTY (13 uncommitted)` for a scan of
  // a clean detached worktree.
  //
  // A worktree has its own HEAD, so asking git from INSIDE the scanned root is
  // what makes the answer true for either case rather than only the default one.
  // 🔴 PREFER AN EXPLICIT CONTENT ID OVER `git rev-parse HEAD`. When the caller
  // extracted a subtree it knows exactly WHAT it handed us, and HEAD is a
  // different identity: measured 2026-09-04, the content read was cad tree
  // `bcad6ec592bc` while HEAD had moved to an unrelated commit, and the line
  // still said *"findings are replayable from this commit"*. Naming a commit
  // whose `hardware/cad` you did not read is a provenance claim about the wrong
  // artefact — the same defect this function was already fixed for once, when it
  // reported the working tree while scanning a worktree.
  const refArg = process.argv.includes('--hardware-ref')
    ? process.argv[process.argv.indexOf('--hardware-ref') + 1]
    : null;
  if (refArg) return { sha: refArg.slice(0, 12), dirtyFiles: 0, contentId: true };
  const cwd = HARDWARE_CAD;
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }).trim();
    } catch {
      return null;
    }
  };
  const sha = run(['rev-parse', 'HEAD']);
  // `.` rather than a repo-relative path: relative to the scanned root, which is
  // the directory the question is about in both cases.
  const dirty = run(['status', '--porcelain', '--', '.']);
  return {
    sha: sha ? sha.slice(0, 12) : 'UNKNOWN',
    dirtyFiles: dirty === null ? null : dirty ? dirty.split('\n').filter(Boolean).length : 0,
  };
}
/**
 * The `hardware/cad/` tree to scan.
 *
 * 🔴 DEFAULTS TO THE SHARED WORKING TREE, WHICH IS NOT REPRODUCIBLE. Every other
 * lane writes into `hardware/cad/` while this runs, so a result is a statement
 * about a tree that no longer exists — `treeState()` records the SHA and the
 * dirty count, but that is ATTRIBUTION, not reproducibility (`cad`'s point,
 * 2026-09-02, carried in this lane's OPEN block since 09-03).
 *
 * `--hardware-root <dir>` points the hardware leg at any checkout — typically a
 * `git worktree` of a named commit — so a past population can be re-measured
 * with TODAY's reader. That separation is the whole value: comparing
 * old-files/new-reader against both the pinned baseline and today's run splits a
 * moved number into "our reader changed" and "their models changed", which no
 * single run can do.
 *
 * ⚠ IT DOES NOT MOVE THE CORPUS. `tools/scad_oracle/corpus/` is this lane's own
 * and travels with the code under test; only the hardware leg is redirected, and
 * the header prints the root so a redirected run cannot be read as a normal one.
 */
// Reads `process.argv` rather than the `argv`/`opt` helpers below: those are
// declared further down the file and a `const` cannot be read before it is
// initialised. Kept literal here for that reason, not by preference.
const HARDWARE_CAD = resolve(
  process.argv.includes('--hardware-root')
    ? process.argv[process.argv.indexOf('--hardware-root') + 1] ?? join(REPO, 'hardware/cad')
    : join(REPO, 'hardware/cad')
);
const OPENSCAD = process.env.OPENSCAD_BIN || 'openscad';

// ---------------------------------------------------------------------------
// The flag check. A harness that cannot import the product must say so and
// stop; it must never fall back to anything, because the fallback would be a
// harness testing itself.
// ---------------------------------------------------------------------------

let runOurs;
let PLANTS;
let PLANT_TARGETS;
try {
  // 🔴 ORDER IS IRRELEVANT; BEING INSIDE THE `try` IS THE WHOLE POINT.
  // `canon.mjs` imports `web/src/cad/mesh.ts` and `ours.mjs` imports `scad.ts`,
  // `library.ts` and `mesh.ts`. Under a bare `node` those files parse only with
  // `--experimental-transform-types` (`mesh.ts` uses a TypeScript parameter
  // property), and WITHOUT it the graph throws at parse time.
  //
  // ⚠ MEASURED 2026-09-04, AND IT IS WHY THIS SHAPE CHANGED. `canon.mjs` was a
  // STATIC import at the top of this file. A static import is resolved and
  // parsed BEFORE any of this module's body executes, so a missing flag killed
  // the process inside the module loader — **the catch below never ran**. The
  // operator got a raw V8 stack and `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` from a
  // file they have no reason to connect to a command-line flag, and, worse,
  // exit status **1** — which in this harness means RAN AND FOUND PROBLEMS, not
  // COULD NOT RUN. The one thing the guard was written to prevent.
  //
  // ⚠ A GUARD ON A DYNAMIC IMPORT IS DEFEATED BY A STATIC IMPORT OF THE SAME
  // DEPENDENCY ANYWHERE ELSE IN THE GRAPH. Adding `import x from './canon.mjs'`
  // back at the top of this file silently disarms everything below. Gate
  // `CAD1`/`CAD1H` carries a limb that runs this file with NO flag and asserts
  // the STATUS is 2, so that regression is caught by consequence rather than by
  // anyone remembering this comment.
  ({ exportCsg, exportStl, openscadVersion, DEFAULT_TIMEOUT_MS } = await import('./openscad.mjs'));
  ({ csgToCanon, normalise, serialise, serialiseEq, firstDiff, EMPTY } = await import('./canon.mjs'));
  ({ invariants, compareInvariants, quantisationFloor, ngonDeficit, REL_TOL } = await import(
    './invariants.mjs'
  ));
  ({ runOurs, PLANTS, PLANT_TARGETS } = await import('./ours.mjs'));
} catch (e) {
  const msg = String(e && e.message);
  console.error('🔴 scad_oracle could not load our own pipeline, so NOTHING was measured.\n');
  console.error(`   ${msg}\n`);
  if (/TypeScript|ERR_UNSUPPORTED|ERR_UNKNOWN_FILE_EXTENSION/i.test(msg)) {
    console.error('   Almost certainly the missing flag. Run:\n');
    console.error('     node --experimental-transform-types --disable-warning=ExperimentalWarning \\');
    console.error('       tools/scad_oracle/oracle.mjs\n');
  }
  process.exit(2);
}

// ---------------------------------------------------------------------------
// THE STRICTER LEDGER — every refusal that costs a capability, named and dated.
//
// Same shape as `CAD1_KNOWN` in `gates/slicer_gate_check.mjs`, and for the same
// reason: a gap that is written down is a decision, and a gap that is merely
// counted is a habit. An entry says WHAT OpenSCAD does that we do not, and WHEN
// somebody chose to accept that. Anything STRICTER and unlisted is a NO-GO.
//
// FOUR PROPERTIES, three of which are failures rather than notes:
//   1. NAME-EXACT ON THE CORPUS. The corpus is this lane's own fixed set, so a
//      new capability gap has to be written here by name before a run is clean.
//   2. `openscad` IS PART OF THE CLAIM, not decoration — `solid` means the
//      binary exports an STL for that file, `outline` means it draws 2D and
//      exports none. A case that changes which one it is has changed meaning,
//      and the entry stops matching.
//   3. A STALE ENTRY FAILS. If a case stops being STRICTER the entry must be
//      REMOVED, or the ledger keeps headroom that would absorb the next gap in
//      silence. ⚠ Corpus only — see 4.
//   4. THE HARDWARE LEG IS SCORED IN ONE DIRECTION ONLY. `hardware/cad/` is
//      ANOTHER LANE'S TREE: a file may legitimately be renamed or deleted, and
//      failing on that would train the "just edit the list" habit this whole
//      structure exists to prevent. So an unlisted hardware STRICTER is a NO-GO
//      (it is new exposure) while a stale hardware entry prints ⚠ and does not
//      fail. That asymmetry is a hole, and it is named rather than hidden: a
//      hardware file that stops being STRICTER because it stopped being READ is
//      invisible here, and only the CAD1H count in `gates/` would notice.
//
// 🔴 WHAT A LEDGER ENTRY IS NOT: permission to keep the gap. `refuse_hull` on
// this list does not mean hull is out of scope; it means the cost of refusing it
// is measured (OpenSCAD hands the user a solid, we hand them nothing) and
// recorded, so the next reader argues with a fact instead of discovering one.
// 🔴 THE FIRST THING THIS LEDGER MEASURED, AND IT IS NOT WHAT THE SPLIT WAS
// EXPECTED TO FIND: of the SIXTEEN refusals the harness was scoring as safe on
// 2026-08-11, **sixteen are capability gaps and zero are agreement.** The only
// `REFUSED-BOTH` in the whole suite is a case written for this pass. The word
// "REFUSED" had been carrying "OpenSCAD does not do this either" for every one
// of them, and the binary says otherwise on all sixteen.
//
// Facet counts below are ASCII-STL triangles, from `openscad 2026.08.07` on the
// case file itself. `outline` entries export NO file — the binary says "Current
// top level object is not a 3D object" and draws a 2D result we do not draw.
const STRICTER_LEDGER = {
  // --- the 2D-operand family, established at the source AND the binary in
  // d1d953317c and pinned by five corpus cases written for this pass. The fix
  // is NOT "drop the 2D operand": right for these two, and it invents a solid
  // for `bool_2d_operand_intersection` / `bool_2d_first_operand`.
  // ⚠ `bool_2d_all_operands` LEFT this family 2026-08-22: the kernel now
  // computes the 2D boolean itself and the case reads SAME (2D on both sides,
  // trees agree). The note on its old entry — "stops being cosmetic the day
  // linear_extrude lands" — is exactly what happened; the gap it named is
  // closed, not renamed.
  'corpus/bool_2d_operand_difference': {
    since: '2026-08-11',
    openscad: 'solid',
    why: 'openscad replaces the 2D child with an EMPTY 3D operand in place, a difference skips it, and it exports the minuend UNCHANGED — 12 facets, the pocket never cut. We refuse the whole node, so the user gets nothing where openscad gives them a part that looks finished',
  },
  'corpus/bool_2d_operand_union': {
    since: '2026-08-11',
    openscad: 'solid',
    why: 'same shape on the other operator, and a genuinely different code path — union filters empty operands out before the boolean (GeometryEvaluator.cc:175-181) rather than carrying them in. 12 STL facets of plain cube; we draw nothing',
  },
  'corpus/bool_2d_first_operand': {
    since: '2026-08-11',
    openscad: 'outline',
    why: 'the first operand fixes the node at 2D and every 3D child is replaced by an empty one; openscad draws the 2D result and exports no solid. ⚠ LISTED AGAINST THE BRIEF, which called this one agreement because "openscad produces no solid either" — equally true of bool_2d_all_operands, which the same brief lists as a live gap. 🔴 THIS ENTRY USED TO END "the binary answers identically for the two, so no consult can separate them", which is FALSE and was measured false 2026-08-12: the SVG door exits 0 for both and writes 820 B / 1 contour here against 994 B / 2 contours there, and even the STL door differs by the two "Mixing 2D and 3D objects" warnings. The verdict is unchanged and right; the sentence asserted a limit of the WORLD from a limit of the one door openscad.mjs opens. See the case header',
  },

  // --- the kernel's own refusals -----------------------------------------
  // 🔴 2026-08-22: THIRTEEN ENTRIES LEFT THIS LEDGER, and the reason each left
  // is a measurement, not a tidy-up. Between 2026-08-19 and 2026-08-21 the
  // kernel (web/src/cad/scad.ts + mesh.ts) implemented hull, minkowski,
  // linear_extrude, rotate_extrude, offset, projection, resize, polygon,
  // polyhedron, intersection_for, list comprehensions, 2D booleans over all-2D
  // operands and determinant<=0 transforms; `canon.mjs`'s sceneToCanon was
  // taught the new group flags and primitive kinds the same day the entries
  // came out (before that, the cases read DIVERGES/ERROR on the SERIALISER
  // alone). Where each case stands now, measured:
  //   refuse_linear_extrude, refuse_resize, refuse_intersection_for,
  //   refuse_list_comprehension, bool_2d_all_operands, edge_negative_scale,
  //   refuse_offset, refuse_polygon, refuse_projection   -> SAME
  //   refuse_hull (non-manifold), refuse_minkowski (open) -> PENDING on the
  //     audit leg: our kernel's own audit says the surface is not closed, and
  //     a volume with no referent is never compared. NOT green.
  //   refuse_polyhedron -> DIVERGES: the corpus file's faces wind INWARD and
  //     openscad exports them as given (signed volume -266.67); our kernel
  //     emits the same shape outward (+266.67). Same area/bbox/centroid, the
  //     orientation differs, and orientation is what a CAM normal is.
  //   refuse_rotate_extrude -> DIVERGES on the TREE: the source passes
  //     $fn=32 to rotate_extrude; scad.ts drops it (GroupNode.rotateExtrude
  //     carries only {angle}) and mesh.ts revolves at a fixed 48/turn. The
  //     marker prints $fn=0, the oracle prints $fn=32 — a true red.
  // refuse_minkowski's entry was removed earlier (885513b227); the rest came
  // out with the canon.mjs change. Any of these regressing to a refusal is an
  // UNLISTED STRICTER and a NO-GO, which is the ratchet doing its job.
  /* `corpus/refuse_mirror` WAS HERE AND IS GONE — RATCHETED OUT 2026-09-02,
   * because `mirror()` is implemented and the case now reads SAME (tree AND
   * solid agree). Its old `why` was: *"mirror() exports 12 facets. It is the
   * same determinant question as edge_negative_scale arriving through a
   * different door, and it appears in hardware/cad/"* — and that was right,
   * including about the door: fixing it required correcting where the winding
   * flip happens for ANY negative-determinant transform, which `scale([-1,1,1])`
   * was already getting wrong in shipped code.
   *
   * ⚠ THE FIXTURE IS RENAMED `mirror_reflection.scad` IN THIS SAME COMMIT.
   * `refuse_mirror` would now be a label asserting the opposite of what the
   * case measures — the same disease as CAD1H's "73 files this company cuts"
   * and my own "_wcnc" miscount, both caught today. A corpus case is discovered
   * by filename, so the rename is the case name. */
  'corpus/refuse_text': {
    since: '2026-08-11',
    openscad: 'outline',
    why: 'text() renders glyphs through fontconfig and we render nothing — ⚠ STILL TRUE 2026-08-22, re-measured when the rest of the family left the ledger: scad.ts PARSES text (the trees agree) but mesh.ts refuses `text()` at the kernel stage and emits nothing, so the gap moved from "unparseable" to "unmeshable" and the entry stays',
  },

  // --- the hardware leg. Scored in ONE direction (see the header): unlisted is
  // a NO-GO, stale prints a warning, because these files belong to `cad`.
  'hardware/2bee_scnc.scad': {
    since: '2026-08-11',
    openscad: 'solid',
    why: 'the CNC table model: openscad exports 42008 facets and we export nothing. Refused on `include`/`use` (the harness passes no ScadFileHost — a limit of THIS instrument, named in the README), plus echo() and linear_extrude()',
  },
  'hardware/hive_top_assembly.scad': {
    since: '2026-08-11',
    openscad: 'solid',
    why: 'the hive top assembly: openscad exports 21978 facets and we export nothing. Refused entirely on `use <>` imports, so this row measures the harness\'s missing file host as much as the subset — do not read it as six missing constructs',
  },
  // 🔴 2026-08-22 — TWO MORE, surfaced (not created) by teaching the oracle
  // serializer the ten constructs the 08-19→21 series implemented: both files
  // used to hide inside DIVERGES/PENDING on the harness's own crash, and now
  // measure as what they are — files we REFUSE where the binary cuts geometry.
  'hardware/lib/human_ref.scad': {
    since: '2026-08-22',
    openscad: 'solid',
    why: 'the kernel refuses the `union()` over `hull()` children whose meshes audit NON-MANIFOLD — the same broken-hull defect that holds corpus/refuse_hull at audit-PENDING, propagated one node up; openscad exports 4456 facets. The tree ALSO differs at 1e-4 rel in one rotation-matrix entry (0.237740 vs 0.237716 — past serialiseEq\'s 1e-5, so not the 6-sig-fig rounding class), a second and independent divergence this entry does not explain away',
  },
  // 🔴 BOTH ARRIVED 2026-09-04 AS A CONSEQUENCE OF FIXING A DEFECT, WHICH IS
  // WHY THEY ARE HERE RATHER THAN QUIETLY IN THE COUNT. `linear_extrude` and
  // `rotate_extrude` used to evaluate their child in WORLD space and so produced
  // the wrong solid under any enclosing rotation; both now evaluate in the LOCAL
  // frame. These two files previously DIVERGED — we emitted a plausible wrong
  // part — and now the kernel REFUSES their `intersection()` outright.
  //
  // ⚠ THE MOVE IS SAFER AND IT IS STILL A CAPABILITY GAP. A refusal emits
  // nothing; a divergence emits something a machine would cut. But openscad
  // exports 48 facets for these, so we cannot do something it can, and that is
  // what this ledger is for.
  //
  // ⚠ AND IT POINTS AT A SECOND DEFECT I HAVE NOT DIAGNOSED: the geometry these
  // files produce is now CORRECT, and it is the correct geometry that trips the
  // kernel's intersection refusal. Whatever that refusal is protecting against,
  // it is now firing on a shape openscad handles. Not investigated; named here
  // so the next reader does not take the ledger entry as the end of the story.
  'hardware/2bee_cnc_machine/probe_upright_contact.scad': {
    since: '2026-09-04',
    openscad: 'solid',
    why: 'the kernel refuses this `intersection()` and emits nothing; openscad exports 48 facets, exit 0. It DIVERGED until the extrude local-frame fix, so this is a divergence traded for a refusal — safer, and still a capability we lack',
  },
  'hardware/2bee_cnc_machine/probe_upright_x_rail.scad': {
    since: '2026-09-04',
    openscad: 'solid',
    why: 'same kernel `intersection()` refusal and the same origin as probe_upright_contact — it moved DIVERGES -> STRICTER when the extrudes began evaluating in the local frame, so the refusal fires on geometry that is now CORRECT',
  },
  'hardware/lib/inwall_m8.scad': {
    since: '2026-08-22',
    openscad: 'solid',
    why: 'refused on the `%` modifier, `str()` and a kernel-stage `difference()`; openscad exports 3500 facets. The `%` ghost bodies are display-only in openscad, but `str()` (in `echo`) and the difference refusal are real capability gaps, not cosmetics',
  },
};

{
  // An accepted gap with no reason and no date is a name wearing a comment.
  // FATAL rather than a failed verdict: a malformed ledger means the run below
  // is scoring against something nobody wrote a sentence about.
  const bad = [];
  for (const [name, e] of Object.entries(STRICTER_LEDGER)) {
    if (!e || typeof e.why !== 'string' || e.why.trim().length < 20) bad.push(`${name}: no usable \`why\``);
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.since ?? '')) bad.push(`${name}: no \`since\` date`);
    if (!e || (e.openscad !== 'solid' && e.openscad !== 'outline')) {
      bad.push(`${name}: \`openscad\` must be 'solid' or 'outline' — what the binary actually produces`);
    }
  }
  if (bad.length) {
    console.error(`🔴 malformed STRICTER_LEDGER — an accepted capability gap must name itself and its date:`);
    for (const b of bad) console.error(`   ${b}`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, d = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

if (flag('--list-plants')) {
  console.log('Planted defects — each aims at ONE leg so the legs are proved independently:\n');
  for (const [k, v] of Object.entries(PLANTS)) console.log(`  ${k.padEnd(12)} ${v}`);
  process.exit(0);
}

const plant = opt('--plant');
if (plant !== null && !(plant in PLANTS)) {
  console.error(`unknown plant ${JSON.stringify(plant)}. Known: ${Object.keys(PLANTS).join(', ')}`);
  process.exit(2);
}
const only = opt('--only');
/**
 * 🔴 `--cut-only` IS THE DEV-LOOP SUBSET, AND IT IS CHOSEN BY CONSEQUENCE.
 *
 * The full hardware leg takes ~25 minutes (measured 2026-09-02: 24m58s over
 * 584 files) and moves to the NIGHTLY cadence per ceo's ruling. What a person
 * editing CAD needs in seconds is the subset where being wrong has a PHYSICAL
 * consequence: the files that are actually cut. 16 `_wcnc` + 1 `_acnc` live
 * today, and 6 of the 16 diverge.
 *
 * ⚠ IT IS A CADENCE SPLIT, NOT A SCOPE REDUCTION. The full population still
 * runs; it runs nightly. A subset that quietly became the whole check is the
 * defect this file spent the morning repairing, so the flag says `cut-only` in
 * the run header and the gate never accepts it as a full pass.
 */
const cutOnly = flag('--cut-only');
const jsonPath = opt('--json');
const TREE = treeState();
const timeoutMs = Number(opt('--timeout', String(DEFAULT_TIMEOUT_MS)));

// ---------------------------------------------------------------------------
// Case collection
// ---------------------------------------------------------------------------

function scadFilesIn(dir, recurse) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (recurse) out = out.concat(scadFilesIn(p, true));
    } else if (e.name.endsWith('.scad')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Directories inside `hardware/cad/` that are NOT part of the population, each
 * with the reason it is out.
 *
 * 🔴 STATED AND COUNTED, NEVER FILTERED QUIETLY — ceo ruling 2026-09-02, on the
 * argument that produced this whole repair: an exclusion that is printed is a
 * claim someone can check, and one that is silent is how this gate came to scan
 * 6 files while its description claimed 73. The count AND the reason are
 * printed together, because a bare number invites the next reader to assume the
 * exclusion was arbitrary.
 *
 * ⚠ `archive/` was considered for a separate non-gating lane and REJECTED: its
 * divergences are the SAME capability gaps (`str()`, `mirror()`) on files nobody
 * cuts, so it would cost 288 renders and add no information.
 */
const EXCLUDED_DIRS = [
  { dir: 'archive', why: 'superseded designs — not cut and not shipped' },
  { dir: 'ref_models', why: 'reference geometry from vendors — not ours to fix' },
];

/**
 * 🔴 A LEADING UNDERSCORE MEANS "NOT A REAL ARTEFACT", AND IT IS THE FLEET'S
 * OWN CONVENTION — `_WORKING.md`, `_done/`, `_FOUNDER-QUEUE-*`, `_announce-*`.
 * Scratch `.scad` files are not designs, and this gate had been scoring them.
 *
 * ceo ruling 2026-09-02, and it fixes a CLASS rather than an instance. Twice the
 * instance was closed by `cad` DELETING the files — handover
 * `2026-08-22-2bee_app-underscore-scratch-scad-files-redden-cad1h` (12 files),
 * and again this morning when `_mtest.scad`/`_mtest2.scad` moved PENDING 113 ->
 * 115 between one measurement and the next. Deleting the evidence closes the
 * ticket and leaves the mechanism.
 *
 * ⚠ AND NOT ALL THREE ARE SCRATCH — corrected by `cad` 2026-09-02.
 * `_iso.scad` and `_mesh_test.scad` are untracked scratch; `2bee_hive/_hv.scad`
 * is TRACKED and named in `hardware/cad/AGENTS.md`. Excluding it is still right
 * — a three-line preview entry point carrying no coverage `side_hive.scad`
 * does not already have — but NOT because it is scratch. A rule justified by
 * the wrong reason is one nobody can apply to the next case.
 *
 * ⚠ `cad` HAS BEEN TOLD their `_*` files are outside the scan. An exclusion
 * nobody informs the owner of is a trap for whoever later puts real work behind
 * an underscore — so it is a ticket, not just a constant.
 */
const EXCLUDED_PREFIX = {
  test: (rel) => rel.split('/').pop().startsWith('_'),
  dir: '_scratch',
  why: 'leading-underscore scratch files — the fleet convention for "not a real artefact"',
};

/** `true` when a path relative to `hardware/cad/` is outside the population. */
function isExcluded(rel) {
  const top = rel.split('/')[0];
  const byDir = EXCLUDED_DIRS.find((e) => e.dir === top);
  if (byDir) return byDir;
  return EXCLUDED_PREFIX.test(rel) ? EXCLUDED_PREFIX : null;
}

function collectCases() {
  const cases = [];
  for (const f of scadFilesIn(join(HERE, 'corpus'), false)) {
    cases.push({
      name: `corpus/${basename(f, '.scad')}`,
      path: f,
      group: 'corpus',
      root: join(HERE, 'corpus'),
    });
  }
  if (flag('--hardware')) {
    // 🔴 READ ONLY. These are the `cad` lane's files. The harness opens them,
    // hands their PATH to openscad (which writes only into a temp dir), and
    // writes nothing back. Nothing in this tool has a write path into them.
    //
    // 🔴 RECURSIVE SINCE 2026-09-02, AND IT WAS NOT BEFORE — CAD1H'S SET WAS
    // NOT THE SET IT CLAIMED. This read `scadFilesIn(HARDWARE_CAD, false)` plus
    // a separate recursive walk of `lib/`, which collected **85 cases: 6
    // top-level files and 79 library files**, while `hardware/cad/` holds 584.
    // Every product directory — `2bee_hive/` (46 files), `2bee_entrance/`,
    // `2bee_feeder/`, the schools kit — was outside it, and so was **every one
    // of the 18 `_wcnc` CNC cut files**, all of which live in subdirectories.
    // The gate's own description said it covered "the .scad files this company
    // actually cuts"; it scanned none of them, and the ledger's tightening
    // 31 -> 16 -> 10 -> 7 was the divergence count of `lib/`.
    //
    // ⚠ THE `lib/` LOOP IS GONE BECAUSE RECURSION SUBSUMES IT. Leaving both
    // would enter every library file twice under the same case name.
    const excludedBy = new Map();
    for (const f of scadFilesIn(HARDWARE_CAD, true)) {
      const rel = relative(HARDWARE_CAD, f);
      const out = isExcluded(rel);
      if (out) {
        excludedBy.set(out.dir, (excludedBy.get(out.dir) ?? 0) + 1);
        continue;
      }
      cases.push({
        name: `hardware/${rel}`,
        path: f,
        group: 'hardware',
        root: HARDWARE_CAD,
      });
    }
    const total = [...excludedBy.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const parts = [...EXCLUDED_DIRS, EXCLUDED_PREFIX]
        .filter((e) => excludedBy.has(e.dir))
        .map((e) => `${e.dir} ${excludedBy.get(e.dir)} (${e.why})`);
      process.stderr.write(
        `population: ${cases.filter((c) => c.group === 'hardware').length} hardware case(s); ` +
          `${total} excluded — ${parts.join('; ')}\n`,
      );
      process.stderr.write(
        `tree: ${TREE.sha}` +
          (TREE.dirtyFiles === null
            ? ' (git unavailable — the scanned state cannot be identified at all)'
            : TREE.dirtyFiles > 0
              ? ` ⚠ hardware/cad DIRTY (${TREE.dirtyFiles} uncommitted path(s)) — findings from this run may not be ` +
                'reproducible from any commit; re-run when the tree settles before chasing one'
              : TREE.contentId
                ? ' \u2014 the hardware/cad TREE hash of the content actually read, not a commit id: findings are ' +
                  'replayable by extracting exactly this tree'
                : ' (hardware/cad clean — findings are replayable from this commit)') +
          '\n',
      );
    }
  }
  const scoped = cutOnly
    ? cases.filter((c) => c.group !== 'hardware' || /_wcnc\.scad$|_acnc\.scad$/.test(c.name))
    : cases;
  return only ? scoped.filter((c) => c.name.includes(only)) : scoped;
}

// ---------------------------------------------------------------------------
// The oracle, memoised per file: the CSG is cheap and always taken, the STL is
// a full CGAL render and is taken only when a case is actually comparable.
// ---------------------------------------------------------------------------

function oracleFor(path) {
  let csg = null;
  let stl = null;
  return {
    csg() {
      if (csg === null) csg = exportCsg(OPENSCAD, path, timeoutMs);
      return csg;
    },
    stl() {
      if (stl === null) stl = exportStl(OPENSCAD, path, timeoutMs);
      return stl;
    },
  };
}

// ---------------------------------------------------------------------------
// One case, one verdict
// ---------------------------------------------------------------------------

function decide(c, oracle, plantName) {
  const row = {
    name: c.name,
    group: c.group,
    verdict: 'PENDING',
    reason: '',
    tree: '-',
    mesh: '-',
    notes: [],
    numbers: {},
  };

  let src;
  try {
    src = readFileSync(c.path, 'utf8');
  } catch (e) {
    row.reason = `source unreadable: ${e.message}`;
    return row;
  }

  // 🔴 $preview-DEPENDENT GEOMETRY MAKES THE ORACLE DISAGREE WITH ITSELF, and
  // that is a property of the INSTRUMENT, not of either side. OpenSCAD's
  // `-o csg` leg runs $preview=true (F5) and its `-o stl` leg runs
  // $preview=false (F6), so for a source whose geometry depends on `$preview`
  // (`$fn = $preview ? lo : hi` is the shape every live example takes) the
  // tree leg is compared against one solid and the mesh leg against ANOTHER.
  // Our kernel is deliberately self-consistent at $preview=true
  // (scad.ts:3707-3721) — whether the product should follow OpenSCAD to F6 is
  // a deferred decision this harness may not pre-empt. So the fact is
  // detected here and `meshLeg` scores the case undecidable BEFORE any number
  // is compared; a TREE difference is still a real divergence and decides the
  // case first, because both tree legs run at $preview=true. Comments and
  // string literals are stripped first: a mention in prose (`bee_logo_2d`
  // carries one) is not a dependency.
  const srcCode = src
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const previewDependent = /\$preview\b/.test(srcCode);

  // --- our side -----------------------------------------------------------
  let ours;
  try {
    ours = runOurs(src, plantName, c.root ? { root: c.root, path: relative(c.root, c.path) } : null);
  } catch (e) {
    row.verdict = 'ERROR';
    row.reason = `our pipeline threw: ${e && e.message}`;
    row.notes.push(String((e && e.stack) || '').split('\n')[1] || '');
    return row;
  }
  // A refusal is a refusal whichever stage named it — see the note in ours.mjs.
  const refusalNames = [
    ...ours.unsupported.map((u) => u.name),
    ...ours.meshRefusals.map((i) => `${i.name} [kernel]`),
  ];
  row.numbers.ourTriangles = ours.inv.triangles;
  row.numbers.ourSolids = ours.solidParts;
  row.numbers.ourFlats = ours.flatParts;
  row.numbers.refusals = refusalNames.length;
  row.numbers.evalErrors = ours.errors.length;
  if (plantName && !ours.plantApplied) row.notes.push(`plant ${plantName} had nothing to corrupt here`);
  if (refusalNames.length) {
    row.notes.push(`refused: ${[...new Set(refusalNames)].slice(0, 6).join(', ')}`);
  }

  // --- the oracle's tree --------------------------------------------------
  const csg = oracle.csg();
  if (!csg.ok) {
    row.reason = csg.reason;
    return row;
  }
  let refCanon;
  try {
    refCanon = normalise(csgToCanon(csg.csg));
  } catch (e) {
    row.reason = `oracle CSG could not be parsed: ${e.message}`;
    return row;
  }
  const ourCanon = normalise(ours.canon);
  const refText = serialise(refCanon);
  const ourText = serialise(ourCanon);
  // Numeric-tolerant, NOT exact-string: the oracle's .csg matrices are
  // pre-rounded to six significant figures and `normalise` composes them,
  // while our side composes full doubles — a 1e-6 rounding straddle is the
  // instrument disagreeing with itself, not the trees. See canon.mjs's
  // header for what the tolerance cannot absorb.
  const treeSame = serialiseEq(refText, ourText);
  row.tree = treeSame ? 'same' : 'differs';
  if (!treeSame) row.numbers.treeDiff = firstDiff(refText, ourText);

  const bothEmpty = refCanon.k === 'empty' && ourCanon.k === 'empty';

  // --- classification that precedes any comparison ------------------------
  // ⚠ THIS BRANCH SITS AHEAD OF THE REFUSAL CONSULT AND DOES NOT BYPASS IT. A
  // case can reach it while naming refusals — a library file that refuses an
  // import and emits nothing — but the ORACLE's tree is empty here too, so the
  // binary exports nothing either and the answer the consult would give is
  // `REFUSED-BOTH`. Same cost, different word, and the `empty` tag is what keeps
  // it out of the agreement count.
  if (bothEmpty) {
    row.verdict = 'SAME';
    row.empty = true;
    row.mesh = 'n/a';
    row.reason = 'no top-level geometry on either side (a library / module-only file)';
    return row;
  }
  const weEmittedNothing = ours.solidParts === 0 && ours.flatParts === 0;
  if (refusalNames.length > 0 && weEmittedNothing) {
    return refusalVerdict(oracle, ours, row, refusalNames);
  }
  if (ours.errors.length > 0) {
    row.verdict = 'ERROR';
    row.mesh = 'n/a';
    row.reason = `our evaluator reported ${ours.errors.length} error(s): ${ours.errors[0].message} (line ${ours.errors[0].line})`;
    return row;
  }

  // --- the mesh leg -------------------------------------------------------
  const mesh = meshLeg(oracle, ours, row, previewDependent);
  row.mesh = mesh.status;

  if (!treeSame) {
    row.verdict = 'DIVERGES';
    row.reason = mesh.status === 'same'
      ? 'the trees differ (the solids happen to agree — which is exactly why both legs are run)'
      : 'the trees differ';
    return row;
  }
  if (mesh.status === 'differs') {
    row.verdict = 'DIVERGES';
    row.reason = mesh.reason;
    return row;
  }
  if (mesh.status === 'pending') {
    row.verdict = 'PENDING';
    row.reason = mesh.reason;
    return row;
  }
  row.verdict = 'SAME';
  row.reason = mesh.status === 'n/a' ? mesh.reason : 'tree and solid both agree';
  return row;
}

// ---------------------------------------------------------------------------
// A REFUSAL, SCORED AGAINST THE ORACLE INSTEAD OF AGAINST ITSELF
//
// 🔴 THE DEFECT THIS REPLACES, MEASURED RATHER THAN ARGUED (d1d953317c). This
// branch used to read:
//
//     if (refusalNames.length > 0 && weEmittedNothing) { verdict = 'REFUSED' }
//
// — awarded as soon as we named a construct and emitted nothing, BEFORE either
// leg was compared. So the oracle's own answer was never consulted for a
// refusal, and every refusal scored the same whether OpenSCAD produced a solid,
// an outline, or nothing at all. An agent planted a real behaviour change (drop
// the 2D operand of a boolean, "to match OpenSCAD") and ran the full hardware
// leg over 103 real files: THE OUTPUT WAS BYTE-IDENTICAL except one
// informational note. No corpus case could have fixed that — the verdict
// algebra was what was blind, because a case that emits nothing never reaches a
// comparison.
//
// ⚠ AND THE REASON IT MATTERS IS NOT SYMMETRY, IT IS THAT THE TWO OUTCOMES HAVE
// DIFFERENT COSTS. "We refuse and OpenSCAD emits nothing either" costs nothing
// but the reason. "We refuse and OpenSCAD hands the user a part" is a capability
// we do not have, wearing the same word as the safe case — and the whole point
// of the refusal rule is that a refusal is honest, which it stops being the
// moment it hides a gap.
//
// THE CONSULT — three states, and the binary says which one in words:
//
//   exit 0, facets > 0                        STRICTER  (openscad = solid)
//   exit 1, "not a 3D object"                 STRICTER  (openscad = outline)
//   exit 1, "empty"                           REFUSED-BOTH
//   anything else (absent, timeout, truncated) PENDING — a check that could not
//                                             run is not a check that passed
//
// 🔴 `STRICTER` IS NOT A FAILURE AND IT IS NOT A PASS. It is a named, dated
// ledger entry (`STRICTER_LEDGER` below) and anything unlisted is a NO-GO.
function refusalVerdict(oracle, ours, row, refusalNames) {
  const cascade = ours.errors.length
    ? ` (+${ours.errors.length} evaluator error(s) cascading from them)`
    : '';
  const named = `${refusalNames.length} construct(s) named and refused; nothing emitted${cascade}`;
  const stl = oracle.stl();
  row.mesh = 'n/a';

  if (stl.ok) {
    const tris = stl.tris.length / 9;
    row.numbers.refTriangles = tris;
    if (tris > 0) {
      row.verdict = 'STRICTER';
      row.strictness = 'solid';
      row.reason =
        `${named} — 🔴 BUT OPENSCAD EXPORTS A SOLID FOR THIS FILE (${tris} facets, exit 0). ` +
        'That is a capability we do not have, and it has been scoring as safety';
      return row;
    }
    row.verdict = 'REFUSED-BOTH';
    row.reason = `${named}; openscad exits 0 and writes an STL with NO facets, so neither side produces a solid`;
    return row;
  }
  if (stl.empty) {
    row.verdict = 'REFUSED-BOTH';
    row.reason = `${named}; openscad produces no geometry at all here either ("Current top level object is empty")`;
    return row;
  }
  if (stl.notSolid) {
    row.verdict = 'STRICTER';
    row.strictness = 'outline';
    row.reason =
      `${named} — 🔴 BUT OPENSCAD DRAWS 2D GEOMETRY HERE ("Current top level object is not a 3D object"), and ` +
      'we draw nothing. No solid on either side, so the mesh leg cannot see it; it is a capability gap all the same';
    return row;
  }
  // Not a refusal question at all: the oracle could not be asked. Reported as
  // the unknown it is rather than defaulted to either bucket.
  row.verdict = 'PENDING';
  row.reason =
    `${named}; and whether that costs anything CANNOT BE DECIDED — the oracle could not be asked: ${stl.reason}`;
  return row;
}

function meshLeg(oracle, ours, row, previewDependent) {
  const stl = oracle.stl();

  // 🔴 `empty` JOINED `notSolid` HERE 2026-08-11 AND IT MOVED A CASE OUT OF
  // PENDING. "openscad produced NOTHING" used to fall through to the generic
  // arm and be reported as an oracle the harness could not ask — so the one
  // direction this lane cares about most, *we emit a solid where OpenSCAD emits
  // none*, was scored UNDECIDABLE instead of DIVERGES. Measured before the
  // change: no case in the corpus or in `hardware/cad/` reaches this branch, so
  // nothing moved today; it moves under `--plant drop-2d-operand`, which is
  // exactly the shape it exists for.
  if (!stl.ok && !stl.notSolid && !stl.empty) {
    return { status: 'pending', reason: `oracle mesh unavailable: ${stl.reason}` };
  }

  const oracleHasSolid = stl.ok && stl.tris.length > 0;
  const weHaveSolid = ours.solidParts > 0;

  if (!oracleHasSolid && !weHaveSolid) {
    return {
      status: 'n/a',
      reason: stl.notSolid
        ? 'no 3D solid on either side (2D-only model); the tree leg decided this case'
        : stl.empty
          ? 'openscad produces no geometry at all here, and neither do we; the tree leg decided this case'
          : 'no triangles on either side',
    };
  }
  if (!oracleHasSolid && weHaveSolid) {
    return {
      status: 'differs',
      reason: stl.empty
        ? 'OpenSCAD produces NO GEOMETRY AT ALL here and we produced a solid — the dangerous direction: a part ' +
          'that exists only in our pipeline'
        : 'OpenSCAD reports no 3D solid, we produced one',
    };
  }
  if (oracleHasSolid && !weHaveSolid) {
    return { status: 'differs', reason: 'OpenSCAD produced a solid, we produced none' };
  }

  if (ours.overlappingSolids) {
    // See the note in ours.mjs: our model deliberately does not union top-level
    // siblings, so the summed volume is not the union's volume. Not a pass.
    return {
      status: 'pending',
      reason:
        `our ${ours.solidParts} top-level solids overlap, and mesh.ts deliberately does not union ` +
        'top-level siblings (it matches OpenSCAD F5 preview, not F6 render) — the summed invariants ' +
        'are not the union\'s, so this case cannot be decided on the mesh leg',
    };
  }

  // 🔴 $preview STRADDLE — placed AFTER the has-solid and overlap checks,
  // because those answers stay meaningful (presence is not tessellation, and
  // an overlap is undecidable for its own reason whichever $preview leg the
  // oracle's STL came from) — and BEFORE any invariant is compared, because
  // that comparison is the oracle disagreeing with ITSELF: the tree leg above
  // ran at $preview=true and the STL this leg would compare against ran at
  // $preview=false. See the detection note in `decide()`.
  if (previewDependent) {
    return {
      status: 'pending',
      reason:
        'the source evaluates $preview-dependent geometry, and the oracle\'s own two legs straddle it: ' +
        '`-o csg` runs $preview=true (F5) while `-o stl` runs $preview=false (F6), so the tree was compared ' +
        'against one solid and the mesh would be compared against ANOTHER — no comparison is meaningful here. ' +
        'Our kernel is deliberately self-consistent at $preview=true (scad.ts); following OpenSCAD to F6 is a ' +
        'deferred product decision, not something this instrument may guess at',
    };
  }

  const ref = invariants(stl.tris);
  const floor = quantisationFloor(stl.tris);
  row.numbers.refTriangles = ref.triangles;
  row.numbers.quantFloor = floor;

  if (floor.volume >= REL_TOL || floor.area >= REL_TOL) {
    return {
      status: 'pending',
      reason:
        `float32 output cannot decide this case: re-quantising the ORACLE'S OWN mesh to float32 moves ` +
        `volume by ${floor.volume.toExponential(2)} and area by ${floor.area.toExponential(2)}, ` +
        `at or above REL_TOL ${REL_TOL.toExponential(0)}`,
    };
  }

  // 🔴 OUR KERNEL'S OWN AUDIT, CONSULTED BEFORE ITS NUMBERS ARE BELIEVED. Until
  // 2026-08-12 `ours.audits` and `ours.trust` were computed by `ours.mjs` on
  // every run and read by NOTHING — neither `decide()` nor this function looked
  // at them — so a solid `mesh.ts` itself calls `open` or `non-manifold` was
  // compared on volume and area anyway, and on a high-triangle curved primitive
  // one dropped, duplicated or flipped face moves the invariants by LESS THAN
  // `REL_TOL`. Measured here, `--plant drop-face`, against the unplanted run:
  // `prim_sphere_default_fn` (672 triangles) moves volume 1.71e-2 mm³, rel
  // 8.18e-6; `partial_fa_fs_args` and `partial_fa_fs_global` (5180 triangles)
  // move 2.10e-4 mm³, rel 5.03e-8 — BELOW the 9.04e-8 float32 quantisation
  // floor, so on those two the invariants were never going to see it at any
  // tolerance this harness could defend. All three audited `open` /
  // `non-manifold` with `trust: untrusted` while this harness printed
  // `SAME — tree and solid both agree`. The README named the hole and
  // filed it as accepted ("volume is meaningless on an open surface … the
  // harness does not separately assert closure"); this is the assertion.
  //
  // 🔴 PENDING, NOT DIVERGES, AND THE DIFFERENCE IS THE WHOLE POINT. An
  // unclosed surface does not disagree with the oracle — it makes the
  // comparison MEANINGLESS: the divergence theorem's volume integral and the
  // summed triangle area are both defined on a closed orientable surface, and
  // on an open or self-intersecting one they are numbers with no referent. So
  // this is a check that CANNOT RUN, and this lane's rule is that a check which
  // cannot run reports PENDING, never PASS and never a measured disagreement.
  //
  // ⚠ `mesh-scale` NEVER REACHES THIS STATE — it moves every vertex and leaves
  // the surface closed — so no plant that existed before today could find it.
  // The three `MESH_PLANTS` in `ours.mjs` are what reddens this branch.
  //
  // ⚠ THE PER-PART AUDIT VERDICT, NOT `ours.trust`, AND THE DIFFERENCE WAS
  // MEASURED BEFORE IT WAS CHOSEN. `trust` is the ONE-WORD answer to "can I
  // trust this picture", so it is `suspect` whenever ANY construct was refused
  // anywhere in the source — a question about the parse, not about closure.
  // Measured over this corpus: 8 cases are `suspect` and 6 of them have every
  // solid audited `closed`; keying on `trust` would have moved five decided
  // `SAME` rows (`edge_2d_and_3d`, `edge_modifier_background{,_operand}`,
  // `partial_unknown_module`, `xform_scalar_forms`) into PENDING for a reason
  // that has nothing to do with whether the comparison can run. A check must
  // assert the property it needs, not the nearest summary of it.
  //
  // ⚠ `ours.audits` IS THE `dim === 3` SET ALREADY — `ours.mjs` builds it from
  // `parts.filter(p => p.dim === 3 && p.triangles > 0)`. A 2D part carries
  // `audit: null` in `mesh.ts` because closure is not a meaningful question
  // about a zero-thickness outline, and a `null` verdict here would be an
  // UNAUDITED 3D part, which is also not something to compare — so the test is
  // `!== 'closed'` rather than a list of bad verdicts.
  //
  // ⚠ NAMED RATHER THAN LEFT TO BE ASSUMED: of the three shapes the reason
  // string can take, TWO have been watched — the single-solid form and the
  // `all N of our solids` form (`corpus/xform_rotate_quadrant`, 6 solids). The
  // `k of N` form has NOT: every plant here corrupts EVERY solid, so only a
  // real kernel defect on part of a model can produce it. It is formatting, it
  // decides nothing, and this sentence is here so nobody reads it as tested.
  const audits = ours.audits ?? [];
  const unclosed = audits.filter((a) => a.verdict !== 'closed');
  row.numbers.ourAudits = audits.map((a) => a.verdict ?? 'unaudited');
  if (unclosed.length > 0) {
    const kinds = [...new Set(unclosed.map((a) => a.verdict ?? 'unaudited'))].join(' / ');
    const which =
      audits.length === 1
        ? ''
        : unclosed.length === audits.length
          ? ` (all ${audits.length} of our solids)`
          : ` (${unclosed.length} of ${audits.length} solids: ` +
            `${unclosed.slice(0, 6).map((a) => `${a.id} ${a.verdict ?? 'unaudited'}`).join(', ')}` +
            `${unclosed.length > 6 ? ', …' : ''})`;
    return {
      status: 'pending',
      reason:
        `our kernel audits this solid as ${kinds}; volume and area are not defined on an open or ` +
        `non-manifold surface, so the invariant comparison cannot decide it${which}`,
    };
  }

  const cmp = compareInvariants(ref, ours.inv);
  row.numbers.checks = cmp.checks;
  if (cmp.same) return { status: 'same', reason: '' };

  // 🔴 TOUCHING TOP-LEVEL SOLIDS MAKE AREA NON-COMPARABLE, AND ONLY AREA.
  // OpenSCAD's STL export is the CGAL union, which deletes the coincident
  // CONTACT FACES of touching solids; our summed mesh keeps them, so the sum
  // counts exactly 2x the contact area extra (measured against the binary
  // 2026-08-14: stacked cubes union to area 1000 vs 1200 summed). Volume,
  // bbox and centroid are untouched by a zero-volume contact, so they are
  // STILL COMPARED — and if any of them fails, the case falls through to
  // `differs` below. Only when area is the SOLE disagreement is the case
  // undecidable: reporting it as a divergence would be the instrument
  // reporting its own missing union (founder-deferred 2026-08-14) as a kernel
  // defect, which is what ten hardware files were scored as.
  if (ours.touchingSolids) {
    const decidable = cmp.checks.filter((c) => c.name !== 'area');
    if (decidable.every((c) => c.ok)) {
      return {
        status: 'pending',
        reason:
          `our ${ours.solidParts} top-level solids TOUCH (bbox face/edge contact), and mesh.ts deliberately does ` +
          'not union top-level siblings — OpenSCAD\'s STL is the CGAL union, which deletes the coincident contact ' +
          'faces, so the summed AREA counts them and the oracle\'s does not: area is not comparable without ' +
          'unioning. Volume, bbox and centroid are unaffected by a contact and were compared — they AGREE. ' +
          'Unioning is founder-deferred (2026-08-14), so this case is undecidable on the mesh leg, not divergent',
      };
    }
  }

  const bad = cmp.checks.filter((c) => !c.ok);
  const worst = bad.reduce((a, b) => ((b.rel ?? b.delta) > (a.rel ?? a.delta) ? b : a));
  let hint = '';
  if (worst.rel !== null && worst.rel > ngonDeficit(64) * 0.3) {
    hint = ` — that magnitude is in the tessellation band (an n-gon at $fn=32 understates a circle by ${ngonDeficit(32).toExponential(1)}), so suspect $fn/$fa/$fs, not float noise`;
  }
  return {
    status: 'differs',
    reason:
      `${bad.length} invariant(s) outside tolerance; worst is ${worst.name}: oracle ` +
      `${fmt(worst.ref)} vs ours ${fmt(worst.got)} ` +
      (worst.rel !== null ? `(rel ${worst.rel.toExponential(2)} > ${worst.tol.toExponential(0)})` : `(abs ${worst.delta.toExponential(2)} > ${worst.tol.toExponential(2)})`) +
      hint,
  };
}

const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(8)) : String(v));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const version = openscadVersion(OPENSCAD);
const cases = collectCases();

console.log('scad_oracle — our OpenSCAD subset measured against real OpenSCAD');
console.log(`  oracle    ${version ?? `🔴 NOT AVAILABLE (${OPENSCAD}) — every case will be PENDING`}`);
console.log(`  ours      web/src/cad/scad.ts + web/src/cad/mesh.ts (imported directly)`);
console.log(`  tolerance REL_TOL ${REL_TOL.toExponential(0)} relative, see invariants.mjs for the derivation`);
console.log(`  cases     ${cases.length}${flag('--hardware') ? ' (including hardware/cad, read-only)' : ''}`);
// 🔴 A REDIRECTED RUN MUST NOT BE READABLE AS A NORMAL ONE. Printed only when
// the root is not the working tree, so the line's presence IS the warning.
if (flag('--hardware') && HARDWARE_CAD !== resolve(join(REPO, 'hardware/cad'))) {
  console.log(`  🔴 ROOT     ${HARDWARE_CAD} — NOT the working tree; this run measures another checkout`);
}
if (plant) console.log(`  🔴 PLANT  ${plant} — ${PLANTS[plant]}`);
console.log('');

if (cases.length === 0) {
  console.error('no cases matched — nothing was measured, which is not a pass');
  process.exit(2);
}

const baseline = [];
const planted = [];

// 🔴 THE ORACLE IS BUILT INSIDE THE LOOP AND DROPPED AT THE END OF IT. It used
// to live in a `new Map()` keyed by `c.path`, outside the loop — and that map
// OOM'd the full run (`--hardware`, 303 cases) at both the default heap and
// `--max-old-space-size=4096`, which broke the nightly and made BOTH CAD1H
// ratchets unmeasurable for two days.
//
// It read as a cache and was not one. `collectCases()` emits EXACTLY ONE case
// per file — `corpus/<basename>` and `hardware/<rel>` off a recursive walk — so
// no path is ever visited twice and the map's hit rate is ZERO. It bought
// nothing and retained everything: `oracleFor()` memoises the real binary's STL
// export as `tris`, a Float64Array of 9 doubles per triangle capped at 512 MB
// PER FILE, and the map held one for every case at once until the process died.
//
// The lifetime it actually needs is ONE ITERATION — `baseline` and `planted`
// share a single `o` so the plant run does not re-invoke openscad on the same
// file. That is the whole requirement, and a `const` in the loop body meets it.
//
// ⚠ A ZERO-HIT CACHE IS INVISIBLE IN A SMALL RUN. `--cut-only` (18 cases) was
// unaffected and stayed green throughout, which is why this survived: the
// harness that would have caught it is the one that could not finish.
// `--progress` prints one stderr line per case: index, resident set, heap used,
// name. It exists because this loop was SILENT for 177 seconds and then died of
// a heap OOM with no indication of which file it was on — a failure whose whole
// diagnostic value is WHERE it happened, discarded. Off by default: the gate
// tails the last lines of this transcript to report a failure, and a progress
// line would push the actual message out of that window.
const progress = flag('--progress');
const mb = (n) => `${(n / 1e6).toFixed(0)}MB`;
for (const c of cases) {
  if (progress) {
    const m = process.memoryUsage();
    process.stderr.write(
      `[${String(baseline.length + 1).padStart(4)}/${cases.length}] rss ${mb(m.rss).padStart(7)}` +
        ` heap ${mb(m.heapUsed).padStart(7)}  ${c.name}\n`
    );
  }
  const o = oracleFor(c.path);
  baseline.push(decide(c, o, null));
  if (plant) planted.push(decide(c, o, plant));
}

const rows = plant ? planted : baseline;

// --- table -----------------------------------------------------------------

const w = Math.min(52, Math.max(...rows.map((r) => r.name.length)));
const head = plant ? 'BASE     ->PLANTED' : 'VERDICT ';
console.log(`${'CASE'.padEnd(w)}  ${head}  TREE     MESH     WHY`);
console.log('-'.repeat(w + 2 + head.length + 2 + 9 + 9 + 4));
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const left = plant ? `${baseline[i].verdict.padEnd(8)}->${r.verdict.padEnd(8)}` : r.verdict.padEnd(8);
  console.log(
    `${r.name.padEnd(w).slice(0, w)}  ${left}  ${String(r.tree).padEnd(8)} ${String(r.mesh).padEnd(8)} ${r.reason}`,
  );
  for (const n of r.notes) if (n) console.log(`${' '.repeat(w + 2)}  ${' '.repeat(head.length)}  ${' '.repeat(18)}· ${n}`);
  if (r.numbers.treeDiff) {
    const d = r.numbers.treeDiff;
    console.log(`${' '.repeat(w + 2)}  ${' '.repeat(head.length)}  ${' '.repeat(18)}· tree line ${d.line}: openscad ${JSON.stringify(d.openscad)}`);
    console.log(`${' '.repeat(w + 2)}  ${' '.repeat(head.length)}  ${' '.repeat(18)}·              ours     ${JSON.stringify(d.ours)}`);
  }
}
console.log('');

// --- summary ---------------------------------------------------------------

const tally = (rs) => {
  const t = { SAME: 0, 'REFUSED-BOTH': 0, STRICTER: 0, DIVERGES: 0, ERROR: 0, PENDING: 0 };
  for (const r of rs) t[r.verdict]++;
  return t;
};
const t = tally(rows);
const emptySame = rows.filter((r) => r.verdict === 'SAME' && r.empty).length;
const strictSolid = rows.filter((r) => r.verdict === 'STRICTER' && r.strictness === 'solid').length;

console.log(
  `SAME ${t.SAME} (of which ${emptySame} are empty-on-both-sides library files) · ` +
    `REFUSED-BOTH ${t['REFUSED-BOTH']} · STRICTER ${t.STRICTER} (${strictSolid} where openscad exports a SOLID) · ` +
    `DIVERGES ${t.DIVERGES} · ERROR ${t.ERROR} · PENDING ${t.PENDING}`,
);

const named = (v) => rows.filter((r) => r.verdict === v).map((r) => r.name);
if (t.DIVERGES) console.log(`\n🔴 DIVERGES: ${named('DIVERGES').join(', ')}`);
if (t.ERROR) console.log(`\n🔴 ERROR: ${named('ERROR').join(', ')}`);
if (t.PENDING) console.log(`\n⚠  PENDING: ${named('PENDING').join(', ')}`);

// --- the STRICTER ledger ---------------------------------------------------
//
// 🔴 SCORED ON THE BASELINE RUN, NEVER ON THE PLANTED ONE. A plant corrupts our
// side on purpose, so a planted run moves cases off STRICTER by design — scoring
// the ledger there would report a corrupted run's capability gaps as the real
// ones, and `--plant` would quietly become a way to empty the ledger.
const ledgerFailures = [];
let ledgerReport = null;
{
  const listed = Object.keys(STRICTER_LEDGER);
  const ranNames = new Set(baseline.map((r) => r.name));
  const strictRows = baseline.filter((r) => r.verdict === 'STRICTER');
  const strictByName = new Map(strictRows.map((r) => [r.name, r]));
  const isHw = (n) => n.startsWith('hardware/');

  const fresh = strictRows.filter((r) => !(r.name in STRICTER_LEDGER));
  const wrongKind = strictRows.filter(
    (r) => r.name in STRICTER_LEDGER && STRICTER_LEDGER[r.name].openscad !== r.strictness,
  );
  // An entry can only be scored if its case actually ran AND was decided.
  // `--only` filters the set and `--hardware` decides whether the hardware leg
  // exists at all, so both of those make the stale limb UNABLE TO RUN — which it
  // says, rather than reporting "nothing stale" for a check it never performed.
  //
  // 🔴 AND A `PENDING` CASE IS NOT EVIDENCE THAT A GAP CLOSED. Caught by a
  // negative test on the first cut of this limb: with `OPENSCAD_BIN` pointing at
  // nothing, `corpus/refuse_hull` went PENDING and the ledger demanded its entry
  // be REMOVED — **a false red that instructs someone to delete a true record
  // because the instrument was absent.** That is this file's own catalogue of
  // defects arriving in the control written to close one. Undecided is reported
  // as undecided.
  const decided = new Set(baseline.filter((r) => r.verdict !== 'PENDING').map((r) => r.name));
  const undecidedEntries = listed.filter((n) => ranNames.has(n) && !decided.has(n));
  const scoredNames = only ? [] : listed.filter((n) => decided.has(n));
  const unscored = listed.filter((n) => !ranNames.has(n));
  const stale = scoredNames.filter((n) => !strictByName.has(n));
  // An entry naming a case that no longer exists is stale in the worst way: it
  // reads as coverage of something that is not there. Only decidable on a full,
  // unfiltered run of the leg the entry belongs to.
  const gone = only
    ? []
    : unscored.filter((n) => (isHw(n) ? flag('--hardware') : true));

  console.log('\nSTRICTER LEDGER');
  console.log(`  entries ${listed.length} · scored on this run ${scoredNames.length} · not run ${unscored.length}`);
  if (only) {
    console.log(`  ⚠ --only ${JSON.stringify(only)} — the stale limb CANNOT RUN under a filter and was not run`);
  }
  if (undecidedEntries.length) {
    console.log(
      `  ⚠ ${undecidedEntries.length} entr(ies) could not be scored — their case is PENDING this run, which is ` +
        `NOT evidence the gap closed: ${undecidedEntries.join(', ')}`,
    );
  }
  if (!flag('--hardware') && listed.some(isHw)) {
    console.log(`  ⚠ ${listed.filter(isHw).length} hardware entr(ies) not scored — this run has no hardware leg`);
  }
  for (const r of strictRows) {
    const e = STRICTER_LEDGER[r.name];
    console.log(`  ${e ? '·' : '🔴'} ${r.name.padEnd(46)} openscad=${r.strictness}  ${e ? `${e.since} ${e.why}` : 'UNLISTED'}`);
  }
  if (fresh.length) {
    ledgerFailures.push(
      `${fresh.length} refusal(s) are STRICTER THAN OPENSCAD and are NOT on the ledger — a capability the binary ` +
        `has and we do not, with nobody's name and no date on it: ${fresh.map((r) => r.name).join(', ')}`,
    );
  }
  if (wrongKind.length) {
    ledgerFailures.push(
      `${wrongKind.length} ledger entr(ies) claim the wrong thing about openscad: ` +
        wrongKind
          .map((r) => `${r.name} says '${STRICTER_LEDGER[r.name].openscad}', the binary produces '${r.strictness}'`)
          .join('; '),
    );
  }
  const staleCorpus = stale.filter((n) => !isHw(n));
  const staleHw = stale.filter(isHw);
  if (staleCorpus.length) {
    ledgerFailures.push(
      `RATCHET: ${staleCorpus.length} corpus ledger entr(ies) are no longer STRICTER and must be REMOVED — ` +
        `${staleCorpus.join(', ')}. A ledger that keeps headroom it has stopped needing is the slack that absorbs ` +
        'the next gap in silence',
    );
  }
  if (staleHw.length) {
    console.log(
      `  ⚠ ${staleHw.length} hardware entr(ies) are no longer STRICTER: ${staleHw.join(', ')} — NOT a failure ` +
        '(another lane may legitimately have changed the file) and NOT nothing: check it stopped being a gap ' +
        'rather than stopped being read',
    );
  }
  const goneCorpus = gone.filter((n) => !isHw(n));
  const goneHw = gone.filter(isHw);
  if (goneCorpus.length) {
    ledgerFailures.push(
      `${goneCorpus.length} corpus ledger entr(ies) name a case that DID NOT RUN — the file is gone or renamed, so ` +
        `the entry reads as coverage of something that is not there: ${goneCorpus.join(', ')}`,
    );
  }
  if (goneHw.length) {
    console.log(`  ⚠ ${goneHw.length} hardware entr(ies) name a file that is no longer in hardware/cad/: ${goneHw.join(', ')}`);
  }
  for (const f of ledgerFailures) console.log(`  🔴 ${f}`);
  if (!ledgerFailures.length && strictRows.length) {
    console.log(`  ✅ every STRICTER row is named, dated and its openscad behaviour matches what was written down`);
  }

  // 🔴 THE LEDGER'S ANSWER GOES IN THE JSON BECAUSE A VERDICT WITH NO CONSUMER
  // IS A CONTROL NOBODY READS. `gates/slicer_gate_check.mjs` reads this file's
  // JSON and IGNORES its exit code (it branches on `status === 2` only), so a
  // NO-GO raised here reaches nothing until the gate reads `stricterLedger`.
  // That is stated in the run report rather than fixed here: `gates/` is
  // another boundary.
  ledgerReport = {
    entries: listed.length,
    scored: scoredNames.length,
    stricter: strictRows.map((r) => ({ name: r.name, openscad: r.strictness, listed: r.name in STRICTER_LEDGER })),
    refusedBoth: baseline.filter((r) => r.verdict === 'REFUSED-BOTH').map((r) => r.name),
    fresh: fresh.map((r) => r.name),
    wrongKind: wrongKind.map((r) => r.name),
    staleCorpus,
    staleHardware: staleHw,
    goneCorpus,
    goneHardware: goneHw,
    undecided: undecidedEntries,
    staleLimbRan: !only,
    failures: ledgerFailures,
  };
}

// --- the plant's own verdict ----------------------------------------------
//
// 🔴 A PLANT THAT REDDENS EVERYTHING IS TELLING YOU ABOUT THE HARNESS, NOT THE
// CODE. Both directions are asserted: it must fire on the cases it can reach,
// and it must leave the others exactly where they were.
//
// ⚠ EACH PLANT DECLARES WHERE ITS CASES ARE ALLOWED TO LAND, AND THE DEFAULT
// USED TO BE HARD-CODED AS "DIVERGES OR IT IS BROKEN". That was true of the
// three geometry plants and it is NOT true of `drop-2d-operand`, whose whole
// point is that "match OpenSCAD" is right for two shapes and catastrophic for
// two others — it moves cases to SAME *and* to DIVERGES, and a check that
// called the SAME half "the plant is not usable" would have read as a broken
// control rather than as the measurement. So the targets live with the plant
// (`PLANT_TARGETS` in ours.mjs), a plant with no declared targets is FATAL, and
// every plant must still move at least one case to `mustHit` — otherwise a
// plant could declare its way out of firing at all.

if (plant) {
  const spec = PLANT_TARGETS[plant];
  if (!spec) {
    console.error(
      `\n🔴 plant ${JSON.stringify(plant)} declares no targets in PLANT_TARGETS, so there is nothing to assert ` +
        'about where it landed — and an unasserted plant is not a control',
    );
    process.exit(2);
  }
  const moved = [];
  const held = [];
  const wrong = [];
  const hit = [];
  for (let i = 0; i < rows.length; i++) {
    const b = baseline[i].verdict;
    const p = planted[i].verdict;
    if (b === p) held.push(rows[i].name);
    else if (spec.targets.includes(p)) {
      moved.push(`${rows[i].name} ${b}->${p}`);
      if (p === spec.mustHit) hit.push(rows[i].name);
    } else wrong.push(`${rows[i].name} ${b}->${p}`);
  }
  console.log('\nPLANT CHECK');
  console.log(`  declared targets:    ${spec.targets.join(' | ')} · must hit ${spec.mustHit}`);
  console.log(`  fired (moved):       ${moved.length}  ${moved.slice(0, 12).join(', ')}${moved.length > 12 ? ', …' : ''}`);
  console.log(`  reached ${String(spec.mustHit).padEnd(12)} ${hit.length}  ${hit.slice(0, 12).join(', ')}`);
  console.log(`  unchanged:           ${held.length}`);
  if (wrong.length) console.log(`  🔴 moved outside the declared targets: ${wrong.join(', ')}`);
  const specific = hit.length > 0 && held.length > 0 && wrong.length === 0;
  console.log(
    specific
      ? '  ✅ the plant is SENSITIVE (it fired) and SPECIFIC (it did not redden everything)'
      : `  🔴 the plant is not usable as a control: fired=${moved.length} reached-${spec.mustHit}=${hit.length} unchanged=${held.length} wrong=${wrong.length}`,
  );
}

// --- verdict ---------------------------------------------------------------
//
// The three-verdict contract of SLICER-GATES.md: a PENDING is not a pass, and
// the gap verdict is deliberately not a prefix of the clean one, so a control
// that greps for `VERDICT: GO` cannot match it.
//
// ⚠ COMPUTED BEFORE THE JSON IS WRITTEN, so the file carries the same answer
// the exit code does. It used to be computed after, which meant a reader of the
// JSON had to re-derive the verdict and could derive a different one.

let verdict;
let code;
if (ledgerFailures.length > 0) {
  // An unnamed capability gap is a NO-GO, and it shares the exit code with a
  // divergence on purpose: both are "our subset means something OpenSCAD does
  // not, and nobody wrote down why". One emits the wrong part; the other emits
  // no part at all while looking exactly like safety.
  verdict = 'NO-GO';
  code = 1;
} else if (t.DIVERGES > 0 || t.ERROR > 0) {
  verdict = 'NO-GO';
  code = 1;
} else if (t.PENDING > 0) {
  verdict = 'INCOMPLETE';
  code = 3;
} else {
  verdict = 'GO';
  code = 0;
}

// --- json ------------------------------------------------------------------

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        openscad: version,
        relTol: REL_TOL,
        plant,
        generated: new Date().toISOString(),
        /* See `treeState`: this scan reads the SHARED WORKING TREE, so a
         * finding is only replayable if the subtree was clean. */
        tree: TREE,
        verdict,
        exitCode: code,
        stricterLedger: ledgerReport,
        baseline,
        planted: plant ? planted : null,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${jsonPath}`);
}

console.log(`\nVERDICT: ${verdict}`);
process.exit(code);
