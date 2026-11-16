// EVERY PCB, FOR THE DESIGNS PAGE — founder 2026-10-15: *"load all pcbs into the
// design, able to open only with pnp"*. The list is DISCOVERED from `pcb`'s tree
// (`boards.ts`), never typed in. A card opens its board with `openInPnp(id)`
// (`pnpHandoff.ts`) and nothing else: a PCB is not a cad, cnc or 3d design.
//
// Each board's CPL is read to describe it (part count, sides) and to draw its
// thumbnail; a board whose files will not load is still LISTED, with the reason
// as its detail and no thumbnail, rather than silently dropped — a list that
// shrinks when a file breaks reads as "that board does not exist".

import { BOARDS, loadBoard } from './boards';
import { boardModel, boardThumbnailSvg } from './boardModel';
import { boardParts, countLine } from './parts';
import { retiredLabel } from './retired';

export interface PcbCard {
  id: string;
  name: string;
  detail: string;
  thumbnail?: string;
  /** Set when pcb has retired the board; the card must show it (`retired.ts`). */
  retired?: string;
}

let cache: Promise<PcbCard[]> | null = null;

export function listPcbBoards(): Promise<PcbCard[]> {
  cache ??= Promise.all(
    BOARDS.map(async (b): Promise<PcbCard> => {
      try {
        const l = await loadBoard(b, { kicad: false });
        const m = boardModel(l.cpl);
        // Every BOM part, by who fits it — not only the CPL's machine-placed rows
        // (founder, on buck48_05: "there are only 5 components needed?").
        const bp = boardParts({ bom: l.bom, cpl: l.cpl, sidecar: l.sidecar });
        return {
          id: b.id,
          name: b.id,
          detail: `PCB · ${countLine(bp)} · ${b.cplPath}`,
          thumbnail: m.parts.length ? boardThumbnailSvg(m) : undefined,
          ...(b.retired ? { retired: `${retiredLabel(b.retired)} · ${b.retired.marker}` } : {}),
        };
      } catch (e) {
        return { id: b.id, name: b.id, detail: `PCB · could not read: ${(e as Error).message}`, ...(b.retired ? { retired: `${retiredLabel(b.retired)} · ${b.retired.marker}` } : {}) };
      }
    })
  );
  return cache;
}
