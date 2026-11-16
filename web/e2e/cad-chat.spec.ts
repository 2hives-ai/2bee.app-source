/*
 * 2bee.cad — the chat view (founder 2026-10-15: "2bee.cad should be only a chat
 * interface and a 3d visualization, no menus, nothing else right now, may be a
 * save button?").
 *
 * The model endpoint is answered by `page.route`, so nothing leaves the
 * machine. Asserted on what the user SEES: no menu bar and no editor, a chat
 * request changes the 3D model's size, Undo puts it back, and Save stores it.
 */
import { test, expect } from '@playwright/test';
import { seedTab } from './tab';

const ENDPOINT = 'http://127.0.0.1:9/v1/chat/completions';
const TALLER = 'cube([30, 20, 60]);\n';

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cad');
  await page.addInitScript(
    ([endpoint]) => {
      window.localStorage.setItem('2bee.app.cad.view', 'chat');
      window.localStorage.setItem(
        '2bee.app.cad.session',
        JSON.stringify({ v: 1, src: 'cube([30, 20, 10]);\n', baseline: '', savedName: null, undoStep: null, camera: null }),
      );
      window.localStorage.setItem(
        '2bee.app.cad.ask',
        JSON.stringify({ endpoint, model: 'test', apiKey: 'k', rememberKey: true, timeoutMs: 20000 }),
      );
    },
    [ENDPOINT],
  );
  await page.route(ENDPOINT, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```openscad\n' + TALLER + '```' } }] }),
    }),
  );
});

test('chat view: no menus, a request changes the model, Undo puts it back, Save stores it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-cad').click();
  await expect(page.getByTestId('cad-chat')).toBeVisible();
  await expect(page.getByTestId('cad-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('cad-source')).toHaveCount(0);
  await expect(page.getByTestId('cad-preview-canvas')).toBeVisible();

  await page.getByTestId('cad-chat-prompt').fill('make it 60 mm tall');
  await page.getByTestId('cad-chat-send').click();
  const reply = page.getByTestId('cad-chat-reply').last();
  await expect(reply).toContainText('Now 30 × 20 × 60 mm');

  await page.getByTestId('cad-chat-undo').click();
  await expect(reply).toContainText('Back to 30 × 20 × 10 mm');

  await page.getByTestId('cad-save').click();
  await page.getByTestId('cad-quick-save-name').fill('chat test block');
  await page.getByTestId('cad-quick-save-go').click();
  await expect(page.locator('.cad-simple-bar')).toContainText('Saved · chat test block');
  // Founder 2026-11-13: Save stores the 3D view as the design's picture, so the
  // Mine card on the design page shows it without a separate "Save thumbnail".
  const thumb = await page.evaluate(() => localStorage.getItem('2bee.app.thumb.chat test block'));
  expect(thumb).toContain('data:image/png');
});
