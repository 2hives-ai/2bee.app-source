// The "Archived" view of the design page — founder 2026-10-16: *"in the design
// able to archive"*. Every key on the archive list (`archive.ts`) as a card with
// one action, Restore. Nothing here deletes anything, and nothing here opens a
// design: restore it first, and it is back on its own shelf with its own actions.

import { useMemo } from 'react';
import type { ShopEntry } from './catalogue';
import type { MineItem } from './mine';
import { archiveKeyOfEntry, archiveKeyOfMine, archiveKeyOfPcb, RESTORE_TITLE } from './archive';

interface Row {
  key: string;
  title: string;
  what: string;
  thumb: string | null;
}

export function ArchivedShelf({
  keys,
  entries,
  mine,
  boards,
  query,
  onRestore,
}: {
  keys: readonly string[];
  entries: readonly ShopEntry[];
  /** `null` while the saved designs are still being read. */
  mine: readonly MineItem[] | null;
  /** `null` while the PCB list is loading. */
  boards: readonly { id: string; name: string; detail: string; thumbnail?: string }[] | null;
  query: string;
  onRestore: (key: string) => void;
}) {
  const rows = useMemo(() => {
    const byEntry = new Map(entries.map((e) => [archiveKeyOfEntry(e), e]));
    const byMine = new Map((mine ?? []).map((m) => [archiveKeyOfMine(m), m]));
    const byBoard = new Map((boards ?? []).map((b) => [archiveKeyOfPcb(b.id), b]));
    return keys.map((key): Row => {
      const e = byEntry.get(key);
      if (e) return { key, title: e.title, what: `design · ${e.family} · ${e.path}`, thumb: e.thumb ? `shop/${e.thumb}` : null };
      const m = byMine.get(key);
      if (m) return { key, title: m.title, what: 'yours · saved in this browser', thumb: null };
      const b = byBoard.get(key);
      if (b) return { key, title: b.name, what: `circuit board · ${b.detail}`, thumb: b.thumbnail ?? null };
      /* Not resolved: still loading, or the item is gone (renamed in cad, deleted in cad). Said, not hidden. */
      const loading = (key.startsWith('mine:') && mine === null) || (key.startsWith('pcb:') && boards === null);
      return { key, title: key.replace(/^(mine|pcb):/, ''), what: loading ? 'still loading…' : 'no longer listed — Restore just forgets it', thumb: null };
    });
  }, [keys, entries, mine, boards]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => q === '' || r.title.toLowerCase().includes(q) || r.what.toLowerCase().includes(q));
  }, [rows, query]);

  if (keys.length === 0) {
    return (
      <p className="shop-empty" data-testid="shop-archived-empty">
        Nothing is archived. Archive hides a card from the list in this browser; nothing is deleted.
      </p>
    );
  }
  if (shown.length === 0) {
    return (
      <p className="shop-empty" data-testid="shop-archived-no-match">
        None of the {keys.length} archived item{keys.length === 1 ? '' : 's'} matches that search.
      </p>
    );
  }
  return (
    <>
      <p className="shop-note" data-testid="shop-archived-note">
        Hidden from the other lists in this browser only. Nothing was deleted; Restore puts a card back.
      </p>
      <ul className="shop-grid" data-testid="shop-archived-grid">
        {shown.map((r) => (
          <li key={r.key} className="shop-card shop-card-split shop-card-archived" data-testid="shop-archived-card">
            <span className="shop-thumb">
              {r.thumb ? <img src={r.thumb} alt="" /> : <span className="shop-thumb-none">no picture</span>}
            </span>
            <div className="shop-card-body">
              <span className="shop-card-title">{r.title}</span>
              <span className="shop-card-family">{r.what}</span>
            </div>
            <div className="shop-card-actions" role="group" aria-label={`${r.title}`}>
              <button
                type="button"
                className="shop-card-act"
                onClick={() => onRestore(r.key)}
                title={RESTORE_TITLE}
                data-testid={`shop-restore-${r.key}`}
              >
                Restore
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
