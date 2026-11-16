// Jobs — the operator's page, AT THE MACHINE (founder 2026-10-14: *"have a
// separate jobs page where the operator can manage the jobs"*, *"cnc is not
// 100% automatic"*).
//
// Per machine: the queue (reorder, remove), what is loaded, and the history.
// Open a job → the guided run, one step per screen, each ticked: load → clamp
// → cutter 1 → home + zero → FORCED AIR CUT → "I am at the machine" → Start.
// While it runs: Feed Hold (the biggest target), Resume, Abort (confirmed), and
// a full-screen takeover at every M0. After: unclamp / check / clean, then
// done or failed with a note.
//
// 🔴 START IS DISABLED, WITH THE REASON ON SCREEN, FOR EVERY MACHINE THAT IS NOT
// THE SIMULATED ONE (`safety.ts::runBlocker`): no physical e-stop exists and
// ops has router operation on HOLD. The simulated machine streams through the
// Run tab's sender (`simController.ts`), whose own refusals (R1–R14) still
// apply and are shown.

import { useEffect, useMemo, useState } from 'react';
import { toolLibrary, type ToolRow } from '../cam';
import { readInventory } from '../inventory';
import { registeredTools, type RegisteredTool } from '../shop-setup/toolRegistry';
import { indexedDbPhotoStore } from '../shop-setup/toolPhotos';
import { gcodeLines } from '../runProgram';
import type { MeshResult } from '../cad/mesh';
import { displayName, isSimulated, loadedCheck, machineById, setInCollet, setMachineTools, type Machine } from './machines';
import { airCutFor, finishJob, historyFor, moveJob, queueFor, removeJob, type Job } from './jobs';
import { beginRun, holdRun, resumeRun } from './runDoor';
import { guidedSteps, pausePrompt, type StepId } from './steps';
import { runBlocker, startBlockers } from './safety';
import { applyBook, getState, sessionFor, setRegistry, useCncJobs, WHO } from './state';
import { flatDesign } from './plan';
import { NOT_SAFETY, stateClass, statusLabel, stateWord } from './MachineCard';
import Workpiece3D from './Workpiece3D';
import { unsendable, type SimSnapshot } from './simController';

const now = () => Date.now();

function useRegistered(): RegisteredTool[] {
  const [tools, setTools] = useState<RegisteredTool[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const inv = await readInventory().catch(() => null);
      const lib: ToolRow[] = await toolLibrary().then((l) => l.tools).catch(() => []);
      if (live && inv) setTools(registeredTools(inv.doc, lib));
    })();
    return () => {
      live = false;
    };
  }, []);
  return tools;
}

function ToolPhoto({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    void indexedDbPhotoStore()
      .get(id)
      .then((b) => {
        if (live && b) setUrl((u = URL.createObjectURL(b)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [id]);
  return url ? <img className="cj-photo" src={url} alt={id} /> : <div className="cj-photo cj-photo-none">No photo (add one under Tools).</div>;
}

export default function JobsPage({ onBack }: { onBack: () => void }) {
  const st = useCncJobs();
  const [mid, setMid] = useState<string>(() => st.reg.machines[0]?.id ?? '');
  const [open, setOpen] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<string, StepId[]>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const tools = useRegistered();
  const machine = machineById(st.reg, mid) ?? st.reg.machines[0] ?? null;
  const snap = machine ? (sessionFor(machine.id)?.snapshot() ?? null) : null;
  const job = open ? (st.book.jobs.find((j) => j.id === open) ?? null) : null;

  if (!machine) return <div className="cj">No machines.</div>;
  const queue = queueFor(st.book, machine.id);
  const done = historyFor(st.book, machine.id);
  const alarm = snap && (snap.state.startsWith('Alarm') || snap.state.startsWith('Door'));

  return (
    <div className="cj cj-jobs" data-testid="cj-jobs">
      <div className="cj-top">
        <h1>Jobs</h1>
        <button type="button" onClick={open ? () => setOpen(null) : onBack} data-testid="cj-back">
          {open ? '← Queue' : '← 2bee.cnc'}
        </button>
      </div>
      <nav className="cj-switch" aria-label="Machines">
        {st.reg.machines.map((m) => {
          const w = stateWord(m, sessionFor(m.id)?.snapshot() ?? null);
          return (
            <button key={m.id} type="button" className={`cj-mchip cj-st-${stateClass(w)}`} aria-pressed={m.id === machine.id}
              onClick={() => { setMid(m.id); setOpen(null); }} data-testid={`cj-switch-${m.id}`}>
              {displayName(m)} <small>{statusLabel(w)}</small>
            </button>
          );
        })}
      </nav>
      {alarm && (
        <div className="cj-alarm" role="alert" data-testid="cj-alarm">
          <h2>{statusLabel(snap!.state)}</h2>
          <p>The controller stopped. Find out why before anything else. Home again before cutting.</p>
          <p className="cj-small">{NOT_SAFETY}</p>
          {isSimulated(machine) && <button type="button" onClick={() => void sessionFor(machine.id)?.home()}>Home ($H)</button>}
        </div>
      )}
      {msg && <p className="cj-warn" data-testid="cj-msg">{msg}</p>}
      {job ? (
        <JobView
          job={job}
          machine={machine}
          snap={snap}
          ticks={new Set(ticks[job.id] ?? [])}
          setTick={(s, on) => setTicks((t) => ({ ...t, [job.id]: on ? [...new Set([...(t[job.id] ?? []), s])] : (t[job.id] ?? []).filter((x) => x !== s) }))}
          say={setMsg}
        />
      ) : (
        <>
          <section className="cj-panel" aria-label="Queue">
            <h2>Queue on {displayName(machine)}</h2>
            {queue.length === 0 && <p className="cj-muted">Empty. Send a job from 2bee.cnc.</p>}
            <ol className="cj-queue" data-testid="cj-queue">
              {queue.map((j, i) => {
                const lc = loadedCheck(machine, j.program.tools);
                return (
                  <li key={j.id} data-testid="cj-queue-row">
                    <button type="button" className="cj-qopen" onClick={() => { setOpen(j.id); setMsg(null); }} data-testid={`cj-open-${j.id}`}>
                      <b>{j.title}</b>
                      <small>
                        {j.state}
                        {j.airCut && airCutFor(j) ? ' · air cut done' : ''} · {Math.max(1, Math.round(j.program.seconds / 60))} min · {j.program.tools.join(', ')}
                      </small>
                      <small className={lc.ok ? 'cj-ok' : 'cj-warn'} data-testid="cj-loaded">{lc.ok ? 'Loaded ✓' : lc.problems.join(' ')}</small>
                    </button>
                    {j.state === 'queued' && (
                      <span className="cj-qctl">
                        <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => setMsg(applyBook(moveJob(getState().book, j.id, -1)))}>↑</button>
                        <button type="button" aria-label="Move down" onClick={() => setMsg(applyBook(moveJob(getState().book, j.id, 1)))}>↓</button>
                        {confirmRemove === j.id ? (
                          <button type="button" className="cj-danger" onClick={() => { setMsg(applyBook(removeJob(getState().book, j.id))); setConfirmRemove(null); }}>Remove?</button>
                        ) : (
                          <button type="button" aria-label="Remove" onClick={() => setConfirmRemove(j.id)}>✕</button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          <Cutters machine={machine} tools={tools} />
          {done.length > 0 && (
            <details className="cj-panel cj-details">
              <summary>History ({done.length})</summary>
              <ul>
                {done.map((j) => (
                  <li key={j.id}>
                    {j.title}: <b>{j.state}</b>
                    {j.history.at(-1)?.note ? ` — ${j.history.at(-1)!.note}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Cutters({ machine, tools }: { machine: Machine; tools: RegisteredTool[] }) {
  const ids = tools.map((t) => t.id);
  const [why, setWhy] = useState<string | null>(null);
  const set = (next: string[]) => {
    const r = setMachineTools(getState().reg, machine.id, next, ids);
    if (!r.ok) return setWhy(r.problem);
    setWhy(null);
    setRegistry(r.reg);
  };
  return (
    <section className="cj-panel" aria-label="Cutters on this machine" data-testid="cj-cutters">
      <h2>Cutters on {machine.hostname}</h2>
      {tools.length === 0 && <p className="cj-muted">No cutters registered (Expert tools → Tools).</p>}
      <ul className="cj-tools">
        {tools.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={machine.toolIds.includes(t.id)} onChange={(e) => set(e.target.checked ? [...machine.toolIds, t.id] : machine.toolIds.filter((x) => x !== t.id))} data-testid={`cj-holds-${t.id}`} />
              {t.name}
            </label>
          </li>
        ))}
      </ul>
      {machine.toolIds.length > 0 && (
        <label className="cj-collet">
          In the collet now{' '}
          <select
            value={machine.inCollet ?? ''}
            onChange={(e) => {
              const r = setInCollet(getState().reg, machine.id, e.target.value || null);
              if (r.ok) setRegistry(r.reg);
              else setWhy(r.problem);
            }}
            data-testid="cj-collet"
          >
            <option value="">not known</option>
            {machine.toolIds.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      )}
      {why && <p className="cj-warn">{why}</p>}
    </section>
  );
}

function JobView({
  job,
  machine,
  snap,
  ticks,
  setTick,
  say,
}: {
  job: Job;
  machine: Machine;
  snap: SimSnapshot | null;
  ticks: Set<StepId>;
  setTick: (s: StepId, on: boolean) => void;
  say: (m: string | null) => void;
}) {
  const steps = useMemo(() => guidedSteps({ facts: job.facts, stock: job.stock, tools: job.program.tools }), [job.facts, job.stock, job.program.tools]);
  const [idx, setIdx] = useState(0);
  const [mesh, setMesh] = useState<MeshResult | null>(null);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [after, setAfter] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const session = sessionFor(machine.id);
  const stream = snap?.stream && snap.stream.jobId === job.id ? snap.stream : null;
  const loaded = loadedCheck(machine, job.program.tools);
  /* The sender's encoding rule over the whole program, shown before anyone presses anything. */
  const unsend = useMemo(() => unsendable(gcodeLines(job.program.gcode)), [job.program.gcode]);

  useEffect(() => {
    let live = true;
    void flatDesign(job.design.id).then((r) => live && 'mesh' in r && setMesh(r.mesh));
    return () => {
      live = false;
    };
  }, [job.design.id]);

  /* Through the ONE door (runDoor.ts): every refusal, the one-job check
   * included, is answered before the controller is touched. */
  const run = (phase: 'aircut' | 'cut') => {
    const b = beginRun({ book: getState().book, machine, job, ticks, phase, now: now(), who: WHO, session });
    if (!b.ok) return say(b.problem);
    say(null);
    applyBook(b);
  };

  const resume = async () => {
    const why = await resumeRun({ session, pause: snap?.pause ?? null, machineId: machine.id, job, now: now(), who: WHO });
    if (why) say(why);
  };

  /* ── RUNNING: the takeover controls ── */
  if ((job.state === 'running' || job.state === 'held') && !job.streamed) {
    const pct = stream && stream.total ? Math.round((100 * stream.acked) / stream.total) : 0;
    const held = !!snap && snap.state.startsWith('Hold');
    const pp = snap?.pause ? pausePrompt(snap.pause) : null;
    return (
      <section className="cj-run" aria-label="Running" data-testid="cj-running">
        <h2>
          {job.title}: {job.phase === 'aircut' ? 'AIR CUT' : 'CUTTING'} {isSimulated(machine) ? '(SIMULATED)' : ''}
        </h2>
        <div className="cj-bar cj-bar-big" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} data-testid="cj-progress">
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="cj-muted">{stream ? `${stream.acked} / ${stream.total} lines accepted by the controller` : 'Waiting for the controller…'} · {statusLabel(snap?.state ?? '?')}</p>
        {pp && (
          <div className="cj-takeover" role="alertdialog" aria-label={pp.title} data-testid="cj-m0">
            <h2>{pp.title}</h2>
            {snap!.pause!.kind === 'tool' && <ToolPhoto id={snap!.pause!.text} />}
            {pp.lines.map((l) => <p key={l}>{l}</p>)}
            <button type="button" className="cj-resume" onClick={() => void resume()} data-testid="cj-resume">Resume</button>
            <button type="button" className="cj-danger" onClick={() => (confirmAbort ? (void session?.abort('Aborted by the operator at a pause.'), setConfirmAbort(false)) : setConfirmAbort(true))} data-testid="cj-m0-abort">
              {confirmAbort ? 'Abort: yes, stop the job' : 'Abort'}
            </button>
          </div>
        )}
        <button type="button" className="cj-hold cj-hold-big" disabled={held} onClick={() => void holdRun({ session, job, now: now(), who: WHO })} data-testid="cj-feedhold">
          Feed Hold
        </button>
        <div className="cj-row">
          {!pp && <button type="button" className="cj-resume" disabled={!held} onClick={() => void resume()} data-testid="cj-resume-plain">Resume</button>}
          {confirmAbort ? (
            <button type="button" className="cj-danger" onClick={() => { void session?.abort('Aborted by the operator.'); setConfirmAbort(false); }} data-testid="cj-abort-confirm">
              Abort: yes, stop the job
            </button>
          ) : (
            <button type="button" className="cj-danger" onClick={() => setConfirmAbort(true)} data-testid="cj-abort">Abort</button>
          )}
        </div>
      </section>
    );
  }

  /* ── AFTER: the cut finished streaming ── */
  if (job.state === 'running' && job.streamed) {
    const AFTER = ['Unclamp and lift the parts out.', 'Check the parts against the design.', 'Clean the machine and the spoilboard.'];
    return (
      <section className="cj-panel" aria-label="After the cut" data-testid="cj-after">
        <h2>{job.title}: finished</h2>
        {AFTER.map((a) => (
          <label key={a} className="cj-tick">
            <input type="checkbox" checked={after.includes(a)} onChange={(e) => setAfter((x) => (e.target.checked ? [...x, a] : x.filter((y) => y !== a)))} />
            {a}
          </label>
        ))}
        <input className="cj-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
        <div className="cj-row">
          <button type="button" className="cj-primary" disabled={after.length < AFTER.length} onClick={() => say(applyBook(finishJob(getState().book, job.id, 'done', now(), WHO, note || undefined)))} data-testid="cj-mark-done">
            Done
          </button>
          <button type="button" className="cj-danger" onClick={() => say(applyBook(finishJob(getState().book, job.id, 'failed', now(), WHO, note || undefined)))} data-testid="cj-mark-failed">
            Failed
          </button>
        </div>
      </section>
    );
  }

  /* ── FINISHED ── */
  if (job.state !== 'queued') {
    return (
      <section className="cj-panel" data-testid="cj-finished">
        <h2>{job.title}: {job.state}</h2>
        <ul>{job.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString()} · {h.who} · {h.what}{h.note ? ` — ${h.note}` : ''}</li>)}</ul>
      </section>
    );
  }

  /* ── QUEUED: the guided steps, one per screen ── */
  const isStart = idx >= steps.length;
  const s = isStart ? null : steps[idx];
  const blockers = [...startBlockers({ machine, job, ticks, loaded, phase: 'cut' }), ...(unsend ? [unsend] : [])];
  const refusals = snap?.refusals.map((r) => `${r.id}: ${r.fact}`) ?? [];
  const block = runBlocker(machine);
  const canTick = (id: StepId): string | null => {
    if (id === 'zero' && isSimulated(machine) && !snap?.homed) return 'Home first.';
    if (id === 'aircut' && !airCutFor(job)) return 'Run the air cut first.';
    return null;
  };

  return (
    <section className="cj-guide" aria-label="Guided run" data-testid="cj-guide">
      <ol className="cj-steps" aria-label="Steps">
        {[...steps.map((x) => x.title), 'Start'].map((t, i) => (
          <li key={t} className={i === idx ? 'on' : i < steps.length && ticks.has(steps[i].id) ? 'done' : ''}>
            <button type="button" onClick={() => setIdx(i)}>{i + 1}</button>
          </li>
        ))}
      </ol>
      {s ? (
        <div className="cj-step" key={s.id} data-testid={`cj-step-${s.id}`}>
          <h2>{s.title}</h2>
          {s.lines.map((l) => <p key={l}>{l}</p>)}
          {s.checks.map((c) => <p key={c} className="cj-warn">{c}</p>)}
          {(s.id === 'load' || s.id === 'clamp') && mesh && <Workpiece3D mesh={mesh} stock={job.stock} clamps={s.id === 'clamp'} label={s.title} />}
          {s.id === 'cutter' && s.tool && <ToolPhoto id={s.tool} />}
          {s.id === 'cutter' && !loaded.ok && <p className="cj-warn">{loaded.problems.join(' ')}</p>}
          {s.id === 'zero' && isSimulated(machine) && (
            <p>
              <button type="button" onClick={() => void session?.home()} disabled={snap?.homing} data-testid="cj-home">
                {snap?.homing ? 'Homing…' : snap?.homed ? 'Homed ✓ (again)' : 'Home ($H)'}
              </button>
            </p>
          )}
          {s.id === 'aircut' && (
            <div>
              {airCutFor(job) ? (
                <p className="cj-ok">Air cut done for this program.</p>
              ) : (
                <>
                  <button type="button" className="cj-primary cj-big" disabled={!!block || !!unsend} onClick={() => run('aircut')} data-testid="cj-run-aircut">
                    Run the air cut
                  </button>
                  {block && <p className="cj-warn" data-testid="cj-blocked">{block}</p>}
                  {unsend && <p className="cj-warn" data-testid="cj-unsendable">{unsend}</p>}
                </>
              )}
            </div>
          )}
          <label className="cj-tick cj-tick-big">
            <input
              type="checkbox"
              checked={ticks.has(s.id)}
              disabled={!!canTick(s.id) && !ticks.has(s.id)}
              onChange={(e) => {
                setTick(s.id, e.target.checked);
                if (e.target.checked) setIdx(idx + 1);
              }}
              data-testid={`cj-tick-${s.id}`}
            />
            {s.id === 'present' ? 'I am at the machine' : s.id === 'aircut' ? 'I watched it: the path is right and it stayed clear' : 'Done'}
          </label>
          {canTick(s.id) && !ticks.has(s.id) && <p className="cj-muted">{canTick(s.id)}</p>}
        </div>
      ) : (
        <div className="cj-step" data-testid="cj-step-start">
          <h2>Start {isSimulated(machine) ? '(SIMULATED)' : ''}</h2>
          <p className="cj-muted">{job.title} · {job.program.lines} lines · sha256 {job.program.sha256.slice(0, 12)}…</p>
          <button type="button" className="cj-primary cj-big" disabled={blockers.length > 0 || refusals.length > 0} onClick={() => run('cut')} data-testid="cj-start">
            Start
          </button>
          {(blockers.length > 0 || refusals.length > 0) && (
            <ul className="cj-warn" data-testid="cj-start-blocked">
              {[...blockers, ...refusals].map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// An abort (the operator's or the controller's) is recorded by the session's
// end callback in state.ts, so both take the same path into the job book.
