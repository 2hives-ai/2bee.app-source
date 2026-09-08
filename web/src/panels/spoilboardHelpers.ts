/**
 * Spoilboard layout helpers — pure, no React state.
 *
 * Extracted from App.tsx to reduce file size.
 * These functions decide where to place a spoilboard on the machine.
 */

import { formatLength, formatLengthPair, type Unit } from '../units';

/** Spoilboard ID prefixes. */
export const SPOILBOARD_CUSTOM = 'custom';
export const SPOILBOARD_SAVED_PREFIX = 'saved:';

export function isMeasuredBoardId(id: string): boolean {
  return id === SPOILBOARD_CUSTOM || id.startsWith(SPOILBOARD_SAVED_PREFIX);
}

/** The name a saved-board picker id carries. `''` for anything else. */
export function savedBoardName(id: string): string {
  return id.startsWith(SPOILBOARD_SAVED_PREFIX) ? id.slice(SPOILBOARD_SAVED_PREFIX.length) : '';
}

export type ReachVerdict = { covers: boolean; short: string | null; overhang: string | null };

export function spoilboardReachVerdict(
  sizeX: number,
  sizeY: number,
  travelX: number,
  travelY: number,
  /* 🔴 THE DISPLAY UNIT, THREADED IN — TODO #109. This function BUILDS A
   * SENTENCE, so it is a rendering site even though it is not JSX, and a
   * rendering site that cannot see the unit is a millimetre leaking into an inch
   * screen with no way for the caller to fix it. The arithmetic above is
   * untouched and stays in millimetres; only the two `formatLength` calls know
   * the unit exists. */
  unit: Unit
): ReachVerdict {
  const shortX = travelX - sizeX;
  const shortY = travelY - sizeY;
  const shorts = [
    ...(shortX > 0 ? [`${formatLength(shortX, unit)} short in X`] : []),
    ...(shortY > 0 ? [`${formatLength(shortY, unit)} short in Y`] : []),
  ];
  const overs = [
    ...(shortX < 0 ? [`${formatLength(-shortX, unit)} past the reach in X`] : []),
    ...(shortY < 0 ? [`${formatLength(-shortY, unit)} past the reach in Y`] : []),
  ];
  return {
    covers: shorts.length === 0,
    short: shorts.length ? shorts.join(' and ') : null,
    overhang: overs.length ? overs.join(' and ') : null,
  };
}

/**
 * **Fit a board of this size onto this machine — an ASSUMED corner, never a
 * measurement.**
 *
 * Founder, 2026-08-10: *"fit the spoil board on the table when I select one"*
 * and *"automatically fill out and position the spoil board"*. Selecting a
 * board is therefore the moment its position is decided, and this is the
 * arithmetic that decides it.
 *
 * 🔴 WHAT COMES OUT OF HERE IS AN ASSUMPTION AND MUST NEVER RENDER AS A
 * MEASUREMENT. `core/src/types.rs` states the hazard in as many words: *"a
 * board is bolted where the T-slots let it go, and a 20mm offset is 20mm of
 * bare rail that the old depth-only check called spoilboard"*. Nothing in this
 * program can see a T-slot. Every caller therefore carries the provenance —
 * `assumed` versus `entered` — through to the panel, the counters and the
 * viewport, and a count qualified by an assumed position is never painted the
 * green that means "checked and clear".
 *
 * ⚠ AND NOTE WHICH WAY RULE (1) FAILS. Placing the board under the cuts is the
 * PERMISSIVE placement: it puts declared sacrificial material exactly where the
 * program goes through, so `past_spoilboard_edge` comes back `0` close to by
 * construction. It is used because the founder asked for it and because it is
 * the placement an operator actually satisfies in the shop — but it is the
 * reason the ASSUMED tag exists, and the reason rule (2) is the fallback rather
 * than the other way round.
 *
 * TWO RULES, and the one that was used is reported:
 *
 * 1. **contains the work** — when a program is loaded and the board is big
 *    enough to span it: centred on the **cut extent in machine coordinates**,
 *    taken from `Report.render`, which the core has already placed. It is not
 *    re-derived from the sheet datum and rotation — the last time this app
 *    rebuilt a placement rule in TypeScript the copy was orientation-blind.
 *    Rapids, probes and tool changes are excluded: sacrificial material is
 *    needed where material is REMOVED.
 *    ⚠ It spans the CUTS and not the sheet's full footprint, so a board fitted
 *    this way may not physically support the whole sheet.
 * 2. **centred in the travel envelope** — when there is no program, or when the
 *    board is SMALLER THAN THE JOB. The second case is a refusal of rule (1)
 *    with its reason reported, never a silent shrink or a nudge: a board that
 *    cannot span the cuts is placed symmetrically instead, which claims less
 *    material under the work and therefore reports the overhang as the real red
 *    it is.
 *
 * Both rules clamp the same way: a board SMALLER than the reach is kept inside
 * the travel envelope; a board BIGGER than it is kept to the range that still
 * spans the reach.
 */
export type SpoilboardFit = {
  x: number;
  y: number;
  /** Which rule placed it — shown to the operator, never inferred by them. */
  rule: 'contains the work' | 'centred in the travel envelope';
  /** Why rule (1) was not used, when it was not. `null` when it was. */
  why: string | null;
};

export function fitSpoilboard(
  moves: { kind: string; x: number; y: number }[],
  sizeX: number,
  sizeY: number,
  travelX: number,
  travelY: number,
  /* 🔴 DISPLAY ONLY — TODO #109, and it reaches `why` and NOTHING ELSE. The
   * returned `x`/`y` are the corner this app would store, so they stay
   * millimetres and stay whole (see the rounding above, which is a provenance
   * signal and not a precision choice). If a unit ever reaches those two
   * numbers, an assumed corner starts arriving at the machine in the wrong
   * place. */
  unit: Unit
): SpoilboardFit | null {
  if (!(sizeX > 0) || !(sizeY > 0)) return null;
  // Whole millimetres, everywhere. A fitted corner offered to 0.1mm would look
  // like something somebody measured with a tape, which is the one impression
  // it must not give.
  const clamp = (v: number, size: number, travel: number) =>
    Math.round(size <= travel ? Math.min(Math.max(v, 0), travel - size) : Math.min(Math.max(v, travel - size), 0));
  /* 🔴 THE CHOICE IS PER AXIS, and that is not a refinement for its own sake.
   * On an axis where the board is at least as long as the reach, centring it on
   * the WORK buys nothing — the whole axis is covered either way — and it puts
   * the board somewhere lopsided that no operator would bolt it. On an axis
   * where the board is SHORTER than the reach, the work is the only thing worth
   * centring on, because that is the axis where some reachable coordinate is
   * going to be bare and it matters which one. */
  const centreOn = (min: number, span: number, size: number, travel: number, haveWork: boolean) =>
    size >= travel || !haveWork
      ? clamp((travel - size) / 2, size, travel)
      : clamp(min - (size - span) / 2, size, travel);

  const CUTTING = new Set(['cut', 'tab', 'drill']);
  const pts = moves.filter(
    (m) => CUTTING.has(m.kind) && Number.isFinite(m.x) && Number.isFinite(m.y)
  );
  if (!pts.length) {
    return {
      x: centreOn(0, 0, sizeX, travelX, false),
      y: centreOn(0, 0, sizeY, travelY, false),
      rule: 'centred in the travel envelope',
      why: 'no program is loaded, so there is no work to centre it on',
    };
  }
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  const y1 = Math.max(...pts.map((p) => p.y));
  const tooSmall = x1 - x0 > sizeX || y1 - y0 > sizeY;
  if (tooSmall) {
    return {
      x: centreOn(0, 0, sizeX, travelX, false),
      y: centreOn(0, 0, sizeY, travelY, false),
      rule: 'centred in the travel envelope',
      why:
        `this board is SMALLER THAN THE JOB — the cuts span ` +
        `${formatLengthPair(x1 - x0, y1 - y0, unit)} and the board is ` +
        `${formatLengthPair(sizeX, sizeY, unit)} — so no position ` +
        `puts sacrificial material under all of it. It was centred in the travel envelope ` +
        `instead of being shuffled to hide the overhang: choose a bigger board, move the work, ` +
        `or accept that part of this program cuts over bare machine.`,
    };
  }
  const spansBoth = sizeX >= travelX && sizeY >= travelY;
  return {
    x: centreOn(x0, x1 - x0, sizeX, travelX, true),
    y: centreOn(y0, y1 - y0, sizeY, travelY, true),
    rule: spansBoth ? 'centred in the travel envelope' : 'contains the work',
    why: spansBoth
      ? 'the board is at least as big as the reach on both axes, so centring it on the work would move it without covering anything more'
      : null,
  };
}
