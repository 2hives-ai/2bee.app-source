//! `FillAdaptive` (adaptive cubic and support cubic infill): an octree, refined around the model surface, whose
//! cube walls are cut by the layer plane into infill lines; lines are then joined with hooks/anchors.
//! libslic3r/Fill/FillAdaptive.cpp. The octree needs the object mesh (and, optionally, the internal bridge
//! areas), so it is built once per object by `AdaptiveOctree::build` and shared by all layers through
//! `InfillCtx::octree`.
use super::gx::{self, P};
use super::Ctx;
use crate::types::Poly;
use std::f64::consts::PI;

const NM: f64 = 1e6;
const EPSILON: f64 = 1e-4;
const EPS_NM: f64 = 100.0;
type IP = [i64; 2];
type V3 = [f64; 3];
pub type Tri = [V3; 3];

const NONE: u32 = u32::MAX;
const CHILD_CENTERS: [[f64; 3]; 8] = [
    [-1., -1., -1.], [1., -1., -1.], [-1., 1., -1.], [1., 1., -1.],
    [-1., -1., 1.], [1., -1., 1.], [-1., 1., 1.], [1., 1., 1.],
];
const CHILD_TRAVERSAL_ORDER: [[usize; 8]; 3] = [[2, 3, 0, 1, 6, 7, 4, 5], [4, 0, 6, 2, 5, 1, 7, 3], [1, 5, 0, 4, 3, 7, 2, 6]];
const DIRECTION_ANGLES: [f64; 3] = [0.0, 2.0 * PI / 3.0, -(2.0 * PI) / 3.0];
const OCTREE_ROT: [f64; 3] = [5.0 * PI / 4.0, 215.264 * PI / 180.0, PI / 6.0];

struct Cube { center: V3, children: [u32; 8] }
#[derive(Clone, Copy, Debug)]
struct CubeProps { edge_length: f64, height: f64, diagonal_length: f64, line_z_distance: f64, line_xy_distance: f64 }

/// Octree of cubes standing on a corner, centres already in object space.
pub struct AdaptiveOctree { cubes: Vec<Cube>, props: Vec<CubeProps> }
impl std::fmt::Debug for AdaptiveOctree { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "AdaptiveOctree({} cubes, {} levels)", self.cubes.len(), self.props.len()) } }

fn mat_mul(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 { for j in 0..3 { for k in 0..3 { r[i][j] += a[i][k] * b[k][j]; } } }
    r
}
fn rx(a: f64) -> [[f64; 3]; 3] { let (s, c) = (a.sin(), a.cos()); [[1., 0., 0.], [0., c, -s], [0., s, c]] }
fn ry(a: f64) -> [[f64; 3]; 3] { let (s, c) = (a.sin(), a.cos()); [[c, 0., s], [0., 1., 0.], [-s, 0., c]] }
fn rz(a: f64) -> [[f64; 3]; 3] { let (s, c) = (a.sin(), a.cos()); [[c, -s, 0.], [s, c, 0.], [0., 0., 1.]] }
fn apply(m: &[[f64; 3]; 3], v: V3) -> V3 { [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]] }
/// Rz(oct[2]) * Ry(oct[1]) * Rx(oct[0])
fn to_world() -> [[f64; 3]; 3] { mat_mul(rz(OCTREE_ROT[2]), mat_mul(ry(OCTREE_ROT[1]), rx(OCTREE_ROT[0]))) }
/// Rx(-oct[0]) * Ry(-oct[1]) * Rz(-oct[2])
fn to_octree() -> [[f64; 3]; 3] { mat_mul(rx(-OCTREE_ROT[0]), mat_mul(ry(-OCTREE_ROT[1]), rz(-OCTREE_ROT[2]))) }

fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn vabs(a: V3) -> V3 { [a[0].abs(), a[1].abs(), a[2].abs()] }

/// `triangle_AABB_intersects` (separating axis test).
fn triangle_aabb_intersects(a: V3, b: V3, c: V3, bmin: V3, bmax: V3) -> bool {
    for k in 0..3 {
        let (tmin, tmax) = (a[k].min(b[k]).min(c[k]), a[k].max(b[k]).max(c[k]));
        if tmin >= bmax[k] || tmax <= bmin[k] { return false; }
    }
    let center = [(bmin[0] + bmax[0]) * 0.5, (bmin[1] + bmax[1]) * 0.5, (bmin[2] + bmax[2]) * 0.5];
    let h = sub(bmax, center);
    let t = [sub(b, a), sub(c, a), sub(c, b)];
    let ac = sub(a, center);
    let n = cross(t[0], t[1]);
    let s = dot(n, ac);
    let mut r = dot(h, vabs(n)).abs();
    if s.abs() >= r { return false; }
    let at = [vabs(t[0]), vabs(t[1]), vabs(t[2])];
    let bc = sub(b, center);
    let cc = sub(c, center);
    let test = |d1: f64, d2: f64, rr: f64| -> bool { let tc = (d1 + d2) * 0.5; rr + (tc - d1).abs() < tc.abs() };
    // eX x t[i]
    let ex = |tt: V3, p: V3, q: V3| (tt[1] * p[2] - tt[2] * p[1], tt[1] * q[2] - tt[2] * q[1]);
    let ey = |tt: V3, p: V3, q: V3| (tt[2] * p[0] - tt[0] * p[2], tt[2] * q[0] - tt[0] * q[2]);
    let ez = |tt: V3, p: V3, q: V3| (tt[0] * p[1] - tt[1] * p[0], tt[0] * q[1] - tt[1] * q[0]);
    let q_of = [cc, bc, bc];
    for i in 0..3 {
        let (d1, d2) = ex(t[i], ac, q_of[i]);
        r = (h[1] * at[i][2] + h[2] * at[i][1]).abs();
        if test(d1, d2, r) { return false; }
    }
    for i in 0..3 {
        let (d1, d2) = ey(t[i], ac, q_of[i]);
        r = (h[0] * at[i][2] + h[2] * at[i][0]).abs();
        if test(d1, d2, r) { return false; }
    }
    for i in 0..3 {
        let (d1, d2) = ez(t[i], ac, q_of[i]);
        r = (h[1] * at[i][0] + h[0] * at[i][1]).abs();
        if test(d1, d2, r) { return false; }
    }
    true
}

fn make_cubes_properties(max_edge: f64, line_spacing: f64) -> Vec<CubeProps> {
    let max_edge = max_edge + EPSILON;
    let mut v = Vec::new();
    let mut e = line_spacing * 2.0;
    loop {
        v.push(CubeProps { edge_length: e, height: e * 3f64.sqrt(), diagonal_length: e * 2f64.sqrt(), line_z_distance: e / 3f64.sqrt(), line_xy_distance: e / 6f64.sqrt() });
        if e > max_edge { break; }
        e *= 2.0;
    }
    if v.len() == 1 {
        let mut p = v[0];
        p.edge_length *= 2.0;
        p.height = p.edge_length * 3f64.sqrt();
        p.diagonal_length = p.edge_length * 2f64.sqrt();
        p.line_z_distance = p.edge_length / 3f64.sqrt();
        p.line_xy_distance = p.edge_length / 6f64.sqrt();
        v.push(p);
    }
    v
}

impl AdaptiveOctree {
    /// `adaptive_fill_line_spacing` for one region: `extrusion_width / (density * 1/3) * multiline`.
    pub fn line_spacing(density: f64, extrusion_width: f64, multiline: usize) -> f64 { extrusion_width / (density * 0.333333333) * multiline as f64 }

    /// `build_octree`. `triangles` are the object mesh facets in object space (XY centred on the object origin,
    /// z from the bed); `overhangs` are internal-bridge triangles in the same space (e.g. from `triangulate`).
    /// `support_overhangs_only` selects the support-cubic variant (only upward-facing overhang triangles).
    pub fn build(triangles: &[Tri], overhangs: &[Tri], line_spacing: f64, support_overhangs_only: bool) -> AdaptiveOctree {
        let to_oct = to_octree();
        let rot = |t: &Tri| -> Tri { [apply(&to_oct, t[0]), apply(&to_oct, t[1]), apply(&to_oct, t[2])] };
        let tris: Vec<Tri> = triangles.iter().map(rot).collect();
        let ovh: Vec<Tri> = overhangs.iter().map(rot).collect();
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for t in &tris { for p in t { for k in 0..3 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } } }
        if !lo[0].is_finite() { return AdaptiveOctree { cubes: Vec::new(), props: Vec::new() }; }
        // float32 bounding box as in the original
        let center = [((lo[0] as f32 + hi[0] as f32) * 0.5) as f64, ((lo[1] as f32 + hi[1] as f32) * 0.5) as f64, ((lo[2] as f32 + hi[2] as f32) * 0.5) as f64];
        let size = (hi[0] - lo[0]).max(hi[1] - lo[1]).max(hi[2] - lo[2]);
        let props = make_cubes_properties(size, line_spacing);
        let mut oct = AdaptiveOctree { cubes: vec![Cube { center, children: [NONE; 8] }], props };
        if oct.props.len() > 1 {
            let half = 0.5 * oct.props.last().unwrap().edge_length;
            let max_depth = oct.props.len() as i32 - 1;
            let up = apply(&to_oct, [0.0, 0.0, 1.0]);
            let process = |oct: &mut AdaptiveOctree, a: V3, b: V3, c: V3| {
                let bmin = [center[0] - half, center[1] - half, center[2] - half];
                let bmax = [center[0] + half, center[1] + half, center[2] + half];
                oct.insert_triangle(a, b, c, 0, bmin, bmax, max_depth);
            };
            for t in &tris {
                let ok = if support_overhangs_only {
                    let n = cross(sub(t[1], t[0]), sub(t[2], t[1]));
                    dot(n, up) > 0.707 * dot(n, n).sqrt()
                } else { true };
                if ok { process(&mut oct, t[0], t[1], t[2]); }
            }
            for t in &ovh { process(&mut oct, t[0], t[1], t[2]); }
            let w = to_world();
            for c in oct.cubes.iter_mut() { c.center = apply(&w, c.center); }
        }
        oct
    }

    fn insert_triangle(&mut self, a: V3, b: V3, c: V3, cur: usize, cur_min: V3, cur_max: V3, depth: i32) {
        let depth = depth - 1;
        for i in 0..8 {
            let dir = CHILD_CENTERS[i];
            let cc = self.cubes[cur].center;
            let (mut bmin, mut bmax) = ([0.0; 3], [0.0; 3]);
            for k in 0..3 {
                if dir[k] == -1.0 { bmin[k] = cur_min[k]; bmax[k] = cc[k] + EPSILON; } else { bmin[k] = cc[k] - EPSILON; bmax[k] = cur_max[k]; }
            }
            let e = self.props[depth as usize].edge_length / 2.0;
            let child_center = [cc[0] + dir[0] * e, cc[1] + dir[1] * e, cc[2] + dir[2] * e];
            if triangle_aabb_intersects(a, b, c, bmin, bmax) {
                if self.cubes[cur].children[i] == NONE {
                    self.cubes.push(Cube { center: child_center, children: [NONE; 8] });
                    let id = (self.cubes.len() - 1) as u32;
                    self.cubes[cur].children[i] = id;
                }
                if depth > 0 { let ch = self.cubes[cur].children[i] as usize; self.insert_triangle(a, b, c, ch, bmin, bmax, depth); }
            }
        }
    }
}

/// Ear-clipping triangulation of an ExPolygon lifted to height `z` (for `AdaptiveOctree::build` overhang input).
pub fn triangulate_at(region: &Poly, z: f64) -> Vec<Tri> {
    // bridge each hole into the contour (rightmost vertex), then ear-clip the resulting simple polygon
    let mut ring: Vec<P> = region.contour.clone();
    if gx::ring_area(&ring) < 0.0 { ring.reverse(); }
    let mut holes: Vec<Vec<P>> = region.holes.iter().map(|h| { let mut h = h.clone(); if gx::ring_area(&h) > 0.0 { h.reverse(); } h }).collect();
    holes.sort_by(|a, b| { let ma = a.iter().map(|p| p[0]).fold(f64::MIN, f64::max); let mb = b.iter().map(|p| p[0]).fold(f64::MIN, f64::max); mb.partial_cmp(&ma).unwrap() });
    for h in holes {
        let (hi, hp) = h.iter().enumerate().max_by(|a, b| a.1[0].partial_cmp(&b.1[0]).unwrap()).map(|(i, p)| (i, *p)).unwrap();
        // closest ring vertex that is visible: pick the nearest vertex (adequate for infill octree purposes)
        let (ri, _) = ring.iter().enumerate().min_by(|a, b| gx::dist(*a.1, hp).partial_cmp(&gx::dist(*b.1, hp)).unwrap()).unwrap();
        let mut nr: Vec<P> = ring[..=ri].to_vec();
        for k in 0..=h.len() { nr.push(h[(hi + k) % h.len()]); }
        nr.push(ring[ri]);
        nr.extend_from_slice(&ring[ri + 1..]);
        ring = nr;
    }
    let n = ring.len();
    let mut idx: Vec<usize> = (0..n).collect();
    let mut out = Vec::new();
    let cross2 = |a: P, b: P, c: P| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let mut guard = 0;
    while idx.len() > 3 && guard < 10 * n * n + 10 {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let (ia, ib, ic) = (idx[(i + m - 1) % m], idx[i], idx[(i + 1) % m]);
            let (a, b, c) = (ring[ia], ring[ib], ring[ic]);
            if cross2(a, b, c) <= 1e-12 { continue; }
            let mut ear = true;
            for &j in &idx {
                if j == ia || j == ib || j == ic { continue; }
                let p = ring[j];
                if p == a || p == b || p == c { continue; }
                let (d1, d2, d3) = (cross2(a, b, p), cross2(b, c, p), cross2(c, a, p));
                if d1 >= 0.0 && d2 >= 0.0 && d3 >= 0.0 { ear = false; break; }
            }
            if ear {
                out.push([[a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z]]);
                idx.remove(i);
                clipped = true;
                break;
            }
        }
        if !clipped { idx.remove(0); }
    }
    if idx.len() == 3 {
        let (a, b, c) = (ring[idx[0]], ring[idx[1]], ring[idx[2]]);
        if cross2(a, b, c).abs() > 1e-12 { out.push([[a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z]]); }
    }
    out
}

// ------------------------------------------------------------------------- line generation
struct FillCtx<'a> {
    props: &'a [CubeProps],
    z: f64,
    order: [usize; 8],
    cos_a: f64,
    sin_a: f64,
    temp_lines: Vec<(IP, IP)>,
    output: Vec<(IP, IP)>,
}
const UNUSED: i64 = i64::MAX;

fn new_scale(p: [f64; 2]) -> IP { [(p[0] * NM).round() as i64, (p[1] * NM).round() as i64] }

fn gen_lines(ctx: &mut FillCtx, oct: &AdaptiveOctree, cube: usize, mut address: usize, mut depth: i32) {
    let props = ctx.props;
    let c = &oct.cubes[cube];
    let z_diff = ctx.z - c.center[2];
    let z_diff_abs = z_diff.abs();
    let pr = props[depth as usize];
    if z_diff_abs > pr.height / 2.0 { return; }
    if z_diff_abs < pr.line_z_distance {
        let zdist = pr.line_z_distance;
        let mut from = [0.5 * pr.diagonal_length * (zdist - z_diff_abs) / zdist, pr.line_xy_distance - (zdist + z_diff) / 2f64.sqrt()];
        let mut to = [-from[0], from[1]];
        let rotate = |v: [f64; 2]| [ctx.cos_a * v[0] - ctx.sin_a * v[1], ctx.sin_a * v[0] + ctx.cos_a * v[1]];
        from = rotate(from);
        to = rotate(to);
        from = [from[0] + c.center[0], from[1] + c.center[1]];
        to = [to[0] + c.center[0], to[1] + c.center[1]];
        let new_a = new_scale(from);
        let new_b = new_scale(to);
        let last = &mut ctx.temp_lines[address];
        if last.0[0] == UNUSED {
            last.0 = new_a;
        } else if (new_a[0] - last.1[0]).abs().max((new_a[1] - last.1[1]).abs()) > 1000 {
            let done = *last;
            ctx.output.push(done);
            ctx.temp_lines[address].0 = new_a;
        }
        ctx.temp_lines[address].1 = new_b;
    }
    address = address * 2 + 1;
    depth -= 1;
    let mut i = 0;
    for ci in ctx.order {
        let ch = c.children[ci];
        if ch != NONE && depth >= 0 { gen_lines(ctx, oct, ch as usize, address, depth); }
        i += 1;
        if i == 4 { address += 1; }
    }
}

// ------------------------------------------------------------------------- hooks
fn vec_of(l: &(IP, IP)) -> [f64; 2] { [(l.1[0] - l.0[0]) as f64, (l.1[1] - l.0[1]) as f64] }
fn norm2(v: [f64; 2]) -> f64 { (v[0] * v[0] + v[1] * v[1]).sqrt() }
fn normalized(v: [f64; 2]) -> [f64; 2] { let l = norm2(v); if l == 0.0 { v } else { [v[0] / l, v[1] / l] } }
fn perp(v: [f64; 2]) -> [f64; 2] { [-v[1], v[0]] }
fn cross2(a: [f64; 2], b: [f64; 2]) -> f64 { a[0] * b[1] - a[1] * b[0] }
fn trunc_ip(v: [f64; 2]) -> IP { [v[0].trunc() as i64, v[1].trunc() as i64] }
fn add_ip(a: IP, b: IP) -> IP { [a[0] + b[0], a[1] + b[1]] }
fn sub_ip(a: IP, b: IP) -> IP { [a[0] - b[0], a[1] - b[1]] }
fn translate(l: &(IP, IP), v: IP) -> (IP, IP) { (add_ip(l.0, v), add_ip(l.1, v)) }
fn extend(l: &(IP, IP), off: f64) -> (IP, IP) {
    let ov = trunc_ip([off * normalized(vec_of(l))[0], off * normalized(vec_of(l))[1]]);
    (sub_ip(l.0, ov), add_ip(l.1, ov))
}
/// `Line::intersection` (segments; parallel lines never intersect).
fn seg_intersection(l1: &(IP, IP), l2: &(IP, IP)) -> Option<IP> {
    let v1 = vec_of(l1);
    let v2 = vec_of(l2);
    let denom = cross2(v1, v2);
    if denom.abs() < EPSILON { return None; }
    let v12 = [(l1.0[0] - l2.0[0]) as f64, (l1.0[1] - l2.0[1]) as f64];
    let nume_a = cross2(v2, v12);
    let nume_b = cross2(v1, v12);
    let (t1, t2) = (nume_a / denom, nume_b / denom);
    if (0.0..=1.0).contains(&t1) && (0.0..=1.0).contains(&t2) { Some(trunc_ip([l1.0[0] as f64 + t1 * v1[0], l1.0[1] as f64 + t1 * v1[1]])) } else { None }
}
fn dist2_point_seg(p: IP, l: &(IP, IP)) -> f64 {
    let v = vec_of(l);
    let va = [(p[0] - l.0[0]) as f64, (p[1] - l.0[1]) as f64];
    let l2 = v[0] * v[0] + v[1] * v[1];
    if l2 == 0.0 { return va[0] * va[0] + va[1] * va[1]; }
    let t = ((va[0] * v[0] + va[1] * v[1]) / l2).clamp(0.0, 1.0);
    let d = [t * v[0] - va[0], t * v[1] - va[1]];
    d[0] * d[0] + d[1] * d[1]
}
pub(super) fn seg_seg_touch(a: IP, b: IP, c: IP, d: IP) -> bool {
    let o = |p: IP, q: IP, r: IP| -> i128 { (q[0] - p[0]) as i128 * (r[1] - p[1]) as i128 - (q[1] - p[1]) as i128 * (r[0] - p[0]) as i128 };
    let on = |p: IP, q: IP, r: IP| r[0] >= p[0].min(q[0]) && r[0] <= p[0].max(q[0]) && r[1] >= p[1].min(q[1]) && r[1] <= p[1].max(q[1]);
    let (o1, o2, o3, o4) = (o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b));
    if ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)) { return true; }
    (o1 == 0 && on(a, b, c)) || (o2 == 0 && on(a, b, d)) || (o3 == 0 && on(c, d, a)) || (o4 == 0 && on(c, d, b))
}

/// Uniform-grid index over segments (the R-tree of the original).
pub(super) struct SegIndex { pub(super) segs: Vec<(IP, IP)>, pub(super) alive: Vec<bool>, cell: f64, cells: std::collections::HashMap<(i64, i64), Vec<usize>> }
impl SegIndex {
    pub(super) fn new(cell: f64) -> SegIndex { SegIndex { segs: Vec::new(), alive: Vec::new(), cell, cells: std::collections::HashMap::new() } }
    pub(super) fn insert(&mut self, s: (IP, IP)) -> usize {
        let id = self.segs.len();
        self.segs.push(s);
        self.alive.push(true);
        let (x0, x1) = (s.0[0].min(s.1[0]) as f64, s.0[0].max(s.1[0]) as f64);
        let (y0, y1) = (s.0[1].min(s.1[1]) as f64, s.0[1].max(s.1[1]) as f64);
        let (cx0, cx1, cy0, cy1) = ((x0 / self.cell).floor() as i64, (x1 / self.cell).floor() as i64, (y0 / self.cell).floor() as i64, (y1 / self.cell).floor() as i64);
        for cx in cx0..=cx1 { for cy in cy0..=cy1 { self.cells.entry((cx, cy)).or_default().push(id); } }
        id
    }
    fn remove(&mut self, id: usize) { self.alive[id] = false; }
    /// ids of live segments whose cells overlap the bbox
    pub(super) fn candidates(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<usize> {
        let (cx0, cx1, cy0, cy1) = ((x0 / self.cell).floor() as i64, (x1 / self.cell).floor() as i64, (y0 / self.cell).floor() as i64, (y1 / self.cell).floor() as i64);
        let mut out: Vec<usize> = Vec::new();
        for cx in cx0..=cx1 { for cy in cy0..=cy1 { if let Some(v) = self.cells.get(&(cx, cy)) { for &id in v { if self.alive[id] { out.push(id); } } } } }
        out.sort_unstable();
        out.dedup();
        out
    }
    pub(super) fn intersecting(&self, a: IP, b: IP, filter: &dyn Fn(usize) -> bool) -> Vec<usize> {
        let (x0, x1) = (a[0].min(b[0]) as f64, a[0].max(b[0]) as f64);
        let (y0, y1) = (a[1].min(b[1]) as f64, a[1].max(b[1]) as f64);
        self.candidates(x0, y0, x1, y1).into_iter().filter(|&id| filter(id) && seg_seg_touch(a, b, self.segs[id].0, self.segs[id].1)).collect()
    }
    /// nearest live segment satisfying `filter`
    fn nearest(&self, p: IP, filter: &dyn Fn(usize) -> bool) -> Option<usize> {
        let mut r = self.cell;
        loop {
            let c = self.candidates(p[0] as f64 - r, p[1] as f64 - r, p[0] as f64 + r, p[1] as f64 + r);
            let mut best: Option<(f64, usize)> = None;
            for id in c { if filter(id) { let d = dist2_point_seg(p, &self.segs[id]); if best.map_or(true, |b| d < b.0) { best = Some((d, id)); } } }
            if let Some((d, id)) = best { if d.sqrt() <= r { return Some(id); } }
            if r > 1e9 { return best.map(|b| b.1); }
            r *= 2.0;
            if r > 4096.0 * self.cell && self.segs.len() < 100000 { // give up growing a grid search: brute force
                let mut best: Option<(f64, usize)> = None;
                for id in 0..self.segs.len() { if self.alive[id] && filter(id) { let d = dist2_point_seg(p, &self.segs[id]); if best.map_or(true, |b| d < b.0) { best = Some((d, id)); } } }
                return best.map(|b| b.1);
            }
        }
    }
}

struct Isect { closest: usize, line: usize, pl: usize, pt: IP, front: bool, left: bool, used: bool }

fn connect_lines_using_hooks(mut lines: Vec<Vec<IP>>, boundary_rings: &[Vec<IP>], spacing: f64, hook_length: f64, hook_length_max: f64) -> Vec<Vec<IP>> {
    let mut rtree = SegIndex::new(8.0 * NM);
    let scaled_offset = spacing * NM * 0.81;
    let scaled_trim = spacing * NM * 0.5 * 0.75;
    let n_lines = lines.len();
    let mut touching: Vec<(usize, usize)> = Vec::new();
    let mut tree_of: Vec<Option<usize>> = vec![None; n_lines]; // line idx -> rtree id
    let r2_close = 1200.0f64 * 1200.0;
    for li in 0..n_lines {
        if li > 0 {
            let (pf, pb) = (lines[li][0], *lines[li].last().unwrap());
            for which in 0..2 {
                let (pt, pt_other) = if which == 0 { (pf, pb) } else { (pb, pf) };
                // nearest segment (any)
                let Some(cid) = rtree.nearest(pt, &|_| true) else { continue };
                let oi = cid;
                // `other` is lines[oi] (rtree ids == line ids because every line is inserted in order)
                if lines[oi].is_empty() { continue; }
                let (of, ob) = (lines[oi][0], *lines[oi].last().unwrap());
                let d = |a: IP, b: IP| ((a[0] - b[0]) as f64).powi(2) + ((a[1] - b[1]) as f64).powi(2);
                let (d_front, d_back) = (d(of, pt), d(ob, pt));
                let dmin = d_front.min(d_back);
                if dmin < r2_close {
                    let dmin_other = d(of, pt_other).min(d(ob, pt_other));
                    if dmin_other > dmin {
                        let v1 = normalized([(pt_other[0] - pt[0]) as f64, (pt_other[1] - pt[1]) as f64]);
                        let v2 = normalized([(ob[0] - of[0]) as f64, (ob[1] - of[1]) as f64]);
                        if (v1[0] * v2[0] + v1[1] * v2[1]).abs() > 0.99 {
                            // collinear: merge
                            rtree.remove(oi);
                            let other_pts = lines[oi].clone();
                            let take = if dmin == d_front { *other_pts.last().unwrap() } else { other_pts[0] };
                            if which == 0 { lines[li][0] = take; } else { let l = lines[li].len(); lines[li][l - 1] = take; }
                            lines[oi].clear();
                            continue;
                        } else {
                            let (a, b) = if li > oi { (oi, li) } else { (li, oi) };
                            touching.push((a, b));
                        }
                    }
                }
            }
        }
        if lines[li].is_empty() { tree_of[li] = None; rtree.segs.push(([0, 0], [0, 0])); rtree.alive.push(false); continue; }
        let id = rtree.insert((lines[li][0], *lines[li].last().unwrap()));
        debug_assert_eq!(id, li);
        tree_of[li] = Some(id);
    }
    let lines_src: Vec<(IP, IP)> = lines.iter().map(|pl| if pl.is_empty() { ([0, 0], [0, 0]) } else { (pl[0], *pl.last().unwrap()) }).collect();
    touching.sort();
    touching.dedup();

    // T-joints
    let line_len_threshold_drop_both = scaled_offset * (2.0 / (PI / 6.0).cos() + 0.5) + EPS_NM;
    let line_len_threshold_anchor_both = line_len_threshold_drop_both + scaled_offset;
    let line_len_threshold_drop_single = scaled_offset * (1.0 / (PI / 6.0).cos() + 1.5) + EPS_NM;
    let line_len_threshold_anchor_single = line_len_threshold_drop_single + scaled_offset;
    let mut isects: Vec<Isect> = Vec::new();
    for li in 0..n_lines {
        if lines[li].is_empty() { continue; }
        let front = lines[li][0];
        let back = *lines[li].last().unwrap();
        let has_tjoint = |pt: IP, lines: &Vec<Vec<IP>>| -> Option<usize> {
            let filter = |id: usize| -> bool {
                if id != li && id < n_lines {
                    let l = &lines_src[id];
                    let v = vec_of(l);
                    let va = [(pt[0] - l.0[0]) as f64, (pt[1] - l.0[1]) as f64];
                    let l2 = v[0] * v[0] + v[1] * v[1];
                    if l2 > 0.0 { let t = va[0] * v[0] + va[1] * v[1]; return t > EPS_NM && t < l2 - EPS_NM; }
                }
                false
            };
            let cid = rtree.nearest(pt, &filter)?;
            let pl = &lines[cid];
            if pl.is_empty() { return None; }
            if pl.len() >= 2 && dist2_point_seg(pt, &(pl[0], *pl.last().unwrap())) <= 1000.0 * 1000.0 { Some(cid) } else { None }
        };
        let filter_end = |r: Option<usize>| -> Option<usize> {
            let r = r?;
            let (lo, hi) = if li > r { (r, li) } else { (li, r) };
            if touching.binary_search(&(lo, hi)).is_ok() { None } else { Some(r) }
        };
        let tj_front = filter_end(has_tjoint(front, &lines));
        let tj_back = filter_end(has_tjoint(back, &lines));
        let num = tj_front.is_some() as i32 + tj_back.is_some() as i32;
        if num > 0 {
            let line_len = gx_len(&lines[li]);
            let (drop, anchor);
            if num == 1 { drop = line_len < line_len_threshold_drop_single; anchor = line_len > line_len_threshold_anchor_single; }
            else { drop = line_len < line_len_threshold_drop_both; anchor = line_len > line_len_threshold_anchor_both; }
            if drop {
                lines[li].clear();
            } else if anchor {
                if let Some(c) = tj_front { isects.push(mk_isect(&lines_src, c, li, li, front, true)); }
                if let Some(c) = tj_back { isects.push(mk_isect(&lines_src, c, li, li, back, false)); }
            } else {
                let n = lines[li].len();
                let (fp, bp) = (lines[li][0], lines[li][n - 1]);
                if tj_front.is_some() { let v = normalized([(bp[0] - fp[0]) as f64, (bp[1] - fp[1]) as f64]); let nf = add_ip(fp, trunc_ip([scaled_trim * 1.155 * v[0], scaled_trim * 1.155 * v[1]])); lines[li][0] = nf; }
                if tj_back.is_some() { let (fp2, bp2) = (lines[li][0], lines[li][n - 1]); let v = normalized([(fp2[0] - bp2[0]) as f64, (fp2[1] - bp2[1]) as f64]); lines[li][n - 1] = add_ip(bp2, trunc_ip([scaled_trim * 1.155 * v[0], scaled_trim * 1.155 * v[1]])); }
            }
        }
    }
    // remove intersections pointing at dropped lines
    let mut k = 0;
    while k < isects.len() {
        if lines[isects[k].closest].is_empty() { isects.swap_remove(k); } else { k += 1; }
    }
    isects.sort_by(|a, b| a.closest.cmp(&b.closest).then((a.left as u8).cmp(&(b.left as u8))));
    let mut merged_with: Vec<usize> = (0..n_lines).collect();
    // boundary segments appended to the index
    for ring in boundary_rings {
        let mut prev = *ring.last().unwrap();
        for &p in ring { rtree.insert((prev, p)); prev = p; }
    }
    fn root(m: &mut [usize], i: usize) -> usize { let mut last = i; loop { let lower = m[last]; if lower == last { m[i] = last; return last; } last = lower; } }

    // merge polylines touching at their ends
    for &(a, b) in touching.iter().rev() {
        let (pl1, mut pl2) = (a, b);
        pl2 = root(&mut merged_with, pl2);
        if pl1 != pl2 && !lines[pl1].is_empty() && !lines[pl2].is_empty() {
            let (f1, b1, f2, b2) = (lines[pl1][0], *lines[pl1].last().unwrap(), lines[pl2][0], *lines[pl2].last().unwrap());
            let d = |a: IP, b: IP| ((a[0] - b[0]) as f64).powi(2) + ((a[1] - b[1]) as f64).powi(2);
            let (d11, d12, d21, d22) = (d(f1, f2), d(f1, b2), d(b1, f2), d(b1, b2));
            let (d1min, d2min) = (d11.min(d12), d21.min(d22));
            if d1min < d2min { lines[pl1].reverse(); if d12 == d1min { lines[pl2].reverse(); } }
            else if d22 == d2min { lines[pl2].reverse(); }
            let last = lines[pl1].len() - 1;
            let mid = [(lines[pl1][last][0] + lines[pl2][0][0]) / 2, (lines[pl1][last][1] + lines[pl2][0][1]) / 2];
            lines[pl1][last] = mid;
            let rest: Vec<IP> = lines[pl2][1..].to_vec();
            lines[pl1].extend(rest);
            lines[pl2].clear();
            merged_with[pl2] = pl1;
        }
    }

    // process intersections
    let fresh = |is: &Isect, lines: &Vec<Vec<IP>>| !is.used && !lines[is.pl].is_empty();
    let mut min_idx = 0usize;
    while min_idx < isects.len() {
        let mut max_idx = min_idx;
        let (c0, l0) = (isects[min_idx].closest, isects[min_idx].left);
        let line_dir = vec_of(&lines_src[c0]);
        let mut il: Vec<(usize, f64)> = Vec::new();
        while max_idx < isects.len() && isects[max_idx].closest == c0 && isects[max_idx].left == l0 {
            il.push((max_idx, line_dir[0] * isects[max_idx].pt[0] as f64 + line_dir[1] * isects[max_idx].pt[1] as f64));
            max_idx += 1;
        }
        min_idx = max_idx;
        il.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        let upd = |i: usize, isects: &mut Vec<Isect>, lines: &Vec<Vec<IP>>, merged_with: &mut Vec<usize>| {
            let r = root(merged_with, isects[i].pl);
            isects[i].pl = r;
            if fresh(&isects[i], lines) {
                isects[i].front = lines[r][0] == isects[i].pt;
            }
        };
        if il.len() == 1 {
            let fi = il[0].0;
            upd(fi, &mut isects, &lines, &mut merged_with);
            if fresh(&isects[fi], &lines) {
                add_hook(&isects[fi], &mut lines, scaled_offset, hook_length, scaled_trim, &rtree, &lines_src, n_lines);
                isects[fi].used = true;
            }
            continue;
        }
        for first_idx in 0..il.len() {
            let fi = il[first_idx].0;
            upd(fi, &mut isects, &lines, &mut merged_with);
            if !fresh(&isects[fi], &lines) { continue; }
            if first_idx > 0 { upd(il[first_idx - 1].0, &mut isects, &lines, &mut merged_with); }
            if first_idx + 1 < il.len() { upd(il[first_idx + 1].0, &mut isects, &lines, &mut merged_with); }
            // get_nearest_intersection
            let take_next = if first_idx == 0 { true } else if first_idx + 1 == il.len() { false } else {
                let (ithis, iprev, inext) = (&il[first_idx], &il[first_idx - 1], &il[first_idx + 1]);
                if fresh(&isects[iprev.0], &lines) && fresh(&isects[inext.0], &lines) { inext.1 - ithis.1 < ithis.1 - iprev.1 } else { fresh(&isects[inext.0], &lines) }
            };
            let ni = il[if take_next { first_idx + 1 } else { first_idx - 1 }].0;
            let (fpt, npt) = (isects[fi].pt, isects[ni].pt);
            let offset_line = create_offset_line(&(fpt, npt), &lines_src, &isects[fi], scaled_offset);
            let (mut fpp, mut npp) = ([0i64; 2], [0i64; 2]);
            let mut could_connect = false;
            if fresh(&isects[ni], &lines) {
                let a = seg_intersection(&lines_src[isects[fi].line], &offset_line);
                let b = seg_intersection(&lines_src[isects[ni].line], &offset_line);
                if let (Some(a), Some(b)) = (a, b) { fpp = a; npp = b; could_connect = true; }
            }
            let dd = ((npp[0] - fpp[0]) as f64).powi(2) + ((npp[1] - fpp[1]) as f64).powi(2);
            could_connect &= dd <= hook_length_max * hook_length_max;
            if could_connect {
                let (fl, nl) = (isects[fi].line, isects[ni].line);
                let hits = rtree.intersecting(fpp, npp, &|id| id != fl && id != nl);
                could_connect = hits.is_empty();
            }
            let mut connected = false;
            if could_connect {
                let (fpl, npl) = (isects[fi].pl, isects[ni].pl);
                if fpl == npl {
                    if !isects[fi].front { std::mem::swap(&mut fpp, &mut npp); }
                    let pts = &mut lines[fpl];
                    pts[0] = fpp;
                    let l = pts.len();
                    pts[l - 1] = npp;
                    pts.insert(0, npp);
                } else {
                    let left = isects[fi].left;
                    let cl = vec_of(&lines_src[isects[fi].closest]);
                    let pv = perp(normalized(cl));
                    let tr = trunc_ip([pv[0] * if left { scaled_trim } else { -scaled_trim }, pv[1] * if left { scaled_trim } else { -scaled_trim }]);
                    let l = translate(&(fpp, npp), tr);
                    let (mut pt_start, mut pt_end) = ([0i64; 2], [0i64; 2]);
                    let trim_start = lines[fpl].len() == 3 && other_hook_intersects(&isects[fi], &lines, &l, &mut pt_start);
                    let trim_end = lines[npl].len() == 3 && other_hook_intersects(&isects[ni], &lines, &l, &mut pt_end);
                    let mut first_points = std::mem::take(&mut lines[fpl]);
                    let second_points = std::mem::take(&mut lines[npl]);
                    if isects[fi].front { first_points.reverse(); }
                    if trim_start { first_points[0] = pt_start; }
                    let fl = first_points.len();
                    first_points[fl - 1] = fpp;
                    first_points.push(npp);
                    if isects[ni].front { first_points.extend_from_slice(&second_points[1..]); } else { first_points.extend(second_points[..second_points.len() - 1].iter().rev().cloned()); }
                    if trim_end { let l2 = first_points.len(); first_points[l2 - 1] = pt_end; }
                    if fpl < npl { lines[fpl] = first_points; merged_with[npl] = fpl; }
                    else { lines[npl] = first_points; merged_with[fpl] = npl; }
                }
                isects[ni].used = true;
                connected = true;
            }
            if !connected {
                add_hook(&isects[fi], &mut lines, scaled_offset, hook_length, scaled_trim, &rtree, &lines_src, n_lines);
            }
            isects[fi].used = true;
        }
    }
    lines.into_iter().filter(|l| !l.is_empty()).collect()
}

fn gx_len(pl: &[IP]) -> f64 { pl.windows(2).map(|w| (((w[1][0] - w[0][0]) as f64).powi(2) + ((w[1][1] - w[0][1]) as f64).powi(2)).sqrt()).sum() }

fn mk_isect(lines_src: &[(IP, IP)], closest: usize, intersect_line: usize, pl: usize, pt: IP, front: bool) -> Isect {
    let c = &lines_src[closest];
    let il = &lines_src[intersect_line];
    let v1 = vec_of(c);
    let v2 = if pt == il.0 { [(il.1[0] - il.0[0]) as f64, (il.1[1] - il.0[1]) as f64] } else { [(il.0[0] - il.1[0]) as f64, (il.0[1] - il.1[1]) as f64] };
    Isect { closest, line: intersect_line, pl, pt, front, left: cross2(v1, v2) > 0.0, used: false }
}

fn create_offset_line(base: &(IP, IP), lines_src: &[(IP, IP)], is: &Isect, scaled_offset: f64) -> (IP, IP) {
    let cl = vec_of(&lines_src[is.closest]);
    let pv = perp(normalized(cl));
    let s = if is.left { scaled_offset } else { -scaled_offset };
    let t = translate(base, trunc_ip([pv[0] * s, pv[1] * s]));
    extend(&t, (scaled_offset * 1.16).trunc())
}

fn other_hook(is: &Isect, lines: &[Vec<IP>]) -> Option<(IP, IP)> {
    let pts = &lines[is.pl];
    if pts.len() >= 3 { Some(if is.front { (pts[1], pts[2]) } else { (pts[pts.len() - 2], pts[pts.len() - 3]) }) } else { None }
}
fn other_hook_intersects(is: &Isect, lines: &[Vec<IP>], l: &(IP, IP), out: &mut IP) -> bool {
    match other_hook(is, lines) { Some(h) => match seg_intersection(&h, l) { Some(p) => { *out = p; true } None => false }, None => false }
}

#[allow(clippy::too_many_arguments)]
fn add_hook(is: &Isect, lines: &mut Vec<Vec<IP>>, scaled_offset: f64, hook_length: f64, scaled_trim: f64, rtree: &SegIndex, lines_src: &[(IP, IP)], n_lines: usize) {
    if hook_length < EPS_NM { return; }
    let off_line = create_offset_line(&lines_src[is.closest], lines_src, is, scaled_offset);
    let Some(hook_start) = seg_intersection(&lines_src[is.line], &off_line) else { return };
    let other = other_hook(is, lines);
    let hvn = normalized(vec_of(&lines_src[is.closest]));
    let hv = trunc_ip([(hook_length + 1.16 * scaled_trim) * hvn[0], (hook_length + 1.16 * scaled_trim) * hvn[1]]);
    let hook_forward = (hook_start, add_ip(hook_start, hv));
    let self_line = is.line;
    let filter = move |id: usize| id != self_line;
    let hits = rtree.intersecting(hook_forward.0, hook_forward.1, &filter);
    let self_int = other.and_then(|o| seg_intersection(&o, &hook_forward));
    let max_hook_length = |pt: [f64; 2], dir: [f64; 2], hits: &Vec<usize>, self_int: Option<IP>, other: Option<(IP, IP)>| -> f64 {
        let mut max_length = hook_length;
        let shift = |dir2: [f64; 2]| scaled_trim * cross2(dir, normalized(dir2)).abs();
        for &id in hits {
            let s = rtree.segs[id];
            let pt2 = [s.0[0] as f64, s.0[1] as f64];
            let dir2 = [(s.1[0] - s.0[0]) as f64, (s.1[1] - s.0[1]) as f64];
            let denom = cross2(dir, dir2);
            if denom.abs() <= EPSILON { continue; }
            let mut t = cross2([pt2[0] - pt[0], pt2[1] - pt[1]], dir2) / denom;
            if id < n_lines { t -= shift(dir2); }
            if t < max_length { max_length = t; }
        }
        if let (Some(p), Some(o)) = (self_int, other) {
            let t = ((p[0] as f64 - pt[0]) * dir[0] + (p[1] as f64 - pt[1]) * dir[1]) - shift([(o.1[0] - o.0[0]) as f64, (o.1[1] - o.0[1]) as f64]);
            max_length = max_length.min(t);
        }
        max_length.max(0.0)
    };
    let hsf = [hook_start[0] as f64, hook_start[1] as f64];
    let fwd = max_hook_length(hsf, hvn, &hits, self_int, other);
    let mut back = 0.0;
    if fwd < hook_length - EPS_NM {
        let hook_backward = (hook_start, sub_ip(hook_start, hv));
        let hits2 = rtree.intersecting(hook_backward.0, hook_backward.1, &filter);
        let self_int2 = other.and_then(|o| seg_intersection(&o, &hook_backward));
        back = max_hook_length(hsf, [-hvn[0], -hvn[1]], &hits2, self_int2, other);
    }
    let len = if fwd > back { fwd } else { -back };
    let hook_end = add_ip(hook_start, trunc_ip([len * hvn[0], len * hvn[1]]));
    let pl = &mut lines[is.pl];
    if is.front { pl[0] = hook_start; pl.insert(0, hook_end); } else { let l = pl.len(); pl[l - 1] = hook_start; pl.push(hook_end); }
}

/// `FillAdaptive::Filler::_fill_surface_single` for one (already contracted) ExPolygon.
pub(super) fn fill_adaptive(poly: &Poly, cx: &Ctx, oct: &AdaptiveOctree) -> Vec<Vec<P>> {
    if oct.props.is_empty() { return Vec::new(); }
    let o = cx.origin;
    let ex = Poly { contour: poly.contour.iter().map(|p| [p[0] - o[0], p[1] - o[1]]).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|p| [p[0] - o[0], p[1] - o[1]]).collect()).collect() };
    let mut all: Vec<(IP, IP)> = Vec::new();
    for dir in 0..3 {
        let mut ctx = FillCtx { props: &oct.props, z: cx.z, order: CHILD_TRAVERSAL_ORDER[dir], cos_a: DIRECTION_ANGLES[dir].cos(), sin_a: DIRECTION_ANGLES[dir].sin(),
            temp_lines: vec![([UNUSED, UNUSED], [UNUSED, UNUSED]); (1usize << oct.props.len()) - 1], output: Vec::new() };
        gen_lines(&mut ctx, oct, 0, 0, oct.props.len() as i32 - 1);
        all.extend(ctx.output.iter().cloned());
        for l in &ctx.temp_lines { if l.0[0] != UNUSED { all.push(*l); } }
    }
    let polylines: Vec<Vec<P>> = all.iter().map(|l| vec![[l.0[0] as f64 / NM, l.0[1] as f64 / NM], [l.1[0] as f64 / NM, l.1[1] as f64 / NM]]).collect();
    let polylines = if cx.multiline > 1 { super::rect::multiline_offsets_pub(polylines, cx.multiline, cx.spacing) } else { polylines };
    let mut clipped = gx::clip_lines(&polylines, &vec![ex.clone()]);
    for pl in &mut clipped { if pl.len() > 2 { let (f, l) = (pl[0], *pl.last().unwrap()); *pl = vec![f, l]; } }
    let result: Vec<Vec<P>>;
    if cx.multiline == 1 {
        let ipl: Vec<Vec<IP>> = clipped.iter().map(|p| p.iter().map(|q| new_scale(*q)).collect()).collect();
        let with_hooks = if ipl.len() > 1 {
            let rings: Vec<Vec<IP>> = gx::rings(&vec![ex.clone()]).iter().map(|r| r.iter().map(|q| new_scale(*q)).collect()).collect();
            connect_lines_using_hooks(ipl, &rings, cx.spacing, cx.anchor * NM, cx.anchor_max * NM)
        } else { ipl };
        let fl: Vec<Vec<P>> = with_hooks.iter().map(|p| p.iter().map(|q| [q[0] as f64 / NM, q[1] as f64 / NM]).collect()).collect();
        result = chain_or_connect(fl, &ex, cx);
    } else {
        result = chain_or_connect(clipped, &ex, cx);
    }
    result.into_iter().map(|l| l.into_iter().map(|p| [p[0] + o[0], p[1] + o[1]]).collect()).collect()
}

fn chain_or_connect(pl: Vec<Vec<P>>, ex: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    if pl.is_empty() { return pl; }
    if cx.anchor_max < 0.05 { super::chain_polylines(pl, None) }
    else { super::connect::connect_infill(pl, &gx::rings(&vec![ex.clone()]), cx.spacing, cx.anchor, cx.anchor_max, cx.multiline) }
}
