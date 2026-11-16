// The router page: analyse what the controller reports, show it, then walk the
// operator through the measurements the controller cannot answer.
//
// Founder 2026-10-14: *"I attach the cnc router, it will analize, show the
// router in a page and I will do the remaining measurements test been adviced
// on the page"* · *"if measurement needed the system will show what needs to be
// measured and how"* · *"not svg, show it in 3d!"*.
//
// 🔴 WHAT THIS SENDS: `$I`, `$$`, `$#`, `$PINS`, bare, and only after the board
// was identified as grblHAL, while Idle or Alarm, and never while a job streams.
// grblHAL documents all four as reads (system.c:309-310, 612-636; report.c:2408).
// Nothing else. The measurement steps are instructions to a person; this page
// never sends a motion, a spindle command or a setting.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { StatusReport, TrackedState } from './protocol';
import {
  ANALYSE_COMMANDS,
  AXES,
  AXIS_INDEX,
  analyse,
  measurementsFor,
  pinsSeen,
  profileOf,
  verdictFor,
  type Measurement,
  type RouterProfile,
} from './routerProfile';
import { routerScene } from './routerScene';
import Measure3D from '../shop-setup/Measure3D';

export interface RouterPageProps {
  tracked: TrackedState;
  report: StatusReport | null;
  lastWco: number[] | null;
  /** Every line the controller sent on this connection, oldest first. */
  inbound: readonly { text: string; at: number }[];
  writeLine: (line: string) => void;
  streaming: boolean;
}

const MEASURED_KEY = '2bee.app.router.measured';

function readMeasured(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(MEASURED_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function writeMeasured(v: Record<string, number>) {
  try {
    localStorage.setItem(MEASURED_KEY, JSON.stringify(v));
  } catch {
    /* Not remembered. The page still works for this visit. */
  }
}

/** Why Analyse cannot run now, or null. */
export function analyseBlocker(t: TrackedState, streaming: boolean): string | null {
  if (t.identification !== 'grblHAL') return 'Connect and identify the router first. Analysis is only sent to a board identified as grblHAL.';
  if (streaming) return 'A job is streaming. Analysis waits until it has finished.';
  if (t.controllerState !== 'Idle' && t.controllerState !== 'Alarm') return `The controller is in ${t.controllerState}. Analysis runs in Idle or Alarm only.`;
  return null;
}

/** Machine position from a report: MPos directly, or WPos + WCO. */
export function machinePosition(r: StatusReport | null, wco: number[] | null): number[] | null {
  if (!r?.position) return null;
  if (r.positionKind === 'MPos') return r.position;
  if (r.positionKind === 'WPos' && wco) return r.position.map((v, i) => v + (wco[i] ?? 0));
  return null;
}

export default function RouterPage({ tracked, report, lastWco, inbound, writeLine, streaming }: RouterPageProps) {
  const [since, setSince] = useState<number | null>(null);
  const [measured, setMeasured] = useState<Record<string, number>>(readMeasured);
  const [seen, setSeen] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const blocker = analyseBlocker(tracked, streaming);

  /* Fold every line since Analyse was pressed. Re-derived, never accumulated,
   * so a re-render cannot double-count a reply. */
  const profile: RouterProfile | null = useMemo(() => {
    if (since === null) return null;
    return profileOf(analyse(inbound.filter((l) => l.at >= since).map((l) => l.text)));
  }, [inbound, since]);

  const measurements = useMemo(() => (profile ? measurementsFor(profile) : []), [profile]);

  const pnRef = useRef<string | null>(null);
  useEffect(() => {
    const pn = report?.pn ?? null;
    if (pn && pn !== pnRef.current) setSeen((s) => pinsSeen(s, pn));
    pnRef.current = pn;
  }, [report]);

  const set = (key: string, v: number | undefined) => {
    setMeasured((m) => {
      const n = { ...m };
      if (v === undefined || !Number.isFinite(v)) delete n[key];
      else n[key] = v;
      writeMeasured(n);
      return n;
    });
  };

  const run = () => {
    if (blocker) return;
    setSince(Date.now());
    setSeen('');
    for (const c of ANALYSE_COMMANDS) writeLine(c);
  };

  const mpos = machinePosition(report, lastWco);

  return (
    <div className="block router" data-testid="run-router" style={{ marginTop: 12 }}>
      <strong>Your router</strong>
      <p className="note" style={{ margin: '4px 0 8px' }}>
        Reads what the controller reports. Sends only {ANALYSE_COMMANDS.join(', ')}, which change nothing. The
        measurements below are done by you at the machine; this page never moves it.
      </p>
      <button type="button" onClick={run} disabled={blocker !== null} data-refused={blocker ? 'router-analyse' : undefined} data-testid="router-analyse">
        Analyse router
      </button>
      {blocker && (
        <p className="note" data-testid="router-blocked">
          {blocker}
        </p>
      )}

      {profile && (
        <>
          <div className="router-top">
            <Measure3D scene={routerScene('travel', profile)} label="Your router, scaled from its reported travel" width={360} height={240} />
            <table className="router-facts" data-testid="router-facts">
              <tbody>
                <tr><th>Firmware</th><td>{profile.firmware ?? 'not reported'}</td></tr>
                <tr><th>Travel (set)</th><td>{AXES.map((a) => `${a} ${profile.travel[a] ?? '?'}`).join(' · ')} mm</td></tr>
                <tr><th>Steps per mm</th><td>{AXES.map((a) => `${a} ${profile.stepsPerMm[a] ?? '?'}`).join(' · ')}</td></tr>
                <tr><th>Max speed</th><td>{AXES.map((a) => `${a} ${profile.maxRate[a] ?? '?'}`).join(' · ')} mm/min</td></tr>
                <tr><th>Acceleration</th><td>{AXES.map((a) => `${a} ${profile.accel[a] ?? '?'}`).join(' · ')} mm/s²</td></tr>
                <tr><th>Spindle</th><td>{profile.spindleRpm.max == null ? 'no range reported' : `${profile.spindleRpm.min ?? 0}–${profile.spindleRpm.max} rpm`}</td></tr>
                <tr><th>Homing / soft / hard limits</th><td>{[profile.homing, profile.softLimits, profile.hardLimits].map((b) => (b == null ? '?' : b ? 'on' : 'off')).join(' / ')}</td></tr>
                <tr><th>Probe</th><td>{profile.probeWired == null ? 'not reported' : profile.probeWired ? 'configured' : 'none'}</td></tr>
              </tbody>
            </table>
          </div>
          {profile.flags.length > 0 && (
            <ul className="router-flags" data-testid="router-flags">
              {profile.flags.map((f, i) => (
                <li key={i} className={f.level === 'stop' ? 'bad' : 'warn'}>{f.text}</li>
              ))}
            </ul>
          )}

          <h3 style={{ margin: '14px 0 6px' }}>Measurements</h3>
          <ol className="router-measure" data-testid="router-measurements">
            {measurements.map((m) => (
              <MeasureItem
                key={m.id}
                m={m}
                profile={profile}
                measured={measured}
                seen={seen}
                mpos={mpos}
                homed={!!report?.homed?.all || tracked.homingSeen}
                open={open === m.id}
                onToggle={() => setOpen(open === m.id ? null : m.id)}
                set={set}
              />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function MeasureItem(props: {
  m: Measurement;
  profile: RouterProfile;
  measured: Record<string, number>;
  seen: string;
  mpos: number[] | null;
  homed: boolean;
  open: boolean;
  onToggle: () => void;
  set: (k: string, v: number | undefined) => void;
}) {
  const { m, profile, measured, seen, mpos, homed, open, onToggle, set } = props;
  const v = verdictFor(m, profile, measured, seen);
  const live =
    m.id === 'switches' ? `Seen: ${seen || 'none yet'}` : m.id === 'homing' ? (homed ? 'Homed.' : 'Not homed yet.') : null;
  const axisOf = (key: string) => (key.startsWith('travel') ? (key.slice(6) as 'X' | 'Y' | 'Z') : null);
  return (
    <li data-testid={`router-m-${m.id}`}>
      <button type="button" className="router-m-head" onClick={onToggle} aria-expanded={open}>
        <span className={`router-v router-v-${v.status}`}>{v.status === 'ok' ? '✓' : v.status === 'pending' ? '○' : '!'}</span> {m.title}
        {m.moves && <span className="warn"> · moves the machine</span>}
      </button>
      {open && (
        <div className="router-m-body">
          <Measure3D
            scene={routerScene(m.diagram, profile, m.id.startsWith('steps') ? (m.id.slice(5) as 'X' | 'Y' | 'Z') : undefined)}
            label={m.title}
          />
          <div>
            <p>{m.what}</p>
            <ol>
              {m.how.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
            {live && <p className="note" data-testid={`router-live-${m.id}`}>{live}</p>}
            {m.inputs.map((inp) => {
              const ax = axisOf(inp.key);
              return (
                <label key={inp.key} className="router-input">
                  {inp.label}{' '}
                  <input
                    type="number"
                    step="0.01"
                    value={measured[inp.key] ?? ''}
                    onChange={(e) => set(inp.key, e.target.value === '' ? undefined : Number(e.target.value))}
                  />{' '}
                  {inp.unit}
                  {ax && (
                    <button
                      type="button"
                      disabled={!mpos}
                      data-refused={mpos ? undefined : 'no-machine-position'}
                      title={mpos ? 'Take the machine position the controller reports now' : 'No machine position reported yet'}
                      onClick={() => mpos && set(inp.key, mpos[AXIS_INDEX[ax]])}
                    >
                      Use position
                    </button>
                  )}
                </label>
              );
            })}
            <p className={v.status === 'ok' ? 'ok' : v.status === 'pending' ? 'note' : v.status === 'stop' ? 'bad' : 'warn'} data-testid={`router-verdict-${m.id}`}>
              {v.text}
            </p>
          </div>
        </div>
      )}
    </li>
  );
}
