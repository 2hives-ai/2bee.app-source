//! Multi-material prime tower for the Bambu X2D: a port of OrcaSlicer 2.5.0-dev's `WipeTower` (type2, the "new" block
//! tower of `WipeTower.cpp`: `plan_toolchange` / `calc_block_infill_gap` / `plan_tower_new` / `generate_new` /
//! `tool_change_new` / `toolchange_wipe_new` / `finish_layer_new` / `finish_block` / `finish_block_solid` /
//! `generate_support_wall_new` / `generate_rib_polygon`), plus the part of `GCode.cpp` that places the tower pieces in a
//! layer (`WipeTowerIntegration::append_tcr`'s coordinate post-processing).
//!
//! WHAT IS PORTED (single extruder, any number of filaments on it; the filaments may belong to different
//! adhesiveness categories = several blocks): tower geometry (rib wall + fillet, square width, depth per layer, block
//! stacking, y-shift, rib offset, first-layer brim and chamfer), tool-change wipe lines with Orca's speed ramp, empty-grid
//! fill (sparse inverse-U and the first-layer / next-layer-solid variants), solid and contact block layers, wall gaps at the
//! tool-change entry points (`prime_tower_skip_points`), arc fitting of the wall (`G2`/`G3`), flat/line ironing at
//! the start of a wipe, per-filament flow/feed limits, tower accelerations.
//!
//! WHAT IS NOT (refused or labelled): the two-extruder X2D case (`filament_map` with both extruders: nozzle change / ramming
//! / `Hybrid` volume types) is REFUSED by `WipeTowerCfg::from_settings`; timelapse / wrapping-detection tower modes; a tower
//! rotation other than 0; non-Marlin flavours; multi-nozzle (H2C) grouping. Tower interface ("contact") temperature
//! handling and pre-extrusion are emitted but are not verified against an Orca reference that contains contact layers
//! (the reference corpus has none: `enable_tower_interface_features` only changes layers where a category enters or
//! leaves the print).
//!
//! The tower text is produced in TOWER-LOCAL coordinates with Orca's placeholders `[filament_end_gcode]`,
//! `[change_filament_gcode]`, `[filament_start_gcode]`; `post_process` rewrites X/Y into bed coordinates the way
//! `post_process_wipe_tower_moves` does (so the output looks like Orca's, `G1  X.. Y..  E..`).
//!
//! All arithmetic that Orca does in `float` is done in `f32` here (positions such as 192.516 depend on it).

use crate::geom;
use crate::motion::arcs::{self, Seg};
use crate::motion::settings::{opt_kind, split_vector, OptKind, Settings};
use crate::types::{FdmError, Poly, Polys};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::rc::Rc;

type V2 = [f32; 2];

const EPSILON: f32 = 1e-4; // libslic3r EPSILON (double 1e-4 used in float contexts)
const WT_EPSILON: f32 = 1e-3;
const WIDTH_TO_NOZZLE_RATIO: f32 = 1.25;
const WIPE_TOWER_RESOLUTION: f64 = 0.1;
const ARC_FIT_SIZE: usize = 20;
const FLAT_IRON_SPEED: f32 = 10.0 * 60.0;
const SC: f64 = 1e6;

/// Orca's `Preset::filament_options()`: the keys that carry one value per FILAMENT (the rest of the config block is
/// per extruder or global). `Settings::for_filament` collapses exactly these keys to one filament's value.
pub const FILAMENT_KEYS: &[&str] = &[
    "default_filament_colour", "required_nozzle_HRC", "filament_diameter", "pellet_flow_coefficient", "volumetric_speed_coefficients", "filament_type",
    "filament_soluble", "filament_is_support", "filament_printable", "filament_extruder_compatibility", "filament_max_volumetric_speed",
    "filament_adaptive_volumetric_speed", "filament_flow_ratio", "filament_density", "filament_adhesiveness_category", "filament_cost",
    "filament_minimal_purge_on_wipe_tower", "filament_tower_interface_pre_extrusion_dist", "filament_tower_interface_pre_extrusion_length",
    "filament_tower_ironing_area", "filament_tower_interface_purge_volume", "filament_tower_interface_print_temp", "nozzle_temperature",
    "nozzle_temperature_initial_layer", "cool_plate_temp", "textured_cool_plate_temp", "eng_plate_temp", "hot_plate_temp", "textured_plate_temp",
    "cool_plate_temp_initial_layer", "textured_cool_plate_temp_initial_layer", "eng_plate_temp_initial_layer", "hot_plate_temp_initial_layer",
    "textured_plate_temp_initial_layer", "supertack_plate_temp_initial_layer", "supertack_plate_temp", "temperature_vitrification",
    "reduce_fan_stop_start_freq", "dont_slow_down_outer_wall", "slow_down_for_layer_cooling", "fan_min_speed", "fan_max_speed",
    "enable_overhang_bridge_fan", "overhang_fan_speed", "overhang_fan_threshold", "close_fan_the_first_x_layers", "close_additional_fan_first_x_layers",
    "first_x_layer_fan_speed", "full_fan_speed_layer", "initial_layer_fan_speed", "additional_fan_full_speed_layer", "fan_cooling_layer_time",
    "slow_down_layer_time", "slow_down_min_speed", "filament_start_gcode", "filament_end_gcode", "filament_change_extrusion_role_gcode",
    "activate_air_filtration", "activate_air_filtration_during_print", "activate_air_filtration_on_completion", "during_print_exhaust_fan_speed",
    "complete_print_exhaust_fan_speed", "filament_deretraction_speed", "filament_retract_after_wipe", "filament_retract_before_wipe",
    "filament_retract_lift_above", "filament_retract_lift_below", "filament_retract_lift_enforce", "filament_retract_restart_extra",
    "filament_retract_when_changing_layer", "filament_retraction_length", "filament_retraction_minimum_travel", "filament_retraction_speed",
    "filament_retract_length_toolchange", "filament_retract_restart_extra_toolchange", "filament_wipe", "filament_z_hop", "filament_z_hop_types",
    "filament_vendor", "filament_wipe_distance", "additional_cooling_fan_speed", "nozzle_temperature_range_low", "nozzle_temperature_range_high",
    "filament_extruder_variant", "enable_pressure_advance", "pressure_advance", "adaptive_pressure_advance", "adaptive_pressure_advance_model",
    "adaptive_pressure_advance_overhangs", "adaptive_pressure_advance_bridges", "chamber_temperature", "filament_shrink",
    "filament_shrinkage_compensation_z", "support_material_interface_fan_speed", "internal_bridge_fan_speed", "filament_notes", "ironing_fan_speed",
    "filament_ironing_flow", "filament_ironing_spacing", "filament_ironing_inset", "filament_ironing_speed", "filament_loading_speed",
    "filament_loading_speed_start", "filament_unloading_speed", "filament_unloading_speed_start", "filament_toolchange_delay", "filament_cooling_moves",
    "filament_stamping_loading_speed", "filament_stamping_distance", "filament_cooling_initial_speed", "filament_cooling_final_speed",
    "filament_ramming_parameters", "filament_multitool_ramming", "filament_multitool_ramming_volume", "filament_multitool_ramming_flow",
    "activate_chamber_temp_control", "chamber_minimal_temperature", "filament_long_retractions_when_cut", "filament_retraction_distances_when_cut",
    "idle_temperature", "filament_change_length", "filament_flush_volumetric_speed", "filament_flush_temp", "filament_flush_temp_fast",
    "filament_cooling_before_tower", "filament_ramming_volumetric_speed", "filament_ramming_volumetric_speed_nc", "filament_ramming_travel_time",
    "filament_ramming_travel_time_nc", "filament_pre_cooling_temperature", "filament_pre_cooling_temperature_nc", "filament_preheat_temperature_delta",
    "filament_retract_length_nc", "filament_change_length_nc", "filament_prime_volume", "filament_prime_volume_nc", "long_retractions_when_ec",
    "retraction_distances_when_ec", "filament_colour",
];

impl Settings {
    /// A copy of the settings in which every per-filament key holds ONLY filament `idx`'s value, so the single-filament
    /// readers of `gcode.rs` (`Params::new`, `s.num("nozzle_temperature")`, ...) see that filament. Keys that are not
    /// vectors of at least `idx+1` elements are left as they are (out-of-range reads fall back to element 0, as Orca's
    /// `get_at` does).
    pub fn for_filament(&self, idx: usize) -> Settings {
        let mut out = self.clone();
        for k in FILAMENT_KEYS {
            let Some(raw) = self.raw(k) else { continue };
            let (kind, vec) = opt_kind(k);
            let is_str_vec = kind == OptKind::Str && vec;
            let els = if is_str_vec { split_vector(raw, true) } else if kind == OptKind::Str { continue } else { split_vector(raw, false) };
            if els.len() <= 1 { continue; }
            let e = els.get(idx).cloned().unwrap_or_else(|| els[0].clone());
            out.set(k, &if is_str_vec { format!("\"{}\"", e) } else { e });
        }
        out
    }
}

fn r3(x: f32) -> String { format!("{:.3}", x) }
fn r4(x: f32) -> String { format!("{:.4}", x) }
fn fi(f: f32) -> String { format!("{}", (f + 0.5).floor() as i64) }
fn align_round(v: f32, base: f32) -> f32 { (v / base).round() * base }
fn align_ceil(v: f32, base: f32) -> f32 { (v / base).ceil() * base }
fn align_floor(v: f32, base: f32) -> f32 { (v / base).floor() * base }
fn v2sub(a: V2, b: V2) -> V2 { [a[0] - b[0], a[1] - b[1]] }
fn v2add(a: V2, b: V2) -> V2 { [a[0] + b[0], a[1] + b[1]] }
fn v2norm(a: V2) -> f32 { (a[0] * a[0] + a[1] * a[1]).sqrt() }
fn v2eq(a: V2, b: V2) -> bool { a[0] == b[0] && a[1] == b[1] }

// ---------------------------------------------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------------------------------------------

/// Per-filament tower parameters (`WipeTower::FilamentParameters`).
#[derive(Clone, Debug)]
pub struct FilPar {
    pub material: String,
    pub category: i32,
    pub is_soluble: bool,
    pub nozzle_temperature: i32,
    pub nozzle_temperature_initial_layer: i32,
    /// filament mm/s at the filament's max volumetric speed
    pub max_e_speed: f32,
    pub filament_area: f32,
    pub retract_length: f32,
    pub retract_speed: f32,
    pub wipe_dist: f32,
    pub flat_iron_area: f32,
    pub cooling_before_tower: f32,
    pub interface_print_temp: f32,
    pub interface_pre_extrusion_dist: f32,
    pub interface_pre_extrusion_length: f32,
}

/// Everything the tower needs, resolved from the Orca config. Built by `from_settings`.
#[derive(Clone, Debug)]
pub struct WipeTowerCfg {
    pub fil: Vec<FilPar>,
    /// tower left-front corner on the bed (config `wipe_tower_x/y`), mm
    pub pos: V2,
    pub width0: f32,
    pub perimeter_width: f32,
    pub rotation_deg: f32,
    pub brim_width: f32,
    pub use_gap_wall: bool,
    pub use_rib_wall: bool,
    pub rib_width: f32,
    pub extra_rib_length: f32,
    pub fillet: bool,
    pub extra_spacing0: f32,
    pub tower_framework: bool,
    /// `wipe_tower_max_purge_speed * 60` (mm/min)
    pub max_speed: f32,
    pub first_layer_speed: f32,
    pub travel_speed: f32,
    pub no_sparse_layers: bool,
    pub flat_ironing: bool,
    pub enable_interface: bool,
    pub contact_speed: f32,
    pub arc_fitting: bool,
    pub first_layer_flow_ratio: f32,
    pub normal_accel: u32,
    pub first_normal_accel: u32,
    pub travel_accel: u32,
    pub first_travel_accel: u32,
    pub max_accel: u32,
    /// flush volume matrix of extruder 0, `[from][to]`, already multiplied by `flush_multiplier`
    pub flush: Vec<Vec<f32>>,
    /// the same matrix WITHOUT the multiplier (see `build_tower`: measured against Orca, the purge volume is not scaled)
    pub flush_raw: Vec<Vec<f32>>,
    pub prime_volume: Vec<f32>,
    pub grab_length: f32,
    pub flavor_klipper: bool,
    pub filament_change_length: Vec<f32>,
}

impl WipeTowerCfg {
    /// Resolve the tower configuration from a config block with `nfil` filaments (all on ONE extruder).
    pub fn from_settings(s: &Settings, nfil: usize) -> Result<WipeTowerCfg, FdmError> {
        if nfil == 0 { return Err(FdmError::Unsupported("multi-material: no filaments".into())); }
        let flavor = if s.has("gcode_flavor") { s.text("gcode_flavor") } else { "marlin".into() };
        if flavor != "marlin" && flavor != "marlin2" { return Err(FdmError::Unsupported(format!("prime tower for gcode_flavor {} (only Marlin legacy is ported)", flavor))); }
        if s.has("wipe_tower_type") && s.text("wipe_tower_type") != "type2" { return Err(FdmError::Unsupported("wipe_tower_type other than type2 (the Bambu block tower)".into())); }
        if s.num("wipe_tower_rotation_angle").abs() > 1e-6 { return Err(FdmError::Unsupported("wipe_tower_rotation_angle != 0".into())); }
        if s.text("timelapse_type") == "1" || s.text("timelapse_type") == "Smooth" { return Err(FdmError::Unsupported("smooth timelapse changes the prime tower (only_generate_out_wall)".into())); }
        if s.flag("enable_wrapping_detection") { return Err(FdmError::Unsupported("enable_wrapping_detection changes the prime tower depth".into())); }
        let nozzle = s.num("nozzle_diameter") as f32;
        let pw = nozzle * WIDTH_TO_NOZZLE_RATIO;
        let mut fil = Vec::with_capacity(nfil);
        for i in 0..nfil {
            let diam = s.num_at("filament_diameter", i) as f32;
            let area = std::f32::consts::PI / 4.0 * diam * diam;
            let mv = s.num_at("filament_max_volumetric_speed", i) as f32;
            let nil = |k: &str| -> bool { s.elements(k).get(i).map(|e| e.trim() == "nil").unwrap_or(true) };
            let fo_num = |fk: &str, pk: &str| -> f32 { if !nil(fk) && s.has(fk) { s.num_at(fk, i) as f32 } else { s.num_at(pk, 0) as f32 } };
            let temp = s.num_at("nozzle_temperature", i) as i32;
            let temp_first = s.num_at("nozzle_temperature_initial_layer", i) as i32;
            let enable_if = s.flag("enable_tower_interface_features");
            let range_high = s.num_at("nozzle_temperature_range_high", i) as f32;
            let ip = s.num_at("filament_tower_interface_print_temp", i) as f32;
            fil.push(FilPar {
                material: s.text_at("filament_type", i),
                category: if s.has("filament_adhesiveness_category") { s.num_at("filament_adhesiveness_category", i) as i32 } else { 0 },
                is_soluble: s.flag_at("filament_soluble", i),
                nozzle_temperature: temp,
                nozzle_temperature_initial_layer: temp_first,
                max_e_speed: if mv != 0.0 { mv / area } else { f32::MAX },
                filament_area: area,
                retract_length: fo_num("filament_retraction_length", "retraction_length"),
                retract_speed: fo_num("filament_retraction_speed", "retraction_speed"),
                wipe_dist: if s.has("filament_wipe_distance") && !nil("filament_wipe_distance") { s.num_at("filament_wipe_distance", i) as f32 } else { s.num("wipe_distance") as f32 },
                flat_iron_area: s.num_at("filament_tower_ironing_area", i) as f32,
                cooling_before_tower: s.num_at("filament_cooling_before_tower", i) as f32,
                interface_print_temp: if enable_if { if ip == -1.0 { range_high } else { ip } } else { temp as f32 },
                interface_pre_extrusion_dist: if enable_if { s.num_at("filament_tower_interface_pre_extrusion_dist", i) as f32 } else { 0.0 },
                interface_pre_extrusion_length: if enable_if { s.num_at("filament_tower_interface_pre_extrusion_length", i) as f32 } else { 0.0 },
            });
        }
        // flush matrix: the first extruder's nxn block (`get_flush_volumes_matrix`), times flush_multiplier[0]
        let mat: Vec<f32> = s.elements("flush_volumes_matrix").iter().map(|e| e.trim().parse::<f32>().unwrap_or(0.0)).collect();
        let nnoz = s.len_of("nozzle_diameter").max(1);
        let per = mat.len() / nnoz;
        if per < nfil * nfil { return Err(FdmError::Unsupported(format!("flush_volumes_matrix has {} values per nozzle, {} filaments need {}", per, nfil, nfil * nfil))); }
        let mult = if s.has("flush_multiplier") { s.num("flush_multiplier") as f32 } else { 1.0 };
        let mut flush = vec![vec![0.0f32; nfil]; nfil];
        let mut flush_raw = vec![vec![0.0f32; nfil]; nfil];
        for i in 0..nfil { for j in 0..nfil { flush[i][j] = mat[i * nfil + j] * mult; flush_raw[i][j] = mat[i * nfil + j]; } }
        let prime_volume: Vec<f32> = (0..nfil).map(|i| if s.has("filament_prime_volume") { s.num_at("filament_prime_volume", i) as f32 } else { s.num("prime_volume") as f32 }).collect();
        let acc = |k: &str| -> u32 { (s.num_at(k, 0) + 0.5).floor().max(0.0) as u32 };
        let first_travel = if s.has("initial_layer_travel_acceleration") {
            let v = s.abs("initial_layer_travel_acceleration", s.num("travel_acceleration"));
            (v + 0.5).floor().max(0.0) as u32
        } else { acc("travel_acceleration") };
        let gap = if s.has("prime_tower_infill_gap") { s.num("prime_tower_infill_gap") as f32 / 100.0 } else { 1.0 };
        let fls = s.num("initial_layer_speed") as f32;
        let use_gap = s.flag("prime_tower_skip_points");
        let fcl: Vec<f32> = s.elements("filament_change_length").iter().map(|e| e.trim().parse::<f32>().unwrap_or(0.0)).collect();
        Ok(WipeTowerCfg {
            fil,
            pos: [s.num("wipe_tower_x") as f32, s.num("wipe_tower_y") as f32],
            width0: s.num("prime_tower_width") as f32,
            perimeter_width: pw,
            rotation_deg: 0.0,
            brim_width: s.num_or("prime_tower_brim_width", -1.0) as f32,
            use_gap_wall: use_gap,
            use_rib_wall: s.text("wipe_tower_wall_type") == "rib",
            rib_width: s.num("wipe_tower_rib_width") as f32,
            extra_rib_length: s.num("wipe_tower_extra_rib_length") as f32,
            fillet: s.flag("wipe_tower_fillet_wall"),
            extra_spacing0: gap,
            tower_framework: s.flag("prime_tower_enable_framework"),
            max_speed: s.num("wipe_tower_max_purge_speed") as f32 * 60.0,
            first_layer_speed: if fls == 0.0 { 30.0 } else { fls },
            travel_speed: s.num("travel_speed") as f32,
            no_sparse_layers: s.flag("wipe_tower_no_sparse_layers"),
            flat_ironing: s.flag("prime_tower_flat_ironing") && use_gap,
            enable_interface: s.flag("enable_tower_interface_features"),
            contact_speed: 20.0 * 60.0,
            arc_fitting: s.flag("enable_arc_fitting"),
            first_layer_flow_ratio: if s.flag("set_other_flow_ratios") { s.num("first_layer_flow_ratio") as f32 } else { 1.0 },
            normal_accel: acc("default_acceleration"),
            first_normal_accel: acc("initial_layer_acceleration"),
            travel_accel: acc("travel_acceleration"),
            first_travel_accel: first_travel,
            max_accel: s.machine_limit("machine_max_acceleration_extruding") as u32,
            flush,
            flush_raw,
            prime_volume,
            grab_length: s.num("grab_length") as f32,
            flavor_klipper: false,
            filament_change_length: fcl,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------------------------------------------

/// One piece of tower G-code for a layer (`WipeTower::ToolChangeResult`). `gcode` is TOWER-LOCAL (before `post_process`).
#[derive(Clone, Debug, Default)]
pub struct Tcr {
    pub print_z: f32,
    pub layer_height: f32,
    pub gcode: String,
    pub start_pos: V2,
    pub end_pos: V2,
    pub elapsed_time: f32,
    pub wipe_path: Vec<V2>,
    pub purge_volume: f32,
    pub initial_tool: i32,
    pub new_tool: i32,
    pub is_finish_first: bool,
    pub is_contact: bool,
    pub is_tool_change: bool,
    pub tool_change_start_pos: V2,
}

#[derive(Clone, Debug, Default)]
pub struct TowerOutput {
    /// per plan layer, the pieces in print order (one per tool change of the layer; the wall/fill pieces are merged into them)
    pub layers: Vec<Vec<Tcr>>,
    pub layer_z: Vec<f32>,
    pub depth: f32,
    pub width: f32,
    pub height: f32,
    pub brim_width: f32,
    pub rib_offset: V2,
    /// tower bounding box in tower-local coordinates (min, max), `get_bbx`
    pub bbx: [V2; 2],
    /// filament mm used on the tower per filament (`get_used_filament`)
    pub used_filament: Vec<f32>,
    pub number_of_toolchanges: usize,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------------------------------------------
// the writer
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum LimitFlow { None, Print }

#[derive(Clone, Copy, Debug)]
struct ArcSeg { end: V2, center: V2, ccw: bool, length: f32 }

#[derive(Clone, Debug)]
enum SegKind { Line, Arc(ArcSeg) }
#[derive(Clone, Debug)]
struct Segment { start: V2, end: V2, kind: SegKind }

struct Writer {
    cfg: Rc<WipeTowerCfg>,
    gcode: String,
    cur: V2,
    feed: f32,
    layer_h: f32,
    flow: f32,
    tool: usize,
    y_shift: f32,
    wt_w: f32,
    wt_d: f32,
    start_pos: V2,
    wipe_path: Vec<V2>,
    elapsed: f32,
    last_acc: u32,
    first_layer: bool,
    z: f32,
    used_len: f32,
}

impl Writer {
    fn new(cfg: &Rc<WipeTowerCfg>, layer_h: f32, line_width: f32) -> Writer {
        let mut w = Writer { cfg: cfg.clone(), gcode: String::new(), cur: [f32::MAX, f32::MAX], feed: 0.0, layer_h, flow: 0.0, tool: 0, y_shift: 0.0, wt_w: 0.0, wt_d: 0.0,
            start_pos: [0.0, 0.0], wipe_path: Vec::new(), elapsed: 0.0, last_acc: 0, first_layer: false, z: 0.0, used_len: 0.0 };
        let _ = write!(w.gcode, ";HEIGHT:{}\n;TYPE:Wipe tower\n", format!("{:.6}", layer_h));
        // Orca writes these as reserved tags only for the preview; our statistics use the FEATURE comments the caller writes.
        w.gcode.clear();
        let _ = line_width;
        w
    }
    fn rotate(&self, p: V2) -> V2 { [p[0], p[1] + self.y_shift] }
    fn pos_rotated(&self) -> V2 { self.rotate(self.cur) }
    fn set_initial_position(&mut self, pos: V2, width: f32, depth: f32) { self.wt_w = width; self.wt_d = depth; self.start_pos = self.rotate(pos); self.cur = pos; }
    fn set_y_shift(&mut self, shift: f32) { self.cur[1] -= shift - self.y_shift; self.y_shift = shift; }
    fn append(&mut self, t: &str) -> &mut Self { self.gcode.push_str(t); self }
    fn feedrate(&mut self, f: f32) -> &mut Self {
        if f != self.feed { let _ = write!(self.gcode, "G1 F{}\n", fi(f)); self.feed = f; }
        self
    }
    fn fmt_f(&mut self, f: f32) -> String { self.feed = f; format!(" F{}", fi(f)) }
    fn acc_line(&mut self, travel: bool) -> String {
        let c = self.cfg.clone();
        let acc = if travel { if self.first_layer { c.first_travel_accel } else { c.travel_accel } } else if self.first_layer { c.first_normal_accel } else { c.normal_accel };
        let mut acc = acc;
        if c.max_accel > 0 && acc > c.max_accel { acc = c.max_accel; }
        if acc == 0 || acc == self.last_acc { return String::new(); }
        self.last_acc = acc;
        format!("M204 S{}\n", acc)
    }

    fn extrude_explicit(&mut self, x: f32, y: f32, e: f32, f: f32, record_length: bool, limit: LimitFlow) -> &mut Self {
        if (x - self.cur[0]).abs() <= EPSILON && (y - self.cur[1]).abs() < EPSILON && e == 0.0 && (f == 0.0 || f == self.feed) { return self; }
        let dx = x - self.cur[0];
        let dy = y - self.cur[1];
        let len = (dx * dx + dy * dy).sqrt();
        if record_length { self.used_len += e; }
        let rcur = self.pos_rotated();
        let rot = self.rotate([x, y]);
        let al = self.acc_line(e == 0.0);
        self.gcode.push_str(&al);
        self.gcode.push_str("G1");
        if (rot[0] - rcur[0]).abs() > EPSILON { let _ = write!(self.gcode, " X{}", r3(rot[0])); self.cur[0] = rot[0]; }
        if (rot[1] - rcur[1]).abs() > EPSILON { let _ = write!(self.gcode, " Y{}", r3(rot[1])); self.cur[1] = rot[1]; }
        if e != 0.0 { let _ = write!(self.gcode, " E{}", r4(e)); }
        if f != 0.0 && f != self.feed {
            let mut ff = f;
            if limit != LimitFlow::None {
                let e_speed = e / ((if len == 0.0 { e.abs() } else { len }) / f * 60.0);
                let tmp = self.cfg.fil[self.tool].max_e_speed;
                ff /= (e_speed / tmp).max(1.0);
            }
            let s = self.fmt_f(ff);
            self.gcode.push_str(&s);
        }
        self.cur = [x, y];
        self.elapsed += (if len == 0.0 { e.abs() } else { len }) / self.feed * 60.0;
        self.gcode.push('\n');
        self
    }
    fn extrude_arc(&mut self, a: &ArcSeg, f: f32) -> &mut Self {
        let (x, y) = (a.end[0], a.end[1]);
        let len = a.length;
        let e = len * self.flow;
        if len < EPSILON && e == 0.0 && (f == 0.0 || f == self.feed) { return self; }
        let rcur = self.pos_rotated();
        let rot = self.rotate([x, y]);
        let al = self.acc_line(e == 0.0);
        self.gcode.push_str(&al);
        self.gcode.push_str(if a.ccw { "G3" } else { "G2" });
        let c = self.rotate(a.center);
        let _ = write!(self.gcode, " X{} Y{} I{} J{}", r3(rot[0]), r3(rot[1]), r3(c[0] - rcur[0]), r3(c[1] - rcur[1]));
        self.cur = [x, y];
        if e != 0.0 { let _ = write!(self.gcode, " E{}", r4(e)); }
        if f != 0.0 && f != self.feed {
            let e_speed = e / ((if len == 0.0 { e.abs() } else { len }) / f * 60.0);
            let ff = f / (e_speed / self.cfg.fil[self.tool].max_e_speed).max(1.0);
            let s = self.fmt_f(ff);
            self.gcode.push_str(&s);
        }
        self.elapsed += (if len == 0.0 { e.abs() } else { len }) / self.feed * 60.0;
        self.gcode.push('\n');
        self
    }
    fn travel(&mut self, x: f32, y: f32, f: f32) -> &mut Self { self.extrude_explicit(x, y, 0.0, f, false, LimitFlow::Print) }
    fn travel_v(&mut self, p: V2, f: f32) -> &mut Self { self.travel(p[0], p[1], f) }
    fn extrude(&mut self, x: f32, y: f32, f: f32) -> &mut Self {
        let dx = x - self.cur[0];
        let dy = y - self.cur[1];
        let e = (dx * dx + dy * dy).sqrt() * self.flow;
        self.extrude_explicit(x, y, e, f, false, LimitFlow::Print)
    }
    fn extrude_v(&mut self, p: V2, f: f32) -> &mut Self { self.extrude(p[0], p[1], f) }
    fn load(&mut self, e: f32, f: f32) -> &mut Self {
        if e == 0.0 && (f == 0.0 || f == self.feed) { return self; }
        self.gcode.push_str("G1");
        if e != 0.0 { let _ = write!(self.gcode, " E{}", r4(e)); }
        if f != 0.0 && f != self.feed { let s = self.fmt_f(f); self.gcode.push_str(&s); }
        self.gcode.push('\n');
        self
    }
    fn retract(&mut self, e: f32, f: f32) -> &mut Self { self.load(-e, f) }
    fn x(&self) -> f32 { self.cur[0] }
    fn y(&self) -> f32 { self.cur[1] }
    fn add_wipe_point(&mut self, p: V2) { let r = self.rotate(p); self.wipe_path.push(r); }
    fn add_wipe_path(&mut self, poly: &[V2], mut wipe_dist: f32) {
        if poly.is_empty() { return; }
        // closest point index, polygon split there and reversed
        let mut bi = 0usize; let mut bd = f64::MAX;
        for (i, p) in poly.iter().enumerate() {
            let d = ((p[0] - self.cur[0]) as f64).powi(2) + ((p[1] - self.cur[1]) as f64).powi(2);
            if d < bd { bd = d; bi = i; }
        }
        let n = poly.len();
        // split_at_index: polyline starting at bi going forward, closed (n+1 points); then reversed
        let mut pl: Vec<V2> = (0..=n).map(|k| poly[(bi + k) % n]).collect();
        pl.reverse();
        for i in 0..pl.len() {
            if wipe_dist < EPSILON { break; }
            self.add_wipe_point(pl[i]);
            if i != 0 { wipe_dist -= v2norm(v2sub(pl[i], pl[i - 1])); }
        }
    }
    fn flush_planner_queue(&mut self) -> &mut Self { self.gcode.push_str(if self.cfg.flavor_klipper { "M400\n" } else { "G4 S0\n" }); self }
    fn reset_extruder(&mut self) -> &mut Self { self.gcode.push_str("G92 E0\n"); self }
    fn comment_with_value(&mut self, c: &str, v: i64) -> &mut Self { let _ = write!(self.gcode, ";{}{}\n", c, v); self }
    fn format_m104(&mut self, temp: i32, wait_for_moves: bool) {
        if wait_for_moves { self.gcode.push_str("M400\n"); }
        let _ = write!(self.gcode, "M104 S{} N0\n", temp);
    }
    fn format_m109(&mut self, temp: i32) { let _ = write!(self.gcode, "M109 S{} N0\n", temp); }

    fn spiral_flat_ironing(&mut self, center: V2, area: f32, step: f32, feedrate: f32) {
        let edge = area.sqrt();
        let mut bmax = [center[0] + step, center[1] + step];
        let mut bmin = [center[0] - step, center[1] - step];
        let mut n = (edge / step / 2.0).ceil() as i32;
        if n <= 0 { return; }
        while n > 0 {
            n -= 1;
            let cy = self.cur[1]; self.travel(bmax[0], cy, feedrate);
            let cx = self.cur[0]; self.travel(cx, bmax[1], feedrate);
            let cy = self.cur[1]; self.travel(bmin[0], cy, feedrate);
            let cx = self.cur[0]; self.travel(cx, bmin[1], feedrate);
            bmax = [bmax[0] + step, bmax[1] + step];
            bmin = [bmin[0] - step, bmin[1] - step];
        }
    }

    /// `WipeTowerWriter::generate_path`: the (possibly gapped) wall polylines, arc-fitted, closest segment first,
    /// retract + travel + unretract across gaps.
    fn generate_path(&mut self, pls: &[Vec<V2>], feedrate: f32, retract_length: f32, retract_speed: f32) {
        let mut segments: Vec<Segment> = Vec::new();
        for pl in pls {
            if pl.len() < 2 { continue; }
            if self.cfg.arc_fitting {
                let p64: Vec<[f64; 2]> = pl.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
                let (pts, segs) = arcs::fit_and_simplify(&p64, WIPE_TOWER_RESOLUTION);
                let pf: Vec<V2> = pts.iter().map(|p| [p[0] as f32, p[1] as f32]).collect();
                for sg in segs {
                    match sg {
                        Seg::Line { a, b } => { for j in a..b { segments.push(Segment { start: pf[j], end: pf[j + 1], kind: SegKind::Line }); } }
                        Seg::Arc { a, b, center, ccw, length } => {
                            let c = [center[0] as f32, center[1] as f32];
                            segments.push(Segment { start: pf[a], end: pf[b], kind: SegKind::Arc(ArcSeg { end: pf[b], center: c, ccw, length: length as f32 }) });
                        }
                    }
                }
            } else {
                let simp = douglas_peucker_f32(pl, WIPE_TOWER_RESOLUTION as f32);
                for j in 0..simp.len().saturating_sub(1) { segments.push(Segment { start: simp[j], end: simp[j + 1], kind: SegKind::Line }); }
            }
        }
        if segments.is_empty() { return; }
        let mut bi = 0usize; let mut bd = f32::MAX;
        for (i, s) in segments.iter().enumerate() {
            let d = (s.start[0] - self.cur[0]).powi(2) + (s.start[1] - self.cur[1]).powi(2);
            if d < bd { bd = d; bi = i; }
        }
        let n = segments.len();
        let mut i = bi;
        let s0 = segments[i].clone();
        self.travel_v(s0.start, 0.0);
        self.seg_extrude(&s0, feedrate);
        loop {
            i = (i + 1) % n;
            if i == bi { break; }
            let s = segments[i].clone();
            let dx = s.start[0] - self.cur[0];
            let dy = s.start[1] - self.cur[1];
            let len = (dx * dx + dy * dy).sqrt();
            if len > EPSILON {
                self.retract(retract_length, retract_speed);
                self.travel_v(s.start, 600.0);
                self.retract(-retract_length, retract_speed);
            }
            self.seg_extrude(&s, feedrate);
        }
    }
    fn seg_extrude(&mut self, s: &Segment, f: f32) {
        match &s.kind { SegKind::Line => { self.extrude_v(s.end, f); } SegKind::Arc(a) => { let a = *a; self.extrude_arc(&a, f); } }
    }
    /// `WipeTowerWriter::polygon` is only used by the brim loops (`finish_layer_new`).
    fn polygon(&mut self, poly: &[V2], f: f32) {
        let mut ring: Vec<V2> = poly.to_vec();
        if ring.len() < 3 { return; }
        ring.push(ring[0]);
        let mut segments: Vec<Segment> = Vec::new();
        if self.cfg.arc_fitting {
            let p64: Vec<[f64; 2]> = ring.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
            let (pts, segs) = arcs::fit_and_simplify(&p64, WIPE_TOWER_RESOLUTION);
            let pf: Vec<V2> = pts.iter().map(|p| [p[0] as f32, p[1] as f32]).collect();
            for sg in segs {
                match sg {
                    Seg::Line { a, b } => { for j in a..b { segments.push(Segment { start: pf[j], end: pf[j + 1], kind: SegKind::Line }); } }
                    Seg::Arc { a, b, center, ccw, length } => {
                        segments.push(Segment { start: pf[a], end: pf[b], kind: SegKind::Arc(ArcSeg { end: pf[b], center: [center[0] as f32, center[1] as f32], ccw, length: length as f32 }) });
                    }
                }
            }
        } else {
            let simp = douglas_peucker_f32(&ring, WIPE_TOWER_RESOLUTION as f32);
            for j in 0..simp.len().saturating_sub(1) { segments.push(Segment { start: simp[j], end: simp[j + 1], kind: SegKind::Line }); }
        }
        if segments.is_empty() { return; }
        let mut bi = 0usize; let mut bd = f32::MAX;
        for (i, s) in segments.iter().enumerate() {
            let d = (s.start[0] - self.cur[0]).powi(2) + (s.start[1] - self.cur[1]).powi(2);
            if d < bd { bd = d; bi = i; }
        }
        let n = segments.len();
        let mut i = bi;
        let s0 = segments[i].clone();
        self.travel_v(s0.start, 0.0);
        self.seg_extrude(&s0, f);
        loop {
            i = (i + 1) % n;
            if i == bi { break; }
            let s = segments[i].clone();
            self.seg_extrude(&s, f);
        }
    }
}

fn douglas_peucker_f32(pts: &[V2], tol: f32) -> Vec<V2> {
    let n = pts.len();
    if n <= 2 { return pts.to_vec(); }
    let mut keep = vec![false; n];
    keep[0] = true; keep[n - 1] = true;
    let mut st = vec![(0usize, n - 1)];
    while let Some((lo, hi)) = st.pop() {
        if hi <= lo + 1 { continue; }
        let a = pts[lo]; let b = pts[hi];
        let ab = v2sub(b, a); let l = v2norm(ab);
        let mut best = -1.0f32; let mut bi = lo;
        for i in lo + 1..hi {
            let ap = v2sub(pts[i], a);
            let d = if l < 1e-9 { v2norm(ap) } else { (ab[0] * ap[1] - ab[1] * ap[0]).abs() / l };
            if d > best { best = d; bi = i; }
        }
        if best > tol { keep[bi] = true; st.push((lo, bi)); st.push((bi, hi)); }
    }
    (0..n).filter(|&i| keep[i]).map(|i| pts[i]).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// polygon helpers (rib wall, gaps)
// ---------------------------------------------------------------------------------------------------------------

type Pt64 = [f64; 2];

fn scaled_pt(p: V2) -> Pt64 { [(p[0] as f64 * SC).round(), (p[1] as f64 * SC).round()] }
fn unscaled_pt(p: Pt64) -> V2 { [(p[0] / SC) as f32, (p[1] / SC) as f32] }
fn trunc_pt(p: [f64; 2]) -> Pt64 { [p[0].trunc(), p[1].trunc()] }

fn ring_to_poly_mm(r: &[Pt64]) -> Polys {
    let c: Vec<[f64; 2]> = r.iter().map(|p| [p[0] / SC, p[1] / SC]).collect();
    vec![Poly { contour: c, holes: vec![] }]
}

/// `generate_rectange(line, offset)`: the 4 corner points, integer-truncated like the `Points rect` construction.
fn rect_around_line(a: Pt64, b: Pt64, offset: f64) -> Vec<Pt64> {
    let dx = b[0] - a[0]; let dy = b[1] - a[1];
    let len = (dx * dx + dy * dy).sqrt();
    let ux = dx / len; let uy = dy / len;
    let (vx, vy) = (-uy, ux);
    let (ox, oy) = (vx * offset, vy * offset);
    vec![trunc_pt([a[0] + ox, a[1] + oy]), trunc_pt([a[0] - ox, a[1] - oy]), trunc_pt([b[0] - ox, b[1] - oy]), trunc_pt([b[0] + ox, b[1] + oy])]
}

/// `Line::extend(offset)`: both end points move outwards by `offset`.
fn extend_line(a: Pt64, b: Pt64, off: f64) -> (Pt64, Pt64) {
    let dx = b[0] - a[0]; let dy = b[1] - a[1];
    let l = (dx * dx + dy * dy).sqrt();
    if l == 0.0 { return (a, b); }
    let (ux, uy) = (dx / l * off, dy / l * off);
    (trunc_pt([a[0] - ux, a[1] - uy]), trunc_pt([b[0] + ux, b[1] + uy]))
}

/// `WipeTower::rounding_polygon`: fillet every corner sharper than 30 degrees with a 2 mm radius arc sampled at 20 points.
fn rounding_polygon(poly: &[Pt64], rounding: f64, angle_tol: f64) -> Vec<Pt64> {
    let n = poly.len();
    if n < 3 { return poly.to_vec(); }
    let cos_tol = angle_tol.cos().abs();
    let mut res: Vec<Pt64> = Vec::new();
    let un = |p: Pt64| [p[0] / SC, p[1] / SC];
    for i in 0..n {
        let a = un(poly[(i + n - 1) % n]); let b = un(poly[i]); let c = un(poly[(i + 1) % n]);
        let ab_len = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
        let bc_len = ((b[0] - c[0]).powi(2) + (b[1] - c[1]).powi(2)).sqrt();
        let ab = [(b[0] - a[0]) / ab_len, (b[1] - a[1]) / ab_len];
        let bc = [(c[0] - b[0]) / bc_len, (c[1] - b[1]) / bc_len];
        let cosangle = ((ab[0] * bc[0] + ab[1] * bc[1]) as f32).clamp(-1.0, 1.0) as f64;
        let is_ccw = ab[0] * bc[1] - ab[1] * bc[0] > 0.0;
        if cosangle.abs() < cos_tol {
            let real = (rounding.min(ab_len / 2.1)).min(bc_len / 2.1) as f32 as f64;
            let left = [b[0] - ab[0] * real, b[1] - ab[1] * real];
            let right = [b[0] + bc[0] * real, b[1] + bc[1] * real];
            let half_angle = (cosangle.acos() as f32 / 2.0) as f64;
            let mut dir = [right[0] - left[0], right[1] - left[1]];
            let dl = (dir[0] * dir[0] + dir[1] * dir[1]).sqrt();
            dir = [dir[0] / dl, dir[1] / dl];
            dir = [-dir[1], dir[0]];
            if !is_ccw { dir = [-dir[0], -dir[1]]; }
            let dis = real / half_angle.sin();
            let center = [b[0] + dir[0] * dis, b[1] + dir[1] * dis];
            let radius = ((left[0] - center[0]).powi(2) + (left[1] - center[1]).powi(2)).sqrt();
            let cs = [(center[0] * SC).round(), (center[1] * SC).round()];
            let rs = (radius * SC).round();
            let st = [(left[0] * SC).round(), (left[1] * SC).round()];
            let en = [(right[0] * SC).round(), (right[1] * SC).round()];
            let polar = |p: Pt64| { let mut a = (p[1] - cs[1]).atan2(p[0] - cs[0]); if a < 0.0 { a += 2.0 * std::f64::consts::PI; } a };
            let ts = polar(st); let te = polar(en);
            let mut ang = te - ts;
            if ang < 0.0 && is_ccw { ang += 2.0 * std::f64::consts::PI; } else if ang > 0.0 && !is_ccw { ang -= 2.0 * std::f64::consts::PI; }
            for j in 0..ARC_FIT_SIZE {
                let mut cur = ts + j as f64 / ARC_FIT_SIZE as f64 * ang;
                if cur > 2.0 * std::f64::consts::PI { cur -= 2.0 * std::f64::consts::PI; } else if cur < 0.0 { cur += 2.0 * std::f64::consts::PI; }
                res.push(trunc_pt([cs[0] + rs * cur.cos(), cs[1] + rs * cur.sin()]));
            }
            res.push(en);
        } else {
            res.push(poly[i]);
        }
    }
    // remove_duplicate_points
    let mut out: Vec<Pt64> = Vec::new();
    for p in res { if out.last() != Some(&p) { out.push(p); } }
    while out.len() > 1 && out.first() == out.last() { out.pop(); }
    out
}

fn first_outer(p: &Polys) -> Vec<Pt64> {
    let mut best: Option<&Poly> = None;
    for q in p { if best.map_or(true, |b| geom::ring_area(&q.contour).abs() > geom::ring_area(&b.contour).abs()) { best = Some(q); } }
    best.map(|q| q.contour.iter().map(|p| [(p[0] * SC).round(), (p[1] * SC).round()]).collect()).unwrap_or_default()
}

fn rect_poly(min: V2, max: V2) -> Vec<Pt64> {
    vec![scaled_pt(min), scaled_pt([max[0], min[1]]), scaled_pt(max), scaled_pt([min[0], max[1]])]
}

// --- skip points (gaps in the wall at tool-change entries) ---------------------------------------------------------

#[derive(Clone, Copy)]
struct Inter { pos: V2, idx: usize, pair_idx: i32, dis_from_idx: f32, is_forward: bool }
#[derive(Clone, Copy)]
struct PtFlag { pos: V2, pair_idx: i32, is_forward: bool }

fn ray_intersection_line(a: V2, v1: V2, b: V2, c: V2) -> Option<V2> {
    let v2 = v2sub(c, b);
    let denom = v1[0] * v2[1] - v1[1] * v2[0];
    if denom.abs() < EPSILON { return None; }
    let v12 = v2sub(a, b);
    let nume_a = v2[0] * v12[1] - v2[1] * v12[0];
    let nume_b = v1[0] * v12[1] - v1[1] * v12[0];
    let t1 = nume_a / denom; let t2 = nume_b / denom;
    if t1 >= 0.0 && t2 >= 0.0 && t2 <= 1.0 { Some([a[0] + t1 * v1[0], a[1] + t1 * v1[1]]) } else { None }
}

fn normalized(v: V2) -> V2 { let l = v2norm(v); if l == 0.0 { v } else { [v[0] / l, v[1] / l] } }

fn move_point_along_polygon(points: &[V2], start: V2, start_idx: usize, offset: f32, forward: bool, pair_idx: i32) -> Inter {
    let m = points.len();
    let mut remaining = offset;
    let mut res = Inter { pos: [0.0; 2], idx: 0, pair_idx, dis_from_idx: 0.0, is_forward: forward };
    if forward {
        let next = (start_idx + 1) % m;
        remaining -= v2norm(v2sub(points[next], start));
        if remaining <= 0.0 {
            res.idx = start_idx;
            let d = normalized(v2sub(points[next], start));
            res.pos = [start[0] + d[0] * offset, start[1] + d[1] * offset];
            res.dis_from_idx = v2norm(v2sub(points[start_idx], res.pos));
            return res;
        }
        let mut i = (start_idx + 1) % m;
        while i != start_idx {
            let seg = v2norm(v2sub(points[(i + 1) % m], points[i]));
            if remaining <= seg {
                let ratio = remaining / seg;
                res.idx = i;
                let d = v2sub(points[(i + 1) % m], points[i]);
                res.pos = [points[i][0] + ratio * d[0], points[i][1] + ratio * d[1]];
                res.dis_from_idx = remaining;
                return res;
            }
            remaining -= seg;
            i = (i + 1) % m;
        }
        res.idx = (start_idx + m - 1) % m;
        res.pos = points[start_idx];
        res.dis_from_idx = v2norm(v2sub(res.pos, points[res.idx]));
    } else {
        let next = (start_idx + 1) % m;
        remaining -= v2norm(v2sub(points[start_idx], start));
        if remaining <= 0.0 {
            res.idx = start_idx;
            let d = normalized(v2sub(points[next], points[start_idx]));
            res.pos = [start[0] - d[0] * offset, start[1] - d[1] * offset];
            res.dis_from_idx = v2norm(v2sub(res.pos, points[start_idx]));
            return res;
        }
        let mut i = (start_idx + m - 1) % m;
        while i != start_idx {
            let seg = v2norm(v2sub(points[(i + 1) % m], points[i]));
            if remaining <= seg {
                let ratio = remaining / seg;
                res.idx = i;
                let d = v2sub(points[(i + 1) % m], points[i]);
                res.pos = [points[(i + 1) % m][0] - ratio * d[0], points[(i + 1) % m][1] - ratio * d[1]];
                res.dis_from_idx = seg - remaining;
                return res;
            }
            remaining -= seg;
            i = (i + m - 1) % m;
        }
        res.idx = start_idx;
        res.pos = points[res.idx];
        res.dis_from_idx = 0.0;
    }
    res
}

fn insert_points(pl: &mut Vec<PtFlag>, idx: usize, pos: V2, pair_idx: i32, is_forward: bool) {
    let next = (idx + 1) % pl.len();
    let p1 = pl[idx].pos; let p2 = pl[next].pos;
    let sq = |a: V2, b: V2| (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2);
    if sq(pos, p1) < EPSILON { pl[idx].pair_idx = pair_idx; pl[idx].is_forward = is_forward; }
    else if sq(pos, p2) < EPSILON { pl[next].pair_idx = pair_idx; pl[next].is_forward = is_forward; }
    else { pl.insert(idx + 1, PtFlag { pos, pair_idx, is_forward }); }
}

fn add_extra_point(polygon: &[Pt64], scale_range: f64) -> Vec<Pt64> {
    let n = polygon.len();
    if n < 2 { return polygon.to_vec(); }
    let minx = polygon.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
    let maxx = polygon.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
    let miny = polygon.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
    let anchor = [((minx + maxx) / 2.0).trunc() as f32, miny as f32];
    let mut ce = 0usize; let mut md = f32::MAX;
    for i in 0..n {
        let a = polygon[i]; let b = polygon[(i + 1) % n];
        let (af, bf) = ([a[0] as f32, a[1] as f32], [b[0] as f32, b[1] as f32]);
        let mid = [(af[0] + bf[0]) * 0.5, (af[1] + bf[1]) * 0.5];
        let d = (anchor[0] - mid[0]).powi(2) + (anchor[1] - mid[1]).powi(2);
        if d < md { md = d; ce = i; }
    }
    let a = polygon[ce]; let b = polygon[(ce + 1) % n];
    let (af, bf) = ([a[0] as f32, a[1] as f32], [b[0] as f32, b[1] as f32]);
    let mid = [(af[0] + bf[0]) * 0.5, (af[1] + bf[1]) * 0.5];
    let mut da = v2sub(af, mid); let mut db = v2sub(bf, mid);
    let la = v2norm(da); let lb = v2norm(db);
    if la < EPSILON || lb < EPSILON { return polygon.to_vec(); }
    da = [da[0] / la, da[1] / la]; db = [db[0] / lb, db[1] / lb];
    let max_range = la.min(lb) * 0.9;
    let range = (scale_range as f32).min(max_range);
    let oa = [mid[0] + da[0] * range, mid[1] + da[1] * range];
    let ob = [mid[0] + db[0] * range, mid[1] + db[1] * range];
    let ip = |p: V2| [(p[0]).round() as f64, (p[1]).round() as f64];
    let mut res = Vec::with_capacity(n + 3);
    for i in 0..n {
        res.push(polygon[i]);
        if i == ce { res.push(ip(oa)); res.push(ip(mid)); res.push(ip(ob)); }
    }
    res
}

/// `remove_points_from_polygon`: cut the closed wall open around each skip point. Returns the polylines and the polygon with the
/// gap end points inserted (`insert_skip_pg`, used for the wipe path).
fn remove_points_from_polygon(polygon_ori: &[Pt64], skip_points: &[V2], range: f64, wt_width: f32) -> (Vec<Vec<V2>>, Vec<V2>) {
    let polygon = add_extra_point(polygon_ori, range * SC);
    if polygon.len() < 2 { return (vec![polygon.iter().map(|p| unscaled_pt(*p)).collect()], Vec::new()); }
    // anchor: bbox centre x, min y; split the ring at the closest vertex
    let minx = polygon.iter().map(|p| p[0]).fold(f64::MAX, f64::min);
    let maxx = polygon.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
    let miny = polygon.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
    let anchor = [((minx + maxx) / 2.0).trunc(), miny];
    let mut ci = 0usize; let mut cd = f64::MAX;
    for (i, p) in polygon.iter().enumerate() { let d = (p[0] - anchor[0]).powi(2) + (p[1] - anchor[1]).powi(2); if d < cd { cd = d; ci = i; } }
    let n = polygon.len();
    let points: Vec<V2> = (0..n).map(|k| unscaled_pt(polygon[(ci + k) % n])).collect();
    let rangef = range as f32;
    let mut inter_info: Vec<Inter> = Vec::new();
    for (i, sp) in skip_points.iter().enumerate() {
        let is_left = sp[0].abs() < wt_width / 2.0;
        let ray: V2 = if is_left { [-1.0, 0.0] } else { [1.0, 0.0] };
        for j in 0..points.len() {
            let p1 = points[j]; let p2 = points[(j + 1) % points.len()];
            if let Some(ip) = ray_intersection_line(*sp, ray, p1, p2) {
                let mut fw = move_point_along_polygon(&points, ip, j, rangef, true, i as i32);
                let mut bw = move_point_along_polygon(&points, ip, j, rangef, false, i as i32);
                bw.is_forward = false; fw.is_forward = true;
                inter_info.push(bw); inter_info.push(fw);
                break;
            }
        }
    }
    let mut new_pl: Vec<PtFlag> = points.iter().map(|p| PtFlag { pos: *p, pair_idx: -1, is_forward: false }).collect();
    inter_info.sort_by(|l, r| if l.idx == r.idx { l.dis_from_idx.partial_cmp(&r.dis_from_idx).unwrap_or(std::cmp::Ordering::Equal) } else { l.idx.cmp(&r.idx) });
    for k in (0..inter_info.len()).rev() {
        let ii = inter_info[k];
        insert_points(&mut new_pl, ii.idx, ii.pos, ii.pair_idx, ii.is_forward);
    }
    let insert_skip: Vec<V2> = new_pl.iter().map(|p| p.pos).collect();
    let beg = 0usize;
    let mut skip = true;
    let mut i = beg;
    let mut result: Vec<Vec<V2>> = Vec::new();
    let mut pl: Vec<V2> = Vec::new();
    loop {
        if skip || new_pl[i].pair_idx == -1 {
            pl.push(new_pl[i].pos);
            i = (i + 1) % new_pl.len();
            skip = false;
        } else {
            if !pl.is_empty() { pl.push(new_pl[i].pos); result.push(std::mem::take(&mut pl)); }
            let mut left = new_pl[i].pair_idx;
            let mut j = (i + 1) % new_pl.len();
            while j != beg && new_pl[j].pair_idx != left {
                if new_pl[j].pair_idx != -1 && !new_pl[j].is_forward { left = new_pl[j].pair_idx; }
                j = (j + 1) % new_pl.len();
            }
            i = j;
            skip = true;
        }
        if i == beg { break; }
    }
    if !pl.is_empty() {
        if new_pl[i].pair_idx == -1 { pl.push(new_pl[i].pos); }
        result.push(pl);
    }
    (result, insert_skip)
}

// ---------------------------------------------------------------------------------------------------------------
// the tower
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LayerType { Normal, Contact, Solid, ContactUp }

#[derive(Clone, Debug)]
struct ToolChange { old_tool: usize, new_tool: usize, required_depth: f32, wipe_volume: f32, wipe_length: f32, purge_volume: f32 }

#[derive(Clone, Debug)]
struct LayerInfo { z: f32, height: f32, depth: f32, extra_spacing: f32, tool_changes: Vec<ToolChange>, extruder_fill: bool }
impl LayerInfo { fn toolchanges_depth(&self) -> f32 { self.tool_changes.iter().map(|t| t.required_depth).sum() } }

#[derive(Clone, Debug, Default)]
struct Block {
    block_id: usize,
    category: i32,
    layer_depths: Vec<f32>,
    finish_depth: Vec<f32>,
    layers_type: Vec<Option<LayerType>>,
    depth: f32,
    start_depth: f32,
    cur_depth: f32,
    last_filament_change_id: i32,
}
impl Block { fn lt(&self, layer: usize) -> LayerType { self.layers_type.get(layer).copied().flatten().unwrap_or(LayerType::Normal) } }

/// libstdc++ `unordered_map<int,_>` iteration order for keys inserted in the given order (13 buckets, new node at the
/// head of its bucket, or at the list head when the bucket is empty). Orca iterates such a map when it creates the tower
/// blocks of one layer, so the order decides which category sits lower on the tower. Exact for up to 13 distinct keys.
fn unordered_iteration_order(keys: &[i32]) -> Vec<i32> {
    let mut list: Vec<i32> = Vec::new();
    for &k in keys {
        if list.contains(&k) { continue; }
        let b = (k as i64).rem_euclid(13);
        match list.iter().position(|&x| (x as i64).rem_euclid(13) == b) {
            Some(p) => list.insert(p, k),
            None => list.insert(0, k),
        }
    }
    list
}

pub struct WipeTower {
    cfg: Rc<WipeTowerCfg>,
    pw: f32,
    width: f32,
    depth: f32,
    height: f32,
    brim_width: f32,
    y_shift: f32,
    z_pos: f32,
    layer_h: f32,
    flow: f32,
    plan: Vec<LayerInfo>,
    layer_idx: usize,
    first_layer_idx: Option<usize>,
    extra_spacing: f32,
    blocks: Vec<Block>,
    block_gap: BTreeMap<i32, f32>,
    skip_points: Vec<Vec<V2>>,
    rib_length: f32,
    rib_width: f32,
    rib_offset: V2,
    cur_layer_id: usize,
    num_layer_changes: u32,
    num_tool_changes: u32,
    current_tool: usize,
    left_to_right: bool,
    layer_finished: bool,
    cur_block: Option<usize>,
    used_len: Vec<f32>,
    categories: Vec<i32>,
    bed: [V2; 2],
    notes: Vec<String>,
    outer_min: V2,
    outer_max: V2,
    outer_z: f32,
    brim_width_real: f32,
}

fn limit_depth_by_height(h: f32) -> f32 {
    let table: [(f32, f32); 4] = [(5.0, 5.0), (100.0, 20.0), (250.0, 40.0), (350.0, 60.0)];
    let mut i = 0;
    while i < table.len() {
        let cur = table[i];
        if cur.0 >= h { return cur.1; }
        i += 1;
        if i == table.len() { return cur.1; }
        let next = table[i];
        if next.0 > h { return cur.1 + (h - cur.0) / (next.0 - cur.0) * (next.1 - cur.1); }
    }
    0.0
}
fn auto_brim_by_height(h: f32) -> f32 { if h < 100.0 { h / 100.0 * 8.0 } else { 8.0 } }

impl WipeTower {
    pub fn new(cfg: WipeTowerCfg, initial_tool: usize, bed_min: V2, bed_max: V2) -> WipeTower {
        let cats: Vec<i32> = cfg.fil.iter().map(|f| f.category).collect();
        let nf = cfg.fil.len();
        WipeTower {
            pw: cfg.perimeter_width, width: cfg.width0, depth: 0.0, height: 0.0, brim_width: cfg.brim_width, y_shift: 0.0, z_pos: 0.0, layer_h: 0.0, flow: 0.038,
            plan: Vec::new(), layer_idx: 0, first_layer_idx: None, extra_spacing: cfg.extra_spacing0, blocks: Vec::new(), block_gap: BTreeMap::new(),
            skip_points: Vec::new(), rib_length: 0.0, rib_width: cfg.rib_width, rib_offset: [0.0, 0.0], cur_layer_id: 0, num_layer_changes: 0, num_tool_changes: 0,
            current_tool: initial_tool, left_to_right: true, layer_finished: false, cur_block: None, used_len: vec![0.0; nf], categories: cats,
            bed: [bed_min, bed_max], notes: Vec::new(), outer_min: [f32::MAX; 2], outer_max: [f32::MIN; 2], outer_z: f32::MAX, brim_width_real: 0.0, cfg: Rc::new(cfg),
        }
    }

    fn rec_outer(&mut self, pts: &[V2], dy: f32) {
        if pts.is_empty() { return; }
        if self.z_pos < self.outer_z - 1e-4 { self.outer_z = self.z_pos; self.outer_min = [f32::MAX; 2]; self.outer_max = [f32::MIN; 2]; }
        if (self.z_pos - self.outer_z).abs() < 1e-4 {
            for p in pts {
                self.outer_min = [self.outer_min[0].min(p[0]), self.outer_min[1].min(p[1] + dy)];
                self.outer_max = [self.outer_max[0].max(p[0]), self.outer_max[1].max(p[1] + dy)];
            }
        }
    }
    /// `get_bbx`: extents of the lowest layer's outer wall (wall + brim loops), tower-local mm.
    pub fn outer_bbox(&self) -> [V2; 2] {
        if self.outer_min[0] > self.outer_max[0] { return [[0.0, 0.0], [0.0, 0.0]]; }
        [self.outer_min, self.outer_max]
    }

    fn filament_area(&self) -> f32 { self.cfg.fil[0].filament_area }
    fn extrusion_flow(&self, h: f32) -> f32 { h * (self.pw - h * (1.0 - std::f32::consts::PI / 4.0)) / self.filament_area() }
    fn volume_to_length(&self, vol: f32, lw: f32, h: f32) -> f32 { (vol / (h * (lw - h * (1.0 - std::f32::consts::PI / 4.0)))).max(0.0) }
    fn length_to_volume(&self, len: f32, lw: f32, h: f32) -> f32 { (len * (h * (lw - h * (1.0 - std::f32::consts::PI / 4.0)))).max(0.0) }
    fn is_first_layer(&self) -> bool { self.first_layer_idx == Some(self.layer_idx) }
    fn category(&self, tool: usize) -> i32 { self.categories.get(tool).copied().unwrap_or(0) }
    fn block_index(&self, cat: i32) -> Option<usize> { self.blocks.iter().position(|b| b.category == cat) }
    fn gap_width(&self, tool: usize) -> f32 { self.block_gap.get(&self.fil_cat(tool)).copied().unwrap_or(self.pw) }
    fn fil_cat(&self, tool: usize) -> i32 { self.cfg.fil[tool].category }

    /// `WipeTower::plan_toolchange` (extruder-change flavour: one nozzle per extruder, so no ramming).
    pub fn plan_toolchange(&mut self, z: f32, h: f32, old_tool: usize, new_tool: usize, wipe_volume: f32, purge_volume: f32) {
        if self.plan.last().map_or(true, |l| l.z + WT_EPSILON < z) {
            self.plan.push(LayerInfo { z, height: h, depth: 0.0, extra_spacing: 1.0, tool_changes: Vec::new(), extruder_fill: true });
        }
        if self.first_layer_idx.is_none() && (!self.cfg.no_sparse_layers || old_tool != new_tool) { self.first_layer_idx = Some(self.plan.len() - 1); }
        if old_tool == new_tool { return; }
        let width = self.width - 2.0 * self.pw;
        if width <= EPSILON { return; }
        let len = self.volume_to_length(wipe_volume, self.pw, h);
        let depth = (len / width).ceil() * self.pw;
        self.plan.last_mut().unwrap().tool_changes.push(ToolChange { old_tool, new_tool, required_depth: depth, wipe_volume, wipe_length: len, purge_volume });
    }

    fn set_toolchange(&self, old_tool: usize, new_tool: usize, h: f32, wipe_volume: f32, purge_volume: f32) -> ToolChange {
        let width = self.width - 2.0 * self.pw;
        let len = self.volume_to_length(wipe_volume, self.pw, h);
        let depth = (len / width).ceil() * self.gap_width(new_tool);
        ToolChange { old_tool, new_tool, required_depth: depth, wipe_volume, wipe_length: len, purge_volume }
    }

    fn calc_block_infill_gap(&mut self) {
        let mut cats: Vec<i32> = Vec::new();
        for l in &self.plan { for t in &l.tool_changes { let c = self.cfg.fil[t.new_tool].category; if !cats.contains(&c) { cats.push(c); } } }
        let extra_width = (self.extra_spacing - 1.0) * self.pw;
        for c in cats { self.block_gap.insert(c, extra_width + self.pw); }
        for idx in 0..self.plan.len() {
            let h = self.plan[idx].height;
            for k in 0..self.plan[idx].tool_changes.len() {
                let t = self.plan[idx].tool_changes[k].clone();
                self.plan[idx].tool_changes[k] = self.set_toolchange(t.old_tool, t.new_tool, h, t.wipe_volume, t.purge_volume);
            }
        }
        self.extra_spacing = 1.0;
    }

    fn generate_wipe_tower_blocks(&mut self, add_solid_flag: bool) {
        let n = self.plan.len();
        // 1. per layer, per category depth in the order the categories were first met
        let mut all_depth: Vec<Vec<(i32, f32)>> = vec![Vec::new(); n];
        for (li, info) in self.plan.iter().enumerate() {
            for t in &info.tool_changes {
                let cat = self.cfg.fil[t.new_tool].category;
                if let Some(e) = all_depth[li].iter_mut().find(|e| e.0 == cat) { e.1 += t.required_depth; } else { all_depth[li].push((cat, t.required_depth)); }
            }
        }
        // 3. blocks, in unordered_map iteration order per layer
        self.blocks.clear();
        let mut per_layer: Vec<BTreeMap<i32, f32>> = vec![BTreeMap::new(); n];
        for li in 0..n {
            let keys: Vec<i32> = all_depth[li].iter().map(|e| e.0).collect();
            for (c, d) in &all_depth[li] { per_layer[li].insert(*c, *d); }
            for c in unordered_iteration_order(&keys) {
                let bi = match self.block_index(c) {
                    Some(i) => i,
                    None => { let id = self.blocks.len(); self.blocks.push(Block { block_id: id, category: c, last_filament_change_id: -1, ..Default::default() }); id }
                };
                let b = &mut self.blocks[bi];
                if b.layer_depths.is_empty() { b.layer_depths = vec![0.0; n]; b.finish_depth = vec![0.0; n]; b.layers_type = vec![Some(LayerType::Normal); n]; }
                let d = per_layer[li][&c];
                b.depth = b.depth.max(d);
                b.layer_depths[li] = d;
            }
        }
        // 4. real depth for every layer (propagated downwards)
        for li in (0..n).rev() {
            self.plan[li].depth = 0.0;
            for b in self.blocks.iter_mut() {
                if li + 1 < n { b.layer_depths[li] = b.layer_depths[li].max(b.layer_depths[li + 1]); }
                self.plan[li].depth += b.layer_depths[li];
            }
        }
        if self.cfg.tower_framework {
            for li in 1..n {
                self.plan[li].depth = 0.0;
                for b in self.blocks.iter_mut() { b.layer_depths[li] = b.layer_depths[0]; self.plan[li].depth += b.layer_depths[li]; }
            }
        }
        if add_solid_flag {
            let solid_low = 4usize;
            let mut layers_used: Vec<Vec<i32>> = Vec::new();
            let mut first_tool: i64 = -1;
            for l in &self.plan { if !l.tool_changes.is_empty() { first_tool = l.tool_changes[0].old_tool as i64; break; } }
            for info in &self.plan {
                let mut used: Vec<i32> = Vec::new();
                if info.tool_changes.is_empty() {
                    used.push(if first_tool < 0 { 0 } else { self.category(first_tool as usize) });
                } else {
                    for t in &info.tool_changes { used.push(self.category(t.old_tool)); used.push(self.category(t.new_tool)); }
                    first_tool = info.tool_changes.last().unwrap().new_tool as i64;
                }
                layers_used.push(used);
            }
            let pw = self.pw;
            for b in self.blocks.iter_mut() {
                for li in 0..n {
                    let cat_depth = per_layer[li].get(&b.category).copied().unwrap_or(0.0);
                    if cat_depth < b.layer_depths[li] - pw {
                        let cur_has = layers_used[li].contains(&b.category);
                        let mut lc = solid_low;
                        while lc > 0 {
                            if li + lc < n {
                                let up_has = layers_used[li + lc].contains(&b.category);
                                if cur_has != up_has { b.layers_type[li] = Some(LayerType::Solid); break; }
                            }
                            lc -= 1;
                        }
                    }
                    if li > 0 {
                        let cur_has = layers_used[li].contains(&b.category);
                        let pre_has = layers_used[li - 1].contains(&b.category);
                        if cur_has != pre_has { b.layers_type[li] = Some(LayerType::Contact); }
                        if b.layers_type[li - 1] == Some(LayerType::Contact) && b.layers_type[li] != Some(LayerType::Contact) { b.layers_type[li] = Some(LayerType::ContactUp); }
                    }
                }
            }
        }
    }

    fn update_all_layer_depth(&mut self) {
        self.depth = 0.0;
        let start_offset = self.pw;
        let mut start_depth = start_offset;
        let es = self.extra_spacing;
        let nplan = self.plan.len();
        for b in self.blocks.iter_mut() {
            b.depth *= es;
            b.start_depth = start_depth;
            start_depth += b.depth;
            self.depth += b.depth;
            for d in b.layer_depths.iter_mut() { *d *= es; }
            for k in 0..nplan { self.plan[k].depth *= es; }
        }
        if self.depth > 0.0 { self.depth += start_offset; }
    }

    fn get_all_wall_skip_points(&mut self) {
        self.skip_points = vec![Vec::new(); self.plan.len()];
        for li in 0..self.plan.len() { self.get_wall_skip_points(li); }
    }

    fn get_wall_skip_points(&mut self, layer_id: usize) {
        let pre_access_layer = 4i32;
        let mut cur_block_depth: BTreeMap<i32, f32> = BTreeMap::new();
        let layer = self.plan[layer_id].clone();
        for t in &layer.tool_changes {
            let new_f = t.new_tool;
            let wipe_depth = t.required_depth;
            let cat = self.cfg.fil[new_f].category;
            let Some(bi) = self.block_index(cat) else { continue };
            let block_start = self.blocks[bi].start_depth;
            let process_depth = *cur_block_depth.entry(cat).or_insert(block_start);
            let gap = self.gap_width(new_f);
            let es = self.plan[layer_id].extra_spacing;
            let res: V2 = match layer_id % 4 {
                0 => [0.0, process_depth],
                1 => [self.width, process_depth + wipe_depth - es * gap],
                2 => [self.width, process_depth],
                _ => [0.0, process_depth + wipe_depth - es * gap],
            };
            self.skip_points[layer_id].push(res);
            cur_block_depth.insert(cat, process_depth + wipe_depth);
            let solid_toolchange = self.blocks[bi].lt(layer_id) == LayerType::Contact;
            if solid_toolchange && self.cfg.enable_interface {
                for j in 0..pre_access_layer {
                    let pre = layer_id as i32 - j;
                    if pre < 0 { break; }
                    self.skip_points[pre as usize].push(res);
                }
            }
        }
        if self.cfg.enable_interface {
            for bi in 0..self.blocks.len() {
                let (cat, start, ld) = (self.blocks[bi].category, self.blocks[bi].start_depth, self.blocks[bi].layer_depths[layer_id]);
                let block_depth = cur_block_depth.get(&cat).copied().unwrap_or(start);
                if block_depth + EPSILON >= start + ld - self.pw { continue; }
                let block_solid = self.blocks[bi].lt(layer_id) == LayerType::Contact;
                let add = block_solid && (block_depth - start).abs() < EPSILON;
                if add {
                    let dy_skip = ld - self.pw;
                    let n_skip = ((dy_skip + 0.25 * self.pw) / self.pw + 1.0) as i32;
                    let grid_depth = self.pw * (n_skip - 1) as f32;
                    let res: V2 = match layer_id % 4 {
                        0 => [0.0, block_depth],
                        1 => [self.width, block_depth + grid_depth],
                        2 => [self.width, block_depth],
                        _ => [0.0, block_depth + grid_depth],
                    };
                    self.skip_points[layer_id].push(res);
                    for j in 0..pre_access_layer {
                        let pre = layer_id as i32 - j;
                        if pre < 0 { break; }
                        self.skip_points[pre as usize].push(res);
                    }
                }
            }
        }
    }

    fn plan_tower_new(&mut self) {
        if self.brim_width < 0.0 { self.brim_width = auto_brim_by_height(self.height); }
        self.calc_block_infill_gap();
        if self.cfg.use_rib_wall {
            self.generate_wipe_tower_blocks(false);
            let max_depth: f32 = self.blocks.iter().map(|b| b.depth).sum::<f32>() + self.pw;
            let square = align_ceil((max_depth * self.width * self.extra_spacing).sqrt(), self.pw);
            self.width = square;
            for idx in 0..self.plan.len() {
                let h = self.plan[idx].height;
                for k in 0..self.plan[idx].tool_changes.len() {
                    let t = self.plan[idx].tool_changes[k].clone();
                    self.plan[idx].tool_changes[k] = self.set_toolchange(t.old_tool, t.new_tool, h, t.wipe_volume, t.purge_volume);
                }
            }
        }
        self.generate_wipe_tower_blocks(true);
        let max_depth: f32 = self.blocks.iter().map(|b| b.depth).sum();
        let min_depth = limit_depth_by_height(self.height);
        if max_depth + EPSILON < min_depth {
            if self.cfg.use_rib_wall { self.rib_length = self.rib_length.max(min_depth * 2f32.sqrt()); } else { self.extra_spacing = (min_depth / max_depth).max(self.extra_spacing); }
        }
        let line_len = self.width - 2.0 * self.pw;
        for idx in 0..self.plan.len() {
            let es = self.extra_spacing;
            let h = self.plan[idx].height;
            if idx == 0 {
                self.plan[idx].extra_spacing = 1.0;
                for k in 0..self.plan[idx].tool_changes.len() {
                    let wipe_depth = self.plan[idx].tool_changes[k].required_depth * es;
                    let wipe_line_count = wipe_depth / self.pw;
                    let wl = wipe_line_count * line_len;
                    let wv = self.length_to_volume(wl, self.pw, h);
                    let t = &mut self.plan[idx].tool_changes[k];
                    t.required_depth = wipe_depth;
                    t.wipe_length = wl;
                    t.wipe_volume = wv;
                }
            } else {
                self.plan[idx].extra_spacing = es;
                for k in 0..self.plan[idx].tool_changes.len() {
                    let wv = self.plan[idx].tool_changes[k].wipe_volume;
                    let wl = self.volume_to_length(wv, self.pw, h);
                    let t = &mut self.plan[idx].tool_changes[k];
                    t.required_depth *= es;
                    t.wipe_length = wl;
                }
            }
        }
        self.update_all_layer_depth();
        if self.cfg.use_gap_wall { self.get_all_wall_skip_points(); }
        let diagonal = (self.depth * self.depth + self.width * self.width).sqrt();
        self.rib_length = self.rib_length.max(diagonal);
        self.rib_length += self.cfg.extra_rib_length;
        self.rib_length = self.rib_length.max(diagonal);
        self.rib_width = self.rib_width.min(self.depth.min(self.width) / 2.0);
    }

    fn set_layer(&mut self, z: f32, h: f32, is_first_layer: bool) {
        self.z_pos = z;
        self.layer_h = h;
        self.layer_finished = false;
        if is_first_layer { self.num_layer_changes = 0; self.num_tool_changes = 0; } else { self.num_layer_changes += 1; }
        self.flow = self.extrusion_flow(h);
        while !self.plan.is_empty() && self.plan[self.layer_idx].z < z - WT_EPSILON && self.layer_idx + 1 != self.plan.len() { self.layer_idx += 1; }
    }

    fn align_perimeter(&self, mut b: [V2; 4]) -> [V2; 4] {
        // b = [ld, rd, ru, lu]
        let spacing = self.extra_spacing * self.pw;
        let mut up = b[3][1] - self.pw - EPSILON;
        up = align_ceil(up, spacing);
        up += self.pw;
        up = up.min(self.depth);
        let mut down = b[0][1] - self.pw + EPSILON;
        down = align_floor(down, spacing);
        down += self.pw;
        down = down.max(-self.y_shift);
        b[3][1] = up; b[2][1] = up; b[0][1] = down; b[1][1] = down;
        b
    }
    fn make_box(left: f32, bottom: f32, width: f32, height: f32) -> [V2; 4] {
        [[left, bottom], [left + width, bottom], [left + width, bottom + height], [left, bottom + height]]
    }

    fn new_writer(&self, h: f32) -> Writer {
        let mut w = Writer::new(&self.cfg, h, self.pw);
        w.flow = self.flow;
        w.z = self.z_pos;
        w.first_layer = self.cur_layer_id == 0;
        w.gcode.push_str(&format!("; LAYER_HEIGHT: {:.6}\n; FEATURE: Prime tower\n; LINE_WIDTH: {:.6}\n", h, self.pw));
        w
    }

    fn need_thick_bridge_flow(&self, y: f32) -> bool {
        if self.layer_h >= 0.2 { return false; }
        if self.layer_idx == 0 || self.layer_idx == 1 { return false; }
        let Some(bi) = self.cur_block else { return false };
        let b = &self.blocks[bi];
        let end = b.start_depth + b.depth - self.pw;
        let start = b.finish_depth[self.cur_layer_id - 1];
        y > start && y < end
    }

    fn get_next_pos(&self, cb: &[V2; 4], wipe_length: f32, solid: bool, tool: usize) -> V2 {
        let (xl, xr) = (cb[0][0], cb[1][0]);
        let line_count = (wipe_length / (xr - xl)) as i32;
        let dy = self.plan[self.layer_idx].extra_spacing * self.gap_width(tool);
        let y_offset = line_count as f32 * dy;
        let mut res = match self.cur_layer_id % 4 {
            0 => cb[0],
            1 => [cb[1][0], cb[1][1] + y_offset],
            2 => cb[1],
            _ => [cb[0][0], cb[0][1] + y_offset],
        };
        let contact_pre = solid && self.cfg.enable_interface;
        if contact_pre {
            let d = self.cfg.fil[tool].interface_pre_extrusion_dist;
            let bb = self.bed_local();
            if res[0] < self.width / 2.0 { res[0] -= d; } else { res[0] += d; }
            if res[0] < bb[0][0] { res[0] = bb[0][0]; }
            if res[0] > bb[1][0] { res[0] = bb[1][0]; }
        }
        res
    }
    fn bed_local(&self) -> [V2; 2] {
        [[self.bed[0][0] - self.cfg.pos[0] - self.rib_offset[0], self.bed[0][1] - self.cfg.pos[1] - self.rib_offset[1]],
         [self.bed[1][0] - self.cfg.pos[0] - self.rib_offset[0], self.bed[1][1] - self.cfg.pos[1] - self.rib_offset[1]]]
    }
}

// ---------------------------------------------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------------------------------------------

impl WipeTower {
    fn rib_polygon(&self, wt_box: &[V2; 4]) -> Vec<Pt64> {
        let get_len = |cur: f32, max: f32, max_len: f32| -> f32 { (max - cur).abs() / max * max_len };
        let diagonal_width = ((self.rib_width as f64 * SC).round() as i64 / 2) as f64;
        let (a, b) = (self.width, self.depth);
        let l1 = (scaled_pt([0.0, 0.0]), scaled_pt([a, b]));
        let l2 = (scaled_pt([a, 0.0]), scaled_pt([0.0, b]));
        let len1 = (((l1.1[0] - l1.0[0]).powi(2) + (l1.1[1] - l1.0[1]).powi(2)).sqrt() / SC) as f32;
        let mut extra = ((self.rib_length - len1).max(0.0)) / 2.0;
        extra = get_len(self.z_pos, self.height, extra);
        let extra_sc = (extra as f64 * SC).round();
        let ys = [0.0, (self.y_shift as f64 * SC).round()];
        let mut ex = |l: (Pt64, Pt64)| -> (Pt64, Pt64) {
            let (p, q) = extend_line(l.0, l.1, extra_sc);
            ([p[0] - ys[0], p[1] - ys[1]], [q[0] - ys[0], q[1] - ys[1]])
        };
        let (p1, q1) = ex(l1);
        let (p2, q2) = ex(l2);
        let poly_1 = rect_around_line(p1, q1, diagonal_width);
        let poly_2 = rect_around_line(p2, q2, diagonal_width);
        let poly: Vec<Pt64> = wt_box.iter().map(|p| scaled_pt(*p)).collect();
        let u = geom::union_all(&[&ring_to_poly_mm(&poly_1), &ring_to_poly_mm(&poly_2), &ring_to_poly_mm(&poly)]);
        first_outer(&u)
    }

    /// returns (polygon returned to the caller, in tower-local mm)
    fn generate_support_wall(&mut self, writer: &mut Writer, wt_box: &[V2; 4], feedrate: f32, rib_wall: bool, extrude_perimeter: bool, skip_points: bool) -> Vec<V2> {
        let retract_length = self.cfg.fil[self.current_tool].retract_length;
        let retract_speed = self.cfg.fil[self.current_tool].retract_speed * 60.0;
        let mut wall: Vec<Pt64> = if rib_wall { self.rib_polygon(wt_box) } else { rect_poly(wt_box[0], wt_box[2]) };
        if self.cfg.fillet {
            if !rib_wall && self.y_shift > EPSILON {
            } else {
                if rib_wall { wall = rounding_polygon(&wall, 2.0, 30.0 / 180.0 * std::f64::consts::PI); }
                let boxp = rect_poly(wt_box[0], wt_box[2]);
                let u = geom::union_all(&[&ring_to_poly_mm(&wall), &ring_to_poly_mm(&boxp)]);
                wall = first_outer(&u);
            }
        }
        let wallf: Vec<V2> = wall.iter().map(|p| unscaled_pt(*p)).collect();
        if !extrude_perimeter { return wallf; }
        let (result_wall, insert_skip): (Vec<Vec<V2>>, Vec<V2>);
        let sp: Vec<V2> = if skip_points { self.skip_points.get(self.cur_layer_id).cloned().unwrap_or_default() } else { Vec::new() };
        if skip_points && !sp.is_empty() {
            let (r, ins) = remove_points_from_polygon(&wall, &sp, 2.5 * self.pw as f64, self.width);
            result_wall = r; insert_skip = ins;
        } else {
            let mut pl = wallf.clone();
            if let Some(f) = pl.first().copied() { pl.push(f); }
            result_wall = vec![pl];
            insert_skip = wallf.clone();
        }
        writer.generate_path(&result_wall, feedrate, retract_length, retract_speed);
        if self.cur_layer_id == 0 {
            let mut mn = [f32::MAX; 2];
            for pl in &result_wall { for p in pl { mn[0] = mn[0].min(p[0]); mn[1] = mn[1].min(p[1]); } }
            self.rib_offset = [-mn[0], -mn[1]];
        }
        insert_skip
    }

    fn construct_tcr(&self, w: Writer, old_tool: usize, is_finish: bool, is_tool_change: bool, purge_volume: f32, is_contact: bool) -> Tcr {
        let start = w.start_pos;
        Tcr {
            print_z: self.z_pos, layer_height: self.layer_h, start_pos: start, end_pos: w.pos_rotated(), elapsed_time: w.elapsed, gcode: w.gcode, wipe_path: w.wipe_path,
            purge_volume, initial_tool: old_tool as i32, new_tool: self.current_tool as i32, is_finish_first: is_finish, is_contact, is_tool_change,
            tool_change_start_pos: if is_tool_change { start } else { [0.0, 0.0] },
        }
    }

    fn rectangle_fill_box(&self, w: &mut Writer, fb: &[V2; 4], finish_rect_wipe_path: &mut Vec<V2>, f: f32) {
        let (ld, rd, ru, lu) = (fb[0], fb[1], fb[2], fb[3]);
        let width = rd[0] - ld[0];
        let height = ru[1] - rd[1];
        if height > self.pw - WT_EPSILON {
            // rectangle_fill_box(ld, width, height)
            let need_change_flow = self.need_thick_bridge_flow(ld[1]);
            let corners = [ld, [ld[0] + width, ld[1]], [ld[0] + width, ld[1] + height], [ld[0], ld[1] + height]];
            let mut ioc = 0usize;
            if w.x() - ld[0] > ld[0] + width - w.x() { ioc = 1; }
            if w.y() - ld[1] > ld[1] + height - w.y() { ioc = if ioc == 0 { 3 } else { 2 }; }
            let cy = w.y(); w.travel(corners[ioc][0], cy, 0.0);
            let cx = w.x(); w.travel(cx, corners[ioc][1], 0.0);
            let mut i = ioc;
            let mut flow_changed = false;
            loop {
                i += 1; if i == 4 { i = 0; }
                if need_change_flow {
                    if i == 1 {
                        w.flow = self.extrusion_flow(0.2);
                        w.gcode.push_str("; LAYER_HEIGHT: 0.200000\n");
                        flow_changed = true;
                    } else if i == 2 && flow_changed {
                        w.flow = self.flow;
                        w.gcode.push_str(&format!("; LAYER_HEIGHT: {:.6}\n", self.layer_h));
                    }
                }
                w.extrude_v(corners[i], f);
                if i == ioc { break; }
            }
            let target = if v2eq(w.cur, ld) { rd } else if v2eq(w.cur, rd) { ru } else if v2eq(w.cur, ru) { lu } else { ld };
            finish_rect_wipe_path.push(w.cur);
            finish_rect_wipe_path.push(target);
        } else if height > WT_EPSILON {
            // line(ld, rd)
            let (mut p0, mut p1) = (ld, rd);
            let need_change_flow = self.need_thick_bridge_flow(p0[1]);
            if need_change_flow { w.flow = self.extrusion_flow(0.2); }
            if (w.x() - p0[0]).abs() > (w.x() - p1[0]).abs() { std::mem::swap(&mut p0, &mut p1); }
            let cy = w.y(); w.travel(p0[0], cy, 0.0);
            let cx = w.x(); w.travel(cx, p0[1], 0.0);
            w.extrude_v(p1, 0.0);
            if need_change_flow { w.flow = self.flow; }
            let target = if v2eq(w.cur, ld) { rd } else { ld };
            finish_rect_wipe_path.push(w.cur);
            finish_rect_wipe_path.push(target);
        }
    }

    fn finish_layer_new(&mut self, extrude_perimeter: bool, extrude_fill: bool, extrude_fill_wall: bool) -> Tcr {
        self.layer_finished = true;
        let h = self.layer_h;
        let tool = self.current_tool;
        let mut w = self.new_writer(h);
        w.tool = tool;
        let ys = self.y_shift;
        w.set_y_shift(ys);
        w.append(";WIPE_TOWER_START\n");
        let first_layer = self.is_first_layer();
        let feedrate = if first_layer { (self.cfg.first_layer_speed * 60.0).min(self.cfg.max_speed) } else { (60.0 * self.cfg.fil[tool].max_e_speed / self.flow).min(self.cfg.max_speed) };
        let toolchanges_on_layer = self.plan[self.layer_idx].toolchanges_depth() > WT_EPSILON;
        let mut finish_rect_wipe_path: Vec<V2> = Vec::new();
        let multi_block_fill = self.blocks.len() > 1 && (extrude_fill_wall || extrude_fill);
        let mut fill_boxes: Vec<[V2; 4]> = Vec::new();
        if multi_block_fill {
            for b in &self.blocks {
                let mut bfh = b.depth - 2.0 * self.pw;
                if self.cur_layer_id < b.layer_depths.len() { bfh = b.layer_depths[self.cur_layer_id] - 2.0 * self.pw; }
                if bfh <= WT_EPSILON { continue; }
                fill_boxes.push(Self::make_box(self.pw, b.start_depth + self.pw, self.width - 2.0 * self.pw, bfh));
            }
        }
        if fill_boxes.is_empty() {
            let mut fbd = self.depth - 2.0 * self.pw;
            if self.blocks.len() == 1 { fbd = self.plan[self.layer_idx].depth - 2.0 * self.pw; }
            fill_boxes.push(Self::make_box(self.pw, self.pw, self.width - 2.0 * self.pw, fbd));
        }
        let (wtw, wtd) = (self.width, self.depth);
        let start = if self.left_to_right { fill_boxes[0][2] } else { fill_boxes[0][3] };
        w.set_initial_position(start, wtw, wtd);
        let next_soluble = if self.layer_idx + 1 == self.plan.len() { false } else { self.plan[self.layer_idx + 1].tool_changes.iter().any(|t| self.cfg.fil[t.new_tool].is_soluble || self.cfg.fil[t.old_tool].is_soluble) };
        let solid_infill = next_soluble || first_layer; // m_adhesion is true
        for (bi, fb) in fill_boxes.iter().enumerate() {
            if bi > 0 { let p = if self.left_to_right { fb[2] } else { fb[3] }; w.travel_v(p, 0.0); }
            if extrude_fill_wall && fb[2][1] - fb[1][1] > WT_EPSILON { self.rectangle_fill_box(&mut w, fb, &mut finish_rect_wipe_path, feedrate); }
            let dy = fb[3][1] - fb[0][1] - self.pw;
            let mut left = fb[3][0] + 2.0 * self.pw;
            let mut right = fb[2][0] - 2.0 * self.pw;
            if extrude_fill && dy > self.pw {
                w.travel(fb[0][0] + self.pw * 2.0, fb[0][1], 0.0);
                w.append(";--------------------\n; CP EMPTY GRID START\n").comment_with_value(" layer #", self.num_layer_changes as i64 + 1);
                if solid_infill {
                    let mut sparse_factor = 1.5f32;
                    if first_layer { left -= self.pw; right += self.pw; sparse_factor = 1.0; }
                    let mut y = fb[0][1] + self.pw;
                    let n = (dy / (self.pw * sparse_factor)) as i32;
                    let spacing = (dy - self.pw) / (n - 1) as f32;
                    for i in 0..n {
                        let cx = w.x(); w.extrude(cx, y, feedrate);
                        w.extrude(if i % 2 == 1 { left } else { right }, y, 0.0);
                        y += spacing;
                    }
                    let cx = w.x(); w.extrude(cx, fb[3][1], 0.0);
                } else {
                    w.extrude_v([fb[3][0] + self.pw * 2.0, fb[3][1]], feedrate);
                    let bridging = 10.0f32;
                    let n = 1 + ((right - left) / bridging) as i32;
                    let dx = (right - left) / n as f32;
                    for i in 1..=n {
                        let x = left + dx * i as f32;
                        let cy = w.y(); w.travel(x, cy, 0.0);
                        w.extrude(x, if i % 2 == 1 { fb[1][1] } else { fb[2][1] }, 0.0);
                    }
                    finish_rect_wipe_path.clear();
                    finish_rect_wipe_path.push(w.cur);
                    finish_rect_wipe_path.push([left + dx * n as f32, if n % 2 == 1 { fb[2][1] } else { fb[1][1] }]);
                }
                w.append("; CP EMPTY GRID END\n;------------------\n\n\n\n\n\n\n");
            }
        }
        let mut wipe_tower_depth = self.depth;
        if self.blocks.len() == 1 { wipe_tower_depth = self.plan[self.layer_idx].depth + self.pw; }
        let mut wt_box = Self::make_box(0.0, 0.0, self.width, wipe_tower_depth);
        wt_box = self.align_perimeter(wt_box);
        let mut outer_wall = self.generate_support_wall(&mut w, &wt_box, feedrate, self.cfg.use_rib_wall, extrude_perimeter, self.cfg.use_gap_wall);
        if extrude_perimeter { let ow = outer_wall.clone(); let ys = self.y_shift; self.rec_outer(&ow, ys); }
        // brim chamfer
        let spacing = self.pw - h * (1.0 - std::f32::consts::FRAC_PI_4);
        let mut loops_num = ((self.brim_width + spacing / 2.0) / spacing) as i32;
        let max_chamfer_width = 3.0f32;
        if !first_layer {
            if self.plan[self.layer_idx].depth != self.plan[0].depth {
                loops_num = 0;
            } else {
                let chamfer_loops = (max_chamfer_width / spacing) as i32;
                let dist_to_1st = self.layer_idx as i32 - self.first_layer_idx.unwrap_or(0) as i32;
                loops_num = loops_num.min(chamfer_loops) - dist_to_1st;
            }
        }
        if loops_num > 0 {
            for _ in 0..loops_num {
                let ring: Polys = vec![Poly { contour: outer_wall.iter().map(|p| [p[0] as f64, p[1] as f64]).collect(), holes: vec![] }];
                let off = geom::offset(&ring, spacing as f64);
                if let Some(p) = off.first() {
                    outer_wall = p.contour.iter().map(|q| [q[0] as f32, q[1] as f32]).collect();
                }
                w.polygon(&outer_wall, feedrate);
                let ow = outer_wall.clone(); self.rec_outer(&ow, 0.0);
            }
        }
        if first_layer && loops_num > 0 { self.brim_width_real = loops_num as f32 * spacing + spacing / 2.0; }
        if extrude_perimeter || loops_num > 0 {
            let wd = self.cfg.fil[tool].wipe_dist;
            w.add_wipe_path(&outer_wall, wd);
        } else {
            let mut target = if v2eq(w.cur, wt_box[0]) { wt_box[1] } else if v2eq(w.cur, wt_box[1]) { wt_box[2] } else if v2eq(w.cur, wt_box[2]) { wt_box[3] } else { wt_box[0] };
            if finish_rect_wipe_path.len() == 2 && v2eq(finish_rect_wipe_path[0], w.cur) { target = finish_rect_wipe_path[1]; }
            let c = w.cur; w.add_wipe_point(c); w.add_wipe_point(target);
        }
        w.append(";WIPE_TOWER_END\n");
        if !self.cfg.no_sparse_layers || toolchanges_on_layer { self.used_len[tool] += std::mem::take(&mut w.used_len); }
        self.construct_tcr(w, tool, true, false, 0.0, false)
    }

    fn finish_block(&mut self, block_idx: usize, filament_id: usize, extrude_fill: bool) -> Tcr {
        let h = self.layer_h;
        let mut w = self.new_writer(h);
        w.tool = filament_id;
        let ys = self.y_shift; w.set_y_shift(ys);
        w.append(";WIPE_TOWER_START\n");
        let first_layer = self.is_first_layer();
        let feedrate = if first_layer { (self.cfg.first_layer_speed * 60.0).min(self.cfg.max_speed) } else { (60.0 * self.cfg.fil[filament_id].max_e_speed / self.flow).min(self.cfg.max_speed) };
        let b = self.blocks[block_idx].clone();
        let fb = Self::make_box(self.pw, b.cur_depth, self.width - 2.0 * self.pw, b.start_depth + b.layer_depths[self.cur_layer_id] - b.cur_depth - self.pw);
        let (wtw, wtd) = (self.width, self.depth);
        w.set_initial_position(if self.left_to_right { fb[2] } else { fb[3] }, wtw, wtd);
        let toolchanges_on_layer = self.plan[self.layer_idx].toolchanges_depth() > WT_EPSILON;
        let mut finish_rect_wipe_path: Vec<V2> = Vec::new();
        if fb[2][1] - fb[1][1] > WT_EPSILON { self.rectangle_fill_box(&mut w, &fb, &mut finish_rect_wipe_path, feedrate); }
        let dy = fb[3][1] - fb[0][1] - self.pw;
        let mut left = fb[3][0] + 2.0 * self.pw;
        let mut right = fb[2][0] - 2.0 * self.pw;
        if extrude_fill && dy > self.pw {
            w.travel(fb[0][0] + self.pw * 2.0, fb[0][1], 0.0);
            w.append(";--------------------\n; CP EMPTY GRID START\n").comment_with_value(" layer #", self.num_layer_changes as i64 + 1);
            let next_soluble = if self.layer_idx + 1 == self.plan.len() { false } else { self.plan[self.layer_idx + 1].tool_changes.iter().any(|t| self.cfg.fil[t.new_tool].is_soluble || self.cfg.fil[t.old_tool].is_soluble) };
            let solid_infill = next_soluble || first_layer;
            if solid_infill {
                let mut sparse_factor = 1.5f32;
                if first_layer { left -= self.pw; right += self.pw; sparse_factor = 1.0; }
                let mut y = fb[0][1] + self.pw;
                let n = (dy / (self.pw * sparse_factor)) as i32;
                let spacing = (dy - self.pw) / (n - 1) as f32;
                for i in 0..n {
                    let cx = w.x(); w.extrude(cx, y, feedrate);
                    w.extrude(if i % 2 == 1 { left } else { right }, y, 0.0);
                    y += spacing;
                }
                let cx = w.x(); w.extrude(cx, fb[3][1], 0.0);
            } else {
                w.extrude_v([fb[3][0] + self.pw * 2.0, fb[3][1]], feedrate);
                let n = 1 + ((right - left) / 10.0) as i32;
                let dx = (right - left) / n as f32;
                for i in 1..=n {
                    let x = left + dx * i as f32;
                    let cy = w.y(); w.travel(x, cy, 0.0);
                    w.extrude(x, if i % 2 == 1 { fb[1][1] } else { fb[2][1] }, 0.0);
                }
                finish_rect_wipe_path.clear();
                finish_rect_wipe_path.push(w.cur);
                finish_rect_wipe_path.push([left + dx * n as f32, if n % 2 == 1 { fb[2][1] } else { fb[1][1] }]);
            }
            w.append("; CP EMPTY GRID END\n;------------------\n\n\n\n\n\n\n");
        }
        let wt_box = self.align_perimeter(Self::make_box(0.0, 0.0, self.width, self.plan[self.layer_idx].depth + self.pw));
        let mut target = if v2eq(w.cur, wt_box[0]) { wt_box[1] } else if v2eq(w.cur, wt_box[1]) { wt_box[2] } else if v2eq(w.cur, wt_box[2]) { wt_box[3] } else { wt_box[0] };
        if finish_rect_wipe_path.len() == 2 && v2eq(finish_rect_wipe_path[0], w.cur) { target = finish_rect_wipe_path[1]; }
        let c = w.cur; w.add_wipe_point(c); w.add_wipe_point(target);
        w.append(";WIPE_TOWER_END\n");
        if !self.cfg.no_sparse_layers || toolchanges_on_layer { self.used_len[filament_id] += std::mem::take(&mut w.used_len); }
        let mut t = self.construct_tcr(w, filament_id, true, false, 0.0, false);
        t.initial_tool = filament_id as i32; t.new_tool = filament_id as i32; t.tool_change_start_pos = [0.0, 0.0];
        t
    }

    fn finish_block_solid(&mut self, block_idx: usize, filament_id: usize, extrude_fill: bool, layer_type: LayerType) -> Tcr {
        let _ = extrude_fill;
        let mut layer_height = self.layer_h;
        let mut e_flow = self.flow;
        let b = self.blocks[block_idx].clone();
        if self.cur_layer_id > 1 && b.lt(self.cur_layer_id - 1) == LayerType::Normal && self.flow < self.extrusion_flow(0.2) {
            layer_height = 0.2;
            e_flow = self.extrusion_flow(0.2);
        }
        let mut w = self.new_writer(layer_height);
        w.flow = e_flow;
        w.tool = filament_id;
        let ys = self.y_shift; w.set_y_shift(ys);
        w.append(";WIPE_TOWER_START\n");
        let first_layer = self.is_first_layer();
        let mut feedrate = if first_layer { (self.cfg.first_layer_speed * 60.0).min(self.cfg.max_speed) } else { (60.0 * self.cfg.fil[filament_id].max_e_speed / self.flow).min(self.cfg.max_speed) };
        if layer_type == LayerType::Contact || layer_type == LayerType::ContactUp { feedrate = 20.0 * 60.0; }
        let fb = Self::make_box(self.pw, b.cur_depth, self.width - 2.0 * self.pw, b.start_depth + b.layer_depths[self.cur_layer_id] - b.cur_depth - self.pw);
        let toolchanges_on_layer = self.plan[self.layer_idx].toolchanges_depth() > WT_EPSILON;
        let dy = fb[3][1] - fb[0][1];
        let n = ((dy + 0.25 * self.pw) / self.pw + 1.0) as i32;
        let spacing = self.pw;
        let grid_depth = spacing * (n - 1) as f32;
        let (mut initial_pos, up_to_down);
        match self.cur_layer_id % 4 {
            0 => { initial_pos = fb[0]; self.left_to_right = true; up_to_down = false; }
            1 => { initial_pos = [fb[1][0], fb[1][1] + grid_depth]; self.left_to_right = false; up_to_down = true; }
            2 => { initial_pos = fb[1]; self.left_to_right = false; up_to_down = false; }
            _ => { initial_pos = [fb[0][0], grid_depth + fb[0][1]]; self.left_to_right = true; up_to_down = true; }
        }
        let left = fb[3][0];
        let right = fb[2][0];
        w.append(";--------------------\n; CP EMPTY GRID START\n").comment_with_value(" layer #", self.num_layer_changes as i64 + 1);
        let is_full_block = (b.cur_depth - b.start_depth).abs() < EPSILON;
        if is_full_block && layer_type == LayerType::Contact && self.cfg.enable_interface {
            let d = self.cfg.fil[self.current_tool].interface_pre_extrusion_dist;
            let bb = self.bed_local();
            let mut sp = initial_pos;
            if sp[0] < self.width / 2.0 { sp[0] -= d; } else { sp[0] += d; }
            sp[0] = sp[0].clamp(bb[0][0], bb[1][0]);
            initial_pos = sp;
            let ct = self.cfg.fil[self.current_tool].interface_print_temp as i32;
            if ct != self.cfg.fil[self.current_tool].nozzle_temperature { w.format_m109(ct); }
            w.retract(-self.cfg.fil[self.current_tool].interface_pre_extrusion_length - 2.0, 100.0);
        }
        let (wtw, wtd) = (self.width, self.depth);
        w.set_initial_position(initial_pos, wtw, wtd);
        for i in 0..n {
            let cy = w.y(); w.extrude(if self.left_to_right { right } else { left }, cy, feedrate);
            if i == n - 1 {
                let c = w.cur; w.add_wipe_point(c); let cy = w.y(); w.add_wipe_point([if self.left_to_right { left } else { right }, cy]);
                break;
            }
            self.left_to_right = !self.left_to_right;
            let cx = w.x(); let cy = w.y(); w.extrude(cx, cy + spacing * if up_to_down { -1.0 } else { 1.0 }, feedrate);
        }
        if layer_type == LayerType::Contact && self.cfg.enable_interface && self.cfg.fil[self.current_tool].interface_print_temp as i32 != self.cfg.fil[self.current_tool].nozzle_temperature {
            w.format_m104(self.cfg.fil[self.current_tool].nozzle_temperature, true);
        }
        w.append("; CP EMPTY GRID END\n;------------------\n\n\n\n\n\n\n");
        w.append(";WIPE_TOWER_END\n");
        if !self.cfg.no_sparse_layers || toolchanges_on_layer { self.used_len[filament_id] += std::mem::take(&mut w.used_len); }
        let mut t = self.construct_tcr(w, filament_id, true, false, 0.0, false);
        t.initial_tool = filament_id as i32; t.new_tool = filament_id as i32; t.tool_change_start_pos = [0.0, 0.0];
        t
    }
}

impl WipeTower {
    fn toolchange_wipe_new(&mut self, w: &mut Writer, cb: &[V2; 4], wipe_length: f32, solid: bool) {
        let first = self.is_first_layer();
        w.flow = self.flow * if first { self.cfg.first_layer_flow_ratio } else { 1.0 };
        let _ = write!(w.gcode, ";CP_TOOLCHANGE_WIPE CT{} FL{}\n", solid as i32, first as i32);
        if first { let _ = write!(w.gcode, "; LINE_WIDTH: {:.6}\n", self.cfg.first_layer_flow_ratio * self.pw); }
        let tool = self.current_tool;
        let retract_length = self.cfg.fil[tool].retract_length;
        let retract_speed = self.cfg.fil[tool].retract_speed * 60.0;
        let (xl, xr) = (cb[0][0], cb[1][0]);
        let should_flat = if !self.cfg.enable_interface && solid { false } else { self.cfg.flat_ironing };
        let should_line_ironing = !(!self.cfg.enable_interface && solid);
        // Orca: m_contact_ironing is false, so `!m_contact_ironing && solid` disables ironing on solid (contact) changes
        let (should_flat_ironing, should_line_ironing) = if solid { (false, false) } else { (self.cfg.flat_ironing, true) };
        let _ = (should_flat, should_line_ironing);
        let mut x_to_wipe = wipe_length;
        let mut dy = if first { self.pw } else { self.plan[self.layer_idx].extra_spacing * self.gap_width(tool) };
        if solid { dy = self.pw; }
        if solid { x_to_wipe = f32::MAX; }
        let mut target_speed = if first { (self.cfg.first_layer_speed * 60.0).min(self.cfg.max_speed) } else { self.cfg.max_speed };
        if solid { target_speed = self.cfg.contact_speed; }
        let wsm = [0.33 * target_speed, 0.375 * target_speed, 0.458 * target_speed, 0.875 * target_speed, target_speed.min(0.875 * target_speed + 50.0)];
        let mut wipe_speed;
        self.left_to_right = (self.cur_layer_id + 3) % 4 >= 2;
        let is_from_up = self.cur_layer_id % 2 == 1;
        let should_heating = self.cfg.fil[tool].cooling_before_tower > EPSILON && !solid && !first;
        let speed_factor = 1.0f32;
        let ironing_flat_area = self.cfg.fil[tool].flat_iron_area;
        let mut i = 0usize;
        loop {
            wipe_speed = if i < wsm.len() { wsm[i] * speed_factor } else { wsm[4] * speed_factor };
            let need_change_flow = self.need_thick_bridge_flow(w.y());
            if need_change_flow {
                w.flow = self.extrusion_flow(0.2);
                w.append("; LAYER_HEIGHT: 0.200000\n");
            }
            let mut ironing_length = 3.0f32;
            let m104 = |w: &mut Writer, tower: &WipeTower| {
                if tower.cfg.fil[tool].cooling_before_tower < EPSILON || !should_heating { return; }
                let target = if first { tower.cfg.fil[tool].nozzle_temperature_initial_layer } else { tower.cfg.fil[tool].nozzle_temperature };
                w.gcode.push_str("M400\n");
                let _ = write!(w.gcode, "M104 T{} S{} N0\n", 0, target);
            };
            if i == 0 && self.cfg.use_gap_wall {
                if self.left_to_right {
                    if should_line_ironing {
                        let dx = xr + 0.0 * self.pw - w.cur[0];
                        if dx.abs() < ironing_length { ironing_length = dx.abs(); }
                        let (cx, cy) = (w.x(), w.y());
                        w.extrude(cx + ironing_length, cy, wipe_speed);
                        w.retract(retract_length, retract_speed);
                        let (cx, cy) = (w.x(), w.y());
                        w.travel(cx - 1.5 * ironing_length, cy, 600.0);
                        if should_flat_ironing {
                            let (cx, cy) = (w.x(), w.y());
                            w.travel(cx + 0.5 * ironing_length, cy, 240.0);
                            let pos = [w.x() + 1.0 * ironing_length, w.y()];
                            let c = w.cur; w.spiral_flat_ironing(c, ironing_flat_area, self.pw, FLAT_IRON_SPEED);
                            w.travel_v(pos, wipe_speed);
                        } else {
                            let (cx, cy) = (w.x(), w.y());
                            w.travel(cx + 1.5 * ironing_length, cy, 240.0);
                        }
                        w.retract(-retract_length, retract_speed);
                    }
                    m104(w, self);
                    let cy = w.y(); w.extrude(xr + 0.0 * self.pw, cy, wipe_speed);
                } else {
                    if should_line_ironing {
                        let dx = xl - 0.0 * self.pw - w.cur[0];
                        if dx.abs() < ironing_length { ironing_length = dx.abs(); }
                        let (cx, cy) = (w.x(), w.y());
                        w.extrude(cx - ironing_length, cy, wipe_speed);
                        w.retract(retract_length, retract_speed);
                        let (cx, cy) = (w.x(), w.y());
                        w.travel(cx + 1.5 * ironing_length, cy, 600.0);
                        if should_flat_ironing {
                            let (cx, cy) = (w.x(), w.y());
                            w.travel(cx - 0.5 * ironing_length, cy, 240.0);
                            let pos = [w.x() - 1.0 * ironing_length, w.y()];
                            let c = w.cur; w.spiral_flat_ironing(c, ironing_flat_area, self.pw, FLAT_IRON_SPEED);
                            w.travel_v(pos, wipe_speed);
                        } else {
                            let (cx, cy) = (w.x(), w.y());
                            w.travel(cx - 1.5 * ironing_length, cy, 240.0);
                        }
                        w.retract(-retract_length, retract_speed);
                    }
                    m104(w, self);
                    let cy = w.y(); w.extrude(xl - 0.0 * self.pw, cy, wipe_speed);
                }
            } else {
                if i == 0 { m104(w, self); }
                let cy = w.y();
                if self.left_to_right { w.extrude(xr, cy, wipe_speed); } else { w.extrude(xl, cy, wipe_speed); }
            }
            if need_change_flow {
                w.flow = self.flow;
                w.append(&format!("; LAYER_HEIGHT: {:.6}\n", self.layer_h));
            }
            if !is_from_up && w.y() + dy - EPSILON > cb[3][1] - self.pw { break; }
            if is_from_up && w.y() - dy + EPSILON < cb[0][1] { break; }
            x_to_wipe -= xr - xl;
            if x_to_wipe < WT_EPSILON { break; }
            let cx = w.x(); let cy = w.y();
            if is_from_up { w.extrude(cx, cy - dy, 0.0); } else { w.extrude(cx, cy + dy, 0.0); }
            self.left_to_right = !self.left_to_right;
            i += 1;
        }
        let (cx, cy) = (w.x(), w.y());
        w.add_wipe_point([cx, cy]);
        w.add_wipe_point([if !self.left_to_right { self.width } else { 0.0 }, cy]);
        if let Some(l) = self.plan.get(self.layer_idx) {
            if let Some(last) = l.tool_changes.last() { if self.current_tool != last.new_tool { self.left_to_right = !self.left_to_right; } }
        }
        w.flow = self.flow;
        if first { let _ = write!(w.gcode, "; LINE_WIDTH: {:.6}\n", self.pw); }
    }

    fn tool_change_new(&mut self, new_tool: usize, solid_toolchange: bool) -> Tcr {
        let old_tool = self.current_tool;
        let (mut wipe_length, mut wipe_depth, mut purge_volume) = (0.0, 0.0, 0.0);
        for t in &self.plan[self.layer_idx].tool_changes {
            if t.new_tool == new_tool { wipe_length = t.wipe_length; wipe_depth = t.required_depth; purge_volume = t.purge_volume; break; }
        }
        self.current_tool = new_tool;
        let Some(bi) = self.block_index(self.cfg.fil[new_tool].category) else { return Tcr::default() };
        self.cur_block = Some(bi);
        let cur_depth = self.blocks[bi].cur_depth;
        let cb = Self::make_box(self.pw, cur_depth, self.width - 2.0 * self.pw, wipe_depth);
        let h = self.layer_h;
        let mut w = self.new_writer(h);
        w.tool = new_tool;
        let ys = self.y_shift; w.set_y_shift(ys);
        w.append(";--------------------\n; CP TOOLCHANGE START\n").comment_with_value(" toolchange #", self.num_tool_changes as i64 + 1);
        let _ = write!(w.gcode, "; material : {} -> {}\n;--------------------\n", self.cfg.fil[old_tool].material, self.cfg.fil[new_tool].material);
        w.append("M220 B\nM220 S100\n");
        let init = self.get_next_pos(&cb, wipe_length, solid_toolchange, new_tool);
        let (wtw, wtd) = (self.width, self.depth);
        w.set_initial_position(init, wtw, wtd);
        w.append(";WIPE_TOWER_START\n");
        // toolchange_Unload / Change / Load: the custom G-code goes in at the placeholders (filament end, change, start)
        w.append("[filament_end_gcode]\n[change_filament_gcode]\n");
        w.tool = new_tool;
        w.append("[filament_start_gcode]\n");
        w.flush_planner_queue();
        self.toolchange_wipe_new(&mut w, &cb, wipe_length, solid_toolchange);
        w.append(";WIPE_TOWER_END\n");
        self.num_tool_changes += 1;
        self.blocks[bi].cur_depth += wipe_depth;
        self.blocks[bi].last_filament_change_id = new_tool as i32;
        w.append("M220 R\n");
        let tf = self.cfg.travel_speed * 60.0;
        w.feedrate(tf).flush_planner_queue().reset_extruder().append("; CP TOOLCHANGE END\n;------------------\n\n\n");
        self.used_len[self.current_tool] += std::mem::take(&mut w.used_len);
        self.construct_tcr(w, old_tool, false, true, purge_volume, solid_toolchange)
    }

    fn merge_tcr(&self, first: &Tcr, second: &Tcr) -> Tcr {
        let mut out = first.clone();
        if v2norm(v2sub(first.end_pos, second.start_pos)) > EPSILON {
            let travel = format!("G1 X{} Y{} F{:.6}\n", r3(second.start_pos[0]), r3(second.start_pos[1]), self.cfg.max_speed);
            let mut need = true;
            if second.is_tool_change && (second.start_pos[0] - second.tool_change_start_pos[0]).abs() < EPSILON && (second.start_pos[1] - second.tool_change_start_pos[1]).abs() < EPSILON { need = false; }
            if need { out.gcode.push_str(&travel); }
        }
        out.gcode.push_str(&second.gcode);
        out.end_pos = second.end_pos;
        out.wipe_path = second.wipe_path.clone();
        out.initial_tool = first.initial_tool;
        out.new_tool = second.new_tool;
        out.is_contact = first.is_contact || second.is_contact;
        if first.is_tool_change { out.is_tool_change = true; out.tool_change_start_pos = first.tool_change_start_pos; }
        else if second.is_tool_change { out.is_tool_change = true; out.tool_change_start_pos = second.tool_change_start_pos; }
        else { out.is_tool_change = false; }
        out.purge_volume += second.purge_volume;
        out
    }

    fn get_wall_filament_for_all_layer(&self) -> i32 {
        let mut category_counts: BTreeMap<i32, i32> = BTreeMap::new();
        let mut filament_counts: BTreeMap<usize, i32> = BTreeMap::new();
        let mut current_tool = self.current_tool;
        for layer in &self.plan {
            if layer.tool_changes.is_empty() {
                *filament_counts.entry(current_tool).or_insert(0) += 1;
                *category_counts.entry(self.category(current_tool)).or_insert(0) += 1;
                continue;
            }
            let mut used_tools: Vec<usize> = Vec::new();
            let mut used_cat: Vec<i32> = Vec::new();
            for (i, t) in layer.tool_changes.iter().enumerate() {
                if i == 0 {
                    *filament_counts.entry(t.old_tool).or_insert(0) += 1;
                    *category_counts.entry(self.category(t.old_tool)).or_insert(0) += 1;
                    used_tools.push(t.old_tool);
                    used_cat.push(self.category(t.old_tool));
                }
                if !used_cat.contains(&self.category(t.new_tool)) { *category_counts.entry(self.category(t.new_tool)).or_insert(0) += 1; }
                if !used_tools.contains(&t.new_tool) { *filament_counts.entry(t.new_tool).or_insert(0) += 1; }
                used_tools.push(t.new_tool);
                used_cat.push(self.category(t.new_tool));
            }
            current_tool = layer.tool_changes.last().map(|t| t.new_tool).unwrap_or(current_tool);
        }
        let mut sel_cat = -1; let mut sel_count = 0;
        for (c, n) in &category_counts { if *n > sel_count { sel_cat = *c; sel_count = *n; } }
        let mut fid = -1i32; let mut fcount = 0;
        for (f, n) in &filament_counts { if self.category(*f) == sel_cat && *n > fcount { fid = *f as i32; fcount = *n; } }
        fid
    }

    /// `WipeTower::generate_new`
    pub fn generate(&mut self) -> TowerOutput {
        let mut out = TowerOutput::default();
        if self.plan.is_empty() { return out; }
        self.height = self.plan.last().unwrap().z;
        self.plan_tower_new();
        self.layer_idx = 0;
        for l in &self.plan { if !l.tool_changes.is_empty() { self.current_tool = l.tool_changes[0].old_tool; break; } }
        for u in self.used_len.iter_mut() { *u = 0.0; }
        let wall_filament = self.get_wall_filament_for_all_layer();
        let plan = self.plan.clone();
        let last_z = plan.last().unwrap().z;
        let mut index = 0usize;
        for layer in &plan {
            for b in self.blocks.iter_mut() { b.cur_depth = b.start_depth; b.last_filament_change_id = -1; }
            self.cur_layer_id = index; index += 1;
            self.set_layer(layer.z, layer.height, false);
            let _ = last_z;
            if self.plan[self.layer_idx].depth < self.pw { continue; }
            if self.blocks.len() == 1 && self.plan[self.layer_idx].depth < self.depth - self.pw {
                let dy = self.extra_spacing * self.pw;
                self.y_shift = (self.depth - self.plan[self.layer_idx].depth) / 2.0;
                self.y_shift = align_round(self.y_shift, dy);
            }
            let mut layer_result: Vec<Tcr> = Vec::new();
            let mut finish_layer_tcr = Tcr::default();
            let wall_idx: i32 = {
                if layer.tool_changes.is_empty() { -1 } else {
                    let mut cand = -1i32;
                    let mut ret: Option<i32> = None;
                    for (idx, t) in layer.tool_changes.iter().enumerate() {
                        if idx == 0 {
                            if t.old_tool as i32 == wall_filament { ret = Some(wall_filament); break; }
                            else if wall_filament >= 0 && self.category(t.old_tool) == self.category(wall_filament as usize) { cand = t.old_tool as i32; }
                        }
                        if t.new_tool as i32 == wall_filament { ret = Some(wall_filament); break; }
                        if cand == -1 && wall_filament >= 0 && self.category(t.new_tool) == self.category(wall_filament as usize) { cand = t.new_tool as i32; }
                    }
                    ret.unwrap_or(if cand == -1 { layer.tool_changes[0].new_tool as i32 } else { cand })
                }
            };
            let mut wall_idx = wall_idx;
            if wall_idx == -1 {
                let mut need_solid = false;
                for b in &self.blocks { if b.lt(self.cur_layer_id) != LayerType::Normal { need_solid = true; break; } }
                if need_solid { wall_idx = self.current_tool as i32; } else {
                    finish_layer_tcr = self.finish_layer_new(true, layer.extruder_fill, true);
                    let cl = self.cur_layer_id;
                    for b in self.blocks.iter_mut() { b.finish_depth[cl] = b.start_depth; }
                }
            }
            let mut insert_finish_layer_idx: i32 = -1;
            for i in 0..layer.tool_changes.len() {
                let t = layer.tool_changes[i].clone();
                if i == 0 && t.old_tool as i32 == wall_idx { finish_layer_tcr = self.finish_layer_new(true, false, false); }
                let mut solid_toolchange = false;
                if let Some(bi) = self.block_index(self.cfg.fil[t.new_tool].category) { solid_toolchange = self.blocks[bi].lt(self.cur_layer_id) == LayerType::Contact; }
                layer_result.push(self.tool_change_new(t.new_tool, solid_toolchange));
                if i == 0 && t.old_tool as i32 == wall_idx {
                } else if t.new_tool as i32 == wall_idx {
                    finish_layer_tcr = self.finish_layer_new(true, false, false);
                    insert_finish_layer_idx = i as i32;
                }
            }
            if wall_idx != -1 {
                if layer.tool_changes.is_empty() { finish_layer_tcr = self.finish_layer_new(true, false, false); }
                for bi in 0..self.blocks.len() {
                    let cl = self.cur_layer_id;
                    {
                        let b = &mut self.blocks[bi];
                        b.finish_depth[cl] = b.start_depth + b.depth;
                        if b.cur_depth + EPSILON >= b.start_depth + b.layer_depths[cl] - self.pw { continue; }
                    }
                    let block = self.blocks[bi].clone();
                    let block_solid = matches!(block.lt(cl), LayerType::Contact | LayerType::ContactUp | LayerType::Solid);
                    let mut finish_layer_filament: i32 = -1;
                    if block.last_filament_change_id != -1 { finish_layer_filament = block.last_filament_change_id; }
                    if !layer.tool_changes.is_empty() {
                        if let Some(lb) = self.block_index(self.category(layer.tool_changes[0].old_tool)) {
                            if self.blocks[lb].block_id == block.block_id && finish_layer_filament == -1 { finish_layer_filament = layer.tool_changes[0].old_tool as i32; }
                        }
                    }
                    if finish_layer_filament == -1 { finish_layer_filament = wall_idx; }
                    let fl = finish_layer_filament as usize;
                    let finish_block_tcr = if block_solid {
                        let t = self.finish_block_solid(bi, fl, layer.extruder_fill, block.lt(cl));
                        let b = &mut self.blocks[bi]; b.finish_depth[cl] = b.start_depth + b.depth;
                        t
                    } else {
                        let t = self.finish_block(bi, fl, layer.extruder_fill);
                        let b = &mut self.blocks[bi]; b.finish_depth[cl] = b.cur_depth;
                        t
                    };
                    let mut has_inserted = false;
                    if let Some(p) = layer_result.iter().position(|r| r.new_tool == finish_layer_filament) {
                        let m = self.merge_tcr(&layer_result[p], &finish_block_tcr);
                        layer_result[p] = m;
                        has_inserted = true;
                    }
                    if block.last_filament_change_id == -1 && !has_inserted {
                        if let Some(p) = layer_result.iter().position(|r| r.initial_tool == finish_layer_filament) {
                            let m = self.merge_tcr(&finish_block_tcr, &layer_result[p]);
                            layer_result[p] = m;
                            has_inserted = true;
                        }
                    }
                    if !has_inserted && !finish_block_tcr.gcode.is_empty() {
                        finish_layer_tcr = self.merge_tcr(&finish_layer_tcr, &finish_block_tcr);
                    }
                }
            }
            if layer_result.is_empty() {
                layer_result.push(finish_layer_tcr);
            } else if !finish_layer_tcr.gcode.is_empty() && finish_layer_tcr.gcode.contains("G1") {
                if insert_finish_layer_idx == -1 {
                    let m = self.merge_tcr(&finish_layer_tcr, &layer_result[0]);
                    layer_result[0] = m;
                } else {
                    let k = insert_finish_layer_idx as usize;
                    let m = self.merge_tcr(&layer_result[k], &finish_layer_tcr);
                    layer_result[k] = m;
                }
            }
            out.layers.push(layer_result);
            out.layer_z.push(layer.z);
        }
        out.depth = self.depth;
        out.width = self.width;
        out.height = self.height;
        out.brim_width = self.brim_width_real;
        out.rib_offset = self.rib_offset;
        out.used_filament = self.used_len.clone();
        out.number_of_toolchanges = self.num_tool_changes as usize;
        out.notes = self.notes.clone();
        // bbx (tower local): [0,width] x [0,depth], widened by the rib and brim; Orca derives it from the wall outline of layer 0
        out.bbx = [[-self.rib_offset[0], -self.rib_offset[1]], [self.width + self.rib_offset[0], self.depth + self.rib_offset[1]]];
        out
    }
}

/// `is_valid_gcode` in Orca checks for a G1; `finish_layer_tcr.gcode` is non-empty whenever a wall was written.
#[allow(dead_code)]
fn _doc() {}

// ---------------------------------------------------------------------------------------------------------------
// bed coordinates: `WipeTowerIntegration::post_process_wipe_tower_moves`
// ---------------------------------------------------------------------------------------------------------------

/// Rewrite the X/Y of every `G1`/`G2`/`G3` line of tower-local `gcode` into bed coordinates (`translation` = tower position + rib
/// offset), emitting X/Y only when they changed, with Orca's spacing. `start_pos` is the tcr's start position.
pub fn post_process(gcode: &str, start_pos: V2, translation: V2) -> String {
    let mut out = String::with_capacity(gcode.len() + gcode.len() / 8);
    let mut pos = start_pos;
    let mut old_pos: V2 = [-1000.1, -1000.1];
    let n_lines = gcode.matches('\n').count();
    for (li, raw) in gcode.split('\n').enumerate() {
        if li == n_lines && raw.is_empty() { break; }
        let mut line = raw.to_string();
        let is_move = line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 ");
        if is_move {
            let head = line[..2].to_string();
            let mut rest: Vec<&str> = Vec::new();
            for tok in line[3..].split(' ') {
                if tok.is_empty() { continue; }
                let c = tok.as_bytes()[0] as char;
                if (c == 'X' || c == 'Y') && tok.len() > 1 {
                    let v: f32 = tok[1..].parse().unwrap_or(0.0);
                    if c == 'X' { pos[0] = v; } else { pos[1] = v; }
                } else { rest.push(tok); }
            }
            let tp = [pos[0] + translation[0], pos[1] + translation[1]];
            if tp != old_pos {
                let mut s = format!("{} ", head);
                if tp[0] != old_pos[0] { let _ = write!(s, " X{}", r3(tp[0])); }
                if tp[1] != old_pos[1] { let _ = write!(s, " Y{}", r3(tp[1])); }
                s.push_str(if head == "G1" { "  " } else { "   " });
                s.push_str(&rest.join(" "));
                line = s;
                old_pos = tp;
            } else {
                line = format!("{} {}", head, rest.join(" "));
            }
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// One print layer as the tower sees it: top z, height and the filaments used on it IN PRINT ORDER.
#[derive(Clone, Debug)]
pub struct TowerLayer { pub z: f32, pub h: f32, pub order: Vec<usize> }

/// `Print::_make_wipe_tower`'s planning loop + `generate_new`: the tower for a list of layers whose filament order is known.
pub fn build_tower(cfg: WipeTowerCfg, layers: &[TowerLayer], first_tool: usize, bed_min: V2, bed_max: V2) -> (TowerOutput, WipeTower) {
    let flush = cfg.flush_raw.clone();
    let prime = cfg.prime_volume.clone();
    let grab = cfg.grab_length * 2.4;
    let mut wt = WipeTower::new(cfg, first_tool, bed_min, bed_max);
    let mut current = first_tool;
    for l in layers {
        wt.plan_toolchange(l.z, l.h, current, current, 0.0, 0.0);
        for &f in &l.order {
            if f == current { continue; }
            let mut purge = flush[current][f];
            purge = (purge - grab).max(0.0);
            wt.plan_toolchange(l.z, l.h, current, f, prime[f], purge);
            current = f;
        }
    }
    let out = wt.generate();
    (out, wt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ref_text(name: &str) -> Option<String> {
        let dir = std::env::var("FDM_M4B_REF").unwrap_or_else(|_| "/tmp/fdm-m4b/ref".into());
        std::fs::read_to_string(format!("{}/{}/plate_1.gcode", dir, name)).ok()
    }

    fn stats(g: &str) -> (f64, f64, [f64; 4]) {
        let (mut len, mut e, mut bb) = (0.0f64, 0.0f64, [1e9f64, 1e9, -1e9, -1e9]);
        let (mut x, mut y) = (0.0f64, 0.0f64);
        let mut last_e = 0.0f64;
        for l in g.lines() {
            let body = l.split(';').next().unwrap_or("");
            if !(body.starts_with("G1 ") || body.starts_with("G3 ") || body.starts_with("G2 ")) { if body.starts_with("G92") { last_e = 0.0; } continue; }
            let (mut nx, mut ny, mut ev) = (x, y, None);
            for t in body.split_whitespace().skip(1) {
                let v: f64 = t[1..].parse().unwrap_or(0.0);
                match &t[..1] { "X" => nx = v, "Y" => ny = v, "E" => ev = Some(v), _ => {} }
            }
            let de = ev.unwrap_or(0.0);
            if de > 0.0 {
                len += ((nx - x).powi(2) + (ny - y).powi(2)).sqrt();
                e += de;
                for (px, py) in [(x, y), (nx, ny)] { bb[0] = bb[0].min(px); bb[1] = bb[1].min(py); bb[2] = bb[2].max(px); bb[3] = bb[3].max(py); }
            }
            let _ = &mut last_e;
            x = nx; y = ny;
        }
        (len, e, bb)
    }

    #[test]
    fn tower_vs_orca_two_pla() {
        let Some(txt) = ref_text("v1") else { eprintln!("PENDING: no reference /tmp/fdm-m4b/ref/v1"); return; };
        let s = Settings::from_config_block(&txt);
        let cfg = WipeTowerCfg::from_settings(&s, 2).unwrap();
        let layers: Vec<TowerLayer> = (0..100).map(|i| TowerLayer { z: 0.2 * (i + 1) as f32, h: 0.2, order: if i % 2 == 0 { vec![0, 1] } else { vec![1, 0] } }).collect();
        let (out, _wt) = build_tower(cfg.clone(), &layers, 0, [0.0, 0.0], [256.0, 256.0]);
        eprintln!("tower width {} depth {} rib_offset {:?} brim {} layers {} toolchanges {}", out.width, out.depth, out.rib_offset, out.brim_width, out.layers.len(), out.number_of_toolchanges);
        let mut all = String::new();
        let tr = [cfg.pos[0] + out.rib_offset[0], cfg.pos[1] + out.rib_offset[1]];
        for l in &out.layers { all.push_str("; CHANGE_LAYER\n"); for t in l { all.push_str(&post_process(&t.gcode, t.start_pos, tr)); } }
        let (len, e, bb) = stats(&all);
        eprintln!("OURS tower path {:.1} e {:.1} bbox {:?}", len, e, bb);
        let (rl, re, rb) = stats(&txt.lines().filter(|_| true).collect::<Vec<_>>().join("\n"));
        let _ = (rl, re, rb);
        std::fs::write("/tmp/fdm-m4b/tower_v1.gcode", &all).ok();
    }
}
