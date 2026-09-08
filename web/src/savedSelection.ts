/* =============================================================================
 * WHICH SAVED ROW IS TICKED — Machine, Workpiece, and anything shaped like them
 * =============================================================================
 *
 * Founder, 2026-08-11: *"I have saved as a new Machine but I can't select it,
 * why?"*
 *
 * ⚠ THIS FILE WAS `machineSelection.ts` UNTIL THE WORKPIECE PICKER WAS FIXED
 * WITH IT. The rule was never about machines; the *name* was, and a module
 * named for its first caller is how two copies of one rule get written. The
 * machine history below is kept verbatim because it is the evidence, not
 * because the rule is the machine's.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHAT WAS ACTUALLY WRONG — AND IT IS NOT THE TWO THINGS IT LOOKS LIKE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Traced at the code, in this order, because "saved and missing" and "saved and
 * unusable" are different bugs that look identical from the operator's chair:
 *
 *   ✅ **It reaches storage.** `currentMachine()` writes every field the reader
 *      reads; `useSaved('machines')` calls `refresh()` after a successful write
 *      and surfaces a failed one as a note rather than swallowing it.
 *   ✅ **It reaches the picker.** The `items` array spreads
 *      `savedMachines.items` alongside `MACHINE_PRESETS`. A saved machine is
 *      listed, is not `disabled`, and is not filtered by the inventory (only
 *      PRESET rows take an ownership verdict).
 *   ✅ **Clicking it works.** `ObjectPicker.commit` calls `onChange` in single
 *      mode, and `App.tsx`'s handler loads all ten fields.
 *
 * 🔴 **WHAT DOES NOT WORK IS THE TICK, AND THE TICK IS THE ONLY FEEDBACK THERE
 * IS.** `selectedIds` for that picker was:
 *
 *     MACHINE_PRESETS.filter(m => m.travel_x_mm === travelX && ...)
 *
 * — a set derived ENTIRELY FROM THE SHIPPED PRESET LIST. It is structurally
 * incapable of containing a machine the operator saved. So: the row is chosen,
 * the numbers load, the dialog closes, and the trigger goes back to reading
 * **"choose a machine…"** with nothing ticked. There is no state in which the
 * app agrees that the saved machine was selected — which is exactly the sentence
 * the founder used.
 *
 * ⚠ AND IT IS WORST IN THE CASE HE HIT. A saved machine whose travels match no
 * preset produces an EMPTY selection, so the control reads as though nothing was
 * ever chosen. If its travels happen to match a preset, the PRESET ticks instead
 * — the app naming a different machine than the one that was loaded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE SAME DEFECT SHIPPED IN THE WORKPIECE PICKER, AND WAS FOUND BY LOOKING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `App.tsx`'s workpiece list computed its tick as
 *
 *     SHEET_SIZES.filter(s => (s.w === stockX && s.h === stockY) || …)
 *
 * — the shipped SHEET catalogue, filtered by dimension. Structurally identical,
 * and structurally incapable of containing a saved workpiece for exactly the
 * same reason. It was left standing for one commit *deliberately* (it collided
 * with the material change landing beside it) and is fixed here by CALLING this
 * module, not by copying it. Two near-identical selection rules in one file is
 * the state this lane keeps filing defects about; the second caller is what
 * turned the machine's rule into a rule.
 *
 * ⚠ THE TWO CALLERS DIFFER IN ONE PLACE AND IT IS THE ARGUMENT, NOT THE RULE:
 * a machine's catalogue rows match on TRAVELS, a workpiece's on DIMENSIONS
 * UNORDERED (a 900x600 sheet is the same sheet as a 600x900 one laid the other
 * way — how it is laid is `rotation`, a separate field with its own control).
 * That comparison stays at the call site, where the fields have names. What is
 * shared is the part that was wrong in both: *the loaded row is added to the
 * catalogue's answer, and only while the panel still describes it.*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 IT IS THE SPOILBOARD-EYE DEFECT AGAIN, IN A SECOND AND THIRD CONSUMER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `scene.spoilboard` was `report?.spoilboard ?? null` while every sibling fell
 * back to the DECLARATION, so a board the founder had genuinely selected was
 * invisible — *"I did choose a spoilboard but the eye did not come up."* Same
 * shape here: one consumer answers "what is selected?" from a DERIVED source (a
 * travel match, a dimension match, against a shipped catalogue) instead of from
 * what was declared. The fix there was to read the declaration; the fix here is
 * the same.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT SIMPLY REMEMBER THE ID — THE OBJECTION THE OLD CODE RAISED WAS REAL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The comment that stood over the old rule defended the asymmetry:
 *
 *   > *"A saved machine is TEN numbers, and after loading one the operator is
 *   > free to change any of them — a tick that survived that would be claiming
 *   > the panel still describes the saved object when it does not."*
 *
 * **That objection is correct and it is kept.** A latched id alone would go
 * stale the moment a travel is retyped, and a control asserting "this is the
 * machine you are on" while the numbers underneath it have moved is a worse
 * defect than the one being fixed — it is a green that means "unchecked".
 *
 * So the tick is **declared AND still true**: the id that was loaded, ticked
 * only while every field of the setup still equals the snapshot that was loaded.
 * Retype one travel — or one workpiece dimension — and the tick drops by itself,
 * with no setter to wrap and nothing to remember to clear. The old rule's
 * guarantee survives; what changes is that a saved row can now hold it.
 *
 * ⚠ NO BROWSER RAN ANY OF THIS. The chain above was read, not exercised: nobody
 * has clicked a saved machine or a saved workpiece and watched the trigger. What
 * IS exercised is the rule in this file, including the two cases that fail on
 * the old rules — see `web/tests/saved-selection.test.ts`.
 * ============================================================================= */

/**
 * A saved setup, compared field-by-field without naming its fields.
 *
 * 🔴 THE KEY LIST IS THE UNION OF BOTH OBJECTS AND IS NEVER WRITTEN DOWN. A
 * hand-maintained list here would go stale the next time `SavedMachine` or
 * `SavedWorkpiece` gains a field — and a comparison blind to a new field reports
 * "unchanged" for a setup that changed, which ticks a row that no longer
 * describes the panel. That is the exact failure this whole file exists to
 * prevent, reintroduced one level down.
 */
export type Snapshot = Record<string, unknown>;

/** `undefined` and "absent" are the same answer — a key omitted on save (an
 *  undeclared spoilboard travel, a workpiece saved before it recorded a
 *  material) must not read as a change on load. */
function eq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  if (a === undefined && b === undefined) return true;
  return Object.is(a, b);
}

/** Does the setup on screen still equal the one that was loaded? */
export function sameSnapshot(a: Snapshot | null, b: Snapshot | null): boolean {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!eq(a[k], b[k])) return false;
  return true;
}

/** What the picker was told was loaded, and what it looked like at that moment. */
export type LoadedRecord = { id: string; snapshot: Snapshot } | null;

/**
 * The rows a picker ticks: what its catalogue matched, PLUS the row that was
 * loaded, while the panel still describes it.
 *
 * @param catalogueIds the shipped rows that match the panel by their own rule —
 *                     travels for a machine, dimensions for a sheet. Passed in
 *                     unchanged, because a shipped row genuinely IS identified
 *                     by those fields and nothing else.
 * @param loaded       what the operator actually chose, if anything.
 * @param current      the setup on the panel right now.
 *
 * 🔴 THE LOADED ROW IS ADDED, NEVER SUBSTITUTED, and it is deduplicated. A saved
 * machine copied from a preset legitimately matches that preset's travels, and
 * dropping the preset tick would make choosing a saved copy look like it
 * unselected the machine it was copied from. Same for a saved workpiece cut from
 * a catalogue sheet size.
 */
export function selectedIdsWithLoaded(
  catalogueIds: string[],
  loaded: LoadedRecord,
  current: Snapshot
): string[] {
  if (!loaded || !sameSnapshot(loaded.snapshot, current)) return catalogueIds;
  return catalogueIds.includes(loaded.id) ? catalogueIds : [...catalogueIds, loaded.id];
}
