/*
 * 2bee.cad — the code column can be hidden (founder 2026-10-12: "add ability to
 * hide/collapse the left sidebar"). Asserted on what the operator SEES: the
 * column is gone, the 3D view got wider, the code is still there afterwards,
 * and the hide survives a reload.
 */
import { test, expect } from '@playwright/test';
import { seedTab, seedCadCode } from './tab';

/* 2bee.cad opens on the chat view since 2026-10-15; these tests drive its code view. */
test.beforeEach(async ({ page }) => seedCadCode(page));

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cad');
});

test('Hide code takes the editor off screen, widens the view, and keeps the code', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-cad').click();
  const source = page.getByTestId('cad-source');
  const column = page.getByTestId('cad-editor-column');
  const view = page.getByTestId('cad-preview');
  await expect(source).toBeVisible();
  await source.fill('cube(12);');
  const before = (await view.boundingBox())!.width;

  await page.getByTestId('cad-editor-toggle').click();
  await expect(column).toBeHidden();
  await expect(page.getByTestId('cad-split-main')).toHaveCount(0);
  await expect.poll(async () => (await view.boundingBox())!.width).toBeGreaterThan(before * 1.3);

  // Shown again: the same text, because the editor was never unmounted.
  await page.getByTestId('cad-editor-toggle').click();
  await expect(source).toBeVisible();
  await expect(source).toHaveValue(/cube\(12\)/);

  // The CHOICE persists across a reload (the layout is stored; the unsaved
  // source is a different store with its own rules, and not this test's).
  await page.getByTestId('cad-editor-toggle').click();
  await page.reload();
  await page.getByTestId('tab-cad').click();
  await expect(page.getByTestId('cad-preview')).toBeVisible();
  await expect(page.getByTestId('cad-editor-column')).toBeHidden();
});
