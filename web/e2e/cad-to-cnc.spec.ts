/*
 * End-to-end: CAD → Save → CNC → Plan → Simulate
 *
 * Imports a SCAD model into the CAD tab, evaluates it, saves it,
 * switches to CNC, picks the saved drawing, and verifies the plan
 * runs clean (no gouges, G-code emitted, simulation passes).
 *
 * This is the first test that exercises the full workflow the app
 * exists for: design a part in CAD, bring it to CNC, and get a
 * runnable program.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedTab } from './tab';
/* The row's own constant, not a fourth copy of its text: renaming it in the
 * panel used to leave this assertion green while the screen said something
 * else. */
import { STALE_WASM_FEED } from '../src/panels/SummaryPanel';

/* The landing tab is Designs; this suite is about the CNC tab. See e2e/tab.ts. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

// A simple rectangular plate — small enough to fit on any workpiece.
const SCAD_SOURCE = `cube([20, 15, 10], center = true);`;

const MODEL_NAME = 'e2e-bracket-test';

/* ── helpers (borrowed from slicer.spec.ts patterns) ─────────────── */

async function openGcode(page: Page) {
  const head = page.getByTestId('panel-gcode').locator('.panel-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

/* ── the test ──────────────────────────────────────────────────────── */

test.describe('CAD to CNC end-to-end', () => {

  test('design a part in CAD, save it, bring it to CNC, and get a runnable program', async ({
    page,
  }) => {

    /* ── Step 1: Switch to CAD tab ─────────────────────────────────── */
    await page.goto('/');
    await page.getByTestId('tab-cad').click();
    const cadTab = page.getByTestId('cad-tab');
    await expect(cadTab).toBeVisible();

    /* ── Step 2: Type SCAD source ──────────────────────────────────── */
    // Clear the default example and type our model.
    const editor = page.getByTestId('cad-source');
    await editor.fill(SCAD_SOURCE);

    /* ── Step 3: Wait for mesh evaluation ──────────────────────────── */
    // The mesh evaluation is debounced by 250ms. The 'cad-preview-stale'
    // banner appears when the source has changed but the mesh hasn't
    // caught up. Wait for it to be gone (or absent).
    // Give it a generous timeout — the first eval can be slow.
    await page.waitForTimeout(1000); // initial debounce + mesh time
    // The preview canvas should be visible (geometry was produced).
    await expect(page.getByTestId('cad-preview-canvas')).toBeVisible({ timeout: 15_000 });

    /* ── Step 4: Save the model (File → Save As...) ────────────────── */
    // Open the File menu.
    await page.getByTestId('cad-menu-file').click();
    // Click "Save As..."
    await page.getByTestId('cad-menuitem-file.save-as').click();

    // The save dialog should appear.
    const nameInput = page.getByTestId('cad-save-name');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(MODEL_NAME);

    // Click save.
    await page.getByTestId('cad-save-go').click();

    // Wait for the save to complete — check for success or failure.
    // The save is async (IndexedDB write + verification). Give it time.
    await page.waitForTimeout(5000);
    const blocked = page.getByTestId('cad-save-blocked');
    const blockedVisible = await blocked.isVisible().catch(() => false);
    if (blockedVisible) {
      const blockedText = await blocked.textContent();
      throw new Error(`Save was blocked: ${blockedText}`);
    }
    // Also check for the "replaces" warning (saving over an existing name).
    const replaces = page.getByTestId('cad-save-replaces');
    const replacesVisible = await replaces.isVisible().catch(() => false);
    if (replacesVisible) {
      // Click the save button again to confirm the overwrite.
      await page.getByTestId('cad-save-go').click();
      await page.waitForTimeout(3000);
    }
    // The save dialog should have closed.
    const nameStillVisible = await nameInput.isVisible().catch(() => false);
    if (nameStillVisible) {
      throw new Error('Save dialog is still open — save may have failed');
    }

    /* ── Step 5: Switch to CNC tab ─────────────────────────────────── */
    // Give IndexedDB time to flush the save.
    await page.waitForTimeout(3000);
    await page.getByTestId('tab-cnc').click();
    await expect(page.getByTestId('tabpanel-cnc')).toBeVisible();

    /* ── Step 6: Wait for the CNC tab to initialize ────────────────── */
    // The WASM needs time to load. Wait for the drawing picker to be visible
    // as a proxy for "the CNC tab is ready".
    await expect(page.getByTestId('drawing-picker-trigger')).toBeVisible({ timeout: 30_000 });
    // Extra time for the useSaved hook to refresh from IndexedDB.
    await page.waitForTimeout(2000);

    /* ── Step 7: Select the saved drawing ──────────────────────────── */
    // Give IndexedDB time to flush.
    await page.waitForTimeout(2000);

    // Debug: check what's in the picker.
    await page.getByTestId('drawing-picker-trigger').click();
    await page.waitForTimeout(2000);
    const optIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="drawing-picker-opt-"]'))
        .map(el => el.getAttribute('data-testid'))
    );
    console.log('Picker options:', optIds);

    // Check if our saved model is there.
    const savedOpt = page.getByTestId(`drawing-picker-opt-saved:${MODEL_NAME}`);
    const savedExists = await savedOpt.count();
    console.log('Saved model exists:', savedExists);

    if (savedExists === 0) {
      // Try looking for it with a different prefix.
      const allOpts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="drawing-picker-opt-"]'))
          .map(el => el.getAttribute('data-testid'))
          .filter(id => id?.includes('bracket') || id?.includes('e2e'))
      );
      console.log('Matching options:', allOpts);
      // Close the picker and fail with a diagnostic.
      await page.getByTestId('drawing-picker-done').click();
      throw new Error(`Saved model 'saved:${MODEL_NAME}' not found in picker. Available: ${optIds.join(', ')}`);
    }

    // Select it.
    await savedOpt.click();
    await page.getByTestId('drawing-picker-done').click();
    await expect(page.getByTestId('drawing-picker-list')).toHaveCount(0);

    /* ── Step 7.5: Confirm the bed is clear ────────────────────────── */
    // The plan requires workholding to be declared. Confirm the bed is clear.
    // Open the Work holding section first (the checkbox may be inside it).
    /* 🔴 THE CONTROLS MUST EXIST — this whole block was wrapped in
     * `if (await whSection.count() > 0)` and `if (confirmCount > 0)`, so
     * renaming or removing either testid made the step do nothing and the test
     * stay green while its own comment above still claimed workholding was
     * declared. ⚠ `slicer.spec.ts:5580` records this EXACT shape as a defect
     * already fixed there — *"a test whose whole body is optional is a green
     * that says the feature is absent"* — and it stayed live one file over.
     * ⚠ AND THE VERIFICATION WAS A `console.log`: the re-read that confirms the
     * box actually got checked was printed to stdout instead of asserted, so a
     * silent failure to check it printed `false` and the test carried on. */
    const whSection = page.getByTestId('panel-clamps');
    await expect(whSection, 'the Work holding panel is gone — this step is not optional').toHaveCount(1);
    const head = whSection.locator('.panel-head');
    if ((await head.getAttribute('aria-expanded')) !== 'true') {
      await head.click();
      await expect(head).toHaveAttribute('aria-expanded', 'true');
    }
    const confirmClear = page.getByTestId('confirmed-clear');
    await expect(confirmClear, 'the bed-clear confirmation is gone — the plan requires it').toHaveCount(1);
    if (!(await confirmClear.isChecked())) {
      await confirmClear.check({ force: true });
    }
    await expect(confirmClear, 'the bed-clear box did not take the check').toBeChecked();
    // Also check the status after confirming.
    const statusAfterConfirm = await page.getByTestId('status').textContent();
    console.log('Status after confirm:', statusAfterConfirm);

    /* ── Step 8: Wait for the plan ─────────────────────────────────── */
    /* 🔴 THIS TEST IS NAMED "…and get a RUNNABLE program" AND WAS ACCEPTING A
     * REFUSAL. It asserted `expect(['runnable', 'refused']).toContain(status)`,
     * so the one outcome it exists to catch was enumerated as a pass — and the
     * run really did take that path: `Plan status: refused`, measured
     * 2026-09-07.
     *
     * ⚠ The comment here blamed "no WebGL, no workholding". That was wrong. The
     * sibling test in this same file (~:400) names the true cause and fixes it:
     * the cube is modelled `center = true`, so at the (0,0) placement the cut
     * runs off the bed, and *"off the bed is a REFUSAL in this app, not a thing
     * to assert away"*. It places the part and then demands `runnable`.
     * ⇒ The fix was already written one test down; this one widened the
     * assertion instead. Placing the part is what an operator does next. */
    await page.getByTestId('part-x').fill('20');
    await page.getByTestId('part-y').fill('20');
    await expect(page.getByTestId('status'), 'the round-tripped model did not plan').toHaveText(
      'runnable',
      { timeout: 30_000 },
    );

    // Verify the drawing name appears in the notes (confirms the CAD model
    // was actually planned, not just the default fixture).
    const notesText = await page.evaluate(() =>
      document.querySelector('[data-testid="panel-notes"]')?.textContent || ''
    );
    expect(notesText).toContain(MODEL_NAME);

    /* ── Step 9: Verify simulation ran ─────────────────────────────── */
    // The simulation should have run (gouge count exists).
    const gougeEl = page.getByTestId('sim-gouge');
    await expect(gougeEl).toBeAttached({ timeout: 15_000 });

    /* ── Step 10: Verify G-code was emitted ────────────────────────── */
    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const gcode = await page.getByTestId('gcode').textContent();
    expect(gcode).toBeTruthy();
    expect(gcode!.length).toBeGreaterThan(500);

    // The G-code should contain real cutting moves.
    expect(gcode).toContain('G1');

    /* ── Step 11: Verify the summary ───────────────────────────────── */
    /* 🔴 ASSERT THE TEXT, NOT THE NODE — and this assertion was SILENTLY VACATED
     * on 2026-08-28 without anything going red.
     *
     * It read `toBeAttached`, which proved something while the row rendered under
     * `{feed != null && …}`: the node existing meant a feed had been derived, so
     * this was the CAD→CNC pipeline's only evidence that it had produced a
     * feed-bearing plan. That same day the row was made UNCONDITIONAL — for a
     * good reason, so "commands no feed" and "the derivation missed it" stopped
     * being the same blank space — and this line became a check that a `<b>`
     * exists. It attaches for a refused job, an empty program and a stale wasm.
     *
     * ⚠ The edit that broke it was three files away and its own tests were green.
     * A presence assertion is only ever as strong as the condition it renders
     * under, and that condition is not visible from here. */
    /* ⚠ ANCHORED AND POSITIVE. `/\d+\s*mm\/min/` is satisfied by `-100 mm/min`
     * (the `-` is simply not matched) and by `0 mm/min` — the two values the
     * core was deliberately taught to KEEP because they are alarming: `F0` on a
     * motion block is `error:22`, a halt with the tool down. A pipeline
     * assertion that accepts them is green on exactly the programs worth
     * stopping for. */
    /* 🔴 PARSE THE LIST, DO NOT REGEX THE COMPOSITE STRING — and the version
     * this replaces moved the defect one alternation over rather than closing
     * it. It read `/^[1-9][\d.]*\s*mm\/min$|^\d+ feeds: /`: branch one is
     * anchored and positive, and **branch two constrains nothing after the
     * colon** — so `2 feeds: 0, 3600 mm/min` and `2 feeds: -100, 3600 mm/min`
     * both matched. Those are the two values the core was deliberately taught to
     * KEEP because they are alarming (`F0` on a motion block is `error:22`, a
     * halt with the tool down).
     *
     * ⚠ AND IT IS THE LIVE BRANCH. Measured: `report plate` commands three
     * distinct cutting feeds — a plunge feed distinct from a cut feed is the
     * ordinary case, not the corner one — so every real run took the branch that
     * checked nothing. An alternation is two assertions, and the weaker one is
     * the one that decides. */
    const feedText = (await page.getByTestId('summary-feed').textContent()) ?? '';
    const many = /^(\d+) feeds: (.+) mm\/min$/.exec(feedText);
    /* `\S+` and not `[\d.]+`: the digit class cannot match a leading `-`, so a
     * single-feed program emitting `F-100` fell through to `values = []` and the
     * test reported "produced NO commanded cutting feed" — sending the reader
     * after a broken derivation when the truth is a negative feed on the
     * summary. `Number` decides, and the loop below prints the right owner. */
    const one = /^(\S+) mm\/min$/.exec(feedText);
    const values = many
      ? many[2].split(', ').map(Number)
      : one
        ? [Number(one[1])]
        : [];
    /* 🔴 THE STALE-WASM STATE IS ITS OWN OWNER. `formatFeeds` renders
     * `unknown — rebuild the wasm` when the report has no `cutting_feeds_mm_min`
     * — the only reachable cause being a browser running the previously
     * committed module, which is the case K3 exists for. Neither regex matches
     * it, so it fell through to "the pipeline produced no commanded cutting
     * feed": the pipeline is fine and the BUILD is stale, which is the same
     * misattribution the `\S+` change was made to remove one value along. */
    expect(
      feedText,
      'the browser is running a wasm build older than the core — rebuild it (`npm run wasm`) ' +
        'before reading anything on this row as a fact about the job'
    ).not.toBe(STALE_WASM_FEED);
    /* 🔴 EACH NON-NUMERIC STATE NAMES ITS OWN OWNER. `formatFeeds` has three,
     * and only one of them is about the pipeline: `no program` means the job was
     * REFUSED (there are no bytes), `not commanded` means it ran and commanded
     * no feed, and the stale-wasm state above is about the BUILD. Collapsing
     * them into "the pipeline produced no commanded cutting feed" sends the
     * reader after the wrong thing in two cases out of three — the same
     * misattribution the `\S+` and stale-wasm changes were each made for. */
    expect(
      feedText,
      'the CAD → CNC pipeline was REFUSED — there is no program at all, so there is nothing ' +
        'downstream to check. Read the refusal, not this row.'
    ).not.toBe('no program');
    expect(
      values.length,
      `the CAD → CNC pipeline produced no commanded cutting feed — the row reads "${feedText}"`
    ).toBeGreaterThan(0);
    if (many) {
      expect(values.length, `"${feedText}" says ${many[1]} feeds and lists ${values.length}`).toBe(
        Number(many[1])
      );
    }
    for (const v of values) {
      /* Unparsable and non-positive are different findings. `Number('abc')` is
       * NaN, which fails `toBeGreaterThan(0)` under a message about a
       * non-positive feed — right to red, wrong owner, which is the class this
       * whole block has been corrected for twice. */
      expect(
        Number.isFinite(v),
        `an unparsable value is on the feed row: "${feedText}"`
      ).toBe(true);
      expect(
        v,
        `a non-positive commanded cutting feed reached the summary: "${feedText}"`
      ).toBeGreaterThan(0);
    }
    /* 🔴 THE SAME PARSE, BECAUSE THIS ASSERTION HAD THE IDENTICAL DEFECT FOUR
     * LINES BELOW THE FIX FOR IT. `/\d+/` is unanchored and positive-free: green
     * on `0`, on `-100` (the `-` is simply not matched) and on
     * `2 speeds: 0, 18000`. `spindleWordsOnLine` deliberately KEEPS signed and
     * zero values and `formatSpindle` prints them, so those strings are
     * reachable — and `S0` while cutting is the spindle-side `F0`: a program
     * that cuts with a stopped spindle. */
    const rpmText = (await page.getByTestId('summary-rpm').textContent()) ?? '';
    const manyS = /^(\d+) speeds: (.+)$/.exec(rpmText);
    const oneS = /^(\S+)$/.exec(rpmText);
    const speeds = manyS
      ? manyS[2].split(', ').map(Number)
      : oneS
        ? [Number(oneS[1])]
        : [];
    expect(
      rpmText,
      'the CAD → CNC pipeline was REFUSED — there is no program at all. Read the refusal.'
    ).not.toBe('no program');
    expect(
      speeds.length,
      `the CAD → CNC pipeline produced no commanded spindle speed — the row reads "${rpmText}"`
    ).toBeGreaterThan(0);
    /* ⚠ THE COUNT-VS-LISTED CHECK, WHICH THE FEED BRANCH HAD AND THIS DID NOT —
     * the same asymmetry this block's own comment is about, committed inside the
     * fix for it. "2 speeds:" followed by three values is a row contradicting
     * itself, and a reader trusts the prose half. */
    if (manyS) {
      expect(
        speeds.length,
        `"${rpmText}" says ${manyS[1]} speeds and lists ${speeds.length}`
      ).toBe(Number(manyS[1]));
    }
    for (const v of speeds) {
      expect(
        Number.isFinite(v),
        `an unparsable value is on the RPM row: "${rpmText}"`
      ).toBe(true);
      expect(
        v,
        `a non-positive commanded spindle speed reached the summary: "${rpmText}"`
      ).toBeGreaterThan(0);
    }
  });

  test('the saved CAD model persists across CNC tab switches', async ({
    page,
  }) => {
    // This test verifies that saving in CAD and picking in CNC works
    // across a tab switch (the IndexedDB round-trip).

    await page.goto('/');
    await page.getByTestId('tab-cad').click();
    await expect(page.getByTestId('cad-tab')).toBeVisible();

    // Type and save.
    const editor = page.getByTestId('cad-source');
    await editor.fill(SCAD_SOURCE);
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('cad-preview-canvas')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('cad-menu-file').click();
    await page.getByTestId('cad-menuitem-file.save-as').click();
    const nameInput = page.getByTestId('cad-save-name');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(MODEL_NAME);
    await page.getByTestId('cad-save-go').click();
    await expect(nameInput).toHaveCount(0, { timeout: 10_000 });

    // Switch to CNC, verify the drawing appears in the picker.
    await page.getByTestId('tab-cnc').click();
    await expect(page.getByTestId('tabpanel-cnc')).toBeVisible();
    /* 🔴 NOT `ready()` here: a bare CNC tab plans NOTHING until a drawing is
     * chosen (deliberate — an empty app never shows a toolpath for a part the
     * user did not supply), so `status` does not exist yet and the wait would
     * time out. The picker trigger is the readiness proxy, same as the first
     * test in this file. */
    await expect(page.getByTestId('drawing-picker-trigger')).toBeVisible({ timeout: 30_000 });

    // Open the drawing picker and verify our saved model is listed.
    await page.getByTestId('drawing-picker-trigger').click();
    const savedOption = page.getByTestId(`drawing-picker-opt-saved:${MODEL_NAME}`);
    await expect(savedOption).toBeVisible({ timeout: 10_000 });

    // Select it and verify the plan runs.
    await savedOption.click();
    await page.getByTestId('drawing-picker-done').click();
    await expect(page.getByTestId('drawing-picker-list')).toHaveCount(0);

    /* 🔴 PLACE THE PART, or the plan is refused for the right reason and this
     * test fails on it: the cube is modelled `center = true`, so its section
     * spans −10..+10 / −7.5..+7.5, and at the (0, 0) placement the cut runs to
     * X −13 / Y −10.5 (cutter radius outside the outline) — off the bed, and
     * "off the bed" is a REFUSAL in this app, not a thing to assert away. The
     * intent under test is that the saved model round-trips and plans; placing
     * it on the bed is what an operator does next. 20 mm clears the outline
     * plus the cutter on both axes. */
    await page.getByTestId('part-x').fill('20');
    await page.getByTestId('part-y').fill('20');
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });
  });
});
