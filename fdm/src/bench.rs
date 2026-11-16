//! Performance harness (lane 10): std-only (`Instant`, /proc), no new dependencies.
//!
//! NOT declared in `lib.rs` (the lead owns it): `src/bin/fdmbench.rs` pulls this file in with
//! `#[path = "../bench.rs"] mod bench;`, so it only ever uses the public API of `twobee_fdm`.
//!
//! Contents: dense-mesh generators (sphere / torus -> binary STL bytes), order-sensitive bit hashes of
//! slice results / polygons / G-code statistics (the equality proof: a hash over the IEEE-754 bit
//! patterns, so two runs hash equal iff every f64 is bit-identical and in the same order), RSS readers
//! and a counting allocator (allocations + bytes, an exact count, not an estimate).
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use twobee_fdm::gcode_parse::Stats;
use twobee_fdm::slice::SliceResult;
use twobee_fdm::types::{Layer, Polys};

// ------------------------------------------------------------------ counting allocator
pub static ALLOCS: AtomicU64 = AtomicU64::new(0);
pub static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
pub struct CountingAlloc;
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(l.size() as u64, Ordering::Relaxed);
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { System.dealloc(p, l) }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(n as u64, Ordering::Relaxed);
        System.realloc(p, l, n)
    }
}
pub fn alloc_counters() -> (u64, u64) { (ALLOCS.load(Ordering::Relaxed), ALLOC_BYTES.load(Ordering::Relaxed)) }

// ------------------------------------------------------------------ /proc
fn status_kb(key: &str) -> Option<u64> {
    let s = std::fs::read_to_string("/proc/self/status").ok()?;
    s.lines().find_map(|l| l.strip_prefix(key)?.trim().trim_end_matches("kB").trim().parse().ok())
}
/// Peak resident set (VmHWM), kB. None off Linux.
pub fn peak_rss_kb() -> Option<u64> { status_kb("VmHWM:") }
pub fn cur_rss_kb() -> Option<u64> { status_kb("VmRSS:") }

// ------------------------------------------------------------------ timing
/// One stage measurement.
#[derive(Clone, Debug)]
pub struct StageRow { pub name: String, pub secs: f64, pub allocs: u64, pub alloc_mb: f64, pub rss_peak_mb: f64, pub hash: u64 }
pub fn timed<T>(f: impl FnOnce() -> T) -> (T, f64, u64, u64) {
    let (a0, b0) = alloc_counters();
    let t = Instant::now();
    let r = f();
    let s = t.elapsed().as_secs_f64();
    let (a1, b1) = alloc_counters();
    (r, s, a1 - a0, b1 - b0)
}

/// Best-of-`reps` wall time (the machine is shared; the minimum is the least-contended sample). Allocation
/// counts are those of the fastest run; the result is from the last run.
pub fn best_of<T>(reps: usize, mut f: impl FnMut() -> T) -> (T, f64, u64, u64) {
    let mut best: Option<(f64, u64, u64)> = None;
    let mut last = None;
    for _ in 0..reps.max(1) {
        let (r, s, a, b) = timed(&mut f);
        if best.map_or(true, |x| s < x.0) { best = Some((s, a, b)); }
        last = Some(r);
    }
    let (s, a, b) = best.unwrap();
    (last.unwrap(), s, a, b)
}
/// CPU time (s) consumed by the calling process's main thread (/proc/self/schedstat). Unlike wall time it is
/// mostly immune to other processes stealing the core, so it is the number to use for single-threaded stages.
pub fn cpu_s() -> f64 {
    std::fs::read_to_string("/proc/self/schedstat").ok().and_then(|s| s.split_whitespace().next()?.parse::<u64>().ok()).map_or(f64::NAN, |ns| ns as f64 * 1e-9)
}
/// Best-of-`reps` CPU time (main thread) for a single-threaded stage; returns (result, cpu_s, wall_s of that run).
pub fn best_cpu<T>(reps: usize, mut f: impl FnMut() -> T) -> (T, f64, f64) {
    let mut best = (f64::INFINITY, 0.0);
    let mut last = None;
    for _ in 0..reps.max(1) {
        let (c0, t0) = (cpu_s(), Instant::now());
        let r = f();
        let (c, w) = (cpu_s() - c0, t0.elapsed().as_secs_f64());
        if c < best.0 { best = (c, w); }
        last = Some(r);
    }
    (last.unwrap(), best.0, best.1)
}
/// 1-minute load average (how contended the shared machine was).
pub fn loadavg() -> String { std::fs::read_to_string("/proc/loadavg").map(|s| s.split_whitespace().next().unwrap_or("?").to_string()).unwrap_or_else(|_| "?".into()) }

// ------------------------------------------------------------------ order-sensitive bit hash (FNV-1a 64)
pub struct Fnv(pub u64);
impl Fnv {
    pub fn new() -> Self { Fnv(0xcbf29ce484222325) }
    pub fn u64(&mut self, v: u64) { for b in v.to_le_bytes() { self.0 ^= b as u64; self.0 = self.0.wrapping_mul(0x100000001b3); } }
    pub fn f(&mut self, v: f64) { self.u64(v.to_bits()); }
    pub fn n(&mut self, v: usize) { self.u64(v as u64); }
    pub fn bytes(&mut self, b: &[u8]) { for &x in b { self.0 ^= x as u64; self.0 = self.0.wrapping_mul(0x100000001b3); } }
}
pub fn hash_polys(h: &mut Fnv, p: &Polys) {
    h.n(p.len());
    for q in p {
        h.n(q.contour.len());
        for v in &q.contour { h.f(v[0]); h.f(v[1]); }
        h.n(q.holes.len());
        for r in &q.holes { h.n(r.len()); for v in r { h.f(v[0]); h.f(v[1]); } }
    }
}
pub fn hash_layers(h: &mut Fnv, ls: &[Layer]) {
    h.n(ls.len());
    for l in ls { h.n(l.index); h.f(l.z); h.f(l.h); hash_polys(h, &l.region); }
}
/// Layers + per-layer reports + open loops: everything `SliceResult` carries.
pub fn hash_slice(r: &SliceResult) -> u64 {
    let mut h = Fnv::new();
    hash_layers(&mut h, &r.layers);
    for x in &r.reports { h.n(x.loops_topological); h.n(x.loops_gap_closed); h.n(x.open_loops); h.n(x.degenerate_loops); h.n(x.segments); }
    h.n(r.open_loops.len());
    for o in &r.open_loops { h.n(o.layer); h.f(o.gap); h.n(o.points.len()); for p in &o.points { h.f(p[0]); h.f(p[1]); } }
    h.0
}
/// Serialised statistics (serde_json prints the shortest round-trip repr of each f64, i.e. bit-exact) + segments.
pub fn hash_stats(s: &Stats) -> u64 {
    let mut h = Fnv::new();
    h.bytes(serde_json::to_string(&s.to_json()).unwrap_or_default().as_bytes());
    h.n(s.segments.len());
    for g in &s.segments { for v in g { h.f(*v); } }
    h.0
}

// ------------------------------------------------------------------ generators
fn stl_from_tris(tris: &[[[f32; 3]; 3]]) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b.extend((tris.len() as u32).to_le_bytes());
    for t in tris {
        b.extend([0u8; 12]);
        for v in t { for c in v { b.extend(c.to_le_bytes()); } }
        b.extend([0u8; 2]);
    }
    b
}
/// Closed parametric surface (u wraps always; v wraps when `v_closed`, else collapses to poles at both ends).
/// Outward winding for `flip = false` for the sphere/torus parametrisations below.
fn grid_surface(nu: usize, nv: usize, v_closed: bool, f: impl Fn(f64, f64) -> [f64; 3]) -> Vec<[[f32; 3]; 3]> {
    let tau = std::f64::consts::TAU;
    let pt = |i: usize, j: usize| -> [f32; 3] {
        let p = f((i % nu) as f64 / nu as f64 * tau, j as f64 / nv as f64);
        [p[0] as f32, p[1] as f32, p[2] as f32]
    };
    let mut t = Vec::new();
    for i in 0..nu {
        for j in 0..nv {
            let (a, b, c, d) = (pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1));
            let jj = if v_closed { j } else { usize::MAX };
            let _ = jj;
            if !v_closed && j == 0 { t.push([a, c, d]); } // pole: a == b
            else if !v_closed && j == nv - 1 { t.push([a, b, c]); } // pole: c == d
            else { t.push([a, b, c]); t.push([a, c, d]); }
        }
    }
    t
}
/// Binary STL of a UV sphere (radius `r` mm) with about `tris` triangles.
pub fn sphere_stl(tris: usize, r: f64) -> Vec<u8> {
    // tris ~= 2 * nu * nv, nu = 2 nv
    let nv = ((tris as f64 / 4.0).sqrt().round() as usize).max(4);
    let nu = 2 * nv;
    let t = grid_surface(nu, nv, false, |a, v| { let th = v * std::f64::consts::PI; [r * th.sin() * a.cos(), r * th.sin() * a.sin(), -r * th.cos()] });
    stl_from_tris(&t)
}
/// Binary STL of a torus (major `big`, minor `small`) with about `tris` triangles; slices into islands with holes.
pub fn torus_stl(tris: usize, big: f64, small: f64) -> Vec<u8> {
    let nv = ((tris as f64 / 4.0).sqrt().round() as usize).max(4);
    let nu = 2 * nv;
    let t = grid_surface(nu, nv, true, |a, v| { let b = v * std::f64::consts::TAU; let rr = big + small * b.cos(); [rr * a.cos(), rr * a.sin(), small * b.sin()] });
    stl_from_tris(&t)
}
/// ~`mb` MB of Orca-shaped G-code built by repeating the supplied real files (same bytes, many times).
pub fn repeat_to_size(parts: &[String], mb: usize) -> String {
    let mut out = String::with_capacity(mb << 20);
    let mut i = 0;
    while out.len() < (mb << 20) && !parts.is_empty() { out.push_str(&parts[i % parts.len()]); i += 1; }
    out
}
