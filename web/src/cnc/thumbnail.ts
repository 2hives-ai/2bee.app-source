/**
 * A design's thumbnail, captured from the cnc 3D view (founder 2026-10-15: "on
 * cnc able to save the thumbnail for design (colored)").
 *
 * The cnc Viewport renders with `preserveDrawingBuffer: true`, so its canvas can
 * be read back after a frame. The picture is scaled into 384 × 288 (the
 * catalogue thumbnail size, web/public/shop/t/*.png) keeping its aspect, and
 * stored per design name in this browser. The design page reads it with
 * `readThumbnail`. It is a PICTURE of the cnc view (sheet, toolpath colours),
 * not a render of the part, and the card should say where it came from.
 */
export const THUMB_PREFIX = '2bee.app.thumb.';
export const THUMB_W = 384;
export const THUMB_H = 288;

export function captureCanvas(src: HTMLCanvasElement): string | null {
  if (!src.width || !src.height) return null;
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = THUMB_H;
  const g = c.getContext('2d');
  if (!g) return null;
  const k = Math.max(THUMB_W / src.width, THUMB_H / src.height);
  const w = src.width * k, h = src.height * k;
  g.drawImage(src, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
  return c.toDataURL('image/png');
}

/** Store it; false when the browser refused (quota, storage disabled). */
/** Fired on `window` after every successful save, detail `{ key }`. A card that
 *  shows a saved picture listens to it, so a picture saved in the 3D viewer
 *  replaces the card's picture at once (founder 2026-11-19: "save thumbnail ->
 *  image is not updated on the main screen"). */
export const THUMB_SAVED_EVENT = '2bee-thumb-saved';

export function saveThumbnail(design: string, dataUrl: string): boolean {
  try {
    globalThis.localStorage?.setItem(THUMB_PREFIX + design, JSON.stringify({ dataUrl, savedAt: Date.now(), from: 'cnc' }));
    try {
      globalThis.dispatchEvent?.(new CustomEvent(THUMB_SAVED_EVENT, { detail: { key: design } }));
    } catch {
      /* no window (node): the save itself succeeded */
    }
    return true;
  } catch {
    return false;
  }
}

export function readThumbnail(design: string): { dataUrl: string; savedAt: number; from: string } | null {
  try {
    const raw = globalThis.localStorage?.getItem(THUMB_PREFIX + design);
    if (!raw) return null;
    const v = JSON.parse(raw) as { dataUrl?: unknown; savedAt?: unknown; from?: unknown };
    return typeof v.dataUrl === 'string' && v.dataUrl.startsWith('data:image/')
      ? { dataUrl: v.dataUrl, savedAt: Number(v.savedAt) || 0, from: String(v.from ?? '') }
      : null;
  } catch {
    return null;
  }
}
