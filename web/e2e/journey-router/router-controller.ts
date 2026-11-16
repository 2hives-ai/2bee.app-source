// TEST-ONLY. A Web Serial port for the router journey: the run18 fake-serial
// shim (`../run18/fake-serial-port.ts`, over `src/run/fake.ts`), imported
// UNMODIFIED, wrapped with two things it does not have.
//
//   1. A RECEIVED-BYTES LOG, taken inside `writable` — every byte the app
//      wrote, before anything interprets it. This is what the journey asserts
//      on (`wire.ts`), never the app's own echo.
//
//   2. A grblHAL MACHINE PROFILE for the four analysis reads. `fake.ts`
//      answers `$I` with a 2024 build and no NEWOPT, answers `$$` with no axis
//      settings ($100-$132 absent), and answers `$#` and `$PINS` with a bare
//      `ok`. Those four lines are answered HERE instead, in grblHAL's formats
//      (report.c / system.c); everything else — the 0x87 full report that
//      identifies the board as grblHAL, `?`, any other line — goes to the
//      unmodified fake.
//
// 🔴 WHAT A GREEN THROUGH THIS MEANS: the router page, the RunTab connection
// and the real `streamer.worker` agree with THIS LANE'S reading of grblHAL's
// reply formats. It says nothing about a real board. The profile below is
// invented for the test (1250 x 670 x 90 travel); it is not our router's
// configuration and not anything `pcb` set.

import { FakeSerial } from '../run18/fake-serial-port';
import type { PersonaName } from '../../src/run/fake';
import type { SerialLike, SerialPortInfoLike, SerialPortLike } from '../../src/run/transport';
import { isRealtime, type WireWrite } from './wire';

/** The machine this fake describes. Realistic grblHAL reply lines. */
export const PROFILE_REPLIES: Record<string, readonly string[]> = {
  $I: ['[VER:1.1f.20260811:]', '[OPT:VNSL,35,1024,3,0]', '[NEWOPT:ENUMS,RT+,HOME,PROBES=1,TC]', '[FIRMWARE:grblHAL]'],
  $$: [
    '$0=10.0',
    '$1=25',
    '$10=511',
    '$13=0',
    /* Soft limits OFF on purpose: the journey asserts a flag is rendered, and
     * this is the flag a real misconfigured machine would raise. */
    '$20=0',
    '$21=1',
    '$22=1',
    '$30=24000.000',
    '$31=6000.000',
    '$100=400.00000',
    '$101=400.00000',
    '$102=800.00000',
    '$110=8000.000',
    '$111=8000.000',
    '$112=2000.000',
    '$120=400.000',
    '$121=400.000',
    '$122=200.000',
    '$130=1250.000',
    '$131=670.000',
    '$132=90.000',
    '$398=100',
    '$481=0',
  ],
  '$#': [
    '[G54:0.000,0.000,0.000]',
    '[G55:0.000,0.000,0.000]',
    '[G56:0.000,0.000,0.000]',
    '[G57:0.000,0.000,0.000]',
    '[G58:0.000,0.000,0.000]',
    '[G59:0.000,0.000,0.000]',
    '[G28:0.000,0.000,0.000]',
    '[G30:0.000,0.000,0.000]',
    '[G92:0.000,0.000,0.000]',
    '[TLO:0.000,0.000,12.500]',
    '[PRB:0.000,0.000,-41.200:1]',
  ],
  $PINS: ['[PIN:PB10,X limit min]', '[PIN:PE12,Y limit min]', '[PIN:PE14,Z limit max]', '[PIN:PA1,Probe]'],
};

const enc = (s: string) => new TextEncoder().encode(s);

/** A port that records what it receives and answers the analysis reads. */
export class RouterPort implements SerialPortLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly log: WireWrite[] = [];
  private seq = 0;
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private line: number[] = [];

  constructor(private readonly inner: SerialPortLike) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.out = c;
      },
    });
    /* Pump the inner fake's replies through, chunk by chunk, in arrival order.
     * The inner reader is taken ONCE, here — `WebSerialLink` only ever sees our
     * readable. */
    const innerReadable = inner.readable;
    if (!innerReadable) throw new Error('inner fake has no readable');
    const reader = innerReadable.getReader();
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        if (value) this.out.enqueue(value);
      }
    })();

    const innerWritable = inner.writable;
    if (!innerWritable) throw new Error('inner fake has no writable');
    const innerWriter = innerWritable.getWriter();

    this.writable = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        /* 1. Record first, interpret second. */
        this.log.push({ seq: this.seq++, at: Date.now(), bytes: Array.from(bytes) });
        /* 2. Route byte by byte: realtime to the fake at once; line bytes are
         *    held until `\n`, then either answered here or forwarded whole. */
        for (const b of bytes) {
          if (isRealtime(b)) {
            await innerWriter.write(Uint8Array.of(b));
            continue;
          }
          this.line.push(b);
          if (b !== 0x0a) continue;
          const raw = Uint8Array.from(this.line);
          this.line = [];
          const text = String.fromCharCode(...raw).replace(/\r?\n$/, '').trim();
          const reply = PROFILE_REPLIES[text];
          if (reply) {
            for (const l of reply) this.out.enqueue(enc(l + '\r\n'));
            this.out.enqueue(enc('ok\r\n'));
          } else {
            await innerWriter.write(raw);
          }
        }
      },
    });
  }

  open(options: { baudRate: number; bufferSize?: number }): Promise<void> {
    return this.inner.open(options);
  }
  getInfo(): SerialPortInfoLike {
    return this.inner.getInfo();
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * `navigator.serial` for the worker: one port, the router.
 *
 * Synchronous to construct, deliberately: it is installed by a sibling module
 * that must finish evaluating before `streamer.worker` does, and a top-level
 * await there would put the worker's message handler behind a promise. The
 * inner port is resolved lazily on the first `getPorts`/`requestPort`.
 */
export class RouterSerial implements SerialLike {
  private readonly inner: FakeSerial;
  private readonly ready: Promise<RouterPort>;
  /** Set once resolved; the test reads `port.log` through it. */
  port: RouterPort | null = null;

  constructor(persona: PersonaName) {
    this.inner = new FakeSerial(persona);
    this.ready = this.inner.requestPort().then((p) => (this.port = new RouterPort(p)));
  }

  async getPorts(): Promise<SerialPortLike[]> {
    return [await this.ready];
  }
  async requestPort(): Promise<SerialPortLike> {
    return this.ready;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  describe(): string {
    return this.inner.describe() + ' + journey-router profile ($I/$$/$#/$PINS answered by e2e/journey-router)';
  }
}
