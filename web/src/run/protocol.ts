// The grblHAL protocol core — parsing, tables, streaming arithmetic, refusals.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// PURE. No DOM, no Web Serial, no timers, no I/O, no `await` on anything real.
// Every export below is either a pure function, a data table, or a state object
// the caller drives by handing it bytes and replies. That is not tidiness — it
// is the only way this half can be tested to a machine-control standard on a box
// with no machine and no browser. `transport.ts` (Web Serial) and `RunTab.tsx`
// (the screen) are written by other hands against the `Link` seam below and are
// not imported here; nothing in this file may assume either exists.
//
// 🔴 NOTHING HERE MOVES A MACHINE. It produces bytes and verdicts. Whether a byte
// reaches a controller is the transport's question, and whether it should have
// been sent at all is `refusalsFor`'s.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SOURCE OF EVERY CONTROLLER FACT BELOW
// ─────────────────────────────────────────────────────────────────────────────
//
// `docs/design-76-run-tab.md`, which read grblHAL's own C (`report.c`,
// `protocol.c`, `system.c`, `gcode.c`, `alarms.c`, `errors.c`, `settings.h`,
// `stream.h`, `grbl.h`, `machine_limits.c`, `motion_control.c`), the grblHAL
// wiki, and the grbl v1.1 interface documents grblHAL descends from, on
// 2026-08-10, each with its URL and line cite. **This file does not re-derive any
// of it and must not.** Where the design settled a number, the number is here
// with the cite next to it. Where the design did NOT settle something, the code
// says so at the point of the judgement rather than quietly picking one — search
// this file for `JUDGEMENT` to find every one of them.
//
// Five facts that cost the most if taken from grbl instead of grblHAL, because
// grbl is what every tutorial and every LLM will hand you:
//
//   · the RX buffer is **1024**, not 128 (`stream.h:51-53`) — and it is not
//     hard-coded here either, because a board map may override the define. It is
//     MEASURED from `Bf` (§2 of the design). See `Streamer`. ⚠ And the number
//     `Bf` can report is NOT always the buffer size: the USB CDC stream returns
//     `RX_BUFFER_SIZE - count` (`STM32F4xx/Src/usb_serial.c:54`, max **1024**)
//     and a UART returns `(RX_BUFFER_SIZE - 1) - count`
//     (`STM32F4xx/Src/serial.c:551`, max **1023**). grblHAL requires
//     `RX_BUFFER_SIZE` itself to be a power of two (`stream.h:52`, its own
//     comment) — **the measured figure is not**, so nothing here may round it,
//     mask it, or check it for one.
//   · `$10` has **fourteen** bits, not two (`settings.h:637-656`). Under `$10=1`
//     there is no `WCO` **at all**, so a DRO that assumes one arrives shows
//     machine coordinates in a box labelled work. See `deriveDro`.
//   · **`?`, `~` and `!` are the LEGACY encoding.** grblHAL carries two:
//     `CMD_STATUS_REPORT_LEGACY '?'` / `CMD_CYCLE_START_LEGACY '~'` /
//     `CMD_FEED_HOLD_LEGACY '!'` (`grbl.h:107-109`) **and**
//     `CMD_STATUS_REPORT 0x80` / `CMD_CYCLE_START 0x81` / `CMD_FEED_HOLD 0x82`
//     (`grbl.h:115-117`). They are handled in **different switches** with
//     **different guards** and neither is unconditional — see
//     {@link legacyRealtimeReliability}. Naming a legacy byte after the
//     non-legacy constant is how that difference disappears from view, and it
//     is what this file did until 2026-08-11.
//   · **`0x98` does not exist** in grblHAL (commented out in `grbl.h`), and the
//     spindle overrides run to `0x9E`, which is `Hold`-only. See `REALTIME`.
//   · after the first `error:`, grblHAL **poisons every subsequent line** and
//     replies with a copy of the same error about a line it never parsed
//     (`protocol.c:265-272`). So an error list is one finding plus N copies, and
//     the streamer aborts on the first one. See `Streamer.onReply`.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT A GREEN TEST OF THIS FILE DOES NOT MEAN
// ─────────────────────────────────────────────────────────────────────────────
//
// It does not mean the protocol is right. It means this implementation agrees
// with this lane's reading of grblHAL, checked against a fake this lane also
// wrote. A fake cannot discover that the reading is wrong. The same sentence is
// at the top of `fake.ts`, where it belongs even more.

/* ═══════════════════════════════════════════════════════════════════════════
   THE SEAM
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The one interface between this file and anything that can touch hardware.
 *
 * Implemented by `transport.ts` (Web Serial, real port) and by `fake.ts` (a
 * grblHAL responder in memory). Bytes in both directions, deliberately: a seam
 * that carried parsed objects would put the parser — where `$10` variants, an
 * absent `WCO`, `Alarm:5` substates and error poisoning actually live — on the
 * fake's side of the boundary, and the fake would then vouch for the one layer
 * it replaced (design §18).
 */
export interface Link {
  /** Raw bytes, including single realtime bytes. Never a string: see
   *  {@link realtimeBytes} for why a `TextEncoder` on this path is a defect. */
  write(bytes: Uint8Array): Promise<void>;
  /** Subscribe to inbound bytes. Returns an unsubscribe. Chunk boundaries are
   *  arbitrary and fall mid-line — {@link LineAssembler} is what handles that. */
  onData(cb: (chunk: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

/* ═══════════════════════════════════════════════════════════════════════════
   NEGATIVE CONTROLS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE DEFECTS THIS MODULE EXISTS TO PREVENT, REINTRODUCED ON DEMAND.
 *
 * Same idiom and same reason as `MESH_PLANTS` (`cad/mesh.ts`), `INVENTORY_PLANTS`
 * (`inventory.ts`) and `--plant` in the CLI: a rule nobody has watched fail is
 * not a rule. Every plant is an explicit extra argument, is never passed by the
 * UI, and the planted result is not decorated as planted — because a plant that
 * announces itself cannot be mistaken for the real defect, and it is precisely
 * the mistakability that the test needs.
 *
 * The names match the `--plant` column of gate `RUN` in
 * `docs/design-76-run-tab.md` §18 so the gate and this file cannot drift apart
 * silently.
 */
export type ProtocolPlant =
  /** Character counting is allowed one byte past the buffer. The classic
   *  off-by-one, and it overruns a real controller silently. (`RUN-1`) */
  | 'overcount'
  /** Status reports and `[…]` messages decrement the character count as if they
   *  were line replies. (`RUN-2`) */
  | 'count-status-as-ok'
  /** Keep streaming past the first `error:`. grblHAL then answers every later
   *  line with a copy of that error about a line it never read. (`RUN-3`) */
  | 'keep-going-past-error'
  /** Encode realtime commands through `TextEncoder`, so `0x90` goes out as the
   *  two bytes `0xC2 0x90`. (`RUN-4`) */
  | 'utf8-realtime'
  /** Treat a not-yet-reported `WCO` as zero, so the work DRO shows machine
   *  coordinates. (`RUN-5`) */
  | 'assume-zero-wco'
  /** Subtract `WCO` from a position the controller already reported as `WPos`.
   *  (`RUN-6`) */
  | 'double-subtract-wco'
  /** Permit `0x85` outside `Jog`, where it flushes the controller's RX buffer
   *  and desynchronises the character count. (`RUN-7`) */
  | 'cancel-while-streaming'
  /** Start a job with no homing evidence, and with position untrusted.
   *  (`RUN-8`) */
  | 'stream-unhomed'
  /** Start a job whose first motion is a descent, and start one where `WCO` is
   *  unknown so the comparison cannot be made at all. (`RUN-9`) */
  | 'descend-first'
  /** Believe `$X` worked when the controller answered `error:46`. (`RUN-10`) */
  | 'unlock-optimism'
  /** Treat a hard-limit or aborted-cycle alarm as one that retains position.
   *  (`RUN-11`) */
  | 'trust-after-hardlimit'
  /** Auto-resume a job after a reconnect. (`RUN-12`) */
  | 'auto-resume'
  /** Classify an asynchronous `ALARM:N` as ordinary output, so it never aborts
   *  the stream. (`RUN-13`) */
  | 'ignore-async-alarm'
  /** Render an alarm/error code this build has no entry for as if it were
   *  known and blank. (`RUN-14`) */
  | 'swallow-unknown-code'
  /** Accept any firmware as grblHAL. (`RUN-15`) */
  | 'accept-anything'
  /** Assume one read is one line. (`RUN-16`) */
  | 'assume-read-is-line';

export const PROTOCOL_PLANTS: ProtocolPlant[] = [
  'overcount',
  'count-status-as-ok',
  'keep-going-past-error',
  'utf8-realtime',
  'assume-zero-wco',
  'double-subtract-wco',
  'cancel-while-streaming',
  'stream-unhomed',
  'descend-first',
  'unlock-optimism',
  'trust-after-hardlimit',
  'auto-resume',
  'ignore-async-alarm',
  'swallow-unknown-code',
  'accept-anything',
  'assume-read-is-line',
];

/* ═══════════════════════════════════════════════════════════════════════════
   READING THE WIRE — chunks to lines
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Bytes to lines, across arbitrary read boundaries.
 *
 * ⚠ A serial read boundary falls **anywhere** — mid-line, mid-number, and on a
 * real CDC endpoint under load it will. A parser that assumes one read is one
 * line works perfectly against a naive fake and fails at the machine (design
 * §18 item 13). That is why this is a class with a carry buffer and not a
 * `split('\n')`.
 *
 * grblHAL terminates with `\r\n` (`ASCII_EOL`); `\n` alone is accepted because a
 * driver or a USB stack may not preserve the pair, and an empty line is dropped
 * rather than delivered as a reply — grblHAL's own empty-line handling is a
 * parser-state reset, not an answer to anything.
 */
export class LineAssembler {
  private carry = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  /** @param plant `'assume-read-is-line'` discards the carry buffer and treats
   *  each chunk as exactly one line — the defect this class exists to prevent. */
  push(chunk: Uint8Array, plant?: ProtocolPlant): string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    if (plant === 'assume-read-is-line') {
      const one = text.replace(/[\r\n]+$/, '');
      return one.length > 0 ? [one] : [];
    }
    this.carry += text;
    const out: string[] = [];
    for (;;) {
      const nl = this.carry.indexOf('\n');
      if (nl < 0) break;
      const line = this.carry.slice(0, nl).replace(/\r$/, '');
      this.carry = this.carry.slice(nl + 1);
      if (line.length > 0) out.push(line);
    }
    return out;
  }

  /** What has arrived with no terminator yet. Shown in the console as a partial
   *  line rather than hidden — a controller that stops mid-line is a fact. */
  get pending(): string {
    return this.carry;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLASSIFYING WHAT CAME BACK
   ═══════════════════════════════════════════════════════════════════════════ */

export type InboundKind =
  | 'ok'
  | 'error'
  | 'alarm'
  | 'status'
  | 'message'
  | 'banner'
  | 'other';

export interface Inbound {
  raw: string;
  kind: InboundKind;
  /** `error:N` / `ALARM:N`. */
  code: number | null;
  /** Parsed `<…>`; `null` with {@link parseError} set when it looked like a
   *  report and did not parse. A report we could not read is a finding, not
   *  noise, so it is never silently reclassified as `'other'`. */
  status: StatusReport | null;
  parseError: string | null;
  /** `'GrblHAL 1.1f …'` vs `'Grbl 1.1f …'` — the firmware word, verbatim. */
  bannerFirmware: string | null;
  /**
   * 🔴 THE ONE FIELD THE CHARACTER COUNT KEYS ON.
   *
   * Exactly one of `ok` / `error:N` comes back per line, and that stays true for
   * poisoned lines (design §2, `protocol.c:286`) — which is why character
   * counting cannot deadlock on an error. **`ALARM:N` is not a line reply**: it
   * arrives asynchronously and decrements nothing. A streamer that treats the
   * first line back as the answer scores a status report as an acceptance.
   */
  isLineReply: boolean;
}

const BANNER_RE = /^(GrblHAL|Grbl)\s+(\S+)/i;

/** @param plant `'count-status-as-ok'` makes reports and messages decrement the
 *  character count; `'ignore-async-alarm'` demotes `ALARM:N` to ordinary
 *  output so nothing aborts on it. */
export function classifyInbound(line: string, plant?: ProtocolPlant): Inbound {
  const raw = line;
  const trimmed = line.trim();
  const base = {
    raw,
    code: null as number | null,
    status: null as StatusReport | null,
    parseError: null as string | null,
    bannerFirmware: null as string | null,
  };
  const countsAnything = plant === 'count-status-as-ok';

  if (trimmed === 'ok') {
    return { ...base, kind: 'ok', isLineReply: true };
  }
  const err = /^error:\s*(\d+)$/i.exec(trimmed);
  if (err) {
    return { ...base, kind: 'error', code: Number(err[1]), isLineReply: true };
  }
  const alarm = /^ALARM:\s*(\d+)$/i.exec(trimmed);
  if (alarm) {
    if (plant === 'ignore-async-alarm') {
      return { ...base, kind: 'other', isLineReply: false };
    }
    return { ...base, kind: 'alarm', code: Number(alarm[1]), isLineReply: false };
  }
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const parsed = parseStatusReport(trimmed);
    return {
      ...base,
      kind: 'status',
      status: parsed.report,
      parseError: parsed.error,
      isLineReply: countsAnything,
    };
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return { ...base, kind: 'message', isLineReply: countsAnything };
  }
  const banner = BANNER_RE.exec(trimmed);
  if (banner) {
    return {
      ...base,
      kind: 'banner',
      bannerFirmware: banner[1],
      isLineReply: false,
    };
  }
  return { ...base, kind: 'other', isLineReply: countsAnything };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE STATUS REPORT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The ten machine states grblHAL reports. `Tool` is included because a report
 * carrying it must be *rendered*, not because we ever cause it — our post emits
 * `M0`, never `M6`, so the `0xA3` tool-change handshake is not on our path
 * (design F4/§9). A `Tool` state means a program from somewhere else is running,
 * and the tab should say that plainly rather than half-handling it.
 */
export type MachineState =
  | 'Idle'
  | 'Run'
  | 'Hold'
  | 'Jog'
  | 'Alarm'
  | 'Door'
  | 'Check'
  | 'Home'
  | 'Sleep'
  | 'Tool';

const MACHINE_STATES: MachineState[] = [
  'Idle',
  'Run',
  'Hold',
  'Jog',
  'Alarm',
  'Door',
  'Check',
  'Home',
  'Sleep',
  'Tool',
];

/** Whichever of `MPos`/`WPos` the report carried. Bit 0 of `$10` selects one and
 *  a report never carries both (`report.c:1285`). */
export type PositionKind = 'MPos' | 'WPos';

export interface StatusReport {
  raw: string;
  state: MachineState;
  /** The state word exactly as sent, substate included: `Hold:1`, `Alarm:5`. */
  stateWord: string;
  /** `Hold:0/1`, `Run:1/2`, `Door:0-3`, `Alarm:N`, or `null` when the controller
   *  sent a bare state word (`$10` bits 10/11 clear for `Alarm`/`Run`). */
  substate: number | null;
  positionKind: PositionKind | null;
  /** Axis count is whatever arrived — a 4- or 5-axis grblHAL reports that many.
   *  JUDGEMENT: the design's DRO is three axes; parsing into a fixed triple
   *  would silently drop a rotary's position, so this is an array and the UI
   *  decides how many columns it can draw. */
  position: number[] | null;
  wco: number[] | null;
  bf: { plannerFree: number; rxFree: number } | null;
  ln: number | null;
  fs: { feed: number; programmedRpm: number; actualRpm: number | null } | null;
  /** Raw `Pn:` letters. Decode with {@link decodePins}. */
  pn: string | null;
  ov: { feed: number; rapid: number; spindle: number } | null;
  /** Raw `A:` accessory letters. Decode with {@link decodeAccessories}. */
  a: string | null;
  /** `WCS:G54` → `'G54'`. */
  wcs: string | null;
  mpg: boolean | null;
  /** `H:1` or `H:1,7`. `all` is the 0/1; `mask` the per-axis bits when sent. */
  homed: { all: boolean; mask: number | null } | null;
  /** `D:0|1` — block-delete / optional-stop switch state, carried verbatim. */
  d: boolean | null;
  sc: string | null;
  tlr: boolean | null;
  /** `FW:grblHAL` — only ever appended to a **full** report requested with
   *  `0x87` (`report.c:1543-1545`). The strongest positive identification we
   *  have, because grbl 1.1 has no such field. */
  fw: string | null;
  /**
   * `AR:<ms>` / bare `AR` — whether the controller is auto-reporting, and at
   * what interval.
   *
   * 🔴 **This is the only place the tab can OBSERVE auto-reporting.** `$481`
   * says an interval is configured; it does not say the flag is set, because
   * `0x8C` toggles the flag independently of the setting
   * (`protocol.c:936-939`). grblHAL writes `"|AR:"` + the interval when the
   * flag is on and a bare `"|AR"` when it is off (`report.c:1500-1503`) — so
   * the colonless form is a **value**, not an unreadable field.
   *
   * ⚠ Emitted only in a **full** report (`0x87`) and only when `$481 != 0`, so
   * `null` means *"not stated"* and never *"off"*.
   */
  autoReporting: { on: boolean; intervalMs: number | null } | null;
  in: number | null;
  sd: string | null;
  dtg: number[] | null;
  /**
   * Fields this build has no entry for, kept verbatim.
   *
   * grblHAL adds report fields over time. Dropping an unrecognised one is the
   * same defect class as swallowing an unknown alarm code — the UI decides the
   * controller said nothing when it said something we did not read.
   */
  unknownFields: string[];
}

function numbers(csv: string): number[] | null {
  const parts = csv.split(',');
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (p.trim() === '' || !Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/**
 * Parse one `<…>` report.
 *
 * Returns `{ report, error }` rather than `StatusReport | null` on purpose: a
 * report that arrived and did not parse is evidence, and a function that
 * returned `null` for both "not a report" and "a report I could not read" would
 * make the second invisible.
 *
 * ⚠ Written to accept **both** `$10` worlds in every branch it can: `Alarm` and
 * `Alarm:5`, `Run` and `Run:2`, `MPos` and `WPos`, `WCO` present and absent.
 * Writing it defensively costs nothing and grblHAL's own config warns that
 * enabling bits 10/11 "may break senders" (`config.h:712, 725`).
 */
export function parseStatusReport(line: string): {
  report: StatusReport | null;
  error: string | null;
} {
  const trimmed = line.trim();
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) {
    return { report: null, error: 'not delimited by < >' };
  }
  const body = trimmed.slice(1, -1);
  const fields = body.split('|');
  if (fields.length === 0 || fields[0] === '') {
    return { report: null, error: 'empty report' };
  }

  const [stateWord] = fields;
  const colon = stateWord.indexOf(':');
  const stateName = colon < 0 ? stateWord : stateWord.slice(0, colon);
  const subText = colon < 0 ? null : stateWord.slice(colon + 1);
  const state = MACHINE_STATES.find((s) => s.toLowerCase() === stateName.toLowerCase());
  if (!state) {
    return { report: null, error: `unknown machine state '${stateName}'` };
  }
  let substate: number | null = null;
  if (subText !== null) {
    const n = Number(subText);
    if (!Number.isFinite(n)) {
      return { report: null, error: `unreadable substate '${subText}'` };
    }
    substate = n;
  }

  const r: StatusReport = {
    raw: trimmed,
    state,
    stateWord,
    substate,
    positionKind: null,
    position: null,
    wco: null,
    bf: null,
    ln: null,
    fs: null,
    pn: null,
    ov: null,
    a: null,
    wcs: null,
    mpg: null,
    homed: null,
    d: null,
    sc: null,
    tlr: null,
    fw: null,
    autoReporting: null,
    in: null,
    sd: null,
    dtg: null,
    unknownFields: [],
  };

  for (const field of fields.slice(1)) {
    const at = field.indexOf(':');
    if (at < 0) {
      /* A bare `AR` is grblHAL SAYING auto-reporting is off while an interval
       * is configured (`report.c:1501`) — the colon is absent because there is
       * no interval to print, not because the field is malformed. Treating it
       * as unknown would file a stated fact under "we did not read this". */
      if (field === 'AR') {
        r.autoReporting = { on: false, intervalMs: null };
        continue;
      }
      r.unknownFields.push(field);
      continue;
    }
    const key = field.slice(0, at);
    const value = field.slice(at + 1);
    switch (key) {
      case 'MPos':
      case 'WPos': {
        const v = numbers(value);
        if (!v) return { report: null, error: `unreadable ${key}: '${value}'` };
        r.positionKind = key;
        r.position = v;
        break;
      }
      case 'WCO': {
        const v = numbers(value);
        if (!v) return { report: null, error: `unreadable WCO: '${value}'` };
        r.wco = v;
        break;
      }
      case 'Bf': {
        const v = numbers(value);
        if (!v || v.length !== 2) {
          return { report: null, error: `unreadable Bf: '${value}'` };
        }
        r.bf = { plannerFree: v[0], rxFree: v[1] };
        break;
      }
      case 'Ln': {
        const v = Number(value);
        if (!Number.isFinite(v)) return { report: null, error: `unreadable Ln: '${value}'` };
        r.ln = v;
        break;
      }
      case 'FS': {
        const v = numbers(value);
        if (!v || v.length < 2) return { report: null, error: `unreadable FS: '${value}'` };
        r.fs = {
          feed: v[0],
          programmedRpm: v[1],
          actualRpm: v.length > 2 ? v[2] : null,
        };
        break;
      }
      case 'Pn':
        r.pn = value;
        break;
      case 'Ov': {
        const v = numbers(value);
        if (!v || v.length !== 3) return { report: null, error: `unreadable Ov: '${value}'` };
        r.ov = { feed: v[0], rapid: v[1], spindle: v[2] };
        break;
      }
      case 'A':
        r.a = value;
        break;
      case 'WCS':
        r.wcs = value;
        break;
      case 'MPG':
        r.mpg = value === '1';
        break;
      case 'H': {
        const parts = value.split(',');
        const all = parts[0] === '1';
        let mask: number | null = null;
        if (parts.length > 1) {
          const m = Number(parts[1]);
          mask = Number.isFinite(m) ? m : null;
        }
        r.homed = { all, mask };
        break;
      }
      case 'D':
        r.d = value === '1';
        break;
      case 'Sc':
        r.sc = value;
        break;
      case 'TLR':
        r.tlr = value === '1';
        break;
      case 'FW':
        r.fw = value;
        break;
      case 'AR': {
        const v = Number(value);
        r.autoReporting = { on: true, intervalMs: Number.isFinite(v) ? v : null };
        break;
      }
      case 'In': {
        const v = Number(value);
        r.in = Number.isFinite(v) ? v : null;
        break;
      }
      case 'SD':
        r.sd = value;
        break;
      case 'DTG': {
        const v = numbers(value);
        if (!v) return { report: null, error: `unreadable DTG: '${value}'` };
        r.dtg = v;
        break;
      }
      default:
        r.unknownFields.push(field);
    }
  }

  if (!r.positionKind) {
    return { report: null, error: 'report carried neither MPos nor WPos' };
  }
  return { report: r, error: null };
}

/* ── Pin and accessory letters ─────────────────────────────────────────────── */

/**
 * `Pn:` letters, per grbl v1.1 `doc/markdown/interface.md` (a source the design
 * cites in §20).
 *
 * ⚠ **NOT EXHAUSTIVE, and deliberately not guessed.** grblHAL adds letters this
 * table does not carry; the design points at the wiki's table without
 * reproducing it, so inventing entries here would put a fabricated controller
 * fact into a safety surface. An unrecognised letter is rendered as an
 * unrecognised letter — `decodePins` never drops one. A probe shown as not
 * triggered when it is triggered is the thing that turns a probe into a crash,
 * and "we had no entry for that letter" is the only honest rendering.
 */
const PIN_LETTERS: Record<string, string> = {
  X: 'X limit',
  Y: 'Y limit',
  Z: 'Z limit',
  A: 'A limit',
  B: 'B limit',
  C: 'C limit',
  P: 'probe',
  D: 'door',
  H: 'feed hold',
  R: 'soft reset',
  S: 'cycle start',
};

export interface DecodedLetter {
  letter: string;
  label: string;
  known: boolean;
}

export function decodePins(pn: string | null): DecodedLetter[] {
  if (!pn) return [];
  return [...pn].map((letter) => ({
    letter,
    label: PIN_LETTERS[letter] ?? `unrecognised pin '${letter}' — this UI has no entry for it`,
    known: letter in PIN_LETTERS,
  }));
}

/** `A:` accessory letters, grbl v1.1 `interface.md`. `S`/`C` are the two spindle
 *  directions — the tab may only say "the spindle is off" when it has watched
 *  `A:` lose its `S` (design §16). */
const ACCESSORY_LETTERS: Record<string, string> = {
  S: 'spindle CW',
  C: 'spindle CCW',
  F: 'flood coolant',
  M: 'mist coolant',
};

export function decodeAccessories(a: string | null): DecodedLetter[] {
  if (!a) return [];
  return [...a].map((letter) => ({
    letter,
    label:
      ACCESSORY_LETTERS[letter] ??
      `unrecognised accessory '${letter}' — this UI has no entry for it`,
    known: letter in ACCESSORY_LETTERS,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   WILL IT MOVE AGAIN ON ITS OWN?
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Whether the machine may move again with nobody touching anything.
 *
 * Modelled explicitly rather than left to a caller's judgement, because the
 * refusal set keys on it and because the two states that catch people out —
 * `Hold:1` (still decelerating) and `Door:2`/`Door:3` (retract/restore motions)
 * — look stopped in every UI that renders only the state word.
 */
export interface MotionVerdict {
  /** True when the machine is moving now or will move with no further input. */
  mayMove: boolean;
  /** Operator-readable, and it is what the top band renders under the state. */
  why: string;
  /**
   * False when the controller's own idea of where the tool is cannot be relied
   * on. `Sleep` disables the steppers, so the gantry can be pushed by hand and
   * the controller will not know (design §4).
   */
  positionGuaranteed: boolean;
}

export function motionVerdict(state: MachineState, substate: number | null): MotionVerdict {
  switch (state) {
    case 'Idle':
      return { mayMove: false, why: 'Idle — the planner is empty.', positionGuaranteed: true };
    case 'Run':
      return {
        mayMove: true,
        why:
          substate === 2
            ? 'Run:2 — probing. It is moving now.'
            : substate === 1
              ? 'Run:1 — moving, with a feed hold pending.'
              : 'Run — it is moving now.',
        positionGuaranteed: true,
      };
    case 'Hold':
      if (substate === 0) {
        return {
          mayMove: false,
          why: 'Hold:0 — stopped, and it resumes only on a cycle start (~). 🔴 The spindle is still turning and the tool is still in the cut.',
          positionGuaranteed: true,
        };
      }
      if (substate === 1) {
        return {
          mayMove: true,
          why: 'Hold:1 — still decelerating. It has not stopped yet.',
          positionGuaranteed: true,
        };
      }
      /* JUDGEMENT (the design does not cover a substate-less `Hold`): grblHAL
       * always sends one (`report.c:1228`), so its absence means we are talking
       * to something that is not what we think. Treated as MAY MOVE, because
       * being wrong in that direction costs a needless warning and being wrong
       * in the other direction says "stopped" about a decelerating gantry. */
      return {
        mayMove: true,
        why: 'Hold with no substate — this controller did not say whether it has finished decelerating. Treated as still moving.',
        positionGuaranteed: true,
      };
    case 'Jog':
      return {
        mayMove: true,
        why: 'Jog — a queued jog is still running.',
        positionGuaranteed: true,
      };
    case 'Alarm':
      return {
        mayMove: false,
        why: 'Alarm — motion is locked out. Position may or may not be trusted; that is the alarm code’s question, not the state’s.',
        positionGuaranteed: true,
      };
    case 'Door':
      if (substate === 2 || substate === 3) {
        return {
          mayMove: true,
          why: `Door:${substate} — a parking retract/restore motion is running.`,
          positionGuaranteed: true,
        };
      }
      if (substate === 0 || substate === 1) {
        return {
          mayMove: false,
          why: `Door:${substate} — stopped at the door state.`,
          positionGuaranteed: true,
        };
      }
      /* JUDGEMENT, same shape as `Hold` above and for the same reason. */
      return {
        mayMove: true,
        why: 'Door with no substate — the parking state was not reported. Treated as still moving.',
        positionGuaranteed: true,
      };
    case 'Check':
      return {
        mayMove: false,
        why: 'Check — g-code is parsed and nothing moves.',
        positionGuaranteed: true,
      };
    case 'Home':
      return {
        mayMove: true,
        why: 'Home — the homing cycle is running. Expect no status reports during it ($10 bit 12 is off by default).',
        positionGuaranteed: false,
      };
    case 'Sleep':
      return {
        mayMove: false,
        why: 'Sleep — the steppers are disabled, so the gantry can be moved by hand and the controller will not know. Position is NOT guaranteed.',
        positionGuaranteed: false,
      };
    case 'Tool':
      return {
        mayMove: false,
        why: 'Tool — waiting for a tool-change acknowledge (0xA3). ⚠ Our post emits M0, never M6, so reaching this state means a program from somewhere else is running.',
        positionGuaranteed: true,
      };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE DRO — MPos, WPos, WCO
   ═══════════════════════════════════════════════════════════════════════════ */

export interface DroAxisSet {
  /** `null` means "cannot be derived", never "zero". */
  values: number[] | null;
  /** Why it cannot be derived, in words an operator can act on. Rendered
   *  instead of the numbers — never beside a zero. */
  unavailable: string | null;
}

export interface Dro {
  machine: DroAxisSet;
  work: DroAxisSet;
  wco: number[] | null;
  wcs: string | null;
  /** Which key the controller actually sent. The branch below is keyed on this
   *  and on nothing else. */
  positionKind: PositionKind;
}

/**
 * Why the work DRO has no numbers, in the form the operator can act on.
 *
 * 🔴 **`0x87` CANNOT force a `WCO` when `$10` bit 5 is clear, and this string
 * used to tell the operator to press it anyway.** `report.c:1419` gates the
 * **entire** `|WCO:` path on `settings.status_report.work_coord_offset`; the
 * full-report flag (`report->flags.all`, which is what `0x87` sets) is only
 * consulted **inside** that gate, at `report.c:1420`. So under `$10=1` the
 * operator presses the button, nothing changes, and — until 2026-08-11 — the
 * message still said to press it. The doc comment on {@link deriveDro} twenty
 * lines below already knew this; *the string a human actually reads did not*,
 * which is the whole lesson: a caveat in a comment does not reach the person
 * standing at the machine.
 *
 * Three states, and the difference between them is not cosmetic — one is a
 * wait, one is a controller setting that has to change, and one is *"this tab
 * does not know which"*.
 *
 * @param mask the decoded `$10`, or `null`/omitted when `$$` has not been read.
 */
export function wcoUnavailable(mask?: ReportMask | null): string {
  const head = 'the controller has not reported WCO yet';
  if (mask && !mask.workCoordinateOffset) {
    return (
      `Set $10 bit 5 at the controller (type $10=511 in the console below). Without it, ${head}, ` +
      'and it never will: report.c:1419 gates the whole |WCO: element on that bit — 0x87 (full ' +
      'report) cannot force it. The work DRO is not derivable at all until $10 bit 5 is set; this ' +
      `tab does not write settings. ($10=${mask.value} on this controller.)`
    );
  }
  if (mask) {
    return (
      `${head} — it is a change-only element and $10 bit 5 is set ($10=${mask.value}), so it can ` +
      'be up to 30 reports away (REPORT_WCO_REFRESH_BUSY_COUNT 30, config.h:240). ' +
      'Send 0x87 (full report) to force one.'
    );
  }
  /* ⚠ This arm must not assert WHY the mask is absent. It is reached whenever
   * the caller did not pass one — which includes a tab that has read $$ and
   * simply did not thread it through — so a sentence like "$$ has not been
   * read" would be a claim this function cannot check, printed at an operator.
   * State what is not known here, and the action; not the cause. */
  return (
    `${head}, and $10 has not been given to this readout, so it cannot say which of the two ` +
    'cases you are in. If $10 bit 5 is SET, WCO is change-only and up to 30 reports away and ' +
    '0x87 (full report) forces one. If it is CLEAR, no WCO will ever arrive and 0x87 CANNOT ' +
    'force it (report.c:1419). Read $10 (via $$) to find out which.'
  );
}


/**
 * Machine and work position from one report plus the last `WCO` seen.
 *
 * `WPos = MPos - WCO`, and grblHAL folds the G54/G92/tool-length terms into that
 * one `WCO` (`gcode.c:2951`, `report.c:1274-1280`). Three ways this goes wrong,
 * all silent, all handled here and all exercised in both directions by the
 * tests:
 *
 * 1. **`WCO` has not arrived.** Under `$10=1` it never will. Computing with
 *    `WCO = 0` displays machine coordinates in a box labelled work, and on a
 *    homed router those differ by the whole table. ⇒ `—` and the reason. **A
 *    zero is a number and reads as a measurement.**
 * 2. **The controller is sending `WPos`.** The offset is already applied.
 *    Subtracting `WCO` again displaces the DRO by the entire offset.
 * 3. **Axis counts disagree** between the position and the last `WCO`. That is a
 *    report from a machine whose axis configuration changed under us; it refuses
 *    rather than truncating.
 *
 * @param lastWco the most recent `WCO` received on this connection, or `null`.
 * @param plant `'assume-zero-wco'` / `'double-subtract-wco'`.
 * @param mask the decoded `$10`, when `$$` has been read. It changes only the
 * WORDS of the refusal, never the numbers — but the words are the difference
 * between *"wait"* and *"0x87 will not help you, change the setting"*, and
 * getting that wrong sends an operator to press a button that cannot work
 * ({@link wcoUnavailable}). Omitted ⇒ the honest both-cases sentence.
 */
export function deriveDro(
  report: StatusReport,
  lastWco: number[] | null,
  plant?: ProtocolPlant,
  mask?: ReportMask | null,
): Dro {
  const WCO_NEVER_ARRIVED = wcoUnavailable(mask);
  const kind = report.positionKind;
  const pos = report.position;
  if (!kind || !pos) {
    /* `parseStatusReport` refuses a report with no position, so this is
     * unreachable through the parser and is kept as a total function. */
    return {
      machine: { values: null, unavailable: 'the report carried no position' },
      work: { values: null, unavailable: 'the report carried no position' },
      wco: lastWco,
      wcs: report.wcs,
      positionKind: 'MPos',
    };
  }
  const wco = report.wco ?? lastWco;
  const mismatch =
    wco !== null && wco.length !== pos.length
      ? `the report has ${pos.length} axes and the last WCO had ${wco.length} — refusing to pair them`
      : null;

  const sub = (a: number[], b: number[]) => a.map((v, i) => round3(v - b[i]));
  const add = (a: number[], b: number[]) => a.map((v, i) => round3(v + b[i]));

  if (kind === 'MPos') {
    const machine: DroAxisSet = { values: pos.map(round3), unavailable: null };
    if (plant === 'assume-zero-wco' && !wco) {
      return {
        machine,
        work: { values: pos.map(round3), unavailable: null },
        wco,
        wcs: report.wcs,
        positionKind: kind,
      };
    }
    if (mismatch) {
      return {
        machine,
        work: { values: null, unavailable: mismatch },
        wco,
        wcs: report.wcs,
        positionKind: kind,
      };
    }
    return {
      machine,
      work: wco
        ? { values: sub(pos, wco), unavailable: null }
        : { values: null, unavailable: WCO_NEVER_ARRIVED },
      wco,
      wcs: report.wcs,
      positionKind: kind,
    };
  }

  // kind === 'WPos' — the offset is ALREADY APPLIED.
  if (plant === 'double-subtract-wco') {
    const zeros = pos.map(() => 0);
    return {
      machine: wco
        ? { values: add(pos, wco), unavailable: null }
        : { values: null, unavailable: WCO_NEVER_ARRIVED },
      work: { values: sub(pos, wco ?? zeros), unavailable: null },
      wco,
      wcs: report.wcs,
      positionKind: kind,
    };
  }
  const work: DroAxisSet = { values: pos.map(round3), unavailable: null };
  if (mismatch) {
    return { machine: { values: null, unavailable: mismatch }, work, wco, wcs: report.wcs, positionKind: kind };
  }
  return {
    machine: wco
      ? { values: add(pos, wco), unavailable: null }
      : { values: null, unavailable: WCO_NEVER_ARRIVED },
    work,
    wco,
    wcs: report.wcs,
    positionKind: kind,
  };
}

/** Three decimals is the DRO's resolution (design §13); doing it here keeps
 *  `-0` and float dust out of a comparison that decides whether a rapid goes
 *  down into the work. */
function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/* ═══════════════════════════════════════════════════════════════════════════
   $10 AND $22 — the settings that change how everything else reads
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * `$10`, the status report mask. **Fourteen bits in grblHAL, two in grbl v1.1**
 * (`settings.h:637-656`). grbl ships `$10=1`; grblHAL's compiled default sets
 * bits 0–8, i.e. `$10=511`.
 *
 * Bit 0 is the one that inverts the DRO: **set = `MPos:`**, clear = `WPos:`.
 */
export interface ReportMask {
  value: number;
  /** bit 0 — set means positions arrive as `MPos`. */
  positionIsMachine: boolean;
  /** bit 1 */ bufferState: boolean;
  /** bit 2 */ lineNumbers: boolean;
  /** bit 3 */ feedAndSpeed: boolean;
  /** bit 4 */ pinState: boolean;
  /** bit 5 */ workCoordinateOffset: boolean;
  /** bit 6 */ overrides: boolean;
  /** bit 7 */ probeCoordinates: boolean;
  /** bit 8 */ syncOnWcoChange: boolean;
  /** bit 9 */ parserState: boolean;
  /** bit 10 */ alarmSubstate: boolean;
  /** bit 11 */ runSubstate: boolean;
  /** bit 12 */ reportWhileHoming: boolean;
  /** bit 13 */ distanceToGo: boolean;
}

export function decodeReportMask(value: number): ReportMask {
  const bit = (n: number) => (value & (1 << n)) !== 0;
  return {
    value,
    positionIsMachine: bit(0),
    bufferState: bit(1),
    lineNumbers: bit(2),
    feedAndSpeed: bit(3),
    pinState: bit(4),
    workCoordinateOffset: bit(5),
    overrides: bit(6),
    probeCoordinates: bit(7),
    syncOnWcoChange: bit(8),
    parserState: bit(9),
    alarmSubstate: bit(10),
    runSubstate: bit(11),
    reportWhileHoming: bit(12),
    distanceToGo: bit(13),
  };
}

/**
 * What the tab renders where a field cannot arrive.
 *
 * "Buffer: not reported (`$10` bit 1 clear)" is a true statement; an empty box
 * is not, and a zero is worse than either (design §4).
 */
export function missingFieldNote(
  field: 'Bf' | 'FS' | 'Ov' | 'WCO' | 'Ln' | 'Pn' | 'DTG',
  mask: ReportMask,
): string | null {
  const say = (bit: number, what: string) =>
    `${what} is not reported — $10 bit ${bit} is clear (this controller reports $10=${mask.value}). ` +
    `Set it at the controller if you want it; this tab does not write settings.`;
  switch (field) {
    case 'Bf':
      return mask.bufferState ? null : say(1, 'buffer state');
    case 'Ln':
      return mask.lineNumbers ? null : say(2, 'the executing line number');
    case 'FS':
      return mask.feedAndSpeed ? null : say(3, 'feed and speed');
    case 'Pn':
      return mask.pinState ? null : say(4, 'input pin state');
    case 'WCO':
      return mask.workCoordinateOffset
        ? null
        : say(5, 'the work coordinate offset — so the work DRO is not derivable at all');
    case 'Ov':
      return mask.overrides
        ? null
        : say(6, 'override readback — the override buttons would be asserting a state they cannot see');
    case 'DTG':
      return mask.distanceToGo ? null : say(13, 'distance to go');
  }
}

/**
 * `$22` is a bitfield in grblHAL, not a boolean (`settings.h:693-709`).
 *
 * Bit 2 (`init_lock`) and bit 6 (`override_locks`) are the two that decide
 * whether the controller enforces homing at all — and **bit 6 means a soft reset
 * drops the lock** (design §10). That is exactly why the tab tracks homing
 * itself (R1) instead of reading "not in Alarm" as "homed".
 */
export interface HomingConfig {
  value: number;
  enabled: boolean;
  singleAxisCommands: boolean;
  initLock: boolean;
  forceSetOrigin: boolean;
  twoSwitches: boolean;
  manual: boolean;
  overrideLocks: boolean;
  keepOnReset: boolean;
  useLimitSwitches: boolean;
  perAxisFeedrates: boolean;
  nxScriptsOnHomedOnly: boolean;
}

export function decodeHomingConfig(value: number): HomingConfig {
  const bit = (n: number) => (value & (1 << n)) !== 0;
  return {
    value,
    enabled: bit(0),
    singleAxisCommands: bit(1),
    initLock: bit(2),
    forceSetOrigin: bit(3),
    twoSwitches: bit(4),
    manual: bit(5),
    overrideLocks: bit(6),
    keepOnReset: bit(7),
    useLimitSwitches: bit(8),
    perAxisFeedrates: bit(9),
    nxScriptsOnHomedOnly: bit(10),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   REALTIME COMMANDS — one byte, and it must go out as one byte
   ═══════════════════════════════════════════════════════════════════════════ */

export type RealtimeName =
  | 'reset'
  | 'statusReport'
  | 'statusReportAll'
  | 'cycleStart'
  | 'feedHold'
  | 'gcodeReport'
  | 'safetyDoor'
  | 'jogCancel'
  | 'optionalStopToggle'
  | 'singleBlockToggle'
  | 'autoReportingToggle'
  | 'feedOverrideReset'
  | 'feedOverridePlus10'
  | 'feedOverrideMinus10'
  | 'feedOverridePlus1'
  | 'feedOverrideMinus1'
  | 'rapidOverride100'
  | 'rapidOverride50'
  | 'rapidOverride25'
  | 'spindleOverrideReset'
  | 'spindleOverridePlus10'
  | 'spindleOverrideMinus10'
  | 'spindleOverridePlus1'
  | 'spindleOverrideMinus1'
  | 'spindleStop'
  | 'floodToggle'
  | 'mistToggle'
  | 'toolAck';

export interface RealtimeCommand {
  name: RealtimeName;
  byte: number;
  /**
   * grblHAL's own identifier for **this byte**, so a controller fact can be
   * grepped both ways.
   *
   * 🔴 **It must name the constant the byte actually is.** grblHAL defines two
   * encodings for status-report / cycle-start / feed-hold, and until 2026-08-11
   * three rows here paired the LEGACY bytes (`0x3f`/`0x7e`/`0x21`) with the
   * NON-LEGACY names (`CMD_STATUS_REPORT`/`CMD_CYCLE_START`/`CMD_FEED_HOLD`).
   * The bytes on the wire were right the whole time — a grbl sender does send
   * `?`/`~`/`!` — so nothing misbehaved and nothing could: **the defect was
   * entirely in what a reader would conclude.** A reader who grepped grblHAL
   * for `CMD_STATUS_REPORT` landed on `0x80`, found the `$481` guard that
   * belongs to `0x80`, and attributed it to `?`. That is exactly what happened
   * (#121), and it is why this field is a claim about the byte and not a label
   * for the button.
   */
  id: string;
  /** `null` = any state. Otherwise the ONLY states in which sending it is
   *  permitted; sending it elsewhere is either silently ignored (which is worse
   *  than a greyed control) or destructive. */
  allowedIn: MachineState[] | null;
  note: string;
}

/**
 * The realtime table, from `grblHAL/core/grbl.h:103-157`.
 *
 * 🔴 Taken from grblHAL, not from a range. **`0x98` does not exist** — grblHAL
 * carries it commented out as `*NOT SUPPORTED*` — and the spindle set runs to
 * `0x9E`, not `0x9A`. A brief that said "`0x90`–`0x9A`" was short at both ends.
 *
 * ⚠ **This table is what this tab SENDS. It is not the set of realtime bytes
 * grblHAL has**, and the difference is stated rather than left to be inferred
 * from an absence: {@link NOT_IMPLEMENTED_REALTIME} carries the bytes that look
 * like commands and do nothing, and {@link EXCLUDED_REALTIME} carries the ones
 * grblHAL really implements that this tab deliberately does not offer, with the
 * reason. **A byte in none of the three lists is an omission nobody decided.**
 */
export const REALTIME: Record<RealtimeName, RealtimeCommand> = {
  reset: {
    name: 'reset',
    byte: 0x18,
    id: 'CMD_RESET',
    allowedIn: null,
    note: '🔴 Not a stop button. If the machine is MOVING this kills the steppers with no deceleration, sets sys.position_lost and raises ALARM:3 (motion_control.c:1170-1204). If it is stationary, position is retained and no alarm is raised.',
  },
  statusReport: {
    name: 'statusReport',
    byte: 0x3f,
    id: 'CMD_STATUS_REPORT_LEGACY',
    allowedIn: null,
    note:
      'Queues one report. 🔴 This is the LEGACY byte and it is NOT the one $481 gates: the auto-reporting guard sits on the non-legacy 0x80 branch only (protocol.c:871-876), while `?` is picked off in a separate switch (protocol.c:987-992) with no such guard — so `?` IS answered while auto-reporting is on. ' +
      'The link watchdog must still be "a report arrived", never "my ? was answered": auto-reports and change-driven reports arrive unbidden, so no report can be attributed to a particular `?`, and under $39=0 a `?` that lands inside a comment or a $-line is swallowed as data (see legacyRealtimeReliability).',
  },
  statusReportAll: {
    name: 'statusReportAll',
    byte: 0x87,
    id: 'CMD_STATUS_REPORT_ALL',
    allowedIn: null,
    note: '⚠ REQUIRED, not optional. WCO, Ov and H are change-only; a client that only sends ? may wait 30 reports for a WCO and may never see H at all. Also the only request that appends FW:grblHAL.',
  },
  cycleStart: {
    name: 'cycleStart',
    byte: 0x7e,
    id: 'CMD_CYCLE_START_LEGACY',
    allowedIn: null,
    note: 'Resume. Only means anything in Hold / Door / Tool. Never enabled in Alarm — there is nothing to resume. ⚠ LEGACY byte (grbl.h:108); the non-legacy CMD_CYCLE_START is 0x81 (grbl.h:116) and is subject to $39 differently — see legacyRealtimeReliability.',
  },
  feedHold: {
    name: 'feedHold',
    byte: 0x21,
    id: 'CMD_FEED_HOLD_LEGACY',
    allowedIn: null,
    note: '🔴 Controlled decel to Hold. DOES NOT STOP THE SPINDLE — only the parking/door path calls spindle_all_off (state_machine.c:116). A hold leaves a turning cutter in the work. ⚠ LEGACY byte (grbl.h:109); the non-legacy CMD_FEED_HOLD is 0x82 (grbl.h:117) and is subject to $39 differently — see legacyRealtimeReliability.',
  },
  gcodeReport: {
    name: 'gcodeReport',
    byte: 0x83,
    id: 'CMD_GCODE_REPORT',
    allowedIn: null,
    note: 'Same as $G.',
  },
  safetyDoor: {
    name: 'safetyDoor',
    byte: 0x84,
    id: 'CMD_SAFETY_DOOR',
    allowedIn: null,
    note: '⚠ Forces the door state. NOT a stop button, and must never be offered as one.',
  },
  jogCancel: {
    name: 'jogCancel',
    byte: 0x85,
    id: 'CMD_JOG_CANCEL',
    allowedIn: ['Jog'],
    note: '🔴 Jog only. It sets char_counter = 0 and calls hal.stream.cancel_read_buffer() (protocol.c:894-897) — it FLUSHES the RX buffer, so sending it mid-stream discards queued g-code AND desynchronises the character count from the controller.',
  },
  optionalStopToggle: {
    name: 'optionalStopToggle',
    byte: 0x88,
    id: 'CMD_OPTIONAL_STOP_TOGGLE',
    allowedIn: null,
    note: '',
  },
  singleBlockToggle: {
    name: 'singleBlockToggle',
    byte: 0x89,
    id: 'CMD_SINGLE_BLOCK_TOGGLE',
    allowedIn: null,
    note: '',
  },
  autoReportingToggle: {
    name: 'autoReportingToggle',
    byte: 0x8c,
    id: 'CMD_AUTO_REPORTING_TOGGLE',
    allowedIn: null,
    note: 'Only acts if $481 != 0 (protocol.c:936-939).',
  },
  feedOverrideReset: {
    name: 'feedOverrideReset',
    byte: 0x90,
    id: 'CMD_OVERRIDE_FEED_RESET',
    allowedIn: null,
    note: 'Feed override → 100%. Range 10–200% (grbl.h:189-212).',
  },
  feedOverridePlus10: {
    name: 'feedOverridePlus10',
    byte: 0x91,
    id: 'CMD_OVERRIDE_FEED_COARSE_PLUS',
    allowedIn: null,
    note: '+10%.',
  },
  feedOverrideMinus10: {
    name: 'feedOverrideMinus10',
    byte: 0x92,
    id: 'CMD_OVERRIDE_FEED_COARSE_MINUS',
    allowedIn: null,
    note: '−10%.',
  },
  feedOverridePlus1: {
    name: 'feedOverridePlus1',
    byte: 0x93,
    id: 'CMD_OVERRIDE_FEED_FINE_PLUS',
    allowedIn: null,
    note: '+1%.',
  },
  feedOverrideMinus1: {
    name: 'feedOverrideMinus1',
    byte: 0x94,
    id: 'CMD_OVERRIDE_FEED_FINE_MINUS',
    allowedIn: null,
    note: '−1%.',
  },
  rapidOverride100: {
    name: 'rapidOverride100',
    byte: 0x95,
    id: 'CMD_OVERRIDE_RAPID_RESET',
    allowedIn: null,
    note: '🔴 Rapid override has THREE POSITIONS ONLY — 100 / 50 / 25. It is not a slider.',
  },
  rapidOverride50: {
    name: 'rapidOverride50',
    byte: 0x96,
    id: 'CMD_OVERRIDE_RAPID_MEDIUM',
    allowedIn: null,
    note: '50%.',
  },
  rapidOverride25: {
    name: 'rapidOverride25',
    byte: 0x97,
    id: 'CMD_OVERRIDE_RAPID_LOW',
    allowedIn: null,
    note: '25%. 🔴 There is no 0x98 — see NOT_IMPLEMENTED_REALTIME.',
  },
  spindleOverrideReset: {
    name: 'spindleOverrideReset',
    byte: 0x99,
    id: 'CMD_OVERRIDE_SPINDLE_RESET',
    allowedIn: null,
    note: 'Spindle override → 100%. Range 10–200%. ⚠ Meaningless with no spindle PWM — grey the control and say the VFD dial is the only speed control.',
  },
  spindleOverridePlus10: {
    name: 'spindleOverridePlus10',
    byte: 0x9a,
    id: 'CMD_OVERRIDE_SPINDLE_COARSE_PLUS',
    allowedIn: null,
    note: '+10%.',
  },
  spindleOverrideMinus10: {
    name: 'spindleOverrideMinus10',
    byte: 0x9b,
    id: 'CMD_OVERRIDE_SPINDLE_COARSE_MINUS',
    allowedIn: null,
    note: '−10%.',
  },
  spindleOverridePlus1: {
    name: 'spindleOverridePlus1',
    byte: 0x9c,
    id: 'CMD_OVERRIDE_SPINDLE_FINE_PLUS',
    allowedIn: null,
    note: '+1%.',
  },
  spindleOverrideMinus1: {
    name: 'spindleOverrideMinus1',
    byte: 0x9d,
    id: 'CMD_OVERRIDE_SPINDLE_FINE_MINUS',
    allowedIn: null,
    note: '−1%.',
  },
  spindleStop: {
    name: 'spindleStop',
    byte: 0x9e,
    id: 'CMD_OVERRIDE_SPINDLE_STOP',
    allowedIn: ['Hold'],
    note: '🔴 Hold ONLY — "Spindle stop override allowed only while in HOLD state." (protocol.c:726-727). Elsewhere it is silently ignored, and a control that silently does nothing is worse than one that is greyed out.',
  },
  floodToggle: {
    name: 'floodToggle',
    byte: 0xa0,
    id: 'CMD_OVERRIDE_COOLANT_FLOOD_TOGGLE',
    allowedIn: null,
    note: '',
  },
  mistToggle: {
    name: 'mistToggle',
    byte: 0xa1,
    id: 'CMD_OVERRIDE_COOLANT_MIST_TOGGLE',
    allowedIn: null,
    note: '',
  },
  toolAck: {
    name: 'toolAck',
    byte: 0xa3,
    id: 'CMD_TOOL_ACK',
    allowedIn: ['Tool'],
    note: '⚠ NOT ON OUR PATH. Our post emits M0, not M6, so the machine never enters Tool because of us (design F4/§9).',
  },
};

/**
 * Bytes that look like realtime commands and are not.
 *
 * Listed rather than omitted, because "it does nothing" is a fact somebody will
 * otherwise rediscover by shipping a button for it.
 *
 * 🔴 **Until 2026-08-11 this held `0x98` alone, and the gap was invisible
 * because an absence looks identical whether it was decided or forgotten.**
 * `0x86` in particular sits **between** `0x85` and `0x87` — two bytes this tab
 * ships — so the run of contiguous commands reads as complete, and a reader
 * filling the hole would ship a debug-report button that does nothing on every
 * build we will ever flash.
 */
export const NOT_IMPLEMENTED_REALTIME: Record<number, string> = {
  0x86:
    '0x86 (CMD_DEBUG_REPORT) is COMMENTED OUT in grblHAL: ' +
    '"//#define CMD_DEBUG_REPORT 0x86 // Only when DEBUG enabled, sends debug report in \'{}\' braces." ' +
    '(grbl.h:121). ⚠ It sits BETWEEN 0x85 (jog cancel) and 0x87 (full report), both of which this ' +
    'tab sends — so the numbering looks unbroken and it is not. On a build without DEBUG the ' +
    'controller receives an unrecognised byte and does nothing.',
  0x8a:
    '0x8A (CMD_OVERRIDE_FAN0_TOGGLE) is DEFINED but, in grblHAL\'s own words, ' +
    '"not implemented by the core" (grbl.h:125). A defined constant with no handler is the ' +
    'shape most likely to be shipped as a working button: it greps, it has a name, and it does ' +
    'nothing. Fan control on this table is a VFD/extraction question, not a controller one.',
  0x98:
    '0x98 (CMD_OVERRIDE_RAPID_EXTRA_LOW) is COMMENTED OUT in grblHAL: ' +
    '"// #define CMD_OVERRIDE_RAPID_EXTRA_LOW 0x98 // *NOT SUPPORTED*" (grbl.h:136). ' +
    'The controller receives an unrecognised byte and does nothing.',
};

/**
 * Realtime bytes grblHAL **really implements** that this tab deliberately does
 * not send — with the reason, because *"we do not send it"* and *"nobody
 * thought about it"* are indistinguishable from an empty table.
 *
 * 🔴 **These two are the ones a CNC sender reaches for**, which is precisely
 * why leaving them unstated was the risk: a future reader wanting a Stop button
 * finds `CMD_STOP` in `grbl.h`, finds nothing about it here, and reads the
 * silence as "not looked at yet" — when in fact each one has a specific,
 * checkable consequence for a sender that is character-counting a job.
 */
export const EXCLUDED_REALTIME: Record<number, string> = {
  0x03:
    '0x03 (CMD_EXIT, ctrl-C) calls mc_reset() and sets sys.flags.exit (protocol.c:858-862). ' +
    'Two reasons it is not offered. (1) It is a SOFT RESET with extra consequences, so on a ' +
    'moving machine it costs position exactly as 0x18 does — and this tab already offers 0x18 ' +
    'behind a two-press confirmation that quotes grblHAL\'s own ALARM:3 sentence. A second, ' +
    'unconfirmed door to the same outcome defeats that confirmation. (2) It is compiled out ' +
    'unless COMPATIBILITY_LEVEL == 0 (protocol.c:857-863; config.h:97 defaults to 0, but a ' +
    'board map may not) — so it is a control that silently does nothing on some builds, which ' +
    'is the failure mode this table exists to refuse.',
  0x19:
    '0x19 (CMD_STOP, ctrl-Y) is the closest thing grblHAL has to the Stop button a router ' +
    'operator expects: it cancels motion via EXEC_MOTION_CANCEL_FAST (protocol.c:575), KILLS THE ' +
    'SPINDLE AND COOLANT (gc_spindle_off / gc_coolant, protocol.c:592-593), resets the planner ' +
    'and returns to Idle with [MSG:Stop] (protocol.c:598-599) — everything 0x21 (feed hold) does ' +
    'not do. It is not offered anyway, for three reasons that are all about the sender rather ' +
    'than the machine. (1) grblHAL marks the whole handler "Experimental for now, must be ' +
    'verified" in its own comment (protocol.c:548), and this lane does not build a safety control ' +
    'on an upstream experiment it cannot test on a board. (2) It FLUSHES the RX buffer ' +
    '(hal.stream.cancel_read_buffer, protocol.c:565) and zeroes char_counter (protocol.c:846), so ' +
    'mid-stream it desynchronises character counting exactly as 0x85 does — see refusal R7 for ' +
    'the same failure with the same cause. (3) Its position consequence is CONDITIONAL, which is ' +
    'worse for a UI than a flat "costs position": sys.position_lost is set only where an alarm ' +
    'was already pending AND the steppers were still stepping (protocol.c:569-571); the ordinary ' +
    'path is a controlled fast cancel that retains position. A stop whose position cost depends ' +
    'on controller state the operator cannot see needs the reply read back, not a fixed label. ' +
    '⚠ If it is ever offered, it belongs behind the SAME confirmation as 0x18, must abort the ' +
    'stream rather than pause it, and must take its position verdict from the report that ' +
    'follows — route the "should we?" to a run on a real board first.',
};

/* ───────────────────────────────────────────────────────────────────────────
 * `$39`, `$481`, and why NEITHER encoding of `?` is unconditional
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The two controller settings that decide whether a status/hold/resume byte
 * does anything. `null` = not read, which is never the same as "off".
 */
export interface LegacyRtConfig {
  /**
   * `$39` — `Setting_EnableLegacyRTCommands` (`settings.h:87`), default **On**
   * (`config.h:812-814`).
   *
   * ⚠ **It does NOT switch `?`/`~`/`!` off.** grblHAL's own description
   * (`settings.c:2551`): *"Enables 'normal' processing of ?, ! and ~ characters
   * when part of $-setting or comment. If disabled then they are added to the
   * input string instead."* The guard is
   * `if(!keep_rt_commands || settings.flags.legacy_rt_commands)`
   * (`protocol.c:988`), and `keep_rt_commands` is set only while a line that
   * began with `$` or `[` is being received, or inside a `(…)` comment
   * (`protocol.c:297-305`, `protocol.c:841`). So with `$39=0` the byte still
   * works from an idle prompt and is swallowed **as data** mid-comment or
   * mid-`$`-line.
   */
  legacyRtCommands: boolean | null;
  /**
   * Whether the controller is auto-reporting **right now**. Read it from `AR:`
   * in a full report ({@link StatusReport.autoReporting}); do not infer it from
   * `$481`, which only says an interval is configured — `0x8C` toggles the flag
   * independently (`protocol.c:936-939`).
   */
  autoReporting: boolean | null;
}

export interface RealtimeReliability {
  byte: number;
  id: string;
  /** Whether the controller takes the byte out of the g-code stream at all. */
  pickedOff: 'always' | 'not-in-comments-or-$-lines' | 'unknown';
  /** Having been picked off, whether it acts. */
  acts: 'always' | 'not-while-auto-reporting' | 'unknown';
  why: string;
}

/**
 * 🔴 **The fork this function exists to make visible, NOT to settle.**
 *
 * This tab sends the legacy bytes (`?` `~` `!`) and nothing else. Whether it
 * should ALSO send `0x80`/`0x81`/`0x82` is a design decision that belongs to a
 * human with a board in front of them, so it is modelled here and left open.
 *
 * The two encodings fail in **opposite** directions and neither is
 * unconditional:
 *
 *  - **legacy `?`** is picked off in the second switch (`protocol.c:987-992`)
 *    with **no auto-reporting guard**, so it is answered even while the
 *    controller is auto-reporting — but under `$39=0` it is **passed through as
 *    data** inside a comment or a `$` line.
 *  - **non-legacy `0x80`** is picked off in the first switch
 *    (`protocol.c:871-876`) **unconditionally** — it can never become data —
 *    but it is **ignored while auto-reporting is on** (`protocol.c:873`).
 *
 * 🔴 **The dependency is on OUR OWN OUTPUT, which is what makes it more than
 * trivia.** Every program this post emits opens with a block of `( … )`
 * comments and puts one before each operation. A `?` written while the
 * controller is receiving one of those lines is inside a comment by
 * construction — so on a machine that arrives with `$39=0`, the polls this tab
 * loses are not random, they cluster exactly where our own comments are.
 *
 * **What sending both would cost, measured at the source rather than guessed:**
 * the effect of each is an atomic **bit-set** on `sys.rt_exec_state`
 * (`system.h:340`), not an entry on a queue. Two status requests arriving
 * before the realtime executor next runs therefore coalesce into **one**
 * report; where the executor runs between them, it is one extra report. Cycle
 * start and feed hold are idempotent in the same way. So the honest cost is
 * **one extra byte per press, and occasionally one extra report** — not double
 * traffic.
 *
 * **What it would cost that is not bandwidth**, and the reason this is not a
 * one-line change: the console transcript and `realtimeEcho` currently render
 * *one button, one byte* — `[0x21 CMD_FEED_HOLD_LEGACY]`. A two-byte press
 * needs the echo, the plant `'utf8-realtime'` (which asserts **exactly one**
 * byte reaches the link) and RUN-4's assertion all to change together, and a
 * half-done version of that produces a transcript that no longer matches the
 * wire — which is the one property this tab's transcript exists to have.
 *
 * ⚠ **And it cannot be settled here.** `$39=0` is not the default, this lane
 * has never seen a board, and nothing in `gates/controller/` records what a
 * real SKR Pro arrives configured as. Route the decision with the measurement:
 * read `$39` and `$481` off the machine first.
 */
export function legacyRealtimeReliability(
  which: 'statusReport' | 'cycleStart' | 'feedHold',
  cfg: LegacyRtConfig,
): { legacy: RealtimeReliability; nonLegacy: RealtimeReliability } {
  const legacyByte = { statusReport: 0x3f, cycleStart: 0x7e, feedHold: 0x21 }[which];
  const legacyId = {
    statusReport: 'CMD_STATUS_REPORT_LEGACY',
    cycleStart: 'CMD_CYCLE_START_LEGACY',
    feedHold: 'CMD_FEED_HOLD_LEGACY',
  }[which];
  const nonLegacyByte = { statusReport: 0x80, cycleStart: 0x81, feedHold: 0x82 }[which];
  const nonLegacyId = {
    statusReport: 'CMD_STATUS_REPORT',
    cycleStart: 'CMD_CYCLE_START',
    feedHold: 'CMD_FEED_HOLD',
  }[which];

  const pickedOff: RealtimeReliability['pickedOff'] =
    cfg.legacyRtCommands === null
      ? 'unknown'
      : cfg.legacyRtCommands
        ? 'always'
        : 'not-in-comments-or-$-lines';

  const legacy: RealtimeReliability = {
    byte: legacyByte,
    id: legacyId,
    pickedOff,
    /* 🔴 'always', for ALL THREE — the $481/auto-reporting guard is on the
     * non-legacy branch only. This lane asserted the opposite about `?` until
     * 2026-08-11, having read the guard that belongs to 0x80. */
    acts: 'always',
    why:
      pickedOff === 'always'
        ? 'picked off unconditionally ($39 is On) and acted on with no further guard — including while auto-reporting is on (protocol.c:987-992).'
        : pickedOff === 'not-in-comments-or-$-lines'
          ? '$39=0 on this controller: inside a ( … ) comment or a $-line this byte is NOT picked off — it is appended to the g-code line as data (protocol.c:988). Everywhere else it acts, with no auto-reporting guard.'
          : '$$ has not been read, so $39 is unknown. If it is 0, this byte is swallowed as data inside comments and $-lines — and every program this post emits contains comments.',
  };

  const nonLegacy: RealtimeReliability = {
    byte: nonLegacyByte,
    id: nonLegacyId,
    /* The first switch consumes 0x80–0x82 whatever the line state, and $39 does
     * not reach it (protocol.c:871-885). ⚠ 0x81 is the one that does not set
     * `drop` in its own arm — it sets `signals.cycle_start = On`, and the
     * signal block at protocol.c:1017-1021 sets `drop` there instead. It is
     * still unconditional; it is just unconditional two switches later, which
     * is exactly the kind of thing a reader concludes the opposite of. */
    pickedOff: 'always',
    acts:
      which !== 'statusReport'
        ? 'always'
        : cfg.autoReporting === null
          ? 'unknown'
          : cfg.autoReporting
            ? 'not-while-auto-reporting'
            : 'always',
    why:
      which !== 'statusReport'
        ? 'always picked off and always acted on; $39 does not reach the non-legacy branch (protocol.c:878-885, cycle start dropped at 1017-1021).'
        : cfg.autoReporting === true
          ? 'always picked off, but SILENTLY IGNORED right now: the controller is auto-reporting and protocol.c:873 gates this branch on !sys.flags.auto_reporting. The legacy `?` is not gated and would be answered.'
          : cfg.autoReporting === false
            ? 'always picked off and acted on — auto-reporting is off (AR in the last full report).'
            : 'always picked off; whether it ACTS depends on auto-reporting, which is not stated in any report seen so far. Request a full report (0x87) and read AR.',
  };

  return { legacy, nonLegacy };
}

/**
 * One realtime command, as the literal single byte.
 *
 * 🔴 **This function exists so that no caller is ever tempted to reach for
 * `TextEncoder`.** Every grblHAL realtime command above `0x7F` lives in
 * 0x80–0xBF (`grbl.h:112-114`), and `new TextEncoder().encode('')`
 * produces **two** bytes, `0xC2 0x90`. The controller then gets a byte it does
 * not know followed by one it does — and the failure presents as "the override
 * button doesn't work sometimes", which is the hardest possible shape to debug.
 *
 * @param plant `'utf8-realtime'` does exactly that, so the test can watch it.
 */
export function realtimeBytes(name: RealtimeName, plant?: ProtocolPlant): Uint8Array {
  const cmd = REALTIME[name];
  if (plant === 'utf8-realtime') {
    return new TextEncoder().encode(String.fromCharCode(cmd.byte));
  }
  return Uint8Array.of(cmd.byte);
}

/** Whether a realtime command may be sent in the current controller state, with
 *  the reason when it may not. `null` = permitted. */
export function realtimeRefusal(name: RealtimeName, state: MachineState): string | null {
  const cmd = REALTIME[name];
  if (cmd.allowedIn === null || cmd.allowedIn.includes(state)) return null;
  return `${cmd.id} (0x${cmd.byte.toString(16)}) is only valid in ${cmd.allowedIn.join('/')}; the machine is ${state}. ${cmd.note}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ALARM TABLE — and which alarms cost you your position
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Whether the controller's idea of where the tool is survived the alarm.
 *
 * 🔴 **This is the safety-bearing field in this file.** R2 keys on it: after
 * `$X`, a `'retained'` alarm may return to a trusted state and everything else
 * must re-home before it may cut.
 */
export type PositionAfterAlarm = 'retained' | 'lost' | 'unknown';

export interface AlarmSpec {
  code: number;
  id: string;
  /** grblHAL's own sentence, verbatim from `alarms.c`. Not a paraphrase: these
   *  sentences are already the right length and already say the dangerous
   *  part, and the confirmation dialog quotes them. */
  text: string;
  position: PositionAfterAlarm;
  /** Why the verdict above is what it is, so a future reader can audit it
   *  without re-reading grblHAL. */
  positionBasis: string;
}

const LOST = 'grblHAL’s own text: "Machine position is likely lost due to sudden halt. Re-homing is highly recommended."';
const RETAINED = 'grblHAL’s own text: "Machine position retained. Alarm may be safely unlocked."';
/* JUDGEMENT — the design settles alarms 1, 2 and 3 from grblHAL's own sentences
 * and says of alarm 2 that it is the one alarm, "and only that one", which may
 * return to a trusted state without re-homing. It does not classify 4–21. So
 * they are `'unknown'`, and `positionTrustAfterAlarm` treats unknown exactly as
 * it treats lost. That is deliberately conservative and it has a real cost: a
 * probe that fails to make contact (ALARM:5) is a routine event, and under this
 * rule it forces a re-home before the next job. The alternative is a UI that
 * decides, on this lane's guess, that a machine whose stop it did not analyse
 * still knows where it is. ⚠ Route the 4–21 classification to `pcb`/the
 * controller source rather than promoting a guess here. */
const UNSTATED =
  'grblHAL’s text for this alarm does not state whether position is retained, and this lane ' +
  'has not read the stop path for it. Treated as NOT retained: re-home before cutting.';

export const ALARMS: ReadonlyMap<number, AlarmSpec> = new Map(
  (
    [
      [1, 'Alarm_HardLimit', 'Hard limit has been triggered. Machine position is likely lost due to sudden halt. Re-homing is highly recommended.', 'lost', LOST],
      [2, 'Alarm_SoftLimit', 'Soft limit alarm. G-code motion target exceeds machine travel. Machine position retained. Alarm may be safely unlocked.', 'retained', RETAINED],
      [3, 'Alarm_AbortCycle', 'Reset/E-stop while in motion. Machine position is likely lost due to sudden halt. Re-homing is highly recommended.', 'lost', LOST],
      [4, 'Alarm_ProbeFailInitial', 'Probe fail. Probe is not in the expected initial state before starting probe cycle.', 'unknown', UNSTATED],
      [5, 'Alarm_ProbeFailContact', 'Probe fail. Probe did not contact the workpiece within the programmed travel for G38.2 and G38.4.', 'unknown', UNSTATED],
      [6, 'Alarm_HomingFailReset', 'Homing fail. The active homing cycle was reset.', 'unknown', UNSTATED],
      [7, 'Alarm_HomingFailDoor', 'Homing fail. Safety door was opened during homing cycle.', 'unknown', UNSTATED],
      [8, 'Alarm_FailPulloff', 'Homing fail. Pull off travel failed to clear limit switch.', 'unknown', UNSTATED],
      [9, 'Alarm_HomingFailApproach', 'Homing fail. Could not find limit switch within search distances.', 'unknown', UNSTATED],
      [10, 'Alarm_EStop', 'EStop asserted. Clear and reset', 'unknown', UNSTATED],
      [11, 'Alarm_HomingRequired', 'Homing required. Execute homing command ($H) to continue.', 'unknown', UNSTATED],
      [12, 'Alarm_LimitsEngaged', 'Limit switch engaged. Clear before continuing.', 'unknown', UNSTATED],
      [13, 'Alarm_ProbeProtect', 'Probe protection triggered. Clear before continuing.', 'unknown', UNSTATED],
      [14, 'Alarm_Spindle', 'Spindle at speed timeout. Clear before continuing.', 'unknown', UNSTATED],
      [15, 'Alarm_HomingFailAutoSquaringApproach', 'Homing fail. Could not find second limit switch for auto squared axis.', 'unknown', UNSTATED],
      [16, 'Alarm_SelftestFailed', 'Power on selftest (POS) failed.', 'unknown', UNSTATED],
      [17, 'Alarm_MotorFault', 'Motor fault.', 'unknown', UNSTATED],
      [18, 'Alarm_HomingFail', 'Homing fail. Bad configuration.', 'unknown', UNSTATED],
      [19, 'Alarm_ModbusException', 'Modbus exception. Timeout or message error.', 'unknown', UNSTATED],
      [20, 'Alarm_ExpanderException', 'I/O expander communication failed.', 'unknown', UNSTATED],
      [21, 'Alarm_NVS_Failed', 'Non Volatile Storage (EEPROM) failure.', 'unknown', UNSTATED],
    ] as [number, string, string, PositionAfterAlarm, string][]
  ).map(([code, id, text, position, positionBasis]) => [
    code,
    { code, id, text, position, positionBasis },
  ]),
);

export interface CodeRendering {
  code: number;
  /** True when this build carries an entry. False renders as an explicit
   *  unknown — never swallowed, never blank. */
  known: boolean;
  id: string | null;
  text: string;
  /** What the operator can do next. */
  action: string;
}

/**
 * 🔴 Alarms 10–21 do not exist in grbl v1.1. A UI built from grbl's 9-entry
 * table renders "unknown alarm 17" for a motor fault. This ships grblHAL's
 * table, and an unrecognised code is rendered as an unrecognised code.
 *
 * @param plant `'swallow-unknown-code'` renders an unknown code as known and
 * blank — the defect where a controller says something and the UI shows nothing.
 */
export function describeAlarm(code: number, plant?: ProtocolPlant): CodeRendering {
  const spec = ALARMS.get(code);
  if (spec) {
    return {
      code,
      known: true,
      id: spec.id,
      text: spec.text,
      action:
        spec.position === 'retained'
          ? 'Unlock ($X) is safe here: the controller says machine position is retained.'
          : 'Unlock ($X) clears the lock and restores nothing — no position, no homing, no offsets. Re-home ($H) before cutting.',
    };
  }
  if (plant === 'swallow-unknown-code') {
    return { code, known: true, id: null, text: '', action: '' };
  }
  return {
    code,
    known: false,
    id: null,
    text: `alarm ${code} — this build reports an alarm this UI does not know.`,
    action: 'Run $EA for the controller’s own alarm list, and route the code to pcb.',
  };
}

/**
 * Position trust after an alarm, which is what R2 reads.
 *
 * @param plant `'trust-after-hardlimit'` reports alarms 1 and 3 as retained.
 */
export function positionTrustAfterAlarm(
  code: number,
  plant?: ProtocolPlant,
): { trusted: boolean; why: string } {
  if (plant === 'trust-after-hardlimit' && (code === 1 || code === 3)) {
    return { trusted: true, why: 'planted' };
  }
  const spec = ALARMS.get(code);
  if (!spec) {
    return {
      trusted: false,
      why: `alarm ${code} is not in this build’s table, so nothing here can say the position survived it. Re-home before cutting.`,
    };
  }
  if (spec.position === 'retained') {
    return { trusted: true, why: `${spec.id}: ${spec.positionBasis}` };
  }
  return { trusted: false, why: `${spec.id}: ${spec.positionBasis}` };
}

/**
 * Position trust after a soft reset (`0x18`).
 *
 * Two completely different outcomes, and the difference is whether the machine
 * was moving (`motion_control.c:1170-1204`): stationary keeps position and
 * raises no alarm; moving kills the steppers with no deceleration, sets
 * `sys.position_lost` and raises `ALARM:3`.
 */
export function positionTrustAfterReset(
  stateWhenSent: MachineState,
  substate: number | null,
): { trusted: boolean; why: string } {
  const moving = motionVerdict(stateWhenSent, substate).mayMove;
  if (moving) {
    return {
      trusted: false,
      why: 'Soft reset while moving: the steppers were killed with no deceleration and ALARM:3 was raised. Steps are lost. Re-home before cutting again.',
    };
  }
  return {
    trusted: true,
    why: 'Soft reset while stationary: nothing was killed, no alarm was raised, position is retained.',
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ERROR TABLE
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ErrorSpec {
  code: number;
  id: string;
  /**
   * grblHAL's own sentence, verbatim from `errors.c`. `null` only where this
   * lane has not read it at a primary source.
   *
   * 🔴 **This table is NOT the full ~90 codes, and that is stated rather than
   * papered over.** An unknown code renders as unknown; nothing here is
   * paraphrased or invented, because a fabricated sentence in a safety surface
   * is indistinguishable from a sourced one and gets quoted back as evidence.
   *
   * ⚠ **The REASON this table is partial changed on 2026-08-11 and the old one
   * is now false.** It used to say the extraction *"needs `grblHAL/core/errors.c`,
   * which this box cannot reach"*. The box reaches it — `errors.c` is on disk
   * and every sentence below was taken from it. What is still missing is not
   * access, it is the `meaning` column: each row's second half is a *judgement
   * about our own path* ("typed console input", "never, for our programs"), and
   * a bulk import would either leave ~70 of those blank or fill them with
   * guesses. **A stale reason is worse than no reason: nobody re-tests a gap
   * that already names a cause.**
   */
  text: string | null;
  /** What brings the tab here. */
  meaning: string;
}

export const ERRORS: ReadonlyMap<number, ErrorSpec> = new Map(
  (
    [
      [1, 'Status_ExpectedCommandLetter', 'G-code words consist of a letter and a value. Letter was not found.', 'A g-code word had no letter. Typed console input.'],
      [2, 'Status_BadNumberFormat', 'Missing the expected G-code word value or numeric value format is not valid.', 'A g-code word had no usable value. Typed console input.'],
      [3, 'Status_InvalidStatement', "'$' system command was not recognized or supported.", 'An unrecognised `$` command.'],
      [8, 'Status_IdleError', "'$' command cannot be used unless controller state is IDLE. Ensures smooth operation during a job.", 'A `$` command sent mid-job.'],
      [9, 'Status_SystemGClock', 'G-code commands are locked out during alarm or jog state.', '🔴 Streaming into an Alarm, or into a jog in flight. This is what a whole job looks like when the machine simply has not homed — it reads exactly like a dialect failure and is not one.'],
      [10, 'Status_SoftLimitError', 'Soft limits cannot be enabled without homing also enabled.', 'Soft limits cannot be enabled without homing.'],
      [11, 'Status_Overflow', 'Max characters per line exceeded. Received command line was not executed.', 'A line longer than the 256-character line buffer (protocol.h:36). Never, for our programs.'],
      /* 🔴 13 / 18 / 49 are here because they are what `$X` answers BEFORE it
       * ever reaches 46 — see UNLOCK_REFUSAL_ORDER. Carrying only 46 rendered
       * an open safety door or an asserted e-stop as "an error this UI does not
       * carry text for", which is the one message that tells an operator to go
       * looking in the wrong place. */
      [13, 'Status_CheckDoor', 'Safety door detected as opened and door state initiated.', '🔴 The safety door is OPEN. As a reply to `$X` it outranks 46: check_status tests the door before it tests homing (system.c:425-427). Close the door, then `$X`.'],
      [15, 'Status_TravelExceeded', 'Jog target exceeds machine travel. Jog command has been ignored.', 'A jog past a soft limit. 🔴 An ERROR, not an alarm — the jog is simply not executed and nothing is locked.'],
      [16, 'Status_InvalidJogCommand', "Jog command has no '=' or contains prohibited g-code.", 'A malformed `$J=`, or a word `$J=` does not accept (everything except axis words, F, G20/21, G90/91, G53 and N).'],
      [18, 'Status_Reset', 'Reset asserted', '🔴 The RESET input is held asserted. As a reply to `$X` it outranks 46 (system.c:428-430). Nothing will unlock while the signal is held — this is wiring or a latched button, not a stuck UI.'],
      [20, 'Status_GcodeUnsupportedCommand', 'Unsupported or invalid g-code command found in block.', 'A word this build does not implement — the canned-cycle case gate CTRL exists for.'],
      [26, 'Status_GcodeNoAxisWords', 'No axis words found in block for g-code command or current modal state which requires them.', 'A motion word with no axis word.'],
      [33, 'Status_GcodeInvalidTarget', 'Motion command target is invalid.', 'A zero-length move or probe — a G38.2 whose target is the current position.'],
      [40, 'Status_GcodeToolChangePending', 'G-code command not allowed when tool change is pending.', 'Motion attempted while a tool change is pending.'],
      [45, 'Status_LimitsEngaged', 'Only homing is allowed when a limit switch is engaged.', 'A limit switch is engaged; clear it before continuing. ⚠ Reached only AFTER the four blocking checks pass, and only when `$21`+`$22` ask for the check at init (system.c:438-439).'],
      [46, 'Status_HomingRequired', 'Home machine to continue.', '🔴 The reply to `$X` on a machine that must home. `$X` does NOT clear the boot alarm on such a machine (system.c:413-445) — run `$H`. ⚠ It is the LAST verdict check_status can return, so it is the one that means "nothing else is wrong" — see UNLOCK_REFUSAL_ORDER.'],
      [49, 'Status_SelfTestFailed', 'Power on self test failed. A hard reset is required.', '🔴 The controller failed its power-on self test. As a reply to `$X` it outranks everything, including 46 (system.c:419-421). grblHAL says a HARD RESET is required — `$X` and `$H` will not help.'],
      [50, 'Status_EStop', 'Emergency stop active.', '🔴 E-stop asserted. As a reply to `$X` it outranks 46 (system.c:422-424). Release the physical button, then reset.'],
      [51, 'Status_MotorFault', 'Motor fault.', 'A motor driver reported a fault. Blocks `$H` specifically (system.c:434-435).'],
      [56, 'Status_GCodeCoordSystemLocked', 'Coordinate system is locked.', 'The coordinate system is locked.'],
      [57, 'Status_UnexpectedDemarcation', 'Unexpected file demarcation.', 'A bare `%` — file demarcation toggled. Our post strips `%` from comments for exactly this reason.'],
      /* 🔴 The `text: null` case, and it is a REAL one rather than a placeholder
       * kept alive for a test. `Status_SDMountError` is declared in
       * `errors.h:93` and has NO entry in the core's `errors.c` table — the
       * sdcard plugin supplies its sentence at runtime via `errors_register`
       * (`sdcard/sdcard.c:247`). So there is a whole class of codes whose text
       * exists only on a board with the plugin built in, and this lane cannot
       * source it from the core at all. That is what `null` means here, and it
       * is why `describeError` must keep a branch that says "this build does
       * not carry the sentence" instead of paraphrasing one. */
      [60, 'Status_SDMountError', null, 'A filesystem/SD-card code. grblHAL\'s CORE carries no sentence for it — the sdcard plugin registers its own error table at runtime — so `$EE` on a board with the plugin will print text this build cannot know in advance. Not on this tab\'s path: we stream over the link, never from the card.'],
    ] as [number, string, string | null, string][]
  ).map(([code, id, text, meaning]) => [code, { code, id, text, meaning }]),
);

/**
 * 🔴 **The order `$X` refuses in, and why 46 is the WRONG code to special-case
 * alone.**
 *
 * `check_status()` (`system.c:413-445`) is a single `else if` chain, so it
 * returns **one** code and the earlier tests win. `Status_HomingRequired` (46)
 * is the **last** thing it can return — it is reached only when the self test
 * passed, no e-stop is asserted, the door is shut and the reset line is clear.
 *
 * ⇒ A UI that recognises 46 and nothing else does not degrade gracefully; it
 * **inverts the diagnosis**. The operator whose door is ajar gets a generic
 * *"an error this UI does not carry text for"* — and the one condition it
 * DOES name, *"run `$H`"*, is the advice for the case that is not happening.
 *
 * ⚠ **This is not the same channel as {@link TrackedState.estopAsserted} /
 * `doorAjar` / `limitsEngaged`, and both are needed.** Those are decoded from
 * `Pn:` and are only present when `$10` bit 4 is set; this is what the
 * controller actually **answered**. A machine reporting `$10=1` sends no `Pn`
 * at all, so on that machine the reply code is the *only* evidence there is.
 *
 * Listed in the order the controller applies them, first match wins.
 */
export const UNLOCK_REFUSAL_ORDER: readonly {
  code: number;
  id: string;
  /** What the operator must physically do. `$X` is not one of the answers. */
  clearedBy: string;
}[] = [
  { code: 49, id: 'Status_SelfTestFailed', clearedBy: 'a HARD RESET — grblHAL\'s own sentence says so. Neither $X nor $H will clear a failed power-on self test.' },
  { code: 50, id: 'Status_EStop', clearedBy: 'releasing the physical e-stop, then resetting the controller.' },
  { code: 13, id: 'Status_CheckDoor', clearedBy: 'closing the safety door (unless $17x is configured to ignore it while idle).' },
  { code: 18, id: 'Status_Reset', clearedBy: 'clearing whatever holds the RESET input asserted — a latched button or a wiring fault.' },
  { code: 46, id: 'Status_HomingRequired', clearedBy: 'running $H and by nothing else — this is the only one of the five where the machine is otherwise well.' },
] as const;

/** @param plant `'swallow-unknown-code'` — see {@link describeAlarm}. */
export function describeError(code: number, plant?: ProtocolPlant): CodeRendering {
  const spec = ERRORS.get(code);
  if (spec) {
    return {
      code,
      known: true,
      id: spec.id,
      text: spec.text ?? `${spec.id} — grblHAL’s own sentence for this code is not carried in this build.`,
      action: spec.meaning,
    };
  }
  if (plant === 'swallow-unknown-code') {
    return { code, known: true, id: null, text: '', action: '' };
  }
  return {
    code,
    known: false,
    id: null,
    text: `error ${code} — this build reports an error this UI does not carry text for.`,
    action:
      'Run $EE for the controller’s own error list (it enumerates its own tables; the design cites $EA for the alarm list), and route the code to pcb.',
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   IDENTIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

export type Identification = 'grblHAL' | 'grbl' | 'unknown';

export interface IdentificationVerdict {
  verdict: Identification;
  /** What in the received bytes decided it. */
  evidence: string;
  /** What the tab may do. `unknown` permits NOTHING and the port is closed —
   *  leaving it open with a console is a loaded gun pointed at a Marlin board
   *  that will happily execute `G0 Z-50`. */
  permits: 'everything' | 'read-only' | 'nothing';
  /** Rendered to the operator. */
  why: string;
  /**
   * 🔴 **The two ways an `unknown` verdict happens, separated — because they
   * are different facts and only one of them is about the board.**
   *
   * `'silence'` — nothing arrived at all. A dead cable, the wrong port, the
   * wrong baud rate, **and a perfectly healthy grblHAL board that booted before
   * this tab opened the port** are all indistinguishable from here: grblHAL and
   * Marlin alike print their banner only at power-on. Silence is the *absence*
   * of evidence, not evidence of anything.
   *
   * `'speech'` — bytes arrived and nothing in them identified the firmware.
   * That IS a fact about the board, and {@link IdentificationVerdict.received}
   * carries the bytes it is a fact about.
   *
   * ⚠ Both still permit **nothing**. This separates the diagnosis, never the
   * permission. (Until 2026-08-11 both rendered the one string
   * `'nothing was received'`, so a refusal could not tell an operator whether
   * to check the cable or the firmware.)
   */
  heard: 'silence' | 'speech';
  /** Exactly what arrived, verbatim and in order, so a refusal can SHOW it
   *  rather than describe it. Empty when {@link IdentificationVerdict.heard} is
   *  `'silence'`. */
  received: readonly string[];
}

const MARLIN_MARKERS = ['echo:', 'marlin', 'ok t:'];

/**
 * Classify the firmware from everything received during the handshake.
 *
 * The order is the design's (§11) and each step is weaker than the one before,
 * so the strongest available evidence wins: `FW:grblHAL` in a `0x87` full report
 * (a field grbl 1.1 does not have) > a `GrblHAL` banner > `[VER:`+`[OPT:`.
 *
 * ⚠ **Absence of a banner is not evidence of anything** — a board that has been
 * running for an hour sends none. That is why the two `unknown` branches are
 * separate ({@link IdentificationVerdict.heard}) and why silence is the branch
 * {@link handshakeDecision} refuses to conclude from.
 *
 * @param plant `'accept-anything'` returns grblHAL for any input at all.
 */
export function identify(lines: string[], plant?: ProtocolPlant): IdentificationVerdict {
  /* Carried on EVERY verdict, not only the refusals: a green identification
   * whose bytes are not recorded cannot be re-read later, and this whole
   * function is one lane's reading of another project's firmware. */
  const received = [...lines];
  const heard: 'silence' | 'speech' = lines.length === 0 ? 'silence' : 'speech';

  if (plant === 'accept-anything') {
    return {
      verdict: 'grblHAL',
      evidence: 'planted',
      permits: 'everything',
      why: 'planted',
      heard,
      received,
    };
  }
  const lower = lines.map((l) => l.toLowerCase());

  for (const line of lines) {
    const parsed = parseStatusReport(line);
    if (parsed.report?.fw && /grblhal/i.test(parsed.report.fw)) {
      return {
        verdict: 'grblHAL',
        evidence: `FW:${parsed.report.fw} in a full status report`,
        permits: 'everything',
        why: 'The controller identified itself as grblHAL in a field grbl 1.1 does not have.',
        heard,
        received,
      };
    }
  }
  if (lower.some((l) => /^grblhal\s/.test(l.trim()))) {
    return {
      verdict: 'grblHAL',
      evidence: 'a GrblHAL startup banner',
      permits: 'everything',
      why: 'The controller announced itself as GrblHAL.',
      heard,
      received,
    };
  }
  if (lower.some((l) => MARLIN_MARKERS.some((m) => l.includes(m)))) {
    return {
      verdict: 'unknown',
      evidence: 'Marlin markers (echo:/Marlin) in the reply',
      permits: 'nothing',
      why: 'This looks like Marlin, not grblHAL. The port is closed. An SKR Pro ships with Marlin, and a console pointed at it would execute whatever gets typed.',
      heard,
      received,
    };
  }
  const hasVer = lower.some((l) => l.includes('[ver:'));
  const hasOpt = lower.some((l) => l.includes('[opt:'));
  const grblBanner = lower.some((l) => /^grbl\s/.test(l.trim()));
  if (grblBanner || (hasVer && hasOpt)) {
    return {
      verdict: 'grbl',
      evidence: grblBanner ? 'a Grbl banner with no FW:grblHAL' : '[VER: and [OPT: with no FW:grblHAL',
      permits: 'read-only',
      why: 'This reports as grbl 1.1, not grblHAL. Our post targets grblHAL and the differences are not cosmetic — RX buffer size, alarm codes, and error persistence all differ. DRO and status only: no streaming, no jogging.',
      heard,
      received,
    };
  }
  /* 🔴 TWO REFUSALS, NOT ONE. Both permit nothing; they send a human to
   * completely different places. */
  if (heard === 'silence') {
    return {
      verdict: 'unknown',
      evidence: 'the port opened and NOTHING arrived — no banner, no report, not one byte',
      permits: 'nothing',
      why:
        'Silence is not evidence about this board. grblHAL and Marlin both print their banner only ' +
        'at power-on, so a controller that has been running for hours says nothing until it is reset ' +
        '— and a dead cable, the wrong port and the wrong baud rate all look exactly like this too. ' +
        'Reset or power-cycle the controller and it will announce itself; nothing has been written to ' +
        'this port.',
      heard,
      received,
    };
  }
  return {
    verdict: 'unknown',
    evidence: `nothing identifiable in the ${received.length} line(s) received: ${received
      .map((l) => JSON.stringify(l))
      .join(' ')}`,
    permits: 'nothing',
    why:
      'This device spoke and none of it identifies the firmware. That IS a fact about the board, ' +
      'unlike silence. The port is closed and the raw bytes are shown so a human can identify it.',
    heard,
    received,
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * The probe, and why sending it is the OPERATOR'S decision
 * ─────────────────────────────────────────────────────────────────────────── */

/** One thing the identification probe would put on the wire. */
export interface ProbeStep {
  /** Exactly what goes out, written the way it goes out. */
  bytes: string;
  /** What it asks grblHAL for. */
  asks: string;
  /** 🔴 What it is on firmware that has NOT been identified as grblHAL. */
  onUnknownFirmware: string;
}

/**
 * 🔴 **THE THREE THINGS THIS TAB USED TO SEND TO AN UNIDENTIFIED CONTROLLER.**
 *
 * They went out unconditionally, straight after the port opened and two seconds
 * before anything classified the firmware — the tab did to a machine exactly
 * what a human inspector is forbidden from doing by hand.
 *
 * They are still the right probe. What changed is who decides: this list is
 * **rendered to the operator, byte for byte**, and it goes on the wire only
 * after an explicit action that has read it.
 *
 * ⚠ **"Read-only" is a fact about grblHAL and about nothing else.** `$` is not
 * a universal no-op — on some firmwares it prefixes a parameter **write** — and
 * `0x87` is an arbitrary byte whose meaning belongs to whatever is actually
 * running. On a board we have not identified, "harmless" is an assumption, not
 * a measurement.
 */
export const IDENTIFY_PROBE: readonly ProbeStep[] = [
  {
    bytes: '$I\\n',
    asks: 'the build-info block — grblHAL answers [VER:…] and [OPT:…] then ok (report.c:868, 883).',
    onUnknownFirmware:
      'a `$` line of unknown meaning. On some firmwares `$` prefixes a SETTING WRITE, so this is the step whose worst case is not noise.',
  },
  {
    bytes: '0x87 (ONE byte, no newline)',
    asks:
      'a full status report, the only one that carries FW:grblHAL — the strongest positive identification there is, because grbl 1.1 has no such field (report.c:1543-1545).',
    onUnknownFirmware:
      'one byte in the 0x80–0xFF range. grblHAL treats that range as realtime commands; anything else may treat it as data, as a command of its own, or as a framing error.',
  },
  {
    bytes: '$$\\n',
    asks:
      'every setting, so the tab can read $10 (report mask), $13 (units — inches make a millimetre DRO wrong by 25.4), $22 (homing) and $481 (auto-report).',
    onUnknownFirmware: 'a second `$` line, with the same worst case as the first.',
  },
] as const;

/**
 * What to do at the end of the listen window.
 *
 * 🔴 **The rule this encodes: identify from what the board says UNPROMPTED, and
 * gate every write behind either a verdict or an operator who has been shown
 * the bytes.**
 *
 * Three answers, and the middle one is the whole point:
 *
 *  - `accept` — something identified it. {@link Connection} may proceed, and the
 *    settings read (`$$`) now goes to firmware we have classified.
 *  - `ask-operator` — **silence, and nothing has been probed yet.** Silence is
 *    the one refusal that is not about the board (see
 *    {@link IdentificationVerdict.heard}), so concluding from it would be
 *    concluding from an absence. The tab stops, shows {@link IDENTIFY_PROBE}
 *    verbatim, and waits. **It does not send the probe as a silent default.**
 *  - `refuse` — the board spoke and was not recognised, **or** it stayed silent
 *    through a probe the operator did authorise. Close the port. ⚠ This is
 *    deliberately unchanged and must stay so: an unknown board is refused, not
 *    made usable.
 *
 * @param probed `true` once {@link IDENTIFY_PROBE} has actually gone out on this
 *   connection. It is what stops `ask-operator` from being offered twice — a
 *   second ask after a probe that answered nothing is a loop, not a question.
 */
export type HandshakeAction = 'accept' | 'ask-operator' | 'refuse';

export interface HandshakeDecision {
  action: HandshakeAction;
  verdict: IdentificationVerdict;
  /** The bytes the operator is being asked to authorise. Empty unless
   *  `action === 'ask-operator'` — a list rendered on any other branch would be
   *  an offer nobody made. */
  probe: readonly ProbeStep[];
  /** Rendered verbatim. */
  why: string;
}

export function handshakeDecision(
  lines: string[],
  opts: { probed: boolean },
  plant?: ProtocolPlant
): HandshakeDecision {
  const verdict = identify(lines, plant);
  if (verdict.permits !== 'nothing') {
    return { action: 'accept', verdict, probe: [], why: verdict.why };
  }
  if (verdict.heard === 'silence' && !opts.probed) {
    return {
      action: 'ask-operator',
      verdict,
      probe: IDENTIFY_PROBE,
      why:
        'Nothing has been written to this port and nothing will be until you say so. The listen ' +
        'window closed with no bytes at all, which is the one answer that says nothing about the ' +
        'board: a grblHAL controller that booted before this tab opened the port is silent, and so ' +
        'is a dead cable. The zero-risk step is to RESET the controller and let it announce itself. ' +
        'The alternative is to ask it, and asking means writing to firmware nobody has identified — ' +
        'so the exact bytes are listed and the decision is yours.',
    };
  }
  return {
    action: 'refuse',
    verdict,
    probe: [],
    why:
      opts.probed && verdict.heard === 'silence'
        ? 'The probe went out and the port stayed silent. There is nothing further to ask with: the ' +
          'port is closed rather than left open with a console on it.'
        : verdict.why,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE STREAMER — character counting against a MEASURED buffer
   ═══════════════════════════════════════════════════════════════════════════ */

export type StreamMode = 'character-counting' | 'send-response';

export type StreamerState = 'ready' | 'streaming' | 'done' | 'aborted';

export interface StreamAbort {
  reason: 'error' | 'alarm' | 'desync' | 'stopped';
  code: number | null;
  /** The line the abort is about, where there is one. */
  line: string | null;
  lineNumber: number | null;
  message: string;
}

/**
 * Character counting, and nothing else.
 *
 * No timers, no I/O, no `Link`. The caller pumps: {@link nextLines} hands back
 * the lines that may be on the wire right now, {@link onReply} takes what came
 * back. That is what makes the whole streaming protocol testable with no
 * machine, and it is also the shape the design's §17 demands — a streamer
 * driven by replies rather than by a timer, because Chrome throttles timers in a
 * hidden tab and **a streamer built on a timer pump stalls the moment the tab is
 * hidden, which leaves a turning cutter stationary in the work.**
 *
 * 🔴 **The buffer size is a constructor argument and there is no default.**
 * grbl's own reference streamer hard-codes 128; grblHAL's is 1024
 * (`stream.h:51-53`) unless a board map overrides the define. Both numbers are
 * wrong to assume. The connect handshake measures it from `Bf` while `Idle`
 * (design §2), and if `Bf` is not reported the honest answers are send-response
 * with the reason on screen, or refuse — never a guess. See R13.
 *
 * 🔴 **AND THE MEASURED NUMBER IS NOT NECESSARILY THE BUFFER SIZE.** `Bf`'s
 * second figure is what the *driver* calls free space, and the two drivers on
 * this board do not compute it the same way: USB CDC returns
 * `RX_BUFFER_SIZE - count` (`STM32F4xx/Src/usb_serial.c:54`) so it tops out at
 * **1024**, while a UART returns `(RX_BUFFER_SIZE - 1) - count`
 * (`STM32F4xx/Src/serial.c:551`) so it tops out at **1023** — the same firmware,
 * the same `RX_BUFFER_SIZE`, one byte apart depending on which cable is plugged
 * in. grblHAL requires `RX_BUFFER_SIZE` to be a power of two (`stream.h:52`, its
 * own comment); **1023 is not one**, so nothing here may round, mask, bit-shift
 * or sanity-check the measured value against a power of two. It is an arbitrary
 * positive integer and the allowance arithmetic below treats it as one. *That
 * is the property `the streamer counts against an ODD, non-power-of-two
 * measured buffer` exists to hold, and it holds because the code never learned
 * the number's shape — which is exactly the sort of thing a later "tidy-up"
 * removes.*
 */
export class Streamer {
  readonly total: number;
  readonly mode: StreamMode;
  readonly rxBufferSize: number;

  private readonly lines: string[];
  private readonly plant: ProtocolPlant | undefined;
  private cursor = 0;
  /** Byte cost of each line still un-acknowledged, oldest first. */
  private outstanding: { chars: number; line: string; index: number }[] = [];
  private ackedCount = 0;
  private _state: StreamerState = 'ready';
  private _abort: StreamAbort | null = null;

  constructor(opts: {
    lines: string[];
    mode: StreamMode;
    /** Measured from `Bf`. Required for character counting; ignored otherwise. */
    rxBufferSize: number | null;
    plant?: ProtocolPlant;
  }) {
    if (opts.mode === 'character-counting' && (opts.rxBufferSize === null || opts.rxBufferSize <= 0)) {
      throw new Error(
        'character counting needs a MEASURED RX buffer size (Bf, second figure). ' +
          'Never guess 128 or 1024 — see refusal R13 and design §2.',
      );
    }
    this.lines = opts.lines;
    this.total = opts.lines.length;
    this.mode = opts.mode;
    this.rxBufferSize = opts.rxBufferSize ?? 0;
    this.plant = opts.plant;
  }

  get state(): StreamerState {
    return this._state;
  }
  get abort(): StreamAbort | null {
    return this._abort;
  }
  /** Lines handed to the transport. */
  get sent(): number {
    return this.cursor;
  }
  /** Lines the controller has answered. */
  get acknowledged(): number {
    return this.ackedCount;
  }
  /** Characters the controller is believed to be holding. */
  get pendingChars(): number {
    return this.outstanding.reduce((a, b) => a + b.chars, 0);
  }
  /**
   * 🔴 **Completion is the sender's own accounting, never the state word.**
   * `Idle` means the planner is empty, and a streamer that has stopped feeding
   * produces `Idle` in the middle of a job — which is the starvation case, not
   * the completion case (design §4).
   */
  get complete(): boolean {
    return this.ackedCount === this.total && this.cursor === this.total;
  }

  /**
   * The lines that may go out now, marked as sent.
   *
   * Each costs `line.length + 1` — the terminating newline the transport adds.
   * The gate is `pending + cost <= rxBufferSize`.
   *
   * @param plant `'overcount'` allows one byte past the buffer.
   */
  nextLines(): string[] {
    if (this._state === 'aborted' || this._state === 'done') return [];
    if (this._state === 'ready') this._state = 'streaming';
    const allowance = this.rxBufferSize + (this.plant === 'overcount' ? 1 : 0);
    const out: string[] = [];
    while (this.cursor < this.total) {
      if (this.mode === 'send-response') {
        if (this.outstanding.length > 0 || out.length > 0) break;
      } else {
        const cost = this.lines[this.cursor].length + 1;
        if (this.pendingCharsWith(out) + cost > allowance) break;
      }
      const line = this.lines[this.cursor];
      this.outstanding.push({ chars: line.length + 1, line, index: this.cursor });
      out.push(line);
      this.cursor += 1;
    }
    if (this.cursor === this.total && this.outstanding.length === 0) this._state = 'done';
    return out;
  }

  private pendingCharsWith(_justAdded: string[]): number {
    /* `outstanding` already includes everything in `_justAdded` — they are
     * pushed as they are emitted — so the running total is simply the current
     * pending count. The parameter is kept to make that explicit at the call
     * site rather than leaving a reader to work out whether the new lines were
     * double-counted. */
    return this.pendingChars;
  }

  /**
   * Take one inbound line.
   *
   * Only `ok` / `error:N` decrement the count (`Inbound.isLineReply`). An
   * `ALARM:N` is asynchronous and aborts without decrementing anything.
   *
   * 🔴 **The first `error:` aborts.** grblHAL poisons every line after an error
   * and replies with a copy of the same code about a line it never parsed
   * (`protocol.c:265-272`), so continuing produces one real finding plus N
   * copies of it and executes motion after a rejected block.
   *
   * @param plant `'keep-going-past-error'`.
   */
  onReply(inbound: Inbound): void {
    if (inbound.kind === 'alarm') {
      this._state = 'aborted';
      this._abort = {
        reason: 'alarm',
        code: inbound.code,
        line: null,
        lineNumber: null,
        message: `ALARM:${inbound.code} arrived between line replies. ${describeAlarm(inbound.code ?? -1, this.plant).text}`,
      };
      return;
    }
    if (!inbound.isLineReply) return;
    const oldest = this.outstanding.shift();
    if (!oldest) {
      this._state = 'aborted';
      this._abort = {
        reason: 'desync',
        code: inbound.code,
        line: null,
        lineNumber: null,
        /* ⚠ NAME THE CAUSE THAT IS NOT A BUG IN HERE. An extra reply is what a
         * SECOND PROGRAM on the same port produces: its lines are answered on
         * the same stream, and two processes reading one tty each receive some
         * of the bytes. Until 2026-08-11 this message described the symptom and
         * stopped, so the one explanation an operator could act on was the one
         * missing from it. */
        message:
          `a reply ("${inbound.raw}") arrived with no line outstanding — the sender and the controller ` +
          'disagree about what has been sent. The commonest cause is not a fault in this tab: a SECOND ' +
          'PROGRAM writing to the same port (a serial monitor, gSender, CNCjs, a screen session) gets ' +
          'its lines answered on this same stream. If one is open, that is the fault, and this tab’s ' +
          'character count has been wrong for as long as it has been open.',
      };
      return;
    }
    this.ackedCount += 1;
    if (inbound.kind === 'error') {
      if (this.plant === 'keep-going-past-error') {
        if (this.cursor === this.total && this.outstanding.length === 0) this._state = 'done';
        return;
      }
      this._state = 'aborted';
      const rendered = describeError(inbound.code ?? -1, this.plant);
      this._abort = {
        reason: 'error',
        code: inbound.code,
        line: oldest.line,
        lineNumber: oldest.index + 1,
        message: `error:${inbound.code} on line ${oldest.index + 1} ("${oldest.line}") — ${rendered.text} Every reply after this one would be a copy of it about a line the controller never parsed.`,
      };
      return;
    }
    if (this.cursor === this.total && this.outstanding.length === 0) this._state = 'done';
  }

  /** Operator pressed Stop, or a watchdog fired. */
  stop(message: string): void {
    if (this._state === 'done' || this._state === 'aborted') return;
    this._state = 'aborted';
    this._abort = { reason: 'stopped', code: null, line: null, lineNumber: null, message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SOLE OWNERSHIP OF THE PORT — the assumption under the character count
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 **THE CHARACTER COUNT ASSUMES THIS TAB IS THE ONLY WRITER ON THE PORT, AND
 * NOTHING ENFORCES THAT.** This sentence is a constant rather than a comment
 * because it has to reach an operator, not a reader of this file.
 *
 * `Streamer` gates on `pendingChars + cost <= rxBufferSize`, and `pendingChars`
 * sums **only this tab's own sent-but-unacknowledged lines**. The controller's
 * `Bf` is per-stream and honest — `report.c:1293-1300` prints
 * `hal.stream.get_rx_buffer_free()`, **the active stream's own pointer over its
 * own ring, with no aggregation anywhere** (the MPG path proves it by
 * repointing that very function pointer, `stream.c:739`). So a second process
 * that has `/dev/ttyACM0` open — **which needs no hub and is the realistic
 * version of this** — puts its bytes in the same ring, and our count undercounts
 * by exactly its bytes. We then send into space we believe is free.
 *
 * 🔴 **And grblHAL says nothing when that overruns.** `usbBufferInput` sets
 * `rxbuf.overflow = 1` and drops the byte (`STM32F4xx/Src/usb_serial.c:256-259`;
 * the three UART paths do the same at `serial.c:791`, `:1061`, `:1331`) — and
 * **that flag is written in four places and read in none.** No error, no
 * message, no report field. The first symptom is a mutilated line: a dropped
 * newline merges two of our lines into one, a dropped digit turns `X10.5` into
 * `X105`. **The machine executes something that was never in the file.**
 */
export const SOLE_OWNERSHIP_LIMIT =
  'This tab’s flow control assumes it is the ONLY program writing to this port. It counts its ' +
  'own characters against the buffer size it measured; it cannot count anybody else’s. If a ' +
  'second program has the same port open — a serial monitor, gSender, CNCjs, a screen session — ' +
  'the controller’s buffer fills faster than this tab believes, grblHAL drops what will not fit ' +
  'WITHOUT REPORTING ANYTHING, and the machine runs a mutilated line. Nothing in the Web Serial ' +
  'API can claim the port, so this is a limit rather than a guarantee.';

/**
 * The one character in the RX ring that is nobody's second writer.
 *
 * `cancel_read_buffer` — the `0x85` jog-cancel path — does not merely flush:
 * `usbRxCancel` **writes an `ASCII_CAN` into the ring** and then moves the tail
 * (`STM32F4xx/Src/usb_serial.c:68-73`; `serial.c:575-580`, `:843-848` do the
 * same). The main loop reads and discards it on its next pass
 * (`grbl/protocol.c:212-219`) and never replies to it — but a status report
 * rendered in between shows `Bf`'s free figure **one lower than the buffer**,
 * with nothing of ours and nothing foreign in it.
 *
 * ⚠ **This is a named non-foreign occupant, not a safety margin.** It buys
 * exactly one character of insensitivity: a second writer holding a single
 * character is invisible to {@link PortOwnershipWatch}. That is the trade, it is
 * stated, and it is the whole of it — nothing else here is padded.
 */
export const RING_ARTEFACT_CHARS = 1;

/**
 * What this tab knows about whether it is alone on the port.
 *
 * ⚠ **Three states, deliberately not a boolean** — and the middle one is not the
 * good news it sounds like. `'no-disagreement'` means *every sample this watch
 * could evaluate agreed with sole ownership*; it does **not** mean "sole
 * owner". A second writer that has only sent realtime bytes, or that has been
 * quiet since we connected, produces exactly `'no-disagreement'`.
 */
export type PortOwnershipVerdict = 'unchecked' | 'no-disagreement' | 'foreign-writer';

/** How a foreign writer was caught. Kept so the message can quote the numbers
 *  rather than assert a conclusion. */
export interface OwnershipEvidence {
  kind:
    /** A quiescent sample sat BELOW the quiescent baseline. */
    | 'quiescent-dip'
    /** A quiescent sample rose ABOVE it, so every earlier one — including the
     *  handshake's measurement — was taken over somebody else's bytes. */
    | 'baseline-rose'
    /** Not quiescent, but the arithmetic leaves no room: the occupancy exceeds
     *  the most this tab could possibly account for. */
    | 'bound-exceeded';
  /** Characters of ring occupancy this tab cannot account for. */
  chars: number;
  /** The largest quiescent `Bf` free figure seen up to that sample. */
  baseline: number;
  /** The free figure in the sample that produced the evidence. */
  rxFree: number;
  /** The bound this tab supplied for its own bytes at that moment. */
  ourChars: number | 'unknown';
}

/**
 * One `Bf` observation, offered to {@link PortOwnershipWatch}.
 *
 * 🔴 **`ourChars` IS THE LOAD-BEARING FIELD AND IT IS NOT `Streamer.pendingChars`.**
 * It must bound **every** non-realtime byte this tab has written and not yet had
 * a reply to — the streamer's lines *and* the console's `$` commands, the `$$`
 * read at connect, `$H`, `$X`, a `$J=` jog. A tab that supplies only the
 * streamer's count **manufactures a foreign writer out of its own `$$`**, and a
 * detector that fires on the tab's own traffic is a detector that gets muted.
 * The test `an unaccounted channel of OUR OWN reads as a foreign writer` is that
 * failure, planted.
 *
 * ⚠ **And it must be an upper bound at the moment the CONTROLLER rendered the
 * report, not at the moment this tab read it** — the report is a snapshot from
 * the past. The honest supply is the **maximum** this tab's outstanding count
 * reached since the previous report. Too high is safe: it only makes the watch
 * less sensitive.
 *
 * `'unknown'` is not a nuisance value, it is the correct answer whenever the
 * tab cannot bound its own bytes — after a `0x85` or a `0x18`, both of which
 * flush the ring under the count (R7), or after any write it did not record.
 * **`'unknown'` samples are skipped, never scored.** A `0` that means "I did not
 * check" is the one input that would turn this watch into a liar.
 */
export interface RingSample {
  /** `Bf`'s SECOND figure — RX characters free. */
  rxFree: number;
  /** The state word from the same report. */
  state: MachineState;
  /** Is this tab feeding the streamer right now? */
  streaming: boolean;
  ourChars: number | 'unknown';
}

/**
 * Detects a second writer on the port from `Bf` alone — **sending nothing.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ASSERTION, AND WHY IT DOES NOT DEPEND ON THE NUMBER UNDER ATTACK
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The sharp case is the quiet one: the handshake **measures** the RX buffer size
 * from `Bf` while `Idle` and refuses to stream without it (R13). A second writer
 * present at that moment depresses the measurement, and every later gate
 * inherits the error. **So the detector may not be built on that measurement.**
 *
 * It is built on an invariant instead. Let `B` be the largest value the driver's
 * free-space function can return — unknown to us, and *not* required to be the
 * buffer size (USB CDC tops out at `RX_BUFFER_SIZE`, a UART at
 * `RX_BUFFER_SIZE - 1`). Then for any sample:
 *
 *     occupancy = B − rxFree,   ours ≤ ourChars,   foreign = occupancy − ours
 *
 * Take `q` = the largest `rxFree` ever seen in a **quiescent** sample (`Idle`,
 * not streaming, `ourChars === 0`). By construction `q ≤ B`, whatever B is. So:
 *
 *     foreign ≥ (q − rxFree) − ourChars
 *
 * is true **regardless of whether `q` is the real buffer size** — under-measuring
 * `q` only makes the watch blinder, never wrong. That is the property the
 * connect-time case needs: the arithmetic never asks *"is 1024 right?"*.
 *
 * And the connect-time corruption has its own signature, read off the same
 * invariant from the other side. Under sole ownership a quiescent `rxFree` is
 * **constant** — nothing of ours is in the ring and realtime bytes never enter
 * it (`protocol_enqueue_realtime_command` returns `drop = true` for `?`, `!`,
 * `~`, `0x80`–`0x87`, `0x90`+, and `usbBufferInput` buffers only what it returns
 * `false` for: `usb_serial.c:253-262`). **So a quiescent sample that RISES above
 * the baseline proves the baseline was taken over somebody else's bytes** — the
 * corrupted handshake, caught by its own later correction, with no appeal to
 * what the number should have been.
 *
 * ⚠ **`measureBuffers()` in `RunTab.tsx` throws exactly this away.** It keeps
 * `Math.max` of the same samples, and its comment is right that small is the
 * safe direction for *sending*. But the maximum is the one summary that cannot
 * show variation, and **the variation is the evidence.** Two facts, one series,
 * and only one of them survives a `Math.max`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHAT WOULD GET THIS MUTED, CHECKED RATHER THAN ASSUMED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  - **Auto-reporting (`$481`) and our own `?`/`0x80` polls — no effect.**
 *    Realtime bytes are stripped in the ISR and never occupy the ring (cited
 *    above), and a report is *output*. This was the first thing checked, because
 *    a detector that fires on auto-reporting is a detector nobody keeps.
 *  - **The operator's own console — accounted, or it fires.** Those bytes are
 *    ours; see {@link RingSample.ourChars}.
 *  - **The `0x85` `ASCII_CAN`** — {@link RING_ARTEFACT_CHARS}, one character,
 *    named and subtracted.
 *  - **A probing line that never gets an `ok`** (`G38.2` into an `ALARM:5`)
 *    leaves `ourChars > 0` forever, so no sample is quiescent and the watch goes
 *    quiet. Blind, not wrong — the safe direction.
 *
 * ⚠ **WHAT IT CANNOT SEE, and the refusal says so rather than implying
 * coverage.** A second writer that sends only realtime bytes takes no ring space
 * and is invisible here — while still being able to feed-hold or reset the
 * machine, and to *steal our `ok`s*, because two processes reading one tty each
 * get some of the bytes. A second writer that is merely present and quiet is
 * invisible too, and becomes visible the instant it writes a line. **This is a
 * detector for the case that corrupts the count, not a presence check.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT IS STICKY, ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Once `'foreign-writer'`, it stays. A second writer that goes quiet has not
 * gone away, and a verdict that un-fires teaches an operator to wait it out.
 * Clearing it means disconnecting — which is also what re-takes the corrupted
 * measurement.
 */
export class PortOwnershipWatch {
  private q: number | null = null;
  private _verdict: PortOwnershipVerdict = 'unchecked';
  private _evidence: OwnershipEvidence | null = null;
  /** Quiescent samples scored. The instrument's own liveness: a watch that has
   *  seen none has checked nothing, and `'unchecked'` says so. */
  private _quiescentSamples = 0;

  get verdict(): PortOwnershipVerdict {
    return this._verdict;
  }
  get evidence(): OwnershipEvidence | null {
    return this._evidence;
  }
  /** The largest quiescent `Bf` free figure seen. `null` = none yet. */
  get quiescentFree(): number | null {
    return this.q;
  }
  get quiescentSamples(): number {
    return this._quiescentSamples;
  }

  /** One sentence, rendered verbatim. Always names the limit, whatever the
   *  verdict — a green here covers one failure mode out of several. */
  get why(): string {
    switch (this._verdict) {
      case 'foreign-writer': {
        const e = this._evidence as OwnershipEvidence;
        const how =
          e.kind === 'baseline-rose'
            ? `the free figure ROSE to ${e.rxFree} from a baseline of ${e.baseline}, so the earlier ` +
              'samples — including the one the buffer size was measured from — were taken while ' +
              `${e.chars} character(s) of somebody else's data sat in the controller's buffer`
            : e.kind === 'quiescent-dip'
              ? `with nothing of ours outstanding and the controller Idle, the free figure was ${e.rxFree} ` +
                `against a baseline of ${e.baseline} — ${e.chars} character(s) in the buffer that are not ours`
              : `the buffer held at least ${e.chars} character(s) more than this tab could account for ` +
                `(free ${e.rxFree}, baseline ${e.baseline}, ours at most ${String(e.ourChars)})`;
        return (
          `A SECOND PROGRAM IS WRITING TO THIS PORT: ${how}. ${SOLE_OWNERSHIP_LIMIT} ` +
          'Close the other program, then disconnect and reconnect here — reconnecting is not ' +
          'ceremony, it is what re-takes the buffer measurement that the other program corrupted.'
        );
      }
      case 'no-disagreement':
        return (
          `${this._quiescentSamples} sample(s) with nothing of ours outstanding all reported the same ` +
          `${this.q} characters free, which is what sole ownership looks like. ⚠ It is not proof of it: ` +
          'a second program that has only sent realtime bytes, or that has been quiet since this tab ' +
          `connected, looks identical. ${SOLE_OWNERSHIP_LIMIT}`
        );
      case 'unchecked':
        return (
          'Nothing has been checked. No status report has arrived with the controller Idle, this tab ' +
          'not streaming, and this tab able to bound its own outstanding characters — so there is no ' +
          `sample to compare. ${SOLE_OWNERSHIP_LIMIT}`
        );
    }
  }

  /**
   * Score one report. Never sends anything and never can — it takes numbers
   * already on the wire.
   *
   * ⚠ Nothing is written to the port to make a sample happen. `5dc1b077f0` made
   * the connect path write NOTHING until a verdict, because the board on the
   * bench runs Marlin and *"harmless"* is an assumption on unidentified
   * firmware. A probe here would reintroduce exactly that.
   */
  observe(s: RingSample): void {
    if (this._verdict === 'foreign-writer') return; // sticky

    const quiescent = !s.streaming && s.state === 'Idle' && s.ourChars === 0;

    if (quiescent) {
      this._quiescentSamples += 1;
      if (this.q === null) {
        this.q = s.rxFree;
        this._verdict = 'no-disagreement';
        return;
      }
      const diff = s.rxFree - this.q;
      if (diff > RING_ARTEFACT_CHARS) {
        /* The baseline was low. Everything measured against it — the buffer
         * size included — was measured over somebody else's bytes. */
        this.fire({ kind: 'baseline-rose', chars: diff, baseline: this.q, rxFree: s.rxFree, ourChars: 0 });
        return;
      }
      if (diff > 0) {
        // Within the CAN artefact. Take the higher figure and say nothing.
        this.q = s.rxFree;
        return;
      }
      const short = this.q - s.rxFree;
      if (short > RING_ARTEFACT_CHARS) {
        this.fire({ kind: 'quiescent-dip', chars: short, baseline: this.q, rxFree: s.rxFree, ourChars: 0 });
      }
      return;
    }

    if (s.ourChars === 'unknown' || this.q === null) return;

    /* The one-sided bound. Sound in `Run`, in `Hold`, mid-stream — anywhere —
     * because it never claims to know B, only that `q ≤ B`. Weak while
     * streaming by construction: our own allowance is most of the buffer, so it
     * fires when a foreign writer exceeds our SLACK, which is the moment the
     * overrun becomes possible rather than a moment before it. */
    const unaccounted = this.q - s.rxFree - s.ourChars;
    if (unaccounted > RING_ARTEFACT_CHARS) {
      this.fire({
        kind: 'bound-exceeded',
        chars: unaccounted,
        baseline: this.q,
        rxFree: s.rxFree,
        ourChars: s.ourChars,
      });
    }
  }

  private fire(e: OwnershipEvidence): void {
    this._verdict = 'foreign-writer';
    this._evidence = e;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE REFUSAL SET
   ═══════════════════════════════════════════════════════════════════════════ */

export type RunAction =
  | 'start-job'
  | 'jog'
  | 'jog-cancel'
  | 'spindle-stop'
  | 'unlock'
  | 'resume'
  | 'auto-resume'
  | 'console-gcode';

export type RefusalId =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7'
  | 'R8' | 'R9' | 'R10' | 'R11' | 'R12' | 'R13' | 'R14';

export interface Refusal {
  id: RefusalId;
  action: RunAction;
  /** The fact — the setting, the code, the field. */
  fact: string;
  /** What the operator can do about it, in their words. Every refusal carries
   *  one: `AGENTS.md` "Refuse rather than approximate", and a refusal with no
   *  route forward is a wall, not a control. */
  why: string;
}

/**
 * Everything the tab tracks that a refusal can key on.
 *
 * 🔴 **`homingSeen` is tracked BY THE TAB and not asked of the controller.**
 * grblHAL's own lock is optional: with `$22` bit 2 (`init_lock`) clear, or bit 6
 * (`override_locks`) set on a warm start, `limits_homing_required()` is false,
 * the machine boots straight to `Idle` and **accepts the job** with machine
 * coordinates that are whatever they were at power-on. And a soft reset on such
 * a configuration drops a stale homing lock (`protocol.c:163-164`). So "not in
 * Alarm" is not "homed", and this field is the tab's own evidence: an `H:1` seen
 * in a report, or a `$H` watched to completion.
 */
export interface TrackedState {
  /** The tab's own state, not the controller's. */
  tab:
    | 'Disconnected'
    | 'Identifying'
    | 'Idle'
    | 'Homing'
    | 'Jogging'
    | 'Streaming'
    | 'Held'
    | 'Paused'
    | 'Stopping'
    | 'Aborted'
    | 'Alarm'
    | 'Door'
    | 'DisconnectedMidJob';
  controllerState: MachineState;
  controllerSubstate: number | null;
  identification: Identification | null;
  /** `H:1` seen, or a `$H` watched to completion. */
  homingSeen: boolean;
  /** `$22` bit 0. `null` = `$$` has not been read. */
  homingEnabled: boolean | null;
  positionTrusted: boolean;
  positionUntrustedWhy: string | null;
  /** A `WCO` has arrived at least once on this connection. */
  wcoKnown: boolean;
  /** Work-Z now, from the DRO. `null` when it cannot be derived. */
  currentWorkZ: number | null;
  /** The first `G0 Z` the loaded program executes, as a work coordinate. */
  programFirstZ: number | null;
  programLoaded: boolean;
  /** The bytes on screen differ from the bytes that would be streamed. */
  programDirty: boolean;
  /** `$13`. `'unknown'` before `$$` has been read. */
  reportUnits: 'mm' | 'inch' | 'unknown';
  inchReportingAcknowledged: boolean;
  streamMode: StreamMode;
  /** Second figure of `Bf`, measured while `Idle`. `null` = not measured. */
  measuredRxBuffer: number | null;
  /**
   * {@link PortOwnershipWatch}'s verdict, carried here so R14 can key on it.
   *
   * ⚠ **`'unchecked'` is the default and it is not a pass.** It is the state of
   * a tab that has not fed the watch a single scorable sample — which is also
   * the state of a tab that has not wired the watch up at all. R14 fires on
   * `'foreign-writer'` only; the limit itself is stated unconditionally in
   * {@link SOLE_OWNERSHIP_LIMIT}, because a detector nobody has wired is exactly
   * the thing a named limit outlives.
   */
  portOwnership: PortOwnershipVerdict;
  /** {@link PortOwnershipWatch.why} at the moment the verdict was taken.
   *  `null` before anything has been observed. */
  portOwnershipWhy: string | null;
  /** The controller's answer to the last `$X`, if it refused. */
  lastUnlockError: number | null;
  /** Decoded from `Pn:` — these are what make `$X` refuse (`system.c:413-443`). */
  estopAsserted: boolean;
  doorAjar: boolean;
  limitsEngaged: boolean;
  /** The link dropped while a job was running and has come back. */
  reconnectedMidJob: boolean;
  /**
   * 🔴 **The listen window closed in SILENCE and the tab has stopped, having
   * written nothing.**
   *
   * Not a verdict and not a permission: it is the tab holding
   * {@link IDENTIFY_PROBE} at the operator, byte for byte, because the only
   * remaining way to learn anything is to write to firmware nobody has
   * identified. `false` everywhere else, including while the window is still
   * open and after any verdict — a stale `true` would draw a live control that
   * writes to a board already classified.
   */
  awaitingIdentifyConsent: boolean;
}

/**
 * A `TrackedState` in the shape a freshly-connected tab has: knows nothing,
 * trusts nothing, refuses everything. Exported so a caller starts from refusal
 * rather than from a permissive default it has to remember to tighten.
 */
export function initialTrackedState(): TrackedState {
  return {
    tab: 'Disconnected',
    controllerState: 'Idle',
    controllerSubstate: null,
    identification: null,
    homingSeen: false,
    homingEnabled: null,
    positionTrusted: false,
    positionUntrustedWhy: 'nothing has established where this machine is yet.',
    wcoKnown: false,
    currentWorkZ: null,
    programFirstZ: null,
    programLoaded: false,
    programDirty: false,
    reportUnits: 'unknown',
    inchReportingAcknowledged: false,
    streamMode: 'character-counting',
    measuredRxBuffer: null,
    portOwnership: 'unchecked',
    portOwnershipWhy: null,
    lastUnlockError: null,
    estopAsserted: false,
    doorAjar: false,
    limitsEngaged: false,
    reconnectedMidJob: false,
    awaitingIdentifyConsent: false,
  };
}

/**
 * Every reason the tab will not do the thing that was asked.
 *
 * Returns ALL applicable refusals, not the first — an operator who clears one
 * and is met with another has been told the truth in the least useful order.
 *
 * The set is the design's §12 table (R1–R13) and the numbering is that table's.
 *
 * @param plant see {@link ProtocolPlant}: `'stream-unhomed'`, `'descend-first'`,
 * `'cancel-while-streaming'`, `'unlock-optimism'`, `'auto-resume'`.
 */
export function refusalsFor(
  action: RunAction,
  s: TrackedState,
  plant?: ProtocolPlant,
): Refusal[] {
  const out: Refusal[] = [];
  const add = (id: RefusalId, fact: string, why: string) => out.push({ id, action, fact, why });

  if (action === 'start-job') {
    if (!(plant === 'stream-unhomed')) {
      if (!s.homingSeen) {
        add(
          'R1',
          s.homingEnabled === false
            ? '$22 bit 0 is clear: homing is disabled on this controller.'
            : 'no H:1 has been seen and no $H has completed on this connection.',
          'Run $H and watch it finish. Without it the machine coordinates are whatever they were at power-on, soft limits bound a fictional origin, and — because grblHAL’s own homing lock is optional ($22 bits 2 and 6) — the controller may accept the job anyway. This refusal exists precisely because the controller’s is optional.',
        );
      }
      if (!s.positionTrusted) {
        add(
          'R2',
          s.positionUntrustedWhy ?? 'position is marked untrusted.',
          'Re-home ($H). $X clears the lock and restores nothing — not position, not homing, not offsets. It is permission to jog and to home; it is not permission to cut.',
        );
      }
    }

    if (s.controllerState !== 'Idle') {
      add(
        'R4',
        `the controller is ${s.controllerState}${s.controllerSubstate === null ? '' : `:${s.controllerSubstate}`}, not Idle.`,
        `Streaming into ${s.controllerState} interleaves the job with whatever is already in the planner. ${motionVerdict(s.controllerState, s.controllerSubstate).why}`,
      );
    }

    if (!s.programLoaded) {
      add('R5', 'no program is loaded.', 'Post a program in the CNC tab first.');
    } else if (s.programDirty) {
      add(
        'R5',
        'the program on screen has unsaved changes, so the bytes shown and the bytes that would be sent can differ.',
        'Re-post the program. The tab streams bytes and displays a hash of exactly those bytes at Start; a picture that is not the program is not a preflight.',
      );
    }

    if (!(plant === 'descend-first')) {
      if (!s.wcoKnown || s.currentWorkZ === null) {
        add(
          'R3',
          'the work coordinate offset has not been reported, so the current work Z is not derivable.',
          'Until a WCO arrives the tab cannot compare the program’s first Z against where the tool is now — and an unmakeable comparison is a refusal, not a pass. Check $10 bit 5 FIRST: if it is set, send a full report (0x87) and the WCO follows. If it is CLEAR no WCO will ever arrive and 0x87 cannot force one — report.c:1419 gates the whole |WCO: element on that bit and only consults the full-report flag inside the gate — so the setting has to change at the controller.',
        );
      } else if (s.programFirstZ === null) {
        add(
          'R3',
          'the program’s first Z could not be read from the loaded program.',
          'The first motion of every program this post emits is an absolute rapid to a work Z. If it cannot be read, the descent check cannot be made.',
        );
      } else if (s.programFirstZ < s.currentWorkZ) {
        add(
          'R3',
          `the program’s first move is G0 Z${s.programFirstZ.toFixed(3)} and the tool is at work Z${s.currentWorkZ.toFixed(3)} — the first motion is a DESCENT of ${(s.currentWorkZ - s.programFirstZ).toFixed(3)} mm at rapid rate.`,
          'Jog to a safe Z, or re-zero. G54 persists in the controller across power cycles, so a stale offset from the last job makes the opening rapid a plunge before anything has been probed.',
        );
      }
    }

    if (s.reportUnits === 'inch' && !s.inchReportingAcknowledged) {
      add(
        'R12',
        '$13=1: this controller reports positions in INCHES and this tab is in millimetres.',
        'A DRO wrong by 25.4× reads as a catastrophic position error and provokes exactly the wrong reaction. Set $13=0 at the controller, or acknowledge the mismatch explicitly.',
      );
    }

    if (s.streamMode === 'character-counting' && s.measuredRxBuffer === null) {
      add(
        'R13',
        'the RX buffer size has not been measured — Bf was not reported ($10 bit 1 clear, or no full report while Idle).',
        'Either enable $10 bit 1 at the controller and reconnect, or switch to send-response streaming, which will say on screen that it is in use and why. Never guess 128 (grbl) or 1024 (grblHAL) — a streamer counting against a number nobody measured is the same defect as a feed nobody derived.',
      );
    }

    /* 🔴 R14 — a second writer on the port, which needs no hub. The sibling of
     * R13 and the sharper half: R13 is "nobody measured the number", R14 is
     * "the number is wrong and nothing downstream can tell". It refuses on a
     * POSITIVE detection only — an unchecked verdict is not evidence of
     * anything, and the limit that stands in both cases is stated rather than
     * inferred from a green. See `PortOwnershipWatch`.
     *
     * ⚠ It deliberately does NOT refuse in `send-response` mode: with one line
     * outstanding at a time there is no character count to corrupt. A second
     * writer is still a hazard there — it can feed-hold the machine and it
     * steals replies — but it is not THIS refusal's hazard, and a refusal that
     * fires where its reason does not apply is the one operators learn to
     * click past. */
    if (s.portOwnership === 'foreign-writer' && s.streamMode === 'character-counting') {
      add(
        'R14',
        s.portOwnershipWhy ??
          'a second program is writing to this port, so this tab’s character count undercounts the controller’s buffer by exactly that program’s bytes.',
        'Close the other program, then disconnect and reconnect. Reconnecting is what re-takes the buffer measurement, which was taken from Bf and may itself have been read while the other program’s bytes were in the buffer. Do not widen the margin instead: the number is wrong, not tight, and a safety factor over a wrong number is a green that means less than it did before.',
      );
    }

    if (s.identification !== 'grblHAL') {
      add(
        'R1',
        `this controller identified as ${s.identification ?? 'nothing yet'}, not grblHAL.`,
        'Our post targets grblHAL and the differences are not cosmetic — RX buffer size, alarm codes, and error persistence. Read-only only.',
      );
    }
  }

  if (action === 'jog') {
    if (s.tab === 'Streaming' || s.tab === 'Held') {
      add(
        'R6',
        `the tab is ${s.tab}.`,
        'Jogging and streaming are mutually exclusive: g-code is locked out during Jog (error:9, protocol.c:255), and the jog-cancel byte flushes the controller’s RX buffer, which destroys the stream. Stop the job first.',
      );
    }
    if (s.controllerState === 'Alarm') {
      add(
        'R6',
        'the controller is in Alarm, where even $J= is refused with error:9.',
        'Unlock ($X) first — and note that after unlocking, position is untrusted until $H completes.',
      );
    }
  }

  if (action === 'jog-cancel') {
    if (!(plant === 'cancel-while-streaming') && s.controllerState !== 'Jog') {
      add(
        'R7',
        `0x85 (jog cancel) outside Jog: the controller is ${s.controllerState}.`,
        'It sets char_counter = 0 and flushes the RX buffer (protocol.c:894-897) — queued g-code is discarded and the sender’s character count silently becomes a lie. At a tool-change pause, cancel a jog by stopping the sends and letting the queue drain; never with 0x85.',
      );
    }
  }

  if (action === 'spindle-stop') {
    if (s.controllerState !== 'Hold') {
      add(
        'R8',
        `0x9E (spindle stop override) outside Hold: the controller is ${s.controllerState}.`,
        'grblHAL allows it only while in HOLD (protocol.c:726-727). Elsewhere it is silently ignored, and a control that silently does nothing is worse than one that is greyed out.',
      );
    }
  }

  if (action === 'unlock') {
    if (!(plant === 'unlock-optimism')) {
      /* 🔴 ALL FIVE codes check_status can return, not just 46.
       * `$X` refuses through one `else if` chain (system.c:413-445) and 46 is
       * the LAST arm — so it is the code that means "nothing else is wrong".
       * Keying only on 46 (as this did until 2026-08-11) left the four
       * conditions that OUTRANK it — a failed self test, an e-stop, an open
       * door, a held reset — rendering as a generic unknown error, while the
       * only advice on screen was "run $H", which is the fix for the case that
       * is not happening. The `Pn`-derived checks below are a DIFFERENT
       * channel, not a substitute: `Pn` is absent entirely under $10=1, where
       * the reply code is the only evidence there is. */
      const refusal = UNLOCK_REFUSAL_ORDER.find((u) => u.code === s.lastUnlockError);
      if (refusal) {
        const spec = ERRORS.get(refusal.code);
        const tail =
          refusal.code === 46
            ? 'Run $H. The lock is not stuck and nothing is broken.'
            : '⚠ This code is returned BEFORE 46 in check_status, so the homing question has not been reached yet — expect error:46 next once this is cleared. Something IS wrong here; do not read it as a stuck unlock.';
        add(
          'R9',
          `the controller answered error:${refusal.code} — "${spec?.text ?? refusal.id}"`,
          `$X is REFUSED (system.c:413-445): it is cleared by ${refusal.clearedBy} ${tail}`,
        );
      } else if (s.lastUnlockError !== null) {
        add(
          'R9',
          `the controller answered error:${s.lastUnlockError} to $X, which is not one of the five codes check_status can return (49, 50, 13, 18, 46).`,
          'Something other than the unlock precondition chain refused it. Read the code with $EE and route it to pcb rather than pressing $X again.',
        );
      }
      if (s.estopAsserted) {
        add('R9', 'an e-stop is asserted (Pn).', 'Release the physical e-stop, then reset.');
      }
      if (s.doorAjar) {
        add('R9', 'the safety door is ajar (Pn).', 'Close the door.');
      }
      if (s.limitsEngaged) {
        add('R9', 'a limit switch is engaged (Pn).', 'Clear the switch by hand, then $X.');
      }
    }
  }

  if (action === 'resume') {
    if (s.tab === 'Aborted' || s.tab === 'Alarm' || s.controllerState === 'Alarm') {
      add(
        'R10',
        'the job aborted or the controller is in Alarm.',
        'There is nothing to resume — the controller’s buffer is gone. Clear the alarm, re-home, and start the job again.',
      );
    }
  }

  if (action === 'auto-resume') {
    if (!(plant === 'auto-resume')) {
      add(
        'R11',
        s.reconnectedMidJob
          ? 'the link dropped while a job was running.'
          : 'automatic resumption is never offered.',
        'The sender’s idea of which line was executing was never better than "somewhere in the last buffer-full" (up to ~1024 characters, 40–70 of our lines), and after a drop it is not even that. A human decides what happens next, from the machine’s current state.',
      );
    }
  }

  if (action === 'console-gcode') {
    add(
      'R5',
      'the console accepts $ commands and realtime bytes only.',
      'A console that accepts arbitrary g-code is a motion-control surface with no preflight — none of R1–R4 or R12 would have run. Load a program instead.',
    );
  }

  return out;
}

/** Convenience: may this action proceed? */
export function permitted(action: RunAction, s: TrackedState, plant?: ProtocolPlant): boolean {
  return refusalsFor(action, s, plant).length === 0;
}
