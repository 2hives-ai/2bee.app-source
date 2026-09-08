// The streamer, in a dedicated worker. It owns the port.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS IS A WORKER, AND IT IS NOT A PERFORMANCE DECISION
// ─────────────────────────────────────────────────────────────────────────────
//
// Chrome throttles `setTimeout`/`setInterval` in hidden pages — ~1 s when
// hidden, and up to ~1 min under intensive throttling
// (<https://developer.chrome.com/blog/timer-throttling-in-chrome-88>, read
// 2026-08-10, design §17). **A streamer built on a timer pump stalls the moment
// the operator switches tabs, and a stalled streamer leaves a turning cutter
// stationary in the work.** That burns the edge and, on a small cutter, snaps
// it.
//
// So nothing here is paced by a timer. The loop is `await reader.read()` and the
// controller's own `ok` replies — I/O completions, which the Chrome
// documentation does not list as throttled. Web Serial is
// `[Exposed=(DedicatedWorker,Window)]` and `WorkerNavigator` carries `serial`
// (design §1), which is what makes it possible to run the whole thing off the
// main thread — so "the UI thread was busy rendering the toolpath and the write
// was late" stops being a category of failure.
//
// 🔴 **MEASURED 2026-08-28 — and the sentence this replaces was WRONG when
// written.** It read "AND IT IS UNMEASURED … There is no browser on this box,
// no serial port" — Playwright had been driving a real browser here since
// 2026-08-27. RUN-18 is now taken by `web/e2e/run18.spec.ts`: a TEST-ONLY
// worker entry (`web/e2e/run18/streamer-fake.worker.ts`) installs a fake
// `self.navigator.serial` and then imports THIS module, unmodified — the page
// hands the worker only a port index, so no page-level seam could ever reach
// here, and none was added. Hidden leg is genuinely hidden (Xvfb + raw-CDP tab
// switch; Playwright's own launch args disable the throttling under test, and
// its focus emulation keeps every page 'visible' — both had to be left
// behind). Result, three runs: hidden/visible throughput ratio 0.77–0.80,
// ZERO stall events. ⚠ The transport was `fake.ts` — this lane's own model of
// grblHAL, not a machine; and the worker's OWN timers (status-poll interval)
// under a hidden page are still unmeasured — this spec exercises the I/O pump,
// which is timer-free by construction.
//
// ⚠ A worker of a hidden page may itself have its timers throttled — the Chrome
// note is about pages and this lane has not measured workers. That is why the
// stall watchdog below is EVENT-DRIVEN first (checked on every write completion
// and every arriving line) and only backstopped by an interval. If the interval
// is throttled the event-driven half still fires the moment anything happens; if
// NOTHING happens, that is itself the stall and only the backstop can notice it.
// Both are here because neither alone is enough.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE DOES NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
// It does not parse a status report, does not hold the error or alarm tables and
// does not decide whether a control is allowed. Inbound lines go up to the window
// verbatim and `./protocol` parses them there; the only classification down here
// is `./protocol`'s own `classifyInbound`, inside its own `Streamer`, reached
// through `StreamPump`. There is no second parser in this file and there must
// not be one.

import {
  StatusPoller,
  StreamPump,
  WebSerialLink,
  classifyPortError,
  encodeLine,
  resolvePort,
  type SerialCapableNavigator,
  type WorkerCommand,
  type WorkerEvent,
} from './transport';
import { Streamer, realtimeBytes } from './protocol';

/** How long without a resolved write before the window is told (ms). */
const STALL_WARN_MS = 750;
/** The backstop tick. See the note about worker timers at the top. */
const WATCHDOG_MS = 250;

const post = (e: WorkerEvent): void => {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(e);
};

let link: WebSerialLink | null = null;
let pump: StreamPump | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastStallReport = 0;

/* ── status polling ──────────────────────────────────────────────────────────
 *
 * 🔴 THE POLL TIMER IS HERE AND NOT IN THE PAGE, for the same reason the
 * streamer is: Chrome throttles timers in a hidden PAGE, and a DRO that quietly
 * drops to 1 Hz when the operator switches tabs is a frozen readout that looks
 * live. Moving it here is a real improvement and it is **not a guarantee** — a
 * worker of a hidden page may be throttled too and this lane has not measured
 * it. That is why the poll never carries the freshness claim: the window renders
 * the AGE of the last report that actually arrived, so a poll that did not
 * happen shows up as an old number labelled old rather than as nothing at all.
 *
 * ⚠ The poller writes DIRECTLY to the link and posts no `sent` event. At 5 Hz an
 * echoed `?` would be ~300 console lines a minute in a 500-line buffer, which
 * would push every real transaction out of the transcript inside two minutes —
 * and the console exists to be the record that gets routed to `pcb`. The window
 * says so in the console copy rather than leaving it to be noticed.
 */
let poller: StatusPoller | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  poller = null;
}

function publishStream(): void {
  if (!pump) return;
  post({
    t: 'stream',
    state: pump.state,
    sent: pump.sent,
    acknowledged: pump.acknowledged,
    total: pump.total,
    abort: pump.abort,
  });
}

function checkStall(): void {
  if (!pump || pump.state !== 'streaming') return;
  const ms = pump.sinceLastWrite();
  if (ms < STALL_WARN_MS) return;
  const now = Date.now();
  if (now - lastStallReport < STALL_WARN_MS) return; // rate-limit the report, not the detection
  lastStallReport = now;
  post({ t: 'stall', ms });
}

async function attach(cmd: Extract<WorkerCommand, { t: 'attach' }>): Promise<void> {
  const nav = (self as unknown as { navigator?: SerialCapableNavigator }).navigator;
  const serial = nav?.serial;
  if (!serial) {
    post({
      t: 'attach-failed',
      error: {
        kind: 'unknown',
        ours: true,
        message:
          'This worker has no `navigator.serial`. Web Serial is specified as exposed to ' +
          'dedicated workers; if it is missing here the streamer cannot run off the main thread, ' +
          'and the tab must say so rather than quietly moving it back.',
      },
    });
    return;
  }
  const found = await resolvePort(serial, cmd);
  if ('error' in found) {
    post({ t: 'attach-failed', error: found.error });
    return;
  }
  const l = new WebSerialLink(found.port);
  // 🔴 Reader first, then anything else (design §11). A banner that arrives
  // while nobody is reading is lost, and its absence is then indistinguishable
  // from a board that is not grblHAL at all.
  l.onData((chunk) => {
    // Framing and classification happen inside the pump, which owns
    // `./protocol`'s LineAssembler. This listener exists only to give the window
    // the raw bytes for the console — decoded here, never re-framed.
    let text = '';
    for (const b of chunk) text += String.fromCharCode(b);
    for (const line of text.split(/\r?\n/)) {
      if (line.length) post({ t: 'line', line, at: Date.now() });
    }
    checkStall();
  });
  l.onFailure((failure) => {
    // The port is gone. Stop feeding — and note what that does NOT do: the
    // controller keeps executing everything already in its buffer, with the
    // spindle running (design §10). The window says that sentence to the
    // operator; the worker's job is to stop writing into a dead stream.
    pump?.stop('the serial port disconnected');
    // Stop asking a port that is gone. Left running, every tick would reject and
    // the only visible effect would be a rising failure count nobody reads —
    // while the window's report AGE, which is the honest signal, keeps climbing
    // either way.
    stopPolling();
    publishStream();
    post({ t: 'failure', failure });
  });
  try {
    await l.open(cmd.baudRate ?? 115200);
  } catch (err) {
    // `'opening'`: this is `open()` itself rejecting, where a NetworkError means
    // the OS would not give us the port — most often because another program is
    // already holding it — and NOT that the cable came out.
    post({ t: 'attach-failed', error: classifyPortError(err, 'opening') });
    return;
  }
  link = l;
  post({ t: 'attached', info: found.port.getInfo() });
  if (watchdog == null) watchdog = setInterval(checkStall, WATCHDOG_MS);
  /* A new port is a new connection with no WCO, no Ov and no H — every
   * change-only element is unknown again — so whatever poll the window asks for
   * next, its FIRST request is a full one. */
  poller?.resync();
}

async function handle(cmd: WorkerCommand): Promise<void> {
  switch (cmd.t) {
    case 'attach':
      await attach(cmd);
      return;
    case 'load': {
      if (!link) {
        /* 🔴 NOT A SILENT RETURN. The window has just told an operator a job is
         * starting; if this returns quietly the tab shows `Streaming` forever
         * and nothing is on the wire — the same class of defect as a button
         * that is enabled and inert, one layer down. It is reported through the
         * stream channel because that is the channel the window is already
         * watching for this job. */
        post({
          t: 'stream',
          state: 'aborted',
          sent: 0,
          acknowledged: 0,
          total: cmd.lines.length,
          abort: {
            reason: 'stopped',
            code: null,
            line: null,
            lineNumber: null,
            message:
              'The streamer was asked to load a program with no port open. Nothing was sent. ' +
              'This is a defect in this app, not a machine fault — connect first.',
          },
        });
        return;
      }
      pump?.detach();
      // 🔴 The buffer size has no default and is not guessed here. `./protocol`'s
      // Streamer THROWS if character counting is asked for without a measured
      // one (R13), and that throw is the intended behaviour: the window measures
      // `Bf` at connect or declares send-response with the reason on screen.
      const streamer = new Streamer({
        lines: cmd.lines,
        mode: cmd.mode,
        rxBufferSize: cmd.rxBufferSize,
      });
      pump = new StreamPump({
        link,
        streamer,
        onEvent: (e) => {
          if (e.t === 'sent') {
            post({ t: 'sent', line: e.line ?? '', lineNumber: e.lineNumber ?? 0, at: Date.now() });
          }
          if (e.t === 'state') publishStream();
          checkStall();
        },
      });
      pump.attach();
      publishStream();
      return;
    }
    case 'start':
      if (!pump) {
        // Same reason as `load` above: a start with nothing loaded must not look
        // like a start that is under way.
        post({
          t: 'stream',
          state: 'aborted',
          sent: 0,
          acknowledged: 0,
          total: 0,
          abort: {
            reason: 'stopped',
            code: null,
            line: null,
            lineNumber: null,
            message:
              'The streamer was told to start with no program loaded. Nothing was sent. ' +
              'This is a defect in this app, not a machine fault.',
          },
        });
        return;
      }
      await pump.pump();
      publishStream();
      return;
    case 'stop':
      pump?.stop(cmd.why);
      publishStream();
      return;
    case 'write':
      // A single line outside the stream: the console's `$` queries and the
      // handshake. It bypasses the character count deliberately — these are sent
      // one at a time while `Idle` — and the tab is what refuses g-code here
      // (design §15, the console row).
      if (link) await link.write(encodeLine(cmd.line));
      post({ t: 'sent', line: cmd.line, lineNumber: -1, at: Date.now() });
      return;
    case 'realtime':
      // One byte, from `./protocol`'s table, never from a string (§3). Reachable
      // before a program is loaded — `!`, `?` and `0x18` are exactly the things
      // an operator needs when there is no job.
      if (pump) await pump.realtime(cmd.name);
      else if (link) await link.write(realtimeBytes(cmd.name));
      return;
    case 'poll': {
      stopPolling();
      if (cmd.intervalMs <= 0 || !link) return;
      const p = new StatusPoller(link, cmd.fullEvery);
      poller = p;
      // 🔴 The first request of any connection is `0x87`, always. See
      // `StatusPoller.resync` for why that is required rather than tidy.
      p.tick();
      pollTimer = setInterval(() => {
        p.tick();
      }, cmd.intervalMs);
      return;
    }
    case 'throughput': {
      const t = pump?.throughput ?? { bytes: 0, ms: 0, bytesPerSecond: 0 };
      post({ t: 'throughput', ...t });
      return;
    }
    case 'close': {
      if (watchdog != null) {
        clearInterval(watchdog);
        watchdog = null;
      }
      stopPolling();
      pump?.detach();
      await link?.close();
      link = null;
      pump = null;
      post({ t: 'closed' });
      return;
    }
  }
}

self.addEventListener('message', (ev: MessageEvent<WorkerCommand>) => {
  void handle(ev.data).catch((err: unknown) => {
    /* `'connected'`: every command that reaches this catch — write, load,
     * start, stop, close — runs against a port `attach` has already opened.
     * `attach` catches its own `open()` rejection above and returns before this
     * can see it. */
    post({ t: 'failure', failure: { fatal: false, error: classifyPortError(err, 'connected') } });
  });
});

export {};
