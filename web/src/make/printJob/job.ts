// The print job, as pnp's contract shapes it, built from what the person chose
// on the three-step screen. Pure functions: every line the person reads is
// unit-tested in `tests/print-job-*.test.ts`.
//
// SOURCE OF TRUTH for the shape: `/home/gbacs/build/web-slicer/CONTRACT-chat-job.md`
// §1 (pnp, 2026-10-14) and `jobs.js` `cleanJob` (version 1):
//   { version: 1, name, bed, process, files: [{name, size, sha256}],
//     objects: [{file, slot, placement: null}], slotPresets: {}, overrides: {} }
//
// What the UI can drive today, and therefore all this builder is fed:
//   · ONE design from the three-step flow = ONE file = ONE object. The builder
//     takes a list because the contract does; the screen passes one.
//   · `placement: null` always — "Orca arranges". There is no placement UI.
//   · `slot` — the AMS slot the person picks. The contract requires one per
//     object (`cleanJob` refuses a job without it), so it is asked, and it has
//     NO default: which spool sits in which slot is a fact at the printer, and a
//     default would answer it silently.
//
// What it cannot fill, said rather than invented (`pending`):
//   · `process` — an Orca process preset NAME. The app does not hold Orca's
//     preset names; the slicer service chooses. Sent as "" (cleanJob accepts it).
//   · `slotPresets` — the filament preset per slot is "read from the printer"
//     (contract §1). There is no printer connection here, so it is `{}`.
//
// 🔴 Nothing here slices, uploads, or starts anything. Printer path is UPLOAD
// ONLY (founder 2026-10-14) and even the upload does not exist in this app yet.

import { BED_TYPES, describe, validateOverrides, type BedType, type Refusal } from './allowlist';
import { QUESTIONS, type Answer, type Question } from './chips';
import type { SetupStep } from '../setup';

export const SLOT_IDS = ['ams1-1', 'ams1-2', 'ams1-3', 'ams1-4', 'ext'] as const;
export type SlotId = (typeof SLOT_IDS)[number];
export const SLOT_LABEL: Readonly<Record<SlotId, string>> = {
  'ams1-1': 'AMS slot 1',
  'ams1-2': 'AMS slot 2',
  'ams1-3': 'AMS slot 3',
  'ams1-4': 'AMS slot 4',
  ext: 'External spool',
};
export const isSlot = (s: unknown): s is SlotId => typeof s === 'string' && (SLOT_IDS as readonly string[]).includes(s);

/** The plate the job names when no answer chose one. The printer checklist already names it. */
export const DEFAULT_BED: BedType = 'Textured PEI Plate';
/** `jobs.js` MAX_OBJECTS. */
export const MAX_OBJECTS = 24;

export interface JobFile {
  name: string;
  size: number;
  sha256: string;
}

export interface PrintJob {
  version: 1;
  name: string;
  bed: BedType;
  process: string;
  files: JobFile[];
  objects: { file: number; slot: SlotId; placement: null }[];
  slotPresets: Record<string, string>;
  overrides: Record<string, string>;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Choices — what the person tapped or asked, in order
 * ══════════════════════════════════════════════════════════════════════════ */

export type Choice =
  | { kind: 'chip'; question: string; answer: string }
  | { kind: 'ai'; id: number; prompt: string; overrides: Record<string, string>; reasons: Record<string, string>; refused?: Refusal[]; reply?: string }
  | { kind: 'ai-chip'; id: number; question: string; label: string; overrides: Record<string, string> };

export interface AnswerResult {
  question: Question;
  answer: Answer;
  accepted: Record<string, string>;
  refused: Refusal[];
  /** An answer that changes no setting (e.g. "dry the filament"): it is a thing to do. */
  noSetting: boolean;
}

export function findAnswer(questionId: string, answerId: string): { question: Question; answer: Answer } | null {
  const question = QUESTIONS.find((q) => q.id === questionId);
  const answer = question?.answers.find((a) => a.id === answerId);
  return question && answer ? { question, answer } : null;
}

/**
 * One chip answer → validated overrides. A `rel` answer is refused WHOLE: its
 * absolute half alone would be a change nobody proposed.
 */
export function applyAnswer(questionId: string, answerId: string): AnswerResult | null {
  const qa = findAnswer(questionId, answerId);
  if (!qa) return null;
  const { question, answer } = qa;
  const rel = Object.keys(answer.rel ?? {});
  if (rel.length) {
    return {
      question,
      answer,
      accepted: {},
      refused: rel.map((key) => ({
        key,
        why: 'changes the filament profile’s own value, which the app does not have yet; nothing from this answer was applied',
      })),
      noSetting: false,
    };
  }
  const v = validateOverrides(answer.overrides ?? {});
  return { question, answer, accepted: v.accepted, refused: v.refused, noSetting: Object.keys(answer.overrides ?? {}).length === 0 };
}

/** Tap an answer: replaces that question's earlier answer; tapping the same one again clears it. */
export function tapAnswer(choices: readonly Choice[], questionId: string, answerId: string): Choice[] {
  const prev = choices.find((c) => c.kind === 'chip' && c.question === questionId);
  const rest = choices.filter((c) => !(c.kind === 'chip' && c.question === questionId));
  if (prev && prev.kind === 'chip' && prev.answer === answerId) return rest;
  return [...rest, { kind: 'chip', question: questionId, answer: answerId }];
}

export function chosenAnswer(choices: readonly Choice[], questionId: string): string | null {
  const c = choices.find((x) => x.kind === 'chip' && x.question === questionId);
  return c && c.kind === 'chip' ? c.answer : null;
}

/** One line per choice, for the Change step. */
export interface ChoiceLine {
  /** "Support", "AI", … */
  title: string;
  /** "Auto tree support" or "Wall loops: 4". */
  what: string;
  /** "because …" */
  why: string;
  refused: Refusal[];
  /** Keys this choice set that a LATER choice replaced. */
  replaced: string[];
  /** Index of the choice this line describes. */
  choice: number;
}

export interface Resolved {
  /** The final overrides, every one validated. Later choices win per key. */
  overrides: Record<string, string>;
  /** Per key: which choice set it and why. */
  reasons: Record<string, string>;
  lines: ChoiceLine[];
  /** Things to do that are not settings ("Dry the filament first"). */
  todo: { text: string; why: string }[];
}

/**
 * 🔴 Fold the choices into one override set — and validate EVERY key again on
 * the way, whatever its source. An AI choice was validated when it arrived; it
 * is validated again here so no path into the job skips the check.
 */
export function resolveChoices(choices: readonly Choice[]): Resolved {
  const overrides: Record<string, string> = {};
  const reasons: Record<string, string> = {};
  const setBy: Record<string, number> = {};
  const lines: ChoiceLine[] = [];
  const todo: { text: string; why: string }[] = [];
  choices.forEach((c, ci) => {
    let line: ChoiceLine;
    let accepted: Record<string, string>;
    let why: (k: string) => string;
    if (c.kind === 'chip') {
      const r = applyAnswer(c.question, c.answer);
      if (!r) return;
      accepted = r.accepted;
      line = { title: r.question.title.replace(/\?$/, ''), what: r.answer.label, why: r.answer.why, refused: r.refused, replaced: [], choice: ci };
      why = () => `${r.question.title.replace(/\?$/, '')} → ${r.answer.label}: ${r.answer.why}`;
      if (r.noSetting) todo.push({ text: r.answer.label.replace(/\s*\(no setting\)\s*$/i, ''), why: r.answer.why });
    } else {
      const v = validateOverrides(c.overrides);
      accepted = v.accepted;
      const keys = Object.keys(accepted);
      const title = c.kind === 'ai' ? 'AI' : `AI → ${c.question}`;
      line = {
        title,
        what: c.kind === 'ai' ? (keys.length ? keys.map((k) => describe(k, accepted[k])).join(', ') : 'no setting changed') : c.label,
        why: c.kind === 'ai' ? keys.map((k) => c.reasons[k]).filter(Boolean).join(' ') || `asked: “${c.prompt}”` : 'an answer the model offered',
        refused: [...(c.kind === 'ai' ? (c.refused ?? []) : []), ...v.refused],
        replaced: [],
        choice: ci,
      };
      why = (k) => (c.kind === 'ai' ? `AI (asked “${c.prompt}”)${c.reasons[k] ? `: ${c.reasons[k]}` : ''}` : `AI → ${c.question}: ${c.label}`);
    }
    const idx = lines.length;
    for (const [k, val] of Object.entries(accepted)) {
      if (setBy[k] !== undefined) lines[setBy[k]].replaced.push(k);
      overrides[k] = val;
      reasons[k] = why(k);
      setBy[k] = idx;
    }
    lines.push(line);
  });
  return { overrides, reasons, lines, todo };
}

/* ════════════════════════════════════════════════════════════════════════════
 * The job
 * ══════════════════════════════════════════════════════════════════════════ */

export interface JobInput {
  name: string;
  /** One entry per object; `file` null while the design's STL is not made yet. */
  objects: { file: JobFile | null; slot: SlotId | null }[];
  resolved: Resolved;
}

export interface JobOutcome {
  /** The contract-shaped job, or null while something the PERSON must supply is missing. */
  job: PrintJob | null;
  /** What the person must still do before a job exists. */
  missing: string[];
  /** What the slicer service or the printer fills in, which the app cannot. */
  pending: string[];
  /** The job's `bed` (Orca's plate name), and whether an answer chose it. */
  plate: { name: BedType; chosen: boolean };
}

const clip = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildPrintJob(input: JobInput): JobOutcome {
  const missing: string[] = [];
  const pending = [
    'Process preset: chosen by the slicer service (the app does not hold Orca’s preset names).',
    'Filament preset per slot: read from the printer’s AMS at upload. There is no printer connection in the app yet.',
  ];
  // 🔴 Validated again: the job carries only what passes the allow-list now.
  const v = validateOverrides(input.resolved.overrides);
  for (const r of v.refused) missing.push(`Setting ${r.key} was refused: ${r.why}`);
  const bedRaw = v.accepted.curr_bed_type;
  const bed = (BED_TYPES as readonly string[]).includes(bedRaw ?? '') ? (bedRaw as BedType) : DEFAULT_BED;

  if (!input.objects.length) missing.push('No object to print.');
  if (input.objects.length > MAX_OBJECTS) missing.push(`At most ${MAX_OBJECTS} objects per job.`);
  const files: JobFile[] = [];
  const objects: PrintJob['objects'] = [];
  input.objects.forEach((o, i) => {
    const n = input.objects.length > 1 ? ` (object ${i + 1})` : '';
    if (!o.file) missing.push(`The printable file is not made yet${n}.`);
    else if (!/^[0-9a-f]{64}$/.test(o.file.sha256) || !(o.file.size > 0)) missing.push(`The printable file is not valid${n}.`);
    if (!o.slot) missing.push(`Pick the filament slot${n}.`);
    else if (!isSlot(o.slot)) missing.push(`Unknown filament slot${n}.`);
    if (o.file && isSlot(o.slot)) {
      let fi = files.findIndex((f) => f.sha256 === o.file!.sha256);
      if (fi < 0) {
        files.push({ name: clip(o.file.name, 80).replace(/[^\w.\- ]/g, '_') || 'model.stl', size: o.file.size, sha256: o.file.sha256 });
        fi = files.length - 1;
      }
      objects.push({ file: fi, slot: o.slot, placement: null });
    }
  });

  const outcome: JobOutcome = { job: null, missing, pending, plate: { name: bed, chosen: bedRaw !== undefined } };
  if (missing.length) return outcome;
  outcome.job = {
    version: 1,
    name: clip(input.name, 80) || 'job',
    bed,
    process: '',
    files,
    objects,
    slotPresets: {},
    overrides: v.accepted,
  };
  return outcome;
}

/** The job summary lines for the Make step: final value per key, with its reason. */
export function summaryLines(resolved: Resolved): { text: string; why: string }[] {
  return Object.keys(resolved.overrides).map((k) => ({ text: describe(k, resolved.overrides[k]), why: resolved.reasons[k] ?? '' }));
}

/**
 * The printer's Send stays blocked, and this is the honest reason (founder:
 * upload only). Slicing for the X2D runs in the 3d tab on 2bee.fdm since
 * 2026-10-16 ("no orcaslicer anymore!"); this step is not wired to it yet, and
 * that engine has printed nothing.
 */
export const PRINT_SEND_BLOCKER =
  'Not yet. This job has to be sliced first, and this step cannot slice yet. Slicing runs in the 3d tab with 2bee.fdm, this app’s own engine, which has not printed yet: the first print from it is a calibration print.';

/**
 * The printer checklist, made to agree with the job: the plate line names the
 * job's plate (an answer can change it), the filament line names the slot, and
 * answers that are things to do ("dry the filament") become lines.
 */
export function printChecklist(base: readonly SetupStep[], outcome: JobOutcome, slots: readonly (SlotId | null)[], todo: Resolved['todo']): SetupStep[] {
  const out = base.map((s) => {
    if (/^Clean the build plate/.test(s.text)) {
      return {
        text: `Clean the build plate and check it is the ${outcome.plate.name}.`,
        why: `${s.why} ${outcome.plate.chosen ? 'The plate is the one you chose.' : 'No plate was chosen, so the job names the usual one.'}`,
      };
    }
    if (/^Check the filament loaded/.test(s.text)) {
      const named = slots.filter(isSlot).map((x) => SLOT_LABEL[x]);
      return named.length ? { text: `Check the filament in ${named.join(', ')} is the one you mean to print with.`, why: s.why } : s;
    }
    return s;
  });
  const at = Math.max(0, out.findIndex((s) => /^Watch the first layer/.test(s.text)));
  out.splice(at, 0, ...todo.map((t) => ({ text: `${t.text}.`.replace(/\.\.$/, '.'), why: t.why })));
  return out;
}
