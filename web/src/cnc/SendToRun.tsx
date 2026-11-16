/**
 * cnc → cnc.run (founder 2026-10-15: "test if the machine is connected, able to
 * send the config to cnc.run (have a run button)").
 *
 * Picks a machine from cnc.run's registry (`cncjob/machines.ts`: the simulated
 * one and any bridge machine), checks it answers, and QUEUES the planned program
 * as a job there (`cncjob/jobs.ts::enqueue`, the same call 2bee.cnc's Send
 * makes), then opens cnc.run. Nothing here moves a machine: Play in cnc.run
 * does, after its steps, the forced air cut and "I am at the machine" — and a
 * real machine stays blocked until ops closes H5.
 *
 * ⚠ "Connected" for a bridge machine means its URL answered an HTTP request,
 * nothing more: it is not the controller's state. The simulated machine is
 * always there and says so.
 */
import { useEffect, useState } from 'react';
import type { JobConfig, SetupAnswer, SetupFacts } from '../cam';
import { mayRun, mayTest, type Gate } from './runGates';
import { enqueue, newJobId } from '../cncjob/jobs';
import { markLoaded } from '../loaded';
import { displayName, isSimulated, type Machine } from '../cncjob/machines';
import { sha256Hex } from '../cncjob/plan';
import { applyBook, getState, useCncJobs, WHO } from '../cncjob/state';

export interface SendToRunProps {
  /** The plan on screen. `null` while nothing is planned. */
  report: { ok: boolean; gcode: string; estimated_seconds: number; tools_used: string[]; tool_changes: number; deepest_z_mm: number; rapid_mm_min?: number | null } | null;
  config: JobConfig;
  sectionZ: number | null;
  stock: { x: number; y: number; t: number };
  /** The loaded design(s), for the job's title. */
  drawings: { name: string }[];
  /** Setup facts for EXACTLY the planned program (same inputs as the plan). */
  factsFor(): Promise<SetupAnswer>;
  onOpenRun(): void;
  /** The pre-run gates (cnc/runGates.ts), machine gate included. Run needs all PASS. */
  gates: Gate[];
  /** Tell the gates which machine is chosen and what its Test said. */
  onMachine(m: { name: string; check: 'untested' | 'ok' | 'simulated' | 'unreachable'; detail?: string } | null): void;
}

type Check = { state: 'idle' | 'checking' } | { state: 'ok' | 'bad'; text: string };

export function SendToRun({ report, config, sectionZ, stock, drawings, factsFor, onOpenRun, gates, onMachine }: SendToRunProps) {
  const { reg } = useCncJobs();
  const machines: Machine[] = reg.machines;
  const [id, setId] = useState<string>(() => machines[0]?.id ?? '');
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const m = machines.find((x) => x.id === id) ?? null;
  /* A simulated machine is always there: it passes the machine gate without a Test. */
  useEffect(() => {
    if (m && isSimulated(m) && check.state === 'idle') setCheck({ state: 'ok', text: 'Simulated machine: always connected (nothing real moves).' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.id, check.state]);
  const machineCheck = !m
    ? null
    : check.state === 'ok'
      ? { name: displayName(m), check: isSimulated(m) ? ('simulated' as const) : ('ok' as const) }
      : check.state === 'bad'
        ? { name: displayName(m), check: 'unreachable' as const, detail: check.text }
        : { name: displayName(m), check: 'untested' as const };
  const machineKey = JSON.stringify(machineCheck);
  useEffect(() => {
    onMachine(machineCheck);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineKey]);
  const blocking = gates.filter((g) => g.state !== 'PASS');

  const test = async () => {
    if (!m) return;
    if (isSimulated(m)) {
      setCheck({ state: 'ok', text: 'Simulated machine: always connected (nothing real moves).' });
      return;
    }
    if (m.connection.kind !== 'bridge') return;
    setCheck({ state: 'checking' });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(m.connection.url, { signal: ctl.signal });
      setCheck({ state: 'ok', text: `${displayName(m)} answered (HTTP ${r.status}). That is the bridge, not the controller's state.` });
    } catch (e) {
      setCheck({ state: 'bad', text: `${displayName(m)} did not answer at ${m.connection.url}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      clearTimeout(t);
    }
  };

  const why = !mayRun(gates)
    ? (blocking[0]?.why ?? 'A gate is not passing.')
    : !report
    ? 'Nothing is planned yet.'
    : !report.ok
      ? 'The plan is refused; fix it first.'
      : !m
        ? 'Choose a machine.'
        : null;

  const send = async () => {
    if (why || !report || !m) return;
    setBusy(true);
    setNote('');
    try {
      const sha = await sha256Hex(report.gcode);
      /* Facts for THIS program: accepted only when the core read them from the
       * byte-identical G-code (hash match), as cncjob/plan.ts does. */
      let facts: SetupFacts | null = null;
      const ans = await factsFor();
      if (ans.facts && ans.gcode_sha256 === sha) facts = ans.facts;
      else setNote(ans.refused.length ? `Setup facts not read: ${ans.refused.join('; ')}` : 'Setup facts were read from a different program; cnc.run will ask for them.');
      const now = Date.now();
      const book = getState().book;
      const title = drawings.map((x) => x.name).join(' + ') || 'cnc job';
      const r = enqueue(
        book,
        {
          id: newJobId(book, now),
          title,
          design: { id: title, title, thumb: null },
          machineId: m.id,
          plan: { config, sectionZ: sectionZ ?? 0, chosen: drawings.map((x) => x.name) },
          stock,
          program: {
            gcode: report.gcode,
            sha256: sha,
            lines: report.gcode.split('\n').length,
            seconds: report.estimated_seconds,
            tools: report.tools_used,
            toolChanges: report.tool_changes,
            deepestZ: report.deepest_z_mm,
            rapidRate: report.rapid_mm_min ?? 0,
          },
          facts,
          createdAt: now,
        },
        now,
        WHO,
      );
      const problem = applyBook(r);
      if (problem) {
        setNote(problem);
        return;
      }
      markLoaded('run');
      onOpenRun();
    } catch (e) {
      setNote(`Not queued: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cnc-run-card" data-testid="cnc-send-run">
      <label className="note" htmlFor="cnc-run-machine">Run on</label>
      <div className="cnc-run-row">
        <select
          id="cnc-run-machine"
          data-testid="cnc-run-machine"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setCheck({ state: 'idle' });
          }}
        >
          {machines.map((x) => (
            <option key={x.id} value={x.id}>
              {displayName(x)}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void test()} disabled={!m || check.state === 'checking' || !mayTest(gates)} title={mayTest(gates) ? undefined : blocking.find((g) => g.id !== 'machine')?.why} data-testid="cnc-run-test">
          {check.state === 'checking' ? 'Checking…' : 'Test'}
        </button>
        <button type="button" className="primary" onClick={() => void send()} disabled={!!why || busy} title={why ?? 'Queue this program in cnc.run and open it'} data-testid="cnc-run-go">
          {busy ? 'Sending…' : 'Run ▶'}
        </button>
      </div>
      {check.state === 'ok' || check.state === 'bad' ? (
        <span className={check.state === 'ok' ? 'note' : 'bad'} data-testid="cnc-run-check">
          {check.text}
        </span>
      ) : null}
      {!mayRun(gates) ? (
        <span className="cnc-run-blockers" data-testid="cnc-run-blockers">
          {blocking.length} gate{blocking.length === 1 ? '' : 's'} not passing — see Gates.
        </span>
      ) : null}
      {note ? <span className="bad">{note}</span> : null}
    </div>
  );
}

export default SendToRun;
