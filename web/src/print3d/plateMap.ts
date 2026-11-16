// The plate picture beside "Objects on the plate" on the printer card (founder 2026-11-13: "can I
// see the actual model?"). Top view, bed millimetres, Y up as on the printer.
//
// What it draws comes from the PRINTING FILE, not from the 3d tab: the bridge reads each object's
// footprint off the file's own extrusion (`objectFootprints`, the convex hull of its extruding
// moves) and the plate from the file's own `printable_area`. So the outline shown for "Skip" is
// the object the printer will skip — there is no matching step that could pair a row with the
// wrong part. Skip cannot be undone; a picture that might point at the wrong part would be worse
// than none.
//
// ⚠ A hull is not the part's shape: an L-shaped part draws as its convex outline, and the line
// is the wall centreline, about half a line width inside the printed edge. Enough to tell which
// part is which on the plate; not a measurement.

export interface PlateObject {
  id: number;
  name: string;
  hull?: [number, number][];
}

export interface PlateMap {
  /** SVG viewBox, in bed mm with Y flipped (SVG y = -bed y). */
  viewBox: string;
  /** The printable area as an SVG path, or null when the file does not state its printable area. */
  plate: string | null;
  shapes: { id: number; name: string; path: string; label: [number, number] }[];
  /** Objects the file gave no outline for: listed, never drawn somewhere guessed. */
  unplaced: { id: number; name: string }[];
}

const path = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${x} ${-y}`).join(' L')} Z`;

/** null when there is nothing to draw (no object has an outline). */
export function plateMap(objects: readonly PlateObject[], printableArea?: [number, number][] | null): PlateMap | null {
  const drawn = objects.filter((o) => o.hull && o.hull.length >= 3);
  if (!drawn.length) return null;
  const all = [...drawn.flatMap((o) => o.hull!), ...(printableArea ?? [])];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  // With no bed stated, the picture frames the objects; the margin keeps an edge object visible.
  const m = printableArea ? 2 : 10;
  const minX = Math.min(...xs) - m;
  const maxX = Math.max(...xs) + m;
  const minY = Math.min(...ys) - m;
  const maxY = Math.max(...ys) + m;
  return {
    viewBox: `${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`,
    plate: printableArea && printableArea.length >= 3 ? path(printableArea) : null,
    shapes: drawn.map((o) => {
      const h = o.hull!;
      const cx = h.reduce((s, p) => s + p[0], 0) / h.length;
      const cy = h.reduce((s, p) => s + p[1], 0) / h.length;
      return { id: o.id, name: o.name, path: path(h), label: [cx, -cy] as [number, number] };
    }),
    unplaced: objects.filter((o) => !(o.hull && o.hull.length >= 3)).map((o) => ({ id: o.id, name: o.name })),
  };
}
