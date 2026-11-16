// The 3d tab's own layout: SEPARATE a mesh into its solids, LAY each one FLAT,
// ARRANGE them on the build plate. Founder 2026-10-16: *"separation and auto
// arrangement should happen automatically"* (and: no OrcaSlicer for the person
// to open). Pure functions over triangle soups (9 floats per triangle, mm).
//
// What each step guards, physically:
//   · separate — two solids in one file are placed, cooled and supported as ONE
//     object; a part that should stand on its own face is held up in the air
//     by its neighbour's orientation.
//   · lay flat — a part standing on an edge or a point has no first layer to
//     hold it; it is knocked over by the nozzle part-way through.
//   · arrange — two parts in the same place print as a fused lump, a part past
//     the plate edge is cut off or crashes the head. `checkLayout` re-measures
//     every arrangement after it is made, so a packer defect is a refusal, not
//     a print.
//
// What this does NOT do, on purpose:
//   · Parts that TOUCH without sharing vertices are two solids here (the weld is
//     by vertex position, not by contact). Parts that share vertices stay one.
//   · Lay flat picks a face of the MESH that the whole part rests on (a
//     supporting plane), largest contact area first. It does not reason about
//     strength along layer lines, overhangs or supports; the slicer's support
//     setting is unchanged.
//   · Arrange packs bounding rectangles in shelves (rows). It does not nest
//     shapes into each other's gaps, and it does not reserve room for a prime
//     tower: the bridge picks the tower spot around the fixed placements.
//
// 🔴 NOTHING HAS BEEN PRINTED FROM THIS. The checks below are geometry; whether
// the X2D prints the result as laid out has never been watched.

export type V3 = [number, number, number];

export interface Box3 {
  min: V3;
  max: V3;
}

export function bbox(tri: Float32Array): Box3 {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < tri.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = tri[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

export const sizeOf = (b: Box3): V3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

const r1 = (x: number) => Math.round(x * 10) / 10;
export const sizeText = (s: V3) => `${r1(s[0])} x ${r1(s[1])} x ${r1(s[2])} mm`;

/** Signed volume (divergence theorem). Its sign follows the winding; |volume| is the solid's volume when the shell is closed. */
export function volumeOf(tri: Float32Array): number {
  let v = 0;
  for (let t = 0; t + 8 < tri.length; t += 9) {
    const ax = tri[t], ay = tri[t + 1], az = tri[t + 2];
    const bx = tri[t + 3], by = tri[t + 4], bz = tri[t + 5];
    const cx = tri[t + 6], cy = tri[t + 7], cz = tri[t + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/* ════════════════════════════════════════════════════════════════════════════
 * SEPARATE
 * ══════════════════════════════════════════════════════════════════════════ */

export interface Component {
  tri: Float32Array;
  triangles: number;
  size: V3;
  /** |volume| in mm³. */
  volume: number;
  /** Why this is not a printable solid, or null. A degenerate component is never added as a part, and it is always named. */
  degenerate: string | null;
  /** Smaller than 1 mm in its largest dimension: added, and said. */
  tiny: boolean;
}

/** Vertex weld within `tol` mm: a vertex joins an earlier one when it lies within tol of it (grid + 27 neighbour cells, not rounding). */
export function weldIds(tri: Float32Array, tol = 1e-3): Int32Array {
  const n = Math.floor(tri.length / 3);
  const ids = new Int32Array(n);
  const cell = new Map<string, number[]>();
  const reps: number[] = []; // vertex index of each welded id
  const t2 = tol * tol;
  for (let i = 0; i < n; i++) {
    const x = tri[3 * i], y = tri[3 * i + 1], z = tri[3 * i + 2];
    const cx = Math.floor(x / tol), cy = Math.floor(y / tol), cz = Math.floor(z / tol);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const list = cell.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      for (const id of list) {
        const r = reps[id];
        const ex = tri[3 * r] - x, ey = tri[3 * r + 1] - y, ez = tri[3 * r + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= t2) {
          found = id;
          break;
        }
      }
    }
    if (found < 0) {
      found = reps.length;
      reps.push(i);
      const k = `${cx},${cy},${cz}`;
      const l = cell.get(k);
      if (l) l.push(found);
      else cell.set(k, [found]);
    }
    ids[i] = found;
  }
  return ids;
}

const DEGENERATE_VOLUME = 1e-3; // mm³
const TINY = 1; // mm

/**
 * Split a triangle soup into its connected solids: vertices welded within
 * `tol`, then triangles that share a welded vertex are one solid. Largest
 * (by triangle count) first. Every component is returned, degenerate ones too,
 * each with its reason; the caller decides, and says, what to do with them.
 */
export function separate(tri: Float32Array, tol = 1e-3): Component[] {
  const T = Math.floor(tri.length / 9);
  if (!T) return [];
  const vid = weldIds(tri.subarray(0, T * 9), tol);
  let nv = 0;
  for (let i = 0; i < vid.length; i++) if (vid[i] + 1 > nv) nv = vid[i] + 1;
  const par = Array.from({ length: nv }, (_, i) => i);
  const find = (a: number) => {
    while (par[a] !== a) {
      par[a] = par[par[a]];
      a = par[a];
    }
    return a;
  };
  for (let t = 0; t < T; t++) {
    const a = find(vid[3 * t]);
    par[find(vid[3 * t + 1])] = a;
    par[find(vid[3 * t + 2])] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    const r = find(vid[3 * t]);
    const g = groups.get(r);
    if (g) g.push(t);
    else groups.set(r, [t]);
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length || a[0] - b[0])
    .map((ts) => {
      const out = new Float32Array(ts.length * 9);
      ts.forEach((t, i) => out.set(tri.subarray(9 * t, 9 * t + 9), 9 * i));
      const size = sizeOf(bbox(out));
      const volume = Math.abs(volumeOf(out));
      const degenerate =
        ts.length < 4 ? `${ts.length} triangle${ts.length === 1 ? '' : 's'}: not a closed solid` : volume < DEGENERATE_VOLUME ? 'no volume: a surface, not a solid' : null;
      return { tri: out, triangles: ts.length, size, volume, degenerate, tiny: !degenerate && Math.max(...size) < TINY };
    });
}

/** One sentence about a separation, naming every degenerate and tiny component. */
export function separationText(name: string, comps: readonly Component[], partName: (k: number) => string): string {
  const good = comps.filter((c) => !c.degenerate);
  const bad = comps.map((c, k) => ({ c, k })).filter((x) => x.c.degenerate);
  const tiny = comps.map((c, k) => ({ c, k })).filter((x) => x.c.tiny);
  const head =
    comps.length <= 1
      ? `${name}: 1 object, nothing to separate.`
      : `${name}: ${comps.length} objects separated${bad.length ? `, ${good.length} added as parts` : ''}.`;
  const badText = bad.length ? ` Not added (${bad.length}): ${bad.map((x) => `${partName(x.k)} (${sizeText(x.c.size)}, ${x.c.degenerate})`).join('; ')}.` : '';
  const tinyText = tiny.length ? ` Very small, check ${tiny.length === 1 ? 'it is' : 'they are'} meant: ${tiny.map((x) => `${partName(x.k)} (${sizeText(x.c.size)})`).join('; ')}.` : '';
  return `${head}${badText}${tinyText}`;
}

/* ════════════════════════════════════════════════════════════════════════════
 * LAY FLAT
 * ══════════════════════════════════════════════════════════════════════════ */

export interface FlatResult {
  /** The part turned onto its face, with min z = 0. */
  tri: Float32Array;
  /** The face's outward normal BEFORE turning (it now points down). */
  normal: V3;
  /** Contact area of the chosen face, mm². */
  area: number;
  /** Height after turning, mm. */
  height: number;
  /** Rotation axis (unit) and angle in degrees; angle 0 = not turned. */
  axis: V3;
  angle: number;
  /** False when no face of the mesh supports the part; it is left as it came. */
  found: boolean;
  text: string;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Rotation matrix (row-major 3x3) about unit axis by angle (radians). */
export function rotMatrix(axis: V3, ang: number): number[] {
  const [x, y, z] = norm(axis);
  const c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Apply a 3x3 matrix to every vertex, then drop the part so its min z = 0 (x, y keep their box centre). */
export function transformDrop(tri: Float32Array, m: number[]): Float32Array {
  const b0 = bbox(tri);
  const cx = (b0.min[0] + b0.max[0]) / 2, cy = (b0.min[1] + b0.max[1]) / 2;
  const out = new Float32Array(tri.length);
  for (let i = 0; i + 2 < tri.length; i += 3) {
    const x = tri[i], y = tri[i + 1], z = tri[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  const b = bbox(out);
  const dx = cx - (b.min[0] + b.max[0]) / 2, dy = cy - (b.min[1] + b.max[1]) / 2, dz = -b.min[2];
  for (let i = 0; i + 2 < out.length; i += 3) {
    out[i] += dx;
    out[i + 1] += dy;
    out[i + 2] += dz;
  }
  return out;
}

/** Triangle area on the plate (all three vertices within tol of z = 0), mm². */
export function contactArea(tri: Float32Array, tol = 0.01): number {
  const b = bbox(tri);
  const z0 = b.min[2];
  let a = 0;
  for (let t = 0; t + 8 < tri.length; t += 9) {
    if (Math.abs(tri[t + 2] - z0) > tol || Math.abs(tri[t + 5] - z0) > tol || Math.abs(tri[t + 8] - z0) > tol) continue;
    const u: V3 = [tri[t + 3] - tri[t], tri[t + 4] - tri[t + 1], 0];
    const v: V3 = [tri[t + 6] - tri[t], tri[t + 7] - tri[t + 1], 0];
    a += Math.abs(u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return a;
}

const DOWN: V3 = [0, 0, -1];
const AXIS_NAMES: [V3, string][] = [
  [[1, 0, 0], 'X'],
  [[-1, 0, 0], 'X'],
  [[0, 1, 0], 'Y'],
  [[0, -1, 0], 'Y'],
  [[0, 0, 1], 'Z'],
  [[0, 0, -1], 'Z'],
];
function dirText(n: V3): string {
  const s = (v: number) => (v >= 0 ? '+' : '-');
  const ax = AXIS_NAMES.find(([a]) => dot(a, n) > 0.9995);
  if (ax) return `${s(dot(ax[0], [1, 1, 1]))}${ax[1]}`;
  return `(${n.map((v) => v.toFixed(2)).join(', ')})`;
}

/**
 * Turn the part onto its best flat face: among the planes of the mesh that the
 * WHOLE part lies on one side of (a supporting plane, i.e. a face of its convex
 * hull that is also a face of the mesh), the largest contact area wins; within
 * 1 % of it, the lowest resulting height; then the face it already stands on.
 * Winding-independent: both sides of every plane are tried.
 */
export function layFlat(tri: Float32Array, opts: { maxPlanes?: number } = {}): FlatResult {
  const T = Math.floor(tri.length / 9);
  const b0 = bbox(tri);
  const diag = Math.hypot(...sizeOf(b0));
  const tol = Math.max(0.01, diag * 1e-5);
  // unique vertices for the support test
  const ids = weldIds(tri, 1e-4);
  const seen = new Set<number>();
  const verts: number[] = [];
  for (let i = 0; i < ids.length; i++) if (!seen.has(ids[i])) {
    seen.add(ids[i]);
    verts.push(tri[3 * i], tri[3 * i + 1], tri[3 * i + 2]);
  }
  // planes: canonical normal (first non-zero component positive), offset d = n·p
  const planes = new Map<string, { n: V3; d: number; area: number }>();
  for (let t = 0; t < T; t++) {
    const o = 9 * t;
    const a: V3 = [tri[o], tri[o + 1], tri[o + 2]];
    const u: V3 = [tri[o + 3] - a[0], tri[o + 4] - a[1], tri[o + 5] - a[2]];
    const v: V3 = [tri[o + 6] - a[0], tri[o + 7] - a[1], tri[o + 8] - a[2]];
    const c = cross(u, v);
    const area2 = Math.hypot(c[0], c[1], c[2]);
    if (area2 < 1e-9) continue;
    let n: V3 = [c[0] / area2, c[1] / area2, c[2] / area2];
    const lead = Math.abs(n[0]) > 1e-6 ? n[0] : Math.abs(n[1]) > 1e-6 ? n[1] : n[2];
    if (lead < 0) n = [-n[0], -n[1], -n[2]];
    const d = dot(n, a);
    const key = `${Math.round(n[0] * 1000)},${Math.round(n[1] * 1000)},${Math.round(n[2] * 1000)},${Math.round(d * 20)}`;
    const p = planes.get(key);
    if (p) p.area += area2 / 2;
    else planes.set(key, { n, d, area: area2 / 2 });
  }
  const sorted = [...planes.values()].sort((x, y) => y.area - x.area);
  const cap = opts.maxPlanes ?? 400;
  let best: { n: V3; area: number; height: number } | null = null;
  const cands: { n: V3; area: number; height: number }[] = [];
  for (let k = 0; k < sorted.length && k < cap; k++) {
    const p = sorted[k];
    if (best && p.area < best.area * 0.99) break;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      const s = p.n[0] * verts[i] + p.n[1] * verts[i + 1] + p.n[2] * verts[i + 2];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    // outward = +n when the part lies below the plane, -n when above
    let out: V3 | null = null;
    if (hi <= p.d + tol) out = p.n;
    else if (lo >= p.d - tol) out = [-p.n[0], -p.n[1], -p.n[2]];
    if (!out) continue;
    const c = { n: out, area: p.area, height: hi - lo };
    cands.push(c);
    if (!best) best = c;
  }
  if (!best) {
    return { tri, normal: DOWN, area: 0, height: sizeOf(b0)[2], axis: [1, 0, 0], angle: 0, found: false, text: 'no flat face found that the whole part rests on: left as it came' };
  }
  const tied = cands.filter((c) => c.area >= best!.area * 0.99);
  tied.sort((a, b) => a.height - b.height);
  const already = tied.find((c) => dot(c.n, DOWN) > 0.9999);
  const pick = already && already.height <= tied[0].height + 1e-3 ? already : tied[0];
  const n = pick.n;
  const cosA = Math.max(-1, Math.min(1, dot(n, DOWN)));
  let axis: V3 = norm(cross(n, DOWN));
  let angle = (Math.acos(cosA) * 180) / Math.PI;
  if (angle < 0.01) {
    angle = 0;
    axis = [1, 0, 0];
  } else if (Math.hypot(...cross(n, DOWN)) < 1e-9) axis = [1, 0, 0]; // facing straight up: half a turn about X
  const out = angle === 0 ? transformDrop(tri, [1, 0, 0, 0, 1, 0, 0, 0, 1]) : transformDrop(tri, rotMatrix(axis, (angle * Math.PI) / 180));
  const h = sizeOf(bbox(out))[2];
  const area = Math.round(pick.area * 10) / 10;
  const text =
    angle === 0
      ? `already on its largest flat face (${area} mm² on the plate): not turned`
      : `laid on its ${area} mm² face (it faced ${dirText(n)}): turned ${Math.round(angle * 10) / 10}° about ${dirText(axis)}`;
  return { tri: out, normal: n, area: pick.area, height: h, axis, angle, found: true, text };
}

/** Turn a part a quarter (or half) turn about X, Y or Z, then drop it onto the plate. */
export function rotatePart(tri: Float32Array, axis: 'x' | 'y' | 'z', deg: 90 | 180 | 270): Float32Array {
  const a: V3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const m = rotMatrix(a, (deg * Math.PI) / 180).map((v) => Math.round(v * 1e12) / 1e12);
  return transformDrop(tri, m);
}

/* ════════════════════════════════════════════════════════════════════════════
 * ARRANGE
 * ══════════════════════════════════════════════════════════════════════════ */

export interface PlateRect {
  /** Printable area, mm, in the printer's own coordinates. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** "XxY" corner strings (the printer profile's printable_area) → the rectangle, or null when unreadable. */
export function plateFromArea(area: readonly string[] | null | undefined): PlateRect | null {
  if (!area || area.length < 3) return null;
  const pts = area.map((q) => String(q).trim().split('x').map(Number));
  if (pts.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return r.x1 - r.x0 > 0 && r.y1 - r.y0 > 0 ? r : null;
}

export interface Footprint {
  /** X and Y size of the part as it stands, mm. */
  w: number;
  d: number;
  /**
   * The part's real outline on the plate: XY triangles (6 floats each), relative to the
   * centre of its XY box. Absent = the box itself (a w x d rectangle).
   */
  outline?: Float32Array;
}

export interface Placed {
  /** 1-based plate. */
  plate: number;
  /**
   * Where the centre of the part's UNTURNED XY box goes, in plate coordinates: the
   * bridge's placement convention (jobs.cjs placeMesh: turn about that centre, then move it there).
   */
  x: number;
  y: number;
  /** Turn about Z, degrees, counter-clockwise (0, 15, 30 ... 345). */
  rot: number;
}

export interface Arrangement {
  /** One per footprint; null = too big for the plate (listed in `tooBig`). */
  placed: (Placed | null)[];
  tooBig: { index: number; reason: string }[];
  plates: number;
}

export interface ArrangeOpts {
  /** Space between parts, mm. */
  gap?: number;
  /** Space kept free along the plate edge, mm. */
  margin?: number;
  /** Raster cell, mm (default 0.5). */
  cell?: number;
  /** Turn step, degrees (default 15). */
  step?: number;
}

/** The outline of a footprint: its triangles, or its box as two. */
function outlineOf(f: Footprint): Float32Array {
  if (f.outline && f.outline.length >= 6) return f.outline;
  const w = f.w / 2, d = f.d / 2;
  return Float32Array.from([-w, -d, w, -d, w, d, -w, -d, w, d, -w, d]);
}

/** Outline turned by `deg` about its origin, then moved by (x, y). */
function placeOutline(o: Float32Array, deg: number, x: number, y: number): Float64Array {
  const t = (deg * Math.PI) / 180;
  const c = Math.round(Math.cos(t) * 1e12) / 1e12, s = Math.round(Math.sin(t) * 1e12) / 1e12;
  const out = new Float64Array(o.length);
  for (let i = 0; i < o.length; i += 2) {
    out[i] = o[i] * c - o[i + 1] * s + x;
    out[i + 1] = o[i] * s + o[i + 1] * c + y;
  }
  return out;
}

/** A turned outline as raster rows: every cell the outline touches (conservative), as runs per row. */
interface Raster {
  /** Size in cells. */
  w: number;
  h: number;
  /** Outline's min corner relative to its origin, mm (after the turn). */
  minX: number;
  minY: number;
  /** Per row: flat [start, end] (inclusive) runs. */
  rows: Int32Array[];
  cells: number;
}

function runsOf(bits: Uint8Array, w: number, h: number): Int32Array[] {
  const rows: Int32Array[] = [];
  for (let y = 0; y < h; y++) {
    const r: number[] = [];
    let x = 0;
    const o = y * w;
    while (x < w) {
      if (!bits[o + x]) { x++; continue; }
      const a = x;
      while (x < w && bits[o + x]) x++;
      r.push(a, x - 1);
    }
    rows.push(Int32Array.from(r));
  }
  return rows;
}

function rasterize(o: Float32Array, deg: number, cell: number): Raster {
  const p = placeOutline(o, deg, 0, 0);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
  }
  const w = Math.max(1, Math.ceil((maxX - minX) / cell - 1e-9));
  const h = Math.max(1, Math.ceil((maxY - minY) / cell - 1e-9));
  const bits = new Uint8Array(w * h);
  const X = [0, 0, 0], Y = [0, 0, 0];
  for (let t = 0; t + 5 < p.length; t += 6) {
    for (let k = 0; k < 3; k++) {
      X[k] = (p[t + 2 * k] - minX) / cell;
      Y[k] = (p[t + 2 * k + 1] - minY) / cell;
    }
    const ty0 = Math.min(Y[0], Y[1], Y[2]), ty1 = Math.max(Y[0], Y[1], Y[2]);
    const r0 = Math.max(0, Math.floor(ty0)), r1 = Math.min(h - 1, Math.ceil(ty1) - 1 < Math.floor(ty0) ? Math.floor(ty0) : Math.ceil(ty1) - 1);
    for (let r = r0; r <= r1; r++) {
      // the triangle's exact x-extent inside the band r..r+1: vertices in the band + edge crossings of its two lines
      const b0 = Math.max(r, ty0), b1 = Math.min(r + 1, ty1);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        if (Y[k] >= b0 && Y[k] <= b1) { lo = Math.min(lo, X[k]); hi = Math.max(hi, X[k]); }
        const j = (k + 1) % 3;
        const ya = Y[k], yb = Y[j];
        if (ya === yb) continue;
        for (const yy of [b0, b1]) {
          if ((yy - ya) * (yy - yb) <= 0) {
            const xx = X[k] + ((X[j] - X[k]) * (yy - ya)) / (yb - ya);
            lo = Math.min(lo, xx);
            hi = Math.max(hi, xx);
          }
        }
      }
      if (lo > hi) continue;
      const c0 = Math.max(0, Math.floor(lo)), c1 = Math.min(w - 1, Math.max(Math.floor(lo), Math.ceil(hi) - 1));
      bits.fill(1, r * w + c0, r * w + c1 + 1);
    }
  }
  let cells = 0;
  for (let i = 0; i < bits.length; i++) cells += bits[i];
  return { w, h, minX, minY, rows: runsOf(bits, w, h), cells };
}

/**
 * The raster grown by the gap: every cell whose BOX is closer than `g` cells to a cell of
 * the outline (box-to-box distance, so the real parts are at least `gap` apart wherever the
 * grown shape and another part's cells do not meet). Origin moves by `k` cells.
 */
function grow(r: Raster, g: number): { rows: Int32Array[]; k: number } {
  const ky = Math.ceil(g + 1) - 1;
  const half: number[] = [];
  for (let dy = 0; dy <= ky; dy++) {
    const ey = Math.max(0, dy - 1);
    half.push(ey < g ? Math.ceil(Math.sqrt(g * g - ey * ey) + 1) - 1 : -1);
  }
  const k = Math.max(ky, half[0]);
  const W = r.w + 2 * k, H = r.h + 2 * k;
  const diff = new Int32Array(H * (W + 1));
  for (let y = 0; y < r.h; y++) {
    const runs = r.rows[y];
    for (let q = 0; q < runs.length; q += 2) {
      for (let dy = -ky; dy <= ky; dy++) {
        const kx = half[Math.abs(dy)];
        if (kx < 0) continue;
        const row = y + k + dy;
        diff[row * (W + 1) + runs[q] + k - kx]++;
        diff[row * (W + 1) + runs[q + 1] + k + kx + 1]--;
      }
    }
  }
  const bits = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = 0; x < W; x++) {
      acc += diff[y * (W + 1) + x];
      if (acc > 0) bits[y * W + x] = 1;
    }
  }
  return { rows: runsOf(bits, W, H), k };
}

/** One plate's raster: occupied cells, with per-row prefix sums and "last occupied at or before x". */
class Board {
  occ: Uint8Array;
  pre: Int32Array;
  last: Int32Array;
  ux = 0;
  uy = 0;
  constructor(public W: number, public H: number) {
    this.occ = new Uint8Array(W * H);
    this.pre = new Int32Array(H * (W + 1));
    this.last = new Int32Array(W * H).fill(-1);
  }
  /** First free spot, lowest row then lowest column, for the raw raster `r` grown by `g` (or null). */
  find(r: Raster, g: { rows: Int32Array[]; k: number }): { x: number; y: number } | null {
    const { W, H, pre, last } = this;
    for (let py = 0; py + r.h <= H; py++) {
      let px = 0;
      search: while (px + r.w <= W) {
        for (let j = 0; j < g.rows.length; j++) {
          const Y = py - g.k + j;
          if (Y < 0 || Y >= H) continue;
          const runs = g.rows[j];
          for (let q = 0; q < runs.length; q += 2) {
            const a = Math.max(0, px - g.k + runs[q]), b = Math.min(W - 1, px - g.k + runs[q + 1]);
            if (a > b) continue;
            if (pre[Y * (W + 1) + b + 1] - pre[Y * (W + 1) + a] > 0) {
              px = Math.max(px + 1, last[Y * W + b] + g.k - runs[q] + 1);
              continue search;
            }
          }
        }
        return { x: px, y: py };
      }
    }
    return null;
  }
  put(r: Raster, x: number, y: number) {
    const { W, occ, pre, last } = this;
    for (let j = 0; j < r.h; j++) {
      const Y = y + j;
      const runs = r.rows[j];
      for (let q = 0; q < runs.length; q += 2) occ.fill(1, Y * W + x + runs[q], Y * W + x + runs[q + 1] + 1);
      let acc = 0, l = -1;
      for (let X = 0; X < W; X++) {
        if (occ[Y * W + X]) { acc++; l = X; }
        pre[Y * (W + 1) + X + 1] = acc;
        last[Y * W + X] = l;
      }
    }
    this.ux = Math.max(this.ux, x + r.w);
    this.uy = Math.max(this.uy, y + r.h);
  }
}

const rasterCache = new WeakMap<Float32Array, Map<string, { r: Raster; g: { rows: Int32Array[]; k: number } }>>();
function shapeAt(o: Float32Array, deg: number, cell: number, gc: number) {
  let m = rasterCache.get(o);
  if (!m) rasterCache.set(o, (m = new Map()));
  const key = `${deg}|${cell}|${gc}`;
  let v = m.get(key);
  if (!v) {
    const r = rasterize(o, deg, cell);
    v = { r, g: grow(r, gc) };
    m.set(key, v);
  }
  return v;
}

/**
 * Nest the parts by their REAL outlines (founder 2026-11-13: "tune the arranger make it
 * efficient as possible"; 3 sill brackets went on 2 plates while their outlines fit on 1).
 * Each outline is rasterised (cells it touches, conservative) at every `step`° turn, grown by
 * the gap, and placed at the lowest, then leftmost, free spot on the first plate where it fits,
 * choosing the turn that keeps the used area smallest. Several part orders are tried; the
 * result with the fewest plates, then the smallest used area, is kept. Each plate's group is
 * then centred. A part that fits an empty plate at no turn is never placed and always listed.
 * It does not turn a part over (only about Z), and it does not reserve room for a prime tower.
 */
export function arrange(fps: readonly Footprint[], plate: PlateRect, opts: ArrangeOpts = {}): Arrangement {
  const gap = opts.gap ?? 5;
  const margin = opts.margin ?? 2;
  const cell = opts.cell ?? 0.5;
  const step = opts.step ?? 15;
  const Wmm = plate.x1 - plate.x0 - 2 * margin;
  const Dmm = plate.y1 - plate.y0 - 2 * margin;
  const W = Math.floor(Wmm / cell + 1e-9), H = Math.floor(Dmm / cell + 1e-9);
  const gc = gap / cell;
  const turns: number[] = [];
  for (let a = 0; a < 360; a += step) turns.push(a);
  const tooBig: Arrangement['tooBig'] = [];
  const items: { i: number; o: Float32Array; area: number; long: number; d: number; turns: number[] }[] = [];
  fps.forEach((f, i) => {
    if (!(f.w > 0 && f.d > 0) || !Number.isFinite(f.w) || !Number.isFinite(f.d)) {
      tooBig.push({ index: i, reason: 'it has no size' });
      return;
    }
    const o = outlineOf(f);
    const ok = turns.filter((t) => {
      const r = shapeAt(o, t, cell, gc).r;
      return r.w <= W && r.h <= H;
    });
    if (!ok.length) {
      tooBig.push({ index: i, reason: `${r1(f.w)} x ${r1(f.d)} mm does not fit the ${r1(Wmm)} x ${r1(Dmm)} mm plate area at any turn` });
      return;
    }
    items.push({ i, o, area: shapeAt(o, 0, cell, gc).r.cells, long: Math.max(f.w, f.d), d: f.d, turns: ok });
  });
  const orders = [
    (a: (typeof items)[0], b: (typeof items)[0]) => b.area - a.area || a.i - b.i,
    (a: (typeof items)[0], b: (typeof items)[0]) => b.long - a.long || a.i - b.i,
    (a: (typeof items)[0], b: (typeof items)[0]) => b.d - a.d || b.area - a.area || a.i - b.i,
  ];
  type Try = { plates: number; used: number; pos: Map<number, { plate: number; x: number; y: number; t: number; r: Raster }>; boards: Board[] };
  let best: Try | null = null;
  for (const ord of orders) {
    const list = [...items].sort(ord);
    const boards: Board[] = [];
    const pos: Try['pos'] = new Map();
    for (const it of list) {
      let done = false;
      for (let b = 0; b <= boards.length && !done; b++) {
        if (b === boards.length) boards.push(new Board(W, H));
        const bd = boards[b];
        let pick: { x: number; y: number; t: number; r: Raster; score: number } | null = null;
        for (const t of it.turns) {
          const s = shapeAt(it.o, t, cell, gc);
          const at = bd.find(s.r, s.g);
          if (!at) continue;
          const ux = Math.max(bd.ux, at.x + s.r.w), uy = Math.max(bd.uy, at.y + s.r.h);
          const score = ux * uy * 4 + at.y * W + at.x;
          if (!pick || score < pick.score) pick = { ...at, t, r: s.r, score };
        }
        if (pick) {
          bd.put(pick.r, pick.x, pick.y);
          pos.set(it.i, { plate: b + 1, x: pick.x, y: pick.y, t: pick.t, r: pick.r });
          done = true;
        } else if (b === boards.length - 1 && boards[b].ux === 0) {
          boards.pop(); // cannot happen for a part that fits an empty plate; never leave an empty plate behind
          break;
        }
      }
    }
    const used = boards.reduce((s, b) => s + b.ux * b.uy, 0);
    if (!best || boards.length < best.plates || (boards.length === best.plates && used < best.used)) best = { plates: boards.length, used, pos, boards };
  }
  const placed: (Placed | null)[] = fps.map(() => null);
  if (best) {
    best.boards.forEach((bd, k) => {
      // centre the plate's group: the used cells, moved to the middle of the free area
      const ox = plate.x0 + margin + ((W - bd.ux) * cell) / 2;
      const oy = plate.y0 + margin + ((H - bd.uy) * cell) / 2;
      for (const [i, p] of best!.pos) {
        if (p.plate !== k + 1) continue;
        placed[i] = { plate: p.plate, x: ox + p.x * cell - p.r.minX, y: oy + p.y * cell - p.r.minY, rot: p.t };
      }
    });
  }
  tooBig.sort((a, b) => a.index - b.index);
  return { placed, tooBig, plates: best ? best.plates : 0 };
}

/* ── checkLayout: exact 2D geometry on the outlines, independent of the raster above ── */

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function segsCross(a: number[], b: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const [p1, p2] = [a.slice(0, 2), a.slice(2)], [q1, q2] = [b.slice(0, 2), b.slice(2)];
  return o(p1, p2, q1) * o(p1, p2, q2) < 0 && o(q1, q2, p1) * o(q1, q2, p2) < 0;
}
function inTri(px: number, py: number, t: Float64Array, o: number): boolean {
  const s = (ax: number, ay: number, bx: number, by: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d1 = s(t[o], t[o + 1], t[o + 2], t[o + 3]), d2 = s(t[o + 2], t[o + 3], t[o + 4], t[o + 5]), d3 = s(t[o + 4], t[o + 5], t[o], t[o + 1]);
  if (d1 === 0 && d2 === 0 && d3 === 0) return false;
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}
/** Distance between two triangles (0 when they overlap). */
function triDist(A: Float64Array, a: number, B: Float64Array, b: number): number {
  for (let k = 0; k < 3; k++) {
    if (inTri(A[a + 2 * k], A[a + 2 * k + 1], B, b) || inTri(B[b + 2 * k], B[b + 2 * k + 1], A, a)) return 0;
  }
  let m = Infinity;
  for (let k = 0; k < 3; k++) {
    const k2 = (k + 1) % 3;
    const ea = [A[a + 2 * k], A[a + 2 * k + 1], A[a + 2 * k2], A[a + 2 * k2 + 1]];
    for (let j = 0; j < 3; j++) {
      const j2 = (j + 1) % 3;
      const eb = [B[b + 2 * j], B[b + 2 * j + 1], B[b + 2 * j2], B[b + 2 * j2 + 1]];
      if (segsCross(ea, eb)) return 0;
      m = Math.min(m, segDist(ea[0], ea[1], eb[0], eb[1], eb[2], eb[3]), segDist(eb[0], eb[1], ea[0], ea[1], ea[2], ea[3]));
    }
  }
  return m;
}

/** Smallest distance between two placed outlines, stopping as soon as one pair is closer than `stop`. */
function outlineDist(A: Float64Array, B: Float64Array, stop: number): number {
  const reach = Math.max(stop, 1e-6);
  const C = Math.max(2, reach);
  const grid = new Map<string, number[]>();
  for (let b = 0; b + 5 < B.length; b += 6) {
    const x0 = Math.floor(Math.min(B[b], B[b + 2], B[b + 4]) / C), x1 = Math.floor(Math.max(B[b], B[b + 2], B[b + 4]) / C);
    const y0 = Math.floor(Math.min(B[b + 1], B[b + 3], B[b + 5]) / C), y1 = Math.floor(Math.max(B[b + 1], B[b + 3], B[b + 5]) / C);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x},${y}`;
      const l = grid.get(key);
      if (l) l.push(b);
      else grid.set(key, [b]);
    }
  }
  let m = Infinity;
  const seen = new Set<number>();
  for (let a = 0; a + 5 < A.length; a += 6) {
    const x0 = Math.floor((Math.min(A[a], A[a + 2], A[a + 4]) - reach) / C), x1 = Math.floor((Math.max(A[a], A[a + 2], A[a + 4]) + reach) / C);
    const y0 = Math.floor((Math.min(A[a + 1], A[a + 3], A[a + 5]) - reach) / C), y1 = Math.floor((Math.max(A[a + 1], A[a + 3], A[a + 5]) + reach) / C);
    seen.clear();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      for (const b of grid.get(`${x},${y}`) ?? []) {
        if (seen.has(b)) continue;
        seen.add(b);
        const d = triDist(A, a, B, b);
        if (d < m) {
          m = d;
          if (m < stop) return m;
        }
      }
    }
  }
  return m;
}

/**
 * Re-measure an arrangement on the parts' OUTLINES (exact triangle geometry, no raster): every
 * placed outline inside the plate, no two on the same plate closer than `gap` (less 0.01 mm of
 * rounding). Returns every violation as a sentence; [] = valid. Independent of how `arrange` did it.
 */
export function checkLayout(fps: readonly Footprint[], placed: readonly (Placed | null)[], plate: PlateRect, gap = 0): string[] {
  const out: string[] = [];
  const eps = 0.01;
  const shapes = placed.map((p, i) => {
    if (!p) return null;
    const t = placeOutline(outlineOf(fps[i]), p.rot || 0, p.x, p.y);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < t.length; k += 2) {
      x0 = Math.min(x0, t[k]); x1 = Math.max(x1, t[k]);
      y0 = Math.min(y0, t[k + 1]); y1 = Math.max(y1, t[k + 1]);
    }
    return { i, plate: p.plate, t, x0, x1, y0, y1 };
  });
  for (const r of shapes) {
    if (!r) continue;
    if (r.x0 < plate.x0 - eps || r.y0 < plate.y0 - eps || r.x1 > plate.x1 + eps || r.y1 > plate.y1 + eps)
      out.push(`part ${r.i + 1} is outside plate ${r.plate} (${r1(r.x0)}..${r1(r.x1)} x ${r1(r.y0)}..${r1(r.y1)} mm)`);
  }
  for (let a = 0; a < shapes.length; a++) for (let b = a + 1; b < shapes.length; b++) {
    const p = shapes[a], q = shapes[b];
    if (!p || !q || p.plate !== q.plate) continue;
    if (Math.max(q.x0 - p.x1, p.x0 - q.x1, q.y0 - p.y1, p.y0 - q.y1) >= gap - eps) continue;
    const d = outlineDist(p.t, q.t, gap - eps);
    if (d < gap - eps) out.push(`parts ${p.i + 1} and ${q.i + 1} on plate ${p.plate} are ${d <= 0 ? 'overlapping' : `only ${r1(d)} mm apart`}`);
  }
  return out;
}

const footprintCache = new WeakMap<Float32Array, Footprint>();
/**
 * The footprint of a part's mesh as it stands (rot 0): its XY box and its real outline (every
 * triangle that is not edge-on, projected onto the plate, relative to the box centre). The
 * same mesh gives the same object, so copies share their rasters.
 */
export function footprintOf(tri: Float32Array): Footprint {
  const hit = footprintCache.get(tri);
  if (hit) return hit;
  const b = bbox(tri);
  const s = sizeOf(b);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const o: number[] = [];
  for (let t = 0; t + 8 < tri.length; t += 9) {
    const ax = tri[t], ay = tri[t + 1], bx = tri[t + 3], by = tri[t + 4], qx = tri[t + 6], qy = tri[t + 7];
    if (Math.abs((bx - ax) * (qy - ay) - (by - ay) * (qx - ax)) < 1e-9) continue; // edge-on: covered by its neighbours in a closed solid
    o.push(ax - cx, ay - cy, bx - cx, by - cy, qx - cx, qy - cy);
  }
  const f: Footprint = { w: s[0], d: s[1], ...(o.length ? { outline: Float32Array.from(o) } : {}) };
  footprintCache.set(tri, f);
  return f;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Layout actions the assistant may propose (checked here, like the overrides)
 * ══════════════════════════════════════════════════════════════════════════ */

export type LayoutAction =
  | { do: 'separate' }
  | { do: 'lay_flat'; part: number | null }
  | { do: 'arrange' }
  | { do: 'rotate'; part: number; axis: 'x' | 'y' | 'z'; deg: 90 | 180 | 270 };

export const LAYOUT_ACTIONS_TEXT = [
  'LAYOUT ACTIONS (put them in "actions"; the app does them itself, checks them, and the person presses Apply):',
  '{"do": "separate"} - split every part into its separate solids, each its own part.',
  '{"do": "lay_flat", "part": n} - turn part n (1-based, as listed in job.parts) onto its largest flat face; omit "part" for every part.',
  '{"do": "arrange"} - place every part on the build plate(s), 5 mm apart, centred; more plates when they do not fit on one.',
  '{"do": "rotate", "part": n, "axis": "x"|"y"|"z", "deg": 90|180|270} - turn part n about an axis, then put it back on the plate.',
  'Separating, laying flat and arranging already happen automatically when a part arrives; propose them again when the person asks.',
].join('\n');

/** Every action the model sent is checked; only `accepted` may ever be applied. */
export function validateLayoutActions(raw: unknown, parts: number): { accepted: LayoutAction[]; refused: { key: string; why: string }[] } {
  const accepted: LayoutAction[] = [];
  const refused: { key: string; why: string }[] = [];
  if (raw === undefined || raw === null) return { accepted, refused };
  if (!Array.isArray(raw)) return { accepted, refused: [{ key: 'actions', why: 'must be a list' }] };
  const partOk = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= parts;
  for (const a of raw.slice(0, 8)) {
    const o = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
    const name = o && typeof o.do === 'string' ? o.do : '';
    const key = `action ${name || '?'}`;
    if (!o || !name) {
      refused.push({ key, why: 'not an action object' });
      continue;
    }
    if (!parts) {
      refused.push({ key, why: 'there are no parts in the job' });
      continue;
    }
    if (name === 'separate' || name === 'arrange') accepted.push({ do: name });
    else if (name === 'lay_flat') {
      if (o.part === undefined || o.part === null) accepted.push({ do: 'lay_flat', part: null });
      else if (partOk(o.part)) accepted.push({ do: 'lay_flat', part: o.part as number });
      else refused.push({ key, why: `part must be 1..${parts}` });
    } else if (name === 'rotate') {
      if (!partOk(o.part)) refused.push({ key, why: `part must be 1..${parts}` });
      else if (o.axis !== 'x' && o.axis !== 'y' && o.axis !== 'z') refused.push({ key, why: 'axis must be x, y or z' });
      else if (o.deg !== 90 && o.deg !== 180 && o.deg !== 270) refused.push({ key, why: 'deg must be 90, 180 or 270' });
      else accepted.push({ do: 'rotate', part: o.part as number, axis: o.axis, deg: o.deg });
    } else refused.push({ key, why: 'unknown action (separate, lay_flat, arrange, rotate only)' });
  }
  return { accepted, refused };
}

export function actionText(a: LayoutAction): string {
  if (a.do === 'separate') return 'Separate every part into its solids';
  if (a.do === 'arrange') return 'Arrange the parts on the plate';
  if (a.do === 'lay_flat') return a.part ? `Lay part ${a.part} flat` : 'Lay every part flat';
  return `Turn part ${a.part} ${a.deg}° about ${a.axis.toUpperCase()}`;
}

/* ════════════════════════════════════════════════════════════════════════════
 * Other programs: the assistant never sends the person to one
 * ══════════════════════════════════════════════════════════════════════════ */

const OTHER_PROGRAM = /\b(orca\s*slicer|orcaslicer|orca|bambu\s*studio|prusa\s*slicer|prusaslicer|cura|superslicer)\b/i;

/**
 * Remove every sentence of a model reply that names another slicer program
 * (founder 2026-10-16: "no orcaslicer anymore!"). Returns the text kept and
 * how many sentences were dropped, so the page can say that it dropped them.
 */
export function scrubOtherPrograms(text: string): { text: string; dropped: number } {
  const parts = String(text ?? '').split(/(?<=[.!?])\s+|\n+/);
  const kept = parts.filter((s) => !OTHER_PROGRAM.test(s));
  return { text: kept.join(' ').replace(/\s+/g, ' ').trim(), dropped: parts.length - kept.length };
}
