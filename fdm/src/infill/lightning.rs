//! Lightning infill (libslic3r/Fill/Lightning/*, from CuraEngine): trees grown from the infill outline,
//! layer by layer from the top down, that support the area above them. Needs the infill region of EVERY layer of
//! the object, so it is generated once with `LightningGenerator::build` and shared through `InfillCtx::lightning`.
use super::adaptive::SegIndex;
use super::bylines::sample_grid_pattern;
use super::gx::{self, P};
use super::Ctx;
use crate::types::{Poly, Polys};

const NM: f64 = 1e6;
type IP = [i64; 2];
const CELL: i64 = 4_000_000; // locator_cell_size() = 4 mm

fn to_ip(p: P) -> IP { [(p[0] * NM).round() as i64, (p[1] * NM).round() as i64] }
fn to_mm(p: IP) -> P { [p[0] as f64 / NM, p[1] as f64 / NM] }
fn dist(a: IP, b: IP) -> f64 { (((a[0] - b[0]) as f64).powi(2) + ((a[1] - b[1]) as f64).powi(2)).sqrt() }
fn dist2(a: IP, b: IP) -> i64 { let (dx, dy) = (a[0] - b[0], a[1] - b[1]); dx * dx + dy * dy }
fn add(a: IP, b: IP) -> IP { [a[0] + b[0], a[1] + b[1]] }
fn sub(a: IP, b: IP) -> IP { [a[0] - b[0], a[1] - b[1]] }
fn trunc(v: [f64; 2]) -> IP { [v[0].trunc() as i64, v[1].trunc() as i64] }
fn normalized(v: [f64; 2]) -> [f64; 2] { let l = (v[0] * v[0] + v[1] * v[1]).sqrt(); if l == 0.0 { v } else { [v[0] / l, v[1] / l] } }
fn hash_mod(p: IP) -> u64 { (((89 * 31 + p[0]).wrapping_mul(31)).wrapping_add(p[1])) as u64 % 191 }

#[derive(Clone, Debug)]
pub struct LightningParams {
    /// `sparse_infill_line_width` (mm).
    pub infill_extrusion_width: f64,
    /// `sparse_infill_density` as a fraction.
    pub density: f64,
    pub multiline: usize,
    /// Nominal object layer height (mm).
    pub layer_height: f64,
    pub overhang_angle_deg: f64,
    pub prune_angle_deg: f64,
    pub straightening_angle_deg: f64,
    /// Origin of object space in the regions' frame (the unsupported-point lattice and hash are phased on object space).
    pub origin: [f64; 2],
}
impl Default for LightningParams {
    fn default() -> Self { LightningParams { infill_extrusion_width: 0.45, density: 0.15, multiline: 1, layer_height: 0.2, overhang_angle_deg: 45.0, prune_angle_deg: 45.0, straightening_angle_deg: 45.0, origin: [0.0, 0.0] } }
}

#[derive(Clone, Debug)]
struct Node { p: IP, parent: Option<usize>, children: Vec<usize>, is_root: bool, last_grounding: Option<IP> }

/// All trees of all layers.
pub struct LightningGenerator { nodes: Vec<Node>, roots: Vec<Vec<usize>>, origin: [f64; 2] }
impl std::fmt::Debug for LightningGenerator { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "LightningGenerator({} layers, {} nodes)", self.roots.len(), self.nodes.len()) } }

// ---------------------------------------------------------------- outline locator (EdgeGrid::Grid)
struct Locator { idx: SegIndex }
impl Locator {
    fn new(rings: &[Vec<IP>]) -> Locator {
        let mut idx = SegIndex::new(CELL as f64);
        for r in rings { if r.len() < 2 { continue; } let mut prev = *r.last().unwrap(); for &p in r { idx.insert((prev, p)); prev = p; } }
        Locator { idx }
    }
    fn resolution(&self) -> i64 { CELL }
    fn collides(&self, a: IP, b: IP) -> bool { !self.idx.intersecting(a, b, &|_| true).is_empty() }
    /// `lineSegmentPolygonsIntersection`, bug for bug: Orca passes the segment END POINT where
    /// `Geometry::segment_segment_intersection` expects a direction vector (`(p1, v1, p2, v2)`), so the "segments" it tests
    /// are the rays p -> 2p, which essentially never intersect. Reproduced as written (`intersection_pt` starts at zero).
    fn segment_intersection(&self, a: IP, b: IP, within_max_dist: i64) -> Option<IP> {
        let mut d2min = f64::MAX;
        let mut intersection_pt = [0.0f64, 0.0f64];
        for id in self.idx.intersecting(a, b, &|_| true) {
            let s = self.idx.segs[id];
            if let Some(ip) = segment_segment_intersection_vec([s.0[0] as f64, s.0[1] as f64], [s.1[0] as f64, s.1[1] as f64], [a[0] as f64, a[1] as f64], [b[0] as f64, b[1] as f64]) {
                let d = (intersection_pt[0] - b[0] as f64).powi(2) + (intersection_pt[1] - b[1] as f64).powi(2);
                if d < d2min { d2min = d; intersection_pt = ip; }
            }
        }
        if d2min < (within_max_dist as f64) * (within_max_dist as f64) { Some([intersection_pt[0] as i64, intersection_pt[1] as i64]) } else { None }
    }
}
/// `Geometry::segment_segment_intersection(p1, v1, p2, v2, res)` (point + direction form).
fn segment_segment_intersection_vec(p1: [f64; 2], v1: [f64; 2], p2: [f64; 2], v2: [f64; 2]) -> Option<[f64; 2]> {
    let mut denom = v1[0] * v2[1] - v2[0] * v1[1];
    if denom.abs() < 1e-4 { return None; }
    let (s12x, s12y) = (p1[0] - p2[0], p1[1] - p2[1]);
    let mut s_numer = v1[0] * s12y - v1[1] * s12x;
    let mut denom_is_positive = false;
    if denom < 0.0 { denom_is_positive = true; denom = -denom; s_numer = -s_numer; }
    if s_numer < 0.0 { return None; }
    let mut t_numer = v2[0] * s12y - v2[1] * s12x;
    if !denom_is_positive { t_numer = -t_numer; }
    if t_numer < 0.0 || s_numer > denom || t_numer > denom { return None; }
    let t = t_numer / denom;
    Some([p1[0] + t * v1[0], p1[1] + t * v1[1]])
}
// ---------------------------------------------------------------- geometry helpers
type Rings = Vec<Vec<IP>>;
fn shift_polys(p: &Polys, d: [f64; 2]) -> Polys {
    p.iter().map(|q| Poly { contour: q.contour.iter().map(|x| [x[0] + d[0], x[1] + d[1]]).collect(), holes: q.holes.iter().map(|h| h.iter().map(|x| [x[0] + d[0], x[1] + d[1]]).collect()).collect() }).collect()
}
fn rings_of(polys: &Polys) -> Rings { gx::rings(polys).iter().map(|r| r.iter().map(|&p| to_ip(p)).collect()).collect() }
fn bbox_of(rings: &Rings) -> Option<(IP, IP)> {
    let mut lo = [i64::MAX; 2]; let mut hi = [i64::MIN; 2];
    for r in rings { for p in r { for k in 0..2 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } } }
    if lo[0] == i64::MAX { None } else { Some((lo, hi)) }
}
/// ClipperLib::PointInPolygon over all rings: boundary -> inside; otherwise even-odd count.
fn inside_outlines(rings: &Rings, p: IP) -> bool {
    let mut count = 0;
    for r in rings {
        let n = r.len();
        if n < 3 { continue; }
        let mut ins = false;
        let mut on = false;
        let mut j = n - 1;
        for i in 0..n {
            let (a, b) = (r[i], r[j]);
            if dist2_pt_seg(p, a, b) == 0 { on = true; }
            if (a[1] > p[1]) != (b[1] > p[1]) && (p[0] as f64) < (b[0] - a[0]) as f64 * (p[1] - a[1]) as f64 / (b[1] - a[1]) as f64 + a[0] as f64 { ins = !ins; }
            j = i;
        }
        if on { return true; }
        if ins { count += 1; }
    }
    count % 2 == 1
}
fn dist2_pt_seg(p: IP, a: IP, b: IP) -> i64 {
    let (v, va) = ([(b[0] - a[0]) as f64, (b[1] - a[1]) as f64], [(p[0] - a[0]) as f64, (p[1] - a[1]) as f64]);
    let l2 = v[0] * v[0] + v[1] * v[1];
    if l2 == 0.0 { return (va[0] * va[0] + va[1] * va[1]) as i64; }
    let t = ((va[0] * v[0] + va[1] * v[1]) / l2).clamp(0.0, 1.0);
    let d = [t * v[0] - va[0], t * v[1] - va[1]];
    (d[0] * d[0] + d[1] * d[1]).round() as i64
}
fn closest_pt_on_seg(p: IP, a: IP, b: IP) -> (f64, IP) {
    let (v, va) = ([(b[0] - a[0]) as f64, (b[1] - a[1]) as f64], [(p[0] - a[0]) as f64, (p[1] - a[1]) as f64]);
    let l2 = v[0] * v[0] + v[1] * v[1];
    if l2 == 0.0 { return (va[0] * va[0] + va[1] * va[1], a); }
    let t = (va[0] * v[0] + va[1] * v[1]) / l2;
    if t <= 0.0 { (va[0] * va[0] + va[1] * va[1], a) }
    else if t >= 1.0 { (((p[0] - b[0]) as f64).powi(2) + ((p[1] - b[1]) as f64).powi(2), b) }
    else { let c = trunc([a[0] as f64 + t * v[0], a[1] as f64 + t * v[1]]); ((t * v[0] - va[0]).powi(2) + (t * v[1] - va[1]).powi(2), c) }
}

// ---------------------------------------------------------------- distance field
struct DistanceField {
    cell_size: i64, supporting_radius: i64, r2: i64, bbox_min: IP, bbox_max: IP,
    cells: Vec<(IP, i64)>, erased: Vec<bool>,
    grid_min: IP, grid_size: IP, grid_data: Vec<usize>, grid_erased: Vec<bool>, have_grid: bool,
}
impl DistanceField {
    fn to_grid(&self, p: IP) -> IP { [(p[0] - self.bbox_min[0]) / self.cell_size, (p[1] - self.bbox_min[1]) / self.cell_size] }
    fn from_grid(&self, g: IP) -> IP { [g[0] * self.cell_size + self.bbox_min[0], g[1] * self.cell_size + self.bbox_min[1]] }
    fn new(radius: i64, outlines_bbox: (IP, IP), overhang: &Polys, _outlines: &Rings) -> DistanceField {
        let cell_size = radius / 6;
        let mut df = DistanceField { cell_size, supporting_radius: radius, r2: radius * radius, bbox_min: outlines_bbox.0, bbox_max: outlines_bbox.1, cells: Vec::new(), erased: Vec::new(), grid_min: [0, 0], grid_size: [0, 0], grid_data: Vec::new(), grid_erased: Vec::new(), have_grid: false };
        let ov_rings = rings_of(overhang);
        if let Some((olo, ohi)) = bbox_of(&ov_rings) {
            // union_ex + opening by half a cell
            let cs = cell_size as f64 / NM;
            let u = gx::union(overhang, &Polys::new());
            let opened = gx::offset(&gx::offset(&u, -cs / 2.0), cs / 2.0);
            for ex in &opened {
                let pts = sample_grid_pattern(ex, cell_size, olo[0], ohi[0] - olo[0]).unwrap_or_default();
                let exr: Vec<Vec<IP>> = gx::rings(&vec![ex.clone()]).iter().map(|r| r.iter().map(|&p| to_ip(p)).collect()).collect();
                for sp in pts {
                    let mut d2 = f64::MAX;
                    for r in &exr { if r.len() > 2 { let mut prev = *r.last().unwrap(); for &p2 in r { d2 = d2.min(closest_pt_on_seg(sp, prev, p2).0); prev = p2; } } }
                    df.cells.push((sp, d2.sqrt() as i64));
                }
            }
        }
        // stable sort with hash tie-break
        let radius_i = radius;
        let mut cells = std::mem::take(&mut df.cells);
        // std::stable_sort with a (non-strict-weak) comparator: emulate with insertion into a merge sort using the same predicate
        cells = stable_sort_by(cells, |a, b| if (b.1 - a.1).abs() > radius_i { a.1 < b.1 } else { hash_mod(a.0) < hash_mod(b.0) });
        df.erased = vec![false; cells.len()];
        // grid
        if !cells.is_empty() {
            let (mut lo, mut hi) = ([i64::MAX; 2], [i64::MIN; 2]);
            for c in &cells { for k in 0..2 { lo[k] = lo[k].min(c.0[k]); hi[k] = hi[k].max(c.0[k]); } }
            df.grid_min = df.to_grid(lo);
            let gmax = df.to_grid(hi);
            df.grid_size = [gmax[0] - df.grid_min[0] + 1, gmax[1] - df.grid_min[1] + 1];
            let n = (df.grid_size[0] * df.grid_size[1]) as usize;
            df.grid_data = vec![usize::MAX; n];
            df.grid_erased = vec![true; n];
            for (i, c) in cells.iter().enumerate() {
                let g = df.to_grid(c.0);
                let flat = (df.grid_size[0] * (g[1] - df.grid_min[1]) + (g[0] - df.grid_min[0])) as usize;
                df.grid_data[flat] = i;
                df.grid_erased[flat] = false;
            }
            df.have_grid = true;
        }
        df.cells = cells;
        df
    }
    fn next_point(&self, start: usize) -> Option<(usize, IP)> {
        for i in start..self.cells.len() { if !self.erased[i] { return Some((i, self.cells[i].0)); } }
        None
    }
    fn update(&mut self, to_node: IP, added_leaf: IP) {
        let v = [(added_leaf[0] - to_node[0]) as f64, (added_leaf[1] - to_node[1]) as f64];
        let l2 = v[0] * v[0] + v[1] * v[1];
        let extent = [-v[1] * self.supporting_radius as f64 / l2.sqrt(), v[0] * self.supporting_radius as f64 / l2.sqrt()];
        let r = self.supporting_radius;
        let iext = trunc(extent);
        let mut lo = [added_leaf[0] - r, added_leaf[1] - r];
        let mut hi = [added_leaf[0] + r, added_leaf[1] + r];
        for q in [sub(to_node, iext), add(to_node, iext), sub(added_leaf, iext), add(added_leaf, iext)] { for k in 0..2 { lo[k] = lo[k].min(q[k]); hi[k] = hi[k].max(q[k]); } }
        // clip by the unsupported-points bbox (the outlines bbox)
        lo[0] = lo[0].max(self.bbox_min[0]); lo[1] = lo[1].max(self.bbox_min[1]);
        hi[0] = hi[0].min(self.bbox_max[0]); hi[1] = hi[1].min(self.bbox_max[1]);
        if !self.have_grid { return; }
        let (g0, g1) = (self.to_grid(lo), self.to_grid(hi));
        for gy in g0[1]..=g1[1] {
            for gx_ in g0[0]..=g1[0] {
                let loc = self.from_grid([gx_, gy]);
                let d2l = { let (dx, dy) = ((loc[0] - added_leaf[0]) as i128, (loc[1] - added_leaf[1]) as i128); dx * dx + dy * dy };
                if d2l > self.r2 as i128 {
                    let vx = [(loc[0] - to_node[0]) as f64, (loc[1] - to_node[1]) as f64];
                    let mut d = v[0] * vx[0] + v[1] * vx[1];
                    if d >= 0.0 && d <= l2 {
                        d = extent[0] * vx[0] + extent[1] * vx[1];
                        if d < -1.0 || d > 1.0 { continue; }
                    }
                }
                // find cell
                if gx_ < self.grid_min[0] || gy < self.grid_min[1] || gx_ >= self.grid_min[0] + self.grid_size[0] || gy >= self.grid_min[1] + self.grid_size[1] { continue; }
                let flat = (self.grid_size[0] * (gy - self.grid_min[1]) + (gx_ - self.grid_min[0])) as usize;
                if !self.grid_erased[flat] {
                    let ci = self.grid_data[flat];
                    let c = self.cells[ci].0;
                    let d2c = { let (dx, dy) = ((c[0] - added_leaf[0]) as i128, (c[1] - added_leaf[1]) as i128); dx * dx + dy * dy };
                    if d2c <= self.r2 as i128 { self.erased[ci] = true; self.grid_erased[flat] = true; }
                }
            }
        }
    }
}

/// libstdc++ `std::stable_sort` (adaptive variant with a (n+1)/2 buffer), ported exactly because the comparator used
/// for the unsupported points is not a strict weak ordering and the result depends on the algorithm.
fn stable_sort_by<T: Clone>(mut v: Vec<T>, less: impl Fn(&T, &T) -> bool + Copy) -> Vec<T> {
    let n = v.len();
    if n < 2 { return v; }
    let buf_size = (n + 1) / 2;
    stable_sort_adaptive(&mut v, 0, n, buf_size, less);
    v
}
fn insertion_sort<T: Clone>(v: &mut [T], first: usize, last: usize, less: impl Fn(&T, &T) -> bool + Copy) {
    if first == last { return; }
    for i in first + 1..last {
        if less(&v[i], &v[first]) {
            let val = v[i].clone();
            for k in (first + 1..=i).rev() { v[k] = v[k - 1].clone(); }
            v[first] = val;
        } else {
            let val = v[i].clone();
            let mut j = i;
            while less(&val, &v[j - 1]) { v[j] = v[j - 1].clone(); j -= 1; }
            v[j] = val;
        }
    }
}
fn move_merge<T: Clone>(src: &[T], mut f1: usize, l1: usize, mut f2: usize, l2: usize, dst: &mut [T], mut r: usize, less: impl Fn(&T, &T) -> bool + Copy) -> usize {
    while f1 != l1 && f2 != l2 {
        if less(&src[f2], &src[f1]) { dst[r] = src[f2].clone(); f2 += 1; } else { dst[r] = src[f1].clone(); f1 += 1; }
        r += 1;
    }
    while f1 != l1 { dst[r] = src[f1].clone(); f1 += 1; r += 1; }
    while f2 != l2 { dst[r] = src[f2].clone(); f2 += 1; r += 1; }
    r
}
fn merge_sort_with_buffer<T: Clone>(v: &mut Vec<T>, first: usize, last: usize, less: impl Fn(&T, &T) -> bool + Copy) {
    let len = last - first;
    let mut buffer: Vec<T> = v[first..last].to_vec();
    let mut step = 7usize;
    // chunk insertion sort
    let mut f = first;
    while last - f >= step { insertion_sort(v, f, f + step, less); f += step; }
    insertion_sort(v, f, last, less);
    while step < len {
        // v[first..last] -> buffer
        {
            let mut f = 0usize;
            let l = len;
            let two = 2 * step;
            let src: Vec<T> = v[first..last].to_vec();
            let mut r = 0usize;
            while l - f >= two { r = move_merge(&src, f, f + step, f + step, f + two, &mut buffer, r, less); f += two; }
            let st = step.min(l - f);
            move_merge(&src, f, f + st, f + st, l, &mut buffer, r, less);
        }
        step *= 2;
        // buffer -> v[first..last]
        {
            let mut f = 0usize;
            let l = len;
            let two = 2 * step;
            let src: Vec<T> = buffer.clone();
            let mut dst: Vec<T> = v[first..last].to_vec();
            let mut r = 0usize;
            while l - f >= two { r = move_merge(&src, f, f + step, f + step, f + two, &mut dst, r, less); f += two; }
            let st = step.min(l - f);
            move_merge(&src, f, f + st, f + st, l, &mut dst, r, less);
            v[first..last].clone_from_slice(&dst);
        }
        step *= 2;
    }
}
fn stable_sort_adaptive<T: Clone>(v: &mut Vec<T>, first: usize, last: usize, buffer_size: usize, less: impl Fn(&T, &T) -> bool + Copy) {
    let len = (last - first + 1) / 2;
    let middle = first + len;
    if len > buffer_size {
        stable_sort_adaptive(v, first, middle, buffer_size, less);
        stable_sort_adaptive(v, middle, last, buffer_size, less);
    } else {
        merge_sort_with_buffer(v, first, middle, less);
        merge_sort_with_buffer(v, middle, last, less);
    }
    // __merge_adaptive
    let (len1, len2) = (middle - first, last - middle);
    if len1 <= len2 && len1 <= buffer_size {
        let buffer: Vec<T> = v[first..middle].to_vec();
        let (mut b, be) = (0usize, buffer.len());
        let (mut m, mut r) = (middle, first);
        while b != be && m != last {
            if less(&v[m], &buffer[b]) { v[r] = v[m].clone(); m += 1; } else { v[r] = buffer[b].clone(); b += 1; }
            r += 1;
        }
        while b != be { v[r] = buffer[b].clone(); b += 1; r += 1; }
    } else if len2 <= buffer_size {
        let buffer: Vec<T> = v[middle..last].to_vec();
        // __move_merge_adaptive_backward(first, middle, buffer, buffer_end, last)
        let (f1, mut l1) = (first, middle);
        let (f2, mut l2) = (0usize, buffer.len());
        let mut result = last;
        if f1 == l1 { for k in (f2..l2).rev() { result -= 1; v[result] = buffer[k].clone(); } return; }
        if f2 == l2 { return; }
        l1 -= 1; l2 -= 1;
        loop {
            if less(&buffer[l2], &v[l1]) {
                result -= 1; v[result] = v[l1].clone();
                if f1 == l1 { for k in (f2..=l2).rev() { result -= 1; v[result] = buffer[k].clone(); } return; }
                l1 -= 1;
            } else {
                result -= 1; v[result] = buffer[l2].clone();
                if f2 == l2 { return; }
                l2 -= 1;
            }
        }
    } else {
        // not reachable with a (n+1)/2 buffer
        let tmp: Vec<T> = v[first..last].to_vec();
        let mut t = tmp;
        t.sort_by(|a, b| if less(a, b) { std::cmp::Ordering::Less } else if less(b, a) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal });
        v[first..last].clone_from_slice(&t);
    }
}

// ---------------------------------------------------------------- tree
impl LightningGenerator {
    fn new_node(&mut self, p: IP, last: Option<IP>) -> usize { self.nodes.push(Node { p, parent: None, children: Vec::new(), is_root: true, last_grounding: last }); self.nodes.len() - 1 }
    fn weighted_distance(&self, n: usize, unsupported: IP, radius: i64) -> i64 {
        let node = &self.nodes[n];
        let valence = (!node.is_root) as usize + node.children.len();
        let boost = if 0 < valence && valence < 4 { 4 * radius } else { 0 };
        dist(node.p, unsupported) as i64 - boost
    }
    fn has_offspring(&self, n: usize, check: usize) -> bool {
        if n == check { return true; }
        self.nodes[n].children.iter().any(|&c| self.has_offspring(c, check))
    }
    fn add_child_node(&mut self, parent: usize, child: usize) -> usize {
        self.nodes[parent].children.push(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[child].is_root = false;
        child
    }
    fn add_child_loc(&mut self, parent: usize, loc: IP) -> usize { let c = self.new_node(loc, None); self.add_child_node(parent, c) }
    fn deep_copy(&mut self, n: usize) -> usize {
        let (p, is_root, last) = (self.nodes[n].p, self.nodes[n].is_root, self.nodes[n].last_grounding);
        let lr = self.new_node(p, None);
        self.nodes[lr].is_root = is_root;
        if is_root { self.nodes[lr].last_grounding = Some(last.unwrap_or(p)); }
        let ch = self.nodes[n].children.clone();
        for c in ch { let cc = self.deep_copy(c); self.nodes[cc].parent = Some(lr); self.nodes[lr].children.push(cc); }
        lr
    }
    fn reroot(&mut self, n: usize, new_parent: Option<usize>) {
        if !self.nodes[n].is_root {
            let old_parent = self.nodes[n].parent.unwrap();
            self.reroot(old_parent, Some(n));
            self.nodes[n].children.push(old_parent);
        }
        if let Some(np) = new_parent {
            self.nodes[n].children.retain(|&c| c != np);
            self.nodes[n].is_root = false;
            self.nodes[n].parent = Some(np);
        } else {
            self.nodes[n].is_root = true;
            self.nodes[n].parent = None;
        }
    }
    fn closest_node(&self, n: usize, loc: IP) -> usize {
        let mut result = n;
        let mut cd = dist(self.nodes[n].p, loc) as i64;
        for &c in &self.nodes[n].children {
            let cand = self.closest_node(c, loc);
            let d = dist(self.nodes[cand].p, loc) as i64;
            if d < cd { cd = d; result = cand; }
        }
        result
    }
    fn visit_nodes(&self, n: usize, f: &mut dyn FnMut(usize)) { f(n); for &c in &self.nodes[n].children { self.visit_nodes(c, f); } }

    fn prune(&mut self, n: usize, pruning_distance: i64) -> i64 {
        if pruning_distance <= 0 { return 0; }
        let mut max_pruned = 0i64;
        let mut i = 0;
        while i < self.nodes[n].children.len() {
            let child = self.nodes[n].children[i];
            let dpc = self.prune(child, pruning_distance);
            if dpc >= pruning_distance { max_pruned = max_pruned.max(dpc); i += 1; }
            else {
                let (a, b) = (self.nodes[n].p, self.nodes[child].p);
                let ba = sub(a, b);
                let ab_len = dist(a, b) as i64;
                if dpc + ab_len <= pruning_distance { max_pruned = max_pruned.max(dpc + ab_len); self.nodes[n].children.remove(i); }
                else {
                    let nv = normalized([ba[0] as f64, ba[1] as f64]);
                    let np = add(b, trunc([nv[0] * (pruning_distance - dpc) as f64, nv[1] * (pruning_distance - dpc) as f64]));
                    max_pruned = max_pruned.max(pruning_distance);
                    self.nodes[child].p = np;
                    i += 1;
                }
            }
        }
        max_pruned
    }

    fn straighten_root(&mut self, n: usize, magnitude: i64, max_remove_colinear_dist: i64) {
        let p = self.nodes[n].p;
        self.straighten(n, magnitude, p, 0, max_remove_colinear_dist * max_remove_colinear_dist);
    }
    /// returns (total_recti_dist, junction_loc)
    fn straighten(&mut self, n: usize, magnitude: i64, junction_above: IP, accumulated_dist: i64, max_remove_colinear_dist2: i64) -> (i64, IP) {
        let junction_magnitude = magnitude * 3 / 4;
        if self.nodes[n].children.len() == 1 {
            let child = self.nodes[n].children[0];
            let child_dist = dist(self.nodes[n].p, self.nodes[child].p) as i64;
            let (total_below, jloc) = self.straighten(child, magnitude, junction_above, accumulated_dist + child_dist, max_remove_colinear_dist2);
            let (a, b) = (junction_above, jloc);
            if a != b {
                let ab = sub(b, a);
                let den = total_below.max(1) as i128;
                let dest = [(a[0] as i128 + ab[0] as i128 * accumulated_dist as i128 / den) as i64, (a[1] as i128 + ab[1] as i128 * accumulated_dist as i128 / den) as i64];
                let mp = self.nodes[n].p;
                if dist2(dest, mp) <= magnitude * magnitude { self.nodes[n].p = dest; }
                else {
                    let nv = normalized([(dest[0] - mp[0]) as f64, (dest[1] - mp[1]) as f64]);
                    self.nodes[n].p = add(mp, trunc([nv[0] * magnitude as f64, nv[1] * magnitude as f64]));
                }
            }
            // remove nodes on linear segments
            let child_p = self.nodes[n].children[0];
            if let Some(parent) = self.nodes[n].parent {
                let pp = self.nodes[parent].p;
                let cp = self.nodes[child_p].p;
                if dist2(cp, pp) < max_remove_colinear_dist2 && closest_pt_on_seg(self.nodes[n].p, pp, cp).0 < 100.0 {
                    self.nodes[child_p].parent = Some(parent);
                    for sib in self.nodes[parent].children.iter_mut() { if *sib == n { *sib = child_p; break; } }
                }
            }
            (total_below, jloc)
        } else {
            let weight = 1000.0;
            let mp = self.nodes[n].p;
            let dir0 = normalized([(junction_above[0] - mp[0]) as f64, (junction_above[1] - mp[1]) as f64]);
            let mut dir = trunc([dir0[0] * weight, dir0[1] * weight]);
            let mut prevent = false;
            let children = self.nodes[n].children.clone();
            for child in children {
                let child_dist = dist(self.nodes[n].p, self.nodes[child].p) as i64;
                let mpn = self.nodes[n].p;
                let (btotal, bloc) = self.straighten(child, magnitude, mpn, child_dist, max_remove_colinear_dist2);
                let d = normalized([(bloc[0] - mpn[0]) as f64, (bloc[1] - mpn[1]) as f64]);
                dir = add(dir, trunc([d[0] * weight, d[1] * weight]));
                if btotal < magnitude { prevent = true; }
            }
            if dir != [0, 0] && !self.nodes[n].children.is_empty() && !self.nodes[n].is_root && !prevent {
                let len = ((dir[0] as f64).powi(2) + (dir[1] as f64).powi(2)).sqrt() as i64;
                if len > junction_magnitude { dir = [dir[0] * junction_magnitude / len, dir[1] * junction_magnitude / len]; }
                self.nodes[n].p = add(self.nodes[n].p, dir);
            }
            (accumulated_dist, self.nodes[n].p)
        }
    }

    fn realign(&mut self, n: usize, outlines: &Rings, locator: &Locator, rerooted: &mut Vec<usize>) -> bool {
        if outlines.is_empty() { return false; }
        let p = self.nodes[n].p;
        if inside_outlines(outlines, p) {
            let mut reground_me = false;
            let children = self.nodes[n].children.clone();
            let mut keep: Vec<usize> = Vec::new();
            for child in children {
                let mut connect = self.realign(child, outlines, locator, rerooted);
                let cp = self.nodes[child].p;
                if connect && locator.segment_intersection(cp, p, locator.resolution() * 2).is_some() {
                    self.nodes[child].last_grounding = None;
                    self.nodes[child].parent = None;
                    self.nodes[child].is_root = true;
                    rerooted.push(child);
                    reground_me = true;
                    connect = false;
                }
                if connect { keep.push(child); }
            }
            self.nodes[n].children = keep;
            if reground_me { self.nodes[n].last_grounding = None; }
            return true;
        }
        let children = self.nodes[n].children.clone();
        for child in children {
            if self.realign(child, outlines, locator, rerooted) {
                self.nodes[child].last_grounding = Some(p);
                self.nodes[child].parent = None;
                self.nodes[child].is_root = true;
                rerooted.push(child);
            }
        }
        self.nodes[n].children.clear();
        false
    }

    fn propagate(&mut self, root: usize, next_trees: &mut Vec<usize>, next_outlines: &Rings, locator: &Locator, prune: i64, smooth: i64, max_colinear: i64) {
        let below = self.deep_copy(root);
        self.prune(below, prune);
        self.straighten_root(below, smooth, max_colinear);
        if self.realign(below, next_outlines, locator, next_trees) { next_trees.push(below); }
    }

    fn convert_to_polylines(&self, root: usize, overlap: i64, rng: &mut u64, out: &mut Vec<Vec<IP>>) {
        let mut result: Vec<Vec<IP>> = vec![Vec::new()];
        self.conv(root, 0, &mut result, rng);
        // removeJunctionOverlap
        let mut i = 0;
        while i < result.len() {
            if result[i].len() <= 1 { let last = result.pop().unwrap(); if i < result.len() { result[i] = last; } continue; }
            let mut to_be_reduced = overlap;
            let mut a = *result[i].last().unwrap();
            let mut k = result[i].len() as i64 - 2;
            while k >= 0 {
                let b = result[i][k as usize];
                let ab = sub(b, a);
                let ab_len = ((ab[0] as f64).powi(2) + (ab[1] as f64).powi(2)).sqrt() as i64;
                if ab_len >= to_be_reduced {
                    let f = to_be_reduced as f64 / ab_len as f64;
                    let l = result[i].len();
                    result[i][l - 1] = add(a, trunc([ab[0] as f64 * f, ab[1] as f64 * f]));
                    break;
                } else { to_be_reduced -= ab_len; result[i].pop(); }
                a = b;
                k -= 1;
            }
            if result[i].len() <= 1 { let last = result.pop().unwrap(); if i < result.len() { result[i] = last; } } else { i += 1; }
        }
        out.extend(result);
    }
    fn conv(&self, n: usize, long_idx: usize, out: &mut Vec<Vec<IP>>, rng: &mut u64) {
        let node = &self.nodes[n];
        if node.children.is_empty() { out[long_idx].push(node.p); return; }
        *rng ^= *rng << 13; *rng ^= *rng >> 7; *rng ^= *rng << 17; // xorshift64: deterministic stand-in for rand()
        let first = (*rng as usize) % node.children.len();
        self.conv(node.children[first], long_idx, out, rng);
        out[long_idx].push(node.p);
        for off in 1..node.children.len() {
            let ci = (first + off) % node.children.len();
            out.push(Vec::new());
            let li = out.len() - 1;
            self.conv(node.children[ci], li, out, rng);
            out[li].push(node.p);
        }
    }
}

// ---------------------------------------------------------------- per-layer tree growth
struct GroundingLocation { tree_node: Option<usize>, boundary: Option<IP> }
impl GroundingLocation { fn p(&self, g: &LightningGenerator) -> IP { match self.tree_node { Some(n) => g.nodes[n].p, None => self.boundary.unwrap() } } }

struct NodeGrid { cells: std::collections::HashMap<(i64, i64), Vec<usize>>, bbox_min: IP }
impl NodeGrid {
    fn key(&self, p: IP) -> (i64, i64) { ((p[0] - self.bbox_min[0]) / CELL, (p[1] - self.bbox_min[1]) / CELL) }
    fn insert(&mut self, p: IP, n: usize) { let k = self.key(p); self.cells.entry(k).or_default().insert(0, n); } // newest first, like unordered_multimap groups
}

#[allow(clippy::too_many_arguments)]
fn best_grounding(g: &LightningGenerator, unsupported: IP, outlines: &Rings, _bbox_min: IP, locator: &Locator, supporting_radius: i64, wall_supporting_radius: i64, grid: &NodeGrid, exclude: Option<usize>) -> GroundingLocation {
    // closest point on the outlines
    let mut node_location = [0i64; 2];
    let mut d2 = f64::MAX;
    for r in outlines { if r.len() > 2 { let mut prev = *r.last().unwrap(); for &p2 in r { let (d, c) = closest_pt_on_seg(unsupported, prev, p2); if d < d2 { d2 = d; node_location = c; } prev = p2; } } }
    let within_dist = dist(node_location, unsupported) as i64;
    let mut sub_tree: Option<usize> = None;
    let mut current_dist = dist(node_location, unsupported) as i64;
    if current_dist >= wall_supporting_radius {
        let search_radius = current_dist.min(within_dist);
        let lo = [unsupported[0] - search_radius, unsupported[1] - search_radius];
        let hi = [unsupported[0] + search_radius + CELL, unsupported[1] + search_radius + CELL];
        let (gl, gh) = (grid.key(lo), grid.key(hi));
        let mut grid_addr = (i64::MIN, i64::MIN);
        for gy in gl.1..gh.1 {
            for gxa in gl.0..gh.0 {
                let mut local_sub: Option<usize> = None;
                let mut local_dist = current_dist;
                if let Some(v) = grid.cells.get(&(gxa, gy)) {
                    for &cand in v {
                        if Some(cand) != exclude && !exclude.map_or(false, |e| g.has_offspring(e, cand)) && !locator.collides(unsupported, g.nodes[cand].p) {
                            let cd = g.weighted_distance(cand, unsupported, supporting_radius);
                            if cd < local_dist { local_dist = cd; local_sub = Some(cand); }
                        }
                    }
                }
                if local_dist < current_dist || (local_dist == current_dist && (gy < grid_addr.1 || (gy == grid_addr.1 && gxa < grid_addr.0))) {
                    current_dist = local_dist;
                    sub_tree = local_sub;
                    grid_addr = (gxa, gy);
                }
            }
        }
    }
    match sub_tree { Some(t) => GroundingLocation { tree_node: Some(t), boundary: None }, None => GroundingLocation { tree_node: None, boundary: Some(node_location) } }
}

struct Params { supporting_radius: i64, wall_supporting_radius: i64, prune_length: i64, straightening_max: i64 }

impl LightningGenerator {
    /// `Generator(print_object)`: `infill_regions[i]` is the union of the internal and internal-void surfaces of layer i
    /// (layer 0 = lowest object layer).
    pub fn build(infill_regions: &[Polys], lp: &LightningParams) -> LightningGenerator {
        let n_layers = infill_regions.len();
        let width_nm = (lp.infill_extrusion_width * NM) as i64;
        let layer_thickness = lp.layer_height * NM;
        let supporting_radius = ((width_nm as f64) * 100.0 * lp.multiline as f64 / (lp.density * 100.0)) as i64;
        let params = Params {
            supporting_radius,
            wall_supporting_radius: (layer_thickness * (lp.overhang_angle_deg.to_radians()).tan()) as i64,
            prune_length: (layer_thickness * (lp.prune_angle_deg.to_radians()).tan()) as i64,
            straightening_max: (layer_thickness * (lp.straightening_angle_deg.to_radians()).tan()) as i64,
        };
        let mut g = LightningGenerator { nodes: Vec::new(), roots: vec![Vec::new(); n_layers], origin: lp.origin };
        // work in object space
        let shifted: Vec<Polys> = infill_regions.iter().map(|r| shift_polys(r, [-lp.origin[0], -lp.origin[1]])).collect();
        let infill_regions = &shifted[..];
        if n_layers == 0 { return g; }
        // initial internal overhangs, top to bottom
        let mut overhang: Vec<Polys> = vec![Polys::new(); n_layers];
        let mut above = Polys::new();
        for l in (0..n_layers).rev() {
            let here = infill_regions[l].clone();
            let shrunk = gx::offset(&here, -(params.wall_supporting_radius as f64) / NM);
            overhang[l] = gx::diff(&shrunk, &above);
            above = here;
        }
        let outlines: Vec<Rings> = infill_regions.iter().map(rings_of).collect();
        let top = n_layers - 1;
        let mut locator = Locator::new(&outlines[top]);
        let mut rng: u64 = 0x2545F4914F6CDD1D;
        let _ = &mut rng;
        for layer_id in (0..=top).rev() {
            let current = &outlines[layer_id];
            let bbox = bbox_of(current);
            let bbox_min = bbox.map(|b| b.0).unwrap_or([0, 0]);
            let to_reconnect = g.roots[layer_id].clone();
            g.generate_new_trees(layer_id, &overhang[layer_id], current, bbox.unwrap_or(([0, 0], [0, 0])), &locator, &params);
            g.reconnect_roots(layer_id, to_reconnect, current, bbox_min, &locator, &params);
            if layer_id == 0 { break; }
            let below = &outlines[layer_id - 1];
            let mut below_bbox = bbox_of(below).map(|(lo, hi)| (sub(lo, [100, 100]), add(hi, [100, 100])));
            // merge with the locator's extent (approximated by the current outlines bbox) and the trees
            if let Some((lo, hi)) = bbox_of(current) { below_bbox = Some(match below_bbox { Some((l2, h2)) => ([l2[0].min(lo[0] - 100), l2[1].min(lo[1] - 100)], [h2[0].max(hi[0] + 100), h2[1].max(hi[1] + 100)]), None => (lo, hi) }); }
            let _ = below_bbox;
            locator = Locator::new(below);
            let roots = g.roots[layer_id].clone();
            let mut lower: Vec<usize> = g.roots[layer_id - 1].clone();
            for r in roots { g.propagate(r, &mut lower, below, &locator, params.prune_length, params.straightening_max, CELL / 2); }
            g.roots[layer_id - 1] = lower;
        }
        g
    }

    fn fill_locator(&self, layer: usize, bbox_min: IP) -> NodeGrid {
        let mut grid = NodeGrid { cells: std::collections::HashMap::new(), bbox_min };
        let roots = self.roots[layer].clone();
        let mut visits: Vec<usize> = Vec::new();
        for r in roots { self.visit_nodes(r, &mut |n| visits.push(n)); }
        for n in visits { let p = self.nodes[n].p; grid.insert(p, n); }
        grid
    }

    fn generate_new_trees(&mut self, layer: usize, overhang: &Polys, outlines: &Rings, bbox: (IP, IP), locator: &Locator, prm: &Params) {
        let bbox_min = bbox.0;
        let mut df = DistanceField::new(prm.supporting_radius, bbox, overhang, outlines);
        let mut grid = self.fill_locator(layer, bbox_min);
        let mut idx = 0usize;
        while let Some((ci, loc)) = df.next_point(idx) {
            idx = ci;
            let gl = best_grounding(self, loc, outlines, bbox_min, locator, prm.supporting_radius, prm.wall_supporting_radius, &grid, None);
            let (new_child, new_parent);
            if let Some(b) = gl.boundary {
                let root = self.new_node(b, Some(b));
                let child = self.add_child_loc(root, loc);
                self.roots[layer].push(root);
                new_parent = Some(root);
                new_child = child;
            } else {
                let t = gl.tree_node.unwrap();
                new_child = self.add_child_loc(t, loc);
                new_parent = None;
            }
            grid.insert(self.nodes[new_child].p, new_child);
            if let Some(p) = new_parent { grid.insert(self.nodes[p].p, p); }
            let gp = gl.p(self);
            df.update(gp, loc);
        }
    }

    fn reconnect_roots(&mut self, layer: usize, to_reconnect: Vec<usize>, outlines: &Rings, bbox_min: IP, locator: &Locator, prm: &Params) {
        let mut grid = self.fill_locator(layer, bbox_min);
        let within_max_dist = locator.resolution() * 2;
        for root in to_reconnect {
            let Some(old_pos) = self.roots[layer].iter().position(|&r| r == root) else { continue };
            if let Some(ground_loc) = self.nodes[root].last_grounding {
                let rp = self.nodes[root].p;
                if ground_loc != rp {
                    if let Some(new_root_pt) = locator.segment_intersection(rp, ground_loc, within_max_dist) {
                        let new_root = self.new_node(new_root_pt, Some(new_root_pt));
                        self.add_child_node(new_root, root);
                        // `root_ptr->addChild(new_root); new_root->reroot()` : new_root becomes the root of the tree
                        // (addChild appended new_root under root, reroot flips the tree so new_root is on top)
                        self.nodes[root].children.retain(|&c| c != new_root);
                        self.nodes[new_root].parent = None;
                        self.nodes[new_root].children = vec![root];
                        self.nodes[new_root].is_root = true;
                        self.nodes[root].parent = Some(new_root);
                        self.nodes[root].is_root = false;
                        grid.insert(new_root_pt, new_root);
                        self.roots[layer][old_pos] = new_root;
                        continue;
                    }
                }
            }
            let ignore_width = prm.wall_supporting_radius - 100;
            let rp = self.nodes[root].p;
            let ground = best_grounding(self, rp, outlines, bbox_min, locator, prm.supporting_radius, ignore_width, &grid, Some(root));
            if let Some(b) = ground.boundary {
                if b == self.nodes[root].p { continue; }
                let new_root = self.new_node(b, Some(b));
                let attach = self.closest_node(root, b);
                self.reroot(attach, None);
                self.add_child_node(new_root, attach);
                grid.insert(b, new_root);
                self.roots[layer][old_pos] = new_root;
            } else {
                let t = ground.tree_node.unwrap();
                let attach = self.closest_node(root, self.nodes[t].p);
                self.reroot(attach, None);
                self.add_child_node(t, attach);
                let last = self.roots[layer].pop().unwrap();
                if old_pos < self.roots[layer].len() { self.roots[layer][old_pos] = last; }
            }
        }
    }

    #[doc(hidden)]
    pub fn debug_dump(&self, layer: usize) -> Vec<(P, Vec<P>)> {
        let o = self.origin;
        let mut out = Vec::new();
        for &r in &self.roots[layer] { self.visit_nodes(r, &mut |n| { let p = to_mm(self.nodes[n].p); out.push(([p[0] + o[0], p[1] + o[1]], self.nodes[n].children.iter().map(|&c| { let q = to_mm(self.nodes[c].p); [q[0] + o[0], q[1] + o[1]] }).collect())); }); }
        out
    }
    #[doc(hidden)]
    pub fn debug_layer(&self, layer: usize) -> (usize, usize, f64) {
        let roots = &self.roots[layer];
        let mut nodes = 0usize; let mut len = 0.0;
        for &r in roots { self.visit_nodes(r, &mut |n| { nodes += 1; for &c in &self.nodes[n].children { len += dist(self.nodes[n].p, self.nodes[c].p); } }); }
        (roots.len(), nodes, len / NM)
    }

    /// `Layer::convertToLines`: all trees of a layer as polylines (mm) clipped to `limit_to`.
    pub fn convert_to_lines(&self, layer: usize, limit_to: &Polys, line_overlap: f64) -> Vec<Vec<P>> {
        let Some(roots) = self.roots.get(layer) else { return Vec::new() };
        if roots.is_empty() { return Vec::new(); }
        let mut result: Vec<Vec<IP>> = Vec::new();
        let mut rng: u64 = 0x2545F4914F6CDD1D ^ (layer as u64).wrapping_mul(0x9E3779B97F4A7C15) | 1;
        for &r in roots { self.convert_to_polylines(r, (line_overlap * NM) as i64, &mut rng, &mut result); }
        let o = self.origin;
        let lines: Vec<Vec<P>> = result.into_iter().map(|pl| pl.into_iter().map(|q| { let m = to_mm(q); [m[0] + o[0], m[1] + o[1]] }).collect()).collect();
        gx::clip_lines(&lines, limit_to)
    }
}

/// `FillLightning::Filler::_fill_surface_single` for one (contracted) ExPolygon.
pub(super) fn fill_lightning(poly: &Poly, cx: &Ctx, gen: &LightningGenerator) -> Vec<Vec<P>> {
    let o = cx.origin;
    let region = vec![poly.clone()];
    // overlap = 0.5 * spacing - overlap(0)
    let mut lines = gen.convert_to_lines(cx.layer_id, &region, 0.5 * cx.spacing);
    let _ = o;
    if cx.multiline > 1 { lines = gx::clip_lines(&super::rect::multiline_offsets_pub(lines, cx.multiline, cx.spacing), &region); }
    if lines.is_empty() { return lines; }
    super::rect::clipper_order(&mut lines);
    if cx.anchor_max < 0.05 { super::chain_polylines(lines, None) }
    else { super::connect::connect_infill(lines, &gx::rings(&region), cx.spacing, cx.anchor, cx.anchor_max, cx.multiline) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ported_stable_sort_matches_std_for_a_strict_weak_order() {
        // xorshift data, many ties: for a strict weak ordering libstdc++'s stable_sort and a stable sort agree
        let mut s = 0x9E3779B97F4A7C15u64;
        for n in [0usize, 1, 2, 7, 8, 15, 16, 33, 100, 257, 1000] {
            let v: Vec<(u64, usize)> = (0..n).map(|i| { s ^= s << 13; s ^= s >> 7; s ^= s << 17; (s % 17, i) }).collect();
            let mut want = v.clone();
            want.sort_by_key(|x| x.0);
            let got = stable_sort_by(v, |a: &(u64, usize), b: &(u64, usize)| a.0 < b.0);
            assert_eq!(got, want, "n = {n}");
        }
    }
    #[test]
    fn straight_down_tree_is_pruned_one_layer_height_per_layer() {
        // a thin 30 mm bar: one tree from the top layer, losing 0.2 mm of every leaf per layer going down
        let bar = vec![Poly { contour: vec![[30.0, 5.0], [0.0, 5.0], [0.0, 0.0], [30.0, 0.0]], holes: vec![] }; 1];
        let regions = vec![bar; 40];
        let g = LightningGenerator::build(&regions, &LightningParams::default());
        let (_, _, top) = g.debug_layer(39);
        let (_, _, below) = g.debug_layer(35);
        assert!(top > 0.0);
        assert!(below < top, "pruning must shorten the trees going down: {top} -> {below}");
    }
}
