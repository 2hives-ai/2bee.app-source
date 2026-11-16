// The forced air cut's PROGRAM: the job's own program, lifted clear of the
// workpiece, with the spindle starts taken out.
//
// 🔴 THE DEFECT THIS REPLACES (journey test 2026-10-15, _WORKING.md item 4):
// the air cut streamed the IDENTICAL program — spindle on, no Z lift — and
// relied on a printed instruction ("raise Z zero by 25 mm") that was never
// checked against how deep the program goes. A 30 mm-deep program with a 25 mm
// lift air-cuts 5 mm INTO the workpiece with the spindle running. On the
// simulated machine that is invisible; on a router it is the first cut.
//
// What this does, on the emitted lines and nothing else:
//   · every `M3`/`M4` line (spindle start) is replaced by a comment;
//   · every Z word is raised by `lift`, where lift is chosen FROM THE PROGRAM:
//     the lowest Z it commands, plus a clearance, never less than the old
//     25 mm. So the lowest point of the air cut is at least
//     `AIR_CUT_CLEARANCE_MM` above the TOP OF THE WORKPIECE.
//
// 🔴 REFUSE RATHER THAN APPROXIMATE. A Z word can only be raised safely when it
// is an ABSOLUTE work coordinate in millimetres. Anything that breaks that is
// refused BY LINE, never rewritten: inch mode (G20), machine coordinates
// (G53), G92, return-to-reference (G28/G30), canned cycles (G81–G89: their R
// plane is a Z too), absolute arc centres (G90.1), a G10 other than the post's
// `G10 L20 P1`, a probe to an absolute target, and a spindle word on a line
// that also moves. Z words in G91 (distances) are left as they are — see `scan`.
//
// 🔴 "CLEAR OF THE WORKPIECE" NEEDS TO KNOW WHERE ITS TOP IS. That is read
// from the core's setup facts for THIS program (`z_datum`): the emitted Z of
// the workpiece top when the core states it, else 0 for a declared workpiece-
// top datum. Anything else is refused, not lifted by a guess.
//
// ⚠ What this does NOT check: that the lifted program stays inside the
// machine's Z travel. The simulated machine has no Z limit to hit; on a real
// router the top of travel is the next thing to check, and this file does not
// know it. Real machines cannot run at all today (safety.ts, ops H5).

// ⚠ A READER OF THE G-CODE DIALECT (tests/dialect-readers.test.ts). Its word
// rule follows `feeds::word_value_at` (a value may follow its letter after
// spaces: `F 5000`) and its comment rule `feeds::strip_comments` (`( … )` and
// `; …` removed before any word is read, so a Z in comment prose is not a Z).

import type { SetupFacts } from '../cam';

/** The old fixed lift. The lift is never less than this. */
/**
 * Whether a declared Z datum is the WORKPIECE top. 🔴 One test for every reader: "spoilboard
 * top" also contains "top", and `includes('top')` in the guided steps and the Make checklist
 * told the operator to zero on the workpiece for a program zeroed on the spoilboard — every cut
 * one workpiece thickness too shallow (bughunt 2026-11-15).
 */
export function isWorkpieceTopDatum(declared: string): boolean {
  return /^\s*(workpiece top|top of the workpiece)\b/i.test(declared);
}

export const AIR_CUT_MIN_LIFT_MM = 25;
/** The lowest point of the air cut stays at least this far above Z zero. */
export const AIR_CUT_CLEARANCE_MM = 5;

export type AirCut =
  | { ok: true; lines: string[]; lift: number; lowestZ: number; lowestLifted: number; spindleLinesRemoved: number }
  | { ok: false; why: string };

/** The code part of a line: comments `( … )` and `; …` removed. */
function codeOf(line: string): string {
  return line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
}

const WORD = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi;

function words(code: string): { letter: string; value: number; raw: string }[] {
  const out: { letter: string; value: number; raw: string }[] = [];
  for (const m of code.matchAll(WORD)) out.push({ letter: m[1].toUpperCase(), value: Number(m[2]), raw: m[2] });
  return out;
}

const REFUSED_G: readonly [RegExp, string][] = [
  [/^20(\.0*)?$/, 'G20 (inches): the lift is in millimetres'],
  [/^53(\.0*)?$/, 'G53 (machine coordinates): not shifted by work zero'],
  [/^92(\.\d*)?$/, 'G92 (offsets set from the program)'],
  [/^2[89](\.\d*)?$/, 'G28/G29 (move to a stored machine position)'],
  [/^30(\.\d*)?$/, 'G30 (move to a stored machine position)'],
  [/^8[1-9](\.\d*)?$/, 'a canned cycle (its R plane is a Z too)'],
  [/^90\.1$/, 'G90.1 (absolute arc centres)'],
];

const fmt = (v: number) => v.toFixed(3);
const gnum = (raw: string) => raw.replace(/^0+(?=\d)/, '');

/**
 * One pass over the program with the distance mode tracked. Returns the
 * refusal, or the lowest ABSOLUTE Z and, per line, whether its Z is to be
 * raised.
 *
 * 🔴 THE TOUCH-PLATE BLOCK IS READ, NOT REFUSED (found by journey J9, the
 * core-planned program): the post probes Z as `G91` → `G38.2 Z-…` → `G0 Z…`
 * → `G38.2 Z-…` → `G90` → `G10 L20 P1 Z<top>` (`post_grblhal.rs`). Its Z
 * words are DISTANCES (G91) or a statement of where the tip IS (G10 L20), so
 * none of them is raised; every absolute move after the G10 is raised from the
 * datum the probe set, so the lift holds. The probe still descends to the plate
 * during the air cut — with the spindle off (the post asserts M5 first) — which
 * is the probe it will do for the cut, watched.
 */
function scan(lines: readonly string[]): { ok: false; why: string } | { ok: true; lowest: number; raise: boolean[] } {
  let incremental = false;
  let lowest = Infinity;
  const raise: boolean[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ws = words(codeOf(lines[i]));
    const refuse = (what: string) => ({ ok: false as const, why: `Line ${i + 1} ("${lines[i].trim()}") uses ${what}. The air cut is refused rather than lifted by a guess.` });
    let g10 = false;
    let probe = false;
    for (const w of ws) {
      if (w.letter !== 'G') continue;
      const n = gnum(w.raw);
      const hit = REFUSED_G.find(([re]) => re.test(n));
      if (hit) return refuse(hit[1]);
      if (/^91(\.0*)?$/.test(n)) incremental = true;
      if (/^90(\.0*)?$/.test(n)) incremental = false;
      if (/^10(\.0*)?$/.test(n)) g10 = true;
      if (/^38\.\d+$/.test(n)) probe = true;
    }
    if (g10) {
      const L = ws.find((w) => w.letter === 'L')?.value;
      const P = ws.find((w) => w.letter === 'P')?.value;
      if (L !== 20 || (P !== undefined && P !== 1) || incremental) return refuse('G10 other than "G10 L20 P1" in absolute mode');
    }
    if (probe && !incremental) return refuse('G38 (probing) to an ABSOLUTE target, which a lift would move');
    const spindle = ws.some((w) => w.letter === 'M' && (w.value === 3 || w.value === 4));
    if (spindle && ws.some((w) => 'XYZIJKG'.includes(w.letter))) {
      return { ok: false, why: `Line ${i + 1} ("${lines[i].trim()}") starts the spindle on a line that also moves or sets a mode. The air cut is refused rather than edited.` };
    }
    const z = ws.find((w) => w.letter === 'Z');
    const up = !!z && !incremental && !g10;
    if (up) lowest = Math.min(lowest, z!.value);
    raise.push(up);
  }
  if (!Number.isFinite(lowest)) return { ok: false, why: 'The program has no absolute Z move, so there is nothing to lift.' };
  return { ok: true, lowest, raise };
}

/**
 * The air-cut program for `lines`, or why there cannot be one.
 * `facts` must be the setup facts read off THIS program.
 */
export function airCutProgram(lines: readonly string[], facts: Pick<SetupFacts, 'z_datum'> | null): AirCut {
  if (!facts) return { ok: false, why: 'The setup facts could not be read for this program, so nothing says where Z zero is.' };
  /* The core states the emitted Z of the workpiece top (setup.rs ZDatumFact);
   * `cam.ts`'s type does not list it yet, so it is read defensively. Without
   * it, only a declared WORKPIECE-top datum (top = 0) is accepted — "spoilboard
   * top" also contains the word "top", and must not pass on it. */
  const topField = (facts.z_datum as { workpiece_top_emitted_z_mm?: unknown }).workpiece_top_emitted_z_mm;
  let top: number;
  if (typeof topField === 'number' && Number.isFinite(topField)) top = topField;
  else if (isWorkpieceTopDatum(facts.z_datum.declared)) top = 0;
  else {
    return { ok: false, why: `Z zero is "${facts.z_datum.declared}" and the facts do not say where the workpiece top is, so this app cannot say how high the air cut must be lifted.` };
  }
  const sc = scan(lines);
  if (!sc.ok) return sc;
  const lowest = sc.lowest;
  const lift = Math.max(AIR_CUT_MIN_LIFT_MM, Math.ceil(top + AIR_CUT_CLEARANCE_MM - lowest));
  let removed = 0;
  const out = lines.map((line, i) => {
    const ws = words(codeOf(line));
    if (ws.some((w) => w.letter === 'M' && (w.value === 3 || w.value === 4))) {
      removed += 1;
      return '( AIR CUT: spindle start removed )';
    }
    if (!sc.raise[i]) return line;
    // Raise the Z word in the code part only; comments are kept as they are.
    return line.replace(/(\([^)]*\))|(;.*$)|([Zz]\s*)([-+]?(?:\d+\.?\d*|\.\d+))/g, (m, paren, semi, z, v) =>
      paren || semi ? m : `${z.trim()}${fmt(Number(v) + lift)}`,
    );
  });
  return { ok: true, lines: ['( AIR CUT: Z raised ' + fmt(lift) + ' mm, spindle starts removed )', ...out], lift, lowestZ: lowest, lowestLifted: lowest + lift, spindleLinesRemoved: removed };
}
