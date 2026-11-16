//! Overhang speed ramp: a port of `GCode/ExtrusionProcessor.hpp` (`ExtrusionQualityEstimator` +
//! `estimate_points_properties`, the `<scaled, add_intersections, prev_layer_boundary_offset, signed_distance>`
//! instantiation GCode.cpp uses).
//!
//! Every perimeter / bridge path of layer N > 0 is measured against the slice outline of layer N-1: each vertex gets the
//! signed distance to that outline (negative inside) plus half a bead, points are inserted where the path crosses the
//! outline and along long segments that start to overhang, and the speed of each segment follows the table
//! `overlap {90,75,50,25,13,0}%  ->  {100%, overhang_1_4, _2_4, _3_4, _4_4, bridge_speed}` (linear interpolation between
//! rows, clamped to the speed the path would have anyway). `slowdown_for_curled_perimeters` (curled-line data from the
//! support-spot generator) has no input here and is not applied.

use super::geo::{self, P2};
use crate::types::Poly;

const EPS: f64 = 1e-4;

#[derive(Clone, Copy, Debug)]
pub struct ProcessedPoint {
    pub p: P2,
    /// mm/s for the segment starting at this point
    pub speed: f64,
    /// `1 - distance/width` (1 = fully supported)
    pub overlap: f64,
}

#[derive(Clone, Copy, Debug)]
struct Ext { p: P2, distance: f64 }

/// Boundary of the previous layer: line segments of every contour and hole.
pub struct Boundary { segs: Vec<(P2, P2)>, polys: Vec<Poly> }

impl Boundary {
    pub fn new(polys: &[Poly]) -> Boundary {
        let mut segs = Vec::new();
        for p in polys {
            for ring in std::iter::once(&p.contour).chain(p.holes.iter()) {
                let n = ring.len();
                for i in 0..n { segs.push((ring[i], ring[(i + 1) % n])); }
            }
        }
        Boundary { segs, polys: polys.to_vec() }
    }
    pub fn is_empty(&self) -> bool { self.segs.is_empty() }

    /// Distance to the outline, negative when `p` lies inside the slice.
    pub fn signed_distance(&self, p: P2) -> f64 {
        let mut best = f64::INFINITY;
        for (a, b) in &self.segs {
            let ab = geo::sub(*b, *a);
            let l2 = geo::dot(ab, ab);
            let t = if l2 < 1e-18 { 0.0 } else { (geo::dot(geo::sub(p, *a), ab) / l2).clamp(0.0, 1.0) };
            let d = geo::dist(p, geo::lerp(*a, *b, t));
            if d < best { best = d; }
        }
        if geo::in_polys(p, &self.polys) { -best } else { best }
    }

    /// Intersections of segment `a`-`b` with the outline, sorted along the segment.
    fn intersections(&self, a: P2, b: P2) -> Vec<P2> {
        let ab = geo::sub(b, a);
        let mut out: Vec<(f64, P2)> = Vec::new();
        for (c, d) in &self.segs {
            let cd = geo::sub(*d, *c);
            let den = geo::cross(ab, cd);
            if den.abs() < 1e-12 { continue; }
            let ac = geo::sub(*c, a);
            let t = geo::cross(ac, cd) / den;
            let u = geo::cross(ac, ab) / den;
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) { out.push((t, geo::lerp(a, b, t))); }
        }
        out.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
        out.into_iter().map(|x| x.1).collect()
    }
}

fn estimate_points(pts: &[P2], bnd: &Boundary, width: f64, min_distance: f64) -> Vec<Ext> {
    let min_spacing = width * 0.25;
    let boundary_offset = 0.5 * width;
    let mut points: Vec<Ext> = Vec::with_capacity(pts.len() * 3 / 2 + 1);
    points.push(Ext { p: pts[0], distance: bnd.signed_distance(pts[0]) + boundary_offset });
    for i in 1..pts.len() {
        let next = Ext { p: pts[i], distance: bnd.signed_distance(pts[i]) + boundary_offset };
        let prev = *points.last().unwrap();
        if (prev.distance > boundary_offset + EPS) != (next.distance > boundary_offset + EPS) {
            for ip in bnd.intersections(prev.p, next.p) {
                if geo::dist(ip, prev.p) > min_spacing && geo::dist(next.p, ip) > min_spacing {
                    points.push(Ext { p: ip, distance: boundary_offset });
                }
            }
        }
        points.push(next);
    }
    // segmentation
    let mut new_points: Vec<Ext> = Vec::with_capacity(points.len() * 2);
    new_points.push(points[0]);
    for k in 0..points.len().saturating_sub(1) {
        let (curr, next) = (points[k], points[k + 1]);
        if (curr.distance > -boundary_offset && curr.distance < boundary_offset + 2.0) || (next.distance > -boundary_offset && next.distance < boundary_offset + 2.0) {
            let line_len = geo::dist(next.p, curr.p);
            if (min_distance > 0.0 && (curr.distance.abs() > min_distance || next.distance.abs() > min_distance) && line_len >= 2.0) || (min_distance <= 0.0 && line_len > 4.0) {
                let a0 = ((curr.distance + 3.0 * boundary_offset) / line_len).clamp(0.0, 1.0);
                let a1 = (1.0 - (next.distance + 3.0 * boundary_offset) / line_len).clamp(0.0, 1.0);
                let (t0, t1) = (a0.min(a1), a0.max(a1));
                if t0 < 1.0 {
                    let p0 = geo::lerp(curr.p, next.p, t0);
                    let d0 = bnd.signed_distance(p0);
                    if d0.abs() > min_distance || min_distance <= 0.0 {
                        if geo::dist(p0, curr.p) > min_spacing && geo::dist(next.p, p0) > min_spacing { new_points.push(Ext { p: p0, distance: d0 + boundary_offset }); }
                    }
                }
                if t1 > 0.0 {
                    let p1 = geo::lerp(curr.p, next.p, t1);
                    let d1 = bnd.signed_distance(p1);
                    if d1.abs() > min_distance || min_distance <= 0.0 {
                        if geo::dist(p1, curr.p) > min_spacing && geo::dist(next.p, p1) > min_spacing { new_points.push(Ext { p: p1, distance: d1 + boundary_offset }); }
                    }
                }
            }
        }
        new_points.push(next);
    }
    new_points
}

/// `ExtrusionQualityEstimator::estimate_extrusion_quality`.
/// `overlaps_pct` and `speeds` (absolute mm/s, already resolved against the reference speed) are the section table.
pub fn estimate(pts: &[P2], width: f64, bnd: &Boundary, overlaps_pct: &[f64], speeds: &[f64], original_speed: f64) -> Vec<ProcessedPoint> {
    if pts.len() < 2 || bnd.is_empty() { return pts.iter().map(|p| ProcessedPoint { p: *p, speed: original_speed, overlap: 1.0 }).collect(); }
    let n = overlaps_pct.len().min(speeds.len());
    let mut sections: Vec<(f64, f64)> = (0..n).map(|i| (width * (1.0 - overlaps_pct[i] / 100.0), speeds[i])).collect();
    sections.sort_by(|a, b| if a.0 == b.0 { b.1.partial_cmp(&a.1).unwrap() } else { a.0.partial_cmp(&b.0).unwrap() });
    let mut last = (f64::INFINITY, 0.0);
    for s in sections.iter_mut() {
        if s.0 == last.0 { s.1 = last.1; } else { last = *s; }
    }
    let mut smallest = f64::INFINITY;
    let mut found = false;
    for s in &sections { if s.1 <= original_speed && s.0 < smallest { smallest = s.0; found = true; } }
    let min_distance = if found { smallest } else { -1.0 };
    let ext = estimate_points(pts, bnd, width, min_distance);
    let width_inv = 1.0 / width;
    let calc = |distance: f64| -> f64 {
        let v = if distance <= sections[0].0 { original_speed }
            else if distance >= sections[sections.len() - 1].0 { sections[sections.len() - 1].1 }
            else {
                let mut i = 0;
                while distance > sections[i + 1].0 { i += 1; }
                let t = ((distance - sections[i].0) / (sections[i + 1].0 - sections[i].0)).clamp(0.0, 1.0);
                (1.0 - t) * sections[i].1 + t * sections[i + 1].1
            };
        v.round()
    };
    let mut out = Vec::with_capacity(ext.len());
    for i in 0..ext.len() {
        let curr = ext[i];
        let next = ext[if i + 1 < ext.len() { i + 1 } else { i }];
        let mut sp = calc(curr.distance).min(calc(next.distance));
        sp = sp.min(original_speed);
        let overlap = (1.0 - curr.distance * width_inv).min(1.0 - next.distance * width_inv);
        out.push(ProcessedPoint { p: curr.p, speed: sp, overlap });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq() -> Vec<Poly> { vec![Poly { contour: vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]], holes: vec![] }] }

    #[test]
    fn supported_wall_keeps_speed_and_overhang_slows() {
        let b = Boundary::new(&sq());
        let overlaps = [90.0, 75.0, 50.0, 25.0, 13.0, 0.0];
        let speeds = [60.0, 60.0, 50.0, 30.0, 10.0, 50.0];
        // wall exactly half a bead inside the outline: fully supported
        let w = 0.42;
        let inside: Vec<P2> = vec![[w / 2.0, 1.0], [w / 2.0, 19.0]];
        let r = estimate(&inside, w, &b, &overlaps, &speeds, 60.0);
        assert!(r.iter().all(|p| p.speed == 60.0), "{:?}", r);
        // wall on the outline (half a bead unsupported): 50 % overlap row
        let on: Vec<P2> = vec![[0.0, 1.0], [0.0, 19.0]];
        let r = estimate(&on, w, &b, &overlaps, &speeds, 60.0);
        assert!(r.iter().all(|p| p.speed == 50.0), "{:?}", r);
        // 0.1 mm beyond the outline: between the 50 % and 25 % rows
        let beyond: Vec<P2> = vec![[-0.1, 1.0], [-0.1, 19.0]];
        let r = estimate(&beyond, w, &b, &overlaps, &speeds, 60.0);
        assert!(r.iter().all(|p| p.speed > 30.0 && p.speed < 50.0), "{:?}", r);
        // 0.3 mm beyond: past the last row -> bridge speed
        let far: Vec<P2> = vec![[-0.3, 1.0], [-0.3, 19.0]];
        let r = estimate(&far, w, &b, &overlaps, &speeds, 60.0);
        assert!(r.iter().all(|p| p.speed == 50.0), "{:?}", r);
        // a wall crossing the outline gets an inserted point at the crossing
        let cross: Vec<P2> = vec![[-3.0, 10.0], [3.0, 10.0]];
        let r = estimate(&cross, w, &b, &overlaps, &speeds, 60.0);
        assert!(r.len() >= 3, "{:?}", r);
        assert!(r[0].speed <= 50.0 && r.last().unwrap().speed == 60.0, "{:?}", r);
    }
}
