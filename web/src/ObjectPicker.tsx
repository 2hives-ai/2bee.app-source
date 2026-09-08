/* ObjectPicker — the one way this app puts a list of objects in front of a user.
 *
 * Founder, 2026-08-08: "There should be a standard way to add objects to the
 * app: All files, objects (Drawing, Machine, Workpiece, Tools … etc). When I
 * click on it should bring up a list (same style), when I select one show the
 * properties of the object, this list should be searchable, able to add one
 * (e.g. machine) or more (e.g. tools, Drawings) to the app. I do not like the
 * drop down, can't search in it. This list became a standard (branding)."
 *
 * The spec — props, the two rules, the keyboard contract — is `objectPicker.md`
 * next to this file. Read that before changing behaviour here; `brand` may lift
 * it into the design system, in which case that file is the canon and this file
 * is one implementation of it.
 *
 * ── TWO RULES THAT ARE NOT NEGOTIABLE ──────────────────────────────────────
 *
 * 1. SEARCH NEVER HIDES AN ITEM FOR BEING UNUSABLE.  This app deliberately
 *    lists things it will not let you use, with the reason: a tool no collet
 *    can hold, a workpiece too big for the machine, a workpiece that only fits
 *    turned 90°. On screen a hidden item and a non-existent item are IDENTICAL, and in
 *    a machining tool that difference decides whether someone goes and finds a
 *    collet or concludes the tool does not exist. So: the search box narrows by
 *    NAME only, disabled items stay in the list with their reason, and whatever
 *    the search string hides is COUNTED where the user can see it — including
 *    how many of the hidden ones were unusable.
 *
 * 2. KEYBOARD IS A REGRESSION, NOT A NICETY.  A native <select> gives type-
 *    ahead, arrow keys, Enter and Escape for free; a hand-rolled list loses all
 *    four unless they are built. All four are built here, on the ARIA combobox/
 *    listbox/aria-activedescendant model. This is a tool used with one hand on
 *    a machine — "find the mouse" is a bad instruction in a workshop.
 *
 * ── AND ONE THING THIS COMPONENT DOES NOT DO ───────────────────────────────
 *
 * It does not describe an object. The tool's fit verdict, the workpiece's
 * footprint and turn, the machine's collets are all facts the Rust core owns; they arrive
 * here as `detail`, `disabledReason` and `properties` DATA and are rendered
 * verbatim. This app has twice had a machining rule re-derived in TypeScript
 * where no gate could see it. Nothing in this file computes a verdict, formats
 * a dimension, or decides that something is usable — a `disabled` item is
 * disabled because the caller said so.
 *
 * Styling: every colour, radius and font comes from the CSS custom properties
 * the app already defines (`--bg`, `--panel`, `--ink`, `--muted`, `--line`,
 * `--accent`, `--ok`, `--bad`, `--warn`, `--radius`, `--mono`), which resolve
 * to `brand/tokens.css`. There is no hex literal in this file, deliberately: a
 * hex here would be the one value that stops matching when brand changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
/* The one resize in this app. Every list gets its edges from here — see the
 * header of `resizable.tsx` for why there is exactly one of them. */
import { useResizable } from './resizable';

/* ── THE HEADING THIS PICKER IS SITTING UNDER ──────────────────────────────────
 *
 * 🔴 FOUNDER, 2026-08-11 (TODO #77): *"most of the menus having the header, then
 * the header repeats — like `Machine` / `Machine ▾`. Remove the duplicates from
 * EVERYWHERE."* Measured again the same day: four exact repeats — **Machine ·
 * Spoilboard · Workpiece · Drawing**. `Work holding → Hold-down`, `Tooling →
 * Tool`, `Machine → Touch plate` and `Workpiece → Material` differ and are left
 * alone; they are a heading and a thing inside it, not a heading said twice.
 *
 * 🔴 **THE FIX IS NOT TO DELETE THE LABEL.** `label` is what names the LISTBOX
 * (`aria-labelledby={uid-label}` below), so removing the span would trade a
 * visual annoyance for a listbox a screen reader announces as nothing — a bad
 * trade, and an invisible one, because the markup of the fix and the markup of
 * the defect look identical. The VISIBLE half is suppressed; the ANNOUNCED half
 * stays, exactly the distinction this file already draws for `shape.label`.
 *
 * ⚠ **A MECHANISM, NOT EIGHT CALL SITES.** The rule is *"do not print a visible
 * label that repeats my heading"*, and it is stated once, here, so it also
 * covers the ninth panel somebody adds next month. Eight hand-edited call sites
 * would be eight chances to forget, and the forgotten one is the defect.
 *
 * ⚠ A picker rendered outside any provider (`web/src/cad/`) sees `''` and
 * behaves exactly as it did before this existed. That is deliberate: this is not
 * a cross-lane change dressed as a shared component.
 */
export const SectionHeadingContext = createContext<string>('');

/**
 * Does this picker's label say the same thing as the heading above it?
 *
 * 🔴 EXACT, case- and space-insensitive equality, and **no stemming**. `Tool`
 * must NOT match `Tooling` and `Hold-down` must not match `Work holding`: those
 * are a panel and a thing inside it, and suppressing the label there would leave
 * a control with no visible name at all. A looser comparison buys nothing and
 * can only ever hide something it should not.
 *
 * Exported, and pure, because it is the whole rule and there is no browser here
 * — a rule nobody can watch fail is not a rule.
 */
export function labelRepeatsHeading(label: string, heading: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  return heading !== '' && norm(label) === norm(heading);
}

/* ── Data in, opinions out ─────────────────────────────────────────────────── */

/** One row of the properties view. `value` is rendered as given. */
export interface ObjectProperty {
  label: string;
  value: string | number;
  /**
   * Present ⇒ this property is an INPUT and may be edited here. Absent ⇒ it is
   * DERIVED and renders as text.
   *
   * 🔴 That distinction is the safety rule of this whole component, not a
   * convenience. A tool's diameter, flutes and chipload window are inputs. Its
   * FIT VERDICT — "12mm shank; the shop's collets are 6mm, 3.175mm, 6.35mm,
   * 8mm" — is the CORE'S ANSWER about that tool on this machine. A workpiece's
   * size is an input; "fits turned 90°" is derived. Letting someone type over a
   * derived value produces a green that means nothing, which is the exact
   * failure this lane exists to prevent. Callers pass `input` ONLY for fields
   * the core takes as arguments.
   */
  input?: {
    kind: 'number' | 'text' | 'bool';
    /** Field this maps to in the caller's object. Returned in the draft. */
    key: string;
    step?: number;
    min?: number;
    max?: number;
    unit?: string;
  };
}

/** One selectable object — a machine, a workpiece, a drawing, a tool, a sample. */
export interface ObjectItem {
  /** Stable identity. Selection, keys and `aria-activedescendant` all key on it. */
  id: string;
  /** What the user searches by. Search matches THIS and nothing else. */
  name: string;
  /** One short line under the name (e.g. "6 mm shank · 3 flute"). Not searched. */
  detail?: string;
  /**
   * This row's answer to the host's FACET — see {@link ObjectPickerProps.facet}.
   * `undefined` means the row does not state one, which is a real answer and is
   * reachable through the facet's own "not stated" option rather than being
   * quietly excluded.
   *
   * 🔴 It is a VALUE, not a filter, and nothing in this component interprets it.
   * The comparison is `facet.matches`, supplied by the host, for the same reason
   * `disabled` is: a component that decided what "plywood" meant would be a
   * second place a domain rule lived.
   */
  facet?: string;
  /** True ⇒ present in the list, visible, readable, but not selectable. */
  disabled?: boolean;
  /**
   * `true` for the built-ins — the shipped machine presets, the tool library,
   * the sample drawings. They can be EDITED and then only kept with "Save as":
   * the built-in itself never changes, so a shop can always get back to a known
   * starting point. A user's own saved object also gets a plain "Save".
   */
  builtIn?: boolean;
  /*
   * 🔴 `icon` IS GONE — founder, 2026-08-10: the drawing belongs on the
   * PROPERTIES PANEL ONLY. It was a 22x24px schematic beside the name in every
   * option row, which is the size at which a shank step and a flute length —
   * the two facts the drawing exists to show — are exactly what you cannot see.
   * The panel keeps `shape` below, at `pane` size, where it is legible and where
   * it is a primary description rather than decoration.
   *
   * The FIELD is removed rather than merely left unrendered: a prop a component
   * accepts and ignores is a control that looks live and is not, and every
   * caller in this app passed the same node to both fields anyway.
   */
  /**
   * The SAME drawing, larger, on the properties panel — founder, 2026-08-09:
   * *"the all images in the list (like for the Hold-down should be presented on
   * the property (right) panel)"*.
   *
   * 🔴 IT IS NOT `aria-hidden`. This is now the ONLY place a drawing appears —
   * the row copy was removed 2026-08-10 — and on the properties panel it is a
   * PRIMARY DESCRIPTION of the object, often the only place the shank step, the
   * under-arm clearance or which face the plate registers on is legible at all.
   * Hiding a primary description from a screen reader is the wrong way round.
   * So `label` is REQUIRED by the type — unchanged by the row removal, and worth
   * saying because it now carries the whole weight: a picture that says
   * something nobody can read as text is a claim only sighted users get to
   * check, and there is no longer a second rendering anywhere to fall back on.
   *
   * ⚠ `label` must be derived from THE SAME FIELDS THE SHAPE IS DRAWN FROM, not
   * written beside it. A caption composed independently drifts from the drawing
   * silently, and the drawing is the thing people will believe.
   *
   * ⚠ And there is deliberately NO fallback. A catalogue with no honest shape —
   * a machine, a workpiece, a saved setup — passes nothing, and the panel simply
   * has no picture. A placeholder would be a picture of nothing, which reads as
   * a fact. (`ToolShape` already refuses in the same direction: a row that
   * states no diameter gets an empty dashed frame, never a generic bit.)
   */
  shape?: { node: React.ReactNode; label: string };
  /**
   * Whether THIS row may be deleted, when the host supplies `onRemoveItem`.
   * Defaults to `!builtIn`.
   *
   * 🔴 Added 2026-08-09 with the merged lists, and it is a safety default rather
   * than a convenience. Before this, `onRemoveItem` put a delete control on
   * EVERY row — which was harmless while a list held only the user's own saved
   * objects, and stops being harmless the moment a shipped catalogue entry and a
   * saved one are in the same list (founder: one list for all drawings, presets
   * and saved machines together). Deleting a built-in has no way back: it is in
   * the bundle, not in IndexedDB, so the control would either do nothing or
   * remove something that reappears on reload. Both are worse than no control.
   */
  removable?: boolean;
  /** Why it cannot be used, in the core's words. Shown whenever `disabled`. */
  disabledReason?: string;
  /** Everything the core says about this object. Rendered verbatim, in order. */
  properties?: ObjectProperty[];
  /**
   * A STATEMENT THE OPERATOR MAKES ABOUT THIS ROW, written immediately — see
   * {@link RowClaim}. `undefined` on a list where there is nothing to state.
   */
  claim?: RowClaim;
}

/* ── A statement about the row, as opposed to a property OF it ────────────────
 *
 * 🔴 IT IS NOT AN `ObjectProperty`, AND THE DIFFERENCE IS THE WHOLE REASON THIS
 * TYPE EXISTS. A property with `input` is an EDIT TO THE OBJECT: it lands in
 * `draft` and does nothing at all until Save or Save as, which is right, because
 * a diameter half-typed must not reach a plan. A claim is an assertion about the
 * SHOP — *I have this cutter* — it belongs to no draft, there is nothing to save
 * it under, and holding it behind a Save button would produce a control that
 * appears to answer a question and does not.
 *
 * ⚠ AND IT IS DELIBERATELY NOT A BOOLEAN. The first host of this is the ownership
 * axis, whose four verdicts include `unchecked` — *nobody has said* — which a
 * checkbox cannot express and would silently merge into "no". `docs/terminology.md`
 * carries that as a safety-bearing distinction. So the shape is a value out of a
 * host-supplied set, every member of which is LISTED even when it cannot be
 * chosen, with the reason — `ObjectPicker` rule 1, applied to a control instead
 * of a row.
 *
 * ⚠ NOTHING HERE INTERPRETS A VALUE. This component does not know what ownership
 * is, does not decide which option is available, and does not write anything: it
 * renders what the host stated and calls back. Same rule as `disabled`, `facet`
 * and `detail`.
 *
 * ⚠ WHERE IT RENDERS, AND WHY NOT ON THE ROW. It is on the PROPERTIES PANEL, not
 * in the list, because a `role="option"` must not contain a focusable control:
 * the two affordances already inside a row (`op-rm`, the chips' ×) are
 * `tabIndex={-1}` mouse-only shortcuts with keyboard routes of their own, and a
 * claim is not a shortcut — it is the answer to a question, and a keyboard
 * operator has to be able to give it. The panel is also where the row's existing
 * ownership sentences already are, so the control sits with the reason.
 */
export interface RowClaimOption {
  value: string;
  label: string;
  /** Present ⇒ listed and NOT choosable, with this as the reason. */
  unavailable?: string;
}

export interface RowClaim {
  /** Names the control for sighted users and for AT, e.g. "Do you own this?". */
  label: string;
  /** The row's CURRENT value. Must be one of `options` — see the render note. */
  value: string;
  options: RowClaimOption[];
  /** Called with the chosen value. Never called for an unavailable one. */
  onChange(value: string): void;
  /** What this control means here, from the host. Rendered under it. */
  note?: string;
  /**
   * What choosing something would do BEYOND this row — e.g. a first mark that
   * changes what every other row means. Rendered as a warning, only while the
   * host supplies one, because a consequence printed permanently is one nobody
   * reads by the third time.
   */
  consequence?: string;
}

export type PickerMode = 'single' | 'multi';

/**
 * One narrowing control beside the search box.
 *
 * 🔴 **A LIST OF THEM, SINCE 2026-08-11, AND THEY AND-TOGETHER.** Founder:
 * *"in the tool section add a drop down filter: Selected (this will show the
 * selected tools); same for all other lists"*. *Selected* and *recommended* are
 * **independent axes** — a tool can be selected and not recommended, which is
 * exactly the case an operator most wants to look at — so a second facet could
 * not replace the first. This prop was singular; making it plural is the
 * substance of that change and everything else follows from it.
 *
 * 🔴 SUBJECT TO RULE 1, EXACTLY LIKE THE SEARCH BOX. A facet narrows by a value
 * the row STATES; it can no more hide a row for being unusable than the search
 * box can, because it never sees `disabled`. Whatever each one hides is COUNTED
 * at the foot of the dialog, **attributed to the control that hid it**, so
 * *"there are no plywood sheets"* and *"the Material filter is hiding the
 * plywood sheets"* are never the same picture — and neither is *"the Selected
 * filter is"*.
 *
 * ⚠ A DROPDOWN, in a component whose founding complaint was *"I do not like the
 * drop down, can't search in it"*. That objection was about CHOOSING AN OBJECT
 * from an unsearchable list of many. This selects a FACET from a short, closed
 * set, and the thing it narrows is still the searchable list below. Different
 * control, different job; the objection does not carry over.
 *
 * ⚠ The options, their labels and their counts all come from the host. This
 * component does not know what a material is, does not compute a count, and does
 * not decide which rows a value covers — `matches` does that. The ONE exception
 * is the built-in *Selected* facet below, and it is an exception precisely
 * because "is this row selected" is this component's own state rather than a
 * domain rule.
 */
export interface Facet {
  /** Names the control for sighted users and for AT, e.g. "Material". */
  label: string;
  /** `''` conventionally means "everything"; the host owns the vocabulary. */
  value: string;
  /** In the host's order. A count of 0 is still listed — an option that
   *  disappears when nothing matches it hides the fact that nothing does. */
  options: { value: string; label: string; count: number }[];
  onChange: (value: string) => void;
  /**
   * Does this row pass that value? Supplied by the host so no domain rule
   * lives in here. Never called for `''`, which always passes.
   */
  matches: (item: ObjectItem, value: string) => boolean;
}

/* ── The built-in SELECTED facet ──────────────────────────────────────────────
 *
 * 🔴 IT IS BUILT IN RATHER THAN ASKED OF EVERY HOST, AND THAT IS THE ONE PLACE
 * THIS FILE IS ALLOWED TO OWN A FACET. *"Is this row selected"* is this
 * component's own state — it already holds `selectedIds` and renders the tick
 * from it. Asking eight call sites to re-derive it would be eight copies of one
 * answer, and the founder asked for it on every list, so the first one that was
 * forgotten would be the defect.
 *
 * ⚠ IT IS NOT PERSISTED, deliberately, and neither is any host facet. A filter
 * restored from a previous session hides rows the operator did not hide, in a
 * list they have no reason to think is filtered — the same argument that keeps
 * the workpiece-edge toggle out of storage. It also resets when the popup
 * closes: a narrowing control that survives the dialog it lives in is a
 * narrowing control nobody can see.
 */
export const SELECTED_FACET_LABEL = 'Selected';
type SelectedFacetValue = '' | 'selected' | 'unselected';

/**
 * Apply every active facet in order, and say WHICH ONE removed what.
 *
 * 🔴 **ATTRIBUTION IS SEQUENTIAL, AND IT HAS TO BE.** The facets AND together, so
 * one row can fail more than one of them, and a per-facet *"this one alone would
 * hide N"* would not sum to the total. Each stage counts the rows removed AT
 * THAT STAGE, so the numbers add up exactly — and clearing one control re-runs
 * the pipeline and re-attributes whatever it was masking. A row hidden by two
 * controls is reported under the first; clear that one and it moves to the
 * second, which is precisely the sequence an operator clearing controls one at a
 * time experiences.
 *
 * ⚠ WHY A BARE TOTAL IS NOT ACCEPTABLE. *"12 hidden"* leaves the operator
 * clearing the wrong control, and if they clear the search while a facet is
 * still on, the list stays short and reads as *"there are none"* — which, on a
 * machining list, is the difference between walking to the drawer and concluding
 * the cutter does not exist.
 *
 * 🔴 IT NEVER SEES `disabled`. Rule 1: nothing in this component hides a row for
 * being unusable. A facet narrows by a value the row STATES, and that is all.
 *
 * Exported, and pure, because it is the one piece of this component a node test
 * can drive — there is no browser here, and a rule nobody can watch fail is not
 * a rule.
 */
export function narrowingStages(
  items: readonly ObjectItem[],
  facets: readonly Facet[]
): { rows: ObjectItem[]; byFacet: { label: string; hidden: number }[] } {
  const byFacet: { label: string; hidden: number }[] = [];
  let cur = items as ObjectItem[];
  for (const f of facets) {
    if (f.value === '') continue;
    const next = cur.filter((it) => f.matches(it, f.value));
    byFacet.push({ label: f.label, hidden: cur.length - next.length });
    cur = next;
  }
  return { rows: cur, byFacet };
}

/**
 * One facet option whose STATED count disagrees with the rows its own `matches`
 * would leave. See {@link facetCountMismatches}.
 */
export interface FacetCountMismatch {
  facet: string;
  option: string;
  /** What the dropdown prints. */
  stated: number;
  /** What `matches` actually leaves, over the same full set. */
  actual: number;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE COUNT IN THE DROPDOWN MUST EQUAL THE ROWS THE LIST WOULD SHOW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The founder, 2026-08-11, pasted a machine list reading **`All (3)` over four
 * rows**. Whatever produced that particular paste, the SHAPE of it is a defect
 * this component was structurally unable to notice, and it is worth stating
 * plainly why: **`count` and `matches` are two separate host-supplied answers to
 * one question, and nothing has ever compared them.** A host computes its counts
 * over one collection and hands `items` built from another — the tool picker
 * counts `lib.tools + toolInv.extras`, the drawing picker counts `drawingItems`,
 * the workpiece picker counts `SHEET_SIZES + saved` — and the day any of those
 * two expressions drift apart, the dropdown says one number and the list shows a
 * different one. The operator has no way to tell which is lying.
 *
 * On a machining list that is not cosmetic. *"Recommendation: usable (2)"* over
 * three usable cutters, or over one, is the difference between walking to the
 * drawer and concluding the cutter does not exist — the same argument that put
 * the attributed hidden-count in the foot.
 *
 * 🔴 THE COMPARISON IS OVER THE FULL `items` SET, NEVER OVER WHAT SURVIVED THE
 * OTHER FACETS, and that is a rule for hosts as much as for this function. The
 * facets AND together, so a count taken after another facet had narrowed the
 * list would change every time an unrelated control moved. Every option's count
 * is *"how many of everything here state this value"*; what the list currently
 * SHOWS after several controls is the foot's job, attributed, and always ≤ this.
 *
 * ⚠ SO THIS CANNOT PRODUCE A FALSE RED FROM MULTIPLE FACETS. It never looks at
 * the narrowed rows. It puts two of the host's own outputs in contact and reports
 * only where they contradict each other.
 *
 * ⚠ AND IT SAYS NOTHING ABOUT WHETHER EITHER NUMBER IS *RIGHT*. Both can be
 * wrong together — a host that derives its rows and its counts from the same
 * stale list is self-consistent and still lying. This catches the disagreement,
 * which is the case nobody can see on screen; a wrong-but-agreeing pair is a
 * different check and does not exist.
 *
 * Pure and exported so a node test can drive it: there is no browser here, and
 * an assertion nobody has watched fail is not an assertion.
 * ───────────────────────────────────────────────────────────────────────────── */
export function facetCountMismatches(
  items: readonly ObjectItem[],
  facets: readonly Facet[]
): FacetCountMismatch[] {
  const out: FacetCountMismatch[] = [];
  for (const f of facets) {
    for (const o of f.options) {
      /* `''` is never passed to `matches` — the `Facet` contract says it always
       * passes — so its count is the whole set BY DEFINITION. That is the exact
       * pair the founder's paste put side by side. */
      const actual =
        o.value === '' ? items.length : items.filter((it) => f.matches(it, o.value)).length;
      if (o.count !== actual) {
        out.push({ facet: f.label, option: o.label, stated: o.count, actual });
      }
    }
  }
  return out;
}

/** The sentence the picker prints when a count and its own filter disagree. */
export function describeFacetCountMismatch(m: FacetCountMismatch): string {
  return (
    `the ${m.facet} filter offers “${m.option}” with a count of ${m.stated}, and its own rule ` +
    `matches ${m.actual} of the rows in this list`
  );
}

export interface ObjectPickerProps {
  /** Field label, e.g. "Machine", "Tools". Also names the search box for AT. */
  label: string;
  /** The full set. Never pre-filter this to "the usable ones" — see rule 1. */
  items?: ObjectItem[];
  /** `'single'` = one machine/workpiece. `'multi'` = a SET of tools/drawings. */
  mode?: PickerMode;
  /** Selected ids. An array in BOTH modes; single mode uses `[0]` and ignores the rest. */
  selectedIds?: string[];
  /** Required. A picker that cannot report a change is a control that looks live and is not. */
  onChange: (ids: string[]) => void;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Search box placeholder. */
  searchPlaceholder?: string;
  /**
   * The host's narrowing controls beside the search box — founder, 2026-08-11:
   * *"able to filter workpiece by material via a drop down"*, and then *"add a
   * drop down filter: Selected … same for all other lists"*.
   *
   * 🔴 A LIST, AND THEY AND-TOGETHER. See {@link Facet} for the rule, the
   * attribution and why the built-in *Selected* facet is the one exception to
   * "the host owns every facet". A host that supplies none still gets that one.
   */
  facets?: Facet[];
  /** Host's own add flow. When absent, no "+" is shown — this component never invents one. */
  onAdd?: () => void;
  /** Label for the "+" affordance. */
  addLabel?: string;
  /**
   * Host's own delete flow for an object. When absent, rows carry no remove
   * control; when present, only rows whose `removable` is true (default
   * `!builtIn`) get one.
   */
  onRemoveItem?: (item: ObjectItem) => void;
  /**
   * Host controls that act on the LIST rather than on an item — import a tool
   * file, export the library. Rendered in the search row beside `+ add`.
   *
   * Founder, 2026-08-09: *"tooling, remove the Export tools, Choose File (new)
   * from the left navbar, put this functionality into the list"*. The standing
   * rule this serves is that the left panel shows PROPERTIES, read-only, and
   * every add / import / export / delete lives in the standardised list — so
   * this slot exists to stop the next panel growing its own file controls again.
   *
   * ⚠ It takes a node rather than a callback because export and import are
   * different shapes (a button and an `<input type="file">`), and a component
   * that invented a file input would be guessing the accepted types.
   */
  actions?: React.ReactNode;
  /**
   * Save edits over the SAME object. Offered only for an item that is not
   * `builtIn` — overwriting your own named thing is ordinary; overwriting the
   * shipped tool library is not, and there would be no way back.
   */
  onSave?: (item: ObjectItem, draft: Record<string, string | number | boolean>) => void;
  /** Save the edits under a NEW name. The only way to keep a change to a built-in. */
  /**
   * Save under a NEW name. `item` is `null` when nothing is being previewed —
   * which is the state a shop is in the FIRST time it saves anything.
   *
   * 🔴 That case was a real regression and it is why the signature is nullable.
   * When the panel's own name box and Save button were removed and saving moved
   * in here, the save row rendered only for a previewed item — and an empty
   * library has none. The result was an app where the first machine could never
   * be saved, and every subsequent one could. A control that works only once you
   * already have what it creates is not a control.
   */
  onSaveAs?: (
    item: ObjectItem | null,
    draft: Record<string, string | number | boolean>,
    name: string,
  ) => void;
  /** Shown when `items` is empty (nothing exists yet — a different fact from "search found none"). */
  emptyMessage?: string;
  /** Disables the whole control (e.g. nothing loaded yet). */
  disabled?: boolean;
  /**
   * Initial open state. Exists so the popup — the half of this component a
   * pointer-less renderer can otherwise never reach — can be rendered in a
   * test. Not a controlled prop: after mount the component owns `open`.
   */
  defaultOpen?: boolean;
  /**
   * Initial search text. Same reason as `defaultOpen`: rule 1's hidden-count is
   * only observable once something is hidden, and a renderer with no keyboard
   * cannot type. Not controlled — the search box owns the value after mount.
   */
  defaultQuery?: string;
  /** `data-testid` root; children get suffixed ids. */
  testid?: string;
}

/* ── Styles ────────────────────────────────────────────────────────────────── */

const STYLE_ID = '2bee-object-picker-styles';

/* Tokens only. `color-mix()` of a token is still that token — it is used where a
 * translucent wash is needed and no token exists for it. No hex, ever. */
const CSS = `
.op-root { position: relative; display: flex; flex-direction: column; gap: 4px; font: inherit; }
.op-label { font-size: 0.78rem; color: var(--muted); }
/* THE WORD THAT REPEATS ITS SECTION HEADING — TODO #77.
   CLIPPED, never display:none and never visibility:hidden. Both of those remove
   the element from the ACCESSIBILITY TREE, and the spans this is applied to are
   what name the listbox below and the trigger button (both via
   aria-labelledby). The founder asked for one less word on screen, not for a
   list that announces itself as nothing. This is the standard clip technique:
   zero visual footprint, still read aloud, still focusable-safe because there
   is nothing focusable inside it.

   TWO CALL SITES, ONE CLASS: the field label above the trigger, and the noun
   inside the trigger's action verb. They were fixed in two passes because the
   first one only looked at the element the founder pointed at. */
.op-label-quiet {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
.op-trigger {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px;
  padding: 4px 8px; text-align: left; cursor: pointer;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-trigger:hover:not(:disabled) { border-color: var(--accent); }
.op-trigger:disabled { cursor: not-allowed; opacity: 0.55; }
.op-trigger-text { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-trigger-text.op-placeholder { color: var(--muted); }
/* The action verb on the closed trigger. flex 0 0 auto + nowrap so it is the
   LAST thing to be squeezed in a 290px panel: the chips ellipsise and overflow
   into a "+N more" count, and what the button DOES stays legible. Accent-
   coloured because it is the affordance; it is also the button's accessible
   name (via aria-labelledby), so it must never become aria-hidden.

   (No backticks in this comment — it lives inside the CSS TEMPLATE LITERAL, and
   one backtick here ends the string and turns the rest of the stylesheet into
   TypeScript. The header block above says so; this comment proved it again.) */
.op-trigger-action {
  flex: 0 0 auto; white-space: nowrap; font-size: 0.72rem; color: var(--accent);
}
.op-caret { flex: 0 0 auto; color: var(--muted); font-size: 0.7rem; }
/* The selected set, ON THE CLOSED TRIGGER — founder, 2026-08-08: "SHOW THE
   SELECTED OBJECTS IN THE LEFT SIDEBAR". The chips are the only place the
   current set is readable without opening anything.

   NOWRAP, not wrap: this trigger lives in a 290px side panel, and a wrapping
   chip row silently grows the panel until the controls below it are pushed off
   screen. Overflow is reported as a "+N more" count instead, which is a fact
   the user can act on; a row that quietly clips is not. */
.op-chips { display: flex; flex-wrap: nowrap; gap: 4px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.op-chip {
  display: inline-flex; align-items: center; gap: 4px; flex: 0 1 auto; min-width: 0;
  max-width: 14ch;
  padding: 1px 6px; font-size: 0.75rem;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Not removable and not pretending to be: it is a count, not an object. */
.op-chip-more { flex: 0 0 auto; max-width: none; background: none; color: var(--muted); }
.op-chip-x {
  border: 0; background: none; color: var(--muted); cursor: pointer;
  font-size: 0.85rem; line-height: 1; padding: 0;
}
.op-chip-x:hover { color: var(--bad); }

/* CENTRED ON THE SCREEN, not anchored under the trigger — founder, 2026-08-08.
 *
 * The anchored popup inherited the one property of a dropdown he did not want:
 * it opens wherever the field happens to sit, so a control near the bottom of a
 * 290px side panel opens a list into the last few pixels of the window. A list
 * you have to scroll the page to read is a list that will not be read, and the
 * unusable entries with their reasons are exactly what gets scrolled past.
 *
 * Positioned fixed against the VIEWPORT, so it is unaffected by the scroll
 * position of the panel it was opened from.
 *
 * (No backticks in this comment: the whole block lives inside a TEMPLATE
 * LITERAL, and one backtick here ends the CSS string and turns the rest of the
 * stylesheet into TypeScript. It did exactly that once.) */
.op-backdrop {
  position: fixed; inset: 0; z-index: 39;
  /* A wash rather than a blackout: the viewport behind stays legible, because
     choosing a tool while looking at the toolpath is the normal case. */
  background: color-mix(in srgb, var(--bg) 55%, transparent);
}
.op-pop {
  position: fixed; z-index: 40;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(560px, 92vw);
  /* Bounded so a long library scrolls INSIDE the dialog and the hidden-count
     line at its foot stays on screen — that line is the one that says what the
     search took away. */
  max-height: min(70vh, 720px);
  /* Draggable from the corner AND from either edge — resizable.tsx owns that,
     and this rule no longer carries the native CSS resize property.
     🔴 THE NATIVE RESIZE WAS REMOVED FOR A MEASURED REASON, not for tidiness:
     it offers ONE corner (no single-axis drag, which is what the founder asked
     for by name), it is unreachable from a keyboard, and it cannot be clamped —
     the max-height above beat the restored inline height, so a dialog dragged
     taller than 70vh came back shrunk and the shrunken value was then SAVED over
     the operator's choice. The overflow stays hidden and the LIST inside still
     does the scrolling.
     (No backticks anywhere in this stylesheet: it is a template literal, and one
     backtick ends the CSS string and turns the rest into TypeScript. That has
     now happened twice.) */
  overflow: hidden; min-width: 280px; min-height: 220px;
  display: flex; flex-direction: column;
  background: var(--panel); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
  /* brand's own elevation token, not a hand-mixed shadow — a popup that floats
     differently from every other raised surface is a second design system. */
  box-shadow: var(--shadow-card-hover);
}
/* The dialog says WHAT LIST THIS IS — founder, 2026-08-08.
   Since the popup is centred on the viewport rather than hanging under its
   field, nothing else on screen names it. Without this the dialog carried the
   name only in aria-label, so a screen-reader user knew which list they were in
   and a sighted user did not, which is the wrong way round. */
.op-head {
  flex: 0 0 auto;
  display: flex; align-items: baseline; gap: 8px;
  padding: 7px 9px 6px; border-bottom: 1px solid var(--line);
}
.op-head-title { margin: 0; font-size: 0.95rem; font-weight: 600; }
.op-head-count { margin-left: auto; font-size: 0.72rem; color: var(--muted); }

/* ── The column, and why every child names its flex behaviour ───────────────
   .op-pop is a resizable flex COLUMN. Drag it taller and the extra height has
   to land somewhere; whichever child is allowed to grow takes it. The body was
   previously capped at a fixed max-height, so it could not take the space and
   the free height piled up under the list — reading, to the founder, as "the
   bottom section became large (51 shown Cancel)".

   So: search row, header and footer are 0 0 auto, the body is 1 1 auto, and the
   body carries min-height: 0. That last part is the one that is usually left
   out: a flex item defaults to min-height: auto, which refuses to shrink below
   its content, so a long list makes the body refuse to fit and the layout
   breaks in the other direction instead. Same argument for min-width: 0 on the
   two columns inside it and a long tool name. */
.op-search-row { flex: 0 0 auto; display: flex; gap: 6px; padding: 6px; border-bottom: 1px solid var(--line); }
.op-search {
  flex: 1 1 auto; min-width: 0; padding: 4px 6px;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-add {
  flex: 0 0 auto; padding: 3px 9px; cursor: pointer;
  background: var(--bg); color: var(--accent);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-add:hover { border-color: var(--accent); }
/* The facet select. Same surface, border and radius as the search box beside it:
   two controls that narrow the same list should not look like two kinds of
   thing. flex 0 0 auto with a max-width so a long material name does not squeeze
   the search box, which is the control people reach for first. */
.op-facet {
  flex: 0 0 auto; max-width: 40%; padding: 4px 6px;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.op-actions button, .op-actions label {
  padding: 3px 9px; cursor: pointer; white-space: nowrap; font-size: 0.78rem;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-actions button:hover, .op-actions label:hover { border-color: var(--accent); }

.op-body { flex: 1 1 auto; min-height: 0; display: flex; align-items: stretch; }
.op-list {
  flex: 1 1 55%; min-width: 0; min-height: 0; margin: 0; padding: 2px; list-style: none;
  overflow-y: auto;
}
.op-opt {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  padding: 4px 6px; border-radius: var(--radius); cursor: pointer;
}
.op-opt[aria-disabled='true'] { cursor: not-allowed; }
.op-opt.op-active { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.op-opt[aria-selected='true'] { box-shadow: inset 2px 0 0 0 var(--accent); }
.op-opt-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.op-opt[aria-disabled='true'] .op-opt-name { color: var(--muted); }
.op-tick { flex: 0 0 auto; color: var(--ok); }
.op-opt-detail { flex: 0 0 auto; font-size: 0.72rem; color: var(--muted); font-family: var(--mono); }
.op-opt-reason { flex: 1 0 100%; font-size: 0.72rem; color: var(--warn); }
/* Multi mode only. The pill says what the NEXT press does, never what the row
   is: a row that keeps saying "Add" after it has been added is a control that
   lies the second time you press it. A disabled row gets no pill at all — the
   affordance must not appear on something that cannot be added. */
.op-act {
  flex: 0 0 auto; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 0 5px; color: var(--accent);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-act-remove { color: var(--bad); }
.op-rm {
  flex: 0 0 auto; border: 0; background: none; color: var(--muted);
  cursor: pointer; font-size: 0.85rem; line-height: 1; padding: 0 2px;
}
.op-rm:hover { color: var(--bad); }

.op-props {
  flex: 1 1 45%; min-width: 0; min-height: 0; padding: 8px;
  border-left: 1px solid var(--line); overflow-y: auto;
}
.op-props-name { margin: 0 0 2px; font-size: 0.85rem; }
.op-props-detail { margin: 0 0 6px; font-size: 0.75rem; color: var(--muted); }
.op-props-blocked {
  margin: 0 0 6px; padding: 4px 6px; font-size: 0.75rem; color: var(--warn);
  border: 1px solid var(--line); border-radius: var(--radius);
}
/* The shape on the PROPERTIES panel. Bounded rather than sized: the two SVG
   catalogues (work holding, touch plates) size themselves to 100% of a viewBox
   and would otherwise grow to fill the pane, while ToolShape carries its own
   pixel frame. The max-height is what keeps a tall cutter from pushing the
   property rows — the facts the drawing illustrates — off the bottom.

   (No backticks anywhere in this stylesheet: the whole block is a template
   literal, and one backtick ends the CSS string and turns the rest into
   TypeScript. The file says so twice above; this comment is the third time it
   happened, caught by tsc rather than in a browser.) */
.op-props-shape {
  display: flex; justify-content: center; align-items: flex-start;
  margin: 0 0 6px; padding: 6px;
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-props-shape > * { max-width: 100%; max-height: 210px; }
/* The VISIBLE half of the label. The svg carries its own aria-label; this is the
   caption a sighted reader gets, and both are composed from the fields the
   drawing is drawn from rather than written beside it. */
.op-props-shape-label { display: block; margin: 0 0 6px; font-size: 0.72rem; color: var(--muted); }
/* The CLAIM control — a statement the operator makes about the row, not a
   property of it. Boxed and set apart from the property grid on purpose: every
   other thing on this panel is something the app or the core is telling YOU, and
   this is the one place the traffic runs the other way. It carries no ok/bad
   colour of its own — the VALUE is already spelled out in the row's tags and in
   the ownership sentences above, and a second colour-coded rendering of one
   verdict is a second thing to keep true. */
.op-claim {
  margin: 10px 0 0; padding: 6px;
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-claim-label { display: block; font-size: 0.72rem; color: var(--muted); margin-bottom: 3px; }
.op-claim select {
  width: 100%; min-width: 0; padding: 3px 4px; font: inherit; font-size: 0.78rem;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-claim-note { margin: 5px 0 0; font-size: 0.72rem; color: var(--muted); }
.op-claim-consequence { margin: 5px 0 0; font-size: 0.72rem; color: var(--warn); }
/* The reason an option cannot be chosen. It is NOT only the <option disabled>
   attribute: a disabled option in a native select shows greyed text and no
   reason, and this app's convention is that an unusable thing says why. */
.op-claim-why { margin: 5px 0 0; font-size: 0.72rem; color: var(--muted); }
.op-props-dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 0.78rem; }
.op-props-dl dt { color: var(--muted); }
.op-props-dl dd { margin: 0; font-family: var(--mono); overflow-wrap: anywhere; }
.op-note { padding: 6px; font-size: 0.75rem; color: var(--muted); }
.op-edit {
  width: 100%; min-width: 0; padding: 1px 4px; font: inherit; font-family: var(--mono);
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-saverow { display: flex; gap: 6px; margin-top: 10px; align-items: center; }
.op-saverow button {
  padding: 2px 10px; cursor: pointer; white-space: nowrap;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
.op-saverow button:disabled { opacity: 0.5; cursor: default; }
.op-foot {
  flex: 0 0 auto;
  padding: 4px 8px; font-size: 0.72rem; color: var(--muted);
  border-top: 1px solid var(--line);
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.op-foot-hidden { color: var(--warn); }
.op-cancel {
  margin-left: auto; padding: 2px 10px; cursor: pointer;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius);
}
/* Multi mode only. Add-and-stay-open needs an explicit way OUT that AFFIRMS the
   set — every other exit that keeps it (Escape, clicking away, Tab) reads as a
   dismissal rather than as "yes, these". Cancel is the one that discards. */
.op-done {
  padding: 2px 10px; cursor: pointer;
  background: var(--bg); color: var(--accent);
  border: 1px solid var(--accent); border-radius: var(--radius);
}
.op-showall {
  border: 0; background: none; color: var(--accent); cursor: pointer;
  font: inherit; font-size: 0.72rem; text-decoration: underline;
}
`;

/** Injected once into <head>; never removed, because other instances share it. */
function useObjectPickerStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}

/* ── Component ─────────────────────────────────────────────────────────────── */

const EMPTY_ITEMS: ObjectItem[] = [];
const EMPTY_IDS: string[] = [];

/** How many chips the closed trigger shows before it starts counting instead.
 *  Three fits a 290px panel at the app's font size without wrapping. */
const MAX_CHIPS = 3;

/** Whether a row may be deleted. One definition, so the keyboard route and the
 *  button route cannot disagree about which rows are protected. */
function removableOf(it: ObjectItem): boolean {
  return it.removable ?? it.builtIn !== true;
}

export default function ObjectPicker({
  label,
  items = EMPTY_ITEMS,
  mode = 'single',
  selectedIds = EMPTY_IDS,
  onChange,
  placeholder = 'choose…',
  searchPlaceholder = 'search by name…',
  facets,
  onAdd,
  addLabel = '+ add',
  onRemoveItem,
  actions,
  onSave,
  onSaveAs,
  emptyMessage = 'Nothing here yet.',
  disabled = false,
  defaultOpen = false,
  defaultQuery = '',
  testid = 'object-picker',
}: ObjectPickerProps) {
  useObjectPickerStyles();

  /* TODO #77 — is the field label the same word as the panel heading above it?
   * The heading arrives by context so the rule lives in ONE place; see
   * `SectionHeadingContext` for why the label is suppressed rather than removed. */
  const quietLabel = labelRepeatsHeading(label, useContext(SectionHeadingContext));

  const [open, setOpen] = useState(defaultOpen);
  /* What was selected when the popup OPENED. Cancel puts this back.
   *
   * 🔴 Multi-select commits each toggle immediately, so by the time a person
   * decides they did not mean it, three tools are already in the job. "Cancel"
   * meaning "close, keeping everything I just did" would be a button that lies
   * about its own name. It reverts. */
  const openedWith = useRef<string[]>(selectedIds ?? []);
  /* Edits in progress for the object being looked at, keyed by the property's
   * `input.key`. Empty means nothing has been touched — which is why Save is
   * offered but does nothing surprising when pressed with no changes. */
  /**
   * The unsaved property edits, AND THE ROW THEY WERE TYPED ON.
   *
   * 🔴 THE ROW ID IS NOT BOOKKEEPING — IT IS THE WHOLE FIX. `draft` is merged
   * into whatever `Save` / `Save as` writes, so a draft that outlives its row
   * writes one object's numbers into another's record: edit a travel while
   * previewing machine A, arrow to B, press `Save` → `onSave(B, {…A's value})`.
   *
   * ⚠ THE FIRST ATTEMPT AT THIS (2026-08-27) CLEARED THE DRAFT WHENEVER THE
   * PREVIEW MOVED, and traded a wrong record for SILENT DATA LOSS on a gesture
   * this same file had just ruled *"does not count as choosing"*: hovering. With
   * `onPointerMove` moving the preview, sliding the mouse across the list wiped
   * a half-typed value with no notice and no undo — the field simply snapped
   * back. Both defects come from the draft not knowing whose it is, so it is
   * told: it is KEPT, and it is only ever applied to the row it belongs to.
   */
  const [draft, setDraft] = useState<{
    rowId: string | null;
    values: Record<string, string | number | boolean>;
  }>({ rowId: null, values: {} });

  /** The draft, but only if it belongs to `id`. Every writer goes through this. */
  const draftFor = useCallback(
    (id: string | null | undefined): Record<string, string | number | boolean> =>
      draft.rowId !== null && draft.rowId === id ? draft.values : {},
    [draft]
  );
  const [saveAsName, setSaveAsName] = useState('');

  /* ── HOW BIG THE DIALOG OPENS ────────────────────────────────────────────────
   *
   * 🔴 FOUNDER, 2026-08-11: *"the initial list size should be the full 3d canvas
   * size"*. He is reading 51 tools, a drawing library and four spoilboards
   * through a window that shows a handful of rows, and every filter we add makes
   * that worse rather than better: **a filter is only useful if you can see what
   * survived it.**
   *
   * ⚠ MEASURED FROM THE REGION, NEVER TYPED AS A NUMBER. A pixel constant here
   * would be a second copy of a dimension the layout already owns, and it would
   * drift the first time the report splitter moved — which the founder made
   * resizable on purpose. So this reads the canvas's own box.
   *
   * 🔴 AND IT IS CLAMPED BY THE WINDOW AS WELL AS BY THE REGION, because the
   * dialog is `position: fixed` and centred on the WINDOW while being sized from
   * a REGION — which is exactly the shape of the defect `web/e2e/` already
   * guards (a control once sat at x=336 against a panel edge at 290). The clamp
   * is not a special case at a breakpoint: it is the same expression on every
   * screen, and on a laptop the window bound simply wins.
   *
   * ⚠ A REMEMBERED DRAG STILL WINS. The instruction is about the size the dialog
   * OPENS at; overriding a size the operator deliberately dragged would be this
   * control forgetting what it was told. */
  const openingSize = (): { w: number; h: number } | null => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    const region =
      document.querySelector('[data-testid="viewport"]') ?? document.querySelector('main.stage');
    if (!region) return null;
    const r = (region as HTMLElement).getBoundingClientRect();
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width <= 0 || r.height <= 0) {
      return null;
    }
    /* ⚠ NOT CLAMPED HERE ANY MORE. It used to repeat the stylesheet's floors and
     * a window margin inline — three numbers that had to agree with three others
     * — and `useResizable` now applies exactly the same clamp to this seed, to a
     * restored size and to every drag, from one expression. Returning the raw
     * region is the honest thing for a function called `openingSize` to do; the
     * clamp is the resizer's job and belongs where the drag can also fail it. */
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };

  const [query, setQuery] = useState(defaultQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  /* 🔴 WHETHER THE ACTIVE ROW IS THE USER'S CHOICE OR JUST ROW 0.
   *
   * The properties view follows the active row, and on open with nothing
   * selected the active row is index 0 — a row nobody picked. That is fine for
   * DISPLAYING properties and wrong for deciding what `Save as` writes, and the
   * two were the same fact until 2026-08-27.
   *
   * Measured against the built app that day: type travels into the Machine
   * panel, open the list, name it, press `Save as` — and the app answers
   * *"Nothing was saved. You are looking at \"Bellwether Lead 1250x670\", but the
   * panel holds a 1234 × 900 machine … or close the properties view if you meant
   * to save what is set up now."* **There is no control that closes the
   * properties view** — the picker's only buttons are `Save as` and `Cancel` —
   * so the remedy the sentence offers does not exist and a hand-typed machine
   * could not be saved at all. That is the SAME defect the comment further down
   * this file records from 2026-08-08 ("the first machine could never be
   * saved"), returned in a new form: the control exists now, and it refuses.
   *
   * ⚠ THE REFUSAL ITSELF IS RIGHT AND IS NOT WEAKENED. `App.tsx`'s TODO #102
   * branch exists because arrowing changes the preview WITHOUT selecting, so
   * `Save as` while looking at one machine with another ticked would write the
   * ticked one's travels under that name. That ambiguity needs a user who
   * MOVED. It cannot arise before they have touched the list, which is exactly
   * the case this flag separates — so the guard keeps every case it was built
   * for and loses only the one it was never aimed at. */
  const [activeChosen, setActiveChosen] = useState(false);
  /** The row `activeIndex` pointed at last render — see the clamp effect. */
  const activeRowId = useRef<string | null>(null);
  const chooseActive = useCallback((next: number | ((i: number) => number)) => {
    setActiveChosen(true);
    setActiveIndex(next as never);
  }, []);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const uid = useId().replace(/:/g, '');
  const listboxId = `${uid}-listbox`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  /* ── THE SELECTED FACET'S SNAPSHOT ──────────────────────────────────────────
   *
   * 🔴 IT FILTERS AGAINST A SNAPSHOT OF THE SELECTION, NOT AGAINST THE LIVE ONE,
   * AND THAT IS A DELIBERATE CHOICE ABOUT WHAT A CLICK DOES.
   *
   * *Selected* is a view of state the operator changes while looking at it. Filter
   * against the live set and deselecting a row makes that row VANISH FROM UNDER
   * THE CURSOR — which reads as the app eating the click, and in a multi-select
   * list the next click then lands on whatever slid up into that position. So the
   * row stays listed and simply loses its tick, which is the same information
   * without the moving target.
   *
   * The snapshot is retaken when the facet is (re)chosen and when the popup
   * opens. When it has drifted — a listed row is no longer selected, or a
   * selected row is not listed — the foot offers a re-apply, so the view is never
   * silently out of date with the thing it claims to show. */
  const [selectedSnapshot, setSelectedSnapshot] = useState<Set<string> | null>(null);
  const [selFacet, setSelFacet] = useState<SelectedFacetValue>('');
  const snapshotNow = useCallback(() => setSelectedSnapshot(new Set(selectedIds ?? [])), [selectedIds]);

  /** The built-in facet, in the same shape a host supplies — so the pipeline,
   *  the attribution and the "show all" reset have exactly one kind of thing to
   *  handle and cannot treat this one specially by accident. */
  const selectedFacet: Facet = useMemo(() => {
    const snap = selectedSnapshot ?? new Set(selectedIds ?? []);
    const inSnap = items.filter((it) => snap.has(it.id)).length;
    return {
      label: SELECTED_FACET_LABEL,
      value: selFacet,
      options: [
        { value: '', label: 'All', count: items.length },
        { value: 'selected', label: 'Selected', count: inSnap },
        { value: 'unselected', label: 'Not selected', count: items.length - inSnap },
      ],
      onChange: (v) => {
        setSelFacet(v as SelectedFacetValue);
        // Re-choosing the same value is how a drifted view is refreshed.
        setSelectedSnapshot(new Set(selectedIds ?? []));
      },
      matches: (it, v) => (v === 'selected' ? snap.has(it.id) : !snap.has(it.id)),
    };
  }, [items, selFacet, selectedIds, selectedSnapshot]);

  /* 🔴 THE BUILT-IN GOES LAST so a host facet's attribution is unchanged by its
   * arrival: the counts are SEQUENTIAL (see below), and inserting a filter ahead
   * of an existing one would silently move rows from one control's column to
   * another's. */
  const allFacets: Facet[] = useMemo(
    () => [...(facets ?? []), selectedFacet],
    [facets, selectedFacet],
  );

  /* RULE 1 — the narrowing steps in this component, and NONE of them can see
   * `disabled`, so none can hide something for being unusable even by accident.
   * A facet narrows by a value the row STATES; the search narrows by `name` and
   * nothing else. The attribution rule and its reasons are on
   * {@link narrowingStages}, which is pure and exported so a node test can
   * drive it — there is no browser here. */
  const stages = useMemo(() => narrowingStages(items, allFacets), [items, allFacets]);

  const afterFacet = stages.rows;
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => (q === '' ? afterFacet : afterFacet.filter((it) => it.name.toLowerCase().includes(q))),
    [afterFacet, q],
  );
  const hiddenByFacet = items.length - afterFacet.length;
  const hiddenBySearch = afterFacet.length - visible.length;
  const hidden = hiddenByFacet + hiddenBySearch;
  /** Every active narrowing control, in the order it is applied, for the foot and
   *  for the empty-list message. `[]` when only the search is narrowing. */
  const activeFacets = useMemo(() => stages.byFacet.filter((s) => s.hidden >= 0), [stages]);
  /** Has the selection moved under a snapshot the list is still filtered by? */
  const snapshotDrifted = useMemo(() => {
    if (selFacet === '' || !selectedSnapshot) return false;
    const live = new Set(selectedIds ?? []);
    if (live.size !== selectedSnapshot.size) return true;
    for (const id of live) if (!selectedSnapshot.has(id)) return true;
    return false;
  }, [selFacet, selectedSnapshot, selectedIds]);
  /* 🔴 THE FACET COUNTS, CHECKED AGAINST THE FACETS' OWN RULES, ON EVERY PICKER.
   * See {@link facetCountMismatches} for what this is and why the comparison is
   * over the full set. It is rendered rather than logged: a console warning in a
   * browser nobody has open is a check that cannot be watched, and the person who
   * needs to know a number is wrong is the one reading it. */
  const countMismatches = useMemo(
    () => facetCountMismatches(items, allFacets),
    [items, allFacets],
  );
  const hiddenUnusable = useMemo(() => {
    if (hidden === 0) return 0;
    const shown = new Set(visible.map((it) => it.id));
    return items.filter((it) => it.disabled && !shown.has(it.id)).length;
  }, [items, visible, hidden]);

  /* Keep the active row inside the list whenever the list changes under it. */
  useEffect(() => {
    /* A clamp, not a choice: the list shrank under the operator and the active
     * row moved because there was nowhere else for it to be. Leaving
     * `activeChosen` armed here would let a filter change decide the save
     * target — see the flag's own comment. */
    /* ⚠ THE FLAG RESET IS OUT HERE, NOT INSIDE THE UPDATER. A `setState`
     * updater must be pure — React 18 double-invokes them in StrictMode and may
     * discard and re-run them under concurrent rendering — and the first version
     * of this called `setActiveChosen(false)` from inside one. Idempotent, so it
     * failed in the safe direction, but a side effect in a function React is
     * allowed to call speculatively is a defect waiting for a scheduler change.
     *
     * ⚠ AND IT KEYS ON THE ROW, NOT THE COUNT. Depending on `visible.length`
     * missed the case the three sibling resets were added for: a list whose
     * CONTENTS change while its length does not — a parent swapping an item, a
     * facet that yields the same count — leaves `activeIndex` pointing at a
     * different row with the flag still armed. */
    const clamped = visible.length === 0 ? 0 : Math.min(activeIndex, visible.length - 1);
    if (clamped !== activeIndex || visible[clamped]?.id !== activeRowId.current) {
      setActiveChosen(false);
    }
    activeRowId.current = visible[clamped]?.id ?? null;
    setActiveIndex(clamped);
  }, [visible.length]);

  const activeItem: ObjectItem | undefined = visible[activeIndex];

  /* The properties view follows the ACTIVE row (keyboard or hover-free pointer
   * move is not required — arrowing is enough), and falls back to the first
   * selected item when the list has no active row. */
  const previewItem: ObjectItem | undefined =
    activeItem ?? items.find((it) => selected.has(it.id));

  /* 🔴 AN UNSAVED EDIT BELONGS TO THE ROW IT WAS TYPED ON.
   *
   * `draft` holds the property-pane edits and is merged into whatever `Save` /
   * `Save as` writes. It was cleared on save and (since 2026-08-27) on close,
   * and NOT when the preview moved — so: edit a travel while previewing machine
   * A, arrow to B, press `Save`, and `onSave(B, { travelX: A's value })` writes
   * A's number into B's record. `Save` is not gated on `activeChosen` the way
   * `Save as` is, because saving an existing row you are looking at is
   * unambiguous — which is true only while the draft belongs to that row.
   *
   * The value was visible in the field rather than silently applied, so this is
   * a wrong record an operator could have caught, not one they could not. That
   * is not the standard: `closePopup`'s own reason — "merging values they
   * abandoned into a record" — applies across rows exactly as it does across
   * closes. */
  /* ⚠ THERE IS DELIBERATELY NO `useEffect` CLEARING THE DRAFT WHEN THE PREVIEW
   * MOVES. One was added on 2026-08-27 and removed the next day: with hover
   * moving the preview, it wiped a half-typed value whenever the mouse crossed
   * a row. The draft is KEPT and gated by `draftFor`, so an operator can look at
   * another row and come back — and `Save` still cannot write A's numbers into
   * B's record, because `draftFor(B)` is empty while the draft belongs to A. */

  const openPopup = useCallback(
    (seed?: string) => {
      if (disabled) return;
      if (seed !== undefined) setQuery(seed);
      // Open on the first selected item when there is one, so Enter is a no-op
      // rather than a surprise re-selection.
      const firstSel = items.findIndex((it) => selected.has(it.id));
      // A row that is active because the user selected it EARLIER is still the
      // user's choice; row 0 on an empty selection is not.
      setActiveChosen(firstSel >= 0 && seed === undefined);
      setActiveIndex(firstSel >= 0 && seed === undefined ? firstSel : 0);
      openedWith.current = selectedIds ?? [];
      setOpen(true);
    },
    [disabled, items, selected, selectedIds],
  );

  const closePopup = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery('');
    /* 🔴 THE FILTER GOES WITH THE DIALOG, like the search box beside it. A
     * narrowing control that outlives the surface it is drawn on is a list that
     * is short for a reason nobody can see — the same argument that keeps it out
     * of storage, applied to the shorter timescale. */
    setSelFacet('');
    setSelectedSnapshot(null);
    /* 🔴 THE UNSAVED EDIT GOES WITH THE DIALOG TOO, and it is not tidiness:
     * `draft` DECIDES THE SAVE TARGET (a non-empty draft counts as choosing,
     * because editing a property is choosing). Left standing across a close it
     * would make the NEXT visit's `Save as` behave as though the operator had
     * pointed at a row they never opened — refusing a save they should get, or
     * merging values they abandoned into a record. `Cancel` is the only control
     * that reverts a selection and it must revert this with it. */
    setDraft({ rowId: null, values: {} });
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  /* 🔴 THE ONE CONTROL THAT PUTS THE SELECTION BACK. Nothing else reverts.
   *
   * MEASURED IN A BROWSER, 2026-08-09, `?fixtures=1`, the Tool picker, adding
   * `Surfacing 25mm 2F` and removing `End Mill - Down-cut 6mm 2F` and then
   * leaving the dialog five different ways:
   *
   *   close route      selection after close
   *   Escape           End Mill - Down-cut 6mm 2F     <- REVERTED
   *   Cancel           End Mill - Down-cut 6mm 2F     <- reverted
   *   click-away       Surfacing 25mm 2F              <- kept
   *   Done             Surfacing 25mm 2F              <- kept
   *   Tab / trigger    kept
   *
   * This function used to be wired to BOTH Escape and Cancel, and the comment
   * that stood here defended it: *"having Escape keep changes while a Cancel
   * button discards them would make the two obvious ways out do opposite
   * things."* The reasoning compared Escape against Cancel and never counted the
   * other three exits — so the app it described did not exist. THREE of the five
   * ways out kept and TWO reverted, and the split ran between two DISMISSAL
   * gestures a user reads as identical: press Escape and lose the tool, click
   * the greyed-out background and keep it.
   *
   * 🔴 The direction it failed in is the dangerous one for this app. The chips
   * do redraw, so it is not invisible — but what it produces is an operator who
   * deliberately fitted a 25mm surfacing cutter, dismissed the dialog, and gets
   * a program planned for a 6mm end mill. A selection silently put back is a
   * machining decision quietly overruled.
   *
   * ⇒ Escape now DISMISSES and keeps, like every other dismissal. Revert has
   * exactly one route and it is the button that says the word: the only exit
   * whose LABEL promises the change is thrown away is the only exit that throws
   * it away. (Single mode is unaffected either way — there, choosing a row
   * closes the popup, so "a row was chosen and the dialog is still open" is not
   * a reachable state and there is never anything for Escape to undo.)
   *
   * ⚠ `objectPicker.md` still documents Escape only as "closes and returns focus
   * to the trigger", which stays true and stays incomplete; that file was not in
   * this pass's scope and whoever holds it should record the split explicitly. */
  const revert = useCallback(
    (restoreFocus: boolean) => {
      const before = openedWith.current;
      const now = selectedIds ?? [];
      const changed =
        before.length !== now.length || before.some((id, i) => id !== now[i]);
      if (changed) onChange([...before]);
      closePopup(restoreFocus);
    },
    [closePopup, onChange, selectedIds],
  );

  /* Pointer-down outside closes, matching a native select's popup. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  /* ── THE DRAG, AND WHERE IT NO LONGER LIVES ───────────────────────────────────
   *
   * 🔴 THIS COMPONENT USED TO OWN ITS OWN RESIZE — a `resize: both` rule, a
   * `ResizeObserver`, a `2bee.picker.size.<id>` key and a read/write pair, about
   * forty lines. It is `resizable.tsx` now, unchanged in what it remembers and
   * different in three ways that were defects here:
   *
   *   1. It offers a RIGHT EDGE, a BOTTOM EDGE and a CORNER. Native `resize`
   *      offers a corner only, and the founder asked for both axes by name.
   *   2. It CLAMPS. The `max-height: min(70vh, 720px)` in this file's own
   *      stylesheet beat the restored inline height, so a dialog dragged taller
   *      than 70vh reopened shrunk — and the observer then wrote the shrunken
   *      size back over the operator's choice. `useResizable` raises the inline
   *      ceiling with the size, and floors both axes with one expression.
   *   3. It writes on POINTER-UP, not on every observed frame.
   *
   * ⚠ `anchor: 'center'` is not optional here: `.op-pop` is centred with
   * `translate(-50%, -50%)`, so each edge moves half as far as the size and an
   * undoubled delta makes the grip slide out from under the cursor.
   *
   * ⚠ The identity is `testid ?? label`, which is what the old key used, so a
   * dialog somebody already sized keeps... nothing. The KEY SHAPE changed
   * (`2bee.picker.size.X` -> `2bee.app.size.X`), so every remembered size is
   * forgotten once, on purpose: the old values were written by the observer that
   * could store a silently-clamped height, and inheriting those would carry the
   * defect across the fix. Said here rather than left as a surprise. */
  const rz = useResizable({
    id: testid ?? label,
    enabled: open,
    anchor: 'center',
    minWidth: 280,
    minHeight: 220,
    initial: openingSize,
  });

  /* Focus goes to the search box on open — that is what makes type-ahead work
   * without a bespoke keystroke buffer. */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /* 🔴 ESCAPE AT THE DOCUMENT, not only at the search box.
   *
   * MEASURED IN A BROWSER, 2026-08-08. Escape was handled solely by the search
   * input's onKeyDown. Clicking a row moves focus to <body> (an <li> is not
   * focusable, so the mousedown blurs the input) — after which Escape reached
   * nothing and the dialog could not be dismissed by keyboard at all.
   *
   * SINGLE MODE HID THIS COMPLETELY: there, clicking a row closes the popup, so
   * "a row has been clicked and the dialog is still open" was an unreachable
   * state. Add-and-stay-open makes it the NORMAL state, and it is the state in
   * which Escape matters most — someone can add five things and then need a way
   * out of the dialog with one hand on a machine. (Escape KEEPS those five; the
   * Cancel button is what puts them back. That split is measured and argued in
   * `revert` below — it was the other way round until 2026-08-09 and the
   * asymmetry against click-away is what made a tool selection not stick.)
   *
   * `defaultPrevented` keeps this from double-firing: when focus IS in the
   * search box its own handler runs first and calls preventDefault, so this one
   * stands down rather than cancelling twice off a stale closure.
   *
   * The mousedown guard on each row (below) is the other half — it stops focus
   * leaving in the first place, which also keeps type-ahead alive between adds.
   * Both are kept: the guard covers the common path, this covers focus that
   * left some other way, e.g. via a property field.
   *
   * 🔴 It DISMISSES and keeps the set — see `revert` above for the measurement
   * that changed this. Escape is the exit a one-handed workshop user reaches
   * for, and it was wired to the destructive half. */
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      closePopup(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closePopup]);

  /* Keep the active option in view when arrowing. `getElementById`, not a CSS
   * selector: the generated id is not guaranteed to be a valid selector token. */
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    document.getElementById(`${uid}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, visible.length, uid]);

  const commit = useCallback(
    (item: ObjectItem | undefined) => {
      if (!item) return;
      // A disabled item is READ, never chosen. It stays on screen with its
      // reason; selecting it would hand the core an object it already refused.
      if (item.disabled) return;
      if (mode === 'single') {
        onChange([item.id]);
        closePopup(true);
        return;
      }
      // MULTI = ADD, and stay open — founder, 2026-08-08: "when I can select
      // more than one from the list able to Add instead of select just 1".
      // A press on a row that is not in the set ADDS it; a press on one that is
      // REMOVES it, and the row's pill says which of the two it is before you
      // press, so the second press is never a surprise.
      const next = selected.has(item.id)
        ? selectedIds.filter((id) => id !== item.id)
        : [...selectedIds, item.id];
      onChange(next);
      // Staying open is the whole point: picking a SET one item at a time
      // through a popup that closes on every pick is the thing that makes
      // people give up and use one. Every exit keeps the set except Cancel,
      // which is the only control that says it discards anything — see `revert`.
    },
    [mode, onChange, selected, selectedIds, closePopup],
  );

  const deselect = useCallback(
    (id: string) => onChange(selectedIds.filter((x) => x !== id)),
    [onChange, selectedIds],
  );

  const move = useCallback(
    (delta: number) => {
      chooseActive((i) => {
        if (visible.length === 0) return 0;
        const n = i + delta;
        return n < 0 ? 0 : n > visible.length - 1 ? visible.length - 1 : n;
      });
    },
    [visible.length],
  );

  /* RULE 2 — the four native-select behaviours, rebuilt.
   *   type-ahead : characters land in the search box (it holds DOM focus)
   *   arrows     : Up/Down/Home/End/PageUp/PageDown move `aria-activedescendant`
   *   Enter      : commits the active row
   *   Escape     : closes and returns focus to the trigger
   * Plus Tab (closes, does not trap) and Shift+Delete (host's remove flow). */
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        e.preventDefault();
        move(10);
        break;
      case 'PageUp':
        e.preventDefault();
        move(-10);
        break;
      case 'Home':
        e.preventDefault();
        chooseActive(0);
        break;
      case 'End':
        e.preventDefault();
        chooseActive(Math.max(0, visible.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        commit(activeItem);
        break;
      case 'Escape':
        // DISMISS, keeping the set. Not a revert — `revert` above carries the
        // measurement, and Cancel is the only control that undoes anything.
        e.preventDefault();
        closePopup(true);
        break;
      case 'Tab':
        // Not trapped. Tab means "I am done here" — close and let focus go.
        setOpen(false);
        setQuery('');
        break;
      case 'Delete':
        // Removal is destructive, so it is NEVER a bare key: Shift+Delete only,
        // which no text-editing gesture uses. And it honours `removableOf` for
        // the same reason the button does — a keyboard route that could delete a
        // built-in the button protects would be the protection working only for
        // people using a mouse.
        if (e.shiftKey && activeItem && onRemoveItem && removableOf(activeItem)) {
          e.preventDefault();
          onRemoveItem(activeItem);
        }
        break;
      default:
        break;
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPopup();
      return;
    }
    // Type-ahead from the closed state, exactly like a native <select>: the
    // first character opens the list AND is the first character of the search.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openPopup(e.key);
    }
  };

  const selectedItems = useMemo(
    () => items.filter((it) => selected.has(it.id)),
    [items, selected],
  );

  /* Chips shown on the closed trigger, and the ones that did not fit.
   *
   * The trigger sits in a 290px side panel. Wrapping every chip would push the
   * controls below it down the panel and eventually off screen, and clipping
   * them silently would make "four tools selected" and "six tools selected"
   * look identical — the same absence-reads-as-reassurance failure rule 1
   * exists to stop. So the overflow is COUNTED, and the full count is also on
   * the dialog header where nothing truncates it. */
  const shownChips = selectedItems.slice(0, MAX_CHIPS);
  const overflowChips = selectedItems.slice(MAX_CHIPS);

  const triggerText =
    mode === 'single'
      ? (selectedItems[0]?.name ?? placeholder)
      : selectedItems.length === 0
        ? placeholder
        : '';

  /* THE TRIGGER IS AN ACTION — founder, 2026-08-10: *"Add Drawing"*, *"Add
   * Tool"*. It used to be a value with a caret: it showed what was chosen and
   * nothing said it could be pressed, so the one control that opens every
   * catalogue in the app read as a read-only field.
   *
   * 🔴 THE VERB COMES FROM `mode`, and that is the whole reason this is computed
   * rather than passed in as a string. `Add` is TRUE of the two multi-select
   * pickers — Drawing and Tool — where a row joins a set and the others stay.
   * It is FALSE of the five single-select ones (Machine, Touch plate, Material,
   * Workpiece, Hold-down), where choosing REPLACES what is there. A button that
   * says "Add Machine" over a control that silently discards the current machine
   * is an affordance describing the wrong operation, and the operator finds out
   * afterwards. So single mode says `Choose` while nothing is set and `Change`
   * once something is — "change" being the honest name for replace.
   *
   * ⚠ It does NOT replace the selection readout. The chips (multi) and the name
   * (single) stay exactly where they were — founder, 2026-08-08: *"SHOW THE
   * SELECTED OBJECTS IN THE LEFT SIDEBAR"* — because a trigger that shows only a
   * verb is a control that has forgotten its own state. The action sits beside
   * them, not over them.
   *
   * ⚠ And it is the button's ACCESSIBLE NAME, not just paint. `aria-labelledby`
   * previously pointed at the field label alone, so the button announced "Tool,
   * button" — a screen reader got the noun and never the verb. It now points at
   * this span, which carries both.
   *
   * 🔴 THE VERB AND THE NOUN ARE TWO ELEMENTS, NOT ONE STRING — 2026-08-11, and
   * this is the second half of TODO #77 rather than a new rule. Suppressing the
   * `op-label` moved one repeat behind a screen reader and left this one on
   * screen: under a heading that reads **Machine**, the trigger still printed
   * `Choose Machine`, and with nothing chosen the placeholder made it three
   * renderings of one noun in one column-width. Splitting the string lets the
   * SAME `quietLabel` decision reach the noun here — visible `Change`, announced
   * `Change Machine` — so a picker used outside a provider (`web/src/cad/`) is
   * untouched and the ninth panel somebody adds inherits the rule.
   *
   * 🔴 **NEVER DELETE THE NOUN.** It is inside the element `aria-labelledby`
   * points at, so a deletion announces the button as *"Change, button"* — the
   * exact trade the label above refuses. Clipped, not removed; the class is the
   * one `.op-label-quiet` already defines and it is applied to a span with
   * nothing focusable inside it. */
  const actionVerb = mode === 'multi' ? 'Add' : selectedItems.length > 0 ? 'Change' : 'Choose';

  return (
    <div className="op-root" ref={rootRef} data-testid={testid}>
      {/* 🔴 TODO #77 — the visible half goes when it repeats the heading above;
          the ANNOUNCED half never does. See `SectionHeadingContext`. The
          `data-quiet` attribute is on the span so a test can tell the two states
          apart without a browser: a suppressed label and a deleted one are
          identical in every other respect, and only one of them is the fix. */}
      <span
        className={quietLabel ? 'op-label op-label-quiet' : 'op-label'}
        id={`${uid}-label`}
        data-testid={`${testid}-label`}
        data-quiet={quietLabel ? 'true' : 'false'}
      >
        {label}
      </span>

      <button
        type="button"
        ref={triggerRef}
        className="op-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={`${uid}-action`}
        onClick={() => (open ? closePopup(false) : openPopup())}
        onKeyDown={onTriggerKeyDown}
        data-testid={`${testid}-trigger`}
      >
        {mode === 'multi' && selectedItems.length > 0 ? (
          <span className="op-chips" data-testid={`${testid}-chips`}>
            {shownChips.map((it) => (
              <span className="op-chip" key={it.id} title={it.name} data-testid={`${testid}-chip-${it.id}`}>
                <span className="op-chip-name">{it.name}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="op-chip-x"
                  aria-label={`remove ${it.name} from selection`}
                  data-testid={`${testid}-chip-x-${it.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deselect(it.id);
                  }}
                >
                  ×
                </span>
              </span>
            ))}
            {overflowChips.length > 0 && (
              <span
                className="op-chip op-chip-more"
                title={overflowChips.map((it) => it.name).join(', ')}
                data-testid={`${testid}-chips-more`}
              >
                +{overflowChips.length} more
              </span>
            )}
          </span>
        ) : (
          <span
            className={`op-trigger-text${selectedItems.length === 0 ? ' op-placeholder' : ''}`}
          >
            {triggerText}
          </span>
        )}
        <span
          className="op-trigger-action"
          id={`${uid}-action`}
          data-testid={`${testid}-action`}
        >
          {actionVerb}
          {/* The noun. `data-quiet` is on the span for the same reason it is on
              the label: a clipped noun and a deleted one are identical in every
              other respect, and only one of them keeps the accessible name. */}
          <span
            className={quietLabel ? 'op-label-quiet' : undefined}
            data-testid={`${testid}-action-noun`}
            data-quiet={quietLabel ? 'true' : 'false'}
          >{` ${label}`}</span>
        </span>
        <span className="op-caret" aria-hidden="true">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <>
        <div
          className="op-backdrop"
          data-testid={`${testid}-backdrop`}
          // Clicking away closes it. Kept as a sibling rather than wrapping the
          // dialog: a backdrop that CONTAINS the panel swallows clicks meant for
          // the list unless every one of them stops propagation, and forgetting
          // one makes a row that silently does nothing.
          onMouseDown={() => setOpen(false)}
        />
        <div
          ref={rz.ref}
          className="op-pop"
          data-testid={`${testid}-pop`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${uid}-title`}
        >
          {/* The dialog names the list it is showing. It used to carry that name
              only in aria-label — readable by a screen reader, invisible to
              everyone else — and once the popup moved to the centre of the
              viewport there was nothing left on screen tying it to its field. */}
          <div className="op-head">
            <h3 className="op-head-title" id={`${uid}-title`} data-testid={`${testid}-title`}>
              {label || 'Choose'}
            </h3>
            {mode === 'multi' && (
              // The untruncated count. The trigger's chips stop at MAX_CHIPS;
              // this one never does, so the two can never disagree about size.
              <span className="op-head-count" data-testid={`${testid}-selected-count`}>
                {selectedItems.length} selected
              </span>
            )}
          </div>

          <div className="op-search-row">
            <input
              ref={inputRef}
              className="op-search"
              type="text"
              role="combobox"
              aria-expanded={true}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeItem ? optionId(activeIndex) : undefined}
              aria-label={`search ${label} by name`}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Re-filtering lands on row 0 again, and row 0 is a default —
                // not something the user picked. See `activeChosen`.
                setActiveChosen(false);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              data-testid={`${testid}-search`}
            />
            {/* The facet. A native <select> on purpose: it is a short closed set,
                it is keyboard-operable for free, and the thing it narrows is the
                searchable list below — see the `facet` prop for why the
                founding "I do not like the drop down" objection does not carry
                over to it. Each option states its own count, so an empty result
                is legible BEFORE it is chosen. */}
            {allFacets
              .filter((f) => f.options.length > 0)
              .map((f, i) => (
                <select
                  key={`${f.label}-${i}`}
                  className="op-facet"
                  aria-label={`filter by ${f.label}`}
                  value={f.value}
                  onChange={(e) => {
                    f.onChange(e.target.value);
                    setActiveChosen(false);
                    setActiveIndex(0);
                  }}
                  /* The FIRST host facet keeps the original `-facet` id, because
                     it is the same control it always was and existing callers
                     ask for it by that name. The rest are addressed by label, so
                     a new facet cannot renumber an existing one. */
                  data-testid={
                    f.label === SELECTED_FACET_LABEL
                      ? `${testid}-facet-selected`
                      : /* Keyed off the HOST's own array, not the filtered index:
                           an index computed after a `.filter` renames a control
                           the moment some other facet is hidden, and `web/e2e/`
                           addresses this one by name. */
                        (facets ?? []).indexOf(f) === 0
                        ? `${testid}-facet`
                        : `${testid}-facet-${f.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
                  }
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} ({o.count})
                    </option>
                  ))}
                </select>
              ))}
            {onAdd && (
              <button
                type="button"
                className="op-add"
                onClick={onAdd}
                data-testid={`${testid}-add`}
              >
                {addLabel}
              </button>
            )}
            {/* List-level controls the HOST owns — import a library, export one.
                They act on the whole collection, never on the previewed item,
                which is why they sit up here with the search and the "+" rather
                than in the properties pane where Save and Save-as live. */}
            {actions ? (
              <span className="op-actions" data-testid={`${testid}-actions`}>
                {actions}
              </span>
            ) : null}
          </div>

          <div className="op-body">
            <ul
              ref={listRef}
              className="op-list"
              id={listboxId}
              role="listbox"
              aria-labelledby={`${uid}-label`}
              aria-multiselectable={mode === 'multi'}
              data-testid={`${testid}-list`}
            >
              {visible.map((it, i) => (
                <li
                  key={it.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected.has(it.id)}
                  aria-disabled={it.disabled === true}
                  className={`op-opt${i === activeIndex ? ' op-active' : ''}`}
                  /* 🔴 HOVER MOVES THE PREVIEW AND DOES NOT COUNT AS CHOOSING.
                     Corrected 2026-08-27, hours after `activeChosen` was added
                     with `chooseActive(i)` here — which reintroduced the very
                     defect that change closed, by a route the new tests could
                     not see. The save box lives in the properties pane, to the
                     RIGHT of the list; `Tab` from the search box CLOSES the
                     dialog and `<li>`s are not focusable, so `Save as` is
                     reachable by mouse only — and the mouse path from the
                     trigger to that box crosses rows. Arming on `pointermove`
                     therefore made the save-target refusal UNAVOIDABLE for
                     every mouse user, while `save-target.spec.ts` stayed green
                     because `fill()` moves no pointer and `click()` jumps.
                     Arrow, Home and End still arm it: those are navigation a
                     person performs, and they are the gesture TODO #102's
                     ambiguity is actually about. */
                  onPointerMove={() => setActiveIndex(i)}
                  // Keep focus in the search box. An <li> is not focusable, so
                  // without this the mousedown blurs the input to <body> and the
                  // keyboard contract dies mid-dialog: no type-ahead for the
                  // next add, no arrows, no Escape. Harmless in single mode
                  // (the click closes the popup); load-bearing once a row ADDS
                  // and the popup stays open. Click still fires.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(it)}
                  data-testid={`${testid}-opt-${it.id}`}
                >
                  {/* No drawing here — see `ObjectItem`. The row carries the
                      name; the picture is on the properties panel at a size
                      where it says something. */}
                  <span className="op-opt-name">{it.name}</span>
                  {selected.has(it.id) && (
                    <span className="op-tick" aria-hidden="true">
                      {mode === 'multi' ? '✓ added' : '✓'}
                    </span>
                  )}
                  {it.detail && <span className="op-opt-detail">{it.detail}</span>}
                  {/* In multi mode a row's action is ADD, and it stays open so
                      several can be added in one visit — founder, 2026-08-08.
                      The pill names the action the NEXT press performs, so an
                      already-added row says Remove rather than continuing to
                      offer Add and quietly doing the opposite.

                      aria-hidden because `role="option"` already carries
                      aria-selected, which is what assistive tech announces for a
                      multi-selectable listbox; repeating it in the option's
                      accessible NAME would have every row read its own verb.

                      A disabled row gets no pill: search lists it, the reason is
                      readable, and it is still not addable. */}
                  {mode === 'multi' && !it.disabled && (
                    <span
                      className={`op-act${selected.has(it.id) ? ' op-act-remove' : ''}`}
                      aria-hidden="true"
                      data-testid={`${testid}-act-${it.id}`}
                    >
                      {selected.has(it.id) ? 'Remove' : 'Add'}
                    </span>
                  )}
                  {/* Visible, unselectable, and SAYING WHY — the whole point of
                      rule 1. An unusable row with no reason is just a mystery. */}
                  {it.disabled && it.disabledReason && (
                    <span className="op-opt-reason">{it.disabledReason}</span>
                  )}
                  {/* Only where deletion is a real, reversible act — see
                      `removableOf`. A shipped catalogue row lives in the bundle
                      and cannot be deleted, so it gets no control that says it
                      can be. */}
                  {onRemoveItem && removableOf(it) && (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="op-rm"
                      aria-label={`remove ${it.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveItem(it);
                      }}
                      data-testid={`${testid}-rm-${it.id}`}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
              {items.length === 0 && <li className="op-note">{emptyMessage}</li>}
              {items.length > 0 && visible.length === 0 && (
                /* WHICH control emptied the list, named. Before the facet
                   existed this could only ever be the search box; now an empty
                   list has two possible causes and a message naming the wrong
                   one sends the user to clear a control that was not the
                   problem. Either way it ends the same: nothing was dropped for
                   being unusable, and here is how to see all of them. */
                <li className="op-note" data-testid={`${testid}-none-match`}>
                  {(() => {
                    /* WHICH controls emptied the list, NAMED — all of them, in
                       order. With one facet this could name the only candidate;
                       with several, naming one sends the operator to clear a
                       control that was not the problem, and the list stays
                       short and reads as "there are none". */
                    const names = activeFacets
                      .filter((s) => s.hidden > 0)
                      .map((s) => `${s.label} filter`);
                    const list =
                      names.length === 0
                        ? ''
                        : names.length === 1
                          ? names[0]
                          : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
                    if (q !== '' && names.length) {
                      return `No name matches “${query}” among the rows the ${list} ${
                        names.length === 1 ? 'is' : 'are'
                      } showing.`;
                    }
                    if (q !== '') return `No name matches “${query}”.`;
                    if (names.length) {
                      return `The ${list} ${names.length === 1 ? 'is' : 'are'} showing no rows.`;
                    }
                    return 'No row is showing.';
                  })()}{' '}
                  Nothing was dropped for being unusable — clear the search
                  {activeFacets.some((s) => s.hidden > 0) ? ' and the filters' : ''} to see all{' '}
                  {items.length}.
                </li>
              )}
            </ul>

            <div className="op-props" data-testid={`${testid}-props`}>
              {previewItem ? (
                <>
                  <h4 className="op-props-name">{previewItem.name}</h4>
                  {previewItem.detail && (
                    <p className="op-props-detail">{previewItem.detail}</p>
                  )}
                  {previewItem.disabled && (
                    <p className="op-props-blocked" data-testid={`${testid}-blocked`}>
                      {previewItem.disabledReason ?? 'Not usable here.'}
                    </p>
                  )}
                  {/* 🔴 THE DRAWING, AND IT IS NOT DECORATION HERE — TODO #60.
                      No `aria-hidden`: on this panel the shape is a primary
                      description of the object, so it keeps the `role="img"`
                      and `aria-label` its own component gives it, and the same
                      sentence is rendered visibly below it. See `ObjectItem.shape`
                      for why the label is required by the type rather than
                      optional beside it, and for why nothing is drawn at all for
                      the catalogues that have no honest shape. */}
                  {previewItem.shape ? (
                    <>
                      <div className="op-props-shape" data-testid={`${testid}-shape`}>
                        {previewItem.shape.node}
                      </div>
                      <span
                        className="op-props-shape-label"
                        data-testid={`${testid}-shape-label`}
                      >
                        {previewItem.shape.label}
                      </span>
                    </>
                  ) : null}
                  {previewItem.properties && previewItem.properties.length > 0 ? (
                    <dl className="op-props-dl">
                      {previewItem.properties.map((p) => (
                        <div key={p.label} style={{ display: 'contents' }}>
                          <dt>{p.label}</dt>
                          <dd>
                            {p.input ? (
                              p.input.kind === 'bool' ? (
                                <input
                                  type="checkbox"
                                  checked={Boolean(draftFor(previewItem?.id)[p.input.key] ?? p.value)}
                                  data-testid={`${testid}-edit-${p.input.key}`}
                                  onChange={(e) =>
                                    setDraft((d) => ({
                                      rowId: previewItem?.id ?? null,
                                      values: {
                                        ...(d.rowId === (previewItem?.id ?? null) ? d.values : {}),
                                        [p.input!.key]: e.target.checked,
                                      },
                                    }))
                                  }
                                />
                              ) : (
                                <input
                                  className="op-edit"
                                  type={p.input.kind === 'number' ? 'number' : 'text'}
                                  step={p.input.step}
                                  min={p.input.min}
                                  max={p.input.max}
                                  value={String(draftFor(previewItem?.id)[p.input.key] ?? p.value)}
                                  data-testid={`${testid}-edit-${p.input.key}`}
                                  onChange={(e) =>
                                    setDraft((d) => ({
                                      rowId: previewItem?.id ?? null,
                                      values: {
                                        ...(d.rowId === (previewItem?.id ?? null) ? d.values : {}),
                                        [p.input!.key]:
                                          p.input!.kind === 'number'
                                            ? Number(e.target.value)
                                            : e.target.value,
                                      },
                                    }))
                                  }
                                />
                              )
                            ) : (
                              /* DERIVED — text, never a field. See ObjectProperty. */
                              p.value
                            )}
                            {p.input?.unit ? ` ${p.input.unit}` : ''}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    /* Honest absence: "the caller supplied none" is a different
                       fact from "this object has none", and only the first is
                       something this component can know. */
                    <p className="op-note">No properties were supplied for this object.</p>
                  )}
                  {/* ── THE CLAIM ──────────────────────────────────────────────
                      🔴 IT IS BELOW THE PROPERTIES AND ABOVE THE SAVE ROW, and
                      the placement is the argument: everything above it is the
                      app describing the object, everything below it writes a
                      saved OBJECT, and this writes neither — it records
                      something the operator knows and this app cannot.

                      🔴 THE CURRENT VALUE IS RENDERED EVEN WHEN IT IS NOT
                      CHOOSABLE. A `<select>` whose `value` is absent from its
                      options silently displays the FIRST one, which would show a
                      verdict nobody holds — the exact class of lie this list
                      exists to prevent. So the host is required to include the
                      current value among the options (`unavailable` is how a
                      value that may be shown but not chosen is expressed), and
                      the guard below states it on screen rather than papering
                      over it, because a component cannot fix a host's mistake by
                      picking a value for it. */}
                  {previewItem.claim ? (
                    (() => {
                      const c = previewItem.claim!;
                      const current = c.options.find((o) => o.value === c.value);
                      return (
                        <div className="op-claim" data-testid={`${testid}-claim`}>
                          <label
                            className="op-claim-label"
                            htmlFor={`${uid}-claim`}
                            data-testid={`${testid}-claim-label`}
                          >
                            {c.label}
                          </label>
                          <select
                            id={`${uid}-claim`}
                            data-testid={`${testid}-claim-select`}
                            value={c.value}
                            onChange={(e) => {
                              const next = c.options.find((o) => o.value === e.target.value);
                              /* An unavailable option is `disabled` in the
                                 markup and cannot be chosen by pointer or
                                 keyboard — this is the second lock, for a
                                 driver setting `.value` directly. It is not
                                 defensive noise: `e2e` does exactly that. */
                              if (!next || next.unavailable) return;
                              c.onChange(next.value);
                            }}
                          >
                            {c.options.map((o) => (
                              <option key={o.value} value={o.value} disabled={!!o.unavailable}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          {!current ? (
                            <p className="op-claim-why bad" data-testid={`${testid}-claim-unlisted`}>
                              This control is showing the wrong value: the state this row is
                              actually in ({c.value}) is not among the options offered, so what the
                              box reads is the first option and not the truth. Nothing has been
                              written; treat the words above the control as the answer.
                            </p>
                          ) : null}
                          {/* Why the CURRENT value cannot be re-chosen, or why
                              some other one cannot — listed, never dropped. */}
                          {c.options
                            .filter((o) => o.unavailable)
                            .map((o) => (
                              <p
                                key={o.value}
                                className="op-claim-why"
                                data-testid={`${testid}-claim-why-${o.value}`}
                              >
                                <b>{o.label}</b> — {o.unavailable}
                              </p>
                            ))}
                          {c.consequence ? (
                            <p
                              className="op-claim-consequence"
                              data-testid={`${testid}-claim-consequence`}
                            >
                              {c.consequence}
                            </p>
                          ) : null}
                          {c.note ? (
                            <p className="op-claim-note" data-testid={`${testid}-claim-note`}>
                              {c.note}
                            </p>
                          ) : null}
                        </div>
                      );
                    })()
                  ) : null}
                  {/* Shown whenever saving is possible AT ALL — not only when
                      an object is previewed with editable fields. With an empty
                      library there is nothing to preview, and that is precisely
                      when a person needs to save the first one. */}
                  {onSave || onSaveAs ? (
                    <div className="op-saverow">
                      {/* Save over the same object — only for the user's own.
                          A built-in has no Save on purpose: there would be no
                          way back to the shipped values. */}
                      {onSave && previewItem && !previewItem.builtIn && (
                        <button
                          type="button"
                          data-testid={`${testid}-save`}
                          onClick={() => {
                            onSave(previewItem!, draftFor(previewItem?.id));
                            setDraft({ rowId: null, values: {} });
                          }}
                        >
                          Save
                        </button>
                      )}
                      {onSaveAs && (
                        <>
                          <input
                            className="op-edit"
                            placeholder={
                              !previewItem
                                ? 'save the current settings as…'
                                : previewItem.builtIn
                                  ? 'save as…'
                                  : 'save as a new name…'
                            }
                            value={saveAsName}
                            data-testid={`${testid}-saveas-name`}
                            onChange={(e) => setSaveAsName(e.target.value)}
                          />
                          <button
                            type="button"
                            data-testid={`${testid}-saveas`}
                            disabled={!saveAsName.trim()}
                            onClick={() => {
                              /* 🔴 `null` MEANS "save what the caller holds", and
                                 that is the honest answer when the preview is
                                 row 0 rather than a row the user chose. Editing
                                 a property IS choosing, so a non-empty draft
                                 counts even if the row was never moved to. */
                              /* The draft counts as choosing only when it is THIS
                                 row's — a draft belonging to a row the operator
                                 has since moved away from says nothing about
                                 what they are looking at now. */
                              const mine = draftFor(previewItem?.id);
                              const chosen = activeChosen || Object.keys(mine).length > 0;
                              onSaveAs(chosen ? (previewItem ?? null) : null, mine, saveAsName.trim());
                              setDraft({ rowId: null, values: {} });
                              setSaveAsName('');
                            }}
                          >
                            Save as
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <></>
                  )}
                </>
              ) : (
                <>
                  <p className="op-note">
                    {items.length === 0
                      ? 'Nothing saved yet.'
                      : 'Select or arrow to an item to see its properties.'}
                  </p>
                  {/* 🔴 THE FIRST SAVE. With an empty library there is no item to
                      preview, and the save controls above live inside the
                      preview branch — so removing the panel's own Save box left
                      an app where the first machine could never be saved and
                      every later one could. A control that only works once you
                      already have what it creates is not a control.
                      Caught by a test that was left failing rather than muted. */}
                  {onSaveAs && (
                    <div className="op-saverow">
                      <input
                        className="op-edit"
                        placeholder="save the current settings as…"
                        value={saveAsName}
                        data-testid={`${testid}-saveas-name`}
                        onChange={(e) => setSaveAsName(e.target.value)}
                      />
                      <button
                        type="button"
                        data-testid={`${testid}-saveas`}
                        disabled={!saveAsName.trim()}
                        onClick={() => {
                          // No item, so no draft: this saves what the CALLER
                          // currently holds, under a new name.
                          onSaveAs(null, {}, saveAsName.trim());
                          setSaveAsName('');
                        }}
                      >
                        Save as
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* RULE 1's visible half. The count is announced politely, because a
              screen-reader user cannot see a footer they were never sent to. */}
          <div className="op-foot">
            <span aria-live="polite" data-testid={`${testid}-hidden-count`}>
              {hidden > 0 ? (
                <span className="op-foot-hidden">
                  {/* ATTRIBUTED, not totalled. A count that says only "12 hidden"
                      leaves the user clearing the wrong control — and if they
                      clear the search and the facet is still on, the list stays
                      short and reads as "there are none". */}
                  {(() => {
                    const parts = [
                      ...activeFacets
                        .filter((s) => s.hidden > 0)
                        .map((s) => `${s.hidden} by the ${s.label} filter`),
                      ...(hiddenBySearch > 0 ? [`${hiddenBySearch} by search`] : []),
                    ];
                    return (
                      <>
                        {hidden} hidden
                        {parts.length > 1 ? ` (${parts.join(', ')})` : parts.length === 1
                          ? ` ${parts[0].replace(/^\d+ /, '')}`
                          : ''}
                      </>
                    );
                  })()}
                  {hiddenUnusable > 0 && ` — ${hiddenUnusable} of them unusable`}
                </span>
              ) : (
                `${visible.length} shown`
              )}
            </span>
            {/* 🔴 A NUMBER IN THIS DIALOG DISAGREES WITH THE LIST UNDER IT.
                Named, on screen, in the picker it happened in — because the two
                things that disagree are both invisible: the count is printed by
                the dropdown and the membership is decided by a function. Neither
                is inspectable from the operator's chair, and their disagreement
                is exactly what the founder was left holding on 2026-08-11.
                Rendered as a fault rather than a caveat: nothing in this dialog
                can say which of the two numbers is the true one. */}
            {countMismatches.length > 0 && (
              <span className="op-foot-hidden" data-testid={`${testid}-facet-count-mismatch`}>
                ⚠ this list’s own numbers disagree —{' '}
                {countMismatches.map(describeFacetCountMismatch).join('; ')}. Trust neither count
                until that is fixed; the rows themselves are all here.
              </span>
            )}
            {/* 🔴 THE SELECTION MOVED WHILE THE VIEW WAS FILTERED BY IT. The list
                deliberately does NOT re-filter under the cursor — see
                `selectedSnapshot` — so it can go out of date, and a filtered view
                that is quietly stale is exactly the kind of green this app spends
                its life removing. Offered as an act, never done silently. */}
            {snapshotDrifted && (
              <button
                type="button"
                className="op-showall"
                title="The list is showing the selection as it was when this filter was applied. Your selection has changed since."
                onClick={() => {
                  snapshotNow();
                  // Row 0 again, and row 0 is a DEFAULT — see `activeChosen`.
                  // Missing here and on `show all` until 2026-08-27: arrow to a
                  // row (arming the flag), press this, and the preview lands on
                  // a row nobody chose while the flag still says they did.
                  setActiveChosen(false);
                  setActiveIndex(0);
                }}
                data-testid={`${testid}-facet-reapply`}
              >
                re-apply Selected
              </button>
            )}
            {hidden > 0 && (
              <button
                type="button"
                className="op-showall"
                onClick={() => {
                  setQuery('');
                  // Clears EVERY narrowing control, because the button says
                  // "show all N" and a button that shows fewer than N after
                  // being pressed is a control that lies about its own label.
                  // That includes facets added after this line was written —
                  // it walks the list rather than naming them.
                  for (const f of allFacets) if (f.value !== '') f.onChange('');
                  setActiveChosen(false);
                  setActiveIndex(0);
                  inputRef.current?.focus();
                }}
                data-testid={`${testid}-showall`}
              >
                show all {items.length}
              </button>
            )}
            {/* Cancel = close and PUT BACK what was selected when this opened.
                Not "close": multi-select commits every toggle immediately, so a
                button labelled Cancel that kept those changes would be lying
                about its own name.

                🔴 It is now the ONLY exit that reverts. Escape used to do this
                too and no longer does — `revert` above carries the browser
                measurement and the reason. The rule that replaced the old one:
                the exit whose LABEL promises the change is discarded is the only
                exit that discards it. */}
            <button
              type="button"
              className="op-cancel"
              onClick={() => revert(true)}
              data-testid={`${testid}-cancel`}
            >
              Cancel
            </button>
            {/* Multi mode only, and it is not decoration. Once a row ADDS and
                the popup stays open, every remaining exit is a DISMISSAL —
                Escape, click-away, Tab — and a dismissal that happens to keep
                the set is not the same as saying "yes, these". A set-building
                dialog needs one control whose label promises the commit, for
                the same reason Cancel is the only control that promises the
                discard. Single mode has no Done because choosing a row is
                already the commit.

                🔴 CORRECTED 2026-08-11. This comment read *"the two obvious
                ways out both revert (Cancel, Escape) — leaving 'click somewhere
                else' as the only way to keep what you just did."* **Escape has
                not reverted since `6b1272810`**, and `revert` 900 lines above
                says so in its own table. So the reason given for this button
                was the pre-`6b1272810` app, in the one file whose entire safety
                argument is which exits discard a machining decision — the same
                shape of defect `6b1272810` itself fixed, left behind in the
                prose that described it. The button is still right; the reason
                was not. */}
            {mode === 'multi' && (
              <button
                type="button"
                className="op-done"
                onClick={() => closePopup(true)}
                data-testid={`${testid}-done`}
              >
                Done
              </button>
            )}
          </div>
          {/* LAST CHILD on purpose: the grips are absolutely positioned against
              this dialog and must paint over the foot rather than under it. */}
          {rz.grips}
        </div>
        </>
      )}
    </div>
  );
}

export { ObjectPicker };
