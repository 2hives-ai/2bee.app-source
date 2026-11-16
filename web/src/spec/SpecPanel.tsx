/**
 * The functional specification of the design on screen — read, edit, AI review.
 *
 * Founder 2026-10-16: *"Every design cad(scad)/pcb have to have a detailed functional
 * specification, show it in cnc, pcb, user should able to edit what ai will review and
 * work on it if it changes the design."*
 *
 * A compact card (title + whose text it is + Open) that opens a side drawer:
 *   view   the spec, rendered, under a label saying WHOSE text it is (`sourceLabel`)
 *   edit   a textarea; Save keeps the user's copy in this browser (`specStore.ts`)
 *   review on Save the AI compares old spec, new spec and the design (`specReview.ts`)
 *          and says whether the design must change; the reply is read strictly
 *   change cad: the change requests go to the cad chat (its own checked apply + Undo);
 *          pcb: copied as a request to pcb — this app cannot change a board
 *
 * 🔴 An AI-written text is NEVER shown as the owning lane's spec: a draft is labelled
 * "AI draft — not from cad/pcb, check it" and stays marked after it is kept.
 */
import { useEffect, useRef, useState } from 'react';
import { classifyThrow, fetchTransport, preflight, readAskConfig, type AskTransport } from '../cad/ask';
import { Markdown } from './Markdown';
import {
  ownerText,
  readUserSpec,
  revertUserSpec,
  saveUserSpec,
  sourceLabel,
  specKey,
  undoUserSpec,
  type OwnerSpec,
  type UserSpec,
} from './specStore';
import {
  buildDraftRequest,
  buildReviewRequest,
  changeRequestText,
  missingHeadings,
  pcbRequestText,
  readReview,
  replyContent,
  type SpecReview,
} from './specReview';
// spec.css is imported by main.tsx: node tests import this tree and cannot load CSS.

export interface SpecPanelProps {
  kind: 'cad' | 'pcb';
  /** Storage key for the user's copy (saved name, catalogue path, board id); null = cannot save. */
  designKey: string | null;
  /** Why there is no key, shown instead of the Edit button. */
  noKeyWhy?: string;
  title: string;
  /** Loads the owning lane's spec. Re-run when `ownerKey` changes. */
  loadOwner: () => Promise<OwnerSpec>;
  ownerKey: string;
  /** The design as the AI should see it: .scad source (cad), board summary (pcb). */
  designSource: () => Promise<string> | string;
  /** cad only: hand change requests to the cad chat (or open cad with them). */
  onChangeDesign?: (text: string) => void | Promise<void>;
  changeLabel?: string;
  /** Shown when the review asks for a change and there is no way to hand it on. */
  noChangeWhy?: string;
  testid?: string;
  transport?: AskTransport;
}

type Review =
  | { state: 'idle' }
  | { state: 'busy'; what: 'review' | 'draft' }
  | { state: 'skipped'; why: string }
  | { state: 'failed'; why: string }
  | { state: 'done'; review: SpecReview; cut: boolean; newSpec: string };

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function SpecPanel(p: SpecPanelProps) {
  const tid = p.testid ?? `spec-${p.kind}`;
  const key = p.designKey ? specKey(p.kind, p.designKey) : null;
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState<OwnerSpec | null>(null);
  const [user, setUser] = useState<UserSpec | null>(() => (key ? readUserSpec(storage(), key) : null));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [review, setReview] = useState<Review>({ state: 'idle' });
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const transport = p.transport ?? fetchTransport;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    let live = true;
    setOwner(null);
    void p.loadOwner().then((o) => live && setOwner(o));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.ownerKey]);
  useEffect(() => {
    setUser(key ? readUserSpec(storage(), key) : null);
    setEditing(null);
    setDraft(null);
    setReview({ state: 'idle' });
    setNote(null);
    abort.current?.abort();
  }, [key]);

  const ownerName = p.kind;
  const shown = user ? user.text : owner ? ownerText(owner) : '';
  const label = owner ? sourceLabel(owner, user) : 'Reading the specification…';
  const short = !owner ? '…' : user ? (user.origin === 'ai-draft' ? 'your copy (AI draft)' : 'your edited copy') : owner.kind === 'per-file' ? `from ${ownerName}` : owner.kind === 'directory' ? `${ownerName}'s directory spec` : owner.kind === 'none' ? 'none yet' : 'not shown';

  async function ask(what: 'review' | 'draft', build: (cfg: ReturnType<typeof readAskConfig>, design: string) => { req: Parameters<AskTransport>[0]; cut: boolean }, prompt: string) {
    const cfg = readAskConfig(storage());
    const pre = preflight(cfg, prompt || ' ', typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) return { ok: false as const, why: `${pre.headline}. ${pre.detail}` };
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    setReview({ state: 'busy', what });
    try {
      const design = await p.designSource();
      const { req, cut } = build(cfg, design);
      const c = replyContent(await transport(req, ctl.signal));
      if (!c.ok) return { ok: false as const, why: c.problem };
      return { ok: true as const, text: c.text, cut };
    } catch (e) {
      const f = classifyThrow(e);
      return { ok: false as const, why: `${f.headline}. ${f.detail}` };
    } finally {
      clearTimeout(timer);
      if (abort.current === ctl) abort.current = null;
    }
  }

  async function save(next: string) {
    if (!key) return;
    const before = shown;
    const ok = saveUserSpec(storage(), key, next, before, 'edited');
    if (!ok) {
      setNote('This browser refused to store the edit — it is NOT saved.');
      return;
    }
    setUser(readUserSpec(storage(), key));
    setEditing(null);
    setNote('Saved in this browser. The AI is reviewing the change against the design…');
    const r = await ask('review', (cfg, design) => buildReviewRequest(cfg, { kind: p.kind, title: p.title, oldSpec: before, newSpec: next, design }), next);
    setNote('Saved in this browser.');
    if (!r.ok) {
      setReview({ state: 'skipped', why: r.why });
      return;
    }
    const read = readReview(r.text);
    setReview(read.ok ? { state: 'done', review: read.review, cut: r.cut, newSpec: next } : { state: 'failed', why: read.problem });
  }

  async function makeDraft() {
    setDraft(null);
    const r = await ask('draft', (cfg, design) => buildDraftRequest(cfg, { kind: p.kind, title: p.title, design }), 'draft');
    if (!r.ok) {
      setReview({ state: 'failed', why: r.why });
      return;
    }
    const miss = missingHeadings(r.text);
    if (miss.length) {
      setReview({ state: 'failed', why: `the AI draft is missing ${miss.length} of the 8 sections (${miss.join('; ')}), so it was not kept` });
      return;
    }
    setReview({ state: 'idle' });
    setDraft(r.text.trim());
  }

  const reviewBox = (() => {
    switch (review.state) {
      case 'idle':
        return null;
      case 'busy':
        return <div className="spec-review note" data-testid={`${tid}-busy`}>{review.what === 'review' ? 'The AI is reviewing the edit…' : 'The AI is drafting…'}</div>;
      case 'skipped':
        return <div className="spec-review bad" data-testid={`${tid}-review-skipped`}>Not reviewed: {review.why}</div>;
      case 'failed':
        return <div className="spec-review bad" data-testid={`${tid}-review-failed`}>The AI reply was refused: {review.why}</div>;
      case 'done': {
        const r = review.review;
        return (
          <div className={`spec-review ${r.designChange ? 'change' : 'ok'}`} data-testid={`${tid}-review`} data-change={r.designChange ? 'yes' : 'no'}>
            <strong>{r.designChange ? 'AI review: the design should change' : 'AI review: no design change needed'}</strong>
            <p>{r.summary}</p>
            {r.conflicts.length ? (
              <>
                <div className="spec-review-h">Conflicts with the current design</div>
                <ul>{r.conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </>
            ) : null}
            {r.changes.length ? (
              <>
                <div className="spec-review-h">Change requests</div>
                <ol>{r.changes.map((c, i) => <li key={i}>{c}</li>)}</ol>
              </>
            ) : null}
            {review.cut ? <p className="note">The design was cut to fit before it was sent; the review saw only part of it.</p> : null}
            <p className="note">This is the AI’s reading of the text. It is not a check of the part — the design’s gates still decide.</p>
            {r.designChange ? (
              p.kind === 'pcb' ? (
                <>
                  <p className="note">This app cannot change a board: pcb’s generators make it. Copy the request and file it to pcb.</p>
                  <button
                    type="button"
                    data-testid={`${tid}-copy-pcb`}
                    onClick={() => {
                      const t = pcbRequestText(p.designKey ?? p.title, r, review.newSpec);
                      void navigator.clipboard?.writeText(t).then(
                        () => setNote('Copied — paste it into a ticket to pcb.'),
                        () => setNote('The browser refused the clipboard; select the change requests above and copy them by hand.'),
                      );
                    }}
                  >
                    Copy as request to pcb
                  </button>
                </>
              ) : p.onChangeDesign ? (
                <button type="button" className="primary" data-testid={`${tid}-change`} onClick={() => void p.onChangeDesign!(changeRequestText(r))}>
                  {p.changeLabel ?? 'Change the design'}
                </button>
              ) : (
                <p className="note">{p.noChangeWhy ?? 'The change cannot be handed to cad from here.'}</p>
              )
            ) : null}
          </div>
        );
      }
    }
  })();

  return (
    <div className="spec-card" data-testid={tid}>
      <span className="spec-card-title">Specification</span>
      <span className={`spec-card-src ${owner?.kind === 'none' && !user ? 'none' : ''}`} data-testid={`${tid}-short`} title={label}>
        {short}
      </span>
      <button type="button" onClick={() => setOpen(true)} data-testid={`${tid}-open`}>
        Open
      </button>
      {open ? (
        <div className="spec-drawer" role="dialog" aria-label={`Specification · ${p.title}`} data-testid={`${tid}-drawer`}>
          <header className="spec-head">
            <strong>Specification · {p.title}</strong>
            <button type="button" onClick={() => setOpen(false)} data-testid={`${tid}-close`}>
              Close
            </button>
          </header>
          <div className={`spec-label ${user?.origin === 'ai-draft' ? 'ai' : ''}`} data-testid={`${tid}-label`}>
            {label}
          </div>
          {note ? <div className="note spec-note" data-testid={`${tid}-note`}>{note}</div> : null}
          <div className="spec-actions">
            {editing === null && draft === null ? (
              key ? (
                <>
                  <button type="button" data-testid={`${tid}-edit`} disabled={!owner} onClick={() => setEditing(shown)}>
                    Edit
                  </button>
                  {user ? (
                    <>
                      <button
                        type="button"
                        data-testid={`${tid}-undo`}
                        disabled={user.undo.length === 0}
                        onClick={() => {
                          const u = undoUserSpec(storage(), key);
                          if (u) setUser(u);
                        }}
                      >
                        Undo
                      </button>
                      <button
                        type="button"
                        data-testid={`${tid}-revert`}
                        onClick={() => {
                          revertUserSpec(storage(), key);
                          setUser(null);
                          setReview({ state: 'idle' });
                          setNote(`Your copy is removed; ${ownerName}’s version shows.`);
                        }}
                      >
                        Revert to {ownerName}’s version
                      </button>
                    </>
                  ) : null}
                  {!user && owner && owner.kind !== 'per-file' && owner.kind !== 'directory' ? (
                    <button type="button" data-testid={`${tid}-draft`} disabled={review.state === 'busy'} onClick={() => void makeDraft()}>
                      Draft with AI
                    </button>
                  ) : null}
                </>
              ) : (
                <span className="note">{p.noKeyWhy ?? 'Save the design first; an edited spec is kept under its name.'}</span>
              )
            ) : null}
            {review.state === 'busy' ? (
              <button type="button" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : null}
          </div>
          {reviewBox}
          {draft !== null ? (
            <div className="spec-draft" data-testid={`${tid}-ai-draft`}>
              <div className="spec-label ai">AI draft — not from {ownerName}, check it</div>
              <div className="spec-actions">
                <button
                  type="button"
                  className="primary"
                  data-testid={`${tid}-keep-draft`}
                  onClick={() => {
                    if (!key) return;
                    if (saveUserSpec(storage(), key, draft, '', 'ai-draft')) {
                      setUser(readUserSpec(storage(), key));
                      setDraft(null);
                      setNote('Kept as your copy, marked as an AI draft.');
                    } else setNote('This browser refused to store it — NOT kept.');
                  }}
                >
                  Keep as my copy
                </button>
                <button type="button" onClick={() => setDraft(null)}>
                  Discard
                </button>
              </div>
              <Markdown text={draft} />
            </div>
          ) : editing !== null ? (
            <div className="spec-edit">
              <textarea data-testid={`${tid}-text`} value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck />
              <div className="spec-actions">
                <button type="button" className="primary" data-testid={`${tid}-save`} disabled={editing === shown} onClick={() => void save(editing)}>
                  Save
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : shown ? (
            <div className="spec-body" data-testid={`${tid}-body`}>
              <Markdown text={shown} />
            </div>
          ) : owner ? (
            <p className="note spec-empty">Nothing written yet. Edit to start one, or ask the AI for a draft.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
