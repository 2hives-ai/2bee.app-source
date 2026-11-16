// Jobs and per-machine queues for 2bee.cnc.
//
// Founder 2026-10-14: *"on the main page just monitor the cnc and send the job
// to the cnc"* and *"have a separate jobs page where the operator can manage the
// jobs"*. So "Send" APPENDS A JOB TO A QUEUE and nothing else: it never starts
// motion. Starting is the Jobs page's, after the guided steps.
//
// A job carries everything the run needs and nothing it would have to re-derive:
// the design, the plan inputs, the PROGRAM (bytes + SHA-256), the setup facts
// read off that same program, and the machine it is for. The program is never
// re-planned between Send and Start — a re-plan is a different program, and
// the air cut, the steps and the hash the operator saw belong to this one.
//
// Rules this file holds (each has a test, with a red run):
//   · one RUNNING (or held) job per machine;
//   · a job may only move along the transitions in `NEXT`;
//   · only a queued job is reordered or removed;
//   · "done"/"failed" only after the program finished streaming — the operator
//     marks it after unclamp/check/clean, the stream finishing is not "done".
//
// Persisted to localStorage like `machines.ts`, validated on read, bad entries
// dropped by name.

import type { JobConfig, SetupFacts } from '../cam';

export type JobState = 'queued' | 'running' | 'held' | 'done' | 'failed' | 'aborted';
/** What a running job is doing: the forced air cut, or the cut. */
export type RunPhase = 'aircut' | 'cut';

export interface JobProgram {
  gcode: string;
  /** SHA-256 of `gcode`, the same hash the setup facts were checked against. */
  sha256: string;
  lines: number;
  seconds: number;
  tools: string[];
  toolChanges: number;
  deepestZ: number;
  rapidRate: number;
}

export interface HistoryEntry {
  at: number;
  who: string;
  what: string;
  note?: string;
}

export interface Job {
  id: string;
  /** e.g. "Hive cleat (1 of 2)". */
  title: string;
  design: { id: string; title: string; thumb: string | null };
  machineId: string;
  plan: { config: JobConfig; sectionZ: number; chosen: string[] };
  stock: { x: number; y: number; t: number };
  program: JobProgram;
  facts: SetupFacts | null;
  state: JobState;
  phase: RunPhase | null;
  /** True once the cut (not the air cut) streamed to the end. */
  streamed: boolean;
  /** The air cut that ran THIS program on THIS machine, or `null`. */
  airCut: { sha256: string; machineId: string; at: number } | null;
  history: HistoryEntry[];
  createdAt: number;
}

export interface JobBook {
  version: 1;
  jobs: Job[];
}

export const EMPTY_BOOK: JobBook = { version: 1, jobs: [] };
export const JOBS_KEY = '2bee.app.cncjob.jobs';

/**
 * Allowed transitions. Anything else is refused by name. `running|held →
 * queued` is reached only from an AIR CUT (finished or aborted): the job goes
 * back to the queue to be cut.
 */
export const NEXT: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running'],
  running: ['held', 'queued', 'done', 'failed', 'aborted'],
  held: ['running', 'queued', 'aborted'],
  done: [],
  failed: [],
  aborted: [],
};

const ACTIVE: readonly JobState[] = ['running', 'held'];

export type BookOutcome = { ok: true; book: JobBook } | { ok: false; problem: string };

export function jobById(book: JobBook, id: string): Job | null {
  return book.jobs.find((j) => j.id === id) ?? null;
}

/** Queued and active jobs for one machine, active first, then queue order. */
export function queueFor(book: JobBook, machineId: string): Job[] {
  const mine = book.jobs.filter((j) => j.machineId === machineId);
  return [...mine.filter((j) => ACTIVE.includes(j.state)), ...mine.filter((j) => j.state === 'queued')];
}

/** Finished jobs for one machine, newest first. */
export function historyFor(book: JobBook, machineId: string): Job[] {
  return book.jobs
    .filter((j) => j.machineId === machineId && (j.state === 'done' || j.state === 'failed' || j.state === 'aborted'))
    .sort((a, b) => (b.history.at(-1)?.at ?? 0) - (a.history.at(-1)?.at ?? 0));
}

export function activeOn(book: JobBook, machineId: string): Job | null {
  return book.jobs.find((j) => j.machineId === machineId && ACTIVE.includes(j.state)) ?? null;
}

export function newJobId(book: JobBook, now: number): string {
  let n = 0;
  let id = `job-${now.toString(36)}`;
  while (book.jobs.some((j) => j.id === id)) id = `job-${now.toString(36)}-${++n}`;
  return id;
}

/** Append a job to its machine's queue. It never starts anything. */
export function enqueue(
  book: JobBook,
  job: Omit<Job, 'state' | 'phase' | 'streamed' | 'airCut' | 'history'>,
  now: number,
  who: string,
): BookOutcome {
  if (book.jobs.some((j) => j.id === job.id)) return { ok: false, problem: `A job ${job.id} already exists.` };
  if (!job.program.gcode.trim()) return { ok: false, problem: 'The job has no program.' };
  const full: Job = { ...job, state: 'queued', phase: null, streamed: false, airCut: null, history: [{ at: now, who, what: `queued on ${job.machineId}` }] };
  return { ok: true, book: { ...book, jobs: [...book.jobs, full] } };
}

function put(book: JobBook, j: Job): JobBook {
  return { ...book, jobs: book.jobs.map((x) => (x.id === j.id ? j : x)) };
}

function step(book: JobBook, id: string, to: JobState, now: number, who: string, what: string, note?: string, edit: (j: Job) => Partial<Job> = () => ({})): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  if (!NEXT[j.state].includes(to)) return { ok: false, problem: `A ${j.state} job cannot become ${to}.` };
  const h: HistoryEntry = { at: now, who, what, ...(note ? { note } : {}) };
  return { ok: true, book: put(book, { ...j, ...edit(j), state: to, history: [...j.history, h] }) };
}

/**
 * Start the air cut or the cut. Refused while another job on the same machine
 * is running or held — one program on one controller at a time.
 */
export function startJob(book: JobBook, id: string, phase: RunPhase, now: number, who: string): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  const other = activeOn(book, j.machineId);
  if (other && other.id !== id) return { ok: false, problem: `${other.title} is already running on ${j.machineId}.` };
  if (phase === 'cut' && !airCutFor(j)) return { ok: false, problem: 'The air cut has not been run for this program on this machine.' };
  return step(book, id, 'running', now, who, phase === 'aircut' ? 'air cut started' : 'cut started', undefined, () => ({ phase }));
}

export function holdJob(book: JobBook, id: string, now: number, who: string, why: string): BookOutcome {
  return step(book, id, 'held', now, who, why);
}

export function resumeJob(book: JobBook, id: string, now: number, who: string): BookOutcome {
  return step(book, id, 'running', now, who, 'resumed');
}

/** The program streamed to the end. An air cut returns the job to the queue with the air cut recorded. */
export function streamFinished(book: JobBook, id: string, now: number, who: string): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  if (j.state !== 'running') return { ok: false, problem: `A ${j.state} job did not just finish streaming.` };
  if (j.phase === 'aircut') {
    return step(book, id, 'queued', now, who, 'air cut complete', undefined, (x) => ({
      phase: null,
      airCut: { sha256: x.program.sha256, machineId: x.machineId, at: now },
    }));
  }
  return { ok: true, book: put(book, { ...j, streamed: true, history: [...j.history, { at: now, who, what: 'program finished' }] }) };
}

/** Abort. An aborted AIR CUT returns the job to the queue; an aborted cut is final. */
export function abortJob(book: JobBook, id: string, now: number, who: string, note?: string): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  if (j.phase === 'aircut' && (j.state === 'running' || j.state === 'held')) {
    return step(book, id, 'queued', now, who, 'air cut aborted', note, () => ({ phase: null }));
  }
  return step(book, id, 'aborted', now, who, 'aborted', note);
}

/** Mark the finished job done or failed, after unclamp/check/clean. */
export function finishJob(book: JobBook, id: string, outcome: 'done' | 'failed', now: number, who: string, note?: string): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  if (!j.streamed) return { ok: false, problem: 'The program has not finished, so the job cannot be marked yet.' };
  return step(book, id, outcome, now, who, outcome === 'done' ? 'marked done' : 'marked failed', note);
}

/** Move a queued job up (-1) or down (+1) among its machine's queued jobs. */
export function moveJob(book: JobBook, id: string, dir: -1 | 1): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  if (j.state !== 'queued') return { ok: false, problem: 'Only a queued job can be moved.' };
  const peers = book.jobs.map((x, i) => ({ x, i })).filter(({ x }) => x.machineId === j.machineId && x.state === 'queued');
  const k = peers.findIndex(({ x }) => x.id === id);
  const t = k + dir;
  if (t < 0 || t >= peers.length) return { ok: true, book };
  const jobs = [...book.jobs];
  const a = peers[k].i;
  const b = peers[t].i;
  [jobs[a], jobs[b]] = [jobs[b], jobs[a]];
  return { ok: true, book: { ...book, jobs } };
}

/** Remove a queued job. A running, held or finished job is not removed here. */
export function removeJob(book: JobBook, id: string): BookOutcome {
  const j = jobById(book, id);
  if (!j) return { ok: false, problem: `No job ${id}.` };
  if (j.state !== 'queued') return { ok: false, problem: `A ${j.state} job cannot be removed.` };
  return { ok: true, book: { ...book, jobs: book.jobs.filter((x) => x.id !== id) } };
}

/** The air cut that counts for this job: same program bytes, same machine. */
export function airCutFor(j: Pick<Job, 'airCut' | 'program' | 'machineId'>): boolean {
  return !!j.airCut && j.airCut.sha256 === j.program.sha256 && j.airCut.machineId === j.machineId;
}

/**
 * After a reload, a job the book says is running on a machine whose
 * controller session is gone cannot be running: the simulated controller lives
 * in the page. It is marked aborted (an air cut goes back to the queue), with
 * the reason, rather than shown as running.
 */
export function reconcileAfterReload(book: JobBook, liveMachines: readonly string[], now: number): JobBook {
  let out = book;
  for (const j of book.jobs) {
    if (!ACTIVE.includes(j.state) || liveMachines.includes(j.machineId)) continue;
    // 🔴 A cut whose program already streamed to the END lost no session: it
    // is waiting for the operator's after-check. Aborting it recorded a finished
    // part as aborted, and `finishJob` then refused to ever mark it done.
    if (j.streamed) continue;
    const r = abortJob(out, j.id, now, 'this app', 'The page was reloaded, so the controller session that was running it is gone.');
    if (r.ok) out = r.book;
  }
  return out;
}

const STATES: readonly JobState[] = ['queued', 'running', 'held', 'done', 'failed', 'aborted'];

/** Validate a stored book. A job that cannot be read is dropped by name, never repaired. */
export function validateBook(raw: unknown, dropped: string[] = []): JobBook {
  const r = (raw ?? {}) as Record<string, unknown>;
  const jobs: Job[] = [];
  if (Array.isArray(r.jobs)) {
    for (const item of r.jobs as Record<string, unknown>[]) {
      const j = (item ?? {}) as Record<string, unknown>;
      const name = typeof j.title === 'string' ? j.title : String(j.id ?? '?');
      const p = j.program as Record<string, unknown> | undefined;
      if (typeof j.id !== 'string' || typeof j.machineId !== 'string' || !STATES.includes(j.state as JobState)) {
        dropped.push(`${name}: no id, machine or known state`);
        continue;
      }
      if (!p || typeof p.gcode !== 'string' || typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) {
        dropped.push(`${name}: its program is missing or has no hash`);
        continue;
      }
      if (!Array.isArray(j.history) || !j.design || !j.plan || !j.stock) {
        dropped.push(`${name}: incomplete record`);
        continue;
      }
      jobs.push(j as unknown as Job);
    }
  }
  return { version: 1, jobs };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readJobs(storage: StorageLike | null): { book: JobBook; dropped: string[] } {
  const dropped: string[] = [];
  let raw: unknown = null;
  try {
    const s = storage?.getItem(JOBS_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    dropped.push('the saved jobs could not be read');
  }
  return { book: validateBook(raw, dropped), dropped };
}

export function writeJobs(storage: StorageLike | null, book: JobBook): string | null {
  try {
    if (!storage) return 'No storage in this browser: jobs hold for this page only.';
    storage.setItem(JOBS_KEY, JSON.stringify(book));
    return null;
  } catch (e) {
    return `Jobs could not be saved (${String((e as Error).message ?? e)}). They hold for this page only.`;
  }
}
