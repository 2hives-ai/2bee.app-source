/*
 * The first screen: Design → Change → Make (founder 2026-10-14, AGENTS.md § Scope).
 *
 * What this watches in a real browser:
 *   · a first visit opens on the three steps, with no tab bar and no header;
 *   · step 1 lists only designs that are one job on one machine;
 *   · picking one reaches step 2, and with no AI configured it says so instead
 *     of showing a box that cannot send;
 *   · step 3 names the machine, lists the setup, and Send stays DISABLED with
 *     its reason on screen — because nothing from this app has cut or printed;
 *   · Expert tools reaches the old tabs, and Simple comes back.
 *
 * 🔴 NOT watched: an AI change end to end (needs a model endpoint; the review
 * path is unit-tested in tests/cad-ask-library.test.ts), and any real send
 * (there is none to watch).
 */
import { expect, test } from '@playwright/test';

test('a first visit opens on the three steps and walks to a disabled Send', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('make-flow')).toBeVisible();
  await expect(page.getByTestId('tabbar')).toHaveCount(0);
  // The header row stays (mark, name, theme) but carries no tabs.
  await expect(page.getByTestId('open-cncjob')).toHaveCount(0);

  const cards = page.getByTestId('make-designs').locator('li');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  // Only one-job designs: every card says which machine it goes to.
  const kinds = await cards.locator('.shop-card-family').allTextContents();
  expect(kinds.length).toBeGreaterThan(0);
  for (const k of kinds) expect(['3D print', 'CNC cut']).toContain(k);

  // Pick a CNC part, so the checklist has a workpiece line.
  const cnc = cards.filter({ hasText: 'CNC cut' }).first();
  await cnc.locator('button').click();

  await expect(page.getByTestId('make-ai-off')).toBeVisible();
  await page.getByTestId('make-next').click();

  const list = page.getByTestId('make-checklist');
  await expect(list).toContainText('Put in the workpiece');
  const send = page.getByTestId('make-send');
  await expect(send).toBeDisabled();
  await expect(page.getByTestId('make-send-blocked')).toContainText('Not yet.');
  // Ticking every line does not enable it: the blocker is the reason, not the list.
  for (const box of await list.locator('input[type=checkbox]').all()) await box.check();
  await expect(send).toBeDisabled();
});

test('Expert tools reaches the five tabs, and Simple comes back', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('make-expert').click();
  await expect(page.getByTestId('tabbar')).toBeVisible();
  await expect(page.getByTestId('tab-shop')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('back-to-simple').click();
  await expect(page.getByTestId('make-flow')).toBeVisible();
  await expect(page.getByTestId('tabbar')).toHaveCount(0);
});
