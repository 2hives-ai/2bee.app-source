/**
 * THE CLAMP PICTURE AND THE CLAMP KEEPOUT ARE ONE SET OF NUMBERS.
 *
 * 🔴 WHY THIS FILE EXISTS. Until 2026-08-27 `workholdingShape.tsx` carried its
 * own hand-keyed copy of every entry's `heightMm` and `footprintMm`, its header
 * asserted *"Every number here is the number in `workholding.ts`"*, and
 * `App.tsx`'s picker comment went further — *"the schematic beside each is drawn
 * to scale from the SAME numbers, so a picture and a keepout cannot disagree."*
 *
 * Three of the nineteen disagreed. The worst was
 * `machinable-low-profile-clamp`: catalogue `[25.4, 18.0]`, drawing
 * `[18, 25.4]` — **the axes transposed on a steel clamp at 43 RC**, where the
 * catalogue value is what `App.tsx` copies into `ClampCfg` and gate `P7` clears
 * a toolpath against. The operator reads 18 mm across the sheet edge from the
 * picture and the checked keepout is 25.4 mm.
 *
 * Nothing read either copy: `workholding` appears nowhere in `gates/`, and
 * `terminology.test.ts` sweeps this file only for the words `sheet|bed`.
 *
 * The geometry now lives once, in `workholding.ts`, and the drawing derives it.
 * These tests are what keeps that true — a second table can grow back, and the
 * comment that said it had not is the thing that let it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKHOLDING } from '../src/workholding';
import { DRAWN_IDS, shapeFor } from '../src/workholdingShape';

test('every drawn id is a catalogue id — a schematic for a device not in the list is a picture of nothing', () => {
  const cat = new Set(WORKHOLDING.map((w) => w.id));
  const orphans = DRAWN_IDS.filter((id) => !cat.has(id));
  assert.deepEqual(orphans, [], `drawn but not in the catalogue: ${orphans.join(', ')}`);
});

test('every catalogue entry has a drawing — the picker renders one per row', () => {
  const missing = WORKHOLDING.filter((w) => !DRAWN_IDS.includes(w.id)).map((w) => w.id);
  assert.deepEqual(missing, [], `catalogue entries with no schematic: ${missing.join(', ')}`);
});

test('🔴 the drawn height is the CATALOGUE height, for every entry, with no override possible', () => {
  /* Height has no draw-only case: a device is as tall as it is, and the height
   * is what a rapid has to clear. There is deliberately no `drawnHeightMm`. */
  for (const w of WORKHOLDING) {
    const s = shapeFor(w.id);
    assert.ok(s, `${w.id}: no resolved shape`);
    assert.equal(s.heightMm, w.heightMm, `${w.id}: drawn height`);
  }
});

test('🔴 the drawn footprint is the KEEPOUT, except where the device obstructs NOTHING', () => {
  /* This is the assertion the transposed clamp would have failed. An entry that
   * a cutter must avoid may not be drawn at a size the check does not use; an
   * entry that obstructs nothing has a [0, 0] keepout that is correct and
   * undrawable, and may say what to draw instead — with a reason. */
  for (const w of WORKHOLDING) {
    const s = shapeFor(w.id);
    assert.ok(s, `${w.id}: no resolved shape`);
    if (s.drawnFootprintMm === undefined) {
      assert.deepEqual(
        s.footprintMm,
        w.footprintMm,
        `${w.id}: drawn footprint must equal the catalogue keepout`
      );
      continue;
    }
    assert.equal(
      w.obstructs,
      false,
      `${w.id}: declares a draw-only footprint while obstructs=true. On a device a cutter must ` +
        `avoid, the picture and the keepout answer the SAME question and may not differ.`
    );
    assert.ok(
      (s.drawnFootprintWhy ?? '').trim().length > 20,
      `${w.id}: a draw-only footprint with no stated reason is indistinguishable from the drift this replaced`
    );
  }
});

test('the two declared draw-only overrides are the ONLY ones, and both are tape', () => {
  /* Pinned as a SET rather than a count: a third override appearing is a
   * decision somebody should have to make deliberately, and a count would let
   * one be swapped for another silently. */
  const over = WORKHOLDING.filter((w) => shapeFor(w.id)?.drawnFootprintMm !== undefined).map((w) => w.id);
  assert.deepEqual(over.sort(), ['double-sided-tape', 'tape-and-ca-glue']);
});

test('🔴 no caption or warning restates a height the drawing already derives', () => {
  /* The defect this catches, found 2026-08-27 by review AFTER the derivation
   * landed: `double-sided-tape`'s caption read "Drawn to scale: 0.127 mm" while
   * `Film()` prints `${s.heightMm} mm` from the catalogue (0.13) on a leader in
   * the SAME SVG panel. One picture, two thicknesses for one tape — and 0.127 is
   * the exact drift the derivation was written to remove, surviving one field
   * along because no other test here reads `caption` or `warn`.
   *
   * ⚠ THE FIRST VERSION OF THIS TEST WAS UNSOUND AND ITS FALSE RED IS WHY THE
   * RULE IS WHAT IT IS. It flagged any figure within 20% of the height, and
   * `toggle-clamp-horizontal` fired immediately: *"Clearance under the arm is
   * 16.5 mm"* / *"The stock is 18 mm."* Those are TWO DIFFERENT QUANTITIES whose
   * whole point is the contrast, and they are 9% apart. A proximity threshold
   * cannot tell a restatement from a comparison, and tuning it until the two
   * cases I happened to have both passed would have been fitting the rule to the
   * evidence.
   *
   * The rule instead asks a question with an answer: **is this the same
   * measurement written to a different precision?** `0.127` and `0.13` agree to
   * two significant figures — one number, two roundings. `18` and `16.5` do not
   * (18 vs 17). Prose stays free to quote intrusion, stock thickness, a sum, or
   * the height exactly; what it may not do is print a rounding of the number the
   * drawing derives, because then one panel carries two answers. */
  /* ⚠ A vacuity counter, because this test can pass by finding nothing to check
   * — every entry figure-free, or `caption` gone undefined and `${undefined}`
   * yielding no matches. It asserts the sweep actually looked at figures. */
  let figuresSeen = 0;
  const sameMeasurement = (a: number, b: number) =>
    a !== b && a.toPrecision(2) === b.toPrecision(2);

  for (const w of WORKHOLDING) {
    const s = shapeFor(w.id);
    assert.ok(s, `${w.id}: no resolved shape`);
    const prose = `${s.caption} ${s.warn ?? ''}`;
    /* `(?<![\d.])(\d*\.?\d+)` so a bare-dot figure parses as itself. Measured:
     * the first form read ".13 mm" as **13** — a hundredfold error in the
     * guard's own input, which would have compared the wrong number and reported
     * the wrong verdict either way. Still evaded by "0,127 mm", "1.27e-1 mm" and
     * by any non-mm unit ("0.005 in", "127 µm"); stated rather than chased,
     * because a caption written in inches is a different review problem from one
     * that restates a derived millimetre. */
    const figures = [...prose.matchAll(/(?<![\d.])(\d*\.?\d+)\s*mm/g)].map((m) => Number(m[1]));

    /* 🔴 THE EXEMPTION, AND IT IS THE WHOLE RULE. Prose that quotes the derived
     * height EXACTLY is unambiguous no matter what else it quotes — that panel
     * has stated its answer, and the other figures are the comparisons the
     * sentence exists to make. The defect was never "two numbers near each
     * other"; it was a panel showing a height and never showing the derived one.
     *
     * This exemption is why the second version of this test also had to go. It
     * flagged `dog-hole-bench-dog` — *"The 0.7 in dog: 17.8 mm, so it sits 0.2 mm
     * BELOW an 18 mm workpiece"* — because 17.8 and 18 agree to two significant
     * figures. They are the dog and the WORKPIECE, and the caption's entire point
     * is the 0.2 mm between them. Two false reds from two different numeric rules
     * is the signal that the question was numeric and the answer is not. */
    /* 🔴 THE HOLE THIS LEAVES IS NAMED, because it is load-bearing. Skipping the
     * WHOLE entry means a caption that quotes the derived value AND a stale
     * rounding of it — "Drawn to scale: 0.127 mm. It is 0.13 mm thick." — passes.
     * Checking the non-exact figures instead re-breaks `dog-hole-bench-dog`
     * ("17.8 mm, so it sits 0.2 mm BELOW an 18 mm workpiece"), where 18 is the
     * WORKPIECE and agrees with 17.8 to two significant figures. No numeric rule
     * separates those two sentences and both real captions must pass. The
     * exemption stays, the evasion is written down, and that case is one a person
     * has to catch in review. */
    if (figures.some((v) => v === s.heightMm)) continue;

    for (const v of figures) {
      figuresSeen += 1;
      assert.ok(
        !sameMeasurement(v, s.heightMm),
        `${w.id}: prose says "${v} mm", the drawing derives ${s.heightMm} mm from the catalogue, and ` +
          `the panel never states ${s.heightMm} — the same measurement at two precisions, and the ` +
          `operator has no way to tell which is the device. Quote the derived value or drop the figure.`
      );
    }
  }
  assert.ok(
    figuresSeen > 0,
    'this test examined ZERO figures across the whole catalogue — it passed by looking at nothing, ' +
      'which is what an undefined `caption` or a figure-free rewrite would do'
  );
});

// ---------------------------------------------------------------------------
// The Pitbull's axes — the one number a merge silently chose for us
// ---------------------------------------------------------------------------

test('the Pitbull footprint is [across, along] = [18.0, 25.4], not the transpose', () => {
  /*
   * 🔴 THIS IS THE VALUE A UNIFICATION PICKED WITHOUT ANSWERING THE QUESTION.
   *
   * Two tables disagreed — catalogue [25.4, 18.0], drawing [18, 25.4]. Making
   * the drawing DERIVE from the catalogue removed the disagreement and thereby
   * ruled in favour of the catalogue, because that is where the data lived, not
   * because anyone decided it was right. It was not: `bom` recovered the raw
   * MB.26077 vendor row on 2026-08-31 (curl, not an AI-summarised read, which
   * drops column alignment) — C = ClampWidth = 1.00in = 25.4mm named "width"
   * twice, E = 0.710in = 18.03mm — and reads 18.0 as ACROSS the clamped edge.
   * The drawing had been right for as long as they disagreed.
   *
   * ⚠ A MERGE IS A RULING EVEN WHEN NOBODY NOTICES MAKING IT, and the merged
   * value carries no trace of which branch it came from. That is why this
   * asserts the ORDER and not merely that the two tables agree: they agreed
   * before this was correct, and would agree again if it were transposed back.
   *
   * Consequence if it flips: `App.tsx` copies `footprintMm` straight into
   * `ClampCfg.w/h` (grep `w: fw`), so gate P7 would clear a rapid over 7.4 mm
   * of tool steel at 43 RC that it believes is spoilboard.
   */
  const pit = WORKHOLDING.find((w) => w.id === 'machinable-low-profile-clamp');
  assert.ok(pit, 'the entry must exist');
  assert.deepEqual(pit.footprintMm, [18.0, 25.4]);
  // The drawing must still derive it, or the second table has grown back.
  assert.deepEqual(shapeFor(pit.id)?.footprintMm, [18.0, 25.4]);
});

test('the Pitbull entry still ADMITS the axis assignment is unmeasured', () => {
  /*
   * 🔴 AN ANSWER ARRIVING IS NOT A MEASUREMENT HAPPENING. `bom` rates the axis
   * assignment moderate-high — reasoned from clamp mechanics and a
   * low-resolution vendor GIF, because the vendor never writes "across" or
   * "along" — and asks for a caliper on a real MB.26077 before this gates a
   * cut. The two NUMBERS are certain; which one runs which way is not.
   *
   * The failure this guards is the quiet upgrade: someone tidies the note,
   * the entry reads like every measured neighbour, and a keepout that was
   * inferred from a picture becomes indistinguishable from one that was
   * measured. A hedge deleted is a claim made.
   */
  const pit = WORKHOLDING.find((w) => w.id === 'machinable-low-profile-clamp');
  assert.ok(pit, 'the entry must exist');
  assert.match(pit.notes ?? '', /caliper/i, 'the open physical check must still be named');
  assert.match(pit.notes ?? '', /moderate-high|not measured|AXIS ASSIGNMENT IS NOT/i);
});

test('the Pitbull entry says the caliper check is BLOCKED, not merely outstanding', () => {
  /*
   * 🔴 A REMEDY NOBODY CAN PERFORM IS NOT A PLAN. `bom` grepped the sourcing
   * ledger, every BOM and every fixturing doc on 2026-08-31: no MB.26077 has
   * ever been bought by this company, and every hit in the repo is this
   * catalogue entry itself. So "caliper it before this gates a cut" is not
   * pending work with an owner — it is a condition on ever trusting the entry,
   * and the two read completely differently to whoever picks this clamp.
   *
   * ⚠ THE FAILURE THIS GUARDS IS DECAY, NOT EDITING. An "owed by someone else"
   * line goes stale silently: it reads as diligence, so nobody re-checks it,
   * and a check nobody owns looks identical to a check somebody is doing. If
   * the part is ever bought this assertion should be UPDATED by the person who
   * bought it — going red is the prompt.
   */
  const pit = WORKHOLDING.find((w) => w.id === 'machinable-low-profile-clamp');
  assert.ok(pit, 'the entry must exist');
  assert.match(
    pit.notes ?? '',
    /never bought one|no such unit|blocked on a PURCHASE/i,
    'the entry must say no unit exists to measure, not merely that a measurement is wanted',
  );
});

test('double-sided tape carries its PUBLISHED thickness, not a rounding of it', () => {
  /* 0.127 mm is the published 5 mil. The entry used to carry `0.13` while its
   * own `notes` cited 0.127 three lines below — a rounding that had become the
   * fact, with the real number in the same object. */
  const tape = WORKHOLDING.find((w) => w.id === 'double-sided-tape');
  assert.ok(tape, 'the entry must exist');
  assert.equal(tape.heightMm, 0.127);
});
