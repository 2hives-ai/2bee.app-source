// THE ONE DOOR a run goes through — the Jobs page and cnc.run both call this.
//
// Order, and why it is this order:
//   1. this app's own conditions (`safety.ts::startBlockers`: runBlocker first —
//      no machine but the SIMULATED one runs, ops H5 — then the ticks, the air
//      cut of THIS program, the loaded cutters), plus any the caller adds;
//   2. the sender's encoding rule over the whole program (`unsendable`);
//   3. 🔴 THE JOB BOOK — one running job per machine (`jobs.ts::startJob`),
//      checked on a COPY of the book BEFORE the controller is touched;
//   4. only then the controller session (`SimSession.start`, whose own R1–R14
//      refusals apply), and the book change is returned for the caller to apply.
//
// 🔴 THE DEFECT STEP 3's POSITION FIXES (journey test 2026-10-15, _WORKING.md
// item 2): the Jobs page called `session.start` first and `startJob` second, so
// a second job on a busy machine had 45 lines on the wire before the one-job
// check refused it — and the abort it then sent stopped the FIRST job too.
// A refusal here sends nothing.
//
// The air cut streams `airCut.ts::airCutProgram` — the program lifted clear of
// the workpiece with the spindle starts removed — not the job's program.

import { gcodeLines } from '../runProgram';
import type { RunProgram } from '../RunTab';
import { airCutProgram } from './airCut';
import { holdJob, resumeJob, startJob, type BookOutcome, type Job, type JobBook, type RunPhase } from './jobs';
import { colletAfterChange, loadedCheck, type Machine } from './machines';
import { applyBook, getState, setRegistry } from './state';
import { startBlockers } from './safety';
import type { StartResult } from './simController';
import { unsendable } from './simController';
import type { Pause, StepId } from './steps';

/** What the door needs from a controller session. `SimSession` is one. */
export interface RunSession {
  start(jobId: string, phase: RunPhase, program: RunProgram): StartResult;
}

/** The lines that will be streamed for this phase, or why there are none. */
export function linesFor(job: Pick<Job, 'program' | 'facts'>, phase: RunPhase): { ok: true; lines: string[] } | { ok: false; why: string } {
  const lines = gcodeLines(job.program.gcode);
  if (phase === 'cut') return { ok: true, lines };
  const a = airCutProgram(lines, job.facts);
  return a.ok ? { ok: true, lines: a.lines } : { ok: false, why: `No air cut: ${a.why}` };
}

export function programFor(job: Job, phase: RunPhase): { ok: true; program: RunProgram } | { ok: false; why: string } {
  const l = linesFor(job, phase);
  if (!l.ok) return l;
  return {
    ok: true,
    program: {
      name: phase === 'aircut' ? `${job.title} (air cut)` : job.title,
      lines: l.lines,
      path: [],
      hash: job.program.sha256,
      rapidRate: job.program.rapidRate,
    },
  };
}

/** Everything that stands between the operator and this phase, without touching anything. */
export function runRefusals(a: {
  book: JobBook;
  machine: Machine;
  job: Job;
  ticks: ReadonlySet<StepId>;
  phase: RunPhase;
  extra?: readonly string[];
  now: number;
  who: string;
}): string[] {
  const out = [...startBlockers({ machine: a.machine, job: a.job, ticks: a.ticks, loaded: loadedCheck(a.machine, a.job.program.tools), phase: a.phase })];
  out.push(...(a.extra ?? []));
  const p = programFor(a.job, a.phase);
  if (!p.ok) out.push(p.why);
  else {
    const bad = unsendable(p.program.lines);
    if (bad) out.push(bad);
  }
  const b = startJob(a.book, a.job.id, a.phase, a.now, a.who);
  if (!b.ok && !out.includes(b.problem)) out.push(b.problem);
  return [...new Set(out)];
}

/**
 * Start the air cut or the cut. Refused: nothing was sent and the book is
 * unchanged. Accepted: the controller is streaming, and the returned book
 * (job marked running) is the caller's to apply.
 */
export function beginRun(a: Parameters<typeof runRefusals>[0] & { session: RunSession | null }): BookOutcome {
  const refused = runRefusals(a);
  if (refused.length) return { ok: false, problem: refused.join(' ') };
  if (!a.session) return { ok: false, problem: 'This machine has no controller session.' };
  const b = startJob(a.book, a.job.id, a.phase, a.now, a.who);
  if (!b.ok) return b;
  const p = programFor(a.job, a.phase);
  if (!p.ok) return { ok: false, problem: p.why };
  const r = a.session.start(a.job.id, a.phase, p.program);
  if (!r.ok) return { ok: false, problem: `The sender refused: ${r.refusals.join(' ')}` };
  return b;
}

/**
 * Resume after a feed hold or an M0, through the sender's own refusal (R10).
 * After a TOOL CHANGE the collet record moves to the new cutter, so the next
 * loaded-check reads what the operator just fitted. Shared by both pages.
 */
export async function resumeRun(a: {
  session: { resume(): Promise<string[]> } | null;
  pause: Pause | null;
  machineId: string;
  job: Pick<Job, 'id' | 'state'>;
  now: number;
  who: string;
}): Promise<string | null> {
  const refused = (await a.session?.resume()) ?? ['No controller session.'];
  if (refused.length) return refused.join(' ');
  if (a.pause?.kind === 'tool') {
    const r = colletAfterChange(getState().reg, a.machineId, a.pause.text);
    if (r.ok) setRegistry(r.reg);
  }
  if (a.job.state === 'held') return applyBook(resumeJob(getState().book, a.job.id, a.now, a.who));
  return null;
}

/** Feed hold: the realtime `!` first, then the book. Allowed whatever else is true. */
export async function holdRun(a: { session: { feedHold(): Promise<void> } | null; job: Pick<Job, 'id' | 'state'>; now: number; who: string }): Promise<string | null> {
  await a.session?.feedHold();
  if (a.job.state === 'running') return applyBook(holdJob(getState().book, a.job.id, a.now, a.who, 'feed hold'));
  return null;
}
