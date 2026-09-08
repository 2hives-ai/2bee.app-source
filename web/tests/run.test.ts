// The Run tab's transport and its picture.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS SUITE CANNOT DO, SAID FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// **There is no browser on this box, no WebGL, no serial port and no machine.**
// The router is ordered and has not arrived. CDP 9222 is the founder's personal
// browser and is banned outright, reads included. So:
//
//   🔴 NOT COVERED, and each needs a real controller on a USB cable:
//      that `navigator.serial` behaves as the specification says; that a
//      `SerialPort` opened in a window appears at the same index in a worker's
//      `getPorts()`; that any byte written here is understood by grblHAL.
//
//   ✅ COVERED ELSEWHERE SINCE 2026-08-28: that `await reader.read()` survives
//      a hidden tab (gate branch `RUN-18`) — measured by `e2e/run18.spec.ts`
//      through a TEST-ONLY worker entry against `fake.ts` in a real browser:
//      hidden/visible throughput ratio 0.771, zero stall events. ⚠ Still not
//      covered: the same question against a real controller, and whether a
//      hidden page throttles the WORKER's own timers (the poll interval).
//
//   ✅ COVERED: that the pump agrees with `run/protocol.ts`'s reading of
//      grblHAL, driven through `run/fake.ts` at the BYTE boundary — the fake's
//      `Link` is the same `Link` the Web Serial transport implements, so
//      framing, classification and character counting are all on the path and
//      none of them is stubbed; and that the tab renders the facts the design
//      requires, asserted on server-rendered markup.
//
// 🔴 **AND A GREEN HERE IS A GREEN ABOUT OUR OWN READING OF grblHAL.** The fake
// was written from grblHAL's source by this lane; it can show the sender is
// self-consistent with that reading and it can never discover the reading is
// wrong. `CTRL` and the physical rungs are what would prove anything more.
//
// ⚠ `createElement` rather than JSX, because `npm run test:node` globs
// `tests/*.test.ts` and a `.tsx` here would simply not be collected — and a test
// that is not collected is indistinguishable from one that passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  StreamPump,
  WebSerialLink,
  classifyPortError,
  encodeLine,
  lineCost,
  resolvePort,
  serialAvailability,
  type SerialPortLike,
} from '../src/run/transport.ts';
import { Streamer, parseStatusReport, realtimeBytes } from '../src/run/protocol.ts';
import { FakeController } from '../src/run/fake.ts';
import {
  Control,
  LISTEN_WINDOW_MS,
  OutstandingChars,
  ProgressCanvas,
  RunTab,
  StopPanel,
  abortResponse,
  applyStatusReport,
  afterVerdictCommands,
  connectCommands,
  controlRefusals,
  describeProbe,
  divergence,
  firstProgramZ,
  identifyProbeCommands,
  matchOnPath,
  measureBuffers,
  predictIndexAtTime,
  remainingSeconds,
  startCommands,
  streamingSignal,
  trackedForProgram,
  wiredActions,
  type Connection,
  type ControlId,
  type MeasuredBuffers,
  type RunProgram,
} from '../src/RunTab.tsx';
import {
  IDENTIFY_PROBE,
  PortOwnershipWatch,
  RING_ARTEFACT_CHARS,
  classifyInbound,
  identify,
  initialTrackedState,
  type TrackedState,
} from '../src/run/protocol.ts';

/* ════════════════════════════════════════════════════════════════════════════
   1. Feature detection and the four refusals of a port
   ════════════════════════════════════════════════════════════════════════════ */

test('Web Serial is feature-detected, and each way it can be absent says which', () => {
  assert.equal(serialAvailability(undefined, true).code, 'no-api');
  assert.equal(serialAvailability({}, true).code, 'no-api');
  const nav = { serial: {} as never };
  assert.equal(serialAvailability(nav, false).code, 'insecure-context');
  assert.equal(serialAvailability(nav, true).ok, true);

  /* The reason must name the browsers that work and must not offer a polyfill:
   * a serial port is not something JavaScript can shim, and a UI that suggests
   * otherwise sends someone looking for one. */
  assert.match(serialAvailability(undefined, true).reason, /Chrome or Edge/);
  assert.match(serialAvailability(undefined, true).reason, /no polyfill/);
});

test('a refused port is classified, because "could not open" throws away the fix', () => {
  const kinds = (name: string) => classifyPortError({ name });
  assert.equal(kinds('NotFoundError').kind, 'cancelled');
  assert.equal(kinds('NotFoundError').ours, false);
  assert.equal(kinds('SecurityError').kind, 'no-gesture');
  /* 🔴 A missing user gesture is OUR bug and must never reach an operator as
   * something they can act on. */
  assert.equal(kinds('SecurityError').ours, true);
  assert.equal(kinds('NotAllowedError').kind, 'blocked-by-policy');
  assert.equal(kinds('SomethingElse').kind, 'unknown');

  /* 🔴 THESE TWO WERE SWAPPED UNTIL 2026-08-11, on the one message the design
   * says is worth getting exactly right. Read at the primary sources:
   *
   *   · `InvalidStateError` is step 2 of open() — "If this.[[state]] is not
   *     "closed"" (<https://wicg.github.io/serial/>). `[[state]]` belongs to THIS
   *     SerialPort object in THIS page; Blink's string is literally "The port is
   *     already open." (`serial_port.cc`, kInvalidStateError). Nothing outside
   *     this page can move it, so it CANNOT mean another application — and it
   *     used to render as "already open in another tab or application (gSender,
   *     CNCjs…)", sending the operator to close a program that was not the
   *     problem.
   *   · The OS refusing the device is `NetworkError` — step 9, "Invoke the
   *     operating system to open the serial port … If this fails for ANY REASON
   *     … reject with a NetworkError"; Blink: "Failed to open serial port." So
   *     the real "another program holds it" case arrived as the message that
   *     said THE CABLE HAD BEEN UNPLUGGED. */
  assert.equal(kinds('InvalidStateError').kind, 'already-open-here');
  assert.equal(kinds('InvalidStateError').ours, true, 'this tab asking twice is OUR defect, not the operator’s situation');
  assert.doesNotMatch(
    kinds('InvalidStateError').message,
    /gSender|CNCjs|another tab/,
    'it must not send anyone off to close a program that cannot have caused it',
  );

  assert.equal(classifyPortError({ name: 'NetworkError' }, 'opening').kind, 'os-refused');
  assert.match(classifyPortError({ name: 'NetworkError' }, 'opening').message, /gSender|CNCjs/);
  assert.match(classifyPortError({ name: 'NetworkError' }, 'opening').message, /dialout/);
  assert.match(classifyPortError({ name: 'NetworkError' }, 'opening').message, /no longer plugged in/);

  /* ⚠ THE SAME NAME MEANS SOMETHING ELSE ONCE THE PORT IS OPEN. After open()
   * resolves, a NetworkError on the read loop is the port GOING, which is the
   * one reading the old code had right — for the wrong branch. */
  assert.equal(classifyPortError({ name: 'NetworkError' }, 'connected').kind, 'disconnected');
  assert.match(classifyPortError({ name: 'NetworkError' }, 'connected').message, /unplugged/);
  assert.notEqual(
    classifyPortError({ name: 'NetworkError' }, 'opening').message,
    classifyPortError({ name: 'NetworkError' }, 'connected').message,
    'if the two phases ever render the same, the parameter has stopped doing anything',
  );

  /* The default is the OPENING phase, because the one call site outside this
   * lane — RunTab.tsx's connect .catch — is the opening phase. Pinned so a
   * later "tidy-up" cannot flip it silently. */
  assert.equal(kinds('NetworkError').kind, 'os-refused');
});

test('🔴 the Web Serial API cannot claim a port, and the message must not imply it can', () => {
  /* Established at the primary sources on 2026-08-11, because the old string
   * ended "only one program may hold a serial port" — which is false on Linux
   * and is the assumption this lane's character counting rests on:
   *
   *   · The SPEC has no exclusivity concept at all. No `exclusive` option, no
   *     mention of other applications or processes. There is nothing to ask for.
   *   · Chromium claims it anyway on POSIX and only FORWARDS:
   *     `serial_io_handler_posix.cc` calls `ioctl(fd, TIOCEXCL)` in PostOpen(),
   *     and TIOCEXCL is "Put the terminal into exclusive mode. No further
   *     open(2) operations on the terminal are permitted. (They fail with EBUSY,
   *     except for a process with the CAP_SYS_ADMIN capability.)"
   *     (`man 2const TIOCEXCL`, read on this box.)
   *
   * ⇒ It stops the writer who arrives AFTER us and does nothing about the one
   * who was already there — whose fd is untouched and whose presence makes our
   * open() succeed with no error to classify. That is why detection exists and
   * why no message here may promise exclusivity. */
  for (const name of ['InvalidStateError', 'NetworkError', 'NotAllowedError']) {
    for (const phase of ['opening', 'connected'] as const) {
      assert.doesNotMatch(
        classifyPortError({ name }, phase).message,
        /only one program may hold/i,
        `${name}/${phase} must not promise an exclusivity the API does not have`,
      );
    }
  }
  /* And the one that CAN fire says which direction it works in, because an
   * operator who reads "another program is holding it" reasonably concludes the
   * reverse case is covered too. */
  assert.match(classifyPortError({ name: 'NetworkError' }, 'opening').message, /Note the direction/);
  assert.match(
    classifyPortError({ name: 'NetworkError' }, 'opening').message,
    /BEFORE this tab did is not refused/,
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   2. Encoding — the count and the wire must agree byte for byte
   ════════════════════════════════════════════════════════════════════════════ */

test('encodeLine puts exactly lineCost bytes on the wire', () => {
  for (const line of ['G0 X0 Y0', '', 'M3 S18000', 'G1 X-12.5 Y3.25 F1200']) {
    assert.equal(encodeLine(line).length, lineCost(line));
    assert.equal(encodeLine(line).at(-1), 0x0a);
  }
});

test('a non-ASCII character is refused rather than silently costing extra bytes', () => {
  /* `protocol.ts`'s Streamer charges `length + 1` CHARACTERS against the
   * controller's RX buffer. A multi-byte character would put more BYTES on the
   * wire than the count was charged for, and the count is the only thing
   * standing between the sender and an overrun. */
  assert.throws(() => encodeLine('G0 X0 ( 12° )'), /non-ASCII/);
});

test('RUN-4 — a realtime command goes out as ONE byte, not as UTF-8', async () => {
  const fake = new FakeController('healthy');
  const pump = new StreamPump({
    link: fake,
    streamer: new Streamer({ lines: [], mode: 'send-response', rxBufferSize: null }),
  });
  await pump.realtime('feedOverrideReset'); // 0x90
  const wires = fake.writes.filter((w) => w.length && w[0] >= 0x80);
  assert.equal(wires.length, 1);
  assert.deepEqual([...wires[0]], [0x90]);

  /* NEGATIVE CONTROL — the defect this asserts against, reintroduced. A
   * `TextEncoder` renders U+0090 as `0xC2 0x90`: the controller receives a byte
   * it does not recognise followed by one it does, and the symptom is "the
   * override button doesn't work sometimes". */
  const planted = realtimeBytes('feedOverrideReset', 'utf8-realtime');
  assert.deepEqual([...planted], [0xc2, 0x90]);
  assert.notDeepEqual([...planted], [0x90]);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. The pump against the fake controller
   ════════════════════════════════════════════════════════════════════════════ */

/** Give the microtask queue a chance to drain the pump's awaited writes. */
const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

test('RUN-1 — character counting never overruns the fake, over 5,000 lines', async () => {
  const fake = new FakeController('tiny-buffer', { autoExecute: true, bannerOnConnect: false });
  const lines = Array.from({ length: 5000 }, (_, i) => `G1 X${(i % 97) / 4} Y${i % 13} F1200`);
  const streamer = new Streamer({
    lines,
    mode: 'character-counting',
    // 🔴 MEASURED, not assumed: this is the number the fake actually reports in
    // `Bf`'s second figure. Guessing 128 (grbl's stream.py) or 1024 (grblHAL's
    // default) is the defect R13 exists for.
    rxBufferSize: fake.options.rxBufferSize,
  });
  const pump = new StreamPump({ link: fake, streamer });
  pump.attach();
  await pump.pump();
  await settle(200);

  assert.equal(fake.overruns, 0, 'the fake jams on overrun; a jam here is a real overrun');
  assert.equal(pump.state, 'done');
  assert.equal(pump.acknowledged, lines.length);
  assert.equal(fake.executed.length, lines.length);
});

test('RUN-3 — the first error: aborts the stream and nothing else is sent', async () => {
  const fake = new FakeController('rejects-a-line', { bannerOnConnect: false });
  const lines = Array.from({ length: 40 }, (_, i) => `G1 X${i} F600`);
  const pump = new StreamPump({
    link: fake,
    streamer: new Streamer({ lines, mode: 'send-response', rxBufferSize: null }),
  });
  pump.attach();
  await pump.pump();
  await settle(200);

  assert.equal(pump.state, 'aborted');
  assert.equal(pump.abort?.reason, 'error');
  /* 🔴 grblHAL poisons every line after an error and answers each with a COPY of
   * the same code about a line it never parsed (design F7). A streamer that
   * "keeps going to collect them all" collects one fact N times, and keeps a
   * machine moving through blocks that are being discarded. */
  const executedAfter = fake.executed.length;
  await pump.pump();
  await settle();
  assert.equal(fake.executed.length, executedAfter, 'no line may be sent after the abort');
  assert.match(pump.abort?.message ?? '', /error:20/);
});

test('RUN-13 — an async ALARM between replies aborts, and is not counted as one', async () => {
  const fake = new FakeController('healthy', { bannerOnConnect: false });
  const streamer = new Streamer({
    lines: ['G0 X1', 'G0 X2', 'G0 X3'],
    mode: 'send-response',
    rxBufferSize: null,
  });
  const pump = new StreamPump({ link: fake, streamer });
  pump.attach();
  // An ALARM arriving between line replies — not a reply, and it decrements
  // nothing. A parser that only inspects replies misses it entirely.
  pump.accept('ALARM:5');
  assert.equal(pump.state, 'aborted');
  assert.equal(pump.abort?.reason, 'alarm');
  assert.equal(pump.acknowledged, 0, 'an alarm is not a line reply');
});

test('RUN-2 — status reports and messages are not replies', async () => {
  const fake = new FakeController('healthy', { bannerOnConnect: false });
  const streamer = new Streamer({
    lines: ['G0 X1', 'G0 X2'],
    mode: 'character-counting',
    rxBufferSize: 1024,
  });
  const pump = new StreamPump({ link: fake, streamer });
  pump.accept('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
  pump.accept('[MSG:Hello]');
  pump.accept('GrblHAL 1.1f [\'$\' or \'$HELP\' for help]');
  assert.equal(pump.acknowledged, 0);
  assert.equal(pump.state, 'ready', 'nothing above was an answer to a line we sent');
});

test('RUN-16 — a line split across two reads still parses as one line', async () => {
  /* A serial read boundary falls anywhere. A parser that assumes one read is one
   * line works perfectly against a naive fake and fails against a real CDC
   * endpoint under load — so the fake is configured to split. */
  const fake = new FakeController('healthy', { splitEvery: 3, bannerOnConnect: false });
  const seen: string[] = [];
  const pump = new StreamPump({
    link: fake,
    streamer: new Streamer({ lines: ['G0 X1'], mode: 'send-response', rxBufferSize: null }),
    onEvent: (e) => {
      if (e.t === 'inbound') seen.push(e.line ?? '');
    },
  });
  pump.attach();
  await pump.pump();
  await settle(100);
  assert.ok(seen.includes('ok'), `expected a whole "ok" among ${JSON.stringify(seen)}`);
  assert.equal(pump.acknowledged, 1);
});

test('R13 — character counting with no measured buffer refuses, it does not guess', () => {
  assert.throws(
    () => new Streamer({ lines: ['G0 X1'], mode: 'character-counting', rxBufferSize: null }),
    /MEASURED/
  );
  // send-response needs no measurement, and is the declared fallback.
  assert.doesNotThrow(
    () => new Streamer({ lines: ['G0 X1'], mode: 'send-response', rxBufferSize: null })
  );
});

test('the starvation key is the SENDER, and it is a clock the caller injects', async () => {
  /* 🔴 Keyed on the sender failing to write — never on the planner being empty.
   * Our post emits `G4 P<spinup>` after every `M3` and `mc_dwell` drains the
   * planner before delaying (design F5), so a planner-empty detector false-fires
   * at every spindle start, and a control that false-fires gets muted. */
  let clock = 1000;
  const fake = new FakeController('healthy', { bannerOnConnect: false, autoExecute: false });
  const pump = new StreamPump({
    link: fake,
    streamer: new Streamer({ lines: ['G0 X1', 'G0 X2'], mode: 'send-response', rxBufferSize: null }),
    now: () => clock,
  });
  pump.attach();
  await pump.pump();
  await settle();
  assert.equal(pump.sinceLastWrite(), 0);
  clock += 5000;
  assert.equal(pump.sinceLastWrite(), 5000);
});

test('the RUN-18 instrument exists (the hidden-tab measurement is e2e/run18.spec.ts)', async () => {
  let clock = 0;
  const fake = new FakeController('healthy', { bannerOnConnect: false });
  const pump = new StreamPump({
    link: fake,
    streamer: new Streamer({ lines: ['G0 X1', 'G0 X2'], mode: 'character-counting', rxBufferSize: 1024 }),
    now: () => (clock += 100),
  });
  pump.attach();
  await pump.pump();
  await settle(100);
  const t = pump.throughput;
  assert.ok(t.bytes > 0);
  assert.ok(t.ms > 0);
  /* This asserts the INSTRUMENT, not the measurement. The measurement —
   * `RUN-18`, throughput with `document.visibilityState === 'hidden'` — was
   * taken 2026-08-28 by `e2e/run18.spec.ts` against `fake.ts` through a
   * test-only worker entry, with the product byte-identical. What that green
   * means and does not mean is in the spec's own header. */
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The Web Serial link, against a stream-shaped stand-in
   ════════════════════════════════════════════════════════════════════════════ */

function fakePort(): { port: SerialPortLike; written: number[][]; feed: (b: number[]) => void } {
  const written: number[][] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push([...chunk]);
    },
  });
  return {
    written,
    feed: (b) => controller?.enqueue(Uint8Array.from(b)),
    port: {
      readable,
      writable,
      open: async () => undefined,
      close: async () => undefined,
      getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
    },
  };
}

test('the link reads before it writes, and writes exactly the bytes it is given', async () => {
  const { port, written, feed } = fakePort();
  const link = new WebSerialLink(port);
  const chunks: number[][] = [];
  link.onData((c) => chunks.push([...c]));
  await link.open();
  feed([0x6f, 0x6b, 0x0a]); // "ok\n"
  await settle(20);
  assert.deepEqual(chunks, [[0x6f, 0x6b, 0x0a]]);

  await link.write(Uint8Array.of(0x90));
  await settle(20);
  assert.deepEqual(written, [[0x90]], 'no re-encoding anywhere on the write path');
});

test('a port the worker cannot identify is refused, never opened anyway', async () => {
  const a = fakePort().port;
  const serial = {
    getPorts: async () => [a],
    requestPort: async () => a,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const ok = await resolvePort(serial, { portIndex: 0, usbVendorId: 0x0483, usbProductId: 0x5740 });
  assert.ok('port' in ok);

  const missing = await resolvePort(serial, { portIndex: 3 });
  assert.ok('error' in missing);

  /* 🔴 The index is an assumption about two realms agreeing on an ordering the
   * spec does not guarantee across them. A mismatch is a REFUSAL: the cost of
   * being wrong is a program streamed to whatever else is plugged in. */
  const wrong = await resolvePort(serial, { portIndex: 0, usbVendorId: 0x1234, usbProductId: 0x5678 });
  assert.ok('error' in wrong);
  assert.match((wrong as { error: { message: string } }).error.message, /different device/);
});

/* ════════════════════════════════════════════════════════════════════════════
   5. The DRO — the two ways it lies, both silent
   ════════════════════════════════════════════════════════════════════════════ */

function reportOf(line: string) {
  const { report, error } = parseStatusReport(line);
  assert.equal(error, null, `the fixture must parse: ${String(error)}`);
  return report!;
}

test('RUN-5 — with no WCO yet, the work DRO is a dash and a reason, never 0.000', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      report: reportOf('<Idle|MPos:-100.000,-200.000,-5.000|FS:0,0>'),
      lastWco: null,
      tracked: connected(),
      now: 1_000,
    })
  );
  const work = section(html, 'run-dro-work');
  assert.doesNotMatch(work, /0\.000/, 'a zero is a number and reads as a measurement');
  assert.match(work, /—/);
  assert.match(work, /WCO/);
  // And the machine column, which IS derivable, still shows numbers.
  assert.match(section(html, 'run-dro-machine'), /-100\.000/);
});

test('RUN-6 — when the controller reports WPos, WCO is not subtracted a second time', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      report: reportOf('<Idle|WPos:10.000,20.000,3.000|WCO:-100.000,-200.000,-25.000|FS:0,0>'),
      tracked: connected(),
      now: 1_000,
    })
  );
  const work = section(html, 'run-dro-work');
  assert.match(work, /10\.000\s+20\.000\s+3\.000/);
  /* Subtracting again would give 110/220/28 — the DRO displaced by the entire
   * offset, which on a homed router is most of the table. */
  assert.doesNotMatch(work, /110\.000/);
  assert.match(section(html, 'run-dro-machine'), /-90\.000/); // 10 + (-100)
});

/* ════════════════════════════════════════════════════════════════════════════
   6. The picture — a prediction and a measurement must not be the same mark
   ════════════════════════════════════════════════════════════════════════════ */

const PROGRAM: RunProgram = {
  name: 'coupon',
  hash: 'abc123',
  rapidRate: 3000,
  lines: ['G0 X0 Y0', 'G1 X10 F600', 'G1 Y10 F600', 'G1 X0 F600'],
  path: [
    { x: 0, y: 0, z: 0, feed: 600, rapid: true, line: 0 },
    { x: 10, y: 0, z: 0, feed: 600, rapid: false, line: 1 },
    { x: 10, y: 10, z: 0, feed: 600, rapid: false, line: 2 },
    { x: 0, y: 10, z: 0, feed: 600, rapid: false, line: 3 },
  ],
};

/**
 * The check `RUN-17` is: are the two markers distinguishable **without colour**?
 *
 * Written as a function so it can be run against the real render (must pass) and
 * against a planted one (must fail). A check nobody has watched go red is not a
 * check.
 */
export function markerProblems(svg: string): string[] {
  const problems: string[] = [];
  const measured = /data-mark="measured"[^>]*/.exec(svg)?.[0];
  const predicted = /data-mark="predicted"[^>]*/.exec(svg)?.[0];
  if (!measured) problems.push('no measured marker');
  if (!predicted) problems.push('no predicted marker');
  if (!measured || !predicted) return problems;
  const fillOf = (s: string) => /data-fill="([^"]+)"/.exec(s)?.[1];
  const shapeOf = (s: string) => /data-shape="([^"]+)"/.exec(s)?.[1];
  if (fillOf(measured) === fillOf(predicted)) problems.push('same fill');
  if (shapeOf(measured) === shapeOf(predicted)) problems.push('same shape');
  return problems;
}

test('RUN-17 — the predicted and measured markers differ in fill AND in shape', () => {
  const svg = renderToStaticMarkup(
    h(ProgressCanvas, { program: PROGRAM, matched: 1, predicted: 2 })
  );
  assert.deepEqual(markerProblems(svg), []);
  assert.match(svg, /fill="none"/); // the prediction is an outline
  assert.match(svg, /stroke-dasharray/);

  /* 🔴 NEGATIVE CONTROL: the defect, planted. Two identical marks — which is
   * exactly what a well-meaning "make them consistent" edit produces — and the
   * check must go red. Distinguishing them by colour alone would pass a
   * screenshot and fail in a sunlit shed and in a colourblind eye. */
  const planted = svg
    .replace('data-mark="predicted"', 'data-mark="predicted" x-was="rect"')
    .replace(/data-mark="predicted"([^>]*)data-fill="none" data-shape="square"/, 'data-mark="predicted"$1data-fill="solid" data-shape="circle"');
  assert.deepEqual(
    markerProblems(planted).sort(),
    ['same fill', 'same shape'],
    'the plant must trip the fill AND the shape check — if it trips "no predicted marker" instead, ' +
      'the plant broke the markup rather than reintroducing the defect, and proves nothing'
  );
});

test('the legend claims passage, not removal', () => {
  const html = renderToStaticMarkup(h(RunTab, { program: PROGRAM, tracked: connected(), now: 0 }));
  const legend = section(html, 'run-legend');
  assert.match(legend, /tool has passed here/);
  /* The DRO is where the controller THINKS the tool is. After a hard limit or a
   * killed reset it is wrong and says nothing about it — so this line may not
   * claim material was removed. That claim is `P9`'s and it is a different one. */
  assert.doesNotMatch(legend, /material was removed here[^”]*\.<\/strong>/);
  assert.match(legend, /not the same claim/);
});

test('Remaining is a dash when the tool cannot be located on the path', () => {
  // Matched: an estimate exists.
  assert.ok((remainingSeconds(PROGRAM, 1, 100) ?? 0) > 0);
  // Unmatched: no estimate at all, rather than a number invented in TypeScript.
  assert.equal(remainingSeconds(PROGRAM, null, 100), null);

  const html = renderToStaticMarkup(
    h(RunTab, {
      program: PROGRAM,
      report: reportOf('<Idle|WPos:900.000,900.000,900.000|FS:0,0>'),
      tracked: connected(),
      now: 0,
    })
  );
  assert.match(section(html, 'run-remaining'), /Remaining —/);
  assert.match(section(html, 'run-divergence'), /not on the programmed path/);
});

test('the match is constrained forward, so a path that crosses itself cannot snap back', () => {
  const crossing: RunProgram = {
    ...PROGRAM,
    path: [
      { x: 0, y: 0, z: 0, feed: 600, rapid: false, line: 0 },
      { x: 10, y: 0, z: 0, feed: 600, rapid: false, line: 1 },
      { x: 0, y: 0, z: 0, feed: 600, rapid: false, line: 2 },
    ],
  };
  assert.equal(matchOnPath(crossing.path, [0, 0, 0], 0, 2), 0);
  assert.equal(matchOnPath(crossing.path, [0, 0, 0], 1, 2), 2, 'from index 1 the only 0,0,0 ahead is index 2');
  assert.equal(matchOnPath(crossing.path, [50, 50, 0], 0, 2), null, 'out of tolerance is a failure, not a snap');
});

test('the divergence is a signed number with a named cause, per cause', () => {
  const base = { predictedSeconds: 10, measuredSeconds: 20, senderStalled: false, matched: 1 };
  assert.equal(divergence({ ...base, feedOverridePct: 60 }).cause, 'override');
  assert.equal(divergence({ ...base, feedOverridePct: 100, senderStalled: true }).cause, 'starvation');
  assert.equal(divergence({ ...base, feedOverridePct: 100 }).cause, 'model');
  assert.equal(divergence({ ...base, feedOverridePct: 100, matched: null }).cause, 'model');
  assert.equal(
    divergence({ predictedSeconds: 10, measuredSeconds: 10.2, feedOverridePct: 100, senderStalled: false, matched: 1 })
      .cause,
    'none'
  );
  const d = divergence({ ...base, feedOverridePct: 60 });
  assert.equal(d.signedSeconds, 10);
  assert.match(d.text, /behind/);
});

test('the prediction walks the program at its own feeds and rapids run at rapid rate', () => {
  // 10 mm at 600 mm/min = 1 s; a rapid of the same length at 3000 = 0.2 s.
  assert.equal(predictIndexAtTime(PROGRAM, 0.1, 100), 1);
  assert.equal(predictIndexAtTime(PROGRAM, 100, 100), PROGRAM.path.length - 1);
  assert.equal(predictIndexAtTime(null, 5, 100), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   7. The stop control — the copy IS the safety property
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Everything wrong with a rendering of the stop control.
 *
 * The plant below runs this against markup that claims to be an emergency stop,
 * which is the failure this whole panel exists to prevent: a person who believes
 * the button is a safety device will use it as one, once, in the moment it
 * cannot work.
 */
export function stopCopyProblems(html: string): string[] {
  const problems: string[] = [];
  if (!/not an emergency stop/i.test(html)) problems.push('does not deny being an emergency stop');
  if (!/does not cut power/i.test(html)) problems.push('does not say it cuts no power');
  if (!/physical emergency stop/i.test(html)) problems.push('does not point at the physical device');
  const estops = html.match(/E-STOP/g) ?? [];
  if (estops.length !== 1) problems.push(`E-STOP appears ${estops.length} times, expected exactly 1`);
  if (!/never labelled E-STOP|ever labelled E-STOP/.test(html)) {
    problems.push('the one E-STOP is not the sentence banning it');
  }
  if (/>\s*E-STOP\s*</.test(html)) problems.push('E-STOP is a control label');
  return problems;
}

test('the stop control refuses to be an emergency stop, permanently and in the markup', () => {
  const html = renderToStaticMarkup(
    h(StopPanel, { stopRefusals: [], abortRefusals: [] })
  );
  assert.deepEqual(stopCopyProblems(html), []);

  /* The line is PERMANENT — not a tooltip, not a modal that is dismissed once.
   * `title` attributes and `<details>` both hide text behind an interaction, and
   * this sentence may never be behind one. */
  const permanent = section(html, 'run-stop-permanent');
  assert.match(permanent, /not an emergency stop/);
  assert.doesNotMatch(html, /<details/, 'the limits are rendered, not folded away');

  /* What Stop does not guarantee, all present.
   *
   * ⚠ SCOPED TO STOP SINCE 2026-08-11, and the count went with the scope. The
   * heading read *"Seven things Stop does not guarantee"* over a list whose
   * sixth bullet was about **Abort** — a different control, a different byte
   * (`0x18` vs `!`), a different confirmation and a different cost. The bullet
   * was not deleted: it leads `run-abort-cost` below, and the assertion for it
   * moved there with it.
   *
   * 🔴 The literal `7` that stood here is gone rather than corrected to `6`,
   * because a hardcoded count beside a literal list is the defect twice — once
   * in the component and once in the test that blesses it. What is asserted is
   * that every named limit is present and that the heading states no number it
   * would have to be kept in step with. */
  const limits = section(html, 'run-stop-limits');
  for (const needle of [
    /cuts power to nothing/i,
    /USB link alive/i,
    /browser to be scheduled/i,
    /grblHAL alive/i,
    /lost steps/i,
    /spins down over seconds/i,
  ]) {
    assert.match(limits, needle);
  }
  assert.doesNotMatch(
    limits,
    /does not decelerate/i,
    'an Abort limit is back under a heading scoped to Stop'
  );
  assert.doesNotMatch(
    limits,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+things\b/i,
    'the heading states a count that nothing keeps in step with the list under it'
  );

  /* Abort is a SEPARATE control, leads with what it costs, and quotes grblHAL's
   * own consequence sentence rather than a paraphrase — grblHAL's sentences
   * already say the dangerous part. */
  assert.match(html, /Abort \(soft reset\)/);
  const abort = section(html, 'run-abort-cost');
  assert.match(abort, /does not decelerate/i, 'the Abort deceleration fact reached no panel');
  assert.match(abort, /Machine position is likely lost due to sudden halt/);
});

test('PLANT — a Stop that claims to be an e-stop must go red', () => {
  const html = renderToStaticMarkup(h(StopPanel, { stopRefusals: [], abortRefusals: [] }));
  /* Two plants, because they are two different lies and only one of them is
   * about the word: a button LABELLED E-STOP, and copy that promises power is
   * cut. */
  const labelled = html.replace('>Stop<', '>E-STOP<');
  assert.notEqual(labelled, html, 'the plant must actually change the markup');
  assert.deepEqual(stopCopyProblems(labelled).sort(), [
    'E-STOP appears 2 times, expected exactly 1',
    'E-STOP is a control label',
  ]);

  const promising = html.replace(
    /It is not an emergency stop and does not cut power\./,
    'It is the emergency stop and it cuts power.'
  );
  assert.notEqual(promising, html, 'the plant must actually change the markup');
  assert.deepEqual(stopCopyProblems(promising), [
    'does not deny being an emergency stop',
    'does not say it cuts no power',
  ]);
});

test('the whole tab carries the E-STOP word exactly once', () => {
  const html = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  assert.deepEqual(stopCopyProblems(html), []);
});

/* ════════════════════════════════════════════════════════════════════════════
   8. Refusals — a disabled control that says why
   ════════════════════════════════════════════════════════════════════════════ */

/** A tracked state that is connected and otherwise knows nothing. */
function connected(over: Partial<TrackedState> = {}): TrackedState {
  return { ...initialTrackedState(), tab: 'Idle', controllerState: 'Idle', ...over };
}

/** A state in which every precondition for streaming has been met. */
function readyToCut(over: Partial<TrackedState> = {}): TrackedState {
  return connected({
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
    measuredRxBuffer: 1024,
    /* The handshake got a positive identification. Without it R1 stands on
     * identification alone, which is a different refusal from the homing one
     * this test is about — and a plant that fires for the wrong reason proves
     * nothing. */
    identification: 'grblHAL',
    ...over,
  });
}

test('a fresh connection refuses to start, and says which facts are missing', () => {
  const html = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  const start = section(html, 'run-control-start');
  assert.match(start, /disabled/);
  assert.match(start, /data-refused="[^"]*R1[^"]*"/);

  /* 🔴 The reason is in the MARKUP, not only in a `title`. A disabled button
   * whose reason lives in a tooltip is a control that fails silently for anyone
   * on a touch screen or a keyboard — which in a shop is most people, because
   * the other hand is on the machine. */
  const reason = section(html, 'run-refused-start');
  assert.match(reason, /R1/);
  assert.match(reason, /\$H/);
  assert.match(reason, /R2/);
});

test('PLANT — streaming permitted with no homing evidence must go red', () => {
  /* The assertion above is only worth something if it can pass. Here is the
   * state in which it does: everything established, Start live. */
  const ready = renderToStaticMarkup(h(RunTab, { tracked: readyToCut(), now: 0 }));
  const liveStart = section(ready, 'run-control-start');
  assert.doesNotMatch(liveStart, /disabled/, 'the refusal must be about the facts, not permanent');

  /* 🔴 THE PLANT: the same state with homing evidence removed. If a future edit
   * lets Start through here, THIS is the assertion that goes red — and the
   * failure it guards is a job streamed at a machine whose coordinates are
   * whatever they were at power-on, because grblHAL's own homing lock is
   * optional ($22 bits 2 and 6) and the controller will accept the job. */
  const unhomed = renderToStaticMarkup(
    h(RunTab, { tracked: readyToCut({ homingSeen: false }), now: 0 })
  );
  const blocked = section(unhomed, 'run-control-start');
  assert.match(blocked, /disabled/);
  assert.match(section(unhomed, 'run-refused-start'), /R1/);

  /* And the same via the pure path, so the plant is visible at the decision and
   * not only at the pixel: `protocol.ts`'s own `stream-unhomed` plant removes
   * R1/R2 and the control would then be offered. */
  assert.ok(controlRefusals('start', readyToCut({ homingSeen: false })).some((r) => r.id === 'R1'));
});

test('0x85 is refused outside Jog, and 0x9E outside Hold', () => {
  const idle = connected({ controllerState: 'Idle' });
  const jogCancel = controlRefusals('jog-cancel', idle);
  assert.ok(jogCancel.length > 0, 'jog-cancel flushes the RX buffer; outside Jog it desynchronises the count');
  const spindleStop = controlRefusals('spindle-stop', idle);
  assert.ok(spindleStop.some((r) => r.id === '0x9E' || /HOLD|Hold/.test(r.why)));

  const held = connected({ controllerState: 'Hold', tab: 'Held' });
  assert.equal(
    controlRefusals('spindle-stop', held).filter((r) => r.id === '0x9E').length,
    0,
    'in Hold the spindle-stop override is exactly what grblHAL permits'
  );
});

test('Home is offered from Alarm — that is the recovery path — and Zero is not', () => {
  const alarm = connected({ controllerState: 'Alarm', tab: 'Alarm' });
  assert.deepEqual(controlRefusals('home', alarm), []);
  assert.ok(controlRefusals('zero', alarm).length > 0);
});

test('nothing but Connect is offered while disconnected', () => {
  const s = initialTrackedState();
  assert.deepEqual(controlRefusals('connect', s), []);
  for (const c of [
    'identify',
    'start',
    'hold',
    'stop',
    'home',
    'zero',
    'unlock',
    'jog',
  ] as const) {
    assert.ok(controlRefusals(c, s).length > 0, `${c} must be refused while disconnected`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   8b. 🔴 NOT ONE BYTE BEFORE A VERDICT

   Until 2026-08-11 the connect path wrote `$I`, realtime `0x87` and `$$`
   unconditionally, then waited two seconds and asked what it was talking to.
   Those bytes were called harmless on the strength of what grblHAL does with
   them — and the board on the bench identifies itself over USB as
   `BLACK_F407VE CDC in FS Mode`, which is the Arduino core for STM32, not
   grblHAL (whose `usbd_desc.c` hardcodes `STM32 Virtual ComPort`). "Harmless"
   was an assumption, not a measurement.
   ════════════════════════════════════════════════════════════════════════════ */

test('🔴 opening the port writes NOTHING — the connect command list is empty', () => {
  assert.deepEqual([...connectCommands()], []);
  /* Asserted as a PROPERTY rather than as a length, so a `poll` or a `load`
   * added here later fails this too: no command that reaches the wire may be
   * issued before something has been identified. */
  for (const c of connectCommands()) {
    assert.ok(false, `connect must issue nothing before a verdict; it issued ${JSON.stringify(c)}`);
  }
});

test('PLANT probe-unasked — the pre-fix handshake, restored, and it still reaches the wire', () => {
  const planted = connectCommands('probe-unasked');
  assert.notDeepEqual([...planted], [...connectCommands()], 'the plant plants nothing — it is inert');
  assert.deepEqual([...planted], [...identifyProbeCommands()]);
  // Exactly the historical three, in the historical order.
  assert.deepEqual(planted.map((c) => (c.t === 'write' ? c.line : c.t === 'realtime' ? c.name : c.t)), [
    '$I',
    'statusReportAll',
    '$$',
  ]);
});

test('what the operator is SHOWN is what would be SENT, step for step', () => {
  /* Consent to bytes nobody listed is not consent. The two lists are built in
   * different files and this is the only place they are compared. */
  const sent = identifyProbeCommands();
  assert.equal(sent.length, IDENTIFY_PROBE.length);
  assert.equal(sent[0].t === 'write' && sent[0].line, '$I');
  assert.match(IDENTIFY_PROBE[0].bytes, /^\$I/);
  assert.equal(sent[1].t === 'realtime' && sent[1].name, 'statusReportAll');
  assert.match(IDENTIFY_PROBE[1].bytes, /0x87/);
  assert.equal(sent[2].t === 'write' && sent[2].line, '$$');
  assert.match(IDENTIFY_PROBE[2].bytes, /^\$\$/);

  const offer = describeProbe();
  for (const step of IDENTIFY_PROBE) assert.ok(offer.includes(step.bytes), `${step.bytes} unlisted`);
  assert.match(offer, /RESET or power-cycle/, 'the zero-risk alternative must be in the offer');
});

test('the settings read happens AFTER a verdict, and never on a refusal', () => {
  const hal = afterVerdictCommands(identify(['<Idle|MPos:0,0,0|FW:grblHAL>']));
  assert.deepEqual(
    hal.map((c) => (c.t === 'write' ? c.line : c.t === 'realtime' ? c.name : c.t)),
    ['statusReportAll', '$$']
  );

  /* grbl 1.1 has no `0x87`; this branch is reached exactly because the board
   * said it is not grblHAL, so sending grblHAL's realtime byte here would be
   * the same mistake one verdict later. */
  const grbl = afterVerdictCommands(identify(["Grbl 1.1f ['$' for help]"]));
  assert.deepEqual(
    grbl.map((c) => (c.t === 'write' ? c.line : c.t)),
    ['$$']
  );

  for (const refused of [identify([]), identify(['echo:Marlin 2.1.2']), identify(['nonsense'])]) {
    assert.deepEqual([...afterVerdictCommands(refused)], [], 'a refusal queues no bytes');
  }
});

test('🔴 the probe control is refused everywhere except the one state that offers it', () => {
  const silent = connected({ tab: 'Identifying', awaitingIdentifyConsent: true });
  assert.deepEqual(controlRefusals('identify', silent), []);

  // Still listening: writing over the window is how a banner gets lost.
  assert.ok(controlRefusals('identify', connected({ tab: 'Identifying' })).length > 0);
  // Already identified: there is nothing left to ask.
  const known = connected({ identification: 'grblHAL' });
  const why = controlRefusals('identify', known)[0]?.why ?? '';
  assert.match(why, /already identified itself as grblHAL/);
  // And a stale `true` may not survive an identification.
  assert.deepEqual(
    controlRefusals('identify', connected({ identification: 'grblHAL' })).length > 0,
    true
  );
});

test('the probe is wired to a real call, not drawn and inert', () => {
  const calls: string[] = [];
  const map = wiredActions({
    conn: recordingConn(calls),
    program: null,
    tracked: connected({ tab: 'Identifying', awaitingIdentifyConsent: true }),
    awaitingAbortConfirm: false,
    setAwaitingAbortConfirm: () => undefined,
  });
  assert.ok(map.identify, 'the control would render disabled with nothing behind it');
  map.identify?.();
  assert.deepEqual(calls, ['identifyNow']);
});

test('a silent controller is explained to the operator with the bytes, not probed silently', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      tracked: connected({ tab: 'Identifying', awaitingIdentifyConsent: true }),
      now: 0,
    })
  );
  const box = section(html, 'run-identify-consent');
  assert.match(box, new RegExp(`no bytes arrived in ${LISTEN_WINDOW_MS / 1000} seconds`));
  assert.match(box, /only at power-on/, 'silence must be explained rather than concluded from');
  assert.match(box, /reset or power-cycle the controller/i);

  const bytes = section(html, 'run-identify-bytes');
  for (const step of IDENTIFY_PROBE) {
    const shown = step.bytes.replace(/&/g, '&amp;').replace(/\$/g, '$');
    assert.ok(
      bytes.includes(shown.split(' ')[0]),
      `the consent screen does not name ${step.bytes}`
    );
  }
  const risk = section(html, 'run-identify-risk');
  assert.match(risk, /not a universal no-op/);
  assert.match(risk, /prefixes a parameter/);

  // 🔴 The offer does not permit anything: nothing that streams is unlocked.
  assert.ok(
    controlRefusals('start', connected({ tab: 'Identifying', awaitingIdentifyConsent: true }))
      .length > 0
  );
});

test('the consent block is absent whenever there is nothing to consent to', () => {
  for (const t of [initialTrackedState(), connected(), connected({ identification: 'grblHAL' })]) {
    const html = renderToStaticMarkup(h(RunTab, { tracked: t, now: 0 }));
    assert.equal(
      html.includes('data-testid="run-identify-consent"'),
      false,
      'an offer nobody made is a control that writes to an identified board'
    );
  }
});

test('a control renders its refusal reason and cannot be pressed', () => {
  const html = renderToStaticMarkup(
    h(Control, {
      id: 'start',
      label: 'Start',
      refusals: [{ id: 'R9', why: 'the door is ajar.' }],
    })
  );
  assert.match(html, /disabled/);
  assert.match(html, /R9 — the door is ajar\./);
});

/* ════════════════════════════════════════════════════════════════════════════
   9. What the tab says when it cannot know
   ════════════════════════════════════════════════════════════════════════════ */

test('the tab never claims a machine has been run', () => {
  const html = renderToStaticMarkup(h(RunTab, { now: 0 }));
  const banner = section(html, 'run-unproven');
  assert.match(banner, /ordered and has not arrived/);
  assert.match(banner, /has cut anything/);
});

test('a browser without Web Serial is told why, and is not given a dead Connect', () => {
  const html = renderToStaticMarkup(h(RunTab, { navigatorLike: {}, now: 0 }));
  const box = section(html, 'run-unavailable');
  assert.match(box, /does not implement the Web Serial API/);
  assert.match(box, /Chrome or Edge/);
  assert.match(box, /no polyfill/);
  assert.match(box, /iOS/);
});

test('a silent link is "state unknown", not "the machine stopped"', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      tracked: connected({ tab: 'Streaming' }),
      report: reportOf('<Run|MPos:1.000,2.000,3.000|FS:600,18000>'),
      lastReportAt: 0,
      now: 9_000,
    })
  );
  const link = section(html, 'run-link');
  assert.match(link, /9000ms ago/);
  assert.match(link, /state is unknown/);
  /* 🔴 And the homing exception, because a watchdog that holds the job on
   * silence would fire on every homing cycle — $10 bit 12 is off by default —
   * and a control that false-fires gets muted. */
  assert.match(link, /homing/i);
});

test('a pendant on the stream disables the controls and says who has the machine', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      tracked: readyToCut(),
      report: reportOf('<Idle|MPos:0.000,0.000,0.000|MPG:1>'),
      now: 0,
    })
  );
  assert.match(section(html, 'run-pendant'), /pendant has taken the input stream/);
});

test('the sender count and the controller line number are shown as different numbers', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      tracked: connected({ tab: 'Streaming' }),
      report: reportOf('<Run|MPos:0.000,0.000,0.000|Ln:42|Bf:90,900>'),
      sender: { sent: 71, acknowledged: 40, total: 500, stalled: false, startedAt: 0 },
      buffers: { rx: 1024, planner: 100 },
      now: 30_000,
    })
  );
  const lines = section(html, 'run-lines');
  /* 🔴 Both are true and they are not the same fact: `Ln:` is what the PLANNER
   * is executing, the sender's count is what has been TRANSMITTED, and the gap
   * between them is the buffer. Showing one hides it. */
  assert.match(lines, /executing 42/);
  assert.match(lines, /sent 71/);
  assert.match(lines, /acknowledged 40 of 500/);
  assert.match(section(html, 'run-buffer'), /90\/100 planner blocks free/);
  assert.match(section(html, 'run-buffer'), /900\/1024 RX characters free/);
});

test('an absent field is named with the bit that suppressed it, not left blank', () => {
  const html = renderToStaticMarkup(
    h(RunTab, {
      tracked: connected(),
      // `$10=1`: MPos only. No Bf, no FS, no Ov, no WCO.
      report: reportOf('<Idle|MPos:0.000,0.000,0.000>'),
      mask: { value: 1, positionIsMachine: true, bufferState: false, lineNumbers: false, feedAndSpeed: false, pinState: false, workCoordinateOffset: false, overrides: false, probeCoordinates: false, syncOnWcoChange: false, parserState: false, alarmSubstate: false, runSubstate: false, reportWhileHoming: false, distanceToGo: false },
      now: 0,
    })
  );
  assert.match(section(html, 'run-buffer'), /\$10 bit 1 is clear/);
  assert.match(section(html, 'run-feed'), /\$10 bit 3 is clear/);
  assert.match(section(html, 'run-overrides'), /\$10 bit 6 is clear/);
  /* And the tab does not offer to fix it by writing the setting: reading `$$` is
   * safe, writing `$10=511` would be the tab silently reconfiguring a machine
   * somebody else set up. */
  assert.match(section(html, 'run-buffer'), /does not write settings/);
});

/* ════════════════════════════════════════════════════════════════════════════
   helpers
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The markup of one `data-testid`, with balanced tags.
 *
 * Crude on purpose: this suite asserts on strings because there is no DOM on
 * this box, and a real parser would be a dependency to licence-check for a
 * handful of assertions. It is balanced rather than "up to the next closing
 * tag", because the earlier version of this helper silently returned the first
 * fragment of a nested element — and a check that reads the wrong half of the
 * markup passes for the wrong reason.
 */
function section(html: string, testid: string): string {
  const i = html.indexOf(`data-testid="${testid}"`);
  assert.notEqual(i, -1, `no element with data-testid="${testid}"`);
  const start = html.lastIndexOf('<', i);
  const tag = /^<([a-zA-Z][-a-zA-Z0-9]*)/.exec(html.slice(start))?.[1];
  assert.ok(tag, 'could not read the tag name');
  const open = new RegExp(`<${tag}[\\s>/]`, 'g');
  const close = new RegExp(`</${tag}>`, 'g');
  let depth = 0;
  let cursor = start;
  for (let guard = 0; guard < 10000; guard++) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const o = open.exec(html);
    const c = close.exec(html);
    if (!c) return html.slice(start);
    if (o && o.index < c.index) {
      depth += 1;
      cursor = o.index + 1;
      continue;
    }
    depth -= 1;
    cursor = c.index + c[0].length;
    if (depth === 0) return html.slice(start, cursor);
  }
  return html.slice(start);
}

/* ════════════════════════════════════════════════════════════════════════════
   10. Start — the control that was drawn, enabled, and wired to nothing
   ════════════════════════════════════════════════════════════════════════════

   🔴 THE DEFECT THESE TESTS EXIST FOR, NAMED SO IT CANNOT COME BACK QUIETLY:
   `Start` was rendered, the protocol gate enabled it, and the action map had no
   entry for it — so pressing it did nothing at all. An enabled control that does
   nothing reads as *"the machine did not respond"*, which on this tab sends an
   operator to look at the machine for a fault that is in the software.

   ⚠ AND WHAT THESE TESTS STILL CANNOT SAY. There is no browser here, no
   `Worker`, no `navigator.serial` and no machine: the tab's click handlers are
   never invoked by a real DOM, and `renderToStaticMarkup` runs no effects. What
   is exercised is the DECISION (`startCommands`), the MAP (`wiredActions`), and
   the bytes those commands produce when they are handed to the same `Streamer`
   and `StreamPump` the worker runs — driven against `run/fake.ts` at the byte
   boundary. A green here says the tab agrees with this lane's reading of
   grblHAL. It says nothing whatever about a machine. */

/** A program shaped like the one `post_grblhal.rs` emits: G90/G54 preamble,
 *  then an absolute rapid to a safe Z. That opening rapid is what R3 compares. */
const READY_PROGRAM: RunProgram = {
  name: 'plate',
  hash: 'f00d-42',
  rapidRate: 3000,
  lines: [
    'G17 G21 G90 G54 G94 G40',
    'G0 Z5.000',
    'G0 X0.000 Y0.000',
    'M3 S18000',
    'G4 P2.0',
    'G1 Z-2.000 F300.0',
    'G1 X40.000 F1200.0',
    'G0 Z5.000',
    'M5',
    'M2',
  ],
  path: [
    { x: 0, y: 0, z: 5, feed: 0, rapid: true, line: -1 },
    { x: 0, y: 0, z: -2, feed: 300, rapid: false, line: -1 },
    { x: 40, y: 0, z: -2, feed: 1200, rapid: false, line: -1 },
    { x: 40, y: 0, z: 5, feed: 0, rapid: true, line: -1 },
  ],
};

test('the program’s first Z is read off the EMITTED TEXT, and refuses rather than approximating', () => {
  assert.equal(firstProgramZ(READY_PROGRAM.lines), 5);
  assert.equal(firstProgramZ(['G17 G21 G90', 'G0Z5.0']), 5, 'grblHAL does not require spaces');
  assert.equal(
    firstProgramZ(['( fixture: plate, Z-40 datum )', 'G0 Z3']),
    3,
    'a Z inside a comment is not a Z word — and our post writes comments with numbers in them'
  );

  /* 🔴 Each of these returns `null`, which makes R3 REFUSE the job rather than
   * compare two numbers that are not in the same frame. This is the same defect
   * class as design F1 — a quantity computed in one frame and used in another —
   * and there it was found in the post's own probe block. */
  assert.equal(firstProgramZ(['G91', 'G0 Z5']), null, 'incremental: a distance, not a coordinate');
  assert.equal(firstProgramZ(['G20', 'G0 Z5']), null, 'inches, against a millimetre DRO');
  assert.equal(firstProgramZ(['G53 G0 Z-5']), null, 'a MACHINE coordinate, not a work one');
  assert.equal(firstProgramZ(['G1 Z-2 F300']), null, 'the first motion is a feed, not a rapid');
  assert.equal(firstProgramZ(['G0 X0 Y0']), null, 'no Z word at all');
  assert.equal(firstProgramZ([]), null);
});

test('the handed-over program reaches the refusal set', () => {
  /* 🔴 The join that was missing: the tab took a `program` prop and its refusal
   * set never saw it, so R5's *"no program is loaded"* was rendered underneath a
   * drawn toolpath, and R3 could not make the descent comparison at all. */
  const before = connected();
  assert.ok(controlRefusals('start', before).some((r) => /no program is loaded/.test(r.why)));

  const after = trackedForProgram(before, READY_PROGRAM);
  assert.equal(after.programLoaded, true);
  assert.equal(after.programFirstZ, 5);
  assert.ok(!controlRefusals('start', after).some((r) => /no program is loaded/.test(r.why)));

  const none = trackedForProgram(before, null);
  assert.equal(none.programLoaded, false);
  assert.equal(none.programFirstZ, null);
});

test('🔴 nothing streams while a refusal applies — and the plant proves the refusal is what stopped it', () => {
  const ready = trackedForProgram(readyToCut(), READY_PROGRAM);
  const ok = startCommands(READY_PROGRAM, ready);
  assert.equal(ok.status, 'ok');
  if (ok.status !== 'ok') return;
  assert.deepEqual(
    ok.commands.map((c) => c.t),
    ['load', 'start'],
    'load then start: the worker cannot start what it has not been given'
  );
  const load = ok.commands[0];
  assert.equal(load.t === 'load' && load.rxBufferSize, 1024, 'the MEASURED buffer, never a guess');
  assert.equal(load.t === 'load' && load.mode, 'character-counting');

  /* Every refusal is a stop, and the reason is carried out rather than swallowed
   * — a control that stops and says nothing is the failure this tab is written
   * against. */
  for (const [why, state] of [
    ['R1, unhomed', { homingSeen: false }],
    ['R2, position untrusted', { positionTrusted: false }],
    ['R4, controller not Idle', { controllerState: 'Run' as const }],
    ['R12, inch reporting', { reportUnits: 'inch' as const }],
    ['R13, buffer never measured', { measuredRxBuffer: null }],
  ] as const) {
    const refused = startCommands(READY_PROGRAM, { ...ready, ...state });
    assert.equal(refused.status, 'refused', `${why} must refuse`);
    if (refused.status === 'refused') assert.ok(refused.why.length > 40, `${why} must say why`);
  }

  /* 🔴 R3 — the one the design calls the strongest argument for this tab
   * existing. The program's opening rapid is ABOVE the tool, so it is a descent
   * at rapid rate before anything has been probed (design F3). */
  const descending = startCommands(READY_PROGRAM, { ...ready, currentWorkZ: 30 });
  assert.equal(descending.status, 'refused');
  if (descending.status === 'refused') {
    assert.ok(descending.refusals.some((r) => r.id === 'R3'));
    assert.match(descending.why, /DESCENT/);
  }

  /* 🔴 THE PLANT. The guard removed, in one argument: commands are built while
   * R1 and R2 stand — a job streamed at a machine whose coordinates are whatever
   * they were at power-on, which grblHAL's own optional homing lock would allow.
   * If this line ever returns `refused`, the plant has stopped planting and the
   * assertion above proves nothing. */
  const unhomed = { ...ready, homingSeen: false, positionTrusted: false };
  assert.equal(startCommands(READY_PROGRAM, unhomed).status, 'refused');
  assert.equal(startCommands(READY_PROGRAM, unhomed, 'start-ignores-refusals').status, 'ok');
});

test('a permissive state with no program still cannot build a stream', () => {
  /* Not reachable through the tab, and that is exactly why it is asserted: a
   * caller with a hand-made state must not get a `load` carrying no lines. */
  const out = startCommands(null, { ...readyToCut(), programLoaded: true });
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') assert.match(out.why, /no program has been handed/);
});

test('the commands Start builds put the program’s own bytes on the fake’s wire', async () => {
  const ready = trackedForProgram(readyToCut(), READY_PROGRAM);
  const built = startCommands(READY_PROGRAM, ready);
  assert.equal(built.status, 'ok');
  if (built.status !== 'ok') return;
  const load = built.commands[0];
  assert.equal(load.t, 'load');
  if (load.t !== 'load') return;

  /* The same `Streamer` and the same `StreamPump` the worker constructs from
   * these fields — `streamer.worker.ts` reads `cmd.lines`, `cmd.mode` and
   * `cmd.rxBufferSize` and does nothing else with them, and the `WorkerCommand`
   * type is what keeps the two in step. The worker itself cannot run here: node
   * has no `Worker` and no `navigator.serial`. */
  const fake = new FakeController('healthy', { bannerOnConnect: false, autoExecute: true });
  const pump = new StreamPump({
    link: fake,
    streamer: new Streamer({ lines: load.lines, mode: load.mode, rxBufferSize: load.rxBufferSize }),
  });
  pump.attach();
  await pump.pump();
  await settle(200);

  assert.equal(pump.state, 'done');
  assert.equal(fake.overruns, 0);
  assert.deepEqual(
    fake.executed,
    [...READY_PROGRAM.lines],
    'the bytes the machine receives are the program’s own lines, in order, and nothing else'
  );
  /* 🔴 Completion is the SENDER's accounting — every line sent and acknowledged
   * — never the controller's `Idle`, which a starved streamer also produces. */
  assert.equal(pump.acknowledged, READY_PROGRAM.lines.length);
});

/** A `Connection` stub that records what the map asked it to do. */
function recordingConn(calls: string[]): Pick<
  Connection,
  'connect' | 'identifyNow' | 'send' | 'writeLine' | 'stopFeeding' | 'startJob'
> {
  return {
    connect: () => calls.push('connect'),
    identifyNow: () => calls.push('identifyNow'),
    send: (n) => calls.push(`realtime:${n}`),
    writeLine: (l) => calls.push(`line:${l}`),
    stopFeeding: (why) => calls.push(`stopFeeding:${why}`),
    startJob: (program, tracked) => {
      calls.push(`startJob:${program?.hash ?? 'none'}`);
      return startCommands(program, tracked);
    },
  };
}

test('🔴 Start is IN the action map, and Jog and Zero are deliberately not', () => {
  const calls: string[] = [];
  const map = wiredActions({
    conn: recordingConn(calls),
    program: READY_PROGRAM,
    tracked: trackedForProgram(readyToCut(), READY_PROGRAM),
    awaitingAbortConfirm: false,
    setAwaitingAbortConfirm: () => undefined,
  });

  assert.ok(map.start, 'THE DEFECT: Start drawn and enabled with no entry here');
  map.start?.();
  assert.deepEqual(calls, ['startJob:f00d-42']);

  /* Absent on purpose, and their absence is what disables them: Zero writes
   * non-volatile storage. A stub would be a control that rewrites its datum on
   * a path nobody designed. Jog is now wired as a minimal single-press $J=G91. */
  assert.ok(map.jog, 'jog is now wired as a minimal $J=G91');
  assert.equal(map.zero, undefined);

  /* Stop is the §16 two-step and the ORDER is the safety property: the hold
   * goes out FIRST, then the sender stops. The other order leaves tens of
   * buffered blocks executing with nothing decelerating them. */
  calls.length = 0;
  map.stop?.();
  assert.equal(calls[0], 'realtime:feedHold');
  assert.match(calls[1] ?? '', /^stopFeeding:/);
});

test('🔴 PLANT — a control with nothing behind it renders DISABLED, never enabled and inert', () => {
  const ready = trackedForProgram(readyToCut(), READY_PROGRAM);
  const live = renderToStaticMarkup(
    h(RunTab, { program: READY_PROGRAM, tracked: ready, now: 0 })
  );
  assert.doesNotMatch(section(live, 'run-control-start'), /disabled/, 'Start is live when it may run');

  // Jog is now wired (minimal $J=G91), so it is NOT disabled with "not built".
  // Zero is still absent and disabled with "not built".
  assert.doesNotMatch(section(live, 'run-control-jog'), /disabled/, 'Jog is now wired');
  assert.match(section(live, 'run-refused-zero'), /not built/);

  /* 🔴 THE PLANT: the action map this file actually shipped with — everything
   * wired except `Start`. The button must go DISABLED and say so. If it renders
   * live here, the tab is back to a control that looks armed and sends nothing,
   * and the operator's conclusion is "the machine did not respond". */
  const planted: Partial<Record<ControlId, () => void>> = wiredActions({
    conn: recordingConn([]),
    program: READY_PROGRAM,
    tracked: ready,
    awaitingAbortConfirm: false,
    setAwaitingAbortConfirm: () => undefined,
  });
  delete planted.start;
  const html = renderToStaticMarkup(
    h(RunTab, { program: READY_PROGRAM, tracked: ready, actions: planted, now: 0 })
  );
  assert.match(section(html, 'run-control-start'), /disabled/);
  assert.match(section(html, 'run-refused-start'), /not built/);
  assert.match(section(html, 'run-refused-start'), /did not respond/);
});

test('the RX buffer is MEASURED from Bf while Idle, and a stream is refused until it has been', () => {
  const empty: MeasuredBuffers = { rx: null, planner: null };
  let b = measureBuffers(empty, reportOf('<Idle|MPos:0.000,0.000,0.000|Bf:90,900>'), false);
  assert.equal(b.rx, 900);
  assert.equal(b.planner, 90);

  /* A running maximum, and a LOWER BOUND: `Bf` reports what is FREE, so it
   * equals the size only when the buffer is empty. A residual `$$` reply still
   * in the buffer makes the first measurement small — small is the safe
   * direction, because counting against a smaller number sends less. */
  b = measureBuffers(b, reportOf('<Idle|MPos:0.000,0.000,0.000|Bf:100,1024>'), false);
  assert.equal(b.rx, 1024);
  b = measureBuffers(b, reportOf('<Idle|MPos:0.000,0.000,0.000|Bf:20,64>'), false);
  assert.equal(b.rx, 1024, 'a fuller buffer is occupancy, and must not lower the measurement');

  /* Never taken mid-stream or off a moving machine: reading occupancy as
   * capacity is how a streamer talks itself into an overrun. */
  assert.equal(measureBuffers(empty, reportOf('<Run|MPos:0.000,0.000,0.000|Bf:2,10>'), false).rx, null);
  assert.equal(measureBuffers(empty, reportOf('<Idle|MPos:0.000,0.000,0.000|Bf:2,10>'), true).rx, null);
  assert.equal(measureBuffers(empty, reportOf('<Idle|MPos:0.000,0.000,0.000>'), false).rx, null);

  // R13 stands until it has been measured — never 128 (grbl) or 1024 (grblHAL).
  assert.ok(controlRefusals('start', readyToCut({ measuredRxBuffer: null })).some((r) => r.id === 'R13'));
});

test('an aborted stream gets a feed hold, and an alarm does not', () => {
  /* 🔴 Stopping the sender stops nothing that is already in the controller: it
   * keeps executing its RX buffer and planner — up to 40–70 of our lines — with
   * the spindle turning. On a rejected line the honest response is a controlled
   * deceleration. */
  const onError = abortResponse({
    reason: 'error',
    code: 20,
    line: 'G83 X0',
    lineNumber: 7,
    message: 'error:20 on line 7.',
  });
  assert.equal(onError.realtime, 'feedHold');
  assert.match(onError.why, /still turning/);

  /* An alarm has already halted the motion, and a `!` there is a byte that means
   * nothing. A `stopped` abort already had its hold — sent BEFORE the sender
   * stopped, which is the order that matters. */
  assert.equal(
    abortResponse({ reason: 'alarm', code: 5, line: null, lineNumber: null, message: 'ALARM:5' })
      .realtime,
    null
  );
  assert.equal(
    abortResponse({ reason: 'stopped', code: null, line: null, lineNumber: null, message: 'Stop.' })
      .realtime,
    null
  );
  assert.equal(abortResponse(null).realtime, null);
});

test('🔴 the tab reports STREAMING upward, and the signal does not overclaim', () => {
  const running = streamingSignal({
    program: READY_PROGRAM,
    state: 'streaming',
    sent: 40,
    acknowledged: 31,
    total: 10,
    startedAt: 1000,
    abort: null,
    linkLost: false,
  });
  assert.equal(running.streaming, true);
  assert.equal(running.program?.hash, 'f00d-42');
  /* The sentence the consumer renders beside whatever it disables. It names the
   * program, because "a job is running" does not tell an operator which one. */
  assert.match(running.why, /f00d-42/);
  assert.match(running.why, /Replacing the program now/);

  const idle = streamingSignal({
    program: READY_PROGRAM,
    state: 'ready',
    sent: 0,
    acknowledged: 0,
    total: 0,
    startedAt: null,
    abort: null,
    linkLost: false,
  });
  assert.equal(idle.streaming, false);
  assert.equal(idle.ended, 'none');
  /* 🔴 `streaming === false` IS NOT "the machine is stopped", and the signal
   * says so itself — a consumer that renders "idle" off this flag is asserting
   * something this tab never said. */
  assert.match(idle.why, /not about the machine/);

  const dropped = streamingSignal({
    program: READY_PROGRAM,
    state: 'streaming',
    sent: 40,
    acknowledged: 31,
    total: 100,
    startedAt: 1000,
    abort: null,
    linkLost: true,
  });
  assert.equal(dropped.streaming, false, 'a dropped link is not a running stream');
  assert.equal(dropped.ended, 'link-lost');
  assert.match(dropped.why, /never told to stop/);

  const finished = streamingSignal({
    program: READY_PROGRAM,
    state: 'done',
    sent: 10,
    acknowledged: 10,
    total: 10,
    startedAt: 1000,
    abort: null,
    linkLost: false,
  });
  assert.equal(finished.ended, 'complete');
  /* Completion is the sender's accounting. It is not a claim about what was
   * cut, and the sentence must not let anyone read it as one. */
  assert.match(finished.why, /not a claim about what was cut/);
});

test('🔴 the tab may not claim the CNC hand-over does not exist — the copy is re-audited', () => {
  const empty = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  const withProgram = renderToStaticMarkup(
    h(RunTab, { program: READY_PROGRAM, tracked: connected(), now: 0 })
  );

  /* Both sentences were live in this file weeks after the seam was built, and
   * nothing went red because no test asserted the copy. A stale red lies exactly
   * like a stale green. */
  for (const html of [empty, withProgram]) {
    assert.doesNotMatch(html, /does not hand its program to/);
    assert.doesNotMatch(html, /that seam is not built/);
  }
  assert.match(section(empty, 'run-canvas-empty'), /Hand to the Run tab/);
  assert.match(section(empty, 'run-gaps'), /Start is wired/);
  assert.match(section(withProgram, 'run-program-hash'), /f00d-42/);

  /* 🔴 PLANT: the sentence put back. The assertion above must be able to see it
   * — otherwise it is a check that passes because it matches nothing. */
  const planted = empty.replace(
    'No program has been handed over',
    'The CNC tab does not hand its program to this tab yet'
  );
  assert.match(planted, /does not hand its program to/);
});

/* ════════════════════════════════════════════════════════════════════════════
   16. AM I ALONE ON THIS PORT? — the detector, wired to something
   ════════════════════════════════════════════════════════════════════════════

   `2c4f75b693` built `PortOwnershipWatch` and `SOLE_OWNERSHIP_LIMIT` and could
   not wire them: `measureBuffers`, the report handler and the `TrackedState`
   assembly all live in `RunTab.tsx`. Until this section existed the verdict read
   `'unchecked'` — worded as unchecked, correctly, and not a pass — and the
   detector was an instance of the thing this lane keeps filing against itself:
   *a control with no consumer accrues authority it never earned*.

   🔴 WHAT IS ASSERTED HERE, AND WHERE IT STOPS.

   ✅ From a report line to the RENDERED MARKUP, through the real
      `applyStatusReport` the tab calls, with ring occupancy produced by
      `run/fake.ts` rather than by numbers chosen to make the arithmetic work.
      The verdict is asserted where an operator would read it and in the refusal
      that stops the job — never on the watch object, because `158658175e` found
      `wcoUnavailable` and `deriveDro` both green while this same file called one
      of them without its argument.

   🔴 NOT ASSERTED: that `onLine` calls `applyStatusReport`. That single line of
      glue lives inside `useSerialConnection`, which needs `navigator.serial` and
      a `Worker` — node has neither, and not one line of that function has ever
      run. It is why the report handler was reduced to ONE call: everything the
      report path decides is in a function a test can drive, and what is left
      unglued is a call site, not a decision. `web/e2e/` is where that would be
      reached, and it needs a browser.
   ════════════════════════════════════════════════════════════════════════════ */

/** A report with a chosen `Bf`, and a `WCO` so the work-Z derivation succeeds —
 *  without it every fed state loses `currentWorkZ` and R3 fires for a reason
 *  that has nothing to do with what these tests are about. */
function bfReport(state: string, rxFree: number) {
  return reportOf(`<${state}|MPos:0.000,0.000,5.000|WCO:0.000,0.000,0.000|Bf:15,${rxFree}>`);
}

/** The report path as the tab runs it: one watch and one ledger across a
 *  connection, `applyStatusReport` per report, the merge applied to the state. */
function connectionUnderTest(base: TrackedState = readyToCut()) {
  const watch = new PortOwnershipWatch();
  const ours = new OutstandingChars();
  let buffers: MeasuredBuffers = { rx: null, planner: null };
  let tracked = base;
  return {
    ours,
    watch,
    get tracked() {
      return tracked;
    },
    get buffers() {
      return buffers;
    },
    feed(state: string, rxFree: number, streaming = false) {
      const step = applyStatusReport({
        report: bfReport(state, rxFree),
        buffers,
        lastWco: null,
        streaming,
        ours,
        watch,
      });
      buffers = step.buffers;
      tracked = step.track(tracked);
      return tracked;
    },
  };
}

test('🔴 a second program on the port reaches the SCREEN and the refusal, not just the watch', () => {
  /* The realistic failure: a serial monitor, gSender or a `screen` session holds
   * `/dev/ttyACM0` at the same time. No hub, no configuration. Its bytes land in
   * the same ring, `Bf` stays honest about that ring, and this tab's count
   * undercounts by exactly its bytes — then grblHAL drops what will not fit and
   * writes that fact into a flag nothing reads. */
  const fake = new FakeController('healthy', { autoExecute: false });
  const c = connectionUnderTest();

  c.feed('Idle', fake.rxFree);
  assert.equal(c.tracked.portOwnership, 'no-disagreement', 'one sample is not a series');

  fake.foreignWrite('G0 X0 Y0\n');
  assert.equal(fake.rxFree, 1024 - 9, 'the fake must really hold the other program’s bytes');
  c.feed('Idle', fake.rxFree);

  /* THE STATE, not the mechanism. A verdict computed and left in the watch is
   * the same defect one layer along from the one this section exists for. */
  assert.equal(c.tracked.portOwnership, 'foreign-writer');
  assert.match(c.tracked.portOwnershipWhy ?? '', /SECOND PROGRAM IS WRITING TO THIS PORT/);

  const html = renderToStaticMarkup(
    h(RunTab, { program: READY_PROGRAM, tracked: c.tracked, now: 0 })
  );
  const shown = section(html, 'run-ownership');
  assert.match(shown, /data-verdict="foreign-writer"/);
  assert.match(shown, /SECOND PROGRAM IS WRITING TO THIS PORT/);
  assert.match(shown, /9 character\(s\)/, 'the numbers, not a conclusion');
  assert.match(shown, /disconnect and reconnect/);
  /* The limit is stated whatever the verdict — a green here covers one failure
   * mode out of several, and the sentence has to reach an operator. */
  assert.match(shown, /ONLY program writing to this port/);

  /* And the job is REFUSED, at the control, with R14's own words. */
  assert.match(section(html, 'run-control-start'), /disabled/);
  assert.match(section(html, 'run-refused-start'), /R14/);
  assert.match(section(html, 'run-refused-start'), /the number is wrong, not tight/);

  /* IN-TEST NEGATIVE CONTROL — the same series with nobody else on the port.
   * Without it every assertion above is satisfied by a constant. */
  const clean = new FakeController('healthy', { autoExecute: false });
  const ok = connectionUnderTest();
  ok.feed('Idle', clean.rxFree);
  ok.feed('Idle', clean.rxFree);
  assert.equal(ok.tracked.portOwnership, 'no-disagreement');
  const okHtml = renderToStaticMarkup(
    h(RunTab, { program: READY_PROGRAM, tracked: ok.tracked, now: 0 })
  );
  assert.match(section(okHtml, 'run-ownership'), /data-verdict="no-disagreement"/);
  assert.doesNotMatch(section(okHtml, 'run-refusals'), /R14/);
});

test('🔴 the CONNECT-TIME case survives the Math.max that measures the buffer', () => {
  /* The sharp one, and the reason the samples had to be fed as well as summed.
   * A second writer present at the handshake depresses the one number R13 makes
   * every later gate depend on. `measureBuffers` keeps `Math.max`, which is
   * right about the SIZE and is the one summary that cannot show variation —
   * and the variation is the evidence. */
  const fake = new FakeController('healthy', { autoExecute: false });
  const c = connectionUnderTest();

  fake.foreignWrite('$$\n'); // already there when we connect
  c.feed('Idle', fake.rxFree);
  assert.equal(c.tracked.measuredRxBuffer, 1021, 'the corrupted number is what got measured');
  assert.equal(c.tracked.portOwnership, 'no-disagreement');

  fake.execute(); // the other program's line runs; the ring empties
  c.feed('Idle', fake.rxFree);

  /* BOTH facts survive, from one series: the size measurement climbed to the
   * truth, AND the rise is reported as proof the baseline was taken over
   * somebody else's bytes. */
  assert.equal(c.tracked.measuredRxBuffer, 1024, 'the Math.max is still doing its job');
  assert.equal(c.tracked.portOwnership, 'foreign-writer');
  assert.match(c.tracked.portOwnershipWhy ?? '', /ROSE to 1024 from a baseline of 1021/);
  assert.match(c.tracked.portOwnershipWhy ?? '', /the buffer size was measured from/);

  /* PLANT — the watch fed `buffers.rx`, the running maximum, instead of the
   * sample. It is what "wire it to the number we already have" produces, and it
   * is silent on the arm most likely in a shop: a monitor opened AFTER we
   * connected only ever depresses the figure, and a maximum cannot fall. */
  const planted = new PortOwnershipWatch();
  let max = 0;
  for (const sample of [1024, 1015]) {
    max = Math.max(max, sample);
    planted.observe({ rxFree: max, state: 'Idle', streaming: false, ourChars: 0 });
  }
  assert.equal(
    planted.verdict,
    'no-disagreement',
    'THE DEFECT: a maximum cannot fall, so the dip is summarised away by the summary'
  );

  const samples = new PortOwnershipWatch();
  for (const sample of [1024, 1015]) {
    samples.observe({ rxFree: sample, state: 'Idle', streaming: false, ourChars: 0 });
  }
  assert.equal(samples.verdict, 'foreign-writer', 'and the individual samples are not');
});

test('🔴 ourChars bounds EVERY channel — a tab that counts only the streamer invents a writer', () => {
  /* THE FAILURE THAT GETS A DETECTOR MUTED, and it is ours to cause. The console
   * and the handshake write `$` commands the `Streamer` knows nothing about. The
   * planted case in `run-protocol.test.ts` is this one; here it is driven
   * through the ledger the tab actually feeds. */
  const fake = new FakeController('healthy', { autoExecute: false });
  const ours = new OutstandingChars();

  /* `$$` at connect — OUR bytes, written through `{ t: 'write' }` and invisible
   * to the streamer. The fake's ring does not care whose they are, which is the
   * whole difficulty: `Bf` cannot tell us apart from anybody else. */
  fake.foreignWrite('$$\n');
  ours.onSent('$$');
  assert.equal(fake.rxFree, 1021);
  assert.equal(ours.outstanding, 3, '$$ costs its two characters plus the newline');

  const correct = new PortOwnershipWatch();
  correct.observe({ rxFree: 1024, state: 'Idle', streaming: false, ourChars: 0 });
  correct.observe({ rxFree: fake.rxFree, state: 'Run', streaming: true, ourChars: ours.bound() });
  assert.equal(correct.verdict, 'no-disagreement', 'our own $$ is not somebody else');

  /* PLANT — the streamer's count supplied instead. `Streamer.pendingChars` is 0
   * here, because the streamer sent nothing. */
  const planted = new PortOwnershipWatch();
  planted.observe({ rxFree: 1024, state: 'Idle', streaming: false, ourChars: 0 });
  planted.observe({ rxFree: fake.rxFree, state: 'Run', streaming: true, ourChars: 0 });
  assert.equal(planted.verdict, 'foreign-writer', 'THE DEFECT: our own $$ rendered as a stranger');

  /* An `ok` discharges it, and the ledger is back to owing nothing — which is
   * what makes the next Idle sample quiescent and therefore scorable at all.
   * ⚠ The BOUND does not drop to zero in the same breath: the `$$` was
   * outstanding during the window the next report was rendered in, and the peak
   * is what that window is entitled to. Only the report after it reads 0. */
  ours.onInbound(classifyInbound('ok'));
  assert.equal(ours.outstanding, 0);
  assert.equal(ours.bound(), 3, 'the peak over the window, not the value at the end of it');
  assert.equal(ours.bound(), 0, 'and the window after that owes nothing');

  /* An `ALARM:N` is NOT a line reply and must discharge nothing: exactly one
   * `ok`/`error:` comes back per line, and treating an async alarm as an
   * acceptance is how a count drifts low — which is the direction that fires. */
  ours.onSent('G1 X10');
  ours.onInbound(classifyInbound('ALARM:1'));
  ours.onInbound(classifyInbound('<Idle|MPos:0.000,0.000,0.000>'));
  assert.equal(ours.outstanding, 7);
  ours.onInbound(classifyInbound('error:20'));
  assert.equal(ours.outstanding, 0, 'an error: is a reply too — one per line, poisoned or not');
});

test('🔴 the bound is the MAXIMUM since the previous report, because the report is from the past', () => {
  /* `Bf` was rendered by the controller at some moment between two reports and
   * nothing says which. Supplying what we owe NOW would understate what we owed
   * when the figure was taken — and understating our own bytes is the direction
   * that manufactures a foreign writer. */
  const ours = new OutstandingChars();
  ours.onSent('G1 X10 Y10 F600'); // 16
  ours.onInbound(classifyInbound('ok')); // …and gone again, between reports
  assert.equal(ours.outstanding, 0);
  assert.equal(ours.bound(), 16, 'the peak, not the trough');
  assert.equal(ours.bound(), 0, 'and it is consumed — one call per report');

  /* Too high only blinds the watch: `run-protocol.test.ts` asserts that
   * direction, and this is the input that relies on it. */
  const w = new PortOwnershipWatch();
  w.observe({ rxFree: 1024, state: 'Idle', streaming: false, ourChars: 0 });
  w.observe({ rxFree: 1008, state: 'Run', streaming: true, ourChars: 16 });
  assert.equal(w.verdict, 'no-disagreement');
});

test('🔴 after a 0x85 or a 0x18 the count is “unknown”, and only a banner re-establishes it', () => {
  /* R7: both flush the ring under the count. `cancel_read_buffer` discards what
   * has not been parsed while lines already parsed still answer, so some of what
   * we owe will be acknowledged and some never will — and nothing on the wire
   * says which. A `0` there is a `0` that means "I did not check". */
  for (const name of ['jogCancel', 'reset'] as const) {
    const ours = new OutstandingChars();
    ours.onSent('$J=G91 X1 F600');
    assert.notEqual(ours.bound(), 'unknown');
    ours.onRealtime(name);
    assert.equal(ours.bound(), 'unknown', `${name} flushes the ring under the count`);
    assert.equal(ours.isUnknown, true);
  }

  /* A feed hold does not flush anything, and must not blind the watch: a refusal
   * that fires where its reason does not apply is the one operators click past. */
  const held = new OutstandingChars();
  held.onSent('G1 X10');
  held.onRealtime('feedHold');
  assert.equal(held.bound(), 7);

  /* The one event that re-establishes it, and it is an observation rather than a
   * timeout: the controller announcing a restart. Its ring is empty by
   * construction and nothing of ours is outstanding. */
  const afterReset = new OutstandingChars();
  afterReset.onSent('G1 X10');
  afterReset.onRealtime('reset');
  assert.equal(afterReset.bound(), 'unknown');
  afterReset.onInbound(classifyInbound('GrblHAL 1.1f [\'$\' or \'$HELP\' for help]'));
  assert.equal(afterReset.bound(), 0, 'a restarted controller owes nothing and holds nothing');

  /* 🔴 A `0x85` produces no banner, so a jog cancel leaves this tab blind until
   * it resets or reconnects. Blind, not wrong — and the verdict says
   * `'unchecked'` rather than anything that reads as a pass. */
  const c = connectionUnderTest();
  c.ours.onRealtime('jogCancel');
  c.feed('Idle', 1024);
  c.feed('Idle', 900); // a dip a scorable sample would have fired on
  assert.equal(c.tracked.portOwnership, 'unchecked');
  assert.equal(c.watch.quiescentSamples, 0, 'an unknown sample is not a sample that was checked');
  const html = renderToStaticMarkup(h(RunTab, { tracked: c.tracked, now: 0 }));
  assert.match(section(html, 'run-ownership'), /Nothing has been checked/);
  assert.doesNotMatch(section(html, 'run-ownership'), /sole owner|all clear|alone/i);
});

test('🔴 “unchecked” is what the tab says before any report, and it is not worded as a pass', () => {
  /* The default state of a tab that has scored nothing — which is also the state
   * of a tab that has not wired the watch up at all. The two are indistinguishable
   * on screen ON PURPOSE: neither may read as coverage. */
  const html = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  const shown = section(html, 'run-ownership');
  assert.match(shown, /data-verdict="unchecked"/);
  assert.match(shown, /Nothing has been checked/);
  assert.match(shown, /ONLY program writing to this port/);
  assert.match(shown, /WITHOUT REPORTING ANYTHING/);
  /* `unchecked` is not evidence, so it does not refuse the job either. The limit
   * that stands in that case is a stated sentence, not a green. */
  assert.doesNotMatch(section(html, 'run-refusals'), /R14/);

  /* A report with no `Bf` is silence, not a quiescent sample: scoring it would
   * invent a baseline out of a field the controller did not send. */
  const c = connectionUnderTest();
  const step = applyStatusReport({
    report: reportOf('<Idle|MPos:0.000,0.000,0.000>'),
    buffers: { rx: null, planner: null },
    lastWco: null,
    streaming: false,
    ours: c.ours,
    watch: c.watch,
  });
  assert.equal(step.track(connected()).portOwnership, 'unchecked');
  assert.equal(c.watch.quiescentFree, null);
});

test('🔴 the verdict is sticky across reports, and a reconnect is what clears it', () => {
  /* A second writer that goes quiet has not gone away, and a verdict that
   * un-fires teaches an operator to wait it out. */
  const c = connectionUnderTest();
  c.feed('Idle', 1024);
  c.feed('Idle', 1024 - RING_ARTEFACT_CHARS - 1);
  assert.equal(c.tracked.portOwnership, 'foreign-writer');
  c.feed('Idle', 1024);
  c.feed('Idle', 1024);
  assert.equal(c.tracked.portOwnership, 'foreign-writer');

  /* One character is the named `0x85` CAN artefact and not a writer — the
   * subtraction is exactly one, or it is a safety margin. */
  const artefact = connectionUnderTest();
  artefact.feed('Idle', 1024);
  artefact.feed('Idle', 1024 - RING_ARTEFACT_CHARS);
  assert.equal(artefact.tracked.portOwnership, 'no-disagreement');
});
