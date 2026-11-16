// cnc.run (src/run/*) and the run door it shares with the Jobs page
// (src/cncjob/runDoor.ts, src/cncjob/airCut.ts). Every assertion is on the
// EMITTED lines or on what reached the controller session, never on a setting.
//
// ⚠ A green here is a statement about this lane's code and its fake grblHAL.
// Nothing moved and nothing has cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIR_CUT_CLEARANCE_MM, AIR_CUT_MIN_LIFT_MM, airCutProgram } from '../src/cncjob/airCut.ts';
import { beginRun, linesFor, runRefusals, type RunSession } from '../src/cncjob/runDoor.ts';
import { EMPTY_BOOK, enqueue, startJob, streamFinished, type Job, type JobBook } from '../src/cncjob/jobs.ts';
import { KNOWN_MACHINES, colletAfterChange, loadedCheck, simulatedMachine, type Machine } from '../src/cncjob/machines.ts';
import { ESTOP_REASON } from '../src/cncjob/safety.ts';
import { extraOpen, guidedTicks, runSequence } from '../src/run/runSequence.ts';
import { toolAt, toolpathOf } from '../src/run/toolpath.ts';
import { localAnswer, buildRunRequest, RUN_SYSTEM_INSTRUCTION } from '../src/run/RunChat.tsx';
import type { RunProgram } from '../src/RunTab.tsx';
import type { SetupFacts } from '../src/cam.ts';

const T0 = 1_760_000_000_000;
const TOOLS = ['T6', 'T3'];
const GCODE = [
  '( test )',
  'G17 G21 G90 G54 G94 G40',
  'G0 Z5.000',
  'M3 S18000',
  'G1 Z-6.500 F300.0 ( deepest )',
  'G2 X10.000 Y0.000 I5.000 J0.000 Z-6.500',
  'G0 Z5.000',
  'M5',
  '( TOOL CHANGE -> T3 )',
  'M0',
  'M03 S16000',
  'G1 Z-2.000 F300.0',
  'G0 Z5.000',
  'M5',
  'M30',
].join('\n');

const FACTS = {
  ok: true, mismatches: [], pending: [], tool_changes: 1,
  tools: TOOLS.map((name, index) => ({ index, name, diameter_mm: index ? 3 : 6, in_job_tool_list: true })),
  z_datum: { declared: 'top of the workpiece', source: 'test' },
  xy_zero: { convention: 'front-left corner', source: 'test' },
  workpiece: { size_x_mm: 120, size_y_mm: 60, thickness_mm: 6 },
  depth: { deepest_emitted_z_mm: -6.5, cuts_through: true, into_spoilboard_mm: 0.5 },
  spindle: { rpm: [18000] },
} as unknown as SetupFacts;

const lines = GCODE.split('\n');
const zOf = (l: readonly string[]) => l.flatMap((x) => [...x.replace(/\([^)]*\)/g, '').matchAll(/Z([-+]?\d*\.?\d+)/gi)].map((m) => Number(m[1])));

/* ── airCut.ts ─────────────────────────────────────────────────────────── */

test('air cut: the EMITTED lines start no spindle and stay clearance above Z zero', () => {
  const a = airCutProgram(lines, FACTS);
  assert.ok(a.ok, JSON.stringify(a));
  if (!a.ok) return;
  assert.equal(a.lift, AIR_CUT_MIN_LIFT_MM, 'a shallow program keeps the old minimum lift');
  assert.equal(a.spindleLinesRemoved, 2, 'both spindle starts (M3 and M03) removed');
  assert.ok(!a.lines.some((l) => /\bM0?[34]\b/i.test(l.replace(/\([^)]*\)/g, ''))), 'no M3/M4 left in the code');
  assert.ok(Math.min(...zOf(a.lines)) >= AIR_CUT_CLEARANCE_MM, `lowest emitted Z ${Math.min(...zOf(a.lines))}`);
  assert.ok(a.lines.includes('M0') && a.lines.includes('( TOOL CHANGE -> T3 )'), 'the tool change and its note survive, in order');
  assert.ok(a.lines.includes('M5') && a.lines.includes('M30'));
  assert.ok(a.lines.some((l) => l.includes('( deepest )')), 'comments are kept');
});

test('air cut: the lift is chosen FROM THE PROGRAM — a 30 mm deep program is lifted 35, not 25', () => {
  // The defect: a fixed 25 mm instruction, unchecked, would air-cut 5 mm into this workpiece.
  const deep = lines.map((l) => l.replace('Z-6.500', 'Z-30.000'));
  const a = airCutProgram(deep, FACTS);
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(a.lowestZ, -30);
  assert.equal(a.lift, 35);
  assert.equal(Math.min(...zOf(a.lines)), AIR_CUT_CLEARANCE_MM);
});

test('air cut: refused by line, never rewritten — G20, G53, G92, a canned cycle, an odd G10, an absolute probe, spindle on a moving line', () => {
  for (const [bad, word] of [
    ['G20', 'G20'],
    ['G10 L2 P1 Z0', 'G10'],
    ['G38.2 Z-10 F100', 'G38'],
    ['G53 G0 Z0', 'G53'],
    ['G92 Z0', 'G92'],
    ['G81 X1 Y1 Z-3 R2', 'canned cycle'],
    ['G1 X1 M3', 'starts the spindle'],
  ] as const) {
    const a = airCutProgram([...lines.slice(0, 3), bad, ...lines.slice(3)], FACTS);
    assert.equal(a.ok, false, bad);
    if (!a.ok) {
      assert.match(a.why, /Line 4/, bad);
      assert.ok(a.why.includes(word), `${bad}: ${a.why}`);
    }
  }
  assert.ok(airCutProgram(['G90', 'G91.1', 'G0 Z5'], FACTS).ok, 'G91.1 (incremental arc centres) is not G91');
});

test('air cut: the post\'s touch-plate block — G91 distances and the G10 L20 datum are NOT raised; absolute moves after it are', () => {
  // As post_grblhal.rs writes it (journey J9's core-planned program).
  const probe = ['G21 G90', 'M5', 'G49', 'G0 Z10.000', 'G91', 'G38.2 Z-50.000 F100.0', 'G0 Z2.000', 'G38.2 Z-4.000 F25.0', 'G90', 'G10 L20 P1 Z12.000', 'G0 Z10.000', 'M3 S18000', 'G1 Z-6.000 F300', 'G0 Z10.000', 'M5', 'M30'];
  const a = airCutProgram(probe, FACTS);
  assert.ok(a.ok, JSON.stringify(a));
  if (!a.ok) return;
  const body = a.lines.slice(1);
  for (const keep of ['G38.2 Z-50.000 F100.0', 'G0 Z2.000', 'G38.2 Z-4.000 F25.0', 'G10 L20 P1 Z12.000']) assert.ok(body.includes(keep), `${keep} unchanged`);
  assert.equal(a.lowestZ, -6);
  assert.equal(a.lift, 25);
  assert.ok(body.includes('G1 Z19.000 F300'), 'the cut move after the datum is raised');
  assert.ok(body.includes('G0 Z35.000'));
  // Planted: the same block with the G91 removed would make the probe's Z an absolute target.
  const planted = probe.filter((l) => l !== 'G91');
  assert.equal(airCutProgram(planted, FACTS).ok, false);
});

test('air cut: Z zero on the SPOILBOARD — lifted clear of the workpiece top the core states, refused when it states none', () => {
  // "spoilboard top" contains the word "top": it must not pass as a workpiece-top datum.
  const spoil = { ...FACTS, z_datum: { declared: 'spoilboard top', source: 't' } } as SetupFacts;
  const a = airCutProgram(lines, spoil);
  assert.equal(a.ok, false);
  if (!a.ok) assert.match(a.why, /do not say where the workpiece top is/);
  // With the core's own fact (setup.rs ZDatumFact.workpiece_top_emitted_z_mm), the lift clears the top.
  const deep = lines.map((l) => l.replace('Z-6.500', 'Z12.000').replace('Z-2.000', 'Z14.000'));
  const withTop = { ...FACTS, z_datum: { declared: 'spoilboard top', source: 't', workpiece_top_emitted_z_mm: 18 } } as unknown as SetupFacts;
  const b = airCutProgram(deep, withTop);
  assert.ok(b.ok, JSON.stringify(b));
  if (b.ok) {
    assert.equal(b.lift, 25, 'lowest Z 5 → lift max(25, ceil(18 + 5 - 5))');
    assert.ok(Math.min(...zOf(b.lines)) >= 18 + AIR_CUT_CLEARANCE_MM);
  }
  const deeper = deep.map((l) => l.replace('Z12.000', 'Z-6.000'));
  const c = airCutProgram(deeper, withTop);
  assert.ok(c.ok);
  if (c.ok) {
    assert.equal(c.lift, 29, 'lowest Z -6 under an 18 mm top: lift 18 + 5 + 6');
    assert.equal(Math.min(...zOf(c.lines)), 18 + AIR_CUT_CLEARANCE_MM);
  }
  assert.equal(airCutProgram(lines, null).ok, false);
});

/* ── runDoor.ts ────────────────────────────────────────────────────────── */

function machines(): { sim: Machine; real: Machine } {
  const sim = { ...simulatedMachine(T0), toolIds: [...TOOLS], inCollet: TOOLS[0] };
  const real = { ...KNOWN_MACHINES[0], addedAt: T0, toolIds: [...TOOLS], inCollet: TOOLS[0] } as Machine;
  return { sim, real };
}

function book(machineIds: string[]): JobBook {
  let b = EMPTY_BOOK;
  machineIds.forEach((m, i) => {
    const r = enqueue(
      b,
      {
        id: `j${i + 1}`,
        title: `job ${i + 1}`,
        design: { id: 'd', title: 'D', thumb: null },
        machineId: m,
        plan: { config: {}, sectionZ: 3, chosen: [] },
        stock: { x: 120, y: 60, t: 6 },
        program: { gcode: GCODE, sha256: 'b'.repeat(64), lines: lines.length, seconds: 60, tools: TOOLS, toolChanges: 1, deepestZ: -6.5, rapidRate: 5000 },
        facts: FACTS,
        createdAt: T0,
      },
      T0,
      'op',
    );
    assert.ok(r.ok);
    b = r.book;
  });
  return b;
}

class SpySession implements RunSession {
  calls: { jobId: string; phase: string; program: RunProgram }[] = [];
  start(jobId: string, phase: 'aircut' | 'cut', program: RunProgram) {
    this.calls.push({ jobId, phase, program });
    return { ok: true as const };
  }
}

const PREP = new Set(['load', 'clamp', 'cutter', 'zero'] as const);
const job = (b: JobBook, id: string) => b.jobs.find((j) => j.id === id)! as Job;

test('door: the air cut sends the LIFTED program, and the session is the last thing touched', () => {
  const { sim } = machines();
  const b = book([sim.id]);
  const s = new SpySession();
  const r = beginRun({ book: b, machine: sim, job: job(b, 'j1'), ticks: PREP, phase: 'aircut', now: T0, who: 'op', session: s });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(s.calls.length, 1);
  const sent = s.calls[0].program.lines;
  assert.ok(!sent.some((l) => /^M0?3\b/i.test(l)), 'no spindle start reached the session');
  assert.ok(Math.min(...zOf(sent)) >= AIR_CUT_CLEARANCE_MM);
  assert.deepEqual(linesFor(job(b, 'j1'), 'cut'), { ok: true, lines }, 'the cut sends the program unchanged');
});

test('door: a SECOND job on a busy machine is refused BEFORE a byte is sent (journey bug 2)', () => {
  const { sim } = machines();
  let b = book([sim.id, sim.id]);
  const st = startJob(b, 'j1', 'aircut', T0, 'op');
  assert.ok(st.ok);
  b = st.book;
  const s = new SpySession();
  const r = beginRun({ book: b, machine: sim, job: job(b, 'j2'), ticks: PREP, phase: 'aircut', now: T0, who: 'op', session: s });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.problem, /job 1 is already running/);
  assert.equal(s.calls.length, 0, 'the session was never asked to start');
});

test('door: a REAL machine is refused with the e-stop (H5) reason even with every step ticked; nothing is sent', () => {
  const { real } = machines();
  let b = book([real.id]);
  // Even with the air cut recorded and every tick, it stays refused.
  b = { ...b, jobs: b.jobs.map((j) => ({ ...j, airCut: { sha256: j.program.sha256, machineId: real.id, at: T0 } })) };
  const s = new SpySession();
  const all = new Set(['load', 'clamp', 'cutter', 'zero', 'aircut', 'present'] as const);
  const r = beginRun({ book: b, machine: real, job: job(b, 'j1'), ticks: all, phase: 'cut', now: T0, who: 'op', session: s });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.problem.startsWith(ESTOP_REASON), r.problem);
  assert.equal(s.calls.length, 0);
});

test('door: the cut needs the air cut of this program, the watched tick and "I am at the machine"', () => {
  const { sim } = machines();
  let b = book([sim.id]);
  const s = new SpySession();
  const refused = runRefusals({ book: b, machine: sim, job: job(b, 'j1'), ticks: PREP, phase: 'cut', now: T0, who: 'op' });
  assert.ok(refused.some((x) => /air cut has not been run/.test(x)));
  assert.ok(refused.some((x) => /air cut, at the machine/.test(x)), refused.join(' | '));
  const st = startJob(b, 'j1', 'aircut', T0, 'op');
  assert.ok(st.ok);
  const fin = streamFinished(st.book, 'j1', T0, 'controller');
  assert.ok(fin.ok);
  b = fin.book;
  const all = new Set(['load', 'clamp', 'cutter', 'zero', 'aircut', 'present'] as const);
  const r = beginRun({ book: b, machine: sim, job: job(b, 'j1'), ticks: all, phase: 'cut', extra: extraOpen(new Set()), now: T0, who: 'op', session: s });
  assert.equal(r.ok, false, 'the page\'s own hand steps (guard, protection, spindle) refuse too');
  assert.equal(s.calls.length, 0);
  const ok = beginRun({ book: b, machine: sim, job: job(b, 'j1'), ticks: all, phase: 'cut', extra: extraOpen(new Set(['guard', 'ppe', 'spindle'])), now: T0, who: 'op', session: s });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(s.calls[0].program.lines, lines);
});

/* ── runSequence.ts ────────────────────────────────────────────────────── */

test('sequence: prepare → air cut → at the machine → cut → each M0 → finish, numbered', () => {
  const b = book(['cnc-sim']);
  const s = runSequence(job(b, 'j1'));
  assert.deepEqual(
    s.map((x) => x.key),
    ['load', 'clamp', 'cutter', 'zero', 'guard', 'ppe', 'spindle', 'aircut', 'refit', 'present', 'cut', 'pause-9', 'stopped', 'unclamp', 'check', 'clean'],
  );
  assert.deepEqual(s.map((x) => x.n), s.map((_, i) => i + 1));
  const p = s.find((x) => x.kind === 'pause')!;
  assert.equal(p.title, 'Fit cutter 2: T3', 'the tool change is read from the program');
  assert.equal(s.find((x) => x.key === 'cutter')!.title, 'Fit cutter 1: T6');
  assert.match(s.find((x) => x.key === 'aircut')!.lines.join(' '), /lifted clear/);
  assert.deepEqual([...guidedTicks(new Set(['load', 'guard', 'present']))].sort(), ['load', 'present']);
  assert.deepEqual(extraOpen(new Set(['guard'])), ['Not ticked yet: protection, spindle check.']);
  assert.equal(s.find((x) => x.key === 'refit')!.title, 'Put cutter 1 back: T6', 'an air cut with a tool change ends on cutter 2');
  assert.deepEqual(extraOpen(new Set(['guard', 'ppe', 'spindle']), true), ['Not ticked yet: cutter 1 back in the collet after the air cut.']);
  const noChange = runSequence({ ...job(b, 'j1'), program: { ...job(b, 'j1').program, gcode: 'G0 Z5\nG1 Z-1\nM30\n' } });
  assert.ok(!noChange.some((x) => x.key === 'refit' || x.kind === 'pause'), 'no tool change, no refit and no pause step');
});

test('sequence: a clamp move gets its own step in order, and a clamp move at a cutter change is ONE step with both', () => {
  const b = book(['cnc-sim']);
  const g = [
    'G0 Z5', 'M3 S18000', 'G1 Z-1', 'G0 Z5', 'M5',
    '( CLAMP CHANGE -> phase 2 of 3, 2 clamps: move clamp c1 from X5.0 Y120.0 to X5.0 Y255.0 while the other clamps stay tight )',
    'M0',
    'G1 Z-1', 'G0 Z5', 'M5',
    '( CLAMP CHANGE -> phase 3 of 3, 2 clamps: move clamp c2 from X455.0 Y120.0 to X455.0 Y22.5 while the other clamps stay tight )',
    '( TOOL CHANGE -> T3 )',
    'M0',
    'G1 Z-1', 'M30',
  ].join('\n');
  const s = runSequence({ ...job(b, 'j1'), program: { ...job(b, 'j1').program, gcode: g } });
  const pauses = s.filter((x) => x.kind === 'pause');
  assert.deepEqual(pauses.map((x) => x.key), ['pause-6', 'pause-12']);
  assert.equal(pauses[0].title, 'Move the clamps.');
  assert.match(pauses[0].lines.join(' '), /move clamp c1 from X5\.0 Y120\.0 to X5\.0 Y255\.0/);
  assert.equal(pauses[1].title, 'Move the clamps, then fit cutter 2: T3');
  assert.match(pauses[1].lines.join(' '), /move clamp c2/);
  assert.ok(s.indexOf(pauses[0]) < s.indexOf(pauses[1]) && s.indexOf(pauses[1]) < s.findIndex((x) => x.key === 'stopped'));
});

/* ── toolpath.ts ───────────────────────────────────────────────────────── */

test('toolpath: positions per line, an arc ends where it says, G91 / probe / G10 L20 read, G20 stops the drawing by name', () => {
  const tp = toolpathOf(lines);
  assert.deepEqual(toolAt(tp, 0), [0, 0, 0]);
  assert.deepEqual(toolAt(tp, 5), [0, 0, -6.5]);
  assert.deepEqual(toolAt(tp, 6), [10, 0, -6.5], 'the G2 ends at its X/Y');
  assert.ok(tp.lineOf.filter((l) => l === 5).length > 4, 'the arc is drawn as several segments');
  assert.equal(tp.stopped, null);
  const rel = toolpathOf(['G0 Z5', 'G91', 'G1 Z-1', 'G38.2 Z-3 F100', 'G90', 'G10 L20 P1 Z12', 'G0 Z15']);
  assert.equal(rel.stopped, null);
  assert.deepEqual(toolAt(rel, 3), [0, 0, 4], 'G91 moves add');
  assert.deepEqual(toolAt(rel, 4), [0, 0, 1], 'a probe is drawn to its target');
  assert.deepEqual(toolAt(rel, 6), [0, 0, 12], 'G10 L20: the tip now reads 12');
  assert.match(toolpathOf(['G20', 'G0 Z1']).stopped ?? '', /Line 1: G20/);
});

/* ── RunChat.tsx ───────────────────────────────────────────────────────── */

test('chat: quick answers come from the page facts; the request carries no G-code and says it cannot act', () => {
  const ctx = { summary: ['Job: x'], steps: ['1. Load — now'], now: 'step 1, Load', playRefusals: ['Not ticked yet: load.'] };
  assert.equal(localAnswer('now', ctx), 'Now: step 1, Load');
  assert.match(localAnswer('play', ctx), /Not ticked yet: load/);
  const req = buildRunRequest({ endpoint: 'http://x/v1/chat/completions', model: 'm', apiKey: '', rememberKey: false, timeoutMs: 1000 }, 'what next?', ctx);
  assert.equal(req.body.messages[0].content, RUN_SYSTEM_INSTRUCTION);
  assert.match(RUN_SYSTEM_INSTRUCTION, /cannot act/);
  assert.ok(!/G0|G1|M3/.test(req.body.messages[1].content), 'no G-code in what is sent');
});

test('a tool-change resume whose cutter name is not on the machine clears the collet record (bughunt 2026-11-15)', () => {
  /* The post cuts a comment longer than grblHAL's 256-char line buffer to end in `...`, so a long
   * cutter name reaches the TOOL CHANGE stop as text that is no cutter id. `setInCollet` refused it
   * and resume (runDoor.resumeRun) dropped the refusal: the record kept naming cutter 1 while
   * cutter 2 was fitted, and the next job's loaded check passed on that. */
  const [first, second] = ['End Mill - Down-cut 6mm 2F', 'End Mill - Down-cut 3.175mm 2F'];
  const m0 = { ...simulatedMachine(T0), toolIds: [first, second], inCollet: first } as Machine;
  const reg = { version: 1 as const, machines: [m0] };
  const cut = colletAfterChange(reg, m0.id, `${second.slice(0, 5)}...`);
  assert.ok(cut.ok);
  const after = cut.ok ? cut.reg.machines[0] : m0;
  assert.equal(after.inCollet, null);
  assert.equal(loadedCheck(after, [first]).ok, false);
  // CONTROL: a name that IS one of its cutters moves the record to it.
  const named = colletAfterChange(reg, m0.id, second);
  assert.equal(named.ok ? named.reg.machines[0].inCollet : 'refused', second);
});
