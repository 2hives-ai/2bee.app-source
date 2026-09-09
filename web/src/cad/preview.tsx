// 2bee.cad stage 2 — the 3D preview.
//
// 🔴 THE ONE RULE THIS FILE EXISTS TO KEEP. A viewport is the most persuasive
// artefact this lane produces: a shaded solid looks finished in a way a scene
// tree never does, and the person looking at it is deciding whether to cut it.
// So everything the kernel could not establish is stated ON THE PICTURE, and
// anything that would have to be guessed is not drawn at all:
//
//   · A part whose audit is not `closed` is drawn in the ERROR colour with its
//     wireframe over it, so it cannot be mistaken for a clean solid at a glance,
//     and the verdict is named in the overlay. It is deliberately NOT drawn in
//     the normal material and quietly listed in a panel somewhere.
//   · A refused construct is drawn as NOTHING — no ghost, no outline, no
//     placeholder. A refused `difference()` does not get its operands drawn:
//     that would show material the source says was removed. The mesher's own
//     `trustDetail` — printed here whenever the verdict is not clean — is what
//     says the picture is a SUBSET of the model, and it carries the count.
//     ⚠ The ITEMISED list is the console pane's, and the number of rows it
//     holds is on the dock tab's badge, which is visible whatever pane is
//     showing. This surface no longer repeats either.
//   · A 2D shape is drawn as a zero-thickness plate in a muted colour, labelled
//     2D, and casts no shadow. Giving it a thickness would invent an extrusion
//     the source never wrote.
//   · While the source has changed and the mesh has not caught up, the whole
//     viewport is marked STALE and dimmed. An out-of-date picture presented as
//     current is the same lie as a wrong one, arriving more slowly.
//
// House style: `MeshStandardMaterial` with `flatShading`, low-poly, real
// shadows. Every colour is RESOLVED at runtime from the brand tokens through a
// hidden probe element — the same mechanism `Viewport.tsx` uses and for the same
// reason: `web/src/styles.css` keeps no palette of its own, so a hex literal
// here would be a second copy of a value this app deliberately stopped holding.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { MeshPart, MeshResult } from './mesh';
import {
  AXES,
  AXIS_DIRECTION,
  TICK_DIRECTION,
  rulerPlan,
  rulerSignature,
  type RulerPlan,
} from './rulers';
import {
  CAMERA_FOV_DEG,
  orthoFrustum,
  worldPerPixel,
  type Projection,
} from '../projection';
// 🔴 THE GL GUARD AND THE ABSENCE PANEL ARE SHARED WITH THE CNC VIEWPORT, ON
// PURPOSE. There are exactly two `WebGLRenderer` construction sites in this app
// and both fail the same way — an exception out of an effect blanks the whole
// tree — so a fix that lived in one file would be half a fix, and two copies of
// the same sentence would be two sentences to keep true.
// ⚠ It lives in `Viewport.tsx` rather than in a module of its own because that
// was the boundary of the change that added it; a later pass may well want it
// somewhere neutral, and nothing here depends on where it sits.
import { GlUnavailable, tryRenderer } from '../Viewport';

/**
 * The origin triad's colours — X red, Y green, Z blue.
 *
 * 🔴 THIS IS A DELIBERATE COPY OF `Viewport.tsx`'s `AXIS_COLOR`, STATED RATHER
 * THAN AN ACCIDENT. That constant is module-private there and `Viewport.tsx` is
 * another lane's live file, so exporting it was not this change's to do. **Two
 * tabs disagreeing about which axis is Y is worse than neither having arrows**,
 * so the duplication is guarded: `tests/cad-camera-parity.test.ts` reads both
 * files and goes red if the six hex digits ever stop matching. If the two files
 * are ever free at the same time, this belongs in one module and the test
 * becomes an import.
 *
 * ⚠ The convention is not ours and is not a style choice: OpenSCAD's own
 * `showSmallaxes` uses (1,0,0) / (0,1,0) / (0,0,1) for X / Y / Z
 * (`src/glview/GLView.cc`), and so does every controller an operator has seen.
 * These are INSTRUMENT colours and stay outside the brand palette for the same
 * reason the move classes do — brand ruled instrument/safety colours out of
 * scope on purpose (2026-08-08).
 */
const AXIS_COLOR = { x: 0xd32f2f, y: 0x388e3c, z: 0x1976d2 };

/**
 * Where the camera is, as four numbers that survive a page refresh.
 *
 * 🔴 THE ZOOM IS ONE SCALAR AND IT IS `radius`, NOT A PROJECTION-SPECIFIC
 * NUMBER. `540bab9d66` established that at OpenSCAD's own source: there is one
 * `viewer_distance`, and the orthographic half-height is DERIVED from it
 * (`orthoHalfHeight`). Storing a frustum extent instead would be a second zoom
 * quantity that disagrees with the perspective one the moment either is
 * restored — which is the exact defect `projection.ts` exists to prevent. The
 * projection MODE is not in here either: it is the layout blob's, beside the
 * ruler toggles, where OpenSCAD keeps it too.
 *
 * ⚠ `target` IS THE ORBIT CENTRE, so restoring it restores what a pan did. It
 * is not `framing()`'s pivot — the two agree until the operator pans, and then
 * the pivot is what `Fit` would go back to and this is where they actually are.
 */
export interface CadCamera {
  /** Orbit azimuth, radians. */
  theta: number;
  /** Orbit elevation, radians, within the same band the drag handler clamps. */
  phi: number;
  /** THE zoom scalar — the orbit distance. See the note above. */
  radius: number;
  /** The orbit centre in world millimetres. */
  target: [number, number, number];
}

/**
 * Validate a camera that came back out of a store.
 *
 * 🔴 SAME RULE AS `readLayout` AND `readProjection`: a preference store going
 * bad may not put the viewport into a state nobody chose. Anything that is not
 * four finite numbers and a three-number target comes back `null`, which means
 * *"frame the model as usual"* — the behaviour of a browser that has never seen
 * this tab. A partial restore is not attempted: a camera with a good `radius`
 * and a `NaN` target is a black screen, and half a camera is not half a view.
 *
 * ⚠ `radius` AND `phi` ARE CLAMPED RATHER THAN REFUSED, because both have a
 * legitimate range this viewport already enforces on every gesture, and a value
 * one notch outside it is far more likely to be an old build's than an attack.
 * `theta` is not clamped: it is an angle and every real number is a direction.
 */
export function readCamera(v: unknown): CadCamera | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Partial<CadCamera>;
  const t = c.target;
  if (!Array.isArray(t) || t.length !== 3) return null;
  const nums = [c.theta, c.phi, c.radius, ...t];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    theta: c.theta as number,
    phi: Math.min(Math.PI - 0.05, Math.max(0.05, c.phi as number)),
    radius: Math.min(ZOOM_CLAMP.max, Math.max(ZOOM_CLAMP.min, c.radius as number)),
    target: [t[0] as number, t[1] as number, t[2] as number],
  };
}

export interface CadPreviewProps {
  result: MeshResult;
  /** The source has changed and this mesh is from the previous one. */
  stale: boolean;
  /**
   * The camera to open on, or `null` to frame the first model as usual.
   *
   * 🔴 READ EXACTLY ONCE, IN THE SETUP EFFECT, AND IT SUPPRESSES THE AUTOMATIC
   * FIT. Restoring a camera and then letting the first non-empty scene frame
   * itself would be a restore nobody can see — the founder would report the same
   * thing again and the code would look correct. So a seed sets `framedOnce`,
   * which is the one flag that automatic framing is gated on.
   *
   * ⚠ It is deliberately NOT a live prop. A camera pushed in on every render
   * would fight the operator's own orbit, which is the "viewport lurches under
   * your hands" defect this file has already fixed once for the mesh.
   */
  initialCamera?: CadCamera | null;
  /**
   * The camera moved. Debounced here, so a wheel spin is one call and not forty.
   *
   * ⚠ IT MUST NOT BE A `setState`. This fires from a pointer handler on a
   * surface whose whole interaction is dragging; a re-render per notch is the
   * thrash, not the storage. The caller is expected to write it somewhere and
   * return.
   */
  onCameraChange?: (camera: CadCamera) => void;
  /**
   * OpenSCAD's `view/showAxes`. Draws the origin cross AND the corner gizmo —
   * `GLView.cc:196`, `:225` and `:198` all gate on this one flag.
   */
  showAxes: boolean;
  /**
   * OpenSCAD's `view/showScaleProportional`. 🔴 A CHILD OF {@link showAxes}:
   * the renderer ANDs them (`GLView.cc:198`) and the menu disables this control
   * while axes are off (`MainWindow.cc:2761`). This component ANDs them too, so
   * a caller that lets the two disagree still cannot produce ticks with no axis
   * to sit on.
   */
  showScaleMarkers: boolean;
  /**
   * OpenSCAD's `view/orthogonalProjection`, as the word rather than as a bool.
   *
   * 🔴 REQUIRED, NOT OPTIONAL WITH A DEFAULT. A default here would let a caller
   * that forgot to wire the menu render a viewport that ignores the setting the
   * operator just changed — a control that looks live and reaches nothing. A
   * required prop makes that a red build at the one call site instead.
   *
   * ⚠ IT IS NOT A ZOOM. See `projection.ts`: this selects how the projection
   * matrix is built and touches no camera state. The orbit distance, the wheel,
   * the clamps, `Fit` and the ruler's decade are the same in both modes.
   */
  projection: Projection;
}

/**
 * 🔴 WHERE THE CAMERA ORBITS, AND HOW FAR AWAY IT SITS TO SEE THE WHOLE MODEL.
 *
 * Founder 2026-08-11: *"the center (mouse rotation) should be in the middle of
 * the base area"* — so the pivot is the bounding box's XY centre at **z = 0**,
 * not the box centre. What it WAS, measured before changing it: `frameScene`
 * took `centre`, the full three-axis midpoint of the bounds, so a 40 mm-tall box
 * standing on the bed orbited about a point 20 mm up in the air.
 *
 * 🔴 AND THE FRAMING RADIUS IS RE-DERIVED, NOT INHERITED. `span` used to be the
 * largest edge of the box, which is the right answer only while the camera looks
 * at the box's own centre. Moving the pivot down to z = 0 moves the model
 * off-centre in the view by exactly the height it stands, so the same radius no
 * longer contains it. This measures the half-extents **about the pivot** — which
 * makes the z half-extent `max(|z_max|, |z_min|)` rather than half the height —
 * so `Fit` still frames what the camera orbits. For a model already centred on
 * z = 0 the two agree exactly.
 *
 * 🔴 `null` IS THE WHOLE FALLBACK, AND IT IS THE ANSWER TO A REAL CASE. This tab
 * parses on every keystroke and a refusal cascade renders the tree minus every
 * subtree, so a scene can go momentarily empty in the middle of an edit — half a
 * typed `difference(`. `null` means **do not move the camera**: the caller keeps
 * the last framing it had. A pivot computed from empty bounds would be
 * `(0,0,0)` with an invented span, which is a camera move caused by a keystroke,
 * and is exactly the lurch this pivot change must not introduce.
 */
export interface SceneBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

export interface Framing {
  /** The orbit target. XY centre of the bounds, at z = 0. */
  pivot: [number, number, number];
  /** The largest full extent about that pivot. `frameScene` scales it. */
  span: number;
}

/**
 * 🔴 THE `&&` FROM `GLView.cc:198`, AS A FUNCTION SO IT CAN BE WATCHED GOING
 * RED.
 *
 * OpenSCAD renders its scale markers on `if (showaxes && showscale)`. Written
 * inline in a render loop that no harness can reach, this rule would be one
 * nothing asserts — and its failure is silent in the worst direction: ticks
 * drawn with no axis line under them, while the menu says the axes are off.
 */
export function rulersDrawn(showAxes: boolean, showScaleMarkers: boolean): boolean {
  return showAxes && showScaleMarkers;
}

export function framing(bounds: SceneBounds | null): Framing | null {
  if (!bounds) return null;
  const [ax, ay, az] = bounds.min;
  const [bx, by, bz] = bounds.max;
  if (![ax, ay, az, bx, by, bz].every((v) => Number.isFinite(v))) return null;

  const pivot: [number, number, number] = [(ax + bx) / 2, (ay + by) / 2, 0];
  /* Half-extents ABOUT THE PIVOT. X and Y reduce to half the box because the
   * pivot is their midpoint; Z does not, because the pivot is at zero and the
   * model may sit entirely above it. `Math.abs` on both ends rather than
   * `bz - 0`: a model built downward from the origin is the same problem
   * mirrored, and `bz` alone would be negative for it. */
  const half = Math.max(
    (bx - ax) / 2,
    (by - ay) / 2,
    Math.abs(bz),
    Math.abs(az),
  );
  return { pivot, span: Math.max(2 * half, 1) };
}

/** How a part is painted, decided by its audit and nothing else. */
type Paint = 'solid' | 'unsound' | 'flat';

function paintOf(p: MeshPart): Paint {
  if (p.dim === 2) return 'flat';
  return p.audit && p.audit.verdict === 'closed' ? 'solid' : 'unsound';
}

/**
 * 🔴 THE FLOOR UNDER A SOURCE-SPECIFIED ALPHA, AND WHY THERE IS ONE.
 *
 * This tab reserves ONE meaning for "you can see nothing here": the construct
 * was REFUSED and no geometry exists. `color("red", 0) cube(3)` still exports 12
 * facets in OpenSCAD — the solid is entirely there — so honouring alpha 0 to the
 * letter would draw a present part exactly as this file draws an absent one, and
 * the operator's only cue for the difference is a count in a panel.
 *
 * ⚠ IT IS A KNOWN, NAMED DIVERGENCE FROM OPENSCAD, not an oversight — OpenSCAD's
 * own preview does make an alpha-0 subtree invisible. Recorded in
 * `docs/audit/2026-08-11-scad-silent-divergence.md`.
 */
export const MIN_VISIBLE_OPACITY = 0.12;

/**
 * The corner gizmo's screen box, in CSS pixels — and the reason it is a shared
 * constant rather than two numbers.
 *
 * 🔴 THE BOTTOM-LEFT OF THIS CANVAS USED TO BE OCCUPIED, AND THE FIX IS NOW
 * STRUCTURAL RATHER THAN NUMERIC. `cad-preview-verdict` was a DOM overlay ON TOP
 * of the canvas at `left: 8, right: 8, bottom: 8`, present on every model — so a
 * gizmo drawn into the bottom-left of the WebGL surface rendered correctly and
 * was completely hidden behind it. The answer at the time was a shared
 * `GIZMO_CLEARANCE` that the box indented by, plus a test asserting the two
 * could not drift apart.
 *
 * ⚠ BOTH ARE GONE (2026-08-11, founder: *"remove cad-preview-verdict"*), AND
 * THEY WERE REMOVED TOGETHER RATHER THAN LEFT AS ORPHANS. **Every DOM overlay on
 * this picture is now anchored to the TOP**, so nothing can reach the
 * bottom-left corner at any pane size — a guarantee about the layout rather than
 * a number that has to keep matching another number. A constant and a test
 * guarding a collision that can no longer happen are the dead controls this lane
 * keeps filing, so the replacement assertion in
 * `tests/cad-camera-parity.test.ts` is on the PROPERTY: no overlay carries a
 * `bottom:`.
 */
export const GIZMO_BOX = { pad: 10, min: 56, max: 128 } as const;

/**
 * The wheel's zoom clamp, as data.
 *
 * 🔴 IT EXISTS BECAUSE {@link readCamera} HAS TO CLAMP THE SAME RANGE. A restored
 * camera comes out of a store anybody can edit, and a `radius` of `1e12` would
 * put the operator somewhere no gesture can reach — so the validator clamps. The
 * wheel handler keeps its literals (`tests/cad-camera-parity.test.ts` reads them
 * to prove the CAD clamp has not collapsed onto the machine-sized CNC one), so
 * this is a SECOND copy of two numbers, and a second copy with no guard is a
 * drift waiting for its first edit. `tests/cad-session.test.ts` reads the wheel
 * line out of this file and asserts it against these two fields.
 */
export const ZOOM_CLAMP = { min: 1, max: 200000 } as const;

/**
 * How long the camera must sit still before it is reported for storage.
 *
 * Long enough that one wheel spin or one drag is a single call; short enough
 * that a refresh a moment after letting go still restores where you were. The
 * mesh debounce next door is 250 ms for the same kind of reason.
 */
const CAMERA_SAVE_MS = 400;

/** How long the orbit-centre triad is on screen, in CSS pixels. */
const PIVOT_TRIAD_PX = 64;

/** A 2D plate's translucency, unchanged from before colour existed. */
const FLAT_OPACITY = 0.55;

/** What one part's material is, decided from the part and nothing else. */
export interface PartMaterial {
  /**
   * `#rrggbb` when the SOURCE said what colour this is; `null` when the theme
   * decides (which is every part that no `color()` covered, and every part the
   * rules below refuse to obey).
   */
  colour: string | null;
  opacity: number;
  transparent: boolean;
  /**
   * Non-null ⇒ the source stated a colour and it was deliberately NOT used.
   * The reason, so the overlay can say it rather than the picture quietly
   * disagreeing with the text the operator wrote.
   */
  overridden: 'unsound' | null;
}

const hex2 = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');

/**
 * A line of text as a camera-facing sprite, sized in WORLD units.
 *
 * 🔴 ONE WRITER, TWO CALLERS. The gizmo's X/Y/Z letters and the ruler's numbers
 * are the same problem — draw a glyph in a 3D scene that stays readable at any
 * orientation — and they were about to be two copies of the same forty lines.
 * The aspect ratio is measured from the 2D context rather than assumed, because
 * `-12.5` is four times as wide as `X` and a square sprite would squash it.
 *
 * ⚠ IT IS A SPRITE, WHERE OPENSCAD DRAWS HERSHEY VECTOR TEXT IN THE AXIS PLANE
 * (`GLView.cc:609 decodeMarkerValue`). A sprite always faces the viewer, so the
 * number is legible from every orbit position; OpenSCAD's lies flat and is read
 * edge-on from some. This is the CNC tab's approach and the one the corner gizmo
 * already uses, so it is also the one this app is consistent with.
 *
 * ⚠ The caller disposes. Every returned object is in `junk`.
 */
function glyphSprite(
  text: string,
  fill: string,
  size: number,
): { sprite: THREE.Sprite; junk: { dispose(): void }[] } {
  const cell = 128;
  const font = `bold ${Math.round(cell * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
  const cv = document.createElement('canvas');
  const ctx2d = cv.getContext('2d');
  let ratio = 1;
  if (ctx2d) {
    ctx2d.font = font;
    cv.width = Math.ceil(Math.max(cell * 0.7, ctx2d.measureText(text).width + cell * 0.4));
    cv.height = cell;
    ratio = cv.width / cv.height;
    ctx2d.font = font; // sizing the canvas resets the 2d context
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.lineWidth = Math.round(cell * 0.13);
    ctx2d.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx2d.strokeText(text, cv.width / 2, cv.height / 2);
    ctx2d.fillStyle = fill;
    ctx2d.fillText(text, cv.width / 2, cv.height / 2);
  } else {
    cv.width = cell;
    cv.height = cell;
  }
  const texture = new THREE.CanvasTexture(cv);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size * ratio, size, 1);
  return { sprite, junk: [texture, material] };
}

/**
 * The SHAPE of an axis arrow, as multiples of its own length. Never a position.
 *
 * 🔴 THE PLACEMENT RULE IS DELIBERATELY NOT IN HERE, and that is the whole
 * reason this is a form and not a component. The two tabs' z = 0 mean different
 * things: in the CNC scene it is the DECLARED work zero (`ZDatum` —
 * workpiece top or spoilboard top), and here it is OpenSCAD's world origin,
 * which is not a datum at all. A shared thing that carried a placement would
 * carry one tab's datum into the other, one level up where it is harder to see.
 * So the caller says where; this says what it looks like.
 *
 * ⚠ PREMISE CORRECTED 2026-08-11, CONCLUSION UNCHANGED. This paragraph used to
 * say `Viewport.tsx` lifts its triad to `aZ = 0.4`. It no longer does —
 * `37bdb0bc6d` removed the lift after measuring it at 0.23px in the view the
 * founder was actually looking at, i.e. it was never what he saw (*"the xyz
 * arros center seems on top of the workpeace"*; the geometry was, and `ZDatum`
 * is the fix). The lift is gone, the reason to keep placement out of a shared
 * form is not: it was never about that particular 0.4mm.
 */
export interface TriadForm {
  /** Arrowhead radius, ×length. */
  coneRadius: number;
  /** Arrowhead height, ×length. */
  coneHeight: number;
  coneSegments: number;
  /** Where the letter hangs, ×length from the arrow's root. */
  labelAt: number;
  /** Letter height, ×length. */
  labelSize: number;
}

/**
 * 🔴 THE CNC TAB'S ARROW, TRANSCRIBED — founder 2026-08-11: *"have the same xyz
 * arrow in 2bee.cad what already exists in 2bee.cnc"*.
 *
 * Read off `Viewport.tsx`'s `arrow()`: `ConeGeometry(len * 0.05, len * 0.17,
 * 10)`, the letter at `to + dir * len * 0.22` (so `1.22` from the root) at
 * `aLen * 0.3`.
 *
 * ⚠ IT IS A COPY, STATED, FOR THE SAME REASON {@link AXIS_COLOR} IS. A genuinely
 * shared component would have to live in a module both files import, and
 * `Viewport.tsx` is another lane's live file that this change may not edit — so
 * the guard is the one this lane already uses: `tests/cad-camera-parity.test.ts`
 * reads BOTH files and goes red if either set of ratios moves. If the two files
 * are ever free at the same time, this belongs in one module and that test
 * becomes an import.
 */
export const CNC_TRIAD_FORM: TriadForm = {
  coneRadius: 0.05,
  coneHeight: 0.17,
  coneSegments: 10,
  labelAt: 1.22,
  labelSize: 0.3,
};

/**
 * The corner gizmo's own, chunkier, proportions — and they are NOT unified with
 * {@link CNC_TRIAD_FORM} on purpose.
 *
 * ⚠ The gizmo is drawn into a box of 56–128 CSS pixels. A 0.05-radius shaft that
 * reads correctly on a 400-pixel-wide instrument is a hairline at 56, and an
 * orientation indicator nobody can see is the same as no indicator. Only the
 * PIVOT triad has to match the CNC tab — that is what the founder asked for —
 * and it does. Unifying these numbers for tidiness would trade a legible gizmo
 * for a consistent-looking table.
 */
/**
 * One shaft, one arrowhead, one letter — the single writer for both triads in
 * this file.
 *
 * ⚠ EVERY ARROW IS ONE UNIT LONG AND ROOTED AT ITS PARENT'S ZERO. Size and
 * position are the parent group's, which is what lets the same code be a
 * screen-fixed gizmo in one place and a world-space marker that tracks the orbit
 * centre in another, with no branch and no second copy.
 *
 * ⚠ The caller disposes; everything allocated is handed to `keep`.
 */
function axisArrow(opts: {
  dir: THREE.Vector3;
  colour: number;
  label: string;
  form: TriadForm;
  into: THREE.Object3D;
  keep: (x: { dispose(): void }) => void;
  /** False ⇒ drawn through the model. See the callers; both say why. */
  depthTest: boolean;
}): void {
  const { dir, colour, label, form, into, keep, depthTest } = opts;
  const from = new THREE.Vector3(0, 0, 0);
  const to = from.clone().add(dir);

  const shaftGeo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const shaftMat = new THREE.LineBasicMaterial({ color: colour, depthTest, depthWrite: depthTest });
  keep(shaftGeo);
  keep(shaftMat);
  into.add(new THREE.Line(shaftGeo, shaftMat));

  const coneGeo = new THREE.ConeGeometry(form.coneRadius, form.coneHeight, form.coneSegments);
  // Flat-shaded and emissive so the head reads as one instrument colour whatever
  // the key light is doing, rather than as a lit object whose hue depends on
  // where the operator has orbited to.
  const coneMat = new THREE.MeshStandardMaterial({
    color: colour,
    emissive: colour,
    emissiveIntensity: 0.85,
    flatShading: true,
    roughness: 1,
    metalness: 0,
    depthTest,
    depthWrite: depthTest,
  });
  keep(coneGeo);
  keep(coneMat);
  const tip = new THREE.Mesh(coneGeo, coneMat);
  // `ConeGeometry` points along +Y; turn that onto the axis being drawn.
  tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  tip.position.copy(to);
  into.add(tip);

  const made = glyphSprite(label, `#${colour.toString(16).padStart(6, '0')}`, form.labelSize);
  for (const j of made.junk) keep(j);
  made.sprite.position.copy(dir.clone().multiplyScalar(form.labelAt));
  made.sprite.material.depthTest = depthTest;
  made.sprite.material.depthWrite = depthTest;
  into.add(made.sprite);
}

/**
 * 🔴 EXTRACTED FROM THE `useEffect` ON PURPOSE, AND THIS IS THE SECOND TIME THIS
 * FILE HAS HAD TO LEARN IT. `CadPreview` builds its scene inside an effect, and
 * `renderToStaticMarkup` runs no effects — so a colour rule written inline in
 * that effect would be a rule NOTHING IN THE HARNESS COULD REACH, on a surface
 * whose whole job is to be persuasive. Every decision about what a part looks
 * like is taken here, by a pure function over one part.
 *
 * THE TWO PLACES THE SOURCE IS OVERRULED, both deliberate:
 *
 *   1. AN UNSOUND PART IS ALWAYS THE ERROR COLOUR, FULLY OPAQUE. A model whose
 *      audit is not `closed` is meant to be the loudest thing on screen, and a
 *      `color()` in the source must not be able to turn that off — accidentally
 *      or otherwise. `overridden` carries the fact out so the overlay says it.
 *   2. ALPHA IS FLOORED AT {@link MIN_VISIBLE_OPACITY}. See its note.
 *
 * ⚠ WHAT IS NOT DECIDED HERE: transparency SORTING. three.js orders transparent
 * objects back-to-front per OBJECT, not per triangle, so a concave translucent
 * part can show its own far faces in front of its near ones. That is a real
 * artefact of drawing translucency this way and is recorded in the audit rather
 * than left for someone to discover and read as a geometry fault.
 */
export function materialFor(p: MeshPart): PartMaterial {
  const paint = paintOf(p);
  const rgb = p.colour?.rgb ?? null;

  if (paint === 'unsound') {
    return { colour: null, opacity: 1, transparent: false, overridden: rgb ? 'unsound' : null };
  }

  const base = paint === 'flat' ? FLAT_OPACITY : 1;
  const stated = p.colour?.alpha ?? null;
  const opacity =
    stated === null ? base : Math.min(base, Math.max(MIN_VISIBLE_OPACITY, Math.min(1, stated)));

  return {
    colour: rgb ? `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}` : null,
    opacity,
    transparent: opacity < 1,
    overridden: null,
  };
}

/**
 * Parse whatever `getComputedStyle` hands back into a THREE.Color.
 *
 * 🔴 `THREE.Color.setStyle` does NOT parse `color(srgb …)`, and its failure mode
 * is a console warning plus an UNCHANGED colour — a silently wrong scene that no
 * error-watching test would catch. Two of this app's semantic tokens (`--warn`,
 * `--bad`) are `color-mix()` of a brand token, and a browser serialises those in
 * exactly that form. `Viewport.tsx` routes around it by only ever asking for
 * tokens that compute to `rgb()`; this file needs the status colours, so it
 * parses the other form instead of avoiding it.
 */
function cssToColor(text: string): THREE.Color | null {
  const s = text.trim();
  if (!s) return null;
  const nums = (from: string): number[] =>
    (from.match(/-?\d*\.?\d+(?:e[-+]?\d+)?%?/gi) ?? []).map((t) =>
      t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t),
    );
  if (s.startsWith('color(')) {
    // color(<space> r g b / a). srgb and display-p3 are close enough for a
    // viewport tint; srgb-linear is not, so it is converted rather than assumed.
    const v = nums(s.slice(s.indexOf('(') + 1));
    if (v.length < 3) return null;
    const linear = s.includes('srgb-linear');
    const enc = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
    const [r, g, b] = [v[0], v[1], v[2]].map((x) => Math.min(1, Math.max(0, linear ? enc(x) : x)));
    return new THREE.Color(r, g, b);
  }
  if (s.startsWith('rgb') || s.startsWith('#') || /^[a-z]+$/i.test(s)) {
    try {
      return new THREE.Color(s);
    } catch {
      return null;
    }
  }
  return null;
}

export function CadPreview({
  result,
  stale,
  showAxes,
  showScaleMarkers,
  projection,
  initialCamera = null,
  onCameraChange,
}: CadPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  /* 🔴 THE CALLBACK GOES THROUGH A REF, and this is not ceremony. The setup
   * effect has `[]` deps — re-running it would tear down the renderer — so a
   * callback captured there would be whichever one the FIRST render happened to
   * pass, forever. A parent that rebuilds its handler (any `useCallback` with a
   * dependency) would then be writing through a closure over stale state, and
   * the symptom is a session that restores an old camera with no error anywhere. */
  const cameraOut = useRef(onCameraChange);
  useEffect(() => {
    cameraOut.current = onCameraChange;
  }, [onCameraChange]);
  const kit = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    /** Whichever of the two the mode currently selects — see `projection.ts`. */
    camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    key?: THREE.DirectionalLight;
    frame?: number;
    token?: (expr: string) => THREE.Color;
    applyPalette?: () => void;
    frameScene?: (c: THREE.Vector3, r: number) => void;
    /** Re-frame on the last scene, on request. See the note where it is set. */
    refit?: () => void;
    /** 🔴 THE ORBIT TARGET, NOT THE BOX CENTRE — see {@link framing}. */
    lastPivot?: THREE.Vector3;
    lastSpan?: number;
    /** False until the first scene that had any geometry in it at all. */
    framedOnce?: boolean;
    /* ---- the axes, the rulers, and what decides whether they are drawn ---- */
    /** The origin cross. Built per result (it is sized to the model). */
    originAxes?: THREE.Group;
    /**
     * The ruler. 🔴 OWNED BY THE SETUP EFFECT, NOT BY `[result]`, because it is
     * a function of the CAMERA and rebuilding it at the mesh cadence would be a
     * canvas texture per number on every keystroke that settles.
     */
    rulers?: THREE.Group;
    /** Throw away the current ruler geometry and build the plan's. */
    buildRulers?: (plan: RulerPlan | null) => void;
    /**
     * The coloured triad that marks the ORBIT CENTRE. Owned by the setup effect
     * like the ruler and the gizmo, and exempted from the `[result]` sweep by
     * identity for the same reason.
     */
    pivotTriad?: THREE.Group;
    /** How far the origin cross's arms run, so ticks stop where the line does. */
    axisReach?: number;
    /** The live toggles, read by the render loop. Written by an effect. */
    view: { axes: boolean; scale: boolean; projection: Projection };
    dispose: (() => void)[];
    /* Seeded from the props on the FIRST render, not from a hard-coded `true`.
     * The `[result]` effect reads `view.axes` when it builds the origin cross,
     * and both effects run before the toggle effect below — so a hard-coded
     * default would build a visible cross for one commit on a browser where the
     * operator had turned axes off, which is a persisted preference not being
     * honoured on load. */
  }>({ dispose: [], view: { axes: showAxes, scale: showScaleMarkers, projection } });

  /* Whether there is a renderer, MEASURED. `null` until the setup effect has
   * run — published as an absent `data-gl`, never as a word, because "not yet
   * measured" and "measured, and there is none" are different facts. */
  const [gl, setGl] = useState<{ ok: boolean; detail?: string } | null>(null);

  // --- one-time setup -------------------------------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    /* 🔴 GUARDED — same defect, same fix, same reason as `Viewport.tsx`. This
     * line threw straight out of the effect on any machine without working
     * WebGL and unmounted the entire application: the editor, the console, the
     * audit and the source the user had typed, all of it, replaced by an empty
     * body. Everything below needs a renderer, so the effect stops here; the
     * scene effect already returns on `!scene`, so nothing is built and no
     * animation frame is scheduled. */
    const attempt = tryRenderer({ antialias: true, preserveDrawingBuffer: true });
    if (!attempt.ok) {
      setGl({ ok: false, detail: attempt.detail });
      return;
    }
    const renderer = attempt.renderer;
    setGl({ ok: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Real shadows, because the house style asks for `castShadow` and a
    // castShadow flag with no shadow map enabled is a setting that does nothing.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'cad-preview-canvas');

    const scene = new THREE.Scene();
    /* ══════════════════════════════════════════════════════════════════════
       TWO CAMERAS, ONE ORBIT (founder, 2026-08-11: *"add perspective /
       orthogonal view change capability in all 3d canvas"*)
       ══════════════════════════════════════════════════════════════════════

       🔴 BOTH ARE BUILT ONCE AND ONE IS SELECTED. Rebuilding a camera on the
       toggle would be a new object every switch, and every closure below that
       captured the old one — the raycaster, the framing, the gizmo's `up` —
       would go on describing a camera that is no longer being rendered. `camera`
       is a `let` in this scope, so reassigning it moves all of them together.

       🔴 THE ORBIT STATE IS NOT DUPLICATED. `theta`, `phi`, `radius` and
       `target` are the camera's, not a projection's; `place()` positions
       whichever camera is selected and `applyProjection()` builds the matrix.
       Switching mode therefore cannot move the view — the whole reason there is
       one `radius` and not two. See `projection.ts` for the OpenSCAD source this
       is transcribed from.

       ⚠ THE ORTHO FRUSTUM IS A PLACEHOLDER HERE and is overwritten by the first
       `applyProjection()` below, which runs before the first frame. Six zeroes
       would have been an unbuildable matrix; six ones is a valid camera that is
       simply never rendered with these numbers. */
    const perspectiveCamera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.5, 100000);
    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspectiveCamera;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(300, -420, 620);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    scene.add(key.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-400, 350, 200);
    scene.add(fill);

    // Colour probe. Resolved THROUGH the browser rather than by reading the
    // custom property text, because the token is a var() chain today and could
    // be anything tomorrow, whereas a computed `color` is always a colour.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    el.appendChild(probe);
    const token = (expr: string): THREE.Color => {
      probe.style.color = '';
      probe.style.color = expr;
      return cssToColor(getComputedStyle(probe).color) ?? new THREE.Color(0.5, 0.5, 0.5);
    };
    kit.current.token = token;

    /* ══════════════════════════════════════════════════════════════════════
       THE CORNER GIZMO (founder, 2026-08-11: *"move the xyz arrow to the
       corner (check how is it positioned in openscad)"*)
       ══════════════════════════════════════════════════════════════════════

       ── WHAT OPENSCAD ACTUALLY DOES, read rather than assumed ───────────────
       `/home/gbacs/apps/openscad`, `src/glview/GLView.cc`. **It has BOTH, and
       one flag draws them both** (`showaxes`, at `GLView.cc:196` and `:225`):

         · `showSmallaxes()` — its own comment reads *"Small axis cross in the
           lower left corner"*. It is drawn LAST, with `glDepthFunc(GL_ALWAYS)`
           so nothing occludes it, in its OWN orthographic projection translated
           to `(-0.8, -0.8)` in NDC, at a FIXED scale (`glOrtho(±90·dpi)` against
           a 10·dpi axis ⇒ ~1/9 of half the viewport, whatever the zoom), rotated
           only by `cam.object_rot`. **Red X, green Y, blue Z**, with the letters
           drawn as screen-space glyphs.
         · `showAxes()` — a separate, uncoloured, unlabelled cross through the
           WORLD ORIGIN, drawn with `w = 0` vertices so the positive half runs to
           infinity, the negative half `glLineStipple`d, plus `showScalemarkers`
           ticks and numbers.

       ⇒ **The founder's request IS OpenSCAD's arrangement.** The coloured,
       labelled triad belongs in the corner; what stays at the origin is a
       different and deliberately duller instrument. Keeping both is matching the
       reference he pointed at, not scope creep — and this file's own note said
       the opposite until today, that `showAxes` was *"not taken"*.

       🔴 THE TWO QUESTIONS ARE NOT THE SAME QUESTION, which is why moving the
       triad without replacing it would have LOST something:
         · a corner gizmo answers *"which way is the camera pointing?"*
         · origin axes answer *"where is [0,0,0] relative to my model?"* — the
           question `translate()` is the answer to, and the stated reason this
           tab's triad was rooted at a literal zero yesterday.
       The origin cross built in the `[result]` effect below is what keeps the
       second question answered.

       ── HOW IT IS SCREEN-FIXED, AND WHAT THAT COSTS ─────────────────────────
       A SECOND SCENE and a SECOND (orthographic) CAMERA, rendered into a scissor
       box in the lower-left after the main pass with the depth buffer cleared
       inside that box. So:
         · it cannot scale with zoom — the ortho frustum is a constant and the
           box is sized from the CANVAS, never from `radius` or from `span`;
         · it cannot be occluded — nothing from the main scene is in this scene,
           and the depth cleared under it is the main pass's;
         · it rotates with the camera, because the only per-frame work is
           pointing `gizmoCamera` along the main camera's view direction.

       🔴 IT IS BUILT ONCE, IN THIS EFFECT, AND NEVER REBUILT. The `[result]`
       effect empties `scene` and the dispose list on every mesh — which is every
       250 ms while someone types — and this scene is not `scene`, so nothing it
       holds is touched. An object recreated per frame is exactly the thrash
       `Viewport.tsx` had before its scene was keyed by value; the render loop
       below allocates NOTHING, it copies into two vectors that already exist. */
    /* Corner gizmo removed — the pivot triad (below) serves as the orientation
     * indicator and uses axisArrow() directly.  The gizmo scene, its lights and
     * its arrows are no longer allocated. */

    /* ══════════════════════════════════════════════════════════════════════
       THE ORBIT-CENTRE TRIAD (founder, 2026-08-11: *"put back the xyz arrows
       to the cad where the zoom/mouse rotation is centered"*)
       ══════════════════════════════════════════════════════════════════════

       🔴 IT MARKS THE ORBIT CENTRE, WHICH IS NOT THE ORIGIN, AND THAT IS THE
       WHOLE HAZARD. Coloured, lettered XYZ arrows are read as `[0,0,0]` by
       everyone who has ever used a CAD tool — and an operator who writes a
       `translate()` against them gets a part in the wrong place. Three things
       keep the two apart, and none of them is a colour:

         · the ORIGIN cross (built in the `[result]` effect) is uncoloured,
           unlettered, has a dashed negative half and runs to a multiple of the
           model span. It is world-sized: zoom in and it grows off screen.
         · THIS one is coloured, lettered, POSITIVE-ONLY, and screen-sized — a
           constant apparent size at every zoom, so it never reads as geometry.
         · and it is SAID, twice, in the two places a hand is already going: the
           viewport's own `title` and the `Fit` button's.

       🔴 IT TRACKS `target`, THE ORBIT STATE ITSELF — not `framing()`'s pivot,
       and not the bounds. That is what makes it honest AND what keeps it off
       the per-keystroke path: `target` is the variable `place()` orbits about,
       so the arrows cannot disagree with where rotation is centred, and it is
       written by exactly two things — `frameScene` (the first model, and `Fit`)
       and a pan. A triad positioned from `lastPivot` would move on every parse,
       250 ms after every keystroke, while the camera did not — arrows that
       twitch away from the centre they claim to mark.

       🔴 NO `z` LIFT, and this is the fourth time the reason has been written
       down. This tab has no sheet, no datum and no workpiece, so there is
       nothing for a triad to be raised clear OF; {@link CNC_TRIAD_FORM} carries
       the shape and deliberately carries no position, so there is nothing to
       inherit either.

       ⚠ PREMISE CORRECTED 2026-08-11. This paragraph said `Viewport.tsx` raises
       its triad clear of the sheet's top face and that the founder had reported
       that lift — *"the xyz arros center seems on top of the workpeace"*. The
       lift is gone (`37bdb0bc6d`) and it was never the thing reported: measured
       at the view the complaint came from it is 0.23px. The complaint was about
       the geometry, and `ZDatum` is where that fix went. The ban stands on this
       tab's own facts.

       ⚠ IT IS NOT OCCLUDED BY THE MODEL (`depthTest: false`), and that is a
       judgement rather than an oversight. The orbit centre is usually the XY
       centre of the footprint at z = 0 — i.e. INSIDE the solid — so a
       depth-tested triad would be invisible on most models, which is a feature
       that renders and cannot be seen. The rule this file already states is the
       one being applied: an instrument that describes the CAMERA is never
       occluded (the corner gizmo), and an instrument that describes the WORLD
       is (the ruler, the origin cross). This one describes the camera.

       ⚠ ONE SCALE DECISION, STATED: it DOES scale with zoom, to stay the same
       size on screen. The clamp is `1 … 200000`, so a world-sized triad would
       swamp a 10 mm part at one end and vanish on a 2 m assembly at the other —
       both reachable, and arrows that are useless at either extreme are worse
       than none. `worldPerPixel` is the same helper the pan step uses and is
       projection-blind, so this holds in orthographic too. */
    const pivotTriad = new THREE.Group();
    pivotTriad.name = 'orbit-centre';
    /* Drawn after the model, so the depth-test exemption above is not fighting
     * draw order as well. */
    pivotTriad.renderOrder = 999;
    scene.add(pivotTriad);
    kit.current.pivotTriad = pivotTriad;
    const pivotJunk: { dispose(): void }[] = [];
    {
      const keepPivot = (x: { dispose(): void }) => {
        pivotJunk.push(x);
      };
      for (const [dir, colour, label] of [
        [new THREE.Vector3(1, 0, 0), AXIS_COLOR.x, 'X'],
        [new THREE.Vector3(0, 1, 0), AXIS_COLOR.y, 'Y'],
        [new THREE.Vector3(0, 0, 1), AXIS_COLOR.z, 'Z'],
      ] as const) {
        axisArrow({
          dir,
          colour,
          label,
          form: CNC_TRIAD_FORM,
          into: pivotTriad,
          keep: keepPivot,
          depthTest: false,
        });
      }
    }

    /* ══════════════════════════════════════════════════════════════════════
       THE RULER (founder, 2026-08-11: *"like in openscad able to enable/
       disable the rulers for xyz"*)
       ══════════════════════════════════════════════════════════════════════

       🔴 IT LIVES IN THE MAIN SCENE, ON PURPOSE. It is world geometry at the
       world origin, so it must be occluded by the model exactly as the origin
       cross is — a ruler drawn through a solid is an instrument in front of
       geometry it is behind.

       ⚠ THE RULE THIS RESTS ON WAS RESTATED ON 2026-08-11, because the line here
       used to say the corner gizmo was *"the thing that is never occluded"* and
       that *"that property belongs to an orientation indicator and to nothing
       else"* — and the orbit-centre triad added that day is a second holder of
       it. The distinction that actually carries the weight is not "gizmo vs the
       rest": an instrument describing the CAMERA (the corner gizmo, the
       orbit-centre triad) is never occluded, and an instrument describing the
       WORLD (this ruler, the origin cross) is. A ruler you can read through the
       part is a measurement of something you cannot see.

       🔴 BUT IT IS OWNED BY *THIS* EFFECT, NOT BY `[result]`, and that is the
       whole engineering content of this feature. Tick geometry is a function of
       the CAMERA, and the camera changes every frame. OpenSCAD re-emits its
       ticks per frame in immediate mode (`glBegin`/`glVertex3d`) and pays
       nothing for it; here every rebuild is a `BufferGeometry`, a
       `CanvasTexture` per printed number, and a `dispose()` for each. So the
       rebuild is keyed on {@link rulerSignature}, which is a function of the
       DECADE of the zoom rather than of the zoom — a continuous wheel scroll
       inside one decade rebuilds nothing at all.

       ⚠ THE `[result]` EFFECT EMPTIES `scene` OF EVERYTHING THAT IS NOT A LIGHT.
       This group is exempted there BY IDENTITY, with a comment — if that
       exemption is ever lost, the ruler is silently deleted 250 ms after every
       keystroke and rebuilt on the next decade change, which is a defect that
       looks exactly like a flicker. */
    const rulerRoot = new THREE.Group();
    rulerRoot.name = 'rulers';
    scene.add(rulerRoot);
    kit.current.rulers = rulerRoot;

    /** Disposed by the ruler builder, never by `kit.current.dispose`. */
    let rulerJunk: { dispose(): void }[] = [];

    const buildRulers = (plan: RulerPlan | null) => {
      for (const o of [...rulerRoot.children]) rulerRoot.remove(o);
      for (const j of rulerJunk) j.dispose();
      rulerJunk = [];
      if (!plan) return;

      const tok = kit.current.token;
      const ink = tok ? tok('var(--ink)') : new THREE.Color(0.8, 0.8, 0.8);
      const muted = tok ? tok('var(--muted)') : new THREE.Color(0.5, 0.5, 0.5);
      const wire = muted.clone().lerp(ink, 0.35);

      const plus: number[] = [];
      const minus: number[] = [];
      /* The label offset clears the longest arm, so a number never sits on top
       * of a tick it is not about. OpenSCAD does the same with its
       * `baseline_offset = font_size / 5` above the axis line. */
      const labelOut = plan.majorLength + plan.labelHeight * 0.75;

      for (const axis of AXES) {
        const [ax, ay, az] = AXIS_DIRECTION[axis];
        const [tx, ty, tz] = TICK_DIRECTION[axis];
        for (const t of plan.ticks) {
          const len = t.major ? plan.majorLength : plan.minorLength;
          for (const sign of [1, -1] as const) {
            const px = ax * t.at * sign;
            const py = ay * t.at * sign;
            const pz = az * t.at * sign;
            const into = sign === 1 ? plus : minus;
            into.push(px, py, pz, px + tx * len, py + ty * len, pz + tz * len);
            if (t.label === null) continue;
            const made = glyphSprite(
              sign === 1 ? t.label : `-${t.label}`,
              `#${hex2(wire.r)}${hex2(wire.g)}${hex2(wire.b)}`,
              plan.labelHeight,
            );
            made.sprite.position.set(px + tx * labelOut, py + ty * labelOut, pz + tz * labelOut);
            rulerJunk.push(...made.junk);
            rulerRoot.add(made.sprite);
          }
        }
      }

      const segments = (points: number[], opacity: number) => {
        if (points.length === 0) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
        const mat = new THREE.LineBasicMaterial({ color: wire, transparent: true, opacity });
        rulerJunk.push(geo, mat);
        rulerRoot.add(new THREE.LineSegments(geo, mat));
      };
      segments(plus, 0.85);
      /* 🔴 THE NEGATIVE SIDE IS FAINTER, WHERE OPENSCAD STIPPLES IT
       * (`glLineStipple(3, 0xAAAA)` at `GLView.cc:585`). A stipple with a 3-pixel
       * factor on a tick that is a few pixels long does not read as "dashed", it
       * reads as "missing" — the pattern would delete most of the arm. The
       * distinction OpenSCAD is drawing is *this half is the negative one*, and
       * opacity carries it on a mark this short. The long ARMS of the origin
       * cross are genuinely dashed, because they are long enough for a dash to
       * be a dash; that is in the `[result]` effect and is unchanged. */
      segments(minus, 0.45);
    };
    kit.current.buildRulers = buildRulers;

    /**
     * What the ruler was last built for. Compared every frame; equal is the
     * overwhelmingly common case and costs one string compare.
     *
     * ⚠ The THEME is in here because the printed numbers are pixels in a canvas
     * texture, not a tintable material — a theme flip has to redraw them or the
     * ruler keeps the old palette's contrast. It is the one input that is not
     * about the camera, and it changes at most when somebody presses a toggle.
     */
    let rulerBuiltFor: string | null = null;

    /* 🔴 FOUR CONVENTIONS, AND THEY ARE DELIBERATELY THE CNC VIEWPORT'S.
     * Orbit azimuth, orbit elevation, pan and wheel-zoom are four independent
     * sign choices that can disagree independently, so they are named here
     * rather than left to be re-derived from the arithmetic:
     *
     *   orbit azimuth   drag RIGHT → the near face of the model goes RIGHT
     *                   (`theta -= dx`)
     *   orbit elevation drag DOWN  → the camera rises, more of the TOP shows
     *                   (`phi   -= dy`)
     *   pan             the scene FOLLOWS the mouse
     *   wheel           deltaY > 0 (scroll toward you) → zoom OUT
     *
     * All four are byte-identical to `Viewport.tsx` (its `place`, `move` and
     * `wheel`), which is the surface operators judge a cutting job on and is
     * therefore the one that wins any disagreement.
     *
     * ⚠ AND THEY INDEPENDENTLY MATCH OPENSCAD, checked at its source rather
     * than assumed — OpenSCAD 2026.08.07, `src/core/MouseConfig.h`
     * (`presetSettings[OPEN_SCAD]` maps LEFT_CLICK to ROTATE_ALT_AZ, whose
     * matrix is `rot.x += dy`, `rot.z += dx`; RIGHT_CLICK to PAN_LR_UD, whose
     * matrix is `+dx` screen-right and `-dy` screen-up) with the render signs
     * in `src/glview/GLView.cc:147-149` and the eye at `(0, -dist, 0)`, up +Z.
     * A `theta`/`phi` camera and an object-rotation camera express the same
     * gesture differently; the OBSERVABLE direction is the same in all three.
     *
     * 🔴 So do not "fix" a sign here in isolation. Changing one of these makes
     * this tab disagree with the other tab in the same app AND with the tool
     * this tab imitates, and only one of the three can be right at a time.
     * `tests/cad-camera-parity.test.ts` asserts the parity at the source text
     * and goes red if either file drifts. */
    let theta = -Math.PI / 4;
    let phi = Math.PI / 3.2;
    let radius = 200;
    let target = new THREE.Vector3(0, 0, 0);
    let dragging = false;
    let panning = false;
    let lx = 0;
    let ly = 0;
    let viewW = 1;
    let viewH = 1;
    let lastTheme: string | null = null;
    /** What `applyProjection` last built for. Compared once per frame. */
    let builtProjection: Projection | null = null;

    /* ══════════════════════════════════════════════════════════════════════
       THE CAMERA THE LAST SESSION LEFT (founder, 2026-08-11: *"when I refresh
       the browser the 2bee.cad should come back what has been changed (zoom,
       FOV, edited code)"*)
       ══════════════════════════════════════════════════════════════════════

       🔴 IT SETS `framedOnce`, AND WITHOUT THAT LINE THE WHOLE FEATURE IS
       INVISIBLE. The `[result]` effect frames the first non-empty scene, which
       arrives ~250 ms after this effect runs — so a restored camera would be
       overwritten by an automatic `Fit` before anybody saw it, and the code
       would read as correct while the founder reported the same thing again.

       ⚠ IT DOES NOT CALL `frameScene`. Assigning the four values is exactly
       what a restore is; going through the framing path would re-derive a
       radius from the model and throw the stored zoom away.

       ⚠ AND "FOV" IS THE ZOOM, NOT A SECOND NUMBER. There is one scalar,
       `radius`; the orthographic half-height is derived from it. See
       {@link CadCamera}. */
    const seed = readCamera(initialCamera);
    if (seed) {
      theta = seed.theta;
      phi = seed.phi;
      radius = seed.radius;
      target = new THREE.Vector3(seed.target[0], seed.target[1], seed.target[2]);
      kit.current.framedOnce = true;
    }

    /**
     * Tell the caller where the camera ended up, once the hand stops.
     *
     * 🔴 DEBOUNCED HERE RATHER THAN AT THE CALLER, because the caller cannot
     * see the events: one wheel spin is ~40 notches and one orbit drag is a
     * `pointermove` per frame. An un-debounced write is a synchronous
     * `localStorage.setItem` of the whole session — the source included — inside
     * a pointer handler, on the one surface whose entire interaction is
     * dragging. That is a stutter with a cause nobody would find.
     */
    let cameraTimer: ReturnType<typeof setTimeout> | null = null;
    const cameraMoved = () => {
      if (cameraTimer !== null) clearTimeout(cameraTimer);
      cameraTimer = setTimeout(() => {
        cameraTimer = null;
        cameraOut.current?.({
          theta,
          phi,
          radius,
          target: [target.x, target.y, target.z],
        });
      }, CAMERA_SAVE_MS);
    };

    /* 🔴 THE ONE BRANCH IN THE WHOLE FEATURE. Everything else — the wheel, the
     * clamps, the pan, `Fit`, the ruler's decade — is projection-blind, because
     * `orthoHalfHeight(radius)` IS the perspective half-height at `radius`. See
     * the invariants in `projection.ts`.
     *
     * ⚠ IT MUST RUN WHENEVER `radius` MOVES, not only on a mode change: in ortho
     * the frustum IS the zoom, so a wheel notch that did not reach here would be
     * the "wheel dead in ortho" defect exactly. `place()` calls it, and `place()`
     * is what every gesture already ends with. */
    const applyProjection = () => {
      /* 🔴 THE WANTED MODE IS READ FROM THE REF, NEVER PASSED IN. The first cut
       * of this took a parameter and every caller passed `builtProjection ??
       * want`, which re-applies the mode that is ALREADY built — so a toggle
       * would have rebuilt the old frustum forever and the control would have
       * been dead. One reader, one source. */
      const want = kit.current.view.projection;
      const aspect = viewW / Math.max(1, viewH);
      if (want === 'orthographic') {
        const f = orthoFrustum(radius, aspect);
        orthographicCamera.left = f.left;
        orthographicCamera.right = f.right;
        orthographicCamera.top = f.top;
        orthographicCamera.bottom = f.bottom;
        orthographicCamera.near = f.near;
        orthographicCamera.far = f.far;
        orthographicCamera.updateProjectionMatrix();
        camera = orthographicCamera;
      } else {
        perspectiveCamera.aspect = aspect;
        perspectiveCamera.updateProjectionMatrix();
        camera = perspectiveCamera;
      }
      builtProjection = want;
      kit.current.camera = camera;
    };

    const place = () => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi),
      );
      camera.up.set(0, 0, 1);
      camera.lookAt(target);
      /* The eye moves in BOTH projections — `gluLookAt` sits outside OpenSCAD's
       * own projection switch (`GLView.cc:141`) — so this is unconditional, and
       * the frustum is rebuilt from the radius the move just used. */
      applyProjection();
    };

    const dom = renderer.domElement;
    const down = (e: PointerEvent) => {
      dragging = true;
      panning = e.button === 2 || e.shiftKey;
      lx = e.clientX;
      ly = e.clientY;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (panning) {
        // Same derivation as the CAM viewport: screen-right and screen-up
        // projected onto the model plane, from the lookAt basis rather than by
        // flipping signs until it felt right.
        const rightX = -Math.sin(theta);
        const rightY = Math.cos(theta);
        const cz = Math.cos(phi);
        const upX = -Math.sign(cz) * Math.cos(theta);
        const upY = -Math.sign(cz) * Math.sin(theta);
        /* 🔴 `worldPerPixel(radius, viewH)`, NOT `camera.fov`. An
         * `OrthographicCamera` has no `fov`, so the old expression became `NaN`
         * the moment the mode changed — and a `NaN` pan corrupts `target` with
         * nothing on screen to say why. It is the SAME number in both modes (see
         * `projection.ts`), so this changes no behaviour in perspective. */
        const k = worldPerPixel(radius, viewH);
        const fore = 1 / Math.max(0.2, Math.abs(cz));
        target.x -= dx * k * rightX - dy * k * fore * upX;
        target.y -= dx * k * rightY - dy * k * fore * upY;
      } else {
        theta -= dx * 0.006;
        phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - dy * 0.006));
      }
      place();
      cameraMoved();
    };
    const up = () => {
      dragging = false;
      panning = false;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      radius = Math.min(200000, Math.max(1, radius * (e.deltaY > 0 ? 1.12 : 0.9)));
      place();
      cameraMoved();
    };
    const ctx = (e: Event) => e.preventDefault();
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointerleave', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    dom.addEventListener('contextmenu', ctx);

    const resize = () => {
      const w = el.clientWidth || 640;
      const h = el.clientHeight || 360;
      viewW = w;
      viewH = h;
      renderer.setSize(w, h, false);
      /* Both cameras take the aspect from here — the perspective one as
       * `.aspect`, the orthographic one as the width of its frustum. One call
       * site, so a resize cannot leave one of them stretched. */
      applyProjection();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    place();

    kit.current.frameScene = (c: THREE.Vector3, r: number) => {
      target = c.clone();
      radius = Math.max(r * 2.4, 1);
      place();
      /* A `Fit` is a camera move like any other and is remembered like one —
       * including the automatic first framing, so a browser that has never seen
       * this tab still stores something rather than storing nothing until the
       * operator happens to touch the mouse. */
      cameraMoved();
    };
    /* 🔴 THE CAMERA IS NOT A FUNCTION OF THE MESH. Framing on every result
     * looked like a courtesy and was a defect: the mesh recomputes 250 ms after
     * every keystroke, so a user who had zoomed in on a corner and then typed
     * one character was thrown back to the whole-model view — repeatedly, and
     * with no control that caused it. Orbit survived (θ/φ are not touched) while
     * pan and zoom did not, which is a worse failure than resetting all three:
     * it looks like the viewport is fighting you rather than resetting.
     *
     * OpenSCAD does not move the camera on re-render either, so the behaviour
     * matches the tool this tab mirrors as well as being the right one. The
     * first non-empty scene still frames itself — otherwise the model opens off
     * screen — and after that framing is a control the user presses. */
    kit.current.refit = () => {
      /* 🔴 THE PIVOT, NOT THE BOX CENTRE, AND THE SPAN THAT GOES WITH IT. Both
       * come from {@link framing} and neither is written while the scene is
       * empty, so `Fit` in the middle of a refusal cascade re-frames the last
       * model that actually existed rather than a point at the origin. */
      const c = kit.current.lastPivot;
      const s = kit.current.lastSpan;
      if (!c || !s) return;
      kit.current.frameScene?.(c, s);
    };

    const tick = () => {
      kit.current.frame = requestAnimationFrame(tick);
      /* 🔴 A BOX WITH NO SIZE IS A CANVAS NOBODY CAN SEE — stop drawing into it.
       *
       * Added 2026-08-11 with the tab bar. The CAD tab is HIDDEN rather than
       * unmounted when another tab is showing (`Tabs.tsx`), so that the source
       * being typed survives a switch — and `display: none` stops neither this
       * loop nor `resize()`, which falls back to 640x360 when the container
       * measures nothing. Without this, opening the CNC tab would leave a full
       * 3D scene rendering at 60 Hz behind it, forever.
       *
       * ⚠ IT MEASURES ITS OWN BOX RATHER THAN BEING TOLD, which is the weaker of
       * the two mechanisms and is used here for a structural reason, not a
       * preference: `App` knows which tab is showing and tells `Viewport`
       * directly (`paused`), but `CadTab` sits between `App` and this component
       * and is not this change's to modify. Its own geometry is the only fact
       * this component has, and it is a sound one — a zero-sized canvas is
       * exactly the case worth skipping, however it got that way.
       *
       * The frame stays SCHEDULED, so the picture returns on the first frame
       * after the box has a size again, with no restart. */
      if (!el.clientWidth || !el.clientHeight) return;

      /* ── the palette, and then the ruler that is baked out of it ────────
       * Re-resolve the palette when the THEME changes, keyed on the attribute
       * that drives it rather than on a React prop — `App` writes `data-theme`
       * in an effect, and a child's effects run before its parent's, so a prop
       * read here would leave the 3D scene one toggle behind the panels.
       *
       * ⚠ IT MOVED ABOVE THE RENDER, from the bottom of this function. It was
       * below `renderer.render`, which cost one frame of the old palette and was
       * invisible; it is now the input to the ruler's rebuild key, and a rebuild
       * that ran before the palette was re-resolved would bake the OLD colour
       * into the new numbers and then never rebuild again. */
      const theme = document.documentElement.dataset.theme ?? '';
      if (theme !== lastTheme) {
        lastTheme = theme;
        kit.current.applyPalette?.();
      }

      /* ── the projection, on the same idiom as the theme above ────────────
       * 🔴 ONE ENUM COMPARE PER FRAME. The setup effect has `[]` deps and cannot
       * see a prop change, so the mode arrives the way `view.axes` and the theme
       * do: written into the ref by an effect, read here. `place()` is called on
       * the change rather than `applyProjection()` alone, so the frustum is
       * rebuilt from the CURRENT radius — the two are one operation and calling
       * only half of it is how a mode switch ends up showing a stale frustum. */
      if (kit.current.view.projection !== builtProjection) place();

      /* 🔴 ONE STRING COMPARE PER FRAME, AND A REBUILD ONLY WHEN THE DECADE
       * MOVES. See {@link rulerSignature}. `view.scale` is ANDed with
       * `view.axes` here as well as in the props, because `GLView.cc:198` does
       * exactly that and because ticks with no axis line to sit on are an
       * instrument annotating nothing. */
      /* ── the orbit-centre triad, before the pass that draws it ───────────
       * 🔴 TWO COPIES AND A MULTIPLY, AND NOTHING ELSE. No allocation, no
       * rebuild, no lookup: the group exists from setup and this only moves and
       * resizes it. It sits with the axes because every other instrument in
       * this viewport does (`GLView.cc:196`, `:198`, `:225` are one flag), and
       * a fourth toggle is not what the founder asked for.
       *
       * ⚠ `target` AND `radius` ARE THE LIVE ORBIT STATE, read here rather than
       * pushed in from an effect — which is what makes the arrows incapable of
       * disagreeing with where the mouse actually rotates. */
      pivotTriad.visible = kit.current.view.axes;
      if (pivotTriad.visible) {
        pivotTriad.position.copy(target);
        pivotTriad.scale.setScalar(worldPerPixel(radius, viewH) * PIVOT_TRIAD_PX);
      }

      const rulersOn = rulersDrawn(kit.current.view.axes, kit.current.view.scale);
      const reach = kit.current.axisReach ?? 0;
      const want = `${rulerSignature(radius, reach, rulersOn)}|${theme}`;
      if (want !== rulerBuiltFor) {
        rulerBuiltFor = want;
        buildRulers(rulersOn ? rulerPlan(radius, reach) : null);
      }

      renderer.render(scene, camera);

      /* 🔴 THE CORNER GIZMO GOES WITH THE AXES, BECAUSE IT DOES IN OPENSCAD.
       * `GLView.cc:225` is `if (showaxes) GLView::showSmallaxes(axescolor)` —
       * the same flag that draws the origin cross at `:196` and gates the scale
       * markers at `:198`. One flag, three instruments. Giving the gizmo its own
       * life here would be a fourth toggle the founder did not ask for and a
       * divergence from the tool he pointed at. */
      if (!kit.current.view.axes) return;

      /* ── the corner gizmo, second pass ──────────────────────────────────
       * 🔴 SIZED FROM THE CANVAS AND FROM NOTHING ELSE. Not `radius`, not
       * `span`, not the model bounds — the whole point of a gizmo is that it
       * is the one thing on screen whose size never moves. The clamp keeps it
       * legible in a small pane and stops it swallowing a large one.
       *
       * ⚠ `setViewport`/`setScissor` take CSS pixels here, the same units
       * `setSize(w, h, false)` was given; three.js applies the pixel ratio.
       *
       * 🔴 THE CORNER GIZMO IS REMOVED. The founder's original request was
       * "move the xyz arrow to the corner", but the user now wants it near
       * the object instead — like the CNC viewport's triad at the machine
       * origin. The pivot triad at the orbit centre already serves this
       * purpose, so the corner gizmo rendering is disabled.
       *
       * The gizmo scene/camera are still built (for the pivot triad's
       * shared axisArrow helper) but not rendered into a scissor box. */
    };
    tick();

    kit.current.renderer = renderer;
    kit.current.scene = scene;
    kit.current.camera = camera;
    kit.current.key = key;

    return () => {
      if (kit.current.frame) cancelAnimationFrame(kit.current.frame);
      /* A pending camera write must not fire into an unmounted tree — and more
       * to the point, must not fire AFTER the next mount has already restored
       * and moved the camera, which would overwrite the new position with the
       * old one. */
      if (cameraTimer !== null) clearTimeout(cameraTimer);
      ro.disconnect();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointerleave', up);
      dom.removeEventListener('wheel', wheel);
      dom.removeEventListener('contextmenu', ctx);
      /* Built once here, so freed once here. `kit.current.dispose` is emptied
       * on every mesh and would take it. */
      for (const j of pivotJunk) j.dispose();
      /* The ruler is this effect's, not `[result]`'s, so it is freed here.
       * `buildRulers(null)` is the same path an axes-off toggle takes — one
       * teardown, exercised in the ordinary case rather than only on unmount. */
      buildRulers(null);
      renderer.dispose();
      el.removeChild(dom);
      el.removeChild(probe);
    };
  }, []);

  // --- scene contents -------------------------------------------------------
  useEffect(() => {
    const scene = kit.current.scene;
    const key = kit.current.key;
    if (!scene || !key) return;

    for (const d of kit.current.dispose) d();
    kit.current.dispose = [];
    for (const o of [...scene.children]) {
      if ((o as THREE.Object3D & { isLight?: boolean }).isLight) continue;
      if (o === key.target) continue;
      /* 🔴 THE RULER IS NOT THIS EFFECT'S TO DELETE. It belongs to the setup
       * effect and is rebuilt on a DECADE change, not on a mesh — removing it
       * here would delete it 250 ms after every keystroke and leave it gone
       * until the next time somebody crossed a power of ten while zooming. That
       * failure looks like a flicker, which is the kind nobody files. */
      if (o === kit.current.rulers) continue;
      /* 🔴 NOR IS THE ORBIT-CENTRE TRIAD. Same ownership, same failure if it is
       * ever lost: it would be deleted 250 ms after every keystroke and never
       * come back, because nothing rebuilds it. That reads as a flicker, which
       * is the kind of defect nobody files. */
      if (o === kit.current.pivotTriad) continue;
      scene.remove(o);
    }

    const track = <T extends { dispose(): void }>(x: T): T => {
      kit.current.dispose.push(() => x.dispose());
      return x;
    };

    // Overall bounds, for the ground plane, the shadow camera and the framing.
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of result.parts) {
      if (!p.bounds) continue;
      min.min(new THREE.Vector3(...p.bounds.min));
      max.max(new THREE.Vector3(...p.bounds.max));
    }
    const has = Number.isFinite(min.x);
    const centre = has ? min.clone().add(max).multiplyScalar(0.5) : new THREE.Vector3();
    const span = has ? Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 1) : 100;

    /* Tinted by `applyPalette` on every theme change, like every other
     * theme-driven material in this scene. */
    const originArmMats: THREE.LineBasicMaterial[] = [];

    /* ══════════════════════════════════════════════════════════════════════
       THE ORIGIN CROSS — what stays at [0,0,0] now the triad has moved
       ══════════════════════════════════════════════════════════════════════

       🔴 THE COLOURED TRIAD USED TO BE HERE AND IS NOW A CORNER GIZMO (founder,
       2026-08-11: *"move the xyz arrow to the corner (check how is it positioned
       in openscad)"*). See the gizmo's own note in the setup effect for what
       OpenSCAD does, read at its source.

       🔴 THIS EXISTS BECAUSE MOVING THE TRIAD WOULD OTHERWISE HAVE DELETED AN
       ANSWER. Yesterday's note on the triad said, correctly, that an operator
       reads it to answer *"where does my model sit relative to [0,0,0]"* — the
       question `translate()` is the answer to — and a corner gizmo CANNOT answer
       that: it is screen-fixed and orientation-only. So the origin keeps a
       marker, and it is OpenSCAD's own marker rather than a second coloured
       triad competing with the one in the corner.

       ⚠ FAITHFUL TO `showAxes()` IN EVERYTHING BUT LENGTH. OpenSCAD emits the
       positive half with `w = 0` homogeneous vertices, i.e. literally to
       infinity, and stipples the negative half. `THREE.Line` has no
       to-infinity vertex, so the arms are cut at a multiple of the model span —
       a FINITE APPROXIMATION, said here rather than left to be mistaken for a
       measured extent. It is one muted colour, uncoloured and unlabelled by
       axis, exactly as OpenSCAD draws it: colour and letters are the gizmo's
       job now, and two coloured instruments disagreeing about which one to read
       is worse than one of each.

       ⚠ `showScalemarkers` — the ticks WITH NUMBERS along each axis — is still
       NOT BUILT. It is the half of OpenSCAD's origin axes that carries
       information, and it stays recorded as a gap in `menu.tsx` rather than
       becoming a silent difference.

       🔴 AND IT IS AT A LITERAL `[0,0,0]`, WITH NO LIFT OF ANY KIND — the third
       time this reason has had to be written down. This tab has no sheet, no
       datum and no workpiece; `[0,0,0]` is OpenSCAD's world origin and nothing
       else, so there is nothing here for a cross to be raised clear OF. Lifting
       it would look like an obvious tidy-up and would put the origin marker
       somewhere the origin is not.

       ⚠ PREMISE CORRECTED 2026-08-11, CONCLUSION UNCHANGED — and this is the
       exact reason the sentence was not simply deleted. It used to read
       *"`Viewport.tsx` lifts ITS triad to `aZ = 0.4` … and that lift is
       precisely what the founder complained about"*. Both halves are now false:
       `37bdb0bc6d` removed the lift, having measured that at the view the
       complaint was made from it is **0.23px** — so it cannot have been what
       was seen, and what was seen was the geometry (the CNC tab's z = 0 is the
       declared work zero, `ZDatum`, which is where the fix went). The ban here
       survives its own former justification, which is why it now stands on this
       tab's own facts instead of on the other tab's history.

       ⚠ DEPTH TESTING STAYS ON, unchanged. A model built up from the origin
       hides the first part of each arm inside itself; drawing the cross THROUGH
       the solid would make it legible and would also draw an instrument in front
       of geometry it is behind, which is a different lie from the one it fixes.
       This cross is a statement about the WORLD — where `[0,0,0]` is relative to
       the part — so it is subject to the part. The two instruments that are
       never occluded (the corner gizmo, the orbit-centre triad) are statements
       about the CAMERA, and a camera is not behind anything.

       ⚠ IT IS BUILT IN THE `[result]` EFFECT, NOT PER FRAME, because it is sized
       to the model. The gizmo is not, and is built once. */
    {
      const axes = new THREE.Group();
      axes.name = 'axes';
      const from = new THREE.Vector3(0, 0, 0);
      const reach = Math.max(6, span * 0.75);
      const armMat = track(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85 }));
      const dashMat = track(
        /* `scale` and `gapSize` are in world units, so the dash is sized to the
         * model like the arm it belongs to — a fixed 1 mm dash on a 2 m assembly
         * is a solid line. */
        new THREE.LineDashedMaterial({
          transparent: true,
          opacity: 0.55,
          dashSize: reach * 0.04,
          gapSize: reach * 0.04,
        }),
      );
      originArmMats.push(armMat, dashMat);

      const arm = (dir: THREE.Vector3) => {
        const plus = new THREE.Line(
          track(new THREE.BufferGeometry().setFromPoints([from, dir.clone().multiplyScalar(reach)])),
          armMat,
        );
        axes.add(plus);
        const minus = new THREE.Line(
          track(new THREE.BufferGeometry().setFromPoints([from, dir.clone().multiplyScalar(-reach)])),
          dashMat,
        );
        /* Without this the dashed material draws a solid line — the shader
         * needs the per-vertex distance attribute and nothing computes it for
         * you. A dash that silently renders solid is the negative half becoming
         * indistinguishable from the positive one. */
        minus.computeLineDistances();
        axes.add(minus);
      };

      arm(new THREE.Vector3(1, 0, 0));
      arm(new THREE.Vector3(0, 1, 0));
      arm(new THREE.Vector3(0, 0, 1));
      /* 🔴 THE TOGGLE IS APPLIED AT BUILD TIME AS WELL AS ON CHANGE. This group
       * is rebuilt on every mesh, so a group built while the axes are off and
       * left `visible` would come back on its own at the next keystroke — the
       * toggle would read as intermittent rather than broken, which is worse. */
      axes.visible = kit.current.view.axes;
      kit.current.originAxes = axes;
      scene.add(axes);
      /* Published for the ruler, whose ticks stop where this line stops. It is
       * the ONE thing the camera-owned ruler needs from the mesh-owned scene. */
      kit.current.axisReach = reach;
    }

    const solidMats: THREE.MeshStandardMaterial[] = [];
    const unsoundMats: THREE.MeshStandardMaterial[] = [];
    const flatMats: THREE.MeshStandardMaterial[] = [];
    const wireMats: THREE.LineBasicMaterial[] = [];
    let groundMat: THREE.MeshStandardMaterial | null = null;
    let grid: THREE.GridHelper | null = null;

    if (has) {
      // Ground, one span below the model, purely to receive the shadow. It is
      // NOT a machine bed and is not labelled as one — this tab has no machine.
      const g = track(new THREE.PlaneGeometry(span * 6, span * 6));
      groundMat = track(new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }));
      const ground = new THREE.Mesh(g, groundMat);
      ground.position.set(centre.x, centre.y, min.z - span * 0.08);
      ground.receiveShadow = true;
      ground.name = 'ground';
      scene.add(ground);

      grid = new THREE.GridHelper(span * 6, 24);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(centre.x, centre.y, min.z - span * 0.079);
      scene.add(grid);
      kit.current.dispose.push(() => {
        grid?.geometry.dispose();
        (grid?.material as THREE.Material | undefined)?.dispose();
      });

      // Frame the shadow camera on the model. Left at its default it covers a
      // 10mm box, so anything bigger casts no shadow at all — a low-poly look
      // with no shadows reads as "flat shading is broken", not as a setting.
      const s = span * 1.6;
      key.shadow.camera.left = -s;
      key.shadow.camera.right = s;
      key.shadow.camera.top = s;
      key.shadow.camera.bottom = -s;
      key.shadow.camera.near = 0.1;
      key.shadow.camera.far = span * 12;
      key.position.set(centre.x + span * 1.2, centre.y - span * 1.6, centre.z + span * 2.4);
      key.target.position.copy(centre);
      key.target.updateMatrixWorld();
      key.shadow.camera.updateProjectionMatrix();
    }

    for (const p of result.parts) {
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
      // No normal attribute on purpose: `flatShading` derives the face normal in
      // the shader, and a computed vertex normal would be averaged across faces
      // and fight it.
      const paint = paintOf(p);
      const plan = materialFor(p);
      const mat = track(
        new THREE.MeshStandardMaterial({
          flatShading: true,
          roughness: paint === 'flat' ? 0.95 : 0.78,
          metalness: 0,
          side: paint === 'flat' ? THREE.DoubleSide : THREE.FrontSide,
          transparent: plan.transparent,
          opacity: plan.opacity,
          /* A translucent solid that still wrote depth would hide whatever is
           * behind it while showing through — the worst of both. */
          depthWrite: !plan.transparent,
        }),
      );
      if (plan.colour === null) {
        /* Only the theme-driven materials go in these lists. A material whose
         * colour the SOURCE chose must not be re-tinted by `applyPalette` on
         * the next theme change — that is how a red part quietly becomes amber
         * when someone flips to dark mode. */
        (paint === 'solid' ? solidMats : paint === 'unsound' ? unsoundMats : flatMats).push(mat);
      } else {
        mat.color = new THREE.Color(plan.colour);
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `part:${p.id}`;
      mesh.userData.verdict = p.audit?.verdict ?? 'flat';
      // A 2D plate has no volume and casts no shadow, because a shadow is the
      // one cue that reads as "this is a solid".
      mesh.castShadow = paint !== 'flat';
      mesh.receiveShadow = paint !== 'flat';
      scene.add(mesh);

      if (paint !== 'solid') {
        // Wireframe over anything not proven closed. The point is that it CANNOT
        // be mistaken for a finished solid at a glance — the overlay text is the
        // authority, and this is the part of the warning that survives someone
        // looking only at the picture.
        const wg = track(new THREE.WireframeGeometry(geo));
        const wm = track(new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 }));
        wireMats.push(wm);
        const wire = new THREE.LineSegments(wg, wm);
        wire.name = `wire:${p.id}`;
        scene.add(wire);
      }
    }

    const applyPalette = () => {
      const token = kit.current.token;
      if (!token) return;
      const bg = token('var(--bg)');
      const panel = token('var(--panel)');
      const line = token('var(--line)');
      const ink = token('var(--ink)');
      const accent = token('var(--accent)');
      const bad = token('var(--color-status-error)');
      const muted = token('var(--muted)');

      scene.background = bg;
      if (groundMat) groundMat.color = panel.clone().lerp(bg, 0.5);
      if (grid) {
        // GridHelper bakes its colours into a vertex attribute at construction,
        // so it is rebuilt rather than tinted.
        const old = grid;
        const ng = new THREE.GridHelper(span * 6, 24, line, line.clone().lerp(panel, 0.5));
        ng.rotation.copy(old.rotation);
        ng.position.copy(old.position);
        scene.remove(old);
        scene.add(ng);
        old.geometry.dispose();
        (old.material as THREE.Material).dispose();
        grid = ng;
      }
      // A trustworthy solid is brand amber pulled toward the surface it sits on.
      for (const m of solidMats) m.color = accent.clone().lerp(panel, 0.35);
      // An unsound one is the status-error colour, undiluted. It is meant to be
      // the loudest thing on screen.
      for (const m of unsoundMats) m.color = bad;
      for (const m of wireMats) m.color = bad.clone().lerp(ink, 0.35);
      // 2D reads as annotation, not as material.
      for (const m of flatMats) m.color = muted.clone().lerp(panel, 0.25);
      /* The origin cross is an INSTRUMENT and reads as one: a single muted
       * colour, no per-axis hue. OpenSCAD draws its own origin axes in one grey
       * for the same reason — the coloured, labelled triad is the corner gizmo,
       * and two coloured instruments in one viewport is a question about which
       * to read. */
      for (const m of originArmMats) m.color = muted.clone().lerp(ink, 0.2);
    };
    kit.current.applyPalette = applyPalette;
    applyPalette();

    /* ══════════════════════════════════════════════════════════════════════
       WHAT THE CAMERA ORBITS (founder, 2026-08-11: *"the center (mouse
       rotation) should be in the middle of the base area"*)
       ══════════════════════════════════════════════════════════════════════

       🔴 WHAT IT WAS BEFORE THIS CHANGE, MEASURED RATHER THAN REMEMBERED: the
       target was `centre`, the full three-axis midpoint of the bounds, captured
       here and handed to `frameScene`. A 40 mm box standing on z = 0 therefore
       orbited about a point 20 mm in the air. It is now {@link framing}'s pivot
       — the XY centre at z = 0 — with the framing radius re-derived about that
       pivot so `Fit` still contains the model.

       🔴 AND THIS IS THE ONLY PLACE IT IS COMPUTED, WHICH IS WHAT KEEPS IT OFF
       THE PER-KEYSTROKE PATH. This effect runs on `[result]` — the DEBOUNCED
       mesh — and it does not move the camera: it only records where the camera
       WOULD go. Only `frameScene` moves it, and `frameScene` has exactly two
       callers, both explicit: the first non-empty scene, and the `Fit` button.
       A pivot recomputed into the live camera on every parse would make the view
       lurch under the operator's hands as they type, and it would read as a
       rendering fault rather than as a camera policy.

       ⚠ AN EMPTY SCENE LEAVES ALL OF IT ALONE. `framing(null)` is `null`, so
       `lastPivot`/`lastSpan` keep their previous values and `framedOnce` stays
       false until something has actually been drawn. A refusal cascade mid-edit
       — a half-typed `difference(` renders the tree minus every subtree — must
       not be able to fling the camera anywhere, and `Fit` pressed in that state
       re-frames the last real model rather than a point at the origin. */
    const frame = framing(
      has ? { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] } : null,
    );
    if (frame) {
      kit.current.lastPivot = new THREE.Vector3(...frame.pivot);
      kit.current.lastSpan = frame.span;
      // ONCE. See the note on `refit` — after the first framing the camera
      // belongs to the user, and the "Fit" control is how they hand it back.
      if (!kit.current.framedOnce) {
        kit.current.framedOnce = true;
        kit.current.frameScene?.(kit.current.lastPivot, frame.span);
      }
    }
  }, [result]);

  /**
   * 🔴 THE TOGGLES, PUSHED INTO THE RENDER LOOP RATHER THAN CLOSED OVER.
   *
   * The setup effect has `[]` deps deliberately — re-running it would tear down
   * the renderer and the canvas — so it cannot see a prop that changed. It reads
   * `kit.current.view` on each frame instead, and this is the one writer.
   *
   * ⚠ THE ORIGIN CROSS IS SET HERE **AND** AT BUILD TIME IN THE `[result]`
   * EFFECT. Neither alone is enough: this one misses a group built after the
   * toggle changed, and that one misses a toggle changed after the group was
   * built. The ruler needs no equivalent because its rebuild key already
   * contains the toggle.
   */
  useEffect(() => {
    kit.current.view = { axes: showAxes, scale: showScaleMarkers, projection };
    if (kit.current.originAxes) kit.current.originAxes.visible = showAxes;
  }, [showAxes, showScaleMarkers, projection]);

  const solids = result.parts.filter((p) => p.dim === 3);
  const unsound = solids.filter((p) => p.audit && p.audit.verdict !== 'closed');
  const colourOverridden = useMemo(
    () => result.parts.filter((p) => materialFor(p).overridden !== null),
    [result],
  );

  /**
   * 🔴 A GREEN THAT FIRES ON EVERY SUCCESSFUL PARSE IS NOT A SIGNAL.
   *
   * This box used to open with `MESH AUDITED — watertight` in the OK colour on
   * every clean model, which is nearly every model — and a banner that is almost
   * always present is one the eye stops reading, including on the day it says
   * something else in the same slot (founder, 2026-08-11: *"remove MESH
   * AUDITED"*).
   *
   * 🔴 THE AUDIT'S ANSWER DID NOT GO WITH THE LABEL. `preview.tsx` refuses to
   * draw what the audit cannot stand behind, `record.ts` refuses to save it and
   * `Export as STL` refuses on the same terms — so a verdict that is anything
   * other than `trusted` is stated here as loudly as before, and MORE
   * conspicuously now that nothing occupies the slot when it is fine.
   *
   * ⚠ `suspect` IS NOT FINE. It is what a model with a refused construct
   * reports: sound geometry that is MISSING a feature the source asked for. It
   * is the state most likely to be mis-read as clean once the green is gone, so
   * it is on the loud side of this line, in the warn colour, by name.
   */
  const quiet = result.trust === 'trusted';
  /**
   * 🔴 WHETHER THERE IS ANYTHING TO SAY AT ALL — the gate the whole overlay
   * hangs on, and it is deliberately NOT `!quiet` alone.
   *
   * The unsound list and the colour-override sentence are both reachable only
   * from a part whose audit is not `closed`, and `mesh.ts` returns `untrusted`
   * for exactly that — so `!quiet` would in fact cover them today. That is an
   * argument about somebody ELSE's function, made here, about a fact that could
   * change in `mesh.ts` without anything going red. So each statement gates on
   * its own content: this box appears when there is something in it, and a
   * future verdict rule cannot silently take a statement off the picture.
   */
  const speak = !quiet || unsound.length > 0 || colourOverridden.length > 0;
  const tone =
    result.trust === 'trusted'
      ? 'var(--line)'
      : result.trust === 'untrusted'
        ? 'var(--bad)'
        : result.trust === 'nothing'
          ? 'var(--muted)'
          : 'var(--warn)';

  return (
    <div
      data-testid="cad-preview"
      data-trust={result.trust}
      data-stale={stale ? 'yes' : 'no'}
      /* Absent until measured — see the state's note. */
      data-gl={gl ? (gl.ok ? 'ok' : 'unavailable') : undefined}
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 260 }}
    >
      {gl && !gl.ok ? (
        /* 🔴 THE ALARM BLOCK AND THE STALE BANNER STAY. They are ordinary markup
         * and they carry the two facts that matter most when there is no
         * picture: what the mesher concluded, and whether it concluded it about
         * the source currently in the editor. The absence panel is inset to
         * clear both rather than covering them — losing the audit because the
         * canvas failed would be exactly the trade this whole change exists to
         * refuse.
         *
         * ⚠ IT MOVED TO THE LOWER HALF ON 2026-08-11, because the overlays it
         * has to clear moved to the top with the verdict box's removal. A panel
         * inset to dodge a banner that is no longer under it would have covered
         * the banner that now is. */
        <GlUnavailable
          testid="cad-preview-gl-unavailable"
          detail={gl.detail ?? 'no message'}
          unaffected="The parse, the mesh audit and the diagnostics"
          stillWorks={
            'Everything else on this tab still works: the editor and the source in it, the ' +
            'console with every refusal and warning on its own line, and the audit verdict ' +
            'above — which is the mesher’s answer, not the picture’s.'
          }
          style={{
            position: 'absolute',
            top: '45%',
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
          }}
        />
      ) : (
        <div
          ref={host}
          /* 🔴 THE DRAG DIRECTIONS LIVE ON THE THING THEY DESCRIBE. They used to
           * be the first sentence of a three-sentence footer under the picture,
           * which the founder removed (2026-08-11). A tooltip on the viewport
           * itself is where a hand that is already on it will look, and it costs
           * no vertical space on every model forever. The directions themselves
           * were measured against OpenSCAD's convention (2026-08-10 audit, F3) —
           * see the note above `pointerdown`, which is the authority for them. */
          /* 🔴 AND THE SECOND SENTENCE IS THE ONE THAT STOPS A `translate()`
           * GOING TO THE WRONG PLACE. Coloured, lettered XYZ arrows are read as
           * the origin by everybody; these ones sit at the point the view
           * rotates and zooms about, which is only the origin by coincidence.
           * The picture cannot say that for itself, so it is said here and on
           * the `Fit` control — the two places a hand is already going. */
          title={
            'Drag to orbit · shift-drag or right-drag to pan · wheel to zoom — the same directions as ' +
            'the CNC tab’s viewport and as OpenSCAD. ' +
            'The coloured X/Y/Z arrows mark the point all three turn about, NOT [0,0,0] — the plain ' +
            'grey cross with the dashed negative arms is the origin.'
          }
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            border: '1px solid var(--line)',
            // Dimmed while the mesh is behind the source. The picture is still
            // there — hiding it would lose the last known-good shape — but it is
            // visibly not current.
            opacity: stale ? 0.35 : 1,
            transition: 'opacity 120ms linear',
          }}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════
          THE OVERLAY COLUMN — and it is TOP-ANCHORED ON PURPOSE
          ══════════════════════════════════════════════════════════════════

          🔴 `cad-preview-verdict` IS GONE (founder, 2026-08-11: *"remove
          cad-preview-verdict"*), AND IT WAS NOT A RESTATEMENT OF ANYTHING —
          checked before deleting, because four of the six things in it had no
          second home:

            · the verdict WORD and the mesher's `trustDetail` — nowhere else on
              screen. `Design → Check Validity` prints them behind a menu.
            · the UNSOUND SOLIDS list — the ONLY statement of mesh soundness
              anywhere in this tab since `MESH AUDITED` was removed the same
              morning. `consoleLines()` reads `mesh.issues`; a part's `audit`
              is not an issue and never reaches the console.
            · the COLOUR-OVERRIDE sentence — the only place the operator is told
              that the colour they wrote is not the colour they are looking at.
            · the `Fit` control — the only caller of `refit`, and the only route
              back to a framed view now that the camera is not reset per mesh.

          So all four MOVED, into the block below, and only the sixth was
          genuinely a duplicate: the `N refused · N flagged · see the console`
          line. Its refusal half is inside `trustDetail` verbatim (*"…are
          missing from this picture entirely. What you see is a subset of the
          model"*), and its warning half is the console pane's rows plus the
          dock tab's badge — which `112d2e34b9` ruled must stay visible whatever
          pane is showing, precisely so this surface does not have to repeat it.

          🔴 WHAT ACTUALLY CHANGED, THEN, IS THE THING THE FOUNDER WAS LOOKING
          AT: the box rendered on EVERY model, bordered and padded, taking up to
          38% of the picture, because the `Fit` row in it was unconditional. It
          now says nothing when there is nothing to say — the same rule that
          removed `MESH AUDITED`, the counts strip and the export receipt.

          🔴 AND THE POSITION IS A GUARANTEE, NOT A NUMBER. The old box spanned
          `left: 8 … right: 8, bottom: 8` and therefore covered the corner gizmo,
          which was answered with a shared `GIZMO_CLEARANCE` and a test asserting
          the two could not drift. **Everything here is anchored to the TOP**, so
          no overlay can reach the bottom-left corner at any pane size, and the
          constant and its test are removed as the orphans they became. */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          /* The column is only as tall as its content, but it still spans the
           * full width — so it is transparent to the pointer and each child
           * opts back in. A dead band across a viewport is indistinguishable
           * from a broken viewport. */
          pointerEvents: 'none',
        }}
      >
        {stale && (
          <div
            data-testid="cad-preview-stale"
            style={{
              padding: '6px 8px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--warn)',
              background: 'var(--panel)',
              color: 'var(--warn)',
              fontWeight: 600,
              /* 🔴 IT MUST NOT EAT THE DRAG. This banner spans the full width of
               * the viewport across the top, and it is pure information — there
               * is nothing in it to click, scroll or select. Left interactive it
               * swallowed every pointerdown that started in that strip, so an
               * orbit begun at the top of the picture simply did not happen, on
               * a surface whose only interaction IS dragging. Stated on the
               * element itself and not inherited from the column: this is the
               * property a test reads, and a child that opted back in would be
               * the same defect with the same symptom. */
              pointerEvents: 'none',
            }}
          >
            STALE — the source has changed and this is the previous mesh. Not a picture of what is in the editor.
          </div>
        )}

        {/* Everything the audit has to say, and nothing when it has nothing.
            It sits ON the picture rather than in a panel elsewhere, because the
            picture is the thing being believed. */}
        {speak && (
          <div
            data-testid="cad-preview-alarm"
            style={{
              /* ⚠ INTERACTIVE, AND THEREFORE IT COSTS DRAG AREA. It has to be:
               * it scrolls, and its text is meant to be selectable and quoted.
               * The mitigation is to keep it SMALL and to keep it rare — it is
               * absent on a clean model, which is most of them. */
              pointerEvents: 'auto',
              /* A fixed pixel cap rather than a percentage: this is a flex child
               * of an auto-height column, and a percentage max-height against an
               * auto-height parent computes to `none` — a silent no-op that
               * would let a model with forty unsound parts cover the picture. */
              maxHeight: 220,
              overflow: 'auto',
              padding: '8px 10px',
              borderRadius: 'var(--radius)',
              border: `1px solid ${tone}`,
              background: 'var(--panel)',
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {/* The verdict WORD, and only when there is one to give. */}
            {quiet ? null : (
              <div style={{ color: tone, fontWeight: 700, marginBottom: 4 }}>
                {result.trust === 'untrusted'
                  ? 'DO NOT TRUST THIS PICTURE'
                  : result.trust === 'nothing'
                    ? 'NOTHING DRAWN'
                    : 'PARTLY TRUSTED — this picture is missing something your source asked for'}
              </div>
            )}

            {/* 🔴 `trustDetail` IS THE MESHER'S OWN SENTENCE AND IT IS THE ONE
                THING THAT SURVIVES SOMEBODY READING ONLY THIS BOX — it is where
                "N construct(s) were REFUSED" reaches the picture, because a
                construct refused by the PARSER is not a `MeshIssue` and so
                never becomes a console row about the mesh. It is printed
                whenever the verdict is not clean; when it IS clean the sentence
                says so, which is the thing that was removed. */}
            {quiet ? null : <div style={{ color: 'var(--muted)' }}>{result.trustDetail}</div>}

            {/* 🔴 THE MESH AUDIT'S OWN ANSWER, PER PART, AND THIS IS ITS ONLY
                HOME. The console lists diagnostics; an audit verdict is not a
                diagnostic and `consoleLines()` cannot see it. Deleting this with
                the box would have left the tab with no statement at all that a
                solid is open or non-manifold — on the morning the green banner
                that used to say the opposite was also removed. */}
            {unsound.length > 0 && (
              <ul data-testid="cad-preview-unsound" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {unsound.map((p) => (
                  <li key={p.id} style={{ marginBottom: 3 }}>
                    <span style={{ color: 'var(--bad)' }}>
                      line {p.line} · {p.label} · {p.audit!.verdict}
                    </span>{' '}
                    <span style={{ color: 'var(--muted)' }}>{p.audit!.detail}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* 🔴 A COLOUR THE SOURCE ASKED FOR AND THE PICTURE REFUSED HAS TO
                SAY SO. `materialFor` overrules a `color()` on any part whose
                audit is not `closed`, so the loudest thing on screen cannot be
                switched off from the source. That is the right rule and it makes
                the viewport disagree with a line the operator wrote — silently,
                unless this sentence is here. It appears ONLY when it actually
                happened. */}
            {colourOverridden.length > 0 && (
              <div data-testid="cad-preview-colour-overridden" style={{ color: 'var(--warn)', marginTop: 6 }}>
                {colourOverridden.length} part(s) carry a color() this picture is NOT using — they failed the
                mesh audit and are drawn in the error colour instead, because a part that cannot be trusted
                must not be paintable. Lines {colourOverridden.map((p) => p.line).join(', ')}.
              </div>
            )}
          </div>
        )}

        {/* 🔴 NO DEAD CONTROLS IN THE DEGRADED STATE. With no renderer there is
            no orbit, no pan, no zoom and nothing for `Fit` to fit — `refit` is
            never assigned, so the button would render, look live, and do NOTHING
            when pressed. A dead control is worse than a missing one: it teaches
            that the tab is broken rather than that the picture is absent, and
            the absence panel has already said which it is. The one sentence in
            this slot that is NOT about the camera — that nothing this lane has
            produced has ever been cut — is what takes its place, because it is
            true whether or not anything is drawn. */}
        {gl && !gl.ok ? (
          <div style={{ color: 'var(--muted)', fontSize: 12, pointerEvents: 'none' }}>
            Nothing this app has produced has ever been cut.
          </div>
        ) : (
          <div style={{ alignSelf: 'flex-end', pointerEvents: 'auto' }}>
            <button
              type="button"
              data-testid="cad-preview-fit"
              onClick={() => kit.current.refit?.()}
              title={
                'Frames the whole model again, about the point the view orbits and zooms about — the ' +
                'point the coloured X/Y/Z arrows sit on. That point is the XY centre of the model at ' +
                'z = 0, and a pan moves it; it is NOT [0,0,0], which is marked by the plain grey cross. ' +
                'The camera is no longer reset when the mesh recomputes, so this is what gives the ' +
                'whole model back.'
              }
            >
              Fit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default CadPreview;
