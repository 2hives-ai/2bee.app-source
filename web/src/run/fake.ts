// A grblHAL responder behind the `Link` seam — including the ways it goes wrong.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT A GREEN AGAINST THIS FAKE DOES NOT MEAN
// ─────────────────────────────────────────────────────────────────────────────
//
// **A green against a simulated port is not a green against a machine.** This
// fake is this lane's model of grblHAL, written from grblHAL's source by the
// same hands that wrote `protocol.ts` — so it can only ever confirm that the
// sender agrees with our reading of the controller. **It cannot discover that
// our reading is wrong.** Every behaviour below is a claim about grblHAL that a
// real board is free to contradict, and several of them will only ever be
// settled by rung 2 of `docs/design-76-run-tab.md` §19: a USB cable, a bare
// board, and a committed transcript in `gates/controller/`.
//
// That sentence is here, at the top of the file, because it is exactly the
// sentence a future reader needs and exactly the one nobody thinks to ask for.
// `docs/design-76-run-tab.md` §18 requires it in the gate's own output too: any
// check that runs against this file must print WHICH PERSONA ANSWERED and with
// what configuration — `describe()` exists for that and for nothing else. *A
// green whose subject is unnamed is a green nobody can audit.*
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 AND IT MUST BE ABLE TO BEHAVE BADLY
// ─────────────────────────────────────────────────────────────────────────────
//
// A fake that only ever answers well tests the happy path and nothing else, and
// every failure the Run tab exists to survive is in the other direction. So the
// personas below include a board that boots into `Alarm` and refuses `$X`, one
// that reports under `$10=1` and therefore never sends a `WCO` at all, one that
// poisons every line after an error the way grblHAL really does, one that stops
// answering mid-stream, one that resets under the sender, one that is running
// Marlin, and one whose RX buffer is small enough that a careless streamer
// overruns it in a dozen lines.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO TIMERS, NO PROMISES THAT SETTLE LATER
// ─────────────────────────────────────────────────────────────────────────────
//
// Time is a number this object holds and `tick(ms)` advances. Execution is
// explicit: `write()` puts bytes in the RX buffer, `execute(n)` takes complete
// lines out of it. That is what makes the RX buffer a real, finite, observable
// thing rather than a decoration — with `autoExecute` off, a streamer that
// ignores the character count genuinely overruns this object, which is the only
// way `RUN-1` means anything.

import { LineAssembler, classifyInbound, type Link, type ProtocolPlant, type Streamer } from './protocol';

/* ═══════════════════════════════════════════════════════════════════════════
   PERSONAS
   ═══════════════════════════════════════════════════════════════════════════ */

export type PersonaName =
  /** grblHAL, `$10=511`, homed, `Idle`, 1024-byte RX buffer. The baseline. */
  | 'healthy'
  /** Boots into `Alarm:11` with homing required. `$X` → `error:46`; every
   *  g-code line after that → `error:9`. `$H` is the only way out. This is the
   *  machine a router SHOULD be configured as, and the one whose transcript
   *  reads like a total dialect failure (design F6). */
  | 'alarm-homing-required'
  /** `$10=1` — grbl's default. `MPos` only: **no `WCO` ever**, no `Bf`, no `FS`,
   *  no `Ov`, no `Pn`, no `Ln`. The work DRO is not derivable at all and
   *  character counting cannot be calibrated. */
  | 'mask-1'
  /** `$10=510` — bit 0 clear, so positions arrive as `WPos` **and** `WCO` is
   *  still sent. A UI that subtracts `WCO` here double-counts the offset. */
  | 'wpos-reporting'
  /** Rejects one line mid-program with `error:20`, then poisons everything
   *  after it exactly as grblHAL does. */
  | 'rejects-a-line'
  /** Stops answering entirely partway through a stream. No error, no alarm, no
   *  reports: just silence, which is what a wedged USB stack looks like. */
  | 'goes-silent'
  /** `G38.2` finds nothing: `ALARM:5`, asynchronously, with no `ok` for the
   *  probing line. */
  | 'probe-no-contact'
  /** Resets under the sender mid-stream — an unsolicited banner and `ALARM:3`,
   *  buffers cleared, settings possibly reverted. */
  | 'resets-mid-stream'
  /** A 64-byte RX buffer. Nothing else is wrong with it; it just leaves no room
   *  for a streamer that guesses. */
  | 'tiny-buffer'
  /** grbl v1.1: a `Grbl` banner, no `FW:grblHAL`, `$10=1`. Must be classified as
   *  degraded and refused streaming. */
  | 'grbl-1.1'
  /** Marlin, which is what an SKR Pro ships with. Answers `$I` with `echo:`.
   *  Must be classified `unknown` and the port closed. */
  | 'marlin'
  /** Opens and says nothing at all, ever. */
  | 'silent'
  /** Emits bytes that are not lines and not UTF-8. */
  | 'garbage'
  /** grblHAL that has been running for an hour: no banner on connect, because
   *  absence of a banner is not evidence of anything. */
  | 'no-banner';

export const PERSONAS: PersonaName[] = [
  'healthy',
  'alarm-homing-required',
  'mask-1',
  'wpos-reporting',
  'rejects-a-line',
  'goes-silent',
  'probe-no-contact',
  'resets-mid-stream',
  'tiny-buffer',
  'grbl-1.1',
  'marlin',
  'silent',
  'garbage',
  'no-banner',
];

export interface FakeOptions {
  persona: PersonaName;
  /** The number a streamer is supposed to MEASURE from `Bf`, never assume. */
  rxBufferSize: number;
  plannerBlocks: number;
  /** `$10`. */
  statusMask: number;
  /** `$13`: 0 = mm, 1 = inches. */
  reportInches: boolean;
  /** `$22`. Default 5 = enabled + init_lock. */
  homingConfig: number;
  homed: boolean;
  /** Machine position at power-on, per axis. */
  machinePosition: number[];
  /** The active work offset. What `WCO` reports and what `WPos` is measured
   *  against. */
  wco: number[];
  /** Reports between change-only `WCO` refreshes. grblHAL's own counters are 10
   *  (idle) and 30 (busy) — `REPORT_WCO_REFRESH_*_COUNT`, `config.h:233-244`. */
  wcoRefreshCount: number;
  /** Emit the startup banner when the first listener attaches. */
  bannerOnConnect: boolean;
  /** Execute queued lines as soon as they are written. Turn this OFF to make the
   *  RX buffer a real constraint — which is the only configuration in which
   *  character counting is being tested at all. */
  autoExecute: boolean;
  /** Split every emission into chunks of this many bytes, so a line arrives
   *  across two reads. `null` = one chunk per emission. */
  splitEvery: number | null;
  /** Stop answering after this many executed lines. */
  silentAfterLines: number | null;
  /** Reset (banner + ALARM:3) after this many executed lines. */
  resetAfterLines: number | null;
  /** Reject the Nth executed line (1-based) with this code, then poison. */
  rejectLine: { index: number; code: number } | null;
  /** `G38.2` makes contact. */
  probeContacts: boolean;
  /** ⚠ JUDGEMENT, and it is a real uncertainty: whether grblHAL emits `ok` for
   *  the probing line before raising `ALARM:5` is NOT settled by the design, and
   *  this lane has not read `mc_probe_cycle`'s reply path. The sender must
   *  survive both, so both are reachable here and both are tested. Default
   *  `false` = the alarm arrives with no line reply, which is the harder case:
   *  the character count never frees and only the alarm ends the stream. */
  probeAlarmEmitsOk: boolean;
  /** `$J=` beyond this machine coordinate answers `error:15`. `null` = no soft
   *  limit. */
  jogSoftLimitMm: number | null;
  /** How long a queued jog runs before the machine returns to `Idle`. */
  jogMs: number;
  /** How long `$H` takes, during which nothing is reported at all. */
  homingMs: number;
  /** How long `!` takes to decelerate: `Hold:1` for this long, then `Hold:0`. */
  holdMs: number;
  /**
   * Which driver computes `Bf`'s second figure — because on this board the two
   * do not agree, and the difference is a whole byte of allowance.
   *
   * 🔴 **ADDED 2026-08-11, and it models a fact this lane had never checked
   * rather than re-tuning the fake to agree with the sender.** grblHAL's USB
   * CDC stream returns `RX_BUFFER_SIZE - count`
   * (`STM32F4xx/Src/usb_serial.c:54`), so an empty 1024-byte buffer reports
   * **1024**. A UART returns `(RX_BUFFER_SIZE - 1) - count`
   * (`STM32F4xx/Src/serial.c:551`), so the same firmware on the same board
   * reports **1023**. Same `RX_BUFFER_SIZE`, different cable, different number
   * — and `1023` is not a power of two, while `RX_BUFFER_SIZE` is required to
   * be one (`stream.h:52`).
   *
   * ⚠ No persona sets this. It is an override, so the existing fourteen
   * personas answer exactly as they did before this option existed — a fake
   * that quietly started reporting a different `Bf` would have turned every
   * buffer assertion in the suite into a new claim under an old name.
   */
  rxFreeFormula: 'usb-cdc' | 'uart';
}

const BASE: Omit<FakeOptions, 'persona'> = {
  rxBufferSize: 1024,
  plannerBlocks: 100,
  statusMask: 511,
  reportInches: false,
  homingConfig: 5,
  homed: true,
  machinePosition: [-100, -200, -5],
  wco: [-100, -200, -25],
  wcoRefreshCount: 10,
  bannerOnConnect: true,
  autoExecute: true,
  splitEvery: null,
  silentAfterLines: null,
  resetAfterLines: null,
  rejectLine: null,
  probeContacts: true,
  probeAlarmEmitsOk: false,
  jogSoftLimitMm: null,
  jogMs: 50,
  homingMs: 4000,
  holdMs: 120,
  rxFreeFormula: 'usb-cdc',
};

/** The persona's configuration, resolved. Every field an override may change. */
export function personaOptions(
  persona: PersonaName,
  overrides: Partial<FakeOptions> = {},
): FakeOptions {
  const per: Partial<FakeOptions> = (() => {
    switch (persona) {
      case 'healthy':
        return {};
      case 'alarm-homing-required':
        return { homed: false, homingConfig: 5 };
      case 'mask-1':
        return { statusMask: 1 };
      case 'wpos-reporting':
        return { statusMask: 510 };
      case 'rejects-a-line':
        return { rejectLine: { index: 4, code: 20 } };
      case 'goes-silent':
        return { silentAfterLines: 6 };
      case 'probe-no-contact':
        return { probeContacts: false };
      case 'resets-mid-stream':
        return { resetAfterLines: 5 };
      case 'tiny-buffer':
        return { rxBufferSize: 64 };
      case 'grbl-1.1':
        return { statusMask: 1 };
      case 'marlin':
        return {};
      case 'silent':
        return { bannerOnConnect: false };
      case 'garbage':
        return {};
      case 'no-banner':
        return { bannerOnConnect: false };
    }
  })();
  return { ...BASE, ...per, persona, ...overrides };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE RESPONDER
   ═══════════════════════════════════════════════════════════════════════════ */

type FakeState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Home' | 'Check' | 'Sleep' | 'Door';

/** `ASCII_CAN`, 0x18 (`grbl/stream.h:45`). What `cancel_read_buffer` leaves
 *  BEHIND in the RX ring — see the `0x85` branch of {@link FakeController.realtime}. */
const CANCEL_ARTEFACT = '\x18';

/** One realtime byte the fake received, with the state it was received in — so a
 *  test can assert "0x85 was never sent outside Jog" at the wire rather than at
 *  the caller's intention. */
export interface RealtimeReceipt {
  byte: number;
  state: FakeState;
  /** True when this build of grblHAL would ignore it here (0x9E outside Hold,
   *  0x98 at all). Recorded rather than acted on. */
  ignored: boolean;
  reason: string | null;
}

export class FakeController implements Link {
  readonly options: FakeOptions;

  /* ── observable history, for tests and for the gate's own output ────────── */
  /** Every `write()`, byte-for-byte. `RUN-4` asserts on this: a realtime `0x90`
   *  must appear as ONE byte, not as `0xC2 0x90`. */
  readonly writes: Uint8Array[] = [];
  readonly realtimeReceived: RealtimeReceipt[] = [];
  /** Complete lines the fake actually executed, in order. */
  readonly executed: string[] = [];
  /** Times the RX buffer was overrun. Must be 0 for a correct streamer. */
  overruns = 0;
  /** Characters put into the RX ring by {@link foreignWrite} — i.e. by somebody
   *  who is not the `Link`'s owner. Cumulative, and printed by
   *  {@link describe} so a gate can say whether the fake it drove had a second
   *  writer on it. */
  foreignChars = 0;
  /** True once overrun: the fake stops answering, exactly as a controller whose
   *  buffer has been trampled stops making sense. */
  private jammed = false;

  private listeners: ((chunk: Uint8Array) => void)[] = [];
  private rx = '';
  private state: FakeState;
  private alarmCode: number | null = null;
  private lastError = 0;
  private homedNow: boolean;
  private mpos: number[];
  private wcoNow: number[];
  private reportsSinceWco: number;
  private overrides = { feed: 100, rapid: 100, spindle: 100 };
  private spindleOn = false;
  private now = 0;
  private timers: { at: number; run: () => void }[] = [];
  private executedCount = 0;
  private closed = false;
  private bannerSent = false;

  constructor(persona: PersonaName | FakeOptions, overrides: Partial<FakeOptions> = {}) {
    this.options =
      typeof persona === 'string' ? personaOptions(persona, overrides) : { ...persona, ...overrides };
    this.homedNow = this.options.homed;
    this.mpos = [...this.options.machinePosition];
    this.wcoNow = [...this.options.wco];
    this.reportsSinceWco = this.options.wcoRefreshCount; // first report carries it
    this.state = this.homingRequired() ? 'Alarm' : 'Idle';
    this.alarmCode = this.homingRequired() ? 11 : null;
  }

  /**
   * 🔴 THE LINE A GATE MUST PRINT.
   *
   * `docs/design-76-run-tab.md` §18: "RUN prints, on every run, that its
   * transport was the fake — with the fake's configuration (buffer size, `$10`,
   * persona) in the line."
   */
  describe(): string {
    const o = this.options;
    return (
      `FAKE grblHAL responder — persona=${o.persona} $10=${o.statusMask} $13=${o.reportInches ? 1 : 0} ` +
      `$22=${o.homingConfig} rx=${o.rxBufferSize}B/${o.rxFreeFormula} planner=${o.plannerBlocks} homed=${o.homed ? 'yes' : 'no'} ` +
      `autoExecute=${o.autoExecute} splitEvery=${o.splitEvery ?? 'none'} foreign=${this.foreignChars}B ` +
      `(NOT A MACHINE: this proves the sender agrees with this lane's reading of grblHAL, nothing more)`
    );
  }

  /* ── Link ───────────────────────────────────────────────────────────────── */

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.listeners.push(cb);
    if (!this.bannerSent) {
      this.bannerSent = true;
      this.onConnect();
    }
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('the port is closed');
    this.writes.push(bytes.slice());
    for (const b of bytes) {
      if (this.isRealtime(b)) {
        this.realtime(b);
        continue;
      }
      this.rx += String.fromCharCode(b);
      if (this.rx.length > this.options.rxBufferSize) {
        /* A real UART drops what will not fit and the controller's line parser
         * then sees a mutilated stream. Recorded, and the fake JAMS: it stops
         * answering, so an over-eager streamer deadlocks here instead of at a
         * machine. */
        this.overruns += 1;
        this.jammed = true;
        this.rx = this.rx.slice(0, this.options.rxBufferSize);
      }
    }
    if (this.options.autoExecute) this.execute();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners = [];
  }

  /* ── driving it ─────────────────────────────────────────────────────────── */

  /**
   * 🔴 **A SECOND PROCESS WRITING TO THE SAME PORT.** Bytes enter the same RX
   * ring, are executed by the same parser and are answered on the same stream —
   * because that is all grblHAL can do.
   *
   * ⚠ **This is a CAPABILITY, not a persona, and the distinction is the point.**
   * A persona is a board: a `$10` mask, a buffer size, a firmware. A second
   * writer is not a property of the board at all — **grblHAL cannot tell it is
   * happening**. `hal.stream` is a copy of ONE stream's function pointers
   * (`stream.c:408`) and the connection list is used for output only:
   * `stream_write_all()` broadcasts and **nothing iterates it to read**. Two
   * processes on `/dev/ttyACM0` are one stream from the firmware's side. Adding
   * a fifteenth persona would have asserted the opposite — that a board can be
   * configured to have a second writer — and every existing persona must be able
   * to have one, which is what an override gives and a persona does not.
   *
   * It goes through the same overrun and jam path as {@link write}, because the
   * ring does not care who filled it.
   *
   * @param text bytes exactly as the other program sent them. Include the `\n`
   *   if that program sent one — a foreign write with no terminator is a real
   *   case (a monitor with the line ending set to "none") and it sits in the
   *   ring indefinitely, which is the version that quietly eats buffer.
   */
  foreignWrite(text: string): void {
    if (this.closed) throw new Error('the port is closed');
    this.foreignChars += text.length;
    for (const ch of text) {
      const b = ch.charCodeAt(0);
      if (this.isRealtime(b)) {
        /* Realtime bytes are stripped in the ISR and never reach the ring
         * (`usbBufferInput` buffers only what `protocol_enqueue_realtime_command`
         * returns false for, `usb_serial.c:253-262`). A second writer's `?` is
         * therefore invisible in `Bf` — which is exactly why the detector cannot
         * be a presence check. Recorded as received, like any other. */
        this.realtime(b);
        continue;
      }
      this.rx += ch;
      if (this.rx.length > this.options.rxBufferSize) {
        this.overruns += 1;
        this.jammed = true;
        this.rx = this.rx.slice(0, this.options.rxBufferSize);
      }
    }
    if (this.options.autoExecute) this.execute();
  }

  /** Execute up to `n` complete lines out of the RX buffer (all of them by
   *  default), freeing their bytes and emitting their replies. Returns how many
   *  ran. */
  execute(n = Number.POSITIVE_INFINITY): number {
    /* The reader loop drops an `ASCII_CAN` as soon as it reaches it, whether or
     * not a line has been terminated — `protocol.c:210-219` reads character by
     * character and the CAN arm is the first one. It is consumed and never
     * answered, so it does not count as a line that ran. Without this the fake
     * would hold the artefact until the next newline, which would model a
     * controller that never clears it. */
    while (this.rx.startsWith(CANCEL_ARTEFACT)) this.rx = this.rx.slice(1);
    let ran = 0;
    while (ran < n) {
      const nl = this.rx.indexOf('\n');
      if (nl < 0) break;
      const line = this.rx.slice(0, nl).replace(/\r$/, '');
      this.rx = this.rx.slice(nl + 1);
      this.handleLine(line);
      ran += 1;
    }
    return ran;
  }

  /** Advance the fake's clock. Nothing here uses a real timer. */
  tick(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const first = due[0];
      this.timers = this.timers.filter((t) => t !== first);
      first.run();
    }
  }

  /**
   * Free space in the RX buffer, which is what `Bf`'s second figure reports.
   *
   * 🔴 **This number is the DRIVER's, not the buffer's** — see
   * {@link FakeOptions.rxFreeFormula}. A UART never reports the last byte as
   * free, so a streamer that hard-codes 1024 would over-fill it by one on every
   * cycle; a streamer that counts against the MEASURED figure cannot.
   */
  get rxFree(): number {
    const usable =
      this.options.rxFreeFormula === 'uart'
        ? this.options.rxBufferSize - 1
        : this.options.rxBufferSize;
    return usable - this.rx.length;
  }

  get machineState(): FakeState {
    return this.state;
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private homingRequired(): boolean {
    /* `limits_homing_required()` (`machine_limits.c:668-673`): enabled AND
     * init_lock AND not homed. `override_locks` (bit 6) is the warm-start
     * escape and is not modelled here — it is modelled by simply setting
     * `homingConfig` without bit 2. */
    const enabled = (this.options.homingConfig & 1) !== 0;
    const initLock = (this.options.homingConfig & 4) !== 0;
    return enabled && initLock && !this.homedNow;
  }

  private onConnect(): void {
    const p = this.options.persona;
    if (p === 'garbage') {
      this.emitBytes(Uint8Array.of(0xff, 0xfe, 0x00, 0x01, 0x9a, 0x0a));
      return;
    }
    if (!this.options.bannerOnConnect) return;
    if (p === 'marlin') {
      this.emit('start');
      this.emit('echo:Marlin 2.1.2');
      return;
    }
    if (p === 'grbl-1.1') {
      this.emit("Grbl 1.1f ['$' for help]");
      return;
    }
    this.emit("GrblHAL 1.1f ['$' or '$HELP' for help]");
    if (this.state === 'Alarm' && this.alarmCode !== null) this.emit(`ALARM:${this.alarmCode}`);
  }

  private isRealtime(b: number): boolean {
    return b === 0x18 || b === 0x3f || b === 0x21 || b === 0x7e || b >= 0x80;
  }

  private realtime(b: number): void {
    const receipt: RealtimeReceipt = { byte: b, state: this.state, ignored: false, reason: null };
    this.realtimeReceived.push(receipt);
    if (this.jammed) return;

    switch (b) {
      case 0x3f:
      case 0x80:
        this.emitReport(false);
        return;
      case 0x87:
        this.emitReport(true);
        return;
      case 0x21: // feed hold
      case 0x82:
        if (this.state === 'Run' || this.state === 'Jog') {
          this.state = 'Hold';
          this.holdSubstate = 1;
          this.after(this.options.holdMs, () => {
            this.holdSubstate = 0;
          });
        } else if (this.state === 'Idle') {
          this.state = 'Hold';
          this.holdSubstate = 0;
        }
        return;
      case 0x7e: // cycle start
      case 0x81:
        if (this.state === 'Hold' && this.holdSubstate === 0) {
          this.state = 'Idle';
        }
        return;
      case 0x18: {
        // soft reset
        const wasMoving = this.state === 'Run' || this.state === 'Jog' || this.state === 'Home';
        this.rx = '';
        this.lastError = 0;
        this.jammed = false;
        if (wasMoving) {
          this.state = 'Alarm';
          this.alarmCode = 3;
          this.homedNow = false; // position lost
        } else if (this.homingRequired()) {
          this.state = 'Alarm';
          this.alarmCode = 11;
        } else {
          this.state = 'Idle';
          this.alarmCode = null;
        }
        this.emit("GrblHAL 1.1f ['$' or '$HELP' for help]");
        if (this.alarmCode !== null) this.emit(`ALARM:${this.alarmCode}`);
        return;
      }
      case 0x85: // jog cancel — FLUSHES THE RX BUFFER, AND LEAVES ONE BYTE IN IT
        /* 🔴 `cancel_read_buffer` is NOT a plain flush, and the difference is
         * one character of `Bf`. `usbRxCancel` writes an `ASCII_CAN` (0x18,
         * `stream.h:45`) into the ring, THEN moves the tail past everything
         * else — `usb_serial.c:68-73`, and `serial.c:575-580` / `:843-848` do
         * the same. The main loop reads it on its next pass and uses it to
         * reset the line state without replying (`protocol.c:212-219`).
         *
         * ⚠ Modelled here because a status report rendered in that window
         * reports the buffer one character short WITH NOTHING IN IT — which is
         * a false positive for `PortOwnershipWatch`, and `RING_ARTEFACT_CHARS`
         * is the constant that subtracts it. Without this line the fake could
         * not produce the false positive, and the constant would be justified
         * by a comment nothing exercises. */
        if (this.state === 'Jog') {
          this.rx = CANCEL_ARTEFACT;
          this.state = 'Idle';
        } else {
          /* grblHAL still flushes: the realtime handler sets char_counter = 0
           * and calls cancel_read_buffer() before it looks at the state
           * (protocol.c:894-897). Modelled that way ON PURPOSE, because a fake
           * that made it harmless outside Jog would make R7 look like fussiness
           * instead of the stream-destroying byte it is. */
          this.rx = CANCEL_ARTEFACT;
          receipt.ignored = false;
          receipt.reason = 'sent outside Jog — the RX buffer was flushed anyway';
        }
        return;
      case 0x98:
        receipt.ignored = true;
        receipt.reason = '0x98 is not implemented in grblHAL (commented out as *NOT SUPPORTED*)';
        return;
      case 0x9e:
        if (this.state !== 'Hold') {
          receipt.ignored = true;
          receipt.reason = 'spindle stop override is allowed only while in HOLD (protocol.c:726-727)';
          return;
        }
        this.spindleOn = false;
        return;
      case 0x90:
        this.overrides.feed = 100;
        return;
      case 0x91:
        this.overrides.feed = Math.min(200, this.overrides.feed + 10);
        return;
      case 0x92:
        this.overrides.feed = Math.max(10, this.overrides.feed - 10);
        return;
      case 0x93:
        this.overrides.feed = Math.min(200, this.overrides.feed + 1);
        return;
      case 0x94:
        this.overrides.feed = Math.max(10, this.overrides.feed - 1);
        return;
      case 0x95:
        this.overrides.rapid = 100;
        return;
      case 0x96:
        this.overrides.rapid = 50;
        return;
      case 0x97:
        this.overrides.rapid = 25;
        return;
      case 0x99:
        this.overrides.spindle = 100;
        return;
      case 0x9a:
        this.overrides.spindle = Math.min(200, this.overrides.spindle + 10);
        return;
      case 0x9b:
        this.overrides.spindle = Math.max(10, this.overrides.spindle - 10);
        return;
      case 0x9c:
        this.overrides.spindle = Math.min(200, this.overrides.spindle + 1);
        return;
      case 0x9d:
        this.overrides.spindle = Math.max(10, this.overrides.spindle - 1);
        return;
      default:
        receipt.ignored = true;
        receipt.reason = `unrecognised realtime byte 0x${b.toString(16)}`;
    }
  }

  private holdSubstate = 0;

  private after(ms: number, run: () => void): void {
    this.timers.push({ at: this.now + ms, run });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    this.executed.push(trimmed);
    this.executedCount += 1;

    if (this.options.resetAfterLines !== null && this.executedCount === this.options.resetAfterLines) {
      this.state = 'Alarm';
      this.alarmCode = 3;
      this.homedNow = false;
      this.rx = '';
      this.emit("GrblHAL 1.1f ['$' or '$HELP' for help]");
      this.emit('ALARM:3');
      return;
    }
    if (this.options.silentAfterLines !== null && this.executedCount > this.options.silentAfterLines) {
      return; // no reply, no report, nothing. Ever again.
    }
    if (this.jammed) return;

    if (this.options.persona === 'marlin') {
      this.emit(trimmed.startsWith('$') ? 'echo:Unknown command: "' + trimmed + '"' : 'ok');
      return;
    }

    /* An empty line or a `$` command clears the poisoned state — the wiki says
     * so, and it is exactly why a sender that "syncs" with a blank line silently
     * un-poisons a stream and resumes executing motion after a rejected block. */
    if (trimmed === '' || trimmed.startsWith('$')) this.lastError = 0;

    if (trimmed === '') {
      this.emit('ok');
      return;
    }

    if (trimmed.startsWith('$')) {
      this.handleSystemCommand(trimmed);
      return;
    }

    // ── g-code ──
    if (this.state === 'Alarm' || this.state === 'Jog') {
      this.emit('error:9'); // Status_SystemGClock
      return;
    }
    if (this.lastError !== 0) {
      /* 🔴 POISONED. The line is never parsed; the previous error is repeated.
       * `protocol.c:265-272` guards the g-code branch on the PREVIOUS line's
       * result. So an error list is one real finding plus N copies of it. */
      this.emit(`error:${this.lastError}`);
      return;
    }
    const reject = this.options.rejectLine;
    if (reject && this.executedCount === reject.index) {
      this.lastError = reject.code;
      this.emit(`error:${reject.code}`);
      return;
    }
    if (/^G38\.[23456]/i.test(trimmed)) {
      if (this.options.probeContacts) {
        this.emit(`[PRB:${this.mpos.map((v) => v.toFixed(3)).join(',')}:1]`);
        this.emit('ok');
      } else {
        if (this.options.probeAlarmEmitsOk) this.emit('ok');
        this.state = 'Alarm';
        this.alarmCode = 5;
        this.emit('ALARM:5');
      }
      return;
    }
    if (/(^|\s)M0(\s|$)/i.test(trimmed)) {
      this.state = 'Hold';
      this.holdSubstate = 0;
      this.emit('ok');
      return;
    }
    if (/(^|\s)M3(\s|$)/i.test(trimmed)) this.spindleOn = true;
    if (/(^|\s)M5(\s|$)/i.test(trimmed)) this.spindleOn = false;
    this.emit('ok');
  }

  private handleSystemCommand(cmd: string): void {
    const c = cmd.trim();
    if (c === '$I') {
      this.emit('[VER:1.1f.20240122:]');
      this.emit('[OPT:VNS,35,1024,3,0]');
      this.emit('ok');
      return;
    }
    if (c === '$$') {
      for (const line of this.settingsDump()) this.emit(line);
      this.emit('ok');
      return;
    }
    if (c === '$X') {
      if (this.homingRequired()) {
        /* 🔴 `$X` is REFUSED while homing is required: `disable_lock` calls
         * `check_status(false)`, which returns `Status_HomingRequired` and the
         * unlock branch is never taken (`system.c:439-460`). */
        this.emit('error:46');
        return;
      }
      this.state = 'Idle';
      this.alarmCode = null;
      this.emit('[MSG:Caution: Unlocked]');
      this.emit('ok');
      return;
    }
    if (c === '$H') {
      this.state = 'Home';
      /* A long blocking motion with NO status reports — `$10` bit 12 (report
       * while homing) is off by default. A watchdog that is not state-aware
       * fires here on every single homing cycle, gets muted, and then misses a
       * real death. */
      this.after(this.options.homingMs, () => {
        this.homedNow = true;
        this.state = 'Idle';
        this.alarmCode = null;
        this.mpos = [...this.options.machinePosition];
        this.emit('ok');
      });
      return;
    }
    if (c.startsWith('$J=')) {
      if (this.state === 'Alarm') {
        this.emit('error:9');
        return;
      }
      const limit = this.options.jogSoftLimitMm;
      if (limit !== null) {
        const words = [...c.matchAll(/([XYZ])\s*(-?\d+(?:\.\d+)?)/gi)];
        if (words.some(([, , v]) => Math.abs(Number(v)) > limit)) {
          /* An ERROR, not an alarm: the jog is simply not executed. */
          this.emit('error:15');
          return;
        }
      }
      this.state = 'Jog';
      this.emit('ok');
      this.after(this.options.jogMs, () => {
        if (this.state === 'Jog') this.state = 'Idle';
      });
      return;
    }
    if (c === '$G') {
      this.emit('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]');
      this.emit('ok');
      return;
    }
    this.emit('ok');
  }

  private settingsDump(): string[] {
    const o = this.options;
    return [
      '$10=' + o.statusMask,
      '$13=' + (o.reportInches ? 1 : 0),
      '$20=1',
      '$21=1',
      '$22=' + o.homingConfig,
      '$30=24000',
      '$31=6000',
      '$40=1',
      '$398=' + o.plannerBlocks,
      '$481=0',
    ];
  }

  /* ── the status report ──────────────────────────────────────────────────── */

  /**
   * Build one report, honouring `$10` **by actually omitting the fields the mask
   * clears** — not by sending them and hoping nobody looks. That is the whole
   * point of the `mask-1` persona: under `$10=1` there is no `WCO` at all, and a
   * DRO that assumes one arrives shows machine coordinates labelled work.
   *
   * @param full a `0x87` request: every element, including the change-only ones
   * and `FW:grblHAL`.
   */
  private emitReport(full: boolean): void {
    const o = this.options;
    const m = o.statusMask;
    const bit = (n: number) => (m & (1 << n)) !== 0;

    if (o.persona === 'grbl-1.1') {
      // grbl v1.1: MPos only, no extensions at all.
      this.emit(`<${this.stateWord()}|MPos:${this.fmt(this.mpos)}|FS:0,0>`);
      return;
    }

    const fields: string[] = [];
    if (bit(0)) {
      fields.push(`MPos:${this.fmt(this.mpos)}`);
    } else {
      fields.push(`WPos:${this.fmt(this.mpos.map((v, i) => v - this.wcoNow[i]))}`);
    }
    if (bit(1)) fields.push(`Bf:${o.plannerBlocks},${this.rxFree}`);
    if (bit(2)) fields.push(`Ln:${this.executedCount}`);
    if (bit(3)) fields.push(`FS:0,${this.spindleOn ? 12000 : 0}`);
    if (bit(4)) fields.push('Pn:');

    // Change-only elements. WCO is withheld until the refresh counter fires or a
    // full report is asked for — which is exactly why 0x87 is required and not
    // optional.
    this.reportsSinceWco += 1;
    const wcoDue = full || this.reportsSinceWco >= o.wcoRefreshCount;
    if (bit(5) && wcoDue) {
      fields.push(`WCO:${this.fmt(this.wcoNow)}`);
      this.reportsSinceWco = 0;
    }
    if (bit(6) && (full || wcoDue)) {
      fields.push(`Ov:${this.overrides.feed},${this.overrides.rapid},${this.overrides.spindle}`);
    }
    if (full) {
      fields.push(`WCS:G54`);
      fields.push(`H:${this.homedNow ? 1 : 0}`);
      fields.push('TLR:0');
      fields.push('FW:grblHAL');
    }
    if (this.spindleOn) fields.push('A:S');
    // `Pn:` with no letters is not sent by a real controller; drop the empty one.
    const cleaned = fields.filter((f) => f !== 'Pn:');
    this.emit(`<${this.stateWord()}|${cleaned.join('|')}>`);
  }

  private stateWord(): string {
    if (this.state === 'Alarm') {
      // `$10` bit 10 governs the substate — but a FULL report always carries it.
      return this.alarmCode !== null && (this.options.statusMask & 1024) !== 0
        ? `Alarm:${this.alarmCode}`
        : 'Alarm';
    }
    if (this.state === 'Hold') return `Hold:${this.holdSubstate}`;
    return this.state;
  }

  private fmt(v: number[]): string {
    return v.map((n) => n.toFixed(3)).join(',');
  }

  /* ── emission ───────────────────────────────────────────────────────────── */

  private emit(line: string): void {
    this.emitBytes(new TextEncoder().encode(line + '\r\n'));
  }

  private emitBytes(bytes: Uint8Array): void {
    const chunkSize = this.options.splitEvery;
    if (chunkSize === null || chunkSize <= 0) {
      this.deliver(bytes);
      return;
    }
    for (let i = 0; i < bytes.length; i += chunkSize) {
      this.deliver(bytes.slice(i, i + chunkSize));
    }
  }

  private deliver(chunk: Uint8Array): void {
    for (const l of [...this.listeners]) l(chunk);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   A PUMP, so a test can drive a real stream against a real Link
   ═══════════════════════════════════════════════════════════════════════════ */

export interface PumpResult {
  rounds: number;
  /** Every line the streamer put on the wire, in order. */
  wrote: string[];
  /** Every line the fake sent back, in order, including reports and messages. */
  read: string[];
  /** True when the loop stopped because nothing more could happen — a real
   *  deadlock, not a completion. A test that does not distinguish these two is
   *  a test that passes when the streamer stalls. */
  stalled: boolean;
}

/**
 * Run a `Streamer` against a `FakeController` with no timers anywhere.
 *
 * The loop is the one the real tab's worker runs — `nextLines()` → write →
 * replies → `onReply()` — which is what makes this an exercise of the streaming
 * protocol rather than of a mock of it. Bytes go out through `Link.write` and
 * come back through `Link.onData`, so `LineAssembler` and `classifyInbound` are
 * both on the path and neither is stubbed.
 *
 * With `autoExecute: false` the caller decides how many lines leave the fake's
 * RX buffer per round, which is what makes that buffer a real constraint: a
 * streamer whose character count is wrong overruns it and the fake jams.
 *
 * @param plant passed through to `classifyInbound`, so a plant can corrupt the
 * classification the streamer sees — which is where `count-status-as-ok` and
 * `ignore-async-alarm` actually bite.
 */
export async function pumpStream(
  fake: FakeController,
  streamer: Streamer,
  opts: { linesPerRound?: number; maxRounds?: number; plant?: ProtocolPlant } = {},
): Promise<PumpResult> {
  const linesPerRound = opts.linesPerRound ?? 1;
  const maxRounds = opts.maxRounds ?? 200000;
  const wrote: string[] = [];
  const read: string[] = [];
  const inbox: string[] = [];
  const assembler = new LineAssembler();
  const off = fake.onData((chunk) => {
    for (const line of assembler.push(chunk)) {
      read.push(line);
      inbox.push(line);
    }
  });

  let rounds = 0;
  let stalled = false;
  try {
    while (rounds < maxRounds) {
      rounds += 1;
      const toSend = streamer.nextLines();
      for (const line of toSend) {
        wrote.push(line);
        await fake.write(new TextEncoder().encode(line + '\n'));
      }
      const executed = fake.options.autoExecute ? 0 : fake.execute(linesPerRound);
      const replies = inbox.length;
      while (inbox.length > 0) {
        streamer.onReply(classifyInbound(inbox.shift() as string, opts.plant));
      }
      if (streamer.state === 'done' || streamer.state === 'aborted') break;
      if (toSend.length === 0 && executed === 0 && replies === 0) {
        stalled = true;
        break;
      }
    }
  } finally {
    off();
  }
  return { rounds, wrote, read, stalled };
}
