// The three tabs, and the rule about what stays mounted behind them.
//
// Founder, 2026-08-11 (TODO #76): *"1st tab cad, 2nd tab CNC, 3rd tab operation,
// this is where I will execute and monitor the CNC router"*. The third tab is
// called **Run**, per #76 — `Operation` is already the name of a panel inside
// the CNC tab and of the word the emitted program uses (`( op: pocket-1 )`), and
// one word naming two different things is how a person or a test reaches the
// wrong one.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE MOUNTING RULE IS THE SAFETY-RELEVANT PART OF THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// **An inactive panel is HIDDEN, never unmounted, once it has been opened.**
//
// The CNC tab holds the machine, the workpiece, every drawing and its placement,
// the tool selection and the last report the core produced. None of that is
// derived — the placements are where an operator dragged parts to, and the
// report is the answer they are reading. React discards a subtree's state when
// it unmounts, so a tab switch that unmounted it would silently reset a machine
// setup and throw away a plan, and the panels would come back looking like a
// form nobody had filled in yet. The alternative — lifting ~90 pieces of state
// out of `App.tsx` into a parent — is a rewrite of the file, and a rewrite is
// how the setup gets reset for a subtler reason instead of an obvious one.
//
// The CAD tab is the same argument at a smaller size: its state is the SOURCE
// the user is typing. Losing that on a tab switch is losing their work.
//
// ⚠ WHAT HIDING COSTS, AND IT IS NOT FREE. Both the CNC viewport and the CAD
// preview are three.js canvases with a `requestAnimationFrame` loop that renders
// unconditionally. `display: none` does not stop that loop, and neither viewport
// shrinks to nothing when hidden — both fall back to a default size when their
// container measures 0 (`el.clientWidth || 640`), so a hidden tab would keep
// rendering a full-size scene nobody can see, forever. So each one is TOLD to
// stop: `Viewport` takes a `paused` prop from `App` (which is the authority on
// which tab is showing), and `CadPreview` — which `App` cannot reach, because
// `CadTab` sits between them and is not ours to modify — stops itself when its
// own box measures zero. Two mechanisms because two different components can
// know the fact; the fact is the same one.
//
// ⚠ AND A PANEL IS NOT MOUNTED UNTIL IT IS FIRST OPENED. `App` only renders the
// CAD tree once the tab has been visited. That keeps a first page load exactly
// what it was before this file existed — which is what the browser suite drives,
// and none of those tests knows a tab bar exists.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE SELECTED TAB IS REMEMBERED
// ─────────────────────────────────────────────────────────────────────────────
//
// `localStorage`, under its own key, and DELIBERATELY NOT in `store.ts`'s
// validated session blob. That blob is machining configuration: a field that
// fails its rule is dropped on restore and the operator is told, by name, which
// setting went. Which tab is open cannot produce a wrong part, and mixing it in
// would let a corrupt chrome value contribute to a banner about a machining
// setting. `2bee.app.panels.open` (which panels are expanded) and the report
// width are the precedent, and this follows them.

import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export type TabId = 'shop' | 'cad' | 'cnc' | 'run';

export interface TabSpec {
  id: TabId;
  /** What the tab says. */
  label: string;
  /** The `title`/tooltip — one line, and honest about what is behind it. */
  hint: string;
}

/**
 * 🔴 ORDER IS THE FOUNDER'S, VERBATIM: cad, cnc, run.
 *
 * ⚠ And it is NOT the default. See {@link DEFAULT_TAB} — "first in the bar" and
 * "selected when you arrive" are two decisions and only the first was ruled on.
 */
export const TABS: readonly TabSpec[] = [
  {
    id: 'shop',
    label: 'Designs',
    hint: "Browse cad's designs and open one in 2bee.cad. A catalogue, not a store — nothing here is priced or for sale.",
  },
  {
    id: 'cad',
    label: '2bee.cad',
    hint: 'Design a part. A subset of the OpenSCAD language, evaluated and audited here — the tab says what it is not.',
  },
  {
    id: 'cnc',
    label: '2bee.cnc',
    hint: 'Plan a job and emit G-code. Everything this app can do today.',
  },
  {
    id: 'run',
    label: 'Run',
    /* ⚠ RE-AUDITED 2026-08-11. This said "NOT BUILT", which stopped being true
     * without anything going red: the tab connects, identifies the controller,
     * renders the DROs and streams a program. What has never happened is the
     * only thing that matters — no byte it has ever produced has reached a
     * machine. A stale red lies exactly like a stale green. */
    hint: 'Execute and monitor the machine. NEVER RUN AGAINST A CONTROLLER — the tab says so, and says what it needs first.',
  },
];

/**
 * 🔴 `Designs`, AND THIS IS A FOUNDER RULING, NOT THIS LANE'S PREFERENCE.
 *
 * Founder 2026-08-31, verbatim: *"How about have the 1st page (before 2bee.scad)
 * a shop style page so the user can 'shop for the designs', select it -> than it
 * goes to 2bee.cad"*. "The 1st page" settles what OPENS, which is the question
 * the previous value deliberately left open — the earlier ruling had covered
 * only the ORDER of the tabs.
 *
 * ⚠ WHAT THAT SUPERSEDED, kept because the reasoning was sound and only its
 * PREMISE changed. This was `cnc`, on the argument that landing a user on `cad`
 * or `Run` would make the app's first screen a list of absences — both open with
 * a red banner naming what they are not. That argument does not reach the shop:
 * the catalogue is the one screen here whose content is a list of things that
 * DO exist and DO open. The absences it does carry — how many candidates this
 * reader could not read, and that nothing has ever been cut — are stated ON the
 * page rather than being the page.
 *
 * ⚠ THE COST IS REAL AND WAS PAID, NOT DISCOVERED LATER. The old reasoning's
 * second point was that every spec in `web/e2e/` loads `/` and reaches straight
 * for a CNC control, so a non-`cnc` default puts a tab click in front of all of
 * them. That is still true, and those specs now seed the stored tab before
 * loading (`e2e/tab.ts`) — one helper, not a click bolted onto each test, so a
 * spec that forgets it fails loudly on a missing control rather than passing
 * against the wrong panel.
 *
 * It remains only the FIRST visit: a stored choice always wins, so a user who
 * works in `2bee.cnc` gets it back on the next load.
 */
export const DEFAULT_TAB: TabId = 'shop';

/** Its own key, next to `2bee.app.panels.open`. */
export const TAB_KEY = '2bee.app.tab';

const IDS: readonly string[] = TABS.map((t) => t.id);

/**
 * Read a stored value into a tab id.
 *
 * Pure, and separate from the storage read, so the parsing rule can be tested
 * without a browser: `null`, `''`, `'"cnc"'` (JSON, which this never writes),
 * `'operation'` (the name the tab does NOT have) and anything else a hand-edit
 * or an older build could leave behind all land on the default. An unknown value
 * is IGNORED rather than an error — this is chrome, and the worst it may do is
 * open the wrong tab, which the user fixes with one click.
 */
export function parseTab(raw: string | null | undefined): TabId {
  return raw && IDS.includes(raw) ? (raw as TabId) : DEFAULT_TAB;
}

/** The stored tab, or {@link DEFAULT_TAB}. Never throws. */
export function readStoredTab(): TabId {
  try {
    return parseTab(localStorage.getItem(TAB_KEY));
  } catch {
    /* Storage disabled or unavailable. The app opens on the default; a tab bar
     * that stopped working because a preference could not be read would be a
     * worse outcome than a forgotten preference. */
    return DEFAULT_TAB;
  }
}

/** Remember it. A failed write is not reported — see {@link readStoredTab}. */
export function rememberTab(id: TabId): void {
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* Not remembered. The tab still switches. */
  }
}

/** The tab button's DOM id — referenced by its panel's `aria-labelledby`. */
export function tabDomId(id: TabId): string {
  return `tab-${id}`;
}

/** The panel's DOM id — referenced by its tab's `aria-controls`. */
export function panelDomId(id: TabId): string {
  return `tabpanel-${id}`;
}

/**
 * The tab strip.
 *
 * 🔴 A REAL TAB WIDGET, not a row of styled `<div>`s — `role="tablist"` over
 * `role="tab"` buttons, `aria-selected` on every one of them, `aria-controls`
 * pointing at the panel, and ROVING TABINDEX: exactly one tab is in the page's
 * tab order and the arrow keys move between them. That is the WAI-ARIA APG
 * pattern, and the reason to follow it here rather than approximate it is the
 * same reason this app has an accessibility audit at all: a shop is a place
 * where somebody's other hand is on the machine, and a control that can only be
 * reached with a mouse is a control that is not there for everyone.
 *
 * Activation is AUTOMATIC — an arrow key both moves focus and selects. That is
 * the APG default and it is right here because every panel is already mounted,
 * so selecting one costs a `display` change and nothing else.
 */
export function TabBar({
  tab,
  onTab,
}: {
  tab: TabId;
  onTab: (id: TabId) => void;
}) {
  /* Refs so an arrow key can MOVE FOCUS, not merely change the selection. With
   * roving tabindex the newly selected tab is the only one in the tab order, and
   * leaving focus on the old one would strand the keyboard user outside it. */
  const refs = useRef(new Map<TabId, HTMLButtonElement | null>());

  const go = (next: TabId) => {
    onTab(next);
    refs.current.get(next)?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = TABS.length - 1;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    go(TABS[next].id);
  };

  return (
    <div className="tabbar" role="tablist" aria-label="2bee.app sections" data-testid="tabbar">
      {TABS.map((t, i) => {
        const selected = t.id === tab;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current.set(t.id, el);
            }}
            id={tabDomId(t.id)}
            role="tab"
            type="button"
            className="tab"
            aria-selected={selected}
            aria-controls={panelDomId(t.id)}
            tabIndex={selected ? 0 : -1}
            title={t.hint}
            data-testid={`tab-${t.id}`}
            onClick={() => go(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One panel.
 *
 * 🔴 `hidden` AND `display: none`, not a conditional render — see the mounting
 * rule at the top of this file. The active panel is a flex column that fills the
 * remaining height, because that is what `.app`'s direct children were before
 * this wrapper existed: `.body` is `flex: 1` and only means something inside a
 * flex parent.
 *
 * `focusable` gives the panel itself a tab stop. The APG asks for one on EITHER
 * of two conditions — a panel that holds nothing focusable, **or one whose first
 * element with content is not focusable** — and it is the second that the `Run`
 * panel meets: it opens with the red "nothing here has ever run a machine"
 * banner and the DROs, and its controls come after them. The other two panels
 * open with their own controls and must NOT get a stop, because an extra one in
 * front of a CAM panel changes the keyboard order an operator already knows.
 *
 * ✅ **RESOLVED 2026-08-11, and left visible because a stale 🔴 lies exactly like
 * a stale ✅.** This block carried a warning that the one caller passing
 * `focusable` *"no longer meets that condition"*, on the grounds that the Run
 * tab renders Connect, Start, Hold, Resume, Home, Unlock, Stop and Abort. That
 * observation was correct and the conclusion drawn from it was not: it read the
 * APG's first condition as the only one. The call site's reason was the thing
 * that was wrong, and `App.tsx` now states the condition the panel actually
 * meets. **The prop was not changed** — dropping a tab stop is a keyboard-order
 * change and an operator's hands are the thing it moves.
 */
export function TabPanel({
  id,
  tab,
  focusable,
  children,
}: {
  id: TabId;
  tab: TabId;
  focusable?: boolean;
  children: ReactNode;
}) {
  const active = id === tab;
  return (
    <div
      id={panelDomId(id)}
      role="tabpanel"
      aria-labelledby={tabDomId(id)}
      hidden={!active}
      tabIndex={focusable && active ? 0 : undefined}
      data-testid={`tabpanel-${id}`}
      style={
        active
          ? { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }
          : { display: 'none' }
      }
    >
      {children}
    </div>
  );
}
