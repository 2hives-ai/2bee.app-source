/*
 * 2bee.pnp — the chat view (founder 2026-10-15: "the pnp should be the same
 * concept (left side AI agent, on top select the pcb) below the 3d have the
 * machine").
 *
 * The model endpoint is answered by `page.route`, so nothing leaves the machine.
 * Asserted on what the user SEES: picking `pcb`'s outlet board draws it and plans
 * its trays from the shipped bundle; a chat proposal that would make the plan
 * worse is refused and changes nothing; one that the plan accepts is applied and
 * Undo puts it back; the machine card shows `pnp`'s facts; the expert view is
 * still one link away.
 */
import { test, expect } from '@playwright/test';
import { readdirSync, existsSync } from 'node:fs';
import { seedTab } from './tab';

/** Boards with a fab BOM AND CPL on disk — what the picker must list, discovered,
 *  not typed in (founder 2026-10-15: "remove the hardcoded drop down"). */
function boardsOnDisk(): string[] {
  const pcb = new URL('../../../../hardware/pcb/', import.meta.url);
  const out: string[] = [];
  for (const d of readdirSync(pcb, { withFileTypes: true })) {
    const fab = new URL(`${d.name}/fab/`, pcb);
    if (!d.isDirectory() || !existsSync(fab)) continue;
    const files = readdirSync(fab, { recursive: true }).map(String);
    for (const f of files) {
      const m = /([^/]+)-cpl\.csv$/.exec(f);
      if (m && files.includes(f.replace(/-cpl\.csv$/, '-bom.csv'))) out.push(m[1]);
    }
  }
  return out.sort();
}

const ENDPOINT = 'http://127.0.0.1:9/v1/chat/completions';
let reply = '';

test.beforeEach(async ({ page }) => {
  await seedTab(page, 'pnp');
  await page.addInitScript(
    ([endpoint]) => {
      window.localStorage.setItem('2bee.app.pnp.view', 'chat');
      window.localStorage.setItem(
        '2bee.app.cad.ask',
        JSON.stringify({ endpoint, model: 'test', apiKey: 'k', rememberKey: true, timeoutMs: 20000 })
      );
    },
    [ENDPOINT]
  );
  await page.route(ENDPOINT, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }),
    })
  );
});

test('pnp chat view: pick a board, see it in 3D, plan it; the chat is checked and undoable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('pnp-chat')).toBeVisible();
  await expect(page.getByTestId('pnp-components')).toContainText('Choose a board');
  // No trays on the default view (founder: "on the pnp do not show the trays").
  await expect(page.getByTestId('pnp-trays-card')).toHaveCount(0);
  await expect(page.getByTestId('pnp-plan-card')).toHaveCount(0);

  const items = page.getByTestId('pnp-board-list').locator('.pnp-board-item strong');
  const listed = (await items.allTextContents()).sort();
  expect(listed).toEqual(boardsOnDisk());
  expect(listed.length).toBeGreaterThanOrEqual(10);
  await page.getByTestId('pnp-board-search').fill('outl');
  await expect(items).toHaveText(['outlet']);

  await page.getByTestId('pnp-board-item-outlet').click();
  await expect(page.getByTestId('pnp-board-current')).toContainText('outlet');
  await expect(page.getByTestId('pnp-board-sources')).toContainText('hardware/pcb/outlet/fab/outlet-cpl.csv');
  await expect(page.getByTestId('pnp-board-canvas')).toBeVisible();
  await expect(page.getByTestId('pnp-board-legend')).toContainText(/outlet: \d+ parts/);
  const verdict = page.getByTestId('pnp-plan-verdict');
  // pcb's outlet BOM as of 2026-10-15, on the four default trays: two parts
  // need a 16 mm tray that is not on the machine (rule 1). If pcb's BOM moves,
  // this line is the one to re-measure.
  await expect(verdict).toContainText('REFUSED');
  const before = await verdict.textContent();

  // Components ⇄ 3D, both directions (founder: "when I hover the mouse highlight
  // it in the pcb same when I point a component in the pcb highlight it in the list").
  const view = page.getByTestId('pnp-board-view');
  const row = page.getByTestId('pnp-comp-C_B3BST');
  await row.hover();
  await expect(row).toHaveClass(/hot/);
  await expect(view).toHaveAttribute('data-hot', 'C_B3BST');
  // the hover card, anchored to the part on the canvas
  await expect(page.getByTestId('pnp-hover-card')).toContainText('C_B3BST');
  await expect(page.getByTestId('pnp-hover-placed-by')).toHaveText('PnP');
  // keyboard focus highlights too (pointer moved off first: focusing scrolls the
  // panel, and a list row sliding out from under a resting pointer is a real
  // mouseleave)
  await page.mouse.move(0, 0);
  await page.getByTestId('pnp-comp-C_B3IN').focus();
  await expect(view).toHaveAttribute('data-hot', 'C_B3IN');
  await expect(page.getByTestId('pnp-comp-C_B3IN')).toHaveClass(/hot/);
  // 3D → list: point at a real part on the canvas, by its own projected position.
  const canvas = page.getByTestId('pnp-board-canvas');
  await page.mouse.move(0, 0);
  await page.getByTestId('pnp-chat').hover(); // a resting place off the canvas and off the list
  await canvas.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  const target = 'U_MON_L4';
  const at = await canvas.evaluate(
    (el, ref) => (el as unknown as { __screenOf(r: string): { x: number; y: number } | null }).__screenOf(ref),
    target
  );
  expect(at).not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await expect(view).toHaveAttribute('data-hot', target);
  // hovering a part on the canvas shows its card (founder: "when I hover the
  // mouse on top of a component show it")
  await expect(page.getByTestId('pnp-hover-card')).toContainText(target);
  await expect(page.getByTestId('pnp-hover-package')).toHaveText('SOIC-8');
  const hotRow = page.getByTestId(`pnp-comp-${target}`);
  await expect(hotRow).toHaveClass(/hot/);
  // Scrolled into view WITHIN the list (the panel itself is not scrolled: that
  // would move the 3D under the pointer and change the part it is on).
  await expect
    .poll(() =>
      hotRow.evaluate((tr) => {
        const sc = tr.closest('.pnp-components-scroll')!.getBoundingClientRect();
        const r = tr.getBoundingClientRect();
        return r.top >= sc.top - 1 && r.bottom <= sc.bottom + 1;
      })
    )
    .toBe(true);
  await page.mouse.move(0, 0);
  await expect(view).toHaveAttribute('data-hot', '');
  await expect(page.getByTestId('pnp-hover-card')).toHaveCount(0);

  // No notes on the canvas (founder: "remove the comments from the 3d"): the
  // only text inside the view is the controls (and the hover card, now gone).
  const canvasText = (await view.innerText()).replace(/\s+/g, ' ').trim();
  expect(canvasText).toBe('Fit board Fit machine Top Bottom Iso Flip board');

  // Parts must not flicker in and out as the view turns (founder: "when I rotate
  // the pcb the components are disappear and appear again"): from straight
  // above, every part is on screen at all eight azimuths, at both framings.
  for (const fitTo of ['pnp-fit-board', 'pnp-fit-machine']) {
    await page.getByTestId(fitTo).click();
    const seen: number[] = [];
    for (let i = 0; i < 8; i++)
      seen.push(
        await canvas.evaluate(
          (el, t) => {
            const c = el as unknown as { __look(p: number, t: number): void; __visibleParts(): string[] };
            c.__look(0.02, t);
            return c.__visibleParts().length;
          },
          (i / 8) * Math.PI * 2
        )
      );
    // At the machine framing two parts' 4 px markers can land on the same
    // pixels (one ID wins), so allow a spread of 2 there; the defect this
    // guards swung 80 → 96 of 98 (measured with the old fixed depth range).
    const spread = Math.max(...seen) - Math.min(...seen);
    expect(spread, `${fitTo}: ${seen.join(' ')}`).toBeLessThanOrEqual(fitTo === 'pnp-fit-board' ? 0 : 2);
    expect(Math.min(...seen), `${fitTo}: ${seen.join(' ')}`).toBeGreaterThanOrEqual(95);
  }
  await page.getByTestId('pnp-view-iso').click();
  await page.getByTestId('pnp-fit-board').click();

  // A worse plan (1000 boards: every lane short) is refused by the tab's own check.
  reply = JSON.stringify({ answer: 'many', patch: { boards: 1000 } });
  await page.getByTestId('pnp-chat-prompt').fill('build a thousand boards');
  await page.getByTestId('pnp-chat-send').click();
  await expect(page.getByTestId('pnp-chat-reply').last()).toContainText('Not changed: the tray plan would not get better');

  // An unknown variant is refused before any plan runs.
  reply = JSON.stringify({ answer: 'x', patch: { trays: [{ trayId: 'T1', variant: '99mm' }] } });
  await page.getByTestId('pnp-chat-prompt').fill('use a 99 mm tray');
  await page.getByTestId('pnp-chat-send').click();
  await expect(page.getByTestId('pnp-chat-reply').last()).toContainText('broke the rules');

  // Adding trays can only help: applied, then undone.
  reply = JSON.stringify({
    answer: 'Added trays.',
    patch: {
      trays: [
        { trayId: 'T01', variant: '0402' },
        { trayId: 'T02', variant: '8paper' },
        { trayId: 'T03', variant: '8emb' },
        { trayId: 'T04', variant: '12' },
        { trayId: 'T05', variant: '0402' },
        { trayId: 'T06', variant: '8paper' },
        { trayId: 'T07', variant: '12' },
        { trayId: 'T08', variant: '16' },
      ],
    },
  });
  await page.getByTestId('pnp-chat-prompt').fill('add the trays this job needs');
  await page.getByTestId('pnp-chat-send').click();
  const last = page.getByTestId('pnp-chat-reply').last();
  await expect(last).toContainText('Done.');
  await expect(last).toContainText('MANIFEST OK');
  await expect(verdict).toContainText('plan: OK');
  await page.getByTestId('pnp-chat-undo').click();
  await expect(last).toContainText('Undone.');
  await expect(verdict).toHaveText(before ?? '');

  // Drag the board on the machine (founder: "able to drag and drop the pcb on the
  // 3d with mouse"): press on a part, move, release — the position changes.
  const pos = page.getByTestId('pnp-board-pos');
  await expect(pos).toContainText('on the 410 × 210 mm travel');
  const before0 = await pos.textContent();
  const grab = await canvas.evaluate(
    (el, ref) => (el as unknown as { __screenOf(r: string): { x: number; y: number } | null }).__screenOf(ref),
    'U_MON_L4'
  );
  await page.mouse.move(grab!.x, grab!.y);
  await page.mouse.down();
  await page.mouse.move(grab!.x + 30, grab!.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect(pos).not.toHaveText(before0 ?? '');
  await expect(page.getByTestId('pnp-board-held')).toHaveCount(0);
  // Far past the edge: held inside the travel, and said so.
  const grab2 = await canvas.evaluate(
    (el, ref) => (el as unknown as { __screenOf(r: string): { x: number; y: number } | null }).__screenOf(ref),
    'U_MON_L4'
  );
  await page.mouse.move(grab2!.x, grab2!.y);
  await page.mouse.down();
  await page.mouse.move(grab2!.x + 2000, grab2!.y, { steps: 5 });
  await expect(page.getByTestId('pnp-board-held')).toBeVisible();
  await page.mouse.up();

  // Clear empties the assistant (the applied state is untouched).
  await expect(page.getByTestId('pnp-chat-reply').first()).toBeVisible();
  await page.getByTestId('pnp-chat-clear').click();
  await expect(page.getByTestId('pnp-chat-reply')).toHaveCount(0);
  await expect(page.getByTestId('pnp-chat-clear')).toBeDisabled();

  // The real board from pcb's gerbers, when the render has been generated
  // (`npm run pnp:stackup`; `npm run build` runs it). Either way the tab SAYS which.
  await expect(page.getByTestId('pnp-board-gerber')).toContainText(/pcb’s gerbers \(hardware\/pcb\/outlet\/fab\)|no gerber render/);

  // 360° (founder: "able to 360 rotate the object"): Bottom looks up from under
  // the board; Flip turns it over; the part under the pointer is still found.
  await page.getByTestId('pnp-view-bottom').click();
  await page.getByTestId('pnp-flip').click();
  await expect(view).toHaveAttribute('data-flipped', 'yes');
  await page.getByTestId('pnp-view-top').click();
  const flippedAt = await canvas.evaluate(
    (el, ref) => (el as unknown as { __screenOf(r: string): { x: number; y: number } | null }).__screenOf(ref),
    'U_MON_L4'
  );
  expect(flippedAt).not.toEqual(grab2);
  await page.getByTestId('pnp-flip').click();
  await expect(view).toHaveAttribute('data-flipped', 'no');
  await page.getByTestId('pnp-view-iso').click();

  // Drop a board row from the picker onto the 3D: that board opens.
  await page.getByTestId('pnp-board-change').click();
  await page.getByTestId('pnp-board-item-buck48_24').dragTo(page.getByTestId('pnp-board-view'));
  await expect(page.getByTestId('pnp-board-sources')).toContainText('buck48_24-cpl.csv');
  await expect(page.getByTestId('pnp-board-legend')).toContainText(/buck48_24: \d+ parts/);
  // Every BOM part, by who fits it — not only the CPL's machine rows (founder,
  // on buck48_05: "there are only 5 components needed?").
  await expect(page.getByTestId('pnp-components-count')).toContainText(/\d+ parts: 5 by machine \(bottom\), \d+ by hand/);
  await expect(page.getByTestId('pnp-comp-U_DC')).toContainText('hand');
  // Listed in the order they are fitted (founder: "order the components based
  // how those components should be soldered / placed"): machine reflow first,
  // then THT by height, the hand-fitted converter last.
  await expect(page.getByTestId('pnp-seq-group').first()).toContainText('1. Bottom reflow · machine');
  await expect(page.getByTestId('pnp-seq-group').last()).toContainText('Hand-fitted');
  const lastRow = page.locator('[data-testid^="pnp-comp-"]').last();
  await expect(lastRow).toHaveAttribute('data-testid', 'pnp-comp-U_DC');

  // Filter by side or by who fits it (founder: "pnp: able to filter by side or
  // 'by'"): counts on every option, rows narrow, the 3D dims the rest.
  await expect(page.getByTestId('pnp-filter-by-machine')).toContainText('5');
  await expect(page.getByTestId('pnp-filter-side-top')).toBeVisible();
  await page.getByTestId('pnp-filter-by-hand').click();
  await expect(page.getByTestId('pnp-comp-U_DC')).toBeVisible();
  await expect(page.getByTestId('pnp-comp-C1')).toHaveCount(0);
  await expect(view).not.toHaveAttribute('data-dimmed', '0');
  await page.getByTestId('pnp-filter-by-all').click();
  await page.getByTestId('pnp-filter-side-bottom').click();
  await expect(page.getByTestId('pnp-comp-C1')).toBeVisible();
  await expect(page.getByTestId('pnp-filter-by-machine')).toContainText('5');
  await page.getByTestId('pnp-filter-side-all').click();
  await expect(view).toHaveAttribute('data-dimmed', '0');

  // The machine below the 3D: pnp's facts, switchable.
  const card = page.getByTestId('pnp-machine-card');
  await expect(card).toContainText('Designed, not built');
  await page.getByTestId('pnp-machine-select').selectOption('lumenpnp-v4');
  await expect(card).toContainText('Reference, not bought');
  await expect(card).toContainText('not stated');
  await expect(pos).toContainText('states no travel, so the position is not checked');

  // The expert view is one link away and still has the upload pre-flight.
  await page.getByTestId('pnp-to-expert').click();
  await expect(page.getByTestId('pnp-bom')).toBeAttached();
});
