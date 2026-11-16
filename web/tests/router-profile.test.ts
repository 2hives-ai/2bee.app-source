// The router analysis (src/run/routerProfile.ts): parse grblHAL's report
// replies, flag what is unset, and turn the operator's measurements into
// verdicts. Line formats are from the grblHAL source on this machine
// (~/apps/grblHAL/STM32F4xx/grbl: report.c:416-427, 520-546, 357-369, 864-1100;
// defaults config.h:2253-2389). NEVER observed from our router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSE_COMMANDS,
  analyse,
  profileOf,
  measurementsFor,
  verdictFor,
  pinsSeen,
} from '../src/run/routerProfile.ts';

/** A configured machine, as grblHAL would print it. */
const CONFIGURED = [
  '[VER:1.1f.20260811:]',
  '[OPT:VNMHTL,35,1024,3,0]',
  '[AXS:3:XYZ]',
  '[NEWOPT:ENUMS,RT+,HOME,PROBES=1,TC]',
  '[FIRMWARE:grblHAL]',
  'ok',
  '$20=1', '$21=1', '$22=1',
  '$30=24000.000', '$31=0.000',
  '$100=400.00000', '$101=400.00000', '$102=400.00000',
  '$110=6000.000', '$111=6000.000', '$112=1500.000',
  '$120=300.000', '$121=300.000', '$122=150.000',
  '$130=1250.000', '$131=670.000', '$132=90.000',
  '$481=0',
  'ok',
  '[G54:-600.000,-300.000,-40.000]',
  '[G28:0.000,0.000,0.000]',
  '[G92:0.000,0.000,0.000]',
  '[HOME:0.000,0.000,0.000:7]',
  '[TLO:0.000,0.000,12.500]',
  '[PRB:0.000,0.000,-41.200:1]',
  'ok',
  '[PIN:PB10,X limit min]',
  '[PIN:PE12,Y limit min]',
  '[PIN:PG8,Z limit max]',
  '[PIN:PA1,Probe]',
  'ok',
];

/** A board straight out of the firmware build. */
const DEFAULTS = [
  '[NEWOPT:ENUMS,RT+,NOPROBE]',
  '$20=0', '$21=0', '$22=0',
  '$100=250.00000', '$101=250.00000', '$102=250.00000',
  '$130=200.000', '$131=200.000', '$132=200.000',
];

test('only bare report commands are sent — none of them may carry "="', () => {
  assert.deepEqual([...ANALYSE_COMMANDS], ['$I', '$$', '$#', '$PINS']);
  // `$I=text` overwrites build info and `$N=V` stores a setting (system.c:643).
  for (const c of ANALYSE_COMMANDS) assert.ok(!c.includes('='), c);
});

test('a configured machine parses into a profile with no stop flags', () => {
  const a = analyse(CONFIGURED);
  assert.equal(a.tlo, 12.5, 'tool length is the Z of [TLO:x,y,z]');
  assert.deepEqual(a.probe, { at: [0, 0, -41.2], ok: true });
  assert.deepEqual(a.offsets.get('G54'), [-600, -300, -40]);
  const p = profileOf(a);
  assert.deepEqual(p.travel, { X: 1250, Y: 670, Z: 90 });
  assert.deepEqual(p.stepsPerMm, { X: 400, Y: 400, Z: 400 });
  assert.deepEqual(p.spindleRpm, { min: 0, max: 24000 });
  assert.equal(p.homing, true);
  assert.equal(p.probeWired, true);
  assert.deepEqual(p.flags.filter((f) => f.level === 'stop'), []);
});

test('a board on firmware defaults is flagged, and the flags say why', () => {
  const p = profileOf(analyse(DEFAULTS));
  const text = p.flags.map((f) => `${f.level}:${f.text}`).join('\n');
  assert.match(text, /stop:Homing is off/);
  assert.match(text, /stop:Steps per mm are the firmware default/);
  assert.match(text, /check:Travel is the firmware default/);
  assert.match(text, /check:Soft limits are off/);
  assert.equal(p.probeWired, false, 'NOPROBE in NEWOPT means no probe, whatever $PINS says');
});

test('nothing read is a stop, not an empty-but-clean profile', () => {
  const p = profileOf(analyse(['ok', '<Idle|MPos:0,0,0>']));
  assert.equal(p.flags.length, 1);
  assert.equal(p.flags[0].level, 'stop');
});

test('$21 is a bitmask: strict mode alone does not count as enabled', () => {
  assert.equal(profileOf(analyse(['$21=2'])).hardLimits, false);
  assert.equal(profileOf(analyse(['$21=3'])).hardLimits, true);
});

test('measurements: homing is skipped when off, spindle when no range, distance check per axis', () => {
  const ids = (lines: string[]) => measurementsFor(profileOf(analyse(lines))).map((m) => m.id);
  assert.deepEqual(ids(CONFIGURED), ['switches', 'homing', 'travel', 'stepsX', 'stepsY', 'stepsZ', 'spoilboard', 'collet', 'spindle']);
  const d = ids(DEFAULTS);
  assert.ok(!d.includes('homing') && !d.includes('spindle'));
  // Every measurement says what AND how.
  for (const m of measurementsFor(profileOf(analyse(CONFIGURED)))) {
    assert.ok(m.what.length > 10 && m.how.length > 0, m.id);
  }
});

test('distance check computes the corrected steps per mm and never sends it', () => {
  const p = profileOf(analyse(CONFIGURED));
  const m = measurementsFor(p).find((x) => x.id === 'stepsX')!;
  assert.equal(verdictFor(m, p, {}).status, 'pending');
  assert.equal(verdictFor(m, p, { movedX: 100.1 }).status, 'ok');
  const v = verdictFor(m, p, { movedX: 98 });
  assert.equal(v.status, 'adjust');
  assert.match(v.text, /\$100=408\.163 \(now 400\)/);
  assert.match(v.text, /Type it in the console yourself/);
});

test('travel: reaching less than the setting is a STOP (the machine is allowed past what it can do)', () => {
  const p = profileOf(analyse(CONFIGURED));
  const m = measurementsFor(p).find((x) => x.id === 'travel')!;
  assert.equal(verdictFor(m, p, { travelX: -1250, travelY: -670, travelZ: -90 }).status, 'ok');
  assert.equal(verdictFor(m, p, { travelX: -1180, travelY: -670, travelZ: -90 }).status, 'stop');
  assert.equal(verdictFor(m, p, { travelX: -1260, travelY: -670, travelZ: -90 }).status, 'adjust');
});

test('spoilboard flatness and live switch check', () => {
  const p = profileOf(analyse(CONFIGURED));
  const board = measurementsFor(p).find((x) => x.id === 'spoilboard')!;
  assert.equal(verdictFor(board, p, { board0: 18, board1: 18.1, board2: 18.05, board3: 17.95 }).status, 'ok');
  assert.equal(verdictFor(board, p, { board0: 18, board1: 18.6, board2: 18, board3: 18 }).status, 'adjust');
  const sw = measurementsFor(p).find((x) => x.id === 'switches')!;
  let seen = '';
  for (const pn of ['X', null, 'YZ']) seen = pinsSeen(seen, pn);
  assert.equal(verdictFor(sw, p, {}, seen).status, 'pending', 'P not seen yet');
  assert.equal(verdictFor(sw, p, {}, pinsSeen(seen, 'P')).status, 'ok');
});
