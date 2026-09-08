// `panel-spoilboard`'s header badge — the count that pays for the sticky collapse.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE HOLE THIS CLOSES
// ═══════════════════════════════════════════════════════════════════════════
//
// `Section` collapse is STICKY and a shut section renders NOTHING. `panel-notes`
// and `panel-sim` each state a count in their header while shut; until
// 2026-08-12 `panel-spoilboard` did not, so an operator who collapsed it once
// could carry `SPOILBOARD POSITION NOT CHECKED` — or `THIS BOARD CANNOT COVER
// THE REACH` — across every later job on a screen indistinguishable from one
// with a measured board under it.
//
// `tests/ui-text-sweep.test.ts` §3.1–3.3 names that hole as the reason
// `Notes and warnings` must keep rendering the COMPLETE, unfiltered array. This
// file builds the badge; it does NOT filter anything, and that test is still
// green — deliberately. The filter is a separate, founder-owned decision.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS ASSERTED HERE, AND WHAT ONLY A BROWSER CAN SAY
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 NOTHING HERE HAS SEEN A BADGE. `App.tsx` does not import in node (three.js,
// wasm, `localStorage`), so every assertion below is over its SOURCE TEXT —
// `tests/saved-selection.test.ts` and `tests/cad-console.test.ts` do the same,
// for the same reason, and say so. `renderToStaticMarkup` would not help either:
// it runs no effects, and this lane has had 1096 green node tests over a blank
// app. **That the badge appears, reads as a severity, and carries the right
// number is a browser fact and is verified in a browser, not here.**
//
// What source text CAN carry is the two properties that would actually go
// wrong, both of which are structural:
//
//   1. **ONE PRODUCER.** The badge is a prop on `<Section>` and the sentences are
//      rendered inside its children, so the arithmetic cannot live where the
//      sentences do. `112d2e34b9` traced exactly this shape on the CAD console
//      badge: a second sum, blind to a class the pane listed. So the body must
//      DESTRUCTURE from `spoilboardFindings` and must not re-ask any of it.
//   2. **THE LIST AND THE PANEL ARE THE SAME SET.** Every alarming paragraph the
//      panel can render is either counted or excluded WITH A REASON, and every
//      counted item names an element the panel actually renders. A list is
//      otherwise blind to whatever is added next — the failure mode that made
//      this badge necessary in the first place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = readFileSync(join(HERE, '..', 'src', 'App.tsx'), 'utf8');

/** The `<Section testid="panel-spoilboard">` body, exactly as `ui-text-sweep` slices `panel-notes`. */
function panelBody(source: string): string {
  const i = source.indexOf('testid="panel-spoilboard"');
  assert.notEqual(i, -1, '`panel-spoilboard` is gone');
  return source.slice(i, source.indexOf('</Section>', i));
}

/** The `items` array inside `spoilboardFindings`, as `{tone, testid}` pairs. */
function items(source: string): { tone: string; testid: string }[] {
  const i = source.indexOf("const items: { tone: 'warn' | 'pending'; testid: string }[] = [");
  assert.notEqual(i, -1, '`spoilboardFindings.items` is gone — the badge has no list to be the length of');
  const block = source.slice(i, source.indexOf('\n    ];', i));
  return [...block.matchAll(/tone: '(warn|pending)' as const, testid: '([^']+)'/g)].map((m) => ({
    tone: m[1],
    testid: m[2],
  }));
}

/**
 * Every `<p>` the panel renders, with the `className` expression it carries.
 *
 * ⚠ A DYNAMIC `className` COUNTS AS ALARMING. `spoilboard-machine-note` renders
 * `className={spoilboardMachineNote.tone}` — the word `warn` does not appear in
 * the markup at all — so a test keyed on the literal would wave through exactly
 * the elements whose severity it cannot read. Unknown is treated as alarming and
 * has to be adjudicated, which is the direction that fails safe.
 */
function paragraphs(body: string): { testid: string; cls: string; alarming: boolean }[] {
  return [...body.matchAll(/<p\b[^>]*?>/gs)].map((m) => {
    const tag = m[0].replace(/\s+/g, ' ');
    const cls = /className=(\{[^}]*\}|"[^"]*")/s.exec(tag)?.[1] ?? '';
    const testid = /data-testid="([^"]+)"/.exec(tag)?.[1] ?? '(no testid)';
    const literal = /^"([^"]*)"$/.exec(cls)?.[1];
    const alarming =
      literal === undefined ? cls !== '' : ['warn', 'bad', 'pending'].includes(literal.trim());
    return { testid, cls, alarming };
  });
}

/**
 * Alarming paragraphs the badge deliberately does NOT count. Every entry carries
 * the reason, here rather than in a commit message nobody will find — an
 * exclusion with no reason is how a list quietly stops being complete.
 */
const EXCLUDED: Record<string, string> = {
  'spoilboard-save-refused':
    'the answer to a button the operator has just pressed — which cannot be pressed with the ' +
    'panel shut — and the next action clears it. It says nothing about the board under the cutter.',
};

test('every alarming sentence in the panel is either counted by the badge or excluded with a reason', () => {
  const body = panelBody(APP);
  const counted = new Set(items(APP).map((i) => i.testid));
  const missed = paragraphs(body)
    .filter((p) => p.alarming && !counted.has(p.testid) && !(p.testid in EXCLUDED))
    .map((p) => `${p.testid} (className=${p.cls})`);
  assert.deepEqual(
    missed,
    [],
    'these sentences can be on screen while the badge says nothing — count them in ' +
      '`spoilboardFindings.items`, or add them to EXCLUDED with the reason'
  );
});

test('and nothing is counted that the panel does not render', () => {
  const body = panelBody(APP);
  const unrendered = [...new Set(items(APP).map((i) => i.testid))].filter(
    (t) => !body.includes(`data-testid="${t}"`)
  );
  assert.deepEqual(
    unrendered,
    [],
    'the badge counts an element this panel does not render — a number promising a sentence ' +
      'that is not behind the header'
  );
});

test('the badge is wired to the header, and to the ONE list', () => {
  assert.match(
    APP,
    /badge=\{spoilboardFindings\.badge\}/,
    '`panel-spoilboard` has no badge again — a collapsed panel can hide a spoilboard PENDING'
  );
  /* The counts come off `items`, not off a re-derivation. `w` is the warn half
   * and `p` is everything else, so no item can fall out of both. */
  assert.match(APP, /const w = items\.filter\(\(i\) => i\.tone === 'warn'\)\.length;/);
  assert.match(APP, /const p = items\.length - w;/);
});

test('the body renders FROM the same list — it does not re-ask any of it', () => {
  const body = panelBody(APP);
  assert.match(body, /\}\s*=\s*spoilboardFindings;/, 'the panel no longer reads the shared list');
  /* The four re-derivations that were in this body until 2026-08-12, and the two
   * conditions that joined them. Each one back here is a second producer, and a
   * second producer is what put a `0` on the CAD console tab beside a REFUSED
   * row. */
  for (const [needle, what] of [
    ["startsWith('SPOILBOARD POSITION NOT CHECKED')", 'the PENDING filter'],
    ["includes('PAST THE EDGE OF THE SPOILBOARD')", 'the strike filter'],
    ["startsWith('SPOILBOARD NOT INSTALLED')", 'the refusal filter'],
    ["inventoryRefusal('spoilboard'", 'the inventory refusal'],
    /* ⚠ NARROWED TO THE DECLARED BOARD, and the first draft of this needle was
     * `spoilboardReachVerdict(` — which went red on two innocent calls that grade
     * CATALOGUE ROWS and SAVED ROWS in the picker. Those answer "would this board
     * cover the reach if you chose it", which is a different question from "does
     * the board on the machine cover it" and has its own verdict per row. Only
     * the second one is what the badge counts, and only its argument list names
     * the declared size. Left recorded because a needle that fires on a
     * neighbouring correct call is one somebody deletes rather than narrows. */
    ['spoilboardReachVerdict(sizeX, sizeY,', 'the reach verdict for the DECLARED board'],
    ['spoilboardTravels[0] !== travelX', 'the travel-drift comparison'],
  ] as const) {
    assert.ok(
      !body.includes(needle),
      `${what} is computed inside the panel again — the header now totals one set of sentences and the body prints another`
    );
  }
});

/**
 * 🔴 THE SHUT-ONLY RULE, which is `453786fe2e`'s and is deliberately NOT the
 * always-visible rule `112d2e34b9` chose for the CAD dock. That one applied
 * because the dock's height is clamped to zero AND persisted, so a tab-keyed
 * guard gave that state no pane and no badge. `Section` has no height, no clamp
 * and nothing persisted but the open boolean, and its body is `{open && …}` — so
 * `open` IS "the sentences are in the DOM", and a count printed an inch above the
 * sentences it counts is the duplicate `453786fe2e` removed.
 */
test('`Section` still shows a badge only while it is shut', () => {
  /* `Section` was extracted to `panels/SectionPanel.tsx` by `e076313391`; the
   * rule moved with the component, so the needle reads it there. */
  const SECTION = readFileSync(join(HERE, '..', 'src', 'panels', 'SectionPanel.tsx'), 'utf8');
  assert.match(SECTION, /\{!open && badge \? \(/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   PLANTS — each one is a way this badge goes quiet, applied to a STRING
   ═══════════════════════════════════════════════════════════════════════════ */

test('🔴 PLANT — a new alarming sentence in the panel that nobody counted goes RED', () => {
  const body = panelBody(APP);
  const counted = new Set(items(APP).map((i) => i.testid));
  const planted = body.replace(
    '<p className="warn" data-testid="spoilboard-travel-drift">',
    '<p className="warn" data-testid="spoilboard-travel-drift"></p><p className="bad" data-testid="spoilboard-brand-new-alarm">'
  );
  assert.notEqual(planted, body, 'the plant did not apply');
  const missed = paragraphs(planted)
    .filter((p) => p.alarming && !counted.has(p.testid) && !(p.testid in EXCLUDED))
    .map((p) => p.testid);
  assert.deepEqual(missed, ['spoilboard-brand-new-alarm']);
});

test('🔴 PLANT — a sentence whose severity is dynamic is NOT waved through', () => {
  const one = paragraphs('<p className={someTone} data-testid="x">hi</p>');
  assert.equal(one[0].alarming, true, 'an unreadable severity was treated as harmless');
  const note = paragraphs('<p className="note" data-testid="y">hi</p>');
  assert.equal(note[0].alarming, false, 'every plain note now demands adjudication — the guard will be turned off');
});

test('🔴 PLANT — the badge counting something the panel does not show goes RED', () => {
  const body = panelBody(APP);
  const counted = ['spoilboard-pending', 'spoilboard-a-sentence-that-does-not-exist'];
  const unrendered = counted.filter((t) => !body.includes(`data-testid="${t}"`));
  assert.deepEqual(unrendered, ['spoilboard-a-sentence-that-does-not-exist']);
});
