/**
 * materials — what the shop HAS (founder 2026-10-16, approved: "a new materials
 * tab, same concept as the machines tab"; then "add pcb components to the
 * materials as well").
 *
 * Pills: sheets (cnc stock) · filaments (3d) · components (pcb parts).
 * Left: the chat that ADDS or edits an item from words, a link or a web search
 * (`stock.ts` / `components.ts` refuse the whole patch on any unknown key or
 * out-of-bounds value), and the facts of the selected item. Right: its 3D.
 *
 * ⚠ Nothing on this page is a default. An unstated field reads "not stated";
 * no list order means "preferred"; cnc's choice of stock is the operator's.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AskSettings,
  askConfigured,
  classifyThrow,
  fetchTransport,
  preflight,
  readAskConfig,
  readReply,
  writeAskConfig,
  type AskConfig,
  type AskTransport,
} from '../cad/ask';
import { pagesBlock, pagesBlockFromSearch, readLinkedPages, researchPages, researchQuery, wantsResearch } from '../ai/linkedPages';
import { toolLibrary } from '../cam';
import { bodySize } from '../pnp/boardModel';
import {
  FILAMENT_FIELDS,
  FILAMENT_KEYS,
  NO_FILAMENT_FIELDS,
  NO_SHEET_FIELDS,
  SHEET_FIELDS,
  SHEET_KEYS,
  buildStockRequest,
  filamentLabel,
  plannerMaterial,
  readFilamentProposal,
  readFilaments,
  readSheetProposal,
  readSheets,
  sheetLabel,
  showValue,
  stockId,
  stockRows,
  writeFilaments,
  writeSheets,
  type Filament,
  type FilamentFields,
  type Sheet as StockItem,
  type SheetFields,
} from './stock';
import { ONHAND_MAX, buildOnHandRequest, buildable, readOnHand, readOnHandProposal, writeOnHand, type OnHand } from './components';
import { loadComponents, type ComponentsData } from './componentsData';
import { MATERIAL_COLOURS, StockView, type StockShape } from './StockView';
import './materials.css';

type Kind = 'stock' | 'filaments' | 'components';
const KINDS: Kind[] = ['stock', 'filaments', 'components'];
/* The pill words are the founder's (2026-10-16: "sheets (cnc stock) · filaments (3d)"). */
const KIND_LABEL: Record<Kind, string> = { stock: 'sheets', filaments: 'filaments', components: 'components' };
const KIND_KEY = '2bee.app.materials.kind';
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

type Undo =
  | { kind: 'stock'; before: StockItem | null; afterId: string | null; index: number }
  | { kind: 'filaments'; before: Filament | null; afterId: string | null; index: number }
  | { kind: 'components'; before: Record<string, number | null> };

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'note' | 'undone'; text: string; notes: string[]; undo?: Undo };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const store = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Put `item` back where it was (replace by id, else insert at `index`); or drop `dropId`. */
function restore<T extends { id: string }>(list: T[], before: T | null, dropId: string | null, index: number): T[] {
  let next = dropId ? list.filter((x) => x.id !== dropId) : list.slice();
  if (before) {
    if (next.some((x) => x.id === before.id)) next = next.map((x) => (x.id === before.id ? before : x));
    else next.splice(Math.min(index, next.length), 0, before);
  }
  return next;
}

export function MaterialsTab({ active, transport = fetchTransport }: { active: boolean; transport?: AskTransport }) {
  const [kind, setKind] = useState<Kind>(() => {
    try {
      const v = globalThis.localStorage?.getItem(KIND_KEY);
      return v === 'filaments' || v === 'components' ? v : 'stock';
    } catch {
      return 'stock';
    }
  });

  // ── stock lists ──
  const [sheets, setSheets] = useState<StockItem[]>(() => readSheets(store()));
  const [filaments, setFilaments] = useState<Filament[]>(() => readFilaments(store()));
  const [selSheet, setSelSheet] = useState(() => sheets[0]?.id ?? '');
  const [selFil, setSelFil] = useState(() => filaments[0]?.id ?? '');
  const [saveNote, setSaveNote] = useState('');
  const commitSheets = (next: StockItem[]) => {
    setSheets(next);
    setSaveNote(writeSheets(store(), next) ?? '');
  };
  const commitFilaments = (next: Filament[]) => {
    setFilaments(next);
    setSaveNote(writeFilaments(store(), next) ?? '');
  };
  const curSheet = sheets.find((s) => s.id === selSheet) ?? null;
  const stockList = sheets;
  const curFil = filaments.find((f) => f.id === selFil) ?? null;

  /* The planner's own material names: the core's list, never a copy. */
  const [known, setKnown] = useState<string[]>([]);
  const [knownErr, setKnownErr] = useState('');
  useEffect(() => {
    let live = true;
    toolLibrary()
      .then((l) => live && setKnown(l.materials.map((m) => m.name)))
      .catch((e) => live && setKnownErr(`The planner's material list did not load (${e instanceof Error ? e.message : String(e)}), so materials are unchecked.`));
    return () => {
      live = false;
    };
  }, []);

  // ── components ──
  const [comp, setComp] = useState<ComponentsData | null>(null);
  const [compErr, setCompErr] = useState('');
  const [onHand, setOnHand] = useState<OnHand>(() => readOnHand(store()));
  const [selPart, setSelPart] = useState('');
  const [board, setBoard] = useState('');
  useEffect(() => {
    if (kind !== 'components' || comp) return;
    let live = true;
    loadComponents()
      .then((d) => live && setComp(d))
      .catch((e) => live && setCompErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [kind, comp]);
  const commitOnHand = (next: OnHand) => {
    setOnHand(next);
    setSaveNote(writeOnHand(store(), next) ?? '');
  };
  const rows = comp?.rows ?? [];
  const shownRows = board ? rows.filter((r) => (r.perBoard[board] ?? 0) > 0) : rows;
  const curPart = rows.find((r) => r.key === selPart) ?? null;
  const builds = useMemo(() => (comp ? comp.boards.map((b) => buildable(b, comp.rows, onHand)) : []), [comp, onHand]);

  // ── chat ──
  const [cfg, setCfg] = useState<AskConfig>(() => readAskConfig(store()));
  const patchCfg = (p: Partial<AskConfig>) =>
    setCfg((c) => {
      const n = { ...c, ...p };
      writeAskConfig(n, store());
      return n;
    });
  const connected = askConfigured(cfg);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, busy]);
  const push = (m: NewMsg) => setMsgs((o) => [...o, { ...m, id: nextId.current++ } as Msg]);
  /* 🔴 The lists ON SCREEN now, read when a reply lands. The answer is applied to the lists
   * captured at send, so a count typed or a sheet removed while the model worked was put
   * back (bughunt 2026-11-15). A reply that lands on changed lists is refused. */
  const listsNow = () => JSON.stringify([onHandNow.current, sheetsNow.current, filamentsNow.current, selNow.current]);
  const onHandNow = useRef(onHand);
  onHandNow.current = onHand;
  const sheetsNow = useRef(sheets);
  sheetsNow.current = sheets;
  const filamentsNow = useRef(filaments);
  filamentsNow.current = filaments;
  const selNow = useRef([selSheet, selFil]);
  selNow.current = [selSheet, selFil];
  const stale = (): NewMsg => ({
    role: 'ai',
    tone: 'bad',
    text: 'Not changed: the list changed while the AI was working.',
    notes: ['Its answer was written against the list as it was when you asked. Ask again.'],
  });

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ role: 'user', text: ask });
    setPrompt('');
    const pre = preflight(cfg, ask, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) return push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail] });
    if (kind === 'components' && !comp) return push({ role: 'ai', tone: 'bad', text: 'The part list has not loaded yet. Nothing changed.', notes: compErr ? [compErr] : [] });
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    const sentAs = listsNow();
    try {
      /* A link is read; "add <product>" with no link is RESEARCHED (dev web search).
       * Counts are the operator's own, so the components pill never searches. */
      const research = kind !== 'components' && wantsResearch(ask) && researchQuery(ask) !== '';
      const linked = research ? await researchPages(researchQuery(ask), ctl.signal) : await readLinkedPages(ask, ctl.signal);
      const pagesText = research ? pagesBlockFromSearch(linked.pages) : pagesBlock(linked.pages);
      const source = linked.pages[0]?.url ?? 'operator';

      if (kind === 'components') {
        const r = readReply(await transport(buildOnHandRequest(cfg, ask, rows, onHand, pagesText), ctl.signal));
        if (!r.ok) return push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. Nothing changed.`, notes: [r.failure.detail] });
        if (listsNow() !== sentAs) return push(stale());
        const p = readOnHandProposal(r.raw, rows);
        if (!p.ok) return push({ role: 'ai', tone: 'bad', text: 'Not changed: the proposal broke the rules.', notes: p.problems });
        const keys = Object.keys(p.set).filter((k) => onHand[k] !== p.set[k]);
        const missing = p.missing.length ? [`Not stated or not found: ${p.missing.join(', ')}.`] : [];
        if (!keys.length) return push({ role: 'ai', tone: 'note', text: p.why || 'Nothing to change.', notes: [...linked.notes, ...missing] });
        const before: Record<string, number | null> = {};
        for (const k of keys) before[k] = k in onHand ? onHand[k] : null;
        commitOnHand({ ...onHand, ...Object.fromEntries(keys.map((k) => [k, p.set[k]])) });
        if (keys.length === 1) setSelPart(keys[0]);
        return push({
          role: 'ai',
          tone: 'ok',
          text: `Done. ${p.why}`.trim(),
          notes: [...linked.notes, ...keys.map((k) => `${k} your count: ${before[k] ?? 'not counted'} → ${p.set[k]}`), ...missing],
          undo: { kind: 'components', before },
        });
      }

      const isSheet = kind === 'stock';
      const list: (StockItem | Filament)[] = isSheet ? sheets : filaments;
      const cur = isSheet ? curSheet : curFil;
      const req = buildStockRequest(
        cfg,
        isSheet ? 'cnc' : '3d',
        ask,
        cur ? { name: cur.name, fields: cur } : null,
        list.map((x) => x.name),
        known,
        pagesText,
      );
      const r = readReply(await transport(req, ctl.signal));
      if (!r.ok) return push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. Nothing changed.`, notes: [r.failure.detail] });
      if (listsNow() !== sentAs) return push(stale());
      const p = isSheet ? readSheetProposal(r.raw, curSheet, known) : readFilamentProposal(r.raw, curFil);
      if (!p.ok) return push({ role: 'ai', tone: 'bad', text: 'Not changed: the proposal broke the rules.', notes: p.problems });
      const specs = (isSheet ? SHEET_FIELDS : FILAMENT_FIELDS) as Record<string, Parameters<typeof showValue>[0]>;
      const missing = p.missing.length ? [`Not stated, so not set: ${p.missing.map((k) => specs[k]?.label ?? k).join(', ')}.`] : [];
      const index = cur ? list.findIndex((x) => x.id === cur.id) : list.length;

      if (p.action === 'remove' && cur) {
        const next = list.filter((x) => x.id !== cur.id);
        if (isSheet) {
          commitSheets(next as StockItem[]);
          setSelSheet(next[0]?.id ?? '');
        } else {
          commitFilaments(next as Filament[]);
          setSelFil(next[0]?.id ?? '');
        }
        return push({
          role: 'ai',
          tone: 'ok',
          text: `Removed "${cur.name}". ${p.why}`.trim(),
          notes: linked.notes,
          undo: isSheet ? { kind: 'stock', before: cur as StockItem, afterId: null, index } : { kind: 'filaments', before: cur as Filament, afterId: null, index },
        });
      }
      if (p.action === 'edit' && Object.keys(p.patch).length === 0 && !p.name)
        return push({ role: 'ai', tone: 'note', text: p.why || 'Nothing to change.', notes: [...linked.notes, ...p.flags, ...missing] });

      let target: StockItem | Filament;
      let next: (StockItem | Filament)[];
      if (p.action === 'add') {
        const fields = { ...(isSheet ? NO_SHEET_FIELDS : NO_FILAMENT_FIELDS), ...p.patch };
        const name = p.name ?? (isSheet ? sheetLabel(fields as SheetFields) : filamentLabel(fields as FilamentFields));
        target = { ...fields, id: stockId(name, list.map((x) => x.id)), name, source, addedAt: Date.now() } as StockItem | Filament;
        next = [...list, target];
      } else {
        target = { ...cur!, ...p.patch, ...(p.name ? { name: p.name } : {}), source } as StockItem | Filament;
        next = list.map((x) => (x.id === cur!.id ? target : x));
      }
      if (isSheet) {
        commitSheets(next as StockItem[]);
        setSelSheet(target.id);
      } else {
        commitFilaments(next as Filament[]);
        setSelFil(target.id);
      }
      const before = p.action === 'add' ? null : cur;
      push({
        role: 'ai',
        tone: 'ok',
        text: `Done. ${p.why}`.trim(),
        notes: [
          ...linked.notes,
          ...(p.action === 'add' ? [`Added "${target.name}".`] : []),
          ...stockRows(specs, before, p.patch as Record<string, unknown>),
          ...p.flags,
          ...missing,
          ...(isSheet ? ['A stated thickness is nominal. Measure the panel before a through-cut.'] : []),
        ],
        undo: isSheet
          ? { kind: 'stock', before: before as StockItem | null, afterId: target.id, index }
          : { kind: 'filaments', before: before as Filament | null, afterId: target.id, index },
      });
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: `${f.headline}. Nothing changed.`, notes: [f.detail] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  const undo = (id: number, u: Undo) => {
    if (u.kind === 'stock') {
      const next = restore(sheets, u.before, u.before ? null : u.afterId, u.index);
      commitSheets(next);
      setSelSheet(u.before?.id ?? next[0]?.id ?? '');
    } else if (u.kind === 'filaments') {
      const next = restore(filaments, u.before, u.before ? null : u.afterId, u.index);
      commitFilaments(next);
      setSelFil(u.before?.id ?? next[0]?.id ?? '');
    } else {
      const next = { ...onHand };
      for (const [k, v] of Object.entries(u.before)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      commitOnHand(next);
    }
    setMsgs((o) => o.map((x) => (x.id === id && x.role === 'ai' ? { ...x, tone: 'undone', undo: undefined, text: `Undone. ${x.text.replace(/^(Done|Removed)\.?\s*/, '')}` } : x)));
  };

  const pills = (
    <div className="machine-kinds" role="tablist" aria-label="Material kind">
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={kind === k}
          data-testid={`materials-kind-${k}`}
          onClick={() => {
            setKind(k);
            try {
              globalThis.localStorage?.setItem(KIND_KEY, k);
            } catch {
              /* remembered for this page only */
            }
          }}
        >
          {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );

  // ── the 3D, from stated values only ──
  let shape: StockShape | null = null;
  let legend = '';
  let empty = '';
  if (kind === 'stock') {
    const s = curSheet;
    if (!s) empty = 'No stock selected. Add some in the chat.';
    else if (s.sizeX === null || s.sizeY === null || s.thicknessMm === null) empty = `${s.name}: size or thickness not stated, so nothing is drawn.`;
    else {
      const look = MATERIAL_COLOURS[(s.material ?? '').toLowerCase()] ?? { color: '#9a9a9a' };
      shape = { kind: 'box', x: s.sizeX, y: s.sizeY, z: s.thicknessMm, ...look };
      legend = `${s.sizeX} × ${s.sizeY} × ${s.thicknessMm} mm${s.material ? ` · ${s.material}` : ''} (as stated)`;
    }
  } else if (kind === 'filaments') {
    const f = curFil;
    if (!f) empty = 'No filament selected. Add one in the chat.';
    else {
      shape = { kind: 'spool', color: f.colourHex ?? '#9a9a9a' };
      legend = `${f.name} · spool not to scale${f.colourHex ? '' : ' · colour not stated, drawn grey'}`;
    }
  } else if (curPart) {
    const b = bodySize(curPart.pkg);
    if (b.from === 'unknown') empty = `${curPart.key}: package "${curPart.pkg || 'not stated'}" has no known size, so nothing is drawn.`;
    else {
      shape = { kind: 'box', x: b.l, y: b.w, z: b.h, color: '#4a5058' };
      legend = `${curPart.pkg}: ${b.l} × ${b.w} × ${b.h} mm (${b.from === 'table' ? 'nominal for the package family' : 'read from the package name'})`;
    }
  } else empty = 'Pick a part in the list.';

  const facts = (keys: string[], specs: Record<string, Parameters<typeof showValue>[0]>, item: object | null) => (
    <dl className="machine-facts" data-testid={`materials-facts-${kind}`}>
      {keys.map((k) => (
        <div key={k}>
          <dt>{specs[k].label}</dt>
          <dd>{showValue(specs[k], item ? (item as Record<string, unknown>)[k] : null)}</dd>
        </div>
      ))}
    </dl>
  );

  const placeholder =
    kind === 'stock'
      ? 'e.g. 18 mm birch ply 2440 x 1220 from Bunnings, 4 of them'
      : kind === 'filaments'
      ? 'e.g. add this filament: https://…'
      : 'e.g. I have 2 reels of C13585, 4000 each';

  return (
    <div className="cad-simple" data-testid="materials-tab">
      <section className="cad-chat" aria-label="Materials assistant" data-testid="materials-chat">
        <header className="cad-chat-head">
          <strong>Materials assistant</strong>
          <button
            type="button"
            className="cad-chat-clear"
            data-testid="materials-chat-clear"
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
        {pills}

        {kind === 'stock' ? (
          <>
            <select data-testid="materials-stock-pick" aria-label="Stock" value={selSheet} onChange={(e) => setSelSheet(e.target.value)}>
              {stockList.length === 0 ? <option value="">no stock yet — add some in the chat</option> : null}
              {sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {facts(SHEET_KEYS, SHEET_FIELDS, curSheet)}
            {curSheet?.material && !plannerMaterial(curSheet.material, known) ? (
              <p className="bad" data-testid="materials-material-flag">
                {known.length ? `"${curSheet.material}" is not a material the planner carries; cnc cannot plan feeds for it.` : knownErr || 'Checking the material against the planner…'}
              </p>
            ) : null}
          </>
        ) : kind === 'filaments' ? (
          <>
            <select data-testid="materials-filament-pick" aria-label="Filament" value={selFil} onChange={(e) => setSelFil(e.target.value)}>
              {filaments.length === 0 ? <option value="">no filament yet — add one in the chat</option> : null}
              {filaments.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {facts(FILAMENT_KEYS, FILAMENT_FIELDS, curFil)}
          </>
        ) : (
          <ComponentsPanel
            data={comp}
            err={compErr}
            rows={shownRows}
            onHand={onHand}
            board={board}
            setBoard={setBoard}
            sel={selPart}
            setSel={setSelPart}
            builds={builds}
            setCount={(k, n) => {
              const next = { ...onHand };
              if (n === null) delete next[k];
              else next[k] = n;
              commitOnHand(next);
            }}
          />
        )}
        {saveNote ? <p className="bad">{saveNote}</p> : null}

        {setup ? (
          <div className="cad-chat-setup">
            <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
          </div>
        ) : null}
        <div className="cad-chat-log" ref={log} aria-live="polite">
          {msgs.length === 0 ? (
            <div className="cad-chat-msg ai">
              {connected ? (
                kind === 'components'
                  ? 'Tell me what you have on hand, e.g. "I have 2 reels of C13585, 4000 each". JLC stock is theirs, not yours.'
                  : 'Add stock in words, with a link, or ask me to look it up. I fill in what is stated; the rest stays "not stated".'
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
              <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="materials-chat-reply">
                <div>{m.text}</div>
                {m.notes.length ? (
                  <ul>
                    {m.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                ) : null}
                {m.undo ? (
                  <button type="button" className="cad-chat-undo" data-testid="materials-chat-undo" onClick={() => undo(m.id, m.undo!)}>
                    Undo
                  </button>
                ) : null}
              </div>
            ),
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
            data-testid="materials-chat-prompt"
            rows={2}
            value={prompt}
            placeholder={connected ? placeholder : 'Connect the AI first'}
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
            <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="materials-chat-send">
              Send
            </button>
          )}
        </form>
      </section>
      <div className="cad-simple-view">
        <div className="cad-simple-canvas">
          {shape ? (
            <StockView shape={shape} active={active} legend={legend} />
          ) : (
            <div className="machine-view machine-empty">
              <p className="note">{empty}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ComponentsPanel(props: {
  data: ComponentsData | null;
  err: string;
  rows: ComponentsData['rows'];
  onHand: OnHand;
  board: string;
  setBoard(b: string): void;
  sel: string;
  setSel(k: string): void;
  builds: ReturnType<typeof buildable>[];
  setCount(k: string, n: number | null): void;
}) {
  const { data, err, rows, onHand, board, setBoard, sel, setSel, builds, setCount } = props;
  if (!data) return <p className="note">{err ? `The part list did not load: ${err}` : 'Reading the boards’ BOMs…'}</p>;
  const cur = data.rows.find((r) => r.key === sel) ?? null;
  const jlc = data.snapshotDate ? `JLC stock on ${data.snapshotDate}` : 'JLC stock (snapshot date unknown)';
  return (
    <>
      <select data-testid="materials-board-pick" aria-label="Board" value={board} onChange={(e) => setBoard(e.target.value)}>
        <option value="">all boards ({data.rows.length} parts)</option>
        {data.boards.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <div className="materials-boards" data-testid="materials-buildable">
        {!board ? (
          <p className="note">Pick a board to see how many your counts cover.</p>
        ) : (
          builds
            .filter((b) => b.boardId === board)
            .map((b) => (
              <div key={b.boardId}>
                <span>
                  Enough for <strong>{b.boards}</strong> board{b.boards === 1 ? '' : 's'} (your counts; JLC stock is not yours)
                </span>
                {b.notCounted.length ? <span className="note">{b.notCounted.length} of {b.parts} parts not counted (counted as 0).</span> : null}
                {b.short.length && b.short.length !== b.notCounted.length ? (
                  <span className="note">Short for one more: {b.short.filter((x) => x.have !== null).map((x) => `${x.key} (need ${x.need}, have ${x.have})`).join(', ')}</span>
                ) : null}
                {b.bad.length ? <span className="bad">bom marks {b.bad.length} part(s) dead / wrong: {b.bad.join(', ')}</span> : null}
              </div>
            ))
        )}
      </div>
      <div className="materials-list" data-testid="materials-parts">
        <table>
          <thead>
            <tr>
              <th>Part</th>
              <th>Value</th>
              <th className="num" title={board ? 'Needed per board' : 'How many boards use it'}>{board ? 'Need' : 'Boards'}</th>
              <th className="num">Yours</th>
              <th className="num" title={`${jlc}: the supplier's stock, not ours`}>JLC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = r.bom.map((b) => b.status).filter(Boolean).join(' / ');
              return (
                <tr key={r.key} aria-selected={r.key === sel} className={r.bad ? 'bad' : undefined} onClick={() => setSel(r.key)} data-testid="materials-part-row">
                  <td title={r.bad ? `bom: ${status}\n${r.bom.map((b) => b.note).join('\n')}` : status ? `bom: ${status}` : 'no bom record'}>{r.key}</td>
                  <td title={`${r.value} · ${r.pkg}`}>{r.value}</td>
                  <td className="num">{board ? r.perBoard[board] : Object.keys(r.perBoard).length}</td>
                  <td className="num">{r.key in onHand ? onHand[r.key] : '—'}</td>
                  <td className="num" title={r.jlcStock === null ? 'not in the JLC snapshot' : `${jlc}: ${r.jlcStock.toLocaleString('en')}`}>{r.jlcStock === null ? '—' : COMPACT.format(r.jlcStock)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {cur ? (
        <>
          <dl className="machine-facts materials-facts-one" data-testid="materials-facts-components">
            <div><dt>Part</dt><dd>{cur.key}</dd></div>
            <div><dt>Mfr PN</dt><dd>{cur.mpn || 'not stated'}</dd></div>
            <div><dt>Value</dt><dd>{cur.value || 'not stated'}</dd></div>
            <div><dt>Package</dt><dd>{cur.pkg || 'not stated'}</dd></div>
            <div><dt>Boards</dt><dd>{Object.entries(cur.perBoard).map(([b, n]) => `${b} ×${n}`).join(', ')}</dd></div>
            <div><dt>{jlc}</dt><dd>{cur.jlcStock === null ? 'not in snapshot' : cur.jlcStock.toLocaleString('en')}</dd></div>
            <div>
              <dt>bom status</dt>
              <dd className={cur.bad ? 'bad' : undefined} title={cur.bom.map((b) => b.note).join('\n')}>
                {cur.bom.length ? cur.bom.map((b) => b.status || '(blank)').join(' / ') : 'no record'}
              </dd>
            </div>
          </dl>
          <label className="materials-onhand">
            Your count
            <input
              type="number"
              min={0}
              max={ONHAND_MAX}
              step={1}
              data-testid="materials-onhand"
              value={cur.key in onHand ? onHand[cur.key] : ''}
              placeholder="not counted"
              onChange={(e) => {
                const v = e.target.value;
                if (v === '') return setCount(cur.key, null);
                const n = Number(v);
                if (Number.isInteger(n) && n >= 0 && n <= ONHAND_MAX) setCount(cur.key, n);
              }}
            />
          </label>
        </>
      ) : null}
      {data.problems.length ? (
        <ul className="note bad">
          {data.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export default MaterialsTab;
