// THE PnP TAB — founder 2026-10-15: *"the pnp should be the same concept (left
// side AI agent, on top select the pcb) below the 3d have the machine"*.
//
//   left   the PnP assistant (PnpChat), with the board picker at its top
//   right  the selected board in 3D (BoardView), every CPL part at its position
//   below  the tray plan, the trays on the machine, and the machine (PnpMachineCard)
//
// The boards are `pcb`'s fab BOM + CPL (+ the Assembly sidecar), read in place
// (`boards.ts`). The plan is the SAME `preflight` the expert view runs, with the
// built-in datasheet tape overrides. The machines are `pnp`'s, cited
// (`pnpMachines.ts`).
//
// 🔴 STILL PLANS TRAYS ONLY. Nothing on this tab talks to a machine, and the
// chat cannot: it may change the board count and the trays, through the tab's
// own check, and nothing else. The history of why the tab is a seat and not a
// feature is in `PnpExpert.tsx`'s header, which is the old page, unchanged and
// reached by `?pnp=expert` (persisted; `?pnp=chat` comes back), as 2bee.cad's
// `?cad=code` is.

import { SINGLE_SIDED, SINGLE_SIDED_LABEL, unexpectedMissing } from './singleSided';
import { useEffect, useMemo, useState } from 'react';
import PnpExpert from './PnpExpert';
import { PnpChat } from './PnpChat';
import { BoardView } from './BoardView';
import { PnpMachineCard } from './PnpMachineCard';
import { BoardPicker, BOARD_DRAG_TYPE } from './BoardPicker';
import { PcbSpec } from '../spec/pcbMount';
import { BY_LABEL, assemblySequence, boardParts, countLine } from './parts';
import { loadPartsGlb, loadStackup, stackupIndex, type StackupSides } from './stackup';
import type { Object3D } from 'three';
import { ComponentList, NO_FILTER, passes, type PartFilter } from './ComponentList';
import { BOARDS, loadBoard, type LoadedBoard } from './boards';
import { modelFromParts, defaultPlacement, placeOnTravel, type BoardPlacement } from './boardModel';
import { assemblyFromSidecar, parseCsv, parseOverrides, preflight, type PreflightResult, type TrayDef, type Vspec } from './manifest';
import { PNP_MACHINES, describePnpMachine, pnpMachineById, DEFAULT_PNP_MACHINE_ID } from './pnpMachines';
import { MAX_TRAYS, mayApplyPnp, type PnpPatch, type PnpSettings } from './pnpAsk';
import { pnpGates, traysFromNeed } from './pnpGates';
import { GatesPanel } from '../gates/GatesPanel';
import { claimPendingPnp, subscribePnp } from './pnpHandoff';
import TAPE_OVERRIDES from './tape-overrides.json';
import { bundledVspec, VSPEC_SOURCE } from './vspec';
import './pnp.css';

/** Prefix of a board id that came from a file drop, not from hardware/pcb. */
const DROPPED = 'dropped:';

export type PnpView = 'chat' | 'expert';
export const PNP_VIEW_KEY = '2bee.app.pnp.view';
export const PNP_BOARD_KEY = '2bee.app.pnp.board';
export const PNP_MACHINE_KEY = '2bee.app.pnp.machine';

export function readPnpView(search: string, stored: string | null): PnpView {
  const q = new URLSearchParams(search).get('pnp');
  if (q === 'expert' || q === 'chat') return q;
  return stored === 'expert' ? 'expert' : 'chat';
}
function initialPnpView(): PnpView {
  try {
    const v = readPnpView(globalThis.location?.search ?? '', globalThis.localStorage?.getItem(PNP_VIEW_KEY) ?? null);
    globalThis.localStorage?.setItem(PNP_VIEW_KEY, v);
    return v;
  } catch {
    return 'chat';
  }
}
function stored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function store(key: string, v: string) {
  try {
    globalThis.localStorage?.setItem(key, v);
  } catch {
    /* Storage blocked: holds for this page only. */
  }
}

const VSPEC: Vspec | string = (() => {
  try {
    return bundledVspec();
  } catch (e) {
    return `Cannot read ${VSPEC_SOURCE}: ${(e as Error).message}`;
  }
})();

/** The same four trays the expert view starts with. */
const DEFAULT_TRAYS: TrayDef[] = [
  { trayId: 'T01', variant: '0402' },
  { trayId: 'T02', variant: '8paper' },
  { trayId: 'T03', variant: '8emb' },
  { trayId: 'T04', variant: '12' },
];

/** The tray plan for a loaded board. The sidecar is joined only when the BOM has
 *  no `Assembly` column of its own — the BOM's column wins in `preflight` anyway,
 *  and a sidecar quirk must not block a board that does not need it. */
export function planBoard(b: LoadedBoard | null, s: PnpSettings): PreflightResult | string | null {
  if (typeof VSPEC === 'string') return VSPEC;
  if (!b) return null;
  const bomHasTier = 'Assembly' in (parseCsv(b.bom)[0] ?? {});
  let assembly = {};
  if (!bomHasTier && b.sidecar) {
    const sc = assemblyFromSidecar(b.sidecar);
    if (sc.problems.length) return `${b.entry.pnsPath}: ${sc.problems.join('; ')}`;
    assembly = sc.map;
  }
  return preflight({
    bomCsv: b.bom,
    cplCsv: b.cpl,
    trays: s.trays,
    boards: s.boards,
    overrides: parseOverrides(TAPE_OVERRIDES),
    vspec: VSPEC,
    assembly,
  });
}

export default function PnpTab() {
  const [view, setView] = useState(initialPnpView);
  /* A board opened from the Designs page (`pnpHandoff.ts`). Claimed here, at the
   * top, so a request lands even while the expert view is showing: it switches
   * to the chat view, where the board is drawn. `n` makes a repeat click of the
   * same board a new request. */
  const [requested, setRequested] = useState<{ id: string; n: number } | null>(() => {
    const id = claimPendingPnp();
    return id ? { id, n: 0 } : null;
  });
  useEffect(
    () =>
      subscribePnp((id) => {
        setRequested((r) => ({ id, n: (r?.n ?? 0) + 1 }));
        setView('chat');
        store(PNP_VIEW_KEY, 'chat');
      }),
    []
  );
  useEffect(() => {
    if (requested && view === 'expert') {
      setView('chat');
      store(PNP_VIEW_KEY, 'chat');
    }
  }, [requested, view]);
  return view === 'expert' ? <PnpExpert /> : <PnpSimple requested={requested} />;
}

function PnpSimple({ requested }: { requested: { id: string; n: number } | null }) {
  const [boardId, setBoardId] = useState<string>(() => {
    const s = requested?.id ?? stored(PNP_BOARD_KEY);
    return s && BOARDS.some((b) => b.id === s) ? s : '';
  });
  const [unknownRequest, setUnknownRequest] = useState<string | null>(null);
  useEffect(() => {
    if (!requested) return;
    if (BOARDS.some((b) => b.id === requested.id)) {
      setBoardId(requested.id);
      setUnknownRequest(null);
    } else setUnknownRequest(`No board "${requested.id}" in hardware/pcb — nothing was opened.`);
  }, [requested]);
  const [loaded, setLoaded] = useState<LoadedBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PnpSettings>({ boards: 1, trays: DEFAULT_TRAYS });
  const [machineId, setMachineId] = useState<string>(() => pnpMachineById(stored(PNP_MACHINE_KEY) ?? DEFAULT_PNP_MACHINE_ID).id);
  const machine = pnpMachineById(machineId);

  useEffect(() => {
    if (boardId.startsWith(DROPPED)) return; // loaded by `dropFiles`, not from hardware/pcb
    store(PNP_BOARD_KEY, boardId);
    setLoaded(null);
    setLoadError(null);
    const entry = BOARDS.find((b) => b.id === boardId);
    if (!entry) return;
    let live = true;
    loadBoard(entry).then(
      (b) => live && setLoaded(b),
      (e) => live && setLoadError(`Could not read this board: ${(e as Error).message}`)
    );
    return () => {
      live = false;
    };
  }, [boardId]);

  const result = useMemo(() => planBoard(loaded, settings), [loaded, settings]);
  /* EVERY BOM part, positioned from the CPL or the .kicad_pcb, tagged by who fits
   * it (`parts.ts`); the tray plan still takes only the machine's (preflight
   * skips the hand tiers by the same Assembly column). */
  const bparts = useMemo(
    () => (loaded ? boardParts({ bom: loaded.bom, cpl: loaded.cpl, sidecar: loaded.sidecar, kicad: loaded.kicad }) : null),
    [loaded]
  );
  const model = useMemo(() => (bparts ? modelFromParts(bparts.parts) : null), [bparts]);
  /* The order the parts go on (founder: "order the components based how those
   * components should be soldered / placed"). */
  const sequence = useMemo(() => (bparts ? assemblySequence(boardId, bparts.parts) : undefined), [bparts, boardId]);

  /* Where the board sits on the machine (founder: "able to drag and drop the pcb
   * on the 3d with mouse"). Centred on the travel when a board loads or the
   * machine changes; a drag asks, `placeOnTravel` keeps it inside. Not used by
   * the tray plan, which has no positions — the status line says so. */
  /* The real board from pcb's gerbers (`stackup.ts`), when generated. */
  const [stack, setStack] = useState<{ id: string; sides: StackupSides | null; why: string } | null>(null);
  useEffect(() => {
    setStack(null);
    if (!boardId || boardId.startsWith(DROPPED)) return;
    let live = true;
    void stackupIndex().then(async (idx) => {
      const e = idx?.get(boardId);
      const why = !idx
        ? 'no gerber render (run npm run pnp:stackup)'
        : !e
          ? 'no gerbers for this board'
          : e.error
            ? `gerbers could not be rendered: ${e.error}`
            : '';
      if (why) return live && setStack({ id: boardId, sides: null, why });
      try {
        const sides = await loadStackup(boardId);
        if (live) setStack({ id: boardId, sides, why: sides ? '' : 'no gerber render' });
      } catch (err) {
        if (live) setStack({ id: boardId, sides: null, why: `gerber render did not load: ${(err as Error).message}` });
      }
    });
    return () => {
      live = false;
    };
  }, [boardId]);
  const sides = stack && stack.id === boardId ? stack.sides : null;

  /* pcb's component models (kicad-cli GLB from the .kicad_pcb's own model refs). */
  const [glb, setGlb] = useState<{ id: string; obj: Object3D | null; why: string } | null>(null);
  useEffect(() => {
    setGlb(null);
    if (!boardId || boardId.startsWith(DROPPED)) return;
    let live = true;
    void stackupIndex().then(async (idx) => {
      const e = idx?.get(boardId)?.parts;
      if (!e?.glb) return live && setGlb({ id: boardId, obj: null, why: e?.error ?? 'no model export (run npm run pnp:stackup)' });
      try {
        const obj = await loadPartsGlb(boardId);
        if (live) setGlb({ id: boardId, obj, why: '' });
      } catch (err) {
        if (live) setGlb({ id: boardId, obj: null, why: `models did not load: ${(err as Error).message}` });
      }
    });
    return () => {
      live = false;
    };
  }, [boardId]);
  const partsGlb = glb && glb.id === boardId ? glb.obj : null;
  const [modelMeta, setModelMeta] = useState<{ id: string; withModel: number; placeholder: number; why: string } | null>(null);
  useEffect(() => {
    let live = true;
    void stackupIndex().then((idx) => {
      const p = idx?.get(boardId)?.parts;
      if (live) setModelMeta(p ? { id: boardId, withModel: p.withModel, placeholder: p.placeholder, why: p.error ?? '' } : null);
    });
    return () => {
      live = false;
    };
  }, [boardId]);
  const modelNote =
    modelMeta && modelMeta.id === boardId ? (
      modelMeta.withModel === 0 ? (
        <span className="bad">pcb’s footprints reference no 3D model for this board</span>
      ) : (
        <>
          {modelMeta.placeholder} of {modelMeta.withModel} models are pcb’s generic box_*.step stand-ins, not the parts’ own CAD
          {glb && glb.id === boardId && glb.why ? <span className="bad"> · {glb.why}</span> : null}
        </>
      )
    ) : null;
  const gbox = sides?.entry.box;
  const extent = gbox
    ? { minX: gbox.minX, minY: gbox.minY, maxX: gbox.minX + gbox.w, maxY: gbox.minY + gbox.h }
    : model?.plate ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const boardNote = sides ? (
    <span data-testid="pnp-board-gerber">
      board = pcb’s gerbers ({sides.entry.source}), outline from Edge_Cuts
      {SINGLE_SIDED[boardId] ? <span> · {SINGLE_SIDED_LABEL}</span> : null}{unexpectedMissing(boardId, sides.entry.missing).length ? <span className="bad"> · missing layers: {unexpectedMissing(boardId, sides.entry.missing).join(', ')}</span> : null}
    </span>
  ) : stack && stack.id === boardId ? (
    <span data-testid="pnp-board-gerber">{stack.why} · plate = extent of part centres + 3 mm, not the board outline</span>
  ) : undefined;

  const travel = machine.travel.x !== null && machine.travel.y !== null ? { x: machine.travel.x, y: machine.travel.y } : null;
  const size = model ? { w: extent.maxX - extent.minX, h: extent.maxY - extent.minY } : { w: 0, h: 0 };
  const [place, setPlace] = useState<BoardPlacement>({ x: 0, y: 0, held: false, fits: true, checked: false });
  useEffect(() => {
    setPlace(defaultPlacement(size, travel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, travel?.x, travel?.y, size.w, size.h]);
  const placeStatus = model ? (
    <>
      Board at X {place.x.toFixed(1)} · Y {place.y.toFixed(1)} mm (lower-left of {gbox ? 'the board outline' : 'the part extent'})
      {place.checked && travel ? ` on the ${travel.x} × ${travel.y} mm travel` : ' · this machine states no travel, so the position is not checked'}
      {!place.fits ? <span className="bad"> · the board is larger than the travel</span> : null}
      {place.held ? <span className="bad" data-testid="pnp-board-held"> · held at the travel edge: parts would be outside</span> : null}
      {' · not used by the tray plan'}
    </>
  ) : null;

  /* Dropping onto the 3D: a board row from the picker (its id), or files. A
   * file named like one of pcb's boards opens THAT board; a dropped CPL (with
   * its BOM, if dropped together) is shown as a one-off board, named as dropped. */
  const dropOnView = async (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(BOARD_DRAG_TYPE);
    if (id && BOARDS.some((b) => b.id === id)) {
      setBoardId(id);
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const stem = (f: File) => f.name.replace(/-(cpl|bom|pns)\.csv$|\.kicad_pcb$/i, '');
    const known = files.map(stem).find((n) => BOARDS.some((b) => b.id === n));
    if (known) {
      setBoardId(known);
      return;
    }
    const cpl = files.find((f) => /cpl.*\.csv$|pos.*\.csv$/i.test(f.name));
    if (!cpl) {
      setLoadError(`Dropped ${files.map((f) => f.name).join(', ')}: not a board of hardware/pcb and no CPL (*-cpl.csv) among them.`);
      return;
    }
    const bom = files.find((f) => /bom.*\.csv$/i.test(f.name));
    const id2 = `${DROPPED}${cpl.name}`;
    setLoaded({
      entry: { id: id2, cplPath: `(dropped) ${cpl.name}`, bomPath: bom ? `(dropped) ${bom.name}` : '(no BOM dropped)', pnsPath: null, kicadPath: null, retired: null },
      cpl: await cpl.text(),
      bom: bom ? await bom.text() : '',
      sidecar: '',
      kicad: '',
    });
    setLoadError(null);
    setBoardId(id2);
  };
  const laned = useMemo(
    () => new Set(result && typeof result !== 'string' ? result.lanes.flatMap((l) => l.refs) : []),
    [result]
  );
  /* The part highlighted in BOTH the list and the 3D, and which side set it (the
   * list scrolls only when the 3D did — scrolling under the pointer that is
   * hovering the list would move the row away from it). */
  const [hot, setHot] = useState<string | null>(null);
  const [modelled, setModelled] = useState(0);
  const [filter, setFilter] = useState<PartFilter>(NO_FILTER);
  const [hotSource, setHotSource] = useState<'list' | 'board'>('list');
  const setHotFrom = (ref: string | null, from: 'list' | 'board') => {
    setHot(ref);
    setHotSource(from);
  };
  useEffect(() => setHot(null), [boardId]);
  const dimmed = useMemo(
    () => new Set((model?.parts ?? []).filter((p) => !passes(p, filter)).map((p) => p.ref)),
    [model, filter]
  );
  const partOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of loaded ? parseCsv(loaded.bom) : [])
      for (const ref of (r.Reference ?? '').split(',').map((x) => x.trim()).filter(Boolean)) m.set(ref, r.Mfr_PN ?? '');
    return m;
  }, [loaded]);
  /* The hover card's rows (founder: "when I hover the mouse on top of a
   * component show it"). */
  const describe = (ref: string): [string, string][] => {
    const p = bparts?.parts.find((x) => x.ref === ref);
    if (!p) return [];
    const lanes = result && typeof result !== 'string' ? result.lanes.filter((l) => l.refs.includes(ref)) : [];
    return [
      ['Value', p.value],
      ['Part', p.mfrPn],
      ['Package', p.pkg],
      ['Side', p.side],
      ['Placed by', BY_LABEL[p.by]],
      ['X / Y / rot', `${p.x.toFixed(2)} / ${p.y.toFixed(2)} mm / ${p.rot}°`],
      ['Tray lane', lanes.length ? lanes.map((l) => `${l.trayId} lane ${l.lane}`).join(', ') : p.by === 'machine' ? 'none' : '—'],
    ];
  };
  const onApply = (patch: PnpPatch) => setSettings((s) => ({ ...s, ...patch }));

  /* ── gates (founder 2026-10-16: the right column, "like the left ai one") ──
   * `pnpGates.ts` decides; the column only shows. The physical confirmation is
   * keyed to THIS job (board, trays, board count, machine): change any of them
   * and the person is asked again. */
  const jobKey = `${boardId}|${JSON.stringify(settings)}|${machineId}`;
  const [loadedKey, setLoadedKey] = useState('');
  const gates = useMemo(
    () =>
      pnpGates({
        boardId,
        loaded: !!loaded,
        loadError,
        parts: bparts,
        plan: result,
        machine: { name: machine.name, travel: { x: machine.travel.x, y: machine.travel.y } },
        board: model ? { w: size.w, h: size.h, x: place.x, y: place.y } : null,
        confirmedLoaded: loadedKey === jobKey,
      }),
    [boardId, loaded, loadError, bparts, result, machine, model, size.w, size.h, place.x, place.y, loadedKey, jobKey]
  );
  const [fixing, setFixing] = useState(false);
  const [fixNotes, setFixNotes] = useState<string[]>([]);
  const [autoAsk, setAutoAsk] = useState<{ nonce: number; text: string } | null>(null);
  useEffect(() => setFixNotes([]), [boardId]);
  /* "Fix with AI" (founder: "automatically fix the issues with the ai agent where
   * possible"). Each fix goes through the path a hand change takes, and the gates
   * re-check it; anything physical is said, never set. */
  const fixPnp = () => {
    setFixing(true);
    const notes: string[] = [];
    try {
      const g = Object.fromEntries(gates.map((x) => [x.id, x]));
      if (g.board?.state === 'FAIL') notes.push(`Board: ${g.board.why}`);
      if (g.cpl?.state === 'FAIL') notes.push('Placement rows: only pcb can export the CPL again; nothing here invents a position.');
      if (g.machine?.state === 'FAIL') notes.push(`Machine: ${g.machine.why} Choose a machine whose travel pnp states.`);
      if (g.travel?.state === 'FAIL') {
        if (travel && model && size.w <= travel.x && size.h <= travel.y) {
          setPlace(defaultPlacement(size, travel));
          notes.push('Board: moved to the centre of the travel.');
        } else notes.push('Board: it is larger than the travel on this machine, so no position fits.');
      }
      if (g.trays?.state === 'FAIL') {
        const cand = result && typeof result !== 'string' ? traysFromNeed(result, MAX_TRAYS) : null;
        const after = cand ? planBoard(loaded, { ...settings, trays: cand }) : null;
        if (cand && mayApplyPnp(result, after)) {
          onApply({ trays: cand });
          const left = after && typeof after !== 'string' ? after.refusals.length : 0;
          notes.push(`Trays: set to ${cand.map((t) => `${t.trayId} ${t.variant}`).join(', ')}, from the plan's own count of lanes needed${left ? `; ${left} problem(s) left` : ''}.`);
          if (left) setAutoAsk({ nonce: Date.now(), text: `Propose tray changes so every machine part has a lane. Remaining: ${(after as PreflightResult).refusals[0].message}` });
        } else {
          setAutoAsk({ nonce: Date.now(), text: `Propose tray changes so every machine part has a lane. ${g.trays.why}` });
          notes.push('Trays: asked the PnP assistant for a tray change (see the chat); it is applied only if the plan gets better.');
        }
      }
      if (g.loaded?.state === 'FAIL') notes.push('Trays loaded, nozzle fitted: only a person at the machine can confirm that.');
    } finally {
      setFixNotes(notes);
      setFixing(false);
    }
  };

  const picker = (
    <div className="pnp-pick">
      <span>Board</span>
      <BoardPicker value={boardId} onChange={setBoardId} />
      {loaded ? (
        <small className="pnp-pick-src" data-testid="pnp-board-sources">
          {loaded.entry.bomPath} · {loaded.entry.cplPath}
          {loaded.entry.pnsPath ? ` · ${loaded.entry.pnsPath}` : ''}
        </small>
      ) : null}
      {unknownRequest ? (
        <small className="bad" data-testid="pnp-board-unknown">
          {unknownRequest}
        </small>
      ) : null}
      {loadError ? (
        <small className="bad" data-testid="pnp-board-error">
          {loadError}
        </small>
      ) : null}
      {/* Founder 2026-10-16: the board's functional spec, as in the pcb tab. A dropped board has none. */}
      {boardId && !boardId.startsWith(DROPPED) ? <PcbSpec boardId={boardId} /> : null}
      {result ? (
        <small className={typeof result !== 'string' && result.exit === 0 ? 'pnp-ok' : 'bad'} data-testid="pnp-plan-verdict">
          {typeof result === 'string'
            ? result
            : `Pick-and-place plan: ${['OK', 'REFUSED', 'COULD NOT RUN'][result.exit]}${
                result.refusals.length ? ` (${result.refusals.length} problem(s), ask me or open Expert)` : ''
              }`}
        </small>
      ) : null}
    </div>
  );

  return (
    <div className="cad-simple pnp-simple" data-testid="pnp-tab" data-view="chat">
      <PnpChat
        context={{ board: boardId, settings, vspec: typeof VSPEC === 'string' ? {} : VSPEC, result, machine: describePnpMachine(machine) }}
        evaluate={(s) => planBoard(loaded, s)}
        onApply={onApply}
        autoAsk={autoAsk}
        picker={picker}
        expert={
          <a href="?pnp=expert" className="pnp-expert-link" data-testid="pnp-to-expert" title="The full pre-flight page: your own BOM/CPL files, tape overrides">
            Expert
          </a>
        }
      />
      <div className="cad-simple-view pnp-right">
        <div className="cad-simple-canvas">
          <BoardView
            model={model}
            laned={laned}
            hot={hot}
            onHot={(r) => setHotFrom(r, 'board')}
            travel={travel}
            at={place}
            onMove={(asked) => setPlace(placeOnTravel(asked, size, travel))}
            onDropBoard={(e) => void dropOnView(e)}
            stackup={sides}
            dimmed={dimmed}
            partsGlb={partsGlb}
            extent={extent}
            describe={describe}
            onModelled={setModelled}
          />
        </div>
        {/* Below the view, not on it (founder: "remove the comments from the 3d
            on the pnp"): one status line, and the rest folded away. */}
        <div className="pnp-about">
          <div className="pnp-about-line" data-testid="pnp-board-pos">
            {model ? placeStatus : boardId ? (loadError ? 'Board not loaded' : `Loading ${boardId}…`) : 'Choose a board on the left, or drop one on the view.'}
          </div>
          {model && model.parts.length ? (
            <details>
              <summary>About this view</summary>
              <div data-testid="pnp-board-legend">
                {boardId.replace(DROPPED, 'dropped ')}: {model.parts.length} parts · <span className="pnp-sw amber" /> has a lane ·{' '}
                <span className="pnp-sw grey" /> no lane · <span className="pnp-sw hand" /> not by our machine (hand / fab / DNP)
              </div>
              <div data-testid="pnp-board-models">
                3D models: {modelled} of {model.parts.length} parts
                {modelled < model.parts.length ? `, ${model.parts.length - modelled} drawn as boxes (no model)` : ''}
                {modelNote ? <> · {modelNote}</> : null}
              </div>
              <div>{boardNote ?? 'plate = extent of part centres + 3 mm, not the board outline'}</div>
              <div>
                Box sizes: {model.sizes.table} by package family, {model.sizes.name} from the package name, {model.sizes.unknown} unknown
                (wireframe).
              </div>
              <div>Left-drag the board to move it · left-drag elsewhere to pan · right-drag (or shift + drag) to rotate · wheel to zoom.</div>
            </details>
          ) : null}
        </div>
        <div className="pnp-below">
          <ComponentList model={model} parts={bparts} countLine={bparts ? countLine(bparts) : ''} partOf={partOf} hot={hot} onHot={(r) => setHotFrom(r, 'list')} scrollToHot={hotSource === 'board'} filter={filter} onFilter={setFilter} sequence={sequence} />
          <PnpMachineCard
            machine={machine}
            picker={
              <select
                data-testid="pnp-machine-select"
                aria-label="Pick-and-place machine"
                value={machineId}
                onChange={(e) => {
                  setMachineId(e.target.value);
                  store(PNP_MACHINE_KEY, e.target.value);
                }}
              >
                {PNP_MACHINES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            }
          />
        </div>
      </div>
      <GatesPanel
        gates={gates.map((g) =>
          g.confirm
            ? { ...g, action: { label: 'I loaded the trays as planned and fitted the nozzle', onClick: () => setLoadedKey(jobKey) } }
            : g
        )}
        storeKey="2bee.app.pnp.gates"
        onFix={fixPnp}
        fixing={fixing}
        fixNotes={fixNotes}
        foot={'Nothing on this tab runs the machine yet; these say what must hold before a job could. "…" means not checked yet, which is not a pass.'}
      />
    </div>
  );
}
