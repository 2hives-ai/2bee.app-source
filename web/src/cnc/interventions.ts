/**
 * Operator stops in a CNC program — the points where the machine waits for a
 * person (founder 2026-10-16: "if the clamp needs to be removed and reapplied
 * during the job show it in the timeline and the 3d", "in the cnc progress show
 * in different color when I have to change the tools/clamps", "this is generic
 * tool change what needs to be done by the user").
 *
 * 🔴 READ FROM THE CORE'S REPORT, NEVER DECIDED HERE. A stop is a `change`
 * (cutter) or `clamp` render move, which the core writes from the same moves the
 * post turns into `M0`; a `clamp` immediately followed by a `change` is ONE stop
 * (the post writes one `M0` for both). Which clamps stand during which part of
 * the program is `report.clamp_phases`, and where they move is
 * `report.clamp_moves` — both echoed by the core from the plan it posted.
 *
 * On a machine with NO Z probe a cutter change is followed by a `zero` render
 * move — the program stops a second time for the person to set Z zero by hand
 * — and it is folded into that cutter change's stop here: one intervention. A
 * clamp-only stop with no `probe` after it carries {@link CLAMP_NO_ZCHECK}.
 *
 * ⚠ Kinds that exist today: cutter change, clamp move. A toolhead change
 * (spindle -> laser / drag knife) is not modelled by the core, so no program
 * contains one and nothing here invents one.
 */
import type { ClampCfg, ClampMove, RenderMove, Report } from '../cam';
import { formatLength, type Unit } from '../units';

export type StopKind = 'cutter' | 'clamps' | 'both';

/**
 * What a clamp-only stop on a machine with no Z probe says (founder
 * 2026-10-16: "have as a warning allow without z probe"). The SAME words the
 * core writes into the program (`setup::CLAMP_NO_ZCHECK`), so the screen and
 * the file cannot say different things.
 */
export const CLAMP_NO_ZCHECK =
  'Z not re-checked after the clamp move - do not touch the spindle or the cutter while moving the clamp';

export interface ProgramStop {
  /** Index in `report.render` of the stop's first move. */
  at: number;
  kind: StopKind;
  /** The cutter to fit, when the stop changes it. */
  cutter?: string;
  /** The clamp instruction, when the stop moves clamps. */
  clamps?: string;
  /** No Z probe: after the cutter change the program stops again for the
   *  person to set Z zero by hand. The instruction. */
  zero?: string;
  /** The cutter that was in the collet before this stop, when it changes it. */
  from?: string;
  /** A clamp move after which nothing re-measures Z. */
  warning?: string;
}

/** Every operator stop, in program order. */
export function stopsOf(moves: readonly RenderMove[]): ProgramStop[] {
  const out: ProgramStop[] = [];
  // The cutter in the collet: the first `change` names the second cutter, so
  // the first is unknown here until one is fitted — `from` is then absent.
  let fitted: string | undefined;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    let stop: ProgramStop | null = null;
    if (m.kind === 'clamp') {
      const next = moves[i + 1];
      if (next && next.kind === 'change') {
        stop = { at: i, kind: 'both', clamps: m.text ?? '', cutter: next.text ?? '' };
        i += 1;
      } else {
        stop = { at: i, kind: 'clamps', clamps: m.text ?? '' };
        // The core re-probes right after a clamp stop when the machine can;
        // no probe there = nothing re-measures Z.
        if (next?.kind !== 'probe') stop.warning = CLAMP_NO_ZCHECK;
      }
    } else if (m.kind === 'change') {
      stop = { at: i, kind: 'cutter', cutter: m.text ?? '' };
    } else if (m.kind === 'zero') {
      // A hand zero with no cutter change in front of it: the core never
      // plans one, so it is shown as what it is rather than dropped.
      out.push({ at: i, kind: 'cutter', cutter: '', zero: m.text ?? '' });
      continue;
    }
    if (!stop) continue;
    if (stop.cutter !== undefined) {
      if (fitted !== undefined) stop.from = fitted;
      fitted = stop.cutter;
      if (moves[i + 1]?.kind === 'zero') {
        stop.zero = moves[i + 1].text ?? '';
        i += 1;
      }
    }
    out.push(stop);
  }
  return out;
}

/** "Change cutter: 6mm → 3mm, then set Z zero by hand" — the one line a stop is called by. */
export function stopTitle(s: ProgramStop): string {
  const cut = s.cutter ? `${s.from ? `${s.from} → ` : ''}${s.cutter}` : '';
  const head =
    s.kind === 'clamps' ? 'Move clamps' : s.kind === 'both' ? `Move clamps and change cutter: ${cut}` : cut ? `Change cutter: ${cut}` : 'Stop';
  return s.zero !== undefined ? `${head}, then set Z zero by hand` : head;
}

/** Moves already played at `progress` — the SAME formula the viewport draws with. */
export function playedCount(n: number, progress: number): number {
  return Math.min(n, Math.max(1, Math.floor(n * progress)));
}

/** Which clamp phase the playhead is in: the number of clamp stops already played. */
export function phaseAt(moves: readonly RenderMove[], played: number): number {
  let p = 0;
  for (let i = 0; i < Math.min(played, moves.length); i++) if (moves[i].kind === 'clamp') p += 1;
  return p;
}

/** The clamps standing during `phase`. A one-phase job: `report.clamps` throughout. */
export function clampsForPhase(r: Pick<Report, 'clamps' | 'clamp_phases'>, phase: number): ClampCfg[] {
  const ph = r.clamp_phases ?? [];
  if (!ph.length) return r.clamps;
  return ph[Math.min(phase, ph.length - 1)] ?? r.clamps;
}

/**
 * The clamps that moved INTO `phase` (empty for phase 0 / one-phase jobs). The
 * core plans at most one clamp move today, so every move belongs to phase 1.
 */
export function movedInto(r: Pick<Report, 'clamp_moves'>, phase: number): ClampMove[] {
  return phase === 1 ? (r.clamp_moves ?? []) : [];
}

/** "Move clamp c1 from X −10, Y 120 to X −10, Y 347.5" — one line per clamp. */
export function moveLines(moves: readonly ClampMove[], unit: Unit): string[] {
  const at = (p: [number, number]) => `X ${formatLength(p[0], unit)}, Y ${formatLength(p[1], unit)}`;
  return moves.map((m) => `Move clamp ${m.clamp} from ${at(m.from)} to ${at(m.to)}`);
}

/** Counts by kind, read off the stops. */
export function stopCounts(moves: readonly RenderMove[]): { stops: number; cutter: number; clamps: number; both: number; handZero: number; unchecked: number } {
  const s = stopsOf(moves);
  return {
    stops: s.length,
    cutter: s.filter((x) => x.kind !== 'clamps').length,
    clamps: s.filter((x) => x.kind !== 'cutter').length,
    both: s.filter((x) => x.kind === 'both').length,
    handZero: s.filter((x) => x.zero !== undefined).length,
    unchecked: s.filter((x) => x.warning !== undefined).length,
  };
}

/**
 * The bar's words: "2 cutter changes · 1 clamp move (done at a cutter change:
 * 3 stops → 2)". `plan` is the core's own before/after count.
 */
export function stopSummary(
  moves: readonly RenderMove[],
  plan?: Report['intervention_plan'],
): string {
  const c = stopCounts(moves);
  const parts = [`${c.cutter} cutter change${c.cutter === 1 ? '' : 's'}`];
  if (c.clamps) parts.push(`${c.clamps} clamp move${c.clamps === 1 ? '' : 's'}`);
  if (c.handZero) {
    const which =
      c.handZero !== c.cutter ? `${c.handZero} cutter change${c.handZero === 1 ? '' : 's'}` : c.cutter === 1 ? 'the cutter change' : 'every cutter change';
    parts.push(`Z zero set by hand after ${which} (no Z probe)`);
  }
  let s = parts.join(' · ');
  if (plan && plan.merged > 0) s += ` (${plan.merged} done at a cutter change: ${plan.stops_unmerged} stops → ${plan.stops})`;
  return s;
}
