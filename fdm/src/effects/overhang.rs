//! Slowdown for overhangs: port of `ExtrusionQualityEstimator::estimate_extrusion_quality` and
//! `estimate_points_properties` (GCode/ExtrusionProcessor.hpp). For a wall (or bridge) path, the signed
//! distance of every point to the PREVIOUS layer's outline decides a per-point speed from the
//! `overhang_1_4_speed ... overhang_4_4_speed` / `bridge_speed` table, and extra points are inserted where
//! the path crosses the outline boundary so the speed changes at the right place.
//!
//! Output: a point list with the speed of the segment STARTING at each point (Orca writes
//! `pre_processed_point.speed` for segment i-1 -> i) and the `overlap` value the overhang fan logic reads.
//! Not ported: the `slowdown_for_curled_perimeters` branch (needs the support-spots curled-line analysis).
use super::adapter as g;
use crate::types::{ExtPath, Feature, PathPt, Polys};

type P = [f64; 2];
const EPS: f64 = 1e-4;

#[derive(Clone, Debug)]
pub struct OverhangSpeedConfig {
    /// enable_overhang_speed (also true if only the overhang FAN needs the geometry).
    pub enabled: bool,
    /// Absolute mm/s values of overhang_1_4_speed .. overhang_4_4_speed. Orca treats < 0.5 as "no limit" (100%).
    pub speed_1_4: f64,
    pub speed_2_4: f64,
    pub speed_3_4: f64,
    pub speed_4_4: f64,
    /// bridge_speed (mm/s), used for the 100%-overhang section.
    pub bridge_speed: f64,
}
impl Default for OverhangSpeedConfig {
    /// X2D profile: overhang_1_4_speed 0, 2_4 50, 3_4 30, 4_4 10, bridge_speed 50.
    fn default() -> Self { OverhangSpeedConfig { enabled: true, speed_1_4: 0.0, speed_2_4: 50.0, speed_3_4: 30.0, speed_4_4: 10.0, bridge_speed: 50.0 } }
}

/// Previous layer outline (Orca: `layer->lslices` of the layer below, unscaled lines).
#[derive(Clone, Debug, Default)]
pub struct LowerOutline {
    segs: Vec<(P, P)>,
    region: Polys,
}
impl LowerOutline {
    pub fn new(lslices: &Polys) -> Self {
        let mut segs = Vec::new();
        for q in lslices {
            for ring in std::iter::once(&q.contour).chain(q.holes.iter()) {
                let n = ring.len();
                for i in 0..n { segs.push((ring[i], ring[(i + 1) % n])); }
            }
        }
        LowerOutline { segs, region: lslices.clone() }
    }
    pub fn is_empty(&self) -> bool { self.segs.is_empty() }
    fn unsigned(&self, p: P) -> f64 {
        let mut best = f64::INFINITY;
        for (a, b) in &self.segs {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let t = if l2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) };
            let d2 = (a[0] + dx * t - p[0]).powi(2) + (a[1] + dy * t - p[1]).powi(2);
            if d2 < best { best = d2; }
        }
        best.sqrt()
    }
    /// Positive outside the previous layer (overhanging), negative inside.
    pub fn signed(&self, p: P) -> f64 {
        let d = self.unsigned(p);
        if d.is_infinite() { return f64::INFINITY; }
        if g::contains(&self.region, p[0], p[1]) { -d } else { d }
    }
    /// Intersections of segment a-b with the outline lines, sorted by distance from a.
    fn intersections(&self, a: P, b: P) -> Vec<P> {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let mut ts: Vec<f64> = Vec::new();
        for (c, d) in &self.segs {
            let (ex, ey) = (d[0] - c[0], d[1] - c[1]);
            let den = dx * ey - dy * ex;
            if den.abs() < 1e-18 { continue; }
            let t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den;
            let u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) { ts.push(t); }
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
        ts.into_iter().map(|t| [a[0] + dx * t, a[1] + dy * t]).collect()
    }
}

#[derive(Clone, Copy, Debug)]
struct Ext { pos: P, distance: f64 }

/// `estimate_points_properties<true, true, true, true>` (distances only; curvature is not consumed downstream).
fn estimate_points(input: &[P], prev: &LowerOutline, flow_width: f64, min_distance: f64) -> Vec<Ext> {
    if input.is_empty() { return vec![]; }
    let min_spacing = flow_width * 0.25;
    let bo = 0.5 * flow_width;
    let mut pts: Vec<Ext> = Vec::with_capacity(input.len() * 2);
    pts.push(Ext { pos: input[0], distance: prev.signed(input[0]) + bo });
    for i in 1..input.len() {
        let next = Ext { pos: input[i], distance: prev.signed(input[i]) + bo };
        let back = *pts.last().unwrap();
        if (back.distance > bo + EPS) != (next.distance > bo + EPS) {
            for x in prev.intersections(back.pos, next.pos) {
                let d1 = (x[0] - back.pos[0]).hypot(x[1] - back.pos[1]);
                let d2 = (next.pos[0] - x[0]).hypot(next.pos[1] - x[1]);
                if d1 > min_spacing && d2 > min_spacing { pts.push(Ext { pos: x, distance: bo }); }
            }
        }
        pts.push(next);
    }
    // segmentation near the boundary
    let mut out: Vec<Ext> = Vec::with_capacity(pts.len() * 2);
    out.push(pts[0]);
    for k in 0..pts.len() - 1 {
        let (curr, next) = (pts[k], pts[k + 1]);
        if (curr.distance > -bo && curr.distance < bo + 2.0) || (next.distance > -bo && next.distance < bo + 2.0) {
            let len = (next.pos[0] - curr.pos[0]).hypot(next.pos[1] - curr.pos[1]);
            if (min_distance > 0.0 && (curr.distance.abs() > min_distance || next.distance.abs() > min_distance) && len >= 2.0) || (min_distance <= 0.0 && len > 4.0) {
                let a0 = ((curr.distance + 3.0 * bo) / len).clamp(0.0, 1.0);
                let a1 = (1.0 - (next.distance + 3.0 * bo) / len).clamp(0.0, 1.0);
                let (t0, t1) = (a0.min(a1), a0.max(a1));
                let at = |t: f64| [curr.pos[0] + t * (next.pos[0] - curr.pos[0]), curr.pos[1] + t * (next.pos[1] - curr.pos[1])];
                if t0 < 1.0 {
                    let p0 = at(t0);
                    let d0 = prev.signed(p0);
                    if d0.abs() > min_distance || min_distance <= 0.0 {
                        if (p0[0] - curr.pos[0]).hypot(p0[1] - curr.pos[1]) > min_spacing && (next.pos[0] - p0[0]).hypot(next.pos[1] - p0[1]) > min_spacing {
                            out.push(Ext { pos: p0, distance: d0 + bo });
                        }
                    }
                }
                if t1 > 0.0 {
                    let p1 = at(t1);
                    let d1 = prev.signed(p1);
                    if d1.abs() > min_distance || min_distance <= 0.0 {
                        if (p1[0] - curr.pos[0]).hypot(p1[1] - curr.pos[1]) > min_spacing && (next.pos[0] - p1[0]).hypot(next.pos[1] - p1[1]) > min_spacing {
                            out.push(Ext { pos: p1, distance: d1 + bo });
                        }
                    }
                }
            }
        }
        out.push(next);
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProcessedPoint {
    pub x: f64,
    pub y: f64,
    /// mm/s for the segment that STARTS at this point.
    pub speed: f64,
    /// `1 - distance/width` (what the overhang fan thresholds read).
    pub overlap: f64,
}

/// Port of `estimate_extrusion_quality` for the non-curled branch. `overlaps` are percents (90,75,50,25,13,0);
/// `speeds` are the matching ABSOLUTE speeds (mm/s) before sorting; `ref_speed` is the external (or inner) wall speed.
pub fn estimate_extrusion_quality(pts: &[PathPt], width: f64, prev: &LowerOutline, overlaps: &[f64], speeds: &[f64], original_speed: f64) -> Vec<ProcessedPoint> {
    let m = overlaps.len().min(speeds.len());
    let mut sections: Vec<(f64, f64)> = (0..m).map(|i| (width * (1.0 - overlaps[i] / 100.0), speeds[i])).collect();
    sections.sort_by(|a, b| if a.0 == b.0 { b.1.partial_cmp(&a.1).unwrap() } else { a.0.partial_cmp(&b.0).unwrap() });
    let mut last = (f64::INFINITY, 0.0f64);
    for s in sections.iter_mut() {
        if s.0 == last.0 { s.1 = last.1; } else { last = *s; }
    }
    let mut smallest = f64::INFINITY;
    let mut found = false;
    for s in &sections { if s.1 <= original_speed && s.0 < smallest { smallest = s.0; found = true; } }
    let min_distance = if found { smallest } else { -1.0 };
    let input: Vec<P> = pts.iter().map(|p| [p.x, p.y]).collect();
    let ext = estimate_points(&input, prev, width, min_distance);
    let calc = |d: f64| -> f64 {
        let v = if d <= sections[0].0 { original_speed }
        else if d >= sections[sections.len() - 1].0 { sections[sections.len() - 1].1 }
        else {
            let mut i = 0;
            while d > sections[i + 1].0 { i += 1; }
            let t = ((d - sections[i].0) / (sections[i + 1].0 - sections[i].0)).clamp(0.0, 1.0);
            (1.0 - t) * sections[i].1 + t * sections[i + 1].1
        };
        v.round()
    };
    let winv = 1.0 / width;
    let mut out = Vec::with_capacity(ext.len());
    for i in 0..ext.len() {
        let curr = ext[i];
        let next = ext[(i + 1).min(ext.len() - 1)];
        let mut sp = calc(curr.distance).min(calc(next.distance));
        sp = sp.min(original_speed);
        let overlap = (1.0 - curr.distance * winv).min(1.0 - next.distance * winv);
        out.push(ProcessedPoint { x: curr.pos[0], y: curr.pos[1], speed: sp, overlap });
    }
    out
}

/// Result of the hook for one path.
#[derive(Clone, Debug)]
pub struct OverhangProfile {
    pub points: Vec<ProcessedPoint>,
    /// True when any point's speed differs from the path speed by more than 1 mm/s (Orca `variable_speed`).
    pub variable_speed: bool,
}

/// Is this a path Orca runs the estimator on (`is_bridge(role) || is_perimeter(role)`)?
pub fn needs_overhang_estimation(f: Feature) -> bool {
    matches!(f, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall | Feature::Bridge | Feature::InternalBridge)
}

/// The hook: speed profile for `path`, or None when it is not applicable (disabled, first layer, not a
/// wall/bridge) or does not need a speed change. `ref_speed` = outer_wall_speed for the outer wall else
/// inner_wall_speed (capped by volumetric flow upstream); `path_speed` = the speed the motion lane chose.
pub fn overhang_speed_profile(path: &ExtPath, layer_index: usize, prev: &LowerOutline, cfg: &OverhangSpeedConfig, ref_speed: f64, path_speed: f64) -> Option<OverhangProfile> {
    if !cfg.enabled || layer_index == 0 || prev.is_empty() || !needs_overhang_estimation(path.feature) || path.pts.len() < 2 { return None; }
    let width = path.pts.iter().map(|p| p.w).fold(0.0f64, f64::max);
    if width <= 0.0 { return None; }
    let pct = |abs: f64| -> f64 { if abs < 0.5 { ref_speed } else { abs } };
    let speeds = [ref_speed, pct(cfg.speed_1_4), pct(cfg.speed_2_4), pct(cfg.speed_3_4), pct(cfg.speed_4_4), cfg.bridge_speed];
    let overlaps = [90.0, 75.0, 50.0, 25.0, 13.0, 0.0];
    let pts = estimate_extrusion_quality(&path.pts, width, prev, &overlaps, &speeds, path_speed);
    let variable_speed = pts.iter().any(|p| (p.speed - path_speed).abs() > 1.0);
    if !variable_speed { return None; }
    Some(OverhangProfile { points: pts, variable_speed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    fn circle(r: f64, n: usize) -> Vec<[f64; 2]> { (0..n).map(|i| { let a = std::f64::consts::TAU * i as f64 / n as f64; [r * a.cos(), r * a.sin()] }).collect() }
    fn wall(r: f64, n: usize, w: f64) -> ExtPath {
        ExtPath { feature: Feature::OuterWall, pts: circle(r, n).into_iter().map(|p| PathPt { x: p[0], y: p[1], w }).collect(), closed: true, layer_h: 0.2, speed: 60.0, flow_ratio: 1.0 }
    }
    fn prev(r: f64) -> LowerOutline { LowerOutline::new(&vec![Poly { contour: circle(r, 720), holes: vec![] }]) }

    /// Measured on OrcaSlicer 2.5.0-dev: a 45-degree-ish cone growing 0.3 mm per layer (outer wall centre line
    /// 0.21 inside the slice outline) prints its whole outer wall at a constant 33.0 mm/s with the X2D profile
    /// (outer_wall_speed 60, overhang_2_4_speed 50, 3_4 30, 4_4 10, bridge_speed 50).
    #[test]
    fn uniform_overhang_gets_orca_speed() {
        // previous outline radius R, this wall centre line R + 0.3 - 0.21 (so 0.09 outside the previous outline)
        let r = 66.0;
        let path = wall(r + 0.3 - 0.21, 600, 0.42);
        let pr = overhang_speed_profile(&path, 10, &prev(r), &OverhangSpeedConfig::default(), 60.0, 60.0).expect("variable speed");
        let mean = pr.points.iter().map(|p| p.speed).sum::<f64>() / pr.points.len() as f64;
        assert!((mean - 33.0).abs() < 1.0, "{mean}");
        assert!(pr.points.iter().all(|p| p.speed >= 31.0 && p.speed <= 35.0));
    }
    #[test]
    fn supported_walls_need_no_slowdown() {
        let path = wall(9.0, 200, 0.42); // well inside the previous outline
        assert!(overhang_speed_profile(&path, 10, &prev(10.0), &OverhangSpeedConfig::default(), 60.0, 60.0).is_none());
    }
    #[test]
    fn hooks_off_switches() {
        let path = wall(10.5, 200, 0.42);
        let ok = overhang_speed_profile(&path, 10, &prev(10.0), &OverhangSpeedConfig::default(), 60.0, 60.0);
        assert!(ok.is_some());
        assert!(overhang_speed_profile(&path, 0, &prev(10.0), &OverhangSpeedConfig::default(), 60.0, 60.0).is_none(), "first layer");
        assert!(overhang_speed_profile(&path, 10, &prev(10.0), &OverhangSpeedConfig { enabled: false, ..Default::default() }, 60.0, 60.0).is_none());
        let mut infill = path.clone();
        infill.feature = Feature::SparseInfill;
        assert!(overhang_speed_profile(&infill, 10, &prev(10.0), &OverhangSpeedConfig::default(), 60.0, 60.0).is_none());
    }
    #[test]
    fn fully_unsupported_walls_run_at_bridge_speed() {
        let path = wall(15.0, 300, 0.42); // 5 mm outside the previous layer
        let pr = overhang_speed_profile(&path, 10, &prev(10.0), &OverhangSpeedConfig::default(), 60.0, 60.0).unwrap();
        assert!(pr.points.iter().all(|p| (p.speed - 50.0).abs() < 1e-9), "bridge_speed section");
        assert!(pr.points.iter().all(|p| p.overlap < 0.0));
    }
    #[test]
    fn a_wall_crossing_the_boundary_is_split_where_it_crosses() {
        // straight 20 mm wall, half supported (x < 0 over the lower square), half hanging out
        let lower = LowerOutline::new(&vec![Poly { contour: vec![[-30.0, -30.0], [0.0, -30.0], [0.0, 30.0], [-30.0, 30.0]], holes: vec![] }]);
        let line = ExtPath { feature: Feature::OuterWall, pts: vec![PathPt { x: -10.0, y: 0.0, w: 0.42 }, PathPt { x: 10.0, y: 0.0, w: 0.42 }], closed: false, layer_h: 0.2, speed: 60.0, flow_ratio: 1.0 };
        let pr = overhang_speed_profile(&line, 10, &lower, &OverhangSpeedConfig::default(), 60.0, 60.0).unwrap();
        assert!(pr.points.len() >= 4, "points inserted around the boundary: {}", pr.points.len());
        assert_eq!(pr.points[0].speed, 60.0);
        // supported part: full speed; the boundary point is 0.21 (half width) past the outline -> 50 mm/s section;
        // beyond that the wall hangs in the air -> bridge speed 50. (Orca samples only at the points it inserts, so
        // the 10 mm/s section between 0.365 and 0.42 is never hit on this straight crossing - same as Orca.)
        assert!(pr.points.iter().take_while(|p| p.x < -1.0).all(|p| p.speed == 60.0));
        assert!(pr.points.iter().filter(|p| p.x >= 0.0).all(|p| (p.speed - 50.0).abs() < 1e-9), "{:?}", pr.points);
        assert!(pr.points.iter().any(|p| p.x > -1.0 && p.x < 0.0), "a point just before the boundary");
    }
    #[test]
    fn speed_table_is_monotone_through_sections() {
        // Orca's table: more overhang never means a faster speed until the bridge section
        let cfg = OverhangSpeedConfig::default();
        let pts = [PathPt { x: 0.0, y: 0.0, w: 0.42 }, PathPt { x: 1.0, y: 0.0, w: 0.42 }];
        let mut last = f64::INFINITY;
        for k in 0..8 {
            let off = 0.03 * k as f64; // distance of the path from the previous outline's edge
            let lower = LowerOutline::new(&vec![Poly { contour: vec![[-5.0, -5.0 - 0.0], [6.0, -5.0], [6.0, -off - 0.0], [-5.0, -off]], holes: vec![] }]);
            let p = ExtPath { feature: Feature::OuterWall, pts: pts.to_vec(), closed: false, layer_h: 0.2, speed: 60.0, flow_ratio: 1.0 };
            let pr = overhang_speed_profile(&p, 3, &lower, &cfg, 60.0, 60.0);
            let sp = pr.map(|x| x.points[0].speed).unwrap_or(60.0);
            if off + 0.21 < 0.365 { assert!(sp <= last + 1e-9, "off {off}: {sp} > {last}"); }
            last = sp;
        }
    }
}
