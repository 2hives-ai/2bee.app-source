// Tests for saving a 2bee.cad model into the drawings list.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// `node --experimental-strip-types --import ./tests/register.mjs --test tests/`
// (`npm run test:node`). No browser, no bundler, no WebGL.
//
// ✅ EXERCISED, and by the real modules rather than by stand-ins: `scad.ts`
// parses a real source, `mesh.ts` evaluates and AUDITS a real solid, `record.ts`
// builds/refuses/verifies/describes the record, and `store.ts` runs its own
// save/list/load/remove/import/export code. The geometry in every case below is
// really tessellated and really audited — no MeshResult is hand-written, because
// a hand-written one would let a wrong expectation agree with a wrong
// implementation.
//
// ✅ THE AUDIT-FAILURE PATH IS DRIVEN BY THE KERNEL'S OWN NEGATIVE CONTROL.
// `meshScene(scene, plant)` exists to make the audit fail on demand, and all
// three plants are used, so "closed" in the passing cases is a verdict that has
// been watched go red rather than one that cannot go red.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · Chrome's IndexedDB. `tests/fake-indexeddb.mjs` is a stand-in; it clones
//     with `structuredClone` (the real algorithm, which is what makes the
//     round-trip assertion mean anything) and reproduces nothing else. Quota,
//     partitioning, transaction lifetimes and the two-tab `blocked`/
//     `versionchange` dance need a real browser and belong in `web/e2e/`.
//   · Every pixel of `CadTab.tsx`. There is no React renderer here. The control
//     that names a replacement before it happens, the stale-preview refusal and
//     the disabled button are UNTESTED in this file — the RULES they enforce are
//     tested, at the functions they call.
//   · That `App.tsx` shows any of it. The wiring on that side was not written by
//     this change and nothing here asserts it.
//
// Each of these gaps is a real one, and naming them is the point: a suite that
// implies coverage it does not have is the failure this lane exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-indexeddb.mjs';

/* 🔴 SEEDED AT THE OLD SCHEMA, ON PURPOSE, AND BEFORE `store.ts` IS IMPORTED.
 *
 * The database is created here as VERSION 1 holding exactly the three object
 * stores that shipped before 2026-08-10. Everything below therefore runs against
 * a database that had to be UPGRADED — which is the state every existing user is
 * in, and the one that breaks if a collection is added and `open()` does not
 * create it. A test that started from an empty browser would pass with that
 * removed, which is a test that agrees with the defect.
 *
 * ⚠ THIS SENTENCE USED TO SAY *"the one that breaks if `DB_VERSION` is not
 * bumped"*. Corrected 2026-08-11: since `a4e5ff68be` the upgrade is driven by a
 * MISSING STORE and not by the version number, and this file carried the old
 * mechanism in two places — here and at the test below. **One of them was
 * ticketed and the other was not**, which is the whole reason it is worth
 * writing down: a correction aimed at the line somebody noticed leaves the
 * sibling that says the same thing. The measurement, and what this file does and
 * does not guard, is in the comment on that test. */
installFakeIndexedDb({
  name: '2bee.slicer',
  version: 1,
  stores: ['machines', 'workpieces', 'drawings'],
});

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene, MESH_PLANTS } = await import('../src/cad/mesh.ts');
const {
  buildCadRecord,
  verifyCadRecord,
  isCadRecord,
  describeCadRecord,
  checksumBytes,
  CAD_RECORD_KIND,
} = await import('../src/cad/record.ts');
const store = await import('../src/store.ts');

const CUBE = 'cube([20, 10, 5]);';
const POCKET = `
difference() {
    cube([40, 30, 12]);
    translate([8, 8, 4]) cube([24, 14, 20]);
}
`;

/** Build from a real parse + a real mesh of the same source. */
function build(name: string, src: string, plant?: (typeof MESH_PLANTS)[number]) {
  const parse = parseScad(src);
  const mesh = meshScene(parse.scene, plant);
  return { parse, mesh, built: buildCadRecord({ name, source: src, parse, mesh, now: 1_700_000_000_000 }) };
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

test('a model saves into the drawings collection, lists, and reads back byte-identical', async () => {
  const { built } = build('Test pocket plate', POCKET);
  assert.equal(built.ok, true, built.ok ? '' : built.refusal.detail);
  if (!built.ok) return;

  await store.saveCadModel(built.record, 1_700_000_000_000);

  // LISTED — in the drawings collection, not a collection of its own.
  const listed = await store.list('drawings');
  const row = listed.find((i) => i.name === 'Test pocket plate');
  assert.ok(row, 'the saved model is in the drawings list');

  // READ BACK — through the CAD-aware reader, which cannot hand it over without
  // its verification.
  const back = await store.loadCadModel('Test pocket plate');
  assert.ok(back);
  assert.equal(back.verification.status, 'ok');

  const a = built.record;
  const b = back.item.data;
  assert.equal(b.name, a.name);
  assert.equal(b.format, 'stl');
  assert.equal(b.cad.kind, CAD_RECORD_KIND);
  // THE SOURCE survived — this is the half that keeps the model editable.
  assert.equal(b.cad.source, POCKET);
  // THE MESH survived, byte for byte. `structuredClone` in the fake is what
  // makes this a real question rather than a reference comparison.
  assert.equal(b.bytes.length, a.bytes.length);
  assert.deepEqual([...b.bytes], [...a.bytes]);
  assert.equal(checksumBytes(b.bytes), a.cad.stl_checksum);
  assert.equal(b.cad.verdict, 'closed');
  assert.ok(b.cad.triangles > 0);
  assert.equal(b.cad.solids, 1);

  await store.remove('drawings', 'Test pocket plate');
});

test('the STL is a well-formed binary STL and does not start with "solid"', async () => {
  const { built } = build('Cube', CUBE);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bytes = built.record.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  // The arithmetic every reader in this app checks a mesh against.
  assert.equal(bytes.length, 84 + declared * 50);
  assert.equal(declared, built.record.cad.triangles);
  const header = new TextDecoder().decode(bytes.slice(0, 5));
  assert.notEqual(header, 'solid');
});

test('saving over a name REPLACES it — the store does not silently keep both', async () => {
  const first = build('Same name', CUBE);
  const second = build('Same name', POCKET);
  assert.equal(first.built.ok, true);
  assert.equal(second.built.ok, true);
  if (!first.built.ok || !second.built.ok) return;

  await store.saveCadModel(first.built.record, 1);
  await store.saveCadModel(second.built.record, 2);

  const rows = (await store.list('drawings')).filter((i) => i.name === 'Same name');
  assert.equal(rows.length, 1, 'one row, not two');
  const back = await store.loadCadModel('Same name');
  assert.equal(back?.item.data.cad.source, POCKET, 'the second save won');

  await store.remove('drawings', 'Same name');
});

// ---------------------------------------------------------------------------
// The refusal that matters
// ---------------------------------------------------------------------------

test('a model whose mesh audit did not pass is REFUSED, for every planted defect', () => {
  // 🔴 THE NEGATIVE CONTROL. Without this the `closed` assertions above are a
  // check that cannot fail, which is indistinguishable from one that passes.
  for (const plant of MESH_PLANTS) {
    const { mesh, built } = build('Planted', CUBE, plant);
    const solid = mesh.parts.find((p) => p.dim === 3);
    assert.ok(solid?.audit, `${plant}: the plant produced an audited solid`);
    assert.notEqual(solid!.audit!.verdict, 'closed', `${plant}: the audit went red`);

    assert.equal(built.ok, false, `${plant}: the save was refused`);
    if (built.ok) continue;
    // The refusal NAMES the verdict — a refusal that says only "invalid" tells
    // the operator nothing they can act on.
    assert.match(built.refusal.headline, /mesh audit says "(open|non-manifold|seams)"/);
    // And carries the audit's own sentence rather than a paraphrase.
    assert.equal(built.refusal.detail.startsWith(solid!.audit!.detail), true);
  }
});

test('a refused model never reaches the store', async () => {
  const { built } = build('Never saved', CUBE, 'drop-face');
  assert.equal(built.ok, false);
  const rows = (await store.list('drawings')).filter((i) => i.name === 'Never saved');
  assert.equal(rows.length, 0);
});

test('a source with no solid is refused — a 2D shape has nothing to section', () => {
  const { built } = build('Flat only', 'square([30, 20]); circle(r = 5);');
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.refusal.headline, /no solid/);
  assert.match(built.refusal.detail, /2D shape\(s\) and no solid/);
});

test('an unnamed model is refused before anything is encoded', () => {
  const { built } = build('   ', CUBE);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.match(built.refusal.headline, /needs a name/);
});

// ---------------------------------------------------------------------------
// Staleness — the price of caching a mesh, paid
// ---------------------------------------------------------------------------

test('an edited source with an unrefreshed mesh reports STALE, and names which half moved', () => {
  const { built } = build('Drifted', CUBE);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  assert.equal(verifyCadRecord(built.record).status, 'ok');

  // The failure this whole checksum pair exists for: someone changes the design
  // text without re-evaluating, and the bytes are now of a different shape.
  const sourceMoved = { ...built.record, cad: { ...built.record.cad, source: 'cube([99, 99, 99]);' } };
  const v1 = verifyCadRecord(sourceMoved);
  assert.equal(v1.status, 'stale');
  assert.match(v1.status === 'stale' ? v1.why : '', /SOURCE has changed/);

  // And the other direction: the bytes were swapped for someone else's.
  const meshMoved = { ...built.record, bytes: built.record.bytes.slice(0, built.record.bytes.length - 50) };
  const v2 = verifyCadRecord(meshMoved);
  assert.equal(v2.status, 'stale');
  assert.match(v2.status === 'stale' ? v2.why : '', /MESH has changed/);

  // Both at once is its own message, not one of the two above.
  const bothMoved = { ...sourceMoved, bytes: meshMoved.bytes };
  const v3 = verifyCadRecord(bothMoved);
  assert.equal(v3.status, 'stale');
  assert.match(v3.status === 'stale' ? v3.why : '', /BOTH halves/);
});

test('the STORE refuses to write a record that does not verify — the gate is not only in the UI', async () => {
  const { built } = build('Stale write', CUBE);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const broken = { ...built.record, cad: { ...built.record.cad, source: '// something else\n' } };
  await assert.rejects(() => store.saveCadModel(broken, 3), /NOT saved/);
  const rows = (await store.list('drawings')).filter((i) => i.name === 'Stale write');
  assert.equal(rows.length, 0);
});

test('a record from an unknown schema version is refused rather than read field-by-field', () => {
  const { built } = build('From the future', CUBE);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const future = { ...built.record, cad: { ...built.record.cad, version: 99 } };
  const v = verifyCadRecord(future);
  assert.equal(v.status, 'incompatible');
});

// ---------------------------------------------------------------------------
// Parse state — a model missing a feature says so, at the point of USE
// ---------------------------------------------------------------------------

test('a model saved with a refused construct is SAVED, carries it, and says so first', async () => {
  const src = 'cube([20, 20, 6]);\nhulls() cube(5);\n';
  const { parse, built } = build('Missing a feature', src);

  // The premise: the parser really did refuse something, by name and line.
  assert.ok(parse.unsupported.length > 0);
  assert.ok(parse.unsupported.some((u) => u.name.includes('hulls')));

  // It is saved rather than refused — a closed solid missing a feature is
  // something an operator may legitimately intend to cut.
  assert.equal(built.ok, true, built.ok ? '' : built.refusal.detail);
  if (!built.ok) return;
  assert.equal(built.record.cad.verdict, 'closed');
  assert.equal(built.record.cad.complete, false);
  assert.ok(built.record.cad.unsupported.some((u) => u.name.includes('hulls')));
  assert.ok(built.record.cad.unsupported[0].line > 0, 'the line travels with it');

  // 🔴 AND IT IS THE FIRST THING SAID WHEN THE PART IS SELECTED. A caveat under
  // the numbers it qualifies is a caveat read after the decision.
  const props = describeCadRecord(built.record);
  assert.match(String(props[0].label), /FEATURES ARE MISSING/);
  assert.match(String(props[0].value), /hulls/);

  // Through the store as well, not only in memory.
  await store.saveCadModel(built.record, 4);
  const back = await store.loadCadModel('Missing a feature');
  assert.equal(back?.item.data.cad.complete, false);
  assert.match(String(describeCadRecord(back!.item.data)[0].label), /FEATURES ARE MISSING/);
  await store.remove('drawings', 'Missing a feature');
});

test('a complete model does not claim more than "nothing was refused"', () => {
  const { built } = build('Clean', POCKET);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.record.cad.complete, true);
  const props = describeCadRecord(built.record);
  assert.match(String(props[0].label), /Complete\?/);
  assert.match(String(props[0].value), /statement about the LANGUAGE/);
  // The section warning is present on a complete model too — it is a property of
  // the CNC side being 2.5D, not of anything being wrong with this model.
  assert.ok(props.some((p) => /Section Z/.test(String(p.label))));
  assert.ok(props.some((p) => /ONE flat section/.test(String(p.value))));
});

test('a stale record leads its description with a do-not-cut line', () => {
  const { built } = build('Drifted description', CUBE);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const broken = { ...built.record, cad: { ...built.record.cad, source: 'cube(1);' } };
  const props = describeCadRecord(broken);
  assert.match(String(props[0].label), /STALE — do not cut/);
});

test('isCadRecord tells a CAD model from an ordinary saved drawing', () => {
  const { built } = build('Discriminate', CUBE);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(isCadRecord(built.record), true);
  assert.equal(isCadRecord({ text: '0\nSECTION\n', format: 'dxf', name: 'a.dxf' }), false);
  assert.equal(isCadRecord(null), false);
  assert.equal(isCadRecord({ cad: { kind: 'something else' } }), false);
});

// ---------------------------------------------------------------------------
// The new collections
// ---------------------------------------------------------------------------

test('a database that already existed gained the new object stores, because they were MISSING', async () => {
  /* 🔴 WHAT MAKES THIS GO RED IS A MISSING STORE, NOT `DB_VERSION` — AND THE
   * COMMENT HERE CLAIMED THE OPPOSITE UNTIL 2026-08-11.
   *
   * It used to read: *"The database was seeded at version 1 with three stores.
   * If `DB_VERSION` had not been bumped, `onupgradeneeded` would never fire and
   * this write would throw NotFoundError."* That was true when it was written
   * and `a4e5ff68be` moved the thing it names. `open()` no longer requests a
   * fixed version at all: it opens at WHATEVER IS ON DISK, asks `COLLECTIONS`
   * which stores are absent, and upgrades to `db.version + 1` only when one is —
   * so the upgrade this test rides fires on a NAME being absent, and `DB_VERSION`
   * is now exactly one thing, the generation stamped into an export file.
   *
   * ⚠ THE TEST NEVER STOPPED BEING WORTH RUNNING; it stopped being able to
   * prove the sentence above it. That is the failure mode, and it is invisible
   * from a green: the assertion passed throughout, so nothing pointed at the
   * comment. Measured with three plants against a COPY of the tree rather than
   * argued:
   *
   *   DB_VERSION 3 -> 1  (exactly what the old comment named)  21 pass, 0 fail
   *   drop 'operations' from COLLECTIONS                       THIS TEST FAILS
   *   never take the missing-store branch in `open()`          THIS TEST FAILS
   *
   * So: the one lever the comment cited is the one lever this test does not
   * respond to. What it DOES guard, and what a future change would break:
   * `COLLECTIONS` losing a name, and `open()`'s upgrade branch not running on a
   * pre-existing database. The seed above must stay at the OLD schema for either
   * to mean anything — from an empty browser both plants would pass, because a
   * fresh `indexedDB.open` fires `onupgradeneeded` regardless.
   *
   * 🔴 The guard the bump USED to get for free is gone and is not re-created
   * here. A forgotten `DB_VERSION` bump now breaks nothing at runtime and only
   * makes every export file understate its own generation. That replacement
   * lives in `web/tests/store-schema.test.ts`, which pins the number against the
   * exact `COLLECTIONS` list — not in this file, and this file should not be
   * read as covering it. */
  await store.save('operations', 'roughing', { rpm: 18000 }, 10);
  await store.save('spoilboards', 'left bench', { id: 'x' }, 10);
  assert.equal((await store.list('operations')).length, 1);
  assert.equal((await store.list('spoilboards')).length, 1);
  await store.remove('operations', 'roughing');
  await store.remove('spoilboards', 'left bench');
});

test('an operation applied over a different tool set does NOT hand back the numbers', () => {
  const op = {
    depthPerPass: 3,
    rpm: 18000,
    entry: 'Ramp',
    direction: 'Climb',
    dogbone: 'Corner',
    finishAllowance: 0.2,
    leadMm: 2,
    tabsEnabled: true,
    tabHeight: 2,
    tabWidth: 6,
    tabSpacing: 120,
    toolIds: ['endmill-6mm-2f'],
    material: 'Plywood',
  };

  const refused = store.readOperation(op, { toolIds: ['endmill-3mm-2f'], material: 'Plywood' });
  assert.equal(refused.status, 'tool-mismatch');
  if (refused.status !== 'tool-mismatch') return;
  assert.match(refused.why, /properties OF THE CUTTER/);
  assert.deepEqual(refused.savedToolIds, ['endmill-6mm-2f']);
  assert.deepEqual(refused.currentToolIds, ['endmill-3mm-2f']);
  /* 🔴 The numbers are not on this branch AT ALL — not present-and-ignored.
   * This asserts the runtime shape; the compile-time half is the discriminated
   * union in `store.ts`, which is what stops an `App.tsx` caller reading
   * `.values` without handling the mismatch first. This file is not
   * type-checked (see the header), so it can only hold the runtime half. */
  assert.equal('values' in refused, false);

  // An empty acknowledgement is not an acknowledgement.
  assert.equal(store.readOperation(op, { toolIds: ['endmill-3mm-2f'], material: 'Plywood' }, '   ').status, 'tool-mismatch');

  const forced = store.readOperation(
    op,
    { toolIds: ['endmill-3mm-2f'], material: 'Plywood' },
    'operator refitted the 6mm after saving this'
  );
  assert.equal(forced.status, 'ok');
  if (forced.status !== 'ok') return;
  assert.equal(forced.values.rpm, 18000);
  assert.match(forced.note ?? '', /APPLIED OVER A TOOL MISMATCH/);
  // The numbers came through unchanged, and only the operation's own fields did.
  assert.equal('material' in forced.values, false);
  assert.equal('toolIds' in forced.values, false);
});

test('a matching tool set returns the numbers, and a material change is still said', () => {
  const op = {
    depthPerPass: 3,
    rpm: 18000,
    entry: 'Ramp',
    direction: 'Climb',
    dogbone: 'Corner',
    finishAllowance: 0.2,
    leadMm: 2,
    tabsEnabled: true,
    tabHeight: 2,
    tabWidth: 6,
    tabSpacing: 120,
    toolIds: ['a', 'b'],
    material: 'Plywood',
  };
  const same = store.readOperation(op, { toolIds: ['b', 'a'], material: 'Plywood' });
  assert.equal(same.status, 'ok');
  if (same.status !== 'ok') return;
  assert.equal(same.note, null, 'nothing to say when nothing differs');
  assert.equal(same.values.depthPerPass, 3);

  const otherStock = store.readOperation(op, { toolIds: ['a', 'b'], material: 'Aluminium' });
  assert.equal(otherStock.status, 'ok');
  if (otherStock.status !== 'ok') return;
  assert.match(otherStock.note ?? '', /material/i);
});

test('a spoilboard restored onto a different machine keeps the board and DROPS the position', () => {
  const rec = {
    id: 'mdf-18',
    x: '12.5',
    y: '30',
    sizeX: '',
    sizeY: '',
    name: '',
    machine_travels_mm: [1250, 670, 100] as [number, number, number],
  };

  const elsewhere = store.readSpoilboard(rec, [600, 900, 80], 5);
  assert.equal(elsewhere.values.id, 'mdf-18', 'the board itself still comes back');
  assert.equal(elsewhere.values.x, '', 'the position did not');
  assert.equal(elsewhere.values.y, '');
  assert.equal(elsewhere.dropped.length, 1);
  assert.equal(elsewhere.dropped[0].field, 'spoilboardPosition');
  assert.match(elsewhere.dropped[0].reason, /MACHINE coordinates/);
  assert.equal(elsewhere.provenance, null);

  const sameMachine = store.readSpoilboard(rec, [1250, 670, 100], 5);
  assert.equal(sameMachine.values.x, '12.5');
  assert.equal(sameMachine.dropped.length, 0);
  // A match is provenance, not a green: identical travels cannot prove identity.
  assert.match(sameMachine.provenance ?? '', /not proof of the same machine/);

  // A board saved before the fingerprint existed has nothing to check against,
  // and unknown is treated as different rather than as fine.
  const noFingerprint = store.readSpoilboard({ ...rec, machine_travels_mm: undefined }, [1250, 670, 100], 5);
  assert.equal(noFingerprint.values.x, '');
  assert.match(noFingerprint.dropped[0].reason, /without recording which machine/);

  // A board with no position at all is not a drop — it is a board with no
  // position, which is exactly what the core treats as unchecked.
  const noPosition = store.readSpoilboard({ ...rec, x: '', y: '' }, [600, 900, 80], 5);
  assert.equal(noPosition.dropped.length, 0);
});

// ---------------------------------------------------------------------------
// Export / import across a schema change
// ---------------------------------------------------------------------------

test('an import names the collections it had to leave behind instead of reporting success', async () => {
  const file = JSON.stringify({
    kind: '2bee.slicer store',
    version: 99,
    collections: ['machines', 'drawings', 'toolpaths', 'fixtures'],
    machines: [{ name: 'Imported mill', saved_at: 1, data: { travelX: 1250 } }],
    drawings: [],
    toolpaths: [{ name: 'a', saved_at: 1, data: {} }, { name: 'b', saved_at: 1, data: {} }],
    fixtures: [{ name: 'c', saved_at: 1, data: {} }],
  });

  const r = await store.importAll(file, 6);
  assert.equal(r.added, 1);
  // 🔴 The two unknown collections are NAMED and COUNTED. Before 2026-08-10 this
  // returned `{added: 1, replaced: []}` and the three lost items were invisible.
  assert.deepEqual(
    r.skipped.sort((a, b) => a.collection.localeCompare(b.collection)),
    [
      { collection: 'fixtures', items: 1 },
      { collection: 'toolpaths', items: 2 },
    ]
  );
  assert.match(r.versionNote ?? '', /NEWER version/);
  await store.remove('machines', 'Imported mill');
});

test('a file exported today carries the collection list and the warning for an older build', async () => {
  const text = await store.exportAll();
  const parsed = JSON.parse(text);
  assert.equal(parsed.kind, '2bee.slicer store', 'the compatibility key is unchanged');
  /* The literal list, not `store.COLLECTIONS` — a test that re-derives its
   * expectation from the thing under test asserts only that the module agrees
   * with itself. `inventory` was appended 2026-08-11 (TODO #83) with the 2 → 3
   * schema bump, and this line going red is the intended cost of adding one. */
  assert.deepEqual(parsed.collections, [
    'machines',
    'workpieces',
    'drawings',
    'spoilboards',
    'operations',
    'inventory',
  ]);
  assert.match(parsed.note, /OLDER build/);
  // And it round-trips through the importer that reads it.
  const r = await store.importAll(text, 7);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.versionNote, null);
});

test('a file that is not ours is refused by its kind, not parsed hopefully', async () => {
  await assert.rejects(() => store.importAll(JSON.stringify({ kind: 'something else' }), 8), /not a 2bee.slicer store file/);
});
