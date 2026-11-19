// The "Mine" view of the design page — the user's own saved designs, as cards
// with the same three actions as the catalogue. See `mine.ts` for what is listed
// and what a saved item does NOT carry.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DesignViewer, savedPicture, ThumbButton, useThumbSaves } from './DesignViewer';
import { cachedPicture } from './autoPicture';
import { requestOpenIn, type HandoffTarget, type OpenTarget } from './handoff';
import { designToCnc, recordStandsUp } from './toCnc';
import { ARCHIVE_TITLE } from './archive';
import { listMine, meshFromRecord, mineCnc, mineDesign, mineNote, mineSubject, type MineItem } from './mine';

/** The user's saved items, re-read on every store change. Lifted so the page can show the count. */
export function useMine(): { items: MineItem[] | null; error: string | null } {
  const [items, setItems] = useState<MineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      listMine().then(
        (m) => live && (setItems(m), setError(null)),
        (e) => live && setError(`your saved designs could not be read from this browser's store — ${String(e)}`),
      );
    void read();
    /* A save in cad or cnc while this page is mounted. */
    const onChange = (ev: Event) => {
      const c = (ev as CustomEvent<{ collection?: string }>).detail?.collection;
      if (!c || c === 'drawings') void read();
    };
    window.addEventListener('store-changed', onChange);
    return () => {
      live = false;
      window.removeEventListener('store-changed', onChange);
    };
  }, []);
  return { items, error };
}

export function MineShelf({
  items,
  error,
  query,
  onOpened,
  onArchive,
}: {
  items: MineItem[] | null;
  error: string | null;
  query: string;
  onOpened: (target: OpenTarget) => void;
  /** Hide this saved design from the list in this browser (`archive.ts`). It is NOT deleted from the store. */
  onArchive?: (m: MineItem) => void;
}) {
  const [viewing, setViewing] = useState<MineItem | null>(null);
  /* The drawing-file cards read saved pictures directly; redraw them after a save too. */
  useThumbSaves();
  const [failed, setFailed] = useState<string | null>(null);
  const subject = useMemo(() => (viewing ? mineSubject(viewing) : null), [viewing]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((m) => q === '' || m.title.toLowerCase().includes(q));
  }, [items, query]);

  const open = useCallback(
    (m: MineItem, target: HandoffTarget) => {
      setFailed(null);
      if (target === 'cnc') {
        if (m.verification && m.verification.status !== 'ok') {
          setFailed(`"${m.title}" was NOT sent to cnc — ${m.verification.why} Open it in cad and save it again.`);
          return;
        }
        if (m.rec && recordStandsUp(m.rec)) {
          /* Saved from 2bee.cad as modelled, not laid flat: the cnc tab would section it through
           * its edge. Rebuilt laid flat, as Open in cnc from a design does, under its OWN name:
           * `freeDrawingName` reuses a name holding the same source, which would overwrite this
           * as-modelled record (what Open in 3d prints from) with the laid-flat one. */
          const d = mineDesign(m);
          if (!d) return setFailed(`"${m.title}" was NOT sent to cnc — it is not laid flat and has no source to lay it flat from.`);
          void designToCnc({ ...d, title: `${m.title} (laid flat)` }).then((r) =>
            r.ok ? requestOpenIn('cnc', { id: m.id, title: m.title, cnc: r.cnc }) : setFailed(`"${m.title}" was NOT sent to cnc — ${r.why}`),
          );
          return;
        }
        requestOpenIn('cnc', { id: m.id, title: m.title, cnc: mineCnc(m) });
      } else {
        const d = mineDesign(m);
        if (!d) {
          setFailed(`"${m.title}" has no 2bee.cad source — it opens in cnc only.`);
          return;
        }
        if (target === '3d') {
          /* The saved mesh IS an STL (the record's cache), so nothing is rebuilt. */
          requestOpenIn('3d', { ...d, stl: { name: `${d.title.replace(/[\\/]/g, '_')}.stl`, bytes: m.rec!.bytes, note: 'the mesh saved with this model.' } });
        } else {
          requestOpenIn('cad', d);
        }
      }
      onOpened(target);
    },
    [onOpened],
  );

  if (error) {
    return (
      <p className="shop-failed" role="alert" data-testid="shop-mine-error">
        {error}
      </p>
    );
  }
  if (!items) return <p className="shop-note" data-testid="shop-mine-loading">Reading your saved designs…</p>;
  if (items.length === 0) {
    return (
      <p className="shop-empty" data-testid="shop-mine-empty">
        You have not saved any designs in this browser yet. Change a design in cad and press Save, and it shows here.
      </p>
    );
  }
  return (
    <>
      {failed ? (
        <p className="shop-failed" role="alert" data-testid="shop-mine-failed">
          {failed}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="shop-empty" data-testid="shop-mine-no-match">
          None of your {items.length} saved design{items.length === 1 ? '' : 's'} matches that search.
        </p>
      ) : (
        <ul className="shop-grid" data-testid="shop-mine-grid">
          {shown.map((m) => {
            const can3d = m.rec !== null;
            return (
              <li key={m.id} className={`shop-card shop-card-split shop-card-mine`} data-testid="shop-mine-card">
                {can3d ? (
                  <ThumbButton
                    entry={m}
                    onView={setViewing}
                    fallback={() => cachedPicture(`${m.id}@${m.savedAt}`, () => meshFromRecord(m).parts[0]?.positions ?? null)}
                  />
                ) : (
                  <span className="shop-thumb" style={{ position: 'relative' }}>
                    {savedPicture(m) ? (
                      <>
                        <img src={savedPicture(m)!.dataUrl} alt="" />
                        <span className="shop-thumb-src">your picture</span>
                      </>
                    ) : (
                      <span className="shop-thumb-none">no picture · drawing file</span>
                    )}
                  </span>
                )}
                <div className="shop-card-body">
                  <span className="shop-card-title">{m.title}</span>
                  <span className="shop-card-family">
                    yours · {m.rec ? '2bee.cad model' : `drawing${m.format ? ` (${m.format})` : ''}`} · saved{' '}
                    {new Date(m.savedAt).toLocaleString()}
                  </span>
                  {m.rec ? (
                    <span className="shop-card-stats">
                      {m.rec.cad.solids} solid{m.rec.cad.solids === 1 ? '' : 's'} · {m.rec.cad.triangles} triangles
                    </span>
                  ) : null}
                  {m.rec ? <span className="shop-card-stats">{mineCnc(m).note}</span> : null}
                  <span className="shop-card-trust" title={mineNote(m)}>
                    {mineNote(m)}
                  </span>
                  {onArchive ? (
                    <button
                      type="button"
                      className="shop-card-archive"
                      onClick={() => onArchive(m)}
                      title={ARCHIVE_TITLE}
                      data-testid={`shop-mine-archive-${m.title}`}
                    >
                      Archive
                    </button>
                  ) : null}
                </div>
                <div className="shop-card-actions" role="group" aria-label={`Open ${m.title} in`}>
                  {(['cad', 'cnc', '3d'] as const).map((t) => {
                    const off = t !== 'cnc' && !m.rec;
                    return (
                      <button
                        key={t}
                        type="button"
                        className="shop-card-act"
                        onClick={() => open(m, t)}
                        disabled={off}
                        data-testid={`shop-mine-open-${t}-${m.title}`}
                        title={off ? 'A saved drawing file has no 2bee.cad source.' : `Open ${m.title} in ${t}`}
                      >
                        Open in {t}
                      </button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {subject && viewing ? (
        <DesignViewer entry={subject} onClose={() => setViewing(null)} onArchive={onArchive ? () => onArchive(viewing) : undefined} />
      ) : null}
    </>
  );
}
