//! Spiral vase: port of `GCode/SpiralVase.cpp` at the extrusion-path level.
//!
//! Orca post-processes each layer's G-code: every extruding move gets
//! `Z = z_prev + (cumulative length / total length) * layer_height`, travels and retractions are
//! dropped, the first spiral layer ramps its flow from `spiral_starting_flow_ratio` to 100%, the last
//! layer is followed by a flat loop at the top Z whose flow ramps from 100% down to
//! `spiral_finishing_flow_ratio`, and with `spiral_mode_smooth` the XY of each move is blended
//! with the closest point of the previous layer's loop (limited by `spiral_mode_max_xy_smoothing`).
//! Here the same math runs on the wall loop's point list; the G-code lane must emit 3D moves
//! (`SpiralMove.z`) and scale each segment's extrusion by `e_scale`.
//!
//! Which layers are spiral layers (GCode.cpp `process_layer`): `layer_id >= skirt_height`, `layer_id > 0 ||
//! !brim`, no infinite skirt, `bottom_shell_layers <= layer_id`, exactly one perimeter loop, no fills.
//! See [`spiral_layer_enabled`]. The wall generator (lane 2) must emit ONE loop per layer in spiral mode
//! (`keep_largest_contour` implements Orca's "largest contour only" rule for multi-island layers).
use super::adapter as g;
use crate::types::{ExtPath, Polys};

type P = [f64; 2];

#[derive(Clone, Debug)]
pub struct SpiralParams {
    pub smooth: bool,
    /// spiral_mode_max_xy_smoothing, absolute mm (config percent of the nozzle: 200% * 0.4 = 0.8).
    pub max_xy_smoothing: f64,
    pub starting_flow_ratio: f64,
    pub finishing_flow_ratio: f64,
    /// `resolution` config (0.012): moves shorter than 2*resolution are dropped.
    pub resolution: f64,
}
impl Default for SpiralParams {
    fn default() -> Self { SpiralParams { smooth: false, max_xy_smoothing: 0.8, starting_flow_ratio: 0.0, finishing_flow_ratio: 0.0, resolution: 0.012 } }
}

/// One extruding segment ending at (x, y, z); its nominal extrusion is multiplied by `e_scale`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpiralMove { pub x: f64, pub y: f64, pub z: f64, pub e_scale: f64 }

#[derive(Clone, Debug, Default)]
pub struct SpiralLayer {
    /// The (redundant) Z move target emitted first: the previous layer's top.
    pub z_start: f64,
    /// Spiral segments, in order. The loop's start point is the end of the previous layer (travel dropped).
    pub moves: Vec<SpiralMove>,
    /// Last layer only: a flat loop at the top Z whose flow ramps 100% -> finishing ratio.
    pub transition_out: Vec<SpiralMove>,
}

/// `layer.id() >= skirt_height && (layer.id() > 0 || !brim) && !infinite_skirt && bottom_shell_layers <= layer.id()
///  && perimeter loops == 1 && no fills` (the GCode.cpp rule plus its caller's inputs).
pub fn spiral_layer_enabled(layer_id: usize, skirt_height: usize, has_brim: bool, infinite_skirt: bool, bottom_shell_layers: usize, perimeter_loops: usize, fill_items: usize) -> bool {
    (layer_id > 0 || !has_brim) && layer_id >= skirt_height && !infinite_skirt
        && bottom_shell_layers <= layer_id && perimeter_loops <= 1 && fill_items == 0
}

/// PerimeterGenerator rule for spiral mode: keep only the contour with the largest area.
pub fn keep_largest_contour(p: &Polys) -> Polys {
    let mut best: Option<(f64, usize)> = None;
    for (i, q) in p.iter().enumerate() {
        let a = g::ring_area(&q.contour).abs();
        if best.map_or(true, |b| a > b.0) { best = Some((a, i)); }
    }
    best.map(|(_, i)| vec![p[i].clone()]).unwrap_or_default()
}

fn nearest_on_lines(p: P, pts: &[P]) -> Option<(P, f64)> {
    if pts.len() < 2 { return None; }
    let mut best = (f64::MAX, [0.0, 0.0]);
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let ab = [b[0] - a[0], b[1] - a[1]];
        let ca = [p[0] - a[0], p[1] - a[1]];
        let dd = ab[0] * ab[0] + ab[1] * ab[1];
        let t = if dd == 0.0 { 0.0 } else { ((ca[0] * ab[0] + ca[1] * ab[1]) / dd).clamp(0.0, 1.0) };
        let c = [a[0] + ab[0] * t, a[1] + ab[1] * t];
        let d = (p[0] - c[0]).hypot(p[1] - c[1]);
        if d < best.0 { best = (d, c); }
    }
    Some((best.1, best.0))
}

/// Stateful per-object processor, fed every layer in order (like `SpiralVase::process_layer`).
#[derive(Clone, Debug)]
pub struct SpiralVase {
    pub params: SpiralParams,
    previous: Option<Vec<P>>,
    enabled: bool,
}
impl SpiralVase {
    pub fn new(params: SpiralParams) -> Self { SpiralVase { params, previous: None, enabled: false } }

    /// `wall`: the layer's single closed wall loop, starting at the seam. Returns None for layers that are
    /// not spiral layers (they print normally). `layer_h` is the layer height, `z_top` the layer's print Z.
    pub fn process_layer(&mut self, wall: &ExtPath, z_top: f64, layer_h: f64, enable: bool, last_layer: bool) -> Option<SpiralLayer> {
        let transition_in = enable && !self.enabled;
        self.enabled = enable;
        if !enable { return None; }
        let p = &self.params;
        let z_prev = z_top - layer_h;
        let min_seg = (2.0 * p.resolution).max(1e-4);
        // extruding moves: start is the previous point, then the loop closes back to the start
        let mut pts: Vec<P> = wall.pts.iter().map(|q| [q.x, q.y]).collect();
        if wall.closed && pts.len() > 1 && pts.first() != pts.last() { pts.push(pts[0]); }
        let total: f64 = pts.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum();
        let mut out = SpiralLayer { z_start: z_prev, ..Default::default() };
        let mut cur_layer: Vec<P> = Vec::new();
        let prev_layer = self.previous.clone();
        let mut last_point = prev_layer.as_ref().and_then(|v| v.last().copied()).unwrap_or([0.0, 0.0]);
        let mut len = 0.0;
        for w in pts.windows(2) {
            let dist = (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]);
            if dist < min_seg { continue; }
            len += dist;
            let factor = if total > 0.0 { len / total } else { 1.0 };
            let (mut x, mut y) = (w[1][0], w[1][1]);
            let mut e = 1.0;
            if transition_in {
                e *= p.starting_flow_ratio + factor * (1.0 - p.starting_flow_ratio);
            } else if last_layer {
                out.transition_out.push(SpiralMove { x, y, z: z_top, e_scale: p.finishing_flow_ratio + (1.0 - factor) * (1.0 - p.finishing_flow_ratio) });
            }
            let z = z_prev + factor * layer_h;
            if p.smooth {
                cur_layer.push([x, y]);
                if let Some(prev) = &prev_layer {
                    match nearest_on_lines([x, y], prev) {
                        Some((np, d)) if d < p.max_xy_smoothing => {
                            let target = [np[0] * (1.0 - factor) + x * factor, np[1] * (1.0 - factor) + y * factor];
                            let md = (last_point[0] - target[0]).hypot(last_point[1] - target[1]);
                            if md < min_seg { continue; }
                            x = target[0]; y = target[1];
                            e *= md / dist;
                            last_point = target;
                        }
                        _ => { last_point = [x, y]; }
                    }
                }
            }
            out.moves.push(SpiralMove { x, y, z, e_scale: e });
        }
        self.previous = Some(cur_layer);
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Feature, PathPt};

    fn square_loop(hw: f64, start_x: f64) -> ExtPath {
        // seam on the top edge, like Orca's cube: start (start_x, +hw), go left, down, right, up, back
        let pts = [(start_x, hw), (-hw, hw), (-hw, -hw), (hw, -hw), (hw, hw)];
        ExtPath { feature: Feature::OuterWall, pts: pts.iter().map(|&(x, y)| PathPt { x, y, w: 0.42 }).collect(), closed: true, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 }
    }

    /// Numbers measured from OrcaSlicer 2.5.0-dev G-code of a 20mm cube (spiral_mode=1, wall_loops=1,
    /// top_shell_layers=0, sparse_infill_density=0, 3 bottom layers): see the lane-7 report.
    #[test]
    fn first_layer_ramps_flow_and_z_like_orca() {
        let mut sv = SpiralVase::new(SpiralParams::default());
        let wall = square_loop(9.79, -8.872);
        let l = sv.process_layer(&wall, 0.8, 0.2, true, false).unwrap();
        assert_eq!(l.moves.len(), 5);
        let z: Vec<f64> = l.moves.iter().map(|m| m.z).collect();
        let want_z = [0.602, 0.652, 0.702, 0.752, 0.8];
        for (a, b) in z.iter().zip(want_z) { assert!((a - b).abs() < 2e-3, "{a} vs {b}"); }
        let e: Vec<f64> = l.moves.iter().map(|m| m.e_scale).collect();
        // Orca: e/d over normal e/d = 0.0114, 0.2618, 0.5116, 0.7616, 1.0 (spiral_starting_flow_ratio = 0)
        let want_e = [0.0114, 0.2618, 0.5116, 0.7616, 1.0];
        for (a, b) in e.iter().zip(want_e) { assert!((a - b).abs() < 3e-3, "{a} vs {b}"); }
        assert!(l.transition_out.is_empty());
    }
    #[test]
    fn middle_layer_is_full_flow_and_last_layer_ramps_down() {
        let mut sv = SpiralVase::new(SpiralParams::default());
        let wall = square_loop(9.79, -8.872);
        sv.process_layer(&wall, 0.8, 0.2, true, false).unwrap();
        let l = sv.process_layer(&wall, 1.0, 0.2, true, false).unwrap();
        assert!(l.moves.iter().all(|m| (m.e_scale - 1.0).abs() < 1e-12));
        assert!((l.moves.last().unwrap().z - 1.0).abs() < 1e-9 && (l.z_start - 0.8).abs() < 1e-12);
        let last = sv.process_layer(&wall, 1.2, 0.2, true, true).unwrap();
        // Orca layer 100: flat at the top Z, e/d ratios 0.988, 0.738, 0.488, 0.238 (+ the zero-flow closing side)
        let t = &last.transition_out;
        assert!(t.iter().all(|m| (m.z - 1.2).abs() < 1e-12));
        let want = [0.9883, 0.7383, 0.4883, 0.2383];
        for (m, w) in t.iter().zip(want) { assert!((m.e_scale - w).abs() < 3e-3, "{} vs {w}", m.e_scale); }
        assert!(t.last().unwrap().e_scale.abs() < 1e-9);
    }
    #[test]
    fn disabled_layer_prints_normally_and_resets_transition() {
        let mut sv = SpiralVase::new(SpiralParams::default());
        let wall = square_loop(9.79, -8.872);
        assert!(sv.process_layer(&wall, 0.4, 0.2, false, false).is_none());
        assert!(sv.process_layer(&wall, 0.6, 0.2, true, false).unwrap().moves[0].e_scale < 0.1);
    }
    #[test]
    fn smooth_blends_with_previous_layer() {
        let mut sv = SpiralVase::new(SpiralParams { smooth: true, ..SpiralParams::default() });
        let ring = |r: f64| -> ExtPath {
            let n = 360;
            let pts = (0..n).map(|i| { let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64; PathPt { x: r * a.cos(), y: r * a.sin(), w: 0.42 } }).collect();
            ExtPath { feature: Feature::OuterWall, pts, closed: true, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 }
        };
        sv.process_layer(&ring(10.0), 0.8, 0.2, true, false).unwrap();
        let l = sv.process_layer(&ring(10.2), 1.0, 0.2, true, false).unwrap();
        // radius ramps from ~10.0 (start of layer: previous radius) to 10.2 (end): blended, not a step
        let r0 = (l.moves[0].x.hypot(l.moves[0].y)).min(10.2);
        let rl = l.moves.last().unwrap();
        assert!(r0 < 10.05 && (rl.x.hypot(rl.y) - 10.2).abs() < 0.01, "{r0} {}", rl.x.hypot(rl.y));
        assert!(l.moves.iter().all(|m| m.e_scale > 0.0));
    }
    #[test]
    fn enable_rule() {
        assert!(!spiral_layer_enabled(2, 1, false, false, 3, 1, 0));
        assert!(spiral_layer_enabled(3, 1, false, false, 3, 1, 0));
        assert!(!spiral_layer_enabled(5, 1, false, false, 3, 2, 0));
        assert!(!spiral_layer_enabled(5, 1, false, false, 3, 1, 1));
    }
}

/// What a layer of a spiral-vase print is made of (PrintObject::detect_surfaces_type + LayerRegion rules).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpiralLayerKind {
    /// layer 0 .. bottom_shell_layers-2: classic bottom / internal-solid layers with walls and solid fill.
    BottomSolid,
    /// layer bottom_shell_layers-1 (only if bottom_shell_layers > 1): its slice is retyped `stTop` so it is
    /// filled with the top pattern (the floor of the vase).
    LastBottomAsTop,
    /// everything above: one wall, no fill, run through [`SpiralVase`].
    Spiral,
}
/// `spiral_mode` layer plan: `num_layers = min(bottom_shell_layers, layer_count)`; the last of those layers is
/// retyped as a top surface when there is more than one.
pub fn spiral_layer_kind(layer_id: usize, bottom_shell_layers: usize, layer_count: usize) -> SpiralLayerKind {
    let num = bottom_shell_layers.min(layer_count);
    if layer_id >= num { SpiralLayerKind::Spiral }
    else if num > 1 && layer_id == num - 1 { SpiralLayerKind::LastBottomAsTop }
    else { SpiralLayerKind::BottomSolid }
}
/// The settings the GUI forces when spiral_mode is on (`ConfigManipulation`): wall_loops 1, top_shell_layers 0,
/// sparse_infill_density 0, no support, no thin-wall detection, no overhang_reverse. The CLI does NOT force
/// them: a config that violates them is accepted and the vase silently degrades to normal layers
/// (layers with more than one loop or any fill are never spiralised). Returns the violated keys.
pub fn spiral_config_violations(wall_loops: u32, top_shell_layers: u32, sparse_infill_density: f64, enable_support: bool, detect_thin_wall: bool, overhang_reverse: bool) -> Vec<&'static str> {
    let mut v = vec![];
    if wall_loops != 1 { v.push("wall_loops"); }
    if top_shell_layers != 0 { v.push("top_shell_layers"); }
    if sparse_infill_density != 0.0 { v.push("sparse_infill_density"); }
    if enable_support { v.push("enable_support"); }
    if detect_thin_wall { v.push("detect_thin_wall"); }
    if overhang_reverse { v.push("overhang_reverse"); }
    v
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    #[test]
    fn layer_plan_matches_orca_cube_layers() {
        // measured: spiral cube, bottom_shell_layers = 3 -> layers 0,1 normal, layer 2 printed with the top pattern, 3.. spiral
        assert_eq!(spiral_layer_kind(0, 3, 100), SpiralLayerKind::BottomSolid);
        assert_eq!(spiral_layer_kind(1, 3, 100), SpiralLayerKind::BottomSolid);
        assert_eq!(spiral_layer_kind(2, 3, 100), SpiralLayerKind::LastBottomAsTop);
        assert_eq!(spiral_layer_kind(3, 3, 100), SpiralLayerKind::Spiral);
        assert_eq!(spiral_layer_kind(0, 1, 100), SpiralLayerKind::BottomSolid, "single bottom layer is not retyped");
        assert_eq!(spiral_layer_kind(1, 1, 100), SpiralLayerKind::Spiral);
        assert_eq!(spiral_layer_kind(1, 3, 2), SpiralLayerKind::LastBottomAsTop, "short objects: min(bottom, layers)");
    }
    #[test]
    fn config_violations_listed() {
        assert!(spiral_config_violations(1, 0, 0.0, false, false, false).is_empty());
        assert_eq!(spiral_config_violations(2, 5, 15.0, false, false, false), vec!["wall_loops", "top_shell_layers", "sparse_infill_density"]);
    }
}
