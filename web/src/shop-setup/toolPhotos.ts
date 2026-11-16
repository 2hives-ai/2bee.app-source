/* toolPhotos.ts — ONE PHOTO PER REGISTERED CUTTER, IN THIS BROWSER ONLY.
 *
 * Founder, 2026-10-14: *"make a photo of all tools what will be registered to
 * the system"*.
 *
 * ── WHERE THE PHOTOS LIVE, AND WHY NOT IN store.ts ─────────────────────────
 *
 * IndexedDB, in a database of their own (`2bee.app-tool-photos`), keyed by the
 * tool id the registry uses. Not localStorage: a phone photo, even downscaled,
 * is tens to hundreds of kB and localStorage fails by THROWING when its ~5 MB is
 * full.
 *
 * Not a collection in `store.ts`, deliberately. Adding one there is a schema
 * change (a `DB_VERSION` bump owned by that file), and `store.ts::exportAll`
 * serialises every collection with `JSON.stringify`, which turns a `Blob` into
 * `{}` — an export would then carry an empty object per photo and look like it
 * had backed them up. So:
 *
 *   🔴 THE STORE EXPORT CARRIES THE TOOL LIST AND DOES NOT CARRY THE PHOTOS.
 *   The Tools page says so. Clearing site data deletes them. They are never
 *   uploaded and never reach another device.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * Nothing reads a STORED photo. No measurement is taken from it and it is not
 * sent anywhere; it is for a human to recognise which cutter is which.
 * (2026-10-15: the Add form's "Photo the cutter" sends its OWN photo to the AI —
 * `toolPhotoAsk.ts` — before registration. That photo is stored here only once
 * the cutter is registered, and it is never sent again from here.)
 */

/** Storage for photos, injectable so node tests run without IndexedDB. */
export interface ToolPhotoStore {
  get(id: string): Promise<Blob | null>;
  put(id: string, photo: Blob): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Longest edge after downscaling, px. */
export const PHOTO_MAX_EDGE = 1024;
/** JPEG quality for the stored copy. */
export const PHOTO_JPEG_QUALITY = 0.8;

/**
 * Target size for a downscale: fit within `max` on the long edge, keep the
 * aspect ratio, never upscale. Whole pixels, at least 1.
 *
 * Refuses a non-positive or non-finite size rather than inventing one — an image
 * that reports 0×0 is a decode failure, not a 1×1 photo.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number = PHOTO_MAX_EDGE
): { width: number; height: number; scaled: boolean } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`the image reports a size of ${width}×${height}, so it could not be read`);
  }
  if (!(max > 0)) throw new Error(`max edge must be positive, got ${max}`);
  const long = Math.max(width, height);
  if (long <= max) return { width: Math.round(width), height: Math.round(height), scaled: false };
  const k = max / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
    scaled: true,
  };
}

/**
 * Downscale an image file in the browser to a JPEG Blob. Browser-only (canvas,
 * `createImageBitmap`). `imageOrientation: 'from-image'` applies the phone's
 * EXIF rotation, so a portrait photo is stored upright.
 */
export async function downscaleImage(
  file: Blob,
  max: number = PHOTO_MAX_EDGE,
  quality: number = PHOTO_JPEG_QUALITY
): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitWithin(bmp.width, bmp.height, max);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser gave no 2D canvas, so the photo could not be resized');
    ctx.drawImage(bmp, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('the resized photo could not be encoded as JPEG'))),
        'image/jpeg',
        quality
      )
    );
  } finally {
    bmp.close();
  }
}

/** In-memory store, for tests and for a browser where IndexedDB will not open. */
export function memoryPhotoStore(): ToolPhotoStore & { size(): number } {
  const m = new Map<string, Blob>();
  return {
    async get(id) {
      return m.get(id) ?? null;
    },
    async put(id, photo) {
      m.set(id, photo);
    },
    async delete(id) {
      m.delete(id);
    },
    size: () => m.size,
  };
}

const PHOTO_DB = '2bee.app-tool-photos';
const PHOTO_STORE = 'photos';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** The real store: IndexedDB, one object store, key = tool id, value = Blob. */
export function indexedDbPhotoStore(): ToolPhotoStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('this browser has no IndexedDB, so photos cannot be kept'));
        return;
      }
      const open = indexedDB.open(PHOTO_DB, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(PHOTO_STORE)) open.result.createObjectStore(PHOTO_STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('IndexedDB would not open'));
    }));
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(PHOTO_STORE, mode).objectStore(PHOTO_STORE);
  return {
    async get(id) {
      const v = await req((await tx('readonly')).get(id));
      return v instanceof Blob ? v : null;
    },
    async put(id, photo) {
      await req((await tx('readwrite')).put(photo, id));
    },
    async delete(id) {
      await req((await tx('readwrite')).delete(id));
    },
  };
}
