// The SIMULATED machine (src/cncjob/simController.ts): the Run tab's own
// sender (startCommands → Streamer → StreamPump) against run/fake.ts.
//
// ⚠ A green here is a statement about this lane's model of grblHAL. Nothing moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_POSITION, SimSession, displayState, workPosition } from '../src/cncjob/simController.ts';
import type { StatusReport } from '../src/run/protocol.ts';
import type { RunProgram } from '../src/RunTab.tsx';

const GCODE = [
  '( test )',
  'G17 G21 G90 G54 G94 G40',
  'G0 Z5.000',
  'M3 S18000',
  'G1 Z-1.000 F300.0',
  'G0 Z5.000',
  'M5',
  '( TOOL CHANGE -> End Mill - Down-cut 3mm 2F )',
  'M0',
  'M3 S18000',
  'G1 Z-1.000 F300.0',
  'G0 Z5.000',
  'M5',
  'M30',
];

const program = (lines = GCODE): RunProgram => ({ name: 'test', lines, path: [], hash: 'x', rapidRate: 5000 });

async function until(s: SimSession, cond: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await s.tick();
  assert.ok(cond(), 'condition never reached');
}

test('the healthy persona identifies as grblHAL and names itself as a fake', async () => {
  const s = new SimSession();
  await s.connect();
  const snap = s.snapshot();
  assert.equal(snap.identified, 'grblHAL');
  assert.match(snap.describe, /NOT A MACHINE/);
});

test('Start is refused (R2) until a $H has completed on this link — the sender, not this file, refuses', async () => {
  const s = new SimSession();
  await s.connect();
  await s.tick();
  const r = s.start('j1', 'cut', program());
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.refusals.some((x) => x.startsWith('R2')), r.refusals.join(' | '));
});

test('a homed simulated machine streams, stops at the M0 with the tool-change prompt, resumes and finishes', async () => {
  const s = new SimSession();
  let ended: string | null = null;
  s.onEnded((_id, how) => (ended = how));
  await s.connect();
  await s.home();
  await until(s, () => s.snapshot().homed);
  const r = s.start('j1', 'cut', program());
  assert.deepEqual(r, { ok: true });
  assert.equal(s.snapshot().state, 'Run', 'the sender is streaming and the fake reports Idle');
  await until(s, () => s.snapshot().pause !== null);
  const p = s.snapshot().pause!;
  assert.equal(p.kind, 'tool');
  assert.equal(p.cutter, 2);
  assert.equal(GCODE[p.line], 'M0');
  assert.match(s.snapshot().state, /Hold/);
  // Held: further ticks execute nothing.
  const acked = s.snapshot().stream!.acked;
  for (let i = 0; i < 10; i++) await s.tick();
  assert.equal(s.snapshot().stream!.acked, acked, 'lines executed while held at M0');
  assert.deepEqual(await s.resume(), []);
  await until(s, () => ended !== null);
  assert.equal(ended, 'done');
});

test('feed hold stops execution; abort ends the stream and position must be re-homed', async () => {
  const s = new SimSession();
  let ended: string | null = null;
  s.onEnded((_id, how) => (ended = how));
  s.linesPerTick = 1;
  await s.connect();
  await s.home();
  await until(s, () => s.snapshot().homed);
  assert.equal(s.start('j1', 'cut', program()).ok, true);
  await s.tick();
  await s.feedHold();
  const acked = s.snapshot().stream!.acked;
  for (let i = 0; i < 5; i++) await s.tick();
  assert.equal(s.snapshot().stream!.acked, acked);
  await s.abort('test abort');
  assert.equal(ended, 'aborted');
  assert.equal(s.snapshot().homed, false);
});

test('R3 still refuses a descent: a tool above the first Z is refused by the sender', async () => {
  // The fake's own default position: work Z 20, so G0 Z5 is a 15 mm rapid descent.
  const s = new SimSession({});
  await s.connect();
  await s.home();
  await until(s, () => s.snapshot().homed);
  const r = s.start('j1', 'cut', program());
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.refusals.some((x) => x.startsWith('R3')), r.refusals.join(' | '));
});

test('displayState: Run only while the sender streams and the controller says Idle', () => {
  assert.equal(displayState('Idle', true), 'Run');
  assert.equal(displayState('Idle', false), 'Idle');
  assert.equal(displayState('Hold', true), 'Hold');
  assert.equal(displayState('Alarm', true), 'Alarm');
});

test('a program the sender cannot encode is refused BEFORE the first byte, naming the line', async () => {
  const s = new SimSession();
  await s.connect();
  await s.home();
  await until(s, () => s.snapshot().homed);
  const lines = [...GCODE];
  lines.splice(2, 0, '( Z zero from touch plate _Z only — this plate references no X or Y_ )');
  const r = s.start('j1', 'cut', program(lines));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.refusals[0], /cannot send line 3 .*U\+2014/);
  assert.equal(s.snapshot().stream, null, 'nothing started');
  assert.equal((s.fake as unknown as { executed: string[] }).executed.filter((l) => l.startsWith('G0')).length, 0, 'no motion line reached the controller');
});

test('our own lines are charged to our count: R14 neither fires on them nor goes blind (through a run)', async () => {
  // connect() asks for a full report while `$I` still sits unexecuted in the
  // buffer; if that line is not charged to OUR count, the watch later sees the
  // free figure rise and calls it a foreign writer (found by journey J9b).
  const s = new SimSession();
  let ended: string | null = null;
  s.onEnded((_id, how) => (ended = how));
  await s.connect();
  // The page's 50 ms ticker can poll while one of our own lines is still unexecuted.
  const priv = s as unknown as { write(l: string): Promise<void>; realtime(b: number): Promise<void> };
  await priv.write('$I');
  await priv.realtime(0x87);
  s.fake.execute();
  await s.home();
  await until(s, () => s.snapshot().homed);
  assert.equal(s.start('j1', 'aircut', program()).ok, true);
  await until(s, () => s.snapshot().pause !== null);
  await s.resume();
  await until(s, () => ended !== null);
  const watch = (s as unknown as { watch: { quiescentSamples: number; verdict: string } }).watch;
  const before = watch.quiescentSamples;
  for (let i = 0; i < 5; i++) await s.tick();
  assert.deepEqual(s.snapshot().refusals.map((r) => `${r.id}: ${r.fact}`), []);
  // And the watch is still CHECKING, not blinded: uncharged writes make our count
  // 'unknown', which silences R14 instead of satisfying it.
  assert.equal(watch.verdict, 'no-disagreement');
  assert.ok(watch.quiescentSamples > before, `the port-ownership watch took no sample (${before} → ${watch.quiescentSamples})`);
  assert.equal(s.start('j1', 'cut', program()).ok, true, 'the second run is not refused');
});

test('🔴 a Jobs-page stream that aborts on an error sends a feed hold, as the Run tab does', async () => {
  /* An `error:` abort stops the SENDER; grblHAL keeps running its buffer with
   * the spindle on. The Run tab answers with `!`; this session did not, so the
   * job book said "aborted" while the controller sat with the spindle turning. */
  const s = new SimSession({ ...SIM_POSITION, rejectLine: { index: 10, code: 20 } });
  await s.connect();
  await s.home();
  for (let i = 0; i < 200 && s.fake.machineState !== 'Idle'; i++) await s.tick(50);
  await s.tick(50);
  const realtime: number[] = [];
  const write = s.fake.write.bind(s.fake);
  s.fake.write = async (b: Uint8Array) => {
    if (b.length === 1) realtime.push(b[0]);
    return write(b);
  };
  let ended: string | null = null;
  s.onEnded((_id, how) => {
    ended = how;
  });
  const lines = ['G21 G90', 'G0 Z5', 'M3 S12000', 'G4 P1'];
  for (let i = 0; i < 40; i++) lines.push(`G1 X${i} Y${i} Z-1 F600`);
  lines.push('G0 Z5', 'M5', 'M30');
  const r = s.start('j1', 'cut', { name: 't', lines, path: [], hash: 'h', rapidRate: 3000 } as unknown as RunProgram);
  assert.equal(r.ok, true);
  for (let i = 0; i < 30; i++) await s.tick(50);
  assert.equal(ended, 'aborted', 'the planted rejection did not abort the stream');
  assert.ok(realtime.includes(0x21), 'no feed hold after an error abort');
});

// 🔴 bughunt 2026-11-15: the run view drew the tool at the last ACKNOWLEDGED line. A real grblHAL
// acknowledges a line as it enters the planner, so the drawn tool led the cutter by a planner's worth
// of moves. The view now draws the position the controller reports; these pin the conversion.
const rep = (kind: 'MPos' | 'WPos', position: number[], wco: number[] | null = null) =>
  ({ positionKind: kind, position, wco }) as unknown as StatusReport;

test('workPosition: WPos is taken as sent; MPos is converted with the report WCO, else the last one', () => {
  assert.deepEqual(workPosition(rep('WPos', [1, 2, 3]), [9, 9, 9]), [1, 2, 3]);
  assert.deepEqual(workPosition(rep('MPos', [-90, -190, -20], [-100, -200, -25]), null), [10, 10, 5]);
  assert.deepEqual(workPosition(rep('MPos', [-90, -190, -20]), [-100, -200, -25]), [10, 10, 5]);
});

test('workPosition: no position, or MPos with no WCO ever seen, is null — never a guess at 0,0,0', () => {
  assert.equal(workPosition(null, null), null);
  assert.equal(workPosition(rep('MPos', [-90, -190, -20]), null), null);
  assert.equal(workPosition({ positionKind: null, position: null, wco: null } as unknown as StatusReport, null), null);
});

test('a homed simulated machine reports a work position in its snapshot', async () => {
  const s = new SimSession();
  await s.connect();
  await s.home();
  await until(s, () => s.snapshot().homed && s.snapshot().work !== null);
  const w = s.snapshot().work!;
  assert.equal(w.length, 3);
  assert.ok(w.every((v) => Number.isFinite(v)), String(w));
});
