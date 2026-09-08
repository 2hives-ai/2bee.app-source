import { expect, test } from '@playwright/test';
import { seedTab } from './tab';

/* The landing tab is Designs; this suite is about the CNC tab. See e2e/tab.ts. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

/**
 * =============================================================================
 * THE HARNESS CHECKING ITSELF: is this browser actually on the GPU?
 * =============================================================================
 *
 * Every other spec in this directory assumes an accelerated context and says
 * nothing when it does not get one — it times out waiting for a canvas
 * attribute, or three.js throws, and the failure reads as a product defect. So
 * this file asks the question once, first, and in a form that can be wrong.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE PARAMETER MATTERS MORE THAN THE ANSWER.
 * ---------------------------------------------------------------------------
 *
 * `ops` reported `gl.getParameter(gl.VENDOR)` → `"WebKit WebGL"` as evidence
 * that WebGL worked. **That string is Chrome's MASKED vendor and is returned
 * under software rasterisation too.** It proves a context was created. It says
 * nothing whatsoever about what is drawing. A green on `VENDOR` would have been
 * a green that meant nothing — and this suite would have inherited it.
 *
 * The only parameter that discriminates hardware from a software rasteriser is
 * `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL`. That is what is
 * asserted below, and `assertsTheUselessOnesAreUseless` exists to keep the
 * reason visible rather than filed in a commit message nobody re-reads.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS — BOTH OF THEM, BECAUSE ONE IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * A plant that fires is not a plant that fires FOR THE REASON YOU THINK. These
 * two bite at different points on purpose:
 *
 *   1. E2E_GL_PLANT=swiftshader   npx playwright test e2e/webgl.spec.ts
 *      Swaps the launch flags for software rasterisation. On THIS box that does
 *      not merely give a slow context, it gives NO context — so this plant kills
 *      the test at `getContext`, one step BEFORE the renderer string is ever
 *      read. It proves the flags are load-bearing. It does NOT prove the
 *      assertion discriminates, and reporting it as if it did would be exactly
 *      the mistake this file was written to stop.
 *
 *   2. E2E_GL_PLANT=spoof-renderer npx playwright test e2e/webgl.spec.ts
 *      Leaves the real accelerated context in place and rewrites ONLY the
 *      unmasked renderer string to a SwiftShader one, in the page, before any
 *      app code runs. Masked `VENDOR`/`RENDERER` stay exactly as Chrome reports
 *      them. 🔴 **This is the plant that matters**: it reproduces the precise
 *      state `ops`'s check could not tell apart — a context that exists, reports
 *      `"WebKit WebGL"`, and is not on the GPU — and the assertion must still go
 *      red. If this one ever passes, the check has silently become the check we
 *      already knew was worthless.
 *
 * Neither plant may be left set in a real run. They are read from the
 * environment, so a stray export is invisible in the diff — which is why the
 * first test below FAILS LOUDLY when a plant is active but the run was not
 * scoped to this file.
 */

/** Renderer strings that mean "no GPU is involved", however they arrive. */
const SOFTWARE_RASTERISERS = /swiftshader|llvmpipe|softpipe|mesa offscreen|generic renderer|disabled/i;

type GlProbe = {
  ctx: boolean;
  contextError?: string;
  vendor?: string;
  renderer?: string;
  debugExtension?: boolean;
  unmaskedVendor?: string | null;
  unmaskedRenderer?: string | null;
};

/**
 * Read the four strings in one page evaluation.
 *
 * ⚠ Deliberately NOT reading them through `Viewport.tsx` or any product code.
 * This asks what the BROWSER can do; if it went through the app, an app defect
 * and an environment defect would arrive as the same failure — which is the
 * confusion that produced the 17-test quarantine in the first place.
 */
async function probe(page: import('@playwright/test').Page): Promise<GlProbe> {
  await page.goto('about:blank');
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    let contextError: string | undefined;
    try {
      gl = (canvas.getContext('webgl2') ??
        canvas.getContext('webgl')) as WebGL2RenderingContext | null;
    } catch (e) {
      contextError = String(e);
    }
    if (!gl) return { ctx: false, contextError };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ctx: true,
      vendor: String(gl.getParameter(gl.VENDOR)),
      renderer: String(gl.getParameter(gl.RENDERER)),
      debugExtension: Boolean(dbg),
      unmaskedVendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
      unmaskedRenderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
    };
  });
}

test.describe('the browser this suite runs in', () => {
  test.beforeEach(async ({ page }) => {
    if (process.env.E2E_GL_PLANT !== 'spoof-renderer') return;
    /*
     * PLANT 2. Patch `getParameter` so the UNMASKED renderer — and only that —
     * lies. Everything else about the context stays real: it is still the 4090
     * drawing, `VENDOR` still returns `"WebKit"`, `RENDERER` still returns
     * `"WebKit WebGL"`. If the assertion below is reading the right parameter
     * this must go red; if it is reading VENDOR, it goes green and tells us the
     * check is the one `ops` already had.
     */
    await page.addInitScript(() => {
      const LIE = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)';
      for (const proto of [
        (globalThis as never as { WebGLRenderingContext?: { prototype: WebGLRenderingContext } })
          .WebGLRenderingContext?.prototype,
        (globalThis as never as { WebGL2RenderingContext?: { prototype: WebGL2RenderingContext } })
          .WebGL2RenderingContext?.prototype,
      ]) {
        if (!proto) continue;
        const original = proto.getParameter;
        proto.getParameter = function (pname: number) {
          // 0x9246 === UNMASKED_RENDERER_WEBGL, the one parameter that tells the truth.
          if (pname === 0x9246) return LIE;
          return original.call(this, pname);
        };
      }
    });
  });

  test('no GL plant is active unless this file was run on purpose', async () => {
    const plant = process.env.E2E_GL_PLANT;
    if (!plant) return;
    /*
     * A plant lives in the environment, so it leaves no diff and no artefact. A
     * full suite run with one still exported would report a page of failures
     * with an environmental cause nobody could see. Fail here, first, with the
     * cause named — rather than let it be discovered downstream as 80 red tests.
     */
    expect(
      ['swiftshader', 'spoof-renderer'],
      `E2E_GL_PLANT=${plant} is not a plant this file defines`
    ).toContain(plant);
    throw new Error(
      `E2E_GL_PLANT=${plant} is active. This is a NEGATIVE CONTROL and every ` +
        `WebGL assertion in this run is expected to be red. If you did not mean ` +
        `to plant, unset E2E_GL_PLANT and re-run.`
    );
  });

  test('runs WebGL on real GPU hardware, not a software rasteriser', async ({ page }) => {
    const gl = await probe(page);

    // (1) A context at all. This is the step the `swiftshader` plant kills, and
    //     it is reported separately so that plant cannot be mistaken for proof
    //     that the renderer-string assertion works.
    expect(
      gl.ctx,
      `no WebGL context: ${gl.contextError ?? 'getContext returned null'}\n` +
        `The launch flags in playwright.config.ts are the first thing to check.`
    ).toBe(true);

    // (2) The debug extension. Without it there is NO way to tell hardware from
    //     software, so its absence is a failure of this check, never a pass.
    //     🔴 A check that cannot run reports PENDING, never PASS — and in a test
    //     the only honest rendering of PENDING is red.
    expect(
      gl.debugExtension,
      'WEBGL_debug_renderer_info is unavailable, so acceleration CANNOT be ' +
        'determined from this browser. Not a pass.'
    ).toBe(true);

    // (3) THE DISCRIMINATOR. Not VENDOR. Not RENDERER.
    const unmasked = gl.unmaskedRenderer ?? '';
    expect(
      unmasked,
      `UNMASKED_RENDERER_WEBGL = ${JSON.stringify(unmasked)} is a software ` +
        `rasteriser. Masked VENDOR/RENDERER were ${JSON.stringify(gl.vendor)} / ` +
        `${JSON.stringify(gl.renderer)} — which is what they say on the GPU too.`
    ).not.toMatch(SOFTWARE_RASTERISERS);

    // (4) ...and positively: it names a real device. `not swiftshader` alone is
    //     satisfied by an empty string, which is how an absent value passes a
    //     negative assertion.
    expect(unmasked.length, 'UNMASKED_RENDERER_WEBGL is empty').toBeGreaterThan(0);
    expect(
      unmasked,
      `UNMASKED_RENDERER_WEBGL = ${JSON.stringify(unmasked)} names no GPU vendor`
    ).toMatch(/nvidia|amd|radeon|intel|apple|mali|adreno/i);
  });

  test('the parameters ops cited cannot answer the question, and this pins why', async ({
    page,
  }) => {
    const gl = await probe(page);
    test.skip(!gl.ctx, 'no context — covered by the test above');

    /*
     * The claim: masked `VENDOR` and `RENDERER` are constants Chrome substitutes
     * for fingerprinting reasons, identical on hardware and on swiftshader.
     *
     * ⚠ Asserted as "does not name the device", NOT as the literal strings
     * `"WebKit"` / `"WebKit WebGL"`. Pinning the literals would make this file go
     * red on a Chrome release that changes the placeholder — a false red about
     * nothing, on a check whose whole purpose is to stop false greens. What must
     * hold is the PROPERTY: whatever those two say, it is not the GPU.
     */
    expect(
      gl.renderer,
      `masked RENDERER (${JSON.stringify(gl.renderer)}) now names the device — ` +
        `if Chrome has stopped masking it, the reasoning in this file's header ` +
        `is stale and the check should be re-derived rather than relaxed`
    ).not.toMatch(/nvidia|geforce|radeon|swiftshader|llvmpipe/i);
    expect(gl.vendor).not.toMatch(/nvidia|geforce|radeon|swiftshader|llvmpipe/i);

    // And the pair that proves they cannot discriminate: masked says nothing,
    // unmasked says everything, in the SAME context, in the same breath.
    expect(gl.unmaskedRenderer).not.toEqual(gl.renderer);
  });

  test('a WebGL context survives inside the app, not only on a bare canvas', async ({ page }) => {
    /*
     * The probe above uses `about:blank` on purpose. This one does not: a
     * context on a bare canvas and a context three.js can keep are different
     * facts, and only the second is what the 17 quarantined tests need.
     *
     * ⚠ This asserts the ABSENCE of the three.js failure line, which is a weaker
     * claim than "the viewport renders". What the viewport actually draws is
     * asserted by the viewport tests in `slicer.spec.ts` and `tabs.spec.ts`;
     * duplicating that here would be a second copy of a check with a first copy
     * already in place. *(They were the `@needs-gpu` set; that tag was stripped
     * on 2026-08-12 — see the banner in `slicer.spec.ts` — so they are named by
     * where they live, which is the only handle that still resolves.)*
     */
    const glErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && /webgl/i.test(m.text())) glErrors.push(m.text());
    });
    // ⚠ `?fixtures=1`, not a bare `/`. `data-testid="status"` is inside the
    // report, and a bare app has no drawing, so no report, so no status — a
    // first draft of this test waited 30s for an element the app was correct not
    // to render. `slicer.spec.ts`'s `ready()` opens fixtures for the same reason.
    await page.goto('/?fixtures=1');
    await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
    expect(glErrors, `WebGL errors on the console:\n${glErrors.join('\n')}`).toEqual([]);
  });
});

/**
 * =============================================================================
 * THE BLANK-APP GUARD — the class of defect e2e is the ONLY instrument for
 * =============================================================================
 *
 * `71e5092bb3`: a `const` referenced from inside a `useMemo` that runs during
 * render, i.e. read in its temporal dead zone. The app was BLANK IN EVERY
 * BROWSER for hours.
 *
 *   · `tsc` could not see it — the reference is inside a closure, and TDZ is a
 *     runtime property, not a type one.
 *   · ~1096 node tests were green over it, because `renderToStaticMarkup` in
 *     `web/tests/**` does not run effects and nothing on this box renders a
 *     component tree into a live DOM.
 *
 * The same commit's report records a second the same hour: a component rendered
 * inside its own branch — infinite recursion — also green everywhere else.
 *
 * 🔴 SO STATE IT PLAINLY: nothing but `web/e2e/**` can catch this class, and
 * until today `web/e2e/**` could not run. Both defects reached the founder
 * because the one instrument that renders anything was disabled by four
 * characters of launch flag.
 *
 * These two tests are deliberately DUMB and deliberately UNTAGGED. They need no
 * GPU, they assert nothing about CAM, and they exist so that "the app mounts at
 * all" is a named check with a title, instead of a property inferred from 80
 * other tests happening to pass.
 */
test.describe('the app mounts', () => {
  test('renders a non-empty document rather than a blank page', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto('/');

    // The failure mode is literally zero characters — React unmounts the whole
    // tree when an effect or a render throws. Assert against that, not against
    // any particular panel, so a redesign cannot quietly retire the guard.
    await expect
      .poll(async () => (await page.locator('body').innerText()).trim().length, {
        timeout: 30_000,
        message: 'the document body is empty — the tree did not mount',
      })
      .toBeGreaterThan(0);

    // A render-phase throw shows up here and nowhere else in this repo.
    expect(
      pageErrors,
      `uncaught errors during render:\n${pageErrors.join('\n')}`
    ).toEqual([]);

    // And the positive: a control that only exists once the app has committed.
    // Absence of an error is not presence of an app.
    await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 30_000 });
  });

  test('renders under vite dev too, where the module graph is different', async ({ page }) => {
    /*
     * The preview server serves a bundle; the dev server serves the module graph.
     * A TDZ fault is present in both, but a circular import that Rollup hoists
     * into working order is not — and `dev-server.spec.ts` asks its own,
     * narrower question (does the wasm glue resolve) and, while the swiftshader
     * flags stood, could not reach it — three WebGL console lines fired before
     * any module-resolution failure could. *(It carried `@needs-gpu` for that;
     * the tag was stripped on 2026-08-12 and the test passes.)*
     */
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`http://127.0.0.1:${process.env.E2E_DEV_PORT ?? 5179}`);

    await expect
      .poll(async () => (await page.locator('body').innerText()).trim().length, {
        timeout: 30_000,
        message: 'the document body is empty under vite dev',
      })
      .toBeGreaterThan(0);
    expect(
      pageErrors,
      `uncaught errors during render under vite dev:\n${pageErrors.join('\n')}`
    ).toEqual([]);
  });
});
