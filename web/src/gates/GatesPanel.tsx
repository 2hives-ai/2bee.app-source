/**
 * The right-hand gates column, the same on every tab that runs something
 * (founder 2026-10-16: "List the gates on the right navbar (create a right
 * navbar like the left ai one), able to collapse it, create similar navbar on
 * pnp and 3d").
 *
 * It DISPLAYS gates; it decides nothing. Each tab computes its own gates
 * (cnc: cnc/runGates.ts) and gates its own buttons on them. Collapsed, it is a
 * narrow strip that still shows the count of FAIL / PENDING, so hiding the
 * panel never hides that something is wrong.
 */
import { useState } from 'react';

export type PanelGateState = 'PASS' | 'FAIL' | 'PENDING';
export interface PanelGate {
  id: string;
  name: string;
  state: PanelGateState;
  why: string;
  guards?: string;
  /** A person's action that can clear this gate (a confirmation the app may not make). */
  action?: { label: string; onClick: () => void };
}

const ICON: Record<PanelGateState, string> = { PASS: '✓', FAIL: '✕', PENDING: '…' };

export function GatesPanel({
  gates,
  storeKey,
  title = 'Gates',
  onFix,
  fixing = false,
  fixNotes = [],
  foot = 'Run stays off until every gate passes. "…" means not checked yet, which is not a pass.',
}: {
  gates: readonly PanelGate[];
  storeKey: string;
  title?: string;
  /** "Fix with AI": the tab fixes what it safely can and reports the rest in `fixNotes`. */
  onFix?: () => void;
  fixing?: boolean;
  fixNotes?: string[];
  /** The line under the list: what these gates hold back on this tab. */
  foot?: string;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return globalThis.localStorage?.getItem(storeKey) === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        globalThis.localStorage?.setItem(storeKey, c ? 'open' : 'collapsed');
      } catch {
        /* remembered for this page only */
      }
      return !c;
    });
  const fails = gates.filter((g) => g.state === 'FAIL').length;
  const pending = gates.filter((g) => g.state === 'PENDING').length;
  const summary = fails ? `${fails} failing` : pending ? `${pending} pending` : gates.length ? 'all pass' : 'none';
  const tone = fails ? 'fail' : pending ? 'pending' : 'pass';

  if (collapsed) {
    return (
      <aside className={`gates-panel gates-collapsed gates-${tone}`} aria-label={`${title}: ${summary}`} data-testid="gates-panel">
        <button type="button" className="gates-toggle" onClick={toggle} title={`Show ${title.toLowerCase()} (${summary})`} data-testid="gates-expand">
          ‹
        </button>
        <span className="gates-strip-count">{fails || pending || '✓'}</span>
        <span className="gates-strip-label">{title}</span>
      </aside>
    );
  }
  return (
    <aside className={`gates-panel gates-${tone}`} aria-label={title} data-testid="gates-panel">
      <header className="gates-head">
        <strong>{title}</strong>
        <span className={`gates-summary gates-${tone}`}>{summary}</span>
        <button type="button" className="gates-toggle" onClick={toggle} title={`Collapse ${title.toLowerCase()}`} data-testid="gates-collapse">
          ›
        </button>
      </header>
      {onFix && gates.some((g) => g.state !== 'PASS') ? (
        <button type="button" className="primary gates-fix" onClick={onFix} disabled={fixing} data-testid="gates-fix">
          {fixing ? 'Fixing…' : 'Fix with AI'}
        </button>
      ) : null}
      {fixNotes.length ? (
        <ul className="gates-fix-notes" data-testid="gates-fix-notes">
          {fixNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
      <ol className="gates-list">
        {gates.map((g) => (
          <li key={g.id} className={`gate gate-${g.state.toLowerCase()}`} data-testid={`gate-${g.id}`} data-state={g.state}>
            <span className="gate-icon" aria-hidden="true">{ICON[g.state]}</span>
            <div>
              <div className="gate-name">{g.name}</div>
              <div className="gate-why">{g.why}</div>
              {g.guards ? <div className="gate-guards">Guards: {g.guards}</div> : null}
              {g.action ? (
                <button type="button" className="gate-action" data-testid={`gate-${g.id}-action`} onClick={g.action.onClick}>
                  {g.action.label}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="note gates-foot">{foot}</p>
    </aside>
  );
}

export default GatesPanel;
