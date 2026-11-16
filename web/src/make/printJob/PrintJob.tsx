// The printer path of the three-step screen: the questions as chips, the
// filament slot, "ask about the print" (AI), and the job summary for Make.
//
// 🔴 THE SAME RULE AS MakeFlow: if a control is not needed for one of the three
// steps it is not here. The founder asked for exactly these: filament, the
// questions with predefined answers, and talking to the AI. Nothing here
// slices, uploads or starts a print.

import { useEffect, useRef, useState } from 'react';
import { askConfigured, fetchTransport, readAskConfig, type AskFailure, type AskTransport } from '../../cad/ask';
import { describe } from './allowlist';
import { askPrint, type PrintProposal } from './ai';
import { QUESTIONS } from './chips';
import {
  chosenAnswer,
  isSlot,
  SLOT_IDS,
  SLOT_LABEL,
  summaryLines,
  tapAnswer,
  type Choice,
  type JobOutcome,
  type Resolved,
  type SlotId,
} from './job';

export interface PrintChangeProps {
  design: string;
  choices: Choice[];
  setChoices: (c: Choice[]) => void;
  slot: SlotId | null;
  setSlot: (s: SlotId | null) => void;
  resolved: Resolved;
  /** Injected in tests. */
  transport?: AskTransport;
}

let aiSeq = 0;

export function PrintChange({ design, choices, setChoices, slot, setSlot, resolved, transport = fetchTransport }: PrintChangeProps) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AskFailure | null>(null);
  const [last, setLast] = useState<{ prompt: string; proposal: PrintProposal } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const cfg = (() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  })();
  const connected = askConfigured(cfg);
  useEffect(() => () => abort.current?.abort(), []);
  /* The choices NOW, read when a reply lands. The chips and "remove" stay live while the model
   * works; appending to the list captured at send undid a line removed or a chip tapped in
   * the meantime (bughunt 2026-11-15). */
  const choicesNow = useRef(choices);
  choicesNow.current = choices;

  const ask = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    abort.current = new AbortController();
    const out = await askPrint({
      cfg,
      prompt,
      ctx: { design, slot, current: resolved.overrides },
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      transport,
      signal: abort.current.signal,
    });
    setBusy(false);
    if (!out.ok) {
      setFailure(out.failure);
      return;
    }
    const p = out.proposal;
    setLast({ prompt, proposal: p });
    /* Only the validated keys are applied; the refused ones ride along so the
     * line can keep showing them. */
    if (Object.keys(p.accepted).length || p.refused.length) {
      setChoices([...choicesNow.current, { kind: 'ai', id: ++aiSeq, prompt, overrides: p.accepted, reasons: p.reasons, refused: p.refused, reply: p.reply }]);
    }
    setPrompt('');
  };

  return (
    <section className="print-job" aria-label="Print settings" data-testid="print-job">
      <h2>How should it print?</h2>
      <p className="make-muted">Tap an answer to change the print. Anything not answered is left to the slicer.</p>
      <label className="print-slot">
        Filament{' '}
        <select
          value={slot ?? ''}
          onChange={(e) => setSlot(isSlot(e.target.value) ? e.target.value : null)}
          data-testid="print-slot"
        >
          <option value="">Pick the slot it is loaded in</option>
          {SLOT_IDS.map((s) => (
            <option key={s} value={s}>
              {SLOT_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <ul className="print-questions">
        {QUESTIONS.map((q) => {
          const on = chosenAnswer(choices, q.id);
          return (
            <li key={q.id} data-testid={`print-q-${q.id}`}>
              <span className="print-q" title={q.help}>
                {q.ask}
              </span>
              <span className="print-chips">
                {q.answers.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="print-chip"
                    aria-pressed={on === a.id}
                    title={a.risk ? `Cost: ${a.risk}` : undefined}
                    onClick={() => setChoices(tapAnswer(choices, q.id, a.id))}
                    data-testid={`print-chip-${q.id}-${a.id}`}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            </li>
          );
        })}
      </ul>

      {connected ? (
        <form
          className="make-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <label htmlFor="print-ask">Ask about the print (optional)</label>
          <textarea
            id="print-ask"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder="e.g. print it quick, or: is support needed?"
            rows={2}
            disabled={busy}
            data-testid="print-ask"
          />
          {busy && <p className="make-muted">Asking the model…</p>}
        </form>
      ) : null}
      {failure && (
        <p className="make-warn" data-testid="print-ai-failed">
          {failure.headline}. {failure.detail} Nothing was changed.
        </p>
      )}
      {last && (
        <div className="print-ai" data-testid="print-ai">
          <p className="make-muted">Asked: “{last.prompt}”</p>
          {last.proposal.reply && <p data-testid="print-ai-reply">{last.proposal.reply}</p>}
          {last.proposal.questions.map((q, i) => (
            <p key={i} className="print-ai-q">
              {q.text}{' '}
              {q.chips.map((c, j) => (
                <button
                  key={j}
                  type="button"
                  className="print-chip"
                  disabled={!Object.keys(c.accepted).length}
                  title={c.refused.length ? `Refused: ${c.refused.map((r) => `${r.key} (${r.why})`).join('; ')}` : undefined}
                  onClick={() => setChoices([...choices, { kind: 'ai-chip', id: ++aiSeq, question: q.text, label: c.label, overrides: c.accepted }])}
                  data-testid="print-ai-chip"
                >
                  {c.label}
                </button>
              ))}
            </p>
          ))}
        </div>
      )}

      {resolved.lines.length > 0 && (
        <ul className="print-lines" data-testid="print-lines">
          {resolved.lines.map((l, i) => (
            <li key={i}>
              <span data-testid="print-line">
                <strong>{l.title}:</strong> {l.what} — because {l.why}
              </span>
              {l.replaced.length > 0 && (
                <small className="make-muted"> ({l.replaced.map((k) => describe(k, resolved.overrides[k]).split(':')[0]).join(', ')} changed again below)</small>
              )}
              {l.refused.map((r, j) => (
                <span key={j} className="print-refused make-warn" data-testid="print-refused">
                  REFUSED {r.key}: {r.why}
                </span>
              ))}
              {choices[l.choice] && choices[l.choice].kind !== 'chip' && (
                <button type="button" className="make-link" onClick={() => setChoices(choices.filter((_, j) => j !== l.choice))}>
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Step 3's job summary: what the job will ask the slicer for, and why. */
export function PrintSummary({ outcome, resolved }: { outcome: JobOutcome; resolved: Resolved }) {
  const lines = summaryLines(resolved);
  return (
    <div className="print-summary" data-testid="print-summary">
      <h2>The print job</h2>
      <ul>
        <li>
          Plate: {outcome.plate.name}
          {outcome.plate.chosen ? '' : ' (the usual one; no answer chose another)'}
        </li>
        {lines.length === 0 && <li className="make-muted">No settings changed: the slicer’s defaults for the X2D apply.</li>}
        {lines.map((l, i) => (
          <li key={i} data-testid="print-summary-line">
            {l.text} <small className="make-muted">— {l.why}</small>
          </li>
        ))}
      </ul>
      {outcome.missing.length > 0 && (
        <ul className="make-warn" data-testid="print-job-missing">
          {outcome.missing.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}
      <details className="make-details">
        <summary>Filled in later</summary>
        <ul>
          {outcome.pending.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
        {outcome.job && <pre className="print-json" data-testid="print-job-json">{JSON.stringify(outcome.job, null, 1)}</pre>}
      </details>
    </div>
  );
}
