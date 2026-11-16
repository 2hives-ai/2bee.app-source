/**
 * 2bee.cnc — the chat. Founder 2026-10-15: *"The 2bee.cnc should be the same
 * concept as the 2bee.cad … have a chat window and have a cnc view, that is all."*
 *
 * The SAME pipeline as `CncAskPanel` (option B, 2026-10-12), not a looser one:
 * the model proposes a settings patch → `readJobProposal` refuses anything
 * outside `jobAsk.ts`'s rules → the CORE re-plans the candidate → only a plan
 * the core accepts (`mayApplyJob`) is applied. Nothing here writes G-code, and
 * the model cannot change the machine, workpiece, material or clamps.
 *
 * ⚠ Applied without a second click, as in 2bee.cad (founder 2026-08-11, "no
 * extra click needed"), because the click it replaces came AFTER the core had
 * already accepted the plan. Every applied change has an Undo, which applies
 * the inverse patch through the same `onApply` (the same store fields the
 * Operation panel sets), so an undo is re-planned like any other change.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import type { JobConfig } from '../cam';
import {
  buildJobRequest,
  candidateConfig,
  mayApplyJob,
  patchIsEmpty,
  patchRows,
  readJobProposal,
  type JobContext,
  type JobPatch,
} from './jobAsk';
import type { PlanOutcome } from './CncAskPanel';

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'undone' | 'note'; text: string; notes: string[]; undo?: JobPatch };

type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

/**
 * Suggestions for THIS job (founder 2026-10-15: "the recommendations for the AI
 * assistant should be relevant to the loaded scad"). First a local reading of
 * the plan (refusals, tabs off, many passes), shown at once; then the model's
 * own three, asked once per loaded design, replace them when they arrive.
 * A chip is only a prompt: pressing it goes through the same checked pipeline.
 */
function localSuggestions(context: JobContext): string[] {
  const out: string[] = [];
  const r = context.plan.refusals[0];
  if (r) out.push(`Fix this: ${r.length > 70 ? `${r.slice(0, 67)}…` : r}`);
  if (context.op.tabs_enabled === false) out.push('Add tabs so the parts stay put');
  if (typeof context.op.depth_per_pass_mm === 'number' && context.op.depth_per_pass_mm < 2) out.push('Fewer, deeper passes if the cutter allows');
  if (context.plan.warnings[0]) out.push(`Deal with: ${context.plan.warnings[0].slice(0, 60)}`);
  out.push('Make it cut faster but safely');
  return out.slice(0, 3);
}

const SUGGEST_SYSTEM = [
  'You suggest what an operator might ask to change in THIS CNC routing job.',
  'Use the job context: the loaded design names, the plan refusals and warnings, the operation settings and the cutters.',
  'Answer with ONE JSON object and nothing else: {"suggestions": ["...", "...", "..."]}.',
  'Exactly three, each under 9 words, each a request about operation settings or cutters only (not the machine, stock or clamps).',
].join('\n');

export interface CncChatProps {
  config: JobConfig;
  context: JobContext;
  current: PlanOutcome | null;
  planCandidate(config: JobConfig): Promise<PlanOutcome>;
  onApply(patch: JobPatch): void;
  /** The design chooser, rendered at the top of the chat. */
  designs: ReactNode;
  /** True when no drawing is loaded: there is nothing to plan yet. */
  empty: boolean;
  /** Names of the loaded design(s); a change asks for new suggestions. */
  designKey: string;
  /** How many cutters cnc.tools holds as owned. 0 ⇒ the AI proposes one to register. */
  ownedTools: number;
  onOpenTools(): void;
  /** "add clamps": the AI picks type + count, the app computes positions. Resolves to the sentence to show. */
  onAddClamps?: (text: string) => Promise<string>;
  /** Register a CATALOGUE cutter as owned (cnc.tools). Resolves to null on success, else why not. */
  onRegisterTool?: (id: string) => Promise<string | null>;
  /** A request sent on the user's behalf (the gates' "Fix with AI"); each new nonce sends once. */
  autoAsk?: { nonce: number; text: string } | null;
  transport?: AskTransport;
}

/** The patch that puts back what `patch` changed. */
function inverseOf(context: JobContext, patch: JobPatch): JobPatch {
  const op: JobPatch['op'] = {};
  for (const k of Object.keys(patch.op) as (keyof JobContext['op'])[]) op[k] = context.op[k];
  return { op, ...(patch.tool_ids ? { tool_ids: [...context.toolIds] } : {}) };
}

export function CncChat({ config, context, current, planCandidate, onApply, designs, empty, designKey, ownedTools, onOpenTools, autoAsk = null, onRegisterTool, onAddClamps, transport = fetchTransport }: CncChatProps) {
  /* The SAME endpoint settings as 2bee.cad and CncAskPanel (`ASK_CONFIG_KEY`). */
  const [cfg, setCfg] = useState<AskConfig>(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  });
  const onPatch = (p: Partial<AskConfig>) =>
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
  const [busy, setBusy] = useState<'' | 'asking' | 'planning'>('');
  const [setup, setSetup] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const connected = askConfigured(cfg);

  useEffect(() => () => abort.current?.abort(), []);

  const [aiChips, setAiChips] = useState<{ key: string; list: string[] } | null>(null);
  const ctxRef = useRef(context);
  ctxRef.current = context;
  useEffect(() => {
    if (!designKey || !askConfigured(cfg)) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    const base = buildJobRequest(cfg, '(suggest three requests for this job)', ctxRef.current);
    const req = {
      ...base,
      body: {
        ...base.body,
        messages: [
          { role: 'system' as const, content: SUGGEST_SYSTEM },
          { role: 'user' as const, content: `Loaded design(s): ${designKey}\n\n${base.body.messages[1].content}` },
        ],
      },
    };
    void transport(req, ctl.signal)
      .then((res) => {
        const r = readReply(res);
        if (!r.ok) return;
        const m = /\{[\s\S]*\}/.exec(r.raw);
        const v = m ? (JSON.parse(m[0]) as { suggestions?: unknown }) : null;
        const list = Array.isArray(v?.suggestions)
          ? (v!.suggestions as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 80).slice(0, 3)
          : [];
        if (list.length) setAiChips({ key: designKey, list });
      })
      .catch(() => {
        /* Suggestions are a convenience: the local ones stay. */
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designKey, cfg.endpoint, cfg.model]);
  const chips = aiChips && aiChips.key === designKey ? aiChips.list : localSuggestions(context);

  /* No owned cutter: ask once per design which cutter to REGISTER. Text only;
   * the person adds it in cnc.tools (measured), nothing is added from here. */
  /* Founder 2026-10-16: "I have asked to create the required tools in the cnc". The
   * planner can only plan with cutters in ITS catalogue (context.library), so the
   * model picks ONE catalogue id for this design and the human (or Fix with AI)
   * registers it in cnc.tools with one click. A made-up cutter would not plan. */
  const [toolIdea, setToolIdea] = useState<{ key: string; text: string; id: string | null } | null>(null);
  const [registerNote, setRegisterNote] = useState('');
  useEffect(() => {
    if (ownedTools > 0 || !designKey || !askConfigured(cfg)) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    const base = buildJobRequest(cfg, '(choose a cutter)', ctxRef.current);
    const req = {
      ...base,
      body: {
        ...base.body,
        messages: [
          {
            role: 'system' as const,
            content:
              'The shop has NO cutters registered. Choose the ONE cutter from the library that best suits this job (the "library" ids in the context are the only valid answers). Answer JSON only: {"id": "<library id>", "why": "<one short sentence>"}.',
          },
          { role: 'user' as const, content: `Loaded design(s): ${designKey}\n\n${base.body.messages[1].content}` },
        ],
      },
    };
    void transport(req, ctl.signal)
      .then((res) => {
        const r = readReply(res);
        if (!r.ok) return;
        const id = /"id"\s*:\s*"([^"]+)"/.exec(r.raw)?.[1] ?? null;
        const why = /"why"\s*:\s*"([^"]*)"/.exec(r.raw)?.[1] ?? '';
        const valid = id && ctxRef.current.library.includes(id) ? id : null;
        setToolIdea({ key: designKey, id: valid, text: valid ? `${valid}${why ? ` — ${why}` : ''}` : r.raw.trim().slice(0, 300) });
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownedTools, designKey, cfg.endpoint, cfg.model]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, busy]);

  const lastUndoable = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'ai' && m.undo) return m.id;
    }
    return -1;
  }, [msgs]);

  const push = (m: NewMsg) => setMsgs((old) => [...old, { ...m, id: nextId.current++ } as Msg]);

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ role: 'user', text: ask });
    setPrompt('');
    /* Clamps are not a job setting: route "add/create clamps" to the clamp path. */
    if (onAddClamps && /\bclamps?\b/i.test(ask) && /\b(add|create|place|put|declare|use)\b/i.test(ask)) {
      setBusy('asking');
      try {
        const said = await onAddClamps(ask);
        push({ role: 'ai', tone: /^Added/.test(said) ? 'ok' : 'bad', text: said, notes: [] });
      } finally {
        setBusy('');
      }
      return;
    }
    const pre = preflight(cfg, ask, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) {
      push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail] });
      return;
    }
    setBusy('asking');
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const res = await transport(buildJobRequest(cfg, ask, context), ctl.signal);
      const r = readReply(res);
      if (!r.ok) {
        push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. The job is unchanged.`, notes: [r.failure.detail] });
        return;
      }
      const p = readJobProposal(r.raw, context);
      if (!p.ok) {
        push({ role: 'ai', tone: 'bad', text: 'Not changed: the proposal broke the rules.', notes: p.problems });
        return;
      }
      if (patchIsEmpty(p.patch)) {
        push({ role: 'ai', tone: 'note', text: p.why || 'No change needed.', notes: p.unchanged.length ? [`Already as asked: ${p.unchanged.join(', ')}`] : [] });
        return;
      }
      setBusy('planning');
      let candidate: PlanOutcome | null = null;
      let planError: string | null = null;
      try {
        candidate = await planCandidate(candidateConfig(config, p.patch));
      } catch (e) {
        planError = String(e instanceof Error ? e.message : e);
      }
      const rows = patchRows(context.op, context.toolIds, p.patch);
      const changes = rows.map((x) => `${x.label}: ${x.from} → ${x.to}`);
      if (!mayApplyJob(candidate, p.patch)) {
        push({
          role: 'ai',
          tone: 'bad',
          text: 'Not changed: the planner refused this.',
          notes: [...changes, ...(candidate?.refusals ?? []), ...(planError ? [planError] : [])],
        });
        return;
      }
      const undo = inverseOf(context, p.patch);
      onApply(p.patch);
      push({
        role: 'ai',
        tone: 'ok',
        text: `Done. ${p.why}`.trim(),
        notes: [...changes, ...(candidate?.warnings ?? [])],
        undo,
      });
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: `${f.headline}. The job is unchanged.`, notes: [f.detail] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy('');
    }
  };

  const lastAuto = useRef(0);
  useEffect(() => {
    if (!autoAsk || autoAsk.nonce === lastAuto.current) return;
    lastAuto.current = autoAsk.nonce;
    void send(autoAsk.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk?.nonce]);

  const undo = (id: number, patch: JobPatch) => {
    onApply(patch);
    setMsgs((old) => old.map((m) => (m.id === id && m.role === 'ai' ? { ...m, tone: 'undone', undo: undefined, text: `Undone. ${m.text.replace(/^Done\.\s*/, '')}` } : m)));
  };

  return (
    <section className="cad-chat" aria-label="CNC assistant" data-testid="cnc-chat">
      <header className="cad-chat-head">
        <strong>CNC assistant</strong>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="cnc-chat-clear"
          disabled={msgs.length === 0 && !abort.current}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
        <button type="button" className="cad-chat-status" data-testid="cnc-chat-status" onClick={() => setSetup((s) => !s)} title="AI connection settings">
          <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
          {connected ? 'AI ready' : 'Connect AI'}
        </button>
      </header>

      <div className="cnc-chat-designs">{designs}</div>

      {setup ? (
        <div className="cad-chat-setup">
          <AskSettings cfg={cfg} onPatch={onPatch} onClose={() => setSetup(false)} />
        </div>
      ) : null}

      <div className="cad-chat-log" ref={log} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cad-chat-msg ai">
            {empty ? (
              'Pick a design above. Then tell me what to change in the job: cutter, depth, passes, tabs.'
            ) : connected ? (
              'Tell me what to change in the job. The planner checks every change before it is used.'
            ) : (
              <>
                The AI is not connected yet.{' '}
                {setup ? null : (
                  <button type="button" className="cad-chat-undo" data-testid="cnc-chat-connect" onClick={() => setSetup(true)}>
                    Set up AI
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
        {ownedTools === 0 && !empty ? (
          <div className="cad-chat-msg ai bad" data-testid="cnc-chat-no-tools">
            No cutter is registered in cnc.tools, so nothing can be planned for real.
            {toolIdea && toolIdea.key === designKey ? (
              <>
                {' '}A cutter that would suit this design:
                <ul>
                  <li>{toolIdea.text}</li>
                </ul>
              </>
            ) : connected ? (
              ' Asking which cutter suits this design…'
            ) : null}
            <div className="cnc-chat-tool-actions">
              {toolIdea && toolIdea.key === designKey && toolIdea.id && onRegisterTool ? (
                <button
                  type="button"
                  className="primary"
                  data-testid="cnc-chat-register-tool"
                  onClick={() => void onRegisterTool(toolIdea.id!).then((why) => setRegisterNote(why ?? `Added ${toolIdea.id} to cnc.tools. Confirm you have it and measure it there.`))}
                >
                  Add {toolIdea.id} to cnc.tools
                </button>
              ) : null}
              <button type="button" className="cad-chat-undo" onClick={onOpenTools} data-testid="cnc-chat-open-tools">
                Open cnc.tools
              </button>
            </div>
            {registerNote ? <div className="note">{registerNote}</div> : null}
          </div>
        ) : null}
        {msgs.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="cad-chat-msg user">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="cnc-chat-reply">
              <div>{m.text}</div>
              {m.notes.length ? (
                <ul>
                  {m.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {m.undo && m.id === lastUndoable ? (
                <button type="button" className="cad-chat-undo" data-testid="cnc-chat-undo" onClick={() => undo(m.id, m.undo!)}>
                  Undo
                </button>
              ) : null}
            </div>
          ),
        )}
        {busy ? <div className="cad-chat-msg ai busy">{busy === 'asking' ? 'Thinking…' : 'Checking the plan…'}</div> : null}
      </div>

      {connected && !empty && !busy ? (
        <div className="cad-chat-chips" data-testid="cnc-chat-chips">
          {chips.map((s) => (
            <button key={s} type="button" disabled={!!busy} onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {current ? (
        <p className="note cnc-chat-plan" data-testid="cnc-chat-plan">
          {current.ok && current.refusals.length === 0
            ? `Plan OK · ${current.lines} lines · ${Math.floor(current.seconds / 60)}:${String(Math.round(current.seconds % 60)).padStart(2, '0')}`
            : `Plan refused: ${current.refusals[0] ?? 'see details'}`}
        </p>
      ) : null}

      <form
        className="cad-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(prompt);
        }}
      >
        <textarea
          data-testid="cnc-chat-prompt"
          rows={2}
          value={prompt}
          placeholder={connected ? 'Describe the change…' : 'Connect the AI first'}
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
          <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="cnc-chat-send">
            Send
          </button>
        )}
      </form>
    </section>
  );
}

export default CncChat;
