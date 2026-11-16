//! Lane 2: wall generation (`wall_generator = classic`) and the geometry both wall generators share.
//!
//! PUBLIC API
//!   * `generate_walls(region, lower, upper, &WallParams) -> Result<WallResult, FdmError>` - one layer, all islands.
//!     `region` = the layer's slices (`Layer::region`), `lower`/`upper` = the union of the layer below / above
//!     (`None` on the bottom / top layer: Orca's `lower_slices`/`upper_slices == nullptr`). Dispatches on
//!     `WallParams::generator` to `generate_classic` (this file) or `arachne::generate_arachne`.
//!   * `WallParams::from_config(&Config, layer_id, layer_h)`: strict (a missing key is an error); `WallParams::default()`.
//!   * `WallResult { paths, infill_region, infill_no_overlap }`: `paths` in print order (walls, then each island's
//!     `Feature::GapInfill` paths), `infill_region` = Orca `fill_surfaces`, `infill_no_overlap` = `fill_no_overlap`.
//!   * `medial_axis`, `variable_width`, `Flow`, `ThickPolyline`, `geo::*` (Clipper-faithful offset, booleans, DP simplify).
//!
//! Contents: the classic generator (`PerimeterGenerator::process_classic`: wall onion, thin walls, narrow-loop
//! smaller-width walls, gap fill, only_one_wall_top, extra/alternate walls, overhang walls, wall sequences, precise outer
//! wall, infill-wall overlap), the medial axis used for thin walls and gap fill (`Geometry/MedialAxis.cpp` on top of
//! `boostvoronoi`), `VariableWidth.cpp`, and `geo` (a port of ClipperLib::ClipperOffset: jtMiter, limit 3).
//!
//! NOT implemented (refused with `FdmError::Unsupported`, never approximated): fuzzy skin (lane 7 owns it),
//! `overhang_reverse`, `extra_perimeters_on_overhangs`, `counterbore_hole_bridging`.
//! Approximated and measured: island/loop chaining order (greedy nearest-endpoint instead of Orca's exact
//! `chain_segments_greedy` tie-breaking); seam/start points are lane 5's (loops start at the polygon's first vertex).
//!
//! Units: millimetres, f64. Orca works in 1e-6 mm integers; every threshold that Orca expresses in scaled units is
//! expressed here in mm with the same value (`SCALED_EPSILON` = 1e-4 mm, `ClipperSafetyOffset` = 1e-5 mm, ...).
//!
//! PathPt.w convention: the Orca extrusion WIDTH of the bead (what `; WIDTH:` reports), i.e. the flow width. The bead
//! cross-section is (w - h*(1-pi/4))*h with h = ExtPath.layer_h, and the centre-to-centre spacing of two such beads is
//! w - h*(1-pi/4). Overhang walls carry the (round) overhang flow: layer_h = overhang_height, w = overhang_width.
//!
//! Orca references: PerimeterGenerator.cpp (process_classic, traverse_loops, split_top_surfaces), Geometry/MedialAxis.cpp,
//! ExPolygon.cpp (medial_axis), VariableWidth.cpp, Flow.cpp, ClipperLib offset.


use crate::config::Config;
use crate::types::*;
use std::collections::BTreeMap;
use std::f64::consts::PI;

pub const SCALED_EPSILON: f64 = 1e-4; // scale_(EPSILON)
pub const CLIPPER_SAFETY_OFFSET: f64 = 1e-5; // 10 scaled units
pub const INSET_OVERLAP_TOLERANCE: f64 = 0.4;
const SMALLER_EXT_INSET_OVERLAP_TOLERANCE: f64 = 0.22;
const NARROW_LOOP_LENGTH_THRESHOLD: f64 = 10.0;

pub type P2 = [f64; 2];


// =====================================================================================================================
// geometry helpers
// =====================================================================================================================
pub mod geo {
    use super::*;
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::core::overlay_rule::OverlayRule;
    use i_overlay::float::single::SingleFloatOverlay;

    type Shapes = Vec<Vec<Vec<P2>>>;

    pub fn ring_area(r: &[P2]) -> f64 {
        let n = r.len();
        let mut a = 0.0;
        for i in 0..n {
            let (p, q) = (r[i], r[(i + 1) % n]);
            a += p[0] * q[1] - q[0] * p[1];
        }
        0.5 * a
    }
    pub fn poly_area(p: &Poly) -> f64 {
        ring_area(&p.contour).abs() - p.holes.iter().map(|h| ring_area(h).abs()).sum::<f64>()
    }
    pub fn polys_area(p: &Polys) -> f64 {
        p.iter().map(poly_area).sum()
    }
    /// Drop duplicate and (numerically) collinear vertices: i_overlay's outline emits three collinear points per miter
    /// join, and feeding those back into another offset makes the next miter peaks noisy.
    pub fn clean_ring(r: &[P2]) -> Vec<P2> {
        // Near-duplicate vertices (slicer output carries pairs ~6e-8 mm apart, f32 noise) are merged at Clipper's own
        // integer resolution (1e-6 mm). With the old 1e-9 tolerance such a pair survived and the collinear pass below
        // removed BOTH members at once (each judged against the other as a neighbour), deleting the corner entirely.
        const DUP: f64 = 5e-7;
        let mut v: Vec<P2> = Vec::with_capacity(r.len());
        for &p in r {
            if v.last().map_or(true, |q| (q[0] - p[0]).abs() > DUP || (q[1] - p[1]).abs() > DUP) {
                v.push(p);
            }
        }
        while v.len() > 1 && (v[0][0] - v[v.len() - 1][0]).abs() <= DUP && (v[0][1] - v[v.len() - 1][1]).abs() <= DUP {
            v.pop();
        }
        loop {
            let n = v.len();
            if n < 4 {
                break;
            }
            let mut out: Vec<P2> = Vec::with_capacity(n);
            let mut removed = false;
            let mut prev_removed = false;
            let mut first_removed = false;
            for i in 0..n {
                let (a, b, c) = (v[(i + n - 1) % n], v[i], v[(i + 1) % n]);
                let (abx, aby, acx, acy) = (b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
                let l = (acx * acx + acy * acy).sqrt();
                let cross = (abx * acy - aby * acx).abs();
                let dot = abx * acx + aby * acy;
                // never remove two neighbours in one pass: each is judged against the other
                if !prev_removed && l > 0.0 && cross / l < 2e-7 && dot > 0.0 && dot < l * l && !(i == n - 1 && first_removed) {
                    removed = true;
                    prev_removed = true;
                    if i == 0 {
                        first_removed = true;
                    }
                    continue;
                }
                prev_removed = false;
                out.push(b);
            }
            v = out;
            if !removed {
                break;
            }
        }
        v
    }
    fn removed_adjacent(_out: &[P2], _b: P2) -> bool {
        false
    }
    fn to_shapes(p: &Polys) -> Shapes {
        p.iter()
            .filter(|q| q.contour.len() >= 3)
            .map(|q| {
                let mut s = vec![clean_ring(&q.contour)];
                for h in &q.holes {
                    if h.len() >= 3 {
                        s.push(clean_ring(h));
                    }
                }
                s
            })
            .filter(|s| s[0].len() >= 3)
            .collect()
    }
    fn from_shapes(s: Shapes) -> Polys {
        s.into_iter()
            .filter(|sh| !sh.is_empty())
            .map(|mut sh| {
                let contour = clean_ring(&sh.remove(0));
                Poly { contour, holes: sh.into_iter().map(|h| clean_ring(&h)).filter(|h| h.len() >= 3).collect() }
            })
            .filter(|p| p.contour.len() >= 3)
            .collect()
    }
    fn ov(a: &Polys, b: &Polys, rule: OverlayRule) -> Polys {
        let sa = to_shapes(a);
        let sb = to_shapes(b);
        if sa.is_empty() {
            return match rule {
                OverlayRule::Union | OverlayRule::Xor => union(b),
                _ => vec![],
            };
        }
        if sb.is_empty() {
            return match rule {
                OverlayRule::Union | OverlayRule::Xor | OverlayRule::Difference => union(a),
                _ => vec![],
            };
        }
        from_shapes(sa.overlay(&sb, rule, FillRule::NonZero))
    }
    pub fn union(a: &Polys) -> Polys {
        let sa = to_shapes(a);
        if sa.is_empty() {
            return vec![];
        }
        let empty: Shapes = vec![];
        from_shapes(sa.overlay(&empty, OverlayRule::Union, FillRule::NonZero))
    }
    pub fn union2(a: &Polys, b: &Polys) -> Polys {
        ov(a, b, OverlayRule::Union)
    }
    pub fn diff(a: &Polys, b: &Polys) -> Polys {
        ov(a, b, OverlayRule::Difference)
    }
    pub fn inter(a: &Polys, b: &Polys) -> Polys {
        ov(a, b, OverlayRule::Intersect)
    }
    /// Orca `ApplySafetyOffset::Yes`: grow the clip by `CLIPPER_SAFETY_OFFSET` before subtracting.
    pub fn diff_safe(a: &Polys, b: &Polys) -> Polys {
        diff(a, &offset(b, CLIPPER_SAFETY_OFFSET))
    }

    /// Clipper `offset` with jtMiter, miter limit 3 (ClipperUtils DefaultJoinType / DefaultMiterLimit).
    pub fn offset(p: &Polys, d: f64) -> Polys {
        offset_join(p, d, true)
    }
    /// A port of ClipperLib::ClipperOffset (jtMiter with limit 3, or jtSquare with limit 0): raw per-vertex offset rings
    /// cleaned with a positive-fill union. A negative delta is done on the complement inside a bounding box, which is
    /// the same union that Clipper runs with its reversed outer rectangle and pftNegative.
    pub fn offset_join(p: &Polys, d: f64, miter: bool) -> Polys {
        if p.is_empty() {
            return vec![];
        }
        if d == 0.0 {
            return union(p);
        }
        if d > 0.0 {
            return offset_pos(p, d, miter);
        }
        let Some(b) = bbox(p) else { return vec![] };
        let m = -d * 4.0 + 1.0;
        let rect = vec![Poly { contour: vec![[b[0] - m, b[1] - m], [b[2] + m, b[1] - m], [b[2] + m, b[3] + m], [b[0] - m, b[3] + m]], holes: vec![] }];
        let comp = diff(&rect, p);
        let grown = offset_pos(&comp, -d, miter);
        // keep only what lies inside the (slightly shrunk) rectangle: the rectangle border itself never touches the part
        let inner = vec![Poly { contour: vec![[b[0] - m / 2.0, b[1] - m / 2.0], [b[2] + m / 2.0, b[1] - m / 2.0], [b[2] + m / 2.0, b[3] + m / 2.0], [b[0] - m / 2.0, b[3] + m / 2.0]], holes: vec![] }];
        inter(&diff(&inner, &grown), &inner)
    }
    fn offset_pos(p: &Polys, d: f64, miter: bool) -> Polys {
        let mut rings: Vec<Vec<P2>> = vec![];
        let lim = if miter { 2.0 / (3.0 * 3.0) } else { 0.5 };
        for q in p {
            let mut c = clean_ring(&q.contour);
            if c.len() < 3 {
                continue;
            }
            if ring_area(&c) < 0.0 {
                c.reverse();
            }
            rings.push(offset_ring(&c, d, lim, miter));
            for h in &q.holes {
                let mut hh = clean_ring(h);
                if hh.len() < 3 {
                    continue;
                }
                if ring_area(&hh) > 0.0 {
                    hh.reverse();
                }
                rings.push(offset_ring(&hh, d, lim, miter));
            }
        }
        if rings.is_empty() {
            return vec![];
        }
        let empty: Vec<Vec<P2>> = vec![];
        from_shapes(rings.overlay(&empty, OverlayRule::Subject, FillRule::Positive))
    }
    /// ClipperOffset::DoOffset for one closed ring; `right-hand normal` points away from the solid for both outer
    /// (CCW) and hole (CW) rings.
    fn offset_ring(r: &[P2], delta: f64, miter_lim: f64, miter: bool) -> Vec<P2> {
        let n = r.len();
        let mut normals: Vec<P2> = Vec::with_capacity(n);
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l = (dx * dx + dy * dy).sqrt();
            normals.push(if l > 0.0 { [dy / l, -dx / l] } else { [0.0, 0.0] });
        }
        let mut out: Vec<P2> = Vec::with_capacity(n * 2);
        let mut k = n - 1;
        for j in 0..n {
            let (nk, nj) = (normals[k], normals[j]);
            let p = r[j];
            let mut sin_a = nk[0] * nj[1] - nj[0] * nk[1];
            let cos_a = nk[0] * nj[0] + nj[1] * nk[1];
            if (sin_a * delta).abs() < 1e-6 {
                if cos_a > 0.0 {
                    out.push([p[0] + nk[0] * delta, p[1] + nk[1] * delta]);
                    k = j;
                    continue;
                }
            } else if sin_a > 1.0 {
                sin_a = 1.0;
            } else if sin_a < -1.0 {
                sin_a = -1.0;
            }
            if sin_a * delta < 0.0 {
                out.push([p[0] + nk[0] * delta, p[1] + nk[1] * delta]);
                out.push(p);
                out.push([p[0] + nj[0] * delta, p[1] + nj[1] * delta]);
            } else {
                let r_ = 1.0 + (nj[0] * nk[0] + nj[1] * nk[1]);
                if miter && r_ >= miter_lim {
                    let q = delta / r_;
                    out.push([p[0] + (nk[0] + nj[0]) * q, p[1] + (nk[1] + nj[1]) * q]);
                } else {
                    let dx = (sin_a.atan2(cos_a) / 4.0).tan();
                    out.push([p[0] + delta * (nk[0] - nk[1] * dx), p[1] + delta * (nk[1] + nk[0] * dx)]);
                    out.push([p[0] + delta * (nj[0] + nj[1] * dx), p[1] + delta * (nj[1] - nj[0] * dx)]);
                }
            }
            k = j;
        }
        out
    }
    pub fn offset2(p: &Polys, d1: f64, d2: f64) -> Polys {
        let a = offset(p, d1);
        if a.is_empty() {
            return a;
        }
        offset(&a, d2)
    }
    pub fn opening(p: &Polys, r: f64) -> Polys {
        offset2(p, -r, r)
    }

    // ---- point / segment predicates ----
    pub fn dist_pt_seg(p: P2, a: P2, b: P2) -> f64 {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (cx, cy) = (a[0] + t * dx, a[1] + t * dy);
        ((p[0] - cx).powi(2) + (p[1] - cy).powi(2)).sqrt()
    }
    pub fn ring_contains(r: &[P2], p: P2) -> bool {
        // even-odd crossing test (border result unspecified)
        let n = r.len();
        let mut inside = false;
        let mut j = n - 1;
        for i in 0..n {
            let (a, b) = (r[i], r[j]);
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
            j = i;
        }
        inside
    }
    pub fn poly_contains(q: &Poly, p: P2) -> bool {
        ring_contains(&q.contour, p) && !q.holes.iter().any(|h| ring_contains(h, p))
    }
    pub fn region_contains(r: &Polys, p: P2) -> bool {
        r.iter().any(|q| poly_contains(q, p))
    }
    pub fn dist_to_ring(r: &[P2], p: P2) -> f64 {
        let n = r.len();
        (0..n).map(|i| dist_pt_seg(p, r[i], r[(i + 1) % n])).fold(f64::INFINITY, f64::min)
    }
    pub fn on_boundary(q: &Poly, p: P2, eps: f64) -> bool {
        dist_to_ring(&q.contour, p) < eps || q.holes.iter().any(|h| dist_to_ring(h, p) < eps)
    }
    pub fn region_dist_to_boundary(r: &Polys, p: P2) -> f64 {
        let mut d = f64::INFINITY;
        for q in r {
            d = d.min(dist_to_ring(&q.contour, p));
            for h in &q.holes {
                d = d.min(dist_to_ring(h, p));
            }
        }
        d
    }
    /// Segment/segment intersection (Slic3r Line::intersection semantics: proper or touching, not parallel).
    pub fn seg_intersection(a: P2, b: P2, c: P2, d: P2) -> Option<P2> {
        let (r0, r1) = (b[0] - a[0], b[1] - a[1]);
        let (s0, s1) = (d[0] - c[0], d[1] - c[1]);
        let den = r0 * s1 - r1 * s0;
        if den.abs() < 1e-18 {
            return None;
        }
        let t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den;
        let u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
        if (-1e-9..=1.0 + 1e-9).contains(&t) && (-1e-9..=1.0 + 1e-9).contains(&u) {
            Some([a[0] + t * r0, a[1] + t * r1])
        } else {
            None
        }
    }
    pub fn len(a: P2, b: P2) -> f64 {
        ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
    }
    pub fn path_length(p: &[P2], closed: bool) -> f64 {
        let mut s: f64 = p.windows(2).map(|w| len(w[0], w[1])).sum();
        if closed && p.len() > 1 {
            s += len(p[p.len() - 1], p[0]);
        }
        s
    }

    /// Douglas-Peucker as libslic3r `MultiPoint::_douglas_peucker` (anchor/floater iterative form).
    pub fn douglas_peucker(pts: &[P2], tol: f64) -> Vec<P2> {
        if pts.len() < 3 {
            return pts.to_vec();
        }
        let tol2 = tol * tol;
        let mut out = vec![pts[0]];
        let mut anchor = 0usize;
        let mut floater = pts.len() - 1;
        let mut stack: Vec<usize> = vec![floater];
        loop {
            let (a, f) = (pts[anchor], pts[floater]);
            let (dx, dy) = (f[0] - a[0], f[1] - a[1]);
            let l2 = dx * dx + dy * dy;
            let mut max_d2 = 0.0;
            let mut furthest = anchor;
            for i in anchor + 1..floater {
                let p = pts[i];
                let d2 = if l2 == 0.0 {
                    (p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)
                } else {
                    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
                    let t = t.clamp(0.0, 1.0);
                    (p[0] - (a[0] + t * dx)).powi(2) + (p[1] - (a[1] + t * dy)).powi(2)
                };
                if d2 > max_d2 {
                    max_d2 = d2;
                    furthest = i;
                }
            }
            if max_d2 <= tol2 {
                out.push(f);
                anchor = floater;
                stack.pop();
                match stack.last() {
                    Some(&n) => floater = n,
                    None => break,
                }
            } else {
                floater = furthest;
                stack.push(floater);
            }
        }
        out
    }
    /// ExPolygon::simplify_p: closed rings through DP (the first point is appended then dropped).
    pub fn simplify_ring(r: &[P2], tol: f64) -> Vec<P2> {
        if r.len() < 4 {
            return r.to_vec();
        }
        let mut v = r.to_vec();
        v.push(r[0]);
        let mut s = douglas_peucker(&v, tol);
        s.pop();
        s
    }
    pub fn simplify_polys(p: &Polys, tol: f64) -> Polys {
        let mut out: Polys = vec![];
        for q in p {
            let c = simplify_ring(&q.contour, tol);
            if c.len() < 3 {
                continue;
            }
            let holes = q.holes.iter().map(|h| simplify_ring(h, tol)).filter(|h| h.len() >= 3).collect();
            out.push(Poly { contour: c, holes });
        }
        out
    }
    pub fn bbox(r: &Polys) -> Option<[f64; 4]> {
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        let mut any = false;
        for q in r {
            for p in &q.contour {
                any = true;
                b[0] = b[0].min(p[0]);
                b[1] = b[1].min(p[1]);
                b[2] = b[2].max(p[0]);
                b[3] = b[3].max(p[1]);
            }
        }
        any.then_some(b)
    }
    pub fn to_rings(p: &Polys) -> Vec<Vec<P2>> {
        let mut v = vec![];
        for q in p {
            v.push(q.contour.clone());
            for h in &q.holes {
                v.push(h.clone());
            }
        }
        v
    }

    /// Spatial index over the boundary of a region. Every query answers EXACTLY what the brute-force functions
    /// (`seg_intersection` over all edges, `region_contains`, `region_dist_to_boundary(..) < eps`) answer: only edges that
    /// cannot affect the result are skipped, the surviving edges are evaluated with the same arithmetic.
    pub struct RegionIndex<'a> {
        region: &'a Polys,
        edges: Vec<(P2, P2)>,
        gx0: f64,
        gy0: f64,
        cell: f64,
        nx: usize,
        ny: usize,
        cells: Vec<Vec<u32>>,
        /// per ring (poly-major: contour, holes...): y bucket -> edge (a, b) = (r[i], r[i-1]) pairs, as `ring_contains` walks them
        rings: Vec<Vec<Vec<(P2, P2)>>>,
        ring_poly: Vec<(usize, bool)>,
        ry0: f64,
        rch: f64,
    }
    impl<'a> RegionIndex<'a> {
        pub fn new(region: &'a Polys) -> RegionIndex<'a> {
            let mut edges: Vec<(P2, P2)> = vec![];
            for q in region {
                for r in std::iter::once(&q.contour).chain(q.holes.iter()) {
                    let m = r.len();
                    for i in 0..m {
                        edges.push((r[i], r[(i + 1) % m]));
                    }
                }
            }
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for e in &edges {
                for p in [e.0, e.1] {
                    x0 = x0.min(p[0]);
                    y0 = y0.min(p[1]);
                    x1 = x1.max(p[0]);
                    y1 = y1.max(p[1]);
                }
            }
            if edges.is_empty() {
                x0 = 0.0;
                y0 = 0.0;
                x1 = 0.0;
                y1 = 0.0;
            }
            let (x0, y0) = (x0 - 1e-5, y0 - 1e-5);
            let mut cell = 1.0f64;
            while ((x1 - x0) / cell + 2.0) * ((y1 - y0) / cell + 2.0) > 250_000.0 {
                cell *= 2.0;
            }
            let nx = ((x1 - x0) / cell) as usize + 2;
            let ny = ((y1 - y0) / cell) as usize + 2;
            let mut cells: Vec<Vec<u32>> = vec![vec![]; nx * ny];
            let pad = 1e-6;
            for (k, e) in edges.iter().enumerate() {
                let (ax, bx) = (e.0[0].min(e.1[0]) - pad, e.0[0].max(e.1[0]) + pad);
                let (ay, by) = (e.0[1].min(e.1[1]) - pad, e.0[1].max(e.1[1]) + pad);
                let (ix0, ix1) = (((ax - x0) / cell).floor().max(0.0) as usize, (((bx - x0) / cell).floor() as usize).min(nx - 1));
                let (iy0, iy1) = (((ay - y0) / cell).floor().max(0.0) as usize, (((by - y0) / cell).floor() as usize).min(ny - 1));
                for iy in iy0..=iy1 {
                    for ix in ix0..=ix1 {
                        cells[iy * nx + ix].push(k as u32);
                    }
                }
            }
            let rch = 1.0f64;
            let mut rings = vec![];
            let mut ring_poly = vec![];
            for (pi, q) in region.iter().enumerate() {
                for (ri, r) in std::iter::once(&q.contour).chain(q.holes.iter()).enumerate() {
                    let n = r.len();
                    let nb = ((y1 - y0) / rch) as usize + 2;
                    let mut b: Vec<Vec<(P2, P2)>> = vec![vec![]; nb];
                    if n > 0 {
                        let mut j = n - 1;
                        for i in 0..n {
                            let (a, bb) = (r[i], r[j]);
                            let (lo, hi) = (a[1].min(bb[1]), a[1].max(bb[1]));
                            let (i0, i1) = ((((lo - y0) / rch).floor().max(0.0)) as usize, ((((hi - y0) / rch).floor().max(0.0)) as usize).min(nb - 1));
                            for k in i0..=i1 {
                                b[k].push((a, bb));
                            }
                            j = i;
                        }
                    }
                    rings.push(b);
                    ring_poly.push((pi, ri > 0));
                }
            }
            RegionIndex { region, edges, gx0: x0, gy0: y0, cell, nx, ny, cells, rings, ring_poly, ry0: y0, rch }
        }
        fn cand_box(&self, lox: f64, loy: f64, hix: f64, hiy: f64, pad: f64, out: &mut Vec<u32>) {
            out.clear();
            let ix0 = (((lox - pad - self.gx0) / self.cell).floor().max(0.0)) as usize;
            let iy0 = (((loy - pad - self.gy0) / self.cell).floor().max(0.0)) as usize;
            let fx1 = ((hix + pad - self.gx0) / self.cell).floor();
            let fy1 = ((hiy + pad - self.gy0) / self.cell).floor();
            if fx1 < 0.0 || fy1 < 0.0 {
                return;
            }
            if ix0 >= self.nx || iy0 >= self.ny {
                return;
            }
            let ix1 = (fx1 as usize).min(self.nx - 1);
            let iy1 = (fy1 as usize).min(self.ny - 1);
            for iy in iy0..=iy1 {
                for ix in ix0..=ix1 {
                    out.extend_from_slice(&self.cells[iy * self.nx + ix]);
                }
            }
            out.sort_unstable();
            out.dedup();
        }
        /// Edges whose `seg_intersection(a, b, edge)` can be `Some` (bbox overlap + the 1e-9 parameter tolerance, padded).
        pub fn seg_candidates(&self, a: P2, b: P2, out: &mut Vec<u32>) {
            self.cand_box(a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1]), 1e-6, out);
        }
        pub fn edge(&self, k: u32) -> (P2, P2) {
            self.edges[k as usize]
        }
        fn ring_contains_idx(&self, ri: usize, p: P2) -> bool {
            let b = &self.rings[ri];
            let k = ((p[1] - self.ry0) / self.rch).floor();
            if k < 0.0 || k as usize >= b.len() {
                return false;
            }
            let mut inside = false;
            for &(a, bb) in &b[k as usize] {
                if (a[1] > p[1]) != (bb[1] > p[1]) && p[0] < (bb[0] - a[0]) * (p[1] - a[1]) / (bb[1] - a[1]) + a[0] {
                    inside = !inside;
                }
            }
            inside
        }
        /// == `region_contains(region, p)`
        pub fn contains(&self, p: P2) -> bool {
            let mut ri = 0;
            while ri < self.rings.len() {
                // ring_poly[ri] is a contour; its holes follow
                let mut rj = ri + 1;
                while rj < self.rings.len() && self.ring_poly[rj].1 {
                    rj += 1;
                }
                if self.ring_contains_idx(ri, p) && !(ri + 1..rj).any(|h| self.ring_contains_idx(h, p)) {
                    return true;
                }
                ri = rj;
            }
            false
        }
        /// == `region_dist_to_boundary(region, p) < eps` for eps <= 1e-6
        pub fn near_boundary(&self, p: P2, eps: f64) -> bool {
            let mut c = vec![];
            self.cand_box(p[0], p[1], p[0], p[1], 1e-6, &mut c);
            c.iter().any(|&k| {
                let (a, b) = self.edges[k as usize];
                dist_pt_seg(p, a, b) < eps
            })
        }
    }

    /// Split a closed ring (starting at its first point, closed back to it) into the pieces inside and outside `region`,
    /// in ring order. Mirrors `intersection_pl({polygon}, region)` / `diff_pl({polygon}, region)`: the ring is cut at its
    /// first point, so a run that straddles the start point comes back as two pieces.
    /// Returns (inside pieces, outside pieces, whole_ring_inside, whole_ring_outside).
    pub fn split_ring_by_region(ring: &[P2], region: &Polys) -> (Vec<Vec<P2>>, Vec<Vec<P2>>) {
        let n = ring.len();
        let idx = RegionIndex::new(region);
        let mut cand: Vec<u32> = vec![];

        // build (point, inside_after) pieces
        let mut inside: Vec<Vec<P2>> = vec![];
        let mut outside: Vec<Vec<P2>> = vec![];
        let mut cur: Vec<P2> = vec![];
        let mut cur_in: Option<bool> = None;
        let push_piece = |cur: &mut Vec<P2>, cur_in: Option<bool>, inside: &mut Vec<Vec<P2>>, outside: &mut Vec<Vec<P2>>| {
            if cur.len() >= 2 {
                if cur_in == Some(true) {
                    inside.push(std::mem::take(cur));
                } else {
                    outside.push(std::mem::take(cur));
                }
            } else {
                cur.clear();
            }
        };
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            // parameters of intersections of a-b with region edges
            let mut ts: Vec<f64> = vec![0.0, 1.0];
            let l = len(a, b);
            if l > 0.0 {
                idx.seg_candidates(a, b, &mut cand);
                for &ek in &cand {
                    let (c, d) = idx.edge(ek);
                    if let Some(ip) = seg_intersection(a, b, c, d) {
                        let t = len(a, ip) / l;
                        if t > 1e-9 && t < 1.0 - 1e-9 {
                            ts.push(t);
                        }
                    }
                }
            }
            ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
            ts.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
            for w in ts.windows(2) {
                let (t0, t1) = (w[0], w[1]);
                let p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
                let p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
                let mid = [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5];
                let is_in = idx.contains(mid) || idx.near_boundary(mid, 1e-7);
                if cur_in != Some(is_in) {
                    push_piece(&mut cur, cur_in, &mut inside, &mut outside);
                    cur_in = Some(is_in);
                    cur.push(p0);
                }
                cur.push(p1);
            }
        }
        push_piece(&mut cur, cur_in, &mut inside, &mut outside);
        (inside, outside)
    }

    #[cfg(test)]
    pub fn split_ring_by_region_slow(ring: &[P2], region: &Polys) -> (Vec<Vec<P2>>, Vec<Vec<P2>>) {
        let n = ring.len();
        let edges: Vec<(P2, P2)> = region
            .iter()
            .flat_map(|q| {
                let mut v = vec![];
                for r in std::iter::once(&q.contour).chain(q.holes.iter()) {
                    let m = r.len();
                    for i in 0..m {
                        v.push((r[i], r[(i + 1) % m]));
                    }
                }
                v
            })
            .collect();
        // build (point, inside_after) pieces
        let mut inside: Vec<Vec<P2>> = vec![];
        let mut outside: Vec<Vec<P2>> = vec![];
        let mut cur: Vec<P2> = vec![];
        let mut cur_in: Option<bool> = None;
        let push_piece = |cur: &mut Vec<P2>, cur_in: Option<bool>, inside: &mut Vec<Vec<P2>>, outside: &mut Vec<Vec<P2>>| {
            if cur.len() >= 2 {
                if cur_in == Some(true) {
                    inside.push(std::mem::take(cur));
                } else {
                    outside.push(std::mem::take(cur));
                }
            } else {
                cur.clear();
            }
        };
        for i in 0..n {
            let a = ring[i];
            let b = ring[(i + 1) % n];
            // parameters of intersections of a-b with region edges
            let mut ts: Vec<f64> = vec![0.0, 1.0];
            let l = len(a, b);
            if l > 0.0 {
                for &(c, d) in &edges {
                    if let Some(ip) = seg_intersection(a, b, c, d) {
                        let t = len(a, ip) / l;
                        if t > 1e-9 && t < 1.0 - 1e-9 {
                            ts.push(t);
                        }
                    }
                }
            }
            ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
            ts.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
            for w in ts.windows(2) {
                let (t0, t1) = (w[0], w[1]);
                let p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
                let p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
                let mid = [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5];
                let is_in = region_contains(region, mid) || region_dist_to_boundary(region, mid) < 1e-7;
                if cur_in != Some(is_in) {
                    push_piece(&mut cur, cur_in, &mut inside, &mut outside);
                    cur_in = Some(is_in);
                    cur.push(p0);
                }
                cur.push(p1);
            }
        }
        push_piece(&mut cur, cur_in, &mut inside, &mut outside);
        (inside, outside)
    }
}

// =====================================================================================================================
// Voronoi diagram of line segments, flattened out of boostvoronoi's Rc<Cell<..>> wrappers
// =====================================================================================================================
pub mod voro {
    use super::*;
    use boostvoronoi::prelude::*;
    use boostvoronoi::SourceCategory;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Src {
        Segment,
        Start,
        End,
        Point,
    }
    #[derive(Clone, Debug)]
    pub struct VEdge {
        pub cell: usize,
        pub v0: Option<usize>,
        pub twin: usize,
        pub next: usize,
        pub prev: usize,
        pub primary: bool,
        pub curved: bool,
    }
    #[derive(Clone, Debug)]
    pub struct VCell {
        pub src: usize,
        pub cat: Src,
        pub incident_edge: Option<usize>,
    }
    pub struct Vd {
        pub verts: Vec<P2>, // in input (scaled integer) units
        pub edges: Vec<VEdge>,
        pub cells: Vec<VCell>,
    }
    impl Vd {
        pub fn v1(&self, e: usize) -> Option<usize> {
            self.edges[self.edges[e].twin].v0
        }
        pub fn rot_next(&self, e: usize) -> usize {
            self.edges[self.edges[e].prev].twin
        }
        pub fn is_finite(&self, e: usize) -> bool {
            self.edges[e].v0.is_some() && self.v1(e).is_some()
        }
    }
    /// Scale factor mm -> integer input units (same as libslic3r: 1e6).
    pub const SCALE: f64 = 1e6;

    /// Build the Voronoi diagram of the given segments (integer coordinates). Returns None if boostvoronoi fails.
    pub fn build(segs: &[[i64; 4]]) -> Option<Vd> {
        let lines: Vec<Line<i64>> = segs.iter().map(|s| Line::from([s[0], s[1], s[2], s[3]])).collect();
        let d = Builder::<i64, f64>::default().with_segments(lines.iter()).ok()?.build().ok()?;
        let verts: Vec<P2> = d.vertices().iter().map(|v| { let v = v.get(); [v.x(), v.y()] }).collect();
        let mut edges = Vec::with_capacity(d.edges().len());
        for e in d.edges().iter() {
            let e = e.get();
            edges.push(VEdge {
                cell: e.cell().ok()?.0,
                v0: e.vertex0().map(|v| v.0),
                twin: e.twin().ok()?.0,
                next: e.next().ok()?.0,
                prev: e.prev().ok()?.0,
                primary: e.is_primary(),
                curved: e.is_curved(),
            });
        }
        let mut cells = Vec::with_capacity(d.cells().len());
        for c in d.cells().iter() {
            let c = c.get();
            let cat = match c.source_category() {
                SourceCategory::Segment => Src::Segment,
                SourceCategory::SegmentStart => Src::Start,
                SourceCategory::SegmentEnd => Src::End,
                SourceCategory::SinglePoint => Src::Point,
            };
            cells.push(VCell { src: c.source_index() as usize, cat, incident_edge: c.get_incident_edge().map(|e| e.0) });
        }
        Some(Vd { verts, edges, cells })
    }
}

// =====================================================================================================================
// MedialAxis (Geometry/MedialAxis.cpp + ExPolygon::medial_axis)
// =====================================================================================================================
#[derive(Clone, Debug)]
pub struct ThickPolyline {
    pub points: Vec<P2>,
    /// two entries per segment: width at its start and at its end (mm)
    pub width: Vec<f64>,
    pub endpoints: (bool, bool),
}
impl ThickPolyline {
    pub fn length(&self) -> f64 {
        geo::path_length(&self.points, false)
    }
    pub fn reverse(&mut self) {
        self.points.reverse();
        self.width.reverse();
        self.endpoints = (self.endpoints.1, self.endpoints.0);
    }
}

#[derive(Clone, Copy, Default)]
struct EdgeData {
    active: bool,
    width_start: f64,
    width_end: f64,
}

/// Rings of an ExPolygon as integer segment list (contour first, then holes), as `ExPolygon::lines()`.
fn expolygon_lines(ex: &Poly) -> Vec<[i64; 4]> {
    let mut v = vec![];
    for r in std::iter::once(&ex.contour).chain(ex.holes.iter()) {
        let pts: Vec<[i64; 2]> = {
            let mut p: Vec<[i64; 2]> = r.iter().map(|q| [(q[0] * voro::SCALE).round() as i64, (q[1] * voro::SCALE).round() as i64]).collect();
            p.dedup();
            if p.len() > 1 && p[0] == p[p.len() - 1] {
                p.pop();
            }
            p
        };
        let n = pts.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            v.push([a[0], a[1], b[0], b[1]]);
        }
    }
    v
}

struct MedialAxis<'a> {
    ex: &'a Poly,
    lines: Vec<[i64; 4]>,
    min_width: f64,
    max_width: f64,
    vd: voro::Vd,
    ed: Vec<EdgeData>,
    // 0 = unknown/outside, 1 = inside, 2 = on contour (per vertex)
    vcat: Vec<u8>,
}

impl<'a> MedialAxis<'a> {
    fn new(min_width: f64, max_width: f64, ex: &'a Poly) -> Option<Self> {
        let lines = expolygon_lines(ex);
        if lines.is_empty() {
            return None;
        }
        let vd = voro::build(&lines).or_else(|| {
            let closed = geo::offset2(&vec![ex.clone()], 0.0, 0.0);
            let _ = closed;
            None
        })?;
        Some(MedialAxis { ex, lines, min_width, max_width, vd, ed: vec![], vcat: vec![] })
    }

    fn seg(&self, cell: usize) -> ([f64; 2], [f64; 2]) {
        let l = self.lines[self.vd.cells[cell].src];
        ([l[0] as f64 / voro::SCALE, l[1] as f64 / voro::SCALE], [l[2] as f64 / voro::SCALE, l[3] as f64 / voro::SCALE])
    }
    fn endpoint(&self, cell: usize) -> P2 {
        let (a, b) = self.seg(cell);
        if self.vd.cells[cell].cat == voro::Src::Start { a } else { b }
    }
    fn vert(&self, v: usize) -> P2 {
        let p = self.vd.verts[v];
        [p[0] / voro::SCALE, p[1] / voro::SCALE]
    }

    /// Replacement for `annotate_inside_outside`: classify every Voronoi vertex by point-in-expolygon.
    fn classify(&mut self) {
        let region = vec![self.ex.clone()];
        self.vcat = (0..self.vd.verts.len())
            .map(|v| {
                let p = self.vert(v);
                let d = geo::region_dist_to_boundary(&region, p);
                if d < 1e-6 {
                    2
                } else if geo::region_contains(&region, p) {
                    1
                } else {
                    0
                }
            })
            .collect();
    }

    fn edge_data(&mut self, e: usize) -> (&mut EdgeData, bool) {
        (&mut self.ed[e / 2], e & 1 != 0)
    }

    fn validate_edge(&mut self, e: usize) -> bool {
        let (v0, v1) = (self.vd.edges[e].v0.unwrap(), self.vd.v1(e).unwrap());
        let line_a = self.vert(v0);
        let line_b = self.vert(v1);
        let line_len = geo::len(line_a, line_b);
        let cell_l = self.vd.edges[e].cell;
        let cell_r = self.vd.edges[self.vd.edges[e].twin].cell;
        let l_seg = self.vd.cells[cell_l].cat == voro::Src::Segment;
        let r_seg = self.vd.cells[cell_r].cat == voro::Src::Segment;
        let (sl_a, sl_b) = self.seg(cell_l);
        let (sr_a, sr_b) = self.seg(cell_r);
        let mut w0 = if r_seg { geo::dist_pt_seg(line_a, sr_a, sr_b) * 2.0 } else { geo::len(self.endpoint(cell_r), line_a) * 2.0 };
        let mut w1 = if l_seg { geo::dist_pt_seg(line_b, sl_a, sl_b) * 2.0 } else { geo::len(self.endpoint(cell_l), line_b) * 2.0 };
        if l_seg && r_seg {
            let orient = |a: P2, b: P2| {
                let mut ang = (b[1] - a[1]).atan2(b[0] - a[0]);
                if ang < 0.0 {
                    ang += 2.0 * PI;
                }
                ang
            };
            let mut angle = (orient(sr_a, sr_b) - orient(sl_a, sl_b)).abs();
            if angle > PI {
                angle = 2.0 * PI - angle;
            }
            if PI - angle > PI / 8.0 && (w0 < SCALED_EPSILON || w1 < SCALED_EPSILON || line_len >= self.min_width) {
                return false;
            }
        } else if w0 < SCALED_EPSILON || w1 < SCALED_EPSILON {
            return false;
        }
        if (w0 >= self.min_width || w1 >= self.min_width) && (w0 <= self.max_width || w1 <= self.max_width) {
            let (ed, second) = self.edge_data(e);
            if second {
                std::mem::swap(&mut w0, &mut w1);
            }
            ed.width_start = w0;
            ed.width_end = w1;
            return true;
        }
        false
    }

    fn process_edge_neighbors(&mut self, mut edge: usize, pl: &mut ThickPolyline) {
        loop {
            let twin = self.vd.edges[edge].twin;
            let mut num = 0;
            let mut first: Option<usize> = None;
            let mut nb = self.vd.rot_next(twin);
            while nb != twin {
                if self.ed[nb / 2].active {
                    if num == 0 {
                        first = Some(nb);
                    }
                    num += 1;
                }
                nb = self.vd.rot_next(nb);
            }
            if num == 1 {
                let f = first.unwrap();
                if self.ed[f / 2].active {
                    self.ed[f / 2].active = false;
                    let v1 = self.vd.v1(f).unwrap();
                    pl.points.push(self.vert(v1));
                    let (ws, we) = (self.ed[f / 2].width_start, self.ed[f / 2].width_end);
                    if f & 1 != 0 {
                        pl.width.push(we);
                        pl.width.push(ws);
                    } else {
                        pl.width.push(ws);
                        pl.width.push(we);
                    }
                    edge = f;
                    continue;
                }
            } else if num == 0 {
                pl.endpoints.1 = true;
            }
            break;
        }
    }

    fn build(&mut self) -> Vec<ThickPolyline> {
        self.classify();
        let ne = self.vd.edges.len();
        self.ed = vec![EdgeData::default(); ne / 2 + 1];
        let mut e = 0;
        while e < ne {
            let ed = &self.vd.edges[e];
            if ed.primary && self.vd.is_finite(e) {
                let (v0, v1) = (ed.v0.unwrap(), self.vd.v1(e).unwrap());
                let finite = |v: usize| self.vd.verts[v][0].is_finite() && self.vd.verts[v][1].is_finite();
                if finite(v0) && finite(v1) && (self.vcat[v0] == 1 || self.vcat[v1] == 1) && self.validate_edge(e) {
                    self.ed[e / 2].active = true;
                }
            }
            e += 2;
        }
        let mut out = vec![];
        let mut seed = 0;
        while seed < ne {
            if self.ed[seed / 2].active {
                self.ed[seed / 2].active = false;
                let (v0, v1) = (self.vd.edges[seed].v0.unwrap(), self.vd.v1(seed).unwrap());
                let mut pl = ThickPolyline {
                    points: vec![self.vert(v0), self.vert(v1)],
                    width: vec![self.ed[seed / 2].width_start, self.ed[seed / 2].width_end],
                    endpoints: (false, false),
                };
                self.process_edge_neighbors(seed, &mut pl);
                let mut rev = ThickPolyline { points: vec![], width: vec![], endpoints: (false, false) };
                let tw = self.vd.edges[seed].twin;
                self.process_edge_neighbors(tw, &mut rev);
                let mut pts: Vec<P2> = rev.points.iter().rev().cloned().collect();
                pts.extend(pl.points.iter());
                let mut w: Vec<f64> = rev.width.iter().rev().cloned().collect();
                w.extend(pl.width.iter());
                pl.points = pts;
                pl.width = w;
                pl.endpoints.0 = rev.endpoints.1;
                if pl.points.first() == pl.points.last() {
                    pl.endpoints = (false, false);
                }
                out.push(pl);
            }
            seed += 2;
        }
        out
    }
}

/// `Polygon::intersection(Line)`: first intersection found, checking the closing edge first.
fn contour_first_intersection(ring: &[P2], a: P2, b: P2) -> Option<P2> {
    let n = ring.len();
    if n < 2 {
        return None;
    }
    if let Some(p) = geo::seg_intersection(ring[0], ring[n - 1], a, b) {
        return Some(p);
    }
    for i in 1..n {
        if let Some(p) = geo::seg_intersection(ring[i - 1], ring[i], a, b) {
            return Some(p);
        }
    }
    None
}

/// `ExPolygon::medial_axis(min_width, max_width)`: thick polylines of the medial axis of one ExPolygon.
pub fn medial_axis(ex: &Poly, min_width: f64, max_width: f64) -> Vec<ThickPolyline> {
    let Some(mut ma) = MedialAxis::new(min_width, max_width, ex) else { return vec![] };
    let mut pp = ma.build();
    let mut max_w = 0.0f64;
    for p in &pp {
        for &w in &p.width {
            max_w = max_w.max(w);
        }
    }
    let mut removed = false;
    let mut i = 0;
    while i < pp.len() {
        let pl = &mut pp[i];
        let mut new_front = pl.points[0];
        let mut new_back = *pl.points.last().unwrap();
        let region = vec![ex.clone()];
        let _ = &region;
        if pl.endpoints.0 && !geo::on_boundary(ex, new_front, SCALED_EPSILON) {
            let mut p1 = pl.points[0];
            let mut p2 = pl.points[1];
            if pl.points.len() == 2 {
                p2 = [(p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5];
            }
            let d = geo::len(p1, p2);
            if d > 0.0 {
                p1 = [p1[0] - (p2[0] - p1[0]) / d * max_width, p1[1] - (p2[1] - p1[1]) / d * max_width];
            }
            if let Some(ip) = contour_first_intersection(&ex.contour, p1, p2) {
                new_front = ip;
            }
        }
        if pl.endpoints.1 && !geo::on_boundary(ex, new_back, SCALED_EPSILON) {
            let n = pl.points.len();
            let mut p1 = pl.points[n - 2];
            let mut p2 = pl.points[n - 1];
            if n == 2 {
                p1 = [(p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5];
            }
            let d = geo::len(p1, p2);
            if d > 0.0 {
                p2 = [p2[0] + (p2[0] - p1[0]) / d * max_width, p2[1] + (p2[1] - p1[1]) / d * max_width];
            }
            if let Some(ip) = contour_first_intersection(&ex.contour, p1, p2) {
                new_back = ip;
            }
        }
        pl.points[0] = new_front;
        let last = pl.points.len() - 1;
        pl.points[last] = new_back;
        if (pl.endpoints.0 || pl.endpoints.1) && pl.length() < max_w * 2.0 {
            pp.remove(i);
            removed = true;
            continue;
        }
        i += 1;
    }
    if removed {
        let mut i = 0;
        while i < pp.len() {
            if pp[i].endpoints.0 && pp[i].endpoints.1 {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < pp.len() {
                let (pf, pl_) = (pp[i].points[0], *pp[i].points.last().unwrap());
                let (of, ol) = (pp[j].points[0], *pp[j].points.last().unwrap());
                if pl_ == ol {
                    pp[j].reverse();
                } else if pf == ol {
                    pp[i].reverse();
                    pp[j].reverse();
                } else if pf == of {
                    pp[i].reverse();
                } else if pl_ != of {
                    j += 1;
                    continue;
                }
                let other = pp.remove(j);
                pp[i].points.extend(other.points.iter().skip(1));
                pp[i].width.extend(other.width.iter());
                pp[i].endpoints.1 = other.endpoints.1;
                j = i + 1;
            }
            i += 1;
        }
    }
    pp
}

// =====================================================================================================================
// VariableWidth.cpp
// =====================================================================================================================
/// A bead flow: Orca `Flow`.
#[derive(Clone, Copy, Debug)]
pub struct Flow {
    pub width: f64,
    pub height: f64,
}
impl Flow {
    pub fn new(width: f64, height: f64) -> Flow {
        Flow { width, height }
    }
    pub fn spacing(&self) -> f64 {
        self.width - self.height * (1.0 - 0.25 * PI)
    }
    pub fn mm3_per_mm(&self) -> f64 {
        self.height * (self.width - self.height * (1.0 - 0.25 * PI))
    }
    pub fn with_width(&self, w: f64) -> Flow {
        Flow { width: w, height: self.height }
    }
}

/// A path before it is turned into an `ExtPath` (global coordinates, one width).
#[derive(Clone, Debug)]
pub struct WPath {
    pub pts: Vec<P2>,
    pub width: f64,
}

/// `thick_polyline_to_extrusion_paths_2`
fn thick_polyline_to_paths(tp: &ThickPolyline, flow: Flow, tolerance: f64) -> Vec<WPath> {
    #[derive(Clone, Copy)]
    struct TL {
        a: P2,
        b: P2,
        aw: f64,
        bw: f64,
    }
    impl TL {
        fn length(&self) -> f64 {
            geo::len(self.a, self.b)
        }
    }
    let mut lines: Vec<TL> = (0..tp.points.len() - 1)
        .map(|i| TL { a: tp.points[i], b: tp.points[i + 1], aw: tp.width[2 * i], bw: tp.width[2 * i + 1] })
        .collect();
    let mut paths: Vec<WPath> = vec![];
    let mut start_index = 0usize;
    let (mut max_width, mut min_width) = (0.0f64, 0.0f64);
    let mut i = 0usize;
    let k = 1.0 - 0.25 * PI;
    while i < lines.len() {
        let line = lines[i];
        if i == 0 {
            max_width = line.aw;
            min_width = line.aw;
        }
        let line_len = line.length();
        if line_len < SCALED_EPSILON {
            i += 1;
            continue;
        }
        let mut thickness_delta = (max_width - line.bw).abs().max((min_width - line.bw).abs());
        if thickness_delta > tolerance {
            if start_index != i {
                let mut length = lines[start_index].length();
                let mut sum = lines[start_index].length() * 0.5 * (lines[start_index].aw + lines[start_index].bw);
                let mut pts = vec![lines[start_index].a];
                for idx in start_index + 1..i {
                    length += lines[idx].length();
                    sum += lines[idx].length() * 0.5 * (lines[idx].aw + lines[idx].bw);
                    pts.push(lines[idx].a);
                }
                pts.push(lines[i].a);
                if length > SCALED_EPSILON {
                    let w = sum / length;
                    paths.push(WPath { pts, width: w + flow.height * k });
                }
            }
            start_index = i;
            max_width = line.aw;
            min_width = line.aw;
            thickness_delta = (line.aw - line.bw).abs();
            if thickness_delta > tolerance {
                let segments = ((thickness_delta / tolerance) + 1e-9).ceil().max(2.0) as usize; // +eps: guarantees sub-delta < tolerance (no re-split loop)
                let seg_len = line_len / segments as f64;
                let mut pp: Vec<P2> = vec![line.a];
                let mut width: Vec<f64> = vec![line.aw];
                let dir = [(line.b[0] - line.a[0]) / line_len, (line.b[1] - line.a[1]) / line_len];
                for j in 1..segments {
                    pp.push([line.a[0] + dir[0] * (j as f64 * seg_len), line.a[1] + dir[1] * (j as f64 * seg_len)]);
                    let w = line.aw + (j as f64 * seg_len) * (line.bw - line.aw) / line_len;
                    width.push(w);
                    width.push(w);
                }
                pp.push(line.b);
                width.push(line.bw);
                lines.remove(i);
                let new: Vec<TL> = (0..segments).map(|j| TL { a: pp[j], b: pp[j + 1], aw: width[2 * j], bw: width[2 * j + 1] }).collect();
                for (j, nl) in new.into_iter().enumerate() {
                    lines.insert(i + j, nl);
                }
                continue; // --i; continue (the for loop increments back to i)
            }
        } else {
            max_width = max_width.max(line.aw.max(line.bw));
            min_width = min_width.min(line.aw.min(line.bw));
        }
        i += 1;
    }
    let final_size = lines.len();
    if start_index < final_size {
        let mut length = lines[start_index].length();
        let mut sum = lines[start_index].length() * lines[start_index].aw;
        let mut pts = vec![lines[start_index].a];
        for idx in start_index + 1..final_size {
            length += lines[idx].length();
            sum += lines[idx].length() * lines[idx].aw;
            pts.push(lines[idx].a);
        }
        pts.push(lines[final_size - 1].b);
        if length > SCALED_EPSILON {
            let w = sum / length;
            paths.push(WPath { pts, width: w + flow.height * k });
        }
    }
    paths
}

/// `variable_width(polylines, role, flow, out)`: each result is either a closed loop (first == last point) or paths.
pub fn variable_width(polylines: &[ThickPolyline], flow: Flow) -> Vec<Vec<WPath>> {
    let tolerance = 0.05;
    let mut out = vec![];
    for p in polylines {
        if p.points.len() < 2 {
            continue;
        }
        let paths = thick_polyline_to_paths(p, flow, tolerance);
        if !paths.is_empty() {
            out.push(paths);
        }
    }
    out
}

// =====================================================================================================================
// parameters / result
// =====================================================================================================================
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WallSequence {
    InnerOuter,
    OuterInner,
    InnerOuterInner,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WallGenerator {
    Classic,
    Arachne,
}

/// Everything the wall generators read from the resolved Orca config for ONE layer. Widths are the flow widths that
/// `PrintRegion::flow()` returns for that layer (so on layer 0 the caller passes `initial_layer_line_width` for all
/// of them, exactly as Orca does).
#[derive(Clone, Debug)]
pub struct WallParams {
    pub generator: WallGenerator,
    pub layer_id: usize,
    pub layer_h: f64,
    pub nozzle: f64,
    // flows (mm)
    pub ext_width: f64,
    pub inner_width: f64,
    pub solid_infill_width: f64,
    pub sparse_infill_width: f64,
    /// Diameter of the round overhang/bridge flow (nozzle * sqrt(bridge_flow) or bridge_line_width); its "height".
    pub overhang_width: f64,
    pub overhang_height: f64,
    // wall options
    pub wall_loops: i32,
    pub wall_sequence: WallSequence,
    pub wall_ccw: bool,
    pub precise_outer_wall: bool,
    pub detect_thin_wall: bool,
    pub only_one_wall_top: bool,
    pub only_one_wall_first_layer: bool,
    pub top_shell_layers: i32,
    pub bottom_shell_layers: i32,
    pub top_surface_density: f64,   // percent 0..100
    pub top_surface_expansion: f64, // mm
    pub alternate_extra_wall: bool,
    pub sparse_infill_density: f64, // percent 0..100
    pub extra_perimeters: i32,      // Surface::extra_perimeters applied to every island
    pub detect_overhang_wall: bool,
    pub raft_layers: usize,
    pub interface_shells: bool,
    pub min_width_top_surface: f64,         // value
    pub min_width_top_surface_percent: bool, // true: value is % of the inner wall width
    // gap fill
    pub gap_infill: bool, // gap_infill_speed > 0
    pub filter_out_gap_fill: f64,
    // infill overlap (percent of the inset + solid spacing/2)
    pub infill_wall_overlap: f64,
    pub top_bottom_infill_wall_overlap: f64,
    // misc
    pub resolution: f64,
    pub enable_arc_fitting: bool,
    pub spiral_vase: bool,
    // options Orca implements that this port refuses instead of approximating
    pub fuzzy_skin: bool,
    pub overhang_reverse: bool,
    pub extra_perimeters_on_overhangs: bool,
    pub counterbore_hole_bridging: bool,
    pub thick_bridges: bool,
    // arachne
    pub min_bead_width: f64,       // mm (absolute; layer 0 carries initial_layer_min_bead_width)
    pub min_feature_size: f64,     // mm (absolute)
    pub wall_transition_length: f64, // mm
    pub wall_transition_angle: f64,  // degrees
    pub wall_transition_filter_deviation: f64, // mm
    pub wall_distribution_count: i32,
    pub wall_maximum_deviation: f64, // mm (meshfix_maximum_deviation)
    pub wall_maximum_resolution: f64, // mm
    pub min_length_factor: f64,
    /// `slice_closing_radius` (mm). Orca closes every sliced layer with offset2(+r, -r); the slicer stage of this crate does
    /// not, so the wall generators close the island set themselves (idempotent if the slicer ever does).
    pub slice_closing_radius: f64,
}

impl Default for WallParams {
    /// Orca defaults for a 0.4 mm nozzle at 0.2 mm layers.
    fn default() -> Self {
        WallParams {
            generator: WallGenerator::Classic,
            layer_id: 1,
            layer_h: 0.2,
            nozzle: 0.4,
            ext_width: 0.42,
            inner_width: 0.45,
            solid_infill_width: 0.42,
            sparse_infill_width: 0.45,
            overhang_width: 0.4,
            overhang_height: 0.4,
            wall_loops: 2,
            wall_sequence: WallSequence::InnerOuter,
            wall_ccw: true,
            precise_outer_wall: false,
            detect_thin_wall: false,
            only_one_wall_top: false,
            only_one_wall_first_layer: false,
            top_shell_layers: 5,
            bottom_shell_layers: 3,
            top_surface_density: 100.0,
            top_surface_expansion: 0.0,
            alternate_extra_wall: false,
            sparse_infill_density: 15.0,
            extra_perimeters: 0,
            detect_overhang_wall: true,
            raft_layers: 0,
            interface_shells: false,
            min_width_top_surface: 300.0,
            min_width_top_surface_percent: true,
            gap_infill: true,
            filter_out_gap_fill: 0.0,
            infill_wall_overlap: 15.0,
            top_bottom_infill_wall_overlap: 25.0,
            resolution: 0.012,
            enable_arc_fitting: false,
            spiral_vase: false,
            fuzzy_skin: false,
            overhang_reverse: false,
            extra_perimeters_on_overhangs: false,
            counterbore_hole_bridging: false,
            thick_bridges: false,
            slice_closing_radius: 0.0,
            min_bead_width: 0.34,
            min_feature_size: 0.1,
            wall_transition_length: 0.4,
            wall_transition_angle: 10.0,
            wall_transition_filter_deviation: 0.1,
            wall_distribution_count: 1,
            wall_maximum_deviation: 0.025,
            wall_maximum_resolution: 0.5,
            min_length_factor: 0.5,
        }
    }
}

impl WallParams {
    /// Build the per-layer parameters from a resolved Orca `Config` (strict: a missing key is an error, never a default).
    /// Mirrors `PrintRegion::flow()` (layer 0 uses `initial_layer_line_width` for every role; a 0 width falls back to
    /// `line_width`) and `LayerRegion::bridging_flow` for the overhang-wall flow.
    pub fn from_config(cfg: &Config, layer_id: usize, layer_h: f64) -> Result<WallParams, FdmError> {
        let mut p = WallParams::default();
        p.layer_id = layer_id;
        p.layer_h = layer_h;
        p.nozzle = cfg.f64("nozzle_diameter")?;
        let line_width = cfg.float_or_percent("line_width")?.resolve(p.nozzle);
        let w = |k: &str| -> Result<f64, FdmError> {
            let v = cfg.float_or_percent(k)?.resolve(p.nozzle);
            Ok(if v == 0.0 { line_width } else { v })
        };
        let iw = cfg.float_or_percent("initial_layer_line_width")?.resolve(p.nozzle);
        let first = layer_id == 0 && iw > 0.0;
        p.ext_width = if first { iw } else { w("outer_wall_line_width")? };
        p.inner_width = if first { iw } else { w("inner_wall_line_width")? };
        p.solid_infill_width = if first { iw } else { w("internal_solid_infill_line_width")? };
        p.sparse_infill_width = if first { iw } else { w("sparse_infill_line_width")? };
        let bridge_w = cfg.float_or_percent("bridge_line_width")?.resolve(p.nozzle);
        let bridge_ratio = cfg.f64("bridge_flow")?;
        p.thick_bridges = cfg.bool_("thick_bridges")?;
        if p.thick_bridges {
            // round bridging flow: diameter = (bridge_line_width or nozzle) * sqrt(bridge_flow)
            let mut d = if bridge_w > 0.0 { bridge_w } else { p.nozzle };
            if bridge_ratio > 0.0 {
                d *= bridge_ratio.sqrt();
            }
            p.overhang_width = d;
            p.overhang_height = d;
        } else {
            // normal extrusion, bridge_flow applied while keeping the spacing (Flow::with_flow_ratio, height unchanged)
            let base_w = if bridge_w > 0.0 { bridge_w } else { p.inner_width };
            let area = layer_h * (base_w - layer_h * (1.0 - 0.25 * PI)) * bridge_ratio;
            p.overhang_width = area / layer_h + layer_h * (1.0 - 0.25 * PI);
            p.overhang_height = layer_h;
        }
        p.wall_loops = cfg.i64("wall_loops")? as i32;
        p.wall_sequence = match cfg.enum_("wall_sequence")?.as_str() {
            "outer wall/inner wall" => WallSequence::OuterInner,
            "inner-outer-inner wall" => WallSequence::InnerOuterInner,
            "inner wall/outer wall" => WallSequence::InnerOuter,
            o => return Err(FdmError::Unsupported(format!("wall_sequence '{o}'"))),
        };
        // wall_direction: auto behaves as counter-clockwise outside overhang_reverse handling (refused below)
        p.wall_ccw = cfg.enum_("wall_direction")? != "cw";
        p.precise_outer_wall = cfg.bool_("precise_outer_wall")?;
        p.detect_thin_wall = cfg.bool_("detect_thin_wall")?;
        p.only_one_wall_top = cfg.bool_("only_one_wall_top")?;
        p.only_one_wall_first_layer = cfg.bool_("only_one_wall_first_layer")?;
        p.top_shell_layers = cfg.i64("top_shell_layers")? as i32;
        p.bottom_shell_layers = cfg.i64("bottom_shell_layers")? as i32;
        p.top_surface_density = cfg.percent("top_surface_density")?;
        p.top_surface_expansion = cfg.float_or_percent("top_surface_expansion")?.resolve(p.nozzle);
        p.alternate_extra_wall = cfg.bool_("alternate_extra_wall")?;
        p.sparse_infill_density = cfg.percent("sparse_infill_density")?;
        p.detect_overhang_wall = cfg.bool_("detect_overhang_wall")?;
        p.raft_layers = cfg.usize("raft_layers")?;
        p.interface_shells = cfg.bool_("interface_shells")?;
        let mw = cfg.float_or_percent("min_width_top_surface")?;
        p.min_width_top_surface = mw.value;
        p.min_width_top_surface_percent = mw.percent;
        p.gap_infill = cfg.f64("gap_infill_speed")? > 0.0;
        p.filter_out_gap_fill = cfg.f64("filter_out_gap_fill")?;
        p.infill_wall_overlap = cfg.percent("infill_wall_overlap")?;
        p.top_bottom_infill_wall_overlap = cfg.percent("top_bottom_infill_wall_overlap")?;
        let res = cfg.f64("resolution")?;
        p.resolution = if res > 1e-4 { res } else { 1e-4 };
        p.enable_arc_fitting = cfg.bool_("enable_arc_fitting")?;
        p.spiral_vase = cfg.bool_("spiral_mode")?;
        let fz = cfg.enum_("fuzzy_skin")?;
        p.fuzzy_skin = fz != "none" && fz != "disabled_fuzzy";
        p.overhang_reverse = cfg.bool_("overhang_reverse")?;
        p.extra_perimeters_on_overhangs = cfg.bool_("extra_perimeters_on_overhangs")?;
        p.counterbore_hole_bridging = cfg.enum_("counterbore_hole_bridging")? != "none";
        p.generator = match cfg.enum_("wall_generator")?.as_str() {
            "arachne" => WallGenerator::Arachne,
            _ => WallGenerator::Classic,
        };
        p.min_bead_width = if layer_id == 0 {
            cfg.float_or_percent("initial_layer_min_bead_width")?.resolve(p.nozzle)
        } else {
            cfg.float_or_percent("min_bead_width")?.resolve(p.nozzle)
        };
        p.min_length_factor = cfg.f64("min_length_factor")?;
        p.min_feature_size = cfg.float_or_percent("min_feature_size")?.resolve(p.nozzle);
        p.wall_transition_length = cfg.float_or_percent("wall_transition_length")?.resolve(p.nozzle);
        p.wall_transition_angle = cfg.f64("wall_transition_angle")?;
        p.wall_transition_filter_deviation = cfg.float_or_percent("wall_transition_filter_deviation")?.resolve(p.nozzle);
        p.wall_distribution_count = cfg.i64("wall_distribution_count")? as i32;
        p.wall_maximum_deviation = cfg.f64("wall_maximum_deviation")?;
        p.wall_maximum_resolution = cfg.f64("wall_maximum_resolution")?;
        p.slice_closing_radius = cfg.f64("slice_closing_radius").unwrap_or(0.0).max(0.0);
        Ok(p)
    }
    /// Convenience for tests / tools that hold the raw `key -> value` map of a CONFIG_BLOCK.
    pub fn from_config_block(map: &BTreeMap<String, String>, layer_id: usize, layer_h: f64) -> Result<WallParams, FdmError> {
        WallParams::from_config(&Config::from_map(map.clone()), layer_id, layer_h)
    }

    pub fn ext_flow(&self) -> Flow {
        Flow::new(self.ext_width, self.layer_h)
    }
    pub fn inner_flow(&self) -> Flow {
        Flow::new(self.inner_width, self.layer_h)
    }
    pub fn solid_flow(&self) -> Flow {
        Flow::new(self.solid_infill_width, self.layer_h)
    }
}

#[derive(Clone, Debug, Default)]
pub struct WallResult {
    /// Print order. Walls first (per island: sequence as Orca emits it), then every island's gap fill
    /// (Feature::GapInfill; Orca extrudes the `thin_fills` of an island after its perimeters).
    pub paths: Vec<ExtPath>,
    /// Region left for infill/shell classification: Orca `fill_surfaces` after process_classic.
    pub infill_region: Polys,
    /// Orca `fill_no_overlap`: the same region without the infill_wall_overlap growth.
    pub infill_no_overlap: Polys,
}

// =====================================================================================================================
// helpers
// =====================================================================================================================
fn mk_path(feature: Feature, pts: &[P2], closed: bool, w: f64, h: f64) -> ExtPath {
    ExtPath {
        feature,
        pts: pts.iter().map(|p| PathPt { x: p[0], y: p[1], w }).collect(),
        closed,
        layer_h: h,
        speed: 0.0,
        flow_ratio: 1.0,
    }
}
fn first_pt(p: &ExtPath) -> P2 {
    [p.pts[0].x, p.pts[0].y]
}
fn last_pt(p: &ExtPath) -> P2 {
    if p.closed { first_pt(p) } else { let q = p.pts.last().unwrap(); [q.x, q.y] }
}
fn reverse_path(p: &mut ExtPath) {
    if p.closed {
        // reverse a loop keeping its first point
        let first = p.pts[0];
        let mut rest: Vec<PathPt> = p.pts[1..].to_vec();
        rest.reverse();
        p.pts = std::iter::once(first).chain(rest).collect();
    } else {
        p.pts.reverse();
    }
}

#[derive(Clone)]
struct Ent {
    paths: Vec<ExtPath>,
    inset_idx: usize,
    is_loop: bool,
}
impl Ent {
    fn first(&self) -> P2 {
        first_pt(&self.paths[0])
    }
    fn last(&self) -> P2 {
        last_pt(self.paths.last().unwrap())
    }
    fn reverse(&mut self) {
        self.paths.reverse();
        for p in self.paths.iter_mut() {
            reverse_path(p);
        }
    }
}

/// Greedy nearest-endpoint chaining as `chain_segments_greedy*`: returns (index, reversed).
fn chain_greedy(ends: &[(P2, P2, bool)], start_near: Option<P2>) -> Vec<(usize, bool)> {
    let n = ends.len();
    let mut used = vec![false; n];
    let mut out = vec![];
    let mut cur: Option<P2> = start_near;
    for _ in 0..n {
        let mut best: Option<(usize, bool, f64)> = None;
        match cur {
            None => {
                // no start hint: begin with the first segment
                let i = (0..n).find(|&i| !used[i]).unwrap();
                best = Some((i, false, 0.0));
            }
            Some(c) => {
                for i in 0..n {
                    if used[i] {
                        continue;
                    }
                    let d0 = geo::len(c, ends[i].0);
                    if best.map_or(true, |b| d0 < b.2) {
                        best = Some((i, false, d0));
                    }
                    if ends[i].2 {
                        let d1 = geo::len(c, ends[i].1);
                        if best.map_or(true, |b| d1 < b.2) {
                            best = Some((i, true, d1));
                        }
                    }
                }
            }
        }
        let (i, rev, _) = best.unwrap();
        used[i] = true;
        out.push((i, rev));
        cur = Some(if rev { ends[i].0 } else { ends[i].1 });
    }
    out
}

fn ring_ccw(r: &[P2]) -> bool {
    geo::ring_area(r) > 0.0
}

// =====================================================================================================================
// classic perimeter generator
// =====================================================================================================================
struct Node {
    ring: Vec<P2>,
    is_contour: bool,
    small: bool,
    depth: usize,
    children: Vec<usize>,
}

struct Gen<'a> {
    p: &'a WallParams,
    lower: Option<&'a Polys>,
    upper: Option<&'a Polys>,
    ext_w: f64,
    ext_sp: f64,
    ext_sp2: f64,
    w: f64,
    sp: f64,
    solid_sp: f64,
    smaller_ext_w: f64,
    grown_lower: Option<Polys>,
    /// `offset(upper, min_w)` of `split_top_surfaces`: identical for every island of the layer, so computed once.
    upper_grown: std::cell::OnceCell<Polys>,
}

fn spacing_of(w: f64, h: f64) -> f64 {
    w - h * (1.0 - 0.25 * PI)
}

impl<'a> Gen<'a> {
    fn new(p: &'a WallParams, lower: Option<&'a Polys>, upper: Option<&'a Polys>) -> Result<Gen<'a>, FdmError> {
        let h = p.layer_h;
        let ext_sp = spacing_of(p.ext_width, h);
        let sp = spacing_of(p.inner_width, h);
        if ext_sp <= 0.0 || sp <= 0.0 {
            return Err(FdmError::Unsupported("Flow::spacing() produced negative spacing. Did you set some extrusion width too small?".into()));
        }
        let ext_sp2 = if p.precise_outer_wall && p.wall_sequence == WallSequence::InnerOuter {
            0.5 * (p.ext_width + p.inner_width)
        } else {
            0.5 * (ext_sp + sp)
        };
        let grown_lower = match (lower, p.detect_overhang_wall) {
            (Some(l), true) => Some(geo::offset(l, p.nozzle / 2.0)),
            _ => None,
        };
        Ok(Gen {
            p,
            lower,
            upper,
            ext_w: p.ext_width,
            ext_sp,
            ext_sp2,
            w: p.inner_width,
            sp,
            solid_sp: spacing_of(p.solid_infill_width, h),
            smaller_ext_w: p.ext_width - 0.5 * SMALLER_EXT_INSET_OVERLAP_TOLERANCE * ext_sp,
            grown_lower,
            upper_grown: std::cell::OnceCell::new(),
        })
    }

    /// `PerimeterGenerator::split_top_surfaces`. Returns (top_fills added, non_top_polygons, fill_clip).
    fn split_top_surfaces(&self, orig: &Polys, top_fills: &mut Polys, fill_clip: &mut Polys) -> Polys {
        let p = self.p;
        let (ext_w, ext_sp, pw, psp) = (self.ext_w, self.ext_sp, self.w, self.sp);
        let wl = p.wall_loops as f64;
        // offset_top_surface
        let mut offset_top = 0.9 * if p.wall_loops == 0 { 0.0 } else { ext_w + psp * (wl - 1.0) };
        let thr = 0.9 * if p.wall_loops <= 1 { 0.0 } else { psp * (wl - 1.0) };
        if offset_top > thr {
            offset_top -= thr;
        } else {
            offset_top = 0.0;
        }
        let min_w = {
            let v = if p.min_width_top_surface_percent { pw * p.min_width_top_surface / 100.0 } else { p.min_width_top_surface };
            (ext_sp / 2.0 + CLIPPER_SAFETY_OFFSET).max(v)
        };
        let upper_grown = self.upper_grown.get_or_init(|| {
            let upper = self.upper.map(|u| u.clone()).unwrap_or_default();
            geo::offset(&upper, min_w)
        });
        *fill_clip = geo::offset(orig, -ext_sp);
        let mut bridge_checker: Polys = vec![];
        if let Some(lower) = self.lower {
            let bridge_offset = ext_sp.max(pw);
            let margin = (1.0f64).min(p.nozzle * 1.0 / 0.4); // BRIDGE_INFILL_MARGIN = 1
            let ds = geo::diff_safe(orig, lower);
            bridge_checker = geo::offset(&ds, 1.5 * bridge_offset + margin + psp / 2.0);
        }
        let delete_bridge = geo::diff_safe(orig, &bridge_checker);
        let mut top_polygons = geo::diff_safe(&delete_bridge, upper_grown);
        let temp_gap = geo::diff(&top_polygons, fill_clip);
        let inner_polygons = geo::diff_safe(orig, &geo::offset(&top_polygons, offset_top + min_w - ext_sp / 2.0));
        top_polygons = geo::diff_safe(fill_clip, &inner_polygons);
        *top_fills = geo::union2(top_fills, &top_polygons);
        let mut infill_spacing = p.sparse_infill_width;
        if infill_spacing == 0.0 {
            infill_spacing = p.nozzle;
        }
        *fill_clip = geo::offset(orig, ext_sp / 2.0 - infill_spacing / 2.0);
        let mut non_top = geo::inter(&inner_polygons, orig);
        if p.gap_infill {
            non_top = geo::union2(&non_top, &temp_gap);
        }
        non_top
    }

    /// Build the ExtrusionLoop entity of one loop node (overhang detection included).
    fn make_loop(&self, nodes: &[Node], id: usize, reverse_thin_wall_hole: bool) -> Ent {
        let n = &nodes[id];
        let p = self.p;
        let external = n.depth == 0;
        let (feature, width) = if external {
            (Feature::OuterWall, if n.small { self.smaller_ext_w } else { self.ext_w })
        } else {
            (Feature::InnerWall, self.w)
        };
        let h = p.layer_h;
        // orientation: (wall_ccw == (is_contour || reverse_thin_wall_hole)) -> CCW else CW
        let want_ccw = p.wall_ccw == (n.is_contour || reverse_thin_wall_hole);
        let mut ring = n.ring.clone();
        if ring_ccw(&ring) != want_ccw {
            ring.reverse();
        }
        let mut paths: Vec<ExtPath> = vec![];
        if let (true, true, Some(gl)) = (p.detect_overhang_wall, p.layer_id > p.raft_layers, self.grown_lower.as_ref()) {
            let (inside, outside) = geo::split_ring_by_region(&ring, gl);
            if outside.is_empty() {
                paths.push(mk_path(feature, &ring, true, width, h));
            } else if inside.is_empty() {
                paths.push(mk_path(Feature::OverhangWall, &ring, true, p.overhang_width, p.overhang_height));
            } else {
                for pc in inside {
                    paths.push(mk_path(feature, &pc, false, width, h));
                }
                for pc in outside {
                    paths.push(mk_path(Feature::OverhangWall, &pc, false, p.overhang_width, p.overhang_height));
                }
                // chain_and_reorder_extrusion_paths(paths, &first point)
                let ends: Vec<(P2, P2, bool)> = paths.iter().map(|q| (first_pt(q), last_pt(q), true)).collect();
                let order = chain_greedy(&ends, Some(first_pt(&paths[0])));
                let mut np = vec![];
                for (i, rev) in order {
                    let mut q = paths[i].clone();
                    if rev {
                        reverse_path(&mut q);
                    }
                    np.push(q);
                }
                paths = np;
            }
        } else {
            paths.push(mk_path(feature, &ring, true, width, h));
        }
        Ent { paths, inset_idx: n.depth, is_loop: true }
    }

    fn traverse_loops(&self, nodes: &[Node], loops: &[usize], thin_walls: &mut Vec<ThickPolyline>, reverse_thin_wall_hole: bool) -> Vec<Ent> {
        let mut coll: Vec<Ent> = loops.iter().map(|&id| self.make_loop(nodes, id, reverse_thin_wall_hole)).collect();
        let n_loops = coll.len();
        if !thin_walls.is_empty() {
            let wp = variable_width(thin_walls, self.p.ext_flow());
            for group in wp {
                // a closed result becomes a loop, others separate paths
                let closed = group.first().unwrap().pts.first() == group.last().unwrap().pts.last();
                if closed {
                    let paths: Vec<ExtPath> = group.iter().map(|w| mk_path(Feature::OuterWall, &w.pts, false, w.width, self.p.layer_h)).collect();
                    coll.push(Ent { paths, inset_idx: 0, is_loop: true });
                } else {
                    for w in group {
                        coll.push(Ent { paths: vec![mk_path(Feature::OuterWall, &w.pts, false, w.width, self.p.layer_h)], inset_idx: 0, is_loop: false });
                    }
                }
            }
            thin_walls.clear();
        }
        let ends: Vec<(P2, P2, bool)> = coll.iter().map(|e| (e.first(), e.last(), !e.is_loop)).collect();
        let chain = chain_greedy(&ends, Some([0.0, 0.0]));
        let mut out: Vec<Ent> = vec![];
        for (idx, rev) in chain {
            if idx >= n_loops {
                let mut e = coll[idx].clone();
                if rev {
                    e.reverse();
                }
                out.push(e);
            } else {
                let node = &nodes[loops[idx]];
                let rthwh = loops.len() == 1
                    && node.is_contour
                    && node.children.len() == 1
                    && !nodes[node.children[0]].is_contour
                    && nodes[node.children[0]].children.is_empty();
                let mut empty_thin: Vec<ThickPolyline> = vec![];
                let mut children = self.traverse_loops(nodes, &node.children, &mut empty_thin, rthwh);
                if rthwh {
                    children.reverse();
                }
                let mut eloop = coll[idx].clone();
                eloop.inset_idx = node.depth;
                if node.is_contour {
                    out.extend(children);
                    out.push(eloop);
                } else {
                    out.push(eloop);
                    out.extend(children);
                }
            }
        }
        out
    }
}

/// Scale-aware wrapper: generate the walls of one layer with the generator selected in `p`.
///
/// A panic inside the geometry/Voronoi code is turned into `FdmError::Geometry` (the layer is refused, never approximated).
pub fn generate_walls(region: &Polys, lower: Option<&Polys>, upper: Option<&Polys>, p: &WallParams) -> Result<WallResult, FdmError> {
    let closed: Polys;
    let region = if p.slice_closing_radius > 0.0 {
        closed = geo::offset2(&geo::union(region), p.slice_closing_radius, -p.slice_closing_radius);
        &closed
    } else {
        region
    };
    let run = || match p.generator {
        WallGenerator::Classic => generate_classic(region, lower, upper, p),
        WallGenerator::Arachne => crate::arachne::generate_arachne(region, lower, upper, p),
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(r) => r,
        Err(_) => Err(FdmError::Geometry("wall generator hit an internal error (panic); layer refused instead of approximated".into())),
    }
}

pub(crate) fn refuse_unsupported(p: &WallParams) -> Result<(), FdmError> {
    if p.fuzzy_skin {
        return Err(FdmError::Unsupported("fuzzy skin is applied by lane 7 (effects); wall generator refuses fuzzy_skin".into()));
    }
    if p.overhang_reverse {
        return Err(FdmError::Unsupported("overhang_reverse (steep overhang loop reversal) is not implemented".into()));
    }
    if p.extra_perimeters_on_overhangs && p.detect_overhang_wall {
        return Err(FdmError::Unsupported("extra_perimeters_on_overhangs is not implemented".into()));
    }
    if p.counterbore_hole_bridging {
        return Err(FdmError::Unsupported("counterbore_hole_bridging (process_no_bridge) is not implemented".into()));
    }
    Ok(())
}


pub fn generate_classic(region: &Polys, lower: Option<&Polys>, upper: Option<&Polys>, p: &WallParams) -> Result<WallResult, FdmError> {
    refuse_unsupported(p)?;
    let g = Gen::new(p, lower, upper)?;
    let h = p.layer_h;
    let min_spacing = g.sp * (1.0 - INSET_OVERLAP_TOLERANCE);
    let ext_min_spacing = g.ext_sp * (1.0 - INSET_OVERLAP_TOLERANCE);
    let ext_min_spacing_smaller = g.ext_sp * (1.0 - SMALLER_EXT_INSET_OVERLAP_TOLERANCE);
    let has_gap_fill = p.gap_infill;
    let surface_simplify_resolution = if p.enable_arc_fitting && !p.fuzzy_skin { 0.2 * p.resolution } else { p.resolution };

    let has_top_shell = p.top_shell_layers > 0;
    let has_bottom_shell = p.bottom_shell_layers > 0;
    let only_one_wall_top = p.only_one_wall_top && has_top_shell;
    let only_one_wall_first_layer = p.only_one_wall_first_layer && has_bottom_shell;
    let top_fill_replaces = has_top_shell && p.top_surface_density > 0.0 && p.top_surface_expansion > 0.0;

    // island order: chain_expolygons over bbox centres
    let centers: Vec<(P2, P2, bool)> = region
        .iter()
        .map(|q| {
            let b = geo::bbox(&vec![q.clone()]).unwrap_or([0.0; 4]);
            let c = [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0];
            (c, c, false)
        })
        .collect();
    let order: Vec<(usize, bool)> = if centers.is_empty() { vec![] } else { chain_greedy(&centers, None) };

    let mut result = WallResult::default();
    let mut gap_paths_all: Vec<ExtPath> = vec![];
    let mut infill_all: Polys = vec![];
    let mut no_overlap_all: Polys = vec![];

    for (surf_idx, _) in order {
        let surface = &region[surf_idx];
        let mut loop_number: i32 = p.wall_loops + p.extra_perimeters - 1;
        if p.alternate_extra_wall && p.layer_id % 2 == 1 && !p.spiral_vase && p.sparse_infill_density > 0.0 {
            loop_number += 1;
        }
        if p.layer_id == p.raft_layers && only_one_wall_first_layer {
            loop_number = 0;
        }
        if loop_number > 0 && only_one_wall_top && upper.is_none() {
            loop_number = 0;
        }

        let mut last: Polys = geo::union(&geo::simplify_polys(&vec![surface.clone()], surface_simplify_resolution));
        let mut gaps: Polys = vec![];
        let mut top_fills: Polys = vec![];
        let mut fill_clip: Polys = vec![];
        let mut one_wall_top_region: Polys = vec![];
        let mut one_wall_top_reclaimed: Polys = vec![];
        let mut one_wall_top_kept_bands: Polys = vec![];
        let mut apply_one_wall_top = false;

        if loop_number >= 0 {
            let ln = loop_number as usize;
            let mut nodes: Vec<Node> = vec![];
            let mut contours: Vec<Vec<usize>> = vec![vec![]; ln + 1];
            let mut holes: Vec<Vec<usize>> = vec![vec![]; ln + 1];
            let mut thin_walls: Vec<ThickPolyline> = vec![];
            let mut ln_cur = loop_number;
            let mut i: i32 = 0;
            loop {
                let mut offsets: Polys;
                let mut offsets_smaller: Polys = vec![];
                if i == 0 {
                    if p.detect_thin_wall {
                        offsets = geo::offset2(&last, -(g.ext_w / 2.0 + ext_min_spacing / 2.0 - 1e-6), ext_min_spacing / 2.0 - 1e-6);
                        let min_width = p.nozzle / 3.0;
                        let expp = geo::opening(&geo::diff(&last, &geo::offset(&offsets, g.ext_w / 2.0 + CLIPPER_SAFETY_OFFSET)), min_width / 2.0);
                        for ex in &expp {
                            thin_walls.extend(medial_axis(ex, min_width, g.ext_w + g.ext_sp2));
                        }
                    } else {
                        offsets = vec![];
                        for ex in &last {
                            let one = vec![ex.clone()];
                            let r = geo::offset2(&one, -(g.ext_w / 2.0 + ext_min_spacing_smaller / 2.0), ext_min_spacing_smaller / 2.0);
                            if r.is_empty() && geo::poly_area(ex) < (g.ext_w + ext_min_spacing_smaller) * NARROW_LOOP_LENGTH_THRESHOLD {
                                offsets_smaller.extend(geo::offset(&one, -(g.smaller_ext_w / 2.0)));
                            } else {
                                offsets.extend(geo::offset(&one, -(g.ext_w / 2.0)));
                            }
                        }
                    }
                    if p.spiral_vase && (offsets.len() > 1 || offsets_smaller.len() > 1) {
                        let keep = |v: &mut Polys| {
                            if let Some(k) = (0..v.len()).max_by(|&a, &b| geo::poly_area(&v[a]).partial_cmp(&geo::poly_area(&v[b])).unwrap()) {
                                let q = v[k].clone();
                                *v = vec![q];
                            }
                        };
                        keep(&mut offsets);
                        if offsets.is_empty() {
                            keep(&mut offsets_smaller);
                        } else {
                            offsets_smaller.clear();
                        }
                    }
                } else {
                    let distance = if i == 1 { g.ext_sp2 } else { g.sp };
                    offsets = geo::offset2(&last, -(distance + min_spacing / 2.0 - 1e-6), min_spacing / 2.0 - 1e-6);
                    if has_gap_fill {
                        let a = geo::offset(&last, -0.5 * distance);
                        let b = geo::offset(&offsets, 0.5 * distance + CLIPPER_SAFETY_OFFSET);
                        gaps.extend(geo::diff(&a, &b));
                    }
                }
                if offsets.is_empty() && offsets_smaller.is_empty() {
                    ln_cur = i - 1;
                    last.clear();
                    break;
                } else if i > ln_cur {
                    break;
                }
                let iu = i as usize;
                for ex in &offsets {
                    nodes.push(Node { ring: ex.contour.clone(), is_contour: true, small: false, depth: iu, children: vec![] });
                    contours[iu].push(nodes.len() - 1);
                    for hl in &ex.holes {
                        nodes.push(Node { ring: hl.clone(), is_contour: false, small: false, depth: iu, children: vec![] });
                        holes[iu].push(nodes.len() - 1);
                    }
                }
                if i == 0 {
                    for ex in &offsets_smaller {
                        nodes.push(Node { ring: ex.contour.clone(), is_contour: true, small: true, depth: 0, children: vec![] });
                        contours[0].push(nodes.len() - 1);
                        for hl in &ex.holes {
                            nodes.push(Node { ring: hl.clone(), is_contour: false, small: true, depth: 0, children: vec![] });
                            holes[0].push(nodes.len() - 1);
                        }
                    }
                }
                last = offsets;

                if i == 0 && i != ln_cur && only_one_wall_top && upper.is_some() {
                    if top_fill_replaces {
                        let non_top = g.split_top_surfaces(&last, &mut top_fills, &mut fill_clip);
                        apply_one_wall_top = !top_fills.is_empty();
                        if apply_one_wall_top {
                            one_wall_top_region = geo::diff(&last, &non_top);
                        }
                    } else {
                        let nt = g.split_top_surfaces(&last, &mut top_fills, &mut fill_clip);
                        last = nt;
                    }
                }
                if i == ln_cur && (!has_gap_fill || p.sparse_infill_density == 0.0) {
                    break;
                }
                i += 1;
            }
            loop_number = ln_cur;
            let ln = loop_number;

            if apply_one_wall_top && ln >= 1 {
                let grazing_tolerance = 2.0 * g.w;
                let wall_band = |ring: &Vec<P2>| -> Polys {
                    let mut c = ring.clone();
                    if !ring_ccw(&c) {
                        c.reverse();
                    }
                    let poly = vec![Poly { contour: c, holes: vec![] }];
                    geo::diff(&geo::offset(&poly, g.sp / 2.0), &geo::offset(&poly, -g.sp / 2.0))
                };
                let mut dropped_bands: Polys = vec![];
                let region_top = one_wall_top_region.clone();
                for d in 1..=ln as usize {
                    for list in [&mut contours[d], &mut holes[d]] {
                        let mut keep: Vec<usize> = vec![];
                        for &id in list.iter() {
                            let ring = &nodes[id].ring;
                            let inside = ring.iter().filter(|q| geo::region_contains(&region_top, **q)).count();
                            let overlap = if inside == 0 { 0 } else if inside == ring.len() { 2 } else { 1 };
                            if overlap == 0 {
                                keep.push(id);
                                continue;
                            }
                            if overlap == 1 {
                                let (ins, _) = geo::split_ring_by_region(ring, &region_top);
                                let tl: f64 = ins.iter().map(|pc| geo::path_length(pc, false)).sum();
                                if tl < grazing_tolerance {
                                    one_wall_top_kept_bands.extend(wall_band(ring));
                                    keep.push(id);
                                    continue;
                                }
                            }
                            dropped_bands.extend(wall_band(ring));
                        }
                        *list = keep;
                    }
                }
                if !gaps.is_empty() {
                    gaps = geo::diff(&gaps, &one_wall_top_region);
                }
                if !dropped_bands.is_empty() {
                    one_wall_top_reclaimed = geo::diff(&dropped_bands, &one_wall_top_region);
                }
            }

            // nest loops: holes first
            if ln >= 0 {
                let lnu = ln as usize;
                for d in 0..=lnu {
                    let mut idx = 0;
                    while idx < holes[d].len() {
                        let id = holes[d][idx];
                        let fp = nodes[id].ring[0];
                        let mut placed = false;
                        'outer: for t in d + 1..=lnu {
                            for j in 0..holes[t].len() {
                                let cand = holes[t][j];
                                if geo::ring_contains(&nodes[cand].ring, fp) {
                                    nodes[cand].children.push(id);
                                    holes[d].remove(idx);
                                    placed = true;
                                    break 'outer;
                                }
                            }
                        }
                        if !placed {
                            'outer2: for t in (0..=lnu).rev() {
                                for j in 0..contours[t].len() {
                                    let cand = contours[t][j];
                                    if geo::ring_contains(&nodes[cand].ring, fp) {
                                        nodes[cand].children.push(id);
                                        holes[d].remove(idx);
                                        placed = true;
                                        break 'outer2;
                                    }
                                }
                            }
                        }
                        if !placed {
                            idx += 1;
                        }
                    }
                }
                // nest contour loops
                for d in (1..=lnu).rev() {
                    let mut idx = 0;
                    while idx < contours[d].len() {
                        let id = contours[d][idx];
                        let fp = nodes[id].ring[0];
                        let mut placed = false;
                        'o3: for t in (0..d).rev() {
                            for j in 0..contours[t].len() {
                                let cand = contours[t][j];
                                if geo::ring_contains(&nodes[cand].ring, fp) {
                                    nodes[cand].children.push(id);
                                    contours[d].remove(idx);
                                    placed = true;
                                    break 'o3;
                                }
                            }
                        }
                        if !placed {
                            idx += 1;
                        }
                    }
                }
            }

            let top: Vec<usize> = contours[0].clone();
            let mut entities = g.traverse_loops(&nodes, &top, &mut thin_walls, false);

            let outer_first = p.wall_sequence == WallSequence::OuterInner;
            if outer_first {
                entities.reverse();
            } else if p.wall_sequence == WallSequence::InnerOuterInner && p.layer_id > 0 {
                entities.reverse();
                if entities.len() > 2 {
                    entities = sandwich_reorder(entities);
                }
            }
            for e in entities {
                result.paths.extend(e.paths);
            }
        }

        // fill gaps
        if !gaps.is_empty() {
            let min = 0.2 * g.w.min(g.ext_w) * (1.0 - INSET_OVERLAP_TOLERANCE);
            let max = 2.0 * g.sp;
            let gaps_ex = geo::diff(&geo::opening(&gaps, min / 2.0), &geo::offset2(&gaps, -max / 2.0, max / 2.0 + CLIPPER_SAFETY_OFFSET));
            let mut polylines: Vec<ThickPolyline> = vec![];
            for ex in &gaps_ex {
                let s = geo::simplify_polys(&vec![ex.clone()], surface_simplify_resolution);
                for e in &s {
                    polylines.extend(medial_axis(e, min, max));
                }
            }
            polylines.retain(|t| t.length() >= p.filter_out_gap_fill);
            if !polylines.is_empty() {
                let wp = variable_width(&polylines, p.solid_flow());
                let mut covered: Polys = vec![];
                let mut new_paths: Vec<ExtPath> = vec![];
                for group in wp {
                    for w in group {
                        covered.extend(stroke_polys(&w.pts, w.width / 2.0 + CLIPPER_SAFETY_OFFSET));
                        new_paths.push(mk_path(Feature::GapInfill, &w.pts, false, w.width, h));
                    }
                }
                // a closed medial-axis result is emitted as a loop in Orca; keep the path flags honest
                for np in new_paths.iter_mut() {
                    let f = np.pts[0];
                    let l = *np.pts.last().unwrap();
                    if np.pts.len() > 2 && (f.x - l.x).abs() < 1e-9 && (f.y - l.y).abs() < 1e-9 {
                        np.pts.pop();
                        np.closed = true;
                    }
                }
                let covered = geo::union(&covered);
                last = geo::diff(&last, &covered);
                if !one_wall_top_reclaimed.is_empty() {
                    one_wall_top_reclaimed = geo::diff(&one_wall_top_reclaimed, &covered);
                }
                gap_paths_all.extend(new_paths);
            }
        }

        // infill boundary
        let mut inset = if loop_number < 0 {
            0.0
        } else if loop_number == 0 {
            g.ext_sp / 2.0
        } else {
            g.sp / 2.0
        };
        let mut infill_peri_overlap = 0.0;
        let mut top_infill_peri_overlap = 0.0;
        if inset > 0.0 {
            let base = inset + g.solid_sp / 2.0;
            if p.layer_id == 0 || upper.is_none() {
                infill_peri_overlap = p.top_bottom_infill_wall_overlap * base / 100.0;
            } else {
                infill_peri_overlap = p.infill_wall_overlap * base / 100.0;
                top_infill_peri_overlap = p.top_bottom_infill_wall_overlap * base / 100.0;
            }
            inset -= infill_peri_overlap;
        }
        let not_filled = geo::union(&geo::simplify_polys(&last, p.resolution));
        let min_pis = g.solid_sp * (1.0 - INSET_OVERLAP_TOLERANCE);
        let mut infill_exp = geo::offset2(&not_filled, -inset - min_pis / 2.0, min_pis / 2.0);
        let mut top_infill_exp = geo::inter(&fill_clip, &geo::offset(&top_fills, g.ext_sp / 2.0));
        if !one_wall_top_kept_bands.is_empty() {
            top_infill_exp = geo::diff(&top_infill_exp, &one_wall_top_kept_bands);
        }
        if !top_fills.is_empty() {
            infill_exp = geo::union2(&infill_exp, &geo::offset(&top_infill_exp, top_infill_peri_overlap));
        }
        if !one_wall_top_reclaimed.is_empty() {
            infill_exp = geo::union2(&infill_exp, &one_wall_top_reclaimed);
        }
        infill_all.extend(infill_exp);
        let mut without_overlap = if min_pis / 2.0 > infill_peri_overlap {
            geo::offset2(&not_filled, -inset - min_pis / 2.0, min_pis / 2.0 - infill_peri_overlap)
        } else {
            geo::offset(&not_filled, -inset - infill_peri_overlap)
        };
        if !top_fills.is_empty() {
            without_overlap = geo::union2(&without_overlap, &top_infill_exp);
        }
        if !one_wall_top_reclaimed.is_empty() {
            without_overlap = geo::union2(&without_overlap, &one_wall_top_reclaimed);
        }
        no_overlap_all.extend(without_overlap);
    }
    result.paths.extend(gap_paths_all);
    result.infill_region = geo::union(&infill_all);
    result.infill_no_overlap = no_overlap_all;
    Ok(result)
}

/// `offset(polyline, delta)` with butt ends: the area a polyline of half-width `half` covers (one quad per segment
/// plus a bevel wedge at every interior vertex, unioned).
pub fn stroke_polys(pts: &[P2], half: f64) -> Polys {
    let mut quads: Polys = vec![];
    let n = pts.len();
    if n < 2 {
        return quads;
    }
    let normal = |a: P2, b: P2| -> Option<P2> {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = (dx * dx + dy * dy).sqrt();
        (l > 1e-12).then(|| [-dy / l * half, dx / l * half])
    };
    for i in 0..n - 1 {
        let Some(nv) = normal(pts[i], pts[i + 1]) else { continue };
        let (a, b) = (pts[i], pts[i + 1]);
        quads.push(Poly { contour: vec![[a[0] + nv[0], a[1] + nv[1]], [a[0] - nv[0], a[1] - nv[1]], [b[0] - nv[0], b[1] - nv[1]], [b[0] + nv[0], b[1] + nv[1]]], holes: vec![] });
    }
    for i in 1..n.saturating_sub(1) {
        if let (Some(n1), Some(n2)) = (normal(pts[i - 1], pts[i]), normal(pts[i], pts[i + 1])) {
            let p = pts[i];
            for sgn in [1.0, -1.0] {
                quads.push(Poly { contour: vec![p, [p[0] + sgn * n1[0], p[1] + sgn * n1[1]], [p[0] + sgn * n2[0], p[1] + sgn * n2[1]]], holes: vec![] });
            }
        }
    }
    for q in quads.iter_mut() {
        if geo::ring_area(&q.contour) < 0.0 {
            q.contour.reverse();
        }
    }
    geo::union(&quads)
}

/// WallSequence::InnerOuterInner reordering (PerimeterGenerator.cpp:1693..1788), operating on the already reversed list.
fn sandwich_reorder(mut entities: Vec<Ent>) -> Vec<Ent> {
    let n = entities.len();
    let mut reordered: Vec<Ent> = vec![];
    let mut skipped: Vec<Ent> = vec![];
    let mut found_second_internal = false;
    for e in entities.iter() {
        match e.inset_idx {
            0 => {
                if found_second_internal {
                    reordered.append(&mut skipped);
                }
                reordered.push(e.clone());
            }
            1 => reordered.push(e.clone()),
            _ => {
                skipped.push(e.clone());
                found_second_internal = true;
            }
        }
    }
    if n > reordered.len() {
        reordered.append(&mut skipped);
    }
    let mut position: usize = 0;
    while position < reordered.len() {
        let (mut outer, mut first_internal, mut second_internal): (i64, i64, i64) = (-1, -1, -1);
        let mut max_internal: usize = reordered.len() - 1;
        let mut arr_i = position;
        while arr_i < reordered.len() {
            match reordered[arr_i].inset_idx {
                0 => {
                    if outer == -1 {
                        outer = arr_i as i64;
                    }
                }
                1 => {
                    if first_internal == -1 && arr_i as i64 > outer && outer != -1 {
                        first_internal = arr_i as i64;
                    }
                }
                2 => {
                    if second_internal == -1 && arr_i as i64 > first_internal && outer != -1 {
                        second_internal = arr_i as i64;
                    }
                }
                _ => {}
            }
            if outer > -1 && first_internal > -1 && second_internal > -1 && reordered[arr_i].inset_idx == 0 {
                arr_i -= 1;
                max_internal = arr_i;
                break;
            }
            arr_i += 1;
        }
        if outer > -1 && first_internal > -1 && second_internal > -1 {
            let second_internal = second_internal as usize;
            let mut inner_outer: Vec<Ent> = vec![];
            let mut aj = max_internal as i64;
            while aj >= position as i64 {
                if aj as usize >= second_internal {
                    inner_outer.push(reordered[aj as usize].clone());
                }
                aj -= 1;
            }
            for aj in position..second_internal {
                inner_outer.push(reordered[aj].clone());
            }
            for aj in position..=max_internal {
                entities[aj] = inner_outer[aj - position].clone();
            }
        } else {
            break;
        }
        position = arr_i + 1;
    }
    entities
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Poly {
        Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }
    }
    fn len(p: &ExtPath) -> f64 {
        let pts: Vec<[f64; 2]> = p.pts.iter().map(|q| [q.x, q.y]).collect();
        geo::path_length(&pts, p.closed)
    }
    fn total(r: &WallResult, f: Feature) -> f64 {
        r.paths.iter().filter(|p| p.feature == f).map(len).sum()
    }
    fn count(r: &WallResult, f: Feature) -> usize {
        r.paths.iter().filter(|p| p.feature == f).count()
    }

    #[test]
    fn indexed_split_equals_brute_force() {
        let mut st: u64 = 0xDEADBEEFCAFE1234;
        let mut rnd = move || {
            st = st.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((st >> 33) as f64) / ((1u64 << 31) as f64)
        };
        let mut n_pieces = 0usize;
        for case in 0..400 {
            let cx = 50.0 + 100.0 * rnd();
            let blob = |rnd: &mut dyn FnMut() -> f64, r0: f64, k: usize, jag: f64| -> Vec<[f64; 2]> {
                (0..k).map(|i| {
                    let a = i as f64 / k as f64 * std::f64::consts::TAU;
                    let r = r0 + jag * rnd();
                    [cx + r * a.cos(), cx + r * a.sin()]
                }).collect()
            };
            let k1 = 5 + (rnd() * 120.0) as usize;
            let outer = blob(&mut rnd, 20.0, k1, 6.0);
            let hole = {
                let k2 = 4 + (rnd() * 40.0) as usize;
                let mut h = blob(&mut rnd, 6.0, k2, 4.0);
                h.reverse();
                h
            };
            let region = vec![Poly { contour: outer.clone(), holes: if case % 3 == 0 { vec![hole] } else { vec![] } }, Poly { contour: blob(&mut rnd, 3.0, 12, 1.0).iter().map(|p| [p[0] + 40.0, p[1]]).collect(), holes: vec![] }];
            // a ring sometimes sharing vertices with the region (touching / collinear cases), sometimes random
            let ring: Vec<[f64; 2]> = if case % 4 == 0 { outer.iter().map(|p| [p[0] * 0.999 + cx * 0.001, p[1] * 0.999 + cx * 0.001]).collect() } else { { let k3 = 6 + (rnd() * 150.0) as usize; blob(&mut rnd, 18.0, k3, 8.0) } };
            let (ai, ao) = geo::split_ring_by_region(&ring, &region);
            let (bi, bo) = geo::split_ring_by_region_slow(&ring, &region);
            assert_eq!(ai, bi, "case {case} inside");
            assert_eq!(ao, bo, "case {case} outside");
            n_pieces += ai.len() + ao.len();
        }
        assert!(n_pieces > 400, "population examined: {n_pieces} pieces (the comparison must see both inside and outside runs)");
    }

    #[test]
    fn geo_offset_union_diff() {
        let r = vec![rect(0.0, 0.0, 10.0, 10.0)];
        assert!((geo::polys_area(&geo::offset(&r, -1.0)) - 64.0).abs() < 1e-6);
        assert!((geo::polys_area(&geo::offset(&r, 1.0)) - 144.0).abs() < 1e-6); // miter keeps the corners
        let ring = Poly { contour: rect(0., 0., 10., 10.).contour, holes: vec![rect(3., 3., 7., 7.).contour.into_iter().rev().collect()] };
        let rr = vec![ring];
        assert!((geo::polys_area(&rr) - 84.0).abs() < 1e-9);
        assert!((geo::polys_area(&geo::offset(&rr, -1.0)) - (64.0 - 36.0)).abs() < 1e-6);
        assert!((geo::polys_area(&geo::diff(&r, &vec![rect(5., 0., 15., 10.)])) - 50.0).abs() < 1e-9);
        // a tiny offset must never shrink a growing region (the failure of the naive i_overlay outline on near-collinear rings)
        let circle: Vec<[f64; 2]> = (0..170).map(|i| { let a = i as f64 / 170.0 * std::f64::consts::TAU; [5.0 + 1.55 * a.cos(), 5.0 + 1.55 * a.sin()] }).collect();
        let holed = vec![Poly { contour: rect(0., 0., 10., 10.).contour, holes: vec![circle.into_iter().rev().collect()] }];
        let a0 = geo::polys_area(&holed);
        for d in [1e-5, 1e-3, 0.049] {
            assert!(geo::polys_area(&geo::offset(&holed, d)) > a0, "grow by {d}");
            assert!(geo::polys_area(&geo::offset(&holed, -d)) < a0, "shrink by {d}");
        }
    }

    #[test]
    fn clean_ring_merges_near_duplicate_vertices_without_eating_corners() {
        // slicer output carries every vertex twice, ~6e-8 mm apart. The old clean_ring removed BOTH members of each pair
        // in one pass and chorded across the curve (measured: a 207-vertex hole became 136, with 7 mm chords).
        let n = 60;
        let mut ring: Vec<[f64; 2]> = vec![];
        for i in 0..n {
            let a = i as f64 / n as f64 * std::f64::consts::TAU;
            let p = [10.0 + 5.0 * a.cos(), 10.0 + 5.0 * a.sin()];
            ring.push(p);
            ring.push([p[0] + 6e-8, p[1]]);
        }
        let c = geo::clean_ring(&ring);
        assert_eq!(c.len(), n, "one vertex per pair survives");
        let (a0, a1) = (geo::ring_area(&ring), geo::ring_area(&c));
        assert!((a0 - a1).abs() < 1e-5, "area preserved {a0} vs {a1}");
        // negative control: genuinely collinear vertices are still removed
        let sq = vec![[0.0, 0.0], [5.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        assert_eq!(geo::clean_ring(&sq).len(), 4);
        // the grown ring must still contain the original (the Bearing failure: material inside the lower layer fell outside it)
        let p = vec![Poly { contour: rect(0.0, 0.0, 20.0, 20.0).contour, holes: vec![ring.iter().rev().cloned().collect()] }];
        let g = geo::offset(&p, 0.2);
        for k in 0..n {
            let a = k as f64 / n as f64 * std::f64::consts::TAU;
            assert!(geo::region_contains(&g, [10.0 + 5.3 * a.cos(), 10.0 + 5.3 * a.sin()]), "material at angle {k} lost");
        }
    }

    #[test]
    fn touching_islands_closed_by_slice_closing_radius() {
        // syn_thin_wall_box_open: four wall slabs 0.01 mm apart must become ONE ring (two loops), as in Orca
        let slabs = vec![
            rect(0.0, 0.0, 40.0, 0.79),
            rect(0.0, 0.8, 0.8, 39.2),
            rect(0.0, 39.21, 40.0, 40.0),
            rect(39.2, 0.8, 40.0, 39.2),
        ];
        let mut p = WallParams::default();
        p.slice_closing_radius = 0.049;
        p.wall_loops = 1;
        let closed = generate_walls(&slabs, None, None, &p).unwrap();
        assert_eq!(count(&closed, Feature::OuterWall), 2, "outer ring + hole ring");
        assert!(closed.paths.iter().all(|q| q.closed));
        // negative control: without the closing radius the slabs stay four islands
        p.slice_closing_radius = 0.0;
        let open = generate_walls(&slabs, None, None, &p).unwrap();
        assert!(count(&open, Feature::OuterWall) >= 4);
    }

    #[test]
    fn medial_axis_thin_bar() {
        let bar = rect(0.0, 0.0, 10.0, 0.3);
        let m = medial_axis(&bar, 0.1, 1.0);
        assert_eq!(m.len(), 1, "{:?}", m);
        assert!(m[0].length() > 9.5 && m[0].length() < 10.2, "length {}", m[0].length());
        for w in &m[0].width {
            assert!((w - 0.3).abs() < 1e-3, "w {}", w);
        }
        // negative control: a bar wider than max_width has no medial axis
        assert!(medial_axis(&rect(0.0, 0.0, 10.0, 3.0), 0.1, 1.0).is_empty());
        // taper: width must vary along the axis
        let taper = Poly { contour: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 0.6], [0.0, 0.2]], holes: vec![] };
        let t = medial_axis(&taper, 0.05, 1.0);
        assert_eq!(t.len(), 1);
        let (mn, mx) = t[0].width.iter().fold((f64::MAX, 0.0f64), |(a, b), &w| (a.min(w), b.max(w)));
        assert!(mx - mn > 0.15, "taper widths {mn}..{mx}");
    }

    #[test]
    fn variable_width_converts_taper_to_steps() {
        let tp = ThickPolyline { points: vec![[0.0, 0.0], [10.0, 0.0]], width: vec![0.2, 0.6], endpoints: (false, false) };
        let g = variable_width(&[tp], Flow::new(0.42, 0.2));
        assert_eq!(g.len(), 1);
        assert!(g[0].len() >= 4, "taper 0.2..0.6 with 0.05 tolerance gives several constant-width pieces, got {}", g[0].len());
        let ws: Vec<f64> = g[0].iter().map(|p| p.width).collect();
        assert!(ws.windows(2).all(|w| w[1] >= w[0] - 1e-9), "monotone {:?}", ws);
    }

    fn base() -> WallParams {
        let mut p = WallParams::default();
        p.top_bottom_infill_wall_overlap = 25.0;
        p
    }

    #[test]
    fn square_two_walls_lengths_order_and_infill_region() {
        let p = base();
        let island = vec![rect(0.0, 0.0, 20.0, 20.0)];
        let lower = island.clone();
        let upper = island.clone();
        let r = generate_walls(&island, Some(&lower), Some(&upper), &p).unwrap();
        let sp = |w: f64| w - 0.2 * (1.0 - 0.25 * PI);
        let ext_sp2 = 0.5 * (sp(0.42) + sp(0.45));
        assert_eq!(count(&r, Feature::OuterWall), 1);
        assert_eq!(count(&r, Feature::InnerWall), 1);
        assert_eq!(count(&r, Feature::GapInfill), 0);
        let outer_side = 20.0 - 0.42;
        let inner_side = 20.0 - 2.0 * (0.21 + ext_sp2);
        assert!((total(&r, Feature::OuterWall) - 4.0 * outer_side).abs() < 1e-6, "{}", total(&r, Feature::OuterWall));
        assert!((total(&r, Feature::InnerWall) - 4.0 * inner_side).abs() < 1e-6, "{}", total(&r, Feature::InnerWall));
        // InnerOuter: the inner loop is printed first
        assert_eq!(r.paths[0].feature, Feature::InnerWall);
        assert_eq!(r.paths[1].feature, Feature::OuterWall);
        assert!(r.paths.iter().all(|q| q.closed));
        // infill region: inset = 0.21 + ext_sp2 + sp/2 - overlap, overlap = infill_wall_overlap(15%) of (sp/2 + solid_sp/2)
        let inset0 = sp(0.45) / 2.0;
        let overlap = 0.15 * (inset0 + sp(0.42) / 2.0);
        let side = 20.0 - 2.0 * (0.21 + ext_sp2 + inset0 - overlap);
        assert!((geo::polys_area(&r.infill_region) - side * side).abs() < 1e-3, "{} vs {}", geo::polys_area(&r.infill_region), side * side);
        // negative control: outer-first reverses the print order
        let mut q = p.clone();
        q.wall_sequence = WallSequence::OuterInner;
        let r2 = generate_walls(&island, Some(&lower), Some(&upper), &q).unwrap();
        assert_eq!(r2.paths[0].feature, Feature::OuterWall);
        // top layer (no upper, only_one_wall_top): a single wall
        let mut t = p.clone();
        t.only_one_wall_top = true;
        let r3 = generate_walls(&island, Some(&lower), None, &t).unwrap();
        assert_eq!(count(&r3, Feature::InnerWall), 0);
        let r4 = generate_walls(&island, Some(&lower), Some(&upper), &t).unwrap();
        assert_eq!(count(&r4, Feature::InnerWall), 1, "negative control: with an upper layer the second wall stays");
    }

    #[test]
    fn precise_outer_wall_changes_inner_spacing_only_for_inner_outer() {
        let island = vec![rect(0.0, 0.0, 20.0, 20.0)];
        let mut a = base();
        a.precise_outer_wall = true;
        let mut b = base();
        b.precise_outer_wall = false;
        let ra = generate_walls(&island, Some(&island), Some(&island), &a).unwrap();
        let rb = generate_walls(&island, Some(&island), Some(&island), &b).unwrap();
        assert!((total(&ra, Feature::OuterWall) - total(&rb, Feature::OuterWall)).abs() < 1e-9);
        assert!(total(&ra, Feature::InnerWall) < total(&rb, Feature::InnerWall), "precise uses the (smaller) width mean, so the inner wall sits deeper");
        // ignored when the sequence is not inner/outer (Orca: "ignore precise_outer_wall if wall_sequence is not InnerOuter")
        let mut c = a.clone();
        c.wall_sequence = WallSequence::OuterInner;
        let rc = generate_walls(&island, Some(&island), Some(&island), &c).unwrap();
        assert!((total(&rc, Feature::InnerWall) - total(&rb, Feature::InnerWall)).abs() < 1e-9);
    }

    #[test]
    fn thin_strip_gets_one_loop_and_a_gap_fill_line() {
        let island = vec![rect(0.0, 0.0, 20.0, 1.3)];
        let p = base();
        let r = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        assert_eq!(count(&r, Feature::OuterWall), 1);
        assert_eq!(count(&r, Feature::InnerWall), 0);
        assert_eq!(count(&r, Feature::GapInfill), 1, "{:?}", r.paths.iter().map(|q| (q.feature, len(q))).collect::<Vec<_>>());
        let g = r.paths.iter().find(|q| q.feature == Feature::GapInfill).unwrap();
        assert!(len(g) > 19.0 && len(g) < 20.5, "gap fill length {}", len(g));
        assert!(g.pts[0].w > 0.4 && g.pts[0].w < 0.6, "gap fill bead width {}", g.pts[0].w);
        // negative control: gap fill disabled
        let mut q = p.clone();
        q.gap_infill = false;
        let r2 = generate_walls(&island, Some(&island), Some(&island), &q).unwrap();
        assert_eq!(count(&r2, Feature::GapInfill), 0);
        // the covered strip is removed from the infill region (nothing left to infill)
        assert!(geo::polys_area(&r.infill_region) < 1e-6, "{}", geo::polys_area(&r.infill_region));
    }

    #[test]
    fn overhang_wall_where_the_lower_layer_is_missing() {
        let p = base();
        let island = vec![rect(0.0, 0.0, 20.0, 20.0)];
        let lower = vec![rect(0.0, 0.0, 10.0, 20.0)]; // right half has nothing below
        let r = generate_walls(&island, Some(&lower), Some(&island), &p).unwrap();
        let oh = total(&r, Feature::OverhangWall);
        assert!(oh > 20.0, "overhang wall length {oh}");
        assert!(r.paths.iter().filter(|q| q.feature == Feature::OverhangWall).all(|q| (q.layer_h - p.overhang_height).abs() < 1e-12));
        // negative control: fully supported -> no overhang wall at all
        let r2 = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        assert_eq!(total(&r2, Feature::OverhangWall), 0.0);
        // detect_overhang_wall = false -> none
        let mut q = p.clone();
        q.detect_overhang_wall = false;
        let r3 = generate_walls(&island, Some(&lower), Some(&island), &q).unwrap();
        assert_eq!(total(&r3, Feature::OverhangWall), 0.0);
    }

    #[test]
    fn hole_walls_nest_and_unsupported_options_are_refused() {
        let ring = Poly { contour: rect(0., 0., 20., 20.).contour, holes: vec![rect(8., 8., 12., 12.).contour.into_iter().rev().collect()] };
        let island = vec![ring];
        let p = base();
        let r = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        assert_eq!(count(&r, Feature::OuterWall), 2); // contour + hole
        assert_eq!(count(&r, Feature::InnerWall), 2);
        let mut q = p.clone();
        q.fuzzy_skin = true;
        assert!(matches!(generate_walls(&island, None, None, &q), Err(FdmError::Unsupported(_))));
        let mut q = p.clone();
        q.overhang_reverse = true;
        assert!(matches!(generate_walls(&island, None, None, &q), Err(FdmError::Unsupported(_))));
    }

    #[test]
    fn deterministic() {
        let island = vec![rect(0.0, 0.0, 20.0, 1.3), rect(0.0, 5.0, 20.0, 9.0)];
        let p = base();
        let a = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        let b = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        assert_eq!(a.paths.len(), b.paths.len());
        for (x, y) in a.paths.iter().zip(b.paths.iter()) {
            assert_eq!(x.pts, y.pts);
        }
    }
}
