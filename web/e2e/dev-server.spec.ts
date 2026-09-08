import { test, expect } from '@playwright/test';
import { seedTab } from './tab';

/**
 * The DEV server, not the built app.
 *
 * Everything else in this directory runs against `vite preview` — the artefact
 * that ships. This file exists because the two servers resolve module paths
 * differently, and for one commit that difference was total: the wasm glue was
 * in `public/`, which a production build copies verbatim and `vite dev` refuses
 * to serve to an importing module. `npm run dev` answered 500, the app said
 * "The CAM core did not load", and **all 16 tests stayed green** because not
 * one of them had ever opened the dev server.
 *
 * Kept deliberately small. This is not a second copy of the suite — it asks the
 * one question the preview run structurally cannot: does the thing a developer
 * opens actually load the core?
 *
 * 🔴 THE ONE TEST HERE WAS TAGGED `@needs-gpu` UNTIL 2026-08-12. THE TAG WAS
 * STRIPPED, SUITE-WIDE, BECAUSE IT HAD NO MEMBERS LEFT THAT WERE
 * ENVIRONMENTAL. See the banner in `slicer.spec.ts` for the whole accounting.
 *
 * ⚠ IT WAS TAGGED FOR A REASON THAT IS NOT ITS SUBJECT, WHICH IS WHY IT IS
 * STILL SAID HERE. This test asserts *"no console errors under vite dev"*, and
 * with the browser told to use software rasterisation the console carried three
 * `THREE.WebGLRenderer: A WebGL context could not be created` lines before it
 * could ever get to a module-resolution failure. **So it could not answer its
 * own question** — and it was NOT tagged by grepping for `viewport-canvas`, a
 * string this file never mentions. It was tagged from the observed error text,
 * which is the only defensible way to build such a set and still produced a set
 * that was wrong in every member.
 *
 * ✅ THE PREMISE, NOT THE TEST, WAS THE PROBLEM. Those three lines were produced
 * by `--use-gl=swiftshader` in `playwright.config.ts`, not by a box without a
 * GPU. On the corrected flags the console is clean and **this test passes in
 * ~3s**, which means it is finally answering the question it was written to
 * ask: the dev server does resolve the wasm glue.
 *
 * ⚠ THERE IS NO `--grep-invert @needs-gpu` CONTRACT ANY MORE. This file's header
 * quoted one, as did two others; all three are gone. The suite is run whole.
 */

// Kept in step with `playwright.config.ts`, which reads the same variable. A
// hardcoded 5179 here would send this file at whatever server happens to hold
// that port once a concurrent run moves its own — the exact confusion the
// `--strictPort` note in the config describes, one layer up.
const DEV = `http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`;

/* The landing tab is Designs; this suite is about the CAM core, which lives in
 * the CNC tab. See e2e/tab.ts for why this seeds rather than clicks. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

test.describe('dev server', () => {
  test('the CAM core loads under vite dev, not only in the built app', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(DEV, { waitUntil: 'networkidle' });

    // The failure this guards renders as a specific refusal, not a blank page —
    // the app is built to say so rather than compute something in its place.
    // Assert on the refusal by its own words, so a redesign that keeps the
    // failure but changes the copy fails here rather than passing quietly.
    await expect(page.getByText('The CAM core did not load')).toHaveCount(0);

    // ...and assert the positive: a control that only exists once the core has
    // answered. Absence of an error message is not presence of a working app.
    await expect(page.locator('select').first()).toBeVisible();
    const jobs = await page.locator('select').first().locator('option').count();
    expect(jobs).toBeGreaterThan(0);

    expect(errors, `console errors under vite dev:\n${errors.join('\n')}`).toEqual([]);
  });
});
