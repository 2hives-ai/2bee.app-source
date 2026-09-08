// 3D viewport — bed, stock, clamps, toolpath.
//
// three.js is driven imperatively inside one effect rather than through a
// declarative wrapper: the scene is rebuilt wholesale whenever the report
// changes, and a partial-update path would be a second source of truth about
// what is on screen.

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  decodeLoadedMesh,
  decodeStockSurface,
  type ClampCfg,
  type DrawingContour,
  type DrawingPart,
  type LoadedMesh,
  type Placement2D,
  NO_PLACEMENT,
  type RenderKind,
  type RenderMove,
  type StockSurface,
  type ToolRow,
} from './cam';
// 🔴 The tool marker is drawn from the SAME reading as the 2D tool drawing —
// see the TODO #44 block below. This import is the seam that stops the two
// views describing one cutter differently: the WORDS
// (`describeToolShape`), the FIELD READING and the TIP (`readToolShape`,
// which resolves through `resolveToolTip`) all come from that file. Nothing
// here re-derives the shape of a cutter.
import {
  describeToolShape,
  readToolShape,
  toolCategoryKey,
  type ToolTip,
} from './toolShape';
import {
  CAMERA_FOV_DEG,
  orthoFrustum,
  worldPerPixel,
  type Projection,
} from './projection';

/* ═══ WEBGL MAY SIMPLY NOT BE THERE, AND THAT MUST NOT COST THE PROGRAM ══════
 *
 * 🔴 BOTH VIEWPORTS IN THIS APP BUILD A `WebGLRenderer` INSIDE A REACT EFFECT,
 * and until 2026-08-11 both did it unguarded. An exception thrown from an
 * effect is not caught by React: it propagates out of the commit and UNMOUNTS
 * THE WHOLE TREE, so `document.body` renders ZERO CHARACTERS. No panels, no
 * settings, no refusals, no G-code, no download, and no sentence saying why.
 *
 * ⚠ THE CONSEQUENCE IS THE POINT, not the exception. On a locked-down shop PC,
 * a remote-desktop session, a VM, or a browser with hardware acceleration
 * switched off, EVERYTHING THAT MATTERS STILL WORKS — the job plans, the checks
 * run, the program posts. The operator would be denied a program they could
 * have downloaded because a PICTURE failed.
 *
 * ⚠ Measured on this box 2026-08-11: bare `canvas.getContext('webgl')` returns
 * `null` in its Chromium, on a blank page, with and without swiftshader flags.
 * The trigger is real and it is not ours. The RESPONSE to it is entirely ours.
 *
 * 🔴 AND THE DEGRADED VIEW DRAWS NOTHING. No 2D substitute, no outline, no
 * placeholder rectangle, no "roughly what it would look like". A canvas drawing
 * that resembles the viewport but is not the scene the checks were run against
 * is worse than an honest absence — it is the same rule `cad/preview.tsx`
 * already applies to a refused construct, and the same rule this lane's whole
 * position rests on: a picture that lies about a shape is worse than no picture.
 */

/** The result of trying to build a renderer. There is no third state: a
 *  renderer either exists or there is a reason it does not. */
export type GlAttempt =
  | { ok: true; renderer: THREE.WebGLRenderer }
  | { ok: false; detail: string };

/**
 * Build a `WebGLRenderer`, or say why not. **This function never throws.**
 *
 * 🔴 IT IS THE ONLY `new THREE.WebGLRenderer(` IN `web/src/`, and that is the
 * property `tests/gl-absent.test.ts` asserts rather than a style preference —
 * a second construction site is a second way to blank the application, and it
 * would be invisible to every check we have. Both viewports call this.
 *
 * ⚠ WHAT IT DOES NOT COVER, named rather than left to be discovered: a context
 * that is created and then LOST (`webglcontextlost`, a GPU reset, a driver
 * crash, a tab evicted in the background). That arrives as an event on a
 * renderer that constructed fine, not as an exception from this call, and
 * nothing in this file watches for it yet.
 */
export function tryRenderer(params: THREE.WebGLRendererParameters): GlAttempt {
  try {
    return { ok: true, renderer: new THREE.WebGLRenderer(params) };
  } catch (err) {
    // The browser's own words, kept and shown. The failure is NOT always the
    // one we expect — `Error creating WebGL context.` is three.js refusing a
    // null context, but a hardened browser can throw from `createElementNS`,
    // and a headless harness throws `document is not defined`. Naming the cause
    // ourselves would be asserting a diagnosis we did not make; quoting the
    // message states exactly what happened and nothing more.
    const raw = err instanceof Error ? err.message : String(err);
    const one = raw.replace(/\s+/g, ' ').trim();
    return {
      ok: false,
      // Bounded, because it goes on screen inside a fixed panel and a driver
      // can return a paragraph.
      detail: one ? (one.length > 240 ? `${one.slice(0, 240)}…` : one) : 'no message',
    };
  }
}

/**
 * The stated absence that goes where the picture would have been.
 *
 * 🔴 THE SECOND SENTENCE IS QUOTED, NOT WRITTEN. *"… are unaffected by what is
 * on screen"* is already the sentence the layer-toggle tooltips use for exactly
 * this fact (`App.tsx`, the `eye` control's `title`). One fact, one phrasing —
 * an operator who has read one should not have to work out whether the other
 * means something different.
 *
 * ⚠ THE SUBJECTS ARE THE CALLER'S because the two tabs do not hold the same
 * things: the CNC viewport sits over a program, checks and a simulation; the
 * CAD preview sits over a parse, a mesh audit and a console. Reusing the CNC
 * list on the CAD tab would name a program that tab does not have. The clause
 * is shared; what it is said ABOUT is not.
 *
 * ⚠ `App.tsx` holds a THIRD copy of the clause inline, and that file is not
 * this change's to touch. Reported rather than reached into.
 */
export function GlUnavailable(props: {
  /** The failure, in the browser's own words. */
  detail: string;
  /** Subject of the reused clause — e.g. "The program, the checks and the simulation". */
  unaffected: string;
  /** What this page can still do, said concretely enough to be acted on. */
  stillWorks: string;
  testid: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      data-testid={props.testid}
      style={{
        padding: '12px 14px',
        color: 'var(--muted)',
        font: '12px/1.55 var(--font-primary, inherit)',
        overflow: 'auto',
        ...props.style,
      }}
    >
      <div style={{ color: 'var(--warn)', fontWeight: 700, marginBottom: 6 }}>
        NO 3D VIEW — WebGL did not start
      </div>
      <p style={{ margin: '0 0 6px' }}>
        This browser could not create a WebGL context, so nothing is being drawn here. The renderer
        failed with: <span style={{ color: 'var(--ink)' }}>“{props.detail}”</span>
      </p>
      <p style={{ margin: '0 0 6px', color: 'var(--ink)' }}>
        {props.unaffected} are unaffected by what is on screen.
      </p>
      <p style={{ margin: '0 0 6px' }}>{props.stillWorks}</p>
      <p style={{ margin: 0 }}>
        Nothing has been drawn in place of the picture, on purpose: a substitute that is not the
        scene the checks were run against would be worse than an honest absence.
      </p>
    </div>
  );
}

/**
 * One drawing on the sheet, as the viewport needs to know it: the id the
 * PROGRAM calls its parts by, and the placement that id currently carries.
 *
 * 🔴 `offset` is the same quantity `ImportSource::offset_mm` is — a DELTA from
 * where the drawing was drawn, in SHEET millimetres, not an absolute corner and
 * not a machine coordinate. It is echoed here for one purpose: a drag has to be
 * measured from where the part currently is, and reading that off the panel
 * would make the gesture depend on a second copy of the number.
 */
export interface PartInstance {
  instance: string;
  offset: [number, number];
}

export interface ViewportProps {
  /**
   * **Stop rendering.** `true` ⇒ the render loop keeps being scheduled and draws
   * nothing.
   *
   * 🔴 It exists because this component's tab can be HIDDEN rather than
   * unmounted (`Tabs.tsx`), and neither `display: none` nor a zero-sized
   * container stops a `requestAnimationFrame` loop — `resize()` even falls back
   * to 640x480 when the container measures nothing, so a hidden viewport would
   * render a full scene at full rate indefinitely.
   *
   * ⚠ It is a DRAWING switch and nothing else, the same scope rule
   * {@link ViewportProps.layers} follows: nothing about the plan, the program,
   * the simulation or the report is affected by it, and pausing cannot change
   * what the machine would do. What it does stop is the publication of the
   * screen-coordinate probe attributes, which are meaningless while the canvas
   * is off screen — see the loop.
   *
   * Absent ⇒ running, so a caller that does not know about tabs is unaffected.
   */
  paused?: boolean;
  stock: [number, number, number];
  /**
   * **Where the job declares work zero** — `core/src/types.rs`'s `ZDatum`, by
   * the two names it gives itself (`ZDatum::label`).
   *
   * 🔴 IT IS THE ONE THING THAT MOVES THE TRIAD, and it was NOT passed here
   * until 2026-08-11. `App` has held the founder's ruling (*"0Z should be on the
   * bottom of the workpiece, top of the spoilboard"*) as `zZeroTop` since the
   * day it landed and never handed it to this component, so the arrows were
   * drawn at plan zero **whatever was declared** — one workpiece thickness wrong
   * on exactly the jobs the ruling exists for. See {@link axesRootZMm}.
   *
   * 🔴 **REQUIRED, and a string rather than the `boolean` `App` stores it in.**
   * Two reasons, both measured failures elsewhere in this tree:
   *
   *   · A default here would let a caller that never wired it render a viewport
   *     that ignores a safety declaration — the same rule {@link
   *     ViewportProps.layers} and {@link ViewportProps.projection} state, and
   *     for the harder case: a missing `layers` throws, a missing datum draws a
   *     confident wrong picture.
   *   · A `boolean` puts the two datums on opposite sides of truthiness, where
   *     `undefined`, `''` and `0` all read as *"bottom datum"*. The two states
   *     here are named, so a value that is neither is a compile error and never
   *     a silent pick.
   *
   * ⚠ It is a DECLARATION, not a measurement. It says where the operator will
   * zero the machine; it cannot say they did. The caption says so in those
   * words rather than this component asserting a datum was established.
   */
  zDatum: ZDatumName;
  clamps: ClampCfg[];
  moves: RenderMove[];
  /**
   * **The travel envelope** — how far the cutter can REACH, from the machine
   * datum at `0,0`.
   *
   * 🔴 IT IS A LIMIT AND IT IS NOT A SURFACE. Until 2026-08-10 this component
   * drew exactly these two numbers as `PlaneGeometry(tx, ty)`, lit, receiving
   * shadows, named `bed` and labelled *"table / bed"* — the machine's REACH
   * rendered as the OBJECT THE WORK LIES ON. Two physical things wore one name
   * and the name belonged to neither. It is now drawn as a boundary; the thing
   * made of material is {@link ViewportProps.spoilboard}.
   */
  travel: [number, number];
  /**
   * The machine's **Z** reach, mm — `Report.travel[2]`.
   *
   * ⚠ OPTIONAL, and absent is *"nobody told this viewport"*, never *"zero"*.
   * `App` flattens `Report.travel` to its first two numbers for {@link
   * ViewportProps.travel} (the scene needs an XY rectangle), so the Z limit is
   * a CALLER-WIRING fact rather than a missing export — the hover panel says so
   * in those words instead of printing a number it does not have.
   */
  travelZMm?: number | null;
  /**
   * **The sacrificial sheet, and where it is bolted** — `Report.spoilboard`,
   * passed through verbatim.
   *
   * 🔴 `null` MEANS NOBODY DECLARED ONE, and this component draws NOTHING for
   * it. It must never fall back to a board the size of {@link
   * ViewportProps.travel}: an absent spoilboard is not a spoilboard covering
   * everything, and that assumption is what made a through-cut and a cutter in
   * an extrusion look identical.
   */
  spoilboard?: {
    name?: string | null;
    x_mm?: number | null;
    y_mm?: number | null;
    size_x_mm?: number | null;
    size_y_mm?: number | null;
    /**
     * **How thick the slab is, exactly as the core echoed it** — and `null` or
     * absent means **UNKNOWN**, never *"thick enough"*.
     *
     * 🔴 THIS IS WHAT DECIDES WHETHER A BOARD IS DRAWN AS A SLAB. The core's
     * own wiring note on the echo (`core/src/fixtures.rs`, the `Report`
     * builder) states the contract this end has to keep: *"if this echoed a
     * plausible depth the picture would assert a measurement nobody made …
     * absent here is the instruction to draw it as UNKNOWN"*. So an absent
     * thickness keeps the flat plane this scene has always drawn — no bottom
     * face, no side walls — plus a marker, and never a slab of guessed depth.
     * See {@link boardSlab}.
     */
    thickness_mm?: number | null;
  } | null;
  /**
   * **The depth limb's answer, as the report carries it** — `Report.sim`, whose
   * three relevant fields are `board_depth`, `through_board` and
   * `board_depth_pending_reason`.
   *
   * 🔴 **COLOUR THE VERDICT, NEVER THE COUNT.** `through_board: 0` beside
   * `board_depth: "board-depth-unknown"` is **PENDING** — the value a limb that
   * compared nothing reports — and it is the same three glyphs as a limb that
   * compared everything and found nothing. The core says this in terms on the
   * field itself; this component reads {@link readBoardDepth} and paints the
   * board from the WORD.
   *
   * ⚠ Absent (or a verdict this file does not recognise) is **PENDING**, not
   * clear. A missing honesty field must render as the honest answer.
   */
  boardDepth?: {
    board_depth?: string | null;
    through_board?: number | null;
    board_depth_pending_reason?: string | null;
  } | null;
  /**
   * The four edge strips of REACH the declared board does not cover, in mm:
   * `[X-, X+, Y-, Y+]` — `Report.spoilboard_bare_reach`, **the core's own
   * subtraction**.
   *
   * 🔴 `null` (no board) and `[0,0,0,0]` (the board covers the whole reach) are
   * different facts and are drawn differently: nothing at all, versus no shaded
   * strip because there is none. This component does not subtract two
   * rectangles to find out which — the last time this app re-derived a
   * placement rule in TypeScript the copy was orientation-blind.
   */
  spoilboardBareReach?: [number, number, number, number] | null;
  /**
   * Was the board's CORNER fitted by the app, or typed by a person?
   *
   * 🔴 A drawn rectangle is a claim about where a physical object is, and this
   * viewport cannot tell an assumed corner from a measured one by looking at
   * it. `true` = this app placed it (founder, 2026-08-10: *"fit the spoil board
   * on the table when I select one"*), which is a genuinely weaker fact than a
   * corner somebody put a tape against — and the picture is the surface where
   * that difference disappears fastest.
   */
  spoilboardPositionAssumed?: boolean;
  /** 0..1 — how much of the program to draw. Drives the playback scrubber. */
  progress: number;
  /**
   * `App`'s older single rapids checkbox. OPTIONAL and defaulted to `true`,
   * because the per-layer toggles below supersede it: a caller that has dropped
   * the checkbox must not have to pass a boolean it no longer owns. While both
   * exist, a class hidden by EITHER is hidden, and the indicator counts it.
   */
  showRapids?: boolean;
  /**
   * Which view layers are shown — **`App`'s state, not this component's**.
   *
   * 🔴 IT WAS A `useState` IN HERE, and it moved out on 2026-08-11 when the
   * founder put the eyes on the sidebar sections. Lifting it is what makes that
   * safe rather than duplicative: the panel eye and anything left on the canvas
   * read and write ONE boolean, so two controls for one layer cannot disagree —
   * there is no second copy to fall out of step.
   *
   * ⚠ What did NOT change: this is still DRAWING ONLY. It reaches the scene and
   * nothing else — not the plan, the G-code, the export, the summary or the
   * simulation. `App` holds it beside the panels and never sends it to the
   * core. Hiding a class changes the picture and never the program, and the
   * indicator on the canvas exists so nobody reads the picture as the program.
   *
   * 🔴 REQUIRED, AND DELIBERATELY NOT OPTIONAL-WITH-A-FALLBACK. While this lift
   * was half-applied a dev server rendered `Viewport` with the prop missing and
   * the spread below threw `Cannot read properties of undefined (reading
   * 'rapid')`, unmounting the canvas. The tempting repair — `props.layers ??
   * LAYER_DEFAULTS` — is the WORSE outcome: it would draw every layer visible
   * while the sidebar controls reached nothing, which is a picture that looks
   * like it is working. A required prop makes the same mistake a RED BUILD
   * (`tsc` names the missing property at the call site) instead of a silent
   * wrong picture, and this component has exactly one caller.
   */
  layers: Record<Layer, boolean>;
  /* 🔴 `onSetAllLayers` IS GONE, 2026-08-11. It drove the `all` / `none` pair
   * this component used to keep in the overlay column; the founder moved that
   * control to the top of the SIDEBAR as a single tri-state eye (*"move the
   * view layers all none above the Machine … (just an eye)"*), so the viewport
   * no longer writes the layer record at all. It READS `layers` to draw and to
   * count what is hidden, and that is the whole of its involvement — which is
   * the cleaner seam anyway: the picture reports, the panels decide. */
  /**
   * The app's theme toggle. It is a CHANGE SIGNAL, not a palette: every colour
   * in the scene is resolved from the brand tokens on `documentElement`, and
   * those are the truth about which theme is live. The boolean can be a commit
   * ahead of the DOM, because `App` writes `data-theme` in an effect and a
   * child's effects run before its parent's.
   */
  dark: boolean;
  /**
   * Perspective or orthographic. **Required, for the same reason `layers` is** —
   * a default here would let a caller that never wired the control render a
   * viewport that ignores it, which is a control that looks live and reaches
   * nothing.
   *
   * 🔴 THIS TAB DEFAULTS TO **ORTHOGRAPHIC** AND THE CAD TAB DOES NOT. The
   * default lives at the call site (`App.tsx`, from `CNC_DEFAULT_PROJECTION`);
   * the reason lives in `projection.ts` and is about dimensional reading, not
   * taste — perspective converges parallel edges, so a part that fits can be made
   * to look like it overhangs and a clamp the cutter will strike can be made to
   * look clear.
   *
   * ⚠ IT IS DRAWING ONLY, exactly like `layers`. It is not in `plan()`'s inputs,
   * not exported, not in the program. Changing it changes the picture and never
   * the G-code.
   */
  projection: Projection;
  /** Drag a clamp on the bed. `null` disables dragging entirely. */
  onClampMove?: ((index: number, x: number, y: number) => void) | null;
  /** Where the sheet's datum sits on the bed, mm. */
  stockOrigin?: [number, number];
  /** How the sheet is laid, degrees anticlockwise about its datum corner. */
  stockRotationDeg?: number;
  /** Drag the sheet on the bed. `null` disables it. */
  onStockMove?: ((x: number, y: number) => void) | null;
  /* 🔴 `onStockRotate` AND THE SPHERE KNOB IT DROVE ARE GONE — founder,
   * 2026-08-10: *"remove the large ball to rotate the workpeace"*.
   *
   * Removed in FOUR places, not one, because a knob that is invisible and still
   * hit-tested would silently eat every drag aimed at the sheet underneath it —
   * the same class of defect as the pointer shield that made the snap chips
   * dead: the mesh, its material entry in the theme pass, the `data-rotate-handle`
   * publication, and the `draggingRotate` branch that claimed pointer priority
   * ahead of every other drag.
   *
   * ✅ **The CAPABILITY stays**, which is what makes the deletion safe rather
   * than a regression wearing a UI-cleanup costume: `App.tsx`'s `stock-rotation`
   * select (0/90/180/270) and the `rotate-ccw` / `rotate-cw` buttons write the
   * same `rotation` state the handle wrote, unconditionally and on every render.
   * Verified before deleting, not after. */
  /**
   * 🔴 **The transform the DRAWING-FRAME objects must be drawn under** —
   * `Report.drawing_placement`, measured by the core out of the one function
   * that places the program.
   *
   * `drawing` and `loadedMesh` are in the imported geometry's own millimetres;
   * `path` is in machine coordinates. Before 2026-08-09 this component drew both
   * raw, so the extruded walls and the loaded solid stood at the machine origin
   * while the sheet was drawn at its datum — any datum or rotation put the
   * object beside the board, which is what the founder reported.
   *
   * Absent means the IDENTITY (see `NO_PLACEMENT`), never a zero matrix.
   */
  drawingPlacement?: Placement2D | null;
  /**
   * **Every drawing on the sheet, by the id the PROGRAM names its parts with**,
   * and where each one currently sits.
   *
   * 🔴 THE ID IS THE CORE'S INSTANCE ID AND NOT AN INDEX INTO ANYTHING. The core
   * names every part `<instance>/<part>` (`ImportSource::id`, minted by `App` as
   * `Hive super end`, `… #2`, …), and `Report.drawing` carries those names. This
   * viewport groups the drawn geometry by that id and hands the SAME id back on
   * a drag, so the object under the pointer and the placement that moves are the
   * same part by construction. A parallel index — "the third mesh is the third
   * row" — is the one way this goes wrong silently: it agrees for as long as the
   * two orders happen to match, and moves the wrong part the day they do not.
   *
   * ⚠ Pass a MEMOISED array. It is in the scene effect's dependency list, so a
   * fresh literal per render rebuilds the scene on every render — the identity
   * churn the two scalars this prop replaced were split up to avoid.
   *
   * Absent or empty means nothing is placed, which is the honest state of a
   * reference fixture: it has no drawing behind it and nothing to drag.
   */
  partInstances?: PartInstance[];
  /**
   * Which instance the PANEL is about — `App`'s selection. It decides only what
   * the single-part probes (`data-part-probe` / `data-part-bbox`) report, so a
   * page with one drawing publishes exactly what it always did. It does NOT
   * decide what a drag moves: that is whatever the pointer actually hit.
   */
  selectedInstance?: string | null;
  /**
   * Drag ONE named drawing across the sheet. `null` disables it entirely.
   *
   * 🔴 It hands back the INSTANCE ID and a position in SHEET millimetres,
   * already converted out of the bed frame through the inverse of
   * `drawingPlacement`'s rotation. The result is UNCLAMPED: a drag that puts the
   * part off the sheet, past the travel limits or into a clamp is refused by the
   * core on the re-plan, and that refusal is the answer. Nothing here snaps a
   * part out of the way — `fit` reports a datum shift and will not apply one,
   * and `layout` grades a placement rather than choosing it, for the same
   * reason: THE CLAMPS DO NOT TRAVEL WITH THE PARTS.
   *
   * 🔴 It replaced a two-scalar `onPartMove(x, y)` that could only ever describe
   * ONE part. With several drawings on the sheet that call had to be resolved
   * against a selection somewhere else, and the resolution was the defect: every
   * grab moved the SELECTED drawing, whichever one the operator had hold of.
   */
  onPartMoveAt?: ((instance: string, x: number, y: number) => void) | null;
  /**
   * The sheet's material name, for the hover panel. OPTIONAL: rather than name
   * a material the viewport cannot know, the row is simply absent until a
   * caller passes one. An absent row and a wrong row are not the same mistake.
   *
   * ⚠ This doc read *"OPTIONAL and unwired today: `App` holds it (`material`)
   * and this component does not"* until 2026-08-09. **Stale.** `App.tsx:2300`
   * passes `stockMaterial={material}`, and the sheet's hover panel was measured
   * rendering `Material — Plywood` on the running app. Exactly the same stale
   * comment about a live wire that the `tool` prop below records — and it is the
   * second one in this interface, which makes it a pattern rather than a slip:
   * a prop doc is a claim about the CALLER, and nothing in this file goes red
   * when the caller changes.
   */
  stockMaterial?: string;
  /**
   * The selected tool. Every field shown from this comes from the CORE's tool
   * library row — including `fit` / `fit_why`, which is the machine's verdict
   * and not a rule this file re-derives. The collet check was got wrong once by
   * being computed in the UI; it is not going to be computed here.
   *
   * 🔴 IT IS NO LONGER JUST A HOVER ROW — it is the MARKER'S GEOMETRY (TODO
   * #44), so the three states stay apart the way they do everywhere else here:
   *   `undefined` — this caller has not wired it, so the viewport does not KNOW
   *   `null`      — no tool is selected
   *   `{...}`     — this row, drawn to its own numbers
   * All three that cannot be drawn refuse in the same SHAPE and say different
   * sentences. ⚠ This doc read *"OPTIONAL and unwired today"* while `App.tsx`
   * had been passing `tool={selectedTool}` all along — a stale comment about a
   * live wire, which is one way a field ends up ignored by the code that holds
   * it.
   */
  tool?: ToolRow | null;
  /**
   * The SIMULATION's cell size, mm — the resolution `Report.sim`'s gouge / uncut
   * / spoilboard COUNTS were computed at.
   *
   * 🔴 It is NOT the resolution of the drawn surface and must never be used to
   * label it. `stockSurface.cell_mm` is a DISPLAY cell chosen by the caller (a
   * 600×900 sheet at the simulation's own 0.6mm is 8.0MB of base64 per plan),
   * and the two numbers are routinely different. The cell size rides inside
   * `StockSurface` precisely so no consumer has to reach for a second one — so
   * nothing in this file reads this prop today, and the label it once carried
   * has moved to where the data is.
   */
  simCellMm?: number;
  /**
   * What the user loaded, for the `loaded object` control. OPTIONAL, and the
   * three states are deliberately distinguishable:
   *   `undefined` — the caller has not wired this, so the viewport does not KNOW
   *   `null`      — nothing is loaded
   *   `{...}`     — this drawing is loaded, in this format
   * "I was not told" and "there is nothing" are different facts and the control
   * says which one it is in.
   */
  loaded?: { name: string; format: string } | null;
  /**
   * The imported mesh AS LOADED, when the caller asked for it. `Report`'s own
   * field is `loaded_mesh`, and it is `null` unless requested with a triangle
   * budget — asking is expensive (a 47k-triangle STL is 2.17 MB per call), so
   * declining is the default and this prop stays absent until a caller opts in.
   *
   * 🔴 This is the INPUT. It is not the result, not the part, and not what the
   * machine will leave — the section plane drawn against it is the ONE outline
   * the machine actually follows through this solid, which is the entire reason
   * the plane is drawn rather than the solid alone.
   */
  loadedMesh?: LoadedMesh | null;
  /**
   * The machine's touch plate, for the `touch plate` layer. OPTIONAL: `Machine`
   * has all of this (`probe_enabled`, `probe_x`, `probe_y`, `touch_plate_mm`)
   * but the viewport is not handed the machine, so until a caller passes it the
   * control is disabled and says it has not been told — rather than drawing a
   * plate on an assumption.
   *
   * 🔴 `x: 0, y: 0` is NOT "missing". The core's own definition is *"`0,0` =
   * probe where the tool already is"*, so at 0,0 there is no fixed plate
   * position at all and a solid block at the world origin would be a
   * measurement nobody took. That case is drawn as an outline and says so.
   */
  touchPlate?: { enabled: boolean; x: number; y: number; thickness_mm: number } | null;
  /**
   * The stock AFTER machining, as the core's height map — `Report.simulated_stock_surface`.
   * OPTIONAL, and the three states are distinguishable for the same reason
   * `loaded` is:
   *   `undefined` — this viewport was not wired to receive it
   *   `null`      — the plan did not produce one (not requested, or refused)
   *   `{...}`     — a real map, at the cell size inside it
   *
   * 🔴 It is the OUTPUT and it is NOT THE PART. A height map records REMOVED
   * material; on a through cut it cannot say which side of the line you keep.
   * Every label drawn from it says *simulated stock surface* and carries
   * `cell_mm`, because a feature narrower than one cell is not blurred — it is
   * ABSENT.
   */
  stockSurface?: StockSurface | null;
  /**
   * The minimum clear material two CUT boundaries must have between them, and
   * where the number came from. OPTIONAL and **unwired today** — see
   * `gapStatus()` for the measured reason.
   *
   * 🔴 THIS IS THE CORE'S NUMBER OR IT IS NOTHING. `core/src/layout.rs`'s
   * `Clearance` is the only place the rule lives: `Clearance::from_tool(&tool,
   * margin)` then `required_mm()`. This viewport does not add a diameter to a
   * margin, does not pick a margin, and does not decide what counts as too
   * close — it draws an affordance at a number it was handed, and the verdict
   * stays with `Layout::check()`, which measures the real boundaries with arcs
   * and tells OVERLAP apart from TOO-CLOSE because the two have different
   * fixes.
   */
  clearance?: { required_mm: number; cutter_diameter_mm: number; margin_mm: number } | null;
  /**
   * The imported drawing **as the drawing had it** — `Report.drawing`. OPTIONAL,
   * and the three states are distinguishable for the same reason `loaded` and
   * `stockSurface` are:
   *   `undefined` — this viewport was not wired to receive it
   *   `[]`        — the core exported no contours for this report
   *   `[…]`       — real parts, outer boundary plus every hole
   *
   * 🔴 `[]` is NOT "the drawing is empty". `cam.ts` is explicit: it is empty for
   * every reference fixture (built from code, no drawing behind it) and for an
   * import refused before a part existed. An import that produced nothing
   * cuttable comes back `ok: false` with the reason in `errors` — a different
   * fact, and the control says which one it is rather than looking broken.
   *
   * 🔴 It is the geometry the program was planned FROM, not an un-offset of
   * `render`. Arcs are CARRIED, as `bulge = tan(theta / 4)` to the next vertex —
   * see {@link tessellateContour}, which is the only place in this file allowed
   * to turn one into line work.
   */
  drawing?: DrawingPart[];
  /**
   * How deep the program actually cuts, **mm below the stock top, positive** —
   * the height the extruded walls are drawn to. OPTIONAL and **unwired today**;
   * `App` holds the report and this viewport does not.
   *
   * 🔴 THE HEIGHT IS THE OPERATION'S DEPTH, NOT BLINDLY THE SHEET THICKNESS. A
   * through cut really does produce a prism of the contour, so on a through job
   * the thickness is the right number and nothing is lost. A **6mm pocket in an
   * 18mm sheet extruded to 18mm draws a hole straight through a board that will
   * still have 12mm of material under it** — a picture asserting a machining
   * outcome nobody planned.
   *
   * So the three states are kept apart and the ASSUMPTION is stated on screen,
   * exactly as the importer states an assumed `$INSUNITS`:
   *   `undefined` — not told. Drawn at the sheet thickness, labelled ASSUMED.
   *   `null`      — this plan produced no depth. Same drawing, different reason.
   *   `> 0`       — drawn at that depth, labelled as measured.
   *
   * The value is NOT clamped to the sheet. A program that cuts 0.5mm past the
   * underside is a real and common thing, and a wall poking through the board is
   * the honest picture of it.
   */
  cutDepthMm?: number | null;

  /**
   * Other workpieces on the table (not the active one). Drawn as ghost
   * outlines so the operator can see where they sit. Each entry is
   * `[stockX, stockY, originX, originY, rotation]`.
   */
  otherWorkpieces?: Array<{
    stockX: number; stockY: number;
    originX: number; originY: number;
    rotation: number;
  }>;

  /** Called on right-click in the 3D canvas. `null` if nothing was hit. */
  onContextMenu?: (info: {
    x: number; y: number;
    object: 'stock' | 'ghost-workpiece' | 'clamp' | 'tool' | 'drawing' | 'background';
    workpieceIndex?: number;
    clampName?: string;
  }) => void;
}

/**
 * Every layer the viewport can switch off, in legend order — the six move
 * classes the core renders, plus the workpiece itself.
 *
 * The list is FIXED rather than derived from the current program: "this program
 * has no drilling" and "drilling is switched off" are different facts, and a
 * control list that quietly shrinks makes the second look like the first.
 */
export type Layer =
  | RenderKind
  | 'workpiece'
  | 'tool'
  | 'touch'
  | 'loaded'
  | 'result'
  | 'walls'
  | 'clamps'
  /* 🔴 RENAMED FROM `bed` 2026-08-10. The layer draws the machine's REACH and
   * was labelled "table / bed" — a name that means a SURFACE, attached to a
   * LIMIT. The founder's ruling the same day retires "table" and "bed" as names
   * in this tool; `spoilboard` below is the thing made of material. */
  | 'travel'
  | 'spoilboard';

// `touch` leads the machining classes (founder, 2026-08-08), behind only the
// loaded object — the two solids a person looks for before they read a path.
//
// `result` sits SECOND, directly behind `loaded`, because the two are the same
// job seen from opposite ends — what the user brought in, and what the machine
// would leave. Anything between them would invite reading one as the other.
//
// ⚠ `walls` sits THIRD and deliberately NOT between `loaded` and `result`, even
// though it is the middle claim of the three solids. The reason above is a
// stronger constraint than tidiness: those two are the same job from opposite
// ends, and anything wedged between them invites reading one as the other. So
// the drawing's own shape follows both rather than splitting the pair.
export const LAYERS: Layer[] = [
  'loaded',
  'result',
  'walls',
  'touch',
  // 🔴 THE CUTTER ITSELF — founder, 2026-08-10: *"on the top section able to
  // show/hide the Tooling as well"*. It sat immediately in front of the moves
  // because that is what it marks: the head of the drawn program, at the tip.
  // It was the ONE drawn object in this scene with no toggle.
  //
  // 🔴 OFFERED ONLY WHEN A CUTTER IS ACTUALLY DRAWN — `presentKinds`' rule, the
  // one `clamps` uses, and NOT `walls`' present-and-disabled one.
  // `toolMarkerShape` REFUSES to draw when the tool row states no diameter, so
  // "no marker" is a real state a job can be in; a greyed chip for it would say
  // the cutter is switched off when the truth is that nothing knows how wide it
  // is.
  'tool',
  'cut',
  'tab',
  'drill',
  'rapid',
  'change',
  'probe',
  'workpiece',
  // Second to last, beside the bed and for the same reason: work holding is a
  // thing you switch OFF to look under, not a thing you look at. A clamp sits
  // on top of the board and is the only object in this scene that can hide the
  // work it is holding. Founder, 2026-08-09 (TODO #53).
  //
  // 🔴 It is OFFERED ONLY WHEN CLAMPS ARE DECLARED — `presentKinds`' rule, not
  // `walls`' present-and-disabled one, and the choice is safety-bearing rather
  // than tidiness. `Fixturing` refuses to conflate "nothing declared" with "a
  // human confirmed the bed is clear"; a greyed-out clamp chip on a job with no
  // clamps would put that same conflation on the canvas, because a disabled
  // control reads as "off" and "off" reads as "there are none".
  'clamps',
  // The board sits under the work and over the rails, and it is drawn in that
  // order: after the clamps, before the reach outline.
  //
  // 🔴 OFFERED ONLY WHEN A BOARD IS DECLARED — `presentKinds`' rule, the one
  // `clamps` uses, and for the identical safety reason. A greyed chip for an
  // undeclared board would read as "there is one, it is switched off", and
  // "nothing declared" versus "declared and checked" is the whole distinction
  // this layer exists to draw.
  'spoilboard',
  // Last, because it is the thing you switch off to look UNDER everything else
  // rather than a thing you look at. Founder, 2026-08-08.
  'travel',
];

// ⚠ `touch plate` and `probe move` are TWO DIFFERENT THINGS and the labels have
// to keep them apart: one is a lump of metal sitting on the bed, the other is
// the move that goes down and touches it. "probe" alone would have been read as
// both — and the plate is the one that can be hit by a cutter.
export const LAYER_LABEL: Record<Layer, string> = {
  loaded: 'loaded object',
  // Never "result", never "the part" — see `RESULT_LABEL`.
  result: 'simulated stock after machining',
  // Never "the part", never "the shape" — see `WALLS_LABEL`. It is what the
  // DRAWING asks for, which is a third claim and not either of the two above.
  walls: 'extruded walls',
  touch: 'touch plate',
  // Never "tool" alone: this app already calls a row in the library a "tool",
  // and this layer is the PICTURE of the one at the head of the program. A chip
  // labelled "tool" beside a Tooling panel reads as the panel's on/off switch.
  tool: 'cutter at the head',
  cut: 'cut',
  tab: 'tab',
  drill: 'drill',
  rapid: 'rapid',
  change: 'tool change',
  probe: 'probe move',
  workpiece: 'workpiece',
  // Both words, for the same reason `bed` carries both: "work holding" is what
  // the core, the report and gate P7 call it, "clamps" is what is on the bed.
  // Never just "clamps" — the layer hides every DECLARED obstruction, and a
  // vice or a dog would be hidden by a control that named only clamps.
  clamps: 'work holding / clamps',
  /* 🔴 NOT "table", NOT "bed" — founder, 2026-08-10, and the rename is the
   * whole point of this layer. Both words name a SURFACE, and this rectangle is
   * the machine's REACH: nothing sits on it and nothing is cut into it. The
   * label says "reach" so nobody reads the outline as the thing under the work.
   */
  travel: 'travel envelope (reach)',
  /* The one rectangle in this scene that is made of anything. "sacrificial" is
   * in the label because that is what makes a through-cut into it correct. */
  spoilboard: 'spoilboard (sacrificial material)',
};

/**
 * The six MOVE CLASSES, as layers. Module scope because `liveLayersOf()` below
 * is the one place the "not in this program, so not offered" rule is written
 * and it is called from two surfaces.
 */
const MOVE_LAYERS: Layer[] = ['cut', 'tab', 'drill', 'rapid', 'change', 'probe'];

/**
 * Which SIDEBAR PANEL owns each layer — founder, 2026-08-11: *"put it into the
 * left sidebar (Machine — hide/show; Spoilboard hide/show; Workpiece … etc)
 * like a small eye icon"*.
 *
 * The key is the panel's `testid` (`panel-machine`, …) rather than its title,
 * because the title is prose that a copy change may reword and the testid is
 * what the panel is identified by everywhere else.
 *
 * 🔴 `walls` GOES UNDER **Drawing**, not under Workpiece, and this is the one
 * row that departs from the proposal in TODO #81. Read at the code rather than
 * taken from the table: the layer is live iff `props.drawing` has contours
 * (`wallsLive`), it is labelled *"what the DRAWING asks for"*, and its
 * unavailability sentence is `wallsReason(props.drawing)`. It is a picture of
 * the IMPORTED GEOMETRY — the same object `loaded` draws, extruded — while the
 * Workpiece panel owns the stock: material, size, datum. The extrusion HEIGHT
 * comes from the sheet, but a rendering parameter is not ownership, and putting
 * the drawing's own shape under the panel that sets the sheet's thickness is
 * exactly the confusion `WALLS_LABEL` exists to prevent.
 *
 * ⚠ `touch` (the plate) is under **Machine** because that is where it is
 * declared — `probe-enabled` and `touch-plate-mm` are both in `panel-machine`.
 * `probe` (the MOVE) is under Operation with the other move classes: they are
 * two different things, which is why `LAYER_LABEL` spells both out.
 */
export const LAYER_SECTION: Record<Layer, string> = {
  travel: 'panel-machine',
  touch: 'panel-machine',
  spoilboard: 'panel-spoilboard',
  workpiece: 'panel-stock',
  loaded: 'panel-import',
  walls: 'panel-import',
  clamps: 'panel-clamps',
  tool: 'panel-tools',
  cut: 'panel-op',
  tab: 'panel-op',
  drill: 'panel-op',
  rapid: 'panel-op',
  change: 'panel-op',
  probe: 'panel-op',
  result: 'panel-verify',
};

/**
 * Which layers start VISIBLE. Lifted out of the viewport's own `useState` when
 * the controls moved to the sidebar — the state is `App`'s now, and the reasons
 * for each default came with it rather than being restated there.
 */
export const LAYER_DEFAULTS: Record<Layer, boolean> = {
  loaded: true,
  result: true,
  walls: true,
  // The reach outline starts VISIBLE: it is the frame everything else is
  // positioned in, and a machine with no limits drawn reads as a bug.
  travel: true,
  // And the board starts visible for the reason the clamps do: it is the thing
  // you switch OFF to look under, never the thing you switch ON to discover the
  // sheet is hanging off it.
  spoilboard: true,
  touch: true,
  // The cutter starts VISIBLE: it is where the program currently is, and the
  // scrubber is read against it.
  tool: true,
  cut: true,
  tab: true,
  drill: true,
  rapid: true,
  change: true,
  probe: true,
  workpiece: true,
  // Work holding starts VISIBLE for the same reason the reach does, only
  // harder: a clamp is the thing a cutter hits. The operator switches it off to
  // look under it and switches it back; nobody should have to switch it ON to
  // discover the bed is not clear.
  clamps: true,
};

/**
 * The touch plate's FOOTPRINT is not declared anywhere. `Machine` carries
 * `touch_plate_mm` (its thickness), `probe_x` / `probe_y` (where it is) and
 * `probe_enabled` — and nothing about how big it is in X and Y. This number is
 * therefore a PLACEHOLDER so the block can be seen, it is stated as one on the
 * object itself, and it must never be read back as a dimension. A comment
 * describing what someone drew has been promoted to a requirement here before.
 */
const PLATE_PLACEHOLDER_XY = 50;

/* 🔴 `touchReason()` IS GONE, 2026-08-11, AND IT WAS ALREADY UNREACHABLE BEFORE
 * THIS PASS — recorded rather than quietly deleted, because "removed dead code"
 * and "removed a reason a user was seeing" look identical in a diff.
 *
 * It had exactly one caller: the `k === 'touch' && !touchLive` arm of the chip
 * title. That arm sat INSIDE `liveLayers.map()`, and `liveLayers` filters
 * `touch` out when `!touchLive` — so the branch could never be taken and the
 * sentence had never once been on screen. The same is true of the `loaded` and
 * `result` arms beside it; those two functions survive because the CANVAS lines
 * (`loaded-unavailable`, `result-unavailable`) really do call them.
 *
 * What explains an absent touch-plate eye now is the Machine panel itself:
 * `probe-enabled`, `touch-plate-mm` and the `touchplate-undeclared` warning are
 * all in `panel-machine`, which is the section whose header the eye would have
 * been on. */

/**
 * 🔴 THE LAYER WHOSE REASON WENT STALE, and what it says now.
 *
 * This block used to read *"there is nothing to draw it from — `Report.sim`
 * carries the COUNTS, not the heights"*. **That was true when it was written
 * and is false now.** The height map landed in `18adbcbf2`:
 * `Report.simulated_stock_surface` is a real `StockSurface { cols, rows,
 * cell_mm, origin_x_mm, origin_y_mm, z_mm_b64 }` and `decodeStockSurface()`
 * hands back a `Float32Array` indexed `[row * cols + col]` — `0` is uncut stock
 * top, negative is material removed to that depth.
 *
 * A stale RED lies exactly like a stale green: the founder read that sentence
 * off the screen and asked about a blocker that had already been cleared, which
 * is the cost of a reason nobody re-checked against the code.
 *
 * The two things that had to travel with the drawing, now that it is drawn:
 *  1. It is a MODEL AT A RESOLUTION, so every label carries `cell_mm` — which
 *     is why the number lives INSIDE the struct rather than being asked for
 *     separately. A gouge narrower than one cell is not blurred, it is ABSENT.
 *  2. A height map records REMOVED MATERIAL. On a through cut it cannot say
 *     which side of the line you keep. So this is the simulated STOCK AFTER
 *     MACHINING — never "the result", never "your part", never "what you get".
 *     The founder's phrase ("the final product") is the one thing here not to
 *     take literally into the UI.
 */
const RESULT_LABEL = 'simulated stock after machining';

/**
 * What a display cell does to a feature — TODO #46.
 *
 * 🔴 THE NOTE USED TO STATE ONE HALF OF THIS AND READ AS IF IT COVERED BOTH.
 * *"A feature narrower than one cell is absent from it, not blurred"* is true,
 * and it says nothing about the features that ARE drawn — which come out
 * OVERSIZE, with corners on the cell grid. Measured 2026-08-09 on `plate.dxf`
 * (Ø6mm holes, 18mm stock), reading the decoded map: **9.0mm at the 3mm display
 * cell**, 7.2mm at 1.2mm, 6.0mm at 0.6mm. The founder asked why a drilled hole
 * has square corners; the answer was on the screen and the warning was not.
 *
 * Neither the squareness nor the oversize is a bug. `core/src/fixtures.rs::
 * stock_surface_of()` reduces each k×k block by its DEEPEST sample on purpose —
 * it over-reports removed material and never under-reports it, which is the
 * only safe direction for a picture of what is left. So this text explains the
 * artefact; it does not ask for the geometry to change.
 *
 * The through-cut half is the other question the founder asked — *"why can I
 * look through it?"*. The map's deepest value is exactly the stock thickness
 * (1,441 cells of 46,184 at −18.0, nothing below), so a through hole is a PIT
 * whose floor lies on the sheet's underside, seen through a workpiece drawn
 * translucent. A height map is single-valued: it can say "removed down to here"
 * and can never say "no material here".
 *
 * One function, three consumers — the chip title, the on-canvas line and the
 * hover note — because a caveat that is worded three times is a caveat that
 * ends up meaning three things.
 */
function resultCaveats(cellMm: number): string {
  return (
    `A feature narrower than one cell is ABSENT from it, not blurred; ` +
    `one that IS drawn comes out up to a cell OVERSIZE with corners on the ${cellMm}mm grid, not on the cutter — ` +
    `each cell takes its DEEPEST sample, which over-reports removal and never under-reports it ` +
    `(measured: a Ø6mm hole reads 9mm at 3mm cells, 6mm at 0.6mm). ` +
    `A through cut is a PIT whose floor sits on the underside, not an opening — a height map is single-valued.`
  );
}

/**
 * Why the `simulated stock` control is off, when it is off. Three different
 * facts, and none of them is the old "the core only sends counts".
 */
function resultReason(surface: ViewportProps['stockSurface']): string {
  if (surface === undefined) {
    return 'this viewport has not been handed `Report.simulated_stock_surface` yet — the core exports it and the caller has to pass it';
  }
  if (surface === null) {
    return 'this plan produced no surface — it is opt-in per call (a 600×900 workpiece at the simulation’s own 0.6mm cell is 8.0MB of base64), and a refused job has none at all';
  }
  return '';
}

/**
 * Vertices the surface mesh is allowed to build. A 600×900 sheet at the 3mm
 * display cell is 200×300 = 60k, comfortably inside this; the budget exists so
 * a finer cell degrades into a coarser PICTURE rather than into a stalled tab.
 *
 * 🔴 Going over it STRIDES the map, which SKIPS samples — the deepest point
 * inside a skipped cell is not drawn at all. That is the same class of thing as
 * a decimated mesh, so when it happens the drawn cell size is stated on screen
 * and the map's own `cell_mm` is never presented as what you are looking at.
 */
const SURFACE_VERTEX_BUDGET = 240_000;

/**
 * 🔴 THE OTHER SOLID THAT CANNOT BE DRAWN YET, and it is NOT the one above.
 * There are two, they arrive from opposite ends of the pipeline, and a viewer
 * must never have to guess which solid is theirs and which is ours:
 *
 *   LOADED OBJECT  — the mesh the user imported.       The INPUT.  (this one)
 *   SIMULATED STOCK— what the machine would leave.     The OUTPUT. (above)
 *
 * The names are chosen so neither can be read as the other, and this one sits
 * FIRST in the row (founder, 2026-08-08) because it is the thing the user
 * brought.
 *
 * Why it is disabled, measured rather than assumed: `core/src/mesh.rs` parses
 * an STL and immediately SECTIONS it at a Z — only the resulting 2D contours
 * travel onward, and the triangles are dropped inside the core. They never
 * reach the report, so the browser has no mesh. And a DXF or an SVG has no 3D
 * object AT ALL: that is not a missing feature, it is what a 2D drawing is, and
 * the control says so rather than looking broken.
 *
 * ⚠ THAT LAST SENTENCE NOW STOPS SHORT, and `loadedReason` finishes it. "No 3D
 * object" is still exactly true — but it was written when it also meant "so
 * there is nothing on the canvas for this file", and that second half is dead:
 * the drawing's contours are drawn as {@link WALLS_LABEL}. Two claims lived in
 * one sentence, one of them expired, and the surviving one kept its tone. That
 * is the same failure as a stale reason line, in a comment.
 */
const LOADED_LABEL = 'loaded object';

/**
 * 🔴 THE THIRD SOLID, AND THE SECOND REASON IN THIS FILE TO HAVE GONE STALE.
 *
 * This block used to carry a MEASURED refusal — *"the report carries NO
 * CONTOURS… the only 2D geometry that reaches the browser is `render`, the
 * cutter centre line"* — with a `2bee-slice report plate | jq 'keys'` dump to
 * prove it. **That was true when it was written and is false now.**
 * `Report.drawing` exists: a `DrawingPart[]` of outer boundary plus every hole,
 * in mm, **before any tool offset**, exported precisely so nothing has to
 * un-offset a toolpath in TypeScript. Measured at the artefact rather than
 * assumed from the ticket that said so:
 *
 *     $ 2bee-slice import gates/fixtures/plate.dxf --json | jq '.drawing[0]'
 *     parts: 1 · outer 4 verts · inners 4
 *     inner[0].verts = [ {x:223, y:80, bulge:-1}, {x:217, y:80, bulge:-1} ]
 *
 * That inner contour is one of the plate's four Ø6mm holes, and it is the whole
 * reason this file may not treat a vertex list as a polyline: **a full circle
 * arrives as TWO vertices, each a half turn.** Read as straight segments it is
 * a 6mm line, not a hole. See {@link tessellateContour}.
 *
 * ⚠ Note what the old text got RIGHT and keep it: `render` really is the cutter
 * centre line with the radius, lead-ins, tabs and reliefs baked in, and
 * un-offsetting it here would still be wrong. The layer was not unblocked by
 * relaxing that rule — it was unblocked by the core exporting the real thing.
 *
 * Three claims that must never be mistaken for each other on one canvas:
 *   loaded object  — what the user gave us            (mesh, the INPUT)
 *   extruded walls — what the DRAWING asks for        (contours, this one)
 *   simulated stock— what the machine would LEAVE     (heights, the OUTPUT)
 *
 * 🔴 THIS ONE IS A PICTURE OF THE DRAWING, NOT OF THE MACHINED RESULT. It has
 * square inside corners the cutter physically cannot make, and no dogbones — the
 * `simulated stock after machining` layer is the one that shows what the machine
 * would leave. So it is drawn as a REFERENCE SHAPE and never as material:
 * near-transparent ribbons with their top and bottom rings picked out as line
 * work, in a token nothing else in this scene uses, and it casts NO SHADOW —
 * material casts, annotation does not.
 */
const WALLS_LABEL = 'extruded walls';

/**
 * How far a drawn chord may sit from the arc it replaces, mm.
 *
 * 🔴 A tolerance that is not stated is a tolerance nobody can check, so this
 * number is on the screen next to the layer and not only here. At 0.05mm a Ø6mm
 * hole becomes 18 vertices, which reads as round; the flattened alternative is
 * 2 vertices, which is not a hole at all.
 *
 * It is a DISPLAY tolerance and nothing else reads it. No machining decision is
 * made from these vertices — the program is the core's, already emitted.
 */
const WALL_ARC_TOLERANCE_MM = 0.05;

/**
 * Segments one arc may be given. A near-zero-radius bulge (a drawing artefact,
 * or a degenerate export) asks for unbounded work; this stops the tab instead of
 * the browser stopping it. When it bites, the layer SAYS the arc is drawn
 * coarser than the tolerance claims, because otherwise the stated tolerance
 * would be a number the picture does not honour.
 */
const WALL_ARC_MAX_SEGMENTS = 720;

/**
 * Points the whole layer may tessellate to. A nest of many arced parts is the
 * case that runs away. Over budget, whole CONTOURS are dropped and counted —
 * never silently thinned, because a thinned arc is exactly the polygonal hole
 * this function exists to prevent.
 */
const WALL_VERTEX_BUDGET = 200_000;

/** What {@link tessellateContour} produced, and what it had to give up. */
export interface WallTessellation {
  /**
   * Flat `[x0, y0, x1, y1, …]` in mm, in drawing order. A closed contour does
   * NOT repeat its first point — the wrap is a fact about the contour, carried
   * in `closed`, and duplicating the point would make a zero-length segment
   * that the ribbon builder would turn into a degenerate triangle.
   */
  xy: number[];
  /** Segments that carried a bulge and were swept as arcs. */
  arcs: number;
  /** Points produced BY those sweeps — the ones a flattening would lose. */
  arcPoints: number;
  /** True when an arc hit {@link WALL_ARC_MAX_SEGMENTS} and is drawn coarser. */
  clamped: boolean;
}

/**
 * Turn one imported contour into line work at {@link WALL_ARC_TOLERANCE_MM}.
 *
 * 🔴 THE ONE THING THIS FUNCTION EXISTS TO STOP. `DrawingVertex.bulge` is
 * `tan(theta / 4)` of the arc **to the next vertex**; pushing the vertices
 * straight into a polyline treats every arc as its own chord, and the failure is
 * SILENT — every hole squares off, every fillet becomes a corner, and the result
 * still looks like a drawing. On the `plate` fixture it is worse than that: its
 * holes are two vertices each, so a flattened circle is a 6mm line segment.
 *
 * The arithmetic is `cam.ts`'s own, not re-derived here:
 *
 * ```ts
 * const theta  = 4 * Math.atan(a.bulge);            // signed sweep, radians
 * const chord  = Math.hypot(b.x - a.x, b.y - a.y);
 * const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
 * ```
 *
 * The centre is the midpoint pushed along the chord's left normal by
 * `cot(theta / 2) = (1 - t²) / 2t` half-chords — the standard bulge identity,
 * and it degenerates correctly at `|t| = 1` (a half turn, centre ON the
 * midpoint) which is exactly the full-circle case above.
 *
 * Segment count comes from the SAGITTA, not from a fixed count: a chord
 * subtending `d` deviates from its arc by `r · (1 - cos(d / 2))`, so
 * `d = 2 · acos(1 - tol / r)` is the coarsest step that still honours the
 * tolerance. A fixed count would draw a Ø3mm hole and a Ø300mm arc equally
 * badly, in opposite directions.
 *
 * Exported so it can be exercised on real contour data without standing up the
 * whole scene — the maths is the part of this layer that can be silently wrong.
 */
export function tessellateContour(
  c: DrawingContour,
  tolMm: number = WALL_ARC_TOLERANCE_MM
): WallTessellation {
  const verts = c.verts ?? [];
  const xy: number[] = [];
  let arcs = 0;
  let arcPoints = 0;
  let clamped = false;
  const n = verts.length;
  if (n < 2) {
    for (const v of verts) xy.push(v.x, v.y);
    return { xy, arcs, arcPoints, clamped };
  }

  // A closed contour has a segment from the last vertex back to the first; an
  // open one does not. Carried, never assumed — closing an open loop invents an
  // edge the drawing never had, and `cam.ts` says so on the field itself.
  const segments = c.closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    // Every segment contributes its own START point, so each vertex is pushed
    // exactly once and the wrap needs no special case.
    xy.push(a.x, a.y);

    const t = a.bulge;
    if (!t || !Number.isFinite(t)) continue;

    const theta = 4 * Math.atan(t);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    const half = Math.sin(theta / 2);
    // A zero-length chord with a bulge on it describes no arc anyone can draw.
    // Skipped as a straight join rather than guessed at — the alternative is a
    // NaN centre, which draws as nothing and reports as a wall.
    if (!(chord > 0) || Math.abs(half) < 1e-12) continue;

    const radius = Math.abs(chord / (2 * half));
    const k = (1 - t * t) / (2 * t);
    const cx = (a.x + b.x) / 2 - (k * dy) / 2;
    const cy = (a.y + b.y) / 2 + (k * dx) / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(radius > 0)) continue;

    // The sagitta rule. Below the tolerance the arc is already inside it at one
    // segment, and `acos` of a negative would fold the step over.
    const step = radius > tolMm ? 2 * Math.acos(1 - tolMm / radius) : Math.PI;
    let segs = Math.max(1, Math.ceil(Math.abs(theta) / step));
    if (segs > WALL_ARC_MAX_SEGMENTS) {
      segs = WALL_ARC_MAX_SEGMENTS;
      clamped = true;
    }
    const a0 = Math.atan2(a.y - cy, a.x - cx);
    // `s < segs`, not `<= segs`: the arc's END is the next segment's start and
    // is pushed by the next iteration (or by the open-contour tail below).
    // Emitting it here would double every joint.
    for (let s = 1; s < segs; s++) {
      const ang = a0 + (theta * s) / segs;
      xy.push(cx + radius * Math.cos(ang), cy + radius * Math.sin(ang));
      arcPoints++;
    }
    arcs++;
  }
  // An open contour's last vertex is nobody's segment start.
  if (!c.closed) xy.push(verts[n - 1].x, verts[n - 1].y);
  return { xy, arcs, arcPoints, clamped };
}

/** Why the `extruded walls` control is off, when it is off. Three facts, and
 *  none of them is the old "the report carries only the cutter centre line". */
function wallsReason(drawing: ViewportProps['drawing']): string {
  if (drawing === undefined) {
    return 'this viewport has not been handed `Report.drawing` yet — the core exports it and the caller has to pass it';
  }
  if (drawing.length === 0) {
    return 'the core exported no contours for this report — a reference fixture is built from code and has no drawing behind it, and an import refused before a part existed has none either. A drawing that yielded nothing cuttable comes back `ok: false` with the reason in `errors`, which is a different fact';
  }
  return '';
}

/**
 * How tall the walls are drawn, and whether that number was MEASURED or ASSUMED.
 *
 * 🔴 The assumption is the dangerous half, so it is returned as its own flag
 * rather than folded into the sentence — a caller cannot render the height
 * without deciding what to do about `assumed`.
 */
function wallHeight(
  cutDepthMm: ViewportProps['cutDepthMm'],
  thicknessMm: number
): { mm: number; assumed: boolean; why: string } {
  if (typeof cutDepthMm === 'number' && Number.isFinite(cutDepthMm) && cutDepthMm > 0) {
    return {
      mm: cutDepthMm,
      assumed: false,
      why: `drawn ${cutDepthMm.toFixed(1)}mm deep — the depth this program actually cuts to`,
    };
  }
  const base =
    cutDepthMm === null
      ? 'this plan produced no cut depth'
      : 'no cut depth was passed to this viewport';
  return {
    mm: thicknessMm,
    assumed: true,
    // 🔴 All three nouns in this sentence are the SAME rectangle — the
    // workpiece. `board` here did NOT mean the spoilboard: what keeps 12mm
    // after a 6mm pocket is the material being cut. Correcting `sheet` and
    // leaving `board` would have left the sentence about two objects.
    why: `drawn ${thicknessMm.toFixed(1)}mm deep — ASSUMED, because ${base}, so the workpiece thickness stands in. That is exact for a THROUGH cut and wrong for anything shallower: a 6mm pocket drawn to an 18mm workpiece shows a hole through a workpiece that keeps 12mm`,
  };
}

/** Why the `loaded object` control is off, in the user's terms. Each branch is
 *  a different fact and none of them is "unsupported".
 *
 *  🔴 `wallsLive` is here because the 2D branch below WENT STALE the moment the
 *  extruded-walls layer landed. It used to end *"there is no 3D object to
 *  show"* — full stop — which was the whole truth when a DXF really did put
 *  nothing on the canvas, and reads as "we have nothing for you" now that its
 *  outline is drawn. Founder, 2026-08-08.
 *
 *  ⚠ It is CONDITIONAL, and that is the point rather than caution: promising
 *  walls while the walls layer is dark would be the identical defect pointing
 *  the other way — a reason line asserting something the canvas does not
 *  honour. There is no 3D object either way; whether there is anything to look
 *  at instead is a separate fact, and only this flag knows it. */
function loadedReason(
  loaded: ViewportProps['loaded'],
  mesh?: LoadedMesh | null,
  wallsLive = false
): string {
  if (mesh) return '';
  if (loaded === undefined) {
    return 'the mesh was not requested for this plan — `Report.loaded_mesh` is null unless a caller asks with a triangle budget, and this viewport is not told which drawing is open';
  }
  if (loaded === null) return 'no drawing loaded';
  if (/stl/i.test(loaded.format)) {
    return `${loaded.name} is an STL, but its mesh was not requested for this plan — asking costs about 48 bytes a triangle, so it is opt-in with a budget`;
  }
  return (
    `${loaded.name} is a 2D ${loaded.format.toUpperCase()} drawing — there is no 3D object to show` +
    (wallsLive ? `; we draw its contours as ${WALLS_LABEL} only` : '')
  );
}

/* 🔴 `SNAP_DEG` WENT WITH THE ROTATE KNOB (2026-08-10). It was the angular
 * snap for a DRAG, and there is no longer a drag that turns the sheet — the
 * `Laid at` select offers the four quarter turns directly, so the intention it
 * existed to make reachable without a steady hand is now the only thing the
 * control can express. Left as a note rather than deleted silently: a constant
 * that reappears without its consumer is how a dead branch grows back. */

const COLOR: Record<string, number> = {
  cut: 0x2e7d32,
  tab: 0xe6a700,
  drill: 0x1565c0,
  rapid: 0x9e9e9e,
  change: 0xc62828,
  probe: 0x6a1b9a,
};

/**
 * The clamp red — ONE number, read by the mesh material and by the legend
 * swatch, for the reason `swatch()` states below: two copies of an instrument
 * colour is how a legend ends up describing an object it no longer matches.
 * This was a bare literal in two places inside the clamp material until the
 * layer chip needed to quote it (TODO #53).
 *
 * ⚠ It is deliberately THE SAME red as `change` (tool change) and that is not
 * an oversight to be fixed by inventing a new hue here: red is this scene's
 * hazard colour and both are hazards. The chip and the move are told apart by
 * their labels, not by a colour that would then disagree with the scene.
 */
const CLAMP_COLOR = 0xc62828;

/** The legend swatch, as CSS, from the SAME number the scene draws with. Two
 *  copies of an instrument colour is how a legend ends up describing a line it
 *  no longer matches. The workpiece is the exception and takes the brand token
 *  the sheet is painted from, because the sheet IS resolved from the tokens —
 *  a hex here would be the copy this file refuses to keep. */
export const swatch = (k: Layer) =>
  k === 'loaded'
    ? 'var(--ok)'
    : k === 'workpiece'
      ? 'var(--accent)'
      : // The simulated stock takes `--ink`, the one neutral nothing else in the
        // scene uses. It must not share the loaded object's swatch: those two
        // are the input and the output of the same job and the whole point of
        // drawing them is that they are different claims.
        k === 'result'
      ? 'var(--ink)'
    : // The walls take `--ink` — the TEXT colour, undiluted, because they are
      // line work and a drawing is line work. It is measured rather than
      // chosen: `--link` was tried first (the one alias nothing else in the
      // scene used) and it is amber-deep, which put the drawing's own shape
      // within a hue of the amber SHEET it stands on — the two solids most
      // likely to be confused, drawn on top of each other. A token being unused
      // is not the same as a token being distinguishable.
      //
      // ⚠ It therefore shares a HUE with `result`, which is `--ink` pulled 35%
      // toward the panel — and that is why the walls swatch is the only
      // OUTLINED one in the row (see the chip). Filled = a solid in the scene,
      // outlined = a reference shape, which is the distinction that actually
      // matters here and the one the scene itself makes. In the canvas the two
      // are never ambiguous anyway: the surface is an opaque sheet lying flat,
      // these are transparent ribbons standing up.
      k === 'walls'
      ? 'var(--ink)'
    : // 🔴 The plate is deliberately NOT the clamp red. Red is this scene's
      // keepout colour, and whether a touch plate IS a keepout is a machining
      // question that belongs in the core where a gate can see it — not
      // something settled here by picking a colour.
      k === 'touch'
      ? 'var(--muted)'
    : // …and the clamps ARE the keepout, so they take that red — from the same
      // constant the mesh is built with, never a second copy of it.
      k === 'clamps'
      ? `#${CLAMP_COLOR.toString(16).padStart(6, '0')}`
    : /* The reach outline takes `--line`, the theme's boundary colour, which is
       * the same token the scene draws it with. It is rendered OUTLINED for the
       * same reason `walls` is and a stronger one: in the scene it IS a line,
       * so a filled chip would be a swatch for a solid that does not exist. */
      k === 'travel'
      ? 'var(--line)'
    : /* And the board takes `--panel`, the surface neutral it is painted with.
       * ⚠ That is the same colour the chip row sits on, so this one swatch is
       * given a border by the chip below — the alternative was inventing a hue
       * here, which is exactly the second copy of a scene colour this function
       * exists to refuse. */
      k === 'spoilboard'
      ? 'var(--panel)'
      : `#${(COLOR[k] ?? 0x888888).toString(16).padStart(6, '0')}`;

/**
 * Everything the "is this layer actually in the scene?" question is answered
 * from — the SAME values the viewport is handed, nothing derived and nothing
 * re-read from a panel.
 *
 * 🔴 IT IS A `Pick` OF `ViewportProps` ON PURPOSE. The controls now live in the
 * sidebar and the drawing lives on the canvas, so two surfaces have to agree
 * about what is on screen; typing this as a subset of the viewport's own props
 * means the caller cannot feed the liveness check one thing and the picture
 * another without the compiler noticing the shape changed.
 */
export type LayerScene = Pick<
  ViewportProps,
  | 'touchPlate'
  | 'loadedMesh'
  | 'stockSurface'
  | 'drawing'
  | 'clamps'
  | 'spoilboard'
  | 'tool'
  | 'moves'
  | 'travel'
  | 'stock'
  | 'loaded'
  | 'cutDepthMm'
>;

/**
 * 🔴 THE DEAD-CONTROL RULE, AND THE ONE PLACE IT IS WRITTEN.
 *
 * A layer the scene does not contain is **not offered at all** — no control for
 * a move class this program lacks, none for a cutter with no diameter, none for
 * clamps or a board nobody declared. A disabled control reads as *"this is
 * switched off"*, and *"switched off"* reads as *"there is one and you cannot
 * see it"* — which is a different fact from *"there is none"*, and on a bed the
 * dangerous one.
 *
 * It moved out of the component body when the toggles moved to the sidebar,
 * because it now has TWO callers: the panel that renders the eyes, and the
 * canvas that counts what is hidden. A second copy of this filter would be two
 * answers to one question, and the disagreement would show up as an eye for a
 * layer the indicator does not count.
 */
export function liveLayersOf(s: LayerScene): Layer[] {
  // A layer with nothing behind it cannot be "hidden" — it is UNAVAILABLE, and
  // the indicator must not claim the operator switched something off that was
  // never there.
  const touchLive = !!s.touchPlate?.enabled;
  const loadedLive = !!s.loadedMesh;
  const resultLive = !!s.stockSurface;
  // A contour list with no contours in it is not a drawing to extrude — and it
  // is not "the drawing is empty" either. `wallsReason` keeps the two apart.
  const wallsLive = !!s.drawing && s.drawing.length > 0;
  const clampsLive = s.clamps.length > 0;
  const spoilLive = !!s.spoilboard;
  /* 🔴 IS A CUTTER ACTUALLY DRAWN? Two things have to be true and neither is a
   * setting: the program must have a head to sit at (an empty program has
   * none), and the tool row must state a diameter — `toolMarkerShape` refuses
   * to draw without one rather than inventing a width, which is the same
   * refusal the core makes.
   *
   * ⚠ NOT `!!s.tool`. A tool row exists whenever one is selected; a row with no
   * diameter draws nothing, and a control offered for it would toggle a layer
   * that is already empty — which teaches an operator that the eyes do nothing.
   *
   * ⚠ `refused === null` and NOT `drawn.length` — `drawn` is the list of what
   * the marker ASSERTS, prose for the hover panel, and a marker can be drawn
   * while asserting nothing worth listing. */
  const toolLive = s.moves.length > 0 && toolMarkerShape(s.tool).refused === null;
  /* Which MOVE CLASSES this program actually contains — measured from the moves
   * themselves, never from a setting. A job configured with two tools that
   * emitted one program with no change has no change to show. */
  const presentKinds = new Set<string>();
  for (const m of s.moves) presentKinds.add(m.kind);
  return LAYERS.filter(
    (k) =>
      (k !== 'touch' || touchLive) &&
      (k !== 'loaded' || loadedLive) &&
      (k !== 'result' || resultLive) &&
      (k !== 'walls' || wallsLive) &&
      (k !== 'clamps' || clampsLive) &&
      (k !== 'spoilboard' || spoilLive) &&
      (k !== 'tool' || toolLive) &&
      // A move class the program does not contain is not offered at all.
      // `probe` is the exception: it is kept while a plate is declared.
      //
      // ⚠ FINDING, 2026-08-11, recorded rather than silently changed: the
      // reason this clause carried — *"it is drawn from the touch-plate layer
      // as well"* — is NOT what `applyVis` does. There, `probe` hides
      // `path:probe` and nothing else; the plate is the separate `touch` arm.
      // So on a machine with a declared plate whose program contains no probe
      // move (an empty or refused program), this offers a control that toggles
      // nothing. Preserved verbatim because changing which layers are offered
      // is a behaviour change, not a move — see the report for TODO #81.
      (!MOVE_LAYERS.includes(k) || presentKinds.has(k) || (k === 'probe' && touchLive))
  );
}

/**
 * What a layer's control says when you hover it — the long form, with the
 * caveat that makes the toggle safe.
 *
 * 🔴 ONE FUNCTION, TWO SURFACES, for the reason the labels are one map: these
 * sentences are the place a control admits that hiding the PICTURE does not
 * change the PROGRAM ("the fixture check still runs against every one of
 * them"). A sidebar eye whose tooltip was written separately would be a second,
 * softer copy of a safety message, in the one place no gate can see it.
 */
export function layerTitle(k: Layer, s: LayerScene, shown: boolean): string {
  const off = shown ? '' : ', HIDDEN';
  switch (k) {
    case 'touch':
      return `${LAYER_LABEL[k]}${off}.`;
    case 'loaded':
      return `${LAYER_LABEL[k]}${off}.`;
    case 'result':
      return s.stockSurface
        ? `${LAYER_LABEL[k]}, ${s.stockSurface.cell_mm}mm cells${off} — the stock the machine would LEAVE, not the part: a height map records removed material and cannot say which side of a through cut you keep. ${resultCaveats(s.stockSurface.cell_mm)}`
        : `${LAYER_LABEL[k]} — ${resultReason(s.stockSurface)}.`;
    case 'walls':
      return `${LAYER_LABEL[k]}${off} — what the DRAWING asks for, ${
        wallHeight(s.cutDepthMm, s.stock[2]).why
      }. Square inside corners no cutter can make and no dogbones; the simulated stock surface is what the machine would leave. Arcs drawn to ${WALL_ARC_TOLERANCE_MM}mm.`;
    case 'tool':
      return `${LAYER_LABEL[k]} — the cutter drawn at the head of the program${off}. It is a MARKER, not a measurement of the cut: it stands where the last drawn move ends, at the tip. Switching it off changes the picture and nothing else — the same tool still plans every feed, depth and clearance in the program.`;
    case 'clamps':
      return `${LAYER_LABEL[k]} — ${s.clamps.length} declared${off}. This switches off the picture of them and nothing else: they are still declared work holding, the fixture check still runs the toolpath against every one, and a hidden clamp cannot be dragged.`;
    case 'travel':
      return `${LAYER_LABEL[k]} — ${s.travel[0]} x ${s.travel[1]}mm from the machine datum${off}. It is a LIMIT, not a surface: nothing sits on it and nothing is cut into it. Exceeding it is the controller refusing the line or an axis hitting its stop — a different failure from running off the spoilboard, which is the cutter reaching what the machine is built of.`;
    case 'spoilboard': {
      // The thickness state rides on the layer's own sentence, because the
      // control is offered for a board whose depth may be unknown and "the
      // board is drawn" must not be heard as "the board is measured".
      const slab = boardSlab(s.spoilboard, s.stock[2]);
      const depth =
        slab.state === 'slab'
          ? ` It is drawn as a SLAB ${slab.thicknessMm!.toFixed(1)}mm thick, from its top face down to its underside.`
          : slab.state === 'unknown-thickness'
            ? ' Its THICKNESS IS UNKNOWN, so it is drawn as a flat plane with a dashed edge and NO underside — a slab of assumed depth would be a measurement nobody made.'
            : '';
      return `${LAYER_LABEL[k]} — the declared board, at its own size and its own corner${off}, with the reach it does NOT cover shaded beside it. This is the only rectangle here made of anything: a through-cut into it is intended and sacrificial, and the same cut past its edge has no sacrificial material under it at all.${depth} Switching it off changes the picture and nothing else — the position check still runs.`;
    }
    default:
      return shown ? `Hide the ${LAYER_LABEL[k]}` : `Show the ${LAYER_LABEL[k]}`;
  }
}

// ---------------------------------------------------------------------------
// The spoilboard as a SLAB — TODO #71, browser half
// ---------------------------------------------------------------------------
//
// 🔴 THREE STATES, AND NO TWO OF THEM MAY LOOK ALIKE.
//
//   none               nobody declared a board. Nothing is drawn — not a faint
//                      plane, not a dashed hint, not `travel`-sized. That has
//                      been true since 2026-08-10 and is unchanged here.
//   unknown-thickness  a board is declared and its depth is not. It keeps the
//                      FLAT PLANE it has always been drawn as — no bottom face,
//                      no side walls — and gains a marker.
//   slab               a board with a usable declared thickness, drawn with a
//                      top face, an underside and the sides between them.
//
// ⚠ The requirement the founder asked for is *"visualize the thickness as
// well"*; the requirement the CORE imposes is that an unknown thickness must
// not become a picture. `core/src/sim.rs::BoardDepth` says it in terms — the
// enum exists *"because the browser has to paint a board whose thickness nobody
// declared, and painting it as a slab of some plausible depth would assert a
// measurement nobody made"*.

/** What is drawn for the board. Three values, deliberately not two. */
export type BoardDrawState = 'none' | 'unknown-thickness' | 'slab';

export interface BoardSlab {
  state: BoardDrawState;
  /**
   * The board's TOP FACE, in the same Z the toolpath is drawn in (`z = 0` at
   * the workpiece top, negative downward). `null` only when nothing is drawn.
   */
  topZMm: number | null;
  /** The board's UNDERSIDE. `null` unless {@link BoardSlab.state} is `'slab'` —
   *  there is deliberately no fallback floor. */
  undersideZMm: number | null;
  /** The thickness as DECLARED and usable. `null` is UNKNOWN, never zero. */
  thicknessMm: number | null;
  /** Why it is not a slab, in the operator's words. Empty when it is one. */
  why: string;
}

/**
 * Where the board sits in Z, and whether it may be drawn with a depth at all.
 *
 * 🔴 **THE TWO FORMULAE ARE THE CORE'S AND THIS IS THEIR ONLY HOME IN THIS
 * FILE.** `core/src/types.rs` states them once, on purpose, because before it
 * did *"the relationship was nowhere — not in a field, not in a comment — and
 * the workpiece bottom sat at the board top by assumption rather than by
 * construction"*:
 *
 * * `Spoilboard::top_face_z_mm(stock) == -stock` — the workpiece RESTS on the
 *   board, so the board's top IS the workpiece's underside.
 * * `Spoilboard::underside_z_mm(stock) == top_face - thickness`, and it is
 *   `None` exactly when the thickness is unusable.
 *
 * The report carries the two INPUTS (the workpiece thickness and the board's
 * `thickness_mm`) and not the two answers, so this end has to apply them — but
 * in ONE named place that cites the core, never spelled `-sz` at each site that
 * needs it. Two spellings of where the board sits is how the picture and the
 * check acquire two definitions.
 *
 * ⚠ It mirrors `usable_thickness_mm` exactly: **finite and greater than zero**.
 * A present-but-unusable value is a THIRD fact — somebody typed a thickness and
 * that is not the same as never having said — and it is reported in `why`
 * rather than folded into absence.
 */
export function boardSlab(
  board: ViewportProps['spoilboard'],
  workpieceThicknessMm: number
): BoardSlab {
  const none = (why: string): BoardSlab => ({
    state: 'none',
    topZMm: null,
    undersideZMm: null,
    thicknessMm: null,
    why,
  });
  if (board == null) return none('No spoilboard is declared — the position check reports UNCHECKED.');
  const x = Number(board.x_mm);
  const y = Number(board.y_mm);
  const w = Number(board.size_x_mm);
  const h = Number(board.size_y_mm);
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || !(w > 0) || !(h > 0)) {
    return none('The declared board is not a rectangle on this machine, so nothing is drawn for it.');
  }
  // A non-finite workpiece thickness gives the stack no height, and the core
  // refuses an underside for exactly this input. Drawing at NaN puts a board at
  // the world origin — a rectangle in a place nobody declared.
  if (!Number.isFinite(workpieceThicknessMm)) {
    return none('The workpiece thickness is not a number, so where the board sits cannot be stated.');
  }
  const topZMm = -workpieceThicknessMm;
  const declared = board.thickness_mm;
  const t = Number(declared);
  const usable = declared != null && Number.isFinite(t) && t > 0;
  if (!usable) {
    return {
      state: 'unknown-thickness',
      topZMm,
      undersideZMm: null,
      thicknessMm: null,
      why:
        declared == null
          ? 'Thickness UNKNOWN — nobody declared one. It is NOT read as "thick enough": the depth check reports PENDING, and this board is drawn flat because a slab of assumed depth would be a measurement nobody made.'
          : `A thickness of ${String(declared)} was declared and it is not a slab. It is NOT read as "unknown" — somebody typed a thickness — and it is not read as "thick enough" either. Nothing here draws a depth from it.`,
    };
  }
  return {
    state: 'slab',
    topZMm,
    undersideZMm: topZMm - t,
    thicknessMm: t,
    why: '',
  };
}

// ---------------------------------------------------------------------------
// The depth limb's verdict — TODO #71 / #74
// ---------------------------------------------------------------------------

/** `core/src/sim.rs::BoardDepth::as_str`, and nothing else is a verdict. */
export type BoardDepthVerdict = 'through-board' | 'inside-board' | 'board-depth-unknown';

const BOARD_DEPTH_VERDICTS: readonly string[] = ['through-board', 'inside-board', 'board-depth-unknown'];

export interface BoardDepthRead {
  verdict: BoardDepthVerdict;
  /** The count EXACTLY as reported, and `null` when nothing reported one. It is
   *  never the signal — see {@link readBoardDepth}. */
  throughCells: number | null;
  /** Why the limb did not run, in the CORE's words wherever it sent any. */
  reason: string | null;
  /** Did the limb run? `false` ⇒ PENDING, whatever the count says. */
  ran: boolean;
}

/**
 * Read the depth limb's answer **off the word, never off the integer**.
 *
 * 🔴 `through_board > 0` IS NOT THE SIGNAL. `0` is what a limb that compared
 * nothing reports and also what a limb that compared everything and found
 * nothing reports, and the core gave the verdict a three-state WORD rather than
 * a boolean *"precisely so a host cannot render PENDING and CLEAR the same
 * way"*. Deriving the verdict here from the count would render PENDING as the
 * safe answer — one of the three mutations the core's own tests plant.
 *
 * ⚠ An unrecognised verdict string is **PENDING**, not a fall-through to the
 * harmless arm. The core's serde default note names that exact failure: *"a
 * renderer with a three-way match on the verdict would fall through its own
 * arms and print whatever its `_` case says, which on every UI written so far
 * is the harmless one"*.
 */
export function readBoardDepth(c: ViewportProps['boardDepth']): BoardDepthRead {
  const raw = c?.board_depth;
  const n = Number(c?.through_board);
  const throughCells = c?.through_board != null && Number.isFinite(n) ? n : null;
  const reported = c?.board_depth_pending_reason ?? null;
  if (raw == null) {
    return {
      verdict: 'board-depth-unknown',
      throughCells,
      // Named as a WIRING fact rather than dressed up as a machining one: the
      // report carries this field, and if it is not here the caller did not
      // pass it. Absent still renders as PENDING either way.
      reason:
        reported ??
        'The depth verdict (report.sim.board_depth) has not reached this viewport, so nothing here says whether a cut went through the board. PENDING, not clear.',
      ran: false,
    };
  }
  if (!BOARD_DEPTH_VERDICTS.includes(raw)) {
    return {
      verdict: 'board-depth-unknown',
      throughCells,
      reason: `The report's depth verdict is "${raw}", which this viewport does not recognise. Treated as PENDING rather than matched to the nearest state.`,
      ran: false,
    };
  }
  const verdict = raw as BoardDepthVerdict;
  const ran = verdict !== 'board-depth-unknown';
  return { verdict, throughCells, reason: ran ? null : reported, ran };
}

/** One line of what the depth limb answered, for the hover panel. */
export function boardDepthText(d: BoardDepthRead): { text: string; tone: HoverTone | undefined } {
  // 🔴 "the count was not reported" and "0 cells" are different sentences, and
  // the second one is a measurement. A missing integer is never printed as one.
  const cells =
    d.throughCells == null
      ? 'the cell count was not reported'
      : `${d.throughCells} cell(s) past its underside`;
  switch (d.verdict) {
    case 'through-board':
      return {
        text: `THROUGH THE BOARD — ${cells}, into whatever the machine is built of`,
        tone: 'bad',
      };
    case 'inside-board':
      return { text: `inside the board — ${cells}`, tone: undefined };
    default:
      // 🔴 The count is deliberately NOT printed here. `0` beside a PENDING
      // word is the exact pair that reads as a clean result.
      return { text: 'PENDING — the limb did not run', tone: 'pending' };
  }
}

/**
 * The reachable area with **no sacrificial material under it**, in words.
 *
 * 🔴 `null` (nobody declared a board, so the question was never asked) and
 * `[0,0,0,0]` (a board that covers everywhere the cutter can go) are different
 * facts and only the second is safe. They are said differently here, and the
 * strip format mirrors `core/src/types.rs::BareReach::describe` rather than
 * inventing a second wording for the same numbers.
 */
export function bareReachText(
  bare: [number, number, number, number] | null | undefined
): { text: string; tone: HoverTone | undefined } {
  if (bare == null) {
    return { text: 'not reported — no board reached the check', tone: 'pending' };
  }
  const v = bare.map((x) => (Number.isFinite(Number(x)) ? Number(x) : NaN));
  if (v.some((x) => Number.isNaN(x))) {
    return { text: 'not reported — the four strips did not arrive as numbers', tone: 'pending' };
  }
  const parts: string[] = [];
  for (const [mm, side] of [
    [v[0], 'X-'],
    [v[1], 'X+'],
    [v[2], 'Y-'],
    [v[3], 'Y+'],
  ] as [number, string][]) {
    if (mm > 0) parts.push(`${mm.toFixed(1)}mm on ${side}`);
  }
  if (!parts.length) return { text: 'none — the board covers the whole reach', tone: undefined };
  return { text: parts.join(', '), tone: 'warn' };
}

// ---------------------------------------------------------------------------
// The tool marker — TODO #44
// ---------------------------------------------------------------------------
//
// 🔴 IT WAS ONE PICTURE FOR EVERY CUTTER. `CylinderGeometry(3, 3, 40, 8)` drew
// a Ø1 engraver, a Ø6 down-cut end mill and a Ø20 surfacing cutter identically,
// and a drill exactly like a profile bit — in the one scene an operator uses to
// judge whether a cutter clears a clamp. A marker at a size nobody stated is a
// measurement nobody took, and it was 6mm wide for all of them.
//
// This is the same defect `toolShape.tsx` fixed in 2D (TODO #31) and it is
// fixed here on the same terms: EVERYTHING IS DRAWN FROM A NUMBER THAT EXISTS,
// OR IT IS NOT DRAWN.
//
//   no diameter at all -> no cutter. A dashed cage, and the reason in words.
//   no tip angle       -> no tip. The solid ends OPEN, with a dashed ring.
//   no shank diameter  -> no shank. Nothing is drawn above the flute.
//   no cutting length  -> the flute is drawn TORN, never to a plausible length.
//   no tool passed     -> the same cage, and a DIFFERENT sentence. "I was not
//                         told" and "there is nothing" are separate facts.
//
// 🔴 THE FIELD READING IS NOT DUPLICATED HERE. IT WAS, AND THE MIRROR IS GONE.
//
// For one commit this file held its own copy of `toolShape.tsx`'s category
// mapping — `read()`, `resolveTip()` and `Tip` were module-private there, and
// that file was held by another change — so the two views could describe one
// cutter differently and were kept in step by CROSS-CHECKS that could only
// subtract a claim. That is a floor under the damage, not agreement.
//
// `toolShape.tsx` now exports `readToolShape()`, `resolveToolTip()` and
// `toolCategoryKey()`, and this file calls them. There is ONE answer to "what
// shape is this tool", and it is not in this file.
//
// What this file still owns, because it is genuinely this view's and not the
// tool list's:
//
//   * the OVERSIZE envelope — every radius is scaled by {@link
//     TOOL_FACET_SCALE} so the 12 flat faces sit outside the true circle. The
//     shared reader is asked for the tip at the TRUE radius and the answer is
//     scaled here, so the drawn cone keeps the row's real half-angle;
//   * the refusal SENTENCES, which differ because the pictures differ: the 2D
//     drawing's body "ends in a dashed line", the marker's solid "ends open,
//     inside a dashed ring". Only the missing NOUN is shared;
//   * the two `is_angular` cross-checks, which compare the CORE's verdict
//     against the category's, and can still only ever remove a tip.
//
// ⚠ The third cross-check — "the tool list refuses a tip and this drew one" —
// is now STRUCTURALLY unreachable, because both views resolve the same
// `ToolTip`. It is kept as a tripwire on that invariant, not as the thing that
// makes it true, and it says so where it stands.
//
// ⚠ EXACTLY ONE SENTENCE CHANGED when the mirror went, and it is the ball nose.
// This view said *"ball nose, 3.00 mm radius"* where the tool list said *"ball
// nose, 3.0 mm radius"* for the same cutter: the mirror carried its own
// formatting, and divided the facet scale back out to recover the true radius.
// Both stated the TRUE radius, so neither was ever wrong — they simply were not
// the same words, which is the precise class of divergence this change exists
// to end. Every other drawn and not-drawn sentence, and every coordinate in
// both lathe profiles, is byte-identical to before.

/**
 * The marker's instrument colours. Deliberately NOT brand tokens: like the six
 * move classes above, a cutter marker is an INSTRUMENT, and whether brand owns
 * instrument/safety colours is an open question (brand ticket, 2026-08-08).
 * Changing the geometry does not settle the colour, so the teal is the teal it
 * has always been.
 */
const TOOL_CUT_COLOR = 0x0b7285;
/**
 * The shank cuts nothing, so it is not drawn in the cutting colour — the same
 * split `toolShape.tsx` makes between `--ink` and `--muted`. It is still an
 * instrument colour and still outside the token palette.
 */
const TOOL_SHANK_COLOR = 0x4b6a72;
/** The refusal: grey, dashed, and unmistakably not a cutter. */
const TOOL_REFUSED_COLOR = 0x9e9e9e;

/**
 * The origin triad. INSTRUMENT colours, in the same class as the six move
 * classes and the cutter marker, and outside the token palette for the same
 * reason: X-red / Y-green / Z-blue is a convention an operator already reads off
 * every other CAM screen and every machine controller, and re-hueing it to suit
 * a theme would make this the one axis indicator that disagrees with all of
 * them.
 *
 * ⚠ Red is also this scene's HAZARD colour (`CLAMP_COLOR`, `change`). That
 * collision is accepted rather than resolved with a fourth red: an arrow with a
 * letter on its tip, drawn from the origin, is not mistakable for a clamp
 * footprint or a rapid, and inventing an off-convention X would trade a
 * theoretical confusion for a certain one.
 */
const AXIS_COLOR = { x: 0xd32f2f, y: 0x388e3c, z: 0x1976d2 };

/**
 * WHICH MACHINE DIRECTION A SHEET-FRAME BASIS VECTOR POINTS IN, in words —
 * `null` when it is not cardinal.
 *
 * 🔴 It reads the BASIS, and deliberately does not recover an angle with
 * `atan2`. Recovering an angle here would be this file writing the placement
 * rule a second time, which is the exact defect `Job::placement()`'s header
 * records — and the answer wanted is a direction, which the basis vector
 * already is.
 */
function cardinal(x: number, y: number): string | null {
  const t = 1e-9;
  if (Math.abs(y) < t && x > t) return 'machine +X';
  if (Math.abs(y) < t && x < -t) return 'machine −X';
  if (Math.abs(x) < t && y > t) return 'machine +Y';
  if (Math.abs(x) < t && y < -t) return 'machine −Y';
  return null;
}

/**
 * The two datums, by the names `core/src/types.rs::ZDatum::label` gives them.
 *
 * 🔴 NOT A BOOLEAN, even though `App` stores one (`zZeroTop`). The core stopped
 * being a boolean on 2026-08-11 for the reason its own header gives — *"`!stock
 * .z_zero_at_top` no longer compiles anywhere"* — and a boolean crossing this
 * prop boundary would put the two datums back on opposite sides of truthiness,
 * where an unwired caller, an empty string and a zero all land on ONE of them
 * silently. The conversion happens once, at the call site, in the open.
 */
export type ZDatumName = 'workpiece-top' | 'spoilboard-top';

/**
 * **WHERE THE ARROWS MEET, in this scene's Z** — and since 2026-08-11 that is
 * the DECLARED work zero rather than the picture's own zero.
 *
 * 🔴 THIS IS THE CHANGE THE FOUNDER'S REPORT ACTUALLY NEEDED. His words were
 * *"the xyz arros center seems on top of the workpeace"*, and three commits read
 * that as the `aZ = 0.4` lift. It was not: the lift is 0.23px at the view the
 * report was made from (measured — see the triad's own note), and what he was
 * looking at was the GEOMETRY. `stockOrigin` defaults to `[0,0]`, so the
 * workpiece's datum corner sits on the machine origin and this scene's `z = 0`
 * IS the workpiece's top face. The arrows genuinely met there, and under
 * `ZDatum::WorkpieceTop` they are RIGHT to.
 *
 * What was wrong is that they met there under the OTHER datum too. `ZDatum`
 * (founder ruling, same day: *"0Z should be on the bottom of the workpiece, top
 * of the spoilboard"*) puts work zero one workpiece thickness lower, and this
 * component was never handed the declaration — so the instrument whose entire
 * job is to say which frame you are in was drawing the wrong frame, confidently,
 * with no way to tell from the picture.
 *
 * The two formulae are the core's, in this scene's coordinates (`z = 0` at the
 * workpiece top, negative downward), and they are the same pair {@link
 * boardSlab} cites:
 *
 *   · `ZDatum::WorkpieceTop`  → `0`     — the workpiece's top face.
 *   · `ZDatum::SpoilboardTop` → `-t`    — the workpiece's UNDERSIDE, which is
 *     `Spoilboard::top_face_z_mm(t)` exactly, and is the same plane whether or
 *     not a board has been declared.
 *
 * ⚠ A NON-FINITE THICKNESS FALLS BACK TO `0` AND THE CAPTION SAYS SO. The
 * alternative is `NaN`, which in three.js puts the whole triad at nowhere and
 * silently removes the app's only axis indicator — an instrument that vanishes
 * is read as "there are no axes", not as "the thickness is not a number".
 * Falling back is a picture decision; it is never allowed to be a silent one.
 *
 * Pure and exported so a node test can drive both datums without a canvas.
 */
export function axesRootZMm(datum: ZDatumName, workpieceThicknessMm: number): number {
  if (datum !== 'spoilboard-top') return 0;
  return Number.isFinite(workpieceThicknessMm) ? -workpieceThicknessMm : 0;
}

/**
 * WHERE THE ARROWS MEET, said on the screen because the picture cannot say it.
 *
 * ⚠ IT SAYS **PLANE**, NOT **FACE**, and the difference is a whole class of
 * setups. The arrows are at the machine origin, which the workpiece only covers
 * while `stockOrigin` is near `[0,0]`. Move the workpiece inboard — which is
 * what a real setup does, since the gantry cannot reach the very corner — and
 * they meet in mid-air at that height. "On the top face" would then be a caption
 * describing a picture nobody is looking at.
 *
 * 🔴 IT NOW STATES WHERE Z0 IS, AND THAT IS ONLY HONEST BECAUSE THE DATUM IS
 * PASSED IN. Until 2026-08-11 this sentence ended *"this picture's zero, not the
 * job's declared Z zero"* — a correct disclaimer of a fact the component did not
 * have, and `docs/design-87-z-datum.md` §4.4 was right that the picture change
 * *"should follow the numbers, not lead them"*. The numbers landed; the arrows
 * moved; **the disclaimer had to go with them.** A sentence that still said
 * *"not the job's declared Z zero"* over arrows now drawn AT the declared Z zero
 * would be a stale explanation of a fixed problem, which is its own defect and a
 * worse one than the ambiguity it used to describe.
 *
 * ⚠ IT SAYS **DECLARED**, AND IT DOES NOT SAY THE DATUM HAS BEEN SET. Where the
 * operator says Z0 is and where they actually touched off are two facts, and
 * only the first reaches this app at all. `ZDatum::SpoilboardTop`'s own doc is
 * blunt about it: a datum arithmetically at the bottom and physically referenced
 * to the workpiece TOP is *worse* than doing nothing, because the thickness
 * error is back in full and the operator believes it is gone. So the bottom-datum
 * sentence names the surface the machine has to be zeroed against.
 */
export function axesRootNote(datum: ZDatumName, workpieceThicknessMm: number): string {
  if (datum !== 'spoilboard-top') {
    return (
      ' The arrows meet at the machine origin, in the workpiece’s top-face plane —' +
      ' and that is where this job declares Z 0: the workpiece top.'
    );
  }
  const t = Number.isFinite(workpieceThicknessMm) ? workpieceThicknessMm : null;
  if (t == null) {
    return (
      ' This job declares Z 0 at the SPOILBOARD TOP, and the workpiece thickness is not a number,' +
      ' so how far below the top face that is cannot be drawn: the arrows are at the machine origin' +
      ' in the top-face plane, which is NOT the declared Z zero. Fix the thickness.'
    );
  }
  return (
    ` The arrows meet at the machine origin, in the workpiece’s UNDERSIDE plane —` +
    ` ${t} mm below its top face, and that is where this job declares Z 0: the spoilboard top.` +
    ` Zero the machine against the BOARD, not the workpiece; a bottom datum referenced off the top` +
    ` face puts the thickness error back in full and hides it.`
  );
}

/**
 * The one sentence that makes `Part X` / `Part Y` readable.
 *
 * 🔴 THE FRAME IS THE FOUNDER'S 2026-08-10 CONFUSION, AND IT IS NOT A BUG.
 * `Job::place` adds the drawing offset BEFORE the workpiece's rotation, so those
 * two fields are millimetres measured ON THE WORKPIECE. On a workpiece laid at
 * 90°, typing into `Part X` moves the program along the machine's Y — correctly,
 * because that is where the part physically is on the material. Measured at the
 * emitted G-code (plate.dxf, 500x500 workpiece, 90°): `drawing_offset [50,0]` moved Y
 * 47..253 -> 97..303 with X unchanged.
 *
 * An unlabelled triad would assert the opposite — "these are the axes your
 * numbers are in" — so the machine triad names its frame and this line states
 * the relationship between the two frames in words.
 *
 * 🔴 AND SINCE 2026-08-11 THIS LINE CARRIES IT ALONE. The founder removed the
 * workpiece's own arrow pair — quoted verbatim, and a quotation is a record
 * (terminology.md X11): *"remove the sheet X, sheet Y arrows"*; the machine
 * triad stays, because he asked for those himself. So the canvas no longer
 * DRAWS the second frame at any angle — it only says so, here. Written down
 * rather than compensated for: substituting some other indicator he did not ask
 * for is the failure worth avoiding, and if the words turn out not to be enough
 * he will say so.
 */
function frameNote(
  P: Placement2D | null | undefined,
  /* 🔴 THE ROOT NOTE IS PASSED IN, not read from a module constant, because it
   * now DEPENDS ON THE JOB — the declared datum and the workpiece thickness. A
   * constant could not carry either, and re-deriving the datum inside each of
   * the three branches below would be three places for the caption to disagree
   * with the arrows. One computation, at the caller, beside the one that roots
   * the triad. */
  rootNote: string
): { text: string; turned: boolean } {
  const p = P ?? NO_PLACEMENT;
  const sx = cardinal(p.cos, p.sin);
  const sy = cardinal(p.row_y[0], p.row_y[1]);
  if (sx === 'machine +X' && sy === 'machine +Y') {
    return {
      turned: false,
      // ⚠ EACH `text:` STARTS ITS STRING ON ITS OWN LINE, and that is not a
      // formatting preference. `tests/terminology.test.ts`'s negative control
      // plants the founder's retired word into the first of these three
      // sentences by a literal source replacement, so wrapping the string onto
      // the next line makes the plant silently not apply. Concatenate at the
      // END; never break before the opening quote.
      //
      // 🔴 AND DO NOT QUOTE THE ANCHOR IN A COMMENT. This note originally spelt
      // the replaced text out, which put a copy of it ABOVE the code — and
      // `String.replace` takes the FIRST occurrence, so the plant landed in the
      // comment, where the scanner does not look. It applied, changed a byte,
      // and found nothing: **a negative control disarmed by the note explaining
      // it.** Caught only because that control asserts the delta rather than the
      // replacement.
      text: 'Axes — the workpiece is laid square, so its X and Y run with the machine\'s. Part X / Part Y are millimetres measured on the workpiece.' + rootNote,
    };
  }
  if (sx && sy) {
    return {
      turned: true,
      text: `Axes — the workpiece is TURNED: its X runs along ${sx} and its Y along ${sy}. Part X / Part Y are millimetres measured on the workpiece, so Part X moves the program along ${sx}.` + rootNote,
    };
  }
  return {
    turned: true,
    text:
      // ⚠ This used to end "…along the dashed pair", naming the workpiece's own
      // arrow pair. They were removed on 2026-08-11 and a sentence pointing at a
      // deleted object is worse than a shorter one: it sends the reader hunting.
      'Axes — the workpiece is turned to an angle that is not a quarter turn, so neither of its axes runs along a machine axis. ' +
      'Part X / Part Y are millimetres measured on the workpiece, not along the machine arrows drawn here.' +
      rootNote,
  };
}

/** Facets around the marker. Low-poly and flat-shaded, like the rest of the scene. */
const TOOL_SEGMENTS = 12;

/**
 * 🔴 The polygon CIRCUMSCRIBES the true circle instead of inscribing it.
 *
 * A lathe puts its vertices ON the circle, so a 12-sided Ø20 cutter would be
 * drawn up to 3.5% NARROWER than the tool actually is — in the scene people use
 * to decide whether that cutter clears a clamp. Scaling every radius by
 * `1 / cos(pi/n)` puts the flat faces tangent to the circle instead, so the
 * drawn envelope is never smaller than the real one. Same direction as the
 * simulation's own rounding: over-report the space the tool occupies, never
 * under-report it.
 */
const TOOL_FACET_SCALE = 1 / Math.cos(Math.PI / TOOL_SEGMENTS);

/**
 * How much shank is drawn, mm. OVERALL LENGTH IS NOT IN THE TOOL RECORD, so
 * this is a display length and the shank is ALWAYS drawn with a torn end. It is
 * never a measurement and nothing may read it back as one — the same rule
 * {@link PLATE_PLACEHOLDER_XY} carries.
 */
const TOOL_SHANK_DISPLAY_MM = 25;

/**
 * How much flute is drawn when the record states no cutting length, mm — again
 * a display length with a torn end, and again never a measurement. It is tied
 * to the diameter only so the stick looks like a stick at any size.
 */
const toolUnstatedFluteMm = (diaMm: number) => Math.max(2 * diaMm, 10);

/**
 * The refusal cage, mm. A PLACEHOLDER SIZE, stated as one wherever it is shown,
 * for exactly the reason the touch plate's footprint is: a box drawn at a size
 * nobody declared gets measured off the screen by the next person.
 */
const TOOL_FRAME_MM = { xy: 14, h: 40 };

interface ToolMarkerTip {
  kind: 'flat' | 'ball' | 'cone' | 'none';
  /** Height along the axis, mm. 0 for a flat end. */
  heightMm: number;
  /** What it is, in words, when it IS drawn. */
  says: string | null;
  /**
   * The whole sentence for the refusal, when there is one — not a fragment to
   * be slotted into a frame elsewhere. The first version held only the missing
   * NOUN and built the sentence at the call site, which reads correctly for
   * *"point angle"* and produced *"…so the row contradicts itself is not
   * stated, so no tip is drawn"* for the cross-checks. A refusal that comes out
   * as gibberish is a refusal nobody reads.
   */
  refusal: string | null;
}

/** What the marker draws, and what it refuses to. */
export interface ToolMarkerShape {
  /** Why no cutter is drawn, or `null` when one is. */
  refused: string | null;
  /** Lathe profile of the CUTTING portion, `[radius, height]` mm, tip at y = 0. */
  cutting: [number, number][];
  /** Lathe profile of the shank, or `null` when no shank diameter is stated. */
  shank: [number, number][] | null;
  /** Radius of the dashed "tip not stated" ring at y = 0, or `null`. */
  openTipRadiusMm: number | null;
  /** What the marker asserts, in the order it draws it. */
  drawn: string[];
  /** What it will not assert — the tool list's refusals, plus this view's. */
  notDrawn: string[];
  /** One line for the hover row. */
  summary: string;
}

/** The tip is not drawn because two readings of the row DISAGREE. */
const CONTRADICTED_TIP = (why: string): ToolMarkerTip => ({
  kind: 'none',
  heightMm: 0,
  refusal: `no tip is drawn — ${why}. The solid ends open, inside a dashed ring`,
  says: null,
});

/**
 * The shared tip, put into this view's terms — and then cross-checked.
 *
 * `tip` comes from `toolShape.tsx`'s `resolveToolTip()` **at the true radius**,
 * so every length in it is scaled here by {@link TOOL_FACET_SCALE} onto the
 * oversize envelope this marker draws. Scaling the height as well as the radius
 * is what keeps a cone at the row's REAL half-angle: scale one and not the
 * other and the drawn V is a different tool.
 *
 * `listRefusesTip` is the same reading's verdict and `is_angular` is the CORE's
 * (`ToolCategory::is_angular()` — exactly VBit, Chamfer, Countersink and
 * Engraving). Both are used to take a tip AWAY, never to add one: a
 * disagreement between the readings means somebody is wrong about the shape of
 * a cutter, and the safe answer to that is to draw no tip and say so.
 */
function markerTip(tool: ToolRow, tip: ToolTip, listRefusesTip: boolean): ToolMarkerTip {
  const k = toolCategoryKey(tool.category);
  const marker: ToolMarkerTip = {
    kind: tip.kind,
    heightMm: tip.heightMm * TOOL_FACET_SCALE,
    says: tip.says,
    // The missing NOUN is shared; the sentence is not. This picture refuses by
    // leaving the solid OPEN inside a dashed ring, which is not what the 2D
    // drawing does, and a refusal that describes the wrong picture is a refusal
    // nobody can act on.
    refusal:
      tip.missing === null
        ? null
        : `${tip.missing} is not stated, so no tip is drawn — the solid ends open, inside a dashed ring`,
  };

  // The three cross-checks. Each can only remove a tip.
  //
  // ⚠ This first one is now STRUCTURALLY unreachable: `tip` IS the tool list's
  // reading, so `listRefusesTip` is true exactly when `tip.kind === 'none'`. It
  // is kept as a tripwire on that invariant — if a local tip path is ever
  // reintroduced here, this is what fires — and NOT as the thing that makes the
  // two views agree. What makes them agree is that there is one reader.
  if (listRefusesTip && marker.kind !== 'none') {
    return CONTRADICTED_TIP(
      'the tool list refuses to draw a tip for this row, and the two views may not disagree about the shape of a cutter'
    );
  }
  if (tool.is_angular === true && marker.kind !== 'cone') {
    return CONTRADICTED_TIP(
      `the core marks this tool ANGULAR (\`is_angular\`) while its category resolved to a ${marker.kind} end, so the row contradicts itself`
    );
  }
  if (tool.is_angular === false && marker.kind === 'cone' && k !== 'drill') {
    return CONTRADICTED_TIP(
      'the core does NOT mark this tool angular, and the only cone on a non-angular tool is a drill point'
    );
  }
  return marker;
}

/**
 * A torn ring — the 3D form of the zig-zag `toolShape.tsx` draws for
 * "shortened, NOT shown to length". It goes on every end whose length the
 * record does not hold, which is every shank and any flute with no cutting
 * length. Returns the height it ended at.
 */
function tearEnd(pts: [number, number][], r: number, y: number): number {
  const h = Math.max(r * 0.45, 0.4);
  pts.push([r * 1.2, y + h * 0.25]);
  pts.push([r * 0.8, y + h * 0.5]);
  pts.push([r * 1.2, y + h * 0.75]);
  pts.push([r * 0.8, y + h]);
  return y + h;
}

function refusedMarker(why: string, notDrawn: string[] = []): ToolMarkerShape {
  return {
    refused: why,
    cutting: [],
    shank: null,
    openTipRadiusMm: null,
    drawn: [],
    notDrawn,
    summary: 'no cutter drawn — a dashed cage at a placeholder size',
  };
}

/**
 * The marker, read off the tool row. Pure, and exported so the reading can be
 * exercised without standing up a scene: the arithmetic — a cone's height from
 * its half angle, the facet scale — is the part that can be silently wrong.
 *
 * `undefined` (not told), `null` (no tool) and "a row with no diameter" are
 * three different facts and all three produce the same refusal SHAPE with a
 * different sentence, because the picture cannot carry that distinction and the
 * words must.
 */
export function toolMarkerShape(tool: ToolRow | null | undefined): ToolMarkerShape {
  if (tool === undefined) {
    return refusedMarker(
      'this viewport was not handed a tool — `App` holds the selection, and being told nothing is not the same fact as there being no tool'
    );
  }
  if (tool === null) return refusedMarker('no tool is selected for this program');

  // The WORDS and the FIELDS both come from the tool list's own reader, so the
  // two views cannot describe the same row differently. `fields.tip` is
  // resolved at the TRUE radius; `markerTip` scales it onto this view's
  // oversize envelope.
  const reading = describeToolShape(tool);
  const fields = readToolShape(tool);
  const dia = fields.diaMm;
  if (dia === null) {
    return refusedMarker(
      'this tool states no diameter — a marker drawn at a size nobody stated is a measurement nobody took, and this marker is what a clearance is judged by eye against',
      reading.notDrawn
    );
  }

  // 🔴 Read off the shared TIP, not sniffed out of the shared reader's prose.
  // This used to search `notDrawn` for the substring "the tip is NOT drawn",
  // which made a sentence in another file load-bearing — reword it and this
  // silently flips to "the list drew a tip", which is the direction that ADDS a
  // claim to the picture.
  const listRefusesTip = fields.tip.missing !== null;
  const r = (dia / 2) * TOOL_FACET_SCALE;
  const tip = markerTip(tool, fields.tip, listRefusesTip);

  const cutting: [number, number][] = [];
  if (tip.kind === 'flat') {
    cutting.push([0, 0], [r, 0]);
  } else if (tip.kind === 'cone') {
    cutting.push([0, 0], [r, tip.heightMm]);
  } else if (tip.kind === 'ball') {
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / steps);
      cutting.push([r * Math.cos(a), r + r * Math.sin(a)]);
    }
  } else {
    // No cap. The solid ends OPEN and a dashed ring is drawn round the opening,
    // which is this view's form of the 2D drawing's dashed bottom edge.
    cutting.push([r, 0]);
  }

  // Cutting length INCLUDES the tip, the same reading the tool list takes.
  const fluteStated = fields.fluteMm;
  const fluteLen =
    fluteStated !== null
      ? Math.max(fluteStated - tip.heightMm, 0.5)
      : toolUnstatedFluteMm(dia);
  const fluteTopY = tip.heightMm + fluteLen;
  cutting.push([r, fluteTopY]);

  const shankStated = fields.shankMm;
  // The flute's own end is torn when its length is unstated, and also when
  // nothing is drawn above it — in both cases the tool carries on past where
  // this picture stops and the picture has to say so.
  let cuttingTopY = fluteTopY;
  if (fluteStated === null || shankStated === null) cuttingTopY = tearEnd(cutting, r, fluteTopY);
  cutting.push([0, cuttingTopY]);

  let shank: [number, number][] | null = null;
  if (shankStated !== null) {
    const rs = (shankStated / 2) * TOOL_FACET_SCALE;
    // Starts where the CUTTING solid actually ended — `cuttingTopY`, not
    // `fluteTopY`. A flute of unstated length ends in a torn ring above
    // `fluteTopY`, and a shank based on the plain figure would grow up through
    // its own break.
    const base = cuttingTopY;
    shank = [
      [0, base],
      [rs, base],
      [rs, base + TOOL_SHANK_DISPLAY_MM],
    ];
    const top = tearEnd(shank, rs, base + TOOL_SHANK_DISPLAY_MM);
    shank.push([0, top]);
  }

  const drawn: string[] = [`Ø${dia} mm to scale`];
  if (tip.says) drawn.push(tip.says);
  if (fluteStated !== null) drawn.push(`${fluteStated} mm cutting length`);
  if (shankStated !== null) {
    const step =
      Math.abs(shankStated - dia) < 0.05
        ? 'same as the cutter'
        : shankStated > dia
          ? 'steps DOWN to the cutter'
          : 'steps UP to the cutter';
    drawn.push(`${shankStated} mm shank, ${step}`);
  }

  // The tool list's refusals ARE this marker's refusals — both views read the
  // same fields — plus anything only this view can refuse.
  const notDrawn = [...reading.notDrawn];
  // Only when the tool list has not already said it — the two views refuse the
  // same tip for the same reason and the sentence must not appear twice.
  if (tip.refusal && !listRefusesTip) notDrawn.push(tip.refusal);
  notDrawn.push(
    'flute count and helix are not in this marker at all — it is the cutter’s swept ENVELOPE, which is what a clearance question needs; the tool list draws the flutes'
  );

  return {
    refused: null,
    cutting,
    shank,
    openTipRadiusMm: tip.kind === 'none' ? r : null,
    drawn,
    notDrawn,
    summary: drawn.join(' · '),
  };
}

/**
 * 🔴 GATE INSTRUMENT — the marker's reading, reachable from the page.
 *
 * {@link toolMarkerShape} was exported "so it can be exercised" and then nothing
 * exercised it: two agents proved it with throwaway probe scripts, pasted the
 * output into their commit bodies and deleted the scripts, which leaves the
 * evidence in the git log and a check nowhere. This is the seam that ends that
 * — and it deliberately publishes the function the BROWSER BUNDLE holds rather
 * than letting a test import the source into node, because a check that
 * exercises a different build than the product ships is not a check (gate K3's
 * whole reason for existing).
 *
 * Behind the same `?fixtures=1` / `?plants=1` flag as the fixture jobs and the
 * plants, so it is off the operator surface. It is a PURE reading — it touches
 * no state, draws nothing and cannot move a machine — but an instrument on the
 * default page is an instrument somebody eventually mistakes for an API.
 */
if (
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).has('fixtures') ||
    new URLSearchParams(window.location.search).has('plants'))
) {
  (window as unknown as Record<string, unknown>).__toolMarkerShape = toolMarkerShape;
}

/**
 * How one hover ROW is coloured — and there are three, not two.
 *
 * 🔴 `'pending'` IS NOT A QUIETER `ok`. It is `--muted`, the colour this app
 * already uses for *"a fact it does not have"*, and `styles.css`'s `.pending`
 * rule carries the argument in full: *a check that cannot run reports PENDING,
 * never PASS*. It exists so `0` cells past a board of unknown thickness cannot
 * be painted the same as `0` cells past a board that was measured.
 *
 * ⚠ `'warn'` maps to `--warn` and `'bad'` to `--bad` — the same two tokens the
 * panels use, resolved here as CSS variables rather than re-picked as colours.
 */
export type HoverTone = 'bad' | 'warn' | 'pending';

/** What the hover panel is allowed to say about one object. `rows` are FACTS
 *  the viewport already holds; `note` is where a limit of the data is stated
 *  rather than papered over. The optional third element of a row is its TONE —
 *  omitted means the panel's ordinary ink. */
interface HoverInfo {
  title: string;
  rows: [string, string, HoverTone?][];
  note?: string;
}

// ---------------------------------------------------------------------------
// Snap — TODO #32
// ---------------------------------------------------------------------------
//
// 🔴 SNAP CHANGES THE DATUM, AND THE DATUM IS THE PROGRAM. Everything below
// therefore obeys one rule: whatever this file decides, it hands the SNAPPED
// number to the same callback the numeric fields are bound to. There is no
// display rounding anywhere in here — a field showing a tidy 50 over a stored
// 47.3 would be a measurement nobody took, printed as if someone had.
//
// And a snap is not an authority. The value goes on to `App`, which re-plans,
// and the core's travel and fixture checks run over it exactly as before. A
// snap that puts the sheet off the table or into a clamp is REFUSED downstream
// and the refusal wins. Nothing here clamps a value to keep it legal — that
// would hide the refusal rather than earn it.

/** Offered grid steps, mm. Off is the absence of a step, not a fourth button. */
const GRID_STEPS = [1, 5, 10] as const;

/**
 * How close a drag has to come before an edge target takes it, mm.
 *
 * Fixed in MILLIMETRES rather than pixels on purpose: the number it produces is
 * a datum, so the distance at which one is chosen has to be a fact about the
 * bed and not about the zoom. The cost is that it feels sticky zoomed out; the
 * alternative is a datum that depends on where the camera happened to be.
 */
const EDGE_SNAP_MM = 5;

/** A footprint the snap machinery reasons about, in bed coordinates. */
interface Neighbour {
  label: string;
  /**
   * 🔴 WHICH RULE OWNS THE SPACE BETWEEN THIS NEIGHBOUR AND THE THING BEING
   * DRAGGED. **It is a property of the PAIR, not of the object.** The sheet is
   * material and a clamp is steel, but the space between them is the FIXTURE
   * check's question (gate P7, toolpath versus clamp) — and a clamp overlapping
   * the board is not a fault at all, it is how the board is held down.
   *
   * `clearance` — part against part, both of them cut. `core/src/layout.rs`
   *               owns it: the cutter has to fit down the channel or it takes
   *               the edge off both.
   * `other`     — every pair this viewport can make today. No clearance band is
   *               drawn, because a band there would fire on every correct
   *               setup, and a false red lies exactly like a false green.
   *
   * Either way the CONTACT snap is withheld — see `snapAxis`.
   */
  kind: 'clearance' | 'other';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface SnapConfig {
  /** 0 = off. */
  grid: number;
  edges: boolean;
  /** The core's `Clearance::required_mm()`, or `null` when none was declared. */
  required: number | null;
  /** Travel envelope, mm — the machine's own two edges.
   *
   * ⚠ This field was called `bed` until 2026-08-10. It has only ever held
   * `props.travel`, and the snap candidates it feeds are labelled "travel
   * limit" — so the name was the one thing in the chain that said SURFACE. */
  travel: [number, number];
}

interface AxisSnap {
  /** Where the dragged footprint's MIN corner ends up on this axis. */
  value: number;
  /** The world line it settled against, for the guide. */
  line: number;
  label: string;
}

/** Round to 0.1mm, biased AWAY from a neighbour so a clearance snap cannot be
 *  rounded back inside the band it was chosen to respect. */
function q1(v: number, bias: number): number {
  if (bias < 0) return Math.floor(v * 10) / 10;
  if (bias > 0) return Math.ceil(v * 10) / 10;
  return Math.round(v * 10) / 10;
}

/**
 * The edge snap, one axis at a time. Returns `null` when nothing is near enough.
 *
 * 🔴 THE CANDIDATE THAT IS DELIBERATELY MISSING IS THE POINT OF THIS FUNCTION.
 * For every neighbour it offers the two SAME-SIDE alignments (min to min, max
 * to max) — registration, which is what nesting a row is actually done with —
 * and, for a `material` neighbour with a declared clearance, the two positions
 * that leave exactly that clearance. It never offers `min → neighbour max` or
 * `max → neighbour min`: those are CONTACT, and putting two footprints flush is
 * the single most natural gesture a snap invites and the one that produces a
 * job the machine cannot run. There is no flag to turn it back on.
 */
function snapAxis(
  raw: number,
  size: number,
  axis: 'x' | 'y',
  cfg: SnapConfig,
  neighbours: Neighbour[]
): AxisSnap | null {
  const lo = (n: Neighbour) => (axis === 'x' ? n.x0 : n.y0);
  const hi = (n: Neighbour) => (axis === 'x' ? n.x1 : n.y1);
  const travel = axis === 'x' ? cfg.travel[0] : cfg.travel[1];

  const cands: { p: number; line: number; label: string; bias: number }[] = [];
  // The machine's own lines. These are not material, so landing ON them is the
  // correct answer — a datum on the machine origin is the placement every
  // coordinate in the program is measured from.
  cands.push({ p: 0, line: 0, label: 'machine origin', bias: 0 });
  cands.push({ p: -size, line: 0, label: 'machine origin (far edge)', bias: 0 });
  cands.push({ p: travel, line: travel, label: 'travel limit', bias: 0 });
  cands.push({ p: travel - size, line: travel, label: 'travel limit (far edge)', bias: 0 });

  for (const n of neighbours) {
    cands.push({ p: lo(n), line: lo(n), label: `${n.label} — near edges aligned`, bias: 0 });
    cands.push({ p: hi(n) - size, line: hi(n), label: `${n.label} — far edges aligned`, bias: 0 });
    if (n.kind === 'clearance' && cfg.required !== null) {
      cands.push({
        p: lo(n) - cfg.required - size,
        line: lo(n),
        label: `${n.label} — ${cfg.required.toFixed(1)}mm clearance`,
        bias: -1,
      });
      cands.push({
        p: hi(n) + cfg.required,
        line: hi(n),
        label: `${n.label} — ${cfg.required.toFixed(1)}mm clearance`,
        bias: +1,
      });
    }
  }

  let best: { p: number; line: number; label: string; bias: number } | null = null;
  for (const c of cands) {
    if (Math.abs(c.p - raw) > EDGE_SNAP_MM) continue;
    if (!best || Math.abs(c.p - raw) < Math.abs(best.p - raw)) best = c;
  }
  return best ? { value: q1(best.p, best.bias), line: best.line, label: best.label } : null;
}

/** Clear distance between two axis-aligned footprints, mm. */
function clearGap(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: Neighbour
): { gap: number; overlap: boolean } {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1);
  const dy = Math.max(b.y0 - a.y1, a.y0 - b.y1);
  if (dx < 0 && dy < 0) return { gap: 0, overlap: true };
  return { gap: Math.hypot(Math.max(dx, 0), Math.max(dy, 0)), overlap: false };
}

interface SnapOutcome {
  /** The snapped MIN corner. This is the number that goes to the callback. */
  x: number;
  y: number;
  /** What moved it, in the user's words. Empty when nothing did. */
  why: string[];
  /** World lines to draw a guide along, or `null`. */
  guideX: number | null;
  guideY: number | null;
  /** The worst clearance finding against a `material` neighbour, if any. */
  tooClose: { label: string; gap: number; required: number; overlap: boolean } | null;
}

/**
 * One drag step, snapped.
 *
 * Order is grid FIRST, then edges, and an edge target overrides the grid where
 * both apply — an edge is a specific thing the user aimed at, a grid line is a
 * default. Both are reported, so a datum that ended up somewhere unexpected can
 * be traced to the control that put it there.
 */
function snapPlacement(
  raw: [number, number],
  size: [number, number],
  cfg: SnapConfig,
  neighbours: Neighbour[]
): SnapOutcome {
  const why: string[] = [];
  // Rounded to 0.1mm as the drag always was: a datum carrying 14 decimal places
  // of mouse noise reads as a measurement nobody took, and it lands in the
  // G-code as a work offset.
  let x = q1(raw[0], 0);
  let y = q1(raw[1], 0);

  if (cfg.grid > 0) {
    x = Math.round(raw[0] / cfg.grid) * cfg.grid;
    y = Math.round(raw[1] / cfg.grid) * cfg.grid;
    // A multiple of 1/5/10 is already exact at 0.1mm; the round is here so the
    // value cannot carry a float artefact into a work offset.
    x = q1(x, 0);
    y = q1(y, 0);
    why.push(`${cfg.grid}mm grid`);
  }

  let guideX: number | null = null;
  let guideY: number | null = null;
  if (cfg.edges) {
    const sx = snapAxis(raw[0], size[0], 'x', cfg, neighbours);
    if (sx) {
      x = sx.value;
      guideX = sx.line;
      why.push(`X to ${sx.label}`);
    }
    const sy = snapAxis(raw[1], size[1], 'y', cfg, neighbours);
    if (sy) {
      y = sy.value;
      guideY = sy.line;
      why.push(`Y to ${sy.label}`);
    }
  }

  // 🔴 Measured AFTER the snap, on where the thing actually ended up — not on
  // where the pointer was. The whole failure this guards is a snap that moved a
  // part into a position the drag itself never visited.
  let tooClose: SnapOutcome['tooClose'] = null;
  if (cfg.required !== null) {
    const rect = { x0: x, y0: y, x1: x + size[0], y1: y + size[1] };
    for (const n of neighbours) {
      if (n.kind !== 'clearance') continue;
      const { gap, overlap } = clearGap(rect, n);
      if (!overlap && gap >= cfg.required) continue;
      if (tooClose && !overlap && (tooClose.overlap || tooClose.gap <= gap)) continue;
      tooClose = { label: n.label, gap, required: cfg.required, overlap };
    }
  }

  return { x, y, why, guideX, guideY, tooClose };
}

/**
 * What the viewport is allowed to say about the minimum gap, and why.
 *
 * 🔴 THE FIRST HALF OF THIS WENT STALE AND IS CORRECTED — 2026-08-09. It used
 * to read *"the core's answer does not cross the wasm boundary … grepping the
 * web and wasm trees for `Clearance` / `Interference` / `layout` returns no
 * binding at all"*. **That was measured and true when it was written and it is
 * false now.** Re-measured at the artefacts:
 *
 *     wasm/src/lib.rs:453   pub fn clearance_for(cutter_diameter_mm, margin_mm)
 *     wasm/src/lib.rs:491   pub fn check_layout(drawings_json, …)
 *     web/src/cam.ts:897    export async function clearanceFor(…)
 *     web/src/cam.ts:935    export async function checkLayout(…)  -> Interference[]
 *
 * So BOTH the number and the OVERLAP-vs-TOO-CLOSE verdict now cross the
 * boundary. A stale RED lies exactly like a stale green, and it is the harder
 * one to find because nobody re-reads a row that already admits it is blocked.
 *
 * What is STILL blocking, and it is a different fact with a different owner:
 *
 *  1. **Nobody passes `clearance` to this viewport.** `App.tsx` renders
 *     `<Viewport …>` with no `clearance` prop (measured 2026-08-09), so the
 *     prop is `undefined` — a CALLER-WIRING fact, not a missing export. The two
 *     are not interchangeable: one is work in this lane's own UI, the other
 *     would have been work in the core.
 *  2. **This viewport holds no pair the rule governs.** It is handed one sheet
 *     and the clamps. Clamp-versus-sheet is the fixture question, not the
 *     clearance one, and a clamp overlapping the board is how the board is
 *     held down — a band drawn there would fire on every correct setup.
 *
 * So the affordance says which of the two it is waiting on rather than drawing
 * a band from a rule this file made up. What IS live meanwhile is the stronger
 * half of the same defence: `snapAxis` has no contact candidate, so no gesture
 * in this viewport can place two declared footprints flush.
 */
function gapStatus(
  clearance: ViewportProps['clearance'],
  materialNeighbours: number
): { required: number | null; text: string; warn: boolean } {
  if (!clearance) {
    return {
      required: null,
      text:
        'minimum gap — no clearance passed to this viewport: the core computes it (layout.rs `Clearance::required_mm()` = cutter + margin) and DOES export it (`clearance_for`, bound as `clearanceFor`), but no caller hands one in, so there is no number to draw at. Snapping two footprints flush is refused regardless — the edge snap has no contact target.',
      warn: false,
    };
  }
  if (materialNeighbours === 0) {
    return {
      required: clearance.required_mm,
      text: `minimum gap ${clearance.required_mm.toFixed(1)}mm (${clearance.cutter_diameter_mm.toFixed(1)}mm cutter + ${clearance.margin_mm.toFixed(1)}mm margin) — nothing on this workpiece to measure it against: the rule governs part-to-part material and there is one part. Clamps are the fixture check's, not this one's.`,
      warn: false,
    };
  }
  return {
    required: clearance.required_mm,
    text: `minimum gap ${clearance.required_mm.toFixed(1)}mm (${clearance.cutter_diameter_mm.toFixed(1)}mm cutter + ${clearance.margin_mm.toFixed(1)}mm margin), measured here between bounding footprints while you drag. The verdict is the core's — it measures the real boundaries, arcs included.`,
    warn: true,
  };
}

/* ═══ THE SCENE REBUILDS ON A CHANGE, NOT ON A RENDER ════════════════════════
 *
 * 🔴 UNTIL 2026-08-11 IT REBUILT ON EVERY `App` RENDER. The scene effect below
 * disposes every geometry and material it built and builds all of them again —
 * so "one render of the parent" and "one full teardown of the picture" were the
 * same event. A slider drag, a keystroke in an unrelated field, a hover that
 * set state: each one threw away the toolpath, the walls, the loaded solid and
 * the height map and rebuilt them.
 *
 * 🔴 AND THE CAUSE IS NOT IN THE EFFECT — IT IS IN THE SHAPE OF WHAT IT IS
 * HANDED. `App.tsx` builds its `LayerScene` as a fresh object literal on every
 * render, so several dependencies arrive as NEW IDENTITIES CARRYING IDENTICAL
 * VALUES:
 *
 *     travel        [report.travel[0], report.travel[1]]    a new array, always
 *     stockOrigin   [originX, originY]                      a new array, always
 *     touchPlate    { enabled, x, y, thickness_mm }         a new object, always
 *     stock         report?.stock ?? [x, y, t]              new while no report
 *     moves         report?.render ?? []                    new while no report
 *     onStockMove   (x, y) => { … }                         a new arrow, always
 *     onClampMove   (i, x, y) => { … }                      a new arrow, always
 *
 * React compares dependencies with `Object.is`, so every one of those is a
 * change. Five props keyed by identity and two inline handlers were enough to
 * make the dependency array a no-op.
 *
 * 🔴 THE FIX IS ON THIS SIDE ON PURPOSE, and that is not a boundary dodge.
 * `App` could memoise all seven — and that repair would sit one JSX edit away
 * from being lost again by anyone who inlines a handler or unwraps a `useMemo`,
 * with nothing to say it had gone. A memoised caller is a performance property
 * held by a habit in a file that has no reason to remember it. Keying by VALUE
 * here holds it structurally: a caller may hand this component fresh literals
 * every render — which is what React callers normally do — and the picture is
 * rebuilt when the NUMBERS change.
 *
 * ⚠ IT IS A REAL BEHAVIOUR CHANGE AND HERE IS ITS COST, stated rather than
 * discovered: anything that was picking up a mutation BECAUSE the scene was
 * rebuilt anyway now stops picking it up. Two were found and both are handled
 * in this change:
 *
 *   1. `props.loadedMesh` builds geometry inside the effect and was NOT in the
 *      dependency list. The churn hid it — every render rebuilt, so the mesh
 *      was always current. It is now listed (see {@link sceneDeps}).
 *   2. The three drag callbacks were published to `state.current` from inside
 *      the effect. They are display-independent — no geometry reads them — so
 *      they are out of the dependency list and are published on EVERY render in
 *      the component body instead, next to `paused` and `visRef`, which already
 *      work exactly this way. A callback the pointer handlers reach one render
 *      late is the defect this would otherwise introduce.
 *
 * ⚠ WHAT IS NOT COVERED, because no key can cover it: a caller that MUTATES one
 * of these arrays IN PLACE rather than replacing it. See {@link numsKey} and
 * {@link movesKey} for which half of that is caught and which is not.
 */

/** The key for a value that is absent. It contains a character no number and no
 *  boolean can produce, so it cannot be confused with a real key. */
const KEY_ABSENT = '\u0000absent';

/**
 * A dependency key for a tuple of numbers — `travel`, `stock`, `stockOrigin`.
 *
 * 🔴 WHY IT CANNOT COLLIDE. `Array.prototype.join` separates with `,`, and no
 * `Number.prototype.toString()` output contains a comma — not `1e21`, not
 * `-1.5`, not `Infinity`, not `NaN`. The comma therefore appears only where the
 * separator put it, so the string can be split back into exactly the numbers it
 * was built from: the mapping is injective, at this arity and at any other.
 * `[1,23]` gives `"1,23"` and `[12,3]` gives `"12,3"` — different strings for
 * different tuples, which is the whole requirement.
 *
 * ⚠ TWO EXACT EQUIVALENCES, both deliberate and neither a collision in the
 * sense that matters:
 *   · `-0` and `0` share a key. They are the same coordinate on this machine and
 *     every consumer below (`position.set`, the placement arithmetic, the
 *     probes) treats them identically. React's own `Object.is` would call them
 *     DIFFERENT and rebuild the scene for a sign nobody can see.
 *   · `NaN` and `NaN` share a key, which is what `Object.is` does too.
 *
 * ✅ IT CATCHES AN IN-PLACE MUTATION, and the identity key it replaces did not.
 * `travel[0] = 9` leaves the array identity untouched — invisible to `Object.is`
 * for ever — and changes this key immediately, because the key reads the values.
 * On these tuples the value key is strictly the more sensitive of the two.
 */
export function numsKey(v: readonly number[] | null | undefined): string {
  return v ? v.join(',') : KEY_ABSENT;
}

/**
 * A dependency key for the touch plate.
 *
 * 🔴 IT READS ALL FOUR FIELDS — the same four the scene reads (`enabled` gates
 * the object, `x`/`y` place it, `thickness_mm` sizes it and decides the
 * OUTLINE-versus-SOLID split that says whether anybody stated where the plate
 * is). A key over a subset would be a picture that could disagree with the
 * declaration about a thing a cutter can hit.
 *
 * 🔴 WHY IT CANNOT COLLIDE: `|` cannot appear in a number's string form or in
 * `0`/`1`, so it appears only where this template put it — the same argument as
 * {@link numsKey}, with an explicit separator instead of `join`'s.
 */
export function touchPlateKey(tp: ViewportProps['touchPlate']): string {
  return tp ? `${tp.enabled ? 1 : 0}|${tp.x}|${tp.y}|${tp.thickness_mm}` : KEY_ABSENT;
}

/** The one array every empty move list is keyed by. Module scope, so two
 *  different empty arrays from two different renders map to one identity. */
const NO_MOVES: RenderMove[] = [];

/**
 * The dependency key for the toolpath — **the identity, with only the EMPTY
 * case collapsed.**
 *
 * 🔴 THIS IS THE ONE DEPENDENCY WHERE A VALUE KEY WOULD BE THE WRONG ANSWER.
 * `moves` is `Report.render` and can be tens of thousands of points, so
 * stringifying it — or checksumming it — would run over the whole toolpath on
 * every render, which is trading a rebuild for a scan and calling it a fix. And
 * it would buy nothing, because a summary of n points into one number is not
 * injective: two different programs can share a checksum, and a key that misses
 * a change is worse than the churn being removed.
 *
 * ⇒ So the toolpath keeps the identity dependency it already had. `App` hands
 * this prop through as `report?.render ?? []`, so its identity is STABLE for as
 * long as a report is: the only churn it produces is the `?? []` fallback taken
 * while there is no report at all, and **every empty array has exactly one
 * possible value.** Collapsing empties onto one array is therefore exact, not a
 * summary — there is nothing about an empty toolpath for a key to lose.
 *
 * ⚠ WHAT THIS INHERITS: an identity key catches every REPLACEMENT and misses an
 * in-place mutation (`moves.push(…)`, `moves[3].x = …`) for ever. That is
 * exactly what this dependency did before this change, so nothing was traded
 * away here — but it is the one prop where the caveat is real, and it is why
 * `moves` must keep arriving as a NEW ARRAY from a new plan rather than being
 * edited where it lies.
 */
export function movesKey(moves: RenderMove[]): unknown {
  return moves.length === 0 ? NO_MOVES : moves;
}

/**
 * The names of {@link sceneDeps}' entries, in order — for tests, and for a
 * failure message that can say WHICH dependency moved rather than an index.
 */
export const SCENE_DEP_NAMES = [
  'stock',
  'clamps',
  'moves',
  'travel',
  'progress',
  'dark',
  'stockOrigin',
  'stockRotationDeg',
  'drawingPlacement',
  'partInstances',
  'selectedInstance',
  'stockMaterial',
  'tool',
  'stockSurface',
  'loadedMesh',
  'drawing',
  'cutDepthMm',
  'clearance',
  'touchPlate',
  'spoilboard',
  'spoilboardBareReach',
  'boardDepth',
  'spoilboardPositionAssumed',
  'travelZMm',
  'zDatum',
  'otherWorkpieces',
] as const;

/**
 * **Everything a scene rebuild is a function of**, as the array React compares.
 *
 * 🔴 IT IS A FUNCTION AND NOT AN INLINE LITERAL SO THAT IT CAN BE MEASURED. The
 * question "does this render rebuild the scene?" is decided entirely by this
 * array and `Object.is`; with the list inline there is no way to ask it without
 * a GPU, a browser and a frame to watch. `tests/viewport-rebuild.test.ts` runs
 * sequences of prop snapshots through this function and counts the rebuilds.
 *
 * ⚠ Its LENGTH must not vary between renders — React warns and falls back to
 * rebuilding every time. Every branch here is inside a key function, and every
 * key function returns exactly one value.
 */
export function sceneDeps(p: ViewportProps): readonly unknown[] {
  return [
    numsKey(p.stock),
    p.clamps,
    movesKey(p.moves),
    numsKey(p.travel),
    p.progress,
    // 🔴 `props.showRapids` is NOT here, and that is the point of the
    // rebuild-free design: rapids are always BUILT, and hidden by `applyVis`.
    // A display toggle that rebuilt the scene would make "what is on screen"
    // and "what the program contains" the same code path again.
    p.dark,
    numsKey(p.stockOrigin),
    p.stockRotationDeg,
    /* 🔴 `onClampMove`, `onStockMove` and `onPartMoveAt` ARE NOT HERE. They are
     * inline arrows at the call site, so they change identity on every render —
     * and no geometry reads them: they are published to `state.current` for the
     * pointer handlers and nothing else. They are now published from the
     * component body on every render, which is both cheaper and MORE correct
     * than a dependency entry — a handler that closes over newer state reaches
     * the drag on the render it was created in, not on the next rebuild. */
    // The placement is scene GEOMETRY — every drawing-frame object's matrix is
    // built from it — so a datum, a turn or a drag has to rebuild the scene.
    // Omitting it would leave the walls and the solid at the last placement
    // while the sheet and the toolpath moved: the exact mismatch this prop was
    // added to remove, reintroduced through a dependency list.
    p.drawingPlacement,
    // The placements are read by the drag and the instance keys are baked into
    // the scene objects, so both have to rebuild when either moves. ⚠ `App`
    // MEMOISES this array — a fresh literal here rebuilds the scene on every
    // render, which is the identity churn the two scalars it replaced were split
    // apart to avoid.
    p.partInstances,
    p.selectedInstance,
    p.stockMaterial,
    p.tool,
    // The surface is scene GEOMETRY, so it rebuilds. The clearance is not — it
    // only sizes the snap candidates — but it is listed because the guides and
    // the gap findings are built here too, and a snap reading one clearance
    // while the status line reports another is the disagreement this whole file
    // is arranged to prevent.
    p.stockSurface,
    /* 🔴 ADDED 2026-08-11, AND IT WAS MISSING BEFORE. The loaded solid is built
     * inside the effect from `props.loadedMesh` — geometry, a decimation note
     * and the hover facts — and this prop was in NO dependency list. It worked
     * only because every render rebuilt everything, so an omission behaved like
     * a declaration. The moment the scene stops rebuilding on identity churn,
     * an unlisted prop is a solid frozen at the last plan while the panel
     * describes the new one. Fixing the churn without listing this would have
     * traded a performance defect for a correctness one. */
    p.loadedMesh,
    // The drawing is scene GEOMETRY, so it rebuilds. `cutDepthMm` is listed with
    // it because it is not a label — it is the EXTRUSION HEIGHT, so a change to
    // it is a change to the geometry, and a viewport that re-rendered the note
    // without rebuilding the walls would say 6mm under an 18mm wall.
    p.drawing,
    p.cutDepthMm,
    p.clearance,
    touchPlateKey(p.touchPlate),
    /* 🔴 THE BOARD IS SCENE GEOMETRY, so it rebuilds. A prop that reaches the
     * draw call but not this list is a picture frozen at the last board while
     * the check runs against the new one — the look-right / checked-wrong shape
     * gate P7R exists for, arriving through a dependency array. The strips are
     * listed with it because they are drawn from the same declaration and a
     * board that moved without them would show material where the report says
     * there is none. */
    p.spoilboard,
    p.spoilboardBareReach,
    /* Same rule, three more props, and the first two are the reason it is worth
     * restating: the board's DEPTH decides whether a box or a plane is built,
     * and the depth VERDICT decides what colour it is painted. A verdict that
     * reached the render but not this list would leave a board still painted
     * clear after the report said the cutter went through it — a picture frozen
     * one plan behind the check, in the one place that says whether the cutter
     * reached the machine.
     *
     * ⚠ `spoilboard` already carries `thickness_mm`, so the slab itself needs no
     * new entry — but `boardDepth`, the corner's PROVENANCE and the Z limit all
     * reach `hoverData`, which is rebuilt in the effect and nowhere else. */
    p.boardDepth,
    p.spoilboardPositionAssumed,
    p.travelZMm,
    /* 🔴 THE DATUM IS SCENE GEOMETRY. It is the triad's Z root (`axesRootZMm`),
     * so a declaration that reached the render but not this list would leave the
     * arrows at the last datum while every Z word in the program moved by a
     * workpiece thickness — an instrument whose only job is to say which frame
     * you are in, frozen one declaration behind the program. `stock` is already
     * listed and carries the thickness the root is computed from. */
    p.zDatum,
    // Other workpieces are scene GEOMETRY (ghost outlines), so they rebuild.
    p.otherWorkpieces,
  ];
}

export function Viewport(props: ViewportProps) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    projection?: Projection;
    frame?: number;
    paused?: boolean;
    dispose: (() => void)[];
    // ── Imperative state published from the render loop ──────────────
    partDrag: ((instance: string, x: number, y: number) => void) | null;
    stockDrag: ((x: number, y: number) => void) | null;
    clampDrag: ((index: number, x: number, y: number) => void) | null;
    snapCfg: SnapConfig | null;
    setSnapNote: ((note: { text: string; warn: boolean }) => void) | null;
    applySnapGuides: (() => void) | null;
    snap: { x: number; y: number } | null;
    key: THREE.DirectionalLight | null;
    token: ((expr: string) => THREE.Color) | null;
    accent: THREE.Color | null;
    bedZ: number;
    clamps: import('./cam').ClampCfg[];
    drawingToBed: THREE.Matrix4 | null;
    partOffsets: Map<string, [number, number]>;
    selectedInstance: string | null;
    stockExtent: [number, number];
    stockOrigin: [number, number];
    stockCentre: [number, number];
    stockRotationDeg: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshInfo: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    surfaceInfo: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallInfo: any;
    toolWorld: THREE.Vector3 | null;
    hoverMark: THREE.Mesh | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hoverData: any;
    applyVis: (() => void) | null;
    applyPalette: (() => void) | null;
    frameScene: ((sx: number, sy: number) => void) | null;
    resetHover: (() => void) | null;
    repick: (() => void) | null;
  }>({
    dispose: [],
    partDrag: null, stockDrag: null, clampDrag: null,
    snapCfg: null, setSnapNote: null, applySnapGuides: null, snap: null,
    key: null, token: null, accent: null, bedZ: 0,
    clamps: [], drawingToBed: null, partOffsets: new Map(),
    selectedInstance: null, stockExtent: [0, 0], stockOrigin: [0, 0],
    stockCentre: [0, 0], stockRotationDeg: 0,
    meshInfo: null, surfaceInfo: null, wallInfo: null,
    toolWorld: null, hoverMark: null, hoverData: null,
    applyVis: null, applyPalette: null, frameScene: null,
    resetHover: null, repick: null,
  });

  /* 🔴 THE LOOP READS THIS REF, NOT THE PROP. The scene effect runs once with
   * `[]`, so the `tick` closure captures the value `paused` had at mount and
   * would never see it change. Writing it into the ref on every render is what
   * makes the pause arrive; a `paused` in the effect's dependency list would
   * tear down and rebuild the whole renderer instead. */
  state.current.paused = props.paused === true;
  /* Same idiom, same reason — published on every render so the loop's own
   * per-frame compare can see it. `paused` is read by the loop as a skip; this
   * one is read as "rebuild the projection matrix", and neither can be a
   * dependency of the scene effect without tearing down the renderer. */
  state.current.projection = props.projection;

  /* 🔴 THE DRAG HANDLERS, PUBLISHED ON EVERY RENDER — the same idiom as
   * `paused` above and `visRef` below, and for a sharper version of the same
   * reason.
   *
   * These three are read by the pointer handlers in the one-time setup effect
   * and by NOTHING THAT IS DRAWN: no geometry, no material, no probe is a
   * function of them. They used to be published from inside the scene effect,
   * which was harmless only because that effect ran on every render — and it no
   * longer does (see `sceneDeps`). Published from there now, a handler that
   * closes over newer state would not reach a drag until the next time the
   * geometry happened to change.
   *
   * ⚠ AND THE CALL SITE INLINES THEM. `App.tsx` passes `onStockMove` and
   * `onClampMove` as arrow literals, so their identity changes on every render
   * while their behaviour does not. As dependencies they rebuilt the entire
   * scene for a new function object; published here they cost one assignment
   * and are always the current closure. */
  state.current.partDrag = props.onPartMoveAt ?? null;
  state.current.stockDrag = props.onStockMove ?? null;
  state.current.clampDrag = props.onClampMove ?? null;

  // Per-class visibility. 🔴 This state is DRAWING ONLY — see
  // `ViewportProps.layers`, which is where it lives now. It reaches the scene
  // and nothing else: not the plan, the G-code, the export, the summary or the
  // simulation. The checks run over the whole program whatever is on screen.
  const kindOn = props.layers;
  const [hover, setHover] = useState<HoverInfo | null>(null);

  /* Whether there is a renderer, as a fact this component MEASURED rather than
   * assumed. `null` until the setup effect has run, which is the state a server
   * render and the first commit are in — and it is published as an ABSENT
   * `data-gl` rather than as a word, for the reason `data-walls` and
   * `data-spoilboard` are removed rather than zeroed: "not measured yet" and
   * "measured, and there is none" are different facts, and a value that reads
   * like an answer would collapse them. */
  const [gl, setGl] = useState<{ ok: boolean; detail?: string } | null>(null);

  /**
   * The framing basis the camera was last placed for — `"<sx>x<sy>"`, or `null`
   * before the first frame.
   *
   * 🔴 THE CAMERA IS THE USER'S, AND A RE-PLAN MAY NOT TAKE IT. The scene is
   * rebuilt wholesale on every dependency change, and `props.progress` is one of
   * them — so the playback scrubber rebuilds the scene many times a second.
   * `frameScene()` used to run at the end of EVERY rebuild, which meant that
   * zooming in while the program played snapped the view back to the whole sheet
   * on the very next tick: the operator could not watch the cut they had just
   * zoomed in on, which is the single thing playback is for. Reported by the
   * founder, 2026-08-08.
   *
   * So the framing is tied to what framing is actually a function of — the sheet
   * size — and nothing else. A new or resized sheet re-frames, because the old
   * view may not contain it. A progress tick, a drag, a re-plan, a theme change
   * and a layer toggle do not, because none of them changes what is worth
   * looking at.
   */
  const framedFor = useRef<string | null>(null);

  // --- snap (TODO #32) -----------------------------------------------------
  //
  // 🔴 BOTH DEFAULT TO OFF, and that is not timidity. A snap moves the datum,
  // and the datum is the work offset the program is cut from — so a placement
  // aid that is on before anyone asked for it changes a number the operator
  // believes they typed. Off, visible, and stated when it acts.
  const [gridStep, setGridStep] = useState(0);
  const [edgeSnap, setEdgeSnap] = useState(false);
  /** What the last drag step actually did, for the on-canvas readout. */
  const [snapNote, setSnapNote] = useState<{ text: string; warn: boolean } | null>(null);

  // `showRapids` is `App`'s own older control and still binds: a class hidden
  // by EITHER control is hidden, and the indicator counts it. Two controls for
  // one class is a wart worth naming rather than hiding — see the report.
  const visible: Record<Layer, boolean> = {
    ...kindOn,
    rapid: kindOn.rapid && props.showRapids !== false,
  };
  // A layer with nothing behind it cannot be "hidden" — it is UNAVAILABLE, and
  // the indicator must not claim the operator switched something off that was
  // never there.
  //
  // ⚠ These are the ones the REASON LINES below are written from, and that is
  // now ALL they are for. The offered/not-offered decision itself is
  // `liveLayersOf()` at module scope, because the sidebar asks the same
  // question and two copies of that filter would be two answers to it.
  const loadedLive = !!props.loadedMesh;
  const resultLive = !!props.stockSurface;
  // A contour list with no contours in it is not a drawing to extrude — and it
  // is not "the drawing is empty" either. `wallsReason` keeps the two apart.
  const wallsLive = !!props.drawing && props.drawing.length > 0;
  /* 🔴 NO CLAMPS DECLARED AND CLAMPS SWITCHED OFF MUST NOT LOOK THE SAME, and
   * this line is half of how that is kept true (the indicator below is the
   * other half). `Fixturing` already refuses to read "nothing declared" as "a
   * human confirmed the bed is clear"; the same refusal has to survive being
   * drawn. So the chip is NOT OFFERED on a job with no work holding — the
   * `presentKinds` rule — rather than offered-and-empty, because a control
   * showing a layer that cannot be there teaches that the bed is clear. */
  const clampsLive = props.clamps.length > 0;
  /* 🔴 IS A BOARD DECLARED? Same rule as `clampsLive`, same argument. An
   * undeclared spoilboard gets NO CHIP rather than a greyed one, because a
   * disabled control reads as "off" and "off" reads as "there is one and you
   * cannot see it". The absence is stated in words below instead. */
  const spoilLive = !!props.spoilboard;
  // The wall height and its assumption, resolved ONCE per render so the note
  // under the canvas and the hover panel cannot disagree about how deep the
  // walls are — or about whether anybody measured that.
  const wallH = wallHeight(props.cutDepthMm, props.stock[2]);
  /* 🔴 THE SAME FUNCTION THE SIDEBAR CALLS, with this component's own props as
   * the argument. The eyes are rendered from `liveLayersOf(scene)` in `App` and
   * the count below is rendered from `liveLayersOf(props)` here; a layer that
   * appears in one and not the other would be an eye the indicator cannot
   * count, or a count for a layer nobody can reach. One filter, two callers. */
  const liveLayers = liveLayersOf(props);
  const hiddenLayers = liveLayers.filter((k) => !visible[k]);
  // The imperative scene reads visibility through a ref, because it is rebuilt
  // by an effect that must not re-run just because a checkbox moved.
  const visRef = useRef(visible);
  visRef.current = visible;

  // The gap facts, resolved ONCE per render so the drag handler, the readout
  // and the status line cannot disagree about the number or about whether there
  // is one. The material-neighbour count is 0 and hardcoded because it is: this
  // viewport is handed one sheet and the clamps, and a clamp is the fixture
  // check's business. When placed drawings arrive (TODO #31) they are the set
  // that goes in here, and nothing else about this changes.
  const gap = gapStatus(props.clearance, 0);
  // Stashed rather than closed over: the pointer handlers live in the one-time
  // effect and would otherwise snap to whatever the controls said on first
  // render, forever.
  state.current.snapCfg = {
    grid: gridStep,
    edges: edgeSnap,
    required: gap.required,
    travel: props.travel,
  } satisfies SnapConfig;
  state.current.setSnapNote = setSnapNote;

  // --- one-time setup ------------------------------------------------------
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    /* 🔴 GUARDED, AND THE EARLY RETURN IS THE WHOLE FIX. Unguarded, this line
     * threw straight out of the effect and took the entire application with it
     * — see `tryRenderer`'s block at the top of this file. Everything below
     * here is scene, loop and pointer wiring that only makes sense with a
     * renderer, so the effect stops: no scene is stored, so the scene effect
     * (which already returns on `!scene`) builds nothing, no `requestAnimation-
     * Frame` loop starts, and no probe attribute is published — they are
     * written to `renderer.domElement`, which does not exist.
     *
     * ⚠ THE PROBES GO ABSENT, NOT ZERO, AND THAT IS DELIBERATE.
     * `data-part-bboxes`, `data-part-probe(s)`, `data-tool-probe`,
     * `data-path-probe`, `data-walls`, `data-spoilboard`, `data-shading` and
     * `data-hover-ms` are all measurements OF A DRAWN SCENE. With no scene
     * there is nothing to measure, and `0` — a bbox at the origin, a probe at
     * `0,0`, `through:0` — is a number a reader would take for an answer. It is
     * the same rule the spoilboard probe already applies when it publishes
     * `notreported` rather than a zero. The only thing published in this state
     * is `data-gl="unavailable"` on the container, which says why they are all
     * missing so a caller cannot read the absence as a failed measurement. */
    const attempt = tryRenderer({
      antialias: true,
      alpha: false,
      // 🔴 Required for the viewport to be INSPECTABLE. Without it the drawing
      // buffer is cleared once the frame is composited, so readPixels() after
      // the fact returns a single flat colour — and an E2E check that samples
      // the canvas reports a correctly-rendered scene as blank. It also makes
      // "save an image of the toolpath" possible later. The cost is that the
      // buffer is kept between frames, which at this scene size is noise.
      preserveDrawingBuffer: true,
    });
    if (!attempt.ok) {
      setGl({ ok: false, detail: attempt.detail });
      return;
    }
    const renderer = attempt.renderer;
    setGl({ ok: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Shadows, because the house 3D look casts them (`ApiaryDesigner3D` renders
    // under `<Canvas shadows>` with `castShadow` on every solid). Soft PCF at a
    // 1024 map is the cheapest setting that still reads as a shadow rather than
    // as a jagged artefact; the shadow camera is sized to the BED in the scene
    // effect, because a fixed frustum silently stops covering a larger machine.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('data-testid', 'viewport-canvas');

    const scene = new THREE.Scene();
    /* ══════════════════════════════════════════════════════════════════════
       TWO CAMERAS, ONE ORBIT (founder, 2026-08-11: *"add perspective /
       orthogonal view change capability in all 3d canvas"*)
       ══════════════════════════════════════════════════════════════════════

       🔴 BOTH BUILT ONCE, ONE SELECTED, AND `camera` IS A `let`. Everything in
       this effect that touches the camera — six `Raycaster.setFromCamera` calls
       for the hover, the clamp, the sheet, the part and the two probes; four
       `Vector3.project` calls that publish screen coordinates; the render call
       itself — reads this one binding. Reassigning it moves all of them
       together. Building a new camera on the toggle would leave the picking
       casting against a camera that is no longer being drawn, which is the
       version of this defect that does not look like one: the picture is right
       and the clicks land somewhere else.

       ⚠ `Raycaster` and `Vector3.project` both handle an orthographic camera —
       three.js branches on `isPerspectiveCamera` / `isOrthographicCamera`
       internally. That was checked rather than assumed, because a raycast that
       silently kept using a perspective origin would put every pick a few
       millimetres off in a tab where a pick moves a clamp.

       ⚠ The ortho frustum below is a placeholder, overwritten by the first
       `applyProjection()` before the first frame. */
    const perspectiveCamera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 1, 20000);
    const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspectiveCamera;

    // Ambient 0.75 + one key light: the same two-light rig the apiary designer
    // uses. Flat-shaded low-poly geometry needs a single directional key to
    // read — more lights average the facets back out and the look is gone.
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(400, -600, 900);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    scene.add(key.target);
    state.current.key = key;

    state.current.renderer = renderer;
    state.current.scene = scene;
    state.current.camera = camera;

    // Scene colours are RESOLVED from the brand tokens at runtime, never copied
    // as hex. `web/src/styles.css` keeps no palette of its own any more — every
    // neutral comes from `brand/tokens.css` — so a hex literal here would be a
    // second copy of a value this app deliberately stopped holding, and it
    // would silently stop matching the panels the day brand changes a neutral.
    //
    // Resolved THROUGH the browser via a probe element rather than by reading
    // the custom property directly: `getPropertyValue('--bg')` hands back
    // whatever text the token happens to hold, which is a var() chain today and
    // could be anything tomorrow, whereas a computed `color` is always rgb().
    const probe = document.createElement('span');
    probe.style.display = 'none';
    el.appendChild(probe);
    const token = (expr: string) => {
      probe.style.color = '';
      probe.style.color = expr;
      return new THREE.Color(getComputedStyle(probe).color);
    };
    state.current.token = token;

    // Orbit without pulling in a control library: drag to rotate, wheel to
    // zoom. Kept minimal on purpose — the viewport is here to show the
    // toolpath, not to be a modelling tool.
    let theta = -Math.PI / 4;
    let phi = Math.PI / 3.2;
    let radius = 1400;
    let target = new THREE.Vector3(0, 0, 0);
    let dragging = false;
    let panning = false;
    let lx = 0;
    let ly = 0;
    // Layout size of the canvas in CSS pixels, kept by resize(). Read every
    // frame to publish the handle's screen position; calling
    // getBoundingClientRect() in the render loop would force a layout per frame.
    let viewW = 1;
    let viewH = 1;
    // `null` until the first frame, so the palette is applied once at startup
    // whatever the theme turns out to be.
    let lastTheme: string | null = null;
    /** What `applyProjection` last built for. Compared once per frame. */
    let builtProjection: Projection | null = null;

    /* 🔴 THE ONE BRANCH IN THE WHOLE FEATURE — everything else is
     * projection-blind. `orthoHalfHeight(radius)` IS the perspective half-height
     * at `radius`, so the wheel, the clamps, the pan and the framing are the same
     * arithmetic in both modes and none of them is touched. The invariants and
     * the OpenSCAD source they are transcribed from are in `projection.ts`.
     *
     * ⚠ IT RUNS WHENEVER `radius` MOVES, not only on a mode change: in ortho the
     * frustum IS the zoom, so a wheel notch that did not reach here would leave
     * the wheel dead — which is the named trap for this feature. `place()` calls
     * it, and every gesture already ends in `place()`. */
    const applyProjection = () => {
      /* Read from the ref, never passed in. A parameter invites callers to pass
       * the mode that is already built, which re-applies the old frustum forever
       * and makes the control dead while looking wired. */
      const want = state.current.projection ?? props.projection;
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
      state.current.camera = camera;
    };

    const place = () => {
      camera.position.set(
        target.x + radius * Math.sin(phi) * Math.cos(theta),
        target.y + radius * Math.sin(phi) * Math.sin(theta),
        target.z + radius * Math.cos(phi)
      );
      camera.up.set(0, 0, 1);
      camera.lookAt(target);
      /* The eye moves in BOTH projections — OpenSCAD's `gluLookAt` sits outside
       * its own projection switch (`GLView.cc:141`) — so this is unconditional,
       * and the frustum is rebuilt from the radius the move just used. */
      applyProjection();
    };

    // Clamp dragging. The clamp is moved on the BED PLANE, not on the screen
    // plane: dragging in screen space moves a clamp by an amount that depends
    // on the camera angle, so the same gesture places it somewhere different
    // each time and the numeric fields and the drag disagree about the model.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let draggingClamp: { index: number; grabDX: number; grabDY: number } | null = null;
    let draggingStock: { grabDX: number; grabDY: number } | null = null;
    /** A drag of ONE PLACED DRAWING across the sheet. `instance` is the id the
     *  program names that drawing's parts with, taken off the object the ray
     *  actually hit — never off the selection, which is what made every grab
     *  move the same part. `p0` is the bed point the grab started at; `off0` is
     *  where THAT part was in SHEET millimetres. The delta is converted bed ->
     *  sheet on every move, so the gesture is measured in the frame the offset
     *  is stored in even on a turned board. */
    let draggingPart: {
      instance: string;
      p0x: number;
      p0y: number;
      off0: [number, number];
    } | null = null;
    // The pivot is FROZEN at grab time. The sheet's centre moves as it turns
    // (the core pushes the rotated sheet back so its bounding corner stays on
    // the datum), so measuring against the live centre would feed the result of
    // the turn back into the angle that produced it and the handle would chase
    // itself. One pivot per gesture, taken once.

    const bedHit = (e: PointerEvent): THREE.Vector3 | null => {
      const rect = dom.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), state.current.bedZ ?? 0);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(plane, hit) ? hit : null;
    };

    /**
     * The footprints one gesture snaps against. `skipClamp` is the clamp being
     * dragged — a thing cannot register against itself, and offering it its own
     * edges would pin it in place.
     *
     * Every entry is `kind: 'other'`, which is the honest state of this
     * viewport and not an oversight: the only pair the clearance rule governs
     * is part-against-part, and there is one part here. See `gapStatus`.
     */
    const neighboursFor = (skipClamp: number | null, includeSheet: boolean): Neighbour[] => {
      const out: Neighbour[] = [];
      const cl = (state.current.clamps ?? []) as ClampCfg[];
      cl.forEach((c, i) => {
        if (i === skipClamp) return;
        out.push({
          label: `clamp ${c.name}`,
          kind: 'other',
          x0: c.x,
          y0: c.y,
          x1: c.x + c.w,
          y1: c.y + c.h,
        });
      });
      if (includeSheet) {
        const [ox0, oy0] = (state.current.stockOrigin ?? [0, 0]) as [number, number];
        const [ew, eh] = (state.current.stockExtent ?? [0, 0]) as [number, number];
        // 🔴 `label` is DISPLAY TEXT, not a key. It is interpolated into the
        // overlap refusal below (`🔴 OVERLAPS ${label} — cutting one destroys
        // the other`), so the terminology canon binds it: the sibling entry
        // above passes the human phrase `clamp <name>`. This one names the
        // WORKPIECE rectangle — `stockOrigin` / `stockExtent`.
        out.push({ label: 'workpiece', kind: 'other', x0: ox0, y0: oy0, x1: ox0 + ew, y1: oy0 + eh });
      }
      return out;
    };

    /** Publish what the snap just did. Deduped on the text, because a drag
     *  fires many pointermoves and most of them decide the same thing. */
    let lastSnapText = '';
    const publishSnap = (what: string, out: SnapOutcome) => {
      const parts: string[] = [];
      if (out.why.length) parts.push(`${what} snapped: ${out.why.join(', ')}`);
      parts.push(`→ X ${out.x.toFixed(1)}, Y ${out.y.toFixed(1)}`);
      if (out.tooClose) {
        parts.push(
          out.tooClose.overlap
            ? `🔴 OVERLAPS ${out.tooClose.label} — cutting one destroys the other`
            : `🔴 ${out.tooClose.gap.toFixed(1)}mm to ${out.tooClose.label}, ${out.tooClose.required.toFixed(1)}mm required — the cutter does not fit between them`
        );
      }
      const text = parts.join(' · ');
      if (text === lastSnapText) return;
      lastSnapText = text;
      state.current.setSnapNote?.({ text, warn: !!out.tooClose });
    };

    // --- hover ---------------------------------------------------------------
    //
    // The pointer position is RECORDED here and the raycast happens once, in
    // the animation frame. A pointermove can fire many times between two
    // frames, and casting per event would do work whose result is thrown away
    // before anything draws it.
    //
    // 🔴 Throttling drops POINTER SAMPLES, never SCENE SAMPLES. Every visible
    // segment of the program is tested on every cast. A pick that quietly
    // skipped segments to go faster would report "nothing here" over a real
    // cut, which is the one answer this panel must never give wrongly.
    let hoverPending: { x: number; y: number } | null = null;
    let hoverKey = '';
    // Where the pointer was last seen, whether or not it was hovering. Kept
    // separately from `hoverPending` because it has to survive a whole drag: it
    // is what the panel is brought BACK at when the button is released.
    let lastPointer: { x: number; y: number } | null = null;
    // The material whose emissive was raised for the current hover, with the
    // values to put back. Restored before the next one is raised, so a hover
    // cannot leave a permanently lit object behind.
    let litBy: { m: THREE.MeshStandardMaterial; colour: number; intensity: number } | null = null;

    const mm = (v: number) => `${v.toFixed(1)} mm`;

    const clearLit = () => {
      if (!litBy) return;
      litBy.m.emissive.setHex(litBy.colour);
      litBy.m.emissiveIntensity = litBy.intensity;
      litBy = null;
    };

    const light = (o: THREE.Object3D) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m || !m.emissive) return;
      litBy = { m, colour: m.emissive.getHex(), intensity: m.emissiveIntensity ?? 1 };
      m.emissive.copy((state.current.accent as THREE.Color) ?? new THREE.Color(0xffffff));
      m.emissiveIntensity = 0.55;
    };

    /** What each object is allowed to say about itself. Every value below is
     *  read from state this component was GIVEN; nothing is derived. */
    const describe = (hit: THREE.Intersection): HoverInfo | null => {
      const o = hit.object;
      const d = state.current.hoverData;
      if (!d) return null;

      if (o.name === 'stock') {
        const rows: [string, string][] = [
          ['Size', `${mm(d.stock[0])} × ${mm(d.stock[1])} × ${mm(d.stock[2])}`],
          ['Datum', `X ${mm(d.origin[0])}, Y ${mm(d.origin[1])}`],
          ['Laid at', `${d.rotation}°`],
        ];
        if (d.material) rows.push(['Material', String(d.material)]);
        // 🔴 The hover panel's title, and the sidebar's word for this object.
        //
        // ✅ CLOSED 2026-08-11. This note read *"`web/e2e/slicer.spec.ts:1969`
        // still asserts `toContain('Sheet')` … and is STALE"*. It no longer
        // does: the e2e assertion is `toContain('Workpiece')`, corrected in the
        // same day off THIS producer's word rather than guessed, and it carries
        // its own note saying the capitalisation was read here.
        //
        // ⚠ Kept rather than deleted, because a stale 🔴 lies exactly like a
        // stale ✅ and is harder to find — nobody re-reads a line that already
        // admits it is broken. What survives is the reason it was written: a
        // stale assertion nobody can trace back to the change that stranded it
        // gets "fixed" by weakening it.
        //
        // ⚠ AND IT IS STILL NOT PROVEN ON SCREEN. That test fails ~150 lines
        // earlier on `viewport-canvas.boundingBox()` — the hover panel is a
        // WebGL pick and this box has no WebGL — so the word agrees at the
        // source and has never been read off a rendered panel.
        return { title: 'Workpiece', rows };
      }

      /* ═══ THE SPOILBOARD — TODO #74 ═════════════════════════════════════════
       *
       * 🔴 It is MATERIAL, and the travel envelope below is REACH.
       * `docs/terminology.md` §9 S1 makes that distinction safety-bearing:
       * *"travel is reach, the spoilboard is material, and they are not the
       * same rectangle"* — conflating them made an intended through-cut and a
       * cutter descending into the machine's own frame report identically. Two
       * separate branches, two separate titles, and each says in its own note
       * which of the two it is. */
      if (o.name === 'spoilboard' || o.name === 'spoilboard-unknown' || o.name === 'spoilboard-bare') {
        const b = d.board as ViewportProps['spoilboard'];
        const sl = d.slab as BoardSlab;
        if (!b || !sl || sl.state === 'none') return null;
        const dep = d.boardDepth as BoardDepthRead;
        const depText = boardDepthText(dep);
        const bare = bareReachText(d.bareReach);
        // 🔴 THREE states, not two. `undefined` is not "somebody typed it": the
        // provenance was never stated, and that is a weaker fact than either.
        const assumed = d.boardPositionAssumed;
        const corner =
          assumed === true
            ? 'fitted by this app (ASSUMED)'
            : assumed === false
              ? 'entered'
              : 'provenance not stated';
        const rows: [string, string, HoverTone?][] = [
          ['Name', b.name ? String(b.name) : 'not named'],
          ['Size', `${mm(Number(b.size_x_mm))} × ${mm(Number(b.size_y_mm))}`],
          [
            'Lower-left',
            `X ${mm(Number(b.x_mm))}, Y ${mm(Number(b.y_mm))} — ${corner}`,
            assumed === true ? 'warn' : assumed === undefined ? 'pending' : undefined,
          ],
          // 🔴 THE WORD, NOT A BLANK. An empty cell where a thickness would go
          // reads as zero, and zero is the one value that would make every
          // through-cut a strike on the frame.
          [
            'Thickness',
            sl.thicknessMm == null ? 'UNKNOWN' : mm(sl.thicknessMm),
            sl.thicknessMm == null ? 'pending' : undefined,
          ],
          [
            'Top face',
            sl.topZMm == null ? 'UNKNOWN' : `Z ${mm(sl.topZMm)}`,
            sl.topZMm == null ? 'pending' : undefined,
          ],
          [
            'Underside',
            sl.undersideZMm == null ? 'UNKNOWN — no thickness to measure it from' : `Z ${mm(sl.undersideZMm)}`,
            sl.undersideZMm == null ? 'pending' : undefined,
          ],
          ['Depth check', depText.text, depText.tone],
          // The number the operator would most want on hover: reachable area
          // with NO sacrificial material under it.
          ['Uncovered reach', bare.text, bare.tone],
        ];
        /* 🔴 THE STRIPS ARE NOT THE BOARD, and the title has to say so. They are
         * drawn from the board's declaration and report the same facts, so they
         * share this panel — but the pointer is over reachable area with NO
         * sacrificial material under it, and a panel headed "Spoilboard" there
         * would name material at the one XY where there is none. That is the S1
         * collapse in miniature, on the surface an operator trusts fastest. */
        const onBare = o.name === 'spoilboard-bare';
        return {
          title: onBare ? 'Uncovered reach — NO board here' : 'Spoilboard',
          rows,
          note:
            (onBare
              ? 'You are pointing at reachable area the declared board does NOT cover: bare machine — a rail, an extrusion, a T-slot, the frame. A cut that goes below the workpiece here reaches what the machine is built of, not sacrificial material. The board it is measured against: '
              : '') +
            'Sacrificial MATERIAL bolted to the machine — NOT the travel envelope, which is reach and has no surface. ' +
            'The board is smaller than the reach and need not start at the datum, so "inside the travel" and "over the spoilboard" are different questions. ' +
            (sl.why ? `${sl.why} ` : '') +
            (dep.reason ? `${dep.reason} ` : '') +
            'The thickness is whatever was DECLARED — nominal, and a board is dressed thinner in service; packers, a sub-board or tape all move the real top face up, toward the cutter, and nothing here can see them.',
        };
      }

      /* ═══ THE TRAVEL ENVELOPE — TODO #74 ════════════════════════════════════ */
      if (o.name === 'travel') {
        const [tvx, tvy] = d.travel as [number, number];
        const bare = bareReachText(d.bareReach);
        const tz = d.travelZ;
        const rows: [string, string, HoverTone?][] = [
          ['X limit', mm(Number(tvx))],
          ['Y limit', mm(Number(tvy))],
          // 🔴 NOT a blank and NOT a zero. `App` flattens `Report.travel` to two
          // numbers for the scene, so the Z limit is a caller-wiring fact — and
          // a `0.0 mm` here would read as a machine with no Z at all.
          [
            'Z limit',
            tz == null || !Number.isFinite(Number(tz)) ? 'not passed to this viewport' : mm(Number(tz)),
            tz == null || !Number.isFinite(Number(tz)) ? 'pending' : undefined,
          ],
          ['Uncovered reach', bare.text, bare.tone],
        ];
        return {
          title: 'Travel envelope',
          rows,
          // 🔴 The sentence this panel exists to keep intact.
          note:
            'This is REACH, not material. Nothing sits on it and nothing is cut into it: it is how far the axes can go, from the machine datum at 0,0. ' +
            'Exceeding it is the controller refusing the line or an axis hitting its stop. That is a different failure from running off the spoilboard, which is the cutter reaching what the machine is built of — and they are not the same rectangle. ' +
            'The ruled grid is the same limits drawn twice and is deliberately not pickable; hovering it would put a line across the whole reach in front of everything behind it.',
        };
      }

      if (o.name.startsWith('clamp:')) {
        const c = d.clamps[Number(o.userData.index)] as ClampCfg | undefined;
        if (!c) return null;
        return {
          title: `Clamp — ${c.name}`,
          rows: [
            ['Footprint', `${mm(c.w)} × ${mm(c.h)}`],
            // `Clamp.height_mm` is how far the clamp stands above the surface
            // it sits on — the spoilboard's top face, which is the workpiece's
            // underside (`clearance_z = tallest − stock_thickness`). NOT the
            // machine: this datum is material.
            ['Height', `${mm(c.height_mm)} from the spoilboard`],
            ['Datum', `X ${mm(c.x)}, Y ${mm(c.y)}`],
          ],
          // 🔴 Gate E5's distinction, kept intact: this panel reports a
          // DECLARED obstruction. Whether the path clears it is the fixture
          // check in the report, and "declared" must never read as "checked".
          note: 'Declared work holding. Whether the path clears it is the fixture check in the report, not this panel.',
        };
      }

      if (o.name === 'loaded' || o.name === 'loaded-section') {
        const mi = state.current.meshInfo;
        if (!mi) return null;
        const rows: [string, string][] = [
          ['Triangles', mi.error ? 'none decoded' : `${mi.triangles}${mi.decimated ? ` of ${mi.source}` : ''}`],
          ['Section Z', mm(mi.sectionZ)],
          ['Bounds X', `${mm(mi.min[0])} to ${mm(mi.max[0])}`],
          ['Bounds Y', `${mm(mi.min[1])} to ${mm(mi.max[1])}`],
          ['Bounds Z', `${mm(mi.min[2])} to ${mm(mi.max[2])}`],
        ];
        return {
          title: o.name === 'loaded-section' ? 'Section plane' : 'Loaded object',
          rows,
          note: mi.error
            ? `The mesh did not decode: ${mi.error}. Nothing is drawn for it — a partly-decoded solid looks entirely like a model.`
            : 'This is the object AS LOADED — the input, not the result and not the part. ' +
              'The machine follows ONE FLAT OUTLINE through it, at the section Z above. ' +
              (mi.decimated
                ? `Drawn from ${mi.triangles} of the file's ${mi.source} triangles: a decimated mesh is a DIFFERENT SOLID with facets missing. Fit for looking at, never for measuring.`
                : 'Every triangle in the file is drawn.'),
        };
      }

      if (o.name === 'walls') {
        const wi = state.current.wallInfo;
        if (!wi) return null;
        const rows: [string, string][] = [
          ['Parts', `${wi.parts}`],
          ['Contours', `${wi.contours} (${wi.holes} holes)`],
          ['Height', `${mm(wi.height)}${wi.assumed ? ' (assumed)' : ''}`],
          [
            'Arcs',
            wi.arcs
              ? `${wi.arcs} swept to ${wi.arcPoints} points of ${wi.points}`
              : 'none in this drawing',
          ],
          ['Chord tolerance', `${wi.tolerance} mm`],
        ];
        return {
          title: 'Extruded walls',
          rows,
          // 🔴 The two things a viewer must not conclude from this solid: that
          // it is the machined result, and that its height was measured when it
          // was not. Both live on the object, not in a doc nobody opens.
          note:
            'This is the DRAWING extruded — what the geometry asks for, before any tool touches it. ' +
            'It has square inside corners no cutter can make and no dogbones; the simulated stock surface is the layer that shows what the machine would leave. ' +
            `Its arcs are drawn as line work to ${wi.tolerance}mm, so a radius measured off it reads that much small${wi.clamped ? ' — and at least one arc hit the segment cap, so it is drawn coarser than that' : ''}. ` +
            wi.why +
            (wi.dropped
              ? ` ${wi.dropped} contour(s) are NOT DRAWN at all — the layer's vertex budget was reached, and dropping whole contours is the only thinning that cannot quietly round a corner off.`
              : ''),
        };
      }

      if (o.name === 'surface') {
        const si = state.current.surfaceInfo;
        if (!si) return null;
        const rows: [string, string][] = [
          ['Map', `${si.cols} × ${si.rows} samples`],
          ['Cell', `${si.cell} mm`],
          ['Drawn at', `${si.drawnCell} mm`],
          ['Deepest', mm(si.deepest)],
          ['Here', mm(hit.point.z)],
        ];
        return {
          title: 'Simulated stock surface',
          rows,
          // 🔴 Two claims that must never be read off this object: that it is
          // the part, and that it is complete at any resolution finer than the
          // cell. Both are stated on the object itself, not left to a doc.
          note: si.error
            ? `The surface did not decode: ${si.error}. Nothing is drawn for it — a short height map read row-major draws a plausible workpiece on a slant.`
            : 'This is the stock AFTER machining — the output, and NOT the part: a height map records removed material and cannot say which side of a through cut you keep. ' +
              `It is a model at ${si.cell}mm cells${si.strided ? `, drawn at ${si.drawnCell}mm because the map was strided to fit the vertex budget — skipped samples are not drawn at all` : ''}. ` +
              // 🔴 The cell the VIEWER is looking at, not the map's own, when
              // the two differ: the oversize and the square corners are
              // produced by the cell that was drawn.
              resultCaveats(si.strided ? si.drawnCell : si.cell),
        };
      }

      if (o.name === 'touch') {
        const placed = o.userData.placed === true;
        const rows: [string, string][] = [
          ['Thickness', mm(Number(o.userData.thickness))],
          [
            'Position',
            placed ? `X ${mm(o.position.x)}, Y ${mm(o.position.y)}` : 'not declared',
          ],
          ['Footprint', `${PLATE_PLACEHOLDER_XY} x ${PLATE_PLACEHOLDER_XY} mm (placeholder)`],
        ];
        return {
          title: 'Touch plate',
          rows,
          // Two limits, both stated on the object rather than left to be
          // inferred from a picture that looks precise.
          note:
            (placed
              ? ''
              : "Position not declared: the machine reads probe 0,0, which its own definition means \u201cprobe where the tool already is\u201d. Drawn at the machine origin as a placeholder, not a measurement. ") +
            'The footprint is not declared anywhere, so the square above is a placeholder too — the thickness and the position are the only measured numbers here. ' +
            'Drawn as an obstacle you can see; it is NOT treated as a keepout by any check in this app.',
        };
      }

      if (o.name === 'tool') {
        // An EMPTY program has no head, and the marker is not built without
        // one — so this branch is unreachable today. It is guarded anyway
        // rather than relying on that: "the object cannot exist" is a fact
        // about the other end of this file, and the zero-move state is the
        // first thing a user sees.
        if (!d.head) return null;
        const mk = d.toolMarker as ToolMarkerShape | undefined;
        const rows: [string, string][] = [
          ['At', `X ${mm(d.head.x)}, Y ${mm(d.head.y)}, Z ${mm(d.head.z)}`],
          ['Move', `${d.upTo} of ${d.total}`],
        ];
        if (d.tool) {
          rows.push(['Tool', String(d.tool.id)]);
          // 🔴 NOT `mm(Number(...))`. An absent diameter formatted as a number
          // reads as "NaN mm" at best and as a measurement at worst, and this
          // is the field the whole marker refuses over.
          const stated = (v: unknown) => {
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? mm(n) : 'not stated';
          };
          rows.push(['Diameter', stated(d.tool.diameter_mm)]);
          rows.push(['Flutes', d.tool.flutes ? String(d.tool.flutes) : 'not stated']);
          rows.push(['Shank', stated(d.tool.shank_mm)]);
          if (d.tool.fit) rows.push(['Fit', `${d.tool.fit}${d.tool.fit_why ? ` — ${d.tool.fit_why}` : ''}`]);
        }
        // What is actually ON SCREEN, which is a different question from what
        // the row holds — and the only one this object can answer.
        if (mk) rows.push(['Marker', mk.refused ? 'NO CUTTER DRAWN' : mk.summary]);
        return {
          title: 'Tool',
          rows,
          note:
            'The marker is the head of the DRAWN program, which the scrubber moves. It is not a machine position. ' +
            (!mk
              ? ''
              : mk.refused
                ? `No cutter is drawn: ${mk.refused}. The dashed cage is a PLACEHOLDER at ${TOOL_FRAME_MM.xy}×${TOOL_FRAME_MM.xy}×${TOOL_FRAME_MM.h}mm — a size nobody declared, so nothing about it may be measured or read as clearance.`
                : `The solid is the cutter's swept ENVELOPE, drawn to scale from the tool row. Its ${TOOL_SEGMENTS} facets sit OUTSIDE the true circle, so the envelope is up to ${((TOOL_FACET_SCALE - 1) * 100).toFixed(1)}% OVERSIZE and never undersize — the safe direction for judging a clearance by eye. A torn end means shortened, not shown to length; an open end inside a dashed ring means the tip is not stated.`) +
            (mk && mk.notDrawn.length ? ` Not drawn: ${mk.notDrawn.join('; ')}.` : ''),
        };
      }

      if (o.name.startsWith('path:')) {
        const kind = o.name.slice(5) as RenderKind;
        const line = o as THREE.LineSegments;
        const pos = line.geometry.getAttribute('position');
        // three.js reports the index of the segment's FIRST vertex for a
        // LineSegments hit; the pair is (i, i+1).
        const i = hit.index ?? 0;
        const j = Math.min(i + 1, pos.count - 1);
        const idx = (line.userData.moveIdx as Int32Array | undefined)?.[i >> 1];
        const rows: [string, string][] = [
          ['From', `X ${mm(pos.getX(i))}, Y ${mm(pos.getY(i))}, Z ${mm(pos.getZ(i))}`],
          ['To', `X ${mm(pos.getX(j))}, Y ${mm(pos.getY(j))}, Z ${mm(pos.getZ(j))}`],
        ];
        if (idx !== undefined && idx >= 0) rows.push(['Move', `${idx + 1} of ${d.total}`]);
        return {
          title: `Toolpath — ${LAYER_LABEL[kind] ?? kind}`,
          rows,
          // 🔴 The whole reason this panel is short. A rendered move carries
          // `kind`, `x`, `y`, `z` and nothing else. A feed, an operation name
          // or a tool shown here would be a machining fact INVENTED in the
          // browser, which this app has already got wrong twice.
          note: 'A rendered move carries its class and its coordinates. The core sends no feed, operation or tool with it, so none is shown.',
        };
      }
      return null;
    };

    /** One cast per frame. Coarse solids first, then the path — a sheet-sized
     *  mesh is a handful of triangles and the path is thousands of segments. */
    const pickAt = (cx: number, cy: number) => {
      const rect = dom.getBoundingClientRect();
      ndc.x = ((cx - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((cy - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);

      // FOUR tiers, and the order is a correctness decision, not only a cost
      // one:
      //
      //   1. things that sit ON the board — clamps, the tool marker. Solid, few
      //      triangles, genuinely in front. Cheap and tested first.
      //   2. the toolpath.
      //   3. the SHEET, and under it the SPOILBOARD.
      //   4. the travel OUTLINE, last of all.
      //
      // 🔴 The sheet is deliberately NOT in tier 1, even though it is coarse.
      // Cutting happens INSIDE the stock, so the ray meets the sheet's top face
      // before it ever reaches the path: a plain "coarse before path" order
      // makes the entire toolpath unhoverable behind a board you can see
      // through. The sheet is what you are pointing at when you are not
      // pointing at anything on it.
      const near: THREE.Object3D[] = [];
      const paths: THREE.Object3D[] = [];
      // Tier 3 — the big coarse surfaces you are pointing at when you are
      // not pointing at anything on them. The simulated stock joins the sheet
      // here for the same reason the sheet is here: it spans the whole job and
      // the toolpath is drawn INSIDE it.
      //
      // 🔴 THE SPOILBOARD JOINS THIS TIER AND NOT AN EARLIER ONE. It lies UNDER
      // everything — under the work, under the path, under the clamps — so it
      // must never win a pick from something standing on it. Within the tier
      // `intersectObjects` sorts by distance, and the board is the furthest
      // thing in it, so the work above wins wherever the two overlap. It is
      // what you are pointing at when you are pointing past the edge of the
      // work: MATERIAL, which is the whole reason it is drawn.
      const sheet: THREE.Object3D[] = [];
      // Tier 4 — the reach outline. 🔴 The GRID is deliberately excluded even
      // though it draws the same limits: it is line work ruled across the whole
      // reach, and with the pick radius below every hover anywhere near a grid
      // line would report the envelope instead of what is under the pointer.
      // One fact, drawn twice, pickable once.
      const reach: THREE.Object3D[] = [];
      for (const o of scene.children) {
        // 🔴 An invisible class is not pickable. A hover panel reporting an
        // object the operator cannot see is worse than no hover, and three.js
        // does NOT skip invisible objects in `intersectObjects` — the check has
        // to be here.
        if (!o.visible) continue;
        if (o.name.startsWith('path:')) paths.push(o);
        // The walls join the SHEET tier, not the near one, for the same reason
        // the sheet is there: they span the whole job and the toolpath runs
        // right alongside them, one tool radius away. In tier 1 a ribbon
        // standing on the cut line would swallow every pick meant for the cut
        // it is next to — and telling a cut from a rapid is the safety-bearing
        // question on this canvas, not identifying a reference shape.
        else if (o.name === 'stock' || o.name === 'surface' || o.name === 'walls') sheet.push(o);
        // The board, its dashed UNKNOWN-thickness edge and the bare strips all
        // answer with the same panel: the strips are the board's own report of
        // where it runs out, and a separate panel for them would be a second
        // description of one declaration.
        else if (
          o.name === 'spoilboard' ||
          o.name === 'spoilboard-unknown' ||
          o.name === 'spoilboard-bare'
        )
          sheet.push(o);
        else if (o.name === 'travel') reach.push(o);
        else if (
          o.name === 'tool' ||
          o.name === 'touch' ||
          o.name === 'loaded' ||
          o.name === 'loaded-section' ||
          o.name.startsWith('clamp:')
        )
          near.push(o);
      }

      // The threshold is set before the FIRST cast, not only before the path
      // one: an undeclared touch plate is drawn as an outline, and a line with
      // no radius cannot be hit.
      ray.params.Line.threshold = Math.min(20, Math.max(1, radius / 200));
      let hits = ray.intersectObjects(near, false);
      if (!hits.length && paths.length) {
        // A line has no area, so the pick needs a radius (set above). It is tied
        // to the ORBIT DISTANCE: a fixed millimetre threshold is unusable zoomed
        // out and grabs the wrong segment zoomed in.
        hits = ray.intersectObjects(paths, false);
      }
      if (!hits.length && sheet.length) hits = ray.intersectObjects(sheet, false);
      if (!hits.length && reach.length) hits = ray.intersectObjects(reach, false);
      if (!hits.length) return null;
      const info = describe(hits[0]);
      return info ? { info, hit: hits[0] } : null;
    };

    const down = (e: PointerEvent) => {
      /* 🔴 THE POINTER LANDED ON A PART, whether or not that part turned out to
       * be draggable. It suppresses the SHEET drag below.
       *
       * Without it, a grab on a part this file cannot name — an unkeyed object,
       * or one whose placement it was not given — falls through to the branch
       * underneath, which is the board. The part sits ON the board, so the ray
       * hits it every time: a gesture aimed at a part would move the DATUM, and
       * the datum takes the clamps' and the touch plate's relationship to the
       * work with it. "That part did not move" is a refusal; "the board moved
       * instead" is a different object changed by a gesture nobody aimed at it.
       * The gesture falls through to ORBIT, which changes nothing. */
      let onPart = false;
      // A clamp under the pointer takes precedence over orbiting, so a drag
      // that starts on a clamp moves the clamp rather than the camera.
      if (state.current.clampDrag && e.button === 0 && !e.shiftKey) {
        const rect = dom.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        ray.setFromCamera(ndc, camera);
        // 🔴 `o.visible`, for the same reason the part and sheet drags check it,
        // and it became reachable the moment work holding got a hide toggle
        // (TODO #53). A hidden clamp left grabbable is an INVISIBLE OBJECT THAT
        // EATS A DRAG: the operator switches the clamps off to see the work
        // under them, goes to orbit, and instead moves a clamp they cannot see
        // to a position they did not choose — silently changing an input to the
        // fixture check. Hiding a layer must cost the picture and nothing else.
        const targets = scene.children.filter((o) => o.name.startsWith('clamp:') && o.visible);
        const hits = ray.intersectObjects(targets, false);
        if (hits.length) {
          const idx = Number(hits[0].object.userData.index);
          const p = bedHit(e);
          if (p && Number.isFinite(idx)) {
            const c = state.current.clamps[idx];
            draggingClamp = { index: idx, grabDX: p.x - c.x, grabDY: p.y - c.y };
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return;
          }
        }
      }
      // 🔴 THE LOADED OBJECT IS PICKED BEFORE THE SHEET, and after the clamps.
      // It sits ON the board, so a grab that lands on the part is a part drag
      // and not a sheet drag — the other order makes the object unmovable,
      // which is the founder's complaint restated as an ordering bug. The
      // clamps still win over it: a clamp sits on top of everything.
      if (state.current.partDrag && e.button === 0 && !e.shiftKey) {
        const rectP = dom.getBoundingClientRect();
        ndc.x = ((e.clientX - rectP.left) / rectP.width) * 2 - 1;
        ndc.y = -((e.clientY - rectP.top) / rectP.height) * 2 + 1;
        ray.setFromCamera(ndc, camera);
        // `o.visible` for the same reason the sheet drag checks it: a gesture
        // that moves geometry nobody can see changes the program with nothing
        // on screen to show for it. The section plane is deliberately NOT a
        // grab target — it is an annotation about where the cut is taken, and
        // dragging an annotation to move a part reads as moving the plane.
        const targets = scene.children.filter(
          (o) => (o.name === 'loaded' || o.name === 'walls') && o.visible
        );
        // 🔴 THE NEAREST HIT DECIDES WHICH PART MOVES. `intersectObjects` returns
        // hits sorted by distance, so this is the object the operator is looking
        // at — not the selected row, which is what the single global grab target
        // resolved to and is why every drag moved the same drawing.
        const hits = ray.intersectObjects(targets, false);
        onPart = hits.length > 0;
        const grabbedId = hits.length
          ? (hits[0].object.userData.instance as string | undefined)
          : undefined;
        const offsets = state.current.partOffsets as Map<string, [number, number]>;
        // ⚠ An object with no instance, or one whose placement this file was not
        // given, is NOT dragged and the gesture falls through to the sheet. It
        // would otherwise have to guess a placement to write, and the guess
        // moves a part the operator is not touching. "I could not tell which
        // part that is" and "that part did not move" are different failures, and
        // only the second one is safe.
        if (grabbedId && offsets?.has(grabbedId)) {
          const p = bedHit(e);
          if (p) {
            draggingPart = {
              instance: grabbedId,
              p0x: p.x,
              p0y: p.y,
              off0: offsets.get(grabbedId)!,
            };
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return;
          }
        }
      }
      // The sheet is picked AFTER clamps: a clamp sits on top of the board, so
      // a drag starting on a clamp is a clamp drag. Orbit comes last, so the
      // camera only moves when the gesture started on empty bed.
      if (!onPart && state.current.stockDrag && e.button === 0 && !e.shiftKey) {
        const rect2 = dom.getBoundingClientRect();
        ndc.x = ((e.clientX - rect2.left) / rect2.width) * 2 - 1;
        ndc.y = -((e.clientY - rect2.top) / rect2.height) * 2 + 1;
        ray.setFromCamera(ndc, camera);
        // `o.visible` matters: a sheet switched off in the layer list must not
        // be draggable either. A gesture that moves the datum of an invisible
        // board changes the program with nothing on screen to show for it.
        const st = scene.children.filter((o) => o.name === 'stock' && o.visible);
        if (ray.intersectObjects(st, false).length) {
          const p = bedHit(e);
          const [ox0, oy0] = state.current.stockOrigin ?? [0, 0];
          if (p) {
            draggingStock = { grabDX: p.x - ox0, grabDY: p.y - oy0 };
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return;
          }
        }
      }
      dragging = true;
      panning = e.button === 2 || e.shiftKey;
      lx = e.clientX;
      ly = e.clientY;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
      // 🔴 WHILE SOMETHING IS BEING MOVED, THE PROPERTIES PANEL GOES AWAY
      // (founder, 2026-08-08). It sits over the thing being dragged, and it is
      // describing an object whose numbers are changing underneath it — a
      // panel that lags the drag by a frame reads as a measurement of where the
      // part is, which is the one thing it must not do while the part moves.
      //
      // Note this suppresses the PANEL, not the picking: `up()` re-requests a
      // pick at the last pointer position, so releasing over the object brings
      // the panel straight back rather than waiting for the pointer to leave
      // and return.
      if (!draggingClamp && !draggingStock && !draggingPart && !dragging) {
        hoverPending = { x: e.clientX, y: e.clientY };
      } else if (hoverKey) {
        hoverPending = null;
        hoverKey = '';
        clearLit();
        setHover(null);
      }
      if (draggingClamp) {
        const p = bedHit(e);
        if (p) {
          const cfg = state.current.snapCfg as SnapConfig;
          const c = (state.current.clamps ?? [])[draggingClamp.index] as
            | ClampCfg
            | undefined;
          const w = c?.w ?? 0;
          const h = c?.h ?? 0;
          const out = snapPlacement(
            [p.x - draggingClamp.grabDX, p.y - draggingClamp.grabDY],
            [w, h],
            cfg,
            neighboursFor(draggingClamp.index, true)
          );
          state.current.snap = out;
          state.current.applySnapGuides?.();
          publishSnap(`clamp ${c?.name ?? draggingClamp.index}`, out);
          // 🔴 The CENTRE, not the corner — and this is a fix, not a
          // preference. `grabDX` is measured against `c.x`, which is the
          // footprint's MIN corner (it is what the mesh is offset from and what
          // the hover panel reports as the datum), so this handler has always
          // produced a corner. `App` converts what it receives back with
          // `x - w/2`, i.e. it expects a centre — so every clamp jumped half its
          // own width the instant it was grabbed, and a snapped corner would
          // have been stored as corner-minus-half-width: the numeric field
          // showing a value the drag never chose, which is the exact failure
          // this snap work exists to prevent.
          state.current.clampDrag?.(draggingClamp.index, out.x + w / 2, out.y + h / 2);
        }
        return;
      }
      if (draggingPart) {
        const p = bedHit(e);
        if (p) {
          // 🔴 THE DELTA IS CONVERTED BED -> SHEET, and this is not decoration.
          // The offset is added BEFORE the sheet's rotation in the core, so it
          // is measured on the board. On a sheet turned a quarter turn, a drag
          // that moves the pointer along the machine's X has to be stored as a
          // move along the sheet's Y — otherwise the number in the panel and
          // the direction the part went would be two different facts.
          //
          // The 2x2 is INVERTED rather than transposed. A transpose is only the
          // inverse of a rotation, and this matrix is whatever the core reported
          // — asserting orthonormality here would be an assumption about another
          // module's arithmetic, in the file least able to notice it was wrong.
          const M = state.current.drawingToBed as THREE.Matrix4 | undefined;
          const m = M ? M.elements : null;
          // three.js stores column-major: e[0]=m11 e[4]=m12 e[1]=m21 e[5]=m22.
          const a = m ? m[0] : 1;
          const b = m ? m[4] : 0;
          const c = m ? m[1] : 0;
          const d2 = m ? m[5] : 1;
          const det = a * d2 - b * c;
          const bdx = p.x - draggingPart.p0x;
          const bdy = p.y - draggingPart.p0y;
          if (Math.abs(det) > 1e-12) {
            const sdx = (d2 * bdx - b * bdy) / det;
            const sdy = (-c * bdx + a * bdy) / det;
            // Rounded to 0.1mm, the same quantum every other drag here uses. A
            // placement carrying 14 decimal places of mouse noise reads as a
            // measurement nobody took, and it lands in the G-code as a
            // coordinate.
            //
            // ⚠ UNCLAMPED, deliberately, and not snapped to anything. A drag
            // that puts the part off the sheet, past the travel limits or into a
            // clamp is REFUSED by the core on the re-plan, and that refusal is
            // the answer. Trimming it here would hide it — and a snap that moved
            // a part out of a clamp would be this tool relocating geometry to
            // resolve an interference, which is the one thing `fit` and `layout`
            // exist to refuse.
            // 🔴 ONE CALL, CARRYING THE ID AND BOTH AXES TOGETHER. The pair is
            // one stored value in `App` (`drawings[i].offset`), and the last
            // time this was two single-axis writes the second discarded the
            // first from a stale closure and Part X could not move at all
            // (`4ae2615c23`). A per-instance handler is the same trap one step
            // along: it must take the id and the pair in one call, never an
            // id-then-x-then-y sequence.
            state.current.partDrag?.(
              draggingPart.instance,
              q1(draggingPart.off0[0] + sdx, 0),
              q1(draggingPart.off0[1] + sdy, 0)
            );
          }
        }
        return;
      }
      if (draggingStock) {
        const p = bedHit(e);
        if (p) {
          // Rounding to 0.1mm still happens — inside `snapPlacement`, which is
          // now the one place a datum is decided. A datum carrying 14 decimal
          // places of mouse noise reads as a measurement nobody took, and it
          // lands in the G-code as a work offset.
          //
          // ⚠ The result is handed on UNCLAMPED. A snap that puts the workpiece
          // outside the travel or into a clamp is refused by the core's travel
          // and fixture checks on the re-plan, and that refusal is the answer.
          // Trimming the value here to keep it legal would hide it.
          const cfg = state.current.snapCfg as SnapConfig;
          const ext = (state.current.stockExtent ?? [0, 0]) as [number, number];
          const out = snapPlacement(
            [p.x - draggingStock.grabDX, p.y - draggingStock.grabDY],
            ext,
            cfg,
            neighboursFor(null, false)
          );
          state.current.snap = out;
          state.current.applySnapGuides?.();
          // 🔴 The first argument is DISPLAY TEXT, not a key — `publishSnap`
          // builds `${what} snapped: …` and pushes it to `setSnapNote`. The
          // only other call site passes the human phrase `clamp <name>`.
          publishSnap('workpiece', out);
          state.current.stockDrag?.(out.x, out.y);
        }
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (panning) {
        // Pan along the two directions the SCREEN axes project onto the bed.
        // Both are derived from three.js's own lookAt basis rather than picked
        // by flipping signs until it felt right — with `up` = +Z and
        // `z = eye - target = (sinφ·cosθ, sinφ·sinθ, cosφ)`:
        //
        //   screen right = x = up x z    = (-sinθ, cosθ, 0)
        //                                  already horizontal, so it lies IN
        //                                  the bed with no projection needed
        //   screen up    = y = z x x     = (-cosφ·cosθ, -cosφ·sinθ, sinφ)
        //   screen up projected onto bed = -sign(cosφ) · (cosθ, sinθ)
        //
        // 🔴 The old code used (cosθ, sinθ) as screen-right. That is the
        // NEGATIVE of screen-up-on-the-bed — right and up swapped — so the two
        // axes disagreed about sign and the pan fought the mouse. Its vertical
        // term was also `* 0` on x and `* -1` on y: half the basis vector,
        // sign-corrected by hand. Deriving it removes both.
        const rightX = -Math.sin(theta);
        const rightY = Math.cos(theta);
        const cz = Math.cos(phi);
        const upX = -Math.sign(cz) * Math.cos(theta);
        const upY = -Math.sign(cz) * Math.sin(theta);
        // 🔴 #20 — PAN BASIS INVARIANTS. The fix that derived these from the
        // lookAt basis (instead of hand-tuned signs) shipped without a
        // regression guard. The invariants below are the guard: a sign flip
        // in either vector reverses the pan direction and is invisible in
        // code review because both (-sinθ, cosθ) and (sinθ, -cosθ) look
        // plausible. Two things to check against:
        //
        //   1. ORTHOGONALITY: right · up = 0. A swap makes them parallel.
        //   2. DEFAULT VALUES: at the initial camera (θ=-π/4, φ=π/3.2):
        //        right ≈ (+0.707, +0.707) — northeast on the bed
        //        up    ≈ (-0.707, +0.707) — northwest on the bed
        //      The OLD wrong code had right ≈ (+0.707, +0.707) and
        //      up ≈ (+0.707, -0.707), which are NOT orthogonal — they were
        //      a reflection, and the pan fought the mouse on one axis.
        //
        // A test that asserts orthogonality for several (θ, φ) pairs is the
        // durable version of this comment. Until then, a reviewer who touches
        // these four lines should verify right · up ≈ 0 at the default angle.
        // World units per CSS pixel at the orbit distance, from the ACTUAL
        // frustum rather than the old magic `radius / 900`.
        /* 🔴 `worldPerPixel(radius, viewH)`, NOT `camera.fov`. An
         * `OrthographicCamera` has no `fov`: the old expression evaluates to
         * `NaN` the moment the mode changes, and a `NaN` pan corrupts `target`
         * with nothing on screen to say why. It is the SAME number in both modes
         * (see `projection.ts`), so perspective behaviour is unchanged — and the
         * comment below about the ACTUAL frustum is still true, more literally
         * than before. */
        const k = worldPerPixel(radius, viewH);
        // Vertical drag crosses a bed that is tilted away from the camera, so a
        // pixel of dy covers 1/|cosφ| times as much bed as a pixel of dx. The
        // factor is capped: at a grazing angle the exact one diverges, and an
        // unbounded pan is worse than one that lags.
        const fore = 1 / Math.max(0.2, Math.abs(cz));
        // SCENE FOLLOWS THE MOUSE — the same direction dragging the SHEET
        // already moves it, so the two gestures do not contradict each other.
        // The cursor's world displacement is dx along right MINUS dy along up
        // (screen y grows downward); moving the scene that way means moving the
        // camera target the other way.
        target.x -= dx * k * rightX - dy * k * fore * upX;
        target.y -= dx * k * rightY - dy * k * fore * upY;
      } else {
        theta -= dx * 0.006;
        phi = Math.min(Math.PI - 0.05, Math.max(0.05, phi - dy * 0.006));
      }
      place();
    };
    const up = () => {
      dragging = false;
      panning = false;
      draggingClamp = null;
      draggingStock = null;
      draggingPart = null;
      // The guides go with the gesture; the READOUT stays. A person releases the
      // button and then looks at what the snap decided — a note that vanished
      // with the pointer would be unreadable exactly when it is wanted.
      state.current.snap = null;
      state.current.applySnapGuides?.();
      // The gesture is over, so the panel comes back at wherever the pointer
      // actually is — no need to move away and return.
      //
      // ⚠ WHICH NUMBERS IT COMES BACK WITH. The pick reads `hoverData`, which
      // the scene effect rewrites on every rebuild, and a drag rebuilds the
      // scene on every step — so by the time a pointerup is dispatched the
      // stash is already the post-drag one. The remaining gap (a release in the
      // same frame as the final move) is closed from the other end: the scene
      // effect calls `repick()` after every rebuild, so a panel that did read
      // one step behind is corrected on the very next frame rather than sitting
      // there as a stale position.
      if (lastPointer) hoverPending = lastPointer;
    };
    // Re-ask the question whenever the DATA changes, not only when the pointer
    // does. Without this the panel keeps whatever it said when the pointer last
    // moved, while the scrubber, a datum field or a re-plan changes the thing
    // it is describing underneath it.
    // Forget everything about the CURRENT hover and ask again. Needed because
    // `hoverKey` is a dedupe latch living out here in the imperative scene,
    // while `setHover(null)` only clears React's copy — so a caller that
    // cleared the panel without clearing the latch got a panel that stayed
    // blank for as long as the pointer kept resolving to the same object.
    //
    // 🔴 Found by a planted defect, not by reading: with hidden layers made
    // pickable on purpose, the test that should have caught it PASSED, because
    // the stale latch was suppressing the very panel the test was looking for.
    // A guard whose failure is masked by a second bug is not a guard.
    state.current.resetHover = () => {
      hoverKey = '';
      clearLit();
      setHover(null);
      state.current.repick?.();
    };
    state.current.repick = () => {
      if (draggingClamp || draggingStock || draggingPart || dragging) return;
      if (lastPointer) hoverPending = lastPointer;
    };
    // Leaving the canvas ends the hover. A panel left describing the last thing
    // the pointer crossed is a stale reading of a live scene.
    const leave = () => {
      up();
      lastPointer = null;
      hoverPending = null;
      if (hoverKey) {
        hoverKey = '';
        clearLit();
        setHover(null);
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      radius = Math.min(9000, Math.max(120, radius * (e.deltaY > 0 ? 1.12 : 0.9)));
      place();
    };
    const ctx = (e: Event) => {
      e.preventDefault();
      if (!props.onContextMenu) return;
      const me = e as MouseEvent;
      const rect = dom.getBoundingClientRect();
      const x = ((me.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((me.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(new THREE.Vector2(x, y), camera);
      // Pick against stock, ghost-workpiece, and clamp objects
      const targets = scene.children.filter(
        (o) => o.visible && (
          o.name === 'stock' ||
          o.name === 'ghost-workpiece' ||
          o.name.startsWith('clamp:')
        )
      );
      const hits = ray.intersectObjects(targets, false);
      if (hits.length > 0) {
        const hit = hits[0].object;
        if (hit.name === 'ghost-workpiece') {
          const idx = scene.children.filter(
            (o) => o.name === 'ghost-workpiece'
          ).indexOf(hit);
          props.onContextMenu({
            x: me.clientX, y: me.clientY,
            object: 'ghost-workpiece',
            workpieceIndex: idx,
          });
        } else if (hit.name.startsWith('clamp:')) {
          props.onContextMenu({
            x: me.clientX, y: me.clientY,
            object: 'clamp',
            clampName: hit.name.slice('clamp:'.length),
          });
        } else {
          props.onContextMenu({ x: me.clientX, y: me.clientY, object: 'stock' });
        }
      } else {
        props.onContextMenu({ x: me.clientX, y: me.clientY, object: 'background' });
      }
    };

    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointerleave', leave);
    dom.addEventListener('wheel', wheel, { passive: false });
    dom.addEventListener('contextmenu', ctx);

    const resize = () => {
      const w = el.clientWidth || 640;
      const h = el.clientHeight || 480;
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

    /* 🔴 FRAMES THIS VIEWPORT ACTUALLY DREW — the observable the pause guard
     * never had, published because the only one available was a PROXY and the
     * proxy is defeated by the program standing still.
     *
     * `tabs.spec.ts` watches `data-tool-probe` to decide whether the render loop
     * stopped and started, and calls that guard *"the entire cost-justification
     * for hiding rather than unmounting"*. MEASURED 2026-08-12 against the
     * `?fixtures=1` program, with counters inside this loop and inside `App`'s
     * playback: the loop pauses and resumes correctly — 43 live frames per 700ms
     * while showing, FOUR then ZERO while the CAD tab is up, and 43 again per
     * 700ms after it comes back. What does NOT move is the marker: the `plate`
     * fixture is multi-tool, its ONE `M0` sits at move 127 of 689, and the report
     * charges **120 seconds** for it (`tool_change_seconds`, declared). At x10
     * the playhead reaches that dwell about 2.8 seconds in and then stands on it
     * for twelve wall-seconds — so every leg of that test after the first is
     * reading a program that is legitimately not moving.
     *
     * ⚠ A frozen marker therefore means *"paused"* and *"waiting for a human to
     * change the tool"* equally well, and the clock control cannot separate them:
     * playback is still RUNNING during a dwell, which is why `play` stays
     * pressed. A frame count separates them because it is a fact about the
     * RENDERER and about nothing in the scene. */
    let framesDrawn = 0;
    const tick = () => {
      state.current.frame = requestAnimationFrame(tick);
      /* 🔴 HIDDEN MEANS IDLE. When this viewport's tab is not showing, the host
       * is `display: none` — which stops nothing on its own: the loop keeps
       * running and `resize()` above falls back to 640x480 when the container
       * measures zero, so the renderer would keep drawing a full-size scene at
       * 60 Hz for a canvas nobody can see.
       *
       * The frame is still SCHEDULED, so the loop resumes the moment the prop
       * clears without anything having to restart it. Everything below is
       * skipped together, deliberately: the probe attributes this publishes
       * (`data-part-probe`, `data-path-probe`, `data-tool-probe`) are SCREEN
       * coordinates, and screen coordinates for a canvas that is not on screen
       * are a measurement of nothing. They freeze at their last on-screen values
       * and are refreshed on the first frame after the tab comes back.
       *
       * `lastTheme` is left alone rather than cleared, so a theme toggled while
       * this tab was hidden is still seen as a CHANGE on the first live frame
       * and the palette is re-resolved then. */
      if (state.current.paused) return;
      // Below the `paused` return, so it counts DRAWN frames and not scheduled
      // ones — a counter above it would tick all the way through a pause and
      // report the opposite of what it is for.
      dom.setAttribute('data-frames', String(++framesDrawn));
      /* 🔴 ONE ENUM COMPARE PER FRAME, on the same idiom as the theme check at
       * the foot of this loop. `place()` rather than `applyProjection()` alone,
       * so the frustum is rebuilt from the CURRENT radius: the two are one
       * operation and calling half of it is how a switch ends up showing a stale
       * frustum.
       *
       * ⚠ IT SITS BELOW THE `paused` RETURN ON PURPOSE. A projection changed
       * while this tab is hidden is applied on the first live frame — the same
       * treatment `lastTheme` gets, and for the same reason: there is nothing to
       * draw yet, and the compare is against the LAST BUILT mode, so a change
       * cannot be missed by having happened at the wrong moment. */
      if (state.current.projection !== builtProjection) place();
      renderer.render(scene, camera);
      // ONE hover cast per frame, whatever the pointer did in between.
      if (hoverPending) {
        const p = hoverPending;
        hoverPending = null;
        const t0 = performance.now();
        const got = pickAt(p.x, p.y);
        // Published so the COST is a measurement anyone can read off the page,
        // not an assurance in a commit message. If picking ever gets slow, this
        // is the number that says so.
        dom.setAttribute('data-hover-ms', (performance.now() - t0).toFixed(2));
        const k = got ? `${got.info.title}|${got.info.rows.map((r) => r.join('=')).join('|')}` : '';
        if (k !== hoverKey) {
          hoverKey = k;
          clearLit();
          if (got) light(got.hit.object);
          setHover(got ? got.info : null);
        }
        const mark = state.current.hoverMark as THREE.Mesh | undefined;
        if (mark) {
          mark.visible = !!got;
          if (got) mark.position.copy(got.hit.point);
        }
      }

      // Where the first drawn CUT segment is ON SCREEN, in canvas CSS pixels —
      // the same reasoning as the rotate handle above. A caller that guesses a
      // point on the toolpath is testing its guess: a miss and a dead hover
      // fail identically. Absent when the cut class is hidden, which is exactly
      // the state a caller needs to be able to check.
      const cut = scene.children.find((o) => o.name === 'path:cut');
      if (cut && cut.visible) {
        const pos = (cut as THREE.LineSegments).geometry.getAttribute('position');
        const v = new THREE.Vector3(
          (pos.getX(0) + pos.getX(1)) / 2,
          (pos.getY(0) + pos.getY(1)) / 2,
          (pos.getZ(0) + pos.getZ(1)) / 2
        ).project(camera);
        const s = `${((v.x * 0.5 + 0.5) * viewW).toFixed(1)},${((-v.y * 0.5 + 0.5) * viewH).toFixed(1)}`;
        if (dom.getAttribute('data-path-probe') !== s) dom.setAttribute('data-path-probe', s);
      } else if (dom.hasAttribute('data-path-probe')) {
        dom.removeAttribute('data-path-probe');
      }

      // Where the LOADED OBJECT is on screen, in canvas CSS pixels — the same
      // pattern and the same reason as the three probes around it. Without one,
      // a caller wanting to DRAG the part has to guess a point on a 3D object
      // under a camera it does not model, and a miss and a dead drag handler
      // fail identically. That cost a day on the rotate handle; this exists so
      // it cannot cost it again here.
      //
      // 🔴 It is the point on the object the raycaster would actually hit — the
      // centre of its WORLD bounding box, projected — so a caller that clicks it
      // is clicking the same geometry the pick tests, not a coordinate this file
      // computed some other way. Absent when nothing draggable is drawn, which
      // is exactly the state a test needs to be able to assert.
      //
      // 🔴 PER INSTANCE, because there is no longer "the" loaded object. With
      // several drawings on the sheet a single published point cannot say WHICH
      // part it is a point on, so a test that dragged it could not tell "the
      // right part moved" from "a part moved". The keys are the core's own
      // instance ids — the same strings the program names its parts with and the
      // same ones a refusal quotes — so an assertion can name the part the way
      // the operator sees it named.
      const boxes = new Map<string, THREE.Box3>();
      /* The SAME target list the drag builds in `down()` — every visible
       * `loaded`/`walls` object, keyed or not. It is what makes the published
       * point a fact about the pick rather than about this loop: a candidate is
       * only published once a ray through it comes back with THIS instance
       * nearest, which is exactly the question `down()` asks. Unkeyed objects
       * are in it as OCCLUDERS for the same reason they are in `down()`'s. */
      const partTargets: THREE.Object3D[] = [];
      const partObjs = new Map<string, THREE.Object3D[]>();
      if (state.current.partDrag) {
        for (const o of scene.children) {
          if (o.name !== 'loaded' && o.name !== 'walls') continue;
          if (!o.visible) continue;
          partTargets.push(o);
          const id = o.userData.instance as string | undefined;
          // An unkeyed object is deliberately absent from this table rather than
          // filed under a placeholder: it is not grabbable, and publishing a
          // grab point for it would advertise a drag that refuses.
          if (!id) continue;
          const bb = new THREE.Box3().setFromObject(o);
          const seen = boxes.get(id);
          if (seen) seen.union(bb);
          else boxes.set(id, bb);
          const objs = partObjs.get(id);
          if (objs) objs.push(o);
          else partObjs.set(id, [o]);
        }
      }
      const asBbox = (bb: THREE.Box3) =>
        `${bb.min.x.toFixed(2)},${bb.min.y.toFixed(2)},` +
        `${bb.max.x.toFixed(2)},${bb.max.y.toFixed(2)}`;
      const onScreen = (p: THREE.Vector3) => {
        const v = p.clone().project(camera);
        return `${((v.x * 0.5 + 0.5) * viewW).toFixed(1)},${((-v.y * 0.5 + 0.5) * viewH).toFixed(1)}`;
      };
      /*
       * 🔴 A GRAB POINT IS PUBLISHED ONLY ONCE A RAY THROUGH IT RESOLVES TO THIS
       * PART. Until 2026-08-12 this function projected the centre of the world
       * bounding box and stopped there, over a comment claiming the result was
       * *"the point on the object the raycaster would actually hit"*. That is
       * true of a SOLID and false of everything else, and the everything else is
       * this tool's own primary input:
       *
       *   · An STL import draws a `loaded` mesh. Its bbox centre is inside the
       *     material, a ray to it lands on the top face, and the drag works —
       *     which is why the STL drag test has passed all along.
       *   · A DXF import draws `walls`: a RIBBON standing on the contour, open
       *     at the top and hollow inside. Its bbox centre is in FRESH AIR over
       *     the middle of the part, and the ray sails through it to the SHEET
       *     UNDERNEATH.
       *
       * MEASURED in the browser (plate.dxf, 1000x800 sheet, 2026-08-12): hover
       * at the published point named the *Workpiece*; a drag there moved the
       * SHEET DATUM 0,0 -> 134.1,7.1 while the part stood still, and the clamps
       * and the touch plate do not move with the datum. A 4px scan of the whole
       * plate found THREE points that hit the drawing; the same gesture 8px away
       * on one of them moved the PART by the same 134.1,7.1 and left the datum
       * alone. So the pick tiers were right and the advertised point was wrong —
       * the caller aimed where it was told to aim, and re-referenced the program.
       *
       * ⚠ THE BBOX CENTRE IS STILL TRIED FIRST, on purpose. It is the point
       * every currently-green assertion was written against, so a solid keeps
       * publishing the identical string; the fallback only runs where the old
       * answer was a miss. Candidates after it are triangle centroids of the
       * instance's own geometry, NEAREST TO THE CAMERA first — the surface a
       * ray reaches before any of the object's other faces.
       *
       * ⚠ `Line.threshold = 0` on this raycaster, so only MESH hits verify a
       * point. `down()` raycasts with the shared instance whose line threshold
       * is whatever the last hover left on it; a point that needs a fat line to
       * be hit is therefore a point whose grabbability depends on where the
       * pointer has been. Publishing only mesh-verified points removes that
       * dependency instead of inheriting it.
       */
      const probeRay = new THREE.Raycaster();
      probeRay.params.Line.threshold = 0;
      const probeNdc = new THREE.Vector2();
      /** Triangle centroids of one mesh, in ITS OWN coordinates, capped and
       *  cached. Local rather than world: geometry never changes under an
       *  object, but a transform can, and a cached world point would go stale
       *  silently — the failure this whole block is about. */
      const localCentroids = (o: THREE.Object3D): THREE.Vector3[] => {
        const cached = o.userData.probeCentroids as THREE.Vector3[] | undefined;
        if (cached) return cached;
        const mesh = o as THREE.Mesh;
        const geo = mesh.geometry as THREE.BufferGeometry | undefined;
        const out: THREE.Vector3[] = [];
        if (mesh instanceof THREE.Mesh && geo) {
          const pos = geo.getAttribute('position');
          const idx = geo.getIndex();
          const tris = Math.floor((idx ? idx.count : pos.count) / 3);
          // At most 64 per object: this runs per frame, and a ribbon around a
          // dense contour is thousands of triangles for a question that needs a
          // handful of well-spread candidates.
          const step = Math.max(1, Math.ceil(tris / 64));
          for (let t = 0; t < tris; t += step) {
            const a = idx ? idx.getX(t * 3) : t * 3;
            const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
            const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
            out.push(
              new THREE.Vector3(
                (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3,
                (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3,
                (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3
              )
            );
          }
        }
        o.userData.probeCentroids = out;
        return out;
      };
      /** Does a ray through this world point come back with `id` nearest? */
      const resolvesTo = (id: string, p: THREE.Vector3) => {
        const v = p.clone().project(camera);
        if (!Number.isFinite(v.x) || Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) return false;
        probeRay.setFromCamera(probeNdc.set(v.x, v.y), camera);
        const hits = probeRay.intersectObjects(partTargets, false);
        return hits.length > 0 && hits[0].object.userData.instance === id;
      };
      const asProbe = (id: string, bb: THREE.Box3): string | null => {
        const centre = bb.getCenter(new THREE.Vector3());
        if (resolvesTo(id, centre)) return onScreen(centre);
        const cam = camera.position;
        const cands: THREE.Vector3[] = [];
        for (const o of partObjs.get(id) ?? []) {
          o.updateWorldMatrix(true, false);
          for (const c of localCentroids(o)) cands.push(c.clone().applyMatrix4(o.matrixWorld));
        }
        cands.sort((a, b) => a.distanceToSquared(cam) - b.distanceToSquared(cam));
        // A bounded number of tries: if a dozen nearest points are all occluded
        // by another part or a clamp, the honest answer is that this instance
        // has no reachable grab point right now — which is published as the
        // attribute being ABSENT, not as a point that refuses.
        for (const p of cands.slice(0, 12)) if (resolvesTo(id, p)) return onScreen(p);
        return null;
      };
      const put = (name: string, value: string | null) => {
        if (value === null) {
          if (dom.hasAttribute(name)) dom.removeAttribute(name);
        } else if (dom.getAttribute(name) !== value) {
          dom.setAttribute(name, value);
        }
      };
      // JSON, not a delimited list, because an instance id is a FILE-DERIVED
      // string: it may carry a space, a `#`, a comma or a semicolon, and a
      // delimiter that appears inside a key silently splits one part into two.
      const bboxes: Record<string, string> = {};
      const probes: Record<string, string> = {};
      for (const [id, bb] of boxes) {
        bboxes[id] = asBbox(bb);
        // ⚠ An instance with no reachable grab point is ABSENT from the probe
        // table while it is still present in the box table — the two tables
        // answering different questions, which is what they are for. A caller
        // that compares their key sets sees the difference instead of reading a
        // point that does not grab anything.
        const at = asProbe(id, bb);
        if (at) probes[id] = at;
      }
      put('data-part-bboxes', boxes.size ? JSON.stringify(bboxes) : null);
      put('data-part-probes', boxes.size ? JSON.stringify(probes) : null);

      // The SELECTED instance keeps the two single-part attributes exactly as
      // they were, so a page with one drawing publishes what it always did and
      // every existing assertion still means the same thing. With one drawing
      // the selection IS the only drawing; with several it is the one the panel
      // is talking about, which is what a caller reading a single point wants.
      //
      // ⚠ It falls back to the sole entry when nothing is selected, and to
      // NOTHING when there are several: a point that silently means "whichever
      // came first" is the ambiguity this whole change is removing.
      const selId = state.current.selectedInstance as string | null | undefined;
      const sole = boxes.size === 1 ? [...boxes.keys()][0] : null;
      const single = (selId && boxes.has(selId) ? selId : sole) ?? null;
      // 🔴 `data-part-bbox` is the DRAWN object's own world box in bed
      // millimetres — the one number that makes "the picture agrees with the
      // program" checkable from outside. `data-part-probe` is a screen point and
      // moves when the CAMERA moves; this does not. Without it, a mesh left at
      // its raw model coordinates — which is what shipped until 2026-08-09 — is
      // invisible to every test in the suite.
      put('data-part-probe', (single ? probes[single] : null) ?? null);
      put('data-part-bbox', single ? bboxes[single] : null);
      // Which instance those two are ABOUT. Without it a caller reading them on
      // a multi-drawing sheet cannot tell which part it measured, and a true
      // number about the wrong part reads exactly like a finding.
      put('data-part-selected', single);


      // Where the TOOL MARKER is on screen, in canvas CSS pixels — the third of
      // the same pattern, added for the same reason the other two were: without
      // it the only way to find the marker was to sample the canvas for its
      // teal, which finds a COLOUR rather than an object and goes quietly wrong
      // the moment anything else in the scene is that colour.
      //
      // 🔴 The point published is the MIDDLE OF THE CUTTING SOLID, not the tip.
      // The tip sits exactly on the head coordinate, which is also the end of
      // the drawn toolpath — so a probe there is a point where the tool and the
      // path overlap, and a caller could hover it, hit the path, and conclude
      // the marker was missing.
      //
      // 🔴 ABSENT WHEN NO CUTTER IS DRAWN, which is the state that matters: a
      // refused marker (no diameter, no tool, not told) draws a dashed
      // PLACEHOLDER cage, and publishing a position for that would hand a
      // caller a point on a shape that is explicitly not a cutter. Absence is
      // the checkable form of the refusal.
      const tw = state.current.toolWorld as THREE.Vector3 | null | undefined;
      if (tw) {
        const v = tw.clone().project(camera);
        const s = `${((v.x * 0.5 + 0.5) * viewW).toFixed(1)},${((-v.y * 0.5 + 0.5) * viewH).toFixed(1)}`;
        if (dom.getAttribute('data-tool-probe') !== s) dom.setAttribute('data-tool-probe', s);
      } else if (dom.hasAttribute('data-tool-probe')) {
        dom.removeAttribute('data-tool-probe');
      }

      // Re-resolve the palette when the THEME changes, keyed on the attribute
      // that actually drives it. Reading `dataset.theme` is a property read,
      // not a style recalc, so this costs nothing per frame.
      //
      // 🔴 It is deliberately NOT keyed on the `dark` prop. React runs a child's
      // effects BEFORE its parent's, and it is `App`'s effect that writes
      // `documentElement.dataset.theme` — so at the moment this component's
      // scene effect runs, the custom properties still resolve to the OLD
      // theme. Reading them there would leave the 3D scene one toggle behind
      // the panels around it, which looks exactly like a hardcoded palette.
      const theme = document.documentElement.dataset.theme ?? '';
      if (theme !== lastTheme) {
        lastTheme = theme;
        state.current.applyPalette?.();
      }
    };
    tick();

    // Expose the camera framing helper so a data change can re-frame.
    state.current.frameScene = (sx: number, sy: number) => {
      target = new THREE.Vector3(sx / 2, sy / 2, 0);
      radius = Math.max(sx, sy) * 1.5;
      place();
    };

    return () => {
      if (state.current.frame) cancelAnimationFrame(state.current.frame);
      ro.disconnect();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointerleave', leave);
      dom.removeEventListener('wheel', wheel);
      dom.removeEventListener('contextmenu', ctx);
      renderer.dispose();
      el.removeChild(dom);
      el.removeChild(probe);
    };
  }, []);

  // --- scene contents ------------------------------------------------------
  useEffect(() => {
    const { scene } = state.current;
    if (!scene) return;

    // Drop anything from the previous build. Meshes and geometries are disposed
    // explicitly — a viewport that leaks a geometry per re-plan will exhaust
    // GPU memory during an editing session, which reads as "the app got slow"
    // rather than as a bug.
    for (const d of state.current.dispose) d();
    state.current.dispose = [];
    for (const o of [...scene.children]) {
      if (o instanceof THREE.Light) continue;
      scene.remove(o);
    }

    const [sx, sy, sz] = props.stock;
    const [tx, ty] = props.travel;

    const track = <T extends { dispose(): void }>(x: T) => {
      state.current.dispose.push(() => x.dispose());
      return x;
    };

    /* ═══ TWO RECTANGLES, AND THEY ARE NOT THE SAME THING ═══════════════════
     *
     * 🔴 UNTIL 2026-08-10 THERE WAS ONE, AND IT WAS THE WRONG ONE. This block
     * built `PlaneGeometry(tx, ty)` — the machine's TRAVEL — as a lit, shadow-
     * receiving solid named `bed` and labelled *"table / bed"*. So the volume
     * the cutter can REACH was drawn as the OBJECT THE WORK LIES ON, and the
     * picture asserted sacrificial material under every point the axes can get
     * to. That is exactly the assumption `core/src/sim.rs` stopped making the
     * same day: an absent spoilboard is NOT a spoilboard covering everything,
     * and the difference between the two is a through-cut versus a 2.2 kW
     * spindle driving a cutter into a rail.
     *
     * So, in order:
     *
     *   travel      an OUTLINE. A limit. Nothing sits on it, nothing is cut
     *               into it, and it casts and receives nothing.
     *   spoilboard  a SOLID, drawn only when one is DECLARED, at the rectangle
     *               the core echoed back — its own size, at its own corner, and
     *               since 2026-08-11 with its own DEPTH when one is declared.
     *   bare strips the reach the board does not cover, shaded as a warning,
     *               from `spoilboard_bare_reach`, which is the CORE'S
     *               subtraction and not one done here.
     *
     * ⚠ With no board declared there is no ground plane and therefore no
     * shadow. That is the honest picture and it is deliberately not papered
     * over: a surface drawn under the work is a claim that there is one.
     */
    //
    // ⚠ `bedZ` IS THE OUTLINE'S PLANE, NOT THE BOARD'S. It is `-sz - 2`, and
    // `docs/design-87-z-datum.md` filed the 2 as *"a z-fight dodge"* with no
    // comment explaining it — which was true while the board was drawn on this
    // same plane. It is no longer: the board now sits at its own
    // `top_face_z_mm` (see `boardSlab`), and the travel outline keeps this
    // plane because the travel envelope HAS no true Z — it is a limit, nothing
    // sits on it, and drawing it a couple of millimetres clear of the material
    // is a picture decision about a thing with no surface rather than an
    // assertion about where anything is.
    const bedZ = -sz - 2;

    // --- travel: a boundary, drawn as line work -----------------------------
    const travelGeo = track(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, bedZ),
        new THREE.Vector3(tx, 0, bedZ),
        new THREE.Vector3(tx, ty, bedZ),
        new THREE.Vector3(0, ty, bedZ),
        new THREE.Vector3(0, 0, bedZ),
      ])
    );
    const travelMat = track(new THREE.LineBasicMaterial({}));
    const travelLine = new THREE.Line(travelGeo, travelMat);
    travelLine.name = 'travel';
    scene.add(travelLine);

    // --- spoilboard: the only rectangle here made of anything ---------------
    //
    // 🔴 NO FALLBACK. `props.spoilboard == null` draws nothing at all — not a
    // faint plane, not a dashed hint, not `tx x ty`. The panel says "not
    // declared — position UNCHECKED" in words; the canvas says it by having
    // nothing there, which is the same answer and cannot be misread as a board
    // with the contrast turned down.
    const board = props.spoilboard ?? null;
    const bx = Number(board?.x_mm ?? NaN);
    const by = Number(board?.y_mm ?? NaN);
    const bw = Number(board?.size_x_mm ?? NaN);
    const bh = Number(board?.size_y_mm ?? NaN);
    // Every number checked before anything is drawn. A NaN corner puts a plane
    // at the world origin in three.js and renders as a board somewhere nobody
    // declared — the exact "rectangle in the wrong place" the core refuses to
    // substitute. `boardSlab` applies the same test and then answers the second
    // question — how deep, if at all — in the one place that owns the core's
    // two Z formulae.
    const slab = boardSlab(board, sz);
    const boardOk = slab.state !== 'none';
    // 🔴 THE VERDICT, READ OFF THE WORD. `depth.verdict` — never
    // `through_board > 0` — decides what colour the board is painted below.
    const depth = readBoardDepth(props.boardDepth);
    const boardMats: THREE.MeshStandardMaterial[] = [];
    const boardUnknownMats: THREE.LineDashedMaterial[] = [];
    if (boardOk) {
      const topZ = slab.topZMm as number;
      // 🔴 THE TWO PICTURES, AND THEY MUST NOT BE CONFUSABLE AT A GLANCE.
      //
      //   slab              a BOX: top face at `top_face_z_mm`, underside at
      //                     `underside_z_mm`, and the sides that exist between
      //                     them. You can see how thick the board is.
      //   unknown-thickness the flat PLANE this scene has always drawn — no
      //                     bottom face and no side walls, because there is no
      //                     measured depth to draw them from — plus a dashed
      //                     edge (below) that a solid slab never has.
      const geo = track(
        slab.state === 'slab'
          ? new THREE.BoxGeometry(bw, bh, slab.thicknessMm as number)
          : new THREE.PlaneGeometry(bw, bh)
      );
      const mat = track(
        new THREE.MeshStandardMaterial({
          side: THREE.DoubleSide,
          flatShading: true,
          roughness: 0.95,
          metalness: 0,
          // The board's top face is now EXACTLY the workpiece's underside —
          // that is what `top_face_z_mm` says, and the drag plane at
          // `state.bedZ` has always used it. Two coplanar faces z-fight, so the
          // board is biased in the DEPTH BUFFER rather than moved in Z: a
          // renderer setting changes no coordinate, and the 2mm nudge this
          // block used to carry was a coordinate that disagreed with the core.
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        })
      );
      boardMats.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(
        bx + bw / 2,
        by + bh / 2,
        // A plane sits ON the top face; a box hangs BELOW it by half its
        // thickness, so its own top face lands there.
        slab.state === 'slab' ? topZ - (slab.thicknessMm as number) / 2 : topZ
      );
      mesh.receiveShadow = true;
      mesh.name = 'spoilboard';
      scene.add(mesh);

      // --- the marker that says UNKNOWN --------------------------------------
      //
      // 🔴 A BOARD OF UNKNOWN DEPTH MUST NOT MERELY BE A THINNER SLAB. It is a
      // plane, and a plane alone reads as "the board is 0mm" or as "the board
      // is however deep the last one was". So its perimeter is traced with a
      // DASHED line — the one thing a solid slab's silhouette never has — in
      // the muted token this app already uses for a fact it does not hold.
      // The words are in the hover panel and in the layer's own title; this is
      // what a glance gets.
      if (slab.state === 'unknown-thickness') {
        const ring = track(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(bx, by, topZ),
            new THREE.Vector3(bx + bw, by, topZ),
            new THREE.Vector3(bx + bw, by + bh, topZ),
            new THREE.Vector3(bx, by + bh, topZ),
            new THREE.Vector3(bx, by, topZ),
          ])
        );
        const rmat = track(
          new THREE.LineDashedMaterial({
            dashSize: Math.max(4, Math.min(bw, bh) / 40),
            gapSize: Math.max(3, Math.min(bw, bh) / 55),
          })
        );
        boardUnknownMats.push(rmat);
        const line = new THREE.Line(ring, rmat);
        // Without this the dash pattern is never computed and the line draws
        // SOLID — the marker silently becoming the thing it is distinguished
        // from, with nothing on screen to say so.
        line.computeLineDistances();
        // Same name family as the board so `applyVis` hides them together and
        // the pick lists treat a hover on the edge as a hover on the board.
        line.name = 'spoilboard-unknown';
        scene.add(line);
      }
    }

    // --- the reach the board does NOT cover ---------------------------------
    //
    // 🔴 FROM THE REPORT, NOT SUBTRACTED HERE. `[X-, X+, Y-, Y+]` is the core's
    // own `Spoilboard::bare_reach`, and `null` versus `[0,0,0,0]` is the
    // distinction the whole field exists to carry: no board at all, versus a
    // board that covers everywhere the cutter can go. Only the second is a
    // machine with nothing exposed, and only the first draws nothing.
    const bare = props.spoilboardBareReach ?? null;
    const bareMats: THREE.MeshBasicMaterial[] = [];
    if (boardOk && bare && bare.some((v) => Number.isFinite(v) && v > 0)) {
      const [mxr, pxr, myr, pyr] = bare.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
      // The Y strips are inset to the span the X strips do not already take, so
      // two translucent quads never stack at a corner. A doubled tint would read
      // as "worse here", which is a claim nothing measured.
      const innerX0 = mxr;
      const innerX1 = Math.max(mxr, tx - pxr);
      const strips: [number, number, number, number][] = [
        [0, 0, mxr, ty],
        [Math.max(0, tx - pxr), 0, pxr, ty],
        [innerX0, 0, Math.max(0, innerX1 - innerX0), myr],
        [innerX0, Math.max(0, ty - pyr), Math.max(0, innerX1 - innerX0), pyr],
      ];
      for (const [x, y, w, h] of strips) {
        if (!(w > 0) || !(h > 0)) continue;
        const geo = track(new THREE.PlaneGeometry(w, h));
        // Unlit and translucent ON PURPOSE: this is not material, it is the
        // ABSENCE of material — hatching over bare machine. Shading it like a
        // surface would make the thing being warned about look like the thing
        // that is safe.
        const mat = track(
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, side: THREE.DoubleSide })
        );
        bareMats.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        // ⚠ THE STRIP IS ON THE TRAVEL OUTLINE'S PLANE, NOT THE BOARD'S — it is
        // `bedZ - 0.05`, so 2.05mm below `top_face_z_mm`, and that is correct
        // rather than a leftover: the strip marks reach with NO board under it,
        // and a rectangle with no board has no top face to sit on. Drawing it at
        // the board's plane would put sacrificial-material geometry where the
        // report says there is none.
        //
        // 🔴 THIS COMMENT USED TO READ *"a hair below the board"*, and it was
        // true until `91f40f5fe3` moved the board's top face from `-sz - 2` to
        // exactly `-sz` 34 minutes after it was written. The code was right
        // through both; only the sentence went stale — and it is the sentence a
        // later reader would have used to conclude the strip was 0.05mm out.
        mesh.position.set(x + w / 2, y + h / 2, bedZ - 0.05);
        mesh.name = 'spoilboard-bare';
        scene.add(mesh);
      }
    }

    // The key light follows the BED, and its shadow frustum is sized to it. A
    // light left at a fixed world position throws the machine out of its own
    // shadow camera the moment the travel grows, and the shadows just stop —
    // silently, which looks like a style choice rather than a broken frustum.
    const keyLight = state.current.key as THREE.DirectionalLight | undefined;
    if (keyLight) {
      const reach = Math.max(tx, ty);
      keyLight.position.set(tx / 2 + reach * 0.5, ty / 2 - reach * 0.7, reach * 1.1 + 200);
      keyLight.target.position.set(tx / 2, ty / 2, 0);
      keyLight.target.updateMatrixWorld();
      const cam = keyLight.shadow.camera;
      cam.left = -reach * 0.8;
      cam.right = reach * 0.8;
      cam.top = reach * 0.8;
      cam.bottom = -reach * 0.8;
      cam.near = 1;
      cam.far = reach * 4 + 1000;
      cam.updateProjectionMatrix();
    }

    // GridHelper bakes its two colours into a vertex-colour attribute at
    // construction, so a repaint means a rebuild rather than a material tweak.
    // The disposer reads the LIVE `grid`, so whichever one is current when the
    // scene is next torn down is the one that gets freed.
    let grid: THREE.GridHelper | null = null;
    state.current.dispose.push(() => {
      grid?.geometry.dispose();
      (grid?.material as THREE.Material | undefined)?.dispose();
    });
    const buildGrid = (major: THREE.Color, minor: THREE.Color) => {
      if (grid) scene.remove(grid);
      const old = grid;
      grid = new THREE.GridHelper(Math.max(tx, ty), Math.round(Math.max(tx, ty) / 100), major, minor);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(tx / 2, ty / 2, -sz - 1.5);
      // Named so it hides WITH the reach outline — it is the same fact drawn
      // twice, a ruled version of the limits. It is rebuilt on a theme change,
      // and a rebuild resets `visible` to true, so the new one is given the
      // current state rather than reappearing under a switched-off layer.
      grid.name = 'travel-grid';
      grid.visible = visRef.current.travel !== false;
      scene.add(grid);
      old?.geometry.dispose();
      (old?.material as THREE.Material | undefined)?.dispose();
    };

    // Stock. Z = 0 is the top face, so the block hangs below.
    const stockGeo = track(new THREE.BoxGeometry(sx, sy, sz));
    const stockMat = track(
      new THREE.MeshStandardMaterial({
        transparent: true,
        opacity: 0.55,
        flatShading: true,
        roughness: 0.85,
        metalness: 0,
        // 🔴 THE TOP FACE IS THIS SCENE'S z = 0, so it is coplanar with
        // everything else drawn AT the datum — the origin triad's flat X and Y
        // arrows, and any future line at the work zero. Coplanar geometry has no
        // depth answer, and the shimmer that produces reads as a feature.
        //
        // Pushed a hair AWAY from the camera in DEPTH ONLY, so whatever is drawn
        // at the datum wins. No vertex moves: the workpiece is still exactly as
        // thick as it was declared, which matters because its top face is the
        // surface every Z in the program is measured from.
        //
        // ⚠ THIS IS THE SAME MECHANISM AS THE SIMULATED SURFACE'S HALO FIX, in
        // the mirror direction — that one biases ITSELF toward the camera by 1,
        // this biases the face it sits on away by 1, and they compose rather
        // than cancel. It is on the face and not on the triad because WebGL
        // exposes `POLYGON_OFFSET_FILL` only: a `THREE.Line` cannot be biased,
        // so the only thing left to move is the polygon it fights.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      })
    );
    // 🔴 The sheet is drawn WHERE IT ACTUALLY IS: at its datum, laid at its
    // angle. It used to be drawn at the origin unconditionally while the
    // TOOLPATH was drawn at the placed coordinates the core emitted — so a
    // moved or turned sheet showed the cut sitting off the board. The picture
    // and the program have to agree, or the picture is worse than none.
    const [ox, oy] = props.stockOrigin ?? [0, 0];
    const rot = ((props.stockRotationDeg ?? 0) * Math.PI) / 180;
    // Same push-back the core applies: rotate about the datum corner, then
    // shift the rotated sheet so its own bounding corner sits on the datum.
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const cornersXY = [
      [0, 0],
      [sx * cs, sx * sn],
      [-sy * sn, sy * cs],
      [sx * cs - sy * sn, sx * sn + sy * cs],
    ];
    const minX = Math.min(...cornersXY.map((c) => c[0]));
    const minY = Math.min(...cornersXY.map((c) => c[1]));
    const centreLocal = [sx / 2, sy / 2];
    const centre = [
      centreLocal[0] * cs - centreLocal[1] * sn - minX + ox,
      centreLocal[0] * sn + centreLocal[1] * cs - minY + oy,
    ];

    const stock = new THREE.Mesh(stockGeo, stockMat);
    stock.position.set(centre[0], centre[1], -sz / 2);
    stock.rotation.z = rot;
    stock.name = 'stock';
    stock.castShadow = true;
    stock.receiveShadow = true;
    scene.add(stock);

    // Ghost outlines for other workpieces (inactive ones on the table).
    if (props.otherWorkpieces) {
      for (const wp of props.otherWorkpieces) {
        const ghostGeo = track(new THREE.BoxGeometry(wp.stockX, wp.stockY, sz));
        const ghostEdges = track(new THREE.EdgesGeometry(ghostGeo));
        const ghostLine = new THREE.LineSegments(
          ghostEdges,
          new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.4 })
        );
        const gcs = Math.cos(((wp.rotation ?? 0) * Math.PI) / 180);
        const gsn = Math.sin(((wp.rotation ?? 0) * Math.PI) / 180);
        const gcorners = [
          [0, 0],
          [wp.stockX * gcs, wp.stockX * gsn],
          [-wp.stockY * gsn, wp.stockY * gcs],
          [wp.stockX * gcs - wp.stockY * gsn, wp.stockX * gsn + wp.stockY * gcs],
        ];
        const gminX = Math.min(...gcorners.map((c) => c[0]));
        const gminY = Math.min(...gcorners.map((c) => c[1]));
        const gcentre = [
          (wp.stockX / 2) * gcs - (wp.stockY / 2) * gsn - gminX + (wp.originX ?? 0),
          (wp.stockX / 2) * gsn + (wp.stockY / 2) * gcs - gminY + (wp.originY ?? 0),
        ];
        ghostLine.position.set(gcentre[0], gcentre[1], -sz / 2);
        ghostLine.rotation.z = ((wp.rotation ?? 0) * Math.PI) / 180;
        ghostLine.name = 'ghost-workpiece';
        scene.add(ghostLine);
      }
    }

    /* 🔴 WHERE THE SHEET WAS ACTUALLY DRAWN, beside the datum it was drawn FROM.
     * Added 2026-08-10 for the founder's third report — *"I move the object in
     * the canvas, the numbers change on the left navbar but the object does not
     * move"*. That is a claim about the picture disagreeing with the state, and
     * nothing in this app could measure it: `data-part-bbox` covers the loaded
     * object, and the sheet — the object he named — had no probe at all.
     *
     * TWO numbers, and the pair is the diagnostic. `datum` is
     * `props.stockOrigin` as this build received it; `at` is the corner the
     * drawn mesh ended up on, taken from the mesh's own world box rather than
     * from the arithmetic above, so the two are independent derivations. They
     * disagree if the mesh was positioned from something other than the datum;
     * they AGREE while the screen still looks wrong if the datum never reached
     * this component — a different fault with a different owner, and one number
     * could not tell them apart.
     *
     * ⚠ So there are THREE values to line up, not two: the panel's `origin-x` /
     * `origin-y` fields, the `datum` printed here, and the `at`. Panel vs datum
     * is "did the state reach the viewport"; datum vs at is "did the picture
     * follow it". At a datum of 0,0 all three read zero and the pair proves
     * nothing — move the sheet before believing it.
     *
     * ⚠ Published from the BUILD, not from the animation frame, and that is
     * deliberate: `requestAnimationFrame` does not run in a background tab, so
     * every probe in the frame loop is unreadable exactly when someone is
     * inspecting a page they are not looking at. This one answers whenever the
     * scene was last built. */
    state.current.renderer?.domElement.setAttribute(
      'data-stock-xy',
      (() => {
        const sbb = new THREE.Box3().setFromObject(stock);
        return `datum ${ox.toFixed(2)},${oy.toFixed(2)} at ${sbb.min.x.toFixed(2)},${sbb.min.y.toFixed(2)}`;
      })()
    );
    const edgeGeo = track(new THREE.EdgesGeometry(stockGeo));
    const edgeMat = track(new THREE.LineBasicMaterial());
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.position.copy(stock.position);
    edges.rotation.z = rot;
    edges.name = 'stock-edges';
    scene.add(edges);

    // The sheet's AXIS-ALIGNED extent measured FROM ITS DATUM. The core's
    // push-back puts the rotated sheet's own bounding corner on the datum, so
    // the extent is exactly [ox, ox+extW] x [oy, oy+extH] — which is what lets
    // the snap reason in corner coordinates without inventing a second
    // placement model to disagree with `Stock`'s.
    //
    // ⚠ At an angle that is not a quarter turn this is the sheet's BOUNDING
    // BOX, which is bigger than the sheet. An edge snap against it is therefore
    // conservative rather than exact, and the readout says which line it took.
    const extW = Math.abs(sx * cs) + Math.abs(sy * sn);
    const extH = Math.abs(sx * sn) + Math.abs(sy * cs);

    // 🔴 THE DRAWING FRAME -> BED TRANSFORM, taken from the CORE and not rebuilt
    // here. `props.drawing` and `props.loadedMesh` are the imported geometry in
    // its own millimetres; `props.moves` is machine coordinates. This component
    // used to draw both raw, so the walls and the loaded solid stood at the
    // machine origin while the sheet above was drawn at its datum — any datum
    // or rotation left the object standing beside the board.
    //
    // ⚠ It is a MATRIX built from the four reported terms, not `rotation.z`
    // recovered with `atan2`. Recovering an angle and re-deriving a rotation
    // from it is this file writing the placement rule a second time, which is
    // exactly how the sheet-fit rule ended up orientation-blind in TypeScript.
    // Given the terms, the arithmetic is a copy; given an angle, it is a guess.
    const P = props.drawingPlacement ?? NO_PLACEMENT;
    const drawingToBed = new THREE.Matrix4().set(
      P.cos, P.row_y[0], 0, P.dx_mm,
      P.sin, P.row_y[1], 0, P.dy_mm,
      0,     0,          1, 0,
      0,     0,          0, 1
    );
    /** Put an object whose GEOMETRY is in drawing millimetres onto the bed.
     *  `local` is an extra transform inside the drawing frame — a plane that
     *  knows where it sits but whose vertices are centred on the origin. */
    const inDrawingFrame = (o: THREE.Object3D, local?: THREE.Matrix4) => {
      o.matrixAutoUpdate = false;
      o.matrix.copy(local ? drawingToBed.clone().multiply(local) : drawingToBed);
      // Composed now rather than at the next render: `pickAt` raycasts against
      // `matrixWorld`, and a hover or a grab can happen before a frame is drawn.
      o.updateMatrixWorld(true);
    };
    /* The transform every DRAWING-FRAME object was drawn under — the core's own
     * `Report.drawing_placement`, as this build received it, published beside
     * `data-stock-xy` and for the same reason.
     *
     * 🔴 It is the other half of the same question, and it is the half that was
     * actually wrong on the founder's page. Measured at the CLI 2026-08-10: a
     * REFUSED plan returns the IDENTITY (`dx 0, dy 0`) whatever the datum is —
     * `import plate.dxf --config '{"stock":{"origin_x_mm":37,"origin_y_mm":11}}'`
     * with no tool gives `ok:false` with `dx_mm 0, dy_mm 0`, while the same call
     * naming a tool gives `dx_mm 37, dy_mm 11`. So on a refused sheet every
     * drawing-frame object is drawn at the MACHINE ORIGIN and stops following
     * the datum and the part offsets: the panel numbers move and the object does
     * not. Nothing here invents a placement to cover that — this file is
     * forbidden from re-deriving the placement rule, which is why the state is
     * published to be read rather than patched. */
    state.current.renderer?.domElement.setAttribute(
      'data-drawing-placement',
      `${P.dx_mm.toFixed(2)},${P.dy_mm.toFixed(2)} basis ${P.cos.toFixed(3)},${P.sin.toFixed(3)}`
    );
    state.current.drawingToBed = drawingToBed;
    /* ⚠ `partDrag` USED TO BE PUBLISHED HERE and is now published from the
     * component body, on every render — see the block beside `state.current
     * .paused`. It was moved because it is not scene geometry and never was:
     * publishing it from an effect that no longer runs on every render would
     * hand the pointer handlers a handler from an older render. */
    /* Where each named drawing currently is, so a drag can be measured from the
     * part's own position rather than from the selected one's. A MAP keyed by
     * the core's instance id — the same key the scene objects carry — so there
     * is no second ordering for the two to disagree about. */
    state.current.partOffsets = new Map(
      (props.partInstances ?? []).map((d) => [d.instance, d.offset] as const)
    );
    state.current.selectedInstance = props.selectedInstance ?? null;

    // ⚠ `stockDrag` moved to the component body with `partDrag` above — same
    // reason: it is pointer wiring, not geometry.
    state.current.stockExtent = [extW, extH];
    state.current.stockOrigin = [ox, oy];
    state.current.stockCentre = [centre[0], centre[1]];
    state.current.stockRotationDeg = props.stockRotationDeg ?? 0;

    // --- THE ORIGIN AXES -----------------------------------------------------
    //
    // 🔴 ONE TRIAD SINCE 2026-08-11 — THE MACHINE'S — AND THE SCENE STILL HAS
    // TWO FRAMES. That gap is deliberate and it is the founder's: *"remove the
    // sheet X, sheet Y arrows"*. What was here is worth keeping written down,
    // because it is the reason the caption below still has a job.
    //
    // The machine's axes are what the G-code is in; the SHEET's axes are what
    // `Part X` / `Part Y` are in, because `Job::place` adds the drawing offset
    // BEFORE the sheet's rotation. On a sheet laid at 90° those are different
    // directions. Measured at the emitted program (plate.dxf, 500x500 sheet,
    // 90°): `drawing_offset [50,0]` moved the G-code Y and left X alone. The
    // founder read that as a dead axis.
    //
    // ⚠ So the arrows below are labelled `X`/`Y`/`Z` and they mean the MACHINE
    // — the frame the G-code is in — and nothing on this canvas draws the other
    // one any more. `frameNote()` states it in words in the `axes-frame` line
    // directly under the scene, and that line is now the whole of it.
    //
    // ⚠ NOT a pointer shield and not in the overlay column: this is scene
    // geometry inside a `THREE.Group`, and every pick path in this file selects
    // its tiers by NAME out of `scene.children`. A group named `axes` matches no
    // tier, so it is unhoverable and ungrabbable by construction — which also
    // means the `flat:n/m` shading measurement, which walks `scene.children` for
    // top-level meshes, is unchanged by it.
    {
      const axes = new THREE.Group();
      axes.name = 'axes';
      // Sized to the MACHINE, not to a constant: a 40mm triad is invisible on a
      // 2400mm workpiece and a fixed fraction is unreadable on a small one.
      const aLen = Math.max(25, Math.min(tx, ty) * 0.13);
      //
      // 🔴 THE `aZ = 0.4` LIFT IS GONE — 2026-08-11, and the measurement is the
      // point of this note, because the lift was removed for a DIFFERENT reason
      // than the one that has been quoted at it three times.
      //
      // What it was: a 0.4mm raise, so the flat X and Y arrows would not z-fight
      // with the workpiece's top face, which is z = 0 in this scene.
      //
      // What it was blamed for: the founder's *"the xyz arros center seems on
      // top of the workpeace"*. ⚠ **IT CANNOT HAVE BEEN.** Measured against this
      // component's own camera: fov 45°, orbit radius clamped to [120, 9000]mm
      // (`radius = Math.min(9000, Math.max(120, …))`), so world height at the
      // target is `0.828 * radius`. At the tightest zoom this app allows, on a
      // 700px canvas, 0.4mm is ~2.8px; at the whole-workpiece view anyone is
      // looking at when they say the arrows sit on the workpiece — a 1200mm
      // workpiece framed at radius ~1500 — it is **0.23px**. A fifth of a pixel
      // is not what was seen, and removing it changes nothing on screen.
      //
      // What WAS seen is the geometry and it is not a defect: `stockOrigin`
      // defaults to `[0,0]`, so the workpiece's datum corner sits ON the machine
      // origin, and its top face IS this scene's z = 0. The arrows therefore
      // meet at the workpiece's top corner and the flat pair lies in its top
      // plane. That is where the machine origin is. `frameNote()` now says so in
      // the `axes-frame` caption, because the picture cannot.
      //
      // So the lift goes for its own reasons: it is a magic number three commits
      // have had to explain, it has been mistaken for the complaint three times,
      // and **it only ever did half the job it was credited with.** The flat
      // arrowheads are cones of radius `len * 0.05` — 1.25mm at the smallest
      // triad this scene draws and ~8mm on a 1200mm travel — so at a 0.4mm lift
      // their lower halves were still 0.85mm and ~7.6mm inside the workpiece.
      // The letter sprites (half-height `aLen * 0.15`, ≥3.75mm) were cut by the
      // same plane. It bought the LINES a dodge and nothing else, and only the
      // lines are what the removal has to replace.
      //
      // ⚠ WHAT THE OPERATOR LOSES, named rather than discovered: the flat arrows
      // are now exactly coplanar with the top face. The dodge is replaced by the
      // depth-only bias this file already uses for the same collision one layer
      // up (see the simulated surface's `polygonOffset` halo note) — applied to
      // the WORKPIECE, pushing it back, because WebGL exposes
      // `POLYGON_OFFSET_FILL` only and cannot bias a `THREE.Line`. **No vertex
      // moves**, which is the property that matters for an instrument whose
      // whole claim is where the origin is.
      //
      // ✅ FIXED 2026-08-11, AND IT IS THE ONE THAT MOVED THE PICTURE. The triad
      // used to be drawn at plan z = 0 unconditionally while `ZDatum` (founder
      // ruling, same day: *"0Z should be on the bottom of the workpiece, top of
      // the spoilboard"*) put work zero one workpiece thickness lower. `App` held
      // the declaration as `zZeroTop` and did not pass it, so nothing here COULD
      // draw it — and rooting the triad at an invented datum would have been
      // worse than the ambiguity, which is why the previous pass stopped and
      // said so instead. It is passed now (`props.zDatum`), so the arrows go
      // where the job says Z 0 is: see `axesRootZMm`.
      //
      // ⚠ WHAT AN OPERATOR SEES CHANGE UNDER A BOTTOM DATUM, named rather than
      // discovered. At the default `stockOrigin` of `[0,0]` the workpiece covers
      // the machine origin, so the flat X and Y arrows drop to the workpiece's
      // underside plane and the Z arrow's first `sz` mm run up THROUGH the
      // material. The workpiece is `transparent: true, opacity: 0.55`, so they
      // read as behind it rather than as gone — and that is the correct picture:
      // the declared zero IS under the material. It is not compensated for with
      // `depthTest: false`, which would draw the triad on top of the workpiece
      // and reproduce the founder's original complaint the other way round.

      /** A label, drawn to a canvas and hung past an arrow's tip. */
      const letter = (text: string, colour: number, at: THREE.Vector3, size: number) => {
        // 🔴 THE CANVAS IS SIZED FROM THE TEXT, not fixed at a square. A sprite
        // stretches its texture over whatever `scale` it is given, so a canvas
        // whose aspect does not match the glyph renders the label distorted —
        // and a legend nobody can read is the same as no legend, on the one
        // instrument whose entire job is to say which frame you are looking at.
        //
        // ⚠ The measurement that produced this was the two-word `sheet X` label,
        // which smeared badly; those arrows were removed on 2026-08-11 and the
        // sizing STAYS, because it is not specific to them. Even `X` is 106x128
        // at this font — a square canvas stretches it by 21%. The fix outlives
        // the label that exposed it.
        const cell = 128;
        const font = `bold ${Math.round(cell * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
        const cv = document.createElement('canvas');
        const ctx2d = cv.getContext('2d');
        let ratio = 1;
        if (ctx2d) {
          ctx2d.font = font;
          const w = Math.max(cell * 0.7, ctx2d.measureText(text).width + cell * 0.4);
          cv.width = Math.ceil(w);
          cv.height = cell;
          ratio = cv.width / cv.height;
          // Sizing the canvas RESETS the 2d context, so the font is set again.
          // Setting it once above and trusting it here is a silent fallback to
          // 10px sans-serif.
          ctx2d.font = font;
          ctx2d.textAlign = 'center';
          ctx2d.textBaseline = 'middle';
          // An outline under the glyph, so the label stays readable over the
          // sheet, over the bed and in either theme without this code having to
          // know which one is live.
          ctx2d.lineWidth = Math.round(cell * 0.13);
          ctx2d.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx2d.strokeText(text, cv.width / 2, cv.height / 2);
          ctx2d.fillStyle = `#${colour.toString(16).padStart(6, '0')}`;
          ctx2d.fillText(text, cv.width / 2, cv.height / 2);
        } else {
          cv.width = cell;
          cv.height = cell;
        }
        const tex = track(new THREE.CanvasTexture(cv));
        const mat = track(new THREE.SpriteMaterial({ map: tex, transparent: true }));
        const sp = new THREE.Sprite(mat);
        sp.position.copy(at);
        // Sprites scale in world units, so the label is sized off the arrow it
        // belongs to and stays legible at every zoom the orbit allows.
        sp.scale.set(size * ratio, size, 1);
        axes.add(sp);
      };

      /** Shaft + cone + label, from `from` along the unit vector `dir`.
       *
       * ⚠ The `dashed` parameter went with the sheet pair on 2026-08-11. It was
       * the only caller that ever passed `true`, and with it gone the dashed
       * branch — `LineDashedMaterial` plus the `computeLineDistances()` its
       * silence depended on — was configuration with one reachable value. A
       * parameter that can only take one value is a switch nobody can throw,
       * and the comment justifying it described a second triad that no longer
       * exists. */
      const arrow = (
        from: THREE.Vector3,
        dir: THREE.Vector3,
        len: number,
        colour: number,
        label: string
      ) => {
        const to = from.clone().addScaledVector(dir, len);
        const geo = track(new THREE.BufferGeometry().setFromPoints([from, to]));
        const mat = track(new THREE.LineBasicMaterial({ color: colour }));
        const line = new THREE.Line(geo, mat);
        axes.add(line);

        // The tip. Flat-shaded and emissive so it reads as one solid instrument
        // colour under whatever the key light is doing, rather than as a lit
        // object whose hue depends on where the operator has orbited to.
        const cone = track(new THREE.ConeGeometry(len * 0.05, len * 0.17, 10));
        const cmat = track(
          new THREE.MeshStandardMaterial({
            color: colour,
            emissive: colour,
            emissiveIntensity: 0.85,
            flatShading: true,
            roughness: 1,
            metalness: 0,
          })
        );
        const tip = new THREE.Mesh(cone, cmat);
        // `ConeGeometry` points along +Y; turn that onto the axis being drawn.
        tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        tip.position.copy(to);
        axes.add(tip);

        letter(label, colour, to.clone().addScaledVector(dir, len * 0.22), aLen * 0.3);
      };

      // THE MACHINE FRAME, at the machine origin — the only triad drawn now.
      // The labels are bare `X`/`Y`/`Z` and they are the machine's, which is
      // the frame the G-code is in.
      //
      // X and Y are LITERAL `0` — the machine datum, which no datum declaration
      // moves — and Z is the declared work zero, from the one function that owns
      // that formula. One root, written once: three arrows reading three
      // different origins is the defect this shape invites, and it is why the
      // datum is resolved HERE and handed to all three rather than inside
      // `arrow()`.
      const mo = new THREE.Vector3(0, 0, axesRootZMm(props.zDatum, sz));
      arrow(mo, new THREE.Vector3(1, 0, 0), aLen, AXIS_COLOR.x, 'X');
      arrow(mo, new THREE.Vector3(0, 1, 0), aLen, AXIS_COLOR.y, 'Y');
      arrow(mo, new THREE.Vector3(0, 0, 1), aLen, AXIS_COLOR.z, 'Z');

      // 🔴 2. THE SHEET FRAME'S OWN ARROW PAIR IS GONE — founder, 2026-08-11:
      //    *"remove the sheet X, sheet Y arrows"*. It was a dashed pair at the
      //    sheet's datum corner, drawn from the core's placement basis
      //    (`P.cos/P.sin`, `P.row_y`), shorter and higher so it nested inside
      //    the machine pair.
      //
      //    ⚠ THE MACHINE PAIR STAYS. He asked for XYZ axes on the canvas
      //    himself days earlier; an instruction naming one object is about that
      //    object. Taking the surrounding gizmo along would be reading a
      //    removal wider than it was given.
      //
      //    ⚠ AND THE CONSEQUENCE, RECORDED RATHER THAN COMPENSATED FOR: nothing
      //    on this canvas now DRAWS the fact that the sheet frame is rotated
      //    relative to the machine's. At a quarter turn or at 37° the machine
      //    arrows look identical to square. `frameNote()` still SAYS so in the
      //    `axes-frame` line, which is the caption directly under this scene —
      //    words, not a picture. That is the founder's call; inventing a
      //    replacement indicator he did not ask for is the worse failure.

      scene.add(axes);
    }

    // The touch plate's material, collected for the palette pass below. It is a
    // neutral resolved from the tokens, not an instrument colour.
    const plateMats: (THREE.Material & { color: THREE.Color })[] = [];
    // The loaded object + its section plane. A distinct neutral from everything
    // else in the scene, because it is a distinct CLAIM: the input.
    const loadedMats: THREE.MeshStandardMaterial[] = [];
    // The simulated stock surface. Its own neutral again, because it is its own
    // claim — the OUTPUT, at the opposite end of the job from the loaded object.
    const surfaceMats: THREE.MeshStandardMaterial[] = [];
    // The extruded walls — the ribbon AND its two rings, collected together so
    // the outline can never end up a different colour from the thing it
    // outlines. A third neutral again, because it is a third claim: what the
    // DRAWING asks for, which is neither the input nor the output.
    const wallMats: (THREE.Material & { color: THREE.Color })[] = [];

    // Clamps. Height is measured from the BED, so a clamp sits from the bed
    // upward — drawing it from the stock top would show a 40mm clamp on an 18mm
    // board as floating in the air.
    for (const c of props.clamps) {
      const g = track(new THREE.BoxGeometry(c.w, c.h, c.height_mm));
      const m = track(
        new THREE.MeshStandardMaterial({
          color: CLAMP_COLOR,
          transparent: true,
          opacity: 0.5,
          flatShading: true,
          roughness: 0.7,
          metalness: 0,
          // A declared obstruction is an ACTIVE thing on the bed, so it takes
          // the low emissive the house look reserves for exactly that. The hue
          // is unchanged: this is the clamp red, lifted, not restyled.
          emissive: CLAMP_COLOR,
          emissiveIntensity: 0.22,
        })
      );
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(c.x + c.w / 2, c.y + c.h / 2, -sz + c.height_mm / 2);
      mesh.name = `clamp:${c.name}`;
      mesh.userData.index = props.clamps.indexOf(c);
      mesh.castShadow = true;
      scene.add(mesh);
    }
    // The LOADED OBJECT — the mesh the user imported, as loaded.
    //
    // 🔴 It is drawn WITH ITS SECTION PLANE, and that pairing is the safety
    // point of the layer rather than a nicety. The user sees a 3D solid; the
    // machine cuts ONE FLAT OUTLINE through it at `section_z_mm`. A solid on
    // screen with no indication of where that plane lies invites exactly the
    // wrong conclusion about what is about to happen.
    //
    // It is also drawn on a REFUSED job, unlike the machined surface: a surface
    // is an output of machining that did not happen, but the mesh is the input,
    // which certainly exists — and a section Z that missed the part is the
    // moment someone most needs to see their solid.
    let meshInfo: {
      triangles: number;
      source: number;
      decimated: boolean;
      sectionZ: number;
      min: [number, number, number];
      max: [number, number, number];
      error?: string;
    } | null = null;
    if (props.loadedMesh) {
      try {
        const d = decodeLoadedMesh(props.loadedMesh);
        meshInfo = {
          triangles: d.triangles,
          source: d.source_triangles,
          decimated: d.decimated,
          sectionZ: d.section_z_mm,
          min: d.min_mm,
          max: d.max_mm,
        };
        const mg = track(new THREE.BufferGeometry());
        mg.setAttribute('position', new THREE.BufferAttribute(d.xyz_mm, 3));
        // The STL's own normals are discarded by the core (they are wrong in a
        // great many files), so they are computed here. With flat shading that
        // is per-facet anyway, which is the look.
        mg.computeVertexNormals();
        const mm2 = track(
          new THREE.MeshStandardMaterial({
            flatShading: true,
            roughness: 0.8,
            metalness: 0,
            // Translucent so the toolpath and the section plane read THROUGH
            // it. The input is a reference for the eye, not material.
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
          })
        );
        loadedMats.push(mm2);
        const mesh = new THREE.Mesh(mg, mm2);
        mesh.name = 'loaded';
        // 🔴 THE SOLID IS GRABBABLE ONLY WHEN IT CAN BE NAMED, and it can be
        // named only when the sheet holds exactly one drawing. `Report` carries
        // ONE `loaded_mesh` and the core declines to send it at all for a sheet
        // of several — so on a multi-drawing sheet a solid could only be here by
        // arriving from a stale report, and a drag on it would write a placement
        // to whichever drawing this file guessed. Left unkeyed it still draws,
        // still hovers, and refuses the drag: the walls of the part the operator
        // can actually see are what moves it.
        if ((props.partInstances ?? []).length === 1) {
          mesh.userData.instance = props.partInstances![0].instance;
        }
        mesh.castShadow = true;
        // Drawn WHERE IT WILL BE CUT. Its vertices are the model's own
        // coordinates, which is the same frame the section outline the machine
        // follows was taken in — so it goes through the identical transform the
        // program went through.
        inDrawingFrame(mesh);
        scene.add(mesh);

        // The section plane: a filled quad across the mesh's own XY bounds at
        // the Z the machine follows, with its outline, so it is legible edge-on.
        const pw = Math.max(1, d.max_mm[0] - d.min_mm[0]);
        const ph = Math.max(1, d.max_mm[1] - d.min_mm[1]);
        const secGeo = track(new THREE.PlaneGeometry(pw * 1.08, ph * 1.08));
        const secMat = track(
          new THREE.MeshBasicMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.18,
          })
        );
        loadedMats.push(secMat as unknown as THREE.MeshStandardMaterial);
        const sec = new THREE.Mesh(secGeo, secMat);
        // The plane's own place INSIDE the drawing frame — the quad's vertices
        // are centred on the origin, so it carries its position as a local
        // transform and the sheet placement is applied on top of it.
        const secLocal = new THREE.Matrix4().makeTranslation(
          (d.min_mm[0] + d.max_mm[0]) / 2,
          (d.min_mm[1] + d.max_mm[1]) / 2,
          d.section_z_mm
        );
        inDrawingFrame(sec, secLocal);
        sec.name = 'loaded-section';
        scene.add(sec);
        const secEdge = new THREE.LineSegments(
          track(new THREE.EdgesGeometry(secGeo)),
          track(new THREE.LineBasicMaterial())
        );
        inDrawingFrame(secEdge, secLocal);
        secEdge.name = 'loaded-section';
        loadedMats.push(secEdge.material as unknown as THREE.MeshStandardMaterial);
        scene.add(secEdge);
      } catch (e) {
        // 🔴 `decodeLoadedMesh` throws on a length mismatch rather than drawing
        // a plausible, progressively wrong solid. That refusal is worth nothing
        // if this file swallows it: the layer reports the failure instead of
        // quietly showing no object, because "no mesh was sent" and "the mesh
        // that was sent did not decode" are different facts.
        meshInfo = {
          triangles: 0,
          source: props.loadedMesh.source_triangles,
          decimated: props.loadedMesh.decimated,
          sectionZ: props.loadedMesh.section_z_mm,
          min: props.loadedMesh.min_mm,
          max: props.loadedMesh.max_mm,
          error: String((e as Error).message ?? e),
        };
      }
    }
    state.current.meshInfo = meshInfo;

    // The SIMULATED STOCK SURFACE — what the machine would LEAVE. The output.
    //
    // 🔴 It is drawn from the core's own height map and it is NOT THE PART. A
    // height map records removed material; on a through cut it cannot say which
    // side of the line you keep, so the surface below a profile cut is the
    // spoilboard-side floor of a cut that goes all the way through, not the
    // edge of a component. Every label attached to it says "simulated stock
    // surface" and carries the cell size, because a feature narrower than one
    // cell is not blurred — it is ABSENT from the data entirely.
    let surfaceInfo: {
      cols: number;
      rows: number;
      cell: number;
      drawnCell: number;
      strided: boolean;
      deepest: number;
      error?: string;
    } | null = null;
    if (props.stockSurface) {
      try {
        const s = decodeStockSurface(props.stockSurface);
        // A stride SKIPS samples. That is a decimation, so it is measured and
        // stated rather than absorbed: the drawn cell is what the picture is
        // at, and `cell_mm` stays the fact about the DATA.
        const stride = Math.max(
          1,
          Math.ceil(Math.sqrt((s.cols * s.rows) / SURFACE_VERTEX_BUDGET))
        );
        const cols = Math.floor((s.cols - 1) / stride) + 1;
        const rows = Math.floor((s.rows - 1) / stride) + 1;
        let deepest = 0;
        for (let i = 0; i < s.z_mm.length; i++) if (s.z_mm[i] < deepest) deepest = s.z_mm[i];
        surfaceInfo = {
          cols: s.cols,
          rows: s.rows,
          cell: s.cell_mm,
          drawnCell: s.cell_mm * stride,
          strided: stride > 1,
          // Measured over EVERY sample, not over the drawn ones — the deepest
          // point of the map is a fact about the map, and a strided picture
          // must not be allowed to under-report it.
          deepest,
        };
        if (cols >= 2 && rows >= 2) {
          const pos = new Float32Array(cols * rows * 3);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const sc = c * stride;
              const sr = r * stride;
              const o = (r * cols + c) * 3;
              pos[o] = s.origin_x_mm + sc * s.cell_mm;
              pos[o + 1] = s.origin_y_mm + sr * s.cell_mm;
              pos[o + 2] = s.z_mm[sr * s.cols + sc];
            }
          }
          const idx: number[] = [];
          for (let r = 0; r < rows - 1; r++) {
            for (let c = 0; c < cols - 1; c++) {
              const a = r * cols + c;
              idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
            }
          }
          const sg = track(new THREE.BufferGeometry());
          sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          sg.setIndex(idx);
          sg.computeVertexNormals();
          const smat = track(
            new THREE.MeshStandardMaterial({
              flatShading: true,
              roughness: 0.9,
              metalness: 0,
              side: THREE.DoubleSide,
              // 🔴 THE HALO. Uncut cells of this map sit at z = 0, which is
              // EXACTLY the stock's top face — two coplanar surfaces, and the
              // depth buffer cannot say which is in front. The result is a
              // shimmering fringe that reads as a feature of the simulation.
              // Polygon offset pushes this one a hair toward the camera in DEPTH
              // ONLY: no vertex moves, so every height still measures what the
              // simulation computed, which matters because this map is evidence
              // about a machined surface rather than decoration.
              polygonOffset: true,
              polygonOffsetFactor: -1,
              polygonOffsetUnits: -1,
            })
          );
          surfaceMats.push(smat);
          const smesh = new THREE.Mesh(sg, smat);
          smesh.name = 'surface';
          // A height field lying ON the stock has nothing to cast onto: its own
          // shadow lands on the face it is already covering, which is shadow
          // acne — the dark fringe underneath. It still RECEIVES, so the tool
          // and the clamps still cast onto it.
          smesh.castShadow = false;
          smesh.receiveShadow = true;
          scene.add(smesh);
        }
      } catch (e) {
        // 🔴 `decodeStockSurface` throws on a length mismatch rather than
        // handing back a short array, because a short array read row-major does
        // not fail — it draws a machined sheet on a progressive slant and
        // nobody spots it. That refusal is worth nothing if this file swallows
        // it, so the failure is reported: "no surface was sent" and "the
        // surface that was sent did not decode" are different facts.
        surfaceInfo = {
          cols: props.stockSurface.cols,
          rows: props.stockSurface.rows,
          cell: props.stockSurface.cell_mm,
          drawnCell: props.stockSurface.cell_mm,
          strided: false,
          deepest: 0,
          error: String((e as Error).message ?? e),
        };
      }
    }
    state.current.surfaceInfo = surfaceInfo;

    // The EXTRUDED WALLS — the imported drawing, standing up.
    //
    // 🔴 A PICTURE OF THE DRAWING, NOT OF THE MACHINED RESULT. Every treatment
    // below is chosen so it cannot be read as material, because three solids now
    // share this canvas and each makes a different claim:
    //
    //   - near-transparent ribbon, so the toolpath and the sheet read through it
    //   - top and bottom rings as LINE WORK, which is what a drawing looks like
    //   - `castShadow = false` — material casts a shadow, an annotation does not,
    //     and a wall dropping a shadow onto the bed would assert an object
    //   - `--link`, a token nothing else in this scene uses
    //
    // The height is the OPERATION'S DEPTH where one was passed and the sheet
    // thickness where none was, LABELLED as assumed — see `wallHeight`. That
    // distinction is the difference between a through cut (where the prism is
    // exact) and a pocket (where it draws a hole through material that stays).
    const heightMm = wallH.mm;
    let wallInfo: {
      parts: number;
      contours: number;
      holes: number;
      points: number;
      arcs: number;
      /** Points the arc sweeps produced — the ones a flattening would lose. */
      arcPoints: number;
      tolerance: number;
      height: number;
      assumed: boolean;
      why: string;
      clamped: boolean;
      dropped: number;
    } | null = null;
    if (props.drawing && props.drawing.length) {
      /* 🔴 ONE RIBBON PER INSTANCE, not one for the sheet — and this is the
       * whole of the multi-drawing drag fix. Until 2026-08-10 every part on the
       * sheet went into ONE `walls` mesh, so there was exactly one grabbable
       * object however many drawings were loaded: a grab anywhere on it started
       * a drag that moved whichever drawing the panel happened to have selected.
       * The picture and the program had stopped keying on the same thing.
       *
       * The bucket key is the CORE'S OWN instance id, read off the part name it
       * emitted (`<instance>/<part>`) and matched against the ids `App` sent it
       * — not split blind at the first `/`, because an id is a file-derived
       * string and nothing forbids a `/` in it. LONGEST match wins, so
       * `Hive super end #2` cannot be swallowed by `Hive super end`.
       *
       * ⚠ A part whose name matches NO declared instance is drawn and is NOT
       * grabbable. That is the refusal, not an oversight: a drag on geometry
       * this file cannot name would have to guess which placement to write, and
       * a guess here moves a part the operator was not touching. */
      const declared = [...(props.partInstances ?? [])].sort(
        (a, b) => b.instance.length - a.instance.length
      );
      const instanceOf = (partName: string): string => {
        for (const d of declared) {
          if (partName === d.instance || partName.startsWith(`${d.instance}/`)) return d.instance;
        }
        return '';
      };
      type Bucket = { top: number[]; bottom: number[]; quads: number[] };
      const buckets = new Map<string, Bucket>();
      const bucketFor = (id: string): Bucket => {
        let b = buckets.get(id);
        if (!b) {
          b = { top: [], bottom: [], quads: [] };
          buckets.set(id, b);
        }
        return b;
      };
      let contours = 0;
      let holes = 0;
      let points = 0;
      let arcs = 0;
      let arcPoints = 0;
      let clamped = false;
      let dropped = 0;

      const addContour = (c: DrawingContour, isHole: boolean, bucket: Bucket) => {
        const t = tessellateContour(c);
        const m = t.xy.length / 2;
        if (m < 2) return;
        // 🔴 Over budget, a WHOLE CONTOUR is dropped and counted. The tempting
        // alternative — thin every arc until it fits — reintroduces the exact
        // defect `tessellateContour` exists to prevent, and does it invisibly:
        // a quietly polygonal hole still looks like a hole.
        if (points + m > WALL_VERTEX_BUDGET) {
          dropped++;
          return;
        }
        contours++;
        if (isHole) holes++;
        points += m;
        arcs += t.arcs;
        arcPoints += t.arcPoints;
        clamped = clamped || t.clamped;

        const segs = c.closed ? m : m - 1;
        for (let i = 0; i < segs; i++) {
          const x0 = t.xy[i * 2];
          const y0 = t.xy[i * 2 + 1];
          const j = (i + 1) % m;
          const x1 = t.xy[j * 2];
          const y1 = t.xy[j * 2 + 1];
          // Two triangles per segment, non-indexed. `DoubleSide` rather than a
          // consistent winding: the drawing's own winding tells outer from
          // inner in the CORE, and deciding a facing here would be this file
          // re-deriving a geometry fact it was handed.
          bucket.quads.push(
            x0, y0, 0,   x1, y1, 0,   x1, y1, -heightMm,
            x0, y0, 0,   x1, y1, -heightMm,   x0, y0, -heightMm
          );
          bucket.top.push(x0, y0, 0, x1, y1, 0);
          bucket.bottom.push(x0, y0, -heightMm, x1, y1, -heightMm);
        }
      };

      for (const part of props.drawing) {
        // The bucket is resolved ONCE per part, so a part's holes can never end
        // up on a different instance from its own outline — which would draw a
        // plate whose holes move when a neighbour is dragged.
        const bucket = bucketFor(instanceOf(part.name ?? ''));
        if (part.outer) addContour(part.outer, false, bucket);
        // 🔴 The holes matter as much as the outline — `cam.ts` says so on the
        // field. A part drawn without them looks entirely correct and is a
        // plate with no holes in it.
        for (const inner of part.inners ?? []) addContour(inner, true, bucket);
      }

      wallInfo = {
        parts: props.drawing.length,
        contours,
        holes,
        points,
        arcs,
        arcPoints,
        tolerance: WALL_ARC_TOLERANCE_MM,
        height: heightMm,
        assumed: wallH.assumed,
        why: wallH.why,
        clamped,
        dropped,
      };

      for (const [instance, bucket] of buckets) {
        const { quads, top, bottom } = bucket;
        if (!quads.length) continue;
        const wg = track(new THREE.BufferGeometry());
        wg.setAttribute('position', new THREE.Float32BufferAttribute(quads, 3));
        wg.computeVertexNormals();
        const wmat = track(
          new THREE.MeshStandardMaterial({
            flatShading: true,
            roughness: 0.9,
            metalness: 0,
            side: THREE.DoubleSide,
            transparent: true,
            // Low enough that the sheet, the toolpath and anything behind read
            // straight through. A reference shape you cannot see past is a
            // solid, whatever the legend calls it.
            opacity: 0.16,
            // The ribbon stands exactly on the drawn boundary, which is where
            // the outline lines are too. Pushed back in DEPTH ONLY so the rings
            // win the z-fight against their own fill — no vertex moves, so every
            // point still sits on the coordinate the drawing gave.
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          })
        );
        wallMats.push(wmat as THREE.Material & { color: THREE.Color });
        const wmesh = new THREE.Mesh(wg, wmat);
        // 🔴 THE NAME STAYS `walls` — the layer toggle, the pick tiers and the
        // hover panel all key on it, and a per-instance name would silently
        // remove this geometry from all three. WHICH drawing it is rides in
        // `userData`, which is where the drag reads it and where nothing else
        // has to change to keep working.
        wmesh.name = 'walls';
        wmesh.userData.instance = instance;
        // Same frame as the loaded solid, and for the same reason: these are
        // `Report.drawing`'s coordinates, not the program's.
        inDrawingFrame(wmesh);
        // 🔴 No shadow, cast or received. A shadow is what tells the eye a thing
        // is made of something, and this one is not.
        wmesh.castShadow = false;
        wmesh.receiveShadow = false;
        scene.add(wmesh);

        for (const [pts, tag] of [
          [top, 'top'],
          [bottom, 'bottom'],
        ] as const) {
          const lg = track(new THREE.BufferGeometry());
          lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          const lm = track(new THREE.LineBasicMaterial());
          wallMats.push(lm as THREE.Material & { color: THREE.Color });
          const ring = new THREE.LineSegments(lg, lm);
          // Same name as the ribbon, so one toggle moves all three objects and
          // the hover panel describes the layer rather than the piece of it the
          // ray happened to meet.
          ring.name = 'walls';
          ring.userData.ring = tag;
          // The rings are part of the same drawing as the ribbon they edge, so
          // they carry the same instance. A ring left unkeyed would be a piece
          // of a part that is not draggable while the rest of it is.
          ring.userData.instance = instance;
          // The rings ARE the ribbon's own edges, so they take the identical
          // transform. Placing one and not the others is how an outline ends up
          // describing a shape that is somewhere else.
          inDrawingFrame(ring);
          scene.add(ring);
        }
      }
    }
    state.current.wallInfo = wallInfo;

    // Snap guides — the two bed lines a drag settled against. Built once here
    // and moved by the drag, rather than created per pointer event.
    const guideMats: (THREE.Material & { color: THREE.Color })[] = [];
    const guides: THREE.Line[] = [];
    for (const axis of ['x', 'y'] as const) {
      const g = track(new THREE.BufferGeometry());
      g.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          axis === 'x' ? [0, -ty * 0.1, 0, 0, ty * 1.1, 0] : [-tx * 0.1, 0, 0, tx * 1.1, 0, 0],
          3
        )
      );
      const m = track(new THREE.LineBasicMaterial());
      guideMats.push(m as THREE.Material & { color: THREE.Color });
      const line = new THREE.Line(g, m);
      line.name = `snap-guide-${axis}`;
      line.position.z = -sz - 1.2;
      line.visible = false;
      scene.add(line);
      guides.push(line);
    }
    const applySnapGuides = () => {
      const snap = state.current.snap as SnapOutcome | null | undefined;
      guides[0].visible = !!snap && snap.guideX !== null;
      guides[1].visible = !!snap && snap.guideY !== null;
      if (snap?.guideX != null) guides[0].position.x = snap.guideX;
      if (snap?.guideY != null) guides[1].position.y = snap.guideY;
    };
    state.current.applySnapGuides = applySnapGuides;
    applySnapGuides();

    // Touch plate. Drawn only when the machine says probing is on — an object
    // on the bed that is not there is worse than one that is missing.
    //
    // 🔴 DRAWN, NOT DECLARED AS A KEEPOUT. A plate left on the bed is something
    // a cutter can hit, exactly like a clamp — which is what gate P7 is for.
    // But whether it becomes a real keepout is a machining question, and it
    // belongs in the CORE where a gate can see it, not in a colour chosen here.
    // Nothing below feeds the fixture check; this makes it visible, no more.
    const tp = props.touchPlate;
    if (tp && tp.enabled) {
      const th = Math.max(0.2, tp.thickness_mm);
      const plateGeo = track(new THREE.BoxGeometry(PLATE_PLACEHOLDER_XY, PLATE_PLACEHOLDER_XY, th));
      // "Placed" means the machine names a position. At 0,0 it does not — its
      // own definition of 0,0 is "probe where the tool already is" — so the
      // plate is drawn as an OUTLINE at the origin rather than as a solid block
      // that would read as a measurement of where it sits.
      const placed = !(tp.x === 0 && tp.y === 0);
      const plateMat = track(
        placed
          ? new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.35, metalness: 0.6 })
          : new THREE.LineBasicMaterial()
      );
      const plate = placed
        ? new THREE.Mesh(plateGeo, plateMat as THREE.MeshStandardMaterial)
        : new THREE.LineSegments(
            track(new THREE.EdgesGeometry(plateGeo)),
            plateMat as THREE.LineBasicMaterial
          );
      plate.position.set(tp.x, tp.y, -sz + th / 2);
      plate.name = 'touch';
      plate.userData.placed = placed;
      plate.userData.thickness = th;
      if (placed) (plate as THREE.Mesh).castShadow = true;
      scene.add(plate);
      plateMats.push(plateMat as THREE.Material & { color: THREE.Color });
    }

    // The drag handler reads these rather than closing over a stale render.
    // ⚠ `clampDrag` moved to the component body with `partDrag` and `stockDrag`
    // — it is pointer wiring, not geometry. `clamps` stays: it is a dependency
    // of this effect and the drawn clamp meshes are built from it here.
    state.current.clamps = props.clamps;
    state.current.bedZ = sz;

    // Toolpath. One line segment set per kind so colours do not need vertex
    // colours and a kind can be toggled off wholesale.
    //
    // 🔴 EVERY kind is BUILT, always. Visibility is applied afterwards by
    // `applyVis`, because the two questions are different: what the program
    // contains is a fact about the job, what is on screen is a display state.
    // Building only the visible kinds would mean a toggle rebuilt the scene,
    // and — worse — that the geometry itself encoded a display preference.
    // 🔴 CLAMPED TO THE ACTUAL LENGTH. `Math.max(1, …)` on an EMPTY move list
    // yields 1, and the loop then reads `moves[0]` of an empty array and dies on
    // `undefined.kind`. An empty list is now a normal state — with the gate
    // fixtures off the operator surface, the app plans nothing until a drawing
    // is chosen, so the viewport is handed zero moves on first load.
    //
    // ⚠ The previous code survived this by ACCIDENT: it read `m.kind` inside
    // `if (prev && …)`, and `prev` is null on the first pass, so the
    // short-circuit hid the out-of-range read. That is not a guard, it is a
    // coincidence — and it stopped being true the moment the loop body needed
    // `m` before `prev`.
    const upTo = Math.min(props.moves.length, Math.max(1, Math.floor(props.moves.length * props.progress)));
    const byKind: Record<string, number[]> = {};
    // Which MOVE produced each segment, per kind, so the hover panel can say
    // "move 412 of 9000" without re-deriving anything.
    const idxOf: Record<string, number[]> = {};
    // Half the marker cross, sized to the sheet so it stays visible on a 2.4m
    // panel and does not swamp a 120mm test part.
    const cross = Math.max(3, Math.min(sx, sy) * 0.015);
    let prev: RenderMove | null = null;
    for (let i = 0; i < upTo; i++) {
      const m = props.moves[i];
      if (m.kind === 'change' || m.kind === 'probe') {
        // 🔴 A tool change and a probe are POINTS, not travel: the core emits
        // them at the last position and safe Z. They used to be dropped from
        // the scene entirely, which would have made their toggles controls
        // that do nothing — and a dead control is worse than a missing one.
        // Drawn as a three-axis cross so the operator can see WHERE the
        // program stops and asks for something.
        (byKind[m.kind] ||= []).push(
          m.x - cross, m.y, m.z, m.x + cross, m.y, m.z,
          m.x, m.y - cross, m.z, m.x, m.y + cross, m.z,
          m.x, m.y, m.z - cross, m.x, m.y, m.z + cross
        );
        (idxOf[m.kind] ||= []).push(i, i, i);
        prev = m;
        continue;
      }
      if (prev) {
        (byKind[m.kind] ||= []).push(prev.x, prev.y, prev.z, m.x, m.y, m.z);
        (idxOf[m.kind] ||= []).push(i);
      }
      prev = m;
    }
    for (const [kind, pts] of Object.entries(byKind)) {
      if (!pts.length) continue;
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = track(
        new THREE.LineBasicMaterial({
          color: COLOR[kind] ?? 0x888888,
          transparent: kind === 'rapid',
          opacity: kind === 'rapid' ? 0.35 : 1,
        })
      );
      const line = new THREE.LineSegments(g, m);
      line.name = `path:${kind}`;
      line.userData.moveIdx = Int32Array.from(idxOf[kind] ?? []);
      scene.add(line);
    }

    // Remaining (not-yet-played) portion of the toolpath — drawn at reduced
    // opacity so the operator can see what is left to cut without confusing it
    // with the already-executed portion. Uses the same per-kind colours.
    // `prev` is already set to moves[upTo-1] from the done loop above, so the
    // first remaining segment connects naturally from the playhead position.
    const remByKind: Record<string, number[]> = {};
    for (let i = upTo; i < props.moves.length; i++) {
      const m = props.moves[i];
      if (m.kind === 'change' || m.kind === 'probe') {
        (remByKind[m.kind] ||= []).push(
          m.x - cross, m.y, m.z, m.x + cross, m.y, m.z,
          m.x, m.y - cross, m.z, m.x, m.y + cross, m.z,
          m.x, m.y, m.z - cross, m.x, m.y, m.z + cross
        );
        prev = m;
        continue;
      }
      if (prev) {
        (remByKind[m.kind] ||= []).push(prev.x, prev.y, prev.z, m.x, m.y, m.z);
      }
      prev = m;
    }
    for (const [kind, pts] of Object.entries(remByKind)) {
      if (!pts.length) continue;
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const m = track(
        new THREE.LineBasicMaterial({
          color: COLOR[kind] ?? 0x888888,
          transparent: true,
          opacity: 0.3,
        })
      );
      const line = new THREE.LineSegments(g, m);
      line.name = `path-remaining:${kind}`;
      scene.add(line);
    }

    // Tool marker at the head of the drawn program — TODO #44. The tip sits ON
    // the head coordinate, because that IS the tool tip: the head is the last
    // drawn move and a move's Z is where the end of the cutter is.
    const head = props.moves[Math.min(upTo, props.moves.length) - 1];
    const marker = toolMarkerShape(props.tool);
    // Cleared on EVERY rebuild, before anything decides to set it. A scene that
    // stops drawing a cutter — an empty program, a row that states no diameter —
    // must drop the published position with it; a stale coordinate from the
    // previous scene is exactly the "dead handle that reads as a live one" this
    // instrument exists to make impossible.
    state.current.toolWorld = null;
    if (head) {
      // Every piece is added to the scene under the name `tool`, never grouped:
      // the pick pass is non-recursive on purpose, so a group would put the
      // marker behind a hover that silently stopped working.
      const lathe = (
        profile: [number, number][],
        colour: number,
        emissiveIntensity: number,
        openEnded: boolean
      ) => {
        const g = track(
          new THREE.LatheGeometry(
            profile.map(([pr, py]) => new THREE.Vector2(pr, py)),
            TOOL_SEGMENTS
          )
        );
        const m = track(
          new THREE.MeshStandardMaterial({
            color: colour,
            flatShading: true,
            roughness: 0.4,
            metalness: 0.2,
            // The live head of the program is the one thing in the scene that
            // is genuinely moving, so it takes the "active" emissive.
            emissive: colour,
            emissiveIntensity,
            // An unstated tip leaves the solid OPEN. Double-sided so the
            // opening reads as a hollow end rather than as a hole in the
            // render — the refusal has to look deliberate.
            side: openEnded ? THREE.DoubleSide : THREE.FrontSide,
          })
        );
        const mesh = new THREE.Mesh(g, m);
        // A lathe turns about its +Y; this scene is Z-up, so +Y becomes +Z.
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(head.x, head.y, head.z);
        mesh.name = 'tool';
        mesh.castShadow = true;
        scene.add(mesh);
      };

      if (marker.refused) {
        // 🔴 NO CUTTER. A dashed cage at a placeholder size, which is the one
        // shape nobody can mistake for a tool — and it casts no shadow, because
        // material casts and annotation does not.
        const box = new THREE.BoxGeometry(TOOL_FRAME_MM.xy, TOOL_FRAME_MM.xy, TOOL_FRAME_MM.h);
        const edges = track(new THREE.EdgesGeometry(box));
        box.dispose();
        const m = track(
          new THREE.LineDashedMaterial({ color: TOOL_REFUSED_COLOR, dashSize: 2.5, gapSize: 2 })
        );
        const cage = new THREE.LineSegments(edges, m);
        cage.computeLineDistances();
        cage.position.set(head.x, head.y, head.z + TOOL_FRAME_MM.h / 2);
        cage.name = 'tool';
        scene.add(cage);
      } else {
        lathe(marker.cutting, TOOL_CUT_COLOR, 0.35, marker.openTipRadiusMm !== null);
        // Half way up the CUTTING solid, on its axis. Read off the profile that
        // was just drawn rather than off the tool row, so the published point
        // moves with the thing on screen and not with the plan behind it — the
        // rule every gate in this lane is held to. A lathe turns about +Y and
        // the mesh is rotated onto this scene's +Z, so a profile height becomes
        // a height above the head coordinate.
        const topY = Math.max(...marker.cutting.map(([, y]) => y));
        state.current.toolWorld = new THREE.Vector3(head.x, head.y, head.z + topY / 2);
        // The shank cuts nothing, so it is neither the cutting colour nor as
        // bright — the same distinction the tool list draws.
        if (marker.shank) lathe(marker.shank, TOOL_SHANK_COLOR, 0.12, false);
        if (marker.openTipRadiusMm !== null) {
          // The tip is not stated. A dashed ring round the open end, at the
          // same envelope radius the solid is drawn to — the diameter is known,
          // the shape of the end is not.
          const pts: number[] = [];
          const steps = 48;
          for (let i = 0; i <= steps; i++) {
            const a = (i / steps) * Math.PI * 2;
            pts.push(
              head.x + marker.openTipRadiusMm * Math.cos(a),
              head.y + marker.openTipRadiusMm * Math.sin(a),
              head.z
            );
          }
          const g = track(new THREE.BufferGeometry());
          g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          const m = track(
            new THREE.LineDashedMaterial({ color: TOOL_REFUSED_COLOR, dashSize: 1, gapSize: 0.8 })
          );
          const ring = new THREE.Line(g, m);
          ring.computeLineDistances();
          ring.name = 'tool';
          scene.add(ring);
        }
      }
    }

    // The hover dot. Never pickable (it is not in either pick list) and hidden
    // until something is actually under the pointer.
    const markGeo = track(new THREE.SphereGeometry(Math.max(2, Math.min(sx, sy) * 0.012), 10, 8));
    const markMat = track(new THREE.MeshStandardMaterial({ flatShading: true, emissiveIntensity: 0.6 }));
    const mark = new THREE.Mesh(markGeo, markMat);
    mark.name = 'hover-mark';
    mark.visible = false;
    scene.add(mark);
    state.current.hoverMark = mark;

    // Everything the hover panel is allowed to read. Stashed rather than closed
    // over, because the pointer handlers live in the one-time effect and would
    // otherwise describe the sheet as it was on first render.
    state.current.hoverData = {
      stock: props.stock,
      origin: [ox, oy],
      rotation: props.stockRotationDeg ?? 0,
      material: props.stockMaterial,
      clamps: props.clamps,
      // 🔴 `props.tool ?? null` FLATTENS the three states this file keeps apart
      // everywhere else, so the marker's own reading — which was taken from the
      // un-flattened prop — travels beside it. The hover reports what was
      // DRAWN, and only `marker` knows that.
      tool: props.tool ?? null,
      toolMarker: marker,
      head,
      upTo: Math.min(upTo, props.moves.length),
      total: props.moves.length,
      // --- TODO #74: the two things the spoilboard work put on screen --------
      //
      // Everything below is passed through from the props this build was given
      // and from `boardSlab` / `readBoardDepth`, which are the same two
      // functions the PICTURE was built from a few hundred lines up. The panel
      // and the canvas therefore cannot disagree about what state the board is
      // in — there is one reading, used twice.
      board: board,
      slab,
      boardDepth: depth,
      bareReach: props.spoilboardBareReach ?? null,
      boardPositionAssumed: props.spoilboardPositionAssumed,
      travel: props.travel,
      travelZ: props.travelZMm,
    };

    // Apply the per-class display state to what was just built, and publish
    // what the scene ACTUALLY is: how many meshes are flat-shaded, out of how
    // many, and whether shadows are on. A measurement of the built scene, so a
    // material that silently reverts is a red test and not a matter of taste.
    const applyVis = () => {
      const vis = visRef.current;
      for (const o of scene.children) {
        if (o.name.startsWith('path:')) o.visible = vis[o.name.slice(5) as Layer] !== false;
        else if (o.name === 'touch') o.visible = vis.touch !== false;
        else if (o.name === 'loaded' || o.name === 'loaded-section')
          o.visible = vis.loaded !== false;
        else if (o.name === 'surface') o.visible = vis.result !== false;
        // The ribbon and its two rings share the name, so one arm hides all
        // three. A wall left standing with its outline switched off — or the
        // reverse — would be a fourth thing on the canvas that is none of the
        // three claims.
        else if (o.name === 'walls') o.visible = vis.walls !== false;
        // The workpiece is a SOLID, not a line group, so it needed its own arm
        // here — and its outline has to go with it, or hiding the sheet leaves
        // a wireframe box that still reads as a board.
        //
        // ⚠ The rotate GRIP is deliberately not hidden with it. It is a
        // control, not scene furniture: a handle that vanishes when a display
        // layer is switched off strands the sheet at whatever angle it was
        // last left, with no way back that does not involve finding the toggle
        // that did it.
        else if (o.name === 'stock' || o.name === 'stock-edges') o.visible = vis.workpiece !== false;
        // 🔴 The body, the cage and the rings ALL carry the name `tool`, so one
        // arm hides every piece. Half a cutter left on the canvas would be a
        // fourth object that is not the cutter, not the path and not the work.
        //
        // ⚠ AND HIDING IT MUST NOT LEAVE IT CLAIMING THE POINTER. The pick pass
        // filters `scene.children` by name into tiers and casts against them,
        // and three.js `intersectObjects` skips an object whose `visible` is
        // false — so a hidden marker drops out of the pick with the picture. It
        // is asserted rather than assumed in `pickAt`'s tier build, because this
        // is the exact defect the clamps work had to fix (a hidden clamp still
        // ate a drag) and the rotate knob's removal was written to avoid.
        else if (o.name === 'tool') o.visible = vis.tool !== false;
        // Every declared obstruction goes together. One clamp left standing
        // while the rest are hidden would be the worst of both: a bed that
        // looks nearly clear, with the one thing you can see implying the ones
        // you cannot are not there.
        //
        // ⚠ This hides the PICTURE and nothing else. The clamps still reach the
        // core, gate P7 still checks the toolpath against every one of them,
        // and the snap in `neighboursFor` still treats them as neighbours —
        // that reads `state.current.clamps`, the declared data, not the scene.
        else if (o.name.startsWith('clamp:')) o.visible = vis.clamps !== false;
        // 🔴 THE BOARD AND ITS BARE STRIPS GO TOGETHER. The strips are the
        // reachable area the board does NOT cover; leaving them on their own
        // would draw the absence of a thing that is not on screen, and leaving
        // the board on without them would show material and hide where it runs
        // out — which is the direction that reaches the machine.
        // `spoilboard-unknown` is the dashed edge that says the thickness was
        // never declared. It hides with the board it marks — a marker left
        // floating over a board that is switched off would be a fourth object
        // that is none of the three the scene draws.
        else if (
          o.name === 'spoilboard' ||
          o.name === 'spoilboard-bare' ||
          o.name === 'spoilboard-unknown'
        )
          o.visible = vis.spoilboard !== false;
        // The reach outline and the grid go together: hiding the limits and
        // leaving the grid lines floating would still occlude what you switched
        // it off to see, which is the underside of the work.
        else if (o.name === 'travel' || o.name === 'travel-grid')
          o.visible = vis.travel !== false;
      }
    };
    state.current.applyVis = applyVis;
    applyVis();
    // The scene has just been rebuilt, so anything the hover panel is currently
    // saying was computed against the PREVIOUS `hoverData`. Ask again.
    state.current.repick?.();

    let flat = 0;
    let meshes = 0;
    for (const o of scene.children) {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!(o as THREE.Mesh).isMesh || !mat) continue;
      meshes++;
      if ((mat as THREE.MeshStandardMaterial).flatShading) flat++;
    }
    state.current.renderer?.domElement.setAttribute(
      'data-shading',
      `flat:${flat}/${meshes} shadows:${state.current.renderer?.shadowMap.enabled ? 'on' : 'off'}`
    );

    // What the WALL LAYER actually built, published as a measurement of the
    // scene rather than as an assurance in a commit message — the same reason
    // `data-shading` and `data-hover-ms` are here.
    //
    // 🔴 `arcs` and `points` are the pair that matters. A drawing whose arcs
    // were flattened reports `arcs:0` while still drawing something that looks
    // like a part, so the count that would go quiet on the defect is on the
    // page. `h` carries `assumed` for the same reason: a height nobody measured
    // must be legible without opening a panel.
    const wdom = state.current.renderer?.domElement;
    if (wdom) {
      if (wallInfo) {
        wdom.setAttribute(
          'data-walls',
          `parts:${wallInfo.parts} contours:${wallInfo.contours} holes:${wallInfo.holes} ` +
            // ⚠ `arcpoints` is COUNTED, not derived. It was briefly
            // `points - contours` — which silently assumes exactly one non-arc
            // point per contour and reported 71 where the truth was 64. A
            // measurement published next to real ones borrows their authority,
            // so it has to be measured too.
            `points:${wallInfo.points} arcs:${wallInfo.arcs} arcpoints:${wallInfo.arcPoints} ` +
            `tol:${wallInfo.tolerance}mm h:${wallInfo.height}mm${wallInfo.assumed ? ' assumed' : ' measured'}` +
            `${wallInfo.clamped ? ' CLAMPED' : ''}${wallInfo.dropped ? ` dropped:${wallInfo.dropped}` : ''}`
        );
      } else {
        // Absent rather than zeroed. "No drawing was passed" and "a drawing was
        // passed and produced nothing" are different facts, and `contours:0`
        // would render the first as the second.
        wdom.removeAttribute('data-walls');
      }

      /* 🔴 WHAT WAS ACTUALLY DRAWN FOR THE BOARD, on the canvas itself.
       *
       * There is no WebGL on the machine this was written on, so nothing here
       * can be checked by looking. This attribute is the structural substitute:
       * it publishes the three states apart — `none` (removed entirely), `plane`
       * with `thickness:unknown`, and `slab` with its top face and underside —
       * beside the depth VERDICT and, separately, the count.
       *
       * ⚠ The attribute is REMOVED when no board is declared rather than written
       * as `state:none`, for the reason `data-walls` is removed: absent and
       * zeroed are different facts, and a `state:none` string is a value a
       * scraper would read as an answer. */
      if (boardOk) {
        wdom.setAttribute(
          'data-spoilboard',
          `state:${slab.state === 'slab' ? 'slab' : 'plane'} ` +
            `top:${(slab.topZMm as number).toFixed(2)} ` +
            `underside:${slab.undersideZMm == null ? 'unknown' : slab.undersideZMm.toFixed(2)} ` +
            `thickness:${slab.thicknessMm == null ? 'unknown' : slab.thicknessMm.toFixed(2)} ` +
            // The verdict is published as the WORD, and the count beside it is
            // published as `notreported` when nothing sent one — never as `0`,
            // which is the value that reads as a measurement.
            `depth:${depth.verdict} ` +
            `through:${depth.throughCells == null ? 'notreported' : depth.throughCells}`
        );
      } else {
        wdom.removeAttribute('data-spoilboard');
      }
    }

    // --- palette -----------------------------------------------------------
    //
    // Every neutral in the scene is RESOLVED from `brand/tokens.css` through
    // the app's own semantic aliases, so the 3D view and the panels around it
    // cannot drift apart. Nothing here is a hex literal, and nothing here reads
    // `props.dark`: the resolved tokens ARE the theme, and the boolean is only
    // a hint about a theme the DOM may not have been told about yet.
    //
    // 🔴 NOT included, deliberately: the toolpath legend (cut / tab / drill /
    // rapid / change / probe at the top of this file), the clamp red and the
    // tool marker. Those are INSTRUMENT colours — telling a rapid from a cut on
    // a program that is about to drive a 2.2 kW spindle is a safety property,
    // not a style one — and whether brand owns them is an open question with
    // the brand session. They stay put until that is answered.
    const applyPalette = () => {
      const token = state.current.token as (expr: string) => THREE.Color;
      if (!token) return;
      // Only bare `var(--token)` is asked of the browser, because that computes
      // to `rgb(...)`, which `THREE.Color.setStyle` parses. A CSS `color-mix()`
      // computes to `color(srgb ...)`, which it does NOT — and its failure mode
      // is a console WARNING and an unchanged colour, i.e. a silently wrong
      // scene that no error-watching test would catch. Blends are done here,
      // where a bad one is a visible number rather than a swallowed parse.
      const bg = token('var(--bg)');
      const panel = token('var(--panel)');
      const line = token('var(--line)');
      const ink = token('var(--ink)');
      const accent = token('var(--accent)');

      scene.background = bg;
      // The reach outline is `--line`: the theme's own boundary colour, which is
      // what it is — a limit, not a surface. It deliberately does NOT take
      // `--panel`, the colour the board and the panels use for material.
      travelMat.color = line;
      /* The board takes `--panel`, the neutral this app uses for a SURFACE, so
       * the one rectangle in the scene made of anything is the one that reads as
       * something you could put a sheet on — UNLESS the depth limb has something
       * to say about it.
       *
       * 🔴 THE VERDICT IS THE KEY, NEVER THE COUNT. `depth.verdict` is the core's
       * own three-state word. `through_board: 0` beside `board-depth-unknown` is
       * PENDING and is painted `--muted` — the colour `styles.css`'s `.pending`
       * rule reserves for a fact this app does not hold — while the same `0`
       * beside `inside-board` is a measured clear result and keeps the surface
       * neutral. Keying on the integer would paint PENDING as the safe answer,
       * which is one of the three mutations the core's own tests plant. */
      const boardColour =
        depth.verdict === 'through-board'
          ? token('var(--bad)')
          : depth.verdict === 'inside-board'
            ? panel
            : token('var(--muted)');
      for (const m of boardMats) m.color = boardColour;
      // The dashed UNKNOWN-thickness edge is `--muted` for the same reason and
      // never `--warn`: an undeclared thickness is a question nobody answered,
      // not a hazard that was measured. See `styles.css` `.pending`.
      for (const m of boardUnknownMats) m.color = token('var(--muted)');
      /* 🔴 THE BARE STRIPS ARE `--warn` AND STAY `--warn`. This is a safety
       * instrument, not a neutral: the strip marks reachable area with NO
       * sacrificial material under it, which is where a through-cut becomes a
       * cutter in an extrusion. It is grouped with the palette so it follows the
       * theme's own warn token, and it is called out here so a later style pass
       * does not quietly trade it for a tint that reads as decoration. */
      for (const m of bareMats) m.color = token('var(--warn)');
      buildGrid(line, line.clone().lerp(panel, 0.45));
      // The sheet is amber pulled toward the surface it sits on; its edge is
      // the same amber pulled toward the TEXT colour — near-white in dark and
      // near-black in light — so the outline always moves AWAY from the fill in
      // whichever theme is live, without this file knowing which one that is.
      stockMat.color = accent.clone().lerp(panel, 0.4);
      edgeMat.color = accent.clone().lerp(ink, 0.4);
      // The hover dot and the emissive lift on a hovered solid are the accent
      // too, kept here so they follow the theme with everything else.
      // The plate is a bed FIXTURE, so it takes a neutral pulled toward the
      // surface it sits on — visibly not the sheet, visibly not a keepout.
      for (const m of plateMats) m.color = token('var(--muted)');
      for (const m of loadedMats) m.color = token('var(--ok)');
      // The machined surface is `--ink` pulled toward the panel: a solid that
      // reads as material under the translucent sheet, and visibly not the
      // sheet, the plate or the loaded object — three claims it must never be
      // mistaken for.
      for (const m of surfaceMats) m.color = ink.clone().lerp(panel, 0.35);
      // The walls are `--ink` undiluted — line work, at the highest contrast the
      // theme has, because a drawing IS line work and the eye should read it as
      // annotation over the board rather than as another board. See `swatch()`
      // for why this is not `--link`: an unused token is not automatically a
      // distinguishable one, and amber-deep sat a hue away from the sheet the
      // walls stand on. Fill and rings share this array, so the outline is the
      // same colour as the thing it outlines by construction rather than by two
      // edits that have to agree.
      for (const m of wallMats) m.color = ink;
      // The snap guide is the interactive accent, the same amber as the grip.
      for (const m of guideMats) m.color = accent;
      state.current.accent = accent;
      markMat.color = accent;
      markMat.emissive = accent;
    };
    state.current.applyPalette = applyPalette;
    applyPalette();

    // 🔴 Frame ONCE PER SHEET, not once per rebuild — see `framedFor`. The
    // guard is on the BASIS rather than on a "first run" flag, because a first-run
    // flag would also refuse to re-frame a genuinely new sheet, and a sheet the
    // camera does not contain is the one case where seizing the view is right.
    const framingBasis = `${sx}x${sy}`;
    if (framedFor.current !== framingBasis) {
      framedFor.current = framingBasis;
      state.current.frameScene?.(sx, sy);
    }
    /* 🔴 THE DEPENDENCY LIST IS `sceneDeps(props)` AND IT LIVES AT MODULE SCOPE.
     * Two reasons, and the second is the load-bearing one:
     *
     *   · Five of the props it keys arrive as a FRESH LITERAL on every parent
     *     render, so keying them by identity rebuilt this whole scene on every
     *     keystroke. `sceneDeps` keys those by VALUE.
     *   · A list written inline cannot be measured. "Does this render rebuild
     *     the scene?" is decided entirely by that array and `Object.is` — and
     *     with the array inline, answering it needs a GPU, a browser and a frame
     *     to watch, none of which this lane's tests have.
     *     `tests/viewport-rebuild.test.ts` counts rebuilds through it instead. */
  }, sceneDeps(props));

  // Display state only — no rebuild, no plan, no export. Clearing the hover is
  // part of it: a panel describing a class that has just been switched off is
  // the exact "reports something you cannot see" failure the toggles create.
  useEffect(() => {
    state.current.applyVis?.();
    state.current.resetHover?.();
  }, [kindOn, props.showRapids]);

  /* 🔴 NO RENDERER ⇒ THE STATED ABSENCE, AND NOTHING ELSE IN THIS BOX.
   *
   * It is placed AFTER every hook above and before any other early exit, so the
   * hook order cannot depend on whether this machine has WebGL.
   *
   * ⚠ THE OVERLAY COLUMN GOES WITH THE PICTURE, and that is a real loss worth
   * naming rather than discovering. Everything in it is a CAPTION: the axes
   * note explains a triad that is not drawn, the `…-unavailable` reason lines
   * explain layers that are not drawn, the hidden-layer indicator counts what
   * is missing from a picture that is entirely missing, and the snap chips are
   * controls for a drag that cannot happen without a canvas to drag on. A
   * caption over an empty box reads as a broken viewport, and a snap control
   * that changes the DATUM must not sit there looking live when no gesture in
   * this component can reach it. What those lines were reporting about the JOB
   * — a decimated mesh, an assumed wall height, no clamps declared — is the
   * sidebar's and the report's to say, and both still render. */
  if (gl && !gl.ok) {
    return (
      <div
        className="viewport"
        data-testid="viewport"
        data-gl="unavailable"
        style={{ position: 'relative', overflow: 'hidden' }}
      >
        <GlUnavailable
          testid="viewport-gl-unavailable"
          detail={gl.detail ?? 'no message'}
          unaffected="The program, the checks and the simulation"
          stillWorks={
            'Everything else on this page still works: the panels and their settings, every ' +
            'refusal and warning, the report, the G-code and its download. Nothing about the ' +
            'job was skipped — only its picture. The layer eyes in the sidebar still toggle; ' +
            'there is simply no picture for them to change.'
          }
          style={{ position: 'absolute', inset: 0 }}
        />
      </div>
    );
  }

  /* Read off the SAME placement the 3D triad is drawn from, so the caption and
   * the arrows cannot describe two different frames — and, since 2026-08-11,
   * from the SAME datum and the SAME thickness the triad's root is computed
   * from, for the same reason one step along in Z. `axesRootNote` and
   * `axesRootZMm` take identical arguments precisely so a reader can see that
   * the sentence and the geometry are answering one question. */
  const axesNote = frameNote(
    props.drawingPlacement,
    axesRootNote(props.zDatum, props.stock[2])
  );

  const chip: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 7px',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    background: 'var(--panel)',
    color: 'var(--ink)',
    font: 'inherit',
    fontSize: 11.5,
    lineHeight: 1.5,
    cursor: 'pointer',
    // 🔴 EVERY CONTROL IN THE OVERLAY COLUMN TAKES POINTER EVENTS BACK HERE, ON
    // ITSELF — not on the row that holds it. The column is `pointerEvents:
    // 'none'` (see the note on it) and that inherits, so a button inside it is
    // DEAD until something says otherwise.
    //
    // ⚠ MEASURED 2026-08-09, and it is the second half of the same lesson the
    // column's own note records. The `move-classes` row re-enabled events on the
    // ROW; the `snap-controls` row was added later and did not, so the grid and
    // edge buttons rendered, looked enabled, reported `aria-pressed`, and could
    // not be clicked: `getComputedStyle(snap-grid-5).pointerEvents === 'none'`
    // and `document.elementFromPoint()` at the button's own centre returned
    // `viewport-canvas`. **A click aimed at "5mm" went to the 3D canvas as an
    // orbit.** #32's grid and edge snap were fully built, wired into both drag
    // handlers, and unreachable — a feature that looks shipped and cannot be
    // reached, which is the failure nothing goes red for.
    //
    // Putting it on the CHIP rather than on the row is deliberate: a flex column
    // child stretches, so a row with `pointerEvents: 'auto'` becomes an
    // invisible shield the FULL WIDTH of the column (774px measured at a 1400px
    // viewport) over a strip of canvas its ~250px of buttons never occupied.
    // The chip's own box is exactly the area the operator is aiming at, so this
    // adds no shield beyond the visible control — and every future control in
    // this column inherits the fix by using `chip`.
    //
    // ⚠ RESIDUAL, named rather than left to be discovered: a control IS a shield
    // over its own box, and this column's chips grow with the feature list. A 3D
    // affordance that ends up under one is covered, and a covered handle and a
    // dead handle fail identically. The `elementFromPoint`-at-the-handle
    // assertion the rotate e2e makes BEFORE it drags is what turns that from a
    // day of debugging arithmetic into a failure that says what it is; anything
    // else pickable in this corner wants the same assertion.
    pointerEvents: 'auto',
  };

  return (
    // `position: relative` + `overflow: hidden` are set here rather than in
    // `styles.css`: the overlays are absolutely positioned children of this
    // box, and an unclipped overlay is how a 3D panel adds horizontal page
    // scroll on a narrow screen.
    <div
      ref={host}
      className="viewport"
      data-testid="viewport"
      /* Absent until the setup effect has measured it — see the state's own
       * note. `ok` here, `unavailable` in the branch above, and nothing at all
       * before either is known. */
      data-gl={gl ? 'ok' : undefined}
      style={{ position: 'relative', overflow: 'hidden' }}
    >
      {/* One column, so the chips, the two disabled controls' reasons and the
          hidden-layers indicator stack in flow instead of being pinned at
          hand-tuned offsets that go wrong the moment a row wraps.

          🔴 `pointerEvents: 'none'` IS LOAD-BEARING, NOT TIDINESS. This column is
          ~654px wide on a 670px canvas and it is TEXT — with pointer events on, it
          is an invisible shield over the top third of the viewport, and every 3D
          affordance under it stops responding. The rotate handle was clearing it
          by 15.35px, which is LESS THAN ONE WRAPPED LINE of this column's own text
          (11.5px/1.5 = 17.25px); unrelated additions to the column spent that
          margin inside a single session and the clearance went to -36.4px.

          ⚠ A covered handle and a broken handle fail IDENTICALLY — `mouse.down()`
          landed on `span[data-testid=gap-status]`, the viewport never saw a grab,
          and the panel then honestly reported 0 rotation for all 36 sweep steps.
          That read as broken rotation arithmetic and cost a day. The e2e test now
          asserts `elementFromPoint` at the handle is the canvas BEFORE it drags,
          so the next time this is covered the failure says so.

          The margin was never designed — it was arithmetic nobody checked. Anything
          added here needs its own `pointerEvents: 'auto'`, exactly as `hover-panel`
          two blocks below already does. */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          maxWidth: 'calc(100% - 16px)',
          font: '11.5px/1.5 var(--font-primary, inherit)',
          pointerEvents: 'none',
        }}
      >
      {/* 🔴 NOTHING ON THIS CANVAS TOGGLES A LAYER ANY MORE — founder,
          2026-08-11, in two steps.

          First: *"INSTEAD of having the hide/show on the top of the 3d … put it
          into the left sidebar … like a small eye icon"*. The per-layer chips
          moved onto the header of the panel that owns the object each one hides,
          which is where a control belongs: beside the thing it acts on.

          Then, when I kept an `all` / `none` pair here on the argument that a
          GLOBAL control belongs to no panel: *"move the view layers all none
          above the Machine what will control all hide/view (just an eye)"*. He
          agreed the control is global and disagreed about where global lives —
          it is the top of the sidebar, above `panel-machine`, as ONE tri-state
          eye. So the pair is gone from the canvas too.

          🔴 WHAT REMAINS HERE IS REPORTING, NOT CONTROL: the reason lines below
          and the hidden-layers indicator at the foot. Those matter MORE now, not
          less — see the indicator's own note. The canvas says what is missing
          from the picture and why; the sidebar decides it.

          ⚠ WHAT WAS LOST, named rather than left to be discovered: the chip row
          was the one place every layer's swatch appeared at once, so it doubled
          as the move-class LEGEND. The swatch travels with each eye into the
          sidebar, which keeps the colour attached to its label — but the eight
          panels are not all open at once, so there is no longer a single view of
          the whole legend. That is the cost of the founder's "instead of", and
          it is a real one. */}

      {/* --- snap (TODO #32) ------------------------------------------------
          🔴 SNAP CHANGES THE DATUM, WHICH CHANGES THE PROGRAM. Both controls
          default to OFF, both say what they did, and the value that reaches the
          numeric fields is the SNAPPED one — never a tidy display over an
          untidy truth.

          🔴 FIRST IN THE COLUMN SINCE 2026-08-11 — founder, *"move the snap to
          the top"*. It is now the only CONTROL in a column that is otherwise all
          reporting, so the reading order is: what you can change, then what the
          picture is not showing you.

          ⚠ PROMINENCE IS NOT COMPREHENSION, and the reason he asked what this
          row does is the finding worth keeping: every word explaining
          `off / 1 / 5 / 10 / edges` lived in a `title=`, which is a hover a
          shop-floor operator on a touch screen never performs. Two of those
          sentences are now on the screen and the rest stay in the tooltips,
          deliberately:

            · THE ROW'S STAKES — *changes the datum, which changes the program* —
              inline beside the label, because it is the answer to "what is this
              row for" and it is seven words.
            · THE `edges` LIMIT — the safety-bearing one, on its own line, and
              only while `edges` is ON. It is the one sentence here that says the
              control REFUSES something an operator would expect it to do, so it
              has to be readable at the moment it can bite.
            · Everything else — the 0.1mm rounding under `off`, the "the field
              shows the snapped number" rule under 1/5/10, the `EDGE_SNAP_MM`
              radius and the list of edge targets — stays in `title=`. Pasting
              the whole set into the viewport is the clutter this column was just
              swept clear of, and none of those is a refusal.

          ⚠ The chips carry the shared `chip` style, which takes pointer events
          back on the BUTTON — see its note. Moving the row does not change that,
          and it moves the only pointer shield in this column to the top-left
          corner, away from the canvas mid-field the drag handles live in. */}
      <div
        data-testid="snap-controls"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}
      >
        <span style={{ color: 'var(--muted)' }}>snap — changes the datum, which changes the program</span>
        <button
          type="button"
          data-testid="snap-grid-off"
          aria-pressed={gridStep === 0}
          title="No grid step. The drag still rounds to 0.1mm, which stops a datum carrying mouse noise — it does not help you land on 10."
          onClick={() => setGridStep(0)}
          style={{ ...chip, opacity: gridStep === 0 ? 1 : 0.55 }}
        >
          off
        </button>
        {GRID_STEPS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid={`snap-grid-${s}`}
            aria-pressed={gridStep === s}
            title={`Round the datum to ${s}mm. The field shows the snapped number, because that is the number the program is cut from.`}
            onClick={() => setGridStep((g) => (g === s ? 0 : s))}
            style={{ ...chip, opacity: gridStep === s ? 1 : 0.55 }}
          >
            {s}mm
          </button>
        ))}
        <button
          type="button"
          data-testid="snap-edges"
          aria-pressed={edgeSnap}
          title={
            `Snap to the machine origin, the travel limits, and the edges of the other things on the machine — within ${EDGE_SNAP_MM}mm. ` +
            'Nesting is done against edges, not against a coordinate. ' +
            '🔴 There is no CONTACT target: this will align two footprints and it will not put them flush, because flush is the gesture that produces a job the cutter cannot run.'
          }
          onClick={() => setEdgeSnap((v) => !v)}
          style={{ ...chip, opacity: edgeSnap ? 1 : 0.55 }}
        >
          edges
        </button>
      </div>
      {/* 🔴 THE REFUSAL, OUT OF THE TOOLTIP. `snapAxis` deliberately offers no
          contact candidate, and that is the single most surprising thing this
          control does — an operator who turns on an edge snap is expecting to be
          able to butt two footprints together. A refusal explained only on hover
          reads as a bug, and the operator's next move after "it will not go
          flush" is to type the coordinate by hand.

          ⚠ Rendered only while `edges` is ON: it is the state in which the limit
          can be met, and an always-on line about a control nobody switched on
          spends this column's finite vertical budget on nothing. Plain text, so
          it adds no pointer shield. */}
      {edgeSnap && (
        <span data-testid="snap-edges-limit" style={{ color: 'var(--warn)' }}>
          edges aligns — it never puts two things touching. There is no contact target, because
          flush is the gesture that produces a job the cutter cannot run.
        </span>
      )}
      {snapNote && (
        <span
          data-testid="snap-readout"
          style={{ color: snapNote.warn ? 'var(--warn)' : 'var(--muted)' }}
        >
          {snapNote.text}
        </span>
      )}

      {/* 🔴 THE TRIAD'S CAPTION, and the half of it a picture cannot carry. The
          arrows show WHICH WAY the axes run; only words can say WHOSE axes the
          panel's `Part X` / `Part Y` are, and that is the fact the founder was
          missing on 2026-08-10. It is warn-coloured when the frames differ,
          because that is the state in which the numeric fields do something an
          operator reading the machine's axes would not predict.

          ⚠ Plain text, so it inherits the column's `pointerEvents: 'none'` and
          adds no shield over the canvas — see the column's own note. It costs
          one line of the column's vertical budget, which that note is explicit
          about being finite. */}
      <span
        data-testid="axes-frame"
        style={{ color: axesNote.turned ? 'var(--warn)' : 'var(--muted)' }}
      >
        {axesNote.text}
      </span>

      {/* The reasons, VISIBLE rather than only in a tooltip. A disabled control
          whose blocker is hidden behind a hover is a control that reads as
          broken — and these two are disabled for entirely different reasons, at
          opposite ends of the pipeline, so they get a line each. */}
      {!loadedLive && (
        <span data-testid="loaded-unavailable" style={{ color: 'var(--muted)' }}>
          {LOADED_LABEL} — {loadedReason(props.loaded, props.loadedMesh, wallsLive)}.
        </span>
      )}
      {/* 🔴 A decimated mesh is a DIFFERENT SOLID — facets are missing and its
          bounds can be tighter than the real part's. That has to be on the
          SCREEN, not only in a hover: the loaded object is the thing the user
          recognises, so a wrong version of it is the one they believe. */}
      {loadedLive && props.loadedMesh!.decimated && (
        <span data-testid="loaded-decimated" style={{ color: 'var(--warn)' }}>
          {LOADED_LABEL} drawn from {props.loadedMesh!.triangles} of{' '}
          {props.loadedMesh!.source_triangles} triangles — a display copy with facets missing. Fit
          for looking at, not for measuring.
        </span>
      )}
      {/* 🔴 This line used to say "the report carries the cutter centre line,
          not the drawing's contours". That was MEASURED and true when it was
          written, and it stopped being true when `Report.drawing` landed. It is
          the second reason in this file to have gone stale while still reading
          as a fact about the code — the first was the simulated surface, and the
          founder read that one off the screen and asked about a blocker already
          cleared. A stale RED lies exactly like a stale green. */}
      {!wallsLive && (
        <span data-testid="walls-unavailable" style={{ color: 'var(--muted)' }}>
          {WALLS_LABEL} — {wallsReason(props.drawing)}.
        </span>
      )}
      {/* 🔴 The ASSUMED height goes on the CANVAS, not in a hover. It is the one
          number in this layer nobody measured, and the same rule the importer
          follows for a missing `$INSUNITS` applies: an assumption that is not
          visible is an assumption that gets quoted as a measurement.

          ⚠ THIS LINE NO LONGER POINTS AT THE RESULT LAYER (2026-08-11). It
          ended *"the simulated stock surface is what the machine would leave"*,
          which `result-resolution` — the very next line in this column, and the
          layer that owns the claim — states better and with its cell size:
          *"the stock the machine would leave, not the part"*. What is kept is
          this layer's OWN fact, that the square inside corners drawn here are
          not makeable; a caption whose second half is a pointer at its
          neighbour is the neighbour said twice. **Text-only judgement — no
          browser was available; the two are adjacent in the same overlay
          column whenever both layers are live.** */}
      {wallsLive && (
        <span
          data-testid="walls-basis"
          style={{ color: wallH.assumed ? 'var(--warn)' : 'var(--muted)' }}
        >
          {WALLS_LABEL} — what the drawing asks for, {wallH.why}. Square inside corners no cutter
          can make and no dogbones.
        </span>
      )}
      {/* 🔴 This line used to say "the core sends the simulation's counts, not
          its heights". That was true when it was written and stopped being true
          in `18adbcbf2`, when `Report.simulated_stock_surface` landed — and the
          founder read the stale sentence off the screen and asked about a
          blocker that had already been cleared. A reason is a claim about the
          code and goes stale exactly like any other. */}
      {!resultLive && (
        <span data-testid="result-unavailable" style={{ color: 'var(--muted)' }}>
          {RESULT_LABEL} — {resultReason(props.stockSurface)}.
        </span>
      )}
      {/* A strided map is a DIFFERENT PICTURE — whole samples are skipped, so
          the deepest point inside one may not be drawn. Same treatment as a
          decimated mesh: on the screen, not in a hover. */}
      {resultLive && (
        <span data-testid="result-resolution" style={{ color: 'var(--muted)' }}>
          {RESULT_LABEL} at {props.stockSurface!.cell_mm}mm cells — the stock the machine would
          leave, not the part. {resultCaveats(props.stockSurface!.cell_mm)}
        </span>
      )}

      {/* ⚠ THE MINIMUM-GAP LINE STAYS HERE, with the other reporting lines,
          while the snap row it used to sit under moved to the top of the column
          on 2026-08-11. It reads as a snap caption and is not one: it reports
          what the CORE was able to tell this viewport about clearance, in the
          same family as the `…-unavailable` reasons above it. Its last clause —
          that flush is refused regardless — is now stated where the operator
          meets it, on the `edges` control itself. */}
      <span data-testid="gap-status" style={{ color: gap.warn ? 'var(--warn)' : 'var(--muted)' }}>
        {gap.text}
      </span>

      {/* 🔴 A HIDDEN LAYER THAT GETS ITS OWN LINE, because its absence from the
          picture is a claim about the MACHINE rather than about the drawing.
          Hide `cut` and the workpiece looks uncut; hide the work holding and the
          machine looks CLEAR — and "the machine is clear" is the fact an
          operator acts on before they let a 2.2 kW spindle traverse it.

          The generic indicator below would name the layer in its list, which is
          true but not loud, and it counts LAYERS rather than clamps. This line
          states the number that was declared, so the emptier picture cannot be
          read as an empty machine. It is the same distinction `Fixturing` makes
          between "nothing declared" and "a human confirmed the machine is
          clear", held on the canvas instead of only in the report.

          ⚠ THIS SAID "THE ONE HIDDEN LAYER THAT GETS ITS OWN LINE" UNTIL
          2026-08-11 AND THERE ARE TWO. `spoilboard-hidden`, ~60 lines down, was
          added afterwards and its own comment positions it as *"the clamps'
          argument, one rung along"*. A stale uniqueness claim is what makes the
          next reader delete the second box as a duplicate — and that box is the
          only surface in this app that says *"so is the bare reach beside it"*,
          because `Layer` has no bare-reach member for `hidden-indicator` to
          name. Corrected rather than deleted: the two are a FAMILY, and a third
          one is allowed to join it. */}
      {clampsLive && !visible.clamps && (
        <div
          data-testid="clamps-hidden"
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--warn)',
            background: 'var(--panel)',
            color: 'var(--warn)',
            font: '11.5px/1.5 var(--font-primary, inherit)',
          }}
        >
          {props.clamps.length} clamp{props.clamps.length === 1 ? '' : 's'} declared and HIDDEN —
          this machine is not clear. The fixture check still runs against{' '}
          {props.clamps.length === 1 ? 'it' : 'them all'}.
        </div>
      )}

      {/* 🔴 NO BOARD DECLARED GETS ITS OWN LINE, and it is not a hidden-layer
          message — there is no layer to hide. This canvas draws NOTHING where a
          spoilboard would be, and an empty floor is exactly what a machine with
          a board switched off looks like too. The two must not read the same,
          for the same reason `Fixturing` refuses to conflate "nothing declared"
          with "a human confirmed the bed is clear": under the board a
          through-cut is sacrificial, past its edge it is a cutter in the frame,
          and with nothing declared they are the same picture.

          ⚠ It says UNCHECKED, never "no spoilboard on this machine". This app
          knows what was DECLARED; it has never looked at the machine. */}
      {!spoilLive && (
        <div
          data-testid="spoilboard-undeclared"
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            color: 'var(--muted)',
            font: '11.5px/1.5 var(--font-primary, inherit)',
          }}
        >
          No spoilboard declared — position UNCHECKED. Nothing is drawn under the work because
          nothing was declared, and that is not a board covering the travel envelope.
        </div>
      )}

      {/* 🔴 A DRAWN BOARD WHOSE CORNER NOBODY MEASURED. The rectangle on the
          canvas is the most convincing thing in this app — it looks like a
          photograph of the machine — and an assumed corner drawn identically to
          a measured one is the picture doing the persuading. Said on the canvas
          rather than only in the panel, because this is where the operator
          decides the board is "obviously" under the work. */}
      {spoilLive && visible.spoilboard && props.spoilboardPositionAssumed && (
        <div
          data-testid="spoilboard-position-assumed"
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--warn)',
            background: 'var(--panel)',
            color: 'var(--warn)',
            font: '11.5px/1.5 var(--font-primary, inherit)',
          }}
        >
          The spoilboard is drawn at an ASSUMED corner — this app fitted it, nobody measured it.
          Your board is bolted where the T-slots allowed.
        </div>
      )}

      {/* Declared and switched off. The clamps' argument, one rung along: the
          board is the thing that makes a through-cut correct, so a picture with
          it hidden shows a cut into apparently nothing. */}
      {spoilLive && !visible.spoilboard && (
        <div
          data-testid="spoilboard-hidden"
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--warn)',
            background: 'var(--panel)',
            color: 'var(--warn)',
            font: '11.5px/1.5 var(--font-primary, inherit)',
          }}
        >
          A spoilboard IS declared and HIDDEN — so is the bare reach beside it. The check still
          runs against both.
        </div>
      )}

      {/* 🔴 The indicator that makes the toggles safe. Someone who hides `cut`,
          sees a clean board and concludes nothing is cut there has been misled
          by a control we gave them — so an emptier picture always carries the
          reason it is emptier, on the canvas, with nothing to open.

          🔴 AND IT MATTERS MORE SINCE 2026-08-11, NOT LESS. The controls now
          live in eight collapsible panels. The section EYE is on the header and
          so survives collapsing — that is why it is there — but it is a GROUP
          control: on a shut `Operation` it can only say "4 of 6", and it cannot
          say WHICH two. This line names them, all of them, from one place. It
          is the only surface left that does, which is why the founder's "instead
          of" could not be allowed to take it with the chips.

          ⚠ It counts LIVE layers only. "Switched off" and "there is none" stay
          different facts, and the denominator is a claim about the scene. */}
      {hiddenLayers.length > 0 && (
        <div
          data-testid="hidden-indicator"
          style={{
            padding: '3px 8px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--warn)',
            background: 'var(--panel)',
            color: 'var(--warn)',
            font: '11.5px/1.5 var(--font-primary, inherit)',
          }}
        >
          {hiddenLayers.length} of {liveLayers.length} view layers hidden (
          {hiddenLayers.map((k) => LAYER_LABEL[k]).join(', ')}) — the picture only. The program is
          unchanged.
        </div>
      )}
      </div>

      {hover && (
        <div
          data-testid="hover-panel"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 2,
            // Never intercepts the pointer: a panel that swallows the hover
            // that produced it flickers on and off at its own edge.
            pointerEvents: 'none',
            maxWidth: 'min(280px, calc(100% - 16px))',
            padding: '7px 9px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            color: 'var(--ink)',
            font: '11.5px/1.5 var(--font-primary, inherit)',
          }}
        >
          <strong>{hover.title}</strong>
          <dl style={{ margin: '4px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1px 8px' }}>
            {hover.rows.map(([k, v, tone]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--muted)' }}>{k}</dt>
                <dd
                  data-testid={`hover-row-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                  data-tone={tone ?? 'none'}
                  style={{
                    margin: 0,
                    fontVariantNumeric: 'tabular-nums',
                    /* 🔴 THREE tones, and PENDING is `--muted` — the token
                     * `styles.css`'s `.pending` rule reserves for a fact this
                     * app does not hold. It is deliberately NOT `--ok` with the
                     * contrast turned down: a check that could not run and a
                     * check that found nothing must not be the same colour.
                     * These are the panels' own tokens, resolved here rather
                     * than re-picked as colours. */
                    color:
                      tone === 'bad'
                        ? 'var(--bad)'
                        : tone === 'warn'
                          ? 'var(--warn)'
                          : tone === 'pending'
                            ? 'var(--muted)'
                            : undefined,
                  }}
                >
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {hover.note && (
            <p style={{ margin: '5px 0 0', color: 'var(--muted)' }} data-testid="hover-note">
              {hover.note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
