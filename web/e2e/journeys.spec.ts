/*
 * USER JOURNEYS through the three-step screen (founder 2026-10-14: "review the
 * user journeys and test them").
 *
 *   J1  Print: pick a 3D part → Change (no AI) → Make → printer checklist → Send held.
 *   J2  Cut:   pick a CNC part → … → workpiece line in the checklist → Send held.
 *   J3  AI change: with AI set up (as 2bee.cad stores it), ask for a change; the
 *       model's reply is reviewed and applied; Make says it includes the change;
 *       "Put it back" restores the original. The model is a STUB served on this
 *       origin — no real model is called.
 *   J4  Way back: the step bar returns to earlier steps; "Pick another design".
 *   J5  Expert and back, and a reload lands on the same view.
 *   J6  J1 at phone size (390×844, touch) — no sideways scroll on any step.
 *   J8  Print job: tap a question chip → its line; ask the AI (STUB) and get a reply
 *       carrying an off-list key and a G-code key → both shown REFUSED, only the
 *       valid key applied; Make shows the job summary; Send held.
 *
 * 🔴 NOT covered: a real model, a real send (there is none), Safari/WebKit (run
 * separately on the Mac), and the router journey (e2e/journey-router.spec.ts).
 */
import { expect, test, type Page } from '@playwright/test';

const ASK_KEY = '2bee.app.cad.ask';
const STUB = '/__ai-stub/v1/chat/completions';

async function firstOf(page: Page, kind: '3D print' | 'CNC cut') {
  const cards = page.getByTestId('make-designs').locator('li').filter({ hasText: kind });
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  return cards.first();
}

async function noSidewaysScroll(page: Page, where: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${where}: page scrolls sideways by ${over}px`).toBeLessThanOrEqual(1);
}

test('J1 print: design → make, printer checklist, Send held with its reason', async ({ page }) => {
  await page.goto('/');
  await (await firstOf(page, '3D print')).locator('button').click();
  await expect(page.getByTestId('make-ai-off')).toBeVisible();
  await page.getByTestId('make-next').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bambu Lab X2D printer');
  await expect(page.getByTestId('make-checklist')).toContainText('Clean the build plate');
  await expect(page.getByTestId('make-send')).toBeDisabled();
  await expect(page.getByTestId('make-send-blocked')).toContainText('2bee.fdm');
  await expect(page.getByTestId('make-send-blocked')).not.toContainText('OrcaSlicer');
});

test('J2 cut: design → make, workpiece from the design, Send held', async ({ page }) => {
  await page.goto('/');
  await (await firstOf(page, 'CNC cut')).locator('button').click();
  await page.getByTestId('make-next').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2bee CNC router');
  // No cutters registered on a fresh browser: nothing is planned, and it says where to register.
  await expect(page.getByTestId('make-plan-none')).toContainText('Tools', { timeout: 60_000 });
  await expect(page.getByTestId('make-checklist')).toContainText(/Put in the workpiece: [\d.]+ mm thick/);
  await expect(page.getByTestId('make-send')).toBeDisabled();
});

test('J3 AI change: reviewed, applied, carried to Make, and put back', async ({ page }) => {
  let source = '';
  let asked = 0;
  await page.route(`**${STUB}`, async (route) => {
    asked++;
    const changed = `${source}\n// changed by the stub\ntranslate([0, 0, 40]) cube(5);\n`;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '```openscad\n' + changed + '```' } }] }),
    });
  });
  await page.addInitScript(
    ([key, endpoint]) => {
      localStorage.setItem(key, JSON.stringify({ endpoint: location.origin + endpoint, model: 'stub', rememberKey: true, apiKey: 'stub-key', timeoutMs: 20000 }));
    },
    [ASK_KEY, STUB] as const,
  );
  await page.goto('/');
  const card = await firstOf(page, '3D print');
  const id = (await card.locator('button').getAttribute('data-testid'))!.replace('make-design-', '');
  source = await page.evaluate(async (i) => {
    const d = await (await fetch(`shop/d/${i}.json`)).json();
    return d.sources[d.path] as string;
  }, id);
  await card.locator('button').click();

  const box = page.getByTestId('make-prompt');
  await expect(box, 'AI is set up, so the Change step must offer the box').toBeVisible();
  await box.fill('add a small block on top');
  await box.press('Enter');
  await expect(page.getByText('Asked: “add a small block on top”')).toBeVisible({ timeout: 30_000 });
  expect(asked).toBe(1);
  await expect(page.getByTestId('make-change-summary')).toContainText('Changed.');

  await page.getByTestId('make-next').click();
  await expect(page.getByText('Includes your AI change.')).toBeVisible();

  // Back to Change and put it back: Make must no longer claim the change.
  await page.getByRole('button', { name: '2. Change' }).click();
  await page.getByTestId('make-undo').click();
  await page.getByTestId('make-next').click();
  await expect(page.getByText('Includes your AI change.')).toHaveCount(0);
});

/* Shared by J3b/J3c: AI set up with the stub, a 3D design picked, its source returned. */
async function aiOnFirstPrint(page: Page, reply: (asked: number, source: string) => Promise<string>) {
  const st = { source: '', asked: 0 };
  await page.route(`**${STUB}`, async (route) => {
    st.asked++;
    const scad = await reply(st.asked, st.source);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '```openscad\n' + scad + '```' } }] }),
    });
  });
  await page.addInitScript(
    ([key, endpoint]) => {
      localStorage.setItem(key, JSON.stringify({ endpoint: location.origin + endpoint, model: 'stub', rememberKey: true, apiKey: 'stub-key', timeoutMs: 20000 }));
    },
    [ASK_KEY, STUB] as const,
  );
  await page.goto('/');
  const card = await firstOf(page, '3D print');
  const id = (await card.locator('button').getAttribute('data-testid'))!.replace('make-design-', '');
  st.source = await page.evaluate(async (i) => {
    const d = await (await fetch(`shop/d/${i}.json`)).json();
    return d.sources[d.path] as string;
  }, id);
  await card.locator('button').click();
  return st;
}

async function ask(page: Page, text: string) {
  const box = page.getByTestId('make-prompt');
  await box.fill(text);
  await box.press('Enter');
}

test('J3b Undo while the model is working: its reply is NOT applied over the Undo (bughunt 2026-11-15)', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const S1 = (src: string) => `${src}\n// change 1\ntranslate([0, 0, 40]) cube(5);\n`;
  await aiOnFirstPrint(page, async (n, src) => {
    if (n === 1) return S1(src);
    await held;
    return `${S1(src)}// change 2\ntranslate([0, 0, 50]) cube(3);\n`;
  });
  await ask(page, 'first change');
  await expect(page.getByTestId('make-change-summary')).toContainText('Changed.', { timeout: 30_000 });
  await ask(page, 'second change');
  await page.getByTestId('make-undo').click();
  release();
  await expect(page.getByTestId('make-ask-failure')).toContainText('changed while the AI was working', { timeout: 30_000 });
  await page.getByTestId('make-next').click();
  await expect(page.getByText('Includes your AI change.'), 'the undone change came back with the late reply').toHaveCount(0);
});

test('J3c a refused second ask keeps the applied change, its Undo and its record (bughunt 2026-11-15)', async ({ page }) => {
  let applied = '';
  await aiOnFirstPrint(page, async (n, src) => {
    if (n === 1) applied = `${src}\n// change 1\ntranslate([0, 0, 40]) cube(5);\n`;
    return applied; // the second reply changes nothing: refused as 'unchanged'
  });
  await ask(page, 'first change');
  await expect(page.getByTestId('make-change-summary')).toContainText('Changed.', { timeout: 30_000 });
  await ask(page, 'second change');
  await expect(page.getByTestId('make-ask-failure')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('make-undo'), 'the refused ask threw away the Undo of the change still in the source').toBeVisible();
  await expect(page.getByText('Asked: “first change”')).toBeVisible();
});

test('J3d ticks made for one design do not carry over to an AI-changed design (bughunt 2026-11-15)', async ({ page }) => {
  await aiOnFirstPrint(page, async (_n, src) => `${src}\n// change 1\ntranslate([0, 0, 40]) cube(5);\n`);
  await page.getByTestId('make-next').click();
  const boxes = page.getByTestId('make-checklist').getByRole('checkbox');
  const n = await boxes.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await page.getByRole('button', { name: '2. Change' }).click();
  await ask(page, 'first change');
  await expect(page.getByTestId('make-change-summary')).toContainText('Changed.', { timeout: 30_000 });
  await page.getByTestId('make-next').click();
  await expect(page.getByText('Includes your AI change.')).toBeVisible();
  const after = page.getByTestId('make-checklist').getByRole('checkbox');
  const m = await after.count();
  for (let i = 0; i < m; i++) await expect(after.nth(i), `line ${i} stayed ticked for a part nobody checked`).not.toBeChecked();
});

test('J4 way back: the step bar and "Pick another design"', async ({ page }) => {
  await page.goto('/');
  await (await firstOf(page, 'CNC cut')).locator('button').click();
  await page.getByTestId('make-next').click();
  await page.getByRole('button', { name: '2. Change' }).click();
  await expect(page.getByTestId('make-next')).toBeVisible();
  await page.getByRole('button', { name: '1. Design' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a design' })).toBeVisible();
  await (await firstOf(page, '3D print')).locator('button').click();
  await page.getByTestId('make-next').click();
  await page.getByRole('button', { name: 'Pick another design' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a design' })).toBeVisible();
});

test('J5 Expert and back; a reload keeps the view', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('make-expert').click();
  await expect(page.getByTestId('tabbar')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('tabbar'), 'Expert view survives a reload').toBeVisible();
  await page.getByTestId('back-to-simple').click();
  await page.reload();
  await expect(page.getByTestId('make-flow'), 'Simple view survives a reload').toBeVisible();
});

test('J7 cut with a registered cutter: the job is planned and the checklist comes from the plan', async ({ page }) => {
  test.setTimeout(180_000);
  const CUTTER = 'End Mill - Down-cut 6mm 2F';
  // Register the cutter the way a person does: Expert tools → Tools → Add → from the list.
  await page.goto('/');
  await page.getByTestId('make-expert').click();
  await page.getByTestId('tab-tools').click();
  const tools = page.locator('#tabpanel-tools');
  await tools.getByRole('button', { name: 'Add', exact: true }).click();
  await tools.getByRole('radio', { name: /From the list/ }).check();
  await tools.getByTestId('object-picker-trigger').click();
  await page.getByTestId(`object-picker-opt-${CUTTER}`).click();
  await tools.getByRole('button', { name: 'Register' }).click();
  await expect(tools.getByTestId('tool-row')).toHaveCount(1);
  await chooseMaterial(page);

  await page.getByTestId('back-to-simple').click();
  await (await firstOf(page, 'CNC cut')).locator('button').click();
  await page.getByTestId('make-next').click();
  const plan = page.getByTestId('make-plan');
  await expect(plan, 'a registered cutter must lead to a planned job (or a refusal from the planner)').toBeVisible({ timeout: 90_000 });
  const refused = (await page.getByTestId('make-plan-refused').count()) > 0;
  console.log(`J7 BRANCH ${refused ? 'refused' : 'planned'}: ${(await plan.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (refused) {
    await expect(page.getByTestId('make-send')).toBeDisabled();
  } else {
    await expect(page.getByTestId('make-checklist')).toContainText(`Fit ${CUTTER} first`);
    await expect(page.getByTestId('make-checklist')).toContainText(/cuts|Hold the parts down/);
    // Facts read off the SAME program (hash-checked): where zero is.
    await expect(page.getByTestId('make-facts-why')).toHaveCount(0);
    await expect(page.getByTestId('make-checklist')).toContainText('Z zero');
  }
  await expect(page.getByTestId('make-checklist')).not.toContainText('Fit the cutter the job names');
});

test('J8 print job: chip and AI settings, validated key by key, carried to Make; Send held', async ({ page }) => {
  const sent: { system: string; user: string }[] = [];
  await page.route(`**${STUB}`, async (route) => {
    const body = route.request().postDataJSON() as { messages: { content: string }[] };
    sent.push({ system: body.messages[0].content, user: body.messages[1].content });
    const content = JSON.stringify({
      reply: 'Four walls for strength.',
      overrides: { wall_loops: 4, make_it_fast: 1, machine_start_gcode: 'G28\nM104 S400' },
      reasons: { wall_loops: 'stronger walls', machine_start_gcode: 'sneaky' },
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await page.addInitScript(
    ([key, endpoint]) => {
      localStorage.setItem(key, JSON.stringify({ endpoint: location.origin + endpoint, model: 'stub', rememberKey: true, apiKey: 'stub-key', timeoutMs: 20000 }));
    },
    [ASK_KEY, STUB] as const,
  );
  await page.goto('/');
  await (await firstOf(page, '3D print')).locator('button').click();

  // 1. A chip: the answer is pressed and its line says what and why.
  const chip = page.getByTestId('print-chip-support-tree');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('print-line').first()).toContainText('Support: Auto tree support — because Thin tree-shaped supports');

  // 2. The AI: the stub's reply carries one valid key, one off-list key and one G-code key.
  const box = page.getByTestId('print-ask');
  await expect(box, 'AI is set up, so the print box must be offered').toBeVisible();
  await box.fill('make it stronger');
  await box.press('Enter');
  await expect(page.getByTestId('print-ai-reply')).toContainText('Four walls', { timeout: 30_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0].system, 'no G-code key name is offered to the model').not.toContain('machine_start_gcode');
  expect(JSON.parse(sent[0].user).user_text).toBe('make it stronger');
  const refused = page.getByTestId('print-refused');
  await expect(refused).toHaveCount(2);
  await expect(refused.filter({ hasText: 'machine_start_gcode' })).toContainText('never allowed');
  await expect(refused.filter({ hasText: 'make_it_fast' })).toContainText('not on the allow-list');
  await expect(page.getByTestId('print-line').nth(1)).toContainText('AI: Wall loops: 4 — because stronger walls');

  // 3. Make: the job summary carries the chip and the valid AI key, and nothing refused.
  await page.getByTestId('make-next').click();
  const summary = page.getByTestId('print-summary');
  await expect(summary).toContainText('Support: on');
  await expect(summary).toContainText('Support type: tree(auto)');
  await expect(summary).toContainText('Wall loops: 4');
  await expect(summary).not.toContainText('machine_start_gcode');
  await expect(summary).not.toContainText('make_it_fast');
  await expect(page.getByTestId('print-job-missing')).toContainText('Pick the filament slot');
  await expect(page.getByTestId('make-send')).toBeDisabled();
  await expect(page.getByTestId('make-send-blocked')).toContainText('this step cannot slice yet');
});

test.describe('J6 phone size', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('J1 at phone size with no sideways scroll on any step', async ({ page }) => {
    await page.goto('/');
    const card = await firstOf(page, '3D print');
    await noSidewaysScroll(page, 'step 1');
    await card.locator('button').tap();
    await expect(page.getByTestId('make-next')).toBeVisible();
    await noSidewaysScroll(page, 'step 2');
    await page.getByTestId('make-next').tap();
    await expect(page.getByTestId('make-checklist')).toBeVisible();
    await noSidewaysScroll(page, 'step 3');
    await expect(page.getByTestId('make-expert')).toBeVisible();
  });
});

/* ── 2bee.cnc and Jobs (src/cncjob/) ─────────────────────────────────────────
 *
 * 🔴 J9's DESIGN IS A TEST FIXTURE SERVED ON THIS ORIGIN, and why: measured
 * 2026-10-15, no design in the shipped catalogue plans with a tool change
 * through the section-import path — every feature of a section is through-cut
 * at one depth, and the planner keeps the first cutter that fits (`recommend.rs`
 * rule 6), so one cutter always does the whole job or the job is refused. A
 * design of TWO separate plates, one with a Ø4.5 hole, makes the 6 mm cutter
 * take the first plate and the 3.175 mm cutter the hole: the core plans it, the
 * grblHAL post writes the real `( TOOL CHANGE -> … )` + `M0`. Only the catalogue
 * entry is stubbed; the plan, the program and the M0 are the core's.
 */
const FIX_ID = 'e2e-two-plates-wcnc';
const FIX_PATH = 'e2e/two_plates_wcnc.scad';
const FIX_SRC =
  'cube([100, 60, 6]);\ntranslate([0, 80, 0]) difference() { cube([60, 40, 6]); translate([30, 20, -1]) cylinder(d = 4.5, h = 8, $fn = 24); }\n';

async function serveFixtureDesign(page: Page) {
  await page.route('**/shop/index.json', async (route) => {
    const res = await route.fetch();
    const idx = await res.json();
    const proto = idx.entries.find((e: { path: string }) => /_wcnc\.scad$/.test(e.path));
    idx.entries.push({ ...proto, id: FIX_ID, path: FIX_PATH, title: 'E2E two plates', thumb: null, sizeMm: [100, 120, 6], trust: 'trusted' });
    await route.fulfill({ response: res, json: idx });
  });
  await page.route(`**/shop/d/${FIX_ID}.json`, (route) =>
    route.fulfill({ json: { id: FIX_ID, path: FIX_PATH, entry: {}, sources: { [FIX_PATH]: FIX_SRC } } }),
  );
}

/** Choose the job's material the way an operator does: Expert tools → 2bee.cnc → Material. Since 2026-11-14 a CNC
 *  plan refuses the store's placeholder material; it plans only on one somebody chose. */
async function chooseMaterial(page: Page, name = 'Plywood') {
  await page.getByTestId('tab-cnc').click();
  await page.getByTestId('material').selectOption(name);
}

async function registerCutters(page: Page, names: string[]) {
  await page.getByTestId('make-expert').click();
  await page.getByTestId('tab-tools').click();
  const tools = page.locator('#tabpanel-tools');
  for (const c of names) {
    await tools.getByRole('button', { name: 'Add', exact: true }).click();
    await tools.getByRole('radio', { name: /From the list/ }).check();
    await tools.getByTestId('object-picker-trigger').click();
    await page.getByTestId(`object-picker-opt-${c}`).click();
    await tools.getByRole('button', { name: 'Register' }).click();
  }
  await expect(tools.getByTestId('tool-row')).toHaveCount(names.length);
  await chooseMaterial(page);
}

async function tick(page: Page, id: string) {
  await expect(page.getByTestId(`cj-tick-${id}`)).toBeEnabled({ timeout: 30_000 });
  // Ticking moves to the next step (a new screen), so this is a click, then a check that it moved.
  await page.getByTestId(`cj-tick-${id}`).click();
  await expect(page.getByTestId(`cj-step-${id}`)).toHaveCount(0);
}

/** Resume through every M0 takeover until the run screen goes away; returns the prompts seen. */
async function runThrough(page: Page): Promise<string[]> {
  const seen: string[] = [];
  const running = page.getByTestId('cj-running');
  await expect(running).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 600; i++) {
    if (!(await running.isVisible())) break;
    const m0 = page.getByTestId('cj-m0');
    if (await m0.isVisible()) {
      const title = (await m0.locator('h2').innerText()).trim();
      seen.push(title);
      await page.getByTestId('cj-resume').click();
      /* Resumed = this stop's takeover is gone. Two M0s a comment apart (a tool change, then "set Z zero by
       * hand" on a machine without a probe) put the NEXT takeover up at once, so "hidden" never happens
       * between them; what must not happen is the SAME stop staying up. */
      await expect
        .poll(async () => ((await m0.isVisible()) ? (await m0.locator('h2').innerText()).trim() : null), { timeout: 10_000 })
        .not.toBe(title);
    }
    await page.waitForTimeout(100);
  }
  await expect(running).toBeHidden();
  return seen;
}

test('J9 2bee.cnc → Jobs on the SIMULATED machine: queue, guided steps, and the CORE-PLANNED program air-cuts to its M0', async ({ page }) => {
  test.setTimeout(300_000);
  const SIX = 'End Mill - Down-cut 6mm 2F';
  const SMALL = 'End Mill - Down-cut 3.175mm 2F';
  await serveFixtureDesign(page);
  await page.goto('/');
  await registerCutters(page, [SIX, SMALL]);

  // Main page: pick the design, read the results line, send. Sending starts nothing.
  await page.getByTestId('open-cncjob').click();
  await expect(page.getByTestId('cj-simulated')).toContainText('SIMULATED');
  await expect(page.getByTestId('cj-state-cnc-sim')).toContainText('controller status');
  await page.getByTestId('cj-add').click();
  await page.getByTestId(`cj-design-${FIX_ID}`).click();
  await expect(page.getByTestId('cj-results')).toContainText('1 tool change', { timeout: 90_000 });
  await expect(page.getByTestId('cj-send-cnc-sim')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('cj-send-cnc-sim').click();
  await expect(page.getByTestId('cj-sent')).toContainText('1 job queued on cnc-sim');
  await expect(page.getByTestId('cj-state-cnc-sim')).not.toContainText('Run');
  const prog = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cncjob.jobs')!).jobs[0].program as { gcode: string; tools: string[] });
  /* 🔴 TWO M0 since 411b33a0f3 (2026-11-15): the import job no longer probes with the reference fixture's plate, so
   * Z is not re-referenced by G38.2 after the swap. The program stops for the cutter and again at once to set Z zero
   * by hand (steps.ts: ONE intervention, two M0). One M0 here would mean a new cutter running on the old one's zero. */
  expect(prog.gcode.split('\n').filter((l) => l.trim() === 'M0'), 'tool change + set Z zero by hand').toHaveLength(2);

  // Jobs page: say what the machine holds and what is in the collet.
  await page.getByTestId('cj-open-jobs').click();
  await page.getByTestId('cj-switch-cnc-sim').click();
  await expect(page.getByTestId('cj-loaded')).not.toContainText('Loaded ✓');
  await page.getByTestId(`cj-holds-${SIX}`).check();
  await page.getByTestId(`cj-holds-${SMALL}`).check();
  await page.getByTestId('cj-collet').selectOption(prog.tools[0]);
  await expect(page.getByTestId('cj-loaded')).toContainText('Loaded ✓');

  await page.locator('[data-testid^="cj-open-job-"]').first().click();
  await tick(page, 'load');
  await tick(page, 'clamp');
  await expect(page.getByTestId('cj-step-cutter')).toContainText(`Fit cutter 1: ${prog.tools[0]}`);
  await tick(page, 'cutter');
  await expect(page.getByTestId('cj-tick-zero'), 'zero cannot be ticked before homing').toBeDisabled();
  await page.getByTestId('cj-home').click();
  await tick(page, 'zero');

  /* 🔴 FIXED 2026-10-15: this journey used to END here, holding the refusal of
   * the core's em dash (post_grblhal.rs:1087) — the sender refuses non-ASCII.
   * The post is now ASCII-only (sanitize + every_reference_program_is_ascii…),
   * so the CORE-PLANNED program now runs its air cut on the simulated machine
   * and stops at its real M0 for cutter 2. */
  expect(prog.gcode.split('').every((c) => c.charCodeAt(0) < 128), 'the core program is pure ASCII').toBe(true);
  await expect(page.getByTestId('cj-jobs').getByTestId('cj-unsendable')).toHaveCount(0);
  await expect(page.getByTestId('cj-run-aircut')).toBeEnabled();
  await page.getByTestId('cj-run-aircut').click();
  const airPrompts = await runThrough(page);
  expect(airPrompts, 'the core M0s: swap to cutter 2, then Z zero by hand').toEqual([
    `Stop. Change cutter: ${prog.tools[0]} → ${prog.tools[1]}, then set Z zero by hand`,
    'Stop. Set Z zero by hand with the new cutter',
  ]);
  await expect(page.getByTestId('cj-step-aircut')).toContainText('Air cut done');
});

/* J9b — the run itself, on a HAND-WRITTEN ASCII program seeded into the queue
 * (NOT planned by the core: see J9 for why the core's program cannot stream
 * today). Everything after the seed is real: the guided steps, the Run tab's
 * sender, the fake grblHAL, the M0 takeover. */
const SEED_TOOLS = ['End Mill - Down-cut 6mm 2F', 'End Mill - Down-cut 3.175mm 2F'];
const SEED_GCODE = [
  '( e2e seeded program )',
  'G17 G21 G90 G54 G94 G40',
  'G0 Z5.000',
  'M3 S18000',
  'G4 P1.00',
  ...Array.from({ length: 40 }, (_, i) => `G1 X${(i * 2).toFixed(3)} Y0.000 Z-1.000 F1200.0`),
  'G0 Z5.000',
  'M5',
  `( TOOL CHANGE -> ${SEED_TOOLS[1]} )`,
  'M0',
  'M3 S18000',
  ...Array.from({ length: 40 }, (_, i) => `G1 X${(i * 2).toFixed(3)} Y10.000 Z-1.000 F1200.0`),
  'G0 Z5.000',
  'M5',
  'M30',
  '',
].join('\n');

test('J9b the SIMULATED run: steps, forced air cut, Start, the M0 tool-change takeover, Resume, done', async ({ page }) => {
  test.setTimeout(240_000);
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(SEED_GCODE).digest('hex');
  const facts = {
    ok: true, mismatches: [], pending: [], tool_changes: 1,
    tools: SEED_TOOLS.map((name, index) => ({ index, name, diameter_mm: index ? 3.175 : 6, in_job_tool_list: true })),
    z_datum: { declared: 'top of the workpiece', source: 'e2e seed' },
    xy_zero: { convention: 'front-left corner', source: 'e2e seed' },
    workpiece: { size_x_mm: 120, size_y_mm: 60, thickness_mm: 6 },
    depth: { deepest_emitted_z_mm: -1, cuts_through: false, into_spoilboard_mm: 0 },
    spindle: { rpm: [18000] },
  };
  const job = {
    id: 'job-e2e-seed', title: 'E2E seeded job', design: { id: '2bee-hive-2bee-hive-cleat-wcnc', title: 'Hive cleat', thumb: null },
    machineId: 'cnc-sim', plan: { config: {}, sectionZ: 3, chosen: [] }, stock: { x: 120, y: 60, t: 6 },
    program: { gcode: SEED_GCODE, sha256: sha, lines: SEED_GCODE.split('\n').length, seconds: 60, tools: SEED_TOOLS, toolChanges: 1, deepestZ: -1, rapidRate: 5000 },
    facts, state: 'queued', phase: null, streamed: false, airCut: null, history: [{ at: 0, who: 'e2e', what: 'seeded' }], createdAt: 0,
  };
  const machines = { version: 1, machines: [{ id: 'cnc-sim', hostname: 'cnc-sim', connection: { kind: 'simulated' }, profile: null, toolIds: SEED_TOOLS, inCollet: SEED_TOOLS[0], addedAt: 0 }] };
  await page.addInitScript(
    ([j, m]) => {
      if (!localStorage.getItem('e2e-seeded')) {
        localStorage.setItem('2bee.app.cncjob.jobs', j);
        localStorage.setItem('2bee.app.cncjob.machines', m);
        localStorage.setItem('2bee.app.tab', 'jobs');
        localStorage.setItem('e2e-seeded', '1');
      }
    },
    [JSON.stringify({ version: 1, jobs: [job] }), JSON.stringify(machines)] as const,
  );
  await page.goto('/');
  await expect(page.getByTestId('cj-jobs')).toBeVisible();
  await expect(page.getByTestId('cj-loaded')).toContainText('Loaded ✓');
  await page.getByTestId('cj-open-job-e2e-seed').click();
  await tick(page, 'load');
  await tick(page, 'clamp');
  await tick(page, 'cutter');
  await page.getByTestId('cj-home').click();
  await tick(page, 'zero');

  // The start screen refuses until the air cut and the last two ticks are done.
  await page.getByRole('button', { name: '7', exact: true }).click();
  await expect(page.getByTestId('cj-start')).toBeDisabled();
  await expect(page.getByTestId('cj-start-blocked')).toContainText('air cut has not been run');
  await page.getByRole('button', { name: '5', exact: true }).click();

  await page.getByTestId('cj-run-aircut').click();
  const airPrompts = await runThrough(page);
  expect(airPrompts, 'the air cut stops at the M0 too').toEqual([`Stop. Fit cutter 2: ${SEED_TOOLS[1]}`]);
  await expect(page.getByTestId('cj-step-aircut')).toContainText('Air cut done');
  // The tool change moved the collet record on; the operator puts cutter 1 back for the cut.
  await page.getByTestId('cj-back').click();
  await expect(page.getByTestId('cj-loaded')).not.toContainText('Loaded ✓');
  await page.getByTestId('cj-collet').selectOption(SEED_TOOLS[0]);
  await page.getByTestId('cj-open-job-e2e-seed').click();
  await page.getByRole('button', { name: '5', exact: true }).click();
  await tick(page, 'aircut');
  await tick(page, 'present');

  await expect(page.getByTestId('cj-step-start')).toContainText('SIMULATED');
  await expect(page.getByTestId('cj-start-blocked')).toHaveCount(0);
  await page.getByTestId('cj-start').click();
  const prompts = await runThrough(page);
  expect(prompts).toEqual([`Stop. Fit cutter 2: ${SEED_TOOLS[1]}`]);

  const after = page.getByTestId('cj-after');
  await expect(after).toBeVisible();
  await expect(page.getByTestId('cj-mark-done')).toBeDisabled();
  for (const box of await after.locator('input[type=checkbox]').all()) await box.check();
  await page.getByTestId('cj-mark-done').click();
  await expect(page.getByTestId('cj-finished')).toContainText('done');
});

test('J10 a non-simulated machine: the job queues, the air cut and Start stay disabled with the e-stop reason', async ({ page }) => {
  test.setTimeout(240_000);
  const SIX = 'End Mill - Down-cut 6mm 2F';
  await page.goto('/');
  await registerCutters(page, [SIX]);
  await page.getByTestId('open-cncjob').click();
  await expect(page.getByTestId('cj-machine-cnc-01')).toContainText('Bridge not built');
  await expect(page.getByTestId('cj-state-cnc-01')).toContainText('controller status: not connected');
  // Plan FOR cnc-01: since 2026-11-14 Send is offered only on the machine the designs were planned for.
  await page.getByTestId('cj-machine-cnc-01').getByRole('button', { name: 'cnc-01', exact: true }).click();
  await page.getByTestId('cj-add').click();
  await page.getByTestId('cj-design-2bee-hive-2bee-hive-cleat-wcnc').click();
  await expect(page.getByTestId('cj-send-cnc-01')).toBeEnabled({ timeout: 90_000 });
  await page.getByTestId('cj-send-cnc-01').click();
  await expect(page.getByTestId('cj-sent')).toContainText('queued on cnc-01');

  await page.getByTestId('cj-open-jobs').click();
  await page.getByTestId('cj-switch-cnc-01').click();
  await page.getByTestId(`cj-holds-${SIX}`).check();
  await page.getByTestId('cj-collet').selectOption(SIX);
  await page.locator('[data-testid^="cj-open-job-"]').first().click();
  for (const s of ['load', 'clamp', 'cutter', 'zero']) await tick(page, s);
  await expect(page.getByTestId('cj-run-aircut')).toBeDisabled();
  await expect(page.getByTestId('cj-blocked')).toContainText('No physical e-stop is installed');
  await expect(page.getByTestId('cj-blocked')).toContainText('H5');
  await page.getByRole('button', { name: '7', exact: true }).click();
  await expect(page.getByTestId('cj-start')).toBeDisabled();
  await expect(page.getByTestId('cj-start-blocked')).toContainText('No physical e-stop is installed (never ordered; firmware ESTOP_ENABLE 0)');
  await expect(page.getByTestId('cj-start-blocked')).toContainText('H5');
});

/* J11: four defects the 2026-10-15 journey test found in the Simple flow, each asserted on what
 * the person sees. */
test('J11 the flow survives Expert tools and the Back button; a too-big part is refused; aluminium is not offered', async ({ page }) => {
  await page.goto('/');
  const designs = page.getByTestId('make-designs');
  await expect(designs.locator('li').first()).toBeVisible({ timeout: 60_000 });
  // `_acnc` is aluminium on a drill press: never a router job here.
  const ids = await designs.locator('[data-testid^="make-design-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(ids.filter((i) => /acnc/.test(i ?? '')), 'an aluminium part is offered as a router job').toEqual([]);

  // Back: step 3 -> step 2 -> step 1, and the page never leaves the app.
  await (await firstOf(page, '3D print')).locator('button').click();
  await page.getByTestId('make-next').click();
  await expect(page.getByTestId('make-checklist')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('make-next'), 'Back from Make lands on Change').toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Pick a design' }), 'Back from Change lands on Design').toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('make-next'), 'Forward returns to Change with the design kept').toBeVisible();

  // Expert tools and back: still on the same step, same design.
  const title = await page.getByRole('heading', { level: 1 }).textContent();
  await page.getByTestId('make-next').click();
  await page.getByTestId('make-expert').click();
  await expect(page.getByTestId('tabbar')).toBeVisible();
  await page.getByTestId('back-to-simple').click();
  await expect(page.getByTestId('make-checklist'), 'Expert and back returns to Make').toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(title ?? '');

  // A part bigger than the X2D is refused in words, and is not a box to tick.
  await page.getByRole('button', { name: 'Pick another design' }).click();
  const excluder = designs.locator('li').filter({ hasText: /queen excluder/i }).first();
  if (await excluder.count()) {
    await excluder.locator('button').click();
    await page.getByTestId('make-next').click();
    await expect(page.getByTestId('make-too-big')).toContainText('does not fit the X2D');
    await expect(page.getByTestId('make-checklist')).not.toContainText('does not fit');
    await expect(page.getByTestId('make-send')).toBeDisabled();
  }
});
