import { test, expect, type Page, type Worker } from '@playwright/test';
import { seedTab } from './tab';
import { checkWire, describeVerdict, ANALYSIS_LINES, type WireWrite } from './journey-router/wire';

/*
 * ROUTER JOURNEY — connect → identify (with consent) → Analyse router →
 * profile, flags, measurements → one measurement's how-to + 3D view → a
 * distance-check value → the corrected `$100` verdict. Then the assertion the
 * journey exists for: what the app WROTE, read from the bytes the fake
 * controller received.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRANSPORT — FAKE, AND SAID SO
 * ─────────────────────────────────────────────────────────────────────────────
 * The REAL `src/RunTab.tsx` connection and the REAL `src/run/streamer.worker.ts`,
 * with `navigator.serial` faked on both sides:
 *
 *   page    an init script gives `navigator.serial` a `requestPort()` that
 *           returns a stub port (vendor/product ids only — the page never
 *           reads or writes it; the worker does), and wraps `window.Worker` so
 *           the product's `streamer.worker.ts` URL is swapped for
 *           `e2e/journey-router/worker-entry.ts`.
 *   worker  that entry installs `RouterSerial` (run18's unmodified fake-serial
 *           shim over `src/run/fake.ts`, persona per test, wrapped to answer
 *           `$I`/`$$`/`$#`/`$PINS` in grblHAL format and to LOG EVERY RECEIVED
 *           BYTE), then imports the real worker.
 *
 * Nothing in `src/` is modified. Runs against the vite DEV server, because only
 * the dev server transforms and serves `e2e/` (same reason as `run18.spec.ts`).
 * Plain headless Playwright: unlike RUN-18 this journey does not need a hidden
 * tab, so no Xvfb and no raw CDP — and no DISPLAY is touched.
 *
 * 🔴 A GREEN HERE IS NOT A MACHINE. It says the page and the worker agree with
 * this lane's reading of grblHAL's reply formats. The router has never been
 * connected to this page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ROUTES TO "IDENTIFIED", ONE TEST EACH
 * ─────────────────────────────────────────────────────────────────────────────
 *   consent  persona `no-banner`: silence → consent panel → "Ask it to identify
 *            itself" → `$I`, 0x87, `$$` → verdict. The route a board that was
 *            already running takes.
 *   banner   persona `healthy`: `GrblHAL 1.1f` on connect → verdict, no probe.
 * Both then run the identical router-page journey and wire assertion.
 *
 * 🔴 MEASURED 2026-10-14: THE CONSENT ROUTE IS RED, AND THE DEFECT IS IN `src/`.
 * After the probe the tab's verdict is `grbl` ("[VER: and [OPT: with no
 * FW:grblHAL"), so `analyseBlocker` refuses Analyse for good. The 0x87 reply
 * DID carry `FW:grblHAL` — but `RunTab.tsx` `onLine` returns early for status
 * reports (`if (inbound.status) { … return; }`) BEFORE
 * `handshake.current.push(line)`, so `identify()`'s FW:grblHAL branch never
 * sees it; and `identify()` does not read `[FIRMWARE:grblHAL]` from `$I`.
 * The test is left red on purpose: it is the operator's real path.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROL
 * ─────────────────────────────────────────────────────────────────────────────
 *   JOURNEY_ROUTER_PLANT=forbidden-write npx playwright test e2e/journey-router.spec.ts
 * appends a `$100=1\n` write to the REAL recorded log before the wire assertion
 * runs, so the journey test must go RED on the VERDICT line. The second test
 * does the same against a synthetic log for every forbidden class, in-process.
 */

const DEV = `http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`;
const PLANT = process.env.JOURNEY_ROUTER_PLANT ?? '';
const ENTRY = '/e2e/journey-router/worker-entry.ts';

type Persona = 'no-banner' | 'healthy';

/** Page-side fakes. Runs before any app code. */
async function installPageFakes(page: Page, persona: Persona): Promise<void> {
  await page.addInitScript(
    ([entry, persona]: [string, string]) => {
      const info = { usbVendorId: 0x2bee, usbProductId: 0x0001 }; // == run18 FakeSerialPort.getInfo
      const port = { getInfo: () => info, readable: null, writable: null, open: async () => {}, close: async () => {} };
      const serial = {
        requestPort: async () => port,
        getPorts: async () => [port],
        addEventListener() {},
        removeEventListener() {},
      };
      Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
      // Says this port is a FAKE, so the Run tab's no-motion-on-a-real-board gate (ops H5) does not apply.
      (window as unknown as { __2BEE_FAKE_SERIAL__: boolean }).__2BEE_FAKE_SERIAL__ = true;

      const w = window as unknown as { Worker: typeof Worker; __journeySwaps: string[] };
      w.__journeySwaps = [];
      const Orig = w.Worker;
      w.Worker = class extends Orig {
        constructor(url: string | URL, opts?: WorkerOptions) {
          const s = String(url);
          if (s.includes('streamer.worker')) {
            w.__journeySwaps.push(s);
            super(entry, { type: 'module', name: `persona=${persona}` });
          } else {
            super(url, opts);
          }
        }
      } as typeof Worker;
    },
    [ENTRY, persona] as [string, string],
  );
}

async function readLog(worker: Worker): Promise<{ log: WireWrite[]; describe: string }> {
  return worker.evaluate(() => {
    const s = (self as unknown as { __routerSerial?: { port: { log: unknown[] } | null; describe(): string } }).__routerSerial;
    if (!s) throw new Error('worker has no __routerSerial — the journey entry did not run in this worker');
    return { log: JSON.parse(JSON.stringify(s.port?.log ?? [])), describe: s.describe() };
  });
}

/** Print where the journey stopped, with the evidence, then rethrow. */
async function diagnose(page: Page, worker: Worker, where: string, err: unknown): Promise<never> {
  const blocked = await page.getByTestId('router-blocked').textContent().catch(() => null);
  const consoleLog = await page.getByTestId('run-console-log').innerText().catch(() => '(no console)');
  const wire = await readLog(worker).catch((e) => ({ log: [] as WireWrite[], describe: String(e) }));
  console.log(`DIAG stopped at: ${where}`);
  console.log('DIAG router-blocked: ' + blocked);
  console.log(
    'DIAG run-console-log (status reports omitted, notes only):\n' +
      consoleLog
        .split('\n')
        .filter((l) => !/^< /.test(l))
        .slice(-20)
        .join('\n'),
  );
  console.log('DIAG wire: ' + describeVerdict('at-failure', checkWire(wire.log, {})));
  throw err;
}

async function journey(page: Page, persona: Persona): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await installPageFakes(page, persona);
  await seedTab(page, 'run');
  /* The app starts other workers (the CAM core) — pick ours by URL. */
  const workerP = page.waitForEvent('worker', { predicate: (w) => w.url().includes('/e2e/journey-router/'), timeout: 30_000 });
  await page.goto(DEV);
  await expect(page.getByTestId('run-tab')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('run-unavailable')).toHaveCount(0);

  /* Before connect: Analyse is refused, and says why. */
  await expect(page.getByTestId('router-analyse')).toBeDisabled();
  await expect(page.getByTestId('router-blocked')).toContainText('identify');

  /* ── connect ── */
  await page.getByTestId('run-control-connect').click();
  const worker = await workerP;
  expect(
    await page.evaluate(() => (window as unknown as { __journeySwaps: string[] }).__journeySwaps),
    'the PRODUCT created its streamer worker and the init script swapped it',
  ).toHaveLength(1);

  let expectPre: string[];
  if (persona === 'no-banner') {
    /* ── silence → consent, with nothing written yet ── */
    await expect(page.getByTestId('run-identify-consent')).toBeVisible({ timeout: 15_000 });
    const beforeConsent = await readLog(worker);
    console.log('TRANSPORT: ' + beforeConsent.describe);
    expect(beforeConsent.log, 'nothing may be written before the operator consents').toHaveLength(0);
    await page.getByTestId('run-control-identify').click();
    expectPre = ['$I', '$$', '$$']; // identifyProbeCommands ($I, 0x87, $$) + afterVerdictCommands (0x87, $$)
  } else {
    console.log('TRANSPORT: ' + (await readLog(worker)).describe);
    await expect(page.getByTestId('run-identify-consent')).toHaveCount(0);
    expectPre = ['$$']; // afterVerdictCommands only (0x87, $$) — no probe on a board that announced itself
  }
  try {
    await expect(page.getByTestId('router-analyse')).toBeEnabled({ timeout: 15_000 });
  } catch (err) {
    await diagnose(page, worker, 'waiting for "Analyse router" to be enabled after identification', err);
  }

  /* Settle: let the after-verdict `$$` and the first polls land. */
  await page.waitForTimeout(1000);
  const preN = (await readLog(worker)).log.length;

  /* ── Analyse router ── */
  await page.getByTestId('router-analyse').click();

  const facts = page.getByTestId('router-facts');
  await expect(facts).toBeVisible({ timeout: 15_000 });
  await expect(facts).toContainText('X 1250 · Y 670 · Z 90');
  await expect(facts).toContainText('X 400 · Y 400 · Z 800'); // steps/mm
  await expect(facts).toContainText('X 8000 · Y 8000 · Z 2000'); // max rate
  await expect(facts).toContainText('6000–24000 rpm');
  await expect(facts).toContainText('1.1f.20260811');
  await expect(facts).toContainText('on / off / on'); // $22=1 $20=0 $21=1
  await expect(facts.locator('tr', { hasText: 'Probe' })).toContainText('configured');

  const flags = page.getByTestId('router-flags');
  await expect(flags).toBeVisible();
  await expect(flags).toContainText('Soft limits are off ($20)');
  await expect(flags).not.toContainText('Homing is off');

  const list = page.getByTestId('router-measurements');
  await expect(list).toBeVisible();
  for (const id of ['switches', 'homing', 'travel', 'stepsX', 'stepsY', 'stepsZ', 'spoilboard', 'collet', 'spindle']) {
    await expect(list.getByTestId(`router-m-${id}`), `measurement ${id} is listed`).toBeVisible();
  }

  /* ── open the X distance check: how-to + 3D (or its fallback) ── */
  const item = list.getByTestId('router-m-stepsX');
  await item.getByRole('button', { name: /Distance check, X/ }).click();
  await expect(item).toContainText('Put a mark (tape) on the frame next to the X carriage');
  await expect(item).toContainText('Jog X exactly 100.000 mm');
  const view = item.locator('[data-testid="measure3d"], [data-testid="measure3d-fallback"]');
  await expect(view.first()).toBeVisible();
  console.log(`MEASURE VIEW rendered as: ${await view.first().getAttribute('data-testid')}`);

  const verdict = item.getByTestId('router-verdict-stepsX');
  await expect(verdict).toContainText('Enter how far it really moved');
  await item.locator('input[type="number"]').fill('99.5');
  /* 400 × 100 / 99.5 = 402.0100… */
  await expect(verdict).toContainText('$100=402.010 (now 400)');
  await expect(verdict).toContainText('-0.5% off');
  console.log('VERDICT TEXT: ' + (await verdict.textContent()));

  /* ── THE WIRE ── */
  await page.waitForTimeout(500);
  const all = (await readLog(worker)).log;
  if (PLANT === 'forbidden-write') {
    const at = all.length ? all[all.length - 1].at + 1 : Date.now();
    all.push({ seq: 1e9, at, bytes: Array.from(new TextEncoder().encode('$100=1\n')) });
    console.log('PLANT forbidden-write: appended "$100=1\\n" to the recorded log');
  }
  const pre = checkWire(all.slice(0, preN), { exact: expectPre });
  const analysis = checkWire(all.slice(preN), { exact: ANALYSIS_LINES });
  const session = checkWire(all, { allowed: ANALYSIS_LINES });
  console.log(describeVerdict('identify+after-verdict', pre));
  console.log(describeVerdict('analysis', analysis));
  console.log(describeVerdict('whole-session', session));
  console.log(`WIRE writes recorded: ${all.length} (pre-analysis ${preN})`);

  expect(pre.ok, pre.violations.join('\n')).toBe(true);
  expect(analysis.ok, analysis.violations.join('\n')).toBe(true);
  expect(session.ok, session.violations.join('\n')).toBe(true);
  expect(pageErrors, 'uncaught page errors during the journey').toEqual([]);
}

test.describe('router journey', () => {
  test('consent route (no banner): connect → consent → identify → Analyse router → profile → measure → $100 verdict; wire = $I $$ $# $PINS only', async ({ page }) => {
    test.setTimeout(120_000);
    await journey(page, 'no-banner');
  });

  test('banner route (GrblHAL banner): connect → Analyse router → profile → measure → $100 verdict; wire = $I $$ $# $PINS only', async ({ page }) => {
    test.setTimeout(120_000);
    await journey(page, 'healthy');
  });

  test('NEGATIVE CONTROL — the wire assertion rejects every forbidden write class', () => {
    const w = (lines: string[], rt: number[] = []): WireWrite[] => {
      const out: WireWrite[] = rt.map((b, i) => ({ seq: i, at: i, bytes: [b] }));
      lines.forEach((l, i) => out.push({ seq: 100 + i, at: 100 + i, bytes: Array.from(new TextEncoder().encode(l + '\n')) }));
      return out;
    };
    const clean = checkWire(w([...ANALYSIS_LINES], [0x87, 0x3f]), { exact: ANALYSIS_LINES });
    console.log(describeVerdict('control-clean', clean));
    expect(clean.ok, 'the clean log must pass, or a red below proves nothing').toBe(true);

    const planted: [string, WireWrite[]][] = [
      ['$100=1', w([...ANALYSIS_LINES, '$100=1'])],
      ['$J=G91 X10 F500', w([...ANALYSIS_LINES, '$J=G91 X10 F500'])],
      ['G0 X10', w([...ANALYSIS_LINES, 'G0 X10'])],
      ['M3 S12000', w([...ANALYSIS_LINES, 'M3 S12000'])],
      ['$H', w([...ANALYSIS_LINES, '$H'])],
      ['realtime 0x18', w([...ANALYSIS_LINES], [0x18])],
      ['missing $PINS', w(['$I', '$$', '$#'])],
    ];
    for (const [name, log] of planted) {
      const v = checkWire(log, { exact: ANALYSIS_LINES, allowed: ANALYSIS_LINES });
      console.log(describeVerdict(`plant[${name}]`, v));
      expect(v.ok, `plant ${name} must be REJECTED`).toBe(false);
    }
  });
});
