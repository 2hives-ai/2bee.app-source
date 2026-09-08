// Saved machines, workpieces, drawings, spoilboards and operations.
//
// ONE store, five collections. Five separate stores would drift: five
// versions of "is this name taken", five export formats, five bugs.
//
// 🔴 EACH COLLECTION IS A THING THE OPERATOR SAVES AND PICKS AGAIN — founder
// 2026-08-10: *"when I edit able to save the spoil board, workpiece, drawings,
// operation; operation needs a list so I can pick an operation (setting) from
// the list"*. `spoilboards` and `operations` were added that day and needed a
// DB version bump; see `DB_VERSION` below, which is the one part of this file
// that can break an existing user rather than merely disappoint them.
//
// IndexedDB rather than localStorage because a DXF is text and a real one runs
// to megabytes; localStorage's ~5MB budget is shared with everything else the
// origin keeps and fails by THROWING mid-write, which would lose a drawing the
// user believed was saved.
//
// 🔴 This is browser-local. It is not sync, not backup, and not visible to the
// CLI or the gates. Clearing site data deletes it. The export/import pair below
// exists so a shop can put a machine definition in a file and keep it with the
// machine, rather than trusting one browser profile with the only copy.

import type { ClampCfg } from './cam';
import { WORKHOLDING } from './workholding';
import { TOUCH_PLATES } from './touchplates';
import type { SavedCadDrawing } from './cad/record';
import { verifyCadRecord, isCadRecord, type CadVerification } from './cad/record';

export type Collection =
  | 'machines'
  | 'workpieces'
  | 'drawings'
  | 'spoilboards'
  | 'operations'
  /**
   * WHICH OF THOSE THIS SHOP ACTUALLY HAS — added 2026-08-11 for TODO #83,
   * founder: *"in machine, spoilboard, Work Holding, Tooling I should able to
   * select what I have in inventory"*.
   *
   * 🔴 IT IS NOT A SIXTH KIND OF SAVED OBJECT. The five above are things the
   * operator BUILT here and picks again. This one is a claim about the physical
   * shop, imported from `bom`/`ops` and not authored in this app — the shape,
   * the refusals and the reason the app must not invent it are all in
   * `inventory.ts`, which owns everything about the contents. This file only
   * gives it somewhere to live.
   *
   * ⚠ ONE RECORD, under `INVENTORY_RECORD_NAME`. A collection is used rather
   * than localStorage for the same reason `drawings` is: an inventory can be
   * thousands of rows, and localStorage fails by THROWING mid-write.
   */
  | 'inventory';

export const COLLECTIONS: Collection[] = [
  'machines',
  'workpieces',
  'drawings',
  'spoilboards',
  'operations',
  'inventory',
];

const DB_NAME = '2bee.slicer';

/**
 * 🔴 BUMPED 1 → 2 ON 2026-08-10, BECAUSE ADDING A COLLECTION IS A SCHEMA CHANGE.
 *
 * IndexedDB creates object stores only inside `onupgradeneeded`, and that event
 * only fires when the requested version is HIGHER than the stored one. Adding
 * `spoilboards` and `operations` to the array above without this bump would
 * leave every existing user on a database that has three object stores while
 * the code asks for five — and `db.transaction('operations')` on a store that
 * does not exist throws `NotFoundError` on EVERY read and EVERY write. Not a
 * degraded feature: an exception out of the first call, in a browser where the
 * app had been working.
 *
 * The upgrade handler already creates whatever is missing, so this is correct
 * for both a fresh install and an upgrade, and it destroys nothing: the three
 * existing stores are untouched and a user's saved machines survive.
 *
 * ⚠ WHAT A BUMP COSTS, handled below rather than discovered: a tab that already
 * has the OLD database open BLOCKS the upgrade. Before 2026-08-10 there was no
 * `onblocked` handler, so that case resolved as *nothing at all* — the promise
 * never settled, every store call hung forever, and the app looked like it had
 * simply stopped saving. A hang is the worst failure this file can produce,
 * because it is indistinguishable from slowness. It now rejects with a sentence
 * naming the other tab.
 */
/**
 * 🔴 BUMPED 2 → 3 ON 2026-08-11, for the same reason and by the same rule as the
 * bump above: `inventory` is a new object store, and IndexedDB creates object
 * stores ONLY inside `onupgradeneeded`, which fires only on a higher version.
 * Without this, every existing user's database would hold five stores while the
 * code asks for six, and the FIRST call `inventory.ts` makes —
 * `db.transaction('inventory')` — throws `NotFoundError`. Not a missing feature:
 * an exception on load, in a browser where the app had been working.
 *
 * Everything the 1 → 2 note above says about what a bump costs still applies
 * unchanged: the `onblocked` handler is what keeps a second tab holding the old
 * version from resolving as silence, and the upgrade handler destroys nothing —
 * the five existing stores are untouched and every saved machine survives.
 *
 * ⚠ The one genuinely new consequence is on the EXPORT FILE. A store file
 * written by this build declares six collections; a build that predates it will
 * import five and REPORT the sixth as skipped, by name and item count, because
 * `importAll` walks the FILE rather than its own list. That path is why this
 * bump is a bump and not a silent addition — it was built for exactly this.
 */
/**
 * 🔴 SINCE 2026-08-11 THIS IS **NOT** THE VERSION THE DATABASE IS OPENED AT.
 * `open()` below opens at whatever is ON DISK and upgrades only when a
 * collection is genuinely missing. This constant is now exactly one thing: the
 * **generation stamped into an export file** (`exportAll`) and compared against
 * an incoming one (`importAll`).
 *
 * ⚠ AND THAT IS A CHECK THIS CHANGE WEAKENED, SO IT IS NAMED RATHER THAN LEFT
 * TO BE DISCOVERED. Before, forgetting to bump this when a collection was added
 * broke LOUDLY on the next run — `db.transaction('<new store>')` threw
 * `NotFoundError` on a database that had not been upgraded. Now the store
 * creates what is missing regardless, so a forgotten bump would break nothing at
 * runtime and would only make every export file understate its own generation —
 * a silent wrong number in a file whose whole job is to be read by a build that
 * is not this one. The replacement guard is mechanical and lives in
 * `web/tests/store-schema.test.ts`: it pins this number against the exact
 * `COLLECTIONS` list, so adding a collection fails a test that says why.
 */
export const DB_VERSION = 3;

export interface SavedItem<T = unknown> {
  /** The user's name for it. Also the key: saving over a name replaces it. */
  name: string;
  /** Millis. Stamped by the caller, so a test can control it. */
  saved_at: number;
  data: T;
}

let dbp: Promise<IDBDatabase> | null = null;

/**
 * The version the LAST SUCCESSFUL OPEN found on disk. `null` before the first
 * one. Read by {@link schemaNote}; never used to decide anything.
 */
let schemaOnDisk: number | null = null;

/**
 * One `indexedDB.open`, wrapped. `version === undefined` opens at whatever is on
 * disk — which is the whole point of the two-step in {@link open}.
 */
function request(version?: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Creates what is missing and touches what is not. A user upgrading from
      // the three-collection schema keeps every machine, sheet and drawing.
      for (const c of COLLECTIONS) {
        if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: 'name' });
      }
    };
    /* 🔴 THE OTHER TAB. An upgrade cannot proceed while another connection holds
     * the old version, and without this handler that state is SILENCE — the
     * promise never settles and every call in this file waits forever. A hang is
     * worse than an error here because it looks like slowness, and the operator's
     * next action is to wait rather than to close the other tab. */
    req.onblocked = () =>
      reject(
        new Error(
          'this app is open in another tab using an older version of its local database. ' +
            'Close the other tab and reload — nothing was saved or lost.'
        )
      );
    req.onsuccess = () => {
      const db = req.result;
      /* The mirror image of `onblocked`: when ANOTHER tab starts an upgrade, this
       * connection is what blocks it. Closing on demand turns a deadlock between
       * two tabs into a reload in one of them. The closed connection is not
       * reused — `dbp` is cleared so the next call reopens. */
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS OPENS WITH NO VERSION — THE FOUNDER'S DEAD STORE, 2026-08-11
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * On screen: *"The stored inventory could NOT be read… The requested version (3)
 * is less than the existing version (4)"*, with every tool row UNCHECKED **for a
 * fault rather than an absence** — and, one panel up, *"save as does not work:
 * Machine"*.
 *
 * ⚠ THOSE ARE ONE BUG, NOT TWO, AND THAT IS THE FIRST THING TO SAY. `open()` is
 * the ONLY door in this file: `save`, `list`, `load`, `remove`, `exportAll`,
 * `importAll`, the CAD records and `inventory.ts` all go through it. Open fails
 * ⇒ `useSaved.refresh()` rejects and leaves `items` at `[]`, which renders as
 * *"you have saved nothing"*; `saveAs` rejects, so the row never appears. **Save
 * as was wired correctly the whole time** (`useSaved` has called `refresh()`
 * after every successful write since it was written) — it was writing into a
 * database this build could not open.
 *
 * 🔴 THE OLD `open()` REQUESTED A FIXED `DB_VERSION`, AND INDEXEDDB REFUSES TO
 * OPEN A DATABASE AT A VERSION BELOW THE ONE ON DISK. So any origin whose
 * database had ever been taken above 3 was **permanently and unrecoverably
 * bricked for this build** — no read, no write, no recovery except clearing site
 * data, which destroys everything the operator saved. A whole-app failure with
 * no route back is not a defensible response to a number being larger than
 * expected.
 *
 * ⚠ WHAT PUT HIS DATABASE AT 4 IS **NOT ESTABLISHED**, and I will not repeat the
 * guess. `540bab9d66` says `e2e/storage.spec.ts:300` — which opens at
 * `DB_VERSION + 1` and never deletes or restores — leaves *"any origin that suite
 * touches"* at 4. That file IS the only code in this tree that opens above
 * `DB_VERSION` (measured: `grep -rn 'indexedDB.open' src/ e2e/ tests/` returns
 * three sites, one of them it), and it is fixed in this change. But Playwright
 * gives every test a fresh, ephemeral BrowserContext with its own storage, so it
 * cannot reach the founder's own Chrome profile, and `DB_VERSION` has never been
 * 4 in git history (`git log -S 'const DB_VERSION'`: 1, 1, 3). **A cause I cannot
 * reproduce does not make an unrecoverable brick acceptable** — so the
 * consequence is fixed here and the provenance is left open rather than closed
 * with a story.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 ARGUING WITH `e2e/storage.spec.ts`, WHICH DEFENDS THE OLD BEHAVIOUR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * That file says the refusal is *"the honest product behaviour, not a shortfall:
 * the tab is running an OLDER BUILD than the one that owns the database now. It
 * cannot write, and the app's job is to say so"*. **Half of that is right and is
 * kept; the half that is wrong is why it was worth arguing with rather than
 * overturning quietly.**
 *
 *   ✅ RIGHT — *say so, never hang and never drop a save silently*. Unchanged.
 *      `onblocked` still rejects with a sentence, a failed write is still
 *      surfaced by `useSaved`, and {@link schemaNote} now states out loud the one
 *      fact the `VersionError` was carrying: **another build owns this data.**
 *      It is said as a note by code that chose to say it, instead of arriving as
 *      a browser exception nobody wrote.
 *
 *   🔴 WRONG — *"it cannot write"* was never a decision this app made. It is
 *      Chrome's invariant, and the file promoted an unimplemented, untunable
 *      side-effect to a product rule. A behaviour nobody wrote is not a control:
 *      nothing can watch it go red, nothing can scope it, and it fires on the
 *      version NUMBER rather than on any incompatibility. It also refused every
 *      READ, which no reading of *"an older build must not write"* asks for.
 *
 *   🔴 AND THE PROPERTY IT PROTECTED IS PROTECTED BETTER HERE, because it is now
 *      checked rather than assumed. The risk in opening a newer database is
 *      reading records whose MEANING moved. This app's schema changes have only
 *      ever ADDED object stores — the upgrade handler above literally cannot do
 *      anything else — so a higher on-disk version is a SUPERSET of what this
 *      build needs, and `open()` verifies that by NAME (every collection present)
 *      instead of inferring it from an integer. A version number is a proxy for
 *      "are my stores here"; this asks the question directly.
 *
 * ⚠ THE LIMIT, STATED: this build will read and write a store written by a build
 * that added a COLLECTION. It would also read one that changed what a RECORD
 * means, and nothing here can see that — `validateDoc`, `readSession`,
 * `readOperation` and `verifyCadRecord` are the per-record guards, and they are
 * the layer where a re-meant field is caught. If a future change re-means a
 * record, the refusal belongs THERE, on the record, not on an integer that
 * cannot tell an added store from a rewritten one.
 * ───────────────────────────────────────────────────────────────────────────── */
function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  /* 🔴 A FAILED OPEN IS NOT CACHED. `dbp` used to keep the rejected promise
   * forever, so one transient failure — a private-mode restriction, a blocked
   * upgrade, a quota refusal at open time — made the store permanently dead for
   * the life of the page with no way back except a reload the user has no reason
   * to think of. Clearing it means the next call retries. Unchanged by the
   * two-step below, which is why the `catch` wraps the WHOLE chain. */
  dbp = (async () => {
    const db = await request();
    schemaOnDisk = db.version;
    const missing = COLLECTIONS.filter((c) => !db.objectStoreNames.contains(c));
    if (missing.length === 0) return db;
    /* One above WHATEVER IS THERE — never `DB_VERSION`, which is the mistake
     * being fixed and may be below it. This is the only path that upgrades, and
     * it runs on the fact that a store is missing rather than on a number. */
    const next = db.version + 1;
    db.close();
    const upgraded = await request(next);
    schemaOnDisk = upgraded.version;
    return upgraded;
  })().catch((e) => {
    dbp = null;
    throw e;
  });
  return dbp;
}

/**
 * **Another build owns this database** — the one fact the old `VersionError`
 * carried, said deliberately instead of thrown accidentally.
 *
 * `null` when there is nothing to say: before the first open, and whenever the
 * on-disk generation is one this build declares. It is a NOTE and not an error,
 * because the app is working — that is the whole difference this change makes,
 * and rendering it in red would re-teach the operator the thing that was wrong.
 *
 * ⚠ It reports the state at the LAST SUCCESSFUL OPEN. It cannot report a
 * database that has never been opened, and it is not reactive — a caller renders
 * it on the next render after any store call, which every panel already does.
 */
export function schemaNote(): string | null {
  if (schemaOnDisk === null || schemaOnDisk <= DB_VERSION) return null;
  return (
    `This browser's local database is at generation ${schemaOnDisk} and this build declares ` +
    `${DB_VERSION} — it was last upgraded by a NEWER build of this app. Everything this build ` +
    `knows about (${COLLECTIONS.join(', ')}) is present and is being read and written normally. ` +
    `What this build CANNOT see is anything the newer one added: if you saved something there ` +
    `and cannot find it here, that is where it is. Nothing has been deleted or downgraded.`
  );
}

/** Test-only reset. The module caches one connection and one observed version
 *  for the life of the page, which is right in a browser and wrong across tests
 *  that each install their own stand-in. Never called by the app. */
export function _resetStoreForTests(): void {
  dbp = null;
  schemaOnDisk = null;
}

function tx<T>(c: Collection, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(c, mode);
        const req = fn(t.objectStore(c));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function save<T>(c: Collection, name: string, data: T, now: number): Promise<void> {
  const clean = name.trim();
  // An unnamed save is refused rather than stored as "". A blank name would be
  // one shared slot every later save silently overwrote.
  if (!clean) throw new Error('a saved item needs a name');
  await tx<IDBValidKey>(c, 'readwrite', (s) => s.put({ name: clean, saved_at: now, data }));
}

export async function list<T>(c: Collection): Promise<SavedItem<T>[]> {
  const all = await tx<SavedItem<T>[]>(c, 'readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function load<T>(c: Collection, name: string): Promise<SavedItem<T> | null> {
  return (await tx<SavedItem<T> | undefined>(c, 'readonly', (s) => s.get(name))) ?? null;
}

export async function remove(c: Collection, name: string): Promise<void> {
  await tx<undefined>(c, 'readwrite', (s) => s.delete(name));
}

/**
 * 🔴 THE COMPATIBILITY KEY OF EVERY FILE ALREADY EXPORTED, AND IT SAYS
 * `2bee.slicer` — this app's OLD name (renamed to `2bee.app` on 2026-08-09).
 *
 * Leave it. It is not a label, it is the one string `importAll` matches on, and
 * renaming it to match the product would make every file a shop has already
 * exported unreadable by the build that is supposed to read them — a silent
 * loss of the backup somebody made precisely so it would not be silent. If a
 * new key is ever introduced, the old value has to keep being accepted forever;
 * there is no version of this file in which dropping it is a tidy-up.
 *
 * (Same reasoning applies to `DB_NAME` above, which is also `2bee.slicer`: it
 * is the address of the user's existing data, not a name.)
 */
const STORE_FILE_KIND = '2bee.slicer store';

/**
 * Everything, as one JSON blob, for a file the shop can keep.
 *
 * ⚠ `collections` is written explicitly rather than left implicit in the keys.
 * A reader — including a FUTURE reader — can then tell the difference between
 * "this collection was empty" and "this file was written by a build that had no
 * such collection", which are the same thing to anything that iterates its own
 * list of names. That distinction is what {@link importAll} reports on.
 */
export async function exportAll(): Promise<string> {
  const out: Record<string, SavedItem[]> = {};
  for (const c of COLLECTIONS) out[c] = await list(c);
  return JSON.stringify(
    {
      kind: STORE_FILE_KIND,
      version: DB_VERSION,
      collections: COLLECTIONS,
      /* 🔴 IN THE FILE, not only in this comment. An older build imports the
       * collections IT knows and silently ignores the rest — it cannot do
       * otherwise, it was written before they existed — so the only place this
       * warning can reach the person holding the file is the file. */
      note:
        'Exported by 2bee.app store schema version ' +
        `${DB_VERSION}. An OLDER build of the app will import only the collections it knows ` +
        `(${COLLECTIONS.join(', ')} are in this file) and will not tell you which ones it dropped. ` +
        'Keep this file rather than re-exporting from an older build.',
      ...out,
    },
    null,
    2
  );
}

export interface ImportReport {
  added: number;
  replaced: string[];
  /**
   * 🔴 COLLECTIONS PRESENT IN THE FILE THAT THIS BUILD DOES NOT HAVE, with how
   * many items each was carrying. Never empty-and-silent: a partial import that
   * reports success is how a shop loses a machine definition it believed it had
   * backed up, and the loss is invisible because what DID import looks right.
   */
  skipped: { collection: string; items: number }[];
  /** Set when the file was written by a schema this build does not know. */
  versionNote: string | null;
}

/**
 * Merge a previously exported file back in.
 *
 * 🔴 Merge, not replace, and it REPORTS what it overwrote. An import that
 * silently replaced the store would destroy a machine definition someone was
 * still using, and they would find out at the machine.
 *
 * 🔴 AND IT REPORTS WHAT IT COULD NOT TAKE. Before 2026-08-10 this iterated
 * `COLLECTIONS` — this build's own list — so a file containing anything else
 * was imported "successfully" with that data dropped and nothing said. That was
 * harmless while the list never changed and became a real defect the day it
 * did. It now walks the FILE and names every collection it had to leave behind.
 *
 * ⚠ It still imports what it recognises rather than refusing the whole file.
 * The alternative — refuse a newer file outright — protects nothing (this build
 * cannot store what it has no object store for) and costs the user the machines
 * and drawings it could perfectly well have restored. What matters is that the
 * gap is stated, not that the file is rejected.
 */
export async function importAll(text: string, now: number): Promise<ImportReport> {
  const parsed = JSON.parse(text);
  if (parsed?.kind !== STORE_FILE_KIND) {
    throw new Error('not a 2bee.slicer store file');
  }
  let added = 0;
  const replaced: string[] = [];
  const known = new Set<string>(COLLECTIONS);

  for (const c of COLLECTIONS) {
    for (const item of (parsed[c] ?? []) as SavedItem[]) {
      if (!item?.name) continue;
      if (await load(c, item.name)) replaced.push(`${c}/${item.name}`);
      else added++;
      await save(c, item.name, item.data, item.saved_at ?? now);
    }
  }

  /* What the file claims to carry, taken from its own `collections` key where it
   * has one and inferred from its array-valued keys where it does not — files
   * exported before 2026-08-10 have no such key and are still perfectly good. */
  const declared: string[] = Array.isArray(parsed.collections)
    ? (parsed.collections as unknown[]).filter((x): x is string => typeof x === 'string')
    : Object.keys(parsed).filter((k) => Array.isArray(parsed[k]));

  const skipped = declared
    .filter((c) => !known.has(c))
    .map((c) => ({ collection: c, items: Array.isArray(parsed[c]) ? parsed[c].length : 0 }));

  const fileVersion = typeof parsed.version === 'number' ? parsed.version : null;
  const versionNote =
    fileVersion !== null && fileVersion > DB_VERSION
      ? `this file was written by a NEWER version of the app (file ${fileVersion}, this build ${DB_VERSION}). ` +
        (skipped.length
          ? `What it carried that this build has no place for is listed as skipped and was NOT imported.`
          : `Everything in it was recognised, but a newer schema can also change what a field MEANS — ` +
            `check the values that came back rather than assuming them.`)
      : null;

  return { added, replaced, skipped, versionNote };
}

/* ===========================================================================
 * SESSION CONFIG — the working setup, so a refresh does not rebuild the shop
 * ===========================================================================
 *
 * Founder, 2026-08-09: *"When I refresh the browser all config should stay!"*
 *
 * 🔴 THIS IS NOT A CONVENIENCE FEATURE AND MUST NOT BE BUILT AS ONE. The values
 * below set depth of cut, spindle speed, rapid height, tab retention and probe
 * behaviour. An operator who does not know the numbers on screen came from last
 * session cannot check them, and a stale or half-valid setup restored under a
 * fresh-looking form is exactly the failure this lane exists to prevent. Three
 * rules follow from that, and all three are enforced here rather than promised:
 *
 *   1. NOTHING IS RESTORED THAT CANNOT BE VALIDATED. A machine, tool or
 *      material that no longer exists, a number that is not a number, a field
 *      the schema does not know — dropped, defaulted, and NAMED to the operator.
 *      Silently substituting a default is the one outcome that is forbidden:
 *      it is indistinguishable, on screen, from the value having been restored.
 *   2. THE BLOB IS VERSIONED AND A MISMATCH RESTORES NOTHING. A depth-per-pass
 *      read field-for-field out of a schema this build does not understand is
 *      worse than an empty form, because an empty form is obviously empty.
 *   3. THE RESTORE IS ANNOUNCED. `App.tsx` renders what came back and what did
 *      not. A silent restore is a lie of omission about where the numbers on
 *      the panel came from.
 *
 * WHY localStorage, when the collections above are deliberately IndexedDB.
 * The reason is the opposite of the reason up there and just as load-bearing:
 * localStorage is SYNCHRONOUS, so every `useState` initialiser in `App.tsx` can
 * read the restored value before the first paint. An asynchronous restore
 * renders the DEFAULTS and then replaces them a tick later — and a machining
 * panel that shows `4 mm` and then flips to `12 mm` has just shown the operator
 * a number that was never their setting. The size objection does not apply
 * either: what is stored here is scalars, enums and a handful of clamp
 * rectangles, and the one thing that could be megabytes — the drawing — is
 * stored as a NAME, resolved back out of the IndexedDB collection above.
 *
 * 🔴 WHAT IS DELIBERATELY NOT STORED, and why each one is a decision:
 *   - `confirmedClear` — the operator's attestation that they LOOKED AT THE BED.
 *     Restoring it would assert, in this session, that somebody checked the bed
 *     in this session. Nobody did. The clamp geometry comes back so it does not
 *     have to be retyped; the statement that a human looked does not.
 *   - `plant` — a plant is a deliberate defect and four of them post a runnable
 *     program. A restored plant is a plant path leaking into a real job, which
 *     this lane's own rule forbids in as many words.
 *   - `job` — a gate fixture, off the operator surface. Restoring one would put
 *     a toolpath on screen for a part the user never supplied.
 *   - `sectionZ` — the Z a mesh is sliced at is a statement about ONE solid, and
 *     nothing here can establish that the restored bytes are that solid. Dropped,
 *     which hands the choice back to the core — which sections at mid-height and
 *     SAYS IT CHOSE. A restored Z would be a section nobody chose for this load,
 *     labelled as one somebody did.
 *   - `extraTools` — an arbitrary JSON tool file whose rows drive feed and rpm.
 *     Validating it here would mean a second copy of the core's tool rules in
 *     TypeScript, which is the duplication this app has spent its life removing.
 *     The COUNT is stored instead, purely so the loss can be REPORTED by number
 *     rather than discovered at the machine.
 */

/** Exported so the browser suite asserts against the SAME key the app writes.
 *  A test carrying its own copy of this string passes happily after a rename. */
export const SESSION_KEY = '2bee.app.session';

/**
 * Bump when a field is renamed, changes units, or changes MEANING.
 *
 * ⚠ Nothing enforces this. It is a human act, and a schema change that forgets
 * it is a stored blob reinterpreted field-for-field by a build that means
 * something else by the same key — the exact failure the version exists to stop.
 * That residual is named here rather than papered over; the mitigation is that
 * every field is bounds-checked on the way back in, so a reinterpreted value
 * still has to be plausible for its NEW field to survive.
 */
export const SESSION_VERSION = 3;
/* 🔴 2 -> 3, 2026-08-11: `zZeroTop` KEPT ITS NAME AND CHANGED ITS MEANING.
 *
 * Until today the key was inert — measured, not assumed: the pre-rebuild wasm
 * bundle emitted BYTE-IDENTICAL G-code for `true` and `false`, so the toggle
 * reached no coordinate. The Z-datum work landed and the bundle was rebuilt, and
 * the same two settings now differ: safe Z `5.000` -> `17.000`, surface `0.000`
 * -> `12.000` — the workpiece thickness.
 *
 * So a session stored while the key meant NOTHING would come back meaning
 * SOMETHING, and the operator who zeroes on the workpiece top as they always
 * have would be one workpiece thickness out on every cut, with nothing on screen
 * disagreeing with them.
 *
 * The bump is the whole fix, because the mismatch path below already refuses to
 * restore field-by-field for exactly this reason: a name surviving a schema
 * change says nothing about the meaning surviving it. An empty form is obviously
 * empty; a form full of numbers that meant something else is not.
 *
 * ⚠ Adding keys does NOT bump this — the spoilboard fields were added today
 * without one, correctly, because a new key changes no existing meaning. This
 * bumps because a MEANING moved under an unchanged name. */

const SESSION_KIND = '2bee.app session config';

/* 🔴 BUMPED TO 2 ON 2026-08-10, and a bump RESTORES NOTHING by design.
 *
 * `drawing: {origin, name} | null` became `drawings: DrawingRef[]`, and
 * `partX`/`partY` — one sheet-wide offset — were removed in favour of a
 * placement per drawing. A v1 blob read field-for-field by this build would
 * restore a sheet with no drawings on it while the banner said the setup came
 * back, and the two fields it still recognised would be a placement for a part
 * that is not there. An empty form is obviously empty; that would not have
 * been. */

export interface DroppedField {
  /** The state key, as `App.tsx` names it. */
  field: string;
  /** Said to the operator, in the banner. Names the thing, never just "invalid". */
  reason: string;
}

/**
 * Where a loaded drawing came from. Decides how it is resolved on the way back.
 *
 * 🔴 THERE IS NO `'cad'` ORIGIN, AND THAT IS A DECISION — 2026-08-10, founder:
 * *"in the 1st tab (cad) we should able to save the cad files in the same list
 * as drawings"*. A model designed in `2bee.cad` is saved into the `drawings`
 * collection above and comes back as **`'saved'`**, like anything else the user
 * put there. The reasons, in order of how much they cost to get wrong:
 *
 *   1. **AN ORIGIN IS A LOOKUP ROUTE, NOT A PROVENANCE.** Every value in this
 *      union answers exactly one question — *where do I go to get the bytes
 *      back?* `'sample'` reads `SAMPLES`, `'mesh-sample'` fetches an asset,
 *      `'file'` cannot be resolved at all. A CAD model is resolved by
 *      `load('drawings', name)`: the same call, the same key, the same object
 *      store as a `'saved'` drawing. A second tag over one route means two ids
 *      resolving to one record — and `App.tsx` already REWRITES a stored
 *      `'file'` tag to `'saved'` on read for precisely this reason: *where it
 *      came FROM stops mattering the moment it is in the store; where it is NOW
 *      is the only thing a reload can act on.* A `'cad'` origin would
 *      reintroduce the defect that comment records having removed.
 *   2. **IT WOULD COST A SESSION-SCHEMA BUMP FOR NOTHING.** The origin list is
 *      validated in `check()` below, and a `drawings` entry with an unknown
 *      origin fails the WHOLE list — so a blob written with `'cad'` and read by
 *      any build that predates it comes back as an empty sheet. Reusing
 *      `'saved'` means `SESSION_VERSION` does not move, every stored session
 *      keeps restoring, and the multi-select restore path needs no new branch.
 *   3. **WHAT IS CAD-SPECIFIC IS A PROPERTY OF THE RECORD, NOT OF ITS ADDRESS.**
 *      The source, the checksums, the audit verdict and the missing constructs
 *      travel INSIDE the stored value (`SavedCadDrawing.cad` in
 *      `cad/record.ts`), where `isCadRecord()` finds them on the row that
 *      actually holds them. A tag on the reference could only ever say that
 *      such a record was expected — and a reference that promises a property the
 *      record may not have is a green nobody checked.
 */
export type DrawingOrigin = 'sample' | 'mesh-sample' | 'file' | 'saved';

export interface DrawingRef {
  /**
   * 🔴 **THE INSTANCE, not the drawing.** Founder 2026-08-10: *"Drawing: Able to
   * add more than 1 from the same drawing"* — two copies of one file are TWO
   * parts with TWO placements, and anything keyed on `origin:name` collapses
   * them into one. The collapse is the quiet kind: the second copy vanishes, or
   * both share a placement and move together, or a restore de-duplicates them
   * and the operator loses a part they placed.
   *
   * It is also the name the emitted program calls this part —
   * `<instance>/<part>` — so it is human-readable on purpose: a refusal naming
   * `d2/part1` is a refusal about a part the operator cannot find on screen.
   */
  instance: string;
  /** WHAT to cut. Several instances may point at the same one. */
  origin: DrawingOrigin;
  name: string;
  /**
   * Where the operator put this drawing ON THE SHEET, as a DELTA from where it
   * was drawn, in sheet millimetres. `[0, 0]` is AS DRAWN.
   *
   * 🔴 Validated per FIELD like every other field here — which is not the same
   * as being restored per ENTRY: a bad offset fails the whole `drawings` key,
   * per `check()`. Per-entry dropping happens in `App.tsx`'s restore loop, one
   * layer up, and only for content that cannot be RESOLVED. It is `signed`
   * rather than
   * bounded to the sheet: a part can legitimately be dragged to a negative sheet
   * coordinate, off the near edge of the board. The CORE refuses what that
   * produces — travel, keepout, or the note that it is past the sheet edge and
   * therefore unsimulated. A bound here would be this file deciding a machining
   * question, which the header forbids. What it stops is `NaN`, `Infinity` and
   * parse wreckage reaching a coordinate.
   */
  offset_mm: [number, number];
  /**
   * Degrees anticlockwise about the drawing's own lower-left corner.
   *
   * 🔴 NOT bounded to the four quarter turns the SHEET rotation offers, and the
   * difference is deliberate: a sheet is registered against the machine's axes
   * and a part is not, so a part at 37 degrees is a real placement the core
   * plans and WARNS about. Bounding it here would silently discard a placement
   * the core accepts, and the panel would come back reading 0 for a part the
   * operator turned.
   */
  rotation_deg: number;
}

/** Everything written. `App.tsx` owns the values; this module owns their shape. */
export interface SessionValues {
  travelX: number;
  travelY: number;
  travelZ: number;
  safeZ: number;
  colletMm: number;
  spindleMax: number;
  probeEnabled: boolean;
  touchPlateMm: string;
  touchPlateId: string;
  supportsArcs: boolean;
  /* ── THE SPOILBOARD DECLARATION ────────────────────────────────────────────
   *
   * 🔴 ADDED 2026-08-11 (TODO #89). These seven keys were MISSING, so a reload
   * silently reverted the board to UNDECLARED. That is not a convenience
   * defect: with no board declared the core reports
   * `spoilboard_position_checked: false` and every below-the-workpiece cut is
   * judged on DEPTH ALONE — *over the sacrificial board* and *into the machine
   * frame* then read identically (terminology §9, S1).
   *
   * ⚠ It failed in the SAFE direction — reverting to UNCHECKED costs a false
   * pending, never a false green — which is exactly why nobody reading the
   * panel noticed for as long as they did.
   *
   * 🔴 ALL SIX ARE STRINGS AND MUST STAY STRINGS. `''` is NOT ENTERED and `'0'`
   * is a measured zero, and the core acts on them differently — `0,0` is a
   * plausible corner that slides the declared board toward the datum and turns
   * bare rail into declared spoilboard. A `number` type here collapses the two
   * answers into the dangerous one. Same rule, same reason, as `touchPlateMm`.
   *
   * ⚠ NOT VALIDATED AGAINST THE BOARD CATALOGUE HERE, and that is a decision.
   * The catalogue comes from the CORE over the wasm boundary (`spoilboardCatalogue()`),
   * and an id the core does not hold is already refused BY THE CORE, loudly, in
   * its own words — the `SPOILBOARD NOT INSTALLED` note the panel renders
   * verbatim. A second catalogue check in TypeScript would be a second copy of
   * a machining fact, which is the duplication this app has spent its life
   * removing, and it could only ever disagree with the authority.
   */
  spoilboardId: string;
  spoilboardX: string;
  spoilboardY: string;
  spoilboardSizeX: string;
  spoilboardSizeY: string;
  /**
   * 🔴 **THE ONLY FIELD IN THIS GROUP WHOSE EMPTY VALUE ARMS A CHECK.** The five
   * around it decide WHERE a rectangle is; this one decides whether *"did the
   * cutter go through the board and into the machine?"* can be ASKED at all.
   * `''` ⇒ the core's `thickness_mm` is `None` ⇒ `sim::BoardDepth` reports
   * `board-depth-unknown`, which is PENDING and is not a pass.
   *
   * ⚠ ADDING THIS KEY DOES NOT BUMP {@link SESSION_VERSION}, and the rule it
   * follows is the one stated at that constant: a NEW key changes no existing
   * meaning, so an older blob simply has no thickness and reads back as *"not
   * declared"* — which is where every session already was. The bump is for a
   * MEANING moving under an unchanged name, which is not what this is.
   */
  spoilboardThickness: string;
  spoilboardName: string;
  /**
   * 🔴 A MISSING KEY RESTORES AS `'assumed'`, NEVER `'entered'`. `'entered'`
   * means a human measured the corner and typed it; manufacturing that out of
   * an absent key would launder this app's own arithmetic through a flag that
   * means somebody looked. Absence is handled by the rule failing to restore
   * anything, which leaves `App.tsx`'s `?? 'assumed'` opening default in place.
   */
  spoilboardPos: 'assumed' | 'entered';
  /**
   * 🔴 THE TRAVELS THE POSITION WAS SET AGAINST — the fingerprint that arms
   * {@link spoilboardForMachine} on the way back in.
   *
   * X and Y are MACHINE coordinates. They mean *"this corner, measured from
   * THIS machine's datum"*, so restoring them onto a machine with a different
   * reach is a rectangle in the wrong place presented as a measurement. The
   * session stores the travels too, so in the ordinary case this matches and
   * the position survives — but the two can come apart, and that is the case
   * worth catching: a travel that FAILS its own rule is dropped to a default
   * while the board's corner sails through, and the corner then means a
   * different place than it did.
   *
   * ⚠ OPTIONAL, and absent means "unknown machine", which
   * {@link readSpoilboard} treats as a MISMATCH rather than as fine. A session
   * written before this key existed carries a corner nobody can vouch for.
   */
  spoilboardTravels?: [number, number, number];
  stockX: number;
  stockY: number;
  thickness: number;
  zZeroTop: boolean;
  originX: number;
  originY: number;
  rotation: number;
  /** Multi-workpiece — TODO #64. Absent in single-workpiece sessions. */
  workpieces?: Array<{
    stockX: number; stockY: number;
    originX: number; originY: number;
    rotation: number;
  }>;
  activeWorkpiece?: number;
  depthPerPass: number;
  rpm: number;
  entry: string;
  direction: string;
  dogbone: string;
  tabsEnabled: boolean;
  tabHeight: number;
  tabWidth: number;
  tabSpacing: number;
  finishAllowance: number;
  leadMm: number;
  probeAfterChange: boolean;
  clamps: ClampCfg[];
  workholdingId: string;
  /** Multi-type work holding — TODO #63. Absent in older sessions. */
  workholdingIds?: string[];
  dark: boolean;
  simCell: number;
  /** Validated against the TOOL LIBRARY, which arrives asynchronously — see below. */
  material: string;
  /** Same. */
  toolIds: string[];
  /**
   * REFERENCES, in the order they were added. The bytes live in the `drawings`
   * collection or in the bundle; only the name and the placement are stored.
   *
   * 🔴 A LIST since 2026-08-10, because the sheet holds more than one drawing.
   * It was a single `{origin, name}`, and that is why multi-select was REFUSED
   * when the merged picker landed: a second drawing could have been held in
   * memory and would have been dropped on refresh **with nothing to say so** —
   * an operator returning to a one-part program that had been a two-part one.
   *
   * ⚠ An empty list and a dropped list are different facts. `[]` restores as "no
   * drawings", which is what a fresh app has; an entry that fails validation is
   * dropped BY NAME into the banner, never silently.
   */
  drawings: DrawingRef[];
  /** Not the tools. The COUNT, so the drop can be reported rather than noticed. */
  extraToolsCount: number;
}

/** The fields validated here at read time — everything except the two that need
 *  the tool library and are therefore done in a second pass. */
type BaseKey = Exclude<keyof SessionValues, 'material' | 'toolIds'>;

/*
 * 🔴 THESE BOUNDS ARE NOT MACHINING LIMITS AND MUST NOT BE READ AS ANY.
 *
 * The question a bound here answers is *"could a control in this app have
 * produced this value"* — never *"is this safe to cut"*. Every machining
 * judgement stays in the core, which refuses. What these stop is a corrupted,
 * hand-edited or foreign blob putting `NaN`, `Infinity`, a negative diameter or
 * a megabyte of string into a field the panel then renders and the core then
 * plans from.
 *
 * Where a control declares its own limit the bound is THAT number and nothing
 * else (`sim-cell` has `min={0.2}`; the rotation select offers four values).
 * Where a control declares none, the bound is `ABSURD` — which expresses no
 * machine, no material and no opinion, and exists only to reject infinities and
 * parse wreckage. Do not tighten one of these into a safety limit; a safety
 * limit that lives in the browser is a rule no gate can see.
 */
const ABSURD = 1e6;

type Rule =
  | { t: 'bool' }
  /** finite, and > 0. A travel, a diameter, a depth: zero is not a setting. */
  | { t: 'pos' }
  /** finite, and >= 0. An allowance or a lead-in may legitimately be zero. */
  | { t: 'nonneg' }
  /** finite, either sign. A datum offset. */
  | { t: 'signed' }
  | { t: 'enum'; of: readonly (string | number)[] }
  /** `''` (NOT DECLARED) or a string holding a finite number >= 0. See below. */
  | { t: 'blank-or-number-string' }
  /**
   * `''` (NOT DECLARED) or a string holding a finite number of EITHER SIGN.
   *
   * 🔴 The sign is the whole point of the separate rule. A spoilboard corner is
   * a MACHINE coordinate and is legitimately negative — a 2400×1200 board fitted
   * to a 1250×670 machine sits at `-575, -265` — so the non-negative rule above
   * would drop a perfectly good measured corner and report the board as
   * position-not-entered. Under-declaring costs a false red, but a false red
   * manufactured by a bound in the browser is one nobody can act on.
   */
  | { t: 'blank-or-signed-number-string' }
  /** `''` (none chosen) or a member of a shipped catalogue. */
  | { t: 'catalogue'; ids: readonly string[]; what: string }
  /**
   * Any string this app's own controls could have produced, bounded in LENGTH
   * only. For a value whose vocabulary lives on the other side of the wasm
   * boundary and is therefore not checkable here — see the note on
   * `spoilboardId`. It rejects parse wreckage and a megabyte of text; it
   * asserts nothing about meaning, and does not pretend to.
   */
  | { t: 'text'; max: number }
  | { t: 'clamps' }
  | { t: 'drawings' }
  /** Three finite positive millimetre travels, as `[x, y, z]`. */
  | { t: 'travels' }
  /** finite, >= 0, and an integer. */
  | { t: 'count' }
  | { t: 'min'; min: number }
  /** Pass-through: any value is accepted. For optional complex objects. */
  | { t: 'any' };

const RULES: Record<BaseKey, Rule> = {
  travelX: { t: 'pos' },
  travelY: { t: 'pos' },
  travelZ: { t: 'pos' },
  safeZ: { t: 'pos' },
  colletMm: { t: 'pos' },
  spindleMax: { t: 'pos' },
  probeEnabled: { t: 'bool' },
  /* 🔴 EMPTY AND ZERO ARE DIFFERENT ANSWERS, and the round trip must keep them
   * different. `App.tsx` holds this as a STRING for that reason: `''` is NOT
   * DECLARED, which the core refuses on, and `0` is a measured "no plate, I am
   * probing the work directly". A rule that coerced this to a number would turn
   * "I did not say" into "I measured nothing there" — reintroducing, in the
   * restore path, precisely the assumption core decision #43 removed. */
  touchPlateMm: { t: 'blank-or-number-string' },
  touchPlateId: { t: 'catalogue', ids: TOUCH_PLATES.map((p) => p.id), what: 'touch plate' },
  supportsArcs: { t: 'bool' },
  /* The board. See the field notes on `SessionValues` — every one of these is a
   * STRING because `''` (not entered) and `'0'` (a measured zero) are different
   * answers the core acts on differently, and the two position fields are
   * SIGNED because a machine coordinate legitimately is. */
  spoilboardId: { t: 'text', max: 200 },
  spoilboardX: { t: 'blank-or-signed-number-string' },
  spoilboardY: { t: 'blank-or-signed-number-string' },
  spoilboardSizeX: { t: 'blank-or-number-string' },
  spoilboardSizeY: { t: 'blank-or-number-string' },
  /* `blank-or-number-string`, NOT the signed rule the corner uses: a corner can
   * legitimately be negative (a board hanging past the datum) and a thickness
   * cannot. A rule that admitted `-18` would restore a depth the core reads as
   * unusable, which is a third state — somebody typed a thickness and it is not
   * one — rather than the honest blank. */
  spoilboardThickness: { t: 'blank-or-number-string' },
  spoilboardName: { t: 'text', max: 200 },
  /* 🔴 The two values the panel offers, and nothing else. An unknown word is
   * DROPPED, which leaves `App.tsx`'s opening `'assumed'` standing — the same
   * outcome as a missing key, and the only honest one: `'entered'` is a claim
   * that a human measured this corner, and a blob cannot make that claim on a
   * human's behalf. */
  spoilboardPos: { t: 'enum', of: ['assumed', 'entered'] },
  spoilboardTravels: { t: 'travels' },
  stockX: { t: 'pos' },
  stockY: { t: 'pos' },
  thickness: { t: 'pos' },
  zZeroTop: { t: 'bool' },
  originX: { t: 'signed' },
  originY: { t: 'signed' },
  /* 🔴 `partX`/`partY` WERE HERE and are GONE — 2026-08-10. They stored ONE
   * offset for the whole sheet, and the sheet now holds several drawings, each
   * with its own. Keeping them would have been a stored setting that restores
   * into a field which is a VIEW of the selected drawing — i.e. a value read
   * back, displayed, and consumed by nothing, which is the defect gate B2B4 and
   * gate MOVE both exist for. The placement travels per entry in `drawings`
   * instead, so a drawing comes back WHERE IT WAS. */
  /* The four the `stock-rotation` select offers, and nothing between them. A
   * sheet "laid at 37 degrees" is not a state any control can reach. */
  rotation: { t: 'enum', of: [0, 90, 180, 270] },
  depthPerPass: { t: 'pos' },
  rpm: { t: 'pos' },
  /* The three `EntryMode` values the select offers. Gate ENT found `Helix`
   * silently aliased to `Ramp` in the engine — that is the core's problem and
   * is filed there; what this rule guarantees is only that the string coming
   * back is one the select could have produced, so an unknown mode cannot enter
   * the app through storage and reach the post as a value nothing checked. */
  entry: { t: 'enum', of: ['Ramp', 'Helix', 'Plunge'] },
  direction: { t: 'enum', of: ['Climb', 'Conventional'] },
  dogbone: { t: 'enum', of: ['Corner', 'TBoneX', 'TBoneY', 'None'] },
  tabsEnabled: { t: 'bool' },
  tabHeight: { t: 'pos' },
  tabWidth: { t: 'pos' },
  tabSpacing: { t: 'pos' },
  finishAllowance: { t: 'nonneg' },
  leadMm: { t: 'nonneg' },
  probeAfterChange: { t: 'bool' },
  clamps: { t: 'clamps' },
  workholdingId: { t: 'catalogue', ids: WORKHOLDING.map((w) => w.id), what: 'hold-down' },
  workholdingIds: { t: 'any' },
  dark: { t: 'bool' },
  /* The `sim-cell` control's OWN `min={0.2}`, copied from it and from nowhere
   * else. A finer cell is a bigger height map, not a safer one. */
  simCell: { t: 'min', min: 0.2 },
  drawings: { t: 'drawings' },
  extraToolsCount: { t: 'count' },
  // Multi-workpiece: pass-through. App.tsx validates the shape on restore.
  workpieces: { t: 'any' },
  activeWorkpiece: { t: 'count' },
};

/** A bound on RENDER COST, not on how many hold-downs a bed may carry. A blob
 *  claiming more than this is corrupt, not a busy setup. */
const MAX_CLAMPS = 256;

/** The same kind of bound, for drawings. Not a nesting limit: the core checks
 *  every PAIR of parts, so a sheet of this many drawings is already a check the
 *  browser would not finish. A blob claiming more is corrupt. */
const MAX_DRAWINGS = 64;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= ABSURD ? v : null;
}

/** `null` = the value did not survive; the caller turns that into a named drop. */
function check(rule: Rule, v: unknown): unknown | null {
  switch (rule.t) {
    case 'bool':
      return typeof v === 'boolean' ? v : null;
    case 'pos': {
      const n = num(v);
      return n !== null && n > 0 ? n : null;
    }
    case 'nonneg': {
      const n = num(v);
      return n !== null && n >= 0 ? n : null;
    }
    case 'signed':
      return num(v);
    case 'min': {
      const n = num(v);
      return n !== null && n >= rule.min ? n : null;
    }
    case 'count': {
      const n = num(v);
      return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
    }
    case 'any':
      return v;
    case 'enum':
      return rule.of.includes(v as string | number) ? v : null;
    case 'blank-or-number-string': {
      if (typeof v !== 'string') return null;
      if (v.trim() === '') return '';
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= ABSURD ? v : null;
    }
    case 'blank-or-signed-number-string': {
      if (typeof v !== 'string') return null;
      if (v.trim() === '') return '';
      const n = Number(v);
      /* 🔴 THE STRING IS RETURNED, NOT THE NUMBER. `'0'` and `'0.0'` and `''`
       * must survive as themselves — the panel round-trips this into a text
       * input and the core reads the distinction between blank and zero. */
      return Number.isFinite(n) && Math.abs(n) <= ABSURD ? v : null;
    }
    case 'text': {
      if (typeof v !== 'string') return null;
      return v.length <= rule.max ? v : null;
    }
    case 'travels': {
      if (!Array.isArray(v) || v.length !== 3) return null;
      const out: number[] = [];
      for (const e of v) {
        const n = num(e);
        // A travel of zero is not a machine, and this triple is only ever
        // COMPARED — a wrecked one must not silently equal another wrecked one.
        if (n === null || n <= 0) return null;
        out.push(n);
      }
      return out as [number, number, number];
    }
    case 'catalogue': {
      if (typeof v !== 'string') return null;
      if (v === '') return '';
      return rule.ids.includes(v) ? v : null;
    }
    case 'clamps': {
      if (!Array.isArray(v) || v.length > MAX_CLAMPS) return null;
      const out: ClampCfg[] = [];
      for (const c of v as Record<string, unknown>[]) {
        if (!c || typeof c.name !== 'string') return null;
        const x = num(c.x);
        const y = num(c.y);
        const w = num(c.w);
        const h = num(c.h);
        const z = num(c.height_mm);
        // 🔴 ALL OR NOTHING, and deliberately not per-clamp salvage. These
        // rectangles ARE the keepout gate P7 checks a toolpath against. A
        // partially-restored fixture set is a bed the operator believes is
        // declared and is not, which is worse than an empty one — an empty one
        // still warns on every export.
        if (x === null || y === null || w === null || h === null || z === null) return null;
        if (!(w > 0 && h > 0 && z > 0)) return null;
        out.push({ name: c.name, x, y, w, h, height_mm: z });
      }
      return out;
    }
    case 'drawings': {
      // 🔴 ALL OR NOTHING, and the code below is the rule — read it, not this
      // paragraph's ancestor.
      //
      // ⚠ CORRECTED 2026-08-11. This header used to open *"PER ENTRY, and a bad
      // entry is DROPPED BY NAME rather than taking the whole list with it"*.
      // Every `return null` below takes the WHOLE key, `whyDropped` says so in
      // the operator's words (*"NOTHING from it was restored"*), and the
      // `DrawingRef` doc agrees. The comment was the odd one out — and it is
      // the artefact a reader trusts, so it was the one that had to move.
      //
      // 🔴 THE BEHAVIOUR IS RIGHT, AND THE PER-ENTRY RULE IS REAL — it just
      // lives one layer up. Two different failures, two different answers:
      //
      //   THIS layer validates the stored REFERENCE LIST as a structure — not
      //   an array, over `MAX_DRAWINGS`, an origin outside the enum, a missing
      //   or duplicate `instance`, a non-finite offset. Every one of those is a
      //   CORRUPT BLOB, not a drawing that went away, and the dedup case says
      //   so where it stands. Keeping the readable half of a corrupt blob would
      //   restore a list the operator never wrote — the same argument the
      //   clamps use one case above, where a partially-restored fixture set is
      //   a machine the operator believes is declared and is not.
      //
      //   `App.tsx`'s restore loop resolves each surviving reference to actual
      //   CONTENT, and there a failure is ordinary and expected — a sample not
      //   in this build, a saved record deleted since. That loop drops ONE
      //   entry by name and keeps the rest, in order, and it is right to:
      //   losing four good drawings because a fifth was deleted is worse than
      //   being told which one went.
      //
      // What must never happen at either layer is a SILENT drop, and neither is
      // silent: the caller turns every `null` below into a named line in the
      // banner via `whyDropped`, and the loop above reports per entry.
      if (!Array.isArray(v) || v.length > MAX_DRAWINGS) return null;
      const origins: DrawingOrigin[] = ['sample', 'mesh-sample', 'file', 'saved'];
      const out: DrawingRef[] = [];
      const seen = new Set<string>();
      for (const item of v as Record<string, unknown>[]) {
        const d = item ?? {};
        if (!origins.includes(d.origin as DrawingOrigin)) return null;
        if (typeof d.name !== 'string' || !d.name || d.name.length > 260) return null;
        // 🔴 DEDUPED ON THE INSTANCE, NOT ON THE DRAWING. Two entries pointing
        // at the same file are legitimate — that is the whole point of an
        // instance — but two entries with the same INSTANCE id share operation
        // names, which the core refuses outright and which would make a refusal
        // unable to say which copy it condemned. A blob carrying one is corrupt.
        if (typeof d.instance !== 'string' || !d.instance.trim() || d.instance.length > 300) {
          return null;
        }
        if (seen.has(d.instance)) return null;
        seen.add(d.instance);
        const off = d.offset_mm;
        // 🔴 An ABSENT placement is `[0, 0]` and 0 degrees — AS DRAWN — because
        // that is what every blob written before this field existed meant. A
        // PRESENT but unusable one is a failure, not a default: an operator who
        // turned a part and gets it back square would be looking at a placement
        // nobody chose, which is the whole reason nothing here defaults silently.
        let offset_mm: [number, number] = [0, 0];
        if (off !== undefined) {
          if (!Array.isArray(off) || off.length !== 2) return null;
          const x = num(off[0]);
          const y = num(off[1]);
          if (x === null || y === null) return null;
          offset_mm = [x, y];
        }
        let rotation_deg = 0;
        if (d.rotation_deg !== undefined) {
          const r = num(d.rotation_deg);
          if (r === null) return null;
          rotation_deg = r;
        }
        out.push({
          instance: d.instance,
          origin: d.origin as DrawingOrigin,
          name: d.name,
          offset_mm,
          rotation_deg,
        });
      }
      return out;
    }
  }
}

/**
 * Why a value did not come back, in words the banner can print unchanged.
 *
 * 🔴 NAMES THE THING, never just "invalid". "2 could not be restored" tells the
 * operator nothing they can act on; *"the tool 'X' is no longer in the library"*
 * tells them what to pick and why the panel is not what they left.
 */
function whyDropped(key: BaseKey, rule: Rule, present: boolean, value: unknown): string {
  if (!present) return `the stored settings did not contain "${key}"`;
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
  switch (rule.t) {
    case 'enum':
      return `"${key}" was stored as "${shown}", which this build does not offer (it offers ${rule.of.join(', ')})`;
    case 'catalogue':
      return `the ${rule.what} "${shown}" it named is not in this build's catalogue`;
    case 'text':
      return `"${key}" was stored as something this build cannot read back as text (${rule.max} characters at most)`;
    case 'travels':
      return (
        `the travels "${key}" recorded — the machine the spoilboard's corner was measured on — ` +
        `were stored as ${shown}, which is not three positive millimetre figures. Without them ` +
        `there is nothing to check the corner against, so it is treated as measured on an ` +
        `unknown machine`
      );
    case 'clamps':
      return 'the stored hold-downs did not all carry a name, a position and a positive size';
    case 'drawings':
      return (
        'the stored drawing list was not readable — every entry needs an origin this build ' +
        'knows, a name, and (if present) a finite placement. NOTHING from it was restored, so ' +
        'the workpiece is empty rather than partly the one you left'
      );
    case 'any':
      return `"${key}" was stored as something this build cannot read`;
    default:
      return `"${key}" was stored as "${shown}", which is not a usable number`;
  }
}

export type SessionRead =
  /** Nothing stored. A first visit, or the settings were discarded. NOT a fault. */
  | { status: 'none' }
  /** Something is there and it is not ours, or not JSON. Restore nothing. */
  | { status: 'unreadable'; why: string }
  /** Ours, and written by a schema this build does not read. Restore NOTHING. */
  | { status: 'incompatible'; storedVersion: number | null; why: string }
  | {
      status: 'ok';
      /** ONLY the fields that passed. A key absent here was never restored. */
      values: Partial<SessionValues>;
      restored: BaseKey[];
      dropped: DroppedField[];
      savedAt: number | null;
      /** The unvalidated blob, for the library-bound second pass below. */
      raw: Record<string, unknown>;
    };

/**
 * Read and validate the stored setup.
 *
 * 🔴 Called ONCE per page load, at module scope in `App.tsx`, so every
 * `useState` initialiser sees one consistent snapshot. Reading it per render
 * would let two fields disagree about which session they came from.
 */
export function readSession(): SessionRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch (e) {
    // Storage disabled or partitioned. NOT silent: the app says the settings
    // are not being kept, rather than letting the operator believe they are.
    return { status: 'unreadable', why: `this browser refused to read stored settings: ${e}` };
  }
  if (!raw) return { status: 'none' };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable', why: 'the stored settings are not readable JSON' };
  }
  if (parsed?.kind !== SESSION_KIND) {
    return { status: 'unreadable', why: 'the stored settings were not written by this app' };
  }
  const storedVersion = typeof parsed.version === 'number' ? parsed.version : null;
  if (storedVersion !== SESSION_VERSION) {
    /* 🔴 RESTORE NOTHING. Not "restore the fields whose names still match" —
     * a name surviving a schema change says nothing about the MEANING surviving
     * it, and a depth-per-pass read out of a schema that meant something else by
     * that key is a wrong number wearing a right label. An empty form is
     * obviously empty; this is not. */
    return {
      status: 'incompatible',
      storedVersion,
      why:
        `the stored settings were written by a different version of this app ` +
        `(stored ${storedVersion ?? 'no version'}, this build reads ${SESSION_VERSION}). ` +
        `Nothing was restored: a value read field-for-field out of a schema this ` +
        `build does not understand is worse than an empty form.`,
    };
  }

  const stored = (parsed.values ?? {}) as Record<string, unknown>;
  const values: Partial<SessionValues> = {};
  const restored: BaseKey[] = [];
  const dropped: DroppedField[] = [];

  for (const key of Object.keys(RULES) as BaseKey[]) {
    const rule = RULES[key];
    const present = Object.prototype.hasOwnProperty.call(stored, key);
    // An EMPTY drawing list is a REAL answer — no drawing was loaded — and is
    // not a drop. `check` would return `[]` for it anyway; this is here so the
    // intent survives the next edit to `check`, and so a blob written by the
    // single-drawing schema (`drawing: null`) does not read as a failure it is
    // not. Everything else that fails is named.
    if (key === 'drawings' && present && Array.isArray(stored.drawings) && !stored.drawings.length) {
      values.drawings = [];
      restored.push(key);
      continue;
    }
    const ok = present ? check(rule, stored[key]) : null;
    if (ok === null) {
      // A field simply absent from an older-but-compatible blob is not worth a
      // line in the banner for every key; only a value that WAS there and did
      // not survive is. (A version bump is what covers a shape change.)
      if (present) dropped.push({ field: key, reason: whyDropped(key, rule, present, stored[key]) });
      continue;
    }
    (values as Record<string, unknown>)[key] = ok;
    restored.push(key);
  }

  return {
    status: 'ok',
    values,
    restored,
    dropped,
    savedAt: typeof parsed.saved_at === 'number' ? parsed.saved_at : null,
    raw: stored,
  };
}

/**
 * The second pass: the two fields that can only be checked against the TOOL
 * LIBRARY, which is fetched from the wasm core and is therefore not available
 * when the `useState` initialisers run.
 *
 * 🔴 THIS MUST COMPLETE BEFORE THE FIRST PLAN. A tool id the library does not
 * hold does not fail loudly in the core — `fixtures.rs` takes an
 * `unwrap_or_else` branch and SILENTLY SUBSTITUTES a Ø6mm end mill, then plans
 * feeds, depths and a whole program around a cutter nobody picked. So a restored
 * tool id is never handed to the planner unvalidated; `App.tsx` applies this
 * inside the same load that sets `ready`, and `replan` does nothing until then.
 *
 * ⚠ `selectable` is the CORE's verdict for the collet now fitted, not this
 * module's opinion — a shank rule re-derived in TypeScript would be the third
 * copy of a machining fact in this app.
 */
export function validateLibraryBound(
  raw: Record<string, unknown>,
  tools: { id: string; selectable?: boolean; fit_why?: string }[],
  materials: { name: string }[]
): { toolIds?: string[]; material?: string; restored: string[]; dropped: DroppedField[] } {
  const restored: string[] = [];
  const dropped: DroppedField[] = [];
  const out: { toolIds?: string[]; material?: string } = {};

  if (Object.prototype.hasOwnProperty.call(raw, 'material')) {
    const m = raw.material;
    const hit = typeof m === 'string' && materials.some((x) => x.name === m);
    if (hit) {
      out.material = m as string;
      restored.push('material');
    } else {
      dropped.push({
        field: 'material',
        reason: `the material "${String(m)}" is not in this build's library`,
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'toolIds')) {
    const ids = raw.toolIds;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      dropped.push({ field: 'toolIds', reason: 'the stored tool selection was not a list of names' });
    } else {
      const keep: string[] = [];
      for (const id of ids as string[]) {
        const t = tools.find((x) => x.id === id);
        if (!t) {
          dropped.push({ field: 'toolIds', reason: `the tool "${id}" is no longer in the library` });
        } else if (t.selectable === false) {
          /* Existence is not enough. A tool the collet now fitted cannot hold is
           * a cutter that would be planned with and could not be mounted — and
           * the collet is itself a restored value, so this pairing is exactly
           * what a restore can get wrong. */
          dropped.push({
            field: 'toolIds',
            reason: `the tool "${id}" cannot be held by the collet on this machine — ${
              t.fit_why ?? 'no collet in the shop holds its shank'
            }`,
          });
        } else {
          keep.push(id);
        }
      }
      // An EMPTY surviving set is not written back as a restore: `App.tsx`
      // refuses to plan with no cutter, and reporting "restored 0 tools" beside
      // a panel that says "choose…" reads as success.
      if (keep.length) {
        out.toolIds = keep;
        restored.push(`toolIds (${keep.length})`);
      }
    }
  }

  return { ...out, restored, dropped };
}

/**
 * Write the setup. Returns `null` on success, or the browser's own words.
 *
 * 🔴 A FAILURE IS RETURNED, NEVER SWALLOWED. A quota error or a storage-disabled
 * browser means the operator's settings are NOT being kept, and an app that
 * quietly stopped saving while looking exactly like one that is saving is the
 * silent-green this lane spends its life removing.
 */
export function writeSession(v: SessionValues): string | null {
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ kind: SESSION_KIND, version: SESSION_VERSION, saved_at: Date.now(), values: v })
    );
    return null;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

/* ===========================================================================
 * A JOB FILE — the same setup, portable, and BOUNDED ON PURPOSE
 * ===========================================================================
 *
 * TODO #108, `File → Save job… / Open job…`. The session blob above already
 * survives a reload; this is the copy a shop can keep with the machine or send
 * to somebody else.
 *
 * 🔴 THE ONE HARD LIMIT, AND IT IS STATED AT SAVE TIME RATHER THAN DISCOVERED.
 * `SessionValues` is **not** "everything the planner reads". Three values the
 * planner genuinely uses are deliberately absent from it and must stay absent
 * from a job file, and the reasons are not the same reason:
 *
 *   · `confirmedClear` — the operator's attestation that they LOOKED AT THE BED.
 *     A file that carried it would assert, in somebody else's shop, tomorrow,
 *     that a human checked a machine. Nobody did.
 *   · `useWorkpieceEdge` — whether the part is cut against the material's own
 *     edge. It is a statement about the piece of stock ON THE BED RIGHT NOW; a
 *     restored `true` is a claim about a workpiece nobody has seen.
 *   · `plant` — a deliberate defect, and four of them post a runnable program.
 *     `AGENTS.md` forbids a plant path in a real job in as many words, and a job
 *     file is the one artefact that would carry one between machines.
 *
 * ⇒ **The byte-identical round trip is over {@link SESSION_KEYS} and nothing
 * else.** Everything outside that list is not saved, is listed in the file, and
 * is asked again when the file is opened.
 *
 * 🔴 AND THE BOUND IS ENFORCED BY CONSTRUCTION, NOT BY CARE. {@link encodeJob}
 * PICKS the known keys rather than spreading the object it is given, so a field
 * added to `App.tsx`'s state cannot ride into a file by being spread in, and
 * `tests/job-file.test.ts` plants exactly that: an object carrying
 * `confirmedClear`, `useWorkpieceEdge` and `plant` goes in, and the three must
 * not come out.
 *
 * 🔴 OPENING IS A REFUSE-THEN-REPLACE, IN THAT ORDER. A file this build cannot
 * read is refused BEFORE the stored setup is touched — a check that runs after
 * the destructive step has destroyed the thing it was protecting. What is
 * written is the session blob itself, so the ONE restore path in this app is
 * also the one that reads a job: the reload announces what came back and what
 * did not, by name, exactly as it does for an ordinary session. A second
 * apply-a-job routine would be a second restore with its own validation, and the
 * two would disagree the first time a field changed.
 */

export const JOB_FILE_KIND = '2bee.app job';

/**
 * Bump when the FILE's own envelope changes. It is deliberately separate from
 * {@link SESSION_VERSION}, which versions the values INSIDE it — a job file
 * whose envelope this build understands can still carry a session generation it
 * does not, and those two failures get two different sentences.
 */
export const JOB_FILE_VERSION = 1;

/**
 * Every key a job file carries, and the whole of it.
 *
 * Derived from `RULES` rather than written out, so a field added to
 * {@link SessionValues} is carried automatically and cannot be forgotten — and
 * the two library-bound keys are appended because they are validated in the
 * second pass rather than by a rule.
 */
export const SESSION_KEYS: readonly (keyof SessionValues)[] = [
  ...(Object.keys(RULES) as BaseKey[]),
  'material',
  'toolIds',
];

/**
 * What a job file does NOT carry, in the words the file itself prints.
 *
 * 🔴 IT IS IN THE FILE, not only in this module. The person opening it in six
 * months is holding the artefact, not this source — and a job file that looks
 * complete is precisely the failure the bound exists to prevent.
 */
export const JOB_NOT_SAVED: readonly { field: string; why: string }[] = [
  {
    field: 'confirmedClear',
    why:
      'your confirmation that the machine is clear. It records that somebody LOOKED at the machine, ' +
      'and nobody has looked in the session that opens this file. It is asked again.',
  },
  {
    field: 'useWorkpieceEdge',
    why:
      'whether the part is cut against the material’s own edge. That is a statement about the piece ' +
      'of stock clamped over the spoilboard today, not about this job.',
  },
  {
    field: 'plant',
    why:
      'the deliberate-defect selector. Four plants emit a runnable program; a plant that travelled ' +
      'in a job file is a planted defect arriving on a machine nobody planted it on.',
  },
  {
    /* 🔴 THE BOUND NOBODY WOULD GUESS FROM THE FILE'S SIZE. `SessionValues.drawings`
     * is a list of REFERENCES — an origin and a name — because a DXF is text and a
     * real one runs to megabytes. That is right for a browser session, where the
     * bytes are in IndexedDB two milliseconds away, and it is a trap for a file
     * that leaves this machine: the placements travel, the geometry does not. The
     * restore drops each unresolvable one BY NAME into the banner, so the loss is
     * announced rather than discovered — but it is announced on the other shop's
     * screen, which is why it is also stated here, on ours, at save time. */
    field: 'the drawings themselves',
    why:
      'only their NAMES and where you placed them. A drawing is stored in this browser, not in this ' +
      'file — so opening this job somewhere else restores the placements and reports every drawing ' +
      'it could not find, by name. Send the drawings with it, or export your saved data as well.',
  },
  {
    field: 'job / sectionZ / extraTools',
    why:
      'the gate fixture, the Z a mesh was sectioned at, and an imported tool file. The first is not ' +
      'a drawing, the second is a statement about one solid this file does not carry, and the third ' +
      'is a library whose rows drive feed and rpm — its COUNT is carried so its absence is reported ' +
      'rather than discovered.',
  },
];

export interface JobFileParse {
  status: 'ok';
  /** The session envelope, ready to be written verbatim. Never re-shaped. */
  session: string;
  /** What the file says about itself, for the operator. */
  savedAt: number | null;
}

export type JobRead = JobFileParse | { status: 'refused'; why: string };

/**
 * Write the job.
 *
 * `now` is passed rather than read so a test controls it — the same convention
 * every other write in this file uses.
 */
export function encodeJob(values: SessionValues, now: number): string {
  /* 🔴 PICKED, NEVER SPREAD. A spread would carry whatever the caller's object
   * happens to hold, which is how a field that must never be saved gets saved:
   * not by anybody deciding to, but by a state object growing a key. */
  const picked: Record<string, unknown> = {};
  /* `unknown` first: `SessionValues` NAMES its fields rather than carrying an
   * index signature, deliberately (see its header), so it is not assignable to a
   * bag of strings and TypeScript says so. The double step is the honest way to
   * read a named type by key — and the read is the only thing here that is
   * dynamic; what may be read is the fixed list above. */
  const bag = values as unknown as Record<string, unknown>;
  for (const k of SESSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values, k)) picked[k] = bag[k];
  }
  return JSON.stringify(
    {
      kind: JOB_FILE_KIND,
      version: JOB_FILE_VERSION,
      saved_at: now,
      /* IN THE FILE. See {@link JOB_NOT_SAVED}. */
      not_saved: JOB_NOT_SAVED,
      note:
        'This is a 2bee.app JOB: the setup, not the program. Opening it replaces every panel and ' +
        'reloads, and anything it could not carry is asked again. It is not G-code and it has not ' +
        'been run on a machine.',
      /* The session envelope, byte-for-byte what `writeSession` stores, so
       * opening a job is the ordinary restore rather than a second one. */
      session: { kind: SESSION_KIND, version: SESSION_VERSION, saved_at: now, values: picked },
    },
    null,
    2
  );
}

/**
 * Read a job file — and REFUSE before anything is replaced.
 *
 * ⚠ It validates the ENVELOPE and the session GENERATION only. The values
 * themselves are validated on the way back in by {@link readSession}, which
 * drops a bad field by name into the banner. Re-validating them here would be a
 * second copy of `RULES` that could only ever disagree with the first.
 */
export function parseJobFile(text: string): JobRead {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'refused', why: 'that file is not readable JSON. Nothing was replaced.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 'refused', why: 'that file does not contain a job. Nothing was replaced.' };
  }
  if (parsed.kind !== JOB_FILE_KIND) {
    return {
      status: 'refused',
      why:
        `that file is not a job for this app — it must carry "kind": "${JOB_FILE_KIND}". If it is a ` +
        `saved-data export, open it with Import under Saved data instead. Nothing was replaced.`,
    };
  }
  const version = typeof parsed.version === 'number' ? parsed.version : null;
  if (version === null || version > JOB_FILE_VERSION) {
    return {
      status: 'refused',
      why:
        `that job file was written by a NEWER version of this app (file ${
          version ?? 'no version'
        }, this build reads ${JOB_FILE_VERSION}). Nothing was replaced: a value read out of a ` +
        `schema this build does not understand is worse than the setup you already have.`,
    };
  }
  const session = parsed.session as Record<string, unknown> | undefined;
  if (!session || typeof session !== 'object' || session.kind !== SESSION_KIND) {
    return {
      status: 'refused',
      why: 'that job file carries no setup this app recognises. Nothing was replaced.',
    };
  }
  /* 🔴 THE GENERATION IS CHECKED HERE, EVEN THOUGH `readSession` CHECKS IT TOO.
   * It has to be: `readSession` runs AFTER the reload, by which time the
   * operator's own setup has already been overwritten by one that will restore
   * nothing. Refusing now costs a sentence; refusing later costs their setup. */
  if (session.version !== SESSION_VERSION) {
    return {
      status: 'refused',
      why:
        `that job holds settings written by a different version of this app (job ${
          typeof session.version === 'number' ? session.version : 'no version'
        }, this build reads ${SESSION_VERSION}). Nothing was replaced — opening it would have ` +
        `discarded the setup you have now and restored nothing in its place.`,
    };
  }
  return {
    status: 'ok',
    session: JSON.stringify(session),
    savedAt: typeof parsed.saved_at === 'number' ? parsed.saved_at : null,
  };
}

/**
 * Put a parsed job where the ordinary restore will find it. Returns `null` on
 * success, or the browser's own words.
 *
 * 🔴 THE CALLER RELOADS. Writing without reloading would leave the panels
 * showing the OLD setup over a stored NEW one — the state where what is on
 * screen and what is stored disagree, and nothing says which is which.
 */
export function installJob(parsed: JobFileParse): string | null {
  try {
    localStorage.setItem(SESSION_KEY, parsed.session);
    return null;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

/** Whether this browser is holding a stored setup at all. Drives the enabled
 *  state of `File → Discard`: an item that forgets nothing is a dead control. */
export function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) !== null;
  } catch {
    /* Storage refused. Nothing is stored that this app could discard, and the
     * refusal is already reported by `readSession`. */
    return false;
  }
}

/** Forget the stored setup. The operator's escape hatch from a bad restore. */
export function clearSession(): string | null {
  try {
    localStorage.removeItem(SESSION_KEY);
    return null;
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

/* ===========================================================================
 * CAD MODELS — the same list as drawings, because they ARE drawings
 * ===========================================================================
 *
 * Founder 2026-08-10: *"in the 1st tab (cad) we should able to save the cad
 * files in the same list as drawings"*.
 *
 * The record shape, what it carries, what it refuses and why is all in
 * `cad/record.ts` — read its header before changing anything here. This section
 * is only the two calls that put one in the store and take one out, and the one
 * rule they add:
 *
 * 🔴 A RECORD THAT DOES NOT VERIFY IS NOT WRITTEN, AND IS NOT HANDED BACK
 * WITHOUT ITS VERDICT. The verification is a checksum pair proving the stored
 * mesh is an evaluation of the stored source. Checking it only in the CAD tab
 * would put the guard on the surface that cannot be the one that matters — what
 * cuts is the CNC tab, days later, through the generic drawings path. So the
 * check sits at the store boundary, where every route in and out goes past it.
 */

/**
 * Write a CAD model into the `drawings` collection.
 *
 * 🔴 FAILS CLOSED. A record whose checksums do not re-derive is refused rather
 * than stored with a flag: at this point the caller still has the model on
 * screen and can save it again, whereas a stored inconsistent record is a part
 * somebody picks later with no way to tell what it is. The only way to produce
 * one is a bug in the builder or a hand-edited object, and both are things that
 * should stop here.
 *
 * ⚠ Saving over an existing name REPLACES it, exactly as `save()` does for every
 * other collection. That is deliberate and is the founder's expectation for the
 * other object types; what the CALLER owes the user is telling them the name is
 * taken BEFORE they press it. `CadTab` does that; this function will not
 * second-guess a name the user confirmed.
 */
export async function saveCadModel(rec: SavedCadDrawing, now: number): Promise<void> {
  const v = verifyCadRecord(rec);
  if (v.status !== 'ok') {
    throw new Error(
      `this model was NOT saved — ${v.why} A record whose mesh cannot be shown to belong to its ` +
        'source is one the CNC tab would cut without knowing what it is.'
    );
  }
  await save<SavedCadDrawing>('drawings', rec.name, rec, now);
  // Notify other hooks (like the drawing picker) that the collection changed.
  // The `useSaved` hook refreshes on mount but not on cross-component writes.
  window.dispatchEvent(new CustomEvent('store-changed', { detail: { collection: 'drawings' } }));
}

/**
 * Read one back, with its verification.
 *
 * The verification is returned rather than thrown on, because a stale record is
 * still worth SHOWING — the source is in it, the user can reopen and re-save,
 * and deleting their work to protect them from it would be the worse trade. The
 * contract is that a caller cannot get the record without also getting the
 * verdict, so there is no path on which the check is skipped by omission.
 *
 * `null` when there is no such drawing, or when the one there is not a CAD
 * model — an ordinary saved DXF is not a failure, it is a different thing.
 */
export async function loadCadModel(
  name: string
): Promise<{ item: SavedItem<SavedCadDrawing>; verification: CadVerification } | null> {
  const rec = await load<unknown>('drawings', name);
  if (!rec || !isCadRecord(rec.data)) return null;
  const item = rec as SavedItem<SavedCadDrawing>;
  return { item, verification: verifyCadRecord(item.data) };
}

/* ===========================================================================
 * SPOILBOARDS — a board, and where it is bolted
 * ===========================================================================
 *
 * Founder 2026-08-10: *"when I edit able to save the spoil board … "*.
 *
 * 🔴 A SAVED SPOILBOARD IS TWO FACTS WITH DIFFERENT LIFETIMES, AND ONLY ONE OF
 * THEM TRAVELS. The BOARD — which catalogue entry it is, its size, the name the
 * operator gave a measured one — is a property of the object and is true
 * wherever it goes. Its POSITION is `x`/`y` in the MACHINE's coordinates: it
 * means "this corner, measured from THIS machine's datum". Restore that onto a
 * different machine and you have a rectangle in the wrong place, presented as a
 * measurement, feeding the keepout the simulator checks a toolpath against. The
 * failure is not an error message: it is a program that passes the spoilboard
 * check because the board it was checked against is not where the board is.
 *
 * So the record carries the TRAVELS of the machine it was measured on, and
 * {@link readSpoilboard} DROPS THE POSITION BY NAME when they differ. The board
 * still comes back — the operator does not have to re-pick it — and the position
 * returns to "not entered", which is the state the core already treats as
 * unchecked and warns about on every export. A safe existing state is reached by
 * dropping, not by inventing one.
 *
 * ⚠ AND THE MATCH IS NOT AN IDENTITY. Two machines of the same model in one shop
 * have the same travels and may have their boards bolted in different places, so
 * a match cannot prove this is the same machine — it can only prove a mismatch
 * is a different one. That asymmetry is why a match returns a PROVENANCE line
 * (what it was measured against, and when) rather than a green: a reassurance
 * printed on every restore is a reassurance nobody reads by the third time.
 */

/**
 * What the `spoilboards` collection holds.
 *
 * The five string fields mirror `App.tsx`'s own state exactly, including the
 * fact that they are STRINGS. `''` is NOT ENTERED and `'0'` is a measured zero,
 * and those are different answers the core acts on differently — a number type
 * here would collapse them, which is the defect the `touchPlateMm` rule below
 * exists to prevent for the plate.
 */
export interface SavedSpoilboard {
  /** Catalogue id, or the app's measured-board sentinel. `''` is no board. */
  id: string;
  /** Machine coordinates, mm, as typed. `''` = not entered. MACHINE-BOUND. */
  x: string;
  y: string;
  /** Only meaningful for a measured board. `''` = not entered. */
  sizeX: string;
  sizeY: string;
  /**
   * 🔴 **HOW THICK, AND `''` IS THE LOAD-BEARING VALUE.** The core's
   * `Spoilboard::thickness_mm` is an `Option<f64>` and `None` is what makes
   * `sim::BoardDepth` report `board-depth-unknown` — PENDING, not a pass — for
   * *"did the cutter go through the board and into the machine?"*. So an empty
   * string here must survive as an empty string all the way to the wasm
   * boundary, where the key is OMITTED rather than sent as a number.
   *
   * ⚠ It is a STRING for the same reason the five above are, and the reason
   * matters more here than anywhere else in this record: `Number('')` is `0`,
   * and `0` is not *"nobody declared a thickness"* — it is a board with no
   * depth, which answers the question favourably by accident. A `number` field
   * here collapses the undeclared case into the one that reads as safe.
   *
   * ⚠ OPTIONAL, because records written before 2026-08-11 have no such key.
   * Absent reads back as `''`, which is the honest state: nobody said.
   */
  thickness?: string;
  /** What the operator called a board this lane has never seen. */
  name: string;
  /**
   * 🔴 The travels of the machine the POSITION was measured on. A fingerprint,
   * not an identity — see the section header. Optional because a record written
   * before this field existed has none, and the honest reading of an absent
   * fingerprint is "unknown machine", which is treated as a mismatch.
   */
  machine_travels_mm?: [number, number, number];
}

export interface SpoilboardRead {
  /** Always present. The board itself; safe anywhere. */
  values: Omit<SavedSpoilboard, 'machine_travels_mm'>;
  /** Named drops, in the same shape and the same spirit as the session restore. */
  dropped: DroppedField[];
  /** Where the position came from, when it survived. `null` when it did not. */
  provenance: string | null;
}

/**
 * Apply a saved spoilboard to the machine that is set up NOW.
 *
 * Pure, so it can be tested without a browser, and so the caller decides what to
 * do with a drop rather than this module deciding for them.
 */
export function readSpoilboard(
  rec: SavedSpoilboard,
  currentTravelsMm: [number, number, number],
  savedAt: number
): SpoilboardRead {
  const board = {
    id: typeof rec.id === 'string' ? rec.id : '',
    x: typeof rec.x === 'string' ? rec.x : '',
    y: typeof rec.y === 'string' ? rec.y : '',
    sizeX: typeof rec.sizeX === 'string' ? rec.sizeX : '',
    sizeY: typeof rec.sizeY === 'string' ? rec.sizeY : '',
    /* 🔴 ANYTHING THAT IS NOT A STRING BECOMES `''`, WHICH IS *"NOT DECLARED"*.
     * The tempting `String(rec.thickness)` turns a stored `18` into `'18'` and a
     * stored `null` into the string `'null'`; the first looks like a kindness
     * and the second is a thickness of NaN that the panel would print. Absence,
     * a number, a `null` and a wrecked value all land on the one answer the core
     * treats as PENDING — the safe direction, and the only one nobody typed. */
    thickness: typeof rec.thickness === 'string' ? rec.thickness : '',
    name: typeof rec.name === 'string' ? rec.name : '',
  };

  const hadPosition = board.x !== '' || board.y !== '';
  const saved = rec.machine_travels_mm;
  const same =
    Array.isArray(saved) &&
    saved.length === 3 &&
    saved.every((v, i) => Number.isFinite(v) && v === currentTravelsMm[i]);

  if (!hadPosition) {
    return { values: board, dropped: [], provenance: null };
  }
  if (same) {
    return {
      values: board,
      dropped: [],
      provenance:
        `this position was measured on a machine with travels ` +
        `${saved!.join(' × ')} mm on ${new Date(savedAt).toLocaleString()}. Those are the travels set ` +
        `now — but identical travels are not proof of the same machine, and a board bolted to a ` +
        `different machine of the same model is somewhere else. Check the corner before you cut.`,
    };
  }
  return {
    values: { ...board, x: '', y: '' },
    dropped: [
      {
        field: 'spoilboardPosition',
        reason: saved
          ? `the board's position was measured on a machine with travels ${saved.join(' × ')} mm and ` +
            `this machine has ${currentTravelsMm.join(' × ')} mm. X and Y are MACHINE coordinates, so ` +
            `they mean a different corner here — they were NOT carried over and the board is back to ` +
            `"position not entered", which the core reports as unchecked rather than assuming.`
          : `this board was saved without recording which machine its position was measured on, so ` +
            `there is nothing to check it against. X and Y are MACHINE coordinates and were NOT ` +
            `carried over; re-enter them for this machine.`,
      },
    ],
    provenance: null,
  };
}

/* ---------------------------------------------------------------------------
 * ARMING THE GUARD — the one call both doors go through
 * ---------------------------------------------------------------------------
 *
 * 🔴 UNTIL 2026-08-11 {@link readSpoilboard} HAD ZERO PRODUCTION CALLERS. A
 * definition, four test call sites and a `spoilboards` collection nothing wrote
 * or read — *a guard armed only by its own test* (TODO #88). The check itself
 * was correct; nothing asked it anything.
 *
 * There are TWO doors into the same defect and they are the same defect:
 *
 *   1. **THE MACHINE CHANGES UNDER A DECLARED BOARD.** The machine picker set
 *      travel X/Y/Z and touched neither the corner, the size, nor the
 *      provenance flag — measured, zero spoilboard references in that handler.
 *      A 2400×1200 board fitted for a 1250×670 machine (corner `-575,-265`)
 *      then reported `past: 0` on a 6090 — rendered as *"none — the board covers
 *      the whole reach"* — where the honest 6090 declaration on the same job
 *      gives **2204 frame-strike cells**. 2204 becomes a silent zero on one
 *      preset click.
 *   2. **THE SESSION IS RESTORED.** The stored corner is a MACHINE coordinate
 *      and the travels it was measured against can fail their own rule and be
 *      defaulted while the corner sails through.
 *
 * ⚠ **THE DANGEROUS PERMUTATION IS `entered`, NOT `assumed`.** A corner a human
 * measured on machine A stays green on machine B *and provenance says it was
 * measured* — the panel's `'entered'` note is the strongest statement this app
 * makes about a number, and it would be making it about the wrong rectangle.
 *
 * So both doors call THIS, which calls `readSpoilboard`. One check, one place to
 * watch it go red.
 */

/** The board as `App.tsx` holds it, plus the fingerprint the guard needs. */
export interface SpoilboardState {
  id: string;
  x: string;
  y: string;
  sizeX: string;
  sizeY: string;
  /**
   * 🔴 `''` = NOT DECLARED, and it must stay reachable. See
   * {@link SavedSpoilboard.thickness}: the core's `Option<f64>` is what makes
   * the through-the-board check report PENDING instead of clear, and `Number('')`
   * is `0` — a board with no depth, which answers the question favourably by
   * accident. Required here (not optional) so a caller assembling this state has
   * to decide what it holds rather than omit it into a default.
   */
  thickness: string;
  name: string;
  pos: 'assumed' | 'entered';
  /**
   * The travels in effect when the POSITION was last set. `null` = unknown,
   * which {@link readSpoilboard} treats as a mismatch rather than as fine.
   */
  travels: [number, number, number] | null;
}

export interface SpoilboardForMachine {
  /** What the board is on this machine. Apply it wholesale; do not cherry-pick. */
  values: SpoilboardState;
  /** Named, in the same shape and spirit as every other drop in this file. */
  dropped: DroppedField[];
  /** Where the position came from, when it survived. `null` when it did not. */
  provenance: string | null;
}

/**
 * Reconcile a declared board with the machine that is set up NOW.
 *
 * 🔴 THE PROVENANCE FLAG AND THE FINGERPRINT MOVE WITH THE POSITION, and that
 * is the half `readSpoilboard` alone cannot do. When the corner is dropped:
 *
 *   · `pos` goes back to `'assumed'`. Leaving it `'entered'` would print
 *     *"Position entered by you"* over an empty pair of fields — a human's
 *     authority attached to a number that is no longer there. `'assumed'` is
 *     what the panel already renders for a board whose fit could not be
 *     computed, so this lands in a state the UI states honestly.
 *   · `travels` goes to `null`. A stale fingerprint left behind would MATCH the
 *     next time the operator returns to the old machine and hand back a green
 *     for a corner that has since been cleared.
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT DO: it never invents, re-fits or slides a
 * corner. A safe state is reached by DROPPING, never by computing a
 * replacement — `spoilboards.rs`'s rule is that under-declaring costs a false
 * red and over-declaring reaches the machine, and an auto-fit onto an unfamiliar
 * machine is an over-declaration wearing the app's own arithmetic.
 *
 * Pure, so both doors can be driven from node — where `App.tsx` cannot be
 * imported at all.
 */
export function spoilboardForMachine(
  board: SpoilboardState,
  currentTravelsMm: [number, number, number],
  setAt: number
): SpoilboardForMachine {
  const read = readSpoilboard(
    {
      id: board.id,
      x: board.x,
      y: board.y,
      sizeX: board.sizeX,
      sizeY: board.sizeY,
      /* The DEPTH travels with the board and is never machine-bound — a 18mm
       * board is 18mm thick on any machine. Only the CORNER is a machine
       * coordinate, which is why it is the only thing below that can be
       * dropped. */
      thickness: board.thickness,
      name: board.name,
      ...(board.travels ? { machine_travels_mm: board.travels } : {}),
    },
    currentTravelsMm,
    setAt
  );
  const kept = read.values.x !== '' || read.values.y !== '';
  return {
    values: {
      ...read.values,
      /* `SpoilboardRead.values` inherits the field's OPTIONALITY from the stored
       * record, so this narrows it back to the string `SpoilboardState` promises
       * — `readSpoilboard` always sets it, and `?? ''` is the same answer it
       * would have produced. Absence and "not declared" are one value here. */
      thickness: read.values.thickness ?? '',
      /* 🔴 `pos` and `travels` follow the POSITION, not the board. The board
       * itself is safe anywhere; only the corner is machine-bound. */
      pos: kept ? board.pos : 'assumed',
      travels: kept ? board.travels : null,
    },
    dropped: read.dropped,
    provenance: read.provenance,
  };
}

/**
 * The board a restored session describes, reconciled with the travels that are
 * actually in effect after the restore.
 *
 * 🔴 THE TRAVELS PASSED IN ARE THE EFFECTIVE ONES, NOT THE STORED ONES. That is
 * the whole check: in the ordinary case they are the same and the corner
 * survives with a provenance line, and in the case worth catching — a travel
 * that failed its own rule and was defaulted — they differ and the corner is
 * dropped by name rather than restored into a machine it was never measured on.
 *
 * ⚠ A blob with no board reads back as no board. That is not a drop, it is the
 * state a fresh app is in, and it is the state the core reports as UNCHECKED.
 */
export function readSessionSpoilboard(
  values: Partial<SessionValues>,
  effectiveTravelsMm: [number, number, number],
  savedAt: number
): SpoilboardForMachine {
  return spoilboardForMachine(
    {
      id: values.spoilboardId ?? '',
      x: values.spoilboardX ?? '',
      y: values.spoilboardY ?? '',
      sizeX: values.spoilboardSizeX ?? '',
      sizeY: values.spoilboardSizeY ?? '',
      /* A session written before this key existed has no thickness, and absent
       * reads back as NOT DECLARED — the state the core reports as PENDING.
       * Restoring an old blob must never manufacture a depth. */
      thickness: values.spoilboardThickness ?? '',
      name: values.spoilboardName ?? '',
      /* 🔴 `?? 'assumed'`, and it is the same rule as everywhere else in this
       * file: a missing key is not a human's statement. */
      pos: values.spoilboardPos === 'entered' ? 'entered' : 'assumed',
      travels: values.spoilboardTravels ?? null,
    },
    effectiveTravelsMm,
    savedAt
  );
}

/* ===========================================================================
 * OPERATIONS — a cutting setup, saved and picked from a list
 * ===========================================================================
 *
 * Founder 2026-08-10: *"operation needs a list so I can pick an operation
 * (setting) from the list"*.
 *
 * WHAT AN OPERATION IS HERE, exactly, because the word is broad: the numbers
 * that decide HOW the material is removed — depth per pass, spindle speed, entry
 * mode, cut direction, dogbone style, finish allowance, lead-in, and the tab
 * settings. Every field is already a `SessionValues` key and is reused from
 * there rather than re-declared, so a rename cannot make the two disagree.
 *
 * WHAT IT IS NOT, and each omission is a decision:
 *   · NOT the machine (travels, collet, probe, arcs) — that is a machine, and it
 *     has its own collection.
 *   · NOT the sheet, the material or the datum — that is a workpiece, same.
 *   · NOT `probeAfterChange` — probing between tool changes is a property of the
 *     machine's routine and its touch plate, not of how deep this pass goes.
 *   · NOT the tool SELECTION. See below; this is the one that can hurt.
 *
 * 🔴 THE TOOL IS RECORDED AND IS NOT APPLIED, AND APPLYING THE NUMBERS OVER A
 * DIFFERENT TOOL REQUIRES SAYING SO.
 *
 * Depth per pass, RPM and the whole feed calculation are derived FROM the
 * cutter — the core refuses to plan without one. So a setup saved with a 6 mm
 * two-flute and recalled while a 3 mm cutter is fitted is a set of numbers
 * computed for a tool that is not in the spindle: it plans, it posts, and the
 * first thing that tells you is the cutter. The two available answers were to
 * bind the tool into the record and re-select it on apply, or to record it and
 * refuse to hand the numbers over quietly.
 *
 * Binding loses, and not narrowly. Selecting a tool is a claim that somebody has
 * FITTED that tool. A control labelled "operation" that silently changes which
 * cutter the program is written for makes the panel agree with the program while
 * both disagree with the spindle — and the operator has no reason to look,
 * because they changed a setting, not a tool. A mismatch that stops and names
 * both cutters is recoverable; a silent re-selection is the same class of defect
 * as a restored `confirmedClear`.
 *
 * So {@link readOperation} REFUSES to return the numbers when the tool set
 * differs, and the caller must ask again with an explicit acknowledgement. That
 * is a gate rather than a hope: there is no argument shape in which a caller
 * gets the numbers by accident.
 */

/** The `SessionValues` keys an operation is made of. One list, used by the type
 *  and by the reader, so a field cannot be added to one and not the other. */
export const OPERATION_FIELDS = [
  'depthPerPass',
  'rpm',
  'entry',
  'direction',
  'dogbone',
  'finishAllowance',
  'leadMm',
  'tabsEnabled',
  'tabHeight',
  'tabWidth',
  'tabSpacing',
] as const;

export type OperationField = (typeof OPERATION_FIELDS)[number];

/** The numbers themselves — literally a slice of `SessionValues`. */
export type OperationValues = Pick<SessionValues, OperationField>;

/** What the `operations` collection holds. */
export interface SavedOperation extends OperationValues {
  /**
   * 🔴 THE TOOLS THESE NUMBERS WERE CHOSEN FOR. Provenance, not a selection: it
   * is what makes a mismatch detectable, and nothing here ever applies it. An
   * empty list means the operation was saved with no tool selected, which the
   * app does not otherwise allow and is therefore treated as unknown.
   */
  toolIds: string[];
  /**
   * The material they were chosen for, same status. Feeds are material-dependent
   * too, and an operation carried from ply to aluminium is as wrong as one
   * carried from a 6 mm cutter to a 3 mm one — it is reported in the same
   * sentence rather than given a second gate, because the operator's decision is
   * the same decision.
   */
  material: string;
}

export type OperationRead =
  | { status: 'ok'; values: OperationValues; note: string | null }
  | {
      status: 'tool-mismatch';
      why: string;
      savedToolIds: string[];
      currentToolIds: string[];
      /** 🔴 The numbers are NOT here. Call again with `acceptToolMismatch`. */
    };

/**
 * Apply a saved operation to the setup that exists NOW.
 *
 * @param acceptToolMismatch a sentence recording WHY the operator is applying
 *        numbers computed for another cutter. Required to get past a mismatch,
 *        and required to be non-empty: a boolean flag would be typed once and
 *        left true, whereas a reason has to be produced at the point of use and
 *        can be put in front of the person before it is accepted.
 */
export function readOperation(
  rec: SavedOperation,
  current: { toolIds: string[]; material: string },
  acceptToolMismatch?: string
): OperationRead {
  const values = {} as OperationValues;
  for (const k of OPERATION_FIELDS) {
    (values as Record<string, unknown>)[k] = rec[k];
  }

  const saved = [...(rec.toolIds ?? [])].sort();
  const now = [...(current.toolIds ?? [])].sort();
  const sameTools = saved.length > 0 && saved.length === now.length && saved.every((t, i) => t === now[i]);
  const sameMaterial = rec.material === current.material;

  if (!sameTools) {
    const why =
      `these numbers were chosen for ${saved.length ? saved.join(', ') : 'a tool set that was not recorded'}` +
      ` and the tools selected now are ${now.length ? now.join(', ') : 'none'}. Depth per pass, spindle ` +
      `speed and every feed the core derives are properties OF THE CUTTER, so applying them over a ` +
      `different one is planning for a tool that is not in the spindle. Choose the tools this operation ` +
      `was written for, or accept the mismatch deliberately.`;
    if (!acceptToolMismatch || !acceptToolMismatch.trim()) {
      return { status: 'tool-mismatch', why, savedToolIds: saved, currentToolIds: now };
    }
    return {
      status: 'ok',
      values,
      note:
        `APPLIED OVER A TOOL MISMATCH — ${why} Accepted because: ${acceptToolMismatch.trim()}.` +
        (sameMaterial ? '' : ` The material also differs: saved for "${rec.material}", now "${current.material}".`),
    };
  }

  return {
    status: 'ok',
    values,
    note: sameMaterial
      ? null
      : `these numbers were chosen for "${rec.material}" and the workpiece is "${current.material}". Feeds and ` +
        `depth of cut are material-dependent; the cutter matches, the stock does not.`,
  };
}
