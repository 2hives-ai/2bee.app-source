//! Lane 9: reconstruct per-layer path lists (`types::LayerPlan`) from a G-code text, so a post-processor can be run on, and
//! compared against, the ordering OrcaSlicer itself produced.
//!
//! What is reconstructed: every continuous run of extruding moves with the same `; FEATURE:` becomes one `ExtPath`
//! (polyline; arcs G2/G3 are flattened to <= 3 degree chords, which is geometry-preserving to < 0.01 mm at 10 mm radius).
//! Any move without extrusion (travel, wipe, z-hop) ends the path. `; LINE_WIDTH:` gives the width, `; CHANGE_LAYER` starts a layer.
//! What is NOT reconstructed: retraction/wipe/z-hop moves themselves (a model of them is in `pathopt`), fan, temperature, accel.
//! Nothing before the first `; CHANGE_LAYER` (start G-code, purge line) is included.
use crate::types::{ExtPath, Feature, FdmError, LayerPlan, PathPt};

pub fn feature_from_orca(name: &str) -> Option<Feature> {
    use Feature::*;
    [OuterWall, InnerWall, OverhangWall, SparseInfill, InternalSolidInfill, TopSurface, BottomSurface, InternalBridge, Bridge, GapInfill, Skirt, Brim, Support,
     SupportInterface, SupportTransition, Ironing, PrimeTower, Custom].into_iter().find(|f| f.orca_name().eq_ignore_ascii_case(name.trim()))
}

#[derive(Clone, Debug, Default)]
pub struct Recon {
    pub plans: Vec<LayerPlan>,
    /// Position where the first layer's first path begins is `plans[0]`'s first point; this is the last position before it.
    pub start_xy: [f64; 2],
    pub extruding_moves: usize,
    pub lines: usize,
    /// `retracted_before[layer][path]`: Orca issued a retraction (a negative E move) between the previous path and this one.
    pub retracted_before: Vec<Vec<bool>>,
}

fn num(t: &str) -> Option<f64> { t.parse::<f64>().ok() }

pub fn plan_from_gcode(text: &str) -> Result<Recon, FdmError> {
    let mut rec = Recon::default();
    let (mut x, mut y, mut z) = (0.0f64, 0.0f64, 0.0f64);
    let mut e_rel = true; // Bambu/Orca: M83. M82 switches
    let mut e_pos = 0.0f64;
    let mut feature = Feature::Custom;
    let mut width = 0.42f64;
    let mut layer_h = 0.2f64;
    let mut in_layers = false;
    let mut cur: Option<ExtPath> = None;
    let mut first_start: Option<[f64; 2]> = None;
    let mut last_xy_before_first = [0.0, 0.0];
    let mut ret_flag = false;
    let flush = |cur: &mut Option<ExtPath>, rec: &mut Recon| {
        if let Some(p) = cur.take() { if p.pts.len() >= 2 { if let Some(l) = rec.plans.last_mut() { l.paths.push(p); } } }
    };
    for raw in text.lines() {
        rec.lines += 1;
        let (code, comment) = match raw.find(';') { Some(i) => (&raw[..i], Some(raw[i + 1..].trim())), None => (raw, None) };
        if let Some(c) = comment {
            if c == "CHANGE_LAYER" { flush(&mut cur, &mut rec); in_layers = true; rec.plans.push(LayerPlan { z, h: layer_h, paths: vec![] }); rec.retracted_before.push(vec![]); }
            else if let Some(v) = c.strip_prefix("FEATURE:") { flush(&mut cur, &mut rec); feature = feature_from_orca(v).ok_or_else(|| FdmError::Parse(format!("unknown ; FEATURE: '{}'", v.trim())))?; }
            else if let Some(v) = c.strip_prefix("LINE_WIDTH:") { if let Some(w) = num(v.trim()) { if (w - width).abs() > 1e-9 { flush(&mut cur, &mut rec); } width = w; } }
            else if let Some(v) = c.strip_prefix("Z_HEIGHT:") { if let Some(zz) = num(v.trim()) { z = zz; if let Some(l) = rec.plans.last_mut() { if l.paths.is_empty() { l.z = zz; } } } }
            else if let Some(v) = c.strip_prefix("LAYER_HEIGHT:") { if let Some(h) = num(v.trim()) { layer_h = h; if let Some(l) = rec.plans.last_mut() { if l.paths.is_empty() { l.h = h; } } } }
        }
        let code = code.trim();
        if code.is_empty() { continue; }
        let mut toks = code.split_ascii_whitespace();
        let cmd = toks.next().unwrap_or("").to_ascii_uppercase();
        let mut w: [Option<f64>; 26] = [None; 26];
        for t in toks { let b = t.as_bytes(); if !b[0].is_ascii_alphabetic() { continue; } w[(b[0].to_ascii_uppercase() - b'A') as usize] = num(&t[1..]); }
        let g = |c: char| w[(c as u8 - b'A') as usize];
        match cmd.as_str() {
            "M82" => e_rel = false,
            "M83" => e_rel = true,
            "G92" => { if let Some(v) = g('E') { e_pos = v; } if let Some(v) = g('X') { x = v; } if let Some(v) = g('Y') { y = v; } if let Some(v) = g('Z') { z = v; } }
            "G20" => return Err(FdmError::Unsupported("inches".into())),
            "G0" | "G1" | "G2" | "G3" => {
                let (nx, ny) = (g('X').unwrap_or(x), g('Y').unwrap_or(y));
                let de = match g('E') { Some(v) => if e_rel { v } else { let d = v - e_pos; e_pos = v; d }, None => 0.0 };
                if let (Some(_), true) = (g('E'), e_rel) { e_pos += de; }
                if let Some(nz) = g('Z') { z = nz; }
                let moved = (nx - x).abs() > 1e-12 || (ny - y).abs() > 1e-12;
                let arc = cmd == "G2" || cmd == "G3";
                // geometry of this move as a polyline (excluding the start point)
                let mut pts: Vec<[f64; 2]> = vec![];
                if arc && (g('I').is_some() || g('J').is_some()) {
                    let (cx, cy) = (x + g('I').unwrap_or(0.0), y + g('J').unwrap_or(0.0));
                    let r = (x - cx).hypot(y - cy);
                    let a0 = (y - cy).atan2(x - cx);
                    let mut a1 = (ny - cy).atan2(nx - cx);
                    let ccw = cmd == "G3";
                    let tau = std::f64::consts::TAU;
                    let mut sweep = if ccw { a1 - a0 } else { a0 - a1 };
                    while sweep <= 1e-9 { sweep += tau; }
                    if !moved { sweep = tau; } // full circle
                    let n = ((sweep.to_degrees() / 3.0).ceil() as usize).max(1);
                    for k in 1..=n { a1 = if ccw { a0 + sweep * k as f64 / n as f64 } else { a0 - sweep * k as f64 / n as f64 }; pts.push([cx + r * a1.cos(), cy + r * a1.sin()]); }
                    if let Some(l) = pts.last_mut() { *l = [nx, ny]; }
                } else if moved { pts.push([nx, ny]); }
                if de < -1e-9 { ret_flag = true; }
                let extruding = de > 1e-12 && (moved || arc) && in_layers && !pts.is_empty();
                if extruding {
                    rec.extruding_moves += 1;
                    if cur.is_none() {
                        if let Some(r) = rec.retracted_before.last_mut() { r.push(ret_flag); }
                        ret_flag = false;
                        cur = Some(ExtPath { feature, pts: vec![PathPt { x, y, w: width }], closed: false, layer_h, speed: 0.0, flow_ratio: 1.0 });
                        if first_start.is_none() { first_start = Some([x, y]); rec.start_xy = last_xy_before_first; }
                    }
                    if let Some(p) = cur.as_mut() { for q in &pts { p.pts.push(PathPt { x: q[0], y: q[1], w: width }); } }
                } else {
                    flush(&mut cur, &mut rec);
                    if first_start.is_none() { last_xy_before_first = [nx, ny]; }
                }
                x = nx; y = ny;
            }
            _ => {}
        }
    }
    flush(&mut cur, &mut rec);
    // close loops that really close
    for l in &mut rec.plans { for p in &mut l.paths { if p.pts.len() > 3 { let (a, b) = (p.pts[0], p.pts[p.pts.len() - 1]); if (a.x - b.x).hypot(a.y - b.y) < 1e-6 { p.closed = true; p.pts.pop(); } } } }
    let keep: Vec<bool> = rec.plans.iter().map(|l| !l.paths.is_empty()).collect();
    let mut it = keep.iter(); rec.plans.retain(|_| *it.next().unwrap());
    let mut it = keep.iter(); rec.retracted_before.retain(|_| *it.next().unwrap());
    debug_assert!(rec.plans.iter().zip(&rec.retracted_before).all(|(l, r)| l.paths.len() == r.len()));
    if rec.plans.is_empty() { return Err(FdmError::Parse("no extruding layer moves found (no '; CHANGE_LAYER' / no extrusion)".into())); }
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn paths_arcs_and_features() {
        let g = "M83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; LAYER_HEIGHT: 0.2\nG1 X0 Y0 F9000\n; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 X10 Y0 E.5\nG1 X10 Y10 E.5\nG1 E-.4\nG1 X20 Y20\n; FEATURE: Sparse infill\nG1 X30 Y20 E.5\nG3 X30 Y20 I-5 J0 E1\n";
        let r = plan_from_gcode(g).unwrap();
        assert_eq!(r.plans.len(), 1);
        let p = &r.plans[0].paths;
        assert_eq!(p.len(), 2, "paths: {}", p.len());
        assert_eq!(p[0].feature, Feature::OuterWall); assert_eq!(p[0].pts.len(), 3);
        assert_eq!(p[1].feature, Feature::SparseInfill);
        // full circle radius 5 flattened at 3 degrees: 120 chords, length close to 2*pi*5
        let len: f64 = p[1].pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum();
        assert!((len - 10.0 - 31.4159).abs() < 0.05, "{len}");
    }
    #[test] fn empty_is_an_error_not_a_pass() { assert!(plan_from_gcode("G1 X1 Y1 E1\n").is_err()); }
}
