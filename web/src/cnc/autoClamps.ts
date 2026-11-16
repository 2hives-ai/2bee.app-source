/**
 * Clamp POSITIONS computed, not guessed (founder 2026-10-16: "add the clamps,
 * positions and when to move" / "create the clamps"). The AI may choose WHICH
 * clamp and HOW MANY; where they go is this function's: at the workpiece's edge
 * midpoints (2 = left/right, 4 = all four edges, 6 = thirds of the long edges +
 * short-edge midpoints), each footprint perpendicular to its edge, reaching
 * `REACH` mm onto the work and the rest off it. Parts are then auto-placed
 * around these keepouts and the core checks every cut and rapid against them.
 *
 * ⚠ A declared clamp is a statement that the operator WILL fit it there; cnc.run
 * makes that a step. Nothing here checks the clamp physically fits the table.
 */
import type { ClampCfg } from '../cam';

export const REACH = 30;

export function edgeClamps(
  stock: { x0: number; y0: number; w: number; h: number },
  clamp: { id: string; footprint: [number, number]; heightMm: number },
  count: 2 | 4 | 6,
): ClampCfg[] {
  const [L, W] = [Math.max(clamp.footprint[0], clamp.footprint[1]), Math.min(clamp.footprint[0], clamp.footprint[1])];
  const out: ClampCfg[] = [];
  const add = (x: number, y: number, w: number, h: number) =>
    out.push({ name: `${clamp.id}-${out.length + 1}`, x, y, w, h, height_mm: clamp.heightMm });
  const { x0, y0, w, h } = stock;
  const longIsX = w >= h;
  /* Left / right edges: long axis along X. Bottom / top: along Y. */
  const left = (yc: number) => add(x0 - (L - REACH), yc - W / 2, L, W);
  const right = (yc: number) => add(x0 + w - REACH, yc - W / 2, L, W);
  const bottom = (xc: number) => add(xc - W / 2, y0 - (L - REACH), W, L);
  const top = (xc: number) => add(xc - W / 2, y0 + h - REACH, W, L);
  if (count === 2) {
    if (longIsX) {
      bottom(x0 + w / 2);
      top(x0 + w / 2);
    } else {
      left(y0 + h / 2);
      right(y0 + h / 2);
    }
  } else {
    left(y0 + h / 2);
    right(y0 + h / 2);
    if (count === 4) {
      bottom(x0 + w / 2);
      top(x0 + w / 2);
    } else if (longIsX) {
      bottom(x0 + w / 3);
      bottom(x0 + (2 * w) / 3);
      top(x0 + w / 3);
      top(x0 + (2 * w) / 3);
    } else {
      left(y0 + h / 3);
      right(y0 + (2 * h) / 3);
      bottom(x0 + w / 2);
      top(x0 + w / 2);
    }
  }
  return out;
}
