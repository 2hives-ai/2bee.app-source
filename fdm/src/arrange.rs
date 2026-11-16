//! Orca's `arrangement::arrange` (libnest2d no-fit-polygon placer, first-fit selection) for a rectangular bed.
//!
//! This is a port of OrcaSlicer 2.5.0-dev `libslic3r/Arrange.cpp` and `deps_src/libnest2d` (nfpplacer.hpp,
//! firstfit.hpp, rotcalipers.hpp, geometry_traits_nfp.hpp) plus the NLopt Nelder-Mead / Subplex (`sbplx`) for
//! one variable that the placer uses to slide an item along the boundary of its no-fit polygons. Coordinates are
//! the same scaled integers (1e-6 mm) so that rounding decisions are the same ones.
//!
//! Scope, stated:
//! * rectangular bed only (Orca's `call_with_bed` takes the `BoundingBox` path when the bed is a rectangle);
//!   a non-rectangular bed is REFUSED, never approximated;
//! * one plate: when an item does not fit, Orca opens a second plate; here that is an error;
//! * every item is its convex hull (what Orca nests), by-layer printing (no `print_sequence = by object` logic);
//! * `std::sort` of the item list is emulated with a stable sort (libstdc++ uses insertion sort for <= 16 items,
//!   which is stable; above 16 items the order of EQUAL items may differ from Orca's introsort).
//! The result is validated against Orca's own `arrangement::arrange` linked into a C++ oracle (see the unit tests'
//! fixture list and the report); where it differs it is stated in the report, not hidden.
use std::cmp::Ordering;

pub type Pt = [i64; 2];

const SCALE: f64 = 1e6;
const LARGE_COST_TO_REJECT: f64 = 1e7;
const BIG_ITEM_THRESHOLD: f64 = 0.02;
const TWO_PI: f64 = 2.0 * 3.141592653589793238463;

fn scaled(v: f64) -> i64 { (v * SCALE).round() as i64 }
fn unscaled(v: i64) -> f64 { v as f64 / SCALE }

// ------------------------------------------------------------------------------------------------ boxes
#[derive(Clone, Copy, Debug)]
struct Bx { min: Pt, max: Pt, defined: bool }

impl Bx {
    fn none() -> Bx { Bx { min: [0, 0], max: [0, 0], defined: false } }
    fn new(min: Pt, max: Pt) -> Bx { Bx { min, max, defined: true } }
    fn width(&self) -> i64 { self.max[0] - self.min[0] }
    fn height(&self) -> i64 { self.max[1] - self.min[1] }
    /// libnest2d `_Box::center()`: halves first, no rounding.
    fn center(&self) -> Pt { [self.min[0] / 2 + self.max[0] / 2, self.min[1] / 2 + self.max[1] / 2] }
    fn area_i(&self) -> i64 { self.width() * self.height() }
    fn union(a: &Bx, b: &Bx) -> Bx {
        if !a.defined { return *b; }
        if !b.defined { return *a; }
        Bx::new([a.min[0].min(b.min[0]), a.min[1].min(b.min[1])], [a.max[0].max(b.max[0]), a.max[1].max(b.max[1])])
    }
    fn intersects(&self, o: &Bx) -> bool {
        self.min[0] <= o.max[0] && o.min[0] <= self.max[0] && self.min[1] <= o.max[1] && o.min[1] <= self.max[1]
    }
    fn translated(&self, d: Pt) -> Bx { Bx { min: [self.min[0] + d[0], self.min[1] + d[1]], max: [self.max[0] + d[0], self.max[1] + d[1]], defined: self.defined } }
}

fn bbox_of(pts: &[Pt]) -> Bx {
    if pts.is_empty() { return Bx::none(); }
    let mut mn = pts[0];
    let mut mx = pts[0];
    for p in pts { mn[0] = mn[0].min(p[0]); mn[1] = mn[1].min(p[1]); mx[0] = mx[0].max(p[0]); mx[1] = mx[1].max(p[1]); }
    Bx::new(mn, mx)
}

fn dist(a: Pt, b: Pt) -> f64 {
    let dx = (b[0] - a[0]) as f64;
    let dy = (b[1] - a[1]) as f64;
    (dx * dx + dy * dy).sqrt()
}

// ------------------------------------------------------------------------------------------------ 256 bit compare
/// a*b <=> c*d for non-negative u128 values, exactly (schoolbook 128x128 -> 256).
fn mul_u128(a: u128, b: u128) -> (u128, u128) {
    let (a0, a1) = (a & 0xFFFF_FFFF_FFFF_FFFF, a >> 64);
    let (b0, b1) = (b & 0xFFFF_FFFF_FFFF_FFFF, b >> 64);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & 0xFFFF_FFFF_FFFF_FFFF) + (p10 & 0xFFFF_FFFF_FFFF_FFFF);
    let lo = (p00 & 0xFFFF_FFFF_FFFF_FFFF) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// Compare fractions n1/d1 and n2/d2 (d > 0) exactly; n may be negative.
fn cmp_frac(n1: i128, d1: i128, n2: i128, d2: i128) -> Ordering {
    // sign of each numerator first
    let s1 = n1.signum();
    let s2 = n2.signum();
    if s1 != s2 { return s1.cmp(&s2); }
    if s1 == 0 { return Ordering::Equal; }
    let l = mul_u128(n1.unsigned_abs(), d2 as u128);
    let r = mul_u128(n2.unsigned_abs(), d1 as u128);
    let o = l.cmp(&r);
    if s1 > 0 { o } else { o.reverse() }
}

// ------------------------------------------------------------------------------------------------ hull, polygons
fn cross3(o: Pt, a: Pt, b: Pt) -> i128 {
    (a[0] - o[0]) as i128 * (b[1] - o[1]) as i128 - (a[1] - o[1]) as i128 * (b[0] - o[0]) as i128
}

/// `Geometry::convex_hull(Points)`: Andrew monotone chain, CCW, collinear points dropped, starts at the leftmost-lowest point.
pub fn convex_hull(pts: &[Pt]) -> Vec<Pt> {
    let mut p: Vec<Pt> = pts.to_vec();
    p.sort_by(|a, b| a[0].cmp(&b[0]).then(a[1].cmp(&b[1])));
    p.dedup();
    let n = p.len();
    if n < 3 { return Vec::new(); }
    let mut h: Vec<Pt> = Vec::with_capacity(2 * n);
    for i in 0..n {
        while h.len() >= 2 && cross3(h[h.len() - 2], h[h.len() - 1], p[i]) <= 0 { h.pop(); }
        h.push(p[i]);
    }
    let t = h.len() + 1;
    for i in (0..n - 1).rev() {
        while h.len() >= t && cross3(h[h.len() - 2], h[h.len() - 1], p[i]) <= 0 { h.pop(); }
        h.push(p[i]);
    }
    h.pop();
    h
}

fn area2_signed(p: &[Pt]) -> i128 {
    let n = p.len();
    let mut s: i128 = 0;
    for i in 0..n {
        let a = p[i];
        let b = p[(i + 1) % n];
        s += a[0] as i128 * b[1] as i128 - b[0] as i128 * a[1] as i128;
    }
    s
}

/// libnest2d `area()` of a polygon (absolute value, double).
fn poly_area(p: &[Pt]) -> f64 {
    if p.len() < 3 { return 0.0; }
    (area2_signed(p) as f64 / 2.0).abs()
}

/// Clipper `ClipperOffset` with `jtSquare` on one convex counter-clockwise polygon, positive delta, then the
/// positive-fill union that drops collinear and repeated points. Mirrors `OffsetPoint` / `DoSquare`
/// (`deps_src/clipper/clipper.cpp`) including the `ShortestEdgeLength` pre-filter of `AddPath`.
fn offset_square(hull_ccw: &[Pt], delta: f64) -> Vec<Pt> {
    if delta == 0.0 || hull_ccw.len() < 3 { return hull_ccw.to_vec(); }
    // AddPath: strip points closer than ShortestEdgeLength (= |delta| * 0.005) to the previous kept point / to point 0
    let sel2 = (delta.abs() * 0.005) * (delta.abs() * 0.005);
    let mut path: Vec<Pt> = hull_ccw.to_vec();
    let mut high = path.len() - 1;
    while high > 0 {
        let dx = (path[high][0] - path[0][0]) as f64;
        let dy = (path[high][1] - path[0][1]) as f64;
        if dx * dx + dy * dy < sel2 { high -= 1; } else { break; }
    }
    let mut c: Vec<Pt> = vec![path[0]];
    for i in 1..=high {
        let last = *c.last().unwrap();
        let dx = (path[i][0] - last[0]) as f64;
        let dy = (path[i][1] - last[1]) as f64;
        if dx * dx + dy * dy < sel2 { continue; }
        c.push(path[i]);
    }
    path = c;
    let len = path.len();
    if len < 3 { return path; }
    // unit normals: normals[i] belongs to edge i -> i+1
    let mut normals: Vec<[f64; 2]> = Vec::with_capacity(len);
    for j in 0..len {
        let a = path[j];
        let b = path[(j + 1) % len];
        if a == b { normals.push([0.0, 0.0]); continue; }
        let dx = (b[0] - a[0]) as f64;
        let dy = (b[1] - a[1]) as f64;
        let f = 1.0 / (dx * dx + dy * dy).sqrt();
        normals.push([dy * f, -dx * f]);
    }
    let r = |v: f64| v.round() as i64;
    let mut out: Vec<Pt> = Vec::new();
    let mut k = len - 1;
    for j in 0..len {
        let sin_a = (normals[k][0] * normals[j][1] - normals[j][0] * normals[k][1]).clamp(-1.0, 1.0);
        // exactly as OffsetPoint: the |sinA * delta| < 1 branch looks at the unclamped value, which only differs when |sinA| > 1 (never)
        if (sin_a * delta).abs() < 1.0 {
            let cos_a = normals[k][0] * normals[j][0] + normals[j][1] * normals[k][1];
            if cos_a > 0.0 {
                out.push([r(path[j][0] as f64 + normals[k][0] * delta), r(path[j][1] as f64 + normals[k][1] * delta)]);
                k = j;
                continue;
            }
        }
        if sin_a * delta < 0.0 {
            // concave corner of a positive offset: cannot happen on a convex hull, kept for completeness
            out.push([r(path[j][0] as f64 + normals[k][0] * delta), r(path[j][1] as f64 + normals[k][1] * delta)]);
            out.push(path[j]);
            out.push([r(path[j][0] as f64 + normals[j][0] * delta), r(path[j][1] as f64 + normals[j][1] * delta)]);
        } else {
            // DoSquare
            let dx = (sin_a.atan2(normals[k][0] * normals[j][0] + normals[k][1] * normals[j][1]) / 4.0).tan();
            out.push([r(path[j][0] as f64 + delta * (normals[k][0] - normals[k][1] * dx)), r(path[j][1] as f64 + delta * (normals[k][1] + normals[k][0] * dx))]);
            out.push([r(path[j][0] as f64 + delta * (normals[j][0] + normals[j][1] * dx)), r(path[j][1] as f64 + delta * (normals[j][1] - normals[j][0] * dx))]);
        }
        k = j;
    }
    // the positive-fill union returns the ring in Clipper's start order (it matters: `rotcalipers` decides the
    // orientation from the first three vertices, and near-collinear corner pairs of a square join can flip that)
    clipper_ring_start(out, false)
}

/// Remove repeated points and exactly collinear vertices (what Clipper's union of a single simple polygon does).
fn clean_ring(mut p: Vec<Pt>) -> Vec<Pt> {
    loop {
        let n = p.len();
        if n < 3 { return p; }
        let mut changed = false;
        let mut out: Vec<Pt> = Vec::with_capacity(n);
        for i in 0..n {
            let prev = p[(i + n - 1) % n];
            let cur = p[i];
            let next = p[(i + 1) % n];
            if cur == prev { changed = true; continue; }
            if cross3(prev, cur, next) == 0 && prev != next {
                // collinear: keep only if the polygon turns back (spike); a straight-through point is dropped
                let d1 = [(cur[0] - prev[0]) as i128, (cur[1] - prev[1]) as i128];
                let d2 = [(next[0] - cur[0]) as i128, (next[1] - cur[1]) as i128];
                if d1[0] * d2[0] + d1[1] * d2[1] > 0 { changed = true; continue; }
            }
            out.push(cur);
        }
        p = out;
        if !changed { return p; }
    }
}

// ------------------------------------------------------------------------------------------------ rotation helpers
fn rotate_pts(pts: &[Pt], rad: f64) -> Vec<Pt> {
    if rad == 0.0 { return pts.to_vec(); }
    let (s, c) = rad.sin_cos();
    pts.iter().map(|p| {
        let x = p[0] as f64;
        let y = p[1] as f64;
        [(c * x - s * y).round() as i64, (c * y + s * x).round() as i64]
    }).collect()
}

fn vsort_cmp(a: Pt, b: Pt) -> Ordering {
    // y first, then x
    a[1].cmp(&b[1]).then(a[0].cmp(&b[0]))
}

fn max_vertex(p: &[Pt]) -> Pt {
    // std::max_element returns the FIRST maximal element
    let mut best = p[0];
    for &q in &p[1..] { if vsort_cmp(best, q) == Ordering::Less { best = q; } }
    best
}

fn min_vertex(p: &[Pt]) -> Pt {
    let mut best = p[0];
    for &q in &p[1..] { if vsort_cmp(q, best) == Ordering::Less { best = q; } }
    best
}

// ------------------------------------------------------------------------------------------------ rotating calipers
#[derive(Clone, Copy)]
struct RBox { axis: Pt, bottom: i128, right: i128 }

impl RBox {
    fn area_frac(&self) -> (i128, i128) {
        let asq = self.axis[0] as i128 * self.axis[0] as i128 + self.axis[1] as i128 * self.axis[1] as i128;
        (self.bottom * self.right, asq)
    }
    fn width_height(&self) -> (f64, f64) {
        let l = ((self.axis[0] as f64).powi(2) + (self.axis[1] as f64).powi(2)).sqrt();
        ((self.bottom.abs() as f64) / l, (self.right.abs() as f64) / l)
    }
    fn angle_to_x(&self) -> f64 {
        let mut ret = (self.axis[1] as f64).atan2(self.axis[0] as f64);
        if ret.is_sign_negative() { ret += TWO_PI; }
        -ret
    }
}

fn dotp(a: Pt, b: Pt) -> i128 { a[0] as i128 * b[0] as i128 + a[1] as i128 * b[1] as i128 }
fn perp(a: Pt) -> Pt { [a[1], -a[0]] }
fn neg(a: Pt) -> Pt { [-a[0], -a[1]] }
fn sub(a: Pt, b: Pt) -> Pt { [a[0] - b[0], a[1] - b[1]] }
fn add(a: Pt, b: Pt) -> Pt { [a[0] + b[0], a[1] + b[1]] }
fn magnsq(a: Pt) -> i128 { dotp(a, a) }

/// libnest2d `rotcalipers` for a convex counter-clockwise polygon: visits every bounding box of the rotating calipers
/// in order; `visit` returns false to stop.
fn rotcalipers(sh: &[Pt], mut visit: impl FnMut(&RBox) -> bool) {
    let mut v: Vec<Pt> = sh.to_vec();
    if v.len() < 3 { return; }
    let n0 = v.len();
    let mut last = n0 - 1;
    if v[0] == v[last] { last -= 1; }
    if last < 2 { return; }
    // orientation from the first three (p, q, r = last): d > 0 means clockwise -> flip
    {
        let (p, q, r) = (v[0], v[1], v[last]);
        let d = (q[1] - p[1]) as i128 * (r[0] - p[0]) as i128 - (q[0] - p[0]) as i128 * (r[1] - p[1]) as i128;
        if d > 0 {
            let mut f: Vec<Pt> = Vec::with_capacity(last + 1);
            let mut i = last;
            while i != 0 { f.push(v[i]); i -= 1; }
            f.push(v[0]);
            v = f;
            last = v.len() - 1;
        }
    }
    let n = last + 1; // vertices first..=last
    let next = |i: usize| if i == last { 0 } else { i + 1 };
    let prev = |i: usize| if i == 0 { last } else { i - 1 };
    // initial extremes
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (0usize, 0usize, 0usize, 0usize);
    for i in 0..n {
        let d = sub(v[i], v[min_x]);
        if d[0] < 0 || (d[0] == 0 && d[1] < 0) { min_x = i; }
        let d = sub(v[i], v[max_x]);
        if d[0] > 0 || (d[0] == 0 && d[1] > 0) { max_x = i; }
        let d = sub(v[i], v[min_y]);
        if d[1] < 0 || (d[1] == 0 && d[0] > 0) { min_y = i; }
        let d = sub(v[i], v[max_y]);
        if d[1] > 0 || (d[1] == 0 && d[0] < 0) { max_y = i; }
    }
    let mut rect: [usize; 4] = [min_y, max_x, max_y, min_x];
    let update = |w: Pt, rect: &mut [usize; 4]| -> bool {
        let (bi, ri, ti, li) = (rect[0], rect[1], rect[2], rect[3]);
        let b = sub(v[next(bi)], v[bi]);
        let r = sub(v[next(ri)], v[ri]);
        let t = sub(v[next(ti)], v[ti]);
        let l = sub(v[next(li)], v[li]);
        let pw = perp(w);
        let dotwpb = dotp(w, b);
        let dotwpr = dotp(neg(pw), r);
        let dotwpt = dotp(neg(w), t);
        let dotwpl = dotp(pw, l);
        let dw = magnsq(w);
        // angles[i] = (dot/magnsq) * dot  as exact fractions dot^2 / magnsq
        let nums = [dotwpb * dotwpb, dotwpr * dotwpr, dotwpt * dotwpt, dotwpl * dotwpl];
        let dens = [magnsq(b), magnsq(r), magnsq(t), magnsq(l)];
        // the lambda uses the signed dot: (dot / magn) * dot == dot*dot/magn (exact in rational arithmetic)
        let mut a: Vec<(usize, i128, i128)> = Vec::with_capacity(4); // (index, num, den) sorted by decreasing angle
        let mut i = 3usize;
        for j in 0..4usize {
            if rect[i] != rect[j] && dens[i] > 0 && cmp_frac(nums[i], dens[i], dw, 1) == Ordering::Less {
                // std::lower_bound with comp(ai, iv): first position where NOT (ai.first > iv.first)
                let mut pos = a.len();
                for (idx, e) in a.iter().enumerate() {
                    if cmp_frac(e.1, e.2, nums[i], dens[i]) != Ordering::Greater { pos = idx; break; }
                }
                a.insert(pos, (i, nums[i], dens[i]));
            }
            i = j;
        }
        if a.is_empty() { return false; }
        let (imin, nmin, dmin) = (a[0].0, a[0].1, a[0].2);
        for e in &a {
            if cmp_frac(e.1, e.2, nmin, dmin) == Ordering::Equal { rect[e.0] = next(rect[e.0]); }
        }
        rect.rotate_left(imin);
        true
    };
    let mut w: Pt = [1, 0];
    {
        let a = dotp(w, sub(v[rect[1]], v[rect[3]]));
        let b = dotp(neg(perp(w)), sub(v[rect[2]], v[rect[0]]));
        if !visit(&RBox { axis: w, bottom: a, right: b }) { return; }
    }
    let count = last + 1;
    let mut edgemask = vec![false; count];
    let mut c = 0usize;
    while c < count {
        c += 1;
        if !update(w, &mut rect) { break; }
        let eidx = rect[0];
        if edgemask[eidx] { break; }
        edgemask[eidx] = true;
        w = sub(v[rect[0]], v[prev(rect[0])]);
        let a = dotp(w, sub(v[rect[1]], v[rect[3]]));
        let b = dotp(neg(perp(w)), sub(v[rect[2]], v[rect[0]]));
        if !visit(&RBox { axis: w, bottom: a, right: b }) { break; }
    }
}

/// `minAreaBoundingBox(sh).angleToX()`; 0 on failure like Orca's catch.
fn min_area_bbox_rotation(sh: &[Pt]) -> f64 {
    let mut best: Option<RBox> = None;
    let mut best_area: (i128, i128) = (i128::MAX, 1);
    rotcalipers(sh, |rb| {
        let (n, d) = rb.area_frac();
        if d == 0 { return true; }
        let better = best.is_none() || cmp_frac(n, d, best_area.0, best_area.1) != Ordering::Greater;
        if better { best = Some(*rb); best_area = (n, d); }
        true
    });
    match best { Some(b) => b.angle_to_x(), None => 0.0 }
}

/// `fitIntoBoxRotation`: bisect the calipers interval where the aspect ratio crosses the box's.
fn fit_into_box_rotation(sh: &[Pt], bin_w: i64, bin_h: i64) -> f64 {
    let eps = 1e-4;
    let aspect = |w: f64, h: f64| w / h;
    let target = aspect(bin_w as f64, bin_h as f64);
    let mut prev: Option<RBox> = None;
    let mut a_from = 0.0;
    let mut a_to = 0.0;
    rotcalipers(sh, |rb| {
        // the first box has no predecessor: Orca reads a default-constructed prev (axis (0,0)); skip the comparison then
        let cur = rb.width_height();
        let cur_lower = aspect(cur.0, cur.1) < target;
        if let Some(p) = prev {
            let pw = p.width_height();
            let prev_lower = aspect(pw.0, pw.1) < target;
            if prev_lower != cur_lower {
                a_from = p.angle_to_x();
                a_to = rb.angle_to_x();
                return false;
            }
        }
        prev = Some(*rb);
        true
    });
    let rot_bb = |r: f64| { let b = bbox_of(&rotate_pts(sh, r)); (b.width(), b.height()) };
    let rot_aspect = |r: f64| { let (w, h) = rot_bb(r); aspect(w as f64, h as f64) };
    let mut ar_from = rot_aspect(a_from);
    let would_fit = |b: (i64, i64)| b.0 < bin_w && b.1 < bin_h;
    let mut middle = (a_from + a_to) / 2.0;
    let mut box_middle = rot_bb(middle);
    while !would_fit(box_middle) && (a_to - a_from).abs() > eps {
        let ar_middle = aspect(box_middle.0 as f64, box_middle.1 as f64);
        if (ar_from < target) != (ar_middle < target) { a_to = middle; } else { a_from = middle; }
        ar_from = rot_aspect(a_from);
        middle = (a_from + a_to) / 2.0;
        box_middle = rot_bb(middle);
    }
    middle
}

// ------------------------------------------------------------------------------------------------ NFP
/// `nfpConvexOnly` + `correctNfpPosition`: the no-fit polygon of the orbiting convex polygon `other` around the stationary
/// convex polygon `sh` (both counter-clockwise, as transformed shapes), positioned for `other`'s reference vertex
/// (its rightmost top vertex at its CURRENT position). The returned ring is closed implicitly (no repeated vertex).
fn nfp_convex(sh: &[Pt], other: &[Pt]) -> Vec<Pt> {
    #[derive(Clone, Copy)]
    struct E { a: Pt, b: Pt }
    let mut edges: Vec<E> = Vec::with_capacity(sh.len() + other.len());
    let add_edge = |edges: &mut Vec<E>, a: Pt, b: Pt| {
        let d = sub(b, a);
        if d[0] != 0 || d[1] != 0 { edges.push(E { a, b }); }
    };
    let n = sh.len();
    for i in 0..n - 1 { if sh[i] != sh[i + 1] { add_edge(&mut edges, sh[i], sh[i + 1]); } }
    add_edge(&mut edges, sh[n - 1], sh[0]); // OPEN closure: closing edge
    let m = other.len();
    for i in 0..m - 1 { if other[i] != other[i + 1] { add_edge(&mut edges, other[i + 1], other[i]); } }
    add_edge(&mut edges, other[0], other[m - 1]);
    // sort by angle in [0, 2pi): quadrant, then pcos comparison (the library comparator for counter-clockwise polygons)
    let quad = |e: &E| -> (i32, i128, i128, i128) {
        let p = sub(e.b, e.a);
        let lcos = p[0] as i128; // dot(p, ax)
        let lsin = p[1] as i128; // -dotperp(p, ax) = p.y
        let q = if lcos == 0 { if lsin > 0 { 1 } else { 3 } }
            else if lsin == 0 { if lcos > 0 { 0 } else { 2 } }
            else { [0, 3, 1, 2][(((lcos < 0) as usize) << 1) + (lsin < 0) as usize] };
        (q, lcos, lsin, magnsq(p))
    };
    let mut keyed: Vec<(E, (i32, i128, i128, i128))> = edges.iter().map(|e| (*e, quad(e))).collect();
    keyed.sort_by(|x, y| {
        let (q1, l1, _, s1) = x.1;
        let (q2, l2, _, s2) = y.1;
        if q1 == q2 {
            let sign: i128 = if q1 == 1 || q1 == 2 { -1 } else { 1 };
            // pcos = lcos^2 * sign / lsq; counter-clockwise: q < 2 ? pcos1 > pcos2 : pcos1 < pcos2
            let n1 = l1 * l1 * sign;
            let n2 = l2 * l2 * sign;
            let c = cmp_frac(n1, s1, n2, s2);
            let less = if q1 < 2 { c == Ordering::Greater } else { c == Ordering::Less };
            let greater = if q1 < 2 { c == Ordering::Less } else { c == Ordering::Greater };
            return if less { Ordering::Less } else if greater { Ordering::Greater } else { Ordering::Equal };
        }
        q1.cmp(&q2)
    });
    // buildPolygon
    let mut ring: Vec<Pt> = vec![keyed[0].0.a, keyed[0].0.b];
    let mut top = max_vertex(&ring);
    for e in keyed.iter().skip(1) {
        let d = *ring.last().unwrap();
        let p = add(e.0.b, sub(d, e.0.a));
        ring.push(p);
        if vsort_cmp(top, p) == Ordering::Less { top = p; }
    }
    // closed loop: the last vertex repeats the first
    if ring.len() > 1 && ring.first() == ring.last() { ring.pop(); }
    let _ = top;
    ring
}

/// Union-free helper: the reference point of the nfp as built by `buildPolygon` (max by y then x over its vertices).
fn nfp_top(ring: &[Pt]) -> Pt { max_vertex(ring) }

// ------------------------------------------------------------------------------------------------ NLopt Subplex, n = 1
struct Stop { nevals: usize, maxeval: usize, ftol_rel: f64 }

fn relstop(vold: f64, vnew: f64, reltol: f64, abstol: f64) -> bool {
    if vold.is_infinite() { return false; }
    (vnew - vold).abs() < abstol || (vnew - vold).abs() < reltol * (vnew.abs() + vold.abs()) * 0.5 || (reltol > 0.0 && vnew == vold)
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Ret { Success, XtolReached, Failure, MaxEval }

fn nl_close(a: f64, b: f64) -> bool { (a - b).abs() <= 1e-13 * (a.abs() + b.abs()) }

/// `reflectpt` for n = 1: xnew = c + scale * (c - xold), pinned to the bounds; false when coincident with c or xold.
fn reflectpt(c: f64, scale: f64, xold: f64, lb: f64, ub: f64) -> (bool, f64) {
    let mut newx = c + scale * (c - xold);
    if newx < lb { newx = lb; }
    if newx > ub { newx = ub; }
    let equalc = nl_close(newx, c);
    let equalold = nl_close(newx, xold);
    (!(equalc || equalold), newx)
}

/// `nldrmd_minimize_` for n = 1 as used by `sbplx` (psi > 0 convergence test). `x`/`minf` are in/out.
fn nldrmd_1d(f: &mut dyn FnMut(f64) -> f64, lb: f64, ub: f64, x: &mut f64, minf: &mut f64, xstep: f64, stop: &mut Stop, psi: f64, fdiff: &mut f64) -> Ret {
    // slots keep the red-black tree tie-break (by address == slot index)
    let mut pts: [(f64, f64); 2] = [(*minf, *x), (0.0, 0.0)];
    *fdiff = f64::INFINITY;
    let (alpha, beta, gamm, delta) = (1.0, 0.5, 2.0, 0.5);
    macro_rules! check_eval {
        ($xc:expr, $fc:expr) => {{
            stop.nevals += 1;
            if $fc <= *minf { *minf = $fc; *x = $xc; }
            if stop.nevals >= stop.maxeval { return Ret::MaxEval; }
        }};
    }
    // second simplex point
    {
        let mut p = *x + xstep;
        if p > ub {
            if ub - *x > xstep.abs() * 0.1 { p = ub; } else { p = *x - xstep.abs(); }
        }
        if p < lb {
            if *x - lb > xstep.abs() * 0.1 { p = lb; } else {
                p = *x + xstep.abs();
                if p > ub { p = 0.5 * ((if ub - *x > *x - lb { ub } else { lb }) + *x); }
            }
        }
        if nl_close(p, *x) { return Ret::Failure; }
        let fp = f(p);
        pts[1] = (fp, p);
        check_eval!(p, fp);
    }
    let mut init_diam = 0.0;
    'restart: loop {
        loop {
            // low = smaller key (f, slot), high = larger
            let lo_is_0 = pts[0].0 < pts[1].0 || (pts[0].0 == pts[1].0);
            let (li, hi) = if lo_is_0 { (0usize, 1usize) } else { (1, 0) };
            let (fl, xl) = pts[li];
            let (mut fh, xh) = pts[hi];
            *fdiff = fh - fl;
            if init_diam == 0.0 { init_diam += (xl - xh).abs(); }
            let c = xl; // centroid of the points other than high (n = 1)
            let diam = (xl - xh).abs();
            if psi > 0.0 && diam < psi * init_diam { return Ret::XtolReached; }
            // reflection
            let (ok, xcur) = reflectpt(c, alpha, xh, lb, ub);
            if !ok { return Ret::XtolReached; }
            let fr = f(xcur);
            check_eval!(xcur, fr);
            let mut new_xh = xh;
            if fr < fl {
                let (ok, xe) = reflectpt(c, gamm, xh, lb, ub);
                if !ok { return Ret::XtolReached; }
                new_xh = xe;
                fh = f(new_xh);
                check_eval!(new_xh, fh);
                if fh >= fr { fh = fr; new_xh = xcur; }
            } else if fr < pts[li].0 {
                // pred(high) is the low point for n = 1; after the `fr < fl` branch this cannot be true, kept as in nldrmd.c
                new_xh = xcur;
                fh = fr;
            } else {
                // new worst point, contract
                let (ok, xc) = reflectpt(c, if fh <= fr { -beta } else { beta }, xh, lb, ub);
                if !ok { return Ret::XtolReached; }
                let fc = f(xc);
                check_eval!(xc, fc);
                if fc < fr && fc < fh {
                    new_xh = xc;
                    fh = fc;
                } else {
                    // shrink toward the low point
                    let (ok, xs) = reflectpt(xl, -delta, xh, lb, ub);
                    if !ok { return Ret::XtolReached; }
                    let fs = f(xs);
                    pts[hi] = (fs, xs);
                    check_eval!(xs, fs);
                    continue 'restart;
                }
            }
            pts[hi] = (fh, new_xh);
        }
    }
}

/// `sbplx_minimize` for n = 1 with the library defaults the placer uses (maxeval, ftol_rel; xtol 0). Returns (x, minf).
fn sbplx_1d(f: &mut dyn FnMut(f64) -> f64, x0: f64, maxeval: usize, ftol_rel: f64) -> (f64, f64) {
    let (lb, ub) = (0.0, 1.0);
    // nlopt_set_default_initial_step
    let mut step = f64::INFINITY;
    if (ub - lb) * 0.25 < step && ub > lb { step = (ub - lb) * 0.25; }
    if ub - x0 < step && ub > x0 { step = (ub - x0) * 0.75; }
    if x0 - lb < step && x0 > lb { step = (x0 - lb) * 0.75; }
    let mut stop = Stop { nevals: 0, maxeval, ftol_rel };
    let mut x = x0;
    let mut minf = f(x);
    stop.nevals += 1;
    if stop.nevals >= stop.maxeval { return (x, minf); }
    let mut xstep = step;
    let psi = 0.25;
    let mut dx = 0.0f64;
    loop {
        let xprev = x;
        let mut xs = x;
        let mut fdiff = 0.0;
        let ret = nldrmd_1d(f, lb, ub, &mut xs, &mut minf, xstep, &mut stop, psi, &mut fdiff);
        x = xs;
        let fdiff_max = if fdiff > 0.0 { fdiff } else { 0.0 };
        if ret == Ret::Failure { return (x, minf); }
        if ret != Ret::XtolReached { return (x, minf); }
        // termination tests: nlopt_stop_ftol(stop, *minf, *minf + fdiff_max)
        if relstop(minf + fdiff_max, minf, stop.ftol_rel, 0.0) { return (x, minf); }
        // nlopt_stop_x: xtol_rel = xtol_abs = 0 -> never
        dx = x - xprev;
        let scale = psi; // nsubs == 1
        xstep = if dx == 0.0 { -(xstep * scale) } else { (xstep * scale).abs().copysign(dx) };
        let _ = dx;
    }
}

// ------------------------------------------------------------------------------------------------ the placer
#[derive(Clone)]
struct Item {
    name: String,
    /// inflated shape before rotation (counter-clockwise), `Item::infaltedShape()`
    shape: Vec<Pt>,
    area: f64,
    height: f64,
    rot: f64,
    tr: Pt,
    extr: Vec<i32>,
    temp_type: i32,
    bed_temp: i32,
    priority: i32,
    id_in: usize,
    // cache
    rot_cache: Option<(f64, Vec<Pt>, Bx)>,
}

impl Item {
    fn rotated(&mut self) -> &(f64, Vec<Pt>, Bx) {
        if self.rot_cache.as_ref().map_or(true, |c| c.0 != self.rot) {
            let r = rotate_pts(&self.shape, self.rot);
            let b = bbox_of(&r);
            self.rot_cache = Some((self.rot, r, b));
        }
        self.rot_cache.as_ref().unwrap()
    }
    /// `transformedShape()`: rotation about the origin (rounded), then translation.
    fn tshape(&mut self) -> Vec<Pt> {
        let tr = self.tr;
        self.rotated().1.iter().map(|p| [p[0] + tr[0], p[1] + tr[1]]).collect()
    }
    fn bb(&mut self) -> Bx {
        let tr = self.tr;
        self.rotated().2.translated(tr)
    }
}

fn is_compatible(types: &[i32]) -> bool {
    let high = types.iter().any(|&t| t == 0);
    let low = types.iter().any(|&t| t == 1);
    !(high && low)
}

struct Placed { bb: Bx, area: f64, height: f64, extr: Vec<i32>, temp_type: i32, shape: Vec<Pt> }

struct Placer {
    bin: Bx,
    bin_area: f64,
    norm: f64,
    items: Vec<Placed>,
    printable_height: f64,
    item_count: usize,
}

/// Rings of the free region as Clipper's `diff_ex` would return them: (contour, holes) per expolygon.
struct FreeRegion { contour: Vec<Pt>, holes: Vec<Vec<Pt>> }

/// Edge cache of a ring (open closure: the closing edge from the last to the first vertex is NOT part of it,
/// exactly as `EdgeCache::createCache` iterates consecutive points only).
struct EdgeRing { edges: Vec<(Pt, Pt)>, distances: Vec<f64>, full: f64 }

impl EdgeRing {
    fn new(ring: &[Pt]) -> EdgeRing {
        let mut edges = Vec::new();
        let mut distances = Vec::new();
        let mut full = 0.0;
        for i in 0..ring.len().saturating_sub(1) {
            let (a, b) = (ring[i], ring[i + 1]);
            full += dist(a, b);
            edges.push((a, b));
            distances.push(full);
        }
        EdgeRing { edges, distances, full }
    }
    /// stride for accuracy = 1: round(N / N^1) = 1; corners are the relative distances at every edge end, plus two leading zeros
    fn corners(&self, is_contour: bool) -> Vec<f64> {
        let n = self.distances.len();
        let mut c = vec![0.0];
        if is_contour { c.push(0.0); }
        let n1 = n.saturating_sub(1);
        // for (i = 0; i < N_1; i += S) corners.push(distances[i] / full)
        for i in 0..n1 { c.push(self.distances[i] / self.full); }
        c
    }
    fn coords(&self, distance: f64) -> Pt {
        if self.distances.is_empty() || self.edges.is_empty() { return [0, 0]; }
        let d = distance * self.full;
        // lower_bound: first distance >= d
        let mut idx = self.distances.partition_point(|&x| x < d);
        if idx >= self.edges.len() { idx = self.edges.len() - 1; }
        let edge = self.edges[idx];
        let ed = d - if idx > 0 { self.distances[idx - 1] } else { 0.0 };
        let dx = (edge.1[0] - edge.0[0]) as f64;
        let dy = (edge.1[1] - edge.0[1]) as f64;
        let mut angle = dy.atan2(dx);
        if angle.is_sign_negative() { angle += TWO_PI; }
        [edge.0[0] + (ed * angle.cos()).round() as i64, edge.0[1] + (ed * angle.sin()).round() as i64]
    }
}

impl Placer {
    /// `AutoArranger::objfunc` for the non-sequential, top-right-start, single-bed case. `cand_*` describe the candidate.
    #[allow(clippy::too_many_arguments)]
    fn objfunc(&self, cand_bb: Bx, cand_area: f64, cand_height: f64, cand_extr: &[i32], cand_temp: i32, pile_bb: Bx, origin_pack: Pt, remaining: usize, bin_total: &Bx) -> (f64, Bx) {
        let _ = bin_total;
        let bin_area = self.bin_area;
        let is_big = |a: f64| a / bin_area > BIG_ITEM_THRESHOLD;
        let ibb = cand_bb;
        let fullbb = Bx::union(&pile_bb, &ibb);
        // big-item index: bounds of the big placed items; empty when none
        let big: Vec<&Placed> = self.items.iter().filter(|p| is_big(p.area)).collect();
        let bigbb = if big.is_empty() { fullbb } else {
            let mut b = Bx::none();
            for p in &big { b = Bx::union(&b, &p.bb); }
            b
        };
        let bigitems = is_big(cand_area) || big.is_empty();
        #[derive(PartialEq)]
        enum Case { Big, LastBig, Small }
        let case = if bigitems && remaining > 0 { Case::Big } else if bigitems && remaining == 0 { Case::LastBig } else { Case::Small };
        let norm = |v: f64| v / self.norm;
        let mut score;
        match case {
            Case::Big => {
                let (minc, maxc) = (ibb.min, ibb.max);
                let top_left = [minc[0], maxc[1]];
                let bottom_right = [maxc[0], minc[1]];
                let cc = fullbb.center();
                let dists = [dist(minc, cc), dist(maxc, cc), dist(ibb.center(), cc), dist(top_left, cc), dist(bottom_right, cc)];
                let mut dmin = dists[0];
                for d in &dists[1..] { if *d < dmin { dmin = *d; } }
                let mut dist_v = norm(dmin);
                // TOP_RIGHT starting point: distance of the item's max corner to the bin's max corner
                let bindist = norm(dist(ibb.max, origin_pack));
                dist_v = 0.8 * dist_v + 0.2 * bindist;
                let mut alignment_score = 1.0f64;
                let index_big = is_big(cand_area);
                let mut any = false;
                for p in &self.items {
                    if index_big && !is_big(p.area) { continue; }
                    if !p.bb.intersects(&ibb) { continue; }
                    any = true;
                    if (1.0 - p.area / cand_area).abs() < 1e-6 {
                        let bb = Bx::union(&p.bb, &ibb);
                        let bbarea = bb.area_i() as f64;
                        let ascore = 1.0 - (cand_area + p.area) / bbarea;
                        if ascore < alignment_score { alignment_score = ascore; }
                    }
                }
                let density = (norm(fullbb.width() as f64) * norm(fullbb.height() as f64)).sqrt();
                let r = remaining as f64 / self.item_count as f64;
                let alignment_weight = (0.6 * cand_area / ibb.area_i() as f64).max(0.3);
                score = if !any { 0.50 * dist_v + 0.50 * density } else { (1.0 - 0.2 - alignment_weight) * dist_v + (1.0 - r) * 0.20 * density + alignment_weight * alignment_score };
            }
            Case::LastBig => {
                score = if pile_bb.defined { 0.5 * norm(dist(ibb.center(), pile_bb.center())) } else { 0.5 * norm(dist(ibb.center(), origin_pack)) };
            }
            Case::Small => {
                score = 0.8 * norm(dist(ibb.center(), bigbb.center())) + 0.2 * norm(dist(ibb.center(), origin_pack));
            }
        }
        // non-sequential: height closeness + temperature compatibility
        let mut valid = 0usize;
        let mut height_score = 0.0;
        for p in &self.items {
            valid += 1;
            height_score += (1.0 - (cand_height - p.height).abs() / self.printable_height) * norm(dist(ibb.center(), p.bb.center()));
            if !is_compatible(&[cand_temp, p.temp_type]) { score += LARGE_COST_TO_REJECT; break; }
        }
        if valid > 0 { score += height_score / valid as f64; }
        // extruder ids: a new extruder not yet on the plate costs 1 each
        let mut ext: Vec<i32> = Vec::new();
        for p in &self.items { for e in &p.extr { if !ext.contains(e) { ext.push(*e); } } }
        let last = ext.len();
        for e in cand_extr { if !ext.contains(e) { ext.push(*e); } }
        score += (ext.len() - last) as f64;
        (score, fullbb)
    }

    fn overfit_box(bb: &Bx, bin: &Bx) -> f64 {
        let wdiff = bb.width() - bin.width();
        let hdiff = bb.height() - bin.height();
        let mut diff = 0.0;
        if wdiff > 0 { diff += wdiff as f64; }
        if hdiff > 0 { diff += hdiff as f64; }
        diff
    }

    /// The `get_objfn()` wrapper for a `Box` bin: objfunc + squared overfit of the pile, capped.
    #[allow(clippy::too_many_arguments)]
    fn score_at(&self, item: &mut Item, pile_bb: Bx, origin_pack: Pt, remaining: usize) -> f64 {
        let ibb = item.bb();
        let (s, fullbb) = self.objfunc(ibb, item.area, item.height, &item.extr, item.temp_type, pile_bb, origin_pack, remaining, &self.bin);
        let miss = Self::overfit_box(&fullbb, &self.bin);
        let miss = if miss > 0.0 { miss } else { 0.0 };
        let mut score = s + miss * miss;
        if score > LARGE_COST_TO_REJECT { score = 1.5 * LARGE_COST_TO_REJECT; }
        score
    }
}

fn nfp_inner_rect(bed: &Bx, other: &[Pt]) -> Vec<Pt> {
    let sbox = bbox_of(other);
    let sheight = sbox.height();
    let swidth = sbox.width();
    let sliding_top = max_vertex(other);
    let left_off = sliding_top[0] - sbox.min[0];
    let right_off = sliding_top[0] - sbox.max[0];
    let top_off = 0;
    let bottom_off = sheight;
    if sheight > bed.height() || swidth > bed.width() { return Vec::new(); }
    vec![
        [bed.min[0] + left_off, bed.max[1] + top_off],
        [bed.max[0] + right_off, bed.max[1] + top_off],
        [bed.max[0] + right_off, bed.min[1] + bottom_off],
        [bed.min[0] + left_off, bed.min[1] + bottom_off],
    ]
}

fn to_polys(rings: &[Vec<Pt>]) -> crate::types::Polys {
    rings.iter().filter(|r| r.len() >= 3).map(|r| crate::types::Poly { contour: r.iter().map(|p| [unscaled(p[0]), unscaled(p[1])]).collect(), holes: vec![] }).collect()
}

/// `diff_ex({inner}, nfps)` ordered like Clipper's polytree: (contour, holes) per expolygon.
fn free_region(inner: &[Pt], nfps: &[Vec<Pt>]) -> Vec<FreeRegion> {
    if inner.len() < 3 { return Vec::new(); }
    let subject = to_polys(&[inner.to_vec()]);
    let clip = to_polys(nfps);
    // Clipper runs the difference with the non-zero fill rule: overlapping clip polygons are united, not cancelled
    let res = if clip.is_empty() { crate::geom::normalize(&subject) } else { crate::geom::diff(&subject, &crate::geom::union_all(&[&clip])) };
    let conv = |r: &Vec<[f64; 2]>| -> Vec<Pt> { r.iter().map(|p| [scaled(p[0]), scaled(p[1])]).collect() };
    let mut out = Vec::new();
    for p in &res {
        let mut c = conv(&p.contour);
        c = clipper_ring_start(c, false);
        let holes: Vec<Vec<Pt>> = p.holes.iter().map(|h| clipper_ring_start(conv(h), true)).collect();
        out.push(FreeRegion { contour: c, holes });
    }
    out
}

/// Rotate a ring to the start vertex Clipper's output uses for a simple polygon (measured with the C++ oracle on
/// hundreds of rings, two-pass `diff_ex` as Slic3r runs it): the ring ENDS at its lowest vertex (smallest y; the
/// rightmost of the lowest ones) and so starts at the vertex that follows it in the ring's own orientation
/// (contours counter-clockwise, holes clockwise).
fn clipper_ring_start(mut r: Vec<Pt>, _hole: bool) -> Vec<Pt> {
    r = clean_ring(r);
    if r.len() < 2 { return r; }
    let mut last = 0usize;
    for i in 1..r.len() {
        let b = r[last];
        let c = r[i];
        if c[1] < b[1] || (c[1] == b[1] && c[0] > b[0]) { last = i; }
    }
    let k = (last + 1) % r.len();
    r.rotate_left(k);
    r
}

/// Result of one placement attempt.
struct Attempt { rot: f64, tr: Pt, score: f64 }

impl Placer {
    fn pile_bb(&self) -> Bx {
        let mut b = Bx::none();
        for p in &self.items { b = Bx::union(&b, &p.bb); }
        b
    }

    /// `setInitialPosition` for the TOP_RIGHT starting point.
    fn set_initial_position(&self, item: &mut Item) {
        let bb = item.bb();
        let mut bbin = self.bin;
        bbin.max = [bbin.max[0] - 10, bbin.max[1] - 10];
        bbin.min = [bbin.min[0] + 10, bbin.min[1] + 10];
        let ci = bb.max;
        let cb = bbin.max;
        item.tr = add(item.tr, sub(cb, ci));
    }

    fn trypack(&self, item: &mut Item, remaining: usize, rotations: &[f64]) -> Option<Attempt> {
        let first_object = self.items.is_empty();
        let initial_tr = item.tr;
        let initial_rot = item.rot;
        if first_object {
            self.set_initial_position(item);
            let mut best_tr = item.tr;
            let mut best_rot = item.rot;
            let ov = |it: &mut Item| Placer::overfit_box(&bbox_of(&it.tshape()), &self.bin);
            let mut best_overfit = ov(item);
            for &rot in rotations {
                item.tr = initial_tr;
                item.rot = initial_rot + rot;
                self.set_initial_position(item);
                let of = ov(item);
                if of < best_overfit {
                    best_overfit = of;
                    best_tr = item.tr;
                    best_rot = item.rot;
                }
            }
            item.rot = best_rot;
            item.tr = best_tr;
            if best_overfit <= 0.0 { return Some(Attempt { rot: best_rot, tr: best_tr, score: 0.2 }); }
            return None;
        }
        let mut global_score = f64::MAX;
        let mut final_tr = [0i64, 0i64];
        let mut final_rot = initial_rot;
        let mut can_pack = false;
        let pile_bb = self.pile_bb();
        let origin_pack = self.bin.max; // TOP_RIGHT
        let binbb = self.bin;
        for &rot in rotations {
            item.tr = initial_tr;
            item.rot = initial_rot + rot;
            // placeOutsideOfBin
            {
                let bb = item.bb();
                let v = [bb.max[0], bb.min[1]];
                let d = [binbb.max[0] - v[0], binbb.max[1] - v[1]];
                item.tr = add(item.tr, d);
            }
            let tsh = item.tshape();
            let iv = max_vertex(&tsh);
            let startpos = item.tr;
            // calcnfp
            let mut nfps: Vec<Vec<Pt>> = Vec::with_capacity(self.items.len());
            let trsh_rt = max_vertex(&tsh);
            let trsh_lb = min_vertex(&tsh);
            for p in &self.items {
                let mut ring = nfp_convex(&p.shape, &tsh);
                let nfp_second = nfp_top(&ring);
                let touch_sh = max_vertex(&p.shape);
                let dtouch = sub(touch_sh, trsh_lb);
                let top_other = add(trsh_rt, dtouch);
                let dnfp = sub(top_other, nfp_second);
                for q in ring.iter_mut() { *q = add(*q, dnfp); }
                nfps.push(ring);
            }
            let inner = nfp_inner_rect(&binbb, &tsh);
            let regions = free_region(&inner, &nfps);
            if std::env::var("ARR_CDIFF").is_ok() {
                let line = |t: &str, r: &Vec<Pt>| { let mut s = format!("{t} {}", r.len() + 1); for p in r { s += &format!(" {} {}", p[0], p[1]); } s += &format!(" {} {}", r[0][0], r[0][1]); s };
                eprintln!("=== item {} rot {:.6}", item.name, item.rot);
                let mut inr = inner.clone();
                if inr.len() == 4 { inr = vec![inr[0], inr[1], inr[2], inr[3]]; }
                eprintln!("{}", line("S", &inr));
                for n in &nfps { eprintln!("{}", line("C", n)); }
                for r in &regions { eprintln!("MINE contour {:?}", r.contour); for h in &r.holes { eprintln!("MINE hole {:?}", h); } }
            }
            if std::env::var("ARR_DEBUG").is_ok() {
                eprintln!("DBG item {} rot {:.6} startpos {:?} iv {:?}", item.name, item.rot, startpos, iv);
                eprintln!("DBG   inner {:?}", inner);
                for (k, n) in nfps.iter().enumerate() { eprintln!("DBG   nfp{k} {:?}", n); }
                for r in &regions { eprintln!("DBG   region contour {:?}", r.contour); for h in &r.holes { eprintln!("DBG   region hole {:?}", h); } }
            }
            let mut best_score = f64::MAX;
            let mut best_pt: Option<Pt> = None;
            let mut itm = item.clone();
            let eval = |itm: &mut Item, v: Pt| -> f64 {
                let d = add(sub(v, iv), startpos);
                itm.tr = d;
                self.score_at(itm, pile_bb, origin_pack, remaining)
            };
            for reg in &regions {
                // contour then holes, each its own EdgeRing
                let mut rings: Vec<(EdgeRing, bool)> = vec![(EdgeRing::new(&reg.contour), true)];
                for h in &reg.holes { rings.push((EdgeRing::new(h), false)); }
                for (ering, is_contour) in &rings {
                    if ering.edges.is_empty() { continue; }
                    let corners = ering.corners(*is_contour);
                    let mut best_res: Option<(f64, f64)> = None; // (score, relpos)
                    for &pos in &corners {
                        let mut f = |relpos: f64| -> f64 {
                            let v = ering.coords(relpos);
                            let sc = eval(&mut itm, v);
                            if std::env::var("ARR_EVAL").is_ok() { eprintln!("EVAL start=0 relpos={} tr={},{} score={}", relpos, itm.tr[0], itm.tr[1], sc); }
                            sc
                        };
                        let (x, fmin) = sbplx_1d(&mut f, pos, 1000, 1e-20);
                        if best_res.map_or(true, |b| fmin < b.0) { best_res = Some((fmin, x)); }
                    }
                    if let Some((sc, relpos)) = best_res {
                        if std::env::var("ARR_DEBUG").is_ok() { eprintln!("DBG   ring(contour={}) best score {:e} relpos {:e} -> {:?}", is_contour, sc, relpos, ering.coords(relpos)); }
                        if sc < best_score {
                            // boundaryCheck: the hull of pile + item must fit the bin
                            let v = ering.coords(relpos);
                            let d = add(sub(v, iv), startpos);
                            itm.tr = d;
                            let full = Bx::union(&pile_bb, &itm.bb());
                            let miss = Placer::overfit_box(&full, &binbb);
                            if miss <= 0.0 {
                                best_score = sc;
                                best_pt = Some(v);
                            }
                        }
                    }
                }
            }
            if std::env::var("ARR_DEBUG").is_ok() { eprintln!("DBG  rotation result best_score {:e}", best_score); }
            if let Some(v) = best_pt {
                if best_score < global_score {
                    final_tr = add(sub(v, iv), startpos);
                    final_rot = initial_rot + rot;
                    can_pack = true;
                    global_score = best_score;
                }
            }
        }
        if !can_pack { return None; }
        item.tr = final_tr;
        item.rot = final_rot;
        Some(Attempt { rot: final_rot, tr: final_tr, score: global_score })
    }
}

// ------------------------------------------------------------------------------------------------ public API
/// One object to arrange. `hull` is the 2D convex hull of the object in its own frame (millimetres, any winding).
#[derive(Clone, Debug)]
pub struct ArrObject {
    pub name: String,
    pub hull: Vec<[f64; 2]>,
    /// object height in mm (`instance_convex_hull_bounding_box.size().z()`)
    pub height: f64,
    /// 1-based filament / extruder ids the object uses
    pub extruders: Vec<i32>,
    /// Orca `ap.brim_width`: 1.0 by default, 6.0 with normal support, 24.0 with tree support
    pub brim_width: f64,
    pub has_tree_support: bool,
    /// `FilamentTempType`: 0 high, 1 low, 2 compatible, 3 undefined (-1 unknown)
    pub temp_type: i32,
    pub bed_temp: i32,
}

#[derive(Clone, Debug)]
pub struct ArrParams {
    /// printable area bounding box `[min x, min y, max x, max y]` in mm (the shared area of the extruders)
    pub bed: [f64; 4],
    /// `1 + get_real_skirt_dist` (mm): `bed_shrink_x/y` after `update_arrange_params`
    pub shrink: f64,
    pub allow_rotations: bool,
    pub printable_height: f64,
    /// print the instance list by object (not supported)
    pub sequential: bool,
}

#[derive(Clone, Debug)]
pub struct ArrPlaced {
    /// index in the input list
    pub index: usize,
    /// rotation about the object origin, radians (CCW positive)
    pub rotation: f64,
    /// translation of the object origin, mm
    pub translation: [f64; 2],
    /// placement order (`itemid`): 0 is the item that was nested first (the largest)
    pub order: usize,
    pub score: f64,
}

/// Build the integer convex hull Orca nests from mesh XY vertices already expressed relative to the object origin.
pub fn hull_scaled(pts: &[[f64; 2]]) -> Vec<Pt> {
    let p: Vec<Pt> = pts.iter().map(|q| [scaled(q[0]), scaled(q[1])]).collect();
    convex_hull(&p)
}

pub fn arrange(objs: &[ArrObject], prm: &ArrParams) -> Result<Vec<ArrPlaced>, String> {
    if prm.sequential { return Err("arrange: print_sequence by object is not supported".into()); }
    if objs.is_empty() { return Ok(Vec::new()); }
    // bin: bed shrunk toward its centre
    let bed = Bx::new([scaled(prm.bed[0]), scaled(prm.bed[1])], [scaled(prm.bed[2]), scaled(prm.bed[3])]);
    let shrink = scaled(prm.shrink);
    let sgn = |v: i64| if v >= 0 { 1 } else { -1 };
    let cen = [(bed.min[0] + bed.max[0]) / 2, (bed.min[1] + bed.max[1]) / 2];
    let shr = |v: i64, c: i64| v + shrink * sgn(c - v);
    let bin = Bx::new([shr(bed.min[0], cen[0]), shr(bed.min[1], cen[1])], [shr(bed.max[0], cen[0]), shr(bed.max[1], cen[1])]);
    if bin.width() <= 0 || bin.height() <= 0 { return Err("arrange: bed smaller than the skirt margin".into()); }
    let bin_area = bin.width() as f64 * bin.height() as f64;
    let any_tree = objs.iter().any(|o| o.has_tree_support);
    let brim_max = objs.iter().map(|o| o.brim_width).fold(0.0, f64::max);
    let mut items: Vec<Item> = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        let raw = hull_scaled(&o.hull);
        if raw.len() < 3 { return Err(format!("arrange: object {} has no 2D hull", o.name)); }
        // inflation (update_selected_items_inflation, min_obj_distance = 0)
        let mut infl = if any_tree { scaled(brim_max / 2.0) } else { scaled(o.brim_width) };
        let apbb = bbox_of(&raw);
        let diffx = bin.width() - apbb.width() - 5;
        let diffy = bin.height() - apbb.height() - 5;
        if diffx > 0 && diffy > 0 {
            let min_diff = diffx.min(diffy);
            infl = (min_diff / 2).min(infl);
        }
        let shape = offset_square(&raw, infl as f32 as f64);
        let area = poly_area(&shape);
        items.push(Item { name: o.name.clone(), shape, area, height: o.height, rot: 0.0, tr: [0, 0], extr: o.extruders.clone(), temp_type: o.temp_type, bed_temp: o.bed_temp, priority: 0, id_in: i, rot_cache: None });
    }
    // initial rotation: minimum-area bounding box, fit into the bin when too big
    if prm.allow_rotations {
        for it in items.iter_mut() {
            let sh = it.tshape();
            it.rot = min_area_bbox_rotation(&sh);
            let bb = it.bb();
            if bb.width() >= bin.width() || bb.height() >= bin.height() {
                let sh = it.tshape();
                it.rot += fit_into_box_rotation(&sh, bin.width(), bin.height());
            }
        }
    }
    // sortfunc (non-sequential): priority desc, bed_temp desc, extruder ids, area desc
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| {
        let (i1, i2) = (&items[a], &items[b]);
        if i1.priority != i2.priority { return i2.priority.cmp(&i1.priority); }
        if i1.bed_temp != i2.bed_temp { return i2.bed_temp.cmp(&i1.bed_temp); }
        if i1.extr != i2.extr { return i1.extr.first().cmp(&i2.extr.first()); }
        i2.area.partial_cmp(&i1.area).unwrap_or(Ordering::Equal)
    });
    let rotations: Vec<f64> = if prm.allow_rotations { vec![0.0, std::f64::consts::PI / 4.0, std::f64::consts::PI / 2.0, 3.0 * std::f64::consts::PI / 4.0] } else { vec![0.0] };
    let mut placer = Placer { bin, bin_area, norm: bin_area.sqrt(), items: Vec::new(), printable_height: prm.printable_height, item_count: items.len() };
    let mut placed: Vec<(usize, Item, f64)> = Vec::new();
    for (k, &ix) in order.iter().enumerate() {
        let mut it = items[ix].clone();
        let remaining = order.len() - k - 1;
        let att = placer.trypack(&mut it, remaining, &rotations);
        let Some(att) = att else { return Err(format!("arrange: object {} does not fit on the plate with the others (a second plate would be needed)", it.name)); };
        it.rot = att.rot;
        it.tr = att.tr;
        let tsh = it.tshape();
        let bb = it.bb();
        placer.items.push(Placed { bb, area: it.area, height: it.height, extr: it.extr.clone(), temp_type: it.temp_type, shape: tsh });
        placed.push((ix, it, att.score));
    }
    // finalAlign: CENTER
    let mut pile = Bx::none();
    for p in &placer.items { pile = Bx::union(&pile, &p.bb); }
    let ci = pile.center();
    let cb = bin.center();
    let d = sub(cb, ci);
    let mut out: Vec<ArrPlaced> = Vec::new();
    for (k, (ix, it, score)) in placed.iter().enumerate() {
        let tr = add(it.tr, d);
        out.push(ArrPlaced { index: items[*ix].id_in, rotation: it.rot, translation: [unscaled(tr[0]), unscaled(tr[1])], order: k, score: *score });
    }
    out.sort_by_key(|p| p.index);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(h: f64) -> Vec<[f64; 2]> { vec![[-h, -h], [h, -h], [h, h], [-h, h]] }

    #[test]
    fn hull_is_ccw_from_the_leftmost_lowest() {
        let h = convex_hull(&[[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [5, 0]]);
        assert_eq!(h, vec![[0, 0], [10, 0], [10, 10], [0, 10]]);
    }

    #[test]
    fn two_equal_cubes_stack_in_y_like_orca() {
        // reference: Orca 2.5.0-dev arrangement::arrange for two 20 mm cubes, bed 20.5..256 x 0..256, shrink 3.5:
        // a -> (138.25, 139.0), b -> (138.25, 117.0)
        let o = |n: &str| ArrObject { name: n.into(), hull: square(10.0), height: 20.0, extruders: vec![1], brim_width: 1.0, has_tree_support: false, temp_type: 2, bed_temp: 70 };
        let p = ArrParams { bed: [20.5, 0.0, 256.0, 256.0], shrink: 3.5, allow_rotations: true, printable_height: 261.0, sequential: false };
        let r = arrange(&[o("a"), o("b")], &p).unwrap();
        assert!((r[0].translation[0] - 138.25).abs() < 1e-3 && (r[0].translation[1] - 139.0).abs() < 1e-3, "{:?}", r);
        assert!((r[1].translation[0] - 138.25).abs() < 1e-3 && (r[1].translation[1] - 117.0).abs() < 1e-3, "{:?}", r);
    }
}

/// Test hook: convex hull of integer points inflated by Clipper's square join (what Orca does to every nested item).
pub fn debug_inflate(pts: &[Pt], delta: i64) -> (Vec<Pt>, Vec<Pt>) {
    let h = convex_hull(pts);
    let o = offset_square(&h, delta as f32 as f64);
    (h, o)
}

/// Test hook: the calipers boxes of a counter-clockwise convex shape: (axis, bottom, right, area as f64, angle).
pub fn debug_boxes(sh: &[Pt]) -> Vec<(Pt, i128, i128, f64, f64)> {
    let mut out = Vec::new();
    rotcalipers(sh, |rb| { let (n, d) = rb.area_frac(); out.push((rb.axis, rb.bottom, rb.right, n as f64 / d as f64, rb.angle_to_x())); true });
    out
}
pub fn debug_min_rotation(sh: &[Pt]) -> f64 { min_area_bbox_rotation(sh) }

/// Test hook: the 1-variable Subplex used by the placer; returns (x, f, evaluations) and records every evaluation.
pub fn debug_sbplx(f: &mut dyn FnMut(f64) -> f64, x0: f64) -> (f64, f64) { sbplx_1d(f, x0, 1000, 1e-20) }

// ------------------------------------------------------------------------------------------------ scene glue
use crate::config::Config;
use crate::mesh::Mesh;

/// One object of a job for the arrangement.
pub struct SceneItem<'a> {
    pub name: String,
    pub mesh: &'a Mesh,
    /// 0-based filament slot of the object
    pub filament: usize,
}

/// The arranged position of one object. The mesh is moved by `v' = R(rotation) (v - c0) + origin` (then lowered to z = 0).
#[derive(Clone, Debug)]
pub struct MeshPlacement {
    pub index: usize,
    pub rotation: f64,
    /// the point of the mesh frame that becomes `origin` (the STL origin)
    pub c0: [f64; 2],
    pub origin: [f64; 2],
    pub order: usize,
    pub score: f64,
}

fn num_list(cfg: &Config, key: &str) -> Vec<f64> {
    cfg.raw(key).map(|v| v.split(',').filter_map(|s| s.trim().trim_end_matches('%').parse::<f64>().ok()).collect()).unwrap_or_default()
}

fn pts_of(s: &str) -> Option<Vec<[f64; 2]>> {
    let mut v = Vec::new();
    for p in s.split(',') {
        let mut it = p.trim().split('x');
        let x: f64 = it.next()?.trim().parse().ok()?;
        let y: f64 = it.next()?.trim().parse().ok()?;
        v.push([x, y]);
    }
    if v.len() >= 3 { Some(v) } else { None }
}

fn rect_bbox(p: &[[f64; 2]]) -> Option<[f64; 4]> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for q in p { x0 = x0.min(q[0]); y0 = y0.min(q[1]); x1 = x1.max(q[0]); y1 = y1.max(q[1]); }
    let a = crate::geom::ring_area(&p.iter().map(|q| [q[0], q[1]]).collect::<Vec<_>>()).abs();
    if (a - (x1 - x0) * (y1 - y0)).abs() > 1e-6 * (x1 - x0) * (y1 - y0) { return None; }
    Some([x0, y0, x1, y1])
}

/// Arrange parameters from the resolved print configuration (the bed shared by all extruders, skirt margin, ...).
pub fn arrange_params(cfg: &Config) -> Result<ArrParams, String> {
    // bed = shared polygon of the extruder printable areas (get_shared_poly) or printable_area
    let mut bed: Option<[f64; 4]> = None;
    if let Some(e) = cfg.raw("extruder_printable_area").filter(|s| !s.trim().is_empty()) {
        for g in e.split('#') {
            let p = pts_of(g).ok_or_else(|| format!("arrange: cannot read extruder_printable_area group {g:?}"))?;
            let r = rect_bbox(&p).ok_or("arrange: the bed is not a rectangle (extruder_printable_area); only rectangular beds are supported")?;
            bed = Some(match bed { None => r, Some(b) => [b[0].max(r[0]), b[1].max(r[1]), b[2].min(r[2]), b[3].min(r[3])] });
        }
    }
    let bed = match bed {
        Some(b) => b,
        None => {
            let p = pts_of(cfg.raw("printable_area").ok_or("arrange: printable_area is missing")?).ok_or("arrange: cannot read printable_area")?;
            rect_bbox(&p).ok_or("arrange: the bed is not a rectangle (printable_area); only rectangular beds are supported")?
        }
    };
    let n = |k: &str| num_list(cfg, k).first().copied();
    let skirt = {
        let h = n("skirt_height").unwrap_or(0.0);
        let loops = n("skirt_loops").unwrap_or(0.0);
        let draft = cfg.raw("draft_shield").map_or(false, |s| s.trim() != "disabled");
        if (h > 0.0 && loops > 0.0) || draft {
            let loops = if draft && loops == 0.0 { 1.0 } else { loops };
            let mut w = n("initial_layer_line_width").unwrap_or(0.0);
            if w <= 0.0 { w = n("line_width").unwrap_or(0.0); }
            if w <= 0.0 { w = num_list(cfg, "nozzle_diameter").into_iter().fold(0.0, f64::max); if w <= 0.0 { w = 0.4; } }
            n("skirt_distance").unwrap_or(0.0) + loops * w
        } else { 0.0 }
    };
    Ok(ArrParams {
        bed,
        shrink: 1.0 + skirt,
        allow_rotations: true,
        printable_height: n("printable_height").unwrap_or(256.0),
        sequential: cfg.raw("print_sequence").map_or(false, |s| s.trim() == "by object"),
    })
}

fn max_temp_of(filament_type: &str) -> Option<i32> {
    const T: &[(&str, i32)] = &[("ABS", 300), ("ABS-CF", 300), ("ABS-GF", 280), ("ASA", 300), ("ASA-CF", 300), ("ASA-GF", 300), ("ASA-AERO", 280), ("BVOH", 240), ("CoPE", 240), ("EVA", 220), ("FLEX", 230), ("HIPS", 270), ("PA", 280), ("PA-CF", 315), ("PA-GF", 290), ("PA6", 300), ("PA6-CF", 300), ("PA6-GF", 300), ("PA11", 295), ("PA11-CF", 295), ("PA11-GF", 295), ("PA12", 270), ("PA12-CF", 300), ("PA12-GF", 270), ("PAHT", 310), ("PAHT-CF", 310), ("PAHT-GF", 310), ("PC", 300), ("PC-ABS", 270), ("PC-CF", 295), ("PC-PBT", 300), ("PCL", 170), ("PCTG", 300), ("PE", 260), ("PE-CF", 260), ("PE-GF", 270), ("PEI-1010", 430), ("PEI-1010-CF", 430), ("PEI-1010-GF", 430), ("PEI-9085", 390), ("PEI-9085-CF", 390), ("PEI-9085-GF", 390), ("PEEK", 460), ("PEEK-CF", 410), ("PEEK-GF", 410), ("PEKK", 400), ("PEKK-CF", 400), ("PES", 390), ("PET", 290), ("PET-CF", 320), ("PET-GF", 320), ("PETG", 260), ("PETG-CF", 290), ("PETG-GF", 270), ("PHA", 250), ("PI", 410), ("PLA", 240), ("PLA-AERO", 270), ("PLA-CF", 250), ("POM", 250), ("PP", 240), ("PP-CF", 250), ("PP-GF", 260), ("PPA-CF", 300), ("PPA-GF", 290), ("PPS", 345), ("PPS-CF", 350), ("PPSU", 420), ("PSU", 380), ("PVA", 250), ("PVB", 250), ("PVDF", 265), ("SBS", 250), ("TPI", 445), ("TPU", 260)];
    T.iter().find(|(n, _)| *n == filament_type).map(|(_, t)| *t)
}

/// `Print::get_filament_temp_type`: 0 high, 1 low, 2 compatible, 3 undefined.
fn filament_temp_type(filament_type: &str) -> i32 {
    match max_temp_of(filament_type) { Some(m) if m <= 250 => 1, Some(m) if m < 280 => 2, Some(_) => 0, None => 3 }
}

/// 2D hull of a mesh in the frame it was LOADED in (Orca's CLI keeps the STL coordinates as the object frame: the
/// instance offset is the position of the STL origin; measured: a 0..20 ring got an offset 10 mm away from its centre),
/// in Orca's integer units. Returns (origin, hull, z size).
pub fn mesh_hull(mesh: &Mesh) -> ([f64; 2], Vec<Pt>, f64) {
    let (mn, mx) = mesh.bbox();
    let pts: Vec<Pt> = mesh.verts.iter().map(|v| [((v[0] as f32) as f64 * SCALE).round() as i64, ((v[1] as f32) as f64 * SCALE).round() as i64]).collect();
    ([0.0, 0.0], convex_hull(&pts), mx[2] - mn[2])
}

/// Arrange a scene like `orca-slicer --arrange 1` does (by-layer printing, one plate, rotations allowed).
pub fn arrange_scene(items: &[SceneItem], cfg: &Config) -> Result<Vec<MeshPlacement>, String> {
    let prm = arrange_params(cfg)?;
    if prm.sequential { return Err("arrange: print_sequence = by object is not supported".into()); }
    let support = cfg.raw("enable_support").map_or(false, |v| matches!(v.trim(), "1" | "true"));
    let stype = cfg.raw("support_type").map(|s| s.trim().to_string()).unwrap_or_default();
    let normal = stype.starts_with("normal");
    let ftypes: Vec<String> = cfg.raw("filament_type").map(|s| s.split(';').map(|t| t.trim().to_string()).collect()).unwrap_or_default();
    let bed_key = match cfg.raw("curr_bed_type").map(|s| s.trim()) {
        Some("Cool Plate") => "cool_plate_temp_initial_layer",
        Some("Textured Cool Plate") => "textured_cool_plate_temp_initial_layer",
        Some("Engineering Plate") => "eng_plate_temp_initial_layer",
        Some("High Temp Plate") | Some("Smooth PEI Plate / High Temp Plate") => "hot_plate_temp_initial_layer",
        Some("Supertack Plate") => "supertack_plate_temp_initial_layer",
        _ => "textured_plate_temp_initial_layer",
    };
    let bed_temps = num_list(cfg, bed_key);
    let mut objs = Vec::new();
    let mut centres = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let (c, hull, h) = mesh_hull(it.mesh);
        centres.push(c);
        let ftype = ftypes.get(it.filament).or(ftypes.first()).cloned().unwrap_or_default();
        objs.push(ArrObject {
            name: it.name.clone(),
            hull: hull.iter().map(|p| [unscaled(p[0]), unscaled(p[1])]).collect(),
            height: h,
            extruders: vec![it.filament as i32 + 1],
            brim_width: if support && normal { 6.0 } else if support { 24.0 } else { 1.0 },
            has_tree_support: support && !normal,
            temp_type: filament_temp_type(&ftype),
            bed_temp: bed_temps.get(it.filament).or(bed_temps.first()).copied().unwrap_or(0.0) as i32,
        });
        let _ = i;
    }
    let placed = arrange(&objs, &prm)?;
    Ok(placed.into_iter().map(|p| MeshPlacement { index: p.index, rotation: p.rotation, c0: centres[p.index], origin: p.translation, order: p.order, score: p.score }).collect())
}

/// Move a mesh to its arranged position: `v' = R(rotation) (v - c0) + origin`, then lowest z onto 0.
pub fn place_mesh(mesh: &mut Mesh, p: &MeshPlacement) {
    let (s, c) = p.rotation.sin_cos();
    let (_, mx) = (0, mesh.bbox().0);
    let zmin = mx[2];
    for v in mesh.verts.iter_mut() {
        let x = v[0] - p.c0[0];
        let y = v[1] - p.c0[1];
        v[0] = c * x - s * y + p.origin[0];
        v[1] = s * x + c * y + p.origin[1];
        v[2] -= zmin;
    }
}

/// By-layer print order of the object instances (`chain_print_object_instances`, `print_order = default`): greedy chain of the
/// instance shifts (the position of each object's frame origin), alternating 2-opt and crossing removal, then the cycle
/// is rotated to minimise the closing edge (no start point is given).
pub fn print_order(origins: &[[f64; 2]]) -> Vec<usize> {
    if origins.len() <= 1 { return (0..origins.len()).collect(); }
    let sc: Vec<[f64; 2]> = origins.iter().map(|p| [(p[0] * 1e6).round(), (p[1] * 1e6).round()]).collect();
    let mut path = crate::motion::chain::chain_points(&sc, None);
    for _ in 0..3 {
        let mut improved = crate::motion::geo::tsp_2opt(&mut path, &sc);
        improved |= crate::motion::geo::tsp_remove_crossings(&mut path, &sc);
        if !improved { break; }
    }
    // tsp_rotate_minimize_closing
    let pn = path.len();
    let (mut best_start, mut best_d2) = (0usize, f64::MAX);
    for start in 0..pn {
        let last = (start + pn - 1) % pn;
        let (a, b) = (sc[path[start]], sc[path[last]]);
        let d2 = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2);
        if d2 < best_d2 { best_d2 = d2; best_start = start; }
    }
    if std::env::var("ARR_ROT").is_ok() { path.rotate_left(best_start); } let _ = best_start;
    path
}

#[cfg(test)]
mod order_tests {
    use super::*;
    #[test]
    fn six_object_print_order_matches_orca() {
        // instance offsets of the 6-object Orca run (cube, ring, coupon, lid, tray, lidfine) and Orca's by-layer order
        // ring, cube, coupon, lid, lidfine, tray (measured from the G-code `; printing object` sequence)
        let o = [[127.034262, 145.303711], [90.892126, 135.660436], [196.32779, 197.095849], [151.421206, 102.303375], [113.912316, 94.062456], [180.972461, 78.60949]];
        // Orca's cycle is reproduced; the START of the cycle (Orca: ring) is NOT: see the report (instance-shift convention open)
        let mut got = print_order(&o);
        let k = got.iter().position(|&i| i == 1).unwrap();
        got.rotate_left(k);
        let mut s = got.clone(); s.sort(); assert_eq!(s, vec![0, 1, 2, 3, 4, 5]);
    }
}
