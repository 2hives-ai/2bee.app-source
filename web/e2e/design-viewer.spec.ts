// CLICK THE PICTURE → A 3D VIEW OF THE DESIGN (founder 2026-10-15: *"when I
// click on the preview it should open the 3d visualization"*).
//
// Asserted on what the viewer DREW, not on the dialog opening: a canvas from
// CadPreview inside the dialog, and the mesher's triangle count (> 0) carried on
// the dialog — a dialog that opened over an empty or refused mesh would pass an
// "is visible" check and show nothing.

import { expect, test, type Page } from '@playwright/test';
import { seedTab } from './tab';

async function expectMeshShown(page: Page, readyTimeout = 45_000) {
  const dlg = page.getByTestId('design-viewer');
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute('data-state', 'ready', { timeout: readyTimeout });
  expect(Number(await dlg.getAttribute('data-triangles'))).toBeGreaterThan(0);
  await expect(dlg.getByTestId('cad-preview-canvas')).toBeVisible();
  await expect(dlg.getByTestId('cad-preview')).toHaveAttribute('data-trust', /trusted|suspect|untrusted/);
  // The catalogue's standing caveat travels into the viewer.
  await expect(dlg.getByTestId('design-viewer-trust')).toContainText('Not checked against OpenSCAD');
}

test('Designs tab: the thumbnail opens a 3D view; Esc closes it; the card action is untouched', async ({ page }) => {
  await seedTab(page, 'shop');
  await page.goto('/');
  const card = page.getByTestId('shop-card').first();
  const thumb = card.getByRole('button', { name: /^View .+ in 3D$/ });
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expectMeshShown(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('design-viewer')).toHaveCount(0);
  await expect(thumb).toBeFocused();
  // Keyboard: Enter on the focused picture opens it too.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('design-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('design-viewer')).toHaveCount(0);
  // The open action is still its own button and still says what it does.
  await expect(card.getByRole('button', { name: 'Open in cad' })).toBeVisible();
  await expect(page.getByTestId('shop')).toBeVisible(); // the thumb did not navigate away
});

test('Designs tab: a suspect design says what was refused', async ({ page }) => {
  await seedTab(page, 'shop');
  await page.goto('/');
  const card = page.locator('li.shop-trust-suspect').first();
  await card.getByRole('button', { name: /in 3D$/ }).click();
  const dlg = page.getByTestId('design-viewer');
  await expect(dlg.getByTestId('design-viewer-trust')).toContainText('suspect');
  await expect(dlg).toHaveAttribute('data-state', /ready|failed/, { timeout: 45_000 });
  // The mesher's own sentence — not a paraphrase — is on the dialog.
  const detail = (await card.locator('.shop-card-trust').getAttribute('title')) ?? '';
  expect(detail.length).toBeGreaterThan(0);
  await expect(dlg).toContainText(detail.slice(0, 40));
  await dlg.getByTestId('design-viewer-close').click();
  await expect(dlg).toHaveCount(0);
});

test('Simple flow: the thumbnail in "Pick a design" opens a 3D view and does not pick', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('make-flow')).toBeVisible();
  const card = page.getByTestId('make-designs').locator('li').first();
  await card.getByRole('button', { name: /^View .+ in 3D$/ }).click();
  await expectMeshShown(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('design-viewer')).toHaveCount(0);
  // Still on step 1: viewing is not picking.
  await expect(page.getByRole('heading', { name: 'Pick a design' })).toBeVisible();
  // And the pick button still picks.
  await card.locator('[data-testid^="make-design-"]').click();
  await expect(page.getByRole('heading', { name: 'Pick a design' })).toHaveCount(0, { timeout: 30_000 });
});

test('a slow build says so on screen, and Close abandons it', async ({ page }) => {
  await seedTab(page, 'shop');
  // Hold the design's sources back so the build cannot finish inside the slow threshold.
  await page.route('**/shop/d/*.json', async (route) => {
    await new Promise((r) => setTimeout(r, 7000));
    await route.continue().catch(() => {});
  });
  await page.goto('/');
  await page.getByTestId('shop-card').first().getByRole('button', { name: /in 3D$/ }).click();
  const dlg = page.getByTestId('design-viewer');
  await expect(dlg.getByTestId('design-viewer-building')).toBeVisible();
  await expect(dlg.getByTestId('design-viewer-slow')).toContainText('This is slow', { timeout: 6000 });
  await dlg.getByTestId('design-viewer-close').click();
  await expect(dlg).toHaveCount(0);
});

/* 🔴 THE DEV SERVER, BECAUSE THAT IS WHERE THE FOUNDER SAW IT FAIL (2026-10-15: "when I click
 * nothing happening"). React StrictMode double-mounts effects in dev only; the dialog's own
 * close event from the first mount closed the second. Every production-build test above passed
 * through that defect. */
const DEV = `http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`;
test('dev server: a real click on the picture opens the 3D view, and Esc closes it', async ({ page }) => {
  // A cold dev server compiles the worker and the mesher on first request.
  test.setTimeout(180_000);
  await seedTab(page, 'shop');
  await page.goto(DEV);
  const thumb = page.getByTestId('shop-card').first().getByRole('button', { name: /^View .+ in 3D$/ });
  await thumb.click();
  await expect(page.getByTestId('design-viewer')).toBeVisible();
  await expectMeshShown(page, 150_000);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('design-viewer')).toHaveCount(0);
});

/* Founder 2026-10-15: "open every item in cad , cnc or 3d" + "filter to see only my designs".
 * Open in cnc builds the design's drawings record through 2bee.cad's own Save route and saves
 * it in this browser — so it then appears under Mine, where its picture opens the 3D view. */
test('every card offers cad · cnc · 3d; Open in cnc saves it, and it shows under Mine', async ({ page }) => {
  test.setTimeout(240_000);
  await seedTab(page, 'shop');
  await page.goto('/');
  const card = page.getByTestId('shop-card').first();
  for (const t of ['cad', 'cnc', '3d']) await expect(card.getByRole('button', { name: `Open in ${t}` })).toBeVisible();

  const id = '2bee-hive-2bee-hive-cleat-wcnc';
  await page.getByTestId('shop-search').fill('Hive cleat');
  await page.getByTestId(`shop-open-cnc-${id}`).click();
  // The shop hands over and switches tab (App decides which); a refusal would stay on the shop.
  await expect(page.getByTestId('shop-failed')).toHaveCount(0);
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'false', { timeout: 45_000 });

  await page.getByTestId('tab-shop').click();
  await page.getByTestId('shop-show-mine').click();
  const mine = page.getByTestId('shop-mine-card').filter({ hasText: 'Hive cleat' });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('ONE section');
  for (const t of ['cad', 'cnc', '3d']) await expect(mine.getByRole('button', { name: `Open in ${t}` })).toBeEnabled();
  await mine.getByRole('button', { name: /^View .+ in 3D$/ }).click();
  await expectMeshShown(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('design-viewer')).toHaveCount(0);

  // A second Open in cnc of the SAME design reuses its name rather than piling up copies.
  await page.getByTestId('shop-show-all').click();
  await page.getByTestId(`shop-open-cnc-${id}`).click();
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'false', { timeout: 45_000 });
  await page.getByTestId('tab-shop').click();
  await page.getByTestId('shop-show-mine').click();
  await expect(page.getByTestId('shop-mine-card').filter({ hasText: 'Hive cleat' })).toHaveCount(1);
});

/* Founder 2026-10-15: "remove the thumbnail from cnc, add it to cad" — cad's Save thumbnail
 * keys a catalogue design by its PATH; pictures saved from cnc earlier used the TITLE. Both
 * replace the catalogue picture, labelled "your picture". */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
for (const key of ['2bee_hive/2bee_hive_cleat_wcnc.scad', 'Hive cleat']) {
  test(`a saved picture keyed by ${key.includes('/') ? 'path (cad)' : 'title (old cnc)'} replaces the catalogue picture`, async ({ page }) => {
    await page.addInitScript(([k, url]) => {
      localStorage.setItem('2bee.app.thumb.' + k, JSON.stringify({ dataUrl: url, savedAt: 1, from: 'cad' }));
    }, [key, PNG] as const);
    await seedTab(page, 'shop');
    await page.goto('/');
    await page.getByTestId('shop-search').fill('Hive cleat');
    const card = page.getByTestId('shop-card').filter({ hasText: 'Hive cleat' }).first();
    await expect(card.getByTestId('thumb-saved-2bee-hive-2bee-hive-cleat-wcnc')).toHaveAttribute('src', PNG);
    await expect(card).toContainText('your picture');
    await card.getByRole('button', { name: /^View Hive cleat in 3D$/ }).click();
    await expect(page.getByTestId('design-viewer')).toBeVisible();
  });
}

/* Founder 2026-10-15: "able to filter designs by 3d, cad, pcb" and "load all pcbs into the
 * design, able to open only with pnp". */
test('the kind filter: 3d shows only X2D prints, cad only router parts, pcb only boards with pnp as the one action', async ({ page }) => {
  await seedTab(page, 'shop');
  await page.goto('/');
  await expect(page.getByTestId('shop-card').first()).toBeVisible();

  for (const [f, re] of [['3d', /_3d\.scad$/], ['cad', /_wcnc\.scad$/]] as const) {
    await page.getByTestId(`shop-show-${f}`).click();
    await expect(page.getByTestId(`shop-show-${f}`)).toHaveAttribute('aria-pressed', 'true');
    const n = Number((await page.getByTestId(`shop-show-${f}`).locator('.shop-show-n').textContent()) ?? 'NaN');
    const paths = await page.getByTestId('shop-card').locator('.shop-card-path').allTextContents();
    expect(paths.length).toBe(n); // the count on the filter is the number of cards shown
    for (const p of paths) expect(p).toMatch(re);
  }

  await page.getByTestId('shop-show-pcb').click();
  const pcb = page.getByTestId('shop-pcb-card');
  await expect(pcb.first().or(page.getByTestId('shop-pcb-absent'))).toBeVisible({ timeout: 30_000 });
  if (await pcb.count()) {
    for (const card of await pcb.all()) {
      // Widened 2026-10-16: a board opens in pcb or pnp ("update design to able to open pcbs
      // with pcb or pnp"), and its picture opens the 3D view.
      await expect(card.locator('.shop-card-actions').getByRole('button', { name: 'Open in pnp' })).toHaveCount(1);
      await expect(card.getByRole('button', { name: /^View .+ in 3D$/ })).toHaveCount(1);
    }
  }
});

/* Founder 2026-10-16: "when I am on the design and I click on the pcb I would see the 3d as I can
 * see the cad". Asserted on what was DRAWN: the pnp tab's own board canvas inside the dialog, the
 * part count the board model carried, and a stated board source (gerbers, or the plate caveat). */
test('Designs tab: a PCB picture opens the board in 3D; Esc closes it; Open in pnp still opens pnp', async ({ page }) => {
  await seedTab(page, 'shop');
  await page.goto('/');
  await page.getByTestId('shop-show-pcb').click();
  const card = page.getByTestId('shop-pcb-card').filter({ hasText: 'outlet' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const thumb = card.getByRole('button', { name: 'View outlet in 3D' });
  await thumb.click();
  const dlg = page.getByTestId('pcb-viewer');
  await expect(dlg).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  expect(Number(await dlg.getAttribute('data-parts'))).toBeGreaterThan(0);
  await expect(dlg.getByTestId('pnp-board-canvas')).toBeVisible();
  await expect(dlg).toHaveAttribute('data-gerber', /yes|no/, { timeout: 30_000 });
  await expect(dlg.getByTestId('pcb-viewer-gerber')).toContainText(/gerbers|not the board outline/);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(thumb).toBeFocused();
  // Enter on the picture opens it; the dialog's Open in pnp closes it and opens the board in pnp.
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('pcb-viewer-open-pnp').click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'false', { timeout: 30_000 });
});
