// The tool picker's preview is a 3D solid (founder 2026-10-15: "in the tool
// list show the preview not a drawing but a 3d object"). This checks the
// preview holds a <canvas>, that the canvas has actually been drawn into (not a
// blank rectangle), and that the same is true for work holding.
//
// NOT checked: that the solid looks right. That is a screenshot, looked at.
import { expect, test, type Locator } from '@playwright/test';
import { seedTab } from './tab';

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

/** Opaque pixels in the canvas — 0 means nothing was drawn. */
async function inked(canvas: Locator): Promise<number> {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return 0;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

test('tool picker preview is a drawn 3D canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tool-picker-trigger')).toContainText('End Mill', { timeout: 30_000 });
  await page.getByTestId('tool-picker-trigger').click();
  const shape = page.getByTestId('tool-picker-shape');
  await expect(shape).toBeVisible();
  const canvas = shape.locator('canvas');
  await expect(canvas).toHaveCount(1, { timeout: 15_000 });
  await expect(canvas).toHaveAttribute('aria-label', /Ø/);
  await expect.poll(() => inked(canvas), { timeout: 10_000 }).toBeGreaterThan(500);
  // The flat drawing is not also on the panel.
  await expect(shape.locator('svg[data-tool-shape]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('tool-picker-3d.png') });

  // A V-bit, for the tip.
  await page.getByTestId('tool-picker-search').fill('V-Bit');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => inked(shape.locator('canvas')), { timeout: 10_000 }).toBeGreaterThan(200);
  await page.waitForTimeout(800);
  await shape.screenshot({ path: test.info().outputPath('tool-picker-3d-vbit.png') });
});

test('work holding picker preview is a drawn 3D canvas with the drawing caption', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tool-picker-trigger')).toContainText('End Mill', { timeout: 30_000 });
  const trigger = page.getByTestId('workholding-picker-trigger');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const shape = page.getByTestId('workholding-picker-shape');
  await expect(shape).toBeVisible();
  const canvas = shape.locator('canvas');
  await expect(canvas).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => inked(canvas), { timeout: 10_000 }).toBeGreaterThan(500);
  await expect(shape.locator('.t3d-cap')).toContainText(/spoilboard|stock|workpiece|spindle/i);
  await page.waitForTimeout(800);
  await shape.screenshot({ path: test.info().outputPath('workholding-3d.png') });
});
