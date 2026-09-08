/**
 * SimulationPanel — the "Simulation" section showing cut verification results.
 *
 * Extracted from App.tsx to reduce component size.
 * Displays gouges, uncut material, spoilboard penetration, and past-edge checks.
 */

import { Section } from './SectionPanel';
import type { Report } from '../cam';

/** Format a distance in mm. */
function L(mm: number): string {
  return `${mm.toFixed(1)} mm`;
}

interface SimulationPanelProps {
  report: Report;
  uncutState: 'pending' | 'clean' | 'finding';
  spoilboardPos: 'assumed' | 'entered';
  sectionEye: (testid: string, title: string) => React.ReactNode;
}

export function SimulationPanel({ report, uncutState, spoilboardPos, sectionEye }: SimulationPanelProps) {
  return (
    <Section
      title="Simulation"
      testid="panel-sim"
      eye={sectionEye('panel-sim', 'Simulation')}
      badge={(() => {
        const findings =
          (report.sim.gouge > 0 ? 1 : 0) +
          (report.sim.uncut > 0 ? 1 : 0) +
          (report.sim.spoilboard_position_checked === true &&
          (report.sim.past_spoilboard_edge ?? 0) > 0
            ? 1
            : 0);
        if (findings > 0)
          return {
            text: `${findings} finding${findings === 1 ? '' : 's'}`,
            tone: 'bad' as const,
          };
        if (
          report.sim.spoilboard_position_checked !== true ||
          report.sim.uncut_checked !== true
        )
          return { text: 'PENDING', tone: 'warn' as const };
        return null;
      })()}
    >
      <div className="grid2">
        <span>Cell</span>
        <b>{L(report.sim.cell_mm)}</b>
        <span>Gouges</span>
        <b data-testid="sim-gouge" className={report.sim.gouge ? 'bad' : 'ok'}>
          {report.sim.gouge}
        </b>
        <span>Uncut</span>
        <b
          data-testid="sim-uncut"
          data-uncut-state={uncutState}
          className={
            uncutState === 'finding' ? 'bad' : uncutState === 'clean' ? 'ok' : 'pending'
          }
        >
          {report.sim.uncut}
        </b>
        <span>Below the workpiece</span>
        <b data-testid="sim-spoil">{report.sim.spoilboard}</b>
        <span>Past the board's edge</span>
        <b
          data-testid="sim-past-spoil"
          className={
            report.sim.spoilboard_position_checked !== true
              ? 'pending'
              : (report.sim.past_spoilboard_edge ?? 0) > 0
                ? 'bad'
                : spoilboardPos === 'assumed'
                  ? 'warnval'
                  : 'ok'
          }
        >
          {report.sim.spoilboard_position_checked !== true
            ? 'PENDING'
            : `${report.sim.past_spoilboard_edge ?? 0}${
                spoilboardPos === 'assumed' ? ' (ASSUMED board)' : ''
              }`}
        </b>
      </div>
      {report.sim.spoilboard_position_checked !== true && (
        /* The core's own sentence, verbatim, on the panel that shows
           the number it qualifies. It also appears in Notes; both
           exist because either alone can be missed — the flag by a
           human, the note by a gate. */
        <p className="note pending" data-testid="sim-spoil-pending">
          <b>Past the board's edge is PENDING, not a pass.</b>{' '}
          {report.sim.spoilboard_pending_reason ??
            'No spoilboard is declared on this machine, so the below-the-workpiece cells were judged on DEPTH ALONE.'}
        </p>
      )}
      {uncutState === 'pending' && (
        <p className="note pending" data-testid="sim-uncut-pending">
          <b>Uncut is PENDING, not a pass.</b>{' '}
          {report.sim.uncut_pending_reason ??
            'The uncut test did not run on this job, so 0 means the question was never asked rather than that nothing was left standing.'}
        </p>
      )}
      {uncutState !== 'pending' && (
        <p className="note" data-testid="sim-uncut-measured">
          <b>
            {uncutState === 'finding'
              ? 'Uncut was MEASURED, and material is left standing.'
              : 'Uncut was MEASURED, and nothing was left standing.'}
          </b>{' '}
          The core tested {report.sim.uncut_cells_tested ?? 0} cell
          {(report.sim.uncut_cells_tested ?? 0) === 1 ? '' : 's'} inside the regions this
          job declares as <em>must be removed to a depth</em>. That is a result rather
          than a PENDING — and it says nothing about anything outside those regions, or
          about anything the simulation does not model.
        </p>
      )}
      {report.sim.first && <p className="note">{report.sim.first}</p>}
    </Section>
  );
}
