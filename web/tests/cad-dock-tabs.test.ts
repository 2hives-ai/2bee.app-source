// 2bee.cad — the bottom dock's tab widget, and the contract its roles announce.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE CLOSES
// ═══════════════════════════════════════════════════════════════════════════
//
// The dock strip declared `role="tablist"` over `role="tab"` buttons and did
// none of the rest: no `role="tabpanel"` on the pane, no `aria-controls`, no
// roving tabindex — every dock tab sat in the page tab order — and no arrow-key
// handling at all. `Tabs.tsx` implements the whole WAI-ARIA pattern and gives
// the shop-floor reason for it: *"a shop is a place where somebody's other hand
// is on the machine, and a control that can only be reached with a mouse is a
// control that is not there for everyone."*
//
// 🔴 HALF A WIDGET IS WORSE THAN PLAIN BUTTONS. `role="tab"` is a PROMISE about
// the keyboard: a screen reader announces "tab, 1 of 3" and tells the operator
// to use the arrow keys. The arrow keys did nothing. An announced contract that
// is not honoured sends someone looking for a control that is not there, which
// is a worse position than a row of ordinary buttons they would simply Tab
// through. The fork was *complete the pattern or drop the roles*; the pattern
// was completed, because this IS a tab widget — one region, several panes, one
// showing — and dropping the roles would drop the `aria-selected` that says
// which pane is up.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT RUNS HERE
// ═══════════════════════════════════════════════════════════════════════════
//
// ✅ THE REAL MARKUP. `CadTab` renders under `renderToStaticMarkup` in node, so
//    every assertion below reads the ATTRIBUTES THE COMPONENT EMITS rather than
//    its source text. (`tests/cad-console.test.ts` says `CadTab.tsx` "cannot be
//    imported here" and falls back to a source regex — measured 2026-08-12, it
//    imports and renders fine. That comment is stale; the test it guards is not
//    wrong, only weaker than it needed to be.)
// ✅ The key arithmetic, as the exported pure function the handler calls.
//
// 🔴 NOT PROVEN HERE, and it is the half that matters to a person:
//   · **No key was ever pressed.** `renderToStaticMarkup` runs no effects and
//     dispatches no events, so *"ArrowRight moves focus"* is a claim about a
//     function, not about a browser. Focus movement, and the fact that `Enter`
//     is what switches the pane, were driven in a real browser instead — see
//     the change's report.
//   · Nothing here says the strip is legible, or that a screen reader reads it
//     the way the roles intend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { CadTab, DOCK_PANEL_ID, dockTabDomId, nextDockTabIndex } = await import(
  '../src/cad/CadTab.tsx'
);

const html = renderToStaticMarkup(h(CadTab));

/** Every `<button role="tab">` in the rendered dock, as its raw open tag. */
function tabTags(source: string): string[] {
  return [...source.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
}

test('the strip renders a tablist whose tabs each point at the pane', () => {
  const tabs = tabTags(html);
  assert.ok(tabs.length >= 2, `expected a strip, got ${tabs.length} tabs`);
  for (const t of tabs) {
    assert.match(t, /aria-selected="(true|false)"/, `no aria-selected: ${t}`);
    assert.match(
      t,
      new RegExp(`aria-controls="${DOCK_PANEL_ID}"`),
      `a tab controls nothing — the role promises a pane and names none: ${t}`
    );
    assert.match(t, /\bid="cad-dock-tab-/, `a tab has no id, so no pane can be labelled by it: ${t}`);
  }
});

test('the pane is a tabpanel, labelled by the tab that is selected', () => {
  assert.match(
    html,
    new RegExp(`<div role="tabpanel" id="${DOCK_PANEL_ID}" aria-labelledby="${dockTabDomId('console')}"`),
    'the dock pane is still a bare div — the tabs announce a panel that does not exist'
  );
  /* No dangling IDREF: the label target is an element that is actually here.
   * Console is the default pane, and an unpinned tab that is not showing has no
   * button — which is exactly the case that would leave a label pointing at
   * nothing if the panel were ever labelled by anything but the SELECTED tab. */
  assert.ok(html.includes(`id="${dockTabDomId('console')}"`));
});

test('ROVING TABINDEX — exactly one dock tab is in the page tab order', () => {
  const tabs = tabTags(html);
  const zero = tabs.filter((t) => /tabindex="0"/.test(t));
  const minus = tabs.filter((t) => /tabindex="-1"/.test(t));
  assert.equal(
    zero.length,
    1,
    'more than one dock tab is tabbable — a keyboard user walks the whole strip, ' +
      'which is the thing the arrow keys exist to replace'
  );
  assert.equal(zero.length + minus.length, tabs.length, 'a tab carries no tabindex at all');
  /* And it is the SELECTED one, so `Tab` lands on what is showing. */
  assert.match(zero[0], /aria-selected="true"/);
});

test('the selected tab is the one whose pane is rendered', () => {
  const tabs = tabTags(html);
  const selected = tabs.filter((t) => /aria-selected="true"/.test(t));
  assert.equal(selected.length, 1, 'the strip claims two selected tabs, or none');
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE KEY ARITHMETIC — pure, so the off-by-one can be watched failing
   ═══════════════════════════════════════════════════════════════════════════ */

test('arrows wrap in both directions, Home/End go to the ends', () => {
  assert.equal(nextDockTabIndex('ArrowRight', 0, 3), 1);
  assert.equal(nextDockTabIndex('ArrowRight', 2, 3), 0, 'right does not wrap');
  assert.equal(nextDockTabIndex('ArrowLeft', 0, 3), 2, 'left does not wrap');
  assert.equal(nextDockTabIndex('ArrowLeft', 2, 3), 1);
  assert.equal(nextDockTabIndex('Home', 2, 3), 0);
  assert.equal(nextDockTabIndex('End', 0, 3), 2);
  // The strip is two wide whenever the unpinned tree tab is not showing.
  assert.equal(nextDockTabIndex('ArrowRight', 1, 2), 0);
  assert.equal(nextDockTabIndex('End', 0, 1), 0);
});

test('🔴 and it claims NOTHING else — Tab and Enter must reach the page', () => {
  for (const key of ['Tab', 'Enter', ' ', 'Escape', 'ArrowDown', 'a']) {
    assert.equal(
      nextDockTabIndex(key, 0, 3),
      null,
      `\`${key}\` is intercepted by the strip. Swallowing Tab traps a keyboard user inside ` +
        'the dock; swallowing Enter breaks the manual activation this widget is built on'
    );
  }
  assert.equal(nextDockTabIndex('ArrowRight', 0, 0), null, 'an empty strip still moves focus somewhere');
});

/**
 * 🔴 ACTIVATION IS MANUAL, AND THAT IS A DEPARTURE FROM `Tabs.tsx` WITH A REASON.
 *
 * That file activates on the arrow key itself and says why: *"every panel is
 * already mounted, so selecting one costs a `display` change and nothing else."*
 * The dock is the opposite — its panes are conditionally rendered, so a tab
 * change UNMOUNTS one, and `AskPanel` holds its conversation, its in-flight
 * request and its proposal in its own `useState`. Automatic activation would let
 * an operator arrowing along the strip discard a model reply they were reading.
 *
 * The mechanism is that the handler moves FOCUS ONLY: selection stays with the
 * button's own click/Enter/Space. This test pins the two halves that make that
 * true — the key list above claims no activation key, and the handler is wired to
 * the function above rather than to `patch`.
 */
test('the arrow handler moves focus and does not select', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/cad/CadTab.tsx', import.meta.url)), 'utf8');
  const i = src.indexOf('const onDockKeyDown');
  assert.notEqual(i, -1, 'the dock has no key handler — the roles are announcing keys again');
  const body = src.slice(i, src.indexOf('\n  );', i));
  assert.match(body, /nextDockTabIndex\(e\.key, i, dockTabs\.length\)/);
  assert.match(body, /\.focus\(\)/, 'the handler computes an index and moves nothing');
  assert.doesNotMatch(
    body,
    /patch\(/,
    'the arrow keys now SELECT — an operator arrowing past the Ask pane unmounts it and ' +
      'loses the reply they were reading'
  );
});
