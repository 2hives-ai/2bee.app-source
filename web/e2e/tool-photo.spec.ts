/*
 * cnc.tools — the tool assistant (founder 2026-10-15: *"able to photo the tool
 * and ai should recognise it"*, then *"cnc.tools is the same (ai is on the left
 * side, and user should able to add/phot a new tool"*).
 *
 * The AI endpoint is FAKED with page.route — no network, no model. Watched:
 * the layout is chat-left / tool-right (`.cad-simple`); a photo leaves as an
 * image_url data URL (JPEG, resized in the browser); words alone leave as text
 * with no image; the reply FILLS the add form with each AI field marked; the
 * unreadable fields are named; the measure-before-use warning is on screen; a
 * follow-up sends the form as it stands; and NOTHING is registered until
 * Register is pressed — after which the photo the AI saw is the cutter's.
 * 🔴 NOT watched: a real camera (setInputFiles stands in for it), a real model
 * reading a real cutter.
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import { seedTab } from './tab';

const ENDPOINT = 'http://ask.fake.invalid/v1/chat/completions';
// An 8×8 PNG written by PIL. Small, but real: createImageBitmap must decode it.
// (A hand-typed one failed to decode here — the page then said "The photo could
// not be read" and sent nothing, which is the right refusal for a bad file.)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGM8UaHBgA0wYRUdtBIAHicBeAYWg8oAAAAASUVORK5CYII=', 'base64');

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'tools');
  await page.addInitScript(
    ([endpoint]) => {
      localStorage.setItem('2bee.app.cad.ask', JSON.stringify({ endpoint, model: 'claude-sonnet', apiKey: 'k', rememberKey: true, timeoutMs: 20000 }));
    },
    [ENDPOINT],
  );
});

/** Answer every POST with the next reply in `replies` (the last one repeats). */
async function answerWith(page: Page, ...replies: Record<string, unknown>[]): Promise<Request[]> {
  const seen: Request[] = [];
  await page.route(ENDPOINT, (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
    }
    seen.push(route.request());
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
    });
  });
  return seen;
}

async function open(page: Page) {
  await page.goto('/');
  const panel = page.locator('#tabpanel-tools');
  await expect(panel.getByTestId('tools-tab')).toBeVisible();
  return panel;
}

const MILL = {
  type: 'End Mill',
  diameter_mm: 6,
  flutes: 2,
  cutting_length_mm: 22,
  shank_mm: 6,
  overall_length_mm: null,
  included_angle_deg: null,
  flute_type: 'up-cut',
  material: 'carbide',
  confidence: 'medium',
  unreadable: ['overall_length_mm: no scale in the photo'],
  notes: '6 printed on the shank',
};

test('chat on the left, tool view on the right', async ({ page }) => {
  const panel = await open(page);
  const chat = panel.getByTestId('tools-chat');
  const view = panel.getByTestId('tools-view');
  await expect(chat).toBeVisible();
  await expect(view).toBeVisible();
  const c = (await chat.boundingBox())!;
  const v = (await view.boundingBox())!;
  expect(c.x + c.width).toBeLessThanOrEqual(v.x + 1);
});

test('a photo fills the form, nothing is registered until Register, then the photo is kept', async ({ page }) => {
  const seen = await answerWith(page, MILL);
  const panel = await open(page);
  const rows = panel.getByTestId('tool-row');
  await expect(rows).toHaveCount(0);

  await panel.getByTestId('tool-photo-input').setInputFiles({ name: 'cutter.png', mimeType: 'image/png', buffer: PNG });
  await expect(panel.getByTestId('tool-photo-attached')).toBeVisible();
  await panel.getByTestId('tools-chat-send').click();
  await expect(panel.getByTestId('tools-chat-reply')).toBeVisible();

  // What left: one POST, the photo as a JPEG data URL in an image_url part.
  expect(seen).toHaveLength(1);
  const body = seen[0].postDataJSON();
  expect(body.model).toBe('claude-sonnet');
  const parts = body.messages[1].content as { type: string; image_url?: { url: string } }[];
  expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
  expect(parts[1].image_url!.url).toMatch(/^data:image\/jpeg;base64,/);

  // The form is filled, each AI value marked, the gap named, the warning shown.
  await expect(panel.getByTestId('tool-field-type')).toHaveValue('End Mill');
  await expect(panel.getByTestId('tool-field-diameter_mm')).toHaveValue('6');
  await expect(panel.getByTestId('tool-field-flutes')).toHaveValue('2');
  await expect(panel.getByTestId('tool-field-overall_length_mm')).toHaveValue('');
  await expect(panel.getByTestId('ai-filled-diameter_mm')).toBeVisible();
  await expect(panel.getByTestId('tool-photo-unread')).toContainText('Overall length');
  await expect(panel.getByTestId('tool-photo-unread')).toContainText('no scale in the photo');
  await expect(panel.getByTestId('tool-photo-safety')).toContainText('Measure the diameter');
  await expect(panel.getByTestId('tool-photo-confidence')).toHaveText('medium');
  // The tool view shows the cutter being added, with the photo.
  await expect(panel.getByTestId('tools-view')).toContainText('not registered');
  await expect(panel.getByTestId('tools-view').locator('img')).toBeVisible();

  // 🔴 Not registered by the AI.
  await expect(rows).toHaveCount(0);

  // The human corrects one value (the mark goes) and registers.
  await panel.getByTestId('tool-field-diameter_mm').fill('6.35');
  await expect(panel.getByTestId('ai-filled-diameter_mm')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Register' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('6.35 mm');
  await expect(rows.first().locator('img')).toBeVisible();
});

test('words alone: no image leaves; a follow-up sends the form as it stands', async ({ page }) => {
  const seen = await answerWith(page, { ...MILL, flutes: null, unreadable: ['flutes: not stated'] }, { ...MILL, flutes: 3 });
  const panel = await open(page);
  const prompt = panel.getByTestId('tools-chat-prompt');
  await prompt.fill('6 mm up-cut carbide end mill, 22 mm cutting length');
  await prompt.press('Enter');
  await expect(panel.getByTestId('tool-field-diameter_mm')).toHaveValue('6');
  await expect(panel.getByTestId('tool-field-flutes')).toHaveValue('');
  const first = seen[0].postDataJSON().messages[1].content as { type: string; text: string }[];
  expect(first.map((p) => p.type)).toEqual(['text']);
  expect(first[0].text).toContain('Operator: 6 mm up-cut carbide end mill');

  await prompt.fill('it has 3 flutes');
  await prompt.press('Enter');
  await expect(panel.getByTestId('tool-field-flutes')).toHaveValue('3');
  await expect(panel.getByTestId('ai-filled-flutes')).toBeVisible();
  const second = seen[1].postDataJSON().messages[1].content as { type: string; text: string }[];
  expect(second[0].text).toContain('Current form values: type="End Mill", diameter_mm="6"');
  await expect(panel.getByTestId('tool-row')).toHaveCount(0);
});

test('a reply without a diameter fills the rest, and Register refuses naming the diameter', async ({ page }) => {
  await answerWith(page, { type: 'V-Bit', diameter_mm: null, included_angle_deg: 60, flutes: 1, confidence: 'low', unreadable: ['diameter_mm: no scale'] });
  const panel = await open(page);
  await panel.getByTestId('tool-photo-input').setInputFiles({ name: 'v.png', mimeType: 'image/png', buffer: PNG });
  await panel.getByTestId('tools-chat-send').click();
  await expect(panel.getByTestId('tool-field-type')).toHaveValue('V-Bit');
  await expect(panel.getByTestId('tool-field-included_angle_deg')).toHaveValue('60');
  await expect(panel.getByTestId('tool-field-diameter_mm')).toHaveValue('');
  await panel.getByRole('button', { name: 'Register' }).click();
  await expect(panel.getByText('Not registered — fix the fields marked below.')).toBeVisible();
  await expect(panel.getByText(/Cutting diameter is missing/).first()).toBeVisible();
  await expect(panel.getByTestId('tool-row')).toHaveCount(0);
});

test('an endpoint refusal leaves the form unchanged and says why', async ({ page }) => {
  await page.route(ENDPOINT, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'missing or wrong bearer token' } }) }),
  );
  const panel = await open(page);
  await panel.getByTestId('tool-photo-input').setInputFiles({ name: 'c.png', mimeType: 'image/png', buffer: PNG });
  await panel.getByTestId('tools-chat-send').click();
  const reply = panel.getByTestId('tools-chat-reply');
  await expect(reply).toContainText('HTTP 401');
  await expect(reply).toContainText('The form is unchanged.');
  await expect(panel.getByTestId('tool-field-type')).toHaveCount(0);
});
