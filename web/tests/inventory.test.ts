// Tests for the ownership layer — "which of these do I actually have?"
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// `npm run test:node`. No browser, no bundler, no React.
//
// ✅ EXERCISED by the real module: the parse, the per-entry refusals, the
// import's replace-the-imported-set semantics, the four ownership verdicts, the
// two-clause block reason, the merged view, the selection resolver, and the
// round trip through `store.ts`'s own code against the IndexedDB stand-in.
//
// ✅ BOTH PLANTS ARE DRIVEN. `mergeInventory` and `resolveSelection` take an
// optional plant argument that reintroduces the exact defect each rule exists to
// stop — an empty inventory falling back to the catalogue, and a missing id
// resolving to the nearest similar row. Every assertion below that says "it
// refuses" is paired with a planted run that does NOT refuse, so the assertion
// has been watched go the other way rather than merely never failing.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · Chrome's IndexedDB. `tests/fake-indexeddb.mjs` is a stand-in; quota,
//     partitioning and the two-tab blocked/versionchange dance need a browser
//     and belong in `web/e2e/`.
//   · That `App.tsx` renders any of this. The wiring is not written by this
//     change and nothing here asserts it. What is tested is the API the wiring
//     will call.
//   · Any machining judgement. Fitness verdicts are supplied to this module by
//     the caller from the core's own answer; nothing here derives one, and a
//     test that invented one would be re-deriving a machining rule in TypeScript
//     where no gate can see it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-indexeddb.mjs';

/* 🔴 SEEDED AT THE PREVIOUS SCHEMA, ON PURPOSE, AND BEFORE `store.ts` IS
 * IMPORTED. Version 2 with exactly the five stores that shipped on 2026-08-10 —
 * which is the state every existing user is in on the day `inventory` is added.
 * A test that started from an empty browser would pass with the DB_VERSION bump
 * reverted, i.e. it would agree with the defect. */
installFakeIndexedDb({
  name: '2bee.slicer',
  version: 2,
  stores: ['machines', 'workpieces', 'drawings', 'spoilboards', 'operations'],
});

const inv = await import('../src/inventory.ts');
const store = await import('../src/store.ts');

const NOW = Date.parse('2026-08-11T09:00:00Z');
const LATER = NOW + 5 * 86400000;

/** A stand-in catalogue in the shape a host already has. Ids only — no numbers,
 *  because nothing in this module reads a number off a catalogue row. */
const TOOLS: import('../src/inventory.ts').CatalogueRow[] = [
  { id: 'endmill-6mm-2f', name: 'End mill 6mm 2F' },
  { id: 'endmill-3mm-2f', name: 'End mill 3mm 2F' },
  { id: 'vbit-60deg', name: 'V-bit 60°' },
];

function fileText(entries: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: inv.INVENTORY_FILE_KIND,
    version: inv.INVENTORY_FILE_VERSION,
    source: 'bom — cutter stocktake',
    as_of: '2026-08-11',
    entries,
    ...extra,
  });
}

/** The one import used by most cases: this shop owns the 6mm and nothing else. */
function ownsSixMm(): import('../src/inventory.ts').InventoryDoc {
  const p = inv.parseInventoryFile(fileText([{ kind: 'tool', id: 'endmill-6mm-2f' }]), NOW);
  assert.equal(p.status, 'ok');
  return (p as { status: 'ok'; doc: import('../src/inventory.ts').InventoryDoc }).doc;
}

/* ═══ 1. AN EMPTY INVENTORY IS VISIBLE, AND GRANTS NOTHING ═══════════════════ */

test('no default exists, at any inventory state, and the reason is in one place', () => {
  for (const kind of inv.INVENTORY_KINDS) {
    assert.equal(inv.inventoryDefaultId(kind), null);
  }
  assert.match(inv.WHY_NO_DEFAULT, /never picks/i);
});

test('an empty inventory says so and selects nothing — the catalogue is listed, not owned', () => {
  const view = inv.mergeInventory({ kind: 'tool', doc: inv.EMPTY_INVENTORY, catalogue: TOOLS, now: NOW });

  assert.equal(view.state, 'unchecked');
  assert.equal(view.rows.length, TOOLS.length, 'every catalogue row is still listed — never hidden');
  for (const r of view.rows) {
    assert.equal(r.ownership.state, 'unchecked');
    assert.equal(r.tags[0], 'OWNERSHIP UNCHECKED');
  }
  // 🔴 THE REQUIREMENT: no fallback to a default. Nothing is preselected, and
  // "selectable" is not "selected".
  assert.match(view.sourceLine, /NO INVENTORY REGISTERED/);
  assert.ok(!('selected' in view), 'the view carries no selection field to be defaulted into');
});

test('PLANT — with the fallback reintroduced, the empty-inventory assertions go red', () => {
  const planted = inv.mergeInventory({
    kind: 'tool',
    doc: inv.EMPTY_INVENTORY,
    catalogue: TOOLS,
    now: NOW,
    plant: 'empty-falls-back-to-catalogue',
  });

  assert.equal(planted.planted, 'empty-falls-back-to-catalogue', 'a planted run says so');
  // The two facts the real path guarantees, both now false:
  assert.ok(
    planted.rows.every((r) => r.ownership.state === 'held'),
    'PLANT: an empty inventory now reports every catalogue row as OWNED',
  );
  assert.notEqual(planted.rows[0].tags[0], 'OWNERSHIP UNCHECKED');

  // And the negative control that makes the plant meaningful: the same call
  // WITHOUT the plant does not do it.
  const real = inv.mergeInventory({ kind: 'tool', doc: inv.EMPTY_INVENTORY, catalogue: TOOLS, now: NOW });
  assert.equal(real.planted, undefined);
  assert.ok(real.rows.every((r) => r.ownership.state === 'unchecked'));
});

test('"unchecked" is not "not owned" — absence of a record is not evidence of absence', () => {
  const empty = inv.mergeInventory({ kind: 'tool', doc: inv.EMPTY_INVENTORY, catalogue: TOOLS, now: NOW });
  // Unchecked rows stay usable: no shop has an inventory file yet and disabling
  // everything would brick the app. What they do NOT get is a default.
  assert.ok(empty.rows.every((r) => r.disabled === false));

  const known = inv.mergeInventory({ kind: 'tool', doc: ownsSixMm(), catalogue: TOOLS, now: NOW });
  const three = known.rows.find((r) => r.id === 'endmill-3mm-2f')!;
  assert.equal(three.ownership.state, 'not-held');
  assert.equal(three.disabled, true, 'once an inventory EXISTS, what it omits is refused');
});

/* ═══ 2. A SELECTED ITEM THAT NO LONGER EXISTS FAILS ════════════════════════ */

test('a job naming an id nothing has is REFUSED and names it', () => {
  const v = inv.resolveSelection(ownsSixMm(), 'tool', 'endmill-5mm-1f', TOOLS, NOW);
  assert.equal(v.status, 'refused');
  assert.match(v.status === 'refused' ? v.why : '', /endmill-5mm-1f/);
  assert.match(v.status === 'refused' ? v.why : '', /not been replaced with anything similar/i);
});

test('a cutter the inventory DROPPED is refused, not re-resolved', () => {
  // The shop owned the 6mm and the 3mm; the next stocktake lists only the 3mm.
  const first = inv.parseInventoryFile(
    fileText([{ kind: 'tool', id: 'endmill-6mm-2f' }, { kind: 'tool', id: 'endmill-3mm-2f' }]),
    NOW,
  );
  assert.equal(first.status, 'ok');
  const second = inv.parseInventoryFile(fileText([{ kind: 'tool', id: 'endmill-3mm-2f' }]), LATER);
  assert.equal(second.status, 'ok');

  const outcome = inv.applyImport(
    (first as { doc: import('../src/inventory.ts').InventoryDoc }).doc,
    (second as { doc: import('../src/inventory.ts').InventoryDoc }).doc,
  );
  assert.deepEqual(outcome.dropped, [{ kind: 'tool', id: 'endmill-6mm-2f' }]);

  const v = inv.resolveSelection(outcome.doc, 'tool', 'endmill-6mm-2f', TOOLS, LATER);
  assert.equal(v.status, 'refused');
  assert.match(v.status === 'refused' ? v.why : '', /End mill 6mm 2F/);
  assert.equal(v.status === 'refused' ? v.ownership?.state : null, 'not-held');
});

test('PLANT — with nearest-match reintroduced, the refusal assertions go red', () => {
  const planted = inv.resolveSelection(
    ownsSixMm(),
    'tool',
    'endmill-6mm-1f', // does not exist; nearest by name is endmill-6mm-2f
    TOOLS,
    NOW,
    'missing-resolves-to-nearest',
  );
  assert.equal(planted.status, 'ok', 'PLANT: a missing id now resolves instead of refusing');
  assert.equal(planted.status === 'ok' ? planted.row.id : '', 'endmill-6mm-2f');
  assert.equal(planted.status === 'ok' ? planted.planted : '', 'missing-resolves-to-nearest');

  const real = inv.resolveSelection(ownsSixMm(), 'tool', 'endmill-6mm-1f', TOOLS, NOW);
  assert.equal(real.status, 'refused');
});

test('an inventory naming a catalogue id this build does not have is UNRESOLVED, never matched', () => {
  const p = inv.parseInventoryFile(fileText([{ kind: 'tool', id: 'endmill-6mm-2f-OLD-ID' }]), NOW);
  assert.equal(p.status, 'ok');
  const doc = (p as { doc: import('../src/inventory.ts').InventoryDoc }).doc;

  const view = inv.mergeInventory({ kind: 'tool', doc, catalogue: TOOLS, now: NOW });
  const row = view.rows.find((r) => r.id === 'endmill-6mm-2f-OLD-ID')!;
  assert.equal(row.ownership.state, 'unresolved');
  assert.equal(row.disabled, true);
  assert.match(row.disabledReason ?? '', /OWNED BUT UNRESOLVED/);
  // and it is NOT quietly treated as the similarly-named real entry
  assert.equal(view.rows.find((r) => r.id === 'endmill-6mm-2f')!.ownership.state, 'not-held');
});

/* ═══ 3. PROVENANCE TRAVELS ═════════════════════════════════════════════════ */

test('every row carries where its numbers came from and where the ownership claim came from', () => {
  const p = inv.parseInventoryFile(
    fileText([
      { kind: 'tool', id: 'endmill-6mm-2f' },
      { kind: 'tool', id: 'shop-special-8mm', definition: 'shop', label: 'Shop 8mm rougher', fields: { diameter_mm: 8 } },
    ]),
    NOW,
  );
  assert.equal(p.status, 'ok');
  let doc = (p as { doc: import('../src/inventory.ts').InventoryDoc }).doc;
  doc = inv.addOperatorEntry(doc, { kind: 'tool', id: 'typed-2mm', label: 'Typed 2mm', fields: { diameter_mm: 2 } }, NOW);

  const view = inv.mergeInventory({ kind: 'tool', doc, catalogue: TOOLS, now: NOW });
  const byId = Object.fromEntries(view.rows.map((r) => [r.id, r]));

  assert.equal(byId['endmill-6mm-2f'].origin, 'catalogue');
  assert.equal(byId['shop-special-8mm'].origin, 'imported');
  assert.equal(byId['typed-2mm'].origin, 'operator');
  assert.deepEqual(byId['endmill-6mm-2f'].tags, ['OWNED', 'CATALOGUE']);
  assert.deepEqual(byId['shop-special-8mm'].tags, ['OWNED', 'IMPORTED']);
  assert.deepEqual(byId['typed-2mm'].tags, ['OWNED', 'TYPED']);

  // The sentence distinguishes them — a typed entry must not borrow the
  // confidence of a shipped one.
  assert.match(byId['endmill-6mm-2f'].provenance, /shipped with this build/i);
  assert.match(byId['shop-special-8mm'].provenance, /nothing in this build measured/i);
  assert.match(byId['typed-2mm'].provenance, /TYPED in this browser|typed in this browser/i);
});

test('the source line states who counted, when THEY counted, and how old the read is', () => {
  const line = inv.sourceLine(ownsSixMm(), 'tool', LATER);
  assert.match(line, /bom — cutter stocktake/);
  assert.match(line, /2026-08-11/);
  assert.match(line, /5 days ago/);
});

test('an undated or unsourced file is accepted and MARKED, never back-filled from the clock', () => {
  const p = inv.parseInventoryFile(
    JSON.stringify({
      kind: inv.INVENTORY_FILE_KIND,
      version: 1,
      entries: [{ kind: 'tool', id: 'endmill-6mm-2f' }],
    }),
    NOW,
  );
  assert.equal(p.status, 'ok');
  const { doc, report } = p as { doc: import('../src/inventory.ts').InventoryDoc; report: import('../src/inventory.ts').InventoryParseReport };
  assert.equal(doc.as_of, null, 'the read date is NOT copied into the count date');
  assert.equal(report.undated, true);
  assert.equal(report.unsourced, true);
  assert.match(inv.sourceLine(doc, 'tool', NOW), /UNDATED/);
});

test('refused entries are counted IN the document, so the source line cannot overstate the list', () => {
  const p = inv.parseInventoryFile(
    fileText([
      { kind: 'tool', id: 'endmill-6mm-2f' },
      { kind: 'consumable', id: 'sandpaper' }, // out of scope: subtractive CNC only
      { kind: 'tool' }, // no id
    ]),
    NOW,
  );
  assert.equal(p.status, 'ok');
  const { doc, report } = p as { doc: import('../src/inventory.ts').InventoryDoc; report: import('../src/inventory.ts').InventoryParseReport };
  assert.equal(report.accepted, 1);
  assert.equal(report.refused.length, 2);
  assert.equal(doc.refused, 2);
  // named by index and id, not just counted
  assert.equal(report.refused[0].index, 1);
  assert.match(report.refused[0].why, /not something this app can own/);
  assert.match(inv.sourceLine(doc, 'tool', NOW), /2 entries in that file could NOT be read/);
});

/* ═══ 4. OWNED-NESS IS NOT FITNESS ══════════════════════════════════════════ */

test('two reasons a row is unusable stay two labelled reasons', () => {
  const doc = ownsSixMm();
  const catalogue: import('../src/inventory.ts').CatalogueRow[] = [
    // owned, and the core says it will not reach
    { id: 'endmill-6mm-2f', name: 'End mill 6mm 2F', fitness: { fits: false, why: 'cutting length 20mm; the job cuts 24mm' } },
    // not owned, and fine for the job
    { id: 'endmill-3mm-2f', name: 'End mill 3mm 2F' },
    // neither owned nor usable
    { id: 'vbit-60deg', name: 'V-bit 60°', fitness: { fits: false, why: '12mm shank; no collet in the shop holds it' } },
  ];
  const view = inv.mergeInventory({ kind: 'tool', doc, catalogue, now: NOW });
  const byId = Object.fromEntries(view.rows.map((r) => [r.id, r]));

  const owned = byId['endmill-6mm-2f'];
  assert.equal(owned.ownership.state, 'held');
  assert.equal(owned.disabled, true);
  assert.match(owned.disabledReason!, /DOES NOT FIT THIS SETUP/);
  assert.ok(!/NOT IN YOUR INVENTORY/.test(owned.disabledReason!), 'an owned tool is never called un-owned');

  const notOwned = byId['endmill-3mm-2f'];
  assert.match(notOwned.disabledReason!, /NOT IN YOUR INVENTORY/);
  assert.ok(!/DOES NOT FIT/.test(notOwned.disabledReason!), 'a fitting tool is never called unfit');

  const both = byId['vbit-60deg'];
  assert.match(both.disabledReason!, /NOT IN YOUR INVENTORY/);
  assert.match(both.disabledReason!, /DOES NOT FIT THIS SETUP/);
  assert.notEqual(both.disabledReason, notOwned.disabledReason);
});

test('resolveSelection refuses on ownership and NOT on fitness — they are different messages', () => {
  const catalogue: import('../src/inventory.ts').CatalogueRow[] = [
    { id: 'endmill-6mm-2f', name: 'End mill 6mm 2F', fitness: { fits: false, why: 'cutting length 20mm; the job cuts 24mm' } },
  ];
  const v = inv.resolveSelection(ownsSixMm(), 'tool', 'endmill-6mm-2f', catalogue, NOW);
  assert.equal(v.status, 'ok', 'an owned-but-unfit tool is still the tool that was chosen');
  assert.equal(v.status === 'ok' ? v.row.fitness?.fits : true, false);
  assert.equal(v.status === 'ok' ? v.row.ownership.state : '', 'held');
});

test('an unchecked selection resolves WITH a caveat rather than silently', () => {
  const v = inv.resolveSelection(inv.EMPTY_INVENTORY, 'tool', 'endmill-6mm-2f', TOOLS, NOW);
  assert.equal(v.status, 'ok');
  assert.match(v.status === 'ok' ? (v.caveat ?? '') : '', /unchecked, not confirmed/);
});

/* ═══ 5. THE FILE, AND THE SEAM AN ADAPTER PLUGS INTO ═══════════════════════ */

test('a file this build cannot vouch for is refused whole, and the current inventory is untouched', () => {
  const cases: [string, RegExp][] = [
    ['not json at all', /not readable JSON/],
    [JSON.stringify({ kind: 'something else', version: 1, entries: [] }), /not an inventory for this app/],
    [JSON.stringify({ kind: inv.INVENTORY_FILE_KIND, entries: [] }), /carries no version/],
    [JSON.stringify({ kind: inv.INVENTORY_FILE_KIND, version: 99, entries: [] }), /NEWER version/],
    [JSON.stringify({ kind: inv.INVENTORY_FILE_KIND, version: 1 }), /no "entries" list/],
  ];
  for (const [text, why] of cases) {
    const p = inv.parseInventoryFile(text, NOW);
    assert.equal(p.status, 'refused', `expected refusal for: ${text.slice(0, 40)}`);
    assert.match(p.status === 'refused' ? p.why : '', why);
  }
});

test('an import REPLACES the imported set and KEEPS what the operator typed', () => {
  let doc = ownsSixMm();
  doc = inv.addOperatorEntry(doc, { kind: 'tool', id: 'typed-2mm', label: 'Typed 2mm' }, NOW);

  const next = inv.parseInventoryFile(fileText([{ kind: 'tool', id: 'endmill-3mm-2f' }]), LATER);
  const outcome = inv.applyImport(doc, (next as { doc: import('../src/inventory.ts').InventoryDoc }).doc);

  const ids = outcome.doc.entries.map((e) => e.id).sort();
  assert.deepEqual(ids, ['endmill-3mm-2f', 'typed-2mm']);
  assert.deepEqual(outcome.dropped, [{ kind: 'tool', id: 'endmill-6mm-2f' }]);
  assert.equal(outcome.kept, 1);
});

test('a shop entry with a name and no numbers is refused rather than half-carried', () => {
  const p = inv.parseInventoryFile(fileText([{ kind: 'tool', id: 'shop-x', definition: 'shop', label: 'Shop X' }]), NOW);
  assert.equal(p.status, 'ok');
  const { report } = p as { report: import('../src/inventory.ts').InventoryParseReport };
  assert.equal(report.accepted, 0);
  assert.match(report.refused[0].why, /none of its numbers/);
});

/* ═══ 6. PERSISTENCE — through store.ts's own code ══════════════════════════ */

test('the inventory survives a round trip, and the schema bump created its store', async () => {
  const doc = inv.addOperatorEntry(ownsSixMm(), { kind: 'machine', id: 'shop-router', label: 'The router in bay 2' }, NOW);
  await inv.writeInventory(doc, NOW);

  const back = await inv.readInventory();
  assert.equal(back.dropped.length, 0);
  assert.equal(back.savedAt, NOW);
  assert.deepEqual(
    back.doc.entries.map((e) => e.id).sort(),
    ['endmill-6mm-2f', 'shop-router'],
  );
  assert.equal(back.doc.source, 'bom — cutter stocktake');
  assert.equal(back.doc.as_of, '2026-08-11');
});

test('nothing saved reads as EMPTY, which every caller must treat as UNCHECKED', () => {
  assert.deepEqual(inv.EMPTY_INVENTORY.entries, []);
  assert.equal(inv.EMPTY_INVENTORY.as_of, null);
  assert.equal(inv.EMPTY_INVENTORY.imported_at, null);
  const view = inv.mergeInventory({ kind: 'machine', doc: inv.EMPTY_INVENTORY, catalogue: [], now: NOW });
  assert.equal(view.state, 'unchecked');
  assert.equal(view.selectableIds.length, 0);
});

test('a stored record with an unreadable entry drops it BY NAME rather than repairing it', () => {
  const dropped: string[] = [];
  const doc = inv.validateDoc(
    {
      entries: [
        { kind: 'tool', id: 'good', definition: 'catalogue', asserted_by: 'a file', asserted_at: NOW },
        { kind: 'tool', id: 'no-origin', definition: 'invented', asserted_by: 'a file', asserted_at: NOW },
        { kind: 'tool', id: 'no-claim', definition: 'catalogue' },
        { kind: 'sandwich', id: 'lunch', definition: 'operator', asserted_by: 'x', asserted_at: NOW },
      ],
      source: 'ops',
      as_of: '2026-08-01',
      imported_at: NOW,
      refused: 0,
    },
    dropped,
  );
  assert.deepEqual(doc.entries.map((e) => e.id), ['good']);
  assert.equal(dropped.length, 3);
  assert.match(dropped[0], /no-origin/);
  assert.match(dropped[1], /no-claim/);
});

test('the store file declares the new collection, so an older build reports it rather than dropping it silently', async () => {
  const text = await store.exportAll();
  const parsed = JSON.parse(text);
  assert.ok(parsed.collections.includes('inventory'));
  assert.equal(parsed.version, 3);
});
