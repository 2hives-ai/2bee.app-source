// Tests for the grblHAL protocol core and the fake controller that exercises it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// `npm run test:node`. No browser, no bundler, no serial port, no machine.
//
// ✅ EXERCISED, by the real modules: `LineAssembler` reassembles lines from
// chunk boundaries the fake really chose; `classifyInbound` and
// `parseStatusReport` read report text the fake really built from a `$10` mask;
// `Streamer` counts characters against an RX buffer the fake really enforces and
// really overruns; every refusal is evaluated by `refusalsFor`. Bytes cross the
// `Link` seam in both directions in the streaming tests — nothing is stubbed
// above the byte boundary, because a fake that handed the parser parsed objects
// would vouch for the one layer it replaced.
//
// ✅ EVERY PLANT IN `PROTOCOL_PLANTS` IS DRIVEN, and each is paired with the
// unplanted run of the same assertion. The four the brief names specifically —
// `WCO` assumed present, an alarm that loses position treated as one that
// retains it, the character-counting allowance off by one, and a refusal that
// fires on the wrong state — are each watched red below.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//
//   · **A CONTROLLER.** Everything here is measured against `fake.ts`, which is
//     this lane's model of grblHAL written from the same reading of grblHAL that
//     `protocol.ts` was written from. A green means the sender agrees with our
//     reading. It cannot mean the reading is right. `gates/controller/` holds
//     the transcripts that would say anything else and **is empty today** — it
//     contains a README and no transcript at all, so there is no recorded
//     controller behaviour in this repo to test the parser against. The design's
//     rungs 2–3 are what fill it.
//   · **Web Serial.** `transport.ts` is written by other hands against the
//     `Link` seam and is not imported here. Transient activation, `getPorts()`,
//     `NetworkError` on unplug, another tab holding the port and the throttled-
//     tab throughput question (`RUN-18`, the branch that decides the
//     architecture) all need a browser and belong in `web/e2e/`.
//   · **Any pixel of `RunTab.tsx`.** There is no React renderer here. What is
//     tested is the API the screen will call.
//   · **The full grblHAL error table.** `ERRORS` carries the ~19 codes the
//     design quotes at a primary source out of 74+. The gap is asserted below
//     rather than hidden, because a partial table that looks whole is how an
//     unknown code becomes a blank box.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALARMS,
  ERRORS,
  EXCLUDED_REALTIME,
  LineAssembler,
  NOT_IMPLEMENTED_REALTIME,
  PROTOCOL_PLANTS,
  REALTIME,
  RING_ARTEFACT_CHARS,
  SOLE_OWNERSHIP_LIMIT,
  PortOwnershipWatch,
  Streamer,
  UNLOCK_REFUSAL_ORDER,
  legacyRealtimeReliability,
  wcoUnavailable,
  classifyInbound,
  decodeAccessories,
  decodeHomingConfig,
  decodePins,
  decodeReportMask,
  deriveDro,
  describeAlarm,
  describeError,
  handshakeDecision,
  identify,
  IDENTIFY_PROBE,
  initialTrackedState,
  missingFieldNote,
  motionVerdict,
  parseStatusReport,
  permitted,
  positionTrustAfterAlarm,
  positionTrustAfterReset,
  realtimeBytes,
  realtimeRefusal,
  refusalsFor,
  type TrackedState,
} from '../src/run/protocol.ts';
import { FakeController, PERSONAS, pumpStream } from '../src/run/fake.ts';

/* ── helpers ───────────────────────────────────────────────────────────────── */

const enc = (s: string) => new TextEncoder().encode(s);

/** A report parsed or the test fails loudly with the parser's own reason. */
function mustParse(line: string) {
  const { report, error } = parseStatusReport(line);
  assert.equal(error, null, `parse failed: ${error}`);
  assert.ok(report);
  return report;
}

/** 12 characters, so each line costs exactly 13 bytes on the wire. The buffer
 *  sizes below are chosen against that so the off-by-one is REACHABLE — an
 *  allowance test whose boundary is never touched proves nothing. */
const line12 = (i: number) => 'G1X' + String(i % 1000000000).padStart(9, '0');
const program = (n: number) => Array.from({ length: n }, (_, i) => line12(i));

/** A tracked state in which starting a job is permitted, so every refusal test
 *  below is a change from a KNOWN GREEN. Without this, a refusal set that
 *  refuses everything unconditionally would pass every single test. */
function readyToStart(): TrackedState {
  return {
    ...initialTrackedState(),
    tab: 'Idle',
    controllerState: 'Idle',
    controllerSubstate: null,
    identification: 'grblHAL',
    homingSeen: true,
    homingEnabled: true,
    positionTrusted: true,
    positionUntrustedWhy: null,
    wcoKnown: true,
    currentWorkZ: 5,
    programFirstZ: 5,
    programLoaded: true,
    programDirty: false,
    reportUnits: 'mm',
    streamMode: 'character-counting',
    measuredRxBuffer: 1024,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE STATUS REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

test('the minimal grbl report parses, and says which position key arrived', () => {
  const r = mustParse('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
  assert.equal(r.state, 'Idle');
  assert.equal(r.substate, null);
  assert.equal(r.positionKind, 'MPos');
  assert.deepEqual(r.position, [0, 0, 0]);
  assert.deepEqual(r.fs, { feed: 0, programmedRpm: 0, actualRpm: null });
  assert.equal(r.wco, null, 'a report with no WCO must not invent one');
});

test('every field grblHAL adds is read, and an unrecognised one is kept rather than dropped', () => {
  const r = mustParse(
    '<Run:2|MPos:1.500,-2.250,-30.000|Bf:35,1024|Ln:99|FS:1200,12000,11980|Pn:PZ|' +
      'WCO:-10.000,-20.000,-25.000|WCS:G54|Ov:80,50,110|A:SF|MPG:0|H:1,7|D:0|Sc:XYZ|' +
      'TLR:1|FW:grblHAL|In:3|SD:12.5,job.nc|DTG:0.100,0.000,0.000|Zz:novel>',
  );
  assert.equal(r.state, 'Run');
  assert.equal(r.substate, 2, 'Run:2 is the probing substate and must not be discarded');
  assert.deepEqual(r.bf, { plannerFree: 35, rxFree: 1024 });
  assert.equal(r.ln, 99);
  assert.deepEqual(r.fs, { feed: 1200, programmedRpm: 12000, actualRpm: 11980 });
  assert.equal(r.pn, 'PZ');
  assert.deepEqual(r.wco, [-10, -20, -25]);
  assert.equal(r.wcs, 'G54');
  assert.deepEqual(r.ov, { feed: 80, rapid: 50, spindle: 110 });
  assert.equal(r.a, 'SF');
  assert.equal(r.mpg, false);
  assert.deepEqual(r.homed, { all: true, mask: 7 });
  assert.equal(r.d, false);
  assert.equal(r.sc, 'XYZ');
  assert.equal(r.tlr, true);
  assert.equal(r.fw, 'grblHAL');
  assert.equal(r.in, 3);
  assert.equal(r.sd, '12.5,job.nc');
  assert.deepEqual(r.dtg, [0.1, 0, 0]);
  assert.deepEqual(r.unknownFields, ['Zz:novel'], 'a field this build has no entry for is evidence, not noise');
});

test('both $10 worlds parse: bare state words and substate-carrying ones', () => {
  assert.equal(mustParse('<Alarm|MPos:0,0,0>').substate, null);
  assert.equal(mustParse('<Alarm:5|MPos:0,0,0>').substate, 5);
  assert.equal(mustParse('<Run|MPos:0,0,0>').substate, null);
  assert.equal(mustParse('<Run:1|MPos:0,0,0>').substate, 1);
  assert.equal(mustParse('<Hold:0|MPos:0,0,0>').substate, 0);
  assert.equal(mustParse('<Hold:1|MPos:0,0,0>').substate, 1);
  assert.equal(mustParse('<Door:3|MPos:0,0,0>').substate, 3);
});

test('a WPos report and a 4-axis report both parse', () => {
  const w = mustParse('<Idle|WPos:1.000,2.000,3.000|WCO:0.000,0.000,-5.000>');
  assert.equal(w.positionKind, 'WPos');
  assert.deepEqual(w.position, [1, 2, 3]);

  const four = mustParse('<Idle|MPos:1.000,2.000,3.000,90.000|FS:0,0>');
  assert.equal(four.position?.length, 4, 'a rotary axis must not be silently truncated');
});

test('a report that arrived and could not be read is a finding, never silence', () => {
  for (const bad of [
    '<Idle|MPos:1.000,two,3.000>',
    '<Wobble|MPos:0,0,0>',
    '<Idle|Bf:35>',
    '<Idle|FS:0,0>',
    'Idle|MPos:0,0,0',
  ]) {
    const { report, error } = parseStatusReport(bad);
    assert.equal(report, null, bad);
    assert.ok(error && error.length > 0, `no reason given for ${bad}`);
  }
  const inbound = classifyInbound('<Idle|MPos:1.000,two,3.000>');
  assert.equal(inbound.kind, 'status');
  assert.equal(inbound.status, null);
  assert.ok(inbound.parseError);
});

test('pin and accessory letters decode, and an unrecognised letter is named not dropped', () => {
  const pins = decodePins('PZQ');
  assert.deepEqual(
    pins.map((p) => p.letter),
    ['P', 'Z', 'Q'],
  );
  assert.equal(pins[0].label, 'probe');
  assert.equal(pins[1].label, 'Z limit');
  assert.equal(pins[2].known, false);
  assert.match(pins[2].label, /unrecognised/);

  const acc = decodeAccessories('SF');
  assert.equal(acc[0].label, 'spindle CW');
  assert.equal(acc[1].label, 'flood coolant');
  assert.deepEqual(decodePins(null), []);
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. CLASSIFYING WHAT CAME BACK — and what may decrement the count
   ═══════════════════════════════════════════════════════════════════════════ */

test('only ok and error: are line replies', () => {
  assert.equal(classifyInbound('ok').isLineReply, true);
  assert.equal(classifyInbound('error:9').isLineReply, true);
  assert.equal(classifyInbound('error:9').code, 9);

  for (const line of [
    '<Idle|MPos:0,0,0>',
    '[MSG:Caution: Unlocked]',
    '[PRB:1.000,2.000,3.000:1]',
    "GrblHAL 1.1f ['$' or '$HELP' for help]",
    'ALARM:5',
  ]) {
    assert.equal(classifyInbound(line).isLineReply, false, `${line} must not decrement the character count`);
  }
  assert.equal(classifyInbound('ALARM:5').kind, 'alarm');
  assert.equal(classifyInbound('ALARM:5').code, 5);
  assert.equal(classifyInbound("GrblHAL 1.1f ['$']").bannerFirmware, 'GrblHAL');
  assert.equal(classifyInbound("Grbl 1.1f ['$']").bannerFirmware, 'Grbl');
});

test('PLANT count-status-as-ok — a status report scored as an acceptance', () => {
  const clean = classifyInbound('<Idle|MPos:0,0,0>');
  assert.equal(clean.isLineReply, false);
  const planted = classifyInbound('<Idle|MPos:0,0,0>', 'count-status-as-ok');
  assert.equal(planted.isLineReply, true, 'the plant must reintroduce the defect');
});

test('PLANT ignore-async-alarm — ALARM:N demoted to ordinary output', () => {
  assert.equal(classifyInbound('ALARM:3').kind, 'alarm');
  assert.equal(classifyInbound('ALARM:3', 'ignore-async-alarm').kind, 'other');
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. LINE ASSEMBLY — a read boundary falls anywhere
   ═══════════════════════════════════════════════════════════════════════════ */

test('a line split across two reads parses as one line', () => {
  const a = new LineAssembler();
  assert.deepEqual(a.push(enc('<Idle|MPos:0.0')), []);
  assert.equal(a.pending, '<Idle|MPos:0.0');
  assert.deepEqual(a.push(enc('00,0.000,0.000>\r\nok\r\n')), ['<Idle|MPos:0.000,0.000,0.000>', 'ok']);
  assert.equal(a.pending, '');
});

test('a split falling between CR and LF still yields one line, and empty lines are dropped', () => {
  const a = new LineAssembler();
  assert.deepEqual(a.push(enc('ok\r')), []);
  assert.deepEqual(a.push(enc('\nok\n\r\nok\n')), ['ok', 'ok', 'ok']);
});

test('PLANT assume-read-is-line — one read treated as one line', () => {
  const a = new LineAssembler();
  assert.deepEqual(a.push(enc('<Idle|MPos:0.0'), 'assume-read-is-line'), ['<Idle|MPos:0.0']);
  const b = new LineAssembler();
  assert.deepEqual(b.push(enc('ok\r\nerror:9\r\n'), 'assume-read-is-line'), ['ok\r\nerror:9']);
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE DRO — MPos, WPos, WCO
   ═══════════════════════════════════════════════════════════════════════════ */

test('MPos minus WCO is the work position', () => {
  const r = mustParse('<Idle|MPos:-100.000,-200.000,-5.000|WCO:-100.000,-200.000,-25.000>');
  const dro = deriveDro(r, null);
  assert.deepEqual(dro.machine.values, [-100, -200, -5]);
  assert.deepEqual(dro.work.values, [0, 0, 20]);
  assert.equal(dro.work.unavailable, null);
});

test('🔴 with no WCO the work DRO is unavailable WITH A REASON — never zero', () => {
  const r = mustParse('<Idle|MPos:-100.000,-200.000,-5.000|FS:0,0>');
  const dro = deriveDro(r, null);
  assert.deepEqual(dro.machine.values, [-100, -200, -5]);
  assert.equal(dro.work.values, null, 'a zero is a number and reads as a measurement');
  assert.match(dro.work.unavailable ?? '', /has not reported WCO/);
  assert.match(dro.work.unavailable ?? '', /0x87/);
});

test('PLANT assume-zero-wco — machine coordinates rendered in the work column', () => {
  const r = mustParse('<Idle|MPos:-100.000,-200.000,-5.000|FS:0,0>');
  const planted = deriveDro(r, null, 'assume-zero-wco');
  assert.deepEqual(planted.work.values, [-100, -200, -5]);
  assert.equal(planted.work.unavailable, null);
  assert.notDeepEqual(planted.work.values, deriveDro(r, null).work.values);
});

test('a WPos report already has the offset applied — machine is derived, work is not', () => {
  const r = mustParse('<Idle|WPos:0.000,0.000,20.000|WCO:-100.000,-200.000,-25.000>');
  const dro = deriveDro(r, null);
  assert.deepEqual(dro.work.values, [0, 0, 20], 'WPos is the work position as sent');
  assert.deepEqual(dro.machine.values, [-100, -200, -5]);
});

test('PLANT double-subtract-wco — the offset counted twice', () => {
  const r = mustParse('<Idle|WPos:0.000,0.000,20.000|WCO:-100.000,-200.000,-25.000>');
  const planted = deriveDro(r, null, 'double-subtract-wco');
  assert.deepEqual(planted.work.values, [100, 200, 45]);
  assert.notDeepEqual(planted.work.values, deriveDro(r, null).work.values);
});

test('a remembered WCO is used when the report omits it, and a stale axis count refuses', () => {
  const r = mustParse('<Idle|MPos:-100.000,-200.000,-5.000|FS:0,0>');
  assert.deepEqual(deriveDro(r, [-100, -200, -25]).work.values, [0, 0, 20]);
  const mismatched = deriveDro(r, [-100, -200]);
  assert.equal(mismatched.work.values, null);
  assert.match(mismatched.work.unavailable ?? '', /axes/);
});

test('a WPos report with no WCO leaves the MACHINE column unavailable, not the work one', () => {
  const r = mustParse('<Idle|WPos:1.000,2.000,3.000>');
  const dro = deriveDro(r, null);
  assert.deepEqual(dro.work.values, [1, 2, 3]);
  assert.equal(dro.machine.values, null);
  assert.match(dro.machine.unavailable ?? '', /WCO/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. $10 AND $22
   ═══════════════════════════════════════════════════════════════════════════ */

test('$10 has fourteen bits, and $10=1 is a different machine from $10=511', () => {
  const grbl = decodeReportMask(1);
  assert.equal(grbl.positionIsMachine, true);
  assert.equal(grbl.bufferState, false);
  assert.equal(grbl.workCoordinateOffset, false);
  assert.equal(grbl.overrides, false);
  assert.equal(grbl.feedAndSpeed, false);

  const hal = decodeReportMask(511);
  assert.equal(hal.positionIsMachine, true);
  assert.equal(hal.bufferState, true);
  assert.equal(hal.workCoordinateOffset, true);
  assert.equal(hal.overrides, true);
  assert.equal(hal.syncOnWcoChange, true);
  assert.equal(hal.alarmSubstate, false, 'bit 10 is off by default');
  assert.equal(hal.runSubstate, false, 'bit 11 is off by default');
  assert.equal(hal.reportWhileHoming, false, 'bit 12 off is why $H is silent');

  const handEdited = decodeReportMask(510);
  assert.equal(handEdited.positionIsMachine, false, '$10=510 reports WPos AND sends WCO');
  assert.equal(handEdited.workCoordinateOffset, true);
});

test('a missing capability is named, not rendered as a blank', () => {
  const grbl = decodeReportMask(1);
  assert.match(missingFieldNote('Bf', grbl) ?? '', /bit 1 is clear/);
  assert.match(missingFieldNote('WCO', grbl) ?? '', /not derivable at all/);
  assert.match(missingFieldNote('Ov', grbl) ?? '', /asserting a state they cannot see/);
  assert.equal(missingFieldNote('Bf', decodeReportMask(511)), null);
});

test('$22 is a bitfield: the two bits that make the controller’s homing lock optional', () => {
  const strict = decodeHomingConfig(5);
  assert.equal(strict.enabled, true);
  assert.equal(strict.initLock, true);
  assert.equal(strict.overrideLocks, false);

  const loose = decodeHomingConfig(1 | 64);
  assert.equal(loose.enabled, true);
  assert.equal(loose.initLock, false, 'no init lock: the machine boots to Idle unhomed');
  assert.equal(loose.overrideLocks, true, 'a soft reset drops the homing lock on this config');
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. WILL IT MOVE AGAIN ON ITS OWN?
   ═══════════════════════════════════════════════════════════════════════════ */

test('the states that mean the machine may still move are modelled, not left to the caller', () => {
  assert.equal(motionVerdict('Idle', null).mayMove, false);
  assert.equal(motionVerdict('Run', null).mayMove, true);
  assert.equal(motionVerdict('Run', 2).mayMove, true);
  assert.equal(motionVerdict('Hold', 0).mayMove, false);
  assert.equal(motionVerdict('Hold', 1).mayMove, true, 'Hold:1 is still decelerating');
  assert.equal(motionVerdict('Jog', null).mayMove, true);
  assert.equal(motionVerdict('Alarm', 5).mayMove, false);
  assert.equal(motionVerdict('Door', 0).mayMove, false);
  assert.equal(motionVerdict('Door', 1).mayMove, false);
  assert.equal(motionVerdict('Door', 2).mayMove, true, 'Door:2 is a retract motion');
  assert.equal(motionVerdict('Door', 3).mayMove, true, 'Door:3 is a restore motion');
  assert.equal(motionVerdict('Check', null).mayMove, false);
  assert.equal(motionVerdict('Home', null).mayMove, true);
  assert.equal(motionVerdict('Sleep', null).mayMove, false);
  assert.equal(motionVerdict('Tool', null).mayMove, false);
});

test('an absent substate is treated as still moving, and Sleep does not guarantee position', () => {
  assert.equal(motionVerdict('Hold', null).mayMove, true);
  assert.equal(motionVerdict('Door', null).mayMove, true);
  assert.equal(motionVerdict('Sleep', null).positionGuaranteed, false);
  assert.equal(motionVerdict('Home', null).positionGuaranteed, false);
  assert.equal(motionVerdict('Idle', null).positionGuaranteed, true);
});

test('Hold:0 says the spindle is still turning, because a UI that calls it "paused" gets a hand near a cutter', () => {
  assert.match(motionVerdict('Hold', 0).why, /spindle is still turning/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. REALTIME BYTES
   ═══════════════════════════════════════════════════════════════════════════ */

test('every realtime command goes out as exactly one byte', () => {
  for (const name of Object.keys(REALTIME) as (keyof typeof REALTIME)[]) {
    const bytes = realtimeBytes(name);
    assert.equal(bytes.length, 1, `${name} must be one byte`);
    assert.equal(bytes[0], REALTIME[name].byte);
  }
  assert.deepEqual([...realtimeBytes('feedOverrideReset')], [0x90]);
  assert.deepEqual([...realtimeBytes('spindleStop')], [0x9e]);
  assert.deepEqual([...realtimeBytes('statusReportAll')], [0x87]);
  assert.deepEqual([...realtimeBytes('jogCancel')], [0x85]);
  assert.deepEqual([...realtimeBytes('reset')], [0x18]);
});

test('PLANT utf8-realtime — 0x90 encoded as the two bytes 0xC2 0x90', () => {
  const planted = realtimeBytes('feedOverrideReset', 'utf8-realtime');
  assert.deepEqual([...planted], [0xc2, 0x90]);
  assert.notEqual(planted.length, 1);
});

test('the override set runs to 0x9E and 0x98 does not exist', () => {
  assert.equal(REALTIME.spindleOverrideMinus1.byte, 0x9d);
  assert.equal(REALTIME.spindleStop.byte, 0x9e);
  const used = new Set(Object.values(REALTIME).map((c) => c.byte));
  assert.equal(used.has(0x98), false, '0x98 must not be in the command table');
  assert.match(NOT_IMPLEMENTED_REALTIME[0x98], /NOT SUPPORTED/);
  assert.deepEqual(
    [REALTIME.rapidOverride100.byte, REALTIME.rapidOverride50.byte, REALTIME.rapidOverride25.byte],
    [0x95, 0x96, 0x97],
    'rapid override has three positions, not a slider',
  );
});

test('the state-restricted realtime bytes refuse with the reason', () => {
  assert.equal(realtimeRefusal('jogCancel', 'Jog'), null);
  assert.match(realtimeRefusal('jogCancel', 'Run') ?? '', /only valid in Jog/);
  assert.match(realtimeRefusal('jogCancel', 'Run') ?? '', /FLUSHES the RX buffer/);
  assert.equal(realtimeRefusal('spindleStop', 'Hold'), null);
  assert.match(realtimeRefusal('spindleStop', 'Run') ?? '', /HOLD/);
  assert.equal(realtimeRefusal('feedHold', 'Run'), null, 'a hold must never be gated');
  assert.equal(realtimeRefusal('reset', 'Run'), null, '0x18 is allowed from any state');
  assert.equal(realtimeRefusal('statusReport', 'Alarm'), null, 'polling continues in every state');
});

test('the feed-hold entry says the spindle keeps turning, and the reset entry says what it costs', () => {
  assert.match(REALTIME.feedHold.note, /DOES NOT STOP THE SPINDLE/);
  assert.match(REALTIME.reset.note, /ALARM:3/);
  assert.match(REALTIME.statusReportAll.note, /REQUIRED, not optional/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. ALARMS AND ERRORS
   ═══════════════════════════════════════════════════════════════════════════ */

test('all 21 grblHAL alarms are carried, including the twelve grbl v1.1 does not have', () => {
  assert.equal(ALARMS.size, 21);
  for (let i = 1; i <= 21; i += 1) assert.ok(ALARMS.get(i), `alarm ${i} missing`);
  assert.equal(ALARMS.get(17)?.id, 'Alarm_MotorFault');
  assert.equal(describeAlarm(17).known, true);
});

test('🔴 alarm 2 retains position; alarms 1 and 3 lose it', () => {
  assert.equal(positionTrustAfterAlarm(2).trusted, true);
  assert.match(positionTrustAfterAlarm(2).why, /position retained/);
  assert.equal(positionTrustAfterAlarm(1).trusted, false);
  assert.match(positionTrustAfterAlarm(1).why, /likely lost/);
  assert.equal(positionTrustAfterAlarm(3).trusted, false);
  assert.equal(describeAlarm(2).action.includes('safe'), true);
  assert.match(describeAlarm(1).action, /Re-home/);
});

test('an alarm whose position consequence grblHAL does not state is NOT treated as trusted', () => {
  for (const code of [4, 5, 6, 10, 11, 17]) {
    assert.equal(positionTrustAfterAlarm(code).trusted, false, `alarm ${code}`);
  }
  assert.equal(positionTrustAfterAlarm(999).trusted, false, 'an alarm we have no entry for cannot be vouched for');
});

test('PLANT trust-after-hardlimit — a lost-position alarm treated as one that retains it', () => {
  assert.equal(positionTrustAfterAlarm(1).trusted, false);
  assert.equal(positionTrustAfterAlarm(1, 'trust-after-hardlimit').trusted, true);
  assert.equal(positionTrustAfterAlarm(3, 'trust-after-hardlimit').trusted, true);
  assert.equal(positionTrustAfterAlarm(2, 'trust-after-hardlimit').trusted, true, 'alarm 2 was already trusted');
});

test('a soft reset costs position only if the machine was moving', () => {
  assert.equal(positionTrustAfterReset('Idle', null).trusted, true);
  assert.equal(positionTrustAfterReset('Hold', 0).trusted, true);
  assert.equal(positionTrustAfterReset('Alarm', 5).trusted, true);
  assert.equal(positionTrustAfterReset('Run', null).trusted, false);
  assert.equal(positionTrustAfterReset('Jog', null).trusted, false);
  assert.equal(positionTrustAfterReset('Home', null).trusted, false);
  assert.equal(positionTrustAfterReset('Hold', 1).trusted, false, 'Hold:1 is still moving');
  assert.match(positionTrustAfterReset('Run', null).why, /no deceleration/);
});

test('an unknown alarm or error code is rendered as unknown, never swallowed', () => {
  const a = describeAlarm(99);
  assert.equal(a.known, false);
  assert.match(a.text, /does not know/);
  assert.match(a.action, /\$EA/);

  const e = describeError(1234);
  assert.equal(e.known, false);
  assert.match(e.text, /does not carry text for/);
});

test('PLANT swallow-unknown-code — a code the controller sent rendered as nothing', () => {
  assert.equal(describeAlarm(99).known, false);
  const planted = describeAlarm(99, 'swallow-unknown-code');
  assert.equal(planted.known, true);
  assert.equal(planted.text, '');
  assert.equal(describeError(1234, 'swallow-unknown-code').text, '');
});

test('the error codes a Run tab actually meets carry grblHAL’s own sentence where we have it', () => {
  assert.match(describeError(46).text, /Home machine to continue/);
  assert.match(describeError(9).text, /locked out during alarm or jog state/);
  assert.match(describeError(15).text, /Jog command has been ignored/);
  assert.equal(describeError(9).known, true);
  assert.match(describeError(15).action, /ERROR, not an alarm/);
});

test('🔴 the error table is partial, and says so rather than inventing sentences', () => {
  /* The table carries ~25 codes out of grblHAL's ~90. A code in the table with
   * no verbatim text must SAY that, not paraphrase silently.
   *
   * ⚠ The witness moved on 2026-08-11, and the reason it moved is the point.
   * This used to key on code 20, whose text was `null` because `errors.c` was
   * believed unreadable from this box. `errors.c` IS readable — 20's sentence
   * is now carried verbatim — so the null branch needed a witness that is null
   * for a reason that cannot be fixed by reading harder. Code 60 is that
   * witness: it is declared in `errors.h:93` and has NO entry in the core's
   * table at all, because the sdcard plugin registers its sentence at runtime.
   * A test whose fixture is "a gap we have not closed yet" silently stops
   * testing anything the day the gap closes. */
  assert.ok(ERRORS.size < 90, 'if this table ever reaches 90 the note in ERRORS must be updated');
  assert.equal(ERRORS.get(60)?.text, null, 'code 60 has no sentence in grblHAL\'s CORE errors.c');
  assert.match(describeError(60).text, /not carried in this build/);
  assert.equal(describeError(60).known, true, 'we know what code 60 IS; we do not carry its sentence');
  // And the sourced ones are verbatim from errors.c, not paraphrases.
  assert.equal(ERRORS.get(20)?.text, 'Unsupported or invalid g-code command found in block.');
  assert.equal(ERRORS.get(46)?.text, 'Home machine to continue.');
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. IDENTIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

test('FW:grblHAL in a full report is the strongest identification and beats a bare banner', () => {
  const v = identify(['<Idle|MPos:0,0,0|FW:grblHAL>']);
  assert.equal(v.verdict, 'grblHAL');
  assert.equal(v.permits, 'everything');
  assert.match(v.evidence, /FW:grblHAL/);
});

test('a grbl 1.1 banner is degraded to read-only, not accepted and not refused outright', () => {
  const v = identify(["Grbl 1.1f ['$' for help]", '[VER:1.1f.20201212:]', '[OPT:V,15,128]']);
  assert.equal(v.verdict, 'grbl');
  assert.equal(v.permits, 'read-only');
  assert.match(v.why, /not cosmetic/);
});

test('Marlin and silence are both "unknown", and unknown permits nothing', () => {
  const marlin = identify(['start', 'echo:Marlin 2.1.2']);
  assert.equal(marlin.verdict, 'unknown');
  assert.equal(marlin.permits, 'nothing');
  assert.match(marlin.why, /port is closed/);

  const silent = identify([]);
  assert.equal(silent.verdict, 'unknown');
  assert.equal(silent.permits, 'nothing');
});

test('PLANT accept-anything — Marlin classified as grblHAL', () => {
  assert.equal(identify(['echo:Marlin']).verdict, 'unknown');
  assert.equal(identify(['echo:Marlin'], 'accept-anything').verdict, 'grblHAL');
  assert.equal(identify([], 'accept-anything').permits, 'everything');
});

/* ── 9b. Silence is not a refusal about the board ──────────────────────────── */

test('a silent port and a board that spoke unrecognisably are DIFFERENT refusals', () => {
  /* 🔴 Both used to render the one string `nothing was received`, so a refusal
   * could not tell an operator whether to check the cable or the firmware — and
   * the silent case was described as if bytes had been examined. */
  const silent = identify([]);
  assert.equal(silent.heard, 'silence');
  assert.deepEqual(silent.received, []);
  assert.match(silent.evidence, /NOTHING arrived/);
  assert.match(silent.why, /only at power-on/, 'silence must be explained, not asserted about');

  const spoke = identify(['?? 1.4.2', 'BLACK_F407VE ready']);
  assert.equal(spoke.heard, 'speech');
  assert.deepEqual(spoke.received, ['?? 1.4.2', 'BLACK_F407VE ready']);
  assert.notEqual(spoke.evidence, silent.evidence, 'the two diagnoses must not share a string');

  // The permission is identical and stays identical. This separates the
  // DIAGNOSIS, never what the tab may do.
  assert.equal(silent.permits, 'nothing');
  assert.equal(spoke.permits, 'nothing');
});

test('an unknown verdict CARRIES the bytes it is a verdict about', () => {
  /* A refusal that describes bytes it did not keep cannot be re-read, and the
   * design's own answer to `unknown` is "show the raw bytes so a human can
   * identify it" — which needs the bytes to still exist. */
  const said = ['start', 'unrecognised 1', 'unrecognised 2'];
  const v = identify(said);
  assert.deepEqual(v.received, said);
  for (const line of said) assert.ok(v.evidence.includes(line), `${line} is not in the evidence`);
  // Every verdict carries them, not only the refusals: a green identification
  // whose bytes are unrecorded cannot be checked against a real board later.
  assert.deepEqual(identify(['<Idle|MPos:0,0,0|FW:grblHAL>']).received, [
    '<Idle|MPos:0,0,0|FW:grblHAL>',
  ]);
});

/* ── 9c. The probe is the OPERATOR's decision ──────────────────────────────── */

test('🔴 a silent board is ASKED ABOUT, not probed — the decision is handed to the operator', () => {
  const d = handshakeDecision([], { probed: false });
  assert.equal(d.action, 'ask-operator');
  assert.equal(d.verdict.permits, 'nothing', 'asking is not permitting');
  assert.deepEqual([...d.probe], [...IDENTIFY_PROBE], 'the offer must name what would go out');
  assert.match(d.why, /Nothing has been written to this port/);
  assert.match(d.why, /RESET the controller/, 'the zero-risk alternative has to be offered too');
});

test('the offer names every byte AND what it is on firmware nobody has classified', () => {
  assert.equal(IDENTIFY_PROBE.length, 3);
  assert.deepEqual(
    IDENTIFY_PROBE.map((s) => s.bytes),
    ['$I\\n', '0x87 (ONE byte, no newline)', '$$\\n']
  );
  for (const step of IDENTIFY_PROBE) {
    assert.ok(step.asks.length > 20, `${step.bytes} does not say what it asks for`);
    assert.ok(
      step.onUnknownFirmware.length > 20,
      `${step.bytes} does not say what it is on firmware that is not grblHAL`
    );
  }
  /* The `$` steps must name the worst case rather than the usual one. "`$I`
   * moves nothing" is a fact about grblHAL — the firmware the question exists to
   * establish — and quoting it as a general property is the assumption this
   * whole branch was written to remove. */
  assert.match(IDENTIFY_PROBE[0].onUnknownFirmware, /SETTING WRITE/);
  assert.match(IDENTIFY_PROBE[2].onUnknownFirmware, /same worst case/);
});

test('🔴 an unrecognised board is REFUSED without ever being asked about', () => {
  // Speech is a fact about the board, so there is nothing to ask an operator.
  for (const said of [['echo:Marlin 2.1.2'], ['ok T:23.4 /0.0'], ['garbage', 'more garbage']]) {
    const d = handshakeDecision(said, { probed: false });
    assert.equal(d.action, 'refuse', `${said[0]} must refuse outright`);
    assert.equal(d.probe.length, 0, 'a refusal may not carry an offer');
  }
});

test('the probe is offered ONCE — a second ask after a silent probe is a loop, not a question', () => {
  const first = handshakeDecision([], { probed: false });
  assert.equal(first.action, 'ask-operator');
  const after = handshakeDecision([], { probed: true });
  assert.equal(after.action, 'refuse');
  assert.match(after.why, /probe went out and the port stayed silent/);
  assert.equal(after.verdict.permits, 'nothing');
});

test('identification still ACCEPTS on unprompted evidence alone, with nothing written', () => {
  /* The whole point of listening first: a board that announces itself is
   * identified without a byte leaving this tab. */
  const banner = handshakeDecision(["GrblHAL 1.1f ['$' or '$HELP' for help]"], { probed: false });
  assert.equal(banner.action, 'accept');
  assert.equal(banner.verdict.verdict, 'grblHAL');
  assert.equal(banner.probe.length, 0);

  const grbl = handshakeDecision(["Grbl 1.1f ['$' for help]"], { probed: false });
  assert.equal(grbl.action, 'accept');
  assert.equal(grbl.verdict.permits, 'read-only', 'accepted is not the same as permitted to cut');
});

test('the accept-anything plant reaches the DECISION, not only the verdict', () => {
  /* A plant that stops at `identify` would leave the branch that acts on the
   * verdict unguarded — the failure this lane keeps finding one layer along. */
  assert.equal(handshakeDecision(['echo:Marlin'], { probed: false }).action, 'refuse');
  assert.equal(
    handshakeDecision(['echo:Marlin'], { probed: false }, 'accept-anything').action,
    'accept'
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. THE STREAMER — character counting against a MEASURED buffer
   ═══════════════════════════════════════════════════════════════════════════ */

test('🔴 character counting refuses to start without a measured buffer size', () => {
  assert.throws(
    () => new Streamer({ lines: program(3), mode: 'character-counting', rxBufferSize: null }),
    /MEASURED RX buffer size/,
  );
  // send-response needs no buffer figure at all — that is the whole fallback.
  const fallback = new Streamer({ lines: program(3), mode: 'send-response', rxBufferSize: null });
  assert.equal(fallback.total, 3);
});

test('the allowance is exact: pending + len + 1 must fit', () => {
  // 12-char lines cost 13. A 64-byte buffer holds four of them (52) and not
  // five (65). This is the boundary the off-by-one lives on.
  const s = new Streamer({ lines: program(10), mode: 'character-counting', rxBufferSize: 64 });
  assert.equal(s.nextLines().length, 4);
  assert.equal(s.pendingChars, 52);
  assert.deepEqual(s.nextLines(), [], 'nothing more fits until a reply frees room');
  s.onReply(classifyInbound('ok'));
  assert.equal(s.pendingChars, 39);
  assert.equal(s.nextLines().length, 1);
});

test('🔴 PLANT overcount — the allowance off by one, watched at the fake’s own buffer', () => {
  const s = new Streamer({
    lines: program(10),
    mode: 'character-counting',
    rxBufferSize: 64,
    plant: 'overcount',
  });
  assert.equal(s.nextLines().length, 5, 'the plant lets one more line through');
  assert.equal(s.pendingChars, 65, 'which is one byte past a 64-byte buffer');
});

test('5,000 lines against a 64-byte buffer never overrun the fake', async () => {
  const fake = new FakeController('tiny-buffer', { autoExecute: false });
  const s = new Streamer({ lines: program(5000), mode: 'character-counting', rxBufferSize: 64 });
  const out = await pumpStream(fake, s, { linesPerRound: 1 });
  assert.equal(out.stalled, false);
  assert.equal(s.state, 'done');
  assert.equal(s.complete, true);
  assert.equal(s.sent, 5000);
  assert.equal(s.acknowledged, 5000);
  assert.equal(fake.overruns, 0, 'the controller’s RX buffer was never trampled');
  assert.equal(fake.executed.length, 5000);
});

test('🔴 PLANT overcount, driven end to end — the fake records the overrun and jams', async () => {
  const fake = new FakeController('tiny-buffer', { autoExecute: false });
  const s = new Streamer({
    lines: program(5000),
    mode: 'character-counting',
    rxBufferSize: 64,
    plant: 'overcount',
  });
  const out = await pumpStream(fake, s, { linesPerRound: 1, maxRounds: 200 });
  assert.ok(fake.overruns > 0, 'the plant must overrun the buffer');
  assert.notEqual(s.state, 'done');
  assert.equal(out.stalled, true, 'an over-eager streamer deadlocks against the fake, not at the machine');
});

test('a status report arriving mid-stream decrements nothing', () => {
  const s = new Streamer({ lines: program(4), mode: 'character-counting', rxBufferSize: 1024 });
  s.nextLines();
  const before = s.pendingChars;
  s.onReply(classifyInbound('<Run|MPos:1.000,2.000,3.000|Bf:35,900>'));
  s.onReply(classifyInbound('[MSG:Pgm End]'));
  assert.equal(s.pendingChars, before);
  assert.equal(s.acknowledged, 0);
  s.onReply(classifyInbound('ok'));
  assert.equal(s.acknowledged, 1);
});

test('PLANT count-status-as-ok, at the streamer — a report acknowledges a line that was never answered', () => {
  const s = new Streamer({ lines: program(4), mode: 'character-counting', rxBufferSize: 1024 });
  s.nextLines();
  s.onReply(classifyInbound('<Run|MPos:1.000,2.000,3.000>', 'count-status-as-ok'));
  assert.equal(s.acknowledged, 1, 'the plant credits an acknowledgement nobody sent');
});

test('🔴 the first error: aborts the stream and nothing further is sent', async () => {
  // A 64-byte buffer holds four 13-byte lines, so the sender is only ever a few
  // lines ahead — which is what makes "it stopped" observable at all. Against a
  // 1024-byte buffer the whole 20-line program is legitimately on the wire
  // before the first reply comes back, and the assertion would say nothing.
  const fake = new FakeController('rejects-a-line', { autoExecute: false, rxBufferSize: 64 });
  const s = new Streamer({ lines: program(20), mode: 'character-counting', rxBufferSize: 64 });
  const out = await pumpStream(fake, s, { linesPerRound: 1 });
  assert.equal(s.state, 'aborted');
  assert.equal(s.abort?.reason, 'error');
  assert.equal(s.abort?.code, 20);
  assert.equal(s.abort?.lineNumber, 4);
  assert.match(s.abort?.message ?? '', /would be a copy of it/);
  // Everything already on the wire when the error came back is permitted — that
  // is the buffer, and it is why an abort cannot be instantaneous. What matters
  // is that nothing was sent AFTER.
  assert.ok(out.wrote.length < 20, `sent ${out.wrote.length} of 20`);
  const wroteAtAbort = out.wrote.length;
  assert.deepEqual(s.nextLines(), [], 'an aborted streamer emits nothing more');
  assert.equal(out.wrote.length, wroteAtAbort);
});

test('🔴 PLANT keep-going-past-error — and the poisoned copies show up as "findings"', async () => {
  const fake = new FakeController('rejects-a-line', { autoExecute: false });
  const s = new Streamer({
    lines: program(20),
    mode: 'character-counting',
    rxBufferSize: 1024,
    plant: 'keep-going-past-error',
  });
  const out = await pumpStream(fake, s, { linesPerRound: 1 });
  assert.equal(s.state, 'done', 'the plant streams the whole program past the rejection');
  assert.equal(out.wrote.length, 20);
  const errors = out.read.filter((l) => l.startsWith('error:'));
  assert.ok(errors.length > 1, 'grblHAL poisons every line after the first error');
  assert.deepEqual(
    new Set(errors),
    new Set(['error:20']),
    'and every one of them is a copy of the SAME code — one real finding plus N copies',
  );
});

test('🔴 an ALARM arriving between line replies aborts the stream', async () => {
  const fake = new FakeController('probe-no-contact', { autoExecute: false });
  const s = new Streamer({
    lines: ['G0 Z5', 'G38.2 Z-30 F200', 'G1 X10 F600', 'G1 Y10'],
    mode: 'character-counting',
    rxBufferSize: 1024,
  });
  const out = await pumpStream(fake, s, { linesPerRound: 1 });
  assert.equal(s.state, 'aborted');
  assert.equal(s.abort?.reason, 'alarm');
  assert.equal(s.abort?.code, 5);
  assert.match(s.abort?.message ?? '', /Probe did not contact the workpiece/);
  assert.ok(out.read.includes('ALARM:5'));
});

test('PLANT ignore-async-alarm, at the streamer — the alarm passes and the stream runs on', async () => {
  const fake = new FakeController('probe-no-contact', { autoExecute: false });
  const s = new Streamer({
    lines: ['G0 Z5', 'G38.2 Z-30 F200', 'G1 X10 F600'],
    mode: 'character-counting',
    rxBufferSize: 1024,
    plant: 'ignore-async-alarm',
  });
  await pumpStream(fake, s, { linesPerRound: 1, plant: 'ignore-async-alarm', maxRounds: 50 });
  assert.notEqual(s.abort?.reason, 'alarm', 'the plant must swallow the alarm');
});

test('send-response mode holds at most one line outstanding — the declared fallback', async () => {
  // First the arithmetic, with nothing else on the path: one line, then silence
  // until it is answered. This is what guarantees a starved planner, and it is
  // why it is the FALLBACK and not the default.
  const alone = new Streamer({ lines: program(25), mode: 'send-response', rxBufferSize: null });
  assert.equal(alone.nextLines().length, 1);
  assert.deepEqual(alone.nextLines(), [], 'nothing more until the reply arrives');
  alone.onReply(classifyInbound('ok'));
  assert.equal(alone.nextLines().length, 1);

  // Then end to end against the fake, with real replies over the Link seam.
  const fake = new FakeController('healthy', { autoExecute: false });
  const s = new Streamer({ lines: program(25), mode: 'send-response', rxBufferSize: null });
  const out = await pumpStream(fake, s, { linesPerRound: 1 });
  assert.equal(out.stalled, false);
  assert.equal(s.complete, true);
  assert.equal(out.wrote.length, 25);
  // One line per write: the round trip is the flow control.
  assert.equal(fake.writes.every((w) => [...w].filter((b) => b === 0x0a).length === 1), true);
});

test('completion is the sender’s own accounting, not the word Idle', async () => {
  const fake = new FakeController('healthy', { autoExecute: false });
  const s = new Streamer({ lines: program(30), mode: 'character-counting', rxBufferSize: 64 });
  // Stop the pump mid-program. The fake sits at `Idle` — its planner really is
  // empty — and the job is emphatically NOT done. That is the starvation case,
  // and a completion check keyed on the state word would call it finished.
  await pumpStream(fake, s, { linesPerRound: 1, maxRounds: 5 });
  assert.equal(fake.machineState, 'Idle');
  assert.ok(s.sent < 30);
  assert.equal(s.complete, false, 'Idle mid-job is the starvation case, not the completion case');
  await pumpStream(fake, s, { linesPerRound: 3 });
  assert.equal(s.complete, true);
  assert.equal(s.acknowledged, 30);
});

test('a reply with nothing outstanding is a desync, not a free acknowledgement', () => {
  const s = new Streamer({ lines: program(2), mode: 'character-counting', rxBufferSize: 1024 });
  s.onReply(classifyInbound('ok'));
  assert.equal(s.state, 'aborted');
  assert.equal(s.abort?.reason, 'desync');
});

test('stop() ends the stream with the operator’s reason attached', () => {
  const s = new Streamer({ lines: program(5), mode: 'character-counting', rxBufferSize: 1024 });
  s.nextLines();
  s.stop('the browser stopped scheduling this tab; the job was held');
  assert.equal(s.state, 'aborted');
  assert.equal(s.abort?.reason, 'stopped');
  assert.deepEqual(s.nextLines(), []);
});

/* ═══════════════════════════════════════════════════════════════════════════
   11. THE REFUSAL SET
   ═══════════════════════════════════════════════════════════════════════════ */

test('a fully-satisfied state is PERMITTED — the refusal set can go green', () => {
  assert.deepEqual(refusalsFor('start-job', readyToStart()), []);
  assert.equal(permitted('start-job', readyToStart()), true);
});

test('R1 — no homing evidence refuses, and the reason names the optional controller lock', () => {
  const s = { ...readyToStart(), homingSeen: false };
  const r = refusalsFor('start-job', s);
  assert.ok(r.some((x) => x.id === 'R1'));
  assert.match(r.find((x) => x.id === 'R1')?.why ?? '', /\$H/);
  assert.match(r.find((x) => x.id === 'R1')?.why ?? '', /optional/);
});

test('🔴 PLANT stream-unhomed — R1 and R2 both stop firing', () => {
  const s: TrackedState = {
    ...readyToStart(),
    homingSeen: false,
    positionTrusted: false,
    positionUntrustedWhy: 'hard limit',
  };
  const clean = refusalsFor('start-job', s);
  assert.ok(clean.some((x) => x.id === 'R1'));
  assert.ok(clean.some((x) => x.id === 'R2'));
  const planted = refusalsFor('start-job', s, 'stream-unhomed');
  assert.equal(planted.some((x) => x.id === 'R1' && x.fact.includes('H:1')), false);
  assert.equal(planted.some((x) => x.id === 'R2'), false);
});

test('R2 — untrusted position refuses, and says $X is not permission to cut', () => {
  const s = { ...readyToStart(), positionTrusted: false, positionUntrustedWhy: 'ALARM:1 hard limit' };
  const r = refusalsFor('start-job', s).find((x) => x.id === 'R2');
  assert.ok(r);
  assert.match(r.fact, /ALARM:1/);
  assert.match(r.why, /not permission to cut/);
});

test('🔴 R3 — a first move that descends is refused, with both numbers in the reason', () => {
  const s = { ...readyToStart(), currentWorkZ: 40, programFirstZ: 5 };
  const r = refusalsFor('start-job', s).find((x) => x.id === 'R3');
  assert.ok(r);
  assert.match(r.fact, /DESCENT of 35\.000 mm/);
  assert.match(r.why, /Jog to a safe Z/);

  // The same numbers the other way round must NOT refuse.
  assert.deepEqual(refusalsFor('start-job', { ...readyToStart(), currentWorkZ: 5, programFirstZ: 40 }), []);
});

test('🔴 R3 — an unmakeable comparison is a refusal, not a pass', () => {
  const noWco = { ...readyToStart(), wcoKnown: false, currentWorkZ: null };
  const r = refusalsFor('start-job', noWco).find((x) => x.id === 'R3');
  assert.ok(r, 'if WCO never arrived the descent check cannot be made, so it must refuse');
  assert.match(r.why, /0x87/);

  const noFirstZ = { ...readyToStart(), programFirstZ: null };
  assert.ok(refusalsFor('start-job', noFirstZ).some((x) => x.id === 'R3'));
});

test('🔴 PLANT descend-first — both R3 limbs stop firing', () => {
  const descending = { ...readyToStart(), currentWorkZ: 40, programFirstZ: 5 };
  assert.ok(refusalsFor('start-job', descending).some((x) => x.id === 'R3'));
  assert.equal(refusalsFor('start-job', descending, 'descend-first').some((x) => x.id === 'R3'), false);

  const blind = { ...readyToStart(), wcoKnown: false, currentWorkZ: null };
  assert.ok(refusalsFor('start-job', blind).some((x) => x.id === 'R3'));
  assert.equal(refusalsFor('start-job', blind, 'descend-first').some((x) => x.id === 'R3'), false);
});

test('R4 — streaming is refused unless the controller is Idle, and the reason quotes the motion verdict', () => {
  for (const state of ['Run', 'Hold', 'Jog', 'Door', 'Tool'] as const) {
    const r = refusalsFor('start-job', { ...readyToStart(), controllerState: state }).find((x) => x.id === 'R4');
    assert.ok(r, state);
    assert.match(r.fact, new RegExp(state));
  }
});

test('R5 — a program that is not what is on screen, and R12 — inch reporting', () => {
  assert.ok(refusalsFor('start-job', { ...readyToStart(), programDirty: true }).some((x) => x.id === 'R5'));
  assert.ok(refusalsFor('start-job', { ...readyToStart(), programLoaded: false }).some((x) => x.id === 'R5'));

  const inch = { ...readyToStart(), reportUnits: 'inch' as const };
  const r12 = refusalsFor('start-job', inch).find((x) => x.id === 'R12');
  assert.ok(r12);
  assert.match(r12.why, /25\.4/);
  assert.equal(
    refusalsFor('start-job', { ...inch, inchReportingAcknowledged: true }).some((x) => x.id === 'R12'),
    false,
    'an acknowledged mismatch is a decision, not a block',
  );
});

test('R13 — character counting with no measured buffer refuses, and names both wrong guesses', () => {
  const s = { ...readyToStart(), measuredRxBuffer: null };
  const r = refusalsFor('start-job', s).find((x) => x.id === 'R13');
  assert.ok(r);
  assert.match(r.why, /128/);
  assert.match(r.why, /1024/);
  assert.equal(
    refusalsFor('start-job', { ...s, streamMode: 'send-response' }).some((x) => x.id === 'R13'),
    false,
    'send-response is the declared fallback and needs no measurement',
  );
});

test('R6 — jogging is refused while streaming or held, and in Alarm', () => {
  assert.ok(refusalsFor('jog', { ...readyToStart(), tab: 'Streaming' }).some((x) => x.id === 'R6'));
  assert.ok(refusalsFor('jog', { ...readyToStart(), tab: 'Held' }).some((x) => x.id === 'R6'));
  assert.ok(
    refusalsFor('jog', { ...readyToStart(), controllerState: 'Alarm' }).some((x) => x.id === 'R6'),
  );
  assert.deepEqual(
    refusalsFor('jog', { ...readyToStart(), tab: 'Paused' }),
    [],
    'jogging at a tool-change pause is a legitimate need and is permitted',
  );
});

test('🔴 R7 — 0x85 outside Jog is refused, because it flushes the controller’s RX buffer', () => {
  for (const state of ['Idle', 'Run', 'Hold', 'Alarm'] as const) {
    const r = refusalsFor('jog-cancel', { ...readyToStart(), controllerState: state }).find(
      (x) => x.id === 'R7',
    );
    assert.ok(r, state);
    assert.match(r.why, /flushes the RX buffer/);
  }
  assert.deepEqual(refusalsFor('jog-cancel', { ...readyToStart(), controllerState: 'Jog' }), []);
});

test('🔴 PLANT cancel-while-streaming — R7 fires on the wrong state (never)', () => {
  const s = { ...readyToStart(), controllerState: 'Run' as const };
  assert.ok(refusalsFor('jog-cancel', s).some((x) => x.id === 'R7'));
  assert.deepEqual(refusalsFor('jog-cancel', s, 'cancel-while-streaming'), []);
});

test('R8 — 0x9E outside Hold is refused rather than silently ignored', () => {
  const r = refusalsFor('spindle-stop', { ...readyToStart(), controllerState: 'Run' }).find(
    (x) => x.id === 'R8',
  );
  assert.ok(r);
  assert.match(r.why, /silently does nothing is worse/);
  assert.deepEqual(refusalsFor('spindle-stop', { ...readyToStart(), controllerState: 'Hold' }), []);
});

test('🔴 R9 — $X is refused where grblHAL would refuse it, with the actual next step', () => {
  const homing = { ...readyToStart(), lastUnlockError: 46 };
  const r = refusalsFor('unlock', homing).find((x) => x.id === 'R9');
  assert.ok(r);
  assert.match(r.why, /Run \$H/);
  assert.match(r.why, /not stuck and nothing is broken/);

  for (const field of ['estopAsserted', 'doorAjar', 'limitsEngaged'] as const) {
    assert.ok(refusalsFor('unlock', { ...readyToStart(), [field]: true }).some((x) => x.id === 'R9'), field);
  }
  assert.deepEqual(refusalsFor('unlock', readyToStart()), []);
});

test('PLANT unlock-optimism — the error:46 refusal disappears', () => {
  const s = { ...readyToStart(), lastUnlockError: 46 };
  assert.ok(refusalsFor('unlock', s).some((x) => x.id === 'R9'));
  assert.deepEqual(refusalsFor('unlock', s, 'unlock-optimism'), []);
});

test('R10 — resume is refused after an abort or in Alarm', () => {
  assert.ok(refusalsFor('resume', { ...readyToStart(), tab: 'Aborted' }).some((x) => x.id === 'R10'));
  assert.ok(
    refusalsFor('resume', { ...readyToStart(), controllerState: 'Alarm' }).some((x) => x.id === 'R10'),
  );
  assert.deepEqual(refusalsFor('resume', { ...readyToStart(), tab: 'Held', controllerState: 'Hold' }), []);
});

test('R11 — auto-resume is refused always, and PLANT auto-resume removes it', () => {
  const s = { ...readyToStart(), reconnectedMidJob: true };
  const r = refusalsFor('auto-resume', s).find((x) => x.id === 'R11');
  assert.ok(r);
  assert.match(r.why, /buffer-full/);
  assert.deepEqual(refusalsFor('auto-resume', s, 'auto-resume'), []);
  assert.ok(refusalsFor('auto-resume', readyToStart()).length > 0, 'not offered even without a drop');
});

test('the console refuses g-code, because it would bypass every preflight above', () => {
  const r = refusalsFor('console-gcode', readyToStart());
  assert.equal(r.length, 1);
  assert.match(r[0].why, /no preflight/);
});

test('every refusal carries a fact AND a route forward', () => {
  const broken: TrackedState = {
    ...initialTrackedState(),
    programLoaded: true,
    reportUnits: 'inch',
    streamMode: 'character-counting',
  };
  const all = refusalsFor('start-job', broken);
  assert.ok(all.length >= 5, 'a state this bad must produce several refusals, not the first one');
  for (const r of all) {
    assert.ok(r.fact.length > 10, `${r.id} has no fact`);
    assert.ok(r.why.length > 20, `${r.id} has no route forward`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   12. THE FAKE ITSELF — it must be able to behave badly
   ═══════════════════════════════════════════════════════════════════════════ */

/** Collect everything a fake says, through the real assembler. */
function listen(fake: FakeController): string[] {
  const lines: string[] = [];
  const asm = new LineAssembler();
  fake.onData((chunk) => {
    for (const l of asm.push(chunk)) lines.push(l);
  });
  return lines;
}

test('the fake names itself, with the configuration a gate has to print', () => {
  const fake = new FakeController('mask-1');
  const d = fake.describe();
  assert.match(d, /persona=mask-1/);
  assert.match(d, /\$10=1/);
  assert.match(d, /rx=1024B/);
  assert.match(d, /NOT A MACHINE/);
  for (const p of PERSONAS) {
    assert.match(new FakeController(p).describe(), new RegExp(`persona=${p}`));
  }
});

test('the healthy persona: banner, $I, $$, and a full report that carries FW:grblHAL', async () => {
  const fake = new FakeController('healthy');
  const said = listen(fake);
  assert.match(said[0], /^GrblHAL 1\.1f/);

  await fake.write(enc('$I\n'));
  assert.ok(said.some((l) => l.startsWith('[VER:')));
  assert.ok(said.some((l) => l.startsWith('[OPT:')));

  await fake.write(enc('$$\n'));
  assert.ok(said.includes('$10=511'));
  assert.ok(said.includes('$22=5'));

  await fake.write(realtimeBytes('statusReportAll'));
  const full = said.find((l) => l.startsWith('<') && l.includes('FW:grblHAL'));
  assert.ok(full, '0x87 must produce the full report');
  const r = mustParse(full);
  assert.equal(r.fw, 'grblHAL');
  assert.deepEqual(r.homed, { all: true, mask: null });
  assert.ok(r.wco, 'a full report carries WCO');
  assert.ok(r.bf, 'and Bf, which is where the buffer size is measured');
  assert.equal(r.bf?.rxFree, 1024);
});

test('🔴 WCO is change-only: a tab that only sends ? waits, and 0x87 is what forces it', async () => {
  const fake = new FakeController('healthy', { wcoRefreshCount: 10 });
  const said = listen(fake);
  // The first report carries WCO (the counter starts due), the next nine do not.
  for (let i = 0; i < 10; i += 1) await fake.write(realtimeBytes('statusReport'));
  const reports = said.filter((l) => l.startsWith('<'));
  assert.equal(reports.length, 10);
  assert.ok(reports[0].includes('WCO:'), 'first report after connect');
  const withoutWco = reports.slice(1, 10).filter((l) => !l.includes('WCO:'));
  assert.equal(withoutWco.length, 9, 'WCO is withheld between refreshes');

  const before = said.length;
  await fake.write(realtimeBytes('statusReportAll'));
  assert.ok(said[before].includes('WCO:'), '0x87 forces it immediately');
});

test('🔴 the $10=1 persona genuinely omits the fields the mask clears', async () => {
  const fake = new FakeController('mask-1');
  const said = listen(fake);
  await fake.write(realtimeBytes('statusReport'));
  const report = said.find((l) => l.startsWith('<'));
  assert.ok(report);
  const r = mustParse(report);
  assert.equal(r.positionKind, 'MPos');
  assert.equal(r.wco, null, 'under $10=1 there is no WCO AT ALL');
  assert.equal(r.bf, null, 'so character counting cannot be calibrated');
  assert.equal(r.fs, null);
  assert.equal(r.ov, null);

  // And the DRO must therefore refuse the work column rather than show zeros.
  const dro = deriveDro(r, null);
  assert.equal(dro.work.values, null);
  assert.deepEqual(dro.machine.values, r.position);
});

test('the WPos persona reports the work position directly, with WCO still sent', async () => {
  const fake = new FakeController('wpos-reporting');
  const said = listen(fake);
  await fake.write(realtimeBytes('statusReportAll'));
  const r = mustParse(said.find((l) => l.startsWith('<')) as string);
  assert.equal(r.positionKind, 'WPos');
  assert.ok(r.wco);
  const dro = deriveDro(r, null);
  assert.deepEqual(dro.work.values, [0, 0, 20]);
  assert.deepEqual(dro.machine.values, [-100, -200, -5]);
});

test('🔴 the alarm-on-boot persona: $X answers error:46 and every g-code line after is error:9', async () => {
  const fake = new FakeController('alarm-homing-required');
  const said = listen(fake);
  assert.ok(said.includes('ALARM:11'), 'it boots into Alarm');

  await fake.write(enc('$X\n'));
  assert.equal(said.at(-1), 'error:46');
  assert.match(describeError(46).text, /Home machine to continue/);

  await fake.write(enc('G0 X10\n'));
  assert.equal(said.at(-1), 'error:9', 'a transcript of this reads exactly like a dialect failure');
  await fake.write(enc('G0 Y10\n'));
  assert.equal(said.at(-1), 'error:9');
});

test('$H is a long silence with no reports at all, and only then is the machine homed', async () => {
  const fake = new FakeController('alarm-homing-required');
  const said = listen(fake);
  await fake.write(enc('$H\n'));
  const duringHoming = said.length;
  await fake.write(realtimeBytes('statusReport'));
  const report = said.slice(duringHoming).find((l) => l.startsWith('<'));
  assert.ok(report?.startsWith('<Home'), 'the state is Home');

  fake.tick(4000);
  assert.equal(said.at(-1), 'ok');
  await fake.write(realtimeBytes('statusReportAll'));
  const after = mustParse(said.at(-1) as string);
  assert.deepEqual(after.homed, { all: true, mask: null });

  await fake.write(enc('G0 X10\n'));
  assert.equal(said.at(-1), 'ok', 'g-code is accepted once homing has completed');
});

test('a jog past the soft limit is error:15 — an error, not an alarm', async () => {
  const fake = new FakeController('healthy', { jogSoftLimitMm: 100 });
  const said = listen(fake);
  await fake.write(enc('$J=G91 G21 X500 F1000\n'));
  assert.equal(said.at(-1), 'error:15');
  assert.equal(fake.machineState, 'Idle', 'the jog was simply not executed and nothing is locked');

  await fake.write(enc('$J=G91 G21 X5 F1000\n'));
  assert.equal(said.at(-1), 'ok');
  assert.equal(fake.machineState, 'Jog');
  fake.tick(50);
  assert.equal(fake.machineState, 'Idle');
});

test('🔴 0x85 flushes the RX buffer even outside Jog — which is why R7 exists', async () => {
  const fake = new FakeController('healthy', { autoExecute: false });
  await fake.write(enc('G0 X1\nG0 X2\nG0 X3\n'));
  assert.equal(fake.rxFree, 1024 - 3 * 6, 'three six-byte lines are sitting in the RX buffer');
  await fake.write(realtimeBytes('jogCancel'));
  /* ⚠ 1023, NOT 1024, AND THE ONE CHARACTER IS THE POINT (modelled 2026-08-11).
   * `cancel_read_buffer` is not a plain flush: `usbRxCancel` writes an
   * `ASCII_CAN` into the ring before moving the tail past everything else
   * (`usb_serial.c:68-73`), so a status report rendered in this window reports
   * the buffer ONE SHORT with nothing of anyone's in it. That is a false
   * positive for `PortOwnershipWatch` and `RING_ARTEFACT_CHARS` is the named
   * subtraction for it. This assertion said 1024 until the artefact was
   * modelled — a fake that is one byte kinder than the firmware. */
  assert.equal(fake.rxFree, 1023, 'queued g-code was discarded, and one ASCII_CAN was left behind');
  assert.equal(fake.execute(), 0, 'the lines are gone; the sender’s character count is now a lie');
  assert.equal(fake.rxFree, 1024, 'and the reader consumes the CAN without replying to it');
  assert.equal(fake.realtimeReceived.at(-1)?.byte, 0x85);
  assert.equal(fake.realtimeReceived.at(-1)?.state, 'Idle');
});

test('the fake records realtime bytes grblHAL would ignore, rather than pretending they worked', async () => {
  const fake = new FakeController('healthy');
  await fake.write(realtimeBytes('spindleStop')); // 0x9E outside Hold
  await fake.write(Uint8Array.of(0x98)); // does not exist
  const [a, b] = fake.realtimeReceived.slice(-2);
  assert.equal(a.ignored, true);
  assert.match(a.reason ?? '', /HOLD/);
  assert.equal(b.ignored, true);
  assert.match(b.reason ?? '', /not implemented/);
});

test('a feed hold decelerates through Hold:1 before it reaches Hold:0', async () => {
  const fake = new FakeController('healthy', { autoExecute: false });
  const said = listen(fake);
  await fake.write(enc('$J=G91 X10 F1000\n'));
  fake.execute();
  await fake.write(realtimeBytes('feedHold'));
  await fake.write(realtimeBytes('statusReport'));
  assert.ok((said.at(-1) as string).startsWith('<Hold:1'), 'still decelerating');
  assert.equal(motionVerdict('Hold', 1).mayMove, true);

  fake.tick(200);
  await fake.write(realtimeBytes('statusReport'));
  assert.ok((said.at(-1) as string).startsWith('<Hold:0'));
  await fake.write(realtimeBytes('cycleStart'));
  await fake.write(realtimeBytes('statusReport'));
  assert.ok((said.at(-1) as string).startsWith('<Idle'));
});

test('a soft reset costs position only when it interrupts motion — and the fake models both', async () => {
  const stationary = new FakeController('healthy');
  const s1 = listen(stationary);
  await stationary.write(realtimeBytes('reset'));
  assert.ok(s1.some((l) => l.startsWith('GrblHAL')));
  assert.equal(s1.some((l) => l.startsWith('ALARM:')), false, 'no alarm when stationary');

  const moving = new FakeController('healthy', { jogMs: 1000 });
  const s2 = listen(moving);
  await moving.write(enc('$J=G91 X10 F1000\n'));
  assert.equal(moving.machineState, 'Jog');
  await moving.write(realtimeBytes('reset'));
  assert.ok(s2.includes('ALARM:3'), 'reset while moving raises ALARM:3 and loses position');
  assert.equal(positionTrustAfterAlarm(3).trusted, false);
});

test('a controller that resets under the sender is visible as a banner mid-stream', async () => {
  const fake = new FakeController('resets-mid-stream', { autoExecute: false });
  const s = new Streamer({ lines: program(20), mode: 'character-counting', rxBufferSize: 1024 });
  const out = await pumpStream(fake, s, { linesPerRound: 1 });
  assert.ok(out.read.some((l) => l.startsWith('GrblHAL')), 'an unsolicited banner mid-stream');
  assert.equal(s.state, 'aborted');
  assert.equal(s.abort?.code, 3);
});

test('a controller that stops answering stalls the stream rather than completing it', async () => {
  const fake = new FakeController('goes-silent', { autoExecute: false });
  const s = new Streamer({ lines: program(30), mode: 'character-counting', rxBufferSize: 64 });
  const out = await pumpStream(fake, s, { linesPerRound: 1, maxRounds: 500 });
  assert.equal(out.stalled, true);
  assert.notEqual(s.state, 'done');
  assert.equal(s.complete, false);
  assert.ok(s.sent > s.acknowledged, 'lines are outstanding and no reply is coming');
});

test('a probe that alarms WITHOUT an ok is the harder case, and both are survived', async () => {
  for (const emitsOk of [false, true]) {
    const fake = new FakeController('probe-no-contact', { autoExecute: false, probeAlarmEmitsOk: emitsOk });
    const s = new Streamer({
      lines: ['G0 Z5', 'G38.2 Z-30 F200', 'G1 X10'],
      mode: 'character-counting',
      rxBufferSize: 1024,
    });
    await pumpStream(fake, s, { linesPerRound: 1 });
    assert.equal(s.state, 'aborted', `probeAlarmEmitsOk=${emitsOk}`);
    assert.equal(s.abort?.reason, 'alarm');
  }
});

test('the fake can split every line across reads, and the assembler still sees whole lines', async () => {
  const fake = new FakeController('healthy', { splitEvery: 3 });
  const said = listen(fake);
  await fake.write(realtimeBytes('statusReportAll'));
  const report = said.find((l) => l.startsWith('<'));
  assert.ok(report, 'a report split into 3-byte chunks must still arrive as one line');
  assert.equal(parseStatusReport(report).error, null);
  assert.ok(fake.writes.length >= 1);
});

test('the Marlin and grbl-1.1 personas are classified correctly through the real identify()', async () => {
  const marlin = new FakeController('marlin');
  const m = listen(marlin);
  await marlin.write(enc('$I\n'));
  const mv = identify(m);
  assert.equal(mv.verdict, 'unknown');
  assert.equal(mv.permits, 'nothing');

  const grbl = new FakeController('grbl-1.1');
  const g = listen(grbl);
  await grbl.write(realtimeBytes('statusReportAll'));
  const gv = identify(g);
  assert.equal(gv.verdict, 'grbl');
  assert.equal(gv.permits, 'read-only');
  assert.equal(
    g.some((l) => l.includes('FW:grblHAL')),
    false,
    'grbl 1.1 has no FW field — that is the whole discriminator',
  );

  const silent = new FakeController('silent');
  const s = listen(silent);
  assert.deepEqual(s, [], 'a board that has been running for an hour sends no banner');
  assert.equal(identify(s).verdict, 'unknown');
});

test('a board that boots quietly is not the same as a board that is not grblHAL', async () => {
  const fake = new FakeController('no-banner');
  const said = listen(fake);
  assert.deepEqual(said, []);
  // Absence of a banner is not evidence of anything — ASK.
  await fake.write(enc('$I\n'));
  await fake.write(realtimeBytes('statusReportAll'));
  assert.equal(identify(said).verdict, 'grblHAL');
});

test('garbage bytes do not crash the assembler or produce a phantom report', () => {
  const fake = new FakeController('garbage');
  const said = listen(fake);
  for (const line of said) {
    assert.equal(classifyInbound(line).isLineReply, false);
    assert.notEqual(classifyInbound(line).kind, 'ok');
  }
  assert.equal(identify(said).verdict, 'unknown');
});

/* ═══════════════════════════════════════════════════════════════════════════
   13. THE PLANT REGISTRY ITSELF
   ═══════════════════════════════════════════════════════════════════════════ */

test('every plant in the registry is exercised by a test in this file', async () => {
  // A registry entry nobody drives is a negative control that has never been
  // watched, which is the exact failure `PLANT` exists to catch — its own row
  // records ten of eighteen plants being inert on most targets.
  const { readFile } = await import('node:fs/promises');
  const self = await readFile(new URL(import.meta.url), 'utf8');
  for (const plant of PROTOCOL_PLANTS) {
    const hits = self.match(new RegExp(plant, 'g')) ?? [];
    assert.ok(
      hits.length >= 2,
      `plant '${plant}' is not driven by a test (found ${hits.length} mentions: it needs a named ` +
        `test AND at least one call that passes it)`,
    );
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   14. WHAT THE grblHAL SOURCE SAID WHEN IT WAS FINALLY READ (2026-08-11)
   ═══════════════════════════════════════════════════════════════════════════

   Everything in §14 was written against `/home/gbacs/apps/grblHAL/` — driver
   `79b4c1c9`, core `29b7471f` as the `grbl` submodule, `GRBL_BUILD 20260811` —
   NOT against the design document, and not against the fake. Five of this
   lane's claims were wrong or absent and are corrected here.

   🔴 AND THE SENTENCE THAT STILL TRAVELS WITH ALL OF IT: these tests assert
   that `protocol.ts` agrees with a reading of grblHAL's C. They are stronger
   than the rest of this file only in that the C was on disk while they were
   written. **No byte has reached a board.** The bench machine runs Marlin, so
   nothing here is verifiable on the hardware this lane can touch.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── #120 the three bytes that carried the wrong constant ──────────────── */

test('the legacy realtime bytes are NAMED for the constants they actually are', () => {
  /* 🔴 The bytes were always right and the names were always wrong, which is
   * why nothing broke and why it survived for weeks. grbl.h defines BOTH
   * encodings: `?`/`~`/`!` at 107-109 and 0x80/0x81/0x82 at 115-117. Calling
   * 0x3f `CMD_STATUS_REPORT` sends a reader to the 0x80 branch of protocol.c,
   * where they find the $481 guard — and attribute it to `?`. That is exactly
   * the mistake #121 records. */
  assert.equal(REALTIME.statusReport.id, 'CMD_STATUS_REPORT_LEGACY');
  assert.equal(REALTIME.cycleStart.id, 'CMD_CYCLE_START_LEGACY');
  assert.equal(REALTIME.feedHold.id, 'CMD_FEED_HOLD_LEGACY');

  // THE WIRE IS UNCHANGED. A rename that moved a byte would be a real defect
  // wearing a correction's clothes.
  assert.deepEqual([...realtimeBytes('statusReport')], [0x3f]);
  assert.deepEqual([...realtimeBytes('cycleStart')], [0x7e]);
  assert.deepEqual([...realtimeBytes('feedHold')], [0x21]);

  /* And the general property, so the next row cannot re-cross them: no entry
   * below 0x80 may claim a non-legacy constant name, and no entry at or above
   * 0x80 may claim a `_LEGACY` one. */
  for (const cmd of Object.values(REALTIME)) {
    if (cmd.byte === 0x18 || cmd.byte === 0x85) continue; // CMD_RESET / jog cancel: one encoding only
    if (cmd.byte < 0x80) {
      assert.ok(
        cmd.id.endsWith('_LEGACY'),
        `${cmd.id} is byte 0x${cmd.byte.toString(16)}, which is in the legacy range`,
      );
    } else {
      assert.equal(
        cmd.id.endsWith('_LEGACY'),
        false,
        `${cmd.id} is byte 0x${cmd.byte.toString(16)}, which is not a legacy byte`,
      );
    }
  }

  // IN-TEST NEGATIVE CONTROL (the RUN-17 pattern — no registry plant, because
  // adding one to PROTOCOL_PLANTS makes gate RUN red for an unconsumed plant).
  const planted = { ...REALTIME.feedHold, id: 'CMD_FEED_HOLD' };
  assert.equal(
    planted.byte < 0x80 && planted.id.endsWith('_LEGACY'),
    false,
    'the check above must be able to reject the exact string this table used to carry',
  );
});

/* ── #121 the `?` note cited a guard that does not apply to `?` ─────────── */

test('`?` IS answered while auto-reporting is on — the $481 guard is on 0x80 only', () => {
  /* protocol.c:871-876 — `case CMD_STATUS_REPORT: case 0x05:` guarded by
   * `if(!sys.flags.auto_reporting)`.
   * protocol.c:987-992 — `case CMD_STATUS_REPORT_LEGACY:` in a SEPARATE switch,
   * guarded only by `!keep_rt_commands || settings.flags.legacy_rt_commands`.
   * There is no auto-reporting term in the second one. */
  const auto = { legacyRtCommands: true, autoReporting: true };
  const r = legacyRealtimeReliability('statusReport', auto);
  assert.equal(r.legacy.acts, 'always', '`?` is not gated on auto-reporting');
  assert.equal(r.nonLegacy.acts, 'not-while-auto-reporting', '0x80 is');
  assert.match(r.nonLegacy.why, /SILENTLY IGNORED/);

  // The note the operator reads must not assert the refuted claim...
  assert.doesNotMatch(
    REALTIME.statusReport.note,
    /Ignored while auto-reporting/,
    'the corrected note must not still carry the claim it corrects',
  );
  // ...and must keep the OPERATIONAL RULE, whose reason changed but whose
  // conclusion did not: auto-reports arrive unbidden, so no report can be
  // attributed to a particular `?`.
  assert.match(REALTIME.statusReport.note, /a report arrived/);
  assert.match(REALTIME.statusReport.note, /987-992/);
});

/* ── #122 `$39` is a real dependency and it was unmodelled ──────────────── */

test('$39 does not switch `?` off — it stops it being picked off inside comments and $-lines', () => {
  /* grblHAL's own description of Setting_EnableLegacyRTCommands
   * (settings.c:2551): "Enables 'normal' processing of ?, ! and ~ characters
   * WHEN PART OF $-SETTING OR COMMENT. If disabled then they are added to the
   * input string instead."  ⚠ The relayed framing — "a sender that only ever
   * transmits ? has no fallback on a machine with $39=0" — is stronger than
   * the source: from an idle prompt `?` still works. What it loses is the
   * poll that lands mid-comment, and EVERY program this post emits opens with
   * a block of ( … ) comments. */
  const off = legacyRealtimeReliability('statusReport', { legacyRtCommands: false, autoReporting: false });
  assert.equal(off.legacy.pickedOff, 'not-in-comments-or-$-lines');
  assert.match(off.legacy.why, /appended to the g-code line as data/);

  const on = legacyRealtimeReliability('statusReport', { legacyRtCommands: true, autoReporting: false });
  assert.equal(on.legacy.pickedOff, 'always');

  // Unread is UNKNOWN, never "fine". The default being On is not evidence
  // about the board in front of you.
  const unread = legacyRealtimeReliability('statusReport', { legacyRtCommands: null, autoReporting: null });
  assert.equal(unread.legacy.pickedOff, 'unknown');
  assert.equal(unread.nonLegacy.acts, 'unknown');

  /* 🔴 The two encodings fail in OPPOSITE directions, which is the whole
   * reason the "send both?" question is open rather than obvious: $39 cannot
   * touch 0x80, and auto-reporting cannot touch `?`. */
  for (const cfg of [
    { legacyRtCommands: false, autoReporting: false },
    { legacyRtCommands: false, autoReporting: true },
    { legacyRtCommands: true, autoReporting: true },
  ]) {
    assert.equal(legacyRealtimeReliability('statusReport', cfg).nonLegacy.pickedOff, 'always');
    assert.equal(legacyRealtimeReliability('statusReport', cfg).legacy.acts, 'always');
  }

  // Hold and resume have no auto-reporting term at all, in either encoding.
  for (const which of ['cycleStart', 'feedHold'] as const) {
    const both = legacyRealtimeReliability(which, { legacyRtCommands: true, autoReporting: true });
    assert.equal(both.legacy.acts, 'always');
    assert.equal(both.nonLegacy.acts, 'always');
    assert.equal(both.nonLegacy.byte, which === 'cycleStart' ? 0x81 : 0x82);
  }
});

test('auto-reporting is OBSERVED from AR in a full report, never inferred from $481', () => {
  /* report.c:1500-1503 writes "|AR:" + interval when the flag is set and a bare
   * "|AR" when it is not — and $481 only says an interval is CONFIGURED, since
   * 0x8C toggles the flag independently (protocol.c:936-939). A bare `AR` is
   * therefore a stated value; filing it under unknownFields would record a fact
   * the controller volunteered as something we failed to read. */
  const on = mustParse('<Idle|MPos:0,0,0|AR:250|FW:grblHAL>');
  assert.deepEqual(on.autoReporting, { on: true, intervalMs: 250 });
  assert.equal(on.unknownFields.includes('AR:250'), false);

  const off = mustParse('<Idle|MPos:0,0,0|AR|FW:grblHAL>');
  assert.deepEqual(off.autoReporting, { on: false, intervalMs: null });
  assert.equal(off.unknownFields.includes('AR'), false);

  // Absent is NOT "off": AR appears only in a full report and only when $481
  // is non-zero.
  assert.equal(mustParse('<Idle|MPos:0,0,0>').autoReporting, null);
});

/* ── #123 WCO_NEVER_ARRIVED advised something impossible ────────────────── */

test('under $10 bit 5 clear the WCO message does NOT tell the operator to press 0x87', () => {
  /* report.c:1419 gates the WHOLE `|WCO:` element on
   * settings.status_report.work_coord_offset; report->flags.all — which is what
   * 0x87 sets — is only consulted INSIDE that gate. So under $10=1 the operator
   * presses the button, nothing changes, and the message used to still say to
   * press it. The doc comment on deriveDro already knew; the string did not. */
  const clear = wcoUnavailable(decodeReportMask(1));
  assert.doesNotMatch(clear, /Send 0x87/);
  assert.match(clear, /cannot force it/);
  assert.match(clear, /report\.c:1419/);
  assert.match(clear, /never will/);

  // Where 0x87 DOES work, it is still offered — the fix must not delete the
  // useful advice along with the impossible one.
  const set = wcoUnavailable(decodeReportMask(511));
  assert.match(set, /Send 0x87/);
  assert.match(set, /30 reports away/);

  /* And with no mask the readout says WHAT it does not know, rather than
   * guessing the common case — and, equally, rather than asserting WHY. This
   * arm is reached whenever the caller did not thread $10 through, including
   * from a tab that has read $$; "the operator has not read $$" would be a
   * claim printed at an operator that this function cannot check. */
  const unknown = wcoUnavailable(null);
  assert.match(unknown, /\$10 has not been given to this readout/);
  assert.doesNotMatch(unknown, /has not been read,/);
  assert.match(unknown, /CANNOT force it/);

  /* The string reaches the DRO through deriveDro, which is where an operator
   * actually meets it. $10=1 ⇒ MPos only, no WCO, ever. */
  const r = mustParse('<Idle|MPos:10,20,30>');
  const dro = deriveDro(r, null, undefined, decodeReportMask(1));
  assert.equal(dro.work.values, null);
  assert.doesNotMatch(dro.work.unavailable ?? '', /Send 0x87/);
  // Same report, same absence, different controller setting, different advice.
  const waiting = deriveDro(r, null, undefined, decodeReportMask(511));
  assert.match(waiting.work.unavailable ?? '', /Send 0x87/);
  assert.notEqual(dro.work.unavailable, waiting.work.unavailable);
});

/* ── #124 three bytes neither listed nor listed-as-excluded ─────────────── */

test('every realtime byte this lane has ruled on is in exactly one of the three lists', () => {
  const shipped = new Set(Object.values(REALTIME).map((c) => c.byte));
  const inert = new Set(Object.keys(NOT_IMPLEMENTED_REALTIME).map(Number));
  const excluded = new Set(Object.keys(EXCLUDED_REALTIME).map(Number));

  /* 🔴 0x86 is the one that hides. It sits BETWEEN 0x85 and 0x87, both of
   * which we ship, so the run of bytes reads as unbroken — and a reader
   * filling the hole ships a debug-report button that does nothing on every
   * build we will flash. */
  assert.equal(shipped.has(0x85), true);
  assert.equal(shipped.has(0x87), true);
  assert.equal(inert.has(0x86), true, '0x86 CMD_DEBUG_REPORT is commented out in grbl.h:121');
  assert.match(NOT_IMPLEMENTED_REALTIME[0x86], /Only when DEBUG enabled/);

  assert.equal(inert.has(0x8a), true, '0x8A CMD_OVERRIDE_FAN0_TOGGLE, grbl.h:125');
  assert.match(NOT_IMPLEMENTED_REALTIME[0x8a], /not implemented by the core/);
  assert.equal(inert.has(0x98), true);

  /* The two REAL controller-level stops. They are implemented — that is
   * precisely why they may not sit in NOT_IMPLEMENTED — so they need a
   * statement of their own, with the reason. An empty answer and "we thought
   * about it and said no" are the same silence otherwise. */
  assert.equal(excluded.has(0x19), true, 'CMD_STOP');
  assert.equal(excluded.has(0x03), true, 'CMD_EXIT');
  assert.match(EXCLUDED_REALTIME[0x19], /Experimental for now, must be verified/);
  assert.match(EXCLUDED_REALTIME[0x19], /cancel_read_buffer/);
  assert.match(EXCLUDED_REALTIME[0x03], /COMPATIBILITY_LEVEL/);

  // Disjoint, in all three directions.
  for (const b of inert) assert.equal(shipped.has(b), false, `0x${b.toString(16)} is both shipped and inert`);
  for (const b of excluded) assert.equal(shipped.has(b), false, `0x${b.toString(16)} is both shipped and excluded`);
  for (const b of excluded) assert.equal(inert.has(b), false, `0x${b.toString(16)} is both inert and excluded`);
});

/* ── the Bf caveat: 1024 over USB CDC, 1023 over a UART ─────────────────── */

test('the streamer counts against an ODD, non-power-of-two measured buffer', () => {
  /* usb_serial.c:54 returns RX_BUFFER_SIZE - count (max 1024);
   * serial.c:551 returns (RX_BUFFER_SIZE - 1) - count (max 1023).
   * grblHAL requires RX_BUFFER_SIZE itself to be a power of two (stream.h:52),
   * so the MEASURED figure is one of those two and only one of them is. Our
   * refusal to build a streamer without a measured size is what makes this
   * survivable; this test is the check that nothing has since learned the
   * number's shape. */
  for (const size of [1024, 1023, 1000, 127, 65]) {
    const lines = Array.from({ length: 400 }, (_, i) => `G1 X${i}.000 Y${i}.000 F3600.0`);
    const cost = Math.max(...lines.map((l) => l.length + 1));
    const s = new Streamer({ lines, mode: 'character-counting', rxBufferSize: size });

    /* 🔴 THE ASSERTION THE FIRST VERSION OF THIS TEST DID NOT HAVE, and the
     * plant that exposed it: rounding the measured figure DOWN to a power of
     * two left every assertion below green, because "never exceeds" and
     * "finishes" are both still true of a streamer using half the buffer. A
     * silently-halved allowance is not a safe failure — it doubles the
     * round-trips and starves the planner, which is the stalled-cutter failure
     * this whole module exists for. So assert the number SURVIVED, and that
     * the allowance is actually filled. */
    assert.equal(s.rxBufferSize, size, 'the streamer must carry the MEASURED number, unreshaped');

    let peak = 0;
    let guard = 0;
    while (!s.complete && guard++ < 200_000) {
      const out = s.nextLines();
      peak = Math.max(peak, s.pendingChars);
      assert.ok(s.pendingChars <= size, `pending ${s.pendingChars} exceeded the measured ${size}`);
      if (out.length === 0 && s.pendingChars === 0) break;
      s.onReply(classifyInbound('ok'));
    }
    assert.equal(s.complete, true, `did not finish against a ${size}-byte buffer`);
    assert.ok(
      peak > size - cost,
      `only ${peak} of ${size} bytes were ever in flight — the allowance is being under-used by more than one line, so the measured buffer is not the number actually in play`,
    );
    assert.ok(peak <= size);
  }

  /* The one-byte difference, made observable rather than asserted in prose.
   * With a line that costs exactly 512 bytes, 1024 holds two and 1023 holds
   * one — the same firmware, the same RX_BUFFER_SIZE, a different cable. */
  const wide = 'G1 X1.000'.padEnd(511, ' ');
  const two = new Streamer({ lines: [wide, wide, wide], mode: 'character-counting', rxBufferSize: 1024 });
  const one = new Streamer({ lines: [wide, wide, wide], mode: 'character-counting', rxBufferSize: 1023 });
  assert.equal(two.nextLines().length, 2, 'USB CDC reports 1024 free and two 512-byte lines fit');
  assert.equal(one.nextLines().length, 1, 'a UART reports 1023 and the second line does not');

  /* And end to end through the fake, whose UART formula reports one byte less
   * than its own buffer — the same firmware, a different cable. */
  const usb = new FakeController('healthy', { rxBufferSize: 1024, rxFreeFormula: 'usb-cdc' });
  const uart = new FakeController('healthy', { rxBufferSize: 1024, rxFreeFormula: 'uart' });
  assert.equal(usb.rxFree, 1024);
  assert.equal(uart.rxFree, 1023);
  assert.notEqual(usb.rxFree, uart.rxFree);
  assert.match(uart.describe(), /rx=1024B\/uart/, 'the gate must be able to print WHICH driver answered');
  // The default is unchanged, so the other fourteen personas assert the same
  // thing they asserted before this option existed.
  assert.equal(new FakeController('healthy').rxFree, 1024);
});

/* ── the error:46 caveat: 46 is returned LAST ──────────────────────────── */

test('$X refuses with five codes and 46 is the LAST of them', () => {
  /* system.c:413-445 is one else-if chain: SelfTestFailed(49) → EStop(50) →
   * CheckDoor(13) → Reset(18), and only if all four pass does it reach
   * LimitsEngaged(45)/HomingRequired(46). A UI that special-cases 46 alone
   * renders an open door as a generic error while advising "$H" — the fix for
   * the one case that is not happening. */
  assert.deepEqual(UNLOCK_REFUSAL_ORDER.map((u) => u.code), [49, 50, 13, 18, 46]);
  assert.equal(UNLOCK_REFUSAL_ORDER.at(-1)?.code, 46, '46 is the last arm, not the first');

  for (const { code } of UNLOCK_REFUSAL_ORDER) {
    const spec = ERRORS.get(code);
    assert.ok(spec, `error ${code} must be in the table or it renders as unknown`);
    assert.ok(spec.text, `error ${code} must carry grblHAL's own sentence`);
    assert.equal(describeError(code).known, true);

    const r = refusalsFor('unlock', { ...readyToStart(), lastUnlockError: code }).find((x) => x.id === 'R9');
    assert.ok(r, `error:${code} must produce an R9 refusal`);
    assert.match(r.fact, new RegExp(`error:${code}`));
    if (code !== 46) {
      assert.doesNotMatch(r.why, /Run \$H/, `error:${code} must not advise $H — that is 46's fix`);
      assert.match(r.why, /BEFORE 46/);
    }
  }

  // A door and an e-stop must not render as "an error this UI does not carry
  // text for", which is what they did until 2026-08-11.
  for (const code of [13, 49, 50, 18]) {
    assert.doesNotMatch(describeError(code).text, /does not carry text for/);
  }

  // A code outside the chain is named as outside it, rather than silently
  // producing no refusal at all.
  const odd = refusalsFor('unlock', { ...readyToStart(), lastUnlockError: 22 }).find((x) => x.id === 'R9');
  assert.ok(odd);
  assert.match(odd.fact, /not one of the five/);

  // IN-TEST NEGATIVE CONTROL: the 46-only predicate this replaced would pass
  // for 46 and say nothing for the four that outrank it.
  const only46 = (c: number) => (c === 46 ? 'R9' : null);
  assert.equal(only46(46), 'R9');
  for (const c of [49, 50, 13, 18]) {
    assert.equal(only46(c), null, 'the OLD predicate is silent here — which is the defect');
    assert.ok(
      refusalsFor('unlock', { ...readyToStart(), lastUnlockError: c }).some((x) => x.id === 'R9'),
      'and the new one is not',
    );
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   A SECOND WRITER ON THE PORT — the assumption under the character count

   🔴 WHAT IS BEING TESTED, AND WHAT CANNOT BE.

   The failure: two processes hold `/dev/ttyACM0`. No hub is needed and no
   configuration makes it happen — one open serial monitor is enough. Their bytes
   land in the SAME ring, `Bf` stays honest about that ring, and this tab's
   `pendingChars` undercounts by exactly their bytes. We send into space we
   believe is free; grblHAL drops the excess and records it in a flag that
   `usb_serial.c:258` WRITES and nothing anywhere READS. The program loses
   characters mid-line and the machine cuts something that was never in the file.

   ⚠ EXERCISED HERE: the arithmetic, against a fake whose RX ring is a real,
   finite, observable thing and whose `foreignWrite` puts somebody else's bytes
   in it. NOT exercised: that a real second writer produces the numbers the fake
   produces. That is `gates/controller/`, which is still empty.
   ═══════════════════════════════════════════════════════════════════════════ */

/** A quiescent sample: Idle, not streaming, nothing of ours outstanding. */
const quiet = (rxFree: number) => ({
  rxFree,
  state: 'Idle' as const,
  streaming: false,
  ourChars: 0 as const,
});

test('a foreign writer’s bytes in the ring are caught by Bf alone, with nothing sent', () => {
  const fake = new FakeController('healthy', { autoExecute: false });
  const w = new PortOwnershipWatch();

  /* Baseline while genuinely alone. `1024` is the USB CDC figure — but nothing
   * below uses the fact that it is 1024, which is the property that makes the
   * connect-time case tractable. */
  assert.equal(fake.rxFree, 1024);
  w.observe(quiet(fake.rxFree));
  assert.equal(w.verdict, 'no-disagreement');
  assert.equal(w.quiescentFree, 1024);

  /* A serial monitor in another window sends one line. It never reaches this
   * tab's `write()` — that is the whole point. */
  fake.foreignWrite('G0 X0 Y0\n');
  assert.equal(fake.rxFree, 1024 - 9, 'the fake’s ring must actually hold the other program’s bytes');

  w.observe(quiet(fake.rxFree));
  assert.equal(w.verdict, 'foreign-writer');
  assert.equal(w.evidence?.kind, 'quiescent-dip');
  assert.equal(w.evidence?.chars, 9);

  /* And the sentence names the number rather than asserting a conclusion. */
  assert.match(w.why, /SECOND PROGRAM IS WRITING TO THIS PORT/);
  assert.match(w.why, /9 character\(s\)/);

  /* NOT ONE BYTE WAS SENT TO FIND THIS OUT. `5dc1b077f0` made the connect path
   * write nothing until a verdict because the board on the bench runs Marlin;
   * a detector that probed would have undone that. */
  assert.equal(fake.writes.length, 0, 'the watch must be able to reach a verdict having written NOTHING');
});

test('the CONNECT-TIME case: a corrupted measurement is caught by its own later correction', () => {
  /* The sharp one. The handshake measures the RX buffer size from `Bf` while
   * Idle and refuses to stream without it (R13) — so a second writer present at
   * that moment corrupts the one number every later gate is built on, and the
   * detector may not lean on it. This arm leans on nothing but "a maximum that
   * increases was never a maximum". */
  const fake = new FakeController('healthy', { autoExecute: false });
  const w = new PortOwnershipWatch();

  fake.foreignWrite('$$\n');                      // already there when we connect
  assert.equal(fake.rxFree, 1021);

  w.observe(quiet(fake.rxFree));                  // the handshake's measurement
  assert.equal(w.verdict, 'no-disagreement', 'nothing to compare against yet — one sample is not a series');
  assert.equal(w.quiescentFree, 1021, 'and the corrupted number is what got measured');

  fake.execute();                                  // the other program's line runs
  w.observe(quiet(fake.rxFree));

  assert.equal(w.verdict, 'foreign-writer');
  assert.equal(w.evidence?.kind, 'baseline-rose');
  assert.equal(w.evidence?.chars, 3);
  assert.match(w.why, /ROSE to 1024 from a baseline of 1021/);
  assert.match(w.why, /the buffer size was measured from/);

  /* IN-TEST NEGATIVE CONTROL — the detector this one is NOT. A watch that took
   * its baseline as the true buffer size, the way `measureBuffers()` in
   * RunTab.tsx does with `Math.max`, keeps the larger number and says nothing:
   * the anomaly is summarised away by the summary. */
  const maxOnly = [1021, 1024].reduce((a, b) => Math.max(a, b), 0);
  assert.equal(maxOnly, 1024, 'the max is right about the SIZE…');
  assert.equal(
    [1021, 1024].every((v) => v <= maxOnly),
    true,
    '…and a Math.max can never disagree with itself, which is why it cannot carry this finding',
  );
});

test('PLANT — a foreign writer that goes unnoticed is what this replaces', () => {
  /* The pre-fix product, restored: count only our own bytes and compare against
   * the measured size. It is green while the ring is being eaten. */
  const fake = new FakeController('healthy', { autoExecute: false });
  fake.foreignWrite('G1 X50 Y50 F800\n');
  const foreign = 16;
  assert.equal(fake.rxFree, 1024 - foreign);

  const planted = (rxFree: number, ours: number, measured: number) => ours + rxFree >= 0 && ours <= measured;
  assert.equal(
    planted(fake.rxFree, 0, 1024),
    true,
    'THE DEFECT: our own count fits the measured buffer, so the old reading is "all clear"',
  );

  const w = new PortOwnershipWatch();
  w.observe(quiet(1024));
  w.observe(quiet(fake.rxFree));
  assert.equal(w.verdict, 'foreign-writer', 'and the new one is not');
  assert.equal(w.evidence?.chars, foreign);
});

test('a foreign writer is caught MID-STREAM too, by a bound that never claims to know the buffer size', async () => {
  const fake = new FakeController('healthy', { autoExecute: false });
  const w = new PortOwnershipWatch();
  w.observe(quiet(1024));

  /* We have 100 characters outstanding. Somebody else has 200 in the ring. */
  await fake.write(enc('X'.repeat(99) + '\n'));
  fake.foreignWrite('Y'.repeat(200));
  assert.equal(fake.rxFree, 1024 - 100 - 200);

  /* Sound whatever the state word says: `q ≤ B` is true by construction, so
   * `foreign ≥ (q − rxFree) − ourChars` is true without knowing B. */
  w.observe({ rxFree: fake.rxFree, state: 'Run', streaming: true, ourChars: 100 });
  assert.equal(w.verdict, 'foreign-writer');
  assert.equal(w.evidence?.kind, 'bound-exceeded');
  assert.equal(w.evidence?.chars, 200);

  /* IN-TEST NEGATIVE CONTROL: the same numbers with the foreign bytes absent
   * must NOT fire, or the arm is a constant. */
  const clean = new FakeController('healthy', { autoExecute: false });
  const w2 = new PortOwnershipWatch();
  w2.observe(quiet(1024));
  await clean.write(enc('X'.repeat(99) + '\n'));
  w2.observe({ rxFree: clean.rxFree, state: 'Run', streaming: true, ourChars: 100 });
  assert.equal(w2.verdict, 'no-disagreement');
});

test('an OVER-STATED bound of our own bytes only blinds the watch — it never inverts it', () => {
  /* `ourChars` is required to be an UPPER bound at the moment the CONTROLLER
   * rendered the report, which is in the past. Supplying the maximum over the
   * window is therefore too high, sometimes by a lot. That must cost sensitivity
   * and nothing else. */
  const w = new PortOwnershipWatch();
  w.observe(quiet(1024));
  w.observe({ rxFree: 900, state: 'Run', streaming: true, ourChars: 124 });
  assert.equal(w.verdict, 'no-disagreement', '124 accounts for all 124 missing characters');
  w.observe({ rxFree: 900, state: 'Run', streaming: true, ourChars: 1024 });
  assert.equal(w.verdict, 'no-disagreement', 'and an absurdly high bound is merely blind');
});

/* ── the false positives, which are how a detector gets muted ─────────────── */

test('AUTO-REPORTING AND ? POLLS DO NOT MOVE Bf — the false positive that would have killed this', async () => {
  /* The first thing checked, at grblHAL's source rather than by argument:
   * `protocol_enqueue_realtime_command` returns `drop = true` for `?`, and
   * `usbBufferInput` buffers only what it returns FALSE for
   * (`usb_serial.c:253-262`). A realtime byte never enters the ring, so neither
   * our polling nor a `$481` auto-report nor a SECOND writer's `?` can depress
   * the free figure. A detector that fired on any of those would be muted
   * inside a day. */
  const fake = new FakeController('healthy', { autoExecute: false });
  const w = new PortOwnershipWatch();
  w.observe(quiet(fake.rxFree));

  await fake.write(Uint8Array.of(0x3f));   // our poll
  await fake.write(Uint8Array.of(0x87));   // our full-report request
  fake.foreignWrite('?');                     // the OTHER program polling
  fake.foreignWrite('\x90');                  // and resetting the feed override

  assert.equal(fake.rxFree, 1024, 'realtime bytes must not occupy the ring in the fake either');
  w.observe(quiet(fake.rxFree));
  assert.equal(w.verdict, 'no-disagreement');

  /* ⚠ AND SAY WHAT THAT COSTS. A second writer that only ever sends realtime
   * bytes is INVISIBLE here — while still being able to feed-hold the machine
   * and to steal our replies. The verdict word says `no-disagreement` and not
   * `sole-owner` for exactly this reason. */
  assert.ok(fake.realtimeReceived.some((r) => r.byte === 0x3f));
  assert.match(w.why, /not proof of it/);
});

test('the 0x85 CAN artefact: one character in the ring that is nobody’s second writer', async () => {
  /* `cancel_read_buffer` writes an ASCII_CAN into the ring and moves the tail
   * past everything else (`usb_serial.c:68-73`). A report rendered before the
   * main loop reads it shows the buffer one character short with nothing in it.
   * That is a real false positive and `RING_ARTEFACT_CHARS` is the named
   * subtraction for it — one character, and the insensitivity it buys is
   * stated. */
  assert.equal(RING_ARTEFACT_CHARS, 1);

  const fake = new FakeController('healthy', { autoExecute: false });
  const w = new PortOwnershipWatch();
  w.observe(quiet(fake.rxFree));

  await fake.write(Uint8Array.of(0x85));
  assert.equal(fake.rxFree, 1023, 'the fake must model the CAN, or the artefact cannot be reproduced');

  w.observe(quiet(fake.rxFree));
  assert.equal(w.verdict, 'no-disagreement', 'one character is the artefact, not a writer');

  fake.execute();
  assert.equal(fake.rxFree, 1024, 'and the reader consumes it without replying');

  /* Two characters is not the artefact. The subtraction must be exactly one or
   * it is a margin, and a margin is what this whole item refuses to be. */
  const w2 = new PortOwnershipWatch();
  w2.observe(quiet(1024));
  w2.observe(quiet(1022));
  assert.equal(w2.verdict, 'foreign-writer', 'RING_ARTEFACT_CHARS must not be widened into a safety factor');
});

test('PLANT — an unaccounted channel of OUR OWN reads as a foreign writer', async () => {
  /* THE FAILURE THAT GETS A DETECTOR MUTED, and it is ours to cause. The
   * console sends `$` commands; the streamer does not know about them. A caller
   * that supplies `Streamer.pendingChars` instead of ALL of this tab's
   * outstanding bytes manufactures a second writer out of its own `$$`. */
  const fake = new FakeController('healthy', { autoExecute: false });
  await fake.write(enc('$$\n'));                 // OUR console, not a stranger
  assert.equal(fake.rxFree, 1021);

  const streamerPending = 0;                        // the streamer sent nothing
  const allOurs = 3;                                // what the link actually owes

  const planted = new PortOwnershipWatch();
  planted.observe(quiet(1024));
  planted.observe({ rxFree: fake.rxFree, state: 'Run', streaming: true, ourChars: streamerPending });
  assert.equal(planted.verdict, 'foreign-writer', 'THE DEFECT: our own $$ rendered as somebody else');

  const correct = new PortOwnershipWatch();
  correct.observe(quiet(1024));
  correct.observe({ rxFree: fake.rxFree, state: 'Run', streaming: true, ourChars: allOurs });
  assert.equal(correct.verdict, 'no-disagreement', 'and a complete count does not');
});

test('“unknown” is skipped, never scored as zero', () => {
  /* After a 0x85 or a 0x18 this tab's count is a lie (R7 says so). The honest
   * input is `'unknown'`, and the one input that would turn this watch into a
   * liar is a `0` that means "I did not check". */
  const w = new PortOwnershipWatch();
  w.observe(quiet(1024));
  w.observe({ rxFree: 500, state: 'Run', streaming: true, ourChars: 'unknown' });
  assert.equal(w.verdict, 'no-disagreement');
  assert.equal(w.quiescentSamples, 1, 'an unknown sample is not a sample that was checked');

  /* A sample with our count unknown is not quiescent either, so it can neither
   * raise nor lower the baseline. */
  w.observe({ rxFree: 2048, state: 'Idle', streaming: false, ourChars: 'unknown' });
  assert.equal(w.quiescentFree, 1024);
});

test('the verdict is sticky, and the unchecked default is never worded as a pass', () => {
  const w = new PortOwnershipWatch();
  assert.equal(w.verdict, 'unchecked');
  assert.match(w.why, /Nothing has been checked/);
  assert.match(w.why, /ONLY program writing to this port/);

  w.observe(quiet(1024));
  w.observe(quiet(900));
  assert.equal(w.verdict, 'foreign-writer');
  w.observe(quiet(1024));
  w.observe(quiet(1024));
  assert.equal(w.verdict, 'foreign-writer', 'a writer that goes quiet has not gone away');

  /* And the safe word must not be readable as "we are alone". */
  const ok = new PortOwnershipWatch();
  ok.observe(quiet(1024));
  assert.equal(ok.verdict, 'no-disagreement');
  assert.doesNotMatch(ok.verdict, /sole|alone|exclusive/i);
  assert.match(ok.why, /what sole ownership looks like/);
  assert.match(ok.why, /It is not proof of it/);
});

test('R14 refuses the job, names the limit, and refuses the WIDER MARGIN by name', () => {
  const s = readyToStart();
  assert.equal(refusalsFor('start-job', s).length, 0, 'the known green this changes from');

  const w = new PortOwnershipWatch();
  w.observe(quiet(1024));
  w.observe(quiet(1000));
  assert.equal(w.verdict, 'foreign-writer');

  const caught: TrackedState = { ...s, portOwnership: w.verdict, portOwnershipWhy: w.why };
  const r = refusalsFor('start-job', caught).find((x) => x.id === 'R14');
  assert.ok(r, 'a detected second writer must refuse the job, not warn above a runnable one');
  assert.match(r.fact, /SECOND PROGRAM IS WRITING TO THIS PORT/);
  assert.match(r.why, /disconnect and reconnect/);
  assert.match(r.why, /the number is wrong, not tight/);

  /* `unchecked` does not refuse — it is not evidence — and `no-disagreement`
   * does not either. The limit that stands in both cases is a stated constant,
   * not a green. */
  for (const v of ['unchecked', 'no-disagreement'] as const) {
    assert.equal(
      refusalsFor('start-job', { ...s, portOwnership: v }).some((x) => x.id === 'R14'),
      false,
    );
  }
  assert.equal(initialTrackedState().portOwnership, 'unchecked');
  assert.equal(initialTrackedState().portOwnershipWhy, null);

  /* Send-response mode has no character count to corrupt, so R14 does not fire
   * there. A refusal that fires where its reason does not apply is the one
   * operators learn to click past. */
  assert.equal(
    refusalsFor('start-job', { ...caught, streamMode: 'send-response' }).some((x) => x.id === 'R14'),
    false,
  );

  assert.match(SOLE_OWNERSHIP_LIMIT, /ONLY program writing to this port/);
  assert.match(SOLE_OWNERSHIP_LIMIT, /WITHOUT REPORTING ANYTHING/);
  assert.match(SOLE_OWNERSHIP_LIMIT, /limit rather than a guarantee/);
});

test('the desync abort names the second writer, because that is what produces it', () => {
  /* A foreign writer's lines are answered on this same stream, and two readers
   * on one tty split the bytes. The symptom this tab sees is an `ok` with
   * nothing outstanding — and until 2026-08-11 the message described the
   * symptom and named no cause an operator could act on. */
  const s = new Streamer({ lines: program(2), mode: 'character-counting', rxBufferSize: 1024 });
  s.nextLines();
  s.onReply(classifyInbound('ok'));
  s.onReply(classifyInbound('ok'));
  s.onReply(classifyInbound('ok'));            // one more than we sent
  assert.equal(s.state, 'aborted');
  assert.equal(s.abort?.reason, 'desync');
  assert.match(s.abort?.message ?? '', /SECOND PROGRAM/);
  assert.match(s.abort?.message ?? '', /serial monitor|gSender|CNCjs/);
});

test('the fake’s second writer is a CAPABILITY, not a persona, and it names itself', () => {
  /* grblHAL cannot tell a second writer is happening: `hal.stream` is a COPY of
   * one stream's function pointers (`stream.c:408`) and the connection list is
   * output-only — `stream_write_all()` broadcasts and nothing iterates it to
   * read. So "a second writer" is not a board configuration and a fifteenth
   * persona would have asserted that it is. Every existing persona must be able
   * to have one. */
  assert.equal(PERSONAS.length, 14, 'no persona was added for this');
  for (const p of PERSONAS) {
    assert.doesNotMatch(p, /foreign|second-writer/);
  }

  const fake = new FakeController('tiny-buffer', { autoExecute: false });
  assert.match(fake.describe(), /foreign=0B/, 'the gate must be able to print whether one was there');
  fake.foreignWrite('G0X0\n');
  assert.match(fake.describe(), /foreign=5B/);
  assert.match(fake.describe(), /persona=tiny-buffer/, 'and the persona line is unchanged');

  /* The other program's line really executes and really gets answered — on OUR
   * stream. That is the extra `ok`. */
  const said: string[] = [];
  const asm = new LineAssembler();
  fake.onData((c) => {
    for (const l of asm.push(c)) said.push(l);
  });
  fake.execute();
  assert.ok(said.includes('ok'), 'the second writer’s line is answered on this stream, because there is only one');
});

test('a foreign writer really does overrun the controller under a correct streamer', async () => {
  /* End to end, and the overrun counter is the FAKE's — the controller's side of
   * the argument, which is the only side that matters. The streamer here is
   * correct: it counts every one of its own characters against the measured
   * buffer and never exceeds it. It overruns anyway. */
  const fake = new FakeController('tiny-buffer', { autoExecute: false });   // 64 bytes
  const s = new Streamer({ lines: program(40), mode: 'character-counting', rxBufferSize: 64 });

  fake.foreignWrite('X'.repeat(50));            // somebody else takes most of it
  for (const line of s.nextLines()) {
    await fake.write(enc(line + '\n'));
  }
  assert.ok(s.pendingChars <= 64, 'the streamer kept its own promise…');
  assert.ok(fake.overruns > 0, '…and the controller’s buffer was trampled anyway');

  /* And nothing on the wire says so. grblHAL sets `rxbuf.overflow = 1`
   * (`usb_serial.c:258`) — a flag written in four places and read in none. */
  assert.equal(s.state, 'streaming', 'the sender has no idea: no error, no alarm, no report field');
  assert.equal(s.abort, null);
});
