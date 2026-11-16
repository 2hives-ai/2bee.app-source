/**
 * The core's skipped-pocket warnings (core/src/job.rs, founder 2026-10-16), read
 * back out of the plan notes:
 *   "⚠ WARNING — <op>: NO TOOL IN THIS LIBRARY CAN CUT THIS POCKET. … SKIPPED (NOT cut) …
 *    … can cut it: '<tool id>' — …"
 * `tool` is null when the core found no cutter at all, catalogue or generic.
 */
export interface CncWarning {
  op: string;
  tool: string | null;
  text: string;
}

export function cncWarnings(notes: readonly string[]): CncWarning[] {
  const out: CncWarning[] = [];
  for (const n of notes) {
    const m = /^⚠ WARNING — (.+?): .*SKIPPED \(NOT cut\)/.exec(n);
    if (!m) continue;
    const t = /can cut it: '([^']+)'/.exec(n);
    out.push({ op: m[1], tool: t ? t[1] : null, text: n });
  }
  return out;
}
