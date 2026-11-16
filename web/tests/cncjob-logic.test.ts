// 2bee.cnc pure logic: the machine registry, the job queue, the run blocker,
// the guided steps and the M0 prompts (src/cncjob/*.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBridgeMachine,
  EMPTY_REGISTRY,
  loadedCheck,
  proposeHostname,
  readMachines,
  setInCollet,
  setMachineTools,
  SIM_ID,
  validateRegistry,
  withSimulated,
  writeMachines,
  type Machine,
} from '../src/cncjob/machines.ts';
import {
  abortJob,
  activeOn,
  EMPTY_BOOK,
  enqueue,
  finishJob,
  moveJob,
  queueFor,
  reconcileAfterReload,
  removeJob,
  startJob,
  streamFinished,
  validateBook,
  type JobBook,
} from '../src/cncjob/jobs.ts';
import { ESTOP_REASON, runBlocker, startBlockers } from '../src/cncjob/safety.ts';
import { guidedSteps, pauseAt, pausePrompt, pausesOf, type StepId } from '../src/cncjob/steps.ts';
import { NOT_SAFETY, statusLabel } from '../src/cncjob/MachineCard.tsx';
import type { SetupFacts } from '../src/cam.ts';

const T0 = 1_760_000_000_000;
const SHA = 'a'.repeat(64);

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

function jobInput(book: JobBook, machineId = SIM_ID, id = `j${book.jobs.length + 1}`) {
  return {
    id,
    title: id,
    design: { id: 'd', title: 'D', thumb: null },
    machineId,
    plan: { config: {}, sectionZ: 3, chosen: [] },
    stock: { x: 100, y: 60, t: 6 },
    program: { gcode: 'G0 Z5\nM30\n', sha256: SHA, lines: 2, seconds: 60, tools: ['T6'], toolChanges: 0, deepestZ: -6, rapidRate: 5000 },
    facts: null,
    createdAt: T0,
  };
}

function q(book: JobBook, n: number, machineId = SIM_ID): JobBook {
  for (let i = 0; i < n; i++) {
    const r = enqueue(book, jobInput(book, machineId), T0, 'op');
    assert.ok(r.ok);
    book = r.book;
  }
  return book;
}

const ok = <T extends { ok: boolean }>(r: T) => {
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

/* ── machines.ts ─────────────────────────────────────────────────────────── */

test('the registry always holds the simulated machine and the known cnc-01', () => {
  const r = withSimulated(EMPTY_REGISTRY, T0);
  assert.deepEqual(r.machines.map((m) => m.id), [SIM_ID, 'cnc-01']);
  const c1 = r.machines[1];
  assert.equal(c1.connection.kind, 'bridge');
  assert.deepEqual(c1.host, { mdns: 'cnc-01.local', os: 'Raspberry Pi OS Lite 64-bit' });
  assert.equal(c1.estopInstalled, false);
  assert.equal(proposeHostname(r), 'cnc-02');
});

test('a bridge machine needs a cnc-NN name and a plain http(s) URL', () => {
  const r = withSimulated(EMPTY_REGISTRY, T0);
  assert.equal(addBridgeMachine(r, 'router', 'http://x.local', T0).ok, false);
  assert.equal(addBridgeMachine(r, 'cnc-01', 'http://x.local', T0).ok, false, 'duplicate');
  assert.equal(addBridgeMachine(r, 'cnc-02', 'ftp://x.local', T0).ok, false);
  assert.equal(addBridgeMachine(r, 'cnc-02', 'http://u:p@x.local', T0).ok, false);
  const a = ok(addBridgeMachine(r, 'cnc-02', 'http://cnc-02.local:8080', T0));
  assert.equal(a.reg.machines.length, 3);
});

test('tools per machine are a subset of the registered tools; the collet holds one of them', () => {
  const r = withSimulated(EMPTY_REGISTRY, T0);
  assert.equal(setMachineTools(r, SIM_ID, ['T6', 'NOPE'], ['T6', 'T3']).ok, false);
  const a = ok(setMachineTools(r, SIM_ID, ['T6', 'T3'], ['T6', 'T3']));
  assert.equal(setInCollet(a.reg, SIM_ID, 'T12').ok, false);
  const b = ok(setInCollet(a.reg, SIM_ID, 'T3'));
  // Dropping the tool in the collet clears the collet record.
  const c = ok(setMachineTools(b.reg, SIM_ID, ['T6'], ['T6', 'T3']));
  assert.equal(c.reg.machines[0].inCollet, null);
});

test('loaded check: every job cutter held, and the first one in the collet', () => {
  const m = { hostname: 'cnc-sim', toolIds: ['T6'], inCollet: null };
  assert.deepEqual(loadedCheck(m, ['T6']).ok, false);
  assert.deepEqual(loadedCheck({ ...m, inCollet: 'T6' }, ['T6']), { ok: true, problems: [] });
  assert.match(loadedCheck({ ...m, inCollet: 'T6' }, ['T6', 'T3']).problems.join(), /does not hold: T3/);
  assert.match(loadedCheck({ ...m, toolIds: ['T6', 'T3'], inCollet: 'T3' }, ['T6', 'T3']).problems.join(), /T3 is in the collet; the job starts with T6/);
});

test('validation drops bad entries by name, and a stored estopInstalled:true is IGNORED', () => {
  const dropped: string[] = [];
  const reg = validateRegistry(
    {
      machines: [
        { id: 'cnc-sim', hostname: 'cnc-sim', connection: { kind: 'simulated' } },
        { id: 'cnc-05', hostname: 'cnc-05', connection: { kind: 'simulated' } },
        { id: 'cnc-06', hostname: 'cnc-06', connection: { kind: 'bridge', url: 'nope' } },
        { id: 'cnc-07', hostname: 'cnc-07', connection: { kind: 'bridge', url: 'http://cnc-07.local' }, estopInstalled: true },
      ],
    },
    dropped,
  );
  assert.deepEqual(reg.machines.map((m) => m.id), ['cnc-sim', 'cnc-07']);
  assert.equal(dropped.length, 2);
  assert.equal(reg.machines[1].estopInstalled, false, 'a stored true is not ops closing H5');
});

test('machines round-trip through storage', () => {
  const st = memStorage();
  const reg = ok(addBridgeMachine(withSimulated(EMPTY_REGISTRY, T0), 'cnc-03', 'http://cnc-03.local', T0)).reg;
  assert.equal(writeMachines(st, reg), null);
  assert.deepEqual(readMachines(st, T0).reg.machines.map((m) => m.id), ['cnc-sim', 'cnc-01', 'cnc-03']);
});

/* ── jobs.ts ─────────────────────────────────────────────────────────────── */

test('enqueue queues and starts nothing', () => {
  const b = q(EMPTY_BOOK, 2);
  assert.deepEqual(b.jobs.map((j) => j.state), ['queued', 'queued']);
  assert.equal(activeOn(b, SIM_ID), null);
});

test('ONE running job per machine; another machine is independent', () => {
  let b = q(q(EMPTY_BOOK, 2), 1, 'cnc-01');
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  const second = startJob(b, 'j2', 'aircut', T0, 'op');
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.problem, /already running on cnc-sim/);
  assert.ok(startJob(b, 'j3', 'aircut', T0, 'op').ok, 'cnc-01 is a different machine');
});

test('the cut cannot start before the air cut of THIS program; the air cut returns the job to the queue', () => {
  let b = q(EMPTY_BOOK, 1);
  assert.equal(startJob(b, 'j1', 'cut', T0, 'op').ok, false);
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  assert.equal(b.jobs[0].state, 'queued');
  assert.deepEqual(b.jobs[0].airCut, { sha256: SHA, machineId: SIM_ID, at: T0 });
  b = ok(startJob(b, 'j1', 'cut', T0, 'op')).book;
  assert.equal(b.jobs[0].phase, 'cut');
});

test('done/failed only after the program finished; transitions outside NEXT are refused', () => {
  let b = q(EMPTY_BOOK, 1);
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  b = ok(startJob(b, 'j1', 'cut', T0, 'op')).book;
  assert.equal(finishJob(b, 'j1', 'done', T0, 'op').ok, false, 'still cutting');
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  b = ok(finishJob(b, 'j1', 'done', T0, 'op', 'clean')).book;
  assert.equal(b.jobs[0].state, 'done');
  assert.equal(b.jobs[0].history.at(-1)?.note, 'clean');
  assert.equal(startJob(b, 'j1', 'aircut', T0, 'op').ok, false, 'done is terminal');
});

test('an aborted air cut goes back to the queue; an aborted cut is final', () => {
  let b = q(EMPTY_BOOK, 1);
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  b = ok(abortJob(b, 'j1', T0, 'op')).book;
  assert.equal(b.jobs[0].state, 'queued');
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  b = ok(startJob(b, 'j1', 'cut', T0, 'op')).book;
  b = ok(abortJob(b, 'j1', T0, 'op', 'why')).book;
  assert.equal(b.jobs[0].state, 'aborted');
});

test('only queued jobs are moved or removed; moves stay within one machine', () => {
  let b = q(q(EMPTY_BOOK, 1), 1, 'cnc-01');
  b = q(b, 1);
  b = ok(moveJob(b, 'j3', -1)).book;
  assert.deepEqual(queueFor(b, SIM_ID).map((j) => j.id), ['j3', 'j1']);
  b = ok(startJob(b, 'j3', 'aircut', T0, 'op')).book;
  assert.equal(moveJob(b, 'j3', 1).ok, false);
  assert.equal(removeJob(b, 'j3').ok, false);
  assert.equal(ok(removeJob(b, 'j1')).book.jobs.length, 2);
});

test('after a reload a running job whose controller session is gone is not shown as running', () => {
  let b = q(q(EMPTY_BOOK, 1), 1);
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  b = ok(startJob(b, 'j1', 'cut', T0, 'op')).book;
  const r = reconcileAfterReload(b, [], T0);
  assert.equal(r.jobs[0].state, 'aborted');
  assert.match(r.jobs[0].history.at(-1)!.note!, /reloaded/);
  assert.equal(r.jobs[1].state, 'queued');
});

test('🔴 after a reload a cut that already streamed to the end is NOT aborted — it waits for its after-check', () => {
  /* Every page load reconciles with no live sessions. A cut whose program had
   * finished was aborted with them, and `finishJob` then refused to mark it
   * done: a completed part recorded as aborted, for good. */
  let b = q(EMPTY_BOOK, 1);
  b = ok(startJob(b, 'j1', 'aircut', T0, 'op')).book;
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  b = ok(startJob(b, 'j1', 'cut', T0, 'op')).book;
  b = ok(streamFinished(b, 'j1', T0, 'c')).book;
  assert.equal(b.jobs[0].streamed, true, 'the cut did not register as streamed');
  const r = reconcileAfterReload(b, [], T0);
  assert.equal(r.jobs[0].state, 'running');
  assert.equal(finishJob(r, 'j1', 'done', T0, 'op').ok, true, 'the finished cut can no longer be marked done');
});

test('validateBook drops a job with no program hash, by name', () => {
  const dropped: string[] = [];
  const b = q(EMPTY_BOOK, 1);
  const bad = JSON.parse(JSON.stringify(b.jobs[0]));
  bad.id = 'bad';
  bad.title = 'bad job';
  bad.program.sha256 = 'nope';
  assert.equal(validateBook({ jobs: [b.jobs[0], bad] }, dropped).jobs.length, 1);
  assert.match(dropped[0], /bad job/);
});

/* ── safety.ts ───────────────────────────────────────────────────────────── */

const sim = { connection: { kind: 'simulated' as const }, estopInstalled: false };
const real: Pick<Machine, 'connection' | 'estopInstalled'> = { connection: { kind: 'bridge', url: 'http://cnc-01.local' }, estopInstalled: false };
const ALL: ReadonlySet<StepId> = new Set(['load', 'clamp', 'cutter', 'zero', 'aircut', 'present']);

test('runBlocker: only the SIMULATED machine may run; the reason names the e-stop and H5', () => {
  assert.equal(runBlocker(sim), null);
  assert.equal(runBlocker(real), ESTOP_REASON);
  assert.match(ESTOP_REASON, /No physical e-stop is installed \(never ordered; firmware ESTOP_ENABLE 0\) and ops has router operation on HOLD/);
  assert.match(ESTOP_REASON, /H5/);
  // Even with the HOLD lifted and a bridge, no e-stop on the machine record still refuses.
  assert.match(runBlocker(real, { opsHoldLifted: true, bridgeBuilt: true })!, /e-stop.*H5/);
  // With the e-stop fitted, the HOLD and the missing bridge are still separate refusals.
  assert.match(runBlocker({ ...real, estopInstalled: true })!, /HOLD/);
  assert.match(runBlocker({ ...real, estopInstalled: true }, { opsHoldLifted: true, bridgeBuilt: false })!, /bridge is not built/);
});

test('runBlocker refuses a non-simulated machine even with every step ticked and the operator confirmed', () => {
  let b = q(EMPTY_BOOK, 1, 'cnc-01');
  b = { ...b, jobs: b.jobs.map((j) => ({ ...j, facts: {} as SetupFacts, airCut: { sha256: SHA, machineId: 'cnc-01', at: T0 } })) };
  const blockers = startBlockers({ machine: real, job: b.jobs[0], ticks: ALL, loaded: { ok: true, problems: [] }, phase: 'cut' });
  assert.deepEqual(blockers, [ESTOP_REASON]);
  // The same job on the simulated machine has nothing left in the way.
  const j = { ...b.jobs[0], machineId: SIM_ID, airCut: { sha256: SHA, machineId: SIM_ID, at: T0 } };
  assert.deepEqual(startBlockers({ machine: sim, job: j, ticks: ALL, loaded: { ok: true, problems: [] }, phase: 'cut' }), []);
});

test('startBlockers: unticked steps, no air cut, missing facts and loaded problems each refuse', () => {
  const j = { ...q(EMPTY_BOOK, 1).jobs[0] };
  const out = startBlockers({ machine: sim, job: j, ticks: new Set(['load']), loaded: { ok: false, problems: ['T6 not in collet.'] }, phase: 'cut' });
  assert.ok(out.some((x) => /setup facts/.test(x)));
  assert.ok(out.some((x) => /T6 not in collet/.test(x)));
  assert.ok(out.some((x) => /Not ticked yet: clamp, cutter 1, zero, air cut, at the machine/.test(x)));
  assert.ok(out.some((x) => /air cut has not been run/.test(x)));
  // The air cut needs only the setup ticks.
  const air = startBlockers({ machine: sim, job: { ...j, facts: {} as SetupFacts }, ticks: new Set(['load', 'clamp', 'cutter', 'zero']), loaded: { ok: true, problems: [] }, phase: 'aircut' });
  assert.deepEqual(air, []);
});

test('the card state is controller status and never reads as safe, whatever the state', () => {
  for (const w of ['Idle', 'Run', 'Hold:0', 'Alarm', 'Door', 'Home', 'Offline', 'not connected', 'Check', 'Sleep', 'Jog']) {
    const l = statusLabel(w);
    assert.match(l, /^controller status: /);
    assert.doesNotMatch(l, /\b(safe|ready|ok|clear)\b/i, `"${l}" reads as a safety verdict`);
  }
  assert.match(NOT_SAFETY, /does not mean safe/);
});

/* ── steps.ts ────────────────────────────────────────────────────────────── */

const FACTS: SetupFacts = {
  ok: true,
  mismatches: ['program says 18 mm, job says 19 mm'],
  pending: [],
  tools: [
    { index: 1, name: 'T3', diameter_mm: 3.175, in_job_tool_list: true },
    { index: 0, name: 'T6', diameter_mm: 6, in_job_tool_list: true },
  ],
  tool_changes: 1,
  z_datum: { declared: 'top of the workpiece', source: 's' },
  xy_zero: { convention: 'front-left corner', source: 's' },
  workpiece: { size_x_mm: 140, size_y_mm: 100, thickness_mm: 6 },
  depth: { deepest_emitted_z_mm: -6.5, cuts_through: true, into_spoilboard_mm: 0.5 },
  spindle: { rpm: [18000] },
};

test('guided steps come from the setup facts, in the ruled order', () => {
  const s = guidedSteps({ facts: FACTS, stock: { x: 1, y: 1, t: 1 }, tools: ['X'] });
  assert.deepEqual(s.map((x) => x.id), ['load', 'clamp', 'cutter', 'zero', 'aircut', 'present']);
  assert.match(s[0].lines[0], /^6 mm thick, at least 140 × 100 mm/);
  assert.match(s[1].lines.join(' '), /0.5 mm into the spoilboard/);
  assert.equal(s[2].tool, 'T6', 'cutter 1 is the LOWEST index, not the first listed');
  assert.match(s[3].lines[0], /Z zero on the top/);
  assert.deepEqual(s[3].checks, ['program says 18 mm, job says 19 mm']);
});

test('no setup facts: the steps say so instead of filling in', () => {
  const s = guidedSteps({ facts: null, stock: { x: 100, y: 60, t: 6 }, tools: ['T6'] });
  assert.match(s[0].checks.join(), /could not be read/);
  assert.match(s[3].lines[0], /not known/);
});

test('M0 prompts are read from the program: tool, clamp, and an unexplained pause', () => {
  const lines = ['G0 Z5', '( TOOL CHANGE -> T3 )', 'M0', 'G1 X1', '( CLAMP CHANGE -> move clamp B )', 'M0', 'G1 X2', 'M0', 'M30'];
  const p = pausesOf(lines);
  assert.deepEqual(p.map((x) => [x.line, x.kind, x.cutter]), [[2, 'tool', 2], [5, 'clamp', null], [7, 'unexplained', null]]);
  assert.equal(pausePrompt(p[0]).title, 'Stop. Fit cutter 2: T3');
  assert.match(pausePrompt(p[2]).lines[0], /Do not resume/);
  // Only when HELD at the line the controller just answered.
  assert.equal(pauseAt(p, 3, 'Hold:0')?.line, 2);
  assert.equal(pauseAt(p, 3, 'Idle'), null);
  assert.equal(pauseAt(p, 4, 'Hold:0'), null, 'a feed hold between ordinary lines is not a tool change');
  // 🔴 grblHAL's order: it holds BEFORE answering the M0 (the ok comes after
  // Resume), so the M0 is the next unanswered line. The fake's order alone
  // passed every test while a real board would show no tool-change takeover.
  assert.equal(pauseAt(p, 2, 'Hold:0')?.line, 2, 'held ON the M0 with its ok still owed — no takeover');
});

test('a clamp move and a cutter change at ONE M0 are one pause carrying both instructions', () => {
  const lines = [
    'G0 Z5.000',
    '( CLAMP CHANGE -> phase 2 of 2, 3 clamps: move clamp c1 from X-10.0 Y120.0 to X-10.0 Y347.5 while the other clamps stay tight )',
    '( TOOL CHANGE -> 3mm )',
    'M0',
    'G1 X1',
    '( CLAMP CHANGE -> move c2 )',
    'M0',
  ];
  const p = pausesOf(lines);
  assert.equal(p.length, 2);
  assert.equal(p[0].kind, 'tool');
  assert.equal(p[0].text, '3mm');
  assert.match(p[0].clamps ?? '', /move clamp c1/);
  assert.match(pausePrompt(p[0]).title, /^Stop\. Move the clamps, then fit cutter 2: 3mm$/);
  assert.equal(p[1].kind, 'clamp');
  assert.equal(p[1].clamps, undefined);
});

test('no Z probe: the cutter stop names old → new and says a hand-zero stop follows; the zero stop is its own pause', () => {
  const lines = [
    '( tool: 6mm end mill D6.00mm F2 )',
    'G0 Z5.000',
    'M5',
    'G0 X0.000 Y0.000',
    '( change cutter: 6mm end mill -> 3mm drill, then set Z zero by hand. Stopped at safe Z over the workpiece\'s first corner, X0.0 Y0.0 )',
    'G0 Z5.000',
    '( TOOL CHANGE -> 3mm drill )',
    'M0',
    '( SET Z ZERO -> 3mm drill: touch the new cutter off on the workpiece top, set Z zero there with the controller, then resume. The program lifts Z first )',
    'M0',
    'G90 G54',
    'G0 Z5.000',
  ];
  const p = pausesOf(lines);
  assert.deepEqual(p.map((x) => x.kind), ['tool', 'zero']);
  assert.equal(p[0].from, '6mm end mill');
  assert.equal(p[0].zeroNext, true);
  assert.equal(pausePrompt(p[0]).title, 'Stop. Change cutter: 6mm end mill → 3mm drill, then set Z zero by hand');
  assert.match(pausePrompt(p[1]).lines.join(' '), /touch the new cutter off on the workpiece top/);
  assert.match(pausePrompt(p[1]).lines.join(' '), /lifts Z first/);
});

test('no Z probe: a clamp-only stop prompt carries the warning the program writes', () => {
  const lines = [
    'M5',
    '( Z not re-checked after the clamp move - do not touch the spindle or the cutter while moving the clamp )',
    'G0 Z5.000',
    '( CLAMP CHANGE -> move c1 )',
    'M0',
  ];
  const p = pausesOf(lines);
  assert.equal(p[0].kind, 'clamp');
  assert.match(pausePrompt(p[0]).lines.join(' '), /Warning: Z not re-checked after the clamp move - do not touch the spindle or the cutter/);
  // CONTROL: without the comment, the ordinary prompt.
  assert.equal(pausesOf(lines.filter((_, i) => i !== 1))[0].warning, undefined);
});

test('a touch plate left on the work is its own stop, and a re-reference asks for it back (bughunt 2026-11-15)', () => {
  /* The core now stops after a probe against a plate lying on the work, and says before a
   * re-reference stop that the plate goes back. Read as `unexplained`, the first was "do not
   * resume until you know why"; the second said "check Z zero" while the program was about to
   * probe onto wherever the plate was not. */
  const lines = [
    'G10 L20 P1 Z15.000',
    'G0 Z17.000',
    "( TOUCH PLATE -> take the touch plate off the work and out of the cutter's way, then resume )",
    'M0',
    'G90 G54',
    'G0 Z17.000',
    'M3 S18000',
    'G0 Z5.000',
    'M5',
    '( then put the touch plate back under the cutter - Z is probed from it as soon as you resume )',
    '( TOOL CHANGE -> 3mm drill )',
    'M0',
    'G91',
    'G38.2 Z-30.000 F200.0',
  ];
  const p = pausesOf(lines);
  assert.deepEqual(p.map((x) => x.kind), ['plate', 'tool']);
  assert.match(pausePrompt(p[0]).title, /Take the touch plate off the work/);
  assert.equal(p[1].plateBack, true);
  assert.match(pausePrompt(p[1]).lines.join(' '), /Put the touch plate back under the cutter/);
  // CONTROL: without the comment the tool stop is the ordinary one.
  const plain = pausesOf(lines.filter((_, i) => i !== 9));
  assert.equal(plain[1].plateBack, undefined);
  assert.match(pausePrompt(plain[1]).lines.join(' '), /Check Z zero for the new cutter/);
});

test('a SPOILBOARD-top datum is not read as the workpiece top (bughunt 2026-11-15)', () => {
  /* `includes('top')` matched "spoilboard top": the guided step said "Z zero on the top of the
   * workpiece" for a program zeroed on the spoilboard, so every cut ran one workpiece thickness
   * too shallow and the part was not cut through. */
  const facts: SetupFacts = { ...FACTS, z_datum: { declared: 'spoilboard top', source: 's' } };
  const s = guidedSteps({ facts, stock: { x: 1, y: 1, t: 1 }, tools: ['X'] });
  assert.doesNotMatch(s[3].lines[0], /top of the workpiece/);
  assert.match(s[3].lines[0], /spoilboard top/);
});

test('a proposal naming a cutter the shop does not own is refused by the plan (bughunt 2026-11-15)', async () => {
  const { unownedTools } = await import('../src/cncjob/plan.ts');
  const { candidateConfig } = await import('../src/cnc/jobAsk.ts');
  const owned = ['Up-cut 6mm'];
  const base = { tool_ids: owned, op: {} } as unknown as Parameters<typeof candidateConfig>[0];
  const asked = candidateConfig(base, { op: {}, tool_ids: ['End Mill - Down-cut 6mm 2F'] } as Parameters<typeof candidateConfig>[1]);
  assert.deepEqual(unownedTools(asked, owned), ['End Mill - Down-cut 6mm 2F']);
  assert.deepEqual(unownedTools(base, owned), []);
});

test('every host sends the collet drawer the UI lists cutters with (J9: 3.175 mm refused as "the shop\'s collets are 6mm")', async () => {
  // bughunt 2026-11-15: 411b33a0f3 took the reference fixture's drawer off the core's import job and
  // no host sent one, so 2bee.cnc and the Make step refused every cutter but 6 mm.
  const { shopFields, SPARE_COLLETS_MM } = await import('../src/cncjob/machines.ts');
  const f = shopFields({ probeEnabled: false, touchPlateMm: '' });
  assert.deepEqual(f.spare_collets_mm, [...SPARE_COLLETS_MM]);
  assert.equal(f.probe_enabled, false);
  assert.ok(!('touch_plate_mm' in f), 'an unstated plate is not sent');
  assert.equal(shopFields({ probeEnabled: true, touchPlateMm: '15' }).touch_plate_mm, 15);
  const { readFileSync } = await import('node:fs');
  for (const p of ['src/make/MakeFlow.tsx', 'src/cncjob/plan.ts']) {
    assert.match(readFileSync(p, 'utf8'), /shopFields\(useCncStore\.getState\(\)\)/, `${p} plans without the drawer`);
  }
  assert.match(readFileSync('src/App.tsx', 'utf8'), /spare_collets_mm: \[\.\.\.SPARE_COLLETS_MM\]/, 'the expert tab plans without the drawer');
});
