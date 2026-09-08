import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
/**
 * 🔴 THE STORAGE KEY AND THE DEFAULT ARE TAKEN FROM THE PRODUCT, NOT RETYPED.
 * `Tabs.tsx` exports both. A second copy of a key in a test is a second thing
 * that can be silently corrected in one place only — the exact hazard
 * `storage.spec.ts` records against its own hand-copied `'2bee.slicer store'`.
 * `persistence.spec.ts` already imports `SESSION_KEY` from `src/store` the same
 * way, so this is the file's existing convention rather than a new one.
 */
import { TAB_KEY, DEFAULT_TAB } from '../src/Tabs';

const HERE = dirname(fileURLToPath(import.meta.url));

/*
 * ===========================================================================
 * 🔴 ALL SIX TESTS IN THIS FILE RUN, AND PASS, AS OF 2026-08-12. THE
 *    `@needs-gpu` TAG IS STRIPPED — IT WAS HIDING A DEFECT IN A TEST.
 * ===========================================================================
 *
 * WebGL here was BLOCKLISTED, not missing — the config asked for swiftshader.
 * With `--use-gl=angle --use-angle=gl-egl` the suite reaches an RTX 4090. Both
 * previously-tagged tests in this file now run:
 *
 *   ✓ switching to 2bee.cad and back leaves the CAM tab exactly as it was
 *   ✓ the CNC viewport stops rendering while 2bee.cad is showing, and starts
 *     again — REWRITTEN. It failed first time out with *"the viewport did not
 *     resume rendering when its tab came back"*, and 🔴 **THE GUARD WAS FINE
 *     AND THE OBSERVABLE WAS WRONG.** It watched the cutter marker's screen
 *     position; the fixture stands on a 120-second tool-change dwell, so the
 *     marker legitimately freezes with the renderer running — reproduced with
 *     NO TAB SWITCH AT ALL. It now watches `data-frames`, a count of frames the
 *     viewport actually DREW, published below the `paused` return. The test's
 *     own header carries the measurement.
 *
 * 🔴 THAT TEST IS THE COST-JUSTIFICATION FOR THE WHOLE DESIGN. This file's own
 * list below says the pause guard is *"the entire cost-justification for hiding
 * rather than unmounting, and nothing anywhere has watched it go quiet"*.
 * Something has now watched it, on an observable that can tell a quiet renderer
 * from a quiet program — and all three legs have been watched go red on demand
 * (the plant table is in the test).
 *
 * ⚠ THE OBVIOUS SUSPECT WAS CHECKED AND CLEARED at the time. The note further
 * down warns that the 600ms settle *"is a wait, not a measurement"* and is the
 * first thing to blame for flakiness. Re-run serially,
 * `--workers=1 --repeat-each=2`: it failed both times with byte-identical text.
 * The wait was not the cause, and neither was the GPU.
 *
 * ⚠ CORRECTED 2026-08-11. This banner said *"NOTHING IN THIS FILE HAS EVER BEEN
 * RUN"* and *"Playwright does not run here at all"*. Measured at `2c4f75b693`:
 * **4 of the 6 tests in this file pass**, and the two that fail
 * (`switching to 2bee.cad and back…`, `the CNC viewport stops rendering…`) fail
 * on a 60-second timeout waiting for canvas attributes that a dead WebGL context
 * never publishes. **A stale RED lies exactly like a stale green** — and this one
 * cost more than a wrong count: the file was excluded from the split proposed in
 * TODO #135 precisely because everything in it was assumed uniformly dead, so
 * *"split `slicer.spec.ts`"* would have left two failures outside the split with
 * nothing pointing at them.
 *
 * ⚠ CORRECTED AGAIN 2026-08-12, AND THIS IS THE PART TO CARRY FORWARD. The
 * paragraph here said the box reports `GL_VENDOR = Disabled` and that the two
 * tagged tests *"have still never been watched go green OR red… until somebody
 * with a GPU runs them"*. **The GPU was always in the machine.** `Disabled` is
 * what this box prints when Chromium is launched with `--use-gl=swiftshader`,
 * which `playwright.config.ts` was asking for by name. Three agents measured it
 * and all three inferred a missing GPU from a configured one.
 *
 * ⚠ ANY `⚠ NEVER RUN` LINE STILL BELOW IS STALE. Every test in this file has
 * now been run. Those per-test lines are not redundant with a banner — an
 * excerpt of one test does not carry the header of its file, and the reader who
 * trusts a test is reading the test — so they are corrected in place as each
 * test is touched rather than swept, and an untouched one still says NEVER RUN
 * while this banner says otherwise. **The banner is the newer measurement.**
 *
 * ✅ RESOLVED 2026-08-27 — THE SWEEP THIS PARAGRAPH DEFERRED IS DONE, AND THE
 * PARAGRAPH ITSELF WAS THE PROBLEM. It stood above **four** surviving
 * `⚠ NEVER RUN` annotations for fifteen days, which is a document holding both
 * answers at once: a reader who reaches a test through its own header believes
 * the test, a reader who starts at the top believes the banner, and neither
 * knows the other exists. **A blanket retraction is not a correction** — it
 * cannot be checked against anything, it never goes red, and its "corrected as
 * each test is touched" policy is [a habit promised by whoever is least able to
 * keep it]. The four are now corrected in place, individually, and this
 * paragraph is kept because deleting it would erase why they all say the same
 * thing on the same date.
 *
 * WHICH SIDE OF THE CONTRADICTION WAS RIGHT, AND THE EVIDENCE: the banner.
 * All six tests in this file run and pass. `web/playwright.config.ts:70` sets
 * `testDir: './e2e'`, this file carries no `test.skip`/`test.fixme` and no
 * remaining `@needs-gpu` tag (stripped — see the top of this banner), and
 * commit `89aa9fe91d` (2026-08-12) records a full suite at **88 passed, 0
 * failed, twice, at about 1.5 minutes**, having discarded an earlier 84/4 run
 * because `web/src` moved underneath it — *a green over a mutating input is not
 * a green*. That is the run the per-test corrections below cite.
 *
 * ⚠ WHAT IS STILL NOT COVERED, AND IS THE POINT EACH ANNOTATION WAS MAKING:
 * a test passing does not prove the sub-claims its header listed as unproven.
 * Each correction below therefore says which of its listed items the run
 * actually observed and which remain read-not-watched. Only ONE of the four
 * was wrong about the tests running; **all four were right that a passing test
 * is not an assertion about everything it touches.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * `web/tests/tabs.test.ts` (node, `renderToStaticMarkup`) already proves the
 * ARIA wiring, the roving tabindex attribute, the stored-key round trip, and —
 * the one that matters — that an inactive panel's children are STILL IN THE
 * MARKUP. Its own header names what it cannot reach, and this file is that
 * list:
 *
 *   🔴 that a real tab click preserves the machine / workpiece / drawings /
 *      placements / report. **Markup keeping the subtree is not React keeping
 *      the state.** `renderToStaticMarkup` renders once and has no second
 *      render to lose anything between.
 *   🔴 that `Viewport`'s render loop actually STOPS when `paused` is set. That
 *      guard is the entire cost-justification for hiding rather than
 *      unmounting, and nothing anywhere has watched it go quiet.
 *   · that the arrow keys move FOCUS in a real browser (a `tabIndex` attribute
 *     in markup says where focus may go, not where it went).
 *   · that the stored tab survives a genuine reload, and that a corrupt value
 *     lands on the default.
 *   · that the CAD tree is not mounted until the tab is first visited, and
 *     never unmounts after.
 *
 * ---------------------------------------------------------------------------
 * NO NUMBER IN THIS FILE IS A MACHINING NUMBER
 * ---------------------------------------------------------------------------
 *
 * Everything numeric below is either an INPUT this test types (a travel, a
 * sheet size, an offset) or a wait in milliseconds. Nothing asserts a computed
 * quantity, so nothing here can pin the UI's own arithmetic — which this suite
 * has done three times and must not do a fourth. The assertions are all
 * *before === after* or *before !== after*.
 */

/** The first moment the tool library has arrived AND been rendered. */
async function panelsReady(page: Page) {
  await expect(page.getByTestId('tool-picker-trigger')).toContainText(
    'End Mill - Down-cut 6mm 2F',
    { timeout: 30_000 }
  );
}

/** Wait for the first plan to land, so assertions are not racing the WASM load. */
async function ready(page: Page) {
  await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
}

/**
 * ⚠ Both helpers above are COPIES of the ones in `slicer.spec.ts`, deliberately
 * and with the cost named. Playwright collects `*.spec.ts`, so a shared
 * `_helpers.ts` beside them would NOT be collected and is the right home for
 * these — but hoisting them means editing a 4,000-line spec that another change
 * is mid-flight in, and a helper moved under a live edit is how two files end up
 * disagreeing about what "ready" means. Filed as tidy-up rather than done here.
 */

/** A collapsed section keeps its contents out of the DOM entirely. */
async function openSectionByTestId(page: Page, testid: string) {
  const head = page.getByTestId(testid).locator('.panel-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

/**
 * Which tab the DOM currently says is selected — read off `aria-selected`.
 *
 * 🔴 SCOPED TO `tabbar` SINCE 2026-08-11, AND THE SCOPE IS THE FIX. This read was
 * `page.getByRole('tab', { selected: true })` over the WHOLE page and it resolved
 * to TWO elements the moment the CAD tab was visited: `cad/CadTab.tsx` renders a
 * SECOND, nested tab widget for its bottom dock (`role="tablist"`
 * aria-label="bottom pane", with `cad-dock-tab-*` children), and one of those is
 * always `aria-selected`. Strict mode then failed the assertion — a locator
 * fault, not an app fault, and it fails identically to a real double-selection.
 *
 * ⚠ Only the arrow-key test saw it, and that is not luck: the CAD subtree is
 * guarded by `cadSeen`, so the second tablist does not exist until a test opens
 * `2bee.cad`. Every earlier test in this file stays on the CAM tab.
 *
 * ⚠ WHAT THIS NO LONGER CATCHES, said rather than left to be discovered: an
 * app-level tab rendered OUTSIDE `tabbar` and claiming `aria-selected`. That is
 * the one thing the page-wide form would have caught, and it was already
 * indistinguishable from the CAD dock's tabs, which is why it caught nothing
 * useful. `Tabs.tsx` renders every app tab inside this one `tablist`, and the
 * order assertion below is scoped the same way.
 *
 * 🔴 The nesting itself is NOT what this scope decides. Two tablists on a page is
 * legal ARIA and each carries its own `aria-label`; whether the dock's tablist is
 * a COMPLETE tab widget is a separate question and is not answerable from a test
 * selector — see the note filed against `cad/CadTab.tsx`.
 */
async function selectedTab(page: Page) {
  return page.getByTestId('tabbar').getByRole('tab', { selected: true }).getAttribute('data-testid');
}

/** The testid of whatever has focus, or `null`. */
async function focusedTestId(page: Page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

test.describe('the four tabs', () => {
  // =========================================================================
  //  🔴 THE ONE THAT MATTERS
  // =========================================================================
  test('switching to 2bee.cad and back leaves the CAM tab exactly as it was', async ({ page }) => {
    /*
     * 🔴 THIS IS THE TEST THE TAB CHANGE WAS SHIPPED WITHOUT.
     *
     * `Tabs.tsx`'s central decision is *"an inactive panel is HIDDEN, never
     * unmounted"*, and its stated reason is that the CNC subtree holds the
     * machine, the workpiece, every drawing and its placement, the tool
     * selection and the last report — none of it derived, so React discarding
     * that subtree would silently reset a machine setup and throw away a plan,
     * and the panels would come back looking like a form nobody had filled in.
     *
     * The node suite proves the MARKUP keeps the subtree. That is a different
     * claim: `renderToStaticMarkup` renders once, so it has no second render to
     * lose state between, and a `display: none` that React nonetheless remounted
     * would pass every assertion in that file. Only a browser can answer this.
     *
     * ⚠ WHY THE SETUP IS DELIBERATELY NON-DEFAULT. If this test loaded the app
     * and switched tabs, every assertion would compare a default to a default
     * and a full remount would pass it. So a machine, a sheet, a real drawing
     * through the real importer and a PLACEMENT the test typed are all put in
     * first — a remount resets each of them to something different.
     *
     * ✅ RUN, AND GREEN, SINCE 2026-08-12 — this paragraph said `⚠ NEVER RUN`
     * and it was the tag, not the box, that kept it unrun. What it listed as
     * unproven is now observed: a `hidden` + `display:none` panel IS what React
     * leaves behind (every field below survives the switch, and the planning
     * observer reports zero re-plans, which a remount could not); and
     * `data-part-bboxes` IS republished on the first frame after the tab
     * returns.
     *
     * ⚠ THE 600ms SETTLE IS STILL A WAIT, NOT A MEASUREMENT, and it is still the
     * first suspect if this ever goes flaky. It has not been replaced with
     * `data-frames` — which would make it one — only because that would be a
     * change to a green test, and the frame counter is doing load-bearing work
     * one test below where it was actually needed.
     */
    await page.goto('/');
    await panelsReady(page);
    /* The landing tab is Designs (founder 2026-08-31). This test's SUBJECT is the
     * CNC tab, so it goes there explicitly rather than inheriting a default —
     * a precondition that is stated cannot silently become a different one. */
    await page.getByTestId('tab-cnc').click();

    // A machine and a sheet nobody's defaults would produce.
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page.getByTestId('stock-x').fill('1200');
    await page.getByTestId('stock-y').fill('900');
    await page.getByTestId('thickness').fill('15');

    // A real drawing through the real importer — not a fixture. The fixtures
    // bypass the importer, and `drawings` + `placements` are precisely the state
    // this test exists to protect.
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await ready(page);
    await expect(page.getByTestId('drawing-rows')).toContainText('plate.dxf');

    // ...and a placement the operator typed. A remount would zero these.
    await page.getByTestId('drawing-x-0').fill('33');
    await page.getByTestId('drawing-y-0').fill('21');
    await ready(page);

    await openSectionByTestId(page, 'panel-gcode');
    await page.getByTestId('toggle-gcode').click();

    /* Everything a re-mount or a re-plan would disturb, in one reader so the
     * before and after cannot drift apart. `data-part-bboxes` is the DRAWN
     * geometry's world box in bed millimetres — camera-independent, so it
     * measures the scene rather than where the scene is being looked at from. */
    const snapshot = async () => ({
      travelX: await page.getByTestId('travel-x').inputValue(),
      travelY: await page.getByTestId('travel-y').inputValue(),
      stockX: await page.getByTestId('stock-x').inputValue(),
      stockY: await page.getByTestId('stock-y').inputValue(),
      thickness: await page.getByTestId('thickness').inputValue(),
      drawingX: await page.getByTestId('drawing-x-0').inputValue(),
      drawingY: await page.getByTestId('drawing-y-0').inputValue(),
      rows: await page.getByTestId('drawing-rows').textContent(),
      tool: await page.getByTestId('tool-picker-trigger').textContent(),
      status: await page.getByTestId('status').textContent(),
      gouge: await page.getByTestId('sim-gouge').textContent(),
      uncut: await page.getByTestId('sim-uncut').textContent(),
      spoil: await page.getByTestId('sim-spoil').textContent(),
      gcode: await page.getByTestId('gcode').textContent(),
      bboxes: await page.getByTestId('viewport-canvas').getAttribute('data-part-bboxes'),
    });

    const before = await snapshot();
    expect(before.gcode && before.gcode.length, 'there is no program to preserve').toBeGreaterThan(
      500
    );
    expect(before.bboxes, 'no drawn part was published, so the picture leg is vacuous').toBeTruthy();

    /*
     * 🔴 THE "NO RE-PLAN" DETECTOR, AND ITS LIMIT, STATED BEFORE IT IS USED.
     *
     * `replan()` sets `busy` first and clears it in a `finally`, and `busy`
     * renders `<div class="busy">planning…</div>`. A `MutationObserver` over the
     * app records that node appearing even if it is removed again immediately —
     * observers keep the records, so this does not depend on catching a frame.
     *
     * 🔴 WHAT IT CANNOT SEE, so nobody reads a green here as more than it is:
     * if React never COMMITS the `busy` render — the wasm call is synchronous
     * and may finish inside the same microtask checkpoint that scheduled the
     * render — then no node is ever added and this observer stays empty through
     * a real re-plan. It is a one-sided detector: a hit is proof a plan ran, a
     * miss is not proof none did.
     *
     * 🔴 WHAT WOULD MAKE IT TWO-SIDED, filed and NOT built here because
     * `web/src/**` is another agent's: a monotonic counter published by `App` —
     * `data-plans` on the app root, incremented once per `replan()` — turns this
     * into `expect(after).toBe(before)`, which cannot miss. That is a product
     * change and a test migration is the wrong place to hide one.
     *
     * So the leg below is backed by the byte-equality of the emitted program and
     * the simulation verdicts, which is what a re-plan would have to preserve to
     * be harmless anyway.
     */
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__planningSeen = 0;
      const obs = new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (n instanceof HTMLElement && n.classList.contains('busy')) {
              w.__planningSeen = (w.__planningSeen as number) + 1;
            }
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      w.__planningObserver = obs;
    });

    // ── the round trip ────────────────────────────────────────────────────
    await page.getByTestId('tab-cad').click();
    await expect(page.getByTestId('cad-tab')).toBeVisible();
    await expect(page.getByTestId('tabpanel-cnc')).toBeHidden();

    await page.getByTestId('tab-cnc').click();
    await expect(page.getByTestId('tabpanel-cnc')).toBeVisible();
    // The first live frame after the pause clears is what republishes the
    // screen-derived attributes. Nothing here has watched it, so this is a wait
    // rather than a measurement — see the NEVER RUN note.
    // ⚠ 2026-08-27: that pointer is dangling. The note it sent you to no longer
    // says NEVER RUN — it was corrected to "✅ RUN, AND GREEN, SINCE 2026-08-12"
    // in this test's own header, where the 600ms settle is now discussed under
    // "THE 600ms SETTLE IS STILL A WAIT, NOT A MEASUREMENT". Read that paragraph.
    // The sentence above is still true: this is a wait, and it is the first
    // suspect if this test ever goes flaky.
    await page.waitForTimeout(600);

    const after = await snapshot();

    /* 🔴 FIELD BY FIELD, NOT AS ONE BLOB. `toEqual` on the whole object reports
     * "objects differ" and makes the reader diff two 40kB G-code strings by eye;
     * the machining fields are the ones an operator would lose, so each is named
     * and the program is compared last with its own sentence. */
    expect(after.travelX, 'the machine X travel was reset by a tab switch').toBe(before.travelX);
    expect(after.travelY, 'the machine Y travel was reset by a tab switch').toBe(before.travelY);
    expect(after.stockX, 'the sheet X size was reset by a tab switch').toBe(before.stockX);
    expect(after.stockY, 'the sheet Y size was reset by a tab switch').toBe(before.stockY);
    expect(after.thickness, 'the sheet thickness was reset by a tab switch').toBe(before.thickness);
    expect(after.rows, 'the drawings on the table did not survive a tab switch').toBe(before.rows);
    expect(after.drawingX, 'a placement the operator typed was reset by a tab switch').toBe(
      before.drawingX
    );
    expect(after.drawingY, 'a placement the operator typed was reset by a tab switch').toBe(
      before.drawingY
    );
    expect(after.tool, 'the chosen tool was reset by a tab switch').toBe(before.tool);
    expect(after.status, 'the plan verdict changed across a tab switch').toBe(before.status);
    expect(
      [after.gouge, after.uncut, after.spoil],
      'the simulation verdicts changed across a tab switch'
    ).toEqual([before.gouge, before.uncut, before.spoil]);
    expect(after.gcode, 'the emitted program changed across a tab switch').toBe(before.gcode);
    expect(after.bboxes, 'the drawn part moved across a tab switch').toBe(before.bboxes);

    // ...and the report is still THERE, not merely equal. Every field above is
    // also satisfied by an app that came back with nothing in it and rebuilt the
    // same answer, which is the outcome the mounting rule exists to prevent.
    await expect(page.getByTestId('gcode')).toBeVisible();

    const planned = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      (w.__planningObserver as MutationObserver).disconnect();
      return w.__planningSeen as number;
    });
    expect(
      planned,
      'the app re-planned across a tab switch — the CAM subtree was rebuilt, not hidden'
    ).toBe(0);
  });

  // =========================================================================
  //  🔴 THE GUARD THAT PAYS FOR HIDING RATHER THAN UNMOUNTING
  // =========================================================================
  test('the CNC viewport stops rendering while 2bee.cad is showing, and starts again', async ({
    page,
  }) => {
    /*
     * 🔴 THE OBSERVABLE IS `data-frames`, AND THE PREVIOUS ONE WAS THE DEFECT.
     *
     * `Viewport`'s `tick` returns early when `paused`, and the reason is stated
     * in the file: `display: none` does not stop a `requestAnimationFrame` loop,
     * and `resize()` falls back to 640x480 when the container measures zero — so
     * without the guard a hidden tab renders a full-size scene at full rate
     * forever. The node suite cannot see a render loop at all.
     *
     * 🔴 UNTIL 2026-08-12 THIS WATCHED `data-tool-probe` — THE CUTTER MARKER'S
     * SCREEN POSITION — AND FAILED ON A GUARD THAT WORKS. The lane that owns
     * `web/src` put counters inside both loops and measured the render loop
     * pausing and resuming correctly: **43 drawn frames per 700ms while showing,
     * four then zero while the CAD tab was up, 43 again per 700ms on return.**
     * What is frozen is the MARKER. The `plate` fixture is multi-tool, its one
     * `M0` sits at move 127 of 689, and the report charges 120 seconds for it
     * (`tool_change_seconds`, declared) — so at x10 the playhead reaches that
     * dwell about 2.8 seconds in and then stands on it for twelve wall-seconds.
     * 🔴 **REPRODUCED WITH NO TAB SWITCH AT ALL**, which is the whole finding: a
     * still marker means *"the renderer paused"* and *"the program is
     * legitimately standing still"* equally well, so the observable could not
     * distinguish the defect from correct behaviour in either direction. Leg (1)
     * was vacuous for the same reason — it passed only because it ran before the
     * dwell, by timing rather than by design.
     *
     * ⚠ AND THE CLOCK COULD NOT RESCUE IT. Playback is still RUNNING during a
     * dwell — that is why `play` stays pressed and why the clock keeps
     * advancing — so the control below separates a live page from a dead one and
     * has never been able to separate a live RENDERER from a still scene.
     *
     * 🔴 `data-frames` IS A FACT ABOUT THE RENDERER AND ABOUT NOTHING IN THE
     * SCENE. It is incremented in `Viewport.tsx` BELOW the `if (paused) return`,
     * so it counts DRAWN frames and not scheduled ones — a counter above that
     * line would tick all the way through a pause and report the opposite of
     * what it is for. A program standing still still draws; a paused loop does
     * not. That is the distinction this test needs and the marker never had.
     *
     * 🔴 THE NEGATIVE CONTROL IS STILL THE WHOLE POINT, and it is still needed:
     * `playback-clock` is React state driven by `App`'s OWN rAF loop, which is
     * not paused. Frames freezing is equally satisfied by the renderer stopping
     * and by the PAGE stopping. If the clock advances while the frame count does
     * not, the renderer stopped and the app did not — which is the claim.
     *
     * ⚠ `textContent()` is used for the clock rather than `toHaveText`, because
     * the transport is inside the HIDDEN panel while CAD is showing.
     * `textContent` reads a hidden element; an actionability-checked assertion
     * would wait for it to become visible and time out.
     *
     * ⚠ The equality in (2) is EXACT, not a tolerance. A frame counter that
     * advanced "only a little" while the tab was hidden is a guard that does not
     * work; there is no rate at which a paused loop is allowed to draw.
     *
     * -----------------------------------------------------------------------
     * 🔴 WATCHED RED, 2026-08-12 — three plants, one per assertion, each read
     *    for WHICH assertion it fired on and not merely for a red run. The
     *    previous version of this test was itself a red that fired for the
     *    wrong reason, so "it failed" is not evidence about anything.
     * -----------------------------------------------------------------------
     *
     *   delete the `tab-cad` click (the guard never fires)
     *       ✘ (2) "the CNC viewport kept drawing while the CAD tab was showing"
     *             — expected 77, received 118: FORTY-ONE frames drawn where the
     *             guard allows none, which is also the rate leg (1) measured.
     *   delete the `tab-cnc` click (the pause never lifts)
     *       ✘ (3) "the viewport did not resume drawing when its tab came back"
     *             — 68 vs 68, frozen.
     *   click `play` again before hiding (playback stopped, renderer fine)
     *       ✘ (2) THE CONTROL: "the playback clock did not advance… the page
     *             stopped, not the loop" — and note the frame assertion above it
     *             PASSED, because the renderer really did pause correctly. That
     *             is the plant proving the control is load-bearing rather than
     *             decorative.
     */
    await page.goto('/?fixtures=1');
    /* The landing tab is Designs (founder 2026-08-31). This test's SUBJECT is
     * the CNC viewport's render loop, so it goes to that tab explicitly rather
     * than inheriting a default — a stated precondition cannot silently become
     * a different one. */
    await page.getByTestId('tab-cnc').click();
    await ready(page);

    const canvas = page.getByTestId('viewport-canvas');
    /** Frames this viewport has DRAWN. Absent means the loop has not run once,
     *  which is a different failure from a loop that stopped — so it is read as
     *  a number and asserted, never coerced. */
    const frames = async () => {
      const s = await canvas.getAttribute('data-frames');
      expect(s, 'the viewport published no drawn-frame count at all').toBeTruthy();
      return Number(s);
    };
    const clock = () => page.getByTestId('playback-clock').textContent();

    await expect(page.getByTestId('play')).toBeEnabled();
    await page.getByTestId('speed-x10').click();
    await page.getByTestId('play').click();
    await expect(page.getByTestId('play')).toHaveAttribute('aria-pressed', 'true');

    // (1) The loop is LIVE. Without this the rest proves nothing — a counter
    // that never advances is frozen in every state.
    const liveA = await frames();
    await page.waitForTimeout(700);
    const liveB = await frames();
    expect(
      liveB,
      'the viewport drew no frames while its own tab was showing, so the freeze assertions ' +
        'below cannot distinguish a paused renderer from one that never started'
    ).toBeGreaterThan(liveA);

    // (2) Hidden ⇒ idle. Measured 2026-08-12: four frames land between the click
    // and the prop reaching the loop, then zero — so the first 700ms wait is what
    // makes the pair below a measurement of the paused state rather than of the
    // transition into it.
    await page.getByTestId('tab-cad').click();
    await expect(page.getByTestId('cad-tab')).toBeVisible();
    await page.waitForTimeout(700);
    const hiddenFramesA = await frames();
    const hiddenClockA = await clock();
    await page.waitForTimeout(700);
    const hiddenFramesB = await frames();
    const hiddenClockB = await clock();

    expect(
      hiddenFramesB,
      'the CNC viewport kept drawing while the CAD tab was showing — the paused prop ' +
        'is not reaching the render loop'
    ).toBe(hiddenFramesA);

    // The control: the app was still running the whole time.
    expect(
      hiddenClockB,
      'the playback clock did not advance while the tab was hidden, so the frozen frame ' +
        'count above says nothing about the renderer — the page stopped, not the loop'
    ).not.toBe(hiddenClockA);

    // (3) ...and it comes back. A pause that never lifts would satisfy (2)
    // forever and leave the operator with a dead canvas.
    //
    // ⚠ This leg no longer depends on playback still running — the loop draws
    // whether or not a program is playing, which is precisely why the frame
    // count can prove a resume and the marker could not. The `play` assertion is
    // kept because the CLOCK CONTROL above depends on it: playback that ended
    // while the tab was hidden would make a frozen clock mean nothing.
    await page.getByTestId('tab-cnc').click();
    await expect(page.getByTestId('tabpanel-cnc')).toBeVisible();
    await expect(
      page.getByTestId('play'),
      'playback finished while the tab was hidden, so the clock control in (2) was reading ' +
        'a stopped transport — shorten the waits above rather than loosening this'
    ).toHaveAttribute('aria-pressed', 'true');

    const backA = await frames();
    await page.waitForTimeout(700);
    const backB = await frames();
    expect(
      backB,
      'the viewport did not resume drawing when its tab came back'
    ).toBeGreaterThan(backA);
  });

  // =========================================================================
  //  WHICH TAB OPENS
  // =========================================================================
  test('the tab you chose is the tab you get back after a reload', async ({ page }) => {
    /*
     * ⚠ NEVER RUN. Unproven here: that `Run` is reachable by click at all (it is
     * a real `<button role="tab">` in the markup and has never been pressed), and
     * that the write happens before a reload can race it — `rememberTab` is a
     * synchronous `localStorage.setItem` inside the click handler, so there is no
     * window for a race, but that is read rather than observed.
     *
     * ✅ CORRECTED 2026-08-27 — `⚠ NEVER RUN` IS FALSE. This test runs and passes;
     * see the file banner for the evidence (`89aa9fe91d`, 2026-08-12, 88/0 twice).
     * Stale in the UNDERSTATED direction — it disowned a green it had earned.
     *
     * OF THE TWO THINGS THE LINE ABOVE LISTED AS UNPROVEN, ONE IS NOW OBSERVED AND
     * ONE IS NOT, and the split is the reason this is corrected rather than cut:
     *   ✅ `Run` IS reachable by click. `page.getByTestId('tab-run').click()` below
     *      is a real press on the real `<button role="tab">`, and the assertion on
     *      the next line reads `tab-run` back as selected. It has now been pressed.
     *   🔴 THE RACE IS STILL READ, NOT WATCHED. A passing test does not observe an
     *      ordering it never had a way to lose: `rememberTab`'s write is synchronous
     *      inside the click handler, so there is no window here for `reload()` to
     *      race, which means this test would pass identically against an
     *      implementation that deferred the write and got lucky. Nothing in this
     *      file can separate those two.
     */
    await page.goto('/');
    await panelsReady(page);

    // The default first, so the assertion after the reload is a CHANGE and not a
    // coincidence. `DEFAULT_TAB` comes from the product, not from this file.
    expect(await selectedTab(page)).toBe(`tab-${DEFAULT_TAB}`);

    await page.getByTestId('tab-run').click();
    expect(await selectedTab(page)).toBe('tab-run');
    /* ⚠ `tabpanel-run`, NOT anything the Run tab happens to SAY. This file tests
     * the tab machinery; the Run tab's content is being rewritten in `web/src/`
     * as this is written and `run-not-built` — the obvious thing to reach for —
     * is already gone from the working tree while still present at HEAD. A test
     * of tabs that fails because another lane changed a sentence is a test that
     * gets loosened for the wrong reason. */
    await expect(page.getByTestId('tabpanel-run')).toBeVisible();

    // It is in storage under the product's own key, BEFORE the reload — so a
    // failure separates "it never stored" from "it stored and did not restore".
    expect(await page.evaluate((k) => localStorage.getItem(k), TAB_KEY)).toBe('run');

    await page.reload();
    await panelsReady(page);

    expect(await selectedTab(page), 'the chosen tab did not survive a reload').toBe('tab-run');
    await expect(page.getByTestId('tabpanel-run')).toBeVisible();
    await expect(page.getByTestId('tabpanel-cnc')).toBeHidden();
  });

  test('a stored tab that is not a tab opens the default, and a stored tab that IS one does not', async ({
    page,
  }) => {
    /*
     * 🔴 THE SECOND HALF IS WHAT MAKES THIS A TEST. "Garbage lands on the
     * default" is satisfied perfectly by an app that ignores the stored value
     * altogether and always opens `2bee.cnc` — which is the same string the
     * default is. So a VALID stored value is checked in the same test, and it
     * must NOT land on the default.
     *
     * The garbage values are the ones `Tabs.tsx` names as the realistic ways this
     * key goes bad: `'operation'`, the name the third tab does NOT have (the file
     * says so explicitly, and #76 called it that), and `'"cnc"'` — JSON-quoted,
     * which `rememberTab` never writes but a hand-edit or a different serialiser
     * would.
     *
     * ⚠ SEEDED BY `evaluate` + `reload`, NOT BY `addInitScript`, and that is a
     * correctness point rather than a style one. An init script runs before page
     * scripts on EVERY navigation, so it would re-write the seed after each
     * `reload()` below — the third leg would then be reading `'operation'` while
     * claiming to read `'run'`, and would fail while looking like a product
     * defect. Seeding into the live page and reloading leaves exactly one writer.
     *
     * ⚠ NEVER RUN. Unproven here: that the value is read early enough to decide
     * the first paint — `App` reads it in a `useState` initialiser, so it is read
     * at first render, but nothing has watched the ordering.
     *
     * ✅ CORRECTED 2026-08-27 — `⚠ NEVER RUN` IS FALSE. This test runs and passes
     * (file banner; `89aa9fe91d`, 2026-08-12, 88/0 twice). UNDERSTATED.
     *
     * 🔴 BUT THE UNPROVEN ITEM IS STILL UNPROVEN, and stays written down. The three
     * legs below assert WHICH TAB ENDS UP SELECTED after a reload; none of them can
     * see WHEN the stored value was read. A build that mounted on `DEFAULT_TAB` and
     * corrected itself in an effect would satisfy every assertion here and flash the
     * wrong tab on first paint. "It is a `useState` initialiser" is still read off
     * the source, not observed — the same class of claim this suite exists to stop
     * trusting. ⚠ Do not let a green on this test be read as covering first paint.
     */
    await page.goto('/');
    await panelsReady(page);

    await page.evaluate((k) => localStorage.setItem(k, 'operation'), TAB_KEY);
    await page.reload();
    await panelsReady(page);
    expect(
      await selectedTab(page),
      'a stored value that names no tab did not fall back to the default'
    ).toBe(`tab-${DEFAULT_TAB}`);

    // JSON-quoted: a plausible corruption, and not a tab id.
    await page.evaluate((k) => localStorage.setItem(k, '"cnc"'), TAB_KEY);
    await page.reload();
    await panelsReady(page);
    expect(
      await selectedTab(page),
      'a JSON-quoted stored value was accepted as a tab id'
    ).toBe(`tab-${DEFAULT_TAB}`);

    // 🔴 THE CONTROL. A valid stored value must be HONOURED, or every assertion
    // above passes on an app that reads nothing.
    await page.evaluate((k) => localStorage.setItem(k, 'run'), TAB_KEY);
    await page.reload();
    await panelsReady(page);
    expect(
      await selectedTab(page),
      'a VALID stored tab was ignored, so the fallback assertions above prove nothing'
    ).toBe('tab-run');
  });

  // =========================================================================
  //  KEYBOARD
  // =========================================================================
  test('the arrow keys move between tabs, wrap at both ends, and take focus with them', async ({
    page,
  }) => {
    /*
     * A shop is a place where somebody's other hand is on the machine, which is
     * the reason `Tabs.tsx` gives for implementing the WAI-ARIA pattern rather
     * than approximating it. The node suite can assert the `tabIndex` ATTRIBUTE;
     * only a browser can assert that pressing a key MOVED THE FOCUS — and with
     * roving tabindex, selecting a tab without moving focus strands the keyboard
     * user on an element that is no longer in the tab order.
     *
     * Activation is automatic (arrow = move + select), so every step asserts
     * BOTH: which tab reports selected, and which element has focus. Asserting
     * one would pass on an implementation that did the other.
     *
     * ⚠ NEVER RUN. Unproven here: that clicking a tab leaves focus on it (the
     * handler calls `.focus()` explicitly, read not watched), and that visiting
     * `2bee.cad` by keyboard does not throw before the next key lands — the CAD
     * preview is a second WebGL canvas and this box has none.
     *
     * ✅ CORRECTED 2026-08-27, AND THIS ONE WAS WRONG TWICE OVER. `⚠ NEVER RUN` is
     * false — the test runs and passes (file banner; `89aa9fe91d`, 2026-08-12, 88/0
     * twice). And its stated REASON is false too: **"this box has none" was never
     * true.** The GPU was always in the machine; `Disabled` is what this box prints
     * when Chromium is launched with `--use-gl=swiftshader`, which
     * `playwright.config.ts` was asking for BY NAME. Three agents measured it and
     * all three inferred a missing GPU from a configured one — the correction is at
     * the top of this file, dated 2026-08-12, and this annotation kept repeating the
     * refuted claim underneath it. **A stale reason is worse than a stale verdict:
     * nobody re-tests a blocker that names a cause.**
     * BOTH ITEMS THE LINE ABOVE LISTED AS UNPROVEN ARE NOW OBSERVED — so this
     * annotation is fully discharged, which none of the other three are:
     *   ✅ A CLICKED TAB TAKES FOCUS. The seed step below is a real `.click()` on
     *      `tab-cnc` followed by
     *      `expect(await focusedTestId(page), 'a clicked tab did not take focus')
     *      .toBe('tab-cnc')`. The handler's `.focus()` is now watched, not read.
     *   ✅ VISITING `2bee.cad` BY KEYBOARD DOES NOT THROW — the wrap steps land on
     *      it and every following key is still asserted, on both legs.
     */
    await page.goto('/');
    await panelsReady(page);

    // Order is shop, cad, cnc, run — the founder's, asserted here as the basis
    // the wrap steps below depend on rather than assumed by them. `Designs` was
    // added at the FRONT on 2026-08-31, which moved both ends of the wrap: this
    // assertion is what turned that into three named failures instead of a
    // silently different meaning for every `step` below.
    const order = await page
      .getByTestId('tabbar')
      .locator('[role=tab]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(order, 'the tab order changed, so the wrap assertions below mean something else').toEqual(
      ['tab-shop', 'tab-cad', 'tab-cnc', 'tab-run']
    );

    await page.getByTestId('tab-cnc').click();
    expect(await focusedTestId(page), 'a clicked tab did not take focus').toBe('tab-cnc');

    const step = async (key: string, want: string, why: string) => {
      await page.keyboard.press(key);
      expect(await selectedTab(page), `${why}: wrong tab selected`).toBe(want);
      expect(await focusedTestId(page), `${why}: selection moved and focus did not`).toBe(want);
    };

    await step('ArrowRight', 'tab-run', 'right from the middle');
    await step('ArrowRight', 'tab-shop', 'right from the LAST tab must wrap to the first');
    await step('ArrowLeft', 'tab-run', 'left from the FIRST tab must wrap to the last');
    await step('Home', 'tab-shop', 'Home');
    await step('End', 'tab-run', 'End');

    // Roving tabindex, in the live DOM: exactly one tab is in the page's tab
    // order and it is the selected one.
    const tabindexes = await page
      .getByTestId('tabbar')
      .locator('[role=tab]')
      .evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('data-testid')}=${e.getAttribute('tabindex')}`)
      );
    expect(tabindexes, 'the roving tabindex is not roving').toEqual([
      'tab-shop=-1',
      'tab-cad=-1',
      'tab-cnc=-1',
      'tab-run=0',
    ]);
  });

  // =========================================================================
  //  MOUNTING
  // =========================================================================
  test('the CAD tree is not built until the tab is opened, and never torn down after', async ({
    page,
  }) => {
    /*
     * 🔴 TWO PROPERTIES, AND THEY PULL IN OPPOSITE DIRECTIONS, WHICH IS WHY
     * BOTH ARE HERE.
     *
     * `App` guards the CAD subtree with `cadSeen`, so a FIRST page load renders
     * no CAD at all — that is what keeps a fresh load byte-for-byte the thing the
     * rest of this suite drives, and every other test in `web/e2e/` silently
     * depends on it. But once opened it must NEVER unmount, because its state is
     * the source the user is typing.
     *
     * A build that mounted CAD eagerly passes the second and fails the first; a
     * build that unmounted it on switch passes the first and fails the second.
     *
     * ⚠ The panel WRAPPER (`tabpanel-cad`) exists from the first render either
     * way — it is the `hidden` container. What is absent before the first visit
     * is its CONTENT (`cad-tab`). Asserting the wrapper would pass in both
     * worlds, which is why the assertion names the content.
     *
     * ⚠ NEVER RUN. Unproven here: that `cad-source` accepts a `fill()` (it is a
     * controlled `<textarea>`, so the value goes through React state and comes
     * back — read, not watched), and that evaluating the typed source does not
     * throw on this box before the assertion lands.
     *
     * ✅ CORRECTED 2026-08-27 — `⚠ NEVER RUN` IS FALSE. Runs and passes (file
     * banner; `89aa9fe91d`, 2026-08-12, 88/0 twice). UNDERSTATED. ⚠ And as with the
     * arrow-key test above, *"on this box"* leans on the missing-GPU story that was
     * refuted on 2026-08-12 — the flag was `--use-gl=swiftshader`, not absent
     * hardware.
     *   ✅ NOW OBSERVED: `cad-source` accepts a `fill()` and gives the value back.
     *      The round trip through React state is asserted directly below —
     *      `.fill(src)` then `toHaveValue(src)` — so this is watched, not read.
     *   ✅ NOW OBSERVED: evaluating the typed source does not throw before the
     *      assertions land; the tab-switch assertions after it all run.
     *   🔴 STILL NOT COVERED, and it is the claim a reader is most likely to take
     *      from a green here: nothing in this test says the typed source produces
     *      the RIGHT GEOMETRY. It asserts the textarea round-trips and that the CAD
     *      subtree mounts once and never unmounts. Whether `2bee.cad` evaluates that
     *      source into the same solid OpenSCAD does is gates `CAD1`/`CAD1H`, and
     *      they are not green — see `CAD1H_BASELINE` in the gate runner.
     */
    await page.goto('/');
    await panelsReady(page);

    await expect(page.getByTestId('tabpanel-cad')).toHaveCount(1);
    await expect(
      page.getByTestId('cad-tab'),
      'the CAD tree is mounted on a first page load, so a fresh load is no longer what the ' +
        'rest of this suite drives'
    ).toHaveCount(0);

    await page.getByTestId('tab-cad').click();
    await expect(page.getByTestId('cad-tab')).toBeVisible();

    // Something only this test would have typed.
    const src = 'cube([12, 34, 56]);';
    await page.getByTestId('cad-source').fill(src);
    await expect(page.getByTestId('cad-source')).toHaveValue(src);

    await page.getByTestId('tab-cnc').click();
    await expect(page.getByTestId('tabpanel-cnc')).toBeVisible();
    // Still in the document, and hidden rather than removed.
    await expect(
      page.getByTestId('cad-tab'),
      'the CAD tree was torn down on a tab switch — the source being typed is lost'
    ).toHaveCount(1);
    await expect(page.getByTestId('tabpanel-cad')).toBeHidden();

    await page.getByTestId('tab-cad').click();
    await expect(
      page.getByTestId('cad-source'),
      'the CAD source did not survive a round trip — the markup kept the subtree and React ' +
        'did not keep its state'
    ).toHaveValue(src);
  });
});
