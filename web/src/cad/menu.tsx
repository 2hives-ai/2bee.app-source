// 2bee.cad — the menu bar.
//
// Founder 2026-08-11: *"create a similar menu structure in the 2bee.cad what
// looks like openscad (open/save … etc)"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// READ FROM OPENSCAD'S OWN SOURCE, NOT RECONSTRUCTED FROM MEMORY
// ═══════════════════════════════════════════════════════════════════════════
//
// `src/gui/MainWindow.ui` of OpenSCAD 2328d12c3 (2026-08-07), the same file the
// dock layout in `CadTab.tsx` was taken from. Measured there:
//
//   · **SIX** top-level menus in `menubar`'s `addaction` order — File, Edit,
//     Design, View, **Window**, Help. ⚠ Not five: `menuWindow` is between View
//     and Help. (It holds Next/Previous window and Jump-to, all of which are
//     about multiple OpenSCAD windows, so nothing in it maps onto a browser tab
//     and the whole menu is absent here.)
//   · **105** `<action>` elements across them.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE RULE: NO ITEM WHOSE FUNCTION WE DO NOT HAVE
// ═══════════════════════════════════════════════════════════════════════════
//
// The same standard the dock layout was held to. A greyed-out `Export → AMF` is
// a promise; an absent one is a fact. So of 105 actions this bar carries the
// dozen that map onto something real, and {@link OMISSIONS} records what was
// left out and why — rendered in Help → About, because an omission nobody can
// read is indistinguishable from an oversight.
//
// The genuine correspondences, each checked at the code before being claimed:
//
//   · **File → New / Open / Save** — `CadOpen` and `saveCadModel` exist and
//     landed 2026-08-10/11. New is trivial and DESTRUCTIVE: no undo, no
//     autosave, no server copy, so it takes the same confirm as Open.
//   · **File → Example** — OpenSCAD's `menuExamples`. We ship exactly one.
//   · **File → Export → STL (binary)** — `record.ts`'s `encodeBinaryStl`, the
//     same encoder the drawings list stores. One format, because one format is
//     what we can write.
//   · **Edit → Jump to next error** — every diagnostic carries a line and the
//     editor has `goToLine`. OpenSCAD binds Ctrl+Alt+E; see the note on keys.
//   · 🔴 **Design → Check Validity** — this is the one where we have MORE than
//     OpenSCAD, not less. Its item runs a manifold check on demand; `mesh.ts`
//     audits every result for closure, orientation and manifoldness on every
//     evaluation, and the preview refuses to draw what the audit cannot vouch
//     for. The menu item reports that standing verdict.
//   · **Design → Display CSG Tree** — the scene tree, already in the dock.
//   · **View → …** — which bottom pane shows, resetting the pane geometry, and
//     the two axis toggles. 🔴 THIS LINE ENDED *"Nothing about the camera: that
//     is `preview.tsx`'s and not this change's"* UNTIL 2026-08-11. That was a
//     SCOPE statement, and a scope statement left in a capability list reads as
//     a capability claim — the same defect the omission list was split in two to
//     fix, in the same file, three days earlier. `View → Show axes` and
//     `View → Show scale markers` are real items now, mirroring OpenSCAD's
//     `view/showAxes` and `view/showScaleProportional` including the parent-
//     child relationship between them. What is still absent is the named VIEW
//     PRESETS, and that is in `GAPS` where a scope statement may not go.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 ONE KEY IS BOUND — `Ctrl+S` — AND THE OTHER THREE ARE REFUSED FOR THREE
//    DIFFERENT REASONS
// ═══════════════════════════════════════════════════════════════════════════
//
// This bar bound NOTHING until 2026-08-11, and the reason recorded for it was a
// single sentence — *"F5 reloads a browser and Ctrl+S saves the page"* — applied
// as a blanket. That is a true statement about two keys and an argument about
// only one of them, and the blanket hid that the four keys an OpenSCAD user's
// hands reach for are in **four different situations**:
//
//   · **`F5` — NOT BOUND, and this is the original decision, unchanged.**
//     Interceptable, but intercepting it takes the operator's reload away on a
//     page that has needed one. `CadTab.tsx`'s `beforeunload` guard covers the
//     unload — F5, Ctrl+W, the back button and the tab close at once — without
//     taking a key from anybody.
//   · **`Ctrl+S` — BOUND, to `file.save`, and it is the one that had a cost.**
//     `beforeunload` fires on an UNLOAD. Save Page does not unload the document,
//     so the guard never fired for it: the operator pressed Ctrl+S out of thirty
//     years of muscle memory, a browser save dialog completed successfully, they
//     believed the model was saved, and **nothing contradicted them**. That is a
//     silent false belief about stored work, which is the most expensive failure
//     this tab has. The key is interceptable, Save Page in a CAD tab is not a
//     thing anyone means, and the function already exists — so binding it
//     REMOVES the failure instead of documenting it. See {@link commandForKey}.
//   · **`Ctrl+N` — NOT BOUND, and NOT for `F5`'s reason.** Browsers reserve it
//     for a new window and a page cannot `preventDefault` it. Binding it would
//     advertise a key that does nothing — the dead-control defect this bar exists
//     to avoid. **The reason is written down because it was not**, and the next
//     person to revisit the policy would otherwise have to rediscover it.
//   · **`Ctrl+Z` — NOT BOUND, and this is the most important "no".** Inside the
//     focused textarea it is ALREADY DOING SOMETHING: the native typing-undo that
//     {@link OMISSIONS} explicitly delegates to the browser. Binding it to the
//     put-back would trade a whole typing history for one action-undo **and would
//     make this file's own delegation claim false.**
//
// ⚠ AN ACCELERATOR MAY BE PRINTED ONLY FOR A KEY THIS BAR ACTUALLY BINDS. That
// is the `accel` field — a separate field rather than text inside a label, so a
// test can check every advertised key against {@link BOUND_KEYS}, and
// {@link BOUND_KEYS} against what `CadTab.tsx` wires. Printing OpenSCAD's key
// beside an item we have NOT bound would be a dead control drawn as a live one,
// which is the same defect as a greyed-out export format.
//
// ═══════════════════════════════════════════════════════════════════════════
// ACCESSIBILITY
// ═══════════════════════════════════════════════════════════════════════════
//
// The WAI-ARIA menubar pattern, because a row of divs that opens on click would
// be the one control in this app a keyboard cannot reach. Roving tabindex across
// the bar, Left/Right between menus, Down/Up within one, Home/End, Enter/Space
// to open, Escape to close and return focus to the button that opened it, and a
// click anywhere else closes. `aria-haspopup` and `aria-expanded` on every
// top-level button; `role="menu"` / `role="menuitem"` inside.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface MenuItem {
  /** Stable command id, handed to `onCommand`. */
  id: string;
  label: string;
  /** A rule in the tab, restated where the operator presses the button. */
  note?: string;
  disabled?: boolean;
  /** Why, in one sentence. Rendered — a disabled control with no reason is a
   *  puzzle, and this app's convention is to say. */
  disabledReason?: string;
  separatorBefore?: boolean;
  /** True ⇒ this item is currently the active view. Rendered as a check. */
  checked?: boolean;
  /**
   * 🔴 THE PRINTED KEY, AND IT MAY ONLY NAME A KEY THIS BAR BINDS.
   *
   * A separate field rather than text inside `label` or `note` for one reason:
   * a test can compare a field against {@link BOUND_KEYS}, and it cannot compare
   * a sentence against anything. An accelerator printed beside an item nobody
   * bound is a dead control drawn as a live one.
   */
  accel?: string;
}

export interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
  /** A non-interactive line at the foot of the menu. Used for the key note. */
  footnote?: string;
}

/**
 * What OpenSCAD has, what this tab does not, and why — in Help → About.
 *
 * 🔴 THE REASONS ARE THE POINT. "We did not get to it" and "the thing it
 * controls does not exist" are different facts, and only the second is a
 * decision. Every line here is the second.
 *
 * 🔴 AND THAT SENTENCE IS ONLY WORTH ANYTHING IF IT IS TRUE OF EVERY LINE.
 * On 2026-08-11 an audit checked this array against OpenSCAD's own source and
 * found three lines that were not: the camera (which EXISTS — orbit, pan,
 * wheel-zoom and Fit, in `preview.tsx`), `preferences` (three sets of which this
 * tab persists), and six editor commands the browser does not own, filed under a
 * reason that is true of five different ones. **One entry meaning "unbuilt"
 * devalues every other line**, because a reader cannot tell the two kinds apart
 * from the outside — and the whole value of the list is that "absent" can be read
 * as "impossible". So the two kinds are now two arrays: this one, and
 * {@link GAPS}. Nothing was deleted to fix it; entries moved, and each says why.
 */
export const OMISSIONS: string[] = [
  'Preview (F5) and Render (F6) as separate actions. OpenSCAD has two because they are two ' +
    'different computations. Here mesh.ts always computes real booleans and always audits the ' +
    'result — one evaluation path — so two buttons would assert a capability difference we do not ' +
    'have.',
  'The Customizer. It reads /* [Section] */ annotations and parameter sets, and this parser reads ' +
    'neither. An empty Customizer would be a claim about your model made by a feature that is not ' +
    'here.',
  /* 🔴 FIVE, NOT ELEVEN. This line used to end "…Find, Indent, bookmarks,
   * tab-conversion", and "the browser already owns those keys" is true of the
   * five below and FALSE of the other six — those have no native equivalent at
   * all. Six absent capabilities were accounted for by somebody else's
   * ownership, which is how a thing nobody owns is also built by nobody. They
   * are in {@link GAPS} now, as work. */
  /* 🔴 NARROWED ON 2026-08-11, IN THE CHANGE THAT BUILT UNDO AND REDO. They are
   * Edit menu items now — but over DOCUMENT states, not keystrokes, and the
   * delegation this line records is still true of the typing undo it was really
   * about. Deleting the entry would drop the claim that Ctrl+Z is the browser's;
   * leaving it whole would say a menu item does not exist while it does. */
  'Cut, Copy and Paste as menu items — and Undo and Redo FOR TYPING. The editor is a textarea and the ' +
    'browser already owns exactly these keys, so an item here would duplicate a native accelerator we ' +
    'cannot reliably invoke — a control that sometimes does nothing. Ctrl+Z in particular is the ' +
    'browser’s per-keystroke undo, with a granularity nothing here can match, and it stays unbound. ' +
    '⚠ Edit → Undo and Edit → Redo DO exist, and they are a different thing: a history over the ' +
    'actions that replace the whole buffer — New, Example, Open, a model’s reply — bound to no key at ' +
    'all. Two recoveries, two gestures; each control says which it is.',
  'Reload, Auto-reload, Open Recent, New Window, Save All, Save a Copy, Close, Quit. There is no ' +
    'file handle in a browser tab and nothing to quit — the file you opened is a copy in this ' +
    'browser, not a path on disk.',
  'Every export format except binary STL — ASCII STL, OBJ, OFF, WRL, AMF, 3MF, DXF, SVG, CSG, PDF, ' +
    'POV and the image export. We can write one of them.',
  'Display AST and Display CSG Products. The scene tree is the evaluated tree; a syntax tree and a ' +
    'product list are different artefacts and neither is produced.',
  'Library info — the dialog listing OpenSCAD\u2019s own search paths and the fonts and libraries it ' +
    'found on the machine. There are no search paths here: File \u2192 Open\u2026 mounts ONE folder you ' +
    'pick, and it is the whole resolution rule, so a dialog describing a search order would be ' +
    'describing something that does not exist. (This line named File \u2192 Open library folder\u2026 ' +
    'until that item merged into Open on 2026-08-11.)',
  /* ⚠ `preferences` WAS IN THIS LINE and is not any more — see {@link GAPS}.
   * The removal is named rather than silent: a word that disappears from a list
   * a reader trusts to be complete leaves them no signal at all, which is worse
   * than the wrong word was. */
  'Font list, Python venv, 3D Print, measure distance/angle, flush caches, the Window menu, the ' +
    'offline manual and the cheat sheet. Nothing here implements what any of them control. ' +
    '(Preferences used to be named in this line and are not, because they exist — see below.)',
];

/**
 * The other kind, kept apart from {@link OMISSIONS} on purpose.
 *
 * 🔴 NOTHING IN THIS LIST IS A DECISION. Each line is either a function this tab
 * genuinely HAS with no menu item in front of it, or one that would work here and
 * has not been built. They are listed because the alternatives are worse in both
 * directions: filed as omissions they read as impossible and nobody builds them;
 * left out entirely, a list a reader trusts to be complete quietly stops being.
 *
 * ⚠ THE OBLIGATION THIS CREATES: an entry leaves this array in the same change
 * that builds or wires it. A capability that ships while its line still says it
 * is missing is the same defect pointing the other way.
 */
export const GAPS: string[] = [
  /* Finding A. The old text — "The preview owns the camera and this change does
   * not touch it" — is a true SCOPE statement, and scope is the one thing an
   * omission list may not contain: a reader of Help → About concluded from it
   * that this tab CANNOT show a top view. */
  /* ⚠ `show axes` LEFT THIS LINE ON 2026-08-11, in the change that built it —
   * View → Show axes and View → Show scale markers are real items now. The
   * removal is named rather than silent, for the same reason `preferences`
   * leaving OMISSIONS was: a word that quietly disappears from a list a reader
   * trusts to be complete leaves them no signal at all. */
  /* ⚠ `a perspective/orthogonal toggle` LEFT THIS LINE ON 2026-08-11, in the
   * change that built it — View → Perspective and View → Orthogonal are real
   * items now, exclusive, persisted, and the CNC tab has the same choice in its
   * sidebar. Named rather than deleted, for the third time on this line and for
   * the same reason: a word that quietly disappears from a list a reader trusts
   * to be complete leaves them no signal at all. */
  'Named camera views — Top/Bottom/Left/Right/Front/Back, and show edges and crosshairs. 🔴 THE ' +
    'CAMERA ITSELF IS NOT MISSING: the preview orbits, pans, zooms, switches between perspective and ' +
    'orthogonal, and carries a Fit control on the picture. What is missing is the named VIEW PRESETS ' +
    'and the menu items that would select them. Read this as "not wired to the menu", never as "this ' +
    'tab cannot show you the top". (Show axes, show scale markers and the projection toggle used to ' +
    'be named in this line and are not, because they are all in the View menu now.)',
  /* Finding B, the half that is not delegated. The browser owns none of these. */
  'Comment and uncomment a block, indent and unindent, bookmarks, and tab-to-space conversion. ' +
    '🔴 THE BROWSER OWNS NONE OF THESE — they are editor commands with no native equivalent, so ' +
    'they are delegated to nothing: they are NOT BUILT. Comment-toggling is the one that costs the ' +
    'most, because the example this tab ships ends by asking you to uncomment a line — the first ' +
    'thing it tells you to do is the thing there is no command for. (Tab is deliberately not trapped ' +
    'in the editor: capturing it would make the textarea a keyboard trap for anyone who arrived by ' +
    'keyboard, so indentation is typed with spaces.)',
  /* 🔴 THE TICK-MARK ENTRY IS GONE FROM THIS ARRAY — it was built on 2026-08-11
   * and a capability comes off the list in the change that adds it. What is left
   * of it is the RESIDUE, which is a smaller and different claim: OpenSCAD draws
   * numbers as Hershey vector text lying in each axis plane and adds extra
   * labels when few majors are visible; ours are camera-facing sprites on every
   * tenth tick only. Both are stated in `rulers.ts` at the arithmetic they
   * diverge from. */
  'Extra scale labels when the zoom sits just above a decade boundary. OpenSCAD prints a number every ' +
    'SECOND minor tick when the view is less than three times its adjusted scale (GLView.cc:543-548), ' +
    'because otherwise one or two major labels are all you can see. Ours numbers every tenth tick and ' +
    'nothing else — so just after zooming past a power of ten there are fewer numbers on screen than ' +
    'OpenSCAD would give you. The ticks themselves are all there.',
  'Find that moves the caret, and replace. The browser’s own find WILL match your source, ' +
    'because the highlight layer under the textarea renders the same characters — so a string can be ' +
    'located. It cannot put the caret there: the caret belongs to the textarea. Degraded rather than ' +
    'absent, and not built.',
  /* Finding C. Three sets of preferences are persisted; what is absent is one
   * place that collects them, which is a different sentence. */
  /* ⚠ NARROWED ON 2026-08-11, IN THE CHANGE THAT BUILT HALF OF IT. `File →
   * Settings…` now exists and collects the Ask configuration. It does NOT
   * collect the pane layout or the two view toggles, so the entry is rewritten
   * to the smaller claim rather than deleted — deleting it would say every
   * preference has a home, and three of them do not. */
  'ONE preferences dialog for everything. File → Settings… exists and holds the Ask pane’s endpoint, ' +
    'model id and key. The other preferences this tab persists are not in it: the pane layout, ' +
    'whether the axes and the scale markers are shown, and the projection, all under ' +
    '2bee.app.cad.layout — those are ' +
    'changed from the View menu, and View → Reset panel layout is a preferences action on them. So ' +
    'there are two places, not one. (Preferences were listed as ABSENT until 2026-08-11, which was ' +
    'false; there was no dialog at all until this change.)',
];

/* ══════════════════════════════════════════════════════════════════════════
   THE ONE BOUND KEY
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every accelerator this bar binds, and the command it runs. See the header for
 * why this is one entry and not four.
 *
 * 🔴 IT IS THE AUTHORITY FOR BOTH DIRECTIONS: `accel` on an item may only name a
 * key in here, and `CadTab.tsx` must actually wire every key in here. A printed
 * key with no binding and a binding with no printed key are both defects, and
 * only a machine-readable list can catch either.
 */
export const BOUND_KEYS: Readonly<Record<string, string>> = { 'Ctrl+S': 'file.save' };

/** The shape of a `KeyboardEvent` this needs, so it can be tested without a DOM. */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The command a key press should run, or `null` for every key this bar leaves
 * alone — which is all of them but one.
 *
 * ⚠ `Ctrl` OR `Cmd`, because a Mac operator's muscle memory is `Cmd+S` and the
 * hazard is identical there. ⚠ And NOT with Alt or Shift held: `Ctrl+Shift+S` is
 * a different gesture in several browsers and taking it would be taking a key
 * nobody asked us to take.
 */
export function commandForKey(e: KeyLike): string | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  if (e.key !== 's' && e.key !== 'S') return null;
  return BOUND_KEYS['Ctrl+S'];
}

/**
 * Handle a key press for the CAD tab. Returns whether it was ours.
 *
 * 🔴 `preventDefault()` IS THE WHOLE POINT AND IT IS NOT OPTIONAL. Binding
 * `Ctrl+S` without it leaves the browser's Save Page dialog appearing ON TOP of
 * our save — the operator would then have BOTH a real save and a downloaded
 * `.html`, and no way to tell which one the dialog was about. The failure this
 * binding exists to remove would survive its own fix.
 *
 * It lives here rather than inline in `CadTab.tsx` so a test can drive it with a
 * fake event and assert that `preventDefault` was called — a source regex over a
 * handler proves the characters are present, not that the path runs.
 */
export function onCadKeyDown(
  e: KeyLike & { preventDefault(): void },
  run: (command: string) => void,
): boolean {
  const command = commandForKey(e);
  if (command === null) return false;
  e.preventDefault();
  run(command);
  return true;
}

/** Everything the bar needs to know about the tab, to say true things. */
export interface CadMenuContext {
  /** The editor differs from what was last opened or saved. */
  dirty: boolean;
  /** Why a save/export cannot happen right now, or null. */
  saveBlocked: string | null;
  /** Whether any diagnostic carries a line to jump to. */
  errorCount: number;
  /**
   * What `Edit → Undo` would reverse, in words, or `null` for nothing to undo.
   *
   * 🔴 IT IS THE LABEL, NOT A BOOLEAN, because this history holds DOCUMENT
   * states rather than keystrokes and a bare *"Undo"* is read as an undo for
   * typing by everybody who has ever used an editor. The item says which action
   * it reverses, and `replace.ts` is the one place that sentence is written.
   */
  undoLabel: string | null;
  /** The same, forward. */
  redoLabel: string | null;
  /** Which bottom pane is showing. */
  bottomTab: string;
  /** Whether the model-edit pane is offered at all. */
  askVisible: boolean;
  /** OpenSCAD's `view/showAxes` — the origin cross and the corner gizmo. */
  axes: boolean;
  /**
   * OpenSCAD's `view/showScaleProportional` — the numbered ticks.
   *
   * ⚠ This is the STORED setting, not what is on screen. While {@link axes} is
   * false the item is disabled and nothing is drawn; the check mark still shows
   * what the operator last chose, so turning axes back on is predictable.
   */
  scaleMarkers: boolean;
  /**
   * OpenSCAD's `view/orthogonalProjection`, as the word.
   *
   * 🔴 IT DRIVES TWO ITEMS, NOT ONE CHECKBOX, because OpenSCAD has two:
   * `viewActionPerspective` and `viewActionOrthogonal` in an EXCLUSIVE
   * `QActionGroup` (`MainWindow.cc:3920-3923`). A single "Perspective" checkbox
   * would render the same state and say a different thing — it makes
   * orthographic the un-named absence of a mode, when it is one of two named
   * modes and is the one that tells the truth about parallel edges.
   */
  projection: 'perspective' | 'orthographic';
  /**
   * The name this model is already saved under, or `null` if it has never been
   * saved. It is what makes `Save` and `Save as…` two different items rather
   * than one item with a dialog bolted on.
   */
  savedName: string | null;
}

/**
 * The bar, as data. Pure and exported so a test can assert that no item exists
 * for a function we do not have, without rendering anything.
 */
export function cadMenus(ctx: CadMenuContext): Menu[] {
  return [
    {
      id: 'file',
      label: 'File',
      /* 🔴 THIS FOOTNOTE USED TO NAME TWO KEYS, CALL BOTH LOST WORK, AND THEN
       * OFFER ONE GUARD AS THE ANSWER TO BOTH. It covered one. `beforeunload`
       * fires on an UNLOAD; Save Page does not unload the document, so Ctrl+S
       * went straight past it — a browser save dialog completed successfully and
       * the operator believed their MODEL was saved, with nothing anywhere to
       * contradict them. A control asserting something untrue about its own
       * coverage, in operator-facing text, is this lane's own named defect.
       *
       * The fix is the binding, not a better sentence: Ctrl+S is intercepted now
       * and the hazard is gone, so the sentence that described it had to go with
       * it. A stale explanation of a fixed problem is its own defect.
       *
       * ⚠ THE TWO DO NOT BOTH FIRE. `preventDefault` on Ctrl+S means no Save
       * Page and no navigation, so there is no unload for `beforeunload` to
       * catch; and a save that succeeds clears `dirty`, which unregisters the
       * guard. They cover disjoint events. */
      footnote:
        'Ctrl+S is bound here and saves this model — it is intercepted, so the browser’s Save Page ' +
        'never appears. F5 is deliberately NOT bound: intercepting it would take your reload away, so ' +
        'unsaved changes raise the browser’s own leave-page warning instead, which covers reload, ' +
        'Ctrl+W, the back button and closing the tab. Ctrl+N is not bound because a browser reserves ' +
        'it and a page cannot intercept it — binding it would advertise a key that does nothing. ' +
        'Ctrl+Z is not bound because inside the editor it is the browser’s own typing-undo, and ' +
        'taking it would leave you with less than you have.',
      items: [
        {
          id: 'file.new',
          label: 'New',
          /* 🔴 THE NOTE NO LONGER SAYS "this asks first" — nothing asks any
           * more (founder, 2026-08-11: *"remove … alerts"*). What it says
           * instead is where the work went, because a replacement that can be
           * put back and one that cannot are the same press at the moment of
           * pressing, and only the first is safe to make silently. */
          note: ctx.dirty
            ? 'Empties the editor. Your changes are not saved anywhere — the toolbar will offer to put them back, one step, and nothing else will.'
            : 'Empties the editor.',
        },
        {
          id: 'file.example',
          label: 'Example',
          note: 'The one model this tab ships. Replaces the editor; the toolbar offers to put back what it replaced.',
        },
        /* 🔴 ONE ITEM, TWO SOURCES (founder, 2026-08-11: *"merge the Open … and
         * Open library folder … — have just 1 open!"*). There WAS a second item,
         * `file.library`, and the argument for it was real: the two actions
         * differ in what they DESTROY, and an operator who reaches for `Open…`
         * expecting a folder and loses their editor has been misled by a label.
         *
         * That argument did not survive the ruling, so it had to be answered
         * somewhere else rather than dropped. It is answered inside the panel:
         * two headed sections, the non-destructive folder mount first and saying
         * it replaces nothing, the destructive list second and saying it does.
         * The distinction moved down a level; it was not deleted.
         *
         * ⚠ AND THE MOUNT ITSELF WAS NOT DELETED WITH THE ITEM. `open.tsx` has
         * no file input of its own, so mounting a folder is the only route from
         * disk into this tab — removing it would have removed the founder's own
         * workflow while appearing to satisfy his instruction. */
        {
          id: 'file.open',
          label: 'Open…',
          separatorBefore: true,
          note:
            'One panel, two places a model can come from: a folder of .scad files on your disk — ' +
            'which is also what include and use resolve against, and mounting it replaces nothing — ' +
            'and the models saved in this browser. Opening either replaces the editor; the toolbar ' +
            'offers to put back what it replaced.',
        },
        /* 🔴 TWO ITEMS, AND THE DIFFERENCE IS WHETHER ANYTHING INTERRUPTS
         * (founder, 2026-08-11: *"File Save... should bring up a window
         * (similar to the list) to save, not an alert"*). OpenSCAD carries both
         * and the distinction earns its keep here: a model that already has a
         * name just saves, silently, which is the principle this whole pass
         * applies; a model that has never been saved has no name to save under,
         * so `Save` falls through to the dialog once and then stops asking.
         *
         * ⚠ THE ELLIPSIS IS A PROMISE. `Save…` with dots means a chooser
         * appears; `Save` without them means it acts. So the label carries the
         * dots only in the case where it will actually open one. */
        {
          id: 'file.save',
          label: ctx.savedName === null ? 'Save…' : `Save "${ctx.savedName}"`,
          /* 🔴 THE ONE PRINTED KEY IN THE BAR, and it is printed because it is
           * bound — `BOUND_KEYS` is the authority and a test compares the two.
           * It is printed on BOTH forms of this item deliberately: the key does
           * the same thing either way (act on a named model, ask once on an
           * unnamed one), and a key that appears and disappears with the label
           * would read as a key that sometimes exists. */
          accel: 'Ctrl+S',
          disabled: ctx.savedName !== null && !!ctx.saveBlocked,
          disabledReason: ctx.savedName !== null ? (ctx.saveBlocked ?? undefined) : undefined,
          note:
            ctx.savedName === null
              ? 'This model has never been saved, so this brings up the list to name it in. After that, Save just saves.'
              : `Writes straight over "${ctx.savedName}" in the drawings list — the list the CNC tab cuts from. No dialog, and the record it replaces is gone.`,
        },
        {
          id: 'file.save-as',
          label: 'Save as…',
          note: 'Brings up the drawings list, so a name already taken is visible BEFORE the save that would replace it.',
        },
        /* 🔴 THE ASK PANE'S SETTINGS LIVE HERE NOW (founder, 2026-08-11: *"when
         * endpoint set move it to the settings tab under File and hide"*). It is
         * a File item rather than a menu of its own because the founder named
         * File, and because a sixth menu holding one item is the shape this bar
         * spent the day removing.
         *
         * ⚠ IT IS NOT DISABLED WHEN NOTHING IS CONFIGURED, and it is not hidden
         * when everything is. It is the only permanent door to the endpoint, the
         * model id and the key — and the moment it matters most is when a
         * configured endpoint is BROKEN, which is precisely when the pane has
         * collapsed and stopped offering them. */
        {
          id: 'file.settings',
          label: 'Settings…',
          separatorBefore: true,
          note:
            'The endpoint, the model id and the API key the Ask pane uses — and the statement of what ' +
            'leaves this browser. They are here so the pane can be the prompt box alone once they are ' +
            'set. Nothing is sent by opening this.',
        },
        {
          id: 'file.export.stl',
          label: 'Export as STL (binary)…',
          separatorBefore: true,
          disabled: !!ctx.saveBlocked,
          disabledReason: ctx.saveBlocked ?? undefined,
          note: 'The only format this tab can write. Refused on exactly the same terms as a save.',
        },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        /* 🔴 UNDO AND REDO EXIST NOW, AND THEY CARRY NO ACCELERATOR (founder,
         * 2026-08-11: *"2bee.cad: Have an undo, redo option"*).
         *
         * `Ctrl+Z` stays unbound, which is the same "no" this bar's header
         * records: inside the focused textarea it is the browser's own
         * per-keystroke typing-undo, and {@link OMISSIONS} delegates exactly
         * that. Binding it here would trade a whole typing history for a handful
         * of document steps and make the delegation claim false. An `accel`
         * field may only name a key `BOUND_KEYS` lists, so there is none — a
         * printed `Ctrl+Z` beside an item that did something ELSE than the key
         * does would be worse than a dead control.
         *
         * ⚠ THE LABELS NAME THE ACTION rather than saying "Undo", because this
         * is a document history and not a typing one. The distinction is the
         * whole reason it was safe to build. */
        {
          id: 'edit.undo',
          label: ctx.undoLabel || 'Undo',
          disabled: !ctx.undoLabel,
          disabledReason:
            /* ⚠ THE KEY IS NOT NAMED HERE, deliberately, and it cost a
             * rewording. This bar's rule is that free text may never name a
             * keyboard shortcut — an accelerator inside a sentence cannot be
             * compared to `BOUND_KEYS`, which is how a four-keys-one-reason
             * footnote went unexamined for weeks. The rule bites even when the
             * key being named is one we deliberately do NOT bind, and narrowing
             * it to allow that would make it unenforceable. */
            'Nothing has replaced the editor yet. This steps back through New, Example, Open and a ' +
            'model’s reply — not through your typing, which stays with the browser’s own undo.',
          note: 'The same history as the button in the toolbar, reached from here. Not an undo for typing.',
        },
        {
          id: 'edit.redo',
          label: ctx.redoLabel || 'Redo',
          disabled: !ctx.redoLabel,
          disabledReason:
            'There is nothing to step forward to. Typing clears it: once you have edited, the state a ' +
            'Redo would restore is one you have moved away from.',
          note: 'Steps forward through the same document history.',
        },
        {
          id: 'edit.jump-error',
          label: 'Jump to next error',
          separatorBefore: true,
          disabled: ctx.errorCount === 0,
          disabledReason: 'Nothing is currently reported against this source.',
          note: 'Cycles through every error, refusal and warning, in the order the console lists them.',
        },
      ],
    },
    {
      id: 'design',
      label: 'Design',
      items: [
        {
          id: 'design.check-validity',
          label: 'Check Validity',
          note: 'Reports the manifold audit that already ran — closure, orientation, degenerate faces — per solid.',
        },
        { id: 'design.csg-tree', label: 'Display CSG Tree', note: 'Shows the evaluated scene tree in the bottom pane.' },
        ...(ctx.askVisible
          ? [
              {
                id: 'design.ask',
                label: 'Ask a model to change this source…',
                separatorBefore: true,
                note: 'The only thing in this app that sends anything anywhere, and it sends nothing until you configure it.',
              } satisfies MenuItem,
            ]
          : []),
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'view.console', label: 'Console', checked: ctx.bottomTab === 'console' },
        /* 🔴 THE SCENE TREE IS NO LONGER A PERMANENT TAB (founder, 2026-08-11:
         * *"Remove Scene Tree"*), so THESE TWO ITEMS ARE NOW ITS ONLY DOOR.
         * Removing the pane instead would have left `Design → Display CSG Tree`
         * pointing at nothing — the dead-control shape this lane keeps finding.
         *
         * 🔴 `view.about` IS GONE with the pane it showed. A menu item for a
         * pane that no longer exists is that same defect in the other direction,
         * so the item left in the same commit as the banner. */
        { id: 'view.tree', label: 'Scene tree', checked: ctx.bottomTab === 'tree' },
        ...(ctx.askVisible
          ? [{ id: 'view.ask', label: 'Ask a model', checked: ctx.bottomTab === 'ask' } satisfies MenuItem]
          : []),
        /* 🔴 TWO ITEMS AND A PARENT-CHILD RELATIONSHIP, BECAUSE THAT IS WHAT
         * OPENSCAD HAS — read at `MainWindow.cc:2759-2763`, where the axes
         * handler runs `viewActionShowScaleProportional->setEnabled(checked)`,
         * and at `GLView.cc:198`, where the renderer draws the markers only on
         * `showaxes && showscale`. Two INDEPENDENT toggles would let an operator
         * switch scale markers on, see nothing, and be told by the check mark
         * that they are on — the dead-control shape this bar exists to avoid,
         * arriving as a stale green rather than as a grey item. */
        {
          id: 'view.axes',
          label: 'Show axes',
          separatorBefore: true,
          checked: ctx.axes,
          note:
            'The cross through [0,0,0] and the X/Y/Z arrows in the corner — OpenSCAD draws both off ' +
            'this one flag. Turning it off also turns off the scale markers, and leaves nothing on ' +
            'screen marking where zero is.',
        },
        {
          id: 'view.scale-markers',
          label: 'Show scale markers',
          checked: ctx.scaleMarkers,
          disabled: !ctx.axes,
          disabledReason:
            'Scale markers are ticks ON the axes, so there is nothing for them to sit on while the ' +
            'axes are off. OpenSCAD disables this item for the same reason. Your choice is remembered ' +
            'and comes back when you turn the axes on.',
          note:
            'Numbered ticks along each axis. The spacing steps by a power of ten as you zoom, so the ' +
            'numbers stay readable — the same rule OpenSCAD uses, and the numbers are millimetres.',
        },
        /* 🔴 TWO ITEMS IN AN EXCLUSIVE PAIR, MIRRORING OPENSCAD'S OWN
         * `viewActionProjectionGroup` (`MainWindow.cc:3920-3923`,
         * `setExclusive(true)`). Selecting one selects it; there is no way to
         * select neither, and pressing the one already checked is a no-op rather
         * than a toggle back to an unnamed state.
         *
         * ⚠ THE NOTES SAY WHAT EACH MODE DOES TO A MEASUREMENT, not which looks
         * nicer. On this tab the stake is lower than on the CNC tab — nothing
         * here emits G-code — but the sentence is the same sentence, and it is
         * the reason the CNC tab defaults the other way. */
        {
          id: 'view.projection.perspective',
          label: 'Perspective',
          separatorBefore: true,
          checked: ctx.projection === 'perspective',
          note:
            'Distant things are drawn smaller and parallel edges converge, so the model reads as a ' +
            'shape. OpenSCAD starts here too. Measure nothing off this view: two edges that are ' +
            'parallel in the model are not parallel on the screen.',
        },
        {
          id: 'view.projection.orthogonal',
          label: 'Orthogonal',
          checked: ctx.projection === 'orthographic',
          note:
            'No convergence and no foreshortening: an edge that is parallel in the model is parallel ' +
            'on the screen, and two things that overlap in the picture overlap in the model. Zoom, ' +
            'pan and Fit behave exactly as they do in perspective — the camera does not move when you ' +
            'switch.',
        },
        {
          id: 'view.reset-layout',
          label: 'Reset panel layout',
          separatorBefore: true,
          note: 'Puts the splitters back where they started. Touches nothing in your model.',
        },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        {
          id: 'help.about',
          label: 'About 2bee.cad',
          note: 'Including everything OpenSCAD has that this does not, and the reason for each.',
        },
      ],
    },
  ];
}

export interface MenuBarProps {
  menus: Menu[];
  onCommand(id: string): void;
  testid?: string;
}

/** The WAI-ARIA menubar pattern. See the header. */
export function MenuBar({ menus, onCommand, testid = 'cad-menubar' }: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((refocus: boolean) => {
    setOpen(null);
    if (refocus) buttons.current[focusedRef.current]?.focus();
  }, []);

  /* `focused` is read inside a callback that must not be rebuilt on every
   * change, so the index is mirrored in a ref. One value, one writer. */
  const focusedRef = useRef(0);
  focusedRef.current = focused;

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
        // Focus the first item once the popup exists.
        queueMicrotask(() => {
          root.current
            ?.querySelector<HTMLButtonElement>(`[data-menu="${menus[i].id}"] [role="menuitem"]:not([disabled])`)
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
      aria-label="2bee.cad menu"
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
            data-testid={`cad-menu-${m.id}`}
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
              data-testid={`cad-menu-popup-${m.id}`}
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
                boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
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
                    data-testid={`cad-menuitem-${it.id}`}
                    disabled={it.disabled}
                    onKeyDown={(e) => onItemKey(e, m.id)}
                    onClick={() => {
                      setOpen(null);
                      onCommand(it.id);
                    }}
                    onMouseEnter={(e) => { if (!it.disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
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
                    {/* Only ever a key `BOUND_KEYS` names — see {@link MenuItem.accel}. */}
                    {it.accel ? (
                      <span data-testid={`cad-menuaccel-${it.id}`} style={{ color: 'var(--muted)' }}>
                        {it.accel}
                      </span>
                    ) : null}
                  </button>
                  {/* 🔴 The reason travels with the control, never in a footnote
                      somewhere else. A disabled item with no reason is a puzzle,
                      and this app's convention is to say. */}
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
                  data-testid={`cad-menu-footnote-${m.id}`}
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
