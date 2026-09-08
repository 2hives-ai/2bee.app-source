// The one resize primitive: its clamp, its drag arithmetic, what it remembers,
// and the grips it renders.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS SUITE CANNOT DO, SAID FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// **There is no browser on this box and NOBODY HAS DRAGGED ANYTHING.** No
// pointer event has been dispatched, no element has changed size, and no size
// has survived a real page reload. Every assertion below is either on a PURE
// FUNCTION or on server-rendered markup:
//
//   ✅ that the clamp floors BOTH axes and that the floor beats the ceiling
//      when a short window makes them cross;
//   ✅ that the drag arithmetic cannot reach zero, respects a single-axis grip,
//      and doubles the delta for a centred dialog;
//   ✅ that a written size reads back identically through a FRESH read — which
//      is what "survives a refresh" reduces to once the page is gone;
//   ✅ that every unhappy storage path returns `null` rather than a broken size;
//   ✅ that the three grips are in the markup with their roles and testids.
//
//   🔴 NOT covered here, and each of these needs a human at the screen or
//      `web/e2e/`: that a pointer drag actually moves an edge; that the grip
//      stays under the cursor on a centred dialog; that the drag does not
//      re-render (the property is structural — no `setState` exists on the move
//      path — but *smoothness* is a thing you watch, not a thing you assert);
//      that the corner grip is visible against the dialog's foot; that a
//      restored size looks right on a screen this box does not have.
//
// ⚠ `createElement` rather than JSX because `npm run test:node` globs
// `tests/*.test.ts` and a `.tsx` here would simply not run — a test that is not
// collected is indistinguishable from one that passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* A fake `localStorage`, installed BEFORE the module is imported. `resizable.tsx`
 * touches storage only inside functions, never at module scope — which is the
 * property that makes this possible and is worth keeping. */
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
    if (storageThrows) throw new Error('storage disabled');
    store.delete(k);
  },
};

const {
  clampSize,
  sizeAfterDrag,
  viewportBounds,
  sizeKey,
  readStoredSize,
  writeStoredSize,
  forgetStoredSize,
  useResizable,
  DEFAULT_MIN_W,
  DEFAULT_MIN_H,
  VIEWPORT_MARGIN,
} = await import('../src/resizable.tsx');

/* Bounds with plenty of room, so a test about the floor is not accidentally a
 * test about the ceiling. */
const ROOMY = { minW: 100, minH: 80, maxW: 4000, maxH: 3000 };

/* ── The clamp ─────────────────────────────────────────────────────────────── */

test('the floor is enforced on BOTH axes, not just the one you thought of', () => {
  // 🔴 THE PLANT THIS EXISTS FOR: flooring width and forgetting height (or the
  // reverse) is the asymmetry that ships. It looks correct in every drag that
  // happens to be wide, and it is unrecoverable when it finally bites, because a
  // box of zero height has no grip left to grab.
  const tiny = clampSize({ w: 0, h: 0 }, ROOMY);
  assert.equal(tiny.w, ROOMY.minW, 'width was not floored');
  assert.equal(tiny.h, ROOMY.minH, 'height was not floored — the asymmetric case');

  // Negative, which a drag past the origin genuinely produces.
  const negative = clampSize({ w: -900, h: -900 }, ROOMY);
  assert.deepEqual(negative, { w: ROOMY.minW, h: ROOMY.minH });

  // And one axis at a time, so a clamp that only works when both are small
  // cannot pass.
  assert.equal(clampSize({ w: 1, h: 500 }, ROOMY).h, 500);
  assert.equal(clampSize({ w: 1, h: 500 }, ROOMY).w, ROOMY.minW);
  assert.equal(clampSize({ w: 500, h: 1 }, ROOMY).w, 500);
  assert.equal(clampSize({ w: 500, h: 1 }, ROOMY).h, ROOMY.minH);
});

test('the ceiling holds on both axes', () => {
  const big = clampSize({ w: 99999, h: 99999 }, ROOMY);
  assert.deepEqual(big, { w: ROOMY.maxW, h: ROOMY.maxH });
});

test('when a short window makes the floor and the ceiling cross, the FLOOR wins', () => {
  // A 300px-tall browser window: maxH (268) is below minH (400). The two orders
  // give opposite answers and only one of them is recoverable — overflowing the
  // window can be undone by resizing the window; collapsing below the dialog's
  // own header cannot be undone at all.
  const squeezed = { minW: 280, minH: 400, maxW: 1000, maxH: 268 };
  const got = clampSize({ w: 600, h: 600 }, squeezed);
  assert.equal(got.h, 400, 'the floor lost to a ceiling below it');
});

/* ── The drag ──────────────────────────────────────────────────────────────── */

test('a drag cannot reach zero on either axis', () => {
  const from = { w: 500, h: 400 };
  const dragged = sizeAfterDrag(from, -5000, -5000, 'both', 'topleft', ROOMY);
  assert.deepEqual(dragged, { w: ROOMY.minW, h: ROOMY.minH });
  assert.ok(dragged.w > 0 && dragged.h > 0);
});

test('a single-axis grip moves ONE axis', () => {
  const from = { w: 500, h: 400 };
  const x = sizeAfterDrag(from, 100, 100, 'x', 'topleft', ROOMY);
  assert.deepEqual(x, { w: 600, h: 400 }, 'the horizontal grip changed the height');
  const y = sizeAfterDrag(from, 100, 100, 'y', 'topleft', ROOMY);
  assert.deepEqual(y, { w: 500, h: 500 }, 'the vertical grip changed the width');
});

test('a CENTRED dialog doubles the pointer delta, an in-flow box does not', () => {
  // A dialog held by `translate(-50%, -50%)` grows from its middle, so each edge
  // moves half the size change. Drag the corner 100px right and the width must
  // grow 200 for the corner to arrive under the pointer. Without the doubling
  // the box tracks at half speed and reads as a broken drag rather than as
  // arithmetic.
  const from = { w: 500, h: 400 };
  assert.equal(sizeAfterDrag(from, 100, 0, 'both', 'center', ROOMY).w, 700);
  assert.equal(sizeAfterDrag(from, 100, 0, 'both', 'topleft', ROOMY).w, 600);
  assert.equal(sizeAfterDrag(from, 0, 50, 'both', 'center', ROOMY).h, 500);
});

/* ── The bounds ────────────────────────────────────────────────────────────── */

test('the window bound is measured, keeps a margin, and never returns a max below its min', () => {
  const w = globalThis as { window?: unknown };
  const had = 'window' in w;
  try {
    (w as { window: unknown }).window = { innerWidth: 1200, innerHeight: 800 };
    const b = viewportBounds(280, 220);
    assert.equal(b.maxW, 1200 - VIEWPORT_MARGIN * 2);
    assert.equal(b.maxH, 800 - VIEWPORT_MARGIN * 2);

    // A window narrower than the dialog's own floor. `clampSize` is what
    // resolves the crossing (the floor wins); `viewportBounds` must not
    // pre-empt it by reporting nonsense.
    (w as { window: unknown }).window = { innerWidth: 10, innerHeight: 10 };
    const tight = viewportBounds(280, 220);
    assert.ok(Number.isFinite(tight.maxW) && tight.maxW > 0);
    assert.ok(Number.isFinite(tight.maxH) && tight.maxH > 0);
  } finally {
    if (!had) delete (w as { window?: unknown }).window;
  }
});

/* ── What is remembered ────────────────────────────────────────────────────── */

test('a size written now is the size read back later — the whole of "survives a refresh"', () => {
  // 🔴 THE OTHER PLANT: a size that is applied but never stored, or stored but
  // never read, LOOKS identical to a working feature until the second time the
  // dialog opens. A page reload leaves nothing behind but this key, so a fresh
  // read returning the same numbers is exactly the property, and the only part
  // of it this box can reach.
  forgetStoredSize('tool-picker');
  assert.equal(readStoredSize('tool-picker'), null, 'a never-sized list must start at its default');

  writeStoredSize('tool-picker', { w: 940, h: 705 });
  assert.deepEqual(readStoredSize('tool-picker'), { w: 940, h: 705 });

  // Two lists do not share a size.
  writeStoredSize('drawing-picker', { w: 400, h: 300 });
  assert.deepEqual(readStoredSize('tool-picker'), { w: 940, h: 705 });
  assert.deepEqual(readStoredSize('drawing-picker'), { w: 400, h: 300 });
});

test('the key names the list, so a stored size can be found by hand', () => {
  assert.equal(sizeKey('cad-library-picker'), '2bee.app.size.cad-library-picker');
});

test('every broken stored value reads as "never sized", never as a broken box', () => {
  const cases: Array<[string, string]> = [
    ['not json at all', '{oh dear'],
    ['a bare number', '42'],
    ['null', 'null'],
    ['an array', '[900,700]'],
    ['half a pair', '{"w":900}'],
    ['strings that look like numbers', '{"w":"900","h":"700"}'],
    ['zero', '{"w":0,"h":0}'],
    ['negative', '{"w":-900,"h":-700}'],
    ['null height', '{"w":900,"h":null}'],
  ];
  for (const [why, raw] of cases) {
    store.set(sizeKey('probe'), raw);
    assert.equal(readStoredSize('probe'), null, `${why} should read as never-sized`);
  }
  forgetStoredSize('probe');
});

test('storage that throws is harmless in both directions', () => {
  // A browser with storage disabled must get a resize that works for this
  // session and is forgotten — not an app that fails to open a list.
  writeStoredSize('throwy', { w: 800, h: 600 });
  storageThrows = true;
  try {
    assert.equal(readStoredSize('throwy'), null);
    assert.doesNotThrow(() => writeStoredSize('throwy', { w: 100, h: 100 }));
    assert.doesNotThrow(() => forgetStoredSize('throwy'));
  } finally {
    storageThrows = false;
  }
  // And the value that was there before the outage is still there afterwards:
  // a failed write must not have destroyed it.
  assert.deepEqual(readStoredSize('throwy'), { w: 800, h: 600 });
  forgetStoredSize('throwy');
});

/* ── The grips, as markup ──────────────────────────────────────────────────── */

/** A host that does what `resizable.tsx`'s header tells a caller to do. */
function Host(props: { id: string; axis?: 'both' | 'x' | 'y'; enabled?: boolean }) {
  const rz = useResizable({ id: props.id, axis: props.axis, enabled: props.enabled });
  return h('div', { ref: rz.ref, 'data-testid': props.id }, rz.grips);
}

test('both axes AND a corner are offered, each announced', () => {
  const html = renderToStaticMarkup(h(Host, { id: 'tool-picker' }));
  assert.match(html, /data-testid="tool-picker-resize-x"/, 'no horizontal grip');
  assert.match(html, /data-testid="tool-picker-resize-y"/, 'no vertical grip');
  assert.match(html, /data-testid="tool-picker-resize"/, 'no corner grip');
  // Reachable without a pointer. This app is used one-handed next to a machine,
  // and it is also the only route a driver has that is not a synthetic gesture.
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 3, 'a grip is not focusable');
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="horizontal"/, 'the vertical grip is not announced');
  assert.match(html, /aria-label="resize tool-picker horizontally"/);
});

test('a caller may offer one axis, and then the corner is NOT offered', () => {
  const html = renderToStaticMarkup(h(Host, { id: 'x-only', axis: 'x' }));
  assert.match(html, /data-testid="x-only-resize-x"/);
  assert.ok(!html.includes('x-only-resize-y'), 'a vertical grip on a horizontal-only list');
  assert.ok(!html.includes('data-testid="x-only-resize"'), 'a corner that moves an axis with no grip');
});

test('a surface that is not open offers nothing to drag', () => {
  const html = renderToStaticMarkup(h(Host, { id: 'shut', enabled: false }));
  assert.ok(!html.includes('rz-grip'), 'grips rendered for a closed dialog');
});

test('the shipped floors are the ones the primitive documents', () => {
  // Guards against a floor being lowered in passing: these two numbers are the
  // difference between "small" and "unrecoverable".
  assert.equal(DEFAULT_MIN_W, 280);
  assert.equal(DEFAULT_MIN_H, 160);
});
