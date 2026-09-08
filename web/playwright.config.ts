import { defineConfig, devices } from '@playwright/test';

/*
 * =============================================================================
 * 🔴 WebGL ON THIS BOX WAS BLOCKLISTED, NOT MISSING. THE FLAGS BELOW ARE THE FIX.
 * =============================================================================
 *
 * The line this replaces read `--use-gl=swiftshader --enable-unsafe-swiftshader`
 * and carried the comment *"a headless run without a GPU falls back to
 * swiftshader, which renders correctly but slowly"*. **Every clause of that was
 * wrong.** There IS a GPU (an RTX 4090), swiftshader does not render slowly here
 * — it does not produce a context AT ALL — and the fallback was not a fallback,
 * it was this config asking for software rasterisation by name.
 *
 * Three agents tested swiftshader, all got `null`, and all concluded the box had
 * no usable GPU. **Their converging result was consistent with the GPU being
 * fine**, because they were converging on the wrong flag family.
 *
 * MEASURED 2026-08-12, four launches through `chromium.launch()` at Playwright
 * 1.62.1, reading `WEBGL_debug_renderer_info` → `UNMASKED_RENDERER_WEBGL`:
 *
 *   no gl flags at all                    → getContext returns null
 *   --use-gl=swiftshader                  → getContext returns null
 *   --use-gl=angle --use-angle=swiftshader→ getContext returns null
 *   --use-gl=angle --use-angle=gl-egl     → ANGLE (NVIDIA Corporation,
 *                                            NVIDIA GeForce RTX 4090/PCIe/SSE2,
 *                                            OpenGL ES 3.2)
 *
 * ⚠ `--ignore-gpu-blocklist` is NOT the load-bearing flag — `gl-egl` works with
 * and without it (measured, case H). It is kept because it is part of the flag
 * set `ceo` verified end-to-end, and dropping a flag from a verified set to make
 * a tidier line is how a working configuration becomes an untested one. If it is
 * ever removed, re-run the probe rather than reasoning about it.
 *
 * ⚠ NO X DISPLAY IS TAKEN, AND THAT IS DELIBERATE (FLEET_RULES §213). Every
 * result above is headless: `xvfb` is already on `:87`, `:99`, `:100` and `:101`
 * and this suite claims none of them, because ANGLE's EGL backend talks to the
 * driver directly and needs no server. A slot named in writing and then not used
 * is still a slot somebody else could not have.
 */

/** Real hardware. The flags that made 17 quarantined tests runnable. */
const GPU_ARGS = [
  '--no-sandbox',
  '--enable-gpu',
  '--use-gl=angle',
  '--use-angle=gl-egl',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
];

/**
 * The NEGATIVE CONTROL for the flags above, and nothing else.
 *
 *   E2E_GL_PLANT=swiftshader npx playwright test e2e/webgl.spec.ts
 *
 * must go RED. This is the lane's `--plant` convention applied to the harness:
 * a configuration nobody has watched fail is not a configuration.
 */
const SWIFTSHADER_ARGS = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'];

/**
 * Ports, overridable — see the concurrency note on `webServer` below.
 * Defaults are the historical 4173 / 5179 so an unqualified run is unchanged.
 */
const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4173);
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5179);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  // ─────────────────────────────────────────────────────────────────────────
  // 🔴 ONE WORKER, AND IT IS A CORRECTNESS SETTING, NOT A SPEED ONE.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // `fullyParallel: false` only serialises tests WITHIN a file. Playwright still
  // runs FILES across `cpus/2` workers, and every one of them drives the SAME
  // preview server on the SAME origin. Measured 2026-08-27, one tree, one commit,
  // back to back:
  //
  //     default workers   20 failed / 95
  //     --workers=1       12 failed / 95
  //     slicer.spec.ts:847 alone                     PASSES
  //     the same import against a standalone preview  status: runnable
  //
  // EIGHT REDS WERE THE RUN'S OWN CONCURRENCY. They are not in the product and
  // not in the tests, and while they are there **gate I1's red count is not a
  // defect count** — which is worse than the flakes, because it makes the twelve
  // real failures unfindable inside twenty. A suite whose result depends on how
  // many cores the box had is not a gate; it is a coin weighted by load, and
  // this box runs a five-session fleet.
  //
  // ⚠ WHAT THIS DOES NOT FIX, SAID RATHER THAN IMPLIED. The shared state that
  // makes concurrent contexts disagree HAS NOT BEEN FOUND — this pins the
  // suite to the configuration where the question does not arise. So: **the app
  // is not known to survive N concurrent sessions against one origin, and after
  // this change nothing in the suite will ever ask.** That is a real coverage
  // hole, it is bought deliberately in exchange for a readable red, and it is
  // named here because a setting that quietly removes a question reads as a
  // setting that answered it. Overridable with `E2E_WORKERS` for anyone hunting
  // it: `E2E_WORKERS=4 npx playwright test` restores the old behaviour.
  workers: Number(process.env.E2E_WORKERS ?? 1),
  reporter: [['list']],
  // Artefacts are overridable so two lanes cannot overwrite each other's traces
  // and screenshots. A shared `test-results/` is why one run's failure evidence
  // was attributable to nobody.
  outputDir: process.env.E2E_OUTPUT_DIR ?? 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    trace: 'retain-on-failure',
    // 🔴 HEADLESS, STATED EXPLICITLY. It was never set, and the founder watched
    // Chromium windows open on his desktop while agents ran this suite — a test
    // run should not take over the machine somebody is working on. Relying on
    // the default was not enough: whatever this Playwright version does by
    // default, a live browser was measured with no `--headless` in its argv.
    // An unstated default is a setting nobody chose.
    //
    // ⚠ Headless does NOT mean software-rendered here. Playwright 1.62 launches
    // `chromium-headless-shell` for `headless: true`, and the shell reaches the
    // 4090 through ANGLE/EGL exactly as the full browser does — measured both
    // ways (cases A and B of the probe), identical unmasked renderer string. No
    // `channel: 'chromium'` is needed and none is set.
    headless: true,
    launchOptions: {
      args: process.env.E2E_GL_PLANT === 'swiftshader' ? SWIFTSHADER_ARGS : GPU_ARGS,
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // TWO servers, deliberately.
  //
  // 🔴 The suite used to run against `preview` alone — the BUILT app. That is
  // the right thing to gate on, and it is not the thing a developer opens. The
  // wasm glue sat in `public/`, which a production build copies verbatim and
  // `vite dev` refuses to serve to an importing module: `npm run dev` returned
  // a 500 and the app reported "The CAM core did not load", while all 16 tests
  // stayed green. **A suite that only ever sees one of the two servers cannot
  // see a defect that lives in the other.**
  //
  // The dev server runs on 5179, NOT the configured 5178, so a run does not
  // fight a dev server someone already has open.
  //
  // ---------------------------------------------------------------------------
  // 🔴 `--strictPort` ON BOTH SERVERS, AND IT IS A CORRECTNESS FIX, NOT TIDYING.
  // ---------------------------------------------------------------------------
  //
  // `vite preview` without it SILENTLY PICKS THE NEXT FREE PORT. So when another
  // lane already held 4173, this run's own server quietly moved to 4174 while
  // Playwright's `url` check — and every `baseURL` navigation after it — went to
  // 4173 and was served THE OTHER LANE'S BUNDLE. The suite goes green or red
  // against an artefact this run never built, and the result is attributable to
  // nobody. That happened. With `--strictPort` the server dies loudly instead,
  // which is a failure you can read.
  //
  // The ports are env-overridable (`E2E_PREVIEW_PORT` / `E2E_DEV_PORT`) so two
  // lanes CAN run at once by choosing different ones, rather than by hoping.
  webServer: [
    {
      // 🔴 `vite build`, NOT `npm run build`, and the difference is deliberate.
      //
      // `14925b910a` chained `typecheck` into `build` — correctly: `tsc --noEmit`
      // had been reading 40 of 95 files, so every "tsc is clean" in this repo meant
      // *src* is clean. That check belongs on the command people type.
      //
      // ⚠ But `webServer` runs on EVERY e2e invocation, and this is a shared tree
      // with several lanes editing at once. Chaining typecheck here made **one
      // lane's in-flight type error a precondition for a different lane's suite** —
      // measured at ~40 minutes lost across four attempts, in files the runner did
      // not own. Two agents then independently wrote the same bypass config on the
      // same evening. 🔴 *Two people inventing the same workaround is the signal
      // that the constraint is wrong, not that they were careless.*
      //
      // What this does NOT do: weaken the type check. `npm run build` still runs it,
      // and `web/tests/typecheck-coverage.test.ts` still fails if the config narrows.
      // e2e tests the BUNDLE, which is what `vite build` produces and what the
      // browser actually loads — the same artefact it tested before that commit.
      //
      // ⚠ `npx vite preview`, not `npm run preview`, for one reason only: the
      // npm script hardcodes `--port 4173` and cannot take `--strictPort`
      // without editing `package.json`, which is not this lane's file. Same
      // binary, same artefact, one flag more.
      // ⚠ THE CATALOGUE IS GENERATED FIRST, and it has to be. `public/shop/` is
      // written by `scripts/build-shop-catalogue.ts` and is NOT in git, while
      // `vite build` only COPIES `public/` — so a fresh tree would serve a
      // Designs tab that correctly reports "the catalogue has not been built",
      // and `shop.spec.ts` would go red for a missing build step rather than a
      // defect. A false red on a shared tree costs more than the ~35s this adds.
      // Deliberately still NOT `npm run build`: that chains `typecheck`, which
      // is the coupling the note above removed on purpose.
      command:
        `node --import ./tests/register.mjs scripts/build-shop-catalogue.ts` +
        ` && npx vite build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      // 🔴 Auth is BLANKED for e2e (both servers). `web/.env` carries the real
      // Cognito triple since 08-21, and Vite bakes it into the bundle — so the
      // suite found itself behind a closed AuthGate with no Cognito to log in
      // through, and every test died at `ready()` on "Admin access required"
      // (measured 2026-08-23: I1 red, trace.zip tail). The e2e suite tests the
      // CAM, and the CAM's precondition is a deterministic app, not a live
      // identity provider. ⚠ The other half of that sentence: NOTHING covers
      // the gate itself — no e2e and no node test touches AuthGate, so a broken
      // login ships green. That is a named hole, not an oversight.
      env: {
        ...process.env,
        VITE_COGNITO_DOMAIN: '',
        VITE_COGNITO_CLIENT_ID: '',
        VITE_COGNITO_REDIRECT_URI: '',
      },
    },
    {
      command: `npm run dev -- --port ${DEV_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEV_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...process.env,
        VITE_COGNITO_DOMAIN: '',
        VITE_COGNITO_CLIENT_ID: '',
        VITE_COGNITO_REDIRECT_URI: '',
      },
    },
  ],
});
