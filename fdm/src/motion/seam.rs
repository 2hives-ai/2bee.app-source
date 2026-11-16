//! Seam placement: a port of `GCode/SeamPlacer.cpp` for the `aligned`, `nearest`, `rear` and `random` modes, plus
//! `GCode::extrude_loop`'s loop splitting and `seam_gap` clipping.
//!
//! Faithful to Orca: candidate = vertex of the external-perimeter polygon (first point repeated at the end, coordinates
//! scaled to integers of 1 micron and unscaled to f32 in Orca's object frame); score = `overhang + visibility +
//! angle_importance * angle_penalty(ccw_angle)` evaluated in f32 exactly as `SeamComparator` does (angle at the polygon
//! vertices at least one nozzle diameter along the boundary, with the 0.1 mm floor on the closing length, convex corners
//! positive); per-layer pick by the `SeamComparator`; `aligned`/`rear` then gather "seam strings" across layers
//! (`find_seam_string`, including Orca's quirk of skipping the layer next to the start when the upward search ends) and
//! replace the seam by a weighted cubic B-spline fit of the string (`fit_cubic_bspline`, `seam_align_mm_per_segment` =
//! 4 mm). Inner loops are cut at the projection of the outer seam (`place_seam`, role `erPerimeter` branch, minus
//! `staggered_inner_seams`).
//!
//! Bit-level agreement with Orca (measured with an instrumented Orca build that dumps its seam candidates): the
//! visibility of every candidate (`visibility.rs`: same samples, same KD-tree visit order, same f32 sums) and the angle
//! of every vertex are identical to Orca's wherever our polygon coordinates are the same integers. Near ties are then
//! decided exactly as Orca decides them, which is what lets the seam string pick the same corner.
//!
//! DIFFERENCES FROM ORCA (kept honest):
//! * The polygon START. Orca's polygon begins at the first junction of its Arachne extrusion line (a point that is
//!   usually NOT a vertex of the outline: the projection of a beading-transition node onto an edge). The walls stage does
//!   not provide it, so `orca_like_start` rotates the loop to the empirical rule (see there); with Orca's true start
//!   inserted (debug experiment) the agreement is 95-100 % instead of 82-95 %.
//! * Near-tied candidates on a vertical prism (constant visibility) are decided by the micron rounding of Orca's wall
//!   coordinates (angle noise of 1e-6 rad); our wall coordinates differ from Orca's by up to 1 micron, so those are a
//!   coin flip. Penalties within `TIE_EPS` (2e-6) count as tied and fall back to "contours rear-right first, holes
//!   front-left first", standing in for "the earliest vertex of Orca's polygon" (exact for axis-aligned rectangles).
//! * previous-layer overhang uses the slices of the previous layer when given (`SeamExtras::slices`), else the previous
//!   layer's external rings offset by half a bead.
//! * seam painting (enforcers/blockers) and the multi-material "embedded distance" are not available.
//! * Orca's loops made of several extrusion paths (overhang sections) repeat a point at every join; we do not.

use super::geo::{self, P2};
use super::visibility::Kd3;
use super::plan::Stroke;
use crate::types::Feature;


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeamPosition { Nearest, Aligned, AlignedBack, Rear, Random }

impl SeamPosition {
    pub fn parse(s: &str) -> SeamPosition {
        match s.trim() {
            "nearest" => SeamPosition::Nearest,
            "back" | "rear" => SeamPosition::Rear,
            "random" => SeamPosition::Random,
            "aligned_back" => SeamPosition::AlignedBack,
            _ => SeamPosition::Aligned,
        }
    }
}

const SHARP_ANGLE_SNAP: f64 = 55.0 * std::f64::consts::PI / 180.0;
const OVERHANG_ANGLE: f64 = 45.0 * std::f64::consts::PI / 180.0;
const ALIGN_SCORE_TOLERANCE: f32 = 0.3;
const ALIGN_DIST_FACTOR: f32 = 4.0;
const ALIGN_MIN_STRING: usize = 6;
const ALIGN_MM_PER_SEGMENT: f64 = 4.0;
/// Orca scales every coordinate to integers of 1e-6 mm; the seam candidates are those integers, unscaled to float.
const SCALE: f64 = 1e-6;

/// `SeamPlacerImpl::gauss`, in f32 exactly as Orca evaluates it (`std::exp(float)` is `expf`).
fn gauss32(value: f32, mean_x: f32, mean_value: f32, falloff: f32) -> f32 {
    let shifted = value - mean_x;
    let denominator = falloff * shifted * shifted + 1.0f32;
    let exponent = 1.0f32 / denominator;
    mean_value * (exponent.exp() - 1.0f32) / (1.0f32.exp() - 1.0f32)
}

/// `compute_angle_penalty`, f32.
pub fn angle_penalty32(ccw: f32) -> f32 { gauss32(ccw, 0.0, 1.0, 3.0) + 1.0f32 / (2.0f32 + (-ccw).exp()) }

/// f64 convenience form (weights of the spline fit, tests).
pub fn angle_penalty(ccw: f64) -> f64 { angle_penalty32(ccw as f32) as f64 }

/// One seam candidate (Orca `SeamCandidate`): a vertex of an external-perimeter polygon, in Orca's object frame (f32).
#[derive(Clone, Debug)]
struct Cand {
    /// bed coordinates (the integer-scaled position shifted back by the frame offset)
    pos: P2,
    /// Orca position: x, y = unscaled integer coordinates as f32 in the object frame, z = the layer's `slice_z`
    p3: [f32; 3],
    angle: f64,
    ang32: f32,
    overhang: f64,
    oh32: f32,
    unsupported: f64,
    vis32: f32,
    perim: usize,
    hole: bool,
    fw32: f32,
}

#[derive(Clone, Debug)]
struct Perim {
    start: usize,
    end: usize,
    seam_index: usize,
    flow_width: f64,
    fw32: f32,
    finalized: bool,
    final_pos: P2,
}

#[derive(Default, Clone)]
struct LayerSeams {
    perims: Vec<Perim>,
    pts: Vec<Cand>,
    kd: Kd3,
}

pub struct SeamParams {
    pub position: SeamPosition,
    pub nozzle: f64,
    pub staggered_inner: bool,
}

pub struct SeamPlanner {
    layers: Vec<LayerSeams>,
    z: Vec<f64>,
    h: Vec<f64>,
    z32: Vec<f32>,
    params: SeamParams,
}

/// `calculate_polygon_angles_at_vertices` on the INTEGER polygon, as Orca: lengths and arm distances in f32, the angle
/// `atan2(cross, dot)` of the integer edge vectors in f64 then cast to f32. `poly` includes the closing duplicate of the
/// first point (Orca collects the loop's points, first point repeated), whose closing "length" is the 0.1 floor.
fn polygon_angles(poly: &[[i64; 2]], lengths: &[f32], arm: f32) -> Vec<f32> {
    let n = poly.len();
    let mut out = vec![0.0f32; n];
    if n < 3 { return out; }
    let (mut idx_prev, mut idx_curr, mut idx_next) = (0usize, 0usize, 0usize);
    let (mut d_prev, mut d_next) = (0.0f32, 0.0f32);
    let prev_i = |i: usize| (i + n - 1) % n;
    let next_i = |i: usize| (i + 1) % n;
    let mut guard = 0usize;
    while d_prev < arm && guard < 4 * n + 8 { idx_prev = prev_i(idx_prev); d_prev += lengths[idx_prev]; guard += 1; }
    for _ in 0..n {
        let mut g = 0usize;
        while d_prev - lengths[idx_prev] > arm && g < 4 * n + 8 { d_prev -= lengths[idx_prev]; idx_prev = next_i(idx_prev); g += 1; }
        g = 0;
        while d_next < arm && g < 4 * n + 8 { d_next += lengths[idx_next]; idx_next = next_i(idx_next); g += 1; }
        let (p0, p1, p2) = (poly[idx_prev], poly[idx_curr], poly[idx_next]);
        let a = [(p1[0] - p0[0]) as f64, (p1[1] - p0[1]) as f64];
        let b = [(p2[0] - p1[0]) as f64, (p2[1] - p1[1]) as f64];
        out[idx_curr] = (a[0] * b[1] - a[1] * b[0]).atan2(a[0] * b[0] + a[1] * b[1]) as f32;
        let cd = lengths[idx_curr];
        idx_curr += 1;
        if idx_curr >= n { break; }
        d_prev += cd; d_next -= cd;
    }
    out
}

/// Orca's polygon of an outer-wall loop starts at the first junction of the Arachne extrusion line, which we do not
/// have: measured on Orca's own candidate lists it is (a) the corner just after the lowest vertex (last of the lowest
/// ones in CCW order) when that edge ends in a sharp corner (rectangles: always the rear-right corner of the lowest
/// edge), (b) a point 0.10-0.55 (typically 0.2-0.4) of the way along the edge after the lowest vertex on smooth
/// outlines (circles, 8-16-gons; the exact fraction depends on the Voronoi/transition geometry). The start matters
/// because it is a candidate with its own angle, shifts the 0.1 mm phantom closing length, and orders exact ties.
/// This returns the CCW ring rotated to that start (a vertex is inserted for (b), at `START_FRACTION`).
fn orca_like_start(ring: &[P2]) -> Vec<P2> {
    let mut r: Vec<P2> = ring.to_vec();
    if r.len() > 3 && geo::dist(r[0], r[r.len() - 1]) < 1e-9 { r.pop(); }
    if geo::signed_area(&r) < 0.0 { r.reverse(); }
    let n = r.len();
    if n < 3 { return r; }
    let miny = r.iter().map(|p| p[1]).fold(f64::MAX, f64::min);
    let mut low = 0usize;
    for i in 0..n { if r[i][1] <= miny + 1e-6 { low = i; } }
    let nx = (low + 1) % n;
    let nn = (nx + 1) % n;
    let a = geo::sub(r[nx], r[low]);
    let b = geo::sub(r[nn], r[nx]);
    let turn = geo::cross(a, b).atan2(geo::dot(a, b)).abs();
    if turn >= START_SHARP_CORNER {
        (0..n).map(|j| r[(nx + j) % n]).collect()
    } else {
        let q = [r[low][0] + START_FRACTION * a[0], r[low][1] + START_FRACTION * a[1]];
        let mut out = vec![q];
        for j in 1..=n { out.push(r[(low + j) % n]); }
        out
    }
}

/// Penalty difference below which two candidates count as tied (see `first_better`).
const TIE_EPS: f32 = 2e-6;

/// Set to false once the walls stage emits loops that already start at Orca's first Arachne junction.
const START_HEURISTIC: bool = true;
const START_FRACTION: f64 = 0.2;
const START_SHARP_CORNER: f64 = 60.0 * std::f64::consts::PI / 180.0;

/// Signed distance from `p` to a ring's boundary, negative inside (like `distance_from_lines<true>`).
fn signed_dist_to_ring(ring: &[P2], p: P2) -> f64 {
    let (_, _, d) = geo::closest_on_ring(ring, p);
    if geo::in_ring(p, ring) { -d } else { d }
}

#[derive(Clone)]
pub struct LoopSpec {
    /// Closed external-perimeter ring (as printed: any winding).
    pub ring: Vec<P2>,
    pub width: f64,
    /// True for a hole (clockwise relative to its island contour).
    pub is_hole: bool,
}

/// Optional inputs that make the score closer to Orca's: the mesh visibility field and the true layer slices
/// (`lslices`) for the overhang term.
#[derive(Default)]
pub struct SeamExtras<'a> {
    pub visibility: Option<&'a super::visibility::Visibility>,
    /// The visibility mesh is the layers' frame rotated by `frame_rot_deg` about `frame_center` (a parity-tool
    /// artefact: Orca does not rotate the part). Candidates are rotated back before the lookup.
    pub frame_rot_deg: f64,
    pub frame_center: P2,
    /// Slices of every layer; used for the overhang distance instead of the previous layer's outer rings.
    pub slices: Option<&'a [crate::types::Polys]>,
    /// Several objects on one plate: (footprint hull in bed mm, visibility field of THAT object's own triangles). Orca ray-casts
    /// every print object against itself only (`compute_global_occlusion` runs per object), so a candidate takes the field of
    /// the object whose footprint contains (else is nearest to) it. Overrides `visibility`.
    pub per_object: Option<&'a [(Vec<P2>, super::visibility::Visibility)]>,
}

struct SliceDist {
    segs: Vec<(P2, P2)>,
    cell: f64,
    cells: std::collections::HashMap<(i64, i64), Vec<u32>>,
}
impl SliceDist {
    fn new(polys: &[crate::types::Poly]) -> SliceDist {
        let mut segs = Vec::new();
        let mut add = |r: &Vec<P2>, want_ccw: bool| {
            if r.len() < 3 { return; }
            let ccw = geo::signed_area(r) > 0.0;
            let n = r.len();
            for i in 0..n {
                let (a, b) = (r[i], r[(i + 1) % n]);
                if ccw == want_ccw { segs.push((a, b)); } else { segs.push((b, a)); }
            }
        };
        for p in polys { add(&p.contour, true); for h in &p.holes { add(h, false); } }
        let cell = 2.0;
        let mut cells: std::collections::HashMap<(i64, i64), Vec<u32>> = Default::default();
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for (i, (a, b)) in segs.iter().enumerate() {
            for q in [a, b] { for k in 0..2 { lo[k] = lo[k].min(q[k]); hi[k] = hi[k].max(q[k]); } }
            let (x0, x1) = (a[0].min(b[0]), a[0].max(b[0]));
            let (y0, y1) = (a[1].min(b[1]), a[1].max(b[1]));
            // rasterise the segment's bounding box (segments are short; long ones touch more cells, still correct)
            for cx in (x0 / cell).floor() as i64..=(x1 / cell).floor() as i64 {
                for cy in (y0 / cell).floor() as i64..=(y1 / cell).floor() as i64 { cells.entry((cx, cy)).or_default().push(i as u32); }
            }
        }
        let _ = (lo, hi);
        SliceDist { segs, cell, cells }
    }
    fn signed(&self, p: P2) -> f64 {
        if self.segs.is_empty() { return f64::INFINITY; }
        let (cx, cy) = ((p[0] / self.cell).floor() as i64, (p[1] / self.cell).floor() as i64);
        let mut best = f64::INFINITY;
        let mut best_i = usize::MAX;
        let mut r = 0i64;
        loop {
            // visit the ring of cells at Chebyshev radius r
            for x in cx - r..=cx + r {
                for y in cy - r..=cy + r {
                    if (x - cx).abs().max((y - cy).abs()) != r { continue; }
                    if let Some(v) = self.cells.get(&(x, y)) {
                        for &i in v {
                            let (a, b) = self.segs[i as usize];
                            let ab = geo::sub(b, a);
                            let l2 = geo::dot(ab, ab);
                            let t = if l2 < 1e-18 { 0.0 } else { (geo::dot(geo::sub(p, a), ab) / l2).clamp(0.0, 1.0) };
                            let d = geo::dist(geo::lerp(a, b, t), p);
                            if d < best - 1e-12 || (d <= best + 1e-12 && (i as usize) < best_i) { if d < best { best = d; } best_i = i as usize; }
                        }
                    }
                }
            }
            // everything within `r * cell` of p has been visited
            if best <= (r as f64) * self.cell { break; }
            r += 1;
            if r > 2000 { break; }
        }
        if best_i == usize::MAX { return f64::INFINITY; }
        let (a, b) = self.segs[best_i];
        let side = geo::cross(geo::sub(b, a), geo::sub(p, a));
        if side > 0.0 { -best } else { best }
    }
}


/// Stable merge sort by a strict-weak "less" (what `std::stable_sort` with Orca's `is_first_better` yields).
fn stable_sort_by_less<T: Clone>(v: &mut Vec<T>, less: &dyn Fn(&T, &T) -> bool) {
    let n = v.len();
    if n < 2 { return; }
    let mut src = v.clone();
    let mut dst = v.clone();
    let mut w = 1usize;
    while w < n {
        let mut i = 0usize;
        while i < n {
            let mid = (i + w).min(n);
            let hi = (i + 2 * w).min(n);
            let (mut a, mut b, mut k) = (i, mid, i);
            while a < mid && b < hi {
                // take from the right run only when strictly better: equal elements keep their order
                if less(&src[b], &src[a]) { dst[k] = src[b].clone(); b += 1; } else { dst[k] = src[a].clone(); a += 1; }
                k += 1;
            }
            while a < mid { dst[k] = src[a].clone(); a += 1; k += 1; }
            while b < hi { dst[k] = src[b].clone(); b += 1; k += 1; }
            i += 2 * w;
        }
        std::mem::swap(&mut src, &mut dst);
        w *= 2;
    }
    *v = src;
}

impl SeamPlanner {
    /// `layers[i]` = external perimeter rings of layer i; `z[i]` its top Z; `h[i]` its height.
    pub fn new(layers: &[Vec<LoopSpec>], z: &[f64], h: &[f64], params: SeamParams) -> SeamPlanner {
        Self::new_with(layers, z, h, params, &SeamExtras::default())
    }

    pub fn new_with(layers: &[Vec<LoopSpec>], z: &[f64], h: &[f64], params: SeamParams, extras: &SeamExtras) -> SeamPlanner {
        let mut out = Vec::with_capacity(layers.len());
        let arm = params.nozzle as f32;
        let off = super::visibility::FRAME_OFFSET;
        let z32: Vec<f32> = (0..layers.len()).map(|li| (z[li] - h[li] * 0.5) as f32).collect();
        let mut prev_rings: Vec<(Vec<P2>, f64)> = Vec::new();
        for (li, specs) in layers.iter().enumerate() {
            let mut ls = LayerSeams::default();
            for sp in specs {
                if sp.ring.len() < 3 { continue; }
                let ring_owned;
                let sp = if START_HEURISTIC && !sp.is_hole {
                    ring_owned = LoopSpec { ring: orca_like_start(&sp.ring), width: sp.width, is_hole: sp.is_hole };
                    &ring_owned
                } else { sp };
                // Orca polygon: the loop's points scaled to integers, first point repeated at the end, made CCW
                let mut poly: Vec<[i64; 2]> = sp.ring.iter().map(|p| [((p[0] - off[0]) / SCALE).round() as i64, ((p[1] - off[1]) / SCALE).round() as i64]).collect();
                if poly.len() > 3 && poly[0] == poly[poly.len() - 1] { poly.pop(); }
                poly.push(poly[0]);
                let area2: i128 = (0..poly.len() - 1).map(|i| poly[i][0] as i128 * poly[i + 1][1] as i128 - poly[i + 1][0] as i128 * poly[i][1] as i128).sum();
                let was_cw = area2 < 0;
                if was_cw { poly.reverse(); }
                let np = poly.len();
                let un = |p: [i64; 2]| [p[0] as f64 * SCALE, p[1] as f64 * SCALE];
                let dist = |a: [i64; 2], b: [i64; 2]| { let (ua, ub) = (un(a), un(b)); let (dx, dy) = (ua[0] - ub[0], ua[1] - ub[1]); (dx * dx + dy * dy).sqrt() };
                let mut lengths: Vec<f32> = (0..np - 1).map(|i| dist(poly[i], poly[i + 1]) as f32).collect();
                lengths.push(dist(poly[0], poly[np - 1]).max(0.1) as f32);
                let ang = polygon_angles(&poly, &lengths, arm);
                let start = ls.pts.len();
                let pi = ls.perims.len();
                let fw = sp.width;
                for (k, p) in poly.iter().enumerate() {
                    let a32 = if was_cw { -ang[k] } else { ang[k] };
                    let u = un(*p);
                    ls.pts.push(Cand {
                        pos: [u[0] + off[0], u[1] + off[1]],
                        p3: [u[0] as f32, u[1] as f32, z32[li]],
                        angle: a32 as f64, ang32: a32, overhang: 0.0, oh32: 0.0, unsupported: 0.0, vis32: 0.0, perim: pi, hole: sp.is_hole, fw32: fw as f32,
                    });
                }
                ls.perims.push(Perim { start, end: ls.pts.len(), seam_index: start, flow_width: fw, fw32: fw as f32, finalized: false, final_pos: [0.0, 0.0] });
            }
            // overhang vs previous layer: distance to the previous layer's slice (Orca: `lslices` lines), signed
            let prev_slice: Option<SliceDist> = extras.slices.and_then(|sl| if li > 0 { sl.get(li - 1) } else { None }).filter(|v| !v.is_empty())
                .map(|polys| SliceDist::new(polys));
            if li > 0 {
                if let Some(sd) = &prev_slice {
                    for c in ls.pts.iter_mut() {
                        let fw = ls.perims[c.perim].flow_width;
                        let dist = sd.signed(c.pos);
                        if !dist.is_finite() { continue; }
                        c.overhang = (dist + 0.65 * fw - OVERHANG_ANGLE.tan() * h[li]).max(0.0);
                        c.unsupported = dist + 0.4 * fw;
                    }
                } else if !prev_rings.is_empty() {
                    for c in ls.pts.iter_mut() {
                        let fw = ls.perims[c.perim].flow_width;
                        let mut best = f64::INFINITY;
                        let mut best_signed = f64::INFINITY;
                        for (r, w) in &prev_rings {
                            let d = signed_dist_to_ring(r, c.pos) - w * 0.5;
                            if d.abs() < best { best = d.abs(); best_signed = d; }
                        }
                        let dist = best_signed;
                        c.overhang = (dist + 0.65 * fw - OVERHANG_ANGLE.tan() * h[li]).max(0.0);
                        c.unsupported = dist + 0.4 * fw;
                    }
                }
                for c in ls.pts.iter_mut() { c.oh32 = c.overhang as f32; }
            }
            // mesh visibility of every candidate (3-D point at the layer's slice z), f32 as Orca
            if let (Some(objs), true) = (extras.per_object, matches!(params.position, SeamPosition::Aligned | SeamPosition::AlignedBack | SeamPosition::Nearest)) {
                for c in ls.pts.iter_mut() {
                    let mut best = (f64::INFINITY, 0usize);
                    for (i, (fp, _)) in objs.iter().enumerate() {
                        let d = if fp.len() >= 3 && geo::in_ring(c.pos, fp) { -1.0 } else { fp.iter().map(|q| geo::dist(*q, c.pos)).fold(f64::INFINITY, f64::min) };
                        if d < best.0 { best = (d, i); }
                    }
                    c.vis32 = objs[best.1].1.at_f32(c.p3);
                }
            } else if let (Some(vis), true) = (extras.visibility, matches!(params.position, SeamPosition::Aligned | SeamPosition::AlignedBack | SeamPosition::Nearest)) {
                let (sn, cs) = (-extras.frame_rot_deg).to_radians().sin_cos();
                for c in ls.pts.iter_mut() {
                    c.vis32 = if extras.frame_rot_deg == 0.0 { vis.at_f32(c.p3) } else {
                        let d = geo::sub(c.pos, extras.frame_center);
                        let q = [extras.frame_center[0] + d[0] * cs - d[1] * sn, extras.frame_center[1] + d[0] * sn + d[1] * cs];
                        vis.at([q[0], q[1], z32[li] as f64]) as f32
                    };
                }
            }
            prev_rings = specs.iter().filter(|s| s.ring.len() >= 3).map(|s| (s.ring.clone(), s.width)).collect();
            ls.kd = Kd3::build(ls.pts.iter().map(|c| c.p3).collect());
            out.push(ls);
        }
        let mut sp = SeamPlanner { layers: out, z: z.to_vec(), h: h.to_vec(), z32, params };
        sp.pick_all();
        sp
    }

    /// `Layer::slice_z`: the middle of the layer (the seam candidates' z in Orca).
    fn slice_z(&self, li: usize) -> f64 { self.z[li] - self.h[li] * 0.5 }

    fn importance(&self) -> f32 { if self.params.position == SeamPosition::Nearest { 1.0 } else { 0.6 } }

    /// `penalty = overhang + visibility + angle_importance * angle_penalty (+ distance penalty)`, left to right in f32.
    fn pen32(&self, c: &Cand) -> f32 { (c.oh32 + c.vis32) + self.importance() * angle_penalty32(c.ang32) }

    /// `SeamComparator::is_first_better` (no enforcers/blockers/embedding). `preferred` is in the object frame.
    /// Orca returns false both ways for equal penalties (the caller's scan order then decides); candidates that tie
    /// EXACTLY in f32 are ordered here by a stand-in for "Orca's polygon starts at its own vertex" (see module docs),
    /// so the order stays a strict total order.
    fn first_better(&self, a: &Cand, b: &Cand, preferred: [f32; 2]) -> bool {
        if a.oh32 > 0.0 || b.oh32 > 0.0 { return a.oh32 < b.oh32; }
        if self.params.position == SeamPosition::Rear && a.p3[1] != b.p3[1] { return a.p3[1] > b.p3[1]; }
        let (mut da, mut db) = (0.0f32, 0.0f32);
        if self.params.position == SeamPosition::Nearest {
            let n = |c: &Cand| { let (dx, dy) = (c.p3[0] - preferred[0], c.p3[1] - preferred[1]); (dx * dx + dy * dy).sqrt() };
            da = 1.0f32 - gauss32(n(a), 0.0, 1.0, 0.005);
            db = 1.0f32 - gauss32(n(b), 0.0, 1.0, 0.005);
        }
        let pa = self.pen32(a) + da;
        let pb = self.pen32(b) + db;
        // Orca compares the f32 penalties strictly. Penalties closer than TIE_EPS are treated as ties here: our wall
        // coordinates differ from Orca's by up to a micron (angle noise 1e-6 rad), so below that scale Orca's ordering is
        // not reproducible, while a tilted rectangle whose corners tie in Orca (axis-aligned there) would otherwise be
        // decided by a rounding bit (measured: `gk_um2plus_space_filling_cube` seam 500/500 -> 0/500 without it).
        if pa < pb - TIE_EPS { return true; }
        if pb < pa - TIE_EPS { return false; }
        // tie: contours before holes; holes front-left first, contours rear-right first
        if a.hole != b.hole { return !a.hole; }
        let (ay, by, ax, bx) = (a.pos[1], b.pos[1], a.pos[0], b.pos[0]);
        let o = if a.hole { ay.total_cmp(&by).then(ax.total_cmp(&bx)) } else { by.total_cmp(&ay).then(bx.total_cmp(&ax)) };
        o == std::cmp::Ordering::Less
    }

    #[cfg(test)]
    fn cmp_cand(&self, a: &Cand, b: &Cand, preferred: [f32; 2]) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        if self.first_better(a, b, preferred) { Less } else if self.first_better(b, a, preferred) { Greater } else { Equal }
    }

    /// `SeamComparator::is_first_not_much_worse`.
    fn not_much_worse(&self, a: &Cand, b: &Cand) -> bool {
        if (a.oh32 > 0.0 || b.oh32 > 0.0) && (a.oh32 - b.oh32).abs() > 0.1f32 * a.fw32 { return a.oh32 < b.oh32; }
        if self.params.position == SeamPosition::Random { return true; }
        if self.params.position == SeamPosition::Rear { return a.p3[1] + ALIGN_SCORE_TOLERANCE * 5.0f32 > b.p3[1]; }
        let pa = self.pen32(a);
        let pb = self.pen32(b);
        pa <= pb || pa - pb < ALIGN_SCORE_TOLERANCE
    }

    fn pick_all(&mut self) {
        if self.params.position == SeamPosition::Nearest { return; }
        for li in 0..self.layers.len() {
            for pi in 0..self.layers[li].perims.len() {
                if self.params.position == SeamPosition::Random { self.pick_random(li, pi); continue; }
                let (s, e) = (self.layers[li].perims[pi].start, self.layers[li].perims[pi].end);
                let mut best = s;
                for i in s..e {
                    if self.first_better(&self.layers[li].pts[i], &self.layers[li].pts[best], [0.0, 0.0]) { best = i; }
                }
                self.layers[li].perims[pi].seam_index = best;
            }
        }
        if matches!(self.params.position, SeamPosition::Aligned | SeamPosition::AlignedBack | SeamPosition::Rear) { self.align(); }
    }

    fn pick_random(&mut self, li: usize, pi: usize) {
        let (s, e) = (self.layers[li].perims[pi].start, self.layers[li].perims[pi].end);
        let pts = &self.layers[li].pts;
        let seed = pts[s].pos;
        let z = self.slice_z(li) as f32;
        let mut rand = ((seed[0] as f32 * 12.9898 + seed[1] as f32 * 78.233 + z * 133.3333).sin() * 43758.5453).abs();
        rand -= rand.trunc();
        let mut viable_example = s;
        let mut viables: Vec<(usize, f64, P2)> = Vec::new();
        for i in s..e {
            let nxt = if i == e - 1 { s } else { i + 1 };
            let edge = geo::sub(pts[nxt].pos, pts[i].pos);
            let len = geo::norm(edge);
            if self.not_much_worse(&pts[i], &pts[viable_example]) && self.not_much_worse(&pts[viable_example], &pts[i]) {
                viables.push((i, len, edge));
            } else if self.not_much_worse(&pts[viable_example], &pts[i]) {
                // worse, skip
            } else {
                viable_example = i;
                viables.clear();
                viables.push((i, len, edge));
            }
        }
        let sum: f64 = viables.iter().map(|v| v.1).sum();
        let mut picked = sum * rand as f64;
        let mut k = 0;
        while k + 1 < viables.len() && picked - viables[k].1 > 0.0 { picked -= viables[k].1; k += 1; }
        let (idx, len, edge) = viables[k];
        let dir = if len > 0.0 { geo::scale(edge, 1.0 / len) } else { [0.0, 0.0] };
        let final_pos = geo::add(pts[idx].pos, geo::scale(dir, picked));
        let p = &mut self.layers[li].perims[pi];
        p.seam_index = idx;
        p.final_pos = final_pos;
        p.finalized = true;
    }

    /// `find_next_seam_in_layer`: `projected` is a candidate position (object frame, f32).
    fn find_next_seam_in_layer(&self, projected: [f32; 3], layer: usize, max_distance: f32) -> Option<(usize, usize)> {
        let ls = &self.layers[layer];
        let near = ls.kd.nearby(projected, max_distance);
        if near.is_empty() { return None; }
        let sq = |c: &Cand| { let d = [c.p3[0] - projected[0], c.p3[1] - projected[1], c.p3[2] - projected[2]]; d[0] * d[0] + (d[1] * d[1] + d[2] * d[2]) };
        let fin = |i: usize| ls.perims[ls.pts[i].perim].finalized;
        let mut best = near[0];
        let mut nearest = near[0];
        for &i in &near {
            let pt = &ls.pts[i];
            if fin(i) { continue; }
            if self.first_better(pt, &ls.pts[best], [projected[0], projected[1]]) || fin(best) { best = i; }
            if sq(pt) < sq(&ls.pts[nearest]) || fin(nearest) { nearest = i; }
        }
        if fin(nearest) { return None; }
        let np = &ls.pts[nearest];
        let next_seam = &ls.pts[ls.perims[np.perim].seam_index];
        if self.not_much_worse(np, next_seam) { return Some((layer, nearest)); }
        if self.not_much_worse(&ls.pts[best], next_seam) { return Some((layer, best)); }
        None
    }

    fn find_seam_string(&self, start: (usize, usize)) -> Vec<(usize, usize)> {
        let n_layers = self.layers.len() as i64;
        let mut next_layer = start.0 as i64 + 1;
        let mut step = 1i64;
        let mut prev = start;
        let mut string = vec![start];
        let fw = self.layers[start.0].perims[self.layers[start.0].pts[start.1].perim].fw32;
        let max_distance = ALIGN_DIST_FACTOR * fw;
        loop {
            if next_layer < 0 { break; }
            if next_layer >= n_layers {
                step = -1; prev = start; next_layer = start.0 as i64 - 1;
                if next_layer < 0 { break; }
            }
            let pp = self.layers[prev.0].pts[prev.1].p3;
            let projected = [pp[0], pp[1], self.z32[next_layer as usize]];
            match self.find_next_seam_in_layer(projected, next_layer as usize, max_distance) {
                Some(s) => { string.push(s); prev = s; }
                None => {
                    if step == 1 {
                        // Orca: `reverse_lookup_direction()` and then falls through to `next_layer += step`, so the layer
                        // adjacent to the start is SKIPPED when the upward search dies (a quirk that decides which of
                        // two near-equal strings is longer, hence which corner wins)
                        step = -1; prev = start; next_layer = start.0 as i64 - 1;
                        if next_layer < 0 { break; }
                    } else { break; }
                }
            }
            next_layer += step;
        }
        string
    }

    fn align(&mut self) {
        let mut seams: Vec<(usize, usize)> = Vec::new();
        for (li, ls) in self.layers.iter().enumerate() {
            for p in &ls.perims { seams.push((li, p.seam_index)); }
        }
        // stable sort, best first (std::stable_sort with is_first_better)
        {
            let me = &*self;
            stable_sort_by_less(&mut seams, &|a: &(usize, usize), b: &(usize, usize)| me.first_better(&me.layers[a.0].pts[a.1], &me.layers[b.0].pts[b.1], [0.0, 0.0]));
        }
        let sorted = seams;
        let mut gi = 0usize;
        while gi < sorted.len() {
            let (li, si) = sorted[gi];
            gi += 1;
            let pi = self.layers[li].pts[si].perim;
            if self.layers[li].perims[pi].finalized { continue; }
            let mut string = self.find_seam_string((li, si));
            let step_size = 1 + string.len() / 20;
            let mut alt = 0;
            while alt < string.len() {
                let (sl, sp) = string[alt];
                let spi = self.layers[sl].pts[sp].perim;
                let seam_idx = self.layers[sl].perims[spi].seam_index;
                let alt_string = self.find_seam_string((sl, seam_idx));
                if alt_string.len() > string.len() { string = alt_string; }
                alt += step_size;
            }
            if string.len() < ALIGN_MIN_STRING { continue; }
            string.sort_by_key(|s| s.0);
            gi -= 1; // repeat this seam: it is finalized now

            let mut obs: Vec<P2> = Vec::new(); let mut zs: Vec<f64> = Vec::new(); let mut ws: Vec<f64> = Vec::new();
            let mut total_len = 0.0f64;
            let mut last = self.layers[string[0].0].pts[string[0].1].pos;
            for (k, &(l, p)) in string.iter().enumerate() {
                let cur = &self.layers[l].pts[p];
                let mut layer_angle = 0.0;
                if k > 0 && k + 1 < string.len() {
                    let pa = self.layers[string[k - 1].0].pts[string[k - 1].1].pos;
                    let pb = self.layers[string[k + 1].0].pts[string[k + 1].1].pos;
                    let v1 = [cur.pos[0] - pa[0], cur.pos[1] - pa[1], self.z[l] - self.z[string[k - 1].0]];
                    let v2 = [pb[0] - cur.pos[0], pb[1] - cur.pos[1], self.z[string[k + 1].0] - self.z[l]];
                    let n1 = (v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]).sqrt();
                    let n2 = (v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]).sqrt();
                    if n1 > 0.0 && n2 > 0.0 {
                        let d = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2);
                        layer_angle = d.clamp(-1.0, 1.0).acos().abs();
                    }
                }
                obs.push(cur.pos);
                zs.push(self.z[l]);
                ws.push(1.0 / (0.1 + angle_penalty(cur.angle)));
                let curling = if layer_angle > 2.0 * cur.angle.abs() { -0.8 } else { 1.0 };
                total_len += curling * geo::dist(last, cur.pos);
                last = cur.pos;
            }
            if self.params.position == SeamPosition::Rear { total_len *= 0.3; }
            let nseg = ((total_len.max(0.0) / ALIGN_MM_PER_SEGMENT) as usize).max(1).min(obs.len().max(1));
            let curve = fit_cubic_bspline(&obs, &zs, &ws, nseg);
            for (k, &(l, p)) in string.iter().enumerate() {
                let cur = self.layers[l].pts[p].clone();
                let t = (cur.angle.abs() / SHARP_ANGLE_SNAP).powi(3).min(1.0);
                let fitted = curve.value(zs[k]);
                let fin = [t * cur.pos[0] + (1.0 - t) * fitted[0], t * cur.pos[1] + (1.0 - t) * fitted[1]];
                let pi = cur.perim;
                let pr = &mut self.layers[l].perims[pi];
                pr.seam_index = p;
                pr.final_pos = fin;
                pr.finalized = true;
            }
        }
    }

    /// Which external perimeter of `layer` is nearest to `p`.
    fn closest_perimeter(&self, layer: usize, p: P2) -> Option<usize> {
        let ls = self.layers.get(layer)?;
        let mut best: Option<(usize, f64)> = None;
        for (i, c) in ls.pts.iter().enumerate() {
            let d = geo::dist(c.pos, p);
            if best.map_or(true, |b| d < b.1) { best = Some((i, d)); }
        }
        best.map(|b| ls.pts[b.0].perim)
    }

    /// Seam position (in print coordinates) for `stroke` on `layer`, following `GCode::extrude_loop` +
    /// `SeamPlacer::place_seam`. Returns (seam point, unsupported distance at the seam candidate).
    pub fn place(&self, layer: usize, stroke: &Stroke, last_pos: P2) -> Option<(P2, f64)> {
        let ls = self.layers.get(layer)?;
        if ls.pts.is_empty() { return None; }
        // closest perimeter to the loop (use the loop's start; Orca repeats until two consecutive points agree)
        let mut perim = self.closest_perimeter(layer, stroke.pts[0])?;
        if stroke.pts.len() > 1 {
            let p2 = self.closest_perimeter(layer, stroke.pts[1])?;
            if p2 != perim { perim = p2; }
        }
        let pr = &ls.perims[perim];
        let (seam_pos, seam_index) = if pr.finalized {
            (pr.final_pos, pr.seam_index)
        } else {
            let idx = if self.params.position == SeamPosition::Nearest {
                let off = super::visibility::FRAME_OFFSET;
                let pref = [(last_pos[0] - off[0]) as f32, (last_pos[1] - off[1]) as f32];
                let mut best = pr.start;
                for i in pr.start..pr.end { if self.first_better(&ls.pts[i], &ls.pts[best], pref) { best = i; } }
                best
            } else { pr.seam_index };
            (ls.pts[idx].pos, idx)
        };
        let cand = &ls.pts[seam_index];
        let overhang = cand.unsupported;
        let is_external = stroke.feat.iter().any(|f| *f == Feature::OuterWall);
        if is_external { return Some((seam_pos, overhang)); }
        // inner loop: project the outer seam onto this loop (depth-aware, concave-corner branch)
        let (seg, t, depth0) = geo::closest_on_ring(&stroke.pts, seam_pos);
        let mut foot = geo::lerp(stroke.pts[seg], stroke.pts[(seg + 1) % stroke.pts.len()], t);
        let beta = (cand.angle / 2.0).cos();
        let n = pr.end - pr.start;
        let rel = seam_index - pr.start;
        let prev = ls.pts[pr.start + (rel + n - 1) % n].pos;
        let next = ls.pts[pr.start + (rel + 1) % n].pos;
        if geo::dist(seam_pos, cand.pos) * geo::dist(seam_pos, cand.pos) < depth0 && cand.angle < -1e-6 {
            let norm = |v: P2| { let l = geo::norm(v); if l > 0.0 { geo::scale(v, 1.0 / l) } else { v } };
            let dir_mid = geo::scale(geo::add(norm(geo::sub(cand.pos, prev)), norm(geo::sub(cand.pos, next))), 0.5);
            let depth = 1.4142 * depth0 / beta;
            let fin = geo::add(cand.pos, geo::scale(dir_mid, depth));
            let (s2, t2, _) = geo::closest_on_ring(&stroke.pts, fin);
            foot = geo::lerp(stroke.pts[s2], stroke.pts[(s2 + 1) % stroke.pts.len()], t2);
        }
        Some((foot, overhang))
    }
}

// ---- cubic B-spline least squares ---------------------------------------------------------------------------

pub struct BSplineFit { start: f64, seg: f64, coef: Vec<P2> }

fn bspline_kernel(x: f64) -> f64 {
    let x = x.abs();
    if x >= 2.0 { 0.0 }
    else if x <= 1.0 { 4.0 / 6.0 - x * x + 0.5 * x * x * x }
    else { let y = x - 1.0; 1.0 / 6.0 - 0.5 * y + 0.5 * y * y - y * y * y / 6.0 }
}

pub fn fit_cubic_bspline(obs: &[P2], pts: &[f64], weights: &[f64], segments: usize) -> BSplineFit {
    let n = obs.len();
    let params = segments + 1;
    let valid = pts[n - 1] - pts[0];
    let seg = if segments > 0 && valid > 0.0 { valid / segments as f64 } else { 1.0 };
    let start = pts[0];
    // normal equations of the weighted least squares
    let mut ata = vec![vec![0.0f64; params]; params];
    let mut atb = vec![[0.0f64; 2]; params];
    for i in 0..n {
        let sw = weights[i].sqrt();
        let mut row = vec![0.0f64; params];
        let mid_right = ((pts[i] - start) / seg).floor() as i64;
        let first = mid_right - 2 + 1;
        for s in first..first + 4 {
            let seg_start = start + s as f64 * seg;
            let nd = (seg_start - pts[i]) / seg;
            let pi = s.clamp(0, params as i64 - 1) as usize;
            row[pi] += bspline_kernel(nd) * sw;
        }
        for a in 0..params {
            if row[a] == 0.0 { continue; }
            for b in 0..params { ata[a][b] += row[a] * row[b]; }
            atb[a][0] += row[a] * obs[i][0] * sw;
            atb[a][1] += row[a] * obs[i][1] * sw;
        }
    }
    for a in 0..params { ata[a][a] += 1e-9; }
    // gaussian elimination with partial pivoting
    let mut m = ata;
    let mut r = atb;
    for c in 0..params {
        let mut piv = c;
        for rr in c + 1..params { if m[rr][c].abs() > m[piv][c].abs() { piv = rr; } }
        m.swap(c, piv); r.swap(c, piv);
        let d = m[c][c];
        if d.abs() < 1e-14 { continue; }
        for rr in c + 1..params {
            let f = m[rr][c] / d;
            if f == 0.0 { continue; }
            for k in c..params { m[rr][k] -= f * m[c][k]; }
            r[rr][0] -= f * r[c][0]; r[rr][1] -= f * r[c][1];
        }
    }
    let mut coef = vec![[0.0f64; 2]; params];
    for c in (0..params).rev() {
        let mut v = r[c];
        for k in c + 1..params { v[0] -= m[c][k] * coef[k][0]; v[1] -= m[c][k] * coef[k][1]; }
        let d = m[c][c];
        coef[c] = if d.abs() < 1e-14 { [0.0, 0.0] } else { [v[0] / d, v[1] / d] };
    }
    BSplineFit { start, seg, coef }
}

impl BSplineFit {
    pub fn value(&self, z: f64) -> P2 {
        let params = self.coef.len() as i64;
        let mid_right = ((z - self.start) / self.seg).floor() as i64;
        let first = mid_right - 2 + 1;
        let mut out = [0.0, 0.0];
        for s in first..first + 4 {
            let seg_start = self.start + s as f64 * self.seg;
            let nd = (seg_start - z) / self.seg;
            let pi = s.clamp(0, params - 1) as usize;
            let k = bspline_kernel(nd);
            out[0] += k * self.coef[pi][0];
            out[1] += k * self.coef[pi][1];
        }
        out
    }
}

// ---- applying a seam to a stroke -------------------------------------------------------------------------------

/// Rotate a closed `stroke` so it starts at `p` (inserting a vertex when `p` is not within `eps` of an existing
/// vertex), then return it as an OPEN stroke that returns to the start (first vertex repeated at the end).
pub fn split_loop_at(stroke: &Stroke, p: P2, eps: f64) -> Stroke {
    let n = stroke.pts.len();
    // vertex hit?
    let mut hit = None;
    for i in 0..n { if geo::dist(stroke.pts[i], p) <= eps { hit = Some(i); break; } }
    let (pts, w, feat): (Vec<P2>, Vec<f64>, Vec<Feature>) = if let Some(k) = hit {
        let pts: Vec<P2> = (0..=n).map(|j| stroke.pts[(k + j) % n]).collect();
        let w: Vec<f64> = (0..n).map(|j| stroke.w[(k + j) % n]).collect();
        let f: Vec<Feature> = (0..n).map(|j| stroke.feat[(k + j) % n]).collect();
        (pts, w, f)
    } else {
        let (seg, t, _) = geo::closest_on_ring(&stroke.pts, p);
        let a = stroke.pts[seg]; let b = stroke.pts[(seg + 1) % n];
        let q = geo::lerp(a, b, t);
        // new loop: q, pts[seg+1] ... pts[seg], q
        let mut pts = vec![q];
        let mut w = vec![stroke.w[seg]];
        let mut f = vec![stroke.feat[seg]];
        for j in 1..=n {
            let idx = (seg + j) % n;
            pts.push(stroke.pts[idx]);
            if j < n { w.push(stroke.w[idx]); f.push(stroke.feat[idx]); }
        }
        // the last piece goes from pts[seg] to q, with segment seg's attributes
        w.push(stroke.w[seg]); f.push(stroke.feat[seg]);
        pts.push(q);
        (pts, w, f)
    };
    Stroke { pts, w, feat, h: stroke.h, speed: stroke.speed, flow_ratio: stroke.flow_ratio, closed: false }
}

/// `ExtrusionLoop::clip_end(distance)`: shorten an open stroke by `distance` from its end.
pub fn clip_end(stroke: &mut Stroke, distance: f64) {
    if distance <= 0.0 { return; }
    let mut remaining = distance;
    while stroke.pts.len() >= 2 && remaining > 0.0 {
        let n = stroke.pts.len();
        let l = geo::dist(stroke.pts[n - 2], stroke.pts[n - 1]);
        if l <= remaining + 1e-12 {
            remaining -= l;
            stroke.pts.pop(); stroke.w.pop(); stroke.feat.pop();
        } else {
            let t = (l - remaining) / l;
            stroke.pts[n - 1] = geo::lerp(stroke.pts[n - 2], stroke.pts[n - 1], t);
            remaining = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: f64, y0: f64, s: f64) -> Vec<P2> { vec![[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]] }

    #[test]
    fn penalty_prefers_corners() {
        assert!(angle_penalty(std::f64::consts::FRAC_PI_2) < angle_penalty(0.0));
        assert!(angle_penalty(-std::f64::consts::FRAC_PI_2) < angle_penalty(std::f64::consts::FRAC_PI_2));
    }

    #[test]
    fn cube_aligned_seam_is_rear_right_corner_on_every_layer() {
        let n = 20;
        let specs: Vec<Vec<LoopSpec>> = (0..n).map(|_| vec![LoopSpec { ring: square(128.46, 118.21, 19.58), width: 0.42, is_hole: false }]).collect();
        let z: Vec<f64> = (0..n).map(|i| 0.2 * (i + 1) as f64).collect();
        let h = vec![0.2; n];
        let sp = SeamPlanner::new(&specs, &z, &h, SeamParams { position: SeamPosition::Aligned, nozzle: 0.4, staggered_inner: false });
        for li in 0..n {
            let st = Stroke { pts: square(128.46, 118.21, 19.58), w: vec![0.42; 4], feat: vec![Feature::OuterWall; 4], h: 0.2, speed: 0.0, flow_ratio: 1.0, closed: true };
            let (p, _) = sp.place(li, &st, [0.0, 0.0]).unwrap();
            assert!((p[0] - 148.04).abs() < 1e-3 && (p[1] - 137.79).abs() < 1e-3, "layer {} seam at {:?}", li, p);
        }
    }

    fn circle(cx: f64, cy: f64, r: f64, n: usize, ccw: bool) -> Vec<P2> {
        (0..n).map(|k| { let a = std::f64::consts::TAU * k as f64 / n as f64 * if ccw { 1.0 } else { -1.0 }; [cx + r * a.cos(), cy + r * a.sin()] }).collect()
    }

    /// Regression: the `align()` sort panicked ("comparison function does not correctly implement a total order") on
    /// parts whose candidates tie on penalty across contours and holes (smooth revolved solids, `ipadstand`).
    #[test]
    fn align_sort_total_order_no_panic_with_ties_between_contours_and_holes() {
        for position in [SeamPosition::Aligned, SeamPosition::AlignedBack, SeamPosition::Rear] {
            let n = 60;
            let specs: Vec<Vec<LoopSpec>> = (0..n).map(|l| {
                let shift = if l % 7 == 3 { 0.9 } else { 0.0 }; // overhang on some layers
                vec![
                    LoopSpec { ring: circle(100.0 + shift, 100.0, 15.0, 90, true), width: 0.42, is_hole: false },
                    LoopSpec { ring: circle(100.0, 100.0, 6.0 + shift, 90, false), width: 0.42, is_hole: true },
                    LoopSpec { ring: circle(140.0, 100.0 + shift, 5.0, 90, true), width: 0.42, is_hole: false },
                    LoopSpec { ring: square(60.0, 60.0 + shift, 10.0), width: 0.42, is_hole: false },
                ]
            }).collect();
            let z: Vec<f64> = (0..n).map(|i| 0.2 * (i + 1) as f64).collect();
            let h = vec![0.2; n];
            let sp = SeamPlanner::new(&specs, &z, &h, SeamParams { position, nozzle: 0.4, staggered_inner: false });
            let st = Stroke { pts: circle(100.0, 100.0, 15.0, 90, true), w: vec![0.42; 90], feat: vec![Feature::OuterWall; 90], h: 0.2, speed: 0.0, flow_ratio: 1.0, closed: true };
            assert!(sp.place(10, &st, [0.0, 0.0]).is_some());
        }
    }

    /// The candidate order is a strict total order: antisymmetric and transitive on a mixed bag of candidates.
    #[test]
    fn candidate_order_is_transitive() {
        let mk = |x: f64, y: f64, angle: f64, overhang: f64, hole: bool| Cand { pos: [x, y], p3: [x as f32, y as f32, 0.0], angle, ang32: angle as f32, overhang, oh32: overhang as f32, unsupported: 0.0, vis32: 0.0, perim: 0, hole, fw32: 0.42 };
        let mut v = Vec::new();
        let mut seed = 12345u64;
        let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((seed >> 33) as f64) / (1u64 << 31) as f64 };
        for _ in 0..60 {
            let ang = [0.0, 0.5, -0.5, 1.5707963267948966][(rnd() * 4.0) as usize % 4];
            let oh = if rnd() < 0.3 { [0.1, 0.2][(rnd() * 2.0) as usize % 2] } else { 0.0 };
            v.push(mk((rnd() * 4.0).floor(), (rnd() * 4.0).floor(), ang, oh, rnd() < 0.5));
        }
        let sp = SeamPlanner { layers: vec![], z: vec![], h: vec![], z32: vec![], params: SeamParams { position: SeamPosition::Aligned, nozzle: 0.4, staggered_inner: false } };
        use std::cmp::Ordering::*;
        for a in &v { for b in &v {
            let ab = sp.cmp_cand(a, b, [0.0, 0.0]); let ba = sp.cmp_cand(b, a, [0.0, 0.0]);
            assert_eq!(ab, ba.reverse());
            for c in &v {
                if ab != Greater && sp.cmp_cand(b, c, [0.0, 0.0]) != Greater { assert!(sp.cmp_cand(a, c, [0.0, 0.0]) != Greater); }
            }
        } }
    }

    #[test]
    fn stable_sort_keeps_the_order_of_equal_elements() {
        let mut v: Vec<(u32, u32)> = (0..40).map(|i| ((i * 7 + 3) % 5, i)).collect();
        stable_sort_by_less(&mut v, &|a: &(u32, u32), b: &(u32, u32)| a.0 < b.0);
        for w in v.windows(2) { assert!(w[0].0 < w[1].0 || (w[0].0 == w[1].0 && w[0].1 < w[1].1), "{:?}", w); }
    }

    /// Orca's polygon repeats the first point at the end and floors the closing "length" at 0.1 mm; on a square every
    /// vertex (also the repeated one) has a 90 degree angle. On a 0.38 mm rib (narrower than the 0.4 mm arm) the first
    /// vertex sees the far corners (near 180 degrees) while the second reaches the repeated first point, because the
    /// phantom 0.1 mm closing length makes 0.38 + 0.1 exceed the arm: 90 degrees.
    #[test]
    fn polygon_angles_follow_orca_arm_rule() {
        let sq: Vec<[i64; 2]> = vec![[0, 0], [10_000_000, 0], [10_000_000, 10_000_000], [0, 10_000_000], [0, 0]];
        let len: Vec<f32> = vec![10.0, 10.0, 10.0, 10.0, 0.1];
        for a in polygon_angles(&sq, &len, 0.4) { assert!((a - std::f32::consts::FRAC_PI_2).abs() < 1e-6, "{}", a); }
        let rib: Vec<[i64; 2]> = vec![[0, 0], [380_000, 0], [380_000, 90_000_000], [0, 90_000_000], [0, 0]];
        let len: Vec<f32> = vec![0.38, 90.0, 0.38, 90.0, 0.1];
        let a = polygon_angles(&rib, &len, 0.4);
        assert!(a[0] > 3.0 && (a[1] - std::f32::consts::FRAC_PI_2).abs() < 1e-6, "{:?}", a);
    }

    #[test]
    fn orca_like_start_rect_and_circle() {
        // rectangle: starts at the rear-right corner (the vertex after the lowest-rightmost one), CCW
        let r = orca_like_start(&[[0.0, 0.0], [10.0, 0.0], [10.0, 20.0], [0.0, 20.0]]);
        assert_eq!(r[0], [10.0, 20.0]);
        assert_eq!(r.len(), 4);
        let r = orca_like_start(&[[0.0, 20.0], [10.0, 20.0], [10.0, 0.0], [0.0, 0.0]]); // clockwise input
        assert_eq!(r[0], [10.0, 20.0]);
        // 16-gon: a vertex is inserted on the edge after the lowest vertex
        let c: Vec<P2> = (0..16).map(|k| { let a = std::f64::consts::TAU * k as f64 / 16.0; [5.0 * a.cos(), 5.0 * a.sin()] }).collect();
        let r = orca_like_start(&c);
        assert_eq!(r.len(), 17);
        let low = c.iter().cloned().fold([0.0, 1e9], |m, p| if p[1] < m[1] - 1e-9 { p } else { m });
        let d = geo::dist(r[0], low);
        let edge = 2.0 * 5.0 * (std::f64::consts::PI / 16.0).sin();
        assert!((d / edge - START_FRACTION).abs() < 1e-9, "{} {}", d, edge);
    }

    /// A column of identical loops: the seam string must align them all on one vertex (wall positions identical).
    #[test]
    fn column_of_circles_aligns_on_one_vertex() {
        let n = 30;
        let specs: Vec<Vec<LoopSpec>> = (0..n).map(|_| vec![LoopSpec { ring: circle(100.0, 100.0, 3.0, 24, true), width: 0.42, is_hole: false }]).collect();
        let z: Vec<f64> = (0..n).map(|i| 0.2 * (i + 1) as f64).collect();
        let h = vec![0.2; n];
        let sp = SeamPlanner::new(&specs, &z, &h, SeamParams { position: SeamPosition::Aligned, nozzle: 0.4, staggered_inner: false });
        let st = Stroke { pts: circle(100.0, 100.0, 3.0, 24, true), w: vec![0.42; 24], feat: vec![Feature::OuterWall; 24], h: 0.2, speed: 0.0, flow_ratio: 1.0, closed: true };
        let p0 = sp.place(0, &st, [0.0, 0.0]).unwrap().0;
        for li in 1..n { let p = sp.place(li, &st, [0.0, 0.0]).unwrap().0; assert!(geo::dist(p, p0) < 0.05, "layer {} {:?} vs {:?}", li, p, p0); }
    }

    #[test]
    fn split_and_clip() {
        let st = Stroke { pts: square(0.0, 0.0, 10.0), w: vec![0.4; 4], feat: vec![Feature::OuterWall; 4], h: 0.2, speed: 0.0, flow_ratio: 1.0, closed: true };
        let mut o = split_loop_at(&st, [10.0, 10.0], 0.0015);
        assert_eq!(o.pts.len(), 5);
        assert_eq!(o.pts[0], [10.0, 10.0]);
        assert_eq!(o.pts[4], [10.0, 10.0]);
        clip_end(&mut o, 0.04);
        assert!((o.pts[4][0] - 10.0).abs() < 1e-9 && (o.pts[4][1] - 9.96).abs() < 1e-9, "{:?}", o.pts[4]);
        // insert a vertex mid-edge
        let o2 = split_loop_at(&st, [5.0, 0.0], 0.0015);
        assert_eq!(o2.pts.len(), 6);
        assert_eq!(o2.pts[0], [5.0, 0.0]);
        assert_eq!(o2.pts[5], [5.0, 0.0]);
        assert!((o2.length() - 40.0).abs() < 1e-9);
    }

    #[test]
    fn bspline_fit_recovers_line() {
        let obs: Vec<P2> = (0..30).map(|i| [1.0 + 0.1 * i as f64, 5.0]).collect();
        let zs: Vec<f64> = (0..30).map(|i| 0.2 * i as f64).collect();
        let ws = vec![1.0; 30];
        let c = fit_cubic_bspline(&obs, &zs, &ws, 3);
        for i in 0..30 { let v = c.value(zs[i]); assert!((v[0] - obs[i][0]).abs() < 0.05 && (v[1] - 5.0).abs() < 0.05, "{} {:?}", i, v); }
    }
}
