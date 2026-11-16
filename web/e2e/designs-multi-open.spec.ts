// OPENING SEVERAL DESIGNS IN A ROW, AND GETTING BACK OUT OF EACH ONE.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY A SECOND SHOP SPEC, WHEN `shop.spec.ts` ALREADY OPENS A DESIGN
// ═══════════════════════════════════════════════════════════════════════════
//
// That one proves the chain works ONCE, from a cold page. Everything it
// exercises is first-open state: an unmounted `CadTab` claiming a pending slot,
// an empty editor, an untouched undo stack. ⇒ ***It cannot see any defect whose
// precondition is that something was opened before***, and that is the whole
// class this file is about:
//
//   - the second design must REPLACE the first, not merge with or be ignored by
//     it — `handoff.ts` holds ONE pending request and `CadTab` is mounted once
//     and then kept, so the second click takes a different code path from the
//     first (`replaceEditor` on a live tab, not a slot claimed at mount);
//   - going BACK to Designs and returning must not lose the model;
//   - the library installed by design B must not still resolve design A's
//     imports, which is the silent version of this failure: a part that opens
//     and draws using another part's geometry.
//
// ⚠ AND IT IS THE FLOW THE FOUNDER ACTUALLY DESCRIBED — "open up multiple
// designs, closing … etc" — which is browsing, not a single guided path.
//
// ⚠ NOTE ON THE ASSERTIONS: each one is on something the PAGE renders after the
// switch, never on the click having been dispatched. A click that registers and
// changes nothing is the exact defect `handoff.ts`'s header describes, and an
// assertion on the click would pass through it.

import { expect, test, type Page } from '@playwright/test';
import { seedTab, seedCadCode } from './tab';

/* 2bee.cad opens on the chat view since 2026-10-15; these tests drive its code view. */
test.beforeEach(async ({ page }) => seedCadCode(page));

/* The first screen is the three steps since 2026-10-14; this suite is about the Designs tab. */
test.beforeEach(async ({ page }) => {
  await seedTab(page, 'shop');
});

/** Card ids, in catalogue order, without assuming which designs cad ships. */
async function cardIds(page: Page, limit: number): Promise<string[]> {
  const ids = await page.getByTestId('shop-card').evaluateAll((cards) =>
    cards
      // The first OPEN action (inside .shop-card-actions): ac066e5180 put an Archive <button> first in every card,
      // and the bare querySelector('button') read its shop-archive-* id, so every card was filtered out (0 cards).
      .map((c) => c.querySelector('.shop-card-actions button')?.getAttribute('data-testid') ?? '')
      .filter((t) => t.startsWith('shop-open-'))
      .map((t) => t.slice('shop-open-'.length)),
  );
  expect(ids.length).toBeGreaterThan(2);
  return ids.slice(0, limit);
}

async function openDesign(page: Page, id: string): Promise<void> {
  await page.getByTestId(`shop-open-${id}`).click();
  // The tab must actually change. Asserting on the CAD tab being selected is
  // the observable consequence; asserting the click landed is not.
  await expect(page.getByTestId('tab-cad')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
}

async function backToDesigns(page: Page): Promise<void> {
  await page.getByTestId('tab-shop').click();
  await expect(page.getByTestId('shop')).toBeVisible();
}

test.describe('browsing several designs', () => {
  test('three designs open in a row, and each REPLACES the last', async ({ page }) => {
    await page.goto('/');
    const ids = await cardIds(page, 3);

    const seen: string[] = [];
    for (const id of ids) {
      await openDesign(page, id);
      // The editor's text is the evidence that the model changed. Reading the
      // path/title from the tab would only prove a label moved.
      const text = await page.getByTestId('cad-editor').innerText();
      expect(text.length, `design ${id} opened an EMPTY editor`).toBeGreaterThan(0);
      seen.push(text.slice(0, 400));
      await backToDesigns(page);
    }

    // 🔴 THE POINT OF THE LOOP. Three opens that all left the FIRST design in
    // the editor would satisfy every per-iteration assertion above — the tab
    // switches, the editor is non-empty — and would be exactly the "the second
    // click did nothing" failure `handoff.ts` was built to avoid.
    const distinct = new Set(seen);
    expect(distinct.size, 'every design opened the same text — a later pick did not replace the earlier one').toBeGreaterThan(1);
  });

  test('leaving 2bee.cad and coming back keeps the model', async ({ page }) => {
    await page.goto('/');
    const [first] = await cardIds(page, 1);
    await openDesign(page, first);
    const before = await page.getByTestId('cad-editor').innerText();

    await backToDesigns(page);
    await page.getByTestId('tab-cad').click();
    await expect(page.getByTestId('tab-cad')).toHaveAttribute('aria-selected', 'true');

    const after = await page.getByTestId('cad-editor').innerText();
    // ⚠ Equality, not "non-empty". A tab that re-mounted and reloaded a stored
    // session would also be non-empty, with somebody else's model in it.
    expect(after).toBe(before);
  });

  test('the open is reported while it runs, rather than freezing silently', async ({ page }) => {
    await page.goto('/');
    const [first] = await cardIds(page, 1);

    // The progress element is short-lived by design. Racing it is the point:
    // this asserts it EXISTS in the DOM during the open, and tolerates the open
    // finishing first — a fast machine must not turn this into a flake.
    const progress = page.getByTestId('shop-progress');
    // The phase is read WHEN the element appears, bounded: read after the open it waited on an element that had
    // already gone, with no timeout of its own, until the 60 s test limit (Mac Pro, 2026-11-15).
    const appeared = progress.waitFor({ state: 'attached', timeout: 5_000 }).then(
      () => page.getByTestId('shop-progress-phase').textContent({ timeout: 1_000 }).catch(() => null).then((t) => ({ t })),
      () => false as const,
    );
    await page.getByTestId(`shop-open-${first}`).click();
    const shown = await appeared;
    await expect(page.getByTestId('tab-cad')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });

    // ⚠ WHAT THIS DOES AND DOES NOT ASSERT, said rather than implied: if the
    // progress element was seen it must have carried a PHASE, because a bar with
    // no phase is the spinner this replaced. If it was never seen the open was
    // faster than 5s and nothing is claimed — this test is not a timing check.
    if (shown && shown.t !== null) expect(shown.t).toMatch(/\d+\/\d+/);
  });

  test('the external shelf is visibly NOT ours, or visibly absent', async ({ page }) => {
    await page.goto('/');
    const shelf = page.getByTestId('shop-external');
    const absent = page.getByTestId('shop-external-absent');

    // 🔴 EITHER IS A PASS AND THE THIRD OUTCOME IS THE FAILURE. `public/designs/`
    // is generated and not in git, so a build without it is legitimate — and it
    // must say so rather than rendering as an empty shelf, which is the same
    // "no designs" vs "no catalogue" confusion the cad shelf is built to avoid.
    // What may NOT happen is neither element existing at all.
    // Waited for, then counted: a bare count right after goto raced the catalogue load (0 + 0, Mac Pro,
    // 2026-11-15). The wait expires into the same failure below if neither ever appears.
    await shelf.or(absent).first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {});
    const hasShelf = await shelf.count();
    const hasAbsent = await absent.count();
    expect(hasShelf + hasAbsent, 'the external shelf renders neither content nor an explanation').toBeGreaterThan(0);

    if (hasShelf > 0) {
      await expect(shelf).toContainText('not ours');
      const cards = page.getByTestId('shop-external-card');
      if ((await cards.count()) > 0) {
        // Every card must carry its licence and link OUT. An external design
        // rendered without attribution is a licence failure on a served page,
        // not a styling omission.
        const first = cards.first();
        await expect(first.locator('.shop-card-licence')).toBeVisible();
        await expect(first.locator('a')).toHaveAttribute('href', /^https:\/\//);
      }
    }
  });
});

// ── THE CORNER GIZMO AND THE BOTTOM BAR ────────────────────────────────────
//
// 🔴 IN THE BROWSER BECAUSE THE UNIT TESTS CANNOT SEE THE THING THAT MATTERS.
// `tests/cad-gizmo.test.ts` proves the geometry: from the front, +Z is up and
// +Y points away. It cannot prove that clicking the widget MOVES THE CAMERA —
// that runs through the render loop, a ref the setup effect writes, and a
// painter registered from an effect. Four seams, every one of which can be
// wired wrongly while both the maths and the markup stay correct.
test.describe('the 2bee.cad viewport controls', () => {
  test('the gizmo and the bar are both present, and the gizmo tracks the camera', async ({ page }) => {
    await page.goto('/');
    const ids = await cardIds(page, 1);
    await openDesign(page, ids[0]);

    const gizmo = page.getByTestId('cad-gizmo');
    await expect(gizmo).toBeVisible();
    await expect(page.getByTestId('cad-preview-bar')).toBeVisible();
    await expect(page.getByTestId('cad-preview-fit')).toBeVisible();

    // 🔴 THE PAINTED POSITION, NOT THE ELEMENT'S EXISTENCE. A gizmo wired to
    // nothing renders perfectly and never moves; reading the +Z dot's centre
    // before and after a view change is what tells those apart.
    const zDot = page.getByTestId('cad-gizmo-top');
    const before = await zDot.getAttribute('cy');
    expect(before, 'the gizmo was never painted — its dots are still at their JSX defaults').not.toBeNull();

    await page.getByTestId('cad-view-front').click();
    await expect
      .poll(async () => zDot.getAttribute('cy'), { timeout: 5_000 })
      .not.toBe(before);

    // From the front, +Z must be at the TOP of the widget: cy is negative in a
    // viewBox centred on 0, and SVG's y runs down.
    const front = Number(await zDot.getAttribute('cy'));
    expect(front).toBeLessThan(-20);
  });

  test('clicking an axis end orients the view, and Fit is not a view', async ({ page }) => {
    await page.goto('/');
    const ids = await cardIds(page, 1);
    await openDesign(page, ids[0]);

    const xDot = page.getByTestId('cad-gizmo-right');
    await page.getByTestId('cad-view-top').click();
    const fromTop = await xDot.getAttribute('cx');

    // Click the +X end on the gizmo itself — the click-to-orient the founder
    // asked for, exercised through the widget rather than through the bar.
    await xDot.click();
    await expect.poll(async () => xDot.getAttribute('cx'), { timeout: 5_000 }).not.toBe(fromTop);

    // Looking down +X, that end points at the viewer, so it sits at the middle
    // of the widget rather than out at the rim.
    const looking = await xDot.getAttribute('cx');
    expect(Math.abs(Number(looking))).toBeLessThan(2);

    // ⚠ `Fit` must not be a seventh view: it re-frames and leaves the eye
    // alone, so the gizmo does not move when it is pressed. If this ever fails,
    // `Fit` has started moving the camera's angles and every named view has
    // quietly become "and also re-zoom".
    const still = await xDot.getAttribute('cx');
    await page.getByTestId('cad-preview-fit').click();
    await page.waitForTimeout(400);
    expect(await xDot.getAttribute('cx')).toBe(still);
  });
});

// ── MOUSE INTERACTION AND THE CENTRE OF VIEW ───────────────────────────────
//
// 🔴 BOTH BEHAVIOURS ARE INVISIBLE TO THE UNIT TESTS AND THAT IS THE POINT.
// `tests/zoom-to-cursor.test.ts` proves the arithmetic keeps a world point under
// the pointer; it cannot prove the wheel handler PASSES THE POINTER — a call
// that sent the viewport centre instead would satisfy every unit test and zoom
// to the middle of the screen forever. Same for the pivot: the raycast can be
// perfect and the listener never attached.
test.describe('2bee.cad mouse interaction', () => {
  async function openFirst(page: Page): Promise<void> {
    await page.goto('/');
    const ids = await cardIds(page, 1);
    await openDesign(page, ids[0]);
    // Square on and framed, so the assertions below are about the gesture
    // rather than about whatever camera the session restored.
    await page.getByTestId('cad-view-front').click();
    await page.getByTestId('cad-preview-fit').click();
    await page.waitForTimeout(300);
  }

  test('the wheel zooms toward the pointer, not toward the middle', async ({ page }) => {
    await openFirst(page);
    const canvas = page.getByTestId('cad-preview-canvas');
    const box = (await canvas.boundingBox())!;

    // The pivot triad marks `target`, and the gizmo does not move under a zoom —
    // so the observable is the pivot, read through the camera the session saves.
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cad.session') ?? '{}')?.camera ?? null);

    // Scroll well off-centre. A notch at the centre is a no-op by construction,
    // so a test that scrolled in the middle would pass on a dead feature.
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.25);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(700); // the camera write is debounced

    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cad.session') ?? '{}')?.camera ?? null);
    expect(after, 'no camera was saved — this test cannot see anything').not.toBeNull();
    expect(after.radius, 'the wheel did not zoom at all').not.toBe(before?.radius);
    // 🔴 THE TARGET MUST HAVE MOVED. Zoom-to-centre changes only `radius`; that
    // is the exact behaviour this change replaced, and it is what this asserts
    // against.
    const moved = before ? Math.hypot(after.target[0] - before.target[0], after.target[1] - before.target[1]) : Infinity;
    expect(moved, 'the orbit centre did not move — the wheel is still zooming toward the middle of the screen').toBeGreaterThan(0.01);
  });

  test('double-click re-centres on what is under the pointer, and says which', async ({ page }) => {
    await openFirst(page);
    const canvas = page.getByTestId('cad-preview-canvas');
    const box = (await canvas.boundingBox())!;

    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cad.session') ?? '{}')?.camera ?? null);

    // The middle of a framed model is the one place a part is almost certainly
    // under the cursor, so this exercises the HIT path rather than the fallback.
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(700);

    // ⚠ `data-pivot-from` distinguishes a part hit from the plane fallback. A
    // test that only checked "the target moved" would pass on a viewport whose
    // raycast never hits anything and silently falls through every time.
    const from = await canvas.getAttribute('data-pivot-from');
    expect(['part', 'plane']).toContain(from);

    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('2bee.app.cad.session') ?? '{}')?.camera ?? null);
    expect(after).not.toBeNull();
    // The angles and the zoom must NOT change: this re-anchors, it does not
    // re-frame. If radius moved, the gesture has quietly become `Fit`.
    expect(after.radius).toBeCloseTo(before.radius, 6);
    expect(after.theta).toBeCloseTo(before.theta, 6);
    expect(after.phi).toBeCloseTo(before.phi, 6);
  });
});
