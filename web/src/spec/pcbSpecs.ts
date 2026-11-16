/**
 * pcb's functional specifications, read where pcb writes them — never copied here:
 *
 *   per-board  hardware/pcb/<board dir>/SPEC.md
 *   directory  hardware/pcb/<board dir>/*-spec.md (an older spec for the board's directory,
 *              e.g. solar_box/solar-box-spec.md) — shown as the directory's, not this board's
 *
 * The board's directory comes from its fab files (`pnp/boards.ts`), so a sub-board in
 * `fab/<sub>/` shares its directory's spec and the label says so.
 * Browser-only (`import.meta.glob`); `vite dev` serves hardware/pcb (vite.config.ts allow list).
 */
import { BOARDS } from '../pnp/boards';
import type { OwnerSpec } from './specStore';
import { boardDir, pickPcbSpec } from './pick';

const ROOT = '../../../../../hardware/pcb/';
const SPECS = import.meta.glob(['../../../../../hardware/pcb/*/SPEC.md', '../../../../../hardware/pcb/*/*-spec.md'], {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

export async function pcbOwnerSpec(boardId: string): Promise<OwnerSpec> {
  const entry = BOARDS.find((b) => b.id === boardId);
  if (!entry) return { kind: 'error', owner: 'pcb', why: `board "${boardId}" is not in the list` };
  const dir = boardDir(entry.cplPath);
  if (!dir) return { kind: 'error', owner: 'pcb', why: `cannot tell the board's directory from ${entry.cplPath}` };
  const available = Object.keys(SPECS).map((k) => `hardware/pcb/${k.slice(ROOT.length)}`);
  const pick = pickPcbSpec(dir, available);
  if (!pick) return { kind: 'none', owner: 'pcb' };
  try {
    const text = await SPECS[ROOT + pick.path.slice('hardware/pcb/'.length)]();
    return { kind: pick.kind, owner: 'pcb', path: pick.path, text, tracked: null };
  } catch (e) {
    return { kind: 'error', owner: 'pcb', why: `${pick.path}: ${(e as Error).message}` };
  }
}
