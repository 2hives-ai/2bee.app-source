/* runProgram.ts — WHAT THE CNC TAB HANDS TO THE RUN TAB, AND WHEN IT MAY CHANGE
 *
 * `RunTab` has taken an optional `program` since it was written and `App.tsx`
 * rendered it bare, so the tab's toolpath canvas, its line count and its
 * remaining-time estimate had no input at all in the product. This module is the
 * seam that fills it.
 *
 * ── WHY THIS IS A FILE AND NOT TWENTY LINES INSIDE `App.tsx` ────────────────
 *
 * `App.tsx` cannot be imported in node — the loader stops at the sample asset
 * imports (`Unknown file extension ".dxf"`), which a previous agent measured and
 * recorded. So anything that lives inside it is unreachable by every test in
 * `web/tests/`. The derivation below can be wrong in four separate ways — a
 * feed substituted for a rapid, a line index invented, a stale program handed
 * over, a refusal rendered as an empty canvas — and this lane's standing rule is
 * that a rule nobody can watch fail is not a rule. So it lives here, where a
 * test can drive it and a plant can break it.
 *
 * ⚠ It reads `RunTab`'s types and writes none of them. `RunProgram` is that
 * file's contract; this module satisfies it.
 *
 * ── WHAT IS PASSED, AND WHAT IS DELIBERATELY NOT ───────────────────────────
 *
 * NOT the `Report`. The Run tab needs four facts and the report carries thirty:
 *
 *   lines      the EMITTED TEXT, split for the streamer. This is the artefact
 *              that reaches the controller — the thing a check must assert on
 *              (`AGENTS.md`: *assert on the emitted program, never on the
 *              setting that was supposed to produce it*).
 *   path       `Report.render` — the cutter centre line, already carrying the
 *              tool offset, the lead-ins, the tabs and the reliefs. It is what
 *              the machine traces, so it is what a progress picture may draw.
 *              `Report.drawing` is the IMPORTED geometry in a DIFFERENT FRAME
 *              and is not offered here; drawing it against a DRO would put the
 *              marker beside the work.
 *   rapidRate  `Report.rapid_mm_min`. A `G0` carries no `F` word, so without it
 *              a rapid has no duration and the remaining estimate is a number
 *              invented in TypeScript.
 *   hash       a checksum of the emitted text, so the picture and the bytes
 *              cannot silently be two different programs.
 *
 * Handing the whole report over would put `sim`, `refusals`, `spoilboard` and
 * the placement transform inside a tab that must not re-derive any of them —
 * and would give a second surface the material to draw a second, disagreeing
 * picture of the same job.
 *
 * ── 🔴 THE HAZARD: A PROGRAM THAT CHANGES WHILE IT IS STREAMING ────────────
 *
 * If the tab's `program` were `runProgramFromReport(report)` evaluated inline,
 * every re-plan would swap it — the canvas, the line total and the remaining
 * estimate would all jump to a program the machine is not executing, silently,
 * mid-job. That is emergent behaviour nobody chose.
 *
 * 🔴 **THE DECISION IS: FREEZE AT HANDOFF.** The Run tab holds exactly the
 * program an operator explicitly handed it, and NOTHING in the CNC tab can
 * change it — not a re-plan, not a material change, not a new drawing. A newer
 * plan makes the held program *stale* and says so ({@link heldProgramVerdict});
 * it does not replace it. Replacing is a second explicit act.
 *
 * ✅ **WHAT THAT GUARANTEE IS — CORRECTED 2026-08-11, AND THE OLD TEXT IS QUOTED
 * RATHER THAN DELETED, BECAUSE A STALE 🔴 LIES EXACTLY LIKE A STALE ✅.**
 *
 * It said:
 *
 *   > *"It is NOT 'the held program cannot be replaced during a stream', because
 *   > **this app cannot currently tell whether a stream is running**: `RunTab`'s
 *   > `Connection` exposes no streaming state upward, its `sender` prop is
 *   > supplied by nobody, and its `Start` control is not wired to the worker's
 *   > `load`/`start` at all — so as of this change the Run tab cannot stream a
 *   > program even in principle. ⇒ The unblock, when streaming lands, is one
 *   > prop on `RunTab` (a `streaming` flag or an `onStream` callback) and a
 *   > disabled hand-over button."*
 *
 * 🔴 **ALL FOUR LIMBS ARE NOW FALSE, AND THE PARAGRAPH FILED ITS OWN UNBLOCK AS
 * "one prop on `RunTab`" — THE PROP EXISTS.** Measured at the artefacts:
 *
 *   · `RunTab` exports {@link import('./RunTab').StreamingSignal} and calls
 *     `onStreaming` with it — the streaming state IS exposed upward.
 *   · `sender` defaults to the live connection's own accounting
 *     (`props.sender ?? conn.sender`), fed by the worker's `stream` events.
 *   · `Start` is wired through `wiredActions` to `conn.startJob(program,
 *     tracked)`.
 *   · So the Run tab can stream, and `App.tsx` **disables** the hand-over
 *     control while it is — disable, not confirm, which is what
 *     `StreamingSignal`'s contract requires of a consumer.
 *
 * ⇒ **The guarantee delivered is now: the held program never changes without an
 * operator act, AND it cannot be replaced while this tab is feeding lines.**
 *
 * ⚠ **THE LIMIT THAT SURVIVES IS A DIFFERENT ONE, AND IT IS THE SHARPER OF THE
 * TWO.** `streaming === false` is **not** *"the machine is stopped"*. It means
 * this tab is not feeding lines: the controller holds everything already sent —
 * up to a full RX buffer — and keeps executing it with the spindle turning, and
 * after a lost link it is *especially* not stopped, because nothing was told to
 * stop. The refusal above is therefore keyed on a fact about the SENDER, and the
 * sentence the signal carries is rendered beside the control so the button
 * cannot imply the stronger claim. Nothing here may use the signal to decide a
 * motion.
 */

import { checksumText } from './cad/record';
import type { RenderMove, Report } from './cam';
import type { PathPoint, RunProgram } from './RunTab';

/**
 * 🔴 THE LINE INDEX WE CANNOT KNOW, NAMED RATHER THAN GUESSED.
 *
 * `PathPoint.line` is documented as *"index into `RunProgram.lines` that
 * produced this point"*. **`Report.render` carries no such attribution** — a
 * `RenderMove` has a kind, a position, a feed and (on a drill) a peck, and
 * nothing that points back at the text. Nor can it be recovered: the post writes
 * one `G2`/`G3` per arc and `render` is flattened, so one line yields many
 * points and a positional walk would drift silently from the first arc onward.
 *
 * So every point carries `-1`, which is not an index. A consumer that indexes
 * `lines[point.line]` gets `undefined` — obviously missing — rather than a
 * plausible wrong line, which is the failure this lane keeps recording.
 *
 * ⚠ Nothing in `RunTab` reads the field today. The moment something does, it
 * needs the core to emit the attribution; it cannot be manufactured here.
 */
export const LINE_UNATTRIBUTED = -1;

/**
 * What the CNC tab is able to hand over right now.
 *
 * 🔴 A REFUSAL IS A STATE WITH A SENTENCE, never an empty program. "There is
 * nothing to run because the plan was refused" and "there is nothing to run
 * because nothing has been planned" send an operator to two different places,
 * and a blank canvas says neither.
 */
export type ProgramHandoff =
  | { status: 'ok'; program: RunProgram }
  | { status: 'refused'; why: string };

/** Split the emitted text the way the G-code panel already counts it: one entry
 *  per line, with the single trailing newline's empty tail dropped. Interior
 *  blank lines are KEPT — dropping them would renumber every line after the
 *  first one, and the panel and the streamer would then disagree about which
 *  line is which. */
export function gcodeLines(gcode: string): string[] {
  const lines = gcode.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `Report.render` → the path the Run tab draws and locates the DRO on.
 *
 * 🔴 `feed` IS NOT DEFAULTED TO A NUMBER OF OUR OWN. `RenderMove.feed` is
 * `undefined` on a rapid, a tool change and a probe, and `cam.ts` says in the
 * field's own doc: *do not write `feed ?? 0` and divide*. Nothing here divides.
 * `PathPoint.feed` is required to be a number, so an absent feed becomes `0` and
 * `RunTab.pathSeconds` — which adds time only when `rate > 0` — charges the move
 * NOTHING. That is the honest answer for a move whose speed this report does not
 * state: an unknown duration contributes nothing to an estimate, rather than
 * contributing a rate somebody made up.
 *
 * ⚠ A probe is therefore free in the estimate and it is not free on the machine.
 * The estimate already runs short (no acceleration model, in the core or here);
 * this makes it run shorter, in the same direction, and never longer.
 */
export function pathFromRender(render: readonly RenderMove[]): PathPoint[] {
  return render.map((m) => ({
    x: m.x,
    y: m.y,
    z: m.z,
    feed: m.feed ?? 0,
    rapid: m.kind === 'rapid',
    line: LINE_UNATTRIBUTED,
  }));
}

/**
 * Build the program, or say why there is not one.
 *
 * The refusals are ordered so the first one an operator can act on is the one
 * they are told about.
 */
export function runProgramFromReport(report: Report | null | undefined): ProgramHandoff {
  if (!report) {
    return {
      status: 'refused',
      why: 'nothing has been planned yet, so there is no program to hand over. Plan a job in 2bee.cnc first.',
    };
  }
  if (!report.ok) {
    return {
      status: 'refused',
      why:
        `the last plan was REFUSED, so what it produced is not a program — it is a report about why ` +
        `there is not one. Clear the refusal in 2bee.cnc; nothing is handed over until the plan is ok.`,
    };
  }
  if (!report.gcode.trim()) {
    return {
      status: 'refused',
      why: 'that plan emitted no G-code at all. There is nothing to send and nothing to draw.',
    };
  }
  const render = report.render ?? [];
  if (render.length < 2) {
    return {
      status: 'refused',
      why:
        `that plan carries ${render.length} toolpath point${render.length === 1 ? '' : 's'}, which is ` +
        `not a path. The Run tab locates the DRO on the path and draws it; with fewer than two ` +
        `points it can do neither, and it would show an empty picture beside a live machine.`,
    };
  }
  const rapid = report.rapid_mm_min;
  if (typeof rapid !== 'number' || !Number.isFinite(rapid) || rapid <= 0) {
    return {
      status: 'refused',
      why:
        `that report does not state the machine's rapid rate (rapid_mm_min = ${String(rapid)}). A G0 ` +
        `carries no F word, so every rapid in this program would have no duration and the remaining ` +
        `estimate would be a number this app invented. Refused rather than approximated.`,
    };
  }
  return {
    status: 'ok',
    program: {
      name: report.job,
      lines: gcodeLines(report.gcode),
      path: pathFromRender(render),
      /* ⚠ A CHECKSUM, NOT A DIGEST — `cad/record.ts`'s FNV-1a plus the byte
       * length, reused rather than re-implemented so this app has one of them.
       * It exists to tell two programs apart, not to authenticate one. */
      hash: checksumText(report.gcode),
      rapidRate: rapid,
    },
  };
}

/* ── The latch: what the Run tab is holding, and how it relates to the plan ── */

/**
 * 🔴 THE SENTENCE THE OPERATOR GETS ABOUT THE FREEZE, in one place a test can
 * assert on. Same shape as `inventory.ts::WHY_NO_DEFAULT`.
 */
export const WHY_FROZEN =
  'The Run tab holds the program you handed it and nothing else changes it. Re-planning in ' +
  '2bee.cnc does NOT swap what the Run tab is showing or sending — a program that changed itself ' +
  'mid-job would leave the picture, the line count and the remaining time describing something ' +
  'the machine is not executing. A newer plan is reported as newer; replacing is a second ' +
  'deliberate act.';

export type HeldState =
  /** Nothing has been handed over. */
  | 'none'
  /** What is held is what the CNC tab currently has planned. */
  | 'current'
  /** A newer plan exists (or the plan is now refused) and the held program is not it. */
  | 'stale';

export interface HeldVerdict {
  state: HeldState;
  /** What the CNC tab prints beside the hand-over control. */
  text: string;
}

/**
 * Compare what the Run tab holds with what the CNC tab could hand over now.
 *
 * ⚠ It compares the CHECKSUM of the emitted text, not the report identity. Two
 * plans that emit byte-identical G-code are the same program to a machine, and
 * calling them different would raise a stale warning nobody can clear.
 */
export function heldProgramVerdict(held: RunProgram | null, build: ProgramHandoff): HeldVerdict {
  if (!held) {
    return {
      state: 'none',
      text:
        build.status === 'ok'
          ? `The Run tab is holding NOTHING — its canvas, line count and remaining estimate have no ` +
            `input until a program is handed over. This plan ("${build.program.name}", ` +
            `${build.program.lines.length} lines) is ready to hand over.`
          : `The Run tab is holding NOTHING, and there is nothing to hand it: ${build.why}`,
    };
  }
  if (build.status === 'ok' && build.program.hash === held.hash) {
    return {
      state: 'current',
      text:
        `The Run tab is holding "${held.name}" (${held.lines.length} lines, ${held.hash}), which is ` +
        `byte-for-byte what 2bee.cnc has planned.`,
    };
  }
  return {
    state: 'stale',
    text:
      `The Run tab is holding "${held.name}" (${held.lines.length} lines, ${held.hash}) and 2bee.cnc ` +
      `has since ${build.status === 'ok' ? `planned a DIFFERENT program ("${build.program.name}", ${build.program.lines.length} lines, ${build.program.hash})` : `stopped being able to produce one: ${build.why}`} ` +
      `The Run tab has NOT been changed. ${WHY_FROZEN}`,
  };
}

/* ── Negative control ───────────────────────────────────────────────────────
 *
 * 🔴 THE DEFECT THIS MODULE EXISTS TO PREVENT, REINTRODUCED ON DEMAND. Same
 * idiom and same reason as `inventory.ts::InventoryPlant` and the CLI's
 * `--plant`: the freeze is invisible when it is working, so a test that has only
 * ever seen a held program come back establishes nothing.
 */
export type RunHandoffPlant =
  /** The Run tab follows the report instead of the latch — a re-plan silently
   *  swaps the program under a running job. This is the hazard, in code. */
  'follows-the-report';

export const RUN_HANDOFF_PLANTS: RunHandoffPlant[] = ['follows-the-report'];

/**
 * What `App.tsx` passes to `<RunTab program={…} />`.
 *
 * 🔴 IT IS THE LATCH AND NOTHING ELSE. The current build is an argument only so
 * the plant can reach it; the real path never reads it. If this function ever
 * needs the build for a non-planted reason, the freeze has been given up.
 */
export function programForRunTab(
  held: RunProgram | null,
  build: ProgramHandoff,
  plant?: RunHandoffPlant
): RunProgram | null {
  if (plant === 'follows-the-report') {
    /* 🔴 THE PLANT. The whole hazard in one line: whatever the CNC tab has
     * planned most recently becomes what the Run tab is showing and sending,
     * with no operator act between them. */
    return build.status === 'ok' ? build.program : held;
  }
  return held;
}
