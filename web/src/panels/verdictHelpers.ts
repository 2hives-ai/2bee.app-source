/**
 * Verdict helper functions — pure, no React state.
 *
 * Extracted from App.tsx to reduce file size and improve reusability.
 * These functions transform core verdict objects into display strings
 * and property arrays for the ObjectPicker.
 */

import type { ObjectProperty } from '../ObjectPicker';
import type { ToolVerdict, DrawingVerdict } from '../cam';

/* ── Tool verdicts ─────────────────────────────────────────────────────────── */

export function usabilityMark(v: ToolVerdict | undefined): string {
  if (!v) return '⚠ USABILITY UNKNOWN — the core has not answered for this cutter';
  const named = (outcome: 'refused' | 'unchecked') =>
    v.rules
      .filter((r) => r.outcome === outcome)
      .map((r) => r.rule)
      .join(', ');
  if (v.usability === 'invalidates')
    return `🔴 INVALIDATES THE JOB (${named('refused') || 'rule not named'})`;
  if (v.usability === 'unknown')
    return `⚠ UNKNOWN (unchecked: ${named('unchecked') || 'no rule ran'})`;
  return '✅ usable in this setup';
}

/**
 * 🔴 TWO ANSWERS ABOUT THE SAME SHANK, FROM TWO DIFFERENT MACHINE DESCRIPTIONS —
 * surfaced, never reconciled here.
 */
export function colletDisagreement(t: { selectable?: boolean }, v: ToolVerdict | undefined): boolean {
  if (!v) return false;
  const colletRefused = v.rules.some((r) => r.rule === 'collet' && r.outcome === 'refused');
  return colletRefused && t.selectable !== false;
}

export const COLLET_DISAGREEMENT_WHY =
  'TWO ANSWERS FROM TWO MACHINE DESCRIPTIONS, and neither is being preferred. The tool library ' +
  'was told this shop owns spare collets, so it reports this cutter as selectable with a collet ' +
  'change. The job config — the object handed to BOTH this verdict and the planner — carries no ' +
  'spare collets at all, so both judge against the collet in the spindle alone. Declaring the ' +
  'spares in the config would make the planner accept programs it refuses today, which is a ' +
  'decision rather than a display fix. Until it is made, treat the collet you will actually fit ' +
  'as the question, and check it by hand.';

/** What the ADVICE filter offers, in the core's own four values. */
export const ADVICE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'every cutter' },
  { value: 'recommended', label: 'recommended for this drawing' },
  { value: 'usable', label: 'usable, not chosen' },
  { value: 'not-for-this-job', label: 'not for this job' },
  { value: 'unknown', label: 'not asked (no drawing, or too little declared)' },
];

/**
 * Everything the core says about one cutter's suitability, as properties.
 *
 * 🔴 THE `why` SENTENCES ARE THE CORE'S AND ARE RENDERED VERBATIM.
 */
export function verdictProps(v: ToolVerdict | undefined): ObjectProperty[] {
  if (!v)
    return [
      {
        label: 'Does it work in this setup?',
        value:
          'UNCHECKED — the core has not answered for this cutter. That is not "yes": nothing has ' +
          'vouched for it.',
      },
    ];
  return [
    {
      label: 'Does it work in this setup?',
      value:
        v.usability === 'usable'
          ? 'Yes — every blocking rule passed. See each one below.'
          : `${usabilityMark(v)} — ${v.why || 'the core gave no sentence, which is itself unchecked'}`,
    },
    {
      label: 'Does this drawing want it?',
      value: `${v.advice.toUpperCase()} — ${
        v.why_advice || 'the core gave no reason for this advice'
      }`,
    },
    ...v.rules.map((r) => ({
      label: `Rule: ${r.rule}`,
      value:
        r.outcome === 'passed'
          ? 'passed'
          : `${r.outcome.toUpperCase()} — ${r.why || 'no reason given, which is itself unchecked'}`,
    })),
    ...(v.recommended_for.length
      ? [{ label: 'Chosen for', value: v.recommended_for.join(' · ') }]
      : []),
    ...(v.usable_for.length
      ? [{ label: 'Could cut, but lost on preference', value: v.usable_for.join(' · ') }]
      : []),
    ...v.refused_for.map((f) => ({ label: `Refused for ${f.feature_id}`, value: f.why })),
  ];
}

/* ── Drawing verdicts ──────────────────────────────────────────────────────── */

/**
 * The mark at the FRONT of a drawing row — red half.
 * 🔴 IT NAMES THE RULE.
 */
export function drawingUsabilityMark(v: DrawingVerdict | undefined): string {
  if (!v) return '⚠ NOT ASKED — the core has not answered for this drawing';
  const named = (outcome: 'refused' | 'unchecked') =>
    v.rules
      .filter((r) => r.outcome === outcome)
      .map((r) => r.rule)
      .join(', ');
  if (v.usability === 'invalidates')
    return `🔴 INVALIDATES THE JOB (${named('refused') || 'rule not named'})`;
  if (v.usability === 'unknown')
    return `⚠ UNKNOWN (unchecked: ${named('unchecked') || 'no rule ran'})`;
  return '✅ usable on this workpiece';
}

/**
 * The mark for the FIT axis.
 * 🔴 **NEVER `🔴 INVALIDATES`, WHATEVER THE VALUE.** The planner does not refuse
 * an off-workpiece drawing today.
 */
export function drawingFitMark(v: DrawingVerdict | undefined): string {
  if (!v) return '⚠ FIT NOT ASKED';
  if (v.fit === 'off-workpiece') return '⚠ NOT ON THE WORKPIECE';
  if (v.fit === 'unknown') return '⚠ FIT UNCHECKED';
  return 'on the workpiece';
}

export const FIT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'every drawing' },
  { value: 'on-workpiece', label: 'outline is on the workpiece' },
  { value: 'off-workpiece', label: 'outline is NOT on this workpiece (turning may still fit it)' },
  { value: 'unknown', label: 'not asked (not in the job, or too little declared)' },
];

/**
 * Worst-first: refused beats unchecked beats usable.
 * `undefined` when the row put nothing on the workpiece.
 */
export function worstDrawingFit(vs: readonly DrawingVerdict[]): string | undefined {
  if (!vs.length) return undefined;
  const order = ['off-workpiece', 'unknown', 'on-workpiece'] as const;
  for (const target of order) {
    if (vs.some((v) => v.fit === target)) return target;
  }
  return undefined;
}

/**
 * Everything the core says about one drawing's suitability, as properties.
 */
export function drawingVerdictProps(v: DrawingVerdict | undefined): ObjectProperty[] {
  if (!v)
    return [
      {
        label: 'Does it work on this workpiece?',
        value:
          'NOT ASKED — this drawing is not in the job, or the report does not describe the ' +
          'list as it stands. That is not "yes": nothing has vouched for it.',
      },
    ];
  return [
    {
      label: 'Does it work on this workpiece?',
      value:
        v.usability === 'usable'
          ? 'Yes — every blocking rule passed. See each one below.'
          : `${drawingUsabilityMark(v)} — ${v.why || 'the core gave no sentence, which is itself unchecked'}`,
    },
    {
      label: 'Is it on the material?',
      value: `${drawingFitMark(v)} — ${v.why_fit || 'the core gave no sentence, which is itself unchecked'}`,
    },
    ...(v.turn_that_fits_deg !== null
      ? [
          {
            label: 'A quarter turn that fits BY SIZE',
            value:
              `${v.turn_that_fits_deg}° — a SIZE answer only. It does not say where on the ` +
              'workpiece to put it, and nothing here turns or moves a drawing for you.',
          },
        ]
      : []),
    ...v.rules.map((r) => ({
      label: `Rule: ${r.rule}`,
      value:
        r.outcome === 'passed'
          ? 'passed'
          : `${r.outcome.toUpperCase()} — ${r.why || 'no reason given, which is itself unchecked'}`,
    })),
    {
      label: 'Counted in this drawing',
      value:
        `${v.cost.parts} part(s) · ${v.cost.closed_contours} closed contour(s) · ` +
        `${v.cost.interior_features} interior feature(s)` +
        (v.cost.open_contours ? ` · ⚠ ${v.cost.open_contours} OPEN contour(s)` : ''),
    },
    ...(v.placed_extent_mm
      ? [
          {
            label: 'Where it sits (workpiece mm)',
            value:
              `X ${v.placed_extent_mm[0].toFixed(3)} … ${v.placed_extent_mm[2].toFixed(3)} · ` +
              `Y ${v.placed_extent_mm[1].toFixed(3)} … ${v.placed_extent_mm[3].toFixed(3)}`,
          },
        ]
      : []),
  ];
}
