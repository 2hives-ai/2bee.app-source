// THE CORNER ORIENTATION GIZMO, AND THE NAMED VIEWS IT CLICKS TO.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THIS IS A REVERSAL OF A FOUNDER RULING, AND SAYING SO IS THE POINT
// ═══════════════════════════════════════════════════════════════════════════
//
// A corner gizmo existed in `preview.tsx` and was REMOVED, on the founder's
// instruction to put the XYZ arrows near the object instead — the pivot triad at
// the orbit centre took over as the orientation indicator, and the removal is
// still recorded in that file at the second render pass.
//
// The founder asked for the corner gizmo BACK on 2026-09-09, pointing at a
// product-page 3D viewer: *"I like the top right corner xyz, and menu structure
// on the bottom"*. ⚠ **That does not delete the earlier ruling and it must not
// be written as though the earlier one never happened** — both are real, the
// second supersedes the first, and a reader who finds only the second cannot
// tell a reversal from a mistake.
//
// **The two do not conflict, and this is why both can stand:** the pivot triad
// answers *"what is the view turning about?"* and lives in the WORLD, at the
// orbit centre, where a pan moves it. This gizmo answers *"which way is the
// camera pointing?"* and lives on the SCREEN, where nothing moves it. They are
// different questions and the old gizmo was removed for being read as the first.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY THIS IS GEOMETRY IN A PURE MODULE AND NOT A SECOND THREE.JS SCENE
// ═══════════════════════════════════════════════════════════════════════════
//
// The removed one was a scissored WebGL pass. Bringing that back would give an
// indicator that cannot be CLICKED without a raycaster and a second camera, and
// the founder's ask is explicitly click-to-orient — the corner widget on the
// page he pointed at snaps the view.
//
// So the gizmo is DOM. Its positions come from the same `theta`/`phi` the orbit
// runs on, through the same basis three.js's `lookAt` builds, derived below
// rather than sampled from the renderer. ⇒ **It cannot disagree with the camera,
// because it is computed from the camera's own two numbers** — and the click
// targets are real elements, so a test can press one.

/** Where the eye sits, as the viewport's orbit parameterises it. */
export interface Orbit {
  /** Azimuth, radians. */
  theta: number;
  /** Polar angle from +Z, radians. `0` is straight down the +Z axis. */
  phi: number;
}

/** One axis stub, in gizmo space: a unit disc, x right, y UP. */
export interface GizmoAxis {
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
  /** Label — `X`/`Y`/`Z` for the positive ends, empty for the negative ones. */
  label: string;
  /** −1…1, x right. */
  x: number;
  /** −1…1, y UP. ⚠ SVG's y runs DOWN; the caller negates. */
  y: number;
  /**
   * How far toward the viewer this end points, −1…1.
   *
   * 🔴 IT IS WHAT MAKES THE PICTURE READABLE, not decoration: an axis pointing
   * away must be drawn behind and dimmer, or a gizmo at 45° is ambiguous
   * between two orientations that are 180° apart. The caller sorts on it.
   */
  depth: number;
}

/**
 * The six axis ends, for a camera at `theta`/`phi`.
 *
 * The basis is three.js's `lookAt` with `up = +Z`, which is what `place()` in
 * `preview.tsx` sets:
 *
 * ```
 *   d      = (sinφcosθ, sinφsinθ, cosφ)          eye = target + radius·d
 *   z_cam  = d                                    (points AT the viewer)
 *   x_cam  = normalize(up × z_cam) = (−sinθ, cosθ, 0)
 *   y_cam  = z_cam × x_cam        = (−cosφcosθ, −cosφsinθ, sinφ)
 * ```
 *
 * ⚠ `x_cam`'s normalisation would divide by `sinφ`, and the closed form above
 * does not — so this function stays finite at the poles where the raw cross
 * product collapses. **That is a property of this derivation, not of the
 * camera:** three.js's own `lookAt` DOES degenerate when the view direction is
 * parallel to `up`, which is why {@link NAMED_VIEWS}'s top and bottom are
 * nudged off the pole rather than set to exactly 0 and π.
 */
export function gizmoAxes({ theta, phi }: Orbit): GizmoAxis[] {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);

  // (screen-x, screen-y, depth) for the three POSITIVE unit axes.
  const positive: { axis: 'x' | 'y' | 'z'; v: [number, number, number] }[] = [
    { axis: 'x', v: [-st, -cp * ct, sp * ct] },
    { axis: 'y', v: [ct, -cp * st, sp * st] },
    { axis: 'z', v: [0, sp, cp] },
  ];

  const out: GizmoAxis[] = [];
  for (const { axis, v } of positive) {
    out.push({ axis, sign: 1, label: axis.toUpperCase(), x: v[0], y: v[1], depth: v[2] });
    // 🔴 THE NEGATIVE ENDS ARE DRAWN AND ARE NOT LABELLED. Without them the
    // gizmo has three arms and a viewer cannot click "look from −X"; with six
    // letters it is a wall of text at 64 px. The unlabelled ball is the click
    // target, and its tooltip carries the name.
    out.push({ axis, sign: -1, label: '', x: -v[0], y: -v[1], depth: -v[2] });
  }
  return out;
}

/** The name of a view the gizmo or the bottom bar can snap to. */
export type ViewName = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/**
 * 🔴 A NUDGE, NOT A ROUNDING. `top` is `phi = POLE_EPS` rather than `0`, and
 * `bottom` is `π − POLE_EPS`.
 *
 * At exactly `phi = 0` the view direction is parallel to `camera.up` (+Z), so
 * `lookAt`'s cross product is the zero vector and the resulting matrix has no
 * defined roll — three.js resolves it arbitrarily and the picture can flip. A
 * top view is one of the two views a user is most likely to ask for, so the
 * degenerate case is the COMMON case here, not an edge one.
 *
 * ⚠ The value is large enough to define the basis and small enough that the
 * view reads as square-on: at 0.001 rad the camera is 0.06° off vertical, which
 * is ~1 pixel of skew across a 1000-pixel viewport.
 */
export const POLE_EPS = 0.001;

/**
 * Where each named view puts the eye.
 *
 * ⚠ THE NAMES ARE THE OPERATOR'S, NOT THE MATHS'. "Front" is the view looking
 * along +Y (the eye on −Y), because that is the face an operator calls the front
 * of a hive body standing on the XY plane — the same convention the CNC tab's
 * fixture drawings use. Getting this backwards produces a viewer that works
 * perfectly and disagrees with every drawing beside it.
 */
export const NAMED_VIEWS: Record<ViewName, Orbit> = {
  /* The tab's own opening camera, so `iso` is `home` and not a second opinion
   * about what home means. Kept in step with `preview.tsx`'s initial values by
   * `tests/cad-gizmo.test.ts`, which reads them out of that file's source. */
  iso: { theta: -Math.PI / 4, phi: Math.PI / 3.2 },
  top: { theta: -Math.PI / 2, phi: POLE_EPS },
  bottom: { theta: -Math.PI / 2, phi: Math.PI - POLE_EPS },
  front: { theta: -Math.PI / 2, phi: Math.PI / 2 },
  back: { theta: Math.PI / 2, phi: Math.PI / 2 },
  right: { theta: 0, phi: Math.PI / 2 },
  left: { theta: Math.PI, phi: Math.PI / 2 },
};

/** Which named view an axis end corresponds to, for the gizmo's click targets. */
export function viewForAxis(axis: 'x' | 'y' | 'z', sign: 1 | -1): ViewName {
  if (axis === 'x') return sign === 1 ? 'right' : 'left';
  if (axis === 'y') return sign === 1 ? 'back' : 'front';
  return sign === 1 ? 'top' : 'bottom';
}

/** The sentence the control carries, so the label and the tooltip cannot drift. */
export function viewTitle(v: ViewName): string {
  if (v === 'iso') return 'Isometric — the view this tab opens on';
  return `Look from ${v} — the camera moves, the model does not`;
}
