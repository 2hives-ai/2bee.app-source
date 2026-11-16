//! Private geometry adapter for the surfaces lane. Everything the lane needs from polygon booleans,
//! offsets and polyline clipping goes through here, so a change in `geom` touches one file.
//!
//! Conventions: millimetres, f64. Inputs may be overlapping soups (Clipper-style, non-zero union semantics);
//! every boolean first normalises its operands with a union, so the callers never have to.
use crate::geom as g;
use crate::types::{Poly, Polys};

pub type Pt = [f64; 2];

/// libslic3r EPSILON (1e-4) in mm; SCALED_EPSILON is the same number of mm because scale_(1e-4)=100 units of 1e-6 mm.
pub const EPS: f64 = 1e-4;
/// Slivers below this net area are noise from coincident edges (mm^2).
const SLIVER: f64 = 1e-6;

pub fn u(a: &Polys) -> Polys { sl(g::union_all(&[a])) }
pub fn un(a: &Polys, b: &Polys) -> Polys { sl(g::union_all(&[a, b])) }
pub fn un_all(sets: &[&Polys]) -> Polys { sl(g::union_all(sets)) }
pub fn df(a: &Polys, b: &Polys) -> Polys {
    if a.is_empty() { return vec![]; }
    if b.is_empty() { return u(a); }
    sl(g::diff(&u(a), &u(b)))
}
pub fn it(a: &Polys, b: &Polys) -> Polys {
    if a.is_empty() || b.is_empty() { return vec![]; }
    sl(g::intersect(&u(a), &u(b)))
}
/// Difference with Clipper's `ApplySafetyOffset::Yes`: the subtrahend is grown by 10 units (1e-5 mm).
pub fn df_safe(a: &Polys, b: &Polys) -> Polys {
    if b.is_empty() { return u(a); }
    df(a, &off(b, 1e-5))
}
pub fn sl(p: Polys) -> Polys { g::clean(&p, SLIVER) }
/// Miter offset (limit 3) = libslic3r `offset()` default.
pub fn off(a: &Polys, d: f64) -> Polys {
    if a.is_empty() { return vec![]; }
    if d == 0.0 { return u(a); }
    // ClipperOffset port (walls lane): raw per-vertex offset ring + positive-fill union, as libslic3r does. The
    // i_overlay outline in `geom::offset` differs from it when the offset exceeds the feature size (staircase edges).
    sl(crate::walls::geo::offset(&u(a), d))
}
pub fn off_round(a: &Polys, d: f64, arc_tol: f64) -> Polys {
    if a.is_empty() { return vec![]; }
    if d == 0.0 { return u(a); }
    sl(g::offset_round(&u(a), d, arc_tol))
}
pub fn shrink(a: &Polys, d: f64) -> Polys { off(a, -d.abs()) }
pub fn expand(a: &Polys, d: f64) -> Polys { off(a, d.abs()) }
/// offset2: first `d1` then `d2` (Clipper `offset2_ex`).
pub fn off2(a: &Polys, d1: f64, d2: f64) -> Polys { off(&off(a, d1), d2) }
pub fn opening(a: &Polys, d: f64) -> Polys { off2(a, -d, d) }
pub fn closing(a: &Polys, d: f64) -> Polys { off2(a, d, -d) }
pub fn area(a: &Polys) -> f64 { g::area(a) }
pub fn poly_area(p: &Poly) -> f64 { g::area(&vec![p.clone()]) }
pub fn bbox(a: &Polys) -> Option<[f64; 4]> { g::bbox(a) }
pub fn inside(a: &Polys, x: f64, y: f64) -> bool { g::point_in_polys(a, x, y) }

/// Exact accelerated `geom::point_in_polys`: the edges are bucketed by y so a query only evaluates the edges whose
/// y-range can straddle the query row, with the very same predicate and float expression as `geom::pip_ring`
/// (including the edge orientation `a = r[i], b = r[i-1]`), so every answer is identical to `inside()`.
pub struct PolyIdx {
    bins: Vec<Vec<(u32, Pt, Pt)>>,
    y0: f64,
    inv_h: f64,
    /// (first ring id, number of holes) per polygon; the contour has ring id `first`.
    polys: Vec<(u32, u32)>,
    n_rings: usize,
}

impl PolyIdx {
    pub fn new(a: &Polys) -> PolyIdx {
        let mut polys = vec![];
        let mut ring_list: Vec<&Vec<Pt>> = vec![];
        for q in a {
            polys.push((ring_list.len() as u32, q.holes.len() as u32));
            ring_list.push(&q.contour);
            for h in &q.holes { ring_list.push(h); }
        }
        let (mut ymin, mut ymax) = (f64::INFINITY, f64::NEG_INFINITY);
        let mut ne = 0usize;
        for r in &ring_list { ne += r.len(); for p in r.iter() { ymin = ymin.min(p[1]); ymax = ymax.max(p[1]); } }
        if ne == 0 || !(ymax > ymin) {
            return PolyIdx { bins: vec![], y0: 0.0, inv_h: 0.0, polys, n_rings: ring_list.len() };
        }
        let nb = (ne / 2).clamp(1, 4096);
        let inv_h = nb as f64 / (ymax - ymin);
        let mut bins: Vec<Vec<(u32, Pt, Pt)>> = vec![vec![]; nb];
        let bin = |y: f64| -> usize { (((y - ymin) * inv_h).floor().max(0.0) as usize).min(nb - 1) };
        for (id, r) in ring_list.iter().enumerate() {
            let n = r.len();
            let mut j = n.wrapping_sub(1);
            for i in 0..n {
                let (a, b) = (r[i], r[j]);
                j = i;
                if a[1] == b[1] { continue; } // (a.y > y) == (b.y > y) for every y
                let (lo, hi) = (bin(a[1].min(b[1])), bin(a[1].max(b[1])));
                for k in lo..=hi { bins[k].push((id as u32, a, b)); }
            }
        }
        PolyIdx { bins, y0: ymin, inv_h, polys, n_rings: ring_list.len() }
    }
    pub fn inside(&self, x: f64, y: f64) -> bool {
        if self.bins.is_empty() { return false; }
        let nb = self.bins.len();
        let bi = (((y - self.y0) * self.inv_h).floor().max(0.0) as usize).min(nb - 1);
        let mut par = vec![false; self.n_rings];
        for &(id, a, b) in &self.bins[bi] {
            if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] { par[id as usize] = !par[id as usize]; }
        }
        self.polys.iter().any(|&(f, nh)| par[f as usize] && !(1..=nh).any(|k| par[(f + k) as usize]))
    }
}



// ------------------------------------------------------------------------------------------------ rings
pub fn rings(a: &Polys) -> Vec<&Vec<Pt>> {
    let mut v = Vec::new();
    for p in a { v.push(&p.contour); for h in &p.holes { v.push(h); } }
    v
}

pub fn ring_len(r: &[Pt]) -> f64 {
    let n = r.len();
    (0..n).map(|i| dist(r[i], r[(i + 1) % n])).sum()
}

pub fn dist(a: Pt, b: Pt) -> f64 { (a[0] - b[0]).hypot(a[1] - b[1]) }

pub fn poly_len(pl: &[Pt]) -> f64 { pl.windows(2).map(|w| dist(w[0], w[1])).sum() }

// ------------------------------------------------------------------------------------------------ polyline clipping
/// Intersection parameter of segment p->q with segment a->b, both in (0,1) (touching endpoints count).
fn seg_isect(p: Pt, q: Pt, a: Pt, b: Pt) -> Option<f64> {
    let r = [q[0] - p[0], q[1] - p[1]];
    let s = [b[0] - a[0], b[1] - a[1]];
    let den = r[0] * s[1] - r[1] * s[0];
    if den.abs() < 1e-14 { return None; }
    let ap = [a[0] - p[0], a[1] - p[1]];
    let t = (ap[0] * s[1] - ap[1] * s[0]) / den;
    let w = (ap[0] * r[1] - ap[1] * r[0]) / den;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&w) { Some(t) } else { None }
}

/// Split the open polyline `pl` at every crossing with the edges of `region` and keep the pieces whose midpoint is
/// `keep_inside` (true) or outside (false) the region. Pieces of consecutive kept segments are re-joined.
pub fn clip_polyline(pl: &[Pt], region: &Polys, keep_inside: bool) -> Vec<Vec<Pt>> {
    let mut out: Vec<Vec<Pt>> = Vec::new();
    if pl.len() < 2 { return out; }
    if region.is_empty() { return if keep_inside { out } else { vec![pl.to_vec()] }; }
    let rs = rings(region);
    let mut cur: Vec<Pt> = Vec::new();
    for w in pl.windows(2) {
        let (p, q) = (w[0], w[1]);
        let (minx, maxx, miny, maxy) = (p[0].min(q[0]), p[0].max(q[0]), p[1].min(q[1]), p[1].max(q[1]));
        let mut ts: Vec<f64> = vec![0.0, 1.0];
        for r in &rs {
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + 1) % n]);
                if a[0].max(b[0]) < minx || a[0].min(b[0]) > maxx || a[1].max(b[1]) < miny || a[1].min(b[1]) > maxy { continue; }
                if let Some(t) = seg_isect(p, q, a, b) { ts.push(t); }
            }
        }
        ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        for k in 0..ts.len() - 1 {
            let (t0, t1) = (ts[k], ts[k + 1]);
            if t1 - t0 < 1e-9 { continue; }
            let pa = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0];
            let pb = [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
            let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
            let ins = inside(region, mid[0], mid[1]);
            if ins == keep_inside {
                if cur.last().map_or(true, |l| dist(*l, pa) > 1e-7) {
                    if !cur.is_empty() { out.push(std::mem::take(&mut cur)); }
                    cur.push(pa);
                }
                cur.push(pb);
            } else if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out.into_iter().filter(|p| p.len() >= 2 && poly_len(p) > 1e-7).collect()
}

/// Same for a closed ring (treated as a polyline that returns to its first point).
pub fn clip_ring(ring: &[Pt], region: &Polys, keep_inside: bool) -> Vec<Vec<Pt>> {
    let mut c = ring.to_vec();
    if let Some(f) = c.first().copied() { c.push(f); }
    clip_polyline(&c, region, keep_inside)
}

// ------------------------------------------------------------------------------------------------ misc geometry
pub fn rot(p: Pt, c: f64, s: f64) -> Pt { [p[0] * c - p[1] * s, p[0] * s + p[1] * c] }

pub fn rotate_polys(a: &Polys, ang: f64) -> Polys {
    let (c, s) = (ang.cos(), ang.sin());
    a.iter().map(|q| Poly {
        contour: q.contour.iter().map(|&p| rot(p, c, s)).collect(),
        holes: q.holes.iter().map(|h| h.iter().map(|&p| rot(p, c, s)).collect()).collect(),
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polys {
        vec![Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }]
    }
    #[test]
    fn booleans_normalise_overlapping_soup() {
        let mut soup = rect(0.0, 0.0, 10.0, 10.0);
        soup.extend(rect(5.0, 0.0, 15.0, 10.0));
        // without the union an even-odd overlay would punch a hole in the overlap
        assert!((area(&df(&soup, &rect(0.0, 0.0, 1.0, 1.0))) - 149.0).abs() < 1e-6);
    }
    #[test]
    fn polyline_clip() {
        let r = rect(0.0, 0.0, 10.0, 10.0);
        let pieces = clip_polyline(&[[-5.0, 5.0], [15.0, 5.0]], &r, true);
        assert_eq!(pieces.len(), 1);
        assert!((poly_len(&pieces[0]) - 10.0).abs() < 1e-9);
        let outside = clip_polyline(&[[-5.0, 5.0], [15.0, 5.0]], &r, false);
        assert_eq!(outside.len(), 2);
        assert!((outside.iter().map(|p| poly_len(p)).sum::<f64>() - 10.0).abs() < 1e-9);
    }
}

/// Signed area of one ring (positive = CCW).
pub fn ring_area(r: &[Pt]) -> f64 { g::ring_area(r) }

