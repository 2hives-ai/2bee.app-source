// The Cut assistant: chips and free text, through ONE validator.
//
// Founder 2026-10-12, option B (`cnc/jobAsk.ts`): a model proposes JOB
// SETTINGS ONLY, never G-code; the core re-plans the candidate and only a plan
// the core accepts can be applied. The chips here go through the SAME path:
// a chip is a proposal written as the JSON a model would send, read by
// `readJobProposal`, re-planned by the core, applied only if `mayApplyJob`.
// So a chip cannot do anything a model could not, and both are checked alike.
//
// Two chips need no model (tabs, dogbones). The rest ask the model and are
// offered only when AI is set up (it is set up once, in 2bee.cad).

import { useMemo, useRef, useState } from 'react';
import { askConfigured, classifyThrow, fetchTransport, preflight, readAskConfig, readReply, type AskTransport } from '../cad/ask';
import { buildJobRequest, candidateConfig, mayApplyJob, opOf, patchIsEmpty, patchRows, readJobProposal, type JobContext, type JobPatch } from '../cnc/jobAsk';
import type { JobConfig, Report } from '../cam';
import { resultsLine } from './plan';

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'said'; text: string; bad?: boolean }
  | { kind: 'proposed'; patch: JobPatch; why: string; rows: { label: string; from: string; to: string }[]; candidate: Report | null; err: string | null };

export interface CutAssistantProps {
  config: JobConfig;
  report: Report;
  library: string[];
  facts: Record<string, unknown>;
  planCandidate(config: JobConfig): Promise<Report>;
  onApply(patch: JobPatch): void;
  transport?: AskTransport;
}

const AI_CHIPS: readonly { id: string; label: string; prompt: string }[] = [
  { id: 'faster', label: 'Faster', prompt: 'Make this job faster without risking the cutter.' },
  { id: 'finish', label: 'Cleaner edges', prompt: 'Give cleaner edges on the parts.' },
  { id: 'check', label: 'Check my job', prompt: 'Check this job. Change nothing unless something is wrong, and say why.' },
];

export default function CutAssistant({ config, report, library, facts, planCandidate, onApply, transport = fetchTransport }: CutAssistantProps) {
  const cfg = useMemo(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  }, []);
  const ai = askConfigured(cfg);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [text, setText] = useState('');
  const abort = useRef<AbortController | null>(null);

  const ctx: JobContext = useMemo(
    () => ({
      op: opOf(config),
      toolIds: (config.tool_ids ?? []) as string[],
      library,
      facts,
      plan: { ok: report.ok, refusals: report.refusals, warnings: report.warnings, notes: report.notes, summary: report.ok ? resultsLine(report) : 'refused' },
    }),
    [config, library, facts, report],
  );

  /** Read a reply (model or chip) through the one validator, then re-plan. */
  const consider = async (raw: string) => {
    const p = readJobProposal(raw, ctx);
    if (!p.ok) return setPhase({ kind: 'said', text: `Refused: ${p.problems.join('; ')}`, bad: true });
    if (patchIsEmpty(p.patch)) return setPhase({ kind: 'said', text: p.why });
    setPhase({ kind: 'busy', what: 'Planning…' });
    const rows = patchRows(ctx.op, ctx.toolIds, p.patch);
    try {
      const candidate = await planCandidate(candidateConfig(config, p.patch));
      setPhase({ kind: 'proposed', patch: p.patch, why: p.why, rows, candidate, err: null });
    } catch (e) {
      setPhase({ kind: 'proposed', patch: p.patch, why: p.why, rows, candidate: null, err: String((e as Error).message ?? e) });
    }
  };

  const chip = (changes: Record<string, unknown>, why: string) => void consider(JSON.stringify({ changes, why }));

  const ask = async (prompt: string) => {
    const pre = preflight(cfg, prompt, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) return setPhase({ kind: 'said', text: pre.headline, bad: true });
    setPhase({ kind: 'busy', what: 'Asking…' });
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const res = await transport(buildJobRequest(cfg, prompt, ctx), ctl.signal);
      const r = readReply(res);
      if (!r.ok) return setPhase({ kind: 'said', text: r.failure.headline, bad: true });
      await consider(r.raw);
    } catch (e) {
      setPhase({ kind: 'said', text: classifyThrow(e).headline, bad: true });
    } finally {
      clearTimeout(timer);
    }
  };

  const tabsOn = ctx.op.tabs_enabled === true;
  const dogOn = ctx.op.dogbone !== undefined && ctx.op.dogbone !== 'None';
  const busy = phase.kind === 'busy';
  const c = phase.kind === 'proposed' ? phase.candidate : null;
  const can = phase.kind === 'proposed' && mayApplyJob(c, phase.patch);

  return (
    <section className="cj-panel cj-assist" aria-label="Cut assistant" data-testid="cj-assist">
      <h2>Cut assistant</h2>
      <div className="cj-chips">
        <button type="button" className="cj-chip" disabled={busy} aria-pressed={tabsOn} data-testid="cj-chip-tabs"
          onClick={() => chip({ tabs_enabled: !tabsOn }, tabsOn ? 'No tabs: parts come free at the end.' : 'Tabs hold the parts until the last pass.')}>
          Tabs
        </button>
        <button type="button" className="cj-chip" disabled={busy} aria-pressed={dogOn} data-testid="cj-chip-dogbones"
          onClick={() => chip({ dogbone: dogOn ? 'None' : 'Corner' }, dogOn ? 'No dogbones.' : 'Dogbones let square parts fit inside corners.')}>
          Dogbones
        </button>
        {AI_CHIPS.map((a) => (
          <button key={a.id} type="button" className="cj-chip" disabled={busy || !ai} title={ai ? a.prompt : 'AI is not set up'} data-testid={`cj-chip-${a.id}`} onClick={() => void ask(a.prompt)}>
            {a.label}
          </button>
        ))}
      </div>
      {ai ? (
        <form
          className="cj-ask"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void ask(text.trim());
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask for a change…" disabled={busy} data-testid="cj-ask" aria-label="Ask for a change" />
        </form>
      ) : (
        <p className="cj-muted">AI is off (set it up in 2bee.cad).</p>
      )}
      {busy && <p className="cj-muted">{phase.what}</p>}
      {phase.kind === 'said' && <p className={phase.bad ? 'cj-warn' : 'cj-muted'} data-testid="cj-assist-said">{phase.text}</p>}
      {phase.kind === 'proposed' && (
        <div className="cj-proposal" data-testid="cj-proposal">
          <p>{phase.why}</p>
          <ul>
            {phase.rows.map((r) => (
              <li key={r.label}>
                {r.label}: {r.from} → <b>{r.to}</b>
              </li>
            ))}
          </ul>
          {phase.err && <p className="cj-warn">The core could not plan it: {phase.err}</p>}
          {c && (c.ok ? <p className="cj-ok">Core accepts: {resultsLine(c)}</p> : <p className="cj-warn">Core refuses: {c.refusals.join('; ') || 'no program'}</p>)}
          <div className="cj-row">
            {can && (
              <button type="button" className="cj-primary" data-testid="cj-apply" onClick={() => { onApply(phase.patch); setPhase({ kind: 'idle' }); }}>
                Apply
              </button>
            )}
            <button type="button" onClick={() => setPhase({ kind: 'idle' })}>Discard</button>
          </div>
        </div>
      )}
    </section>
  );
}
