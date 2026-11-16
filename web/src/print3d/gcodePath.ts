// The sliced plate as the printer will lay it down, read back from the G-code the
// slicer bridge wrote (GET /v1/gcode/<id> → plate_1.gcode). Pure: no DOM, no three.js.
//
// WHAT THIS READS, AND ONLY THIS:
//   - G0/G1 linear moves and G2/G3 arcs (I/J centre or R radius; interpolated to
//     segments with a chord error under ARC_TOL_MM), G90/G91 for XYZ, M82/M83 for E,
//     G92 for E (and XYZ), G28 (position unknown until the next absolute XY).
//   - Layers from `; CHANGE_LAYER` (+ `; Z_HEIGHT:`) when the file has them, else
//     from Z: a new layer starts at the first extrusion above the current layer's Z.
//   - `; FEATURE: <name>` for the colour of each extrusion.
//   - Extrusion = a move with XY travel AND an E increase. Everything else that moves
//     XY is travel (wipes, which retract while moving, are travel).
//
// WHAT IT DOES NOT DO: it does not simulate the machine. Start and end G-code
// (before the first layer, after `; MACHINE_END_GCODE_START`) is not drawn and the
// result says so. A move whose E mode was never set by the file is REFUSED (thrown),
// not guessed: the drawn picture would otherwise be extrusion-or-travel by
// assumption. An arc that names neither I/J nor R is refused the same way.

export type PathKind = 'outer' | 'inner' | 'infill' | 'solid' | 'gap' | 'support' | 'skirt' | 'other' | 'travel';

export const PATH_KINDS: PathKind[] = ['outer', 'inner', 'infill', 'solid', 'gap', 'support', 'skirt', 'other', 'travel'];

export const KIND_LABEL: Record<PathKind, string> = {
  outer: 'Outer wall',
  inner: 'Inner wall',
  infill: 'Infill',
  solid: 'Solid infill',
  gap: 'Gap fill',
  support: 'Support',
  skirt: 'Skirt / brim',
  other: 'Other',
  travel: 'Travel',
};

/** Instrument colours, not brand colours: a toolpath legend reads like a machine view. */
export const KIND_COLOR: Record<PathKind, string> = {
  outer: '#ff7d38',
  inner: '#ffd84a',
  infill: '#c0392b',
  solid: '#a066e0',
  gap: '#f2f2f2',
  support: '#3ccf5a',
  skirt: '#2fb8b0',
  other: '#8a8f98',
  travel: '#4f8fe8',
};

/** OrcaSlicer / 2bee.fdm feature names → kind. A name not listed here goes to 'other' and is reported by name. */
const FEATURE_KIND: Record<string, PathKind> = {
  'outer wall': 'outer',
  'inner wall': 'inner',
  'sparse infill': 'infill',
  'internal solid infill': 'solid',
  'solid infill': 'solid',
  'top surface': 'solid',
  'bottom surface': 'solid',
  bridge: 'solid',
  'internal bridge': 'solid',
  'gap infill': 'gap',
  'gap fill': 'gap',
  support: 'support',
  'support interface': 'support',
  'support transition': 'support',
  skirt: 'skirt',
  brim: 'skirt',
};

export function featureKind(name: string): PathKind | null {
  return FEATURE_KIND[name.trim().toLowerCase()] ?? null;
}

export const ARC_TOL_MM = 0.01;

export interface PathBuffer {
  /** Segment endpoints, 6 floats per segment (x0 y0 z0 x1 y1 z1), sorted by layer. */
  pos: Float32Array;
  /** layerEnd[i] = number of segments in layers 0..i (cumulative), length = layers.length. */
  layerEnd: Uint32Array;
}

export interface Toolpath {
  layers: { z: number; line: number }[];
  layerSource: 'CHANGE_LAYER' | 'Z moves';
  eMode: 'relative' | 'absolute';
  kinds: Record<PathKind, PathBuffer>;
  /** G-code feature name → extrusion segment count (after arc interpolation). */
  features: Record<string, number>;
  /** Feature names drawn as 'other' because this reader does not know them. */
  unknownFeatures: string[];
  extrusionSegments: number;
  travelSegments: number;
  /** Sum of the positive E of every drawn extrusion (mm of filament). */
  extrudedE: number;
  arcs: number;
  /** Extrusion bounds (XY + Z), null when there is none. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  notDrawn: string[];
}

export class GcodeParseError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(line > 0 ? `G-code line ${line}: ${message}` : message);
  }
}

class Grow {
  a = new Float32Array(1 << 12);
  n = 0;
  push6(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    if (this.n + 6 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    const a = this.a, n = this.n;
    a[n] = x0; a[n + 1] = y0; a[n + 2] = z0; a[n + 3] = x1; a[n + 4] = y1; a[n + 5] = z1;
    this.n = n + 6;
  }
}

/** Read one word's number (e.g. 'X' in "G1 X10.5 Y3"); NaN when absent. `s` is upper-case, comment stripped. */
function word(s: string, letter: string): number {
  let i = s.indexOf(letter, 1);
  while (i > 0) {
    const prev = s.charCodeAt(i - 1);
    if (prev === 32 || prev === 9) break; // a word starts after whitespace
    i = s.indexOf(letter, i + 1);
  }
  if (i < 0) return NaN;
  let j = i + 1;
  while (j < s.length && s.charCodeAt(j) !== 32 && s.charCodeAt(j) !== 9) j++;
  const v = s.slice(i + 1, j);
  return v === '' ? NaN : Number(v);
}

export function parseGcode(text: string): Toolpath {
  const lines = text.split('\n');
  const hasMarkers = text.includes('; CHANGE_LAYER');
  const buf: Record<PathKind, Grow> = Object.fromEntries(PATH_KINDS.map((k) => [k, new Grow()])) as Record<PathKind, Grow>;
  const ends: Record<PathKind, number[]> = Object.fromEntries(PATH_KINDS.map((k) => [k, []])) as unknown as Record<PathKind, number[]>;
  const layers: { z: number; line: number }[] = [];
  const features: Record<string, number> = {};
  const unknown = new Set<string>();

  let absXYZ = true;
  let eMode: 'relative' | 'absolute' | null = null;
  let x = 0, y = 0, z = 0, e = 0;
  let known = false; // XY position known (false at start and after G28)
  const hasStartEnd = text.includes('; MACHINE_START_GCODE_END');
  // inside the layers region: from the first CHANGE_LAYER, or (no markers) from the end of the start G-code / the top
  let drawing = !hasMarkers && !hasStartEnd;
  let zSet = false; // the open layer's Z came from Z_HEIGHT or its first extrusion
  let ended = false;
  let feature = '';
  let kind: PathKind = 'other';
  let extrusionSegments = 0, travelSegments = 0, extrudedE = 0, arcs = 0;
  const mn: [number, number, number] = [Infinity, Infinity, Infinity];
  const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const closeLayer = () => {
    if (!layers.length) return;
    for (const k of PATH_KINDS) ends[k].push(buf[k].n / 6);
  };
  const openLayer = (lz: number, line: number) => {
    closeLayer();
    layers.push({ z: lz, line });
  };

  const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ext: boolean) => {
    if (ext) {
      buf[kind].push6(x0, y0, z0, x1, y1, z1);
      extrusionSegments++;
      if (feature) features[feature] = (features[feature] ?? 0) + 1;
      if (x1 < mn[0]) mn[0] = x1; if (y1 < mn[1]) mn[1] = y1; if (z1 < mn[2]) mn[2] = z1;
      if (x1 > mx[0]) mx[0] = x1; if (y1 > mx[1]) mx[1] = y1; if (z1 > mx[2]) mx[2] = z1;
      if (x0 < mn[0]) mn[0] = x0; if (y0 < mn[1]) mn[1] = y0;
      if (x0 > mx[0]) mx[0] = x0; if (y0 > mx[1]) mx[1] = y0;
    } else {
      buf.travel.push6(x0, y0, z0, x1, y1, z1);
      travelSegments++;
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const ln = li + 1;
    const semi = raw.indexOf(';');
    if (semi >= 0) {
      const c = raw.slice(semi + 1).trim();
      if (c.startsWith('FEATURE:')) {
        feature = c.slice(8).trim();
        const k = featureKind(feature);
        kind = k ?? 'other';
        if (!k) unknown.add(feature);
      } else if (hasMarkers && c === 'CHANGE_LAYER') {
        if (!ended) {
          drawing = true;
          zSet = false;
          openLayer(z, ln);
        }
      } else if (hasMarkers && c.startsWith('Z_HEIGHT:')) {
        const v = Number(c.slice(9).trim());
        if (drawing && layers.length && !zSet && Number.isFinite(v)) {
          layers[layers.length - 1].z = v;
          zSet = true;
        }
      } else if (c === 'MACHINE_END_GCODE_START') {
        if (drawing || !hasMarkers) ended = true;
        drawing = false;
      } else if (!hasMarkers && c === 'MACHINE_START_GCODE_END' && !ended) {
        drawing = true;
      }
    }
    const s = (semi >= 0 ? raw.slice(0, semi) : raw).trim().toUpperCase();
    if (!s) continue;
    const c0 = s.charCodeAt(0);
    if (c0 !== 71 && c0 !== 77) continue; // G / M
    let k = 1;
    while (k < s.length && s.charCodeAt(k) !== 32 && s.charCodeAt(k) !== 9) k++;
    const cmd = s.slice(0, k);
    if (/^G0*[0-3][^0-9]/.test(cmd)) throw new GcodeParseError(`"${cmd}": words without spaces between them are not read here; refusing rather than skipping a move`, ln);
    if (cmd === 'M82') { eMode = 'absolute'; continue; }
    if (cmd === 'M83') { eMode = 'relative'; continue; }
    if (cmd === 'G90') { absXYZ = true; continue; }
    if (cmd === 'G91') { absXYZ = false; continue; }
    if (cmd === 'G28') { known = false; continue; }
    if (cmd === 'G92') {
      const ve = word(s, 'E'), vx = word(s, 'X'), vy = word(s, 'Y'), vz = word(s, 'Z');
      if (!Number.isNaN(ve)) e = ve;
      if (!Number.isNaN(vx)) x = vx;
      if (!Number.isNaN(vy)) y = vy;
      if (!Number.isNaN(vz)) z = vz;
      continue;
    }
    const isLin = cmd === 'G0' || cmd === 'G1' || cmd === 'G00' || cmd === 'G01';
    const isArc = cmd === 'G2' || cmd === 'G3' || cmd === 'G02' || cmd === 'G03';
    if (!isLin && !isArc) continue;
    const vx = word(s, 'X'), vy = word(s, 'Y'), vz = word(s, 'Z'), ve = word(s, 'E');
    const nx = Number.isNaN(vx) ? x : absXYZ ? vx : x + vx;
    const ny = Number.isNaN(vy) ? y : absXYZ ? vy : y + vy;
    const nz = Number.isNaN(vz) ? z : absXYZ ? vz : z + vz;
    let de = 0;
    if (!Number.isNaN(ve)) {
      if (eMode === null) {
        if (drawing) throw new GcodeParseError('a move carries E but the file never set the E mode (M82 or M83); refusing to guess extrusion from travel', ln);
      } else {
        de = eMode === 'relative' ? ve : ve - e;
        e = eMode === 'relative' ? e + ve : ve;
      }
    }
    const vi = isArc ? word(s, 'I') : NaN, vj = isArc ? word(s, 'J') : NaN, vr = isArc ? word(s, 'R') : NaN;
    // an arc with I/J and no XY is a full circle: it moves the head even though it ends where it started
    const movesXY = !Number.isNaN(vx) || !Number.isNaN(vy) || (isArc && (!Number.isNaN(vi) || !Number.isNaN(vj)));
    const ext = de > 1e-9 && movesXY;
    if (drawing && !hasMarkers && ext && (!layers.length || nz > layers[layers.length - 1].z + 1e-6)) { openLayer(nz, ln); zSet = true; }
    if (drawing && ext && layers.length && !zSet) { layers[layers.length - 1].z = nz; zSet = true; }
    const draw = drawing && known && layers.length > 0 && movesXY;
    if (isArc) {
      if (!movesXY && Number.isNaN(vr)) { z = nz; continue; }
      let cx: number, cy: number;
      const cw = cmd === 'G2' || cmd === 'G02';
      if (!Number.isNaN(vi) || !Number.isNaN(vj)) {
        cx = x + (Number.isNaN(vi) ? 0 : vi);
        cy = y + (Number.isNaN(vj) ? 0 : vj);
      } else if (!Number.isNaN(vr)) {
        const dx = nx - x, dy = ny - y, d = Math.hypot(dx, dy);
        const r = Math.abs(vr);
        if (d < 1e-9 || d > 2 * r + 1e-6) throw new GcodeParseError(`arc with R${vr} cannot join its endpoints (${d.toFixed(3)} mm apart)`, ln);
        const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
        // left of the chord for CCW short arcs; R<0 asks for the long arc
        const side = (cw ? -1 : 1) * (vr < 0 ? -1 : 1);
        cx = x + dx / 2 - (side * h * dy) / d;
        cy = y + dy / 2 + (side * h * dx) / d;
      } else {
        throw new GcodeParseError(`${cmd} names neither I/J nor R; refusing to draw an arc it does not define`, ln);
      }
      arcs++;
      if (draw) {
        const r = Math.hypot(x - cx, y - cy);
        const a0 = Math.atan2(y - cy, x - cx);
        let sweep = Math.atan2(ny - cy, nx - cx) - a0;
        if (cw) { if (sweep >= -1e-12) sweep -= 2 * Math.PI; } else if (sweep <= 1e-12) sweep += 2 * Math.PI;
        const step = r > ARC_TOL_MM ? 2 * Math.acos(1 - ARC_TOL_MM / r) : Math.PI;
        const n = Math.max(1, Math.min(720, Math.ceil(Math.abs(sweep) / step)));
        let px = x, py = y, pz = z;
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const qx = i === n ? nx : cx + r * Math.cos(a0 + sweep * t);
          const qy = i === n ? ny : cy + r * Math.sin(a0 + sweep * t);
          const qz = z + (nz - z) * t;
          seg(px, py, pz, qx, qy, qz, ext);
          px = qx; py = qy; pz = qz;
        }
        if (ext) extrudedE += de;
      }
    } else if (draw && (nx !== x || ny !== y)) {
      seg(x, y, z, nx, ny, nz, ext);
      if (ext) extrudedE += de;
    }
    x = nx; y = ny; z = nz;
    if (absXYZ && !Number.isNaN(vx) && !Number.isNaN(vy)) known = true;
  }
  closeLayer();

  if (!layers.length) throw new GcodeParseError(hasMarkers ? 'no layer was opened (no `; CHANGE_LAYER` before the end G-code)' : 'no layer found: the file has no `; CHANGE_LAYER` markers and no extrusion', 0);
  if (extrusionSegments === 0) throw new GcodeParseError('the file has layers but not one extruding move', 0);
  if (eMode === null) throw new GcodeParseError('the file never set the E mode (M82 or M83)', 0);

  const kinds = Object.fromEntries(
    PATH_KINDS.map((k) => [k, { pos: buf[k].a.slice(0, buf[k].n), layerEnd: Uint32Array.from(ends[k]) }]),
  ) as Record<PathKind, PathBuffer>;
  const notDrawn = hasMarkers || hasStartEnd ? ['machine start G-code (before the first layer)'] : [];
  if (ended) notDrawn.push('machine end G-code');
  return {
    layers,
    layerSource: hasMarkers ? 'CHANGE_LAYER' : 'Z moves',
    eMode,
    kinds,
    features,
    unknownFeatures: [...unknown].filter((f) => (features[f] ?? 0) > 0),
    extrusionSegments,
    travelSegments,
    extrudedE,
    arcs,
    bbox: { min: mn, max: mx },
    notDrawn,
  };
}

/** Segment range [from, to) of layer `i` in one kind's buffer. */
export function layerRange(b: PathBuffer, i: number): [number, number] {
  return [i > 0 ? b.layerEnd[i - 1] : 0, b.layerEnd[i] ?? 0];
}
