// The `Run` tab — execute and monitor the machine.
//
// Founder, TODO #76: *"1st tab cad, 2nd tab CNC, 3rd tab operation, this is
// where I will execute and monitor the CNC router?"*. Named `Run` (#76:
// `Operation` already names a panel inside the CNC tab and the word the emitted
// program uses). Specified in `docs/design-76-run-tab.md`, which read grblHAL's
// own C for every controller claim it makes; every §/R/F reference below points
// into it. **Read the design before changing behaviour here** — a number in this
// file that disagrees with it is a defect in this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT HAS NEVER HAPPENED, SAID BEFORE ANYTHING ELSE
// ─────────────────────────────────────────────────────────────────────────────
//
// **Nothing in this tab has ever talked to a machine.** There is no browser on
// the box it was written on, no WebGL, no serial device — and the router is
// ORDERED, NOT ARRIVED (`ops`, delivery estimated 2026-09-30). Every check that
// exists for this file runs in node against `run/fake.ts`. A green from a
// simulated port is a green about **this lane's own reading of grblHAL** and
// nothing else: the fake was written from grblHAL's source by the same lane that
// wrote the tab, so it can show the tab agrees with that reading and can never
// discover the reading is wrong. `CTRL` and the physical rungs (design §19) are
// what would prove more, and they are unclimbed.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE THREE RULES THIS FILE IS BUILT AROUND
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. **`Stop` is not an emergency stop.** It is a request over a link, and the
//     link is exactly what fails in the emergency it is wanted for. That refusal
//     lives in {@link StopPanel} as a PERMANENT LINE — not a tooltip, not a
//     modal that gets dismissed once — with the design's own list of the seven
//     things it does not guarantee. The string that must never label a control
//     appears exactly once in this file, in the sentence banning it.
//  2. **A prediction and a measurement never render identically.** `#70`
//     animates predicted progress from the program's feeds; this tab knows where
//     the tool actually is, from the DRO. They are drawn in two visual languages
//     — filled circle vs dashed square outline — because colour alone dies in a
//     sunlit shed and in a colourblind eye, and the move-class colours are the
//     instrument-safety set `brand` deliberately kept out of the palette.
//  3. **Do not offer a control the state does not allow.** A disabled button
//     that says *why* beats a live one that fails at the controller. The reasons
//     come from `run/protocol.ts`'s refusal set — this file renders them and
//     decides none of them — and the default `TrackedState` knows nothing,
//     trusts nothing and refuses everything, so the failure direction is safe.
//     🔴 **AND A CONTROL WITH NO IMPLEMENTATION BEHIND IT IS DISABLED BY THE
//     SAME MACHINERY** ({@link unbuiltRefusal}): the "is this built?" question is
//     answered from the ACTION MAP itself, not from a list somebody maintains, so
//     a button added without an action disables itself and says so. That defect
//     was live in this file — `Start` was drawn, enabled by the protocol gate,
//     and wired to nothing — and an enabled control that does nothing reads as
//     *"the machine did not respond"*, which sends an operator to look at the
//     machine for a fault that is in the software.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE START GUARD LIVES, AND WHY IT IS NOT ON THE BUTTON
// ─────────────────────────────────────────────────────────────────────────────
//
// The disabled button is a PICTURE of the refusal set, rendered at the last
// render. The guard is {@link startCommands}, which recomputes
// `refusalsFor('start-job', …)` **at the moment the commands would be built** and
// returns the refusals instead of the commands. Nothing else in this file can
// produce a `load`/`start` pair, so there is exactly one door and it is checked
// on the way through — not on the way to being drawn. {@link RunTabPlant}
// (`'start-ignores-refusals'`) reintroduces the defect on demand, because a
// guard nobody has watched fail is not a guard.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM
// ─────────────────────────────────────────────────────────────────────────────
//
// `run/protocol.ts` owns the status parse, the DRO derivation, the machine-state
// model, the alarm and error tables, the realtime byte table and the refusal
// set. `run/transport.ts` owns the port and the write loop. **This file owns the
// picture and nothing else** — it computes no controller fact it was not handed,
// and where it adds a gate of its own ({@link uiStateGate}) it says so and says
// which line of the design's §15 table it is enforcing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyInbound,
  decodeHomingConfig,
  decodePins,
  decodeReportMask,
  deriveDro,
  describeAlarm,
  handshakeDecision,
  IDENTIFY_PROBE,
  initialTrackedState,
  missingFieldNote,
  motionVerdict,
  PortOwnershipWatch,
  positionTrustAfterAlarm,
  realtimeRefusal,
  refusalsFor,
  REALTIME,
  type Dro,
  type Inbound,
  type IdentificationVerdict,
  type MachineState,
  type ProbeStep,
  type RealtimeName,
  type Refusal,
  type ReportMask,
  type RunAction,
  type StatusReport,
  type StreamAbort,
  type StreamMode,
  type TrackedState,
} from './run/protocol';
import {
  classifyPortError,
  lineCost,
  pollPlan,
  serialAvailability,
  type Availability,
  type PollPlan,
  type SerialLike,
  type WorkerCommand,
  type WorkerEvent,
} from './run/transport';

/* `droRendering` is exported from this module and takes a `Dro`. An exported
 * signature whose parameter type cannot be named from the same module leaves a
 * caller to go and find the type elsewhere, or to widen it — so the type travels
 * with the function. A re-export, not a second definition: `run/protocol.ts`
 * stays the only place `Dro` is declared. */
export type { Dro };

/* ────────────────────────────────────────────────────────────────────────────
 * Controls, and how each one asks whether it is allowed
 * ──────────────────────────────────────────────────────────────────────────── */

export type ControlId =
  | 'connect'
  /** 🔴 The one control whose whole purpose is to write to firmware nobody has
   *  identified. It exists so that write is a decision somebody made after
   *  reading the bytes — see {@link identifyProbeCommands}. */
  | 'identify'
  | 'start'
  | 'hold'
  | 'resume'
  | 'stop'
  | 'abort'
  | 'spindle-stop'
  | 'jog'
  | 'jog-cancel'
  | 'home'
  | 'zero'
  | 'unlock';

/** How a control is rendered when it is not available. */
export interface ControlRefusal {
  id: string;
  why: string;
}

/** The controls whose refusal is a decision `run/protocol.ts` already models. */
const ACTION_OF: Partial<Record<ControlId, RunAction>> = {
  start: 'start-job',
  resume: 'resume',
  jog: 'jog',
  'jog-cancel': 'jog-cancel',
  'spindle-stop': 'spindle-stop',
  unlock: 'unlock',
};

/**
 * The two gates that are the TAB's rather than the protocol's.
 *
 * Design §15's control table says `$H` is allowed from `Idle` **and `Alarm`** —
 * `system.c:486` permits both, and that is the whole recovery path — and that
 * zeroing (`G10 L20`) is `Idle` only, because it writes the controller's
 * non-volatile storage and every later coordinate is measured from it.
 *
 * They are here rather than in the refusal set because they are not refusals in
 * the design's sense: they are the table's own "Allowed in" column, and inventing
 * `R14`/`R15` for them would put numbers in the UI that the design does not
 * carry. ⚠ If `run/protocol.ts` grows `RunAction`s for them, delete this.
 */
export function uiStateGate(control: ControlId, s: TrackedState): ControlRefusal | null {
  const st = s.controllerState;
  if (s.tab === 'Disconnected' && control !== 'connect') {
    return { id: 'link', why: 'Not connected. Nothing here can reach a controller.' };
  }
  switch (control) {
    /* 🔴 THE PROBE IS OFFERED IN EXACTLY ONE STATE. `awaitingIdentifyConsent`
     * is set only when the listen window closed in silence and nothing has been
     * written; anywhere else this control would put `$I`/`0x87`/`$$` on a wire
     * for no reason — at a board already identified, or in the middle of the
     * window whose whole point is that nobody is speaking over it. */
    case 'identify':
      return s.awaitingIdentifyConsent
        ? null
        : {
            id: '§11',
            why:
              s.identification != null
                ? `This controller has already identified itself as ${s.identification}. There is nothing left to ask.`
                : 'There is nothing to ask yet. This is offered only when the listen window has closed with nothing received — until then the tab is listening, and writing over that is how a banner gets lost.',
          };
    case 'home':
      return st === 'Idle' || st === 'Alarm'
        ? null
        : {
            id: '§15',
            why: `$H is allowed from Idle and Alarm; the machine is ${st}. It is a long blocking motion and reports are suppressed while it runs ($10 bit 12, off by default) — expect silence, not a lost link.`,
          };
    case 'zero':
      return st === 'Idle'
        ? null
        : {
            id: '§15',
            why: `Zeroing writes G10 L20 to the controller's non-volatile storage and is Idle-only; the machine is ${st}.`,
          };
    case 'stop':
      return s.tab === 'Streaming' || s.tab === 'Held' || s.tab === 'Jogging'
        ? null
        : {
            id: '§15',
            why: 'Nothing is running. Stop asks the controller to stop what it is doing, and it is doing nothing.',
          };
    default:
      return null;
  }
}

/**
 * 🔴 THE CONTROL IS DRAWN AND NOTHING IS BEHIND IT.
 *
 * Answered from the ACTION MAP the tab is actually rendering with — never from a
 * hand-kept list, because a hand-kept list is exactly what was missing when
 * `Start` shipped enabled and inert. A button whose `onClick` reaches nothing
 * looks identical to a button whose command was ignored by the controller, and
 * on this tab those two send an operator to completely different places: one is a
 * software gap, the other is a machine at fault.
 *
 * `implemented === undefined` means *the caller did not ask* — used by tests that
 * are interrogating the STATE rules alone. {@link RunTab} always asks.
 */
export function unbuiltRefusal(
  control: ControlId,
  implemented: ReadonlySet<ControlId> | undefined
): ControlRefusal | null {
  if (!implemented || implemented.has(control)) return null;
  return {
    id: 'not built',
    why:
      'This control is drawn and has nothing behind it — it sends no byte and reaches no ' +
      'controller. It is disabled rather than live, because an enabled control that does ' +
      'nothing reads as “the machine did not respond”.',
  };
}

/**
 * Every reason this control is not offered right now.
 *
 * Delegates: the refusal set to `run/protocol.ts`'s {@link refusalsFor}, the
 * realtime state rules to its {@link realtimeRefusal} (`0x85` only in `Jog`,
 * `0x9E` only in `Hold` — grblHAL ignores them elsewhere, and *a control that
 * silently does nothing is worse than one that is greyed out*), only the §15
 * table's two rows to {@link uiStateGate}, and the "is anything behind this
 * button" question to {@link unbuiltRefusal}.
 */
export function controlRefusals(
  control: ControlId,
  s: TrackedState,
  implemented?: ReadonlySet<ControlId>
): ControlRefusal[] {
  const out: ControlRefusal[] = [];
  const unbuilt = unbuiltRefusal(control, implemented);
  if (unbuilt) out.push(unbuilt);
  const gate = uiStateGate(control, s);
  if (gate) out.push(gate);

  const action = ACTION_OF[control];
  if (action) {
    for (const r of refusalsFor(action, s)) out.push({ id: r.id, why: `${r.fact} ${r.why}` });
  }
  if (control === 'jog-cancel') {
    const rt = realtimeRefusal('jogCancel', s.controllerState);
    if (rt) out.push({ id: '0x85', why: rt });
  }
  if (control === 'spindle-stop') {
    const rt = realtimeRefusal('spindleStop', s.controllerState);
    if (rt) out.push({ id: '0x9E', why: rt });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The program
 * ──────────────────────────────────────────────────────────────────────────── */

/** One point on the toolpath, as the CNC tab would hand it over. */
export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** mm/min for a feed move; `rapid` moves run at the machine's rapid rate. */
  feed: number;
  rapid: boolean;
  /** Index into {@link RunProgram.lines} that produced this point. */
  line: number;
}

export interface RunProgram {
  name: string;
  lines: readonly string[];
  path: readonly PathPoint[];
  /** Shown at Start, so the picture and the bytes cannot diverge (R5). */
  hash: string;
  /** The machine's rapid rate, mm/min. Rapids advance the clock and cut nothing. */
  rapidRate: number;
}

/** One `<letter><number>` word. `G38.2` is one word with value 38.2. */
export function words(line: string): { letter: string; value: number }[] {
  /* Comments first: grblHAL strips `(…)` and everything after `;`, and a Z
   * inside a comment is not a Z word. `( TOOL CHANGE -> 6mm Z ... )` is a real
   * line this post emits.
   *
   * 🔴 DEPTH-COUNTED, NOT REGEXED — corrected 2026-08-28. `replace(/\([^)]*\)/g)`
   * disagreed with the core's `feeds::strip_comments` on two inputs, and this
   * function feeds `firstProgramZ`, which is gate RUN's R3:
   *
   *   `( a ( b ) c )`  regex removes `( a ( b )` and leaves `c )` AS CODE.
   *   `( unterminated` regex removes NOTHING; the core drops the rest of the line.
   *
   * A `Z` left standing in comment text is read as a Z word, and R3's answer is
   * about the first Z the program commands.
   *
   * ⚠ **THE COMMIT THAT MADE THIS CHANGE SAID "two inputs THIS POST CAN
   * PRODUCE". THAT WAS FALSE** and is corrected here rather than left standing:
   * `post_grblhal::sanitize` maps `(` and `)` to `_` at all three comment sites,
   * and nothing else in `core/` or `cli/` writes a `(` into a program — so this
   * post cannot emit a nested or an unterminated comment. The guard is still
   * right, and its reason is the weaker one: it keeps the browser's reader
   * COMPARABLE to the core's, so the two cannot answer differently about a
   * program neither of them wrote. A sender is pointed at files this lane did
   * not emit.
   *
   * ⚠ NOT shared with the core: this file cannot import Rust, and the wasm does
   * not export a line-level stripper. What is shared is the RULE, restated here
   * — `(` nests, `;` counts only at depth 0 — AND A TABLE OF CASES BOTH READERS
   * ARE RUN AGAINST: `web/tests/word-scan-cases.json`.
   *
   * 🔴 THAT TABLE DID NOT EXIST FOR A DAY WHILE `feeds.rs` SAID IT DID. Its
   * census claimed the rule was "restated there with a test comparing the two",
   * and there was no such test — a claim of coverage is what stops the next
   * reader looking. When one was finally written, the readers disagreed on FIVE
   * inputs, every one of them a block grblHAL refuses:
   *
   *   `X1.2.3`  browser 1.2  — a confident, plausible DEPTH — core NaN
   *   `X10-20`  browser 10, `-20` discarded silently
   *   `XY10`    browser dropped `X` entirely
   *   `X-`, `X` browser dropped them entirely
   *
   * `words()` feeds `firstProgramZ`, which is gate RUN's R3, and R3's left-hand
   * side is a DEPTH. On a file this lane did not emit — the stated use case —
   * `G1 Z-1.2.3` handed R3 a plausible `-1.2` where the core refuses. */
  let bare = '';
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) break;
    else if (depth === 0) bare += ch;
  }
  bare = bare.toUpperCase();
  const out: { letter: string; value: number }[] = [];
  /* 🔴 LETTER-DRIVEN, NOT MATCH-DRIVEN — a port of `feeds::word_value_at`, and
   * the difference is the whole defect. A global regex is free to SKIP the text
   * it cannot match: on `XY10` it abandoned `X` and matched at `Y`, so a word
   * this reader could not read looked like a word that was never written. The
   * core walks letter by letter and every letter yields a word, NaN or not, so
   * the caller can refuse.
   *
   * A leading `+` is part of the value (grbl's own `read_float` takes one) and a
   * sign anywhere else is not — `X10-20` is `error:20` on the controller, so it
   * is NaN here rather than a truncated `10`. */
  let i = 0;
  while (i < bare.length) {
    const c = bare[i];
    if (c < 'A' || c > 'Z') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < bare.length && (bare[j] === ' ' || bare[j] === '\t')) j += 1;
    const start = j;
    if (j < bare.length && (bare[j] === '-' || bare[j] === '+')) j += 1;
    while (j < bare.length && ((bare[j] >= '0' && bare[j] <= '9') || bare[j] === '.')) j += 1;
    // Nothing numeric at all, or a run terminated by a byte that cannot begin a
    // new word: both are words this reader cannot use, and both are NAMED.
    const terminated = j >= bare.length || /[A-Z\s()]/.test(bare[j]);
    if (j === start || !terminated) {
      out.push({ letter: c, value: NaN });
      i += 1;
      continue;
    }
    out.push({ letter: c, value: Number(bare.slice(start, j)) });
    i = j;
  }
  return out;
}

/**
 * The work-Z the program's **first motion** goes to — R3's left-hand side.
 *
 * 🔴 **READ OFF THE EMITTED TEXT, never off the render.** `AGENTS.md`: *assert on
 * the emitted program, never on the setting that was supposed to produce it*. The
 * bytes are what the controller receives; the path is a flattened picture of what
 * this app believes they mean, and R3 is a claim about what the machine will do.
 *
 * 🔴 **AND IT REFUSES RATHER THAN APPROXIMATES.** `null` — which makes R3 refuse
 * the job with *"the program's first Z could not be read"* — for every case where
 * the number would not be a work-Z in millimetres:
 *
 *  - a `G91` before the first motion: the value is a distance, not a coordinate;
 *  - a `G20`: the value is in inches and the DRO is in millimetres;
 *  - a `G53` on the motion line: the value is a MACHINE coordinate, and comparing
 *    it against a work-Z is the double-frame error F1 records in the post;
 *  - a first motion that is not a `G0`, or one carrying no `Z` word at all.
 *
 * Every program `post_grblhal.rs` emits opens `G17 G21 G90 G54 …` then
 * `G0 Z<safe_z + z_offset>` (design F3), so the supported case is the one that
 * ships — and anything else is somebody else's program, which is exactly when a
 * guess would be worst.
 */
export function firstProgramZ(lines: readonly string[]): number | null {
  let incremental = false;
  for (const line of lines) {
    const ws = words(line);
    if (!ws.length) continue;
    /* 🔴 A WORD THIS READER COULD NOT READ REFUSES THE WHOLE ANSWER. `words()`
     * now yields NaN for such a word rather than dropping it (see its header),
     * and R3's left-hand side is a DEPTH — so `G1 Z-1.2.3` must give R3 nothing
     * rather than a plausible number. Refusing here and not at the `Z` alone,
     * because an unreadable `G` decides which branch this block takes. */
    if (ws.some((w) => !Number.isFinite(w.value))) return null;
    const gs = ws.filter((w) => w.letter === 'G').map((w) => w.value);
    if (gs.includes(20)) return null; // inches
    if (gs.includes(91)) incremental = true;
    if (gs.includes(90)) incremental = false;
    const motion = gs.find((v) => v === 0 || v === 1 || v === 2 || v === 3 || Math.floor(v) === 38);
    if (motion === undefined) continue;
    // The first motion of the program decides. Anything after it is downstream
    // of a move that has already happened.
    if (incremental || gs.includes(53) || motion !== 0) return null;
    const z = ws.find((w) => w.letter === 'Z');
    return z && Number.isFinite(z.value) ? z.value : null;
  }
  return null;
}

/**
 * The tracked state with the facts the HELD PROGRAM contributes folded in.
 *
 * `run/protocol.ts` keys R5 on `programLoaded` and R3 on `programFirstZ`, and
 * nothing was ever setting either: the tab took a `program` prop and its refusal
 * set never saw it, so *"no program is loaded"* was rendered underneath a drawn
 * toolpath. This is the join.
 *
 * ⚠ **`programDirty` is FALSE and that is a claim, not a default.** `App.tsx`
 * latches the program at an explicit hand-over (`runProgram.ts`) and nothing —
 * not a re-plan, not a material change — rewrites what this tab holds. So the
 * bytes on screen here and the bytes that would be streamed are the same bytes.
 * A newer plan makes the held program *stale*, which is a different fact and is
 * reported in the CNC tab, not here. **If that latch is ever removed, this line
 * is a lie and R5 stops guarding.**
 */
export function trackedForProgram(base: TrackedState, program: RunProgram | null): TrackedState {
  return {
    ...base,
    programLoaded: !!program,
    programFirstZ: program ? firstProgramZ(program.lines) : null,
    programDirty: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Starting a job — the one door that produces a `load`/`start` pair
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 THE DEFECT THIS FILE EXISTS TO PREVENT, REINTRODUCED ON DEMAND.
 *
 * Same idiom as `runProgram.ts::RunHandoffPlant` and the CLI's `--plant`: a guard
 * is invisible while it works, so a test that has only ever seen `startCommands`
 * refuse establishes nothing about whether the refusal is what stopped it.
 */
export type RunTabPlant =
  /** Build the stream commands even though a refusal applies. This is R1–R13
   *  defeated in one line — a job streamed at an unhomed machine, or one whose
   *  first move is a plunge. */
  | 'start-ignores-refusals'
  /** The console sends what was typed even though a refusal applies — arbitrary
   *  g-code with none of the Start preflight behind it, a `$` mid-stream, a
   *  `0x85` outside `Jog`. {@link consoleAction} */
  | 'console-ignores-refusals'
  /** A realtime byte is sent as a LINE: the byte plus a newline, charged against
   *  the character allowance and answered with an `ok` the sender did not earn.
   *  {@link consoleAction}, {@link chargedCharacters} */
  | 'realtime-as-line'
  /** The DRO renders a reading as current when no report has arrived for longer
   *  than the interval one is expected in. {@link droRendering} */
  | 'stale-reads-current'
  /**
   * 🔴 **The defect this tab shipped with until 2026-08-11: the identification
   * probe goes out at connect, unasked.** Restores
   * {@link connectCommands} to what it was — `$I`, `0x87` and `$$` written to
   * firmware nobody has classified, two seconds before anything classifies it.
   * {@link connectCommands}
   */
  | 'probe-unasked';

export const RUN_TAB_PLANTS: RunTabPlant[] = [
  'start-ignores-refusals',
  'console-ignores-refusals',
  'realtime-as-line',
  'stale-reads-current',
  'probe-unasked',
];

/**
 * 🔴 FOR WHOEVER WIRES GATE `RUN` — the branches this file's behaviour needs,
 * written out here because the design's §18 table stops at `RUN-18` and these
 * did not exist when it was written.
 *
 * The design's own rule applies to all of them: *every `--plant` must be
 * verified to actually plant*, and the control asserts the **VERDICT** line, not
 * the gate's message. Every plant named below has been watched go red — the runs
 * are in the commit body. ⚠ *This sentence said "all four" while the table held
 * six rows and five distinct plants; a count in prose beside a list is the one
 * number nobody re-reads.* `RUN-19`–`RUN-24` are exercised in
 * `web/tests/run-status-console.test.ts`; `RUN-25` in `web/tests/run.test.ts`.
 *
 * | Branch | What it asserts | `--plant` |
 * |---|---|---|
 * | `RUN-19` | A status poll never queues in front of the cut: 50 ticks against a link whose writes do not resolve put **one** byte on the wire, and a full character-counted stream with the poller interleaved overruns nothing and executes only its own lines | `poll-on-the-clock` (drop `StatusPoller`'s in-flight guard) |
 * | `RUN-20` | The first request of every connection — and of every reconnect — is `0x87`, on the wire as one byte, because `WCO`/`Ov`/`H` are change-only and R1/R3 key on them | `poll-plain-only` (never send the full report) |
 * | `RUN-21` | A DRO older than the expected report interval renders as **last known with its age**, and never as current; `$481` decides that interval where it is set and the poll period where it is not; silence during `Home` is marked expected and not loud | `stale-reads-current` |
 * | `RUN-22` | Every route out of the console goes through `refusalsFor`/`realtimeRefusal` — g-code refused, `$` outside `Idle` refused, any line mid-stream refused, `0x85` outside `Jog` refused — with the protocol module's own sentences, not a paraphrase | `console-ignores-refusals` |
 * | `RUN-23` | A realtime byte is charged **nothing** against the character allowance, and sending one as a line desynchronises the sender against the fake (the spurious `ok` from the empty line it leaves behind) | `realtime-as-line` |
 * | `RUN-24` | `/reset` sends nothing on the first press and shares the `Abort` confirmation latch — the console is not a cheaper path to a lost position | `console-ignores-refusals` |
 * | `RUN-25` | A second program on the port reaches the **screen and R14**, not just the watch: the individual `Bf` samples are scored as well as summed, `ourChars` bounds every channel this tab writes on, and `0x85`/`0x18` make it `'unknown'` rather than a reassuring zero | in-test (five: the observe call removed · the count restricted to the streamer · `reset` dropped from the flush set · the verdict not copied into `TrackedState` · the sentence dropped from the render) |
 *
 * ⚠ **`RUN-18` remains UNMEASURED and none of these touches it.** The poll timer
 * moved from the page into the worker, which is a real improvement over a page
 * timer and is *not* a measurement: whether a worker of a hidden page keeps its
 * `setInterval` has not been observed by this lane. Nothing above may be read as
 * evidence about it, and the pump itself was not changed — `StatusPoller` writes
 * through the same `Link` and never touches `Streamer`.
 */
export const RUN_TAB_GATE_BRANCHES = [
  'RUN-19',
  'RUN-20',
  'RUN-21',
  'RUN-22',
  'RUN-23',
  'RUN-24',
  'RUN-25',
] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * The handshake, as commands rather than as sends
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 **WHAT GOES ON THE WIRE WHEN THE PORT OPENS: NOTHING.**
 *
 * This function returns an empty list and that emptiness is the fix. Until
 * 2026-08-11 the connect path posted `$I`, then realtime `0x87`, then `$$`, and
 * *then* waited two seconds and asked {@link identify} what it was talking to —
 * three writes to firmware nobody had classified, decided by nobody.
 *
 * The reasoning that made that look safe was **"they are harmless"**, and it is
 * an assumption rather than a measurement. It is true of grblHAL and of Marlin.
 * It is not a property of `$`: `$` is not a universal no-op, and on some
 * firmwares it prefixes a parameter **write**. The board on the bench in August
 * 2026 identifies itself over USB as `BLACK_F407VE CDC in FS Mode` — the string
 * the **Arduino core for STM32** emits, where grblHAL's `usbd_desc.c` hardcodes
 * `"STM32 Virtual ComPort"` — so what it does with `$I` is not something this
 * lane knows, and "probably nothing" is not the standard this tab is held to
 * anywhere else.
 *
 * ⚠ **It is also the one place our code did to a machine exactly what a human
 * inspector was forbidden from doing by hand.** That asymmetry is the finding,
 * not the individual bytes.
 *
 * So: open, read, and let the board speak first. If it says nothing, ask the
 * operator — {@link Connection.identifyNow} — never the wire.
 *
 * @param plant `'probe-unasked'` restores the pre-fix behaviour verbatim.
 */
export function connectCommands(plant?: RunTabPlant): readonly WorkerCommand[] {
  if (plant === 'probe-unasked') return identifyProbeCommands();
  return [];
}

/**
 * How long the tab listens before it decides it has heard nothing.
 *
 * ⚠ It bounds a **wait**, never a stream. Design §11 step 1 says ~2 s for an
 * unsolicited banner; nothing about a job is timed anywhere in this file.
 */
export const LISTEN_WINDOW_MS = 2000;

/**
 * The offer, rendered from {@link IDENTIFY_PROBE} rather than written beside it.
 *
 * 🔴 **Consent to bytes nobody listed is not consent.** If this text were its
 * own prose it would drift from {@link identifyProbeCommands} the first time a
 * step changed, and the operator would be authorising one thing while another
 * went out — which is a worse position than never having asked.
 */
export function describeProbe(probe: readonly ProbeStep[] = IDENTIFY_PROBE): string {
  return (
    'Nothing has been written to this port. Asking this board to identify itself means writing ' +
    'to firmware nobody has classified, so here is exactly what would go out:\n' +
    probe.map((s) => `    ${s.bytes}  — ${s.asks}\n        on unidentified firmware: ${s.onUnknownFirmware}`).join('\n') +
    '\n🔴 “Read-only” above is a fact about grblHAL and about nothing else. `$` is not a universal ' +
    'no-op — on some firmwares it prefixes a parameter WRITE. The zero-risk alternative is to RESET ' +
    'or power-cycle the controller, which makes it announce itself and needs no bytes from us.'
  );
}

/**
 * The probe itself, in wire order, matching {@link IDENTIFY_PROBE} step for step.
 *
 * ⚠ **Exported so a test can assert the two lists agree.** `IDENTIFY_PROBE` is
 * what the operator READS; this is what is SENT, and a consent screen that
 * describes different bytes from the ones that go out is worse than no consent
 * screen — it converts an informed decision into a mis-informed one.
 */
export function identifyProbeCommands(): readonly WorkerCommand[] {
  return [
    { t: 'write', line: '$I' },
    { t: 'realtime', name: 'statusReportAll' },
    { t: 'write', line: '$$' },
  ];
}

/**
 * The settings read, moved to AFTER the verdict.
 *
 * Design §11 step 4 — `$$` for `$10`/`$13`/`$22`/`$481` — is not dropped, it is
 * re-ordered. It was step 4 of a handshake whose steps 2 and 3 already wrote to
 * an unidentified board, so nothing about its position was load-bearing; here it
 * runs against firmware that has been classified, which is the only state in
 * which "reading `$$` is safe" is a fact rather than a hope.
 *
 * `permits: 'nothing'` returns an empty list. That is not defensive coding: the
 * refusal path closes the port, and a command list built there would be bytes
 * queued at a board we have just decided not to talk to.
 */
export function afterVerdictCommands(v: IdentificationVerdict): readonly WorkerCommand[] {
  if (v.permits === 'nothing') return [];
  const out: WorkerCommand[] = [];
  /* Only grblHAL. `0x87` is grblHAL's full-report request; grbl 1.1 has no such
   * realtime command, and this branch is reached precisely because the board
   * said it is NOT grblHAL. */
  if (v.verdict === 'grblHAL') out.push({ t: 'realtime', name: 'statusReportAll' });
  out.push({ t: 'write', line: '$$' });
  return out;
}

export type StartOutcome =
  | { status: 'refused'; refusals: readonly Refusal[]; why: string }
  | { status: 'ok'; commands: readonly WorkerCommand[]; hash: string; total: number };

/**
 * The commands that start a job, or the reasons there are none.
 *
 * 🔴 **NOTHING MAY STREAM WHILE ANY REFUSAL APPLIES**, and this is where that is
 * enforced — not at the button. The disabled button is a picture drawn at the
 * last render; this runs when the bytes would be built. `refusalsFor` returns
 * ALL applicable refusals (design §12, R1–R13) and any one of them is a stop:
 * an operator who clears one and meets another has at least been told the truth,
 * whereas a control that streams on a stale picture has not.
 *
 * The buffer size comes from `TrackedState.measuredRxBuffer` — measured from
 * `Bf` while `Idle` ({@link measureBuffers}), never guessed. R13 is the refusal
 * that stands when it has not been measured, so by the time this function
 * returns commands in `character-counting` mode the number is a measurement.
 *
 * ⚠ It returns `WorkerCommand`s rather than sending them: the send needs a live
 * `Worker`, which node has none of, and a decision nobody can test is a decision
 * nobody has watched refuse.
 */
export function startCommands(
  program: RunProgram | null,
  s: TrackedState,
  plant?: RunTabPlant
): StartOutcome {
  const refusals = refusalsFor('start-job', s);
  if (!program) {
    /* Not reachable through the tab — `trackedForProgram` keeps `programLoaded`
     * and the prop in step, so R5 has already fired — but a caller can hand this
     * function a permissive state and no program, and the answer must not be a
     * `load` with an empty line list. */
    const missing: Refusal = {
      id: 'R5',
      action: 'start-job',
      fact: 'no program has been handed to this tab.',
      why: 'Hand a program over from the CNC tab. There are no bytes to stream and nothing to draw.',
    };
    return {
      status: 'refused',
      refusals: [...refusals, missing],
      why: `${missing.fact} ${missing.why}`,
    };
  }
  if (refusals.length > 0 && plant !== 'start-ignores-refusals') {
    return {
      status: 'refused',
      refusals,
      why: refusals.map((r) => `${r.id} — ${r.fact} ${r.why}`).join(' '),
    };
  }
  return {
    status: 'ok',
    hash: program.hash,
    total: program.lines.length,
    commands: [
      {
        t: 'load',
        lines: [...program.lines],
        mode: s.streamMode,
        rxBufferSize: s.measuredRxBuffer,
      },
      { t: 'start' },
    ],
  };
}

/**
 * What the tab does when the stream aborts under it.
 *
 * 🔴 **Stopping the sender does not stop the machine.** The controller keeps
 * executing everything already in its RX buffer and planner — up to ~1024
 * characters, 40–70 of our lines (design §10) — so on a rejected line the honest
 * response is a **feed hold**: a controlled deceleration that retains position
 * (§16). Design §17's *"first `error:` mid-stream"* row says exactly this.
 *
 * ⚠ An `ALARM` does NOT get one: the alarm has already halted motion, the
 * controller is in `Alarm`, and adding a `!` there is a byte that means nothing.
 * A `stopped` abort does not get one either — the operator's own `Stop` sent the
 * `!` first, in that order and for that reason.
 */
export function abortResponse(abort: StreamAbort | null): {
  realtime: RealtimeName | null;
  why: string;
} {
  if (!abort) return { realtime: null, why: '' };
  switch (abort.reason) {
    case 'error':
      return {
        realtime: 'feedHold',
        why:
          `${abort.message} The stream stopped there. grblHAL keeps executing what is already in ` +
          'its buffer, so a feed hold was sent to decelerate it — the spindle is still turning and ' +
          'the tool is still in the work.',
      };
    case 'desync':
      return {
        realtime: 'feedHold',
        why: `${abort.message} A feed hold was sent, because a sender that has lost count must not keep feeding.`,
      };
    case 'alarm':
      return {
        realtime: null,
        why: `${abort.message} No feed hold was sent: the alarm has already stopped the motion, and the machine is in Alarm until it is unlocked.`,
      };
    case 'stopped':
      return {
        realtime: null,
        why: `${abort.message} The feed hold was already sent, before the sender stopped — that order is what leaves nothing decelerating.`,
      };
  }
}

/** What the tab has measured about the controller's buffers. `null` = not yet. */
export interface MeasuredBuffers {
  /** `Bf`'s second figure — RX characters free — at its largest while `Idle`. */
  rx: number | null;
  /** `Bf`'s first figure — planner blocks free — at its largest while `Idle`. */
  planner: number | null;
}

/**
 * Measure the controller's buffers from `Bf`, per design §2.
 *
 * 🔴 **A MEASUREMENT, AND A LOWER BOUND, AND SAID TO BE ONE.** `Bf` reports what
 * is FREE, so it equals the size only when the buffer is empty. This takes the
 * largest value ever seen while the controller is `Idle` and this tab is not
 * streaming: free space can never exceed the buffer, so the running maximum
 * climbs to the true size and never passes it. A residual `$$` reply still in the
 * buffer therefore makes the first measurement small, not wrong — and small is
 * the safe direction, because character counting against a smaller number sends
 * less, never more.
 *
 * ⚠ It is deliberately not taken while streaming: mid-stream `Bf` is occupancy,
 * and reading occupancy as capacity is how a streamer talks itself into an
 * overrun.
 */
export function measureBuffers(
  prev: MeasuredBuffers,
  report: StatusReport,
  streaming: boolean
): MeasuredBuffers {
  if (streaming || report.state !== 'Idle' || !report.bf) return prev;
  return {
    rx: Math.max(prev.rx ?? 0, report.bf.rxFree),
    planner: Math.max(prev.planner ?? 0, report.bf.plannerFree),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Am I alone on this port? — the consumer `run/protocol.ts` was written for
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 **EVERY UNACKNOWLEDGED NON-REALTIME BYTE *THIS TAB* HAS WRITTEN — WHICH IS
 * NOT `Streamer.pendingChars`.**
 *
 * This is the `ourChars` that {@link PortOwnershipWatch} refuses to guess, and
 * the reason it lives here rather than in the worker is that the worker never
 * sees all of it: the streamer's lines go through `StreamPump`, and the
 * handshake's `$I`/`$$`, the console's `$` commands, `$H`, `$X` and a `$J=` jog
 * go through `{ t: 'write' }`, which the `Streamer` knows nothing about. **A tab
 * that supplies the streamer's count manufactures a second writer out of its own
 * `$$`** — `run-protocol.test.ts`'s *"an unaccounted channel of OUR OWN reads as
 * a foreign writer"* is exactly that failure, planted, and a detector that fires
 * on the tab's own traffic is a detector that gets muted inside a day.
 *
 * So it is fed from the two events that cover **both** channels:
 *
 *  - **`{ t: 'sent' }`** — posted by the worker after the bytes have actually
 *    been written, for a streamed line *and* for a `write` line alike, and for
 *    nothing else. The status poller writes `?`/`0x87` **directly to the link and
 *    posts no `sent` event**, which is what keeps a realtime byte from being
 *    charged here by accident rather than by rule.
 *  - **every inbound line**, classified by `run/protocol.ts`. `isLineReply` is
 *    the one field the character count may key on: exactly one `ok`/`error:N`
 *    comes back per line, and `ALARM:N` and a status report are not replies.
 *
 * ⚠ **It is an UPPER bound and is meant to be.** An `ok` is sent once the line
 * has left the ring, so what this holds is never less than what is really in the
 * ring; and {@link OutstandingChars.bound} reports the **maximum since the
 * previous report** rather than the value now, because the report being scored
 * was rendered by the controller in the past. Too high only makes the watch
 * blinder — `run-protocol.test.ts` asserts that direction is safe.
 *
 * 🔴 **`0x85` AND `0x18` MAKE IT `'unknown'`, AND THE LATCH IS NOT TIMIDITY.**
 * Both flush the ring under the count (R7): `cancel_read_buffer` discards
 * whatever has not been parsed, while lines already parsed still answer. So some
 * of the queue below will be acknowledged and some never will, and **nothing on
 * the wire says which**. A `0` there would be a `0` that means *"I did not
 * check"* — the one input that turns the watch into a liar. There is exactly one
 * event that re-establishes the count, and it is not a timeout: **a banner**, the
 * controller announcing a restart, at which point its ring is empty by
 * construction and nothing of ours is outstanding. A `0x18` produces one; a
 * `0x85` does not, so a jog cancel leaves this tab blind until it resets or
 * reconnects. Blind is the safe direction and the verdict says `'unchecked'`
 * rather than anything that reads as a pass.
 */
export class OutstandingChars {
  /** One entry per line written, in wire order — grblHAL answers in that order. */
  private q: number[] = [];
  private sum = 0;
  /** The maximum {@link sum} has reached since the last {@link bound} call. */
  private peak = 0;
  private unknown = false;

  /** Bytes this tab believes are outstanding **now**. Exposed for a test; the
   *  watch is fed {@link bound}, which is the honest figure for a past report. */
  get outstanding(): number {
    return this.sum;
  }
  /** Whether the count has been invalidated and not yet re-established. */
  get isUnknown(): boolean {
    return this.unknown;
  }

  /** A line has actually gone out — streamed or typed, they are the same bytes
   *  in the same ring. `lineCost` is `transport.ts`'s, so this cannot drift from
   *  what the streamer charges or from what `encodeLine` writes. */
  onSent(line: string): void {
    const cost = lineCost(line);
    this.q.push(cost);
    this.sum += cost;
    if (this.sum > this.peak) this.peak = this.sum;
  }

  /**
   * One inbound line, already classified. Called for **every** line, so that
   * "which lines are replies" stays `run/protocol.ts`'s decision and is not
   * re-derived here.
   */
  onInbound(i: Inbound): void {
    if (i.kind === 'banner') {
      /* The controller has restarted: its ring is empty, and nothing we sent
       * before this moment is outstanding. The one event that can clear the
       * latch, and it is an observation rather than an assumption. */
      this.q = [];
      this.sum = 0;
      this.peak = 0;
      this.unknown = false;
      return;
    }
    if (!i.isLineReply) return;
    const head = this.q.shift();
    if (head === undefined) {
      /* A reply to a line we never sent. That is the desync signature — and one
       * of its causes is the very thing the watch is looking for, because two
       * readers on one tty each get some of the bytes. Either way this ledger no
       * longer knows what it owes. */
      this.unknown = true;
      return;
    }
    this.sum -= head;
  }

  /** A realtime byte went out. Only `0x85` and `0x18` matter, and the decision
   *  is made here rather than at three call sites that would each have to
   *  remember it. */
  onRealtime(name: RealtimeName): void {
    if (name !== 'jogCancel' && name !== 'reset') return;
    this.q = [];
    this.sum = 0;
    this.peak = 0;
    this.unknown = true;
  }

  /** The connection is gone; so is everything this was counting. */
  reset(): void {
    this.q = [];
    this.sum = 0;
    this.peak = 0;
    this.unknown = false;
  }

  /**
   * The bound to hand the watch for the report just received: the **maximum**
   * outstanding since the previous report, because the controller rendered that
   * report at some moment in between and we do not know which.
   *
   * Consumes the peak — call it once per report, which is what
   * {@link applyStatusReport} does.
   */
  bound(): number | 'unknown' {
    if (this.unknown) return 'unknown';
    const max = Math.max(this.peak, this.sum);
    this.peak = this.sum;
    return max;
  }
}

/**
 * One status report, applied: the buffer measurement, the ownership check, and
 * everything the tracked state learns from it.
 *
 * 🔴 **THE `Math.max` STAYS AND THE WATCH GETS THE SAMPLES AS WELL.** Two facts
 * live in one series and only one of them survives a maximum. `measureBuffers`
 * is right about the SIZE — free space can never exceed the buffer, so a running
 * maximum climbs to the true figure and never passes it, and the streamer
 * refuses to start without it (R13). But **the maximum is the one summary that
 * cannot show variation, and the variation is the evidence**: under sole
 * ownership a quiescent `rxFree` is *constant*, because realtime bytes are
 * ISR-stripped and never enter the ring, so a quiescent sample that RISES proves
 * the earlier ones — including the handshake's own measurement — were taken over
 * somebody else's bytes. A `Math.max` can never disagree with itself. So the
 * report goes to both, from one place, and neither is derived from the other.
 *
 * 🔴 **AND THIS IS THE CONSUMER THAT MAKES THE DETECTOR REAL.** `2c4f75b693`
 * built `PortOwnershipWatch` and nothing called it, which is the shape this lane
 * has filed against itself repeatedly: *a control with no consumer accrues
 * authority it never earned*. Until this function ran, `portOwnership` read
 * `'unchecked'` — correctly worded, and not a pass.
 *
 * ⚠ **It returns a MERGE FUNCTION rather than a state.** The observation is a
 * side effect on `watch` and must happen exactly once per report; a React state
 * updater may be invoked more than once for one event. So the impure half runs
 * here, when this is called, and `track` is pure, idempotent and safe to hand to
 * `setTracked` — which is also what keeps a report from clobbering an alarm that
 * arrived between renders.
 */
export function applyStatusReport(args: {
  report: StatusReport;
  /** What has been measured so far on this connection. */
  buffers: MeasuredBuffers;
  /** The most recent `WCO`, for the work-Z derivation (§5). */
  lastWco: number[] | null;
  /** Is this tab feeding the streamer right now? */
  streaming: boolean;
  /** This tab's own outstanding-byte ledger. Read once, here. */
  ours: OutstandingChars;
  /** Held across reports by the caller — the verdict is sticky, and clearing it
   *  is what a reconnect is for. */
  watch: PortOwnershipWatch;
  /** `$10` decoded. Threads to {@link deriveDro} so the DRO's "no WCO" sentence
   *  can distinguish *"change-only"* from *"change the setting"*. `undefined`
   *  until identification completes — the both-cases sentence is still correct. */
  mask?: ReportMask | null;
}): { buffers: MeasuredBuffers; track: (t: TrackedState) => TrackedState } {
  const { report: r, streaming, ours, watch, lastWco, mask } = args;
  const buffers = measureBuffers(args.buffers, r, streaming);

  /* 🔴 THE INDIVIDUAL SAMPLE, not `buffers.rx`. Feeding the watch the maximum
   * would hand it a number that by construction never falls and never rises
   * against itself — a detector wired to a summary chosen for the opposite
   * property. No `Bf` means no sample: a report that carries no buffer figure is
   * not a quiescent sample, it is silence, and scoring it as one would invent a
   * baseline out of a field the controller did not send. */
  if (r.bf) {
    watch.observe({
      rxFree: r.bf.rxFree,
      state: r.state,
      streaming,
      ourChars: ours.bound(),
    });
  }

  const verdict = watch.verdict;
  const why = watch.why;

  return {
    buffers,
    track: (t) => ({
      ...t,
      measuredRxBuffer: buffers.rx,
      controllerState: r.state,
      controllerSubstate: r.substate,
      // 🔴 Homing evidence is the tab's own and is only ever ADDED to: an
      // `H:1` seen once is evidence, and a later report that omits the
      // change-only field is not evidence of the opposite (§7, R1).
      homingSeen: t.homingSeen || r.homed?.all === true,
      wcoKnown: t.wcoKnown || r.wco != null,
      currentWorkZ: (() => {
        const d = deriveDro(r, r.wco ?? lastWco, undefined, mask);
        return d.work.values ? (d.work.values[2] ?? null) : null;
      })(),
      estopAsserted: (r.pn ?? '').includes('E'),
      doorAjar: (r.pn ?? '').includes('D'),
      limitsEngaged: /[XYZ]/.test(r.pn ?? ''),
      /* R14 keys on this, and the sentence is carried with it so the refusal can
       * quote the numbers rather than assert a conclusion. */
      portOwnership: verdict,
      portOwnershipWhy: why,
      tab: t.tab === 'Disconnected' || t.tab === 'Identifying' ? 'Idle' : t.tab,
    }),
  };
}

/**
 * What the tab prints before any report has been scored.
 *
 * ⚠ Taken FROM the watch rather than written beside it. `TrackedState`'s
 * `portOwnershipWhy` is `null` until a report has been applied, and a second copy
 * of the sentence here would be the one that goes stale — while still reading, to
 * an operator, exactly like the live one. It is the `'unchecked'` wording, which
 * names the limit and is not a pass.
 */
const OWNERSHIP_UNCHECKED = new PortOwnershipWatch().why;

/* ────────────────────────────────────────────────────────────────────────────
 * The fact this tab owes the rest of the app
 * ──────────────────────────────────────────────────────────────────────────── */

export type StreamEnd = 'none' | 'complete' | 'aborted' | 'stopped' | 'link-lost';

/**
 * 🔴 **IS THIS TAB FEEDING A CONTROLLER RIGHT NOW?** — the fact nothing outside
 * the tab could observe, which is why `runProgram.ts`'s freeze had to be
 * *"the held program never changes without an operator act"* and could not be
 * *"the held program cannot be replaced during a stream"*. A refusal keyed on an
 * unobservable fact is a guard that reads as armed and is not.
 *
 * ── WHAT THE CONSUMER MUST DO WITH IT, EXACTLY ──────────────────────────────
 *
 *  1. **While `streaming` is true, DISABLE the hand-over control** in the CNC
 *     tab (`data-testid="handover-run"`) — disable it, do not merely confirm.
 *     The `window.confirm` there is a speed bump and says so; this signal is what
 *     turns it into a refusal. Render {@link StreamingSignal.why} beside it so
 *     the operator is told which program is running and how far in.
 *  2. **Do not stop anything on it.** This is a fact about the SENDER, not a
 *     control channel. Nothing outside this tab may use it to decide a motion.
 *  3. 🔴 **`streaming === false` DOES NOT MEAN THE MACHINE IS STOPPED.** It means
 *     this tab is not feeding lines. The controller holds everything already
 *     sent — up to a full RX buffer, 40–70 of our lines — and keeps executing it
 *     with the spindle turning (design §10). After a `link-lost` end it is
 *     *especially* not stopped: nothing was told to stop. A consumer that renders
 *     "idle" or "finished" off this flag is asserting something this tab never
 *     said.
 *  4. **`ended` is how the LAST job ended, and it persists after `streaming`
 *     goes false.** `'complete'` is the sender's own accounting — every line sent
 *     and acknowledged — never the controller's `Idle`, which a starved streamer
 *     also produces (§4).
 */
export interface StreamingSignal {
  streaming: boolean;
  /** The program being fed, identified by the same hash the CNC tab handed over. */
  program: { name: string; hash: string; lines: number } | null;
  sent: number;
  acknowledged: number;
  total: number;
  /** `Date.now()` at the first command of this job. */
  startedAt: number | null;
  ended: StreamEnd;
  /** One sentence, for the consumer to render beside whatever it disables. */
  why: string;
}

export function streamingSignal(args: {
  program: RunProgram | null;
  state: string;
  sent: number;
  acknowledged: number;
  total: number;
  startedAt: number | null;
  abort: StreamAbort | null;
  linkLost: boolean;
}): StreamingSignal {
  /* 🔴 A DROPPED LINK IS NOT A RUNNING STREAM, whatever the last state word
   * said. Nothing is being fed — and the machine was never told to stop, which
   * is the opposite fact and is carried in `why` rather than here. */
  const streaming = args.state === 'streaming' && !args.linkLost;
  const ended: StreamEnd = args.linkLost
    ? 'link-lost'
    : args.state === 'done'
      ? 'complete'
      : args.state === 'aborted'
        ? args.abort?.reason === 'stopped'
          ? 'stopped'
          : 'aborted'
        : 'none';
  const p = args.program
    ? { name: args.program.name, hash: args.program.hash, lines: args.program.lines.length }
    : null;
  const why = streaming
    ? `The Run tab is streaming “${p?.name ?? 'a program'}” (${p?.hash ?? '?'}) — ${args.acknowledged} of ${args.total} lines acknowledged, ${args.sent} sent. Replacing the program now would leave the picture, the line count and the remaining time describing something the controller is not executing.`
    : ended === 'link-lost'
      ? 'The link dropped while a job was running. This tab is not feeding anything — and the machine was never told to stop: it executes whatever is already in its buffer, with the spindle turning.'
      : ended === 'complete'
        ? 'The last job finished by this tab’s own accounting — every line sent and acknowledged. That is not a claim about what was cut.'
        : ended === 'aborted' || ended === 'stopped'
          ? `The last job ended early. ${args.abort?.message ?? ''}`
          : 'This tab is not streaming. That is a fact about the sender, not about the machine.';
  return {
    streaming,
    program: p,
    sent: args.sent,
    acknowledged: args.acknowledged,
    total: args.total,
    startedAt: args.startedAt,
    ended,
    why,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Progress: the measurement, the prediction, and the gap between them
 * ──────────────────────────────────────────────────────────────────────────── */

const NOT_KNOWN = '—';

/**
 * Where on the path the DRO is, **constrained forward** so a path that crosses
 * itself does not snap backwards.
 *
 * 🔴 A failed match is a STATE, not a fallback (design §14). If the nearest
 * point is further away than the tolerance, the tool is somewhere the program
 * does not go — a wrong `WCO`, a `G92`, a resumed job, a pendant — and the answer
 * is `null`, which makes `Remaining` render `—`. Snapping to the nearest thing
 * available turns "we do not know where we are" into a picture of confident
 * progress.
 */
export function matchOnPath(
  path: readonly PathPoint[],
  pos: readonly number[] | null | undefined,
  from: number,
  tolMm: number
): number | null {
  if (!pos || pos.length < 3 || !path.length) return null;
  let best = -1;
  let bestD = Infinity;
  for (let i = Math.max(0, from); i < path.length; i++) {
    const p = path[i];
    const d = Math.hypot(p.x - pos[0], p.y - pos[1], p.z - pos[2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 && bestD <= tolMm ? best : null;
}

/**
 * Seconds the PROGRAM says it takes to walk `from` → `to`.
 *
 * ⚠ **Rapids advance the clock and cut nothing**, so they run at the machine's
 * rapid rate and are deliberately NOT scaled by the feed override — the rapid
 * override is a different control with three positions (100/50/25) and a
 * different number. Merging them makes a time bar read "nearly finished" while a
 * long link move is running, which `#70` already records.
 */
export function pathSeconds(
  program: RunProgram,
  from: number,
  to: number,
  feedOverridePct = 100
): number {
  const k = Math.max(10, feedOverridePct) / 100;
  let s = 0;
  for (let i = Math.max(1, from + 1); i <= Math.min(to, program.path.length - 1); i++) {
    const a = program.path[i - 1];
    const b = program.path[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (d === 0) continue;
    const rate = b.rapid ? program.rapidRate : b.feed * k;
    if (rate > 0) s += (d / rate) * 60;
  }
  return s;
}

/**
 * `Remaining`, honestly (§14): computed **from the program**, forward from the
 * *measured* position, scaled by the current feed override.
 *
 * 🔴 `null` when the DRO could not be located on the path. A time estimate
 * derived from a position we could not find is a number invented in TypeScript
 * and rendered as a measurement — the defect class this lane has recorded four
 * times.
 */
export function remainingSeconds(
  program: RunProgram | null,
  matched: number | null,
  feedOverridePct: number
): number | null {
  if (!program || matched == null) return null;
  return pathSeconds(program, matched, program.path.length - 1, feedOverridePct);
}

/**
 * Where the program's own feeds say the tool should be after `sec` seconds — the
 * PREDICTION.
 *
 * It exists so the tab can draw it in a different visual language from the
 * measurement. It never colours the path and never feeds `Remaining`; both of
 * those are measured.
 */
export function predictIndexAtTime(
  program: RunProgram | null,
  sec: number | null,
  feedOverridePct = 100
): number | null {
  if (!program || sec == null || program.path.length < 2) return null;
  let acc = 0;
  for (let i = 1; i < program.path.length; i++) {
    acc += pathSeconds(program, i - 1, i, feedOverridePct);
    if (acc >= sec) return i;
  }
  return program.path.length - 1;
}

export type DivergenceCause = 'none' | 'override' | 'starvation' | 'model' | 'unknown';

export interface Divergence {
  /** Signed: positive = the machine is behind the prediction. `null` = unknown. */
  signedSeconds: number | null;
  cause: DivergenceCause;
  text: string;
}

/**
 * The disagreement between prediction and measurement — **as a signed number,
 * never by quietly snapping one to the other** (§14).
 *
 * Three causes, and they are distinguishable, which is the whole reason the
 * divergence is worth rendering at all:
 *
 *  - **override** — `Ov:` says the machine was told to go slower, so it is
 *    slower by exactly that factor. Not a fault.
 *  - **starvation** — overrides are at 100% and the sender is not keeping up.
 *    This is the failure that leaves a cutter sitting in the work. ⚠ Keyed on
 *    the SENDER stalling, never on the planner being empty: our post emits `G4`
 *    after every `M3` and `mc_dwell` drains the planner first (design F5), so a
 *    planner-empty detector false-fires at every spindle start — and a control
 *    that false-fires gets muted.
 *  - **model** — the machine is somewhere the program does not go, or is ahead
 *    of it. Stop asserting progress.
 */
export function divergence(args: {
  predictedSeconds: number | null;
  measuredSeconds: number | null;
  feedOverridePct: number | undefined;
  senderStalled: boolean;
  matched: number | null;
}): Divergence {
  if (args.matched == null) {
    return {
      signedSeconds: null,
      cause: 'model',
      text:
        'The tool is not on the programmed path — a wrong work offset, a G92, a resumed job or a ' +
        'pendant driving the machine. Progress is not being asserted.',
    };
  }
  if (args.predictedSeconds == null || args.measuredSeconds == null) {
    return { signedSeconds: null, cause: 'unknown', text: 'Not enough has run to compare.' };
  }
  const signed = args.measuredSeconds - args.predictedSeconds;
  if (Math.abs(signed) < 1) {
    return { signedSeconds: signed, cause: 'none', text: 'Machine and prediction agree.' };
  }
  const ov = args.feedOverridePct ?? 100;
  if (signed > 0 && ov !== 100) {
    return {
      signedSeconds: signed,
      cause: 'override',
      text: `Machine is ${signed.toFixed(1)} s behind the prediction — feed override ${ov}%.`,
    };
  }
  if (signed > 0 && args.senderStalled) {
    return {
      signedSeconds: signed,
      cause: 'starvation',
      text:
        `Machine is ${signed.toFixed(1)} s behind and the overrides are at 100% — the sender is ` +
        'not keeping up. A stalled stream leaves a turning cutter stationary in the material.',
    };
  }
  return {
    signedSeconds: signed,
    cause: 'model',
    text:
      `Machine is ${Math.abs(signed).toFixed(1)} s ${signed > 0 ? 'behind' : 'ahead of'} the ` +
      'prediction and neither an override nor a stalled sender explains it. The model of where ' +
      'the tool is may be wrong.',
  };
}

export function hhmmss(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return NOT_KNOWN;
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** Three decimals, or `—`. Never a zero standing in for an absence (§5). */
export function axes(values: number[] | null): string {
  return values ? values.map((v) => v.toFixed(3)).join('  ') : `${NOT_KNOWN}  ${NOT_KNOWN}  ${NOT_KNOWN}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Is the number on the DRO still true?
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How many expected intervals may pass before a readout is called STALE rather
 * than merely not-current.
 *
 * ⚠ **The literal rule is "older than one poll interval", and the literal rule
 * alone would flicker.** A report requested every 200 ms arrives 0–200 ms old
 * even when everything is healthy, and ordinary jitter — a `$$` dump in the way,
 * a `G4` on the controller, a browser frame — puts it past 200 ms constantly. A
 * marker that blinks on and off during a normal cut is a marker an operator
 * learns to ignore, *and a control that false-fires gets muted* (`AGENTS.md`).
 *
 * So there are TWO verdicts, and both are rendered:
 *
 *  - **not current** at `age > expected` — the literal rule. The DRO carries its
 *    age, always, so the operator can see the number is a moment old.
 *  - **stale** at `age > 3 × expected` — the loud one. Three consecutive missed
 *    reports is not jitter.
 *
 * Neither ever hides the number: design §17's disconnect row says *"freeze the
 * last known DRO **and mark it stale with its age**"*, and a blanked DRO throws
 * away the last thing anyone knew about where the tool is.
 */
export const STALE_FACTOR = 3;

export interface Freshness {
  /** ms since the last report arrived; `null` when none ever has. */
  ageMs: number | null;
  /** How often a report is expected — `$481` when set, else the poll interval.
   *  `null` when nothing is asking and nothing is pushing. */
  expectMs: number | null;
  /** The readout is within one expected interval. */
  current: boolean;
  /** Older than {@link STALE_FACTOR} intervals: not jitter. */
  stale: boolean;
  /**
   * 🔴 The silence is EXPECTED and must not read as a fault.
   *
   * During `$H` grblHAL reports nothing at all — `$10` bit 12 (*report while
   * homing*) is off by default — so a homing cycle produces a multi-second gap
   * on every single run. The numbers really are old, so {@link stale} still
   * says so; what this flag stops is the tab calling it a failure.
   */
  expectedSilence: boolean;
  /** What the operator is told, beside the numbers. */
  why: string;
}

/**
 * Whether the DRO is showing a measurement or a memory.
 *
 * 🔴 **A frozen number that looks live is the worst of the three options** — the
 * others being a number labelled with its age, and no number at all. This
 * function is what makes the first case unreachable: every render of the DRO
 * asks it, and its verdict is rendered next to the digits rather than in a
 * tooltip or a separate status line somebody may not be looking at.
 */
export function droFreshness(a: {
  connected: boolean;
  ageMs: number | null;
  expectMs: number | null;
  state: MachineState;
}): Freshness {
  const base = { ageMs: a.ageMs, expectMs: a.expectMs, expectedSilence: false };
  if (!a.connected) {
    return {
      ...base,
      current: false,
      stale: false,
      why: 'Not connected. There is no reading to be current or stale.',
    };
  }
  if (a.ageMs === null) {
    return {
      ...base,
      current: false,
      stale: true,
      why: 'No status report has arrived on this connection, so nothing here is a measurement yet.',
    };
  }
  if (a.expectMs === null || a.expectMs <= 0) {
    return {
      ...base,
      current: false,
      stale: true,
      /* Nothing polls and nothing auto-reports: reports arrive only if the
       * controller volunteers one. There is no interval to be late against, so
       * the honest verdict is that freshness cannot be judged — which is a
       * stale reading, not a fresh one. */
      why:
        `Nothing is requesting status reports and $481 auto-reporting is not known to be on, so ` +
        `there is no interval this reading can be judged against. It is ${a.ageMs}ms old and it ` +
        `will not update on its own.`,
    };
  }
  const current = a.ageMs <= a.expectMs;
  const stale = a.ageMs > a.expectMs * STALE_FACTOR;
  if (a.state === 'Home' && !current) {
    return {
      ...base,
      current,
      stale,
      expectedSilence: true,
      why:
        `Last report ${a.ageMs}ms ago, against ${a.expectMs}ms expected. 🔴 These numbers are not ` +
        'current — but during a homing cycle that silence is EXPECTED: grblHAL suppresses reports ' +
        'while $H runs ($10 bit 12, off by default). The readings below are from before the cycle ' +
        'started and the machine has moved since.',
    };
  }
  if (stale) {
    return {
      ...base,
      current,
      stale,
      why:
        `🔴 STALE — last report ${a.ageMs}ms ago, more than ${STALE_FACTOR}× the ${a.expectMs}ms ` +
        'expected. The numbers below are the last thing this tab was told, not where the tool is. ' +
        'That is not the same fact as “the machine stopped”: it keeps executing whatever is in its ' +
        'buffer, with the spindle turning.',
    };
  }
  if (!current) {
    return {
      ...base,
      current,
      stale,
      why: `Last report ${a.ageMs}ms ago, against ${a.expectMs}ms expected — a moment behind.`,
    };
  }
  return {
    ...base,
    current,
    stale,
    why: `Last report ${a.ageMs}ms ago, within the ${a.expectMs}ms expected.`,
  };
}

export interface DroRendering {
  machine: string;
  work: string;
  /** 🔴 The tab must say these digits are not a measurement of now. */
  markStale: boolean;
  /** Loud rather than quiet — past {@link STALE_FACTOR} intervals. */
  loud: boolean;
  /** Rendered beside the digits, never in a tooltip. Empty when current. */
  note: string;
}

/**
 * The digits and the claim made about them, together.
 *
 * They are computed in one place so they cannot disagree: a DRO whose numbers
 * come from one path and whose freshness label comes from another is a DRO that
 * can render a fresh label over stale digits, which is precisely the failure.
 *
 * @param plant `'stale-reads-current'` drops the staleness claim and leaves the
 * digits standing as though they were a measurement of now — the defect this
 * whole section exists to prevent, reintroduced so a test can watch it.
 */
export function droRendering(dro: Dro | null, f: Freshness, plant?: RunTabPlant): DroRendering {
  const machine = axes(dro?.machine.values ?? null);
  const work = axes(dro?.work.values ?? null);
  if (plant === 'stale-reads-current') {
    return { machine, work, markStale: false, loud: false, note: '' };
  }
  const markStale = !f.current;
  return {
    machine,
    work,
    markStale,
    loud: f.stale && !f.expectedSilence,
    note: markStale ? f.why : '',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The console input — a line straight to a motion controller
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The realtime commands reachable by name from the console.
 *
 * 🔴 **Realtime commands are NOT lines and must not be typed as if they were.**
 * `?`, `!`, `~`, `0x18` and every override are single bytes picked out of the
 * stream *before* the line parser (§3): they are not line-buffered, they get no
 * `ok`, and they cost the controller's RX buffer nothing. Most of them have no
 * printable form at all — `0x90` is not a character anybody can type — so the
 * console needs an explicit vocabulary rather than a convention.
 *
 * **The rule, stated once so it cannot be inferred wrongly:**
 *
 *  - a leading **`/`** means *this is a realtime byte, by name* — `/hold`,
 *    `/feed+10`, `/reset`;
 *  - the three that grbl's own documents write as characters — **`?`, `!`, `~`**
 *    — are also accepted **bare and alone**, because a line consisting of
 *    exactly one of them is not g-code in any dialect and every sender in the
 *    world spells them that way;
 *  - **everything else is a line**, and a line goes through the line rules.
 *
 * ⚠ **Two of grblHAL's realtime commands are deliberately absent.**
 * `0x84 CMD_SAFETY_DOOR` forces the door state and is *"NOT a stop button, and
 * must never be offered as one"* — in a typed console, next to `/hold`, it is
 * the byte most likely to be reached for as one. `0xA3 CMD_TOOL_ACK` is not on
 * our path at all: our post emits `M0`, never `M6` (F4), so a tool-change
 * acknowledge can only ever be answering a program that is not ours.
 */
export const CONSOLE_REALTIME: Readonly<Record<string, RealtimeName>> = {
  status: 'statusReport',
  'status-all': 'statusReportAll',
  hold: 'feedHold',
  resume: 'cycleStart',
  reset: 'reset',
  'gcode-report': 'gcodeReport',
  'jog-cancel': 'jogCancel',
  'spindle-stop': 'spindleStop',
  'optional-stop': 'optionalStopToggle',
  'single-block': 'singleBlockToggle',
  'auto-report': 'autoReportingToggle',
  'feed=100': 'feedOverrideReset',
  'feed+10': 'feedOverridePlus10',
  'feed-10': 'feedOverrideMinus10',
  'feed+1': 'feedOverridePlus1',
  'feed-1': 'feedOverrideMinus1',
  'rapid=100': 'rapidOverride100',
  'rapid=50': 'rapidOverride50',
  'rapid=25': 'rapidOverride25',
  'spindle=100': 'spindleOverrideReset',
  'spindle+10': 'spindleOverridePlus10',
  'spindle-10': 'spindleOverrideMinus10',
  'spindle+1': 'spindleOverridePlus1',
  'spindle-1': 'spindleOverrideMinus1',
  flood: 'floodToggle',
  mist: 'mistToggle',
};

/** `[0x21 CMD_FEED_HOLD_LEGACY]` — design §13 asks for realtime bytes rendered by name,
 *  so a transcript shows what went on the wire and not just that something did. */
export function realtimeEcho(name: RealtimeName): string {
  const c = REALTIME[name];
  return `[0x${c.byte.toString(16).padStart(2, '0')} ${c.id}]`;
}

export type ConsoleOutcome =
  /** Blank input. */
  | { kind: 'nothing' }
  /** `/help` and friends: nothing goes on the wire. */
  | { kind: 'note'; echo: string; note: string }
  /** One realtime byte. `chargedCharacters` is 0 for this, by construction. */
  | { kind: 'realtime'; name: RealtimeName; echo: string; note: string }
  /** A soft reset, waiting for its second press. Nothing was sent. */
  | { kind: 'confirm'; name: RealtimeName; echo: string; note: string }
  /** One line, terminated, through the line path. */
  | { kind: 'line'; line: string; echo: string; note: string }
  /** Nothing was sent, and these are all the reasons. */
  | { kind: 'refused'; echo: string; refusals: ControlRefusal[] };

/**
 * What the console does with what was typed — **and every refusal that applies**.
 *
 * 🔴 **THIS IS A LINE STRAIGHT TO A MACHINE CONTROLLER**, so it is held to the
 * same discipline as `Start`: the refusal set is `run/protocol.ts`'s
 * {@link refusalsFor} and the realtime state rules are its
 * {@link realtimeRefusal}, asked **here — where the bytes would be built** — and
 * not at the input's rendered state. A console that consulted its own rules
 * would be a way around every refusal the rest of the tab enforces, and it would
 * be the *only* motion surface in the tab with no preflight.
 *
 * The three things it will not do, and why each:
 *
 *  1. **Arbitrary g-code.** `refusalsFor('console-gcode', …)` refuses it
 *     unconditionally (R5): none of R1–R4 or R12 has run, so a typed `G0 Z-50`
 *     is a motion with no homing evidence, no descent check and no units check.
 *  2. **Anything at all while a job is streaming.** The worker's line path
 *     bypasses the character count deliberately — it exists for `$` queries sent
 *     one at a time while `Idle` — so a line typed mid-stream puts bytes in the
 *     controller's RX buffer that the `Streamer`'s count does not know about.
 *     The count then believes there is more room than there is, and *the count
 *     is the only thing standing between the sender and an overrun* (§2).
 *  3. **A bare soft reset.** `/reset` is `Abort` by another route, and `Abort`
 *     takes two presses because `0x18` while moving kills the steppers with no
 *     deceleration and loses position. It takes two here as well, **sharing the
 *     tab's one confirmation latch**, so the console is not a cheaper path to the
 *     same consequence.
 *
 * @param opts.resetConfirmed the tab's abort-confirmation latch — the SAME latch
 * the `Abort` button uses, which is what makes the two paths cost the same.
 * @param plant `'console-ignores-refusals'` sends anyway; `'realtime-as-line'`
 * classifies a realtime byte as a line.
 */
export function consoleAction(
  input: string,
  s: TrackedState,
  opts: { resetConfirmed?: boolean } = {},
  plant?: RunTabPlant
): ConsoleOutcome {
  const echo = input;
  const text = input.trim();
  if (!text) return { kind: 'nothing' };

  const ignore = plant === 'console-ignores-refusals';
  const refusedIf = (rs: ControlRefusal[]): ConsoleOutcome | null =>
    !ignore && rs.length > 0 ? { kind: 'refused', echo, refusals: rs } : null;

  if (text === '/help') {
    return {
      kind: 'note',
      echo,
      note:
        'Realtime bytes: ? ! ~ typed alone, or /' +
        Object.keys(CONSOLE_REALTIME).join(' /') +
        '. Lines: $ commands only — $$ $I $G $# and $H / $X / $J=. G-code is refused: it would ' +
        'be motion with none of the Start preflight behind it. 0x84 (safety door) and 0xA3 (tool ' +
        'acknowledge) are deliberately not offered.',
    };
  }

  const link = refusedIf(
    s.tab === 'Disconnected'
      ? [{ id: 'link', why: 'Not connected. Nothing typed here can reach a controller.' }]
      : []
  );
  if (link) return link;

  /* ── realtime ─────────────────────────────────────────────────────────── */
  const LITERAL: Readonly<Record<string, RealtimeName>> = {
    '?': 'statusReport',
    '!': 'feedHold',
    '~': 'cycleStart',
  };
  const named = text.startsWith('/') ? CONSOLE_REALTIME[text.slice(1)] : undefined;
  const name = LITERAL[text] ?? named;
  if (name || text.startsWith('/')) {
    if (!name) {
      return {
        kind: 'refused',
        echo,
        refusals: [
          {
            id: 'name',
            why:
              `“${text}” is not a realtime command this tab carries. Type /help for the list. It ` +
              'is not sent as a line either: a leading / means “this is a byte, by name”, and ' +
              'guessing which byte was meant is not something a motion controller forgives.',
          },
        ],
      };
    }
    if (plant === 'realtime-as-line') {
      /* 🔴 THE DEFECT, REINTRODUCED: the byte goes out as a LINE. On the wire
       * that is the byte plus a newline — the controller picks the realtime byte
       * out as usual and is then left holding an empty line, which it answers
       * with its own `ok`. Mid-stream that `ok` is counted against a line nobody
       * sent, and the sender's count and the controller's buffer part company. */
      return {
        kind: 'line',
        line: text,
        echo,
        note: 'planted: sent as a line',
      };
    }
    const rt = realtimeRefusal(name, s.controllerState);
    const gated = refusedIf(rt ? [{ id: `0x${REALTIME[name].byte.toString(16)}`, why: rt }] : []);
    if (gated) return gated;
    if (name === 'reset' && !opts.resetConfirmed && !ignore) {
      return {
        kind: 'confirm',
        name,
        echo,
        note:
          'A soft reset from the console is Abort by another route, and it costs the same. ' +
          'grblHAL’s own words for what it costs while the machine is moving: “Reset/E-stop while ' +
          'in motion. Machine position is likely lost due to sudden halt. Re-homing is highly ' +
          'recommended.” Nothing was sent. Type it again, or press Abort, to confirm.',
      };
    }
    return {
      kind: 'realtime',
      name,
      echo,
      note:
        `sent ${realtimeEcho(name)} — one byte, not a line. It is picked out before the line ` +
        'parser, it gets no ok, and it is charged nothing against the character count (§3). ' +
        (REALTIME[name].note || ''),
    };
  }

  /* ── lines ────────────────────────────────────────────────────────────── */
  const streaming = refusedIf(
    s.tab === 'Streaming' || s.tab === 'Held' || s.tab === 'Stopping'
      ? [
          {
            id: '§2',
            why:
              `A job is in flight (the tab is ${s.tab}). A line typed here is written outside the ` +
              'character count — that path exists for $ queries sent one at a time while Idle — so ' +
              'it would put bytes in the controller’s RX buffer that the streamer’s count does not ' +
              'know about, and the count is the only thing standing between the sender and an ' +
              'overrun. Stop the job first.',
          },
        ]
      : []
  );
  if (streaming) return streaming;

  if (!text.startsWith('$')) {
    const rs = refusalsFor('console-gcode', s).map((r) => ({ id: r.id, why: `${r.fact} ${r.why}` }));
    const gated = refusedIf(rs);
    if (gated) return gated;
    return { kind: 'line', line: text, echo, note: 'planted: a refusal was skipped' };
  }

  const upper = text.toUpperCase();
  let action: RunAction | null = null;
  if (upper === '$X') action = 'unlock';
  else if (upper.startsWith('$J=')) action = 'jog';

  if (action) {
    const gated = refusedIf(
      refusalsFor(action, s).map((r) => ({ id: r.id, why: `${r.fact} ${r.why}` }))
    );
    if (gated) return gated;
  } else if (upper === '$H') {
    const gate = uiStateGate('home', s);
    const gated = refusedIf(gate ? [gate] : []);
    if (gated) return gated;
  } else {
    /* Every other `$`: grblHAL answers `error:8` — "'$' command cannot be used
     * unless controller state is IDLE" — outside Idle, and design §15's console
     * row says the same. Refusing here rather than letting the controller refuse
     * means the operator is told which state blocked it, not just a number. */
    const gated = refusedIf(
      s.controllerState !== 'Idle'
        ? [
            {
              id: '8',
              why:
                `Status_IdleError — “'$' command cannot be used unless controller state is IDLE”. ` +
                `The machine is ${s.controllerState}. $H and $X are the exceptions and are ` +
                'allowed from Alarm; everything else waits for Idle.',
            },
          ]
        : []
    );
    if (gated) return gated;
  }

  /* ⚠ JUDGEMENT — a `$n=v` WRITE is allowed, and it is the one place this tab
   * writes a setting. Everywhere else the rule is that the tab never writes one:
   * the handshake reads `$$` and reports a missing capability with the exact
   * command a human can run ("$10 bit 1 is clear — set it at the controller").
   * A human typing that exact command into this console IS the human setting it
   * at the controller, and a tab that prints the command and then refuses to
   * accept it has made itself the obstacle. It is annotated rather than
   * silently passed, because $ settings are non-volatile and some of them
   * (steps/mm, direction inversion) change what every later move does. */
  const write = /^\$(\d+)=/.exec(text);
  return {
    kind: 'line',
    line: text,
    echo,
    note: write
      ? `⚠ $${write[1]} is a SETTING WRITE: it goes to the controller’s non-volatile storage, ` +
        'survives a power cycle, and this tab does not check what it means. It is accepted ' +
        'because you typed it, not because anything here verified it.'
      : '',
  };
}

/**
 * Characters this outcome charges against the controller's RX buffer.
 *
 * 🔴 **A realtime byte is charged NOTHING, and that is not an optimisation.**
 * Realtime commands are picked out of the byte stream before the line parser and
 * are not line-buffered (§3), so they never occupy a line-buffer slot and never
 * produce an `ok`. Charging one against the allowance would under-fill the
 * controller; *counting one as a reply* would over-fill it. The plant
 * `'realtime-as-line'` is the second of those, and it is the dangerous
 * direction — see the test that watches the sender and the fake part company.
 */
export function chargedCharacters(o: ConsoleOutcome): number {
  return o.kind === 'line' ? o.line.length + 1 : 0;
}

/**
 * The refusals that hold for **anything** typed, whatever it is — what the input
 * and its Send button are drawn disabled by.
 *
 * 🔴 **Derived by asking the door, never by restating its rules.** The same
 * idiom as `implemented`, which is read off the action map the tab is actually
 * rendering with rather than off a hand-kept list: the probe is `?`, the least
 * privileged thing the console can produce — a status request, which moves
 * nothing and is legal in every controller state — so a refusal that catches
 * even that is one that catches everything. A second copy of the link rule here
 * would be a picture that could drift from the decision it depicts.
 *
 * ⚠ It is deliberately NOT the whole gate. `consoleAction` refuses g-code, `$`
 * outside `Idle`, `0x85` outside `Jog` and every line mid-stream — none of which
 * can be known before the text is typed. The button being live means *something*
 * can be sent, never that what you are about to type will be.
 */
export function consoleRefusals(s: TrackedState): ControlRefusal[] {
  const probe = consoleAction('?', s);
  return probe.kind === 'refused' ? probe.refusals : [];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Presentation
 * ──────────────────────────────────────────────────────────────────────────── */

export function Control({
  id,
  label,
  refusals,
  onClick,
  danger,
}: {
  id: ControlId;
  label: string;
  refusals: readonly ControlRefusal[];
  onClick?: () => void;
  danger?: boolean;
}) {
  const disabled = refusals.length > 0;
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, maxWidth: 330 }}>
      <button
        type="button"
        data-testid={`run-control-${id}`}
        data-refused={disabled ? refusals.map((r) => r.id).join(',') : undefined}
        disabled={disabled}
        title={disabled ? refusals.map((r) => `${r.id}: ${r.why}`).join('\n') : label}
        onClick={onClick}
        style={{
          padding: '5px 10px',
          borderRadius: 'var(--radius)',
          border: `1px solid ${danger ? 'var(--bad)' : 'var(--line)'}`,
          background: 'transparent',
          color: disabled ? 'var(--muted)' : danger ? 'var(--bad)' : 'var(--ink)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          font: 'inherit',
        }}
      >
        {label}
      </button>
      {/* 🔴 THE REASON IS RENDERED, NOT HIDDEN IN A TOOLTIP. A disabled button
       * whose reason lives only in a `title` is a control that fails silently
       * for anyone on a touch screen or a keyboard — which in a shop is most
       * people, because the other hand is on the machine.
       *
       * 🔴 AND SINCE 2026-08-11 THIS IS THE ONLY FULL-TEXT SURFACE FOR THESE
       * REFUSALS. `RefusalList` used to print the same `fact` + `why` again and
       * now prints an index for anything answered here. Deleting this span does
       * not move the text somewhere else — it removes it from the page. */}
      {disabled ? (
        <span className="note" data-testid={`run-refused-${id}`} style={{ margin: 0 }}>
          {refusals.map((r) => `${r.id} — ${r.why}`).join(' ')}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The stop control.
 *
 * Design §16, and this component is why that section exists. What ships is **one
 * button labelled `Stop`** — not the biggest thing on screen, not hazard-striped
 * — running the two-step sequence: `!` (a controlled deceleration; position
 * retained, nothing lost), then a choice between `Resume` and `End job`.
 * `Abort (soft reset)` is a **separate, smaller** control behind a confirmation,
 * because `0x18` kills the steppers with no deceleration and trades position for
 * roughly one serial byte's worth of immediacy.
 *
 * 🔴 THE PERMANENT LINE BELOW IS NOT A TOOLTIP AND NOT A DISMISSIBLE MODAL. It
 * is always rendered, because the risk *is* the label: a person who believes
 * this button is a safety device will use it as one, once, in the moment it
 * cannot work.
 */
export function StopPanel({
  stopRefusals,
  abortRefusals,
  onStop,
  onAbort,
  awaitingAbortConfirm,
}: {
  stopRefusals: readonly ControlRefusal[];
  abortRefusals: readonly ControlRefusal[];
  onStop?: () => void;
  onAbort?: () => void;
  awaitingAbortConfirm?: boolean;
}) {
  return (
    <div className="block" data-testid="run-stop-panel">
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Control id="stop" label="Stop" refusals={stopRefusals} onClick={onStop} danger />
        <Control
          id="abort"
          label={awaitingAbortConfirm ? 'Abort — press again to confirm' : 'Abort (soft reset)'}
          refusals={abortRefusals}
          onClick={onAbort}
          danger
        />
      </div>

      {/* The permanent line. */}
      <p className="bad" data-testid="run-stop-permanent" style={{ margin: '8px 0 0' }}>
        <strong>
          Stop asks the controller to stop. It is not an emergency stop and does not cut power. Use
          the machine’s physical emergency stop.
        </strong>{' '}
        {/* The one place this file writes the word: the sentence that bans it as
         * a label. A control carrying it would be a promise this software cannot
         * keep, and the promise is the whole risk. */}
        <span data-testid="run-estop-ban">No control here is ever labelled E-STOP.</span>
      </p>

      {/* 🔴 THE HEADING SCOPES THE LIST, AND IT USED TO SCOPE IT WRONGLY.
        * It read *"Seven things Stop does not guarantee"* over a bullet about
        * **Abort** — a different control, a different byte (`0x18` vs `!`), a
        * different confirmation and a different cost. The bullet is
        * safety-bearing and was NOT deleted: it has moved to `run-abort-cost`
        * below, which is the Abort paragraph, and it now leads it.
        *
        * 🔴 AND THE COUNT IS GONE RATHER THAN CORRECTED. It was a hardcoded
        * numeral beside a literal list — right on the day it was written and a
        * lie the next time a bullet is added, with nothing to catch it. A
        * derived count would be honest and would still be a number stating what
        * the list under it already shows. The list is the count. */}
      <div data-testid="run-stop-limits">
        <p className="note" style={{ margin: '6px 0 0' }}>
          What Stop does not guarantee:
        </p>
        <ul className="note" style={{ margin: '2px 0 0', paddingLeft: 18 }}>
          <li>
            <strong>It cuts power to nothing.</strong> Not the spindle, not the drivers, not the
            VFD. A feed hold leaves the spindle turning and the tool in the work.
          </li>
          <li>
            <strong>It needs the USB link alive.</strong> In the emergency where it is most wanted —
            a cable pulled, a hub reset, a laptop asleep, a crashed tab — the byte is never sent. The
            failure mode of a software stop is correlated with the emergency.
          </li>
          <li>
            <strong>It needs the browser to be scheduled.</strong> A backgrounded, throttled or
            garbage-collecting tab may take hundreds of milliseconds to issue the write.
          </li>
          <li>
            <strong>It needs grblHAL alive and its main loop running.</strong> A firmware hang, a
            brownout or a locked-up USB stack is a controller that is still moving and no longer
            listening.
          </li>
          <li>
            <strong>It needs the controller to be able to stop the machine.</strong> Steppers that
            have already lost steps against a jammed gantry do not un-lose them.
          </li>
          <li>
            <strong>Nothing here stops the spindle at the wall.</strong> A VFD commanded off still
            spins down over seconds.
          </li>
        </ul>
      </div>

      <p className="note" style={{ margin: '6px 0 0' }} data-testid="run-abort-cost">
        {/* Moved here 2026-08-11 from the Stop list above, which is scoped to
          * Stop. Kept as the FIRST sentence of the Abort paragraph rather than
          * appended to it: what the button costs is the thing to read before
          * the quotation explaining it. */}
        <strong>Abort does not decelerate.</strong> It kills the steppers; whatever the gantry’s
        inertia does next is not controlled by anything. Abort sends a soft reset. grblHAL’s own
        words for what that costs while the machine is moving: <em>“Reset/E-stop while in motion.
        Machine position is likely lost due to sudden halt. Re-homing is highly recommended.”</em>{' '}
        After it, position is untrusted here until a homing cycle completes.
      </p>
    </div>
  );
}

/**
 * The console: a transcript, and one input straight to a motion controller.
 *
 * 🔴 **The input decides nothing.** Every keystroke that turns into bytes goes
 * through {@link consoleAction} — `run/protocol.ts`'s refusal set and its
 * realtime state table — at the moment the bytes would be built. This component
 * holds the text and draws the log.
 *
 * ⚠ **Status polls are deliberately not in the transcript.** At the default 5 Hz
 * an echoed `?` would be ~300 entries a minute in a 500-entry buffer, and every
 * real transaction would be pushed out of the record inside two minutes. The
 * copy says so rather than leaving somebody to conclude the polls are not
 * happening.
 */
export function ConsolePanel({
  lines,
  onSubmit,
  awaitingResetConfirm,
  refusals = [],
}: {
  lines: readonly ConsoleLine[];
  onSubmit?: (text: string) => void;
  awaitingResetConfirm?: boolean;
  /** From {@link consoleRefusals}. Non-empty ⇒ the input is drawn disabled with
   *  the reasons beside it, on the tab's standing rule that *a disabled control
   *  that says why beats a live one that fails at the controller*. */
  refusals?: readonly ControlRefusal[];
}) {
  const [text, setText] = useState('');
  const disabled = refusals.length > 0;
  const connected = !disabled;
  const submit = () => {
    if (disabled || !text.trim()) return;
    onSubmit?.(text);
    setText('');
  };
  return (
    <div className="block" data-testid="run-console" style={{ marginTop: 12 }}>
      <strong>Console</strong>
      <p className="note" style={{ margin: '2px 0 6px' }} data-testid="run-console-rules">
        Every line sent and received, and every command typed here — including the ones that were
        refused, marked <code>✗</code>. This is how a controller fact gets routed to <code>pcb</code>{' '}
        — a rejection is a finding, not a run failure.
        <br />
        <strong>Realtime bytes are not lines.</strong> Type <code>?</code>, <code>!</code> or{' '}
        <code>~</code> alone, or a name after a slash — <code>/hold</code>, <code>/status-all</code>,{' '}
        <code>/feed+10</code>, <code>/reset</code>; <code>/help</code> lists them. They are single
        bytes picked out before the line parser, they get no <code>ok</code>, and they are charged
        nothing against the character count.
        <br />
        <strong>Lines are <code>$</code> commands only.</strong> Arbitrary g-code is refused: none of
        the Start preflight — homing evidence, position trust, the descent check, the units check —
        would have run, so a typed <code>G0 Z-50</code> is motion with no preflight at all. Nothing
        at all is accepted while a job is streaming, because a line written outside the character
        count puts bytes in the controller’s buffer that the streamer does not know about.
        <br />
        <code>/reset</code> is a soft reset and it is <strong>Abort by another route</strong>: it
        takes the same two presses, and shares the same confirmation as the Abort button.
        <br />⚠ Status polls (<code>?</code> / <code>0x87</code>, several a second) are{' '}
        <strong>not echoed here</strong> — they would push every real transaction out of the
        transcript. Everything else is.
      </p>
      <div style={{ display: 'flex', gap: 6, margin: '0 0 6px' }}>
        <input
          data-testid="run-console-input"
          aria-label="Console input: $ commands, or a realtime byte as ? ! ~ or /name"
          value={text}
          disabled={disabled}
          placeholder={connected ? '$$   ?   /hold   /feed+10   /help' : 'not connected'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          style={{
            flex: '1 1 auto',
            font: '12px/1.4 var(--mono, monospace)',
            padding: '5px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
            background: 'var(--bg)',
            color: 'var(--ink)',
          }}
        />
        <button
          type="button"
          data-testid="run-console-send"
          disabled={disabled}
          data-refused={disabled ? refusals.map((r) => r.id).join(',') : undefined}
          title={disabled ? refusals.map((r) => `${r.id}: ${r.why}`).join('\n') : 'Send'}
          onClick={submit}
          style={{
            padding: '5px 10px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
            background: 'transparent',
            color: disabled ? 'var(--muted)' : 'var(--ink)',
            font: 'inherit',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          Send
        </button>
      </div>
      {disabled ? (
        <p className="note" data-testid="run-console-refused" style={{ margin: '0 0 6px' }}>
          {refusals.map((r) => `${r.id} — ${r.why}`).join(' ')}
        </p>
      ) : null}
      {awaitingResetConfirm ? (
        <p className="bad" data-testid="run-console-reset-armed" style={{ margin: '0 0 6px' }}>
          A soft reset is armed — from the console or from Abort, it is the same latch and the same
          consequence. Send <code>/reset</code> again, or press Abort, to go through with it.
        </p>
      ) : null}
      <p className="note" data-testid="run-console-legend" style={{ margin: '0 0 4px' }}>
        {(Object.keys(CONSOLE_DIRS) as ConsoleLine['dir'][])
          .map((d) => `${CONSOLE_DIRS[d].mark} ${CONSOLE_DIRS[d].label}`)
          .join(' · ')}
      </p>
      {lines.length > 0 ? (
        <button
          type="button"
          data-testid="run-console-copy"
          onClick={() =>
            navigator.clipboard.writeText(
              lines
                .slice(-200)
                .map((l) => `${CONSOLE_DIRS[l.dir].mark} ${l.text}`)
                .join('\n')
            )
          }
          style={{
            display: 'block',
            marginBottom: 4,
            padding: '2px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
            background: 'transparent',
            color: 'var(--ink)',
            font: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Copy transcript
        </button>
      ) : null}
      <pre
        data-testid="run-console-log"
        style={{
          margin: 0,
          maxHeight: 180,
          overflow: 'auto',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          padding: 8,
          fontSize: 11.5,
        }}
      >
        {lines.length === 0
          ? 'nothing yet'
          : lines
              .slice(-200)
              /* Verbatim, with the side it came from. Not summarised: a
               * transcript that paraphrases is a description of a conversation
               * rather than the conversation. */
              .map((l) => `${CONSOLE_DIRS[l.dir].mark} ${l.text}`)
              .join('\n')}
      </pre>
    </div>
  );
}

/**
 * The progress picture.
 *
 * 🔴 **A PREDICTION AND A MEASUREMENT MUST NEVER RENDER IDENTICALLY** (§14, gate
 * branch `RUN-17`, plant `same-marker`). Two markers:
 *
 *  - **measured** — where the controller says the tool is — a **filled circle**.
 *  - **predicted** — where the program's own feeds say it should be — an
 *    **unfilled, dashed square outline**.
 *
 * Distinguished by **fill and by shape**, not by colour: the move-class colours
 * are the instrument/safety set `brand` ruled out of the palette on purpose, a
 * machining legend is a safety surface, and a distinction carried by hue alone
 * is gone in a sunlit shed or a colourblind eye.
 *
 * ⚠ The heavy overlay means **“the tool has passed here”**, never “cut”. The DRO
 * is where the controller *thinks* the tool is; after a hard limit or a killed
 * reset it is wrong and says nothing about it. Material removal is `P9`'s claim
 * and it is a different one.
 */
export function ProgressCanvas({
  program,
  matched,
  predicted,
  width = 420,
  height = 260,
}: {
  program: RunProgram | null;
  matched: number | null;
  predicted: number | null;
  width?: number;
  height?: number;
}) {
  if (!program || program.path.length < 2) {
    return (
      <div className="note" data-testid="run-canvas-empty">
        No program has been handed over, so there is nothing to draw. The CNC tab hands one to this
        tab explicitly — the <strong>Hand to the Run tab</strong> button beside its G-code panel —
        and nothing else changes what this tab holds: not a re-plan, not a material change. Drawing
        an example path here would be a picture of a job nobody asked for.
      </div>
    );
  }
  const xs = program.path.map((p) => p.x);
  const ys = program.path.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = 10;
  const sx = maxX - minX > 0 ? (width - 2 * pad) / (maxX - minX) : 1;
  const sy = maxY - minY > 0 ? (height - 2 * pad) / (maxY - minY) : 1;
  const s = Math.min(sx, sy);
  const px = (p: PathPoint) => pad + (p.x - minX) * s;
  // SVG y grows downward; the machine's does not.
  const py = (p: PathPoint) => height - pad - (p.y - minY) * s;
  const d = (from: number, to: number) =>
    program.path
      .slice(from, to)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p).toFixed(1)},${py(p).toFixed(1)}`)
      .join(' ');

  const mPt = matched != null ? program.path[Math.min(matched, program.path.length - 1)] : null;
  const pPt = predicted != null ? program.path[Math.min(predicted, program.path.length - 1)] : null;

  return (
    <svg
      data-testid="run-canvas"
      width={width}
      height={height}
      role="img"
      aria-label="Toolpath, with the measured tool position as a filled circle and the predicted tool position as a dashed square outline"
      style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}
    >
      <path
        data-testid="run-path-base"
        d={d(0, program.path.length)}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={1}
      />
      {matched != null ? (
        <path
          data-testid="run-path-passed"
          d={d(0, matched + 1)}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={2.5}
        />
      ) : null}
      {/* PREDICTED: outline, dashed, square. */}
      {pPt ? (
        <rect
          data-testid="run-marker-predicted"
          data-mark="predicted"
          data-fill="none"
          data-shape="square"
          x={px(pPt) - 6}
          y={py(pPt) - 6}
          width={12}
          height={12}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          strokeDasharray="3 2"
        />
      ) : null}
      {/* MEASURED: filled, round. */}
      {mPt ? (
        <circle
          data-testid="run-marker-measured"
          data-mark="measured"
          data-fill="solid"
          data-shape="circle"
          cx={px(mPt)}
          cy={py(mPt)}
          r={5}
          fill="var(--ink)"
          stroke="none"
        />
      ) : null}
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * The connection lifecycle
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One line of the console, with **which side it came from**.
 *
 * 🔴 `'refused'` is its own direction and not a flavour of `'note'`. A transcript
 * that shows only what went out is a record of what the tab *allowed*, not of
 * what was *asked* — and when a controller fact gets routed to `pcb`, the thing
 * somebody needs to see is often the command that never left.
 */
export interface ConsoleLine {
  dir: 'in' | 'out' | 'note' | 'refused';
  text: string;
  at: number;
}

/** The marker each direction is written with, and the word for it. */
export const CONSOLE_DIRS: Record<ConsoleLine['dir'], { mark: string; label: string }> = {
  out: { mark: '>', label: 'sent by this tab' },
  in: { mark: '<', label: 'received from the controller' },
  note: { mark: '#', label: 'this tab’s own note — nothing on the wire' },
  refused: { mark: '✗', label: 'typed and REFUSED — nothing was sent' },
};

/**
 * What the tab knows about the job in flight.
 *
 * `state` and `abort` are optional so a fixture can supply the four numbers a
 * picture needs without inventing a streamer state it has not simulated —
 * absent reads as `ready` / no abort, which is the quiet direction.
 */
export interface SenderView {
  /** The `Streamer`'s own word: `ready` | `streaming` | `done` | `aborted`. */
  state?: string;
  sent: number;
  acknowledged: number;
  total: number;
  /** ⚠ The SENDER has not written recently — never "the planner is empty". Our
   *  post emits `G4` after every `M3` and `mc_dwell` drains the planner first
   *  (design F5), so a planner-empty detector false-fires at every spindle
   *  start, and a control that false-fires gets muted. */
  stalled: boolean;
  startedAt: number | null;
  abort?: StreamAbort | null;
}

/** The connection's own accounting: every field present, nothing inferred. */
export interface SenderState extends SenderView {
  state: string;
  abort: StreamAbort | null;
}

export interface Connection {
  avail: Availability | null;
  tracked: TrackedState;
  report: StatusReport | null;
  lastWco: number[] | null;
  lastReportAt: number | null;
  mask: ReportMask | undefined;
  console: readonly ConsoleLine[];
  /** Live accounting for the job in flight. */
  sender: SenderState;
  /** Measured from `Bf` while `Idle` — never guessed (§2, R13). */
  buffers: MeasuredBuffers;
  /** `$481` as read from `$$`. `null` = not read, and **never assumed to be on**
   *  — see {@link pollPlan}. */
  autoReportMs: number | null;
  /** What the worker was told to poll with, or `null` before identification. */
  poll: PollPlan | null;
  connect: () => void;
  disconnect: () => void;
  /**
   * 🔴 **THE ONE WRITE THIS TAB MAKES TO AN UNIDENTIFIED CONTROLLER, AND ONLY AN
   * OPERATOR CAN CAUSE IT.**
   *
   * Offered only after the listen window has closed in silence, only once per
   * connection, and only after {@link describeProbe} has put
   * {@link IDENTIFY_PROBE} on screen byte for byte. Everything else in this
   * interface either needs a verdict first or is refused.
   */
  identifyNow: () => void;
  send: (name: RealtimeName) => void;
  /** A `$` query or a `$H`/`$X`. ⚠ This is the RAW path used by the tab's own
   *  controls and the handshake; it checks nothing. Anything an operator TYPES
   *  goes through {@link Connection.runConsole}, which checks everything. */
  writeLine: (line: string) => void;
  /** Stop feeding the stream. It stops the SENDER; the controller still holds
   *  everything already sent (§16). */
  stopFeeding: (why: string) => void;
  /**
   * 🔴 THE ONLY WAY A PROGRAM LEAVES THIS TAB.
   *
   * Re-checks the refusal set at the moment the commands are built
   * ({@link startCommands}) and hands back what it decided, so a caller cannot
   * mistake "refused" for "sent". The refusal goes to the console verbatim,
   * because a control that stops and says nothing is the failure this whole tab
   * is written against.
   */
  startJob: (program: RunProgram | null, tracked: TrackedState) => StartOutcome;
  /**
   * 🔴 THE ONLY WAY TYPED TEXT LEAVES THIS TAB.
   *
   * Same shape and same reason as {@link startJob}: {@link consoleAction} is
   * asked at the moment the bytes would be built, and what it decided is handed
   * back so a caller cannot mistake "refused" for "sent". Both the typed text
   * and the refusal go into the transcript.
   */
  runConsole: (
    input: string,
    tracked: TrackedState,
    opts?: { resetConfirmed?: boolean }
  ) => ConsoleOutcome;
  /** Reconnect to a previously-permitted port without the chooser dialog.
   *  Uses `serial.getPorts()` — permission persists per origin, so no gesture
   *  is needed. Intended for the DisconnectedMidJob state. */
  reconnect: () => void;
  /** Switch between character-counting and send-response streaming. */
  setStreamMode: (mode: StreamMode) => void;
}

/**
 * Open a port, identify what is on the other end, and keep the tab's own state.
 *
 * 🔴 **NOT ONE LINE OF THIS HAS EVER RUN.** There is no browser on the box it
 * was written on and no serial device; node renders the tab, and node has no
 * `navigator.serial`, so every path below the availability check is unexecuted
 * code. It is written from the specification and from design §11, and the honest
 * status of the whole function is *"believed correct, never observed"*.
 *
 * Four things it does deliberately, each from §11:
 *
 *  1. **`requestPort()` is called straight out of the click handler.** It needs
 *     transient activation, and an `await` before it spends the gesture — which
 *     is why the availability check is read from state rather than recomputed
 *     here.
 *  2. **The reader starts before anything is written**, inside the worker. A
 *     banner that arrives while nobody is reading is lost, and its absence is
 *     then indistinguishable from a board that is not grblHAL.
 *  3. 🔴 **IT WRITES NOTHING UNTIL SOMETHING HAS BEEN IDENTIFIED.**
 *     {@link connectCommands} is empty; the identification probe is
 *     {@link identifyNow}, an operator action that renders
 *     {@link IDENTIFY_PROBE} byte for byte first, and the settings read is
 *     {@link afterVerdictCommands}, which runs after a verdict.
 *     *(This bullet used to read "it asks a read-only question first: `$I` moves
 *     nothing". `$I` moving nothing is a fact about grblHAL — the firmware the
 *     question exists to establish. The old ordering assumed its own answer.)*
 *  4. **It never writes a setting.** Reading `$$` is safe; writing `$10=511` to
 *     "make the UI work" would be this tab silently reconfiguring a machine
 *     somebody else set up. A missing capability is reported with the command a
 *     human can run.
 */
export function useSerialConnection(opts: {
  navigatorLike?: { serial?: unknown };
  secureContext?: boolean;
}): Connection {
  const [avail, setAvail] = useState<Availability | null>(
    opts.navigatorLike !== undefined
      ? serialAvailability(opts.navigatorLike as never, opts.secureContext ?? true)
      : null
  );
  const [tracked, setTracked] = useState<TrackedState>(() => initialTrackedState());
  const [report, setReport] = useState<StatusReport | null>(null);
  const [lastWco, setLastWco] = useState<number[] | null>(null);
  const [lastReportAt, setLastReportAt] = useState<number | null>(null);
  const [mask, setMask] = useState<ReportMask | undefined>(undefined);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [sender, setSender] = useState<SenderState>(() => ({
    state: 'ready',
    sent: 0,
    acknowledged: 0,
    total: 0,
    stalled: false,
    startedAt: null,
    abort: null,
  }));
  const [buffers, setBuffers] = useState<MeasuredBuffers>({ rx: null, planner: null });
  const [autoReportMs, setAutoReportMs] = useState<number | null>(null);
  const [poll, setPoll] = useState<PollPlan | null>(null);
  const worker = useRef<Worker | null>(null);
  const handshake = useRef<string[]>([]);
  /** Read inside `onLine`, which must not re-subscribe every time a job ticks. */
  const streamingRef = useRef(false);
  const buffersRef = useRef<MeasuredBuffers>({ rx: null, planner: null });
  /** `$481`, held in a ref as well as in state because the poll plan is decided
   *  inside the identification timeout, whose closure was created before `$$`
   *  answered. Reading the state there would plan against `null` every time. */
  const autoReportRef = useRef<number | null>(null);
  /** 🔴 Whether {@link IDENTIFY_PROBE} has actually gone out on THIS connection.
   *  It is what stops the tab offering the probe a second time after one that
   *  answered nothing — a second ask is a loop, not a question — and it is reset
   *  by `connect`/`disconnect`, because it is a fact about a connection and not
   *  about the tab. */
  const probedRef = useRef(false);
  /** The poll plan the worker is actually running, held in a ref for the same
   *  reason `autoReportRef` is: the `$481` line that would retune it arrives in
   *  `onLine`, whose closure predates the plan. `null` = not polling. */
  const pollRef = useRef<PollPlan | null>(null);
  /**
   * 🔴 IS ANYBODY ELSE WRITING TO THIS PORT? — {@link PortOwnershipWatch}, and
   * this tab's own outstanding-byte ledger that feeds it.
   *
   * Both are refs and both are per-CONNECTION. The verdict is sticky on purpose
   * — a second writer that goes quiet has not gone away — so the only thing that
   * clears it is a new connection, which is also what re-takes the buffer
   * measurement the other program corrupted.
   */
  const ownershipRef = useRef(new PortOwnershipWatch());
  const ourCharsRef = useRef(new OutstandingChars());

  useEffect(() => {
    if (opts.navigatorLike !== undefined) return;
    setAvail(
      serialAvailability(
        globalThis.navigator as unknown as { serial?: never },
        typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : true
      )
    );
  }, [opts.navigatorLike]);

  const say = useCallback((dir: ConsoleLine['dir'], text: string) => {
    setLines((l) => [...l.slice(-499), { dir, text, at: Date.now() }]);
  }, []);

  /** One inbound line, classified by `run/protocol.ts`. Nothing is parsed here. */
  const onLine = useCallback(
    (line: string) => {
      say('in', line);
      const inbound = classifyInbound(line);
      /* 🔴 EVERY line, before anything branches on it. This is where an `ok`
       * discharges what we owe and where a banner says the controller restarted
       * — and a ledger that only saw *some* lines would be exactly the partial
       * count that manufactures a foreign writer. */
      ourCharsRef.current.onInbound(inbound);
      if (inbound.status) {
        const r = inbound.status;
        setReport(r);
        setLastReportAt(Date.now());
        if (r.wco) setLastWco(r.wco);
        /* 🔴 §2: the RX buffer size is MEASURED from `Bf` while `Idle`, and R13
         * refuses a character-counted stream until it has been. The measurement
         * is a running maximum and a lower bound — see `measureBuffers`. It is
         * held in a ref as well as in state because `measuredRxBuffer` on the
         * tracked state is what the REFUSAL reads, and the two must be written
         * from the same value rather than from two updaters that can interleave.
         *
         * 🔴 And the SAME report goes to `PortOwnershipWatch` as an individual
         * sample, because the maximum cannot carry the second finding — see
         * `applyStatusReport`. One call, so the two cannot be wired apart. */
        const step = applyStatusReport({
          report: r,
          buffers: buffersRef.current,
          lastWco,
          streaming: streamingRef.current,
          ours: ourCharsRef.current,
          watch: ownershipRef.current,
          mask,
        });
        const nextBuffers = step.buffers;
        if (
          nextBuffers.rx !== buffersRef.current.rx ||
          nextBuffers.planner !== buffersRef.current.planner
        ) {
          buffersRef.current = nextBuffers;
          setBuffers(nextBuffers);
        }
        setTracked(step.track);
        return;
      }
      if (inbound.kind === 'alarm' && inbound.code != null) {
        const trust = positionTrustAfterAlarm(inbound.code);
        const spec = describeAlarm(inbound.code);
        say('note', `${spec.text} ${spec.action}`);
        setTracked((t) => ({
          ...t,
          tab: 'Alarm',
          controllerState: 'Alarm',
          controllerSubstate: inbound.code,
          positionTrusted: trust.trusted,
          positionUntrustedWhy: trust.trusted ? null : trust.why,
        }));
        return;
      }
      /* A `$$` line. `\$N=V` is a key/value, not a status grammar, so reading it
       * here is not a second parser — the DECODING of each value is
       * `run/protocol.ts`'s, and that is what is called below. */
      const kv = /^\$(\d+)=(.+)$/.exec(line.trim());
      if (kv) {
        const n = Number(kv[1]);
        const v = Number(kv[2]);
        if (n === 10 && Number.isFinite(v)) setMask(decodeReportMask(v));
        if (n === 13) setTracked((t) => ({ ...t, reportUnits: v === 1 ? 'inch' : 'mm' }));
        if (n === 22 && Number.isFinite(v)) {
          setTracked((t) => ({ ...t, homingEnabled: decodeHomingConfig(v).enabled }));
        }
        /* `$481` — the auto-report interval. Read, never written and never
         * assumed: it decides what this tab has to ASK for, and a tab that
         * assumed it was on would simply stop polling and let every readout
         * freeze. See `pollPlan` for the three worlds it selects between. */
        if (n === 481 && Number.isFinite(v)) {
          autoReportRef.current = v;
          setAutoReportMs(v);
          /* 🔴 RETUNE, because `$$` is now read AFTER the verdict rather than
           * before it. The old code sent `$$` at connect and decided the plan
           * two seconds later, so `$481` had usually — not always — arrived in
           * time; the plan was quietly racing a timer. Now the settings read
           * starts at the verdict, so the first plan is always the `$481 has not
           * been read` one, and this is where the real number replaces it. The
           * worker's `poll` command is documented as *"start, retune or stop"*,
           * so retuning is the supported path and not a second poller. */
          const w = worker.current;
          const next = pollPlan(v);
          if (w && pollRef.current && pollRef.current.intervalMs !== next.intervalMs) {
            pollRef.current = next;
            setPoll(next);
            w.postMessage({
              t: 'poll',
              intervalMs: next.intervalMs,
              fullEvery: next.fullEvery,
            } satisfies WorkerCommand);
            say('note', `$481 has now been read. ${next.why}`);
          }
        }
      }
      handshake.current.push(line);
    },
    [lastWco, mask, say]
  );

  /**
   * 🔴 **THE END OF THE LISTEN WINDOW, AND THE ONLY PLACE A VERDICT IS REACHED.**
   *
   * Runs twice at most on a connection: once when the passive window closes, and
   * once more if the operator authorised {@link IDENTIFY_PROBE} and it answered.
   * `probedRef` is what tells the two apart, and it is why a silent board is
   * asked about once rather than in a loop.
   *
   * Three outcomes, from {@link handshakeDecision}:
   *
   *  - **accept** — identified. The settings read goes out NOW
   *    ({@link afterVerdictCommands}), against firmware that has been classified,
   *    and polling starts.
   *  - **ask-operator** — silence, nothing probed yet. The tab stops, prints the
   *    exact bytes it would send and why they are not obviously safe, and waits.
   *    ⚠ **It writes nothing here.** The port stays open because it has to for
   *    the operator's answer to mean anything — every control is still refused,
   *    `identification` is still `null`, and `consoleRefusals` still holds the
   *    console shut.
   *  - **refuse** — the board spoke and was not recognised, or stayed silent
   *    through a probe. 🔴 **Close the port.** Unchanged, deliberately: an
   *    unidentified board is refused, not made usable. Leaving it open with a
   *    console is a loaded gun — someone types `G0 Z-50` into a Marlin board
   *    that executes it.
   */
  const settle = useCallback(() => {
    const w = worker.current;
    if (!w) return;
    const decision = handshakeDecision(handshake.current, { probed: probedRef.current });
    const v = decision.verdict;
    say('note', `${v.verdict}: ${v.evidence} — ${decision.why}`);

    if (decision.action === 'ask-operator') {
      say('note', describeProbe(decision.probe));
      setTracked((t) => ({ ...t, tab: 'Identifying', awaitingIdentifyConsent: true }));
      pollRef.current = null;
      setPoll(null);
      return;
    }
    if (decision.action === 'refuse') {
      w.postMessage({ t: 'close' } satisfies WorkerCommand);
      setTracked(initialTrackedState());
      pollRef.current = null;
      setPoll(null);
      return;
    }
    setTracked((t) => ({
      ...t,
      identification: v.verdict,
      tab: 'Idle',
      awaitingIdentifyConsent: false,
    }));
    /* §11 step 4, moved to after the verdict — see `afterVerdictCommands`. */
    for (const c of afterVerdictCommands(v)) w.postMessage(c);
    /* 🔴 START POLLING. One `0x87` at connect and nothing after it left the DRO,
     * the machine state, the buffer figure and the override readback frozen at
     * whatever the first report said — a tab whose whole purpose is monitoring,
     * showing one stale snapshot.
     *
     * The plan is decided from `$481` as this controller actually reports it
     * (`pollPlan`), and the TIMER LIVES IN THE WORKER: a `setInterval` here
     * would be throttled to ~1 s the moment the operator switches tabs, and the
     * readouts would slow down without anything on screen saying they had.
     * ⚠ Whether a worker of a hidden page is throttled too is UNMEASURED by this
     * lane — which is why the DRO renders the age of the report that actually
     * arrived rather than trusting that the poll happened. */
    const plan = pollPlan(autoReportRef.current);
    pollRef.current = plan;
    setPoll(plan);
    w.postMessage({
      t: 'poll',
      intervalMs: plan.intervalMs,
      fullEvery: plan.fullEvery,
    } satisfies WorkerCommand);
    say('note', plan.why);
  }, [say]);

  /**
   * 🔴 **THE OPERATOR AUTHORISING A WRITE TO UNIDENTIFIED FIRMWARE.**
   *
   * The only path in this file that can put a byte on a port before a verdict,
   * and it is reachable only from a control that is refused unless
   * `awaitingIdentifyConsent` is set ({@link uiStateGate}) — which is set only by
   * {@link settle} on the silence branch, after the exact bytes have been
   * printed to the console.
   *
   * It restates what it is about to send at the moment it sends it. The offer
   * and the send are separated by however long the operator took to read it, and
   * a transcript that shows the consent but not the bytes is a record of half
   * the decision.
   */
  const identifyNow = useCallback(() => {
    const w = worker.current;
    if (!w) return;
    probedRef.current = true;
    setTracked((t) => ({ ...t, awaitingIdentifyConsent: false }));
    say(
      'note',
      'AUTHORISED BY THE OPERATOR — writing to a controller that has NOT been identified: ' +
        IDENTIFY_PROBE.map((s) => s.bytes).join(', ') +
        '. If the reply does not identify it, the port closes.'
    );
    for (const c of identifyProbeCommands()) w.postMessage(c);
    setTimeout(settle, LISTEN_WINDOW_MS);
  }, [say, settle]);

  const connect = useCallback(() => {
    const serial = (
      opts.navigatorLike !== undefined
        ? (opts.navigatorLike as { serial?: SerialLike })
        : (globalThis.navigator as unknown as { serial?: SerialLike })
    )?.serial;
    if (!serial) return;
    // 🔴 Straight out of the click: `requestPort()` needs transient activation,
    // and an `await` in front of it spends the gesture (§1, and `SecurityError`
    // is classified as OUR bug for exactly this reason).
    serial
      .requestPort()
      .then(async (port) => {
        const ports = await serial.getPorts();
        const idx = ports.indexOf(port);
        const info = port.getInfo();
        const w = new Worker(new URL('./run/streamer.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.current = w;
        w.onmessage = (ev: MessageEvent<WorkerEvent>) => {
          const e = ev.data;
          if (e.t === 'line') onLine(e.line);
          else if (e.t === 'sent') {
            /* 🔴 THE ONLY EVENT THAT SEES BOTH CHANNELS. The worker posts this
             * for a streamed line and for a `write` line alike, after the bytes
             * have actually gone out — and posts nothing for a realtime byte or
             * for the status poller, which is what keeps those from being
             * charged. Counting only the streamer here is the planted defect in
             * `run-protocol.test.ts`. */
            ourCharsRef.current.onSent(e.line);
            say('out', e.line);
            setSender((s) => (s.stalled ? { ...s, stalled: false } : s));
          } else if (e.t === 'stream') {
            /* The sender's own accounting. 🔴 Completion is THIS, never the
             * controller's `Idle`: a streamer that has stopped feeding produces
             * `Idle` in the middle of a job, and that is the starvation case
             * (§4). */
            streamingRef.current = e.state === 'streaming';
            setSender((s) => ({
              ...s,
              state: e.state,
              sent: e.sent,
              acknowledged: e.acknowledged,
              total: e.total,
              abort: e.abort,
            }));
            if (e.state === 'aborted' && e.abort) {
              const response = abortResponse(e.abort);
              /* 🔴 A MOTION DECISION, MADE HERE AND SAID OUT LOUD. Stopping the
               * sender stops nothing that is already in the controller. */
              if (response.realtime) {
                ourCharsRef.current.onRealtime(response.realtime);
                w.postMessage({ t: 'realtime', name: response.realtime } satisfies WorkerCommand);
              }
              say('note', response.why);
              setTracked((t) => ({ ...t, tab: 'Aborted' }));
            } else if (e.state === 'done') {
              say(
                'note',
                `every line was sent and acknowledged (${e.acknowledged} of ${e.total}). That is the ` +
                  'sender’s accounting and it is not a claim about what was cut.'
              );
              setTracked((t) => ({ ...t, tab: 'Idle' }));
            }
          } else if (e.t === 'attach-failed') {
            say('note', e.error.message);
            setTracked(initialTrackedState());
          } else if (e.t === 'failure') {
            /* §10: the controller does NOT know the link went. It keeps
             * executing what is in its buffer and then sits at Idle with the
             * spindle running and the tool in the cut. */
            say('note', e.failure.error.message);
            streamingRef.current = false;
            setSender((s) => (s.state === 'streaming' ? { ...s, state: 'aborted' } : s));
            setTracked((t) => ({
              ...t,
              tab: 'DisconnectedMidJob',
              positionTrusted: false,
              positionUntrustedWhy:
                'the link dropped mid-job: up to a full RX buffer of lines may have executed after the last byte we wrote, so the line we think we were on was never better than “somewhere in the last buffer-full”.',
              reconnectedMidJob: true,
            }));
          } else if (e.t === 'stall') {
            say('note', `the sender has not written for ${e.ms}ms`);
            setSender((s) => ({ ...s, stalled: true }));
          }
        };
        w.postMessage({
          t: 'attach',
          portIndex: idx,
          usbVendorId: info.usbVendorId,
          usbProductId: info.usbProductId,
        } satisfies WorkerCommand);
        setTracked((t) => ({ ...t, tab: 'Identifying', awaitingIdentifyConsent: false }));
        /* 🔴 STEP 1 OF §11 AND NOTHING ELSE: LISTEN. `connectCommands()` is
         * empty and that is the fix — the three writes that used to go here went
         * to firmware nobody had classified, and were called harmless on the
         * strength of what grblHAL does with them. Read its doc comment before
         * putting anything back. */
        handshake.current = [];
        autoReportRef.current = null;
        probedRef.current = false;
        /* A new port is a new question. The watch is deliberately sticky within
         * a connection — reconnecting is what clears it, and reconnecting is
         * also what re-takes the buffer measurement a second writer corrupted —
         * so the fresh instance belongs here and nowhere else. */
        ownershipRef.current = new PortOwnershipWatch();
        ourCharsRef.current.reset();
        setAutoReportMs(null);
        setPoll(null);
        say(
          'note',
          'Port open, reader attached, and NOTHING has been written to it. This tab listens first: ' +
            'grblHAL announces itself at power-on, and a board that announces itself has been ' +
            'identified without anyone writing a byte to it.'
        );
        for (const c of connectCommands()) w.postMessage(c);
        /* ⚠ A TIMER, and the one place one is allowed: this waits for a banner
         * that may never come (a board running for an hour sends none), and it
         * paces nothing. The STREAMER is never timer-driven — that is §17 and
         * it is a different question from "how long do we listen before we
         * judge". */
        setTimeout(settle, LISTEN_WINDOW_MS);
      })
      .catch((err: unknown) => {
        const e = classifyPortError(err);
        say('note', e.message);
      });
  }, [onLine, opts.navigatorLike, say, settle]);

  /**
   * Reconnect to a previously-permitted port without the chooser dialog.
   *
   * Web Serial's `getPorts()` returns ports the origin already has permission
   * for — granted by an earlier `requestPort()` call in the same origin. After
   * a mid-job link drop the port permission persists, so this path skips the
   * gesture requirement and the chooser UI that `connect` goes through.
   */
  const reconnect = useCallback(() => {
    const serial = (
      opts.navigatorLike !== undefined
        ? (opts.navigatorLike as { serial?: SerialLike })
        : (globalThis.navigator as unknown as { serial?: SerialLike })
    )?.serial;
    if (!serial) return;
    serial.getPorts().then(async (ports) => {
      if (ports.length === 0) {
        say('note', 'No previously-permitted port found. Use Connect to grant permission.');
        return;
      }
      /* Pick the first port — permission is per-origin, and in the typical
       * single-port shop there is exactly one. */
      const port = ports[0];
      const idx = 0;
      const info = port.getInfo();
      /* Tear down any existing worker before creating a new one. */
      worker.current?.terminate();
      const w = new Worker(new URL('./run/streamer.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.current = w;
      w.onmessage = (ev: MessageEvent<WorkerEvent>) => {
        const e = ev.data;
        if (e.t === 'line') onLine(e.line);
        else if (e.t === 'sent') {
          ourCharsRef.current.onSent(e.line);
          say('out', e.line);
          setSender((s) => (s.stalled ? { ...s, stalled: false } : s));
        } else if (e.t === 'stream') {
          streamingRef.current = e.state === 'streaming';
          setSender((s) => ({
            ...s,
            state: e.state,
            sent: e.sent,
            acknowledged: e.acknowledged,
            total: e.total,
            abort: e.abort,
          }));
          if (e.state === 'aborted' && e.abort) {
            const response = abortResponse(e.abort);
            if (response.realtime) {
              ourCharsRef.current.onRealtime(response.realtime);
              w.postMessage({ t: 'realtime', name: response.realtime } satisfies WorkerCommand);
            }
            say('note', response.why);
            setTracked((t) => ({ ...t, tab: 'Aborted' }));
          } else if (e.state === 'done') {
            say(
              'note',
              `every line was sent and acknowledged (${e.acknowledged} of ${e.total}). That is the ` +
                "sender's accounting and it is not a claim about what was cut."
            );
            setTracked((t) => ({ ...t, tab: 'Idle' }));
          }
        } else if (e.t === 'attach-failed') {
          say('note', e.error.message);
          setTracked(initialTrackedState());
        } else if (e.t === 'failure') {
          say('note', e.failure.error.message);
          streamingRef.current = false;
          setSender((s) => (s.state === 'streaming' ? { ...s, state: 'aborted' } : s));
          setTracked((t) => ({
            ...t,
            tab: 'DisconnectedMidJob',
            positionTrusted: false,
            positionUntrustedWhy:
              'the link dropped mid-job: up to a full RX buffer of lines may have executed after the last byte we wrote, so the line we think we were on was never better than "somewhere in the last buffer-full".',
            reconnectedMidJob: true,
          }));
        } else if (e.t === 'stall') {
          say('note', `the sender has not written for ${e.ms}ms`);
          setSender((s) => ({ ...s, stalled: true }));
        }
      };
      w.postMessage({
        t: 'attach',
        portIndex: idx,
        usbVendorId: info.usbVendorId,
        usbProductId: info.usbProductId,
      } satisfies WorkerCommand);
      setTracked((t) => ({ ...t, tab: 'Identifying', awaitingIdentifyConsent: false }));
      handshake.current = [];
      autoReportRef.current = null;
      probedRef.current = false;
      ownershipRef.current = new PortOwnershipWatch();
      ourCharsRef.current.reset();
      setAutoReportMs(null);
      setPoll(null);
      say(
        'note',
        'Reconnecting — port opened via previous permission, reader attached, nothing written yet.'
      );
      for (const c of connectCommands()) w.postMessage(c);
      setTimeout(settle, LISTEN_WINDOW_MS);
    });
  }, [onLine, opts.navigatorLike, say, settle]);

  const disconnect = useCallback(() => {
    worker.current?.postMessage({ t: 'close' } satisfies WorkerCommand);
    worker.current?.terminate();
    worker.current = null;
    setTracked(initialTrackedState());
    setReport(null);
    setLastReportAt(null);
    /* The accounting goes with the connection. A `sent 400 of 900` left standing
     * beside a closed port is a picture of a job that is not running — and the
     * measured buffer belongs to the board that was on the other end, not to the
     * next one. */
    streamingRef.current = false;
    setSender({
      state: 'ready',
      sent: 0,
      acknowledged: 0,
      total: 0,
      stalled: false,
      startedAt: null,
      abort: null,
    });
    buffersRef.current = { rx: null, planner: null };
    setBuffers({ rx: null, planner: null });
    autoReportRef.current = null;
    /* Both go with the connection. A `probed` left true would deny the next
     * board its one ask; a `pollRef` left set would let a `$481` from nowhere
     * retune a poll on a worker that no longer exists. */
    probedRef.current = false;
    pollRef.current = null;
    /* And so does what we knew about who else was on the port: a baseline taken
     * against one board's ring says nothing about the next one's, and a verdict
     * left standing would be a fact about a port that is closed. */
    ownershipRef.current = new PortOwnershipWatch();
    ourCharsRef.current.reset();
    setAutoReportMs(null);
    setPoll(null);
    say(
      'note',
      'Port closed. ⚠ That did not stop the machine: the controller executes whatever is already ' +
        'in its buffer, then sits idle with the spindle still running.'
    );
  }, [say]);

  const send = useCallback(
    (name: RealtimeName) => {
      if (!worker.current) return;
      /* 🔴 `0x85` and `0x18` flush the ring under the character count (R7), so
       * from here on this tab cannot bound its own bytes — `'unknown'`, not a
       * reassuring zero. Decided inside the ledger so all three send paths get
       * the same answer. */
      ourCharsRef.current.onRealtime(name);
      worker.current.postMessage({ t: 'realtime', name } satisfies WorkerCommand);
      /* Design §13 wants realtime bytes in the transcript BY NAME. Without this
       * a `!` from the Hold button left no trace at all, and a console showing
       * every line and none of the bytes is a record of half the conversation. */
      say('out', realtimeEcho(name));
    },
    [say]
  );

  const writeLine = useCallback((line: string) => {
    if (!worker.current) return;
    /* ⚠ NO OPTIMISTIC ECHO. The worker posts `{ t: 'sent' }` after the bytes
     * have actually been written, and that event is echoed in `onmessage`.
     * Echoing here as well printed every handshake and console line twice, and a
     * transcript that shows a line that never left is worse than one that is
     * late. */
    worker.current.postMessage({ t: 'write', line } satisfies WorkerCommand);
  }, []);

  const stopFeeding = useCallback((why: string) => {
    worker.current?.postMessage({ t: 'stop', why } satisfies WorkerCommand);
    streamingRef.current = false;
  }, []);

  /**
   * 🔴 THE START PATH, AND THE ONLY ONE.
   *
   * The refusal set is asked HERE — one function call away from the bytes —
   * rather than trusted from the button's rendered state, because a control is
   * drawn from a snapshot and the machine moves on between renders. When it
   * refuses, the reasons go to the console verbatim and nothing is written.
   */
  const startJob = useCallback(
    (program: RunProgram | null, trackedNow: TrackedState): StartOutcome => {
      if (!worker.current) {
        const why =
          'Nothing is connected, so there is nothing to stream to. Connect a controller first.';
        say('note', why);
        return { status: 'refused', refusals: [], why };
      }
      const outcome = startCommands(program, trackedNow);
      if (outcome.status === 'refused') {
        say('note', `Start refused. ${outcome.why}`);
        return outcome;
      }
      for (const c of outcome.commands) worker.current.postMessage(c);
      streamingRef.current = true;
      setSender({
        state: 'streaming',
        sent: 0,
        acknowledged: 0,
        total: outcome.total,
        stalled: false,
        startedAt: Date.now(),
        abort: null,
      });
      setTracked((t) => ({ ...t, tab: 'Streaming' }));
      say(
        'note',
        `streaming ${outcome.total} lines of program ${outcome.hash}, ${trackedNow.streamMode}` +
          (trackedNow.streamMode === 'character-counting'
            ? ` against an RX buffer MEASURED at ${trackedNow.measuredRxBuffer} characters.`
            : ' — one line at a time, waiting for each reply.')
      );
      return outcome;
    },
    [say]
  );

  /**
   * 🔴 THE CONSOLE PATH, AND THE ONLY ONE.
   *
   * Exactly the shape of {@link startJob} and for exactly the same reason: the
   * refusal set is asked HERE, one function call away from the bytes, and the
   * outcome is returned rather than assumed. **Everything typed is echoed** —
   * including what was refused, marked as refused — because the console is the
   * record that routes a controller fact to `pcb`, and a record that omits the
   * commands the tab would not send is a record of the tab, not of the machine.
   */
  const runConsole = useCallback(
    (
      input: string,
      trackedNow: TrackedState,
      opts: { resetConfirmed?: boolean } = {}
    ): ConsoleOutcome => {
      const outcome = consoleAction(input, trackedNow, opts);
      switch (outcome.kind) {
        case 'nothing':
          return outcome;
        case 'note':
          say('out', outcome.echo);
          say('note', outcome.note);
          return outcome;
        case 'refused':
          say('refused', outcome.echo);
          say('note', outcome.refusals.map((r) => `${r.id} — ${r.why}`).join(' '));
          return outcome;
        case 'confirm':
          say('refused', outcome.echo);
          say('note', outcome.note);
          return outcome;
        case 'realtime':
          if (!worker.current) {
            say('note', 'Nothing is connected, so nothing was sent.');
            return outcome;
          }
          /* Echoed VERBATIM — what was typed, not a summary of it — and then the
           * byte it became, by name, so the transcript carries both what a human
           * asked for and what went on the wire. */
          say('out', outcome.echo);
          say('note', outcome.note);
          ourCharsRef.current.onRealtime(outcome.name);
          worker.current.postMessage({ t: 'realtime', name: outcome.name } satisfies WorkerCommand);
          return outcome;
        case 'line':
          if (!worker.current) {
            say('note', 'Nothing is connected, so nothing was sent.');
            return outcome;
          }
          /* The worker echoes the line when the bytes have actually gone out. */
          if (outcome.note) say('note', outcome.note);
          worker.current.postMessage({ t: 'write', line: outcome.line } satisfies WorkerCommand);
          return outcome;
      }
    },
    [say]
  );

  const setStreamMode = useCallback(
    (mode: StreamMode) => {
      setTracked((t) => ({ ...t, streamMode: mode }));
      say(
        'note',
        mode === 'send-response'
          ? 'Streaming mode switched to send-response: one line at a time, waiting for each reply. ' +
              'Slower than character-counting, but works when Bf is not reported ($10 bit 1 clear).'
          : 'Streaming mode switched to character-counting.'
      );
    },
    [say]
  );

  return {
    avail,
    tracked,
    report,
    lastWco,
    lastReportAt,
    mask,
    console: lines,
    sender,
    buffers,
    autoReportMs,
    poll,
    connect,
    reconnect,
    disconnect,
    identifyNow,
    send,
    writeLine,
    stopFeeding,
    startJob,
    runConsole,
    setStreamMode,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * What each control actually does
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The action map the tab renders with.
 *
 * 🔴 **A CONTROL THAT IS ABSENT FROM THIS MAP RENDERS DISABLED**, with the
 * reason, via {@link unbuiltRefusal} — which is why `zero` is absent rather
 * than stubbed:
 *
 *  - **Zero** writes `G10 L20` to the controller's NON-VOLATILE storage; it
 *    survives a power cycle and every later coordinate is measured from it. §15
 *    requires a confirmation showing the before/after `WCO`, and there is nowhere
 *    yet to show it.
 *
 * **Jog** is now a minimal single-press `$J=G91` on the button (X+10), with
 * keyboard shortcuts for X/Y/Z directional jog. The full press-and-hold loop
 * of design §8 (paced by `ok`, `0x85` on release, character-count reset) is
 * not yet built — this is a fixed-distance per-press jog that works and is
 * honest about what it does.
 *
 * ⚠ `stop` is the design's §16 two-step and the ORDER is the safety property:
 * `!` first (a controlled deceleration; position retained), and only then stop
 * feeding. Stopping the sender first leaves tens of buffered blocks executing
 * with nothing decelerating them.
 */
export function wiredActions(a: {
  conn: Pick<
    Connection,
    'connect' | 'identifyNow' | 'send' | 'writeLine' | 'stopFeeding' | 'startJob'
  >;
  program: RunProgram | null;
  tracked: TrackedState;
  awaitingAbortConfirm: boolean;
  setAwaitingAbortConfirm: (v: boolean) => void;
}): Partial<Record<ControlId, () => void>> {
  return {
    connect: a.conn.connect,
    /* 🔴 Wired, and gated by STATE rather than by absence: `uiStateGate` refuses
     * it unless the listen window closed in silence. `jog`/`zero` are absent
     * from this map because nothing is behind them; this one has something
     * behind it and is refused almost all of the time, which is a different
     * fact and renders a different reason. */
    identify: a.conn.identifyNow,
    start: () => {
      a.conn.startJob(a.program, a.tracked);
    },
    hold: () => a.conn.send('feedHold'),
    resume: () => a.conn.send('cycleStart'),
    stop: () => {
      a.conn.send('feedHold');
      a.conn.stopFeeding('the operator pressed Stop');
    },
    abort: () => {
      // One confirmation, because `0x18` while moving kills the steppers with no
      // deceleration and loses position. The cost is quoted at the control.
      if (!a.awaitingAbortConfirm) {
        a.setAwaitingAbortConfirm(true);
        return;
      }
      a.setAwaitingAbortConfirm(false);
      a.conn.send('reset');
    },
    'spindle-stop': () => a.conn.send('spindleStop'),
    'jog-cancel': () => a.conn.send('jogCancel'),
    jog: () => a.conn.writeLine('$J=G91 X10'),
    home: () => a.conn.writeLine('$H'),
    unlock: () => a.conn.writeLine('$X'),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The tab
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RunTabProps {
  /** The last report, parsed by `run/protocol.ts`. This file parses nothing. */
  report?: StatusReport | null;
  /** The most recent `WCO` on this connection. Change-only: usually not in the
   *  last report, and `null` until one has ever arrived (§5). */
  lastWco?: number[] | null;
  /** The tab's own tracked state. Default = knows nothing, refuses everything. */
  tracked?: TrackedState;
  /** `$10` decoded, so a missing field is named rather than left blank (§4). */
  mask?: ReportMask;
  /** The program the CNC tab handed over. `App.tsx` passes the LATCHED one —
   *  `runProgram.ts::programForRunTab` — so a re-plan cannot swap it. */
  program?: RunProgram | null;
  /** Sender accounting. Defaults to the live connection's own, which is fed by
   *  the worker's `stream` events; a prop overrides it for a fixture. */
  sender?: SenderView;
  /** Measured from `Bf` while `Idle` — never guessed (§2, R13). Defaults to the
   *  connection's own measurement. */
  buffers?: { rx: number | null; planner: number | null };
  /**
   * 🔴 **THE STREAMING FACT, HANDED OUTWARD** — see {@link StreamingSignal} for
   * exactly what a consumer must and must not do with it. In short: while
   * `streaming` is true the CNC tab's hand-over control must be **disabled**, not
   * merely confirmed; and `streaming === false` is never a claim that the machine
   * has stopped.
   *
   * ⚠ The refusal itself is NOT implemented here. This tab reports; the tab that
   * owns the hand-over control decides what to do about it.
   */
  onStreaming?: (signal: StreamingSignal) => void;
  /** `$481`, ms, as an override for a fixture. In the product it is read from
   *  `$$` by the live connection. 0/undefined ⇒ polled with `?`. */
  autoReportMs?: number;
  /** The poll plan, as an override for a fixture. In the product the connection
   *  decides it from `$481` at identification. */
  poll?: PollPlan | null;
  /** `Date.now()` when the last report arrived. Absent = none has. */
  lastReportAt?: number | null;
  /** Injected so the availability branches can be exercised without a browser. */
  navigatorLike?: { serial?: unknown };
  secureContext?: boolean;
  actions?: Partial<Record<ControlId, () => void>>;
  /** `Date.now` in the product; frozen in tests. */
  now?: number;
}

/* 🔴 NO DEFAULT VALUE ON THIS PARAMETER, AND IT IS NOT A STYLE CHOICE. Defaulting
 * it to an empty object literal makes the DECLARED parameter type
 * `RunTabProps | undefined`, which fails `createElement<P extends {}>`'s
 * constraint — so TypeScript falls back to the constraint and infers `P = {}` at
 * every call site. The effect is not a noisy error, it is SILENCE: no prop object
 * anywhere is checked against `RunTabProps` at all, and a misspelled or removed
 * prop renders a component that ignores it. Every field here is optional and
 * nothing calls `RunTab()` directly, so the default bought nothing to begin with.
 * Watched red: restoring it turns a planted `nowe:` typo from "did you mean
 * 'now'?" into 28 identical "does not exist in type 'Attributes'" errors, one per
 * correct prop — the typo indistinguishable from every prop that was right. */
export function RunTab(props: RunTabProps) {
  const { program = null, autoReportMs } = props;

  /* The live connection. Every field it produces can be OVERRIDDEN by a prop, so
   * the whole tab can be driven from a fixture in node — where there is no
   * `navigator.serial` and nothing below the availability check ever executes. */
  const conn = useSerialConnection({
    navigatorLike: props.navigatorLike,
    secureContext: props.secureContext,
  });

  const sender: SenderView = props.sender ?? conn.sender;
  const buffers = props.buffers ?? conn.buffers;

  /* 🔴 The default knows nothing and refuses everything — `protocol.ts` exports
   * `initialTrackedState` for exactly that reason: *"a caller starts from
   * refusal rather than from a permissive default it has to remember to
   * tighten."*
   *
   * ⚠ `trackedForProgram` folds in the facts the HELD PROGRAM contributes — R5's
   * `programLoaded` and R3's `programFirstZ`, neither of which anything was
   * setting, so the refusal set could not see the program the tab was drawing. A
   * caller that supplies `tracked` explicitly owns all of it, program facts
   * included: that is the fixture path, and it is the only way a test can put
   * the tab in a state the handshake has not reached. */
  const tracked = props.tracked ?? trackedForProgram(conn.tracked, program);
  const report = props.report !== undefined ? props.report : conn.report;
  const lastWco = props.lastWco !== undefined ? props.lastWco : conn.lastWco;
  const mask = props.mask ?? conn.mask;
  const avail = conn.avail;

  const [awaitingAbortConfirm, setAwaitingAbortConfirm] = useState(false);

  const now = props.now ?? Date.now();
  const lastMatch = useRef(0);

  /* 🔴 THE MASK GOES IN. `deriveDro` changes no NUMBER when it is given `$10` —
   * it changes the WORDS of the "no WCO" refusal, and those words are the
   * difference between *"wait, it is change-only"* and *"0x87 cannot force it,
   * change the setting at the controller"*. This tab decodes `$10` from `$$`
   * and, until now, did not hand it to the readout, so the operator got the
   * both-cases sentence on a machine where the answer was known.
   *
   * ⚠ The both-cases sentence is not a bug and must survive: `wcoUnavailable`'s
   * no-mask arm deliberately says only that `$10` was not given to the READOUT,
   * never that `$$` was unread — a cause it cannot check. Threading the mask
   * SELECTS between arms; it does not let the fallback claim more. `mask` is
   * `undefined` until identification completes, and that arm is still correct. */
  const dro: Dro | null = useMemo(
    () => (report ? deriveDro(report, lastWco, undefined, mask) : null),
    [report, lastWco, mask]
  );
  const state: MachineState = report?.state ?? tracked.controllerState;
  const move = motionVerdict(state, report?.substate ?? tracked.controllerSubstate);

  const matched = program ? matchOnPath(program.path, dro?.work.values ?? null, lastMatch.current, 2.0) : null;
  if (matched != null) lastMatch.current = matched;

  const ovFeed = report?.ov?.feed;
  const elapsed = sender?.startedAt ? (now - sender.startedAt) / 1000 : null;
  const remaining = remainingSeconds(program, matched, ovFeed ?? 100);
  /* The prediction: what the program's own feeds say, at 100% — deliberately NOT
   * scaled by the override, because the override is one of the three causes the
   * divergence has to be able to distinguish, and scaling it away would hide
   * exactly the case it explains. */
  const predicted = predictIndexAtTime(program, elapsed, 100);
  const div = divergence({
    predictedSeconds: program && matched != null ? pathSeconds(program, 0, matched, 100) : null,
    measuredSeconds: elapsed,
    feedOverridePct: ovFeed,
    senderStalled: !!sender?.stalled,
    matched,
  });

  /* Report AGE, not report presence: a report that arrived four seconds ago is
   * a DRO that is four seconds old, and the design puts that number in the top
   * band precisely so a frozen readout cannot pass for a live one. `null` when
   * nothing has ever arrived — which is a different fact from "old". */
  const lastReportAt = props.lastReportAt !== undefined ? props.lastReportAt : conn.lastReportAt;
  const reportAge = lastReportAt != null ? now - lastReportAt : null;

  /* 🔴 THE STALENESS VERDICT, AND THE DRO IS RENDERED THROUGH IT. The expected
   * interval is `$481` where the controller pushes, and the poll period where
   * this tab asks — two different numbers for the same question, and dividing by
   * the wrong one either cries wolf or never fires at all. */
  const plan = props.poll !== undefined ? props.poll : conn.poll;
  const autoReport = autoReportMs ?? conn.autoReportMs;
  const expectMs = autoReport && autoReport > 0 ? autoReport : (plan?.expectMs ?? null);
  const fresh = droFreshness({
    connected: tracked.tab !== 'Disconnected',
    ageMs: reportAge,
    expectMs,
    state,
  });
  const droShown = droRendering(dro, fresh);
  const linkQuiet = tracked.tab !== 'Disconnected' && (report == null || fresh.stale);

  /* What each control does. `zero` is deliberately absent — see
   * {@link wiredActions} — and its absence is what disables it. */
  const wired = useMemo(
    () =>
      wiredActions({
        conn,
        program,
        tracked,
        awaitingAbortConfirm,
        setAwaitingAbortConfirm,
      }),
    [conn, program, tracked, awaitingAbortConfirm]
  );

  const actions = props.actions ?? wired;

  /* 🔴 THE SET IS READ OFF THE MAP THE TAB IS ACTUALLY RENDERING WITH. A button
   * added without an action disables itself and says so; nothing has to remember
   * to add it to a list. */
  const implemented = useMemo(
    () => new Set(Object.keys(actions).filter((k) => actions[k as ControlId]) as ControlId[]),
    [actions]
  );

  /* ── Keyboard shortcuts ───────────────────────────────────────────────────
   *
   * Arrow keys for directional jog, PageUp/Down for Z, Escape for feed hold,
   * and Home for $H. Each shortcut calls the same send path the button uses.
   *
   * Guard: only when the tab is connected (not Disconnected) and the event
   * target is not a text input or textarea — typing in the console must not
   * trigger machine commands. */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      /* Never intercept keys while the user is typing in the console or any
       * other text input. */
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (tracked.tab === 'Disconnected') return;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'ArrowDown':
        case 'PageUp':
        case 'PageDown': {
          /* Route through runConsole so the full refusal set is checked
           * before anything goes on the wire — R6 blocks jog during
           * Streaming/Held and in Alarm, and the streaming guard blocks all
           * lines mid-job. A hand-rolled controllerState === 'Idle' check
           * missed the tab-state refusals. Using runConsole rather than
           * consoleAction + writeLine means a refusal is echoed to the
           * transcript with its reason, same as a typed line would be. */
          const jogMap: Record<string, string> = {
            ArrowRight: '$J=G91 X10',
            ArrowLeft: '$J=G91 X-10',
            ArrowUp: '$J=G91 Y10',
            ArrowDown: '$J=G91 Y-10',
            PageUp: '$J=G91 Z5',
            PageDown: '$J=G91 Z-5',
          };
          const line = jogMap[e.key];
          if (line) {
            e.preventDefault();
            conn.runConsole(line, tracked);
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          actions.hold?.();
          break;
        case 'Home': {
          /* Route through runConsole so uiStateGate checks refusals
           * ($H allowed only from Idle or Alarm) before anything goes on
           * the wire. Using runConsole means a refusal is echoed to the
           * transcript with its reason, same as a typed "$H" would be. */
          e.preventDefault();
          conn.runConsole('$H', tracked);
          break;
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [conn, tracked, actions]);

  const refusals = useMemo(() => {
    const map = {} as Record<ControlId, ControlRefusal[]>;
    for (const id of [
      'connect',
      'identify',
      'start',
      'hold',
      'resume',
      'stop',
      'abort',
      'spindle-stop',
      'jog',
      'jog-cancel',
      'home',
      'zero',
      'unlock',
    ] as ControlId[]) {
      map[id] = controlRefusals(id, tracked, implemented);
    }
    return map;
  }, [tracked, implemented]);

  const act = useCallback((id: ControlId) => () => actions?.[id]?.(), [actions]);

  /**
   * 🔴 The console shares `Abort`'s ONE confirmation latch.
   *
   * `/reset` and the `Abort` button both send `0x18`, and `0x18` while the
   * machine is moving kills the steppers with no deceleration and loses
   * position. If the console had its own latch — or none — it would be the
   * cheaper of two paths to the same consequence, and the expensive one would
   * simply stop being used.
   */
  const submitConsole = useCallback(
    (text: string) => {
      const outcome = conn.runConsole(text, tracked, { resetConfirmed: awaitingAbortConfirm });
      if (outcome.kind === 'confirm') setAwaitingAbortConfirm(true);
      else if (outcome.kind === 'realtime' && outcome.name === 'reset') {
        setAwaitingAbortConfirm(false);
      }
      return outcome;
    },
    [conn, tracked, awaitingAbortConfirm]
  );

  const pins = decodePins(report?.pn ?? null);

  /* 🔴 THE FACT NOTHING OUTSIDE THIS TAB COULD SEE, HANDED OUT. Reported on
   * change only, and reported as a plain fact — this tab does not decide what
   * anyone does about it. See `StreamingSignal` for what the consumer owes it. */
  const signal = useMemo(
    () =>
      streamingSignal({
        program,
        state: sender.state ?? 'ready',
        sent: sender.sent,
        acknowledged: sender.acknowledged,
        total: sender.total,
        startedAt: sender.startedAt,
        abort: sender.abort ?? null,
        linkLost: tracked.tab === 'DisconnectedMidJob',
      }),
    [program, sender, tracked.tab]
  );
  const onStreaming = props.onStreaming;
  const lastSignal = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify(signal);
    if (key === lastSignal.current) return;
    lastSignal.current = key;
    onStreaming?.(signal);
  }, [signal, onStreaming]);

  return (
    <div
      data-testid="run-tab"
      style={{ padding: 12, overflow: 'auto', minHeight: 0, flex: '1 1 auto' }}
    >
      {/* ─── what this tab has never done ───────────────────────────────── */}
      {(typeof __CTRL_TRANSCRIPTS__ === 'undefined' || !__CTRL_TRANSCRIPTS__) && (
        <div
          data-testid="run-unproven"
          style={{
            border: '1px solid var(--bad)',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
          }}
        >
          <strong className="bad">Nothing here has ever run a machine</strong>
          <p style={{ margin: '6px 0 0' }}>
            The router is <strong>ordered and has not arrived</strong>. Every check this tab has runs
            against a simulated controller in node — this app’s own model of grblHAL — so it can show
            that the tab agrees with our reading of the firmware and can never show that the reading is
            right. <strong>Nothing in this app has cut anything.</strong>
          </p>
        </div>
      )}

      {/* ─── the port is open, nothing has been written, and nobody spoke ── */}
      {tracked.awaitingIdentifyConsent ? (
        <div
          className="block"
          data-testid="run-identify-consent"
          style={{ marginTop: 12, border: '1px solid var(--warn)' }}
        >
          <strong className="warn">
            This controller has not been identified, and nothing has been written to it
          </strong>
          <p style={{ margin: '6px 0 0' }}>
            The port opened, the reader attached, and{' '}
            <strong>no bytes arrived in {LISTEN_WINDOW_MS / 1000} seconds</strong>. That is the one
            answer that says nothing about the board: grblHAL prints its banner only at power-on, so
            a controller that has been running for hours is silent — and so is a dead cable, the
            wrong port, and the wrong baud rate.
          </p>
          <p style={{ margin: '6px 0 0' }}>
            <strong>The step with no risk in it is to reset or power-cycle the controller</strong>,
            which makes it announce itself and needs nothing from us. The alternative is to ask it,
            and asking means writing to firmware nobody has classified. Exactly this would go out,
            in this order:
          </p>
          <ul data-testid="run-identify-bytes" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {IDENTIFY_PROBE.map((s) => (
              <li key={s.bytes} style={{ margin: '4px 0' }}>
                <code>{s.bytes}</code> — {s.asks}
                <br />
                <span className="warn">on unidentified firmware: {s.onUnknownFirmware}</span>
              </li>
            ))}
          </ul>
          <p className="bad" style={{ margin: '6px 0 0' }} data-testid="run-identify-risk">
            “Read-only” is a fact about grblHAL and about nothing else. <code>$</code> is not a
            universal no-op — on some firmwares it prefixes a parameter <strong>write</strong> — and{' '}
            <code>0x87</code> is an arbitrary byte whose meaning belongs to whatever is actually
            running. This tab will not send it on its own.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <Control
              id="identify"
              label="Ask it to identify itself"
              refusals={refusals.identify}
              onClick={act('identify')}
            />
          </div>
          <p className="note" style={{ margin: '8px 0 0' }}>
            If the reply still does not identify the firmware, the port closes. Nothing here makes an
            unknown board usable.
          </p>
        </div>
      ) : null}

      {/* ─── identifying countdown ─────────────────────────────────────── */}
      {tracked.tab === 'Identifying' && !tracked.awaitingIdentifyConsent ? (
        <IdentifyingNotice />
      ) : null}

      {/* ─── the browser ────────────────────────────────────────────────── */}
      {avail && !avail.ok ? (
        <div className="block" data-testid="run-unavailable" style={{ marginTop: 12 }}>
          <strong className="bad">This browser cannot open a serial port</strong>
          <p style={{ margin: '6px 0 0' }}>{avail.reason}</p>
          <p className="note" style={{ margin: '6px 0 0' }}>
            The controller is grblHAL on a BTT SKR Pro — an STM32F407 with no ethernet and no radio —
            so the only route from a browser is Web Serial over USB. It needs{' '}
            <strong>Chrome or Edge</strong> on a desktop and a secure context (HTTPS or localhost).
            There is <strong>no polyfill</strong>: a serial port is not something JavaScript can
            shim, and on iOS every browser is Safari’s engine, so no iPhone or iPad will run this.
          </p>
        </div>
      ) : null}

      {/* ─── state and the DROs ─────────────────────────────────────────── */}
      <div className="block" data-testid="run-status" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <strong data-testid="run-state">
            {tracked.tab === 'Disconnected' ? 'Not connected' : (report?.stateWord ?? state)}
          </strong>
          <span className={move.mayMove ? 'bad' : 'note'} data-testid="run-state-sentence">
            {tracked.tab === 'Disconnected' ? 'Nothing here can reach a controller.' : move.why}
          </span>
          {!move.positionGuaranteed ? (
            <span className="bad" data-testid="run-position-not-guaranteed">
              Position is not guaranteed in this state.
            </span>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 24, marginTop: 8, flexWrap: 'wrap' }}>
          <div data-testid="run-dro-machine" data-stale={droShown.markStale ? 'true' : 'false'}>
            <div className="note" style={{ margin: 0 }}>
              Machine{droShown.markStale ? ' — last known' : ''}
            </div>
            {/* 🔴 A stale number is DIMMED as well as labelled. Two channels,
             * because the label is the thing an operator stops reading and the
             * digits are the thing they keep reading. */}
            <code style={droShown.markStale ? { color: 'var(--muted)' } : undefined}>
              {droShown.machine}
            </code>
            {dro?.machine.unavailable ? (
              <p className="note" data-testid="run-dro-machine-note" style={{ margin: 0 }}>
                {dro.machine.unavailable}
              </p>
            ) : null}
          </div>
          <div data-testid="run-dro-work" data-stale={droShown.markStale ? 'true' : 'false'}>
            <div className="note" style={{ margin: 0 }}>
              Work {dro?.wcs ? `(${dro.wcs})` : ''}
              {droShown.markStale ? ' — last known' : ''}
            </div>
            <code style={droShown.markStale ? { color: 'var(--muted)' } : undefined}>
              {droShown.work}
            </code>
            {dro?.work.unavailable ? (
              <p className="note" data-testid="run-dro-work-note" style={{ margin: 0 }}>
                {dro.work.unavailable}
              </p>
            ) : null}
          </div>
          <div data-testid="run-wco">
            <div className="note" style={{ margin: 0 }}>
              WCO
            </div>
            <code>{axes(dro?.wco ?? null)}</code>
            <p className="note" style={{ margin: 0 }}>
              tool length reference:{' '}
              {report?.tlr == null ? 'not reported' : report.tlr ? 'set' : 'not set'}
            </p>
          </div>
        </div>

        {/* 🔴 THE STALENESS CLAIM, BESIDE THE DIGITS. Not in a tooltip, not in a
         * separate status strip: the number and the claim about the number are
         * read together or the claim is not read at all. */}
        {droShown.markStale ? (
          <p
            className={droShown.loud ? 'bad' : 'note'}
            data-testid="run-dro-stale"
            data-loud={droShown.loud ? 'true' : 'false'}
            data-expected-silence={fresh.expectedSilence ? 'true' : 'false'}
            style={{ margin: '4px 0 0' }}
          >
            {droShown.note}
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 24, marginTop: 8, flexWrap: 'wrap' }}>
          <span data-testid="run-feed">
            Feed{' '}
            {report?.fs
              ? `F${report.fs.feed} × ${ovFeed ?? 100}% = ${Math.round(
                  (report.fs.feed * (ovFeed ?? 100)) / 100
                )} mm/min`
              : (mask ? missingFieldNote('FS', mask) : null) || 'not reported'}
          </span>
          <span data-testid="run-speed">
            Spindle{' '}
            {report?.fs
              ? `${report.fs.programmedRpm} rpm programmed${
                  report.fs.actualRpm != null ? `, ${report.fs.actualRpm} actual` : ''
                }`
              : 'not reported'}
          </span>
          <span data-testid="run-overrides">
            Overrides{' '}
            {report?.ov
              ? `feed ${report.ov.feed}% · rapid ${report.ov.rapid}% · spindle ${report.ov.spindle}%`
              : (mask ? missingFieldNote('Ov', mask) : null) ||
                'not reported — the override controls would be asserting a state they cannot see'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 24, marginTop: 8, flexWrap: 'wrap' }}>
          <span data-testid="run-buffer">
            Buffer{' '}
            {report?.bf
              ? `${report.bf.plannerFree}${buffers.planner ? `/${buffers.planner}` : ''} planner blocks free · ` +
                `${report.bf.rxFree}${buffers.rx ? `/${buffers.rx}` : ''} RX characters free`
              : (mask ? missingFieldNote('Bf', mask) : null) ||
                'not reported — character counting cannot be calibrated from it'}
          </span>
          <span data-testid="run-lines">
            {/* 🔴 Two different numbers, both true (§13): `Ln:` is the line the
             * PLANNER is executing; the sender's count is what has been
             * TRANSMITTED. The gap between them IS the buffer, and showing one
             * hides it. */}
            Line executing {report?.ln ?? NOT_KNOWN} · sent {sender?.sent ?? 0} · acknowledged{' '}
            {sender?.acknowledged ?? 0} of {sender?.total ?? program?.lines.length ?? 0}
          </span>
          <span data-testid="run-elapsed">Elapsed {hhmmss(elapsed)}</span>
          <span data-testid="run-remaining">
            Remaining {hhmmss(remaining)}{' '}
            <span className="note">
              {remaining == null
                ? '— the tool could not be located on the programmed path, so no estimate is made'
                : 'estimated: remaining program length ÷ programmed feeds × the current feed override; rapids at the machine’s rapid rate'}
            </span>
          </span>
        </div>

        {/* 🔴 THE ASSUMPTION UNDER THE CHARACTER COUNT, ON SCREEN WHATEVER THE
          * ANSWER IS. `Bf` is the active stream's own pointer over the one ring
          * a second program's bytes land in too, so this tab's count undercounts
          * by exactly theirs — and grblHAL drops the excess with no error, no
          * message and no report field. The verdict word is rendered raw
          * (`unchecked` / `no-disagreement` / `foreign-writer`) because none of
          * the three may be read as "sole owner": a second writer sending only
          * realtime bytes is invisible here, and the sentence says so. */}
        <p
          className={tracked.portOwnership === 'foreign-writer' ? 'bad' : 'note'}
          data-testid="run-ownership"
          data-verdict={tracked.portOwnership}
          style={{ margin: '8px 0 0' }}
        >
          <strong>Port ownership: {tracked.portOwnership}</strong> —{' '}
          {tracked.portOwnershipWhy ?? OWNERSHIP_UNCHECKED}
        </p>

        <p className="note" style={{ margin: '8px 0 0' }} data-testid="run-link">
          {report == null
            ? 'No report has been received.'
            : `Last report ${reportAge == null ? 'age unknown' : `${reportAge}ms ago`}. `}
          <span data-testid="run-poll">
            {plan
              ? plan.why
              : tracked.tab === 'Disconnected'
                ? 'Not connected, so nothing is being asked for.'
                : 'Status polling has not started: it begins once the controller has been identified, and the first request of every connection is a full report (0x87) because WCO, Ov and H are change-only.'}
          </span>{' '}
          {/* ⚠ The poll timer is the WORKER's, not this page's — Chrome throttles
           * timers in a hidden page — and whether a worker of a hidden page is
           * throttled too is UNMEASURED here. So this line says what is known
           * rather than what is hoped, and the DRO carries its own age above. */}
          <span data-testid="run-poll-caveat">
            The poll timer runs in the streamer worker rather than in this page, because Chrome
            throttles timers in a hidden page. ⚠ Whether a worker of a hidden page is throttled too
            has <strong>not been measured for this app</strong> — so the readouts above carry the age
            of the report that actually arrived, and do not assume the poll happened.
          </span>
          {linkQuiet
            ? ' — the machine’s state is unknown. That is not the same fact as “the machine stopped”: it is still executing whatever is in its buffer. During a homing cycle this silence is EXPECTED, because $10 bit 12 is off by default, so a watchdog that holds the job here would fire on every homing cycle — and a control that false-fires gets muted.'
            : ''}
        </p>
        {report?.mpg ? (
          <p className="bad" data-testid="run-pendant" style={{ margin: '6px 0 0' }}>
            A pendant has taken the input stream (MPG:1). The readouts stay live and the controls do
            not: two senders on one stream is how a machine gets two different ideas of what it is
            doing.
          </p>
        ) : null}
        {pins.length ? (
          <p className="warn" data-testid="run-pins" style={{ margin: '6px 0 0' }}>
            Inputs asserted: {pins.map((p) => p.label).join(', ')}
          </p>
        ) : null}
      </div>

      {/* ─── the program, identified by the bytes ───────────────────────── */}
      <div className="block" data-testid="run-program" style={{ marginTop: 12 }}>
        <strong>Program</strong>
        {program ? (
          <>
            <p style={{ margin: '4px 0 0' }}>
              <strong>{program.name}</strong> · {program.lines.length} lines ·{' '}
              <code data-testid="run-program-hash">{program.hash}</code>
            </p>
            {/* 🔴 R5's whole point: the picture and the bytes must be the same
             * program, and a hash is how an operator can tell. The same checksum
             * is printed beside the hand-over control in the CNC tab. */}
            <p className="note" style={{ margin: '4px 0 0' }} data-testid="run-program-firstz">
              {tracked.programFirstZ == null
                ? 'The first motion’s Z could not be read from the emitted text, so the descent check (R3) cannot be made and Start is refused. That is the case for any program that is not one of ours: an incremental, inch, or G53 opening move is not a work-Z this tab may compare against.'
                : `First motion: G0 Z${tracked.programFirstZ.toFixed(3)} in work coordinates. Start is refused unless the tool is at or below that height, because G54 persists across power cycles and a stale offset turns the opening rapid into a plunge.`}
            </p>
            <p className="note" style={{ margin: '4px 0 0' }}>
              This is the program handed over from the CNC tab, and nothing there changes it
              afterwards — a re-plan is reported as newer, never swapped in.
            </p>
          </>
        ) : (
          <p className="note" style={{ margin: '4px 0 0' }} data-testid="run-program-none">
            Nothing has been handed over. Use <strong>Hand to the Run tab</strong> beside the CNC
            tab’s G-code panel.
          </p>
        )}
      </div>

      {/* ─── the picture ────────────────────────────────────────────────── */}
      <div className="block" data-testid="run-progress" style={{ marginTop: 12 }}>
        <strong>Progress</strong>
        <ProgressCanvas program={program} matched={matched} predicted={predicted} />
        <p className="note" data-testid="run-legend" style={{ margin: '6px 0 0' }}>
          <strong>Filled round marker</strong> — measured: where the controller says the tool is.{' '}
          <strong>Dashed square outline</strong> — predicted: where the program’s own feeds say it
          should be. They are told apart by fill and shape, not by colour. The heavy line means{' '}
          <strong>the tool has passed here</strong>, which is not the same claim as “material was
          removed here”.
        </p>
        <p
          className={div.cause === 'starvation' || div.cause === 'model' ? 'bad' : 'note'}
          data-testid="run-divergence"
          data-cause={div.cause}
          style={{ margin: '6px 0 0' }}
        >
          {div.signedSeconds != null
            ? `${div.signedSeconds > 0 ? '+' : ''}${div.signedSeconds.toFixed(1)} s — `
            : ''}
          {div.text}
        </p>
      </div>

      {/* ─── controls ───────────────────────────────────────────────────── */}
      <div className="block" data-testid="run-controls" style={{ marginTop: 12 }}>
        <strong>Controls</strong>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <Control id="connect" label="Connect" refusals={refusals.connect} onClick={act('connect')} />
          <Control id="start" label="Start" refusals={refusals.start} onClick={act('start')} />
          <Control id="hold" label="Hold (feed)" refusals={refusals.hold} onClick={act('hold')} />
          <Control id="resume" label="Resume" refusals={refusals.resume} onClick={act('resume')} />
          <Control id="home" label="Home ($H)" refusals={refusals.home} onClick={act('home')} />
          <Control id="unlock" label="Unlock ($X)" refusals={refusals.unlock} onClick={act('unlock')} />
          <Control id="jog" label="Jog" refusals={refusals.jog} onClick={act('jog')} />
          <Control
            id="jog-cancel"
            label="Cancel jog"
            refusals={refusals['jog-cancel']}
            onClick={act('jog-cancel')}
          />
          <Control
            id="spindle-stop"
            label="Spindle stop"
            refusals={refusals['spindle-stop']}
            onClick={act('spindle-stop')}
          />
          <Control id="zero" label="Zero (G10 L20)" refusals={refusals.zero} onClick={act('zero')} />
        </div>
        <p className="note" style={{ margin: '8px 0 0' }}>
          Hold is a controlled deceleration and <strong>leaves the spindle turning</strong>. Unlock
          is <code>$X</code>: it clears the lock and restores nothing — no position, no homing, no
          offsets — so it is permission to jog and to home, never permission to cut. Zero writes to
          the controller’s non-volatile storage, survives a power cycle, and every later coordinate
          is measured from it.
        </p>
        {/* ─── send-response streaming fallback (R13) ─────────────────────────
         * When Bf is not reported ($10 bit 1 clear), character-counting cannot
         * calibrate its buffer count. R13 refuses Start in that case. This
         * button offers the alternative: send-response mode, which sends one
         * line at a time and waits for each `ok`. Slower, but works without Bf. */}
        {tracked.streamMode === 'character-counting' && tracked.measuredRxBuffer === null && tracked.tab !== 'Disconnected' ? (
          <div
            data-testid="run-send-response-offer"
            style={{ marginTop: 8, padding: '8px 10px', border: '1px solid var(--warn)', borderRadius: 'var(--radius)' }}
          >
            <p style={{ margin: 0 }}>
              <strong>R13 — the RX buffer size has not been measured</strong> (
              <code>Bf</code> was not reported, so <code>$10</code> bit 1 is likely clear). Start is
              refused because character-counting cannot calibrate against an unknown buffer.
            </p>
            <p style={{ margin: '6px 0 0' }}>
              <button
                type="button"
                data-testid="run-switch-send-response"
                onClick={conn.setStreamMode ? () => conn.setStreamMode('send-response') : undefined}
                disabled={!conn.setStreamMode}
                style={{
                  padding: '5px 10px',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--line)',
                  background: 'transparent',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                Switch to send-response
              </button>{' '}
              — sends one line at a time, waits for each <code>ok</code> before sending the next.
              Slower than character-counting, but works without <code>Bf</code>. The mode is shown on
              screen while streaming.{' '}
              <strong>
                Alternatively, enable <code>$10</code> bit 1 at the controller and reconnect.
              </strong>
            </p>
          </div>
        ) : null}
      </div>

      {/* ─── reconnect after mid-job link drop ──────────────────────────── */}
      {tracked.tab === 'DisconnectedMidJob' ? (
        <div
          className="block"
          data-testid="run-reconnect"
          style={{ marginTop: 12, border: '1px solid var(--warn)' }}
        >
          <strong className="warn">The link dropped mid-job</strong>
          <p style={{ margin: '6px 0 0' }}>
            The port closed while a job was streaming. The controller does not know the link went — it
            keeps executing what is in its buffer, then sits idle with the spindle running.
          </p>
          <p style={{ margin: '6px 0 0' }}>
            <button
              type="button"
              data-testid="run-reconnect-button"
              onClick={conn.reconnect}
              style={{
                padding: '5px 10px',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--line)',
                background: 'transparent',
                color: 'var(--ink)',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              Reconnect
            </button>{' '}
            uses a previously-permitted port — no chooser dialog, no user gesture required. The
            controller's position will not be trusted after reconnection.
          </p>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <StopPanel
          stopRefusals={refusals.stop}
          abortRefusals={refusals.abort}
          onStop={actions?.stop}
          onAbort={actions?.abort}
          awaitingAbortConfirm={awaitingAbortConfirm}
        />
      </div>

      {/* ─── everything refused right now, in one place ─────────────────── */}
      <div className="block" data-testid="run-refusals" style={{ marginTop: 12 }}>
        <strong>Refused right now, and why</strong>
        <RefusalList tracked={tracked} />
      </div>

      {/* ─── the console ────────────────────────────────────────────────── */}
      <ConsolePanel
        lines={conn.console}
        onSubmit={submitConsole}
        awaitingResetConfirm={awaitingAbortConfirm}
        refusals={consoleRefusals(tracked)}
      />

      {/* ─── the seams that are not built ───────────────────────────────── */}
      {/* ⚠ RE-AUDITED AGAINST THE CODE, not against its own last version. Two of
          these lines said the CNC tab did not hand a program over, weeks after it
          did, and no test asserted the copy so nothing went red. A stale red lies
          exactly like a stale green. */}
      <div className="block" data-testid="run-gaps" style={{ marginTop: 12 }}>
        <strong>What is not wired yet</strong>
        <ul className="note" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {/* ⚠ THE `only ever run in node against a simulated controller`
            * TRAILERS ARE GONE FROM BULLETS 1 AND 3 (2026-08-11). The
            * red-bordered `run-unproven` banner at the top of this tab states
            * that for the WHOLE tab, in more detail, and the two trailers
            * repeated it with no narrowing. What each bullet says about ITSELF —
            * *"Start is wired and has never streamed to a machine"*, *"the
            * console input is wired and has never reached a controller"* — is a
            * different per-item claim and is the point of this list.
            *
            * 🔴 BULLET 7's `never been on the other end of a USB cable` STAYS.
            * It is tied to gate `CTRL` pending and gate `RUN` not existing,
            * which is a claim about our COVERAGE, not about where our checks
            * run. */}
          <li>
            <strong>Start is wired and has never streamed to a machine.</strong> Pressing it builds a{' '}
            <code>load</code> and a <code>start</code> for the worker, which owns the port.
          </li>
          <li>
            <strong>Zero is drawn and disabled</strong>, because nothing is behind it.
            Zero writes <code>G10 L20</code> to non-volatile storage and needs the before/after
            offset shown before anyone presses it. Jog is now wired as a minimal single-press{' '}
            <code>$J=G91</code> with keyboard shortcuts (arrows for X/Y, PageUp/Down for Z); the
            full press-and-hold loop of §8 is not yet built.
          </li>
          <li>
            <strong>The console input is wired and has never reached a controller.</strong> It takes{' '}
            <code>$</code> commands and realtime bytes by name, refuses arbitrary g-code through the
            same <code>refusalsFor</code> the Start button uses, refuses everything while a job is
            streaming, and makes <code>/reset</code> cost the same two presses as Abort.
          </li>
          <li>
            {/* 🔴 THE CAVEAT ITSELF LIVES BESIDE THE DRO (`run-poll-caveat`),
              * NOT HERE — 2026-08-11. Both blocks are unconditional and on the
              * same scrollable page, and the clause *"whether a worker of a
              * hidden page is throttled too has not been measured for this app"*
              * was word-for-word identical in the two.
              *
              * ⚠ THE FIX IS PLACEMENT, NOT COMPRESSION, and the placement was
              * decided by this file's own rule: `🔴 THE STALENESS CLAIM, BESIDE
              * THE DIGITS` — the number and the claim about the number are read
              * together or the claim is not read at all. So the DRO keeps the
              * unmeasured claim, the Chrome-throttling reason and the *"do not
              * assume the poll happened"* consequence, verbatim; this bullet
              * keeps what the DRO copy does not carry, which is the mechanism
              * (`?`, `0x87`, `$481`) and the RUN-18 link. */}
            <strong>Status polling is wired; the hidden-tab half of it is not measured.</strong> The
            worker polls with <code>?</code> and asks for a full report (<code>0x87</code>)
            periodically, at a rate decided from this controller’s own <code>$481</code>. The
            unmeasured half is the same open question as <code>RUN-18</code>; the DRO carries the
            caveat beside the digits, and marks itself last-known rather than current when a report
            is overdue.
          </li>
          <li>
            <strong>Send-response streaming is now offered as a fallback.</strong> When{' '}
            <code>Bf</code> is not reported (<code>$10</code> bit 1 clear), the controls section shows
            a button to switch to send-response mode — one line at a time, waiting for each{' '}
            <code>ok</code>. Slower than character-counting, but works without a measured buffer size.
            The mode is shown on screen while streaming.
          </li>
          <li>
            Nothing has been measured with the page hidden (gate branch <code>RUN-18</code>). The
            streamer is built read-driven rather than timer-driven precisely because a timer pump
            stalls in a hidden tab — that is the design’s reasoning, and it is not a measurement.
          </li>
          <li>
            No transcript from a real controller exists, so gate <code>CTRL</code> pends and this tab
            has never been on the other end of a USB cable. Gate <code>RUN</code> itself is specified
            in the design and does not exist in <code>gates/slicer_gate_check.mjs</code>; what
            watches this tab today is <code>web/tests/run.test.ts</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Every refusal currently standing, across every action — **in full for the
 * ones with no control of their own, and as an index for the ones already
 * answered beside the button that is refused.**
 *
 * 🔴 THIS PANEL USED TO PRINT THE WHOLE SET AGAIN. `Control` renders
 * `${id} — ${why}` under every disabled button and `ConsolePanel` does the same
 * under the input, so in a disconnected or alarmed state — the states an
 * operator actually meets — the same `fact` + `why` sentence stood twice on one
 * scrollable page, a few hundred pixels apart.
 *
 * 🔴 THE PER-BUTTON COPY IS THE ONE THAT SURVIVED, and the choice is not a
 * coin-toss between two equal placements. `Control`'s own comment names the
 * failure that decides it: *a disabled button whose reason lives only somewhere
 * else is a control that fails silently for anyone on a touch screen or a
 * keyboard — which in a shop is most people, because the other hand is on the
 * machine.* A reason attached to the thing being pressed beats a reason in a
 * list you have to go and find.
 *
 * ⚠ AND THE LIST'S OWN ARGUMENT SURVIVES INTACT. It was *"an operator who clears
 * one refusal and meets another has been told the truth in the least useful
 * order, which is why the WHOLE SET is on screen rather than the first one"* —
 * that is an argument for completeness, not for restating the sentences. Every
 * id still appears here; the ones already explained beside their control appear
 * as `R1 (start-job)` rather than as a second copy of R1's paragraph.
 *
 * 🔴 NOTHING IS EVER REDUCED TO AN ID ALONE. An id enters the index ONLY when
 * its `fact` and `why` are rendered at a control on this same page. That is
 * derived from {@link ACTION_OF} — the map the tab is actually rendering its
 * buttons from — never from a hand-kept list, for the same reason `implemented`
 * is: a hand-kept list is what silently stops matching the buttons.
 *
 * ⚠ `console-gcode` IS AN ORPHAN, AND MEASURED TO BE ONE. The obvious reading is
 * that the console input answers it, and it does not: `ConsolePanel` is handed
 * {@link consoleRefusals}, which is the refusal set of a bare `?` — the link
 * rule and nothing else. `console-gcode`'s R5 is only ever rendered as a
 * transcript entry, *after* somebody has typed g-code. So it prints in full
 * here, beside `auto-resume`, which has no control at all.
 */
export function IdentifyingNotice() {
  const [remaining, setRemaining] = useState(LISTEN_WINDOW_MS / 1000);
  useEffect(() => {
    const id = setInterval(() => setRemaining((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="note" data-testid="run-identifying-countdown" style={{ margin: '6px 0 0' }}>
      Listening for a banner from the controller&hellip; ({remaining}&thinsp;s)
    </p>
  );
}

export function RefusalList({ tracked }: { tracked: TrackedState }) {
  if (tracked.tab === 'Disconnected') {
    return (
      <p className="note" style={{ margin: '6px 0 0' }}>
        Not connected. Connect a controller to see what is allowed.
      </p>
    );
  }
  const actions: RunAction[] = [
    'start-job',
    'jog',
    'jog-cancel',
    'spindle-stop',
    'unlock',
    'resume',
    'auto-resume',
    'console-gcode',
  ];
  /** Actions whose refusals are printed under a button by {@link Control}. */
  const atAControl = new Set<RunAction>(
    Object.values(ACTION_OF).filter((a): a is RunAction => a !== undefined)
  );
  const orphans: { action: RunAction; r: Refusal }[] = [];
  const indexed: { action: RunAction; r: Refusal }[] = [];
  for (const a of actions) {
    for (const r of refusalsFor(a, tracked)) {
      (atAControl.has(a) ? indexed : orphans).push({ action: a, r });
    }
  }
  if (!orphans.length && !indexed.length) {
    return (
      <p className="note" style={{ margin: '6px 0 0' }}>
        Nothing is refused. That is a statement about the machine’s last reported state, and it is
        only as good as that report.
      </p>
    );
  }
  return (
    <>
      {orphans.length ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {orphans.map(({ action, r }, i) => (
            <li
              key={`${action}-${r.id}-${i}`}
              data-testid={`run-refusal-${action}-${r.id}`}
              className="note"
            >
              <strong>{r.id}</strong> <em>({action})</em> — {r.fact} {r.why}
            </li>
          ))}
        </ul>
      ) : null}
      {indexed.length ? (
        <p className="note" style={{ margin: '6px 0 0' }} data-testid="run-refusal-index">
          Also refused, with the reason beside each control:{' '}
          {indexed.map(({ action, r }) => `${r.id} (${action})`).join(' · ')}.
        </p>
      ) : null}
    </>
  );
}

export default RunTab;
