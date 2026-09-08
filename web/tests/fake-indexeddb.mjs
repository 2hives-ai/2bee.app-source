// A minimal IndexedDB stand-in, so the store's real code path can be exercised
// without a browser.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 A GREEN HERE IS NOT A GREEN IN A BROWSER, and reading it as one would be
// the exact defect this lane keeps writing down. What is genuinely exercised is
// `store.ts`'s own logic: the name trimming, the blank-name refusal, the
// replace-on-collision key behaviour, the sort in `list`, the collection set,
// the upgrade path that creates a missing object store, and the import/export
// pair. What is NOT exercised is Chrome's IndexedDB — quota, partitioning,
// transaction lifetimes, the `blocked`/`versionchange` dance between two real
// tabs. Those need a browser and belong in `web/e2e/`.
//
// ✅ THE ONE BROWSER BEHAVIOUR THAT IS REPRODUCED FAITHFULLY, because the whole
// CAD record depends on it: values are put through `structuredClone`, which is
// the actual algorithm IndexedDB uses. A fake that stored the object by
// reference would pass happily for a payload the browser cannot store at all,
// and would return the caller's own `Uint8Array` back to them — so a round-trip
// assertion on the STL bytes would be asserting nothing. Cloning is what makes
// "what came back is what went in" a real question.
//
// ⚠ Events fire on a microtask, not synchronously, because `store.ts` assigns
// its handlers AFTER creating each request. A synchronous fake would resolve
// nothing and every call would hang — which is a fake that cannot fail the way
// the real thing does, in the direction that hides bugs.

/**
 * What Chrome throws, close enough to be asserted on. A plain `Error` stringifies
 * as `Error: …`; the real thing stringifies as `VersionError: …`, and `store.ts`'s
 * callers put exactly that string in front of the operator.
 */
class FakeDomException extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.onblocked = null;
  }
  _succeed(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }
  _fail(error) {
    this.error = error;
    queueMicrotask(() => this.onerror?.());
  }
}

class FakeObjectStore {
  constructor(name, data, keyPath) {
    this.name = name;
    this.data = data;
    this.keyPath = keyPath;
  }
  put(value) {
    const req = new FakeRequest();
    const key = value[this.keyPath];
    // The real algorithm. See the header: a by-reference fake proves nothing.
    this.data.set(key, structuredClone(value));
    req._succeed(key);
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    const hit = this.data.get(key);
    req._succeed(hit === undefined ? undefined : structuredClone(hit));
    return req;
  }
  getAll() {
    const req = new FakeRequest();
    req._succeed([...this.data.values()].map((v) => structuredClone(v)));
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.delete(key);
    req._succeed(undefined);
    return req;
  }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    /** name -> Map(key -> value) */
    this.stores = new Map();
    this.keyPaths = new Map();
    this.onversionchange = null;
    this.closed = false;
  }
  get objectStoreNames() {
    const names = [...this.stores.keys()];
    return { contains: (n) => names.includes(n), length: names.length, [Symbol.iterator]: () => names[Symbol.iterator]() };
  }
  createObjectStore(name, opts) {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, opts.keyPath);
    return new FakeObjectStore(name, this.stores.get(name), opts.keyPath);
  }
  transaction(name) {
    if (this.closed) throw new Error('InvalidStateError: the database connection is closing');
    return {
      objectStore: (n) => {
        const data = this.stores.get(n);
        if (!data) {
          // The real failure mode a version bump exists to prevent — see the
          // DB_VERSION comment in store.ts. Reproduced so a test can watch it.
          throw new Error(`NotFoundError: no object store named "${n}"`);
        }
        return new FakeObjectStore(n, data, this.keyPaths.get(n));
      },
    };
  }
  close() {
    this.closed = true;
  }
}

/**
 * Install a fresh fake on `globalThis.indexedDB`.
 *
 * `seed` optionally pre-creates a database at a given version with a given set
 * of object stores, so an UPGRADE can be tested rather than only a fresh open.
 */
export function installFakeIndexedDb(seed) {
  const dbs = new Map();
  if (seed) {
    const db = new FakeDatabase(seed.name, seed.version);
    for (const s of seed.stores) db.createObjectStore(s, { keyPath: 'name' });
    dbs.set(seed.name, db);
  }

  const impl = {
    /** Set to true to make the next open report a blocking older connection. */
    blockNextOpen: false,
    databases: dbs,
    open(name, version) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        if (impl.blockNextOpen) {
          req.onblocked?.();
          return;
        }
        let db = dbs.get(name);
        if (!db) {
          /* ⚠ NO VERSION ON A DATABASE THAT DOES NOT EXIST creates it at 1 and
           * still fires `onupgradeneeded` — the spec's own rule, and the one
           * `store.ts`'s two-step open depends on for a fresh browser. */
          db = new FakeDatabase(name, version === undefined ? 1 : version);
          dbs.set(name, db);
          req.result = db;
          req.onupgradeneeded?.();
        } else if (version === undefined) {
          /* Open at whatever is on disk. No upgrade event, no refusal — this is
           * the branch `store.ts` uses to STOP being bricked by a database some
           * other build took above its own number. */
          req.result = db;
        } else if (version > db.version) {
          db.version = version;
          req.result = db;
          req.onupgradeneeded?.();
        } else if (version < db.version) {
          /* 🔴 THE FOUNDER'S 2026-08-11 FAILURE, REPRODUCED SO A NODE TEST CAN
           * WATCH IT. IndexedDB refuses to open below the on-disk version, and
           * the old `store.ts` asked for a fixed number — so an origin that had
           * ever been taken higher was dead for this build, permanently, in
           * every collection at once. The message is Chrome's own wording. */
          req._fail(
            new FakeDomException(
              'VersionError',
              `The requested version (${version}) is less than the existing version (${db.version}).`
            )
          );
          return;
        }
        /* A reopen is a NEW CONNECTION. The real thing hands back a fresh one;
         * this fake shares the object, so the closed flag has to be cleared or
         * the two-step open would talk to a connection it just closed itself. */
        db.closed = false;
        req._succeed(db);
      });
      return req;
    },
  };

  globalThis.indexedDB = impl;

  /* 🔴 `store.ts` announces a write with `window.dispatchEvent(new
   * CustomEvent('store-changed', …))` so other components refresh — a browser
   * global this harness does not have, and every test exercising the real
   * `saveCadModel` path died on the REFERENCE (`window is not defined`) after
   * the record itself had already saved. Stubbed beside the IndexedDB fake
   * because both are the same thing: the browser surface the store's real
   * code path runs against. The event is a NOTIFICATION, not part of the
   * stored record, so a sink that records nothing loses nothing these tests
   * assert. What a listener does with it — the drawing picker refreshing — is
   * a rendered-component fact and belongs in `web/e2e/`. */
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { dispatchEvent: () => true };
  }

  return impl;
}
