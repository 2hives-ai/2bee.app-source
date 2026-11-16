// 3D solids for the preview of a cutter, a touch plate and a work holding
// device, built FROM THE SAME NUMBERS the flat drawings use.
//
// Founder 2026-10-15: *"in the tool list show the preview not a drawing but a
// 3d object (have to build up all objects in 3d)"*.
//
// 🔴 THE RULES OF `toolShape.tsx` CARRY OVER UNCHANGED, because a solid asserts
// even harder than a drawing:
//
//   * A number the record does not hold is NOT turned into geometry that looks
//     measured. Where something has to be drawn to have a picture at all (a
//     shank with no overall length, a flute with no cutting length, a clamp
//     body nobody publishes), it is built at a STAND-IN size and tagged
//     `assumed`, which the renderer draws faded/wireframe in the warn colour,
//     and the caption names the stand-in.
//   * No included / point angle -> no cone. The body ends OPEN with a dashed
//     ring at its end, the 3D form of the drawing's dashed bottom edge.
//   * No flute direction, or no flute count -> no flutes are cut in. A plain
//     cylinder, and the caption says why. Straight grooves would be a claim
//     ("straight flutes") nobody made.
//
// This module builds geometry only. It does not touch the DOM, colours or a
// renderer — every mesh carries a `userData.role`, and `Scene3D.tsx` maps a role
// to a material from the theme. That split is what lets the unit test measure
// the built solid in Node with no WebGL.
//
// Units: millimetres. Axis: +Y is up. A cutter stands tip-DOWN with its tip at
// y = 0. Bed-based scenes put the spoilboard top at y = 0.

import * as THREE from 'three';
import { readToolShape, type ToolShapeTool } from '../toolShape';
import { findTouchPlate, type TouchPlate } from '../touchplates';
import { shapeFor } from '../workholdingShape';

/** What a mesh IS. The renderer turns it into a colour; the test reads it. */
export type Role =
  | 'cut' // cutting geometry: flutes, tip — accent
  | 'cut-assumed' // flute drawn at a stand-in length — accent, faded
  | 'shank' // non-cutting — muted
  | 'shank-assumed' // shank at a stand-in length — muted, faded
  | 'refuse' // dashed ring: "this end is not drawn" — muted dashed line
  | 'body' // a device you own — ink
  | 'assumed' // stand-in geometry — warn, translucent wireframe
  | 'stock' // the workpiece — muted, translucent
  | 'spoilboard' // line colour
  | 'steel' // steel in the cut path — warn
  | 'cuttable' // may be cut on purpose / film / the cutter — accent
  | 'hidden' // an obstruction UNDER the stock — ink, translucent
  | 'keepout' // the box gate P7 checks a toolpath against — warn dashed edges
  | 'eaten' // workpiece area a clamp eats — warn, translucent
  | 'edge'; // outline of a solid — ink lines

export const STOCK_MM = 18;

function tag<T extends THREE.Object3D>(o: T, role: Role, name?: string): T {
  o.userData.role = role;
  if (name) o.name = name;
  return o;
}

/** One shared placeholder; `Scene3D` replaces it by role. */
const PLACEHOLDER = new THREE.MeshBasicMaterial();
const LINE_PLACEHOLDER = new THREE.LineBasicMaterial();

function mesh(geo: THREE.BufferGeometry, role: Role, name?: string): THREE.Mesh {
  return tag(new THREE.Mesh(geo, PLACEHOLDER), role, name);
}

/** A dashed ring of radius `r` at height `y` (around the Y axis). */
function ring(r: number, y: number, role: Role = 'refuse', name?: string): THREE.LineLoop {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), LINE_PLACEHOLDER);
  line.computeLineDistances();
  return tag(line, role, name);
}

/** A box spanning [x0,x1]×[y0,y1]×[z0,z1], with its outline. */
function box(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  role: Role,
  name?: string
): THREE.Group {
  const g = new THREE.Group();
  const w = Math.max(x1 - x0, 1e-3);
  const h = Math.max(y1 - y0, 1e-3);
  const d = Math.max(z1 - z0, 1e-3);
  const geo = new THREE.BoxGeometry(w, h, d);
  const m = mesh(geo, role, name);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.add(m);
  g.add(edgesOf(m, role === 'assumed' || role === 'keepout' ? role : 'edge'));
  return tag(g, role, name);
}

/** Outline of a mesh, positioned with it. Dashed for assumed/keepout. */
function edgesOf(m: THREE.Mesh, role: Role): THREE.LineSegments {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), LINE_PLACEHOLDER);
  e.position.copy(m.position);
  e.rotation.copy(m.rotation);
  e.computeLineDistances();
  return tag(e, role);
}

/** A vertical cylinder from y0 to y1. */
function cyl(
  r: number,
  y0: number,
  y1: number,
  role: Role,
  opts: { x?: number; z?: number; rTop?: number; open?: boolean; name?: string; seg?: number } = {}
): THREE.Mesh {
  const h = Math.max(y1 - y0, 1e-3);
  const geo = new THREE.CylinderGeometry(opts.rTop ?? r, r, h, opts.seg ?? 48, 1, opts.open ?? false);
  const m = mesh(geo, role, opts.name);
  m.position.set(opts.x ?? 0, (y0 + y1) / 2, opts.z ?? 0);
  return m;
}

/* ── Cutters ──────────────────────────────────────────────────────────────── */

/** A router bit's helix angle, off the axis. The drawing uses the same ~30°. */
export const HELIX_DEG = 30;

export interface ToolModelInfo {
  /** Tip to the top of the drawn solid, mm. */
  drawnLengthMm: number;
  /** Stated overall length, or null when the shank is a stand-in. */
  overallMm: number | null;
  /** Top of the cutting geometry (tip + flutes), mm from the tip. */
  fluteTopMm: number;
  /** Axial height of the tip, mm. 0 for a flat end. */
  tipHeightMm: number;
  /** Which numbers were replaced by a stand-in to have a solid at all. */
  standIns: string[];
}

/**
 * The cross-section radius of a fluted body at angle `theta`, with `n` flute
 * grooves whose centres sit at `phase`. Lands are at the full radius, so the
 * solid's outer envelope IS the stated diameter.
 */
export function fluteRadius(R: number, n: number, theta: number, phase: number): number {
  const P = (Math.PI * 2) / n;
  let t = ((theta - phase) % P + P) % P / P; // 0..1 across one pitch
  t -= 0.5; // groove centred at 0
  const halfW = 0.28; // groove spans 56% of the pitch
  if (Math.abs(t) >= halfW) return R;
  const depth = n === 1 ? 0.32 : n === 2 ? 0.26 : 0.2;
  return R * (1 - depth * Math.cos((t / halfW) * (Math.PI / 2)));
}

/**
 * Helical (or straight) fluted body from y0 to y1. `twist(y)` is the angular
 * position of the first groove at height y.
 */
function flutedBody(
  R: number,
  n: number,
  y0: number,
  y1: number,
  twist: (y: number) => number,
  turnsHint: number
): THREE.BufferGeometry {
  const S = 96;
  const rings = Math.min(400, Math.max(8, Math.ceil(turnsHint / (Math.PI / 24))));
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const y = y0 + ((y1 - y0) * i) / rings;
    const ph = twist(y);
    for (let j = 0; j < S; j++) {
      const th = (j / S) * Math.PI * 2;
      const r = fluteRadius(R, n, th, ph);
      pos.push(Math.cos(th) * r, y, Math.sin(th) * r);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < S; j++) {
      const a = i * S + j;
      const b = i * S + ((j + 1) % S);
      const c = (i + 1) * S + j;
      const d = (i + 1) * S + ((j + 1) % S);
      // Wound so the normals face OUT (a, c, b) — see the cross product in the
      // commit that added this; the renderer uses FrontSide.
      idx.push(a, c, b, b, c, d);
    }
  }
  // Caps, as their own vertices so the side normals are not dragged flat.
  const capAt = (y: number, down: boolean) => {
    const base = pos.length / 3;
    const ph = twist(y);
    pos.push(0, y, 0);
    for (let j = 0; j < S; j++) {
      const th = (j / S) * Math.PI * 2;
      const r = fluteRadius(R, n, th, ph);
      pos.push(Math.cos(th) * r, y, Math.sin(th) * r);
    }
    for (let j = 0; j < S; j++) {
      const p = base + 1 + j;
      const q = base + 1 + ((j + 1) % S);
      if (down) idx.push(base, p, q);
      else idx.push(base, q, p);
    }
  };
  capAt(y0, true);
  capAt(y1, false);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a cutter. Returns the group and what it measured — `info` is how the
 * unit test asks the solid what length it is, rather than trusting the inputs.
 *
 * `null` when the tool states no diameter: there is nothing to build, and the
 * caller shows the drawing's empty dashed frame and its sentence instead.
 */
export function buildToolModel(tool: ToolShapeTool): { group: THREE.Group; info: ToolModelInfo } | null {
  const r = readToolShape(tool);
  if (r.diaMm === null) return null;
  const R = r.diaMm / 2;
  const g = new THREE.Group();
  g.name = 'tool';
  const standIns: string[] = [];

  const tipH = r.tip.kind === 'cone' || r.tip.kind === 'ball' ? r.tip.heightMm : 0;

  // ── Tip ────────────────────────────────────────────────────────────────
  if (r.tip.kind === 'cone') {
    // Apex at y = 0, base of radius R at y = tipH — the TRUE angle, never fitted.
    const m = mesh(new THREE.CylinderGeometry(R, 0, tipH, 64, 1, false), 'cut', 'tip');
    m.position.y = tipH / 2;
    g.add(m);
  } else if (r.tip.kind === 'ball') {
    const sph = new THREE.SphereGeometry(R, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const m = mesh(sph, 'cut', 'tip');
    m.position.y = R;
    g.add(m);
  } else if (r.tip.kind === 'none') {
    g.add(ring(R * 1.06, 0, 'refuse', 'tip-refused'));
  }

  // ── Flutes ─────────────────────────────────────────────────────────────
  let fluteTop: number;
  let fluteAssumed = false;
  if (r.fluteMm !== null) {
    fluteTop = Math.max(r.fluteMm, tipH);
  } else {
    fluteTop = tipH + Math.max(3 * r.diaMm, 6);
    fluteAssumed = true;
    standIns.push(`cutting length (drawn ${(fluteTop - tipH).toFixed(1)} mm of body, faded)`);
  }
  const bodyH = fluteTop - tipH;
  const flutes = typeof tool.flutes === 'number' && Number.isFinite(tool.flutes) && tool.flutes >= 1 ? Math.round(tool.flutes) : null;
  const helixKnown = r.helix !== 'unstated';
  if (bodyH > 1e-6) {
    const role: Role = fluteAssumed ? 'cut-assumed' : 'cut';
    if (flutes !== null && helixKnown) {
      const k = Math.tan((HELIX_DEG * Math.PI) / 180) / R; // rad per mm
      const mid = tipH + bodyH / 2;
      // Right-hand helix about +Y: the groove angle DECREASES as y rises.
      const twist =
        r.helix === 'straight'
          ? () => 0
          : r.helix === 'up'
            ? (y: number) => -k * (y - tipH)
            : r.helix === 'down'
              ? (y: number) => k * (y - tipH)
              : (y: number) => -k * (Math.min(y, mid) - tipH) + k * Math.max(y - mid, 0);
      const turns = r.helix === 'straight' ? 0 : k * bodyH;
      g.add(mesh(flutedBody(R, flutes, tipH, fluteTop, twist, turns), role, 'flutes'));
    } else {
      // Count or direction unstated: no grooves. Open at the bottom when the
      // tip is refused, so the end does not read as a flat-bottom cutter.
      const m = cyl(R, tipH, fluteTop, role, { name: 'flutes', seg: 64, open: r.tip.kind === 'none' });
      g.add(m);
    }
    // A flute at a stand-in length is BROKEN, as in the drawing: a dashed ring
    // across it says "not to length".
    if (fluteAssumed) g.add(ring(R * 1.1, tipH + bodyH * 0.55, 'refuse', 'flute-broken'));
  }

  // ── Shank ──────────────────────────────────────────────────────────────
  const overall = statedOverall(tool);
  let top = fluteTop;
  let overallDrawn: number | null = null;
  if (r.shankMm !== null) {
    const S = r.shankMm / 2;
    if (overall !== null && overall > fluteTop) {
      g.add(cyl(S, fluteTop, overall, 'shank', { name: 'shank', seg: 64 }));
      top = overall;
      overallDrawn = overall;
    } else {
      const len = Math.max(fluteTop, 2.5 * r.shankMm, 10);
      g.add(cyl(S, fluteTop, fluteTop + len, 'shank-assumed', { name: 'shank', seg: 64, open: true }));
      top = fluteTop + len;
      g.add(ring(S * 1.08, top, 'refuse', 'shank-broken'));
      standIns.push(
        overall !== null
          ? `shank length (overall ${overall} mm is not longer than the flutes — shank drawn faded at a stand-in length)`
          : `shank length (overall length not stated — drawn faded, open at the top)`
      );
    }
  } else {
    // No shank: nothing above the flutes, and the top edge is a dashed ring.
    g.add(ring(R * 1.06, fluteTop, 'refuse', 'shank-refused'));
  }

  return {
    group: g,
    info: { drawnLengthMm: top, overallMm: overallDrawn, fluteTopMm: fluteTop, tipHeightMm: tipH, standIns },
  };
}

function statedOverall(tool: ToolShapeTool): number | null {
  const v = tool.overall_length_mm;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** What the 3D cutter shows and does not, in words — the caption. */
export function describeTool3D(tool: ToolShapeTool): { title: string; drawn: string[]; notDrawn: string[] } {
  const r = readToolShape(tool);
  if (r.diaMm === null) {
    return { title: 'No solid — this tool states no diameter.', drawn: [], notDrawn: ['diameter is not stated, so nothing is built'] };
  }
  const drawn: string[] = [`Ø${r.diaMm} mm`];
  const notDrawn: string[] = [];
  const tipH = r.tip.kind === 'cone' || r.tip.kind === 'ball' ? r.tip.heightMm : 0;
  // Same stand-in as `buildToolModel`, so the words and the solid agree.
  const fluteTop = r.fluteMm !== null ? Math.max(r.fluteMm, tipH) : tipH + Math.max(3 * r.diaMm, 6);
  const ol = statedOverall(tool);
  const overallDrawn = r.shankMm !== null && ol !== null && ol > fluteTop ? ol : null;

  if (r.fluteMm !== null) drawn.push(`${r.fluteMm} mm flute length`);
  else notDrawn.push('cutting length is not stated, so the flutes are drawn FADED at a stand-in length');

  if (r.tip.says) drawn.push(r.tip.says);
  if (r.tip.missing) notDrawn.push(`${r.tip.missing} is not stated, so no tip is built — the body ends open, at a dashed ring`);

  const flutes = typeof tool.flutes === 'number' && Number.isFinite(tool.flutes) && tool.flutes >= 1 ? Math.round(tool.flutes) : null;
  if (r.helix === 'unstated') {
    notDrawn.push('flute direction is not stated, so no flutes are cut in — a plain cylinder');
  } else if (flutes === null) {
    notDrawn.push('flute count is not stated, so no flutes are cut in — a plain cylinder');
  } else {
    const dir =
      r.helix === 'straight' ? 'straight' : r.helix === 'up' ? 'up-cut (right-hand helix)' : r.helix === 'down' ? 'down-cut (left-hand helix)' : 'compression (up-cut below, down-cut above)';
    drawn.push(`${flutes} flute${flutes === 1 ? '' : 's'}, ${dir}`);
    if (r.helix !== 'straight') notDrawn.push(`the helix angle is not in the tool record — drawn at ${HELIX_DEG}°`);
    if (r.helix === 'compression') notDrawn.push('the height the two helices meet at is not in the record — drawn mid-flute');
  }

  if (r.shankMm !== null) {
    drawn.push(`${r.shankMm} mm shank`);
    if (overallDrawn !== null) drawn.push(`${overallDrawn} mm overall`);
    else notDrawn.push('overall length is not stated, so the shank is drawn FADED at a stand-in length, open at the top');
  } else {
    notDrawn.push('shank diameter is not stated, so no shank is built — the top ends at a dashed ring');
  }

  const title = [tool.category ?? 'Tool', ...drawn, ...(notDrawn.length ? [`not drawn: ${notDrawn.join('; ')}`] : [])].join(' · ');
  return { title, drawn, notDrawn };
}

/* ── Scene furniture ──────────────────────────────────────────────────────── */

/** A spoilboard slab under everything, top at y = 0. */
function bed(x0: number, x1: number, z0: number, z1: number, thick = 4): THREE.Group {
  return box(x0, x1, -thick, 0, z0, z1, 'spoilboard', 'spoilboard');
}

/** The 1/4" cutter the touch plate drawings use. DRAWN, not stored. */
const TOOL_DIA = 6.35;

function cutter(x: number, z: number, tipY: number, len = 30): THREE.Mesh {
  return cyl(TOOL_DIA / 2, tipY, tipY + len, 'cuttable', { x, z, name: 'cutter', seg: 32 });
}

/* ── Touch plates ─────────────────────────────────────────────────────────── */

// The same stand-ins `touchplateShape.tsx` draws dashed. Copied by value,
// named the same, and every use below is tagged `assumed`.
const LEG_STANDIN = 40;
const TOP_STANDIN = 12;
const WALL_STANDIN = 8;
const WALL_DROP = 10;
const BORE_STANDIN = 15;
const SETTER_H_STANDIN = 60;
const SETTER_DIA_STANDIN = 20;

export type PlateKind = 'corner' | 'bore' | 'flat' | 'setter' | 'datum';

/** Same derivation as `touchplateShape.tsx`'s `kindOf` (module-private there). */
export function plateKind(p: TouchPlate): PlateKind {
  if (p.id === 'bed-datum-no-plate') return 'datum';
  if (p.references === 'machine') return 'setter';
  if (p.radiusTerm === 'bore') return 'bore';
  return p.axes === 'xyz' ? 'corner' : 'flat';
}

export function buildTouchPlateModel(id: string): THREE.Group | null {
  const p = findTouchPlate(id);
  if (!p) return null;
  const kind = plateKind(p);
  const g = new THREE.Group();
  g.name = `touchplate:${id}`;
  g.userData.kind = kind;

  if (kind === 'corner') {
    // Stock in +x/+z from its corner at the origin; the plate hooks over it.
    g.add(bed(-30, 90, -30, 80));
    g.add(box(0, 80, 0, STOCK_MM, 0, 70, 'stock', 'stock'));
    const top = p.topMm ?? TOP_STANDIN;
    const wall = p.wallMm ?? WALL_STANDIN;
    const fx = p.footprintMm ? p.footprintMm[0] : LEG_STANDIN;
    const fz = p.footprintMm ? p.footprintMm[1] : LEG_STANDIN;
    const topRole: Role = p.topMm === null || p.footprintMm === null ? 'assumed' : 'body';
    g.add(box(-wall, fx - wall, STOCK_MM, STOCK_MM + top, -wall, fz - wall, topRole, 'plate-top'));
    // The two walls hang over the stock's edges. WALL_DROP is a stand-in on
    // every entry, so the walls are always `assumed` — as in the drawing.
    g.add(box(-wall, 0, STOCK_MM - WALL_DROP, STOCK_MM, 0, fz - wall, 'assumed', 'plate-wall-x'));
    g.add(box(0, fx - wall, STOCK_MM - WALL_DROP, STOCK_MM, -wall, 0, 'assumed', 'plate-wall-z'));
    g.add(cutter((fx - wall) / 2, (fz - wall) / 2, STOCK_MM + top));
  } else if (kind === 'bore') {
    g.add(bed(-40, 80, -40, 60));
    g.add(box(-30, 70, 0, STOCK_MM, -30, 50, 'stock', 'stock'));
    const top = p.topMm ?? TOP_STANDIN;
    const bore = p.boreMm ?? BORE_STANDIN;
    const half = LEG_STANDIN / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-half, -half);
    shape.lineTo(half, -half);
    shape.lineTo(half, half);
    shape.lineTo(-half, half);
    shape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, bore / 2, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: top, bevelEnabled: false, curveSegments: 48 });
    geo.rotateX(-Math.PI / 2); // extrude along +Y
    geo.translate(0, STOCK_MM, 0);
    // The footprint around the bore is always a stand-in (LEG_STANDIN).
    const m = mesh(geo, 'assumed', 'plate');
    g.add(m);
    g.add(edgesOf(m, 'assumed'));
    g.add(ring(bore / 2, STOCK_MM + top + 0.05, p.boreMm === null ? 'assumed' : 'cut', 'bore'));
    g.add(cutter(0, 0, STOCK_MM + top * 0.4, 40));
  } else if (kind === 'flat') {
    g.add(bed(-50, 70, -40, 50));
    g.add(box(-40, 60, 0, STOCK_MM, -30, 40, 'stock', 'stock'));
    const top = p.topMm ?? TOP_STANDIN;
    const fx = p.footprintMm ? p.footprintMm[0] : 70;
    const fz = p.footprintMm ? p.footprintMm[1] : 50;
    const role: Role = p.topMm === null || p.footprintMm === null ? 'assumed' : 'body';
    g.add(box(-fx / 2 + 10, fx / 2 + 10, STOCK_MM, STOCK_MM + top, -fz / 2 + 5, fz / 2 + 5, role, 'plate'));
    g.add(cutter(10, 5, STOCK_MM + top));
  } else if (kind === 'setter') {
    g.add(bed(-40, 140, -40, 50));
    // The stock is separate: the setter is bolted to the MACHINE.
    g.add(box(40, 130, 0, STOCK_MM, -30, 40, 'stock', 'stock'));
    const h = p.standingHeightMm ?? SETTER_H_STANDIN;
    const dia = p.footprintMm ? p.footprintMm[0] : SETTER_DIA_STANDIN;
    const baseDia = dia * 2.2; // stand-in in the drawing too
    g.add(cyl(baseDia / 2, 0, Math.min(5, h * 0.2), 'assumed', { name: 'setter-base' }));
    g.add(cyl(dia / 2, Math.min(5, h * 0.2), h, p.standingHeightMm === null || p.footprintMm === null ? 'assumed' : 'body', { name: 'setter' }));
    g.add(cutter(0, 0, h));
  } else {
    // Datum: no device. The cutter's tip touches the spoilboard.
    g.add(bed(-40, 100, -40, 50));
    g.add(box(20, 95, 0, STOCK_MM, -30, 40, 'stock', 'stock'));
    g.add(cutter(-10, 0, 0));
    g.add(ring(TOOL_DIA, 0.05, 'cut', 'datum'));
  }
  return g;
}

/* ── Work holding ─────────────────────────────────────────────────────────── */

export type WorkholdingShape = NonNullable<ReturnType<typeof shapeFor>>;

/** Fastener diameter: published by nobody. The drawing uses 3.2 mm; so do we. */
export const FASTENER_DIA_STANDIN = 3.2;

export function buildWorkholdingModel(id: string): THREE.Group | null {
  const s = shapeFor(id);
  if (!s) return null;
  const g = new THREE.Group();
  g.name = `workholding:${id}`;
  g.userData.kind = s.kind;
  const [across, along] = s.footprintMm;
  const h = s.heightMm;

  if (s.kind === 'proud') {
    // Sheet edge at x = 0, sheet in +x. Body reaches `intrusion` onto it.
    const intrude = s.intrusionMm ?? 0;
    const x0 = intrude - across;
    g.add(bed(Math.min(x0, -20) - 10, 110, -Math.max(along, 60) / 2 - 15, Math.max(along, 60) / 2 + 15));
    g.add(box(0, 100, 0, STOCK_MM, -Math.max(along, 60) / 2, Math.max(along, 60) / 2, 'stock', 'stock'));
    // Off the sheet: full height from the bed.
    if (x0 < 0) g.add(box(x0, Math.min(0, intrude), 0, Math.max(h, 0.2), -along / 2, along / 2, 'body', 'body'));
    // Over the sheet: from the stock top, only when it stands above it.
    if (intrude > 0 && h > STOCK_MM) g.add(box(0, intrude, STOCK_MM, h, -along / 2, along / 2, 'body', 'body-over'));
    if (intrude > 0) g.add(box(0, intrude, STOCK_MM, STOCK_MM + 0.3, -along / 2, along / 2, 'eaten', 'eaten'));
    // The keepout gate P7 checks: the whole footprint, full height.
    g.add(box(x0, intrude, 0, Math.max(h, 0.2), -along / 2, along / 2, 'keepout', 'keepout'));
  } else if (s.kind === 'under') {
    g.add(bed(-90, 90, -70, 70));
    g.add(box(-across / 2, across / 2, 0, h, -along / 2, along / 2, 'hidden', 'pod'));
    // The stock sits ON the pod — lifted by its height.
    g.add(box(-80, 80, h, h + STOCK_MM, -60, 60, 'stock', 'stock'));
  } else if (s.kind === 'film') {
    g.add(bed(-90, 90, -70, 70));
    for (const x of [-48, 0, 48]) {
      g.add(box(x - across / 2, x + across / 2, 0, Math.max(h, 0.01), -along / 2, along / 2, 'cuttable', 'film'));
    }
    g.add(box(-80, 80, h, h + STOCK_MM, -65, 65, 'stock', 'stock'));
  } else if (s.kind === 'through') {
    const depth = s.depthMm ?? STOCK_MM + 5;
    // A deeper spoilboard so the part of the fastener below the stock shows.
    g.add(bed(-60, 60, -40, 40, Math.max(depth - STOCK_MM + 4, 6)));
    g.add(box(-55, 55, 0, STOCK_MM, -35, 35, 'stock', 'stock'));
    const keep = s.footprintMm[0];
    for (const x of [-36, 0, 36]) {
      g.add(cyl(FASTENER_DIA_STANDIN / 2, STOCK_MM - depth, STOCK_MM + 0.2, s.cuttable ? 'cuttable' : 'steel', { x, name: 'fastener', seg: 24 }));
      if (keep > 0) g.add(box(x - keep / 2, x + keep / 2, 0, STOCK_MM, -keep / 2, keep / 2, 'keepout', 'keepout'));
    }
  } else if (s.kind === 'bed') {
    g.add(bed(-100, 100, -70, 70, 6));
    if (s.gridPitchMm) {
      const holeD = across > 0 ? across : 20;
      for (let x = -96; x <= 96; x += s.gridPitchMm) {
        for (let z = -48; z <= 48; z += s.gridPitchMm) {
          g.add(cyl(holeD / 2, -6, 0.05, 'hidden', { x, z, name: 'hole', seg: 32 }));
        }
      }
      g.add(box(-30, 60, 0, STOCK_MM, -40, 30, 'stock', 'stock'));
    } else {
      g.add(box(-90, 90, 0, STOCK_MM, -60, 60, 'stock', 'stock'));
      if (s.holds) g.add(box(-100, 100, -0.6, 0.02, -70, 70, 'cuttable', 'vacuum-field'));
    }
  } else {
    // 'tool' — the pressure foot rides the spindle. No catalogue dimension
    // exists for any of it, so every part is `assumed`.
    g.add(bed(-60, 60, -40, 40));
    g.add(box(-55, 55, 0, STOCK_MM, -35, 35, 'stock', 'stock'));
    const foot = new THREE.Shape();
    foot.absarc(0, 0, 26, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, 10, 0, Math.PI * 2, true);
    foot.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(foot, { depth: 8, bevelEnabled: false, curveSegments: 48 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, STOCK_MM, 0);
    const m = mesh(geo, 'assumed', 'foot');
    g.add(m);
    g.add(edgesOf(m, 'assumed'));
    g.add(cyl(9, STOCK_MM + 22, STOCK_MM + 52, 'assumed', { name: 'spindle' }));
    g.add(cyl(2, STOCK_MM - 10, STOCK_MM + 22, 'cuttable', { name: 'cutter', seg: 24 }));
  }
  return g;
}

/** Free every geometry under `root`. Materials are shared and owned by the renderer. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g) g.dispose();
  });
}
