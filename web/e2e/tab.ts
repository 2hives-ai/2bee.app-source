// SEEDING WHICH TAB THE APP OPENS ON, FOR SPECS THAT ARE NOT ABOUT TABS.
//
// The landing tab is `Designs` (founder 2026-08-31 — see `DEFAULT_TAB` in
// `src/Tabs.tsx`). Almost every spec in this directory loads `/` and then
// reaches straight for a CNC control, and a control inside a hidden `TabPanel`
// is not visible to Playwright.
//
// 🔴 IT SEEDS `localStorage` BEFORE THE APP BOOTS, RATHER THAN CLICKING THE TAB.
// A click would work and would be worse: it puts a real UI interaction into the
// PRECONDITION of every unrelated test, so a regression in the tab bar would go
// red across the whole suite and hide its own cause in ninety places. Seeding
// the stored choice exercises the same code path the app already has for a
// returning user (`readStoredTab`), and leaves the tab bar itself to be tested
// by `tabs.spec.ts`, which deliberately does NOT use this helper.
//
// ⚠ `addInitScript` PERSISTS FOR THE PAGE, so one call in a `beforeEach` covers
// every `goto` that test makes — including reloads. It does NOT cover a second
// page opened from the same context; such a page must seed itself.

import type { Page } from '@playwright/test';

/** Must match `TAB_KEY` in `src/Tabs.tsx`. */
export const TAB_KEY = '2bee.app.tab';

export type SeedableTab = 'shop' | 'cad' | 'cnc' | 'run';

/** Make the app open on `id`, as a returning user would. */
export async function seedTab(page: Page, id: SeedableTab): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* A context with storage disabled falls back to the default tab; the
         * spec that needed this will fail on its own missing control, which is
         * the loud failure we want rather than a silent wrong-panel pass. */
      }
    },
    [TAB_KEY, id] as const,
  );
}
