// Bridge to the CAM core (WASM).
//
// 🔴 No machining decision is made in TypeScript. This module loads the module,
// forwards calls, and types the answers. Anything computed here would be
// invisible to the CLI and to the gates, and the parity check (gate I1) would
// then be comparing two different programs.

// ─────────────────────────────────────────────────────────────────────────────
// THE CORE RUNS IN A WORKER, AND UNTIL 2026-08-29 IT DID NOT (TODO #144)
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 `README.md`'s stack table said "WASM in a Web Worker — slicing must not
// block the canvas" and had never been true. This module loaded the glue on the
// MAIN THREAD and called straight into it; the only `Worker` under `web/src`
// was the serial streamer, which does no CAM. Planning a large drawing froze
// the canvas the row said it protected.
//
// The refactor is contained HERE on purpose, and that is a property of what was
// already written rather than luck: every export that touches the core was
// ALREADY `async` (18 of them), and the five synchronous exports are pure
// TypeScript that never touch it. So the call sites in `App.tsx`,
// `Viewport.tsx`, `store.ts` and `runProgram.ts` are unchanged — they were
// already awaiting a Promise, and now the Promise resolves from another thread.
//
// ⚠ NO SILENT FALLBACK TO THE MAIN THREAD. If the Worker cannot be constructed
// this throws, by name. A fallback would be the kinder-looking choice and it
// would re-create the exact defect being fixed, invisibly: the app would keep
// working, the canvas would freeze again, and nothing would say which path it
// took. A blocking failure is observable; a silent regression is not.

import type { CamRequest, CamResponse } from './cam.worker';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function camWorker(): Worker {
  if (worker) return worker;
  if (typeof Worker === 'undefined') {
    throw new Error(
      'this host has no Worker, so the CAM core cannot be started off the main thread. ' +
        'It is NOT run on the main thread instead: that is the defect TODO #144 fixed, and a ' +
        'silent fallback would bring it back with nothing to show which path was taken.',
    );
  }
  // A literal `new URL(..., import.meta.url)` so Vite can see the entry and
  // bundle it — the same reason the wasm glue import is a literal.
  worker = new Worker(new URL('./cam.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<CamResponse>) => {
    const { id, ok, out, err } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(out);
    else p.reject(new Error(err ?? 'the CAM worker failed without saying why'));
  };
  // 🔴 A worker that DIES must not leave every caller awaiting forever. A hung
  // promise is indistinguishable from a slow plan, and the operator is left
  // watching a spinner over a core that is gone.
  worker.onerror = (ev) => {
    const why = new Error(`the CAM worker stopped: ${ev.message || 'no message'}`);
    for (const [, p] of pending) p.reject(why);
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Call one export of the CAM core, in the worker. */
function call(fn: string, args: unknown[]): Promise<unknown> {
  const w = camWorker();
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, fn, args } satisfies CamRequest);
  });
}

/** Call an export that returns a JSON string, and parse it. */
async function callJson<T>(fn: string, args: unknown[]): Promise<T> {
  return JSON.parse((await call(fn, args)) as string) as T;
}

/**
 * Start the worker and wait for the core to be loaded and answering.
 *
 * ⚠ This no longer returns the wasm module — it cannot, because the module
 * lives in another thread and does not survive `structuredClone`. Nothing
 * outside this file ever used the returned value (checked 2026-08-29: no
 * `loadCam` reference exists in `web/src` outside `cam.ts`), and the type is
 * `void` now so a future caller cannot start depending on one.
 */
export async function loadCam(): Promise<void> {
  await call('version', []);
}

export type RenderKind = 'rapid' | 'cut' | 'tab' | 'drill' | 'change' | 'probe';

/**
 * One point of the drawn toolpath — the **cutter centre**, with the per-move
 * facts the emitted program carries.
 *
 * 🔴 This is the offset path, not the drawing. The tool radius, the lead-ins,
 * the tabs and the corner reliefs are all already in these coordinates, and
 * there is no way back: see {@link Report.drawing}, which is the imported
 * geometry, exported separately for exactly that reason.
 */
export interface RenderMove {
  kind: RenderKind;
  x: number;
  y: number;
  z: number;
  /**
   * mm/min in force for this move — the same number the post writes as an `F`
   * word. (`F` is modal in G-code: the program writes one only when the feed
   * changes. This field repeats it on every move so nothing here has to track
   * modal state, which is a G-code rule and not a UI's job.)
   *
   * 🔴 **`undefined` is not zero.** It means the move carries no feed at all —
   * a `G0` rapid, a tool change, a probe. Do not write `feed ?? 0` and divide;
   * do not substitute a number of your own. A rapid runs at
   * {@link Report.rapid_mm_min}, because a `G0` has no `F` word to read.
   *
   * Duration of a move, in seconds, is `distanceMm / (mmPerMin / 60)` — with
   * `mmPerMin` being this field for a cutting move and `rapid_mm_min` for a
   * rapid. Neither the core's estimate nor that arithmetic models acceleration,
   * so both run short on a program full of short moves; `notes` says so with
   * this job's own numbers.
   */
  feed?: number;
  /**
   * Peck increment in mm, on a drill move that pecks. Absent on every other
   * kind, and absent on a drill that goes straight to depth — which is a
   * different fact from "pecks by 0mm", and only one of them can be drawn.
   */
  peck_mm?: number;
  /**
   * The tool this `change` asks the operator to fit. Present on `kind:
   * 'change'` and on nothing else — a program is thousands of moves and an
   * empty string on every one of them is pure weight on the biggest array in
   * the report.
   */
  text?: string;
}

/**
 * A vertex of an imported contour, in mm, exactly as the drawing had it.
 *
 * `bulge` is `tan(theta / 4)` of the arc from THIS vertex to the NEXT one;
 * `0` is a straight segment; positive sweeps counter-clockwise. Wrapping: the
 * last vertex's bulge belongs to the segment back to the first, on a closed
 * contour.
 *
 * 🔴 **The arcs are not flattened.** {@link RenderMove} is flattened, because it
 * is a path to draw. This is the *drawing*, and something that measures a radius
 * off it has to get the radius that was drawn — a chord-flattened arc measures
 * small with nothing on screen to say by how much.
 *
 * To turn a segment `a -> b` with bulge `t` into line work at a tolerance you
 * choose and can state:
 *
 * ```ts
 * if (a.bulge === 0) return straightSegment(a, b);  // no arc to tessellate
 * const theta  = 4 * Math.atan(a.bulge);            // signed sweep, radians
 * const chord  = Math.hypot(b.x - a.x, b.y - a.y);
 * const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
 * ```
 *
 * A full circle arrives as **two** vertices, each with `|bulge| === 1` (a half
 * turn each) — a circle cannot be one vertex, because it would have no start
 * point.
 */
export interface DrawingVertex {
  x: number;
  y: number;
  /** `tan(theta / 4)` of the arc to the next vertex. `0` = straight. */
  bulge: number;
}

/** One closed boundary of an imported part, in mm. */
export interface DrawingContour {
  verts: DrawingVertex[];
  /**
   * Whether the last vertex joins back to the first. Everything that reaches
   * the CAM is closed — an unclosed contour is refused upstream and named in
   * `notes` — but the flag is carried rather than assumed, because closing an
   * open loop invents an edge the drawing never had.
   */
  closed: boolean;
}

/**
 * A part **as the drawing had it**: outer boundary plus every hole, before any
 * tool offset.
 *
 * This is the geometry to extrude into walls for a 2D drawing. Do NOT try to
 * recover it from {@link Report.render} — that is the cutter centre line, with
 * the tool radius, lead-ins, tabs and reliefs baked in, and un-offsetting it in
 * TypeScript is three transforms deep and has been a defect every time.
 *
 * 🔴 The holes matter as much as the outline. A part drawn without them looks
 * entirely correct and is a plate with no holes in it.
 */
export interface DrawingPart {
  name: string;
  outer: DrawingContour;
  /**
   * Interior boundaries — holes, slots, rabbets. Empty means the importer found
   * none, not that they were dropped: if contours were not exported at all,
   * `outer` would be missing too because the whole part would be.
   */
  inners: DrawingContour[];
}

export interface ClampCfg {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  height_mm: number;
  /** Degrees anticlockwise about the clamp's own (x, y) anchor. */
  rotation_deg?: number;
}

/**
 * A spoilboard as the config DECLARES it and as the report ECHOES it back.
 *
 * 🔴 Two ways in and they may not be combined: `catalogue_id` (an id from
 * {@link spoilboards}, which supplies the size) **or** `size_x_mm` +
 * `size_y_mm`. `x_mm`/`y_mm` are ALWAYS required — the core refuses a size
 * without a position, because *"is there sacrificial material under this XY"*
 * is the only question this declaration exists for and a size alone cannot
 * answer it. `0,0` is not a safe default: it slides the board toward the datum
 * and turns bare rail into declared spoilboard.
 *
 * Any violation installs **NOTHING** and the core pushes
 * `SPOILBOARD NOT INSTALLED — <why>` into {@link Report.notes}. It is never a
 * near-miss substitution.
 *
 * ⚠ On the ECHO, `catalogue_id` is always `null`: what is installed is a
 * rectangle, and a host redrawing it must not have to resolve a catalogue to
 * find out where it is.
 */
export interface SpoilboardCfg {
  catalogue_id?: string | null;
  name?: string | null;
  x_mm?: number | null;
  y_mm?: number | null;
  size_x_mm?: number | null;
  size_y_mm?: number | null;
  /**
   * **How thick the slab is**, in mm — the number
   * {@link SimCounts.board_depth} needs to answer *"did the cutter go through
   * the board into the machine?"*.
   *
   * 🔴 **ON THE MEASURED FORM ONLY.** Sending it beside `catalogue_id` does not
   * override the entry's sourced figure — the core **refuses the whole board**,
   * installs nothing, and pushes `SPOILBOARD NOT INSTALLED — …` into
   * {@link Report.notes}, on the same rule that refuses a size beside an id:
   * there is no tie-break between two numbers about one slab. A catalogue pick
   * carries its own thickness across without this key.
   *
   * 🔴 **ABSENT IS UNKNOWN, NEVER "THICK ENOUGH".** A measured board with no
   * thickness installs fine and the depth limb reports PENDING with its reason.
   * That is a sayable answer and this app must not fill it in.
   *
   * ⚠ Also present on the ECHO, where it is the thickness of the board that was
   * actually installed — the catalogue's, when an id was used.
   */
  thickness_mm?: number | null;
}

/** One sourced board, exactly as the core's catalogue states it. */
export interface SpoilboardSpec {
  id: string;
  label: string;
  size_x_mm: number;
  size_y_mm: number;
  /**
   * The board's thickness in mm, **or `null` when the source this entry cites
   * did not state one**.
   *
   * ✅ **CORRECTED 2026-08-11.** This field was typed `number` and documented
   * *"nominal, DESCRIPTIVE, and read by no check in the core"*. Both halves are
   * now false and each was false in a different direction:
   *
   * - **A check reads it.** `SpoilboardSpec::install_at` carries the figure onto
   *   the installed board and {@link SimCounts.board_depth} uses it to answer
   *   *"did the cutter go through the board into the machine?"* — a question the
   *   old model could not express at all.
   * - **It can be `null`.** The core made it `Option<f64>`, because an entry
   *   whose cited page states no thickness carries `None` rather than an
   *   invented number — absent reads as unknown, invented reads as measured, and
   *   the depth limb reports PENDING on the first. Every entry shipped today
   *   happens to have one, so a renderer that ignores this prints `nullmm` only
   *   for the entry nobody has added yet.
   */
  thickness_mm: number | null;
  material: string;
  /** A URL or a path inside this repo. Where the numbers were read. */
  source: string;
  /** ISO date the source was read. A sourced number with no date is uncheckable. */
  read_on: string;
  /** What this entry does NOT tell you. Never empty. */
  note: string;
}

/**
 * The catalogue payload.
 *
 * 🔴 `default_id` is `null` and the key is present **deliberately** — the core
 * says a missing key would read as "the host may choose". It does not choose.
 */
export interface SpoilboardCatalogue {
  spoilboards: SpoilboardSpec[];
  default_id: string | null;
  position_required: boolean;
  why_no_default: string;
}

export interface SimCounts {
  cell_mm: number;
  gouge: number;
  uncut: number;
  /**
   * Cells that went below the underside of the sheet by more than the
   * sacrificial allowance — **all classes**.
   *
   * 🔴 THIS IS NOT A DEFECT COUNT. A through-cut **over** the board is what a
   * through-cut is for. The number to alarm on is
   * {@link SimCounts.past_spoilboard_edge}, and only when
   * {@link SimCounts.spoilboard_position_checked} is `true`.
   */
  spoilboard: number;
  first: string | null;
  /**
   * 🔴 THE FIELD THAT SAYS WHETHER {@link SimCounts.uncut} IS A MEASUREMENT.
   * `false` ⇒ the uncut limb never ran — `core/src/sim.rs::check` gates the whole
   * test on `remove_depth_mm > 0.0`, and a job that declares no region to CLEAR
   * gives it nothing to test against. `0` with this `false` is PENDING, not a
   * clean bill; `0` with this `true` is a genuine measured clean result and must
   * not be rendered as PENDING.
   *
   * The core's own doc says a consumer must key off THIS, not off `uncut`. It
   * appeared in neither this file nor `App.tsx` until 2026-08-11, so the panel
   * keyed on `uncut > 0` and printed *"on your job this counter cannot fire"*
   * beside `pocket`'s red 3 — false, and measured false at the CLI.
   *
   * Optional here only for a locally-constructed placeholder report; absent
   * reads as `false`, which is the honest default rather than the reassuring
   * one — the same rule the core applies with `#[serde(default)]`, and the same
   * shape as {@link SimCounts.spoilboard_position_checked} beside it.
   */
  uncut_checked?: boolean;
  /**
   * The EVIDENCE behind {@link SimCounts.uncut_checked}: how many map cells the
   * uncut test actually looked at. `9604` on the `pocket` fixture, `0` on
   * `plate`. A flag with no count cannot be told from a flag that is stuck.
   */
  uncut_cells_tested?: number;
  /** Why the uncut limb did not run, **in the core's words**. Never reworded
   *  here, and `null`/absent whenever {@link SimCounts.uncut_checked} is true. */
  uncut_pending_reason?: string | null;
  /**
   * Of the cells above, the ones at an XY **no declared board covers** — bare
   * machine: a rail, an extrusion, a T-slot, the frame.
   *
   * ⚠ Only meaningful when {@link SimCounts.spoilboard_position_checked} is
   * `true`. `0` with the flag `false` is PENDING, not clean.
   */
  past_spoilboard_edge?: number;
  /**
   * 🔴 THE FIELD THAT SAYS WHETHER `past_spoilboard_edge` IS A MEASUREMENT.
   * `false` ⇒ no board is declared, the below-the-sheet cells were judged on
   * DEPTH ALONE, and nothing says what the cutter reached.
   *
   * Optional here only for a locally-constructed placeholder report; absent
   * reads as `false`, which is the honest default rather than the reassuring
   * one — the same rule the core applies with `#[serde(default)]`.
   */
  spoilboard_position_checked?: boolean;
  /** Why the position limb did not run, **in the core's words**. Never reworded here. */
  spoilboard_pending_reason?: string | null;
  /**
   * **DID THE CUT GO PAST THE DECLARED BOARD'S UNDERSIDE?** —
   * `"through-board"`, `"inside-board"` or `"board-depth-unknown"`.
   *
   * 🔴 A DIFFERENT QUESTION from the three fields above. Those ask *"is there a
   * board under this XY at all"*; this asks *"the board is under here — did the
   * cutter go through it into the machine?"* A job can be over the board with an
   * unknown thickness, or past the board's edge with a perfectly known one, so
   * the two limbs are rendered separately.
   *
   * 🔴 **`"board-depth-unknown"` IS PENDING, NOT A PASS. COLOUR THIS WORD,
   * NEVER THE COUNT BESIDE IT.** The verdict is a three-state string rather than
   * a boolean precisely so a host cannot render PENDING and CLEAR the same way.
   *
   * ⚠ Optional here only for a locally-constructed placeholder report; absent
   * reads as PENDING, which is the honest default — the same rule the core
   * applies with its `board_depth_unknown` serde default.
   */
  board_depth?: string | null;
  /**
   * Cells that went past the declared board's underside — cutter below the slab,
   * in whatever the machine is built of.
   *
   * ⚠ Only meaningful when {@link SimCounts.board_depth} is `"through-board"` or
   * `"inside-board"`. `0` beside `"board-depth-unknown"` is **PENDING**, exactly
   * as `uncut: 0` and `past_spoilboard_edge: 0` are.
   *
   * ⚠ Cells past the board's EDGE are not counted here at all — there is no
   * board under them for a cut to go through, and `past_spoilboard_edge` has
   * already reported them. Counting one hazard twice renders it as two.
   */
  through_board?: number | null;
  /** Why the depth limb did not run, **in the core's words**. Never reworded
   *  here, and `null`/absent whenever the verdict is not PENDING. */
  board_depth_pending_reason?: string | null;
}

/**
 * The **simulated stock surface after machining**, as the core encodes it.
 *
 * 🔴 THIS IS NOT THE PART. Read this before drawing it, and before labelling
 * anything on screen with it:
 *
 * - It is a **model at a resolution**. Every number is the surface height at one
 *   sample, `cell_mm` apart. A gouge narrower than one cell is not blurred — it
 *   is **not in the data**. Drawing this as a smooth solid asserts a
 *   smoothness nothing measured.
 * - For a **through-cut it shows removed material and does not know which side
 *   of the cut you keep**. The part and the offcut sit on opposite sides of the
 *   same boundary and this map treats both as "stock still standing". You
 *   cannot recover the part from it, because the information is not there.
 *
 * So label it "simulated stock surface" (or "simulated result at N mm"). Never
 * "the part", "your part", "the finished object", "the result", "preview of
 * what you get". The type name is deliberately the least convenient one to
 * mistype into a marketing word.
 */
export interface StockSurface {
  cols: number;
  rows: number;
  /**
   * The resolution OF THIS ARRAY — not the simulation's, which may be finer.
   * It travels inside the object so any consumer can state the resolution of
   * what it is drawing without going and asking something else.
   */
  cell_mm: number;
  /** World position of sample (col 0, row 0), in mm. */
  origin_x_mm: number;
  origin_y_mm: number;
  /**
   * `cols * rows` little-endian f32, row-major, base64.
   *
   * Do not parse this by hand — call {@link decodeStockSurface}. It is base64
   * and not a JSON number array because the number array is ~15MB of text for a
   * 600x900 sheet at the default cell, against 8.0MB of base64 that decodes in
   * one pass into a `Float32Array` a GPU can take directly.
   */
  z_mm_b64: string;
}

/**
 * The same surface with its heights decoded, ready to feed a geometry.
 *
 * `z_mm[row * cols + col]` is the surface height in mm at
 * `(origin_x_mm + col * cell_mm, origin_y_mm + row * cell_mm)`: `0` is uncut
 * stock top, negative is material removed to that depth.
 *
 * `cell_mm` is carried through onto the decoded object as well, for the same
 * reason it is on the encoded one — a renderer holding only the `Float32Array`
 * could not state what it is drawing.
 */
export interface DecodedStockSurface {
  cols: number;
  rows: number;
  cell_mm: number;
  origin_x_mm: number;
  origin_y_mm: number;
  z_mm: Float32Array;
}

/**
 * Decode a {@link StockSurface} into a `Float32Array` of heights.
 *
 * 🔴 The length is checked against `cols * rows` and a mismatch THROWS. A short
 * array read row-major does not fail — it produces a picture that is
 * progressively skewed and entirely plausible, and nobody spots a machined
 * sheet drawn on a slant.
 */
export function decodeStockSurface(s: StockSurface): DecodedStockSurface {
  const bin = atob(s.z_mm_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const z = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  if (z.length !== s.cols * s.rows) {
    throw new Error(
      `simulated stock surface: ${z.length} heights for a ${s.cols}x${s.rows} map`
    );
  }
  return {
    cols: s.cols,
    rows: s.rows,
    cell_mm: s.cell_mm,
    origin_x_mm: s.origin_x_mm,
    origin_y_mm: s.origin_y_mm,
    z_mm: z,
  };
}

/**
 * The model the user LOADED, as the core encodes it. The **input**.
 *
 * 🔴 THIS IS NOT WHAT WILL BE CUT. Read this before drawing it, and before
 * putting any word on the screen next to it.
 *
 * The machine cuts the **section** at {@link LoadedMesh.section_z_mm} — one flat
 * outline through this solid, planned as 2.5D. There is no surfacing, no
 * waterline, no Z-level roughing anywhere in this engine and there is not going
 * to be. So a viewer looking at this 3D object is looking at their model, not at
 * the part: the machine makes one flat outline through it.
 *
 * That sentence is the whole reason this type exists in this shape, because a
 * PICTURE of a solid asserts "the machine makes this" far more strongly than a
 * note can withdraw it. Whatever draws this must also draw or state the section,
 * and must never label it "the part", "your part", "the result", "the finished
 * object" or "preview of what you get" — those belong to nothing this tool
 * currently produces.
 *
 * Do not confuse it with {@link StockSurface}, which is the opposite end of the
 * same job:
 *
 * | | `LoadedMesh` | `StockSurface` |
 * |---|---|---|
 * | what | the model as loaded | the stock after machining |
 * | direction | INPUT | OUTPUT |
 * | on a refused job | still present | absent |
 */
export interface LoadedMesh {
  /**
   * Triangles **in the array**, never the number that was requested. Loop and
   * allocate against this; a UI that trusts its own budget draws a mesh that
   * does not exist.
   */
  triangles: number;
  /** Triangles in the FILE. Differs from `triangles` only when the budget bit. */
  source_triangles: number;
  /**
   * True when a display budget dropped triangles.
   *
   * 🔴 A decimated mesh is a **DIFFERENT SOLID** — whole facets are missing, so
   * it has holes and its bounds can be tighter than the real part's. It is fit
   * for display and nothing else: never measure it, never derive a Z from it,
   * never present it as evidence of what will be cut. The core says so in
   * `Report.notes` as well, in words meant for the screen.
   */
  decimated: boolean;
  /** Bounds of the DELIVERED triangles, in mm (assumed — an STL declares none). */
  min_mm: [number, number, number];
  max_mm: [number, number, number];
  /**
   * The Z the section was taken at: the plane that produced the outline the
   * machine actually follows. It rides inside this object so a renderer can draw
   * the cut plane against the solid without asking something else where the
   * truth is.
   */
  section_z_mm: number;
  /**
   * `triangles * 9` little-endian f32 — three `[x, y, z]` corners per triangle,
   * in order — base64.
   *
   * Do not parse this by hand — call {@link decodeLoadedMesh}. Winding is not
   * normalised and the STL's own normals are discarded (they are wrong in a
   * great many files), so a renderer that needs normals computes them.
   */
  xyz_mm_b64: string;
}

/**
 * The loaded mesh with its vertices decoded, ready to become a `BufferGeometry`.
 *
 * `xyz_mm` is a flat `triangles * 9` array: vertex `v` of triangle `t` is at
 * `xyz_mm[t * 9 + v * 3 + {0,1,2}]`. It can go straight into a non-indexed
 * position attribute.
 */
export interface DecodedLoadedMesh {
  triangles: number;
  source_triangles: number;
  decimated: boolean;
  min_mm: [number, number, number];
  max_mm: [number, number, number];
  section_z_mm: number;
  xyz_mm: Float32Array;
}

/**
 * Decode a {@link LoadedMesh} into a `Float32Array` of vertex positions.
 *
 * 🔴 The length is checked against `triangles * 9` and a mismatch THROWS, for
 * the same reason {@link decodeStockSurface} does. A short vertex array does not
 * fail on its own: read three-at-a-time it produces a solid that is missing
 * facets from one end and looks entirely like a model, and a long one silently
 * drops the tail. Neither is something anyone catches by eye — and this object
 * is the one the user recognises, so a wrong version of it is believed.
 */
export function decodeLoadedMesh(m: LoadedMesh): DecodedLoadedMesh {
  const bin = atob(m.xyz_mm_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(
      `loaded mesh: ${bytes.byteLength} bytes is not a whole number of f32 — the payload is truncated`
    );
  }
  const xyz = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
  if (xyz.length !== m.triangles * 9) {
    throw new Error(
      `loaded mesh: ${xyz.length} floats for ${m.triangles} triangles (expected ${m.triangles * 9}) — ` +
        'drawing this would show a solid with facets missing, which still looks like a model'
    );
  }
  return {
    triangles: m.triangles,
    source_triangles: m.source_triangles,
    decimated: m.decimated,
    min_mm: m.min_mm,
    max_mm: m.max_mm,
    section_z_mm: m.section_z_mm,
    xyz_mm: xyz,
  };
}

export interface Report {
  job: string;
  ok: boolean;
  gcode: string;
  refusals: string[];
  notes: string[];
  fixture_findings: string[];
  warnings: string[];
  errors: string[];
  tools_used: string[];
  tool_changes: number;
  cutting_distance_mm: number;
  rapid_distance_mm: number;
  estimated_seconds: number;
  deepest_z_mm: number;
  tab_lifts: number;
  dogbones: number;
  sim: SimCounts;
  /**
   * The machined surface, **only if this call asked for it** — `null` otherwise,
   * which is the default. See {@link StockSurface} for what it is and, more
   * importantly, what it is not.
   */
  simulated_stock_surface: StockSurface | null;
  /**
   * The model as LOADED, **only if this call asked for it** — see
   * {@link planImportBytes}. The core always emits the key; it is optional here
   * only because a locally-constructed placeholder report may omit it, and
   * missing and `null` mean the identical thing: **nothing to draw**.
   *
   * 🔴 It is the INPUT and it is NOT what will be cut — the machine cuts the
   * flat section at `loaded_mesh.section_z_mm`. Read {@link LoadedMesh} before
   * rendering it.
   *
   * Absent means one of three things and never "a solid with no triangles": it
   * was not asked for; this was a DXF or SVG, which contains no 3D object at
   * all; or the file yielded no triangles, in which case `notes` says so. A
   * toggle should be DISABLED with which of those it is, not hidden — an absent
   * control looks like a feature nobody thought of.
   */
  loaded_mesh?: LoadedMesh | null;
  render: RenderMove[];
  /**
   * Every distinct CUTTING feed the emitted program commands, mm/min, in
   * first-appearance order. Computed in the core from the same bytes `gcode`
   * carries — `feeds::cutting_feeds_in_program`.
   *
   * ⚠ `?` because an older stored report has no such field. A host must render
   * its absence as "not commanded", never as zero.
   */
  cutting_feeds_mm_min?: number[];
  /**
   * The imported drawing, **as it was imported** — outer boundary and holes per
   * part, in mm, before any tool offset. See {@link DrawingPart}.
   *
   * 🔴 **Empty means "the core exported no contours for this report", never
   * "the drawing is empty".** It is empty for every reference fixture
   * ({@link plan}), which is built from code and has no drawing behind it, and
   * for an import that was refused before any part existed. An import that
   * produced nothing cuttable comes back `ok: false` with the reason in
   * `errors` — that is how you tell the two apart, and a viewport should say
   * which one it is rather than drawing nothing and looking broken.
   *
   * Optional on this interface only because a locally-constructed placeholder
   * report may omit it; the core always emits the key.
   */
  drawing?: DrawingPart[];
  /**
   * The machine's rapid rate in mm/min, or `null` when no job ran.
   *
   * 🔴 Needed because a `G0` **carries no `F` word**, so a rapid's duration
   * cannot be read off the move. This is the rate the core's own
   * `estimated_seconds` charges rapids at, so timed playback built on it agrees
   * with the number shown next to it instead of quietly disagreeing.
   *
   * ⚠ Commanded, not measured: no acceleration model, here or in the core's
   * estimate. Both run short on a program full of little moves.
   */
  rapid_mm_min?: number | null;
  /**
   * **Operator seconds charged for ONE tool change** — the rate the core's own
   * `estimated_seconds` actually used. `null`/absent when no job ran.
   *
   * 🔴 READ IT; NEVER RE-DERIVE IT. `App.tsx` carried
   * `const TOOL_CHANGE_SECONDS = 60` — a hand-copy of a core constant, so
   * labelled — while the core charged **120**, and the playback clock therefore
   * under-read by a minute per change against the estimate printed beside it
   * (item `#90`). The constant is deleted; this field is why it could be.
   *
   * 🔴 **ABSENT ⇒ `?? 0`, NEVER `?? 120`.** Absent means no job ran, or a core
   * older than this field — and a guessed rate is precisely the thing being
   * removed, so guessing a *newer* number would only move the defect. Zero must
   * not be silent: with tool changes present and no rate here, the panel says
   * the clock could not charge operator time, on the same footing as the
   * untimed-move counter beside it.
   */
  tool_change_seconds?: number | null;
  /**
   * 🔴 **THE FIELD THAT SAYS WHETHER {@link Report.tool_change_seconds} IS
   * SOMEBODY'S NUMBER.** `true` ⇒ the machine declared it. `false` ⇒ nobody
   * did, and the core fell back to its built-in default, which its own doc
   * records as the founder's estimate of his own shop and not a measurement.
   *
   * ⚠ Absent reads as `false` — undeclared — which is the weaker claim and
   * therefore the honest default, the same rule the core applies with
   * `#[serde(default)]`. A declared rate that happens to equal the default
   * still reports `true`: "somebody chose 120" and "nobody said, so we used
   * 120" are different facts and this is the only field that separates them.
   */
  tool_change_rate_declared?: boolean;
  stock: [number, number, number];
  /**
   * **The travel envelope** — `[x, y, z]` in mm, everywhere the cutter can
   * REACH, measured from the machine datum at `0,0`.
   *
   * 🔴 IT IS A LIMIT AND IT IS NOT A SURFACE. Nothing sits on it and nothing is
   * cut into it. This app drew these two numbers as a solid plane labelled
   * "table / bed" — the machine's *reach* rendered as the *object the work lies
   * on* — which is exactly the conflation {@link Report.spoilboard} exists to
   * end. Draw it as a boundary; draw the board as material.
   *
   * Optional here only for a locally-constructed placeholder report; the core
   * always emits the key.
   */
  travel?: [number, number, number];
  /**
   * The declared spoilboard, echoed back.
   *
   * 🔴 `null` (or absent) means **NOBODY DECLARED ONE**, and a host must render
   * that as UNCHECKED — **never as a board the size of {@link Report.travel}**,
   * which is the silent assumption this whole field exists to remove. An absent
   * spoilboard is not a spoilboard covering everything.
   */
  spoilboard?: SpoilboardCfg | null;
  /**
   * How much of the reachable area the declared board leaves BARE, as the four
   * edge strips in mm: `[X-, X+, Y-, Y+]`.
   *
   * 🔴 `null` when no board is declared — **a different fact from all four
   * being zero**, and only the second means the board covers everywhere the
   * cutter can go. Do not subtract two rectangles in the host; this is the
   * core's own arithmetic and the picture must come from it.
   */
  spoilboard_bare_reach?: [number, number, number, number] | null;
  clamps: ClampCfg[];
  /**
   * The transform that takes {@link Report.drawing} and {@link Report.loaded_mesh}
   * into the frame {@link Report.render} and {@link Report.gcode} are already in.
   *
   * 🔴 **THE TWO GEOMETRY FRAMES ON THIS REPORT ARE NOT THE SAME FRAME**, and
   * until 2026-08-09 nothing said so. `drawing` and `loaded_mesh` are the
   * imported geometry in DRAWING millimetres; `render` and `gcode` are MACHINE
   * coordinates with the sheet's datum, its rotation and the operator's drag
   * already applied. The viewport drew both raw, so the walls and the loaded
   * solid stood at the machine origin while the sheet was drawn at its datum —
   * any non-zero datum or rotation left the object beside the board. That is
   * what the founder was looking at.
   *
   * Apply it and they land on the toolpath:
   *
   * ```ts
   * const [x, y] = [cos * px + row_y[0] * py + dx_mm, sin * px + row_y[1] * py + dy_mm];
   * ```
   *
   * or, for a three.js group holding drawing-frame geometry:
   * `g.rotation.z = Math.atan2(sin, cos); g.position.set(dx_mm, dy_mm, 0)`.
   *
   * ⚠ Do NOT rebuild it from `stock`. It is measured out of the core's own
   * `Job::place`, and the last time this app wrote a placement rule a second
   * time in TypeScript the copy was orientation-blind and refused a sheet that
   * fits turned.
   *
   * Optional here only because a locally-constructed placeholder report may omit
   * it; the core always emits the key. Absent means **the identity**, never a
   * zero matrix — a zero matrix collapses every point onto the machine origin,
   * which does not read as missing data, it draws a part that is not there.
   */
  drawing_placement?: Placement2D;
}

/**
 * A rigid transform, as the core measured it out of the one function that
 * applies it. See {@link Report.drawing_placement}.
 */
export interface Placement2D {
  /** x-basis: what the transform does to (1,0), less the translation. */
  cos: number;
  sin: number;
  /** y-basis, same reading, from (0,1). */
  row_y: [number, number];
  dx_mm: number;
  dy_mm: number;
  /**
   * The drawing offset this transform CARRIES — what was APPLIED, not what was
   * typed. They differ under `--plant drawing-offset-ignored`, which is the
   * whole point of reporting it: a panel echoing the typed value back is green
   * about a setting that reached no coordinate.
   */
  drawing_offset_mm: [number, number];
}

/** The identity — what an absent {@link Report.drawing_placement} means. */
export const NO_PLACEMENT: Placement2D = {
  cos: 1,
  sin: 0,
  row_y: [0, 1],
  dx_mm: 0,
  dy_mm: 0,
  drawing_offset_mm: [0, 0],
};

export interface ToolRow {
  id: string;
  /** 'fitted' | 'needs-collet' | 'none' | 'undeclared' — decided in the core. */
  fit?: string;
  fit_why?: string;
  selectable?: boolean;
  category: string;
  diameter_mm: number;
  flutes: number;
  /**
   * Which way the flutes spiral: `'straight' | 'up-cut' | 'down-cut' |
   * 'compression'`, decided in the core from `Tool::flute_type`.
   *
   * It decides **which face tears out** on a sheet good — an up-cut lifts the
   * chip and splinters the top face, a down-cut presses down and splinters the
   * bottom, and a compression cutter exists to keep both clean. Optional here
   * because an older core does not emit it; absent means *not stated*, which
   * anything drawing a cutter must render as unstated rather than as straight.
   */
  flute_type?: string;
  shank_mm: number;
  cutting_length_mm: number;
  chipload_mm: number;
  chipload_min_mm: number;
  chipload_max_mm: number;
  rpm_min: number;
  rpm_max: number;
  included_angle_deg: number | null;
  point_angle_deg: number | null;
  can_profile: boolean;
  can_pocket: boolean;
  can_drill: boolean;
  is_angular: boolean;
  valid: boolean;
}

export interface MaterialRow {
  name: string;
  chipload_factor: number;
  max_doc_ratio: number;
  max_rpm: number;
}

export interface ToolLibrary {
  categories: string[];
  materials: MaterialRow[];
  tools: ToolRow[];
}

export interface JobConfig {
  machine?: Record<string, unknown>;
  stock?: Record<string, unknown>;
  clamps?: ClampCfg[];
  confirmed_clear?: boolean;
  /**
   * 🔴 THE ONE TOOL DOOR THIS APP USES, AT ANY COUNT INCLUDING ONE.
   *
   * `tool_ids` goes through `assign_tools_from_set` → `recommend()` per feature,
   * and the rejections become `Job::tool_set_refusals`, which is what makes them
   * reach the planner. See the long note at the send site in `App.tsx`: the
   * singular `tool_id` below skips that entirely, and at one tool it was emitting
   * programs the recommender refuses — measured, 962 lines with 6mm of material
   * left standing and no refusal.
   */
  tool_ids?: string[];
  /**
   * ⚠ STILL IN THE CORE AND IN THE CLI, AND NO LONGER SENT BY THIS APP. Left
   * declared rather than deleted because the core still accepts it and a reader
   * comparing a CLI config against this type needs to find it — but nothing here
   * writes it any more, and `App.tsx` says why at the line that stopped.
   */
  tool_id?: string;
  material?: string;
  op?: Record<string, unknown>;
  probe_after_toolchange?: boolean;
  /**
   * Where the operator has dragged the geometry ON THE SHEET, `[x, y]` in sheet
   * millimetres.
   *
   * 🔴 NOT `stock.origin_*`. That moves the SHEET on the bed and changes the
   * work's relationship to the clamps and to the touch plate hooked over its
   * corner; this moves the part on the board and leaves the board alone. Both
   * reach the emitted coordinates, and only one of them moves the datum.
   */
  drawing_offset?: [number, number];
  /**
   * Clear material required BETWEEN two parts on the sheet, on top of the
   * cutter's own diameter, in millimetres.
   *
   * 🔴 Absent means NOT DECLARED, which is a different fact from a declared
   * zero. The core still runs the check — at the cutter diameter alone, the bare
   * geometric minimum — and says on every report that no margin was declared.
   * Do not default it here: a gap computed from a number nobody chose is trusted
   * exactly as if somebody had.
   */
  part_gap_margin_mm?: number;
}

/**
 * One drawing on the sheet, with where the operator put it.
 *
 * 🔴 `offset_mm` is a DELTA from where the drawing was DRAWN, in sheet
 * millimetres — the per-drawing generalisation of {@link JobConfig.drawing_offset},
 * in the same frame and with the same meaning. Zero means AS DRAWN. It is NOT
 * {@link PlacedDrawingIn}'s `x_mm`/`y_mm`, which the layout CHECK takes and which
 * are the absolute position of a corner; zero there means the sheet corner. Two
 * fields, two questions, deliberately not spelled the same.
 */
export interface ImportDrawing {
  /** Names this drawing's parts and its operations — `id/part`. Must be unique. */
  id: string;
  format: 'dxf' | 'svg' | 'stl' | 'auto';
  bytes: Uint8Array;
  /** The section Z for a mesh. Omitted = nobody chose one; the core sections at
   *  mid-height and SAYS SO. Never send 0 to mean "unset". */
  z_section_mm?: number;
  offset_mm: [number, number];
  /** Degrees anticlockwise about this drawing's own lower-left corner. */
  rotation_deg: number;
}

export async function version(): Promise<{ core: string; gcode_contract: string }> {
  return callJson('version', []);
}

export async function listJobs(): Promise<{ name: string; detail: string }[]> {
  return callJson('jobs', []);
}

export async function listPlants(): Promise<{ name: string; detail: string }[]> {
  return callJson('plants', []);
}

export async function toolLibrary(): Promise<ToolLibrary> {
  return callJson('tools', []);
}

/**
 * The sourced spoilboard catalogue — **the core's list, not a copy of it**.
 *
 * 🔴 There is no TypeScript array of boards anywhere in this app and there must
 * never be one. The core's own file says why: a catalogue re-typed here is a
 * second list that can drift, and the drift would be invisible — both sides
 * render confidently and only the machine disagrees.
 *
 * ⚠ `default_id` is `null`. Do not preselect a row from this payload, do not
 * take `spoilboards[0]`, and do not pre-fill a position: an over-declared board
 * says "there is sacrificial material here" about bare frame.
 */
export async function spoilboardCatalogue(): Promise<SpoilboardCatalogue> {
  return callJson('spoilboards', []);
}

/**
 * The tool library with a per-tool fit verdict for this machine's collets.
 *
 * 🔴 The verdict is the CORE's, not this file's. A UI that decides for itself
 * whether a shank fits is a second copy of a machining rule, in the one place
 * no gate can see it. That is exactly how the sheet-fit rule ended up
 * orientation-blind and refusing a sheet that fits turned.
 */
export async function toolLibraryFor(
  colletMm: number,
  sparesMm: number[]
): Promise<ToolLibrary> {
  return callJson('tools_for_machine', [colletMm, JSON.stringify(sparesMm)]);
}

// ---------------------------------------------------------------------------
//  Tool verdicts — `core/src/recommend.rs`, reachable from the browser
// ---------------------------------------------------------------------------

/**
 * Whether a tool can be used at all in the current setup.
 *
 * 🔴 `'invalidates'` is the **red** one: the job cannot be cut with this tool.
 * `'unknown'` is **not** usable — a rule could not run, so nothing has vouched
 * for the tool. Never fall back to `'usable'` for it and never render it as
 * cleared.
 */
export type Usability = 'usable' | 'invalidates' | 'unknown';

/**
 * Whether this drawing wants the tool. A **different question** from
 * {@link Usability} — a tool can be perfectly usable and simply not the best
 * choice. `'unknown'` means nothing was asked (no drawing, or a setup too
 * incomplete to run the recommender); it is not "not recommended".
 */
export type Advice = 'recommended' | 'usable' | 'not-for-this-job' | 'unknown';

/**
 * One blocking rule's answer.
 *
 * `rule` is which of the four conditions this is — **"invalidates the job" is
 * not one condition**, and a red row that will not say which one it is cannot
 * be acted on:
 *
 * - `'tool-definition'` — the tool itself is nonsense (inverted chipload window,
 *   zero flutes, non-positive diameter).
 * - `'collet'` — no collet the shop owns holds this shank.
 * - `'reach'` — the flute is shorter than the sheet, so the shank would run in
 *   the cut. **This is the predicate the planner refuses the whole job on.**
 * - `'spindle-rpm'` — the material caps the spindle below the slowest speed this
 *   tool and this machine can turn at.
 *
 * `why` is the core's sentence and is **empty for `'passed'`** — the same
 * convention as {@link ToolRow.fit_why}, so `why || 'fine'` cannot make an
 * unanswered rule read as an answered one.
 */
export interface ToolRuleVerdict {
  rule: 'tool-definition' | 'collet' | 'reach' | 'spindle-rpm';
  outcome: 'passed' | 'refused' | 'unchecked';
  why: string;
}

/** Why a tool was refused for one feature of the drawing. */
export interface FeatureRefusal {
  feature_id: string;
  why: string;
}

/**
 * One row of the tool list, as the CORE judges it.
 *
 * 🔴 Every field here is the core's answer. Nothing in this app may re-derive
 * whether a tool suits a setup: that judgement is `core/src/recommend.rs`, where
 * a gate can see it and where the planner reads the identical predicates. The
 * tool row's material-blind feed, the `uncut <= 20` threshold and the travel-fit
 * rule were each a machining rule written a second time in TypeScript, and each
 * was wrong in a way nothing could catch.
 *
 * 🔴 And the two verdicts are **not** one boolean. `usability` is the red mark;
 * `advice` is the filter. See {@link Usability} and {@link Advice}.
 */
export interface ToolVerdict {
  id: string;
  usability: Usability;
  /**
   * The core's sentence for `usability` — the refusals joined for
   * `'invalidates'`, the unchecked reasons for `'unknown'`, **empty** for
   * `'usable'`. Render it verbatim; a paraphrase of a safety message is a second
   * copy that drifts.
   */
  why: string;
  /** Every blocking rule, whether it passed, refused or could not run. */
  rules: ToolRuleVerdict[];
  advice: Advice;
  /**
   * The core's sentence for `advice`. For `'recommended'` this is the
   * recommender's own REASON line — the same text `2bee-slice recommend` prints.
   */
  why_advice: string;
  /** Feature ids the recommender chose this tool for. */
  recommended_for: string[];
  /** Feature ids where it broke no rule and lost on preference. */
  usable_for: string[];
  refused_for: FeatureRefusal[];
}

/**
 * What the verdicts were judged against, echoed back.
 *
 * A verdict quoted without its setup is a verdict about a machine the reader has
 * to guess at. `null` on any field means **not declared**, which is why the
 * matching rule came back `'unchecked'`.
 */
export interface VerdictSetup {
  machine_declared: boolean;
  collet_mm: number | null;
  spare_collets_mm: number[] | null;
  stock_thickness_mm: number | null;
  material: string | null;
  /** `0` = no drawing was sent, so every `advice` is `'unknown'`. */
  parts: number;
}

export type ToolVerdictsResult =
  | {
      ok: true;
      setup: VerdictSetup;
      verdicts: ToolVerdict[];
      /** Setup facts the caller should see — an unrecognised material, a rejected extra tool. */
      notes: string[];
      /**
       * The core's own wording for the two mistakes a list is most likely to
       * make: merging the two verdicts, and rendering `'unknown'` as usable.
       * Show them; do not rewrite them.
       */
      caveats: string[];
    }
  | { ok: false; why: string };

/**
 * 🔴 **Ask the core which tools work for this setup, and which one it would
 * choose.** TODO #66.
 *
 * `config` is **the same {@link JobConfig} you are about to plan with** — pass
 * the object itself, not a summary of it. That is the whole guarantee: a row
 * saying a cutter is usable and a planner refusing that cutter cannot be
 * describing two different machines, because they are handed one description.
 *
 * `parts` is `report.drawing` returned as it was received. Omit it (or pass
 * `[]`) before a drawing is loaded — every `advice` then comes back
 * `'unknown'`, which is a different fact from "no tool is recommended".
 *
 * ```ts
 * const v = await toolVerdicts(config, report.drawing ?? []);
 * if (!v.ok) return showRefusal(v.why);
 * const byId = new Map(v.verdicts.map((t) => [t.id, t]));
 * // red background + the core's reason, never a sentence written here
 * row.classList.toggle('bad', byId.get(t.id)?.usability === 'invalidates');
 * row.title = byId.get(t.id)?.why ?? '';
 * ```
 *
 * ⚠ **A filter that hides rows must say how many it hid, and why.** On screen a
 * hidden item and a non-existent item are identical — the defect the tool
 * picker's own header names, and the one the browser suite has a test title for.
 * Filtering by `advice` is opt-in; filtering by `usability` would hide exactly
 * the rows the operator most needs to see.
 */
export async function toolVerdicts(
  config: JobConfig,
  parts: DrawingPart[] = []
): Promise<ToolVerdictsResult> {
  return callJson('tool_verdicts', [JSON.stringify(config), JSON.stringify(parts)]);
}

// ---------------------------------------------------------------------------
//  Drawing verdicts — the same module, the other list
// ---------------------------------------------------------------------------

/**
 * Which blocking rule spoke about a drawing.
 *
 * - `'identity'` — the drawing's NAME: empty, or shared with another drawing on
 *   the workpiece. The planner refuses a duplicate id rather than renaming it.
 * - `'geometry'` — nothing measurable came out of the import for this drawing.
 * - `'placement'` — the offset or the turn is not a finite number, so where it
 *   sits is unknown and nothing about it could be measured.
 * - `'pair-clearance'` — this drawing shares material with, or is too close to,
 *   another part on the same workpiece. **This is the predicate that refuses the
 *   whole workpiece and emits zero bytes of G-code.**
 *
 * `why` is the core's sentence and is **empty for `'passed'`** — the same
 * convention as {@link ToolRuleVerdict.why}, so `why || 'fine'` cannot make an
 * unanswered rule read as an answered one.
 */
export interface DrawingRuleVerdict {
  rule: 'identity' | 'geometry' | 'placement' | 'pair-clearance';
  outcome: 'passed' | 'refused' | 'unchecked';
  why: string;
}

/**
 * Does this drawing belong on the workpiece that is declared?
 *
 * 🔴 **A SEPARATE AXIS FROM {@link Usability}, AND IT MUST STAY SEPARATE.** The
 * planner does **not** refuse an off-workpiece drawing today: it posts, and the
 * cutter goes where the material is not. Rendering `'off-workpiece'` as an
 * invalidation would claim the planner refuses something it does not — a red
 * that overstates is as expensive as a green that understates, and it sends an
 * operator to fix a refusal that never happened.
 *
 * `'unknown'` means nothing was asked — no workpiece size declared, or no
 * measurable geometry. It is **not** `'on-workpiece'`.
 */
export type DrawingFit = 'on-workpiece' | 'off-workpiece' | 'unknown';

/**
 * What this drawing would cost to cut, **counted rather than estimated**.
 *
 * 🔴 These are counts of GEOMETRY, not a time and not a price. Nothing here has
 * seen a cutter, a feed or a depth — {@link Report.estimated_seconds} is the
 * job's own answer and it is measured on the emitted program.
 */
export interface DrawingCost {
  parts: number;
  closed_contours: number;
  /** 🔴 Non-zero means a host built the parts itself: `to_parts` drops open
   *  boundaries, and an open boundary reaches the pair check as NOT CHECKED. */
  open_contours: number;
  interior_features: number;
}

/**
 * One row of the drawing list, as the CORE judges it.
 *
 * 🔴 Every sentence here is composed in the core — in `recommend.rs`, in
 * `layout.rs` or in `placement.rs` — and a host renders it **verbatim**. For
 * `'invalidates'` it is the sentence the PLANNER refuses the whole workpiece
 * with, from the same run of the same predicate, so a paraphrase is a second
 * copy of a safety message that drifts from the thing doing the refusing.
 */
export interface DrawingVerdict {
  id: string;
  usability: Usability;
  /** The core's sentence for `usability` — refusals joined for `'invalidates'`,
   *  unchecked reasons for `'unknown'`, **empty** for `'usable'`. */
  why: string;
  rules: DrawingRuleVerdict[];
  fit: DrawingFit;
  /** The core's sentence for `fit`, on **every** value including
   *  `'on-workpiece'` — a blank beside a verdict reads as a verdict nobody
   *  stood behind. */
  why_fit: string;
  /**
   * A quarter turn that would make it fit the workpiece **BY SIZE**. `null` for
   * BOTH "it already fits" and "no turn helps", which is why {@link fit} is the
   * real answer and this is only the detail behind it.
   */
  turn_that_fits_deg: number | null;
  cost: DrawingCost;
  /** `[min_x, min_y, max_x, max_y]` in WORKPIECE-LOCAL mm. `null` when there is
   *  no measurable geometry. */
  placed_extent_mm: [number, number, number, number] | null;
}

/** What the drawing verdicts were judged against, echoed back. `null` on a field
 *  means **not declared**, which is why the matching rule came back unchecked. */
export interface DrawingVerdictSetup {
  workpiece_size_mm: [number, number] | null;
  cutter_id: string | null;
  cutter_diameter_mm: number | null;
  part_gap_margin_mm: number | null;
  part_gap_margin_declared: boolean;
  drawings: number;
}

export type DrawingVerdictsResult =
  | {
      ok: true;
      setup: DrawingVerdictSetup;
      verdicts: DrawingVerdict[];
      notes: string[];
      /**
       * The core's own wording for the three mistakes a drawing list is most
       * likely to make: merging `usability` with `fit`, rendering `'unknown'` as
       * usable, and expecting `selected` in the payload. Show them; do not
       * rewrite them.
       */
      caveats: string[];
    }
  | { ok: false; why: string };

/**
 * One drawing on the workpiece, as this app hands it back for judging.
 *
 * 🔴 `offset_mm` and `rotation_deg` are a **DELTA from where the drawing was
 * drawn** — {@link ImportDrawing}'s meaning, not {@link PlacedDrawingInput}'s
 * absolute corner. Zero means AS DRAWN.
 */
export interface VerdictDrawing {
  id: string;
  parts: DrawingPart[];
  offset_mm?: [number, number];
  rotation_deg?: number;
}

/**
 * Split {@link Report.drawing} back into one parts list per drawing.
 *
 * 🔴 **WHY THIS EXISTS AT ALL, AND WHY IT REFUSES INSTEAD OF COPING.**
 * `Report.drawing` is the whole workpiece's geometry, PLACED, with every part
 * renamed `drawing/part` by `layout::PlacedDrawing::placed_parts`. It is the
 * exact geometry `check_interference` was run on. To ask the core about it
 * per-drawing, that qualification has to be inverted — and inverting it is the
 * one place a host can silently produce a verdict about a DIFFERENT workpiece
 * than the planner judged.
 *
 * So it fails closed, in both directions:
 *
 * * a part whose name matches **no** id on the list ⇒ refused. The list would be
 *   short a part, and the pair check would then be run over a workpiece missing
 *   geometry that is really there — a clear result computed from the parts that
 *   happened to attribute. The core says it in its own words: *"a workpiece
 *   checked without one of its drawings is not this workpiece"*.
 * * an id with **no** parts ⇒ refused, **not** reported as an empty drawing. An
 *   empty list is a real answer the core refuses by name (`NoGeometry`), and
 *   manufacturing it here from a report that simply has not caught up with the
 *   list yet would be a confident red about a drawing that is fine.
 *
 * ⚠ **The refusal is the useful state, not an error path.** It is exactly what
 * a report that is one plan behind the drawing list looks like, and the honest
 * rendering of it is *"not asked"* — never *"usable"*, never *"invalidates"*.
 *
 * ⚠ It matches on the `id/` PREFIX rather than splitting at the first `/`,
 * because a part name may contain a slash and an id may not be assumed free of
 * one either; the prefix test is the exact inverse of the `format!("{}/{}")`
 * the core wrote.
 */
export function splitDrawingParts(
  reportDrawing: readonly DrawingPart[] | undefined,
  ids: readonly string[]
): { ok: true; byId: Map<string, DrawingPart[]> } | { ok: false; why: string } {
  const parts = reportDrawing ?? [];
  if (ids.length === 0) return { ok: true, byId: new Map() };
  if (parts.length === 0)
    return {
      ok: false,
      why:
        `${ids.length} drawing(s) are in the job and the report carries no imported geometry ` +
        `at all, so nothing was judged. That is NOT "they are fine": the report is either ` +
        `older than this list or was refused before parts existed, and its own errors say which.`,
    };

  const byId = new Map<string, DrawingPart[]>();
  for (const id of ids) byId.set(id, []);
  const orphans: string[] = [];
  for (const p of parts) {
    // Longest id first, so `Hive super end` cannot claim a part belonging to
    // `Hive super end #2`. Ids are minted unique but they are not prefix-free.
    const owner = [...ids]
      .sort((a, b) => b.length - a.length)
      .find((id) => p.name.startsWith(`${id}/`));
    if (owner === undefined) orphans.push(p.name);
    else byId.get(owner)!.push({ ...p, name: p.name.slice(owner.length + 1) });
  }
  if (orphans.length)
    return {
      ok: false,
      why:
        `the report names ${orphans.length} part(s) that belong to no drawing on this list ` +
        `(${orphans.slice(0, 3).join(', ')}${orphans.length > 3 ? ', …' : ''}), so the list and ` +
        `the report describe different workpieces and nothing was judged.`,
    };
  const empty = ids.filter((id) => byId.get(id)!.length === 0);
  if (empty.length)
    return {
      ok: false,
      why:
        `${empty.length} drawing(s) in the job (${empty.join(', ')}) appear nowhere in the ` +
        `report's geometry, so the list and the report describe different workpieces and ` +
        `nothing was judged. It is NOT "they carry no geometry" — that is a verdict the core ` +
        `gives, and it cannot be given from a report that never saw them.`,
    };
  return { ok: true, byId };
}

/**
 * 🔴 **Ask the core which drawings this workpiece can be cut with, and which of
 * them belong on the material.**
 *
 * `config` is **the same {@link JobConfig} you are about to plan with** — the
 * object itself, not a summary. That is the whole guarantee: a row saying a
 * drawing belongs here and a planner refusing that drawing cannot be describing
 * two different workpieces.
 *
 * `drawings` is `Report.drawing` handed back, split by {@link splitDrawingParts}
 * — which means it is **already placed**, so `offset_mm` and `rotation_deg` are
 * left at zero. 🔴 Passing the operator's Part X/Y here as well would apply the
 * placement a second time and judge a drawing that is nowhere on the machine.
 *
 * ⚠ The cost of that choice, stated rather than left to be discovered: the
 * `'placement'` rule is asked about the delta THIS caller sends, which is zero
 * by construction, so it can only ever report `'passed'` here. A placement too
 * broken to plan is refused by the PLANNER, upstream, and lands in the report's
 * own errors.
 *
 * ⚠ **A filter that hides rows must say how many it hid, and why.** Filtering by
 * `fit` is opt-in; filtering by `usability` would hide exactly the rows the
 * operator most needs to see — the ones that are why the job will be refused.
 */
export async function drawingVerdicts(
  config: JobConfig,
  drawings: VerdictDrawing[] = []
): Promise<DrawingVerdictsResult> {
  return callJson('drawing_verdicts', [JSON.stringify(config), JSON.stringify(drawings)]);
}

export interface StockFit {
  fits: boolean;
  footprint: [number, number];
  /** Degrees that would make it fit, or null if no quarter turn helps. */
  quarter_turn: number | null;
}

export async function stockFit(
  sizeX: number,
  sizeY: number,
  rotationDeg: number,
  travelX: number,
  travelY: number
): Promise<StockFit> {
  return callJson('stock_fit', [sizeX, sizeY, rotationDeg, travelX, travelY]);
}

/**
 * Plan a reference job.
 *
 * `surfaceCellMm` asks for the **simulated stock surface** — the machined
 * height map — at about that display cell size. Leave it out and the report
 * comes back with `simulated_stock_surface: null`, which is what every caller
 * that only reads the counts should do.
 *
 * 🔴 Asking is expensive and the default declines for that reason. A 600x900
 * sheet at the 0.6mm simulation cell is 1,001 x 1,501 samples = **8.0MB of
 * base64 per call**. Re-planning on every slider drag at that size would make
 * the app crawl. Pick a display cell the viewport actually needs — 3mm on that
 * sheet is 201 x 301 = 322KB — and re-ask at a finer cell only when the user
 * stops moving and wants to look closely.
 *
 * A request finer than `simCell` cannot invent detail: the core returns the
 * simulation's own resolution and says so in the returned `cell_mm`.
 */
export async function plan(
  job: string,
  plant: string,
  config: JobConfig,
  simCell = 0.6,
  surfaceCellMm?: number
): Promise<Report> {
  // The config is stringified whole. Sending a partial object and merging in JS
  // would put a second copy of the defaults here, and "absent means leave it
  // alone" would stop being true the first time the two copies disagreed.
  return callJson('plan', [job, plant, JSON.stringify(config), simCell, surfaceCellMm]);
}

/**
 * Plan a job from a drawing the user dropped in.
 *
 * Everything the importer could not read comes back in `notes`; a drawing that
 * yields nothing cuttable comes back `ok: false` with a reason. It never comes
 * back as an empty program that looks finished.
 */
export async function planImport(
  text: string,
  format: 'dxf' | 'svg',
  config: JobConfig,
  simCell = 0.6,
  surfaceCellMm?: number
): Promise<Report> {
  return callJson('plan_import', [text, format, JSON.stringify(config), simCell, surfaceCellMm]);
}

/**
 * Plan from a drawing's own BYTES. The only correct path for a mesh, and the
 * safer one for everything else.
 *
 * 🔴 Why bytes and not a string. `FileReader.readAsText` and `Response.text()`
 * decode as UTF-8 and replace anything undecodable with U+FFFD **silently**. A
 * binary STL put through that loses facets without an error, and a mesh missing
 * facets sections into an outline with a side missing — which still looks like a
 * part. The failure is invisible at every step until the cutter runs out of
 * material that should have been there.
 *
 * 🔴 Why `format: 'auto'` is the right default. A binary STL whose 80-byte
 * header happens to start with "solid" is a real and common export; so is one
 * named `part.dxf`. The core decides by CONTENT — file length against
 * `84 + 50 * triangle_count` — and an extension sniff in this file would be a
 * second, worse copy of that decision.
 *
 * `zSectionMm` applies to meshes only: it is the height the solid is sliced at.
 * Leave it undefined and the core sections at MID-HEIGHT and says so in the
 * notes, in the words "CHOSEN FOR YOU". Do not pass 0 as a stand-in for "no
 * choice" — a model exported sitting on its build plate has its bottom face
 * exactly at z=0, so it sections to nothing.
 *
 * `meshBudgetTris` asks for the **loaded model itself** — its triangles, for
 * drawing — capped at that many. Leave it out and `loaded_mesh` comes back
 * `null`, which is what every caller that is not about to draw a solid should
 * do.
 *
 * 🔴 Asking is expensive and the default declines for that reason. An STL of a
 * real part is routinely 100k+ triangles, and nothing is indexed or shared
 * because an STL has no topology — so that is **4.8MB of base64 per call**.
 * Re-planning at that size while a slider moves would make the app crawl. Ask
 * once, when something is going to draw it, at a budget the viewport can afford,
 * and read the count off `loaded_mesh.triangles`: it is what was DELIVERED, not
 * what you asked for.
 *
 * 🔴 What comes back is the model AS LOADED. It is not the part and not a
 * preview of the cut — the machine follows the flat section at
 * `loaded_mesh.section_z_mm`, one outline through that solid. Draw the section
 * with it, and label the two apart.
 */
export async function planImportBytes(
  data: Uint8Array,
  format: 'dxf' | 'svg' | 'stl' | 'auto',
  config: JobConfig,
  zSectionMm?: number,
  simCell = 0.6,
  surfaceCellMm?: number,
  meshBudgetTris?: number
): Promise<Report> {
  return callJson('plan_import_bytes', [
      data,
      format,
      // `undefined` reaches Rust as `None`. A NaN would section nothing and then
      // blame the model, so a non-finite value is treated as no choice at all.
      zSectionMm !== undefined && Number.isFinite(zSectionMm) ? zSectionMm : undefined,
      JSON.stringify(config),
      simCell,
      // Same rule, same reason: a non-finite cell is no request, not a default.
      // See `plan` for why the surface is opt-in and what it costs.
      surfaceCellMm !== undefined && Number.isFinite(surfaceCellMm) ? surfaceCellMm : undefined,
      // A budget is a positive whole number of triangles. A 0 — which is what a
      // viewport-derived budget computes to before layout has run — is NO
      // REQUEST, never "no limit"; the core reads it the same way. A zero taken
      // as unlimited would hand the page a 100k-triangle model at exactly the
      // moment it is least able to draw one.
      meshBudgetTris !== undefined && Number.isFinite(meshBudgetTris) && meshBudgetTris > 0
        ? Math.floor(meshBudgetTris)
        : undefined
  ]);
}

/**
 * 🔴 **N drawings, placed, checked against each other, and posted — or refused.**
 *
 * This is the path the app plans EVERY import through, including a single
 * drawing: one code path means the picture and the program cannot start
 * disagreeing because one of them got a fix and the other did not.
 *
 * 🔴 **`ok: false` means there is no program**, and `gcode` is empty on every
 * such path — including the overlap refusal, which is the one this exists for.
 * Two parts cut from the same material is one program destroying its own second
 * part, and `refusals` then holds one sentence per condemned pair naming both.
 *
 * ⚠ The bytes are CONCATENATED and each drawing carries its own length, because
 * the wasm boundary takes one `&[u8]`. The core refuses a length that does not
 * add up rather than slicing on — a wrong length does not produce a parse error,
 * it produces a DIFFERENT drawing made of one file's tail and the next one's
 * head, and that composite still posts and cuts.
 */
export async function planImportMany(
  drawings: ImportDrawing[],
  config: JobConfig,
  simCell = 0.6,
  surfaceCellMm?: number,
  meshBudgetTris?: number
): Promise<Report> {
  const total = drawings.reduce((n, d) => n + d.bytes.length, 0);
  const blob = new Uint8Array(total);
  let at = 0;
  for (const d of drawings) {
    blob.set(d.bytes, at);
    at += d.bytes.length;
  }
  const described = drawings.map((d) => ({
    id: d.id,
    format: d.format,
    byte_len: d.bytes.length,
    // `undefined` reaches Rust as `None`. A NaN would section nothing and then
    // blame the model, so a non-finite value is treated as no choice at all.
    z_section_mm:
      d.z_section_mm !== undefined && Number.isFinite(d.z_section_mm) ? d.z_section_mm : undefined,
    offset_mm: d.offset_mm,
    rotation_deg: d.rotation_deg,
  }));
  return callJson('plan_import_many', [
    JSON.stringify(described),
    blob,
    JSON.stringify(config),
    simCell,
    surfaceCellMm !== undefined && Number.isFinite(surfaceCellMm) ? surfaceCellMm : undefined,
    meshBudgetTris !== undefined && Number.isFinite(meshBudgetTris) && meshBudgetTris > 0
      ? Math.floor(meshBudgetTris)
      : undefined,
  ]);
}

// ---------------------------------------------------------------------------
// Multi-part placement — the layout check
// ---------------------------------------------------------------------------

/**
 * How much clear material two parts must have between them, for one cutter.
 *
 * 🔴 `required_mm` is the CORE's number. Do not compute it. `cutter_diameter_mm
 * + margin_mm` written anywhere in TypeScript is a machining rule in the one
 * place no gate can see it, and it is the reason this binding exists: a viewport
 * that needed the gap could not get it, and correctly refused to add the two
 * numbers itself rather than invent the rule a fourth time.
 */
export interface Clearance {
  cutter_diameter_mm: number;
  margin_mm: number;
  /** Minimum clear material between two parts, in mm. */
  required_mm: number;
}

/**
 * A clearance, **or an explicit refusal**.
 *
 * 🔴 There is no fallback number in the failure case, deliberately: the failure
 * shape has no `clearance` key at all, so there is nothing to read past the
 * refusal. A gap derived from a cutter nobody declared would be trusted exactly
 * as if someone had declared it.
 */
export type ClearanceResult =
  | { ok: true; clearance: Clearance }
  | { ok: false; why: string };

/** Which part, of which drawing. Both halves, always. */
export interface PartRef {
  /** The drawing's id, as the caller added it. */
  drawing: string;
  /** The part's name inside that drawing, as imported. */
  part: string;
}

/**
 * `drawing/part` — the qualified name, and **the prefix of exactly the
 * operations this refusal condemns**. A UI can strike the right rows in a
 * program listing with it and match nothing looser.
 */
export function qualifiedPart(p: PartRef): string {
  return `${p.drawing}/${p.part}`;
}

/** An axis-aligned window in sheet millimetres. */
export interface LayoutExtent {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

/**
 * The parts share material. **Fix: re-nest — one of them has to come off this
 * material.**
 *
 * 🔴 This is NOT the same finding as {@link TooCloseFinding} and the two must
 * never be flattened into one "collision" flag. They have different fixes, and
 * a UI that blurs them sends a person to the wrong one.
 *
 * ⚠ **The physical consequence is deliberately NOT written out here.** It used
 * to be — a verbatim run of the core's own refusal sentence, in a doc comment,
 * found 2026-08-11 by the paraphrase guard in `drawing-verdicts.test.ts`. It was
 * never rendered, so it was never a live defect; it was the SEED of one. A
 * safety sentence sitting in TypeScript is what the next person copies when they
 * need a string, and the copy then drifts from the predicate that does the
 * refusing while rendering identically. The sentence lives in
 * `core/src/layout.rs::Interference::describe` and arrives at runtime in `why`.
 */
export interface OverlapFinding {
  finding: 'overlap';
  a: PartRef;
  b: PartRef;
  /** The shared region, measured on the real boundaries — arcs included. */
  region: LayoutExtent;
  /** How far they interpenetrate on each axis. This is the number to move by. */
  over_x_mm: number;
  over_y_mm: number;
  /** Shared material. Separates "stacked" from "touching at a corner". */
  area_mm2: number;
  /** The core's own sentence. Contains the word OVERLAP and never TOO CLOSE. */
  describe: string;
  /**
   * 🔴 **The named false RED — render it, do not file it as a bug.**
   *
   * The check compares outer boundary to outer boundary, so a part deliberately
   * nested inside another part's HOLE is refused here even though that material
   * is a drop-out and genuinely available. That is documented behaviour, not a
   * defect: refusing a legal nest costs a re-draw, permitting an illegal one
   * costs a cutter. The workaround is to draw the nested part as part of the
   * same drawing — **never to relax the check.**
   */
  false_red_note: string;
}

/**
 * The parts do not share material, but the channel between them is narrower
 * than the tool that has to travel down it. **Fix: move them apart.** Nothing
 * is wrong with the nest except the spacing.
 *
 * ⚠ This is the dangerous one, because snapping two parts flush is the most
 * natural gesture a person will make — and a check that only looked for overlap
 * would call it clean.
 */
export interface TooCloseFinding {
  finding: 'too_close';
  a: PartRef;
  b: PartRef;
  /** Clear material between them, measured by the offset that refused them. */
  gap_mm: number;
  required_mm: number;
  cutter_diameter_mm: number;
  margin_mm: number;
  /** The core's own sentence. Contains TOO CLOSE and never OVERLAP. */
  describe: string;
}

/**
 * The check could not be run on this pair.
 *
 * 🔴 **This is a REFUSAL, not a warning.** A pair whose check could not run is
 * not a pair that passed, and a green that means "unchecked" is worse than a
 * red. Do not render it as an advisory, do not let a job post over it, and do
 * not count `findings.filter(f => f.finding !== 'not_checked').length === 0` as
 * clear — an empty findings list is the only clear result.
 */
export interface NotCheckedFinding {
  finding: 'not_checked';
  a: PartRef;
  b: PartRef;
  /** Why it could not be asked — an open boundary, a rejected boolean. */
  why: string;
  describe: string;
}

/** Something about a PAIR of parts that stops this job being cut. */
export type Interference = OverlapFinding | TooCloseFinding | NotCheckedFinding;

/**
 * One drawing, placed on the sheet.
 *
 * `parts` is exactly what {@link Report.drawing} hands back — pass those
 * straight through. There is deliberately no `Layout` object on this side of the
 * boundary: the caller already knows where its drawings sit, and a TypeScript
 * mirror of the Rust struct would be a second source of truth about where parts
 * are.
 */
export interface PlacedDrawingInput {
  /** Unique on the sheet. A duplicate is refused, never disambiguated. */
  id: string;
  /** Lower-left corner in sheet mm. Omit for the datum (0). */
  x_mm?: number;
  y_mm?: number;
  /** Degrees anticlockwise about the drawing's own lower-left corner. Omit for 0. */
  rotation_deg?: number;
  parts: DrawingPart[];
}

/**
 * The result of checking a sheet.
 *
 * 🔴 `ok` means **the check ran** — not that the sheet is clear. `clear` is the
 * verdict, and it is `true` only when every pair was examined and every pair
 * passed. On `ok: false` there is no `clear` key at all, so a caller that reads
 * `result.clear` on a failed check gets `undefined` and not a green.
 */
export type LayoutCheckResult =
  | {
      ok: true;
      /** Every pair examined, nothing found. The only clear result. */
      clear: boolean;
      clearance: Clearance;
      /** One entry per condemned pair. All three kinds are refusals. */
      findings: Interference[];
      /**
       * Non-fatal observations — a drawing laid at something other than a
       * quarter turn. Runnable arithmetic and a fixturing problem, so it notes
       * rather than refuses.
       */
      notes: string[];
      /**
       * Limitations of the check itself, present even on a clear sheet. Today
       * this is the outer-boundary/nested-hole false red; see
       * {@link OverlapFinding.false_red_note}.
       */
      caveats: string[];
    }
  | { ok: false; why: string };

/**
 * The minimum clear material between two parts, for this cutter — or a refusal.
 *
 * 🔴 Ask; never add the two numbers up here. `Clearance` is `Serialize`-only in
 * the core on purpose (a deserialised one would walk past the constructor and
 * admit a zero-diameter cutter), so the only way to a required gap is to hand
 * over a diameter and a margin and let the core build it or refuse.
 *
 * ```ts
 * const c = await clearanceFor(6, 1);
 * if (!c.ok) return showRefusal(c.why);   // never a fallback number
 * gapLabel.textContent = `${c.clearance.required_mm} mm`;
 * ```
 */
export async function clearanceFor(
  cutterDiameterMm: number,
  marginMm: number
): Promise<ClearanceResult> {
  return callJson('clearance_for', [cutterDiameterMm, marginMm]);
}

/**
 * Check every pair of parts on a sheet against every other.
 *
 * Takes the drawings as plain data in ONE call and returns the findings. It
 * holds nothing between calls: re-send the current positions when they change.
 *
 * 🔴 What a UI must not do with the result:
 *
 * - **Do not collapse `overlap` and `too_close` into one flag.** Shared material
 *   is fixed by re-nesting; a narrow channel is fixed by nudging. One word for
 *   both sends people to the wrong repair.
 * - **Do not treat `not_checked` as a warning.** It is a refusal. `clear` is
 *   already false when one is present, and it must stay that way.
 * - **Do not "fix" the nested-part false red by relaxing the check.** See
 *   {@link OverlapFinding.false_red_note} — that note is on the finding so it is
 *   in front of whoever is about to.
 *
 * ```ts
 * const r = await checkLayout(drawings, 6, 1);
 * if (!r.ok) return showRefusal(r.why);          // the check did not run
 * if (r.clear) return showClear(r.clearance);
 * for (const f of r.findings) {
 *   switch (f.finding) {
 *     case 'overlap':     renderOverlap(f.a, f.b, f.over_x_mm, f.over_y_mm); break;
 *     case 'too_close':   renderGap(f.a, f.b, f.gap_mm, f.required_mm);      break;
 *     case 'not_checked': renderRefusal(f.a, f.b, f.why);                    break;
 *   }
 * }
 * ```
 */
export async function checkLayout(
  drawings: PlacedDrawingInput[],
  cutterDiameterMm: number,
  marginMm: number
): Promise<LayoutCheckResult> {
  return callJson('check_layout', [JSON.stringify(drawings), cutterDiameterMm, marginMm]);
}

/**
 * An extent WITH its size, as {@link layoutExtent} and {@link planPlacement}
 * return it at the top level.
 *
 * `width_mm`/`height_mm` are the core's own subtraction. Doing `max_x - min_x`
 * in a component is harmless once and a second copy of the core's arithmetic by
 * the third time someone needs it — the extents nested inside a {@link Placement}
 * are the bare {@link LayoutExtent} because that is what the core's own type
 * carries, and neither shape should be built from the other here.
 */
export interface SizedExtent extends LayoutExtent {
  width_mm: number;
  height_mm: number;
}

/**
 * The union of everything on the sheet, or a refusal.
 *
 * 🔴 **`extent` and `cut_extent` are not interchangeable.** `extent` is the
 * geometry as drawn; `cut_extent` is that window grown by the tool radius on
 * every side — where the tool CENTRE goes. Compare `cut_extent` against a sheet
 * when the outer profile is cut on the outside. Using `extent` is wrong by a
 * whole cutter diameter, in the direction that says a job fits when it does not.
 *
 * ⚠ An empty sheet comes back `ok: false`, never as a zero extent. A 0 x 0
 * window at the datum fits every machine and every sheet, so an empty job would
 * report as placeable.
 */
export type LayoutExtentResult =
  | {
      ok: true;
      /** How many drawings were measured. */
      drawings: number;
      /** How many placed parts they contain. */
      parts: number;
      /** Echoed back: what this answer was computed with. */
      tool_radius_mm: number;
      /** The placed geometry, outer boundaries only, exactly as drawn. */
      extent: SizedExtent;
      /** `extent` grown by `tool_radius_mm` on every side — the tool centre's window. */
      cut_extent: SizedExtent;
      /** A drawing laid at something other than a quarter turn. Non-fatal. */
      notes: string[];
      /** Present even on a good answer — today, that sheet fit is a different question. */
      caveats: string[];
    }
  | { ok: false; why: string };

/** Which axis a refusal is about. Serialised lower-case by the core. */
export type PlacementAxis = 'x' | 'y';

/** One axis on which the program is simply bigger than the table. */
export interface Overhang {
  axis: PlacementAxis;
  /** What the program needs on this axis, cutter included. */
  needed_mm: number;
  /** What the machine has, margins already taken off. */
  available_mm: number;
  /** `needed - available`. Shorten the part by this, or find this much more machine. */
  over_mm: number;
}

/**
 * Where on the table the whole set would have to sit — **three genuinely
 * different answers, and never a boolean**.
 *
 * 🔴 `already_inside` is NOT `shift_datum` with `dx_mm = dy_mm = 0`. Offering a
 * move of 0mm invites a person to accept a change that is not one, and the next
 * time a real shift is offered it is trusted less.
 *
 * 🔴 `will_not_fit` carries NO shift, deliberately — not even for the axis that
 * would have fitted. Do not synthesise one out of `overhangs`: a shift clamped
 * to "as close as we could get" reads as an answer while the extent still hangs
 * off the table, and the limit error comes back with the datum somewhere nobody
 * chose. The true answers there are a smaller program, a different placement of
 * the SHEET, or a bigger machine.
 */
export type Placement =
  | {
      outcome: 'already_inside';
      /** Where the program sits, cutter included. */
      extent: LayoutExtent;
      describe: string;
    }
  | {
      outcome: 'shift_datum';
      /**
       * 🔴 **Offer this; never apply it.** Applying means adding `dx_mm` to the
       * stock's `origin_x_mm` and `dy_mm` to `origin_y_mm` — and the datum is
       * the program's position relative to the CLAMPS, which are bolted to the
       * table and do not travel with the sheet. A 3mm shift to clear a soft
       * limit is 3mm into whatever is holding the work down: gate P7's physical
       * failure, which costs the clamp, the cutter and usually the part.
       */
      dx_mm: number;
      dy_mm: number;
      /** Where the program is now, cutter included. */
      current: LayoutExtent;
      /** Where it would be if a human accepted the shift. */
      shifted: LayoutExtent;
      describe: string;
    }
  | {
      outcome: 'will_not_fit';
      /** Where the program is now, cutter included. */
      current: LayoutExtent;
      /** One per failing axis. Both axes can fail at once — that is two facts. */
      overhangs: Overhang[];
      describe: string;
    };

/**
 * The travel answer for the whole set, or a refusal.
 *
 * ⚠ `ok: true` means the question was ANSWERED, not that the job fits — the
 * verdict is `placement.outcome`, and one of its three values is a refusal.
 */
export type PlacementResult =
  | {
      ok: true;
      placement: Placement;
      /** The union as DRAWN, with no cutter in it. `placement`'s extents include it. */
      extent: SizedExtent;
      drawings: number;
      /** Echoed back: what this answer was computed with. */
      tool_radius_mm: number;
      margin_mm: number;
      machine: { travel_x_mm: number; travel_y_mm: number };
      notes: string[];
      caveats: string[];
    }
  | { ok: false; why: string };

/**
 * 🔴 **The union extent of a whole sheet** — the question {@link checkLayout}
 * cannot ask.
 *
 * Every pair on a sheet can be clear, every part can fit the table on its own,
 * and the union of them can still hang off the end. That job cannot be cut in
 * one setup, and nothing else in this binding can say so.
 *
 * Takes the same {@link PlacedDrawingInput}[] as {@link checkLayout} and holds
 * nothing between calls — re-send the current positions when they change.
 *
 * 🔴 `toolRadiusMm` has **no default and is never inferred**. Nothing on this
 * boundary can see which side of which contour the tool runs on, and the core
 * reads a missing radius as zero — which answers as though there were no cutter.
 * Pass `0` only deliberately, for coordinates that already carry the offset.
 *
 * ⚠ **This does not answer sheet fit.** Compare the extent against whichever
 * sheet YOU hold: the sheet basis is contested in this repo (2700x1200 /
 * 600x900 / 2400x1200) and is bom's and ops' to settle, not this tool's.
 *
 * ```ts
 * const u = await layoutExtent(drawings, 3);
 * if (!u.ok) return showRefusal(u.why);           // includes "the sheet is empty"
 * const fitsMySheet =
 *   u.cut_extent.width_mm <= sheetX && u.cut_extent.height_mm <= sheetY;
 * ```
 */
export async function layoutExtent(
  drawings: PlacedDrawingInput[],
  toolRadiusMm: number
): Promise<LayoutExtentResult> {
  return callJson('layout_extent', [JSON.stringify(drawings), toolRadiusMm]);
}

/**
 * 🔴 **Does the WHOLE SET fit the machine's travel — and if not, what would?**
 *
 * The union extent, put to the core's placement planner. The answer is a tagged
 * union on `outcome` and must not be flattened into a boolean: "it fits", "it
 * would fit if you moved the datum here", and "it is bigger than the table by
 * this much on this axis" are three different facts with three different next
 * steps.
 *
 * 🔴 A shift is **offered, never applied** — by this function, by the core, and
 * by any UI without a human who has looked at the machine. See
 * {@link Placement} for why the clamps make that a safety property.
 *
 * `marginMm` is how far to stay clear of each soft limit; `0` puts the program
 * exactly on the limit, which is legal and unforgiving. Both it and
 * `toolRadiusMm` are refused when negative or not finite rather than clamped —
 * an empty input box yields `NaN`, and `NaN` compares false against every limit
 * test, so a clamped one would report an untested program as already on the bed.
 *
 * ```ts
 * const r = await planPlacement(drawings, 3, 0, machine.travel_x_mm, machine.travel_y_mm);
 * if (!r.ok) return showRefusal(r.why);
 * switch (r.placement.outcome) {
 *   case 'already_inside': return showFits(r.placement.extent);
 *   case 'shift_datum':    return offerShift(r.placement.dx_mm, r.placement.dy_mm); // never apply
 *   case 'will_not_fit':   return showOverhangs(r.placement.overhangs);             // no shift exists
 * }
 * ```
 */
export async function planPlacement(
  drawings: PlacedDrawingInput[],
  toolRadiusMm: number,
  marginMm: number,
  travelXMm: number,
  travelYMm: number
): Promise<PlacementResult> {
  return callJson('plan_placement', [
    JSON.stringify(drawings),
    toolRadiusMm,
    marginMm,
    travelXMm,
    travelYMm,
  ]);
}

/** Human-readable run time. A raw seconds count reads as smaller than it is. */
export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
