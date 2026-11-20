// ONE FILE, SEVERAL PARTS: THE "WHICH PART" SWITCH IN THE DESIGN VIEWER.
//
// Founder 2026-11-20: "Can you create a Variable to switch to buck holder?". The CNC PCB holder file
// makes three prints (fleet_parts.yaml: board = "skr_pi" | "bucks" | "hbs57_usb6"); the card built only
// skr_pi, and that is what went to the printer. Asserted in the TARGET tab: the 3d tab must receive the
// bucks part, named as such, not the default under a new label.

import { expect, test } from '@playwright/test';
import { seedTab } from './tab';

const ID = '2bee-cnc-table-cnc-pcb-holder-3d';

test('the CNC PCB holder offers its three parts; "bucks" rebuilds and is what reaches the 3d tab', async ({ page }) => {
  await seedTab(page, 'shop');
  await page.goto('/');
  await page.getByTestId('shop-search').fill('CNC PCB holder');
  await page.getByRole('button', { name: /^View CNC PCB holder in 3D$/ }).click();
  const dlg = page.getByTestId('design-viewer');
  await expect(dlg).toBeVisible();
  const sw = dlg.getByTestId('design-viewer-variants');
  await expect(sw).toContainText('This file makes 3 parts');
  // The file as committed is the bucks holder (founder 2026-11-20: "make the app default to bucks
  // variant"): that button is the pressed one. Switch away and back so the rebuild path still runs.
  await expect(sw.getByTestId('design-viewer-variant-cnc_pcb_holder_bucks')).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
  await sw.getByTestId('design-viewer-variant-cnc_pcb_holder_skr_pi').click();
  await expect(sw.getByTestId('design-viewer-variant-cnc_pcb_holder_skr_pi')).toHaveAttribute('aria-pressed', 'true');
  await expect(dlg.getByTestId('param-board')).toHaveValue('skr_pi');
  await sw.getByTestId('design-viewer-variant-cnc_pcb_holder_bucks').click();
  await expect(sw.getByTestId('design-viewer-variant-cnc_pcb_holder_bucks')).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByTestId('design-viewer-variant-cnc_pcb_holder_skr_pi')).toHaveAttribute('aria-pressed', 'false');
  // The variable the switch wrote is the one the Variables panel shows.
  await expect(dlg.getByTestId('param-board')).toHaveValue('bucks');
  await expect(dlg.getByTestId('design-viewer-open-3d')).toHaveText('3D print (bucks)');
  await dlg.getByTestId('design-viewer-open-3d').click();
  await expect(page.getByTestId('design-viewer')).toHaveCount(0, { timeout: 120_000 });
  await page.getByTestId('tab-print3d').click();
  await expect(page.getByTestId('tabpanel-print3d').getByTestId('p3d-incoming')).toContainText('CNC PCB holder (cnc_pcb_holder_bucks)', { timeout: 30_000 });
  void ID;
});
