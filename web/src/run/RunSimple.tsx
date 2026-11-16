/**
 * cnc.run, simple view (founder 2026-10-15, verbatim: *"cnc.run: similar
 * concept: ai is on the left side, have a 3d and below the 3d have all the
 * steps the user needs to do step by step when the cnc is running or prepare
 * the cnc (put the panel, clamp ... so a full job sequence), have a play
 * button, this will run the cnc machine"*).
 *
 * Left: the run assistant (explains, cannot act — RunChat.tsx). Right: the job
 * in 3D, the Play bar, and the numbered job sequence (runSequence.ts).
 *
 * 🔴 PLAY GOES THROUGH THE ONE DOOR (`cncjob/runDoor.ts::beginRun`) — the same
 * one the Jobs page uses: every prepare step ticked by the person, the forced
 * air cut (lifted, spindle starts removed) of THIS program before the cut,
 * "I am at the machine", one job per machine checked BEFORE a byte is sent,
 * and `safety.ts::runBlocker` first — which refuses EVERY machine but the
 * SIMULATED one, with the e-stop (ops H5) reason on screen. Nothing on this
 * page can make that refusal go away.
 *
 * 🔴 STOPPING IS ALWAYS REACHABLE WHILE IT RUNS: Feed Hold, Resume, Stop.
 *
 * Jobs come from the 2bee.cnc queue (`cncjob/state.ts`): "Send to <machine>"
 * there, Play here. Nothing from this app has cut anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { airCutFor, finishJob, type Job } from '../cncjob/jobs';
import { displayName, isSimulated, machineById, setInCollet, type Machine } from '../cncjob/machines';
import { NOT_SAFETY, statusLabel, stateWord } from '../cncjob/MachineCard';
import { beginRun, holdRun, linesFor, resumeRun, runRefusals } from '../cncjob/runDoor';
import { applyBook, getState, sessionFor, setRegistry, useCncJobs, WHO } from '../cncjob/state';
import { pausePrompt } from '../cncjob/steps';
import type { SimSnapshot } from '../cncjob/simController';
import { gcodeLines } from '../runProgram';
import RunChat, { type RunChatContext } from './RunChat';
import RunView3D from './RunView3D';
import { extraOpen, FINISH_IDS, guidedTicks, runSequence, type SeqStep } from './runSequence';
import './runSimple.css';

const now = () => Date.now();

export interface RunSimpleProps {
  /** False while the tab is hidden: the 3D stops drawing. */
  active?: boolean;
  /** Where "Send a job" goes (the 2bee.cnc page). Optional. */
  onOpenCnc?: () => void;
}

type StepState = 'done' | 'now' | 'running' | 'todo';

/** Which job to show when none is picked: a running one, else the first queued. */
function defaultJob(jobs: readonly Job[]): Job | null {
  return jobs.find((j) => j.state === 'running' || j.state === 'held') ?? jobs.find((j) => j.state === 'queued') ?? null;
}

function runnable(jobs: readonly Job[]): Job[] {
  return jobs.filter((j) => j.state === 'queued' || j.state === 'running' || j.state === 'held');
}

export function RunSimple({ active = true, onOpenCnc }: RunSimpleProps) {
  const st = useCncJobs();
  const jobs = runnable(st.book.jobs);
  const [pick, setPick] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const job = (pick ? jobs.find((j) => j.id === pick) : null) ?? defaultJob(jobs);
  const machine = job ? machineById(st.reg, job.machineId) : null;
  const session = machine ? sessionFor(machine.id) : null;
  const snap: SimSnapshot | null = session?.snapshot() ?? null;

  useEffect(() => setConfirmStop(false), [job?.id, job?.state]);

  if (!job || !machine) {
    return (
      <div className="cad-simple rs" data-testid="rs">
        <RunChat context={{ summary: ['No job is queued.'], steps: [], now: 'Send a job to a machine from 2bee.cnc.', playRefusals: ['No job is queued.'] }} />
        <div className="cad-simple-view rs-main">
          <div className="rs-empty" data-testid="rs-empty">
            {finished ? <p className="cj-ok" data-testid="rs-finished">{finished}</p> : null}
            <p>Nothing to run. Send a job to a machine from 2bee.cnc, then come back here.</p>
            {onOpenCnc ? (
              <button type="button" onClick={onOpenCnc} data-testid="rs-open-cnc">
                Open 2bee.cnc
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <RunJob
      key={job.id}
      job={job}
      jobs={jobs}
      machine={machine}
      snap={snap}
      session={session}
      ticks={new Set(ticks[job.id] ?? [])}
      setTick={(id, on) => setTicks((t) => ({ ...t, [job.id]: on ? [...new Set([...(t[job.id] ?? []), id])] : (t[job.id] ?? []).filter((x) => x !== id) }))}
      onPick={(id) => {
        setPick(id);
        setMsg(null);
      }}
      msg={msg}
      say={setMsg}
      confirmStop={confirmStop}
      setConfirmStop={setConfirmStop}
      onFinished={(text) => {
        setFinished(text);
        setPick(null);
      }}
      active={active}
    />
  );
}

function RunJob({
  job,
  jobs,
  machine,
  snap,
  session,
  ticks,
  setTick,
  onPick,
  msg,
  say,
  confirmStop,
  setConfirmStop,
  onFinished,
  active,
}: {
  job: Job;
  jobs: Job[];
  machine: Machine;
  snap: SimSnapshot | null;
  session: ReturnType<typeof sessionFor>;
  ticks: Set<string>;
  setTick: (id: string, on: boolean) => void;
  onPick: (id: string) => void;
  msg: string | null;
  say: (m: string | null) => void;
  confirmStop: boolean;
  setConfirmStop: (v: boolean) => void;
  onFinished: (text: string) => void;
  active: boolean;
}) {
  const seq = useMemo(() => runSequence(job), [job]);
  const stream = snap?.stream && snap.stream.jobId === job.id ? snap.stream : null;
  const running = (job.state === 'running' || job.state === 'held') && !job.streamed;
  const phase = running ? job.phase : null;
  const held = !!snap && snap.state.startsWith('Hold');
  const airDone = airCutFor(job);
  const sim = isSimulated(machine);

  /* What is drawn: the lifted lines during (or before) the air cut, the program otherwise. */
  const showAir = phase === 'aircut' || (!running && !airDone && !job.streamed);
  const drawn = useMemo(() => {
    if (showAir) {
      const l = linesFor(job, 'aircut');
      if (l.ok) return l.lines;
    }
    return gcodeLines(job.program.gcode);
  }, [job, showAir]);
  const acked = job.streamed ? drawn.length : (stream?.acked ?? 0);

  const nextPhase = airDone ? 'cut' : 'aircut';
  const hasRefit = seq.some((s) => s.key === 'refit');
  const extra = extraOpen(ticks, nextPhase === 'cut' && hasRefit);
  const refusals = running || job.streamed
    ? []
    : [
        ...runRefusals({ book: getState().book, machine, job, ticks: guidedTicks(ticks), phase: nextPhase, extra, now: now(), who: WHO }),
        ...(snap?.refusals.map((r) => `${r.id}: ${r.fact}`) ?? []),
      ];

  const play = () => {
    const b = beginRun({ book: getState().book, machine, job, ticks: guidedTicks(ticks), phase: nextPhase, extra, now: now(), who: WHO, session });
    if (!b.ok) return say(b.problem);
    say(null);
    say(applyBook(b));
  };
  const resume = async () => say(await resumeRun({ session, pause: snap?.pause ?? null, machineId: machine.id, job, now: now(), who: WHO }));
  const hold = async () => say(await holdRun({ session, job, now: now(), who: WHO }));
  const stop = () => {
    void session?.abort('Stopped by the operator.');
    setConfirmStop(false);
  };

  /* Step states. */
  const tickedAll = (ids: readonly string[]) => ids.every((i) => ticks.has(i));
  const passedPause = (s: SeqStep): boolean => {
    if (!s.pause) return false;
    if (job.streamed) return true;
    if (phase !== 'cut' || !stream) return false;
    return stream.acked > s.pause.line + 1 || (stream.acked === s.pause.line + 1 && !held);
  };
  const isDone = (s: SeqStep): boolean => {
    if (s.kind === 'aircut') return airDone && ticks.has('aircut');
    if (s.kind === 'cut') return job.streamed;
    if (s.kind === 'pause') return passedPause(s);
    return ticks.has(s.tick!);
  };
  /* Kind + text + cutter alone named the FIRST of two identical stops (every probe against a plate
   * on the work ends in the same TOUCH PLATE stop), so the list sat on a stop already passed. The
   * line decides: the same line in the cut, one later in the air cut (its extra first line). */
  const pauseHere = (s: SeqStep) =>
    !!snap?.pause &&
    !!s.pause &&
    snap.pause.kind === s.pause.kind &&
    snap.pause.text === s.pause.text &&
    snap.pause.cutter === s.pause.cutter &&
    snap.pause.line - s.pause.line === (phase === 'aircut' ? 1 : 0);
  let current: string | null = null;
  if (running) {
    const at = seq.find((s) => s.kind === 'pause' && pauseHere(s));
    current = at ? at.key : phase === 'aircut' ? 'aircut' : 'cut';
  } else current = seq.find((s) => !isDone(s))?.key ?? null;
  /* Keep the step the person is on in view as the sequence moves. */
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!current) return;
    list.current?.querySelector(`[data-testid="rs-step-${current}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);
  const stateOf = (s: SeqStep): StepState => (s.key === current ? (running ? 'running' : 'now') : isDone(s) ? 'done' : 'todo');

  const canTick = (s: SeqStep): string | null => {
    if (running) return 'Not while the machine runs.';
    const id = s.tick!;
    if ((FINISH_IDS as readonly string[]).includes(id)) return job.streamed ? null : 'After the cut.';
    if (job.streamed) return 'The cut is finished.';
    if (id === 'zero' && sim && !snap?.homed) return 'Home first.';
    if (id === 'aircut' && !airDone) return 'Run the air cut first (Play).';
    if ((id === 'present' || id === 'refit') && !airDone) return 'After the air cut.';
    return null;
  };

  const toolIdx = seq.filter((s) => s.pause?.kind === 'tool' && (passedPause(s) || pauseHere(s))).length;
  const tools = job.facts ? [...job.facts.tools].sort((a, b) => a.index - b.index) : [];
  const diameter = tools[Math.min(toolIdx, Math.max(0, tools.length - 1))]?.diameter_mm ?? 6;
  const word = stateWord(machine, snap);
  const pct = acked && drawn.length ? Math.round((100 * acked) / drawn.length) : 0;
  const label = `${job.title} · ${phase === 'aircut' ? 'AIR CUT (lifted, spindle off)' : phase === 'cut' ? 'CUTTING' : job.streamed ? 'finished' : showAir ? 'air-cut path' : 'program'}${sim ? ' · SIMULATED' : ''}`;
  const pp = running && snap?.pause && stream ? pausePrompt(snap.pause) : null;
  const finishDone = tickedAll(FINISH_IDS);

  const chat: RunChatContext = {
    summary: [
      `Job: ${job.title} (${job.program.lines} lines, about ${Math.max(1, Math.round(job.program.seconds / 60))} min, cutters: ${job.program.tools.join(', ') || 'none named'})`,
      `Machine: ${displayName(machine)}; ${statusLabel(word)}`,
      `Job state: ${job.state}${phase ? `, ${phase === 'aircut' ? 'air cut' : 'cut'} running` : ''}${airDone ? ', air cut done' : ''}`,
    ],
    steps: seq.map((s) => `${s.n}. ${s.title} — ${stateOf(s)}`),
    now: (() => {
      const s = seq.find((x) => x.key === current);
      if (!s) return 'Everything is done.';
      return `step ${s.n}, ${s.title}. ${s.lines.join(' ')}`;
    })(),
    playRefusals: refusals,
  };

  return (
    <div className="cad-simple rs" data-testid="rs">
      <RunChat context={chat} />
      <div className="cad-simple-view rs-main">
        <div className="rs-top">
          <label className="rs-pick">
            Job{' '}
            <select value={job.id} onChange={(e) => onPick(e.target.value)} data-testid="rs-job" disabled={running}>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title} · {j.machineId} · {j.state}
                </option>
              ))}
            </select>
          </label>
          <span className={sim ? 'rs-machine' : 'rs-machine rs-real'} data-testid="rs-machine">
            {displayName(machine)} · {statusLabel(word)}
          </span>
        </div>

        <div className="rs-canvas-wrap">
          <RunView3D
            lines={drawn}
            acked={acked}
            stock={job.stock}
            toolDiameter={diameter}
            clamps={!running}
            label={label}
            active={active}
            toolPos={running ? (snap?.work ?? null) : null}
          />
        </div>

        <div className="rs-bar" data-testid="rs-bar">
          {running ? (
            <>
              <button type="button" className="rs-hold" disabled={held} onClick={() => void hold()} data-testid="rs-feedhold">
                Feed Hold
              </button>
              <button type="button" className="primary" disabled={!held || !!pp} onClick={() => void resume()} data-testid="rs-resume">
                Resume
              </button>
              {confirmStop ? (
                <button type="button" className="rs-danger" onClick={stop} data-testid="rs-stop-confirm">
                  Stop: yes, end the job
                </button>
              ) : (
                <button type="button" className="rs-danger" onClick={() => setConfirmStop(true)} data-testid="rs-stop">
                  Stop
                </button>
              )}
              <div className="rs-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} data-testid="rs-progress">
                <i style={{ width: `${pct}%` }} />
              </div>
              <span className="note">{stream ? `${stream.acked} / ${stream.total} lines accepted by the controller` : 'Waiting for the controller…'}</span>
            </>
          ) : job.streamed ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={!finishDone}
                data-testid="rs-done"
                onClick={() => {
                  const why = applyBook(finishJob(getState().book, job.id, 'done', now(), WHO));
                  if (why) say(why);
                  else onFinished(`${job.title}: done.`);
                }}
              >
                Done
              </button>
              <button
                type="button"
                className="rs-danger"
                data-testid="rs-failed"
                onClick={() => {
                  const why = applyBook(finishJob(getState().book, job.id, 'failed', now(), WHO));
                  if (why) say(why);
                  else onFinished(`${job.title}: marked failed.`);
                }}
              >
                Failed
              </button>
              <span className="note">{finishDone ? 'Mark the job.' : 'Finish the last steps, then mark the job.'}</span>
            </>
          ) : (
            <>
              <button type="button" className="primary rs-play" disabled={refusals.length > 0} onClick={play} data-testid="rs-play" aria-describedby="rs-play-why">
                ▶ Play: {nextPhase === 'aircut' ? 'air cut' : 'cut'}
              </button>
              <span className="note" id="rs-play-why">
                {refusals.length ? 'Play is off until:' : nextPhase === 'aircut' ? 'Runs the program lifted clear, spindle off. Watch it.' : 'Runs the cut. Stay at the machine.'}
              </span>
            </>
          )}
        </div>
        {!running && !job.streamed && refusals.length ? (
          <ul className="rs-blocked warn" data-testid="rs-play-blocked">
            {refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        {msg ? (
          <p className="warn rs-msg" data-testid="rs-msg">
            {msg}
          </p>
        ) : null}
        {pp ? (
          <div className="rs-m0" role="alertdialog" aria-label={pp.title} data-testid="rs-m0">
            <strong>{pp.title}</strong>
            {pp.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
            <button type="button" className="primary" onClick={() => void resume()} data-testid="rs-m0-resume">
              Resume
            </button>
          </div>
        ) : null}
        {snap && (snap.state.startsWith('Alarm') || snap.state.startsWith('Door')) ? (
          <p className="bad rs-msg" role="alert" data-testid="rs-alarm">
            {statusLabel(snap.state)}. The controller stopped: find out why, then home again. {NOT_SAFETY}
          </p>
        ) : null}

        <ol className="rs-steps" aria-label="Job sequence" data-testid="rs-steps" ref={list}>
          {seq.map((s, i) => {
            const state = stateOf(s);
            const head = i === 0 || seq[i - 1].group !== s.group;
            const why = s.tick ? canTick(s) : null;
            return (
              <li key={s.key} className={`rs-step rs-${state}`} data-testid={`rs-step-${s.key}`} data-state={state} aria-current={state === 'now' || state === 'running' ? 'step' : undefined}>
                {head ? <span className="rs-group">{s.group}</span> : null}
                <div className="rs-step-row">
                  <span className="rs-n" aria-hidden="true">
                    {state === 'done' ? '✓' : s.n}
                  </span>
                  <div className="rs-body">
                    <strong>{s.title}</strong>
                    {state === 'now' || state === 'running' ? (
                      <>
                        {s.lines.map((l) => (
                          <p key={l}>{l}</p>
                        ))}
                        {s.checks.map((c) => (
                          <p key={c} className="warn">
                            {c}
                          </p>
                        ))}
                      </>
                    ) : null}
                    {s.key === 'zero' && sim && !running && !job.streamed ? (
                      <button type="button" onClick={() => void session?.home()} disabled={!!snap?.homing} data-testid="rs-home">
                        {snap?.homing ? 'Homing…' : snap?.homed ? 'Homed ✓' : 'Home ($H)'}
                      </button>
                    ) : null}
                  </div>
                  {s.tick ? (
                    <label className="rs-tick" title={why ?? undefined}>
                      <input
                        type="checkbox"
                        checked={ticks.has(s.tick)}
                        disabled={!!why}
                        onChange={(e) => {
                          setTick(s.tick!, e.target.checked);
                          /* Fitting cutter 1 IS the collet record the loaded-check reads
                           * (the Jobs page sets it from a list; here the tick says it). */
                          if (e.target.checked && (s.key === 'cutter' || s.key === 'refit') && s.tool) {
                            const r = setInCollet(getState().reg, machine.id, s.tool);
                            if (r.ok) setRegistry(r.reg);
                            else say(r.problem);
                          }
                        }}
                        data-testid={`rs-tick-${s.key}`}
                      />
                      {s.key === 'present' ? 'I am at the machine' : s.kind === 'aircut' ? 'Watched it' : 'Done'}
                    </label>
                  ) : null}
                </div>
                {why && !ticks.has(s.tick!) && (state === 'now') ? <p className="rs-why note">{why}</p> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export default RunSimple;
