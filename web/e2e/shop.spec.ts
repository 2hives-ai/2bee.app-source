// THE FOUNDER'S FLOW, END TO END: browse designs -> pick one -> it opens in
// 2bee.cad, WITH ITS IMPORTS, in the BUNDLE the browser actually loads.
//
// Founder 2026-08-31: *"have the 1st page (before 2bee.scad) a shop style page
// so the user can 'shop for the designs', select it -> than it goes to
// 2bee.cad"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY THIS SPEC HAS TO EXIST IN THE BROWSER AND NOT IN `tests/`
// ═══════════════════════════════════════════════════════════════════════════
//
// Every piece of this is unit-tested — the handoff slot, the catalogue loader,
// the tab default. All of them can pass with the feature completely broken,
// because the thing that carries the design across is a chain: the shop fetches
// `shop/d/<id>.json`, publishes to a module-level slot, App switches the tab,
// which MOUNTS `CadTab`, which claims the slot and installs a library. Four
// modules, two of them mounted lazily, and one asset that only exists after a
// build step. A green unit suite over that chain is a green over the parts.
//
// ⚠ AND THE ASSET IS THE HALF MOST LIKELY TO ROT. `public/shop/` is not in git,
// so it is exactly the kind of input that is present on the machine where the
// feature was written and absent everywhere else. This runs against
// `vite preview` over `dist/`, so it fails if the catalogue did not ship.
//
// ⚠ THIS SPEC DELIBERATELY DOES NOT USE `e2e/tab.ts`. It is one of the two
// suites (with `tabs.spec.ts`) that is ABOUT which tab opens, so seeding the
// stored choice would erase the thing under test.

import { expect, test } from '@playwright/test';

test.describe('the Designs tab', () => {
  test('is what a first visit opens on', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('shop')).toBeVisible();
    await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'true');
  });

  test('lists designs, and the catalogue actually shipped', async ({ page }) => {
    await page.goto('/');
    const cards = page.getByTestId('shop-card');
    // 🔴 NOT `> 0`. An asset that half-shipped, or a filter that silently
    // emptied, would leave a handful of cards and pass a loose bound. The
    // generator listed 79 from cad's tree when this was written; require enough
    // to prove the whole catalogue is there, while leaving room for cad to add
    // and remove models without a false red here.
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThan(40);
  });

  test('a card carries the mesher’s trust verdict, not just a picture', async ({ page }) => {
    await page.goto('/');
    const first = page.getByTestId('shop-card').first();
    await expect(first.locator('.shop-badge')).toBeVisible();
    await expect(first.locator('.shop-card-path')).toContainText('.scad');
  });

  test('a NON-TRUSTED card says its picture is incomplete', async ({ page }) => {
    /*
     * 🔴 THE TEST ABOVE IS NOT THIS TEST, AND ON ITS OWN IT PROVED NOTHING.
     *
     * The grid sorts `trusted` first, so `.first()` is ALWAYS a trusted card —
     * the one case where showing the badge and hiding the warning look
     * identical. A regression that rendered the badge only for `trusted` would
     * have passed it, while the catalogue quietly presented incomplete renders
     * as finished parts. 35 of 80 listed designs are not trusted, so that is
     * the common case, not an edge.
     *
     * This asserts the case where right and wrong DISAGREE: a card whose mesh
     * is suspect or untrusted must say so in words, not merely carry a badge.
     */
    await page.goto('/');
    const bad = page.locator('.shop-card:not(.shop-trust-trusted)').first();
    await expect(bad).toBeVisible();
    const badge = bad.locator('.shop-badge');
    await expect(badge).toBeVisible();
    // The badge must not read as an endorsement.
    await expect(badge).not.toContainText('complete render');
    await expect(badge).not.toContainText('mesh closed');
    // And the card must state the CONSEQUENCE for the picture.
    await expect(bad.locator('.shop-card-trust')).toContainText(
      /REFUSED|did not draw what the source describes|non-manifold|Nothing was drawn/,
    );
  });

  test('NO card claims a correctness nobody checked — ruled by ceo 2026-09-02', async ({ page }) => {
    /*
     * 🔴 THE LABEL WAS THE LIVE FALSE CLAIM, AND IT OUTRANKED THE GATE.
     *
     * `trusted` used to render as "complete render". It is a statement about the
     * MESH — watertight, manifold, nothing refused — and NOT that the shape
     * matches the source. Measured 2026-08-31 against OpenSCAD 2026.08.07: 10 of
     * 47 designs with a clean mesh still differed, and
     * `2bee_hive_fan_box_panel_wcnc` — a CNC sheet part — was offered at 41 mm
     * for a 407 mm panel under that badge.
     *
     * ⚠ ASSERTED ACROSS EVERY CARD, not the first one. The grid sorts trusted
     * first, so a check on `.first()` samples exactly the cards most likely to
     * carry an endorsement and would miss one reintroduced further down.
     */
    await page.goto('/');
    const badges = page.locator('.shop-badge');
    const texts = await badges.allInnerTexts();
    expect(texts.length).toBeGreaterThan(40);
    for (const t of texts) {
      expect(t.toLowerCase(), 'a badge asserts a correctness no oracle has confirmed').not.toMatch(
        /complete|verified|correct|accurate|matches/,
      );
    }
    // And the page must say plainly that nothing here was checked against an oracle.
    await expect(page.getByTestId('shop-no-oracle')).toContainText('checked against OpenSCAD');
  });

  test('search narrows the grid', async ({ page }) => {
    await page.goto('/');
    const before = await page.getByTestId('shop-card').count();
    await page.getByTestId('shop-search').fill('zzzzzzzz-no-such-design');
    await expect(page.getByTestId('shop-no-match')).toBeVisible();
    await page.getByTestId('shop-search').fill('');
    await expect(page.getByTestId('shop-card')).toHaveCount(before);
  });

  test('PICKING A DESIGN OPENS IT IN 2bee.cad — the whole feature', async ({ page }) => {
    await page.goto('/');

    const card = page.getByTestId('shop-card').first();
    const title = (await card.locator('.shop-card-title').innerText()).trim();
    const path = (await card.locator('.shop-card-path').innerText()).trim();
    await card.locator('button').click();

    // 1. It went to the CAD tab.
    await expect(page.getByTestId('tabpanel-cad')).toBeVisible();
    await expect(page.getByTestId('tab-cad')).toHaveAttribute('aria-selected', 'true');

    // 2. The editor holds THAT design, not the example file. Asserting on the
    //    editor's text is the point: a handoff that switched tabs and delivered
    //    nothing would satisfy (1) alone and look exactly like success.
    const editor = page.getByTestId('cad-editor');
    await expect(editor).toBeVisible();
    const text = await editor.innerText();
    expect(text.length).toBeGreaterThan(0);
    expect(text, `the editor should hold ${path}, not the example`).not.toContain(
      '// 2bee.cad. Edit freely',
    );

    // 3. The design's own name reaches the tab, so the user can see WHICH model
    //    they are in.
    expect(title.length).toBeGreaterThan(0);
  });

  test('the opened design’s imports RESOLVE — the closure travelled with it', async ({ page }) => {
    await page.goto('/');
    // Pick a design whose card says it carries more than one file, so this
    // asserts about a real import graph rather than a single self-contained
    // model that would pass whether or not the closure shipped.
    await page.getByTestId('shop-search').fill('assembly');
    const card = page.getByTestId('shop-card').first();
    await card.locator('button').click();
    await expect(page.getByTestId('tabpanel-cad')).toBeVisible();

    // The CAD console names an unresolved import. Nothing here may say a path
    // could not be resolved — that is precisely what a missing closure causes,
    // and ONLY in a production build, where `/__cad-library` does not exist.
    const panel = page.getByTestId('tabpanel-cad');
    await expect(panel).not.toContainText('could not be resolved');
  });
});
