//! Browser bindings.
//!
//! 🔴 THERE IS NO MACHINING LOGIC IN THIS FILE, and there must never be. Every
//! function here parses JSON, calls the core, and serialises the answer. If a
//! decision were made here the browser would produce a program the CLI and the
//! gates never see, and gate I1 (browser/CLI parity) would be asserting that
//! two different implementations agree — which is exactly the thing it exists
//! to disprove.

use twobee_cam::fixtures::{
    job_plant_from, plan_report_import_bytes_with_surface_and_mesh, plan_report_import_many,
    plan_report_import_with_surface, plan_report_with_surface, tool_library_json, DrawingContour,
    DrawingPart, ImportSource, JobConfig, JOBS, JOB_PLANTS,
};
use twobee_cam::geometry::{Contour, Part, Vertex};
use twobee_cam::layout::{Clearance, Layout, PlacedDrawing};
use wasm_bindgen::prelude::*;

/// Version of the core and of the G-code contract it emits.
#[wasm_bindgen]
pub fn version() -> String {
    serde_json::json!({
        "core": env!("CARGO_PKG_VERSION"),
        "gcode_contract": twobee_cam::GCODE_CONTRACT_VERSION,
    })
    .to_string()
}

/// Fingerprint of the `core/src` this wasm was compiled from — 12 hex chars.
///
/// 🔴 This is the ONE export whose value must NOT be produced here. It is
/// `twobee_cam::BUILD_ID`, baked in at compile time by the core's `build.rs`, so
/// a wasm built from an older core keeps saying the older id no matter how new
/// the page around it is. Gate K3 compares it against `2bee-slice buildid`.
///
/// Prints bare, with nothing wrapped around it: the gate compares strings, and a
/// JSON envelope invites a future "helpful" field that changes the comparison.
#[wasm_bindgen]
pub fn build_id() -> String {
    twobee_cam::BUILD_ID.to_string()
}

#[wasm_bindgen]
pub fn jobs() -> String {
    serde_json::to_string(
        &JOBS.iter().map(|(n, d)| serde_json::json!({"name": n, "detail": d})).collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".into())
}

#[wasm_bindgen]
pub fn plants() -> String {
    serde_json::to_string(
        &JOB_PLANTS
            .iter()
            .map(|(n, d)| serde_json::json!({"name": n, "detail": d}))
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".into())
}

#[wasm_bindgen]
pub fn tools() -> String {
    tool_library_json()
}

/// The sourced spoilboard catalogue, for a host that has to draw a picker.
///
/// 🔴 IT IS THE CORE'S LIST OR IT IS A SECOND LIST. `core/src/spoilboards.rs`
/// says so in as many words: *"a catalogue re-typed in TypeScript is a second
/// list that can drift, and the drift would be invisible: both sides would
/// render confidently and only the machine would disagree"*. Every entry
/// carries its `source` and the date it was read, so a picker can show WHERE a
/// number came from rather than only how big it is — which is the difference
/// between a measured board and an invented one.
///
/// ⚠ The payload's `default_id` is `null` **on purpose**, and a host must not
/// improve on that. Nothing here ranks the entries and `[0]` is not a
/// recommendation; an over-declared board reports the machine's own frame as
/// sacrificial material, so the operator picks the board they own.
#[wasm_bindgen]
pub fn spoilboards() -> String {
    twobee_cam::spoilboards::catalogue_json()
}

/// The tool library WITH a fit verdict per tool for this machine's collets.
///
/// Kept separate from `tools()` rather than replacing it: a caller that has no
/// machine yet still needs the catalogue, and a library that silently reported
/// every tool as unfittable because no collet was declared would be worse than
/// one that does not answer the question at all.
#[wasm_bindgen]
pub fn tools_for_machine(collet_mm: f64, spares_json: &str) -> String {
    let spares: Vec<f64> = serde_json::from_str(spares_json).unwrap_or_default();
    twobee_cam::fixtures::tool_library_json_for(collet_mm, &spares)
}

/// 🔴 **The tool list's verdicts — usable / invalidates / unknown per tool, and
/// whether the drawing wants it.** `core/src/recommend.rs` decides all of it.
///
/// `config_json` is **the same [`JobConfig`] the browser sends to [`plan`] and
/// [`plan_import_many`]** — deliberately the same object, so a row saying a
/// cutter is usable and a planner refusing that cutter cannot be describing two
/// different machines. Send the config you are about to plan with, not a
/// hand-built summary of it.
///
/// `parts_json` is `DrawingPart[]` — exactly what came back as
/// `Report.drawing`, returned rather than rebuilt. `"[]"` (or an empty string)
/// means **no drawing**, and every `advice` comes back `"unknown"`.
///
/// # Reading the answer
///
/// Each verdict carries **two** answers and they are not interchangeable:
///
/// * `usability` — `"usable" | "invalidates" | "unknown"`. **This is the red
///   mark.** `invalidates` means the job cannot be cut with this tool; `why` is
///   the core's sentence and `rules` says which of the four conditions fired
///   (`tool-definition`, `collet`, `reach`, `spindle-rpm`) — because
///   "invalidates the job" is not one condition and a red square that will not
///   say which one cannot be acted on.
/// * `advice` — `"recommended" | "usable" | "not-for-this-job" | "unknown"`.
///   **This is the filter.** A tool can be perfectly valid and simply not the
///   best choice.
///
/// 🔴 `"unknown"` is **not** usable, in either field. It means a rule could not
/// run — no workpiece thickness declared, no material chosen, no collet on the
/// machine — so nothing has vouched for that tool, and the planner may still
/// refuse it. Render it as unjudged. The payload's `caveats` carry this in the
/// core's own words; show them rather than rewriting them.
///
/// ⚠ Every sentence here is composed in the core. A host renders `why`,
/// `why_advice` and each rule's `why` verbatim; a TypeScript paraphrase of a
/// safety message is a second copy that drifts.
#[wasm_bindgen]
pub fn tool_verdicts(config_json: &str, parts_json: &str) -> String {
    let cfg: JobConfig = if config_json.trim().is_empty() {
        JobConfig::default()
    } else {
        match serde_json::from_str(config_json) {
            Ok(c) => c,
            // Refused, never silently replaced with defaults: judging tools
            // against a default machine while the operator's config was thrown
            // away would answer confidently about a setup nobody has.
            Err(e) => return refused(&format!("configuration rejected: {e}")),
        }
    };
    // An absent list and an empty list mean the same thing here — no drawing —
    // and both are legitimate: the tool list exists before a file is dropped.
    let parts: Vec<DrawingPart> = if parts_json.trim().is_empty() {
        Vec::new()
    } else {
        match serde_json::from_str(parts_json) {
            Ok(v) => v,
            Err(e) => {
                return refused(&format!(
                    "the drawing was rejected: {e}. NOTHING was read from it, so no tool was \
                     judged against this drawing — which is not the same fact as no tool suiting it"
                ))
            }
        }
    };
    let geometry: Vec<Part> = parts.iter().map(to_part).collect();

    // The SAME merged library the planner resolves its tool from, so a shop
    // tool declared in `extra_tools` is judged here exactly as it will be
    // planned. Two lookups against two different libraries is the defect
    // `merged_library` exists to end.
    let mut notes: Vec<String> = Vec::new();
    let lib = cfg.merged_library(&mut notes);
    let setup = twobee_cam::recommend::Setup::from_job_config(&cfg);
    twobee_cam::recommend::tool_verdicts_json(&lib, &setup, &geometry, &notes)
}

/// One drawing on the workpiece, as it crosses the boundary for a VERDICT.
///
/// 🔴 **`offset_mm` / `rotation_deg` are `ImportDrawingIn`'s, not
/// [`PlacedDrawingIn`]'s** — a DELTA from where the drawing was drawn, and zero
/// therefore means AS DRAWN rather than "at the workpiece corner". The core's
/// own `drawing_verdicts_json` doc spells this boundary out field by field and
/// this struct is that spelling, not a second design of it.
#[derive(serde::Deserialize)]
struct VerdictDrawingIn {
    id: String,
    /// `Report.drawing` handed back, filtered to this drawing. Absent is an
    /// empty list, which is a REAL answer — the drawing carries no geometry the
    /// planner could measure — and the core refuses it by name rather than
    /// skipping the row.
    #[serde(default)]
    parts: Vec<DrawingPart>,
    #[serde(default)]
    offset_mm: [f64; 2],
    #[serde(default)]
    rotation_deg: f64,
}

/// 🔴 **The drawing list's verdicts — usable / invalidates / unknown per
/// drawing, and whether it belongs on the declared workpiece.**
/// `core/src/recommend.rs` decides all of it.
///
/// The sibling of [`tool_verdicts`], with the same guarantee and the same two
/// arguments' meaning: `config_json` is **the same [`JobConfig`] the browser
/// sends to [`plan`] and [`plan_import_many`]**, so a row saying a drawing
/// belongs here and a planner refusing that drawing cannot be describing two
/// different workpieces. A config that will not parse is REFUSED
/// (`{ ok: false, why }`), never replaced with defaults.
///
/// `drawings_json` is `VerdictDrawingIn[]`. `"[]"` — or an empty string — is a
/// legitimate answer of **zero rows**: the drawing list exists before a file is
/// dropped, and zero rows is not the same fact as every row being fine.
///
/// # Reading the answer
///
/// Each verdict carries **two** answers and they are not interchangeable:
///
/// * `usability` — `"usable" | "invalidates" | "unknown"`. **This is the red
///   mark.** `invalidates` means the planner refuses the job because of this
///   drawing; `why` is the core's sentence and `rules` says which of the four
///   conditions fired (`identity`, `geometry`, `placement`, `pair-clearance`).
/// * `fit` — `"on-workpiece" | "off-workpiece" | "unknown"`. **This is the
///   filter, and it is a SEPARATE AXIS.** 🔴 The planner does **not** refuse an
///   off-workpiece drawing today — it posts, and the cutter goes where the
///   material is not. Rendering `fit` as an invalidation would claim a refusal
///   that does not exist.
///
/// 🔴 `"unknown"` is **not** usable, in either field, and `selected` / `not
/// chosen` are the HOST's own state and are deliberately absent from the
/// payload. Both sentences travel in `caveats`, in the core's words; show them
/// rather than rewriting them.
#[wasm_bindgen]
pub fn drawing_verdicts(config_json: &str, drawings_json: &str) -> String {
    let cfg: JobConfig = if config_json.trim().is_empty() {
        JobConfig::default()
    } else {
        match serde_json::from_str(config_json) {
            Ok(c) => c,
            // Refused, never silently replaced with defaults: judging where a
            // drawing belongs against a default workpiece while the operator's
            // config was thrown away would answer confidently about material
            // nobody has on the machine.
            Err(e) => return refused(&format!("configuration rejected: {e}")),
        }
    };
    // An absent list and an empty list mean the same thing — no drawings — and
    // both are legitimate. A list that will not PARSE is a third thing and is
    // refused, because nothing was read from it.
    let described: Vec<VerdictDrawingIn> = if drawings_json.trim().is_empty() {
        Vec::new()
    } else {
        match serde_json::from_str(drawings_json) {
            Ok(v) => v,
            Err(e) => {
                return refused(&format!(
                    "the drawing list was rejected: {e}. NOTHING was read from it, so no drawing \
                     was judged — which is not the same fact as every drawing being fine"
                ))
            }
        }
    };

    // The geometry is built ONCE and borrowed, because `DrawingIn` borrows its
    // parts. Two loops rather than one so the `Vec<Part>` outlives the borrow.
    let geometry: Vec<Vec<Part>> =
        described.iter().map(|d| d.parts.iter().map(to_part).collect()).collect();
    let drawings: Vec<twobee_cam::recommend::DrawingIn<'_>> = described
        .iter()
        .zip(geometry.iter())
        .map(|(d, parts)| twobee_cam::recommend::DrawingIn {
            id: &d.id,
            parts,
            offset_mm: d.offset_mm,
            rotation_deg: d.rotation_deg,
        })
        .collect();

    // `DrawingSetup::from_job_config` resolves the cutter through the SAME
    // merged library the planner does, and pushes its own notes; `merged_library`
    // is not called again here, or a rejected extra tool would be reported twice.
    let setup = twobee_cam::recommend::DrawingSetup::from_job_config(&cfg);
    twobee_cam::recommend::drawing_verdicts_json(&setup, &drawings, &[])
}

/// Can this machine hold this workpiece, and if not, would a quarter turn fix it?
///
/// The UI asks; it does not re-derive. The last time a fit rule was written a
/// second time in TypeScript it was orientation-blind and refused a workpiece that
/// fits turned.
#[wasm_bindgen]
pub fn stock_fit(
    size_x_mm: f64,
    size_y_mm: f64,
    rotation_deg: f64,
    travel_x_mm: f64,
    travel_y_mm: f64,
) -> String {
    use twobee_cam::types::{Machine, Stock};
    let stock = Stock { size_x_mm, size_y_mm, rotation_deg, ..Stock::default() };
    let machine = Machine { travel_x_mm, travel_y_mm, ..Machine::default() };
    let (fx, fy) = stock.footprint();
    serde_json::json!({
        "fits": stock.fits(&machine),
        "footprint": [fx, fy],
        "quarter_turn": stock.quarter_turn_that_fits(&machine),
    })
    .to_string()
}

/// Plan a job and return the full report as JSON.
///
/// Errors are RETURNED as JSON with `ok: false`, never thrown: a UI that has to
/// catch to find out a program was refused will eventually forget to catch, and
/// the refusal becomes invisible.
///
/// # `surface_cell_mm` — the simulated stock surface, and why it is opt-in
///
/// Pass `undefined` (or omit it) and `simulated_stock_surface` comes back
/// `null`. Pass a millimetre value and the report carries the machined surface
/// as a base64 `f32` height map resampled to about that display cell.
///
/// 🔴 It is opt-in because the honest size is punishing: at the default 0.6mm
/// simulation cell a 600x900 workpiece is 1,001 x 1,501 samples — **8.0MB of base64
/// on every single call**. A panel that re-plans while a slider moves would send
/// that on every frame. Ask for it when something is going to draw it, at a cell
/// that thing can afford (3mm on that workpiece is ~322KB), and decline it the rest
/// of the time.
///
/// 🔴 And name it correctly downstream. What comes back is the **simulated stock
/// surface**, not the part: it cannot see a feature narrower than one cell, and
/// on a through-cut it shows removed material without knowing which side of the
/// cut is the part and which is the offcut.
#[wasm_bindgen]
pub fn plan(
    job: &str,
    plant: &str,
    config_json: &str,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> String {
    let Some(p) = job_plant_from(if plant.is_empty() { "none" } else { plant }) else {
        return err(&format!("unknown plant '{plant}'"));
    };
    let cfg: JobConfig = if config_json.trim().is_empty() {
        JobConfig::default()
    } else {
        match serde_json::from_str(config_json) {
            Ok(c) => c,
            // 🔴 A rejected config is reported, never silently replaced with
            // defaults. Falling back would run a DIFFERENT job than the one the
            // operator configured, and it would look like it worked.
            Err(e) => return err(&format!("configuration rejected: {e}")),
        }
    };
    let cell = if sim_cell_mm > 0.0 { sim_cell_mm } else { 0.6 };
    match plan_report_with_surface(job, p, &cfg, cell, surface_cell(surface_cell_mm)) {
        Some(r) => serde_json::to_string(&r).unwrap_or_else(|e| err(&e.to_string())),
        None => err(&format!("unknown job '{job}'")),
    }
}

/// Normalise a surface request from JS.
///
/// A non-finite or non-positive cell is treated as **no request at all** rather
/// than clamped to something plausible. `NaN` arrives here whenever a UI does
/// arithmetic on an empty input box, and clamping it to a default would hand
/// back megabytes nobody asked for, at a resolution nobody chose.
fn surface_cell(v: Option<f64>) -> Option<f64> {
    v.filter(|c| c.is_finite() && *c > 0.0)
}

/// Normalise a loaded-mesh request from JS.
///
/// Same rule as [`surface_cell`] and for the same reason: a budget of zero is
/// **no request at all**, never "no limit". A UI that computes a budget from a
/// viewport size will produce 0 the first time it runs before layout, and a zero
/// read as "unlimited" would hand the page a 100k-triangle model at exactly the
/// moment it is least able to draw it.
fn mesh_budget(v: Option<u32>) -> Option<usize> {
    v.filter(|n| *n > 0).map(|n| n as usize)
}

fn err(msg: &str) -> String {
    serde_json::json!({ "ok": false, "errors": [msg], "gcode": "" }).to_string()
}

/// Plan a job from a FILE the user dropped in — the bytes, exactly as read.
///
/// 🔴 **Bytes, not a string, and this is the export a drop-zone should call.**
/// A binary STL is a header plus 50 bytes per triangle of little-endian float.
/// Reading it as text in JS (`FileReader.readAsText`, `Response.text()`) decodes
/// it as UTF-8 and **replaces every byte that does not decode with U+FFFD** — no
/// error, no exception, a string that arrives here looking like a file. The
/// facets it destroyed come back as a mesh with holes, which sections into an
/// outline with a side missing, and that still looks like a part. Use
/// `readAsArrayBuffer` / `new Uint8Array(await file.arrayBuffer())`.
///
/// `format` is `"dxf" | "svg" | "stl" | "auto"`; `"auto"` decides by content and
/// is what a drop-zone wants, since the user's filename is not evidence.
///
/// `z_section_mm` applies to a MESH only. 🔴 An STL is a 3D triangle mesh and
/// this core is 2.5D profile/pocket CAM: it can only enter as ONE FLAT SECTION
/// at a single Z, which is **not 3D surfacing** and never will be here. Pass
/// `undefined` and the core sections at the mesh's mid-height and puts that fact
/// in `notes` — the UI must render those notes, because a user who believes they
/// got 3D machining and got a slice will cut a plausible-looking wrong part and
/// nothing downstream can tell.
///
/// # `mesh_budget_tris` — the LOADED MODEL, and why it is opt-in
///
/// Pass `undefined` (or omit it) and `loaded_mesh` comes back `null`. Pass a
/// triangle count and the report carries the imported solid's triangles — at
/// most that many — as base64 `f32`, for drawing.
///
/// 🔴 Opt-in because an STL of a real part is routinely 100k+ triangles, which
/// is **4.8MB of base64 on every call**. Nothing shared, nothing indexed: an STL
/// has no topology, so it is 36 raw bytes of vertex per triangle. Ask when
/// something is about to draw it, at a budget that thing can afford, and decline
/// the rest of the time.
///
/// 🔴 And say the right thing about it. What comes back is **the model as
/// loaded — the INPUT**. It is NOT what the machine will make: the machine cuts
/// the flat section at `loaded_mesh.section_z_mm`, one outline through that
/// solid. A viewer shown a 3D object assumes the machine produces it, and a
/// picture asserts that far more strongly than a note can withdraw it.
#[wasm_bindgen]
pub fn plan_import_bytes(
    data: &[u8],
    format: &str,
    z_section_mm: Option<f64>,
    config_json: &str,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
    mesh_budget_tris: Option<u32>,
) -> String {
    let cfg: JobConfig = if config_json.trim().is_empty() {
        JobConfig::default()
    } else {
        match serde_json::from_str(config_json) {
            Ok(c) => c,
            // Reported, never silently replaced with defaults: a fallback would
            // plan a DIFFERENT job than the one that was configured, and it
            // would look like it worked.
            Err(e) => return err(&format!("configuration rejected: {e}")),
        }
    };
    let cell = if sim_cell_mm > 0.0 { sim_cell_mm } else { 0.6 };
    // A non-finite Z is treated as ABSENT rather than passed through: NaN
    // compares false against every plane test, so it would section nothing and
    // report a mesh that "crossed no geometry" — a true sentence about the wrong
    // cause, and the operator would go looking at their model.
    let z = z_section_mm.filter(|v| v.is_finite());
    let r = plan_report_import_bytes_with_surface_and_mesh(
        data,
        format,
        z,
        &cfg,
        cell,
        surface_cell(surface_cell_mm),
        mesh_budget(mesh_budget_tris),
    );
    serde_json::to_string(&r).unwrap_or_else(|e| err(&e.to_string()))
}

/// Plan a job from a drawing the user supplied, as TEXT.
///
/// `format` is `"dxf"` or `"svg"`. Everything the importer could not read comes
/// back in `notes`, and a drawing that yields nothing cuttable comes back with
/// `ok: false` and a reason — never as an empty program that looks finished.
///
/// ⚠ Text only. A mesh must go through [`plan_import_bytes`]; an STL forced
/// through here is either rejected or silently corrupted by the UTF-8 decode
/// that happened before it ever reached this function.
///
/// ⚠ And so there is deliberately **no `mesh_budget_tris` here**. A DXF or an
/// SVG contains no 3D object — that is what the format is, not a gap — so a
/// parameter asking for one would be a setting that can be turned on and does
/// nothing, which reads to the next person as a broken feature. `loaded_mesh`
/// comes back `null` from this export, always.
#[wasm_bindgen]
pub fn plan_import(
    text: &str,
    format: &str,
    config_json: &str,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> String {
    let cfg: JobConfig = if config_json.trim().is_empty() {
        JobConfig::default()
    } else {
        match serde_json::from_str(config_json) {
            Ok(c) => c,
            Err(e) => return err(&format!("configuration rejected: {e}")),
        }
    };
    let cell = if sim_cell_mm > 0.0 { sim_cell_mm } else { 0.6 };
    let r = plan_report_import_with_surface(text, format, &cfg, cell, surface_cell(surface_cell_mm));
    serde_json::to_string(&r).unwrap_or_else(|e| err(&e.to_string()))
}

// ---------------------------------------------------------------------------
// Multi-part placement — `core/src/layout.rs`, reachable from the browser
// ---------------------------------------------------------------------------

/// The overlap check's own named FALSE RED, carried across the boundary
/// verbatim from `core/src/layout.rs`'s module header.
///
/// 🔴 It is here because a caveat that stays in a Rust doc comment does not
/// reach the person looking at the refusal. Someone will nest a small part
/// inside a big part's hole, see it refused, and "fix" it by weakening the
/// check — which is the one repair that turns a cutter-saving red into a
/// cutter-breaking green.
const OUTER_BOUNDARY_ONLY: &str =
    "This check compares OUTER boundary to OUTER boundary. A part deliberately nested inside \
     another part's HOLE is therefore refused as an overlap, even though that material is a \
     drop-out and genuinely available. That is a known FALSE RED — it is not a defect in the \
     check and must not be 'fixed' by relaxing it. The workaround is to draw the nested part as \
     part of the same drawing. Refusing a legal nest costs a re-draw; permitting an illegal one \
     costs a cutter.";

/// Why a clearance could not be built. One sentence, no number in it that a
/// caller could mistake for an answer.
const NO_CLEARANCE: &str =
    "a clearance could not be built: the cutter diameter must be a positive, finite number of \
     millimetres and the margin must be finite and not negative. There is no default and no \
     fallback — the required gap is a machining constraint, and a gap computed from a diameter \
     nobody declared would be trusted exactly as if someone had.";

/// A drawing the caller has placed on the workpiece, as it crosses the boundary.
///
/// `parts` is the SAME shape the core already hands back as `Report.drawing`
/// ([`DrawingPart`]) — so the caller returns what it was given rather than
/// building a second description of the same geometry.
#[derive(serde::Deserialize)]
struct PlacedDrawingIn {
    id: String,
    /// Where the drawing's lower-left corner sits, in workpiece mm. Absent is `0.0`
    /// — the datum — which is what `PlacedDrawing` itself defaults to.
    #[serde(default)]
    x_mm: f64,
    #[serde(default)]
    y_mm: f64,
    /// Degrees anticlockwise about the drawing's own lower-left corner.
    #[serde(default)]
    rotation_deg: f64,
    parts: Vec<DrawingPart>,
}

/// A contour from the wire, back into core geometry.
///
/// 🔴 `closed` is CARRIED, never assumed. An open boundary has to reach the
/// check as an open one, so it comes back as `not_checked`; closing it here
/// would invent an edge the drawing never had and silently turn a refusal into
/// a pass.
fn to_contour(c: &DrawingContour) -> Contour {
    Contour {
        verts: c.verts.iter().map(|v| Vertex::arc(v.x, v.y, v.bulge)).collect(),
        closed: c.closed,
    }
}

/// A part from the wire, back into core geometry.
///
/// Built through `Part::new` / `Part::with_hole` rather than a struct literal
/// because those are the constructors every other caller in the core uses, and
/// they normalise winding — outer counter-clockwise, holes clockwise. The gap
/// measurement grows the outer boundary OUTWARD; a boundary wound the other way
/// would grow inward and report clearance that is not there.
fn to_part(p: &DrawingPart) -> Part {
    let mut part = Part::new(p.name.clone(), to_contour(&p.outer));
    for h in &p.inners {
        part = part.with_hole(to_contour(h));
    }
    part
}

/// `{ "ok": false, "why": ... }` — and **no other key**. A refusal that carried
/// a `required_mm` or a `clear` would be a number a caller could read past the
/// refusal, which is the whole failure this pair of exports exists to stop.
fn refused(why: &str) -> String {
    serde_json::json!({ "ok": false, "why": why }).to_string()
}

/// The layout, built from what the caller sent — or the reason it was not.
///
/// One builder for all three workpiece-level exports. It exists so the finite-position
/// refusal and the duplicate-id refusal cannot drift apart between "check this
/// workpiece" and "measure this workpiece": a position too broken to check a pair
/// against is too broken to measure a union from, and the day those two doors
/// disagreed, one of them would be answering about a workpiece the other refused.
///
/// Nothing is held. The `Layout` lives for the duration of one call and dies
/// with it — the caller keeps the only copy of where its drawings sit.
fn layout_from_json(drawings_json: &str) -> Result<Layout, String> {
    let placed: Vec<PlacedDrawingIn> = serde_json::from_str(drawings_json).map_err(|e| {
        format!(
            "the placed drawings were rejected: {e}. NOTHING was read from them, so nothing was \
             checked and nothing was measured, which is not the same fact as nothing being wrong"
        )
    })?;

    let mut layout = Layout::new();
    for d in &placed {
        // A non-finite position is refused rather than clamped. NaN compares
        // false against every test in the check, so a part placed at NaN would
        // sail through every pair as "far enough away" and be reported clear —
        // and it would drop straight out of a union extent, because `min`/`max`
        // propagate it silently, reporting a workpiece smaller than the one on the spoilboard.
        //
        // ⚠ This is a BACKSTOP and it has never been watched go red, because
        // through this door it cannot: JSON has no `NaN` or `Infinity` literal
        // (`JSON.stringify(NaN)` emits `null`), and an overflowing literal like
        // `1e999` is rejected by the deserialiser above as "number out of
        // range". Both were measured. So today the refusal that actually fires
        // is serde's, one branch up — do not read this line as the guard that is
        // holding, and do not delete the one above believing this covers it.
        if !d.x_mm.is_finite() || !d.y_mm.is_finite() || !d.rotation_deg.is_finite() {
            return Err(format!(
                "drawing `{}` is placed at a position or rotation that is not a finite number, so \
                 where it sits on the workpiece is unknown and nothing involving it could be checked \
                 or measured",
                d.id
            ));
        }
        let parts: Vec<Part> = d.parts.iter().map(to_part).collect();
        let drawing = match PlacedDrawing::new(d.id.clone(), parts) {
            Ok(p) => p.at(d.x_mm, d.y_mm).rotated(d.rotation_deg),
            Err(e) => return Err(e.describe()),
        };
        layout.add(drawing).map_err(|e| e.describe())?;
    }
    Ok(layout)
}

/// The clearance as three numbers. `required_mm` is
/// [`Clearance::required_mm`]'s answer — it is READ from the core, not summed
/// here. A `diameter + margin` written in this file would be a machining rule
/// living where no gate can see it, which is the exact defect that put the
/// workpiece-fit rule in TypeScript.
fn clearance_json(c: &Clearance) -> serde_json::Value {
    serde_json::json!({
        "cutter_diameter_mm": c.cutter_diameter_mm(),
        "margin_mm": c.margin_mm(),
        "required_mm": c.required_mm(),
    })
}

/// How much clear material two parts must have between them, for this cutter.
///
/// 🔴 **Returns the refusal, never a fallback number.** A clearance that cannot
/// be built is `{ ok: false, why }` with no `required_mm` at all — a check that
/// cannot run is not a check that passed, and a caller reading a plausible
/// number off a failed call would place parts against it.
///
/// This is the export that exists so nobody adds a cutter diameter to a margin
/// in TypeScript. The sum is [`Clearance::required_mm`]'s, in the core, where
/// the gates can see it.
#[wasm_bindgen]
pub fn clearance_for(cutter_diameter_mm: f64, margin_mm: f64) -> String {
    match Clearance::new(cutter_diameter_mm, margin_mm) {
        Some(c) => serde_json::json!({ "ok": true, "clearance": clearance_json(&c) }).to_string(),
        None => refused(NO_CLEARANCE),
    }
}

/// 🔴 **The check.** Every pair of parts on the workpiece, against every other.
///
/// `drawings_json` is an array of [`PlacedDrawingIn`] — id, position, rotation,
/// and the parts as [`DrawingPart`], which is what `Report.drawing` already
/// hands out. There is no layout OBJECT on this boundary and no handle to keep:
/// the caller already knows where its drawings are, and a second copy of that
/// on the far side of the wire would be a second source of truth about where
/// parts sit.
///
/// # Reading the answer
///
/// * `ok: false` — the check **did not run**. Nothing was examined.
/// * `ok: true, clear: true` — every pair was examined and every pair is clear.
///   An empty `findings` array is the only clear result.
/// * `ok: true, clear: false` — `findings` holds one entry per condemned pair.
///
/// Each finding carries its own numbers and a `finding` tag which is one of:
///
/// * `overlap` — the parts share material. **Fix: re-nest.** Also carries
///   `false_red_note`; see [`OUTER_BOUNDARY_ONLY`].
/// * `too_close` — they share no material but the channel between them is
///   narrower than the tool. **Fix: nudge them apart.** A different failure with
///   a different fix, which is why it is a different tag and never a shared
///   "collision" flag.
/// * `not_checked` — the pair could not be examined. **This is a REFUSAL, not a
///   warning.** An unchecked pair is not a clear pair.
///
/// `describe` on each finding is the core's own sentence, which is worded so an
/// overlap can never read as a spacing problem. Render the numbers; use the
/// sentence when a sentence is wanted, rather than composing one here.
#[wasm_bindgen]
pub fn check_layout(drawings_json: &str, cutter_diameter_mm: f64, margin_mm: f64) -> String {
    let Some(clearance) = Clearance::new(cutter_diameter_mm, margin_mm) else {
        return refused(NO_CLEARANCE);
    };

    let layout = match layout_from_json(drawings_json) {
        Ok(l) => l,
        Err(why) => return refused(&why),
    };

    let found = layout.check(&clearance);
    let mut findings = Vec::with_capacity(found.len());
    for f in &found {
        let mut v = match serde_json::to_value(f) {
            Ok(v) => v,
            Err(e) => {
                return refused(&format!(
                    "a finding could not be encoded for the browser ({e}), so the result cannot be \
                     shown. A refusal nobody can see is not a clear workpiece"
                ))
            }
        };
        if let Some(o) = v.as_object_mut() {
            // The core's own wording. Added, not substituted: the numbers above
            // it are what a UI should lay out, and this is the sentence for
            // when a sentence is wanted.
            o.insert("describe".into(), serde_json::Value::String(f.describe()));
            // Attached to the finding itself, not only to the report, because
            // the moment someone decides this check is wrong is the moment they
            // are looking at one overlap.
            if o.get("finding").and_then(|t| t.as_str()) == Some("overlap") {
                o.insert("false_red_note".into(), serde_json::json!(OUTER_BOUNDARY_ONLY));
            }
        }
        findings.push(v);
    }

    serde_json::json!({
        "ok": true,
        // An empty findings list is the only clear result — `Layout::check`'s
        // own definition, not a threshold applied here.
        "clear": found.is_empty(),
        "clearance": clearance_json(&clearance),
        "findings": findings,
        // Non-fatal: a drawing laid at something other than a quarter turn.
        // Runnable arithmetic and a fixturing problem, so it notes rather than
        // refuses — and it would be lost entirely if only findings crossed.
        "notes": layout.notes(),
        // Always present, including on a clear workpiece. A limitation that only
        // appears once it has already bitten is a limitation nobody read.
        "caveats": [OUTER_BOUNDARY_ONLY],
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// The UNION question — `core/src/layout.rs` + `core/src/placement.rs`
// ---------------------------------------------------------------------------
//
// 🔴 THE HOLE THIS CLOSES. `check_layout` above answers "do these parts destroy
// each other?", one pair at a time. It cannot answer "does the WHOLE SET fit?",
// and those are different facts: every pair on a workpiece can be clear, every part
// can fit the travel on its own, and the union of them can still hang off the
// end. A job like that cannot be cut in one setup, and until these two exports
// existed the browser had no way to ask.

use twobee_cam::placement::Extent;
use twobee_cam::types::Machine;

/// Why a tool radius was not usable. There is no default and there cannot be.
const NO_TOOL_RADIUS: &str =
    "no usable tool radius was given: it must be a finite number of millimetres and not negative. \
     There is NO default. The radius is how far outside the drawn geometry the tool CENTRE runs, \
     and nothing on this boundary can see which side of which contour the tool is on — so it is a \
     parameter, always. It is refused rather than clamped because the core reads a negative radius \
     as ZERO, which answers the question as though there were no cutter: 598mm of geometry fits \
     600mm of travel, and the same geometry with a 6mm cutter running outside it does not. For an \
     already-planned TOOLPATH the radius is in the coordinates, so 0.0 is the correct value — \
     passed on purpose, and not left behind by an empty input box.";

/// Why a margin was not usable.
const NO_MARGIN: &str =
    "no usable margin was given: it must be a finite number of millimetres and not negative. The \
     margin is how far to stay clear of each soft limit; a negative one would be a licence to run \
     past the limit. It is refused rather than clamped because NaN — which is what an empty input \
     box produces the moment any arithmetic touches it — compares false against every limit test, \
     so the program would be reported as sitting inside travel with nothing having been tested.";

/// Why a machine was not usable.
const NO_TRAVEL: &str =
    "the machine's travel was not usable: travel_x_mm and travel_y_mm must both be finite and \
     greater than zero. Refused rather than defaulted to some plausible machine, because every \
     comparison against a non-finite limit is false — the answer would come back `already_inside`, \
     a green meaning nothing was tested, about a machine nobody declared.";

/// Why an empty workpiece gets a refusal and not a zero.
const EMPTY_SHEET: &str =
    "there are no drawings on this workpiece, so it has no extent and no placement. An ABSENT extent \
     and a ZERO extent are different facts, and this returns neither a number nor a verdict rather \
     than blur them: a 0 x 0 window at the datum fits every machine and every workpiece, so an empty \
     job would report as placeable.";

/// 🔴 The `sheet basis` is not this lane's to settle, and these exports must
/// not look as though they settled it.
///
/// ⚠ The CONSTANT NAME is a contract with its callers and does not move. The
/// sentence it holds does: the question it names is *"is the panel you bought
/// big enough"*, which is about MATERIAL, and travel fit is about REACH.
const SHEET_FIT_IS_A_DIFFERENT_QUESTION: &str =
    "WORKPIECE FIT AND TRAVEL FIT ARE DIFFERENT QUESTIONS, and only TRAVEL is answered here. \
     TRAVEL FIT is whether the machine can REACH every coordinate in one setup — a question about \
     the machine, with no material in it. WORKPIECE FIT is whether the panel you bought is big \
     enough to cut this from — a question about MATERIAL, and one this tool cannot answer, because \
     it does not hold the `sheet basis`: which panel size we buy is contested three ways in this \
     repo (2700x1200, 600x900, 2400x1200) and belongs to bom + ops. Compare the extent against \
     whichever workpiece you actually hold. Nothing here picks one, because a default would \
     silently settle an open question that is not ours to settle.";

/// 🔴 The reason `plan_placement` reports instead of moving anything.
const SHIFT_IS_OFFERED_NEVER_APPLIED: &str =
    "A DATUM SHIFT IS OFFERED, NEVER APPLIED — not by the core, not by this binding, and not by a \
     UI without a human who has looked at the machine. The datum is the program's position \
     relative to the CLAMPS, and the clamps are bolted to the machine: they do not travel with the \
     workpiece. Moving a program 3mm to clear a soft limit moves it 3mm into whatever is holding the \
     work down, which is gate P7's physical failure — a toolpath through a clamp destroys the \
     clamp, the cutter, and usually the part.";

/// 🔴 The two answers a caller will be tempted to invent, named so they are not.
const THE_THREE_OUTCOMES_ARE_DIFFERENT_FACTS: &str =
    "`will_not_fit` carries NO shift, deliberately — not even for the axis that would have fitted. \
     A shift clamped to 'as close as we could get' reads as an answer while the extent still hangs \
     outside the travel, and the limit error comes back with the datum somewhere nobody chose. Do not \
     synthesise a shift out of `overhangs`. And `already_inside` is NOT `shift_datum` with \
     dx_mm = dy_mm = 0: offering a move of 0mm invites a person to accept a change that is not \
     one, and the next time a real shift is offered it will be trusted less.";

/// An extent as the window and its size. `width_mm`/`height_mm` are
/// [`Extent::width`]/[`Extent::height`] — read from the core rather than
/// subtracted here, for the same reason `required_mm` is.
fn extent_json(e: &Extent) -> serde_json::Value {
    serde_json::json!({
        "min_x": e.min_x,
        "min_y": e.min_y,
        "max_x": e.max_x,
        "max_y": e.max_y,
        "width_mm": e.width(),
        "height_mm": e.height(),
    })
}

/// A declared tool radius, or nothing. Zero is legal and meaningful (a planned
/// toolpath already carries the offset); negative and non-finite are not.
fn tool_radius(v: f64) -> Option<f64> {
    if v.is_finite() && v >= 0.0 {
        Some(v)
    } else {
        None
    }
}

/// A declared margin, or nothing. The same rule as [`Clearance::new`]'s margin,
/// on purpose: two doors into the same core must not disagree about what a
/// margin is.
fn margin_mm_of(v: f64) -> Option<f64> {
    if v.is_finite() && v >= 0.0 {
        Some(v)
    } else {
        None
    }
}

/// 🔴 **The UNION extent of everything on the workpiece** — the question a per-pair
/// check cannot ask.
///
/// `drawings_json` is the same `PlacedDrawingIn[]` [`check_layout`] takes, so a
/// caller sends back exactly what it was given. Nothing is held between calls
/// and there is no layout handle: the caller already knows where its drawings
/// sit, and a second copy on this side of the wire would be a second source of
/// truth about where parts are.
///
/// # Two extents come back and they are NOT interchangeable
///
/// * `extent` — the placed GEOMETRY, outer boundaries only, exactly as drawn.
/// * `cut_extent` — that window grown by `tool_radius_mm` on every side: where
///   the tool CENTRE goes. This is the one to compare against a workpiece when the
///   outer profile is cut on the outside. Comparing `extent` instead is wrong by
///   a whole cutter diameter, and wrong in the direction that says a job fits
///   when it does not.
///
/// `tool_radius_mm` is a **parameter with no default** — see [`NO_TOOL_RADIUS`].
/// Pass `0.0` deliberately when the coordinates already carry the offset.
///
/// ⚠ **This does not answer workpiece fit and must not be read as doing so.** It
/// hands back a window; the caller compares it against whichever workpiece it holds.
/// See [`SHEET_FIT_IS_A_DIFFERENT_QUESTION`] — the sheet basis is contested in
/// this repo and belongs to bom + ops, so nothing here picks one.
///
/// An empty workpiece is a **refusal**, not a zero extent — see [`EMPTY_SHEET`].
#[wasm_bindgen]
pub fn layout_extent(drawings_json: &str, tool_radius_mm: f64) -> String {
    let Some(radius) = tool_radius(tool_radius_mm) else {
        return refused(NO_TOOL_RADIUS);
    };
    let layout = match layout_from_json(drawings_json) {
        Ok(l) => l,
        Err(why) => return refused(&why),
    };
    // `Layout::extent` is `None` for an empty workpiece, and that `None` crosses as
    // a refusal rather than as `extent: null`. A null a caller can read past
    // becomes a zero the first time someone writes `?? 0`.
    let Some(extent) = layout.extent() else {
        return refused(EMPTY_SHEET);
    };

    serde_json::json!({
        "ok": true,
        "drawings": layout.len(),
        "parts": layout.parts().len(),
        // Echoed back so the answer says what it was computed with. A radius
        // that is invisible in the result is a radius the next reader assumes.
        "tool_radius_mm": radius,
        "extent": extent_json(&extent),
        "cut_extent": extent_json(&extent.grown(radius)),
        // A drawing laid at something other than a quarter turn still has an
        // extent — it is just an extent nobody can register against the
        // machine's own axes. Non-fatal, and lost entirely if it did not cross.
        "notes": layout.notes(),
        "caveats": [SHEET_FIT_IS_A_DIFFERENT_QUESTION],
    })
    .to_string()
}

/// 🔴 **Does the whole set fit the machine's travel — and if not, what would?**
///
/// The union extent from [`layout_extent`], handed to
/// `core/src/placement.rs::plan_datum_shift`, which owns this question. Nothing
/// is decided here.
///
/// # Reading the answer
///
/// `placement` is a **tagged union on `outcome`**, never a boolean:
///
/// * `already_inside` — `{ extent }`. The program is inside travel as it stands.
///   Nothing is offered because there is nothing to offer.
/// * `shift_datum` — `{ dx_mm, dy_mm, current, shifted }`. A datum shift would
///   put the whole program inside travel. **Offer it; do not apply it** — see
///   [`SHIFT_IS_OFFERED_NEVER_APPLIED`]. Applying it means adding `dx_mm` to the
///   workpiece's `origin_x_mm` and `dy_mm` to its `origin_y_mm`, and that is a
///   decision about the CLAMPS, which no program can see.
/// * `will_not_fit` — `{ current, overhangs }`. One `overhang` per failing axis,
///   naming the axis and by how much, and **carrying no shift at all**. Both
///   axes can fail at once and that is two facts, not one. Do not build a shift
///   out of it — see [`THE_THREE_OUTCOMES_ARE_DIFFERENT_FACTS`].
///
/// `describe` on the placement is the core's own sentence, worded so a refusal
/// names the axis and the overhang rather than saying "it does not fit", which
/// is not something anyone can act on.
///
/// ⚠ Travel, not workpiece. The machine reaching every coordinate and the material
/// being big enough are different questions; this answers the first only.
#[wasm_bindgen]
pub fn plan_placement(
    drawings_json: &str,
    tool_radius_mm: f64,
    margin_mm: f64,
    travel_x_mm: f64,
    travel_y_mm: f64,
) -> String {
    let Some(radius) = tool_radius(tool_radius_mm) else {
        return refused(NO_TOOL_RADIUS);
    };
    let Some(margin) = margin_mm_of(margin_mm) else {
        return refused(NO_MARGIN);
    };
    if !travel_x_mm.is_finite()
        || !travel_y_mm.is_finite()
        || travel_x_mm <= 0.0
        || travel_y_mm <= 0.0
    {
        return refused(NO_TRAVEL);
    }
    let machine = Machine { travel_x_mm, travel_y_mm, ..Machine::default() };

    let layout = match layout_from_json(drawings_json) {
        Ok(l) => l,
        Err(why) => return refused(&why),
    };
    // `None` here is the empty workpiece, and it is the same refusal as
    // `layout_extent`'s: there is no union to place.
    let (Some(extent), Some(placement)) =
        (layout.extent(), layout.plan_placement(radius, margin, &machine))
    else {
        return refused(EMPTY_SHEET);
    };

    let mut p = match serde_json::to_value(&placement) {
        Ok(v) => v,
        Err(e) => {
            return refused(&format!(
                "the placement could not be encoded for the browser ({e}), so the answer cannot be \
                 shown. An answer nobody can see is not a program that fits"
            ))
        }
    };
    if let Some(o) = p.as_object_mut() {
        // Added, not substituted: the numbers are what a UI should lay out, and
        // this is the sentence for when a sentence is wanted.
        o.insert("describe".into(), serde_json::Value::String(placement.describe()));
    }

    serde_json::json!({
        "ok": true,
        "placement": p,
        // The union as DRAWN, with no cutter in it. `placement`'s own `current`
        // is this window grown by the radius; both are here because they answer
        // different questions, and subtracting one from the other in JS would
        // put the cutter rule back in TypeScript.
        "extent": extent_json(&extent),
        "drawings": layout.len(),
        // Echoed so the answer carries what produced it. A placement quoted
        // without its radius and margin is a number with no units of judgement.
        "tool_radius_mm": radius,
        "margin_mm": margin,
        "machine": { "travel_x_mm": travel_x_mm, "travel_y_mm": travel_y_mm },
        "notes": layout.notes(),
        "caveats": [
            SHIFT_IS_OFFERED_NEVER_APPLIED,
            THE_THREE_OUTCOMES_ARE_DIFFERENT_FACTS,
            SHEET_FIT_IS_A_DIFFERENT_QUESTION,
        ],
    })
    .to_string()
}

// ---------------------------------------------------------------------------
//  N drawings, one program — `fixtures::plan_report_import_many`
// ---------------------------------------------------------------------------

/// One drawing on the workpiece, as the browser describes it.
///
/// 🔴 `offset_mm` is a DELTA from where the drawing was drawn, in **workpiece
/// millimetres** — the per-drawing generalisation of the job's `drawing_offset`,
/// in the same frame and with the same meaning. It is NOT the `x_mm`/`y_mm` of
/// [`PlacedDrawingIn`], which `check_layout` takes and which is the ABSOLUTE
/// position of a corner. Zero here means AS DRAWN; zero there means the workpiece
/// corner. Two fields, two questions, and they are deliberately not spelled the
/// same.
#[derive(serde::Deserialize)]
struct ImportDrawingIn {
    id: String,
    /// `"dxf" | "svg" | "stl" | "auto"`. `"auto"` decides by CONTENT.
    format: String,
    /// How many bytes of the concatenated buffer belong to THIS drawing.
    byte_len: usize,
    /// The section Z for a mesh. Absent = nobody chose one, and the core
    /// sections at mid-height and says so. It never silently becomes 0.
    #[serde(default)]
    z_section_mm: Option<f64>,
    #[serde(default)]
    offset_mm: [f64; 2],
    #[serde(default)]
    rotation_deg: f64,
}

/// 🔴 **N drawings, placed, checked against each other, and posted — or
/// refused.**
///
/// # The bytes
///
/// `blobs` is every drawing's file content CONCATENATED, and each descriptor
/// carries its own `byte_len`. The lengths must sum to exactly `blobs.len()`, and
/// a mismatch is **REFUSED** rather than truncated or padded: slicing on from a
/// wrong length hands the parser one file's tail joined to the next file's head,
/// and that composite still parses into *something* — a drawing built from two
/// files, which posts and cuts.
///
/// A concatenated buffer rather than an array of arrays because this boundary
/// takes `&[u8]` and nothing else; an STL is routinely megabytes and must not be
/// base64'd through a JSON string on every re-plan.
///
/// # Reading the answer
///
/// The same [`twobee_cam::fixtures::Report`] every other planning export returns.
/// **`ok: false` means no program**, and `gcode` is empty on every such path —
/// including the overlap refusal, which is the one this export exists for.
/// `refusals` then holds one sentence per condemned pair, naming both parts.
#[wasm_bindgen]
pub fn plan_import_many(
    drawings_json: &str,
    blobs: &[u8],
    config_json: &str,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
    mesh_budget_tris: Option<u32>,
) -> String {
    let described: Vec<ImportDrawingIn> = match serde_json::from_str(drawings_json) {
        Ok(v) => v,
        Err(e) => return err(&format!("the drawing list was rejected: {e}")),
    };
    if described.is_empty() {
        return err(
            "no drawings were given, so there is nothing to cut. An empty workpiece is refused rather \
             than posted as a program with no motion in it",
        );
    }
    let total: usize = described.iter().map(|d| d.byte_len).sum();
    if total != blobs.len() {
        // 🔴 Refused, never salvaged. See the header: a wrong length does not
        // produce a parse error, it produces a different drawing.
        return err(&format!(
            "the drawing lengths sum to {total} bytes and {} were sent — the two must agree \
             EXACTLY. Slicing on regardless would hand the parser one file's tail joined to the \
             next file's head, and that composite parses into a drawing that is not any of the \
             files you loaded",
            blobs.len()
        ));
    }

    let cfg: JobConfig = if config_json.trim().is_empty() {
        JobConfig::default()
    } else {
        match serde_json::from_str(config_json) {
            Ok(c) => c,
            // Reported, never silently replaced with defaults: a fallback would
            // plan a DIFFERENT job than the one that was configured, and it
            // would look like it worked.
            Err(e) => return err(&format!("configuration rejected: {e}")),
        }
    };

    let mut at = 0usize;
    let mut sources: Vec<ImportSource<'_>> = Vec::with_capacity(described.len());
    for d in &described {
        let data = &blobs[at..at + d.byte_len];
        at += d.byte_len;
        sources.push(ImportSource {
            id: d.id.clone(),
            data,
            format: d.format.clone(),
            // A non-finite Z is treated as ABSENT rather than passed through:
            // NaN compares false against every plane test, so it would section
            // nothing and report a mesh that "crossed no geometry" — a true
            // sentence about the wrong cause.
            z_section_mm: d.z_section_mm.filter(|v| v.is_finite()),
            offset_mm: d.offset_mm,
            rotation_deg: d.rotation_deg,
        });
    }

    let cell = if sim_cell_mm > 0.0 { sim_cell_mm } else { 0.6 };
    let r = plan_report_import_many(
        &sources,
        &cfg,
        cell,
        surface_cell(surface_cell_mm),
        mesh_budget(mesh_budget_tris),
    );
    serde_json::to_string(&r).unwrap_or_else(|e| err(&e.to_string()))
}
