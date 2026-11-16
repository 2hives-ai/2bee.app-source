//! Mesh visibility for the seam placer: a port of `SeamPlacerImpl::raycast_visibility` and
//! `GlobalModelInfo::calculate_point_visibility` (`GCode/SeamPlacer.cpp`).
//!
//! Orca scatters 30000 samples over the mesh (area weighted, a *fixed* `mt19937_64` seed of 27644437, so the result
//! is reproducible) and casts 5x5 hemisphere rays from each. A sample's visibility is `1 - occluded / 25`; the
//! visibility of a perimeter point is the weighted mean of the samples within a search radius. The seam comparator
//! ADDS visibility to the penalty, so hidden (concave, occluded) places are preferred.
//!
//! What is exact (verified against an instrumented Orca build that dumps its samples and per-candidate visibility, on
//! three synthetic scenes: all 30000 samples, their triangles, normals and ray-cast visibilities were identical, and
//! the candidate visibilities identical bit for bit wherever the candidate coordinates were): the RNG and its
//! `uniform_real_distribution` conversion, the area-weighted triangle choice (float cumulative sum, `upper_bound`),
//! the barycentric sample point, the hemisphere directions, the `Frame`, the ray origin offset, first-hit semantics
//! with Moller-Trumbore (`t > 0`, absolute `eps = 1e-6` as `intersect_ray_first_hit`'s default), front-face test, the
//! radius formula, the point weighting, the object frame (`FRAME_OFFSET`: everything is evaluated relative to the bed
//! centre, which is where Orca's object frame has its origin, so f32 rounding is the same) and the order in which
//! the float sums are accumulated (`Kd3` is Orca's `KDTreeIndirect`: same quickselect build, same pre-order visit; the
//! squared norms and dot products use Eigen's `x + (y + z)` order).
//! What is not: Orca first decimates the mesh to 16000 triangles (`its_short_edge_collpase`); this port samples the
//! mesh as given (identical for meshes up to 16000 triangles). When the mesh comes from a stack of layer polygons
//! (`mesh_from_layers`) the triangles are a different tessellation than the STL, so sample positions are
//! statistically equivalent, not identical.

pub type Tri = [[f64; 3]; 3];

const SAMPLES: usize = 30000;
const SQR_RAYS: usize = 5;

// ---- mt19937_64 + libstdc++ uniform_real_distribution<double> ------------------------------------------------------

pub struct Mt64 { mt: [u64; 312], idx: usize }
impl Mt64 {
    pub fn new(seed: u64) -> Mt64 {
        let mut mt = [0u64; 312];
        mt[0] = seed;
        for i in 1..312 { mt[i] = 6364136223846793005u64.wrapping_mul(mt[i - 1] ^ (mt[i - 1] >> 62)).wrapping_add(i as u64); }
        Mt64 { mt, idx: 312 }
    }
    fn twist(&mut self) {
        const UM: u64 = 0xFFFF_FFFF_8000_0000;
        const LM: u64 = 0x7FFF_FFFF;
        for i in 0..312 {
            let x = (self.mt[i] & UM) | (self.mt[(i + 1) % 312] & LM);
            let mut xa = x >> 1;
            if x & 1 != 0 { xa ^= 0xB502_6F5A_A966_19E9; }
            self.mt[i] = self.mt[(i + 156) % 312] ^ xa;
        }
        self.idx = 0;
    }
    pub fn next_u64(&mut self) -> u64 {
        if self.idx >= 312 { self.twist(); }
        let mut x = self.mt[self.idx];
        self.idx += 1;
        x ^= (x >> 29) & 0x5555_5555_5555_5555;
        x ^= (x << 17) & 0x71D6_7FFF_EDA6_0000;
        x ^= (x << 37) & 0xFFF7_EEE0_0000_0000;
        x ^= x >> 43;
        x
    }
    /// libstdc++ `generate_canonical<double, 53>(mt19937_64)`: `double(x) / 2^64`, clamped below 1.
    pub fn next_f64(&mut self) -> f64 {
        let r = (self.next_u64() as f64) / 18446744073709551616.0;
        if r >= 1.0 { 1.0 - f64::EPSILON / 2.0 } else { r }
    }
}

// ---- small f32 vector helpers (Orca does this in float) --------------------------------------------------------------

type V3 = [f32; 3];
fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn add(a: V3, b: V3) -> V3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn mul(a: V3, s: f32) -> V3 { [a[0] * s, a[1] * s, a[2] * s] }
fn dot(a: V3, b: V3) -> f32 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn normalized(a: V3) -> V3 { let l = dot(a, a).sqrt(); if l > 0.0 { mul(a, 1.0 / l) } else { a } }
fn norm(a: V3) -> f32 { dot(a, a).sqrt() }

fn sample_hemisphere_uniform(sx: f32, sy: f32) -> V3 {
    let term1 = 2.0 * std::f32::consts::PI * sx;
    let term2 = 2.0 * (sy - sy * sy).sqrt();
    [term1.cos() * term2, term1.sin() * term2, (1.0 - 2.0 * sy).abs()]
}

struct Frame { x: V3, y: V3, z: V3 }
impl Frame {
    fn from_z(z: V3) -> Frame {
        let z = normalized(z);
        let tx: V3 = if z[0].abs() > 0.99 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
        let y = normalized(cross(z, tx));
        let x = cross(y, z);
        Frame { x, y, z }
    }
    fn to_world(&self, a: V3) -> V3 { add(add(mul(self.x, a[0]), mul(self.y, a[1])), mul(self.z, a[2])) }
}

// ---- BVH ------------------------------------------------------------------------------------------------------------

struct Bvh {
    // flattened nodes: (min, max, left/first, count_or_right) ; leaf when count > 0
    nodes: Vec<Node>,
    order: Vec<u32>,
    tris: Vec<[[f64; 3]; 3]>,
    eps: f64,
}
#[derive(Clone, Copy)]
struct Node { lo: [f64; 3], hi: [f64; 3], a: u32, n: u32 } // internal: a = right child index (left = self+1), n = 0; leaf: a = first, n = count

impl Bvh {
    fn build(tris: Vec<[[f64; 3]; 3]>) -> Bvh {
        let n = tris.len();
        let mut order: Vec<u32> = (0..n as u32).collect();
        let cent: Vec<[f64; 3]> = tris.iter().map(|t| [(t[0][0] + t[1][0] + t[2][0]) / 3.0, (t[0][1] + t[1][1] + t[2][1]) / 3.0, (t[0][2] + t[1][2] + t[2][2]) / 3.0]).collect();
        let mut nodes = Vec::with_capacity(2 * n / 4 + 2);
        let (mut glo, mut ghi) = ([f64::MAX; 3], [f64::MIN; 3]);
        for t in &tris { for v in t { for k in 0..3 { glo[k] = glo[k].min(v[k]); ghi[k] = ghi[k].max(v[k]); } } }
        if n > 0 {
            Self::rec(&tris, &cent, &mut order, 0, n, &mut nodes);
        }
        let l = (0..3).map(|k| ghi[k] - glo[k]).fold(0.0, f64::max);
        let _ = l; let eps = 0.000001; // Orca: `intersect_ray_first_hit` default `eps = 0.000001` (absolute; `intersect_triangle_epsilon` is unused)
        Bvh { nodes, order, tris, eps }
    }
    fn rec(tris: &[[[f64; 3]; 3]], cent: &[[f64; 3]], order: &mut [u32], s: usize, e: usize, nodes: &mut Vec<Node>) -> usize {
        let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
        for &i in &order[s..e] { for v in &tris[i as usize] { for k in 0..3 { lo[k] = lo[k].min(v[k]); hi[k] = hi[k].max(v[k]); } } }
        let me = nodes.len();
        nodes.push(Node { lo, hi, a: s as u32, n: (e - s) as u32 });
        if e - s <= 4 { return me; }
        let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
        let ax = if ext[0] >= ext[1] && ext[0] >= ext[2] { 0 } else if ext[1] >= ext[2] { 1 } else { 2 };
        order[s..e].sort_by(|&a, &b| cent[a as usize][ax].total_cmp(&cent[b as usize][ax]).then(a.cmp(&b)));
        let mid = (s + e) / 2;
        let _left = Self::rec(tris, cent, order, s, mid, nodes);
        let right = Self::rec(tris, cent, order, mid, e, nodes);
        nodes[me].a = right as u32;
        nodes[me].n = 0;
        me
    }
    /// First hit with `t > 0`: (triangle index, t).
    fn first_hit(&self, o: [f64; 3], d: [f64; 3]) -> Option<(usize, f64)> {
        if self.nodes.is_empty() { return None; }
        let inv = [1.0 / d[0], 1.0 / d[1], 1.0 / d[2]];
        let mut best_t = f64::INFINITY;
        let mut best: Option<usize> = None;
        let mut stack: Vec<usize> = Vec::with_capacity(64);
        stack.push(0);
        while let Some(ni) = stack.pop() {
            let nd = &self.nodes[ni];
            if !box_hit(o, inv, nd.lo, nd.hi, best_t) { continue; }
            if nd.n > 0 {
                for k in nd.a..nd.a + nd.n {
                    let ti = self.order[k as usize] as usize;
                    if let Some(t) = tri_hit(o, d, &self.tris[ti], self.eps) {
                        if t > 0.0 && t < best_t { best_t = t; best = Some(ti); }
                    }
                }
            } else {
                stack.push(nd.a as usize);
                stack.push(ni + 1);
            }
        }
        best.map(|b| (b, best_t))
    }
}

fn box_hit(o: [f64; 3], inv: [f64; 3], lo: [f64; 3], hi: [f64; 3], t1: f64) -> bool {
    let mut tmin = 0.0f64;
    let mut tmax = t1;
    for k in 0..3 {
        let (a, b) = if inv[k] < 0.0 { (hi[k], lo[k]) } else { (lo[k], hi[k]) };
        let t0 = (a - o[k]) * inv[k];
        let t1 = (b - o[k]) * inv[k];
        // NaN (0 * inf) means the ray lies in the slab boundary plane: treat as inside
        let (t0, t1) = (if t0.is_nan() { f64::NEG_INFINITY } else { t0 }, if t1.is_nan() { f64::INFINITY } else { t1 });
        if t0 > tmin { tmin = t0; }
        if t1 < tmax { tmax = t1; }
        if tmin > tmax { return false; }
    }
    true
}

/// Moller-Trumbore, two-sided with epsilon, as `AABBTreeIndirect::intersect_triangle`.
fn tri_hit(o: [f64; 3], d: [f64; 3], t: &[[f64; 3]; 3], eps: f64) -> Option<f64> {
    let s = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cr = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let dt = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let e1 = s(t[1], t[0]);
    let e2 = s(t[2], t[0]);
    let p = cr(d, e2);
    let det = dt(e1, p);
    let tv = s(o, t[0]);
    let (u, v, q);
    if det > eps {
        u = dt(tv, p);
        if u < 0.0 || u > det { return None; }
        q = cr(tv, e1);
        v = dt(d, q);
        if v < 0.0 || u + v > det { return None; }
    } else if det < -eps {
        u = dt(tv, p);
        if u > 0.0 || u < det { return None; }
        q = cr(tv, e1);
        v = dt(d, q);
        if v > 0.0 || u + v < det { return None; }
    } else { return None; }
    let _ = (u, v);
    Some(dt(e2, q) / det)
}

// ---- the visibility field ---------------------------------------------------------------------------------------------

/// Orca computes the occlusion field and the seam candidates in the object frame: the mesh and the layers are shifted
/// by the object's bounding-box centre, which `arrange` puts on the bed centre (measured: the outer-wall bbox centre is
/// (138.25, 128.0) on every corpus model). Working in that frame is what makes the f32 arithmetic below bit-identical
/// to Orca's (float rounding depends on the magnitude of the coordinates).
pub const FRAME_OFFSET: [f64; 2] = [138.25, 128.0];

/// `KDTreeIndirect<3, float>` of Orca (`libslic3r/KDTreeIndirect.hpp`): same build (quickselect with median-of-three), same
/// pre-order visit, so `nearby` returns the points in the order Orca's `find_nearby_points` does. That order is the
/// accumulation order of the float sums in `calculate_point_visibility`, and the tie order of `find_next_seam_in_layer`.
#[derive(Clone, Default)]
pub struct Kd3 {
    pts: Vec<V3>,
    nodes: Vec<usize>,
}
const NPOS: usize = usize::MAX;
impl Kd3 {
    pub fn build(pts: Vec<V3>) -> Kd3 {
        let n = pts.len();
        let mut kd = Kd3 { pts, nodes: Vec::new() };
        if n == 0 { return kd; }
        let mut idx: Vec<usize> = (0..n).collect();
        kd.nodes = vec![NPOS; (n + 1).next_power_of_two().max(1)];
        kd.build_rec(&mut idx, 0, 0, 0, n - 1);
        kd
    }
    fn c(&self, i: usize, d: usize) -> f32 { self.pts[i][d] }
    fn build_rec(&mut self, input: &mut Vec<usize>, node: usize, dim: usize, left: usize, right: usize) {
        if left > right { return; }
        if left == right { self.nodes[node] = input[left]; return; }
        let center = (left + right) / 2;
        self.partition(input, dim, left, right, center);
        self.nodes[node] = input[center];
        let nd = if dim + 1 == 3 { 0 } else { dim + 1 };
        if center > left { self.build_rec(input, node * 2 + 1, nd, left, center - 1); }
        self.build_rec(input, node * 2 + 2, nd, center + 1, right);
    }
    fn partition(&self, input: &mut Vec<usize>, dim: usize, mut left: usize, mut right: usize, k: usize) {
        while left < right {
            let center = (left + right) / 2;
            let pivot;
            {
                let mut lv = self.c(input[left], dim);
                let mut cv = self.c(input[center], dim);
                let mut rv = self.c(input[right], dim);
                if lv > cv { input.swap(left, center); std::mem::swap(&mut lv, &mut cv); }
                if lv > rv { input.swap(left, right); rv = lv; }
                if cv > rv { input.swap(center, right); cv = rv; }
                pivot = cv;
            }
            if right <= left + 2 { break; }
            let mut i = left;
            let mut j = right - 1;
            input.swap(center, j);
            loop {
                loop { i += 1; if !(self.c(input[i], dim) < pivot) { break; } }
                loop { j -= 1; if !(self.c(input[j], dim) > pivot && i < j) { break; } }
                if i >= j { break; }
                input.swap(i, j);
            }
            input.swap(i, right - 1);
            if k < i { right = i - 1; } else if k == i { break; } else { left = i + 1; }
        }
    }
    /// `find_nearby_points(kdtree, center, max_distance)`: indices within `max_distance` (strict, float squared distance
    /// accumulated x, y, z), in visit order.
    pub fn nearby(&self, center: V3, max_distance: f32) -> Vec<usize> {
        let mut out = Vec::new();
        if self.nodes.is_empty() { return out; }
        let md2 = max_distance * max_distance;
        self.visit(0, 0, center, md2, &mut out);
        out
    }
    fn visit(&self, node: usize, dim: usize, center: V3, md2: f32, out: &mut Vec<usize>) {
        if node >= self.nodes.len() || self.nodes[node] == NPOS { return; }
        let idx = self.nodes[node];
        let mut dist = 0.0f32;
        for i in 0..3 { let d = center[i] - self.pts[idx][i]; dist += d * d; }
        if dist < md2 { out.push(idx); }
        // descent_mask(center[dim], md2, idx, dim): dist*dist < md2 + EPSILON(1e-4)
        let dd = center[dim] - self.pts[idx][dim];
        let both = dd * dd < md2 + 1e-4f32;
        let left = node * 2 + 1;
        let nd = if dim + 1 == 3 { 0 } else { dim + 1 };
        let (go_l, go_r) = if both { (true, true) } else if dd > 0.0 { (false, true) } else { (true, false) };
        if go_l { self.visit(left, nd, center, md2, out); }
        if go_r { self.visit(left + 1, nd, center, md2, out); }
    }
    pub fn point(&self, i: usize) -> V3 { self.pts[i] }
}

pub struct Visibility {
    pos: Vec<V3>,
    nrm: Vec<V3>,
    vis: Vec<f32>,
    radius: f32,
    kd: Kd3,
}

impl Visibility {
    /// `aligned_back`: Orca's `spAlignedBack` adds a front-facing bias to every sample.
    pub fn new(tris: &[Tri], aligned_back: bool) -> Option<Visibility> {
        let tris: Vec<Tri> = tris.iter().copied().filter(|t| t.iter().all(|v| v.iter().all(|c| c.is_finite()))).collect();
        if tris.is_empty() { return None; }
        let f32t: Vec<[V3; 3]> = tris.iter().map(|t| [0, 1, 2].map(|i| [(t[i][0] - FRAME_OFFSET[0]) as f32, (t[i][1] - FRAME_OFFSET[1]) as f32, t[i][2] as f32])).collect();
        // ---- sample_its_uniform_parallel ----
        let areas: Vec<f64> = f32t.iter().map(|t| 0.5 * norm(cross(sub(t[1], t[0]), sub(t[2], t[0]))) as f64).collect();
        let mut cum: Vec<(f64, usize)> = Vec::with_capacity(areas.len());
        let mut area_sum = 0.0f32;
        for (i, a) in areas.iter().enumerate() {
            area_sum = (area_sum as f64 + a) as f32; // float += double
            // std::map: a repeated key keeps the first-inserted slot but takes the new value
            if let Some(last) = cum.last_mut() { if last.0 == area_sum as f64 { last.1 = i; continue; } }
            cum.push((area_sum as f64, i));
        }
        if !(area_sum > 0.0) { return None; }
        let mut rng = Mt64::new(27644437);
        let rnd: Vec<[f64; 3]> = (0..SAMPLES).map(|_| { let x = rng.next_f64(); let y = rng.next_f64(); let z = rng.next_f64(); [x, y, z] }).collect();
        let mut pos = Vec::with_capacity(SAMPLES);
        let mut nrm = Vec::with_capacity(SAMPLES);
        for r in &rnd {
            let ts = r[0] * area_sum as f64;
            let k = cum.partition_point(|c| c.0 <= ts);
            let ti = cum[k.min(cum.len() - 1)].1;
            let sq_u = r[1].sqrt();
            let v = r[2];
            let (a, b, c) = (f32t[ti][0], f32t[ti][1], f32t[ti][2]);
            // Eigen: `Vec3f * double` casts the scalar to float; the sum is evaluated in float, left to right
            let w = [(1.0 - sq_u) as f32, (sq_u * (1.0 - v)) as f32, (v * sq_u) as f32];
            let p: V3 = [0, 1, 2].map(|i| a[i] * w[0] + b[i] * w[1] + c[i] * w[2]);
            pos.push(p);
            nrm.push(normalized(cross(sub(b, a), sub(c, b))));
        }
        let density = SAMPLES as f32 / area_sum;
        let search_area = 4.0f32 / (-(0.9f32).ln() * density);
        let radius = (search_area / std::f32::consts::PI).sqrt();
        // ---- raycast_visibility ----
        let step = 1.0f32 / SQR_RAYS as f32;
        let mut dirs: Vec<V3> = Vec::with_capacity(SQR_RAYS * SQR_RAYS);
        for xi in 0..SQR_RAYS {
            let sx = (xi as f32 * step + (step as f64 / 2.0) as f32) as f32;
            for yi in 0..SQR_RAYS {
                let sy = (yi as f32 * step + (step as f64 / 2.0) as f32) as f32;
                dirs.push(sample_hemisphere_uniform(sx, sy));
            }
        }
        let fnorm: Vec<V3> = f32t.iter().map(|t| normalized(cross(sub(t[1], t[0]), sub(t[2], t[1])))).collect();
        let bvh = Bvh::build(f32t.iter().map(|t| {
            // Orca stores float vertices; intersect in double on the float values
            [0, 1, 2].map(|i| [t[i][0] as f64, t[i][1] as f64, t[i][2] as f64])
        }).collect());
        // `bvh.order` indexes the original triangle list, so `first_hit` ids are original ids
        let decrease = 1.0f32 / (SQR_RAYS * SQR_RAYS) as f32;
        // Each sample's visibility depends only on its own position and normal, and its subtractions keep their order,
        // so the parallel map is bit-identical to the serial loop for any thread count (par_map stores by index).
        let samples: Vec<(V3, V3)> = pos.iter().copied().zip(nrm.iter().copied()).collect();
        let vis: Vec<f32> = crate::slice::par_map_chunked(&samples, crate::slice::default_threads(), 256, |_, &(center, normal)| {
            let mut v = 1.0f32;
            if aligned_back {
                let front = ((dot(normal, [0.0, -1.0, 0.0]) + 1.2) * 0.5).clamp(0.0, 1.0);
                v += front;
            }
            let f = Frame::from_z(normal);
            let o32 = add(center, mul(normal, 0.01));
            let o = [o32[0] as f64, o32[1] as f64, o32[2] as f64];
            for d in &dirs {
                let w = f.to_world(*d);
                let dd = [w[0] as f64, w[1] as f64, w[2] as f64];
                if let Some((ti, _t)) = bvh.first_hit(o, dd) {
                    if dot(fnorm[ti], w) <= 0.0 { v -= decrease; }
                }
            }
            v
        });
        let kd = Kd3::build(pos.clone());
        Some(Visibility { pos, nrm, vis, radius, kd })
    }

    /// `calculate_point_visibility` for a point given in BED coordinates (the frame the layers use).
    pub fn at(&self, p: [f64; 3]) -> f64 {
        self.at_f32([(p[0] - FRAME_OFFSET[0]) as f32, (p[1] - FRAME_OFFSET[1]) as f32, p[2] as f32]) as f64
    }

    /// `calculate_point_visibility` for a point in Orca's object frame, evaluated in f32 exactly as Orca does: samples in
    /// KD-tree visit order, `weight = (r - |plane distance|) + (r - distance)`, Eigen's `x + (y + z)` reduction order.
    pub fn at_f32(&self, q: V3) -> f32 {
        let r = self.radius;
        let pts = self.kd.nearby(q, r);
        if pts.is_empty() { return 1.0; }
        let mut total_w = 0.0f32;
        let mut total_v = 0.0f32;
        for &i in &pts {
            let sp = self.pos[i];
            let sn = self.nrm[i];
            let d = sub(q, sp);
            let plane = (d[0] * sn[0] + (d[1] * sn[1] + d[2] * sn[2])).abs();
            let mut w = r - plane;
            let dist = (d[0] * d[0] + (d[1] * d[1] + d[2] * d[2])).sqrt();
            w += r - dist;
            total_v += w * self.vis[i];
            total_w += w;
        }
        total_v / total_w
    }

    pub fn sample_count(&self) -> usize { self.pos.len() }
    pub fn radius(&self) -> f32 { self.radius }
}

// ---- polygon triangulation (ear clipping with hole bridging) ----------------------------------------------------------

type P2 = [f64; 2];

fn area2(a: P2, b: P2, c: P2) -> f64 { (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) }

fn point_in_tri(p: P2, a: P2, b: P2, c: P2) -> bool {
    let (d1, d2, d3) = (area2(a, b, p), area2(b, c, p), area2(c, a, p));
    !((d1 < 0.0 || d2 < 0.0 || d3 < 0.0) && (d1 > 0.0 || d2 > 0.0 || d3 > 0.0))
}

fn ring_area(r: &[P2]) -> f64 { (0..r.len()).map(|i| { let (a, b) = (r[i], r[(i + 1) % r.len()]); a[0] * b[1] - b[0] * a[1] }).sum::<f64>() * 0.5 }

/// Triangulate a polygon with holes. Returns CCW triangles. Degenerate input yields fewer triangles, never a panic.
pub fn triangulate(contour: &[P2], holes: &[Vec<P2>]) -> Vec<[P2; 3]> {
    if contour.len() < 3 { return vec![]; }
    let mut outer: Vec<P2> = contour.to_vec();
    if ring_area(&outer) < 0.0 { outer.reverse(); }
    let mut hs: Vec<Vec<P2>> = holes.iter().filter(|h| h.len() >= 3).map(|h| { let mut h = h.clone(); if ring_area(&h) > 0.0 { h.reverse(); } h }).collect();
    // bridge holes, rightmost hole first
    hs.sort_by(|a, b| {
        let ma = a.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
        let mb = b.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
        mb.total_cmp(&ma)
    });
    for h in &hs {
        // rightmost vertex of the hole
        let (mi, m) = h.iter().enumerate().fold((0usize, h[0]), |acc, (i, p)| if p[0] > acc.1[0] { (i, *p) } else { acc });
        // nearest edge of the outer ring hit by the ray +x from m
        let n = outer.len();
        let mut best: Option<(f64, usize)> = None;
        for i in 0..n {
            let (a, b) = (outer[i], outer[(i + 1) % n]);
            if (a[1] > m[1]) == (b[1] > m[1]) { continue; }
            let t = (m[1] - a[1]) / (b[1] - a[1]);
            let x = a[0] + t * (b[0] - a[0]);
            if x >= m[0] && best.map_or(true, |bb| x < bb.0) { best = Some((x, i)); }
        }
        let Some((ix, ei)) = best else { continue };
        let i_pt = [ix, m[1]];
        let (a, b) = (outer[ei], outer[(ei + 1) % n]);
        let mut pi = if a[0] > b[0] { ei } else { (ei + 1) % n };
        let pp = outer[pi];
        // reflex vertices inside the triangle (m, i, p): pick the one with the smallest angle to the ray
        let mut best_ang = f64::INFINITY;
        for j in 0..n {
            let q = outer[j];
            if j == pi { continue; }
            if point_in_tri(q, m, i_pt, pp) && q != m {
                let ang = ((q[1] - m[1]).abs()).atan2(q[0] - m[0]);
                let prev = outer[(j + n - 1) % n];
                let next = outer[(j + 1) % n];
                let reflex = area2(prev, q, next) < 0.0;
                if reflex && ang < best_ang { best_ang = ang; pi = j; }
            }
        }
        // splice: outer[..=pi], hole from mi around, back to hole[mi], then outer[pi..]
        let mut merged: Vec<P2> = Vec::with_capacity(n + h.len() + 2);
        merged.extend_from_slice(&outer[..=pi]);
        for k in 0..=h.len() { merged.push(h[(mi + k) % h.len()]); }
        merged.push(outer[pi]);
        merged.extend_from_slice(&outer[pi + 1..]);
        outer = merged;
    }
    // ear clipping on the (weakly) simple polygon
    let mut idx: Vec<usize> = (0..outer.len()).collect();
    let mut out = Vec::new();
    let mut guard = 0usize;
    while idx.len() > 3 && guard < 4 * outer.len() * outer.len() + 16 {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for k in 0..m {
            let (ia, ib, ic) = (idx[(k + m - 1) % m], idx[k], idx[(k + 1) % m]);
            let (a, b, c) = (outer[ia], outer[ib], outer[ic]);
            if area2(a, b, c) <= 1e-12 { continue; }
            let mut ear = true;
            for &j in &idx {
                if j == ia || j == ib || j == ic { continue; }
                let q = outer[j];
                if q == a || q == b || q == c { continue; }
                if point_in_tri(q, a, b, c) { ear = false; break; }
            }
            if ear { out.push([a, b, c]); idx.remove(k); clipped = true; break; }
        }
        if !clipped {
            // no ear (numerical trouble or collinear run): drop the flattest vertex
            let mut bk = 0; let mut bv = f64::INFINITY;
            for k in 0..m { let v = area2(outer[idx[(k + m - 1) % m]], outer[idx[k]], outer[idx[(k + 1) % m]]).abs(); if v < bv { bv = v; bk = k; } }
            idx.remove(bk);
        }
    }
    if idx.len() == 3 {
        let (a, b, c) = (outer[idx[0]], outer[idx[1]], outer[idx[2]]);
        if area2(a, b, c) > 1e-12 { out.push([a, b, c]); }
    }
    out
}

// ---- a triangle soup from a stack of layer polygons -----------------------------------------------------------------

/// Occlusion model of the part from its layer polygons: each ring edge of a slab becomes a vertical quad, wound so
/// the normal points out of the solid (outer contours counter-clockwise, holes clockwise); the faces that are
/// exposed between consecutive slabs (`slab[k] - slab[k+1]` upwards, `slab[k] - slab[k-1]` downwards) are
/// triangulated into horizontal faces, and the bottom of the first / top of the last slab are closed. `max_tris` bounds
/// the wall triangle count by merging consecutive layers into one slab (the middle layer's polygons).
pub fn mesh_from_layers(layers: &[(f64, f64, &[crate::types::Poly])], max_tris: usize) -> Vec<Tri> {
    let total_edges: usize = layers.iter().map(|(_, _, polys)| polys.iter().map(|p| p.contour.len() + p.holes.iter().map(|h| h.len()).sum::<usize>()).sum::<usize>()).sum();
    let stride = ((total_edges * 2 + max_tris.max(1) - 1) / max_tris.max(1)).max(1);
    // slabs: (z0, z1, polys)
    let mut slabs: Vec<(f64, f64, &[crate::types::Poly])> = Vec::new();
    let mut i = 0;
    while i < layers.len() {
        let j = (i + stride).min(layers.len());
        let mid = (i + j - 1) / 2;
        slabs.push((layers[i].0 - layers[i].1, layers[j - 1].0, layers[mid].2));
        i = j;
    }
    let mut out = Vec::new();
    for (k, (z0, z1, polys)) in slabs.iter().enumerate() {
        for p in polys.iter() {
            let mut add_ring = |ring: &Vec<[f64; 2]>, ccw_out: bool| {
                let n = ring.len();
                if n < 3 { return; }
                let is_ccw = ring_area(ring) > 0.0;
                let flip = is_ccw != ccw_out;
                for e in 0..n {
                    let (mut a, mut b) = (ring[e], ring[(e + 1) % n]);
                    if flip { std::mem::swap(&mut a, &mut b); }
                    let (a0, b0, a1, b1) = ([a[0], a[1], *z0], [b[0], b[1], *z0], [a[0], a[1], *z1], [b[0], b[1], *z1]);
                    out.push([a0, b0, b1]);
                    out.push([a0, b1, a1]);
                }
            };
            add_ring(&p.contour, true);
            for h in &p.holes { add_ring(h, false); }
        }
        // horizontal faces
        let up: Vec<crate::types::Poly> = match slabs.get(k + 1) { Some(next) => crate::geom::diff(&polys.to_vec(), &next.2.to_vec()), None => polys.to_vec() };
        let down: Vec<crate::types::Poly> = if k == 0 { polys.to_vec() } else { crate::geom::diff(&polys.to_vec(), &slabs[k - 1].2.to_vec()) };
        for p in &up { for t in triangulate(&p.contour, &p.holes) { out.push([[t[0][0], t[0][1], *z1], [t[1][0], t[1][1], *z1], [t[2][0], t[2][1], *z1]]); } }
        for p in &down { for t in triangulate(&p.contour, &p.holes) { out.push([[t[0][0], t[0][1], *z0], [t[2][0], t[2][1], *z0], [t[1][0], t[1][1], *z0]]); } }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mt19937_64_reference_values() {
        // C++ std::mt19937_64 default seed 5489: first output 14514284786278117030, 10000th output 9981545732273789042
        let mut r = Mt64::new(5489);
        assert_eq!(r.next_u64(), 14514284786278117030u64);
        let mut last = 0;
        for _ in 1..10000 { last = r.next_u64(); }
        assert_eq!(last, 9981545732273789042u64);
    }

    fn cube(x0: f64, y0: f64, z0: f64, s: f64) -> Vec<Tri> {
        let p = |x: f64, y: f64, z: f64| [x0 + x * s, y0 + y * s, z0 + z * s];
        let quad = |a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]| vec![[a, b, c], [a, c, d]];
        let mut t = Vec::new();
        t.extend(quad(p(0., 0., 0.), p(0., 1., 0.), p(1., 1., 0.), p(1., 0., 0.))); // bottom, normal -z
        t.extend(quad(p(0., 0., 1.), p(1., 0., 1.), p(1., 1., 1.), p(0., 1., 1.))); // top
        t.extend(quad(p(0., 0., 0.), p(1., 0., 0.), p(1., 0., 1.), p(0., 0., 1.))); // y-
        t.extend(quad(p(1., 1., 0.), p(0., 1., 0.), p(0., 1., 1.), p(1., 1., 1.))); // y+
        t.extend(quad(p(0., 1., 0.), p(0., 0., 0.), p(0., 0., 1.), p(0., 1., 1.))); // x-
        t.extend(quad(p(1., 0., 0.), p(1., 1., 0.), p(1., 1., 1.), p(1., 0., 1.))); // x+
        t
    }

    #[test]
    fn convex_cube_is_fully_visible() {
        let v = Visibility::new(&cube(0.0, 0.0, 0.0, 20.0), false).unwrap();
        for p in [[10.0, 0.0, 10.0], [20.0, 10.0, 5.0], [0.0, 19.0, 15.0]] {
            assert!((v.at(p) - 1.0).abs() < 1e-6, "{:?} {}", p, v.at(p));
        }
    }

    #[test]
    fn point_between_two_close_walls_is_hidden() {
        // two parallel slabs 2 mm apart, 20 mm wide: the gap faces occlude each other
        let mut t = cube(0.0, 0.0, 0.0, 20.0);
        t.extend(cube(22.0, 0.0, 0.0, 20.0));
        let v = Visibility::new(&t, false).unwrap();
        let in_gap = v.at([20.0, 10.0, 10.0]);
        let outside = v.at([0.0, 10.0, 10.0]);
        assert!(outside > 0.99, "{}", outside);
        assert!(in_gap < 0.6, "{}", in_gap);
    }

    #[test]
    fn triangulate_square_with_hole_covers_exact_area() {
        let outer = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let hole = vec![[4.0, 4.0], [4.0, 6.0], [6.0, 6.0], [6.0, 4.0]];
        let tris = triangulate(&outer, &[hole]);
        let a: f64 = tris.iter().map(|t| area2(t[0], t[1], t[2]) * 0.5).sum();
        assert!((a - 96.0).abs() < 1e-9, "area {}", a);
        assert!(tris.iter().all(|t| area2(t[0], t[1], t[2]) > 0.0));
        // a concave "U" and a hole touching the rightmost vertex ordering
        let u = vec![[0.0, 0.0], [9.0, 0.0], [9.0, 9.0], [6.0, 9.0], [6.0, 3.0], [3.0, 3.0], [3.0, 9.0], [0.0, 9.0]];
        let a2: f64 = triangulate(&u, &[]).iter().map(|t| area2(t[0], t[1], t[2]) * 0.5).sum();
        assert!((a2 - (81.0 - 3.0 * 6.0)).abs() < 1e-9, "u area {}", a2);
    }

    #[test]
    fn closed_layer_stack_has_the_volume_of_the_part() {
        use crate::types::Poly;
        let sq = |x0: f64, y0: f64, s: f64| Poly { contour: vec![[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]], holes: vec![] };
        // a block with a smaller block on top (stepped): the caps must close the surface
        let polys: Vec<Vec<Poly>> = (0..10).map(|i| vec![if i < 5 { sq(0.0, 0.0, 10.0) } else { sq(2.0, 2.0, 6.0) }]).collect();
        let layers: Vec<(f64, f64, &[Poly])> = polys.iter().enumerate().map(|(i, p)| (0.2 * (i + 1) as f64, 0.2, p.as_slice())).collect();
        let m = mesh_from_layers(&layers, 100000);
        // divergence theorem: volume = 1/3 sum (centroid . n * area) over a closed outward-oriented surface
        let mut vol = 0.0;
        for t in &m {
            let (a, b, c) = (t[0], t[1], t[2]);
            let n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
            vol += (a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) / 6.0;
        }
        let want = 100.0 * 1.0 + 36.0 * 1.0;
        assert!((vol - want).abs() < 1e-6, "volume {} want {}", vol, want);
    }

    #[test]
    fn layer_stack_mesh_matches_solid_cube_visibility() {
        use crate::types::Poly;
        let sq = |x0: f64, y0: f64, s: f64| Poly { contour: vec![[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]], holes: vec![] };
        let polys: Vec<Vec<Poly>> = (0..50).map(|_| vec![sq(0.0, 0.0, 10.0), sq(12.0, 0.0, 10.0)]).collect();
        let layers: Vec<(f64, f64, &[Poly])> = polys.iter().enumerate().map(|(i, p)| (0.2 * (i + 1) as f64, 0.2, p.as_slice())).collect();
        let m = mesh_from_layers(&layers, 10000);
        assert!(!m.is_empty());
        let v = Visibility::new(&m, false).unwrap();
        assert!(v.at([10.0, 5.0, 5.0]) < 0.8, "wall facing the other block must be occluded: {}", v.at([10.0, 5.0, 5.0]));
        assert!(v.at([0.0, 5.0, 5.0]) > 0.99);
    }
}

#[cfg(test)]
mod exactness_tests {
    use super::*;

    fn cuboid(x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64) -> Vec<Tri> {
        let v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        let f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)];
        f.iter().map(|&(a, b, c)| [v[a], v[b], v[c]]).collect()
    }

    /// The KD tree returns exactly the points within the radius (strict), whatever the pruning does.
    #[test]
    fn kd_tree_nearby_equals_brute_force() {
        let mut seed = 99u64;
        let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((seed >> 40) as f32) / (1u64 << 24) as f32 };
        let pts: Vec<V3> = (0..2000).map(|_| [rnd() * 50.0, rnd() * 50.0, rnd() * 20.0]).collect();
        let kd = Kd3::build(pts.clone());
        for _ in 0..40 {
            let c = [rnd() * 50.0, rnd() * 50.0, rnd() * 20.0];
            let r = 1.0 + rnd() * 8.0;
            let mut got = kd.nearby(c, r); got.sort();
            let want: Vec<usize> = (0..pts.len()).filter(|&i| { let mut d = 0.0f32; for k in 0..3 { let e = c[k] - pts[i][k]; d += e * e; } d < r * r }).collect();
            assert_eq!(got, want);
        }
    }

    /// BVH first-hit visibility of every sample equals a brute-force O(n) ray cast over all triangles.
    #[test]
    fn bvh_visibility_equals_brute_force() {
        let mut tris = cuboid(0.0, 0.0, 0.0, 60.0, 40.0, 2.0);
        tris.extend(cuboid(20.0, 10.0, 2.0, 22.0, 30.0, 14.0));
        tris.extend(cuboid(40.0, 10.0, 2.0, 41.0, 11.0, 9.0));
        let v = Visibility::new(&tris, false).unwrap();
        let step = 1.0f32 / SQR_RAYS as f32;
        let mut dirs = Vec::new();
        for xi in 0..SQR_RAYS { let sx = xi as f32 * step + (step as f64 / 2.0) as f32; for yi in 0..SQR_RAYS { let sy = yi as f32 * step + (step as f64 / 2.0) as f32; dirs.push(sample_hemisphere_uniform(sx, sy)); } }
        let tf: Vec<[V3; 3]> = tris.iter().map(|t| [0, 1, 2].map(|i| [(t[i][0] - FRAME_OFFSET[0]) as f32, (t[i][1] - FRAME_OFFSET[1]) as f32, t[i][2] as f32])).collect();
        let t64: Vec<[[f64; 3]; 3]> = tf.iter().map(|t| [0, 1, 2].map(|i| [t[i][0] as f64, t[i][1] as f64, t[i][2] as f64])).collect();
        let fnorm: Vec<V3> = tf.iter().map(|t| normalized(cross(sub(t[1], t[0]), sub(t[2], t[1])))).collect();
        for s in (0..SAMPLES).step_by(150) {
            let fr = Frame::from_z(v.nrm[s]);
            let o32 = add(v.pos[s], mul(v.nrm[s], 0.01));
            let o = [o32[0] as f64, o32[1] as f64, o32[2] as f64];
            let mut vis = 1.0f32;
            for d in &dirs {
                let w = fr.to_world(*d); let dd = [w[0] as f64, w[1] as f64, w[2] as f64];
                let (mut bt, mut bi) = (f64::INFINITY, usize::MAX);
                for (ti, t) in t64.iter().enumerate() { if let Some(tt) = tri_hit(o, dd, t, 1e-6) { if tt > 0.0 && tt < bt { bt = tt; bi = ti; } } }
                if bi != usize::MAX && dot(fnorm[bi], w) <= 0.0 { vis -= 1.0 / 25.0; }
            }
            assert!((vis - v.vis[s]).abs() < 1e-5, "sample {}: brute {} bvh {}", s, vis, v.vis[s]);
        }
    }

    /// `at` (bed frame) and `at_f32` (object frame) are the same lookup.
    #[test]
    fn bed_and_object_frame_lookups_agree() {
        let mut tris = cuboid(100.0, 100.0, 0.0, 180.0, 150.0, 2.0);
        tris.extend(cuboid(120.0, 110.0, 2.0, 123.0, 113.0, 12.0));
        let v = Visibility::new(&tris, false).unwrap();
        let p = [124.0, 111.5, 6.0];
        let a = v.at(p);
        let b = v.at_f32([(p[0] - FRAME_OFFSET[0]) as f32, (p[1] - FRAME_OFFSET[1]) as f32, p[2] as f32]) as f64;
        assert_eq!(a, b);
        assert!(a > 0.0 && a < 1.0);
    }
}
