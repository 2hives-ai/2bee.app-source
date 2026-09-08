// TEST-ONLY. A Web Serial `SerialPort`/`Serial` shaped shim over the lane's
// grblHAL fake, so the REAL `streamer.worker` module can run unmodified inside
// a test-constructed worker.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT A GREEN THROUGH THIS SHIM MEANS
// ─────────────────────────────────────────────────────────────────────────────
//
// It means the worker's pump, driven by `await reader.read()` and `ok` replies,
// moved bytes at the measured rate in a real browser — against
// `src/run/fake.ts`, which is THIS LANE'S MODEL of grblHAL. It is not a green
// against a machine, and it never will be: that is `CTRL` and the physical
// rungs. The shim adds no timing behaviour of its own — with `autoExecute: true`
// the fake answers each write synchronously, so the pump is paced by the
// browser's own microtask/stream machinery, which is the thing RUN-18 measures.
//
// The shape implemented here is exactly what `WebSerialLink` in
// `src/run/transport.ts` touches: `open({baudRate})`, `readable`, `writable`,
// `getInfo()`, `close()` — plus the `SerialLike` half `resolvePort` consumes
// (`getPorts`/`requestPort`, connect/disconnect listeners as no-ops).

import { FakeController, type PersonaName, type FakeOptions } from '../../src/run/fake';
import type { SerialLike, SerialPortInfoLike, SerialPortLike } from '../../src/run/transport';

class FakeSerialPort implements SerialPortLike {
  private readonly fake: FakeController;
  private readonly controller: { enqueue(c: Uint8Array): void; close(): void };
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  private opened = false;

  constructor(persona: PersonaName, overrides: Partial<FakeOptions> = {}) {
    // autoExecute is the persona default (`healthy`) and stays on: the fake's
    // replies then arrive synchronously with each write, exactly as fast as the
    // browser lets the write promise resolve — no timers anywhere, so a hidden
    // page's timer throttling has nothing to bite in the fake itself.
    this.fake = new FakeController(persona, overrides);

    let ctl: { enqueue(c: Uint8Array): void; close(): void } | null = null;
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
      },
    });
    this.controller = {
      enqueue: (c) => ctl?.enqueue(c),
      close: () => {
        try {
          ctl?.close();
        } catch {
          /* already closed */
        }
      },
    };
    /* The banner fires on the first `onData` listener, so it is queued into the
     * readable side HERE, before `open()` — matching a real board, whose banner
     * would be sitting in the OS buffer by the time anyone reads. A
     * ReadableStream with no reader queues, so nothing is lost. */
    this.fake.onData((chunk) => this.controller.enqueue(chunk));

    this.writable = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        await this.fake.write(bytes);
      },
    });
  }

  async open(_options: { baudRate: number; bufferSize?: number }): Promise<void> {
    if (this.opened) {
      // Match the spec: open() on a non-closed port rejects with
      // InvalidStateError, the string `classifyPortError` keys on.
      throw new DOMException('The port is already open.', 'InvalidStateError');
    }
    this.opened = true;
  }

  getInfo(): SerialPortInfoLike {
    // Arbitrary ids; the page side of this harness sends no id cross-check.
    return { usbVendorId: 0x2bee, usbProductId: 0x0001 };
  }

  async close(): Promise<void> {
    this.opened = false;
    await this.fake.close();
    this.controller.close();
  }

  /** Test hook: the fake itself, for `describe()` and execution history. */
  get controllerFake(): FakeController {
    return this.fake;
  }
}

export class FakeSerial implements SerialLike {
  private readonly port: FakeSerialPort;

  constructor(persona: PersonaName = 'healthy', overrides: Partial<FakeOptions> = {}) {
    this.port = new FakeSerialPort(persona, overrides);
  }

  async getPorts(): Promise<SerialPortLike[]> {
    return [this.port];
  }

  async requestPort(): Promise<SerialPortLike> {
    return this.port;
  }

  addEventListener(): void {
    /* no hotplug in a fake */
  }

  removeEventListener(): void {
    /* no hotplug in a fake */
  }

  /** Test hook: a gate line names its subject; see fake.ts `describe()`. */
  describe(): string {
    return this.port.controllerFake.describe();
  }
}
