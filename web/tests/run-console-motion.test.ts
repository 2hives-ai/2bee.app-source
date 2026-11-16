// 🔴 The Run tab console may not jog or home a REAL board (ops H5: no physical e-stop exists),
// and "the console" means what grblHAL will EXECUTE, not what was typed.
//
// Review r3, 2026-11-12, reproduced: `$ J=G91 X10 F500`, `$J =G91 X10 F500` and `$ H` were
// classified as plain lines and written to a real port, because the classifier matched the TYPED
// text (`upper === '$H'`, `upper.startsWith('$J=')`) while grblHAL's `system_execute_line`
// (grblhal/core/system.c:1127-1131) strips every space before the first `=` and upper-cases it.
// `$HZ` (single-axis homing, system.c:966-985) was never classified at all. And protocol.c strips
// control characters, honours BS/DEL as an edit (protocol.c:320-326) and splits on CR/LF before
// the line ever reaches that parser — so a typed line can carry a different command than it shows.
//
// Every case below is asked of `consoleAction` itself — the function one call away from the
// bytes — never of the wrapper in the component, which a node test cannot reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consoleAction,
  grblSystemCommand,
  realPortMotionRefusal,
  setRealPortConnectedForTest,
  startCommands,
  trackedForProgram,
  type RunProgram,
} from '../src/RunTab';
import { initialTrackedState, refusalsFor, type TrackedState } from '../src/run/protocol';

function connected(over: Partial<TrackedState> = {}): TrackedState {
  return { ...initialTrackedState(), tab: 'Idle', controllerState: 'Idle', ...over };
}
/** Homed, trusted, Idle — the state in which every jog/home refusal OTHER than H5 is clear, so
 *  an H5 that is missing cannot hide behind a different refusal that happened to fire. */
const permissive = connected({ homingSeen: true, homingEnabled: true, positionTrusted: true, positionUntrustedWhy: null });

/** Every spelling grblHAL executes as a jog or a homing cycle. One case per spelling. */
const MOTION_SPELLINGS = [
  '$J=G91 X10 F500',
  '$j=G91 X10 F500',
  '$ J=G91 X10 F500', // repro r3
  '$J =G91 X10 F500', // repro r3
  ' $  j  =G91 X10 F500',
  '$H', // the bare form the old classifier did catch
  '$h',
  '$ H', // repro r3
  '$H ',
  '$H=X', // `H` takes args and ignores them (system.c:510-513): still a full homing cycle
  '$HZ', // single-axis homing (system.c:966-968)
  '$hx',
  '$H Y',
  '$ h z',
  '$HA',
  '$HB',
  '$HC',
  '$HU',
  '$HV',
  '$HW',
  '$TPW', // tool_probe_workpiece (system.c:996): a probing move
  '$ t p w',
] as const;

/** Bytes protocol.c edits or acts on before the line parser sees the line. Each could make the
 *  board execute a different command from the one the console classified. */
const EDITED_SPELLINGS = [
  '$X\bJ=G91 X10 F500', // BS deletes the X (protocol.c:320-326): the board runs $J=
  '$X\u007fJ=G91 X10', // DEL, same
  '$\tJ=G91 X10', // a control char is dropped (protocol.c:292)
  '$$\n$H', // CR/LF ends a line (protocol.c:226): two commands in one input
  '$$\r$J=G91 X10',
  '$~H', // `~` is cycle start unless $ legacy-rt is off (protocol.c:839, 975+)
  '$?H',
  '$!H',
  '$\u0085H', // 0x80-0xBF are realtime commands (protocol.c:976)
  '$\u0018$H', // CAN
] as const;

test('🔴 on a REAL port, every jog / home / probe spelling grblHAL executes is refused with H5', () => {
  setRealPortConnectedForTest(true);
  try {
    for (const typed of MOTION_SPELLINGS) {
      const o = consoleAction(typed, permissive);
      assert.equal(o.kind, 'refused', `${JSON.stringify(typed)} must be refused on a real port, got ${o.kind}`);
      assert.ok(
        o.kind === 'refused' && o.refusals.some((r) => r.id === 'H5'),
        `${JSON.stringify(typed)} must carry H5`
      );
    }
  } finally {
    setRealPortConnectedForTest(false);
  }
});

test('🔴 a line grblHAL would edit, split or pick bytes out of is refused, on any port', () => {
  for (const real of [true, false]) {
    setRealPortConnectedForTest(real);
    try {
      for (const typed of EDITED_SPELLINGS) {
        const o = consoleAction(typed, permissive);
        assert.equal(o.kind, 'refused', `${JSON.stringify(typed)} (real=${real}) must be refused, got ${o.kind}`);
      }
    } finally {
      setRealPortConnectedForTest(false);
    }
  }
});

test('a spaced $J meets the same jog refusals as $J= (fake port, Alarm)', () => {
  const alarm = connected({ controllerState: 'Alarm', tab: 'Alarm' });
  const want = refusalsFor('jog', alarm).map((r) => r.id);
  assert.ok(want.length > 0, 'the control: Alarm must refuse a jog at all');
  for (const typed of ['$J=G91 X10 F500', '$ J=G91 X10 F500', '$J =G91 X10 F500', '$j=G91 X1']) {
    const o = consoleAction(typed, alarm);
    assert.deepEqual(o.kind === 'refused' ? o.refusals.map((r) => r.id) : o.kind, want, JSON.stringify(typed));
  }
});

test('single-axis homing meets the same gate as $H (fake port, Run)', () => {
  const running = connected({ controllerState: 'Run' });
  for (const typed of ['$H', '$HZ', '$ H', '$hx']) {
    const o = consoleAction(typed, running);
    assert.equal(o.kind, 'refused', JSON.stringify(typed));
    assert.equal(o.kind === 'refused' && o.refusals[0].id, '§15', JSON.stringify(typed));
  }
});

test('the control: reads still go through on a real port, and the line sent is the line typed', () => {
  setRealPortConnectedForTest(true);
  try {
    for (const typed of ['$$', '$I', '$G', '$#', '$HSS', '$HELP', '$ i', '$X']) {
      const o = consoleAction(typed, permissive);
      assert.equal(o.kind, 'line', `${typed} is a read/unlock and must still be sent`);
      assert.equal(o.kind === 'line' && o.line, typed.trim());
    }
  } finally {
    setRealPortConnectedForTest(false);
  }
  /* On a fake port the motion spellings still go out (the fake is how the tab is tested). */
  for (const typed of ['$J=G91 X10 F500', '$ J=G91 X10 F500', '$HZ']) {
    assert.equal(consoleAction(typed, permissive).kind, 'line', `${typed} on a fake port`);
  }
});

test('grblSystemCommand mirrors system_execute_line: spaces dropped and caps BEFORE the first =, args verbatim', () => {
  assert.deepEqual(grblSystemCommand('$ j =G91 x10'), { ok: true, name: 'J', args: 'G91 x10' });
  assert.deepEqual(grblSystemCommand('$h z'), { ok: true, name: 'HZ', args: null });
  assert.deepEqual(grblSystemCommand('$10=511'), { ok: true, name: '10', args: '511' });
  assert.deepEqual(grblSystemCommand('$n0=G0 X1'), { ok: true, name: 'N0', args: 'G0 X1' });
  assert.equal(grblSystemCommand('$X\bJ=').ok, false);
});

test('$N0= / $N1= store g-code that runs at every reset: refused like typed g-code', () => {
  for (const typed of ['$N0=G0 Z-50', '$ n1 = G1 X5 F100']) {
    const o = consoleAction(typed, permissive);
    assert.equal(o.kind, 'refused', typed);
    assert.deepEqual(
      o.kind === 'refused' ? o.refusals.map((r) => r.id) : [],
      refusalsFor('console-gcode', permissive).map((r) => r.id)
    );
  }
  assert.equal(consoleAction('$N', permissive).kind, 'line', '$N only lists the startup lines');
});

test('🔴 PLANT — a classifier loosened back to the typed text lets the spaced forms through', () => {
  setRealPortConnectedForTest(true);
  try {
    const leaked = MOTION_SPELLINGS.filter(
      (t) => consoleAction(t, permissive, {}, 'console-classifier-loose').kind === 'line'
    );
    const leakedBytes = EDITED_SPELLINGS.filter(
      (t) => consoleAction(t, permissive, {}, 'console-classifier-loose').kind === 'line'
    );
    /* The tests above would be red under this plant: these are exactly the cases they refuse. */
    for (const t of ['$ J=G91 X10 F500', '$J =G91 X10 F500', '$ H', '$HZ', '$TPW'])
      assert.ok(leaked.includes(t as (typeof MOTION_SPELLINGS)[number]), `plant must leak ${t}`);
    assert.ok(leakedBytes.includes('$X\bJ=G91 X10 F500'), 'plant must leak the BS edit');
    assert.ok(!leaked.includes('$J=G91 X10 F500'), 'the plant is the OLD classifier, which caught the exact form');
  } finally {
    setRealPortConnectedForTest(false);
  }
});

const READY_PROGRAM: RunProgram = {
  name: 'plate',
  hash: 'f00d-42',
  rapidRate: 3000,
  lines: ['G17 G21 G90 G54 G94 G40', 'G0 Z5.000', 'G0 X0.000 Y0.000', 'M3 S18000', 'G1 Z-2.000 F300.0', 'M5', 'M2'],
  path: [
    { x: 0, y: 0, z: 5, feed: 0, rapid: true, line: -1 },
    { x: 0, y: 0, z: -2, feed: 300, rapid: false, line: -1 },
  ],
};

test('🔴 startCommands refuses on a REAL port with H5 — at the bytes, not only at the button', () => {
  const ready = trackedForProgram(
    connected({
      homingSeen: true,
      homingEnabled: true,
      positionTrusted: true,
      positionUntrustedWhy: null,
      wcoKnown: true,
      currentWorkZ: 5,
      programDirty: false,
      reportUnits: 'mm',
      measuredRxBuffer: 1024,
      identification: 'grblHAL',
    }),
    READY_PROGRAM
  );
  assert.equal(startCommands(READY_PROGRAM, ready).status, 'ok', 'the control: fake port, every precondition met');
  setRealPortConnectedForTest(true);
  try {
    const o = startCommands(READY_PROGRAM, ready);
    assert.equal(o.status, 'refused');
    assert.ok(o.status === 'refused' && o.refusals.some((r) => r.id === 'H5'));
    assert.match(o.status === 'refused' ? o.why : '', /H5/);
    /* The plant that skips the R-refusals must NOT skip H5: no plant may stream to a real board. */
    assert.equal(startCommands(READY_PROGRAM, ready, 'start-ignores-refusals').status, 'refused');
  } finally {
    setRealPortConnectedForTest(false);
  }
});

test('🔴 the Jog / Home buttons write path meets H5 at the bytes too (realPortMotionRefusal)', () => {
  assert.equal(realPortMotionRefusal('$J=G91 X10 F500'), null, 'the control: fake port');
  setRealPortConnectedForTest(true);
  try {
    for (const line of ['$J=G91 X10 F500', '$H', '$ H', '$HZ', '$TPW', '$X\bJ=G91 X1'])
      assert.equal(realPortMotionRefusal(line)?.id, 'H5', JSON.stringify(line));
    for (const line of ['$$', '$I', '$X', '$HSS']) assert.equal(realPortMotionRefusal(line), null, line);
  } finally {
    setRealPortConnectedForTest(false);
  }
});
