// CLICK THE BOARD'S PICTURE, TURN THE BOARD — the 3D viewer for a PCB card on
// the Designs page.
//
// Founder 2026-10-16, verbatim: *"when I am on the design and I click on the pcb
// I would see the 3d as I can see the cad"*. Same dialog as `DesignViewer.tsx`
// (the `.dv` box, Esc / backdrop / Close), but the picture is the pnp tab's own
// `BoardView` — pcb's gerber render (`pnp/stackup.ts`) on a board with real
// thickness, pcb's component models (the kicad-cli GLB) or a box per part where
// there is none — fed the way the pnp tab feeds it. NOTHING here renders a board
// a second way: a board that looks wrong here looks wrong in pnp too.
//
// 🔴 WHAT IS SHOWN IS pcb'S FAB OUTPUT DRAWN BY THIS APP, NOT A BUILT BOARD. Where
// there is no gerber render the plate is the extent of the part centres + 3 mm,
// NOT the outline, and the dialog says which of the two it is drawing — a plate
// that silently stood in for an outline would read as the board's real size.
//
// ⚠ The stackup/GLB loading below is the same as `PnpTab.tsx` does inline. It is
// not imported from a shared hook because no committed one exists yet; when one
// does, this becomes a call to it.

import { SINGLE_SIDED, SINGLE_SIDED_LABEL, unexpectedMissing } from '../pnp/singleSided';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Object3D } from 'three';
import { BoardView } from '../pnp/BoardView';
import { BOARDS, loadBoard, type LoadedBoard } from '../pnp/boards';
import { defaultPlacement, modelFromParts } from '../pnp/boardModel';
import { BY_LABEL, boardParts } from '../pnp/parts';
import { loadPartsGlb, loadStackup, stackupIndex, type StackupSides } from '../pnp/stackup';
import { PcbSpec } from '../spec/pcbMount';
import { PcbSaveThumb } from './PcbSaveThumb';
import '../pnp/pnp.css';
import './DesignViewer.css';

export interface PcbViewerAction {
  label: string;
  testId: string;
  run: () => void;
}

export function PcbViewer({
  boardId,
  title,
  detail,
  actions,
  onClose,
}: {
  boardId: string;
  title: string;
  detail: string;
  /** The card's own open actions, repeated in the dialog (Open in pcb / pnp). */
  actions: PcbViewerAction[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /* A real modal, exactly as DesignViewer opens one — including its StrictMode guard:
   * `close` is async, so only a dialog still closed when the event lands unmounts. */
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    const onCloseEv = () => {
      if (!d.open) closeRef.current();
    };
    d.addEventListener('close', onCloseEv);
    return () => {
      d.removeEventListener('close', onCloseEv);
      if (d.open) d.close();
      opener?.focus?.();
    };
  }, []);

  /* The board's files (BOM, CPL, sidecar, .kicad_pcb for hand-fitted positions). */
  const [loaded, setLoaded] = useState<LoadedBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setLoaded(null);
    setLoadError(null);
    const entry = BOARDS.find((b) => b.id === boardId);
    if (!entry) {
      setLoadError(`No board "${boardId}" in hardware/pcb.`);
      return;
    }
    let live = true;
    loadBoard(entry).then(
      (b) => live && setLoaded(b),
      (e) => live && setLoadError(`This board could not be read — ${(e as Error).message}`)
    );
    return () => {
      live = false;
    };
  }, [boardId]);

  const bparts = useMemo(
    () => (loaded ? boardParts({ bom: loaded.bom, cpl: loaded.cpl, sidecar: loaded.sidecar, kicad: loaded.kicad }) : null),
    [loaded]
  );
  const model = useMemo(() => (bparts ? modelFromParts(bparts.parts) : null), [bparts]);
  const machineRefs = useMemo(() => new Set((bparts?.parts ?? []).filter((p) => p.by === 'machine').map((p) => p.ref)), [bparts]);

  /* pcb's gerber render and component models, as the pnp tab loads them. */
  const [stack, setStack] = useState<{ sides: StackupSides | null; why: string } | null>(null);
  const [glb, setGlb] = useState<{ obj: Object3D | null; why: string } | null>(null);
  useEffect(() => {
    setStack(null);
    setGlb(null);
    let live = true;
    void stackupIndex().then(async (idx) => {
      const e = idx?.get(boardId);
      const why = !idx ? 'no gerber render (run npm run pnp:stackup)' : !e ? 'no gerbers for this board' : e.error ? `gerbers could not be rendered: ${e.error}` : '';
      if (why) {
        if (live) setStack({ sides: null, why });
      } else
        loadStackup(boardId).then(
          (sides) => live && setStack({ sides, why: sides ? '' : 'no gerber render' }),
          (err: Error) => live && setStack({ sides: null, why: `gerber render did not load: ${err.message}` })
        );
      if (!e?.parts?.glb) {
        if (live) setGlb({ obj: null, why: e?.parts?.error ?? 'no component models exported for this board' });
      } else
        loadPartsGlb(boardId).then(
          (obj) => live && setGlb({ obj, why: '' }),
          (err: Error) => live && setGlb({ obj: null, why: `models did not load: ${err.message}` })
        );
    });
    return () => {
      live = false;
    };
  }, [boardId]);

  const sides = stack?.sides ?? null;
  const gbox = sides?.entry.box;
  const extent = gbox
    ? { minX: gbox.minX, minY: gbox.minY, maxX: gbox.minX + gbox.w, maxY: gbox.minY + gbox.h }
    : model?.plate ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const at = useMemo(
    () => defaultPlacement({ w: extent.maxX - extent.minX, h: extent.maxY - extent.minY }, null),
    [extent.maxX, extent.minX, extent.maxY, extent.minY]
  );
  const [hot, setHot] = useState<string | null>(null);
  const [modelled, setModelled] = useState(0);
  const describe = (r: string): [string, string][] => {
    const p = bparts?.parts.find((x) => x.ref === r);
    if (!p) return [];
    return [
      ['Value', p.value],
      ['Part', p.mfrPn],
      ['Package', p.pkg],
      ['Side', p.side],
      ['Fitted by', BY_LABEL[p.by]],
    ];
  };

  const state = loadError ? 'failed' : model ? 'ready' : 'loading';

  return (
    <dialog
      ref={ref}
      className="dv"
      aria-labelledby="pcbv-title"
      data-testid="pcb-viewer"
      data-state={state}
      data-board={boardId}
      data-parts={model ? model.parts.length : undefined}
      data-gerber={stack ? (sides ? 'yes' : 'no') : undefined}
      onClick={(ev) => {
        if (ev.target === ref.current) ref.current?.close();
      }}
    >
      <div className="dv-box">
        <header className="dv-head">
          <div>
            <h2 id="pcbv-title" className="dv-title">
              {title}
            </h2>
            <p className="dv-sub">{detail}</p>
            {/* Founder 2026-10-16: the board's functional spec, here as in the pcb tab. */}
            <PcbSpec boardId={boardId} />
          </div>
          <div className="dv-head-acts" style={{ display: 'flex', gap: 8, flex: 'none' }}>
            {actions.map((a) => (
              <button key={a.testId} type="button" className="dv-close" data-testid={a.testId} onClick={a.run}>
                {a.label}
              </button>
            ))}
            <button type="button" className="dv-close" onClick={() => ref.current?.close()} data-testid="pcb-viewer-close" autoFocus>
              Close
            </button>
          </div>
        </header>

        <div className="dv-trust" data-testid="pcb-viewer-trust">
          {stack ? (
            sides ? (
              <span data-testid="pcb-viewer-gerber">
                board = pcb’s gerbers ({sides.entry.source}), outline from Edge_Cuts
                {SINGLE_SIDED[boardId] ? <span> · {SINGLE_SIDED_LABEL}</span> : null}{unexpectedMissing(boardId, sides.entry.missing).length ? <span className="bad"> · missing layers: {unexpectedMissing(boardId, sides.entry.missing).join(', ')}</span> : null}
              </span>
            ) : (
              <span data-testid="pcb-viewer-gerber">{stack.why} · plate = extent of part centres + 3 mm, not the board outline</span>
            )
          ) : (
            <span>reading the gerber render…</span>
          )}
          {model ? <span> · 3D models for {modelled} of {model.parts.length} parts, the rest are boxes</span> : null}
          {glb?.why ? <span className="bad"> · {glb.why}</span> : null}
          <p className="dv-oracle">
            🔴 <strong>Drawn from pcb’s fab files.</strong> This is not a built board. Amber = placed by our machine.
          </p>
        </div>

        <div className="dv-stage">
          {loadError ? (
            <p className="dv-msg dv-msg-bad" role="alert" data-testid="pcb-viewer-failed">
              {loadError}
            </p>
          ) : (
            <>
              <BoardView
                model={model}
                laned={machineRefs}
                hot={hot}
                onHot={setHot}
                at={at}
                stackup={sides}
                partsGlb={glb?.obj ?? null}
                extent={extent}
                describe={describe}
                onModelled={setModelled}
              />
              {/* Founder 2026-10-16: "when I open the pcb in 3d view able to save the thumbnail".
                  The PCB card on the design page shows it in place of the board's picture. */}
              {model ? (
                <div className="dv-thumb-bar dv-thumb-bar-low">
                  <PcbSaveThumb boardId={boardId} scope=".dv-stage" testId="pcb-viewer-save-thumb" />
                </div>
              ) : null}
              {!model ? (
                <div className="dv-msg" role="status" aria-live="polite" data-testid="pcb-viewer-loading" style={{ position: 'absolute', inset: 0 }}>
                  <progress className="dv-bar" aria-label="Reading the board" />
                  <span>Reading {title}…</span>
                </div>
              ) : null}
            </>
          )}
        </div>
        {model ? <p className="dv-hint">Left-drag to move · right-drag (or alt + drag) to rotate · wheel to zoom · Top / Bottom / Flip on the view · Esc to close</p> : null}
      </div>
    </dialog>
  );
}
