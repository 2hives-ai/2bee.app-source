/**
 * useSaved hook — extracted from App.tsx.
 *
 * Generic hook for managing a collection of user-saved objects in IndexedDB.
 * Handles read, write, delete, and error display.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  save as saveItem,
  list as listSaved,
  remove as removeItem,
  type Collection,
  type SavedItem,
} from '../store';

/** What one collection of the user's own saved objects can do. */
export interface SavedCollection<T> {
  items: SavedItem<T>[];
  note: string;
  /** Write under a name that is NEW to the user. */
  saveAs: (name: string, data: T) => Promise<void>;
  /** Write over a name that already exists. Allowed, and SAID rather than
   *  blocked: a shop renames a machine after a rebuild and expects the name to
   *  follow it. */
  replace: (name: string, data: T) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /**
   * Re-read the collection out of the store.
   *
   * 🔴 FOR WRITES THIS HOOK DID NOT MAKE, and it exists because there is one:
   * `store-import` calls `importAll`, which writes every collection straight
   * into IndexedDB behind all three of these hooks. Measured in the browser
   * console on 2026-08-11: `importAll` resolves, the hook's `items` state is
   * still `[]`, and the picker shows nothing until a manual refresh.
   * `refresh()` is the button that says "I know something changed that you
   * did not see" — and the hook's own `write` path already calls it, so a
   * normal save always lands without the operator pressing anything.
   */
  refresh: () => void;
}

export function useSaved<T>(
  collection: Collection,
  writer?: (name: string, data: T, now: number) => Promise<void>
): SavedCollection<T> {
  const [items, setItems] = useState<SavedItem<T>[]>([]);
  const [note, setNote] = useState('');

  /* 🔴 A READ THAT FAILED IS NOT AN EMPTY COLLECTION, AND THAT IS THE HALF OF
   * THE FOUNDER'S *"save as does not work: Machine"* THAT LIVES IN THIS FILE.
   *
   * `items` stays `[]` when the store cannot be opened, and `[]` renders exactly
   * like a shop that has saved nothing: the picker shows the three shipped
   * presets and no more. On 2026-08-11 that was the whole visible symptom of a
   * database this build could not open at all (`store.ts::open`, generation 4 vs
   * a fixed 3) — every collection dead, every write refused, and the machine
   * list looking merely new. `Save as` was correctly wired the entire time; it
   * was writing into a door that would not open.
   *
   * ⚠ SO THE FAILURE SAYS WHAT IT COSTS, not just what threw. `String(e)` alone
   * gave the operator `VersionError: The requested version (3) is less than the
   * existing version (4)` next to a list that looked fine — a true sentence with
   * no consequence attached, which is why it read as noise beside a picker that
   * appeared to be working. It now says the list is INCOMPLETE, which is the
   * fact that changes what the operator does next.
   */
  const refresh = useCallback(() => {
    listSaved<T>(collection)
      .then(setItems)
      .catch((e) =>
        setNote(
          `THIS LIST IS INCOMPLETE — the browser's local store could not be READ, so anything you ` +
            `saved is missing from the list rather than absent from your shop, and a save now would ` +
            `fail the same way: ${String(e instanceof Error ? e.message : e)}`
        )
      );
  }, [collection]);
  useEffect(refresh, [refresh]);

  /* 🔴 A FAILED WRITE IS SHOWN, never swallowed — the same rule the session
   * blob follows. A browser that refused the write looks identical to one that
   * accepted it until the operator comes back and the machine is not there. */
  const write = useCallback(
    async (name: string, data: T, verb: string) => {
      try {
        if (writer) await writer(name, data, Date.now());
        else await saveItem(collection, name, data, Date.now());
        setNote(`${verb} "${name}"`);
        refresh();
      } catch (e) {
        setNote(String(e instanceof Error ? e.message : e));
      }
    },
    [collection, refresh, writer]
  );

  const saveAs = useCallback((n: string, d: T) => write(n, d, 'saved'), [write]);
  const replace = useCallback((n: string, d: T) => write(n, d, 'replaced'), [write]);
  const remove = useCallback(
    async (name: string) => {
      try {
        await removeItem(collection, name);
        setNote(`deleted "${name}"`);
        refresh();
      } catch (e) {
        setNote(String(e instanceof Error ? e.message : e));
      }
    },
    [collection, refresh]
  );

  return { items, note, saveAs, replace, remove, refresh };
}
