// The design page's assistant column — founder 2026-10-16: *"Add an ai
// assistant to the design page as well"*. Same look and controls as the other
// tabs' chats (`cad/CadChat.tsx`, `machines/MachinesTab.tsx`): header with
// Clear + AI status, chips, Enter to send.
//
// What it may do is in `shopAsk.ts`: answer from the catalogue summary, and
// change the VIEW (search, filters, 3D viewer, open in a tab) through actions
// that are checked against the page's real lists first. No Undo: every action
// is a view change the user can see and reverse with the same controls.

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
  type AskTransport,
} from '../cad/ask';
import { buildShopRequest, describeAction, readShopReply, type ShopAction, type ShopAskContext } from './shopAsk';

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'note'; text: string; notes: string[] };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

const SUGGESTIONS = [
  'Show me the hive parts I can cut on the cnc',
  'Which designs can I 3D print?',
  'What is the entrance tray for?',
];

export interface ShopChatProps {
  /** The page's real lists and current view. Rebuilt by the page on every render. */
  ctx: ShopAskContext;
  /** Apply checked actions. Returns notes for anything that then failed (e.g. an open the page refused). */
  onActions: (actions: ShopAction[]) => Promise<string[]>;
  /** False until the catalogue is loaded: nothing to ask about yet. */
  ready: boolean;
  transport?: AskTransport;
}

export function ShopChat({ ctx, onActions, ready, transport = fetchTransport }: ShopChatProps) {
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

  const push = (m: NewMsg) => setMsgs((old) => [...old, { ...m, id: nextId.current++ } as Msg]);

  const titleOf = (id: string) =>
    ctx.entries.find((e) => e.id === id)?.title ?? ctx.boards.find((b) => b.id === id)?.name ?? id;

  const send = async (text: string) => {
    const ask = text.trim();
    if (!ask || busy) return;
    push({ role: 'user', text: ask });
    setPrompt('');
    if (!ready) {
      push({ role: 'ai', tone: 'bad', text: 'The catalogue is not loaded, so there is nothing to answer from yet.', notes: [] });
      return;
    }
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
      const r = readReply(await transport(buildShopRequest(cfg, ask, ctx), ctl.signal));
      if (!r.ok) {
        push({ role: 'ai', tone: 'bad', text: `${r.failure.headline}. The page is unchanged.`, notes: [r.failure.detail] });
        return;
      }
      const p = readShopReply(r.raw, ctx);
      if (!p.ok) {
        push({ role: 'ai', tone: p.answer ? 'note' : 'bad', text: p.answer || 'No answer.', notes: [...p.problems, ...(p.answer ? ['Nothing on the page was changed.'] : [])] });
        return;
      }
      const done = p.actions.map((a) => describeAction(a, titleOf));
      push({ role: 'ai', tone: 'ok', text: p.answer, notes: done });
      if (p.actions.length) {
        const failed = await onActions(p.actions);
        if (failed.length) push({ role: 'ai', tone: 'bad', text: 'That did not go through.', notes: failed });
      }
    } catch (e) {
      const f = classifyThrow(e);
      push({ role: 'ai', tone: 'bad', text: `${f.headline}. The page is unchanged.`, notes: [f.detail] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  return (
    <section className="cad-chat" aria-label="Design assistant" data-testid="shop-chat">
      <header className="cad-chat-head">
        <strong>Design assistant</strong>
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="shop-chat-clear"
          disabled={msgs.length === 0 && !busy}
          onClick={() => {
            abort.current?.abort();
            setMsgs([]);
          }}
        >
          Clear
        </button>
        <button type="button" className="cad-chat-status" data-testid="shop-chat-status" onClick={() => setSetup((s) => !s)} title="AI connection settings">
          <span className={connected ? 'dot ok' : 'dot'} aria-hidden="true" />
          {connected ? 'AI ready' : 'Connect AI'}
        </button>
      </header>

      {setup ? (
        <div className="cad-chat-setup">
          <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
        </div>
      ) : null}

      <div className="cad-chat-log" ref={log} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cad-chat-msg ai">
            {connected ? (
              'Ask about the designs, or tell me what to show. I can filter the list, open the 3D view, open a design in cad, cnc or 3d, or archive one (hide it; nothing is deleted).'
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
            <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="shop-chat-reply">
              <div>{m.text}</div>
              {m.notes.length ? (
                <ul>
                  {m.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ),
        )}
        {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
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
          data-testid="shop-chat-prompt"
          rows={2}
          value={prompt}
          placeholder={connected ? 'Ask about the designs…' : 'Connect the AI first'}
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
          <button type="submit" className="primary" disabled={!connected || !prompt.trim()} data-testid="shop-chat-send">
            Send
          </button>
        )}
      </form>
    </section>
  );
}

export default ShopChat;
