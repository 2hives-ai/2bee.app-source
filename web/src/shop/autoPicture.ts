// A default picture for a saved design that has none.
//
// Founder 2026-11-19: "make sure there is a default thumbnail". A Mine card
// showed "no picture" until the user opened the 3D viewer and saved one. This
// draws one from the mesh the design was SAVED WITH (the same triangles cnc
// cuts from), so a picture exists the moment the card does.
//
// WHAT IT IS: a flat-shaded isometric view of those triangles, painted
// back-to-front on a 2D canvas. One colour, no materials, no parts colouring.
// The card labels it "default picture" so it is never read as the user's own.
// WHAT IT IS NOT: the viewer's render. No WebGL, no lighting model beyond one
// directional light, and a mesh too big to sort quickly gets no picture
// rather than a slow page.

import { THUMB_H, THUMB_W } from '../cnc/thumbnail';

/** Above this many triangles the card keeps "no picture" (sorting cost on the main thread). */
export const AUTO_MAX_TRIANGLES = 200_000;

export interface Face2D {
  /** Screen points (x, y), already fitted into the picture with a margin. */
  pts: [number, number, number, number, number, number];
  /** 0..1 brightness from one fixed light. */
  shade: number;
  /** Distance from the viewer; larger is further. Faces are painted in descending order. */
  depth: number;
}

/** Project triangles (9 floats each) to an isometric view, fit into w×h, and
 *  return them sorted for painting (furthest first). Back faces are dropped.
 *  Pure, so it is tested in node; `meshPicture` paints the result. */
export function projectIso(positions: Float32Array, w = THUMB_W, h = THUMB_H, margin = 16): Face2D[] {
  const n = Math.floor(positions.length / 9);
  // Isometric: turn 45° about Z, then tilt the view down 35.264° (arctan 1/√2).
  const cz = Math.SQRT1_2, sz = Math.SQRT1_2;
  const tilt = Math.atan(Math.SQRT1_2);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const view = (x: number, y: number, z: number): [number, number, number] => {
    const xr = x * cz - y * sz;
    const yr = x * sz + y * cz;
    // screen x = xr; screen y (up) = z*ct - yr*st; depth = yr*ct + z*st (into the screen)
    return [xr, z * ct - yr * st, yr * ct + z * st];
  };
  const light = (() => {
    const l = [0.35, 0.55, 0.76];
    const k = Math.hypot(l[0], l[1], l[2]);
    return [l[0] / k, l[1] / k, l[2] / k];
  })();
  const raw: { p: number[]; shade: number; depth: number }[] = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const a = view(positions[o], positions[o + 1], positions[o + 2]);
    const b = view(positions[o + 3], positions[o + 4], positions[o + 5]);
    const c = view(positions[o + 6], positions[o + 7], positions[o + 8]);
    // Normal in view space; the viewer looks along -depth, so a face points at it when nz < 0.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    nx /= len; ny /= len; nz /= len;
    if (nz > 0) continue; // back face
    const lambert = Math.max(0, nx * light[0] + ny * light[1] - nz * light[2]);
    raw.push({ p: [a[0], a[1], b[0], b[1], c[0], c[1]], shade: 0.25 + 0.75 * lambert, depth: (a[2] + b[2] + c[2]) / 3 });
    for (const [x, y] of [a, b, c]) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!raw.length) return [];
  const k = Math.min((w - 2 * margin) / Math.max(x1 - x0, 1e-9), (h - 2 * margin) / Math.max(y1 - y0, 1e-9));
  const ox = (w - (x1 - x0) * k) / 2, oy = (h - (y1 - y0) * k) / 2;
  const sx = (x: number) => ox + (x - x0) * k;
  const sy = (y: number) => h - (oy + (y - y0) * k); // canvas y grows downwards
  raw.sort((p, q) => q.depth - p.depth);
  return raw.map((f) => ({
    pts: [sx(f.p[0]), sy(f.p[1]), sx(f.p[2]), sy(f.p[3]), sx(f.p[4]), sy(f.p[5])],
    shade: f.shade,
    depth: f.depth,
  }));
}

/** Paint the mesh to a PNG data URL, or null (no canvas, empty mesh, too big). */
export function meshPicture(positions: Float32Array): string | null {
  if (positions.length / 9 > AUTO_MAX_TRIANGLES) return null;
  if (typeof document === 'undefined') return null;
  const faces = projectIso(positions);
  if (!faces.length) return null;
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = THUMB_H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#eef1ee';
  g.fillRect(0, 0, THUMB_W, THUMB_H);
  for (const f of faces) {
    // Warm grey-amber; brightness carries the shape.
    const r = Math.round(70 + 150 * f.shade), gg = Math.round(62 + 128 * f.shade), b = Math.round(48 + 92 * f.shade);
    g.fillStyle = `rgb(${r},${gg},${b})`;
    g.strokeStyle = g.fillStyle; // hides hairline seams between neighbours
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(f.pts[0], f.pts[1]);
    g.lineTo(f.pts[2], f.pts[3]);
    g.lineTo(f.pts[4], f.pts[5]);
    g.closePath();
    g.fill();
    g.stroke();
  }
  return c.toDataURL('image/png');
}

const cache = new Map<string, string | null>();

/** Memoised per key (callers pass id + saved time, so a re-save redraws). */
export function cachedPicture(key: string, positions: () => Float32Array | null): string | null {
  if (cache.has(key)) return cache.get(key)!;
  let url: string | null = null;
  try {
    const p = positions();
    url = p ? meshPicture(p) : null;
  } catch {
    url = null;
  }
  cache.set(key, url);
  return url;
}
