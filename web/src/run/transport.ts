// The transport: bytes to a grblHAL controller over Web Serial, and the pump
// that carries them.
//
// Design: `docs/design-76-run-tab.md` §1 (the transport), §2 (streaming and the
// buffer size), §3 (the realtime bytes), §17 (the throttled tab). Every claim
// this file acts on is cited to the section that verified it against grblHAL's
// own source — not to this file's author's memory of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS FILE HAS NEVER DONE
// ─────────────────────────────────────────────────────────────────────────────
//
// **No byte written by this file has ever reached a serial port.** There is no
// browser on the box it was written on, no WebGL, no serial device, and the
// router is ORDERED, NOT ARRIVED (`ops`, delivery estimated 2026-09-30).
// Everything below is exercised in node against `fake.ts`, and the fake is this
// lane's model of grblHAL: it can confirm that the pump agrees with our reading,
// and it cannot discover that our reading is wrong (design §18's closing
// section, and it means exactly what it says).
//
// RUN-18 (throughput under `document.visibilityState === 'hidden'`) IS
// measured as of 2026-08-28 — by `web/e2e/run18.spec.ts` through a test-only
// worker entry, against `fake.ts` (this lane's model, NOT a machine), with the
// hidden leg verified genuinely hidden. {@link StreamPump.throughput} is the
// instrument it reads. Ratio hidden/visible 0.77–0.80, zero stalls.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM, AND WHAT IS DELIBERATELY NOT HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// `./protocol` owns **everything that decides meaning**: the `Link` interface,
// line framing (`LineAssembler`), classification (`classifyInbound`), the status
// parse, the DRO derivation, the alarm and error tables, the realtime byte table
// and the refusal set — including `Streamer`, which is character counting as a
// pure function with no I/O.
//
// This file owns **only what touches the wire**: opening a port, reading it,
// writing it, and turning `./protocol`'s pure `Streamer` into a loop driven by
// `await reader.read()` and by replies. There is no second parser, no second
// framer, no second realtime table and no second refusal set here, and if one
// starts to appear it should be deleted rather than kept in step.

import {
  LineAssembler,
  Streamer,
  classifyInbound,
  realtimeBytes,
  type Link,
  type ProtocolPlant,
  type RealtimeName,
  type StreamAbort,
} from './protocol';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Web Serial, typed just enough
 * ──────────────────────────────────────────────────────────────────────────── */

// TypeScript's DOM library does not declare Web Serial, and `@types/w3c-web-serial`
// is a dependency this lane would have to licence-check (AGPL compatibility, per
// `AGENTS.md`) for four interfaces. These are the four, structurally, taken from
// <https://wicg.github.io/serial/> as read on 2026-08-10 (design §1). They are
// NOT a global augmentation: augmenting `Navigator` would make `navigator.serial`
// look present at compile time on every platform, which is the opposite of what
// §1 concludes — feature-detect, never assume.

export interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
}

export interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters?: SerialPortInfoLike[] }): Promise<SerialPortLike>;
  addEventListener(type: 'connect' | 'disconnect', cb: (e: Event) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', cb: (e: Event) => void): void;
}

/** The half of `navigator` / `WorkerNavigator` this file touches. */
export interface SerialCapableNavigator {
  serial?: SerialLike;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Can this browser do it at all?
 * ──────────────────────────────────────────────────────────────────────────── */

export type AvailabilityCode = 'ok' | 'no-api' | 'insecure-context';

export interface Availability {
  ok: boolean;
  code: AvailabilityCode;
  /** One sentence, shown to the operator. Names the fact, not a workaround. */
  reason: string;
}

/**
 * Feature-detect. **Never version-detect** (design §1): a UA sniff both wrongly
 * excludes a browser that ships Web Serial tomorrow and wrongly admits one that
 * lists it behind a flag.
 *
 * `secureContext` is passed in rather than read from `globalThis` so both
 * branches can be exercised in node — an untestable branch in a refusal path is
 * a refusal nobody has watched refuse.
 */
export function serialAvailability(
  nav: SerialCapableNavigator | undefined,
  secureContext: boolean
): Availability {
  if (!nav || !('serial' in nav) || !nav.serial) {
    return {
      ok: false,
      code: 'no-api',
      reason:
        'This browser does not implement the Web Serial API. The Run tab needs Chrome or Edge ' +
        'on a desktop; Firefox and Safari do not implement it and there is no polyfill — a ' +
        'serial port is not something JavaScript can shim.',
    };
  }
  if (!secureContext) {
    return {
      ok: false,
      code: 'insecure-context',
      reason:
        'Web Serial requires a secure context. Serve this page over HTTPS, or from localhost. ' +
        'The API is present but the browser will refuse to open a port here.',
    };
  }
  return { ok: true, code: 'ok', reason: 'Web Serial is available.' };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. When the browser says no, say WHICH no
 * ──────────────────────────────────────────────────────────────────────────── */

export type PortErrorKind =
  | 'cancelled'
  | 'no-gesture'
  | 'blocked-by-policy'
  | 'already-open-here'
  | 'os-refused'
  | 'disconnected'
  | 'unknown';

export interface PortError {
  kind: PortErrorKind;
  /** What the operator is told. */
  message: string;
  /** True when this is our bug rather than the operator's situation. */
  ours: boolean;
}

/**
 * Which side of `open()` this error arrived on. **No sensible default exists
 * for the meaning of `NetworkError`, only for our call sites**: the same
 * DOMException name means *"the operating system would not give us the port"*
 * before `open()` resolves and *"the port we already had has gone"* after it.
 *
 * ⚠ The default is `'opening'` because the one call site outside this lane —
 * `RunTab.tsx:2507`, the `.catch` on the connect path — is the opening phase.
 * The two `'connected'` call sites are in this file and in
 * `streamer.worker.ts` and pass it explicitly. A default that is right for the
 * caller that cannot be edited, and wrong nowhere.
 */
export type PortErrorPhase = 'opening' | 'connected';

/**
 * Design §17, the "browser refuses the port" row: these are four different facts
 * and collapsing them into "could not open port" throws away the only part that
 * tells anyone what to do.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 CORRECTED 2026-08-11 — THE TWO BRANCHES WERE SWAPPED, ON THE ONE MESSAGE
 *    THE DESIGN SAYS IS WORTH GETTING RIGHT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until today `InvalidStateError` rendered as *"already open in another tab or
 * application (gSender, CNCjs, …)"* and `NetworkError` rendered as *"the cable
 * was unplugged"*. **Both are wrong, and the second is the harmful one.** Read
 * at the primary sources on 2026-08-11:
 *
 *  - **`InvalidStateError` is step 2 of `open()`** — *"If `this.[[state]]` is not
 *    `"closed"`, reject promise with an `InvalidStateError`"*
 *    (<https://wicg.github.io/serial/>). `[[state]]` belongs to **this
 *    `SerialPort` object in this page**. Blink's string is literally
 *    `"The port is already open."` (`serial_port.cc`, `kInvalidStateError`).
 *    **It cannot mean another application** — nothing outside this page can
 *    move this object's `[[state]]`.
 *  - **The operating system refusing the device is `NetworkError`** — step 9:
 *    *"Invoke the operating system to open the serial port … **If this fails for
 *    any reason**, … reject promise with a `NetworkError`"*. Blink:
 *    `kNetworkError`, `"Failed to open serial port."`
 *
 * ⇒ **The case the design calls "the most common real failure" — another
 * program holding the port — arrives as `NetworkError`, and we were telling the
 * operator the cable had fallen out.** They would go and check the cable.
 *
 * ⚠ **And the spec does not let us split it further.** *"If this fails for any
 * reason"* is one branch for a device held by another program, a device with no
 * permission (`dialout`), and a device that is gone. So `os-refused` names all
 * three in the order worth checking, rather than picking one and sounding sure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT EXCLUSIVITY WE ACTUALLY GET, AND IT IS NOT WHAT THIS MESSAGE IMPLIED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The old string ended *"only one program may hold a serial port"*. **That is
 * false on Linux and it is the assumption this whole lane's character counting
 * silently rests on** — see `./protocol`'s `PortOwnershipWatch`.
 *
 *  - **The Web Serial API guarantees nothing.** The spec has no exclusivity
 *    concept at all: no `exclusive` option, no mention of other applications or
 *    processes. There is nothing here to *ask* for.
 *  - **Chromium claims it anyway, on POSIX, and only forwards.**
 *    `services/device/serial/serial_io_handler_posix.cc` calls
 *    `ioctl(fd, TIOCEXCL)` in `PostOpen()`, with its own comment that the
 *    Windows exclusive-share flags *"do nothing on POSIX-based systems"*. And
 *    `TIOCEXCL` is: *"Put the terminal into exclusive mode. **No further
 *    `open(2)` operations** on the terminal are permitted. (They fail with
 *    `EBUSY`, except for a process with the `CAP_SYS_ADMIN` capability.)"*
 *    (`man 2const TIOCEXCL`, read on this box, 2026-08-11.)
 *
 * ⇒ **It stops the writer who arrives after us. It does nothing whatsoever
 * about the writer who was already there** — that process's file descriptor is
 * untouched, it keeps reading and writing the same tty, and our `open()`
 * *succeeds*. There is no error to classify in that case and no API call that
 * would produce one. That is why detection exists in `./protocol` and why the
 * refusal there names the limit out loud.
 */
export function classifyPortError(err: unknown, phase: PortErrorPhase = 'opening'): PortError {
  const name = (err as { name?: string } | null)?.name ?? '';
  const raw = (err as { message?: string } | null)?.message ?? String(err);
  switch (name) {
    case 'NotFoundError':
      return {
        kind: 'cancelled',
        ours: false,
        message: 'No port was chosen. Nothing was opened — this is not an error.',
      };
    case 'SecurityError':
      return {
        kind: 'no-gesture',
        ours: true,
        message:
          'The browser refused the port chooser because it was not opened from a click. ' +
          'That is a defect in this tab, not something you can fix — please report it.',
      };
    case 'NotAllowedError':
      return {
        kind: 'blocked-by-policy',
        ours: false,
        message:
          'Serial access is blocked by this page’s permissions policy. If the app is embedded ' +
          'in a frame, the embedder must grant the "serial" feature.',
      };
    case 'InvalidStateError':
      /* THIS page already has this port open — `[[state]] !== "closed"`. It is
       * our own bookkeeping, not the operator's situation, and it must not send
       * anyone off to close gSender. */
      return {
        kind: 'already-open-here',
        ours: true,
        message:
          'This tab already has that port open, so nothing was done. That is a defect in this ' +
          'tab — it asked the browser to open a port it was already holding. Please report it; ' +
          'it is not something on the machine.',
      };
    case 'NetworkError':
      return phase === 'connected'
        ? {
            kind: 'disconnected',
            ours: false,
            message:
              'The port went away. Either the cable was unplugged or the device reset its USB stack.',
          }
        : {
            kind: 'os-refused',
            ours: false,
            message:
              'The operating system would not open that port. The browser reports one error for ' +
              'every cause, so all three are worth checking, most likely first: another program ' +
              'is holding it (gSender, CNCjs, a serial monitor, an Arduino IDE, a screen/minicom ' +
              'session) — close it there; or this user cannot open the device at all (on Linux, ' +
              'membership of the dialout group); or the board is no longer plugged in. ' +
              '⚠ Note the direction: a program that opened the port BEFORE this tab did is not ' +
              'refused by this — it keeps the port, and this tab may open it too.',
          };
    default:
      return { kind: 'unknown', ours: false, message: raw || 'The port could not be opened.' };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Encoding — and the one that silently ruins a realtime byte
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A g-code line, ASCII, with the terminator grblHAL's line parser wants.
 *
 * 🔴 The non-ASCII guard is flow control, not pedantry: `./protocol`'s
 * `Streamer` charges the controller's RX buffer `line.length + 1` **characters**,
 * and a multi-byte character would put more bytes on the wire than the count
 * was charged for. The count is the only thing standing between us and an
 * overrun, so the two must agree byte-for-byte — see {@link lineCost} and the
 * test that pairs them.
 */
export function encodeLine(line: string): Uint8Array {
  const out = new Uint8Array(line.length + 1);
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c > 0x7f) {
      throw new RangeError(
        `non-ASCII character U+${c.toString(16)} in a g-code line: ${JSON.stringify(line)} — ` +
          'it would cost more bytes on the wire than the character count charges for'
      );
    }
    out[i] = c;
  }
  out[line.length] = 0x0a;
  return out;
}

/**
 * The number of characters this line occupies in the controller's RX buffer.
 *
 * The same `len + 1` `./protocol`'s `Streamer` charges and grbl's own
 * `stream.py` counts (§2). Separate from {@link encodeLine} on purpose: these
 * two must agree, and a test can assert that they do.
 */
export function lineCost(line: string): number {
  return line.length + 1;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. The Link over a real port
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Events a real port has and the {@link Link} seam does not carry. `Link` is
 * three methods on purpose — it is what the pump needs and no more — so the
 * failure channel hangs off the concrete class rather than widening the seam.
 */
export interface LinkFailure {
  /** `fatal` means the port is gone; the pump must stop, not retry. */
  fatal: boolean;
  error: PortError;
}

const DEFAULT_BAUD = 115200;

/**
 * A {@link Link} backed by one open Web Serial port.
 *
 * 🔴 **The reader loop starts before anything is written** (design §11) — a
 * banner that arrives while nobody is reading is a banner that is lost, and its
 * absence is then indistinguishable from a board that is not grblHAL.
 *
 * 🔴 **Writes are serialised through one promise chain.** Two concurrent
 * `write()`s on a `WritableStreamDefaultWriter` are a `TypeError` waiting to
 * happen, and interleaved halves of two g-code lines are a syntax error at a
 * motion controller. The chain also gives realtime bytes their guarantee:
 * because {@link StreamPump} awaits each line's write before the count allows
 * another, a `!` queues behind at most one line. ⚠ That guarantee lives in the
 * pump's discipline, not in this class — hand this Link a thousand lines at once
 * and `!` waits behind all of them. §17: *"a `!` that waits behind 400 buffered
 * lines is not a hold."*
 */
export class WebSerialLink implements Link {
  private readonly port: SerialPortLike;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly dataCbs = new Set<(chunk: Uint8Array) => void>();
  private readonly failCbs = new Set<(f: LinkFailure) => void>();
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  /** Bytes written since construction. Half of the RUN-18 instrument (§17). */
  bytesWritten = 0;
  /** Bytes read since construction. */
  bytesRead = 0;
  /** `Date.now()` of the last write that RESOLVED, not the last one issued. */
  lastWriteAt = 0;

  constructor(port: SerialPortLike) {
    this.port = port;
  }

  /**
   * Open, then start reading. Callers must `await` this before writing.
   *
   * `bufferSize` is left at the implementation default (255 per the spec, §1);
   * it is the browser's read buffer and has nothing to do with the controller's
   * RX buffer, which is measured from `Bf` (§2) and never guessed.
   */
  async open(baudRate: number = DEFAULT_BAUD): Promise<void> {
    await this.port.open({ baudRate });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const readable = this.port.readable;
    if (!readable) {
      this.fail({ fatal: true, error: classifyPortError({ name: 'NetworkError' }, 'connected') });
      return;
    }
    const reader = readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        // 🔴 THIS `await` IS THE ARCHITECTURE. It is an I/O completion, not a
        // timer, and Chrome's throttling documentation names only timers
        // (design §17). A streamer paced by `setTimeout` stalls the moment the
        // tab is hidden, and a stalled streamer leaves a turning cutter
        // stationary in the material. ⚠ UNMEASURED — that is `RUN-18`.
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          this.bytesRead += value.length;
          for (const cb of this.dataCbs) cb(value);
        }
      }
    } catch (err) {
      // Physical removal errors the readable with NetworkError and sets
      // [[readFatal]] (§1). There is no recovering this stream. `'connected'`:
      // by here `open()` has resolved, so a NetworkError is a port that has
      // GONE, not one the OS refused to give us.
      this.fail({ fatal: true, error: classifyPortError(err, 'connected') });
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released by close() */
      }
      if (this.reader === reader) this.reader = null;
    }
  }

  /**
   * Write bytes. **Exactly these bytes** — nothing here re-encodes anything.
   *
   * 🔴 The realtime hazard (§3) is upstream of this method and cannot be fixed
   * inside it: `new TextEncoder().encode('')` is `0xC2 0x90`, two bytes,
   * and by the time they arrive here they are just bytes. `./protocol`'s
   * `realtimeBytes(name)` is the constructor that cannot get it wrong, and
   * `RUN-4` asserts the single byte at the fake's wire.
   */
  write(bytes: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('link closed'));
    const next = this.writeChain.then(async () => {
      const w = this.writer ?? this.acquireWriter();
      await w.write(bytes);
      this.bytesWritten += bytes.length;
      this.lastWriteAt = Date.now();
    });
    // Keep the chain alive across a rejection: one failed write must not
    // permanently poison every later write with the same rejection.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private acquireWriter(): WritableStreamDefaultWriter<Uint8Array> {
    const writable = this.port.writable;
    if (!writable) throw new Error('port has no writable side');
    this.writer = writable.getWriter();
    return this.writer;
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  /** The channel `Link` does not have: the port died, or the browser refused. */
  onFailure(cb: (f: LinkFailure) => void): () => void {
    this.failCbs.add(cb);
    return () => this.failCbs.delete(cb);
  }

  private fail(f: LinkFailure): void {
    for (const cb of this.failCbs) cb(f);
  }

  /**
   * Close.
   *
   * ⚠ **Closing the port does not stop the machine.** grblHAL keeps executing
   * whatever is already in its planner and RX buffer, then sits at `Idle` with
   * the spindle still running and the tool wherever the last buffered move left
   * it (§10). Whoever calls this owes the operator that sentence.
   */
  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already errored */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* not held */
    }
    this.writer = null;
    try {
      await this.port.close();
    } catch {
      /* already gone */
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. The pump — `./protocol`'s pure streamer, driven by I/O
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PumpEvent {
  t: 'sent' | 'inbound' | 'state' | 'stall';
  line?: string;
  /** 1-based, matching the streamer's own line numbering. */
  lineNumber?: number;
  state?: string;
  abort?: StreamAbort | null;
  /** For `stall`: milliseconds since a write last resolved. */
  ms?: number;
}

export interface PumpOptions {
  link: Link;
  streamer: Streamer;
  onEvent?: (e: PumpEvent) => void;
  /** Injected for tests; `Date.now` in the product. */
  now?: () => number;
  /** Passed through to `classifyInbound` — plants only, never set by the UI. */
  plant?: ProtocolPlant;
}

/**
 * Turns `./protocol`'s pure `Streamer` into a loop over a real `Link`.
 *
 * 🔴 **Nothing in this class is driven by a timer.** {@link pump} runs when a
 * write resolves and when a reply arrives; both are I/O completions. Design
 * §17: a timer pump stalls the moment the tab is hidden, and *"a streamer that
 * stalls mid-cut does not pause the job — it leaves a turning cutter stationary
 * in the material"*.
 *
 * The decisions — what counts as a reply, when to abort, how many characters may
 * be outstanding — are all `./protocol`'s. This class contributes exactly two
 * things the pure streamer cannot have: the write, and the clock that says how
 * long it has been since one succeeded.
 */
export class StreamPump {
  private readonly link: Link;
  private readonly streamer: Streamer;
  private readonly emit: (e: PumpEvent) => void;
  private readonly now: () => number;
  private readonly plant: ProtocolPlant | undefined;
  private readonly assembler = new LineAssembler();
  private unsubscribe: (() => void) | null = null;
  private pumping = false;
  private startedAt = 0;
  private lastWriteAt = 0;
  private bytes = 0;
  private lastState: string;

  constructor(o: PumpOptions) {
    this.link = o.link;
    this.streamer = o.streamer;
    this.emit = o.onEvent ?? (() => undefined);
    this.now = o.now ?? (() => Date.now());
    this.plant = o.plant;
    this.lastState = o.streamer.state;
  }

  /** Attach to the link's byte stream. Idempotent. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.link.onData((chunk) => {
      for (const line of this.assembler.push(chunk, this.plant)) this.accept(line);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Partial line held by the framer, shown in the console rather than hidden. */
  get pendingBytes(): string {
    return this.assembler.pending;
  }

  get state(): string {
    return this.streamer.state;
  }

  get sent(): number {
    return this.streamer.sent;
  }

  get acknowledged(): number {
    return this.streamer.acknowledged;
  }

  get total(): number {
    return this.streamer.total;
  }

  get abort(): StreamAbort | null {
    return this.streamer.abort;
  }

  /**
   * The `RUN-18` instrument: bytes on the wire and the wall time they took.
   *
   * 🔴 **This has never been read with a page hidden.** It is the number that
   * decides whether the read-driven design in §17 holds; taking it needs a
   * browser and a Playwright run, and this box has neither.
   */
  get throughput(): { bytes: number; ms: number; bytesPerSecond: number } {
    const ms = this.startedAt ? this.now() - this.startedAt : 0;
    return { bytes: this.bytes, ms, bytesPerSecond: ms > 0 ? (this.bytes * 1000) / ms : 0 };
  }

  /**
   * Milliseconds since a write last RESOLVED — the starvation key (§17).
   *
   * 🔴 Keyed on **the sender failing to write**, never on the controller's
   * planner being empty: our post emits `G4 P<spinup>` after every `M3` and
   * `mc_dwell` drains the planner before delaying (design F5), so a
   * planner-empty detector false-fires at every spindle start — and a control
   * that false-fires gets muted.
   */
  sinceLastWrite(): number {
    return this.lastWriteAt ? this.now() - this.lastWriteAt : 0;
  }

  /** Feed one complete inbound line. Public so a caller can replay a transcript. */
  accept(line: string): void {
    const inbound = classifyInbound(line, this.plant);
    this.emit({ t: 'inbound', line });
    this.streamer.onReply(inbound);
    this.announceState();
    if (this.streamer.state === 'streaming') void this.pump();
  }

  /** Write everything the streamer's character count currently allows. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    if (!this.startedAt) {
      this.startedAt = this.now();
      this.lastWriteAt = this.startedAt;
    }
    try {
      for (;;) {
        const batch = this.streamer.nextLines();
        if (batch.length === 0) break;
        for (const line of batch) {
          const bytes = encodeLine(line);
          await this.link.write(bytes);
          this.bytes += bytes.length;
          this.lastWriteAt = this.now();
          this.emit({ t: 'sent', line, lineNumber: this.streamer.sent });
        }
      }
      this.announceState();
    } finally {
      this.pumping = false;
    }
  }

  private announceState(): void {
    if (this.streamer.state === this.lastState) return;
    this.lastState = this.streamer.state;
    this.emit({ t: 'state', state: this.lastState, abort: this.streamer.abort });
  }

  /**
   * Send a realtime command, ahead of the queue.
   *
   * It does not wait for the pump: the pump holds at most one line's write in
   * flight, so the worst case here is one line of queueing inside the Link.
   *
   * ⚠ **Which command is legal in which state is `./protocol`'s** —
   * `realtimeRefusal(name, state)` (`0x85` only in `Jog`, `0x9E` only in
   * `Hold`). This method carries no table and refuses nothing; the tab asks
   * before it calls.
   */
  realtime(name: RealtimeName, plant?: ProtocolPlant): Promise<void> {
    return this.link.write(realtimeBytes(name, plant));
  }

  /** Operator pressed Stop, or a watchdog fired. Stops feeding; stops nothing else. */
  stop(message: string): void {
    this.streamer.stop(message);
    this.announceState();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. Asking for status, without starving the thing that cuts
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How often to ask for a status report, and what to ask with.
 *
 * 🔴 **`$481` IS A SETTING ON SOMEBODY ELSE'S MACHINE AND IS NOT ASSUMED.**
 * `Setting_AutoReportInterval = 481` (`settings.h:312`, 100–1000 ms, 0 = off,
 * reboot required) makes the controller push reports on its own timer, and
 * design §17 calls that *"a genuine mitigation for a throttled tab's polling …
 * and **not** a mitigation for a throttled tab's writing"*. So it changes what
 * this tab asks for; it never changes whether the tab must keep writing.
 *
 * Three worlds, and the tab is told which one it is in rather than being left to
 * infer it from an empty DRO:
 *
 *  - **`$481` unread** — `$$` has not answered, or this build does not carry the
 *    setting. **Poll.** Assuming auto-reporting is on and then not polling is
 *    the failure where every readout freezes and nothing says why.
 *  - **`$481 = 0`** — off, which is grblHAL's own default. **Poll.** Nothing
 *    arrives unless this tab asks.
 *  - **`$481 > 0`** — on. A `?` is then a no-op (`protocol.c:872-874`), so
 *    polling with `?` would spend a byte per tick for nothing. What still has to
 *    be asked for is the **full** report: `WCO`, `Ov` and `H` are change-only
 *    (§4) and three refusals key on them. So the plan degrades to a slow
 *    `0x87`-only refresh.
 *    ⚠ **JUDGEMENT, and it is an open one:** whether `0x87` is *also* ignored
 *    while auto-reporting is on is **not settled by the design and this lane has
 *    not read that path in `protocol.c`.** If it is ignored, the change-only
 *    fields never arrive on such a controller — and the tab then refuses through
 *    R1/R3 saying exactly that, rather than proceeding on a `WCO` it never got.
 *    A wrong guess here costs a refusal; the opposite guess costs a work DRO
 *    derived from nothing.
 */
export interface PollPlan {
  /** 0 = do not poll at all. */
  intervalMs: number;
  /** Every Nth request is a `0x87` full report. 1 = every request. */
  fullEvery: number;
  /** How often a report is expected to ARRIVE — `$481` when set, else
   *  {@link intervalMs}. This is what a staleness verdict divides by, and it is
   *  not the same number as the poll interval. */
  expectMs: number;
  /** Rendered next to the DRO. Names the setting, per `AGENTS.md`. */
  why: string;
}

/**
 * The default poll period, and why it is this number.
 *
 * Design §14 puts the real report rate at *"5–10 Hz typical, `$481` floor 100
 * ms"*. 200 ms is 5 Hz — the bottom of the band the design already treats as
 * normal, so the DRO is as fresh as the design says a DRO gets, and the traffic
 * is one byte out per tick.
 */
export const DEFAULT_POLL_MS = 200;

/** A `0x87` costs the same one byte as a `?` and refreshes the change-only
 *  elements. Every 20th request at 200 ms is one full report per 4 s. */
export const DEFAULT_FULL_EVERY = 20;

/** Under `$481`, the only thing left to ask for is the change-only set. */
export const AUTOREPORT_FULL_REFRESH_MS = 4000;

export function pollPlan(autoReportMs: number | null): PollPlan {
  if (autoReportMs === null) {
    return {
      intervalMs: DEFAULT_POLL_MS,
      fullEvery: DEFAULT_FULL_EVERY,
      expectMs: DEFAULT_POLL_MS,
      why:
        '$481 has not been read from this controller, so this tab does not assume auto-reporting ' +
        'is on: it polls with ? every ' +
        `${DEFAULT_POLL_MS}ms and asks for a full report (0x87) every ${DEFAULT_FULL_EVERY}th, ` +
        'because WCO, Ov and H are change-only.',
    };
  }
  if (autoReportMs <= 0) {
    return {
      intervalMs: DEFAULT_POLL_MS,
      fullEvery: DEFAULT_FULL_EVERY,
      expectMs: DEFAULT_POLL_MS,
      why:
        '$481=0: auto-reporting is off on this controller, which is grblHAL’s own default. ' +
        `Nothing arrives unless this tab asks, so it polls with ? every ${DEFAULT_POLL_MS}ms and ` +
        `asks for a full report (0x87) every ${DEFAULT_FULL_EVERY}th.`,
    };
  }
  return {
    intervalMs: AUTOREPORT_FULL_REFRESH_MS,
    fullEvery: 1,
    expectMs: autoReportMs,
    why:
      `$481=${autoReportMs}: the controller pushes a report every ${autoReportMs}ms on its own ` +
      'timer and a ? is ignored while it does (protocol.c:872-874), so this tab does not send ' +
      `them. It still asks for a full report (0x87) every ${AUTOREPORT_FULL_REFRESH_MS}ms, ` +
      'because WCO, Ov and H are change-only and three refusals key on them. ⚠ Whether 0x87 is ' +
      'also ignored under auto-reporting is not settled by the design and has not been read at ' +
      'grblHAL’s source by this app — if those fields never arrive, R1 and R3 refuse and say so.',
  };
}

/**
 * One `?` (or `0x87`) at a time, and never a queue of them.
 *
 * 🔴 **THIS IS THE PART THAT KEEPS STATUS TRAFFIC FROM STARVING THE CUT.**
 * `WebSerialLink` serialises every write through one promise chain, so a poll
 * byte issued while the link is congested does not vanish — it **queues in front
 * of the next g-code line**. A poller that fires on a clock regardless would,
 * on a link that has gone slow, accumulate one un-written `?` per tick ahead of
 * the program, and *"a streamer that stalls mid-cut does not pause the job — it
 * leaves a turning cutter stationary in the material"*.
 *
 * So: **at most one request outstanding, ever.** A tick that arrives while the
 * previous write has not resolved is DROPPED and counted ({@link skipped}) — a
 * dropped status request costs one stale frame on a readout that already renders
 * its own age; a queued one costs feed.
 *
 * ⚠ It is deliberately NOT state-aware. Design §12: *"status polling in every
 * state, including `Alarm` and `Door`. A UI that stops reading when things go
 * wrong stops reading exactly when it matters."* During `$H` the controller
 * answers nothing ( `$10` bit 12 off) — that is silence to be *rendered as
 * expected*, not a reason to stop asking.
 *
 * ⚠ **The clock is the caller's**, and this class has no timer of its own. That
 * is what lets a test drive it deterministically, and it is what lets the worker
 * — not the page — own the interval (design §17: Chrome throttles timers in a
 * hidden **page**).
 */
export class StatusPoller {
  private readonly link: Link;
  private readonly fullEvery: number;
  private inFlight = false;
  private issued = 0;
  private forceFull = true;

  /** Requests actually written. */
  requests = 0;
  /** Of those, full (`0x87`) ones. */
  fullRequests = 0;
  /** Ticks dropped because the previous write had not resolved. */
  skipped = 0;
  /** Writes that rejected — the link is in trouble and the pump will see it too. */
  failures = 0;

  constructor(link: Link, fullEvery: number = DEFAULT_FULL_EVERY) {
    this.link = link;
    this.fullEvery = Math.max(1, Math.floor(fullEvery));
  }

  /**
   * Make the next request a **full** one.
   *
   * 🔴 Called on attach and on any reconnect. `0x87` is **required, not
   * optional**: `WCO`, `Ov` and `H` are change-only, so a client that only ever
   * sends `?` may wait 30 reports for a `WCO` and may never see `H` at all —
   * and `H` is the evidence R1 keys on. A reconnect starts a fresh connection
   * with none of them, which is exactly the state this exists for.
   */
  resync(): void {
    this.forceFull = true;
  }

  /** Issue one request now if the last one has landed. Returns what it sent. */
  tick(): RealtimeName | null {
    if (this.inFlight) {
      this.skipped += 1;
      return null;
    }
    const full = this.forceFull || this.issued % this.fullEvery === 0;
    const name: RealtimeName = full ? 'statusReportAll' : 'statusReport';
    this.forceFull = false;
    this.issued += 1;
    this.requests += 1;
    if (full) this.fullRequests += 1;
    this.inFlight = true;
    this.link.write(realtimeBytes(name)).then(
      () => {
        this.inFlight = false;
      },
      () => {
        this.inFlight = false;
        this.failures += 1;
      },
    );
    return name;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 8. The window ↔ worker boundary
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Commands the window sends the worker, and events the worker sends back.
 *
 * ⚠ **Command/event, never shared mutable state** (§17). Everything here is
 * structured-cloneable; nothing here is a function or a live object. The worker
 * owns the port, the character count and the line cursor. The window owns the
 * picture.
 *
 * ⚠ Inbound lines are posted **verbatim** and parsed on the window side. That is
 * deliberate: a stale DRO in a hidden tab is a display problem, a late write is
 * a physical one, and only the write half needs to be off the main thread.
 */
export type WorkerCommand =
  | {
      t: 'attach';
      portIndex: number;
      usbVendorId?: number;
      usbProductId?: number;
      baudRate?: number;
    }
  | { t: 'load'; lines: string[]; mode: 'character-counting' | 'send-response'; rxBufferSize: number | null }
  | { t: 'start' }
  | { t: 'stop'; why: string }
  | { t: 'write'; line: string }
  | { t: 'realtime'; name: RealtimeName }
  /**
   * Start, retune or stop status polling. `intervalMs: 0` stops it.
   *
   * 🔴 **The timer lives in the WORKER, never in the page.** Chrome throttles
   * `setTimeout`/`setInterval` in a hidden **page** — ~1 s hidden, up to ~1 min
   * under intensive throttling (design §17) — so a poll driven from `RunTab.tsx`
   * would drop to one report a second the moment the operator switches tabs, and
   * the DRO would freeze while still looking live.
   * ⚠ **A worker of a hidden page may have its own timers throttled too. This
   * lane has NOT measured that** (the sibling of gate branch `RUN-18`), which is
   * why {@link StatusPoller} carries no clock of its own and why the tab renders
   * the report's AGE rather than trusting the poll to have happened.
   */
  | { t: 'poll'; intervalMs: number; fullEvery?: number }
  /** Ask for the `RUN-18` instrument. See {@link StreamPump.throughput}. */
  | { t: 'throughput' }
  | { t: 'close' };

export type WorkerEvent =
  | { t: 'attached'; info: SerialPortInfoLike }
  | { t: 'attach-failed'; error: PortError }
  | { t: 'line'; line: string; at: number }
  | { t: 'sent'; line: string; lineNumber: number; at: number }
  | {
      t: 'stream';
      state: string;
      sent: number;
      acknowledged: number;
      total: number;
      abort: StreamAbort | null;
    }
  | { t: 'stall'; ms: number }
  | { t: 'failure'; failure: LinkFailure }
  | { t: 'throughput'; bytes: number; ms: number; bytesPerSecond: number }
  | { t: 'closed' };

/**
 * Find, in this realm's `getPorts()` list, the port the window chose.
 *
 * 🔴 **A `SerialPort` cannot be posted to a worker** — it is not transferable
 * and not structured-cloneable. The permission, however, is granted to the
 * ORIGIN, so the worker's own `getPorts()` returns the same set. The window
 * therefore sends an INDEX into its list, and the worker resolves it here.
 *
 * ⚠ **The index alone is an assumption**: the spec orders `[[availablePorts]]`
 * per origin, so the two lists should agree, and nothing guarantees it across
 * realms and nothing on this box can test it. So the index is CROSS-CHECKED
 * against the USB vendor/product ids and a mismatch is a refusal rather than a
 * "close enough" — the cost of getting this wrong is a program streamed to the
 * wrong device.
 */
export async function resolvePort(
  serial: SerialLike,
  want: { portIndex: number; usbVendorId?: number; usbProductId?: number }
): Promise<{ port: SerialPortLike } | { error: PortError }> {
  const ports = await serial.getPorts();
  const port = ports[want.portIndex];
  if (!port) {
    return {
      error: {
        kind: 'unknown',
        ours: true,
        message:
          `The worker cannot see the port the page chose (index ${want.portIndex} of ` +
          `${ports.length}). Nothing was opened.`,
      },
    };
  }
  const info = port.getInfo();
  const wantsIds = want.usbVendorId != null || want.usbProductId != null;
  if (
    wantsIds &&
    (info.usbVendorId !== want.usbVendorId || info.usbProductId !== want.usbProductId)
  ) {
    return {
      error: {
        kind: 'unknown',
        ours: true,
        message:
          'The port at that position is a different device than the one you chose ' +
          `(chose ${hex(want.usbVendorId)}:${hex(want.usbProductId)}, found ` +
          `${hex(info.usbVendorId)}:${hex(info.usbProductId)}). Nothing was opened — refusing ` +
          'rather than streaming a program to whatever else is plugged in.',
      },
    };
  }
  return { port };
}

function hex(n: number | undefined): string {
  return n == null ? '?' : `0x${n.toString(16).padStart(4, '0')}`;
}
