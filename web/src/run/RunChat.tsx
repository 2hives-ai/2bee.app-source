/**
 * cnc.run — the chat. It EXPLAINS the job and its steps; it cannot act.
 *
 * 🔴 STRUCTURAL, NOT A PROMISE IN A PROMPT: a reply is rendered as text and
 * nothing else. No code path here starts motion, ticks a step, changes the
 * program or presses Play — there is no callback to do it with. The system
 * instruction says the same, so the model does not offer what it cannot do.
 *
 * The quick questions are answered BY THE APP from the page's own facts (the
 * current step, the refusals Play would give), so they work with no AI and
 * cannot disagree with the button they explain. Typed questions go to the
 * same endpoint as 2bee.cad / cnc (`cad/ask.tsx` settings, `ASK_CONFIG_KEY`).
 * The G-code is NOT sent.
 */
import { useEffect, useRef, useState } from 'react';
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
  type AskRequest,
  type AskTransport,
} from '../cad/ask';

export interface RunChatContext {
  /** One line each: job, machine, state. */
  summary: string[];
  /** The numbered steps with their state, e.g. "3. Fit cutter 1 — done". */
  steps: string[];
  /** The step the operator is on, in words. */
  now: string;
  /** Why Play is refused, or empty. */
  playRefusals: string[];
}

export const RUN_SYSTEM_INSTRUCTION = [
  'You help an operator at a CNC router with ONE job. You EXPLAIN; you cannot act.',
  'You cannot start, pause or stop the machine, tick a step, or change the program or its settings. Never say you did, and never offer to.',
  'Every step is done by the person, and the Play button only works after the app\'s own checks. If they ask you to do something, tell them which step or button does it.',
  'Answer in plain words, short, using the job facts below. If a fact is not there, say you do not know.',
  'Safety first: if a question is about something going wrong while the machine runs, the first answer is Feed Hold or Stop.',
].join('\n');

export function buildRunRequest(cfg: AskConfig, question: string, ctx: RunChatContext): AskRequest {
  const facts = [
    ...ctx.summary,
    `Current step: ${ctx.now}`,
    'Steps:',
    ...ctx.steps,
    ctx.playRefusals.length ? `Play is refused because: ${ctx.playRefusals.join(' ')}` : 'Play is not refused right now.',
  ].join('\n');
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: RUN_SYSTEM_INSTRUCTION },
        { role: 'user', content: `Job facts:\n${facts}\n\nQuestion: ${question}` },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

/** The quick questions, answered from the page's own facts. */
export function localAnswer(id: 'now' | 'play' | 'stop', ctx: RunChatContext): string {
  if (id === 'now') return `Now: ${ctx.now}`;
  if (id === 'play') return ctx.playRefusals.length ? `Play is off because:\n• ${ctx.playRefusals.join('\n• ')}` : 'Nothing is stopping Play right now.';
  return 'Feed Hold pauses the machine where it is; Resume carries on. Stop ends the job: it holds first, then resets the controller, and the job cannot be resumed. Then home again before anything else.';
}

const QUICK: readonly { id: 'now' | 'play' | 'stop'; label: string }[] = [
  { id: 'now', label: 'What do I do now?' },
  { id: 'play', label: 'Why is Play off?' },
  { id: 'stop', label: 'How do I stop it?' },
];

type Msg = { id: number; role: 'user' | 'ai'; text: string; tone?: 'bad' | 'note' };

export function RunChat({ context, transport = fetchTransport }: { context: RunChatContext; transport?: AskTransport }) {
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
        /* storage blocked: holds for this page only */
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

  const push = (m: Omit<Msg, 'id'>) => setMsgs((old) => [...old, { ...m, id: nextId.current++ }]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    push({ role: 'user', text: q });
    setPrompt('');
    const pre = preflight(cfg, q, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) return push({ role: 'ai', tone: 'bad', text: `${pre.headline}.` });
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const r = readReply(await transport(buildRunRequest(cfg, q, context), ctl.signal));
      push(r.ok ? { role: 'ai', text: r.raw.trim() } : { role: 'ai', tone: 'bad', text: `${r.failure.headline}.` });
    } catch (e) {
      push({ role: 'ai', tone: 'bad', text: `${classifyThrow(e).headline}.` });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  return (
    <section className="cad-chat" aria-label="Run assistant" data-testid="rs-chat">
      <header className="cad-chat-head">
        <strong>Run assistant</strong>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="run-chat-clear"
          disabled={msgs.length === 0 && !abort.current}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
        <button type="button" className="cad-chat-status" data-testid="rs-chat-status" onClick={() => setSetup((s) => !s)} title="AI connection settings">
          <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
          {connected ? 'AI ready' : 'Connect AI'}
        </button>
      </header>
      {setup ? (
        <div className="cad-chat-setup">
          <AskSettings cfg={cfg} onPatch={onPatch} onClose={() => setSetup(false)} />
        </div>
      ) : null}
      <div className="cad-chat-log" ref={log} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cad-chat-msg ai">
            Ask me about this job and its steps. I explain; I cannot start, stop or change anything. You do the steps, and Play runs the machine.
          </div>
        ) : null}
        {msgs.map((m) => (
          <div key={m.id} className={`cad-chat-msg ${m.role}${m.tone ? ` ${m.tone}` : ''}`} data-testid={m.role === 'ai' ? 'rs-chat-reply' : undefined}>
            {m.text}
          </div>
        ))}
        {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
      </div>
      <div className="cad-chat-chips">
        {QUICK.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`rs-chat-quick-${c.id}`}
            onClick={() => {
              push({ role: 'user', text: c.label });
              push({ role: 'ai', tone: 'note', text: localAnswer(c.id, context) });
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      <form
        className="cad-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(prompt);
        }}
      >
        <textarea
          data-testid="rs-chat-prompt"
          rows={2}
          value={prompt}
          placeholder={connected ? 'Ask about the job…' : 'Connect the AI to ask your own question'}
          disabled={!connected}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask(prompt);
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="rs-chat-send">
            Send
          </button>
        )}
      </form>
    </section>
  );
}

export default RunChat;
