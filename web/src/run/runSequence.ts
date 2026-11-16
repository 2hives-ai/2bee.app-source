// cnc.run's full job sequence, as numbered steps (founder 2026-10-15: *"below
// the 3d have all the steps the user needs to do step by step when the cnc is
// running or prepare the cnc (put the panel, clamp ... so a full job
// sequence)"*).
//
// 🔴 NOT A SECOND SEQUENCER. The prepare steps ARE `cncjob/steps.ts::guidedSteps`
// (read off the core's setup facts for THIS program), the tool changes ARE
// `pausesOf` over the program bytes, and every Start goes through
// `cncjob/runDoor.ts` — the same door the Jobs page uses. This file only lays
// those out in order and adds the steps a person does with their hands that no
// fact in the program can see (guard, protection, a hand check of the spindle,
// and the finish). Those added steps are refused at Play by `extraOpen` just
// like the guided ones, so ticking them is not optional.

import type { Job } from '../cncjob/jobs';
import { guidedSteps, pausePrompt, pausesOf, type Pause, type StepId } from '../cncjob/steps';
import { gcodeLines } from '../runProgram';

/** Hand steps this page adds before the run. */
export type PrepId = 'guard' | 'ppe' | 'spindle';
/** After an air cut that ended on another cutter: cutter 1 back in. */
export type RefitId = 'refit';
/** Hand steps after the cut. */
export type FinishId = 'stopped' | 'unclamp' | 'check' | 'clean';
export type TickId = StepId | PrepId | RefitId | FinishId;

export type SeqGroup = 'Prepare' | 'Run' | 'Finish';

export interface SeqStep {
  /** Stable key: the tick id, or `pause-<line>`, or `cut`. */
  key: string;
  /** 1-based, as shown. */
  n: number;
  group: SeqGroup;
  title: string;
  lines: string[];
  /** Things the facts could not settle, shown in the warning colour. */
  checks: string[];
  /**
   * tick   — the person ticks it;
   * aircut — Play runs the air cut, then the person ticks that they watched it;
   * cut    — Play runs the cut;
   * pause  — an M0 in the program: the run stops here and waits for Resume.
   */
  kind: 'tick' | 'aircut' | 'cut' | 'pause';
  tick?: TickId;
  pause?: Pause;
  tool?: string;
}

const PREP_EXTRA: readonly { id: PrepId; title: string; lines: string[] }[] = [
  { id: 'guard', title: 'Close the guard, fit the dust shoe', lines: ['Dust shoe on and the extraction running.', 'Nothing loose on the table or the gantry.'] },
  { id: 'ppe', title: 'Hearing and eye protection on', lines: ['Ear defenders and safety glasses, for you and anyone near the machine.'] },
  {
    id: 'spindle',
    title: 'Spindle check',
    lines: ['With the spindle OFF: turn the cutter by hand. It turns freely and touches nothing.', 'Collet nut tight.'],
  },
];

const FINISH: readonly { id: FinishId; title: string; lines: string[] }[] = [
  { id: 'stopped', title: 'Wait for the spindle to stop', lines: ['Hands away until the cutter has stopped turning.'] },
  { id: 'unclamp', title: 'Unclamp and lift the parts out', lines: [] },
  { id: 'check', title: 'Check the parts against the design', lines: [] },
  { id: 'clean', title: 'Clean the machine and the spoilboard', lines: [] },
];

export const PREP_IDS: readonly PrepId[] = PREP_EXTRA.map((x) => x.id);
export const FINISH_IDS: readonly FinishId[] = FINISH.map((x) => x.id);

/** The whole job, in the order a person does it. */
export function runSequence(job: Pick<Job, 'facts' | 'stock' | 'program'>): SeqStep[] {
  const g = guidedSteps({ facts: job.facts, stock: job.stock, tools: job.program.tools });
  const by = (id: StepId) => g.find((s) => s.id === id)!;
  const out: Omit<SeqStep, 'n'>[] = [];
  const guided = (id: StepId, group: SeqGroup, kind: SeqStep['kind'] = 'tick') => {
    const s = by(id);
    out.push({ key: id, group, title: s.title, lines: s.lines, checks: s.checks, kind, tick: id, ...(s.tool ? { tool: s.tool } : {}) });
  };
  guided('load', 'Prepare');
  guided('clamp', 'Prepare');
  guided('cutter', 'Prepare');
  guided('zero', 'Prepare');
  for (const p of PREP_EXTRA) out.push({ key: p.id, group: 'Prepare', title: p.title, lines: p.lines, checks: [], kind: 'tick', tick: p.id });
  guided('aircut', 'Run', 'aircut');
  const pauses = pausesOf(gcodeLines(job.program.gcode));
  if (pauses.some((p) => p.kind === 'tool')) {
    const first = by('cutter');
    out.push({
      key: 'refit',
      group: 'Run',
      title: first.tool ? `Put cutter 1 back: ${first.tool}` : 'Put cutter 1 back',
      lines: ['The air cut ended on another cutter. Fit cutter 1 again and check Z zero for it.'],
      checks: [],
      kind: 'tick',
      tick: 'refit',
      ...(first.tool ? { tool: first.tool } : {}),
    });
  }
  guided('present', 'Run');
  out.push({ key: 'cut', group: 'Run', title: 'Cut', lines: ['Press Play. Feed Hold pauses, Stop ends the job.'], checks: [], kind: 'cut' });
  for (const p of pauses) {
    const pr = pausePrompt(p);
    // A hand-zero stop is the second half of the cutter change before it:
    // shown under that change's title so the list reads as one intervention.
    const title = p.kind === 'zero' ? `…then set Z zero by hand (same cutter change)` : pr.title.replace(/^Stop\.\s*/, '');
    out.push({ key: `pause-${p.line}`, group: 'Run', title, lines: pr.lines, checks: [], kind: 'pause', pause: p, ...(p.kind === 'tool' ? { tool: p.text } : {}) });
  }
  for (const f of FINISH) out.push({ key: f.id, group: 'Finish', title: f.title, lines: f.lines, checks: [], kind: 'tick', tick: f.id });
  return out.map((s, i) => ({ ...s, n: i + 1 }));
}

const WORD: Record<PrepId, string> = { guard: 'guard and dust shoe', ppe: 'protection', spindle: 'spindle check' };

/**
 * The page's own hand steps not yet ticked, as refusal lines (or none).
 * `refit`: the sequence has a "put cutter 1 back" step and this is the cut.
 */
export function extraOpen(ticks: ReadonlySet<string>, refit = false): string[] {
  const open = PREP_IDS.filter((id) => !ticks.has(id));
  const out = open.length ? [`Not ticked yet: ${open.map((id) => WORD[id]).join(', ')}.`] : [];
  if (refit && !ticks.has('refit')) out.push('Not ticked yet: cutter 1 back in the collet after the air cut.');
  return out;
}

/** The ticks `safety.ts::startBlockers` reads. */
export function guidedTicks(ticks: ReadonlySet<string>): Set<StepId> {
  const ids: StepId[] = ['load', 'clamp', 'cutter', 'zero', 'aircut', 'present'];
  return new Set(ids.filter((id) => ticks.has(id)));
}
