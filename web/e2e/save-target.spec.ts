/**
 * THE SAVE TARGET — which object `Save as` writes, and when it must refuse.
 *
 * 🔴 WHY THIS FILE EXISTS. `App.tsx`'s TODO #102 branch refuses an ambiguous
 * save and names both sides of the ambiguity. Measured 2026-08-27:
 * `grep "Nothing was saved"` over `web/e2e/` and `web/tests/` returned **nothing**.
 * The rule guarding which machine's travels get written under a name was
 * enforced by code that no test had ever exercised, in either direction — so
 * deleting the branch, or widening it until nothing could be saved, would both
 * have shipped green.
 *
 * ⚠ AND WIDENING IT UNTIL NOTHING COULD BE SAVED IS EXACTLY WHAT HAD HAPPENED.
 * On open with nothing selected the picker makes ROW 0 active, the properties
 * view follows the active row, and the refusal read that as *"you are looking
 * at Bellwether Lead 1250x670"*. So a machine typed into the panel could not be
 * saved at all, and the escape hatch the refusal offered — *"close the
 * properties view"* — named a control that does not exist: the picker's only
 * buttons are `Save as` and `Cancel`. Three tests were red on it and each read
 * as its own defect.
 *
 * The two tests below are the two halves of one rule, and they must BOTH stay:
 * the first alone would pass if the refusal were deleted, the second alone would
 * pass if the refusal swallowed everything. Only the pair pins it.
 */
import { expect, test, type Page } from '@playwright/test';
import { seedTab } from './tab';

/* The landing tab is Designs; this suite is about the CNC tab. See e2e/tab.ts. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'cnc');
});

async function panelsReady(page: Page) {
  await expect(page.getByTestId('tool-picker-trigger')).toContainText(
    'End Mill - Down-cut 6mm 2F',
    { timeout: 30_000 }
  );
}

test('a machine typed into the panel saves, with the list untouched', async ({ page }) => {
  await page.goto('/');
  await panelsReady(page);

  // A value no preset carries, so nothing can pass by coincidence: the refusal
  // compares the panel's travels against the previewed preset's, and 1234 x 900
  // matches none of the three shipped machines.
  await page.getByTestId('travel-x').fill('1234');
  await page.getByTestId('machine-picker-trigger').click();

  // The properties view DOES preview row 0 — that is not the defect and is not
  // being changed. Asserted so this test fails loudly if the preview is what
  // someone "fixes", rather than the save target.
  await expect(page.locator('[data-testid="machine-picker"] h4').first()).toHaveText(
    'Bellwether Lead 1250x670'
  );

  await page.getByTestId('machine-picker-saveas-name').fill('shop router');
  await page.getByTestId('machine-picker-saveas').click();

  await expect(
    page.getByTestId('machine-save-note'),
    'the save was refused even though the operator never touched the list'
  ).toHaveCount(0);
  await expect(page.getByTestId('machine-note')).toContainText('saved');
});

test('arrowing to another machine and saving is REFUSED, naming both', async ({ page }) => {
  await page.goto('/');
  await panelsReady(page);

  await page.getByTestId('travel-x').fill('1234');
  await page.getByTestId('machine-picker-trigger').click();

  // THE GESTURE THAT CREATES THE AMBIGUITY. Arrowing moves the properties view
  // WITHOUT selecting, so `Save as` here would write the previewed machine's
  // travels under the typed name while the panel holds different ones.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-testid="machine-picker"] h4').first()).toHaveText(
    'Desktop 3018'
  );

  await page.getByTestId('machine-picker-saveas-name').fill('ambiguous');
  await page.getByTestId('machine-picker-saveas').click();

  // BOTH sides named — the refusal is only useful if it says which two things
  // it could not tell apart.
  const refusal = page.getByTestId('machine-save-note');
  await expect(refusal).toContainText('Nothing was saved');
  await expect(refusal).toContainText('Desktop 3018');
  await expect(refusal).toContainText('1234');
  // And nothing was written: the success note must be absent, not merely stale.
  await expect(page.getByTestId('machine-note')).toHaveCount(0);
});

test('the MOUSE path to Save as crosses rows, and crossing them is not choosing', async ({ page }) => {
  /* 🔴 THE CASE THE FIRST TWO TESTS COULD NOT SEE, and it made the fix they
   * guard useless in the built app for a few hours on 2026-08-27.
   *
   * `activeChosen` was armed on `pointermove` over any row. The save box sits
   * in the properties pane to the RIGHT of the list; `Tab` from the search box
   * CLOSES the dialog and the rows are not focusable, so `Save as` is reachable
   * by mouse only — and the mouse path from the trigger to that box crosses
   * rows. Every mouse user therefore hit the save-target refusal, unavoidably.
   *
   * The other two tests stayed green throughout: `fill()` moves no pointer and
   * `click()` jumps straight to the element. A suite that only ever teleports
   * cannot see a defect that lives in the space between two controls, so this
   * one MOVES THE MOUSE, in steps, the way a hand does. */
  await page.goto('/');
  await panelsReady(page);

  await page.getByTestId('travel-x').fill('1234');
  await page.getByTestId('machine-picker-trigger').click();

  // Drag the pointer across the list, exactly as reaching for the save box does.
  const rows = page.locator('[data-testid="machine-picker-list"] .op-opt');
  const n = await rows.count();
  expect(n, 'no rows to cross — this test would pass by drawing nothing').toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    const box = await rows.nth(i).boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  }

  await page.getByTestId('machine-picker-saveas-name').fill('shop router');
  await page.getByTestId('machine-picker-saveas').click();

  await expect(
    page.getByTestId('machine-save-note'),
    'moving the mouse across the list counted as choosing a machine, so the save was refused'
  ).toHaveCount(0);
  await expect(page.getByTestId('machine-note')).toContainText('saved');
});

test('an unsaved property edit belongs to the row it was typed on — kept, and never applied to another', async ({
  page,
}) => {
  /* 🔴 TWO DEFECTS IN ONE CONTRACT, both shipped on 2026-08-27 and both from the
   * draft not knowing whose it was.
   *
   *   (a) WRONG RECORD. `draft` was merged into whatever `Save` wrote, with no
   *       record of the row it was typed on: edit a travel while previewing A,
   *       move to B, press Save, and B's record got A's number.
   *   (b) SILENT DATA LOSS. The first fix cleared the draft whenever the preview
   *       moved — and the preview follows the MOUSE, which this same file had
   *       just ruled "does not count as choosing". Sliding the pointer across
   *       the list wiped a half-typed value with no notice and no undo.
   *
   * Both halves are asserted here, because a fix for either alone passes a test
   * for that one alone — which is exactly how (b) shipped as the fix for (a).
   *
   * ⚠ Two SAVED machines are created first because only saved rows carry the
   * editable fields; a preset's properties are read-only, so a version of this
   * test written against the shipped catalogue would have had nothing to type
   * into and would have failed for the wrong reason. (It did — that is why this
   * setup is here.) */
  await page.goto('/');
  await panelsReady(page);

  const saveAs = async (name: string, travelX: string) => {
    await page.getByTestId('travel-x').fill(travelX);
    await page.getByTestId('machine-picker-trigger').click();
    await page.getByTestId('machine-picker-saveas-name').fill(name);
    await page.getByTestId('machine-picker-saveas').click();
    /* ⚠ ASSERT ON THE NAME, NOT ON THE WORD "saved". The first version of this
     * helper checked `toContainText('saved')` — and the note from the PREVIOUS
     * save is still on screen, so the second call passed without saving
     * anything and the failure surfaced 40 lines later as "never reached beta".
     * A stale success message is indistinguishable from a fresh one unless the
     * assertion names what it expects to be fresh. */
    await expect(page.getByTestId('machine-note')).toContainText(name);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('machine-picker-backdrop')).toHaveCount(0);
  };
  await saveAs('alpha', '1111');
  await saveAs('beta', '2222');

  await page.getByTestId('machine-picker-trigger').click();

  /** Arrow until the properties pane is showing `name`. */
  const arrowTo = async (name: string) => {
    const head = page.locator('[data-testid="machine-picker"] h4').first();
    /* 🔴 PUT FOCUS BACK IN THE SEARCH BOX FIRST. `fill()` on a property field
     * leaves focus IN THAT FIELD, so the arrow keys move a caret instead of the
     * list — the first version of this helper spent its twenty presses editing
     * a number and reported "never reached beta", which reads as a missing row
     * rather than a misdirected keystroke. The list's key handler lives on the
     * search input (`onInputKeyDown`). */
    await page.getByRole('combobox', { name: 'search Machine by name' }).focus();
    // And from the top every time: arrowing on from wherever we are depends on
    // the list's order, and a test that depends on the order of a list the app
    // is free to sort fails for a reason that is not the thing under test.
    await page.keyboard.press('Home');
    for (let i = 0; i < 20; i++) {
      if ((await head.textContent()) === name) return;
      await page.keyboard.press('ArrowDown');
    }
    throw new Error(`never reached ${name}`);
  };

  await arrowTo('alpha');
  const edit = page.getByTestId('machine-picker-edit-travelX');
  await edit.fill('999');
  await expect(edit).toHaveValue('999');

  // (a) The other row does NOT show the value typed on alpha.
  //
  // ⚠ Asserted as "not 999" rather than "is 2222", and the difference was
  // measured: with no draft of its own the field renders EMPTY, because its
  // fallback is a formatted string ("2222 mm") that a number input will not
  // take. `toHaveValue('2222')` therefore failed on a rendering detail rather
  // than on the contract — and a test that fails for a reason that is not the
  // thing under test is one somebody deletes. The contract is that alpha's
  // number does not follow the preview.
  await arrowTo('beta');
  await expect(
    page.getByTestId('machine-picker-edit-travelX'),
    'an edit typed on one machine is showing on another'
  ).not.toHaveValue('999');

  // (b) Back on alpha, the edit survived — it was kept, not wiped.
  await arrowTo('alpha');
  await expect(
    page.getByTestId('machine-picker-edit-travelX'),
    'the unsaved edit was destroyed by looking at another row'
  ).toHaveValue('999');
});
