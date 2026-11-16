// The SIMULATED machine: `run/fake.ts`'s healthy grblHAL persona, driven by
// the Run tab's own sender.
//
// 🔴 NOT A NEW SENDER. Every byte goes through the code the Run tab streams
// with: `startCommands` (RunTab.tsx — refuses on R1–R14 from
// `run/protocol.ts::refusalsFor`), `Streamer` (character counting against the
// RX buffer MEASURED from `Bf`), `StreamPump` (run/transport.ts, the loop the
// streamer worker runs), `classifyInbound`, `applyStatusReport`. What differs
// is only the Link: the Run tab's is a Web Serial port in a worker, this one is
// the `FakeController` in the page — which is why it can only ever be the
// SIMULATED machine, and says so everywhere.
//
// 🔴 WHAT A GREEN HERE MEANS: the sender agrees with this lane's own model of
// grblHAL (`fake.ts`'s header says it in full). Nothing has moved, nothing has
// cut.
//
// Three things this file decides, and why:
//
//  1. Execution is PACED. The fake runs with `autoExecute: false` and `tick()`
//     executes a few lines at a time, so the RX buffer is a real constraint,
//     progress is visible, and an M0 actually stops the run: while the
//     controller is in Hold no line is executed, exactly as grblHAL holds its
//     planner.
//  2. POSITION IS TRUSTED ONLY AFTER A `$H` THAT COMPLETED ON THIS LINK. That is
//     R2's own remedy ("Re-home ($H)"). The Run tab never sets it true at all
//     today; this file sets it on the `ok` that ends a homing cycle it sent,
//     and on nothing else.
//  3. THE TOOL STARTS AT WORK Z 0 — the state after zero was set on the top
//     of the workpiece. The fake does not interpret `G10`, so setting zero
//     cannot be simulated; instead the persona is built with its WCO equal to
//     its machine position in Z (`SIM_POSITION`). This is declared, and R3 is
//     NOT disabled: a program whose first move descends below the tool is still
//     refused by the sender (test: "R3 still refuses a descent").
//  4. `Run` on the card is the SENDER's word. The fake never reports `Run` (it
//     executes a line in zero time), so while the sender is streaming and the
//     controller reports `Idle` the card says `Run`. Every other state is the
//     controller's own `?` report.

import { FakeController, type FakeOptions } from '../run/fake';
import {
  LineAssembler,
  PortOwnershipWatch,
  Streamer,
  classifyInbound,
  decodeHomingConfig,
  decodeReportMask,
  identify,
  initialTrackedState,
  refusalsFor,
  type MachineState,
  type Refusal,
  type ReportMask,
  type StatusReport,
  type TrackedState,
} from '../run/protocol';
import { StreamPump, encodeLine } from '../run/transport';
import { applyStatusReport, OutstandingChars, startCommands, trackedForProgram, type MeasuredBuffers, type RunProgram } from '../RunTab';
import { ANALYSE_COMMANDS, analyse, profileOf, type RouterProfile } from '../run/routerProfile';
import { pauseAt, pausesOf, type Pause } from './steps';
import type { RunPhase } from './jobs';

export interface StreamView {
  jobId: string;
  phase: RunPhase;
  sent: number;
  acked: number;
  total: number;
  state: 'ready' | 'streaming' | 'done' | 'aborted';
  abort: string | null;
}

export interface SimSnapshot {
  /** The line a gate must print: which persona answered (fake.ts §18). */
  describe: string;
  identified: string | null;
  /** What the card shows. See note 3 at the top. */
  state: MachineState | 'Offline';
  substate: number | null;
  homed: boolean;
  homing: boolean;
  stream: StreamView | null;
  pause: Pause | null;
  /** R-numbered refusals the sender would give for a start right now (no program: R5 excluded). */
  refusals: Refusal[];
  /**
   * Where the controller SAYS the tool is, in work coordinates (X, Y, Z), from the last status
   * report: `WPos` as sent, or `MPos` minus the last `WCO`. `null` when no report has given one.
   * 🔴 bughunt 2026-11-15: the run view drew the tool at the last ACKNOWLEDGED line, and a real
   * grblHAL acknowledges a line when it enters the planner, a planner's worth of moves before the
   * cutter gets there. The drawn tool led the real one. This is the controller's own answer.
   */
  work: [number, number, number] | null;
}

/** Work position from a status report: `WPos` as sent, `MPos − WCO` otherwise. Pure, so it is tested. */
export function workPosition(r: StatusReport | null, lastWco: readonly number[] | null): [number, number, number] | null {
  if (!r?.position || r.position.length < 3 || !r.positionKind) return null;
  const p = r.position;
  if (r.positionKind === 'WPos') return [p[0], p[1], p[2]];
  const w = r.wco ?? lastWco;
  if (!w || w.length < 3) return null;
  return [p[0] - w[0], p[1] - w[1], p[2] - w[2]];
}

/** The card's state word. Pure, so the one invented word ('Run') is tested. */
export function displayState(controller: MachineState, streaming: boolean): MachineState {
  return streaming && controller === 'Idle' ? 'Run' : controller;
}

/**
 * 🔴 EVERY LINE IS ENCODED BEFORE THE FIRST BYTE IS SENT. `encodeLine`
 * (run/transport.ts) refuses a non-ASCII character, because the character
 * count would undercount the bytes on the wire. Inside `StreamPump` that
 * refusal is a throw from the middle of a stream, AFTER `Streamer` has counted
 * the line as sent — measured 2026-10-15: the pump then carried on with the
 * next line, the count never closed, and the run hung in a state no screen
 * explains. So the same rule is applied to the whole program up front, and the
 * first line it refuses is named. Nothing is rewritten to make it pass.
 */
export function unsendable(lines: readonly string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    try {
      encodeLine(lines[i]);
    } catch (e) {
      return `The sender cannot send line ${i + 1} (${String((e as Error).message ?? e)}). Nothing was sent.`;
    }
  }
  return null;
}

/** Machine position and work offset of the simulated machine: tool at work X0 Y0 Z0. */
export const SIM_POSITION = { machinePosition: [-100, -200, -25], wco: [-100, -200, -25] };

export type StartResult = { ok: true } | { ok: false; refusals: string[] };

export class SimSession {
  readonly fake: FakeController;
  private tracked: TrackedState = initialTrackedState();
  private report: StatusReport | null = null;
  private lastWco: number[] | null = null;
  private mask: ReportMask | null = null;
  private buffers: MeasuredBuffers = { rx: null, planner: null };
  private readonly ours = new OutstandingChars();
  private readonly watch = new PortOwnershipWatch();
  private readonly assembler = new LineAssembler();
  private readonly heard: string[] = [];
  private homingSent = false;
  private pump: StreamPump | null = null;
  private streamer: Streamer | null = null;
  private job: { id: string; phase: RunPhase; pauses: Pause[] } | null = null;
  private listeners = new Set<() => void>();
  private ended: ((jobId: string, how: 'done' | 'aborted', why: string | null) => void) | null = null;
  /** Lines executed per tick. */
  linesPerTick = 6;

  constructor(overrides: Partial<FakeOptions> = SIM_POSITION) {
    this.fake = new FakeController('healthy', { autoExecute: false, ...overrides });
    this.fake.onData((chunk) => {
      for (const line of this.assembler.push(chunk)) this.onLine(line);
    });
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  onEnded(f: (jobId: string, how: 'done' | 'aborted', why: string | null) => void): void {
    this.ended = f;
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }

  /**
   * 🔴 THE LINK EVERY LINE GOES THROUGH, and it charges our count AS THE BYTES
   * ENTER THE BUFFER. Two defects found 2026-10-15 shaped this: (1) lines this
   * file wrote itself (`$I`, `$H`) were not charged, so the port-ownership watch
   * read our own `$H` as a second writer (R14, journey J9b); (2) charging from
   * the pump's 'sent' event is too late — that event fires after the write
   * resolves, the ticker can execute the line first, its `ok` arrives before
   * the charge, and the count goes 'unknown', which silences R14 instead of
   * satisfying it. Realtime bytes are not lines and are not charged.
   */
  private readonly link = {
    write: async (bytes: Uint8Array): Promise<void> => {
      const realtime = bytes.length === 1 && bytes[0] !== 0x0a;
      if (!realtime) this.ours.onSent(new TextDecoder().decode(bytes).replace(/\n$/, ''));
      await this.fake.write(bytes);
    },
    onData: (cb: (chunk: Uint8Array) => void) => this.fake.onData(cb),
    close: () => this.fake.close(),
  };

  private async write(line: string): Promise<void> {
    await this.link.write(new TextEncoder().encode(line + '\n'));
  }

  private realtime(byte: number): Promise<void> {
    return this.fake.write(Uint8Array.of(byte));
  }

  /** Identify (read-only: `$I`, a full report, `$$`), as the Run tab's consent probe does. */
  async connect(): Promise<void> {
    await this.write('$I');
    await this.realtime(0x87);
    await this.write('$$');
    this.fake.execute();
    const v = identify([...this.heard]);
    this.tracked = { ...this.tracked, identification: v.verdict, tab: 'Idle' };
    this.changed();
  }

  /** The Analyse step's read-only commands, read into a router profile. Nothing is written. */
  async analyse(): Promise<RouterProfile> {
    const from = this.heard.length;
    for (const c of ANALYSE_COMMANDS) await this.write(c);
    this.fake.execute();
    return profileOf(analyse(this.heard.slice(from)));
  }

  /** `$H`. Position is trusted on the `ok` that ends it (note 2). */
  async home(): Promise<void> {
    if (this.streamer && this.streamer.state === 'streaming') return;
    this.homingSent = true;
    await this.write('$H');
    this.fake.execute();
    this.changed();
  }

  private onLine(line: string): void {
    this.heard.push(line);
    if (this.heard.length > 2000) this.heard.splice(0, 1000);
    const inbound = classifyInbound(line);
    this.ours.onInbound(inbound);
    if (inbound.status) {
      const r = inbound.status;
      this.report = r;
      if (r.wco) this.lastWco = r.wco;
      const step = applyStatusReport({
        report: r,
        buffers: this.buffers,
        lastWco: this.lastWco,
        streaming: this.streaming,
        ours: this.ours,
        watch: this.watch,
        mask: this.mask,
      });
      this.buffers = step.buffers;
      this.tracked = step.track(this.tracked);
      return;
    }
    if (inbound.kind === 'alarm') {
      this.tracked = { ...this.tracked, tab: 'Alarm', controllerState: 'Alarm', controllerSubstate: inbound.code, positionTrusted: false, positionUntrustedWhy: `ALARM:${inbound.code}` };
      return;
    }
    if (inbound.kind === 'ok' && this.homingSent && this.fake.machineState === 'Idle') {
      this.homingSent = false;
      this.tracked = { ...this.tracked, homingSeen: true, positionTrusted: true, positionUntrustedWhy: null };
      return;
    }
    const kv = /^\$(\d+)=(.+)$/.exec(line.trim());
    if (kv) {
      const n = Number(kv[1]);
      const v = Number(kv[2]);
      if (n === 10 && Number.isFinite(v)) this.mask = decodeReportMask(v);
      if (n === 13) this.tracked = { ...this.tracked, reportUnits: v === 1 ? 'inch' : 'mm' };
      if (n === 22 && Number.isFinite(v)) this.tracked = { ...this.tracked, homingEnabled: decodeHomingConfig(v).enabled };
    }
  }

  get streaming(): boolean {
    return !!this.streamer && this.streamer.state === 'streaming';
  }

  /**
   * Start streaming a program, through `startCommands` — so every refusal the
   * Run tab gives applies here unchanged. Refused: nothing is written.
   */
  start(jobId: string, phase: RunPhase, program: RunProgram): StartResult {
    if (this.streaming) return { ok: false, refusals: ['Another program is streaming on this machine.'] };
    const outcome = startCommands(program, trackedForProgram(this.tracked, program));
    if (outcome.status === 'refused') return { ok: false, refusals: outcome.refusals.map((r) => `${r.id}: ${r.fact}`) };
    const load = outcome.commands.find((c) => c.t === 'load');
    if (!load || load.t !== 'load') return { ok: false, refusals: ['The sender produced no program to load.'] };
    const bad = unsendable(load.lines);
    if (bad) return { ok: false, refusals: [bad] };
    this.streamer = new Streamer({ lines: [...load.lines], mode: load.mode, rxBufferSize: load.rxBufferSize });
    this.pump = new StreamPump({ link: this.link, streamer: this.streamer });
    this.pump.attach();
    this.job = { id: jobId, phase, pauses: pausesOf(load.lines) };
    void this.pump.pump();
    this.changed();
    return { ok: true };
  }

  /** Advance the simulation: execute lines unless held, let the fake's clock run, poll status. */
  async tick(ms = 50): Promise<void> {
    /* A homing cycle is ~4 s of fake time with no reports; it runs at 10× here. */
    this.fake.tick(this.fake.machineState === 'Home' ? ms * 10 : ms);
    for (let i = 0; i < this.linesPerTick; i++) {
      const s = this.fake.machineState;
      if (s === 'Hold' || s === 'Alarm' || s === 'Door' || s === 'Home') break;
      if (this.fake.execute(1) === 0) break;
    }
    if (this.pump && this.streaming) await this.pump.pump();
    await this.realtime(0x87);
    this.finishIfEnded();
    this.changed();
  }

  private finishIfEnded(): void {
    if (!this.streamer || !this.job) return;
    const st = this.streamer.state;
    if (st !== 'done' && st !== 'aborted') return;
    const id = this.job.id;
    const why = this.streamer.abort?.message ?? null;
    /* 🔴 SAME RESPONSE AS THE RUN TAB (`RunTab.tsx` abortResponse): an `error`
     * or `desync` abort stops the SENDER, not the machine — grblHAL keeps
     * running what is in its buffer with the spindle on. The Run tab sends a
     * feed hold; this session did not, so the Jobs page recorded "aborted"
     * while the controller worked through its buffer and sat with the spindle
     * turning. An `alarm` has already stopped motion; `stopped` is the
     * operator's Stop, which sends its own hold. */
    const reason = this.streamer.abort?.reason;
    if (st === 'aborted' && (reason === 'error' || reason === 'desync')) void this.feedHold();
    this.pump?.detach();
    this.pump = null;
    this.job = null;
    this.ended?.(id, st === 'done' ? 'done' : 'aborted', why);
  }

  /** Feed hold. Allowed from anywhere the machine is shown. */
  async feedHold(): Promise<void> {
    await this.realtime(0x21);
    await this.realtime(0x87);
    this.changed();
  }

  /** Cycle start. Refused by R10 when there is nothing to resume. */
  async resume(): Promise<string[]> {
    const r = refusalsFor('resume', this.tracked);
    if (r.length) return r.map((x) => `${x.id}: ${x.fact}`);
    await this.realtime(0x7e);
    await this.realtime(0x87);
    this.changed();
    return [];
  }

  /**
   * Abort: feed hold FIRST, then stop the sender, then soft reset — the order
   * `abortResponse` (RunTab.tsx) documents, so nothing is left decelerating.
   */
  async abort(message: string): Promise<void> {
    await this.realtime(0x21);
    this.pump?.stop(message);
    await this.realtime(0x18);
    this.tracked = { ...this.tracked, positionTrusted: false, positionUntrustedWhy: 'reset after an abort; home again.' };
    this.finishIfEnded();
    await this.realtime(0x87);
    this.changed();
  }

  snapshot(): SimSnapshot {
    const s = this.tracked;
    const streaming = this.streaming;
    const view: StreamView | null =
      this.streamer && this.job
        ? {
            jobId: this.job.id,
            phase: this.job.phase,
            sent: this.streamer.sent,
            acked: this.streamer.acknowledged,
            total: this.streamer.total,
            state: this.streamer.state,
            abort: this.streamer.abort?.message ?? null,
          }
        : null;
    const ctl = this.report?.state ?? s.controllerState;
    return {
      describe: this.fake.describe(),
      identified: s.identification,
      state: s.identification ? displayState(ctl, streaming) : 'Offline',
      substate: this.report?.substate ?? null,
      homed: s.positionTrusted,
      homing: this.homingSent,
      stream: view,
      pause: view && this.job ? pauseAt(this.job.pauses, view.acked, this.fake.machineState) : null,
      refusals: refusalsFor('start-job', s).filter((r) => r.id !== 'R5' && r.id !== 'R3'),
      work: workPosition(this.report, this.lastWco),
    };
  }
}
