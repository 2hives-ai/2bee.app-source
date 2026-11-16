/**
 * The LEFTOVER panel (founder 2026-10-16: "the leftover should show the
 * remaining panel"): the core's simulated stock surface with every part's area
 * taken out — what stays on the table once the parts are lifted off their tabs.
 *
 * Each part's outer contour minus its inner contours (even-odd) is filled into
 * the height grid, row by row (scanline), and those cells are set to `floorZ`
 * (the workpiece bottom: nothing there). Drawing only; nothing about the plan
 * changes. Arc bulges are taken as straight chords, so a curved edge can be off
 * by up to a cell plus the chord error: it is a picture, not a measurement.
 */
import type { DrawingPart, Placement2D, StockSurface } from '../cam';
import { decodeStockSurface } from '../cam';

function encode(z: Float32Array): string {
  const bytes = new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function leftoverSurface(surface: StockSurface, parts: readonly DrawingPart[], P: Placement2D | null, floorZ: number): StockSurface {
  const d = decodeStockSurface(surface);
  const z = new Float32Array(d.z_mm);
  const T = P ?? { cos: 1, sin: 0, row_y: [0, 1] as [number, number], dx_mm: 0, dy_mm: 0 };
  const toBed = (x: number, y: number): [number, number] => [T.cos * x + T.row_y[0] * y + T.dx_mm, T.sin * x + T.row_y[1] * y + T.dy_mm];
  /* Every contour edge, in grid units. Outer and inners together: even-odd fill
   * gives "outer minus holes" without telling them apart. */
  type Edge = [number, number, number, number];
  for (const part of parts) {
    const edges: Edge[] = [];
    for (const c of [part.outer, ...part.inners]) {
      const pts = c.verts.map((v) => {
        const [bx, by] = toBed(v.x, v.y);
        return [(bx - surface.origin_x_mm) / surface.cell_mm, (by - surface.origin_y_mm) / surface.cell_mm] as [number, number];
      });
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
      }
    }
    if (!edges.length) continue;
    let minR = Infinity, maxR = -Infinity;
    for (const e of edges) {
      minR = Math.min(minR, e[1], e[3]);
      maxR = Math.max(maxR, e[1], e[3]);
    }
    for (let row = Math.max(0, Math.ceil(minR)); row <= Math.min(surface.rows - 1, Math.floor(maxR)); row++) {
      const xs: number[] = [];
      for (const [x1, y1, x2, y2] of edges) {
        if ((row >= y1 && row < y2) || (row >= y2 && row < y1)) xs.push(x1 + ((row - y1) * (x2 - x1)) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]));
        const to = Math.min(surface.cols - 1, Math.floor(xs[k + 1]));
        for (let col = from; col <= to; col++) z[row * surface.cols + col] = floorZ;
      }
    }
  }
  return { ...surface, z_mm_b64: encode(z) };
}
