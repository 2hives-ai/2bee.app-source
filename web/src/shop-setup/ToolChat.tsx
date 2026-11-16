/* ToolChat — the left column of cnc.tools: the tool assistant.
 *
 * Founder, 2026-10-15: *"In the tools section able to photo the tool and ai
 * should recognise it"*, then *"cnc.tools is the same (ai is on the left side,
 * and user should able to add/phot a new tool what can be used by the cnc
 * machine"*. Same layout as cnc.machines and 2bee.cad: `.cad-simple`, chat left.
 *
 * The operator DESCRIBES a cutter in words, or takes/attaches a photo, or both.
 * The reply becomes a proposal (`toolPhotoAsk.ts`) that FILLS the add-cutter
 * form on the right. 🔴 Nothing here registers anything: the human checks the
 * form and presses Register, and `validateToolDraft` (the form's own rule) is
 * the only gate a value passes. A size read from a photo is not a measurement,
 * and every proposal says so.
 *
 * ⚠ Earlier turns are not sent. The FORM is the conversation's state, so its
 * current values go with each request instead — a follow-up like "it has 3
 * flutes" changes that field and keeps the rest.
 */

import { useEffect, useRef, useState } from 'react';
import { AskSettings, askConfigured, classifyThrow, preflight, readAskConfig, writeAskConfig, type AskConfig } from '../cad/ask';
import { downscaleImage } from './toolPhotos';
import type { ToolDraft } from './toolRegistry';
import {
  blobToDataUrl,
  buildToolRequest,
  failureSentence,
  fieldName,
  MAX_PHOTO_DATA_URL,
  photoFetchTransport,
  readPhotoReply,
  type PhotoTransport,
  type ToolProposal,
} from './toolPhotoAsk';
import './toolChat.css';

export const PHOTO_SAFETY =
  'These are the AI’s reading, not measurements. Measure the diameter, shank and lengths with calipers before this cutter goes in the spindle — a wrong size is a broken cutter or a thrown part on a 2.2 kW machine.';

type Msg =
  | { id: number; role: 'user'; text: string; photo: string | null }
  | { id: number; role: 'ai'; tone: 'ok' | 'bad' | 'note'; text: string; notes: string[]; safety?: boolean; confidence?: string };
type NewMsg = Msg extends infer M ? (M extends Msg ? Omit<M, 'id'> : never) : never;

export interface ToolChatProps {
  /** The form's values now — sent as context, never changed here. */
  current: ToolDraft | null;
  /** Fill the form. Never registers. `photo` is the resized photo the AI saw, if any. */
  onProposal: (proposal: ToolProposal, photo: Blob | null) => void;
  disabled?: boolean;
  /** Injected in tests; default reads the same config as 2bee.cad (in `vite dev`: the local claude). */
  config?: AskConfig;
  transport?: PhotoTransport;
}

export default function ToolChat({ current, onProposal, disabled, config, transport = photoFetchTransport }: ToolChatProps) {
  /* 🔴 THE STORE MUST BE PASSED — `readAskConfig()` with no argument is the empty
   * config (MakeFlow.tsx ChangeStep learnt this the hard way). */
  const [cfg, setCfg] = useState<AskConfig>(() => {
    if (config) return config;
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
  const connected = askConfigured(cfg);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState('');
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  /* Object URLs live as long as the chat shows them. */
  const urls = useRef<string[]>([]);

  useEffect(
    () => () => {
      abort.current?.abort();
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    []
  );
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [msgs, busy]);

  const push = (m: NewMsg) => setMsgs((old) => [...old, { ...m, id: nextId.current++ } as Msg]);

  const attach = async (file: File | undefined) => {
    if (!file) return;
    try {
      const blob = await downscaleImage(file);
      const url = URL.createObjectURL(blob);
      urls.current.push(url);
      setPhoto({ blob, url });
    } catch (e) {
      push({ role: 'ai', tone: 'bad', text: `The photo could not be read: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`, notes: [] });
    }
  };

  const send = async () => {
    const words = prompt.trim();
    const pic = photo;
    if ((!words && !pic) || busy) return;
    push({ role: 'user', text: words, photo: pic?.url ?? null });
    setPrompt('');
    setPhoto(null);
    const pre = preflight(cfg, words || 'photo', typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) {
      push({ role: 'ai', tone: 'bad', text: `${pre.headline}. The form is unchanged.`, notes: [pre.detail] });
      return;
    }
    let dataUrl: string | undefined;
    if (pic) {
      try {
        dataUrl = await blobToDataUrl(pic.blob);
      } catch (e) {
        push({ role: 'ai', tone: 'bad', text: `The photo could not be read: ${e instanceof Error ? e.message : String(e)}. Nothing was sent.`, notes: [] });
        return;
      }
      if (dataUrl.length > MAX_PHOTO_DATA_URL) {
        push({
          role: 'ai',
          tone: 'bad',
          text: `The photo is still ${Math.round(dataUrl.length / 1000)} kB after resizing, more than the ${MAX_PHOTO_DATA_URL / 1000} kB this sends. Nothing was sent.`,
          notes: [],
        });
        return;
      }
    }
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    /* The configured timeout, as 2bee.cad and cnc.machines use it. */
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const out = readPhotoReply(await transport(buildToolRequest(cfg, { text: words, dataUrl, current }), ctl.signal));
      if (!out.ok) {
        push({ role: 'ai', tone: 'bad', text: `${out.why} The form is unchanged.`, notes: [] });
        return;
      }
      const p = out.proposal;
      onProposal(p, pic?.blob ?? null);
      push({
        role: 'ai',
        tone: 'ok',
        text: `Filled: ${p.filled.map(fieldName).join(', ')}.${p.notes ? ` Based on: ${p.notes}` : ''} Check the form on the right and press Register — nothing is saved until you do.`,
        notes: p.unread.map((u) => `${fieldName(u.field)} left empty: ${u.why}`),
        safety: true,
        confidence: p.confidence,
      });
    } catch (e) {
      push({ role: 'ai', tone: 'bad', text: `${failureSentence(classifyThrow(e))} The form is unchanged.`, notes: [] });
    } finally {
      clearTimeout(timer);
      abort.current = null;
      setBusy(false);
    }
  };

  const off = !connected || disabled || busy;

  return (
    <section className="cad-chat" aria-label="Tool assistant" data-testid="tools-chat">
      <header className="cad-chat-head">
        <strong>Tool assistant</strong>
        {/* Founder 2026-10-15: "have a button to clear the AI assistant on all tabs".
            Empties the conversation and stops a pending answer; what was already
            applied stays applied (each change keeps its own Undo until cleared). */}
        <button
          type="button"
          className="cad-chat-clear"
          data-testid="tools-chat-clear"
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
      {setup ? (
        <div className="cad-chat-setup">
          <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSetup(false)} />
        </div>
      ) : null}
      <div className="cad-chat-log" ref={log} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cad-chat-msg ai">
            {connected ? (
              <>
                Describe a cutter, e.g. “6 mm 2-flute up-cut end mill, 22 mm cutting length”, or take a photo of it. I fill in the form on the right; you measure, check and
                press Register.
                <span className="tool-chat-privacy">
                  A photo you send leaves this browser: one resized copy goes to your AI ({cfg.endpoint}). With the local claude bridge, that is Claude under your own login.
                </span>
              </>
            ) : (
              <>
                The AI is not connected yet, so add the cutter with the form on the right.{' '}
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
              {m.photo ? <img className="tool-chat-photo" src={m.photo} alt="Photo sent to the AI" /> : null}
              {m.text ? <div>{m.text}</div> : null}
            </div>
          ) : (
            <div key={m.id} className={`cad-chat-msg ai ${m.tone}`} data-testid="tools-chat-reply">
              <div>{m.text}</div>
              {m.confidence ? (
                <div className="cad-chat-detail">
                  AI confidence: <strong data-testid="tool-photo-confidence">{m.confidence}</strong>
                </div>
              ) : null}
              {m.notes.length ? (
                <ul data-testid="tool-photo-unread">
                  {m.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {m.safety ? (
                <p className="tool-chat-safety" data-testid="tool-photo-safety">
                  <strong>Measure before use.</strong> {PHOTO_SAFETY}
                </p>
              ) : null}
            </div>
          )
        )}
        {busy ? <div className="cad-chat-msg ai busy">Thinking…</div> : null}
      </div>
      {photo ? (
        <div className="tool-chat-attached" data-testid="tool-photo-attached">
          <img src={photo.url} alt="Photo to send" />
          <span>Photo attached — press Send.</span>
          <button type="button" className="cad-chat-undo" onClick={() => setPhoto(null)}>
            Remove
          </button>
        </div>
      ) : null}
      <form
        className="cad-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className={`tool-chat-camera${off ? ' is-off' : ''}`} title="Take or attach a photo of the cutter">
          Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="tools-row__file"
            data-testid="tool-photo-input"
            disabled={off}
            onChange={(e) => {
              void attach(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        <textarea
          data-testid="tools-chat-prompt"
          rows={2}
          value={prompt}
          placeholder={connected ? 'Describe the cutter, or add a photo…' : 'Connect the AI first'}
          disabled={!connected || busy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={off || (!prompt.trim() && !photo)} data-testid="tools-chat-send">
            Send
          </button>
        )}
      </form>
    </section>
  );
}
