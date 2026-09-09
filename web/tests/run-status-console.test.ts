// Status polling, DRO staleness, and the console input.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT A GREEN HERE MEANS, SAID FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// **A green against the fake proves the tab agrees with this lane's reading of
// grblHAL and nothing more.** `run/fake.ts` was written from grblHAL's source by
// the same lane that wrote `run/protocol.ts` and the tab; it can show the sender
// is self-consistent with that reading, and it can never discover the reading is
// wrong. There is no browser on this box, no serial port, no controller, and CDP
// 9222 is the founder's personal browser and is banned outright including for
// reads. Everything below is driven through the fake `Link` at the BYTE
// boundary, which is the strongest thing available here and is not evidence
// about a machine.
//
//   🔴 NOT COVERED, and each needs hardware or a browser:
//      that a worker of a HIDDEN page keeps its `setInterval` running — the
//      sibling of gate branch `RUN-18`, and the assumption the poll's freshness
//      rests on. It is unmeasured. That is why nothing here asserts the poll
//      HAPPENED: it asserts what the poller does when it is ticked, and the tab
//      renders the age of the report that actually arrived.
//      That grblHAL answers `0x87` while `$481` auto-reporting is on. The design
//      settles that `?` is ignored (`protocol.c:872-874`) and settles nothing
//      about `0x87`; `pollPlan` says so in its own text rather than guessing.
//
//   ✅ COVERED: that the poller never queues status traffic in front of the cut;
//      that a realtime byte is one byte and is charged nothing; that a stale
//      readout renders as stale; that every route out of the console goes
//      through `run/protocol.ts`'s refusal set.
//
// ⚠ `createElement` rather than JSX — `npm run test:node` globs `tests/*.test.ts`
// and a `.tsx` here would not be collected, and a test that is not collected is
// indistinguishable from one that passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DEFAULT_FULL_EVERY,
  DEFAULT_POLL_MS,
  StatusPoller,
  encodeLine,
  pollPlan,
} from '../src/run/transport.ts';
import {
  LineAssembler,
  REALTIME,
  Streamer,
  classifyInbound,
  decodeReportMask,
  initialTrackedState,
  parseStatusReport,
  realtimeBytes,
  realtimeRefusal,
  refusalsFor,
  type Link,
  type TrackedState,
} from '../src/run/protocol.ts';
import { FakeController } from '../src/run/fake.ts';
import {
  CONSOLE_DIRS,
  CONSOLE_REALTIME,
  ConsolePanel,
  RunTab,
  STALE_FACTOR,
  chargedCharacters,
  consoleAction,
  consoleRefusals,
  droFreshness,
  droRendering,
  realtimeEcho,
  type ConsoleLine,
  type Dro,
} from '../src/RunTab.tsx';

const here = dirname(fileURLToPath(import.meta.url));

/** Give the microtask queue a chance to settle the awaited writes. */
const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function connected(over: Partial<TrackedState> = {}): TrackedState {
  return { ...initialTrackedState(), tab: 'Idle', controllerState: 'Idle', ...over };
}

/** The markup of one `data-testid`, up to the end of the document. Crude, and
 *  sufficient: every assertion below is a presence/absence of a string inside a
 *  region that starts at a known marker. */
function from(html: string, testid: string): string {
  const i = html.indexOf(`data-testid="${testid}"`);
  assert.notEqual(i, -1, `no element with data-testid="${testid}"`);
  return html.slice(html.lastIndexOf('<', i));
}

/* ════════════════════════════════════════════════════════════════════════════
   1. The poll plan — `$481` is a setting on somebody else's machine
   ════════════════════════════════════════════════════════════════════════════ */

test('the poll plan is decided from $481 as READ, and never from $481 as hoped', () => {
  /* 🔴 UNREAD is not OFF and is not ON. `$$` may not have answered, or this
   * build may not carry the setting. The one thing the tab must not do is stop
   * polling on a maybe — that is the state where every readout freezes and
   * nothing on screen says why. */
  const unread = pollPlan(null);
  assert.equal(unread.intervalMs, DEFAULT_POLL_MS);
  assert.equal(unread.fullEvery, DEFAULT_FULL_EVERY);
  assert.equal(unread.expectMs, DEFAULT_POLL_MS);
  assert.match(unread.why, /\$481 has not been read/);
  assert.match(unread.why, /does not assume/);

  /* OFF is grblHAL's own default. Nothing arrives unless the tab asks. */
  const off = pollPlan(0);
  assert.equal(off.intervalMs, DEFAULT_POLL_MS);
  assert.match(off.why, /\$481=0/);
  assert.match(off.why, /Nothing arrives unless this tab asks/);

  /* ON: `?` is a no-op (protocol.c:872-874), so the tab stops spending a byte a
   * tick on one — but WCO, Ov and H are change-only and three refusals key on
   * them, so the full report is still asked for. */
  const on = pollPlan(500);
  assert.equal(on.fullEvery, 1, 'every request under auto-reporting is a full one');
  assert.ok(on.intervalMs > DEFAULT_POLL_MS, 'and it is asked for slowly');
  assert.equal(on.expectMs, 500, 'reports are expected at the CONTROLLER’s rate, not the poll rate');
  assert.match(on.why, /ignored/);
  assert.match(on.why, /change-only/);
  /* ⚠ And the open question is IN the text rather than resolved by a guess:
   * whether `0x87` is also ignored under auto-reporting is not settled by the
   * design and has not been read at the source by this lane. */
  assert.match(on.why, /not settled by the design/);
});

test('the expected-report interval is the controller’s rate, not the poll rate', () => {
  /* Two different numbers for the same question, and dividing staleness by the
   * wrong one either cries wolf or never fires. Under `$481=1000` a report is
   * due every second even though the tab asks every four. */
  assert.equal(pollPlan(1000).expectMs, 1000);
  assert.notEqual(pollPlan(1000).expectMs, pollPlan(1000).intervalMs);
  assert.equal(pollPlan(0).expectMs, pollPlan(0).intervalMs);
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The poller — one byte, and never a queue of them
   ════════════════════════════════════════════════════════════════════════════ */

test('the first request of a connection is 0x87, and it goes out as ONE byte', async () => {
  const fake = new FakeController('healthy', { bannerOnConnect: false });
  const poller = new StatusPoller(fake, 5);

  assert.equal(poller.tick(), 'statusReportAll');
  await settle();

  const bytes = fake.writes.filter((w) => w.length && (w[0] === 0x87 || w[0] === 0x3f));
  assert.equal(bytes.length, 1);
  assert.deepEqual([...bytes[0]], [0x87], 'one byte — a TextEncoder would send 0xC2 0x87');

  /* 🔴 It is REQUIRED, not tidy: WCO, Ov and H are change-only, so a client that
   * only ever sends `?` may wait 30 reports for a WCO and may never see H at
   * all — and H is the evidence R1 keys on. The proof is at the fake: only the
   * full report carries FW/H/WCS. */
  const seen: string[] = [];
  const asm = new LineAssembler();
  fake.onData((c) => seen.push(...asm.push(c)));
  poller.tick(); // #1 of the cycle → plain `?`
  await settle();
  assert.match(seen.join('\n'), /^</m);
});

test('every fullEvery-th request is a full report, and the rest are plain', async () => {
  const fake = new FakeController('healthy', { bannerOnConnect: false });
  const poller = new StatusPoller(fake, 4);
  const issued: (string | null)[] = [];
  for (let i = 0; i < 9; i++) {
    issued.push(poller.tick());
    await settle();
  }
  assert.deepEqual(issued, [
    'statusReportAll',
    'statusReport',
    'statusReport',
    'statusReport',
    'statusReportAll',
    'statusReport',
    'statusReport',
    'statusReport',
    'statusReportAll',
  ]);
  assert.equal(poller.requests, 9);
  assert.equal(poller.fullRequests, 3);
  assert.equal(poller.skipped, 0);
});

test('a reconnect resyncs: the next request is full again', async () => {
  const fake = new FakeController('healthy', { bannerOnConnect: false });
  const poller = new StatusPoller(fake, 100);
  poller.tick();
  await settle();
  assert.equal(poller.tick(), 'statusReport');
  await settle();
  /* A new port is a new connection: no WCO, no Ov, no H. Asking with `?` after
   * a reconnect leaves the work DRO underivable for up to 30 reports and leaves
   * R1 refusing on evidence that was already true before the drop. */
  poller.resync();
  assert.equal(poller.tick(), 'statusReportAll');
});

test('🔴 status traffic never queues in front of the cut — one request outstanding, ever', async () => {
  /* A Link whose writes never resolve: a congested port, exactly the state where
   * a clock-driven poller does its damage. `WebSerialLink` serialises writes
   * through one promise chain, so every un-resolved `?` sits IN FRONT of the
   * next g-code line — and "a streamer that stalls mid-cut leaves a turning
   * cutter stationary in the material". */
  class HangingLink implements Link {
    readonly writes: Uint8Array[] = [];
    write(bytes: Uint8Array): Promise<void> {
      this.writes.push(bytes.slice());
      return new Promise<void>(() => undefined); // never settles
    }
    onData(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  }
  const link = new HangingLink();
  const poller = new StatusPoller(link, 1);

  assert.equal(poller.tick(), 'statusReportAll');
  for (let i = 0; i < 50; i++) {
    assert.equal(poller.tick(), null, 'a tick with one already in flight must be DROPPED');
    await settle(2);
  }
  assert.equal(link.writes.length, 1, '50 ticks on a stuck link put ONE byte on the wire');
  assert.equal(poller.requests, 1);
  assert.equal(poller.skipped, 50);

  /* 🔴 PLANT: the guard removed. A poller that fires on the clock regardless
   * accumulates one byte per tick ahead of the program. Written as the loop the
   * guard replaces, so the number this test is protecting against is visible. */
  const planted = new HangingLink();
  for (let i = 0; i < 51; i++) void planted.write(realtimeBytes('statusReport'));
  assert.equal(planted.writes.length, 51);
  assert.notEqual(planted.writes.length, link.writes.length);
});

test('polling through a whole stream disturbs neither the count nor the buffer', async () => {
  /* The character count is the only thing standing between the sender and an
   * overrun (§2). A status request is a realtime byte: picked out before the
   * line parser, never line-buffered, never answered with `ok`. This drives a
   * real character-counted stream against a deliberately small buffer with the
   * poller ticking between every round. */
  const fake = new FakeController('healthy', {
    bannerOnConnect: false,
    autoExecute: false,
    rxBufferSize: 64,
  });
  const lines = Array.from({ length: 120 }, (_, i) => `G1 X${i % 40} Y${i % 7} F900`);
  const streamer = new Streamer({
    lines,
    mode: 'character-counting',
    rxBufferSize: fake.options.rxBufferSize,
  });
  const poller = new StatusPoller(fake, 3);
  const inbox: string[] = [];
  const asm = new LineAssembler();
  fake.onData((c) => inbox.push(...asm.push(c)));

  let rounds = 0;
  let reports = 0;
  while (streamer.state !== 'done' && streamer.state !== 'aborted' && rounds < 5000) {
    rounds += 1;
    for (const line of streamer.nextLines()) await fake.write(encodeLine(line));
    poller.tick();
    await settle(4);
    fake.execute(1);
    while (inbox.length) {
      const inbound = classifyInbound(inbox.shift() as string);
      if (inbound.kind === 'status') reports += 1;
      streamer.onReply(inbound);
    }
  }

  assert.equal(fake.overruns, 0, 'the fake jams on overrun; a jam here is a real overrun');
  assert.equal(streamer.state, 'done');
  assert.equal(streamer.acknowledged, lines.length);
  assert.ok(poller.requests > 20, `the poll actually interleaved (${poller.requests} requests)`);
  assert.ok(reports > 20, `and reports actually came back (${reports})`);
  /* 🔴 Not one status request became a line. If one had, it would sit in the
   * controller's RX buffer uncounted and be answered with an `ok` the sender
   * never earned. */
  assert.equal(fake.executed.filter((l) => l === '?' || l === '').length, 0);
  assert.deepEqual(fake.executed, lines);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. Staleness — a frozen number that looks live is the worst option
   ════════════════════════════════════════════════════════════════════════════ */

const fresh = (over: Partial<Parameters<typeof droFreshness>[0]> = {}) =>
  droFreshness({ connected: true, ageMs: 50, expectMs: 200, state: 'Idle', ...over });

test('a reading within the expected interval is current, and says nothing loud', () => {
  const f = fresh({ ageMs: 120 });
  assert.equal(f.current, true);
  assert.equal(f.stale, false);
  assert.equal(f.expectedSilence, false);
});

test('🔴 a reading older than the interval is NOT current, and older still is STALE', () => {
  /* The literal rule — "older than the poll interval" — is the first verdict. */
  const late = fresh({ ageMs: 260 });
  assert.equal(late.current, false, 'past one interval it is not a measurement of now');
  assert.equal(late.stale, false, 'one late report is jitter, not a fault');
  assert.match(late.why, /a moment behind/);

  /* And the loud one is three intervals, because a marker that blinks during a
   * normal cut is a marker an operator learns to ignore. */
  const dead = fresh({ ageMs: 200 * STALE_FACTOR + 1 });
  assert.equal(dead.stale, true);
  assert.match(dead.why, /STALE/);
  /* 🔴 It must not be read as "the machine stopped": the controller keeps
   * executing whatever is in its buffer with the spindle turning. */
  assert.match(dead.why, /not the same fact as “the machine stopped”/);
});

test('silence during a homing cycle is EXPECTED, and is still not current', () => {
  /* $10 bit 12 (report while homing) is off by default, so every single $H
   * produces a multi-second gap. The numbers really are old — so the tab still
   * says so — but calling it a fault would false-fire on every homing cycle,
   * and a control that false-fires gets muted. */
  const f = fresh({ ageMs: 4000, state: 'Home' });
  assert.equal(f.current, false, 'the digits are old and the tab does not pretend otherwise');
  assert.equal(f.stale, true);
  assert.equal(f.expectedSilence, true);
  assert.match(f.why, /EXPECTED/);
  assert.match(f.why, /\$10 bit 12/);
  /* The loudness is what the expected flag suppresses, not the staleness. */
  assert.equal(droRendering(null, f).loud, false);
  assert.equal(droRendering(null, f).markStale, true);
});

test('never-arrived and no-interval are their own verdicts, not a quiet pass', () => {
  const never = fresh({ ageMs: null });
  assert.equal(never.stale, true);
  assert.match(never.why, /No status report has arrived/);

  /* Nothing polling and nothing auto-reporting: there is no interval to be late
   * against, so freshness cannot be judged — which is a stale reading, never a
   * fresh one. */
  const nothingAsking = fresh({ expectMs: null, ageMs: 10 });
  assert.equal(nothingAsking.stale, true);
  assert.match(nothingAsking.why, /Nothing is requesting status reports/);

  const off = droFreshness({ connected: false, ageMs: null, expectMs: null, state: 'Idle' });
  assert.equal(off.stale, false, 'a closed port has no reading to be stale');
});

test('🔴 the DRO keeps its digits and loses its claim — and the plant takes the claim back', () => {
  const dro = {
    machine: { values: [1.5, -2, 30], unavailable: null },
    work: { values: [0, 0, 5], unavailable: null },
    wco: [1.5, -2, 25],
    wcs: 'G54',
    positionKind: 'MPos',
  } as Dro;
  const f = fresh({ ageMs: 5000 });

  const shown = droRendering(dro, f);
  /* Design §17's disconnect row: "freeze the last known DRO AND MARK IT STALE
   * WITH ITS AGE". Blanking it throws away the last thing anyone knew about
   * where the tool is; leaving it unmarked is the failure this exists for. */
  assert.match(shown.machine, /1\.500/);
  assert.equal(shown.markStale, true);
  assert.equal(shown.loud, true);
  assert.match(shown.note, /5000ms/);

  /* 🔴 PLANT — the digits stand as though they were a measurement of now. This
   * is the defect in one line, and the assertions above must be able to see it. */
  const planted = droRendering(dro, f, 'stale-reads-current');
  assert.equal(planted.markStale, false);
  assert.equal(planted.note, '');
  assert.equal(planted.machine, shown.machine, 'the digits are identical — only the claim differs');
});

test('the rendered DRO carries the staleness, in the markup and not in a tooltip', () => {
  const report = {
    raw: '<Idle|MPos:1.000,2.000,3.000|WCO:0.000,0.000,0.000>',
    state: 'Idle' as const,
    stateWord: 'Idle',
    substate: null,
    positionKind: 'MPos' as const,
    position: [1, 2, 3],
    wco: [0, 0, 0],
    bf: null,
    ln: null,
    fs: null,
    pn: null,
    ov: null,
    a: null,
    wcs: 'G54',
    mpg: null,
    homed: null,
    d: null,
    sc: null,
    tlr: null,
    fw: null,
    in: null,
    sd: null,
    dtg: null,
    /* 🔴 THIS FIELD WAS MISSING, and the compiler could not say so while
     * `tests/` sat outside `tsconfig.json`'s `include`. A hand-built fixture
     * that is not a `StatusReport` is a fixture no parser could ever produce:
     * `parseStatusReport` seeds `autoReporting: null` for every report and only
     * an `A:` field moves it, so the shape this test rendered had `undefined`
     * where a real report has `null` — a distinction any `=== null` test would
     * read the other way round. `RunTab` happens not to read it, so the
     * assertions below are unchanged; the next field to be added would not have
     * been so harmless. */
    autoReporting: null,
    unknownFields: [],
  };
  const plan = pollPlan(0);

  const stale = renderToStaticMarkup(
    h(RunTab, {
      tracked: connected(),
      report,
      lastWco: [0, 0, 0],
      lastReportAt: 0,
      now: 9000,
      poll: plan,
    })
  );
  assert.match(from(stale, 'run-dro-machine'), /data-stale="true"/);
  assert.match(from(stale, 'run-dro-work'), /data-stale="true"/);
  assert.match(from(stale, 'run-dro-stale'), /STALE/);
  assert.match(from(stale, 'run-dro-stale'), /data-loud="true"/);
  /* And the number is still on screen — the operator's last known position is
   * information, and the claim about it is what changed. */
  assert.match(from(stale, 'run-dro-machine'), /1\.000/);

  const current = renderToStaticMarkup(
    h(RunTab, {
      tracked: connected(),
      report,
      lastWco: [0, 0, 0],
      lastReportAt: 8950,
      now: 9000,
      poll: plan,
    })
  );
  assert.match(from(current, 'run-dro-machine'), /data-stale="false"/);
  assert.doesNotMatch(current, /data-testid="run-dro-stale"/);

  /* The poll is named on screen, with the setting it was decided from — an
   * operator debugging a frozen readout needs to know what was being asked for. */
  assert.match(from(current, 'run-poll'), /\$481=0/);
  /* ⚠ And the honest caveat about the hidden tab is rendered, not filed away. */
  assert.match(from(current, 'run-poll-caveat'), /not been measured for this app/);
});

/* 🔴 ASSERT ON THE RENDERED PAGE, NOT ON `deriveDro`. `wcoUnavailable` and
 * `deriveDro` were already covered in `run-protocol.test.ts`, and both were
 * green while the TAB called `deriveDro(report, lastWco)` and dropped the `$10`
 * it was holding — so the operator read the weaker sentence on a machine where
 * the answer was known, and every control was green about a function nobody was
 * calling that way. Every assertion below is on the MARKUP for that reason. */
test('the $10 the tab holds reaches the DRO refusal, and without it the refusal still does not overclaim', () => {
  /* A real parse rather than a hand-built object — this file has already been
   * bitten once by a fixture no parser could produce (see the note above). No
   * `WCO:` element, so the work DRO cannot be derived. */
  const { report, error } = parseStatusReport('<Idle|MPos:1.000,2.000,3.000>');
  assert.equal(error, null);
  assert.ok(report);

  /* $10=1 — bit 5 CLEAR. The controller will never send WCO, and pressing 0x87
   * cannot make it. That is the sentence the operator needs. */
  const sharp = renderToStaticMarkup(
    h(RunTab, { tracked: connected(), report, lastWco: null, mask: decodeReportMask(1), now: 0 })
  );
  const sharpNote = from(sharp, 'run-dro-work-note');
  assert.match(sharpNote, /it never will/);
  assert.match(sharpNote, /Set \$10 bit 5 at the controller/);
  assert.match(sharpNote, /0x87 \(full report\) cannot force it/);
  /* And it is NOT the both-cases hedge — the tab knew which case it was in. */
  assert.doesNotMatch(sharpNote, /cannot say which of the two/);

  /* $10=511 — bit 5 SET. Change-only, so it is a WAIT, and 0x87 does help. */
  const waiting = renderToStaticMarkup(
    h(RunTab, { tracked: connected(), report, lastWco: null, mask: decodeReportMask(511), now: 0 })
  );
  assert.match(from(waiting, 'run-dro-work-note'), /change-only element/);
  assert.match(from(waiting, 'run-dro-work-note'), /Send 0x87 \(full report\) to force one/);

  /* ⚠ THE PROPERTY THAT MUST SURVIVE THE THREADING. With no mask the refusal is
   * the honest both-cases sentence, and it says only that $10 was not given to
   * THIS READOUT — never that `$$` was unread, which is a cause it cannot check
   * and would be a false claim printed at an operator. Threading the mask
   * SELECTS an arm; it must not let this one start asserting a reason. */
  const hedged = renderToStaticMarkup(
    h(RunTab, { tracked: connected(), report, lastWco: null, now: 0 })
  );
  const hedgedNote = from(hedged, 'run-dro-work-note');
  assert.match(hedgedNote, /\$10 has not been given to this readout/);
  assert.match(hedgedNote, /cannot say which of the two/);
  assert.doesNotMatch(hedgedNote, /\$\$ has not been read/);
  assert.doesNotMatch(hedgedNote, /it never will/);
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The console — realtime bytes are not lines
   ════════════════════════════════════════════════════════════════════════════ */

test('the three characters grbl documents are accepted bare, and alone', () => {
  const s = connected();
  for (const [typed, name] of [
    ['?', 'statusReport'],
    ['!', 'feedHold'],
    ['~', 'cycleStart'],
  ] as const) {
    const o = consoleAction(typed, s);
    assert.equal(o.kind, 'realtime');
    assert.equal(o.kind === 'realtime' && o.name, name);
  }
  /* But only alone. `?` inside something else is not a status request, and
   * guessing which byte was meant is not something a controller forgives. */
  const notAlone = consoleAction('G0 ?', s);
  assert.equal(notAlone.kind, 'refused');
});

test('every other realtime byte is reachable BY NAME, because most have no character', () => {
  const s = connected();
  /* `0x90` is not something anybody can type. The vocabulary is explicit rather
   * than conventional: a leading `/` means "this is a byte, by name". */
  const ov = consoleAction('/feed+10', s);
  assert.equal(ov.kind, 'realtime');
  assert.equal(ov.kind === 'realtime' && ov.name, 'feedOverridePlus10');
  assert.equal(REALTIME.feedOverridePlus10.byte, 0x91);

  /* Every name in the map resolves to a byte, and where it does not, the reason
   * is `run/protocol.ts`'s own state table verbatim — never "unknown name". A
   * console with its own idea of which byte is legal where would be a second
   * copy of the one table this whole tab keys on. */
  const held = connected({ controllerState: 'Hold' });
  for (const [key, name] of Object.entries(CONSOLE_REALTIME)) {
    const o = consoleAction(`/${key}`, held);
    if (o.kind === 'realtime' || o.kind === 'confirm') {
      assert.equal(o.name, name, `/${key} must resolve to ${name}`);
      assert.equal(realtimeRefusal(name, 'Hold'), null);
      continue;
    }
    assert.equal(o.kind, 'refused', `/${key}: ${o.kind}`);
    assert.deepEqual(
      o.kind === 'refused' ? o.refusals.map((r) => r.why) : [],
      [realtimeRefusal(name, 'Hold')],
      `/${key} must be refused with the protocol module’s own sentence`
    );
  }

  /* 🔴 Two are deliberately absent. `0x84` forces the door state and "must never
   * be offered as" a stop button — in a typed console next to `/hold` it is the
   * byte most likely to be reached for as one. `0xA3` answers a tool change our
   * post never emits (F4). */
  assert.equal(CONSOLE_REALTIME['door'], undefined);
  assert.equal(CONSOLE_REALTIME['tool-ack'], undefined);
  assert.equal(Object.values(CONSOLE_REALTIME).includes('safetyDoor'), false);
  assert.equal(Object.values(CONSOLE_REALTIME).includes('toolAck'), false);

  /* An unknown name is refused, and is NOT quietly sent as a line. */
  const unknown = consoleAction('/estop', s);
  assert.equal(unknown.kind, 'refused');
  assert.match(unknown.kind === 'refused' ? unknown.refusals[0].why : '', /not a realtime command/);
});

test('🔴 a realtime byte is charged NOTHING against the line allowance', () => {
  const s = connected();
  assert.equal(chargedCharacters(consoleAction('?', s)), 0);
  assert.equal(chargedCharacters(consoleAction('/hold', s)), 0);
  assert.equal(chargedCharacters(consoleAction('$$', s)), 3, '$$ costs its two characters plus \\n');

  /* 🔴 PLANT — the byte sent as a line. Two characters charged for something
   * that occupies no line buffer at all. */
  const planted = consoleAction('?', s, {}, 'realtime-as-line');
  assert.equal(planted.kind, 'line');
  assert.equal(chargedCharacters(planted), 2);
  assert.notEqual(chargedCharacters(planted), chargedCharacters(consoleAction('?', s)));
});

test('🔴 PLANT — a realtime byte sent as a line desynchronises the sender at the wire', async () => {
  /* The arithmetic above is the small half. This is what it costs at a
   * controller: `?\n` is picked out as a realtime byte AND leaves an empty line
   * in the RX buffer, which grblHAL answers with its own `ok`. Mid-stream that
   * `ok` is one more reply than lines were sent, and the sender's count and the
   * controller's buffer part company — which is the state in which a streamer
   * cheerfully overruns a real board. */
  const run = async (planted: boolean) => {
    const fake = new FakeController('healthy', { bannerOnConnect: false, autoExecute: true });
    const streamer = new Streamer({
      lines: ['G0 X1', 'G0 X2'],
      mode: 'send-response',
      rxBufferSize: null,
    });
    const inbox: string[] = [];
    const asm = new LineAssembler();
    fake.onData((c) => inbox.push(...asm.push(c)));

    for (const line of streamer.nextLines()) await fake.write(encodeLine(line));
    // The operator asks for status, mid-stream, from the console.
    const outcome = consoleAction('?', connected({ tab: 'Streaming', controllerState: 'Run' }), {},
      planted ? 'realtime-as-line' : undefined);
    if (outcome.kind === 'line') await fake.write(encodeLine(outcome.line));
    else if (outcome.kind === 'realtime') await fake.write(realtimeBytes(outcome.name));
    else assert.fail(`unexpected console outcome ${outcome.kind}`);
    await settle();
    while (inbox.length) streamer.onReply(classifyInbound(inbox.shift() as string));
    return streamer;
  };

  const correct = await run(false);
  assert.equal(correct.state, 'streaming', 'the honest path leaves the stream healthy');
  assert.equal(correct.acknowledged, 1);
  assert.equal(correct.abort, null);

  const broken = await run(true);
  assert.equal(broken.state, 'aborted');
  assert.equal(broken.abort?.reason, 'desync');
  assert.match(broken.abort?.message ?? '', /no line outstanding/);
});

/* ════════════════════════════════════════════════════════════════════════════
   5. The console goes through the SAME refusal set as Start
   ════════════════════════════════════════════════════════════════════════════ */

test('🔴 arbitrary g-code is refused, with run/protocol.ts’s own words', () => {
  const s = connected();
  const o = consoleAction('G0 Z-50', s);
  assert.equal(o.kind, 'refused');

  /* 🔴 The text is the protocol module's, character for character, so this
   * cannot pass while the console quietly grew a second copy of the rule. A
   * console that bypasses the refusal set is a way around every refusal the tab
   * has. */
  const fromProtocol = refusalsFor('console-gcode', s).map((r) => `${r.fact} ${r.why}`);
  assert.deepEqual(
    o.kind === 'refused' ? o.refusals.map((r) => r.why) : [],
    fromProtocol
  );
  assert.match(fromProtocol[0], /motion-control surface with no preflight/);

  /* And it stays refused in the one state everything else opens up in. */
  assert.equal(consoleAction('M3 S18000', connected({ homingSeen: true })).kind, 'refused');
  assert.equal(consoleAction('G10 L20 P1 Z0', s).kind, 'refused');
});

test('🔴 PLANT — the console sends anyway, and the refusal is what was stopping it', () => {
  const s = connected();
  const planted = consoleAction('G0 Z-50', s, {}, 'console-ignores-refusals');
  assert.equal(planted.kind, 'line', 'the plant streams a plunge with no preflight behind it');
  assert.equal(planted.kind === 'line' && planted.line, 'G0 Z-50');
  assert.notEqual(planted.kind, consoleAction('G0 Z-50', s).kind);
});

test('a $ command outside Idle is refused with the controller’s own reason', () => {
  /* grblHAL answers `error:8` — "'$' command cannot be used unless controller
   * state is IDLE". Refusing here means the operator is told WHICH state blocked
   * it rather than being handed a number. */
  const held = consoleAction('$$', connected({ controllerState: 'Hold' }));
  assert.equal(held.kind, 'refused');
  assert.match(held.kind === 'refused' ? held.refusals[0].why : '', /Status_IdleError/);

  /* $H and $X are the exceptions, and they are the whole recovery path:
   * `system.c:486` permits $H from Idle AND Alarm. */
  const alarm = connected({ controllerState: 'Alarm', tab: 'Alarm' });
  assert.equal(consoleAction('$H', alarm).kind, 'line');
  assert.equal(consoleAction('$X', alarm).kind, 'line');
  assert.equal(consoleAction('$$', alarm).kind, 'refused');
});

test('$X is refused exactly where run/protocol.ts refuses Unlock', () => {
  /* R9: `$X` is REFUSED by the controller while homing is required
   * (`system.c:439-460`), and the tab says "run $H" rather than drawing a button
   * that appears to fail. The console asks the same function. */
  const blocked = connected({ controllerState: 'Alarm', tab: 'Alarm', lastUnlockError: 46 });
  const o = consoleAction('$X', blocked);
  assert.equal(o.kind, 'refused');
  assert.deepEqual(
    o.kind === 'refused' ? o.refusals.map((r) => r.id) : [],
    refusalsFor('unlock', blocked).map((r) => r.id)
  );
  assert.match(o.kind === 'refused' ? o.refusals[0].why : '', /error:46/);

  const doorAjar = connected({ controllerState: 'Alarm', tab: 'Alarm', doorAjar: true });
  assert.equal(consoleAction('$X', doorAjar).kind, 'refused');
});

test('a jog typed into the console meets R6, not a second copy of it', () => {
  const alarm = connected({ controllerState: 'Alarm', tab: 'Alarm' });
  const o = consoleAction('$J=G91 X10 F600', alarm);
  assert.equal(o.kind, 'refused');
  assert.deepEqual(
    o.kind === 'refused' ? o.refusals.map((r) => r.id) : [],
    refusalsFor('jog', alarm).map((r) => r.id)
  );
});

test('0x85 from the console meets the same state table the button does', () => {
  /* It sets `char_counter = 0` and flushes the controller's RX buffer
   * (protocol.c:894-897). Typed outside `Jog` it discards queued g-code and
   * makes the sender's count a lie — so it is refused from the console for
   * exactly the reason it is greyed on the button. */
  const idle = connected();
  const o = consoleAction('/jog-cancel', idle);
  assert.equal(o.kind, 'refused');
  assert.match(o.kind === 'refused' ? o.refusals[0].why : '', /FLUSHES the RX buffer/);

  assert.equal(consoleAction('/jog-cancel', connected({ controllerState: 'Jog' })).kind, 'realtime');
  /* And 0x9E is Hold-only, for the same reason: elsewhere grblHAL silently
   * ignores it, and a control that silently does nothing is worse than one that
   * is greyed out. */
  assert.equal(consoleAction('/spindle-stop', idle).kind, 'refused');
  assert.equal(
    consoleAction('/spindle-stop', connected({ controllerState: 'Hold' })).kind,
    'realtime'
  );
});

test('🔴 nothing typed goes out as a LINE while a job is streaming', () => {
  /* The worker's line path bypasses the character count deliberately — it exists
   * for `$` queries sent one at a time while Idle. A line typed mid-stream puts
   * bytes in the controller's RX buffer that the Streamer's count does not know
   * about, and the count is the only thing standing between the sender and an
   * overrun (§2). */
  const streaming = connected({ tab: 'Streaming', controllerState: 'Run' });
  for (const typed of ['$$', '$I', '$G', '$10=511']) {
    const o = consoleAction(typed, streaming);
    assert.equal(o.kind, 'refused', `${typed} must not go out mid-stream`);
    assert.match(o.kind === 'refused' ? o.refusals[0].why : '', /outside the character count/);
  }

  /* 🔴 AND THE REALTIME BYTES STILL GO. "A hold must never be gated on
   * anything" (§12) — a console that blocked `!` mid-job would be a console that
   * blocks the one thing wanted mid-job. */
  assert.equal(consoleAction('!', streaming).kind, 'realtime');
  assert.equal(consoleAction('?', streaming).kind, 'realtime');
  assert.equal(consoleAction('/feed-10', streaming).kind, 'realtime');
});

test('nothing at all is accepted while disconnected, and the input says so', () => {
  const off = initialTrackedState();
  for (const typed of ['?', '$$', '/hold', 'G0 X0']) {
    assert.equal(consoleAction(typed, off).kind, 'refused');
  }
  /* The button's disabled state is DERIVED from the door rather than restating
   * it: the probe is `?`, the least privileged thing the console can produce. */
  assert.equal(consoleRefusals(off).length, 1);
  assert.equal(consoleRefusals(off)[0].id, 'link');
  assert.equal(consoleRefusals(connected()).length, 0);
});

/* ════════════════════════════════════════════════════════════════════════════
   6. A soft reset from the console is Abort by another route
   ════════════════════════════════════════════════════════════════════════════ */

test('🔴 /reset costs the same two presses as Abort, and shares its latch', () => {
  const s = connected();
  const first = consoleAction('/reset', s);
  assert.equal(first.kind, 'confirm', 'the first press sends NOTHING');
  /* The cost is quoted verbatim from grblHAL, the same sentence the Abort
   * control quotes — because the whole point of the two presses is that the
   * consequence is stated before it is incurred. */
  assert.match(
    first.kind === 'confirm' ? first.note : '',
    /Machine position is likely lost due to sudden halt/
  );
  assert.match(first.kind === 'confirm' ? first.note : '', /Nothing was sent/);

  const second = consoleAction('/reset', s, { resetConfirmed: true });
  assert.equal(second.kind, 'realtime');
  assert.equal(second.kind === 'realtime' && second.name, 'reset');
  assert.equal(REALTIME.reset.byte, 0x18);

  /* 🔴 PLANT — the confirmation skipped, which is the console becoming the
   * cheaper of two paths to the same lost position. The expensive path is the
   * one that then stops being used. */
  const planted = consoleAction('/reset', s, {}, 'console-ignores-refusals');
  assert.equal(planted.kind, 'realtime');
  assert.notEqual(planted.kind, first.kind);
});

/* ════════════════════════════════════════════════════════════════════════════
   7. The transcript is a record, not a summary
   ════════════════════════════════════════════════════════════════════════════ */

test('a realtime byte is echoed by NAME as well as verbatim', () => {
  /* Design §13 asks for realtime bytes rendered by name. Without it a `!` from
   * the Hold button left no trace at all, and a console showing every line and
   * none of the bytes is a record of half the conversation. */
  /* 🔴 `_LEGACY`, and it is not a cosmetic suffix. 0x21 IS
   * `CMD_FEED_HOLD_LEGACY` (grbl.h:109); `CMD_FEED_HOLD` is 0x82 (grbl.h:117),
   * a different byte on a different branch with a different guard. The
   * transcript is the record of what went on the wire, so a name in it that
   * belongs to another byte is a wrong record — which is how this lane came to
   * attribute 0x80's $481 guard to `?`. */
  assert.equal(realtimeEcho('feedHold'), '[0x21 CMD_FEED_HOLD_LEGACY]');
  assert.equal(realtimeEcho('statusReport'), '[0x3f CMD_STATUS_REPORT_LEGACY]');
  assert.equal(realtimeEcho('cycleStart'), '[0x7e CMD_CYCLE_START_LEGACY]');
  assert.equal(realtimeEcho('jogCancel'), '[0x85 CMD_JOG_CANCEL]');
  assert.equal(realtimeEcho('reset'), '[0x18 CMD_RESET]');

  const o = consoleAction('/hold', connected());
  assert.equal(o.kind, 'realtime');
  assert.equal(o.kind === 'realtime' && o.echo, '/hold', 'what was typed, verbatim');
  assert.match(o.kind === 'realtime' ? o.note : '', /\[0x21 CMD_FEED_HOLD_LEGACY\]/);
  /* And what a realtime byte is, said where it is sent rather than only in a
   * header nobody reads twice. */
  assert.match(o.kind === 'realtime' ? o.note : '', /one byte, not a line/);

  /* 🔴 AND THE DOC COMMENT'S EXAMPLE IS PINNED TO THE FUNCTION'S OUTPUT. It had
   * gone stale — it showed `CMD_FEED_HOLD` for 0x21 after `c6e36df848` renamed
   * every sub-0x80 byte to `_LEGACY`, so the one line a reader takes the format
   * from named a byte that is 0x82. The behaviour was right the whole time,
   * which is exactly why nothing said anything. Read out of the file so the two
   * cannot drift again: a comment is not a control unless something reads it. */
  const doc = readFileSync(join(here, '..', 'src', 'RunTab.tsx'), 'utf8');
  const example = /\*\* `(\[0x21 [A-Z_]+\])` — design §13/.exec(doc);
  assert.ok(example, "realtimeEcho's doc comment must open with its own example rendering");
  assert.equal(example[1], realtimeEcho('feedHold'));
});

test('what was REFUSED is in the transcript too, marked as refused', () => {
  const lines: ConsoleLine[] = [
    { dir: 'out', text: '$$', at: 0 },
    { dir: 'in', text: '$10=511', at: 1 },
    { dir: 'note', text: 'a note', at: 2 },
    { dir: 'refused', text: 'G0 Z-50', at: 3 },
  ];
  const html = renderToStaticMarkup(h(ConsolePanel, { lines }));
  const log = from(html, 'run-console-log');
  /* Verbatim, each with the side it came from. A transcript that showed only
   * what the tab ALLOWED would be a record of the tab, not of the machine —
   * and the command that never left is often the finding. */
  assert.match(log, /&gt; \$\$/);
  assert.match(log, /&lt; \$10=511/);
  assert.match(log, /# a note/);
  assert.match(log, /✗ G0 Z-50/);

  /* Every direction has a mark and a word for it, and the legend renders. */
  assert.equal(new Set(Object.values(CONSOLE_DIRS).map((d) => d.mark)).size, 4);
  assert.match(from(html, 'run-console-legend'), /nothing was sent/);
});

test('the console offers an input, and it is disabled with the reason when it cannot be used', () => {
  const off = renderToStaticMarkup(h(RunTab, {}));
  const send = from(off, 'run-console-send');
  assert.match(send, /disabled/);
  assert.match(send, /data-refused="link"/);
  assert.match(from(off, 'run-console-refused'), /Not connected/);

  const on = renderToStaticMarkup(h(RunTab, { tracked: connected() }));
  assert.match(from(on, 'run-console-input'), /data-testid="run-console-input"/);
  assert.doesNotMatch(from(on, 'run-console-send').slice(0, 200), /disabled/);

  /* 🔴 The copy no longer claims the console is read-only — it was true, it is
   * not now, and a stale red lies exactly like a stale green. */
  assert.doesNotMatch(on, /Read-only: there is no input here yet/);
  assert.doesNotMatch(on, /The console has no input/);
  assert.doesNotMatch(on, /Nothing polls for status/);

  /* And what the console will and will not take is stated where it is typed. */
  const rules = from(on, 'run-console-rules');
  assert.match(rules, /Realtime bytes are not lines/);
  assert.match(rules, /Abort by another route/);
  assert.match(rules, /not echoed here/);
});
