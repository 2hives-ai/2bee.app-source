/**
 * Ownership display helpers — pure, no React state.
 *
 * Extracted from App.tsx to reduce file size.
 * These functions transform inventory rows into display properties and items.
 */

import type { ObjectProperty, ObjectItem } from '../ObjectPicker';
import type { InventoryRow } from '../inventory';
import { KIND_LABEL, ownershipTag } from '../inventory';

/** `TAG · rest`, or just the tag when a row has nothing else to say. */
export function withTag(tag: string, rest?: string): string {
  return rest ? `${tag} · ${rest}` : tag;
}

/**
 * The two properties every inventory-backed row carries, in this order.
 *
 * 🔴 THEY ARE TWO QUESTIONS AND THEY STAY TWO. *Where did the numbers come
 * from* and *who says you have it* have different answers and different
 * lifetimes — a catalogue-defined cutter can be owned, and a cutter somebody
 * typed can be owned too. `inventory.ts` keeps `definition` and `asserted_by`
 * apart for that reason, and collapsing them here would put the proxy bug back
 * one layer up.
 *
 * `provenance` REPLACES `shipped()`'s "Where this came from" on these pickers
 * rather than joining it: it already opens with *"Shipped with this build"* for
 * a catalogue row nobody has claimed, and two properties with the same label
 * disagreeing is the thing a properties panel must never do.
 */
export function ownershipProps(r: InventoryRow): ObjectProperty[] {
  return [
    { label: 'Where this came from', value: r.provenance },
    { label: 'Do you own it?', value: `${ownershipTag(r.ownership)} — ${r.ownership.why}` },
  ];
}

/**
 * A row the INVENTORY carries and the shipped catalogue does not.
 *
 * 🔴 LISTED, AND NOT SELECTABLE, AND THE TWO HALVES HAVE DIFFERENT REASONS.
 * Listed because rule 1 is not negotiable: on screen a hidden item and a
 * non-existent item are identical, and a shop that owns a cutter this build has
 * never heard of most needs to SEE that it is theirs and unusable here. Not
 * selectable because this app has no route to install a definition out of the
 * inventory file — the numbers a program is planned against live in the core's
 * catalogue and in the tool-file importer, not here — so selecting it could only
 * ever plan against something else. That is a HOST limit, stated as one; it is
 * not the ownership verdict, which for these rows is usually `held`.
 *
 * ⚠ The fields the file carried are shown VERBATIM and computed on by nothing.
 * `OwnedEntry.fields` says so in its own doc, and a number lifted out of an
 * inventory file into a machining rule would be the invented-clamp-geometry
 * defect with a JSON file in front of it.
 *
 * ⚠ AND IT CARRIES NO `claim` CONTROL — TODO #105, stated rather than left as a
 * hole somebody later reads as an oversight. These rows exist ONLY because an
 * imported file names an id this build cannot define, and the per-row control is
 * how a shop says whether it holds something the build CAN. There is no route in
 * this app that creates one of these (the control appears on catalogue rows, so
 * an operator can only ever claim an id this build knows), and the way one goes
 * away is another import — which replaces the imported set whole. A "no" here
 * would delete a line out of somebody else's stock-take through a picker, which
 * is a different act from answering a question about your own shelf.
 */
export function inventoryOnlyItem(r: InventoryRow): ObjectItem {
  const label = KIND_LABEL[r.kind];
  return {
    id: r.id,
    name: r.name,
    detail: withTag(r.tags.join(' · '), `in your inventory; this build carries no ${label} by that id`),
    disabled: true,
    disabledReason:
      r.disabledReason ??
      `Your inventory lists this ${label} and THIS BUILD HAS NO DEFINITION OF IT — none of the ` +
        `numbers a program would be planned against are here. It is listed because it is yours; ` +
        `it cannot be chosen because nothing could be planned with it.`,
    properties: [
      ...ownershipProps(r),
      ...Object.entries(r.entry?.fields ?? {}).map(([k, v]) => ({
        label: `Stated in the inventory: ${k}`,
        value: `${v} — carried from the file and read by no check in this app.`,
      })),
      ...(r.entry?.note ? [{ label: 'Note in the inventory file', value: r.entry.note }] : []),
    ],
  };
}
