// The 2bee.cad console pane.
//
// WHAT THIS FILE EXERCISES
//   · that `parse.warnings` REACHES the pane. That channel was produced,
//     counted into `GroupNode.diagnostics` and asserted by
//     `scad-openscad-divergence.test.ts` while being rendered by NOTHING —
//     nine OpenSCAD `WARNING:` classes invisible in the tab. This is the test
//     that would go red if the pane stopped consuming it again.
//   · that parse rows and mesh rows are distinguishable, because the mesh lags
//     the editor by up to 250 ms and its line numbers can be numbers in a text
//     the user is no longer looking at.
//   · that a diagnostic naming a line renders a control that can go to it.
//
// 🔴 NOT EXERCISED: nothing here clicks. `onGoToLine` is asserted to be WIRED
// to a button carrying the right line; that the caret actually moves is a
// browser fact and is not claimed here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
const { CadConsole, consoleBadge, consoleLines } = await import('../src/cad/console.tsx');
/* The tab strip lives in `CadTab.tsx`, which cannot be imported here (its sample
 * asset imports stop the loader), so the wiring assertions below read it. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

const analyse = (src: string) => {
  const parse = parseScad(src);
  return { parse, mesh: meshScene(parse.scene) };
};

/**
 * A source that makes the parser emit a real `ScadWarning`. Found by asking the
 * parser rather than by writing one into a fixture — if no source in this
 * subset warns, the test says so instead of passing vacuously.
 */
const WARNING_SOURCES = [
  'sphere(r = 5, d = 12);',
  'cylinder(h = 10, r = 3, d = 8);',
  'cube([1,2,3], center = 1);',
  '$fn = 3; $fa = 0.001; sphere(5);',
  'x = 1; x = 2; cube(x);',
];

test('at least one source in this subset produces a parser WARNING — the channel is live', () => {
  const hits = WARNING_SOURCES.map((s) => ({ s, n: parseScad(s).warnings.length })).filter((r) => r.n > 0);
  assert.ok(
    hits.length > 0,
    'no source warned, so every warning assertion below would be vacuous: ' +
      JSON.stringify(WARNING_SOURCES.map((s) => ({ s, n: parseScad(s).warnings.length }))),
  );
});

const warnSrc = WARNING_SOURCES.find((s) => parseScad(s).warnings.length > 0)!;

/**
 * 🔴 THE ONE THAT MATTERS. Before this pane, this list went nowhere.
 */
test('a parser warning reaches the console lines', () => {
  const { parse, mesh } = analyse(warnSrc);
  assert.ok(parse.warnings.length > 0);
  const lines = consoleLines(parse, mesh);
  const warned = lines.filter((l) => l.channel === 'WARNING' && l.from === 'parse');
  assert.equal(warned.length, parse.warnings.length);
  assert.equal(warned[0].text, parse.warnings[0].message);
  assert.equal(warned[0].line, parse.warnings[0].line);
});

test('a parser warning reaches the rendered pane, with its line', () => {
  const { parse, mesh } = analyse(warnSrc);
  const html = renderToStaticMarkup(
    h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }),
  );
  assert.match(html, /WARNING/);
  assert.match(html, new RegExp(`data-line="${parse.warnings[0].line}"`));
  assert.match(html, /data-warnings="[1-9]/);
});

test('refusals arrive by name and by line', () => {
  const { parse, mesh } = analyse('cube(1);\nhulls() cube(5);\n');
  const lines = consoleLines(parse, mesh);
  const refused = lines.find((l) => l.channel === 'REFUSED');
  assert.ok(refused, 'hulls() should be refused');
  assert.equal(refused.line, 2);
  assert.match(refused.name ?? '', /hulls/);
});

test('errors sort above refusals and warnings, whatever their line number', () => {
  const src = 'hulls() cube(5);\nsphere(r=1, d=2);\ncube(@@@);\n';
  const { parse, mesh } = analyse(src);
  const lines = consoleLines(parse, mesh);
  assert.ok(lines.length >= 2);
  assert.equal(lines[0].severity, 'error', 'an error discarded a span — it is not a footnote');
  // and it is genuinely later in the file than the refusal it outranks
  const refused = lines.find((l) => l.severity === 'refused');
  assert.ok(refused && lines[0].line > refused.line);
});

test('mesh rows are marked as mesh rows, so a stale one can be labelled', () => {
  const { parse, mesh } = analyse('difference() { cube(10); square(4); }\n');
  const lines = consoleLines(parse, mesh);
  const fromMesh = lines.filter((l) => l.from === 'mesh');
  assert.ok(fromMesh.length > 0, 'a 2D operand in a boolean should be refused by the mesher');
  const html = renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: true, onGoToLine: () => {} }));
  assert.match(html, /from the PREVIOUS source/);
});

test('the same pane says nothing about a previous source when there is not one', () => {
  const { parse, mesh } = analyse('difference() { cube(10); square(4); }\n');
  const html = renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }));
  assert.ok(!html.includes('from the PREVIOUS source'));
});

test('a clean source says what its silence means, rather than being blank', () => {
  const { parse, mesh } = analyse('cube([10,10,10]);\n');
  assert.deepEqual(consoleLines(parse, mesh), []);
  const html = renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }));
  assert.match(html, /cad-console-empty/);
  assert.match(html, /statement about the LANGUAGE/);
});

/**
 * A row that cannot be reached by keyboard is a row a keyboard user cannot act
 * on, and the whole point of the pane is acting on it.
 */
test('every diagnostic row is a button when a jump target is supplied', () => {
  const { parse, mesh } = analyse('hulls() cube(5);\n');
  const html = renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: false, onGoToLine: () => {} }));
  assert.match(html, /<button[^>]*data-testid="cad-console-row"/);
});

/** And with no target, no button — rather than a control that does nothing. */
test('with no jump target the rows are not offered as buttons', () => {
  const { parse, mesh } = analyse('hulls() cube(5);\n');
  const html = renderToStaticMarkup(h(CadConsole, { parse, mesh, meshStale: false }));
  assert.match(html, /data-testid="cad-console-row"/);
  assert.ok(!/<button[^>]*data-testid="cad-console-row"/.test(html));
});

/* ════════════════════════════════════════════════════════════════════════════
   🔴 THE TAB BADGE — the last hop, wired 2026-08-11
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE DEFECT, REPRODUCED RATHER THAN DESCRIBED. `112d2e34b9` landed
 * `consoleBadge()` exported and tested, and the tab strip in `CadTab.tsx` went
 * on rendering a SECOND SUM over the PARSE result only:
 *
 *     result.errors.length + result.unsupported.length + result.warnings.length
 *
 * The mesher refuses things the parser accepts, so that sum could be zero while
 * the pane held a refusal — and with any other pane showing there was then NO
 * SIGNAL AT ALL that something had been refused.
 *
 * Measured here, not asserted from memory: for the source below the parse-only
 * sum is **0** and the console holds **1 refused** row.
 */
test('the parse-only sum the tab used to show is BLIND to a mesh refusal', () => {
  const { parse, mesh } = analyse('difference() { cube(10); circle(3); }');
  const parseOnly = parse.errors.length + parse.unsupported.length + parse.warnings.length;
  const lines = consoleLines(parse, mesh);

  assert.equal(parseOnly, 0, 'this source no longer demonstrates the defect — the test has gone blind');
  assert.ok(lines.length > 0, 'the console holds nothing, so there is no divergence left to guard');
  assert.ok(
    lines.some((l) => l.severity === 'refused'),
    'the mesher no longer refuses this, so this fixture proves nothing',
  );
  // The badge the tab now renders sees it.
  assert.equal(consoleBadge(lines).count, lines.length);
  assert.notEqual(consoleBadge(lines).count, parseOnly, 'the two sums agree, so the fixture is not the defect');
});

/**
 * 🔴 AND THE TAB RENDERS THE BADGE, FROM THE PANE'S OWN LIST. Source-text — the
 * two things that would actually go wrong are both visible in the text: the
 * parse-only sum coming back, and the badge being computed from anything other
 * than `jumpTargets`.
 *
 * ⚠ THE REASON GIVEN HERE WAS WRONG AND IS CORRECTED (2026-08-12). It said
 * *"because `CadTab.tsx` cannot be imported here"*. It imports and renders fine
 * under `renderToStaticMarkup` in this suite — `tests/cad-dock-tabs.test.ts` does
 * exactly that and asserts the emitted attributes. So a source regex is a CHOICE
 * here (it is what reads a `useMemo` dependency list), not a limit; the two
 * assertions below are unchanged and still right. **A false limit in a test
 * header is the kind of thing that stops the next person reaching for the
 * stronger check.**
 */
test('the tab badge is computed from the list the pane is given, not from a second sum', () => {
  const tab = readFileSync(join(HERE, '..', 'src', 'cad', 'CadTab.tsx'), 'utf8');
  const body = tab.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/[^\n]*$/gm, ' ');

  assert.match(
    body,
    /const badge = useMemo\(\(\) => consoleBadge\(jumpTargets\), \[jumpTargets\]\);/,
    'the badge is not derived from jumpTargets, so it can disagree with the pane again',
  );
  assert.match(body, /\{t\.id === 'console' && badge\.count > 0 \? ` \(\$\{badge\.count\}\)` : ''\}/);
  assert.doesNotMatch(
    body,
    /result\.errors\.length \+ result\.unsupported\.length \+ result\.warnings\.length/,
    'the parse-only sum is back on the tab, and a mesh refusal is invisible behind another pane again',
  );
  /* The SAME list reaches the pane — one producer is the whole property. */
  assert.match(body, /onGoToLine|CadConsole/, 'the console pane is no longer rendered here — blind, not green');
});

/**
 * 🔴 THE BADGE IS NOT SUPPRESSED BY WHICH PANE IS SHOWING, AND THAT IS A RULING
 * RATHER THAN AN OVERSIGHT. `453786fe2e` suppressed a *different* badge while its
 * pane was open and copying that here is the obvious move.
 *
 * It is wrong here because `layout.dock` is clamped to zero in two places and is
 * PERSISTED, so `{ tab: 'console', dock: 0 }` is reachable in one drag. A guard
 * keyed on the tab alone gives that state no pane AND no badge — reinstating the
 * exact no-signal condition this wiring exists to end, through a different door.
 */
test('the badge does not depend on which pane is showing', () => {
  const tab = readFileSync(join(HERE, '..', 'src', 'cad', 'CadTab.tsx'), 'utf8');
  /* 🔴 THE STRIPPER MUST NOT JOIN LINES, AND THE FIRST CUT OF THIS TEST DID.
   * Replacing a multi-line block comment with a single space MERGES the line
   * above it into the line below, so a per-line scan then reads a line that
   * never existed. Measured: with the suppression planted, `.find()` returned
   * the `title=` line — which legitimately has no `layout.tab` — and this
   * assertion stayed GREEN over the defect it exists to catch. Only the negative
   * control said so.
   *
   * A block comment is now replaced by its own newlines, so line numbers and
   * line boundaries survive, and EVERY line carrying the badge is checked rather
   * than the first one found. */
  const body = tab
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  const lines = body.split('\n').filter((l) => l.includes('badge.count'));
  assert.ok(lines.length > 0, 'the badge expression moved — blind, not green');
  for (const line of lines) {
    assert.doesNotMatch(
      line,
      /layout\.tab|aria-selected/,
      'the badge is now suppressed while its pane is showing — with dock: 0 persisted and reachable ' +
        'in one drag, that state is no pane AND no badge, which is the no-signal condition this wiring ' +
        `exists to end. Offending line: ${line.trim()}`,
    );
  }
});
