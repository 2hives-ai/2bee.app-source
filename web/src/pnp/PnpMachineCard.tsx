/**
 * A pick-and-place machine as a card: what `pnp` documents about it, "not
 * stated" where it does not, and where each fact came from. Used under the
 * 2bee.pnp 3D view and, by the machines tab, in its PnP section.
 */
import type { ReactNode } from 'react';
import type { PnpMachine } from './pnpMachines';
import './pnp.css';

const STATUS: Record<PnpMachine['status'], string> = {
  designed: 'Designed, not built',
  alternate: 'Alternate design',
  reference: 'Reference, not bought',
};

export function PnpMachineCard({ machine, picker }: { machine: PnpMachine; picker?: ReactNode }) {
  const mm = (v: number | null) => (v === null ? 'not stated' : `${v} mm`);
  const rows: [string, string | null][] = [
    ['Travel X', mm(machine.travel.x)],
    ['Travel Y', mm(machine.travel.y)],
    ['Travel Z', mm(machine.travel.z)],
    ['Nozzles', machine.nozzles],
    ['Feeders', machine.feeders],
    ['Cameras', machine.cameras],
    ['Controller', machine.controller],
    ['Accuracy', machine.accuracy],
  ];
  return (
    <section className="pnp-card" data-testid="pnp-machine-card" aria-label="Pick-and-place machine">
      <header className="pnp-card-head">
        <strong>Machine</strong>
        <span className={`pnp-badge ${machine.status}`}>{STATUS[machine.status]}</span>
      </header>
      {picker}
      <p className="pnp-card-note">{machine.statusNote}</p>
      <dl className="pnp-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={v === null ? 'pnp-unknown' : undefined}>{v ?? 'not stated'}</dd>
          </div>
        ))}
      </dl>
      <p className="pnp-card-note">{machine.travel.basis}</p>
      <details className="pnp-sources">
        <summary>Sources ({machine.sources.length})</summary>
        <ul>
          {machine.sources.map((s) => (
            <li key={s}>
              <code>{s}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export default PnpMachineCard;
