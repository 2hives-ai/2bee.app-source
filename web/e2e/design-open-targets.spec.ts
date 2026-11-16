// "OPEN IN …" FROM THE DESIGN PAGE, ASSERTED IN THE TARGET TAB.
//
// Founder 2026-10-15: *"make sure in the design the open in ... working correctly for
// cad , pnp or 3d"*. Each test clicks the card's action and then asserts on what the
// TARGET tab shows — not on the click, not on the tab switch alone: a handoff that
// switched tabs and delivered nothing looks exactly like success from the design page.
//
// Design used for cad/cnc/3d: "Hive cleat" (`2bee_hive/2bee_hive_cleat_wcnc.scad`) —
// one closed solid, so every target can take it without a refusal.

import { expect, test, type Page } from '@playwright/test';
import { seedCadCode, seedTab } from './tab';

const ID = '2bee-hive-2bee-hive-cleat-wcnc';
const TITLE = 'Hive cleat';

async function openFromDesign(page: Page, target: 'cad' | 'cnc' | '3d') {
  await seedTab(page, 'shop');
  await page.goto('/');
  await page.getByTestId('shop-search').fill(TITLE);
  await page.getByTestId(target === 'cad' ? `shop-open-${ID}` : `shop-open-${target}-${ID}`).click();
  await expect(page.getByTestId('shop-failed')).toHaveCount(0);
}

test('cad: the cad tab holds THIS design and draws its mesh', async ({ page }) => {
  await seedCadCode(page); // the code view, so the source can be read
  // The design's own source, from the same file the card loads.
  const d = (await (await page.request.get(`/shop/d/${ID}.json`)).json()) as { path: string; sources: Record<string, string> };
  const line = d.sources[d.path].split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))!;
  await openFromDesign(page, 'cad');
  await expect(page.getByTestId('tab-cad')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
  const panel = page.getByTestId('tabpanel-cad');
  await expect(panel.getByTestId('cad-editor')).toContainText(line, { timeout: 30_000 });
  await expect(panel.getByTestId('cad-preview-canvas')).toBeVisible();
  await expect(panel.getByTestId('cad-preview')).toHaveAttribute('data-trust', 'trusted', { timeout: 30_000 });
});

/* Routing is App.tsx's `onShopOpened` (target -> tab), wired 2026-10-15. */
for (const [target, tab] of [['cnc', 'tab-cnc'], ['3d', 'tab-print3d'], ['pnp', 'tab-pnp']] as const) {
  test(`routing: Open in ${target} lands on the ${target} tab`, async ({ page }) => {
    if (target === 'pnp') {
      await seedTab(page, 'shop');
      await page.goto('/');
      await page.getByTestId('shop-show-pcb').click();
      await page.getByTestId('shop-pcb-card').first().getByRole('button', { name: 'Open in pnp' }).click();
    } else {
      await openFromDesign(page, target);
    }
    await expect(page.getByTestId(tab)).toHaveAttribute('aria-selected', 'true', { timeout: 45_000 });
  });
}

test('cnc: the cnc tab has the design in its picker and plans it', async ({ page }) => {
  /* The cnc tab claims `claimPendingFor('cnc')` since 2026-10-15 (App.tsx pendingCnc); this was
   * a self-retiring test.fail until then. */
  /* `cnc-chat-plan` exists only in the CHAT view, and playwright.config.ts seeds every page with the code view
   * (2ac89e59ad; "a chat-view spec sets 2bee.app.cnc.view = 'chat' itself"). This test never did, so it never
   * passed under Playwright (armed in 2a7f7d67b7 after a manual check on :5190). It asserts a PLAN LINE, either
   * verdict: what is under test is that the handed-over design reaches the planner. */
  await page.addInitScript(() => localStorage.setItem('2bee.app.cnc.view', 'chat'));
  await openFromDesign(page, 'cnc');
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'false', { timeout: 45_000 });
  await page.getByTestId('tab-cnc').click();
  const panel = page.getByTestId('tabpanel-cnc');
  await expect(panel).toContainText(TITLE, { timeout: 30_000 });
  await expect(panel.getByTestId('cnc-chat-plan')).toHaveText(/^Plan (OK|refused)/, { timeout: 60_000 });
});

/* DELIVERY, separated from routing: the tab is clicked by hand after the action, so these
 * assert that the target tab CLAIMS what the design page handed over. */
test('3d: the 3d tab receives the design as an STL', async ({ page }) => {
  await openFromDesign(page, '3d');
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'false', { timeout: 45_000 });
  await page.getByTestId('tab-print3d').click();
  const panel = page.getByTestId('tabpanel-print3d');
  // No slicer bridge in this run, so it is HELD and says so; with a bridge it is uploaded.
  await expect(panel.getByTestId('p3d-incoming')).toContainText(TITLE, { timeout: 30_000 });
});

test('pnp: a PCB card opens that board in the pnp tab', async ({ page }) => {
  await seedTab(page, 'shop');
  await page.goto('/');
  await page.getByTestId('shop-show-pcb').click();
  const card = page.getByTestId('shop-pcb-card').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const id = (await card.getByRole('button', { name: 'Open in pnp' }).getAttribute('data-testid'))!.replace('shop-pcb-open-', '');
  await card.getByRole('button', { name: 'Open in pnp' }).click();
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'false', { timeout: 30_000 });
  await page.getByTestId('tab-pnp').click();
  // The pnp tab's picker shows the chosen board as its current row (pnp/BoardPicker.tsx).
  // Either the collapsed "current" row names it, or the open list marks its row pressed.
  const pnp = page.getByTestId('tabpanel-pnp');
  await expect(
    pnp.getByTestId('pnp-board-current').filter({ hasText: id }).or(pnp.locator(`[data-testid="pnp-board-item-${id}"][aria-pressed="true"]`)),
  ).toBeVisible({ timeout: 30_000 });
  await expect(pnp.getByTestId('pnp-components')).toBeVisible();
});
