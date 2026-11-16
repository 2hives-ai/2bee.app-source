/**
 * 2bee.pnp gates column (src/pnp/pnpGates.ts + gates/GatesPanel.tsx): the gates
 * read the real outlet board, "Fix with AI" changes the trays only through the
 * tab's own check, and the physical gate is cleared only by a person's click.
 */
import { test, expect } from '@playwright/test';
import { seedTab } from './tab';

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'pnp');
  await page.addInitScript(() => {
    window.localStorage.setItem('2bee.app.pnp.view', 'chat');
    window.localStorage.setItem('2bee.app.pnp.machine', 'diy-dual-y');
  });
});

test('pnp gates: outlet on the default trays fails the tray gate; Fix sets trays from the plan; a person confirms loading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('gates-panel')).toBeVisible();
  await expect(page.getByTestId('gate-board')).toHaveAttribute('data-state', 'FAIL'); // no board chosen
  await page.getByTestId('pnp-board-item-outlet').click();
  await expect(page.getByTestId('gate-board')).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('gate-machine')).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('gate-travel')).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('gate-hand')).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('gate-trays')).toHaveAttribute('data-state', 'FAIL');
  await expect(page.getByTestId('gate-loaded')).toHaveAttribute('data-state', 'FAIL');

  await page.getByTestId('gates-fix').click();
  await expect(page.getByTestId('gates-fix-notes')).toContainText('Trays');
  // outlet needs a 16 mm tray: the plan's own need adds it, and the plan passes its own check.
  await expect(page.getByTestId('gate-trays')).toHaveAttribute('data-state', 'PASS');
  await expect(page.getByTestId('pnp-plan-verdict')).toContainText('OK');
  await expect(page.getByTestId('gates-fix-notes')).toContainText('only a person at the machine');
  await expect(page.getByTestId('gate-loaded')).toHaveAttribute('data-state', 'FAIL'); // never set by Fix

  await page.getByTestId('gate-loaded-action').click();
  await expect(page.getByTestId('gate-loaded')).toHaveAttribute('data-state', 'PASS');

  // A machine with no stated travel fails the machine gate and leaves travel unchecked.
  await page.getByTestId('pnp-machine-select').selectOption('lumenpnp-v4');
  await expect(page.getByTestId('gate-machine')).toHaveAttribute('data-state', 'FAIL');
  await expect(page.getByTestId('gate-travel')).toHaveAttribute('data-state', 'PENDING');
  await expect(page.getByTestId('gate-loaded')).toHaveAttribute('data-state', 'FAIL'); // a different job: asked again
});
