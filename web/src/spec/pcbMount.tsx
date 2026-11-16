/**
 * PcbSpec — pcb tab: the chosen board's specification; changes are copied as a
 * request to pcb. Separate from mounts.tsx because pcbSpecs/boards use Vite's
 * import.meta.glob (browser only).
 */
import { BOARDS, loadBoard } from '../pnp/boards';
import { SpecPanel } from './SpecPanel';
import { pcbOwnerSpec } from './pcbSpecs';

export function PcbSpec({ boardId }: { boardId: string }) {
  if (!boardId) return null;
  return (
    <SpecPanel
      kind="pcb"
      testid="pcb-spec"
      designKey={boardId}
      title={boardId}
      ownerKey={boardId}
      loadOwner={() => pcbOwnerSpec(boardId)}
      designSource={async () => {
        const entry = BOARDS.find((b) => b.id === boardId);
        if (!entry) return `board ${boardId}: not in the list`;
        const b = await loadBoard(entry, { kicad: false });
        return [
          `Board ${boardId} — a summary from pcb's fab files, not the schematic or layout.`,
          `Files: ${[entry.bomPath, entry.cplPath, entry.pnsPath ?? '', entry.kicadPath ?? ''].filter(Boolean).join(', ')}`,
          `----- BOM (${entry.bomPath}) -----`,
          b.bom,
          `----- placement (${entry.cplPath}) -----`,
          b.cpl,
        ].join('\n');
      }}
    />
  );
}
