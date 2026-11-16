/**
 * The machines tab's 3d and pnp sections (founder 2026-10-15: "able to add 3d
 * printers to the machines", "able to filter cnc, 3d , pnp machines",
 * "integrate pnp machines into the machines (e.g. lumenpnp)").
 *
 * 3d: a list of printers kept in this browser, a chat that fills a printer's
 * facts from words or a linked page (printers.ts refuses anything outside its
 * keys/bounds) and can ADD a printer, and its build volume in 3D.
 * pnp: the pick-and-place machines the pnp lane documented (pnp/pnpMachines.ts,
 * every fact with its source), read-only here.
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
import { PNP_MACHINES, DEFAULT_PNP_MACHINE_ID, pnpMachineById } from '../pnp/pnpMachines';
import { PnpMachineCard } from '../pnp/PnpMachineCard';
import { MachineView } from './MachinesTab';
import {
  NO_PRINTER_FIELDS,
  PRINTER_FIELDS,
  PRINTER_KEYS,
  buildPrinterRequest,
  printerId,
  printerRows,
  readPrinterProposal,
  readPrinters,
  writePrinters,
  type Printer,
} from './printers';

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'note' | 'undone'; text: string; notes: string[]; undo?: Printer[] };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const store = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function PrintersSection({ active, kindPills, transport = fetchTransport }: { active: boolean; kindPills: React.ReactNode; transport?: AskTransport }) {
  const [list, setList] = useState<Printer[]>(() => readPrinters(store()));
  const [sel, setSel] = useState<string>(() => list[0]?.id ?? '');
  const [saveNote, setSaveNote] = useState('');
  const cur = list.find((p) => p.id === sel) ?? null;
  const fields = cur?.fields ?? NO_PRINTER_FIELDS;
  const commit = (next: Printer[]) => {
    setList(next);
    setSaveNote(writePrinters(store(), next) ?? '');
  };

  /* Filament slots (founder 2026-10-16: "on the machine I would see the 3d printer
   * with the filament config"). The SAME slots the 3d tab slices with: the slicer
   * bridge's /v1/slots, declared by a person. Read from the printer itself needs the
   * X2D's LAN access code (not on this machine), so it is not done here. */
  type Slot = { id: string; label: string; type: string; color: string };
  const [slots, setSlots] = useState<{ bedPlate: string; slots: Slot[]; types: string[] } | null>(null);
  const [slotsNote, setSlotsNote] = useState('');
  useEffect(() => {
    fetch('/__print3d/v1/slots')
      .then((r) => r.json())
      .then((v) => (v?.ok ? setSlots({ bedPlate: v.bedPlate, slots: v.slots, types: v.types }) : setSlotsNote('The slicer bridge did not answer, so the slots are not shown.')))
      .catch(() => setSlotsNote('The slicer bridge did not answer, so the slots are not shown.'));
  }, []);

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
  const lastUndo = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'ai' && m.undo) return m.id;
    }
    return -1;
  }, [msgs]);

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ role: 'user', text: ask });
    setPrompt('');
    const pre = preflight(cfg, ask, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) return push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail] });
    if (slots && /\b(filament|filaments|slot|slots|ams|spool)\b/i.test(ask)) {
      setBusy(true);
      /* 🔴 THIS BRANCH HAD ITS OWN TIMEOUT SIGNAL AND NEVER SET `abort.current`, so Stop and
       * Clear did nothing: the reply still arrived and the PUT changed the slots the 3d tab
       * slices with (bughunt 2026-11-15). Same controller as the other branch now, and the
       * PUT is not sent once it is aborted. */
      const ctl = new AbortController();
      abort.current = ctl;
      const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
      try {
        const fromPrinter = /\b(network|from the (bambu|bamboo|printer|x2d)|read)\b/i.test(ask);
        const res = await transport(
          {
            url: cfg.endpoint,
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
            body: {
              model: cfg.model,
              messages: [
                {
                  role: 'system',
                  content: `Map what the operator says onto the 3D printer's filament slots. Slots: ${slots.slots.map((x) => `${x.id} (${x.label}: ${x.type || 'empty'})`).join(', ')}. Allowed types: ${slots.types.filter(Boolean).join(', ')} or "" for empty. Answer JSON only: {"slots": [{"id": "<slot id>", "type": "<type>", "color": "#rrggbb"}], "why": "<short>"}. Only slots the operator mentioned; never guess a colour or type that was not stated (keep the current one).`,
                },
                { role: 'user', content: ask },
              ],
              temperature: 0,
              stream: false,
            },
          },
          ctl.signal,
        );
        const r = readReply(res);
        if (!r.ok) {
          push({ role: 'ai', tone: 'bad', text: `Filament slots not changed: ${r.failure.headline}.`, notes: [r.failure.detail] });
          return;
        }
        const v = r.ok ? (JSON.parse(/\{[\s\S]*\}/.exec(r.raw)?.[0] ?? '{}') as { slots?: { id?: string; type?: string; color?: string }[]; why?: string }) : {};
        const changes = (v.slots ?? []).filter(
          (c) => slots.slots.some((x) => x.id === c.id) && (c.type === undefined || slots.types.includes(c.type)) && (c.color === undefined || /^#[0-9a-f]{6}$/i.test(c.color)),
        );
        const refused = (v.slots ?? []).length - changes.length;
        /* Any bad slot refuses the WHOLE reply, as printers.ts and machineAsk.ts do. */
        if (refused) {
          push({ role: 'ai', tone: 'bad', text: 'Filament slots not changed: the answer broke the rules.', notes: [`${refused} slot change(s) named an unknown slot, type or colour.`] });
          return;
        }
        const extra = fromPrinter ? ['Reading the AMS from the printer itself needs the X2D LAN access code (not on this machine yet); these are declared values.'] : [];
        if (!changes.length) {
          push({ role: 'ai', tone: 'note', text: 'No filament slot was changed.', notes: [...extra, ...(refused ? [`${refused} slot change(s) refused (unknown slot, type or colour).`] : [])] });
          return;
        }
        const next = slots.slots.map((x) => {
          const c = changes.find((y) => y.id === x.id);
          return c ? { ...x, ...(c.type !== undefined ? { type: c.type } : {}), ...(c.color ? { color: c.color } : {}) } : x;
        });
        if (ctl.signal.aborted) throw new Error('stopped before anything was written');
        const put = await fetch('/__print3d/v1/slots', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bedPlate: slots.bedPlate, slots: next.map(({ id, type, color }) => ({ id, type, color })) }) });
        const pv = await put.json();
        if (!put.ok || !pv?.ok) throw new Error(pv?.error ?? `HTTP ${put.status}`);
        setSlots({ bedPlate: pv.bedPlate, slots: pv.slots, types: pv.types });
        push({
          role: 'ai',
          tone: 'ok',
          text: `Done. ${v.why ?? ''}`.trim(),
          notes: [...changes.map((c) => `${slots.slots.find((x) => x.id === c.id)!.label}: ${c.type || 'empty'}${c.color ? ` ${c.color}` : ''}`), ...extra, 'The 3d tab slices with these slots.'],
        });
      } catch (e) {
        push({ role: 'ai', tone: 'bad', text: `Filament slots not changed: ${e instanceof Error ? e.message : String(e)}`, notes: [] });
      } finally {
        clearTimeout(timer);
        abort.current = null;
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      /* A link is read; "add <model>" with no link is RESEARCHED (dev web search). */
      const research = wantsResearch(ask) && researchQuery(ask) !== '';
      const linked = research ? await researchPages(researchQuery(ask), ctl.signal) : await readLinkedPages(ask, ctl.signal);
      const pagesText = research ? pagesBlockFromSearch(linked.pages) : pagesBlock(linked.pages);
      const r = readReply(await transport(buildPrinterRequest(cfg, ask, fields, cur?.name ?? '', pagesText), ctl.signal));
      if (!r.ok) return push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. Nothing changed.`, notes: [r.failure.detail] });
      const p = readPrinterProposal(r.raw, fields);
      if (!p.ok) return push({ role: 'ai', tone: 'bad', text: 'Not changed: the proposal broke the rules.', notes: p.problems });
      const missing = p.missing.length ? [`Not stated, so not set: ${p.missing.join(', ')}.`] : [];
      const keys = Object.keys(p.patch);
      if (!p.name && keys.length === 0) return push({ role: 'ai', tone: 'note', text: p.why || 'Nothing to change.', notes: [...linked.notes, ...missing] });
      const before = list;
      let next: Printer[];
      let target: Printer;
      const source = linked.pages[0]?.url ?? 'operator';
      if (p.name && (!cur || p.name !== cur.name)) {
        /* "add this printer" → a NEW entry, starting from nothing stated. */
        target = { id: printerId(p.name, list.map((x) => x.id)), name: p.name, fields: { ...NO_PRINTER_FIELDS, ...p.patch }, source, addedAt: Date.now() };
        next = [...list, target];
      } else if (cur) {
        target = { ...cur, fields: { ...cur.fields, ...p.patch }, source };
        next = list.map((x) => (x.id === cur.id ? target : x));
      } else {
        return push({ role: 'ai', tone: 'note', text: 'Tell me which printer this is (its model name) so I can add it.', notes: [...linked.notes, ...missing] });
      }
      commit(next);
      setSel(target.id);
      push({
        role: 'ai',
        tone: 'ok',
        text: `Done. ${p.why}`.trim(),
        notes: [...linked.notes, ...(target.id !== cur?.id ? [`Added "${target.name}".`] : []), ...printerRows(cur && target.id === cur.id ? cur.fields : NO_PRINTER_FIELDS, p.patch), ...missing],
        undo: before,
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

  const view = {
    travelX: fields.buildX ?? 0,
    travelY: fields.buildY ?? 0,
    travelZ: fields.buildZ ?? 0,
    safeZ: 0,
    colletMm: 0,
    spindleMax: 0,
    supportsArcs: false,
  };
  const volumeKnown = fields.buildX !== null && fields.buildY !== null && fields.buildZ !== null;

  return (
    <div className="cad-simple" data-testid="machines-3d">
      <section className="cad-chat" aria-label="Printer assistant">
        <header className="cad-chat-head">
          <strong>Machine assistant</strong>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="printers-chat-clear"
          disabled={msgs.length === 0 && !abort.current}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
          <button type="button" className="cad-chat-status" onClick={() => setSetup((s) => !s)}>
            <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
            {connected ? 'AI ready' : 'Connect AI'}
          </button>
        </header>
        {kindPills}
        <label className="note" htmlFor="printer-pick">3D printer</label>
        <select id="printer-pick" data-testid="printer-pick" value={sel} onChange={(e) => setSel(e.target.value)}>
          {list.length === 0 ? <option value="">no printers yet — add one in the chat</option> : null}
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <dl className="machine-facts" data-testid="printer-facts">
          {PRINTER_KEYS.map((k) => {
            const v = fields[k];
            const f = PRINTER_FIELDS[k];
            return (
              <div key={k}>
                <dt>{f.label}</dt>
                <dd>{v === null ? 'not stated' : f.kind === 'bool' ? (v ? 'yes' : 'no') : `${v}${f.unit ? ` ${f.unit}` : ''}`}</dd>
              </div>
            );
          })}
        </dl>
        <div className="machine-slots" data-testid="printer-slots">
          <div className="note">Filaments (AMS){slots ? ` · ${slots.bedPlate}` : ''}</div>
          {slots ? (
            <ul>
              {slots.slots.map((x) => (
                <li key={x.id}>
                  <span className="machine-swatch" style={{ background: x.type ? x.color : 'transparent' }} aria-hidden="true" />
                  {x.label}: {x.type || 'empty'}
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">{slotsNote || 'Reading…'}</p>
          )}
        </div>
        {saveNote ? <p className="bad">{saveNote}</p> : null}
        {setup ? (
          <div className="cad-chat-setup">
            <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
          </div>
        ) : null}
        <div className="cad-chat-log" ref={log} aria-live="polite">
          {msgs.length === 0 ? (
            <div className="cad-chat-msg ai">
              Add a printer in words or with a link, e.g. "add this printer: https://…". I fill in what is stated; the rest stays "not stated".
            </div>
          ) : null}
          {msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="cad-chat-msg user">{m.text}</div>
            ) : (
              <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="printers-chat-reply">
                <div>{m.text}</div>
                {m.notes.length ? (
                  <ul>
                    {m.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                ) : null}
                {m.undo && m.id === lastUndo ? (
                  <button
                    type="button"
                    className="cad-chat-undo"
                    onClick={() => {
                      commit(m.undo!);
                      setSel(m.undo![0]?.id ?? '');
                      setMsgs((o) => o.map((x) => (x.id === m.id && x.role === 'ai' ? { ...x, tone: 'undone', undo: undefined, text: `Undone. ${x.text.replace(/^Done\.\s*/, '')}` } : x)));
                    }}
                  >
                    Undo
                  </button>
                ) : null}
              </div>
            ),
          )}
          {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
        </div>
        <form className="cad-chat-input" onSubmit={(e) => { e.preventDefault(); void send(prompt); }}>
          <textarea
            data-testid="printers-chat-prompt"
            rows={2}
            value={prompt}
            placeholder={connected ? 'Describe or link a printer…' : 'Connect the AI first'}
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
            <button type="button" onClick={() => abort.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="primary" disabled={!connected || !prompt.trim()}>Send</button>
          )}
        </form>
      </section>
      <div className="cad-simple-view">
        <div className="cad-simple-canvas">
          {volumeKnown ? (
            <MachineView fields={view} active={active} legend={`Build volume ${fields.buildX} × ${fields.buildY} × ${fields.buildZ} mm`} />
          ) : (
            <div className="machine-view machine-empty">
              <p className="note">{cur ? `${cur.name}: build volume not stated, so nothing is drawn.` : 'No printer selected.'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PnpSection({ active, kindPills }: { active: boolean; kindPills: React.ReactNode }) {
  const [id, setId] = useState(DEFAULT_PNP_MACHINE_ID);
  const m = pnpMachineById(id);
  const t = m.travel;
  const known = t.x !== null && t.y !== null;
  return (
    <div className="cad-simple" data-testid="machines-pnp">
      <section className="cad-chat" aria-label="Pick-and-place machines">
        <header className="cad-chat-head">
          <strong>Machine assistant</strong>
        </header>
        {kindPills}
        <PnpMachineCard
          machine={m}
          picker={
            <select data-testid="pnp-machine-pick" value={id} onChange={(e) => setId(e.target.value)}>
              {PNP_MACHINES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          }
        />
        <p className="note">These come from the pnp lane's documents; each fact names its source. They are edited there, not here.</p>
      </section>
      <div className="cad-simple-view">
        <div className="cad-simple-canvas">
          {known ? (
            <MachineView
              fields={{ travelX: t.x!, travelY: t.y!, travelZ: t.z ?? 20, safeZ: 0, colletMm: 0, spindleMax: 0, supportsArcs: false }}
              active={active}
              legend={`Travel ${t.x} × ${t.y}${t.z !== null ? ` × ${t.z}` : ''} mm (${t.basis})`}
            />
          ) : (
            <div className="machine-view machine-empty">
              <p className="note">{m.name}: travel not stated, so nothing is drawn.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
