//! Lane 1: layer stack + mesh slicing.
//!
//! Layer stack = port of Orca `generate_object_layers` (Slicing.cpp): first layer is
//! `initial_layer_print_height`, then `layer_height` (or an optional variable height profile); the loop
//! stops when the layer mid-plane would be at/above the object top, so a final sliver is dropped exactly
//! like Orca. Each layer is cut at its mid-plane. Triangles are cut with a half-open rule (a vertex ON
//! the plane counts as above), so an edge-shared point is computed identically by both neighbours and
//! loops chain topologically (by mesh edge), not by coordinate guessing. Only loops that fail to chain
//! topologically (open/non-manifold input) go through the tolerant geometric pass, and loops that still
//! do not close are REPORTED in `SliceResult::open_loops`, never silently dropped.
use crate::config::Config;
use crate::geom;
use crate::mesh::{FxBuild, Mesh};
use crate::types::{FdmError, Layer, Ring};
use std::collections::HashMap;

const MIN_LAYER_HEIGHT_DEFAULT: f64 = 0.07; // Orca MIN_LAYER_HEIGHT_DEFAULT
const MIN_LAYER_HEIGHT: f64 = 0.01; // Orca MIN_LAYER_HEIGHT

/// One layer of the stack: spans `lo..hi`, sliced at `slice_z = (lo+hi)/2`; `hi` is the print Z.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerSpec { pub lo: f64, pub hi: f64, pub slice_z: f64 }
impl LayerSpec { pub fn h(&self) -> f64 { self.hi - self.lo } }

#[derive(Clone, Debug)]
pub struct StackParams {
    pub initial_layer_height: f64,
    pub layer_height: f64,
    /// Orca `min_layer_height` of the used extruder (0 = default 0.07).
    pub min_layer_height: f64,
    pub object_height: f64,
    /// Optional variable-height profile, flattened `[z0, h0, z1, h1, ...]` like Orca's `layer_height_profile`.
    pub profile: Option<Vec<f64>>,
}

/// Port of Orca `generate_object_layers` (no raft, no XYZ shrinkage compensation, no precise_z_height).
pub fn layer_stack(p: &StackParams) -> Result<Vec<LayerSpec>, FdmError> {
    if !(p.layer_height > 0.0) || !(p.initial_layer_height > 0.0) || !(p.object_height > 0.0) {
        return Err(FdmError::Geometry(format!("bad layer stack parameters {p:?}")));
    }
    let mut min_h = if p.min_layer_height == 0.0 { MIN_LAYER_HEIGHT_DEFAULT } else { p.min_layer_height.max(MIN_LAYER_HEIGHT) };
    min_h = min_h.min(p.layer_height);
    let default_profile = [0.0, p.layer_height, p.object_height, p.layer_height];
    let prof: &[f64] = p.profile.as_deref().unwrap_or(&default_profile);
    if prof.len() < 2 || prof.len() % 2 != 0 { return Err(FdmError::Geometry("layer height profile must be (z,h) pairs".into())); }
    let mut out = Vec::new();
    let mut print_z = p.initial_layer_height;
    out.push((0.0, print_z));
    let mut idx = 0usize;
    let mut slice_z = print_z + 0.5 * min_h;
    while slice_z < p.object_height {
        let mut height = min_h;
        if idx < prof.len() {
            let mut next = idx + 2;
            loop {
                if next >= prof.len() || slice_z < prof[next] { break; }
                idx = next;
                next += 2;
            }
            let (z1, h1) = (prof[idx], prof[idx + 1]);
            height = h1;
            if next < prof.len() {
                let (z2, h2) = (prof[next], prof[next + 1]);
                height = h1 + (h2 - h1) * (slice_z - z1) / (z2 - z1);
            }
        }
        if !(height > 0.0) { return Err(FdmError::Geometry(format!("non-positive layer height {height} at z={print_z}"))); }
        slice_z = print_z + 0.5 * height;
        if slice_z >= p.object_height { break; }
        out.push((print_z, print_z + height));
        print_z += height;
        slice_z = print_z + 0.5 * min_h;
    }
    Ok(out.into_iter().map(|(lo, hi)| LayerSpec { lo, hi, slice_z: 0.5 * (lo + hi) }).collect())
}

/// `raft_layers` of the config (0 when absent). A raft changes the OBJECT stack (see `stack_from_config`) and shifts every
/// object layer up by `supports::generate(..).object_z_shift`; print z of object layer i = `spec.hi + object_z_shift`.
/// Layer ids of the object layers start at `raft_layers` (Orca `Layer::id()` counts the raft layers).
pub fn raft_layers(cfg: &Config) -> Result<i64, FdmError> {
    if cfg.contains("raft_layers") { cfg.i64("raft_layers") } else { Ok(0) }
}

/// Stack from a Config (`layer_height`, `initial_layer_print_height`, `min_layer_height`, `raft_layers`). Refuses what it
/// does not model (`precise_z_height`, adaptive layers, non-regular slicing_mode).
///
/// RAFT API (2026-10-14): `raft_layers > 0` is accepted: the returned stack is the object stack (first layer =
/// `layer_height`), unshifted, relative to the object bottom. `supports::generate` yields `object_z_shift` and
/// `first_object_layer_height`; `pipeline::interleave` applies them. Callers no longer need to hand the slicer a config
/// with the raft removed; the other lanes (walls/surfaces/infill) still read `raft_layers` for `Layer::id()` and
/// `initial_layer_print_height` for the first object layer, which the pipeline workaround keeps correct.
pub fn stack_from_config(cfg: &Config, object_height: f64) -> Result<Vec<LayerSpec>, FdmError> {
    if cfg.contains("precise_z_height") && cfg.bool_("precise_z_height")? { return Err(FdmError::Unsupported("precise_z_height".into())); }
    if cfg.contains("adaptive_layer_height") && cfg.bool_("adaptive_layer_height")? { return Err(FdmError::Unsupported("adaptive_layer_height (pass a profile via StackParams)".into())); }
    if cfg.contains("slicing_mode") { let m = cfg.enum_("slicing_mode")?; if m != "regular" { return Err(FdmError::Unsupported(format!("slicing_mode={m}"))); } }
    // Raft (Orca SlicingParameters::create_from_config): `first_object_layer_height = layer_height` and the first object
    // layer is NOT fixed (`first_object_layer_height_fixed() == !has_raft()`), so the object stack is a plain stack of
    // `layer_height` layers starting at z=0 of the object; the raft below carries `initial_layer_print_height`
    // (see `raft_layers`/`raft_object_shift`; the supports module owns the raft layers themselves).
    let initial = if raft_layers(cfg)? > 0 { cfg.f64("layer_height")? } else { cfg.f64("initial_layer_print_height")? };
    layer_stack(&StackParams {
        initial_layer_height: initial,
        layer_height: cfg.f64("layer_height")?,
        min_layer_height: if cfg.contains("min_layer_height") { cfg.f64("min_layer_height")? } else { 0.0 },
        object_height,
        profile: None,
    })
}

// ---------------------------------------------------------------- slicing
/// A loop that could not be closed.
#[derive(Clone, Debug)]
pub struct OpenLoop { pub layer: usize, pub points: Ring, /// distance between the loose ends (mm)
    pub gap: f64 }

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayerReport {
    pub loops_topological: usize,
    pub loops_gap_closed: usize,
    pub open_loops: usize,
    /// Closed rings with < 3 distinct points (dropped, counted).
    pub degenerate_loops: usize,
    pub segments: usize,
}

#[derive(Clone, Debug, Default)]
pub struct SliceResult {
    pub layers: Vec<Layer>,
    pub reports: Vec<LayerReport>,
    pub open_loops: Vec<OpenLoop>,
}
impl SliceResult {
    #[cfg(test)] fn clone_for_test(&self) -> SliceResult { SliceResult { layers: self.layers.clone(), reports: self.reports.clone(), open_loops: self.open_loops.clone() } }
    pub fn total_open_loops(&self) -> usize { self.open_loops.len() }
}

#[derive(Clone, Copy, Debug)]
pub struct SliceOptions {
    /// Max distance (mm) at which two loose ends are joined geometrically.
    pub gap_tol: f64,
    /// Orca `slice_closing_radius` (mm): after the union the layer is closed with offset2(+r, -r) (Miter 3), exactly
    /// like `make_expolygons` in TriangleMeshSlicer.cpp. 0 = off.
    pub closing_radius: f64,
    /// Douglas-Peucker tolerance (mm) applied to every sliced ExPolygon, Orca `params.resolution`: 0.0025 when the
    /// config `resolution` > 0.001, else 0 (PrintObjectSlice.cpp). 0 = off.
    pub simplify_tol: f64,
}
impl Default for SliceOptions { fn default() -> Self { SliceOptions { gap_tol: 1e-4, closing_radius: 0.0, simplify_tol: 0.0 } } }
impl SliceOptions {
    /// Options from the Orca keys `slice_closing_radius` and `resolution` (missing keys = off).
    pub fn from_config(cfg: &Config) -> SliceOptions {
        let mut o = SliceOptions::default();
        if cfg.contains("slice_closing_radius") { o.closing_radius = cfg.f64("slice_closing_radius").unwrap_or(0.0).max(0.0); }
        if cfg.contains("resolution") && cfg.f64("resolution").unwrap_or(0.0) > 0.001 { o.simplify_tol = 0.0025; }
        o
    }
}

/// Orca `make_expolygons` for slicing_mode=regular: the oriented loops (outer CCW, hole CW, as chained from the
/// outward-wound mesh) are unioned with the NON-ZERO rule (overlapping shells merge, holes are subtracted), then
/// closed by offset2(+r, -r), then simplified. Pure function of its inputs.
fn regions_from_loops(rings: Vec<Ring>, opt: &SliceOptions) -> Vec<crate::types::Poly> {
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::float::simplify::SimplifyShape;
    let rs: Vec<Ring> = rings.into_iter().filter(|r| r.len() >= 3).collect();
    if rs.is_empty() { return vec![]; }
    let shapes = rs.simplify_shape(FillRule::NonZero);
    let mut polys: Vec<crate::types::Poly> = shapes.into_iter().filter_map(|mut sh| {
        if sh.is_empty() { return None; }
        let contour = sh.remove(0);
        Some(crate::types::Poly { contour, holes: sh })
    }).collect();
    polys = geom::normalize(&polys);
    // The offset round trip (geom::offset_ex, i_overlay) leaves ZERO-AREA 3-vertex slivers (measured: kinect scan layer 722,
    // 1 real region + 4 slivers of area < 1e-5 mm^2; they fragment the walls downstream). Clipper never emits those, so
    // islands/holes below 1e-4 mm^2 (a 10 um square) are dropped after each geometric step.
    const SLIVER_MM2: f64 = 1e-4;
    if opt.closing_radius > 0.0 { polys = geom::clean(&geom::closing(&polys, opt.closing_radius), SLIVER_MM2); }
    if opt.simplify_tol > 0.0 { polys = geom::clean(&geom::simplify(&polys, opt.simplify_tol), SLIVER_MM2); }
    polys
}

type EdgeKey = (u32, u32);
#[derive(Clone, Copy)]
struct Seg { a: [f64; 2], b: [f64; 2], ka: EdgeKey, kb: EdgeKey }

fn cut_edge(mesh: &Mesh, i: u32, j: u32, s: f64) -> ([f64; 2], EdgeKey) {
    // canonical direction so both triangles sharing the edge compute a bit-identical point
    let (lo, hi) = if i < j { (i, j) } else { (j, i) };
    let (p, q) = (mesh.verts[lo as usize], mesh.verts[hi as usize]);
    let t = (s - p[2]) / (q[2] - p[2]);
    ([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])], (lo, hi))
}

// ---------------------------------------------------------------- parallelism (lane 10)
/// Thread count used by [`slice_mesh`]: env `FDM_THREADS` when set (>= 1), else the hardware parallelism;
/// always 1 on wasm32. Results never depend on it (see [`slice_mesh_threads`]).
pub fn default_threads() -> usize {
    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Some(n) = std::env::var("FDM_THREADS").ok().and_then(|s| s.trim().parse::<usize>().ok()).filter(|&n| n >= 1) { return n; }
        std::thread::available_parallelism().map_or(1, |n| n.get())
    }
    #[cfg(target_arch = "wasm32")]
    { 1 }
}

/// Deterministic parallel map: `out[i] == f(i, &items[i])`, whatever `threads` is.
///
/// Work is handed out in chunks of `chunk` consecutive items through an atomic counter (dynamic balancing, so
/// cheap and expensive layers mix), and every result is written to the slot of its own index, so the output
/// order and values are independent of scheduling. `f` must be a pure function of its arguments. With
/// `threads <= 1`, a single chunk or on wasm32 it is a plain serial loop (same results, no threads spawned).
pub fn par_map<T: Sync, R: Send>(items: &[T], threads: usize, f: impl Fn(usize, &T) -> R + Sync) -> Vec<R> {
    par_map_chunked(items, threads, 1, f)
}

pub fn par_map_chunked<T: Sync, R: Send>(items: &[T], threads: usize, chunk: usize, f: impl Fn(usize, &T) -> R + Sync) -> Vec<R> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let n = items.len();
        let chunk = chunk.max(1);
        let threads = threads.max(1).min(n.div_ceil(chunk));
        if threads > 1 {
            use std::sync::atomic::{AtomicUsize, Ordering};
            let next = AtomicUsize::new(0);
            let parts: Vec<Vec<(usize, R)>> = std::thread::scope(|sc| {
                let hs: Vec<_> = (0..threads).map(|_| sc.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let lo = next.fetch_add(chunk, Ordering::Relaxed);
                        if lo >= n { break; }
                        for i in lo..(lo + chunk).min(n) { mine.push((i, f(i, &items[i]))); }
                    }
                    mine
                })).collect();
                hs.into_iter().map(|h| h.join().expect("worker thread panicked")).collect()
            });
            let mut slots: Vec<Option<R>> = (0..n).map(|_| None).collect();
            for part in parts { for (i, r) in part { slots[i] = Some(r); } }
            return slots.into_iter().map(|r| r.expect("every index produced exactly once")).collect();
        }
    }
    let _ = (threads, chunk);
    items.iter().enumerate().map(|(i, x)| f(i, x)).collect()
}

#[inline] fn f32r(z: f64) -> f64 { z as f32 as f64 }

/// One triangle cut by the plane z = `s`, or None when the plane misses it (half-open rule, see module docs).
#[inline]
fn tri_seg(mesh: &Mesh, t: &[u32; 3], v: &[[f64; 3]; 3], s: f64) -> Option<Seg> {
    let mut up: Option<([f64; 2], EdgeKey)> = None;
    let mut down: Option<([f64; 2], EdgeKey)> = None;
    for e in 0..3 {
        let (i, j) = (t[e], t[(e + 1) % 3]);
        let (zi, zj) = (f32r(v[e][2]), f32r(v[(e + 1) % 3][2]));
        let (bi, bj) = (zi < s, zj < s);
        if bi == bj { continue; }
        let c = cut_edge(mesh, i, j, s);
        if bi { up = Some(c); } else { down = Some(c); }
    }
    if let (Some(u), Some(d)) = (up, down) {
        // outward-wound triangle: interior on the left when going from the down- to the up-crossing
        Some(Seg { a: d.0, b: u.0, ka: d.1, kb: u.1 })
    } else { None }
}

/// Slice `mesh` at every spec, on [`default_threads`] threads (result identical for every thread count).
pub fn slice_mesh(mesh: &Mesh, specs: &[LayerSpec], opt: SliceOptions) -> SliceResult {
    // Spawning threads for a few hundred triangle-layer cuts costs more than it saves (measured: a 12-triangle
    // cube, 100 layers: 0.2 ms serial, 9 ms on 24 threads). Roughly one thread per 2k triangles; explicit
    // `slice_mesh_threads` calls are never capped. Purely a speed choice: results do not depend on it.
    let t = default_threads().min((mesh.tris.len() / 2048).max(1));
    slice_mesh_threads(mesh, specs, opt, t)
}

/// Slice `mesh` at every spec using `threads` worker threads.
///
/// Determinism: triangles are bucketed per layer once (counting sort, O(T + L + hits), in ascending triangle
/// index, exactly the order the old single loop pushed segments in). Each layer is then cut, chained and
/// converted to regions by a pure function of (mesh, its own triangle list), so layers can run on any
/// thread in any order; results are stored by layer index. The output is bit-identical to `threads = 1`.
pub fn slice_mesh_threads(mesh: &Mesh, specs: &[LayerSpec], opt: SliceOptions, threads: usize) -> SliceResult {
    // Orca slices in float32 (`std::vector<float> zs`, float vertices): a vertex counts as ON the plane when the float32
    // values are equal. Our mesh stores f32-exact vertices widened to f64 and slice_z as f64, so 2.3 (f32) != 2.3 (f64)
    // and a face lying on the plane would flip layers. Compare in f32 everywhere (`f32r`).
    let zs: Vec<f64> = specs.iter().map(|s| f32r(s.slice_z)).collect();
    let nl = specs.len();
    // pass 1: layer range [first, last) of every triangle, count per layer
    let mut ranges: Vec<(u32, u32)> = Vec::with_capacity(mesh.tris.len());
    let mut count = vec![0u32; nl + 1];
    for t in &mesh.tris {
        let (z0, z1, z2) = (f32r(mesh.verts[t[0] as usize][2]), f32r(mesh.verts[t[1] as usize][2]), f32r(mesh.verts[t[2] as usize][2]));
        let zmin = z0.min(z1).min(z2);
        let zmax = z0.max(z1).max(z2);
        if zmin == zmax { ranges.push((0, 0)); continue; }
        // layers with zmin < s <= zmax
        let first = zs.partition_point(|&s| s <= zmin);
        let last = zs.partition_point(|&s| s <= zmax);
        ranges.push((first as u32, last as u32));
        for li in first..last { count[li] += 1; }
    }
    // CSR offsets, then fill in ascending triangle index
    let mut start = vec![0usize; nl + 1];
    for li in 0..nl { start[li + 1] = start[li] + count[li] as usize; }
    let mut fill = start.clone();
    let mut ids = vec![0u32; start[nl]];
    for (ti, &(f, l)) in ranges.iter().enumerate() {
        for li in f as usize..l as usize { ids[fill[li]] = ti as u32; fill[li] += 1; }
    }
    drop(ranges);
    // pass 2: per layer, independent
    let layer_ids: Vec<usize> = (0..nl).collect();
    let per: Vec<(Layer, LayerReport, Vec<OpenLoop>)> = par_map(&layer_ids, threads, |_, &li| {
        let s = zs[li];
        let tl = &ids[start[li]..start[li + 1]];
        let mut segs: Vec<Seg> = Vec::with_capacity(tl.len());
        for &ti in tl {
            let t = &mesh.tris[ti as usize];
            let v = [mesh.verts[t[0] as usize], mesh.verts[t[1] as usize], mesh.verts[t[2] as usize]];
            if let Some(sg) = tri_seg(mesh, t, &v, s) { segs.push(sg); }
        }
        let (rings, rep, opens) = chain_layer(segs, li, opt);
        (Layer { index: li, z: specs[li].hi, h: specs[li].h(), region: regions_from_loops(rings, &opt) }, rep, opens)
    });
    let mut res = SliceResult::default();
    for (l, rep, opens) in per {
        res.layers.push(l);
        res.reports.push(rep);
        res.open_loops.extend(opens);
    }
    res
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 { (a[0] - b[0]).hypot(a[1] - b[1]) }

fn chain_layer(segs: Vec<Seg>, layer: usize, opt: SliceOptions) -> (Vec<Ring>, LayerReport, Vec<OpenLoop>) {
    let mut rep = LayerReport { segments: segs.len(), ..Default::default() };
    // stage 1: topological chaining
    // head[key] = lowest segment index starting at that mesh edge; next[i] = next higher index with the same start
    // (ascending, so "first unused candidate" is exactly what the old Vec-per-key lookup returned).
    let mut by_start: HashMap<EdgeKey, u32, FxBuild> = HashMap::with_capacity_and_hasher(segs.len(), FxBuild);
    let mut next_same: Vec<u32> = vec![u32::MAX; segs.len()];
    for i in (0..segs.len()).rev() {
        if let Some(old) = by_start.insert(segs[i].ka, i as u32) { next_same[i] = old; }
    }
    let mut used = vec![false; segs.len()];
    let mut closed: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut chains: Vec<Vec<[f64; 2]>> = Vec::new(); // open polylines
    for s0 in 0..segs.len() {
        if used[s0] { continue; }
        used[s0] = true;
        let mut pts = vec![segs[s0].a, segs[s0].b];
        let mut cur_end = segs[s0].kb;
        let start_key = segs[s0].ka;
        loop {
            if cur_end == start_key { pts.pop(); closed.push(pts); rep.loops_topological += 1; break; }
            let next = by_start.get(&cur_end).and_then(|&h| {
                let mut i = h;
                while i != u32::MAX { if !used[i as usize] { return Some(i as usize); } i = next_same[i as usize]; }
                None
            });
            match next {
                Some(i) => { used[i] = true; pts.push(segs[i].b); cur_end = segs[i].kb; }
                None => { chains.push(pts); break; }
            }
        }
    }
    // stage 2: tolerant geometric joining of the loose chains (ends may be joined in either orientation)
    let mut opens = Vec::new();
    let mut alive: Vec<Option<Vec<[f64; 2]>>> = chains.into_iter().map(Some).collect();
    'outer: loop {
        // find any chain with a joinable end
        for i in 0..alive.len() {
            let Some(ci) = alive[i].as_ref() else { continue };
            let (si, ei) = (ci[0], *ci.last().unwrap());
            // close on itself
            if ci.len() >= 3 && dist(si, ei) <= opt.gap_tol {
                let mut c = alive[i].take().unwrap(); c.pop(); closed.push(c); rep.loops_gap_closed += 1; continue 'outer;
            }
            // best partner for the END of chain i: start or end of another chain
            let mut best: Option<(usize, bool, f64)> = None; // (j, partner_is_start, d)
            for j in 0..alive.len() {
                if j == i { continue; }
                let Some(cj) = alive[j].as_ref() else { continue };
                for (is_start, p) in [(true, cj[0]), (false, *cj.last().unwrap())] {
                    let d = dist(ei, p);
                    if d <= opt.gap_tol && best.map_or(true, |b| d < b.2) { best = Some((j, is_start, d)); }
                }
            }
            if let Some((j, is_start, _)) = best {
                let mut cj = alive[j].take().unwrap();
                if !is_start { cj.reverse(); }
                alive[i].as_mut().unwrap().extend(cj);
                continue 'outer;
            }
        }
        break;
    }
    for c in alive.into_iter().flatten() {
        let gap = dist(c[0], *c.last().unwrap());
        rep.open_loops += 1;
        opens.push(OpenLoop { layer, points: c, gap });
    }
    // drop consecutive duplicates; count degenerate rings
    let mut rings = Vec::new();
    for mut r in closed {
        r.dedup_by(|a, b| a[0] == b[0] && a[1] == b[1]);
        if r.len() > 1 && r.first() == r.last() { r.pop(); }
        if r.len() < 3 { rep.degenerate_loops += 1; } else { rings.push(r); }
    }
    (rings, rep, opens)
}

/// Slice a placed mesh with the stack derived from `cfg`. The mesh must sit on z = 0 (see `Mesh::place_on_bed`).
pub fn slice(mesh: &Mesh, cfg: &Config) -> Result<SliceResult, FdmError> {
    let (mn, mx) = mesh.bbox();
    if mn[2].abs() > 1e-4 { return Err(FdmError::Geometry(format!("mesh is not on the bed (min z = {}); call place_on_bed first", mn[2]))); }
    let specs = stack_from_config(cfg, mx[2])?;
    Ok(slice_mesh(mesh, &specs, SliceOptions::from_config(cfg)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::tests::box_soup;
    fn sp(h: f64, first: f64, min: f64, top: f64) -> StackParams { StackParams { initial_layer_height: first, layer_height: h, min_layer_height: min, object_height: top, profile: None } }

    #[test] fn stack_counts_like_orca() {
        // measured Orca: 20 mm cube @0.2/0.2 -> 100 layers; cube 20 @ first .2 .. h .2 ends at exactly 20
        let s = layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap();
        assert_eq!(s.len(), 100);
        assert!((s.last().unwrap().hi - 20.0).abs() < 1e-9 && s[0].lo == 0.0 && (s[0].slice_z - 0.1).abs() < 1e-12);
        // height 8.4 (tray) -> 42 layers
        assert_eq!(layer_stack(&sp(0.2, 0.2, 0.07, 8.4)).unwrap().len(), 42);
        // top sliver: 10.05 tall, mid of last partial layer (10.1) would be above top -> dropped
        let s = layer_stack(&sp(0.2, 0.2, 0.07, 10.05)).unwrap();
        assert!((s.last().unwrap().hi - 10.0).abs() < 1e-9, "{:?}", s.last());
        // 10.15 tall: last layer 10.0..10.2 mid 10.1 < 10.15 -> kept
        assert!((layer_stack(&sp(0.2, 0.2, 0.07, 10.15)).unwrap().last().unwrap().hi - 10.2).abs() < 1e-9);
        // thicker first layer
        let s = layer_stack(&sp(0.2, 0.3, 0.07, 1.0)).unwrap();
        assert!((s[0].hi - 0.3).abs() < 1e-12 && (s[1].lo - 0.3).abs() < 1e-12);
        assert!(layer_stack(&sp(0.0, 0.2, 0.07, 1.0)).is_err());
    }
    #[test] fn variable_profile() {
        let mut p = sp(0.2, 0.2, 0.07, 10.0);
        p.profile = Some(vec![0.0, 0.1, 5.0, 0.1, 5.0, 0.3, 10.0, 0.3]);
        let s = layer_stack(&p).unwrap();
        assert!(s.iter().any(|l| (l.h() - 0.1).abs() < 1e-9) && s.iter().any(|l| (l.h() - 0.3).abs() < 1e-9));
        for w in s.windows(2) { assert!((w[0].hi - w[1].lo).abs() < 1e-12); }
    }
    fn cube(x: f64, y: f64, z: f64) -> Mesh { Mesh::from_soup(&box_soup(x, y, z)).unwrap() }
    #[test] fn cube_area_every_layer() {
        let m = cube(20.0, 20.0, 20.0);
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap();
        let r = slice_mesh(&m, &specs, SliceOptions::default());
        assert_eq!(r.layers.len(), 100);
        assert!(r.open_loops.is_empty());
        for l in &r.layers { assert!((geom::area(&l.region) - 400.0).abs() < 1e-9, "layer {}", l.index); assert_eq!(l.region.len(), 1); }
        assert!(r.reports.iter().all(|x| x.loops_topological == 1 && x.loops_gap_closed == 0));
        // CCW contour
        assert!(geom::ring_area(&r.layers[3].region[0].contour) > 0.0);
    }
    /// Frame with a square through-hole: outer 20, hole 8 -> area 336 and one hole.
    fn ring_mesh() -> Mesh {
        let mut soup = vec![];
        let (a, m, hh) = (20.0, 6.0, 8.0);
        let (mm, mx) = (m, m + hh);
        let o = [[0., 0.], [a, 0.], [a, a], [0., a]];
        let i = [[mm, mm], [mx, mm], [mx, mx], [mm, mx]];
        let quad = |p: [[f64; 3]; 4], soup: &mut Vec<[f64; 9]>| {
            for t in [[0, 1, 2], [0, 2, 3]] { let mut s = [0.0; 9]; for (k, &q) in t.iter().enumerate() { s[k * 3..k * 3 + 3].copy_from_slice(&p[q]); } soup.push(s); }
        };
        let v = |p: [f64; 2], z: f64| [p[0], p[1], z];
        for k in 0..4 { let j = (k + 1) % 4;
            quad([v(o[k], 0.), v(o[j], 0.), v(o[j], a), v(o[k], a)], &mut soup);
            quad([v(i[j], 0.), v(i[k], 0.), v(i[k], a), v(i[j], a)], &mut soup);
            quad([v(o[k], a), v(o[j], a), v(i[j], a), v(i[k], a)], &mut soup);
            quad([v(o[j], 0.), v(o[k], 0.), v(i[k], 0.), v(i[j], 0.)], &mut soup);
        }
        Mesh::from_soup(&soup).unwrap()
    }
    #[test] fn ring_has_hole() {
        let m = ring_mesh();
        assert!(m.validate().is_watertight());
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap();
        let r = slice_mesh(&m, &specs, SliceOptions::default());
        for l in &r.layers { assert!((geom::area(&l.region) - 336.0).abs() < 1e-9); assert_eq!(l.region[0].holes.len(), 1); }
    }
    #[test] fn open_mesh_reports_not_drops() {
        let mut soup = box_soup(20.0, 20.0, 20.0);
        soup.remove(5); // punch a hole in the surface
        let m = Mesh::from_soup(&soup).unwrap();
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap();
        let r = slice_mesh(&m, &specs, SliceOptions::default());
        assert!(r.total_open_loops() > 0, "an open surface must produce reported open loops");
        assert!(r.reports.iter().any(|x| x.open_loops > 0));
    }
    #[test] fn gap_within_tolerance_is_closed() {
        // two un-welded halves of a cube wall separated by 5e-5 mm along a side face
        let mut soup = box_soup(20.0, 20.0, 20.0);
        for t in soup.iter_mut().skip(6).take(2) { for k in 0..3 { if t[k * 3] == 20.0 && t[k * 3 + 1] == 20.0 { t[k * 3 + 1] += 5e-5; } } } // one face detached at a corner
        assert!(Mesh::from_soup(&soup).unwrap().validate().open_edges > 0, "test premise: mesh must really be unwelded");
        let m = Mesh::from_soup(&soup).unwrap();
        let r = slice_mesh(&m, &layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap(), SliceOptions::default());
        assert!(r.open_loops.is_empty());
        assert!(r.reports.iter().all(|x| x.loops_gap_closed == 1), "gap path must have been exercised");
        assert!((geom::area(&r.layers[10].region) - 400.0).abs() < 0.01);
    }
    #[test] fn needs_placement() {
        let mut m = cube(10.0, 10.0, 10.0);
        m.translate([0.0, 0.0, 1.0]);
        let mut cfg = Config::new();
        for (k, v) in [("layer_height", "0.2"), ("initial_layer_print_height", "0.2"), ("min_layer_height", "0.07")] { cfg.set(k, v); }
        assert!(slice(&m, &cfg).is_err());
        m.place_on_bed(0.0, 0.0);
        let r = slice(&m, &cfg).unwrap();
        assert_eq!(r.layers.len(), 50);
        cfg.set("raft_layers", "2");
        assert_eq!(slice(&m, &cfg).unwrap().layers.len(), 50, "raft: object stack is plain layer_height layers");
        cfg.set("precise_z_height", "1");
        assert!(slice(&m, &cfg).is_err());
    }

    // ---------------------------------------------------------------- lane 10: parallel == serial
    /// Everything a SliceResult carries, rendered with `{:?}` (f64 Debug is the shortest exact round-trip repr and
    /// prints -0.0 distinctly), so string equality is bit equality of every number and of every ordering.
    fn dump(r: &SliceResult) -> String { format!("{:?}|{:?}|{:?}", r.layers, r.reports, r.open_loops) }

    /// Closed torus-like soup with `nu*nv*2` triangles (islands + holes per layer), outward winding.
    fn torus_soup(nu: usize, nv: usize) -> Vec<[f64; 9]> {
        let tau = std::f64::consts::TAU;
        let p = |i: usize, j: usize| -> [f64; 3] {
            let (a, b) = ((i % nu) as f64 / nu as f64 * tau, (j % nv) as f64 / nv as f64 * tau);
            let rr = 30.0 + 10.0 * b.cos();
            [rr * a.cos(), rr * a.sin(), 10.0 * b.sin() + 10.0]
        };
        let mut out = vec![];
        for i in 0..nu { for j in 0..nv {
            let (a, b, c, d) = (p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1));
            for t in [[a, b, c], [a, c, d]] { let mut s = [0.0; 9]; for (k, q) in t.iter().enumerate() { s[k * 3..k * 3 + 3].copy_from_slice(q); } out.push(s); }
        } }
        out
    }
    fn many_threads() -> Vec<usize> { vec![1, 2, 3, 5, 8, 32] }

    #[test] fn parallel_slice_equals_serial_on_every_shape_of_input() {
        let mut cases: Vec<(&str, Mesh, f64)> = vec![
            ("cube", cube(20.0, 20.0, 20.0), 20.0),
            ("ring", ring_mesh(), 20.0),
            ("torus", Mesh::from_soup(&torus_soup(96, 48)).unwrap(), 20.0),
        ];
        // an OPEN mesh: exercises the geometric-join pass and open_loops/reports ordering
        let mut soup = box_soup(20.0, 20.0, 20.0); soup.remove(5);
        cases.push(("open-cube", Mesh::from_soup(&soup).unwrap(), 20.0));
        let mut worked = 0usize;
        for (name, mut m, _) in cases {
            m.place_on_bed(0.0, 0.0);
            let (_, mx) = m.bbox();
            let specs = layer_stack(&sp(0.2, 0.2, 0.07, mx[2])).unwrap();
            let base = slice_mesh_threads(&m, &specs, SliceOptions::default(), 1);
            assert!(!base.layers.is_empty() && base.layers.iter().any(|l| !l.region.is_empty() || name == "open-cube"), "{name}: population must not be empty");
            let want = dump(&base);
            for t in many_threads() {
                assert_eq!(dump(&slice_mesh_threads(&m, &specs, SliceOptions::default(), t)), want, "{name}: threads {t} differs from serial");
                worked += 1;
            }
            // the default entry point (heuristic thread count) must agree too
            assert_eq!(dump(&slice_mesh(&m, &specs, SliceOptions::default())), want, "{name}: slice_mesh()");
            if name == "open-cube" { assert!(base.total_open_loops() > 0); }
        }
        assert_eq!(worked, 4 * many_threads().len());
    }

    /// NEGATIVE CONTROL: the comparison used above really can fail: a different thread count is NOT the
    /// difference it sees, a different input is.
    #[test] fn parallel_equality_check_detects_a_planted_difference() {
        let m = cube(20.0, 20.0, 20.0);
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap();
        let a = slice_mesh_threads(&m, &specs, SliceOptions::default(), 4);
        let mut planted = slice_mesh_threads(&m, &specs, SliceOptions::default(), 1);
        planted.layers[37].region[0].contour[0][0] += f64::EPSILON * 64.0; // a one-ulp-scale nudge
        assert_ne!(dump(&a), dump(&planted));
        let mut swapped = slice_mesh_threads(&m, &specs, SliceOptions::default(), 1);
        swapped.layers.swap(3, 4);
        assert_ne!(dump(&a), dump(&swapped), "a layer-order swap must be seen");
    }

    #[test] fn par_map_is_ordered_complete_and_thread_independent() {
        // uneven cost so that dynamic scheduling really interleaves
        let items: Vec<u64> = (0..257).collect();
        let f = |i: usize, x: &u64| -> (usize, u64) { let mut a = *x; for _ in 0..(x % 13) * 500 { a = a.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); } (i, a) };
        let want = par_map(&items, 1, f);
        assert_eq!(want.len(), 257);
        for t in many_threads() { for chunk in [1usize, 3, 64, 1000] { assert_eq!(par_map_chunked(&items, t, chunk, f), want, "threads {t} chunk {chunk}"); } }
        assert!(par_map(&Vec::<u8>::new(), 8, |_, _| 0u8).is_empty());
    }

    // ---------------------------------------------------------------- lane 19: Orca make_expolygons semantics
    fn shifted(soup: &[[f64; 9]], d: [f64; 3]) -> Vec<[f64; 9]> {
        soup.iter().map(|t| { let mut o = *t; for k in 0..3 { for a in 0..3 { o[k * 3 + a] += d[a]; } } o }).collect()
    }
    fn specs20() -> Vec<LayerSpec> { layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap() }
    fn region_stats(l: &Layer) -> (f64, usize, usize) { (geom::area(&l.region), l.region.len(), l.region.iter().map(|q| q.holes.len()).sum()) }

    /// Two overlapping closed shells (cube + cube shifted by 10,10): Orca unions them (non-zero): area 800-100 = 700,
    /// ONE region, NO hole. Even-odd (the old behaviour) gave 600 with a hole.
    #[test] fn overlapping_shells_are_unioned_not_xored() {
        let mut soup = box_soup(20.0, 20.0, 20.0);
        soup.extend(shifted(&box_soup(20.0, 20.0, 20.0), [10.0, 10.0, 0.0]));
        let m = Mesh::from_soup(&soup).unwrap();
        let r = slice_mesh(&m, &specs20(), SliceOptions::default());
        assert!(r.open_loops.is_empty());
        for l in &r.layers { let (a, n, h) = region_stats(l); assert!((a - 700.0).abs() < 1e-9 && n == 1 && h == 0, "layer {}: area {a} regions {n} holes {h}", l.index); }
    }
    /// Post running into a plate (the tall_slender shape): the post must NOT show as a hole where it overlaps the plate.
    #[test] fn post_inside_plate_does_not_punch_a_hole() {
        let mut soup = box_soup(30.0, 30.0, 2.0);                                     // plate 0..2
        soup.extend(shifted(&box_soup(5.0, 5.0, 20.0), [12.5, 12.5, 1.0]));           // post 1..21 starts inside the plate
        let m = Mesh::from_soup(&soup).unwrap();
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 21.0)).unwrap();
        let r = slice_mesh(&m, &specs, SliceOptions::default());
        for l in &r.layers {
            let z = l.z - 0.1;
            let want = if z < 2.0 { 900.0 } else { 25.0 };
            let (a, n, h) = region_stats(l);
            assert!((a - want).abs() < 1e-9 && n == 1 && h == 0, "z {z}: area {a} want {want} regions {n} holes {h}");
        }
    }
    /// A shell fully inside another with the same orientation is absorbed (non-zero: winding 2), not a hole.
    #[test] fn nested_same_orientation_shell_is_absorbed() {
        let mut soup = box_soup(20.0, 20.0, 20.0);
        soup.extend(shifted(&box_soup(6.0, 6.0, 20.0), [7.0, 7.0, 0.0]));
        let r = slice_mesh(&Mesh::from_soup(&soup).unwrap(), &specs20(), SliceOptions::default());
        for l in &r.layers { let (a, n, h) = region_stats(l); assert!((a - 400.0).abs() < 1e-9 && n == 1 && h == 0, "layer {}", l.index); }
    }
    /// A reversed-orientation inner shell is a real cavity and stays a hole (loop orientation decides outer vs hole).
    #[test] fn reversed_inner_shell_stays_a_hole() {
        let mut soup = box_soup(20.0, 20.0, 20.0);
        let mut inner = shifted(&box_soup(6.0, 6.0, 12.0), [7.0, 7.0, 4.0]);
        for t in inner.iter_mut() { for a in 0..3 { let (x, y) = (t[3 + a], t[6 + a]); t[3 + a] = y; t[6 + a] = x; } } // flip winding
        soup.extend(inner);
        let r = slice_mesh(&Mesh::from_soup(&soup).unwrap(), &specs20(), SliceOptions::default());
        let mid = &r.layers[50];
        let (a, n, h) = region_stats(mid);
        assert!((a - (400.0 - 36.0)).abs() < 1e-9 && n == 1 && h == 1, "area {a} regions {n} holes {h}");
        assert!((region_stats(&r.layers[3]).0 - 400.0).abs() < 1e-9, "below the cavity it is solid");
    }
    /// slice_closing_radius: two squares 0.04 mm apart merge into one region with r = 0.049 (Orca default) and stay two
    /// without it; the closed area is the squares plus the bridged gap (closing never removes material).
    #[test] fn closing_radius_bridges_a_thin_gap() {
        let mut soup = box_soup(10.0, 10.0, 5.0);
        soup.extend(shifted(&box_soup(10.0, 10.0, 5.0), [10.04, 0.0, 0.0]));
        let m = Mesh::from_soup(&soup).unwrap();
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 5.0)).unwrap();
        let off = slice_mesh(&m, &specs, SliceOptions::default());
        let on = slice_mesh(&m, &specs, SliceOptions { closing_radius: 0.049, ..SliceOptions::default() });
        for (a, b) in off.layers.iter().zip(&on.layers) {
            assert_eq!(a.region.len(), 2);
            assert_eq!(b.region.len(), 1, "layer {}", b.index);
            assert!((geom::area(&a.region) - 200.0).abs() < 1e-9);
            assert!((geom::area(&b.region) - 200.4).abs() < 1e-3, "closed area {}", geom::area(&b.region));
        }
        // a single cube is unchanged by closing + simplify (corners are exact with a miter join)
        let c = slice_mesh(&cube(20.0, 20.0, 20.0), &specs20(), SliceOptions { closing_radius: 0.049, simplify_tol: 0.0025, ..SliceOptions::default() });
        for l in &c.layers { assert!((geom::area(&l.region) - 400.0).abs() < 1e-6 && l.region[0].contour.len() == 4, "layer {}", l.index); }
    }
    #[test] fn options_from_config_reads_orca_keys() {
        let mut cfg = Config::new();
        assert_eq!(SliceOptions::from_config(&cfg).closing_radius, 0.0);
        cfg.set("slice_closing_radius", "0.049"); cfg.set("resolution", "0.012");
        let o = SliceOptions::from_config(&cfg);
        assert!((o.closing_radius - 0.049).abs() < 1e-12 && (o.simplify_tol - 0.0025).abs() < 1e-12);
        cfg.set("resolution", "0.001");
        assert_eq!(SliceOptions::from_config(&cfg).simplify_tol, 0.0);
    }
    /// serial == parallel on overlapping shells with closing + simplify on (the new code path), plus a planted difference.
    #[test] fn parallel_equals_serial_with_union_closing_and_simplify() {
        let mut soup = torus_soup(64, 32);
        soup.extend(shifted(&torus_soup(64, 32), [9.0, 3.0, 0.5]));       // two overlapping shells
        let m = Mesh::from_soup(&soup).unwrap();
        let specs = layer_stack(&sp(0.2, 0.2, 0.07, 20.0)).unwrap();
        let o = SliceOptions { closing_radius: 0.049, simplify_tol: 0.0025, ..SliceOptions::default() };
        let base = slice_mesh_threads(&m, &specs, o, 1);
        assert!(base.layers.iter().any(|l| !l.region.is_empty()));
        let want = dump(&base);
        for t in many_threads() { assert_eq!(dump(&slice_mesh_threads(&m, &specs, o, t)), want, "threads {t}"); }
        let mut planted = base.clone_for_test();
        planted.layers[40].region[0].contour[0][0] += 1e-9;
        assert_ne!(dump(&planted), want);
    }

    /// Orca slices in float32: a face whose top vertices lie ON the plane (f32 equal) is part of that layer (two
    /// vertices on the plane + third below = "Slicing"). Our f64 slice_z 2.3 != the f32-widened vertex z 2.3, so the
    /// comparison must be done in f32 or the layer is lost (a one-layer shift of every feature top).
    #[test] fn face_on_the_plane_is_kept_like_orca() {
        let h = 2.3f32 as f64; // what an STL stores, widened
        assert!(h != 2.3);
        let m = Mesh::from_soup(&box_soup(10.0, 10.0, h)).unwrap();
        let sp = [LayerSpec { lo: 2.2, hi: 2.4, slice_z: 2.3 }, LayerSpec { lo: 2.4, hi: 2.6, slice_z: 2.5 }];
        let r = slice_mesh(&m, &sp, SliceOptions::default());
        assert!((geom::area(&r.layers[0].region) - 100.0).abs() < 1e-9, "top-edge-on-plane layer must be kept");
        assert!(r.layers[1].region.is_empty());
    }

    /// Real model vs Orca 2.5.0-dev (X2D 0.4, pnp-coupon process; wall_generator classic, arc fitting off,
    /// overhang detection off): numbers below are the Σ|area| of every Outer-wall loop in Orca's G-code
    /// (first layer inset 0.25 = initial line width/2, others 0.21), baked in so the test needs no Orca.
    /// The STL is a PINNED copy in tests/fixtures (sha256 142be423…d6736 = cad's pnp_blinds_12_tray.stl of
    /// 2026-10-15 10:28, 64 mm tape, flat lane walls), NOT cad's live gitignored file: cad edits that file
    /// and an earlier version of this test went red on 2026-10-15 when they did. Re-bake = re-slice the
    /// fixture on the Orca server and update the four numbers + layer count together.
    #[test] fn tray12_matches_orca_walls() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pnp_blinds_12_tray.stl");
        assert!(path.is_file(), "pinned fixture missing: {}", path.display());
        let mut m = Mesh::from_stl_file(&path).unwrap();
        assert!(m.validate().is_watertight());
        m.place_on_bed(138.25, 128.0);
        let mut cfg = Config::new();
        for (k, v) in [("layer_height", "0.2"), ("initial_layer_print_height", "0.2"), ("min_layer_height", "0.07")] { cfg.set(k, v); }
        let r = slice(&m, &cfg).unwrap();
        assert_eq!(r.layers.len(), 38, "Orca slices this model into 38 layers");
        assert!(r.open_loops.is_empty());
        let absum = |i: usize, d: f64| -> f64 { geom::offset(&r.layers[i].region, -d).iter().map(|q| geom::ring_area(&q.contour).abs() + q.holes.iter().map(|h| geom::ring_area(h).abs()).sum::<f64>()).sum() };
        for (i, d, orca) in [(0usize, 0.25, 14981.454), (1, 0.21, 15042.369), (2, 0.21, 15086.606), (37, 0.21, 1253.088)] {
            let ours = absum(i, d);
            assert!((ours - orca).abs() / orca < 1e-3, "layer {i}: ours {ours} orca {orca}");
        }
    }

    #[test] fn raft_stack_is_plain_layer_height_stack() {
        let mut cfg = Config::new();
        for (k, v) in [("layer_height", "0.2"), ("initial_layer_print_height", "0.3"), ("min_layer_height", "0.07"), ("raft_layers", "0")] { cfg.set(k, v); }
        let plain = stack_from_config(&cfg, 2.0).unwrap();
        assert!((plain[0].hi - 0.3).abs() < 1e-9);
        cfg.set("raft_layers", "3");
        let raft = stack_from_config(&cfg, 2.0).unwrap();
        assert!((raft[0].hi - 0.2).abs() < 1e-9 && raft[0].lo == 0.0, "first object layer = layer_height, not fixed");
        assert_eq!(raft.len(), 10);
        assert_eq!(raft_layers(&cfg).unwrap(), 3);
        cfg.set("precise_z_height", "1");
        assert!(stack_from_config(&cfg, 2.0).is_err());
    }
}
