// THE pcb TAB — founder 2026-10-16: *"create a new pcb tab (left is ai assistant,
// have the 3d pcb view, right all gates (migrate all gates from local disk)"*.
//
//   left    the pcb assistant: board picker on top, a chat that ANSWERS questions
//           about the board from what this tab loaded. It edits nothing.
//   centre  the board in 3D — the pnp tab's `BoardView` (gerber stackup, part
//           bodies, orbit, Top / Bottom / Flip), fed by `pnp/useBoard3d.ts`.
//   right   `GatesPanel`: pcb's gates for this board, READ from disk records
//           (`pcbGates.ts`, collected by `npm run pcb:gates`) plus gates derived
//           from the fab files. Nothing of pcb's is run from here.
//
// 🔴 READ-ONLY. hardware/pcb is the `pcb` lane's; this tab reads its fab files,
// board file and gate records and writes none of them. A FAIL here is a ticket to
// pcb, not something this tab can fix — so there is no "Fix with AI" button.

import { SINGLE_SIDED, SINGLE_SIDED_LABEL, unexpectedMissing } from '../pnp/singleSided';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AskSettings, askConfigured, classifyThrow, fetchTransport, preflight, readAskConfig, writeAskConfig, type AskConfig, type AskTransport } from '../cad/ask';
import { BoardPicker } from '../pnp/BoardPicker';
import { PcbSpec } from '../spec/pcbMount';
import { PcbSaveThumb } from '../shop/PcbSaveThumb';
import { BoardView } from '../pnp/BoardView';
import { BOARDS, loadBoard, type LoadedBoard } from '../pnp/boards';
import { defaultPlacement, modelFromParts } from '../pnp/boardModel';
import { BY_LABEL, boardParts, countLine, parseKicadFootprints } from '../pnp/parts';
import { parseCsv } from '../pnp/manifest';
import { useBoard3d } from '../pnp/useBoard3d';
import { GatesPanel } from '../gates/GatesPanel';
import { pcbGates, type GatesSnapshot, type PcbGate } from './pcbGates';
import { buildPcbRequest, netsFromKicad, pcbContext, readTextReply } from './pcbAsk';
import { claimPendingPcb, peekPendingPcb, subscribePcb } from './pcbHandoff';
import '../pnp/pnp.css';
import './pcbtab.css';

export const PCB_BOARD_KEY = '2bee.app.pcb.board';

type Msg = { id: number; role: 'user'; text: string } | { id: number; role: 'ai'; tone: 'ok' | 'bad'; text: string; notes: string[] };

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

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The records snapshot, re-read (no cache) each time it is asked for. */
async function readSnapshot(): Promise<GatesSnapshot | string> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL ?? '/'}pcb-gates/index.json`, { cache: 'no-store' });
    if (!r.ok) return `no gate records collected (HTTP ${r.status}) — run npm run pcb:gates`;
    const j = (await r.json()) as GatesSnapshot;
    return Array.isArray(j?.boards) ? j : 'the gate records file is not in the shape this tab reads — run npm run pcb:gates';
  } catch (e) {
    return `the gate records could not be read: ${(e as Error).message} — run npm run pcb:gates`;
  }
}

const RANK: Record<string, number> = { FAIL: 0, PENDING: 1, PASS: 2 };

export function PcbTab({ active, transport = fetchTransport }: { active: boolean; transport?: AskTransport }) {
  // ── board: picker, or a request from the Designs page (`pcbHandoff.ts`) ──
  const [boardId, setBoardId] = useState<string>(() => {
    const s = peekPendingPcb() ?? stored(PCB_BOARD_KEY);
    return s && BOARDS.some((b) => b.id === s) ? s : '';
  });
  const [unknown, setUnknown] = useState<string | null>(null);
  /* Claimed in an EFFECT, not in the state initialiser: StrictMode calls an
   * initialiser twice, and the second call would find the slot already cleared. */
  useEffect(() => {
    const open = (id: string) => {
      if (BOARDS.some((b) => b.id === id)) {
        setBoardId(id);
        setUnknown(null);
      } else setUnknown(`No board "${id}" in hardware/pcb — nothing was opened.`);
    };
    const pending = claimPendingPcb();
    if (pending) open(pending);
    return subscribePcb(open);
  }, []);
  const [loaded, setLoaded] = useState<LoadedBoard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveSha, setLiveSha] = useState<{ id: string; sha: string | null } | null>(null);
  useEffect(() => {
    store(PCB_BOARD_KEY, boardId);
    setLoaded(null);
    setLoadError(null);
    setLiveSha(null);
    const entry = BOARDS.find((b) => b.id === boardId);
    if (!entry) return;
    let live = true;
    loadBoard(entry).then(
      async (b) => {
        if (!live) return;
        setLoaded(b);
        const sha = b.kicad ? await sha256Hex(b.kicad) : null;
        if (live) setLiveSha({ id: boardId, sha });
      },
      (e) => live && setLoadError(`Could not read this board: ${(e as Error).message}`)
    );
    return () => {
      live = false;
    };
  }, [boardId]);

  // ── the records snapshot (re-read on every board change, so a fresh `npm run pcb:gates` shows) ──
  const [snapshot, setSnapshot] = useState<GatesSnapshot | string | null>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(null);
    void readSnapshot().then((s) => live && setSnapshot(s));
    return () => {
      live = false;
    };
  }, [boardId]);

  const bparts = useMemo(() => (loaded ? boardParts({ bom: loaded.bom, cpl: loaded.cpl, sidecar: loaded.sidecar, kicad: loaded.kicad }) : null), [loaded]);
  const model = useMemo(() => (bparts ? modelFromParts(bparts.parts) : null), [bparts]);
  const refs = useMemo(() => {
    if (!loaded) return { bom: [] as string[], cpl: [] as string[], fp: [] as string[] };
    const bom = parseCsv(loaded.bom).flatMap((r) => (r.Reference ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const cpl = parseCsv(loaded.cpl).map((r) => r.Ref).filter(Boolean);
    const fp = loaded.kicad ? parseKicadFootprints(loaded.kicad).map((f) => f.ref) : [];
    return { bom, cpl, fp };
  }, [loaded]);
  const nets = useMemo(() => (loaded?.kicad ? netsFromKicad(loaded.kicad) : null), [loaded]);

  const gates: PcbGate[] = useMemo(() => {
    const gs = pcbGates({
      boardId,
      snapshot,
      liveBoardSha: liveSha && liveSha.id === boardId ? liveSha.sha : null,
      parts: bparts,
      bomRefs: refs.bom,
      cplRefs: refs.cpl,
      footprintRefs: refs.fp,
    });
    // The matrix rows (up to ~190) FAIL first, then PENDING, then PASS; register order within each.
    const head = gs.filter((x) => x.group !== 'matrix');
    const rows = gs.filter((x) => x.group === 'matrix').sort((a, b) => RANK[a.state] - RANK[b.state]);
    return [...head, ...rows];
  }, [boardId, snapshot, liveSha, bparts, refs]);

  // ── 3D ──
  const b3 = useBoard3d(boardId);
  const gbox = b3.sides?.entry.box;
  const extent = gbox ? { minX: gbox.minX, minY: gbox.minY, maxX: gbox.minX + gbox.w, maxY: gbox.minY + gbox.h } : model?.plate ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const at = useMemo(() => defaultPlacement({ w: extent.maxX - extent.minX, h: extent.maxY - extent.minY }, null), [extent.maxX, extent.minX, extent.maxY, extent.minY]);
  const machineRefs = useMemo(() => new Set((bparts?.parts ?? []).filter((p) => p.by === 'machine').map((p) => p.ref)), [bparts]);
  const [hot, setHot] = useState<string | null>(null);
  const [modelled, setModelled] = useState(0);
  useEffect(() => setHot(null), [boardId]);
  const describe = (ref: string): [string, string][] => {
    const p = bparts?.parts.find((x) => x.ref === ref);
    if (!p) return [];
    const onNets = nets ? [...nets.entries()].filter(([, pads]) => pads.some((x) => x.startsWith(`${ref}.`))).map(([n]) => n) : [];
    return [
      ['Value', p.value],
      ['Part', p.mfrPn],
      ['Package', p.pkg],
      ['Side', p.side],
      ['Fitted by', BY_LABEL[p.by]],
      ['Nets', onNets.length ? onNets.slice(0, 6).join(', ') + (onNets.length > 6 ? ' …' : '') : '—'],
    ];
  };

  // ── chat ──
  const [cfg, setCfg] = useState<AskConfig>(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  });
  const patchCfg = (p: Partial<AskConfig>) =>
    setCfg((c) => {
      const next = { ...c, ...p };
      try {
        writeAskConfig(next, globalThis.localStorage);
      } catch {
        /* Storage blocked: the setting holds for this page only. */
      }
      return next;
    });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const connected = askConfigured(cfg);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, busy]);
  const push = (m: Omit<Extract<Msg, { role: 'user' }>, 'id'> | Omit<Extract<Msg, { role: 'ai' }>, 'id'>) =>
    setMsgs((old) => [...old, { ...m, id: nextId.current++ } as Msg]);

  const records = useMemo(() => {
    const rec = snapshot && typeof snapshot !== 'string' ? snapshot.boards.find((b) => b.id === boardId) : undefined;
    if (!rec) return [];
    const r = [...rec.erc, ...rec.drc].map(
      (x) =>
        `${x.kind.toUpperCase()} ${x.file} (${x.date ?? 'undated'}): errors ${x.errors ?? '?'}, warnings ${x.warnings ?? '?'}${
          x.kind === 'drc' ? `, violations ${x.violations ?? '?'}, unconnected ${x.unconnected ?? '?'}` : ''
        }; types ${JSON.stringify(x.types)}`
    );
    if (rec.fab.doNotOrder.length) r.push(`ORDER HOLD: ${rec.fab.doNotOrder.map((d) => `${d.file}: ${d.title}`).join('; ')}`);
    if (rec.fab.ordered) r.push(`ORDERED: ${rec.fab.ordered.title}`);
    r.push(`FAB FILES (${rec.fabDir}): ${rec.fab.files.join(', ')}`);
    return r;
  }, [snapshot, boardId]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const history = msgs.map((m) => ({ role: m.role, text: m.text }));
    push({ role: 'user', text: q });
    setPrompt('');
    if (!loaded) {
      push({ role: 'ai', tone: 'bad', text: boardId ? 'The board is still loading (or did not load) — ask again when it shows.' : 'Choose a board first.', notes: [] });
      return;
    }
    const pre = preflight(cfg, q, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) {
      push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail] });
      return;
    }
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const ctx = pcbContext({
        boardId,
        paths: [loaded.entry.bomPath, loaded.entry.cplPath, loaded.entry.pnsPath ?? '', loaded.entry.kicadPath ?? ''].filter(Boolean),
        bom: loaded.bom,
        cpl: loaded.cpl,
        countLine: bparts ? countLine(bparts) : '',
        nets,
        gates,
        records,
      });
      const r = readTextReply(await transport(buildPcbRequest(cfg, q, ctx.text, history), ctl.signal));
      if (!r.ok) push({ role: 'ai', tone: 'bad', text: r.failure.headline, notes: [r.failure.detail] });
      else push({ role: 'ai', tone: 'ok', text: r.text, notes: ctx.cut ? ['The board data was cut to fit; part of the nets list was not sent.'] : [] });
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: f.headline, notes: [f.detail] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  const fails = gates.filter((x) => x.state === 'FAIL').length;
  return (
    <div className="cad-simple pcb-simple" data-testid="pcb-tab" data-active={active ? 'yes' : 'no'}>
      <section className="cad-chat" aria-label="PCB assistant" data-testid="pcb-chat">
        <header className="cad-chat-head">
          <strong>PCB assistant</strong>
          <button
            type="button"
            className="cad-chat-clear"
            data-testid="pcb-chat-clear"
            disabled={msgs.length === 0 && !abort.current}
            onClick={() => {
              abort.current?.abort();
              setMsgs([]);
            }}
          >
            Clear
          </button>
          <button type="button" className="cad-chat-status" onClick={() => setSetup((s) => !s)} title="AI connection settings">
            <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
            {connected ? 'AI ready' : 'Connect AI'}
          </button>
        </header>
        <div className="pnp-pick">
          <span>Board</span>
          <BoardPicker value={boardId} onChange={setBoardId} />
          {loaded ? (
            <small className="pnp-pick-src" data-testid="pcb-board-sources">
              {loaded.entry.bomPath} · {loaded.entry.cplPath}
              {loaded.entry.kicadPath ? ` · ${loaded.entry.kicadPath}` : ''}
            </small>
          ) : null}
          {unknown ? (
            <small className="bad" data-testid="pcb-board-unknown">
              {unknown}
            </small>
          ) : null}
          {loadError ? (
            <small className="bad" data-testid="pcb-board-error">
              {loadError}
            </small>
          ) : null}
        </div>
        <PcbSpec boardId={boardId} />
        {setup ? (
          <div className="cad-chat-setup">
            <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
          </div>
        ) : null}
        <div className="cad-chat-log" ref={log} aria-live="polite">
          {msgs.length === 0 ? (
            <div className="cad-chat-msg ai">
              {connected ? (
                'Ask about this board: its parts, what is on a net, why a gate fails, what the DRC found. I answer from the board’s files and gate records; I change nothing.'
              ) : (
                <>
                  The AI is not connected yet.{' '}
                  {setup ? null : (
                    <button type="button" className="cad-chat-undo" onClick={() => setSetup(true)}>
                      Set up AI
                    </button>
                  )}
                </>
              )}
            </div>
          ) : null}
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="cad-chat-msg user">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="pcb-chat-reply">
                <div className="pcb-chat-reply">{m.text}</div>
                {m.notes.length ? (
                  <ul>
                    {m.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          )}
          {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
        </div>
        <form
          className="cad-chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(prompt);
          }}
        >
          <textarea
            data-testid="pcb-chat-prompt"
            rows={2}
            value={prompt}
            placeholder={connected ? 'Ask about this board…' : 'Connect the AI first'}
            disabled={!connected}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(prompt);
              }
            }}
          />
          {busy ? (
            <button type="button" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="pcb-chat-send">
              Send
            </button>
          )}
        </form>
      </section>
      <div className="cad-simple-view pcb-right">
        <div className="cad-simple-canvas">
          <BoardView
            model={model}
            laned={machineRefs}
            hot={hot}
            onHot={setHot}
            at={at}
            stackup={b3.sides}
            partsGlb={b3.partsGlb}
            extent={extent}
            describe={describe}
            onModelled={setModelled}
          />
        </div>
        <div className="pcb-about" data-testid="pcb-about">
          {/* Same "Save thumbnail" as the design page's PCB viewer (founder 2026-10-16). */}
          {model ? (
            <div className="pcb-thumb-row">
              <PcbSaveThumb boardId={boardId} scope=".pcb-right" />
            </div>
          ) : null}
          <div>
            {model
              ? `${boardId}: ${bparts ? countLine(bparts) : ''} · 3D models for ${modelled} of ${model.parts.length} · amber = machine-placed`
              : boardId
                ? loadError
                  ? 'Board not loaded'
                  : `Loading ${boardId}…`
                : 'Choose a board on the left.'}
          </div>
          {boardId ? (
            <div data-testid="pcb-board-gerber">
              {b3.sides ? (
                <>
                  board = pcb’s gerbers ({b3.sides.entry.source})
                  {SINGLE_SIDED[boardId] ? <span> · {SINGLE_SIDED_LABEL}</span> : null}{unexpectedMissing(boardId, b3.sides.entry.missing).length ? <span className="bad"> · missing layers: {unexpectedMissing(boardId, b3.sides.entry.missing).join(', ')}</span> : null}
                </>
              ) : (
                b3.sidesWhy || 'reading the gerber render…'
              )}
              {b3.models ? ` · ${b3.models.placeholder} of ${b3.models.withModel} models are pcb’s box_*.step stand-ins` : ''}
              {b3.glbWhy ? <span className="bad"> · {b3.glbWhy}</span> : null}
            </div>
          ) : null}
          <div>Right-drag (or shift + drag) to orbit · left-drag to pan · wheel to zoom · Top / Bottom / Flip on the view.</div>
        </div>
      </div>
      <GatesPanel
        gates={gates}
        storeKey="2bee.app.pcb.gates"
        title={`Gates${boardId ? ` · ${boardId}` : ''}`}
        foot={`Read from pcb’s records on disk (npm run pcb:gates collects them; nothing of pcb’s is run here) and from the fab files. "…" = no record, a stale record, a WARN or a SKIP — not a pass.${fails ? ' A FAIL is a ticket to pcb.' : ''}`}
      />
    </div>
  );
}

export default PcbTab;
