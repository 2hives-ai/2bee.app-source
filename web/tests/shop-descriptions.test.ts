/**
 * 🔴 IN A TEST SUITE, THE TEST NAME IS THE PASS MESSAGE (ceo/`pcb`, 2026-09-06).
 *
 * A green run prints the NAME and none of the comments, so a name that claims
 * more than its assertions reach is an overclaim in the one string a reader of a
 * PASS actually sees. Three names here did exactly that and were narrowed:
 *
 *   "…is cad's own text, VERBATIM"        -> it matches a key and an OPENING CLAUSE
 *   "…with its OWN REASON"                -> it checks the reason is DATED and non-retiring;
 *                                            whether the cited ruling exists is not
 *                                            checkable from the artefact at all
 *   "…a witness ONLY A RUN COULD PRODUCE" -> it checks a witness is present and that the
 *                                            scanned-line count is non-trivial
 *
 * ⚠ The annotations inside each test were already honest about their scope. That
 * was not enough: an annotation reaches a reader of the CODE, and the failure
 * mode is a reader of the OUTPUT. Same shape as `pcb` moving a limit inside a
 * PASS message, and one layer out from the spelling-test finding that prompted
 * the annotations.
 */
/**
 * The Designs catalogue's descriptions, and the designs it deliberately does
 * NOT list.
 *
 * 🔴 WHAT THIS GUARDS, PHYSICALLY: a card is outward-facing copy about a part a
 * beekeeper might make. Two failures live here, and neither one looks like a
 * failure on the page:
 *
 *   1. A DESCRIPTION THAT IS NOT cad's. This lane does not write these; a
 *      confident sentence about another lane's part, written by someone who did
 *      not design it, is a claim wearing a fact's clothes. So a card with no
 *      sentence must show NO sentence — never a placeholder, never the title
 *      restated as prose.
 *   2. A CARD FOR A CANCELLED CONFIGURATION. The founder ruled 2026-08-10 "no
 *      dual queen setup, simple 1 queen setup". `cad` withheld the sentences for
 *      the four dual-queen entrance parts — and the cards rendered anyway,
 *      because this catalogue walks FILES and their withhold list is by
 *      REGISTERED PART NAME. Withholding a sentence is not withholding a card.
 *
 * ⚠ These assert on the BUILT index, never on the generator's intent — the
 * output is what a stranger reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(WEB, 'public', 'shop', 'index.json');
const CAD = join(WEB, '..', '..', '..', 'hardware', 'cad');

/* 🔴 public/shop/ is GITIGNORED and generated. A checkout that has not run
 * `npm run shop` has no index, and a test that quietly passes on a missing file
 * is a check that stops existing exactly where it is easiest not to notice.
 * So: skip LOUDLY, with the command, rather than pass. */
const built = existsSync(INDEX);
const index = built ? JSON.parse(readFileSync(INDEX, 'utf8')) : null;
const need = (t: { skip: (why: string) => void }) =>
  built || (t.skip('public/shop/index.json not built — run `npm run shop` first'), false);

test('every listed description matches a key and an opening clause in cad’s file', (t) => {
  if (!need(t)) return;
  const raw = readFileSync(join(CAD, 'shop_descriptions.yaml'), 'utf8');
  /* ⚠ FOLD THE SOURCE, don't fold the claim. cad writes `>` folded scalars, so
   * a sentence wraps mid-clause in the file and a literal substring search for
   * the clause fails on text that is perfectly correct — the first run of this
   * check failed on `hive_panels_4mm` for exactly that. Normalising the SOURCE
   * keeps the comparison verbatim (a contiguous run of the real words); it does
   * not relax what counts as a match. Read straight off the file rather than
   * through the generator's reader, so this is a second derivation chain. */
  const yaml = raw.replace(/\s+/g, ' ');
  for (const e of index.entries) {
    for (const d of e.describes ?? []) {
      assert.ok(
        raw.includes('\n  ' + d.part + ':'),
        `${e.path} carries a description for '${d.part}', which is not a key in ` +
          'shop_descriptions.yaml — this lane does not write these.',
      );
      /* The first clause has to appear in the source file. A join that mixed a
       * sentence onto the wrong part would still be "cad's text". */
      const head = d.text.split(/[.,;]/)[0].trim();
      assert.ok(head.length > 0 && yaml.includes(head), `${d.part}: text not found in the source file`);
    }
  }
});

test('an undescribed design carries no sentence at all', (t) => {
  if (!need(t)) return;
  const undescribed = index.entries.filter((e: any) => (e.describes ?? []).length === 0);
  assert.ok(undescribed.length > 0, 'no undescribed designs — this check would prove nothing');
  for (const e of undescribed) {
    assert.equal(e.describes?.length ?? 0, 0, `${e.path} invented a description`);
  }
  /* The generator must not have quietly stopped joining altogether. */
  assert.ok(index.described > 0, 'no card carries a description at all');
});

test('a file registered as several parts keeps EVERY sentence', (t) => {
  if (!need(t)) return;
  /* The defect this is here for: inverting the registry into Map<path, name>
   * keeps the last row and drops the rest, silently, because the card still
   * shows A description. Caught only by a count disagreeing. */
  const shown = index.entries.reduce((n: number, e: any) => n + (e.describes ?? []).length, 0);
  assert.equal(shown, index.descriptionsShown, 'index.descriptionsShown disagrees with the entries');
  const multi = index.entries.filter((e: any) => (e.partNames ?? []).length > 1);
  for (const e of multi) {
    const described = (e.partNames as string[]).filter((n) =>
      readFileSync(join(CAD, 'shop_descriptions.yaml'), 'utf8').includes(`\n  ${n}:`),
    );
    assert.equal(
      (e.describes ?? []).length,
      described.length,
      `${e.path} is ${e.partNames.length} registered parts and ${described.length} are described, ` +
        `but the card carries ${(e.describes ?? []).length}`,
    );
  }
});

test('every withheld design is absent, and its reason is dated and does not read as a withdrawal', (t) => {
  if (!need(t)) return;
  const listed = new Set(index.entries.map((e: any) => e.path));
  const withheld = new Set(index.withheld.map((w: any) => w.path));

  /* Named individually. A count would pass if one were swapped for another. */
  for (const p of [
    '2bee_entrance/2bee_entrance_center_closer_3d.scad',
    '2bee_entrance/2bee_entrance_center_divider_3d.scad',
    '2bee_entrance/2bee_entrance_half_scrubber_3d.scad',
    '2bee_entrance/2bee_entrance_vertical_divider_closed_3d.scad',
    /* ⚠ NOT in cad's list — it has no registered part name, so their population
     * cannot see it, and its TITLE is the one that states the cancelled setup. */
    '2bee_entrance/2bee_entrance_dual_queen_assembly.scad',
    /* ceo's 2026-09-05 ruling: an unregistered generation whose own tree does not
     * say whether it is live. A DIFFERENT reason from the five above, named here
     * individually so swapping one group for another cannot pass on a count. */
    '2bee_sensor_pod_v2/pod_v2_carrier.scad',
    '2bee_sensor_pod_v2/pod_v2_devboard.scad',
    '2bee_sensor_pod_v2/pod_v2_enclosure.scad',
  ]) {
    assert.ok(!listed.has(p), `${p} is LISTED — it publishes a cancelled configuration`);
    assert.ok(withheld.has(p), `${p} is absent from the catalogue but not RECORDED as withheld`);
  }

  /* Withholding must be visible, not silent: a design that vanishes without a
   * published reason is indistinguishable from one the reader could not open. */
  for (const w of index.withheld) {
    /* Each GROUP carries its own reason — the dual-queen five cite the founder's
     * 2026-08-10 cancellation, the v2 three cite ceo's 2026-09-05 ruling on an
     * ABSENT status. A single shared string would let one group's justification
     * silently cover another's, so what is asserted is the SHAPE every reason
     * must have: a dated ruling, and the words that stop a reader treating a
     * withholding as a retirement. */
    /* ⚠ TWO KINDS OF WITHHOLDING, and this asserted only one until 2026-09-06.
     * A RULING-based withholding (dual-queen, v2, a do-not-fab board) is somebody's
     * decision and must cite its date. A CONDITION-based one — a source file not
     * yet committed — is not a decision at all: it has no ruling to cite, reverses
     * itself on the next commit, and what it must instead say is how to clear it.
     * Demanding a date from both would have forced a fabricated one. */
    /* ⚠ THESE TWO ARE SHAPE TESTS, NOT TRUTH TESTS, and saying so is the point.
     * cad, 2026-09-06: *a declaration the gate only checks for the EXISTENCE of
     * is not a control; it is a spelling test.* A withhold reason citing
     * `2026-08-10` passes here whether or not a ruling was made that day, and a
     * fabricated date would pass identically. What this catches is the reason
     * that says NOTHING — the empty justification, the copied-from-another-group
     * string — which is the failure that actually occurred twice in this file.
     * Whether a cited ruling exists is not checkable from the artefact; it is
     * checkable by the lane that made it, and that is where it belongs. */
    if (/git does not track/.test(w.why)) {
      assert.match(w.why, /commit the file and it returns/i,
        `${w.path}: a condition-based withholding must say how it clears`);
    } else {
      assert.match(w.why, /20\d\d-\d\d-\d\d/, `${w.path} is withheld without citing a dated ruling`);
    }
    assert.match(w.why, /not a deletion/i, `${w.path}: the reason must say it is not a withdrawal`);
  }
  /* Both groups must actually be present: a rebuild that dropped one would still
   * satisfy every per-entry check above, because they only look at what is there. */
  /* ⚠ KEYED ON THE PATH, NOT THE PROSE. This matched the reason text until
   * 2026-09-05, when cad found v2's actual status and the reason was corrected
   * from "unregistered" to "superseded" — and the test went red for a reason
   * being made MORE accurate. A guard that pins wording punishes correcting it,
   * which is the opposite of what this file is for. The group is the set of
   * paths; the reason is what has to stay true about it. */
  assert.equal(index.withheld.filter((w: any) => w.path.startsWith('2bee_entrance/')).length, 5);
  assert.equal(index.withheld.filter((w: any) => w.path.startsWith('2bee_sensor_pod_v2/')).length, 3);
});

test('no card says dual queen', (t) => {
  if (!need(t)) return;
  for (const e of index.entries) {
    const text = [e.title, e.kind, ...(e.describes ?? []).map((d: any) => d.text)].join(' ');
    assert.doesNotMatch(text, /dual[- ]queen/i, `${e.path} names the cancelled configuration`);
  }
});

test('no design on a do-not-fab board is offered, and the count is on the withheld', (t) => {
  if (!need(t)) return;
  /* 🔴 ceo 2026-09-05, ruling EXTENDED: the marker has three readers —
   * gate_check.py stops checking, extract_pcb.py ignores it, and this catalogue
   * PUBLISHED it, which is the only one a stranger sees. A fix covering two of
   * them is not a fix. Withheld with the reason published, never deleted. */
  assert.ok(index.supersededBoardsSeen.length > 0,
    'no board carries _SUPERSEDED.md — an empty scan and a clean tree are the same number, so this is broken');
  assert.ok(index.withheldOnSupersededBoard > 0, 'none withheld on this ground — the check would prove nothing');

  const onBoard = index.withheld.filter((w: any) => w.why.includes('closure references'));
  assert.equal(onBoard.length, index.withheldOnSupersededBoard);
  const listed = new Set(index.entries.map((e: any) => e.path));
  for (const w of onBoard) {
    assert.ok(!listed.has(w.path), `${w.path} is both withheld and listed`);
    /* The marker's own words, not a paraphrase — pcb wrote them. */
    assert.match(w.why, /_SUPERSEDED\.md, which says: "/, `${w.path} does not quote the marker`);
    assert.match(w.why, /not a deletion/i, `${w.path}: must say it is not a withdrawal`);
  }
  /* Named: the design ceo traced the whole chain through. A count would pass if
   * it were swapped for another. */
  assert.ok(onBoard.some((w: any) => w.path.endsWith('sensor_pod_v1_enclosure_3d.scad')),
    'the v1 enclosure — the design ceo traced from the registry row to "Do not fab" — is not withheld');
  /* And no listed card may still carry the old annotation field. */
  for (const e of index.entries) {
    assert.equal((e as any).supersededBoards, undefined,
      `${e.path} still carries supersededBoards; a field that is always empty reads as "none are affected"`);
  }
});

test('every publish check publishes a witness, and the scan covers exactly the published lines', (t) => {
  if (!need(t)) return;
  /* 🔴 ceo + cad, 2026-09-06: "a check whose PASS state produces no artefact
   * cannot prove it ran." Three lanes hit this independently in one night —
   * an empty intersection writing no STL, an empty marker scan reading as a
   * clean tree, a silent rc=0 reading as a clean run. Refusing on failure is
   * not enough: empty PROHIBITED_CLAIMS, or delete the loop, and the build
   * passes byte-identically with nothing saying the check existed.
   *
   * ⚠ There is no ε here, and that is a property of these checks rather than an
   * omission: every one is discrete — a regex hit, a set membership, a count —
   * so there is no tolerance to state and no detection floor below which a
   * violation hides. cad's witness cube needs one because volume is floating
   * point; a matched line is matched. */
  assert.ok(index.claimCheck, 'the prohibited-claim check publishes no witness at all');
  assert.ok(index.claimCheck.patterns >= 4,
    `only ${index.claimCheck.patterns} claim pattern(s) — too few to be the real family`);
  /* 🔴 AN IDENTITY, NOT A THRESHOLD — and the threshold it replaced was blind.
   * This asserted `linesScanned > 10_000` against a real value near 68,000: a
   * number I typed, which a scan covering ONE FAMILY would have cleared. cad,
   * 2026-09-06, on their own asserted tolerance: *a tolerance nobody converted
   * back into a physical quantity is a blind spot sized by whoever typed it.*
   * `linesExpected` is counted from the bundles actually written to disk, a
   * different chain from the counter incremented during the scan, so equality
   * means every published line was scanned and nothing else was. */
  assert.equal(index.claimCheck.linesScanned, index.claimCheck.linesExpected,
    'the claim scan and the published bundles disagree — some published line was not scanned, or some scanned line was not published');
  assert.ok(index.claimCheck.linesExpected > 0, 'no published source lines at all');
  assert.equal(index.claimCheck.hits, 0, 'a prohibited claim reached the published index');

  assert.ok(index.aliasCheck.forbidden >= 5 && index.aliasCheck.accepted >= 3,
    'the alias list is too small to be legal canon');
  assert.equal(index.aliasCheck.hits, 0, 'a banned alias reached the published index');

  /* The band publishes what the run MEASURED, not only the constant a human
   * wrote — otherwise the artefact records the intent and not the outcome. */
  assert.ok(index.listedBand, 'the listed-count band publishes no witness');
  assert.equal(index.listedBand.measured, index.listed + index.withheldUntracked,
    'the band reports a measurement that disagrees with the population it banded');
  assert.ok(index.listedBand.measured >= index.listedBand.floor &&
            index.listedBand.measured <= index.listedBand.ceiling,
    `${index.listedBand.measured} is outside ${index.listedBand.floor}..${index.listedBand.ceiling} yet the build published`);
});

test('nothing withheld leaves a bundle or a thumbnail on disk', (t) => {
  if (!need(t)) return;
  /* 🔴 THE LEAK THIS EXISTS FOR, found 2026-09-06: the withholding decisions ran
   * AFTER the writes, so six withheld designs had their full source bundle and
   * rendered thumbnail served at guessable URLs while absent from the index.
   * ⇒ The listing was withheld and the artefact was published — the same shape
   * this lane found in cad's descriptions (*withholding the sentence did not
   * withhold the card*) committed one layer down by the person who found it.
   * A card missing from an index is not a design that was not published. */
  const ids = new Set(index.entries.map((e: any) => e.id));
  const dir = join(WEB, 'public', 'shop');
  for (const [sub, ext] of [['d', '.json'], ['t', '.png']] as const) {
    const here = join(dir, sub);
    if (!existsSync(here)) continue;
    const orphans = readdirSync(here)
      .filter((f) => f.endsWith(ext))
      .map((f) => f.slice(0, -ext.length))
      .filter((id) => !ids.has(id));
    assert.deepEqual(orphans, [],
      `${orphans.length} file(s) in public/shop/${sub}/ belong to no listed design — a withheld design still shipped its ${sub === 'd' ? 'source' : 'thumbnail'}`);
  }
  /* Not vacuous: there must BE withheld designs for this to have meant anything. */
  assert.ok(index.withheld.length > 0, 'nothing is withheld — this check would pass on any tree');
});
