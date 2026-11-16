//! Private polygon adapter for the supports lane. Wraps i_overlay's INTEGER engine on a fixed
//! 1e-6 mm grid (same grid as Orca/Clipper), so identical inputs always give identical outputs and
//! results of successive operations stay snapped to one lattice.
//!
//! TODO(lane 1): when geom.rs is delivered this adapter can forward to it; the surface here is
//! deliberately the subset the support generator needs (union/diff/intersect/offset/open/close).
use crate::types::{Poly, Polys, Ring};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::{Overlay, ShapeType};
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;

pub const SCALE: f64 = 1e6;
pub type IP = IntPoint<i64>;
type IShape = Vec<Vec<IP>>;

#[inline]
pub fn scaled(mm: f64) -> i64 { (mm * SCALE).round() as i64 }
/// Orca `coord_t(scale_(v))`: division by SCALING_FACTOR, truncation toward zero.
#[inline]
pub fn scale_trunc(mm: f64) -> i64 { (mm / 1e-6) as i64 }
#[inline]
pub fn unscaled(v: i64) -> f64 { v as f64 / SCALE }

fn ring_to_int(r: &Ring) -> Vec<IP> {
    let mut out: Vec<IP> = Vec::with_capacity(r.len());
    for p in r {
        let q = IP::new(scaled(p[0]), scaled(p[1]));
        if out.last() != Some(&q) { out.push(q); }
    }
    while out.len() > 1 && out.first() == out.last() { out.pop(); }
    out
}
fn ring_from_int(r: &[IP]) -> Ring { r.iter().map(|p| [unscaled(p.x), unscaled(p.y)]).collect() }

fn to_ishapes(ps: &Polys) -> Vec<IShape> {
    let mut v = Vec::with_capacity(ps.len());
    for p in ps {
        let c = ring_to_int(&p.contour);
        if c.len() < 3 { continue; }
        let mut shape = vec![c];
        for h in &p.holes {
            let hh = ring_to_int(h);
            if hh.len() >= 3 { shape.push(hh); }
        }
        v.push(shape);
    }
    v
}
fn from_ishapes(shapes: Vec<IShape>) -> Polys {
    let mut out = Vec::with_capacity(shapes.len());
    for s in shapes {
        let mut it = s.into_iter();
        let Some(c) = it.next() else { continue };
        let holes: Vec<Ring> = it.map(|h| ring_from_int(&h)).collect();
        out.push(Poly { contour: ring_from_int(&c), holes });
    }
    out
}

fn run(subj: &Polys, clip: &Polys, rule: OverlayRule) -> Polys {
    let s = to_ishapes(subj);
    let c = to_ishapes(clip);
    let mut ov = Overlay::<i64>::new(s.len() * 2 + c.len() * 2 + 4);
    ov.add_shapes(&s, ShapeType::Subject);
    ov.add_shapes(&c, ShapeType::Clip);
    from_ishapes(ov.overlay(rule, FillRule::NonZero))
}

/// Union of loose rings. Orientation carries meaning: CCW rings add area, CW rings remove it
/// (NonZero winding), exactly like Clipper's pftNonZero on a Polygons set.
pub fn union_rings(rs: &[Ring]) -> Polys {
    let mut ov = Overlay::<i64>::new(rs.len() * 2 + 4);
    for r in rs {
        let c = ring_to_int(r);
        if c.len() >= 3 { ov.add_contour(&c, ShapeType::Subject); }
    }
    from_ishapes(ov.overlay(OverlayRule::Subject, FillRule::NonZero))
}
/// Union of all regions of `a` (resolves overlaps, touching regions are merged).
pub fn union(a: &Polys) -> Polys { run(a, &Vec::new(), OverlayRule::Subject) }
pub fn union2(a: &Polys, b: &Polys) -> Polys { run(a, b, OverlayRule::Union) }
pub fn diff(a: &Polys, b: &Polys) -> Polys {
    if a.is_empty() { return Vec::new(); }
    if b.is_empty() { return union(a); }
    run(a, b, OverlayRule::Difference)
}
pub fn intersect(a: &Polys, b: &Polys) -> Polys {
    if a.is_empty() || b.is_empty() { return Vec::new(); }
    run(a, b, OverlayRule::Intersect)
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Join {
    /// ClipperLib::jtSquare (what Orca passes as SUPPORT_SURFACES_OFFSET_PARAMETERS)
    Square,
    /// ClipperLib::jtMiter with the given miter limit (Orca's DefaultMiterLimit is 3)
    Miter(f64),
    /// ClipperLib::jtRound with the given arc tolerance in mm (Orca passes it in the miterLimit slot)
    Round(f64),
}

fn rnd(v: f64) -> f64 { if v < 0.0 { (v - 0.5).trunc() } else { (v + 0.5).trunc() } }

/// Port of ClipperLib::ClipperOffset::DoOffset for one closed path (coordinates are integer-valued
/// f64 in lattice units; `delta` in lattice units). Positive delta grows the filled side (the right-hand
/// side of the edge direction is the empty side: CCW outer rings, CW holes).
fn offset_ring_clipper(src: &[[f64; 2]], delta: f64, join: Join, out: &mut Vec<[f64; 2]>) {
    let n = src.len();
    if n < 3 { return; }
    // drop duplicate points
    let mut p: Vec<[f64; 2]> = Vec::with_capacity(n);
    for q in src { if p.last() != Some(q) { p.push(*q); } }
    while p.len() > 1 && p.first() == p.last() { p.pop(); }
    let n = p.len();
    if n < 3 { return; }
    let miter_lim = match join { Join::Miter(l) if l > 2.0 => 2.0 / (l * l), _ => 0.5 };
    // arc approximation parameters for jtRound (ClipperOffset::DoOffset)
    let (rsin, rcos, steps_per_rad) = {
        let arc_tol = match join { Join::Round(t) => t * SCALE, _ => 0.0 };
        let a = delta.abs();
        let y = if arc_tol <= 0.0 { 0.25 } else if arc_tol > a * 0.25 { a * 0.25 } else { arc_tol };
        let mut steps = std::f64::consts::PI / (1.0 - y / a).acos();
        if steps > a * std::f64::consts::PI { steps = a * std::f64::consts::PI; }
        let two_pi = 2.0 * std::f64::consts::PI;
        let mut sn = (two_pi / steps).sin();
        let cs = (two_pi / steps).cos();
        if delta < 0.0 { sn = -sn; }
        (sn, cs, steps / two_pi)
    };
    let normal = |a: [f64; 2], b: [f64; 2]| -> [f64; 2] {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        if dx == 0.0 && dy == 0.0 { return [0.0, 0.0]; }
        let f = 1.0 / (dx * dx + dy * dy).sqrt();
        [dy * f, -dx * f]
    };
    let normals: Vec<[f64; 2]> = (0..n).map(|i| normal(p[i], p[(i + 1) % n])).collect();
    let mut k = n - 1;
    for j in 0..n {
        let (nk, nj) = (normals[k], normals[j]);
        let pj = p[j];
        let mut sin_a = nk[0] * nj[1] - nj[0] * nk[1];
        let mut done = false;
        if (sin_a * delta).abs() < 1.0 {
            let cos_a = nk[0] * nj[0] + nj[1] * nk[1];
            if cos_a > 0.0 {
                out.push([rnd(pj[0] + nk[0] * delta), rnd(pj[1] + nk[1] * delta)]);
                done = true;
            }
        } else if sin_a > 1.0 { sin_a = 1.0; } else if sin_a < -1.0 { sin_a = -1.0; }
        if !done {
            if sin_a * delta < 0.0 {
                // concave corner
                out.push([rnd(pj[0] + nk[0] * delta), rnd(pj[1] + nk[1] * delta)]);
                out.push(pj);
                out.push([rnd(pj[0] + nj[0] * delta), rnd(pj[1] + nj[1] * delta)]);
            } else {
                let square = |out: &mut Vec<[f64; 2]>| {
                    let cos_a = nk[0] * nj[0] + nk[1] * nj[1];
                    let dx = (sin_a.atan2(cos_a) / 4.0).tan();
                    out.push([rnd(pj[0] + delta * (nk[0] - nk[1] * dx)), rnd(pj[1] + delta * (nk[1] + nk[0] * dx))]);
                    out.push([rnd(pj[0] + delta * (nj[0] + nj[1] * dx)), rnd(pj[1] + delta * (nj[1] - nj[0] * dx))]);
                };
                match join {
                    Join::Square => square(out),
                    Join::Miter(_) => {
                        let r = 1.0 + (nj[0] * nk[0] + nj[1] * nk[1]);
                        if r >= miter_lim {
                            let q = delta / r;
                            out.push([rnd(pj[0] + (nk[0] + nj[0]) * q), rnd(pj[1] + (nk[1] + nj[1]) * q)]);
                        } else { square(out); }
                    }
                    Join::Round(_) => {
                        let a = sin_a.atan2(nk[0] * nj[0] + nk[1] * nj[1]);
                        let steps = ((steps_per_rad * a.abs()).round() as i64).max(1);
                        let (mut x, mut y) = (nk[0], nk[1]);
                        for _ in 0..steps {
                            out.push([rnd(pj[0] + x * delta), rnd(pj[1] + y * delta)]);
                            let x2 = x;
                            x = x * rcos - rsin * y;
                            y = x2 * rsin + y * rcos;
                        }
                        out.push([rnd(pj[0] + nj[0] * delta), rnd(pj[1] + nj[1] * delta)]);
                    }
                }
            }
        }
        k = j;
    }
}

/// Offset by `delta` mm (positive grows), Clipper semantics. Input is unioned first.
pub fn offset_j(a: &Polys, delta: f64, join: Join) -> Polys {
    if a.is_empty() { return Vec::new(); }
    let u = union(a);
    if delta == 0.0 { return u; }
    let d = delta * SCALE;
    if d.abs() < 1.0 { return u; }
    let mut rings: Vec<Vec<IP>> = Vec::new();
    for pg in &u {
        for (ri, r) in std::iter::once(&pg.contour).chain(pg.holes.iter()).enumerate() {
            let _ = ri;
            let src: Vec<[f64; 2]> = r.iter().map(|q| [scaled(q[0]) as f64, scaled(q[1]) as f64]).collect();
            let mut o: Vec<[f64; 2]> = Vec::new();
            offset_ring_clipper(&src, d, join, &mut o);
            if o.len() >= 3 { rings.push(o.iter().map(|q| IP::new(q[0] as i64, q[1] as i64)).collect()); }
        }
    }
    let mut ov = Overlay::<i64>::new(rings.len() * 2 + 4);
    for r in &rings { ov.add_contour(r, ShapeType::Subject); }
    from_ishapes(ov.overlay(OverlayRule::Subject, FillRule::Positive))
}
/// ClipperLib::jtSquare offset (Orca SUPPORT_SURFACES_OFFSET_PARAMETERS).
pub fn offset_sq(a: &Polys, delta: f64) -> Polys { offset_j(a, delta, Join::Square) }
/// Default Clipper offset used by Orca: jtMiter with miter limit 3.
pub fn offset(a: &Polys, delta: f64) -> Polys { offset_j(a, delta, Join::Miter(3.0)) }
/// jtMiter with an explicit miter limit (e.g. 1.2 in the tree-support code)
pub fn offset_miter(a: &Polys, delta: f64, limit: f64) -> Polys { offset_j(a, delta, Join::Miter(limit)) }
/// jtRound with arc tolerance (mm)
pub fn offset_round(a: &Polys, delta: f64, arc_tol: f64) -> Polys { offset_j(a, delta, Join::Round(arc_tol)) }
pub fn expand(a: &Polys, d: f64) -> Polys { offset(a, d) }
pub fn shrink(a: &Polys, d: f64) -> Polys { offset(a, -d) }
/// Shrink by d1 then grow by d2 (Clipper offset2).
pub fn offset2_j(a: &Polys, d1: f64, d2: f64, j: Join) -> Polys {
    let s = offset_j(a, d1, j);
    if s.is_empty() { return s; }
    offset_j(&s, d2, j)
}
pub fn offset2(a: &Polys, d1: f64, d2: f64) -> Polys { offset2_j(a, d1, d2, Join::Miter(3.0)) }
/// Morphological opening: shrink by r1 then grow by r2.
pub fn opening(a: &Polys, r1: f64, r2: f64) -> Polys { offset2(a, -r1, r2) }
pub fn opening_sq(a: &Polys, r1: f64, r2: f64) -> Polys { offset2_j(a, -r1, r2, Join::Square) }
/// Morphological closing: grow by r1 then shrink by r2.
pub fn closing(a: &Polys, r1: f64, r2: f64) -> Polys { offset2(a, r1, -r2) }
pub fn closing_sq(a: &Polys, r1: f64, r2: f64) -> Polys { offset2_j(a, r1, -r2, Join::Square) }

pub fn ring_area(r: &Ring) -> f64 {
    let n = r.len();
    let mut a = 0.0;
    for i in 0..n { let p = r[i]; let q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
    a * 0.5
}
pub fn poly_area(p: &Poly) -> f64 { ring_area(&p.contour).abs() - p.holes.iter().map(|h| ring_area(h).abs()).sum::<f64>() }
pub fn area(a: &Polys) -> f64 { a.iter().map(poly_area).sum() }
pub fn is_empty(a: &Polys) -> bool { a.iter().all(|p| p.contour.len() < 3) }

/// (min, max) over all contour points, None if empty.
pub fn bbox(a: &Polys) -> Option<([f64; 2], [f64; 2])> {
    let mut mn = [f64::MAX; 2]; let mut mx = [f64::MIN; 2]; let mut any = false;
    for p in a { for q in &p.contour { any = true; for k in 0..2 { mn[k] = mn[k].min(q[k]); mx[k] = mx[k].max(q[k]); } } }
    if any { Some((mn, mx)) } else { None }
}
/// All rings (outer then holes) as a flat list, orientation as stored.
pub fn rings(a: &Polys) -> Vec<&Ring> {
    let mut v = Vec::new();
    for p in a { v.push(&p.contour); for h in &p.holes { v.push(h); } }
    v
}
pub fn rotate(a: &Polys, ang: f64) -> Polys {
    if ang == 0.0 { return a.clone(); }
    let (s, c) = ang.sin_cos();
    let rr = |r: &Ring| -> Ring { r.iter().map(|p| [p[0] * c - p[1] * s, p[0] * s + p[1] * c]).collect() };
    a.iter().map(|p| Poly { contour: rr(&p.contour), holes: p.holes.iter().map(rr).collect() }).collect()
}
pub fn translate(a: &Polys, dx: f64, dy: f64) -> Polys {
    let rr = |r: &Ring| -> Ring { r.iter().map(|p| [p[0] + dx, p[1] + dy]).collect() };
    a.iter().map(|p| Poly { contour: rr(&p.contour), holes: p.holes.iter().map(rr).collect() }).collect()
}
/// Axis aligned rectangle as a Poly.
pub fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Poly {
    Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }
}
pub fn point_in_poly(p: &Poly, q: [f64; 2]) -> bool {
    fn inside(r: &Ring, q: [f64; 2]) -> bool {
        let mut c = false; let n = r.len(); let mut j = n - 1;
        for i in 0..n {
            if (r[i][1] > q[1]) != (r[j][1] > q[1]) && q[0] < (r[j][0] - r[i][0]) * (q[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0] { c = !c; }
            j = i;
        }
        c
    }
    inside(&p.contour, q) && !p.holes.iter().any(|h| inside(h, q))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boolean_and_offset_basic() {
        let a = vec![rect(0.0, 0.0, 10.0, 10.0)];
        let b = vec![rect(5.0, 5.0, 15.0, 15.0)];
        assert!((area(&union2(&a, &b)) - 175.0).abs() < 1e-6);
        assert!((area(&intersect(&a, &b)) - 25.0).abs() < 1e-6);
        assert!((area(&diff(&a, &b)) - 75.0).abs() < 1e-6);
        let g = offset(&a, 1.0);
        let ar = area(&g);
        assert!(ar > 100.0 + 40.0 && ar < 144.01, "grown area {ar}");
        let s = offset(&a, -1.0);
        assert!((area(&s) - 64.0).abs() < 1e-3, "shrunk {}", area(&s));
        // hole grows when shrinking filled area
        let mut ring = rect(0.0, 0.0, 10.0, 10.0);
        let mut hole = rect(4.0, 4.0, 6.0, 6.0).contour; hole.reverse();
        ring.holes.push(hole);
        let sh = offset(&vec![ring], -1.0);
        assert!(area(&sh) < 64.0 - 1.0);
    }
}

/// Distance from `q` to the boundary (all rings) of `a`.
pub fn dist_to_boundary(a: &Polys, q: [f64; 2]) -> f64 {
    let mut best = f64::MAX;
    for r in rings(a) {
        let n = r.len();
        for i in 0..n {
            let p = r[i]; let s = r[(i + 1) % n];
            let (vx, vy) = (s[0] - p[0], s[1] - p[1]);
            let l2 = vx * vx + vy * vy;
            let t = if l2 == 0.0 { 0.0 } else { (((q[0] - p[0]) * vx + (q[1] - p[1]) * vy) / l2).clamp(0.0, 1.0) };
            let (dx, dy) = (p[0] + t * vx - q[0], p[1] + t * vy - q[1]);
            best = best.min((dx * dx + dy * dy).sqrt());
        }
    }
    best
}
/// True when the two region sets share area (more than numeric dust).
pub fn overlaps(a: &Polys, b: &Polys) -> bool {
    if a.is_empty() || b.is_empty() { return false; }
    area(&intersect(a, b)) > 1e-9
}
pub fn contains_point(a: &Polys, q: [f64; 2]) -> bool { a.iter().any(|p| point_in_poly(p, q)) }
/// Number of vertices over all rings.
pub fn n_points(a: &Polys) -> usize { rings(a).iter().map(|r| r.len()).sum() }

/// Douglas-Peucker on one closed ring (point list repeats the first point at the end internally).
pub fn dp_ring(r: &[[f64; 2]], tol: f64) -> Vec<[f64; 2]> {
    if r.len() < 3 { return r.to_vec(); }
    let mut pts: Vec<[f64; 2]> = r.to_vec();
    pts.push(r[0]);
    let tol2 = tol * tol;
    let dist2 = |p: [f64; 2], a: [f64; 2], b: [f64; 2]| -> f64 {
        let (vx, vy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = vx * vx + vy * vy;
        let t = if l2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2).clamp(0.0, 1.0) };
        let (dx, dy) = (a[0] + t * vx - p[0], a[1] + t * vy - p[1]);
        dx * dx + dy * dy
    };
    let mut out = vec![pts[0]];
    let mut anchor = 0usize;
    let mut floater = pts.len() - 1;
    let mut stack = vec![floater];
    loop {
        let mut maxd = 0.0; let mut far = anchor;
        for i in anchor + 1..floater { let d = dist2(pts[i], pts[anchor], pts[floater]); if d > maxd { maxd = d; far = i; } }
        if maxd <= tol2 {
            out.push(pts[floater]);
            anchor = floater;
            stack.pop();
            match stack.last() { Some(&f) => floater = f, None => break }
        } else { floater = far; stack.push(floater); }
    }
    out.pop();
    out
}
/// Orca polygons_simplify: Douglas-Peucker per ring + resolve self intersections (non-zero union).
pub fn simplify(a: &Polys, tol_mm: f64) -> Polys {
    let mut rings: Vec<Ring> = Vec::new();
    for pg in a {
        let c = dp_ring(&pg.contour, tol_mm);
        if c.len() >= 3 { rings.push(c); }
        for h in &pg.holes { let hh = dp_ring(h, tol_mm); if hh.len() >= 3 { rings.push(hh); } }
    }
    union_rings(&rings)
}

/// `make_circle_num_segments(radius, n)` translated to `center` (all in mm, lattice-exact like the C++ integer points).
pub fn circle_poly(center: [f64; 2], radius: f64, n: usize) -> Poly {
    let r = (radius * SCALE).round();
    let (cx, cy) = ((center[0] * SCALE).round(), (center[1] * SCALE).round());
    let inc = 2.0 * std::f64::consts::PI / n as f64;
    let contour: Ring = (0..n).map(|i| {
        let a = inc * i as f64;
        [unscaled((cx + (a.cos() * r).trunc()) as i64), unscaled((cy + (a.sin() * r).trunc()) as i64)]
    }).collect();
    Poly { contour, holes: vec![] }
}
