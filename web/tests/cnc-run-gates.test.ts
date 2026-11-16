/**
 * cnc pre-run gates (src/cnc/runGates.ts). Every gate is driven to FAIL by a
 * planted defect and to PASS by a clean input; PENDING never lets Run through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayRun, mayTest, runGates, type GateInput } from '../src/cnc/runGates.ts';

const CLEAN: GateInput = {
  plan: { ok: true, refusals: [], fixtureFindings: [] },
  clampCount: 2,
  holdDownCount: 0,
  confirmedClear: false,
  jobToolIds: ['em6'],
  ownedToolIds: ['em6'],
  material: 'Plywood',
  materialLibrary: ['Plywood', 'MDF'],
  thicknessMm: 18,
  machine: { name: 'cnc-sim', check: 'simulated' },
};
const state = (i: GateInput, id: string) => runGates(i).find((g) => g.id === id)!.state;

test('a clean job passes every gate and may run', () => {
  const g = runGates(CLEAN);
  assert.deepEqual(g.map((x) => x.state), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(mayRun(g), true);
});

test('PLANT: each defect fails its own gate and blocks Run', () => {
  const plants: [string, Partial<GateInput>][] = [
    ['plan', { plan: { ok: false, refusals: ['move outside X travel: -3'], fixtureFindings: [] } }],
    ['outline', { plan: { ok: true, refusals: [], fixtureFindings: [], notes: ['6 contour(s) did not close and were NOT cut — an unclosed outline cannot be profiled'] } }],
    ['hold', { clampCount: 0, holdDownCount: 0 }],
    ['hold', { clampCount: 0, holdDownCount: 1, confirmedClear: false }],
    ['hold', { plan: { ok: true, refusals: [], fixtureFindings: ['Undeclared'] } }],
    ['fixture', { plan: { ok: false, refusals: [], fixtureFindings: ['CutsClamp { clamp: "toggle-clamp-vertical-2", x: 378.1, y: 85.0 }'] } }],
    ['cutters', { ownedToolIds: [] }],
    ['material', { material: 'Unobtainium' }],
    ['material', { thicknessMm: 0 }],
    ['machine', { machine: { name: 'cnc-01', check: 'unreachable' } }],
    ['machine', { machine: null }],
  ];
  for (const [id, p] of plants) {
    const i = { ...CLEAN, ...p };
    assert.equal(state(i, id), 'FAIL', `${id} did not fail on ${JSON.stringify(p)}`);
    assert.equal(mayRun(runGates(i)), false);
  }
});

test('the founder\'s clamp refusal fails the FIXTURE gate (not the plan gate) and says it in words', () => {
  const i = { ...CLEAN, plan: { ok: false, refusals: [], fixtureFindings: ['CutsClamp { clamp: "toggle-clamp-vertical-2", x: 378.1, y: 85.0 }'] } };
  const g = runGates(i);
  assert.equal(g.find((x) => x.id === 'plan')!.state, 'PASS');
  assert.match(g.find((x) => x.id === 'fixture')!.why, /cut passes through clamp "toggle-clamp-vertical-2"/);
});

test('PENDING is not a pass: nothing planned / machine untested / material list not loaded block Run', () => {
  for (const p of [{ plan: null }, { machine: { name: 'cnc-01', check: 'untested' as const } }, { materialLibrary: null }, { jobToolIds: [] }]) {
    const g = runGates({ ...CLEAN, ...p });
    assert.ok(g.some((x) => x.state === 'PENDING'), JSON.stringify(p));
    assert.equal(mayRun(g), false);
  }
});

test('Test is allowed while only the machine is pending, refused when another gate fails', () => {
  assert.equal(mayTest(runGates({ ...CLEAN, machine: { name: 'cnc-01', check: 'untested' } })), true);
  assert.equal(mayTest(runGates({ ...CLEAN, clampCount: 0 })), false);
});

test('a clamp-free hold-down passes only with the PERSON\'s confirmation, and asks for it', () => {
  const unconfirmed = runGates({ ...CLEAN, clampCount: 0, holdDownCount: 1, confirmedClear: false }).find((g) => g.id === 'hold')!;
  assert.equal(unconfirmed.state, 'FAIL');
  assert.equal(unconfirmed.confirm, true);
  assert.equal(state({ ...CLEAN, clampCount: 0, holdDownCount: 1, confirmedClear: true }, 'hold'), 'PASS');
});

test('G-FIXTURE on a job whose clamps move: PASS says it was checked per phase and how many clamps move', () => {
  const g = runGates({ ...CLEAN, clampPhases: { phases: 2, moves: 1, stops: '1 cutter change · 1 clamp move' } }).find((x) => x.id === 'fixture')!;
  assert.equal(g.state, 'PASS');
  assert.match(g.why, /each of the 2 clamp phases/);
  assert.match(g.why, /stops 1 time\(s\) for you to move 1 clamp\(s\)/);
  // A fixture finding still FAILS it, phases or not.
  const bad = runGates({
    ...CLEAN,
    plan: { ok: false, refusals: [], fixtureFindings: ['CutsClamp { clamp: "c1", x: 17.0, y: 143.0 }'] },
    clampPhases: { phases: 2, moves: 1 },
  }).find((x) => x.id === 'fixture')!;
  assert.equal(bad.state, 'FAIL');
});

test('G-FIXTURE lists the no-probe clamp warning and still PASSES (a stated warning, not a failure)', () => {
  const w = 'Z not re-checked after the clamp move - do not touch the spindle or the cutter while moving the clamp';
  const g = runGates({ ...CLEAN, clampPhases: { phases: 2, moves: 1, warnings: [w] } }).find((x) => x.id === 'fixture')!;
  assert.equal(g.state, 'PASS');
  assert.ok(g.why.includes(`Warning: ${w}.`), g.why);
});
