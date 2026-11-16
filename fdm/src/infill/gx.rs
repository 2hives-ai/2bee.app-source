//! Private geometry adapter for the infill lane (i_overlay behind a small surface). Lane 1's `geom`
//! module will supersede the booleans/offsets here; everything the infill code needs from geometry
//! goes through this file so the swap is mechanical.
use crate::types::{Poly, Polys, Ring};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::scale::FixedScaleFloatOverlay;
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};

pub type P = [f64; 2];
/// libslic3r SCALED_EPSILON (100 nm) in mm.
pub const EPS: f64 = 1e-4;
/// Fixed float-to-integer scale used for every i_overlay call: 1e6 = libslic3r's 1 nm grid.
pub const SCALE: f64 = 1e6;

pub fn dist(a: P, b: P) -> f64 { ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt() }
pub fn lerp(a: P, b: P, t: f64) -> P { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }
pub fn polyline_len(p: &[P]) -> f64 { p.windows(2).map(|w| dist(w[0], w[1])).sum() }
pub fn ring_area(r: &[P]) -> f64 {
    let n = r.len();
    let mut s = 0.0;
    for i in 0..n { let a = r[i]; let b = r[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
    s * 0.5
}
pub fn poly_area(p: &Poly) -> f64 { ring_area(&p.contour).abs() - p.holes.iter().map(|h| ring_area(h).abs()).sum::<f64>() }
pub fn bbox_pts<'a>(it: impl Iterator<Item = &'a P>) -> Option<(P, P)> {
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for q in it { for k in 0..2 { lo[k] = lo[k].min(q[k]); hi[k] = hi[k].max(q[k]); } }
    if lo[0].is_finite() { Some((lo, hi)) } else { None }
}

const MIN_AREA: f64 = 1e-3;
type Shape = Vec<Vec<P>>;
fn to_shapes(polys: &Polys) -> Vec<Shape> {
    polys.iter().filter(|p| p.contour.len() >= 3).map(|p| {
        let mut s: Shape = vec![p.contour.clone()];
        for h in &p.holes { if h.len() >= 3 { s.push(h.clone()); } }
        s
    }).collect()
}
fn from_shapes(shapes: Vec<Shape>) -> Polys {
    let mut out = Polys::new();
    for s in shapes {
        let mut it = s.into_iter();
        let Some(mut c) = it.next() else { continue };
        if ring_area(&c) < 0.0 { c.reverse(); }
        // i_overlay offsets leave sliver-sized holes/contours at joins; Clipper does not, and a later shrink
        // would grow every such hole into a large disc, so drop anything below 1e-3 mm^2.
        let holes: Vec<Ring> = it.map(|mut h| { if ring_area(&h) > 0.0 { h.reverse(); } h }).filter(|h| ring_area(h).abs() >= MIN_AREA).collect();
        if c.len() >= 3 && ring_area(&c) >= MIN_AREA { out.push(Poly { contour: c, holes }); }
    }
    out
}

/// Clipper-style mitered offset (miter limit 3). Negative = shrink.
pub fn offset(polys: &Polys, delta: f64) -> Polys {
    if polys.is_empty() { return Polys::new(); }
    if delta == 0.0 { return polys.clone(); }
    // A shrink by more than the inradius leaves nothing; the inradius is at most half the smaller bbox side.
    // (Also keeps i_overlay away from huge self-overlapping outlines of tiny shapes, which are very slow.)
    let kept: Polys;
    let polys = if delta < 0.0 {
        kept = polys.iter().filter(|p| match bbox_pts(p.contour.iter()) {
            Some((lo, hi)) => (hi[0] - lo[0]).min(hi[1] - lo[1]) > 2.0 * -delta,
            None => false,
        }).cloned().collect();
        &kept
    } else { polys };
    if polys.is_empty() { return Polys::new(); }
    let shapes = to_shapes(polys);
    // miter limit 3 <=> minimum interior angle 2*asin(1/3)
    let style = OutlineStyle::new(delta).line_join(LineJoin::Miter(2.0 * (1.0f64 / 3.0).asin()));
    let r = shapes.outline_fixed_scale(&style, SCALE).unwrap_or_default();
    from_shapes(r)
}

fn boolean(a: &Polys, b: &Polys, rule: OverlayRule) -> Polys {
    let sa = to_shapes(a);
    let sb = to_shapes(b);
    if sa.is_empty() && sb.is_empty() { return Polys::new(); }
    let r = sa.overlay_with_fixed_scale(&sb, rule, FillRule::NonZero, SCALE).unwrap_or_default();
    from_shapes(r)
}
pub fn union(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Union) }
pub fn diff(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Difference) }
pub fn inter(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Intersect) }

/// Intersection of open polylines with a region (libslic3r `intersection_pl`). Every input polyline is
/// clipped on its own (lines that cross each other are NOT split at the crossing, like Clipper); pieces
/// are returned in input order, rounded to the 1 nm grid.
pub fn clip_lines(lines: &[Vec<P>], region: &Polys) -> Vec<Vec<P>> {
    let mut out: Vec<Vec<P>> = Vec::new();
    if lines.is_empty() || region.is_empty() { return out; }
    let edges: Vec<(P, P)> = {
        let mut e = Vec::new();
        for r in rings(region) { let n = r.len(); for i in 0..n { e.push((r[i], r[(i + 1) % n])); } }
        e
    };
    let q = |v: f64| (v * SCALE).round() / SCALE;
    for pl in lines {
        let mut cur: Vec<P> = Vec::new();
        for w in pl.windows(2) {
            let (a, b) = (w[0], w[1]);
            for (t0, t1) in clip_segment(a, b, region, &edges) {
                let pa = [q(a[0] + (b[0] - a[0]) * t0), q(a[1] + (b[1] - a[1]) * t0)];
                let pb = [q(a[0] + (b[0] - a[0]) * t1), q(a[1] + (b[1] - a[1]) * t1)];
                if !cur.is_empty() && dist(*cur.last().unwrap(), pa) < 2.0 / SCALE { cur.push(pb); }
                else { if cur.len() >= 2 { out.push(std::mem::take(&mut cur)); } cur = vec![pa, pb]; }
            }
        }
        if cur.len() >= 2 { out.push(cur); }
    }
    out
}

/// Parameter intervals (0..1) of segment a-b lying inside the region.
fn clip_segment(a: P, b: P, region: &Polys, edges: &[(P, P)]) -> Vec<(f64, f64)> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 { return Vec::new(); }
    let (bx0, bx1) = (a[0].min(b[0]), a[0].max(b[0]));
    let (by0, by1) = (a[1].min(b[1]), a[1].max(b[1]));
    let mut ts: Vec<f64> = vec![0.0, 1.0];
    for &(p, r) in edges {
        if p[0].max(r[0]) < bx0 || p[0].min(r[0]) > bx1 || p[1].max(r[1]) < by0 || p[1].min(r[1]) > by1 { continue; }
        let (ex, ey) = (r[0] - p[0], r[1] - p[1]);
        let den = dx * ey - dy * ex;
        if den.abs() < 1e-18 { continue; }
        let t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
        let u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
        if t > 0.0 && t < 1.0 && u >= -1e-12 && u <= 1.0 + 1e-12 { ts.push(t); }
    }
    ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let mut res: Vec<(f64, f64)> = Vec::new();
    for w in ts.windows(2) {
        if w[1] - w[0] < 1e-12 { continue; }
        let tm = 0.5 * (w[0] + w[1]);
        let m = [a[0] + dx * tm, a[1] + dy * tm];
        if contains(region, m) {
            if let Some(l) = res.last_mut() { if (l.1 - w[0]).abs() < 1e-12 { l.1 = w[1]; continue; } }
            res.push((w[0], w[1]));
        }
    }
    res
}

pub fn contains(region: &Polys, p: P) -> bool {
    for poly in region {
        if point_in_ring(&poly.contour, p) && !poly.holes.iter().any(|h| point_in_ring(h, p)) { return true; }
    }
    false
}
pub fn point_in_ring(r: &[P], p: P) -> bool {
    let n = r.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (r[i], r[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] { inside = !inside; }
        j = i;
    }
    inside
}
/// All rings of a region (contour first, then its holes), as libslic3r `to_polygons`.
pub fn rings(polys: &Polys) -> Vec<Vec<P>> {
    let mut v = Vec::new();
    for p in polys { v.push(p.contour.clone()); for h in &p.holes { v.push(h.clone()); } }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sq(n: f64) -> Polys { vec![Poly { contour: vec![[0.0, 0.0], [n, 0.0], [n, n], [0.0, n]], holes: vec![] }] }
    #[test]
    fn crossing_lines_are_clipped_independently() {
        // two diagonals crossing at the centre must stay two 2-point lines (Clipper behaviour), not four pieces
        let r = clip_lines(&[vec![[-5.0, -5.0], [25.0, 25.0]], vec![[-5.0, 25.0], [25.0, -5.0]]], &sq(20.0));
        assert_eq!(r.len(), 2);
        assert!(r.iter().all(|l| l.len() == 2));
        assert!((polyline_len(&r[0]) - 28.2843).abs() < 1e-3);
    }
    #[test]
    fn clip_handles_holes_and_outside() {
        let mut p = sq(20.0);
        p[0].holes.push(vec![[5.0, 5.0], [5.0, 15.0], [15.0, 15.0], [15.0, 5.0]]);
        let r = clip_lines(&[vec![[-1.0, 10.0], [21.0, 10.0]], vec![[-1.0, 30.0], [21.0, 30.0]]], &p);
        assert_eq!(r.len(), 2, "the line crossing the hole is cut in two, the outside line vanishes");
        assert!((polyline_len(&r[0]) + polyline_len(&r[1]) - 10.0).abs() < 1e-3);
    }
    #[test]
    fn offset_shrinks_and_drops_what_does_not_fit() {
        let r = offset(&sq(10.0), -2.0);
        assert!((poly_area(&r[0]) - 36.0).abs() < 1e-3);
        assert!(offset(&sq(10.0), -5.5).is_empty(), "shrinking by more than the inradius leaves nothing");
        let g = offset(&r, 2.0);
        assert!((poly_area(&g[0]) - 100.0).abs() < 1.0);
    }
}
