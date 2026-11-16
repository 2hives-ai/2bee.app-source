//! lane 8: compare two G-code statistics sets (Orca's vs ours) with tolerances, render a table and JSON.
//!
//! Contract (same as `SLICER-GATES.md` / the rest of the fleet):
//! * Every row names what it measures. A row that cannot be computed is `PENDING`, never `PASS`.
//! * Tolerances: PASS within +-3 %, WARN within +-10 %, FAIL beyond (`Tol`), with ABSOLUTE FLOORS per metric
//!   so a 0.3 mm gap-fill sliver does not trip a percentage. Exact metrics (layer count, layer z) have no
//!   percentage band at all.
//! * A feature present in one file and absent in the other is FAIL (its `path_mm` row compares against 0), unless
//!   the present side is below the presence floor, and even then the row is printed, never skipped.
//! * A report over zero judged rows is `PENDING`, so a green over an empty population is impossible.
//! * Negative controls live here too: `plant_wall_scale`, `plant_drop_feature`, `synthetic_gcode`.
use crate::gcode_parse::{Stats, parse};
use crate::types::FdmError;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Status {
    /// Shown, not judged (counts, explicitly skipped metrics, seam position for a random seam).
    Info,
    Pass,
    Warn,
    /// Could not be computed (missing on one side, no population). Never a pass.
    Pending,
    Fail,
}
impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Info => "INFO",
            Status::Pass => "PASS",
            Status::Warn => "WARN",
            Status::Pending => "PENDING",
            Status::Fail => "FAIL",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Tol {
    pub pass: f64,
    pub warn: f64,
}
impl Default for Tol {
    fn default() -> Self {
        Tol { pass: 3.0, warn: 10.0 }
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub tol: Tol,
    /// Judge seam start positions layer by layer (off for `seam_position=random`, where no match is possible).
    pub judge_seam_pos: bool,
    pub seam_dist_mm: f64,
    pub seam_pass_frac: f64,
    pub seam_warn_frac: f64,
    /// Compare the `Custom` feature (start/end G-code, purge lines) too.
    pub include_custom: bool,
    /// Row groups (or `group/metric`) that are shown as INFO "SKIPPED" instead of judged.
    pub skip: Vec<String>,
    /// Absolute floors (mm of path, mm of filament, mm/s, mm of width).
    pub floor_path_mm: f64,
    pub floor_e_mm: f64,
    pub floor_layer_path_mm: f64,
}
impl Default for Options {
    fn default() -> Self {
        Options {
            tol: Tol::default(),
            judge_seam_pos: true,
            seam_dist_mm: 0.5,
            seam_pass_frac: 0.9,
            seam_warn_frac: 0.7,
            include_custom: false,
            skip: Vec::new(),
            floor_path_mm: 2.0,
            floor_e_mm: 0.5,
            floor_layer_path_mm: 3.0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Row {
    pub group: String,
    pub metric: String,
    pub orca: Option<f64>,
    pub ours: Option<f64>,
    pub delta: Option<f64>,
    /// (ours - orca) / |orca| * 100; None when orca is 0 or a side is missing.
    pub pct: Option<f64>,
    pub status: Status,
    pub note: String,
}

fn mk(group: &str, metric: &str, o: Option<f64>, u: Option<f64>, status: Status, note: &str) -> Row {
    let delta = match (o, u) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let pct = match (o, delta) {
        (Some(a), Some(d)) if a.abs() > 0.0 => Some(d / a.abs() * 100.0),
        _ => None,
    };
    Row { group: group.into(), metric: metric.into(), orca: o, ours: u, delta, pct, status, note: note.into() }
}

fn pending_note(o: Option<f64>, u: Option<f64>) -> String {
    match (o, u) {
        (None, None) => "reported by neither side".into(),
        (None, _) => "not available from Orca's file".into(),
        _ => "not available from our file".into(),
    }
}

/// Relative metric with an absolute floor.
pub fn rel_row(group: &str, metric: &str, o: Option<f64>, u: Option<f64>, floor: f64, tol: &Tol) -> Row {
    let (Some(a), Some(b)) = (o, u) else {
        return mk(group, metric, o, u, Status::Pending, &pending_note(o, u));
    };
    let d = b - a;
    if d.abs() <= floor {
        return mk(group, metric, o, u, Status::Pass, &format!("|delta| <= floor {floor}"));
    }
    if a.abs() == 0.0 {
        return mk(group, metric, o, u, Status::Fail, "orca value is 0, ours is not (or the reverse): present on one side only");
    }
    let p = (d / a.abs() * 100.0).abs();
    let s = if p <= tol.pass { Status::Pass } else if p <= tol.warn { Status::Warn } else { Status::Fail };
    mk(group, metric, o, u, s, "")
}

/// Exact metric (no band).
pub fn exact_row(group: &str, metric: &str, o: Option<f64>, u: Option<f64>, eps: f64) -> Row {
    let (Some(a), Some(b)) = (o, u) else {
        return mk(group, metric, o, u, Status::Pending, &pending_note(o, u));
    };
    let s = if (a - b).abs() <= eps { Status::Pass } else { Status::Fail };
    mk(group, metric, o, u, s, "must match exactly")
}

/// Absolute-difference band (mm).
pub fn abs_row(group: &str, metric: &str, o: Option<f64>, u: Option<f64>, pass: f64, warn: f64) -> Row {
    let (Some(a), Some(b)) = (o, u) else {
        return mk(group, metric, o, u, Status::Pending, &pending_note(o, u));
    };
    let d = (a - b).abs();
    let s = if d <= pass { Status::Pass } else if d <= warn { Status::Warn } else { Status::Fail };
    mk(group, metric, o, u, s, &format!("abs band {pass}/{warn}"))
}

#[derive(Clone, Debug, Serialize)]
pub struct Population {
    pub orca_lines: usize,
    pub ours_lines: usize,
    pub orca_extrusion_moves: usize,
    pub ours_extrusion_moves: usize,
    pub orca_layers: usize,
    pub ours_layers: usize,
    pub features_compared: usize,
    pub layers_compared: usize,
    pub judged_rows: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub rows: Vec<Row>,
    pub pass: usize,
    pub warn: usize,
    pub fail: usize,
    pub pending: usize,
    pub info: usize,
    pub verdict: Status,
    pub population: Population,
}

impl Report {
    /// 0 = PASS/WARN, 1 = FAIL, 2 = PENDING (could not fully run). Same vocabulary as the fleet gates.
    pub fn exit_code(&self) -> i32 {
        match self.verdict {
            Status::Fail => 1,
            Status::Pending => 2,
            _ => 0,
        }
    }
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
    pub fn worst_row(&self) -> Option<&Row> {
        self.rows.iter().filter(|r| r.status != Status::Info).max_by(|a, b| {
            a.status.cmp(&b.status).then(a.pct.unwrap_or(0.0).abs().partial_cmp(&b.pct.unwrap_or(0.0).abs()).unwrap_or(std::cmp::Ordering::Equal))
        })
    }
    pub fn row(&self, group: &str, metric: &str) -> Option<&Row> {
        self.rows.iter().find(|r| r.group == group && r.metric == metric)
    }
}

fn skipped(o: &Options, r: &mut Row) {
    let key = format!("{}/{}", r.group, r.metric);
    if o.skip.iter().any(|s| s == &r.group || *s == key || r.group.starts_with(&format!("{s}:"))) {
        r.status = Status::Info;
        r.note = format!("SKIPPED by --skip ({})", r.note);
    }
}

fn some(v: f64) -> Option<f64> {
    Some(v)
}

fn nonc<'a>(s: &'a Stats, o: &Options) -> BTreeMap<String, &'a crate::gcode_parse::FeatureStats> {
    s.features.iter().filter(|(k, _)| o.include_custom || k.as_str() != "Custom").map(|(k, v)| (k.clone(), v)).collect()
}

/// Compare Orca's statistics (the reference) with ours.
pub fn compare(orca: &Stats, ours: &Stats, o: &Options) -> Report {
    let t = &o.tol;
    let mut rows: Vec<Row> = Vec::new();
    let fo = nonc(orca, o);
    let fu = nonc(ours, o);
    let names: BTreeSet<&String> = fo.keys().chain(fu.keys()).collect();
    let mut features_compared = 0;
    for n in &names {
        features_compared += 1;
        let g = format!("feature:{n}");
        let (a, b) = (fo.get(*n), fu.get(*n));
        let pa = a.map_or(0.0, |f| f.path_mm);
        let pb = b.map_or(0.0, |f| f.path_mm);
        let mut r = rel_row(&g, "path_mm", some(pa), some(pb), o.floor_path_mm, t);
        if a.is_none() && pb > o.floor_path_mm {
            r.status = Status::Fail;
            r.note = "FEATURE ABSENT IN ORCA, present in ours".into();
        } else if b.is_none() && pa > o.floor_path_mm {
            r.status = Status::Fail;
            r.note = "FEATURE MISSING IN OURS, present in Orca".into();
        }
        rows.push(r);
        rows.push(rel_row(&g, "e_mm", some(a.map_or(0.0, |f| f.e_mm)), some(b.map_or(0.0, |f| f.e_mm)), o.floor_e_mm, t));
        rows.push(mk(&g, "moves", a.map(|f| f.moves as f64), b.map(|f| f.moves as f64), Status::Info, "segmentation differs legitimately"));
        if let (Some(a), Some(b)) = (a, b) {
            // widths: pending when either side carries no LINE_WIDTH annotation for this feature
            rows.push(rel_row(&g, "width_mean", a.width_mean, b.width_mean, 0.01, t));
            rows.push(rel_row(&g, "speed_mean", a.speed_mean, b.speed_mean, 1.0, t));
            rows.push(rel_row(&g, "speed_max", a.speed_max, b.speed_max, 1.0, t));
            rows.push(rel_row(&g, "xsec_mm2", a.xsec_mm2, b.xsec_mm2, 0.002, t));
        }
    }

    // layers
    rows.push(exact_row("layers", "count", some(orca.layers.len() as f64), some(ours.layers.len() as f64), 0.0));
    let n = orca.layers.len().min(ours.layers.len());
    let mut maxdz = 0.0f64;
    for i in 0..n {
        maxdz = maxdz.max((orca.layers[i].z - ours.layers[i].z).abs());
    }
    if n == 0 {
        rows.push(mk("layers", "z_max_abs_diff", None, None, Status::Pending, "no layers on at least one side"));
    } else {
        let mut r = abs_row("layers", "z_max_abs_diff", some(0.0), some(maxdz), 0.001, 0.01);
        if orca.layers.len() != ours.layers.len() {
            r.note = format!("compared the first {n} layers only (counts differ)");
        }
        rows.push(r);
    }
    let mut worst: Option<Row> = None;
    let (mut bad, mut warn) = (0, 0);
    let pl = |s: &Stats, i: usize| -> f64 {
        s.layers[i].path_by_feature.iter().filter(|(k, _)| o.include_custom || k.as_str() != "Custom").map(|(_, v)| *v).sum()
    };
    for i in 0..n {
        let r = rel_row("layers", &format!("path_mm[L{i}]"), some(pl(orca, i)), some(pl(ours, i)), o.floor_layer_path_mm, t);
        match r.status {
            Status::Fail => bad += 1,
            Status::Warn => warn += 1,
            _ => {}
        }
        let better = match &worst {
            None => true,
            Some(w) => (r.status, r.pct.unwrap_or(0.0).abs().to_bits_ord()) > (w.status, w.pct.unwrap_or(0.0).abs().to_bits_ord()),
        };
        if better {
            worst = Some(r);
        }
    }
    if let Some(mut w) = worst {
        let name = w.metric.clone();
        w.metric = "path_mm_worst_layer".into();
        w.note = format!("worst {name}; {bad} layers FAIL, {warn} WARN of {n}");
        rows.push(w);
    } else {
        rows.push(mk("layers", "path_mm_worst_layer", None, None, Status::Pending, "no common layers"));
    }
    let fil = |s: &Stats| -> f64 { s.features.iter().filter(|(k, _)| o.include_custom || k.as_str() != "Custom").map(|(_, f)| f.e_mm).sum() };
    rows.push(rel_row("layers", "filament_mm_in_layers", some(fil(orca)), some(fil(ours)), 1.0, t));

    // bounding box
    match (orca.bbox, ours.bbox) {
        (Some(a), Some(b)) => {
            for (i, nm) in ["xmin", "ymin", "zmin", "xmax", "ymax", "zmax"].iter().enumerate() {
                let (p, w) = if i == 2 || i == 5 { (0.01, 0.05) } else { (0.3, 1.0) };
                rows.push(abs_row("bbox", nm, some(a[i]), some(b[i]), p, w));
            }
        }
        (a, b) => rows.push(mk("bbox", "all", None, None, Status::Pending, &pending_note(a.map(|_| 0.0), b.map(|_| 0.0)))),
    }

    // retraction / z-hop
    rows.push(rel_row("retraction", "count", some(orca.retractions.count as f64), some(ours.retractions.count as f64), 3.0, t));
    rows.push(rel_row("retraction", "total_mm", some(orca.retractions.total_mm), some(ours.retractions.total_mm), 1.0, t));
    rows.push(rel_row("zhop", "count", some(orca.zhops.count as f64), some(ours.zhops.count as f64), 3.0, t));
    rows.push(abs_row("zhop", "max_h", some(orca.zhops.max_h), some(ours.zhops.max_h), 0.01, 0.05));

    // seams
    let sc = |s: &Stats| s.layers.iter().map(|l| l.seams.len()).sum::<usize>() as f64;
    rows.push(rel_row("seam", "count", some(sc(orca)), some(sc(ours)), 1.0, t));
    {
        let (mut total, mut hit) = (0usize, 0usize);
        for i in 0..n {
            for s in &orca.layers[i].seams {
                total += 1;
                if ours.layers[i].seams.iter().any(|q| (q[0] - s[0]).hypot(q[1] - s[1]) <= o.seam_dist_mm) {
                    hit += 1;
                }
            }
        }
        if total == 0 {
            rows.push(mk("seam", "position_match", None, None, Status::Pending, "no outer-wall seams in Orca's file"));
        } else {
            let f = hit as f64 / total as f64;
            let s = if !o.judge_seam_pos {
                Status::Info
            } else if f >= o.seam_pass_frac {
                Status::Pass
            } else if f >= o.seam_warn_frac {
                Status::Warn
            } else {
                Status::Fail
            };
            let note = if o.judge_seam_pos {
                format!("{hit}/{total} Orca seams have one of ours within {} mm", o.seam_dist_mm)
            } else {
                format!("not judged (random/unmatchable seam mode); {hit}/{total} within {} mm", o.seam_dist_mm)
            };
            rows.push(mk("seam", "position_match", some(1.0), some(f), s, &note));
        }
    }

    // fan
    rows.push(rel_row("fan", "commands", some(orca.fans.len() as f64), some(ours.fans.len() as f64), 2.0, t));
    {
        let set = |s: &Stats| -> BTreeSet<i64> { s.fans.iter().map(|f| f.s.round() as i64).collect() };
        let (a, b) = (set(orca), set(ours));
        let diff: Vec<i64> = a.symmetric_difference(&b).copied().collect();
        let s = match diff.len() {
            0 => Status::Pass,
            1 => Status::Warn,
            _ => Status::Fail,
        };
        rows.push(mk("fan", "distinct_S_values", some(a.len() as f64), some(b.len() as f64), s, &format!("S values on one side only: {diff:?}")));
    }

    // header values
    let (ha, hb) = (&orca.header, &ours.header);
    rows.push(rel_row("header", "total_time_s", ha.total_time_s, hb.total_time_s, 5.0, t));
    rows.push(rel_row("header", "model_time_s", ha.model_time_s, hb.model_time_s, 5.0, t));
    rows.push(rel_row("header", "first_layer_time_s", ha.first_layer_time_s, hb.first_layer_time_s, 3.0, t));
    rows.push(exact_row("header", "layer_count", ha.layer_count, hb.layer_count, 0.0));
    rows.push(rel_row("header", "filament_mm", ha.filament_mm, hb.filament_mm, 1.0, t));
    rows.push(rel_row("header", "filament_cm3", ha.filament_cm3, hb.filament_cm3, 0.05, t));
    rows.push(rel_row("header", "filament_g", ha.filament_g, hb.filament_g, 0.05, t));
    for w in &ours.warnings {
        rows.push(mk("parse", "ours_warning", None, None, Status::Info, w));
    }

    for r in rows.iter_mut() {
        skipped(o, r);
    }
    let count = |s: Status| rows.iter().filter(|r| r.status == s).count();
    let (pass, warn_n, fail, pending, info) = (count(Status::Pass), count(Status::Warn), count(Status::Fail), count(Status::Pending), count(Status::Info));
    let judged = pass + warn_n + fail + pending;
    let verdict = if fail > 0 {
        Status::Fail
    } else if pending > 0 || judged == 0 {
        Status::Pending
    } else if warn_n > 0 {
        Status::Warn
    } else {
        Status::Pass
    };
    Report {
        rows,
        pass,
        warn: warn_n,
        fail,
        pending,
        info,
        verdict,
        population: Population {
            orca_lines: orca.lines,
            ours_lines: ours.lines,
            orca_extrusion_moves: orca.extrusion_moves,
            ours_extrusion_moves: ours.extrusion_moves,
            orca_layers: orca.layers.len(),
            ours_layers: ours.layers.len(),
            features_compared,
            layers_compared: n,
            judged_rows: judged,
        },
    }
}

trait OrdBits {
    fn to_bits_ord(self) -> u64;
}
impl OrdBits for f64 {
    /// Monotone integer key for a non-negative finite f64.
    fn to_bits_ord(self) -> u64 {
        if self.is_finite() { self.to_bits() } else { u64::MAX }
    }
}

/// Parse both texts and compare.
pub fn compare_text(orca: &str, ours: &str, o: &Options) -> Result<Report, FdmError> {
    let (a, b) = parse_pair(orca, ours);
    Ok(compare(&a?, &b?, o))
}

/// Parse the two files concurrently (native targets): the parses are independent pure functions, so the
/// statistics are bit-identical to two sequential `parse` calls. Error priority is unchanged (Orca's first).
/// wasm32 has no threads here and parses serially.
fn parse_pair(a: &str, b: &str) -> (Result<Stats, FdmError>, Result<Stats, FdmError>) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        // tiny inputs: a thread costs more than the parse
        if a.len() + b.len() >= (1 << 20) {
            return std::thread::scope(|sc| {
                let h = sc.spawn(|| parse(a));
                let rb = parse(b);
                (h.join().unwrap_or_else(|_| Err(FdmError::Parse("parser thread panicked".into()))), rb)
            });
        }
    }
    (parse(a), parse(b))
}

fn fmt(v: Option<f64>) -> String {
    match v {
        None => "-".into(),
        Some(x) if x.abs() >= 1000.0 => format!("{x:.1}"),
        Some(x) => format!("{x:.3}"),
    }
}

pub fn render_table(r: &Report, show_pass: bool) -> String {
    let mut s = String::new();
    let p = &r.population;
    s += &format!(
        "population: orca {} lines / {} extrusion moves / {} layers   ours {} lines / {} extrusion moves / {} layers   features {}   common layers {}   judged rows {}\n",
        p.orca_lines, p.orca_extrusion_moves, p.orca_layers, p.ours_lines, p.ours_extrusion_moves, p.ours_layers, p.features_compared, p.layers_compared, p.judged_rows
    );
    s += &format!("{:<34}{:>12}{:>12}{:>11}{:>9}  {:<8}{}\n", "group / metric", "orca", "ours", "delta", "pct", "status", "note");
    for row in &r.rows {
        if !show_pass && matches!(row.status, Status::Pass | Status::Info) {
            continue;
        }
        let name = format!("{} / {}", row.group, row.metric);
        let pct = row.pct.map_or("-".to_string(), |v| format!("{v:+.1}%"));
        s += &format!("{:<34}{:>12}{:>12}{:>11}{:>9}  {:<8}{}\n", name, fmt(row.orca), fmt(row.ours), fmt(row.delta), pct, row.status.label(), row.note);
    }
    s += &format!("VERDICT {}   PASS {}  WARN {}  FAIL {}  PENDING {}  INFO {}\n", r.verdict.label(), r.pass, r.warn, r.fail, r.pending, r.info);
    s
}

// ---------------------------------------------------------------------------------------------------------
// Negative controls: plants applied to a COPY of a G-code text.
// ---------------------------------------------------------------------------------------------------------

fn split_code(line: &str) -> (&str, &str) {
    match line.find(';') {
        Some(i) => (&line[..i], &line[i..]),
        None => (line, ""),
    }
}

fn fnum(v: f64) -> String {
    let s = format!("{v:.5}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" { "0".into() } else { s.to_string() }
}

/// Plant: scale every wall extrusion (features `Outer wall`, `Inner wall`, `Overhang wall`) by `k` in XY length and
/// E, keeping travels between them unchanged (the nozzle position drifts, the wall LENGTH grows by `k`).
/// Handles absolute XY, relative or absolute E, and G2/G3 arcs (I/J scaled with the chord).
pub fn plant_wall_scale(gcode: &str, k: f64) -> String {
    plant_scale_features(gcode, k, &["Outer wall", "Inner wall", "Overhang wall"])
}

pub fn plant_scale_features(gcode: &str, k: f64, features: &[&str]) -> String {
    let mut out = String::with_capacity(gcode.len() + gcode.len() / 16);
    let (mut feat, mut e_rel) = (String::new(), false);
    let (mut ox, mut oy, mut px, mut py) = (0.0, 0.0, 0.0, 0.0);
    let (mut oe, mut pe) = (0.0, 0.0);
    for line in gcode.lines() {
        let (code, comment) = split_code(line);
        if let Some(c) = comment.strip_prefix(';') {
            if let Some(f) = c.trim().strip_prefix("FEATURE:") {
                feat = f.trim().to_string();
            }
        }
        let toks: Vec<&str> = code.split_ascii_whitespace().collect();
        let cmd = toks.first().copied().unwrap_or("");
        match cmd {
            "M82" => e_rel = false,
            "M83" => e_rel = true,
            _ => {}
        }
        if cmd == "G92" {
            for t in &toks[1..] {
                if let Some(v) = t.strip_prefix('E').and_then(|v| v.parse::<f64>().ok()) {
                    oe = v;
                    pe = v;
                }
            }
        }
        if !matches!(cmd, "G1" | "G0" | "G2" | "G3") {
            out += line;
            out.push('\n');
            continue;
        }
        let get = |c: char| toks[1..].iter().find_map(|t| t.strip_prefix(c).and_then(|v| v.parse::<f64>().ok()));
        let (nx, ny) = (get('X').unwrap_or(ox), get('Y').unwrap_or(oy));
        let e_word = get('E');
        let e_delta = e_word.map(|e| if e_rel { e } else { e - oe });
        let wall = features.contains(&feat.as_str()) && e_delta.map_or(false, |d| d > 0.0) && ((nx - ox).hypot(ny - oy) > 1e-9 || cmd == "G2" || cmd == "G3");
        let kk = if wall { k } else { 1.0 };
        let (nnx, nny) = (px + (nx - ox) * kk, py + (ny - oy) * kk);
        let mut newtoks: Vec<String> = Vec::with_capacity(toks.len());
        for t in &toks {
            let c = t.chars().next().unwrap_or(' ');
            let v = t[c.len_utf8()..].parse::<f64>().ok();
            match (c, v) {
                ('X', Some(_)) => newtoks.push(format!("X{}", fnum(nnx))),
                ('Y', Some(_)) => newtoks.push(format!("Y{}", fnum(nny))),
                ('I', Some(v)) if wall => newtoks.push(format!("I{}", fnum(v * k))),
                ('J', Some(v)) if wall => newtoks.push(format!("J{}", fnum(v * k))),
                ('E', Some(v)) => {
                    if e_rel {
                        newtoks.push(format!("E{}", fnum(if wall { v * k } else { v })));
                    } else {
                        let d = v - oe;
                        newtoks.push(format!("E{}", fnum(pe + d * if wall { k } else { 1.0 })));
                    }
                }
                _ => newtoks.push((*t).to_string()),
            }
        }
        if let Some(e) = e_word {
            if !e_rel {
                pe += (e - oe) * kk;
                oe = e;
            }
        }
        ox = nx;
        oy = ny;
        px = nnx;
        py = nny;
        out += &newtoks.join(" ");
        if !comment.is_empty() {
            out += " ";
            out += comment;
        }
        out.push('\n');
    }
    out
}

/// Plant: delete a whole feature's extrusion (E words dropped, the moves stay as travels).
pub fn plant_drop_feature(gcode: &str, feature: &str) -> String {
    let mut out = String::with_capacity(gcode.len());
    let mut feat = String::new();
    for line in gcode.lines() {
        let (code, comment) = split_code(line);
        if let Some(c) = comment.strip_prefix(';') {
            if let Some(f) = c.trim().strip_prefix("FEATURE:") {
                feat = f.trim().to_string();
            }
        }
        if feat == feature && code.trim_start().starts_with(['G']) {
            let toks: Vec<&str> = code.split_ascii_whitespace().filter(|t| !(t.starts_with('E') && t[1..].parse::<f64>().map_or(false, |v| v > 0.0))).collect();
            out += &toks.join(" ");
            if !comment.is_empty() {
                out += " ";
                out += comment;
            }
        } else {
            out += line;
        }
        out.push('\n');
    }
    out
}

/// Plant: scale every `F` word inside one feature by `k` (feed-rate defect).
pub fn plant_scale_speed(gcode: &str, feature: &str, k: f64) -> String {
    let mut out = String::new();
    let mut feat = String::new();
    for line in gcode.lines() {
        let (code, comment) = split_code(line);
        if let Some(c) = comment.strip_prefix(';') {
            if let Some(f) = c.trim().strip_prefix("FEATURE:") {
                feat = f.trim().to_string();
            }
        }
        if feat == feature && code.trim_start().starts_with('G') {
            let toks: Vec<String> = code
                .split_ascii_whitespace()
                .map(|t| match t.strip_prefix('F').and_then(|v| v.parse::<f64>().ok()) {
                    Some(v) => format!("F{}", fnum(v * k)),
                    None => t.to_string(),
                })
                .collect();
            out += &toks.join(" ");
            if !comment.is_empty() {
                out += " ";
                out += comment;
            }
        } else {
            out += line;
        }
        out.push('\n');
    }
    out
}

/// Plant: delete every line that starts with `prefix` (e.g. `M106` fan commands, `G1 E-` retractions).
pub fn plant_strip_lines(gcode: &str, prefix: &str) -> String {
    gcode.lines().filter(|l| !l.starts_with(prefix)).map(|l| format!("{l}\n")).collect()
}

/// Plant: shift the layer z values (`; Z_HEIGHT:` and Z words) by `dz` from layer index `from` on.
pub fn plant_z_shift(gcode: &str, dz: f64) -> String {
    let mut out = String::new();
    for line in gcode.lines() {
        let (code, comment) = split_code(line);
        let mut l = line.to_string();
        if let Some(v) = comment.strip_prefix("; Z_HEIGHT:").and_then(|v| v.trim().parse::<f64>().ok()) {
            l = format!("{}; Z_HEIGHT: {}", code, fnum(v + dz));
        }
        out += &l;
        out.push('\n');
    }
    out
}

/// A small deterministic Orca-style G-code: `layers` layers of a `size` mm square part, outer + inner wall, sparse
/// infill lines, a travel with retract + z-hop between features, fan commands and header values. Used by the
/// self-test and the unit tests, so the gate's controls never depend on another lane or on the Orca server.
pub fn synthetic_gcode(layers: usize, size: f64) -> String {
    let mut g = String::new();
    let h = 0.2;
    let area = std::f64::consts::PI * 1.75 * 1.75 / 4.0;
    let e_for = |len: f64, w: f64| len * (w - h * (1.0 - std::f64::consts::FRAC_PI_4)) * h / area;
    let mut total_e = 0.0;
    g += &format!("; HEADER_BLOCK_START\n; model printing time: 10m 0s; total estimated time: 12m 0s\n; estimated first layer printing time (normal mode) = 1m 0s\n; total layer number: {layers}\n; filament_diameter: 1.75\n; HEADER_BLOCK_END\nG90\nM83\nM106 S0\n");
    let mut body = String::new();
    for l in 0..layers {
        let z = h * (l as f64 + 1.0);
        body += &format!("; CHANGE_LAYER\n; Z_HEIGHT: {}\n; LAYER_HEIGHT: {h}\nM106 S{}\nG1 E-.8 F1800\nG1 Z{} F600\nG1 X10 Y10 F9000\nG1 Z{}\nG1 E.8 F1800\n", fnum(z), if l > 1 { 255 } else { 0 }, fnum(z + 0.4), fnum(z));
        for (name, off, w, v) in [("Outer wall", 0.0, 0.42, 60.0), ("Inner wall", 0.45, 0.45, 80.0)] {
            let (a, b) = (10.0 + off, 10.0 + size - off);
            body += &format!("; FEATURE: {name}\n; LINE_WIDTH: {w}\nG1 X{} Y{} F9000\nG1 F{}\n", fnum(a), fnum(a), fnum(v * 60.0));
            let len = b - a;
            for (x, y) in [(b, a), (b, b), (a, b), (a, a)] {
                body += &format!("G1 X{} Y{} E{}\n", fnum(x), fnum(y), fnum(e_for(len, w)));
                total_e += e_for(len, w);
            }
        }
        body += "; FEATURE: Sparse infill\n; LINE_WIDTH: 0.45\nG1 F4800\n";
        let (a, b) = (10.0 + 1.5, 10.0 + size - 1.5);
        let mut y = a + 1.0;
        let mut dir = true;
        while y < b {
            let (x0, x1) = if dir { (a, b) } else { (b, a) };
            body += &format!("G1 X{} Y{} F9000\nG1 X{} Y{} E{} F4800\n", fnum(x0), fnum(y), fnum(x1), fnum(y), fnum(e_for(b - a, 0.45)));
            total_e += e_for(b - a, 0.45);
            y += 3.0;
            dir = !dir;
        }
    }
    g += &body;
    let cm3 = total_e * area / 1000.0;
    g += &format!("; filament used [mm] = {:.2}\n; filament used [cm3] = {:.2}\n; filament used [g] = {:.2}\n", total_e, cm3, cm3 * 1.25);
    g
}

/// Binary STL of a `size` mm cube, or (hole > 0) a square-holed frame ("ring"), standing on z=0 at the origin corner.
/// Port of `web-slicer/test/mkcube.js`.
pub fn stl_cube(size: f64, hole: f64) -> Vec<u8> {
    type V = [f64; 3];
    let mut tris: Vec<[V; 3]> = Vec::new();
    let mut q = |p0: V, p1: V, p2: V, p3: V| {
        tris.push([p0, p1, p2]);
        tris.push([p0, p2, p3]);
    };
    let a = size;
    if hole <= 0.0 {
        let c = [[0., 0., 0.], [a, 0., 0.], [a, a, 0.], [0., a, 0.], [0., 0., a], [a, 0., a], [a, a, a], [0., a, a]];
        q(c[0], c[3], c[2], c[1]);
        q(c[4], c[5], c[6], c[7]);
        q(c[0], c[1], c[5], c[4]);
        q(c[1], c[2], c[6], c[5]);
        q(c[2], c[3], c[7], c[6]);
        q(c[3], c[0], c[4], c[7]);
    } else {
        let m = (a - hole) / 2.0;
        let mm = m + hole;
        let o = [[0., 0.], [a, 0.], [a, a], [0., a]];
        let i = [[m, m], [mm, m], [mm, mm], [m, mm]];
        let v = |p: [f64; 2], z: f64| -> V { [p[0], p[1], z] };
        for k in 0..4 {
            let j = (k + 1) % 4;
            q(v(o[k], 0.), v(o[j], 0.), v(o[j], a), v(o[k], a));
            q(v(i[j], 0.), v(i[k], 0.), v(i[k], a), v(i[j], a));
            q(v(o[k], a), v(o[j], a), v(i[j], a), v(i[k], a));
            q(v(o[j], 0.), v(o[k], 0.), v(i[k], 0.), v(i[j], 0.));
        }
    }
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for t in &tris {
        b.extend_from_slice(&[0u8; 12]); // normal left zero, as mkcube.js does
        for p in t {
            for c in p {
                b.extend_from_slice(&(*c as f32).to_le_bytes());
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

/// Binary STL of the `tbar` overhang model (T profile in x/z, extruded 20 mm along y). Port in spirit of
/// `test/mkoverhang.js t`; the profile is triangulated by hand so the outline has no T-junctions.
pub fn stl_tbar() -> Vec<u8> {
    // outline CCW seen from -y (x right, z up), 10 vertices
    let prof: [[f64; 2]; 10] = [[10., 0.], [20., 0.], [20., 10.], [30., 10.], [30., 15.], [20., 15.], [10., 15.], [0., 15.], [0., 10.], [10., 10.]];
    // triangles by index into prof (CCW in x/z)
    let tri: [[usize; 3]; 8] = [[0, 1, 2], [0, 2, 9], [9, 2, 5], [9, 5, 6], [2, 3, 4], [2, 4, 5], [9, 6, 7], [9, 7, 8]];
    let (y0, y1) = (0.0, 20.0);
    let v = |i: usize, y: f64| -> [f64; 3] { [prof[i][0], y, prof[i][1]] };
    let mut t: Vec<[[f64; 3]; 3]> = Vec::new();
    for [a, b, c] in tri {
        t.push([v(a, y0), v(b, y0), v(c, y0)]);
        t.push([v(a, y1), v(c, y1), v(b, y1)]);
    }
    for i in 0..prof.len() {
        let j = (i + 1) % prof.len();
        t.push([v(i, y0), v(i, y1), v(j, y1)]);
        t.push([v(i, y0), v(j, y1), v(j, y0)]);
    }
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&(t.len() as u32).to_le_bytes());
    for tr in &t {
        b.extend_from_slice(&[0u8; 12]);
        for p in tr {
            for c in p {
                b.extend_from_slice(&(*c as f32).to_le_bytes());
            }
        }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

// ---------------------------------------------------------------------------------------------------------
// Matrix definition (data + verdict aggregation; all I/O is in bin/parity.rs).
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum ModelSrc {
    Cube { size: f64, hole: f64 },
    /// 30 x 20 x 15 T: a 10 mm stem under a 5 mm bar, so both sides overhang 10 mm (supports, bridges, overhang walls).
    TBar,
    File(&'static str),
}
#[derive(Clone, Debug)]
pub struct Model {
    pub name: &'static str,
    pub src: ModelSrc,
}

const FLEET: &str = "/home/gbacs/hives/2bee.farm/hardware/cad/stl/fleet";
/// The default model set is cube + ring + the smallest real tray; `all_models()` adds the other real trays.
pub fn default_models() -> Vec<Model> {
    vec![
        Model { name: "cube", src: ModelSrc::Cube { size: 20.0, hole: 0.0 } },
        Model { name: "ring", src: ModelSrc::Cube { size: 20.0, hole: 8.0 } },
        Model { name: "tbar", src: ModelSrc::TBar },
        Model { name: "coupon0402", src: ModelSrc::File("pnp_blinds_coupon0402_set.stl") },
    ]
}
pub fn all_models() -> Vec<Model> {
    let mut v = default_models();
    for (n, f) in [("tray8emb", "pnp_blinds_8emb_set.stl"), ("tray8paper", "pnp_blinds_8paper_set.stl"), ("tray12", "pnp_blinds_12_set.stl"), ("tray16", "pnp_blinds_16_set.stl")] {
        v.push(Model { name: n, src: ModelSrc::File(f) });
    }
    v
}
pub fn fleet_dir() -> &'static str {
    FLEET
}

/// One matrix variation: one or more Orca process-level `key=value` overrides applied together (a few settings only act
/// in combination, e.g. a support style needs `enable_support`; a 2-layer top shell needs `top_shell_thickness=0`).
/// The baseline (no override) is added by the driver, not listed here.
#[derive(Clone, Debug)]
pub struct Variation {
    pub name: String,
    pub sets: Vec<(&'static str, &'static str)>,
}
impl Variation {
    pub fn baseline() -> Self {
        Variation { name: "baseline".into(), sets: vec![] }
    }
    fn of(sets: &[(&'static str, &'static str)]) -> Self {
        Variation { name: sets.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("+"), sets: sets.to_vec() }
    }
    /// True when this variation sets `key` (to any value).
    pub fn sets_key(&self, key: &str) -> bool {
        self.sets.iter().any(|(k, _)| *k == key)
    }
    pub fn is_random_seam(&self) -> bool {
        self.sets.contains(&("seam_position", "random"))
    }
    /// `--only` token: a key, a full `key=value`, or the whole variation name.
    pub fn matches(&self, tok: &str) -> bool {
        self.name == tok || self.sets.iter().any(|(k, v)| *k == tok || format!("{k}={v}") == tok)
    }
}

/// Process-level keys only: the local server applies `set=` to the PROCESS preset, so filament/printer keys
/// (`filament_flow_ratio`, `retraction_length`, `fan_max_speed`) cannot be varied through it and are deliberately
/// absent (measured 2026-10-14: Orca output byte-identical to baseline, i.e. silently ignored).
/// Every value differs from the preset default (a value equal to the default is a no-op and proves nothing); the
/// driver additionally flags any variation whose Orca G-code is identical to the baseline as NOOP.
pub fn variations() -> Vec<Variation> {
    let mut v: Vec<Variation> = Vec::new();
    let one = |v: &mut Vec<Variation>, k: &'static str, x: &'static str| v.push(Variation::of(&[(k, x)]));
    for (k, x) in [("layer_height", "0.1"), ("layer_height", "0.28"), ("initial_layer_print_height", "0.3"), ("wall_loops", "1"), ("wall_loops", "3"), ("wall_loops", "4"),
        ("sparse_infill_density", "5%"), ("sparse_infill_density", "25%"), ("sparse_infill_density", "50%"), ("sparse_infill_density", "100%")] {
        one(&mut v, k, x);
    }
    for p in ["grid", "rectilinear", "line", "triangles", "cubic", "gyroid", "honeycomb", "concentric", "zigzag", "lightning", "adaptivecubic", "quartercubic", "alignedrectilinear", "tpmsd"] {
        one(&mut v, "sparse_infill_pattern", p);
    }
    v.push(Variation::of(&[("top_shell_layers", "2"), ("top_shell_thickness", "0")]));
    one(&mut v, "top_shell_layers", "7");
    v.push(Variation::of(&[("bottom_shell_layers", "1"), ("bottom_shell_thickness", "0")]));
    one(&mut v, "bottom_shell_layers", "5");
    for (k, x) in [("outer_wall_line_width", "0.35"), ("outer_wall_line_width", "0.5"), ("inner_wall_line_width", "0.5"), ("sparse_infill_line_width", "0.5"),
        ("internal_solid_infill_line_width", "0.5"), ("top_surface_line_width", "0.5"), ("initial_layer_line_width", "0.6"),
        ("infill_wall_overlap", "0%"), ("infill_wall_overlap", "50%"), ("top_bottom_infill_wall_overlap", "0%"),
        ("seam_position", "aligned_back"), ("seam_position", "back"), ("seam_position", "random"), ("seam_position", "nearest"),
        ("wall_sequence", "outer wall/inner wall"), ("wall_sequence", "inner-outer-inner wall"),
        ("top_surface_pattern", "monotonic"), ("top_surface_pattern", "concentric"), ("bottom_surface_pattern", "concentric"), ("bottom_surface_pattern", "monotonicline"),
        ("ironing_type", "top"), ("ironing_type", "solid"), ("wall_generator", "arachne"), ("detect_thin_wall", "1"), ("spiral_mode", "1"),
        ("raft_layers", "2"), ("skirt_loops", "3"), ("skirt_loops", "0"), ("brim_type", "outer_only"), ("brim_type", "outer_and_inner"),
        ("reduce_infill_retraction", "0"), ("z_hop", "0"), ("z_hop", "0.8"), ("reduce_crossing_wall", "1"),
        ("fuzzy_skin", "external"), ("fuzzy_skin", "all"),
        ("xy_contour_compensation", "0.1"), ("elefant_foot_compensation", "0.2"), ("infill_anchor", "0"), ("infill_direction", "0"), ("infill_direction", "90"),
        ("bridge_flow", "0.8"), ("detect_overhang_wall", "0"), ("only_one_wall_top", "0"), ("ensure_vertical_shell_thickness", "none"), ("enable_arc_fitting", "0"),
        ("outer_wall_speed", "40"), ("sparse_infill_speed", "120"), ("bridge_speed", "30"), ("enable_overhang_speed", "0")] {
        one(&mut v, k, x);
    }
    v.push(Variation::of(&[("brim_type", "outer_only"), ("brim_width", "8")]));
    v.push(Variation::of(&[("enable_support", "1")]));
    v.push(Variation::of(&[("enable_support", "1"), ("support_style", "grid")]));
    v.push(Variation::of(&[("enable_support", "1"), ("support_style", "snug")]));
    v.push(Variation::of(&[("enable_support", "1"), ("support_threshold_angle", "60")]));
    v.push(Variation::of(&[("enable_support", "1"), ("support_on_build_plate_only", "1")]));
    v.push(Variation::of(&[("enable_support", "1"), ("support_base_pattern", "rectilinear-grid")]));
    v.push(Variation::of(&[("enable_support", "1"), ("support_interface_top_layers", "0")]));
    v
}

/// The small, fast subset used by `--matrix --quick` (by variation name).
pub fn is_quick(name: &str) -> bool {
    matches!(
        name,
        "layer_height=0.28" | "wall_loops=3" | "sparse_infill_density=50%" | "sparse_infill_pattern=rectilinear" | "top_shell_layers=7" | "outer_wall_line_width=0.5"
            | "infill_wall_overlap=0%" | "seam_position=back" | "skirt_loops=3" | "enable_support=1" | "ironing_type=top" | "wall_generator=arachne"
    )
}

#[derive(Clone, Debug, Serialize)]
pub struct CaseResult {
    pub model: String,
    /// "baseline" or "key=value".
    pub variation: String,
    pub verdict: Status,
    /// Why this verdict, e.g. the worst row, or "ours not available".
    pub detail: String,
    /// Set when Orca (the reference) itself failed: counts as PENDING in the exit code but is listed apart.
    pub orca_error: bool,
    /// Orca's G-code for this variation is motion-identical to the baseline of the same model: the variation
    /// changed nothing (default value, ignored key), so this case adds no evidence.
    pub noop: bool,
    pub report: Option<Report>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MatrixSummary {
    pub variations: usize,
    pub models: usize,
    /// variations (incl. baseline) x models, PLANNED. `cases.len()` must equal this.
    pub population: usize,
    pub pass: usize,
    pub warn: usize,
    pub fail: usize,
    pub pending: usize,
    pub orca_error: usize,
    pub noop: usize,
    pub cases: Vec<CaseResult>,
}

impl MatrixSummary {
    pub fn new(variations: usize, models: usize, cases: Vec<CaseResult>) -> Self {
        let c = |s: Status| cases.iter().filter(|r| r.verdict == s && !r.orca_error).count();
        MatrixSummary {
            variations,
            models,
            population: variations * models,
            pass: c(Status::Pass),
            warn: c(Status::Warn),
            fail: c(Status::Fail),
            pending: c(Status::Pending),
            orca_error: cases.iter().filter(|r| r.orca_error).count(),
            noop: cases.iter().filter(|r| r.noop).count(),
            cases,
        }
    }
    /// 0 only when the population is non-empty, every planned case was evaluated, and all are PASS/WARN.
    /// FAIL -> 1. Anything that could not run (PENDING, Orca error, empty or short population) -> 2.
    pub fn exit_code(&self) -> i32 {
        if self.fail > 0 {
            1
        } else if self.population == 0 || self.cases.len() != self.population || self.pending > 0 || self.orca_error > 0 || self.pass + self.warn != self.population {
            2
        } else {
            0
        }
    }
    pub fn verdict(&self) -> &'static str {
        match self.exit_code() {
            0 if self.warn > 0 => "WARN",
            0 => "PASS",
            1 => "FAIL",
            _ => "PENDING",
        }
    }
    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        v["verdict"] = serde_json::Value::String(self.verdict().into());
        v["exit_code"] = serde_json::Value::from(self.exit_code());
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_files_pass_with_nonzero_population() {
        let g = synthetic_gcode(6, 20.0);
        let r = compare_text(&g, &g, &Options::default()).unwrap();
        assert_eq!(r.verdict, Status::Pass, "{}", render_table(&r, false));
        assert!(r.population.judged_rows > 20, "population size must be reported and non-trivial");
        assert_eq!(r.exit_code(), 0);
        assert_eq!(r.fail + r.pending, 0);
    }

    #[test]
    fn planted_15pct_wall_length_fails() {
        let g = synthetic_gcode(6, 20.0);
        let planted = plant_wall_scale(&g, 1.15);
        let a = parse(&planted).unwrap();
        let o = parse(&g).unwrap();
        let ratio = a.features["Outer wall"].path_mm / o.features["Outer wall"].path_mm;
        assert!((ratio - 1.15).abs() < 1e-3, "plant must grow outer wall length by 15%, got {ratio}");
        let ratio_i = a.features["Inner wall"].path_mm / o.features["Inner wall"].path_mm;
        assert!((ratio_i - 1.15).abs() < 1e-3);
        // infill is untouched by the plant
        assert!((a.features["Sparse infill"].path_mm - o.features["Sparse infill"].path_mm).abs() < 1e-6);
        let r = compare(&o, &a, &Options::default());
        assert_eq!(r.verdict, Status::Fail, "{}", render_table(&r, false));
        assert_eq!(r.row("feature:Outer wall", "path_mm").unwrap().status, Status::Fail);
        assert_eq!(r.exit_code(), 1);
        // the control is sensitive: +2 % must pass, +5 % must warn
        let s2 = parse(&plant_wall_scale(&g, 1.02)).unwrap();
        assert_eq!(compare(&o, &s2, &Options::default()).row("feature:Outer wall", "path_mm").unwrap().status, Status::Pass);
        let s5 = parse(&plant_wall_scale(&g, 1.05)).unwrap();
        assert_eq!(compare(&o, &s5, &Options::default()).row("feature:Outer wall", "path_mm").unwrap().status, Status::Warn);
    }

    #[test]
    fn absolute_e_plant_also_detected() {
        let g = synthetic_gcode(4, 20.0).replace("M83\n", "M82\nG92 E0\n");
        // make E absolute: rewrite each E word as a running sum
        let mut sum = 0.0;
        let mut out = String::new();
        for l in g.lines() {
            let (code, c) = split_code(l);
            let mut toks: Vec<String> = Vec::new();
            for t in code.split_ascii_whitespace() {
                if let (true, Some(v)) = (t.starts_with('E'), t[1..].parse::<f64>().ok()) {
                    sum += v;
                    toks.push(format!("E{}", fnum(sum)));
                } else {
                    toks.push(t.into());
                }
            }
            out += &format!("{}{}\n", toks.join(" "), c);
        }
        let o = parse(&out).unwrap();
        let a = parse(&plant_wall_scale(&out, 1.15)).unwrap();
        let ratio = a.features["Outer wall"].e_mm / o.features["Outer wall"].e_mm;
        assert!((ratio - 1.15).abs() < 1e-2, "absolute-E plant: {ratio}");
    }

    #[test]
    fn missing_feature_is_fail_never_skipped() {
        let g = synthetic_gcode(6, 20.0);
        let dropped = plant_drop_feature(&g, "Sparse infill");
        let r = compare_text(&g, &dropped, &Options::default()).unwrap();
        assert_eq!(r.verdict, Status::Fail);
        let row = r.row("feature:Sparse infill", "path_mm").unwrap();
        assert_eq!(row.status, Status::Fail);
        assert!(row.note.contains("MISSING IN OURS"), "{}", row.note);
        // and the reverse direction
        let r2 = compare_text(&dropped, &g, &Options::default()).unwrap();
        assert!(r2.row("feature:Sparse infill", "path_mm").unwrap().note.contains("ABSENT IN ORCA"));
    }

    #[test]
    fn tiny_feature_under_floor_does_not_trip() {
        let a = rel_row("g", "m", Some(1.0), Some(1.9), 2.0, &Tol::default());
        assert_eq!(a.status, Status::Pass);
        let b = rel_row("g", "m", Some(100.0), Some(103.0), 2.0, &Tol::default());
        assert_eq!(b.status, Status::Pass);
        let c = rel_row("g", "m", Some(100.0), Some(110.0), 2.0, &Tol::default());
        assert_eq!(c.status, Status::Warn);
        let d = rel_row("g", "m", Some(100.0), Some(110.1), 2.0, &Tol::default());
        assert_eq!(d.status, Status::Fail);
    }

    #[test]
    fn missing_data_is_pending_never_pass() {
        assert_eq!(rel_row("g", "m", Some(1.0), None, 0.0, &Tol::default()).status, Status::Pending);
        assert_eq!(exact_row("g", "m", None, None, 0.0).status, Status::Pending);
        // ours without LINE_WIDTH annotations -> width rows PENDING -> verdict PENDING
        let g = synthetic_gcode(5, 20.0);
        let nowidth: String = g.lines().filter(|l| !l.starts_with("; LINE_WIDTH")).map(|l| format!("{l}\n")).collect();
        let r = compare_text(&g, &nowidth, &Options::default()).unwrap();
        assert_eq!(r.row("feature:Outer wall", "width_mean").unwrap().status, Status::Pending);
        assert_eq!(r.verdict, Status::Pending);
        assert_eq!(r.exit_code(), 2);
    }

    #[test]
    fn speed_fan_retraction_bbox_controls_each_fail() {
        let g = synthetic_gcode(8, 20.0);
        let o = Options::default();
        let r = compare_text(&g, &plant_scale_speed(&g, "Inner wall", 0.5), &o).unwrap();
        assert_eq!(r.row("feature:Inner wall", "speed_max").unwrap().status, Status::Fail, "{}", render_table(&r, false));
        let r = compare_text(&g, &plant_strip_lines(&g, "M106"), &o).unwrap();
        assert_eq!(r.row("fan", "commands").unwrap().status, Status::Fail);
        assert_eq!(r.row("fan", "distinct_S_values").unwrap().status, Status::Fail);
        let r = compare_text(&g, &plant_strip_lines(&g, "G1 E-"), &o).unwrap();
        assert_eq!(r.row("retraction", "count").unwrap().status, Status::Fail);
        let r = compare_text(&g, &plant_wall_scale(&g, 1.15), &o).unwrap();
        assert_eq!(r.row("bbox", "xmax").unwrap().status, Status::Fail, "wall growth must move the bbox");
        let hop_gone: String = g.lines().filter(|l| !(l.starts_with("G1 Z") && !l.contains("F600") )).map(|l| format!("{l}\n")).collect();
        let r = compare_text(&g, &hop_gone, &o).unwrap();
        assert_eq!(r.row("zhop", "count").unwrap().status, Status::Fail, "{}", render_table(&r, false));
    }

    #[test]
    fn layer_z_shift_and_count_fail() {
        let g = synthetic_gcode(6, 20.0);
        let r = compare_text(&g, &plant_z_shift(&g, 0.05), &Options::default()).unwrap();
        assert_eq!(r.row("layers", "z_max_abs_diff").unwrap().status, Status::Fail);
        let fewer = synthetic_gcode(5, 20.0);
        let r = compare_text(&g, &fewer, &Options::default()).unwrap();
        assert_eq!(r.row("layers", "count").unwrap().status, Status::Fail);
    }

    #[test]
    fn empty_matrix_population_is_pending_not_pass() {
        let m = MatrixSummary::new(0, 3, vec![]);
        assert_eq!(m.population, 0);
        assert_eq!(m.exit_code(), 2);
        assert_eq!(m.verdict(), "PENDING");
        // a short population (planned 4, evaluated 3) is also not a pass
        let mk = |v| CaseResult { model: "m".into(), variation: "baseline".into(), verdict: v, detail: String::new(), orca_error: false, noop: false, report: None };
        let m = MatrixSummary::new(2, 2, vec![mk(Status::Pass), mk(Status::Pass), mk(Status::Pass)]);
        assert_eq!(m.exit_code(), 2);
        let m = MatrixSummary::new(2, 2, vec![mk(Status::Pass), mk(Status::Pass), mk(Status::Warn), mk(Status::Pass)]);
        assert_eq!(m.exit_code(), 0);
        assert_eq!(m.verdict(), "WARN");
        let m = MatrixSummary::new(1, 2, vec![mk(Status::Pass), mk(Status::Fail)]);
        assert_eq!(m.exit_code(), 1);
        let m = MatrixSummary::new(1, 2, vec![mk(Status::Pass), mk(Status::Pending)]);
        assert_eq!(m.exit_code(), 2);
    }

    #[test]
    fn report_over_zero_judged_rows_is_pending() {
        let mut o = Options::default();
        o.skip = vec![
            "layers".into(), "bbox".into(), "retraction".into(), "zhop".into(), "seam".into(), "fan".into(), "header".into(), "feature".into(),
        ];
        let g = synthetic_gcode(3, 20.0);
        let r = compare_text(&g, &g, &o).unwrap();
        assert_eq!(r.population.judged_rows, 0);
        assert_eq!(r.verdict, Status::Pending);
    }

    #[test]
    fn seam_position_judged_and_random_mode_info() {
        let g = synthetic_gcode(4, 20.0);
        // move every outer-wall start by 5 mm: rewrite the first outer-wall travel (X10 Y10) to X15
        let shifted = g.replace("; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 X10 Y10 F9000", "; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 X15 Y10 F9000");
        let r = compare_text(&g, &shifted, &Options::default()).unwrap();
        assert_eq!(r.row("seam", "position_match").unwrap().status, Status::Fail);
        let mut o = Options::default();
        o.judge_seam_pos = false;
        let r = compare_text(&g, &shifted, &o).unwrap();
        assert_eq!(r.row("seam", "position_match").unwrap().status, Status::Info);
    }

    fn stl_volume(b: &[u8]) -> f64 {
        let n = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as usize;
        assert_eq!(b.len(), 84 + 50 * n);
        let mut vol = 0.0;
        for t in 0..n {
            let o = 84 + t * 50 + 12;
            let f = |i: usize| f32::from_le_bytes([b[o + 4 * i], b[o + 4 * i + 1], b[o + 4 * i + 2], b[o + 4 * i + 3]]) as f64;
            let (p0, p1, p2) = ([f(0), f(1), f(2)], [f(3), f(4), f(5)], [f(6), f(7), f(8)]);
            vol += (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6.0;
        }
        vol
    }

    #[test]
    fn stl_tbar_volume_and_edges_closed() {
        let b = stl_tbar();
        assert!((stl_volume(&b) - 5000.0).abs() < 1e-3, "{}", stl_volume(&b));
        // closed 2-manifold: every undirected edge is used by exactly two triangles
        let n = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as usize;
        let mut edges: BTreeMap<([i64; 3], [i64; 3]), usize> = BTreeMap::new();
        for t in 0..n {
            let o = 84 + t * 50 + 12;
            let p = |i: usize| -> [i64; 3] { let f = |k: usize| (f32::from_le_bytes([b[o + 12 * i + 4 * k], b[o + 12 * i + 4 * k + 1], b[o + 12 * i + 4 * k + 2], b[o + 12 * i + 4 * k + 3]]) * 1000.0).round() as i64; [f(0), f(1), f(2)] };
            for (a, c) in [(0, 1), (1, 2), (2, 0)] {
                let (x, y) = (p(a), p(c));
                *edges.entry(if x < y { (x, y) } else { (y, x) }).or_insert(0) += 1;
            }
        }
        assert!(edges.values().all(|c| *c == 2), "open edges: {}", edges.values().filter(|c| **c != 2).count());
    }

    #[test]
    fn stl_cube_volume() {
        for (s, h) in [(20.0, 0.0), (20.0, 8.0)] {
            let b = stl_cube(s, h);
            let n = u32::from_le_bytes([b[80], b[81], b[82], b[83]]) as usize;
            assert_eq!(b.len(), 84 + 50 * n);
            let mut vol = 0.0;
            for t in 0..n {
                let o = 84 + t * 50 + 12;
                let f = |i: usize| f32::from_le_bytes([b[o + 4 * i], b[o + 4 * i + 1], b[o + 4 * i + 2], b[o + 4 * i + 3]]) as f64;
                let (p0, p1, p2) = ([f(0), f(1), f(2)], [f(3), f(4), f(5)], [f(6), f(7), f(8)]);
                vol += (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6.0;
            }
            let want = s * s * s - h * h * s;
            assert!((vol - want).abs() < 1e-3, "volume {vol} want {want} (hole {h}): triangles must be outward-wound");
        }
    }

    #[test]
    fn variation_list_is_unique_and_covers_the_asked_areas() {
        let v = variations();
        let set: BTreeSet<_> = v.iter().map(|x| x.name.clone()).collect();
        assert_eq!(set.len(), v.len());
        for k in ["layer_height", "wall_loops", "outer_wall_line_width", "top_shell_layers", "sparse_infill_density", "sparse_infill_pattern", "seam_position", "z_hop", "enable_support", "ironing_type", "fuzzy_skin", "wall_generator", "brim_type", "skirt_loops"] {
            assert!(v.iter().any(|x| x.sets_key(k)), "missing variation key {k}");
        }
    }
}
