/*
 * The home page (founder 2026-10-16: "Create a marketing landing page on home
 * (when I click on the 2bee.app)").
 *
 * Watched in a real browser: the "2bee.app" name in the header opens the home
 * view at #home, "Pick a design" opens the three-step design screen, the
 * browser's Back returns from home to the view it was opened from, and
 * "Open the expert tools" reaches the tab bar.
 */
import { expect, test } from '@playwright/test';

test('the 2bee.app name opens home, and Pick a design opens the design step', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('make-flow')).toBeVisible();

  await page.getByTestId('brand-home').click();
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page).toHaveURL(/#home$/);
  await expect(page.getByTestId('home-preview')).toContainText('Nothing made with it has been cut, printed or placed yet.');

  await page.getByTestId('home-pick').click();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(page.getByTestId('make-flow')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pick a design' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
});

test('Back from home returns to the view it was opened from', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('make-expert').click();
  await expect(page.getByTestId('tabbar')).toBeVisible();

  await page.getByTestId('brand-home').click();
  await expect(page.getByTestId('home')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(page.getByTestId('tabbar')).toBeVisible();
});

test('a link to #home opens home, and the expert tools button reaches the tabs', async ({ page }) => {
  await page.goto('/#home');
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByTestId('home-expert').click();
  await expect(page.getByTestId('home')).toHaveCount(0);
  await expect(page.getByTestId('tabbar')).toBeVisible();
});
