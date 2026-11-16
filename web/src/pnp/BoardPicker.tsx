/**
 * The board chooser at the top of the PnP chat — founder 2026-10-15: *"remove
 * the hardcoded drop down for the selection"*. A searchable list of every board
 * DISCOVERED in `hardware/pcb` (`boards.ts`), each with the same thumbnail and
 * detail the Designs page shows (`pnpCatalogue.ts`). Once a board is chosen the
 * list folds to that one row with a Change button, so the chat keeps its room.
 *
 * Rows render from `BOARDS` immediately; thumbnails and details arrive when
 * `listPcbBoards()` has read each CPL. A board whose files will not load still
 * has its row, with the reason as its detail.
 */
import { useEffect, useMemo, useState } from 'react';
import { BOARDS } from './boards';
import { listPcbBoards, type PcbCard } from './pnpCatalogue';

/** The drag payload a board row carries, so it can be dropped on the 3D view. */
export const BOARD_DRAG_TYPE = 'application/x-2bee-pcb';

export function BoardPicker({ value, onChange }: { value: string; onChange(id: string): void }) {
  const [cards, setCards] = useState<Record<string, PcbCard>>({});
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(!value);
  useEffect(() => {
    let live = true;
    void listPcbBoards().then((list) => live && setCards(Object.fromEntries(list.map((c) => [c.id, c]))));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!value) setOpen(true);
  }, [value]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BOARDS.filter((b) => !q || b.id.toLowerCase().includes(q) || (cards[b.id]?.detail ?? '').toLowerCase().includes(q));
  }, [query, cards]);

  const row = (id: string, selected: boolean, onClick: () => void, testid: string) => {
    const c = cards[id];
    return (
      <button
        type="button"
        key={id}
        className={`pnp-board-item${selected ? ' selected' : ''}`}
        data-testid={testid}
        aria-pressed={selected}
        onClick={onClick}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(BOARD_DRAG_TYPE, id);
          e.dataTransfer.setData('text/plain', id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        title="Click to open, or drag onto the 3D view"
      >
        {c?.thumbnail ? <img src={c.thumbnail} alt="" /> : <span className="pnp-board-thumb-empty" aria-hidden="true" />}
        <span className="pnp-board-text">
          <strong>{id}</strong>
          {c?.retired ? (
            <small className="pnp-board-retired" data-testid={`pnp-board-retired-${id}`} title={c.retired}>
              {c.retired.split(' · ')[0]}
            </small>
          ) : null}
          <small>{c ? c.detail.replace(/ · hardware\/pcb\/.*$/, '') : 'reading…'}</small>
        </span>
      </button>
    );
  };

  if (!open && value)
    return (
      <div className="pnp-board-picker" data-testid="pnp-board-picker">
        <div className="pnp-board-current">
          {row(value, true, () => setOpen(true), 'pnp-board-current')}
          <button type="button" className="pnp-board-change" data-testid="pnp-board-change" onClick={() => setOpen(true)}>
            Change
          </button>
        </div>
      </div>
    );

  return (
    <div className="pnp-board-picker" data-testid="pnp-board-picker">
      <input
        type="search"
        className="pnp-board-search"
        placeholder={`Search ${BOARDS.length} boards in hardware/pcb…`}
        aria-label="Search boards"
        data-testid="pnp-board-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pnp-board-list" role="list" data-testid="pnp-board-list">
        {shown.map((b) =>
          row(
            b.id,
            b.id === value,
            () => {
              onChange(b.id);
              setOpen(false);
              setQuery('');
            },
            `pnp-board-item-${b.id}`
          )
        )}
        {shown.length === 0 ? <p className="pnp-card-note">No board matches “{query}”.</p> : null}
      </div>
    </div>
  );
}

export default BoardPicker;
