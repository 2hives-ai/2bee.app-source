// "ARCHIVE" ON THE DESIGN PAGE — HIDE A CARD FROM THE LIST, IN THIS BROWSER.
//
// Founder 2026-10-16: *"in the design able to archive"*.
//
// 🔴 ARCHIVE IS A LIST OF KEYS, NEVER A DELETION. Nothing here touches cad's
// `.scad` files, pnp's boards, or the user's saved designs in the browser store.
// An archived card is filtered out of All / 3d / cad / pcb / Mine and shown under
// "Archived", where Restore takes its key off the list again. Clearing this
// browser's site data restores everything, and that is the right failure: a lost
// archive list costs the user a re-hide, a lost design would cost them the design.
//
// Keys (one namespace, no collisions between the three kinds):
//   catalogue design → its catalogue path, e.g. `2bee_hive/super_panel_wcnc.scad`
//   saved design     → `mine:<name>` (the `MineItem.id`; the name is the store key)
//   PCB board        → `pcb:<boardId>`
//
// ⚠ A KEY CAN OUTLIVE ITS ITEM — a design cad renamed, a saved design deleted in
// cad. Such keys are kept (not silently dropped) and listed under Archived as
// "no longer listed", so the count on the pill is the length of the list and
// Restore can still clear them.

import { useCallback, useEffect, useState } from 'react';

export const ARCHIVE_STORAGE_KEY = '2bee.app.shop.archived';

/** Longest key kept; a longer string is not a key this page wrote. */
const MAX_KEY = 512;
/** More than this is not a list this page wrote either. */
const MAX_KEYS = 5000;

export const archiveKeyOfEntry = (e: { path: string }): string => e.path;
export const archiveKeyOfMine = (m: { id: string }): string => m.id;
export const archiveKeyOfPcb = (boardId: string): string => `pcb:${boardId}`;

/**
 * The stored value → a clean list. NEVER THROWS: `null`, non-JSON, a non-array,
 * non-string members, empty or over-long strings and duplicates all come back as
 * an empty or shortened list. A corrupt value hides nothing — the safe direction,
 * since the failure it avoids is a design vanishing for a reason nobody can see.
 */
export function parseArchived(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of v.slice(0, MAX_KEYS)) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (t === '' || t.length > MAX_KEY || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // access itself can throw (blocked site data)
  }
}

/** Read the list. Never throws; an unreadable store is an empty list. */
export function readArchived(store: Store | null = defaultStore()): string[] {
  if (!store) return [];
  try {
    return parseArchived(store.getItem(ARCHIVE_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Write the list. `false` when the browser refused (private mode, quota). */
export function writeArchived(keys: readonly string[], store: Store | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(parseArchived(JSON.stringify(keys))));
    return true;
  } catch {
    return false;
  }
}

export function withArchived(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? [...keys] : [...keys, key];
}
export function withoutArchived(keys: readonly string[], key: string): string[] {
  return keys.filter((k) => k !== key);
}

/** Button title, said once so every Archive button says the same thing. */
export const ARCHIVE_TITLE = 'Hide from the list in this browser; nothing is deleted';
export const RESTORE_TITLE = 'Show it in the list again';

export interface Archive {
  keys: string[];
  has: (key: string) => boolean;
  archive: (key: string) => void;
  restore: (key: string) => void;
  /** Set when the browser refused the last write; the change then lasts only until reload. */
  writeFailed: boolean;
}

/** The archive list for the page. Follows other tabs of this browser through `storage` events. */
export function useArchive(): Archive {
  const [keys, setKeys] = useState<string[]>(() => readArchived());
  const [writeFailed, setWriteFailed] = useState(false);

  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === null || ev.key === ARCHIVE_STORAGE_KEY) setKeys(readArchived());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const change = useCallback((f: (k: string[]) => string[]) => {
    setKeys((prev) => {
      const next = f(prev);
      setWriteFailed(!writeArchived(next));
      return next;
    });
  }, []);
  const archive = useCallback((key: string) => change((k) => withArchived(k, key)), [change]);
  const restore = useCallback((key: string) => change((k) => withoutArchived(k, key)), [change]);
  const has = useCallback((key: string) => keys.includes(key), [keys]);
  return { keys, has, archive, restore, writeFailed };
}
