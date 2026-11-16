// 2bee.cad — the chat. Founder 2026-10-15: *"2bee.cad should be only a chat
// interface and a 3d visualization, no menus, nothing else right now, may be a
// save button? … in the chat interface user should able to request change on
// the 3d model."*
//
// This is a conversation view over the SAME pipeline the old "Ask a model"
// pane used: `askOnce` (preflight → send → read → `reviewProposal`, which runs
// the same parser and mesh audit as the editor) and `mayApply`. Nothing here
// is a second, lenient path for model output.
//
// 🔴 A CHANGE IS APPLIED ONLY WHEN `mayApply` SAYS SO, and every applied change
// can be undone from the message that made it. The undo is the tab's own
// put-back (`replace.ts`), passed in as a callback, so there is still ONE
// history and not a second stash in this file.
//
// ⚠ The model receives the current source and this one message. Earlier turns
// are not sent: the source IS the conversation's state, and resending old
// prompts would let the model re-apply a change the user already undid.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AskSettings,
  askConfigured,
  askOnce,
  classifyThrow,
  fetchTransport,
  mayApply,
  preflight,
  readReply,
  STALE_FAILURE,
  withReference,
  type AskConfig,
  type Bounds,
} from './ask';
import type { ScadOptions } from './scad';

type Msg =
  | { id: number; role: 'user'; text: string }
  | {
      id: number;
      role: 'ai';
      tone: 'ok' | 'bad' | 'undone';
      text: string;
      notes: string[];
      /** The full shape check, folded under Details so it stays one click away. */
      detail?: string;
      /** What the message says once its change is undone. */
      undoText?: string;
      /** An answer's suggested change, offered as "Apply this". */
      proposal?: string;
      applied: boolean;
    };

type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const mm = (n: number) => (Math.round(n * 10) / 10).toString();
function sizeOf(b: Bounds | null): string | null {
  if (!b) return null;
  return `${mm(b.max[0] - b.min[0])} × ${mm(b.max[1] - b.min[1])} × ${mm(b.max[2] - b.min[2])} mm`;
}

/**
 * What a CNC router needs from a design, for the chat's answers and for changes
 * that mention cnc (founder 2026-10-16: "how should I change the design to able
 * to cnc it?" — the chat edited instead of answering, and the edit broke a
 * difference()). The numbers are the app's defaults, not a machine's facts.
 */
export const CNC_RULES = [
  'CNC routing in 2bee.app cuts FLAT parts from one workpiece (2.5D): every part should be a flat plate of one thickness (the workpiece), lying flat, with features cut straight down (through-cuts, pockets, holes).',
  'Separate parts on one workpiece need clear material between them of at least the cutter diameter (default cutter 6 mm, so >= 6 mm, more is better), or they cannot be cut apart.',
  'Inside corners cannot be sharper than the cutter radius (3 mm for a 6 mm cutter): round them, or add dog-bone reliefs where another part must fit in.',
  'Slots and holes narrower than the cutter diameter cannot be cut with it.',
  'Overhangs, undercuts and features on the side faces cannot be cut by a 3-axis router.',
].join(' ');

function isQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || /^(how|what|why|which|where|when|can|could|should|would|is|are|does|do|explain|tell me)\b/i.test(t);
}

const SUGGESTIONS = ['Make it 20 mm taller', 'Add a 5 mm hole through the middle', 'Make the walls thicker'];

export interface CadChatProps {
  /** The source the model will change: what is on screen now. */
  source: string;
  /** Library host and path, so imports in the design resolve during the review. */
  scad?: ScadOptions;
  /** Replace the model with an accepted change. Goes through the tab's put-back history. */
  onApply: (next: string) => void;
  /** Put back what the last replacement displaced, or null when there is nothing to put back. */
  onUndo: (() => void) | null;
  cfg: AskConfig;
  onPatch: (patch: Partial<AskConfig>) => void;
  /** A request sent on the user's behalf (the gates' "Fix with AI"); each new nonce sends once. */
  autoAsk?: { nonce: number; text: string } | null;
  /** A part reference from a click on the 3D view; each new nonce is added to the prompt once, NOT sent. */
  insert?: { nonce: number; text: string } | null;
}

export function CadChat({ source, scad, onApply, onUndo, cfg, onPatch, autoAsk = null, insert = null }: CadChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  /* Founder 2026-11-13: "have a counter or spinning wheel ... when AI is working ... able
   * to stop the process". What the run is doing and how long it has been at it. */
  const [stage, setStage] = useState('');
  const [since, setSince] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    setSince(t0);
    setNow(t0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);
  const [setup, setSetup] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  /* The editor text NOW, read when a reply lands: a reply to older text is not applied. */
  const latestSource = useRef(source);
  latestSource.current = source;
  const log = useRef<HTMLDivElement>(null);
  const connected = askConfigured(cfg);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [msgs, busy]);

  /* Only the newest applied change offers Undo: the put-back holds one step at a
   * time in this order, so an Undo on an older message would undo the wrong one. */
  const lastApplied = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'ai' && m.applied) return m.id;
    }
    return -1;
  }, [msgs]);

  const push = (m: NewMsg) =>
    setMsgs((old) => [...old, { ...m, id: nextId.current++ } as Msg]);

  /* A QUESTION gets an answer, not an edit; "Apply this" turns the answer into a change. */
  const answer = async (ask: string) => {
    const pre = preflight(cfg, ask, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) {
      push({ role: 'ai', tone: 'bad', text: pre.headline, notes: [pre.detail], applied: false });
      return;
    }
    setStage('Asking the model');
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchTransport(
        {
          url: cfg.endpoint,
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: {
            model: cfg.model,
            messages: [
              {
                role: 'system',
                content:
                  'You advise on a design in 2bee.cad (an OpenSCAD subset, millimetres). Answer the question in plain text, short and concrete, naming the parts/lines of the source to change and by how much. Do not output code. If a change is needed, end with one line starting "Change:" that states it as an instruction. ' +
                  CNC_RULES,
              },
              { role: 'user', content: `Source:\n${source}\n\nQuestion: ${ask}` },
            ],
            temperature: 0,
            stream: false,
          },
        },
        controller.signal,
      );
      const r = readReply(res);
      if (!r.ok) {
        push({ role: 'ai', tone: 'bad', text: r.failure.headline, notes: [r.failure.detail], applied: false });
        return;
      }
      const raw = r.raw.trim();
      const change = /^Change:\s*(.+)$/im.exec(raw)?.[1]?.trim() ?? null;
      push({ role: 'ai', tone: 'ok', text: raw.replace(/^Change:.*$/im, '').trim(), notes: [], applied: false, ...(change ? { proposal: change } : {}) });
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: f.headline, notes: [f.detail], applied: false });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    if (isQuestion(ask)) {
      push({ role: 'user', text: ask });
      setPrompt('');
      await answer(ask);
      return;
    }
    push({ role: 'user', text: ask });
    setPrompt('');
    setStage('Asking the model');
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let out: Awaited<ReturnType<typeof askOnce>>;
    try {
      out = await askOnce({
        timeoutMs: cfg.timeoutMs,
        onStage: setStage,
        cfg,
        prompt: /\b(cnc|router|mill|cut|routing)\b/i.test(ask) ? `${ask}\n\nCNC rules to respect: ${CNC_RULES}` : ask,
        source,
        online: typeof navigator === 'undefined' ? true : navigator.onLine,
        transport: fetchTransport,
        signal: controller.signal,
        scad,
      });
    } finally {
      abort.current = null;
      setBusy(false);
    }
    if (controller.signal.aborted) {
      /* The operator pressed Stop: nothing is applied, whatever came back so far. */
      push({ role: 'ai', tone: 'bad', text: 'Stopped. Nothing was changed.', notes: [], applied: false });
      return;
    }
    if (!out.ok) {
      push({ role: 'ai', tone: 'bad', text: out.failure.headline, notes: [out.failure.detail], applied: false });
      return;
    }
    if (latestSource.current !== source) {
      push({ role: 'ai', tone: 'bad', text: STALE_FAILURE.headline, notes: [STALE_FAILURE.detail], applied: false });
      return;
    }
    const ok = mayApply(out.review);
    if (ok) onApply(out.source);
    const r = out.review;
    if (!ok) {
      push({
        role: 'ai',
        tone: 'bad',
        text: `Not changed. ${r.blocked?.headline ?? ''}`.trim(),
        notes: r.blocked ? [r.blocked.detail] : [],
        applied: false,
      });
      return;
    }
    const before = sizeOf(r.shape.before);
    const after = sizeOf(r.shape.after);
    push({
      role: 'ai',
      tone: 'ok',
      text: after ? `Done. Now ${after}${before && before !== after ? ` (was ${before})` : ''}.` : 'Done.',
      /* Every caution except the shape sentence, which goes under Details: the
       * refusals and an unsound mesh must be read, the triangle counts need not. */
      notes: r.cautions.filter((c) => c !== r.shape.sentence),
      detail: r.shape.sentence,
      undoText: before ? `Undone. Back to ${before}.` : 'Undone.',
      applied: true,
    });
  };

  const lastInsert = useRef(0);
  const promptBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!insert || insert.nonce === lastInsert.current) return;
    lastInsert.current = insert.nonce;
    setPrompt((p) => withReference(p, insert.text));
    promptBox.current?.focus();
  }, [insert]);

  const lastAuto = useRef(0);
  useEffect(() => {
    if (!autoAsk || autoAsk.nonce === lastAuto.current) return;
    lastAuto.current = autoAsk.nonce;
    void send(autoAsk.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk?.nonce]);

  const undo = (id: number) => {
    if (!onUndo) return;
    onUndo();
    setMsgs((old) => old.map((m) => (m.id === id && m.role === 'ai' ? { ...m, applied: false, tone: 'undone', text: m.undoText ?? 'Undone.' } : m)));
  };

  return (
    <section className="cad-chat" aria-label="Design assistant" data-testid="cad-chat">
      <header className="cad-chat-head">
        <strong>Design assistant</strong>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="cad-chat-clear"
          disabled={msgs.length === 0 && !abort.current}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="cad-chat-status"
          data-testid="cad-chat-status"
          onClick={() => setSetup((s) => !s)}
          title="AI connection settings"
        >
          <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
          {connected ? 'AI ready' : 'Connect AI'}
        </button>
      </header>

      {setup ? (
        <div className="cad-chat-setup" data-testid="cad-chat-setup">
          <AskSettings cfg={cfg} onPatch={onPatch} onClose={() => setSetup(false)} />
        </div>
      ) : null}

      <div className="cad-chat-log" ref={log} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cad-chat-msg ai">
            {connected ? (
              'Tell me what to change on the model, in your own words. I change the design and the 3D view updates.'
            ) : (
              <>
                The AI is not connected yet.{' '}
                {setup ? null : (
                  <button type="button" className="cad-chat-undo" data-testid="cad-chat-connect" onClick={() => setSetup(true)}>
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
            <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="cad-chat-reply">
              <div>{m.text}</div>
              {m.notes.length ? (
                <ul>
                  {m.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {m.detail ? (
                <details className="cad-chat-detail">
                  <summary>Details</summary>
                  {m.detail}
                </details>
              ) : null}
              {m.proposal ? (
                <button type="button" className="cad-chat-undo" data-testid="cad-chat-apply" disabled={busy} onClick={() => void send(m.proposal!)}>
                  Apply this: {m.proposal.length > 70 ? `${m.proposal.slice(0, 67)}…` : m.proposal}
                </button>
              ) : null}
              {m.id === lastApplied && m.applied && onUndo ? (
                <button type="button" className="cad-chat-undo" data-testid="cad-chat-undo" onClick={() => undo(m.id)}>
                  Undo
                </button>
              ) : null}
            </div>
          ),
        )}
        {busy ? (
          <div className="cad-chat-msg ai busy" role="status" aria-live="polite" data-testid="cad-chat-busy">
            <span className="cad-chat-spin" aria-hidden="true" />
            {stage || 'Working'}… {Math.max(0, Math.round((now - since) / 1000))} s{' '}
            <button type="button" className="cad-chat-undo" onClick={() => abort.current?.abort()} data-testid="cad-chat-stop">
              Stop
            </button>
          </div>
        ) : null}
      </div>

      {msgs.length === 0 && connected ? (
        <div className="cad-chat-chips">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => void send(s)}>
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
          data-testid="cad-chat-prompt"
          ref={promptBox}
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
          <button type="button" onClick={() => abort.current?.abort()} data-testid="cad-chat-stop-form">
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="cad-chat-send">
            Send
          </button>
        )}
      </form>
    </section>
  );
}

export default CadChat;
