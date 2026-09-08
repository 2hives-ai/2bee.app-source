/**
 * OperationPanel — the "Operation" section with machining parameters.
 *
 * Reads state from the Zustand store — no prop drilling.
 * Contains depth/pass, RPM, lead-in, entry mode, direction, tabs, etc.
 */

import { Section } from './SectionPanel';
import { Num, MmOnlySlot } from './NumericInput';
import { typedMm } from './typedMm';
import { useCncStore } from '../store/cncStore';

interface OperationPanelProps {
  sectionEye: (testid: string, title: string) => React.ReactNode;
  layerRows: (testid: string, title: string) => React.ReactNode;
}

/** Factory defaults for the Operation section — same values the Zustand store opens with. */
const OP_DEFAULTS = {
  depthPerPass: 4,
  rpm: 18000,
  finishAllowance: 0,
  leadMm: 0,
  entry: 'Ramp',
  direction: 'Climb',
  dogbone: 'Corner',
  tabsEnabled: true,
  tabHeight: 3,
  tabWidth: 8,
  tabSpacing: 150,
  useWorkpieceEdge: false,
  workpieceEdgeTol: '0.1',
  probeAfterChange: true,
} as const;

export function OperationPanel({ sectionEye, layerRows }: OperationPanelProps) {
  const {
    unit,
    depthPerPass, setDepthPerPass,
    rpm, setRpm,
    finishAllowance, setFinishAllowance,
    leadMm, setLeadMm,
    entry, setEntry,
    direction, setDirection,
    dogbone, setDogbone,
    tabsEnabled, setTabsEnabled,
    tabHeight, setTabHeight,
    tabWidth, setTabWidth,
    tabSpacing, setTabSpacing,
    useWorkpieceEdge, setUseWorkpieceEdge,
    workpieceEdgeTol, setWorkpieceEdgeTol,
    probeAfterChange, setProbeAfterChange,
  } = useCncStore();

  return (
    <Section
      title="Operation"
      testid="panel-op"
      eye={sectionEye('panel-op', 'Operation')}
      layerRows={layerRows('panel-op', 'Operation')}
    >
      <Num
        unit={unit}
        label="Depth / pass"
        value={depthPerPass}
        onChange={setDepthPerPass}
        step={0.5}
        testid="depth-per-pass"
      />
      <Num label="Spindle" value={rpm} onChange={setRpm} step={500} suffix="rpm" testid="rpm" />
      <Num
        unit={unit}
        label="Finish allowance"
        value={finishAllowance}
        onChange={setFinishAllowance}
        step={0.1}
      />
      <Num
        unit={unit}
        label="Lead in/out"
        value={leadMm}
        onChange={setLeadMm}
        step={0.5}
        testid="lead"
      />
      <label className="field">
        <span>Entry</span>
        <select value={entry} onChange={(e) => setEntry(e.target.value)} data-testid="entry">
          <option>Ramp</option>
          <option>Helix</option>
          <option>Plunge</option>
        </select>
      </label>
      <label className="field">
        <span>Direction</span>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          data-testid="direction"
        >
          <option>Climb</option>
          <option>Conventional</option>
        </select>
      </label>
      <label className="field">
        <span>Corner relief</span>
        <select
          value={dogbone}
          onChange={(e) => setDogbone(e.target.value)}
          data-testid="dogbone"
        >
          <option>Corner</option>
          <option>TBoneX</option>
          <option>TBoneY</option>
          <option>None</option>
        </select>
      </label>
      <p className="note">
        Relief applies only where the job already has an inside corner. A global switch would
        bore into the corners of every outside profile and remove material the part needs.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={tabsEnabled}
          onChange={(e) => setTabsEnabled(e.target.checked)}
          data-testid="tabs-enabled"
        />
        Tabs
      </label>
      {tabsEnabled && (
        <>
          <Num label="Tab height" value={tabHeight} onChange={setTabHeight} step={0.5} unit={unit} />
          <Num label="Tab width" value={tabWidth} onChange={setTabWidth} step={1} unit={unit} />
          <Num label="Min spacing" value={tabSpacing} onChange={setTabSpacing} step={10} unit={unit} />
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={useWorkpieceEdge}
          onChange={(e) => setUseWorkpieceEdge(e.target.checked)}
          data-testid="use-workpiece-edge"
        />
        Leave an edge that lies on the workpiece edge uncut
      </label>
      {useWorkpieceEdge && (
        <>
          <label className="field">
            <span>Edge tolerance</span>
            <span className="numwrap">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.1"
                value={workpieceEdgeTol}
                data-testid="workpiece-edge-tolerance"
                onChange={(e) => setWorkpieceEdgeTol(e.target.value)}
              />
              <MmOnlySlot unit={unit} />
            </span>
          </label>
          <p className="warn" data-testid="workpiece-edge-consequences">
            On a skipped edge the workpiece edge must be straight and square, the part&rsquo;s
            dimension on that side becomes the material supplier&rsquo;s tolerance rather than
            the drawing&rsquo;s, and the datum on that side becomes wherever the workpiece
            actually is rather than where it was probed.
          </p>
          <p className="note">
            An edge further inside than the tolerance is cut normally — a near miss left uncut
            leaves a ribbon of material holding the part, which is worse than either. The
            starting 0.1mm is a <b>chosen</b> number, not a measured one: the physical basis is
            your panel supplier&rsquo;s own size tolerance, which this tool does not know.
            {typedMm(workpieceEdgeTol) === undefined ? (
              <>
                {' '}
                <b>
                  Nothing readable is typed, so no tolerance is being sent and the core keeps
                  its own 0.1mm.
                </b>
              </>
            ) : null}
          </p>
          {entry === 'Ramp' ? (
            <p className="warn" data-testid="workpiece-edge-ramp">
              Entry is <b>Ramp</b>, and the core will <b>refuse this job</b>: a skipped edge
              makes the profile an open path with two ends, and a ramped pass finishes what it
              cut with a second lap from the start — on an open path that lap begins at the far
              end and would feed at full depth straight across the finished part. The refusal
              arrives with the plan and names the choice: <b>Plunge</b> entry, or this option
              off.
            </p>
          ) : null}
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={probeAfterChange}
          onChange={(e) => setProbeAfterChange(e.target.checked)}
          data-testid="probe-after-change"
        />
        Re-reference Z after each tool change
      </label>
      {!probeAfterChange && (
        <p className="warn">
          A new tool is a different length. Without a re-reference every cut after the change is
          wrong by that difference.
        </p>
      )}
      <button
        type="button"
        className="reset-btn"
        data-testid="op-reset-defaults"
        onClick={() => {
          setDepthPerPass(OP_DEFAULTS.depthPerPass);
          setRpm(OP_DEFAULTS.rpm);
          setFinishAllowance(OP_DEFAULTS.finishAllowance);
          setLeadMm(OP_DEFAULTS.leadMm);
          setEntry(OP_DEFAULTS.entry);
          setDirection(OP_DEFAULTS.direction);
          setDogbone(OP_DEFAULTS.dogbone);
          setTabsEnabled(OP_DEFAULTS.tabsEnabled);
          setTabHeight(OP_DEFAULTS.tabHeight);
          setTabWidth(OP_DEFAULTS.tabWidth);
          setTabSpacing(OP_DEFAULTS.tabSpacing);
          setUseWorkpieceEdge(OP_DEFAULTS.useWorkpieceEdge);
          setWorkpieceEdgeTol(OP_DEFAULTS.workpieceEdgeTol);
          setProbeAfterChange(OP_DEFAULTS.probeAfterChange);
        }}
      >
        Reset defaults
      </button>
    </Section>
  );
}
