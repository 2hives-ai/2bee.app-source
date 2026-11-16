/**
 * 2bee.pnp — the chat. Founder 2026-10-15: *"the pnp should be the same concept
 * (left side AI agent, on top select the pcb) below the 3d have the machine"*.
 *
 * The same pipeline as CncChat / MachinesTab: the model answers and may propose
 * a patch → `readPnpProposal` refuses anything outside the board count and the
 * trays → the tab re-runs `preflight` on the candidate → only a candidate
 * `mayApplyPnp` accepts is applied, with an Undo that applies the inverse patch
 * through the same `onApply`. Nothing here talks to a machine.
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
import type { PreflightResult } from './manifest';
import {
  buildPnpRequest,
  mayApplyPnp,
  patchIsEmpty,
  pnpRows,
  readPnpProposal,
  type PnpContext,
  type PnpPatch,
  type PnpSettings,
} from './pnpAsk';

type Plan = PreflightResult | string | null;
type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'undone' | 'note'; text: string; notes: string[]; undo?: PnpPatch };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

export interface PnpChatProps {
  context: PnpContext;
  /** Re-run the tray plan on candidate settings — the tab's own check. */
  evaluate(settings: PnpSettings): Plan;
  onApply(patch: PnpPatch): void;
  /** The board chooser, rendered at the top of the chat. */
  picker: ReactNode;
  /** A link to the expert view, in the header. */
  expert: ReactNode;
  /** A question sent as if typed (the gates' "Fix with AI"); a new `nonce` sends it again. */
  autoAsk?: { nonce: number; text: string } | null;
  transport?: AskTransport;
}

/** Chips from THIS board's plan. A chip is only a prompt: it goes through the same checks. */
export function localSuggestions(c: PnpContext): string[] {
  const out: string[] = [];
  const r = c.result;
  if (!c.board) return ['Which board has the most parts?'];
  if (r && typeof r !== 'string') {
    const first = r.refusals[0];
    if (first) out.push(`Explain: ${first.message.length > 60 ? `${first.message.slice(0, 57)}…` : first.message}`);
    if (r.exit === 0) out.push(`Can I build ${c.settings.boards * 5} boards with these trays?`);
  }
  out.push('Which parts will I place by hand?');
  return out.slice(0, 3);
}

function inverseOf(s: PnpSettings, patch: PnpPatch): PnpPatch {
  return {
    ...(patch.boards !== undefined ? { boards: s.boards } : {}),
    ...(patch.trays !== undefined ? { trays: s.trays.map((t) => ({ ...t })) } : {}),
  };
}

export function PnpChat({ context, evaluate, onApply, picker, expert, autoAsk = null, transport = fetchTransport }: PnpChatProps) {
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
  /* The board and settings ON SCREEN now, read when a reply lands. 🔴 The board picker stays
   * live while the model works: a reply checked against board A was applied to board B and
   * reported "Done. Plan: MANIFEST OK." about A (bughunt 2026-11-15). */
  const onScreen = useRef(context);
  onScreen.current = context;
  const log = useRef<HTMLDivElement>(null);
  const connected = askConfigured(cfg);

  useEffect(() => () => abort.current?.abort(), []);
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
  const chips = localSuggestions(context);

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ role: 'user', text: ask });
    setPrompt('');
    const pre = preflight(cfg, ask, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) {
      push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail] });
      return;
    }
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const r = readReply(await transport(buildPnpRequest(cfg, ask, context), ctl.signal));
      if (!r.ok) {
        push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. The plan is unchanged.`, notes: [r.failure.detail] });
        return;
      }
      if (onScreen.current.board !== context.board || JSON.stringify(onScreen.current.settings) !== JSON.stringify(context.settings)) {
        push({ role: 'ai', tone: 'bad', text: 'Not changed: the board or the tray settings changed while the AI was working.', notes: ['Its answer was checked against what you asked about. Ask again for this board.'] });
        return;
      }
      const p = readPnpProposal(r.raw, context.settings, context.vspec);
      if (!p.ok) {
        push({ role: 'ai', tone: 'bad', text: 'Not changed: the proposal broke the rules.', notes: p.problems });
        return;
      }
      if (patchIsEmpty(p.patch)) {
        push({ role: 'ai', tone: 'note', text: p.answer || 'Nothing to change.', notes: [] });
        return;
      }
      const rows = pnpRows(context.settings, p.patch);
      const candidate = evaluate({ ...context.settings, ...p.patch });
      if (!mayApplyPnp(context.result, candidate)) {
        const why =
          candidate === null
            ? ['No board is loaded, so there is nothing to check the change against.']
            : typeof candidate === 'string'
              ? [candidate]
              : candidate.refusals.slice(0, 6).map((x) => `[${x.rule}] ${x.message}`);
        push({ role: 'ai', tone: 'bad', text: `Not changed: the tray plan would not get better. ${p.answer}`.trim(), notes: [...rows, ...why] });
        return;
      }
      const undo = inverseOf(context.settings, p.patch);
      onApply(p.patch);
      const c = candidate as PreflightResult;
      push({
        role: 'ai',
        tone: 'ok',
        text: `Done. ${p.answer}`.trim(),
        notes: [
          ...rows,
          c.exit === 0 ? 'Plan: MANIFEST OK.' : `Plan: still REFUSED, ${c.refusals.length} refusal(s) left.`,
        ],
        undo,
      });
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: `${f.headline}. The plan is unchanged.`, notes: [f.detail] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  /* Through `send`, so it passes every check a typed question does. */
  const lastAuto = useRef(0);
  useEffect(() => {
    if (!autoAsk || autoAsk.nonce === lastAuto.current) return;
    lastAuto.current = autoAsk.nonce;
    void send(autoAsk.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk?.nonce]);

  const undo = (id: number, patch: PnpPatch) => {
    onApply(patch);
    setMsgs((old) =>
      old.map((m) => (m.id === id && m.role === 'ai' ? { ...m, tone: 'undone', undo: undefined, text: `Undone. ${m.text.replace(/^Done\.\s*/, '')}` } : m))
    );
  };

  return (
    <section className="cad-chat" aria-label="PnP assistant" data-testid="pnp-chat">
      <header className="cad-chat-head">
        <strong>PnP assistant</strong>
        {/* Clear (founder: "have a button to clear the AI assistant on all tabs"):
            stops a pending answer and empties the log. What was applied stays
            applied; its Undo goes with the cleared message. */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="pnp-chat-clear"
          disabled={msgs.length === 0 && !busy}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
        <span className="pnp-chat-head-right">
          {expert}
          <button type="button" className="cad-chat-status" data-testid="pnp-chat-status" onClick={() => setSetup((s) => !s)} title="AI connection settings">
            <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
            {connected ? 'AI ready' : 'Connect AI'}
          </button>
        </span>
      </header>

      <div className="cnc-chat-designs">{picker}</div>

      {setup ? (
        <div className="cad-chat-setup">
          <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
        </div>
      ) : null}

      <div className="cad-chat-log" ref={log} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cad-chat-msg ai">
            {!context.board ? (
              'Pick a board above. I can explain its tray plan and change the board count or the trays; the plan is re-checked before anything changes.'
            ) : connected ? (
              'Ask about this board or its tray plan, or tell me what to change: how many boards, which trays are on the machine.'
            ) : (
              <>
                The AI is not connected yet.{' '}
                {setup ? null : (
                  <button type="button" className="cad-chat-undo" data-testid="pnp-chat-connect" onClick={() => setSetup(true)}>
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
            <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="pnp-chat-reply">
              <div>{m.text}</div>
              {m.notes.length ? (
                <ul>
                  {m.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {m.undo && m.id === lastUndoable ? (
                <button type="button" className="cad-chat-undo" data-testid="pnp-chat-undo" onClick={() => undo(m.id, m.undo!)}>
                  Undo
                </button>
              ) : null}
            </div>
          )
        )}
        {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
      </div>

      {connected && !busy ? (
        <div className="cad-chat-chips" data-testid="pnp-chat-chips">
          {chips.map((s) => (
            <button key={s} type="button" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      <form
        className="cad-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(prompt);
        }}
      >
        <textarea
          data-testid="pnp-chat-prompt"
          rows={2}
          value={prompt}
          placeholder={connected ? 'Ask, or describe the change…' : 'Connect the AI first'}
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
          <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="pnp-chat-send">
            Send
          </button>
        )}
      </form>
    </section>
  );
}

export default PnpChat;
