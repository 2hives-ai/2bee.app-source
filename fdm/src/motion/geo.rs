//! Small 2-D helpers private to the motion lane (no dependency on lane 1's `geom`, which was not delivered when this
//! lane was written). Polygon offsetting uses `i_overlay`'s outline engine, everything else is plain arithmetic.

use crate::types::{Poly, Polys, Ring};
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};

pub type P2 = [f64; 2];

pub fn dist(a: P2, b: P2) -> f64 { (a[0] - b[0]).hypot(a[1] - b[1]) }
pub fn sub(a: P2, b: P2) -> P2 { [a[0] - b[0], a[1] - b[1]] }
pub fn add(a: P2, b: P2) -> P2 { [a[0] + b[0], a[1] + b[1]] }
pub fn scale(a: P2, k: f64) -> P2 { [a[0] * k, a[1] * k] }
pub fn lerp(a: P2, b: P2, t: f64) -> P2 { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }
pub fn dot(a: P2, b: P2) -> f64 { a[0] * b[0] + a[1] * b[1] }
pub fn cross(a: P2, b: P2) -> f64 { a[0] * b[1] - a[1] * b[0] }
pub fn norm(a: P2) -> f64 { a[0].hypot(a[1]) }

/// Signed area (positive = counter-clockwise).
pub fn signed_area(r: &[P2]) -> f64 {
    let n = r.len();
    let mut a = 0.0;
    for i in 0..n { let p = r[i]; let q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
    a * 0.5
}

pub fn centroid(r: &[P2]) -> P2 {
    let n = r.len();
    if n == 0 { return [0.0, 0.0]; }
    let a = signed_area(r);
    if a.abs() < 1e-12 {
        let mut c = [0.0, 0.0];
        for p in r { c[0] += p[0]; c[1] += p[1]; }
        return [c[0] / n as f64, c[1] / n as f64];
    }
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..n {
        let p = r[i]; let q = r[(i + 1) % n];
        let f = p[0] * q[1] - q[0] * p[1];
        cx += (p[0] + q[0]) * f;
        cy += (p[1] + q[1]) * f;
    }
    [cx / (6.0 * a), cy / (6.0 * a)]
}

pub fn bbox(pts: &[P2]) -> Option<(P2, P2)> {
    let first = pts.first()?;
    let (mut lo, mut hi) = (*first, *first);
    for p in pts { lo[0] = lo[0].min(p[0]); lo[1] = lo[1].min(p[1]); hi[0] = hi[0].max(p[0]); hi[1] = hi[1].max(p[1]); }
    Some((lo, hi))
}

pub fn ring_len(r: &[P2]) -> f64 {
    let n = r.len();
    (0..n).map(|i| dist(r[i], r[(i + 1) % n])).sum()
}

pub fn polyline_len(p: &[P2]) -> f64 { p.windows(2).map(|w| dist(w[0], w[1])).sum() }

/// Even-odd point in ring test.
pub fn in_ring(pt: P2, r: &[P2]) -> bool {
    let n = r.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (r[i], r[j]);
        if (a[1] > pt[1]) != (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0] { inside = !inside; }
        j = i;
    }
    inside
}

pub fn in_poly(pt: P2, p: &Poly) -> bool {
    in_ring(pt, &p.contour) && !p.holes.iter().any(|h| in_ring(pt, h))
}

pub fn in_polys(pt: P2, ps: &[Poly]) -> bool { ps.iter().any(|p| in_poly(pt, p)) }

fn seg_proper_cross(a: P2, b: P2, c: P2, d: P2) -> bool {
    let d1 = cross(sub(b, a), sub(c, a));
    let d2 = cross(sub(b, a), sub(d, a));
    let d3 = cross(sub(d, c), sub(a, c));
    let d4 = cross(sub(d, c), sub(b, c));
    (d1 > 1e-12 && d2 < -1e-12 || d1 < -1e-12 && d2 > 1e-12) && (d3 > 1e-12 && d4 < -1e-12 || d3 < -1e-12 && d4 > 1e-12)
}

/// True if the segment a-b lies completely inside one polygon (contour minus holes).
pub fn seg_inside_poly(a: P2, b: P2, p: &Poly) -> bool {
    if !in_poly(a, p) || !in_poly(b, p) { return false; }
    let check = |r: &Ring| -> bool {
        let n = r.len();
        for i in 0..n { if seg_proper_cross(a, b, r[i], r[(i + 1) % n]) { return false; } }
        true
    };
    if !check(&p.contour) { return false; }
    for h in &p.holes { if !check(h) { return false; } }
    // midpoint guard for segments that graze a vertex
    in_poly(lerp(a, b, 0.5), p)
}

pub fn convex_hull(points: &[P2]) -> Vec<P2> {
    let mut pts: Vec<P2> = points.to_vec();
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 { return pts; }
    let mut h: Vec<P2> = Vec::new();
    for pass in 0..2 {
        let start = h.len();
        let it: Box<dyn Iterator<Item = &P2>> = if pass == 0 { Box::new(pts.iter()) } else { Box::new(pts.iter().rev()) };
        for p in it {
            while h.len() >= start + 2 && cross(sub(h[h.len() - 1], h[h.len() - 2]), sub(*p, h[h.len() - 2])) <= 0.0 { h.pop(); }
            h.push(*p);
        }
        h.pop();
    }
    h
}

/// Offset a polygon-with-holes outward (delta > 0) or inward (delta < 0). Round joins with the given maximum chord
/// deviation `tol` (mm), like Clipper's `jtRound` + arc tolerance.
pub fn offset_poly(p: &Poly, delta: f64, tol: f64) -> Polys {
    // radius-relative angular step from the chord tolerance: step = 2*acos(1 - tol/r)
    let r = delta.abs().max(1e-6);
    let step = 2.0 * (1.0 - (tol / r).min(1.0)).acos();
    let step = step.max(0.02 * std::f64::consts::PI).min(0.25 * std::f64::consts::PI);
    let style = OutlineStyle::new(delta).line_join(LineJoin::Round(step));
    let mut shape: Vec<Vec<P2>> = Vec::new();
    // outline() wants contours in the shape's winding: contour ccw first, holes cw.
    let mut c = p.contour.clone();
    if signed_area(&c) < 0.0 { c.reverse(); }
    shape.push(c);
    for h in &p.holes {
        let mut hh = h.clone();
        if signed_area(&hh) > 0.0 { hh.reverse(); }
        shape.push(hh);
    }
    let out = shape.outline(&style);
    out.into_iter().map(|s| {
        let mut it = s.into_iter();
        let contour = it.next().unwrap_or_default();
        Poly { contour, holes: it.collect() }
    }).collect()
}

pub fn offset_polys(ps: &[Poly], delta: f64, tol: f64) -> Polys {
    ps.iter().flat_map(|p| offset_poly(p, delta, tol)).collect()
}

/// Offset a closed ring (as the boundary of the region it encloses) by `delta`; positive = away from the
/// enclosed area. Returns the resulting outer contours.
pub fn offset_ring(r: &[P2], delta: f64, tol: f64) -> Vec<Ring> {
    let mut c = r.to_vec();
    if signed_area(&c) < 0.0 { c.reverse(); }
    offset_poly(&Poly { contour: c, holes: vec![] }, delta, tol).into_iter().map(|p| p.contour).collect()
}

/// Offset a closed ring (boundary of the region it encloses) with sharp (mitre) corners. Positive = outward.
pub fn offset_ring_miter(r: &[P2], delta: f64) -> Vec<Ring> {
    let mut c = r.to_vec();
    if signed_area(&c) < 0.0 { c.reverse(); }
    if delta.abs() < 1e-9 { return vec![c]; }
    let style = OutlineStyle::new(delta).line_join(LineJoin::Miter(0.05 * std::f64::consts::PI));
    let shape: Vec<Vec<P2>> = vec![c];
    shape.outline(&style).into_iter().filter_map(|s| s.into_iter().next()).collect()
}

/// Douglas-Peucker simplification of a closed ring (Orca `Geometry::simplify_polygons`).
pub fn simplify_ring(r: &[P2], tol: f64) -> Vec<P2> {
    if r.len() < 4 { return r.to_vec(); }
    fn dp(pts: &[P2], tol: f64, keep: &mut Vec<bool>, lo: usize, hi: usize) {
        if hi <= lo + 1 { return; }
        let (a, b) = (pts[lo], pts[hi]);
        let ab = sub(b, a);
        let l = norm(ab);
        let mut best = 0.0; let mut bi = lo;
        for i in lo + 1..hi {
            let d = if l < 1e-12 { dist(pts[i], a) } else { cross(ab, sub(pts[i], a)).abs() / l };
            if d > best { best = d; bi = i; }
        }
        if best > tol { keep[bi] = true; dp(pts, tol, keep, lo, bi); dp(pts, tol, keep, bi, hi); }
    }
    // split the ring at its two farthest apart points so both halves are open polylines
    let n = r.len();
    let mut far = 0; let mut fd = 0.0;
    for i in 1..n { let d = dist(r[0], r[i]); if d > fd { fd = d; far = i; } }
    let mut keep = vec![false; n];
    keep[0] = true; keep[far] = true;
    let mut half1: Vec<P2> = r[0..=far].to_vec();
    let mut half2: Vec<P2> = r[far..].to_vec(); half2.push(r[0]);
    let mut k1 = vec![false; half1.len()]; k1[0] = true; *k1.last_mut().unwrap() = true;
    dp(&half1, tol, &mut k1, 0, half1.len() - 1);
    let mut k2 = vec![false; half2.len()]; k2[0] = true; *k2.last_mut().unwrap() = true;
    dp(&half2, tol, &mut k2, 0, half2.len() - 1);
    let mut out: Vec<P2> = Vec::new();
    for (i, k) in k1.iter().enumerate() { if *k { out.push(half1[i]); } }
    for (i, k) in k2.iter().enumerate().skip(1) { if *k && i < half2.len() - 1 { out.push(half2[i]); } }
    half1.clear(); half2.clear();
    out
}

/// Nearest-neighbour chain of points starting near `start` (Orca `chain_points` without the 2-opt refinement).
pub fn chain_points(pts: &[P2], start: Option<P2>) -> Vec<usize> {
    let n = pts.len();
    let mut used = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur = start;
    for _ in 0..n {
        let mut best = usize::MAX; let mut bd = f64::INFINITY;
        for i in 0..n {
            if used[i] { continue; }
            let d = match cur { Some(c) => dist(c, pts[i]), None => pts[i][0] + pts[i][1] * 1e-3 };
            if d < bd { bd = d; best = i; }
        }
        if best == usize::MAX { best = (0..n).find(|i| !used[*i]).unwrap(); }
        used[best] = true;
        order.push(best);
        cur = Some(pts[best]);
    }
    order
}

/// `tsp_2opt_improve` (OrderingStrategies.cpp): best-improvement 2-opt over the CYCLE closed by (last, first).
pub fn tsp_2opt(path: &mut Vec<usize>, pts: &[P2]) -> bool {
    let pn = path.len();
    if pn <= 2 { return false; }
    let mut improved = false;
    for _ in 0..1000 {
        let el: Vec<f64> = (0..pn).map(|i| dist(pts[path[i]], pts[path[(i + 1) % pn]])).collect();
        let mut best = (pn, pn, 0.0f64);
        for i in 0..pn {
            let (pi, pin) = (pts[path[i]], pts[path[(i + 1) % pn]]);
            for j in i + 2..pn {
                let jn = (j + 1) % pn;
                if i == 0 && jn == 0 { continue; }
                let (pj, pjn) = (pts[path[j]], pts[path[jn]]);
                let (na, nb) = (dist(pj, pi), dist(pjn, pin));
                if na >= el[i] && nb >= el[j] { continue; }
                let gain = el[i] + el[j] - na - nb;
                if gain > best.2 { best = (i, j, gain); }
            }
        }
        if best.0 == pn { break; }
        improved = true;
        path[best.0 + 1..=best.1].reverse();
    }
    improved
}

/// `tsp_remove_crossings`: reverse a sub-path whenever two cycle edges cross.
pub fn tsp_remove_crossings(path: &mut Vec<usize>, pts: &[P2]) -> bool {
    let pn = path.len();
    if pn <= 3 { return false; }
    fn crosses(a: P2, b: P2, c: P2, d: P2) -> bool {
        let d1 = cross(sub(b, a), sub(c, a)); let d2 = cross(sub(b, a), sub(d, a));
        let d3 = cross(sub(d, c), sub(a, c)); let d4 = cross(sub(d, c), sub(b, c));
        ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    }
    let mut improved = false;
    let mut iters = pn * pn;
    while iters > 0 {
        iters -= 1;
        let mut found = None;
        'o: for i in 0..pn {
            let (ai, bi) = (pts[path[i]], pts[path[(i + 1) % pn]]);
            for j in i + 2..pn {
                if i == 0 && j == pn - 1 { continue; }
                let (aj, bj) = (pts[path[j]], pts[path[(j + 1) % pn]]);
                if crosses(ai, bi, aj, bj) { found = Some((i, j)); break 'o; }
            }
        }
        match found { Some((i, j)) => { improved = true; path[i + 1..=j].reverse(); } None => break }
    }
    improved
}

/// `chain_points_with_postprocessing`: nearest neighbour from `start_near`, then 2-opt / crossing removal on the cycle.
pub fn chain_points_post(pts: &[P2], start_near: Option<P2>) -> Vec<usize> {
    let mut path = chain_points(pts, start_near);
    for _ in 0..3 {
        let mut improved = tsp_2opt(&mut path, pts);
        improved |= tsp_remove_crossings(&mut path, pts);
        if !improved { break; }
    }
    path
}

/// Closest point on a polyline/ring to `p`: (segment index, parameter t on segment, distance).
pub fn closest_on_ring(r: &[P2], p: P2) -> (usize, f64, f64) {
    let n = r.len();
    let mut best = (0usize, 0.0f64, f64::INFINITY);
    for i in 0..n {
        let a = r[i]; let b = r[(i + 1) % n];
        let ab = sub(b, a);
        let l2 = dot(ab, ab);
        let t = if l2 < 1e-18 { 0.0 } else { (dot(sub(p, a), ab) / l2).clamp(0.0, 1.0) };
        let q = lerp(a, b, t);
        let d = dist(q, p);
        if d < best.2 { best = (i, t, d); }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<P2> { vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }

    #[test]
    fn hull_and_area() {
        let h = convex_hull(&[[0.0, 0.0], [2.0, 0.0], [1.0, 0.5], [2.0, 2.0], [0.0, 2.0]]);
        assert_eq!(h.len(), 4);
        assert!((signed_area(&h) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn offset_square_round() {
        let r = offset_ring(&sq(0.0, 0.0, 20.0, 20.0), 2.0, 0.01);
        assert_eq!(r.len(), 1);
        let (lo, hi) = bbox(&r[0]).unwrap();
        assert!((lo[0] + 2.0).abs() < 1e-3 && (hi[0] - 22.0).abs() < 1e-3);
        // rounded corners: area = 24*24 - (4-pi)*4 ... approx
        let area = signed_area(&r[0]);
        let want = 400.0 + 4.0 * 20.0 * 2.0 + std::f64::consts::PI * 4.0;
        assert!((area - want).abs() < 0.2, "{} vs {}", area, want);
    }

    #[test]
    fn segment_inside() {
        let p = Poly { contour: sq(0.0, 0.0, 10.0, 10.0), holes: vec![sq(4.0, 4.0, 6.0, 6.0)] };
        assert!(seg_inside_poly([1.0, 1.0], [9.0, 1.0], &p));
        assert!(!seg_inside_poly([1.0, 5.0], [9.0, 5.0], &p)); // crosses the hole
        assert!(!seg_inside_poly([1.0, 1.0], [11.0, 1.0], &p));
    }
}
