/*
 * cnc.run simple view (src/run/RunSimple.tsx) — founder 2026-10-15: chat on
 * the left, 3D, the full job sequence below it, and a Play button.
 *
 *   RS1  SIMULATED machine: Play is refused until every prepare step is
 *        ticked; Play runs the forced air cut (the LIFTED program, spindle
 *        starts removed) to its M0 tool change; then cutter 1 back, "I am at
 *        the machine", Play runs the cut through its M0, Feed Hold + Resume
 *        work mid-cut, the finish steps, Done.
 *   RS2  a REAL (non-simulated) machine: every step ticked, Play stays off
 *        with the e-stop (ops H5) reason, and nothing streams.
 *
 * Mounted through the DEV-SERVER-ONLY harness `e2e-harness/run-simple.html`
 * because App.tsx is not this lane-agent's file to edit; the component is the
 * same one App.tsx will mount. The job is SEEDED (as J9b does): the run door,
 * the Run tab's sender and the fake grblHAL are all real from there on.
 *
 * 🔴 Nothing moved. "Done" here is the fake grblHAL agreeing with our sender.
 */
import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

const DEV = `http://127.0.0.1:${Number(process.env.E2E_DEV_PORT ?? 5179)}`;
const HARNESS = `${DEV}/e2e-harness/run-simple.html`;
const TOOLS = ['End Mill - Down-cut 6mm 2F', 'End Mill - Down-cut 3.175mm 2F'];
const GCODE = [
  '( e2e seeded program )',
  'G17 G21 G90 G54 G94 G40',
  'G0 Z5.000',
  'M3 S18000',
  'G4 P1.00',
  ...Array.from({ length: 60 }, (_, i) => `G1 X${(i * 2).toFixed(3)} Y0.000 Z-1.000 F1200.0`),
  'G0 Z5.000',
  'M5',
  `( TOOL CHANGE -> ${TOOLS[1]} )`,
  'M0',
  'M3 S18000',
  ...Array.from({ length: 60 }, (_, i) => `G1 X${(i * 2).toFixed(3)} Y10.000 Z-1.000 F1200.0`),
  'G0 Z5.000',
  'M5',
  'M30',
  '',
].join('\n');

function seed(machineId: string) {
  const sha = createHash('sha256').update(GCODE).digest('hex');
  const facts = {
    ok: true, mismatches: [], pending: [], tool_changes: 1,
    tools: TOOLS.map((name, index) => ({ index, name, diameter_mm: index ? 3.175 : 6, in_job_tool_list: true })),
    z_datum: { declared: 'top of the workpiece', source: 'e2e seed' },
    xy_zero: { convention: 'front-left corner', source: 'e2e seed' },
    workpiece: { size_x_mm: 140, size_y_mm: 60, thickness_mm: 6 },
    depth: { deepest_emitted_z_mm: -1, cuts_through: false, into_spoilboard_mm: 0 },
    spindle: { rpm: [18000] },
  };
  const job = {
    id: 'job-rs-seed', title: 'RS seeded job', design: { id: 'seed', title: 'Seed', thumb: null },
    machineId, plan: { config: {}, sectionZ: 3, chosen: [] }, stock: { x: 140, y: 60, t: 6 },
    program: { gcode: GCODE, sha256: sha, lines: GCODE.split('\n').length, seconds: 60, tools: TOOLS, toolChanges: 1, deepestZ: -1, rapidRate: 5000 },
    facts, state: 'queued', phase: null, streamed: false, airCut: null, history: [{ at: 0, who: 'e2e', what: 'seeded' }], createdAt: 0,
  };
  const machines = {
    version: 1,
    machines: [
      { id: 'cnc-sim', hostname: 'cnc-sim', connection: { kind: 'simulated' }, profile: null, toolIds: TOOLS, inCollet: null, estopInstalled: false, host: null, addedAt: 0 },
      { id: 'cnc-01', hostname: 'cnc-01', connection: { kind: 'bridge', url: 'http://cnc-01.local' }, profile: null, toolIds: TOOLS, inCollet: TOOLS[0], estopInstalled: false, host: { mdns: 'cnc-01.local', os: 'Raspberry Pi OS Lite 64-bit' }, addedAt: 0 },
    ],
  };
  return { jobs: JSON.stringify({ version: 1, jobs: [job] }), machines: JSON.stringify(machines) };
}

async function open(page: Page, machineId: string) {
  const s = seed(machineId);
  await page.addInitScript(
    ([j, m]) => {
      if (!sessionStorage.getItem('rs-seeded')) {
        localStorage.setItem('2bee.app.cncjob.jobs', j);
        localStorage.setItem('2bee.app.cncjob.machines', m);
        sessionStorage.setItem('rs-seeded', '1');
      }
    },
    [s.jobs, s.machines] as const,
  );
  await page.goto(HARNESS);
  await expect(page.getByTestId('rs')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('rs-chat')).toBeVisible();
  await expect(page.getByTestId('rs-steps')).toBeVisible();
}

async function tick(page: Page, key: string) {
  const box = page.getByTestId(`rs-tick-${key}`);
  await expect(box, `step ${key} can be ticked`).toBeEnabled({ timeout: 30_000 });
  await box.check();
  await expect(page.getByTestId(`rs-step-${key}`)).toHaveAttribute('data-state', 'done');
}

/** Resume through every M0 until the run ends; returns the prompts seen. */
async function runThrough(page: Page, holdOnce = false): Promise<string[]> {
  const seen: string[] = [];
  await expect(page.getByTestId('rs-feedhold')).toBeVisible({ timeout: 30_000 });
  let held = !holdOnce;
  for (let i = 0; i < 600; i++) {
    if (!(await page.getByTestId('rs-feedhold').isVisible())) break;
    const m0 = page.getByTestId('rs-m0');
    if (await m0.isVisible()) {
      seen.push((await m0.locator('strong').innerText()).trim());
      await page.getByTestId('rs-m0-resume').click();
      await expect(m0).toBeHidden({ timeout: 10_000 });
    } else if (!held && (await page.getByTestId('rs-progress').getAttribute('aria-valuenow')) !== '0') {
      held = true;
      await page.getByTestId('rs-feedhold').click();
      await expect(page.getByTestId('rs-resume')).toBeEnabled({ timeout: 10_000 });
      await expect(page.getByTestId('rs-stop')).toBeVisible();
      await page.getByTestId('rs-resume').click();
    }
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId('rs-feedhold')).toBeHidden();
  return seen;
}

test('RS1 SIMULATED: steps → Play air cut (lifted, spindle off) → cutter back → Play cut through its M0 → finish → done', async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 'cnc-sim');
  await expect(page.getByTestId('rs-machine')).toContainText('SIMULATED');

  // Play is off until the prepare steps are ticked, and says why.
  await expect(page.getByTestId('rs-play')).toBeDisabled();
  await expect(page.getByTestId('rs-play-blocked')).toContainText('Not ticked yet');
  await expect(page.getByTestId('rs-step-load')).toHaveAttribute('data-state', 'now');
  await page.screenshot({ path: test.info().outputPath('rs1-start.png'), fullPage: true });

  // The chat explains from the page's own facts; it has no way to act.
  await page.getByTestId('rs-chat-quick-play').click();
  await expect(page.getByTestId('rs-chat-reply').last()).toContainText('Not ticked yet');

  await tick(page, 'load');
  await tick(page, 'clamp');
  await tick(page, 'cutter');
  await expect(page.getByTestId('rs-tick-zero'), 'zero cannot be ticked before homing').toBeDisabled();
  await page.getByTestId('rs-home').click();
  await tick(page, 'zero');
  await expect(page.getByTestId('rs-play'), 'the page\'s own hand steps refuse Play too').toBeDisabled();
  await expect(page.getByTestId('rs-play-blocked')).toContainText('guard and dust shoe');
  await tick(page, 'guard');
  await tick(page, 'ppe');
  await tick(page, 'spindle');

  // The air cut: what is drawn and sent is the lifted program.
  await expect(page.getByTestId('rs-play')).toBeEnabled();
  await expect(page.getByTestId('rs-play')).toContainText('air cut');
  await expect(page.getByTestId('rs-tick-present'), '"at the machine" comes after the air cut').toBeDisabled();
  await page.getByTestId('rs-play').click();
  await expect(page.getByTestId('rs-view-label')).toContainText('AIR CUT (lifted, spindle off)');
  await expect(page.getByTestId('rs-step-aircut')).toHaveAttribute('data-state', 'running');
  await page.screenshot({ path: test.info().outputPath('rs1-aircut.png'), fullPage: true });
  const airPrompts = await runThrough(page);
  expect(airPrompts, 'the air cut stops at the program\'s M0 too').toEqual([`Stop. Fit cutter 2: ${TOOLS[1]}`]);

  // Back in the queue with the air cut recorded; the cut needs three more ticks.
  await expect(page.getByTestId('rs-play')).toContainText('cut');
  await expect(page.getByTestId('rs-play')).toBeDisabled();
  await tick(page, 'aircut');
  await expect(page.getByTestId('rs-play-blocked')).toContainText('cutter 1 back in the collet');
  await tick(page, 'refit');
  await page.getByTestId('rs-home').click();
  await expect(page.getByTestId('rs-home')).toContainText('Homed', { timeout: 30_000 });
  await tick(page, 'present');
  await expect(page.getByTestId('rs-play-blocked')).toHaveCount(0);
  await expect(page.getByTestId('rs-play')).toBeEnabled();

  // The cut: Feed Hold and Resume mid-run, the M0 takeover, to the end.
  await page.getByTestId('rs-play').click();
  await expect(page.getByTestId('rs-view-label')).toContainText('CUTTING');
  await expect(page.getByTestId('rs-stop')).toBeVisible();
  const prompts = await runThrough(page, true);
  expect(prompts).toEqual([`Stop. Fit cutter 2: ${TOOLS[1]}`]);
  await expect(page.getByTestId('rs-step-cut')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('rs-step-pause-68')).toHaveAttribute('data-state', 'done');

  // Finish: Done only after the finish steps.
  await expect(page.getByTestId('rs-done')).toBeDisabled();
  for (const k of ['stopped', 'unclamp', 'check', 'clean']) await tick(page, k);
  await page.screenshot({ path: test.info().outputPath('rs1-finish.png'), fullPage: true });
  await page.getByTestId('rs-done').click();
  await expect(page.getByTestId('rs-finished')).toContainText('RS seeded job: done');
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cncjob.jobs')!).jobs[0].state);
  expect(state).toBe('done');
});

test('RS2 a REAL machine: every step ticked, Play stays off with the e-stop (H5) reason, nothing streams', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 'cnc-01');
  await expect(page.getByTestId('rs-machine')).toContainText('cnc-01');
  await expect(page.getByTestId('rs-machine')).not.toContainText('SIMULATED');
  await expect(page.getByTestId('rs-home'), 'no Home button for a machine this app cannot reach').toHaveCount(0);
  for (const k of ['load', 'clamp', 'cutter', 'zero', 'guard', 'ppe', 'spindle']) await tick(page, k);
  await expect(page.getByTestId('rs-play')).toBeDisabled();
  const why = page.getByTestId('rs-play-blocked');
  await expect(why).toContainText('No physical e-stop is installed (never ordered; firmware ESTOP_ENABLE 0)');
  await expect(why).toContainText('H5');
  await expect(why).not.toContainText('Not ticked yet');
  await page.screenshot({ path: test.info().outputPath('rs2-blocked.png'), fullPage: true });
  // A forced click does nothing: the button is disabled and no run screen appears.
  await page.getByTestId('rs-play').click({ force: true });
  await expect(page.getByTestId('rs-feedhold')).toHaveCount(0);
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cncjob.jobs')!).jobs[0].state);
  expect(state).toBe('queued');
});
