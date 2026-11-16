// Why a machine may not run, as one pure function every Start button reads.
//
// 🔴 HARD PRECONDITION FROM pcb/ops, 2026-10-15 (docs/plan-2bee-cnc-redesign.md):
// NO PHYSICAL E-STOP EXISTS. The mushroom NC switch and contactor were designed
// and never ordered, and the firmware is built with `ESTOP_ENABLE 0`. Router
// operation is on HOLD at ops (insurance, venue). So Run stays DISABLED, with
// that reason on screen, for every machine that is not the simulated one.
//
// The e-stop fact is per machine (`machines.ts::ESTOP_INSTALLED`, ops depot SOP
// item H5, pcb correction 2026-10-15-01-20-26); the ops HOLD and the bridge are
// shop-wide constants below. None of them is a setting. A toggle in the UI that said
// "e-stop installed" would be a way to make the refusal go away by typing; the
// fact changes when hardware is fitted and ops lifts the HOLD, and then this
// file changes in a commit that says so.
//
// 🔴 AND EVEN WITH BOTH FACTS TRUE, A BRIDGE MACHINE STAYS BLOCKED: the router
// bridge is not built (plan phase 3), so there is nothing to stream through.
// That is a separate reason and it is checked separately, so lifting one does
// not silently lift the other.

import { isSimulated, type Machine } from './machines';
import { airCutFor, type Job, type RunPhase } from './jobs';
import type { StepId } from './steps';

export interface SafetyFacts {
  /** ops has lifted the HOLD on router operation. */
  opsHoldLifted: boolean;
  /** The per-router network bridge exists and this app can reach it. */
  bridgeBuilt: boolean;
}

/** As of 2026-10-15. Change only with the hardware and ops' word, in a commit that cites both. */
export const SAFETY_FACTS: SafetyFacts = { opsHoldLifted: false, bridgeBuilt: false };

export const ESTOP_REASON =
  'No physical e-stop is installed (never ordered; firmware ESTOP_ENABLE 0) and ops has router operation on HOLD. Run stays off until ops closes depot SOP item H5 (e-stop installed).';
export const NO_ESTOP_REASON = 'No physical e-stop is installed (ops depot SOP item H5 is open).';
export const OPS_HOLD_REASON = 'ops has router operation on HOLD.';
export const NO_BRIDGE_REASON = 'The router bridge is not built yet, so this app cannot reach the machine.';

/**
 * Why this machine may not run a program, or `null` when it may.
 * Only the SIMULATED machine returns `null` today.
 */
export function runBlocker(m: Pick<Machine, 'connection' | 'estopInstalled'>, facts: SafetyFacts = SAFETY_FACTS): string | null {
  if (isSimulated(m)) return null;
  /* 🔴 The e-stop is a fact about THIS machine (machines.ts::ESTOP_INSTALLED,
   * ops H5), checked first and regardless of ticks or operator presence —
   * nothing the operator does on screen reaches this line. */
  if (!m.estopInstalled && !facts.opsHoldLifted) return ESTOP_REASON;
  if (!m.estopInstalled) return NO_ESTOP_REASON;
  if (!facts.opsHoldLifted) return OPS_HOLD_REASON;
  if (!facts.bridgeBuilt) return NO_BRIDGE_REASON;
  return null;
}

/**
 * Everything that stands between the operator and Start, in the order they
 * would fix it. Empty means this app's own conditions are met; the
 * controller's refusals (R1–R14, `run/protocol.ts::refusalsFor`) are checked
 * after these by the sender itself, and are shown too.
 *
 * `phase` 'aircut': the setup steps must be ticked. 'cut': also the air cut of
 * THIS program on THIS machine, Z zero put back, and "I am at the machine".
 */
export function startBlockers(
  a: {
    machine: Pick<Machine, 'connection' | 'estopInstalled'>;
    job: Pick<Job, 'state' | 'facts' | 'airCut' | 'program' | 'machineId'>;
    ticks: ReadonlySet<StepId>;
    loaded: { ok: boolean; problems: string[] };
    phase: RunPhase;
  },
  facts: SafetyFacts = SAFETY_FACTS,
): string[] {
  const out: string[] = [];
  const rb = runBlocker(a.machine, facts);
  if (rb) out.push(rb);
  if (a.job.state !== 'queued') out.push(`The job is ${a.job.state}.`);
  if (!a.job.facts) out.push('The setup facts could not be read for this program.');
  out.push(...a.loaded.problems);
  const need: StepId[] = ['load', 'clamp', 'cutter', 'zero'];
  if (a.phase === 'cut') need.push('aircut', 'present');
  const open = need.filter((s) => !a.ticks.has(s));
  if (open.length) out.push(`Not ticked yet: ${open.map((s) => STEP_WORD[s]).join(', ')}.`);
  if (a.phase === 'cut' && !airCutFor(a.job)) out.push('The air cut has not been run for this program on this machine.');
  return out;
}

const STEP_WORD: Record<StepId, string> = {
  load: 'load',
  clamp: 'clamp',
  cutter: 'cutter 1',
  zero: 'zero',
  aircut: 'air cut',
  present: 'at the machine',
};
