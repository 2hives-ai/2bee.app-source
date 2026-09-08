/**
 * A CATALOGUE NAME IS A CLAIM, AND IT MUST STAY TRUE OF THE NUMBER BESIDE IT.
 *
 * 🔴 The app already applied this rule at one door and not the other. Typing a
 * thickness clears `touchPlateId`, with the reason written at the input —
 * *"Keeping its name beside a hand-typed thickness would be a false
 * provenance."* RESTORING a saved machine had no equivalent: `touchPlateMm` and
 * `touchPlateId` come back independently, so a machine saved against a
 * catalogue entry that has since been corrected returns wearing the entry's
 * NAME beside a number that is no longer the entry's.
 *
 * Why it is not cosmetic: the picker renders the LIVE catalogue's `topMm` next
 * to the SAVED thickness, and the saved one is what reaches `touch_plate_mm`
 * and therefore the probe's Z datum in the emitted program. The operator sees a
 * sourced-looking record and a number from somewhere else.
 *
 * ⚠ `undeclared` is deliberately NOT `agrees`. An entry that publishes no top
 * has nothing to disagree with, and reading "nothing to check" as "checked" is
 * the exact collapse gate E5 exists to stop one level up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOUCH_PLATES, plateProvenance } from '../src/touchplates';

/** A catalogue entry that actually publishes a top — found, not assumed. */
const withTop = TOUCH_PLATES.find((p) => p.topMm != null);

test('vacuity: the catalogue must contain an entry that publishes a top', () => {
  /* Every test below is about the published-top case. If the catalogue ever
   * stops carrying one, they would all pass by never reaching their branch. */
  assert.ok(withTop, 'no TOUCH_PLATES entry declares topMm — the tests below are vacuous');
});

test('no id claims nothing, so nothing can be false', () => {
  assert.equal(plateProvenance('', '1.6').verdict, 'unnamed');
  assert.equal(plateProvenance(null, '1.6').verdict, 'unnamed');
  assert.equal(plateProvenance('   ', '1.6').verdict, 'unnamed');
});

test('an id the catalogue no longer lists is UNKNOWN, not agreeing', () => {
  assert.equal(plateProvenance('a-plate-that-was-deleted', '1.6').verdict, 'unknown');
});

test('the saved thickness matching the published top AGREES', () => {
  assert.equal(plateProvenance(withTop!.id, withTop!.topMm!).verdict, 'agrees');
  assert.equal(plateProvenance(withTop!.id, String(withTop!.topMm)).verdict, 'agrees');
});

test('🔴 a saved thickness that is NOT the published top has DIVERGED', () => {
  const off = withTop!.topMm! + 0.4;
  const p = plateProvenance(withTop!.id, off);
  assert.equal(p.verdict, 'diverged');
  assert.equal(p.catalogueTopMm, withTop!.topMm, 'the refusal must be able to name both numbers');
});

test('an UNPARSEABLE thickness has DIVERGED — it is certainly not the published one', () => {
  assert.equal(plateProvenance(withTop!.id, 'about 1.6').verdict, 'diverged');
});

test('🔴 a BLANK thickness is UNDECLARED, not a declared zero', () => {
  /* ⚠ THIS TEST ENCODED THE DEFECT UNTIL 2026-08-28. It asserted `''` and
   * `undefined` were "diverged" under the label *"unparseable"* — and neither is
   * unparseable: `Number('')`, `Number(null)` and `Number(undefined ?? '')` are
   * all a finite **0**, so they never reached the `isFinite` guard the test named
   * and were compared as a declared zero instead.
   *
   * Reachable, and by the same premise the whole ticket rests on: nine catalogue
   * entries publish no top, the app sets the thickness to `''` for exactly those,
   * and if such an entry later gains a published top the operator was told
   * *"…beside a thickness of 0 mm"* — a number they never typed, in a sentence
   * withdrawing a provenance that was in fact honest. This app treats blank ≠ 0
   * as load-bearing in three other places and says so in each. */
  assert.equal(plateProvenance(withTop!.id, '').verdict, 'undeclared');
  assert.equal(plateProvenance(withTop!.id, '   ').verdict, 'undeclared');
  assert.equal(plateProvenance(withTop!.id, undefined).verdict, 'undeclared');
  assert.equal(plateProvenance(withTop!.id, null).verdict, 'undeclared');
  // …and a real zero, typed, is a declared zero and must still be compared.
  assert.equal(plateProvenance(withTop!.id, 0).verdict, 'diverged');
  assert.equal(plateProvenance(withTop!.id, '0').verdict, 'diverged');
});

test('🔴 UNDECLARED carries the discriminator, because it means two different things', () => {
  /* `catalogueTopMm` is how a caller tells "the entry publishes nothing" from
   * "the entry publishes a top and this machine declares nothing". The one
   * caller ignored it and wrote a sentence that was FALSE in the second world —
   * which is the world this whole ticket rests on: an entry that published no
   * top when the machine was saved, and gained one afterwards. */
  const blankAgainstPublished = plateProvenance(withTop!.id, '');
  assert.equal(blankAgainstPublished.verdict, 'undeclared');
  assert.equal(
    blankAgainstPublished.catalogueTopMm,
    withTop!.topMm,
    'the catalogue DOES publish a top here, and a caller must be able to say so'
  );

  const noTop = TOUCH_PLATES.find((p) => p.topMm == null);
  if (noTop) {
    const p2 = plateProvenance(noTop.id, '1.6');
    assert.equal(p2.verdict, 'undeclared');
    assert.equal(p2.catalogueTopMm, null, 'nothing published — the other world');
  }
});

test('an entry that publishes NO top is UNDECLARED, which is not the same as agreeing', () => {
  const noTop = TOUCH_PLATES.find((p) => p.topMm == null);
  if (!noTop) return; // stated: the catalogue may legitimately have none
  assert.equal(plateProvenance(noTop.id, '1.6').verdict, 'undeclared');
  assert.equal(plateProvenance(noTop.id, '99').verdict, 'undeclared');
});
