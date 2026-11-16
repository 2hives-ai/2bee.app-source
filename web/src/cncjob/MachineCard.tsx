// One router as a card: name, state, current job and progress. MONITOR ONLY.
//
// Founder 2026-10-14: *"on the main page just monitor the cnc and send the job
// to the cnc"*. The card's one control that acts on the machine is FEED HOLD,
// shown only while it is running — stopping is allowed anywhere a machine is
// shown, starting is not. "Send" (passed in by the page) only adds to the queue.

import type { ReactNode } from 'react';
import { displayName, isSimulated, type Machine } from './machines';
import type { SimSnapshot } from './simController';
import type { Job } from './jobs';

export function stateClass(state: string): string {
  if (state.startsWith('Run')) return 'run';
  if (state.startsWith('Hold')) return 'hold';
  if (state.startsWith('Alarm') || state.startsWith('Door')) return 'alarm';
  if (state === 'Idle') return 'idle';
  return 'off';
}

export function stateWord(m: Machine, snap: SimSnapshot | null): string {
  if (!isSimulated(m)) return 'not connected';
  return snap?.state ?? 'Offline';
}

/**
 * 🔴 THE CARD'S STATE IS CONTROLLER STATUS, NOT SAFETY (pcb 2026-10-15-01-20-26).
 * grblHAL's `?` state is status. The Alarm (HBS57 ALM → reset input) and Door
 * (VFD fault → safety door) mappings are DESIGNED, NOT WIRED, so no Alarm or
 * Door here says nothing about the machine being safe. This label never says
 * "safe", "ready" or "OK", whatever the state.
 */
export function statusLabel(word: string): string {
  return `controller status: ${word}`;
}

export const NOT_SAFETY =
  'Controller status only. Alarm and Door wiring is designed, not fitted: no Alarm here does not mean safe.';

export default function MachineCard({
  machine,
  snap,
  job,
  onFeedHold,
  children,
  selected,
  onSelect,
}: {
  machine: Machine;
  snap: SimSnapshot | null;
  job: Job | null;
  onFeedHold?: () => void;
  children?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const word = stateWord(machine, snap);
  const s = snap?.stream;
  const pct = s && s.total ? Math.round((100 * s.acked) / s.total) : 0;
  const running = !!s && s.state === 'streaming';
  const t = machine.profile?.travel;
  return (
    <article className={`cj-card${selected ? ' cj-card-on' : ''}`} data-testid={`cj-machine-${machine.id}`} aria-label={displayName(machine)}>
      <header className="cj-card-head">
        <button type="button" className="cj-card-name" onClick={onSelect} aria-pressed={selected} title="Plan for this machine">
          {machine.hostname}
        </button>
        <span className={`cj-badge cj-st-${stateClass(word)}`} data-testid={`cj-state-${machine.id}`}>
          {statusLabel(word)}
        </span>
      </header>
      {isSimulated(machine) ? (
        <p className="cj-sim" data-testid="cj-simulated">SIMULATED: nothing moves.</p>
      ) : (
        <p className="cj-muted">Bridge not built yet.</p>
      )}
      <p className="cj-muted cj-small" title={NOT_SAFETY}>{NOT_SAFETY}</p>
      {machine.host ? <p className="cj-muted cj-small">{machine.host.mdns} · {machine.host.os}</p> : null}
      {t && (t.X || t.Y) ? <p className="cj-muted">Travel {t.X ?? '?'} × {t.Y ?? '?'} × {t.Z ?? '?'} mm (configured)</p> : null}
      {job ? (
        <div className="cj-card-job">
          <span className="cj-job-name">{job.title}</span>
          {s && s.jobId === job.id ? (
            <>
              <span className="cj-muted">{s.phase === 'aircut' ? 'air cut' : 'cut'} {pct}%</span>
              <div className="cj-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${pct}%` }} />
              </div>
            </>
          ) : (
            <span className="cj-muted">{job.state}</span>
          )}
        </div>
      ) : (
        <p className="cj-muted">No job running.</p>
      )}
      <div className="cj-row">
        {running && onFeedHold ? (
          <button type="button" className="cj-hold" onClick={onFeedHold} data-testid={`cj-feedhold-${machine.id}`}>
            Feed Hold
          </button>
        ) : null}
        {children}
      </div>
    </article>
  );
}
