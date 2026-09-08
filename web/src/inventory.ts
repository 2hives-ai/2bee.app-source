/* inventory.ts — WHICH OF THESE DO I ACTUALLY HAVE?
 *
 * Founder, 2026-08-11: *"in machine, spoilboard, Work Holding, Tooling I should
 * able to select what I have in inventory"*. TODO #83.
 *
 * ── WHY THIS IS A SAFETY MODULE AND NOT A CONVENIENCE ──────────────────────
 *
 * The app lets an operator specify a setup the shop does not own. A CAM program
 * is only safe against the setup it was posted for, and this lane's worst
 * finding this week — a 6 mm cutter driveable through a 40 mm steel clamp at
 * full depth, program emitted and verified clean — came from clamp geometry a
 * human typed into a field. An inventory-backed picker is the same class of fix
 * as the keepout: *it removes a way for the program to be right about the wrong
 * world.*
 *
 * ── THE TWO LAYERS, AND WHY THEY STAY SEPARATE ─────────────────────────────
 *
 * The app ships a CATALOGUE: sourced definitions with provenance
 * (`core/src/spoilboards.rs`, `MACHINE_PRESETS`, the core's tool library,
 * `workholding.ts`). It is generic, this app is AGPL, other shops use it, and it
 * stays exactly where it is.
 *
 * This file is the OWNERSHIP layer on top: which of those entries THIS shop
 * holds, plus shop-specific entries the catalogue does not carry.
 *
 * 🔴 THE APP DOES NOT OWN THE INVENTORY FACT — IT IMPORTS IT. `bom` (cutters,
 * collets) and `ops` (machine, spoilboard, work-holding) were asked whether a
 * record exists. `bom` answered 2026-08-11: **none exists** — no owned cutters
 * (machine ordered, not arrived; ER20 collet; a 2-tool DFM set planned), and
 * their recommendation is a single source-of-truth file
 * (`hardware/bom/cnc-tool-inventory.md`) created when the machine lands, bom
 * owning the record and ops updating it. `ops` answered 2026-08-14: **no floor
 * yet** — no machine, no board, no work-holding physically owned; every number
 * (travels 600×900×180 nominal, ER20, 0–24000 RPM, board size/corner/thickness)
 * will be measured against the delivered unit before it is recorded, and the
 * 1080×1560 vs 1080×1580 board dispute gets a tape measure, not a document. ops
 * accepts the bom-owned file and updates it on every floor change. The feature
 * itself was ruled LIVE by the founder 2026-08-14 (the 08-11 "ignore" referred
 * to something else). So this module reads a file, states where it came from
 * and how old it is, and REFUSES TO GUESS WHEN IT IS ABSENT. `ceo`'s constraint
 * on the work, and it is the right one: *a picker backed by a stale list is
 * worse than a free-text field, because it looks authoritative.*
 *
 * {@link parseInventoryFile} is the seam. When `bom`/`ops` answer with a shape
 * of their own, an adapter converts it into {@link InventoryFile} and nothing
 * else in this module moves.
 *
 * ── THE FOUR VERDICTS THIS FILE KEEPS APART ────────────────────────────────
 *
 * 🔴 `UNCHECKED` IS NOT `NOT OWNED`, AND NEITHER IS `DOES NOT FIT`. Collapsing
 * any pair of these is the defect, not a simplification:
 *
 *   held       — the inventory says this shop has it.
 *   not-held   — an inventory EXISTS for this kind and does NOT list it.
 *   unchecked  — no inventory exists for this kind. Nothing is known either way.
 *   unresolved — the inventory names a catalogue id THIS BUILD DOES NOT HAVE.
 *
 * and separately, orthogonally, from the CORE and never from here:
 *
 *   fitness    — owned and still wrong for the job: too short to reach, a shank
 *                no collet holds, a sheet bigger than the travel.
 *
 * `unchecked` exists because the alternative bricks the app. With no inventory
 * file anywhere in the fleet today, treating absence as "you own nothing" would
 * disable every row in every picker. That is the same error as reading "no
 * clamps declared" as "clamps checked" — gate E5 exists for exactly that — only
 * pointed the other way. So absence is reported as absence, loudly, on every
 * row and in the picker's own source line, and it grants no default.
 *
 * 🔴 THERE IS NO DEFAULT AND THERE IS NO NEAREST MATCH. {@link inventoryDefaultId}
 * exists only to return `null` and say why in one place a test can assert on —
 * the shape `core/src/spoilboards.rs::catalogue_default_id` already uses in this
 * tree. And {@link resolveSelection} refuses a missing id rather than resolving
 * it to something similar: `core/src/fixtures.rs` once resolved an unknown tool
 * id with `.unwrap_or_else(|| end_mill(6.0))` and planned a complete program on
 * a cutter nobody asked for, exit 0, nothing in `notes`. This module carries no
 * `suggestion` field at all — a suggestion is one `??` away from being a
 * fallback, and the fallback is the failure.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 *
 * Subtractive CNC only — the four things the founder named. Not a general asset
 * register: no consumables, no fixtures beyond work-holding, no spares, no
 * quantities-on-hand economics. {@link INVENTORY_KINDS} is the whole scope and
 * a fifth kind is a decision, not an addition.
 */

import { load, save, type SavedItem } from './store';

/* ── What can be owned ─────────────────────────────────────────────────────── */

/** The four surfaces the founder named. The whole scope of this module. */
export type InventoryKind = 'machine' | 'spoilboard' | 'workholding' | 'tool';

export const INVENTORY_KINDS: InventoryKind[] = ['machine', 'spoilboard', 'workholding', 'tool'];

/** For sentences. Singular, lower case, so it reads inside a clause. */
export const KIND_LABEL: Record<InventoryKind, string> = {
  machine: 'machine',
  spoilboard: 'spoilboard',
  workholding: 'hold-down',
  tool: 'cutter',
};

/**
 * Where the DEFINITION — the numbers — came from.
 *
 * This is the same distinction `App.tsx`'s `shipped()` / `yours()` already draw
 * for merged lists, extended rather than duplicated: a shipped preset states
 * travels somebody measured, a machine the user typed states travels nobody
 * checked. `imported` sits between them — somebody outside this app measured it
 * and we can name who and when, which is more than `operator` and less than
 * `catalogue`.
 *
 * ⚠ It is NOT the same question as who asserted OWNERSHIP. A catalogue-defined
 * cutter is still owned because a file or a person said so, which is why
 * {@link OwnedEntry} carries `asserted_by` separately. One field answering both
 * would be a proxy bug: "where did the numbers come from" and "who says we have
 * it" have different answers and different lifetimes.
 */
export type DefinitionOrigin = 'catalogue' | 'imported' | 'operator';

/** The tag that goes at the FRONT of a row's detail line, before the numbers it
 *  qualifies — same placement rule `App.tsx` uses for `SHIPPED` / `YOURS`. */
export const ORIGIN_TAG: Record<DefinitionOrigin, string> = {
  catalogue: 'CATALOGUE',
  imported: 'IMPORTED',
  operator: 'TYPED',
};

/** One thing this shop holds. */
export interface OwnedEntry {
  kind: InventoryKind;
  /** A catalogue id when `definition === 'catalogue'`; otherwise a shop-local id. */
  id: string;
  definition: DefinitionOrigin;
  /** Display name for a shop-specific entry. A catalogue entry names itself. */
  label?: string;
  /**
   * The numbers, for a shop-specific entry. RENDERED VERBATIM AND COMPUTED ON BY
   * NOTHING HERE. A machining rule re-derived in TypeScript is a rule no gate
   * can see, and this app has been bitten by that twice. Whatever consumes these
   * — the core, through the existing custom-entry paths — validates them there.
   */
  fields?: Record<string, string | number>;
  /** Who says the shop has it. A file's own words, or "typed in this browser". */
  asserted_by: string;
  /** Millis. When the assertion entered THIS app. NOT when the count was taken. */
  asserted_at: number;
  /** Anything the file carried that has no field of its own. Shown, never parsed. */
  note?: string;
}

/**
 * The whole ownership record. One document, because a partial one is the thing
 * that has to be impossible: an import that replaced some entries and left
 * others is a shop that believes it declared its tooling and did not.
 */
export interface InventoryDoc {
  entries: OwnedEntry[];
  /**
   * 🔴 THE DATE THE SOURCE SAYS THE COUNT WAS TAKEN — not when we read it.
   * `null` means the file did not say, which is reported as UNDATED rather than
   * filled in from `imported_at`. Those are different facts and the difference
   * is the whole reason this layer exists: a list read today can have been
   * counted a year ago.
   */
  as_of: string | null;
  /** Who produced it. `null` = the file did not say. */
  source: string | null;
  /** Millis, when this app read the file. `null` for an operator-only document. */
  imported_at: number | null;
  /**
   * How many entries in the file this build could NOT read. Carried IN the
   * document so {@link sourceLine} cannot be written without it — a source line
   * claiming "15 items from ops" over a document holding 12 is precisely the
   * authoritative-looking lie this module exists to prevent.
   */
  refused: number;
}

export const EMPTY_INVENTORY: InventoryDoc = {
  entries: [],
  as_of: null,
  source: null,
  imported_at: null,
  refused: 0,
};

/**
 * 🔴 WHY THERE IS NO DEFAULT, IN ONE PLACE A TEST CAN ASSERT ON.
 *
 * Deliberately the same shape as `core/src/spoilboards.rs::catalogue_default_id`,
 * which exists only to return `None` and say why.
 */
export const WHY_NO_DEFAULT =
  'This app never picks a machine, board, hold-down or cutter for you. A default that looks ' +
  'like a selection is a setup nobody chose, presented as one somebody did — and every check ' +
  'downstream would then be right about the wrong world. Pick what you actually have.';

/** Always `null`. See {@link WHY_NO_DEFAULT}. Takes the kind so a future reader
 *  cannot conclude it was only unanswered for one of them. */
export function inventoryDefaultId(_kind: InventoryKind): null {
  return null;
}

/* ── Negative controls ─────────────────────────────────────────────────────── */

/**
 * 🔴 THE DEFECTS THIS MODULE IS SUPPOSED TO PREVENT, REINTRODUCED ON DEMAND.
 *
 * Same idiom and same reason as `MESH_PLANTS` in `cad/mesh.ts` and `--plant` in
 * the CLI: a rule nobody has watched fail is not a rule. Both plants below are
 * the two behaviours the founder asked for, so a test that has only ever seen
 * the green path establishes neither.
 *
 * A plant is an explicit extra argument, is never passed by the UI, and every
 * planted result carries `planted` naming it — a planted answer that could be
 * mistaken for a real one is worse than no plant at all.
 */
export type InventoryPlant =
  /** With no inventory, hand back the catalogue as owned and selectable — the
   *  silent fallback to a default. Must make the empty-inventory tests fail. */
  | 'empty-falls-back-to-catalogue'
  /** Resolve an id nothing holds to the nearest similar row instead of refusing.
   *  This is `fixtures.rs`'s `unwrap_or_else(|| end_mill(6.0))`, in TypeScript. */
  | 'missing-resolves-to-nearest';

export const INVENTORY_PLANTS: InventoryPlant[] = [
  'empty-falls-back-to-catalogue',
  'missing-resolves-to-nearest',
];

/* ── The file, and the seam an adapter plugs into ──────────────────────────── */

export const INVENTORY_FILE_KIND = '2bee.app inventory';
export const INVENTORY_FILE_VERSION = 1;

/** What a file must look like. An adapter for `bom`/`ops`' own shape produces
 *  this and nothing else in the module changes. */
export interface InventoryFile {
  kind: typeof INVENTORY_FILE_KIND;
  version: number;
  /** Who counted. Shown on every picker. */
  source?: string;
  /** When THEY counted, as they wrote it. Shown on every picker. */
  as_of?: string;
  entries: {
    kind: string;
    id: string;
    /** `'catalogue'` = an id this build ships. `'shop'` = the file carries the
     *  numbers. Anything else is refused rather than guessed. */
    definition?: 'catalogue' | 'shop';
    label?: string;
    fields?: Record<string, string | number>;
    note?: string;
  }[];
}

export interface InventoryParseReport {
  accepted: number;
  /** Refused BY INDEX AND ID. Never a count on its own — "3 were dropped" is not
   *  something a shop can act on. */
  refused: { index: number; id: string; why: string }[];
  /** The file did not say when the count was taken. */
  undated: boolean;
  /** The file did not say who counted. */
  unsourced: boolean;
}

export type InventoryParse =
  | { status: 'ok'; doc: InventoryDoc; report: InventoryParseReport }
  /** The whole file is unusable. Nothing is imported and the current document is
   *  untouched — a half-read inventory is worse than none. */
  | { status: 'refused'; why: string };

const MAX_ENTRIES = 5000;

function isKind(v: unknown): v is InventoryKind {
  return typeof v === 'string' && (INVENTORY_KINDS as string[]).includes(v);
}

/**
 * Read an inventory file.
 *
 * ⚠ ENTRY-LEVEL FAILURES ARE NAMED, NOT SILENT, AND NOT FATAL TO THE FILE. An
 * unreadable entry produces a REFUSAL downstream (the shop appears not to own
 * something it owns), which costs a false red; refusing the whole file costs the
 * shop everything the file could have told us. The count of refusals rides in
 * the document so the source line always states it.
 *
 * 🔴 An UNDATED or UNSOURCED file is accepted and marked, not rejected and not
 * back-filled from the clock. Guessing the date is the failure; saying "this
 * file did not say" is the fix.
 */
export function parseInventoryFile(text: string, now: number): InventoryParse {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'refused', why: 'that file is not readable JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'refused', why: 'that file does not contain an inventory object.' };
  }
  if (parsed.kind !== INVENTORY_FILE_KIND) {
    return {
      status: 'refused',
      why:
        `that file is not an inventory for this app — it must carry "kind": "${INVENTORY_FILE_KIND}". ` +
        `Nothing was imported and the inventory already registered is unchanged.`,
    };
  }
  const version = typeof parsed.version === 'number' ? parsed.version : null;
  if (version === null) {
    return { status: 'refused', why: 'that inventory file carries no version, so nothing can be said about what its fields mean.' };
  }
  if (version > INVENTORY_FILE_VERSION) {
    /* Same rule as the session blob: a newer schema can change what a field
     * MEANS, and a field-for-field read of one is a wrong number wearing a right
     * label. An empty picker is obviously empty; that would not be. */
    return {
      status: 'refused',
      why:
        `that inventory file was written by a NEWER version of this app (file ${version}, this ` +
        `build reads ${INVENTORY_FILE_VERSION}). Nothing was imported: a value read out of a ` +
        `schema this build does not understand is worse than an empty list.`,
    };
  }
  const rows = parsed.entries;
  if (!Array.isArray(rows)) {
    return { status: 'refused', why: 'that inventory file has no "entries" list.' };
  }
  if (rows.length > MAX_ENTRIES) {
    return {
      status: 'refused',
      why: `that inventory file claims ${rows.length} entries, which is more than this app will read (${MAX_ENTRIES}). It is corrupt rather than busy.`,
    };
  }

  const source = typeof parsed.source === 'string' && parsed.source.trim() ? parsed.source.trim() : null;
  const as_of = typeof parsed.as_of === 'string' && parsed.as_of.trim() ? parsed.as_of.trim() : null;
  const asserted_by = source
    ? `an inventory file from ${source}`
    : 'an inventory file that did not name who produced it';

  const entries: OwnedEntry[] = [];
  const refused: { index: number; id: string; why: string }[] = [];
  const seen = new Set<string>();

  rows.forEach((raw, index) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const shownId = id || '(no id)';
    if (!id) {
      refused.push({ index, id: shownId, why: 'the entry carries no id, so nothing can be selected by it' });
      return;
    }
    if (!isKind(r.kind)) {
      refused.push({
        index,
        id: shownId,
        why: `"${String(r.kind)}" is not something this app can own — it holds ${INVENTORY_KINDS.join(', ')} and nothing else`,
      });
      return;
    }
    const def = r.definition ?? 'catalogue';
    if (def !== 'catalogue' && def !== 'shop') {
      refused.push({ index, id: shownId, why: `"${String(def)}" is not a definition this build knows (catalogue, shop)` });
      return;
    }
    const key = `${r.kind}/${id}`;
    if (seen.has(key)) {
      refused.push({ index, id: shownId, why: `a ${KIND_LABEL[r.kind]} with this id was already listed; two rows for one id cannot both be the truth` });
      return;
    }
    let fields: Record<string, string | number> | undefined;
    if (r.fields !== undefined) {
      if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields)) {
        refused.push({ index, id: shownId, why: 'its "fields" is not an object of values' });
        return;
      }
      fields = {};
      for (const [k, v] of Object.entries(r.fields as Record<string, unknown>)) {
        if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) fields[k] = v;
        else {
          refused.push({ index, id: shownId, why: `its field "${k}" is not a finite number or a string` });
          return;
        }
      }
    }
    if (def === 'shop' && !fields) {
      refused.push({
        index,
        id: shownId,
        why: 'it is a shop-specific entry with no fields, so this app would carry its name and none of its numbers',
      });
      return;
    }
    seen.add(key);
    entries.push({
      kind: r.kind,
      id,
      definition: def === 'shop' ? 'imported' : 'catalogue',
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : undefined,
      fields,
      asserted_by,
      asserted_at: now,
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
    });
  });

  return {
    status: 'ok',
    doc: { entries, as_of, source, imported_at: now, refused: refused.length },
    report: { accepted: entries.length, refused, undated: as_of === null, unsourced: source === null },
  };
}

export interface ImportOutcome {
  doc: InventoryDoc;
  /**
   * 🔴 IMPORTED ENTRIES THE NEW FILE NO LONGER LISTS, by kind and id. This is
   * the half that makes rule 2 true over time: an import REPLACES the imported
   * set rather than merging into it, because an entry kept alive after the shop
   * stopped listing it is the app asserting ownership of a cutter that is gone.
   * Every one of these is a saved job that must now refuse.
   */
  dropped: { kind: InventoryKind; id: string }[];
  /** Operator-typed entries, which an import never touches. */
  kept: number;
}

/**
 * Replace the imported set, keep what the operator typed here.
 *
 * ⚠ The asymmetry is deliberate. The file is authoritative about what it lists —
 * so what it stopped listing is gone. The operator's own entries were never in
 * the file and dropping them would be this app deleting a shop's record of its
 * own kit because somebody else's list did not mention it.
 */
export function applyImport(current: InventoryDoc, incoming: InventoryDoc): ImportOutcome {
  const mine = current.entries.filter((e) => e.definition === 'operator');
  const wasImported = current.entries.filter((e) => e.definition !== 'operator');
  const now = new Set(incoming.entries.map((e) => `${e.kind}/${e.id}`));
  const dropped = wasImported
    .filter((e) => !now.has(`${e.kind}/${e.id}`))
    .map((e) => ({ kind: e.kind, id: e.id }));
  return {
    doc: { ...incoming, entries: [...incoming.entries, ...mine] },
    dropped,
    kept: mine.length,
  };
}

/** Add or replace one entry the operator typed here. */
export function addOperatorEntry(
  doc: InventoryDoc,
  entry: Omit<OwnedEntry, 'definition' | 'asserted_by' | 'asserted_at'> & { definition?: 'catalogue' | 'operator' },
  now: number
): InventoryDoc {
  const definition: DefinitionOrigin = entry.definition === 'catalogue' ? 'catalogue' : 'operator';
  const next: OwnedEntry = {
    kind: entry.kind,
    id: entry.id,
    definition,
    label: entry.label,
    fields: entry.fields,
    note: entry.note,
    asserted_by: 'typed in this browser — nobody outside it checked',
    asserted_at: now,
  };
  return {
    ...doc,
    entries: [...doc.entries.filter((e) => !(e.kind === next.kind && e.id === next.id)), next],
  };
}

/** Remove one entry. Used when a shop corrects its own list; an import does not
 *  route through here (see {@link applyImport}). */
export function removeEntry(doc: InventoryDoc, kind: InventoryKind, id: string): InventoryDoc {
  return { ...doc, entries: doc.entries.filter((e) => !(e.kind === kind && e.id === id)) };
}

/* ── Where it came from, and how old it is ─────────────────────────────────── */

const DAY_MS = 86400000;

function ageWords(from: number, now: number): string {
  const days = Math.floor((now - from) / DAY_MS);
  if (days < 0) return 'at a time later than this browser\'s clock, which is itself a fault worth checking';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * The sentence the picker prints above its list. Never a green, never a badge —
 * it states the source and the age and lets the operator judge.
 *
 * 🔴 It is SCOPED TO A KIND, because "we have an inventory" and "we have an
 * inventory of cutters" are different claims and only the second is the one a
 * tool picker can act on. A file from `ops` listing machines says nothing about
 * whether `bom` ever listed a cutter.
 */
export function sourceLine(doc: InventoryDoc, kind: InventoryKind, now: number): string {
  const held = doc.entries.filter((e) => e.kind === kind).length;
  const label = KIND_LABEL[kind];
  if (doc.imported_at === null && doc.entries.length === 0) {
    return (
      `NO INVENTORY REGISTERED. Nothing has told this app which ${label}s your shop has, so ` +
      `every row below is UNCHECKED — listed because it exists, not because you have it. ` +
      `Import an inventory file, or mark what you own.`
    );
  }
  if (held === 0) {
    return (
      `NO ${label.toUpperCase()}S IN THE REGISTERED INVENTORY. ` +
      describeProvenance(doc, now) +
      ` It lists ${doc.entries.length} item${doc.entries.length === 1 ? '' : 's'} and none of them is a ${label}, ` +
      `so every ${label} below is UNCHECKED rather than owned or not owned.`
    );
  }
  return (
    `${held} ${label}${held === 1 ? '' : 's'} in your inventory. ` +
    describeProvenance(doc, now) +
    (doc.refused > 0
      ? ` ⚠ ${doc.refused} entr${doc.refused === 1 ? 'y' : 'ies'} in that file could NOT be read and ` +
        `${doc.refused === 1 ? 'is' : 'are'} missing from this list — something you own may show as not owned.`
      : '')
  );
}

/** The provenance clause, shared by the source line and by every row. */
export function describeProvenance(doc: InventoryDoc, now: number): string {
  const who = doc.source ? `Counted by ${doc.source}` : 'Counted by a source the file did not name';
  const when = doc.as_of
    ? `, as of ${doc.as_of} BY ITS OWN STATEMENT`
    : ', on a date the file did NOT state — treat it as UNDATED';
  const read =
    doc.imported_at !== null
      ? `; read into this browser ${ageWords(doc.imported_at, now)}.`
      : '; typed here rather than imported.';
  return `${who}${when}${read}`;
}

/* ── Ownership ─────────────────────────────────────────────────────────────── */

export type OwnershipVerdict =
  /** The inventory says this shop has it. */
  | { state: 'held'; entry: OwnedEntry; why: string }
  /** An inventory EXISTS for this kind and does not list it. */
  | { state: 'not-held'; why: string }
  /** No inventory exists for this kind. Nothing is known either way. */
  | { state: 'unchecked'; why: string }
  /** Owned per the inventory, but it names a definition this build does not
   *  have. Refused rather than matched to something similar. */
  | { state: 'unresolved'; entry: OwnedEntry; why: string };

/** Short word for the row's detail line. Read before the numbers it qualifies. */
export function ownershipTag(v: OwnershipVerdict): string {
  switch (v.state) {
    case 'held':
      return 'OWNED';
    case 'not-held':
      return 'NOT OWNED';
    case 'unchecked':
      return 'OWNERSHIP UNCHECKED';
    case 'unresolved':
      return 'OWNED BUT UNRESOLVED';
  }
}

/**
 * Does this shop have it?
 *
 * @param catalogueIds every id the shipped catalogue for this kind carries. An
 *        entry naming an id outside it is `unresolved` — never matched by name,
 *        never matched to the nearest.
 */
export function ownershipOf(
  doc: InventoryDoc,
  kind: InventoryKind,
  id: string,
  catalogueIds: readonly string[]
): OwnershipVerdict {
  const forKind = doc.entries.filter((e) => e.kind === kind);
  const label = KIND_LABEL[kind];
  if (forKind.length === 0) {
    return {
      state: 'unchecked',
      why:
        `NOTHING HAS TOLD THIS APP WHICH ${label.toUpperCase()}S YOU HAVE. This row is listed ` +
        `because it exists in the catalogue, not because it is in your shop — and this app is ` +
        `not going to decide that for you.`,
    };
  }
  const hit = forKind.find((e) => e.id === id);
  if (!hit) {
    return {
      state: 'not-held',
      why:
        `your registered inventory of ${label}s does NOT list this one. Selecting it would plan a ` +
        `program for kit the shop is not recorded as having.`,
    };
  }
  if (hit.definition === 'catalogue' && !catalogueIds.includes(id)) {
    return {
      state: 'unresolved',
      entry: hit,
      why:
        `your inventory lists "${id}" as a catalogue ${label}, and THIS BUILD HAS NO SUCH ENTRY. ` +
        `It is refused rather than matched to a similar one: a silently substituted ${label} is ` +
        `the wrong object planned with confidence.`,
    };
  }
  return { state: 'held', entry: hit, why: `${hit.asserted_by}, recorded ${new Date(hit.asserted_at).toISOString().slice(0, 10)}.` };
}

/* ── Fitness — the CORE's verdict, carried, never computed ─────────────────── */

/**
 * Whether an owned thing is right for THIS job. Supplied by the caller from the
 * core's own answer (`tool.selectable`/`fit_why`, `sheetFits`, the spoilboard's
 * coverage verdict). Nothing in this file derives one.
 */
export interface Fitness {
  fits: boolean;
  /** The core's words. Required when `fits` is false — an unusable row with no
   *  reason is just a mystery (`ObjectPicker` rule 1). */
  why?: string;
}

/**
 * The two reasons a row can be unusable, KEPT APART.
 *
 * 🔴 Requirement 4, and the reason it is a function rather than a `||`: "you do
 * not own this" and "this will not reach" are different facts with different
 * fixes — one sends someone to the purchase order, the other to a longer cutter.
 * A row that says only "unusable" sends them nowhere, and a row that reports the
 * first reason it finds hides the second. Both clauses are LABELLED and both are
 * present when both apply.
 */
export function blockFor(
  ownership: OwnershipVerdict,
  fitness?: Fitness
): { disabled: boolean; disabledReason?: string } {
  const clauses: string[] = [];
  if (ownership.state === 'not-held') clauses.push(`NOT IN YOUR INVENTORY — ${ownership.why}`);
  if (ownership.state === 'unresolved') clauses.push(`OWNED BUT UNRESOLVED — ${ownership.why}`);
  if (fitness && !fitness.fits) {
    clauses.push(`DOES NOT FIT THIS SETUP — ${fitness.why ?? 'the core refused it and gave no reason, which is itself unchecked'}`);
  }
  /* `unchecked` does NOT disable. Absence of a record is not evidence of
   * absence, and disabling every row because no file exists would brick an app
   * no shop has an inventory for yet. It is marked on the row instead, and it
   * grants no default — see WHY_NO_DEFAULT. */
  if (clauses.length === 0) return { disabled: false };
  return { disabled: true, disabledReason: clauses.join(' · ') };
}

/* ── The merged view a picker renders ──────────────────────────────────────── */

/** One shipped-catalogue entry, as the host already has it. */
export interface CatalogueRow {
  id: string;
  name: string;
  detail?: string;
  /** The core's fitness answer for this row, if the host has one. */
  fitness?: Fitness;
}

export interface InventoryRow {
  id: string;
  name: string;
  kind: InventoryKind;
  /** `null` for a shop-specific entry the catalogue does not carry. */
  catalogue: CatalogueRow | null;
  entry: OwnedEntry | null;
  ownership: OwnershipVerdict;
  fitness?: Fitness;
  /** `null` when the row is owned but its definition could not be resolved. */
  origin: DefinitionOrigin | null;
  /** Front-of-detail tags, ownership first: e.g. `OWNED · CATALOGUE`. */
  tags: string[];
  /** The "Where this came from" sentence for the properties panel. */
  provenance: string;
  disabled: boolean;
  disabledReason?: string;
}

export type InventoryState =
  /** No inventory for this kind. Rows are listed and marked UNCHECKED. */
  | 'unchecked'
  /** An inventory exists for this kind. */
  | 'listed';

export interface InventoryView {
  kind: InventoryKind;
  state: InventoryState;
  rows: InventoryRow[];
  /** The ids a picker may let the user choose. Never seeded with a default. */
  selectableIds: string[];
  /** What the picker prints above the list. */
  sourceLine: string;
  /** What `ObjectPicker`'s `emptyMessage` says when there is nothing at all. */
  emptyMessage: string;
  /** Set only on a planted run. See {@link InventoryPlant}. */
  planted?: string;
}

export interface MergeOptions {
  kind: InventoryKind;
  doc: InventoryDoc;
  /** The shipped catalogue for this kind, in the host's own order. */
  catalogue: readonly CatalogueRow[];
  now: number;
  /** Negative control. Never passed by the UI. */
  plant?: InventoryPlant;
}

/** Rank for the row order: what you have, first. */
function rank(v: OwnershipVerdict): number {
  switch (v.state) {
    case 'held':
      return 0;
    case 'unchecked':
      return 1;
    case 'unresolved':
      return 2;
    case 'not-held':
      return 3;
  }
}

function provenanceOf(row: { entry: OwnedEntry | null; origin: DefinitionOrigin | null }, doc: InventoryDoc, now: number): string {
  if (!row.entry) {
    return (
      'Shipped with this build. Nothing says your shop has it — this app knows what EXISTS, not ' +
      'what you own, unless an inventory tells it.'
    );
  }
  const where =
    row.origin === 'catalogue'
      ? 'The numbers are the ones shipped with this build; the claim that you HAVE it is separate and is below.'
      : row.origin === 'imported'
        ? 'The numbers came IN the inventory file — nothing in this build measured or sourced them.'
        : 'The numbers were TYPED in this browser. Nobody measured them, nobody checked them, and clearing site data deletes them.';
  return `${where} Ownership: ${row.entry.asserted_by}, recorded ${ageWords(row.entry.asserted_at, now)}. ${describeProvenance(doc, now)}`;
}

/**
 * Build the rows a picker shows: the catalogue, marked with what this shop has,
 * plus the shop-specific entries the catalogue does not carry.
 *
 * 🔴 IT NEVER HIDES AN UN-OWNED ROW. `ObjectPicker` rule 1 — on screen a hidden
 * item and a non-existent item are identical, and in a machining tool that
 * difference decides whether somebody goes and buys the cutter or concludes it
 * does not exist. Un-owned rows are listed, disabled, and say why.
 *
 * 🔴 AND IT NEVER SELECTS ANYTHING. `selectableIds` is what MAY be chosen, not
 * what IS. There is no default at any inventory state.
 */
export function mergeInventory(opts: MergeOptions): InventoryView {
  const { kind, doc, catalogue, now, plant } = opts;
  const catalogueIds = catalogue.map((c) => c.id);
  const forKind = doc.entries.filter((e) => e.kind === kind);
  const state: InventoryState = forKind.length === 0 ? 'unchecked' : 'listed';

  /* 🔴 THE PLANT: an empty inventory silently becoming "you own the catalogue".
   * This is the founder's first requirement, inverted, and it is here so a test
   * can watch the real path refuse to do it. */
  const planted = plant === 'empty-falls-back-to-catalogue' && state === 'unchecked' ? plant : undefined;

  const rows: InventoryRow[] = catalogue.map((c) => {
    let ownership = ownershipOf(doc, kind, c.id, catalogueIds);
    if (planted) {
      ownership = {
        state: 'held',
        entry: {
          kind,
          id: c.id,
          definition: 'catalogue',
          asserted_by: 'PLANTED DEFECT — the empty inventory fell back to the catalogue',
          asserted_at: now,
        },
        why: 'PLANTED',
      };
    }
    const entry = ownership.state === 'held' || ownership.state === 'unresolved' ? ownership.entry : null;
    const origin = ownership.state === 'unresolved' ? null : (entry?.definition ?? 'catalogue');
    const block = blockFor(ownership, c.fitness);
    return {
      id: c.id,
      name: c.name,
      kind,
      catalogue: c,
      entry,
      ownership,
      fitness: c.fitness,
      origin,
      tags: [ownershipTag(ownership), ...(origin ? [ORIGIN_TAG[origin]] : [])],
      provenance: provenanceOf({ entry, origin }, doc, now),
      ...block,
    };
  });

  /* Shop-specific entries: owned, real, and NOT in the catalogue. They are rows
   * in their own right rather than an afterthought — the whole reason the
   * ownership layer exists on top of the catalogue instead of replacing it. */
  const inCatalogue = new Set(catalogueIds);
  for (const e of forKind) {
    if (inCatalogue.has(e.id)) continue;
    const ownership = ownershipOf(doc, kind, e.id, catalogueIds);
    const block = blockFor(ownership, undefined);
    rows.push({
      id: e.id,
      name: e.label ?? e.id,
      kind,
      catalogue: null,
      entry: e,
      ownership,
      origin: ownership.state === 'unresolved' ? null : e.definition,
      tags: [ownershipTag(ownership), ...(ownership.state === 'unresolved' ? [] : [ORIGIN_TAG[e.definition]])],
      provenance: provenanceOf({ entry: e, origin: e.definition }, doc, now),
      ...block,
    });
  }

  rows.sort((a, b) => rank(a.ownership) - rank(b.ownership));

  const view: InventoryView = {
    kind,
    state,
    rows,
    selectableIds: rows.filter((r) => !r.disabled).map((r) => r.id),
    sourceLine: sourceLine(doc, kind, now),
    emptyMessage:
      `Nothing to show. This build ships no ${KIND_LABEL[kind]} catalogue entries and your inventory ` +
      `lists none either — so there is nothing to pick, and nothing has been picked for you.`,
  };
  if (planted) view.planted = planted;
  return view;
}

/* ── Resolving a saved selection ───────────────────────────────────────────── */

export type SelectionVerdict =
  | {
      status: 'ok';
      row: InventoryRow;
      /** Present when the row is usable but something about it is UNCHECKED. */
      caveat?: string;
      planted?: string;
    }
  | {
      status: 'refused';
      id: string;
      /** The one sentence the operator gets. NAMES WHAT IS MISSING. */
      why: string;
      ownership: OwnershipVerdict | null;
    };

/**
 * Resolve an id a saved job, a restored session or an import is asking for.
 *
 * 🔴 REQUIREMENT 2. If the inventory dropped a cutter a saved job references,
 * this REFUSES and names it. It does not fall back to the nearest diameter, the
 * same category, or the first row — and it carries no field in which such a
 * suggestion could be returned, because a suggestion is one `??` away from being
 * a substitution and the substitution is the failure `core/src/fixtures.rs`
 * shipped a 9,390-byte program on.
 *
 * ⚠ It refuses on OWNERSHIP and on EXISTENCE and reports which. It does NOT
 * refuse on fitness — a row that is owned and too short is still the row that
 * was chosen, and telling the operator "that cutter cannot reach" is a different
 * message from "that cutter is gone". The fitness verdict rides back on the row.
 */
export function resolveSelection(
  doc: InventoryDoc,
  kind: InventoryKind,
  id: string,
  catalogue: readonly CatalogueRow[],
  now: number,
  plant?: InventoryPlant
): SelectionVerdict {
  const view = mergeInventory({ kind, doc, catalogue, now });
  const row = view.rows.find((r) => r.id === id);

  if (!row) {
    if (plant === 'missing-resolves-to-nearest') {
      /* 🔴 THE PLANT: `fixtures.rs`'s `unwrap_or_else(|| end_mill(6.0))`, in
       * TypeScript. Nearest by name, silently, exactly as the defect did it. */
      const nearest = nearestByName(view.rows, id);
      if (nearest) {
        return {
          status: 'ok',
          row: nearest,
          planted: 'missing-resolves-to-nearest',
          caveat: 'PLANTED DEFECT — a missing id was resolved to a similar row instead of refusing.',
        };
      }
    }
    return {
      status: 'refused',
      id,
      ownership: null,
      why:
        `this job asks for the ${KIND_LABEL[kind]} "${id}", and NOTHING in this build's catalogue or ` +
        `in your inventory has that id. It has not been replaced with anything similar — a program ` +
        `planned for a substituted ${KIND_LABEL[kind]} is right about the wrong world. Pick one that exists.`,
    };
  }

  if (row.ownership.state === 'not-held' || row.ownership.state === 'unresolved') {
    return {
      status: 'refused',
      id,
      ownership: row.ownership,
      why:
        `this job asks for the ${KIND_LABEL[kind]} "${row.name}" and ${row.ownership.why} ` +
        `Nothing similar has been selected in its place.`,
    };
  }

  if (row.ownership.state === 'unchecked') {
    return {
      status: 'ok',
      row,
      caveat:
        `"${row.name}" exists in this build's catalogue, and NOTHING has told this app whether your ` +
        `shop has it. That is unchecked, not confirmed.`,
    };
  }

  return { status: 'ok', row };
}

/** ONLY reachable from the plant above. Kept private and named for what it is:
 *  this function is the defect, not a helper. */
function nearestByName(rows: InventoryRow[], id: string): InventoryRow | undefined {
  let best: InventoryRow | undefined;
  let bestScore = -1;
  for (const r of rows) {
    let n = 0;
    while (n < id.length && n < r.id.length && id[n] === r.id[n]) n++;
    if (n > bestScore) {
      bestScore = n;
      best = r;
    }
  }
  return best;
}

/* ── Persistence ───────────────────────────────────────────────────────────── */

/**
 * One record, one name. The inventory is a single document (see
 * {@link InventoryDoc}) so an import is one atomic put and a half-written
 * inventory is not a state this app can be in.
 */
export const INVENTORY_RECORD_NAME = 'current';

/**
 * Validate a document coming back out of storage.
 *
 * 🔴 The same rule as the session blob: nothing is restored that cannot be
 * validated, and an entry that fails is DROPPED BY NAME rather than repaired.
 * An inventory is a claim about a physical shop; a repaired one is a claim
 * nobody made.
 */
export function validateDoc(raw: unknown, dropped?: string[]): InventoryDoc {
  const r = (raw ?? {}) as Record<string, unknown>;
  const entries: OwnedEntry[] = [];
  if (Array.isArray(r.entries)) {
    for (const item of r.entries as Record<string, unknown>[]) {
      const e = item ?? {};
      if (!isKind(e.kind) || typeof e.id !== 'string' || !e.id) {
        dropped?.push(`an entry with no usable kind/id (${JSON.stringify(e).slice(0, 60)})`);
        continue;
      }
      const def = e.definition;
      if (def !== 'catalogue' && def !== 'imported' && def !== 'operator') {
        dropped?.push(`"${e.id}" — its origin "${String(def)}" is not one this build knows`);
        continue;
      }
      if (typeof e.asserted_by !== 'string' || typeof e.asserted_at !== 'number' || !Number.isFinite(e.asserted_at)) {
        dropped?.push(`"${e.id}" — it does not say who asserted it or when, which is the fact it exists to carry`);
        continue;
      }
      let fields: Record<string, string | number> | undefined;
      if (e.fields && typeof e.fields === 'object' && !Array.isArray(e.fields)) {
        fields = {};
        for (const [k, v] of Object.entries(e.fields as Record<string, unknown>)) {
          if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) fields[k] = v;
        }
      }
      entries.push({
        kind: e.kind,
        id: e.id,
        definition: def,
        label: typeof e.label === 'string' ? e.label : undefined,
        fields,
        asserted_by: e.asserted_by,
        asserted_at: e.asserted_at,
        note: typeof e.note === 'string' ? e.note : undefined,
      });
    }
  }
  return {
    entries,
    as_of: typeof r.as_of === 'string' ? r.as_of : null,
    source: typeof r.source === 'string' ? r.source : null,
    imported_at: typeof r.imported_at === 'number' && Number.isFinite(r.imported_at) ? r.imported_at : null,
    refused: typeof r.refused === 'number' && Number.isFinite(r.refused) && r.refused >= 0 ? r.refused : 0,
  };
}

export interface InventoryLoad {
  doc: InventoryDoc;
  /** Entries the stored record carried that could not be read. Never silent. */
  dropped: string[];
  /** `null` when nothing has ever been saved — a first visit, not a fault. */
  savedAt: number | null;
}

/** Read the registered inventory. An absent record returns
 *  {@link EMPTY_INVENTORY}, which every caller must treat as UNCHECKED. */
export async function readInventory(): Promise<InventoryLoad> {
  const rec = (await load<unknown>('inventory', INVENTORY_RECORD_NAME)) as SavedItem<unknown> | null;
  if (!rec) return { doc: EMPTY_INVENTORY, dropped: [], savedAt: null };
  const dropped: string[] = [];
  return { doc: validateDoc(rec.data, dropped), dropped, savedAt: rec.saved_at };
}

/** Write it. One put, one record. */
export async function writeInventory(doc: InventoryDoc, now: number): Promise<void> {
  await save<InventoryDoc>('inventory', INVENTORY_RECORD_NAME, doc, now);
}
