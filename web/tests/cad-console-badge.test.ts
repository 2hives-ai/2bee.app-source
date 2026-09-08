// 2bee.cad — the number on the Console dock tab.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE CLOSES
// ═══════════════════════════════════════════════════════════════════════════
//
// Measured 2026-08-11 and recorded in `453786fe2e`, re-measured here by running
// it: `difference() { cube(10); circle(3); }` produced a dock-tab badge of `0`
// and one `REFUSED` row in the console pane. The badge totalled the PARSE
// diagnostics; the pane lists parse AND mesh. So with any other pane showing,
// a construct the operator wrote had contributed NOTHING to the model and the
// screen said so NOWHERE.
//
// 🔴 THAT IS NOT A COSMETIC MISCOUNT. A refusal means geometry that was written
// did not become geometry, and the viewport cannot show the difference: a tree
// missing a subtree still renders and still looks like a model. A refusal with
// no signal is indistinguishable from a clean parse — the same shape as the
// write-succeeded / read-cannot-see-it defects this lane filed three times the
// same day, running in the other direction.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE NUMBER PROMISES, AND WHAT IT REFUSES TO PROMISE
// ═══════════════════════════════════════════════════════════════════════════
//
// `consoleBadge(lines).count` = **every row the console holds** — errors,
// refusals and warnings, from the parser and from the mesher. It promises
// nothing about CLASS, because a single number cannot say which and this lane
// distinguishes the three deliberately (the editor gutter renders three
// differentiated marks for exactly this reason). The split lives in the pane's
// header row, in each row's channel word, and in `badge.label` for the tab's
// tooltip.
//
// The tests below are therefore all one property in different clothes: **the
// badge and the pane are the same list.** Not "the badge is right" — a number
// checked against a second hand-rolled sum is how this defect was born.
//
// ⚠ WHAT IS NOT PROVEN HERE.
//   · Nothing was seen on a screen. No browser. These render components to
//     static markup in node; whether a badge is legible, whether its tone reads
//     as a severity, and whether an operator notices it are visual facts and
//     none of them is claimed.
//   · ✅ THE TAB IS WIRED — since 2026-08-11, re-measured at the source
//     2026-08-12. This block said *"`CadTab.tsx` still renders
//     `result.errors.length + result.unsupported.length + result.warnings.length`
//     … THE RUNNING APP STILL HAS THE DEFECT"*, which stopped being true without
//     anything going red: `CadTab.tsx:const badge = useMemo(() =>
//     consoleBadge(jumpTargets), [jumpTargets])`, pinned by
//     `tests/cad-console.test.ts`'s two render-site assertions. **A stale 🔴 lies
//     exactly like a stale ✅** — and this one was worse than most, because it
//     told the next reader the app was broken in a way it was not, which is how a
//     finished fix gets done twice.
//   · 🔴 STILL TRUE, and it is the honest half of the paragraph above: nothing in
//     THIS file would have noticed either way. It exercises `consoleBadge()`; the
//     render site is another file's, and asserting it is `cad-console.test.ts`'s
//     job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
const { CadConsole, consoleLines, consoleBadge, consoleCounts, consoleSummary } = await import(
  '../src/cad/console.tsx'
);

const analyse = (src: string) => {
  const parse = parseScad(src);
  return { parse, mesh: meshScene(parse.scene) };
};

const render = (src: string) => {
  const { parse, mesh } = analyse(src);
  return renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }));
};

const rowsIn = (html: string) => html.split('data-testid="cad-console-row"').length - 1;

/** A source this subset genuinely warns about — measured, see the note below. */
const WARN_SRC = '$fn = 3;\n$fa = 0.001;\nsphere(5);\n';

/** Error + parser refusal + mesher refusal + warning, in one source. */
const ALL_THREE =
  '$fn = 3;\n$fa = 0.001;\nhulls() cube(5);\ndifference() { cube(10); circle(3); }\ncube(@@@);\n';

/**
 * 🔴 THE FIXTURE THAT MATTERS IS FIRST, and every other one is here so the
 * property is tested as a property rather than on the one case that produced
 * the bug report.
 */
const FIXTURES: { src: string; why: string }[] = [
  {
    src: 'difference() { cube(10); circle(3); }',
    why: 'THE MEASURED CASE — a 2D operand in a boolean: refused by the MESHER, invisible to a parse-only badge',
  },
  { src: 'cube(10);', why: 'clean — the badge must be silent, not merely small' },
  { src: 'hulls() cube(5);', why: 'refused by the PARSER — the case the old badge did see' },
  { src: WARN_SRC, why: 'a WARNING — produced, and rendered by nothing until the pane existed' },
  { src: 'cube(@@@);', why: 'a parse ERROR' },
  { src: ALL_THREE, why: 'all three classes and both producers at once' },
];

/**
 * ⚠ THE COMBINED FIXTURE IS NOT ASSUMED TO COMBINE ANYTHING. `sphere(r=5,d=12)`
 * reads like a warning and produces none in this subset — asked rather than
 * assumed, the same way `cad-console.test.ts` picks its warning source. If a
 * parser change makes any class stop appearing here, the rest of this file
 * quietly narrows to the classes that remain, so the composition is asserted.
 */
test('the combined fixture really does carry all three classes, from both producers', () => {
  const { parse, mesh } = analyse(ALL_THREE);
  const lines = consoleLines(parse, mesh);
  const badge = consoleBadge(lines);
  assert.ok(badge.counts.error > 0, 'no ERROR in the fixture that exists to have one');
  assert.ok(badge.counts.refused > 0, 'no REFUSAL in the fixture that exists to have one');
  assert.ok(badge.counts.warning > 0, 'no WARNING in the fixture that exists to have one');
  assert.ok(lines.some((l: { from: string }) => l.from === 'parse'), 'no parse row');
  assert.ok(lines.some((l: { from: string }) => l.from === 'mesh'), 'no mesh row');
});

/* ════════════════════════════════════════════════════════════════════════════
   1. The badge and the pane are the same list
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 PLANT: make `consoleBadge` total the parse diagnostics (the defect), or
 * drop the mesh loop from `consoleLines`, and the first fixture goes red.
 *
 * This is the assertion the old pin could not make. It compares the badge
 * against **the rows the pane actually rendered**, counted out of the markup —
 * not against a sum recomputed in the test, which is what made the previous pin
 * insensitive to the very fix it was written to catch.
 */
test('the badge equals the number of rows the pane renders — every fixture', () => {
  for (const { src, why } of FIXTURES) {
    const { parse, mesh } = analyse(src);
    const badge = consoleBadge(consoleLines(parse, mesh));
    assert.equal(badge.count, rowsIn(render(src)), `badge ≠ rendered rows for [${why}]: ${src}`);
  }
});

/**
 * The two directions of "a badge that shows a count while the pane shows
 * nothing", asserted separately because they are different failures: a number
 * over an empty pane is a lie, and an empty tab over a populated pane is the
 * defect being closed.
 */
test('a count means rows, and no count means the empty note — never the other way round', () => {
  for (const { src, why } of FIXTURES) {
    const { parse, mesh } = analyse(src);
    const badge = consoleBadge(consoleLines(parse, mesh));
    const html = render(src);
    const empty = html.includes('cad-console-empty');
    assert.equal(
      badge.count === 0,
      empty,
      `the badge says ${badge.count} and the pane ${empty ? 'renders its empty note' : 'renders rows'} — [${why}]`,
    );
  }
});

/**
 * ⚠ `count` is `lines.length`, NOT the sum of the three classes. The two must
 * agree today; the day a fourth `ConsoleSeverity` is added they will not, and
 * this red is the notice that `consoleCounts` and the pane's header need
 * widening — rather than a badge that quietly under-reports.
 */
test('the total and the split are counting the same rows', () => {
  for (const { src, why } of FIXTURES) {
    const { parse, mesh } = analyse(src);
    const lines = consoleLines(parse, mesh);
    const badge = consoleBadge(lines);
    const { error, refused, warning } = badge.counts;
    assert.equal(
      error + refused + warning,
      badge.count,
      `a row is in the pane and in no class — a fourth severity? [${why}]: ${src}`,
    );
    assert.deepEqual(badge.counts, consoleCounts(lines));
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The number does not say WHICH — so the pane must, verbatim
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE HALF A SINGLE NUMBER CANNOT CARRY. An error (not understood), a
 * refusal (understood, named, contributing nothing) and a warning are three
 * different facts. The badge flattens them on purpose; `label` is the tab's
 * unflattening, and it is the pane's own header sentence — the same characters
 * from the same producer, so the tooltip and the pane can never disagree.
 *
 * 🔴 PLANT: change either wording independently and this goes red.
 */
test('the badge label is the console header sentence, verbatim', () => {
  for (const { src, why } of FIXTURES) {
    const { parse, mesh } = analyse(src);
    const lines = consoleLines(parse, mesh);
    const badge = consoleBadge(lines);
    assert.equal(badge.label, consoleSummary(consoleCounts(lines)), why);
    const html = render(src);
    const shown = /data-testid="cad-console-summary"[^>]*>([^<]*)</.exec(html)?.[1];
    assert.ok(shown, `the console header summary did not render for [${why}]: ${src}`);
    assert.equal(
      shown.replace(/&#x27;|&quot;/g, ''),
      badge.label,
      `the tab's tooltip and the pane's header say different things about the same source [${why}]`,
    );
  }
});

/** A refusal is named as a refusal in the split, whichever producer refused it. */
test('a mesh refusal and a parse refusal land in the same class', () => {
  const byMesher = analyse('difference() { cube(10); circle(3); }');
  const byParser = analyse('hulls() cube(5);');
  const mesher = consoleBadge(consoleLines(byMesher.parse, byMesher.mesh));
  const parser = consoleBadge(consoleLines(byParser.parse, byParser.mesh));
  assert.equal(mesher.counts.refused, 1, 'the mesher refused and the split did not say so');
  assert.equal(parser.counts.refused, 1, 'the parser refused and the split did not say so');
  assert.equal(mesher.count, 1);
  assert.equal(parser.count, 1);
});

/**
 * `worst` exists so the tab can be TONED without claiming the number is a
 * class. Ordered by what discarded the most: an error threw away a span of
 * source, a refusal threw away one construct, a warning threw away nothing.
 */
test('worst names the most serious class present, and null when there is none', () => {
  const cases: [string, string | null][] = [
    ['cube(10);', null],
    [WARN_SRC, 'warning'],
    ['difference() { cube(10); circle(3); }', 'refused'],
    ['hulls() cube(5);', 'refused'],
    [ALL_THREE, 'error'],
  ];
  for (const [src, expected] of cases) {
    const { parse, mesh } = analyse(src);
    assert.equal(consoleBadge(consoleLines(parse, mesh)).worst, expected, src);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   3. The negative control — the expression that must not come back
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE OLD BADGE, RUN SIDE BY SIDE WITH THE NEW ONE. Without this, every
 * assertion above would also pass against the defect on five of the six
 * fixtures — the two agree everywhere except where it matters, which is exactly
 * why the miscount survived until somebody typed a 2D operand into a
 * `difference()`.
 *
 * ⚠ It asserts a DISAGREEMENT exists. If a future parser change makes this
 * source produce a parse diagnostic too, the fixture stops separating the two
 * definitions and this test says so rather than passing vacuously.
 */
test('the parse-only sum disagrees with the badge on the measured case, and that gap is the defect', () => {
  const { parse, mesh } = analyse('difference() { cube(10); circle(3); }');
  const parseOnly = parse.errors.length + parse.unsupported.length + parse.warnings.length;
  const badge = consoleBadge(consoleLines(parse, mesh));

  assert.equal(parseOnly, 0, 'the fixture now produces a PARSE diagnostic, so it no longer separates the two');
  assert.equal(badge.count, 1, 'the mesh refusal is not reaching the badge');
  assert.notEqual(
    parseOnly,
    badge.count,
    'the two definitions agree here — this fixture can no longer prove the old expression is wrong',
  );
});

/**
 * And the reason the disagreement is *rare*: on a source with no mesh
 * diagnostics the two are identical. Stated so that nobody reads the test above
 * as "the old expression was always wrong" and goes looking for a bigger bug
 * than the one that is there.
 */
test('on a parse-only source the old and new numbers coincide — the gap is mesh diagnostics alone', () => {
  for (const src of ['cube(10);', 'hulls() cube(5);', WARN_SRC]) {
    const { parse, mesh } = analyse(src);
    const parseOnly = parse.errors.length + parse.unsupported.length + parse.warnings.length;
    const lines = consoleLines(parse, mesh);
    assert.equal(lines.filter((l: { from: string }) => l.from === 'mesh').length, 0, src);
    assert.equal(consoleBadge(lines).count, parseOnly, src);
  }
});
