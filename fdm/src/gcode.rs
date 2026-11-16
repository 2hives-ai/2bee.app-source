//! Lane 5: `Vec<LayerPlan>` + settings -> a complete, runnable Bambu X2D (Marlin flavour) G-code file.
//!
//! This is a port of the output side of OrcaSlicer 2.5.0-dev's `GCode.cpp` / `GCodeWriter.cpp` for the single
//! extruder, single object, by-layer case:
//!
//! * file layout: HEADER_BLOCK, CONFIG_BLOCK, extrusion-width notes, EXECUTABLE_BLOCK with machine limits
//!   (`M201/M203/M204/M205`), `machine_start_gcode`, `filament_start_gcode`, layers, `machine_end_gcode`, filament
//!   statistics; `M73 P.. R..` progress and the `; model printing time` header come from our own time estimator.
//! * layer: `; CHANGE_LAYER` / `; Z_HEIGHT` / `; LAYER_HEIGHT`, `layer_change_gcode`, first/second-layer accel and
//!   temperature steps, skirt/brim, object labels (`M624/M625`), islands -> walls -> infill -> ironing,
//!   `time_lapse_gcode` at the layer end.
//! * motion: `travel_to` / `needs_retraction` / `retract` (wipe-while-retracting, `retract_before_wipe`) / lazy z-hop with
//!   `Normal`, `Slope` and `Spiral` lift (`G17`+`G3 ... P1`), unretract, seam via `motion::seam`, `seam_gap` clipping.
//! * speeds and accelerations by feature, first-layer overrides, volumetric speed cap, bridge/solid/top rules, the
//!   `M204` clamp to the machine limit, Orca's flow model for `E`, `filament_flow_ratio`, `print_flow_ratio` and the
//!   per-role flow ratios; `CoolingBuffer` slow-down and fan control (`motion::cooling`).
//!
//! INPUT CONTRACT (`LayerPlan` / `ExtPath`, lane types are not changed):
//! * coordinates are absolute bed coordinates in mm; `LayerPlan::z` is the TOP of the layer, `h` its height;
//! * `closed = true` is a loop without a repeated closing vertex (walls: the seam is chosen here, `seam_gap` clipped);
//!   `PathPt::w` is the bead width at that vertex (the width of a segment is the mean of its end vertices);
//! * `ExtPath::flow_ratio` multiplies the geometric cross-section (0.0 is read as 1.0); `speed > 0` overrides the
//!   per-feature speed (it still goes through the first-layer, volumetric and cooling rules);
//! * cross-section = `(w - h(1 - pi/4)) h`; `Bridge` / `InternalBridge` use the round bridging flow `pi/4 w^2` only when
//!   `thick_bridges` / `thick_internal_bridges` is set (then `w` = `layer_h` = bridge diameter). For `Ironing` pass the
//!   width and height Orca derives (`h = ironing_flow * layer_h * spacing/nozzle`), then the rectangle formula applies;
//! * skirt, brim and the object label are produced here: do not pass `Skirt` / `Brim` paths (if present they are printed
//!   as given and no skirt is generated);
//! * optional `GcodeOptions::slices` (Orca's `lslices` per layer) make island grouping, the skirt hull, the
//!   "travel stays inside the infill region" retraction test and the overhang-speed measurement exact; without them the
//!   slices are rebuilt from the outer-wall loops (centre line + half a bead, mitre corners).
//!
//! NOT implemented (each reported in `GcodeOutput::issues` or refused with `FdmError::Unsupported`, never silently
//! approximated): spiral vase (implemented as a G-code text filter, see `spiral_filter`), by-object print sequence (refused), `reduce_crossing_wall` (avoid
//! crossing perimeters), `slowdown_for_curled_perimeters`, pressure-advance tagging, scarf (sloped) seams,
//! `wipe_on_loops` / `wipe_before_external_loop`, `small_area_infill_flow_compensation`, brim ears, multi-material /
//! multi-extruder, the camera/rod `TimelapsePosPicker` (a fixed or caller-given safe position is used), the mesh
//! visibility term of the seam score (see `motion::seam`).

use std::collections::BTreeMap;
use std::fmt::Write as _;

use crate::motion::arcs;
use crate::motion::cooling::CoolingBuffer;
use crate::motion::geo::{self, P2};
use crate::motion::overhang::{self, Boundary, ProcessedPoint};
use crate::motion::plan::{self, Island, Stroke};
use crate::motion::seam::{self, LoopSpec, SeamExtras, SeamParams, SeamPlanner, SeamPosition};
use crate::motion::visibility::{self, Visibility};
use crate::motion::settings::Settings;
use crate::motion::skirt;
use crate::motion::template::{self, Ctx, Extra, V};
use crate::motion::time::{self, TimeEstimate};
use crate::motion::{fmt_axis, fmt_g};
use crate::types::{Feature, FdmError, LayerPlan, Polys};

// Multi-material (lane M4B): the prime tower and the tool-change / filament-change parts of the generator live in their own
// files; they are children of this module so they can use its private writer state.
#[path = "wipe_tower.rs"]
pub mod wipe_tower;
#[path = "gcode_mm.rs"]
mod mm;
pub use mm::{MultiMaterial, ObjectLabel};

const EPS: f64 = 1e-4;

// ---------------------------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------------------------

/// One object of a multi-object plate (see `GcodeOptions::objects`).
#[derive(Clone, Debug)]
pub struct GcodeObject {
    pub name: String,
    pub id: u64,
    /// Orca instance labeled id; the M624 bit is its index in the sorted list of all label ids
    pub label_id: u32,
    /// convex hull of the object in bed coordinates (mm)
    pub footprint: Vec<[f64; 2]>,
    pub filament: usize,
}

#[derive(Clone, Debug)]
pub struct GcodeOptions {
    /// Object name as shown in `; printing object <name> id:<object_id> copy 0`.
    pub object_name: String,
    pub object_id: u32,
    /// `; start printing object, unique label id: N` (Orca: the model instance's labeled id).
    pub label_id: u32,
    pub generator: String,
    /// `generated by ... on <timestamp>` (kept as given so output is reproducible).
    pub timestamp: String,
    /// Timelapse safe position (`U`/`V` of the `M9711` macro). Orca derives it from the camera/rod model
    /// (`TimelapsePosPicker`, not ported); callers can pass the position they want.
    pub timelapse_pos: [f64; 2],
    /// Slices of every layer (what Orca calls `lslices`), index = layer. Used for island grouping, the
    /// skirt/brim outline and "travel inside the infill region" retraction suppression. When absent they are
    /// reconstructed from the outer wall loops.
    pub slices: Option<Vec<Polys>>,
    /// Write the full CONFIG_BLOCK (every setting) into the file, like Orca does for BBL printers.
    pub include_config_block: bool,
    /// The model's triangles for the seam placer's visibility raycast (`SeamPlacer::compute_global_occlusion`).
    /// With it, the visibility term is Orca's own (same sample seed, rays and weights). Without it, a walls-only
    /// occluder is built from the layer slices (statistically equivalent, not sample-identical).
    pub seam_mesh: Option<SeamMesh>,
    /// Multi-object plates: each object's own triangles (bed coordinates), parallel to `objects`. With it the seam visibility is
    /// ray-cast per object like Orca; `seam_mesh` is then ignored for the seam. Empty = the single `seam_mesh`.
    pub seam_objects: Vec<Vec<[[f64; 3]; 3]>>,
    /// Round-trip diagnostics (the plans were rebuilt from an Orca G-code file): start every closed loop at its first
    /// vertex instead of asking the seam placer. Isolates retract / travel decisions from the seam choice. (Infill
    /// orientation is NOT recoverable from a file: it shows the orientation after Orca's own collection reversal.)
    pub roundtrip: bool,
    /// Multi-material: which filament (and object) prints every path, see `MultiMaterial`. `None` = one filament (index 0).
    pub multi: Option<MultiMaterial>,
    /// Several objects on the plate, in PRINT ORDER (by-layer sequence). Empty = the single object of `object_name` / `object_id`
    /// / `label_id` (behaviour unchanged). Islands, brim and support strokes go to the object whose footprint contains (else is
    /// nearest to) their first point; each object gets its own `; printing object` block and M624 bit. (Lane M4A.)
    pub objects: Vec<GcodeObject>,
}

/// Triangles in bed coordinates (z = 0 at the bed), in the file's order, for the seam visibility raycast. The layers
/// may be the mesh rotated about `center` by `rot_deg` (the parity tool's stand-in for Orca's arrange); the placer
/// rotates candidate points back into the mesh frame.
#[derive(Clone, Debug)]
pub struct SeamMesh {
    pub tris: Vec<[[f64; 3]; 3]>,
    pub rot_deg: f64,
    pub center: [f64; 2],
}

impl Default for GcodeOptions {
    fn default() -> Self {
        GcodeOptions {
            object_name: "model.stl".into(),
            object_id: 0,
            label_id: 14,
            generator: "twobee-fdm 0.1.0 (OrcaSlicer 2.5.0-dev X2D profile)".into(),
            timestamp: "1970-01-01 at 00:00:00".into(),
            timelapse_pos: [191.0, 130.0],
            slices: None,
            include_config_block: true,
            seam_mesh: None,
            seam_objects: Vec::new(),
            roundtrip: false,
            objects: Vec::new(),
            multi: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GcodeStats {
    pub layers: usize,
    /// Net filament length pushed through the extruder (retractions cancel), mm.
    pub filament_mm: f64,
    pub filament_cm3: f64,
    pub filament_g: f64,
    pub filament_cost: f64,
    /// Number of retraction moves (`G1 E-...`, including the retract-while-wiping ones) and their total length.
    pub retractions: usize,
    pub retracted_mm: f64,
    pub z_hops: usize,
    /// Number of `G2/G3` arc moves written.
    pub arcs: usize,
    pub travel_moves: usize,
    pub travel_mm: f64,
    /// Printed length by feature name (mm of path).
    pub path_mm_by_feature: BTreeMap<String, f64>,
    /// Per-layer retraction counts.
    pub retractions_per_layer: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct GcodeOutput {
    pub gcode: String,
    pub time: TimeEstimate,
    pub stats: GcodeStats,
    /// Template expansion problems, unsupported-setting notices and approximations. Empty means none.
    pub issues: Vec<String>,
}

/// Convenience: settings + plans -> G-code text.
pub fn to_gcode(plans: &[LayerPlan], cfg: &Settings) -> Result<String, FdmError> {
    Ok(generate(plans, cfg, &GcodeOptions::default())?.gcode)
}

pub fn generate(plans: &[LayerPlan], cfg: &Settings, opts: &GcodeOptions) -> Result<GcodeOutput, FdmError> {
    // Orca skips layers that have nothing to extrude (no CHANGE_LAYER, no layer number)
    let keep: Vec<usize> = plans.iter().enumerate().filter(|(_, p)| p.paths.iter().any(|q| q.pts.len() >= 2)).map(|(i, _)| i).collect();
    let kept: Vec<LayerPlan> = keep.iter().map(|&i| plans[i].clone()).collect();
    if kept.is_empty() { return Err(FdmError::Geometry("no layers to export (every LayerPlan is empty)".into())); }
    // multi-material: align the side table with the kept layers; a print that uses ONE filament (any index) is a plain
    // single-filament print on that filament's settings
    let prep = mm::prepare_options(cfg, opts, &keep, &kept)?;
    let (cfg_ref, opts_ref, init_f): (&Settings, &GcodeOptions, usize) = match &prep {
        Some(p) => (p.settings.as_ref().unwrap_or(cfg), &p.opts, p.initial_filament),
        None => (cfg, opts, 0),
    };
    let mut g = Gen::new(cfg_ref, opts_ref, &kept);
    g.initial_filament = init_f;
    if kept.len() != plans.len() { g.issue(format!("{} empty LayerPlan(s) were skipped like Orca skips layers with nothing to extrude", plans.len() - kept.len())); }
    g.run(&kept)
}

// ---------------------------------------------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lift { Normal, Slope, Spiral }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ZHopKind { Auto, Normal, Slope, Spiral }

#[derive(Clone)]
struct Params {
    comments: bool,
    relative_e: bool,
    flavor: String,
    nozzle: f64,
    fil_d: f64,
    fil_density: f64,
    fil_cost: f64,
    flow_ratio: f64,
    print_flow_ratio: f64,
    e_per_mm3: f64,
    retract_len: f64,
    retract_speed: f64,
    deretract_speed: f64,
    restart_extra: f64,
    retract_before_wipe: f64,
    retract_after_wipe: f64,
    min_travel: f64,
    retract_when_changing_layer: bool,
    lift_above: f64,
    lift_below: f64,
    lift_enforce: String,
    z_hop: f64,
    z_hop_kind: ZHopKind,
    travel_slope: f64, // radians
    wipe: bool,
    wipe_distance: f64,
    role_based_wipe_speed: bool,
    wipe_speed_cfg: f64,
    travel_speed: f64,
    travel_speed_z: f64,
    initial_travel_speed: f64,
    default_accel: f64,
    initial_accel: f64,
    travel_accel: f64,
    initial_travel_accel: f64,
    outer_accel: f64,
    inner_accel: f64,
    top_accel: f64,
    sparse_accel: f64,
    solid_accel: f64,
    bridge_accel: f64,
    default_jerk: f64,
    initial_jerk: f64,
    outer_jerk: f64,
    inner_jerk: f64,
    top_jerk: f64,
    infill_jerk: f64,
    travel_jerk: f64,
    initial_travel_jerk: f64,
    is_bbl: bool,
    max_accel: f64, // machine_max_acceleration_extruding (0 = unlimited)
    outer_speed: f64,
    inner_speed: f64,
    bridge_speed: f64,
    internal_bridge_speed: f64,
    sparse_speed: f64,
    solid_speed: f64,
    top_speed: f64,
    gap_speed: f64,
    support_speed: f64,
    support_interface_speed: f64,
    ironing_speed: f64,
    initial_layer_speed: f64,
    initial_layer_infill_speed: f64,
    skirt_speed: f64,
    slow_down_layers: i64,
    max_vol_speed: f64,
    seam_gap: f64,
    small_perimeter_length: f64,
    small_perimeter_speed: f64,
    top_flow: f64,
    bottom_flow: f64,
    internal_bridge_flow: f64,
    brim_flow: f64,
    set_other_flow_ratios: bool,
    first_layer_flow_ratio: f64,
    outer_flow: f64,
    inner_flow: f64,
    overhang_flow: f64,
    sparse_flow: f64,
    solid_flow: f64,
    gap_flow: f64,
    support_flow: f64,
    support_interface_flow: f64,
    is_infill_first: bool,
    reduce_infill_retraction: bool,
    sparse_density: f64,
    gcode_label_objects: bool,
    layer_height: f64,
    initial_layer_height: f64,
    printable_area: Vec<P2>,
    arc_fitting: bool,
    resolution: f64,
    bed_temp_first: i64,
    bed_temp: i64,
    nozzle_temp_first: i64,
    nozzle_temp: i64,
    skirt_height: usize,
    skirt_start_angle: f64,
    emit_machine_limits: bool,
}

fn f_over(s: &Settings, pk: &str, fk: &str) -> Option<String> {
    // filament override (non-nil value present in the CONFIG_BLOCK) wins over the printer-level setting
    if s.has(fk) && s.raw(fk) != Some("nil") && !s.raw(fk).unwrap_or("").is_empty() { Some(fk.to_string()) } else if s.has(pk) { Some(pk.to_string()) } else { None }
}
fn num_o(s: &Settings, pk: &str, fk: &str) -> f64 { f_over(s, pk, fk).map(|k| s.num(&k)).unwrap_or(0.0) }
fn text_o(s: &Settings, pk: &str, fk: &str) -> String { f_over(s, pk, fk).map(|k| s.text(&k)).unwrap_or_default() }

/// 🔴 `elements()` returns a points option as ONE element (`0x0,256x0,256x256,0x256`), and this used to split_once
/// that whole string on 'x': "0" and "0,256x0,..." parse to nothing, so the bed was ALWAYS empty (found 2026-11-14).
/// Every bed check here then passed by not running: `spiral_fits` lifted in a spiral at the plate edge, and the
/// skirt/brim bed check never fired. The points are split on ',' first.
fn parse_bed(s: &Settings) -> Vec<P2> {
    let mut v = Vec::new();
    for e in s.elements("printable_area").iter().flat_map(|e| e.split(',').map(str::trim).collect::<Vec<_>>()) {
        if let Some((x, y)) = e.split_once('x') {
            if let (Ok(x), Ok(y)) = (x.parse::<f64>(), y.parse::<f64>()) { v.push([x, y]); }
        }
    }
    v
}

impl Params {
    fn new(s: &Settings) -> Params {
        let nozzle = s.num_or("nozzle_diameter", 0.4);
        let fil_d = s.num_or("filament_diameter", 1.75);
        let area = std::f64::consts::PI * fil_d * fil_d / 4.0;
        let flow_ratio = s.num_or("filament_flow_ratio", 1.0);
        let default_accel = s.num("default_acceleration");
        let outer_accel = s.num("outer_wall_acceleration");
        let travel_accel = s.num("travel_acceleration");
        let z_hop_kind = match text_o(s, "z_hop_types", "filament_z_hop_types").as_str() {
            "Auto Lift" => ZHopKind::Auto, "Normal Lift" => ZHopKind::Normal, "Slope Lift" => ZHopKind::Slope, "Spiral Lift" => ZHopKind::Spiral,
            _ => ZHopKind::Normal,
        };
        let bridge_speed = s.num("bridge_speed");
        let retract_before = {
            let v = num_o(s, "retract_before_wipe", "filament_retract_before_wipe") * 0.01;
            v.clamp(0.0, 1.0)
        };
        let retract_after = { let v = num_o(s, "retract_after_wipe", "filament_retract_after_wipe") * 0.01; v.clamp(0.0, 1.0).min(1.0 - retract_before) };
        let outer_speed = s.num("outer_wall_speed");
        let small_len = s.num("small_perimeter_threshold");
        Params {
            comments: s.flag("gcode_comments"),
            relative_e: s.flag("use_relative_e_distances") || !s.has("use_relative_e_distances"),
            flavor: if s.has("gcode_flavor") { s.text("gcode_flavor") } else { "marlin".into() },
            nozzle, fil_d,
            fil_density: s.num_or("filament_density", 1.24),
            fil_cost: s.num_or("filament_cost", 0.0),
            flow_ratio,
            print_flow_ratio: s.num_or("print_flow_ratio", 1.0),
            e_per_mm3: flow_ratio / area,
            retract_len: num_o(s, "retraction_length", "filament_retraction_length"),
            retract_speed: num_o(s, "retraction_speed", "filament_retraction_speed").round(),
            deretract_speed: { let d = num_o(s, "deretraction_speed", "filament_deretraction_speed").round(); if d > 0.0 { d } else { num_o(s, "retraction_speed", "filament_retraction_speed").round() } },
            restart_extra: num_o(s, "retract_restart_extra", "filament_retract_restart_extra"),
            retract_before_wipe: retract_before,
            retract_after_wipe: retract_after,
            min_travel: num_o(s, "retraction_minimum_travel", "filament_retraction_minimum_travel"),
            retract_when_changing_layer: f_over(s, "retract_when_changing_layer", "filament_retract_when_changing_layer").map(|k| s.flag(&k)).unwrap_or(false),
            lift_above: num_o(s, "retract_lift_above", "filament_retract_lift_above"),
            lift_below: num_o(s, "retract_lift_below", "filament_retract_lift_below"),
            lift_enforce: text_o(s, "retract_lift_enforce", "filament_retract_lift_enforce"),
            z_hop: num_o(s, "z_hop", "filament_z_hop"),
            z_hop_kind,
            travel_slope: s.num("travel_slope") * std::f64::consts::PI / 180.0,
            wipe: f_over(s, "wipe", "filament_wipe").map(|k| s.flag(&k)).unwrap_or(false),
            wipe_distance: num_o(s, "wipe_distance", "filament_wipe_distance"),
            role_based_wipe_speed: s.flag("role_based_wipe_speed"),
            wipe_speed_cfg: s.abs("wipe_speed", s.num("travel_speed")),
            travel_speed: s.num("travel_speed"),
            travel_speed_z: s.num("travel_speed_z"),
            initial_travel_speed: s.abs("initial_layer_travel_speed", s.num("travel_speed")),
            default_accel,
            initial_accel: s.num("initial_layer_acceleration"),
            travel_accel,
            initial_travel_accel: s.abs("initial_layer_travel_acceleration", travel_accel),
            outer_accel,
            inner_accel: s.num("inner_wall_acceleration"),
            top_accel: s.num("top_surface_acceleration"),
            sparse_accel: s.abs("sparse_infill_acceleration", default_accel),
            solid_accel: s.abs("internal_solid_infill_acceleration", default_accel),
            bridge_accel: s.abs("bridge_acceleration", outer_accel),
            default_jerk: s.num("default_jerk"),
            initial_jerk: s.num("initial_layer_jerk"),
            outer_jerk: s.num("outer_wall_jerk"),
            inner_jerk: s.num("inner_wall_jerk"),
            top_jerk: s.num("top_surface_jerk"),
            infill_jerk: s.num("infill_jerk"),
            travel_jerk: s.num("travel_jerk"),
            initial_travel_jerk: s.abs("initial_layer_travel_jerk", s.num("travel_jerk")),
            is_bbl: s.text("printer_model").starts_with("Bambu"),
            max_accel: s.machine_limit("machine_max_acceleration_extruding"),
            outer_speed,
            inner_speed: s.num("inner_wall_speed"),
            bridge_speed,
            internal_bridge_speed: s.abs("internal_bridge_speed", bridge_speed),
            sparse_speed: s.num("sparse_infill_speed"),
            solid_speed: s.num("internal_solid_infill_speed"),
            top_speed: s.num("top_surface_speed"),
            gap_speed: s.num("gap_infill_speed"),
            support_speed: s.num("support_speed"),
            support_interface_speed: s.num("support_interface_speed"),
            ironing_speed: s.num("ironing_speed"),
            initial_layer_speed: s.num("initial_layer_speed"),
            initial_layer_infill_speed: s.num("initial_layer_infill_speed"),
            skirt_speed: s.num("skirt_speed"),
            slow_down_layers: s.int("slow_down_layers"),
            max_vol_speed: s.num("filament_max_volumetric_speed"),
            seam_gap: s.abs("seam_gap", nozzle),
            small_perimeter_length: small_len * 2.0 * std::f64::consts::PI,
            small_perimeter_speed: s.abs("small_perimeter_speed", outer_speed),
            top_flow: s.num_or("top_solid_infill_flow_ratio", 1.0),
            bottom_flow: s.num_or("bottom_solid_infill_flow_ratio", 1.0),
            internal_bridge_flow: s.num_or("internal_bridge_flow", 1.0),
            brim_flow: s.num_or("brim_flow_ratio", 1.0),
            set_other_flow_ratios: s.flag("set_other_flow_ratios"),
            first_layer_flow_ratio: s.num_or("first_layer_flow_ratio", 1.0),
            outer_flow: s.num_or("outer_wall_flow_ratio", 1.0),
            inner_flow: s.num_or("inner_wall_flow_ratio", 1.0),
            overhang_flow: s.num_or("overhang_flow_ratio", 1.0),
            sparse_flow: s.num_or("sparse_infill_flow_ratio", 1.0),
            solid_flow: s.num_or("internal_solid_infill_flow_ratio", 1.0),
            gap_flow: s.num_or("gap_fill_flow_ratio", 1.0),
            support_flow: s.num_or("support_flow_ratio", 1.0),
            support_interface_flow: s.num_or("support_interface_flow_ratio", 1.0),
            is_infill_first: s.flag("is_infill_first"),
            reduce_infill_retraction: s.flag("reduce_infill_retraction"),
            sparse_density: s.abs("sparse_infill_density", 100.0),
            gcode_label_objects: s.flag("gcode_label_objects"),
            layer_height: s.num_or("layer_height", 0.2),
            initial_layer_height: s.num_or("initial_layer_print_height", s.num_or("layer_height", 0.2)),
            printable_area: parse_bed(s),
            arc_fitting: s.flag("enable_arc_fitting"),
            resolution: s.num_or("resolution", 0.012),
            bed_temp_first: 0, bed_temp: 0, nozzle_temp_first: s.int("nozzle_temperature_initial_layer"), nozzle_temp: s.int("nozzle_temperature"),
            skirt_height: s.int("skirt_height").max(0) as usize,
            skirt_start_angle: s.num_or("skirt_start_angle", -135.0),
            emit_machine_limits: s.flag("emit_machine_limits_to_gcode"),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------------------------------------------

struct Gen<'a> {
    s: &'a Settings,
    o: &'a GcodeOptions,
    p: Params,
    issues: Vec<String>,
    tpl_ctx_globals: BTreeMap<String, V>,

    // writer state
    out: String, // current chunk (layer or preamble)
    pos: [f64; 3],
    pos_clear: bool,
    lifted: f64,
    to_lift: f64,
    to_lift_type: Lift,
    is_first_layer: bool,
    cur_speed: f64,
    last_acc: u32,
    last_jerk: f64,
    retracted: f64,
    restart_extra: f64,
    absolute_e: f64,
    obj_start: String,
    obj_end: String,
    last_bed_temp: i64,

    // generator state
    last_pos: P2,
    last_pos_defined: bool,
    nominal_z: f64,
    need_change_layer_lift_z: bool,
    layer_index: i64,
    last_height: f32,
    last_layer_z: f32,
    max_layer_z: f64,
    last_width: f64,
    last_h_tag: f64,
    last_proc_role: Option<Feature>,
    last_role: Option<Feature>,
    last_notgap_role: Option<Feature>,
    wipe_path: Vec<P2>,
    wipe_enable: bool,
    second_layer_done: bool,
    cur_layer: usize,
    /// this layer is printed as a spiral vase layer (Orca: no seam placement, no loop clipping)
    spiral_layer: bool,
    layer_slices: Vec<Polys>,
    sup_strokes: Vec<Vec<Stroke>>, 
    cur_internal: Polys,

    // statistics
    st: GcodeStats,
    layer_retracts: usize,
    seam: Option<SeamPlanner>,
    layer_z: Vec<f64>,
    layer_h: Vec<f64>,
    fan_state: [(bool, i64); 4],
    prev_boundary: Option<Boundary>,
    /// multi-material state (filaments, tower, tool order); `None` for a one-filament print
    mm: Option<mm::MmCtx>,
    /// the one filament used when `GcodeOptions::multi` names a single filament other than 0
    initial_filament: usize,
}

impl<'a> Gen<'a> {
    fn new(s: &'a Settings, o: &'a GcodeOptions, _plans: &[LayerPlan]) -> Gen<'a> {
        let mut p = Params::new(s);
        // bed temperature of the active plate type, like GCode::get_bed_temperature
        let bt = s.text("curr_bed_type");
        let (k1, k2) = bed_temp_keys(&bt);
        p.bed_temp_first = s.int(k1);
        p.bed_temp = s.int(k2);
        let wipe_enable = p.wipe;
        Gen {
            s, o, p, issues: Vec::new(), tpl_ctx_globals: BTreeMap::new(),
            out: String::new(), pos: [0.0; 3], pos_clear: false, lifted: 0.0, to_lift: 0.0, to_lift_type: Lift::Normal, is_first_layer: false,
            cur_speed: 0.0, last_acc: 0, last_jerk: 0.0, retracted: 0.0, restart_extra: 0.0, absolute_e: 0.0,
            obj_start: String::new(), obj_end: String::new(), last_bed_temp: i64::MIN,
            last_pos: [0.0, 0.0], last_pos_defined: false, nominal_z: 0.0, need_change_layer_lift_z: false, layer_index: -1,
            last_height: 0.0, last_layer_z: 0.0, max_layer_z: 0.0, last_width: 0.0, last_h_tag: 0.0,
            last_proc_role: None, last_role: None, last_notgap_role: None, wipe_path: Vec::new(), wipe_enable,
            second_layer_done: false, cur_layer: 0, spiral_layer: false, layer_slices: Vec::new(), sup_strokes: Vec::new(), cur_internal: Vec::new(),
            st: GcodeStats::default(), layer_retracts: 0, seam: None, layer_z: Vec::new(), layer_h: Vec::new(), fan_state: [(false, -1); 4], prev_boundary: None, mm: None, initial_filament: 0,
        }
    }

    fn issue(&mut self, m: impl Into<String>) {
        let m = m.into();
        if !self.issues.contains(&m) { self.issues.push(m); }
    }

    // ---- low level writer ---------------------------------------------------------------------------------------

    fn comment(&self, c: &str) -> String { if self.p.comments && !c.is_empty() { format!(" ; {}", c) } else { String::new() } }

    fn g1(&mut self, parts: &[(char, f64, usize)], comment: &str) {
        let mut l = String::from("G1");
        for (c, v, d) in parts { let _ = write!(l, " {}{}", c, fmt_axis(*v, *d)); }
        l.push_str(&self.comment(comment));
        l.push('\n');
        self.out.push_str(&l);
    }

    /// `set_print_acceleration` / `set_travel_acceleration` (marlin legacy: one shared M204 S, clamped for print only).
    fn set_accel(&mut self, accel: u32, travel: bool) {
        let mut a = accel;
        if !travel && self.p.max_accel > 0.0 && (a as f64) > self.p.max_accel.round() { a = self.p.max_accel.round() as u32; }
        if a == 0 || a == self.last_acc { return; }
        self.last_acc = a;
        let _ = write!(self.out, "M204 S{}{}\n", a, self.comment("adjust acceleration"));
    }

    fn set_jerk(&mut self, jerk: f64) {
        if jerk < 0.01 || (jerk - self.last_jerk).abs() < 1e-9 { return; }
        self.last_jerk = jerk;
        let (mx, my) = (self.s.machine_limit("machine_max_jerk_x"), self.s.machine_limit("machine_max_jerk_y"));
        let jx = if mx > 0.0 { jerk.min(mx) } else { jerk };
        let jy = if my > 0.0 { jerk.min(my) } else { jerk };
        let mut l = format!("M205 X{} Y{}", fmt_g(jx), fmt_g(jy));
        if self.p.is_bbl { l.push_str(&format!(" Z{} E{}", fmt_g_prec(self.s.machine_limit("machine_max_jerk_z"), 2), fmt_g_prec(self.s.machine_limit("machine_max_jerk_e"), 2))); }
        l.push_str(&self.comment("adjust jerk"));
        l.push('\n');
        self.out.push_str(&l);
    }

    fn set_speed(&mut self, f: f64, marker: &str) {
        self.cur_speed = f;
        let mut l = format!("G1 F{}", fmt_axis(f, 3));
        l.push_str(&self.comment(""));
        l.push_str(marker);
        l.push('\n');
        self.out.push_str(&l);
    }

    fn travel_speed_now(&self) -> f64 { if self.is_first_layer { self.p.initial_travel_speed } else { self.p.travel_speed } }

    fn will_move_z(&self, z: f64) -> bool {
        if self.lifted > 0.0 {
            let nominal = self.pos[2] - self.lifted;
            if z >= nominal && z <= self.pos[2] { return false; }
        } else if (self.pos[2] - z).abs() < EPS { return false; }
        true
    }

    fn z_move_speed(&self) -> f64 {
        if self.p.travel_speed_z > 0.0 { self.p.travel_speed_z } else { self.travel_speed_now() }
    }

    fn travel_z_raw(&mut self, z: f64, comment: &str) {
        self.pos[2] = z;
        let sp = self.z_move_speed();
        self.g1(&[('Z', z, 3), ('F', sp * 60.0, 3)], comment);
    }

    fn travel_to_z(&mut self, z: f64, comment: &str, force: bool) {
        if !force && !self.will_move_z(z) {
            let nominal = self.pos[2] - self.lifted;
            self.lifted -= z - nominal;
            if self.lifted.abs() < EPS { self.lifted = 0.0; }
            return;
        }
        self.lifted = 0.0;
        self.travel_z_raw(z, comment);
    }

    fn spiral_fits(&self, center: P2, radius: f64) -> bool {
        if self.p.printable_area.len() < 3 { return true; }
        let mut poly = self.p.printable_area.clone();
        if geo::signed_area(&poly) < 0.0 { poly.reverse(); }
        if !geo::in_ring(center, &poly) { return false; }
        let n = poly.len();
        for i in 0..n {
            let (a, b) = (poly[i], poly[(i + 1) % n]);
            let ab = geo::sub(b, a);
            let l2 = geo::dot(ab, ab);
            let t = if l2 < 1e-18 { 0.0 } else { (geo::dot(geo::sub(center, a), ab) / l2).clamp(0.0, 1.0) };
            if geo::dist(center, geo::lerp(a, b, t)) < radius { return false; }
        }
        true
    }

    fn spiral_travel_to_z(&mut self, z: f64, ij: P2, comment: &str) {
        let sp = self.z_move_speed();
        if !self.p.arc_fitting {
            let z0 = self.pos[2];
            let (px, py) = (self.pos[0], self.pos[1]);
            let (cx, cy) = (px + ij[0], py + ij[1]);
            let radius = geo::norm(ij);
            let dev = self.p.resolution.max(1e-6);
            let steps = ((std::f64::consts::PI / (1.0 - (dev / radius).min(1.0)).acos()).ceil() as usize).clamp(8, 128);
            self.g1(&[('F', sp * 60.0, 3)], comment);
            let a0 = (py - cy).atan2(px - cx);
            for i in 1..steps {
                let t = i as f64 / steps as f64;
                let a = a0 + 2.0 * std::f64::consts::PI * t;
                self.g1(&[('X', cx + radius * a.cos(), 3), ('Y', cy + radius * a.sin(), 3), ('Z', z0 + (z - z0) * t, 3)], "");
            }
            self.g1(&[('X', px, 3), ('Y', py, 3), ('Z', z, 3)], "");
        } else {
            let _ = write!(self.out, "G17{}\n", if self.p.comments { " ; XY plane for arc" } else { "" });
            let _ = write!(self.out, "G3 Z{} I{} J{} P1  F{}{}\n", fmt_axis(z, 3), fmt_axis(ij[0], 3), fmt_axis(ij[1], 3), fmt_axis(sp * 60.0, 3), self.comment(comment));
        }
        self.pos[2] = z;
    }

    /// `GCodeWriter::travel_to_xyz`
    fn travel_to_xyz(&mut self, p: [f64; 3], force_z: bool) {
        let mut dest = p;
        let ts = self.travel_speed_now();
        if self.to_lift.abs() > EPS {
            if (!self.pos_clear || self.pos != dest) && self.to_lift + self.pos[2] > p[2] {
                self.lifted = self.to_lift + self.pos[2] - p[2];
                dest[2] = self.to_lift + self.pos[2];
            }
            self.to_lift = 0.0;
            let source = self.pos;
            let target = dest;
            let delta = [target[0] - source[0], target[1] - source[1], target[2] - source[2]];
            let dxy = [delta[0], delta[1]];
            let dxy_n = geo::norm(dxy);
            if delta[2] > 0.0 && dxy_n != 0.0 {
                if self.to_lift_type == Lift::Spiral && self.pos_clear && self.p.travel_slope > 1e-6 {
                    let radius = delta[2] / (2.0 * std::f64::consts::PI * self.p.travel_slope.atan());
                    let u = geo::scale(dxy, 1.0 / dxy_n);
                    let ij = [-u[1] * radius, u[0] * radius];
                    let centre = [source[0] + ij[0], source[1] + ij[1]];
                    if self.spiral_fits(centre, radius) { self.spiral_travel_to_z(target[2], ij, "spiral lift Z"); }
                    else { self.travel_z_raw(target[2], "normal lift Z"); }
                } else if self.to_lift_type == Lift::Slope && self.pos_clear && self.p.travel_slope > 1e-6 && delta[2].atan2(dxy_n) < self.p.travel_slope {
                    let t = geo::scale(dxy, 1.0 / dxy_n);
                    let k = delta[2] / self.p.travel_slope.tan();
                    let top = [source[0] + t[0] * k, source[1] + t[1] * k, source[2] + delta[2]];
                    self.g1(&[('X', top[0], 3), ('Y', top[1], 3), ('Z', top[2], 3), ('F', ts * 60.0, 3)], "");
                } else if self.to_lift_type == Lift::Normal || self.p.travel_slope <= 1e-6 {
                    self.travel_z_raw(target[2], "normal lift Z");
                }
            }
            if self.pos_clear {
                self.g1(&[('X', target[0], 3), ('Y', target[1], 3), ('Z', target[2], 3), ('F', ts * 60.0, 3)], "");
            } else {
                self.g1(&[('X', target[0], 3), ('Y', target[1], 3), ('F', ts * 60.0, 3)], "");
                self.travel_z_raw(target[2], "");
            }
            self.pos = dest;
            self.pos_clear = true;
            return;
        } else if !force_z && !self.will_move_z(p[2]) {
            let nominal = self.pos[2] - self.lifted;
            self.lifted -= p[2] - nominal;
            if self.lifted.abs() < EPS { self.lifted = 0.0; }
            self.pos_clear = true;
            self.travel_to_xy([p[0], p[1]]);
            return;
        } else {
            self.lifted = 0.0;
        }
        if !self.pos_clear {
            self.g1(&[('X', dest[0], 3), ('Y', dest[1], 3), ('F', self.p.travel_speed * 60.0, 3)], "");
            self.travel_z_raw(dest[2], "");
        } else {
            self.g1(&[('X', dest[0], 3), ('Y', dest[1], 3), ('Z', dest[2], 3), ('F', self.p.travel_speed * 60.0, 3)], "");
        }
        self.pos = dest;
        self.pos_clear = true;
    }

    fn travel_to_xy(&mut self, p: P2) {
        self.pos[0] = p[0]; self.pos[1] = p[1];
        self.pos_clear = true;
        let ts = self.travel_speed_now();
        self.g1(&[('X', p[0], 3), ('Y', p[1], 3), ('F', ts * 60.0, 3)], "");
    }

    fn unlift(&mut self) {
        if self.lifted > 0.0 {
            let z = self.pos[2] - self.lifted;
            self.travel_z_raw(z, "restore layer Z");
            self.lifted = 0.0;
        }
        self.to_lift = 0.0;
    }

    /// `Extruder::retract` + `GCodeWriter::_retract`. Returns the E written (0 if nothing).
    fn writer_retract(&mut self, length: f64, restart_extra: f64) {
        let to_retract = (length - self.retracted).max(0.0);
        // Orca Extruder::retract sets m_restart_extra INSIDE `if (to_retract > 0)`. It was set unconditionally here
        // (to 2026-11-14), so a full retract after a wipe that had already retracted everything replaced the wipe's
        // `retract_before_wipe x restart_extra` with the whole restart_extra, and the unretract pushed more filament
        // than Orca's. Only visible with a non-zero retract_restart_extra (the X2D presets carry 0).
        if to_retract > 0.0 {
            self.restart_extra = restart_extra;
            self.absolute_e -= to_retract;
            self.retracted += to_retract;
            let sp = self.p.retract_speed * 60.0;
            self.g1(&[('E', -to_retract, 5), ('F', sp, 3)], "retract");
            self.st.retractions += 1;
            self.st.retracted_mm += to_retract;
            self.layer_retracts += 1;
        }
    }

    fn writer_unretract(&mut self) {
        let d_e = self.retracted + self.restart_extra;
        if d_e.abs() > 1e-9 {
            self.absolute_e += d_e;
            self.retracted = 0.0;
            self.restart_extra = 0.0;
            let sp = self.p.deretract_speed * 60.0;
            self.g1(&[('E', d_e, 5), ('F', sp, 3)], " ; unretract");
        } else {
            self.retracted = 0.0;
            self.restart_extra = 0.0;
        }
    }

    fn gen_unretract(&mut self) { self.unlift(); self.writer_unretract(); }

    fn lazy_lift(&mut self, lift: Lift) {
        let mut target = 0.0;
        if self.pos[2] >= self.p.lift_above && (self.pos[2] <= self.p.lift_below || self.p.lift_below == 0.0) { target = self.p.z_hop; }
        if self.lifted == 0.0 && self.to_lift == 0.0 && target > 0.0 {
            self.to_lift = target;
            self.to_lift_type = lift;
            self.st.z_hops += 1;
        }
    }

    fn eager_lift(&mut self, lift: Lift) {
        let mut target = 0.0;
        if self.pos[2] >= self.p.lift_above && (self.pos[2] <= self.p.lift_below || self.p.lift_below == 0.0) { target = self.p.z_hop; }
        if lift == Lift::Spiral && self.pos_clear && self.p.travel_slope > 1e-6 {
            let radius = target / (2.0 * std::f64::consts::PI * self.p.travel_slope.atan());
            let ij = [radius, 0.0];
            let c = [self.pos[0] + ij[0], self.pos[1] + ij[1]];
            if target > 0.0 && self.spiral_fits(c, radius) { self.spiral_travel_to_z(self.pos[2] + target, ij, "spiral lift Z"); }
            else if target > 0.0 { self.travel_z_raw(self.pos[2] + target, "normal lift Z"); }
        } else if target > 0.0 {
            self.travel_z_raw(self.pos[2] + target, "normal lift Z");
        }
        self.lifted = target;
        self.to_lift = 0.0;
    }

    /// `_encode_label_ids_to_base64` for one id: bit = index in the sorted list of all label ids.
    fn label_mask(&self, id: u32) -> String {
        let mut ids: Vec<u32> = self.o.objects.iter().map(|o| o.label_id).collect();
        ids.sort();
        let bit = ids.iter().position(|&x| x == id).unwrap_or(0);
        b64(&(1u64 << bit).to_le_bytes())
    }

    fn add_object_labels(&mut self) {
        if !self.obj_end.is_empty() {
            let e = std::mem::take(&mut self.obj_end);
            self.out.push_str(&e);
        }
        if !self.obj_start.is_empty() {
            let b = std::mem::take(&mut self.obj_start);
            self.out.push_str(&b);
        }
    }

    // ---- Orca GCode:: logic -------------------------------------------------------------------------------------

    fn on_first_layer(&self) -> bool { self.is_first_layer }

    fn is_perimeter_role(f: Feature) -> bool { plan::is_wall(f) }

    fn lift_type_for(&self) -> Lift {
        match self.p.z_hop_kind {
            ZHopKind::Auto => Lift::Slope, // through-overhang test not available; Orca picks Spiral only over overhangs
            ZHopKind::Normal => Lift::Normal,
            ZHopKind::Slope => Lift::Slope,
            ZHopKind::Spiral => Lift::Spiral,
        }
    }

    /// `RetractWhenCrossingPerimeters::travel_inside_internal_regions`: the straight travel lies entirely inside ONE
    /// island of the layer's `stInternal` slices (the slice minus its top and bottom surfaces).
    fn travel_inside_internal_regions(&self, a: P2, b: P2) -> bool {
        self.cur_internal.iter().any(|p| geo::seg_inside_poly(a, b, p))
    }

    /// The `stInternal` part of layer `li`'s slices (`PrintObject::detect_surfaces_type`): top surfaces are the slice
    /// minus the layer above, bottom surfaces the slice minus the layer below (the first layer is all bottom, the last
    /// all top), both opened by a tenth of the external perimeter width to drop slivers.
    fn internal_slices(&self, li: usize) -> Polys {
        let n = self.layer_slices.len();
        if li == 0 || li + 1 >= n { return Vec::new(); }
        let s = &self.layer_slices[li];
        if s.is_empty() { return Vec::new(); }
        let w = { let a = self.s.abs("outer_wall_line_width", self.p.nozzle); if a > 0.0 { a } else { self.p.nozzle } };
        let d = w / 10.0;
        let open = |ps: Polys| -> Polys {
            if ps.is_empty() { return ps; }
            let shrunk = geo::offset_polys(&ps, -d, 0.005);
            if shrunk.is_empty() { return Vec::new(); }
            geo::offset_polys(&shrunk, d, 0.005)
        };
        let top = open(crate::geom::diff(s, &self.layer_slices[li + 1]));
        let bottom = open(crate::geom::diff(s, &self.layer_slices[li - 1]));
        let mut internal = crate::geom::diff(s, &top);
        internal = crate::geom::diff(&internal, &bottom);
        internal
    }

    fn needs_retraction(&self, from: P2, to: P2, role: Feature, lift: &mut Lift) -> bool {
        if geo::dist(from, to) < self.p.min_travel { return false; }
        if let Some(r) = self.last_proc_role {
            if Self::is_perimeter_role(r) && r != Feature::InnerWall {
                *lift = self.lift_type_for();
                return true;
            }
        }
        if !Self::is_perimeter_role(role) && self.p.reduce_infill_retraction && self.p.sparse_density > 0.0 && self.travel_inside_internal_regions(from, to) {
            return false;
        }
        *lift = self.lift_type_for();
        true
    }

    fn wipe_retraction_lengths(&self) -> (f64, f64, f64) {
        let remaining0 = self.p.retract_len;
        if remaining0 <= EPS { return (0.0, 0.0, 0.0); }
        let before = remaining0 * self.p.retract_before_wipe;
        let after = remaining0 * self.p.retract_after_wipe;
        let remaining = remaining0 - (before + after);
        if remaining <= EPS { return (before, 0.0, after); }
        let wipe_speed = if self.p.role_based_wipe_speed { self.cur_speed / 60.0 } else { self.p.wipe_speed_cfg }.max(10.0);
        let wipe_dist = self.p.wipe_distance;
        let mut wp = vec![self.last_pos];
        wp.extend(self.wipe_path.iter().skip(1).copied());
        let wipe_path_len = geo::polyline_len(&wp).min(wipe_dist);
        let during = self.p.retract_speed * wipe_path_len / wipe_speed;
        if during <= EPS { return (before, 0.0, after); }
        if during - remaining > EPS { return (before, remaining, after); }
        (before + remaining - during, during, after)
    }

    fn wipe(&mut self, length: f64) {
        let wipe_speed = if self.p.role_based_wipe_speed { self.cur_speed / 60.0 } else { self.p.wipe_speed_cfg }.max(10.0);
        if length >= 0.0 {
            let mut wipe_dist = self.p.wipe_distance;
            let mut path = vec![self.last_pos];
            path.extend(self.wipe_path.iter().skip(1).copied());
            // clip_end(len - wipe_dist)
            let total = geo::polyline_len(&path);
            if total > wipe_dist {
                let mut remaining = total - wipe_dist;
                while path.len() >= 2 && remaining > 0.0 {
                    let n = path.len();
                    let l = geo::dist(path[n - 2], path[n - 1]);
                    if l <= remaining { remaining -= l; path.pop(); } else { path[n - 1] = geo::lerp(path[n - 2], path[n - 1], (l - remaining) / l); remaining = 0.0; }
                }
            }
            if path.len() >= 2 {
                let plen = geo::polyline_len(&path);
                if plen < wipe_dist { wipe_dist = plen.max(EPS); }
                self.out.push_str("; WIPE_START\n");
                self.set_speed(wipe_speed * 60.0, ";_WIPE");
                for w in path.windows(2) {
                    let seg = geo::dist(w[0], w[1]);
                    let d_e = length * (seg / wipe_dist);
                    self.extrude_to_xy(w[1], -d_e);
                }
                self.out.push_str("; WIPE_END\n");
                self.last_pos = *path.last().unwrap();
            }
            self.wipe_path.clear();
        }
    }

    fn gen_retract(&mut self, lift: Lift, apply_instantly: bool, role: Option<Feature>) {
        if self.p.wipe && self.wipe_enable && !self.wipe_path.is_empty() && self.p.wipe_distance > 1e-6 {
            let (before, during, _after) = self.wipe_retraction_lengths();
            let len_before = if before > EPS { before } else { self.p.retract_before_wipe * self.p.retract_len };
            self.writer_retract(len_before, self.p.retract_before_wipe * self.p.restart_extra);
            self.wipe(during);
        }
        self.writer_retract(self.p.retract_len, self.p.restart_extra);
        let needs_lift = self.p.retract_len > 0.0;
        let last_top = matches!(self.last_notgap_role, Some(Feature::TopSurface) | Some(Feature::Ironing));
        let can_lift = match self.p.lift_enforce.as_str() {
            "All Surfaces" => true,
            "Bottom Only" | "Top and Bottom" if self.layer_index == 0 => true,
            "Top Only" | "Top and Bottom" => last_top,
            _ => false,
        };
        let _ = role;
        if needs_lift && can_lift {
            if apply_instantly { self.eager_lift(lift); } else { self.lazy_lift(lift); }
        }
    }

    fn travel_to(&mut self, point: P2, role: Feature, z: Option<f64>) {
        let from = self.last_pos;
        let mut lift = Lift::Spiral;
        let needs = self.needs_retraction(from, point, role, &mut lift);
        // acceleration / jerk for the travel
        let mut accel_to_set = 0u32;
        let mut jerk_to_set = 0.0;
        if self.on_first_layer() {
            if self.p.default_accel > 0.0 && self.p.initial_travel_accel > 0.0 { accel_to_set = (self.p.initial_travel_accel + 0.5).floor() as u32; }
            if self.p.default_jerk > 0.0 && self.p.initial_travel_jerk > 0.0 { jerk_to_set = self.p.initial_travel_jerk; }
        } else {
            let short = geo::dist(from, point) < self.p.min_travel;
            if self.p.default_accel > 0.0 {
                if role == Feature::OverhangWall && short {
                    if self.p.bridge_accel > 0.0 { accel_to_set = (self.p.bridge_accel + 0.5).floor() as u32; }
                } else if role == Feature::OuterWall && short {
                    if self.p.outer_accel > 0.0 { accel_to_set = (self.p.outer_accel + 0.5).floor() as u32; }
                } else if self.p.travel_accel > 0.0 {
                    accel_to_set = (self.p.travel_accel + 0.5).floor() as u32;
                }
            }
            if self.p.default_jerk > 0.0 {
                if (role == Feature::OuterWall || role == Feature::OverhangWall) && short {
                    if self.p.outer_jerk > 0.0 { jerk_to_set = self.p.outer_jerk; }
                } else if self.p.travel_jerk > 0.0 { jerk_to_set = self.p.travel_jerk; }
            }
        }
        self.set_accel(accel_to_set, true);
        self.set_jerk(jerk_to_set);
        if needs {
            self.gen_retract(lift, false, Some(role));
        } else {
            self.wipe_path.clear();
        }
        self.add_object_labels();
        let zz = z.unwrap_or(self.nominal_z);
        let force = self.need_change_layer_lift_z;
        self.travel_to_xyz([point[0], point[1], zz], force);
        self.need_change_layer_lift_z = false;
        self.last_pos = point;
        self.last_pos_defined = true;
        self.st.travel_moves += 1;
        self.st.travel_mm += geo::dist(from, point);
    }

    fn extrude_to_xy(&mut self, p: P2, d_e: f64) {
        self.pos[0] = p[0]; self.pos[1] = p[1];
        if d_e.abs() <= f64::EPSILON {
            self.g1(&[('X', p[0], 3), ('Y', p[1], 3)], "");
        } else {
            self.absolute_e += d_e;
            if d_e < 0.0 { self.retracted -= d_e; }
            self.g1(&[('X', p[0], 3), ('Y', p[1], 3), ('E', d_e, 5)], "");
        }
    }

    // ---- extrusion ----------------------------------------------------------------------------------------------

    fn mm3_for(&self, f: Feature, w: f64, h: f64) -> f64 {
        match f {
            // `thick_bridges` / `thick_internal_bridges` select the round bridging flow (diameter = width = height)
            Feature::Bridge if self.s.flag("thick_bridges") => std::f64::consts::FRAC_PI_4 * w * w,
            Feature::InternalBridge if self.s.flag("thick_internal_bridges") => std::f64::consts::FRAC_PI_4 * w * w,
            _ => skirt::rect_mm3(w, h),
        }
    }

    fn acceleration_for(&self, f: Feature) -> f64 {
        if self.p.default_accel <= 0.0 { return 0.0; }
        let is_bridge = matches!(f, Feature::Bridge | Feature::InternalBridge | Feature::OverhangWall);
        if self.on_first_layer() && self.p.initial_accel > 0.0 { self.p.initial_accel }
        else if self.p.bridge_accel > 0.0 && is_bridge { self.p.bridge_accel }
        else if self.p.sparse_accel > 0.0 && f == Feature::SparseInfill { self.p.sparse_accel }
        else if self.p.solid_accel > 0.0 && f == Feature::InternalSolidInfill { self.p.solid_accel }
        else if self.p.outer_accel > 0.0 && f == Feature::OuterWall { self.p.outer_accel }
        else if self.p.inner_accel > 0.0 && f == Feature::InnerWall { self.p.inner_accel }
        else if self.p.top_accel > 0.0 && f == Feature::TopSurface { self.p.top_accel }
        else { self.p.default_accel }
    }

    fn base_speed(&self, f: Feature) -> f64 {
        match f {
            Feature::InnerWall => self.p.inner_speed,
            Feature::OuterWall => self.p.outer_speed,
            Feature::InternalBridge => self.p.internal_bridge_speed,
            Feature::OverhangWall | Feature::SupportTransition | Feature::Bridge => self.p.bridge_speed,
            Feature::SparseInfill => self.p.sparse_speed,
            Feature::InternalSolidInfill => self.p.solid_speed,
            Feature::TopSurface => self.p.top_speed,
            Feature::Ironing => self.p.ironing_speed,
            Feature::BottomSurface => self.p.initial_layer_infill_speed,
            Feature::GapInfill => self.p.gap_speed,
            Feature::Support => self.p.support_speed,
            Feature::SupportInterface => self.p.support_interface_speed,
            Feature::Skirt | Feature::Brim => self.p.support_speed,
            _ => self.p.sparse_speed,
        }
    }

    /// Emit one `ExtrusionPath` worth of moves: `pts` (>=2), constant `w`/`h`, feature `f`.
    /// `speed_param` mirrors Orca's `speed` argument (-1 = pick by role).
    fn extrude_path(&mut self, pts_in: &[P2], w: f64, h: f64, f: Feature, flow_mult: f64, speed_param: f64, user_speed: f64) -> Vec<P2> {
        if pts_in.len() < 2 { return pts_in.to_vec(); }
        // Orca simplifies every path at slicing time: arc fitting (G2/G3) + Douglas-Peucker for the straight parts when
        // `enable_arc_fitting`, plain Douglas-Peucker at `resolution` otherwise
        // (`LayerRegion::simplify_path`: erInternalInfill = sparse infill is fitted at SPARSE_INFILL_RESOLUTION = 0.04 mm,
        // every other role at `resolution`)
        let (pts_v, segs): (Vec<P2>, Vec<arcs::Seg>) = if self.p.arc_fitting {
            arcs::fit_and_simplify(pts_in, if f == Feature::SparseInfill { 0.04 } else { self.p.resolution })
        } else {
            let v = simplify_path(pts_in, self.p.resolution);
            let n = v.len();
            (v, vec![arcs::Seg::Line { a: 0, b: n - 1 }])
        };
        let pts: &[P2] = &pts_v;
        if pts.len() < 2 { return pts_v.clone(); }
        let first = pts[0];
        if !self.last_pos_defined || geo::dist(self.last_pos, first) > 5e-7 || self.need_change_layer_lift_z {
            let undefined = !self.last_pos_defined;
            self.travel_to(first, f, None);
            if undefined { self.travel_to_z(self.nominal_z, "ensure Z matches planned layer height", true); }
            self.need_change_layer_lift_z = false;
        }
        // reset Z after contouring (also finishes a lift)
        if (fmt_axis(self.pos[2], 3)) != fmt_axis(self.nominal_z, 3) {
            self.travel_to_z(self.nominal_z, "reset Z after contouring", true);
        }
        self.add_object_labels();
        self.gen_unretract();
        // acceleration / jerk
        let acc = self.acceleration_for(f);
        self.set_accel(if acc > 0.0 { (acc + 0.5).floor() as u32 } else { 0 }, false);
        // (jerk: default_jerk == 0 on the X2D profile)
        if self.p.default_jerk > 0.0 {
            let is_infill = matches!(f, Feature::Bridge | Feature::InternalBridge | Feature::SparseInfill | Feature::InternalSolidInfill | Feature::TopSurface | Feature::BottomSurface | Feature::Ironing);
            let jerk = if self.on_first_layer() && self.p.initial_jerk > 0.0 { self.p.initial_jerk }
                else if self.p.outer_jerk > 0.0 && f == Feature::OuterWall { self.p.outer_jerk }
                else if self.p.inner_jerk > 0.0 && f == Feature::InnerWall { self.p.inner_jerk }
                else if self.p.top_jerk > 0.0 && f == Feature::TopSurface { self.p.top_jerk }
                else if self.p.infill_jerk > 0.0 && is_infill { self.p.infill_jerk }
                else { self.p.default_jerk };
            self.set_jerk(jerk);
        }

        // flow
        let mut mm3 = self.mm3_for(f, w, h) * flow_mult * self.p.print_flow_ratio * self.p.flow_ratio;
        match f {
            Feature::TopSurface => mm3 *= self.p.top_flow,
            Feature::BottomSurface => mm3 *= self.p.bottom_flow,
            Feature::InternalBridge => mm3 *= self.p.internal_bridge_flow,
            Feature::Brim => mm3 *= self.p.brim_flow,
            _ => {}
        }
        if self.p.set_other_flow_ratios {
            match f {
                Feature::OuterWall => mm3 *= self.p.outer_flow,
                Feature::InnerWall => mm3 *= self.p.inner_flow,
                Feature::OverhangWall => mm3 *= self.p.overhang_flow,
                Feature::SparseInfill => mm3 *= self.p.sparse_flow,
                Feature::InternalSolidInfill => mm3 *= self.p.solid_flow,
                Feature::GapInfill => mm3 *= self.p.gap_flow,
                Feature::Support => mm3 *= self.p.support_flow,
                Feature::SupportInterface => mm3 *= self.p.support_interface_flow,
                _ => {}
            }
            if self.on_first_layer() && f != Feature::Brim && f != Feature::Skirt { mm3 *= self.p.first_layer_flow_ratio; }
        }
        let e_per_mm = self.p.e_per_mm3 * mm3 / self.p.flow_ratio;

        // speed
        let mut speed = if user_speed > 0.0 { user_speed } else { speed_param };
        if speed == -1.0 { speed = self.base_speed(f); }
        if speed == 0.0 { speed = self.p.max_vol_speed / mm3; }
        let layer_id = self.layer_index.max(0) as i64;
        let is_perim = Self::is_perimeter_role(f);
        if self.on_first_layer() {
            if f != Feature::BottomSurface {
                let use_first = is_perim || f == Feature::Brim;
                speed = if use_first { self.p.initial_layer_speed } else { self.p.initial_layer_infill_speed };
            }
        } else if self.p.slow_down_layers > 1 {
            if layer_id > 0 && layer_id < self.p.slow_down_layers {
                let first = if is_perim { self.p.initial_layer_speed } else { self.p.initial_layer_infill_speed };
                if first < speed {
                    let t = layer_id as f64 / self.p.slow_down_layers as f64;
                    speed = speed.min(first + (speed - first) * t);
                }
            }
        }
        if f == Feature::Skirt && self.p.skirt_speed > 0.0 { speed = self.p.skirt_speed; }
        if self.p.max_vol_speed > 0.0 { speed = speed.min(self.p.max_vol_speed / mm3); }
        let big_f = speed * 60.0;

        // tags
        if self.last_proc_role != Some(f) {
            self.last_proc_role = Some(f);
            let _ = write!(self.out, "; FEATURE: {}\n", f.orca_name());
        }
        if self.last_role != Some(f) { self.last_role = Some(f); }
        if self.last_width != w {
            self.last_width = w;
            let _ = write!(self.out, "; LINE_WIDTH: {}\n", fmt_g(w as f32 as f64));
        }
        if (self.last_h_tag - h).abs() > EPS {
            self.last_h_tag = h;
            let _ = write!(self.out, "; LAYER_HEIGHT: {}\n", fmt_g(h as f32 as f64));
        }

        let mut marker = String::from(";_EXTRUDE_SET_SPEED");
        if f == Feature::OuterWall { marker.push_str(";_EXTERNAL_PERIMETER"); }
        let overhang_fan = self.s.flag("enable_overhang_bridge_fan");
        let enable_overhang_speed = self.s.flag("enable_overhang_speed");

        // ExtrusionQualityEstimator: per-point speed from the overhang distance to the layer below
        let mut var_points: Option<Vec<ProcessedPoint>> = None;
        let is_bridge_role = matches!(f, Feature::Bridge | Feature::InternalBridge | Feature::OverhangWall);
        if (enable_overhang_speed || overhang_fan) && !self.on_first_layer() && (is_bridge_role || is_perim) {
            if let Some(bnd) = self.prev_boundary.as_ref() {
                let mut ref_speed = if f == Feature::OuterWall { self.p.outer_speed } else { self.p.inner_speed };
                if ref_speed == 0.0 { ref_speed = self.p.max_vol_speed / mm3; }
                if self.p.max_vol_speed > 0.0 { ref_speed = ref_speed.min(self.p.max_vol_speed / mm3); }
                let k = |key: &str| { let v = self.s.abs(key, ref_speed); if v < 0.5 { ref_speed } else { v } };
                let speeds = [ref_speed, k("overhang_1_4_speed"), k("overhang_2_4_speed"), k("overhang_3_4_speed"), k("overhang_4_4_speed"), self.p.bridge_speed];
                let mut np = overhang::estimate(pts, w, bnd, &[90.0, 75.0, 50.0, 25.0, 13.0, 0.0], &speeds, speed);
                let mut variable = np.iter().any(|p| (p.speed - speed).abs() > 1.0);
                if !enable_overhang_speed && overhang_fan {
                    for p in np.iter_mut() { p.speed = speed; }
                    variable = np.len() > 1;
                }
                if variable { var_points = Some(np); }
            }
        }

        let mut total = 0.0;
        if let Some(np) = var_points {
            // variable speed: plain G1 chords along the estimator's points (no arcs)
            let mut last_set = np[0].speed * 60.0;
            self.set_speed(last_set, &marker);
            let mut prev = np[0].p;
            let mut pre_fan = if overhang_fan { self.check_overhang_fan(np[0].overlap, f) } else { false };
            if f == Feature::InternalBridge { pre_fan = true; }
            for i in 1..np.len() {
                if overhang_fan {
                    let cur_fan = self.check_overhang_fan(np[i].overlap, f);
                    self.role_fan_marker(0, pre_fan && cur_fan, "_OVERHANG");
                    pre_fan = cur_fan;
                    self.role_fan_marker(1, f == Feature::InternalBridge, "_INTERNAL_BRIDGE");
                }
                self.role_fan_marker(2, f == Feature::SupportInterface && self.s.has("support_material_interface_fan_speed") && self.s.num("support_material_interface_fan_speed") >= 0.0, "_SUPP_INTERFACE");
                self.role_fan_marker(3, f == Feature::Ironing && self.s.has("ironing_fan_speed") && self.s.num("ironing_fan_speed") >= 0.0, "_IRONING");
                let p = np[i].p;
                let len = geo::dist(p, prev);
                if len < EPS * 0.01 { continue; }
                let new_speed = np[i - 1].speed * 60.0;
                if (last_set - new_speed).abs() > 60.0 { self.set_speed(new_speed, &marker); last_set = new_speed; }
                else if (big_f - new_speed).abs() <= 60.0 { self.set_speed(big_f, &marker); last_set = big_f; }
                total += len;
                let d_e = e_per_mm * len;
                self.absolute_e += d_e;
                self.pos[0] = p[0]; self.pos[1] = p[1];
                self.g1(&[('X', p[0], 3), ('Y', p[1], 3), ('E', d_e, 5)], "");
                prev = p;
            }
        } else {
            self.set_speed(big_f, &marker);
            // overhang / bridge fan markers
            let thr = self.s.text("overhang_fan_threshold");
            if overhang_fan {
                let on = (thr == "0%" && f == Feature::OuterWall) || matches!(f, Feature::Bridge | Feature::OverhangWall);
                self.role_fan_marker(0, on, "_OVERHANG");
                self.role_fan_marker(1, f == Feature::InternalBridge, "_INTERNAL_BRIDGE");
            }
            self.role_fan_marker(2, f == Feature::SupportInterface && self.s.has("support_material_interface_fan_speed") && self.s.num("support_material_interface_fan_speed") >= 0.0, "_SUPP_INTERFACE");
            self.role_fan_marker(3, f == Feature::Ironing && self.s.has("ironing_fan_speed") && self.s.num("ironing_fan_speed") >= 0.0, "_IRONING");
            for seg in &segs {
                match seg {
                    arcs::Seg::Line { a, b } => {
                        for win in pts[*a..=*b].windows(2) {
                            let len = geo::dist(win[0], win[1]);
                            if len < EPS * 0.01 { continue; }
                            total += len;
                            let d_e = e_per_mm * len;
                            self.absolute_e += d_e;
                            self.pos[0] = win[1][0]; self.pos[1] = win[1][1];
                            self.g1(&[('X', win[1][0], 3), ('Y', win[1][1], 3), ('E', d_e, 5)], "");
                        }
                    }
                    arcs::Seg::Arc { a, b, center, ccw, length } => {
                        if *length < EPS * 0.01 { continue; }
                        total += *length;
                        let d_e = e_per_mm * *length;
                        self.absolute_e += d_e;
                        let (st, en) = (pts[*a], pts[*b]);
                        self.pos[0] = en[0]; self.pos[1] = en[1];
                        let _ = write!(self.out, "G{} X{} Y{} I{} J{} E{}{}\n", if *ccw { 3 } else { 2 }, fmt_axis(en[0], 3), fmt_axis(en[1], 3),
                            fmt_axis(center[0] - st[0], 3), fmt_axis(center[1] - st[1], 3), fmt_axis(d_e, 5), self.comment(""));
                        self.st.arcs += 1;
                    }
                }
            }
        }
        self.out.push_str(";_EXTRUDE_END\n");
        *self.st.path_mm_by_feature.entry(f.orca_name().to_string()).or_insert(0.0) += total;
        if f != Feature::GapInfill { self.last_notgap_role = Some(f); }
        self.last_pos = *pts.last().unwrap();
        pts_v
    }

    /// `check_overhang_fan` in `GCode::_extrude`: does a point with this overlap get the overhang fan?
    fn check_overhang_fan(&self, overlap: f64, f: Feature) -> bool {
        if matches!(f, Feature::Bridge | Feature::OverhangWall) { return true; }
        match self.s.text("overhang_fan_threshold").as_str() {
            "10%" => overlap <= 0.9,
            "25%" => overlap <= 0.75,
            "50%" => overlap <= 0.5,
            "75%" => overlap <= 0.25,
            "95%" => overlap <= 0.05,
            "0%" => f == Feature::OuterWall,
            _ => false,
        }
    }

    fn role_fan_marker(&mut self, which: usize, on: bool, prefix: &str) {
        if on {
            if !self.fan_state[which].0 || self.fan_state[which].1 != self.layer_index {
                self.fan_state[which] = (true, self.layer_index);
                let _ = write!(self.out, ";{}_FAN_START\n", prefix);
            }
        } else if self.fan_state[which].0 {
            self.fan_state[which] = (false, -1);
            let _ = write!(self.out, ";{}_FAN_END\n", prefix);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------

fn bed_temp_keys(bed_type: &str) -> (&'static str, &'static str) {
    match bed_type {
        "Cool Plate" => ("cool_plate_temp_initial_layer", "cool_plate_temp"),
        "Engineering Plate" => ("eng_plate_temp_initial_layer", "eng_plate_temp"),
        "High Temp Plate" => ("hot_plate_temp_initial_layer", "hot_plate_temp"),
        "Textured PEI Plate" => ("textured_plate_temp_initial_layer", "textured_plate_temp"),
        "Textured Cool Plate" => ("textured_cool_plate_temp_initial_layer", "textured_cool_plate_temp"),
        "Supertack Plate" => ("supertack_plate_temp_initial_layer", "supertack_plate_temp"),
        _ => ("textured_plate_temp_initial_layer", "textured_plate_temp"),
    }
}

fn fmt_g_prec(v: f64, sig: usize) -> String {
    if v == 0.0 { return "0".into(); }
    let e = v.abs().log10().floor() as i32;
    let decimals = (sig as i32 - 1 - e).max(0) as usize;
    let s = format!("{:.*}", decimals, v);
    if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
}

fn seg_dist(a: P2, b: P2, c: P2, d: P2) -> f64 {
    // minimum distance between segments ab and cd
    fn pt_seg(p: P2, a: P2, b: P2) -> f64 {
        let ab = geo::sub(b, a);
        let l2 = geo::dot(ab, ab);
        let t = if l2 < 1e-18 { 0.0 } else { (geo::dot(geo::sub(p, a), ab) / l2).clamp(0.0, 1.0) };
        geo::dist(p, geo::lerp(a, b, t))
    }
    // proper intersection => 0
    let d1 = geo::cross(geo::sub(b, a), geo::sub(c, a));
    let d2 = geo::cross(geo::sub(b, a), geo::sub(d, a));
    let d3 = geo::cross(geo::sub(d, c), geo::sub(a, c));
    let d4 = geo::cross(geo::sub(d, c), geo::sub(b, c));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) { return 0.0; }
    pt_seg(a, c, d).min(pt_seg(b, c, d)).min(pt_seg(c, a, b)).min(pt_seg(d, a, b))
}

/// Douglas-Peucker on an open polyline (`ExtrusionPath::simplify`).
fn simplify_path(p: &[P2], tol: f64) -> Vec<P2> {
    let (v, _) = arcs::fit_and_simplify(p, 0.0);
    if tol <= 0.0 { return v; }
    let pts = p;
    let n = pts.len();
    if n < 3 { return pts.to_vec(); }
    let mut keep = vec![false; n]; keep[0] = true; keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 { continue; }
        let (a, b) = (pts[lo], pts[hi]);
        let ab = geo::sub(b, a);
        let l = geo::norm(ab);
        let (mut best, mut bi) = (-1.0, lo);
        for i in lo + 1..hi {
            let d = if l < 1e-12 { geo::dist(pts[i], a) } else { geo::cross(ab, geo::sub(pts[i], a)).abs() / l };
            if d > best { best = d; bi = i; }
        }
        if best > tol { keep[bi] = true; stack.push((lo, bi)); stack.push((bi, hi)); }
    }
    (0..n).filter(|&i| keep[i]).map(|i| pts[i]).collect()
}

/// `GCodeOutputStream::writeln`: append `\n` unless the text already ends with one.
fn writeln(out: &mut String, text: &str) {
    out.push_str(text);
    if !text.is_empty() && !text.ends_with('\n') { out.push('\n'); }
}

/// Does `gcode` contain a line that sets a temperature through one of the given M-codes?
fn custom_sets_temp(gcode: &str, codes: [&str; 2]) -> bool {
    for line in gcode.lines() {
        let t = line.trim_start();
        for c in codes { if let Some(rest) = t.strip_prefix(c) { if rest.is_empty() || rest.starts_with(' ') || rest.starts_with(';') { return true; } } }
    }
    false
}

// ---------------------------------------------------------------------------------------------------------------
// template contexts
// ---------------------------------------------------------------------------------------------------------------

struct PrintFacts {
    first_layer_min: P2,
    first_layer_max: P2,
    max_print_z: f64,
    max_z_height: f64,
    total_layers: usize,
}

impl<'a> Gen<'a> {
    fn base_vars(&self, facts: &PrintFacts) -> BTreeMap<String, Extra> {
        let s = self.s;
        let mut m: BTreeMap<String, Extra> = BTreeMap::new();
        let i = |v: i64| V::Int(v);
        let f = |v: f64| V::Dbl(v);
        let sc = |k: &str, v: V| (k.to_string(), Extra::Scalar(v));
        let ve = |k: &str, v: Vec<V>| (k.to_string(), Extra::Vector(v));
        let mut put = |kv: (String, Extra)| { m.insert(kv.0, kv.1); };
        let n_noz = s.len_of("nozzle_diameter").max(1);
        put(sc("initial_tool", i(0))); put(sc("initial_extruder", i(0))); put(sc("initial_no_support_tool", i(0))); put(sc("initial_no_support_extruder", i(0)));
        put(sc("initial_filament_id", i(0))); put(sc("initial_no_support_filament_id", i(0)));
        put(sc("initial_no_support_hotend", i(-1))); put(sc("current_hotend", i(-1)));
        put(sc("current_extruder", i(0))); put(sc("current_filament_id", i(0))); put(sc("current_extruder_id", i(0))); put(sc("current_nozzle_id", i(0)));
        put(sc("initial_nozzle_id", i(0)));
        put(sc("filament_extruder_id", i(0)));
        put(sc("most_used_physical_extruder_id", i(0))); put(sc("curr_physical_extruder_id", i(0)));
        let first: Vec<V> = (0..n_noz).map(|k| if k == 0 { i(0) } else { i(-1) }).collect();
        put(ve("first_tools", first.clone())); put(ve("first_filaments", first.clone())); put(ve("first_non_support_tools", first.clone())); put(ve("first_non_support_filaments", first));
        put(ve("first_non_support_hotend", (0..n_noz).map(|_| i(-1)).collect()));
        put(sc("max_additional_fan", f(s.num("additional_cooling_fan_speed"))));
        put(sc("total_layer_count", i(facts.total_layers as i64)));
        put(sc("current_object_idx", i(0)));
        put(sc("has_wipe_tower", V::Bool(false)));
        put(sc("wipe_tower_center_pos_x", f(0.0))); put(sc("wipe_tower_center_pos_y", f(0.0))); put(sc("wipe_tower_center_pos_valid", V::Bool(false)));
        put(sc("has_single_extruder_multi_material_priming", V::Bool(false)));
        put(sc("total_toolchanges", i(0)));
        put(sc("num_extruders", i(n_noz as i64)));
        put(ve("is_extruder_used", (0..n_noz.max(32)).map(|k| V::Bool(k == 0)).collect()));
        // bed / print area
        let bed = parse_bed(s);
        let (bmin, bmax) = geo::bbox(&bed).unwrap_or(([0.0, 0.0], [256.0, 256.0]));
        put(ve("print_bed_min", vec![f(bmin[0]), f(bmin[1])])); put(ve("print_bed_max", vec![f(bmax[0]), f(bmax[1])]));
        put(ve("print_bed_size", vec![f(bmax[0] - bmin[0]), f(bmax[1] - bmin[1])]));
        let (lo, hi) = (facts.first_layer_min, facts.first_layer_max);
        put(ve("first_layer_print_min", vec![f(lo[0]), f(lo[1])])); put(ve("first_layer_print_max", vec![f(hi[0]), f(hi[1])]));
        put(ve("first_layer_print_size", vec![f(hi[0] - lo[0]), f(hi[1] - lo[1])]));
        put(ve("first_layer_center_no_wipe_tower", vec![f((lo[0] + hi[0]) / 2.0), f((lo[1] + hi[1]) / 2.0)]));
        put(sc("in_head_wrap_detect_zone", V::Bool(false)));
        put(sc("max_print_z", i(facts.max_print_z.ceil() as i64)));
        let margin = s.num("adaptive_bed_mesh_margin");
        let (mmin, mmax) = (s.elements("bed_mesh_min"), s.elements("bed_mesh_max"));
        let pv = |e: &Vec<String>, d: f64| -> (f64, f64) { (e.get(0).and_then(|x| x.parse().ok()).unwrap_or(d), e.get(1).and_then(|x| x.parse().ok()).unwrap_or(d)) };
        let (a0, a1) = pv(&mmin, -99999.0); let (b0, b1) = pv(&mmax, 99999.0);
        let (amin, amax) = ([a0.max(lo[0] - margin), a1.max(lo[1] - margin)], [b0.min(hi[0] + margin), b1.min(hi[1] + margin)]);
        put(ve("adaptive_bed_mesh_min", vec![f(amin[0]), f(amin[1])])); put(ve("adaptive_bed_mesh_max", vec![f(amax[0]), f(amax[1])]));
        let probe = s.elements("bed_mesh_probe_distance");
        let (pdx, pdy) = pv(&probe, 50.0);
        let cx = ((amax[0] - amin[0]) / pdx.max(1.0)).ceil() as i64 + 1; let cy = ((amax[1] - amin[1]) / pdy.max(1.0)).ceil() as i64 + 1;
        let (cx, cy) = (cx.max(3), cy.max(3));
        put(ve("bed_mesh_probe_count", vec![i(cx), i(cy)]));
        put(sc("bed_mesh_algo", V::Str(if cx * cy <= 6 { "lagrange".into() } else { "bicubic".into() })));
        // temperatures
        let bt = s.text("curr_bed_type");
        let (k1, k2) = bed_temp_keys(&bt);
        let ints = |k: &str| -> Vec<V> { s.elements(k).iter().map(|e| V::Int(e.trim().parse::<f64>().unwrap_or(0.0) as i64)).collect() };
        put(sc("bbl_bed_temperature_gcode", V::Bool(false)));
        put(ve("bed_temperature_initial_layer", ints(k1))); put(ve("bed_temperature", ints(k2)));
        put(sc("bed_temperature_initial_layer_single", i(self.p.bed_temp_first)));
        put(sc("bed_temperature_initial_layer_vector", V::Str(String::new())));
        let chamber = ints("chamber_temperature");
        let overall = chamber.iter().map(|v| if let V::Int(x) = v { *x } else { 0 }).max().unwrap_or(0);
        put(sc("overall_chamber_temperature", i(overall)));
        put(sc("enable_high_low_temp_mix", V::Bool(true)));
        let vit = ints("temperature_vitrification");
        put(sc("min_vitrification_temperature", i(vit.iter().map(|v| if let V::Int(x) = v { *x } else { 0 }).min().unwrap_or(0))));
        put(ve("first_layer_bed_temperature", ints(k1)));
        put(ve("first_layer_temperature", ints("nozzle_temperature_initial_layer")));
        put(sc("max_print_height", i(s.num("printable_height") as i64)));
        put(sc("z_offset", f(s.num("z_offset"))));
        put(sc("model_name", V::Str(self.o.object_name.clone()))); put(sc("plate_number", V::Str("1".into()))); put(sc("plate_name", V::Str(String::new())));
        put(sc("first_layer_height", f(self.p.initial_layer_height)));
        put(sc("is_all_bbl_filament", V::Bool(s.text("filament_vendor") == "Bambu Lab")));
        put(ve("during_print_exhaust_fan_speed_num", s.elements("during_print_exhaust_fan_speed").iter().map(|e| i((e.trim().parse::<f64>().unwrap_or(0.0) / 100.0 * 255.0) as i64)).collect()));
        let ow = {
            let w = { let a = s.abs("outer_wall_line_width", self.p.nozzle); if a > 0.0 { a } else { self.p.nozzle } };
            let v = self.p.outer_speed * skirt::rect_mm3(w, self.p.layer_height);
            v.min(self.p.max_vol_speed)
        };
        put(sc("outer_wall_volumetric_speed", f(ow)));
        put(sc("has_tpu_in_first_layer", V::Bool(s.text("filament_type") == "TPU")));
        put(sc("hold_chamber_temp_for_flat_print", V::Bool(facts.max_z_height > 0.0 && facts.max_z_height < 0.3)));
        put(sc("print_time_sec", V::Str("@PRINT_TIME_SEC@".into()))); put(sc("used_filament_length", V::Str("@USED_FILAMENT_LENGTH@".into())));
        // flush speeds / temps with Orca's fallbacks
        let fv = { let mut v = s.num("filament_flush_volumetric_speed"); if v == 0.0 { v = s.num("filament_max_volumetric_speed"); } v };
        let ft = { let mut v = s.num("filament_flush_temp"); if v == 0.0 { v = s.num("nozzle_temperature_range_high"); } v };
        put(ve("flush_volumetric_speeds", vec![f(fv)])); put(ve("flush_temperatures", vec![i(ft as i64)]));
        put(ve("nozzle_diameter_at_nozzle_id", vec![f(s.num("nozzle_diameter")); 1]));
        put(ve("nozzle_volume_types", vec![V::Str(s.text("nozzle_volume_type"))]));
        put(sc("retraction_distance_when_cut", f(s.num("retraction_distances_when_cut"))));
        put(sc("long_retraction_when_cut", V::Bool(s.flag("long_retractions_when_cut"))));
        put(sc("retraction_distance_when_ec", f(s.num("retraction_distances_when_ec"))));
        put(sc("long_retraction_when_ec", V::Bool(s.flag("long_retractions_when_ec"))));
        put(ve("temperature", ints("nozzle_temperature")));
        put(ve("retract_length", s.elements("retraction_length").iter().map(|e| f(e.trim().parse().unwrap_or(0.0))).collect()));
        put(sc("version", V::Str("2.5.0-dev".into())));
        m
    }

    fn expand(&mut self, name: &str, templ: &str, extra: &[(&str, Extra)], base: &BTreeMap<String, Extra>) -> String {
        if templ.is_empty() { return String::new(); }
        let (text, issues, globals) = {
            let mut ctx = Ctx::new(self.s);
            ctx.name = name.to_string();
            ctx.extra = base.clone();
            for (k, v) in extra { ctx.extra.insert((*k).to_string(), v.clone()); }
            ctx.globals = std::mem::take(&mut self.tpl_ctx_globals);
            let t = template::expand(templ, &mut ctx);
            (t, ctx.issues.clone(), ctx.globals.clone())
        };
        self.tpl_ctx_globals = globals;
        let mut out = String::new();
        for is in &issues {
            let msg = format!("template {}: {}", name, is.message);
            let _ = write!(out, "; !!!!! FDM-UNRESOLVED in {}: {}\n", name, is.message.replace('\n', " "));
            self.issue(msg);
        }
        out.push_str(&text);
        // custom G-code that changes motion state invalidates the writer's cache (custom_gcode_motion_state_changes)
        for l in text.lines() {
            let t = l.trim_start();
            if t.starts_with("M204") { self.last_acc = 0; }
            if t.starts_with("M205") { self.last_jerk = 0.0; }
        }
        out
    }
}

// ---------------------------------------------------------------------------------------------------------------
// loops, layers, whole file
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Desc { Perimeter, Infill, Skirt, Brim, Ironing, Other }

impl<'a> Gen<'a> {
    /// `extrude_entity`: a loop (closed stroke) goes through `extrude_loop`, an open stroke through `extrude_path`.
    fn extrude_stroke(&mut self, st: &Stroke, desc: Desc, speed_param: f64, start_point: Option<P2>) {
        if st.pts.len() < 2 { return; }
        if st.closed {
            let loop_len = st.length();
            let last = start_point.unwrap_or(self.last_pos);
            let mut s = st.clone();
            // (spiral vase / seam slope / wipe_on_loops are rejected up front)
            let seam_pt: P2 = if self.spiral_layer && desc == Desc::Perimeter { nearest_point_on(st, last) } else if self.o.roundtrip && desc == Desc::Perimeter { st.pts[0] } else if desc == Desc::Perimeter && self.seam.is_some() && !st.feat.iter().all(|f| *f == Feature::InnerWall) || (desc == Desc::Perimeter && self.seam.is_some()) {
                let sp = self.seam.as_ref().unwrap();
                match sp.place(self.cur_layer, st, last) { Some((p, _)) => p, None => nearest_point_on(st, last) }
            } else {
                nearest_point_on(st, last)
            };
            let mut open = seam::split_loop_at(&s, seam_pt, 0.0015);
            if !self.spiral_layer { seam::clip_end(&mut open, self.p.seam_gap); }
            s = open;
            if s.pts.len() < 2 { return; }
            let small = speed_param == -1.0 && desc == Desc::Perimeter && loop_len <= self.p.small_perimeter_length && self.p.small_perimeter_length > 0.0;
            let small_speed = if small {
                if self.s.abs("small_perimeter_speed", self.p.outer_speed) == 0.0 { self.p.outer_speed * 0.5 } else { self.p.small_perimeter_speed }
            } else { -1.0 };
            let mut wipe_path: Vec<P2> = Vec::new();
            self.emit_runs(&s, desc, speed_param, small_speed, &mut wipe_path);
            if self.p.wipe && self.wipe_enable {
                // a loop's wipe path is NOT reversed (it continues along the start of the loop)
                self.wipe_path = wipe_path;
            }
        } else {
            let mut wipe_path: Vec<P2> = Vec::new();
            self.emit_runs(st, desc, speed_param, -1.0, &mut wipe_path);
            if self.p.wipe && self.wipe_enable {
                wipe_path.reverse();
                self.wipe_path = wipe_path;
            }
        }
    }

    /// Split an open stroke into Orca "paths" (constant feature and width) and extrude them.
    fn emit_runs(&mut self, s: &Stroke, desc: Desc, speed_param: f64, small_speed: f64, wipe_path: &mut Vec<P2>) {
        let n = s.pts.len() - 1;
        let mut i = 0;
        while i < n {
            let f = s.feat[i];
            let w = s.w[i];
            let mut j = i + 1;
            while j < n && s.feat[j] == f && (s.w[j] - w).abs() < 1e-6 { j += 1; }
            let pts = &s.pts[i..=j];
            let sp = if small_speed > 0.0 && !matches!(f, Feature::OverhangWall | Feature::Bridge | Feature::InternalBridge) && plan::is_wall(f) { small_speed } else { speed_param };
            let _ = desc;
            let fin = self.extrude_path(pts, w, s.h, f, s.flow_ratio, sp, s.speed);
            if wipe_path.is_empty() { wipe_path.extend_from_slice(&fin); } else { wipe_path.extend(fin.iter().skip(1)); }
            i = j;
        }
    }

    fn print_island(&mut self, isl: &Island, first_layer: bool) {
        // perimeters whose region has is_infill_first == false (always on the first layer)
        let walls_first = first_layer || !self.p.is_infill_first;
        if walls_first { for w in &isl.walls { self.extrude_stroke(w, Desc::Perimeter, -1.0, None); } }
        // infill: Orca (`GCode::extrude_infill`) chains ALL the infill entities of an island's region at once.
        // `Region::append` flattens every sortable fill collection into its individual paths and keeps only the
        // `no_sort` collections (monotonic, concentric, ironing) whole, so one greedy chain runs over single paths and
        // whole no_sort collections together, from the nozzle position.
        if !isl.infill.is_empty() {
            // Orca: the paths of a `grid` sparse infill are not reversible (Fill.cpp, `params.can_reverse = false`)
            let sparse_grid = self.paths_reversible_grid();
            let mut units: Vec<Vec<Stroke>> = Vec::new();
            let mut whole: Vec<bool> = Vec::new();
            for run in &isl.infill {
                if run.is_empty() { continue; }
                if self.pattern_no_sort(run[0].feature()) { for c in plan::split_collections(run) { units.push(c); whole.push(true); } }
                else { for st in run { units.push(vec![st.clone()]); whole.push(false); } }
            }
            let order = plan::chain_units(&units, self.last_pos, &|i: usize| {
                if whole[i] { return false; }
                let st = &units[i][0];
                st.closed || !(st.feature() == Feature::SparseInfill && sparse_grid)
            });
            for (i, rev) in order {
                let mut unit = units[i].clone();
                if rev { unit.reverse(); unit = unit.into_iter().map(|s| s.reversed()).collect(); }
                for st in &unit { self.extrude_stroke(st, Desc::Infill, -1.0, None); }
            }
        }
        if !walls_first { for w in &isl.walls { self.extrude_stroke(w, Desc::Perimeter, -1.0, None); } }
        for st in &isl.other { self.extrude_stroke(st, Desc::Other, -1.0, None); }
        for st in &isl.ironing { self.extrude_stroke(st, Desc::Ironing, -1.0, None); }
    }

    /// Is the sparse infill pattern `grid`? Orca marks the paths of that fill as not reversible (`FillParams::can_reverse`).
    fn paths_reversible_grid(&self) -> bool { self.s.text("sparse_infill_pattern") == "grid" }

    /// `Fill::no_sort()` of the pattern that produced `f`: monotonic, monotonic line and concentric fills keep their order.
    fn pattern_no_sort(&self, f: Feature) -> bool {
        let key = match f {
            Feature::SparseInfill => "sparse_infill_pattern",
            Feature::InternalSolidInfill => "internal_solid_infill_pattern",
            Feature::TopSurface => "top_surface_pattern",
            Feature::BottomSurface => "bottom_surface_pattern",
            Feature::Ironing => return true,
            // bridges are filled with the pattern chosen in `make_fills` for solid non-external surfaces: monotonic when
            // `top_surface_pattern` is monotonic / monotonicline, rectilinear (sortable) otherwise
            Feature::Bridge | Feature::InternalBridge => return matches!(self.s.text("top_surface_pattern").as_str(), "monotonic" | "monotonicline"),
            _ => return false,
        };
        matches!(self.s.text(key).as_str(), "monotonic" | "monotonicline" | "concentric")
    }

    fn start_layer_header(&mut self, plan_z: f64, first_layer: bool) {
        let _ = write!(self.out, "; CHANGE_LAYER\n");
        let _ = write!(self.out, "; Z_HEIGHT: {}\n", fmt_g(plan_z));
        let height: f32 = if first_layer { plan_z as f32 } else { plan_z as f32 - self.last_layer_z };
        let _ = write!(self.out, "; LAYER_HEIGHT: {}\n", fmt_g(height as f64));
        self.last_layer_z = plan_z as f32;
        self.max_layer_z = self.max_layer_z.max(self.last_layer_z as f64);
        self.last_height = height;
        self.last_h_tag = height as f64;
    }

    fn change_layer(&mut self, z: f64, lift_for_layer: Lift) {
        self.layer_index += 1;
        if self.p.retract_when_changing_layer && self.will_move_z(z) {
            let l = if self.p.z_hop_kind == ZHopKind::Auto { Lift::Spiral } else { lift_for_layer };
            self.gen_retract(l, false, None);
        }
        self.add_object_labels();
        self.need_change_layer_lift_z = true;
        self.nominal_z = z;
        self.pos[2] = z;
    }

    fn make_timelapse(&mut self, print_z: f64, base: &BTreeMap<String, Extra>) {
        let tl = self.s.text("time_lapse_gcode");
        if tl.is_empty() { return; }
        let pos = self.o.timelapse_pos;
        let extra: Vec<(&str, Extra)> = vec![
            ("layer_num", Extra::Scalar(V::Int(self.layer_index))),
            ("layer_z", Extra::Scalar(V::Dbl(print_z))),
            ("max_layer_z", Extra::Scalar(V::Dbl(self.max_layer_z))),
            ("timelapse_pos_x", Extra::Scalar(V::Int(pos[0] as i64))),
            ("timelapse_pos_y", Extra::Scalar(V::Int(pos[1] as i64))),
            ("has_timelapse_safe_pos", Extra::Scalar(V::Bool(true))),
            ("timelapse_inline_photo", Extra::Scalar(V::Bool(false))),
            ("farthest_point_timelapse_enabled", Extra::Scalar(V::Bool(false))),
            ("clear_to_x0", Extra::Scalar(V::Bool(false))),
        ];
        let mut t = self.expand("timelapse_gcode", &tl, &extra, base);
        t.push('\n');
        self.out.push_str(&t);
        self.pos_clear = false;
        // the macro moves Z (G1 Z.. F1200): keep the writer's Z in sync like get_last_z_from_gcode
        if let Some(z) = last_z_in(&t) { self.pos[2] = z; }
    }

    fn process_layer(&mut self, li: usize, plan: &LayerPlan, islands: &[Island], extra_isl: &Island, skirt_loops: &[Stroke], brim: &[Stroke], base: &BTreeMap<String, Extra>, first_prim_pos: Option<P2>) {
        let (first_layer, lift) = self.begin_layer(li, plan, base);
        let _ = first_prim_pos;
        self.print_skirt(li, plan, skirt_loops, first_layer);
        let sup_all = self.sup_strokes[li].clone();
        self.print_objects(li, plan, islands, extra_isl, brim, first_layer, sup_all);
        self.end_layer(plan, lift, base);
    }

    /// Print one layer's islands / brim / support, split per object of a multi-object plate (one `; printing object` block each,
    /// owner = footprint containing, else nearest to, the first point). Shared by the one-filament layer and, per filament, the
    /// multi-material layer.
    pub(super) fn print_objects(&mut self, li: usize, plan: &LayerPlan, islands: &[Island], extra_isl: &Island, brim: &[Stroke], first_layer: bool, sup_all: Vec<Stroke>) {
        let nobj = self.o.objects.len();
        if nobj <= 1 {
            let obj = (self.o.object_name.clone(), self.o.object_id as u64, self.o.label_id);
            self.print_object_part_for(li, plan, islands, extra_isl, brim, first_layer, sup_all, obj, true);
        } else {
            let objs = self.o.objects.clone();
            let owner = |p: P2| -> usize {
                let mut best = (f64::INFINITY, 0usize);
                for (i, o) in objs.iter().enumerate() {
                    let d = if o.footprint.len() >= 3 && geo::in_ring(p, &o.footprint) { -1.0 } else { o.footprint.iter().map(|q| geo::dist(*q, p)).fold(f64::INFINITY, f64::min) };
                    if d < best.0 { best = (d, i); }
                }
                best.1
            };
            for (bi, o) in objs.iter().enumerate() {
                let isl: Vec<Island> = islands.iter().filter(|i| !is_empty_island(i) && owner(i.centroid) == bi).cloned().collect();
                let brim_m: Vec<Stroke> = brim.iter().filter(|b| owner(b.pts[0]) == bi).cloned().collect();
                let sup_m: Vec<Stroke> = sup_all.iter().filter(|s| owner(s.pts[0]) == bi).cloned().collect();
                if isl.is_empty() && sup_m.is_empty() && !(bi + 1 == nobj && !is_empty_island(extra_isl)) { continue; }
                self.print_object_part_for(li, plan, &isl, extra_isl, &brim_m, first_layer, sup_m, (o.name.clone(), o.id, o.label_id), bi + 1 == nobj);
            }
        }
    }

    /// Layer start: `; CHANGE_LAYER`, layer-change G-code, first/second-layer acceleration and temperature steps.
    fn begin_layer(&mut self, li: usize, plan: &LayerPlan, base: &BTreeMap<String, Extra>) -> (bool, Lift) {
        let first_layer = li == 0 && (plan.z - plan.h).abs() < 1e-6;
        self.is_first_layer = first_layer;
        self.cur_layer = li;
        self.prev_boundary = if li > 0 { self.layer_slices.get(li - 1).filter(|v| !v.is_empty()).map(|v| Boundary::new(v)) } else { None };
        self.out.clear();
        self.start_layer_header(plan.z, first_layer);
        let lift = self.lift_type_for();
        self.change_layer(plan.z, lift);
        // layer_change_gcode
        let lc = self.s.text("layer_change_gcode");
        if !lc.is_empty() {
            let extra: Vec<(&str, Extra)> = vec![
                ("layer_num", Extra::Scalar(V::Int(self.layer_index))),
                ("layer_z", Extra::Scalar(V::Dbl(plan.z))),
                ("max_layer_z", Extra::Scalar(V::Dbl(self.max_layer_z))),
                ("curr_y_acceleration_limit", Extra::Scalar(V::Dbl(-1.0))),
                ("curr_accumulated_mass", Extra::Scalar(V::Dbl(-1.0))),
                ("curr_layer_mass", Extra::Scalar(V::Dbl(0.0))),
            ];
            let mut t = self.expand("layer_change_gcode", &lc, &extra, base);
            t.push('\n');
            self.out.push_str(&t);
        }
        self.out.push_str(";_SET_FAN_SPEED_CHANGING_LAYER\n");
        if first_layer {
            if self.p.default_accel > 0.0 && self.p.initial_accel > 0.0 { self.set_accel((self.p.initial_accel + 0.5).floor() as u32, false); }
            if self.p.default_jerk > 0.0 && self.p.initial_jerk > 0.0 { self.set_jerk(self.p.initial_jerk); }
        }
        if !first_layer && !self.second_layer_done {
            if self.p.default_accel > 0.0 && self.p.initial_accel > 0.0 { self.set_accel((self.p.default_accel + 0.5).floor() as u32, false); }
            if self.p.default_jerk > 0.0 && self.p.initial_jerk > 0.0 { self.set_jerk(self.p.default_jerk); }
            let t = self.p.nozzle_temp;
            if t > 0 && t != self.p.nozzle_temp_first { let _ = write!(self.out, "M104 S{} ; set nozzle temperature\n", t); }
            let bed = self.p.bed_temp;
            if bed != self.last_bed_temp { self.last_bed_temp = bed; let _ = write!(self.out, "M140 S{} ; set bed temperature\n", bed); }
            self.second_layer_done = true;
        }
        (first_layer, lift)
    }

    /// The skirt of this layer (all printing extruders: just one).
    fn print_skirt(&mut self, li: usize, plan: &LayerPlan, skirt_loops: &[Stroke], first_layer: bool) {
        let skirt_this_layer = !skirt_loops.is_empty() && (li < self.p.skirt_height.max(1));
        if skirt_this_layer {
            for (k, lp) in skirt_loops.iter().enumerate() {
                let mut l = lp.clone();
                l.h = plan.h;
                let start = if first_layer && k == 0 { Some(skirt::find_start_point(&l.pts, self.p.skirt_start_angle)) } else { None };
                self.extrude_stroke(&l, Desc::Skirt, self.p.support_speed, start);
            }
        }
    }

    /// Object label, brim (first layer), support, islands: one object's part of the layer.
    fn print_object_part(&mut self, li: usize, plan: &LayerPlan, islands: &[Island], extra_isl: &Island, brim: &[Stroke], first_layer: bool, sup: Vec<Stroke>) {
        let obj = (self.o.object_name.clone(), self.o.object_id as u64, self.o.label_id);
        self.print_object_part_for(li, plan, islands, extra_isl, brim, first_layer, sup, obj, true);
    }

    fn print_object_part_for(&mut self, li: usize, plan: &LayerPlan, islands: &[Island], extra_isl: &Island, brim: &[Stroke], first_layer: bool, sup: Vec<Stroke>, obj: (String, u64, u32), print_extra: bool) {
        let (obj_name, obj_id, label_id) = obj;
        if self.p.gcode_label_objects {
            let _ = write!(self.out, "; printing object {} id:{} copy 0\n", obj_name, obj_id);
        }
        self.obj_start = format!("; start printing object, unique label id: {}\nM624 {}\n", label_id, self.label_mask(label_id));
        if first_layer {
            for b in brim { self.extrude_stroke(b, Desc::Brim, self.p.support_speed, None); }
        }
        // layer geometry used by the retraction logic
        self.cur_internal = if self.p.reduce_infill_retraction && self.p.sparse_density > 0.0 { self.internal_slices(li) } else { Vec::new() };
        // island order
        let mut order: Vec<usize> = (0..islands.len()).filter(|&k| !is_empty_island(&islands[k])).collect();
        if order.len() > 1 {
            // Orca quantises the island centroids to 1 mm before touring them from the wipe-tower position
            let q = |v: f64| (v + if v >= 0.0 { 0.5 } else { -0.5 }).trunc();
            let cents: Vec<P2> = order.iter().map(|&k| [q(islands[k].centroid[0]), q(islands[k].centroid[1])]).collect();
            // Orca builds `Point wt_pos(wipe_tower_x, wipe_tower_y)` from the mm doubles WITHOUT scaling, i.e. integer scaled
            // units (1e-6 mm): the tour effectively starts at the bed origin, not at the wipe tower (measured: gk_edges_223x223,
            // 6 islands, reversed order with the mm position).
            let wt = [self.s.num("wipe_tower_x") as i64 as f64 * 1e-6, self.s.num("wipe_tower_y") as i64 as f64 * 1e-6];
            let chain = geo::chain_points_post(&cents, Some(wt));
            order = chain.into_iter().rev().map(|k| order[k]).collect();
        }
        // support first, chained from the nozzle like extrude_support
        {
            if !sup.is_empty() {
                let units: Vec<Vec<Stroke>> = sup.into_iter().map(|st| vec![st]).collect();
                let ord = plan::chain_units(&units, self.last_pos, &|_i: usize| true);
                for (i, rev) in ord {
                    let mut st = units[i][0].clone();
                    if rev { st = st.reversed(); }
                    self.extrude_stroke(&st, Desc::Other, -1.0, None);
                }
            }
        }
        for k in order { let isl = islands[k].clone(); self.print_island(&isl, first_layer); }
        if print_extra && !is_empty_island(extra_isl) { let isl = extra_isl.clone(); self.print_island(&isl, first_layer); }
        if self.p.gcode_label_objects {
            let _ = write!(self.out, "; stop printing object {} id:{} copy 0\n", obj_name, obj_id);
        }
        if !self.obj_start.is_empty() { self.obj_start.clear(); }
        else { self.obj_end = format!("; stop printing object, unique label id: {}\nM625\n", label_id); }
        let _ = plan;
    }

    /// Time-lapse snapshot at the end of the layer (multi-nozzle BBL machines).
    fn end_layer(&mut self, plan: &LayerPlan, lift: Lift, base: &BTreeMap<String, Extra>) {
        let multi = self.s.len_of("nozzle_diameter") > 1;
        if multi && !self.s.text("time_lapse_gcode").is_empty() {
            if self.p.retract_when_changing_layer { let l = if self.p.z_hop_kind == ZHopKind::Auto { Lift::Spiral } else { lift }; self.gen_retract(l, true, None); }
            self.add_object_labels();
            if self.o.objects.len() > 1 {
                let mut ids: Vec<u32> = self.o.objects.iter().map(|o| o.label_id).collect(); ids.sort();
                let list = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
                let mask = { let mut m = 0u64; for i in 0..ids.len() { m |= 1u64 << i; } b64(&m.to_le_bytes()) };
                let _ = write!(self.out, "; object ids of layer {} start: {}\nM624 {}\n", self.layer_index + 1, list, mask);
                self.make_timelapse(plan.z, base);
                let _ = write!(self.out, "; object ids of this layer{} end: {}\nM625\n", self.layer_index + 1, list);
            } else { self.make_timelapse(plan.z, base); }
        }
    }

    fn run(&mut self, plans: &[LayerPlan]) -> Result<GcodeOutput, FdmError> {
        let s = self.s;
        // ---- refuse what is not supported ----------------------------------------------------------------
        let mut spiral: Option<spiral_filter::SpiralFilter> = if s.flag("spiral_mode") {
            if plans.iter().any(|p| p.paths.iter().any(|q| matches!(q.feature, Feature::Support | Feature::SupportInterface | Feature::SupportTransition))) {
                return Err(FdmError::Unsupported("spiral_mode with support layers (Orca only spiralises layers without support)".into()));
            }
            Some(spiral_filter::SpiralFilter::new(s.flag("spiral_mode_smooth"), s.abs("spiral_mode_max_xy_smoothing", self.p.nozzle),
                s.num("spiral_starting_flow_ratio"), s.num("spiral_finishing_flow_ratio"), if s.has("resolution") { s.num("resolution") } else { 0.012 }, self.p.relative_e))
        } else { None };
        let base_arc_fitting = self.p.arc_fitting;
        if s.has("print_sequence") && s.text("print_sequence") == "by object" { return Err(FdmError::Unsupported("print_sequence by object".into())); }
        if s.has("gcode_flavor") && s.text("gcode_flavor") != "marlin" && s.text("gcode_flavor") != "marlin2" { self.issue(format!("gcode_flavor {} is not exercised; Marlin flavour output is produced", s.text("gcode_flavor"))); }
        if s.flag("reduce_crossing_wall") { self.issue("reduce_crossing_wall (avoid crossing perimeters) is not implemented; travels are straight"); }
        if s.has("seam_slope_type") && s.text("seam_slope_type") != "none" { self.issue("scarf seam (seam_slope_type) is not implemented; plain seam used"); }
        if s.flag("wipe_on_loops") || s.flag("wipe_before_external_loop") { self.issue("wipe_on_loops / wipe_before_external_loop are not implemented"); }
        if s.flag("enable_pressure_advance") && s.flag("adaptive_pressure_advance") { self.issue("adaptive pressure advance tagging not implemented"); }
        if s.flag("small_area_infill_flow_compensation") { self.issue("small_area_infill_flow_compensation is not implemented"); }
        if s.has("ironing_type") && s.text("ironing_type") != "no ironing" && !plans.iter().any(|p| p.paths.iter().any(|q| q.feature == Feature::Ironing)) { self.issue("ironing_type is set but no Ironing paths were supplied"); }

        self.mm_prepare(plans)?;
        let n = plans.len();
        self.layer_z = plans.iter().map(|p| p.z).collect();
        self.layer_h = plans.iter().map(|p| p.h).collect();
        let mut _t0 = std::time::Instant::now();
        // ---- strokes, islands -----------------------------------------------------------------------------
        let strokes: Vec<Vec<Stroke>> = plans.iter().map(|p| plan::strokes_of(&p.paths)).collect();
        // supports are printed first in a layer and enlarge the skirt hull
        let is_sup = |f: Feature| matches!(f, Feature::Support | Feature::SupportInterface | Feature::SupportTransition);
        let mut sup_strokes: Vec<Vec<Stroke>> = Vec::new();
        let strokes: Vec<Vec<Stroke>> = strokes.into_iter().map(|ss| { let (a, b): (Vec<Stroke>, Vec<Stroke>) = ss.into_iter().partition(|st| is_sup(st.feature())); sup_strokes.push(a); b }).collect();
        self.sup_strokes = sup_strokes;
        let slices: Vec<Polys> = (0..n).map(|li| {
            if let Some(sl) = self.o.slices.as_ref().and_then(|v| v.get(li)) { if !sl.is_empty() { return sl.clone(); } }
            plan::island_contours(&strokes[li], None)
        }).collect();
        self.layer_slices = slices.clone();

        crate::pipeline::stage(&mut _t0, "g.strokes");
        // ---- seam planner ---------------------------------------------------------------------------------
        let seam_pos = SeamPosition::parse(&if s.has("seam_position") { s.text("seam_position") } else { "aligned".into() });
        let specs: Vec<Vec<LoopSpec>> = strokes.iter().map(|ss| {
            let outers: Vec<&Stroke> = ss.iter().filter(|st| st.closed && st.feat.iter().any(|f| *f == Feature::OuterWall)).collect();
            let areas: Vec<f64> = outers.iter().map(|o| geo::signed_area(&o.pts).abs()).collect();
            outers.iter().enumerate().map(|(i, st)| {
                let depth = (0..outers.len()).filter(|&j| j != i && areas[j] > areas[i] && geo::in_ring(st.pts[0], &outers[j].pts)).count();
                LoopSpec { ring: st.pts.clone(), width: st.w.first().copied().unwrap_or(0.42), is_hole: depth % 2 == 1 }
            }).collect()
        }).collect();
        if specs.iter().any(|v| !v.is_empty()) {
            let needs_vis = matches!(seam_pos, SeamPosition::Aligned | SeamPosition::AlignedBack | SeamPosition::Nearest);
            let vis = if !needs_vis { None } else if let Some(m) = &self.o.seam_mesh {
                Visibility::new(&m.tris, seam_pos == SeamPosition::AlignedBack)
            } else {
                let lay: Vec<(f64, f64, &[crate::types::Poly])> = (0..n).map(|li| (self.layer_z[li], self.layer_h[li], slices[li].as_slice())).collect();
                let tris = visibility::mesh_from_layers(&lay, 16000);
                Visibility::new(&tris, seam_pos == SeamPosition::AlignedBack)
            };
            let (frame_rot_deg, frame_center) = match (&self.o.seam_mesh, &vis) { (Some(m), Some(_)) => (m.rot_deg, m.center), _ => (0.0, [0.0, 0.0]) };
            let per_obj: Vec<(Vec<P2>, Visibility)> = if needs_vis && self.o.seam_objects.len() == self.o.objects.len() && self.o.objects.len() > 1 {
                self.o.objects.iter().zip(&self.o.seam_objects).filter_map(|(o, t)| Visibility::new(t, seam_pos == SeamPosition::AlignedBack).map(|v| (o.footprint.clone(), v))).collect()
            } else { Vec::new() };
            let per_object = if per_obj.len() == self.o.objects.len() && per_obj.len() > 1 { Some(per_obj.as_slice()) } else { None };
            crate::pipeline::stage(&mut _t0, "g.seam.vis");
            let extras = SeamExtras { visibility: vis.as_ref(), frame_rot_deg, frame_center, slices: Some(slices.as_slice()), per_object };
            let sp = SeamPlanner::new_with(&specs, &self.layer_z, &self.layer_h, SeamParams { position: seam_pos, nozzle: self.p.nozzle, staggered_inner: s.flag("staggered_inner_seams") }, &extras);
            self.seam = Some(sp);
        }
        crate::pipeline::stage(&mut _t0, "g.seam");
        let islands_per_layer: Vec<(Vec<Island>, Island)> = (0..n).map(|li| plan::group_islands(strokes[li].clone(), &slices[li])).collect();
        // multi-material: the same grouping per filament (the strokes of each filament over the shared slices)
        let (mm_islands, mm_sup): (Vec<Vec<(Vec<Island>, Island)>>, Vec<Vec<Vec<Stroke>>>) = match self.mm.as_ref() {
            None => (Vec::new(), Vec::new()),
            Some(m) => {
                let is_sup2 = |f: Feature| matches!(f, Feature::Support | Feature::SupportInterface | Feature::SupportTransition);
                let mut isl: Vec<Vec<(Vec<Island>, Island)>> = Vec::with_capacity(n);
                let mut sup: Vec<Vec<Vec<Stroke>>> = Vec::with_capacity(n);
                for li in 0..n {
                    let mut row = Vec::with_capacity(m.nfil);
                    let mut srow = Vec::with_capacity(m.nfil);
                    for f in 0..m.nfil {
                        let ss = plan::strokes_of(&m.plans_f[li][f].paths);
                        let (a, b): (Vec<Stroke>, Vec<Stroke>) = ss.into_iter().partition(|st| is_sup2(st.feature()));
                        srow.push(a);
                        row.push(plan::group_islands(b, &slices[li]));
                    }
                    isl.push(row);
                    sup.push(srow);
                }
                (isl, sup)
            }
        };

        crate::pipeline::stage(&mut _t0, "g.islands");
        // ---- skirt / brim ---------------------------------------------------------------------------------
        let input_has_skirt = plans.iter().any(|p| p.paths.iter().any(|q| matches!(q.feature, Feature::Skirt | Feature::Brim)));
        let mut skirt_strokes: Vec<Stroke> = Vec::new();
        let mut brim_strokes: Vec<Stroke> = Vec::new();
        let (flw, flh, fl_spacing, _) = skirt::first_layer_flow(s);
        let mut hull_pts: Vec<P2> = Vec::new();
        let sk_layers = self.p.skirt_height.max(1).min(n);
        for li in 0..sk_layers { for pg in &slices[li] { hull_pts.extend(pg.contour.iter().copied()); } }
        for li in 0..sk_layers { for st in &self.sup_strokes[li] { hull_pts.extend(st.pts.iter().copied()); } } 
        if hull_pts.is_empty() { for li in 0..sk_layers { for st in &strokes[li] { hull_pts.extend(st.pts.iter().copied()); } } }
        let mut fl_min = [0.0, 0.0]; let mut fl_max = [0.0, 0.0];
        let mut brim_area_pts: Vec<P2> = Vec::new();
        if !input_has_skirt {
            let mut brim_issues = Vec::new();
            crate::pipeline::stage(&mut _t0, "g.sk.pre");
            let (b, pts) = skirt::make_brim(&slices[0], s, &mut brim_issues);
            crate::pipeline::stage(&mut _t0, "g.brim");
            brim_strokes = b; brim_area_pts = pts;
            for m in brim_issues { self.issue(m); }
        } else {
            self.issue("input already contains Skirt/Brim paths; the motion lane did not generate its own");
        }
        // Orca: the skirt surrounds the occupied outline = object slices plus the brim area
        hull_pts.extend(brim_area_pts.iter().copied());
        if let Some(m) = self.mm.as_ref() { hull_pts.extend(mm::tower_hull_points(m, s)); }
        if let Some((lo, hi)) = geo::bbox(&hull_pts) { fl_min = lo; fl_max = hi; }
        if !input_has_skirt {
            if let Some(sk) = skirt::make_skirt(&hull_pts, s) {
                for lp in &sk.loops {
                    let m = lp.len();
                    skirt_strokes.push(Stroke { pts: lp.clone(), w: vec![flw; m], feat: vec![Feature::Skirt; m], h: flh, speed: 0.0, flow_ratio: 1.0, closed: true });
                }
                // first-layer convex hull (outer edge of the skirt) feeds first_layer_print_min/max
                let total_dist = s.num("skirt_distance") - fl_spacing / 2.0 + s.int("skirt_loops") as f64 * fl_spacing + 0.5 * fl_spacing;
                let hull = geo::convex_hull(&hull_pts);
                let off = skirt::clipper_round_offset_convex(&hull, total_dist, 0.1);
                if let Some((lo, hi)) = geo::bbox(&off) { fl_min = lo; fl_max = hi; }
            } else if !brim_strokes.is_empty() {
                let pts: Vec<P2> = brim_strokes.iter().flat_map(|b| b.pts.iter().copied()).collect();
                if let Some((lo, hi)) = geo::bbox(&pts) { fl_min = lo; fl_max = hi; }
            }
        }
        let _ = fl_spacing;
        // 🔴 Skirt and brim on the bed (2026-11-14). pipeline::check_bed tests the MESH only; the brim and skirt are
        // made here and nothing checked them. A part 0.5 mm from the plate edge passed and its 5 mm brim went to
        // X/Y -3.94 — after the X2D start G-code has run `M211 X0 Y0 Z0` (soft endstops off), so the firmware does
        // not clip it. fl_min/fl_max is the first-layer extent (objects, brim, skirt outer edge): refused if it
        // leaves printable_area, as Orca flags toolpaths outside the print area.
        if self.p.printable_area.len() >= 3 && (!skirt_strokes.is_empty() || !brim_strokes.is_empty()) {
            if let Some((lo, hi)) = geo::bbox(&self.p.printable_area) {
                const TOL: f64 = 0.01;
                if fl_min[0] < lo[0] - TOL || fl_min[1] < lo[1] - TOL || fl_max[0] > hi[0] + TOL || fl_max[1] > hi[1] + TOL {
                    return Err(FdmError::Geometry(format!(
                        "the skirt/brim reaches x {:.2}..{:.2}, y {:.2}..{:.2}, outside the bed (x {:.1}..{:.1}, y {:.1}..{:.1}, printable_area); \
                         move the part in, or narrow the brim / skirt distance. Nothing was clipped",
                        fl_min[0], fl_max[0], fl_min[1], fl_max[1], lo[0], hi[0], lo[1], hi[1])));
                }
            }
        }

        let facts = PrintFacts { first_layer_min: fl_min, first_layer_max: fl_max, max_print_z: plans.last().unwrap().z, max_z_height: plans.last().unwrap().z, total_layers: n };
        let base = self.base_vars(&facts);

        crate::pipeline::stage(&mut _t0, "g.skirt");
        // ---- file preamble --------------------------------------------------------------------------------
        let mut head = String::new();
        let file_start = s.text("file_start_gcode");
        if !file_start.is_empty() { let t = self.expand("file_start_gcode", &file_start, &[], &base); writeln(&mut head, &t); }
        let used_filament_idx = match self.mm.as_ref() { Some(m) => m.used_filaments.iter().map(|f| (f + 1).to_string()).collect::<Vec<_>>().join(","), None => (self.initial_filament + 1).to_string() };
        let _ = write!(head, "; HEADER_BLOCK_START\n; generated by {} on {}\n", self.o.generator, self.o.timestamp);
        head.push_str(";@FDM_TIME_LINES@\n");
        // Orca counts CHANGE_LAYER tags in the finished file: the spiral vase's flat finishing loop repeats the last layer's tag
        let _ = write!(head, "; total layer number: {}\n", n + if spiral.is_some() { 1 } else { 0 });
        if self.o.objects.len() > 1 { let mut ids: Vec<u32> = self.o.objects.iter().map(|o| o.label_id).collect(); ids.sort(); let _ = write!(head, "; model label id: {}\n", ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")); } else { let _ = write!(head, "; model label id: {}\n", self.o.label_id); }
        let _ = write!(head, "; filament_density: {}\n", s.elements("filament_density").join(","));
        let _ = write!(head, "; filament_diameter: {}\n", s.elements("filament_diameter").join(","));
        let _ = write!(head, "; max_z_height: {:.2}\n", plans.last().unwrap().z);
        let _ = write!(head, "; filament: {}\n", used_filament_idx);
        head.push_str("; HEADER_BLOCK_END\n\n");
        if self.o.include_config_block {
            head.push_str("; CONFIG_BLOCK_START\n");
            for (k, v) in s.iter() {
                if k == "first_layer_bed_temperature" || k == "first_layer_temperature" { continue; }
                if k == "wipe_tower_x" || k == "wipe_tower_y" {
                    let first = v.split(',').next().unwrap_or("0").trim().parse::<f64>().unwrap_or(0.0);
                    let _ = write!(head, "; {} = {:.3}\n", k, first);
                }
                if v.is_empty() { let _ = write!(head, "; {} = \n", k); } else { let _ = write!(head, "; {} = {}\n", k, v); }
            }
            let _ = write!(head, "; first_layer_bed_temperature = {}\n; first_layer_temperature = {}\n; CONFIG_BLOCK_END\n\n", self.p.bed_temp_first, self.p.nozzle_temp_first);
        }
        // extrusion width notes
        let w2 = |k: &str| { let w = s.abs(k, self.p.nozzle); if w > 0.0 { w } else { self.p.nozzle * 1.125 } };
        let _ = write!(head, "; external perimeters extrusion width = {:.2}mm\n", w2("outer_wall_line_width"));
        let _ = write!(head, "; perimeters extrusion width = {:.2}mm\n", w2("inner_wall_line_width"));
        let _ = write!(head, "; infill extrusion width = {:.2}mm\n", w2("sparse_infill_line_width"));
        let _ = write!(head, "; solid infill extrusion width = {:.2}mm\n", w2("internal_solid_infill_line_width"));
        let _ = write!(head, "; top infill extrusion width = {:.2}mm\n", w2("top_surface_line_width"));
        if s.abs("initial_layer_line_width", self.p.nozzle) > 0.0 { let _ = write!(head, "; first layer extrusion width = {:.2}mm\n", s.abs("initial_layer_line_width", self.p.nozzle)); }
        head.push('\n');
        head.push_str("; EXECUTABLE_BLOCK_START\n");
        head.push_str(";@FDM_FIRST_M73@\n");
        // machine envelope
        if self.p.emit_machine_limits && matches!(self.p.flavor.as_str(), "marlin" | "marlin2" | "reprapfirmware") {
            let ml = |k: &str| s.machine_limit(k);
            let _ = write!(head, "M201 X{} Y{} Z{} E{}\n", (ml("machine_max_acceleration_x") + 0.5) as i64, (ml("machine_max_acceleration_y") + 0.5) as i64, (ml("machine_max_acceleration_z") + 0.5) as i64, (ml("machine_max_acceleration_e") + 0.5) as i64);
            let _ = write!(head, "M203 X{} Y{} Z{} E{}\n", (ml("machine_max_speed_x") + 0.5) as i64, (ml("machine_max_speed_y") + 0.5) as i64, (ml("machine_max_speed_z") + 0.5) as i64, (ml("machine_max_speed_e") + 0.5) as i64);
            let travel_acc = if self.p.flavor == "marlin" { ml("machine_max_acceleration_extruding") } else { ml("machine_max_acceleration_travel") };
            if self.p.flavor == "marlin2" {
                let _ = write!(head, "M204 P{} R{} T{} ; sets acceleration (P, T) and retract acceleration (R), mm/sec^2\n", (ml("machine_max_acceleration_extruding") + 0.5) as i64, (ml("machine_max_acceleration_retracting") + 0.5) as i64, (ml("machine_max_acceleration_travel") + 0.5) as i64);
            } else {
                let _ = write!(head, "M204 P{} R{} T{}\n", (ml("machine_max_acceleration_extruding") + 0.5) as i64, (ml("machine_max_acceleration_retracting") + 0.5) as i64, (travel_acc + 0.5) as i64);
            }
            let _ = write!(head, "M205 X{:.2} Y{:.2} Z{:.2} E{:.2} ; sets the jerk limits, mm/sec\n", ml("machine_max_jerk_x"), ml("machine_max_jerk_y"), ml("machine_max_jerk_z"), ml("machine_max_jerk_e"));
        }
        if s.flag("auxiliary_fan") && s.num("close_fan_the_first_x_layers") > 0.0 {
            head.push_str(&crate::motion::cooling::set_fan(0, 0, self.p.comments));
            head.push_str(&crate::motion::cooling::set_additional_fan(0, self.p.comments));
        }
        // machine start gcode
        let ms = s.text("machine_start_gcode");
        let msg = self.expand("machine_start_gcode", &ms, &[], &base);
        if !custom_sets_temp(&msg, ["M140", "M190"]) {
            if self.p.bed_temp_first >= 0 { self.last_bed_temp = self.p.bed_temp_first; let _ = write!(head, "M190 S{} ; set bed temperature and wait for it to be reached\n", self.p.bed_temp_first); }
        } else { self.last_bed_temp = self.p.bed_temp_first; }
        if !custom_sets_temp(&msg, ["M104", "M109"]) && self.p.nozzle_temp_first > 0 {
            let _ = write!(head, "M104 S{} ; set nozzle temperature\n", self.p.nozzle_temp_first);
        }
        head.push_str("; FEATURE: Custom\n");
        writeln(&mut head, &msg);
        if s.flag("enable_pre_heating") { head.push_str("; MACHINE_START_GCODE_END\n"); }
        self.pos_clear = false;
        // filament start gcode
        let fs = self.fs().text_at("filament_start_gcode", 0);
        let fsx = self.expand("filament_start_gcode", &fs, &[("layer_num", Extra::Scalar(V::Int(-1)))], &base);
        writeln(&mut head, &fsx);
        let _ = write!(head, ";VT0\n");
        head.push_str("G90\nG21\n");
        head.push_str(if self.p.relative_e { "M83 ; use relative distances for extrusion\n" } else { "M82 ; use absolute distances for extrusion\n" });
        self.pos[2] = s.num("z_offset");
        if s.has("printer_model") && s.text("printer_model").starts_with("Bambu") { head.push_str("M981 S1 P20000 ;open spaghetti detector\n"); }
        if s.flag("support_air_filtration") && s.flag("activate_air_filtration") && s.flag("activate_air_filtration_during_print") {
            let _ = write!(head, "M106 P3 S{}\n", (s.num("during_print_exhaust_fan_speed") / 100.0 * 255.0) as i64);
        }

        crate::pipeline::stage(&mut _t0, "g.preamble");
        // ---- layers ---------------------------------------------------------------------------------------
        let mut body = String::new();
        let mut cooling = match self.mm.as_ref() { Some(m) => CoolingBuffer::new_multi(&m.fil_s, [0.0, 0.0, self.pos[2]]), None => CoolingBuffer::new(s, [0.0, 0.0, self.pos[2]]) };
        let mut cool_pending = String::new();
        for li in 0..n {
            let (isl, extra) = &islands_per_layer[li];
            self.layer_retracts = 0;
            // spiral vase (GCode.cpp process_layer): the layer is spiralised when it has exactly one wall loop and no fill
            let spiral_en = spiral.is_some() && {
                let walls = plans[li].paths.iter().filter(|q| matches!(q.feature, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall)).count();
                let fills = plans[li].paths.iter().filter(|q| !matches!(q.feature, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall | Feature::Skirt | Feature::Brim | Feature::Custom)).count();
                let has_brim = s.has("brim_type") && s.text("brim_type") != "no_brim" && s.text("brim_type") != "none";
                crate::effects::spiral::spiral_layer_enabled(li, self.p.skirt_height, has_brim, false, s.int("bottom_shell_layers").max(0) as usize, walls, fills)
            };
            // Orca fits no arcs in a spiral vase (the filter only rewrites G1)
            self.p.arc_fitting = base_arc_fitting && !spiral_en;
            self.spiral_layer = spiral_en;
            if self.mm.is_some() {
                self.process_layer_mm(li, &plans[li], &mm_islands[li], &mm_sup[li], &skirt_strokes, &brim_strokes, &base)?;
            } else {
                self.process_layer(li, &plans[li], isl, extra, &skirt_strokes, &brim_strokes, &base, None);
            }
            self.st.retractions_per_layer.push(self.layer_retracts);
            let chunk = std::mem::take(&mut self.out);
            let chunk = match spiral.as_mut() { Some(sf) => sf.process_layer(&chunk, spiral_en, li + 1 == n, plans[li].z - plans[li].h, plans[li].h), None => chunk };
            // Orca's CoolingBuffer only flushes on an OBJECT layer (or the last layer): support-only layers are collected and
            // the slow-down is computed over them together with the following object layer (`cooling_buffer_flush`).
            let support_only = !plans[li].paths.is_empty() && plans[li].paths.iter().all(|p| matches!(p.feature, Feature::Support | Feature::SupportInterface | Feature::SupportTransition));
            cool_pending.push_str(&chunk);
            if !support_only || li + 1 == n {
                let merged = std::mem::take(&mut cool_pending);
                let cooled = cooling.process_layer(&merged, li, self.p.comments);
                body.push_str(&cooled);
            }
        }
        self.p.arc_fitting = base_arc_fitting;
        crate::pipeline::stage(&mut _t0, "g.layers");
        // ---- end ------------------------------------------------------------------------------------------
        self.out.clear();
        self.gen_retract(Lift::Normal, false, None);
        self.add_object_labels();
        self.out.push_str(&crate::motion::cooling::set_fan(0, 0, self.p.comments));
        if s.flag("auxiliary_fan") { self.out.push_str(&crate::motion::cooling::set_additional_fan(0, self.p.comments)); }
        if s.has("printer_model") && s.text("printer_model").starts_with("Bambu") { self.out.push_str("M981 S0 P20000 ; close spaghetti detector\n"); }
        self.out.push_str("; FEATURE: Custom\n");
        if s.flag("enable_pre_heating") { self.out.push_str("; MACHINE_END_GCODE_START\n"); }
        let fe = self.fs().text_at("filament_end_gcode", 0);
        let fex = self.expand("filament_end_gcode", &fe, &[("layer_num", Extra::Scalar(V::Int(self.layer_index))), ("layer_z", Extra::Scalar(V::Dbl(self.pos[2]))), ("max_layer_z", Extra::Scalar(V::Dbl(self.max_layer_z)))], &base);
        let mut tail = std::mem::take(&mut self.out);
        writeln(&mut tail, &fex);
        let me = s.text("machine_end_gcode");
        let mex = self.expand("machine_end_gcode", &me, &[("layer_num", Extra::Scalar(V::Int(self.layer_index))), ("layer_z", Extra::Scalar(V::Dbl(self.pos[2]))), ("max_layer_z", Extra::Scalar(V::Dbl(self.max_layer_z)))], &base);
        writeln(&mut tail, &mex);
        if s.flag("support_air_filtration") && s.flag("activate_air_filtration") && s.flag("activate_air_filtration_on_completion") {
            let _ = write!(tail, "M106 P3 S{}\n", (s.num("complete_print_exhaust_fan_speed") / 100.0 * 255.0) as i64);
        }
        tail.push_str(";@FDM_LAST_M73@\n; EXECUTABLE_BLOCK_END\n\n");

        crate::pipeline::stage(&mut _t0, "g.end");
        // ---- statistics ----------------------------------------------------------------------------------
        let stats_txt = if self.mm.is_some() {
            self.mm_stats()
        } else {
            let used_mm = self.absolute_e + self.retracted;
            let area = std::f64::consts::PI * self.p.fil_d * self.p.fil_d / 4.0;
            let vol = used_mm * area;
            self.st.layers = n;
            self.st.filament_mm = used_mm;
            self.st.filament_cm3 = vol * 0.001;
            self.st.filament_g = self.st.filament_cm3 * self.p.fil_density;
            self.st.filament_cost = self.st.filament_g * self.p.fil_cost * 0.001;
            format!("; filament used [mm] = {:.2}\n; filament used [cm3] = {:.2}\n; filament used [g] = {:.2}\n; filament cost = {:.2}\n", self.st.filament_mm, self.st.filament_cm3, self.st.filament_g, self.st.filament_cost)
        };
        self.st.layers = n;

        crate::pipeline::stage(&mut _t0, "g.stats");
        // ---- assemble and annotate with the time estimate -----------------------------------------------
        let mut text = String::with_capacity(head.len() + body.len() + tail.len() + 1024);
        text.push_str(&head);
        text.push_str(&body);
        text.push_str(&tail);
        text.push_str(&stats_txt);
        text.push('\n');
        crate::pipeline::stage(&mut _t0, "g.assemble");
        let est = time::estimate(&text, s);
        crate::pipeline::stage(&mut _t0, "g.estimate");
        let text = finalize_time(&text, &est);
        crate::pipeline::stage(&mut _t0, "g.finalize");
        Ok(GcodeOutput { gcode: text, time: est, stats: std::mem::take(&mut self.st), issues: std::mem::take(&mut self.issues) })
    }
}

fn is_empty_island(i: &Island) -> bool { i.walls.is_empty() && i.infill.is_empty() && i.ironing.is_empty() && i.other.is_empty() }

fn nearest_point_on(st: &Stroke, p: P2) -> P2 {
    let (seg, t, _) = geo::closest_on_ring(&st.pts, p);
    geo::lerp(st.pts[seg], st.pts[(seg + 1) % st.pts.len()], t)
}

fn last_z_in(gcode: &str) -> Option<f64> {
    let mut z = None;
    for l in gcode.lines() {
        let t = l.trim_start();
        if t.starts_with("G1 ") || t.starts_with("G0 ") {
            for w in t.split_whitespace() { if let Some(v) = w.strip_prefix('Z') { if let Ok(x) = v.parse::<f64>() { z = Some(x); } } }
        }
    }
    z
}

/// Orca `GCode::_encode_label_ids_to_base64`: bit set of the object index (a single object => bit 0), 8 bytes
/// little-endian, base64. The unique label id of the instance maps to its index in the sorted label list (0 for one object).
fn label_base64(_label_id: u32, _model: &str) -> String {
    // single object: bitset = 1 << 0
    let bytes = [1u8, 0, 0, 0, 0, 0, 0, 0];
    b64(&bytes)
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for ch in data.chunks(3) {
        let b = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
        out.push(T[(b[0] >> 2) as usize] as char);
        out.push(T[(((b[0] & 3) << 4) | (b[1] >> 4)) as usize] as char);
        if ch.len() > 1 { out.push(T[(((b[1] & 15) << 2) | (b[2] >> 6)) as usize] as char); } else { out.push('='); }
        if ch.len() > 2 { out.push(T[(b[2] & 63) as usize] as char); } else { out.push('='); }
    }
    out
}

/// Replace the time placeholders and insert `M73 P.. R..` lines like `GCodeProcessor::post_process`.
fn finalize_time(text: &str, est: &TimeEstimate) -> String {
    let total = est.total_s;
    let time_in_minutes = |t: f64| ((t + 0.5) / 60.0).floor() as i64;
    let mut out = String::with_capacity(text.len() + text.len() / 40);
    let cache: BTreeMap<i64, f64> = est.g1_times.iter().cloned().collect();
    let mut g1_counter: i64 = 0;
    let mut arc_i = 0usize;
    let mut last_main = (0i64, time_in_minutes(total));
    for line in text.split_inclusive('\n') {
        let t = line.trim_end_matches('\n');
        if t == ";@FDM_TIME_LINES@" {
            let _ = write!(out, "; model printing time: {}; total estimated time: {}\n", time::fmt_dhms(est.model_s), time::fmt_dhms(est.total_s));
            let _ = write!(out, "; estimated first layer printing time (normal mode) = {}\n", time::fmt_dhms(est.prepare_s));
            continue;
        }
        if t == ";@FDM_FIRST_M73@" { let _ = write!(out, "M73 P0 R{}\n", time_in_minutes(total)); continue; }
        if t == ";@FDM_LAST_M73@" { out.push_str("M73 P100 R0\n"); continue; }
        if t.contains("@PRINT_TIME_SEC@") { out.push_str(&line.replace("@PRINT_TIME_SEC@", &format!("{:.2}", total))); continue; }
        out.push_str(line);
        let tt = t.trim_start();
        let cmd_is = |c: &str| tt.starts_with(c) && tt[c.len()..].starts_with(|ch: char| ch == ' ' || ch == ';' || ch.is_whitespace()) || tt == c;
        if cmd_is("G0") || cmd_is("G1") {
            if let Some(el) = cache.get(&g1_counter) {
                let main = ((100.0 * el / total) as i64, time_in_minutes(total - el));
                if main != last_main { let _ = write!(out, "M73 P{} R{}\n", main.0, main.1); last_main = main; }
            }
            g1_counter += 1;
        } else if cmd_is("G2") || cmd_is("G3") {
            // arc: the estimator reserves one id per chord and caches the last one
            let steps = est.arc_steps.get(arc_i).copied().unwrap_or(1);
            arc_i += 1;
            let id = g1_counter + steps - 1;
            if let Some(el) = cache.get(&id) {
                let main = ((100.0 * el / total) as i64, time_in_minutes(total - el));
                if main != last_main { let _ = write!(out, "M73 P{} R{}\n", main.0, main.1); last_main = main; }
            }
            g1_counter += steps;
        } else if cmd_is("G28") {
            g1_counter += 1;
        }
    }
    out
}


// ---------------------------------------------------------------------------------------------------------------
// spiral vase: port of `GCode/SpiralVase.cpp::process_layer`. Orca runs it as a TEXT filter over each layer's G-code
// (before the cooling buffer), so this does the same: the layer is generated normally, then every extruding XY move
// gets `Z = z_prev + (cumulative XY length / layer XY length) * layer_h`, travels / retractions / short moves are
// dropped, the first spiral layer ramps its flow from `spiral_starting_flow_ratio` to 100 %, the last layer is
// followed by a flat copy of the loop whose flow ramps 100 % -> `spiral_finishing_flow_ratio` (relative E only, like
// Orca), and `spiral_mode_smooth` blends XY with the closest point of the previous layer's loop.
// ---------------------------------------------------------------------------------------------------------------
mod spiral_filter {
    use crate::motion::fmt_axis;
    /// Orca `GCodeLine::set(E, v, 5)`: `%.5f` with trailing zeros trimmed (`0.00034`, `1.5`).
    fn fmt_e_mod(v: f64) -> String { let s = format!("{:.5}", v); let t = s.trim_end_matches('0').trim_end_matches('.'); if t.is_empty() || t == "-" { "0".into() } else { t.to_string() } }
    #[derive(Clone, Default)]
    struct Rd { x: f64, y: f64, z: f64, e: f64 }
    pub struct SpiralFilter {
        smooth: bool, max_xy: f64, start_ratio: f64, finish_ratio: f64, min_seg: f64, relative_e: bool,
        enabled: bool, prev: Option<Vec<[f64; 2]>>, rd: Rd,
    }
    struct Line<'a> { raw: &'a str, cmd: String, words: Vec<(char, f64)>, toks: Vec<(char, &'a str)> }
    fn parse(raw: &str) -> Line<'_> {
        let body = raw.split(';').next().unwrap_or("");
        let mut it = body.split_whitespace();
        let cmd = it.next().unwrap_or("").to_string();
        let mut words = Vec::new();
        let mut toks = Vec::new();
        if cmd.starts_with('G') || cmd.starts_with('g') {
            for w in it { let mut c = w.chars(); if let Some(a) = c.next() { if let Ok(v) = c.as_str().parse::<f64>() { words.push((a.to_ascii_uppercase(), v)); toks.push((a.to_ascii_uppercase(), w)); } } }
        }
        Line { raw, cmd, words, toks }
    }
    impl Line<'_> {
        fn get(&self, a: char) -> Option<f64> { self.words.iter().find(|w| w.0 == a).map(|w| w.1) }
        fn is(&self, c: &str) -> bool { self.cmd == c }
        /// The word exactly as written (Orca keeps untouched fields verbatim, e.g. `E.02757`).
        fn tok(&self, a: char) -> Option<&str> { self.toks.iter().find(|w| w.0 == a).map(|w| w.1) }
    }
    impl SpiralFilter {
        pub fn new(smooth: bool, max_xy: f64, start_ratio: f64, finish_ratio: f64, resolution: f64, relative_e: bool) -> Self {
            SpiralFilter { smooth, max_xy, start_ratio, finish_ratio, min_seg: (2.0 * resolution).max(1e-4), relative_e, enabled: false, prev: None, rd: Rd::default() }
        }
        fn de(&self, l: &Line, rd: &Rd) -> f64 { match l.get('E') { None => 0.0, Some(e) => if self.relative_e { e } else { e - rd.e } } }
        /// Advance the reader over one parsed line (what `GCodeReader::parse_buffer` does).
        fn advance(&self, l: &Line, rd: &mut Rd) {
            if l.is("G92") { if let Some(e) = l.get('E') { rd.e = e; } return; }
            if l.is("G0") || l.is("G1") || l.is("G2") || l.is("G3") {
                if let Some(v) = l.get('X') { rd.x = v; }
                if let Some(v) = l.get('Y') { rd.y = v; }
                if let Some(v) = l.get('Z') { rd.z = v; }
                if let Some(v) = l.get('E') { rd.e = if self.relative_e { 0.0 } else { v }; }
            }
        }
        fn dist_xy(l: &Line, rd: &Rd) -> f64 {
            let nx = l.get('X').unwrap_or(rd.x); let ny = l.get('Y').unwrap_or(rd.y);
            (nx - rd.x).hypot(ny - rd.y)
        }
        pub fn feed(&mut self, text: &str) { let mut rd = self.rd.clone(); for raw in text.lines() { let l = parse(raw); self.advance(&l, &mut rd); } self.rd = rd; }
        fn nearest(p: [f64; 2], pts: &[[f64; 2]]) -> Option<([f64; 2], f64)> {
            if pts.len() < 2 { return None; }
            let mut best = (f64::MAX, [0.0, 0.0]);
            for w in pts.windows(2) {
                let (a, b) = (w[0], w[1]);
                let ab = [b[0] - a[0], b[1] - a[1]]; let ca = [p[0] - a[0], p[1] - a[1]];
                let dd = ab[0] * ab[0] + ab[1] * ab[1];
                let t = if dd == 0.0 { 0.0 } else { ((ca[0] * ab[0] + ca[1] * ab[1]) / dd).clamp(0.0, 1.0) };
                let c = [a[0] + ab[0] * t, a[1] + ab[1] * t];
                let d = (p[0] - c[0]).hypot(p[1] - c[1]);
                if d < best.0 { best = (d, c); }
            }
            Some((best.1, best.0))
        }
        /// One layer's G-code in, the (possibly spiralised) G-code out. `z_prev` = top of the previous layer.
        pub fn process_layer(&mut self, text: &str, enable: bool, last_layer: bool, z_prev: f64, layer_h: f64) -> String {
            let transition_layer = enable && !self.enabled;
            self.enabled = enable;
            if !enable { self.feed(text); return text.to_string(); }
            // pass 1: total XY length of the extruding moves
            let mut rd = self.rd.clone();
            let mut total = 0.0;
            for raw in text.lines() {
                let l = parse(raw);
                if l.is("G1") && self.de(&l, &rd) > 0.0 { total += Self::dist_xy(&l, &rd); }
                self.advance(&l, &mut rd);
            }
            let transition_in = transition_layer && self.relative_e;
            let transition_out = last_layer && self.relative_e;
            let mut out = String::with_capacity(text.len());
            let mut trans = String::new();
            let mut cur: Vec<[f64; 2]> = Vec::new();
            let prev = self.prev.take();
            let mut last_point = prev.as_ref().and_then(|v| v.last().copied()).unwrap_or([0.0, 0.0]);
            let mut len = 0.0;
            let mut rd = self.rd.clone();
            for raw in text.lines() {
                let l = parse(raw);
                let (de, dxy) = if l.is("G1") { (self.de(&l, &rd), Self::dist_xy(&l, &rd)) } else { (0.0, 0.0) };
                let keep_raw = |out: &mut String, trans: &mut String| { out.push_str(raw); out.push('\n'); if transition_out { trans.push_str(raw); trans.push('\n'); } };
                if l.is("G1") {
                    let extruding = de > 0.0;
                    if de < 0.0 || (extruding && dxy < self.min_seg) { self.advance(&l, &mut rd); continue; }
                    let has_xy = l.get('X').is_some() || l.get('Y').is_some();
                    if l.get('Z').is_some() && !has_xy {
                        // the layer's initial Z move becomes a (redundant) move to the previous layer's top
                        let mut s = format!("G1 Z{:.3}", z_prev);
                        if let Some(f) = l.get('F') { s.push_str(&format!(" F{}", fmt_axis(f, 0))); }
                        out.push_str(&s); out.push('\n');
                        self.advance(&l, &mut rd);
                        continue;
                    }
                    if has_xy {
                        if dxy > 0.0 && extruding {
                            len += dxy;
                            let factor = if total > 0.0 { len / total } else { 1.0 };
                            let (mut x, mut y) = (l.get('X').unwrap_or(rd.x), l.get('Y').unwrap_or(rd.y));
                            let mut e = de;
                            let mut skip = false;
                            let mut modified_xy = false;
                            if transition_in { e *= self.start_ratio + factor * (1.0 - self.start_ratio); }
                            else if transition_out {
                                let fe = self.finish_ratio + (1.0 - factor) * (1.0 - self.finish_ratio);
                                trans.push_str(&format!("G1 X{} Y{} E{}\n", fmt_axis(x, 3), fmt_axis(y, 3), fmt_axis(de * fe, 5)));
                            }
                            let z = z_prev + factor * layer_h;
                            if self.smooth {
                                cur.push([x, y]);
                                if let Some(pv) = &prev {
                                    match Self::nearest([x, y], pv) {
                                        Some((np, d)) if d < self.max_xy => {
                                            let t = [np[0] * (1.0 - factor) + x * factor, np[1] * (1.0 - factor) + y * factor];
                                            let md = (last_point[0] - t[0]).hypot(last_point[1] - t[1]);
                                            if md < self.min_seg { skip = true; } else {
                                                e = e * md / dxy; x = t[0]; y = t[1]; last_point = t; modified_xy = true;
                                            }
                                        }
                                        _ => { last_point = [x, y]; }
                                    }
                                }
                            }
                            if !skip {
                                let xs = if modified_xy { fmt_axis(x, 3) } else { l.tok('X').map(|t| t[1..].to_string()).unwrap_or_else(|| fmt_axis(x, 3)) };
                                let ys = if modified_xy { fmt_axis(y, 3) } else { l.tok('Y').map(|t| t[1..].to_string()).unwrap_or_else(|| fmt_axis(y, 3)) };
                                let es = if (e - de).abs() < 1e-12 { l.tok('E').map(|t| t[1..].to_string()).unwrap_or_else(|| fmt_axis(e, 5)) } else { fmt_e_mod(e) };
                                let mut s = format!("G1 Z{:.3} X{} Y{} E{}", z, xs, ys, es);
                                if let Some(f) = l.get('F') { s.push_str(&format!(" F{}", fmt_axis(f, 0))); }
                                out.push_str(&s); out.push('\n');
                            }
                        }
                        // travel moves are dropped: the blend into the first loop point replaces them
                        self.advance(&l, &mut rd);
                        continue;
                    }
                }
                keep_raw(&mut out, &mut trans);
                self.advance(&l, &mut rd);
            }
            self.rd = rd;
            self.prev = Some(cur);
            out.push_str(&trans);
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_retract_that_retracts_nothing_keeps_the_restart_extra_it_had() {
        // Orca Extruder::retract: m_restart_extra changes only when something is retracted.
        let s = Settings::default();
        let o = GcodeOptions::default();
        let mut g = Gen::new(&s, &o, &[]);
        g.writer_retract(0.8, 0.1);
        g.writer_retract(0.8, 0.5);
        assert!((g.restart_extra - 0.1).abs() < 1e-12, "restart_extra {} after a retract of nothing", g.restart_extra);
    }

    #[test]
    fn parse_bed_reads_every_corner_of_printable_area() {
        // 🔴 Read as ONE element and split once on 'x' until 2026-11-14: the bed was always empty, so every bed
        // check (spiral_fits, the skirt/brim check) passed by not running.
        let mut s = Settings::default();
        s.set("printable_area", "0x0,256x0,256x256,0x256");
        assert_eq!(parse_bed(&s), vec![[0.0, 0.0], [256.0, 0.0], [256.0, 256.0], [0.0, 256.0]]);
    }
    use crate::types::PathPt;

    pub fn cfg_from_ref() -> Option<Settings> {
        let t = std::fs::read_to_string(format!("{}/cube_ref.gcode", ref_dir())).ok()?;
        Some(Settings::from_config_block(&t))
    }

    fn square_loop(f: Feature, x0: f64, y0: f64, s: f64, w: f64, h: f64) -> ExtPathHelper {
        ExtPathHelper { f, pts: vec![[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]], w, h }
    }
    struct ExtPathHelper { f: Feature, pts: Vec<[f64; 2]>, w: f64, h: f64 }
    impl ExtPathHelper {
        fn to_path(&self, closed: bool) -> crate::types::ExtPath {
            crate::types::ExtPath { feature: self.f, pts: self.pts.iter().map(|p| PathPt { x: p[0], y: p[1], w: self.w }).collect(), closed, layer_h: self.h, speed: 0.0, flow_ratio: 1.0 }
        }
    }

    #[test]
    fn b64_matches_orca_label() {
        assert_eq!(label_base64(14, ""), "AQAAAAAAAAA=");
    }

    #[test]
    fn minimal_print_is_complete() {
        let Some(cfg) = cfg_from_ref() else { eprintln!("PENDING: cube_ref.gcode not present"); return; };
        let mut plans = Vec::new();
        for k in 0..6 {
            let z = 0.2 * (k + 1) as f64;
            let w = if k == 0 { 0.5 } else { 0.42 };
            let outer = square_loop(Feature::OuterWall, 128.5, 118.25, 19.5, w, 0.2);
            let inner = square_loop(Feature::InnerWall, 129.0, 118.75, 18.5, 0.45, 0.2);
            plans.push(LayerPlan { z, h: 0.2, paths: vec![inner.to_path(true), outer.to_path(true)] });
        }
        let out = generate(&plans, &cfg, &GcodeOptions::default()).unwrap();
        let g = &out.gcode;
        assert!(g.contains("; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; LAYER_HEIGHT: 0.2\n"));
        assert!(g.contains("; FEATURE: Skirt\n; LINE_WIDTH: 0.5\n"));
        assert!(g.contains("; FEATURE: Outer wall"));
        assert!(g.contains("M624 AQAAAAAAAAA="));
        assert!(g.contains("EXECUTABLE_BLOCK_END"));
        eprintln!("issues: {:?}", out.issues);
        
    }

    /// Reference G-code written by OrcaSlicer 2.5.0-dev (see the lane report for how the files were produced).
    /// Directory: `$FDM_L5_REF_DIR`, default `/tmp/fdm-l5`. A missing file means PENDING, never a pass.
    fn ref_dir() -> String { std::env::var("FDM_L5_REF_DIR").unwrap_or_else(|_| "/tmp/fdm-l5".into()) }
    fn read_ref(name: &str) -> Option<String> {
        let d = ref_dir();
        std::fs::read_to_string(format!("{}/{}_ref.gcode", d, name)).ok().or_else(|| std::fs::read_to_string(format!("{}/{}.gcode", d, name)).ok())
    }

    fn compare(name: &str) -> Option<(String, crate::motion::testutil::Stats, crate::motion::testutil::Stats, GcodeOutput)> {
        use crate::motion::testutil::*;
        let reft = read_ref(name)?;
        let cfg = Settings::from_config_block(&reft);
        let plans = plans_from_gcode(&reft);
        let mut opts = GcodeOptions::default();
        opts.object_name = format!("{}.stl", name);
        let out = generate(&plans, &cfg, &opts).unwrap();
        let so = stats_of(&reft);
        let sm = stats_of(&out.gcode);
        let _ = std::fs::write(format!("{}/{}_ours.gcode", ref_dir(), name), &out.gcode);
        Some((reft, so, sm, out))
    }

    fn report(name: &str, reft: &str, so: &crate::motion::testutil::Stats, sm: &crate::motion::testutil::Stats, out: &GcodeOutput) {
        eprintln!("==== {} ====", name);
        eprintln!("layers: orca {} ours {}", so.layers, sm.layers);
        let mut keys: Vec<&String> = so.path_mm.keys().chain(sm.path_mm.keys()).collect();
        keys.sort(); keys.dedup();
        for k in keys {
            let (a, b) = (so.path_mm.get(k).copied().unwrap_or(0.0), sm.path_mm.get(k).copied().unwrap_or(0.0));
            eprintln!("  {:<24} orca {:>10.1} ours {:>10.1} ({:+.2}%)   E orca {:>9.2} ours {:>9.2}", k, a, b, if a > 0.0 { (b - a) / a * 100.0 } else { 0.0 }, so.e_mm.get(k).copied().unwrap_or(0.0), sm.e_mm.get(k).copied().unwrap_or(0.0));
        }
        eprintln!("  retractions: orca {} ours {}   retracted mm: orca {:.1} ours {:.1}", so.retractions, sm.retractions, so.retracted_mm, sm.retracted_mm);
        eprintln!("  net filament mm: orca {:.2} ours {:.2}  (header {:.2})", so.extruded_mm, sm.extruded_mm, out.stats.filament_mm);
        eprintln!("  travel mm: orca {:.0} ours {:.0}", so.travel_mm, sm.travel_mm);
        let (om, ot) = crate::motion::time::parse_header_times(reft).unwrap_or((0.0, 0.0));
        eprintln!("  time: orca model {} total {} | ours model {} total {}", crate::motion::time::fmt_dhms(om), crate::motion::time::fmt_dhms(ot), crate::motion::time::fmt_dhms(out.time.model_s), crate::motion::time::fmt_dhms(out.time.total_s));
        eprintln!("  issues: {:?}", out.issues);
    }

    fn pct(a: f64, b: f64) -> f64 { if b == 0.0 { 0.0 } else { (a - b) / b * 100.0 } }

    /// One roundtrip: Orca's file -> plans -> our file; asserts against Orca's own numbers. Returns false when the
    /// reference is missing (PENDING).
    fn check(name: &str, retract_tol_pct: f64, min_seam_pct: f64) -> bool {
        use crate::motion::testutil::*;
        let Some((reft, so, sm, out)) = compare(name) else { eprintln!("PENDING: reference {} not found in {}", name, ref_dir()); return false; };
        report(name, &reft, &so, &sm, &out);
        let (ok, tot) = seam_match(&reft, &out.gcode);
        let (_, ot) = crate::motion::time::parse_header_times(&reft).expect("orca header time");
        assert_eq!(so.layers, sm.layers, "{}: layer count", name);
        assert!(pct(sm.retractions as f64, so.retractions as f64).abs() <= retract_tol_pct, "{}: retractions {} vs orca {}", name, sm.retractions, so.retractions);
        assert!(pct(sm.retracted_mm, so.retracted_mm).abs() <= retract_tol_pct + 1.0, "{}: retracted mm {} vs {}", name, sm.retracted_mm, so.retracted_mm);
        assert!(pct(sm.extruded_mm, so.extruded_mm).abs() <= 0.2, "{}: filament {} vs {}", name, sm.extruded_mm, so.extruded_mm);
        assert!(pct(out.time.total_s, ot).abs() <= 1.0, "{}: time {} vs {}", name, out.time.total_s, ot);
        for (k, a) in &so.path_mm {
            let b = sm.path_mm.get(k).copied().unwrap_or(0.0);
            if *a > 50.0 { assert!(pct(b, *a).abs() <= 0.5, "{}: {} path {} vs {}", name, k, b, a); }
        }
        assert!(tot == 0 || 100.0 * ok as f64 / tot as f64 >= min_seam_pct, "{}: seams {}/{}", name, ok, tot);
        assert!(out.gcode.contains("; EXECUTABLE_BLOCK_END") && out.gcode.contains("; filament used [mm]"));
        true
    }

    #[test]
    fn cube_matches_orca() { check("cube", 1.0, 99.0); }
    #[test]
    fn ring_matches_orca() { check("ring", 2.0, 99.0); }
    /// Hard case: 4 islands per layer with holes, bridges, overhangs, 60 layers. Seams there depend on the mesh
    /// visibility term this lane does not have (see seam.rs), hence the low seam bar; retractions within 4 %.
    #[test]
    fn coupon_matches_orca() { check("coupon", 4.0, 30.0); }

    /// Settings variants sliced by Orca itself (process-level `set=` overrides): skirt, brim, seam modes, speeds,
    /// accelerations, jerks, wall order, infill-first. `var_seam_random` cannot match (its seed is the ring start
    /// vertex of Orca's internal polygon, which an output file no longer carries) and is only sanity-checked.
    #[test]
    fn process_variants_match_orca() {
        let mut ran = 0;
        for (n, rt, seam) in [("var_brim", 2.0, 99.0), ("var_seam_nearest", 2.0, 95.0), ("var_seam_rear", 1.0, 99.0), ("var_skirt3", 1.0, 99.0), ("var_ring_brim", 3.0, 99.0),
                              ("var_infillfirst", 1.0, 99.0), ("var_speed", 1.0, 99.0), ("var_accel", 1.0, 99.0), ("var_jerk", 1.0, 99.0), ("var_wallseq", 1.0, 99.0), ("var_ironing", 1.0, 99.0)] {
            if check(n, rt, seam) { ran += 1; }
        }
        eprintln!("process variants examined: {}", ran);
    }

    /// Printer/filament-level retraction, wipe and z-hop options (filament overrides, sliced by the Orca CLI on a patched
    /// filament preset). Every variant must make exactly the same retract / lift / wipe decisions as Orca.
    #[test]
    fn retraction_variants_make_orca_decisions() {
        use crate::motion::testutil::*;
        let mut ran = 0;
        for n in ["opt_check", "opt_zhop_normal", "opt_zhop_slope", "opt_zhop_auto", "opt_rcl", "opt_wipe", "opt_mintravel", "opt_zhop08", "opt_restart", "opt_retlen", "opt_nowipe"] {
            let Some((reft, _so, _sm, out)) = compare(n) else { eprintln!("PENDING: {}", n); continue; };
            ran += 1;
            assert_eq!(lift_signature(&reft), lift_signature(&out.gcode), "{}: retract/lift/wipe decisions differ from Orca", n);
        }
        eprintln!("retraction variants examined: {}", ran);
    }

    /// Corpus round trip (PENDING without `FDM_RT_LIST`): for every Orca G-code listed in the file `$FDM_RT_LIST`
    /// (one path per line), rebuild the plans from Orca's own extrusion moves, run this lane on them and print one
    /// line of retract / z-hop / arc / fan / seam numbers beside Orca's. Because the INPUT paths are Orca's, any
    /// difference is a motion/G-code cause, never an upstream one. Never asserts: it measures.
    #[test]
    fn corpus_roundtrip_report() {
        use crate::motion::testutil::*;
        let Ok(list) = std::env::var("FDM_RT_LIST") else { eprintln!("PENDING: FDM_RT_LIST not set"); return; };
        let count = |t: &str, pat: &str| t.lines().filter(|l| l.starts_with(pat)).count();
        let mut n = 0;
        for path in std::fs::read_to_string(&list).unwrap().lines().map(str::trim).filter(|l| !l.is_empty()) {
            let Ok(reft) = std::fs::read_to_string(path) else { eprintln!("RT {} UNREADABLE", path); continue; };
            let cfg = Settings::from_config_block(&reft);
            let plans = plans_from_gcode(&reft);
            if plans.is_empty() { eprintln!("RT {} NO-PLANS", path); continue; }
            let mut opts = GcodeOptions::default();
            opts.include_config_block = false;
            opts.roundtrip = true;
            let out = match generate(&plans, &cfg, &opts) { Ok(o) => o, Err(e) => { eprintln!("RT {} REFUSED {}", path, e); continue; } };
            if let Ok(dir) = std::env::var("FDM_RT_OUT") { let _ = std::fs::write(format!("{}/{}.gcode", dir, std::path::Path::new(path).parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().to_string()).unwrap_or_default()), &out.gcode); }
            let (so, sm) = (stats_of(&reft), stats_of(&out.gcode));
            let (ok, tot) = seam_match(&reft, &out.gcode);
            let (zo, zm) = (lift_signature(&reft), lift_signature(&out.gcode));
            let g = |m: &std::collections::BTreeMap<String, usize>, k: &str| m.get(k).copied().unwrap_or(0);
            let (hm_o, ht_o) = crate::motion::time::parse_header_times(&reft).unwrap_or((0.0, 0.0));
            let (hm_m, ht_m) = crate::motion::time::parse_header_times(&out.gcode).unwrap_or((0.0, 0.0));
            eprintln!("RT2 {} time model {:.0}/{:.0} total {:.0}/{:.0} M73 {}/{}", std::path::Path::new(path).parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), hm_o, hm_m, ht_o, ht_m, count(&reft, "M73"), count(&out.gcode, "M73"));
            eprintln!("RT {} layers {}/{} retract {}/{} zhop(G1Z+spiral+XYZ) {}/{} arcs(G2G3) {}/{} fanM106 {}/{} wipe {}/{} seam {}/{}",
                std::path::Path::new(path).parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                so.layers, sm.layers, so.retractions, sm.retractions,
                g(&zo, "G1 Z") + g(&zo, "spiral") + g(&zo, "G1 XYZ"), g(&zm, "G1 Z") + g(&zm, "spiral") + g(&zm, "G1 XYZ"),
                count(&reft, "G2 ") + count(&reft, "G3 "), count(&out.gcode, "G2 ") + count(&out.gcode, "G3 "),
                count(&reft, "M106"), count(&out.gcode, "M106"), g(&zo, "wipe"), g(&zm, "wipe"), ok, tot);
            n += 1;
        }
        eprintln!("RT examined {} files", n);
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        // bare settings: no CONFIG_BLOCK at all
        let cfg = Settings::new();
        let mk = |pts: Vec<(f64, f64)>, closed: bool, f: Feature| crate::types::ExtPath { feature: f, pts: pts.into_iter().map(|p| PathPt { x: p.0, y: p.1, w: 0.42 }).collect(), closed, layer_h: 0.2, speed: 0.0, flow_ratio: 0.0 };
        let plans = vec![
            LayerPlan { z: 0.2, h: 0.2, paths: vec![mk(vec![(10.0, 10.0), (10.0, 10.0)], false, Feature::SparseInfill), mk(vec![(0.0, 0.0), (5.0, 0.0), (5.0, 5.0)], true, Feature::OuterWall), mk(vec![(1.0, 1.0)], false, Feature::InnerWall)] },
            LayerPlan { z: 0.4, h: 0.2, paths: vec![] }, // empty layer is skipped
            LayerPlan { z: 0.6, h: 0.2, paths: vec![mk(vec![(0.0, 0.0), (20.0, 0.0)], false, Feature::TopSurface)] },
        ];
        let out = generate(&plans, &cfg, &GcodeOptions::default()).unwrap();
        assert!(out.gcode.contains("; CHANGE_LAYER"));
        assert!(out.issues.iter().any(|i| i.contains("empty LayerPlan")), "{:?}", out.issues);
        assert!(generate(&[], &cfg, &GcodeOptions::default()).is_err());
        assert!(generate(&[LayerPlan { z: 0.2, h: 0.2, paths: vec![] }], &cfg, &GcodeOptions::default()).is_err());
    }

    #[test]
    fn spiral_vase_with_support_layers_is_refused() {
        let mut cfg = Settings::new();
        cfg.set("spiral_mode", "1");
        let p = |f| crate::types::ExtPath { feature: f, pts: vec![PathPt { x: 0.0, y: 0.0, w: 0.4 }, PathPt { x: 5.0, y: 0.0, w: 0.4 }], closed: false, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 };
        let plans = vec![LayerPlan { z: 0.2, h: 0.2, paths: vec![p(Feature::OuterWall), p(Feature::Support)] }];
        match generate(&plans, &cfg, &GcodeOptions::default()) { Err(FdmError::Unsupported(m)) => assert!(m.contains("spiral")), other => panic!("expected Unsupported, got {:?}", other.map(|o| o.issues)) }
    }

    /// The spiral filter on a synthetic layer: travel and retraction dropped, Z ramps linearly with the XY length, the
    /// first spiral layer ramps its flow, the last layer is followed by a flat finishing loop.
    #[test]
    fn spiral_filter_ramps_z_and_drops_travel() {
        use super::spiral_filter::SpiralFilter;
        let layer = "; CHANGE_LAYER\nG1 E-.8 F1800\nG1 Z0.600 F60000\nG1 X10 Y0 F30000\nG1 E.8\nG1 F600\nG1 X20 Y0 E1\nG1 X20 Y10 E1\nG1 X10 Y10 E1\nG1 X10 Y0 E1\n";
        // layer 2 of 0.2 mm: z_prev 0.4; total XY length = 10+10+10+10 = 40 (the travel to X10 is not extruding)
        let mut f = SpiralFilter::new(false, 0.8, 0.0, 0.0, 0.012, true);
        let out = f.process_layer(layer, true, false, 0.4, 0.2);
        assert!(out.contains("G1 Z0.400 F60000"), "{out}");
        assert!(!out.contains("E-.8") && !out.contains("G1 X10 Y0 F30000") && !out.contains("E.8\n"), "{out}");
        let zs: Vec<f64> = out.lines().filter(|l| l.starts_with("G1 Z") && l.contains(" X")).map(|l| l[4..].split_whitespace().next().unwrap().parse().unwrap()).collect();
        assert_eq!(zs, vec![0.45, 0.5, 0.55, 0.6]);
        // first spiral layer: E scaled 0 -> 100 % with the cumulative factor
        let es: Vec<f64> = out.lines().filter(|l| l.contains(" X")).map(|l| l.split(" E").nth(1).unwrap().trim().parse().unwrap()).collect();
        assert_eq!(es, vec![0.25, 0.5, 0.75, 1.0]);
        // second spiral layer: E untouched; last layer: a flat copy with E ramping 100 % -> 0
        let out2 = f.process_layer(layer, true, true, 0.6, 0.2);
        let tail: Vec<&str> = out2.lines().filter(|l| l.starts_with("G1 X") && l.contains(" E")).collect();
        assert_eq!(tail.len(), 4, "{out2}");
        assert!(tail[0].ends_with("E.75") && tail[3].ends_with("E0"), "{tail:?}");
        // a non-spiral layer passes through unchanged
        assert_eq!(f.process_layer(layer, false, false, 0.8, 0.2), layer);
    }

    /// Deterministic fuzz: random loops / lines / holes over several layers must never panic, never emit NaN and must
    /// keep E finite and the move count positive.
    #[test]
    fn fuzz_random_layers_never_panic() {
        // Reference settings: the L5 cube reference, else the multi-material corpus fixture (a real Orca CONFIG_BLOCK; the L5 dir
        // lived in /tmp and is gone after a cleanup). With neither, the empty Settings give a zero time estimate: the time
        // assertion is then reported PENDING, never passed.
        let fixture_cfg = || {
            let dir = std::env::var("FDM_MM_FIX").unwrap_or_else(|_| format!("{}/build/fdm-corpus/mm", std::env::var("HOME").unwrap_or_default()));
            std::fs::read_to_string(format!("{dir}/orca.gcode")).ok().map(|t| Settings::from_config_block(&t))
        };
        let real_cfg = cfg_from_ref().or_else(fixture_cfg);
        let have_cfg = real_cfg.is_some();
        if !have_cfg { eprintln!("PENDING: no reference settings (FDM_L5_REF_DIR / FDM_MM_FIX): time estimate not asserted"); }
        let cfg = real_cfg.unwrap_or_else(Settings::new);
        let mut seed: u64 = 0x2bee_f00d;
        let mut rnd = move || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((seed >> 33) as f64) / ((1u64 << 31) as f64) };
        let feats = [Feature::OuterWall, Feature::InnerWall, Feature::OverhangWall, Feature::SparseInfill, Feature::InternalSolidInfill, Feature::TopSurface, Feature::BottomSurface, Feature::InternalBridge, Feature::Bridge, Feature::GapInfill, Feature::Ironing, Feature::Support];
        for round in 0..60 {
            let mut plans = Vec::new();
            for l in 0..(2 + round % 5) {
                let mut paths = Vec::new();
                for _ in 0..(1 + (rnd() * 8.0) as usize) {
                    let f = feats[(rnd() * feats.len() as f64) as usize % feats.len()];
                    let n = 2 + (rnd() * 30.0) as usize;
                    let (cx, cy, r) = (60.0 + rnd() * 100.0, 60.0 + rnd() * 100.0, 0.5 + rnd() * 20.0);
                    let closed = rnd() < 0.5;
                    let pts: Vec<PathPt> = (0..n).map(|i| { let a = i as f64 / n as f64 * 6.2831853 * if closed { 1.0 } else { 0.6 }; PathPt { x: cx + r * a.cos() * (0.8 + 0.4 * rnd()), y: cy + r * a.sin() * (0.8 + 0.4 * rnd()), w: 0.3 + rnd() * 0.3 } }).collect();
                    paths.push(crate::types::ExtPath { feature: f, pts, closed, layer_h: 0.2, speed: if rnd() < 0.2 { 20.0 + rnd() * 100.0 } else { 0.0 }, flow_ratio: if rnd() < 0.1 { 0.5 } else { 1.0 } });
                }
                plans.push(LayerPlan { z: 0.2 * (l + 1) as f64, h: 0.2, paths });
            }
            let out = generate(&plans, &cfg, &GcodeOptions::default()).expect("fuzz input must generate");
            assert!(!out.gcode.contains("NaN") && !out.gcode.contains("inf "), "round {}: non-finite number in output", round);
            assert!(out.stats.filament_mm.is_finite() && out.time.total_s.is_finite() && (!have_cfg || out.time.total_s > 0.0));
        }
    }
}

