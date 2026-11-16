// The one place 2bee.cnc's machines, jobs and simulated controller sessions
// live while the page is open, shared by the main page and the Jobs page.
//
// Persistence is `machines.ts` / `jobs.ts` (localStorage, validated on read).
// The controller sessions are NOT persisted: the simulated controller lives in
// this page, so after a reload a job the book says was running is marked
// aborted with that reason (`reconcileAfterReload`) instead of shown as running.
//
// 🔴 Only SIMULATED machines get a session. A bridge machine has none, because
// the bridge does not exist; its card says so.

import { useSyncExternalStore } from 'react';
import { isSimulated, readMachines, writeMachines, type MachineRegistry } from './machines';
import { abortJob, readJobs, reconcileAfterReload, streamFinished, writeJobs, type BookOutcome, type JobBook } from './jobs';
import { SimSession } from './simController';

export const WHO = 'operator';

interface State {
  reg: MachineRegistry;
  book: JobBook;
  /** Why the last save failed, or why something was dropped on load. */
  notes: string[];
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

let state: State | null = null;
const listeners = new Set<() => void>();
const sessions = new Map<string, SimSession>();
let timer: ReturnType<typeof setInterval> | null = null;

function init(): State {
  if (state) return state;
  const now = Date.now();
  const m = readMachines(storage(), now);
  const j = readJobs(storage());
  const live = m.reg.machines.filter(isSimulated).map((x) => x.id);
  // Sessions are created below; none is running yet, so every active job is stale.
  const book = reconcileAfterReload(j.book, [], now);
  state = { reg: m.reg, book, notes: [...m.dropped.map((d) => `Machine dropped: ${d}`), ...j.dropped.map((d) => `Job dropped: ${d}`)] };
  for (const id of live) ensureSession(id);
  if (book !== j.book) writeJobs(storage(), book);
  return state;
}

function emit(): void {
  for (const f of listeners) f();
}

function subscribe(f: () => void): () => void {
  init();
  listeners.add(f);
  return () => listeners.delete(f);
}

export function getState(): State {
  return init();
}

export function setRegistry(reg: MachineRegistry): void {
  const s = init();
  const why = writeMachines(storage(), reg);
  state = { ...s, reg, notes: why ? [why] : s.notes };
  for (const m of reg.machines) if (isSimulated(m)) ensureSession(m.id);
  emit();
}

/** Apply a book change. Returns the refusal, if any, for the caller to show. */
export function applyBook(o: BookOutcome): string | null {
  if (!o.ok) return o.problem;
  const s = init();
  const why = writeJobs(storage(), o.book);
  state = { ...s, book: o.book, notes: why ? [why] : s.notes };
  emit();
  return null;
}

export function sessionFor(id: string): SimSession | null {
  return sessions.get(id) ?? null;
}

function ensureSession(id: string): SimSession {
  let s = sessions.get(id);
  if (s) return s;
  s = new SimSession();
  sessions.set(id, s);
  let last = '';
  s.subscribe(() => {
    const snap = s!.snapshot();
    const key = JSON.stringify([snap.state, snap.substate, snap.homed, snap.homing, snap.stream, snap.pause, snap.refusals.length, snap.work?.map((v) => v.toFixed(2))]);
    if (key === last) return;
    last = key;
    state = { ...init() };
    emit();
  });
  s.onEnded((jobId, how, why) => {
    const book = init().book;
    applyBook(how === 'done' ? streamFinished(book, jobId, Date.now(), 'controller') : abortJob(book, jobId, Date.now(), 'controller', why ?? undefined));
  });
  void s.connect();
  if (!timer && typeof setInterval === 'function') {
    timer = setInterval(() => {
      for (const x of sessions.values()) void x.tick();
    }, 50);
  }
  return s;
}

/** Re-render on any change to machines, jobs or a controller session. */
export function useCncJobs(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}
