// The guided run, derived — never typed in — from the job's setup facts and
// its program.
//
// Plan, "Screen 2: Cut": load → clamp → fit cutter 1 → zero → AIR CUT (forced)
// → "I am at the machine" → cut, with a prompt at every M0. Every line here
// comes from a fact the core read off THE SAME PROGRAM (`core/src/setup.rs`,
// hash-checked when the job was planned) or from the program bytes; where a
// fact is missing the step says so instead of filling it in.
//
// 🔴 M0 PROMPTS ARE READ FROM THE PROGRAM, NOT FROM THE PLAN. The grblHAL post
// writes `( TOOL CHANGE -> <tool> )` or `( CLAMP CHANGE -> <what> )` and then
// `M0` (`core/src/post_grblhal.rs`, MoveKind::ToolChange / ClampChange). An M0
// with no such comment is a pause nobody explained: it is shown as exactly
// that, and the operator is told not to resume until they know why. It is not
// guessed to be a tool change.

import type { SetupFacts } from '../cam';
import { isWorkpieceTopDatum } from './airCut';
import { CLAMP_MARGIN_MM } from '../make/autoPlan';

export type StepId = 'load' | 'clamp' | 'cutter' | 'zero' | 'aircut' | 'present';

export interface GuidedStep {
  id: StepId;
  title: string;
  /** What to do, one instruction per line. */
  lines: string[];
  /** Things the facts could not settle. Shown in the warning colour. */
  checks: string[];
  /** For `cutter`: which tool, for its photo. */
  tool?: string;
}

const mm = (v: number) => (Math.round(v * 10) / 10).toString();


/**
 * The guided steps for one job. `facts` null (the setup facts could not be
 * read for this program) is refused by `startBlocker`, and the steps say so.
 */
export function guidedSteps(job: {
  facts: SetupFacts | null;
  stock: { x: number; y: number; t: number };
  tools: readonly string[];
}): GuidedStep[] {
  const f = job.facts;
  const wp = f?.workpiece;
  const t = wp ? wp.thickness_mm : job.stock.t;
  const x = wp ? wp.size_x_mm : job.stock.x;
  const y = wp ? wp.size_y_mm : job.stock.y;
  const first = f ? ([...f.tools].sort((a, b) => a.index - b.index)[0] ?? null) : null;
  const firstName = first?.name ?? job.tools[0] ?? null;
  const missing = f ? [] : ['The setup facts could not be read for this program, so it cannot run.'];

  const depth: string[] = [];
  if (f) {
    if (f.depth.into_spoilboard_mm > 0.05) depth.push(`It cuts ${mm(f.depth.into_spoilboard_mm)} mm into the spoilboard.`);
    else if (f.depth.cuts_through) depth.push('It cuts right through: parts come loose at the end.');
  }

  return [
    {
      id: 'load',
      title: 'Load the workpiece',
      lines: [`${mm(t)} mm thick, at least ${mm(x)} × ${mm(y)} mm.`, 'Front-left corner at the machine origin.'],
      checks: missing,
    },
    {
      id: 'clamp',
      title: 'Clamp it',
      lines: [`Clamps only in the ${CLAMP_MARGIN_MM} mm border.`, ...depth],
      checks: ['No clamps are declared for this job, so nothing has checked the cutter path against them.'],
    },
    {
      id: 'cutter',
      title: firstName ? `Fit cutter 1: ${firstName}` : 'Fit cutter 1',
      lines: [
        first?.diameter_mm != null ? `Ø ${mm(first.diameter_mm)} mm.` : 'Diameter not stated in the program.',
        'Tight in the collet, stick-out as short as the cut allows.',
      ],
      checks: firstName ? [] : ['The program names no first cutter.'],
      ...(firstName ? { tool: firstName } : {}),
    },
    {
      id: 'zero',
      title: 'Home, then set zero',
      lines: [
        f ? (isWorkpieceTopDatum(f.z_datum.declared) ? 'Z zero on the top of the workpiece.' : `Z zero: ${f.z_datum.declared}.`) : 'Z zero: not known.',
        f ? `XY zero: ${f.xy_zero.convention}` : 'XY zero: not known.',
        ...(f && f.spindle.rpm.length ? [`Spindle ${f.spindle.rpm.join(', ')} rpm.`] : []),
      ],
      checks: f ? [...f.mismatches, ...f.pending] : [],
    },
    {
      id: 'aircut',
      title: 'Air cut',
      /* The lift is the PROGRAM's (airCut.ts), chosen from its deepest Z; the
       * operator no longer moves Z zero, so there is no zero to forget to put back. */
      lines: ['Leave Z zero on the workpiece.', 'This app runs the program lifted clear of the workpiece, with the spindle starts taken out.', 'Watch the whole path once.'],
      checks: [],
    },
    {
      id: 'present',
      title: 'Stay at the machine',
      lines: ['Hand near Feed Hold for the whole cut.'],
      checks: [],
    },
  ];
}

/** `zero` = the SECOND stop of a cutter change on a machine with no Z probe:
 *  the person sets Z zero by hand with the new cutter (core `ZERO_PREFIX`).
 *  `plate` = the stop after a probe against a touch plate lying on the work:
 *  the person takes the plate off before the spindle starts (core `PLATE_PREFIX`). */
export type PauseKind = 'tool' | 'clamp' | 'zero' | 'plate' | 'unexplained';

export interface Pause {
  /** 0-based index of the `M0` line in the program. */
  line: number;
  kind: PauseKind;
  /** The tool name or clamp instruction from the comment; empty if unexplained. */
  text: string;
  /** For a tool change: which cutter this is in program order (2 = the second cutter). */
  cutter: number | null;
  /**
   * A clamp move made at the SAME stop as this tool change (the core writes one
   * `M0` for both — founder 2026-10-16, "less change … make it quicker"). The
   * instruction text; absent when the stop moves no clamp.
   */
  clamps?: string;
  /** For a tool change: the cutter it replaces, when the program names it. */
  from?: string;
  /** For a tool change on a machine with no Z probe: the program stops again
   *  straight after it for Z zero by hand (the next pause, kind `zero`). */
  zeroNext?: boolean;
  /** For a clamp stop: nothing re-measures Z after it (no probe after the M0). */
  warning?: string;
  /** For a tool or clamp stop: Z is probed from the touch plate as soon as
   *  the program resumes, so the plate goes back under the cutter first. */
  plateBack?: boolean;
}

const M0 = /^\s*M0\s*$/i;
const NOTE = /^\s*\(\s*(TOOL CHANGE|CLAMP CHANGE|SET Z ZERO|TOUCH PLATE)\s*->\s*(.*?)\s*\)\s*$/i;
/** The words the core writes above a stop whose resume probes Z from the plate. */
const PLATE_BACK = /^\s*\(\s*then put the touch plate back under the cutter\b/i;
const HEADER = /^\s*\(\s*tool:\s*(.*?)\s+D[\d.]+mm\s+F\d+\s*\)\s*$/i;
/** The words the core writes before a clamp-only stop on a probe-less machine. */
const NOZ = /^\s*\(\s*(Z not re-checked after the clamp move.*?)\s*\)\s*$/i;

/** Every M0 in the program, with what it is for. */
export function pausesOf(lines: readonly string[]): Pause[] {
  const out: Pause[] = [];
  let cutters = 1;
  let fitted: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (fitted === undefined) {
      const h = HEADER.exec(lines[i]);
      if (h) fitted = h[1];
    }
    if (!M0.test(lines[i])) continue;
    const note = i > 0 ? NOTE.exec(lines[i - 1]) : null;
    // Every change comment directly above this M0 belongs to it: a clamp move
    // and a cutter change share one stop, written clamp first.
    let clampNote: string | undefined;
    let noZ: string | undefined;
    let plateBack = false;
    for (let k = i - 2; k >= 0; k--) {
      if (PLATE_BACK.test(lines[k])) plateBack = true;
      const n = NOTE.exec(lines[k]);
      if (n && n[1].toUpperCase() === 'CLAMP CHANGE') {
        clampNote = n[2];
        break;
      }
      if (!/^\s*\(.*\)\s*$/.test(lines[k])) break;
    }
    // The clamp-only warning sits a few lines up (before the retract).
    for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
      const w = NOZ.exec(lines[k]);
      if (w) {
        noZ = w[1];
        break;
      }
    }
    const kind = note?.[1].toUpperCase();
    if (kind === 'TOOL CHANGE') {
      cutters += 1;
      const zeroNext = NOTE.exec(lines[i + 1] ?? '')?.[1].toUpperCase() === 'SET Z ZERO';
      out.push({
        line: i,
        kind: 'tool',
        text: note![2],
        cutter: cutters,
        ...(clampNote !== undefined ? { clamps: clampNote } : {}),
        ...(fitted !== undefined ? { from: fitted } : {}),
        ...(zeroNext ? { zeroNext } : {}),
        ...(plateBack ? { plateBack } : {}),
      });
      fitted = note![2];
    } else if (kind === 'SET Z ZERO') {
      out.push({ line: i, kind: 'zero', text: note![2], cutter: null });
    } else if (kind === 'TOUCH PLATE') {
      out.push({ line: i, kind: 'plate', text: note![2], cutter: null });
    } else if (kind === 'CLAMP CHANGE') {
      out.push({ line: i, kind: 'clamp', text: note![2], cutter: null, ...(noZ ? { warning: noZ } : {}), ...(plateBack ? { plateBack } : {}) });
    } else {
      out.push({ line: i, kind: 'unexplained', text: '', cutter: null });
    }
  }
  return out;
}

/**
 * The pause the controller is sitting in, or `null`.
 *
 * The controller is held AND the last line it answered is an M0. A feed hold
 * pressed between two ordinary lines is not a tool change, and is not shown as
 * one. `acknowledged` is the sender's count of answered lines (1-based count, so
 * the last answered line is `acknowledged - 1`).
 */
export function pauseAt(pauses: readonly Pause[], acknowledged: number, controllerState: string): Pause | null {
  if (!controllerState.startsWith('Hold')) return null;
  /* 🔴 BOTH ORDERINGS OF THE M0's `ok`. The fake answers M0 and THEN holds, so
   * the M0 is the last answered line (`acknowledged - 1`). grblHAL — read from
   * its source (gcode.c sets the hold, protocol_exec_rt_suspend then blocks in
   * `while(sys.suspend)`), not run on a board here — holds FIRST and answers the
   * M0 only after Resume, so the M0 is the NEXT line (`acknowledged`). Matching
   * only the fake's order meant a real board would show the plain Resume button
   * at a tool change: no "swap the cutter" takeover, the next operation cut with
   * the wrong one. A hold pressed on the line just before an M0 now also shows
   * the takeover — the machine is about to stop there anyway, and that is the
   * cheap direction of the two. */
  return pauses.find((p) => p.line === acknowledged - 1) ?? pauses.find((p) => p.line === acknowledged) ?? null;
}

/** The takeover screen's words for a pause. */
export function pausePrompt(p: Pause): { title: string; lines: string[] } {
  const swap = `${p.from ? `${p.from} → ` : ''}${p.text}`;
  // No Z probe: this stop is the cutter swap; the program stops again at once
  // for Z zero by hand. ONE intervention, two M0.
  const zeroLines = ['Spindle is off. Swap the cutter.', 'Resume. The program stops again straight away for you to set Z zero by hand.'];
  // The program probes Z from the plate the moment it resumes, and the plate
  // was taken off after the last probe: it goes back first.
  const zLine = p.plateBack ? 'Put the touch plate back under the cutter: Z is probed from it as soon as you Resume.' : 'Check Z zero for the new cutter.';
  if (p.kind === 'tool' && p.clamps !== undefined) {
    return {
      title: p.zeroNext ? `Stop. Move the clamps and change cutter: ${swap}, then set Z zero by hand` : `Stop. Move the clamps, then fit cutter ${p.cutter}: ${p.text}`,
      lines: [p.clamps, 'One clamp at a time: the other clamps stay tight while it moves.', ...(p.zeroNext ? zeroLines : ['Spindle is off. Swap the cutter.', zLine, 'Then Resume.'])],
    };
  }
  if (p.kind === 'tool') {
    return p.zeroNext
      ? { title: `Stop. Change cutter: ${swap}, then set Z zero by hand`, lines: zeroLines }
      : { title: `Stop. Fit cutter ${p.cutter}: ${p.text}`, lines: ['Spindle is off. Swap the cutter.', zLine, 'Then Resume.'] };
  }
  if (p.kind === 'plate') {
    return {
      title: 'Stop. Take the touch plate off the work',
      lines: ['Z is set. The plate is still under the cutter.', 'Lift it off the work and out of the way of every cut.', 'Then Resume. The program lifts Z first, then starts the spindle.'],
    };
  }
  if (p.kind === 'zero') {
    return {
      title: 'Stop. Set Z zero by hand with the new cutter',
      lines: [
        p.text,
        'This machine has no Z probe: nothing in the program checks the zero you set.',
        'After Resume the program lifts Z first, then moves.',
      ],
    };
  }
  if (p.kind === 'clamp') {
    return p.warning
      ? { title: 'Stop. Move the clamps.', lines: [p.text, 'One clamp at a time: the other clamps stay tight while it moves.', `Warning: ${p.warning}.`, 'Then Resume.'] }
      : { title: 'Stop. Move the clamps.', lines: [p.text, 'One clamp at a time: the other clamps stay tight while it moves.', p.plateBack ? 'Put the touch plate back under the cutter: Z is probed from it as soon as you Resume.' : 'Check zero, then Resume.'] };
  }
  return { title: 'Stopped at a pause (M0) the program does not explain.', lines: ['Do not resume until you know why it stopped.'] };
}
