/* ownership.ts — THE WRITABLE PROJECTION OF `inventory.ts`'s FOUR VERDICTS.
 *
 * Founder, 2026-08-11 (TODO #105): the ownership axis exists and is wired into
 * all four pickers — that is why every row reads `OWNERSHIP UNCHECKED` — and the
 * operator has no way to write to it. Ownership can arrive only from a file.
 * This module is the per-row control's vocabulary, and nothing else.
 *
 * ── WHY THIS IS A SEPARATE FILE AND NOT PART OF EITHER NEIGHBOUR ────────────
 *
 * `inventory.ts` owns the MODEL — the four verdicts, `blockFor`, `WHY_NO_DEFAULT`
 * and the two plants — and is deliberately not touched here: this change exposes
 * what exists, it does not re-derive it. `App.tsx` owns the wiring, and a rule
 * living there is a rule no node test can reach without importing three.js and a
 * wasm bundle. So the one genuinely new decision — *which of the four verdicts an
 * operator may WRITE, and what happens to the other rows when they do* — lives in
 * a pure, exported, tested file of its own.
 *
 * ── 🔴 THE ASYMMETRY THIS FILE EXISTS TO STATE ─────────────────────────────
 *
 * **The READ is per row and has four values. The WRITE is per row and has TWO,
 * and the third value is a fact about the WHOLE KIND.** That is not a
 * simplification anyone chose here — it is what the stored document can express:
 * `InventoryDoc.entries` is a list of things the shop HAS, so
 *
 *   · `held`      ⇔ this kind's list contains this id
 *   · `not-held`  ⇔ this kind's list is NON-EMPTY and does not contain this id
 *   · `unchecked` ⇔ this kind's list is EMPTY — nothing is known about ANY row
 *
 * ⇒ **Marking the first row of a kind as owned moves every other row of that kind
 * from UNCHECKED to NOT OWNED, and disables them.** That is a consequential act
 * and it is stated AT THE CONTROL, before the press, rather than discovered
 * afterwards by an operator wondering why the rest of the list went grey.
 *
 * ⇒ And *"no, I do not have this"* is **unavailable while the kind is UNCHECKED**,
 * because there would be nothing to remove: the write would store nothing, the
 * row would read back UNCHECKED, and the control would have silently done
 * nothing. A step that can silently do nothing must announce it did something —
 * so this one refuses instead, and says why.
 *
 * ⚠ A BOOLEAN WOULD COLLAPSE `unchecked` AND `not-held`, which `docs/terminology.md`
 * carries as one of the nine safety-bearing distinctions. Every option below is
 * therefore named after the verdict it produces, and all four verdicts are
 * reachable as WORDS on the control even where only two are writable — an
 * unavailable option is listed with its reason, never dropped, for the same
 * reason `ObjectPicker` rule 1 lists an unusable row.
 */

import { KIND_LABEL, type InventoryKind, type OwnershipVerdict } from './inventory';

/** What a press writes. The two the operator may assert; nothing else. */
export type OwnershipWrite = 'held' | 'not-held';

/** One option on the per-row control. `unavailable` ⇒ listed, not choosable. */
export interface OwnershipChoice {
  /** The VERDICT this option produces or names. Never a yes/no. */
  value: OwnershipVerdict['state'];
  label: string;
  /** Why it cannot be chosen from here. Absent ⇒ it can. */
  unavailable?: string;
}

/**
 * How many rows of this kind the inventory lists, and what this row currently
 * reads. The two facts the choices depend on — passed in rather than re-derived,
 * so this file never reaches into the document and cannot disagree with
 * `mergeInventory` about what it says.
 */
export interface OwnershipContext {
  kind: InventoryKind;
  /** Entries the registered inventory holds FOR THIS KIND. `0` ⇒ UNCHECKED. */
  heldInKind: number;
  /** This row's verdict, from `inventory.ts`. */
  state: OwnershipVerdict['state'];
}

/**
 * The consequence sentence for the press that would make this kind's list
 * non-empty for the first time. `null` when there is no such consequence.
 *
 * 🔴 IT IS COMPUTED FROM THE COUNT, not written beside the control, because the
 * sentence is only true in one state and a permanent version of it would be a
 * warning the operator learns to ignore.
 */
export function firstMarkConsequence(ctx: OwnershipContext): string | null {
  if (ctx.heldInKind > 0) return null;
  const label = KIND_LABEL[ctx.kind];
  return (
    `Nothing is recorded about your ${label}s yet, so every row here reads OWNERSHIP UNCHECKED. ` +
    `Marking this one as yours makes the list non-empty — and from that moment every OTHER ${label} ` +
    `in it reads NOT OWNED and cannot be selected, because an inventory that exists and does not ` +
    `list something is saying you do not have it. Mark everything you actually hold.`
  );
}

/**
 * The sentence for the press that would empty this kind's list again.
 * `null` unless this row is the last entry of its kind.
 */
export function lastUnmarkConsequence(ctx: OwnershipContext): string | null {
  if (!(ctx.state === 'held' || ctx.state === 'unresolved') || ctx.heldInKind !== 1) return null;
  const label = KIND_LABEL[ctx.kind];
  return (
    `This is the only ${label} your inventory lists. Removing it empties the list, which is NOT the ` +
    `same as saying you own no ${label}s — it returns every row to OWNERSHIP UNCHECKED, the state ` +
    `that means nothing has told this app either way.`
  );
}

/**
 * The options the control offers, in a fixed order, with every unavailable one
 * carrying its reason.
 *
 * 🔴 THE ORDER IS FIXED AND `held` IS NOT FIRST-BY-DEFAULT-ANYTHING. Nothing here
 * preselects: the control's value is whatever `inventory.ts` already said, and
 * `inventoryDefaultId()` still returns `null` for all four kinds. A control whose
 * opening position asserts ownership would be the `WHY_NO_DEFAULT` defect wearing
 * a dropdown.
 */
export function ownershipChoices(ctx: OwnershipContext): OwnershipChoice[] {
  const label = KIND_LABEL[ctx.kind];
  const out: OwnershipChoice[] = [
    { value: 'held', label: `Yes — this ${label} is in my shop` },
    {
      value: 'not-held',
      label: `No — I do not have this ${label}`,
      unavailable:
        ctx.heldInKind === 0
          ? `Nothing is recorded about your ${label}s at all, so a "no" here has nowhere to be ` +
            `written: this app stores what you HAVE, and a list that stays empty reads back as ` +
            `UNCHECKED, not as "you do not have it". Mark a ${label} you DO hold first — or import ` +
            `an inventory file — and every ${label} you have not marked then reads NOT OWNED.`
          : undefined,
    },
    {
      value: 'unchecked',
      label: 'Not checked — nothing has been recorded either way',
      unavailable:
        ctx.heldInKind === 0
          ? undefined
          : `UNCHECKED is a fact about every ${label} at once, not about this row: it means nothing ` +
            `has told this app which ${label}s you have. Your inventory lists ` +
            `${ctx.heldInKind} of them, so that is no longer true. Remove them all to get back to it.`,
    },
  ];
  /* Listed ONLY when it is what this row currently reads. It is not a state
   * anybody can choose — it is what an ownership claim looks like when it meets a
   * build that has no such catalogue entry — and offering it as an option would
   * invite somebody to assert it. Present so the control can render its own
   * value rather than silently showing a different one. */
  if (ctx.state === 'unresolved') {
    out.push({
      value: 'unresolved',
      label: 'Owned, but this build has no definition of it',
      unavailable:
        `This is not a choice. Your inventory claims this ${label} and THIS BUILD HAS NO ENTRY ` +
        `for the id — refused rather than matched to something similar. The two ways out are a ` +
        `build that carries it or an inventory that names one this one does: choosing "no" here ` +
        `removes the claim.`,
    });
  }
  return out;
}

/**
 * 🔴 THE MACHINE DECISION, WRITTEN DOWN RATHER THAN LEFT TO THE DATA MODEL.
 *
 * An operator has one machine or none, so an exclusive control — marking a second
 * machine unmarks the first — is the obvious build. **It is not built, and that is
 * a decision.** Unmarking the first would be this app DELETING a claim a human
 * made, silently, as a side effect of a different press. `applyImport` already
 * refuses to do that in the other direction (*"the operator's own entries were
 * never in the file and dropping them would be this app deleting a shop's record
 * of its own kit"*), and a shop with two routers, or one being replaced, is not a
 * contradiction this file gets to resolve.
 *
 * So a second machine is ACCEPTED and REPORTED. The count is stated where it can
 * be acted on, which is a smaller claim than exclusivity and a true one.
 */
export const MACHINE_EXCLUSIVITY =
  'Nothing here unmarks another machine when you mark this one. Most shops have exactly one, so ' +
  'two marked machines is usually a leftover rather than a second router — but unmarking the first ' +
  'one for you would be this app deleting something you said, as a side effect of something else ' +
  'you said. It is reported instead, and you remove the one that is wrong.';

/**
 * The one sentence under the control, per kind.
 *
 * 🔴 THREE OF THE FOUR KINDS ARE NOT THE SAME QUESTION, so they do not get the
 * same sentence:
 *
 *   · **spoilboard** is STOCK — *do I have a board like this on the shelf* — and
 *     the answer this app records is PRESENCE, never a count. There are no
 *     quantities anywhere in `inventory.ts` and this line says so, because a shop
 *     with one board left and a shop with forty read identically here.
 *   · **machine** is the one an operator plausibly has exactly one of, and the
 *     decision NOT to enforce that is stated at the control — see
 *     {@link MACHINE_EXCLUSIVITY}.
 *   · **workholding** sits nearest an ATTESTATION, and owning a clamp is not the
 *     machine being clear. `Fixturing::confirmed_clear` is a statement about TODAY,
 *     `App.tsx` deliberately refuses to restore it, and this control does not
 *     touch it in either direction.
 */
export const KIND_NOTE: Record<InventoryKind, string> = {
  machine: `Whether this machine is the one in your shop. ${MACHINE_EXCLUSIVITY}`,
  spoilboard:
    'This records PRESENCE, not a count. "Yes" means a board like this is on your shelf; it does ' +
    'not say how many are left, and nothing in this app tracks that — a shop with one board and a ' +
    'shop with forty read identically here. It is still three answers and not two: "I have it", ' +
    '"I do not have it", and "nobody has said".',
  workholding:
    'This is about OWNING the hold-down, and nothing else. It is NOT the statement that the machine ' +
    'is clear: that one is an attestation about today, it is asked separately on every session, and ' +
    'it is deliberately never restored. Owning a clamp is not the machine being clear, and marking ' +
    'one here does not answer that question or move it one inch.',
  tool:
    'Whether the cutter is in your shop — a different question from whether it fits this setup. ' +
    'Both can block a row and they are printed as two labelled clauses when both apply: one sends ' +
    'you to a purchase order, the other to the collet drawer.',
};

/**
 * The line that appears once a kind lists more than one machine.
 * `null` for every other kind and for a single machine.
 */
export function machineCountNote(kind: InventoryKind, heldInKind: number): string | null {
  if (kind !== 'machine' || heldInKind < 2) return null;
  return (
    `Your inventory lists ${heldInKind} machines. That is allowed and nothing has been unmarked for ` +
    `you — but this app plans against the ONE selected in this panel, so if the others are leftovers ` +
    `they are quietly declaring kit you do not have.`
  );
}

/**
 * 🔴 WHETHER THE PLANNER MAY USE SOMETHING MARKED `not-held` — THE STATED
 * DECISION, in one place, because a default here is not acceptable.
 *
 * **It may, and it is never silent.** The three limbs, and each is a separate
 * property somebody could break:
 *
 *   1. A `not-held` row is DISABLED in every picker (`blockFor`), so it cannot be
 *      SELECTED. This control is the one way a row can become `not-held` while
 *      already selected — mark a cutter you are using as one you do not have —
 *      and that is a real state, not an edge case.
 *   2. The selection is NOT dropped for you. Deselecting a cutter because you
 *      answered a question about your shelf would be this app editing the program
 *      as a side effect of a stock-take, and the operator would find out at the
 *      machine which operation lost its tool.
 *   3. So the job carries a REFUSAL, in `resolveSelection`'s own words, rendered
 *      where the selection is — `tool-inventory-refused` and its three siblings —
 *      and it names the item rather than counting it.
 *
 * ⚠ THE HONEST LIMIT: that refusal is on the SCREEN and is not a gate. This app
 * will still post a program whose cutter your inventory says you do not own, and
 * saying so is the point — *"you may plan with it and here is the sentence that
 * says you did"* is a decision; *"it silently plans"* is not.
 */
export const NOT_HELD_AND_THE_PLAN =
  'Marking something you have SELECTED as "not in my shop" does not deselect it and does not stop ' +
  'the program being planned. What it does is put a refusal on the panel naming that exact item — ' +
  'this app will not quietly plan around your answer, and it will not quietly edit your job to ' +
  'agree with it either. Clear the selection yourself if that is what you meant.';
