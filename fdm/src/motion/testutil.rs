//! Test-only helpers: turn an Orca G-code file back into `LayerPlan`s (so the motion/G-code lane can be exercised on the
//! exact same extrusion paths Orca produced) and compute the handful of statistics the lane is judged on.
//! Independent of lane 8's parser on purpose, so these tests keep working while that module is being changed.

use std::collections::BTreeMap;

use crate::types::{ExtPath, Feature, LayerPlan, PathPt};

#[derive(Default, Debug, Clone)]
pub struct Stats {
    pub layers: usize,
    pub path_mm: BTreeMap<String, f64>,
    pub e_mm: BTreeMap<String, f64>,
    pub retractions: usize,
    pub retracted_mm: f64,
    pub extruded_mm: f64, // net filament
    pub zhop_moves: usize,
    pub travel_mm: f64,
    pub moves: usize,
}

fn word(t: &str, c: char) -> Option<f64> {
    for w in t.split_whitespace() {
        let mut it = w.chars();
        if it.next() == Some(c) { if let Ok(v) = w[1..].parse::<f64>() { return Some(v); } }
    }
    None
}

fn feature_from_name(n: &str) -> Option<Feature> {
    Some(match n {
        "Outer wall" => Feature::OuterWall, "Inner wall" => Feature::InnerWall, "Overhang wall" => Feature::OverhangWall,
        "Sparse infill" => Feature::SparseInfill, "Internal solid infill" => Feature::InternalSolidInfill,
        "Top surface" => Feature::TopSurface, "Bottom surface" => Feature::BottomSurface, "Internal Bridge" => Feature::InternalBridge,
        "Bridge" => Feature::Bridge, "Gap infill" => Feature::GapInfill, "Skirt" => Feature::Skirt, "Brim" => Feature::Brim,
        "Support" => Feature::Support, "Support interface" => Feature::SupportInterface, "Support transition" => Feature::SupportTransition,
        "Ironing" => Feature::Ironing, "Prime tower" => Feature::PrimeTower, "Custom" => Feature::Custom,
        _ => return None,
    })
}

/// Statistics of a G-code text (Orca's or ours): path length and net E by FEATURE, retraction count by E debt.
pub fn stats_of(text: &str) -> Stats {
    let mut st = Stats::default();
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let mut rel_e = false;
    let mut e_pos = 0.0f64;
    let mut feat = String::from("Custom");
    let mut debt = 0.0f64;
    let mut in_exec = false;
    let mut last_z_travel = 0.0f64;
    let mut layer = 0usize;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("; EXECUTABLE_BLOCK_START") { in_exec = true; }
        if line.starts_with("; EXECUTABLE_BLOCK_END") { in_exec = false; }
        if !in_exec { continue; }
        if line == "; CHANGE_LAYER" { layer += 1; }
        if line == "; MACHINE_START_GCODE_END" { debt = 0.0; }
        if let Some(f) = line.strip_prefix("; FEATURE: ") { feat = f.trim().to_string(); continue; }
        let code = line.split(';').next().unwrap().trim();
        if code.is_empty() { continue; }
        let cmd = code.split_whitespace().next().unwrap();
        match cmd {
            "M83" => rel_e = true,
            "M82" => rel_e = false,
            "G92" => { if let Some(e) = word(code, 'E') { e_pos = e; } }
            "G1" | "G0" | "G2" | "G3" => {
                let nx = word(code, 'X').unwrap_or(x); let ny = word(code, 'Y').unwrap_or(y); let nz = word(code, 'Z').unwrap_or(z);
                let de = match word(code, 'E') { Some(e) => if rel_e { e } else { let d = e - e_pos; e_pos = e; d }, None => 0.0 };
                let mut len = ((nx - x).powi(2) + (ny - y).powi(2)).sqrt();
                if cmd == "G2" || cmd == "G3" {
                    // arc length from I/J
                    let (i, j) = (word(code, 'I').unwrap_or(0.0), word(code, 'J').unwrap_or(0.0));
                    let (cx, cy) = (x + i, y + j);
                    let r = (i * i + j * j).sqrt();
                    let a0 = (y - cy).atan2(x - cx); let a1 = (ny - cy).atan2(nx - cx);
                    let mut da = a1 - a0;
                    if cmd == "G3" { if da <= 0.0 { da += 2.0 * std::f64::consts::PI; } } else if da >= 0.0 { da -= 2.0 * std::f64::consts::PI; }
                    if (nx - x).abs() < 1e-9 && (ny - y).abs() < 1e-9 { da = 2.0 * std::f64::consts::PI; }
                    len = da.abs() * r;
                }
                if de < 0.0 && (nx - x).abs() < 1e-9 && (ny - y).abs() < 1e-9 && (nz - z).abs() < 1e-9 {
                    st.retractions += 1; st.retracted_mm += -de; debt += -de;
                } else if de < 0.0 {
                    debt += -de; // wipe-while-retracting: counted as part of a retraction, not a new one
                    st.retracted_mm += -de;
                    st.retractions += 0;
                } else if de > 0.0 {
                    let pay = de.min(debt);
                    debt -= pay;
                    let ext = de - pay;
                    if ext > 1e-9 && len > 0.0 {
                        *st.path_mm.entry(feat.clone()).or_insert(0.0) += len;
                        *st.e_mm.entry(feat.clone()).or_insert(0.0) += ext;
                        st.extruded_mm += ext;
                    }
                } else if len > 0.0 || (nz - z).abs() > 1e-9 {
                    st.travel_mm += len;
                    if nz > z + 1e-9 && nz > last_z_travel - 1.0 && cmd != "G0" { st.zhop_moves += 1; }
                }
                if len > 0.0 || (nz - z).abs() > 0.0 { st.moves += 1; }
                x = nx; y = ny; z = nz;
                last_z_travel = z;
            }
            _ => {}
        }
    }
    st.layers = layer;
    st
}

/// Re-create `LayerPlan`s from the extrusion moves of an Orca file. Skirt / brim are dropped (the motion lane makes its
/// own); wipe moves and retractions are not extrusions. Wall loops whose end is within 0.1 mm of their start are marked
/// closed (Orca stops `seam_gap` short of the start).
pub fn plans_from_gcode(text: &str) -> Vec<LayerPlan> {
    let mut plans: Vec<LayerPlan> = Vec::new();
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let mut rel_e = false;
    let mut feat: Option<Feature> = None;
    let mut width = 0.42f64;
    let mut height = 0.2f64;
    let mut in_exec = false;
    let mut in_wipe = false;
    let mut cur: Option<ExtPath> = None;
    let mut z_pending: Option<f64> = None;
    let flush = |plans: &mut Vec<LayerPlan>, cur: &mut Option<ExtPath>| {
        if let Some(mut p) = cur.take() {
            if p.pts.len() >= 2 && !matches!(p.feature, Feature::Skirt | Feature::Brim | Feature::Custom) {
                let a = p.pts[0]; let b = *p.pts.last().unwrap();
                let walls = matches!(p.feature, Feature::OuterWall | Feature::InnerWall);
                if walls && p.pts.len() > 3 && ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt() < 0.1 { p.closed = true; p.pts.pop(); }
                if let Some(l) = plans.last_mut() { l.paths.push(p); }
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("; EXECUTABLE_BLOCK_START") { in_exec = true; }
        if line.starts_with("; EXECUTABLE_BLOCK_END") { in_exec = false; flush(&mut plans, &mut cur); }
        if !in_exec { continue; }
        if line == "; CHANGE_LAYER" { flush(&mut plans, &mut cur); plans.push(LayerPlan { z: 0.0, h: 0.2, paths: vec![] }); continue; }
        if let Some(v) = line.strip_prefix("; Z_HEIGHT: ") { z_pending = v.trim().parse().ok(); if let (Some(zv), Some(l)) = (z_pending, plans.last_mut()) { l.z = zv; } continue; }
        if let Some(v) = line.strip_prefix("; LAYER_HEIGHT: ") {
            if let Ok(h) = v.trim().parse::<f64>() { height = h; if let Some(l) = plans.last_mut() { if l.paths.is_empty() { l.h = h; } } }
            continue;
        }
        if let Some(v) = line.strip_prefix("; LINE_WIDTH: ") { if let Ok(w) = v.trim().parse::<f64>() { if (w - width).abs() > 1e-9 { flush(&mut plans, &mut cur); } width = w; } continue; }
        if let Some(f) = line.strip_prefix("; FEATURE: ") { flush(&mut plans, &mut cur); feat = feature_from_name(f.trim()); continue; }
        if line == "; WIPE_START" { in_wipe = true; continue; }
        if line == "; WIPE_END" { in_wipe = false; continue; }
        let code = line.split(';').next().unwrap().trim();
        if code.is_empty() { continue; }
        let cmd = code.split_whitespace().next().unwrap();
        match cmd {
            "M83" => rel_e = true,
            "G1" | "G0" | "G2" | "G3" => {
                let nx = word(code, 'X').unwrap_or(x); let ny = word(code, 'Y').unwrap_or(y);
                let de = word(code, 'E').unwrap_or(0.0);
                let extruding = rel_e && de > 0.0 && (nx != x || ny != y) && !in_wipe;
                if extruding {
                    // pure extrusion move; unretracts have no XY
                    let f = feat.unwrap_or(Feature::Custom);
                    let pts: Vec<(f64, f64)> = if cmd == "G2" || cmd == "G3" {
                        let (i, j) = (word(code, 'I').unwrap_or(0.0), word(code, 'J').unwrap_or(0.0));
                        let (cx, cy) = (x + i, y + j);
                        let r = (i * i + j * j).sqrt();
                        let a0 = (y - cy).atan2(x - cx); let a1 = (ny - cy).atan2(nx - cx);
                        let mut da = a1 - a0;
                        if cmd == "G3" { if da <= 0.0 { da += 2.0 * std::f64::consts::PI; } } else if da >= 0.0 { da -= 2.0 * std::f64::consts::PI; }
                        let n = ((da.abs() * r / 0.3).ceil() as usize).max(2);
                        (1..=n).map(|k| { let a = a0 + da * k as f64 / n as f64; (cx + r * a.cos(), cy + r * a.sin()) }).collect()
                    } else { vec![(nx, ny)] };
                    let continues = cur.as_ref().map_or(false, |c| { let l = c.pts.last().unwrap(); (l.x - x).abs() < 1e-3 && (l.y - y).abs() < 1e-3 && c.feature == f });
                    if !continues {
                        flush(&mut plans, &mut cur);
                        cur = Some(ExtPath { feature: f, pts: vec![PathPt { x, y, w: width }], closed: false, layer_h: height, speed: 0.0, flow_ratio: 1.0 });
                    }
                    for (px, py) in pts { cur.as_mut().unwrap().pts.push(PathPt { x: px, y: py, w: width }); }
                } else if cmd != "G3" || word(code, 'E').is_none() {
                    if !in_wipe || de >= 0.0 { flush(&mut plans, &mut cur); }
                }
                x = nx; y = ny;
            }
            _ => {}
        }
    }
    plans
}

/// Start points of every "Outer wall" run (the position the nozzle was at before the first extruding move of a loop).
pub fn outer_wall_starts(text: &str) -> Vec<Vec<(f64, f64)>> {
    let mut layers: Vec<Vec<(f64, f64)>> = Vec::new();
    let (mut x, mut y) = (f64::NAN, f64::NAN);
    let mut feat = String::new();
    let mut in_run = false;
    let mut run_end = (f64::NAN, f64::NAN);
    let mut in_exec = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("; EXECUTABLE_BLOCK_START") { in_exec = true; }
        if !in_exec { continue; }
        if line == "; CHANGE_LAYER" { layers.push(Vec::new()); in_run = false; continue; }
        if let Some(f) = line.strip_prefix("; FEATURE: ") { feat = f.trim().to_string(); in_run = false; continue; }
        if !(line.starts_with("G1 ") || line.starts_with("G2 ") || line.starts_with("G3 ")) { continue; }
        let code = line.split(';').next().unwrap();
        let nx = word(code, 'X').unwrap_or(x); let ny = word(code, 'Y').unwrap_or(y);
        let ext = word(code, 'E').map_or(false, |e| e > 0.0) && (nx != x || ny != y);
        if ext && feat == "Outer wall" {
            if !in_run || (run_end.0 - x).abs() > 1e-3 || (run_end.1 - y).abs() > 1e-3 {
                if let Some(l) = layers.last_mut() { l.push((x, y)); }
            }
            in_run = true; run_end = (nx, ny);
        } else if code.contains('X') || code.contains('Y') { in_run = false; }
        x = nx; y = ny;
    }
    layers
}

/// Fraction of Orca's outer-wall start points that also occur (within 0.02 mm) on the same layer of `ours`.
pub fn seam_match(orca: &str, ours: &str) -> (usize, usize) {
    let a = outer_wall_starts(orca); let b = outer_wall_starts(ours);
    let (mut tot, mut ok) = (0, 0);
    for (la, lb) in a.iter().zip(b.iter()) {
        for p in la { tot += 1; if lb.iter().any(|q| (q.0 - p.0).abs() < 0.02 && (q.1 - p.1).abs() < 0.02) { ok += 1; } }
    }
    (ok, tot)
}

/// Counts of the motion-planning line shapes in a G-code file: lift forms, retractions, unretractions, wipes.
/// Two files with the same signature made the same retract / z-hop / wipe decisions.
pub fn lift_signature(text: &str) -> BTreeMap<String, usize> {
    let mut c: BTreeMap<String, usize> = BTreeMap::new();
    let mut on = false;
    let mut bump = |k: &str| *c.entry(k.to_string()).or_insert(0) += 1;
    for l in text.lines() {
        if l.starts_with("; EXECUTABLE_BLOCK_START") { on = true; }
        if !on { continue; }
        let has_e = l.split_whitespace().any(|w| w.starts_with('E'));
        if l.starts_with("G1 Z") { bump("G1 Z"); }
        else if l.starts_with("G3 Z") || l.starts_with("G2 Z") { bump("spiral"); }
        else if l.starts_with("G1 X") && l.split_whitespace().any(|w| w.starts_with('Z')) && !has_e { bump("G1 XYZ"); }
        else if l.starts_with("G1 E-") { bump("retract"); }
        else if l.starts_with("G1 E") && !l.starts_with("G1 E-") && l.contains(" F") { bump("unretract"); }
        else if l == "; WIPE_START" { bump("wipe"); }
        else if l.starts_with("G1 X") && l.contains(" E-") { bump("wipe-retract-move"); }
    }
    c
}
