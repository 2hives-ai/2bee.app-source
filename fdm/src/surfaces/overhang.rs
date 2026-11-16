//! Overhang walls (`PerimeterGenerator`, `detect_overhang_wall`): wall segments whose centre line is not
//! supported by the grown lower layer are extruded as `Overhang wall`.
use super::ops::*;
use super::SurfaceCfg;
use crate::types::{ExtPath, Feature, PathPt, Polys};

/// Split the wall paths of one layer into supported parts (kept) and `OverhangWall` parts.
///
/// `lower_slices`: the layer below (`lslices`). Orca takes the lower region grown by half the nozzle
/// (`lower_polygons_series.back()`); everything of the wall centre line outside it is overhang.
pub fn split_overhang_walls(paths: Vec<ExtPath>, lower_slices: &Polys, cfg: &SurfaceCfg, first_layer: bool) -> Vec<ExtPath> {
    if !cfg.detect_overhang_wall || first_layer || lower_slices.is_empty() { return paths; }
    let grown = off(lower_slices, cfg.nozzle / 2.0);
    let mut out = vec![];
    for p in paths {
        if !matches!(p.feature, Feature::OuterWall | Feature::InnerWall) { out.push(p); continue; }
        let mut pts: Vec<Pt> = p.pts.iter().map(|q| [q.x, q.y]).collect();
        if p.closed { if let Some(f) = pts.first().copied() { pts.push(f); } }
        let w_of = |q: Pt| -> f64 {
            // nearest original point's width (constant for classic walls)
            let mut best = (f64::MAX, p.pts[0].w);
            for o in &p.pts { let d = (o.x - q[0]).hypot(o.y - q[1]); if d < best.0 { best = (d, o.w); } }
            best.1
        };
        let inside = clip_polyline(&pts, &grown, true);
        let outside = clip_polyline(&pts, &grown, false);
        if outside.is_empty() { out.push(p); continue; }
        let mk = |piece: Vec<Pt>, feature: Feature, flow_ratio: f64| ExtPath {
            feature, closed: false, layer_h: p.layer_h, speed: p.speed, flow_ratio,
            pts: piece.into_iter().map(|q| PathPt { x: q[0], y: q[1], w: w_of(q) }).collect(),
        };
        for piece in inside { out.push(mk(piece, p.feature, p.flow_ratio)); }
        for piece in outside { out.push(mk(piece, Feature::OverhangWall, p.flow_ratio * cfg.overhang_flow_ratio)); }
    }
    out
}
