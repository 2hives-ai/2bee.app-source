//! quality -- the PROOF MACHINERY for "ours is better than OrcaSlicer".
//!
//! Founder rule (2026-10-14): *OrcaSlicer output is a reference; if we have a better outcome use it. Always check, prove.*
//! The reading of that rule enforced here: **a deviation from Orca is a FAIL until proven BETTER.** "Better" is
//! accepted only when ALL of:
//!  (a) the metric is DECLARED in `DEFS` (unit, direction, tolerance, risk flag) before it is measured;
//!  (b) ours beats Orca on it by more than max(measured noise floor of both files, declared tolerance);
//!  (c) no other declared metric is WORSE (beyond the same threshold);
//!  (d) same model and same settings: mesh height matches, layer stack matches, and the CONFIG_BLOCK keys
//!      that define "same settings" are equal (`SAME_SETTINGS`) -- or the check is reported UNVERIFIED and
//!      nothing is accepted;
//!  (e) a NEGATIVE CONTROL exists and fired: a planted degradation of Orca's own file moved THIS metric to WORSE
//!      on this model (`controls`), and an unchanged file / a 1-um shift stayed SAME on every metric;
//!  (f) a physical-risk metric never trades off silently: a WORSE on any `risk` metric is a FAIL however many
//!      other metrics improved ("faster but over the flow limit" is FAIL, not "better time").
//! Anything not proven stays FAIL. "Looks nicer" is not evidence; a metric nobody declared is not evidence.
//!
//! Std + serde_json only (no new dependencies). Reads `parity`/`gcode_parse` nowhere: it is an independent
//! instrument by design (see `parse`).
pub mod analyze;
pub mod parse;
pub mod plants;

use crate::config::Config;
use crate::mesh::Mesh;
use crate::types::FdmError;
use std::collections::{BTreeMap, BTreeSet};

pub use analyze::Opt;

#[derive(Clone, Copy, Debug)]
pub struct MVal { pub v: Option<f64>, pub n: usize }
pub type Metrics = BTreeMap<&'static str, MVal>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir { Lower, Higher, /// deviation either way is a regression; can never be "better"
    Match }
impl Dir { pub fn label(self) -> &'static str { match self { Dir::Lower => "lower", Dir::Higher => "higher", Dir::Match => "match" } } }

/// A metric declaration. The thresholds below were written BEFORE the first measurement was taken
/// (2026-10-14, quality lane); any later change is a logged change in `DIVERGENCES.md` "ledger of definition changes".
#[derive(Clone, Copy, Debug)]
pub struct Def {
    pub key: &'static str,
    pub group: &'static str,
    pub unit: &'static str,
    pub dir: Dir,
    /// physical-risk metric: a regression here is a FAIL that no improvement elsewhere can buy back
    pub risk: bool,
    pub abs_tol: f64,
    pub rel_tol: f64,
    pub what: &'static str,
}
macro_rules! d { ($k:expr,$g:expr,$u:expr,$dir:expr,$risk:expr,$abs:expr,$rel:expr,$w:expr) => { Def { key: $k, group: $g, unit: $u, dir: $dir, risk: $risk, abs_tol: $abs, rel_tol: $rel, what: $w } } }
use Dir::*;
pub const DEFS: &[Def] = &[
    d!("dim_err_mean_mm", "fidelity", "mm", Lower, false, 0.005, 0.0, "mean |distance(outer-wall centreline, sliced contour) - width/2|"),
    d!("dim_err_p95_mm", "fidelity", "mm", Lower, false, 0.010, 0.0, "95th percentile of the same error"),
    d!("dim_err_max_mm", "fidelity", "mm", Lower, false, 0.030, 0.0, "worst sample of the same error"),
    d!("outside_region_pct", "coverage", "%", Lower, true, 0.05, 0.0, "extruded area beyond the sliced contour (+0.05 mm), % of extruded area"),
    d!("solid_underfill_pct", "coverage", "%", Lower, true, 0.25, 0.0, "uncovered share of the must-be-solid zone (top/bottom shell depth, first layer)"),
    d!("solid_gap_count", "coverage", "count", Lower, true, 2.0, 0.05, "connected uncovered patches (>= 4 cells) in the must-be-solid zone"),
    d!("solid_gap_area_mm2", "coverage", "mm2", Lower, true, 0.05, 0.05, "total area of those patches"),
    d!("wall_underfill_pct", "coverage", "%", Lower, true, 0.25, 0.0, "uncovered share of the outer wall band (wall_loops wide)"),
    d!("overfill_pct", "coverage", "%", Lower, true, 0.5, 0.0, "bead overlap: sum(max(0,coverage-1)) / covered area (footprint = deposited volume / layer height)"),
    d!("first_layer_coverage_pct", "coverage", "%", Higher, true, 0.25, 0.0, "covered share of the first-layer region"),
    d!("seam_visibility", "seam", "0..1", Lower, false, 0.05, 0.0, "mean seam score: concave corner 0, smooth wall 0.5, convex corner 1"),
    d!("seam_scatter_mm", "seam", "mm", Lower, false, 0.10, 0.0, "mean distance from a seam to the nearest seam of the layer below"),
    d!("travel_mm", "motion", "mm", Lower, false, 1.0, 0.02, "non-extruding XY motion inside layers (wipes included)"),
    d!("retract_count", "motion", "count", Lower, false, 1.0, 0.02, "retractions (debt accounting)"),
    d!("zhop_count", "motion", "count", Lower, false, 1.0, 0.02, "z lifts above the layer's Z"),
    d!("print_time_s", "time", "s", Lower, false, 5.0, 0.015, "estimated print time, inside layers, ONE estimator for both files"),
    d!("layer_time_deficit_s", "time", "s", Lower, true, 1.0, 0.02, "sum over layers of max(0, slow_down_layer_time - layer time)"),
    d!("min_layer_time_violations", "time", "count", Lower, true, 1.0, 0.0, "layers shorter than slow_down_layer_time"),
    d!("flow_violation_count", "limits", "count", Lower, true, 0.0, 0.0, "extrusions (>= 0.3 mm) above 1.03 x filament_max_volumetric_speed"),
    d!("flow_peak_ratio", "limits", "x", Lower, true, 0.01, 0.0, "peak commanded volumetric flow / limit, over extrusions >= 2 mm (shorter ones never reach their feed)"),
    d!("accel_violation_count", "limits", "count", Lower, true, 0.0, 0.0, "extrusions under M204 above machine_max_acceleration_extruding"),
    d!("accel_peak_ratio", "limits", "x", Lower, true, 0.01, 0.0, "peak acceleration in force / limit"),
    d!("jerk_ratio_p95", "limits", "x", Lower, true, 0.05, 0.0, "p95 over extrusion junctions of |v_out - v_in| (commanded) / machine_max_jerk"),
    d!("jerk_violation_count", "limits", "count", Lower, true, 0.0, 0.02, "extrusion junctions with that ratio > 1 (firmware junction handling is NOT modelled)"),
    d!("bridge_span_max_mm", "bridge", "mm", Lower, true, 0.5, 0.0, "longest single bridge extrusion"),
    d!("bridge_speed_dev_pct", "bridge", "%", Lower, true, 2.0, 0.0, "worst deviation of bridge feed from bridge_speed"),
    d!("bridge_fan_shortfall_pct", "bridge", "%", Lower, true, 1.0, 0.0, "bridge length printed with part fan below overhang_fan_speed"),
    d!("filament_mm", "material", "mm", Match, false, 0.0, 0.01, "net filament extruded; MATCH: less material is not 'better' unless a strength metric is declared"),
    d!("width_flow_err_pct", "material", "%", Lower, false, 0.5, 0.0, "|width implied by E - annotated LINE_WIDTH| / width, length-weighted"),
];

/// CONFIG_BLOCK keys that define "same settings". Equal in both files, or the comparison is UNVERIFIED.
pub const SAME_SETTINGS: &[&str] = &["layer_height", "initial_layer_print_height", "nozzle_diameter", "line_width", "outer_wall_line_width",
    "inner_wall_line_width", "wall_loops", "sparse_infill_density", "sparse_infill_pattern", "top_shell_layers", "bottom_shell_layers",
    "top_shell_thickness", "bottom_shell_thickness", "filament_diameter", "filament_flow_ratio", "filament_max_volumetric_speed",
    "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "bridge_speed", "slow_down_layer_time", "seam_position",
    "machine_max_acceleration_extruding", "machine_max_jerk_x", "overhang_fan_speed", "enable_support", "brim_type", "skirt_loops"];

/// Limits and zone parameters, always taken from the REFERENCE (Orca) file's CONFIG_BLOCK and applied to both files.
#[derive(Clone, Debug)]
pub struct Lim {
    pub flow_max: f64, pub acc_max: f64, pub jerk: f64, pub min_layer_time: f64, pub bridge_speed: f64,
    pub overhang_fan_pct: f64, pub top_layers: usize, pub top_thickness: f64, pub bottom_layers: usize,
    pub bottom_thickness: f64, pub wall_loops: usize, pub outer_w: f64, pub inner_w: f64,
}
impl Lim {
    pub fn from_cfg(c: &Config) -> Result<Lim, FdmError> {
        let nozzle = c.f64("nozzle_diameter").unwrap_or(0.4);
        let fp = |k: &str| c.float_or_percent(k).map(|v| v.resolve(nozzle));
        let need = |r: Result<f64, FdmError>, k: &str| r.map_err(|_| FdmError::Unsupported(format!("reference CONFIG_BLOCK lacks a usable '{k}'")));
        let list0 = |k: &str| c.f64_list(k).ok().and_then(|v| v.first().copied());
        Ok(Lim {
            flow_max: need(c.f64("filament_max_volumetric_speed"), "filament_max_volumetric_speed")?,
            acc_max: list0("machine_max_acceleration_extruding").ok_or_else(|| FdmError::Unsupported("reference lacks machine_max_acceleration_extruding".into()))?,
            jerk: list0("machine_max_jerk_x").ok_or_else(|| FdmError::Unsupported("reference lacks machine_max_jerk_x".into()))?,
            min_layer_time: need(c.f64("slow_down_layer_time"), "slow_down_layer_time")?,
            bridge_speed: need(c.f64("bridge_speed"), "bridge_speed")?,
            overhang_fan_pct: c.f64("overhang_fan_speed").unwrap_or(100.0),
            top_layers: need(c.f64("top_shell_layers"), "top_shell_layers")? as usize,
            top_thickness: c.f64("top_shell_thickness").unwrap_or(0.0),
            bottom_layers: need(c.f64("bottom_shell_layers"), "bottom_shell_layers")? as usize,
            bottom_thickness: c.f64("bottom_shell_thickness").unwrap_or(0.0),
            wall_loops: need(c.f64("wall_loops"), "wall_loops")? as usize,
            outer_w: need(fp("outer_wall_line_width"), "outer_wall_line_width")?,
            inner_w: need(fp("inner_wall_line_width"), "inner_wall_line_width")?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Analysis {
    pub metrics: Metrics,
    /// measured noise floor per metric: max |perturbed - reference| over `noise_runs` perturbed re-analyses
    pub noise: BTreeMap<&'static str, f64>,
    pub offset: [f64; 2],
    pub align_err_mm: f64,
    pub layers: usize,
    pub cfg: Option<Config>,
    pub header_time_s: Option<f64>,
    pub warnings: Vec<String>,
    /// where the numbers come from (diagnostic only)
    pub notes: BTreeMap<&'static str, String>,
}

pub const ALIGN_MAX_MM: f64 = 0.25;

/// Analyse one G-code against the mesh. `lim` comes from the reference file.
pub fn analyze_prepared(prep: &analyze::Prepared, opt: &Opt) -> Analysis {
    let base = analyze::metrics(prep, opt, 0);
    let mut noise: BTreeMap<&'static str, f64> = BTreeMap::new();
    for k in 1..=opt.noise_runs {
        let m = analyze::metrics(prep, opt, 0xA11CE ^ (k as u64 * 7919));
        for (key, v) in &m {
            if let (Some(a), Some(b)) = (base.get(key).and_then(|x| x.v), v.v) {
                let e = noise.entry(*key).or_insert(0.0);
                *e = e.max((a - b).abs());
            }
        }
    }
    Analysis { metrics: base, noise, offset: prep.offset, align_err_mm: analyze::alignment_error(prep).unwrap_or(f64::NAN),
        layers: prep.parsed.layers.len(), cfg: prep.parsed.cfg.clone(), header_time_s: prep.parsed.header_model_time_s, warnings: prep.parsed.warnings.clone(), notes: if opt.noise_runs > 0 { analyze::notes(prep, opt) } else { BTreeMap::new() } }
}

pub fn analyze_text(text: &str, mesh: &Mesh, lim: &Lim, opt: &Opt) -> Result<(analyze::Prepared, Analysis), FdmError> {
    let parsed = parse::parse(text)?;
    let prep = analyze::prepare(parsed, mesh, lim.clone(), opt)?;
    let a = analyze_prepared(&prep, opt);
    if !(a.align_err_mm <= ALIGN_MAX_MM) {
        return Err(FdmError::Unsupported(format!("mesh does not line up with this G-code (mean outer-wall error {:.3} mm > {ALIGN_MAX_MM}): wrong mesh or unplaced model; pass --offset x,y if the automatic alignment is wrong", a.align_err_mm)));
    }
    Ok((prep, a))
}

// ------------------------------------------------------------------------------------ verdicts
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum V { Better, Same, Worse, /// defined on one side only
    Incomparable, NotApplicable }
impl V { pub fn label(self) -> &'static str { match self { V::Better => "BETTER", V::Same => "SAME", V::Worse => "WORSE", V::Incomparable => "INCOMPARABLE", V::NotApplicable => "n/a" } } }

#[derive(Clone, Debug)]
pub struct Row {
    pub def: Def,
    pub orca: Option<f64>,
    pub ours: Option<f64>,
    pub noise: f64,
    pub thr: f64,
    pub verdict: V,
    pub n_orca: usize,
    pub n_ours: usize,
}

pub fn judge(def: &Def, o: &MVal, u: &MVal, noise: f64) -> Row {
    let (ov, uv) = (o.v, u.v);
    let mut row = Row { def: *def, orca: ov, ours: uv, noise, thr: 0.0, verdict: V::NotApplicable, n_orca: o.n, n_ours: u.n };
    match (ov, uv) {
        (None, None) => row,
        (Some(_), None) | (None, Some(_)) => { row.verdict = V::Incomparable; row }
        (Some(a), Some(b)) => {
            row.thr = noise.max(def.abs_tol).max(def.rel_tol * a.abs().max(b.abs()));
            let d = b - a;
            row.verdict = if d.abs() <= row.thr { V::Same } else {
                match def.dir {
                    Dir::Lower => if d < 0.0 { V::Better } else { V::Worse },
                    Dir::Higher => if d > 0.0 { V::Better } else { V::Worse },
                    Dir::Match => V::Worse,
                }
            };
            row
        }
    }
}

pub fn compare(orca: &Analysis, ours: &Analysis) -> Vec<Row> {
    DEFS.iter().map(|d| {
        let na = MVal { v: None, n: 0 };
        let o = orca.metrics.get(d.key).copied().unwrap_or(na);
        let u = ours.metrics.get(d.key).copied().unwrap_or(na);
        let noise = orca.noise.get(d.key).copied().unwrap_or(0.0).max(ours.noise.get(d.key).copied().unwrap_or(0.0));
        judge(d, &o, &u, noise)
    }).collect()
}

#[derive(Clone, Debug, PartialEq)]
pub enum Settings { Verified(usize), Unverified(String), Mismatch(Vec<String>) }
pub fn check_settings(orca: &Analysis, ours: &Analysis) -> Settings {
    let (Some(a), Some(b)) = (&orca.cfg, &ours.cfg) else {
        return Settings::Unverified(if ours.cfg.is_none() { "ours carries no CONFIG_BLOCK".into() } else { "reference carries no CONFIG_BLOCK".into() });
    };
    let mut bad = vec![];
    let mut n = 0;
    for k in SAME_SETTINGS {
        match (a.raw_map().get(*k), b.raw_map().get(*k)) {
            (Some(x), Some(y)) => { n += 1; if x != y { bad.push(format!("{k}: orca={x} ours={y}")); } }
            (None, None) => {}
            (x, y) => bad.push(format!("{k}: orca={x:?} ours={y:?}")),
        }
    }
    if bad.is_empty() { Settings::Verified(n) } else { Settings::Mismatch(bad) }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Overall {
    /// every metric SAME: no divergence to justify
    Same,
    /// BETTER on >= 1 metric, WORSE on none, controls fired for each BETTER metric, settings verified
    ProvenBetter,
    /// BETTER somewhere but not all of (a)-(f) hold: stays FAIL
    Unproven(Vec<String>),
    /// WORSE (or INCOMPARABLE) on >= 1 metric
    Fail(Vec<String>),
}
impl Overall {
    pub fn exit_code(&self) -> i32 { match self { Overall::Same | Overall::ProvenBetter => 0, _ => 1 } }
    pub fn label(&self) -> &'static str { match self { Overall::Same => "PASS (SAME as Orca on every declared metric)", Overall::ProvenBetter => "PASS (PROVEN BETTER, no regression)", Overall::Unproven(_) => "FAIL (better claimed but NOT PROVEN)", Overall::Fail(_) => "FAIL" } }
}

/// The overall rule. `controlled` = metrics for which a planted degradation demonstrably moved them to WORSE on this model.
pub fn overall(rows: &[Row], settings: &Settings, controlled: &BTreeSet<&'static str>, controls_ok: bool) -> Overall {
    let mut fails = vec![];
    for r in rows {
        match r.verdict {
            V::Worse => fails.push(format!("{} WORSE{}", r.def.key, if r.def.risk { " (PHYSICAL-RISK metric)" } else { "" })),
            V::Incomparable => fails.push(format!("{} defined on one side only", r.def.key)),
            _ => {}
        }
    }
    if !fails.is_empty() { return Overall::Fail(fails); }
    let better: Vec<&Row> = rows.iter().filter(|r| r.verdict == V::Better).collect();
    if better.is_empty() { return Overall::Same; }
    let mut why = vec![];
    match settings {
        Settings::Verified(_) => {}
        Settings::Unverified(s) => why.push(format!("(d) settings UNVERIFIED: {s}")),
        Settings::Mismatch(m) => why.push(format!("(d) settings DIFFER: {}", m.join("; "))),
    }
    if !controls_ok { why.push("(e) the identity / 1-um-shift false-positive controls did not stay SAME on every metric".into()); }
    for r in &better {
        if !controlled.contains(r.def.key) { why.push(format!("(e) no negative control fired for '{}' on this model: BETTER cannot be trusted", r.def.key)); }
    }
    if why.is_empty() { Overall::ProvenBetter } else { Overall::Unproven(why) }
}

// ------------------------------------------------------------------------------------ controls
pub struct Plant {
    pub name: &'static str,
    pub desc: &'static str,
    pub apply: fn(&str) -> Result<String, FdmError>,
    /// metrics that MUST read WORSE after this plant (on a model where they apply)
    pub expects: &'static [&'static str],
}
pub const PLANTS: &[Plant] = &[
    Plant { name: "jitter_walls_0.12mm", desc: "outer-wall end points displaced +-0.12 mm", apply: |t| plants::jitter_walls(t, 0.12), expects: &["dim_err_mean_mm", "dim_err_p95_mm"] },
    Plant { name: "jitter_walls_0.8mm", desc: "outer-wall end points displaced +-0.8 mm (large enough to beat Orca's own worst sample)", apply: |t| plants::jitter_walls(t, 0.8), expects: &["dim_err_max_mm"] },
    Plant { name: "shift_outer_0.25mm", desc: "whole outer wall shifted +0.25 mm in X", apply: |t| plants::shift_outer(t, 0.25), expects: &["outside_region_pct", "dim_err_mean_mm"] },
    Plant { name: "drop_solid_infill", desc: "E removed from internal solid infill + top + bottom surface", apply: |t| plants::drop_features(t, &["Internal solid infill", "Top surface", "Bottom surface"]), expects: &["solid_underfill_pct", "solid_gap_area_mm2", "first_layer_coverage_pct", "filament_mm"] },
    Plant { name: "drop_inner_walls", desc: "E removed from inner walls", apply: |t| plants::drop_features(t, &["Inner wall"]), expects: &["wall_underfill_pct", "filament_mm"] },
    Plant { name: "drop_sparse_infill", desc: "E removed from sparse infill", apply: |t| plants::drop_features(t, &["Sparse infill"]), expects: &["filament_mm"] },
    Plant { name: "overextrude_x1.6", desc: "E x1.6 on inner wall + solid infill + top surface", apply: |t| plants::scale_e(t, &["Inner wall", "Internal solid infill", "Top surface"], 1.6), expects: &["overfill_pct", "width_flow_err_pct", "filament_mm"] },
    Plant { name: "extra_retractions", desc: "needless 0.8 mm retract/unretract around every travel", apply: |t| plants::extra_retractions(t, 0.8), expects: &["retract_count"] },
    Plant { name: "travel_detour_15mm", desc: "every travel detours 15 mm out", apply: |t| plants::travel_detour(t, 15.0), expects: &["travel_mm"] },
    Plant { name: "flow_over_x3", desc: "feed x3 on sparse + solid infill with E unchanged (flow above limit; time gets BETTER)", apply: |t| plants::scale_speed(t, &["Sparse infill", "Internal solid infill"], 3.0), expects: &["flow_violation_count", "flow_peak_ratio"] },
    Plant { name: "accel_over_x4", desc: "every M204 acceleration x4", apply: |t| plants::scale_accel(t, 4.0), expects: &["accel_violation_count", "accel_peak_ratio"] },
    Plant { name: "all_fast_x1.5", desc: "every feed x1.5 (cornering jerk up, nothing else touched)", apply: |t| plants::scale_speed(t, &[], 1.5), expects: &["jerk_ratio_p95"] },
    Plant { name: "all_slow_x0.5", desc: "every feed x0.5", apply: |t| plants::scale_speed(t, &[], 0.5), expects: &["print_time_s"] },
    Plant { name: "all_fast_x3", desc: "every feed x3 (layer time collapses; print time gets BETTER)", apply: |t| plants::scale_speed(t, &[], 3.0), expects: &["layer_time_deficit_s", "min_layer_time_violations", "jerk_violation_count"] },
    Plant { name: "solid_dropouts_1in6", desc: "every 6th solid/top/bottom line loses its E (many small voids)", apply: |t| plants::drop_nth(t, &["Internal solid infill", "Top surface", "Bottom surface"], 6), expects: &["solid_gap_count"] },
    Plant { name: "extra_zhops_0.6mm", desc: "needless 0.6 mm z lift around every travel", apply: |t| plants::add_zhops(t, 0.6), expects: &["zhop_count"] },
    Plant { name: "bridges_widened_10mm", desc: "bridge extrusions stretched 10 mm each side (longer unsupported spans)", apply: |t| plants::widen_bridges(t, 10.0), expects: &["bridge_span_max_mm"] },
    Plant { name: "seams_scattered", desc: "each closed outer-wall loop started at a pseudo-random vertex", apply: plants::scatter_seams, expects: &["seam_scatter_mm"] },
    Plant { name: "bridge_fast_x2", desc: "feed x2 on bridges", apply: |t| plants::scale_speed(t, &["Bridge"], 2.0), expects: &["bridge_speed_dev_pct"] },
    Plant { name: "bridge_no_fan", desc: "part fan off during bridges", apply: plants::bridge_no_fan, expects: &["bridge_fan_shortfall_pct"] },
];

#[derive(Clone, Debug)]
pub struct ControlRow {
    pub plant: &'static str,
    pub desc: &'static str,
    pub status: String,
    pub detail: Vec<(String, Option<f64>, Option<f64>, V)>,
    pub fired: Vec<&'static str>,
    pub missed: Vec<&'static str>,
    pub not_applicable: Vec<&'static str>,
    pub also_better: Vec<&'static str>,
}
#[derive(Clone, Debug, Default)]
pub struct ControlReport {
    pub rows: Vec<ControlRow>,
    /// metrics a plant demonstrably degraded on THIS model
    pub controlled: BTreeSet<&'static str>,
    /// metrics a plant was expected to degrade and did NOT (a defect in the instrument on this model)
    pub missed: BTreeSet<&'static str>,
    /// identity (unchanged copy) and 1-um shift stayed SAME on every metric
    pub false_positive_ok: bool,
    pub false_positive_detail: Vec<String>,
}

/// Run every negative control against the reference file. Each plant is applied to Orca's text, re-analysed on
/// the same mesh with the same limits and alignment, and compared with the unplanted reference.
pub fn run_controls(orca_text: &str, mesh: &Mesh, lim: &Lim, opt: &Opt, base: &Analysis, base_prep: &analyze::Prepared) -> ControlReport {
    let mut rep = ControlReport::default();
    let mut fast_opt = opt.clone();
    fast_opt.noise_runs = 0;
    fast_opt.offset = Some(base.offset);
    let _ = (mesh, lim);
    // false-positive controls: unchanged, and a one-micrometre shift of the whole file (a coordinate rounding step)
    let mut fp_ok = true;
    for (name, text) in [("identity (unchanged copy)", Ok(orca_text.to_string())), ("1-um shift of every X/Y", plants::tiny_shift(orca_text, 0.001))] {
        match text.and_then(|t| parse::parse(&t)).map(|p| swap_parsed(base_prep, p)) {
            Ok(prep) => {
                let a = analyze_prepared(&prep, &fast_opt);
                let rows = compare(base, &a);
                let bad: Vec<String> = rows.iter().filter(|r| !matches!(r.verdict, V::Same | V::NotApplicable)).map(|r| format!("{} {}", r.def.key, r.verdict.label())).collect();
                if !bad.is_empty() { fp_ok = false; rep.false_positive_detail.push(format!("{name}: NOT SAME on {}", bad.join(", "))); }
                else { rep.false_positive_detail.push(format!("{name}: SAME on all {} applicable metrics", rows.iter().filter(|r| r.verdict != V::NotApplicable).count())); }
            }
            Err(e) => { fp_ok = false; rep.false_positive_detail.push(format!("{name}: could not run: {e}")); }
        }
    }
    rep.false_positive_ok = fp_ok;
    for p in PLANTS {
        let planted = match (p.apply)(orca_text) {
            Ok(t) => t,
            Err(e) => { rep.rows.push(ControlRow { plant: p.name, desc: p.desc, status: format!("PENDING: {e}"), detail: vec![], fired: vec![], missed: vec![], not_applicable: p.expects.to_vec(), also_better: vec![] }); continue; }
        };
        if planted == orca_text {
            rep.rows.push(ControlRow { plant: p.name, desc: p.desc, status: "NOT APPLICABLE on this model (plant changed nothing)".into(), detail: vec![], fired: vec![], missed: vec![], not_applicable: p.expects.to_vec(), also_better: vec![] });
            continue;
        }
        let res = parse::parse(&planted).map(|pp| swap_parsed(base_prep, pp));
        let prep = match res { Ok(x) => x, Err(e) => { rep.rows.push(ControlRow { plant: p.name, desc: p.desc, status: format!("PENDING: planted file unreadable: {e}"), detail: vec![], fired: vec![], missed: vec![], not_applicable: p.expects.to_vec(), also_better: vec![] }); continue; } };
        let a = analyze_prepared(&prep, &fast_opt);
        let rows = compare(base, &a);
        let mut row = ControlRow { plant: p.name, desc: p.desc, status: String::new(), detail: vec![], fired: vec![], missed: vec![], not_applicable: vec![], also_better: vec![] };
        for r in &rows {
            if r.verdict == V::Better { row.also_better.push(r.def.key); }
            if p.expects.contains(&r.def.key) {
                row.detail.push((r.def.key.to_string(), r.orca, r.ours, r.verdict));
                match r.verdict {
                    V::Worse => { row.fired.push(r.def.key); rep.controlled.insert(r.def.key); }
                    V::NotApplicable => row.not_applicable.push(r.def.key),
                    _ => { row.missed.push(r.def.key); rep.missed.insert(r.def.key); }
                }
            }
        }
        row.status = if !row.missed.is_empty() { format!("MISSED on {}", row.missed.join(", ")) } else if row.fired.is_empty() { "NOT APPLICABLE on this model".into() } else { "FIRED".into() };
        rep.rows.push(row);
    }
    // a metric both fired and missed by different plants is controlled only if no plant missed it
    rep.controlled = rep.controlled.difference(&rep.missed.clone()).copied().collect();
    rep
}

fn swap_parsed(base: &analyze::Prepared, parsed: parse::Parsed) -> analyze::Prepared {
    analyze::Prepared { parsed, geoms: base.geoms.clone(), offset: base.offset, lim: base.lim.clone() }
}

// ------------------------------------------------------------------------------------ rendering
fn f(v: Option<f64>) -> String { match v { None => "-".into(), Some(x) if x.abs() >= 1000.0 => format!("{x:.1}"), Some(x) => format!("{x:.4}") } }

pub fn render_table(rows: &[Row], controlled: &BTreeSet<&'static str>) -> String {
    let mut s = String::new();
    s += &format!("{:<28} {:>11} {:>11} {:>9} {:>9}  {:<7} {:<4} {}\n", "metric (unit, better=)", "orca", "ours", "noise", "thr", "verdict", "risk", "control");
    for r in rows {
        let ctl = if controlled.contains(r.def.key) { "fired" } else { "none" };
        s += &format!("{:<28} {:>11} {:>11} {:>9.4} {:>9.4}  {:<7} {:<4} {}\n", format!("{} ({}, {})", r.def.key, r.def.unit, r.def.dir.label()), f(r.orca), f(r.ours), r.noise, r.thr,
            r.verdict.label(), if r.def.risk { "RISK" } else { "" }, ctl);
    }
    s
}

pub fn render_controls(c: &ControlReport) -> String {
    let mut s = String::from("NEGATIVE CONTROLS (planted degradations of the reference file; each must read WORSE on the metric it targets)\n");
    for d in &c.false_positive_detail { s += &format!("  false-positive control  {d}\n"); }
    for r in &c.rows {
        s += &format!("  {:<22} {:<28} {}\n", r.plant, r.status, r.desc);
        for (k, o, u, v) in &r.detail { s += &format!("      {:<28} orca {:>10} -> planted {:>10}  {}\n", k, f(*o), f(*u), v.label()); }
        if !r.also_better.is_empty() { s += &format!("      (this plant also reads BETTER on: {} -- a good-looking number bought by the defect)\n", r.also_better.join(", ")); }
    }
    s += &format!("  controlled metrics ({}): {}\n", c.controlled.len(), c.controlled.iter().cloned().collect::<Vec<_>>().join(", "));
    if !c.missed.is_empty() { s += &format!("  INSTRUMENT DEFECT -- planted but NOT detected: {}\n", c.missed.iter().cloned().collect::<Vec<_>>().join(", ")); }
    let un: Vec<&str> = DEFS.iter().map(|d| d.key).filter(|k| !c.controlled.contains(k)).collect();
    s += &format!("  UNCONTROLLED on this model ({}): {} -- a BETTER on these is not accepted\n", un.len(), un.join(", "));
    s
}

pub fn to_json(rows: &[Row], overall_: &Overall, settings: &Settings, c: &ControlReport) -> serde_json::Value {
    use serde_json::json;
    json!({
        "overall": overall_.label(),
        "exit_code": overall_.exit_code(),
        "reasons": match overall_ { Overall::Fail(v) | Overall::Unproven(v) => v.clone(), _ => vec![] },
        "settings": format!("{settings:?}"),
        "false_positive_controls_ok": c.false_positive_ok,
        "controlled": c.controlled.iter().collect::<Vec<_>>(),
        "controls_missed": c.missed.iter().collect::<Vec<_>>(),
        "metrics": rows.iter().map(|r| json!({
            "key": r.def.key, "group": r.def.group, "unit": r.def.unit, "better": r.def.dir.label(), "risk": r.def.risk,
            "orca": r.orca, "ours": r.ours, "noise": r.noise, "threshold": r.thr, "verdict": r.verdict.label(),
            "n_orca": r.n_orca, "n_ours": r.n_ours, "controlled": c.controlled.contains(r.def.key),
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn m(v: f64) -> MVal { MVal { v: Some(v), n: 10 } }
    fn def(k: &str) -> &'static Def { DEFS.iter().find(|d| d.key == k).unwrap() }
    fn row(k: &str, o: f64, u: f64) -> Row { judge(def(k), &m(o), &m(u), 0.0) }

    #[test] fn judge_respects_direction_tolerance_and_match() {
        assert_eq!(row("travel_mm", 1000.0, 900.0).verdict, V::Better);      // -10% > 2%
        assert_eq!(row("travel_mm", 1000.0, 1010.0).verdict, V::Same);       // +1% inside 2%
        assert_eq!(row("travel_mm", 1000.0, 1100.0).verdict, V::Worse);
        assert_eq!(row("first_layer_coverage_pct", 98.0, 99.5).verdict, V::Better); // higher is better
        assert_eq!(row("first_layer_coverage_pct", 99.5, 98.0).verdict, V::Worse);
        // MATCH: less filament is never BETTER
        assert_eq!(row("filament_mm", 1000.0, 800.0).verdict, V::Worse);
        // measured noise widens the SAME band
        let r = judge(def("print_time_s"), &m(1000.0), &m(960.0), 50.0);
        assert_eq!(r.verdict, V::Same, "a 40 s gain inside a 50 s noise floor is not evidence");
        // one-sided metric is not comparable
        assert_eq!(judge(def("travel_mm"), &m(1.0), &MVal { v: None, n: 0 }, 0.0).verdict, V::Incomparable);
        assert_eq!(judge(def("travel_mm"), &MVal { v: None, n: 0 }, &MVal { v: None, n: 0 }, 0.0).verdict, V::NotApplicable);
    }

    #[test] fn a_risk_regression_is_never_bought_back() {
        // time BETTER, flow limit WORSE: the classic silent trade. Must be FAIL even with every control fired.
        let rows = vec![row("print_time_s", 1000.0, 600.0), row("flow_violation_count", 0.0, 650.0)];
        let ctl: BTreeSet<&'static str> = ["print_time_s", "flow_violation_count"].into_iter().collect();
        match overall(&rows, &Settings::Verified(28), &ctl, true) {
            Overall::Fail(v) => assert!(v.iter().any(|s| s.contains("flow_violation_count") && s.contains("PHYSICAL-RISK"))),
            o => panic!("{o:?}"),
        }
    }

    #[test] fn better_needs_every_condition() {
        let rows = vec![row("print_time_s", 1000.0, 800.0), row("travel_mm", 1000.0, 1000.0)];
        let ctl: BTreeSet<&'static str> = ["print_time_s"].into_iter().collect();
        assert_eq!(overall(&rows, &Settings::Verified(28), &ctl, true), Overall::ProvenBetter);
        // (e) no control fired for the BETTER metric
        assert!(matches!(overall(&rows, &Settings::Verified(28), &BTreeSet::new(), true), Overall::Unproven(_)));
        // (e) false-positive controls failed
        assert!(matches!(overall(&rows, &Settings::Verified(28), &ctl, false), Overall::Unproven(_)));
        // (d) settings unverified / different
        assert!(matches!(overall(&rows, &Settings::Unverified("x".into()), &ctl, true), Overall::Unproven(_)));
        assert!(matches!(overall(&rows, &Settings::Mismatch(vec!["wall_loops".into()]), &ctl, true), Overall::Unproven(_)));
        // all SAME -> Same
        let same = vec![row("travel_mm", 1000.0, 1000.0)];
        assert_eq!(overall(&same, &Settings::Verified(1), &BTreeSet::new(), false), Overall::Same);
        // exit code: unproven is a FAIL
        assert_eq!(Overall::Unproven(vec![]).exit_code(), 1);
        assert_eq!(Overall::ProvenBetter.exit_code(), 0);
    }

    #[test] fn every_metric_def_is_computed_and_every_plant_targets_a_def() {
        let keys: BTreeSet<&str> = DEFS.iter().map(|d| d.key).collect();
        assert_eq!(keys.len(), DEFS.len(), "duplicate metric key");
        for p in PLANTS { for e in p.expects { assert!(keys.contains(e), "plant {} expects unknown metric {e}", p.name); } }
    }

    // ---- end-to-end on a synthetic part: 10 x 10 x 1.0 mm box, 5 layers of 0.2 mm
    fn lim() -> Lim {
        Lim { flow_max: 15.0, acc_max: 1500.0, jerk: 10.0, min_layer_time: 1.0, bridge_speed: 50.0, overhang_fan_pct: 100.0, top_layers: 1,
            top_thickness: 0.0, bottom_layers: 1, bottom_thickness: 0.0, wall_loops: 2, outer_w: 0.42, inner_w: 0.45 }
    }
    fn e_for(len: f64, w: f64, h: f64) -> f64 { len * (w - h * (1.0 - PI / 4.0)) * h / (PI * 1.75 * 1.75 / 4.0) }
    fn synth() -> String {
        let (h, o) = (0.2, 50.0); // box occupies o..o+10
        let mut s = String::from("; HEADER_BLOCK_START\n; filament_diameter: 1.75\n; HEADER_BLOCK_END\n; EXECUTABLE_BLOCK_START\nM83\n");
        for l in 0..5 {
            s += &format!("; CHANGE_LAYER\n; Z_HEIGHT: {:.1}\n; LAYER_HEIGHT: 0.2\nM204 S1000\n", h * (l + 1) as f64);
            for (feat, ins, w, f) in [("Outer wall", 0.21, 0.42, 3600.0), ("Inner wall", 0.645, 0.45, 6000.0)] {
                let (a, b) = (o + ins, o + 10.0 - ins);
                s += &format!("G1 X{a} Y{a} F60000\n; FEATURE: {feat}\n; LINE_WIDTH: {w}\nG1 F{f}\n");
                for (x, y) in [(b, a), (b, b), (a, b), (a, a)] {
                    let (px, py) = if (x, y) == (b, a) { (a, a) } else if (x, y) == (b, b) { (b, a) } else if (x, y) == (a, b) { (b, b) } else { (a, b) };
                    s += &format!("G1 X{x:.3} Y{y:.3} E{:.5}\n", e_for(((x - px) as f64).hypot(y - py), w, h));
                }
                if feat == "Inner wall" { s += "G1 E-0.8 F1800\n"; }
            }
            // solid infill: horizontal lines filling the inside of the inner wall
            let (lo, hi) = (o + 0.645 + 0.225, o + 10.0 - 0.645 - 0.225);
            s += &format!("G1 X{lo:.3} Y{lo:.3} F60000\nG1 E0.8 F1800\n; FEATURE: Internal solid infill\n; LINE_WIDTH: 0.42\nG1 F6000\n");
            let mut y = lo + 0.2;
            let mut dir = 1.0;
            let mut x = lo;
            while y < hi {
                let nx = if dir > 0.0 { hi } else { lo };
                s += &format!("G1 X{nx:.3} Y{y:.3} E{:.5}\n", e_for((nx - x).abs().max(0.001), 0.42, h));
                x = nx; dir = -dir; y += 0.38;
            }
            s += "G1 E-0.8 F1800\n";
        }
        s + "; EXECUTABLE_BLOCK_END\n"
    }
    fn box_mesh() -> Mesh {
        let mut m = Mesh::from_soup(&crate::mesh::tests::box_soup(10.0, 10.0, 1.0)).unwrap();
        m.translate([50.0, 50.0, 0.0]);
        m
    }
    fn run(text: &str) -> Analysis {
        let o = Opt { noise_runs: 2, offset: Some([0.0, 0.0]), ..Opt::default() };
        analyze_text(text, &box_mesh(), &lim(), &o).unwrap_or_else(|e| panic!("{e}")).1
    }
    #[test] fn end_to_end_synthetic_part_and_plants() {
        let t = synth();
        let a = run(&t);
        let get = |a: &Analysis, k: &str| a.metrics[k].v.unwrap();
        assert!(get(&a, "dim_err_mean_mm") < 0.01, "outer wall sits on the contour: {}", get(&a, "dim_err_mean_mm"));
        assert!(get(&a, "outside_region_pct") < 0.5);
        // population sizes are reported (a green over an empty population means nothing)
        assert!(a.metrics["dim_err_mean_mm"].n > 100);
        // identity and a 1-um shift stay SAME everywhere
        for variant in [t.clone(), plants::tiny_shift(&t, 0.001).unwrap()] {
            let b = run(&variant);
            let rows = compare(&a, &b);
            let bad: Vec<_> = rows.iter().filter(|r| !matches!(r.verdict, V::Same | V::NotApplicable)).map(|r| (r.def.key, r.orca, r.ours)).collect();
            assert!(bad.is_empty(), "{bad:?}");
        }
        // negative controls: planted defects must come out WORSE on the named metric
        let cases: Vec<(&str, String, &str)> = vec![
            ("jitter", plants::jitter_walls(&t, 0.12).unwrap(), "dim_err_mean_mm"),
            ("drop solid", plants::drop_features(&t, &["Internal solid infill"]).unwrap(), "solid_underfill_pct"),
            ("extra retract", plants::extra_retractions(&t, 0.8).unwrap(), "retract_count"),
            ("flow over", plants::scale_speed(&t, &["Internal solid infill"], 4.0).unwrap(), "flow_peak_ratio"),
            ("accel over", plants::scale_accel(&t, 4.0).unwrap(), "accel_violation_count"),
            ("overextrude", plants::scale_e(&t, &["Inner wall", "Internal solid infill"], 1.8).unwrap(), "overfill_pct"),
        ];
        for (name, text, key) in cases {
            let b = run(&text);
            let r = compare(&a, &b).into_iter().find(|r| r.def.key == key).unwrap();
            assert_eq!(r.verdict, V::Worse, "plant '{name}' must make {key} WORSE: {:?} -> {:?}", r.orca, r.ours);
        }
        // the trade-off control: flow-over is faster (time BETTER) yet overall FAIL
        let b = run(&plants::scale_speed(&t, &["Internal solid infill"], 4.0).unwrap());
        let rows = compare(&a, &b);
        let ctl: BTreeSet<&'static str> = DEFS.iter().map(|d| d.key).collect();
        assert!(matches!(overall(&rows, &Settings::Verified(28), &ctl, true), Overall::Fail(_)));
    }
    #[test] fn refuses_a_mesh_that_is_not_this_part() {
        let t = synth();
        let mut far = box_mesh();
        far.translate([30.0, 0.0, 0.0]);
        let o = Opt { noise_runs: 0, offset: Some([0.0, 0.0]), ..Opt::default() };
        assert!(analyze_text(&t, &far, &lim(), &o).is_err(), "a mesh 30 mm off must be refused, not scored");
        let tall = Mesh::from_soup(&crate::mesh::tests::box_soup(10.0, 10.0, 5.0)).unwrap();
        assert!(analyze_text(&t, &tall, &lim(), &Opt { noise_runs: 0, ..Opt::default() }).is_err());
    }
}
