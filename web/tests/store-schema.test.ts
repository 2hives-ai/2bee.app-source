/*
 * THE DATABASE VERSION NEGOTIATION — the founder's dead store, 2026-08-11.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WENT WRONG, AND WHY IT IS ONE BUG AND NOT TWO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On screen: *"The stored inventory could NOT be read… The requested version (3)
 * is less than the existing version (4)"* — and, one panel up, *"save as does
 * not work: Machine"*.
 *
 * `store.ts::open()` is the ONLY door in that file. Every collection, every CAD
 * record and the whole inventory go through it, so an origin whose database had
 * been taken above the fixed `DB_VERSION` was dead in ALL of them at once: no
 * read, no write, no recovery short of clearing site data — which deletes
 * everything the operator saved. `Save as` was correctly wired the whole time;
 * it was writing into a database this build could not open.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHAT THESE TESTS CAN AND CANNOT PROVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `tests/fake-indexeddb.mjs` is a stand-in, and its own header says a green here
 * is not a green in a browser. What IS exercised: `store.ts`'s negotiation —
 * open unversioned, detect a missing store BY NAME, upgrade to `on-disk + 1` and
 * only then. What is NOT: Chrome's real version semantics, its transaction
 * lifetimes, and the two-tab dance, which is `e2e/storage.spec.ts`'s job.
 *
 * ✅ THE NEGATIVE CONTROL IS FIRST AND IT IS NOT DECORATION. Before asserting
 * that the fix works, this file asserts that the stand-in still REFUSES a
 * below-disk open with the founder's own error string. Without that, every test
 * below would pass just as happily against a fake that had quietly stopped
 * modelling the refusal — a green that means "the defect is unreachable here".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-indexeddb.mjs';

const DB_NAME = '2bee.slicer';
const ALL_STORES = ['machines', 'workpieces', 'drawings', 'spoilboards', 'operations', 'inventory'];

/* 🔴 SEEDED AT GENERATION 4 — ABOVE THIS BUILD'S OWN — WHICH IS THE FOUNDER'S
 * STATE, and seeded BEFORE `store.ts` is imported so the module's first open
 * meets it. A test that started from an empty browser would pass with the fix
 * reverted, i.e. it would agree with the defect. */
installFakeIndexedDb({ name: DB_NAME, version: 4, stores: ALL_STORES });

const store = await import('../src/store.ts');

/** The fake's registry, so a test can look at the database rather than at the
 *  code that talks to it. */
function onDisk(): { version: number; stores: string[] } {
  const impl = globalThis.indexedDB as unknown as {
    databases: Map<string, { version: number; stores: Map<string, unknown> }>;
  };
  const db = impl.databases.get(DB_NAME);
  assert.ok(db, 'the fake holds no database under this name');
  return { version: db!.version, stores: [...db!.stores.keys()] };
}

// ---------------------------------------------------------------------------
// The negative control
// ---------------------------------------------------------------------------

test('the stand-in still refuses an open BELOW the on-disk version, in Chrome’s words', async () => {
  const outcome = await new Promise<string>((resolve) => {
    const req = (globalThis.indexedDB as IDBFactory).open(DB_NAME, 3);
    req.onerror = () => resolve(String(req.error));
    req.onsuccess = () => resolve('opened');
  });
  /* This IS the sentence the founder read, and it is the one the OLD `open()`
   * produced on every single call. If this test ever says `opened`, the fake has
   * stopped modelling the refusal and everything below is vacuous. */
  assert.match(outcome, /VersionError/);
  assert.match(outcome, /The requested version \(3\) is less than the existing version \(4\)/);
});

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

test('a database a NEWER build left behind is read and written, not refused', async () => {
  /* The old `open()` asked for a fixed 3 and every one of these would have
   * rejected with the string asserted above — which is exactly what the founder
   * saw: an inventory that could not be read and a Save as that did nothing. */
  await store.save('machines', 'bench-1337', { travelX: 1337 }, 10);
  const machines = await store.list<{ travelX: number }>('machines');
  assert.equal(machines.length, 1);
  assert.equal(machines[0].data.travelX, 1337);

  const back = await store.load<{ travelX: number }>('machines', 'bench-1337');
  assert.equal(back?.data.travelX, 1337, 'the record did not come back out of the store');

  await store.remove('machines', 'bench-1337');
  assert.equal((await store.list('machines')).length, 0);
});

test('opening a database that is already complete does NOT bump its version', async () => {
  /* 🔴 THE DIFFERENCE BETWEEN THE FIX AND A NAIVE ONE. "Always reopen at
   * `version + 1`" would also cure the founder's error — and would ratchet every
   * browser's database one generation on every page load, which is a write to a
   * user's schema performed by an app that had nothing to change. The upgrade is
   * driven by a MISSING STORE, by name, and by nothing else. */
  await store.list('machines');
  assert.equal(onDisk().version, 4, 'the store upgraded a database that was already complete');
});

test('the note names the newer build instead of throwing its error', () => {
  const note = store.schemaNote();
  assert.ok(note, 'nothing was said about a database written by a build this one is not');
  /* The FACT the `VersionError` was carrying, kept: another build owns this
   * data. What is dropped is the consequence — that everything stops. */
  assert.match(note!, /generation 4/);
  assert.match(note!, new RegExp(`declares ${store.DB_VERSION}`));
  assert.match(note!, /NEWER build/);
  /* 🔴 IT MUST SAY THE APP IS STILL WORKING. A note that only reported the
   * mismatch would read as the failure it replaced. */
  assert.match(note!, /read and written normally/i);
  /* ...and it must not claim to cover what it cannot see. */
  assert.match(note!, /CANNOT see/);
});

// ---------------------------------------------------------------------------
// The upgrade path, which is what the version number USED to drive
// ---------------------------------------------------------------------------

test('a missing collection is created at on-disk + 1, from a database at generation 1', async () => {
  /* Every existing user's state on the day a collection is added. The old code
   * reached this through `DB_VERSION` being higher; this reaches it through the
   * store not being there, which is the fact that actually matters — and which
   * stays true when the on-disk number is HIGHER than this build's. */
  installFakeIndexedDb({ name: DB_NAME, version: 1, stores: ['machines', 'workpieces', 'drawings'] });
  store._resetStoreForTests();

  await store.save('inventory', 'current', { entries: [] }, 10);
  assert.equal((await store.list('inventory')).length, 1);

  const disk = onDisk();
  assert.equal(disk.version, 2, 'the upgrade did not go to on-disk + 1');
  for (const c of ALL_STORES) {
    assert.ok(disk.stores.includes(c), `the upgrade did not create the \`${c}\` store`);
  }
  /* Nothing existing was destroyed — the property every bump note in `store.ts`
   * claims and the reason the handler only ever CREATES. */
  assert.equal(store.schemaNote(), null, 'a database below this build reported a newer build');
});

test('a collection missing from a database ABOVE this build is still created', async () => {
  /* 🔴 THE CASE NEITHER OLD PATH COULD REACH. A newer build left generation 5
   * behind and this build needs a store it does not have — under the old code
   * this was an unrecoverable refusal; under a "just open unversioned" fix it
   * would be a `NotFoundError` on first use. It has to upgrade UPWARDS from
   * where the disk is, not from where this build's number is. */
  installFakeIndexedDb({ name: DB_NAME, version: 5, stores: ['machines'] });
  store._resetStoreForTests();

  await store.save('operations', 'roughing', { rpm: 18000 }, 10);
  assert.equal((await store.list('operations')).length, 1);
  assert.equal(onDisk().version, 6, 'the upgrade went to DB_VERSION rather than to on-disk + 1');
});

// ---------------------------------------------------------------------------
// The check this change WEAKENED, replaced mechanically
// ---------------------------------------------------------------------------

test('DB_VERSION is pinned to the exact collection list it stamps into export files', () => {
  /* 🔴 WHY THIS TEST EXISTS AND WHAT IT REPLACES. Until 2026-08-11 forgetting to
   * bump `DB_VERSION` when a collection was added broke LOUDLY — the new object
   * store was never created and `db.transaction()` threw `NotFoundError` on the
   * first call. `open()` now creates what is missing regardless, so that
   * accidental alarm is GONE, and the only remaining consumer of the number is
   * the generation stamped into an export file and compared against an incoming
   * one. A forgotten bump would now be silent and would only make every exported
   * file understate itself to the build that reads it.
   *
   * So the alarm is re-armed deliberately, here, where it says why. If you are
   * reading this because the test is red: you changed `COLLECTIONS`. Bump
   * `DB_VERSION` and update BOTH lists below in the same commit. */
  assert.deepEqual(
    store.COLLECTIONS,
    ['machines', 'workpieces', 'drawings', 'spoilboards', 'operations', 'inventory'],
    'COLLECTIONS changed — see this test’s comment: DB_VERSION has to move with it'
  );
  assert.equal(
    store.DB_VERSION,
    3,
    'the collection list above is the one that shipped at generation 3; a change to it needs a bump'
  );
});
