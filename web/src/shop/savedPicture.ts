// Kept out of DesignViewer.tsx (which imports CSS) so node tests can load it.
import { readThumbnail } from '../cnc/thumbnail';

/**
 * A picture the user saved for this design, if any (`cnc/thumbnail.ts` store).
 * Keys, in order: the catalogue PATH (what cad's Save thumbnail uses for a
 * catalogue design, its selfPath), then the TITLE (a saved model's name, and
 * what pictures saved from cnc used before 2026-10-15).
 */
export function savedPicture(e: { title: string; path?: string }): { dataUrl: string } | null {
  // The third key is where the viewer saved a Mine picture BEFORE 2026-11-19 (its
  // label, not its title). Read so pictures saved then still show.
  for (const k of [e.path, e.title, `your design · ${e.title.replace(/[\\/]/g, '_')}.scad`]) {
    if (!k) continue;
    try {
      const t = readThumbnail(k);
      if (t) return t;
    } catch {
      /* storage blocked: fall back to the catalogue picture */
    }
  }
  return null;
}
