/**
 * Boards pcb has DECLARED single-sided: all copper on the bottom, through-hole
 * bodies on the top, every joint soldered from the bottom. Their fab/ ships no
 * F_Cu / F_Mask gerber ON PURPOSE (an F.Cu gerber would hold only the THT rings
 * and make the fab build a plated 2-layer board).
 *
 * Source: pcb's ticket handover/2bee_app/_done/2026-10-16-02-46-37-pcb-real-3d-
 * bodies-on-8-fab-boards-buck48-single-sided.md, citing the founder ruling of
 * 2026-10-13 ("copper bottom, SMD bottom"), buck48_05/pcb_buck48_05.py:112-120 and
 * buck48_05/export_fab.sh:39-46 (same in buck48_24).
 *
 * ⚠ This is pcb's declaration, not something this app measured. It only explains
 * a missing TOP copper layer for THT-only top sides: an SMD part on the top of
 * one of these boards still FAILS the gate (pcbGates.ts checks that first).
 */
export const SINGLE_SIDED: Readonly<Record<string, string>> = {
  buck48_05: 'pcb 2026-10-16 (founder ruling 2026-10-13): copper bottom only; buck48_05/export_fab.sh:39-46',
  buck48_24: 'pcb 2026-10-16 (founder ruling 2026-10-13): copper bottom only; buck48_24/export_fab.sh:39-46',
};

export const SINGLE_SIDED_LABEL = 'top: no copper (single-sided board)';

/** The layer list to show in red, without the top layers a declared single-sided board omits on purpose. */
export function unexpectedMissing(boardId: string, missing: readonly string[]): string[] {
  return SINGLE_SIDED[boardId] ? missing.filter((l) => !/^F_(Cu|Mask|Paste)$/.test(l)) : [...missing];
}
