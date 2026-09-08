// 2bee.cad — the ruler along each axis: where the ticks go, how long they are,
// and which of them carry a number.
//
// Founder 2026-08-11: *"like in openscad able to enable/disable the rulers for
// xyz"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 READ AT OPENSCAD'S OWN SOURCE, WITH THE LINE NUMBERS, NOT RECONSTRUCTED
// ═══════════════════════════════════════════════════════════════════════════
//
// `/home/gbacs/apps/openscad`, OpenSCAD 2026.08.07. Three files, and the third
// is the one that decides the arithmetic:
//
//   · `src/gui/MainWindow.cc:512`  `settings.value("view/showAxes", true)`
//   · `src/gui/MainWindow.cc:518`  `settings.value("view/showScaleProportional", true)`
//     ⇒ **BOTH DEFAULT TO TRUE.**
//   · `src/gui/MainWindow.cc:2759-2763` — the axes toggle also runs
//     `viewActionShowScaleProportional->setEnabled(checked)`, and
//     `src/glview/GLView.cc:198` renders on `if (showaxes && showscale)`.
//     ⇒ **THE SCALE TOGGLE IS A CHILD OF THE AXES TOGGLE**, disabled in the menu
//     and ANDed in the renderer. Two independent booleans would let an operator
//     turn "scale markers" on and see nothing, with the control saying they are
//     on — a live-looking dead control.
//   · `src/glview/GLView.cc:505-607` `showScalemarkers()`, and
//     `src/glview/Camera.cc:188` `zoomValue() { return viewer_distance; }`
//     ⇒ **`l` IS THE CAMERA'S DISTANCE FROM ITS TARGET**, which is this
//     viewport's `radius`. It is NOT the model size, so the ruler re-scales when
//     you zoom and not when the model changes.
//
// The arithmetic, transcribed:
//
//   const int log_l = (int) floor(log10(l));
//   const double l_adjusted = pow(10, log_l);
//   const double tick_width = l_adjusted / 10.0;
//   const int size_div_sm = 60;              // minor tick size divisor
//   size_t divs = l / tick_width;            // ⇒ always 10 ≤ divs < 100
//   for (div = 0; div < divs; ++div) {
//     double i = div * tick_width;
//     if (line_cnt > 0 && line_cnt % 10 == 0) { size_div = size_div_sm * .5;   // major
//                                               decodeMarkerValue(i, l, size_div_sm); }
//     else                                      size_div = size_div_sm;        // minor
//     ...  glVertex3d(i, 0, 0); glVertex3d(i, -l/size_div, 0);   // x, one arm, toward -Y
//          glVertex3d(0, i, 0); glVertex3d(-l/size_div, i, 0);   // y, toward -X
//          glVertex3d(0, 0, i); glVertex3d(-l/size_div, 0, i);   // z, toward -X
//     ...  the same three again at -i, wrapped in glLineStipple(3, 0xAAAA)
//   }
//
// OpenSCAD's own comment for the `floor(log10())`: *"This is done so that the
// tick denominations change every time the viewport gets 10x bigger or smaller,
// but stays constant in-between. l_adjusted is a step function of l."* **That
// step function is the whole reason this module exists as a separate thing.**
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE ONE STRUCTURAL DIFFERENCE, AND EVERY DIVERGENCE BELOW FOLLOWS FROM IT
// ═══════════════════════════════════════════════════════════════════════════
//
// OpenSCAD emits this geometry **inside its paint function, every frame**, in
// immediate mode: `glBegin/glVertex3d/glEnd`. Per-frame tick geometry is free
// there. In three.js it is a `BufferGeometry` allocation, a `CanvasTexture` per
// number and a `dispose()` for each — per frame that is exactly the scene-rebuild
// thrash this viewport already had once and fixed by keying on value.
//
// ⇒ **This module is a PURE PLAN, rebuilt only when its inputs change**, and its
// inputs are chosen so that they change rarely: the DECADE (not the zoom) and
// the axis length. {@link rulerSignature} is what the render loop compares.
//
// ⇒ And it forces two named divergences, both of which are OpenSCAD quantities
// that are functions of the LIVE `l` rather than of the decade:
//
//   1. **TICK LENGTH.** OpenSCAD's minor arm is `l/60` and its major is `l/30`.
//      Within one decade `l` spans a factor of ten, so `l/60` spans
//      `[tick_width·10/60, tick_width·100/60]` = `[0.167, 1.67]` × the spacing,
//      and `l/30` spans `[0.33, 3.33]` ×. We use CONSTANT multiples of the
//      spacing — {@link MINOR_LENGTH_RATIO} and {@link MAJOR_LENGTH_RATIO} —
//      chosen to sit inside those ranges, so the ruler is decade-stable and the
//      arms never leave the band OpenSCAD's own arms occupy.
//   2. **NUMBER SIZE.** Same reasoning; OpenSCAD's `font_size` is `l/60`, i.e.
//      exactly its minor tick length.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHERE THE TICKS STOP, AND WHY IT IS NOT `l`
// ═══════════════════════════════════════════════════════════════════════════
//
// OpenSCAD runs its ticks out to `l` because its axes are literally infinite —
// `showAxes()` emits the positive half with `w = 0` homogeneous vertices — so a
// tick can never be drawn past the end of the line it annotates. **Ours are
// finite** (`THREE.Line` has no point at infinity; `preview.tsx` cuts the arms at
// a multiple of the model span and says so), so the extent is capped by `reach`:
// a tick floating in space past the end of its own axis is an instrument
// annotating nothing.
//
// 🔴 AND THE OTHER HALF OF THE CAP IS **NOT `l`**, WHICH IS THE ONE THING IN
// THIS MODULE THAT HAD TO BE MEASURED BEFORE IT WAS BELIEVED. The obvious
// reading of OpenSCAD is `extent = min(l, reach)`. It is wrong here, and the
// test caught it: `l` is CONTINUOUS. Whenever the camera is closer than the end
// of the axis — which is every zoomed-in view — `min(l, reach)` moves on every
// wheel notch, so the rebuild key moves with it and the ruler is rebuilt every
// frame. That is precisely the cost the decade exists to avoid, reintroduced one
// line below the thing that avoided it.
//
// ⇒ The extent is the **top of the decade**, `10^(decade+1)` — which is exactly
// `MAJOR_EVERY^2` tick widths, i.e. OpenSCAD's own upper bound on `divs` — capped
// by `reach`. It is a step function of the same input the spacing is, so the
// whole plan changes only when the decade or the model does. The cost is drawing
// at most ten times as much ruler as is on screen at the bottom of a decade,
// which is geometry outside the frustum and is bounded at
// {@link MAX_TICKS_PER_AXIS} ticks per axis.
//
// ⚠ THE CAP IS ALSO THE ONLY THING BOUNDING THE WORK. `divs = l / tick_width` is
// between 10 and 100 BY CONSTRUCTION for OpenSCAD — the decade is taken from `l`
// itself — so it needs no cap. `reach` is not derived from `l`, so a large model
// viewed from close up (`reach` 75 000 mm, `zoom` 1 mm) would otherwise ask for
// 750 000 ticks. {@link rulerPlan} enforces the bound rather than trusting it.

/** OpenSCAD's `size_div_sm` — a minor tick is `l / 60`. Kept for the record. */
export const OPENSCAD_MINOR_DIV = 60;
/** OpenSCAD's major: `size_div_sm * .5`, i.e. `l / 30`. */
export const OPENSCAD_MAJOR_DIV = 30;

/**
 * Minor tick length as a multiple of the tick SPACING.
 *
 * See the header: OpenSCAD's `l/60` is between `0.167` and `1.67` spacings
 * within any one decade. `0.5` is inside that band and does not move within a
 * decade, which is what lets the geometry be rebuilt on a decade change instead
 * of on a frame.
 */
export const MINOR_LENGTH_RATIO = 0.5;
/** Major tick length, same units and the same argument (`l/30` ⇒ `[0.33, 3.33]`). */
export const MAJOR_LENGTH_RATIO = 1;
/** Number height, same units. OpenSCAD's `font_size` is its minor tick length. */
export const LABEL_HEIGHT_RATIO = 0.6;

/**
 * Every tenth tick is major and carries a number — `line_cnt % 10 == 0`.
 * With the extent capped at a hundred ticks that is at most ten numbers per
 * axis direction, so at most sixty canvas textures for the whole ruler.
 */
export const MAJOR_EVERY = 10;

/**
 * The hard bound, enforced rather than assumed. `divs = l / tick_width` is
 * `< 100` by construction for OpenSCAD because the decade comes from `l`; our
 * extent is capped by `reach`, which comes from the MESH, so the bound has to be
 * re-established rather than inherited.
 */
export const MAX_TICKS_PER_AXIS = MAJOR_EVERY * MAJOR_EVERY;

/** One tick on one axis, on the positive side. The negative side mirrors it. */
export interface RulerTick {
  /** Distance from the origin, in millimetres. Always `> 0`. */
  at: number;
  /** True ⇒ longer arm and a printed number. `line_cnt % 10 == 0`. */
  major: boolean;
  /**
   * The number to print, or `null` on a minor tick. Formatted from the DECADE
   * rather than from the accumulated product — see {@link formatTick}.
   */
  label: string | null;
}

export interface RulerPlan {
  /** `floor(log10(zoom))`. The step function; the whole rebuild key. */
  decade: number;
  /** `10^decade / 10`. The distance between two adjacent ticks, in mm. */
  tickWidth: number;
  /**
   * Where the ruler stops, in mm — `min(10^(decade+1), reach)`. A step
   * function of the decade and the model, never of the live zoom. See the
   * header for the defect that made it so.
   */
  extent: number;
  minorLength: number;
  majorLength: number;
  labelHeight: number;
  /** Positive side only, ascending, never empty. */
  ticks: RulerTick[];
}

/**
 * OpenSCAD's `floor(log10(l))`, with the cases `log10` answers uselessly.
 *
 * ⚠ `l <= 0` and a non-finite `l` are not "decade 0", they are NO RULER. A zoom
 * of zero is a camera sitting on its own target; inventing a decade for it would
 * draw a ruler whose spacing is unrelated to anything on screen.
 */
export function tickDecade(zoom: number): number | null {
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  return Math.floor(Math.log10(zoom));
}

/**
 * The printed number for the `n`th tick, formatted FROM THE DECADE.
 *
 * 🔴 NOT `String(n * tickWidth)`. `tickWidth` is `10^decade / 10`, which is not
 * representable in binary for any negative decade, so the product accumulates
 * error: at `decade = -1`, `30 * 0.01` is `0.30000000000000004` and the ruler
 * would print exactly that beside a tick. The value of a major tick is
 * `(n / 10) * 10^decade` by construction, so the number of decimals it needs is
 * known from `decade` alone and `toFixed` is exact for it.
 */
export function formatTick(n: number, decade: number): string {
  const value = (n / MAJOR_EVERY) * Math.pow(10, decade);
  const decimals = Math.max(0, -decade);
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

/**
 * The whole ruler for one axis direction, or `null` when there is nothing to
 * draw.
 *
 * @param zoom  The camera's distance from its target — OpenSCAD's
 *              `cam.zoomValue()`, which is `viewer_distance`.
 * @param reach How far the axis line itself is drawn, in mm. Ticks stop at the
 *              end of the line they annotate; see the header.
 *
 * ⚠ `null` is returned rather than an empty plan when the first tick would
 * already be past the end of the axis. An empty ruler and an absent one are the
 * same picture, and only one of them needs geometry built for it.
 */
export function rulerPlan(zoom: number, reach: number): RulerPlan | null {
  const decade = tickDecade(zoom);
  if (decade === null) return null;
  if (!Number.isFinite(reach) || reach <= 0) return null;

  const tickWidth = Math.pow(10, decade) / MAJOR_EVERY;
  if (!Number.isFinite(tickWidth) || tickWidth <= 0) return null;

  /* 🔴 NOT `min(zoom, reach)`. See the header — that is the obvious reading of
   * OpenSCAD and it silently makes the rebuild key continuous. `tickWidth *
   * MAJOR_EVERY^2` is `10^(decade+1)`, written this way because it is the same
   * quantity as OpenSCAD's largest `divs`, and reading it as "one hundred ticks"
   * is the property that matters here. */
  const extent = Math.min(tickWidth * MAJOR_EVERY * MAJOR_EVERY, reach);
  const ticks: RulerTick[] = [];
  /* From 1, not 0. OpenSCAD's `div = 0` draws a zero-length-offset tick at the
   * origin — where the axis cross already is — and its `line_cnt > 0` guard then
   * denies it a label. It is a tick with no arm to distinguish it and no number,
   * on top of the one instrument that is always drawn there. */
  for (let n = 1; n <= MAX_TICKS_PER_AXIS; n++) {
    const at = n * tickWidth;
    if (at > extent) break;
    const major = n % MAJOR_EVERY === 0;
    ticks.push({ at, major, label: major ? formatTick(n, decade) : null });
  }
  if (ticks.length === 0) return null;

  return {
    decade,
    tickWidth,
    extent,
    minorLength: tickWidth * MINOR_LENGTH_RATIO,
    majorLength: tickWidth * MAJOR_LENGTH_RATIO,
    labelHeight: tickWidth * LABEL_HEIGHT_RATIO,
    ticks,
  };
}

/**
 * 🔴 THE REBUILD KEY, AND IT IS THE POINT OF THE WHOLE MODULE.
 *
 * The render loop calls this every frame and compares it with the last one it
 * built. It is deliberately NOT a function of `zoom` — it is a function of the
 * DECADE of the zoom — so a continuous wheel scroll inside one decade produces
 * one signature and rebuilds nothing. Crossing a power of ten changes it once.
 *
 * ⚠ `reach` is in the key because the axis lines are sized to the model, so a
 * new mesh with different bounds moves the end the ticks stop at. That happens
 * at the mesh cadence (250 ms after typing stops), never per frame.
 *
 * ⚠ `off` returns a signature too, rather than the caller skipping the compare.
 * A toggle turned off has to rebuild — to nothing — and a caller that skipped
 * the comparison while off would leave the last ruler on screen.
 */
export function rulerSignature(zoom: number, reach: number, on: boolean): string {
  if (!on) return 'off';
  const plan = rulerPlan(zoom, reach);
  return plan === null ? 'none' : `${plan.decade}:${plan.extent}`;
}

/**
 * Which way a tick arm points, per axis — copied from OpenSCAD's own vertices.
 *
 * x: `(i,0,0) → (i, -len, 0)` · y: `(0,i,0) → (-len, i, 0)` · z:
 * `(0,0,i) → (-len, 0, i)`. So X ticks lie in the XY plane pointing at −Y, and
 * BOTH Y and Z ticks point at −X. That asymmetry is OpenSCAD's, not a slip: it
 * keeps every tick in a plane containing the viewer's default orientation.
 */
export const TICK_DIRECTION: Readonly<Record<'x' | 'y' | 'z', readonly [number, number, number]>> = {
  x: [0, -1, 0],
  y: [-1, 0, 0],
  z: [-1, 0, 0],
};

/** Unit vector along each axis, in the same order the plan is applied. */
export const AXIS_DIRECTION: Readonly<Record<'x' | 'y' | 'z', readonly [number, number, number]>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

export const AXES: readonly ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
