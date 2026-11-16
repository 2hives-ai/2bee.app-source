// The print assistant: pnp's 2bee.3d chat panel (`public/chat.js`), in React,
// on the app's own AI path.
//
//   · Chips first. Every predefined question is `make/printJob/chips.ts` (a
//     verbatim port of pnp's `chips.json`), every answer goes through
//     `validateOverrides` (`make/printJob/allowlist.ts`, a port of pnp's
//     `allowlist.js`) before it touches the job. Arrangement and the process /
//     filament presets are chips too: they call the tab, never a model.
//   · Free text goes to the model through `askPrint` — `cad/ask.tsx`'s
//     `readAskConfig` + `fetchTransport`, i.e. the founder's local
//     `tools/claude-bridge`. The model proposes allow-listed settings and never
//     G-code; what it proposes is shown, and applied only when the person
//     presses Apply.
//   · 🔴 THE SERVER CHECKS AGAIN. The engine bridge runs pnp's `allowlist.js`
//     on every override before Orca sees it, with the filament profile's limits
//     this side does not have; a refusal there fails the slice and says why.
//   · Every change lands in "Applied settings" with its reason and an Undo.
//   · LAYOUT (founder 2026-10-16: "separate the objects, lay down, arrange" was
//     answered "Use OrcaSlicer"). The model may now propose layout actions
//     (separate / lay_flat / arrange / rotate), checked by
//     `layout3d.validateLayoutActions` and done by the tab on Apply; the same
//     actions are chips. A reply sentence naming another slicer program is
//     dropped (`scrubOtherPrograms`), and the page says it dropped it.

import { useEffect, useRef, useState } from 'react';
import { askConfigured, AskSettings, fetchTransport, readAskConfig, writeAskConfig, type AskConfig, type AskFailure, type AskTransport } from '../cad/ask';
import { describe, type Refusal } from '../make/printJob/allowlist';
import { askPrint, type PrintProposal } from '../make/printJob/ai';
import { QUESTIONS, type Question } from '../make/printJob/chips';
import { applyAnswer } from '../make/printJob/job';
import { OBJECTIVES, STRATEGIES, typeOfPreset, type Objective, type SlotDecl, type Strategy } from './model';
import { actionText, type LayoutAction } from './layout3d';

export interface AssistantProps {
  overrides: Record<string, string>;
  setOverrides: (next: Record<string, string>) => void;
  jobName: string;
  hasParts: boolean;
  /** "AMS slot 3 (PETG)" for the slots the job uses. Data for the model. */
  slotText: string | null;
  strategy: Strategy;
  objective: Objective;
  allowTilt: boolean;
  /** Re-plan / re-slice with one of these changed. Resolves to a plain sentence. */
  onArrange: (o: { strategy?: Strategy; objective?: Objective; allowTilt?: boolean }) => Promise<string>;
  onReset: () => Promise<string>;
  /** Who placed the parts now: this app, or the bridge (a strategy/objective the person chose). */
  layout: 'app' | 'bridge';
  /** Do checked layout actions; resolves to a plain sentence. */
  onLayout: (actions: LayoutAction[]) => Promise<string>;
  /** The rows of the job, in list order (part n = row n). Data for the model. */
  parts: { name: string; size: string; plate: number | null }[];
  processes: string[];
  process: string;
  setProcess: (name: string) => void;
  filaments: string[];
  /** Declared slots the job uses. */
  slotsInUse: SlotDecl[];
  slotPresets: Record<string, string>;
  setSlotPreset: (slot: string, preset: string) => void;
  /** Injected in tests. */
  transport?: AskTransport;
}

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; text: string; notes?: { text: string; tone?: 'warn' | 'bad' }[] }
  | { id: number; role: 'ai'; question: Question }
  | { id: number; role: 'ai'; arrange: true }
  | { id: number; role: 'ai'; presets: true }
  | { id: number; role: 'ai'; proposal: PrintProposal; prompt: string; applied: boolean };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

interface Entry {
  id: number;
  qid: string | null;
  title: string;
  why: string;
  risk: string;
  items: { key: string; to: string }[];
  before: Record<string, string | undefined>;
}

let seq = 0;

function readCfg(): AskConfig {
  try {
    return readAskConfig(globalThis.localStorage);
  } catch {
    return readAskConfig(null);
  }
}

const refusedText = (r: Refusal[]) => r.map((x) => `${x.key}: ${x.why}`).join('; ');

export function Assistant(p: AssistantProps) {
  const { transport = fetchTransport } = p;
  const [cfg, setCfg] = useState<AskConfig>(readCfg);
  const [setup, setSetup] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: ++seq,
      role: 'ai',
      text: 'Hi. Pick a question above, or tell me in your own words what you want to change (for example: make it stronger, print it quick, is support needed?). If you do not know an answer, I will offer choices.',
    },
  ]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const overridesRef = useRef(p.overrides);
  overridesRef.current = p.overrides;
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const say = (m: NewMsg) => setMsgs((xs) => [...xs, { ...m, id: ++seq } as Msg]);
  const connected = askConfigured(cfg);

  // Entries whose values were changed again later are trimmed: an Undo must never put back a value over someone else's change.
  const live = entries
    .map((e) => ({ ...e, items: e.items.filter((it) => p.overrides[it.key] === it.to) }))
    .filter((e) => e.items.length);

  const commit = (accepted: Record<string, string>, meta: { qid?: string; title: string; why?: string; risk?: string }): Entry | null => {
    const keys = Object.keys(accepted);
    if (!keys.length) return null;
    let cur = { ...overridesRef.current };
    let list = entries;
    if (meta.qid) {
      const old = list.find((e) => e.qid === meta.qid);
      if (old) {
        for (const it of old.items) {
          if (cur[it.key] !== it.to) continue;
          if (old.before[it.key] === undefined) delete cur[it.key];
          else cur[it.key] = old.before[it.key]!;
        }
        list = list.filter((e) => e !== old);
      }
    }
    const before: Record<string, string | undefined> = {};
    for (const k of keys) before[k] = cur[k];
    cur = { ...cur, ...accepted };
    const entry: Entry = { id: ++seq, qid: meta.qid ?? null, title: meta.title, why: meta.why ?? '', risk: meta.risk ?? '', items: keys.map((k) => ({ key: k, to: accepted[k] })), before };
    setEntries([...list, entry]);
    overridesRef.current = cur;
    p.setOverrides(cur);
    return entry;
  };

  const undo = (id: number, quiet = false) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    const cur = { ...overridesRef.current };
    const kept: string[] = [];
    for (const it of e.items) {
      if (cur[it.key] !== it.to) {
        kept.push(it.key);
        continue;
      }
      if (e.before[it.key] === undefined) delete cur[it.key];
      else cur[it.key] = e.before[it.key]!;
    }
    overridesRef.current = cur;
    p.setOverrides(cur);
    setEntries((xs) => xs.filter((x) => x.id !== id));
    if (!quiet) say({ role: 'ai', text: `Undone: ${e.title}.${kept.length ? ` Kept ${kept.join(', ')} because a later change set it.` : ''}` });
  };

  const undoAll = () => {
    const cur = { ...overridesRef.current };
    for (const e of [...entries].reverse()) {
      for (const it of e.items) {
        if (cur[it.key] !== it.to) continue;
        if (e.before[it.key] === undefined) delete cur[it.key];
        else cur[it.key] = e.before[it.key]!;
      }
    }
    overridesRef.current = cur;
    p.setOverrides(cur);
    setEntries([]);
    say({ role: 'ai', text: 'Everything the assistant changed is undone: the settings are back to the profile values.' });
  };

  const answer = (q: Question, answerId: string) => {
    const r = applyAnswer(q.id, answerId);
    if (!r) return;
    say({ role: 'user', text: `${q.title} ${r.answer.label}` });
    if (r.refused.length) {
      say({ role: 'ai', text: `Not applied: ${refusedText(r.refused)}.`, notes: r.answer.risk ? [{ text: `Watch out: ${r.answer.risk}`, tone: 'warn' }] : [] });
      return;
    }
    if (r.noSetting) {
      say({ role: 'ai', text: r.answer.why, notes: r.answer.risk ? [{ text: `Watch out: ${r.answer.risk}`, tone: 'warn' }] : [] });
      return;
    }
    commit(r.accepted, { qid: q.id, title: `${q.title} ${r.answer.label}`, why: r.answer.why, risk: r.answer.risk });
    say({
      role: 'ai',
      text: `${r.answer.why} Changed: ${Object.entries(r.accepted).map(([k, v]) => describe(k, v)).join(', ')}.`,
      notes: r.answer.risk ? [{ text: `Watch out: ${r.answer.risk}`, tone: 'warn' }] : [],
    });
  };

  const arrange = async (o: { strategy?: Strategy; objective?: Objective; allowTilt?: boolean }, label: string) => {
    if (!p.hasParts) {
      say({ role: 'ai', text: 'There are no parts in the job yet: drop an STL file first.' });
      return;
    }
    say({ role: 'user', text: label });
    setBusy(true);
    try {
      say({ role: 'ai', text: await p.onArrange(o) });
    } catch (e) {
      say({ role: 'ai', text: `That did not work: ${e instanceof Error ? e.message : String(e)}`, notes: [] });
    } finally {
      setBusy(false);
    }
  };

  const layoutDo = async (actions: LayoutAction[], label: string) => {
    if (!p.hasParts) {
      say({ role: 'ai', text: 'There are no parts in the job yet: open a design in 3d first.' });
      return;
    }
    say({ role: 'user', text: label });
    setBusy(true);
    try {
      say({ role: 'ai', text: await p.onLayout(actions) });
    } catch (e) {
      say({ role: 'ai', text: `That did not work: ${e instanceof Error ? e.message : String(e)}`, notes: [] });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!p.hasParts) return;
    say({ role: 'user', text: 'Back to the automatic arrangement' });
    setBusy(true);
    try {
      say({ role: 'ai', text: await p.onReset() });
    } finally {
      setBusy(false);
    }
  };

  const failureText = (f: AskFailure) => `${f.headline}. ${f.detail} Nothing was changed.`;

  const ask = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    say({ role: 'user', text });
    setPrompt('');
    setBusy(true);
    abort.current = new AbortController();
    const out = await askPrint({
      cfg,
      prompt: text,
      ctx: { design: p.jobName, slot: p.slotText, current: overridesRef.current, parts: p.parts },
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      transport,
      signal: abort.current.signal,
    });
    setBusy(false);
    if (!out.ok) {
      say({ role: 'ai', text: failureText(out.failure), notes: [] });
      return;
    }
    say({ role: 'ai', proposal: out.proposal, prompt: text, applied: false });
  };

  const applyProposal = async (m: Extract<Msg, { proposal: PrintProposal }>) => {
    const e = commit(m.proposal.accepted, {
      title: `Asked: ${m.prompt.slice(0, 60)}`,
      why: Object.values(m.proposal.reasons).join(' '),
    });
    setMsgs((xs) => xs.map((x) => (x.id === m.id ? { ...m, applied: true } : x)));
    if (e) say({ role: 'ai', text: `Applied: ${Object.entries(m.proposal.accepted).map(([k, v]) => describe(k, v)).join(', ')}. The plates slice again with it.` });
    if (m.proposal.actions.length) {
      setBusy(true);
      try {
        say({ role: 'ai', text: await p.onLayout(m.proposal.actions) });
      } catch (err) {
        say({ role: 'ai', text: `That did not work: ${err instanceof Error ? err.message : String(err)}`, notes: [] });
      } finally {
        setBusy(false);
      }
    }
  };

  const patchCfg = (patch: Partial<AskConfig>) =>
    setCfg((c) => {
      const next = { ...c, ...patch };
      try {
        writeAskConfig(next, globalThis.localStorage);
      } catch {
        /* storage off */
      }
      return next;
    });

  const strategyLabel = STRATEGIES.find((s) => s.id === p.strategy)?.label ?? p.strategy;
  const objectiveLabel = OBJECTIVES.find((o) => o.id === p.objective)?.label ?? p.objective;

  return (
    <section className="p3d-panel p3d-chat" aria-label="Print assistant" data-testid="p3d-assistant">
      <div className="p3d-chat-head">
        <h3>Print assistant</h3>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="p3d-chat-clear"
          disabled={entries.length === 0 && !abort.current}
          onClick={() => {
            abort.current?.abort();
            setEntries([]);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="p3d-ai-status"
          onClick={() => setSetup((s) => !s)}
          title="AI connection settings"
          data-testid="p3d-ai-status"
        >
          <span className={`p3d-dot ${connected ? 'p3d-up' : 'p3d-down'}`} aria-hidden="true" />
          {connected ? 'AI ready' : 'AI not set up'}
        </button>
      </div>
      {setup && (
        <div className="p3d-ai-setup">
          <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
        </div>
      )}
      <div className="p3d-qs" role="group" aria-label="Questions">
        <button type="button" className="p3d-qbtn" onClick={() => say({ role: 'ai', arrange: true })} data-testid="p3d-chip-arrange">
          Arrange the plates
        </button>
        <button type="button" className="p3d-qbtn" onClick={() => say({ role: 'ai', presets: true })} data-testid="p3d-chip-presets">
          Process and filaments
        </button>
        {QUESTIONS.map((q) => (
          <button key={q.id} type="button" className="p3d-qbtn" onClick={() => say({ role: 'ai', question: q })} data-testid={`p3d-q-${q.id}`}>
            {q.title}
          </button>
        ))}
      </div>

      <div className="p3d-log" ref={log} role="log" aria-live="polite" tabIndex={0} data-testid="p3d-log">
        {msgs.map((m) => (
          <div key={m.id} className={`p3d-msg ${m.role === 'user' ? 'p3d-user' : ''}`}>
            {'text' in m && <p className="p3d-text">{m.text}</p>}
            {'notes' in m && m.notes?.map((n, i) => <p key={i} className={`p3d-note ${n.tone ? `p3d-${n.tone}` : ''}`}>{n.text}</p>)}
            {'question' in m && (
              <>
                <p className="p3d-text">{m.question.ask}</p>
                <p className="p3d-note">{m.question.help}</p>
                <div className="p3d-chips" role="group" aria-label={`Answers to ${m.question.title}`}>
                  {m.question.answers.map((a) => (
                    <button key={a.id} type="button" className="p3d-chip" title={a.why} onClick={() => answer(m.question, a.id)} data-testid={`p3d-a-${m.question.id}-${a.id}`}>
                      {a.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            {'arrange' in m && (
              <>
                <p className="p3d-text">
                  {p.layout === 'app' ? (
                    <>Now: separated, laid flat and arranged by this app, 5 mm apart, centred. How should the parts be laid out?</>
                  ) : (
                    <>
                      Now: {strategyLabel}, arranged for {objectiveLabel}
                      {p.allowTilt ? '; tall slender parts may be laid on their side' : '; every part stays upright'}. How should the parts be laid out?
                    </>
                  )}
                </p>
                <div className="p3d-chips" role="group" aria-label="Layout">
                  <button type="button" className="p3d-chip" disabled={busy} onClick={() => void layoutDo([{ do: 'separate' }], 'Separate the objects')} data-testid="p3d-lay-separate">
                    Separate the objects
                  </button>
                  <button type="button" className="p3d-chip" disabled={busy} onClick={() => void layoutDo([{ do: 'lay_flat', part: null }], 'Lay every part flat')} data-testid="p3d-lay-flat">
                    Lay every part flat
                  </button>
                  <button type="button" className="p3d-chip" disabled={busy} aria-pressed={p.layout === 'app'} onClick={() => void layoutDo([{ do: 'arrange' }], 'Arrange the parts')} data-testid="p3d-lay-arrange">
                    Arrange the parts
                  </button>
                </div>
                <div className="p3d-chips" role="group" aria-label="Arrangement">
                  {OBJECTIVES.map((o) => (
                    <button key={o.id} type="button" className="p3d-chip" disabled={busy} aria-pressed={p.layout === 'bridge' && p.objective === o.id} onClick={() => void arrange({ objective: o.id }, o.label)} data-testid={`p3d-obj-${o.id}`}>
                      {o.label}
                    </button>
                  ))}
                  {STRATEGIES.map((s) => (
                    <button key={s.id} type="button" className="p3d-chip" disabled={busy} aria-pressed={p.layout === 'bridge' && p.strategy === s.id} onClick={() => void arrange({ strategy: s.id }, s.label)} data-testid={`p3d-strat-${s.id}`}>
                      {s.label}
                    </button>
                  ))}
                  <button type="button" className="p3d-chip" disabled={busy} onClick={() => void arrange({ allowTilt: !p.allowTilt }, p.allowTilt ? 'Keep every part upright' : 'Tall parts may lie on their side')}>
                    {p.allowTilt ? 'Keep every part upright' : 'Tall parts may lie on their side'}
                  </button>
                  <button type="button" className="p3d-chip" disabled={busy} onClick={() => void reset()}>
                    Back to automatic
                  </button>
                </div>
              </>
            )}
            {'presets' in m && (
              <div className="p3d-presets">
                <p className="p3d-text">The process sets layer height and speeds; each filament slot in use gets a filament preset.</p>
                <label>
                  Process
                  <select value={p.process} onChange={(e) => p.setProcess(e.target.value)} data-testid="p3d-process">
                    {p.processes.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                {p.slotsInUse.length === 0 && <p className="p3d-note">Add a part first: presets are chosen per filament slot in use.</p>}
                {p.slotsInUse.map((s) => {
                  const cur = p.slotPresets[s.id] ?? '';
                  const mismatch = cur && typeOfPreset(cur) && typeOfPreset(cur) !== s.type;
                  return (
                    <label key={s.id}>
                      {s.label} ({s.type || 'nothing declared'})
                      <select value={cur} onChange={(e) => p.setSlotPreset(s.id, e.target.value)} data-testid={`p3d-preset-${s.id}`}>
                        <option value="">Automatic (Generic {s.type || '…'})</option>
                        {p.filaments.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      {mismatch && <span className="p3d-warn">The preset looks like {typeOfPreset(cur)} but the slot holds {s.type}.</span>}
                    </label>
                  );
                })}
              </div>
            )}
            {'proposal' in m && (
              <div data-testid="p3d-proposal">
                {!m.proposal.parsed && <p className="p3d-text p3d-bad">The model did not answer in the agreed form, so nothing from it can be applied.</p>}
                {m.proposal.reply && <p className="p3d-text">{m.proposal.reply}</p>}
                {m.proposal.scrubbed > 0 && (
                  <p className="p3d-note" data-testid="p3d-scrubbed">
                    {m.proposal.scrubbed} sentence{m.proposal.scrubbed === 1 ? '' : 's'} naming another program removed from the answer: everything is done here.
                  </p>
                )}
                {(Object.keys(m.proposal.accepted).length > 0 || m.proposal.actions.length > 0) && (
                  <>
                    {m.proposal.actions.length > 0 && (
                      <ul className="p3d-items" data-testid="p3d-proposal-actions">
                        {m.proposal.actions.map((a, i) => (
                          <li key={i}>
                            <span className="p3d-to">{actionText(a)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <ul className="p3d-items">
                      {Object.entries(m.proposal.accepted).map(([k, v]) => (
                        <li key={k}>
                          <span className="p3d-to">{describe(k, v)}</span>
                          {m.proposal.reasons[k] && <span className="p3d-why"> — {m.proposal.reasons[k]}</span>}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="p3d-send" disabled={m.applied || busy} onClick={() => void applyProposal(m)} data-testid="p3d-apply">
                      {m.applied ? 'Applied' : 'Apply'}
                    </button>
                  </>
                )}
                {m.proposal.refused.length > 0 && <p className="p3d-note p3d-warn">Refused, never applied: {refusedText(m.proposal.refused)}</p>}
                {m.proposal.questions.map((q, i) => (
                  <div key={i}>
                    <p className="p3d-text">{q.text}</p>
                    <div className="p3d-chips">
                      {q.chips.map((c, j) => (
                        <button
                          key={j}
                          type="button"
                          className="p3d-chip"
                          disabled={!Object.keys(c.accepted).length}
                          title={c.refused.length ? `Refused: ${refusedText(c.refused)}` : undefined}
                          onClick={() => {
                            say({ role: 'user', text: c.label });
                            if (commit(c.accepted, { title: c.label })) say({ role: 'ai', text: `Changed: ${Object.entries(c.accepted).map(([k, v]) => describe(k, v)).join(', ')}.` });
                          }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="p3d-msg p3d-wait">Working…</div>}
      </div>

      <form
        className="p3d-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label className="p3d-label" htmlFor="p3d-ask">
          Tell me what you want
        </label>
        <textarea
          id="p3d-ask"
          className="p3d-input"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder={connected ? 'Ask in your own words, e.g. "make it stronger" or "is a brim needed?"' : 'Set up the AI first (the dot above), or use the questions'}
          disabled={busy}
          data-testid="p3d-ask"
        />
        <div className="p3d-row">
          <button type="submit" className="p3d-send" disabled={busy || !prompt.trim()} data-testid="p3d-send">
            Send
          </button>
          <span className="p3d-hint">Enter sends, Shift+Enter adds a line</span>
        </div>
      </form>

      <details className="p3d-det" open>
        <summary>Applied settings{live.length ? ` (${live.length})` : ''}</summary>
        <div className="p3d-applied" data-testid="p3d-applied">
          {live.length === 0 && <p className="p3d-empty">Nothing changed yet. Settings you accept appear here, and each one can be undone.</p>}
          {live.map((e) => (
            <div key={e.id} className="p3d-entry">
              <div className="p3d-entry-head">
                <strong>{e.title}</strong>
                <button type="button" onClick={() => undo(e.id)} aria-label={`Undo ${e.title}`}>
                  Undo
                </button>
              </div>
              <ul className="p3d-items">
                {e.items.map((it) => (
                  <li key={it.key}>
                    <span className="p3d-from">{e.before[it.key] === undefined ? 'profile value' : describe(it.key, e.before[it.key]!)}</span>
                    <span className="p3d-arrow"> → </span>
                    <span className="p3d-to">{describe(it.key, it.to)}</span>
                  </li>
                ))}
              </ul>
              {e.why && <p className="p3d-why">{e.why}</p>}
              {e.risk && <p className="p3d-risk">Watch out: {e.risk}</p>}
            </div>
          ))}
          <button type="button" onClick={undoAll} disabled={!live.length}>
            Undo all
          </button>
        </div>
      </details>
    </section>
  );
}
