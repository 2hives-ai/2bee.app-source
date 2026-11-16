/*
 * 2bee.cnc "Ask a model" — founder 2026-10-12, option (B). The endpoint is
 * FAKED with page.route, so this tests OUR half end to end: the request leaves,
 * the reply is read, the CORE re-plans the candidate, and Apply changes the
 * same field the Operation panel shows. Nothing is sent off the box.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedTab } from './tab';

const ENDPOINT = 'http://ask.fake.invalid/v1/chat/completions';

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
  await page.addInitScript(
    ([endpoint]) => {
      localStorage.setItem(
        '2bee.app.cad.ask',
        JSON.stringify({ endpoint, model: 'fake', apiKey: 'k', rememberKey: true, timeoutMs: 20000 }),
      );
    },
    [ENDPOINT],
  );
});

async function answer(page: Page, content: string) {
  await page.route(ENDPOINT, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ choices: [{ message: { content } }] }),
    }),
  );
}

async function openAsk(page: Page) {
  // `?fixtures=1` plans a shipped gate fixture, so there is a real job and a
  // real plan to change without loading a drawing.
  await page.goto('/?fixtures=1');
  await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
  // The fixture refuses while a probe is required after a tool change; this
  // is how slicer.spec reaches a runnable job (`readyRunnable`).
  await page.getByTestId('probe-after-change').uncheck();
  await expect(page.getByTestId('status')).toHaveText('runnable');
  const head = page.getByTestId('panel-ask').locator('.panel-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(page.getByTestId('cnc-ask')).toBeVisible();
}

test('a proposal the core ACCEPTS is shown as a diff and Apply sets the field', async ({ page }) => {
  await answer(page, JSON.stringify({ changes: { depth_per_pass_mm: 1.5 }, why: 'shallower passes' }));
  await openAsk(page);
  const depth = page.getByTestId('depth-per-pass');
  const before = await depth.inputValue();
  expect(Number(before)).not.toBe(1.5);

  await page.getByTestId('cnc-ask-prompt').fill('take shallower passes');
  await page.getByTestId('cnc-ask-send').click();
  await expect(page.getByTestId('cnc-ask-diff')).toContainText('Depth per pass');
  await expect(page.getByTestId('cnc-ask-candidate')).toContainText('The core accepts it', { timeout: 30_000 });
  await page.getByTestId('cnc-ask-apply').click();
  await expect(page.getByTestId('cnc-ask-applied')).toBeVisible();
  await expect(depth).toHaveValue(/^1\.50?$/);
});

test('🔴 a proposal the core REFUSES has no Apply, and the job is untouched', async ({ page }) => {
  // Helix is offered by the Operation panel and refused by the core as unimplemented.
  await answer(page, JSON.stringify({ changes: { entry: 'Helix' }, why: 'helical entry' }));
  await openAsk(page);
  const entry = page.getByTestId('entry');
  const before = await entry.inputValue();
  await page.getByTestId('cnc-ask-prompt').fill('use a helix');
  await page.getByTestId('cnc-ask-send').click();
  await expect(page.getByTestId('cnc-ask-candidate-refusals')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cnc-ask-apply')).toHaveCount(0);
  await expect(entry).toHaveValue(before);
});

test('🔴 a proposal touching a FACT is refused before anything is planned', async ({ page }) => {
  await answer(page, JSON.stringify({ changes: { thickness_mm: 30 }, why: 'thicker' }));
  await openAsk(page);
  await page.getByTestId('cnc-ask-prompt').fill('pretend the board is thicker');
  await page.getByTestId('cnc-ask-send').click();
  await expect(page.getByTestId('cnc-ask-refused')).toContainText('"thickness_mm" may not be changed');
  await expect(page.getByTestId('cnc-ask-proposal')).toHaveCount(0);
});
