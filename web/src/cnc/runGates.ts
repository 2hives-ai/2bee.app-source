/**
 * Pre-run gates for a cnc job: what must hold before a program may go to a
 * machine (founder 2026-10-16: "if it is having issues (like the working peace
 * is not fixed down to the table) disable the test, run buttons and show the
 * issue" and "create gates what are run to validate the execution").
 *
 * WHY THIS EXISTS
 *   2026-10-16, cnc chat view: a job whose part had been auto-placed ON a
 *   declared clamp (CutsClamp at X 378.1, Y 85.0) still showed an enabled Run
 *   button; the only signal was a refusal sentence on the canvas. A job with NO
 *   hold-down declared at all was not flagged anywhere in that view (the core
 *   reports it as the fixture finding `Undeclared`, which the app filtered out).
 *
 * THREE STATES, NEVER TWO. PASS = checked and holds. FAIL = checked and does
 * not. PENDING = could not be checked yet (nothing planned, machine not tested,
 * material list not loaded). PENDING is NOT a pass: `mayRun` needs every gate
 * PASS.
 *
 * DIRECTION OF ERROR: over-block. A false FAIL costs the operator a click; a
 * false PASS sends a program to a 2.2 kW spindle. Every unrecognised input
 * lands on FAIL or PENDING, never PASS.
 *
 * ⚠ These gates sit IN FRONT OF cnc.run's own checks (steps ticked, forced air
 * cut, operator present, one job per machine, e-stop H5); they do not replace
 * any of them.
 */
import { describeFinding } from './findings';

export type GateState = 'PASS' | 'FAIL' | 'PENDING';

export interface Gate {
  id: 'plan' | 'outline' | 'hold' | 'fixture' | 'cutters' | 'material' | 'machine';
  /** What is checked, in the operator's words. */
  name: string;
  /** The physical failure it guards. */
  guards: string;
  state: GateState;
  /** Why this state; for FAIL, what to do. */
  why: string;
  /** True when a PERSON's confirmation clears this gate (never set by the app). */
  confirm?: boolean;
}

export interface GateInput {
  /** null = nothing planned yet. `notes` = the core's import/plan notes. */
  plan: { ok: boolean; refusals: string[]; fixtureFindings: string[]; notes?: string[] } | null;
  /** Placed clamps + other declared hold-downs (screws, tape, vacuum…). */
  clampCount: number;
  holdDownCount: number;
  /** The operator confirmed (today) that the table is clear and the work is held without clamps. */
  confirmedClear: boolean;
  /** Cutters the job would use, and those cnc.tools holds as owned. */
  jobToolIds: string[];
  ownedToolIds: string[];
  material: string;
  /** null = the planner's material list has not loaded. */
  materialLibrary: string[] | null;
  thicknessMm: number;
  /**
   * When the clamps MOVE mid-job (core `reclamp.rs`): how many clamp phases the
   * core checked, and how many clamps the operator moves. Absent = one phase.
   */
  clampPhases?: { phases: number; moves: number; stops?: string; warnings?: string[] };
  /** null = no machine chosen. */
  machine: { name: string; check: 'untested' | 'ok' | 'simulated' | 'unreachable'; detail?: string } | null;
}

const FIXTURE_RE = /^(CutsClamp|RapidBelowClamp|ClampHeightUndeclared)\b/;

export function runGates(i: GateInput): Gate[] {
  const gates: Gate[] = [];

  // G-PLAN
  const fixtureFails = i.plan ? i.plan.fixtureFindings.filter((f) => FIXTURE_RE.test(f.trim())) : [];
  const otherRefusals = i.plan ? i.plan.refusals.filter((r) => !FIXTURE_RE.test(r.trim())) : [];
  gates.push({
    id: 'plan',
    name: 'The planner accepts the job',
    guards: 'a program the core refused (out of travel, overlapping parts, a cut it cannot make) reaching a machine',
    ...(!i.plan
      ? { state: 'PENDING' as const, why: 'Nothing is planned yet.' }
      : !i.plan.ok && otherRefusals.length
        ? { state: 'FAIL' as const, why: describeFinding(otherRefusals[0]).text }
        : !i.plan.ok && !fixtureFails.length
          ? { state: 'FAIL' as const, why: 'The planner refused the job without a reason the app can read.' }
          : { state: 'PASS' as const, why: 'Planned.' }),
  });

  // G-OUTLINE
  /* 2026-10-16: Hive super panel planned "OK" with only its 28 holes — the outer
   * profile came out of the section as open chains and was dropped (core note
   * "N contour(s) did not close and were NOT cut"). A plan that cuts only part of
   * a design is the plausible-wrong-part failure. */
  const open = (i.plan?.notes ?? []).filter((n) => /did not close and were NOT cut|did NOT close/.test(n));
  gates.push({
    id: 'outline',
    name: 'Every outline of the design is cut',
    guards: 'a job that cuts the holes but never cuts the part free (an outline dropped on import)',
    ...(!i.plan
      ? { state: 'PENDING' as const, why: 'Nothing is planned yet.' }
      : open.length
        ? { state: 'FAIL' as const, why: `${open.length} outline note(s): ${open[0].slice(0, 160)}` }
        : { state: 'PASS' as const, why: 'Every outline closed and is cut.' }),
  });

  // G-HOLD
  /* With no clamps, the core requires `confirmed_clear`: a PERSON's statement that
   * they looked at the table today. It is never set by the app or the AI; the gate
   * asks for it (Gate.confirm) once a clamp-free hold-down is declared. */
  const undeclared = !!i.plan?.fixtureFindings.some((f) => f.trim() === 'Undeclared');
  gates.push({
    id: 'hold',
    name: 'The workpiece is held down',
    guards: 'a workpiece lifting or sliding under the cutter and being thrown',
    ...(i.clampCount > 0 && !undeclared
      ? { state: 'PASS' as const, why: `${i.clampCount} clamp(s) placed.` }
      : i.holdDownCount > 0 && i.confirmedClear && !undeclared
        ? { state: 'PASS' as const, why: 'Held without clamps; you confirmed the table is clear.' }
        : i.holdDownCount > 0
          ? { state: 'FAIL' as const, why: 'A hold-down without clamps is declared. Confirm at the machine that it is fitted and nothing else is on the table.', confirm: true }
          : { state: 'FAIL' as const, why: 'No clamp, screws, tape or vacuum is declared for this job. Declare how it is held down.' }),
  });

  // G-FIXTURE
  gates.push({
    id: 'fixture',
    name: 'The cutter clears every clamp',
    guards: 'the cutter cutting into a clamp, or a rapid move hitting one',
    ...(!i.plan
      ? { state: 'PENDING' as const, why: 'Nothing is planned yet.' }
      : fixtureFails.length
        ? { state: 'FAIL' as const, why: describeFinding(fixtureFails[0]).text }
        : i.clampPhases && i.clampPhases.phases > 1
          ? {
              state: 'PASS' as const,
              why:
                `No cut or move crosses a clamp — checked in each of the ${i.clampPhases.phases} clamp phases against the clamps standing during it. ` +
                `The job stops ${i.clampPhases.phases - 1} time(s) for you to move ${i.clampPhases.moves} clamp(s)` +
                (i.clampPhases.stops ? ` (${i.clampPhases.stops}).` : '.') +
                // A stated warning, LISTED and not a failure (founder
                // 2026-10-16: "have as a warning allow without z probe").
                (i.clampPhases.warnings?.length ? ` Warning: ${i.clampPhases.warnings.join('; ')}.` : ''),
            }
          : { state: 'PASS' as const, why: 'No cut or move crosses a clamp.' }),
  });

  // G-CUTTERS
  const unowned = i.jobToolIds.filter((t) => !i.ownedToolIds.includes(t));
  gates.push({
    id: 'cutters',
    name: 'Every cutter the job uses is in cnc.tools',
    guards: 'a program written for a cutter the shop does not have, run with whatever is in the collet',
    ...(i.jobToolIds.length === 0
      ? { state: 'PENDING' as const, why: 'The job uses no cutter yet.' }
      : unowned.length
        ? { state: 'FAIL' as const, why: `Not registered in cnc.tools: ${unowned.join(', ')}. Register (and measure) them, or choose owned cutters.` }
        : { state: 'PASS' as const, why: `${i.jobToolIds.length} cutter(s), all registered.` }),
  });

  // G-MATERIAL
  gates.push({
    id: 'material',
    name: 'The material and thickness are known',
    guards: 'feeds, speeds and depths computed for a material or thickness that is not on the table',
    ...(!(Number.isFinite(i.thicknessMm) && i.thicknessMm > 0)
      ? { state: 'FAIL' as const, why: 'The thickness is not a positive number.' }
      : i.materialLibrary === null
        ? { state: 'PENDING' as const, why: "The planner's material list has not loaded." }
        : !i.materialLibrary.includes(i.material)
          ? { state: 'FAIL' as const, why: `"${i.material}" is not a material the planner knows.` }
          : { state: 'PASS' as const, why: `${i.material}, ${i.thicknessMm} mm.` }),
  });

  // G-MACHINE
  gates.push({
    id: 'machine',
    name: 'The machine answers',
    guards: 'queuing a job for a machine that is not there',
    ...(!i.machine
      ? { state: 'FAIL' as const, why: 'No machine is chosen.' }
      : i.machine.check === 'untested'
        ? { state: 'PENDING' as const, why: `Press Test to check ${i.machine.name}.` }
        : i.machine.check === 'unreachable'
          ? { state: 'FAIL' as const, why: i.machine.detail ?? `${i.machine.name} did not answer.` }
          : { state: 'PASS' as const, why: i.machine.check === 'simulated' ? `${i.machine.name} is simulated (nothing real moves).` : `${i.machine.name} answered.` }),
  });

  return gates;
}

/** Run is allowed only when EVERY gate is PASS. PENDING is not a pass. */
export function mayRun(gates: readonly Gate[]): boolean {
  return gates.length > 0 && gates.every((g) => g.state === 'PASS');
}

/** Test is allowed when nothing other than the machine gate FAILS. */
export function mayTest(gates: readonly Gate[]): boolean {
  return !gates.some((g) => g.id !== 'machine' && g.state === 'FAIL');
}
