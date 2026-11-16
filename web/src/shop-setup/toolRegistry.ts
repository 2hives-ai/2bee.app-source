/* toolRegistry.ts — THE CUTTERS THIS SHOP HAS, REGISTERED ONCE BY A HUMAN.
 *
 * Founder, 2026-10-14: *"similar to the tools, have a tools page and I will
 * add / remove, make a photo of all tools what will be registered to the
 * system?"* — and, same day: *"if measurement needed the system will show what
 * needs to be measured and how"*.
 *
 * ── WHAT THIS IS ───────────────────────────────────────────────────────────
 *
 * Pure logic for the Tools page. It is NOT a second inventory: every record it
 * writes is an `OwnedEntry` of kind `'tool'` in `inventory.ts`'s one document,
 * written through `addOperatorEntry` / `removeEntry`, stored by `store.ts` in
 * the `inventory` collection. The pickers in `App.tsx` already read that
 * document, so a cutter registered here is a cutter the rest of the app sees.
 *
 * Two ways a cutter gets on the list:
 *   (a) CATALOGUE — an id the core's `default_library()` ships, marked owned.
 *       Written exactly the way `App.tsx::claimOwnership` writes it (definition
 *       `operator`, no fields): a browser click is never laundered into the
 *       `catalogue` vocabulary a sourced file uses.
 *   (b) SHOP-DEFINED — a cutter the catalogue does not carry, with the numbers
 *       the planner needs, MEASURED by the operator. Stored in `fields`.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * - It does not decide whether a cutter FITS a job (collet, reach, rpm). That is
 *   the core's verdict (`recommend.rs`) and is never re-derived in TypeScript.
 * - It does not read numbers off a photo. A photo is for a human to recognise
 *   the cutter; diameter comes from calipers. (The AI's photo proposal,
 *   `toolPhotoAsk.ts`, only FILLS the form; it passes `validateToolDraft` like
 *   anything typed, and the page says to measure before use.)
 * - It does not pick a default cutter, and it does not fill a missing field with
 *   a plausible value. A shop-defined cutter with no type or no diameter is
 *   REFUSED, naming the field — `fixtures.rs`'s `unwrap_or_else(|| end_mill(6.0))`
 *   is the failure this refuses to repeat.
 * - Optional measurements left blank are stored as ABSENT, never as zero. An
 *   absent cutting length is "not measured", which the page shows plainly.
 */

import { addOperatorEntry, removeEntry, type InventoryDoc, type OwnedEntry } from '../inventory';
import type { ToolRow } from '../cam';

/* ── Types of cutter — the CORE's categories, spelled as the core spells them ── */

/**
 * `core/src/types.rs::ToolCategory::as_str()`, verbatim. The planner asks every
 * process question through the category (a drill has no side edge; a V-bit's
 * width depends on depth), so a shop-defined cutter carries one of these and
 * nothing else — a free-text type would be a label the core cannot act on.
 */
export const TOOL_TYPES = [
  'End Mill',
  'Ball Nose',
  'V-Bit',
  'Chamfer',
  'Drill',
  'Countersink',
  'Surfacing',
  'Engraving',
  'Thread Mill',
] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

/** `ToolCategory::is_angular()` — these need an included angle, and the core
 *  refuses an angular tool without one (`ToolFault::MissingAngle`). */
export const ANGULAR_TYPES: readonly ToolType[] = ['V-Bit', 'Chamfer', 'Countersink', 'Engraving'];

/** `core/src/types.rs::Flute` as `ToolRow.flute_type` reports it. A compression
 *  cutter is an end mill with this set to `compression`, not a type of its own. */
export const FLUTE_DIRECTIONS = ['straight', 'up-cut', 'down-cut', 'compression'] as const;

export function isToolType(v: string): v is ToolType {
  return (TOOL_TYPES as readonly string[]).includes(v);
}

/* ── The fields, and how each one is MEASURED ──────────────────────────────── */

export type MeasuredField =
  | 'diameter_mm'
  | 'flutes'
  | 'cutting_length_mm'
  | 'shank_mm'
  | 'overall_length_mm'
  | 'included_angle_deg';

/**
 * Every number a human has to obtain, with what it is and how to get it.
 *
 * Founder 2026-10-14: *"if measurement needed the system will show what needs to
 * be measured and how"* and *"show it in an image"*. `what` and `how` are shown
 * beside the input while it is being filled; `measureDiagrams.tsx` draws the
 * picture, one per field, and a test asserts both exist for every entry here.
 */
export interface FieldGuide {
  key: MeasuredField;
  label: string;
  unit: 'mm' | 'count' | '°';
  /** One plain sentence: what to measure. */
  what: string;
  /** How: the instrument and where it goes. */
  how: string;
}

export const FIELD_GUIDES: readonly FieldGuide[] = [
  {
    key: 'diameter_mm',
    label: 'Cutting diameter',
    unit: 'mm',
    what: 'The width of the cutting part — the size of the slot this cutter makes.',
    how: 'Calipers across two opposite cutting edges, near the tip, not across the shank. On an odd number of flutes, measure edge to the flute valley opposite and read the printed size too.',
  },
  {
    key: 'flutes',
    label: 'Flutes',
    unit: 'count',
    what: 'How many cutting edges the cutter has.',
    how: 'Look straight at the tip end and count the cutting edges. Count each edge once.',
  },
  {
    key: 'cutting_length_mm',
    label: 'Cutting length',
    unit: 'mm',
    what: 'How far up from the tip the cutting edges go — the deepest it can cut without the smooth shank rubbing.',
    how: 'Calipers (depth rod or jaws) from the very tip to where the flutes end and the smooth shank starts.',
  },
  {
    key: 'shank_mm',
    label: 'Shank diameter',
    unit: 'mm',
    what: 'The width of the smooth part that goes into the collet.',
    how: 'Calipers across the smooth shank, away from the flutes. It must match a collet you own.',
  },
  {
    key: 'overall_length_mm',
    label: 'Overall length',
    unit: 'mm',
    what: 'The whole cutter, tip to back end.',
    how: 'Calipers or a steel rule from the tip to the back end of the shank.',
  },
  {
    key: 'included_angle_deg',
    label: 'Included angle',
    unit: '°',
    what: 'The full angle of the V, from one cutting edge to the other.',
    how: 'Read it from the cutter, its box or the seller listing (e.g. 60° or 90°). Calipers cannot measure an angle; do not estimate it from a photo.',
  },
];

export function fieldGuide(key: MeasuredField): FieldGuide {
  const g = FIELD_GUIDES.find((f) => f.key === key);
  if (!g) throw new Error(`no guide for field ${key}`);
  return g;
}

/* ── A shop-defined cutter, as typed ───────────────────────────────────────── */

/** What the form holds. Strings, because that is what an input gives, and a
 *  blank is a different fact from a zero. */
export interface ToolDraft {
  type: string;
  diameter_mm: string;
  flutes: string;
  cutting_length_mm: string;
  shank_mm: string;
  overall_length_mm: string;
  included_angle_deg: string;
  flute_type: string;
  material: string;
  /** Optional display name. Blank = built from type + diameter. */
  label: string;
}

export const EMPTY_DRAFT: ToolDraft = {
  type: '',
  diameter_mm: '',
  flutes: '',
  cutting_length_mm: '',
  shank_mm: '',
  overall_length_mm: '',
  included_angle_deg: '',
  flute_type: '',
  material: '',
  label: '',
};

export interface FieldProblem {
  field: keyof ToolDraft;
  why: string;
}

export type DraftVerdict =
  | { ok: true; fields: Record<string, string | number>; label: string }
  | { ok: false; problems: FieldProblem[] };

/** Which measured fields this type asks for. The angle only for angular types. */
export function fieldsFor(type: string): MeasuredField[] {
  const base: MeasuredField[] = ['diameter_mm', 'flutes', 'cutting_length_mm', 'shank_mm', 'overall_length_mm'];
  return isToolType(type) && ANGULAR_TYPES.includes(type) ? [...base, 'included_angle_deg'] : base;
}

function num(s: string): number | null | 'bad' {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : 'bad';
}

/**
 * Validate a shop-defined cutter.
 *
 * 🔴 REQUIRED: type and diameter (and the included angle for an angular type,
 * because the core refuses an angular tool without one). Everything missing is
 * named, every problem at once — a form that reports one error per submit
 * makes the operator play twenty questions.
 *
 * Optional measurements may be blank (stored absent, shown "not measured"), but
 * a value that IS typed must be a real one: positive and finite; flutes a whole
 * number; cutting length not longer than the overall length.
 */
export function validateToolDraft(d: ToolDraft): DraftVerdict {
  const problems: FieldProblem[] = [];
  const fields: Record<string, string | number> = {};

  const type = d.type.trim();
  if (!type) problems.push({ field: 'type', why: 'Type is missing — pick what kind of cutter this is.' });
  else if (!isToolType(type)) problems.push({ field: 'type', why: `"${type}" is not a type this app knows (${TOOL_TYPES.join(', ')}).` });
  else fields.category = type;

  const angular = isToolType(type) && ANGULAR_TYPES.includes(type);

  for (const key of ['diameter_mm', 'flutes', 'cutting_length_mm', 'shank_mm', 'overall_length_mm', 'included_angle_deg'] as const) {
    const g = fieldGuide(key);
    const v = num(d[key]);
    const required = key === 'diameter_mm' || (key === 'included_angle_deg' && angular);
    if (key === 'included_angle_deg' && !angular) {
      if (v !== null) problems.push({ field: key, why: `${g.label} applies only to ${ANGULAR_TYPES.join(', ')} — clear it or change the type.` });
      continue;
    }
    if (v === null) {
      if (required) problems.push({ field: key, why: `${g.label} is missing — ${g.how}` });
      continue;
    }
    if (v === 'bad') {
      problems.push({ field: key, why: `${g.label} "${d[key].trim()}" is not a number.` });
      continue;
    }
    if (v <= 0) {
      problems.push({ field: key, why: `${g.label} must be more than zero.` });
      continue;
    }
    if (key === 'flutes' && !Number.isInteger(v)) {
      problems.push({ field: key, why: 'Flutes is a count of cutting edges — a whole number.' });
      continue;
    }
    if (key === 'included_angle_deg' && v >= 180) {
      problems.push({ field: key, why: 'Included angle must be less than 180°.' });
      continue;
    }
    fields[key] = v;
  }

  const cl = fields.cutting_length_mm;
  const ol = fields.overall_length_mm;
  if (typeof cl === 'number' && typeof ol === 'number' && cl > ol) {
    problems.push({ field: 'cutting_length_mm', why: 'Cutting length is longer than the overall length — one of the two is mis-measured.' });
  }

  const ft = d.flute_type.trim();
  if (ft) {
    if ((FLUTE_DIRECTIONS as readonly string[]).includes(ft)) fields.flute_type = ft;
    else problems.push({ field: 'flute_type', why: `"${ft}" is not a flute direction this app knows (${FLUTE_DIRECTIONS.join(', ')}).` });
  }
  const material = d.material.trim();
  if (material) fields.material = material;

  if (problems.length) return { ok: false, problems };
  const label = d.label.trim() || `${fields.category} ${fields.diameter_mm} mm${typeof fields.flutes === 'number' ? ` ${fields.flutes}F` : ''}`;
  return { ok: true, fields, label };
}

/* ── Writing the registry — through inventory.ts, nowhere else ─────────────── */

/** A shop-local id. Never a catalogue id, so it can never shadow one. */
export function newShopToolId(now: number, doc: InventoryDoc): string {
  const taken = new Set(doc.entries.map((e) => e.id));
  const base = `shop-tool-${now.toString(36)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export type RegisterOutcome = { ok: true; doc: InventoryDoc; id: string } | { ok: false; problems: FieldProblem[] };

/** Register a shop-defined cutter. Refuses (and writes nothing) if invalid. */
export function registerShopTool(doc: InventoryDoc, draft: ToolDraft, now: number): RegisterOutcome {
  const v = validateToolDraft(draft);
  if (!v.ok) return v;
  const id = newShopToolId(now, doc);
  return { ok: true, id, doc: addOperatorEntry(doc, { kind: 'tool', id, label: v.label, fields: v.fields }, now) };
}

/**
 * Mark a catalogue cutter as owned.
 *
 * 🔴 Refuses an id the catalogue does not carry — never matched to the nearest.
 * Written as `App.tsx::claimOwnership` writes it, so the two doors produce the
 * same record and the pickers cannot tell which door was used.
 */
export function registerCatalogueTool(
  doc: InventoryDoc,
  catalogueId: string,
  catalogueIds: readonly string[],
  now: number
): { ok: true; doc: InventoryDoc } | { ok: false; why: string } {
  if (!catalogueIds.includes(catalogueId)) {
    return { ok: false, why: `"${catalogueId}" is not in this build's cutter list. Nothing was registered.` };
  }
  return { ok: true, doc: addOperatorEntry(doc, { kind: 'tool', id: catalogueId }, now) };
}

/** Remove a cutter from the registry. Pure; the photo is removed by
 *  {@link removeToolAndPhoto}. */
export function unregisterTool(doc: InventoryDoc, id: string): InventoryDoc {
  return removeEntry(doc, 'tool', id);
}

/** Anything that can delete a photo by tool id — the slice of `ToolPhotoStore`
 *  removal needs, so this file does not import browser storage. */
export interface PhotoDeleter {
  delete(id: string): Promise<void>;
}

/**
 * Remove a cutter AND its photo. The record goes first: if the photo delete then
 * fails, the outcome says so rather than leaving a photo silently orphaned — and
 * a leftover photo is harmless, whereas a leftover record would be the app still
 * claiming the shop has a cutter it removed.
 */
export async function removeToolAndPhoto(
  doc: InventoryDoc,
  id: string,
  write: (next: InventoryDoc) => Promise<void>,
  photos: PhotoDeleter
): Promise<{ doc: InventoryDoc; photoError: string | null }> {
  const next = unregisterTool(doc, id);
  await write(next);
  try {
    await photos.delete(id);
    return { doc: next, photoError: null };
  } catch (e) {
    return { doc: next, photoError: `The cutter was removed but its photo could not be deleted: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ── The list the page shows ───────────────────────────────────────────────── */

export interface RegisteredTool {
  id: string;
  name: string;
  /** `catalogue` = numbers shipped with this build. `typed` = measured by the shop. */
  origin: 'catalogue' | 'typed';
  /** One line of the numbers, with "not measured" for anything absent. */
  detail: string;
  /** Set when the record names a catalogue id this build does not have. */
  unresolved?: string;
  entry: OwnedEntry;
}

function mm(v: string | number | undefined): string {
  return typeof v === 'number' ? `${v} mm` : 'not measured';
}

/** The registered cutters, in the order they were registered. */
export function registeredTools(doc: InventoryDoc, catalogue: readonly ToolRow[]): RegisteredTool[] {
  return doc.entries
    .filter((e) => e.kind === 'tool')
    .map((e): RegisteredTool => {
      const f = e.fields;
      if (f && Object.keys(f).length > 0) {
        const parts = [
          String(f.category ?? 'type not stated'),
          `Ø ${mm(f.diameter_mm)}`,
          typeof f.flutes === 'number' ? `${f.flutes} flute${f.flutes === 1 ? '' : 's'}` : 'flutes not counted',
          `cutting length ${mm(f.cutting_length_mm)}`,
          `shank ${mm(f.shank_mm)}`,
          `overall ${mm(f.overall_length_mm)}`,
        ];
        if (f.included_angle_deg !== undefined) parts.push(`${f.included_angle_deg}° included`);
        if (f.flute_type) parts.push(String(f.flute_type));
        if (f.material) parts.push(String(f.material));
        return { id: e.id, name: e.label ?? e.id, origin: 'typed', detail: parts.join(' · '), entry: e };
      }
      const c = catalogue.find((t) => t.id === e.id);
      if (!c) {
        return {
          id: e.id,
          name: e.label ?? e.id,
          origin: 'catalogue',
          detail: 'numbers unknown',
          unresolved: `This build has no cutter called "${e.id}" and no numbers were saved with it. It is not matched to a similar one — remove it and register the cutter again.`,
          entry: e,
        };
      }
      return { id: e.id, name: c.id, origin: 'catalogue', detail: catalogueDetail(c), entry: e };
    });
}

/** The catalogue's own numbers for one row, for the list and the picker. */
export function catalogueDetail(c: ToolRow): string {
  return [
    c.category,
    `Ø ${c.diameter_mm} mm`,
    `${c.flutes} flute${c.flutes === 1 ? '' : 's'}`,
    `cutting length ${c.cutting_length_mm} mm`,
    `shank ${c.shank_mm} mm`,
    ...(c.flute_type ? [c.flute_type] : []),
  ].join(' · ');
}
