// The "PCB" view of the design page — founder 2026-10-15: *"load all pcbs into
// the design, able to open only with pnp"*. Cards come from the pnp lane's
// `listPcbBoards()` (`pnp/pnpCatalogue.ts`) and carry ONE action, Open in pnp,
// which publishes through `pnp/pnpHandoff.ts` `openInPnp(id)`.
//
// ⚠ LOADED THROUGH `import.meta.glob`, NOT A STATIC IMPORT. When this was written
// the pnp modules were not yet committed; a static import would make this file's
// commit a broken build on origin. The glob resolves to the modules when they
// exist (and bundles them), and to nothing when they do not — which this view
// reports as "PCBs are not available yet", never as an empty list.

import { openInPcb } from '../pcbtab/pcbHandoff';
import { useEffect, useMemo, useState } from 'react';
import type { OpenTarget } from './handoff';
import { PcbViewer } from './PcbViewer';
import { savedPcbPicture } from './pcbThumb';
import { ARCHIVE_TITLE } from './archive';

interface PcbCard {
  id: string;
  name: string;
  detail: string;
  thumbnail?: string;
  /** pcb has retired the board (pnp/retired.ts): label · marker path. */
  retired?: string;
}
interface PnpCatalogue {
  listPcbBoards: () => Promise<PcbCard[]>;
}
interface PnpHandoff {
  openInPnp: (id: string) => void;
}

const catalogueMods = import.meta.glob('../pnp/pnpCatalogue.ts') as Record<string, () => Promise<PnpCatalogue>>;
const handoffMods = import.meta.glob('../pnp/pnpHandoff.ts') as Record<string, () => Promise<PnpHandoff>>;

async function loadPnp(): Promise<{ cat: PnpCatalogue; hand: PnpHandoff } | null> {
  const c = catalogueMods['../pnp/pnpCatalogue.ts'];
  const h = handoffMods['../pnp/pnpHandoff.ts'];
  if (!c || !h) return null;
  const [cat, hand] = await Promise.all([c(), h()]);
  if (typeof cat.listPcbBoards !== 'function' || typeof hand.openInPnp !== 'function') return null;
  return { cat, hand };
}

export type PcbState =
  | { kind: 'loading' }
  | { kind: 'absent'; why: string }
  | { kind: 'ready'; boards: PcbCard[]; open: (id: string) => void };

/** The PCB list, loaded once per mount. Lifted so the page can show its count on the filter. */
export function usePcbBoards(): PcbState {
  const [state, setState] = useState<PcbState>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    loadPnp()
      .then(async (m) => {
        if (!live) return;
        if (!m) {
          setState({ kind: 'absent', why: 'PCBs are not available yet — this build has no pnp board list.' });
          return;
        }
        const boards = await m.cat.listPcbBoards();
        if (live) setState({ kind: 'ready', boards, open: m.hand.openInPnp });
      })
      .catch((e) => live && setState({ kind: 'absent', why: `the PCB list could not be read — ${String(e)}` }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export function PcbShelf({
  state,
  query,
  onOpened,
  onArchive,
}: {
  state: PcbState;
  query: string;
  onOpened: (target: OpenTarget) => void;
  /** Hide a board from the list in this browser (`archive.ts`). pnp's board is not touched. */
  onArchive?: (boardId: string) => void;
}) {
  /* Founder 2026-10-16: "when I am on the design and I click on the pcb I would see the 3d
   * as I can see the cad" — the picture opens the board in 3D (`PcbViewer.tsx`). */
  const [viewing, setViewing] = useState<PcbCard | null>(null);
  const shown = useMemo(() => {
    if (state.kind !== 'ready') return [];
    const q = query.trim().toLowerCase();
    return state.boards.filter((b) => q === '' || b.name.toLowerCase().includes(q) || b.detail.toLowerCase().includes(q));
  }, [state, query]);

  if (state.kind === 'loading') return <p className="shop-note" data-testid="shop-pcb-loading">Reading the PCB list…</p>;
  if (state.kind === 'absent') {
    return (
      <p className="shop-empty" data-testid="shop-pcb-absent">
        {state.why}
      </p>
    );
  }
  if (shown.length === 0) {
    return (
      <p className="shop-empty" data-testid="shop-pcb-no-match">
        {state.boards.length === 0 ? 'The pnp board list is empty.' : `No PCB matches that search. ${state.boards.length} are listed.`}
      </p>
    );
  }
  return (
    <>
      <ul className="shop-grid" data-testid="shop-pcb-grid">
        {shown.map((b) => (
          <li key={b.id} className="shop-card shop-card-split shop-card-pcb" data-testid="shop-pcb-card">
            {/* role="button", not <button>, for the reason ThumbButton gives (DesignViewer.tsx). */}
            <div
              role="button"
              tabIndex={0}
              className="shop-thumb shop-thumb-btn"
              onClick={() => setViewing(b)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  setViewing(b);
                }
              }}
              aria-label={`View ${b.name} in 3D`}
              title={`View ${b.name} in 3D`}
              data-testid={`view-3d-pcb-${b.id}`}
            >
              {/* A picture saved from the board's 3D view (PcbSaveThumb, founder 2026-10-16)
                  replaces the default one, labelled as theirs — as ThumbButton does for designs.
                  Read on every render, so it shows as soon as the viewer closes. */}
              {(() => {
                const saved = savedPcbPicture(b.id);
                return saved ? (
                  <>
                    <img src={saved.dataUrl} alt="" data-testid={`thumb-saved-pcb-${b.id}`} />
                    <span className="shop-thumb-src" aria-hidden="true">
                      your picture
                    </span>
                  </>
                ) : b.thumbnail ? (
                  <img src={b.thumbnail} alt="" />
                ) : (
                  <span className="shop-thumb-none">no picture</span>
                );
              })()}
              <span className="shop-thumb-3d" aria-hidden="true">
                3D
              </span>
            </div>
            <div className="shop-card-body">
              <span className="shop-card-title">{b.name}</span>
              {b.retired ? (
                <span className="shop-card-retired" data-testid={`shop-pcb-retired-${b.id}`} title={b.retired}>
                  {b.retired.split(' · ')[0]}
                </span>
              ) : null}
              <span className="shop-card-stats">{b.detail}</span>
              <span className="shop-card-trust">A circuit board. It opens in pcb or pnp — it is not a cad, cnc or 3d design.</span>
              {onArchive ? (
                <button type="button" className="shop-card-archive" onClick={() => onArchive(b.id)} title={ARCHIVE_TITLE} data-testid={`shop-pcb-archive-${b.id}`}>
                  Archive
                </button>
              ) : null}
            </div>
            <div className="shop-card-actions" role="group" aria-label={`Open ${b.name} in`}>
              <button
                type="button"
                className="shop-card-act"
                data-testid={`shop-pcb-open-pcb-${b.id}`}
                onClick={() => {
                  openInPcb(b.id);
                  onOpened('pcb');
                }}
              >
                Open in pcb
              </button>
              <button
                type="button"
                className="shop-card-act"
                data-testid={`shop-pcb-open-${b.id}`}
                onClick={() => {
                  state.open(b.id);
                  onOpened('pnp');
                }}
              >
                Open in pnp
              </button>
            </div>
          </li>
        ))}
      </ul>
      {viewing ? (
        <PcbViewer
          boardId={viewing.id}
          title={viewing.name}
          detail={viewing.detail}
          onClose={() => setViewing(null)}
          actions={[
            {
              label: 'Open in pcb',
              testId: 'pcb-viewer-open-pcb',
              run: () => {
                setViewing(null);
                openInPcb(viewing.id);
                onOpened('pcb');
              },
            },
            {
              label: 'Open in pnp',
              testId: 'pcb-viewer-open-pnp',
              run: () => {
                setViewing(null);
                state.open(viewing.id);
                onOpened('pnp');
              },
            },
            ...(onArchive
              ? [
                  {
                    label: 'Archive',
                    testId: 'pcb-viewer-archive',
                    run: () => {
                      setViewing(null);
                      onArchive(viewing.id);
                    },
                  },
                ]
              : []),
          ]}
        />
      ) : null}
    </>
  );
}
