// RETIRED BOARDS (pcb ticket 2026-11-12-19-43-40): a board `pcb` has retired must not look like a live one.
// The marker files are the source of truth and `pcb` owns them; nothing here lists boards by name:
//   hardware/pcb/<board>/_SUPERSEDED.md              the board is replaced by another
//   hardware/pcb/<board>/fab/[<sub>/]_DO-NOT-ORDER*  its fab files must not be ordered
// A DO-NOT-ORDER in fab/ covers every split sub-board under it; one in fab/<sub>/ covers that sub-board only.
// Pure (node tests import it); `boards.ts` feeds it the marker paths from `import.meta.glob`.

export interface Retired {
  /** Repo-relative marker that retires the board. */
  marker: string;
  kind: 'superseded' | 'do-not-order';
}

/**
 * `cplPath` and `markers` are paths of one shape (both repo-relative, or both glob keys).
 * `null` when no marker applies.
 */
export function retiredBy(cplPath: string, markers: readonly string[]): Retired | null {
  const at = cplPath.indexOf('/fab/');
  if (at < 0) return null;
  const boardDir = cplPath.slice(0, at);
  const cplDir = cplPath.slice(0, cplPath.lastIndexOf('/'));
  const sup = markers.find((m) => m === `${boardDir}/_SUPERSEDED.md`);
  if (sup) return { marker: sup, kind: 'superseded' };
  const dno = markers.find((m) => {
    const dir = m.slice(0, m.lastIndexOf('/'));
    return /\/_DO-NOT-ORDER[^/]*$/.test(m) && (dir === `${boardDir}/fab` || dir === cplDir);
  });
  return dno ? { marker: dno, kind: 'do-not-order' } : null;
}

export function retiredLabel(r: Retired): string {
  return r.kind === 'superseded' ? 'RETIRED (superseded) — do not order' : 'RETIRED — do not order';
}
