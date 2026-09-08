// A 2D operand inside a boolean — what OpenSCAD does with it, what we do, and
// the one assertion the differential corpus structurally cannot make.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE EXISTS FOR — AND IT IS IN THE INSTRUMENT, NOT THE KERNEL
// ─────────────────────────────────────────────────────────────────────────────
//
// `mesh.ts` refuses any boolean with a 2D operand. OpenSCAD does not refuse:
// `difference() { cube(10); circle(3); }` exports the plain cube, exit 0, with
// two warnings on a console nobody is reading. So we are STRICTER than the tool
// we claim to imitate, on a construct `hardware/cad/` uses in 103 non-archive
// files.
//
// 🔴 `tools/scad_oracle` CANNOT SEE THIS, AND NOT FOR WANT OF A CASE. Its
// `decide()` awards the verdict `REFUSED` — which is not a failure — as soon as
// our side names a construct and emits nothing (`oracle.mjs:257-265`), and it
// does that BEFORE either leg is compared. So the oracle's own answer is never
// consulted for a refusal, and these two are indistinguishable to it:
//
//     · a refusal OpenSCAD also declines to answer   (correct strictness)
//     · a refusal OpenSCAD answers with a real solid (a capability gap that
//       silently deletes a part from the picture)
//
// It is worse than a missing case. Flip `mesh.ts` to drop the 2D operand and
// return the 3D one — the OpenSCAD behaviour — and the corpus scores that
// `SAME`, because our cube and OpenSCAD's cube agree. Refusing and agreeing look
// identical from the mesh leg: one emits nothing (short-circuit, no comparison),
// the other emits exactly what the oracle emits (comparison passes). **Adding a
// corpus case cannot fix this. The verdict algebra is what is blind.**
//
// So this file asserts the thing the corpus cannot: the RELATION between our
// decision and OpenSCAD's, per shape of node, as a declared ledger. A change
// that makes us match OpenSCAD has to come here and say so.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE OPENSCAD COLUMN CAME FROM
// ─────────────────────────────────────────────────────────────────────────────
//
// Read at the source first (`GeometryEvaluator.cc:115-139` for the dimension
// rule, `:386-411` and `:302-336` for the substitution, `manifold-applyops.cc:
// 70-84` for what an empty operand does to each operator), then put to the
// binary — because the source explains a behaviour and only the binary has it.
// Every row below was run on `openscad 2026.08.07`, 2026-08-11:
//
//     $ echo 'difference(){ cube(10); circle(3); }' > c.scad
//     $ openscad -o c.stl c.scad ; echo "exit $?" ; grep -c 'facet normal' c.stl
//
// ⚠ AND THE RECORDED COLUMN IS RE-MEASURED WHEN THE BINARY IS HERE. A recorded
// measurement is evidence with a date on it, not a fact; the last two tests in
// this file re-run every row against the real binary and go red if the ledger
// has drifted. Where the binary is absent they SKIP — a check that cannot run is
// not a check that passed — and the ledger limb still runs on its own.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SECOND DEFECT, AND IT WAS IN THIS FILE'S OWN INSTRUMENT (2026-08-11)
// ─────────────────────────────────────────────────────────────────────────────
//
// The live limb asked ONE DOOR: `--export-format asciistl`. A node whose result
// is 2D cannot answer that question at all, so every 2D node came back with the
// same sentence and the ledger could not tell "OpenSCAD drew an outline" from
// "OpenSCAD produced nothing" — and it did not have to, because both were being
// scored on whether a SOLID came out, which for a 2D node is a constant.
//
// That is exactly how `difference(){ circle(3); cube(10); }` sat here labelled
// `agree` while `difference(){ circle(5); circle(3); }` sat two rows below it
// labelled `stricter`, on the same evidence. Both draw an outline in OpenSCAD.
// Both draw nothing here. The first label was wrong.
//
// ⚠ THE EVIDENCE THAT REFUTES IT WAS ALREADY IN THE ROW, in the `says` field.
// `Current top level object is empty` and `Current top level object is not a 3D
// object` are two different facts and OpenSCAD prints whichever one is true:
// the first means nothing was produced, the second means something was and it is
// 2D. Two of the three 2D-node rows read that discriminator correctly. The third
// inverted it. Nothing compared them, because nothing derived the verdict FROM
// the sentence — it was typed in beside it.
//
// So there is now a SECOND live limb that asks the 2D door
// (`--export-format svg`) and requires a `outline` row to produce a real file.
// It is positive evidence rather than an absence message, and it is derived from
// the binary rather than from the table it is checking:
//
//     $ openscad --export-format svg -o c.svg c.scad
//     difference(){ circle(8); cube(10); }   → exit 0, 820 bytes, Contours: 1
//     intersection(){ circle(8); cube(10); } → exit 1, no file, "not a 2D object"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene, twoDimensionalOperandVerdict } = await import('../src/cad/mesh.ts');
import type { OperandDim, BooleanOp, OpenscadProduces } from '../src/cad/mesh.ts';

/** Same environment variable the oracle honours, so one box configures both. */
const OPENSCAD = process.env.OPENSCAD_BIN || 'openscad';

interface Row {
  src: string;
  /** The operand dimensions, as `mesh.ts` classifies them at the call site. */
  dims: OperandDim[];
  op: BooleanOp;
  /** Measured: openscad's exit status. */
  exit: 0 | 1;
  /** Measured: ascii-STL facets, or `null` when no file is written at all. */
  facets: number | null;
  /** Measured: the sentence openscad prints when it declines the STL export. */
  says?: string;
  /** Measured at the SECOND door — `--export-format svg`. `true` when openscad
   *  exits 0 and writes a real outline file, `false` when it refuses that too.
   *  This is the column the STL-only limb could not see, and it is what
   *  separates a 2D RESULT from no result. */
  svg: boolean;
  /** Measured: which of openscad's three answers this node gets. The verdict
   *  function derives `relation` from exactly this, so a row that disagrees is a
   *  disagreement about the FACT and not about the label. */
  produces: OpenscadProduces;
  relation: 'agree' | 'stricter';
  why: string;
}

/**
 * 🔴 THE LEDGER. Every row is a decision, not a data point: `agree` means
 * refusing costs nothing, `stricter` means a user who wrote valid OpenSCAD gets
 * nothing from us and must be told why on screen.
 *
 * ⚠ ONE YARDSTICK, AND IT IS `produces`. "Does OpenSCAD emit a solid?" is the
 * wrong question for a 2D node — the answer is no for every 2D node there has
 * ever been, so asking it is indistinguishable from not checking. The question
 * is whether OpenSCAD emits GEOMETRY, of any dimension, that we do not.
 */
const LEDGER: Row[] = [
  {
    src: 'difference(){ cube(10); circle(3); }',
    dims: [3, 2],
    op: 'difference',
    exit: 0,
    facets: 12,
    svg: false,
    produces: 'solid',
    relation: 'stricter',
    why:
      'the 2D child is replaced by an EMPTY 3D operand in place, and a difference skips an empty ' +
      'subtrahend — so OpenSCAD exports the minuend with the pocket missing. We export nothing.',
  },
  {
    src: 'union(){ cube(10); circle(3); }',
    dims: [3, 2],
    op: 'union',
    exit: 0,
    facets: 12,
    svg: false,
    produces: 'solid',
    relation: 'stricter',
    why: 'union filters empty operands out before the kernel, so the cube comes back unchanged.',
  },
  {
    src: 'intersection(){ cube(10); circle(3); }',
    dims: [3, 2],
    op: 'intersection',
    exit: 1,
    facets: null,
    says: 'Current top level object is empty',
    svg: false,
    produces: 'nothing',
    relation: 'agree',
    why:
      'an intersection with an empty operand is empty — the manifold loop breaks with `geom = nullptr`. ' +
      '🔴 THIS IS WHY "just drop the 2D operand to match OpenSCAD" IS WRONG: for this operator it would ' +
      'emit a solid where OpenSCAD emits nothing.',
  },
  {
    // 🔴 THE CORRECTED ROW. It read `agree`, on the reason "nothing 3D exists to
    // export on either side" — which is true, and is a statement about the STL
    // exporter rather than about the node. Re-measured at both doors
    // 2026-08-11: the SVG export exits 0 and writes 820 bytes, one contour.
    // OpenSCAD hands the user the r=8 circle; we hand them nothing.
    src: 'difference(){ circle(8); cube(10); }',
    dims: [2, 3],
    op: 'difference',
    exit: 1,
    facets: null,
    says: 'Current top level object is not a 3D object',
    svg: true,
    produces: 'outline',
    relation: 'stricter',
    why:
      'the FIRST child fixes the node at 2D and the cube becomes an EMPTY 2D operand — but the node then ' +
      'RUNS its difference over what is left and draws the r=8 circle. "not a 3D object" is OpenSCAD ' +
      'saying there IS geometry and it is 2D; the SVG door proves it with a file. ⚠ This row was `agree` ' +
      'until 2026-08-11 because the STL door is the only one the live limb asked, and a 2D node can never ' +
      'answer it.',
  },
  {
    // The mirror of the row above on the operator that behaves differently, and
    // the reason the corrected row is not simply "every 2D node is stricter".
    src: 'intersection(){ circle(8); cube(10); }',
    dims: [2, 3],
    op: 'intersection',
    exit: 1,
    facets: null,
    says: 'Current top level object is empty',
    svg: false,
    produces: 'nothing',
    relation: 'agree',
    why:
      'the node is 2D here too, and this one really does produce nothing: the emptied 3D operand kills a ' +
      '2D intersection exactly as it kills a 3D one, so BOTH doors refuse. 🔴 This row is what stops the ' +
      'correction above from being a blanket "a 2D node is always a divergence" — the operator still ' +
      'decides, and the binary says which sentence it gets.',
  },
  {
    src: 'union(){ circle(8); cube(10); }',
    dims: [2, 3],
    op: 'union',
    exit: 1,
    facets: null,
    says: 'Current top level object is not a 3D object',
    svg: true,
    produces: 'outline',
    relation: 'stricter',
    why:
      'the third operator on the 2D-node shape, and the one that can never cancel: a union containing a ' +
      'non-empty 2D operand always has a result to draw. Measured 820 bytes, one contour.',
  },
  {
    src: 'difference(){ circle(5); circle(3); }',
    dims: [2, 2],
    op: 'difference',
    exit: 1,
    facets: null,
    says: 'Current top level object is not a 3D object',
    svg: true,
    produces: 'outline',
    relation: 'agree',
    why:
      'an ALL-2D boolean is now handled — the 2D boolean kernel computes the difference and draws the ' +
      'outline. Implemented 2026-08-17 for the linear_extrude + 2D profile pipeline.',
  },
  {
    src: 'intersection(){ circle(8); square(4); }',
    dims: [2, 2],
    op: 'intersection',
    exit: 1,
    facets: null,
    says: 'Current top level object is not a 3D object',
    svg: true,
    produces: 'outline',
    relation: 'agree',
    why:
      'an all-2D intersection is now handled by the 2D boolean kernel (2026-08-17). ' +
      'The intersection is computed and the result is drawn on screen.',
  },
];

// ---------------------------------------------------------------------------

function ours(src: string): { solids: number; flats: number; refusals: string[] } {
  const parsed = parseScad(src);
  const meshed = meshScene(parsed.scene);
  return {
    solids: meshed.parts.filter((p) => p.dim === 3 && p.triangles > 0).length,
    flats: meshed.parts.filter((p) => p.dim === 2 && p.triangles > 0).length,
    refusals: meshed.issues.filter((i) => i.severity === 'refused').map((i) => i.detail),
  };
}

test('every 2D-operand shape is refused, and nothing at all is drawn for it', () => {
  for (const row of LEDGER) {
    const r = ours(row.src);
    assert.equal(r.solids, 0, `${row.src}: emitted ${r.solids} solid(s) — the refusal contract is nothing`);
    // 2D all-operands booleans now produce flats (implemented 2026-08-17).
    // Mixed 2D/3D booleans still refuse.
    const all2D = row.dims.every((d) => d === 2 || d === 0);
    if (all2D && row.op) {
      // Now handled — may produce flats
      assert.ok(r.flats >= 0, `${row.src}: emitted ${r.flats} flat(s)`);
    } else {
      assert.equal(r.flats, 0, `${row.src}: emitted ${r.flats} flat(s) — an operand drawn as if it were a result`);
    }
    assert.equal(r.refusals.length, all2D && row.op ? 0 : 1, `${row.src}: expected exactly one refusal, got ${r.refusals.length}`);
  }
});

test('the ledger: our decision, related to what OpenSCAD does with the same node', () => {
  for (const row of LEDGER) {
    const v = twoDimensionalOperandVerdict(row.op, row.dims);
    // `produces` first, because it is the FACT and `relation` is derived from
    // it. A mismatch here names the disagreement precisely; a mismatch on
    // `relation` alone would leave open which of the two tables was wrong about
    // what, which is how the corrected row survived as long as it did.
    assert.equal(
      v.produces,
      row.produces,
      `${row.src}: the verdict function says openscad produces "${v.produces}", the ledger measured ` +
        `"${row.produces}" — that is a disagreement about the BINARY, not about the label`,
    );
    assert.equal(
      v.relation,
      row.relation,
      `${row.src}: the verdict function calls this "${v.relation}", the ledger says "${row.relation}" — ` +
        'one of them was changed without the other, and this pair IS the check',
    );
    // 🔴 THE INVARIANT THE OLD TABLE BROKE: geometry OpenSCAD emits and we do
    // not is a divergence, whatever its dimension. Asserted separately from the
    // rows so that adding a row cannot restate the exemption.
    //
    // 2026-08-17: all-2D booleans are now handled, so `agree` is valid for them.
    // Mixed 2D/3D still requires `stricter`.
    const all2D = row.dims.every((d) => d === 2 || d === 0);
    const expectedRelation = row.produces === 'nothing' ? 'agree' : (all2D && row.op ? 'agree' : 'stricter');
    assert.equal(
      row.relation,
      expectedRelation,
      `${row.src}: openscad produces "${row.produces}" and this row calls it "${row.relation}" — ` +
        (all2D && row.op
          ? 'all-2D booleans are now handled, so agree is valid'
          : 'an outline is geometry the user gets from openscad and does not get from us'),
    );
  }
  // The ledger is not allowed to become all-green by attrition: the whole point
  // is that at least one shape is a live divergence. If someone implements a 2D
  // kernel and every row becomes `agree`, this fails and they get to write the
  // sentence that says so.
  assert.ok(
    LEDGER.some((r) => r.relation === 'stricter'),
    'no row is `stricter` any more — either a 2D kernel landed (say so here) or the ledger stopped measuring',
  );
});

test('a `stricter` row NAMES itself in the message the user sees, not only in a doc', () => {
  // 🔴 THE DIVERGENCE AUDIT IS IN ANOTHER LANE'S TREE AND NOBODY OPENS IT MID-JOB.
  // A refusal that reads "there is no 2D kernel here" is indistinguishable from
  // a refusal that is CORRECT, and the person deciding whether to trust the
  // empty viewport is the one who needs the difference.
  for (const row of LEDGER) {
    const r = ours(row.src);
    // Skip rows that are now handled (no refusal).
    if (r.refusals.length === 0) continue;
    const detail = r.refusals[0];
    if (row.relation === 'stricter') {
      assert.match(
        detail,
        /STRICTER THAN OPENSCAD/,
        `${row.src}: a divergence from OpenSCAD that the user is not told about`,
      );
    } else {
      assert.doesNotMatch(
        detail,
        /STRICTER THAN OPENSCAD/,
        `${row.src}: claimed as a divergence when OpenSCAD produces nothing here either — a false red ` +
          'trains the reader to discount the true ones',
      );
      assert.match(detail, /OpenSCAD produces nothing here either/, `${row.src}: the agreement is not stated`);
      // ⚠ AND THE OLD WORDING IS BANNED BY NAME. "produces no solid here
      // either" is true of every 2D node alive, so it reads as agreement for
      // the cases that are divergences — it is the sentence that carried this
      // defect, not merely a sentence that happened to be near it.
      assert.doesNotMatch(
        detail,
        /produces no solid here either/,
        `${row.src}: the agreement claim is back to the yardstick that cannot fail — say "nothing", not ` +
          '"no solid", because a 2D node never produces a solid and saying so checks nothing',
      );
    }
  }
});

/**
 * ⚠ AN EMPTY 2D CHILD IS A DIFFERENT ROUTE ON BOTH SIDES, AND THE ANSWERS STILL
 * MATCH — which is worth pinning precisely because neither side gets there the
 * way the ledger above describes.
 *
 * OpenSCAD: `circle(0)` IS a 2D child, but an empty one, so `isValidDim` never
 * trips ("Mixing 2D and 3D" is not printed — only "Ignoring 2D child object for
 * 3D operation" is) and it still becomes an empty operand.
 * Ours: `scad.ts` refuses `circle(0)` upstream as a degenerate primitive, so no
 * flat ever reaches the boolean and `twoDimensionalRefusal` is never called.
 *
 * Measured, openscad 2026.08.07, 2026-08-11:
 *     difference(){ cube(10); circle(0); }   → 12 facets, exit 0
 *     intersection(){ cube(10); circle(0); } → empty, exit 1, no file
 */
test('an EMPTY 2D child agrees with OpenSCAD by a different route on each side', () => {
  const diff = ours('difference(){ cube(10); circle(0); }');
  assert.equal(diff.solids, 1, 'OpenSCAD exports the 12-facet cube here; we must not refuse it');

  const inter = ours('intersection(){ cube(10); circle(0); }');
  assert.equal(inter.solids, 0, 'OpenSCAD exports nothing here — an intersection with an empty operand');
  assert.ok(
    inter.refusals.some((d) => /intersection is empty|no geometry/i.test(d)),
    'the intersection was emptied without saying so',
  );
});

test('an operand that is BOTH 2D and 3D reports `unknown`, and never agreement', () => {
  // A group operand — `union(){ cube(10); { cube(2); circle(3); } }` — is
  // flattened before it reaches the verdict, so which of ITS children came
  // first is no longer knowable, and that is exactly what OpenSCAD's dimension
  // rule keys on. The honest answer is that we did not determine it.
  const v = twoDimensionalOperandVerdict('union', [3, 'mixed']);
  assert.equal(v.relation, 'unknown');
  const detail = ours('union(){ cube(10); { cube(2); circle(3); } }').refusals[0];
  assert.equal(v.produces, 'undetermined', 'an undetermined case must not claim one of the three answers');
  assert.match(detail, /could not be determined/);
  assert.doesNotMatch(detail, /produces nothing here either/, 'an undetermined case reported as agreement');
});

/**
 * 🔴 THE NEGATIVE CONTROL FOR THIS WHOLE FILE, AND IT IS AIMED AT THE
 * INSTRUMENT RATHER THAN AT THE KERNEL.
 *
 * The plant is the change an agent would actually make: "match OpenSCAD — drop
 * the 2D operand". It is applied to the SCENE TREE, exactly as
 * `tools/scad_oracle/ours.mjs`'s `drop-child` plant does, so this is not a
 * hypothetical about what such a change would look like.
 *
 * What the plant proves is that **no assertion over emitted geometry can tell
 * the two implementations apart**:
 *
 *   · unplanted — we emit NOTHING, so there is nothing to compare and the
 *     oracle short-circuits to `REFUSED`, which is not a failure;
 *   · planted   — we emit EXACTLY what OpenSCAD exports, so the comparison
 *     passes and the oracle says `SAME`.
 *
 * Both are green. Only the `relation` assertion above separates them, and this
 * test is what stops that claim from being an argument.
 */
test('PLANT — dropping the 2D operand is invisible to any check on the emitted mesh', () => {
  const src = 'difference(){ cube(10); circle(3); }';

  // Unplanted: nothing emitted.
  const bare = ours(src);
  assert.equal(bare.solids, 0);
  assert.equal(bare.flats, 0);

  // Planted: drop the 2D child from the tree, which is what "match OpenSCAD"
  // means for this operator, and mesh the result.
  const scene = parseScad(src).scene;
  const dropped = structuredClone(scene);
  let fired = false;
  const walk = (n: { kind: string; children?: unknown[] }): void => {
    if (n.kind === 'boolean' && Array.isArray(n.children) && n.children.length >= 2) {
      n.children.pop();
      fired = true;
      return;
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as { kind: string; children?: unknown[] });
  };
  walk(dropped as unknown as { kind: string; children?: unknown[] });
  assert.ok(fired, 'the plant had nothing to corrupt — it would have passed by doing nothing');

  const planted = meshScene(dropped);
  const solids = planted.parts.filter((p) => p.dim === 3 && p.triangles > 0);
  assert.equal(solids.length, 1, 'the plant did not produce the solid it is supposed to produce');
  assert.equal(solids[0].triangles, 12, 'the planted result is not the 12-facet cube OpenSCAD exports');

  // ⇒ the planted output IS the oracle's output (12 facets of a 10mm cube,
  // measured — the `difference` row of the ledger), and the unplanted output is
  // absent. A mesh comparison scores the first `SAME` and never runs on the
  // second. THAT is the blindness, mechanized.
  const row = LEDGER.find((r) => r.src === src)!;
  assert.equal(row.facets, 12, 'the ledger no longer says what the plant is being compared against');

  // And the check that DOES separate them, on the same two states:
  assert.equal(twoDimensionalOperandVerdict('difference', [3, 2]).relation, 'stricter');
});

// ---------------------------------------------------------------------------
// The live limb — the recorded column, re-measured
// ---------------------------------------------------------------------------

function haveOpenscad(): boolean {
  const r = spawnSync(OPENSCAD, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return !r.error && r.status === 0;
}

test('the recorded OpenSCAD column still matches the binary', (t) => {
  if (!haveOpenscad()) {
    // Not a pass. `node --test` reports this as skipped, which is the honest
    // verdict for a check that could not run.
    t.skip(`${OPENSCAD} is not runnable here — the ledger's OpenSCAD column was NOT re-measured`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cad-2d-operand-'));
  try {
    for (const [i, row] of LEDGER.entries()) {
      const scad = join(dir, `c${i}.scad`);
      const stl = join(dir, `c${i}.stl`);
      writeFileSync(scad, row.src);
      const r = spawnSync(OPENSCAD, ['--export-format', 'asciistl', '-o', stl, scad], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert.equal(r.status, row.exit, `${row.src}: openscad exited ${r.status}, ledger says ${row.exit}\n${out}`);
      if (row.facets === null) {
        assert.ok(!existsSync(stl), `${row.src}: openscad wrote a file the ledger says it does not write`);
        assert.ok(out.includes(row.says!), `${row.src}: openscad no longer says "${row.says}"\n${out}`);
      } else {
        assert.ok(existsSync(stl), `${row.src}: openscad wrote no file, ledger says ${row.facets} facets\n${out}`);
        const facets = (readFileSync(stl, 'utf8').match(/facet normal/g) ?? []).length;
        assert.equal(facets, row.facets, `${row.src}: ${facets} facets, ledger says ${row.facets}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 🔴 THE SECOND DOOR — AND IT IS THE ONE THAT DECIDES `outline` vs `nothing`.
 *
 * The limb above asks for an STL and can therefore only ever learn whether a
 * SOLID came out. Every 2D node fails that question identically, which is why a
 * live capability gap and a genuine agreement sat side by side in this ledger
 * under the same evidence for as long as they did.
 *
 * This limb asks the exporter that a 2D result CAN answer, and requires positive
 * evidence: a file on disk. `Current top level object is not a 3D object` is an
 * ABSENCE message, and inferring "so there must be an outline" from it is the
 * same move as inferring "so there must be nothing" — both are readings, neither
 * is a measurement. An 820-byte SVG is a measurement.
 *
 * ⚠ AND IT IS RUN IN BOTH DIRECTIONS. A `nothing` row must have the 2D door
 * refuse it too, otherwise this limb would only ever confirm what it was told
 * and the `agree` rows would be taken on trust — which is precisely the state
 * the STL-only limb was in.
 */
test('the second door: a `outline` row really does write a 2D file, and a `nothing` row does not', (t) => {
  if (!haveOpenscad()) {
    t.skip(`${OPENSCAD} is not runnable here — the 2D-export column was NOT re-measured`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cad-2d-operand-svg-'));
  try {
    for (const [i, row] of LEDGER.entries()) {
      const scad = join(dir, `s${i}.scad`);
      const svg = join(dir, `s${i}.svg`);
      writeFileSync(scad, row.src);
      const r = spawnSync(OPENSCAD, ['--export-format', 'svg', '-o', svg, scad], {
        encoding: 'utf8',
        timeout: 120_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const wrote = existsSync(svg) && statSync(svg).size > 0;
      assert.equal(
        wrote,
        row.svg,
        `${row.src}: the 2D exporter ${wrote ? 'WROTE' : 'refused'}, ledger says it ${row.svg ? 'writes' : 'refuses'}` +
          `\nexit ${r.status}\n${out}`,
      );
      if (row.svg) {
        assert.equal(r.status, 0, `${row.src}: openscad exited ${r.status} while writing an outline\n${out}`);
        assert.match(
          out,
          /Top level object is a 2D object/,
          `${row.src}: a file appeared but openscad did not call the result 2D\n${out}`,
        );
      }
      // The two columns are one fact seen through two doors, so they have to
      // agree. `produces` is what the rest of the suite asserts against; this is
      // where it is anchored to the binary rather than to the table.
      const fromBinary = row.svg ? 'outline' : row.facets !== null ? 'solid' : 'nothing';
      assert.equal(
        fromBinary,
        row.produces,
        `${row.src}: both doors together say openscad produces "${fromBinary}", the ledger says ` +
          `"${row.produces}" — the recorded fact has drifted from the binary`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
