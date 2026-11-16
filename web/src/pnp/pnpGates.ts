/**
 * Gates for a pick-and-place job on the 2bee.pnp tab (founder 2026-10-16:
 * "create similar navbar on pnp and 3d) add the gates there"). The same
 * contract as cnc/runGates.ts:
 *
 * THREE STATES, NEVER TWO. PASS = checked and holds. FAIL = checked and does
 * not. PENDING = could not be checked yet (board still loading, no machine
 * travel to check against). PENDING is NOT a pass: `mayRun` needs every gate
 * PASS.
 *
 * DIRECTION OF ERROR: over-block. A false FAIL costs a click; a false PASS
 * sends a person to a machine with a tray that does not hold the part, or a
 * board half outside the travel. Every unrecognised input lands on FAIL or
 * PENDING, never PASS.
 *
 * ⚠ NOTHING ON THIS TAB RUNS A MACHINE. There is no run or export action here
 * to gate (2026-10-16); these gates say what would have to hold before a job
 * could go to one, and they are what any future run/export button must read.
 *
 * Each gate checks the OUTPUT it names (the lanes the plan produced, the
 * placement the view holds), not the setting meant to produce it.
 */
import type { PreflightResult } from './manifest';

export type PnpGateState = 'PASS' | 'FAIL' | 'PENDING';

export interface PnpGate {
  id: 'board' | 'cpl' | 'trays' | 'machine' | 'travel' | 'hand' | 'loaded';
  name: string;
  /** The physical failure it guards. */
  guards: string;
  state: PnpGateState;
  why: string;
  /** True when a PERSON's confirmation clears this gate (never set by the app). */
  confirm?: boolean;
}

export interface PnpPartIn {
  ref: string;
  by: string;
  /** Where the position came from: a CPL row, or the .kicad_pcb fallback. */
  from: 'cpl' | 'kicad_pcb';
}

export interface PnpGateInput {
  /** '' = no board chosen. */
  boardId: string;
  /** null while loading or after an error. */
  loaded: boolean;
  loadError: string | null;
  /** Every BOM part with a position, and those with none. null = not read yet. */
  parts: { parts: PnpPartIn[]; unplaced: { ref: string; by: string }[] } | null;
  /** The tray plan (`preflight`), a could-not-run sentence, or null. */
  plan: PreflightResult | string | null;
  machine: { name: string; travel: { x: number | null; y: number | null } } | null;
  /** The board's size on the machine and where its lower-left sits. null = no model. */
  board: { w: number; h: number; x: number; y: number } | null;
  /** A person confirmed, for THIS job, that the trays are loaded as planned and the nozzle is fitted. */
  confirmedLoaded: boolean;
}

const list = (refs: string[], n = 6) => (refs.length > n ? `${refs.slice(0, n).join(', ')} and ${refs.length - n} more` : refs.join(', '));

export function pnpGates(i: PnpGateInput): PnpGate[] {
  const gates: PnpGate[] = [];
  const machineParts = i.parts ? i.parts.parts.filter((p) => p.by === 'machine') : [];

  // G-BOARD
  gates.push({
    id: 'board',
    name: 'The board is loaded and readable',
    guards: 'a job planned from a file that was not read, or read only in part',
    ...(!i.boardId
      ? { state: 'FAIL' as const, why: 'No board is chosen. Pick one at the top of the assistant.' }
      : i.loadError
        ? { state: 'FAIL' as const, why: i.loadError }
        : !i.loaded || !i.parts
          ? { state: 'PENDING' as const, why: `Loading ${i.boardId}…` }
          : i.parts.parts.length + i.parts.unplaced.length === 0
            ? { state: 'FAIL' as const, why: 'The BOM and CPL name no parts.' }
            : { state: 'PASS' as const, why: `${i.parts.parts.length + i.parts.unplaced.length} parts read.` }),
  });

  // G-CPL — the machine needs a CPL row (X, Y, rotation, side) for every part it places.
  const noRow = i.parts
    ? [...i.parts.unplaced.filter((p) => p.by === 'machine').map((p) => p.ref), ...machineParts.filter((p) => p.from !== 'cpl').map((p) => p.ref)]
    : [];
  gates.push({
    id: 'cpl',
    name: 'Every machine part has a placement row',
    guards: 'the machine placing a part at a position nobody exported, or skipping it',
    ...(!i.parts
      ? { state: 'PENDING' as const, why: 'No board read yet.' }
      : noRow.length
        ? { state: 'FAIL' as const, why: `No CPL row for ${list(noRow)}. Export the CPL again from the board (pcb).` }
        : { state: 'PASS' as const, why: machineParts.length ? `${machineParts.length} machine part(s), each with a CPL row.` : 'No part is placed by the machine on this board.' }),
  });

  // G-TRAYS — read the lanes the plan PRODUCED, not only its exit code.
  const plan = i.plan;
  const laned = new Set(plan && typeof plan !== 'string' ? plan.lanes.flatMap((l) => l.refs) : []);
  const noLane = machineParts.map((p) => p.ref).filter((r) => !laned.has(r));
  gates.push({
    id: 'trays',
    name: 'Every machine part has a tray lane',
    guards: 'a part with no tape on the machine, or a lane that runs out mid-job',
    ...(plan === null
      ? { state: 'PENDING' as const, why: 'No tray plan yet.' }
      : typeof plan === 'string'
        ? { state: 'FAIL' as const, why: `The tray plan could not run: ${plan}` }
        : plan.exit === 2
          ? { state: 'FAIL' as const, why: `The tray plan could not run${plan.refusals[0] ? `: ${plan.refusals[0].message}` : '.'}` }
          : plan.exit !== 0
            ? { state: 'FAIL' as const, why: plan.refusals[0] ? `${plan.refusals.length} problem(s). First: ${plan.refusals[0].message}` : 'The tray plan refused the job without a reason the app can read.' }
            : noLane.length
              ? { state: 'FAIL' as const, why: `The plan says OK but gives no lane to ${list(noLane)}.` }
              : { state: 'PASS' as const, why: `${plan.lanes.length} lane(s) on ${plan.traysUsed.length} tray(s)${plan.warnings.length ? `; ${plan.warnings.length} warning(s), see Expert` : ''}.` }),
  });

  // G-MACHINE — chosen, and its travel stated (the only placement-area number pnp gives).
  const tx = i.machine?.travel.x ?? null;
  const ty = i.machine?.travel.y ?? null;
  gates.push({
    id: 'machine',
    name: 'A machine is chosen and its travel is stated',
    guards: 'a board placed against a machine whose reach nobody has written down',
    ...(!i.machine
      ? { state: 'FAIL' as const, why: 'No machine is chosen.' }
      : tx === null || ty === null
        ? { state: 'FAIL' as const, why: `${i.machine.name}: hardware/pnp/ states no X/Y travel, so where the board sits cannot be checked.` }
        : { state: 'PASS' as const, why: `${i.machine.name}: ${tx} × ${ty} mm (rail strokes, not a placement area).` }),
  });

  // G-TRAVEL — on the numbers the view holds, not on the `fits` flag alone.
  const b = i.board;
  const inside = b && tx !== null && ty !== null ? b.x >= 0 && b.y >= 0 && b.x + b.w <= tx + 1e-9 && b.y + b.h <= ty + 1e-9 : false;
  gates.push({
    id: 'travel',
    name: 'The board sits inside the travel',
    guards: 'the head driven to parts it cannot reach, or into its end stops',
    ...(!b
      ? { state: 'PENDING' as const, why: 'No board on the machine yet.' }
      : tx === null || ty === null
        ? { state: 'PENDING' as const, why: 'The machine states no travel to check against.' }
        : ![b.x, b.y, b.w, b.h].every(Number.isFinite)
          ? { state: 'FAIL' as const, why: 'The board position is not a number.' }
          : b.w > tx || b.h > ty
            ? { state: 'FAIL' as const, why: `The board (${b.w.toFixed(1)} × ${b.h.toFixed(1)} mm) is larger than the ${tx} × ${ty} mm travel.` }
            : !inside
              ? { state: 'FAIL' as const, why: `At X ${b.x.toFixed(1)}, Y ${b.y.toFixed(1)} part of the board is outside the ${tx} × ${ty} mm travel.` }
              : { state: 'PASS' as const, why: `At X ${b.x.toFixed(1)}, Y ${b.y.toFixed(1)}: inside ${tx} × ${ty} mm.` }),
  });

  // G-HAND — information: the parts a person fits, listed so none is forgotten.
  const handRefs = i.parts ? [...i.parts.parts, ...i.parts.unplaced].filter((p) => p.by !== 'machine' && p.by !== 'dnp' && p.by !== 'not-placed').map((p) => p.ref) : [];
  gates.push({
    id: 'hand',
    name: 'Parts placed by hand or by the fab are listed',
    guards: 'a hand-fitted part forgotten because the machine run looked complete',
    ...(!i.parts
      ? { state: 'PENDING' as const, why: 'No board read yet.' }
      : { state: 'PASS' as const, why: handRefs.length ? `${handRefs.length} not by our machine: ${list(handRefs, 8)}.` : 'Every part is placed by the machine.' }),
  });

  // G-LOADED — physical: only a person at the machine can say it.
  gates.push({
    id: 'loaded',
    name: 'Trays loaded and nozzle fitted',
    guards: 'the machine picking from an empty or wrong lane, or with the wrong nozzle',
    ...(i.confirmedLoaded
      ? { state: 'PASS' as const, why: 'You confirmed the trays are loaded as planned and the nozzle is fitted.' }
      : { state: 'FAIL' as const, why: 'Load each lane with the tape the plan names and fit the nozzle, then confirm here. The app cannot see the trays.', confirm: true }),
  });

  return gates;
}

/** A run/export is allowed only when EVERY gate is PASS. PENDING is not a pass. */
export function mayRun(gates: readonly { state: PnpGateState }[]): boolean {
  return gates.length > 0 && gates.every((g) => g.state === 'PASS');
}

/**
 * The trays the plan says the job needs: `lanesNeeded` per variant → that many
 * trays of it. A CANDIDATE only — the caller re-runs `preflight` on it and applies
 * it through `mayApplyPnp`, the same check every chat proposal passes.
 * null when the plan has nothing to offer or the result would exceed `maxTrays`.
 */
export function traysFromNeed(plan: PreflightResult, maxTrays: number): { trayId: string; variant: string }[] | null {
  const out: { trayId: string; variant: string }[] = [];
  for (const [variant, need] of Object.entries(plan.lanesNeeded))
    for (let k = 0; k < need.trays; k++) out.push({ trayId: `T${String(out.length + 1).padStart(2, '0')}`, variant });
  return out.length && out.length <= maxTrays ? out : null;
}
