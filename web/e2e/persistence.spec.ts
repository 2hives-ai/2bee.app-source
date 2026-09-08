/*
 * The working setup survives a refresh — and says so.
 *
 * Founder, 2026-08-09: *"When I refresh the browser all config should stay!"*
 *
 * 🔴 WHY THIS IS ITS OWN SPEC FILE AND NOT THREE ROWS IN `slicer.spec.ts`.
 * Every other test in this suite asserts what ONE page load does. These assert
 * what SURVIVES BETWEEN two of them, which needs `page.reload()` in the middle
 * and a deliberately seeded `localStorage` in front — a different shape, and one
 * that is easy to write in a way that proves nothing.
 *
 * 🔴 THE FAILURE MODE THESE TESTS ARE BUILT AGAINST, stated first because it is
 * the one that produces a green test over a dead feature: **an app that restores
 * nothing still passes a persistence test whose expected values are the
 * defaults.** So every value driven in below is chosen to differ from the
 * default, the default is named beside it in a comment, and the plant run
 * recorded in the handover disables the restore entirely and watches all three
 * tests go red. A persistence assertion that cannot tell "restored" from
 * "never changed" is not a persistence assertion.
 *
 * 🔴 AND ONE TEST ASSERTS THE EMITTED PROGRAM, not the input box. This lane's
 * standing rule is to assert on the artefact rather than the setting that was
 * supposed to produce it — a restored `rpm` that reaches the number input and
 * not the planner is a control that is green about the intent. `S15500` in the
 * posted G-code after a reload is the only form of that claim worth making.
 */
import { expect, test, type Page } from '@playwright/test';
import { seedTab } from './tab';
import { SESSION_KEY, SESSION_VERSION } from '../src/store';

/* The landing tab is Designs; this suite is about the CNC tab. See e2e/tab.ts. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

/** Wait for the first plan to land, so assertions are not racing the WASM load. */
async function ready(page: Page) {
  await expect(page.getByTestId('status')).toBeVisible({ timeout: 30_000 });
}

/**
 * The side panels are live before anything is planned. Used by the tests that
 * only need CONTROLS: with the probe on and no plate declared the app
 * deliberately refuses to post, so there is no `status` to wait for, and
 * waiting for one would read as a broken app rather than as a refusing one.
 */
async function panelsReady(page: Page) {
  await expect(page.getByTestId('tool-picker-trigger')).toContainText(
    'End Mill - Down-cut 6mm 2F',
    { timeout: 30_000 }
  );
}

/** A collapsed section keeps its contents out of the DOM entirely. */
async function openSection(page: Page, testid: string) {
  const head = page.getByTestId(testid).locator('.panel-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
}

/**
 * Wait for the app to have actually WRITTEN the setup before reloading.
 *
 * 🔴 Without this the test is a race it would usually win, and losing it once in
 * CI would look like a persistence bug rather than a test bug. It polls the real
 * key — imported from `store.ts`, not retyped here, so a rename breaks the test
 * instead of silently making it assert about a key nobody writes.
 */
async function savedContains(page: Page, fragment: string) {
  await expect
    .poll(async () => page.evaluate((k) => localStorage.getItem(k) ?? '', SESSION_KEY), {
      timeout: 10_000,
    })
    .toContain(fragment);
}

/** Seed a stored blob before any app code runs. */
async function seed(page: Page, blob: unknown) {
  await page.addInitScript(
    ([k, text]) => window.localStorage.setItem(k as string, text as string),
    [SESSION_KEY, JSON.stringify(blob)] as const
  );
}

test.describe('the working setup survives a refresh', () => {
  test('settings set by hand come back after a reload, and the bed confirmation does not', async ({
    page,
  }) => {
    await page.goto('/?fixtures=1');
    await panelsReady(page);

    /* Every value here DIFFERS FROM THE DEFAULT, and the default is named.
     * That is the whole reason this test can distinguish a restore from an app
     * that stored nothing and re-opened on its opening state. */
    await page.getByTestId('travel-x').fill('1150'); // default 600
    await page.getByTestId('travel-y').fill('1050'); // default 900
    await page.getByTestId('thickness').fill('12.5'); // default 18
    await page.getByTestId('origin-x').fill('25'); // default 0
    await page.getByTestId('origin-y').fill('15'); // default 0
    await page.getByTestId('depth-per-pass').fill('2.5'); // default 4
    await page.getByTestId('rpm').fill('15500'); // default 18000
    await page.getByTestId('lead').fill('2'); // default 0
    await page.getByTestId('entry').selectOption('Plunge'); // default Ramp
    await page.getByTestId('direction').selectOption('Conventional'); // default Climb
    await page.getByTestId('dogbone').selectOption('TBoneX'); // default Corner
    await page.getByTestId('stock-rotation').selectOption('90'); // default 0
    await page.getByTestId('tabs-enabled').uncheck(); // default checked
    await page.getByTestId('z-zero-top').uncheck(); // default checked
    await page.getByTestId('probe-after-change').uncheck(); // default checked

    /* The probe pair, together, because they are the one place an empty string
     * and a zero mean different things and the round trip has to keep them
     * different. `probe-enabled` defaults to OFF; `0` is a DECLARED "no plate,
     * I am probing the workpiece directly", which is not the same fact as the
     * blank the app opens with. A restore that collapsed `'0'` to `''` would
     * turn a measurement into a silence, and vice versa. */
    await page.getByTestId('probe-enabled').check(); // default unchecked
    await page.getByTestId('touch-plate-mm').fill('0'); // default '' (undeclared)

    await openSection(page, 'panel-verify');
    await page.getByTestId('sim-cell').fill('1.5'); // default 0.6

    // A clamp: the geometry gate P7 checks a toolpath against.
    await page.getByTestId('add-clamp').click();
    await page.getByTestId('clamp-0-height_mm').fill('27'); // the generic clamp is 35

    // And the attestation, ticked ON PURPOSE so the reload can prove it is the
    // one thing that does NOT come back.
    await page.getByTestId('confirmed-clear').check();

    await savedContains(page, '"rpm":15500');

    await page.reload();
    await panelsReady(page);

    await expect(page.getByTestId('travel-x')).toHaveValue('1150');
    await expect(page.getByTestId('travel-y')).toHaveValue('1050');
    await expect(page.getByTestId('thickness')).toHaveValue('12.5');
    await expect(page.getByTestId('origin-x')).toHaveValue('25');
    await expect(page.getByTestId('origin-y')).toHaveValue('15');
    await expect(page.getByTestId('depth-per-pass')).toHaveValue('2.5');
    await expect(page.getByTestId('rpm')).toHaveValue('15500');
    await expect(page.getByTestId('lead')).toHaveValue('2');
    await expect(page.getByTestId('entry')).toHaveValue('Plunge');
    await expect(page.getByTestId('direction')).toHaveValue('Conventional');
    await expect(page.getByTestId('dogbone')).toHaveValue('TBoneX');
    await expect(page.getByTestId('stock-rotation')).toHaveValue('90');
    await expect(page.getByTestId('tabs-enabled')).not.toBeChecked();
    await expect(page.getByTestId('z-zero-top')).not.toBeChecked();
    await expect(page.getByTestId('probe-after-change')).not.toBeChecked();
    await expect(page.getByTestId('probe-enabled')).toBeChecked();
    // 🔴 `'0'`, not `''`. Declared-as-zero survived as declared-as-zero.
    await expect(page.getByTestId('touch-plate-mm')).toHaveValue('0');
    await expect(page.getByTestId('clamp-0-height_mm')).toHaveValue('27');

    await openSection(page, 'panel-verify');
    await expect(page.getByTestId('sim-cell')).toHaveValue('1.5');

    /* 🔴 THE SAFETY LEG. Every number above came back; the sentence "I have
     * checked the bed is clear" did not, because nobody has looked at the bed in
     * THIS session. If this assertion ever flips, a restore is asserting that a
     * human performed a physical check they did not perform. */
    await expect(page.getByTestId('confirmed-clear')).not.toBeChecked();

    // And the operator is told, rather than left to notice.
    await expect(page.getByTestId('restore-banner')).toBeVisible();
    await expect(page.getByTestId('restore-not-confirmed')).toBeAttached();
  });

  test('a restored setting reaches the EMITTED PROGRAM, not just the input box', async ({
    page,
  }) => {
    /* Deliberately ONE change, so the fixture stays runnable and the assertion
     * is unambiguous. `rpm` is the setting whose effect on the posted program is
     * a single literal token — the `S` word — so a restore that stops at the
     * React state and never reaches the planner cannot hide behind a derived
     * number that happens to look right.
     *
     * ⚠ 15500 is not the default (18000) and is not a round number the post
     * could arrive at by another route. Both halves are asserted: the new value
     * is present AND the default is absent, because an emitter that wrote both
     * would satisfy the first on its own. */
    /* 🔴 `probe-after-change` IS UNTICKED FIRST, AND IT IS NOT INCIDENTAL SETUP.
     * `?fixtures=1` opens on the MULTI-TOOL `plate` job, whose tool change
     * requests a Z re-reference, while `App.tsx` opens with `probeEnabled ??
     * false` — so the core correctly refuses the whole program and there is no
     * emitted text for the assertion below to read. Withdrawing the request is
     * the resolution that changes NOT ONE BYTE of the posted program (declaring
     * a probe would insert a `G38.2` preamble and move the `S` word this test
     * is looking for out of the first block it appears in). The seam itself is
     * asserted once, in `slicer.spec.ts`; see `readyRunnable()` there for the
     * full measurement. */
    await page.goto('/?fixtures=1');
    await ready(page);
    await page.getByTestId('probe-after-change').uncheck();
    await expect(page.getByTestId('status')).toHaveText('runnable');

    await page.getByTestId('rpm').fill('15500');
    await savedContains(page, '"rpm":15500');

    await page.reload();
    await ready(page);
    /* ⚠ NOT re-unticked: the point of the reload is that the SAVED setup comes
     * back, and `probeAfterChange: false` is part of what was saved. If this
     * needed unticking again the restore would be the thing that was broken. */
    await expect(page.getByTestId('status')).toHaveText('runnable');

    // The G-code panel starts collapsed, so its contents are not in the DOM at
    // all until it is opened — a timeout here reads as a broken app rather than
    // as a closed drawer.
    await openSection(page, 'panel-gcode');
    await page.getByTestId('toggle-gcode').click();
    const gcode = await page.getByTestId('gcode').innerText();
    expect(gcode, 'the posted program carries the restored spindle speed').toContain('S15500');
    expect(gcode, 'and not the default it opened on before the restore').not.toContain('S18000');
  });

  test('a stored setup naming things that no longer exist restores the rest and REPORTS each drop', async ({
    page,
  }) => {
    /* 🔴 THE NEGATIVE PATH, which is the one that matters. A silent fallback to
     * a default is indistinguishable on screen from a value that survived — so
     * this seeds a blob that is VALID in shape and points at four things this
     * build does not have, then asserts both halves: the good values came back
     * AND every bad one is named on the banner with a reason an operator can act
     * on. Asserting only the first half would pass over a restore that quietly
     * substituted a Ø6mm end mill for a cutter nobody owns. */
    await seed(page, {
      kind: '2bee.app session config',
      version: SESSION_VERSION,
      saved_at: Date.now(),
      values: {
        // survives
        travelX: 777,
        rpm: 15500,
        thickness: 9,
        // does not, and each must be NAMED
        toolIds: ['Unobtainium Mill 42mm 9F'],
        material: 'Kryptonite',
        workholdingId: 'no-such-hold-down',
        entry: 'Interpretive Dance',
      },
    });

    await page.goto('/?fixtures=1');
    await panelsReady(page);

    // The rest came back.
    await expect(page.getByTestId('travel-x')).toHaveValue('777');
    await expect(page.getByTestId('rpm')).toHaveValue('15500');
    await expect(page.getByTestId('thickness')).toHaveValue('9');

    // And the four that could not are on the banner, by name.
    await expect(page.getByTestId('restore-banner')).toBeVisible();
    await expect(page.getByTestId('restore-dropped-count')).toHaveText('4');
    const drops = page.getByTestId('restore-dropped');
    await expect(drops).toContainText('Unobtainium Mill 42mm 9F');
    await expect(drops).toContainText('Kryptonite');
    await expect(drops).toContainText('no-such-hold-down');
    await expect(drops).toContainText('Interpretive Dance');

    /* 🔴 And the app is genuinely AT THE DEFAULT for each, not showing the
     * phantom. A banner that reports a drop while the panel still carries the
     * dropped value would be a report about something that did not happen. */
    await expect(page.getByTestId('tool-picker-trigger')).toContainText(
      'End Mill - Down-cut 6mm 2F'
    );
    await expect(page.getByTestId('entry')).toHaveValue('Ramp');
  });

  test('the loaded drawing comes back — by REFERENCE, not by a second copy of its bytes', async ({
    page,
  }) => {
    /* The drawing is the most visible half of "all config should stay", and it
     * is the one thing that must NOT be copied into the stored blob: a DXF is
     * text and a real one runs to megabytes, into a store that fails by throwing
     * mid-write. So a name and an origin are stored and resolved back against
     * what actually exists — and this test is what stops that resolution being
     * written and never exercised. */
    await page.goto('/?fixtures=1');
    await panelsReady(page);

    // MIGRATED 2026-08-09 (TODO #54): the three drawing surfaces are ONE list,
    // and row ids carry their surface — `sample:` / `mesh-sample:` / `saved:` —
    // because a DXF and an STL of the same part are two different objects and a
    // user may save their own drawing under a shipped sample's name.
    await page.getByTestId('drawing-picker-trigger').click();
    await page.getByTestId('drawing-picker-opt-sample:Hive super end').click();
    await expect(page.getByTestId('imported-name')).toContainText('Hive super end');
    await savedContains(page, '"name":"Hive super end"');

    // The bytes are NOT in the blob. A stored drawing that carried its own copy
    // would pass the reload assertion below just as happily, and would be the
    // defect this design exists to avoid.
    const stored = await page.evaluate((k) => localStorage.getItem(k) ?? '', SESSION_KEY);
    expect(stored.length, 'the session blob is a reference, not a drawing').toBeLessThan(4096);

    await page.reload();
    await panelsReady(page);
    await expect(page.getByTestId('imported-name')).toContainText('Hive super end');
  });

  test('a drawing that was opened from disk is NOT silently forgotten — it is named', async ({
    page,
  }) => {
    /* 🔴 The honest half of the reference design. Bytes dropped in from the
     * file picker are never kept by this app, so they cannot come back — and an
     * app that just opened with no drawing would leave the operator to work out
     * why. It says which file, and what to do instead. */
    await seed(page, {
      kind: '2bee.app session config',
      version: SESSION_VERSION,
      saved_at: Date.now(),
      values: {
        travelX: 777,
        // A LIST since 2026-08-10. The entry carries its placement, so a
        // drawing that DOES come back comes back where it was — and one that
        // cannot is named on its own rather than taking the sheet with it.
        //
        // 🔴 `instance` ADDED 2026-08-11, AND ITS ABSENCE IS WHY THIS TEST
        // FAILED. It is not decoration: `DrawingRef.instance` landed in the SAME
        // commit as the list (`ac6e978ea`, 2026-08-10 — two copies of one file
        // are two parts with their own placement), and `store.ts`'s `check()`
        // requires a non-empty one on EVERY entry. This seed was written without
        // it, so the whole `drawings` key failed validation and the banner said
        // *"the stored drawing list was not readable"* — a true sentence about a
        // malformed blob, arriving where this test asserts a sentence about a
        // file that cannot be re-opened. The fixture was wrong, not the app.
        //
        // ⚠ The blob is stamped `version: SESSION_VERSION`, so it CLAIMS to be
        // current-schema; a fixture that claims a schema it does not satisfy
        // tests the validator, not the thing above it.
        drawings: [
          {
            instance: 'panel-from-cad.dxf',
            origin: 'file',
            name: 'panel-from-cad.dxf',
            offset_mm: [0, 0],
            rotation_deg: 0,
          },
        ],
      },
    });

    await page.goto('/?fixtures=1');
    await panelsReady(page);

    await expect(page.getByTestId('travel-x')).toHaveValue('777');
    const drops = page.getByTestId('restore-dropped');
    await expect(drops).toContainText('panel-from-cad.dxf');
    await expect(drops).toContainText('does not keep');
  });

  test('a blob from another schema version restores NOTHING and says why', async ({ page }) => {
    /* A depth-per-pass read field-for-field out of a schema this build does not
     * understand is a wrong number wearing a right label — worse than an empty
     * form, because an empty form is obviously empty. So the version check is
     * all-or-nothing, and this proves the "nothing" half: the blob carries a
     * perfectly well-formed `travelX` that must NOT be applied. */
    await seed(page, {
      kind: '2bee.app session config',
      version: SESSION_VERSION + 1000,
      saved_at: Date.now(),
      values: { travelX: 777, rpm: 15500 },
    });

    await page.goto('/?fixtures=1');
    await panelsReady(page);

    await expect(page.getByTestId('restore-incompatible')).toBeVisible();
    await expect(page.getByTestId('restore-incompatible')).toContainText('NOT restored');
    // Nothing came back — the defaults, not the blob's values.
    await expect(page.getByTestId('travel-x')).toHaveValue('600');
    await expect(page.getByTestId('rpm')).toHaveValue('18000');
    await expect(page.getByTestId('restore-count')).toHaveCount(0);
  });
});
