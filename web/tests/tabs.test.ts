// The tab bar: its ARIA wiring, its mounting rule, and where the choice is kept.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS SUITE CANNOT DO, SAID FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// **There is no browser and no WebGL on this box, so nobody has LOOKED at any of
// this.** No screenshot was taken, no tab was clicked, and the two 3D canvases
// behind these panels have never been seen to start or stop. Everything below is
// a STRUCTURAL assertion on server-rendered markup:
//
//   ✅ that the tablist/tab/tabpanel roles, the `aria-selected` flags, the
//      id↔`aria-controls`↔`aria-labelledby` pairing and the roving tabindex are
//      what the WAI-ARIA pattern requires;
//   ✅ that exactly ONE panel is shown and the others are `hidden` — and that
//      their children are STILL IN THE MARKUP, which is the mounting rule the
//      CNC tab's whole state depends on;
//   ✅ that the stored-tab key round-trips, including an unknown value;
//   ✅ that the `Run` tab renders no control of any kind.
//
//   🔴 NOT covered here, and each of these needs `web/e2e/`: that a real tab
//      click preserves the machine/sheet/report (this file proves the markup
//      keeps the subtree, NOT that React preserved the state behind it); that
//      the arrow keys move focus in a real browser; that `Viewport`'s render
//      loop actually stops when `paused` is set; that the CAD preview stops when
//      its box is zero-sized. The last two are the reason the pause exists and
//      NOTHING in this repository has watched either of them go quiet.
//
// `renderToStaticMarkup` is used rather than a DOM: it needs no jsdom (no new
// dependency, and this lane licence-checks every one) and it is enough for every
// question above, all of which are questions about attributes.
//
// ⚠ `createElement` rather than JSX because `npm run test:node` globs
// `tests/*.test.ts` and a `.tsx` here would simply not run — a test that is not
// collected is indistinguishable from one that passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* A fake `localStorage`, installed BEFORE the module is imported. `Tabs.tsx`
 * touches storage only inside its functions, never at module scope, so this is
 * enough — and that property is itself worth keeping: a module that read storage
 * at import time could not be tested this way and would run in whatever order
 * the bundler chose. */
const store = new Map<string, string>();
let storageThrows = false;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem(k: string) {
    if (storageThrows) throw new Error('storage disabled');
    return store.has(k) ? store.get(k)! : null;
  },
  setItem(k: string, v: string) {
    if (storageThrows) throw new Error('storage disabled');
    store.set(k, String(v));
  },
  removeItem(k: string) {
    store.delete(k);
  },
};

const {
  TABS,
  DEFAULT_TAB,
  TAB_KEY,
  parseTab,
  readStoredTab,
  rememberTab,
  tabDomId,
  panelDomId,
  TabBar,
  TabPanel,
} = await import('../src/Tabs.tsx');
const { RunTab } = await import('../src/RunTab.tsx');

// ---------------------------------------------------------------------------
// The two decisions, asserted separately
// ---------------------------------------------------------------------------

test('the ORDER is the founder’s: shop, cad, cnc, run', () => {
  assert.deepEqual(
    TABS.map((t) => t.id),
    ['shop', 'cad', 'cnc', 'run']
  );
  assert.deepEqual(
    TABS.map((t) => t.label),
    ['Designs', '2bee.cad', '2bee.cnc', 'Run']
  );
});

/* 🔴 STILL A SEPARATE TEST, AND NOW FOR A SHARPER REASON. "First in the bar"
 * and "open on arrival" are two decisions. They USED to have different answers
 * (`cad` first, `cnc` on arrival), and the old assertion here pinned that by
 * checking `DEFAULT_TAB !== TABS[0].id`. Founder 2026-08-31 ruled the shop is
 * "the 1st page", so the two answers now COINCIDE — and that is exactly when a
 * relational assertion stops being a check: `DEFAULT_TAB === TABS[0].id` passes
 * for any reordering that drags a different tab into first place, and would
 * have called that a pass. So this names the tab as a LITERAL. Reordering the
 * bar must fail the test above; changing what opens must fail this one; and
 * neither can satisfy the other by accident. */
test('the DEFAULT is the Designs tab — founder 2026-08-31, "the 1st page"', () => {
  assert.equal(DEFAULT_TAB, 'shop');
});

// ---------------------------------------------------------------------------
// The stored choice
// ---------------------------------------------------------------------------

test('every known id parses to itself', () => {
  for (const t of TABS) assert.equal(parseTab(t.id), t.id);
});

test('an unknown, absent or malformed stored value opens the default', () => {
  // Each of these is reachable: a hand-edit, a cleared store, an older build
  // that wrote a name this one does not have, or a writer that used JSON.
  for (const raw of [null, undefined, '', 'operation', 'CNC', '"cnc"', '{}', 'cad ']) {
    assert.equal(parseTab(raw), DEFAULT_TAB, `parseTab(${JSON.stringify(raw)})`);
  }
});

test('the choice round-trips through storage under its own key', () => {
  store.clear();
  assert.equal(readStoredTab(), DEFAULT_TAB, 'nothing stored yet');

  rememberTab('cad');
  assert.equal(store.get(TAB_KEY), 'cad', 'written as a bare id, not JSON');
  assert.equal(readStoredTab(), 'cad');

  rememberTab('run');
  assert.equal(readStoredTab(), 'run');

  // The value a future build, or a person with the devtools open, could leave.
  store.set(TAB_KEY, 'machine-control');
  assert.equal(readStoredTab(), DEFAULT_TAB, 'an unknown id must not open an empty screen');
});

test('storage that throws is not an error, it is the default', () => {
  store.clear();
  storageThrows = true;
  try {
    assert.equal(readStoredTab(), DEFAULT_TAB);
    rememberTab('cad'); // must not throw
  } finally {
    storageThrows = false;
  }
});

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/** Every `role="tab"` element in the markup, as raw tag text. */
function tabTags(html: string): string[] {
  return html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
}

test('the bar is a real tablist, not a row of divs', () => {
  const html = renderToStaticMarkup(h(TabBar, { tab: 'cnc', onTab: () => {} }));

  assert.match(html, /role="tablist"/);
  assert.equal(tabTags(html).length, TABS.length, 'one role="tab" per tab');

  for (const t of TABS) {
    const tag = tabTags(html).find((x) => x.includes(`id="${tabDomId(t.id)}"`));
    assert.ok(tag, `no tab element for ${t.id}`);
    assert.ok(
      tag!.includes(`aria-controls="${panelDomId(t.id)}"`),
      `${t.id}: aria-controls must name its panel`
    );
  }
});

test('exactly one tab is selected, and exactly one is in the tab order', () => {
  for (const sel of TABS) {
    const html = renderToStaticMarkup(h(TabBar, { tab: sel.id, onTab: () => {} }));
    const tags = tabTags(html);

    const selected = tags.filter((t) => t.includes('aria-selected="true"'));
    assert.equal(selected.length, 1, `${sel.id}: exactly one aria-selected="true"`);
    assert.ok(selected[0].includes(`id="${tabDomId(sel.id)}"`), `${sel.id}: the right one`);

    /* 🔴 ROVING TABINDEX. Every unselected tab must be `-1`, or the bar puts
     * three stops in the page's tab order and the arrow keys become decoration.
     * `aria-selected` alone would still announce correctly and behave wrongly. */
    const inOrder = tags.filter((t) => t.includes('tabindex="0"'));
    assert.equal(inOrder.length, 1, `${sel.id}: exactly one tabindex="0"`);
    assert.equal(
      tags.filter((t) => t.includes('tabindex="-1"')).length,
      TABS.length - 1,
      `${sel.id}: every other tab is out of the tab order`
    );
  }
});

// ---------------------------------------------------------------------------
// The panels — and the mounting rule
// ---------------------------------------------------------------------------
//
// ⚠ The children below are passed IN THE PROPS OBJECT rather than as
// `createElement`'s variadic third argument. Not a style preference: `TabPanel`
// declares `children: ReactNode` as REQUIRED, and `createElement`'s types cannot
// see that the variadic arguments satisfy it — they check `Attributes & P`
// against the props object alone. React itself treats the two spellings
// identically (with no variadic children, `config.children` is kept verbatim),
// so what is rendered and asserted here is unchanged.

test('a panel names the tab that labels it', () => {
  const html = renderToStaticMarkup(
    h(TabPanel, { id: 'cad', tab: 'cad', children: 'anything' })
  );
  assert.match(html, new RegExp(`id="${panelDomId('cad')}"`));
  assert.match(html, /role="tabpanel"/);
  assert.match(html, new RegExp(`aria-labelledby="${tabDomId('cad')}"`));
});

test('the shown panel is the only one shown', () => {
  const shown = renderToStaticMarkup(h(TabPanel, { id: 'cnc', tab: 'cnc', children: 'x' }));
  const hidden = renderToStaticMarkup(h(TabPanel, { id: 'cnc', tab: 'cad', children: 'x' }));

  assert.doesNotMatch(shown, /hidden/, 'the active panel is not hidden');
  assert.match(shown, /display:flex/, 'and it fills the remaining height');

  assert.match(hidden, /hidden/, 'an inactive panel is hidden');
  assert.match(hidden, /display:none/, 'by display too, not by attribute alone');
});

/* 🔴 THE ONE THAT MATTERS. The CNC tab holds the machine, the sheet, every
 * drawing placement and the last report the core produced — none of it derived.
 * If switching to CAD unmounted that subtree, React would discard all of it and
 * the operator would come back to a form that looks freshly opened.
 *
 * ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT: it proves the markup still CONTAINS
 * the subtree while another tab is selected, which is the property the design
 * rests on. It does not prove React preserved the state inside it — there is no
 * DOM here and no re-render. That is an e2e assertion and it is named as missing
 * in the header. */
test('a hidden panel still contains its children', () => {
  const html = renderToStaticMarkup(
    h(TabPanel, {
      id: 'cnc',
      tab: 'cad',
      children: h('div', { 'data-testid': 'panel-machine' }, 'travel X'),
    })
  );
  assert.match(html, /data-testid="panel-machine"/, 'the CAM tree is still mounted');
  assert.match(html, /travel X/);
});

test('only a panel with nothing to focus gets a tab stop of its own', () => {
  const run = renderToStaticMarkup(h(TabPanel, { id: 'run', tab: 'run', focusable: true, children: 'text' }));
  const cnc = renderToStaticMarkup(h(TabPanel, { id: 'cnc', tab: 'cnc', children: 'controls' }));
  assert.match(run, /tabindex="0"/);
  assert.doesNotMatch(cnc, /tabindex/, 'an extra stop in front of the CAM panels would move the keyboard order');

  /* Hidden and focusable is a keyboard trap in waiting — a tab stop inside a
   * `display: none` subtree. It must not survive the panel being hidden. */
  const hiddenRun = renderToStaticMarkup(
    h(TabPanel, { id: 'run', tab: 'cnc', focusable: true, children: 'text' })
  );
  assert.doesNotMatch(hiddenRun, /tabindex/);
});

// ---------------------------------------------------------------------------
// The Run tab says what it is
// ---------------------------------------------------------------------------

test('every control the Run tab offers is refused until the state permits it', () => {
  const html = renderToStaticMarkup(h(RunTab));
  /* ⚠ THIS TEST USED TO ASSERT THE OPPOSITE — "no control at all, not even a
   * disabled one" — and it was right while nothing in the app could open a
   * serial port: a greyed-out Connect said "this works once something small is
   * fixed", and that was false. The tab is built now, so the honest rendering
   * changed with it: the controls exist, and EVERY one of them that could move
   * the machine is disabled with the reason rendered beside it, because a
   * fresh `TrackedState` knows nothing, trusts nothing and refuses everything.
   * The property being kept is the same one — never imply a control works —
   * and only its expression moved. */
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0, 'the tab is built and has controls');
  for (const b of buttons) {
    if (/data-testid="run-control-connect"/.test(b)) continue; // opening a port moves nothing
    assert.match(b, /disabled/, `a control that could move the machine was live: ${b}`);
    assert.match(b, /data-refused="/, 'a disabled control must name which refusal holds it');
  }
  /* And the reason is in the markup, not only in a `title` — a tooltip is not
   * reachable from a touch screen or a keyboard, which in a shop is most
   * people, because the other hand is on the machine. */
  assert.match(html, /data-testid="run-refused-start"/);
});

test('the Run tab states the facts a user has to plan around', () => {
  /* The browser facts render when the platform cannot do Web Serial, which is
   * the state a node render is in — so the injected navigator says so
   * explicitly rather than relying on the absence of one. */
  const html = renderToStaticMarkup(h(RunTab, { navigatorLike: {} }));
  // Nothing here has ever run a machine, and the tab says so before anything else.
  assert.match(html, /ordered and has not arrived/i);
  assert.match(html, /has cut anything/i);
  // Web Serial has no polyfill and iOS cannot have one at all.
  assert.match(html, /Chrome or Edge/);
  assert.match(html, /no polyfill/i);
  assert.match(html, /iOS/);
  // And the label this application must never carry.
  assert.match(html, /not an emergency stop/i);
  assert.match(html, /does not cut power/i);
  /* `E-STOP` appears exactly once, inside the sentence that bans it. The count
   * is the assertion: the word is allowed to be DISCUSSED and must never appear
   * a second time, which is what it would do the moment somebody labels a
   * control with it. */
  assert.equal((html.match(/E-STOP/g) ?? []).length, 1);
  assert.match(html, /ever labelled E-STOP/);
});
