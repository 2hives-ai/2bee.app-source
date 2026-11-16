/**
 * A PCB's saved picture — founder 2026-10-16: *"when I open the pcb in 3d view
 * able to save the thumbnail"*.
 *
 * Same store as a design's picture (`cnc/thumbnail.ts`, localStorage
 * `2bee.app.thumb.<key>`), under the key `pcb:<boardId>`. The `pcb:` prefix keeps
 * a board from ever reading a design's picture: catalogue design keys are paths
 * and saved-model keys are names, and a board id like `sensor_pod` could be either.
 *
 * It is a PICTURE of this app's 3D view of pcb's fab files, in this browser
 * only, not a photo of a built board — the card labels it "your picture".
 */
import { readThumbnail, saveThumbnail } from '../cnc/thumbnail';

export const PCB_THUMB_PREFIX = 'pcb:';

export function pcbThumbKey(boardId: string): string {
  return PCB_THUMB_PREFIX + boardId;
}

export function savedPcbPicture(boardId: string): { dataUrl: string } | null {
  if (!boardId) return null;
  return readThumbnail(pcbThumbKey(boardId));
}

/** True only when the picture READS BACK: `saveThumbnail` reports success when there
 *  is no storage at all (optional chaining), and "Thumbnail saved" must not lie. */
export function savePcbPicture(boardId: string, dataUrl: string): boolean {
  if (!boardId) return false;
  return saveThumbnail(pcbThumbKey(boardId), dataUrl) && savedPcbPicture(boardId)?.dataUrl === dataUrl;
}
