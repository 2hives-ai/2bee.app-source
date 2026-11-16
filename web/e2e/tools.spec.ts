/*
 * The Tools tab (founder 2026-10-14) and the router panel in Run.
 *
 * Watched here: a measured cutter can be registered and removed, the "what to
 * measure" guide appears for the field being filled (with a 3D view or its
 * fallback, never a blank box), and the Run tab's router panel refuses to
 * analyse before a board is identified.
 * 🔴 NOT watched: the camera, IndexedDB photo round-trip, real WebGL pixels,
 * and any analysis against a real controller (none has ever been connected).
 */
import { expect, test } from '@playwright/test';
import { seedTab } from './tab';

test('register a measured cutter, see the measuring guide, then remove it', async ({ page }) => {
  await seedTab(page, 'tools');
  await page.goto('/');
  const panel = page.locator('#tabpanel-tools');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  const own = panel.getByRole('radio', { name: /Not in the list/ });
  if (await own.isEnabled()) await own.check();

  await panel.locator('select').first().selectOption({ index: 1 });
  const dia = panel.getByPlaceholder('required').first();
  await dia.focus();
  const guide = panel.getByTestId('measure-guide');
  await expect(guide).toBeVisible();
  await expect(guide.getByTestId('measure3d').or(guide.getByTestId('measure3d-fallback'))).toBeVisible();
  await dia.fill('6');
  // Fill any other required field the chosen type asks for (V-bit angle).
  for (const extra of await panel.getByPlaceholder('required').all()) if (!(await extra.inputValue())) await extra.fill('90');

  await panel.getByRole('button', { name: 'Register' }).click();
  const rows = panel.getByTestId('tool-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(/no photo/i);

  await rows.first().getByRole('button', { name: 'Remove' }).click();
  await panel.getByRole('group', { name: /Confirm removing/ }).getByRole('button', { name: 'Remove' }).click();
  await expect(rows).toHaveCount(0);
});

test('the Run tab router panel refuses to analyse before a board is identified', async ({ page }) => {
  await seedTab(page, 'run');
  await page.goto('/');
  const analyse = page.getByTestId('router-analyse');
  await expect(analyse).toBeDisabled();
  await expect(page.getByTestId('router-blocked')).toContainText('identify the router first');
});
