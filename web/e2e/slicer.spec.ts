import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { seedTab } from './tab';

import { coords, coordsByPart, spanOf } from './gcode.ts';

/* The landing tab is Designs; this suite is about the CNC tab. See e2e/tab.ts. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

// ESM: no __dirname. The package is type:module, so the CommonJS globals are
// absent and referencing one fails at IMPORT time — which surfaces as
// "No tests found", not as a test failure.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../../target/release/2bee-slice');

/*
 * =============================================================================
 * 🔴 A TEMP DIR THAT SURVIVES THE TEST — CLEANED WHERE A THROW CANNOT SKIP IT.
 * =============================================================================
 *
 * Two tests in this file wrote a config into `mkdtempSync` and never removed
 * it. Measured 2026-08-12 on this box: **11 `slicer-parity-*` and 11
 * `2bee-tools-*` directories in `/tmp`**, one per run since the sites were
 * written, alongside 15 from `gcode-reader.spec.ts` — 37 in total, and it grows
 * by three every full run. `/tmp` inode exhaustion has taken this fleet down
 * before.
 *
 * 🔴 THE CLEANUP IS IN AN `afterEach`, NOT AT THE FOOT OF THE TEST, AND THAT IS
 * THE WHOLE POINT. A `rmSync` on the last line runs only when everything above
 * it passed — so the dirs would be removed on exactly the runs that did not
 * need investigating, and kept on the failing runs where nobody is looking for
 * them. **A leak that only happens when the suite is red is a leak that only
 * happens when the suite is red.** `afterEach` runs after a pass, a failed
 * assertion, a timeout and a throw alike.
 *
 * `force: true` so a test that never reached its `tempDir()` call is not a
 * second failure on the way out — the hook must not be able to fail a test that
 * had already made its point.
 */
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
test.afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

/** Wait for the first plan to land, so assertions are not racing the WASM load. */
async function ready(page: Page) {
  await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
}

/**
 * `ready()`, then RESOLVE THE Z-RE-REFERENCE SEAM, so a test that is about
 * something else can obtain a program at all.
 *
 * 🔴 READ THIS BEFORE ADDING A CALL — IT IS NOT A "MAKE IT PASS" HELPER, AND
 * THE THING IT CLEARS IS THE APP BEING RIGHT.
 *
 * `?fixtures=1` opens on `plate`, which is MULTI-TOOL. A tool change requests a
 * Z re-reference; `App.tsx` opens with `probeEnabled ?? false`; and the core
 * then refuses the whole program with *"a Z re-reference was requested but the
 * machine has no probe — Z would stay referenced to the previous tool's
 * length"*. That refusal is correct — core decision #43 made
 * `Machine::touch_plate_mm` an `Option<f64>` that refuses when undeclared,
 * because **an undeclared plate must not silently zero the datum** — and the
 * browser default was flipped to `false` deliberately on 2026-08-09.
 *
 * ⚠ SO THE FOURTEEN TESTS THAT WENT RED WERE NOT A REGRESSION AND ARE NOT
 * ENVIRONMENTAL. They were asserting `runnable` on precisely the combination
 * the product now refuses. `158658175e` measured the cause three independent
 * ways (in the browser both directions; byte parity with the CLI, which exits 1
 * with the identical sentence; and `2bee-slice job plate` exiting 0 with four
 * `G38.2` moves because **the CLI default is not the browser default**). It is a
 * SEAM NOTHING WATCHES — which is why `the browser opens refusing the default
 * multi-tool fixture, and says which of the two resolutions to pick` is a test
 * in this file now, and why this helper exists instead of the assertion being
 * quietly deleted from twelve places.
 *
 * 🔴 IT UNTICKS `probe-after-change`; IT DOES NOT TICK `probe-enabled`. The two
 * resolutions are NOT interchangeable here:
 *   · **untick the re-reference** — the request goes away, and **not one byte of
 *     the emitted program changes** relative to what these tests were written
 *     against. There was no probe block to begin with.
 *   · **declare a probe + plate** — also runnable, and it INSERTS a `G38.2`
 *     preamble and a probe move at every tool change. Any test asserting on
 *     G-code content, move counts, layer colours or the coloured bar would then
 *     be measuring a different program.
 * The second is the right choice exactly once — in `the browser and the CLI emit
 * byte-identical G-code`, which does tick `probe-enabled` and fill
 * `touch-plate-mm`, because parity over a program that omits the newest and most
 * safety-critical block this post emits covers less. Do not copy that pattern
 * into a test that is not about the probe.
 */
async function readyRunnable(page: Page) {
  await ready(page);
  await page.getByTestId('probe-after-change').uncheck();
  await expect(page.getByTestId('status')).toHaveText('runnable');
}

/** The G-code panel starts collapsed, so its contents are NOT in the DOM until
 *  the section is opened. Reaching for a control inside a collapsed section
 *  fails as a timeout, which reads like a broken app rather than a closed
 *  drawer. */
async function openGcode(page: Page) {
  const head = page.getByTestId('panel-gcode').locator('.panel-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

/** Console errors are collected per test — a page that logs an error while
 *  LOOKING correct is the exact failure a screenshot test misses. */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/**
 * The side panels are live BEFORE anything is planned — the tool library is
 * fetched on its own, not out of a report. A test that only needs a control
 * must therefore NOT use `ready()`: with no drawing chosen the app deliberately
 * plans nothing, there is no `status` at all, and waiting for one times out in
 * a way that reads as a broken app rather than as an empty one.
 *
 * The sentinel is the tool picker's trigger carrying the default tool — the
 * first moment the library has arrived AND been rendered.
 */
async function panelsReady(page: Page) {
  await expect(page.getByTestId('tool-picker-trigger')).toContainText(
    'End Mill - Down-cut 6mm 2F',
    { timeout: 30_000 }
  );
}

/**
 * Choose one row in a SINGLE-select ObjectPicker: open the trigger, click the
 * row, which commits and closes. Multi-select pickers stay open and need their
 * own `-done`, so this helper deliberately does not cover them — one helper
 * that silently does two different things is how a test ends up asserting the
 * wrong mode's contract.
 */
async function pickOne(page: Page, picker: string, id: string) {
  await page.getByTestId(`${picker}-trigger`).click();
  await page.getByTestId(`${picker}-opt-${id}`).click();
  await expect(page.getByTestId(`${picker}-list`)).toHaveCount(0);
}

/**
 * Put exactly these drawings on the table.
 *
 * 🔴 `drawing-picker` became MULTI-select on 2026-08-10 (founder: *"I should
 * able to add more than 1 drawings"*), so it does NOT close on a row click and
 * `pickOne` cannot drive it: that helper asserts the list closed, which is the
 * single-select contract. Two helpers rather than one that silently does both,
 * for the reason `pickOne`'s own header gives — a helper covering two modes is
 * how a test ends up asserting the wrong mode's contract.
 *
 * Every id is clicked, so calling this with a row that is ALREADY on the table
 * takes it off. That is the control's real behaviour and the helper does not
 * hide it.
 */
async function pickDrawings(page: Page, ...ids: string[]) {
  await page.getByTestId('drawing-picker-trigger').click();
  for (const id of ids) await page.getByTestId(`drawing-picker-opt-${id}`).click();
  await page.getByTestId('drawing-picker-done').click();
  await expect(page.getByTestId('drawing-picker-list')).toHaveCount(0);
}

/*
 * `coordsByPart` — the per-part reader — MOVED to `./gcode.ts` on 2026-08-11,
 * and it did not survive the move unchanged.
 *
 * 🔴 It was reading the part name with `(\S+)`, so it stopped at the first
 * space: `Hive super end/part1` arrived here as `Hive`, and two drawings whose
 * ids share a first word arrived as ONE key holding both their coordinates.
 * The reason it moved is the reason it was broken — a helper living inside a
 * spec file cannot be tested (importing a spec registers its tests twice), so
 * the one instrument every multi-drawing assertion depends on had nothing
 * watching it. `gcode-reader.spec.ts` is that test; the fix is in `gcode.ts`.
 *
 * ⚠ **THE SAME ARGUMENT WENT ONE LAYER DEEPER ON THE SAME DAY, and this comment
 * was the thing that hid it.** It said the multi-drawing tests read through
 * *"one reader"* — true of `coordsByPart` from the moment it moved, and **false
 * of the XY scanner underneath it**, which this file still carried TWO more
 * hand-written copies of: one in the drag test, one in the rotation test. Three
 * copies of the loop that decides what counts as a position, one of them
 * tested. They are now `coords` / `spanOf` / `coordsByPart`, all built on
 * `readProgram` in `./gcode.ts`, so the sentence above is true of the scanner
 * too rather than only of the thing sitting on it.
 */

/**
 * The per-instance tables the viewport publishes on the canvas, parsed.
 *
 * 🔴 JSON, and keyed on the CORE'S OWN INSTANCE IDS — never on a row index.
 * `data-part-bboxes` is each drawn drawing's world box in BED MILLIMETRES;
 * `data-part-probes` is its centre in canvas CSS pixels. A caller that wants to
 * grab one part must read the second and a caller that wants to prove the
 * picture agrees with the program must read the first, and both must name the
 * part the way the program names it — an index would be a parallel key, which is
 * exactly the drift that made every drag move the same drawing.
 *
 * Returns `{}` when the attribute is absent, which is a real state (nothing
 * grabbable is drawn) and not an error — the caller asserts on the keys.
 */
async function partTable(page: Page, attr: 'bboxes' | 'probes') {
  const raw = await page.getByTestId('viewport-canvas').getAttribute(`data-part-${attr}`);
  const parsed: Record<string, string> = raw ? JSON.parse(raw) : {};
  const nums: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(parsed)) nums[k] = v.split(',').map(Number);
  return nums;
}

/*
 * ===========================================================================
 * 🔴 THE TAG `@needs-gpu` IS GONE AS OF 2026-08-12. ITS PREMISE WAS FALSE AND
 *    IT HAD NO MEMBERS LEFT THAT WERE ENVIRONMENTAL.
 * ===========================================================================
 *
 * WebGL on this box was **BLOCKLISTED, NOT MISSING.** `playwright.config.ts`
 * was asking for `--use-gl=swiftshader`, which on this machine produces NO
 * CONTEXT AT ALL; the flags that work are `--use-gl=angle --use-angle=gl-egl`,
 * and they reach an RTX 4090. See that file's header for the four-case
 * measurement. **The 17 tests it covered were selected from error text produced
 * by a browser that had been told to use software rasterisation.**
 *
 * FULL RUN AT THE CORRECTED FLAGS, 2026-08-12 — **83 passed / 5 failed of 88**
 * in 1.7 minutes (it was 7.1). Of the 17 tagged tests, **13 PASSED.** Four
 * failed, and NOT ONE on WebGL — every one got a real accelerated context and
 * then failed an assertion about behaviour. All four are now accounted for:
 *
 *   ✘ a grab that lands on a part never becomes a…   THE SHEET DATUM MOVED,
 *                                                      0,0 → 134.1,7.1
 *        FIXED at `a22db8403b`. The viewport was publishing `data-part-probe`
 *        as the projected BBOX CENTRE, which is fresh air over a DXF — a
 *        drawing is drawn as walls, hollow and open at the top, so the ray
 *        sailed through to the sheet. The arithmetic was never wrong; the aim
 *        was.
 *   ✘ a grab moves the drawing under the pointer…    same cause, same fix.
 *   ✘ the cutter at the head has its own layer chip… REWRITTEN below. The chip
 *        works; the COLOUR NEEDLE missed the lit marker by one on blue, and no
 *        tolerance could have fixed it. Read that test's own header.
 *   ✘ the CNC viewport stops rendering while 2bee.cad…  REWRITTEN in
 *        `tabs.spec.ts`. The renderer pauses and resumes correctly; the marker
 *        it was watching stands still on a 120-second tool-change dwell.
 *
 * 🔴 THOSE FOUR WERE REAL AND THEY WERE HIDING BEHIND AN ENVIRONMENTAL LABEL —
 * which is the whole hazard this banner was written about, arriving from the
 * direction nobody was watching. **Two of the four were defects in the TESTS,
 * and an environmental tag hid those exactly as well as it hid the product
 * one.** A label that explains a failure stops anybody asking what the failure
 * is.
 *
 * ⚠ RE-MEASURED SERIALLY at the time (`--workers=1 --repeat-each=2`): all four
 * failed, twice, with BYTE-IDENTICAL error text. Not load, not contention, not
 * flake.
 *
 * 🔴 SO THE TAG WAS STRIPPED — 15 declarations across three files — RATHER THAN
 * LEFT MEANING NOTHING. A tag whose every member is environmental is a
 * quarantine; a tag with no such member is a label that makes a real failure
 * look explained. `--grep-invert @needs-gpu` was quoted as a green contract in
 * three file headers and it is quoted nowhere now: **there is one suite, it is
 * run whole, and there is no invert to type.** The four titles above are the
 * record of what the tag was carrying at the end.
 *
 * ⚠ THE COUNT MISLED FIVE TIMES, WHICH IS WHY THE TITLES ARE WRITTEN OUT ABOVE
 * AND THE NUMBER IS NOT. *"N failures, all environmental"* has to be re-derived
 * by reading titles, and a real regression hides inside it — measured at
 * `2c4f75b693`, **23 failures, of which 14 were NOT environmental.** Twelve were
 * one product seam (see `readyRunnable()`), one was a plant that has stopped
 * refusing, and one was a canvas overlay. Every one of them had been carried
 * inside an "all environmental" total. **Report a run by title, never by count.**
 *
 * ⚠ AND THE OBVIOUS SELECTOR WAS THE WRONG ONE, which is the reason not to
 * rebuild this tag from a grep if somebody wants it back: `viewport-canvas`
 * catches 12 of the 17 and misses five that never mention it, and it cannot
 * reach `tabs.spec.ts` or `dev-server.spec.ts` at all. A tag is applied from an
 * OBSERVED failure with its error read, never from a testid.
 *
 * ---------------------------------------------------------------------------
 * 🔴 CORRECTED 2026-08-11 — THE BANNER THIS REPLACES WAS A STALE RED, AND A
 *    STALE RED LIES EXACTLY LIKE A STALE GREEN.
 * ---------------------------------------------------------------------------
 *
 * It said *"EVERY test in this file fails at mount"* and *"nothing written or
 * changed on 2026-08-10 evening has been run"*. Both were true when written and
 * both were false by the time anyone acted on them: a full run at
 * `2c4f75b693` was **58 passed / 23 failed of 81**, and this file's own share
 * was 19 failures out of 59 tests. A header claiming total blindness is the
 * reason nobody looked at which tests were red — and the answer, when someone
 * finally did, was that most of them were red for a reason that had nothing to
 * do with a GPU.
 *
 * ⚠ CORRECTED AGAIN 2026-08-12. This paragraph used to read: *"The box does
 * report `GL_VENDOR = Disabled` and Chromium genuinely cannot create a WebGL
 * context, so `three.js` throws and anything that needs a mounted `Viewport`
 * cannot pass here. That is real…"* — **it was not real, it was configured.**
 * `GL_VENDOR = Disabled` is exactly what this box prints when Chromium is
 * launched with `--use-gl=swiftshader`, and it is reproducible on demand:
 * `E2E_GL_PLANT=swiftshader` brings that identical string back with the 4090
 * still in the machine. The observation was correct and the inference from it
 * was not, for three agents in a row.
 *
 * The standard the old paragraph invoked still holds and now cuts the other
 * way: *"a gate nobody has watched go red is not a gate"*. Those 17 have now
 * been watched. **Thirteen went green and four went red on their own merits** —
 * so thirteen stopped being comments with a `test()` around them, and four
 * turned out to be pointing at something.
 *
 * Each such test carries its own `⚠ NEVER RUN` line naming what is unproven
 * about it, rather than relying on this banner: an excerpt of one test does not
 * carry the header of its file, and the reader who trusts a test is reading the
 * test.
 *
 * What WAS measured, and is therefore not a guess, is stated per test as
 * `MEASURED:` with the command that produced it. Those came from the release
 * CLI and from reading `web/src/**`, both of which run here. Nothing marked
 * MEASURED is a browser observation.
 *
 * ---------------------------------------------------------------------------
 * 🔴 A MIGRATION IS WORSE THAN A NEW TEST HERE, AND THE 2026-08-11 PASS IS ALL
 *    MIGRATION. A new test that is wrong FAILS the day somebody runs it. A
 *    migrated test that is wrong can go GREEN FOR THE WRONG REASON — a locator
 *    that now matches something else, or an assertion satisfied by a state the
 *    test never intended. Two shapes of that are live in this file since the
 *    view toggles moved into the sidebar panels:
 *
 *      · `toHaveCount(0)` on a `kind-<layer>` control is satisfied both by
 *        "the layer is not offered" (the claim) and by "its panel is shut"
 *        (nothing checked). It fails as a COUNT, so it returns instantly and
 *        never looks stuck. Every such assertion is now preceded by
 *        `expectSectionOpen`.
 *      · A single tri-state `section-eye-all` replaced the directional
 *        `kinds-all-on` / `kinds-all-off` pair. One click means "hide" or
 *        "show" depending on the state it starts from, so both call sites
 *        assert `aria-pressed` BEFORE clicking.
 *
 *    So each migrated block below says what its assertion is FOR, not only
 *    what it matches.
 *
 * ⚠ `npx tsc --noEmit` DOES NOT TYPECHECK THIS FILE. `web/tsconfig.json` has
 *    `"include": ["src"]`, and `@types/node` is not installed — so the
 *    `node:child_process` / `node:fs` imports at the top of this file have no
 *    declarations at all. Measured 2026-08-11. A green `tsc` says nothing about
 *    `e2e/`; this pass was typechecked through a throwaway config that adds
 *    `e2e` to `include` and shims the node builtins.
 * ---------------------------------------------------------------------------
 */

/*
 * 🔴 `?fixtures=1` ON EVERY TEST THAT NEEDS A PROGRAM. The built-in fixture
 * jobs came off the operator surface, so a bare `/` plans NOTHING until a
 * drawing is chosen — deliberately, so an empty app never shows a toolpath for
 * a part the user did not supply. The query flag is the sanctioned way to arm
 * one, and it is not a shortcut around the importer: the three shipped SAMPLES
 * would each be a better route, except that all three are REFUSED on the
 * default machine (measured through the CLI, 2026-08-08 — travel on two of
 * them, a feature narrower than the cutter on the third), which is what they
 * are shipped to demonstrate. A test needing a runnable program cannot use one.
 */
test.describe('2bee.slicer', () => {
  test('the default multi-tool fixture is REFUSED for want of a Z reference, and both resolutions clear it', async ({
    page,
  }) => {
    /* 🔴 THE SEAM `readyRunnable()` EXISTS FOR, ASSERTED ONCE, HERE, SO THAT
     * TWELVE OTHER TESTS CAN STOP CARRYING IT.
     *
     * The failure this guards is not a red suite. It is that **the browser and
     * the CLI hand the same core two different jobs**: `2bee-slice job plate`
     * exits 0 with four `G38.2` moves, while this app opens the same fixture
     * with `probeEnabled ?? false` and the core refuses. Nothing watched that,
     * and its only symptom for two days was twelve tests failing for a reason
     * everybody read as environmental — which is exactly how the count
     * *"N failures, all environmental"* stops being a fact and becomes a habit.
     *
     * ⚠ THREE ARMS, BECAUSE ONE IS NOT A TEST. The refusal on its own would
     * still pass if the app refused everything; each resolution on its own would
     * still pass if the app refused nothing. Only the pair around the refusal
     * says the state is REACHABLE AND ESCAPABLE, and the sentence is asserted
     * rather than the status word, because *"refused"* with the wrong reason
     * beside it is the same green. */
    await page.goto('/?fixtures=1');
    await ready(page);

    // (1) The default state refuses, and NAMES the thing the operator must fix.
    await expect(page.getByTestId('status')).toHaveText('refused');
    await expect(page.getByTestId('blocked')).toContainText(
      'a Z re-reference was requested but the machine has no probe'
    );

    // (2) Resolution A — withdraw the request. This is what `readyRunnable` does.
    await page.getByTestId('probe-after-change').uncheck();
    await expect(page.getByTestId('status')).toHaveText('runnable');

    // ...and it is genuinely the refusal that moved, not the panel: put the
    // request back and the same refusal returns.
    await page.getByTestId('probe-after-change').check();
    await expect(page.getByTestId('status')).toHaveText('refused');

    // (3) Resolution B — declare the probe and the plate top. Both halves are
    // required: `probe-enabled` with no `touch-plate-mm` is an undeclared plate,
    // which is the state decision #43 refuses BY DESIGN rather than defaults.
    await page.getByTestId('probe-enabled').check();
    await page.getByTestId('touch-plate-mm').fill('1.6');
    await expect(page.getByTestId('status')).toHaveText('runnable');
  });

  test('loads, plans, and renders without console errors', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/?fixtures=1');
    await readyRunnable(page);

    await expect(page.getByTestId('status')).toHaveText('runnable');
    await expect(page.getByTestId('viewport-canvas')).toBeVisible();

    // The canvas must actually have drawn something. A canvas element that
    // exists but rendered nothing passes every "is visible" assertion, which is
    // how a broken viewport ships looking fine.
    const painted = await page.evaluate(() => {
      const c = document.querySelector('[data-testid=viewport-canvas]') as HTMLCanvasElement;
      if (!c) return { ok: false, reason: 'no canvas' };
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, reason: 'no webgl context' };
      const w = c.width;
      const h = c.height;
      const px = new Uint8Array(w * h * 4);
      (gl as WebGLRenderingContext).readPixels(
        0, 0, w, h,
        (gl as WebGLRenderingContext).RGBA,
        (gl as WebGLRenderingContext).UNSIGNED_BYTE,
        px
      );
      const seen = new Set<string>();
      for (let i = 0; i < px.length; i += 4 * 97) {
        seen.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      }
      return { ok: seen.size > 3, distinct: seen.size, w, h };
    });
    expect(painted.ok, `viewport rendered ${painted.distinct} distinct colours`).toBeTruthy();

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('every panel the spec promises is present', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    for (const id of [
      'panel-machine',
      'panel-stock',
      'panel-tools',
      'panel-op',
      'panel-clamps',
      'panel-verify',
      'panel-summary',
      'panel-sim',
      'panel-gcode',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test('the machine is adjustable and the change reaches the plan', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    // A 600x900 sheet does not fit a 300x180 desktop machine, and the app must
    // say so rather than quietly producing a program that runs off the table.
    await page.getByTestId('travel-x').fill('300');
    await page.getByTestId('travel-y').fill('180');
    await expect(page.getByTestId('stock-too-big')).toBeVisible();
    await expect(page.getByTestId('blocked')).toBeVisible();
    await expect(page.getByTestId('status')).toHaveText('refused');
  });

  test('the workpiece is adjustable and bounds the cut depth', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    await expect(page.getByTestId('deepest')).toHaveText('-18 mm');
    await page.getByTestId('thickness').fill('12');
    await expect(page.getByTestId('deepest')).toHaveText('-12.3 mm');
  });

  test('drill bits are categorised, and category constrains the tool', async ({ page }) => {
    // MIGRATED 2026-08-08: the `Category` <select> is gone. It was a filter in
    // front of a list — a tool you could not see was indistinguishable from a
    // tool that did not exist — so the category now travels WITH each tool and
    // the search matches it. The assertion is unchanged: the three drill
    // patterns are reachable, and a drill still cannot cut a profile.
    await page.goto('/');
    await panelsReady(page);

    await page.getByTestId('tool-picker-trigger').click();
    await page.getByTestId('tool-picker-search').fill('Drill');
    const names = await page
      .getByTestId('tool-picker-list')
      .locator('.op-opt .op-opt-name')
      .evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    for (const d of ['Brad Point', 'Twist', 'Dowel']) {
      expect(names.some((n) => n.includes(d)), `drill pattern ${d} missing`).toBeTruthy();
    }
    // The category is searchable text, so searching it must not sweep in
    // anything that is not one — a category that no longer constrains is a
    // label, and a label will put an end mill where a drill was asked for.
    for (const n of names) {
      expect(n, `"${n}" answered a search for Drill`).toContain('Drill');
    }

    // MIGRATED 2026-08-09 (TODO #58, founder: *"similar to clamps show the
    // selected Tools (like a table, row by row)"*). The single `tool-card`
    // describing `toolIds[0]` is gone: EVERY selected cutter now has its own
    // row. So this reaches the drill's row by id instead of trusting an
    // ordering, and the note the old comment carried — "the card describes the
    // FIRST tool, so the end mill comes out first" — is no longer needed,
    // because a row cannot describe a tool other than its own.
    // The drill is ADDED to the default end mill, so the set is two — which is
    // the state #58 exists for and the state the old single card could not
    // describe.
    await page.getByTestId('tool-picker-opt-Drill - Brad Point 6mm 2F').click();
    await page.getByTestId('tool-picker-done').click();

    // A drill cannot cut a profile. The capability chips must SAY so — that is
    // the difference between a category as a label and a category as a rule.
    const drill = page.getByTestId('tool-row-Drill - Brad Point 6mm 2F');
    await expect(drill.locator('.caps .no', { hasText: 'profile' })).toBeVisible();
    await expect(drill.locator('.caps .yes', { hasText: 'drill' })).toBeVisible();

    // 🔴 AND THE OTHER TOOL IS STILL DESCRIBED — the property #58 exists for,
    // and the half a one-row check cannot see. Before the rows, a set of two
    // showed ONE card built from `toolIds[0]` and said nothing about the second
    // cutter, so a job planned with a drill AND an end mill rendered the facts
    // of whichever happened to be first. An omission that looks like a complete
    // answer.
    //
    // ⚠ The pair asserted here is `profile` and `pocket`, MEASURED at
    // `core/src/tools.rs:59` and `:64` rather than assumed — an end mill can do
    // both, a drill can do neither. The first version of this assertion used
    // `drill` as the differentiator and went red, because `can_drill` at
    // `tools.rs:70` is `EndMill | Drill | Countersink`: an end mill CAN make a
    // hole by plunging, and only the core knew that. A test that had guessed
    // right would have been just as unmeasured.
    const mill = page.getByTestId('tool-row-End Mill - Down-cut 6mm 2F');
    await expect(mill.locator('.caps .yes', { hasText: 'profile' })).toBeVisible();
    await expect(mill.locator('.caps .yes', { hasText: 'pocket' })).toBeVisible();
    await expect(drill.locator('.caps .no', { hasText: 'pocket' })).toBeVisible();

    // Nothing in a tool row may be typed over: every value is the core's answer
    // about that cutter on this machine, not an operator declaration the way a
    // clamp's geometry is. A clamp row is six inputs; a tool row must be none.
    await expect(
      page.getByTestId('tool-rows').locator('input'),
      'a tool row offers an input — a derived machining number that can be typed over'
    ).toHaveCount(0);

    // The rows FOLLOW the set. Taking the end mill out must take its row with
    // it — a table that only ever grows would pass every assertion above.
    // Clear the search first: the end mill does not match "Drill", so it is not
    // on screen, and a click on a row the search has taken away fails as a
    // timeout that reads like a dead control.
    await page.getByTestId('tool-picker-trigger').click();
    await page.getByTestId('tool-picker-search').fill('');
    await page.getByTestId('tool-picker-opt-End Mill - Down-cut 6mm 2F').click();
    await page.getByTestId('tool-picker-done').click();
    await expect(mill).toHaveCount(0);
    await expect(drill).toHaveCount(1);
  });

  test('the tool row prints NO feed, and the number does not come back when rpm or material moves', async ({
    page,
  }) => {
    /*
     * 🔴 THIS TEST USED TO PIN THE DEFECT. It was titled *"feed is derived from
     * the tool, not typed in"* and asserted `3600 mm/min`, then `2400 mm/min`
     * after changing rpm — both of them the PANEL'S OWN MULTIPLICATION
     * (`rpm x flutes x chipload`), which is `core/src/feeds.rs::
     * feed_from_chipload`, the MATERIAL-BLIND function the planner does not use.
     * The planner uses `core/src/tools.rs::feed_for`, which multiplies by
     * `Material::chipload_factor()`, and `core/src/job.rs::plan` caps rpm at
     * `Material::max_rpm()` and recomputes from the capped value.
     *
     * So this test, and the two below it, DEFENDED the defect: correcting the
     * cell turned three browser tests red. A test that pins a wrong number makes
     * the right one a regression, which is worse than having no test at all.
     *
     * MEASURED for `7140829eb6`, out of the EMITTED PROGRAM, 6mm 2F at 18000rpm
     * typed in: Plywood F3600 · Softwood F3960 · Hardwood F2880 · MDF F3600 ·
     * Acrylic F2400 S16000 · Aluminium F840 S12000 — and the panel printed 3600
     * for every one of them. 4.29x in aluminium, on the side an operator winds
     * the feed override UP.
     *
     * 🔴 IT IS NOW THE NEGATIVE CONTROL FOR THE DELETION. The cell prints a
     * sentence, and the assertion is that the sentence DOES NOT MOVE when the
     * two inputs the old arithmetic was made of move. The old defect was
     * precisely that it moved with rpm and stood still for material, so:
     *   - rpm changes            -> the text must not change  (it used to)
     *   - material changes       -> the text must not change  (it never did,
     *                               and that was the more dangerous half)
     * and no `N mm/min` may appear in the cell in any state.
     *
     * ⚠ THIS IS NOT A TEST THAT THE FEED IS CORRECT. Nothing on this surface
     * knows the planned feed: `feed_for` is re-exported from `core/src/lib.rs`
     * and is NOT on the wasm boundary. The day it is exported, this test must be
     * REPLACED by one that compares the cell to the `F` word in the emitted
     * program — not deleted, and not relaxed to "contains a number".
     *
     * ⚠ NEVER RUN — no WebGL on the box it was written on. Unproven here: that
     * the `material` control commits from a page with no drawing loaded, and
     * that the tool row survives a material change without remounting under a
     * new testid.
     *
     * ⚠ MIGRATED 2026-08-11 WITHOUT EVER GOING GREEN. The `material-picker`
     * dialog this drove was removed when the material became a property of the
     * Workpiece (founder: *"remove the Material selection"*), so the selector was
     * updated to the `<select>` that replaced it. That is a text change to a test
     * nobody has run — it fixes a selector that would certainly have failed; it
     * does not make this test proven.
     */
    await page.goto('/');
    await panelsReady(page);
    const feed = page.getByTestId('tool-row-feed-End Mill - Down-cut 6mm 2F');
    const NOT_SHOWN = 'not shown';

    await expect(feed).toHaveText(NOT_SHOWN);
    // The stronger form of the same claim: not merely "not 3600", but no feed
    // rate of any value. A re-implementation with better arithmetic is the same
    // defect and would satisfy a `not.toHaveText('3600 mm/min')`.
    await expect(feed).not.toContainText('mm/min');

    // (a) rpm — the input the old cell DID follow.
    await page.getByTestId('rpm').fill('12000');
    await expect(feed).toHaveText(NOT_SHOWN);
    await page.getByTestId('rpm').fill('24000');
    await expect(feed).toHaveText(NOT_SHOWN);

    // (b) material — the input the old cell did NOT follow, which is why an
    // operator in aluminium was shown a plywood number. Aluminium is the
    // measured extreme (0.233x on the factor, and the rpm capped to 12000).
    await page.getByTestId('material').selectOption('Aluminium');
    await expect(feed).toHaveText(NOT_SHOWN);
    await expect(feed).not.toContainText('mm/min');
  });

  test('a shank that does not match the fitted collet is reported', async ({ page }) => {
    // MIGRATED 2026-08-08, and the TOOL had to change with it. This test used
    // the 12mm up-cut, which the core now marks UNSELECTABLE — no collet in the
    // shop holds a 12mm shank, so it can no longer be chosen at all (that is
    // its own test). The warning this guards is the OTHER case: a tool that IS
    // selectable but needs a collet CHANGE before it can run. The 8mm up-cut is
    // exactly that — the shop owns an 8mm collet, it is simply not the one in
    // the spindle — so it is now the tool that proves the warning fires.
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('tool-picker-trigger').click();
    await page.getByTestId('tool-picker-opt-End Mill - Up-cut 8mm 2F').click();
    await page.getByTestId('tool-picker-opt-End Mill - Down-cut 6mm 2F').click();
    await page.getByTestId('tool-picker-done').click();
    // MIGRATED 2026-08-09 (TODO #58): the warning belongs to the ROW of the tool
    // it is about. It used to hang off a single card describing `toolIds[0]`,
    // which meant a mismatched cutter anywhere but first was silent.
    const warn = page.getByTestId('tool-row-collet-End Mill - Up-cut 8mm 2F');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('8 mm shank');
    // ...and the 6mm down-cut, which DOES match the fitted 6mm collet, carries
    // no warning. A warning on every row would be a control that always fires,
    // which is the same as one that never does.
    await expect(
      page.getByTestId('tool-row-collet-End Mill - Down-cut 6mm 2F')
    ).toHaveCount(0);
  });

  test('clamps can be added and edited by hand, and are checked', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await page.getByTestId('add-clamp').click();
    // Drop it straight onto the part: the plate spans 60..260 x 60..180.
    await page.getByTestId('clamp-0-x').fill('80');
    await page.getByTestId('clamp-0-y').fill('80');
    await page.getByTestId('clamp-0-w').fill('80');
    await page.getByTestId('clamp-0-h').fill('80');
    await expect(page.getByTestId('blocked')).toBeVisible();
    await expect(page.getByTestId('blocked')).toContainText('CutsClamp');

    // Moved clear of the work, the same clamp must NOT block — otherwise the
    // check is stuck red and will be ignored.
    await page.getByTestId('clamp-0-x').fill('460');
    await page.getByTestId('clamp-0-y').fill('700');
    await expect(page.getByTestId('status')).toHaveText('runnable');
  });

  test('undeclared work holding is surfaced and is not the same as confirmed clear', async ({
    page,
  }) => {
    /* ⚠ `bed` -> `machine`, 2026-08-11. The word moved in `230d712686`, the
     * terminology sweep the founder called for (*"there is no sheet!"*); `web/e2e/**`
     * was outside that sweep's boundary, so these two lines were left asserting a
     * sentence the app had stopped printing, and `App.tsx`'s own inline warning at
     * the producing site names them. `machine` is the word the CORE uses
     * (`Fixturing::confirmed_clear`: *"Set ONLY by a human confirming they looked at
     * the machine"*), so this follows the core rather than picking a synonym.
     *
     * What it still catches, unchanged: that the undeclared-work-holding finding is
     * PRINTED, and that ticking `confirmed-clear` is a DIFFERENT state that removes
     * it. Nothing here is weakened — the string is exact, not a substring of a
     * substring, and it is the fixture finding's whole clause. */
    await page.goto('/?fixtures=1');
    await ready(page);
    await expect(page.getByTestId('notes')).toContainText(
      'nobody has confirmed the machine is clear'
    );
    await page.getByTestId('confirmed-clear').check();
    // With nothing left to report the whole panel is removed, so asserting on
    // the element's TEXT would fail on a missing element and look like the
    // warning had stuck. Assert the state that actually matters: the warning is
    // gone, whether or not the panel survived it.
    await expect(page.getByText('nobody has confirmed the machine is clear')).toHaveCount(0);
  });

  test('tabs can be turned off, and the count follows', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    const before = Number(await page.getByTestId('tab-count').textContent());
    expect(before).toBeGreaterThan(0);
    await page.getByTestId('tabs-enabled').uncheck();
    await expect(page.getByTestId('tab-count')).toHaveText('0');
  });

  // 🔴 `?plants=1`. The plant control is no longer on the operator surface —
  // it emits deliberately defective programs and four of them post rather than
  // refuse. It stays reachable ONLY so this test can arm the simulation check;
  // a safety check with no way to fire it is not a check.
  test('a planted gouge is caught by the simulation and blocks nothing silently', async ({
    page,
  }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    await expect(page.getByTestId('sim-gouge')).toHaveText('0');
    await page.goto('/?plants=1');
    await ready(page);
    await page.getByTestId('plant-select').selectOption('gouge');
    await expect(page.getByTestId('sim-gouge')).not.toHaveText('0');
    const n = Number(await page.getByTestId('sim-gouge').textContent());
    expect(n).toBeGreaterThan(100);
  });

  test('a refused program offers no download', async ({ page }) => {
    // ?plants=1 for the same reason as the gouge test above: this proves a
    // REFUSED program offers nothing to download, and refusing one requires
    // planting the defect that gets refused.
    /* ─────────────────────────────────────────────────────────────────────────
     * 🔴 THIS TEST IS RED AT `2c4f75b693` AND IT IS RIGHT. DELIBERATELY LEFT RED,
     *    AND NOT A GPU PROBLEM.
     * ─────────────────────────────────────────────────────────────────────────
     *
     * ⚠ This paragraph used to say *"deliberately NOT tagged `@needs-gpu`"* and
     * *"the ONLY failure left in `--grep-invert @needs-gpu`"*. The tag was
     * stripped on 2026-08-12 (see the file banner) — so there is no invert to be
     * the only failure in, and **this is now simply the one red test in the
     * suite.** It spent a day inside a total described as *"all environmental"*,
     * which is what the tag was supposed to prevent and is exactly what it
     * eventually caused.
     *
     * **Measured 2026-08-11, both hosts, same job + same plant:**
     *
     *   CLI     `2bee-slice job multi-tool --plant oversize-shank`  → exit 1
     *   browser `?plants=1`, job `multi-tool`, plant `oversize-shank`
     *                                                → status `runnable`
     *
     * The browser is NOT failing to apply the plant — its own notes panel prints
     * *"PLANTED: a 12mm-shank cutter on a 6mm collet"* and then offers the
     * program. `core/src/fixtures.rs` declares this contract
     * `PlantEffect::Refuses`, gate `P6`, and P6 is green because P6 drives the
     * CLI.
     *
     * ⚠ AND IT IS NOT ONE PLANT. Three of the five `Refuses` contracts reachable
     * from this surface diverge the same way — all three exit 1 on the CLI and
     * all three report `runnable` in the browser, with the PLANTED note visible:
     *
     *   oversize-shank  (multi-tool, P6)   a 12mm shank in a 6mm collet
     *   cut-clamp       (clamped,    P7)   a clamp sitting on top of the part
     *   release-order   (two-part,   REL)  ⚠ least certain — its own note says
     *                                      whether it is a defect on THIS job is
     *                                      decided by the route note
     *
     *   wrong-drill and undeclared-plate refuse in BOTH hosts, which is what
     *   makes the other three a divergence rather than a dead plant surface.
     *
     * 🔴 SAME FAMILY AS THE Z-RE-REFERENCE SEAM ABOVE, OPPOSITE DIRECTION. That
     * one had the browser refusing where the CLI ran; this one has the browser
     * RUNNING where the CLI refuses, and only this direction can put a program in
     * front of an operator. Not this lane's file to fix — `web/src/**` — and it
     * is left failing on purpose: making it green would delete the only thing
     * currently pointing at it.
     * ───────────────────────────────────────────────────────────────────────── */
    await page.goto('/?plants=1');
    await ready(page);
    await page.getByTestId('job-select').selectOption('multi-tool');
    await page.getByTestId('plant-select').selectOption('oversize-shank');
    await expect(page.getByTestId('status')).toHaveText('refused');
    await openGcode(page);
    await expect(page.getByTestId('download')).toBeDisabled();
  });

  test('the scrubber changes what is drawn', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    const shot = async () => (await page.getByTestId('viewport-canvas').screenshot()).length;
    const full = await shot();
    await page.getByTestId('scrubber').fill('0.1');
    await page.waitForTimeout(300);
    const partial = await shot();
    expect(partial).not.toBe(full);
  });

  test('no horizontal page scroll at 360px', async ({ page }) => {
    // 🔴 MIGRATED 2026-08-08 to the OPERATOR surface, and the route matters.
    // Measured at 360px: `/` overflows by 0px, `/?fixtures=1` by 6px — and the
    // 6px is the `Job` and `Plant` selects in the header, which are gate
    // instruments an operator never sees. Pinning the responsive layout on a
    // page carrying two controls that do not ship would go red for a surface
    // nobody uses, and it would go red on the WRONG element. (The finding is
    // real and is reported rather than hidden: the gate-instrument header does
    // not fit 360px. It is not an operator-facing defect.)
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );

    await page.setViewportSize({ width: 360, height: 720 });
    await page.goto('/');
    await panelsReady(page);
    expect(await overflow(), 'the empty app scrolls sideways at 360px').toBeLessThanOrEqual(0);

    // ...and with a DRAWING loaded, which is the state that adds the report
    // column and the program map — the two widest things in the layout. An
    // empty app that fits proves very little on its own.
    await pickDrawings(page, 'sample:Hive super end');
    await ready(page);
    expect(
      await overflow(),
      'the app scrolls sideways at 360px once a drawing is loaded'
    ).toBeLessThanOrEqual(0);
  });

  test('a drawing can be imported and cut, and what could not be read is named', async ({
    page,
  }) => {
    // No `ready()` before the import: with nothing chosen the app plans
    // nothing, deliberately, so there is no report to wait for yet.
    await page.goto('/');
    await panelsReady(page);
    await expect(page.getByTestId('no-drawing')).toBeVisible();

    const dxf = resolve(HERE, '../../gates/fixtures/plate.dxf');
    await page.getByTestId('import-file').setInputFiles(dxf);
    await expect(page.getByTestId('imported-name')).toContainText('plate.dxf');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    // The holes must have come across. "1 part imported" is equally true of a
    // plate with four holes and of the same plate with every hole dropped.
    await expect(page.getByTestId('notes')).toContainText('4 interior feature');

    // An entity the parser cannot read is NAMED, not skipped.
    await page.getByTestId('import-file').setInputFiles(resolve(HERE, '../../gates/fixtures/spline.dxf'));
    await expect(page.getByTestId('notes')).toContainText('SPLINE');
    await expect(page.getByTestId('notes')).toContainText('NOT imported');

    // ...and the drawing can be cleared, so an operator is never stuck with one.
    // MIGRATED 2026-08-08: there is no "reference job" to go back TO any more —
    // clearing now returns the app to its empty state, and asserting THAT is
    // what keeps this from passing on an app that cleared the drawing and left
    // a stale program on screen.
    await page.getByTestId('clear-import').click();
    await expect(page.getByTestId('imported-name')).toHaveCount(0);
    await expect(page.getByTestId('no-drawing')).toBeVisible();
    await expect(page.getByTestId('status')).toHaveCount(0);
  });

  test('turning the sheet changes the G-code, and un-refuses a sheet that fits turned', async ({
    page,
  }) => {
    await page.goto('/?fixtures=1');
    await readyRunnable(page);

    // The founder's machine: 1250 x 670. The shop's sheet: 600 x 900.
    // 900 > 670, so laid flat it is refused; turned it measures 900 x 600 and
    // fits with room to spare. This is the case the old TypeScript-side check
    // got wrong, so it is the case the test drives.
    await page.getByTestId('travel-x').fill('1250');
    await page.getByTestId('travel-y').fill('670');
    await page.getByTestId('stock-x').fill('600');
    await page.getByTestId('stock-y').fill('900');

    await expect(page.getByTestId('stock-too-big')).toBeVisible();
    // The refusal must say what to do, not only that it will not.
    await expect(page.getByTestId('stock-too-big')).toContainText('turned 90 degrees');

    await openGcode(page);
    await page.getByTestId('rotate-cw').click();
    // The G-code text is behind a toggle; the panel being open is not the same
    // as the program being on screen.
    await page.getByTestId('toggle-gcode').click();
    await expect(page.getByTestId('status')).toHaveText('runnable');
    await expect(page.getByTestId('stock-too-big')).toHaveCount(0);

    const turned = await page.getByTestId('gcode').textContent();
    expect(turned && turned.length).toBeGreaterThan(500);

    // 🔴 The assertion that matters. A rotation that only turned the render
    // would leave the coordinates alone, draw a sheet lying one way, and cut it
    // lying the other. So compare the PROGRAM at two placements, on a machine
    // big enough that both are runnable.
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page.getByTestId('stock-rotation').selectOption('0');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const flat = await page.getByTestId('gcode').textContent();
    await page.getByTestId('stock-rotation').selectOption('90');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const quarter = await page.getByTestId('gcode').textContent();
    expect(quarter).not.toEqual(flat);
  });

  test('a tool no collet can hold cannot be chosen, and says why rather than vanishing', async ({
    page,
  }) => {
    // MIGRATED 2026-08-08 from the <select> to the ObjectPicker. The old form
    // guarded each arm behind `if (await x.count())`, so it also passed when
    // NEITHER kind of tool was on screen — the shape of a check that cannot
    // fail. Both are now named tools and asserted unconditionally.
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('tool-picker-trigger').click();

    // Every tool is LISTED. A filtered list makes "no such tool" and "hidden
    // tool" identical on screen, and the shop's spare collets mean most
    // mismatches are a collet change, not a refusal.
    const opts = page.getByTestId('tool-picker-list').locator('.op-opt');
    expect(await opts.count()).toBeGreaterThan(1);

    // A tool needing a spare collet stays SELECTABLE and names the collet.
    const needs = page.getByTestId('tool-picker-opt-End Mill - Up-cut 8mm 2F');
    await expect(needs).toHaveAttribute('aria-disabled', 'false');
    await expect(needs).toContainText('collet');

    // A shank no collet in the shop holds is disabled, still visible, and says
    // why — with the collets it DOES own, which is the sentence that stops
    // someone hunting for a collet that was never in the drawer.
    const none = page.getByTestId('tool-picker-opt-End Mill - Up-cut 12mm 2F');
    // 🔴 `toBeDisabled()` reports an <option disabled> as ENABLED — the trap
    // this test used to document. On an `li[role=option]` it is worse: there is
    // no disabled attribute at all, and `aria-disabled` is the only thing the
    // browser, the component and AT agree on.
    await expect(none).toHaveAttribute('aria-disabled', 'true');
    await expect(none).toContainText('shank');
    await expect(none).toContainText("the shop's collets are");
  });

  test('a sheet the machine cannot hold is disabled, and one that fits turned is turned', async ({
    page,
  }) => {
    // MIGRATED 2026-08-08: `sheet-preset` was a <select>; it is an ObjectPicker.
    //
    // MIGRATED AGAIN 2026-08-09, and only the LOCATORS moved. Commit `6b1272810`
    // deleted the inline `SHEET_PRESETS` (`600 x 900`, `2400 x 1200`,
    // `2700 x 1200` — three unsourced numbers typed into `App.tsx`) and pointed
    // the picker at the researched catalogue in `web/src/materials.ts`, whose
    // rows are keyed by a stable `id` rather than by a dimension string. So
    // `sheet-picker-opt-2700 x 1200` resolves to nothing and
    // `sheet-picker-opt-ply-au-2700x1200` is the same sheet.
    //
    // 🔴 2700 x 1200 IS STILL OFFERED — verified at the catalogue, not inferred
    // from the test going green: `ply-au-2700x1200` AND `mdf-au-2700x1200` are
    // both in `SHEET_SIZES`, each carrying the supplier page it was read from.
    // So are the other two contested figures — `ply-au-2400x1200` (bom) and
    // `ply-au-handy-900x600` (ops' 600x900, the same sheet listed long-side
    // first). All three live, none pre-selected. **Had 2700x1200 disappeared
    // this test would have been left red as a regression, because which sheet
    // we buy is `bom` + `ops`' open question and a picker that quietly drops one
    // of the three answers settles it.**
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    // 🔴 THE TRAVEL CHANGED WITH THE CATALOGUE, and that is not the test being
    // bent to fit. The old presets stored ops' sheet SHORT-side-first
    // (600 x 900), so on 1250 x 670 of travel it only fitted turned. The
    // catalogue stores every row long-side-first (`w` is documented as the long
    // dimension), so the same sheet is 900 x 600 and now fits AS LAID on that
    // machine — there is no "fits turned" row left at 1250 x 670 to assert on.
    // 650 x 950 restores BOTH verdicts on the real catalogue: exactly one sheet
    // fits only turned, and nineteen are too big any way round. The property
    // under test — "fits turned 90°" and "too big" are different answers and the
    // picker gives each sheet its own — is unchanged.
    await page.getByTestId('travel-x').fill('650');
    await page.getByTestId('travel-y').fill('950');

    await page.getByTestId('workpiece-picker-trigger').click();
    // 2700x1200 fits no way round on this machine: offered, labelled, disabled.
    const tooBig = page.getByTestId('workpiece-picker-opt-sheet:ply-au-2700x1200');
    await expect(tooBig).toContainText('too big');
    await expect(tooBig).toHaveAttribute('aria-disabled', 'true');

    // ops' 600x900 fits turned, so choosing it applies the turn rather than
    // handing back a sheet the machine refuses. "fits turned 90°" and "too big"
    // are different answers and the picker gives each sheet its own.
    const turned = page.getByTestId('workpiece-picker-opt-sheet:ply-au-handy-900x600');
    await expect(turned).toContainText('fits turned 90');
    await turned.click();
    await expect(page.getByTestId('workpiece-picker-list')).toHaveCount(0);
    await expect(page.getByTestId('stock-rotation')).toHaveValue('90');
    await expect(page.getByTestId('status')).toHaveText('runnable');
  });

  test('the sheet can be dragged on the bed, and the datum follows the drag', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');

    const before = await page.getByTestId('origin-x').inputValue();

    // Drag from the middle of the viewport, where the sheet is, to somewhere
    // else on the bed. The exact millimetres depend on the camera, so the
    // assertion is that the DATUM MOVED and the panel agrees, not a fixed value.
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();

    const after = await page.getByTestId('origin-x').inputValue();
    expect(after).not.toEqual(before);

    // 🔴 And the drag must reach the PROGRAM, not just the panel. A datum that
    // moves the picture and not the coordinates is the same defect the sheet
    // rotation had to be tested for.
    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const moved = await page.getByTestId('gcode').textContent();
    await page.getByTestId('origin-x').fill('0');
    await page.getByTestId('origin-y').fill('0');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const home = await page.getByTestId('gcode').textContent();
    expect(moved).not.toEqual(home);
  });

  test('the loaded object can be dragged on the sheet, and the drag reaches the G-code', async ({
    page,
  }) => {
    // 🔴 THE FOUNDER'S CASE, run as he ran it: *"I put the Hive super end -
    // solid (STL) into the table but it is out of the table, I would able to
    // move the loaded object"* (2026-08-09). Two defects were in that sentence
    // and only one of them was the missing drag — the loaded mesh had NO SCENE
    // POSITION at all, so it stood at the machine origin while the sheet was
    // drawn at its datum.
    await page.goto('/');
    await panelsReady(page);
    await pickDrawings(page, 'mesh-sample:Hive super end — solid (STL)');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });

    // 🔴 TWO SEPARATE REFUSALS, and only one of them is about placement — this
    // is measured through the CLI (2026-08-09), not assumed. With the default
    // Ø6mm cutter the panel's 31 finger tails are each NARROWER THAN THE TOOL
    // and are refused feature by feature, which no amount of dragging fixes; a
    // 3.175mm cutter cuts them. What is left is `move the datum by X +3.000
    // Y +3.500` — the cutter radius, the part sitting half a cutter off the
    // near edge of the sheet — and THAT is what placing the part cures.
    // The tool picker is MULTI-select, so this is a swap and not a choice: the
    // default 6mm comes out and the 3.175 goes in. `pickOne` is deliberately
    // not used — it is written for single-select pickers and would leave both
    // cutters selected, which plans a different job than this test describes.
    await page.getByTestId('tool-picker-trigger').click();
    await page.getByTestId('tool-picker-opt-End Mill - Down-cut 6mm 2F').click();
    await page.getByTestId('tool-picker-opt-End Mill - Down-cut 3.175mm 2F').click();
    await page.getByTestId('tool-picker-done').click();
    await expect(page.getByTestId('tool-picker-trigger')).toContainText('3.175mm');
    /* 🔴 A THIRD REFUSAL THE 2026-08-09 CLI MEASUREMENT ABOVE NEVER SAW, and the
     * planner is RIGHT about it. Swapping to the 3.175mm cutter to reach the finger
     * tails also swaps in its 12mm of cutting length, and the default workpiece is
     * 18mm: measured in the browser 2026-08-11, the app refuses with *"End Mill -
     * Down-cut 3.175mm 2F: 12mm of cutting length cannot cut 18mm deep; the shank
     * would be in the cut"*. That is a real physical failure — an unfluted shank
     * rubbing in a slot — and it is not the thing this test is about, so the
     * WORKPIECE moves rather than the assertion.
     *
     * 10mm, not 12: the check refuses at equality too (12 into 12 still refuses,
     * measured), which is correct — a cut to the exact flute length puts the flute
     * junction at the surface. Picking the first value that "works" is how a limit
     * gets solved to equality and ships as the first value that does not.
     *
     * ⚠ It also changes what the rest of this test measures, deliberately and
     * visibly: the program is now cut 10mm deep instead of 18mm. Nothing below
     * depends on the depth — every assertion is on X/Y coordinates and their
     * deltas. */
    await page.getByTestId('thickness').fill('10');
    await page.getByTestId('part-x').fill('10');
    await page.getByTestId('part-y').fill('10');
    await expect(page.getByTestId('status')).toHaveText('runnable');

    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const before = (await page.getByTestId('gcode').textContent()) ?? '';
    expect(before.length, 'no program to compare').toBeGreaterThan(100);

    // 🔴 THE POINT IS PUBLISHED, NOT GUESSED. The object is a 3D solid under a
    // camera this test does not model, so a guessed pixel tests the guess — and
    // a miss and a dead drag handler fail identically. That cost a day on the
    // rotate handle; `data-part-probe` exists so it cannot cost it again.
    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const at = await canvas.getAttribute('data-part-probe');
    expect(at, 'the viewport published no position for the loaded object').toBeTruthy();
    const [px, py] = at!.split(',').map(Number);

    // ...and nothing is COVERING it. An overlay chip over the grab point is
    // indistinguishable from a handler that never fired — the same failure the
    // rotate handle's own assertion was added for.
    const onTop = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? '',
      [box.x + px, box.y + py]
    );
    expect(onTop, `something is covering the loaded object at ${px},${py}`).toBe('viewport-canvas');

    await page.mouse.move(box.x + px, box.y + py);
    await page.mouse.down();
    await page.mouse.move(box.x + px + 70, box.y + py + 40, { steps: 10 });
    await page.mouse.up();

    // The panel and the drag are the SAME two numbers — `App` has one place the
    // part's position lives — so this reads what the gesture decided rather
    // than what this test hoped it would.
    const dx = Number(await page.getByTestId('part-x').inputValue()) - 10;
    const dy = Number(await page.getByTestId('part-y').inputValue()) - 10;
    // 🔴 THIS PAIR IS READ FROM THE PANEL AND THEN USED AS THE EXPECTATION FOR
    // THE PROGRAM, so everything below is a check that the PANEL reaches the
    // G-CODE. It cannot see a defect in the drag -> panel limb, because that
    // limb is where the expectation comes from — and on 2026-08-10 there was
    // one: `onPartMove={(x, y) => { setPartX(x); setPartY(y); }}` over a single
    // stored pair, so the second write discarded the first and PART X COULD
    // NEVER MOVE (`4ae2615c23`). This test stayed green throughout.
    //
    // The only guard was `hypot(dx, dy) > 1`, WHICH ONE LIVE AXIS SATISFIES.
    // Kept, because the comparison below needs a non-zero delta to mean
    // anything — but it is a precondition, not the per-axis check. That is at
    // the end of this test, and it needs two gestures; see there for why one is
    // not enough.
    expect(Math.hypot(dx, dy), 'the drag moved the part nowhere').toBeGreaterThan(1);
    // ...and the X limb specifically, which is the axis that was dead. This
    // gesture is safe to assert on X and is NOT safe to assert on Y, and the
    // reason is arithmetic rather than caution — see the block at the end.
    expect(
      Math.abs(dx),
      'the drag left Part X exactly where it was typed — the dead axis is back'
    ).toBeGreaterThan(1);

    await expect(page.getByTestId('status')).toHaveText('runnable');
    const after = (await page.getByTestId('gcode').textContent()) ?? '';

    // 🔴 THE ASSERTION IS ON THE EMITTED PROGRAM AND ON THE AMOUNT. "It
    // changed" would pass for a drag that moved the program by the wrong
    // distance, in the wrong direction, or that changed its shape — and a part
    // cut 40mm from where the operator put it is the same scrap as one that did
    // not move at all.
    // The scanner is `./gcode.ts`, and `gcode-reader.spec.ts` is what holds it
    // honest. This test used to carry its own copy of the loop.
    const a = coords(before);
    const b = coords(after);
    expect(a.length, 'the program has no positioned moves to measure').toBeGreaterThan(50);
    expect(b.length, 'the drag changed the SHAPE of the program, not its position').toBe(a.length);
    // 0.05mm: the panel rounds to 0.1mm and the post rounds its words, so the
    // two roundings can disagree by half a quantum and nothing is wrong.
    const wrong = a.filter(
      ([ax, ay], i) => Math.abs(b[i][0] - ax - dx) > 0.05 || Math.abs(b[i][1] - ay - dy) > 0.05
    );
    expect(
      wrong.length,
      `the drag moved the part by ${dx},${dy} and ${wrong.length} of ${a.length} emitted ` +
        `positions did not follow it (first: ${a[a.findIndex((_, i) => wrong.includes(a[i]))] ?? ''})`
    ).toBe(0);

    // 🔴 THE NEGATIVE CONTROL. Without it the comparison above is satisfied by
    // an app that re-plans to a different program on every keystroke — the
    // difference would be real and would mean nothing. Re-entering the SAME
    // numbers must reproduce the SAME program, byte for byte, and putting the
    // part back where it started must reproduce the program from before the
    // drag. A drag that does not change the program is the defect; a program
    // that changes without a drag is a worse one.
    await page.getByTestId('part-x').fill('10');
    await page.getByTestId('part-y').fill('10');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const home = (await page.getByTestId('gcode').textContent()) ?? '';
    expect(home, 'the same placement did not reproduce the same program').toEqual(before);

    // 🔴 AND THE PICTURE HAS TO FOLLOW THE SAME ARITHMETIC. This is the OTHER
    // half of what the founder saw and nothing above covers it: the loaded mesh
    // had NO SCENE POSITION AT ALL — uploaded from the core's `xyz_mm` and
    // drawn at raw MODEL coordinates — so the sheet was drawn at its datum and
    // the object stood at the machine origin. Every G-code assertion above
    // passes while that is true.
    //
    // `data-part-bbox` is the DRAWN object's own world box in bed millimetres.
    // Moving the sheet must move it by exactly what it moves the program.
    const bbox = async () =>
      ((await canvas.getAttribute('data-part-bbox')) ?? '').split(',').map(Number);
    const bb0 = await bbox();
    expect(bb0.length, 'the viewport published no bed position for the loaded object').toBe(4);

    await page.getByTestId('origin-x').fill('40');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const movedByDatum = coords((await page.getByTestId('gcode').textContent()) ?? '');
    expect(movedByDatum[0][0] - a[0][0], 'the datum did not reach the program').toBeCloseTo(40, 3);
    const bb1 = await bbox();
    expect(
      bb1[0] - bb0[0],
      'the sheet moved 40mm and the drawn object stayed where it was — the picture and the ' +
        'program disagree, which is what "it is out of the table" looks like'
    ).toBeCloseTo(40, 1);
    expect(bb1[1] - bb0[1], 'the drawn object moved in Y when only X was asked for').toBeCloseTo(
      0,
      1
    );

    /* =====================================================================
     * 🔴 PER AXIS — the check that was missing when Part X went dead.
     * =====================================================================
     *
     * The defect (`4ae2615c23`): the viewport's drag callback wrote a stored
     * PAIR twice, once per axis, each write closing over the render-time value
     * of the other. The second write always discarded the first. Part Y moved
     * and Part X could not leave the value it was typed at, in code that reads
     * identically to `onStockMove` two props above it — which is correct,
     * because the sheet datum really is two independent `useState` hooks.
     *
     * ⚠ WHY THIS TAKES TWO GESTURES AND NOT ONE. The screen-to-bed map depends
     * on the camera, and the camera here is FIXED at construction rather than
     * fitted: `Viewport.tsx` sets `theta = -PI/4`, `phi = PI/3.2`, `up = +Z`.
     * Derived from those constants (read from the source; NOT observed — no
     * WebGL on this box):
     *
     *     pointer RIGHT by s px  ->  bed ( +0.707s, +0.707s )
     *     pointer DOWN  by t px  ->  bed ( +1.273t, -1.273t )
     *
     * so the gesture this test already performs, (+70, +40), lands on
     * bed (+100.4, -1.4) x mm-per-pixel — VERY NEARLY PURE X. A per-axis
     * assertion on Y for that drag would be a false red on a correct app, and
     * `hypot > 1` was being satisfied by the X limb alone the whole time. The
     * suite could not have seen a dead Y either.
     *
     * So: two gestures at right angles on screen. The bed-plane map is linear
     * and invertible, so two independent screen directions give two independent
     * bed deltas, and an axis that never moves across BOTH of them is an axis
     * nothing writes — whatever the camera is. That makes this check survive a
     * camera change, which the arithmetic above deliberately does not.
     *
     * ⚠ NEVER RUN. Unproven here: the mm-per-pixel scale, which decides whether
     * 50px is a delta big enough to clear the `> 1` thresholds and small enough
     * not to walk the part off the sheet. That is why each gesture starts from
     * the SAME reset placement rather than continuing from the last one — two
     * drags compounding is the failure this could not be sized against.
     */
    await page.getByTestId('origin-x').fill('0');

    const panel = async () => [
      Number(await page.getByTestId('part-x').inputValue()),
      Number(await page.getByTestId('part-y').inputValue()),
    ];
    /** Back to the known-good placement, and WAIT for it to plan. Both gestures
     *  start from here rather than one continuing from the other: a 50px drag is
     *  tens of millimetres on this camera, so two of them compounding would walk
     *  the part off the sheet, and a probe read from a refused plan describes an
     *  object the core has drawn at the machine origin. Two deltas from ONE
     *  origin is also the only form in which they can be compared to each other,
     *  which the last assertion needs. */
    const resetPart = async () => {
      await page.getByTestId('part-x').fill('10');
      await page.getByTestId('part-y').fill('10');
      await expect(page.getByTestId('status')).toHaveText('runnable');
    };
    /** Grab the part at its PUBLISHED point and drag by a screen delta. The
     *  point is re-read every time: after a drag the part is somewhere else, and
     *  a stale grab point misses the object, which fails identically to a dead
     *  handler. */
    const dragBy = async (px: number, py: number) => {
      const p = await canvas.getAttribute('data-part-probe');
      expect(p, 'the viewport stopped publishing a grab point for the part').toBeTruthy();
      const [gx, gy] = p!.split(',').map(Number);
      await page.mouse.move(box.x + gx, box.y + gy);
      await page.mouse.down();
      await page.mouse.move(box.x + gx + px, box.y + gy + py, { steps: 10 });
      await page.mouse.up();
    };

    await resetPart();
    const [x0, y0] = await panel();
    await dragBy(50, 0); //  screen RIGHT
    const [x1, y1] = await panel();

    await resetPart();
    await dragBy(0, 50); //  screen DOWN — perpendicular to the first
    const [x2, y2] = await panel();

    const d1 = [x1 - x0, y1 - y0];
    const d2 = [x2 - x0, y2 - y0];
    expect(
      Math.max(Math.abs(d1[0]), Math.abs(d2[0])),
      `Part X did not move on EITHER gesture (${x0} -> ${x1} and ${x0} -> ${x2}) — one stored ` +
        'pair written twice, second write wins, exactly as in 4ae2615c23'
    ).toBeGreaterThan(1);
    expect(
      Math.max(Math.abs(d1[1]), Math.abs(d2[1])),
      `Part Y did not move on EITHER gesture (${y0} -> ${y1} and ${y0} -> ${y2}) — the same ` +
        'defect on the other axis, which nothing in this suite could see before'
    ).toBeGreaterThan(1);

    // 🔴 AND THE TWO GESTURES MUST NOT AGREE. If the drag handler wrote the same
    // pair whatever the pointer did — a plausible way to "fix" a dead axis — both
    // deltas would be identical and the two assertions above would both pass.
    // Two perpendicular screen drags must produce two different bed deltas.
    expect(
      Math.hypot(d1[0] - d2[0], d1[1] - d2[1]),
      `two perpendicular drags moved the part by the same amount (${d1} and ${d2}) — the ` +
        'gesture is not reaching the placement, something else is'
    ).toBeGreaterThan(1);
  });

  test('a part dragged past the sheet edge is now simulated against the spoilboard', async ({
    page,
  }) => {
    // 🔴 Before 2026-08-20 the height map covered only the workpiece, so cuts
    // past the edge were invisible. Now the map covers the toolpath extent too,
    // and the spoilboard check runs on the extended area. The warning still fires
    // as informational — the operator should know the program leaves the stock.
    /*
     * 🔴 REWRITTEN 2026-08-11 BECAUSE IT WAS DRIVING A DEAD CONTROL, and the dead
     * control was the finding — not this assertion.
     *
     * It used to run on `?fixtures=1`. A fixture job has NO drawing on the table
     * (`drawing-rows` is empty, measured), and since the placement moved onto the
     * drawing on 2026-08-10 `part-x` is a VIEW of `drawings[sel].offset`: with an
     * empty list it reads 0 and writing it maps over nothing. So the old form typed
     * 700 into a field that snapped back to 0, planned the same job, and asserted a
     * note the core had no reason to emit. It read as a missing safety note and was
     * a dead input — the two are indistinguishable from the assertion alone, which
     * is why this comment names which one it was.
     *
     * The input is now `disabled` when there is no drawing (`App.tsx`, same day), so
     * that half is asserted HERE rather than left to be rediscovered: this test is
     * the only place in the suite that touches `part-x` without a drawing loaded.
     *
     * A real drawing then replaces the fixture. `plate.dxf` through the real
     * importer is the same route `two drawings go on the table` uses, and it makes
     * the pair genuine: as imported the outline sits inside the 600x900 workpiece
     * (no note), and offset by 700 the program reaches 353mm past its edge
     * (measured in the browser, this change).
     */
    await page.goto('/?fixtures=1');
    await ready(page);
    await expect(
      page.getByTestId('part-x'),
      'Part X is editable with no drawing on the workpiece — it writes to `drawings[sel].offset`, ' +
        'so there is nothing for it to move and it silently does nothing'
    ).toBeDisabled();

    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });
    // The negative half, and it is not a formality: a check that fires on every
    // job says nothing about the job it fires on.
    await expect(page.getByTestId('notes')).not.toContainText('PAST THE EDGE');

    await page.getByTestId('part-x').fill('700');
    // The panel is read back rather than assumed — that the number reached the
    // placement at all is the thing the old form got wrong.
    await expect(page.getByTestId('part-x')).toHaveValue('700');
    await expect(page.getByTestId('notes')).toContainText('PAST THE EDGE');
    await expect(page.getByTestId('notes')).toContainText('checked against the spoilboard');
  });

  test('a machine can be saved, reloaded after a page reload, and deleted', async ({ page }) => {
    // ✅ GREEN SINCE 2026-08-27. This block read "🔴 THIS TEST IS LEFT FAILING,
    // DELIBERATELY" for nineteen days. The history is kept rather than deleted,
    // because the defect came back once already wearing different clothes and
    // whoever reads a red here next needs to know which of the two it is.
    //
    // ── ROUND ONE, 2026-08-08 ────────────────────────────────────────────────
    // The panel's name box and Save button were removed (founder: "all property
    // changes are from the list module") and saving moved INSIDE the picker. But
    // the picker only rendered its Save / Save-as controls when there was a
    // PREVIEW ITEM — an item already in the list — so with nothing saved yet
    // `<picker>-saveas` resolved to 0 elements. ⇒ THE FIRST MACHINE COULD NEVER
    // BE SAVED. Fixed by the empty-list save row in `ObjectPicker.tsx`; the
    // `toHaveCount(1)` assertion below is what remains of it and stays.
    //
    // ── ROUND TWO, found 2026-08-27 — SAME DEFECT, OPPOSITE MECHANISM ────────
    // The control existed and REFUSED. TODO #102's save-target guard compares
    // the previewed row against the panel, and on open with nothing selected the
    // picker makes ROW 0 active — so it answered "You are looking at 'Bellwether
    // Lead 1250x670', but the panel holds a 1234 x 900 machine ... or close the
    // properties view if you meant to save what is set up now."
    // 🔴 THERE IS NO CONTROL THAT CLOSES THE PROPERTIES VIEW — the picker's
    // buttons are `Save as` and `Cancel` — so the remedy that sentence offered
    // did not exist, and a hand-typed machine could not be saved at all.
    //
    // Fixed in `ObjectPicker.tsx` by separating "active because the user chose
    // it" from "active because it is row 0"; the refusal is unchanged and still
    // fires on the ambiguity it was built for. Both halves are now guarded by
    // `web/e2e/save-target.spec.ts`, WHICH DID NOT EXIST — measured that day,
    // `grep "Nothing was saved"` over `web/e2e/` and `web/tests/` returned
    // nothing, so the rule deciding which machine's travels get written under a
    // name had never been exercised in either direction.
    await page.goto('/');
    await panelsReady(page);

    // MIGRATED 2026-08-09 (TODO #61, founder: *"in the machine section remove
    // the: saved… ▼ / Delete / Preset"*). All three are gone from the panel and
    // every capability behind them is in ONE list — the shipped presets and the
    // user's own machines together, each row saying which it is. So the
    // locators move from `saved-machine-select-*` to `machine-picker-*`, and
    // Delete moves from a panel button to the row's own control.
    await page.getByTestId('travel-x').fill('1234');
    await page.getByTestId('collet').fill('8');
    await page.getByTestId('machine-picker-trigger').click();
    await expect(
      page.getByTestId('machine-picker-saveas'),
      'there is no control that saves a machine — the first save is unreachable'
    ).toHaveCount(1);
    await page.getByTestId('machine-picker-saveas-name').fill('shop router');
    await page.getByTestId('machine-picker-saveas').click();
    await expect(page.getByTestId('machine-note')).toContainText('saved');

    // 🔴 A SHIPPED PRESET HAS NO DELETE, and that is the merge's own rule
    // rather than a detail of this test: a built-in lives in the bundle, so a
    // control offering to remove it would either do nothing or remove something
    // that is back after a reload. Asserted BEFORE the reload, while both kinds
    // of row are on screen together — which is the only state in which the
    // distinction can be got wrong.
    await expect(
      page.getByTestId('machine-picker-rm-preset:Desktop 3018'),
      'a shipped preset offers a delete control it cannot honour'
    ).toHaveCount(0);
    await expect(
      page.getByTestId('machine-picker-rm-saved:shop router'),
      'the machine the user saved cannot be deleted from the list'
    ).toHaveCount(1);
    // And the origin is on the row, not only in the properties: a preset states
    // travels somebody measured, a saved machine states travels nobody checked.
    //
    // ⚠ MIGRATED 2026-08-11 — `SHIPPED` -> `CATALOGUE` ON THE MACHINE ROWS ONLY.
    // The inventory work (TODO #83) took over this row's tag: `App.tsx` builds a
    // preset's detail from `machineInv.row(...).tags`, and its own comment says
    // *"THE OWNERSHIP TAGS REPLACE `SHIPPED` … printing both gave `SHIPPED ·
    // OWNED · CATALOGUE`: one fact twice."* The row now reads
    // `OWNERSHIP UNCHECKED · CATALOGUE · 300 x 180 mm of travel` on a browser
    // with no inventory imported.
    //
    // 🔴 `CATALOGUE`, NOT `OWNERSHIP UNCHECKED`, is what this line asserts, and
    // the choice is the assertion. The origin tag answers the question this test
    // asks — where the numbers came from — and it is the same on every browser.
    // The ownership tag answers a DIFFERENT question (does this shop have one)
    // and legitimately reads `OWNED` or `NOT OWNED` the moment somebody imports
    // an inventory file, so pinning it here would make an unrelated import turn
    // this test red. Ownership is `web/tests/`'s to hold.
    //
    // ⚠ `SHIPPED` is still the tag on the DRAWING rows and this file still
    // asserts it there — the two lists diverged, and that is the fact rather
    // than a rename to chase everywhere.
    await expect(page.getByTestId('machine-picker-opt-preset:Desktop 3018')).toContainText(
      'CATALOGUE'
    );
    await expect(page.getByTestId('machine-picker-opt-saved:shop router')).toContainText('YOURS');
    // The negative half: a saved machine must NOT wear the catalogue's tag. A
    // merged list is only safe while the first row's provenance cannot rub off
    // on the second, and `toContainText` alone would pass on a list that tagged
    // everything `CATALOGUE`.
    await expect(page.getByTestId('machine-picker-opt-saved:shop router')).not.toContainText(
      'CATALOGUE'
    );

    // 🔴 Reload. Saving into memory and calling it saved is the failure this
    // guards: the whole point is that it survives the browser being closed.
    await page.reload();
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('600');
    await pickOne(page, 'machine-picker', 'saved:shop router');
    await expect(page.getByTestId('travel-x')).toHaveValue('1234');
    // The collet must come back too: a machine restored without it silently
    // changes which tools are selectable.
    await expect(page.getByTestId('collet')).toHaveValue('8');

    // Delete from the row, with the dialog left OPEN — the list is where CRUD
    // lives now, and the list is what has to show the result.
    await page.getByTestId('machine-picker-trigger').click();
    await page.getByTestId('machine-picker-rm-saved:shop router').click();
    await expect(page.getByTestId('machine-note')).toContainText('deleted');
    // Deleted means GONE from the list, not merely unselected. The old form of
    // this assertion was "the list is empty and says so", which the merge has
    // made untrue and unusable: the three shipped presets are always there. So
    // it asserts the two halves separately — the saved row is gone, and the
    // presets are NOT, because a delete that took the catalogue with it would
    // pass an "is it gone" check just as happily.
    await expect(page.getByTestId('machine-picker-opt-saved:shop router')).toHaveCount(0);
    await expect(page.getByTestId('machine-picker-opt-preset:Desktop 3018')).toHaveCount(1);
  });

  test('a workpiece round-trips with its placement, not just its size', async ({ page }) => {
    // ✅ GREEN SINCE 2026-08-27, and it was red for the SAME reason the machine
    // test above was — not a second defect. Full history there; in short: the
    // picker made ROW 0 active on open, TODO #102's save-target guard read that
    // as the operator looking at a row they never chose, and refused. The
    // workpiece panel inherits the behaviour because every panel saves through
    // one `ObjectPicker`. Fixed in that file, guarded by
    // `web/e2e/save-target.spec.ts`.
    //
    // ⚠ Left as its own test rather than folded into the machine one: they ride
    // the same control today and a future change could easily move only one of
    // them, which is exactly the case a single test could not see.
    await page.goto('/');
    await panelsReady(page);
    // MIGRATED 2026-08-09 (TODO #61): the Workpiece panel's own `saved… ▼` and
    // `Delete` are gone the same way the Machine panel's did, and the shipped
    // SHEET catalogue and the user's saved workpieces are ONE list. They are
    // different objects and each row says which — a sheet sets two numbers, a
    // saved workpiece sets the whole setup — so `sheet:` and `saved:` prefix the
    // row ids.
    await page.getByTestId('stock-x').fill('420');
    await page.getByTestId('stock-rotation').selectOption('90');
    await page.getByTestId('origin-x').fill('35');
    await page.getByTestId('workpiece-picker-trigger').click();
    await expect(
      page.getByTestId('workpiece-picker-saveas'),
      'there is no control that saves a workpiece — the first save is unreachable'
    ).toHaveCount(1);
    await page.getByTestId('workpiece-picker-saveas-name').fill('offcut');
    await page.getByTestId('workpiece-picker-saveas').click();
    // 🔴 Wait for the WRITE, not just the click. IndexedDB commits
    // asynchronously, so reloading straight after the click raced the save and
    // the item was genuinely not there yet. The note is the app's own
    // confirmation that the write returned.
    await expect(page.getByTestId('workpiece-note')).toContainText('saved');

    await page.reload();
    await panelsReady(page);
    await pickOne(page, 'workpiece-picker', 'saved:offcut');
    await expect(page.getByTestId('stock-x')).toHaveValue('420');
    // Placement is part of the workpiece. A sheet restored flat and at the
    // origin is a different setup wearing the same name.
    await expect(page.getByTestId('stock-rotation')).toHaveValue('90');
    await expect(page.getByTestId('origin-x')).toHaveValue('35');
  });

  // =========================================================================
  //  GATE I1 — BROWSER / CLI PARITY
  // =========================================================================
  test('the browser and the CLI emit byte-identical G-code', async ({ page }) => {
    await page.goto('/?fixtures=1');
    await ready(page);

    // Drive the UI away from every default, so parity is proven on a
    // CONFIGURED job. Agreeing on the defaults proves far less.
    await page.getByTestId('thickness').fill('15');
    await page.getByTestId('depth-per-pass').fill('3');
    await page.getByTestId('rpm').fill('16000');
    await page.getByTestId('entry').selectOption('Plunge');
    // 🔴 THE PROBE IS TURNED ON HERE BECAUSE IT NO LONGER TURNS ITSELF ON.
    //
    // Commit `6b1272810` flipped `probeEnabled` from `true` to `false` in
    // `App.tsx`, following core decision #43 (`a1394e091`) which made
    // `Machine::touch_plate_mm` an `Option<f64>` that REFUSES when undeclared:
    // if the thickness cannot be defaulted, the thing that requires it must not
    // be defaulted either. The CLI side below has always asked for
    // `probe_enabled: true`, so from that commit the two hosts were handed
    // DIFFERENT JOBS and the byte compare failed on the touch-plate block.
    //
    // ⚠ NOT A STALE WASM. `K3` reports both hosts built from the same core
    // (`79f754a1ca5d`, measured 2026-08-09), so the divergence was in the
    // INPUTS, not in the code. Reading it as a stale artefact would have bought
    // a rebuild that fixed nothing.
    //
    // The probe is switched ON rather than the config switched off, because the
    // probing preamble is the newest and most safety-critical thing this post
    // emits and parity over a program that omits it covers less. The plate top
    // is now DECLARED on both sides — the browser types it, the config states it
    // — instead of the CLI silently inheriting the `plate` job's 1.6.
    await page.getByTestId('probe-enabled').check();
    await page.getByTestId('touch-plate-mm').fill('1.6');
    await expect(page.getByTestId('status')).toHaveText('runnable');

    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const browserGcode = await page.getByTestId('gcode').textContent();
    expect(browserGcode && browserGcode.length).toBeGreaterThan(500);

    const cfg = {
      machine: {
        travel_x_mm: 600,
        travel_y_mm: 900,
        travel_z_mm: 100,
        safe_z_mm: 5,
        collet_mm: 6,
        spindle_max_rpm: 24000,
        probe_enabled: true,
        // Stated, not inherited. `report plate` declares 1.6 itself, so leaving
        // this out passed for the wrong reason — the two hosts agreed because
        // one of them fell back, which is exactly the kind of agreement a parity
        // gate must not accept.
        touch_plate_mm: 1.6,
        supports_arcs: true,
      },
      stock: { size_x_mm: 600, size_y_mm: 900, thickness_mm: 15, z_zero_at_top: true },
      clamps: [],
      confirmed_clear: false,
      tool_id: 'End Mill - Down-cut 6mm 2F',
      probe_after_toolchange: true,
      op: {
        depth_per_pass_mm: 3,
        rpm: 16000,
        entry: 'Plunge',
        finish_allowance_mm: 0,
        tabs_enabled: true,
        tab_height_mm: 3,
        tab_width_mm: 8,
        tab_min_spacing_mm: 150,
      },
    };
    const dir = tempDir('slicer-parity-');
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const out = execFileSync(CLI, ['report', 'plate', '--config', cfgPath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const cliGcode = JSON.parse(out).gcode as string;

    expect(cliGcode.length).toBeGreaterThan(500);
    // 🔴 Byte-for-byte. "Close enough" here would mean the two hosts run
    // different code and nobody would find out until a part came out wrong.
    expect(browserGcode).toBe(cliGcode);

    // NEGATIVE CONTROL for the comparison itself.
    //
    // A parity assertion that cannot fail is decoration. If the browser were
    // producing an empty string and the CLI an empty string, the check above
    // would pass. So: run the CLI with ONE setting changed and require the
    // comparison to reject it. If this ever passes, the equality above proves
    // nothing.
    // 🔴 DRIFT DOWNWARD, AND NEVER UPWARD AGAIN.
    //
    // This drifted to `4` until 2026-08-09, when it started FAILING — and the
    // cause was not this file. #38 halved `max_doc_ratio` to 0.50, so a 6mm
    // cutter now caps depth of cut at 3.0mm: `3` and `4` are BOTH clamped to
    // 3.0 and emit byte-identical programs (measured: 7033 chars each, while
    // 1.5 gives 10758). The "changed" config was no longer a changed program,
    // so the control asserted nothing.
    //
    // ⚠ A safety change one layer down silently removed the difference this
    // control was built on. It failed loudly only because it asserts
    // `.not.toBe` — an armed control dies NOISILY, which is the whole argument
    // for arming them. Had it been phrased as "these differ, probably", the
    // parity assertion above would have gone on proving nothing.
    //
    // 1.5 is BELOW every material cap, so no clamp can converge it onto the
    // baseline. The guard two lines down makes that a checked property rather
    // than a comment.
    const drifted = { ...cfg, op: { ...cfg.op, depth_per_pass_mm: 1.5 } };
    const driftPath = join(dir, 'drift.json');
    writeFileSync(driftPath, JSON.stringify(drifted));
    const driftGcode = JSON.parse(
      execFileSync(CLI, ['report', 'plate', '--config', driftPath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    ).gcode as string;
    expect(driftGcode.length).toBeGreaterThan(500);
    // VACUITY GUARD for the negative control itself — one level further down
    // than the control it guards. The CLI's own two programs must differ, so a
    // clamp that quietly converges the drifted setting onto the baseline is
    // caught HERE, naming the clamp, instead of surfacing as a confusing parity
    // failure that points at the browser. This is exactly what happened on
    // 2026-08-09 and it cost a run to attribute.
    expect(
      driftGcode,
      'the drifted config produced the SAME program as the baseline — a cap converged it, ' +
        'so the negative control below proves nothing about parity'
    ).not.toBe(cliGcode);
    expect(
      browserGcode,
      'the parity comparison accepted a program built with a different depth per pass'
    ).not.toBe(driftGcode);
  });

  test('the sheet can be turned by the control that survives, and the turn reaches the G-code', async ({
    page,
  }) => {
    /*
     * 🔴 **INVERTED, NOT DELETED — 2026-08-10.** The founder removed the sphere
     * knob (*"remove the large ball to rotate the workpeace"*), and this test
     * used to drive it. It is NOT deleted with the widget, because the widget was
     * never the guarantee: **the guarantee is that a turn reaches the emitted
     * program**, and that is still true and still worth guarding. A test deleted
     * along with the control it happened to drive takes a live guarantee with it,
     * and nothing goes red when the guarantee does.
     *
     * The affordance under test is now the `Laid at` select in the Workpiece
     * panel, which wrote the same `rotation` state the knob wrote — checked
     * before the knob was removed, because deleting the only way to turn a sheet
     * would be a capability regression wearing a UI-cleanup costume.
     *
     * ⚠ WHAT THIS TEST NO LONGER COVERS, said plainly rather than left for
     * someone to assume it still does: the pointer-shield defect. The knob's
     * grab point was measured against `document.elementFromPoint`, and that
     * assertion caught a full-width overlay eating clicks TWICE. A `<select>` is
     * a DOM control and cannot be shielded by a canvas overlay the same way, so
     * the class of defect is gone with the 3D affordance rather than gone
     * unwatched — but the *technique* is still needed by every other 3D handle
     * (the sheet drag, the part drag, the clamp drag), and those keep it.
     */
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');

    // A 600x900 sheet turned off its axes sweeps a bounding box larger than the
    // default 600x900 travel, so the plan would be REFUSED and there would be no
    // program left to compare. Give the machine room first — the thing under
    // test is the turn, not the travel check.
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await expect(page.getByTestId('status')).toHaveText('runnable');

    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const before = await page.getByTestId('gcode').textContent();
    expect(before && before.length).toBeGreaterThan(500);
    await expect(page.getByTestId('stock-rotation')).toHaveValue('0');

    // 🔴 AND THE KNOB IS ACTUALLY GONE, not merely invisible. A mesh that is
    // still in the scene and still hit-tested FIRST would silently eat every
    // drag aimed at the sheet underneath it — the same class of defect as the
    // pointer shield, arriving from the other direction. The viewport published
    // the knob's screen position for exactly this kind of assertion, so its
    // ABSENCE is checkable too.
    await expect(page.getByTestId('viewport-canvas')).not.toHaveAttribute('data-rotate-handle', /.*/);

    await page.getByTestId('stock-rotation').selectOption('90');
    await expect(page.getByTestId('stock-rotation')).toHaveValue('90');

    // 🔴 The one that matters, and it is unchanged from the version that drove
    // the knob. A rotation that turns the picture and not the coordinates draws
    // a sheet lying one way and cuts it lying the other.
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const after = await page.getByTestId('gcode').textContent();
    expect(after && after.length).toBeGreaterThan(500);
    expect(after, 'the sheet turned on screen and the program did not move').not.toEqual(before);

    // …and the two rotate BUTTONS write the same state, so the panel cannot
    // disagree with itself about how the sheet is laid.
    await page.getByTestId('rotate-ccw').click();
    await expect(page.getByTestId('stock-rotation')).toHaveValue('0');
  });

  // =========================================================================
  //  #25 — PER-CLASS VISIBILITY IS A DISPLAY STATE AND NOTHING ELSE
  // =========================================================================
  test('hiding every move class changes the picture and not one byte of the program', async ({
    page,
  }) => {
    // ⚠ `?fixtures=1`, not `/`. The gate fixtures came off the operator surface
    // while this was being written, so a bare `/` now plans NOTHING until a
    // drawing is chosen — deliberately, so an empty app never shows a toolpath
    // for a part the user did not supply. These three tests need a program to
    // exist, and the query flag is the sanctioned way to arm one.
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');

    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const gcodeBefore = await page.getByTestId('gcode').textContent();
    expect(gcodeBefore && gcodeBefore.length).toBeGreaterThan(500);

    // The simulation's verdicts run over the WHOLE program, so they are the
    // second place a display filter would show up if it had leaked.
    const sim = async () => [
      await page.getByTestId('sim-gouge').textContent(),
      await page.getByTestId('sim-uncut').textContent(),
      await page.getByTestId('sim-spoil').textContent(),
    ];
    const simBefore = await sim();

    /*
     * 🔴 `panel-verify` IS OPENED HERE, BEFORE THE BASELINE, AND THE POSITION IS
     * THE POINT. `kind-result` moved into that section (`LAYER_SECTION.result`,
     * `web/src/Viewport.tsx`) and it is the one sidebar section rendered
     * `defaultOpen={false}`, so this test cannot reach the control without
     * opening it — but doing so at the point of first use would put a DOM change
     * between `drawnBefore` and the negative control (c) that compares against
     * it. `shot()` hashes the canvas size along with its pixels, so any layout
     * effect at all would satisfy (c) without the 3D scene having moved — which
     * is the exact "passes for the wrong reason" the hash was written to avoid
     * for the overlay banner.
     *
     * MEASURED at `web/src/styles.css`: `.side` is `overflow: auto`, so an
     * expanding panel scrolls the sidebar and does not resize the canvas — so
     * this is belt and braces rather than a known defect. It costs one line and
     * removes the question.
     */
    await openSectionByTestId(page, 'panel-verify');

    // 🔴 The DRAWING BUFFER, not an element screenshot. A screenshot of the
    // canvas element also captures whatever DOM sits on top of it — and this
    // feature ADDS an overlay to the canvas, so the screenshot changes the
    // moment the "N of N hidden" banner appears whether or not the 3D scene
    // moved at all. That made the negative control below pass against a planted
    // defect in which the toggles reached nothing: proven, not assumed. Reading
    // the GL buffer sees only what was rendered.
    const shot = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-testid=viewport-canvas]') as HTMLCanvasElement;
        const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext;
        const px = new Uint8Array(c.width * c.height * 4);
        gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let h = 0;
        for (let i = 0; i < px.length; i += 4) {
          h = (Math.imul(h, 31) + px[i] + px[i + 1] * 3 + px[i + 2] * 7) >>> 0;
        }
        return `${c.width}x${c.height}:${h}`;
      });
    const drawnBefore = await shot();

    // Nothing hidden, nothing claimed.
    await expect(page.getByTestId('hidden-indicator')).toHaveCount(0);

    /*
     * 🔴 MIGRATED 2026-08-11 — `kinds-all-on` / `kinds-all-off` NO LONGER EXIST.
     * The canvas pair was replaced by ONE tri-state control, `section-eye-all`,
     * at the top of the sidebar (`1797927d57`, founder: *"move the view layers
     * all none above the Machine what will control all hide/view (just an
     * eye)"*). MEASURED by reading `web/src/App.tsx` — `section-eye-all` is the
     * only global layer control in `src/`, and `kinds-all-*` appears nowhere in
     * it.
     *
     * 🔴 WHAT THE MIGRATION IS FOR, because a click is not a testid rename.
     * The old pair named a DIRECTION; the new control has one button and three
     * states, and `SectionEye` resolves them as: all-shown ⇒ hide, otherwise ⇒
     * show. So a click only means "hide everything" while the control reads
     * `true`. Both call sites in this test sit at an unambiguous state — this
     * one at all-shown, the one below at all-hidden — and the state is ASSERTED
     * FIRST rather than assumed.
     *
     * ⚠ THE ASSERTION BEFORE THE CLICK IS THE POINT OF IT. Without it, an
     * upstream change that left one layer hidden at this line would turn this
     * click into its OPPOSITE — the control would SHOW the remainder — and the
     * test would then fail somewhere downstream on a picture assertion, reading
     * as a broken viewport rather than as a changed starting state. With it,
     * the failure lands here and names the real cause.
     *
     * ⚠ NEVER RUN. Unproven here: that `aria-pressed` is literally the string
     * `'true'` on this element in a live DOM (read at `App.tsx` `SectionEye` —
     * it is `all ? 'true' : none ? 'false' : 'mixed'`, so it is a string and not
     * the boolean Playwright would coerce), and that one click reaches every
     * live layer rather than the six move classes the old chip pair covered.
     */
    const allEye = page.getByTestId('section-eye-all');
    await expect(
      allEye,
      'the global eye is not in the all-shown state, so clicking it SHOWS rather than hides'
    ).toHaveAttribute('aria-pressed', 'true');
    await allEye.click();

    // (a) 🔴 The operator is TOLD the view is filtered, on the canvas, with
    // nothing to open. An emptier picture must never be readable as a fact
    // about the program — someone who hides `cut`, sees a clean board and
    // concludes nothing is cut there has been misled by a control we gave them.
    const indicator = page.getByTestId('hidden-indicator');
    await expect(indicator).toBeVisible();
    // "all of them", not a fixed number: the touch-plate layer is only counted
    // when the caller has told the viewport there is a plate, so the DENOMINATOR
    // is a fact about the machine and pinning it would be pinning that.
    await expect(indicator).toHaveText(/(\d+) of \1 view layers hidden/);
    await expect(indicator).toHaveText(/cut/);
    await expect(indicator).toHaveText(/workpiece/);

    // 🔴 REWRITTEN 2026-08-08, AND THE OLD FORM WAS RIGHT TO GO RED.
    //
    // This block asserted that the machined-surface layer was DISABLED and
    // pinned the exact words of its blocker — "counts, not its heights". That
    // sentence described a viewport that could not draw a machined surface at
    // all. It can now: the core exports the height map, the app asks for it at
    // a 3mm display cell, and the layer draws. So the assertion failed the day
    // the feature landed, which is the correct behaviour and the reason it must
    // NOT be repaired by loosening the regex to match both wordings — that
    // would have held a stale explanation in place and called it a passing test.
    //
    // ⚠ THE GENERAL SHAPE, because this file has several of these: an assertion
    // on the REASON a thing is unavailable is correct only while it is
    // unavailable, and becomes wrong the moment someone builds it. So what is
    // pinned below is the CAPABILITY — enabled or disabled — plus the presence
    // of *a* reason. The words are documentation; the state is the behaviour.
    // (The two places where the words ARE the property — the picker's
    // hidden-count line and a disabled tool's reason — stay pinned to their
    // content, deliberately: there a hidden item and a non-existent item look
    // identical on screen, and the sentence is the only thing separating them.)

    // The machined surface is LIVE, and its label carries the cell size. The
    // cell is not decoration: a height map at 3mm cannot show a feature
    // narrower than 3mm, and a picture that does not say what it was sampled at
    // invites being read as the part.
    //
    /*
     * 🔴 MIGRATED 2026-08-11 — `kind-result` LIVES INSIDE `panel-verify`, WHICH
     * SHIPS COLLAPSED. `LAYER_SECTION.result === 'panel-verify'`
     * (`web/src/Viewport.tsx`) and that section is the one `<Section>` in the
     * sidebar rendered `defaultOpen={false}` (`web/src/App.tsx`). A collapsed
     * section renders no body, so without the line below this reaches for an
     * element that is not in the document and fails as a 60s timeout — which
     * reads as "the machined surface layer is gone" when the truth is "the
     * drawer is shut".
     *
     * ⚠ THE ASSERTION STILL MEANS WHAT IT MEANT. `toBeEnabled()` on a layer row
     * is now carrying the LIVENESS fact, not an `enabled/disabled` fact: the
     * sidebar rows are never rendered with `disabled` at all (read at
     * `sectionLayerRows`, `App.tsx` — the button has `aria-pressed`, `title`,
     * `onClick` and no `disabled` prop), and `liveLayersOf` is what decides
     * whether the row exists. So the property proved here is *the machined
     * surface is offered*, and `result-unavailable` being absent on the next
     * line is its other half.
     *
     * ⚠ NEVER RUN. Unproven here: that opening `panel-verify` by clicking its
     * header actually puts `kind-result` in the DOM (the body is a conditional
     * render on `open`, read at `Section`), and that the click does not also hit
     * the header's eye — they are SIBLING buttons by construction, which is a
     * markup fact somebody has checked and not a click somebody has watched.
     *
     * ⚠ The section was opened at the TOP of this test, before the drawing
     * baseline was taken — see the note there for why that position matters. It
     * is asserted open here rather than assumed, so a failure says "the drawer
     * shut" instead of timing out on a control that reads as deleted.
     */
    await expectSectionOpen(page, 'panel-verify');
    await expect(page.getByTestId('kind-result')).toBeEnabled();
    await expect(page.getByTestId('result-unavailable')).toHaveCount(0);
    const res = page.getByTestId('result-resolution');
    await expect(res).toBeVisible();
    await expect(res).toContainText(/\d+(\.\d+)?mm cells/);
    // ...and it is named as the STOCK, never as the part. The two are different
    // solids and only one of them is what a height map can describe.
    await expect(res).toContainText('simulated stock after machining');
    await expect(res).toContainText('not the part');

    // The two solids that still cannot be drawn each say why, and NEITHER is
    // counted in the "N of N" above — "switched off" and "there is no data for
    // it" are different facts, and the indicator only ever claims the first.
    //
    // ⚠ MIGRATED 2026-08-08, and this one is a DESIGN CHANGE rather than a
    // rename: the chip row now renders only the LIVE layers, so a layer with no
    // data is ABSENT rather than present-and-disabled. The old assertion
    // (`kind-loaded` disabled) therefore fails on a missing element. What must
    // not be lost with it is the reason — an absent control with no explanation
    // is a feature nobody thought of — so the reason line is asserted in its
    // place.
    /*
     * 🔴 MIGRATED AGAIN 2026-08-11, AND THE `kind-walls` HALF WAS STILL WRONG.
     * The sentence above ended *"and `kind-walls`, which IS still rendered
     * disabled, keeps the present-with-a-blocker form"*. That is now false in
     * BOTH of its claims and it would have failed as an assertion on a missing
     * element:
     *
     *   1. `walls` is offered only when `wallsLive` — MEASURED at
     *      `Viewport.tsx`: `const wallsLive = !!s.drawing && s.drawing.length >
     *      0`, and `liveLayersOf` filters the layer out when it is false. A
     *      built-in fixture has no drawing, so the row is ABSENT, exactly like
     *      `loaded`.
     *   2. There is no *disabled* form left to keep. `sectionLayerRows`
     *      (`App.tsx`) renders every row as a plain `<button>` with
     *      `aria-pressed` and no `disabled` prop anywhere in it, so
     *      `toBeDisabled()` could not have passed on a rendered row either.
     *
     * ⇒ Both controls now assert ABSENCE plus a NAMED REASON, and the two
     * reasons are still required to differ (below). The meaning is preserved —
     * *"this solid cannot be drawn, and the operator is told which one and
     * why"* — and what is lost is the ability to distinguish, from the control
     * alone, "not offered" from "offered but blocked". The app no longer draws
     * that distinction anywhere, so a test asserting it would be asserting a
     * behaviour that does not exist.
     *
     * ⚠ BOTH ABSENCES ARE GUARDED, because `panel-import` is a collapsible
     * section and a shut one has no body: without `expectSectionOpen` a closed
     * Drawing panel satisfies both counts and this block goes green having
     * checked nothing. That is the `toHaveCount(0)` failure mode in its exact
     * shape — it fails as a count, so it never times out and never looks stuck.
     *
     * ⚠ NEVER RUN. Unproven here: that `panel-import` is open at this point of
     * this test (it is `defaultOpen` with no explicit prop, and this test has
     * not touched it — but panel state is now persisted per profile, which is
     * why the state is asserted rather than assumed).
     */
    await expectSectionOpen(page, 'panel-import');
    await expect(page.getByTestId('kind-loaded')).toHaveCount(0);
    await expect(page.getByTestId('loaded-unavailable')).toBeVisible();
    await expect(
      page.getByTestId('kind-walls'),
      'a walls layer control is offered for a fixture that has no drawing behind it'
    ).toHaveCount(0);
    await expect(page.getByTestId('walls-unavailable')).toBeVisible();

    // 🔴 And they name DIFFERENT blockers. One reason covering both would let a
    // viewer read one solid as the other. The reasons' WORDS are not pinned —
    // only that each control gives one, and that they are not the same one.
    const loadedWhy = (await page.getByTestId('loaded-unavailable').textContent()) ?? '';
    const wallsWhy = (await page.getByTestId('walls-unavailable').textContent()) ?? '';
    expect(loadedWhy.length, 'the loaded control is disabled with no reason').toBeGreaterThan(20);
    expect(wallsWhy.length, 'the walls control is disabled with no reason').toBeGreaterThan(20);
    expect(loadedWhy, 'the two disabled controls give the same reason').not.toBe(wallsWhy);

    // (b) 🔴 The one that matters. Byte-for-byte, and the sim counts with it.
    await page.waitForTimeout(300);
    expect(
      await page.getByTestId('gcode').textContent(),
      'switching the drawing off changed the emitted program'
    ).toBe(gcodeBefore);
    expect(await sim(), 'switching the drawing off changed the simulation verdict').toEqual(
      simBefore
    );

    // (c) NEGATIVE CONTROL for (b). "The bytes did not change" is also true of
    // a feature that does nothing at all, so the picture has to be shown to
    // have actually changed — otherwise (b) proves nothing.
    expect(
      await shot(),
      'switching every move class off changed nothing on screen, so the byte-equality above is vacuous'
    ).not.toBe(drawnBefore);

    /*
     * 🔴 MIGRATED 2026-08-11 — the same one control, at the opposite state.
     * Everything was switched off above and nothing has been switched back, so
     * `SectionEye` reads `none` here and its single click SHOWS. That direction
     * is asserted before the click for the reason the first call site gives: a
     * change upstream that left one layer visible would make this click HIDE
     * the rest, and the `hidden-indicator` assertion on the next line would then
     * fail in a way that blames the indicator.
     *
     * ⚠ NEVER RUN.
     */
    await expect(
      allEye,
      'the global eye is not in the all-hidden state, so clicking it HIDES rather than shows'
    ).toHaveAttribute('aria-pressed', 'false');
    await allEye.click();
    await expect(page.getByTestId('hidden-indicator')).toHaveCount(0);
    await page.waitForTimeout(200);

    // (d) NEGATIVE CONTROL, PER LAYER — and (c) is not enough on its own.
    // "Everything off changed the picture" is satisfied by ANY ONE layer still
    // working: with the move classes deliberately wired to nothing, hiding the
    // workpiece alone still moved the buffer and (c) passed. Measured, not
    // supposed. So each layer is switched off by itself and has to change what
    // was rendered, which is the only form of this check that catches a single
    // dead toggle.
    // ⚠ ...but FIRST put the machined surface away, and this is a measurement
    // rather than a tidy-up. That layer is a SOLID sitting at the top of the
    // stock, and it now draws by default: with it on, switching the `tab` moves
    // off changed NOT ONE PIXEL, because a tab lift happens inside the material
    // and the surface is in front of it. The control is not broken — the moves
    // were already invisible — but a per-layer negative control that cannot see
    // the layer it is testing proves nothing about that layer either way, and
    // "occluded" and "the toggle is dead" are the two things it exists to tell
    // apart. So the solid comes off, the baseline is re-taken with it off, and
    // each move class is then proven against a picture that can actually show
    // it. (Finding reported rather than papered over: the tab moves are not
    // visible in the default view once the machined surface is drawn.)
    //
    /*
     * ⚠ MIGRATED 2026-08-11. These four rows now live in three different
     * panels, and a click on one reaches a control only while its panel is
     * open: `cut`, `tab` and `rapid` are under `panel-op`, `workpiece` under
     * `panel-stock`, and `result` under `panel-verify` (MEASURED at
     * `LAYER_SECTION`, `web/src/Viewport.tsx`). `panel-verify` was opened
     * earlier in this test; the other two open by default. Each is ASSERTED
     * open rather than assumed, because panel state is persisted and a default
     * is a fact about a fresh profile.
     *
     * Nothing about what this loop MEANS has changed — each layer is still
     * switched off on its own and has to move the drawing buffer, which is the
     * only form of this check that catches one dead toggle. What changed is
     * where the buttons are, and the guards are there so a shut panel fails as
     * "the panel is shut" rather than as a 60s timeout on `kind-cut`.
     */
    await expectSectionOpen(page, 'panel-verify');
    await expectSectionOpen(page, 'panel-op');
    await expectSectionOpen(page, 'panel-stock');
    await page.getByTestId('kind-result').click();
    await page.waitForTimeout(200);
    const allOn = await shot();
    for (const layer of ['cut', 'tab', 'rapid', 'workpiece']) {
      await page.getByTestId(`kind-${layer}`).click();
      await page.waitForTimeout(200);
      expect(await shot(), `switching "${layer}" off changed nothing on screen`).not.toBe(allOn);
      await page.getByTestId(`kind-${layer}`).click();
      await page.waitForTimeout(200);
    }
  });

  // =========================================================================
  //  #17 — HOVER REPORTS WHAT IS THERE, AND ONLY WHAT THE DATA CARRIES
  // =========================================================================
  test('hovering reports the object under the pointer, and a hidden class is not pickable', async ({
    page,
  }) => {
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');

    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const panel = page.getByTestId('hover-panel');

    // Where the toolpath ACTUALLY is on screen. It is a 3D line under a camera
    // this test does not model, so a guessed point would be testing the guess:
    // a miss and a dead hover fail identically. Same reasoning as the rotate
    // handle above.
    const at = await canvas.getAttribute('data-path-probe');
    expect(at, 'the viewport published no toolpath position').toBeTruthy();
    const [px, py] = at!.split(',').map(Number);

    await page.mouse.move(box.x + px, box.y + py);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Toolpath');

    // 🔴 The trap this feature exists to avoid. A rendered move carries kind,
    // x, y and z — no feed, no operation, no tool. Anything more in the FACT
    // ROWS would be a machining number invented in TypeScript, which is the
    // defect this app has already shipped twice. (The prose note is excluded
    // from the match on purpose: it is where the absence is EXPLAINED, so it
    // names the very words the rows may not contain.)
    const rows = await panel.locator('dl').textContent();
    expect(rows).toMatch(/From/);
    expect(rows).toMatch(/To/);
    expect(
      rows,
      'the hover rows carry a machining fact the render data does not contain'
    ).not.toMatch(/feed|mm\/min|rpm|operation|pocket|profile|F\d{3,}/i);

    // The cost, measured rather than asserted in prose.
    const ms = Number(await canvas.getAttribute('data-hover-ms'));
    expect(Number.isFinite(ms), 'the viewport published no hover cost').toBeTruthy();
    // Not a performance target — a tripwire. A pick this slow would mean the
    // hover is sampling the whole program on a machine that cannot afford it,
    // and that is a finding to report, not a reason to sample less of it.
    expect(ms, `hover pick took ${ms}ms`).toBeLessThan(250);

    // 🔴 A hidden class is not pickable. A panel describing something the
    // operator cannot see is worse than no panel.
    //
    // ⚠ Every move class is switched off, not just `cut`, and the assertion is
    // that NO toolpath is reported. Naming one class was not enough: with
    // hidden layers deliberately made pickable, the ray came back with a RAPID
    // that happened to run nearer that point, and an assertion looking only for
    // "Toolpath — cut" passed while the panel was describing an invisible line.
    // The property is "no hidden class is reported", so that is what is asked.
    // ⚠ MIGRATED 2026-08-08: the chip row now renders only the LIVE layers, so
    // a fixed list of six names reaches for controls this program does not have
    // (`plate` has no tool change) and fails as a 60s timeout that reads like a
    // dead control. The property is unchanged and is still "no HIDDEN class is
    // reported" — so every move class the program actually contains is switched
    // off, whatever that set turns out to be, and the count is asserted so this
    // cannot quietly become "switch off nothing".
    /*
     * 🔴 REPAIRED 2026-08-10, AND IT WAS BROKEN IN TWO PLACES, NOT ONE.
     *
     * 1. `move-classes` NO LONGER EXISTS. The canvas chip row was moved into the
     *    sidebar panels (founder, 2026-08-11: *"put it into the left sidebar …
     *    like a small eye icon"*). MEASURED by reading `web/src/App.tsx` —
     *    `sectionLayerRows()` renders `data-testid={`layers-${panel}`}` with the
     *    SAME `kind-<layer>` buttons inside, and the only `move-classes` left in
     *    `web/src/` is a comment in `Viewport.tsx`. Reaching for it produced a
     *    60s timeout that reads like a dead control rather than a moved one.
     *
     * 2. The exclusion list named `bed`, WHICH IS NOT A LAYER ANY MORE. It was
     *    the travel envelope wearing a surface's name; it is `travel` now, with
     *    `spoilboard` beside it as the thing actually made of material.
     *
     * 🔴 AND THE LIST HANDED TO ME WAS STILL INCOMPLETE — verified against
     * `Viewport.tsx`'s own `LAYERS`/`MOVE_LAYERS` rather than trusted. The
     * non-move layers are `loaded result walls touch tool workpiece clamps
     * spoilboard travel`: **`tool` and `clamps` were missing from it**, and both
     * render a `kind-` button. An exclusion list that misses one treats a
     * non-move layer as a move class, which is how this list rotted the first
     * time.
     *
     * So the SET is taken from the structure that defines it — `layers-op`,
     * which `LAYER_SECTION` maps exactly `cut tab drill rapid change probe` into
     * — and the name list is kept only as a second, redundant assertion that the
     * structure and the names still agree. A list is a copy of a fact; the
     * container IS the fact.
     *
     * ⚠ NEVER RUN. Unproven here: that `layers-op` is in the DOM at this moment
     * (`panel-op` is `defaultOpen` and a collapsed section renders no body, so a
     * stored panel state from an earlier test could hide it), and that
     * `:not([disabled])` still selects the live rows — the sidebar rows are
     * `aria-pressed` buttons and nothing observed whether they are ever
     * `disabled` at all.
     *
     * 🔴 BOTH OF THOSE ANSWERED 2026-08-11, one of them by closing it:
     *
     *   1. The container gap is now GUARDED rather than noted —
     *      `expectSectionOpen` below asserts `panel-op` is expanded first. A
     *      shut panel would have made `layers-op` empty, `kinds` empty, and
     *      `expect(kinds.length).toBeGreaterThan(2)` would have failed while
     *      naming the wrong thing ("no move-class controls at all"). The panels
     *      now PERSIST their open state (`2bee.app.panels.open`), so this is a
     *      live risk and not a hypothetical one.
     *   2. `:not([disabled])` is, as of today, A NO-OP — MEASURED by reading
     *      `sectionLayerRows` in `web/src/App.tsx`: every layer row is a
     *      `<button type="button">` carrying `aria-pressed`, `title` and
     *      `onClick`, and NOTHING in that function ever sets `disabled`. A row
     *      that cannot be offered is not rendered. The selector is kept anyway,
     *      because it costs nothing and states the intent ("the live ones"),
     *      but it is not doing any filtering today and must not be read as
     *      evidence that a disabled state exists.
     */
    await expectSectionOpen(page, 'panel-op');
    const NON_MOVE_LAYERS = [
      'workpiece',
      'travel',
      'spoilboard',
      'touch',
      'tool',
      'clamps',
      'result',
      'loaded',
      'walls',
    ];
    const moveChips = page
      .getByTestId('layers-op')
      .locator('button[data-testid^=kind-]:not([disabled])');
    const kinds = (await moveChips.evaluateAll((els) =>
      els.map((e) => (e.getAttribute('data-testid') ?? '').replace('kind-', ''))
    )).filter((k) => !NON_MOVE_LAYERS.includes(k));
    expect(kinds.length, 'no move-class controls at all').toBeGreaterThan(2);
    // The redundant half: `layers-op` must contain move classes ONLY. If a
    // future `LAYER_SECTION` row puts a non-move layer under Operation, the
    // filter above would silently drop it and this line is what notices.
    const opAll = (await page
      .getByTestId('layers-op')
      .locator('button[data-testid^=kind-]')
      .evaluateAll((els) =>
        els.map((e) => (e.getAttribute('data-testid') ?? '').replace('kind-', ''))
      )).filter((k) => NON_MOVE_LAYERS.includes(k));
    expect(
      opAll,
      'a NON-move layer is filed under panel-op, so the move-class set and the container disagree'
    ).toHaveLength(0);
    for (const k of kinds) {
      await page.getByTestId(`kind-${k}`).click();
    }
    await expect(page.getByTestId('hidden-indicator')).toBeVisible();
    await page.mouse.move(box.x + px + 1, box.y + py + 1);
    await page.mouse.move(box.x + px, box.y + py);
    await page.waitForTimeout(300);
    const after = (await panel.count()) ? await panel.textContent() : '';
    expect(after, 'a hidden move class was still reported by the hover panel').not.toContain(
      'Toolpath'
    );
    // ...and NOT vacuously empty. The workpiece is still shown, so the pick has
    // to fall through to it — which proves the hover still works and that the
    // toolpath dropped out of it rather than picking having stopped altogether.
    //
    /* ⚠ `'Sheet'` -> `'Workpiece'`, 2026-08-11, and READ OFF THE PRODUCER rather
     * than guessed: `Viewport.tsx`'s `describe()` returns `{ title: 'Workpiece' }`
     * for `o.name === 'stock'`, and carries an inline warning naming this line.
     * The capitalisation matters and is not inferable from the sweep — the sweep
     * changed `label:'sheet'` and `publishSnap('sheet')`, both lower case; this is
     * the panel TITLE and is capitalised. Guessing `'workpiece'` here would have
     * been red for a reason unrelated to what the test is about.
     *
     * ⚠ NOT RUN as of this change: this test never reaches the assertion on this
     * box — it fails ~150 lines earlier on `viewport-canvas.boundingBox()`, because
     * the hover panel is a WebGL pick and this machine has no WebGL. The string is
     * corrected at the producer's word; it is not proven on screen. */
    expect(after, 'nothing at all was reported, so the check above proves nothing').toContain(
      'Workpiece'
    );

    // The published position goes with the class, so a caller cannot aim at one
    // that is switched off.
    expect(await canvas.getAttribute('data-path-probe')).toBeNull();
  });

  // =========================================================================
  //  #26 — THE HOUSE 3D LOOK, WITHOUT TOUCHING THE INSTRUMENT COLOURS
  // =========================================================================
  test('the scene is flat-shaded and shadowed, and the move-class colours are untouched', async ({
    page,
  }) => {
    await page.goto('/?fixtures=1');
    await ready(page);
    // 🔴 THE PROBE IS ASKED FOR, NOT ASSUMED. This test used to open the app and
    // expect a probe move to be there; commit `6b1272810` flipped
    // `probeEnabled` to `false` by default (core decision #43, `a1394e091`: a
    // plate thickness that cannot be defaulted means the thing requiring it must
    // not be defaulted either), so the program contains no probe and the
    // `kind-probe` swatch is never rendered.
    //
    // The fix is to DECLARE the setup the assertion needs — tick the plate, type
    // its top thickness — not to drop `probe` from the list below. The probe
    // colour marks the one move that drives the cutter down onto a metal plate;
    // a suite that stopped checking it because the default moved would be
    // narrower, not more correct.
    await page.getByTestId('probe-enabled').check();
    await page.getByTestId('touch-plate-mm').fill('1.6');
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const canvas = page.getByTestId('viewport-canvas');

    // A measurement of the BUILT scene, not a claim about it: how many solids
    // are flat-shaded, out of how many, and whether shadows are enabled.
    const shading = await canvas.getAttribute('data-shading');
    expect(shading, 'the viewport published no shading measurement').toBeTruthy();
    const m = /^flat:(\d+)\/(\d+) shadows:(on|off)$/.exec(shading!);
    expect(m, `unreadable shading measurement: ${shading}`).not.toBeNull();
    expect(Number(m![2]), 'no solids in the scene at all').toBeGreaterThan(0);
    expect(Number(m![1]), `a solid is not flat-shaded: ${shading}`).toBe(Number(m![2]));
    expect(m![3], 'shadows are off').toBe('on');

    // 🔴 THE SAFETY BOUNDARY. The move-class colours are a LEGEND for a program
    // that is about to drive a 2.2 kW spindle — telling a rapid from a cut is
    // why they exist. A style pass may restyle the bed, the sheet, the clamps
    // and the tool; it may not trade these for a palette. Read off the live
    // swatches, which are generated from the same numbers the scene draws with.
    const want: Record<string, string> = {
      cut: 'rgb(46, 125, 50)',
      tab: 'rgb(230, 167, 0)',
      drill: 'rgb(21, 101, 192)',
      rapid: 'rgb(158, 158, 158)',
      change: 'rgb(198, 40, 40)',
      probe: 'rgb(106, 27, 154)',
    };
    // ⚠ MIGRATED 2026-08-08. A control for a move class the program does not
    // contain is no longer rendered at all, so asking for all six by name times
    // out on whichever one is absent. Every colour that IS on screen is still
    // checked, and the set of checked colours is asserted afterwards so this
    // cannot decay into checking one.
    //
    // 🔴 NOT COVERED, and named rather than quietly dropped: `change`. No job
    // reachable from this surface renders a tool-change chip — measured across
    // `plate`, `socket` and `multi-tool` on 2026-08-08 — so the tool-change
    // colour, which is the one that marks the moment a person puts a hand near
    // the spindle, has NO test. That is a gap in the fixtures, not in the rule.
    //
    /*
     * ⚠ MIGRATED 2026-08-11. The swatches moved with the controls: they are now
     * the `<i>` inside each `kind-<layer>` row at the foot of `panel-op`, and
     * the row is still generated by `swatch()` from the numbers the scene draws
     * with (read at `sectionLayerRows`, `web/src/App.tsx` — the swatch was kept
     * DELIBERATELY on the move, because the chip row was the app's only legend
     * for these colours). So the assertion below still reads the same source it
     * always read, one container along.
     *
     * 🔴 THE GUARD IS NOT DECORATION HERE. The loop SKIPS a colour whose control
     * is absent (`count() === 0 ⇒ continue`), which is right for a move class
     * the program does not contain and catastrophic for a shut panel: every one
     * of the six would be skipped and this test would report *"the cut colour
     * was never checked"* — a true sentence pointing at the wrong cause. The
     * `expectSectionOpen` makes it say what actually happened.
     */
    await expectSectionOpen(page, 'panel-op');
    const checked: string[] = [];
    for (const [kind, rgb] of Object.entries(want)) {
      const chip = page.getByTestId(`kind-${kind}`);
      if ((await chip.count()) === 0) continue;
      const got = await chip.locator('i').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(got, `the ${kind} move-class colour changed`).toBe(rgb);
      checked.push(kind);
    }
    for (const must of ['cut', 'tab', 'rapid', 'drill', 'probe']) {
      expect(checked, `the ${must} colour was never checked`).toContain(must);
    }
  });

  // =========================================================================
  //  ObjectPicker — THE COMPONENT BEHIND EVERY LIST IN THE APP
  //
  //  Tool, Sample, Material, Sheet, Machine, Work holding and the three saved
  //  collections all render through `src/ObjectPicker.tsx`. Until these tests
  //  it had NO test of any kind: it was verified with a static
  //  `react-dom/server` render, which cannot click, cannot type and cannot move
  //  focus — so every keyboard behaviour in it was written and never once run.
  //
  //  ⚠ These tests drive the TOOL picker specifically, because it is the one
  //  whose list contains items the core has REFUSED (a shank no collet in the
  //  shop can hold). A picker tested only against a list where everything is
  //  usable cannot see the rule that matters.
  // =========================================================================

  test('the search box hides an unusable tool, so an operator reads "needs a collet" as "no such tool"', async ({
    page,
  }) => {
    await page.goto('/');
    await panelsReady(page);

    await page.getByTestId('tool-picker-trigger').click();
    const list = page.getByTestId('tool-picker-list');
    const opts = list.locator('.op-opt');
    const unusable = list.locator('.op-opt[aria-disabled="true"]');
    const count = page.getByTestId('tool-picker-hidden-count');
    await expect(list).toBeVisible();

    // ⚠ The library's SIZE is not pinned here, and deliberately. `bom` adds
    // cutters and the core re-derives every fit verdict against the machine's
    // collets, so a hard 7 or 51 would go red on a change that is not a defect.
    // What is pinned is the RULE, measured across two states of the same list.
    const total = await opts.count();
    const totalUnusable = await unusable.count();
    expect(total, 'the tool library rendered nothing at all').toBeGreaterThan(3);
    expect(
      totalUnusable,
      'no tool in the library is unusable on this machine, so this test can prove nothing'
    ).toBeGreaterThan(0);
    await expect(count).toHaveText(`${total} shown`);

    const search = page.getByTestId('tool-picker-search');
    const noCollet = page.getByTestId('tool-picker-opt-End Mill - Up-cut 12mm 2F');

    // 🔴 RULE 1, AND IT IS A SAFETY PROPERTY RATHER THAN A UI NICETY. On screen
    // a hidden item and a non-existent item are IDENTICAL. In a machining tool
    // that difference decides whether someone walks to the drawer for a collet
    // or concludes the cutter does not exist and runs the job with the wrong
    // one. So the search narrows by NAME and by nothing else: the 12mm up-cut
    // is a shank no collet in this shop can hold, it matches "up-cut",
    // therefore it is still on screen — greyed, unselectable, and carrying the
    // core's own reason.
    await search.fill('Up-cut');
    await expect(noCollet).toBeVisible();
    await expect(noCollet).toHaveAttribute('aria-disabled', 'true');
    await expect(noCollet).toContainText('12mm shank');
    await expect(noCollet).toContainText("the shop's collets are");

    // ...and NOTHING is on screen that fails to match the string. A search that
    // quietly kept extras would be the same defect wearing the other face.
    const names = await list
      .locator('.op-opt .op-opt-name')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').toLowerCase()));
    expect(names.length, 'the search matched nothing, so nothing below is tested').toBeGreaterThan(1);
    for (const n of names) {
      expect(n, `"${n}" is on screen and does not contain the search string`).toContain('up-cut');
    }

    // 🔴 The count line, cross-checked against what is actually in the list at
    // both states rather than against itself. `hidden` is what the search took
    // away; `of them unusable` is how many of those were tools the machine
    // cannot hold — the number that tells someone whether to go and look for a
    // collet. Both are asserted to be non-zero first, or the equality below
    // would be satisfied by a line that always says nothing was hidden.
    const shown = names.length;
    const shownUnusable = await unusable.count();
    expect(total - shown, 'the search hid nothing').toBeGreaterThan(0);
    expect(
      totalUnusable - shownUnusable,
      'the search hid no unusable tool, so the unusable half of the count is untested'
    ).toBeGreaterThan(0);
    //
    // ⚠ MIGRATED 2026-08-11 — PUNCTUATION ONLY, AND IT IS NOT A REGRESSION.
    // The line read `N hidden by search (M of them unusable)` and now reads
    // `N hidden by search — M of them unusable`. The parentheses were taken over
    // by the ATTRIBUTION list when the picker gained facets: with two narrowing
    // controls active the foot says `N hidden (4 by the Material filter, 3 by
    // search)`, so the unusable clause had to move out of a bracket it no longer
    // owned. Both numbers, and both of their meanings, are unchanged — which is
    // why this is a text edit and not a ticket.
    //
    // 🔴 STILL AN EXACT STRING, deliberately. A regex over "contains both
    // numbers" would survive the two of them swapping places, and "3 hidden, 12
    // of them unusable" is a sentence that cannot be true. Only the SEARCH facet
    // is active here, so the single-clause form is the one this state produces.
    await expect(count).toHaveText(
      `${total - shown} hidden by search — ${totalUnusable - shownUnusable} of them unusable`
    );

    // The way back is one click and it says how many it will bring back.
    await expect(page.getByTestId('tool-picker-showall')).toContainText(`show all ${total}`);
    await page.getByTestId('tool-picker-showall').click();
    await expect(opts).toHaveCount(total);
    await expect(count).toHaveText(`${total} shown`);

    // A search that matches NOTHING says the same thing in words: nothing was
    // dropped for being unusable. An empty list with no explanation is where a
    // user decides the library is empty.
    await search.fill('zzz-no-such-tool');
    await expect(opts).toHaveCount(0);
    await expect(page.getByTestId('tool-picker-none-match')).toContainText(
      'Nothing was dropped for being unusable'
    );
  });

  test('a tool no collet in the shop can hold is committed anyway, and the spindle is handed a cutter it cannot grip', async ({
    page,
  }) => {
    await page.goto('/');
    await panelsReady(page);
    const trigger = page.getByTestId('tool-picker-trigger');
    const feed = page.getByTestId('tool-row-feed-End Mill - Down-cut 6mm 2F');

    // The state before. 🔴 THIS ASSERTION USED TO READ `3600 mm/min` and was one
    // of the three that pinned the panel's own material-blind multiplication —
    // see the negative control above. It is kept, not deleted: what it is FOR is
    // a before/after pair around the refusal, and a cell whose text is stable is
    // exactly as good a witness as one carrying a number. Its job was never to
    // check the feed.
    const NOT_SHOWN = 'not shown';
    await expect(feed).toHaveText(NOT_SHOWN);

    await trigger.click();
    const none = page.getByTestId('tool-picker-opt-End Mill - Up-cut 12mm 2F');

    // 🔴 The ARIA attribute, not `toBeDisabled()`. That matcher reports an
    // `<option disabled>` as ENABLED — the trap already documented above — and
    // this row is not an `<option>` at all but an `li[role=option]`, where
    // `aria-disabled` is the only thing the browser and AT honour.
    await expect(none).toHaveAttribute('aria-disabled', 'true');
    await expect(none).toHaveAttribute('aria-selected', 'false');

    // Reading it is allowed and is the point of listing it: the properties view
    // says why it cannot be used, in the core's words.
    await none.hover();
    await expect(page.getByTestId('tool-picker-blocked')).toContainText('12mm shank');

    // (a) A CLICK must not add it.
    //
    // 🔴 `{ force: true }`, and this is not a workaround. Playwright's own
    // actionability treats `aria-disabled="true"` as "not enabled" and WAITS
    // instead of clicking — so an unforced click here never happens, the test
    // goes green having exercised nothing, and the rule stays unproven. The
    // browser has no such scruples: the row is an `<li>`, its pointer events
    // are live, and a user in a workshop can and will click it. Forcing the
    // click is what makes this a test of the guard rather than of Playwright.
    //
    // ⚠ The tool picker is MULTI-select, so "the popup stayed open" proves
    // nothing here — it stays open on a successful add too. The state is what
    // is asserted: the row is not selected and no chip appears for it.
    await none.click({ force: true });
    await expect(none).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('tool-picker-chip-End Mill - Up-cut 12mm 2F')).toHaveCount(0);

    // (b) Nor may ENTER on it — the keyboard path reaches the same commit and
    // would be a second door into the same failure. The row is active from the
    // hover above, so Enter is aimed straight at it.
    await page.keyboard.press('Enter');
    await expect(none).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('tool-picker-chip-End Mill - Up-cut 12mm 2F')).toHaveCount(0);

    // 🔴 The assertion that matters: the TOOL SET did not move — asserted after
    // Done, which is the path that KEEPS a multi-select's changes, so a refusal
    // that leaked into the set could not hide behind Cancel's revert. A picker
    // that refuses on screen and changes the state behind it is worse than one
    // that never refused, because the operator has been shown a refusal.
    await page.getByTestId('tool-picker-done').click();
    await expect(trigger).toContainText('End Mill - Down-cut 6mm 2F');
    await expect(trigger).not.toContainText('Up-cut 12mm');
    // ...and the surviving row is untouched. Same correction as the assertion at
    // the top of this test: it read `3600 mm/min` and was pinning the UI's own
    // arithmetic rather than the tool set.
    await expect(feed).toHaveText(NOT_SHOWN);
  });

  test('the list cannot be driven from the keyboard, in a shop where the other hand is on the machine', async ({
    page,
  }) => {
    await page.goto('/');
    await panelsReady(page);
    const trigger = page.getByTestId('tool-picker-trigger');
    const search = page.getByTestId('tool-picker-search');
    const list = page.getByTestId('tool-picker-list');

    // These four are what a native <select> gives for free and a hand-rolled
    // list loses unless somebody builds them. All four are built; none had ever
    // been pressed.

    // (a) TYPE-AHEAD FROM THE CLOSED TRIGGER. The first printable character
    // opens the list AND is the first character of the search. A list that
    // opens empty has silently eaten the keystroke, which is how a user ends up
    // typing a tool name into a box that already lost its first letter.
    await trigger.focus();
    await page.keyboard.press('u');
    await expect(list).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('u');

    // Narrow to the three up-cuts, so the row the arrows land on is known and
    // is not the one already selected.
    await page.keyboard.type('p-cut ');
    await expect(search).toHaveValue('up-cut ');
    await expect(list.locator('.op-opt')).toHaveCount(3);

    // (b) ARROWS MOVE THE ACTIVE ROW — and move `aria-activedescendant` with
    // it, which is the only thing a screen reader can follow. A highlight that
    // moves without it is a control that works for exactly one kind of user.
    const active = list.locator('.op-opt.op-active');
    await expect(active).toHaveText(/Up-cut 6mm/);
    const first = await search.getAttribute('aria-activedescendant');
    expect(first, 'the search box points at no active row at all').toBeTruthy();
    await page.keyboard.press('ArrowDown');
    await expect(active).toHaveText(/Up-cut 8mm/);
    const second = await search.getAttribute('aria-activedescendant');
    expect(second, 'ArrowDown moved the highlight and not the ARIA pointer').not.toBe(first);
    await page.keyboard.press('ArrowUp');
    await expect(active).toHaveText(/Up-cut 6mm/);
    await expect(search).toHaveAttribute('aria-activedescendant', first!);

    // (c) ENTER COMMITS the active row. This picker is MULTI-select, so a
    // commit ADDS to the set and the popup deliberately stays open — picking a
    // set one item at a time through a popup that closes on every pick is the
    // thing that makes people give up and use one tool.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tool-picker-opt-End Mill - Up-cut 8mm 2F')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(list, 'a multi-select popup closed on the first add').toBeVisible();

    // (d) 🔴 ESCAPE DISMISSES AND KEEPS. **This pin was INVERTED on 2026-08-09
    // and the commit that inverted it is `6b1272810`** — read its body before
    // changing this back.
    //
    // What it asserted until then: Escape REVERTED the set to what it was when
    // the popup opened. Measured in a browser rather than reasoned about,
    // `ObjectPicker` had FIVE exits and only two of them reverted — Escape and
    // Cancel — while click-away, Done and Tab all kept. So the split ran between
    // two DISMISSAL gestures a user reads as identical: press Escape and lose
    // the tool, click three pixels outside the popup and keep it. The consequence
    // is physical: an operator fits a 25mm surfacing cutter, presses Escape, and
    // the job is planned for the 6mm end mill that was there before.
    //
    // Escape now behaves like every other dismissal, and revert has exactly ONE
    // route — the button whose label promises it, asserted at (d2) below.
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(
      trigger,
      'Escape threw away a tool the operator had added — dismissing is not reverting'
    ).toContainText('Up-cut 8mm');
    await expect(trigger).toContainText('End Mill - Down-cut 6mm 2F');
    // ...and put focus back where the eye is. A popup that closes and drops
    // focus on <body> means the next keystroke goes nowhere.
    await expect(trigger).toBeFocused();

    // (d2) 🔴 THE NEGATIVE CONTROL FOR (d), AND IT IS NOT OPTIONAL. Without it
    // this test would pass equally well had the fix DELETED reverting altogether
    // rather than moving it to one button — "Escape keeps" and "nothing reverts,
    // ever" are indistinguishable from (d) alone. So: reopen, add a THIRD tool
    // (a different one, because this picker is multi-select and clicking the
    // same row again would un-toggle it and prove nothing), press CANCEL, and
    // require the set to go back to what it was when the popup opened.
    await trigger.click();
    await expect(list).toBeVisible();
    await page.getByTestId('tool-picker-opt-End Mill - Up-cut 6mm 2F').click();
    await expect(trigger, 'the reopened picker did not take the add').toContainText('Up-cut 6mm');
    await page.getByTestId('tool-picker-cancel').click();
    await expect(list).toHaveCount(0);
    await expect(
      trigger,
      'Cancel kept a tool the operator backed out of — after 6b1272810 this is the ONLY exit that reverts, so nothing reverts at all'
    ).not.toContainText('Up-cut 6mm');
    // And it reverts to the set as it was AT OPEN, not to empty and not to the
    // app's opening state: the tool Escape legitimately kept must survive.
    await expect(
      trigger,
      'Cancel reverted past the popup that was open — it discarded a tool added before it'
    ).toContainText('Up-cut 8mm');
    await expect(trigger).toContainText('End Mill - Down-cut 6mm 2F');

    // (e) The same four keys on the DRAWING picker.
    //
    // 🔴 MIGRATED 2026-08-11 — THIS LEG USED TO BE THE SINGLE-SELECT CONTRACT
    // AND THE DRAWING PICKER IS NO LONGER SINGLE-SELECT. Founder, 2026-08-10:
    // *"I should able to add more than 1 drawings"*; `App.tsx` now renders it
    // `mode="multi"`, so Enter ADDS and the popup deliberately stays open. The
    // old assertions — list closed, trigger focused — were asserting a contract
    // this control gave up, and `pickOne`'s own header in this file already
    // records the change for the click path. **The expectation was outrun by a
    // product decision; nothing here is a defect.**
    //
    // ⚠ AND THE LEG WAS NOT DELETED, because deleting it would take the single
    // mode's coverage with it: (e2) below drives the identical four keys on
    // `machine-picker`, which IS still `mode="single"`. "Both modes ship;
    // testing one and assuming the other is how a mode gets released untried" —
    // the original reason, still true, just pointed at a picker that still has
    // the mode.
    const sample = page.getByTestId('drawing-picker-trigger');
    await sample.focus();
    await page.keyboard.press('h');
    const sampleList = page.getByTestId('drawing-picker-list');
    await expect(sampleList).toBeVisible();
    await expect(page.getByTestId('drawing-picker-search')).toHaveValue('h');
    // FOUR, not two, since the drawing surfaces merged (TODO #54). Counted at
    // the catalogues rather than adjusted until green: `Hive super end` and
    // `Hive box prototype` from `SAMPLES`, plus `Hive super end — solid (STL)`
    // and `Schools-kit solar plate` from `MESH_SAMPLES` — the last one matches
    // on the "h" in "Schools", which is rule 1 working exactly as intended (the
    // search narrows by NAME and has no idea what a mesh is).
    //
    // The count is asserted rather than left loose because of the FIRST and
    // THIRD: two rows whose names differ only by a suffix are exactly the pair
    // a keyboard user lands on by accident, and picking the wrong one is
    // picking a section of a solid over a drawn profile.
    await expect(sampleList.locator('.op-opt')).toHaveCount(4);
    await expect(sampleList.locator('.op-opt.op-active')).toHaveText(/Hive super end/);
    await page.keyboard.press('ArrowDown');
    await expect(sampleList.locator('.op-opt.op-active')).toHaveText(/Hive box prototype/);
    await page.keyboard.press('Enter');
    // MULTI: Enter ADDS and the dialog stays open. Asserted on the ROW's
    // `aria-selected` as well as on the trigger, because a chip on the trigger
    // and a ticked row are written from the same set and only the row can say
    // WHICH row the keyboard was on when Enter landed.
    await expect(
      sampleList,
      'the drawing picker closed on Enter — it is mode="multi" since 2026-08-10 and a set-builder that closes on every add is the thing that change removed'
    ).toBeVisible();
    await expect(
      page.getByTestId('drawing-picker-opt-sample:Hive box prototype')
    ).toHaveAttribute('aria-selected', 'true');
    await expect(sample).toContainText('Hive box prototype');
    // Done is the multi mode's keep-and-close, and it puts focus back on the
    // trigger — the property the old single-mode Enter used to carry here.
    await page.getByTestId('drawing-picker-done').click();
    await expect(sampleList).toHaveCount(0);
    await expect(sample).toBeFocused();

    // (e2) 🔴 THE SINGLE-SELECT CONTRACT, ON A PICKER THAT STILL HAS IT. Enter
    // chooses and CLOSES, and focus comes back to the trigger. `machine-picker`
    // is `mode="single"` (`App.tsx`), and single mode has no Done button by
    // design — choosing a row IS the commit — so this is the only place the
    // closing behaviour can be observed at all.
    const machine = page.getByTestId('machine-picker-trigger');
    await machine.focus();
    await page.keyboard.press('d');
    const machineList = page.getByTestId('machine-picker-list');
    await expect(machineList).toBeVisible();
    await expect(page.getByTestId('machine-picker-search')).toHaveValue('d');
    // TWO of the three shipped presets carry a "d" — `Bellwether Lead 1250x670`
    // and `Desktop 3018`; `MakerSpace 6090` does not. Counted at
    // `MACHINE_PRESETS` rather than adjusted until green, and nothing has been
    // saved into this browser's machine store, so there are no `saved:` rows to
    // widen it. ⚠ If a fourth preset arrives with a "d" in its name this goes
    // red on a change that is not a defect — the count is here because the
    // ArrowDown below has to land on a KNOWN row.
    await expect(machineList.locator('.op-opt')).toHaveCount(2);
    await expect(machineList.locator('.op-opt.op-active')).toHaveText(/Bellwether Lead/);
    await page.keyboard.press('ArrowDown');
    await expect(machineList.locator('.op-opt.op-active')).toHaveText(/Desktop 3018/);
    await page.keyboard.press('Enter');
    await expect(
      machineList,
      'a SINGLE-select popup stayed open after Enter — choosing a row is the commit here, so there is no second gesture that closes it'
    ).toHaveCount(0);
    await expect(machine).toContainText('Desktop 3018');
    await expect(machine).toBeFocused();
    // ...and it REACHED THE APP. A popup that closes on the right row while the
    // panel keeps the old machine is the same defect as one that never fired:
    // `Desktop 3018` is 300 x 180, and the app opens on 600 x 900.
    await expect(page.getByTestId('travel-x')).toHaveValue('300');
  });

  // ⚠ RENAMED 2026-08-11 (was *"every tool row draws the same generic bit, so a
  // drill and an end mill are one picture"*). The old name described the row,
  // which no longer draws anything, and it named the DEFECT rather than the
  // property — nothing in `gates/` or the docs referenced it, checked before the
  // rename rather than assumed.
  test('every tool draws its OWN bit on the properties panel, so a drill and an end mill are not one picture', async ({
    page,
  }) => {
    /*
     * 🔴 MIGRATED 2026-08-11 — THE DRAWING MOVED OFF THE ROW, ON PURPOSE, AND
     * THIS TEST WAS STILL LOOKING FOR IT THERE. It read
     * `.op-opt svg[data-tool-shape]` and found nothing on all 51 rows, which
     * looks exactly like a component that stopped rendering. It has not:
     * `ObjectPicker`'s `ObjectItem` records the removal in its own type —
     * *"🔴 `icon` IS GONE — founder, 2026-08-10: the drawing belongs on the
     * PROPERTIES PANEL ONLY. It was a 22x24px schematic beside the name in every
     * option row, which is the size at which a shank step and a flute length —
     * the two facts the drawing exists to show — are exactly what you cannot
     * see."* The FIELD was deleted rather than left unrendered, and the row
     * markup carries a comment saying the picture is on the panel.
     *
     * ⚠ So the test moves rather than relaxes. Every property it held is still
     * held — every tool is drawn, the geometry is per tool and not per category,
     * more than one tip and more than one helix appear, and the picture has a
     * text alternative — they are just read at `tool-picker-shape`, one row at a
     * time, because the panel shows ONE object.
     *
     * ⚠ WHAT IT NO LONGER CATCHES: a row rendering a picture of the WRONG tool
     * beside its name. That surface no longer exists, so there is nothing left
     * to be wrong on it; the equivalent defect is now the panel showing the
     * wrong object, which the active-row assertion inside the loop pins.
     *
     * ⚠ AND IT COSTS A WALK. The panel follows the ACTIVE row, so this presses
     * Home and then ArrowDown once per tool. Each stop asserts WHICH row is
     * active before reading the picture — without that the read races the
     * re-render and would attribute one tool's geometry to its neighbour, which
     * is the exact failure the per-tool assertions below exist to catch.
     */
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('tool-picker-trigger').click();

    const list = page.getByTestId('tool-picker-list');
    const rows = list.locator('.op-opt');
    const active = list.locator('.op-opt.op-active');
    // The picture, on the properties panel. Located inside `-shape` rather than
    // by `svg[data-tool-shape]` alone: the panel is the surface under test, and
    // a selector that would still pass if the drawing reappeared somewhere else
    // is not asserting where it is.
    const shape = page.getByTestId('tool-picker-shape').locator('svg[data-tool-shape]');

    const ids = await rows.evaluateAll((els) =>
      els.map((e) => (e.getAttribute('data-testid') ?? '').replace('tool-picker-opt-', ''))
    );
    expect(ids.length).toBeGreaterThan(10);

    await page.keyboard.press('Home');
    const shapes: {
      id: string;
      drawn: boolean;
      tip: string | null;
      helix: string | null;
      label: string;
    }[] = [];
    for (let i = 0; i < ids.length; i++) {
      // 🔴 The stop is asserted, not assumed. This retries until the highlight
      // has actually moved, which is also what makes the read below belong to
      // THIS tool: the row and the panel are written by the same render.
      await expect(
        active,
        `the keyboard walk lost its place at index ${i} — expected ${ids[i]}`
      ).toHaveAttribute('data-testid', `tool-picker-opt-${ids[i]}`);
      const drawn = (await shape.count()) === 1;
      shapes.push({
        id: ids[i],
        drawn,
        tip: drawn ? await shape.getAttribute('data-tool-tip') : null,
        helix: drawn ? await shape.getAttribute('data-tool-helix') : null,
        label: drawn ? ((await shape.getAttribute('aria-label')) ?? '') : '',
      });
      if (i < ids.length - 1) await page.keyboard.press('ArrowDown');
    }
    expect(shapes.length).toBe(ids.length);

    // Every tool is drawn. A tool with no schematic is not a smaller picture, it
    // is a tool whose geometry the list declined to state.
    const undrawn = shapes.filter((r) => !r.drawn).map((r) => r.id);
    expect(undrawn, `tools with no schematic: ${undrawn.join(', ')}`).toHaveLength(0);

    // 🔴 THE FAILURE THIS GUARDS. If the picture came from the CATEGORY rather
    // than from the tool's own record, every row in a category would be
    // identical and the drawing would be decoration — worse than none, because
    // a picture is believed faster than a line of text. So the geometry is
    // asserted per tool, on tools chosen because their NAMES are nearly the
    // same and their cutters are not.
    const of = (id: string) => shapes.find((r) => r.id === id);
    // Three end mills that differ ONLY in which way the flutes pull the chip —
    // up (lifts, tears the top face), down (presses, packs the slot),
    // compression (both). That is the difference the picture exists to show.
    expect(of('End Mill - Up-cut 6mm 2F')?.helix).toBe('up');
    expect(of('End Mill - Down-cut 6mm 2F')?.helix).toBe('down');
    expect(of('End Mill - Compression 6mm 2F')?.helix).toBe('compression');
    // ...and the tip follows the record, not the label: a ball nose is round,
    // a 118° twist drill and a countersink come to a cone, and a brad point
    // records a 180° point, which IS flat.
    expect(of('Ball Nose 6mm 2F')?.tip).toBe('ball');
    expect(of('Drill - Twist Carbide 6mm 2F')?.tip).toBe('cone');
    expect(of('Countersink 8.3mm 3F')?.tip).toBe('cone');
    expect(of('Drill - Brad Point 6mm 2F')?.tip).toBe('flat');

    // NEGATIVE CONTROL for the whole idea: a generic bit repeated 51 times
    // would satisfy "every tool is drawn" and collapse to one value here.
    expect(new Set(shapes.map((r) => r.tip)).size, 'every tool drew the same tip').toBeGreaterThan(
      1
    );
    expect(
      new Set(shapes.map((r) => r.helix)).size,
      'every tool drew the same flute direction'
    ).toBeGreaterThan(1);

    // The drawing is not the only copy of what it says. A picture with no text
    // alternative is a control that works for exactly one kind of user, and
    // this one is chosen with a spindle running.
    expect(of('End Mill - Down-cut 6mm 2F')?.label).toContain('Ø6 mm');
    expect(of('End Mill - Down-cut 6mm 2F')?.label).toContain('6 mm shank');
  });

  // =========================================================================
  //  THE FIRST SCREEN, AND THE FIRST REAL DRAWING
  // =========================================================================

  test('an app with no drawing shows a blank column and reads as broken rather than as waiting', async ({
    page,
  }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await panelsReady(page);

    // 🔴 This is the state a user sees FIRST. The fixtures came off the operator
    // surface so that nothing is planned behind their back — a toolpath on
    // screen for a part they never supplied looks like their work — and the
    // cost of that is an empty report column, which reads as a crash.
    const empty = page.getByTestId('no-drawing');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No drawing yet');
    // It must say what to DO. "Nothing here" is not an empty state.
    //
    // MIGRATED 2026-08-09 (TODO #54): it used to look for the word **Sample**,
    // and that is no longer the name of any control — the three drawing
    // surfaces merged into one list labelled **Drawing**. This assertion did its
    // job: an empty state that tells you to use a control that no longer exists
    // is worse than one that says nothing, and nothing else would have caught
    // the copy going stale behind the rename.
    await expect(empty).toContainText('Drawing');

    // ...and NOTHING is planned. Not a summary, not a refusal, not a program.
    // "The panel is empty" and "there is no program" have to be the same fact,
    // or the empty state is decoration over a plan nobody asked for.
    await expect(page.getByTestId('status')).toHaveCount(0);
    await expect(page.getByTestId('panel-summary')).toHaveCount(0);
    await expect(page.getByTestId('blocked')).toHaveCount(0);
    await expect(page.getByTestId('program-map').locator('span')).toHaveCount(0);

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('a real cad drawing is refused for travel and the app either hides it or reports it without the numbers', async ({
    page,
  }) => {
    await page.goto('/');
    await panelsReady(page);
    await expect(page.getByTestId('no-drawing')).toBeVisible();

    // A REAL hive panel, copied from `hardware/cad`, parsed by the real DXF
    // importer — not a fixture built in Rust. 21 interior features.
    await page.getByTestId('drawing-picker-trigger').click();
    await page.getByTestId('drawing-picker-opt-sample:Hive super end').click();
    await ready(page);

    await expect(page.getByTestId('no-drawing')).toHaveCount(0);
    await expect(page.getByTestId('imported-name')).toContainText('Hive super end');

    // ⚠ THIS DRAWING IS REFUSED, and that is the point of shipping it. Its
    // geometry starts at x=-3, y=-3.5 once the cutter radius is carried — which
    // is what a drawing straight out of CAD normally does — so the program
    // runs off the table and grblHAL would reject it at the controller.
    await expect(page.getByTestId('status')).toHaveText('refused');
    const blocked = page.getByTestId('blocked');
    await expect(blocked).toBeVisible();

    // 🔴 WITH THE NUMBERS. "This program will not be produced" on its own sends
    // someone back to CAD to guess. The axis, the offending coordinate and the
    // allowed range are what turn a refusal into a fix.
    await expect(blocked).toContainText('outside X travel: -3');
    await expect(blocked).toContainText('outside Y travel: -3.5');

    // ...and the fix is OFFERED, in millimetres, never applied — moving the
    // datum silently would move the part away from the clamps that are already
    // bolted down.
    await expect(page.getByTestId('notes')).toContainText('move the datum by X +3.000 Y +3.500');
    await expect(page.getByTestId('notes')).toContainText('check the clamps first');

    // The sample says up front that refusing is what it is for. A demo that
    // refuses with no warning reads as a broken importer.
    await expect(page.getByTestId('sample-note')).toContainText('x=-3');
  });

  // =========================================================================
  //  THE PROGRAM MAP
  // =========================================================================

  test('the coloured bar claims a program when there is none, or draws nothing when there is one', async ({
    page,
  }) => {
    await page.goto('/');
    await panelsReady(page);

    // No drawing, no program, no bar. A bar with slices in it under an empty
    // report column would be a picture of a program nobody asked for.
    const map = page.getByTestId('program-map');
    await expect(map).toHaveCount(1);
    await expect(map.locator('span')).toHaveCount(0);

    // With a program, the bar is drawn — from `report.render`, the SAME array
    // the 3D view draws, so the two cannot disagree about what the program
    // contains.
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');
    const slices = page.getByTestId('program-map').locator('span');
    expect(await slices.count(), 'a program exists and the bar is empty').toBeGreaterThan(1);

    const classes = await slices.evaluateAll((els) => els.map((e) => e.className));
    // Every slice is a move class the legend knows. A `pm-undefined` would draw
    // an unstyled sliver that reads as a gap in the program.
    for (const c of classes) {
      expect(c, `unreadable slice class ${c}`).toMatch(/^pm pm-[a-z]+$/);
    }
    // 🔴 One slice per RUN of same-kind moves, which is what makes a
    // 6000-move program a few dozen DOM nodes. Two adjacent slices of the same
    // kind means the runs were not collapsed — the bar is then per-move, and a
    // long program would put thousands of nodes on the operator's screen.
    for (let i = 1; i < classes.length; i++) {
      expect(
        classes[i],
        `two adjacent slices share a kind (${classes[i]}), so the runs were not collapsed`
      ).not.toBe(classes[i - 1]);
    }
  });

  // =========================================================================
  //  TODO #44 — THE TOOL MARKER DRAWS THE ROW, OR REFUSES AND SAYS WHICH FACT
  //             IS MISSING
  // =========================================================================
  //
  // 🔴 WHY THESE TESTS EXIST AT ALL. `toolMarkerShape()` is exported from
  // `Viewport.tsx` "so it can be exercised", and for two commits nothing
  // exercised it: both authors verified it with throwaway probe scripts, pasted
  // the output into their commit bodies and deleted the scripts. The evidence
  // lived in the git log, which is the definition of ungated in this lane.
  //
  // 🔴 AND WHY THEY RUN IN THE PAGE. The function is called through
  // `window.__toolMarkerShape`, the instrument `Viewport.tsx` publishes behind
  // `?fixtures=1`, so what is exercised is the code the BROWSER BUNDLE holds.
  // Importing the module into node would test the source and say nothing about
  // what shipped — the same reason gate K3 exists.

  /** The shape `toolMarkerShape()` returns. Kept structurally identical to
   *  `ToolMarkerShape` in `Viewport.tsx`; it crosses the page boundary as JSON,
   *  so it is re-declared rather than imported. */
  interface MarkerShape {
    refused: string | null;
    cutting: [number, number][];
    shank: [number, number][] | null;
    openTipRadiusMm: number | null;
    drawn: string[];
    notDrawn: string[];
    summary: string;
  }

  /** Load the page far enough that the instrument is on `window`. */
  async function markerInstrument(page: Page) {
    await page.goto('/?fixtures=1');
    await panelsReady(page);
    await page.waitForFunction(
      () => typeof (window as unknown as Record<string, unknown>).__toolMarkerShape === 'function'
    );
  }

  /** Read one row through the shipped bundle's own reading of it. */
  function markerFor(page: Page, row: unknown): Promise<MarkerShape> {
    return page.evaluate(
      (t) =>
        (
          (window as unknown as Record<string, unknown>).__toolMarkerShape as (
            x: unknown
          ) => MarkerShape
        )(t),
      row
    );
  }

  /**
   * The widest point of the CUTTING solid — the drawn envelope.
   *
   * ⚠ Only valid when the row states a cutting length AND a shank: a flute whose
   * length the record does not hold ends in a TORN ring drawn at 1.2x the
   * radius, and that zig-zag is a drafting annotation, not material. Taking the
   * maximum on such a profile would quietly assert the tear as the cutter's
   * width — so every row fed to this helper states both, and the torn case is
   * measured on its wall points instead, below.
   */
  const wallRadius = (m: MarkerShape) => Math.max(...m.cutting.map(([r]) => r));

  /** Rows that state EVERY length, so the profile carries no tear. */
  const STATED = { shank_mm: 6, cutting_length_mm: 22, flute_type: 'down-cut' };
  const ROWS = {
    endmill6: { id: 'em6', category: 'End Mill', diameter_mm: 6, is_angular: false, ...STATED },
    endmill12: {
      id: 'em12', category: 'End Mill', diameter_mm: 12, is_angular: false,
      ...STATED, shank_mm: 12, cutting_length_mm: 32,
    },
    surfacing25: {
      id: 'sf25', category: 'Surfacing', diameter_mm: 25, is_angular: false,
      ...STATED, shank_mm: 8, cutting_length_mm: 12,
    },
    vbit90: {
      id: 'v90', category: 'V-Bit', diameter_mm: 6, included_angle_deg: 90,
      is_angular: true, ...STATED, cutting_length_mm: 12,
    },
    vbit60: {
      id: 'v60', category: 'V-Bit', diameter_mm: 6, included_angle_deg: 60,
      is_angular: true, ...STATED, cutting_length_mm: 12,
    },
    engraving30: {
      id: 'en30', category: 'Engraving', diameter_mm: 3.175, included_angle_deg: 30,
      is_angular: true, ...STATED, shank_mm: 3.175, cutting_length_mm: 10,
    },
    drill118: {
      id: 'd118', category: 'Drill', diameter_mm: 5, point_angle_deg: 118,
      is_angular: false, ...STATED, shank_mm: 5, cutting_length_mm: 40,
    },
    brad180: {
      id: 'd180', category: 'Drill', diameter_mm: 5, point_angle_deg: 180,
      is_angular: false, ...STATED, shank_mm: 5, cutting_length_mm: 40,
    },
    ball6: {
      id: 'b6', category: 'Ball Nose', diameter_mm: 6, is_angular: false,
      ...STATED, cutting_length_mm: 20,
    },
  } as const;

  test('the tool marker draws each tool class from its row, at an envelope that is never undersize', async ({
    page,
  }) => {
    await markerInstrument(page);

    const m = {
      endmill6: await markerFor(page, ROWS.endmill6),
      endmill12: await markerFor(page, ROWS.endmill12),
      surfacing25: await markerFor(page, ROWS.surfacing25),
      vbit90: await markerFor(page, ROWS.vbit90),
      vbit60: await markerFor(page, ROWS.vbit60),
      engraving30: await markerFor(page, ROWS.engraving30),
      drill118: await markerFor(page, ROWS.drill118),
      brad180: await markerFor(page, ROWS.brad180),
      ball6: await markerFor(page, ROWS.ball6),
    };

    // ---------------------------------------------------------------------
    // (a) 🔴 THE ENVELOPE CIRCUMSCRIBES THE TRUE CIRCLE, AND THAT IS A SAFETY
    //     DIRECTION, NOT A ROUNDING TASTE.
    //
    // A 12-sided lathe with its vertices ON the circle draws a cutter up to
    // 3.5% NARROWER than it is — in the scene somebody uses to decide whether
    // that cutter clears a clamp. So the flats sit TANGENT to the circle
    // instead and the drawn envelope is never smaller than the real one.
    //
    // ⚠ `toBeCloseTo(dia / 2)` — the obvious assertion — would pass on the
    // UNSAFE version and fail on the safe one. The direction is asserted
    // explicitly for that reason: strictly greater than the true radius, and
    // inside the 3.5% the hover panel promises.
    // ---------------------------------------------------------------------
    for (const [name, shape] of Object.entries(m)) {
      const dia = (ROWS as Record<string, { diameter_mm: number }>)[name].diameter_mm;
      const r = wallRadius(shape);
      expect(shape.refused, `${name} was refused: ${shape.refused}`).toBeNull();
      expect(r, `${name} (Ø${dia}) is drawn UNDERSIZE at ${r} — the dangerous direction`).toBeGreaterThan(dia / 2);
      expect(r, `${name} (Ø${dia}) is drawn more than 3.5% oversize at ${r}`).toBeLessThan((dia / 2) * 1.0353);
    }

    // The Ø6 envelope to six decimals. A literal, not a re-derivation of
    // `1 / cos(pi/12)` — a test that recomputes the implementation's formula
    // agrees with it however it is edited.
    expect(wallRadius(m.endmill6), 'the Ø6 envelope radius moved').toBeCloseTo(3.105829, 6);

    // ...and ONE factor applies to every class and every size, so nothing has
    // its own private scale. Pinned against the Ø6 row above rather than
    // against the constant.
    const ratio = wallRadius(m.endmill6) / 3;
    for (const [name, shape] of Object.entries(m)) {
      const dia = (ROWS as Record<string, { diameter_mm: number }>)[name].diameter_mm;
      expect(
        wallRadius(shape) / (dia / 2),
        `${name} is drawn at a different facet scale to the Ø6 end mill`
      ).toBeCloseTo(ratio, 12);
    }

    // (b) The diameter SCALES WITH THE ROW — twice the cutter, twice the
    // radius, and the words say which cutter was drawn.
    expect(wallRadius(m.endmill12) / wallRadius(m.endmill6), 'Ø12 is not drawn twice Ø6').toBeCloseTo(2, 12);
    expect(m.endmill6.drawn[0]).toBe('Ø6 mm to scale');
    expect(m.endmill12.drawn[0]).toBe('Ø12 mm to scale');
    expect(m.surfacing25.drawn[0]).toBe('Ø25 mm to scale');

    // ---------------------------------------------------------------------
    // (c) THE END OF THE TOOL, PER CLASS. This is the half a screenshot
    //     cannot check and the half that decides what the picture claims.
    // ---------------------------------------------------------------------

    // FLAT — the profile starts on the axis at y=0 and steps straight out to
    // the wall at the same height. No tip, no cone, no open end.
    for (const [name, shape] of [
      ['endmill6', m.endmill6],
      ['surfacing25', m.surfacing25],
    ] as const) {
      expect(shape.cutting[0], `${name} does not start on the axis at the tip`).toEqual([0, 0]);
      expect(shape.cutting[1][1], `${name} has a tip height on a flat end`).toBe(0);
      expect(shape.cutting[1][0]).toBeCloseTo(wallRadius(shape), 12);
      expect(shape.openTipRadiusMm, `${name} drew a "tip not stated" ring on a known flat end`).toBeNull();
      expect(shape.drawn).toContain('flat end');
    }

    // ANGULAR — the drawn cone carries the row's REAL half angle. Height and
    // radius are both scaled onto the oversize envelope, and scaling one and
    // not the other would draw a different tool at the same diameter; this is
    // the assertion that would catch it.
    for (const [name, shape, deg] of [
      ['vbit90', m.vbit90, 90],
      ['vbit60', m.vbit60, 60],
      ['engraving30', m.engraving30, 30],
      ['drill118', m.drill118, 118],
    ] as const) {
      expect(shape.cutting[0], `${name} does not start at the point`).toEqual([0, 0]);
      const [r, h] = shape.cutting[1];
      expect(h, `${name} has no cone height`).toBeGreaterThan(0);
      const halfDeg = (Math.atan2(r, h) * 180) / Math.PI;
      expect(halfDeg, `${name} is drawn at ${halfDeg}°, not ${deg / 2}°`).toBeCloseTo(deg / 2, 9);
      expect(shape.openTipRadiusMm, `${name} drew a refusal ring on a stated angle`).toBeNull();
    }
    // A sharper included angle is a LONGER point on the same diameter. Two
    // cones that pass the angle check independently but do not order like this
    // would mean the angle is not reaching the geometry at all.
    expect(m.vbit60.cutting[1][1], 'a 60° V-bit is not a longer point than a 90°').toBeGreaterThan(
      m.vbit90.cutting[1][1]
    );

    // 🔴 180° IS FLAT, AND THAT IS WHAT 180° MEANS. A brad point / dowel bit
    // states a point angle and has a flat bottom; treating it as "a cone with
    // an angle" would divide by tan(90°) and draw a zero-height point that
    // happens to look right, or an infinite one that does not.
    expect(m.brad180.cutting[0], 'the 180° drill does not start on the axis').toEqual([0, 0]);
    expect(m.brad180.cutting[1][1], 'a 180° point angle was drawn as a cone').toBe(0);
    expect(m.brad180.drawn).toContain('flat 180° end');
    expect(m.brad180.openTipRadiusMm).toBeNull();
    // ...and it is NOT the same drawing as the 118° drill of the same diameter.
    expect(m.drill118.cutting[1][1]).toBeGreaterThan(0);
    expect(m.drill118.drawn).toContain('118° point');

    // BALL NOSE — the tip is a quarter arc of the tool's own radius, so every
    // point on it sits on a circle of that radius centred one radius up the
    // axis. A "ball" drawn as a chamfer passes a start/end check and fails
    // this one.
    const br = wallRadius(m.ball6);
    // ⚠ `toBeCloseTo`, not `toEqual([0, 0])`. The arc is swept with `cos()`, so
    // its first point is 1.9e-16 rather than a literal zero — a real number and
    // not a defect. An exact-equality assertion here would be red about
    // floating point and say nothing about the tool.
    expect(m.ball6.cutting[0][0], 'the ball nose does not start on the axis').toBeCloseTo(0, 12);
    expect(m.ball6.cutting[0][1], 'the ball nose does not start at the tip').toBeCloseTo(0, 12);
    const arc = m.ball6.cutting.slice(0, 7);
    for (const [r, h] of arc) {
      expect(Math.hypot(r, h - br), `a ball-nose arc point is off the radius: ${r},${h}`).toBeCloseTo(br, 9);
    }
    expect(arc[6][0]).toBeCloseTo(br, 12);
    expect(arc[6][1]).toBeCloseTo(br, 12);
    expect(m.ball6.drawn.join(' ')).toContain('ball nose');
    expect(m.ball6.openTipRadiusMm).toBeNull();

    // (d) The SHANK is a second solid at its own diameter, and the words say
    // which way the step goes — the fact that decides whether a cutter can
    // reach into a pocket at all.
    expect(m.endmill6.shank, 'no shank drawn for a stated shank diameter').not.toBeNull();
    expect(m.endmill6.shank![1][0], 'a 6mm shank on a 6mm cutter is not the same radius').toBeCloseTo(
      wallRadius(m.endmill6),
      12
    );
    expect(m.endmill6.drawn.join(' · ')).toContain('6 mm shank, same as the cutter');
    // An 8mm shank under a Ø25 face mill steps UP to the cutter.
    expect(m.surfacing25.shank![1][0], 'the Ø25 surfacing shank is not drawn at 8mm').toBeLessThan(
      wallRadius(m.surfacing25)
    );
    expect(m.surfacing25.drawn.join(' · ')).toContain('8 mm shank, steps UP to the cutter');
  });

  test('the tool marker refuses rather than substituting a default, and the three refusals stay three sentences', async ({
    page,
  }) => {
    await markerInstrument(page);

    // ---------------------------------------------------------------------
    // 🔴 THE REFUSALS ARE THE PRODUCT. `undefined` (this viewport was told
    // nothing), `null` (there is no tool) and "a row that states no diameter"
    // are THREE DIFFERENT FACTS. The picture cannot carry the distinction — all
    // three draw the same dashed placeholder cage — so the WORDS have to, and a
    // test that collapses them has deleted the thing they exist to say.
    // ---------------------------------------------------------------------
    const notTold = await page.evaluate(
      () =>
        (
          (window as unknown as Record<string, unknown>).__toolMarkerShape as (
            x: unknown
          ) => MarkerShape
        )(undefined)
    );
    const noTool = await markerFor(page, null);
    const noDia = await markerFor(page, {
      id: 'nodia', category: 'End Mill', diameter_mm: null,
      shank_mm: 6, cutting_length_mm: 22, is_angular: false,
    });

    expect(notTold.refused, 'being told nothing is not reported as its own fact').toContain(
      'was not handed a tool'
    );
    expect(noTool.refused).toBe('no tool is selected for this program');
    expect(noDia.refused, 'a row with no diameter is not refused for its diameter').toContain(
      'states no diameter'
    );

    const sentences = [notTold.refused, noTool.refused, noDia.refused];
    expect(
      new Set(sentences).size,
      `three different facts collapsed into fewer sentences: ${sentences.join(' | ')}`
    ).toBe(3);

    // 🔴 AND NO DEFAULT SIZE ANYWHERE IN ANY OF THEM. This is the assertion
    // that goes red if a missing diameter is ever quietly filled in: a cutter
    // drawn at a size nobody stated is a measurement nobody took, in the scene
    // a clearance is judged by eye against.
    for (const [name, shape] of [
      ['not told', notTold],
      ['no tool', noTool],
      ['no diameter', noDia],
    ] as const) {
      expect(shape.cutting, `${name} drew a cutter profile anyway`).toHaveLength(0);
      expect(shape.shank, `${name} drew a shank anyway`).toBeNull();
      expect(shape.openTipRadiusMm, `${name} drew a tip ring anyway`).toBeNull();
      expect(shape.drawn, `${name} asserted something it cannot know`).toHaveLength(0);
      expect(shape.summary).toBe('no cutter drawn — a dashed cage at a placeholder size');
      expect(
        JSON.stringify(shape),
        `${name} carries a diameter it was never given`
      ).not.toMatch(/Ø/);
    }

    // ---------------------------------------------------------------------
    // A MISSING TIP IS A NARROWER REFUSAL: the diameter is known, so the
    // cutter IS drawn — to scale — and only its END is withheld. The solid
    // ends OPEN and `openTipRadiusMm` is set, which is what puts the dashed
    // ring round the opening in the scene.
    // ---------------------------------------------------------------------
    const noAngle = await markerFor(page, {
      id: 'v?', category: 'V-Bit', diameter_mm: 6, included_angle_deg: null,
      shank_mm: 6, cutting_length_mm: 12, is_angular: true,
    });
    const noPoint = await markerFor(page, {
      id: 'd?', category: 'Drill', diameter_mm: 5, point_angle_deg: null,
      shank_mm: 5, cutting_length_mm: 40, is_angular: false,
    });
    const noCategory = await markerFor(page, {
      id: 'c?', category: null, diameter_mm: 6,
      shank_mm: 6, cutting_length_mm: 22, is_angular: false,
    });
    const unknownCategory = await markerFor(page, {
      id: 'w?', category: 'Wobble Bit', diameter_mm: 6,
      shank_mm: 6, cutting_length_mm: 22, is_angular: false,
    });
    // The row contradicts ITSELF: the core says angular, the category resolves
    // to a flat end. Nobody can be sure which is right, so no tip is drawn.
    const contradicted = await markerFor(page, {
      id: 'x?', category: 'End Mill', diameter_mm: 6,
      shank_mm: 6, cutting_length_mm: 22, is_angular: true,
    });

    for (const [name, shape, dia] of [
      ['no included angle', noAngle, 6],
      ['no point angle', noPoint, 5],
      ['no category', noCategory, 6],
      ['unknown category', unknownCategory, 6],
      ['contradicted', contradicted, 6],
    ] as const) {
      expect(shape.refused, `${name} refused the whole cutter, not just the tip`).toBeNull();
      // The cutter is still to scale — the refusal took the END away, not the
      // diameter.
      expect(shape.openTipRadiusMm, `${name} did not open the end`).not.toBeNull();
      expect(shape.openTipRadiusMm!, `${name} opened the end at the wrong radius`).toBeGreaterThan(dia / 2);
      expect(shape.openTipRadiusMm!).toBeLessThan((dia / 2) * 1.0353);
      // No tip means no point on the axis at y = 0: the solid begins at the
      // wall, which is what "ends open" IS.
      expect(shape.cutting[0][0], `${name} still capped the end`).toBeCloseTo(shape.openTipRadiusMm!, 12);
      expect(shape.cutting[0][1]).toBe(0);
      expect(shape.drawn[0]).toBe(`Ø${dia} mm to scale`);
    }

    // ...and each names the fact that is missing, in its own words. A single
    // "cannot draw the tip" for all five would be a picture with a hole in it
    // and no way to tell which number to go and find.
    const why = (s: MarkerShape) => s.notDrawn.join(' | ');
    expect(why(noAngle)).toContain('included angle is not stated');
    expect(why(noPoint)).toContain('point angle is not stated');
    expect(why(noCategory)).toContain('category is not stated');
    expect(why(unknownCategory), 'an unrecognised category is not refused BY NAME').toContain(
      'a tip shape for category "Wobble Bit" is not stated'
    );
    expect(why(contradicted)).toContain('the row contradicts itself');
    expect(
      new Set([why(noAngle), why(noPoint), why(noCategory), why(unknownCategory), why(contradicted)])
        .size,
      'five different missing facts share a sentence'
    ).toBe(5);
    // 🔴 The one that would be silent: an unknown category must NOT fall back
    // to the commonest shape. That is how a drawing acquires a claim nobody
    // made — and a flat end on a tool nobody can identify looks entirely fine.
    expect(unknownCategory.drawn.join(' '), 'an unknown category was drawn as an end mill').not.toContain(
      'flat end'
    );

    // ---------------------------------------------------------------------
    // A LENGTH nobody stated is drawn BROKEN, never to a made-up length. The
    // zig-zag is the drafting mark for "shortened, not shown to length", so the
    // profile carries points OUTSIDE the wall — which is why the envelope
    // checks above are only ever run on rows that state every length.
    // ---------------------------------------------------------------------
    const noLengths = await markerFor(page, {
      id: 'l?', category: 'End Mill', diameter_mm: 6,
      shank_mm: null, cutting_length_mm: null, is_angular: false,
    });
    expect(noLengths.refused).toBeNull();
    expect(noLengths.shank, 'a shank was drawn for a diameter nobody stated').toBeNull();
    expect(why(noLengths)).toContain('shank diameter is not stated');
    expect(why(noLengths)).toContain('cutting length is not stated');
    const wall = noLengths.cutting.filter(([r]) => Math.abs(r - 3.105829) < 1e-6);
    expect(wall.length, 'the flute wall is not drawn at the envelope radius').toBeGreaterThanOrEqual(2);
    const widest = Math.max(...noLengths.cutting.map(([r]) => r));
    expect(
      widest,
      'an unstated cutting length was drawn to a length, with no break'
    ).toBeGreaterThan(3.105829);
    // The tear is an ANNOTATION and not a claim about width — it is drawn at a
    // fixed 1.2x the WALL, so it can never be read as a bigger cutter. Taken
    // against the wall this shape actually drew, not against the rounded
    // literal above: 1.2x a 6-decimal round-off is only good to 5.
    expect(widest).toBeCloseTo(wall[0][0] * 1.2, 12);
  });

  test('the viewport publishes where the tool marker is, and drops it when no cutter is drawn', async ({
    page,
  }) => {
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');

    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;

    // 🔴 WHY THIS ATTRIBUTE HAD TO EXIST. The marker is a small solid at the
    // head of the program, under a camera this test does not model. The
    // previous pass could only find it by sampling the canvas for its teal —
    // which finds a COLOUR, not an object, and goes quietly wrong the moment
    // anything else in the scene is that colour. Same reasoning, and the same
    // pattern, as `data-rotate-handle` and `data-path-probe`.
    const at = await canvas.getAttribute('data-tool-probe');
    expect(at, 'the viewport published no tool-marker position').toBeTruthy();
    const [tx, ty] = at!.split(',').map(Number);
    expect(Number.isFinite(tx) && Number.isFinite(ty), `unreadable tool probe: ${at}`).toBeTruthy();
    expect(tx, `tool probe off canvas: ${at} in ${box.width}x${box.height}`).toBeGreaterThan(0);
    expect(tx).toBeLessThan(box.width);
    expect(ty).toBeGreaterThan(0);
    expect(ty).toBeLessThan(box.height);

    // The point has to land ON the marker, not merely somewhere plausible: a
    // published coordinate nobody hits is a dead handle that reads as a live
    // one. Hovering it must report the TOOL — and the marker's own summary,
    // which is what the reading above actually produced.
    const panel = page.getByTestId('hover-panel');
    await page.mouse.move(box.x + tx, box.y + ty);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Tool');
    // The default library tool is the Ø6 down-cut end mill, and the marker says
    // so in the words `toolMarkerShape` built.
    await expect(panel).toContainText('Ø6 mm to scale');
    // ...and the panel states the envelope is OVERSIZE, so nobody measures a
    // clearance off a picture that is not the tool's true width.
    await expect(panel).toContainText('OVERSIZE');

    // 🔴 ABSENT WHEN NOTHING IS DRAWN — the half that makes the attribute worth
    // having, and it is asserted on a LIVE TRANSITION rather than on a fresh
    // load. A new navigation proves almost nothing: the component remounts, so
    // there is no previous scene for a coordinate to survive from. The state
    // that matters is a viewport that HAD a marker and stops having one —
    // shrink the machine until the sheet no longer fits, the program is
    // refused, no move is drawn, and the published position must go with the
    // marker it described.
    await page.getByTestId('travel-x').fill('300');
    await page.getByTestId('travel-y').fill('180');
    await expect(page.getByTestId('status')).toHaveText('refused');
    await expect(
      canvas,
      'a tool-marker position outlived the marker — a caller would aim at a cutter that is not on screen'
    ).not.toHaveAttribute('data-tool-probe', /.*/);

    // ...and the same on a page that never had a program at all.
    await page.goto('/');
    await panelsReady(page);
    await expect(page.getByTestId('no-drawing')).toBeVisible();
    expect(
      await page.getByTestId('viewport-canvas').getAttribute('data-tool-probe'),
      'a tool-marker position was published for a program that does not exist'
    ).toBeNull();
  });

  // =========================================================================
  //  THE MERGED LISTS — TODO #54 / #55 / #58 / #59 / #60
  //
  //  Five founder items that are all one change: how selection and CRUD work
  //  across every panel. Done separately they would fight each other, so they
  //  are tested together for the properties that only hold when all five are
  //  true at once.
  // =========================================================================

  test('one list holds every drawing, and a shipped sample does not lend its confidence to the user\'s own', async ({
    page,
  }) => {
    // 🔴 TODO #54, founder: *"in the drawings merge the 2 lists, have just 1
    // list including the sample and user owned drawings"*. There were THREE
    // surfaces, not two — shipped DXF/SVG, shipped STL, and the user's own — and
    // the merge is only safe if the list keeps saying which is which.
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('drawing-picker-trigger').click();

    const dxf = page.getByTestId('drawing-picker-opt-sample:Hive super end');
    const stl = page.getByTestId('drawing-picker-opt-mesh-sample:Hive super end — solid (STL)');

    // 🔴 THE SAME PART, TWICE, AND NOT THE SAME OBJECT. One is the cut file cad
    // emits; the other is the solid, of which the machine cuts ONE SECTION.
    // Both produce a program that posts and cuts, so picking the wrong one is a
    // wrong part rather than an error — which is why they are in one list only
    // on condition that each row says what it is, and why the ids carry their
    // surface rather than trusting the names to stay distinct.
    await expect(dxf).toHaveCount(1);
    await expect(stl).toHaveCount(1);
    await expect(dxf).toContainText('2D drawing');
    await expect(stl).toContainText('3D solid');

    // The section Z is named, and named as a GUESS, on the row — before
    // anything is loaded and before any Z control exists to read.
    await expect(stl).toContainText('CHOSEN FOR YOU');
    await expect(stl).toContainText('-9.5');

    // Origin, per row. Both of these are shipped and both were measured.
    await expect(dxf).toContainText('SHIPPED');
    await expect(stl).toContainText('SHIPPED');
    // ...and a shipped row offers no delete. It lives in the bundle: the
    // control would either do nothing or remove something that is back after a
    // reload, and both are worse than no control.
    await expect(page.getByTestId('drawing-picker-rm-sample:Hive super end')).toHaveCount(0);

    // Now the OTHER half of the merge: a drawing the user saved, which carries
    // no provenance because nobody measured it.
    await page.getByTestId('drawing-picker-cancel').click();
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('imported-name')).toContainText('plate.dxf');

    await page.getByTestId('drawing-picker-trigger').click();
    await page.getByTestId('drawing-picker-saveas-name').fill('my plate');
    await page.getByTestId('drawing-picker-saveas').click();
    await expect(page.getByTestId('drawing-note')).toContainText('saved');

    const mine = page.getByTestId('drawing-picker-opt-saved:my plate');
    await expect(mine).toHaveCount(1);
    // 🔴 THE ASSERTION THE WHOLE MERGE TURNS ON. In one list a shipped sample's
    // "measured through the CLI importer" is two rows away from a file somebody
    // dragged in this morning. The tag is what stops the first reading as a
    // statement about the second.
    await expect(mine).toContainText('YOURS');
    await expect(mine).not.toContainText('SHIPPED');
    // ...and it CAN be deleted, because it is in IndexedDB and deleting it is a
    // real, honest act.
    await expect(page.getByTestId('drawing-picker-rm-saved:my plate')).toHaveCount(1);

    // The properties say what is NOT known, not merely who saved it. "Saved by
    // you" alone reads as a provenance; the absence of one is the fact.
    await mine.hover();
    const props = page.getByTestId('drawing-picker-props');
    await expect(props).toContainText('YOU saved this in THIS browser');
    await expect(props).toContainText('Nothing was measured');
    // NEGATIVE CONTROL: the shipped row must NOT say that. A tag applied to
    // every row would satisfy every assertion above and mean nothing.
    await dxf.hover();
    await expect(props).toContainText('Shipped with this build');
    await expect(props).not.toContainText('YOU saved this in THIS browser');
  });

  test('a tool file is imported and exported from the list, not from the panel', async ({
    page,
  }) => {
    // 🔴 TODO #55, founder: *"tooling, remove the Export tools, Choose File
    // (new) from the left navbar, put this functionality into the list"*.
    //
    // The property is not "the buttons moved" but "the capability survived the
    // move" — a sweep that deleted the controls would satisfy any check that
    // only looked at the panel.
    await page.goto('/');
    await panelsReady(page);

    // Gone from the panel...
    await expect(
      page.getByTestId('export-tools'),
      'the tool export is still on the panel'
    ).toHaveCount(0);

    // ...and present in the list.
    await page.getByTestId('tool-picker-trigger').click();
    await expect(
      page.getByTestId('export-tools'),
      'the tool export did not survive the move into the list'
    ).toHaveCount(1);
    await expect(page.getByTestId('tool-picker-add')).toContainText('import a tool file');
    await page.getByTestId('tool-picker-cancel').click();

    // And the import still WORKS, which is the half a locator check cannot see.
    // The file input is mounted off screen and driven by the list's own button:
    // an input that existed only inside an open dialog could not be reached at
    // all once the dialog was shut.
    const dir = tempDir('2bee-tools-');
    const file = join(dir, 'extra-tools.json');
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'Shop Special 5mm 1F',
          category: 'End Mill',
          diameter_mm: 5,
          flutes: 1,
          shank_mm: 6,
          cutting_length_mm: 20,
          chipload_mm: 0.1,
          chipload_min_mm: 0.05,
          chipload_max_mm: 0.15,
          rpm_min: 10000,
          rpm_max: 24000,
          included_angle_deg: null,
          point_angle_deg: null,
        },
      ])
    );
    await page.getByTestId('import-tools').setInputFiles(file);
    await expect(page.getByTestId('extra-tools-note')).toContainText('1 tool(s) loaded from file');
  });

  test('the drawn shape is a description on the property panel and decoration in the row', async ({
    page,
  }) => {
    // 🔴 TODO #60, founder: *"the all images in the list (like for the Hold-down
    // should be presented on the property (right) panel)"*.
    //
    // Two properties, and the second is the one that would rot silently: the
    // shape must be BIGGER on the panel, and it must stop being `aria-hidden`
    // when it gets there. In the row it is decoration beside a name; on the
    // panel it is often the only place a shank step or an under-arm clearance
    // is legible at all, and hiding a primary description from a screen reader
    // is the wrong way round.
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('tool-picker-trigger').click();
    await page.getByTestId('tool-picker-opt-End Mill - Down-cut 6mm 2F').hover();

    const shape = page.getByTestId('tool-picker-shape');
    await expect(shape).toHaveCount(1);
    // It is the SAME component at the pane frame, not a second drawing.
    await expect(shape.locator('svg[data-tool-shape="pane"]')).toHaveCount(1);
    // 🔴 THE ROW DRAWING IS GONE — founder, 2026-08-10, landed in `7140829eb6`
    // by DELETING `ObjectItem.icon`, not by declining to render it: an
    // accepted-and-ignored prop is a control that looks live. This assertion
    // used to be `…locator('svg[data-tool-shape="row"]').first()` with
    // `toHaveCount(1)`, and `.first()` over an empty set is what turned a
    // regression into a WAIT: the locator has nothing to resolve to, so the
    // failure arrives as an expiring timeout rather than as "expected 1,
    // received 0". A hang reads as a broken runner and gets re-run; a count
    // reads as a defect and gets fixed.
    await expect(
      page.getByTestId('tool-picker-list').locator('svg[data-tool-shape="row"]'),
      'a row-sized tool drawing is back in the list — the icon field was deleted, so this is a new one'
    ).toHaveCount(0);

    // 🔴 NOT hidden from assistive tech — asserted through `closest`, because a
    // shape whose own svg carries `role="img"` is still invisible to a screen
    // reader if ANY ancestor is `aria-hidden`. That is exactly how it is
    // rendered in the row, so checking the svg alone would pass on the wrong
    // arrangement.
    const hidden = await shape.locator('svg').evaluate(
      (el) => el.closest('[aria-hidden="true"]') !== null
    );
    expect(hidden, 'the property-panel shape is hidden from assistive tech').toBe(false);

    // 🔴 ...and the ROW carries no drawing at all. This block used to assert the
    // row icon was `aria-hidden` — a true statement about a thing that no longer
    // exists — via `.locator('svg').evaluate(…)`. `evaluate` on a locator that
    // matches nothing WAITS for an element to appear, with no action timeout
    // set, so a regression here consumed the whole 60s test timeout and reported
    // "waiting for locator to resolve". Two tests in this file failed that way
    // and neither said what was wrong.
    //
    // The property is now stated the way it should have been from the start: the
    // row's contract is that it has NO svg, so the assertion is a count, it
    // retries against the same DOM, and it fails in milliseconds with the number
    // it found. `toHaveCount(0)` is also the one assertion shape that is honest
    // about an empty set — every `.first()`-style locator over nothing is a wait
    // dressed as a check.
    await expect(
      page.getByTestId('tool-picker-opt-End Mill - Down-cut 6mm 2F').locator('svg'),
      'the row carries a drawing again — it belongs on the properties panel, at a size where it says something'
    ).toHaveCount(0);

    // And it has a real label, taken from the fields the drawing is drawn from.
    await expect(page.getByTestId('tool-picker-shape-label')).toContainText('Ø6 mm');
    await page.getByTestId('tool-picker-cancel').click();

    // A catalogue with a shape gets one...
    await page.getByTestId('workholding-picker-trigger').click();
    await page.getByTestId('workholding-picker-list').locator('.op-opt').first().hover();
    await expect(page.getByTestId('workholding-picker-shape')).toHaveCount(1);
    await page.getByTestId('workholding-picker-cancel').click();

    // 🔴 ...and one WITHOUT an honest shape gets NOTHING. A sheet of plywood
    // has no picture that says anything a size does not, and a placeholder
    // would be a drawing of nothing rendered as a fact. This is the assertion
    // that stops the feature spreading to every list because it looks nice.
    await page.getByTestId('workpiece-picker-trigger').click();
    await page.getByTestId('workpiece-picker-list').locator('.op-opt').first().hover();
    await expect(
      page.getByTestId('workpiece-picker-shape'),
      'a shape was invented for a catalogue that has none'
    ).toHaveCount(0);
    await expect(page.getByTestId('workpiece-picker-props')).toContainText('Size');
  });

  test('the extruded-walls layer is dark without a drawing and lit with one', async ({ page }) => {
    // 🔴 TODO #59 — the stale HOLD. `drawing={drawingParts}` was refused for
    // nine days on a measurement that named `container pointer-events: auto`;
    // `3dab19fdd` had already changed that container to `'none'`. The layer this
    // test covers is the thing the HOLD cost, because it cannot render without
    // that prop, and NOTHING was watching that it was dark.
    //
    // Two states, because only the pair is a test: a control that is never
    // offered and one that is always offered both pass a one-sided check.
    /*
     * 🔴 MIGRATED 2026-08-11, AND THIS IS A DESIGN CHANGE, NOT A RENAME.
     *
     * The old form asserted PRESENT-AND-DISABLED without a drawing. That state
     * no longer exists in this app, in either half:
     *   · `liveLayersOf` filters `walls` out entirely unless the drawing has
     *     contours (`wallsLive = !!s.drawing && s.drawing.length > 0`,
     *     `web/src/Viewport.tsx`), and
     *   · the sidebar rows are never rendered `disabled` at all
     *     (`sectionLayerRows`, `web/src/App.tsx`).
     * The commit that moved the controls says why the absence is deliberate: a
     * disabled control reads as *"this is hidden"*, and *"there is none"* versus
     * *"there is one you cannot see"* is the whole distinction the rule exists
     * for. The reason lives in words instead, on the canvas, as
     * `walls-unavailable`.
     *
     * 🔴 SO THE PAIR IS PRESERVED, AND IT IS STILL A PAIR — that is the part
     * that must not be lost. `toHaveCount(0)` then `toHaveCount(1)` is exactly
     * as two-sided as `disabled` then `enabled` was: a wiring that never
     * delivered `drawing={drawingParts}` fails the second half, and a wiring
     * that offered the layer unconditionally fails the first. What is asserted
     * ALONGSIDE the absence is the reason line, so an absent control is never
     * mistaken for a feature nobody thought of.
     *
     * ⚠ The absent half is guarded by `expectSectionOpen(panel-import)` — with
     * `panel-import` shut, `toHaveCount(0)` passes having proved nothing at all,
     * and it passes as a COUNT, so it returns immediately and never looks stuck.
     *
     * ⚠ NEVER RUN.
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    // A built-in fixture genuinely has no drawing behind it, so the layer is
    // NOT OFFERED — and the canvas says which solid is missing and why.
    await expectSectionOpen(page, 'panel-import');
    const walls = page.getByTestId('kind-walls');
    await expect(
      walls,
      'a walls control is offered for a fixture with no drawing behind it'
    ).toHaveCount(0);
    await expect(page.getByTestId('walls-unavailable')).toBeVisible();

    // A real drawing through the real importer lights it.
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toHaveText('runnable');
    await expect(
      walls,
      'the walls layer is still not offered with a drawing loaded — drawing={drawingParts} is not reaching the viewport'
    ).toHaveCount(1);
    await expect(walls).toBeEnabled();
    await expect(walls).toHaveAttribute('aria-pressed', 'true');
    // ...and the reason line goes with it. A control AND a "cannot draw this"
    // sentence at the same time would be the app contradicting itself.
    await expect(page.getByTestId('walls-unavailable')).toHaveCount(0);
  });
  /* =========================================================================
   * SEVERAL DRAWINGS ON ONE SHEET — founder 2026-08-10
   * ========================================================================= */

  test('two drawings go on the table, and only the one that was moved moves in the program', async ({
    page,
  }) => {
    /*
     * 🔴 THE ASSERTION IS ON THE EMITTED PROGRAM, and it is on BOTH halves.
     * "The program changed" would pass for a per-drawing offset that was
     * actually the job-level one wearing a per-part label — every coordinate
     * would move, the panel would look right, and the sheet would be nested
     * from a picture nobody cut. So one part must be byte-for-byte where it was
     * while the other moves by exactly the amount typed.
     *
     * The same file is added twice, so any difference between the two parts in
     * one program is the PLACEMENT and nothing else.
     */
    await page.goto('/');
    await panelsReady(page);
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });

    // Save it, then add the saved copy beside the shipped sample so the sheet
    // genuinely holds two rows. (A file opened from disk is not in the list.)
    await expect(page.getByTestId('drawing-rows')).toContainText('plate.dxf');
    // 🔴 The picker ADDS rather than replaces, and the file already on the table
    // is not one of its rows — so this is the two-drawing state the test needs.
    // A picker that replaced would leave one row here and the assertions below
    // would then be measuring a one-part program against itself.
    await pickDrawings(page, 'sample:Hive super end');
    await expect(page.getByTestId('drawing-rows').locator('.objrow')).toHaveCount(2);

    // A sheet big enough to hold both, and a machine that can reach it.
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page.getByTestId('stock-x').fill('1200');
    await page.getByTestId('stock-y').fill('900');

    /* 🔴 AND THEY MUST BE MOVED APART BEFORE THERE IS A PROGRAM AT ALL. Added
     * 2026-08-11 on this test's first ever run: a drawing arrives at offset
     * `[0,0]` — as drawn — so two of them land ON TOP OF EACH OTHER, and the
     * core refuses the whole sheet by design. Measured: *"part `plate.dxf/part1`
     * and part `Hive super end/part1` OVERLAP … 193.000mm in X and 120.000mm in
     * Y … MOVE ONE OF THEM"*, status `refused`, `NOTHING WAS POSTED`.
     *
     * That refusal is the product being right, and it is written down twice in
     * `App.tsx` (the ⧉ button: *"THE COPY LANDS ON TOP OF THE ORIGINAL, AND THE
     * JOB IS THEN REFUSED. That is a decision, not an oversight"* — nothing here
     * moves a part for the operator, because the clamps do not move with it). The
     * old form read the G-code straight after adding the second drawing and got
     * an empty program, which surfaced as *"the program does not name two
     * drawings' parts: none"* — a refusal read as a missing feature.
     *
     * 400mm, not 40: the parts overlap by 120mm in Y, so the +40 the test moves
     * later would not have cleared it either. The separation is done FIRST and
     * the +40 below is then a movement between two runnable programs, which is
     * what this test is actually about.
     *
     * ⚠ AND X MOVES TOO, FOR A SECOND REFUSAL THAT IS ALSO CORRECT. As drawn the
     * sample's outline starts at X 0, so its OUTSIDE profile is one cutter radius
     * further out and the job is refused with *"move outside X travel:
     * -3.0000000000000497 (allowed 0 .. 2000)"* — the machine cannot reach a
     * negative coordinate, and raising `travel-x` does not help because the floor
     * is 0. Both numbers were measured here rather than reasoned about; the
     * separation exists to make a program, not to be minimal. */
    await page.getByTestId('drawing-x-1').fill('50');
    await page.getByTestId('drawing-y-1').fill('400');
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });

    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();

    // Per-part coordinates come off the operation comments the post writes —
    // the only place the emitted program names a part at all. The reader is
    // `./gcode.ts`, and `gcode-reader.spec.ts` is what holds it honest.
    const byPart = coordsByPart;

    const before = byPart((await page.getByTestId('gcode').textContent()) ?? '');
    const names = [...before.keys()];
    expect(
      names.length,
      `the program does not name two drawings' parts: ${names.join(', ') || 'none'}`
    ).toBeGreaterThan(1);
    /* 🔴 WHICH NAME BELONGS TO WHICH ROW IS ASKED, NOT ASSUMED. `[a, b] = names`
     * took the program's own emission order and hoped it matched the row order;
     * if the post ever grouped by tool before instance, this test would assert
     * that the part it did NOT move had moved and read as a per-drawing offset
     * defect. The part id is `<instance>/<part>`, and row 1's instance is the
     * sample added above, so the mapping is derivable. */
    const a = names.find((n) => n.startsWith('plate.dxf'))!;
    /* ⚠ BOTH ROWS ARE NAMED, and the sample's is named in FULL. This used to be
     * `names.find((n) => n !== a)` with a comment explaining that
     * `startsWith('Hive super end')` "was tried and is red" — true at the time,
     * and the reason was the READER, not the app: `coordsByPart` stopped the
     * part name at the first space and answered `Hive`. The reader was fixed on
     * 2026-08-11 (`./gcode.ts`), so the assertion the workaround was written
     * around is now the assertion, and the sample is identified by the name the
     * program actually carries rather than by not being the other one. */
    const b = names.find((n) => n.startsWith('Hive super end'))!;
    expect(a, `the program never names the imported file's part: ${names.join(', ')}`).toBeTruthy();
    expect(b, `the program never names the sample's part: ${names.join(', ')}`).toBeTruthy();

    // Move the SECOND row only.
    await page.getByTestId('drawing-y-1').fill('440');
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });
    const after = byPart((await page.getByTestId('gcode').textContent()) ?? '');

    expect(after.get(a)!.length, 'the first part changed shape').toBe(before.get(a)!.length);
    const firstMoved = before
      .get(a)!
      .some(([x, y], i) => after.get(a)![i][0] !== x || after.get(a)![i][1] !== y);
    expect(firstMoved, 'moving ONE drawing moved the other — the offset is not per drawing').toBe(
      false
    );
    const secondMovedRight = before
      .get(b)!
      .every(
        ([x, y], i) =>
          Math.abs(after.get(b)![i][0] - x) < 1e-6 && Math.abs(after.get(b)![i][1] - y - 40) < 1e-6
      );
    expect(
      secondMovedRight,
      'the drawing that WAS moved did not move by 40mm in the emitted program'
    ).toBe(true);
  });

  test('turning a drawing turns the geometry the program is cut from, not just the picture', async ({
    page,
  }) => {
    /*
     * 🔴 A part DRAWN turned whose toolpath is planned unturned cuts the wrong
     * shape, and the picture is the half that looks right — gate P7R's lesson
     * one object along. So this reads the EMITTED PROGRAM's X and Y spans: a
     * quarter turn about the drawing's own corner SWAPS them, and the move count
     * does not change. A rotation applied to the render alone leaves both spans
     * exactly as they were, and the viewport would look perfect.
     */
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });

    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    // Same scanner as the drag test above and as `coordsByPart` — `./gcode.ts`,
    // measured by `gcode-reader.spec.ts`. This test used to carry its own copy.
    const flat = spanOf((await page.getByTestId('gcode').textContent()) ?? '');
    expect(flat.n, 'no program to turn').toBeGreaterThan(10);
    // A square part could pass the swap below by being unchanged. This one is
    // not square, and the test says so rather than assuming it.
    expect(Math.abs(flat.w - flat.h), 'the fixture is square, so a swap proves nothing').toBeGreaterThan(1);

    await page.getByTestId('drawing-rot-0').fill('90');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
    const turned = spanOf((await page.getByTestId('gcode').textContent()) ?? '');

    expect(turned.n, 'the turn changed how much is cut, not just its orientation').toBe(flat.n);
    expect(Math.abs(turned.w - flat.h), 'the emitted X span did not become the Y span').toBeLessThan(1e-6);
    expect(Math.abs(turned.h - flat.w), 'the emitted Y span did not become the X span').toBeLessThan(1e-6);

    // A free angle PLANS and WARNS. Refusing it would discard a placement the
    // core accepts; accepting it silently would cost the operator the one fact
    // they need to register the work.
    await page.getByTestId('drawing-rot-0').fill('37');
    await expect(page.getByTestId('drawing-rot-note-0')).toContainText('not a quarter turn');
  });

  test('two drawings on the same material are REFUSED, and the same two apart still emit', async ({
    page,
  }) => {
    /*
     * 🔴 THE PAIRED POSITIVE IS HALF THE TEST. A refusal assertion on its own is
     * indistinguishable from a check that refuses everything — which would pass
     * forever while making the feature unusable. Both halves, same sheet, same
     * two drawings.
     */
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page.getByTestId('stock-x').fill('1200');
    await page.getByTestId('stock-y').fill('900');
    // `overlap.dxf` holds TWO rectangles sharing 50 x 80mm of material — one
    // file, because the check is per PAIR OF PARTS and does not care which file
    // a part came from. The cutter does not either.
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/overlap.dxf'));

    await expect(page.getByTestId('status')).toHaveText('refused', { timeout: 30_000 });
    const blocked = page.getByTestId('blocked');
    await expect(blocked).toContainText('OVERLAP');
    await expect(blocked).toContainText('re-nest, do not nudge');
    // 🔴 AND NO PROGRAM. A warning printed above a runnable file is a file that
    // gets run, which is gate G13's property arriving in the UI.
    await openGcode(page);
    await expect(page.getByTestId('download')).toBeDisabled();

    // The positive: one plate on its own emits.
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });
  });
  test('a second copy of ONE drawing is two parts, refused on top of each other and cut when moved', async ({
    page,
  }) => {
    /*
     * 🔴 Founder, 2026-08-10: *"Drawing: Able to add more than 1 from the same
     * drawing"*. The failure this guards is the quiet one: a model that keys a
     * part on its DRAWING loses the second copy, or moves both together, and
     * still posts a runnable program either way.
     *
     * The copy lands ON TOP and the job is refused — a deliberate choice over
     * auto-offsetting it, because offsetting is the software moving a part on
     * its own and the clamps do not move with the parts. So the refusal is
     * asserted first, and the paired positive after it.
     */
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('2000');
    await page.getByTestId('travel-y').fill('2000');
    await page.getByTestId('stock-x').fill('1200');
    await page.getByTestId('stock-y').fill('900');
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('drawing-rows').locator('.objrow')).toHaveCount(1);

    await page.getByTestId('drawing-copy-0').click();
    await expect(page.getByTestId('drawing-rows').locator('.objrow')).toHaveCount(2);
    // Two INSTANCES of one file: the copy is named, and it is not the original's
    // name. A row keyed on the drawing would have collapsed them into one.
    await expect(page.getByTestId('drawing-rows')).toContainText('#2');

    // On top of each other ⇒ refused, both named, and NO program.
    await expect(page.getByTestId('status')).toHaveText('refused', { timeout: 30_000 });
    const blocked = page.getByTestId('blocked');
    await expect(blocked).toContainText('OVERLAP');
    await expect(blocked).toContainText('MOVE ONE OF THEM');
    await openGcode(page);
    await expect(page.getByTestId('download')).toBeDisabled();

    // Move the copy, and the same two parts cut.
    await page.getByTestId('drawing-x-1').fill('400');
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });
    await expect(page.getByTestId('download')).toBeEnabled();
  });
  test('the cutter at the head has its own layer chip, and hiding it changes the canvas', async ({
    page,
  }) => {
    /*
     * Founder, 2026-08-10: *"on the top section able to show/hide the Tooling as
     * well (cut, tab, rapid … etc)"*. The tool marker was the one drawn object in
     * this scene with no toggle.
     *
     * 🔴 ASSERTED ON THE RENDERED CANVAS, NOT ON `aria-pressed`. A chip that
     * renders, styles as enabled and reports its state while being DEAD is this
     * app's most-repeated UI defect — it has happened twice, to the rotate handle
     * and to the snap controls, both times because the overlay column carries
     * `pointerEvents: 'none'` and the control missed the shared `chip` style that
     * takes them back. `aria-pressed` flips in both worlds; the drawing buffer
     * does not.
     *
     * 🔴 And it reads the GL BUFFER rather than screenshotting the element: a
     * screenshot also captures the DOM sitting on top of the canvas, and this
     * feature ADDS to that DOM — the "N of N hidden" banner appears the moment
     * anything is hidden, so an element screenshot would differ whether or not
     * the 3D scene moved at all.
     *
     * =========================================================================
     * 🔴 IT FINDS THE CUTTER BY ITS PUBLISHED POSITION, NOT BY ITS COLOUR — AND
     *    THE COLOUR NEEDLE WAS UNFIXABLE, NOT MERELY MIS-TUNED (2026-08-12).
     * =========================================================================
     *
     * This counted whole-canvas pixels within ±26 of `TOOL_CUT_COLOR`
     * (`0x0b7285`). First time it ever ran, it failed at the FIRST assertion
     * with ZERO hits. The marker is a lit `MeshStandardMaterial`, so it never
     * renders its base colour: measured at the published probe point it is
     * **rgb(8, 92, 107)** while the needle demanded b ∈ [108, 158]. **It missed
     * on blue by one**, and the ±26 was a guess written in a test that had never
     * been run.
     *
     * ⚠ WIDENING THE TOLERANCE WOULD NOT HAVE FIXED IT, AND THAT IS THE REASON
     * FOR THE REWRITE RATHER THAN A ONE-CHARACTER EDIT. Measured over the whole
     * canvas at ±45: **30 hits with the cutter shown and FOUR WITH IT HIDDEN**,
     * sitting at (197,297) and (172,262) — toolpath pixels of a near-enough
     * teal, tens of pixels away from the marker. The middle assertion here
     * demands ZERO while hidden, so no whole-canvas colour count can satisfy it
     * at any tolerance: loosen it and the hidden leg fails, tighten it and the
     * shown leg fails. ⚠ And only ~30 pixels ever carried it at this framing, so
     * `> 0` had thirty pixels of margin AND MOVED WITH THE CAMERA.
     *
     * 🔴 `data-tool-probe` EXISTS PRECISELY SO A CALLER NEED NOT FIND AN OBJECT
     * BY COLOUR — `Viewport.tsx` says so where it publishes it: *"without it the
     * only way to find the marker was to sample the canvas for its teal, which
     * finds a COLOUR rather than an object and goes quietly wrong the moment
     * anything else in the scene is that colour"*. That is this defect, named in
     * the product before the test hit it. So the buffer is still read — the
     * `aria-pressed` hazard above is untouched — but the QUESTION is now *"did
     * the picture change where the cutter is"*, which is a fact about the
     * object.
     *
     * ⚠ THE PROBE SURVIVES THE HIDE, which is what makes it usable as an anchor
     * for all three states: `toolWorld` is set when the scene is BUILT, and
     * hiding the layer only flips `visible` on the meshes. Measured — the
     * attribute reads `134.3,267.1` before, during and after. It would be absent
     * only if no cutter were drawn at all, and that state has its own test (*the
     * viewport publishes where the tool marker is, and drops it when no cutter is
     * drawn*).
     *
     * 🔴 AND THE LOCALITY ASSERTION IS THE PART THAT CARRIES THE WEIGHT.
     * Measured over the full 664x494 buffer: hiding the cutter changes **exactly
     * 97 pixels, and every one of them is within 24 CSS px of the probe** — zero
     * outside. So "the canvas changed" is not being taken on trust as "the
     * cutter changed": the diff is required to land ON the marker and nowhere
     * else, which is the specificity the colour count was reaching for and only
     * approximated. The radius below is 32 to leave margin over a measurement
     * that was already clean at 24.
     *
     * ⚠ Byte comparison is safe here and was checked rather than assumed: the
     * scene is static (nothing is playing), and two reads 250ms apart differ in
     * ZERO pixels at every radius tried. A racing read would have shown up as
     * self-diff.
     *
     * -----------------------------------------------------------------------
     * 🔴 WATCHED RED, 2026-08-12 — four plants, one per assertion, each read for
     *    WHICH assertion it fired on. This test's ORIGINAL red fired on the
     *    right line for the wrong reason (a needle that could not see its
     *    subject), so a red run on its own proves nothing here.
     * -----------------------------------------------------------------------
     *
     *   delete the `chip.click()`            — a DEAD CONTROL, the defect this
     *       ✘ "the chip reported itself off and the canvas is unchanged where
     *          the cutter is", near = 0.
     *   aim the window 220px off the probe   — is it anchored on the CUTTER?
     *       ✘ same assertion, near = 0. The window is measuring the marker's
     *          published position and not "somewhere on the canvas".
     *   shrink R from 32 to 3               — is the LOCALITY split real?
     *       ✘ "hiding the cutter changed pixels away from the marker",
     *          near = 30, far = 67. The two halves are counted, not asserted
     *          into existence.
     *   move the camera before `capture('back')`
     *       ✘ "the cutter came back DIFFERENT from how it went away". The
     *          restore-identity leg is not satisfied by any repaint.
     *
     *   …and deleting the second `chip.click()` reddens "the cutter did not
     *   come back", so the restore leg is not vacuous either.
     */
    await page.goto('/?fixtures=1');
    await readyRunnable(page);
    await expect(page.getByTestId('status')).toHaveText('runnable');

    /** Where the cutter is, in canvas CSS pixels — the object handle, read once
     *  while it is on screen and reused for every state after. */
    const probeAttr = await page.getByTestId('viewport-canvas').getAttribute('data-tool-probe');
    expect(
      probeAttr,
      'the viewport published no cutter position, so there is no marker to hide and this ' +
        'test is about nothing — a refused marker draws a placeholder cage and publishes ' +
        'no point, deliberately'
    ).toBeTruthy();
    const [probeX, probeY] = (probeAttr as string).split(',').map(Number);

    /** Keep the whole drawing buffer in the page under `name`. Kept in-page
     *  rather than shipped over CDP: a 664x494 frame is 1.3MB of JSON per read,
     *  and the comparison is the only thing this side needs. */
    /*
     * 🔴 CAPTURE A SETTLED FRAME, NOT WHATEVER FRAME IT IS.
     *
     * This read the GL buffer once, immediately. The viewport runs an
     * unconditional `requestAnimationFrame` loop, so two captures taken either
     * side of a click can land on different frames of an in-flight render — and
     * the `far` assertion below is `toBe(0)`, exact. Measured 2026-08-28 on a
     * loaded box: `far = 1029`, on a run whose neighbours either side were
     * clean. The test passed alone, passed in the run before and the run after.
     *
     * ⚠ THE FIX IS DETERMINISM, NOT A TOLERANCE, and the difference matters.
     * `far === 0` is the assertion that makes the one above it *about the
     * cutter* — loosen it and "hiding the cutter changed the canvas" is equally
     * satisfied by the camera drifting or the hidden-count banner reflowing.
     * A pixel budget would have made this test quieter and blinder at once.
     *
     * So: read, wait a frame, read again, and accept only when two consecutive
     * frames are identical. A scene that never settles FAILS with that sentence
     * rather than timing out — because "the renderer will not sit still" and
     * "the toggle did nothing" are different findings and this test can only
     * speak to the second.
     */
    const capture = async (name: string, mustDifferFrom?: string) => {
      /* Annotated so a typo in a verdict string is a compile error rather than a
       * confusing red: nothing else enforces exhaustiveness across this seam. */
      type Verdict = 'settled' | 'no-prior' | 'no-frames' | 'slow' | 'never-settled';
      /* The count travels WITH the verdict so the message can cite it. It used
       * to say "painted 30 frames" as a literal, which is wrong by up to the
       * miss count and wrong every time the deadline ended the loop early. */
      type Settle = { verdict: Verdict; painted: number };
      const settle: Settle = await page.evaluate(async ([n, prior]) => {
        const c = document.querySelector('[data-testid=viewport-canvas]') as HTMLCanvasElement;
        const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext;
        const read = () => {
          const px = new Uint8Array(c.width * c.height * 4);
          gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return px;
        };
        /* 🔴 RACED WITH A TIMER, because `requestAnimationFrame` NEVER FIRES in a
         * hidden or occluded tab, or after a lost GL context. The bound below is
         * a FRAME count; without this race it is not a wall-clock bound at all,
         * and the evaluate would hang to the test timeout — the exact "hanging
         * the suite" this settle was introduced to avoid, in a state the old
         * single-read capture could not reach. */
        /* Resolves TRUE when a frame was actually drawn, FALSE when the 250ms
         * timer won. The distinction is the whole point: without it, a box slow
         * enough for rAF to miss 250ms — WHICH IS THE EXACT CONDITION THAT
         * PRODUCED THE ORIGINAL FLAKE — resolves the wait with nothing drawn,
         * `read()` returns the identical buffer, and the loop declares the scene
         * "settled" on a frame that may be mid-paint. "Two identical consecutive
         * reads" would then mean "nothing was drawn in 250ms", and the exact
         * `far === 0` assertion downstream would flake again with a settled
         * claim behind it. A timer-resolved wait counts toward the bound and may
         * never satisfy the settle test. */
        /* 🔴 THE TIMER IS A LIVENESS BUDGET, NOT A COMPETITOR — corrected after
         * the first version made it one.
         *
         * That version raced rAF against 250ms and treated a timer win as a
         * completed wait. On a box where rAF is consistently slower than 250ms
         * — WHICH IS THE CONDITION THAT PRODUCED THE ORIGINAL FLAKE — every one
         * of the 30 iterations timed out, none reached the settle check, and the
         * loop hard-failed claiming "the renderer will not sit still". It turned
         * an intermittent wrong-green into a reproducible red and blamed the
         * renderer for the load.
         *
         * The deadline is now generous (1s) and only exists so a page whose rAF
         * NEVER fires — hidden tab, occluded, lost context — reports that rather
         * than hanging. A slow frame is waited for; an absent one is named. */
        const frame = (): Promise<boolean> =>
          new Promise((r) => {
            const t = setTimeout(() => r(false), 1000);
            requestAnimationFrame(() => {
              clearTimeout(t);
              r(true);
            });
          });
        const same = (a: Uint8Array, b: Uint8Array) => {
          if (a.length !== b.length) return false;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
          return true;
        };
        const w = window as unknown as Record<string, unknown>;
        const frames = (w.__frames ??= {}) as Record<
          string,
          { w: number; h: number; px: Uint8Array }
        >;
        /* 🔴 SETTLE RELATIVE TO THE PREVIOUS CAPTURE, NOT TO ANY TWO EQUAL
         * FRAMES. The first version read immediately after the click returned
         * and accepted the first pair that matched — so if the three.js redraw
         * had not landed yet, BOTH reads were the PRE-TOGGLE frame, `same()` was
         * true, and the pre-toggle image was stored as "hidden". The test then
         * failed with *"the chip reported itself off and the canvas is
         * unchanged"* — a false accusation against a working control, and the
         * opposite of the flake this settle was added to remove.
         *
         * With `mustDifferFrom` the loop waits for the change FIRST and for
         * stillness second. */
        const before = prior ? frames[prior as string] : undefined;
        /* 🔴 A MISSING PRIOR IS A BROKEN INSTRUMENT, NOT A REASON TO RELAX. With
         * `before` undefined the loop silently degrades to "any two equal
         * frames" while the failure message still claims it waited for a change
         * — a control that quietly stops checking and says it did not. */
        if (prior && !before) return { verdict: 'no-prior' as const, painted: 0 };
        let prev = read();
        let changed = !before || !same(prev, before.px);
        /* 🔴 THE LOOP IS BOUNDED IN WALL CLOCK, NOT IN ITERATIONS — and the
         * previous version made that worse while trying to make it better.
         * Raising the per-frame deadline 250ms → 1s multiplied a 30-ITERATION
         * bound by four: ~30s per capture, three captures per test, inside
         * Playwright's 60s timeout. On the contended box this whole helper is
         * about, it would be KILLED BY THE HARNESS — "hanging the suite", which
         * is the outcome it exists to prevent — and the sentence naming the
         * owner would never print. A per-iteration deadline is not a loop bound.
         *
         * 8s is generous against a settle that normally takes two frames, and it
         * is the number a reader should change if this ever legitimately needs
         * longer. */
        const until = Date.now() + 8000;
        /* Painted frames, so the deadline verdict can say whether the page was
         * ALIVE and slow or not painting at all. Those have different owners and
         * the previous version gave them one sentence. */
        let painted = 0;
        /* Frames where NOTHING was painted. Not reset on a drawn frame, so this
         * counts cumulative misses across the whole capture rather than
         * consecutive ones — the comment that said "consecutive" was describing
         * code that never reset it. Cumulative is the behaviour worth having: a
         * page that drops one frame in ten is not rendering reliably enough for
         * an exact pixel comparison either way. */
        let missed = 0;
        // Bounded by BOTH: 30 iterations and the 8s deadline above, whichever
        // comes first. A scene that never settles reports that rather than
        // hanging the suite.
        for (let i = 0; i < 30 && Date.now() < until; i++) {
          const drew = await frame();
          if (!drew) {
            /* 🔴 AND `prev` IS NOT UPDATED. The first version wrote the
             * untrusted read into `prev`, so a timer-resolved wait supplied one
             * of the two frames the settle test compares — while the comment
             * beside it claimed "a timer-resolved wait can never satisfy the
             * settle test". It could. Nothing was painted, so this iteration
             * contributes nothing but a strike against the liveness budget. */
            /* ⚠ CUMULATIVE, AND THE VERDICT SAYS ONLY WHAT THAT SUPPORTS.
             * `missed` is never reset, so three drops scattered across thirty
             * iterations trips it — which cannot support "the page is not
             * rendering". The earlier version asserted exactly that. If any
             * frame painted, the honest verdict is the slow one. */
            if (++missed >= 3) return painted > 0
              ? { verdict: 'slow' as const, painted }
              : { verdict: 'no-frames' as const, painted };
            continue;
          }
          painted += 1;
          const next = read();
          if (!changed) {
            if (before && !same(next, before.px)) changed = true;
            prev = next;
            continue;
          }
          /* 🔴 STILL, **AND** STILL DIFFERENT FROM `before`. Checking only
           * stillness let a scene that moved away and back settle on a frame
           * identical to the previous capture — which is stored as the new one
           * and then reported as "the canvas is unchanged where the cutter is",
           * a false accusation against a working control. That is the failure
           * this whole helper exists to prevent, reachable through its own
           * success path. */
          if (same(prev, next) && (!before || !same(next, before.px))) {
            frames[n as string] = { w: c.width, h: c.height, px: next };
            return { verdict: 'settled' as const, painted };
          }
          prev = next;
        }
        /* 🔴 THE DEADLINE AND THE ITERATION BOUND ARE DIFFERENT FINDINGS, and
         * the previous version returned one verdict for both — reproducing the
         * defect it was written to remove. "Thirty painted frames that never
         * settled" is about the scene; "eight seconds ran out while the page was
         * painting fine but slowly" is about the MACHINE RUNNING THE TEST, and
         * blaming the renderer for the load is the accusation this helper exists
         * to avoid making. */
        /* 🔴 DISCRIMINATE ON WHAT THE LOOP OBSERVED, NOT ON WHICH BOUND EXPIRED.
         * The first version returned `slow` whenever the 8s deadline won — but
         * the deadline is reached by a full-canvas `readPixels` per iteration on
         * a busy box just as readily as by a scene that will not settle, so a
         * genuinely non-settling scene was reported as *"re-run it on a quiet
         * box"*. That is the round-seven finding INVERTED: it used to blame the
         * renderer for the load, and that version blamed the load for the
         * renderer.
         *
         * `changed` is the observation that separates them: if the scene never
         * differed from the previous capture at all, the toggle did nothing and
         * no amount of quiet box will change that. */
        if (!changed) return { verdict: 'never-settled' as const, painted };
        return Date.now() >= until && painted > 0
          ? { verdict: 'slow' as const, painted }
          : { verdict: 'never-settled' as const, painted };
      }, [name, mustDifferFrom ?? null] as [string, string | null]);
      /* 🔴 EACH FAILURE NAMES ITS OWN OWNER. The previous version returned a
       * bare boolean and chose the message from `mustDifferFrom` alone — so a
       * page whose rAF never fired was reported as "the toggle did nothing, or
       * the renderer will not sit still", a false accusation against a working
       * control, which is the failure this helper's own header says it exists to
       * prevent. Three causes, three sentences. */
      const { verdict, painted } = settle;
      expect(
        verdict,
        verdict === 'no-frames'
          ? `nothing was painted at all while capturing "${name}". The page is not rendering — a ` +
            'hidden tab, an occluded window or a lost GL context — which is a finding about the ' +
            'BROWSER, not about the chip and not about the renderer being busy.'
          : verdict === 'slow'
            ? `the page WAS painting while capturing "${name}", and the 8-second budget ran out ` +
              'before the scene settled. That is a finding about the MACHINE RUNNING THIS TEST, ' +
              'not about the chip and not about the renderer — re-run it on a quiet box before ' +
              'reading it as a defect.'
            : verdict === 'no-prior'
              ? `capture "${mustDifferFrom}" was never stored, so "${name}" has nothing to be ` +
                'compared against. That is a broken test, not a finding about the app.'
              : mustDifferFrom
                ? `the 3D scene painted ${painted} frame(s) and never both CHANGED from "${mustDifferFrom}" ` +
                  `and settled, while capturing "${name}". Either the toggle did nothing or the ` +
                  'renderer will not sit still — and this test cannot tell those apart, so it ' +
                  'refuses to guess. It is NOT a finding about load: the frames were painted.'
                : `the 3D scene painted ${painted} frame(s) and never produced two identical consecutive ` +
                  `ones while capturing "${name}". A finding about the renderer, not about the chip.`
      ).toBe('settled');
    };

    /**
     * Pixels that differ between two captured frames, split by whether they lie
     * inside the box of half-width `r` around the cutter — `near` is the marker,
     * `far` is everything the toggle should not have touched.
     */
    const compare = (a: string, b: string, r: number) =>
      page.evaluate(
        ([an, bn, cx, cy, rad]) => {
          const w = window as unknown as Record<string, unknown>;
          const frames = w.__frames as Record<
            string,
            { w: number; h: number; px: Uint8Array }
          >;
          const A = frames[an as string];
          const B = frames[bn as string];
          // readPixels is BOTTOM-left origin; the probe is top-left CSS px. The
          // canvas measured 1:1 with CSS pixels here (dpr 1), and the scale is
          // still derived rather than assumed — a dpr change would otherwise be
          // a wrong answer nobody notices. Hoisted out of the loop: a layout
          // read per pixel is 300k+ of them.
          const rect = (
            document.querySelector('[data-testid=viewport-canvas]') as HTMLCanvasElement
          ).getBoundingClientRect();
          const sx = A.w / rect.width;
          const sy = A.h / rect.height;
          let near = 0;
          let far = 0;
          for (let i = 0; i < A.px.length; i += 4) {
            if (
              A.px[i] === B.px[i] &&
              A.px[i + 1] === B.px[i + 1] &&
              A.px[i + 2] === B.px[i + 2]
            )
              continue;
            const p = i / 4;
            const x = (p % A.w) / sx;
            const y = (A.h - 1 - Math.floor(p / A.w)) / sy;
            if (
              Math.abs(x - (cx as number)) <= (rad as number) &&
              Math.abs(y - (cy as number)) <= (rad as number)
            )
              near++;
            else far++;
          }
          return { near, far };
        },
        [a, b, probeX, probeY, r] as const
      );

    const R = 32;

    /*
     * ⚠ MIGRATED 2026-08-11 — the cutter's control is now the `kind-tool` row at
     * the foot of `panel-tools` (`LAYER_SECTION.tool`, `Viewport.tsx`). The
     * testid is unchanged because it is the same control moved, so the two
     * assertions below still mean what they meant.
     *
     * 🔴 AND THE `pointerEvents` HAZARD THIS TEST WAS BUILT AROUND IS NOT GONE,
     * IT MOVED. The reason above — a control that reports its state while being
     * unclickable — was about the canvas overlay column. The sidebar has no such
     * shield, but the row is now inside a COLLAPSIBLE section, which is a second
     * way for a control to be unreachable while looking fine in the markup. The
     * GL-buffer assertions below are what tell a real click from a reported one,
     * and they are unchanged; the guard just makes a shut panel say so instead
     * of timing out on `kind-tool` as if the control had been deleted.
     */
    await expectSectionOpen(page, 'panel-tools');
    const chip = page.getByTestId('kind-tool');
    await expect(chip).toBeVisible();
    await expect(chip).toBeEnabled();

    await capture('shown');

    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    // Must have CHANGED from `shown` before it may settle — see `capture`.
    await capture('hidden', 'shown');
    const hid = await compare('shown', 'hidden', R);
    expect(
      hid.near,
      'the chip reported itself off and the canvas is unchanged where the cutter is — a ' +
        'dead control and a working one are identical in `aria-pressed`'
    ).toBeGreaterThan(0);
    // …and the change is the CUTTER, not a repaint. Without this, "something on
    // the canvas moved" is equally satisfied by the camera drifting, by the
    // hidden-count banner reflowing the layout under the canvas, or by any other
    // object this chip should not be able to touch. Measured: 97 near, 0 far.
    expect(
      hid.far,
      'hiding the cutter changed pixels away from the marker — the chip is repainting ' +
        'something other than the cutter, or the published probe is not where the cutter ' +
        'is drawn, and either way the assertion above is no longer about the cutter'
    ).toBe(0);

    // …and it comes BACK. A one-way toggle passes a hide assertion forever.
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await capture('back', 'hidden');
    expect(
      (await compare('hidden', 'back', R)).near,
      'the cutter did not come back'
    ).toBeGreaterThan(0);
    // 🔴 It came back THE SAME. "It changed again" is also satisfied by a
    // restore that lost the shank, the emissive or the open-tip ring — the
    // frame is required to be byte-identical to the one before the hide, which
    // is measurable here only because the scene is static and two reads 250ms
    // apart were measured to differ in zero pixels.
    const restored = await compare('shown', 'back', R);
    expect(
      [restored.near, restored.far],
      'the cutter came back DIFFERENT from how it went away — the toggle is rebuilding the ' +
        'marker rather than revealing it'
    ).toEqual([0, 0]);

    // 🔴 Hiding the PICTURE must not touch the PROGRAM. The layer state is
    // viewport-local by design and never reaches the plan; this is where that
    // stops being a comment.
    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const before = await page.getByTestId('gcode').textContent();
    await chip.click();
    await expect(page.getByTestId('gcode')).toHaveText(before ?? '');
  });

  /* =========================================================================
   * 🔴 THE UNGUARDED HALF OF 2026-08-10 — four UI passes landed that day, each
   * closing with "this is unguarded, `web/e2e/` was forbidden to me, here are
   * the assertions". These are those assertions.
   *
   * ⚠ NONE OF THEM HAS BEEN RUN. See the banner at the top of this file. Each
   * carries its own note naming what is unproven about it; do not read a
   * `MEASURED:` line as a browser observation — those came from the release CLI
   * and from reading `web/src/**`, which are the two things that work here.
   * ========================================================================= */

  test('a grab moves the drawing under the pointer, and the other copy of it does not move', async ({
    page,
  }) => {
    /*
     * 🔴 THE ASSERTION THAT WOULD HAVE CAUGHT `cafa41a9d8`, and it is the SECOND
     * half of it that does the work.
     *
     * Until that commit the viewport picked its drag target with
     * `find(o.name === 'loaded' || o.name === 'walls')` — ONE global object,
     * however many drawings were on the sheet — and the drag then wrote the
     * SELECTED drawing's placement. So a grab aimed at any part moved whichever
     * row the panel happened to be talking about. "The part I dragged moved" was
     * true in the old code too, for the one case where the selection and the
     * grab coincide. Only "and the OTHER one did not" separates them.
     *
     * This test therefore grabs the copy while the ORIGINAL is selected, which
     * is the arrangement the old code gets exactly backwards:
     *
     *     old code:  drag copy -> ORIGINAL moves, copy stands still
     *     fixed:     drag copy -> COPY moves, original stands still
     *
     * and both halves are asserted, so neither outcome can be mistaken for the
     * other.
     *
     * MEASURED (release CLI, `2bee-slice fit gates/fixtures/plate.dxf`):
     * plate.dxf is drawn at X 50..250, Y 50..170, so a copy offset +400 in X
     * occupies 450..650 and sits clear of the original on a 1000x800 sheet —
     * far enough that a drag of a few tens of millimetres cannot re-overlap them
     * and turn this into a refusal test.
     *
     * ⚠ NEVER RUN. Unproven here: that both parts are on screen under the fixed
     * camera at this travel, that the published probe points are not covered by
     * an overlay chip (asserted, so a failure names it), and that the drag does
     * not push the copy off the sheet.
     */
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('1200');
    await page.getByTestId('travel-y').fill('1000');
    await page.getByTestId('stock-x').fill('1000');
    await page.getByTestId('stock-y').fill('800');
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('drawing-copy-0').click();
    await expect(page.getByTestId('drawing-rows').locator('.objrow')).toHaveCount(2);
    // Apart, so the sheet plans. On top of each other it is REFUSED and every
    // drawing-frame object is drawn at the machine origin, which would make the
    // bbox comparison below measure the refusal rather than the drag.
    await page.getByTestId('drawing-x-1').fill('400');
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });

    /* 🔴 THE KEYS ARE THE PROGRAM'S OWN INSTANCE IDS, NOT ROW INDICES. This is
     * the property that makes the rest of the test mean anything: a picture
     * keyed on `0`/`1` and a program keyed on `plate.dxf`/`plate.dxf #2` are two
     * indexes that agree until a row is removed, and then silently do not. */
    const bboxes0 = await partTable(page, 'bboxes');
    const probes = await partTable(page, 'probes');
    const ids = Object.keys(bboxes0).sort();
    expect(
      ids,
      `the viewport published no per-instance boxes, or published them under keys that are ` +
        `not the ids the program names these parts with: ${JSON.stringify(ids)}`
    ).toEqual(['plate.dxf', 'plate.dxf #2']);
    expect(Object.keys(probes).sort(), 'the probe table and the box table disagree').toEqual(ids);

    // The ORIGINAL is what the panel is about — `drawing-copy` does not move the
    // selection — so the single-part probes describe it, and the grab below
    // deliberately does not.
    await expect(page.getByTestId('viewport-canvas')).toHaveAttribute(
      'data-part-selected',
      'plate.dxf'
    );

    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const [gx, gy] = probes['plate.dxf #2'];
    // Nothing covering the grab point. An overlay chip over it is
    // indistinguishable from a handler that never fired — the failure that cost
    // this lane a day on the rotate handle and again on the snap chips.
    const onTop = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-testid') ?? '',
      [box.x + gx, box.y + gy]
    );
    expect(onTop, `something is covering the second copy at ${gx},${gy}`).toBe('viewport-canvas');

    const before = {
      x0: await page.getByTestId('drawing-x-0').inputValue(),
      y0: await page.getByTestId('drawing-y-0').inputValue(),
      x1: await page.getByTestId('drawing-x-1').inputValue(),
      y1: await page.getByTestId('drawing-y-1').inputValue(),
    };

    await page.mouse.move(box.x + gx, box.y + gy);
    await page.mouse.down();
    await page.mouse.move(box.x + gx + 40, box.y + gy + 20, { steps: 10 });
    await page.mouse.up();

    await expect(
      page.getByTestId('status'),
      'the drag pushed the copy off the sheet or back onto the original — the assertions below ' +
        'would then be measuring a refusal, not a placement'
    ).toHaveText('runnable', { timeout: 30_000 });

    // (a) THE ONE UNDER THE POINTER MOVED.
    const after1 = [
      Number(await page.getByTestId('drawing-x-1').inputValue()),
      Number(await page.getByTestId('drawing-y-1').inputValue()),
    ];
    expect(
      Math.hypot(after1[0] - Number(before.x1), after1[1] - Number(before.y1)),
      'the grab landed on the second copy and it did not move'
    ).toBeGreaterThan(1);

    // (b) 🔴 THE ONE THAT WAS SELECTED DID NOT. Without this the test passes for
    // the pre-`cafa41a9d8` code, which moved this row on every grab.
    expect(
      [
        await page.getByTestId('drawing-x-0').inputValue(),
        await page.getByTestId('drawing-y-0').inputValue(),
      ],
      'dragging the SECOND copy moved the FIRST — the drag is writing the selected row rather ' +
        'than the part under the pointer'
    ).toEqual([before.x0, before.y0]);

    // (c) ...and the PICTURE followed the same split, in bed millimetres. The
    // panel and the drawn object are two different derivations of one placement,
    // and this feature's whole failure mode is the two disagreeing.
    const bboxes1 = await partTable(page, 'bboxes');
    expect(
      bboxes1['plate.dxf'],
      'the first copy is DRAWN somewhere else while its numbers did not change'
    ).toEqual(bboxes0['plate.dxf']);
    const drew = bboxes1['plate.dxf #2'];
    const drew0 = bboxes0['plate.dxf #2'];
    expect(
      Math.hypot(drew[0] - drew0[0], drew[1] - drew0[1]),
      'the dragged copy is drawn exactly where it was, while its numbers moved'
    ).toBeGreaterThan(1);
  });

  test('a grab that lands on a part never becomes a sheet drag', async ({ page }) => {
    /*
     * 🔴 THE FALL-THROUGH GUARD — a hazard the multi-drawing change created and
     * closed in the same commit (`cafa41a9d8`), which is exactly the kind of
     * thing that has no test because it never shipped as a bug.
     *
     * The part sits ON the board. If a grab that lands on a part but cannot be
     * turned into a part drag fell through to the next tier, it would move the
     * SHEET DATUM — and the datum carries the clamps' and the touch plate's
     * relationship to the work with it. A gesture aimed at a part would silently
     * re-reference the whole program. The pick therefore refuses to the ORBIT
     * tier, which changes nothing that can be cut.
     *
     * ⚠ WHAT THIS TEST DOES NOT REACH, stated rather than implied. The branch
     * that produced the hazard is an UNKEYED hit: `instanceOf()` returning `''`
     * for a part whose name matches no declared instance. That state is not
     * reachable from the browser today — `App.tsx` sends `id: d.instance` for
     * every drawing on the `planImportMany` path, so every part comes back
     * namespaced — and the `loaded` solid, which is the other object that can be
     * unkeyed, is only ever present when there is exactly one drawing. The guard
     * is ONE `if (!onPart)`, shared by both the keyed and the unkeyed path, and
     * this test drives it through the keyed one. That is coverage of the line,
     * not of the case; the unkeyed case is guarded by construction and by
     * nothing else. Reported rather than faked with a plant that does not exist.
     *
     * ⚠ NEVER RUN.
     */
    await page.goto('/');
    await panelsReady(page);
    await page.getByTestId('travel-x').fill('1200');
    await page.getByTestId('travel-y').fill('1000');
    await page.getByTestId('stock-x').fill('1000');
    await page.getByTestId('stock-y').fill('800');
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toHaveText('runnable', { timeout: 30_000 });

    const datumBefore = [
      await page.getByTestId('origin-x').inputValue(),
      await page.getByTestId('origin-y').inputValue(),
    ];
    const partBefore = [
      await page.getByTestId('part-x').inputValue(),
      await page.getByTestId('part-y').inputValue(),
    ];

    const canvas = page.getByTestId('viewport-canvas');
    const box = (await canvas.boundingBox())!;
    const probe = await canvas.getAttribute('data-part-probe');
    expect(probe, 'the viewport published no grab point for the only drawing on the sheet').toBeTruthy();
    const [gx, gy] = probe!.split(',').map(Number);

    await page.mouse.move(box.x + gx, box.y + gy);
    await page.mouse.down();
    await page.mouse.move(box.x + gx + 40, box.y + gy + 20, { steps: 10 });
    await page.mouse.up();

    // 🔴 THE DATUM IS UNTOUCHED. This is the assertion; the one below it is the
    // paired positive that stops "nothing happened at all" from passing.
    expect(
      [
        await page.getByTestId('origin-x').inputValue(),
        await page.getByTestId('origin-y').inputValue(),
      ],
      'a drag that started ON A PART moved the SHEET DATUM — the clamps and the touch plate do ' +
        'not move with it, so this re-references the whole program from a gesture aimed at a part'
    ).toEqual(datumBefore);

    expect(
      [
        await page.getByTestId('part-x').inputValue(),
        await page.getByTestId('part-y').inputValue(),
      ],
      'the part did not move either — this test would pass for a viewport where nothing is ' +
        'grabbable at all, which is the state cafa41a9d8 was fixing'
    ).not.toEqual(partBefore);
  });

  test('the drawing rows and the sidebar fit inside the panel, at the shipped width and after the report is resized', async ({
    page,
  }) => {
    /*
     * 🔴 FOUNDER SYMPTOM, 2026-08-10: *"the X/Y/rotation inputs are clipped off
     * the panel"*. MEASURED on the running app for `cafa41a9d8`: `drawing-rows`
     * had `clientWidth 250` and `scrollWidth 517`, with `drawing-y-0` at x=241
     * and `drawing-rot-0` at x=407 — both outside the panel. With nothing on the
     * sheet grabbable at the time, those fields were THE ONLY WAY TO PLACE A
     * PART, and they were unreachable.
     *
     * The same commit found the sidebar still overflowing by 62px on the CLAMP
     * rows: `1fr repeat(5,52px) 26px` needs 310px in a 250px box, so the ✕ THAT
     * REMOVES A CLAMP sat at x=336 against a panel edge of 290.
     *
     * The fix is `repeat(auto-fit, minmax(...))` in both places, i.e. no
     * breakpoint — so the check is not "it fits at 290px", it is "it fits at
     * whatever width the panel currently is". Both rows are exercised: a drawing
     * row and a clamp row, because they were two separate grids and only one of
     * them was in the founder's sentence.
     *
     * ⚠ WHY THE REPORT RESIZE IS IN HERE. `.side` is a fixed 290px grid column
     * and the splitter moves the REPORT column, so widening the report cannot
     * squeeze the sidebar directly — that is read from `styles.css:219` and is
     * the reason this leg asserts the PAGE does not start scrolling sideways as
     * well as the panels not clipping. `clampReportW` is what should prevent it,
     * and nothing was watching that either.
     *
     * ⚠ NEVER RUN. Unproven here: that `scrollWidth`/`clientWidth` on these
     * elements behave as expected once the panels have their real fonts, and
     * that the keyboard path on the splitter actually changes the width (the
     * assertion on `aria-valuenow` is what makes a dead key a failure rather
     * than a silent no-op).
     */
    await page.goto('/');
    await panelsReady(page);
    await page
      .getByTestId('import-file')
      .setInputFiles(resolve(HERE, '../../gates/fixtures/plate.dxf'));
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
    // A clamp row too — the adjacent overflow the same commit found.
    await page.getByTestId('add-clamp').click();
    await expect(page.getByTestId('clamp-0-x')).toBeVisible();

    /** Every element inside `.side` that is WIDER than the panel can show,
     *  named. A boolean answer to "does it fit" is unactionable; the failure a
     *  reader needs is WHICH control is off the edge.
     *
     *  ⚠ FIRST RUNNER, READ THIS. `cafa41a9d8` measured ZERO offenders here on a
     *  live page, which is why the expectation is an empty list rather than a
     *  count — but that measurement was taken on the founder's page, not on this
     *  fixture. If this goes red on its first ever run, check whether the named
     *  element is genuinely clipped before assuming a regression: an element
     *  reporting `scrollWidth` a pixel or two over the panel is the kind of thing
     *  a font substitution does, and a false red here costs more than the
     *  finding is worth. Narrow the sweep, do not delete it. */
    const overflowing = () =>
      page.evaluate(() => {
        // By testid, not by `.side`: the class is a styling hook and the testid
        // is the contract. A selector that resolves to nothing would make this
        // sweep pass by finding no elements, which is the shape of green this
        // whole file exists to refuse — hence the explicit absence branch.
        const side = document.querySelector('[data-testid=panels]') as HTMLElement | null;
        if (!side) return ['the side panel (data-testid=panels) is not in the document'];
        const out: string[] = [];
        if (side.scrollWidth > side.clientWidth) {
          out.push(`.side ${side.scrollWidth} > ${side.clientWidth}`);
        }
        for (const el of Array.from(side.querySelectorAll<HTMLElement>('*'))) {
          // The panel's own client box is the edge everything inside it must
          // respect — an element can have scrollWidth === clientWidth and still
          // be drawn past the panel edge, which is precisely what the clamp row
          // did.
          if (el.scrollWidth > side.clientWidth) {
            const id = el.getAttribute('data-testid') ?? el.className ?? el.tagName;
            out.push(`${id} ${el.scrollWidth} > panel ${side.clientWidth}`);
          }
        }
        return out;
      });

    const rowsFit = () =>
      page.getByTestId('drawing-rows').evaluate((el) => [el.scrollWidth, el.clientWidth]);

    // (a) At the shipped width.
    {
      const [sw, cw] = await rowsFit();
      expect(sw, `drawing-rows is clipped: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
      expect(await overflowing(), 'controls are drawn past the sidebar edge').toEqual([]);
    }

    // (b) After the report panel is dragged wider — the layout is now
    // user-resizable, so "it fits" has to hold at more than one layout.
    const splitter = page.getByTestId('report-resizer');
    const widthNow = async () => Number(await splitter.getAttribute('aria-valuenow'));
    const w0 = await widthNow();
    // 🔴 THE PRECONDITION, so a clamped width cannot read as a dead key.
    // `clampReportW` caps the report at `innerWidth - 290 - 320`; ten ArrowLefts
    // ask for +160px, so on a narrow viewport the width would legitimately not
    // move and the assertion below would blame the keyboard. MEASURED from
    // `App.tsx`: room = innerWidth - 610, default width 320, so this needs an
    // inner width of at least 1090. Playwright's Desktop Chrome is 1280.
    expect(
      await page.evaluate(() => window.innerWidth),
      'this viewport is too narrow for the report panel to widen at all — the resize leg below ' +
        'would be measuring clampReportW, not the splitter'
    ).toBeGreaterThanOrEqual(1090);
    await splitter.focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft'); // +16px each
    expect(
      await widthNow(),
      'the splitter reports the same width after ten ArrowLeft presses — the keyboard path is ' +
        'dead, and a 6px sliver is the whole of the pointer affordance'
    ).toBeGreaterThan(w0);

    {
      const [sw, cw] = await rowsFit();
      expect(sw, `drawing-rows is clipped after the resize: ${sw} > ${cw}`).toBeLessThanOrEqual(cw);
      expect(await overflowing(), 'controls are past the sidebar edge after the resize').toEqual([]);
    }
    // ...and widening the report may not push the PAGE sideways. `clampReportW`
    // is the only thing between a remembered width and a horizontal scrollbar.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      ),
      'widening the report panel made the whole page scroll sideways'
    ).toBeLessThanOrEqual(0);

    // Home restores the default, which is the way back for anyone who overshot.
    await page.keyboard.press('Home');
    expect(await widthNow(), 'Home did not restore the default report width').toBe(320);
  });

  test('uncut is PENDING at zero and red above it, and the pending note is not a pass', async ({
    page,
  }) => {
    /*
     * 🔴 `uncut <= 20` USED TO RENDER GREEN, on a threshold that exists nowhere
     * in the core (`7140829eb6`). Gouge and spoilboard go red at 1; uncut had a
     * 20-cell green band, sized — by the look of it — against a pre-fix count of
     * 25 that `core/src/sim.rs::check` had already removed by shrinking both
     * region sets by one cell. And that function says in as many words which
     * direction is dangerous: over-reporting removal is the SAFE error for a
     * gouge and the UNSAFE one for an uncut island. The band sat on the unsafe
     * side.
     *
     * Zero is not green either, and that is the second half. `sim::check` gates
     * the whole uncut limb on `remove_depth_mm > 0.0`, and an imported drawing
     * declares no removal region — so on an operator's own job the counter
     * CANNOT FIRE and `0` means nobody asked.
     *
     * MEASURED on this box (release CLI, `report <job>`, reading `sim`):
     *
     *     plate       uncut 0     uncut_checked false   cells tested 0
     *     socket      uncut 0     uncut_checked false   cells tested 0
     *     multi-tool  uncut 0     uncut_checked false   cells tested 0
     *     clamped     uncut 0     uncut_checked false   cells tested 0
     *     pocket      uncut 3     uncut_checked TRUE    cells tested 9604
     *     pocket --plant outline-only
     *                 uncut 6563  uncut_checked TRUE    cells tested 9604
     *
     * so `plate` (the default fixture) is the PENDING case and `pocket` is the
     * red one, and neither needs a plant. The plant is driven anyway as the
     * third state, because 3 and 6563 landing in the same class is what proves
     * the class is not keyed on the size of the number.
     *
     * ✅ THE THING THE ROW SHOULD BE KEYED ON — LANDED 2026-08-11, AND THIS
     * TEST NOW KEYS ON IT. Until that day this block carried a paragraph
     * beginning *"WHAT THIS TEST CANNOT ASSERT"*, and BOTH of its two claims
     * are now false:
     *
     *   - *"`SimCounts::uncut_checked` … is NOT in `web/src/cam.ts`"* — it is,
     *     with `uncut_cells_tested` and `uncut_pending_reason` beside it.
     *   - *"There is no testid for the flag, so this is reported, not tested"*
     *     — `App.tsx` derives `uncutState` from `uncut_checked` once, and
     *     stamps it on the counter as `data-uncut-state`, with THREE values:
     *       pending — the test did not run. `0` means nobody asked.
     *       clean   — it RAN and found nothing. A real pass.
     *       finding — it ran and material is left standing.
     *
     * 🔴 THE COMMENT SURVIVED BECAUSE THE TEST STILL PASSED. It inferred the
     * state from the COUNT and the CLASS, which is exactly what the old panel
     * did — so the day the panel stopped keying on the count, nothing here
     * changed colour and the paragraph went on describing a gap that had been
     * closed. A stale caveat beside a green assertion is the longest-lived kind
     * of wrong sentence in this file, and the fix is not to delete it: the
     * history is why the assertions below are shaped the way they are.
     *
     * ⇒ Each leg now asserts `data-uncut-state` — the flag — and the class
     * SECOND, so a panel that renders the right colour for the wrong reason
     * fails here. The `clean` value is deliberately NOT exercised: no shipped
     * job reaches it (measured above — only `pocket` runs the test at all), and
     * a leg asserting a state nothing can produce is vacuous. Named rather than
     * quietly omitted.
     *
     * ⚠ NEVER RUN.
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    const uncut = page.getByTestId('sim-uncut');
    const gouge = page.getByTestId('sim-gouge');

    // (a) PENDING at zero — asserted on the FLAG first. `plate` declares no
    // removal region, so `uncut_checked` is false and the `0` beside it means
    // nobody asked. The class is checked after, because the class is derived
    // from the flag and a class that agreed by accident would pass alone.
    await expect(
      uncut,
      'the default fixture must render the state the core reports (uncut_checked=false), not a ' +
        'state inferred from the count — those two agreed for weeks and only one of them is a fact'
    ).toHaveAttribute('data-uncut-state', 'pending');
    await expect(uncut).toHaveText('0');
    await expect(uncut, 'uncut at zero is styled as a pass').toHaveClass(/pending/);
    await expect(uncut).not.toHaveClass(/\bok\b/);
    await expect(gouge, 'the control: gouge at zero IS a pass and must stay one').toHaveClass(
      /\bok\b/
    );
    await expect(page.getByTestId('sim-uncut-pending')).toContainText('not a pass');
    // The other half of the pair: the MEASURED note must be absent here. A
    // panel showing both notes claims the test both ran and did not.
    // ⚠ Per the file banner, a `toHaveCount(0)` is satisfied by a shut panel as
    // well as by an absent element — so both of this test's zero-counts sit
    // immediately after a POSITIVE assertion inside the same section, which is
    // what proves the section was open when the count was taken.
    await expect(page.getByTestId('sim-uncut-measured')).toHaveCount(0);

    // (b) A FINDING at three. `pocket` is the one shipped job that declares a
    // region to clear, so it is the only place this counter is a measurement at
    // all — and the measured note must name the cells the core actually tested,
    // which is the evidence `0 over 0 cells` and `3 over 9,604` differ by.
    await page.getByTestId('job-select').selectOption('pocket');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
    await expect(
      uncut,
      'the pocket fixture reports uncut cells over 9,604 tested and the panel did not render a ' +
        'finding — the invented 20-cell tolerance is back, or the state is keyed on something else'
    ).toHaveAttribute('data-uncut-state', 'finding');
    await expect(uncut).toHaveClass(/bad/);
    await expect(page.getByTestId('sim-uncut-pending')).toHaveCount(0);
    await expect(
      page.getByTestId('sim-uncut-measured'),
      'a finding must show the evidence, not just the number: "3" and "3 over 9,604 cells" are ' +
        'different claims and only the second is a result'
    ).toContainText('9604');
    expect(Number(await uncut.textContent()), 'the pocket fixture stopped reporting any uncut cells — ' +
      'this leg is now vacuous and proves nothing about the threshold').toBeGreaterThan(0);

    // (c) ...and at six thousand. Same STATE, so the row is keyed on "the test
    // ran and found something" rather than on a magnitude nobody chose.
    await page.getByTestId('plant-select').selectOption('outline-only');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
    await expect(uncut).toHaveAttribute('data-uncut-state', 'finding');
    await expect(uncut).toHaveClass(/bad/);
    expect(Number(await uncut.textContent())).toBeGreaterThan(100);
  });

  // =========================================================================
  //  THE SPOILBOARD IS A THING ON THE MACHINE (commit `043788cb09`)
  //
  //  🔴 EVERY TEST IN THIS BLOCK IS UNRUN. Same box, same missing WebGL, and
  //  each carries its own `⚠ NEVER RUN` line for the reason the file banner
  //  gives — an excerpt does not travel with its header.
  //
  //  The physical failure the whole block is about: the app drew a solid the
  //  size of the travel envelope and called it the bed. Travel is REACH; a
  //  spoilboard is MATERIAL. Drawing reach as a surface tells the operator
  //  there is sacrificial material everywhere the cutter can go, and the one
  //  thing that must never be true again is that an UNDECLARED board looks
  //  like a board covering everything.
  // =========================================================================

  test('the Spoilboard panel exists, and sits between Machine and Workpiece', async ({ page }) => {
    /*
     * ⚠ NEVER RUN. Unproven here: that `compareDocumentPosition` sees the three
     * panels in the sidebar's own order rather than in some portal order, and
     * that all three are mounted at once on a page with a report.
     *
     * MEASURED, by reading `web/src/App.tsx`: `panel-machine` is declared at
     * :3129, `panel-spoilboard` at :3495, `panel-stock` at :4026. The ORDER is
     * the claim — the board sits under the work and over the rails, and the
     * panel that declares it belongs between the machine it is bolted to and
     * the stock that sits on it.
     */
    await page.goto('/?fixtures=1');
    await ready(page);
    for (const id of ['panel-machine', 'panel-spoilboard', 'panel-stock']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    const order = await page.evaluate(() => {
      const at = (t: string) => document.querySelector(`[data-testid=${t}]`);
      const nodes = ['panel-machine', 'panel-spoilboard', 'panel-stock'].map(at);
      if (nodes.some((n) => !n)) return null;
      // DOCUMENT_POSITION_FOLLOWING === 4
      const before = (a: Element, b: Element) =>
        (a.compareDocumentPosition(b) & 4) === 4;
      return {
        machineBeforeBoard: before(nodes[0]!, nodes[1]!),
        boardBeforeStock: before(nodes[1]!, nodes[2]!),
      };
    });
    expect(order, 'one of the three panels is not in the document').not.toBeNull();
    expect(order!.machineBeforeBoard, 'Spoilboard is not after Machine').toBeTruthy();
    expect(order!.boardBeforeStock, 'Spoilboard is not before Workpiece').toBeTruthy();
  });

  test('a fresh app declares NO board, and the past-the-edge count reads PENDING', async ({
    page,
  }) => {
    /*
     * 🔴 THIS IS THE ONE THE WHOLE CHANGE EXISTS FOR, and the negative control
     * for it is written out below because without one the claim *"we do not
     * draw a board the size of the travel envelope"* is untested.
     *
     * The three assertions are chosen so that a build which drew a
     * travel-sized ground plane on an undeclared board would break EACH of
     * them, not merely one:
     *   (a) the layer chip. `liveLayersOf()` offers `kind-spoilboard` only when
     *       `props.spoilboard` is non-null, so a drawn board necessarily has a
     *       control and an undeclared one necessarily has none. MEASURED at
     *       `Viewport.tsx` — `spoilLive = !!s.spoilboard`, and the chip is
     *       gated on it rather than rendered disabled, deliberately, because a
     *       greyed chip reads as "there is one, it is switched off".
     *   (b) the panel's own status paragraph, which says the distinction in
     *       words: *"This is not a board covering the travel envelope; it is no
     *       board at all."*
     *   (c) the simulation counter, which must read PENDING rather than 0.
     *
     * 🔴 THE NEGATIVE CONTROL, WRITTEN DOWN BECAUSE IT CANNOT BE AUTOMATED
     * FROM HERE. `--plant` reaches the Rust core and the board is drawn in
     * TypeScript, so there is no flag that plants this. The recipe, exact
     * enough to run without rediscovering it:
     *
     *   In `web/src/Viewport.tsx`, in the spoilboard block (`const board =
     *   props.spoilboard ?? null;`, ~:3299), replace the null with the travel
     *   rectangle:
     *       const board = props.spoilboard ?? {
     *         name: 'planted', x_mm: 0, y_mm: 0,
     *         size_x_mm: props.travel[0], size_y_mm: props.travel[1],
     *       };
     *   That is EXACTLY the pre-2026-08-10 behaviour — a solid the size of
     *   travel, drawn whether or not anyone declared one — and it is the
     *   defect this test exists to catch. Limb (a) must go red on it.
     *
     * ⚠ AND THE HONEST PART: the plant above has NOT been run, because nothing
     * in this file has. Until somebody with a GPU runs it, this is a recipe and
     * not a control, and the claim is *"an assertion exists that a travel-sized
     * board would break"*, never *"we have watched it break"*.
     *
     * ⚠ NEVER RUN. Unproven here: that `panel-sim` is present on a fresh
     * fixture page without being opened, and that the status paragraph and the
     * status grid genuinely share the `spoilboard-status` testid so a single
     * locator can see both states (read at `App.tsx` :3943 and :3949 — they do,
     * which is deliberate and is why the TEXT is asserted and not the presence).
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    /*
     * (a) no board is drawn, so there is no layer control for one.
     *
     * 🔴 GUARDED 2026-08-11. The control moved out of the canvas chip row and
     * into `panel-spoilboard` (`LAYER_SECTION.spoilboard`, `Viewport.tsx`), and
     * a collapsed `<Section>` renders no body — so from that commit this
     * `toHaveCount(0)` has TWO ways to pass and only one of them is limb (a) of
     * this test. The section's open state is now also persisted per profile
     * (`2bee.app.panels.open`), so "it opens by default" is a fact about a fresh
     * profile rather than about this page. Assert the container, then the
     * absence.
     *
     * ⚠ This is the limb the whole test exists for — *"we do not draw a board
     * the size of the travel envelope"* — so it is the one that must not be
     * allowed to go green on a shut drawer.
     */
    await expectSectionOpen(page, 'panel-spoilboard');
    await expect(
      page.getByTestId('kind-spoilboard'),
      'a spoilboard layer control exists on an app where nobody declared a board'
    ).toHaveCount(0);

    // (b) the panel says which of the two states it is in, in words.
    await expect(page.getByTestId('spoilboard-status')).toContainText('Not declared');
    await expect(page.getByTestId('spoilboard-status')).toContainText(
      'not a board covering the travel envelope'
    );
    await expect(page.getByTestId('spoilboard-no-default')).toBeVisible();

    // (c) PENDING, not 0. `0` and `0` are the same three glyphs whether nobody
    // asked or nothing reached the frame.
    const past = page.getByTestId('sim-past-spoil');
    await expect(past).toHaveText('PENDING');
    await expect(past).toHaveClass(/pending/);
    await expect(past, 'an unchecked position is painted as a pass').not.toHaveClass(/\bok\b/);
  });

  test('choosing a catalogue board fills the corner, marks it ASSUMED, and refuses to paint zero green', async ({
    page,
  }) => {
    /*
     * ⚠ NEVER RUN. Unproven here: that the catalogue has arrived by the time
     * the picker is opened (`spoilboard-catalogue-pending` is the state where
     * it has not, and this test does not wait for it to clear), and that
     * selecting the row commits and closes — `spoilboard-picker` is
     * `mode="single"`, read at `App.tsx` :3564, which is `pickOne`'s contract.
     *
     * MEASURED at `core/src/spoilboards.rs`: `2bee-cnc-table-mdf-18` is
     * 1080 x 1560 x 18mm MDF, and it is the board this company's own table
     * carries.
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    await pickOne(page, 'spoilboard-picker', '2bee-cnc-table-mdf-18');

    // The corner is WRITTEN, not left blank: founder, 2026-08-10 — *"fit the
    // spoil board on the table when I select one"*.
    await expect(page.getByTestId('spoilboard-x')).not.toHaveValue('');
    await expect(page.getByTestId('spoilboard-y')).not.toHaveValue('');

    // 🔴 AND IT IS MARKED AS THIS APP'S ARITHMETIC. A fitted corner wearing a
    // human's authority is the whole failure the provenance flag exists for.
    await expect(page.getByTestId('spoilboard-assumed')).toBeVisible();
    await expect(page.getByTestId('spoilboard-entered')).toHaveCount(0);
    await expect(page.getByTestId('spoilboard-provenance')).toContainText('ASSUMED');
    await expect(page.getByTestId('spoilboard-provenance')).toHaveClass(/warnval/);

    // 🔴 THE POINT. The fit rule centres the board on the cuts, so zero past
    // the edge is very nearly guaranteed — painting it green would be the app
    // marking its own homework. Both panels have to hold the line, because an
    // operator reads whichever one is open.
    for (const id of ['spoilboard-past', 'sim-past-spoil']) {
      const cell = page.getByTestId(id);
      await expect(cell, `${id} is painted as a pass against an ASSUMED corner`).not.toHaveClass(
        /\bok\b/
      );
      await expect(cell).toHaveClass(/warnval/);
      await expect(cell).toContainText('ASSUMED');
    }
  });

  test('typing a corner makes it yours, and Re-fit hands it back to the app', async ({ page }) => {
    /*
     * ⚠ NEVER RUN. Unproven here: that `fill()` on `spoilboard-x` fires the
     * handler that flips the flag (read at `App.tsx` :3817 — the input's
     * `onChange` is what sets `entered`, so a paste or a programmatic value set
     * that skips `input` events would not flip it and the test would be
     * asserting about `fill`'s implementation rather than about the app).
     */
    await page.goto('/?fixtures=1');
    await ready(page);
    await pickOne(page, 'spoilboard-picker', '2bee-cnc-table-mdf-18');
    await expect(page.getByTestId('spoilboard-assumed')).toBeVisible();

    // assumed -> entered, on ONE field. The pair becomes yours together: a half
    // typed corner is still a corner somebody looked at.
    await page.getByTestId('spoilboard-x').fill('137');
    await expect(page.getByTestId('spoilboard-entered')).toBeVisible();
    await expect(page.getByTestId('spoilboard-assumed')).toHaveCount(0);
    await expect(page.getByTestId('spoilboard-provenance')).toContainText('entered by you');

    // ...and a measured corner with nothing past the edge IS allowed to be a
    // pass. This is the control for the assertion in the test above: without
    // it, "never green" could be satisfied by a cell that is never green.
    await expect(page.getByTestId('spoilboard-past')).not.toContainText('ASSUMED');

    // Re-fit overwrites the pair and says so by going back to ASSUMED. Leaving
    // it `entered` would launder this app's arithmetic through a flag that
    // means "a human looked".
    await page.getByTestId('spoilboard-refit').click();
    await expect(page.getByTestId('spoilboard-assumed')).toBeVisible();
    await expect(page.getByTestId('spoilboard-entered')).toHaveCount(0);
    await expect(page.getByTestId('spoilboard-x')).not.toHaveValue('137');
  });

  test('a measured 250x900 board under a 17.8mm sheet strikes past the edge', async ({ page }) => {
    /*
     * 🔴 THE NUMBER IS MEASURED, TWICE, INDEPENDENTLY — this file has three
     * tests in its history that pinned the UI's own wrong arithmetic and made
     * the correct value a regression, so a fourth is not being added.
     *
     * MEASURED HERE, through the release CLI, on the box this was written on:
     *
     *   $ cat > /tmp/spoil.json <<'EOF'
     *     {"machine":{"spoilboard":{"name":"measured 250x900","x_mm":0,"y_mm":0,
     *       "size_x_mm":250,"size_y_mm":900}},"stock":{"thickness_mm":17.8}}
     *     EOF
     *   $ ./target/release/2bee-slice job plate --config /tmp/spoil.json
     *   sim: cell=0.6mm gouge=0 uncut=0 spoilboard=2204
     *        below_sheet=over-spoilboard:0 past-spoilboard-edge:2204
     *        spoilboard-undeclared:0
     *
     * MEASURED INDEPENDENTLY by the spoilboard change itself (`043788cb09`)
     * through the browser's own wasm with the config object `App` builds:
     * *"a 17.8mm sheet on a board stopping at X250 — reports 2204 cells past
     * the edge"*. Two hosts, two paths, the same number.
     *
     * ⚠ SO A DISAGREEMENT HERE IS NOT A BROKEN TEST — it is the browser and the
     * CLI disagreeing about a safety count, which is gate `I1`'s question and a
     * finding to report rather than a number to relax. Do not "fix" this by
     * loosening it to `toBeGreaterThan(0)`; the property assertion below
     * already covers that, and the equality is what makes it a measurement.
     *
     * ⚠ NEVER RUN. Unproven here: that the browser's default machine, sheet
     * placement and operation match `job plate`'s defaults closely enough for
     * the count to be identical — which is precisely the claim, and precisely
     * what nobody has watched.
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    /* ⚠ MIGRATED 2026-08-27 — the row id is `custom`, not `__measured__`. The
     * 2026-08-20 extraction of the spoilboard id helpers (`6c9031e87b`,
     * `web/src/panels/spoilboardHelpers.ts`) renamed the sentinel when it moved
     * it. Same row, same contract: a board the shop measured and typed in. */
    await pickOne(page, 'spoilboard-picker', 'custom');
    await page.getByTestId('spoilboard-size-x').fill('250');
    await page.getByTestId('spoilboard-size-y').fill('900');
    await page.getByTestId('spoilboard-x').fill('0');
    await page.getByTestId('spoilboard-y').fill('0');
    await page.getByTestId('thickness').fill('17.8');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });

    // The property: the cutter reaches bare machine, and the app alarms.
    const past = page.getByTestId('sim-past-spoil');
    await expect(past).toHaveClass(/bad/);
    await expect(page.getByTestId('spoilboard-strike')).toBeVisible();
    await expect(page.getByTestId('spoilboard-strike')).toContainText('PAST THE EDGE');

    // The measurement, from the two runs above.
    await expect(past).toHaveText('2204');
    await expect(page.getByTestId('spoilboard-past')).toHaveText('2204');
  });

  test('the bare reach says WHICH of the two kinds of nothing it is', async ({ page }) => {
    /*
     * 🔴 `null` (no board) and `[0,0,0,0]` (the board covers everywhere the
     * cutter can go) are DIFFERENT FACTS and only the second is a covered
     * machine. These two must never render the same string, and the assertion
     * is on the STRINGS rather than on which branch was taken, because a
     * refactor that collapsed the two branches into one sentence would satisfy
     * any assertion about the branch.
     *
     * ⚠ NEVER RUN. Unproven here: that the 2bee table board reports
     * `spoilboard_bare_reach = [0,0,0,0]` on the DEFAULT machine — MEASURED
     * only as far as the commit that built it (*"the auto-fit gives the full
     * 1080x1560 rectangle with zero bare reach"*), which was on that agent's
     * machine settings and not necessarily on the ones this page opens with. If
     * this is red with non-zero strips, read the strips before changing the
     * test: they are a true answer about a board that does not cover the reach.
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    // State one: nothing declared. There is no `spoilboard-bare` cell at all —
    // the grid it lives in is only built when a board was echoed back.
    await expect(page.getByTestId('spoilboard-bare')).toHaveCount(0);
    const undeclared = (await page.getByTestId('spoilboard-status').textContent()) ?? '';

    // State two: a board that covers everything.
    await pickOne(page, 'spoilboard-picker', '2bee-cnc-table-mdf-18');
    const bare = page.getByTestId('spoilboard-bare');
    await expect(bare).toBeVisible();
    const covered = (await bare.textContent()) ?? '';

    expect(covered, 'a covered machine is reported as "not measured"').not.toContain(
      'not measured'
    );
    expect(covered).toContain('covers the whole reach');
    expect(
      undeclared.trim(),
      'the undeclared state and the fully-covered state render the same words'
    ).not.toBe(covered.trim());
  });

  test('a catalogue id nothing recognises is refused, and NO board is drawn', async ({ page }) => {
    /*
     * 🔴 WHY THIS GOES IN THROUGH THE STORE FILE. An unknown catalogue id is not
     * reachable through the picker — the picker is built FROM the catalogue, so
     * every row in it exists by construction. The id can only arrive from
     * outside: a machine saved by an older build, a machine saved on a box whose
     * catalogue has since changed, or a store file from somebody else. That is
     * the real path and it is the one driven here.
     *
     * ⚠ A RETYPED CONSTANT, FLAGGED RATHER THAN HIDDEN. `store.ts` does not
     * export `STORE_FILE_KIND`, so the string below is a copy, and a copy is a
     * thing that drifts — `persistence.spec.ts` imports `SESSION_KEY` for
     * exactly this reason. The fix is one word (`export const
     * STORE_FILE_KIND`), it is in `web/src/store.ts`, and it is not this file's
     * to make. Until then: if this test fails with *"not a 2bee.slicer store
     * file"*, the constant moved and this line is what needs updating, NOT the
     * assertion below it.
     *
     * ⚠ NEVER RUN. Unproven here: the whole file-chooser path
     * (`setInputFiles` against a hidden `input[type=file]`), that the imported
     * machine appears in `machine-picker` under the name given, and that
     * applying it sets `spoilboardId` — the restore is at `App.tsx` :3300 and
     * was read, not exercised.
     */
    await page.goto('/?fixtures=1');
    await ready(page);

    const blob = JSON.stringify({
      kind: '2bee.slicer store', // see the warning above — a COPY of store.ts's constant
      machines: [
        {
          name: 'imported-with-a-dead-board',
          saved_at: 1,
          data: {
            travelX: 600,
            travelY: 900,
            travelZ: 100,
            safeZ: 5,
            colletMm: 6,
            spindleMax: 24000,
            probeEnabled: false,
            touchPlateMm: '',
            touchPlateId: '',
            supportsArcs: true,
            // 🔴 THE POINT OF THE FIXTURE.
            spoilboardId: 'no-such-board-in-any-catalogue',
            spoilboardX: '0',
            spoilboardY: '0',
            spoilboardPos: 'entered',
          },
        },
      ],
    });

    await openSectionByTestId(page, 'panel-store');
    await page.getByTestId('store-import').setInputFiles({
      name: 'store.json',
      mimeType: 'application/json',
      buffer: Buffer.from(blob, 'utf8'),
    });

    // ⚠ MIGRATED 2026-08-11 — `saved:`. The Machine list merged the shipped
    // presets with the user's own on 2026-08-09 (TODO #61) and every row id
    // carries its surface, so an imported machine is `saved:<name>`, never the
    // bare name. The bare form matches no row and times out looking exactly like
    // an import that never landed — which is the one failure this test must be
    // able to tell apart from the refusal it is actually about.
    await pickOne(page, 'machine-picker', 'saved:imported-with-a-dead-board');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });

    // The core's own refusal, verbatim and visible — not a TypeScript
    // paraphrase of a safety message.
    await expect(page.getByTestId('spoilboard-not-installed')).toBeVisible();
    await expect(page.getByTestId('spoilboard-not-installed')).toContainText(
      'SPOILBOARD NOT INSTALLED'
    );

    // 🔴 AND NOTHING IS DRAWN FOR IT. A refused declaration that still put a
    // rectangle on the canvas would be the original defect with an error
    // message on top of it — and the error message is the part an operator
    // stops reading first.
    //
    // ⚠ GUARDED 2026-08-11, same reason as the sibling test above: the control
    // is inside `panel-spoilboard` now, and a shut section would satisfy this
    // count without anything having been checked. This test opened
    // `panel-store` a few lines up, which does NOT touch `panel-spoilboard` —
    // but the guard asserts that rather than reasoning about it.
    await expectSectionOpen(page, 'panel-spoilboard');
    await expect(
      page.getByTestId('kind-spoilboard'),
      'a board was drawn for a catalogue id the core refused'
    ).toHaveCount(0);
    await expect(page.getByTestId('spoilboard-status')).toContainText('Not declared');
    await expect(page.getByTestId('sim-past-spoil')).toHaveText('PENDING');
  });

  // =========================================================================
  //  #53 — CLAMPS LAYER SHOW/HIDE TOGGLE
  // =========================================================================
  test('the clamps layer hides and re-shows, and a hidden clamp still blocks cuts', async ({
    page,
  }) => {
    /*
     * 🔴 TODO #53. The `clamps` layer chip existed and was unguarded. This
     * test is the e2e that ticket asks for.
     *
     * What it proves, in order:
     *   (a) The `kind-clamps` chip toggles the clamps layer on and off.
     *   (b) A `clamps-hidden` warning appears on the canvas when the layer is
     *       hidden, saying the declared count is still checked.
     *   (c) The emitted G-code does NOT change — hiding is a display state
     *       and nothing about the plan, the program or the simulation is
     *       affected by it. This is the same contract `ViewportProps.layers`
     *       documents: *"Hiding a class changes the picture and never the
     *       program"*.
     *   (d) Re-showing the layer removes the warning.
     *
     * ⚠ The clamp is placed CLEAR of the work (460, 700), not on it. The
     * existing test `clamps can be added and edited by hand, and are checked`
     * already proves a clamp ON the part blocks the program. This test proves
     * the VISUAL toggle does not change the program regardless — which needs
     * a runnable baseline to compare against.
     */
    await page.goto('/?fixtures=1');
    await readyRunnable(page);

    // Open the clamps section and add a clamp.
    await openSectionByTestId(page, 'panel-clamps');
    await page.getByTestId('add-clamp').click();
    // Place clear of the work — the plate spans ~60..260 × 60..180.
    await page.getByTestId('clamp-0-x').fill('460');
    await page.getByTestId('clamp-0-y').fill('700');
    await expect(page.getByTestId('status')).toHaveText('runnable');

    // Capture the program before hiding.
    await openGcode(page);
    await page.getByTestId('toggle-gcode').click();
    const gcodeBefore = await page.getByTestId('gcode').textContent();
    expect(gcodeBefore && gcodeBefore.length).toBeGreaterThan(500);

    // The chip is present and in the "shown" state.
    const chip = page.getByTestId('kind-clamps');
    await expect(
      chip,
      'the clamps layer chip is not offered even though a clamp was declared'
    ).toHaveAttribute('aria-pressed', 'true');

    // No hidden warning yet.
    await expect(page.getByTestId('clamps-hidden')).toHaveCount(0);

    // ── HIDE ──
    await chip.click();

    // (a) The warning appears, naming the declared count and saying the check
    // still runs. These two facts are what stop the emptier picture from
    // reading as an empty machine.
    const hidden = page.getByTestId('clamps-hidden');
    await expect(hidden).toBeVisible();
    await expect(hidden).toContainText('declared and HIDDEN');
    await expect(hidden).toContainText('fixture check still runs');

    // (b) The program is UNCHANGED. Hiding is a display state — the core
    // still checks the clamp against every cut.
    await expect(page.getByTestId('status')).toHaveText('runnable');
    expect(
      await page.getByTestId('gcode').textContent(),
      'hiding the clamps layer changed the emitted program'
    ).toBe(gcodeBefore);

    // ── RE-SHOW ──
    await expect(
      chip,
      'the chip did not switch to the hidden state after clicking'
    ).toHaveAttribute('aria-pressed', 'false');
    await chip.click();

    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('clamps-hidden')).toHaveCount(0);
  });
});

/** A collapsed section keeps its contents out of the DOM entirely. */
async function openSectionByTestId(page: Page, testid: string) {
  const head = page.getByTestId(testid).locator('.panel-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

/**
 * 🔴 THE GUARD THAT KEEPS AN ABSENCE ASSERTION FROM PASSING FOR THE WRONG
 * REASON — added 2026-08-11 with the sidebar migration.
 *
 * The per-layer `kind-<layer>` controls moved from the canvas into the panel
 * that owns each layer (`5e7c3f90c8`), and **a collapsed `<Section>` renders no
 * body at all**. So from that commit onwards `expect(kind-x).toHaveCount(0)` is
 * satisfied by TWO different worlds: the layer is not offered (what the
 * assertion means) and the panel is shut (what it must never be allowed to
 * mean). Both are a count of zero and neither times out.
 *
 * Panels now also REMEMBER whether they were open (`1797927d57`,
 * `2bee.app.panels.open` in `localStorage`), so "it is open because it opens by
 * default" is a fact about a fresh profile rather than about this page. Every
 * `toHaveCount(0)` on a `kind-*` control is therefore preceded by this.
 *
 * ⚠ It asserts the HEADER's `aria-expanded`, not the presence of `.panel-body`:
 * an empty body and a closed panel are also indistinguishable by presence, and
 * the header is the thing that states the panel's own opinion of itself.
 *
 * ⚠ NEVER RUN — like everything else in this file.
 */
async function expectSectionOpen(page: Page, testid: string) {
  await expect(
    page.getByTestId(testid).locator('.panel-head'),
    `${testid} is collapsed, so an absence assertion inside it proves nothing`
  ).toHaveAttribute('aria-expanded', 'true');
}

// ── I7: Theme from brand/tokens.css ─────────────────────────────────────

test('brand tokens are loaded — CSS custom properties are set', async ({ page }) => {
  await page.goto('/');
  await panelsReady(page);
  // Check that brand tokens are applied by reading CSS custom properties.
  // If the @import failed, these would be empty or the fallback value.
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  );
  const ink = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
  );
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  );
  // These should be non-empty hex/rgb values, not empty strings.
  expect(bg).toBeTruthy();
  expect(ink).toBeTruthy();
  expect(accent).toBeTruthy();
  // The values should differ — a theme where bg === ink is broken.
  expect(bg).not.toBe(ink);
});

test('theme toggle switches between light and dark', async ({ page }) => {
  await page.goto('/');
  await panelsReady(page);
  // Read the initial background
  const initialBg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  );
  /* 🔴 THE TOGGLE MUST EXIST — this was `if (await toggle.count() > 0) { … }`,
   * so removing the control made the test pass by doing nothing. A test whose
   * whole body is optional is a green that says the feature is absent. */
  const toggle = page.getByTestId('theme-toggle');
  await expect(
    toggle,
    'the theme toggle is gone. This test used to skip its own body when that happened, which ' +
      'reported a green for a missing control.',
  ).toHaveCount(1);

  await toggle.click();
  await page.waitForTimeout(300);
  const newBg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  );
  // The background must change after toggling — and it must be a REAL value on
  // both sides, because an empty string differs from an empty string's
  // predecessor only when one of them is a colour.
  expect(initialBg.length, 'the page defined no --bg before the toggle was clicked').toBeGreaterThan(0);
  expect(newBg.length, 'the page defined no --bg after the toggle was clicked').toBeGreaterThan(0);
  expect(newBg).not.toBe(initialBg);
});

// ── J2: Download filename ──────────────────────────────────────────────────

test('the .nc download button is enabled when a report exists', async ({ page }) => {
  await page.goto('/?fixtures=1');
  await readyRunnable(page);
  await expect(page.getByTestId('status')).toHaveText('runnable');
  // Open the G-code section (collapsed by default) by clicking its header
  const gcodeSection = page.getByTestId('panel-gcode');
  const header = gcodeSection.locator('.panel-head');
  if (await header.getAttribute('aria-expanded') !== 'true') {
    await header.click();
    await page.waitForTimeout(300);
  }
  // The download button should be enabled when a report exists
  const btn = page.getByTestId('download');
  await expect(btn).toBeEnabled();
});

// ── B5: Rendered stock box matches the numbers ─────────────────────────────

test('the rendered stock box matches the stock numbers', async ({ page }) => {
  /*
   * 🔴 REWRITTEN 2026-08-28. What stood here asserted that
   * `data-stock-xy` was non-empty and CONTAINED THE WORD `datum` — a string
   * this component writes unconditionally, so the test passed for any sheet at
   * any position, including none. It could not fail while the attribute
   * existed.
   *
   * `Viewport.tsx` says what to do with the attribute, beside the line that
   * writes it: it publishes TWO independently derived numbers — `datum`, which
   * is `props.stockOrigin` as this build received it, and `at`, taken from the
   * drawn mesh's own world box — and there are THREE values to line up, the
   * third being the panel's `origin-x`/`origin-y`. Panel vs datum is "did the
   * state reach the viewport"; datum vs at is "did the picture follow it".
   *
   * ⚠ AND IT WARNS, in the same comment, that **at a datum of 0,0 all three
   * read zero and the pair proves nothing**. The old test read the default
   * position, which is exactly that case. So this one MOVES the sheet first.
   */
  await page.goto('/?fixtures=1');
  await readyRunnable(page);
  await expect(page.getByTestId('status')).toHaveText('runnable');

  const read = async () => {
    const raw = await page.evaluate(
      () => document.querySelector('canvas[data-stock-xy]')?.getAttribute('data-stock-xy') ?? '',
    );
    const m = /^datum (-?[\d.]+),(-?[\d.]+) at (-?[\d.]+),(-?[\d.]+)$/.exec(raw);
    expect(m, `the viewport published no readable stock position: ${JSON.stringify(raw)}`).not.toBeNull();
    return {
      raw,
      datum: [Number(m![1]), Number(m![2])] as const,
      at: [Number(m![3]), Number(m![4])] as const,
    };
  };

  // Away from the origin, so a zero cannot answer for a value that never arrived.
  await page.getByTestId('origin-x').fill('40');
  await page.getByTestId('origin-y').fill('25');
  await expect(page.getByTestId('status')).toHaveText('runnable');

  const panelX = Number(await page.getByTestId('origin-x').inputValue());
  const panelY = Number(await page.getByTestId('origin-y').inputValue());
  const s = await read();

  // Limb 1 — the state reached the viewport.
  expect(
    s.datum[0],
    `the panel says datum X ${panelX} and the viewport was built with ${s.datum[0]} — the number ` +
      `the operator typed did not reach the picture (${s.raw})`,
  ).toBeCloseTo(panelX, 2);
  expect(s.datum[1], `datum Y: panel ${panelY}, viewport ${s.datum[1]} (${s.raw})`).toBeCloseTo(panelY, 2);

  // Limb 2 — the picture followed it. Independent derivation: `at` comes from
  // the drawn mesh's own world box, not from the arithmetic that placed it.
  expect(
    s.at[0],
    `the sheet was placed at datum X ${s.datum[0]} and the DRAWN box starts at ${s.at[0]} — the ` +
      `picture and the numbers disagree (${s.raw})`,
  ).toBeCloseTo(s.datum[0], 2);
  expect(s.at[1], `drawn Y vs datum Y (${s.raw})`).toBeCloseTo(s.datum[1], 2);
});
