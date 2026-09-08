// 2bee.cnc — the menu bar.
//
// Founder 2026-08-11: *"create similar menu in 2bee.cnc what already exists in
// 2bee.cad (File … etc)"*. TODO #108.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THIS IS A SECOND IMPLEMENTATION AND NOT A SHARED COMPONENT — DELIBERATE,
//    AND HERE IS WHAT IT WOULD TAKE TO MERGE THEM
// ═══════════════════════════════════════════════════════════════════════════
//
// `web/src/cad/menu.tsx` already holds a WAI-ARIA menubar. This lane spent
// 2026-08-11 finding copies nobody knew were copies, so a copy that nobody
// declared would be the wrong answer here. **This one is declared.**
//
// Two reasons it is a second file rather than an extraction:
//
//   1. **`cad/menu.tsx` BELONGS TO THE CAD TAB'S LANE and is read-only to this
//      change.** Extracting `MenuBar` out of it means editing it — deleting the
//      component, re-importing it, and moving every one of its call sites — which
//      is a change to somebody else's file made while they are working in it.
//   2. **Its `aria-label` IS HARD-CODED `"2bee.cad menu"`** (`menu.tsx:845`,
//      inside `role="menubar"`). Importing it as-is would give the CNC tab a
//      menubar that a screen reader announces as the CAD tab's — a defect
//      invisible to everybody who does not use one, which is the worst kind to
//      ship, and unfixable from here without editing that file.
//
// ⚠ **THE MERGE CONDITION, so this does not sit as an undeclared fork forever:**
// the ONLY structural difference between the two renderers is that `label` is a
// constant there and a required prop here. When `cad/menu.tsx` takes a `label`
// prop, one of these two components can be deleted and the other imported by
// both tabs; the DATA (`cadMenus` / {@link cncMenus}) stays per-tab either way,
// because a menu describing a tab is not shared content. Until then this file
// carries the same keyboard contract, and {@link MENUBAR_PARITY} names the
// properties that have to stay true of both.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE SAME RULE THE CAD BAR IS HELD TO: NO ITEM WHOSE FUNCTION WE DO NOT HAVE
// ═══════════════════════════════════════════════════════════════════════════
//
// A greyed-out item is a promise; an absent one is a fact. Three menus, not five:
// {@link CNC_MENU_ABSENT} records what the CAD bar has that this one does not,
// and why each is absent rather than empty.
//
// ⚠ AND THE HARDER HALF, WHICH IS THIS TAB'S OWN: **a `View` menu must DRIVE
// existing state and never duplicate it.** The layer eyes, the section collapses
// and the panel widths are all real controls that already exist in the sidebar. A
// menu item that "also" toggles one of them is a second control over one piece of
// state, and two controls can disagree — which is strictly worse than making
// somebody look in the panel column. So the View menu holds exactly the pair that
// MOVED here (projection, whose sidebar block is gone in the same change) and a
// footnote naming where the rest live.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 NO KEY IS BOUND, AND IT IS NOT THE CAD TAB'S REASON INVERTED
// ═══════════════════════════════════════════════════════════════════════════
//
// The CAD tab binds `Ctrl+S` because its editor holds UNSAVED WORK: an operator
// pressed Ctrl+S out of thirty years of muscle memory, the browser's Save Page
// dialog completed successfully, and they believed the model was saved.
//
// **This tab has no unsaved work to lose.** The setup is written to
// `localStorage` on every change (`store.ts`, `writeSession`) and the restore is
// announced on the next load. `File → Save job…` writes a PORTABLE COPY — useful,
// and not a rescue — so intercepting Ctrl+S here would take a browser key away to
// prevent a loss that cannot happen. {@link BOUND_KEYS} is therefore empty, and
// `accel` may name only a key it lists, so no accelerator is printed anywhere.

import { useCallback, useEffect, useRef, useState } from 'react';

import { UNIT_LABEL, UNITS_ABSENT, UNITS_NOT_CONVERTED, type Unit } from './units';

/* ── The data ──────────────────────────────────────────────────────────────── */

export interface MenuItem {
  /** Stable command id, handed to `onCommand`. */
  id: string;
  label: string;
  /** A rule restated where the operator presses the button. */
  note?: string;
  disabled?: boolean;
  /** Why, in one sentence. A disabled control with no reason is a puzzle. */
  disabledReason?: string;
  separatorBefore?: boolean;
  /** True ⇒ this item is the current state. Rendered as a check. */
  checked?: boolean;
  /**
   * 🔴 THE PRINTED KEY, AND IT MAY ONLY NAME A KEY THIS BAR BINDS — which today
   * is none of them. Kept as a field rather than text inside a label so a test
   * can compare it against {@link BOUND_KEYS}; a sentence cannot be compared to
   * anything.
   */
  accel?: string;
}

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
  /** A non-interactive line at the foot of the menu. */
  footnote?: string;
}

/**
 * Every accelerator this bar binds. **Empty, on purpose** — see the header.
 *
 * It exists rather than being omitted because the RULE it serves is the one that
 * matters: an `accel` may only name a key in here, so an empty map means a
 * printed key is a test failure rather than a judgement call.
 */
export const BOUND_KEYS: Readonly<Record<string, string>> = {};

/**
 * What the CAD tab's bar has that this one does not, and why each is ABSENT
 * rather than present-and-empty.
 *
 * 🔴 EVERY LINE IS "the thing it would control does not exist here", never "we
 * did not get to it". That distinction is what makes the list worth reading, and
 * `cad/menu.tsx` had to split its own list in two the day one entry meant the
 * other thing.
 */
export const CNC_MENU_ABSENT: readonly string[] = [
  'An Edit menu. The CAD tab has one because it has a text buffer with a document history — New, ' +
    'Example, Open and a model’s reply each replace the whole source, and Undo steps between those ' +
    'states. This tab has no buffer and no such history: every control writes one setting, and the ' +
    'setting it wrote is on the panel in front of you.',
  'A Design menu. Its items report the CAD tab’s manifold audit and show the evaluated CSG tree. ' +
    'The equivalents here are not missing — the plan, the simulation, the notes and the G-code are ' +
    'the results column, permanently, and a menu item that opened a panel that is already open ' +
    'would be decoration.',
  'Accelerators. The CAD tab binds Ctrl+S because its editor holds unsaved work and the browser’s ' +
    'Save Page dialog looks exactly like a successful save. Nothing here is unsaved: the setup is ' +
    'written on every change and the restore is announced on the next load, so taking a browser key ' +
    'would prevent a loss that cannot happen.',
  'Layer visibility, section collapse and the panel widths. They are real controls and they are in ' +
    'the panel column, one click away. Repeating them here would put two controls on one piece of ' +
    'state, and two controls can disagree — which is worse than a short walk.',
];

/**
 * The properties BOTH menubars must keep, named so a future extraction can be
 * checked rather than eyeballed. Asserted in `tests/cnc-menu.test.ts`.
 */
export const MENUBAR_PARITY: readonly string[] = [
  'role="menubar" on the bar, role="menu" on an open popup, role="menuitem" on every button',
  'aria-haspopup and aria-expanded on every top-level button',
  'roving tabindex across the bar: exactly one button is tabbable',
  'Left/Right between menus, Up/Down within one, Home/End, Enter/Space to open',
  'Escape closes and returns focus to the button that opened it',
  'a click outside closes',
  'a disabled item renders its reason, not just grey text',
];

/** Everything the bar needs in order to say true things about this tab. */
export interface CncMenuContext {
  /**
   * The 3D view's projection. 🔴 TWO ITEMS IN AN EXCLUSIVE PAIR, not one
   * checkbox — the same shape as the CAD tab's and for a stronger reason: on this
   * tab orthographic is the view a fit or a clearance may be judged from, so
   * making it the un-named absence of "perspective" would demote the mode that
   * tells the truth about parallel edges.
   */
  projection: 'perspective' | 'orthographic';
  /**
   * The unit lengths are DISPLAYED in. 🔴 AN EXCLUSIVE PAIR, like the projection
   * above, and for a harder reason than symmetry: a checkbox called "inches"
   * makes millimetres the un-named absence of inches, and millimetres are what
   * this app stores, plans, posts and cuts. The canonical unit does not get to
   * be a state with no name.
   *
   * ⚠ **IT REACHES NO PROGRAM.** It is not in the config object, not in the
   * session blob, not in a job file, and `G20` never leaves this app. See
   * `units.ts` — the whole module exists to keep that true.
   */
  unit: Unit;
  /**
   * Why a job cannot be written right now, or `null`.
   *
   * 🔴 IT IS NOT COSMETIC. The tool selection and the material are restored
   * asynchronously, and a job written before that lands would carry the DEFAULT
   * cutter over the operator's stored one — the same hazard `App.tsx` gates its
   * session write on, arriving through a new door.
   */
  saveBlocked: string | null;
  /** Whether there is a stored setup for `Discard` to forget. */
  hasStoredSetup: boolean;
}

/**
 * The bar, as data. Pure and exported so a test can assert that no item exists
 * for a function this tab does not have, without rendering anything.
 */
export function cncMenus(ctx: CncMenuContext): Menu[] {
  return [
    {
      id: 'file',
      label: 'File',
      /* 🔴 THE FOOTNOTE STATES THE BOUND, WHICH IS THE WHOLE SPEC OF SAVE/OPEN.
       * A "save the job" that quietly leaves three things out is worse than none,
       * because the file LOOKS complete. The bound is stated here, at save time,
       * and again inside the file itself (`store.ts`, `JOB_NOT_SAVED`) so the
       * person holding it a month later is told by the artefact rather than by a
       * menu they are not looking at. */
      footnote:
        'A job file is the SETUP, not the program: the machine, the board, the workpiece, the ' +
        'hold-downs, the cutters and the operation numbers. It deliberately does NOT carry your ' +
        'confirmation that the machine is clear, the workpiece-edge switch, or a plant — the first two ' +
        'are statements about TODAY and the third is a deliberate defect that must never travel in ' +
        'a real job. It carries your drawings by NAME and not by content, so opening it on another ' +
        'machine restores the placements and names every drawing it could not find. The file says ' +
        'all of this in its own text, and opening one asks those questions again.',
      items: [
        {
          id: 'file.save-job',
          label: 'Save job…',
          disabled: !!ctx.saveBlocked,
          disabledReason: ctx.saveBlocked ?? undefined,
          note:
            'Downloads this setup as a file you can keep with the machine or send to somebody else. ' +
            'Your browser already keeps the same setup between reloads — this is a portable copy, ' +
            'not a rescue.',
        },
        {
          id: 'file.open-job',
          label: 'Open job…',
          note:
            'Replaces EVERYTHING on these panels and reloads the page, so the file goes through the ' +
            'same restore that runs on every load — including the banner naming what came back and ' +
            'what did not. A file this build cannot read is refused BEFORE anything is replaced.',
        },
        {
          id: 'file.discard-session',
          label: 'Discard the stored setup and reload',
          separatorBefore: true,
          disabled: !ctx.hasStoredSetup,
          disabledReason:
            'There is no stored setup to forget — this browser has nothing saved for this app, so ' +
            'the panels are already at their defaults.',
          note:
            'Forgets what this browser remembers and reloads on defaults. It does not touch your ' +
            'saved machines, drawings or boards, and it does not touch a job file you have written.',
        },
      ],
    },
    {
      id: 'view',
      label: 'View',
      /* 🔴 THE FOOTNOTE IS THE DUPLICATION RULE, SAID WHERE SOMEBODY WOULD BREAK
       * IT. The obvious next edit to this menu is a "Show/hide layers" item. */
      footnote:
        'The layer eyes, the section collapses and the panel widths are NOT repeated here. They are ' +
        'in the panel column on the left, and a second control over one setting can disagree with ' +
        'the first — which is worse than walking to it. Everything in this menu drives the state ' +
        'the tab already had; nothing in it is a second copy. ' +
        /* 🔴 THE TWO UNIT LISTS ARE RENDERED, NOT MERELY DECLARED. A constant
         * naming what a control does not do, which nothing displays, is a
         * comment with a type — and this lane has shipped one of those before.
         * They are here because the View menu is where somebody asks "why is
         * there no cm" and "why is that refusal still in mm". */
        'NOT OFFERED: ' +
        UNITS_ABSENT.join(' ') +
        ' STAYS IN MILLIMETRES WHATEVER THIS IS SET TO: ' +
        UNITS_NOT_CONVERTED.join(' '),
      items: [
        /* 🔴 ORTHOGRAPHIC FIRST, WHICH IS THE OPPOSITE ORDER FROM THE CAD BAR,
         * AND THE DIFFERENCE IS THE POINT. That bar lists Perspective first
         * because it mirrors OpenSCAD, whose default it is. This tab defaults to
         * orthographic because the operator is judging whether a part fits and
         * whether a toolpath clears a hold-down. Listing the default first is the
         * smaller signal; the sentences under each are the real one. */
        {
          id: 'view.projection.orthogonal',
          label: 'Orthographic',
          checked: ctx.projection === 'orthographic',
          note:
            'No convergence and no foreshortening: an edge that is parallel on the machine is ' +
            'parallel on the screen, and two things that overlap in the picture overlap in the ' +
            'machine. This is the default here — it is the view to judge a fit or a clearance from.',
        },
        {
          id: 'view.projection.perspective',
          label: 'Perspective',
          checked: ctx.projection === 'perspective',
          note:
            'Distant things are drawn smaller and parallel edges converge, so the shape reads more ' +
            'naturally. 🔴 Do not judge a fit or a clearance from this view: a part that fits can be ' +
            'made to look like it overhangs, and a hold-down the cutter will strike can be made to ' +
            'look clear, purely by where the camera is.',
        },
        /* 🔴 THE UNIT PAIR — TODO #109, founder: *"2bee.app able to change from
         * inch to cm"*. It is in THIS menu and on no other surface. A second
         * units control anywhere — a chip on the sidebar, a toggle beside a
         * field — would be two controls over one setting, which is the rule the
         * footnote below states and the reason the projection block left the
         * sidebar in the first place.
         *
         * ⚠ MILLIMETRES FIRST, which IS the default, and unlike the projection
         * pair above the order carries no argument: mm is first because it is
         * what every stored value already is. */
        {
          id: 'view.units.mm',
          label: UNIT_LABEL.mm,
          separatorBefore: true,
          checked: ctx.unit === 'mm',
          note:
            'The unit this app stores, plans, posts and cuts in. Every number on these panels is ' +
            'then exactly the number the planner holds — nothing is converted and nothing is ' +
            'rounded on the way to the screen.',
        },
        {
          id: 'view.units.in',
          label: UNIT_LABEL.in,
          checked: ctx.unit === 'in',
          note:
            'DISPLAY ONLY. Millimetres stay canonical: the G-code is G21 and byte-for-byte ' +
            'identical either way, and nothing you have entered is rewritten. A number shown with ' +
            '“≈” has been rounded to fit an inch display and the planner holds a different ' +
            'millimetre value — type in the box and what you type is what is stored.',
        },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        {
          id: 'help.about',
          label: 'About 2bee.cnc',
          note:
            'What this tool is, and — first, and not behind a click — that nothing it has emitted ' +
            'has ever cut anything.',
        },
        {
          id: 'help.alarm-codes',
          label: 'grblHAL alarm codes',
          note: 'Opens the grblHAL wiki page listing every alarm code and what it means.',
        },
        {
          id: 'help.error-codes',
          label: 'grblHAL error codes',
          note: 'Opens the grblHAL wiki page listing every error code and what it means.',
        },
      ],
    },
  ];
}

/* ── The bar ───────────────────────────────────────────────────────────────── */

export interface MenuBarProps {
  menus: Menu[];
  onCommand(id: string): void;
  /**
   * 🔴 REQUIRED, AND IT IS THE ONE STRUCTURAL DIFFERENCE FROM `cad/menu.tsx`.
   * That component hard-codes `aria-label="2bee.cad menu"`, which is why this
   * file exists at all — see the header. Required rather than defaulted for the
   * same reason `Viewport`'s `zDatum` is: an unwired label is a menubar a screen
   * reader announces as nothing, and a default would hide that a caller forgot.
   */
  label: string;
  testid?: string;
}

/** The WAI-ARIA menubar pattern. See {@link MENUBAR_PARITY}. */
export function MenuBar({ menus, onCommand, label, testid = 'cnc-menubar' }: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  /* `focused` is read inside a callback that must not be rebuilt on every
   * change, so the index is mirrored in a ref. One value, one writer. */
  const focusedRef = useRef(0);
  focusedRef.current = focused;

  const close = useCallback((refocus: boolean) => {
    setOpen(null);
    if (refocus) buttons.current[focusedRef.current]?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const move = (delta: number) => {
    const next = (focused + delta + menus.length) % menus.length;
    setFocused(next);
    buttons.current[next]?.focus();
    if (open) setOpen(menus[next].id);
  };

  const onBarKey = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        move(-1);
        break;
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        e.preventDefault();
        setOpen(menus[i].id);
        setFocused(i);
        queueMicrotask(() => {
          root.current
            ?.querySelector<HTMLButtonElement>(
              `[data-menu="${menus[i].id}"] [role="menuitem"]:not([disabled])`,
            )
            ?.focus();
        });
        break;
      case 'Escape':
        setOpen(null);
        break;
      case 'Home':
        e.preventDefault();
        setFocused(0);
        buttons.current[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        setFocused(menus.length - 1);
        buttons.current[menus.length - 1]?.focus();
        break;
      default:
        break;
    }
  };

  const onItemKey = (e: React.KeyboardEvent, menuId: string) => {
    const items = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        `[data-menu="${menuId}"] [role="menuitem"]:not([disabled])`,
      ) ?? [],
    );
    const at = items.indexOf(e.currentTarget as HTMLButtonElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[(at + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[(at - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case 'ArrowRight':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        move(-1);
        break;
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        setOpen(null);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={root}
      role="menubar"
      aria-label={label}
      data-testid={testid}
      style={{ display: 'flex', gap: 2, position: 'relative', flex: '0 0 auto' }}
    >
      {menus.map((m, i) => (
        <div key={m.id} style={{ position: 'relative' }}>
          <button
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={open === m.id}
            data-testid={`cnc-menu-${m.id}`}
            tabIndex={focused === i ? 0 : -1}
            onClick={() => {
              setFocused(i);
              setOpen((cur) => (cur === m.id ? null : m.id));
            }}
            onKeyDown={(e) => onBarKey(e, i)}
            style={{
              font: '11.5px var(--mono)',
              padding: '3px 9px',
              background: open === m.id ? 'var(--panel)' : 'transparent',
              color: 'var(--ink)',
              border: '1px solid',
              borderColor: open === m.id ? 'var(--line)' : 'transparent',
              borderRadius: 'var(--radius)',
              cursor: 'pointer',
            }}
          >
            {m.label}
          </button>

          {open === m.id ? (
            <div
              role="menu"
              aria-label={m.label}
              data-menu={m.id}
              data-testid={`cnc-menu-popup-${m.id}`}
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                zIndex: 20,
                minWidth: 300,
                maxWidth: 420,
                padding: 4,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow-card-hover)',
              }}
            >
              {m.items.map((it) => (
                <div key={it.id}>
                  {it.separatorBefore ? (
                    <div
                      role="separator"
                      style={{ height: 1, background: 'var(--line)', margin: '4px 2px' }}
                    />
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`cnc-menuitem-${it.id}`}
                    disabled={it.disabled}
                    onKeyDown={(e) => onItemKey(e, m.id)}
                    onClick={() => {
                      setOpen(null);
                      onCommand(it.id);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 24,
                      width: '100%',
                      textAlign: 'left',
                      font: '11.5px/1.4 var(--mono)',
                      padding: '4px 8px',
                      background: 'transparent',
                      color: it.disabled ? 'var(--muted)' : 'var(--ink)',
                      border: '1px solid transparent',
                      borderRadius: 'var(--radius)',
                      cursor: it.disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <span>
                      {it.checked ? '● ' : ''}
                      {it.label}
                    </span>
                    {/* Only ever a key `BOUND_KEYS` names — which is none. */}
                    {it.accel ? (
                      <span data-testid={`cnc-menuaccel-${it.id}`} style={{ color: 'var(--muted)' }}>
                        {it.accel}
                      </span>
                    ) : null}
                  </button>
                  {/* The reason travels with the control, never in a footnote
                      somewhere else. */}
                  {it.disabled && it.disabledReason ? (
                    <p className="note" style={{ margin: '0 8px 4px', maxWidth: 380 }}>
                      {it.disabledReason}
                    </p>
                  ) : it.note ? (
                    <p className="note" style={{ margin: '0 8px 4px', maxWidth: 380 }}>
                      {it.note}
                    </p>
                  ) : null}
                </div>
              ))}
              {m.footnote ? (
                <p
                  className="warn"
                  data-testid={`cnc-menu-footnote-${m.id}`}
                  style={{ margin: '6px 8px 2px', maxWidth: 380 }}
                >
                  {m.footnote}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default MenuBar;
