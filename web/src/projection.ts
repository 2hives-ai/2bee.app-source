// The projection mode — perspective or orthographic — for both 3D canvases.
//
// Founder 2026-08-11: *"2bee.app: add perspective / orthogonal view change
// capability in all 3d canvas."*
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 READ AT OPENSCAD'S OWN SOURCE, WITH LINE NUMBERS, NOT RECONSTRUCTED
// ═══════════════════════════════════════════════════════════════════════════
//
// `/home/gbacs/apps/openscad`, OpenSCAD 2026.08.07. Four files:
//
//   · `src/glview/Camera.h:29`
//       enum class ProjectionType { ORTHOGONAL, PERSPECTIVE }
//         projection{ProjectionType::PERSPECTIVE};
//     ⇒ **THE DEFAULT IS PERSPECTIVE.**
//   · `src/gui/MainWindow.cc:2849-2870` — `setProjectionType()` writes
//     `settings.setValue("view/orthogonalProjection", isOrthogonal)` and calls
//     `qglview->setOrthoMode(...)`. The two menu items are
//     `on_viewActionPerspective_toggled` / `on_viewActionOrthogonal_toggled`,
//     placed in an EXCLUSIVE `QActionGroup` (`MainWindow.cc:3920-3923`).
//     ⇒ **IT IS A TWO-WAY RADIO CHOICE, NOT A CHECKBOX**, persisted as one bool,
//     and `settings.value(...).toBool()` on an unset key is `false` ⇒ perspective.
//   · `src/gui/MainWindow.cc:504-522` — `loadViewSettings()` ends with
//     `viewTogglePerspective()`, which reads that bool back and checks the
//     matching action. ⇒ **THE CHOICE SURVIVES A RESTART**, alongside
//     `view/showAxes` and `view/showScaleProportional`, in the same store.
//   · `src/glview/GLView.cc:124-143` — `setupCamera()`, and this is the one that
//     decides the arithmetic:
//
//         auto dist = cam.zoomValue();                       // == viewer_distance
//         PERSPECTIVE: gluPerspective(cam.fov, aspect, 0.1*dist, 100*dist);
//         ORTHOGONAL : auto height = dist * tan_degrees(cam.fov / 2);
//                      glOrtho(-height*aspect, height*aspect,
//                              -height, height, -100*dist, +100*dist);
//         ...then, OUTSIDE the switch, in BOTH cases:
//         gluLookAt(0.0, -dist, 0.0,  0,0,0,  0,0,1);
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE TRAP, AND WHAT THE SOURCE ACTUALLY SAYS ABOUT IT
// ═══════════════════════════════════════════════════════════════════════════
//
// The expected trap is real in general: **in an orthographic camera, moving the
// eye closer changes nothing.** Perspective zoom is a dolly; orthographic zoom
// is a frustum scale. A naive port leaves the wheel dead in one mode, or leaves
// `Fit` framing the wrong volume in the other.
//
// 🔴 **AND OPENSCAD DOES NOT SOLVE IT BY BRANCHING THE HANDLERS. IT SOLVES IT BY
// NEVER HAVING TWO ZOOM QUANTITIES.** There is exactly ONE scalar,
// `viewer_distance`, and the ortho half-height is DERIVED from it —
// `height = dist * tan(fov/2)`, which is precisely the half-height a
// perspective frustum of the same `fov` subtends at that same distance. So:
//
//   · `Camera::zoom()` (`Camera.cc:117`) — `viewer_distance *= pow(0.9, …)`.
//     **No projection branch.** The wheel is alive in ortho because the scalar
//     it multiplies is what the ortho frustum is built from.
//   · `Camera::viewAll()` (`Camera.cc:78`) — `viewer_distance = radius /
//     sin(fov/2)`. **No projection branch.** Fit frames both.
//   · `GLView::showScalemarkers()` (`GLView.cc:508`) — `auto l = cam.zoomValue()`.
//     **No projection branch.** The ruler's decade means the same thing in both.
//   · `QGLView::zoomCursor()` (`QGLView.cc:510`) — computes its pan correction
//     from `dist * tan(fov/2)`, i.e. the ortho half-height, in BOTH modes.
//   · `gluLookAt` is outside the switch, so **the eye moves in ortho too** — the
//     modelview matrix is identical between projections and only the projection
//     matrix differs.
//
// ⇒ **This module is that one relation, written once, so neither tab can grow a
// second idea of what "zoom" is.** Every handler in both viewports keeps its
// existing `radius`, untouched and unbranched. What branches is the construction
// of the projection matrix, and nothing else.
//
// ⚠ THIS CONTRADICTS THE OBVIOUS DESIGN, which is why it is written down.
// "Branch `Fit`, branch the wheel, branch the clamps" is the reasonable guess and
// it is the wrong one: it would give the two modes two zoom scales that drift
// apart, so switching projection would jump the view. Reading the source beat
// reasoning about it again.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS BUYS, STATED AS INVARIANTS RATHER THAN AS A HOPE
// ═══════════════════════════════════════════════════════════════════════════
//
//  1. **THE WHEEL IS NOT DEAD IN ORTHO.** `radius` is the only zoom state; the
//     ortho half-height is `radius · tan(fov/2)`, strictly increasing in
//     `radius`. Asserted in `tests/projection.test.ts`.
//  2. **`Fit` FRAMES THE SAME VOLUME IN BOTH.** `orthoHalfHeight(r)` is BY
//     DEFINITION the perspective half-height at distance `r`, so whatever radius
//     the existing framing maths produces is correct for both projections. The
//     re-derivation in `cad/preview.tsx`'s `framing()` — the pivot at the base
//     area, z half-extent `max(|z_max|,|z_min|)` — is therefore **not touched and
//     not re-derived for ortho**. There is nothing to re-derive.
//  3. **THE ZOOM CLAMPS STAY DISTINCT.** They clamp `radius`, and `radius` is
//     still `radius`. CNC keeps `120…9000` (machine-sized), CAD keeps
//     `1…200000` (a 10 mm part must be reachable). Nothing here touches either,
//     and `tests/cad-camera-parity.test.ts` already fails if they collapse.
//  4. **THE RULER DECADE STILL MEANS THE SAME THING.** `rulerSignature(radius,…)`
//     is fed the same scalar, and the on-screen scale that scalar stands for is
//     the same in both modes by (2). So the rebuild key is still a step function
//     of the decade and a wheel scroll inside one decade still rebuilds nothing.
//  5. **THE CORNER GIZMO IS UNTOUCHED.** It has its own scene, its own
//     `OrthographicCamera` with a CONSTANT frustum, and its own scissor box. The
//     main camera's mode reaches none of that.
//
// ⚠ WHAT IS NOT VERIFIED: **appearance.** There is no browser in this harness
// and a projection change is a purely visual capability. What is asserted is the
// camera this code CONSTRUCTS, the branch each handler takes, and the invariants
// above — never that the picture looks orthographic.

/** The two modes. Named as OpenSCAD's menu names them. */
export type Projection = 'perspective' | 'orthographic';

/**
 * Both viewports' field of view, in degrees.
 *
 * 🔴 IT IS A MODULE CONSTANT NOW, AND THAT IS A REAL CHANGE, NOT TIDINESS. The
 * pan step used to read `camera.fov` off the live camera — which does not exist
 * on an `OrthographicCamera`. Reading it from a camera that may not have it is
 * how a pan silently becomes `NaN` the moment somebody switches mode.
 *
 * Both files already constructed their camera with `45`, so this changes no
 * number today; `tests/projection.test.ts` asserts both construction sites still
 * agree with it, because a divergence here would make one tab's pan and its
 * ortho frustum describe different frustums.
 */
export const CAMERA_FOV_DEG = 45;

/**
 * How far the orthographic depth range extends either side of the eye, as a
 * multiple of `radius` — OpenSCAD's `-100*dist … +100*dist` (`GLView.cc:136`).
 *
 * 🔴 THE NEAR PLANE IS NEGATIVE ON PURPOSE. It puts the near plane BEHIND the
 * camera, so nothing between the eye and the target can be clipped away. Taking
 * a positive near plane here — the reflex, by analogy with the perspective
 * camera — would silently slice the front off the model, and a part with its
 * near face missing is exactly the picture an operator must not be shown when
 * they are judging whether a cutter clears a clamp.
 *
 * ⚠ THE TRADE, NAMED: an orthographic depth buffer is LINEAR, so a `±100·radius`
 * range spreads 24 bits of depth over `200·radius` millimetres. At the CNC tab's
 * furthest zoom (`radius = 9000`) that is ~0.107 mm per depth step; at its
 * default framing (`radius ≈ 1400`) ~0.017 mm. Coincident surfaces in this app
 * are separated by explicit polygon offset rather than by depth resolution, so
 * this is a legibility trade and not a correctness one — but it is a trade, and
 * the alternative (a tighter range) buys precision by risking a clip, which is
 * the worse failure of the two.
 */
export const ORTHO_DEPTH_REACH = 100;

/**
 * The orthographic frustum's half-height, in world units, for an orbit distance
 * of `radius`.
 *
 * 🔴 THIS IS THE WHOLE MODULE. `dist * tan_degrees(cam.fov / 2)`, transcribed
 * from `GLView.cc:135`. It is BY CONSTRUCTION the half-height a perspective
 * frustum of the same fov subtends at distance `dist` — which is what makes
 * every framing, clamp and ruler decision projection-independent.
 */
export function orthoHalfHeight(radius: number): number {
  return radius * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
}

/** An orthographic camera's six frustum bounds, ready to assign. */
export interface OrthoFrustum {
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

/**
 * The frustum for an orbit distance and an aspect ratio.
 *
 * @param radius the orbit distance — the SAME scalar the perspective camera is
 *               placed at and the wheel multiplies. Not a separate zoom.
 * @param aspect canvas width / height.
 *
 * ⚠ `radius` and `aspect` are floored rather than trusted. A canvas can measure
 * zero (a hidden tab), and a zero-width frustum is a projection matrix full of
 * infinities that renders nothing and reports nothing.
 */
export function orthoFrustum(radius: number, aspect: number): OrthoFrustum {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const h = orthoHalfHeight(r);
  const depth = ORTHO_DEPTH_REACH * r;
  return { left: -h * a, right: h * a, top: h, bottom: -h, near: -depth, far: depth };
}

/**
 * World units per CSS pixel at the orbit distance — the pan step's `k`.
 *
 * 🔴 ONE EXPRESSION FOR BOTH PROJECTIONS, AND THAT IS A CONSEQUENCE, NOT A
 * SIMPLIFICATION. In perspective it is the frustum height at the target plane
 * divided by the canvas height; in ortho it is the frustum height divided by the
 * canvas height. Those are the same number, because `orthoHalfHeight` is defined
 * as the first one. OpenSCAD relies on exactly this in `zoomCursor`
 * (`QGLView.cc:510`), which computes its correction from `dist * tan(fov/2)`
 * whatever the projection.
 *
 * ⇒ A pan drags the model by the same distance under the cursor in both modes,
 * with no branch and nothing to keep in step.
 */
export function worldPerPixel(radius: number, viewH: number): number {
  return (2 * orthoHalfHeight(radius)) / Math.max(1, viewH);
}

/**
 * The CAD tab's default: **perspective**, because that is OpenSCAD's
 * (`Camera.h:29`, and an unset `view/orthogonalProjection` reads `false`). This
 * tab exists to be OpenSCAD-shaped and the founder has said *"like openscad"*
 * four times; a different default here would be a divergence bought for nothing.
 */
export const CAD_DEFAULT_PROJECTION: Projection = 'perspective';

/**
 * 🔴 THE CNC TAB'S DEFAULT IS **ORTHOGRAPHIC**, AND IT DELIBERATELY DISAGREES
 * WITH OPENSCAD AND WITH THE OTHER TAB IN THIS APP.
 *
 * This is a judgement with a consequence, not a preference, so it is stated
 * rather than inherited:
 *
 *   In the CNC viewport the operator is answering two questions — **does this
 *   part fit on this workpiece**, and **does this toolpath clear that clamp**.
 *   Perspective makes parallel edges converge and makes near things large. A
 *   part that fits can be made to look like it overhangs, and a clamp the cutter
 *   will actually strike can be made to look clear, purely by where the camera
 *   happens to be. Under an orthographic projection an edge that is parallel on
 *   the machine is parallel on the screen, and two things that overlap in the
 *   picture overlap in the machine.
 *
 * ⇒ **Orthographic is the honest default for a dimensional judgement.**
 * Perspective is easier to read as a shape, so it stays one click away — it is
 * not removed, and this is not a claim that perspective is wrong.
 *
 * ⚠ AND THIS IS NOT A COLLISION CHECK. The picture is not the guard: interference
 * is decided by the core, and a viewport in either projection is a picture. What
 * an orthographic default buys is that the picture stops CONTRADICTING the check
 * — it does not turn the picture into one.
 *
 * ⚠ THE TWO TABS THEREFORE DIFFER, ON PURPOSE. Making them match for tidiness
 * would mean either giving the CAD tab a non-OpenSCAD default or giving the CNC
 * tab a projection that misleads about fit. Neither is worth a consistent-looking
 * table. `tests/projection.test.ts` asserts they differ, so a later tidy-up has
 * to argue with a red test rather than with a comment.
 */
export const CNC_DEFAULT_PROJECTION: Projection = 'orthographic';

/**
 * Validate a persisted value.
 *
 * ⚠ ANYTHING THAT IS NOT ONE OF THE TWO WORDS FALLS BACK TO THE TAB'S DEFAULT —
 * a missing field, a corrupt blob, `true`, `1`, `"ortho"`. The same rule the CAD
 * layout uses for its instrument toggles: a preference store going bad may not
 * put a viewport into a state nobody chose.
 */
export function readProjection(v: unknown, fallback: Projection): Projection {
  return v === 'perspective' || v === 'orthographic' ? v : fallback;
}

/** The word shown on the control. Lowercase: these are chips, not sentences. */
export const PROJECTION_LABEL: Readonly<Record<Projection, string>> = {
  perspective: 'perspective',
  orthographic: 'orthographic',
};
