/* The PnP tab drives `src/pnp/manifest.ts` in the shipped build. The rules are
 * unit-tested in `tests/pnp-manifest.test.ts`; THIS spec proves the tab reaches
 * them and shows the verdict, the refusal and the warning — not that the module
 * is right, which a browser test is the wrong instrument for. */

import { test, expect } from '@playwright/test';
import { seedTab } from './tab';

const BOM = [
  'Reference,Qty,Value,Package,Manufacturer,Mfr_PN,LCSC_PN,Note,DNP,Consigned',
  '"R1,R2,R3,R4,R5,R6,R7,R8,R9",9,100k,R0402,M,0402WGF1003TCE,,,,',
  'C1,1,100nF,C0603,M,PN-C,,,,',
].join('\n');
const CPL = [
  'Ref,Val,Package,PosX,PosY,Rot,Side',
  ...Array.from({ length: 9 }, (_, i) => `R${i + 1},100k,R0402,${i},0,0,top`),
  'C1,100nF,C0603,0,1,0,top',
].join('\n');
const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

test('pnp tab: reads cad’s tray spec, refuses a shortfall by name, plans the lanes', async ({ page }) => {
  await seedTab(page, 'pnp');
  // The upload pre-flight is the EXPERT view since 2026-10-15 (the default is the
  // chat + board + machine view, `pnp-chat.spec.ts`).
  await page.goto('/?pnp=expert');
  await expect(page.getByTestId('pnp-tab')).toBeVisible();
  await expect(page.getByTestId('pnp-verdict')).toHaveCount(0);

  await page.getByTestId('pnp-bom').setInputFiles(file('bom.csv', BOM));
  await page.getByTestId('pnp-cpl').setInputFiles(file('cpl.csv', CPL));
  // 9 x 60 = 540 parts; the default 0402 tray holds 12 lanes x 44 = 528 — the 44
  // comes from cad's JSON, so this also proves the bundle carries that file.
  await page.getByTestId('pnp-boards').fill('60');

  await expect(page.getByTestId('pnp-verdict')).toContainText('REFUSED');
  await expect(page.getByTestId('pnp-verdict')).toContainText('placed 2 lines / 10 parts per board');
  await expect(page.getByTestId('pnp-refusals')).toContainText('need 540, 12 lane(s) free hold 528');
  await expect(page.getByTestId('pnp-refusals')).toContainText('short 12');

  // Three boards: 27 parts, one lane, usable.
  await page.getByTestId('pnp-boards').fill('3');
  await expect(page.getByTestId('pnp-verdict')).toContainText('MANIFEST OK');
  await expect(page.getByTestId('pnp-lanes')).toContainText('0402WGF1003TCE');
  await expect(page.getByTestId('pnp-lanes-needed')).toContainText('0402 1 lane(s) = 1 tray(s)');
});
