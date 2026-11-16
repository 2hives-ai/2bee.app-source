//! quality::analyze -- every metric, computed from a parsed G-code + the source mesh.
//!
//! Every function is a pure function of (segments, sliced contours, limits). Nothing here knows whether the
//! G-code came from Orca or from us: that is what lets the SAME instrument judge both sides.
use super::parse::{Blk, Kind, Parsed, Seg, QF};
use super::{Lim, MVal, Metrics};
use crate::geom;
use crate::mesh::Mesh;
use crate::slice::{slice_mesh, LayerSpec, SliceOptions};
use crate::types::{FdmError, Polys};

const PI: f64 = std::f64::consts::PI;

#[derive(Clone, Debug)]
pub struct Opt {
    /// raster cell, mm
    pub cell: f64,
    /// perturbed re-analyses used to measure the noise floor of every metric
    pub noise_runs: usize,
    /// override the automatic gcode<->mesh XY alignment
    pub offset: Option<[f64; 2]>,
}
impl Default for Opt { fn default() -> Self { Opt { cell: 0.05, noise_runs: 4, offset: None } } }

/// Per-layer reference geometry derived once from the mesh slice.
#[derive(Clone, Debug, Default)]
pub struct LayerGeom {
    pub region: Polys,
    /// cells that MUST be solid: shell zone eroded by `ERODE`
    pub solid_core: Polys,
    /// the outer wall band, eroded
    pub wall_core: Polys,
    /// region grown by `OUTSIDE_TOL`: extrusion beyond this is material outside the model
    pub grown: Polys,
    /// all contour edges: (a, b, ring orientation +1 outer / -1 hole)
    pub edges: Vec<([f64; 2], [f64; 2], f64)>,
}
/// Zone erosion: cells closer than this to a zone edge are not judged (raster edge effects are symmetric noise).
pub const ERODE: f64 = 0.06;
/// Extrusion further than this beyond the sliced contour is "outside the model".
pub const OUTSIDE_TOL: f64 = 0.05;
/// Gaps smaller than this area are raster dust. Defined in AREA (not cells): at a finer --cell the count must not explode.
pub const MIN_GAP_AREA_MM2: f64 = 0.01;
/// A bead edge is not sharp (stadium profile, 3-decimal coordinates, filament_flow_ratio < 1 narrowing E-derived width):
/// a void must be wider than 2 x COVER_SLACK = 0.05 mm to count as under-fill. Measured on Orca's own file: without this
/// slack the 0.02 mm seam between its outer and first inner wall reads as an 8% 'void' that moves with the raster lattice.
pub const COVER_SLACK: f64 = 0.025;
/// Shortest extrusion that counts toward `flow_peak_ratio`.
pub const PEAK_MIN_LEN: f64 = 2.0;

pub struct Prepared {
    pub parsed: Parsed,
    pub geoms: Vec<LayerGeom>,
    pub offset: [f64; 2],
    pub lim: Lim,
}

fn pseg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
}

fn bbox_of_ext(parsed: &Parsed) -> Option<[f64; 4]> {
    let mut bb: Option<[f64; 4]> = None;
    for s in parsed.segs.iter().filter(|s| s.kind == Kind::Extrude && s.feat.is_exterior_wall()) {
        for p in [s.a, s.b] {
            let b = bb.get_or_insert([p[0], p[1], p[0], p[1]]);
            b[0] = b[0].min(p[0]); b[1] = b[1].min(p[1]); b[2] = b[2].max(p[0]); b[3] = b[3].max(p[1]);
        }
    }
    bb
}

/// Align the mesh to the G-code frame, slice at the G-code's own layer stack, derive the reference zones.
pub fn prepare(parsed: Parsed, mesh: &Mesh, lim: Lim, opt: &Opt) -> Result<Prepared, FdmError> {
    let bb = bbox_of_ext(&parsed).ok_or_else(|| FdmError::Parse("no outer-wall extrusion in the G-code: cannot align it to the mesh".into()))?;
    let (mn, mx) = mesh.bbox();
    let off = opt.offset.unwrap_or([(bb[0] + bb[2]) / 2.0 - (mn[0] + mx[0]) / 2.0, (bb[1] + bb[3]) / 2.0 - (mn[1] + mx[1]) / 2.0]);
    let height = mx[2] - mn[2];
    let top = parsed.layers.last().map(|l| l.z).unwrap_or(0.0);
    let lh = parsed.layers.last().map(|l| l.h).unwrap_or(0.2);
    if (height - top).abs() > lh + 1e-6 {
        return Err(FdmError::Unsupported(format!("mesh height {height:.3} mm does not match the G-code top Z {top:.3} mm (more than one layer apart): wrong model for this G-code")));
    }
    let mut m = mesh.clone();
    m.translate([off[0], off[1], -mn[2]]);
    let specs: Vec<LayerSpec> = parsed.layers.iter().map(|l| LayerSpec { lo: l.z - l.h, hi: l.z, slice_z: l.z - l.h / 2.0 }).collect();
    let sr = slice_mesh(&m, &specs, SliceOptions::default());
    if sr.total_open_loops() > 0 { return Err(FdmError::Geometry(format!("mesh slice has {} open loops: reference contour unreliable", sr.total_open_loops()))); }
    let regions: Vec<Polys> = sr.layers.iter().map(|l| l.region.clone()).collect();
    let n = regions.len();
    let mut geoms = Vec::with_capacity(n);
    for i in 0..n {
        let h = parsed.layers[i].h.max(1e-3);
        let t = lim.top_layers.max((lim.top_thickness / h - 1e-6).ceil() as usize);
        let b = lim.bottom_layers.max((lim.bottom_thickness / h - 1e-6).ceil() as usize);
        let region = &regions[i];
        // above_all = intersection of the next t regions; empty if the part ends within t layers
        let mut above: Option<Polys> = None;
        let mut gone = false;
        for j in 1..=t {
            if i + j >= n { gone = true; break; }
            above = Some(match above { None => regions[i + j].clone(), Some(a) => geom::intersect(&a, &regions[i + j]) });
        }
        let mut below: Option<Polys> = None;
        let mut gone_b = false;
        for j in 1..=b {
            if j > i { gone_b = true; break; }
            below = Some(match below { None => regions[i - j].clone(), Some(a) => geom::intersect(&a, &regions[i - j]) });
        }
        let top_zone = if gone || above.is_none() { region.clone() } else { geom::diff(region, above.as_ref().unwrap()) };
        let bot_zone = if gone_b || below.is_none() { region.clone() } else { geom::diff(region, below.as_ref().unwrap()) };
        let zone = geom::union(&top_zone, &bot_zone);
        let solid_core = geom::inset(&zone, ERODE);
        let band_w = lim.outer_w + (lim.wall_loops.saturating_sub(1)) as f64 * lim.inner_w;
        let inner = geom::inset(region, band_w);
        let band = geom::diff(region, &inner);
        let wall_core = geom::inset(&band, ERODE);
        let grown = geom::outset(region, OUTSIDE_TOL);
        let mut edges = vec![];
        for q in region {
            for (ring, o) in std::iter::once((&q.contour, 1.0)).chain(q.holes.iter().map(|h| (h, -1.0))) {
                for k in 0..ring.len() { edges.push((ring[k], ring[(k + 1) % ring.len()], o)); }
            }
        }
        geoms.push(LayerGeom { region: region.clone(), solid_core, wall_core, grown, edges });
    }
    Ok(Prepared { parsed, geoms, offset: off, lim })
}

// ------------------------------------------------------------------------------------ perturbation
fn hash2(x: f64, y: f64, seed: u64) -> u64 {
    let mut h = seed ^ x.to_bits().wrapping_mul(0x9E3779B97F4A7C15) ^ y.to_bits().rotate_left(29).wrapping_mul(0xC2B2AE3D27D4EB4F);
    h ^= h >> 33; h = h.wrapping_mul(0xFF51AFD7ED558CCD); h ^= h >> 33; h = h.wrapping_mul(0xC4CEB9FE1A85EC53); h ^= h >> 33;
    h
}
/// +-0.5 um jitter keyed on the coordinate (so a shared end point jitters identically): the size of a G-code
/// coordinate rounding step (3 decimals).
fn jitter(p: [f64; 2], seed: u64) -> [f64; 2] {
    let h = hash2(p[0], p[1], seed);
    let u = |s: u32| (((h >> s) & 0xFFFF) as f64 / 65535.0 - 0.5) * 0.001;
    [p[0] + u(0), p[1] + u(16)]
}
fn perturbed(segs: &[Seg], seed: u64) -> Vec<Seg> {
    segs.iter().map(|s| { let mut t = *s; t.a = jitter(s.a, seed); t.b = jitter(s.b, seed); t }).collect()
}

// ------------------------------------------------------------------------------------ raster
struct Grid { ox: f64, oy: f64, c: f64, nx: usize, ny: usize }
impl Grid {
    fn idx(&self, ix: usize, iy: usize) -> usize { iy * self.nx + ix }
    fn center(&self, ix: usize, iy: usize) -> [f64; 2] { [self.ox + (ix as f64 + 0.5) * self.c, self.oy + (iy as f64 + 0.5) * self.c] }
}
/// Even-odd scanline fill of `polys` into a bool mask.
fn fill(polys: &Polys, g: &Grid) -> Vec<bool> {
    let mut m = vec![false; g.nx * g.ny];
    let mut xs: Vec<f64> = vec![];
    for iy in 0..g.ny {
        let y = g.oy + (iy as f64 + 0.5) * g.c;
        xs.clear();
        for q in polys {
            for ring in std::iter::once(&q.contour).chain(q.holes.iter()) {
                let n = ring.len();
                for k in 0..n {
                    let (a, b) = (ring[k], ring[(k + 1) % n]);
                    if (a[1] <= y) != (b[1] <= y) {
                        xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
                    }
                }
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for pair in xs.chunks(2) {
            if pair.len() < 2 { break; }
            let i0 = ((pair[0] - g.ox) / g.c - 0.5).ceil().max(0.0) as usize;
            let i1 = (((pair[1] - g.ox) / g.c - 0.5).floor() as i64).min(g.nx as i64 - 1);
            if i1 < 0 { continue; }
            for ix in i0..=(i1 as usize) { m[g.idx(ix, iy)] = true; }
        }
    }
    m
}

#[derive(Default, Clone)]
struct CovTally {
    gaplist: Vec<(usize, usize, [f64; 2])>,
    covered: f64, vol_cells: f64, over: f64, outside: f64,
    solid_cells: f64, solid_unc: f64, gaps: f64, gap_area: f64,
    wall_cells: f64, wall_unc: f64,
    fl_cells: f64, fl_cov: f64,
}

fn coverage(prep: &Prepared, segs: &[Seg], opt: &Opt, seed: u64) -> CovTally {
    let area = PI * prep.parsed.filament_d * prep.parsed.filament_d / 4.0;
    let c = opt.cell;
    let mut t = CovTally::default();
    let nl = prep.geoms.len();
    // group model-extrusion indices per layer
    let mut per: Vec<Vec<usize>> = vec![vec![]; nl];
    for (i, s) in segs.iter().enumerate() {
        if s.kind == Kind::Extrude && s.feat.is_model() && (s.layer as usize) < nl { per[s.layer as usize].push(i); }
    }
    // sub-cell grid origin shift (a noise source: where the raster lattice falls)
    let (sx, sy) = { let h = hash2(1.0, 2.0, seed); (((h & 0xFFFF) as f64 / 65535.0) * c, (((h >> 16) & 0xFFFF) as f64 / 65535.0) * c) };
    for (li, g) in prep.geoms.iter().enumerate() {
        let idxs = &per[li];
        if idxs.is_empty() && g.region.is_empty() { continue; }
        let mut bb = geom::bbox(&g.grown).unwrap_or([f64::MAX, f64::MAX, f64::MIN, f64::MIN]);
        for &i in idxs { for p in [segs[i].a, segs[i].b] { bb[0] = bb[0].min(p[0]); bb[1] = bb[1].min(p[1]); bb[2] = bb[2].max(p[0]); bb[3] = bb[3].max(p[1]); } }
        if bb[0] > bb[2] { continue; }
        let m = 1.5;
        let gr = Grid { ox: bb[0] - m - sx, oy: bb[1] - m - sy, c, nx: ((bb[2] - bb[0] + 2.0 * m) / c).ceil() as usize + 2, ny: ((bb[3] - bb[1] + 2.0 * m) / c).ceil() as usize + 2 };
        let ncell = gr.nx * gr.ny;
        // Two footprints per bead, both derived from the deposited volume (E):
        //  * VOLUME footprint  w_v = e*A/(len*h): the width a perfectly packed, rectangle-equivalent bead occupies.
        //    Overlap of these = excess material (over-fill).
        //  * FULL footprint    w_v + h*(1-pi/4): the stadium-shaped bead's real extent. A cell outside every FULL footprint
        //    is a real void (under-fill); bead-to-bead spacing of w - h(1-pi/4) is NOT a void.
        let mut cnt = vec![0u8; ncell];
        let mut cov = vec![false; ncell];
        let mut tight = vec![false; ncell];
        let mut mark = vec![0u32; ncell];
        for &i in idxs {
            let s = &segs[i];
            let len = s.len();
            let wv = if len >= 0.05 && s.h > 0.0 && s.e > 0.0 { s.e * area / (len * s.h) } else { (s.w - s.h * (1.0 - PI / 4.0)).max(0.05) };
            let wf = wv + s.h * (1.0 - PI / 4.0);
            let hv = (wv / 2.0).clamp(0.025, 1.5);
            let hf = (wf / 2.0).clamp(0.025, 1.5);
            let hs = hf + COVER_SLACK;
            let (x0, x1) = (s.a[0].min(s.b[0]) - hs, s.a[0].max(s.b[0]) + hs);
            let (y0, y1) = (s.a[1].min(s.b[1]) - hs, s.a[1].max(s.b[1]) + hs);
            let ix0 = (((x0 - gr.ox) / c).floor().max(0.0)) as usize;
            let ix1 = ((((x1 - gr.ox) / c).ceil()) as usize).min(gr.nx - 1);
            let iy0 = (((y0 - gr.oy) / c).floor().max(0.0)) as usize;
            let iy1 = ((((y1 - gr.oy) / c).ceil()) as usize).min(gr.ny - 1);
            for iy in iy0..=iy1 {
                for ix in ix0..=ix1 {
                    let p = gr.center(ix, iy);
                    let d = pseg_dist(p, s.a, s.b);
                    if d <= hs {
                        let k = gr.idx(ix, iy);
                        cov[k] = true;
                        if d <= hf { tight[k] = true; }
                        if d <= hv && mark[k] != s.path { mark[k] = s.path; cnt[k] = cnt[k].saturating_add(1); }
                    }
                }
            }
        }
        let grown = fill(&g.grown, &gr);
        let solid = fill(&g.solid_core, &gr);
        let wall = fill(&g.wall_core, &gr);
        let region = if li == 0 { Some(fill(&geom::inset(&g.region, ERODE), &gr)) } else { None };
        let mut unc = vec![false; ncell];
        for k in 0..ncell {
            let v = cnt[k];
            if v > 0 { t.vol_cells += 1.0; t.over += (v as f64) - 1.0; }
            if tight[k] {
                t.covered += 1.0;
                if !grown[k] { t.outside += 1.0; }
            }
            if solid[k] { t.solid_cells += 1.0; if !cov[k] { t.solid_unc += 1.0; unc[k] = true; } }
            if wall[k] { t.wall_cells += 1.0; if !cov[k] { t.wall_unc += 1.0; } }
            if let Some(r) = &region { if r[k] { t.fl_cells += 1.0; if cov[k] { t.fl_cov += 1.0; } } }
        }
        // connected uncovered components in the must-be-solid zone (4-neighbour)
        let mut seen = vec![false; ncell];
        let mut stack: Vec<usize> = vec![];
        for k0 in 0..ncell {
            if !unc[k0] || seen[k0] { continue; }
            seen[k0] = true; stack.clear(); stack.push(k0);
            let mut size = 0usize;
            let (mut sxx, mut syy) = (0.0, 0.0);
            while let Some(k) = stack.pop() {
                size += 1;
                { let p = gr.center(k % gr.nx, k / gr.nx); sxx += p[0]; syy += p[1]; }
                let (ix, iy) = (k % gr.nx, k / gr.nx);
                let mut nb = [usize::MAX; 4];
                if ix > 0 { nb[0] = k - 1; } if ix + 1 < gr.nx { nb[1] = k + 1; }
                if iy > 0 { nb[2] = k - gr.nx; } if iy + 1 < gr.ny { nb[3] = k + gr.nx; }
                for q in nb { if q != usize::MAX && unc[q] && !seen[q] { seen[q] = true; stack.push(q); } }
            }
            if size as f64 * c * c >= MIN_GAP_AREA_MM2 - 1e-12 { t.gaps += 1.0; t.gap_area += size as f64 * c * c; t.gaplist.push((li, size, [sxx / size as f64, syy / size as f64])); }
        }
    }
    t
}

// ------------------------------------------------------------------------------------ fidelity
fn dist_contour(g: &LayerGeom, p: [f64; 2]) -> (f64, f64) {
    let (mut best, mut o) = (f64::MAX, 1.0);
    for &(a, b, ori) in &g.edges {
        let d = pseg_dist(p, a, b);
        if d < best { best = d; o = ori; }
    }
    (best, o)
}

struct Fid { errs: Vec<f64> }
fn fidelity(prep: &Prepared, segs: &[Seg]) -> Fid {
    let mut errs = vec![];
    for s in segs.iter().filter(|s| s.kind == Kind::Extrude && s.feat.is_exterior_wall()) {
        let Some(g) = prep.geoms.get(s.layer as usize) else { continue };
        let len = s.len();
        let n = (len / 0.25).ceil().max(1.0) as usize;
        let w = if s.w > 0.0 { s.w } else { prep.lim.outer_w };
        for k in 0..n {
            let t = (k as f64 + 0.5) / n as f64;
            let p = [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])];
            let (d, _) = dist_contour(g, p);
            let inside = geom::point_in_polys(&g.region, p[0], p[1]);
            let sd = if inside { d } else { -d };
            errs.push((sd - w / 2.0).abs());
        }
    }
    Fid { errs }
}

// ------------------------------------------------------------------------------------ seams
struct Loops { seam_score: Vec<f64>, scatter: Vec<f64> }
fn seams(prep: &Prepared, segs: &[Seg]) -> Loops {
    // group consecutive contiguous exterior-wall extrusion into loops
    let mut loops: Vec<Vec<&Seg>> = vec![];
    let mut cur: Vec<&Seg> = vec![];
    fn flush<'a>(cur: &mut Vec<&'a Seg>, loops: &mut Vec<Vec<&'a Seg>>) { if !cur.is_empty() { loops.push(std::mem::take(cur)); } }
    for s in segs {
        if s.kind == Kind::Extrude && s.feat.is_exterior_wall() {
            if let Some(l) = cur.last() {
                if l.layer != s.layer || (l.b[0] - s.a[0]).hypot(l.b[1] - s.a[1]) > 1e-3 { flush(&mut cur, &mut loops); }
            }
            cur.push(s);
        } else { flush(&mut cur, &mut loops); }
    }
    flush(&mut cur, &mut loops);
    let mut score = vec![];
    let mut per_layer: Vec<Vec<[f64; 2]>> = vec![vec![]; prep.geoms.len()];
    for lp in &loops {
        let first = lp[0];
        let last = lp[lp.len() - 1];
        let perim: f64 = lp.iter().map(|s| s.len()).sum();
        if perim < 1.0 || (first.a[0] - last.b[0]).hypot(first.a[1] - last.b[1]) > 0.3 { continue; }
        let Some(g) = prep.geoms.get(first.layer as usize) else { continue };
        let din = [last.b[0] - last.a[0], last.b[1] - last.a[1]];
        let dout = [first.b[0] - first.a[0], first.b[1] - first.a[1]];
        let turn = (din[0] * dout[1] - din[1] * dout[0]).atan2(din[0] * dout[0] + din[1] * dout[1]);
        // loop orientation
        let mut a2 = 0.0;
        for s in lp { a2 += s.a[0] * s.b[1] - s.b[0] * s.a[1]; }
        let lori = if a2 >= 0.0 { 1.0 } else { -1.0 };
        let (_, cori) = dist_contour(g, first.a);
        let convex_signed = turn * if lori == cori { 1.0 } else { -1.0 };
        let thr = 15f64.to_radians();
        score.push(if convex_signed > thr { 1.0 } else if convex_signed < -thr { 0.0 } else { 0.5 });
        per_layer[first.layer as usize].push(first.a);
    }
    let mut scatter = vec![];
    for l in 1..per_layer.len() {
        for p in &per_layer[l] {
            let mut best = f64::MAX;
            for q in &per_layer[l - 1] { best = best.min((p[0] - q[0]).hypot(p[1] - q[1])); }
            if best < f64::MAX { scatter.push(best.min(20.0)); }
        }
    }
    Loops { seam_score: score, scatter }
}

// ------------------------------------------------------------------------------------ time
/// Two-pass trapezoid planner with classic-jerk junction limits. An ESTIMATOR: the same one judges both sides;
/// its absolute error against the printer is not measured here (see DIVERGENCES.md "instrument limits").
pub fn plan_times(blks: &[Blk], jerk: f64) -> Vec<f64> {
    let n = blks.len();
    let mut t = vec![0.0; n];
    let mut i = 0;
    while i < n {
        if blks[i].len <= 0.0 { t[i] = blks[i].fixed_t; i += 1; continue; }
        let mut j = i;
        while j < n && blks[j].len > 0.0 { j += 1; }
        let m = j - i; // run i..j
        let mut v = vec![0.0f64; m + 1];
        for k in 1..m {
            let (a, b) = (&blks[i + k - 1], &blks[i + k]);
            let (ax, ay, bx, by) = (a.v * a.dir[0], a.v * a.dir[1], b.v * b.dir[0], b.v * b.dir[1]);
            let dv = (ax - bx).hypot(ay - by);
            let vm = a.v.min(b.v);
            v[k] = if dv > jerk && dv > 0.0 { vm * jerk / dv } else { vm };
        }
        for k in (1..m).rev() { let b = &blks[i + k]; v[k] = v[k].min((v[k + 1] * v[k + 1] + 2.0 * b.acc * b.len).sqrt()); }
        for k in 1..m { let a = &blks[i + k - 1]; v[k] = v[k].min((v[k - 1] * v[k - 1] + 2.0 * a.acc * a.len).sqrt()); }
        for k in 0..m {
            let b = &blks[i + k];
            let (v0, v1, vc, a, l) = (v[k].min(b.v), v[k + 1].min(b.v), b.v, b.acc, b.len);
            let dacc = (vc * vc - v0 * v0) / (2.0 * a);
            let ddec = (vc * vc - v1 * v1) / (2.0 * a);
            t[i + k] = if dacc + ddec > l {
                let vp = ((2.0 * a * l + v0 * v0 + v1 * v1) / 2.0).sqrt().max(v0.max(v1));
                (vp - v0) / a + (vp - v1) / a
            } else { (vc - v0) / a + (vc - v1) / a + (l - dacc - ddec) / vc };
        }
        i = j;
    }
    t
}

// ------------------------------------------------------------------------------------ metrics
fn mv(v: Option<f64>, n: usize) -> MVal { MVal { v, n } }
fn pct(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    let k = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[k]
}

/// Compute every registered metric. `seed` 0 = the reference run; others perturb coordinates (+-0.5 um) and the
/// raster lattice for the noise-floor measurement.
pub fn metrics(prep: &Prepared, opt: &Opt, seed: u64) -> Metrics {
    let owned;
    let segs: &[Seg] = if seed == 0 { &prep.parsed.segs } else { owned = perturbed(&prep.parsed.segs, seed); &owned };
    let lim = &prep.lim;
    let area = PI * prep.parsed.filament_d * prep.parsed.filament_d / 4.0;
    let mut m = Metrics::new();

    // --- dimensional fidelity
    let fid = fidelity(prep, segs);
    let mut e = fid.errs.clone();
    e.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = e.len();
    let have = n > 0;
    m.insert("dim_err_mean_mm", mv(have.then(|| e.iter().sum::<f64>() / n as f64), n));
    m.insert("dim_err_p95_mm", mv(have.then(|| pct(&e, 0.95)), n));
    m.insert("dim_err_max_mm", mv(have.then(|| *e.last().unwrap()), n));

    // --- coverage (raster)
    let t = coverage(prep, segs, opt, seed);
    let ratio = |a: f64, b: f64| if b > 0.0 { Some(100.0 * a / b) } else { None };
    m.insert("outside_region_pct", mv(ratio(t.outside, t.covered), t.covered as usize));
    m.insert("overfill_pct", mv(ratio(t.over, t.vol_cells), t.vol_cells as usize));
    m.insert("solid_underfill_pct", mv(ratio(t.solid_unc, t.solid_cells), t.solid_cells as usize));
    m.insert("solid_gap_count", mv((t.solid_cells > 0.0).then_some(t.gaps), t.solid_cells as usize));
    m.insert("solid_gap_area_mm2", mv((t.solid_cells > 0.0).then_some(t.gap_area), t.solid_cells as usize));
    m.insert("wall_underfill_pct", mv(ratio(t.wall_unc, t.wall_cells), t.wall_cells as usize));
    m.insert("first_layer_coverage_pct", mv(ratio(t.fl_cov, t.fl_cells), t.fl_cells as usize));

    // --- seams
    let lp = seams(prep, segs);
    m.insert("seam_visibility", mv((!lp.seam_score.is_empty()).then(|| lp.seam_score.iter().sum::<f64>() / lp.seam_score.len() as f64), lp.seam_score.len()));
    m.insert("seam_scatter_mm", mv((!lp.scatter.is_empty()).then(|| lp.scatter.iter().sum::<f64>() / lp.scatter.len() as f64), lp.scatter.len()));

    // --- motion
    let travel: f64 = segs.iter().filter(|s| s.kind != Kind::Extrude).map(|s| s.len()).sum();
    m.insert("travel_mm", mv(Some(travel), segs.iter().filter(|s| s.kind != Kind::Extrude).count()));
    m.insert("retract_count", mv(Some(prep.parsed.retract_layers.len() as f64), prep.parsed.retract_layers.len()));
    m.insert("zhop_count", mv(Some(prep.parsed.zhop_layers.len() as f64), prep.parsed.zhop_layers.len()));

    // --- time
    let bt = plan_times(&prep.parsed.blks, lim.jerk.max(1.0));
    let nl = prep.parsed.layers.len();
    let mut lt = vec![0.0; nl];
    for (b, tt) in prep.parsed.blks.iter().zip(&bt) { if b.layer >= 0 && (b.layer as usize) < nl { lt[b.layer as usize] += tt; } }
    let total: f64 = lt.iter().sum();
    m.insert("print_time_s", mv(Some(total), prep.parsed.blks.len()));
    m.insert("layer_time_deficit_s", mv(Some(lt.iter().map(|&x| (lim.min_layer_time - x).max(0.0)).sum()), nl));
    m.insert("min_layer_time_violations", mv(Some(lt.iter().filter(|&&x| x < lim.min_layer_time).count() as f64), nl));

    // --- machine limits
    let ext: Vec<&Seg> = segs.iter().filter(|s| s.kind == Kind::Extrude).collect();
    let (mut fcount, mut fpeak, mut fn_) = (0.0, 0.0f64, 0usize);
    for s in ext.iter().filter(|s| s.len() >= 0.3) {
        let q = s.speed * s.e * area / s.len();
        let r = q / lim.flow_max;
        fn_ += 1;
        if r > 1.03 { fcount += 1.0; }
        // PEAK only over extrusions >= PEAK_MIN_LEN: a 0.5 mm segment never reaches its commanded feed, so its
        // 'peak' is a property of the segmenter, not of the print. (Definition change 1, DIVERGENCES.md: Orca's own file
        // reads 1.000 on a 0.53 mm segment of the ring model.) Violations above the limit still count from 0.3 mm.
        if s.len() >= PEAK_MIN_LEN { fpeak = fpeak.max(r); }
    }
    m.insert("flow_violation_count", mv((fn_ > 0).then_some(fcount), fn_));
    m.insert("flow_peak_ratio", mv((fn_ > 0).then_some(fpeak), fn_));
    let (mut acount, mut apeak, mut an) = (0.0, 0.0f64, 0usize);
    for s in ext.iter().filter(|s| s.accel > 0.0) {
        let r = s.accel / lim.acc_max;
        an += 1;
        if r > 1.001 { acount += 1.0; }
        apeak = apeak.max(r);
    }
    m.insert("accel_violation_count", mv((an > 0).then_some(acount), an));
    m.insert("accel_peak_ratio", mv((an > 0).then_some(apeak), an));
    let mut jr: Vec<f64> = vec![];
    for w in segs.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if a.kind != Kind::Extrude || b.kind != Kind::Extrude || b.arc_cont || a.layer != b.layer { continue; }
        if (a.b[0] - b.a[0]).hypot(a.b[1] - b.a[1]) > 1e-3 { continue; }
        let (la, lb) = (a.len(), b.len());
        if la <= 0.0 || lb <= 0.0 { continue; }
        let va = [a.speed * (a.b[0] - a.a[0]) / la, a.speed * (a.b[1] - a.a[1]) / la];
        let vb = [b.speed * (b.b[0] - b.a[0]) / lb, b.speed * (b.b[1] - b.a[1]) / lb];
        jr.push((va[0] - vb[0]).hypot(va[1] - vb[1]) / lim.jerk.max(1e-6));
    }
    jr.sort_by(|a, b| a.partial_cmp(b).unwrap());
    m.insert("jerk_ratio_p95", mv((!jr.is_empty()).then(|| pct(&jr, 0.95)), jr.len()));
    m.insert("jerk_violation_count", mv((!jr.is_empty()).then(|| jr.iter().filter(|&&x| x > 1.0).count() as f64), jr.len()));

    // --- bridges
    let br: Vec<&Seg> = ext.iter().copied().filter(|s| s.feat == QF::Bridge).collect();
    if br.is_empty() {
        for k in ["bridge_span_max_mm", "bridge_speed_dev_pct", "bridge_fan_shortfall_pct"] { m.insert(k, mv(None, 0)); }
    } else {
        m.insert("bridge_span_max_mm", mv(Some(br.iter().map(|s| s.len()).fold(0.0, f64::max)), br.len()));
        let dev = br.iter().filter(|s| s.len() >= 0.5).map(|s| 100.0 * (s.speed - lim.bridge_speed).abs() / lim.bridge_speed.max(1e-6)).fold(0.0, f64::max);
        m.insert("bridge_speed_dev_pct", mv(Some(dev), br.len()));
        let need = 0.95 * lim.overhang_fan_pct * 2.55;
        let tot: f64 = br.iter().map(|s| s.len()).sum();
        let short: f64 = br.iter().filter(|s| s.fan < need).map(|s| s.len()).sum();
        m.insert("bridge_fan_shortfall_pct", mv((tot > 0.0).then(|| 100.0 * short / tot), br.len()));
    }

    // --- material / flow consistency
    let fil: f64 = segs.iter().filter(|s| s.kind == Kind::Extrude).map(|s| s.e).sum();
    m.insert("filament_mm", mv(Some(fil), ext.len()));
    let (mut num, mut den) = (0.0, 0.0);
    for s in ext.iter().filter(|s| s.len() >= 0.5 && s.w > 0.0 && s.h > 0.0 && s.feat.is_model() && !matches!(s.feat, QF::Bridge | QF::InternalBridge)) {
        let wf = s.e * area / (s.len() * s.h) + s.h * (1.0 - PI / 4.0);
        num += s.len() * (wf - s.w).abs() / s.w;
        den += s.len();
    }
    m.insert("width_flow_err_pct", mv((den > 0.0).then(|| 100.0 * num / den), 0));
    m
}

/// Mean exterior-wall error, used as the mesh<->G-code alignment sanity check.
pub fn alignment_error(prep: &Prepared) -> Option<f64> {
    let f = fidelity(prep, &prep.parsed.segs);
    if f.errs.is_empty() { None } else { Some(f.errs.iter().sum::<f64>() / f.errs.len() as f64) }
}

/// Human-readable pointers to WHERE a metric's value comes from (reference run only). Diagnostics, never verdict inputs.
pub fn notes(prep: &Prepared, opt: &Opt) -> std::collections::BTreeMap<&'static str, String> {
    let mut n = std::collections::BTreeMap::new();
    let segs = &prep.parsed.segs;
    let area = PI * prep.parsed.filament_d * prep.parsed.filament_d / 4.0;
    let mut best: Option<(f64, &Seg)> = None;
    for s in segs.iter().filter(|s| s.kind == Kind::Extrude && s.len() >= 0.3) {
        let r = s.speed * s.e * area / s.len() / prep.lim.flow_max;
        if best.map_or(true, |b| r > b.0) { best = Some((r, s)); }
    }
    if let Some((r, s)) = best { n.insert("flow_peak_ratio", format!("peak {:.3} of limit: feature {:?}, layer {}, {:.1} mm/s, seg {:.2} mm", r, s.feat, s.layer, s.speed, s.len())); }
    let mut byf: std::collections::BTreeMap<String, (f64, f64)> = Default::default();
    for s in segs.iter().filter(|s| s.kind == Kind::Extrude) {
        let r = s.speed * s.e * area / s.len().max(1e-9) / prep.lim.flow_max;
        let e = byf.entry(format!("{:?}", s.feat)).or_insert((0.0, 0.0));
        if s.len() >= 0.3 { e.0 = e.0.max(r); }
        e.1 += s.len();
    }
    n.insert("flow_by_feature", byf.iter().map(|(k, v)| format!("{k}: peak {:.2} over {:.0} mm", v.0, v.1)).collect::<Vec<_>>().join("; "));
    let t = coverage(prep, segs, opt, 0);
    let mut g = t.gaplist.clone();
    g.sort_by(|a, b| b.1.cmp(&a.1));
    n.insert("solid_gap_count", format!("{} patches; largest 5: {}", g.len(), g.iter().take(5).map(|(l, c, p)| format!("layer {l} {} mm2 at ({:.1},{:.1})", *c as f64 * opt.cell * opt.cell, p[0], p[1])).collect::<Vec<_>>().join("; ")));
    let mut layers: std::collections::BTreeMap<usize, usize> = Default::default();
    for (l, _, _) in &g { *layers.entry(*l).or_default() += 1; }
    n.insert("solid_gap_layers", format!("{:?}", layers));
    let tr: f64 = segs.iter().filter(|s| s.kind != Kind::Extrude).map(|s| s.len()).sum();
    let wipe: f64 = segs.iter().filter(|s| s.kind == Kind::Wipe).map(|s| s.len()).sum::<f64>() + 0.0;
    n.insert("travel_mm", format!("{:.0} mm non-extruding, of which {:.0} mm are wipes (retracting moves); {} travel moves", tr, wipe, segs.iter().filter(|s| s.kind == Kind::Travel).count()));
    n
}
