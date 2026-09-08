/* jobMaterial.ts — ONE answer to "what is this job being planned against?"
 *
 * Founder, 2026-08-11: *"move the material into the workpiece list, able to
 * filter workpiece by material via a drop down"*.
 *
 * ── THE THING THAT MAKES THIS A SAFETY MODULE AND NOT A FILTER ─────────────
 *
 * 🔴 `material` IS A FIELD OF `Job`, NOT OF `Stock`. The core carries ONE
 * material for the whole job, and `core/src/tools.rs` derives the chipload — and
 * therefore the feed the program actually carries — from it. This lane's worst
 * UI defect to date was a tool row printing a MATERIAL-BLIND feed, measured at
 * up to 4.3x the number the emitted program carried. A saved workpiece whose
 * stored material disagrees with the material the job is planned against would
 * be that defect wearing a new face: two sources of truth for a number that
 * reaches the spindle.
 *
 * So this module exists to guarantee one property, and it is the only thing it
 * guarantees:
 *
 *   THERE IS EXACTLY ONE ANSWER TO "WHAT MATERIAL IS THIS JOB PLANNED AGAINST",
 *   AND WHERE THAT ANSWER CAME FROM IS ALWAYS SAYABLE.
 *
 * A stored material and the job's material CAN diverge — the operator can pick a
 * saved plywood sheet and then change the material control. That divergence is
 * surfaced as a CONFLICT the operator resolves ({@link checkMaterialAgreement}),
 * never reconciled here by preferring one of them. Silently preferring either
 * would mean one of the two numbers on screen is being ignored, and neither is
 * labelled as the one that lost.
 *
 * ── WHAT IS DELIBERATELY NOT BUILT ────────────────────────────────────────
 *
 * ⚠ NO PER-WORKPIECE OR PER-PART MATERIAL. Two materials in one job cannot be
 * expressed by the core at all, so nothing here offers a shape that implies they
 * can. If a job ever needs two, that is a CORE change (`material` moving from
 * `Job` to `Stock`) and this module must not pretend it has happened by carrying
 * two values a planner can only read one of.
 *
 * ⚠ NO DEFAULT. An unstated material is UNKNOWN and stays unknown. The same rule
 * as the empty inventory next door: a default that looks like a selection is the
 * problem being removed, and here it is worse — the default would silently
 * choose the multiplier every feed in the program is scaled by.
 */

import type { SheetSize } from './materials';

/* ── Resolving a stated material against the CORE's list ───────────────────── */

export type MaterialVerdict =
  /** Stated, and the planner has it. The only state a job may be planned on. */
  | { state: 'known'; name: string }
  /**
   * Stated, and THIS CORE DOES NOT CARRY IT. Refused rather than matched to the
   * nearest name — a material substituted by similarity scales every feed in the
   * program by somebody else's multiplier.
   */
  | { state: 'unknown'; name: string; why: string }
  /** The row says nothing. A real answer, and it is not "plywood". */
  | { state: 'not-stated'; why: string };

/** Shown wherever a material is missing. One sentence, one place. */
export const NOT_STATED_WHY =
  'this does not say what it is made of. The material is what every feed in the program is ' +
  'scaled by, so it is left UNKNOWN rather than filled in — choose it deliberately.';

/** The dropdown value that means "rows that state nothing". A sentinel rather
 *  than `''`, which already means "no filter". */
export const FACET_NOT_STATED = '\0not-stated';

/** The label shown for {@link FACET_NOT_STATED}. */
export const FACET_NOT_STATED_LABEL = '(material not stated)';

/**
 * Is this material one the planner has?
 *
 * @param library the material NAMES the core reported (`lib.materials`). The
 *        core is the authority; this module never carries its own copy of the
 *        list, because a second copy drifts and the drift is invisible.
 */
export function resolveMaterial(stated: string | undefined | null, library: readonly string[]): MaterialVerdict {
  const name = typeof stated === 'string' ? stated.trim() : '';
  if (!name) return { state: 'not-stated', why: NOT_STATED_WHY };
  if (library.includes(name)) return { state: 'known', name };
  return {
    state: 'unknown',
    name,
    why:
      `"${name}" is not a material this build's planner carries (it has ${library.join(', ') || 'none — the library has not loaded'}). ` +
      `It has NOT been matched to a similar one: the material scales every feed in the program, and a ` +
      `substituted one is the wrong number applied confidently.`,
  };
}

/** The material a saved workpiece states, if it states one. Kept as its own
 *  function so the field name is written once. */
export function materialOfWorkpiece(w: { material?: string } | null | undefined): string | undefined {
  const m = w?.material;
  return typeof m === 'string' && m.trim() ? m.trim() : undefined;
}

/** The material a shipped sheet size states. See `materials.ts` for why the four
 *  material-agnostic panel sizes state nothing. */
export function materialOfSheet(s: Pick<SheetSize, 'material'>): string | undefined {
  return typeof s.material === 'string' && s.material.trim() ? s.material.trim() : undefined;
}

/* ── The one answer, and the conflict that must never be silent ────────────── */

export type MaterialAgreement =
  /** The job's material and the selected workpiece's agree, or nothing
   *  contradicts it. `from` says which surface the answer came off. */
  | { state: 'agreed'; name: string; from: 'the job material control' | 'the selected workpiece'; note?: string }
  /** No material anywhere. The job cannot be planned and the UI must say so. */
  | { state: 'unknown'; why: string }
  /**
   * 🔴 TWO ANSWERS. Surfaced, never resolved here. Both names are carried so the
   * operator picks; a module that chose one would be deciding which number on
   * screen is a lie.
   */
  | { state: 'conflict'; job: string; workpiece: string; workpieceName: string; why: string };

/**
 * Reconcile the job's material with the workpiece that is selected.
 *
 * @param jobMaterial what the job is planned against RIGHT NOW — the value the
 *        core is handed. `''` when nothing is set.
 * @param workpiece the selected saved workpiece or shipped sheet, with the name
 *        the picker shows and the material it states. `null` when the workpiece
 *        is ad-hoc (typed dimensions, no record) — which is the common case and is
 *        NOT a conflict.
 */
export function checkMaterialAgreement(
  jobMaterial: string,
  workpiece: { name: string; material?: string } | null,
  library: readonly string[]
): MaterialAgreement {
  const job = resolveMaterial(jobMaterial, library);
  const stated = workpiece ? materialOfWorkpiece(workpiece) : undefined;
  const wp = workpiece ? resolveMaterial(stated, library) : ({ state: 'not-stated', why: NOT_STATED_WHY } as MaterialVerdict);

  if (job.state === 'unknown') {
    return {
      state: 'unknown',
      why:
        `the job is set to ${job.why} Nothing will be planned until a material the planner has is chosen.`,
    };
  }

  if (job.state === 'not-stated') {
    if (wp.state === 'known') {
      /* The workpiece answers it. This is the path the founder asked for:
       * choosing a workpiece SETS the job's material. The caller applies it; the
       * agreement below is what it applied and where it came from. */
      return { state: 'agreed', name: wp.name, from: 'the selected workpiece' };
    }
    if (wp.state === 'unknown') {
      return {
        state: 'unknown',
        /* `workpiece`, not `sheet` — `docs/terminology.md` §3. A SHEET is a
         * published stock size in a catalogue; the object in the job is the
         * WORKPIECE, which is what the panel this message renders under is
         * called. The founder's own example was a message reading "the sheet is
         * TURNED" beside a panel headed Workpiece. */
        why: `the workpiece "${workpiece!.name}" says it is ${wp.why}`,
      };
    }
    return {
      state: 'unknown',
      why:
        `no material is set for this job, and ${workpiece ? `the workpiece "${workpiece.name}" states none either` : 'the workpiece was typed rather than picked, so it states none'}. ` +
        NOT_STATED_WHY,
    };
  }

  // The job HAS a material the planner carries. The only remaining question is
  // whether the selected workpiece says something different.
  if (wp.state === 'known' && wp.name !== job.name) {
    return {
      state: 'conflict',
      job: job.name,
      workpiece: wp.name,
      workpieceName: workpiece!.name,
      why:
        `this job is being planned against "${job.name}", and the workpiece "${workpiece!.name}" is recorded ` +
        `as "${wp.name}". Feeds, chipload and depth of cut are all derived FROM the material, so exactly one ` +
        `of these two is what the program will actually carry — and it is "${job.name}". Fix whichever is ` +
        `wrong before you cut; nothing here will choose for you.`,
    };
  }

  if (wp.state === 'unknown') {
    return {
      state: 'agreed',
      name: job.name,
      from: 'the job material control',
      note:
        `the workpiece "${workpiece!.name}" is recorded as "${wp.name}", which this build's planner does not ` +
        `carry, so it could not be compared. The job is planned against "${job.name}".`,
    };
  }

  return {
    state: 'agreed',
    name: job.name,
    from: wp.state === 'known' ? 'the selected workpiece' : 'the job material control',
    note:
      wp.state === 'not-stated' && workpiece
        ? `the workpiece "${workpiece.name}" states no material of its own, so nothing contradicts the job's "${job.name}" — and nothing confirms it either.`
        : undefined,
  };
}

/* ── The facet the workpiece list filters by ───────────────────────────────── */

export interface FacetOption {
  /** `''` = every row. {@link FACET_NOT_STATED} = the rows that say nothing. */
  value: string;
  label: string;
  /** How many rows this option would show. A count of zero is still LISTED, so
   *  "we stock no acrylic" is visible rather than absent. */
  count: number;
}

/**
 * Build the dropdown, from the rows themselves.
 *
 * 🔴 THE OPTIONS COME FROM THE ROWS, NOT FROM THE MATERIAL LIBRARY. A filter
 * offering "Aluminium" over a list holding no aluminium sheet is a control that
 * empties the list and tells the operator nothing about why. The library is used
 * only to ORDER the known materials consistently and to put anything the rows
 * state that the core does not carry at the end, where its oddity is visible.
 *
 * 🔴 AND `(material not stated)` IS ALWAYS AN OPTION WHEN ANY ROW LACKS ONE.
 * Without it, filtering to "Plywood" would hide the unstated rows with no way to
 * reach them, and a hidden row and a non-existent row are identical on screen —
 * `ObjectPicker` rule 1, applied to the facet instead of the search box.
 */
export function materialFacetOptions(
  rows: readonly { material?: string }[],
  library: readonly string[]
): FacetOption[] {
  const counts = new Map<string, number>();
  let unstated = 0;
  for (const r of rows) {
    const m = materialOfWorkpiece(r);
    if (!m) unstated++;
    else counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const known = library.filter((m) => counts.has(m));
  const foreign = [...counts.keys()].filter((m) => !library.includes(m)).sort();
  const out: FacetOption[] = [{ value: '', label: `All materials`, count: rows.length }];
  for (const m of [...known, ...foreign]) {
    out.push({ value: m, label: library.includes(m) ? m : `${m} (not in this build's planner)`, count: counts.get(m) ?? 0 });
  }
  if (unstated > 0) out.push({ value: FACET_NOT_STATED, label: FACET_NOT_STATED_LABEL, count: unstated });
  return out;
}

/** Does a row pass the chosen facet? `''` passes everything. */
export function facetMatches(rowMaterial: string | undefined, facet: string): boolean {
  if (facet === '') return true;
  const m = materialOfWorkpiece({ material: rowMaterial });
  if (facet === FACET_NOT_STATED) return m === undefined;
  return m === facet;
}
