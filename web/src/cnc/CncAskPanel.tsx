/**
 * 2bee.cnc — Ask a model to change the JOB SETTINGS (founder 2026-10-12, option B).
 *
 * Flow: ask → the model proposes a settings patch → `readJobProposal` refuses
 * anything outside the rules in `jobAsk.ts` → the CORE re-plans the candidate
 * (`planCandidate`, the tab's own `planImportMany`) → the operator sees what
 * changes and what the core said → Apply sets the same store fields the
 * Operation panel sets. Nothing here writes G-code, and a candidate the core
 * refused has no Apply button.
 *
 * Endpoint, model and key are the SAME settings as the 2bee.cad panel
 * (`ASK_CONFIG_KEY`): one endpoint per browser, not one per tab.
 */
import { useCallback, useRef, useState } from 'react';
import {
  AskSettings,
  classifyThrow,
  fetchTransport,
  preflight,
  readAskConfig,
  readReply,
  writeAskConfig,
  type AskConfig,
  type AskFailure,
  type AskTransport,
} from '../cad/ask';
import type { JobConfig } from '../cam';
import {
  buildJobRequest,
  candidateConfig,
  jobTransmissionSummary,
  mayApplyJob,
  patchIsEmpty,
  patchRows,
  readJobProposal,
  type JobContext,
  type JobPatch,
} from './jobAsk';

/** What the core said about a plan, reduced to what the operator compares. */
export interface PlanOutcome {
  ok: boolean;
  refusals: string[];
  warnings: string[];
  lines: number;
  seconds: number;
}

export interface CncAskPanelProps {
  config: JobConfig;
  context: JobContext;
  current: PlanOutcome | null;
  /** Plan this config with the tab's own planner. Throws or returns the outcome. */
  planCandidate(config: JobConfig): Promise<PlanOutcome>;
  onApply(patch: JobPatch): void;
  /** Injected in tests; the real one is `fetch`. */
  transport?: AskTransport;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'failed'; failure: AskFailure }
  | { kind: 'refused'; problems: string[]; raw: string }
  | { kind: 'planning'; patch: JobPatch; why: string }
  | { kind: 'proposed'; patch: JobPatch; why: string; unchanged: string[]; candidate: PlanOutcome | null; planError: string | null }
  | { kind: 'applied'; rows: { label: string; from: string; to: string }[] };

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function CncAskPanel({ config, context, current, planCandidate, onApply, transport = fetchTransport }: CncAskPanelProps) {
  const [cfg, setCfg] = useState<AskConfig>(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);

  const patchCfg = useCallback((p: Partial<AskConfig>) => {
    setCfg((c) => {
      const next = { ...c, ...p };
      try {
        writeAskConfig(next, globalThis.localStorage);
      } catch {
        /* Storage blocked: the setting holds for this page only. */
      }
      return next;
    });
  }, []);

  const send = useCallback(async () => {
    const pre = preflight(cfg, prompt, typeof navigator === 'undefined' ? true : navigator.onLine);
    if (pre) return setPhase({ kind: 'failed', failure: pre });
    setPhase({ kind: 'sending' });
    const ctl = new AbortController();
    abort.current = ctl;
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const res = await transport(buildJobRequest(cfg, prompt, context), ctl.signal);
      const r = readReply(res);
      if (!r.ok) return setPhase({ kind: 'failed', failure: r.failure });
      const p = readJobProposal(r.raw, context);
      if (!p.ok) return setPhase({ kind: 'refused', problems: p.problems, raw: r.raw });
      if (patchIsEmpty(p.patch)) {
        return setPhase({ kind: 'proposed', patch: p.patch, why: p.why, unchanged: p.unchanged, candidate: null, planError: null });
      }
      setPhase({ kind: 'planning', patch: p.patch, why: p.why });
      try {
        const candidate = await planCandidate(candidateConfig(config, p.patch));
        setPhase({ kind: 'proposed', patch: p.patch, why: p.why, unchanged: p.unchanged, candidate, planError: null });
      } catch (e) {
        setPhase({
          kind: 'proposed', patch: p.patch, why: p.why, unchanged: p.unchanged, candidate: null,
          planError: String(e instanceof Error ? e.message : e),
        });
      }
    } catch (e) {
      setPhase({ kind: 'failed', failure: classifyThrow(e) });
    } finally {
      clearTimeout(timer);
      abort.current = null;
    }
  }, [cfg, prompt, context, config, planCandidate, transport]);

  const sending = phase.kind === 'sending' || phase.kind === 'planning';

  return (
    <div data-testid="cnc-ask">
      <p className="note" style={{ marginTop: 0 }}>
        A model proposes new <b>operation settings or cutters</b>. The core re-plans with them and you
        apply only a plan it accepts. It cannot change the machine, workpiece, material or clamps, and it
        never writes G-code.
      </p>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <button type="button" data-testid="cnc-ask-settings-toggle" onClick={() => setSettingsOpen((o) => !o)}>
          {settingsOpen ? 'Close settings' : 'Endpoint…'}
        </button>
        <span className="note" style={{ margin: 0 }} data-testid="cnc-ask-endpoint">
          {cfg.endpoint ? `${cfg.model || '(no model)'} @ ${cfg.endpoint}` : 'no endpoint set'}
        </span>
      </div>
      {settingsOpen ? <AskSettings cfg={cfg} onPatch={patchCfg} onClose={() => setSettingsOpen(false)} /> : null}

      <textarea
        data-testid="cnc-ask-prompt"
        aria-label="What should change in this job?"
        placeholder="e.g. fewer passes in this ply, or add tabs so the parts stay put"
        rows={3}
        style={{ width: '100%', boxSizing: 'border-box' }}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={sending}
      />
      <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
        <button type="button" data-testid="cnc-ask-send" onClick={() => void send()} disabled={sending}>
          {phase.kind === 'sending' ? 'Asking…' : phase.kind === 'planning' ? 'Planning…' : 'Ask'}
        </button>
        {sending ? (
          <button type="button" onClick={() => abort.current?.abort()} data-testid="cnc-ask-cancel">
            Cancel
          </button>
        ) : null}
      </div>
      <details>
        <summary className="note">What is sent</summary>
        <ul className="notes">
          {jobTransmissionSummary(buildJobRequest(cfg, prompt, context), prompt, context).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>

      {phase.kind === 'failed' ? (
        <p className="bad" data-testid="cnc-ask-failed" title={phase.failure.detail}>
          {phase.failure.headline}. The job is untouched.
        </p>
      ) : null}

      {phase.kind === 'refused' ? (
        <div className="block" data-testid="cnc-ask-refused">
          <strong>Proposal refused — nothing was planned or changed.</strong>
          <ul className="notes">
            {phase.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {phase.kind === 'proposed' ? (
        <ProposalBox
          phase={phase}
          context={context}
          current={current}
          onApply={() => {
            const rows = patchRows(context.op, context.toolIds, phase.patch);
            onApply(phase.patch);
            setPhase({ kind: 'applied', rows });
          }}
          onDiscard={() => setPhase({ kind: 'idle' })}
        />
      ) : null}

      {phase.kind === 'applied' ? (
        <p className="ok" data-testid="cnc-ask-applied">
          Applied: {phase.rows.map((r) => `${r.label} ${r.to}`).join(' · ')}. The job re-plans as usual.
        </p>
      ) : null}
    </div>
  );
}

function ProposalBox({
  phase,
  context,
  current,
  onApply,
  onDiscard,
}: {
  phase: Extract<Phase, { kind: 'proposed' }>;
  context: JobContext;
  current: PlanOutcome | null;
  onApply(): void;
  onDiscard(): void;
}) {
  const rows = patchRows(context.op, context.toolIds, phase.patch);
  const c = phase.candidate;
  const can = mayApplyJob(c, phase.patch);
  return (
    <div className="block" data-testid="cnc-ask-proposal">
      <p style={{ margin: '0 0 6px' }}>
        <b>Model:</b> {phase.why}
      </p>
      {rows.length === 0 ? (
        <p className="note" data-testid="cnc-ask-no-change">
          No change proposed{phase.unchanged.length ? ` (${phase.unchanged.join(', ')} already as asked)` : ''}.
        </p>
      ) : (
        <table className="kv" data-testid="cnc-ask-diff">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.from}</td>
                <td>→ {r.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {phase.planError ? (
        <p className="bad" data-testid="cnc-ask-plan-error">
          The core could not plan the candidate: {phase.planError}
        </p>
      ) : null}
      {c ? (
        <div data-testid="cnc-ask-candidate">
          {c.ok && c.refusals.length === 0 ? (
            <p className="ok" style={{ margin: '6px 0' }}>
              The core accepts it: {c.lines} lines, about {mmss(c.seconds)}
              {current?.ok ? ` (now ${current.lines} lines, ${mmss(current.seconds)})` : ''}.
            </p>
          ) : (
            <>
              <p className="bad" style={{ margin: '6px 0' }}>The core refuses this plan, so it cannot be applied:</p>
              <ul className="notes" data-testid="cnc-ask-candidate-refusals">
                {c.refusals.length ? (
                  c.refusals.map((r) => <li key={r}>{r}</li>)
                ) : (
                  <li>the core returned no program and named no reason</li>
                )}
              </ul>
            </>
          )}
          {c.warnings.length ? (
            <details>
              <summary className="note">{c.warnings.length} warning(s) on the candidate</summary>
              <ul className="notes">
                {c.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        {can ? (
          <button type="button" data-testid="cnc-ask-apply" onClick={onApply}>
            Apply
          </button>
        ) : null}
        <button type="button" data-testid="cnc-ask-discard" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

export default CncAskPanel;
