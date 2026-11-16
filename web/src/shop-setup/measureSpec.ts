/* measureSpec.ts — WHAT TO MEASURE, AS A SCENE, WITH NO RENDERER IN IT.
 *
 * Founder, 2026-10-14: *"if measurement needed the system will show what needs
 * to be measured and how"*, *"show it in an image"*, then *"not svg, show it in
 * 3d!"*.
 *
 * This file is the pure layer: plain data describing a few primitive parts and
 * the one dimension being asked for. `Measure3D.tsx` turns it into a three.js
 * scene. Keeping three out of here means the scenes are testable in node (no
 * WebGL) and reusable by any page that needs a "measure this" picture — the
 * router page builds its own scenes on these same types.
 *
 * ⚠ THESE ARE ILLUSTRATIONS, NOT MODELS. Proportions are chosen to make the
 * asked dimension obvious, not to match any real cutter. Nothing reads a number
 * out of a scene, and nothing may: the operator's calipers are the source.
 *
 * Conventions: Y is up, units are arbitrary scene units, the scene is framed on
 * the bounding box of its parts by the renderer.
 */

export type Vec3 = [number, number, number];

export interface Part {
  shape: 'box' | 'cylinder' | 'cone';
  /** box: width, height, depth. cylinder/cone: radiusTop, radiusBottom, height. */
  size: Vec3;
  /** Centre of the part. */
  at: Vec3;
  /** Euler rotation, radians. */
  rot?: Vec3;
  /** `highlight` = the part being measured (drawn in --accent). */
  role: 'body' | 'highlight';
}

export interface DimLine {
  from: Vec3;
  to: Vec3;
  /** Shown as an HTML label at the projected midpoint. Names the field. */
  label: string;
}

export interface MeasureScene {
  parts: Part[];
  dims: DimLine[];
  /** Camera position. The renderer looks at the parts' bounding-box centre. */
  camera?: Vec3;
}

/** The tool fields that have a "measure this" scene. Same keys as
 *  `toolRegistry.ts`'s `MeasuredField`. */
export type EndMillField =
  | 'diameter_mm'
  | 'flutes'
  | 'cutting_length_mm'
  | 'shank_mm'
  | 'overall_length_mm'
  | 'included_angle_deg';

export const END_MILL_FIELDS: readonly EndMillField[] = [
  'diameter_mm',
  'flutes',
  'cutting_length_mm',
  'shank_mm',
  'overall_length_mm',
  'included_angle_deg',
];

/** Label each scene's DimLine carries — the field's own name, so a reader of
 *  the picture and a reader of the form see the same words. */
export const END_MILL_DIM_LABEL: Record<EndMillField, string> = {
  diameter_mm: 'Cutting diameter',
  flutes: 'Flutes — count the edges',
  cutting_length_mm: 'Cutting length',
  shank_mm: 'Shank diameter',
  overall_length_mm: 'Overall length',
  included_angle_deg: 'Included angle',
};

/* Proportions: tip at y = 0, fluted part 0..FL, shank FL..FL+SL. */
const R = 3; // cutting radius
const RS = 3; // shank radius (same as cutting, the common case)
const FL = 22; // fluted length
const SL = 26; // shank length
const TOP = FL + SL;

/** A plain end mill: fluted cylinder, two helix-ish edge strips, shank. */
function endMill(highlight: { flutes?: boolean; edges?: boolean; shank?: boolean }): Part[] {
  const role = (on?: boolean): Part['role'] => (on ? 'highlight' : 'body');
  const parts: Part[] = [
    { shape: 'cylinder', size: [R * 0.92, R * 0.92, FL], at: [0, FL / 2, 0], role: role(highlight.flutes) },
    { shape: 'cylinder', size: [RS, RS, SL], at: [0, FL + SL / 2, 0], role: role(highlight.shank) },
  ];
  /* Two cutting-edge strips, tilted, on opposite sides — enough to read as a
   * fluted cutter and to give "count the edges" something to count. */
  for (const side of [1, -1]) {
    parts.push({
      shape: 'box',
      size: [0.6, FL * 1.02, 0.9],
      at: [side * R * 0.9, FL / 2, 0],
      rot: [side * 0.35, 0, 0],
      role: role(highlight.edges),
    });
  }
  return parts;
}

/**
 * The scene for one measured end-mill field: the measured part highlighted and
 * exactly one dimension line, labelled with the field's name.
 */
export function endMillScene(field: EndMillField): MeasureScene {
  const label = END_MILL_DIM_LABEL[field];
  switch (field) {
    case 'diameter_mm':
      return {
        parts: endMill({ flutes: true, edges: true }),
        dims: [{ from: [-R, 3, R + 1.5], to: [R, 3, R + 1.5], label }],
        camera: [14, 18, 34],
      };
    case 'flutes':
      return {
        parts: endMill({ edges: true }),
        /* Looking up at the tip: the line runs edge to edge across it. */
        dims: [{ from: [-R * 0.9, -1.5, 0], to: [R * 0.9, -1.5, 0], label }],
        camera: [6, -22, 18],
      };
    case 'cutting_length_mm':
      return {
        parts: endMill({ flutes: true, edges: true }),
        dims: [{ from: [R + 3, 0, 0], to: [R + 3, FL, 0], label }],
        camera: [10, 24, 46],
      };
    case 'shank_mm':
      return {
        parts: endMill({ shank: true }),
        dims: [{ from: [-RS, FL + SL * 0.6, RS + 1.5], to: [RS, FL + SL * 0.6, RS + 1.5], label }],
        camera: [14, 40, 34],
      };
    case 'overall_length_mm':
      return {
        parts: endMill({ flutes: true, edges: true, shank: true }),
        dims: [{ from: [R + 4, 0, 0], to: [R + 4, TOP, 0], label }],
        camera: [12, 24, 62],
      };
    case 'included_angle_deg': {
      /* A V-bit: shank plus a cone whose point is the tip. The line spans the
       * mouth of the V, which is where the angle opens. */
      const cone = 8;
      return {
        parts: [
          { shape: 'cone', size: [R * 1.6, 0, cone], at: [0, cone / 2, 0], role: 'highlight' },
          { shape: 'cylinder', size: [RS, RS, SL], at: [0, cone + SL / 2, 0], role: 'body' },
        ],
        dims: [{ from: [-R * 1.6, cone + 0.5, R * 1.6 + 1], to: [R * 1.6, cone + 0.5, R * 1.6 + 1], label }],
        camera: [10, 12, 36],
      };
    }
  }
}
