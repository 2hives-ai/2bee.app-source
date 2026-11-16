//! Lane 1: polygon booleans, offset, hatch over `types::Polys` (i_overlay 9.x, pure Rust).
//!
//! Conventions: millimetres, f64. Outputs are normalised: contours CCW, holes CW (area sign), no
//! repeated closing point. All ops are deterministic (no hash iteration, no randomness).
use crate::types::{Poly, Polys, Ring};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::clip::FloatClip;
use i_overlay::float::single::SingleFloatOverlay;
use i_overlay::float::simplify::SimplifyShape;
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};
use i_overlay::string::clip::ClipRule;

type Pt = [f64; 2];

/// Join style for `offset_ex`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Join {
    /// Clipper-style miter with a miter limit (Orca uses 3 for most perimeter offsets).
    Miter { limit: f64 },
    /// Round join; `arc_tol` is the max chord deviation in mm (Orca: scaled 0.0025..0.01).
    Round { arc_tol: f64 },
}

// ---------------------------------------------------------------- conversions
/// Signed area of a ring (positive = CCW).
pub fn ring_area(r: &[Pt]) -> f64 {
    let n = r.len();
    if n < 3 { return 0.0; }
    let mut s = 0.0;
    for i in 0..n {
        let a = r[i];
        let b = r[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    0.5 * s
}

fn drop_closing(mut r: Ring) -> Ring {
    if r.len() > 1 && r.first() == r.last() { r.pop(); }
    r
}

fn to_shapes(p: &Polys) -> Vec<Vec<Vec<Pt>>> {
    p.iter()
        .filter(|q| q.contour.len() >= 3)
        .map(|q| {
            let mut s = vec![q.contour.clone()];
            for h in &q.holes { if h.len() >= 3 { s.push(h.clone()); } }
            s
        })
        .collect()
}

fn from_shapes(shapes: Vec<Vec<Vec<Pt>>>) -> Polys {
    let mut out = Vec::with_capacity(shapes.len());
    for s in shapes {
        let mut it = s.into_iter();
        let Some(c) = it.next() else { continue };
        let mut contour = drop_closing(c);
        if contour.len() < 3 { continue; }
        if ring_area(&contour) < 0.0 { contour.reverse(); }
        let mut holes = Vec::new();
        for h in it {
            let mut h = drop_closing(h);
            if h.len() < 3 { continue; }
            if ring_area(&h) > 0.0 { h.reverse(); }
            holes.push(h);
        }
        out.push(Poly { contour, holes });
    }
    out
}

/// Re-normalise orientation (contour CCW, holes CW) and drop closing duplicates / degenerate rings.
pub fn normalize(p: &Polys) -> Polys {
    from_shapes(
        p.iter()
            .map(|q| {
                let mut s = vec![q.contour.clone()];
                s.extend(q.holes.iter().cloned());
                s
            })
            .collect(),
    )
}

// ---------------------------------------------------------------- booleans
fn boolean(a: &Polys, b: &Polys, rule: OverlayRule) -> Polys {
    let sa = to_shapes(a);
    let sb = to_shapes(b);
    if sa.is_empty() && sb.is_empty() { return vec![]; }
    from_shapes(sa.overlay(&sb, rule, FillRule::EvenOdd))
}

/// a ∪ b (also merges overlapping members of a single set: `union(a, &vec![])`).
pub fn union(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Union) }
/// a − b
pub fn diff(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Difference) }
/// a ∩ b
pub fn intersect(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Intersect) }
/// a ⊕ b
pub fn xor(a: &Polys, b: &Polys) -> Polys { boolean(a, b, OverlayRule::Xor) }

/// Union of many sets in one pass (non-zero fill so overlapping members merge).
pub fn union_all(sets: &[&Polys]) -> Polys {
    let mut shapes = Vec::new();
    for s in sets { shapes.extend(to_shapes(s)); }
    if shapes.is_empty() { return vec![]; }
    from_shapes(shapes.simplify_shape(FillRule::NonZero))
}

/// Resolve self-overlap / orientation of a set (what Clipper's `union_ex` of one set does).
pub fn simplify_polys(p: &Polys) -> Polys { union_all(&[p]) }

/// Build regions from loose rings with the EVEN-ODD rule (a ring nested in a ring is a hole, nested
/// again is an island...) whatever each ring's winding. Self-overlap of rings is resolved.
pub fn polys_from_rings_evenodd(rings: &[Ring]) -> Polys {
    polys_from_rings_evenodd_owned(rings.iter().filter(|r| r.len() >= 3).cloned().collect())
}

/// `polys_from_rings_evenodd` that takes the rings by value (no copy; the slicer's hot path).
pub fn polys_from_rings_evenodd_owned(mut rs: Vec<Ring>) -> Polys {
    rs.retain(|r| r.len() >= 3);
    if rs.is_empty() { return vec![]; }
    from_shapes(rs.simplify_shape(FillRule::EvenOdd))
}

// ---------------------------------------------------------------- offset
fn miter_min_angle(limit: f64) -> f64 {
    // Clipper miter limit ML = 1 / sin(theta/2) with theta the interior angle at the corner.
    let l = limit.max(1.0001);
    2.0 * (1.0 / l).asin()
}

fn style(delta: f64, join: Join) -> OutlineStyle<f64> {
    let j = match join {
        Join::Miter { limit } => LineJoin::Miter(miter_min_angle(limit)),
        Join::Round { arc_tol } => {
            // max segment length / radius ratio from sagitta: step = 2*acos(1 - tol/R); L/R = 2 sin(step/2).
            let r = delta.abs().max(1e-9);
            let t = (arc_tol / r).clamp(1e-6, 0.5);
            let step = 2.0 * (1.0 - t).acos();
            LineJoin::Round(2.0 * (step / 2.0).sin())
        }
    };
    OutlineStyle::new(delta).line_join(j)
}

/// Remove zero-width spikes (a,b,a) that an offset leaves at consumed short edges (Clipper's positive-fill union drops them).
fn despike(r: Vec<Pt>) -> Vec<Pt> {
    const E: f64 = 1e-5;
    let mut st: Vec<Pt> = Vec::with_capacity(r.len());
    for p in r {
        if st.len() >= 2 && (st[st.len() - 2][0] - p[0]).abs() < E && (st[st.len() - 2][1] - p[1]).abs() < E { st.pop(); continue; }
        if st.last().map_or(false, |q| (q[0] - p[0]).abs() < E && (q[1] - p[1]).abs() < E) { continue; }
        st.push(p);
    }
    loop {
        let n = st.len();
        if n >= 3 && (st[n - 2][0] - st[0][0]).abs() < E && (st[n - 2][1] - st[0][1]).abs() < E { st.pop(); st.remove(0); continue; }
        if n >= 3 && (st[1][0] - st[n - 1][0]).abs() < E && (st[1][1] - st[n - 1][1]).abs() < E { st.remove(0); st.pop(); continue; }
        break;
    }
    st
}

/// Offset by `delta` mm (>0 outset, <0 inset). Holes move the opposite way automatically.
pub fn offset_ex(p: &Polys, delta: f64, join: Join) -> Polys {
    if p.is_empty() { return vec![]; }
    if delta == 0.0 { return normalize(p); }
    // The offsetter needs valid shapes; per-shape call keeps shapes independent, a final union merges overlaps.
    let st = style(delta, join);
    let mut out: Vec<Vec<Vec<Pt>>> = Vec::new();
    for s in to_shapes(p) {
        out.extend(s.outline(&st));
    }
    let res = out.simplify_shape(FillRule::NonZero);
    if std::env::var("W2B_NODESPIKE").is_ok() { return from_shapes(res); }
    from_shapes(res.into_iter().map(|s| s.into_iter().map(despike).collect()).collect())
}

/// Offset with a miter join (limit 3, Orca's default for perimeters).
pub fn offset(p: &Polys, delta: f64) -> Polys { offset_ex(p, delta, Join::Miter { limit: 3.0 }) }
pub fn inset(p: &Polys, d: f64) -> Polys { offset(p, -d.abs()) }
pub fn outset(p: &Polys, d: f64) -> Polys { offset(p, d.abs()) }
/// Round-join offset with arc tolerance in mm.
pub fn offset_round(p: &Polys, delta: f64, arc_tol: f64) -> Polys { offset_ex(p, delta, Join::Round { arc_tol }) }

/// Morphological opening (inset then outset): removes features narrower than `2*d`.
pub fn opening(p: &Polys, d: f64) -> Polys { offset(&offset(p, -d), d) }
/// Morphological closing (outset then inset): fills gaps narrower than `2*d`.
pub fn closing(p: &Polys, d: f64) -> Polys { offset(&offset(p, d), -d) }

// ---------------------------------------------------------------- measures
/// Net area (contours minus holes), mm².
pub fn area(p: &Polys) -> f64 {
    p.iter().map(|q| ring_area(&q.contour).abs() - q.holes.iter().map(|h| ring_area(h).abs()).sum::<f64>()).sum()
}

/// Axis-aligned bounding box `[minx, miny, maxx, maxy]` of the contours, None when empty.
pub fn bbox(p: &Polys) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let mut any = false;
    for q in p { for v in &q.contour {
        any = true;
        b[0] = b[0].min(v[0]); b[1] = b[1].min(v[1]); b[2] = b[2].max(v[0]); b[3] = b[3].max(v[1]);
    } }
    any.then_some(b)
}

fn pip_ring(r: &[Pt], x: f64, y: f64) -> bool {
    let n = r.len();
    let mut inside = false;
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (r[i], r[j]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] { inside = !inside; }
        j = i;
    }
    inside
}

/// Point inside the region (contour and not in a hole). Boundary points are unspecified.
pub fn point_in_polys(p: &Polys, x: f64, y: f64) -> bool {
    p.iter().any(|q| pip_ring(&q.contour, x, y) && !q.holes.iter().any(|h| pip_ring(h, x, y)))
}

/// Drop islands with net area below `min_area` and holes with area below `min_area`.
pub fn clean(p: &Polys, min_area: f64) -> Polys {
    p.iter()
        .filter(|q| ring_area(&q.contour).abs() - q.holes.iter().map(|h| ring_area(h).abs()).sum::<f64>() >= min_area)
        .map(|q| Poly {
            contour: q.contour.clone(),
            holes: q.holes.iter().filter(|h| ring_area(h).abs() >= min_area).cloned().collect(),
        })
        .collect()
}

// ---------------------------------------------------------------- simplify
fn rdp(pts: &[Pt], eps: f64, keep: &mut Vec<bool>, lo: usize, hi: usize) {
    if hi <= lo + 1 { return; }
    let (a, b) = (pts[lo], pts[hi]);
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let (mut dmax, mut idx) = (0.0, lo);
    for i in lo + 1..hi {
        let p = pts[i];
        let d = if l2 < 1e-24 { ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt() }
                else { ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / l2.sqrt() };
        if d > dmax { dmax = d; idx = i; }
    }
    if dmax > eps { keep[idx] = true; rdp(pts, eps, keep, lo, idx); rdp(pts, eps, keep, idx, hi); }
}

/// Ramer-Douglas-Peucker on an open polyline (endpoints kept).
pub fn simplify_polyline(pts: &[Pt], eps: f64) -> Vec<Pt> {
    if pts.len() < 3 { return pts.to_vec(); }
    let mut keep = vec![false; pts.len()];
    keep[0] = true; *keep.last_mut().unwrap() = true;
    rdp(pts, eps, &mut keep, 0, pts.len() - 1);
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// RDP on a closed ring; split at the two points furthest apart so no vertex is privileged.
pub fn simplify_ring(r: &[Pt], eps: f64) -> Ring {
    let n = r.len();
    if n < 4 { return r.to_vec(); }
    let mut far = 0; let mut dm = -1.0;
    for i in 1..n { let d = (r[i][0] - r[0][0]).powi(2) + (r[i][1] - r[0][1]).powi(2); if d > dm { dm = d; far = i; } }
    let a: Vec<Pt> = r[..=far].to_vec();
    let mut b: Vec<Pt> = r[far..].to_vec(); b.push(r[0]);
    let a = simplify_polyline(&a, eps);
    let b = simplify_polyline(&b, eps);
    // a ends at r[far] (kept); b starts at r[far] and ends at r[0] (dropped: a starts there).
    let mut out = a;
    out.extend_from_slice(&b[1..b.len() - 1]);
    out
}

/// Douglas-Peucker every ring; drops rings that collapse below 3 vertices. Result re-unioned for validity.
pub fn simplify(p: &Polys, eps: f64) -> Polys {
    let mut shapes = Vec::new();
    for q in p {
        let c = simplify_ring(&q.contour, eps);
        if c.len() < 3 { continue; }
        let mut s = vec![c];
        for h in &q.holes { let h = simplify_ring(h, eps); if h.len() >= 3 { s.push(h); } }
        shapes.push(s);
    }
    if shapes.is_empty() { return vec![]; }
    from_shapes(shapes.simplify_shape(FillRule::NonZero))
}

// ---------------------------------------------------------------- hatch
/// Parallel lines at `angle_deg` (CCW from +X), pitch `spacing`, clipped to `region`.
/// Lines sit at fixed multiples of `spacing` (+ `phase`) in the rotated frame, so layers/regions align.
/// Returns open 2-point polylines directed along +u (rotated frame), sorted by line then position.
pub fn hatch(region: &Polys, angle_deg: f64, spacing: f64, phase: f64) -> Vec<Vec<Pt>> {
    hatch_threads(region, angle_deg, spacing, phase, 1)
}

/// Rotated-frame line set shared by the hatch variants: (lines, sa, ca). `None` when there is nothing to hatch.
fn hatch_lines(region: &Polys, angle_deg: f64, spacing: f64, phase: f64) -> Option<(Vec<Vec<Pt>>, f64, f64)> {
    if region.is_empty() || spacing <= 0.0 { return None; }
    let bb = bbox(region)?;
    let a = angle_deg.to_radians();
    let (ca, sa) = (a.cos(), a.sin());
    let (mut vlo, mut vhi, mut ulo, mut uhi) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for (x, y) in [(bb[0], bb[1]), (bb[2], bb[1]), (bb[2], bb[3]), (bb[0], bb[3])] {
        let u = x * ca + y * sa; let v = -x * sa + y * ca;
        vlo = vlo.min(v); vhi = vhi.max(v); ulo = ulo.min(u); uhi = uhi.max(u);
    }
    let mut k = ((vlo - phase) / spacing).ceil();
    let mut lines: Vec<Vec<Pt>> = Vec::new();
    loop {
        let v = k * spacing + phase;
        if v > vhi { break; }
        let (u0, u1) = (ulo - 1.0, uhi + 1.0);
        lines.push(vec![[u0 * ca - v * sa, u0 * sa + v * ca], [u1 * ca - v * sa, u1 * sa + v * ca]]);
        k += 1.0;
    }
    Some((lines, sa, ca))
}

/// Normalise one clipped piece: directed along +u, dropped when shorter than 1e-6; returns the sort key and the 2-point line.
fn hatch_piece(mut seg: Vec<Pt>, v: f64, sa: f64, ca: f64) -> Option<(f64, f64, Vec<Pt>)> {
    let _ = sa;
    if seg.len() < 2 { return None; }
    let u_first = seg[0][0] * ca + seg[0][1] * sa;
    let u_last = seg[seg.len() - 1][0] * ca + seg[seg.len() - 1][1] * sa;
    if u_last < u_first { seg.reverse(); }
    let u0 = seg[0][0] * ca + seg[0][1] * sa;
    if (seg[seg.len() - 1][0] - seg[0][0]).hypot(seg[seg.len() - 1][1] - seg[0][1]) < 1e-6 { return None; }
    Some((v, u0, vec![seg[0], seg[seg.len() - 1]]))
}

fn hatch_sorted(mut out: Vec<(f64, f64, Vec<Pt>)>) -> Vec<Vec<Pt>> {
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.partial_cmp(&b.1).unwrap()));
    out.into_iter().map(|t| t.2).collect()
}

/// [`hatch`] with the per-line clips spread over `threads` threads. Each line is clipped by its own independent
/// i_overlay call (exactly as in `hatch`), results are collected in line order and sorted by the same key, so the
/// output is BIT-IDENTICAL to `hatch` for every thread count (it only changes which core runs which line).
pub fn hatch_threads(region: &Polys, angle_deg: f64, spacing: f64, phase: f64, threads: usize) -> Vec<Vec<Pt>> {
    let Some((lines, sa, ca)) = hatch_lines(region, angle_deg, spacing, phase) else { return vec![] };
    let shapes = to_shapes(region);
    let rule = ClipRule { invert: false, boundary_included: true };
    let per_line: Vec<Vec<(f64, f64, Vec<Pt>)>> = crate::slice::par_map_chunked(&lines, threads, 4, |_, l| {
        let v = -l[0][0] * sa + l[0][1] * ca;
        l.clip_by(&shapes, FillRule::EvenOdd, rule).into_iter().filter_map(|seg| hatch_piece(seg, v, sa, ca)).collect()
    });
    hatch_sorted(per_line.into_iter().flatten().collect())
}

/// FAST, NOT BIT-IDENTICAL to [`hatch`]: all lines go through ONE i_overlay clip (one shape build, one sweep)
/// instead of one call per line. i_overlay quantises floats onto an integer grid whose origin/scale come from the
/// bounding box of the input of each call, so a single call uses a different grid than 60 separate ones: the
/// returned line ends can differ by up to one grid cell (about 1e-7..1e-6 mm for a 100 mm part). Same segments in
/// the same order, ends within that cell. Use it where a sub-micron end shift is irrelevant (infill preview,
/// estimates); keep `hatch` where bytes must match.
pub fn hatch_batched(region: &Polys, angle_deg: f64, spacing: f64, phase: f64) -> Vec<Vec<Pt>> {
    let Some((lines, sa, ca)) = hatch_lines(region, angle_deg, spacing, phase) else { return vec![] };
    let shapes = to_shapes(region);
    let rule = ClipRule { invert: false, boundary_included: true };
    // v of the line a piece lies on: nearest line index in the rotated frame, then the SAME v expression as `hatch`
    let v0 = -lines[0][0][0] * sa + lines[0][0][1] * ca;
    let line_v: Vec<f64> = lines.iter().map(|l| -l[0][0] * sa + l[0][1] * ca).collect();
    let pitch = if lines.len() > 1 { line_v[1] - line_v[0] } else { spacing };
    let mut out = Vec::new();
    for seg in lines.clip_by(&shapes, FillRule::EvenOdd, rule) {
        if seg.len() < 2 { continue; }
        let vs = -seg[0][0] * sa + seg[0][1] * ca;
        let idx = (((vs - v0) / pitch).round().max(0.0) as usize).min(lines.len() - 1);
        if let Some(t) = hatch_piece(seg, line_v[idx], sa, ca) { out.push(t); }
    }
    hatch_sorted(out)
}

/// Total length of a polyline.
pub fn polyline_len(pl: &[Pt]) -> f64 { pl.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum() }

// ---------------------------------------------------------------- tests
#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polys {
        vec![Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }]
    }
    fn ring_poly() -> Polys {
        let mut p = rect(0.0, 0.0, 20.0, 20.0);
        p[0].holes.push(vec![[5.0, 5.0], [5.0, 15.0], [15.0, 15.0], [15.0, 5.0]]);
        p
    }
    #[test] fn booleans() {
        let a = rect(0.0, 0.0, 10.0, 10.0); let b = rect(5.0, 5.0, 15.0, 15.0);
        assert!((area(&union(&a, &b)) - 175.0).abs() < 1e-9);
        assert!((area(&intersect(&a, &b)) - 25.0).abs() < 1e-9);
        assert!((area(&diff(&a, &b)) - 75.0).abs() < 1e-9);
        assert!((area(&xor(&a, &b)) - 150.0).abs() < 1e-9);
        assert!(union(&vec![], &vec![]).is_empty());
    }
    #[test] fn orientation() {
        let cw = vec![Poly { contour: vec![[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]], holes: vec![] }];
        let n = normalize(&cw);
        assert!(ring_area(&n[0].contour) > 0.0);
        let r = union(&ring_poly(), &vec![]);
        assert!(ring_area(&r[0].contour) > 0.0 && ring_area(&r[0].holes[0]) < 0.0);
        assert!((area(&r) - 300.0).abs() < 1e-9);
    }
    #[test] fn offsets() {
        let sq = rect(0.0, 0.0, 10.0, 10.0);
        assert!((area(&offset(&sq, -1.0)) - 64.0).abs() < 1e-6);
        assert!((area(&offset(&sq, 1.0)) - 144.0).abs() < 1e-6);
        // round outset: 100 + 4*10*1 + pi
        let r = area(&offset_round(&sq, 1.0, 0.005));
        assert!((r - (140.0 + std::f64::consts::PI)).abs() < 0.03, "{r}");
        // ring: inset by 1 -> contour 18x18, hole 12x12
        assert!((area(&offset(&ring_poly(), -1.0)) - (324.0 - 144.0)).abs() < 1e-6);
        assert!(offset(&sq, -6.0).is_empty());
        // thin feature vanishes under opening
        let thin = union(&sq, &rect(10.0, 4.9, 20.0, 5.1));
        assert!((area(&opening(&thin, 0.5)) - 100.0).abs() < 0.5);
    }
    #[test] fn evenodd_rings() {
        let outer = vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        let hole_ccw = vec![[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0]]; // same winding as outer on purpose
        let island = vec![[8.0, 8.0], [12.0, 8.0], [12.0, 12.0], [8.0, 12.0]];
        let p = polys_from_rings_evenodd(&[outer, hole_ccw, island]);
        assert_eq!(p.len(), 2);
        assert!((area(&p) - (400.0 - 100.0 + 16.0)).abs() < 1e-9);
    }
    #[test] fn measures() {
        let r = ring_poly();
        assert_eq!(bbox(&r), Some([0.0, 0.0, 20.0, 20.0]));
        assert!(point_in_polys(&r, 2.0, 2.0) && !point_in_polys(&r, 10.0, 10.0) && !point_in_polys(&r, 30.0, 1.0));
        let mut s = rect(0.0, 0.0, 10.0, 10.0); s.extend(rect(20.0, 20.0, 20.1, 20.1));
        assert_eq!(clean(&s, 0.05).len(), 1);
    }
    #[test] fn simplify_works() {
        let mut c = vec![]; for i in 0..=100 { c.push([i as f64 * 0.1, 0.0]); }
        c.extend([[10.0, 10.0], [0.0, 10.0]]);
        let p = vec![Poly { contour: c, holes: vec![] }];
        let s = simplify(&p, 0.01);
        assert_eq!(s[0].contour.len(), 4);
        assert!((area(&s) - 100.0).abs() < 1e-6);
    }
    #[test] fn hatch_square() {
        let h = hatch(&rect(0.0, 0.0, 10.0, 10.0), 0.0, 1.0, 0.5);
        assert_eq!(h.len(), 10);
        for l in &h { assert!((polyline_len(l) - 10.0).abs() < 1e-6); }
        // ring: each line through hole splits in two
        let h = hatch(&ring_poly(), 0.0, 1.0, 0.5);
        let tot: f64 = h.iter().map(|l| polyline_len(l)).sum();
        assert!((tot - 300.0).abs() < 1e-3, "{tot}");
        // 45 deg total length ~ area/spacing
        let h = hatch(&rect(0.0, 0.0, 10.0, 10.0), 45.0, 0.5, 0.0);
        let tot: f64 = h.iter().map(|l| polyline_len(l)).sum();
        assert!((tot - 200.0).abs() < 1.0, "{tot}");
        assert!(hatch(&vec![], 0.0, 1.0, 0.0).is_empty());
    }
    #[test] fn hatch_threads_bit_identical_and_batched_close() {
        let mut reg = ring_poly();
        reg.extend(rect(30.0, 3.0, 41.5, 17.25));
        for (ang, sp, ph) in [(0.0, 1.0, 0.5), (45.0, 0.7, 0.0), (117.0, 1.3, 0.2)] {
            let serial = hatch(&reg, ang, sp, ph);
            assert!(!serial.is_empty());
            for t in [1usize, 2, 5, 16] { assert_eq!(hatch_threads(&reg, ang, sp, ph, t), serial, "threads {t}"); }
            let b = hatch_batched(&reg, ang, sp, ph);
            assert_eq!(b.len(), serial.len());
            for (x, y) in b.iter().zip(&serial) { for k in 0..2 { for c in 0..2 { assert!((x[k][c] - y[k][c]).abs() < 1e-5, "{x:?} vs {y:?}"); } } }
        }
    }
}
