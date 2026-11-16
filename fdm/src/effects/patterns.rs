//! Top / bottom surface fill patterns as Orca's Fill classes produce them: monotonic,
//! monotonicline, rectilinear, alignedrectilinear (rect.rs), concentric (classic loops variant),
//! hilbertcurve, archimedeanchords, octagramspiral (FillPlanePath).
//!
//! Pure functions over `types::Polys`; coordinates are millimetres in the OBJECT frame (Orca slices
//! around the object bbox centre; the G-code lane adds the instance shift), because the pattern
//! reference point and the rotation origin are the object centre.
use super::adapter as g;
use super::rect::{self, RectParams};
use crate::types::{Poly, Polys};
use std::f64::consts::{FRAC_PI_2, PI};

pub type Pl = Vec<[f64; 2]>;
const NM: f64 = 1e6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfacePattern { Monotonic, MonotonicLine, Rectilinear, AlignedRectilinear, Concentric, HilbertCurve, ArchimedeanChords, OctagramSpiral }
impl SurfacePattern {
    /// Orca config keys (`top_surface_pattern` / `bottom_surface_pattern` / `ironing_pattern`).
    pub fn from_key(k: &str) -> Option<Self> {
        Some(match k {
            "monotonic" => Self::Monotonic, "monotonicline" => Self::MonotonicLine, "rectilinear" => Self::Rectilinear,
            "alignedrectilinear" => Self::AlignedRectilinear, "concentric" => Self::Concentric,
            "hilbertcurve" => Self::HilbertCurve, "archimedeanchords" => Self::ArchimedeanChords,
            "octagramspiral" => Self::OctagramSpiral, _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CenterOfSurface { EachSurface, EachModel, EachAssembly }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FillOrder { Default, Outward, Inward }

/// Inputs Orca's `Fill` / `FillParams` carry for a solid surface fill. `Default` = the values
/// `Layer::make_fills` uses for a TOP surface of the X2D 0.20mm profile.
#[derive(Clone, Debug)]
pub struct FillParams {
    /// Flow spacing in mm (`Flow::spacing()` = width - h*(1-pi/4)). Lane output may adjust it, see `FillOut::spacing`.
    pub spacing: f64,
    /// 0..1.
    pub density: f64,
    /// `Fill::angle`, radians (`calculate_infill_rotation_angle`: solid_infill_direction, plus model alignment).
    pub angle: f64,
    /// Layer index for the odd/even 90 degree alternation; `usize::MAX` = undefined (no alternation).
    pub layer_id: usize,
    pub thickness_layers: usize,
    /// `Fill::fixed_angle` (top_layer_direction set / rotate template): no alternation.
    pub fixed_angle: bool,
    /// zaa_dont_alternate_fill_direction.
    pub dont_alternate: bool,
    /// `FillParams::dont_adjust` (false for surface fills, TRUE for ironing).
    pub dont_adjust: bool,
    /// `link_max_length` in mm. 0 = unlimited. Orca's `make_fills` computes `3 * f->spacing` BEFORE `f->spacing`
    /// is assigned (it is still 0), so surface fills (top/bottom/solid) always link without a length limit;
    /// only ironing sets it explicitly (3 * ironing_spacing). Measured against Orca on a cylinder top.
    pub link_max_length: f64,
    /// `anchor_length_max` in mm (1000 default; monotonicline forces 0 = no perimeter links).
    pub anchor_length_max: f64,
    /// Object bounding box centre in the object frame (pattern reference point).
    pub ref_point: [f64; 2],
    /// Object bounding box as (minx, miny, maxx, maxy), object frame (centered patterns, Each_Model/Assembly).
    pub object_bbox: Option<[f64; 4]>,
    pub center_of_surface: CenterOfSurface,
    pub fill_order: FillOrder,
    /// `Fill::overlap` in mm (0 for surface fills).
    pub overlap: f64,
    /// seam_gap in mm (concentric `clip_end`), 10% of the nozzle by default = 0.04.
    pub loop_clipping: f64,
    /// Curve discretisation tolerance, `resolution` config (0.012).
    pub resolution: f64,
}
impl Default for FillParams {
    fn default() -> Self {
        FillParams {
            spacing: 0.42 - 0.2 * (1.0 - PI / 4.0), density: 1.0, angle: PI / 4.0, layer_id: usize::MAX, thickness_layers: 1,
            fixed_angle: false, dont_alternate: false, dont_adjust: false,
            link_max_length: 0.0, anchor_length_max: 1000.0, ref_point: [0.0, 0.0],
            object_bbox: None, center_of_surface: CenterOfSurface::EachSurface, fill_order: FillOrder::Default,
            overlap: 0.0, loop_clipping: 0.04, resolution: 0.012,
        }
    }
}

/// Result for one expolygon of the input region.
#[derive(Clone, Debug)]
pub struct FillOut {
    /// Spacing actually used (Orca's `Fill::spacing` after `_adjust_solid_spacing`); flow width derives from it.
    pub spacing: f64,
    /// Ordered polylines, mm, object frame. Print order = vector order; Orca marks these `no_sort`
    /// for monotonic/monotonicline/concentric.
    pub polylines: Vec<Pl>,
}

/// Orca `Fill::_infill_direction().first`: rotation applied so that lines become vertical.
pub fn infill_theta(pat: SurfacePattern, p: &FillParams) -> f64 {
    let mut a = p.angle;
    if p.layer_id != usize::MAX && !p.fixed_angle && !p.dont_alternate {
        let idx = p.layer_id / p.thickness_layers.max(1);
        let alt = match pat {
            SurfacePattern::AlignedRectilinear | SurfacePattern::HilbertCurve | SurfacePattern::ArchimedeanChords | SurfacePattern::OctagramSpiral => 0.0,
            _ => if idx & 1 == 1 { FRAC_PI_2 } else { 0.0 },
        };
        a += alt;
    }
    a + FRAC_PI_2
}

/// Fill a (multi-island) region. One `FillOut` per input expolygon that produced extrusions.
pub fn fill_surface(region: &Polys, pat: SurfacePattern, p: &FillParams) -> Vec<FillOut> {
    let mut outs = Vec::new();
    for poly in region {
        let r = match pat {
            SurfacePattern::Monotonic | SurfacePattern::MonotonicLine | SurfacePattern::Rectilinear | SurfacePattern::AlignedRectilinear => {
                let monotonic = matches!(pat, SurfacePattern::Monotonic | SurfacePattern::MonotonicLine);
                let dont_connect = p.anchor_length_max < 0.05 || pat == SurfacePattern::MonotonicLine;
                let rp = RectParams {
                    spacing: p.spacing, density: p.density, theta: infill_theta(pat, p), overlap: p.overlap,
                    dont_adjust: p.dont_adjust, link_max_length: p.link_max_length, dont_connect, monotonic,
                    consistent_pattern: false, ref_point: p.ref_point,
                };
                let (pls, sp) = rect::fill_by_lines(poly, &rp);
                FillOut { spacing: sp, polylines: pls }
            }
            SurfacePattern::Concentric | SurfacePattern::HilbertCurve | SurfacePattern::ArchimedeanChords | SurfacePattern::OctagramSpiral => {
                // Fill::fill_surface (base class): offset_ex(expolygon, overlap - 0.5 * spacing), one call per piece
                let pieces = g::offset(&vec![poly.clone()], p.overlap - 0.5 * p.spacing);
                let mut all = FillOut { spacing: p.spacing, polylines: vec![] };
                for piece in &pieces {
                    let r = if pat == SurfacePattern::Concentric { concentric(piece, p) } else { plane_path(piece, pat, p) };
                    all.spacing = r.spacing;
                    all.polylines.extend(r.polylines);
                }
                all
            }
        };
        if !r.polylines.is_empty() { outs.push(r); }
    }
    outs
}

/// Convenience form of the lane brief: `(region, angle, spacing, pattern) -> ordered polylines`.
/// `angle` is `Fill::angle` in radians; density 1, no layer alternation (layer_id undefined).
pub fn surface_pattern(region: &Polys, angle: f64, spacing: f64, pattern: SurfacePattern) -> Vec<Pl> {
    let p = FillParams { spacing, angle, ..FillParams::default() };
    fill_surface(region, pattern, &p).into_iter().flat_map(|o| o.polylines).collect()
}

// ------------------------------------------------------------------ helpers
/// Uniform grid over polygon edges for fast crossing queries.
struct EdgeGrid {
    x0: f64, y0: f64, cell: f64, nx: usize, ny: usize,
    cells: Vec<Vec<u32>>,
    edges: Vec<([f64; 2], [f64; 2])>,
    stamp: std::cell::RefCell<Vec<u32>>,
    counter: std::cell::Cell<u32>,
}
impl EdgeGrid {
    fn new(poly: &Poly) -> Self {
        let mut edges = Vec::new();
        for r in std::iter::once(&poly.contour).chain(poly.holes.iter()) {
            let n = r.len();
            for i in 0..n { edges.push((r[i], r[(i + 1) % n])); }
        }
        let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for e in &edges { for p in [e.0, e.1] { minx = minx.min(p[0]); miny = miny.min(p[1]); maxx = maxx.max(p[0]); maxy = maxy.max(p[1]); } }
        let cell = (((maxx - minx).max(maxy - miny)) / 256.0).max(0.5);
        let nx = (((maxx - minx) / cell).ceil() as usize + 1).max(1);
        let ny = (((maxy - miny) / cell).ceil() as usize + 1).max(1);
        let mut cells: Vec<Vec<u32>> = vec![Vec::new(); nx * ny];
        for (i, e) in edges.iter().enumerate() {
            let (ex0, ex1) = (e.0[0].min(e.1[0]), e.0[0].max(e.1[0]));
            let (ey0, ey1) = (e.0[1].min(e.1[1]), e.0[1].max(e.1[1]));
            let (cx0, cx1) = (((ex0 - minx) / cell) as usize, (((ex1 - minx) / cell) as usize).min(nx - 1));
            let (cy0, cy1) = (((ey0 - miny) / cell) as usize, (((ey1 - miny) / cell) as usize).min(ny - 1));
            for cy in cy0..=cy1 { for cx in cx0..=cx1 { cells[cy * nx + cx].push(i as u32); } }
        }
        let ne = edges.len();
        EdgeGrid { x0: minx, y0: miny, cell, nx, ny, cells, edges, stamp: std::cell::RefCell::new(vec![0; ne]), counter: std::cell::Cell::new(0) }
    }
    /// Parameters t in (0,1) where the segment a->b crosses an edge.
    fn crossings(&self, a: [f64; 2], b: [f64; 2], out: &mut Vec<f64>) {
        let (sx0, sx1) = (a[0].min(b[0]), a[0].max(b[0]));
        let (sy0, sy1) = (a[1].min(b[1]), a[1].max(b[1]));
        let gx1 = self.x0 + self.nx as f64 * self.cell;
        let gy1 = self.y0 + self.ny as f64 * self.cell;
        if sx1 < self.x0 || sx0 > gx1 || sy1 < self.y0 || sy0 > gy1 { return; }
        let cx0 = (((sx0 - self.x0) / self.cell).floor().max(0.0)) as usize;
        let cx1 = ((((sx1 - self.x0) / self.cell).floor().max(0.0)) as usize).min(self.nx - 1);
        let cy0 = (((sy0 - self.y0) / self.cell).floor().max(0.0)) as usize;
        let cy1 = ((((sy1 - self.y0) / self.cell).floor().max(0.0)) as usize).min(self.ny - 1);
        let c = self.counter.get().wrapping_add(1);
        self.counter.set(c);
        let mut stamp = self.stamp.borrow_mut();
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        for cy in cy0..=cy1 { for cx in cx0..=cx1 { for &ei in &self.cells[cy * self.nx + cx] {
            if stamp[ei as usize] == c { continue; }
            stamp[ei as usize] = c;
            let (p, q) = self.edges[ei as usize];
            let (ex, ey) = (q[0] - p[0], q[1] - p[1]);
            let den = dx * ey - dy * ex;
            if den.abs() < 1e-18 { continue; }
            let t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den;
            let u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
            if t > 0.0 && t < 1.0 && (0.0..=1.0).contains(&u) { out.push(t); }
        } } }
    }
}

/// Clip an open polyline to a polygon (Clipper `intersection_pl`): the parts inside become polylines.
fn clip_polyline(pl: &[[f64; 2]], poly: &Poly) -> Vec<Pl> {
    let region: Polys = vec![poly.clone()];
    let grid = EdgeGrid::new(poly);
    let mut out: Vec<Pl> = Vec::new();
    let mut cur: Pl = Vec::new();
    if pl.len() < 2 { return out; }
    let mut inside_state = g::contains(&region, pl[0][0], pl[0][1]);
    let mut ts: Vec<f64> = Vec::new();
    for w in pl.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        ts.clear();
        ts.push(0.0); ts.push(1.0);
        grid.crossings(a, b, &mut ts);
        if ts.len() == 2 {
            // no crossing: the whole segment has the state of its start (continuity)
            if inside_state {
                if cur.is_empty() { cur.push(a); }
                else if let Some(l) = cur.last() { if (l[0] - a[0]).abs() > 1e-9 || (l[1] - a[1]).abs() > 1e-9 { out.push(std::mem::take(&mut cur)); cur.push(a); } }
                cur.push(b);
            } else if !cur.is_empty() { out.push(std::mem::take(&mut cur)); }
            continue;
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
        for k in 0..ts.len() - 1 {
            let (t0, t1) = (ts[k], ts[k + 1]);
            if t1 - t0 < 1e-12 { continue; }
            let tm = 0.5 * (t0 + t1);
            let inside = g::contains(&region, a[0] + dx * tm, a[1] + dy * tm);
            inside_state = inside;
            let p0 = [a[0] + dx * t0, a[1] + dy * t0];
            let p1 = [a[0] + dx * t1, a[1] + dy * t1];
            if inside {
                if cur.is_empty() { cur.push(p0); }
                else if let Some(l) = cur.last() { if (l[0] - p0[0]).abs() > 1e-9 || (l[1] - p0[1]).abs() > 1e-9 { out.push(std::mem::take(&mut cur)); cur.push(p0); } }
                cur.push(p1);
            } else if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out.into_iter().filter(|p| p.len() >= 2).collect()
}

/// Greedy nearest-endpoint chaining with reversal (approximation of `chain_polylines`).
pub fn chain_polylines(mut pls: Vec<Pl>) -> Vec<Pl> {
    let mut out = Vec::with_capacity(pls.len());
    if pls.is_empty() { return out; }
    let mut cur = pls.remove(0);
    loop {
        let end = *cur.last().unwrap();
        out.push(cur);
        if pls.is_empty() { break; }
        let mut best = (0usize, false, f64::INFINITY);
        for (i, p) in pls.iter().enumerate() {
            let d0 = (p[0][0] - end[0]).hypot(p[0][1] - end[1]);
            let d1 = (p.last().unwrap()[0] - end[0]).hypot(p.last().unwrap()[1] - end[1]);
            if d0 < best.2 { best = (i, false, d0); }
            if d1 < best.2 { best = (i, true, d1); }
        }
        cur = pls.remove(best.0);
        if best.1 { cur.reverse(); }
    }
    out
}

// ------------------------------------------------------------------ plane path fills
fn hilbert_n_to_xy(n: usize) -> (i64, i64) {
    const NEXT: [usize; 16] = [4, 0, 0, 12, 0, 4, 4, 8, 12, 8, 8, 4, 8, 12, 12, 0];
    const DX: [i64; 16] = [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0];
    const DY: [i64; 16] = [0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1];
    let mut ndigits = 0;
    let mut nc = n;
    while nc > 0 { nc >>= 2; ndigits += 1; }
    let mut state = if ndigits & 1 == 1 { 4usize } else { 0 };
    let (mut x, mut y) = (0i64, 0i64);
    for i in (0..ndigits).rev() {
        let digit = (n >> (i * 2)) & 3;
        state += digit;
        x |= DX[state] << i;
        y |= DY[state] << i;
        state = NEXT[state];
    }
    (x, y)
}

fn gen_hilbert(min_x: i64, min_y: i64, max_x: i64, max_y: i64) -> Vec<[f64; 2]> {
    let sz0 = (max_x + 1 - min_x).max(max_y + 1 - min_y) as usize;
    let mut sz = 2usize;
    while sz < sz0 { sz <<= 1; }
    let mut v = Vec::with_capacity(sz * sz);
    for i in 0..sz * sz { let (x, y) = hilbert_n_to_xy(i); v.push([(x + min_x) as f64, (y + min_y) as f64]); }
    v
}
fn gen_archimedean(max_x: i64, max_y: i64, resolution: f64) -> Vec<[f64; 2]> {
    let rmax = ((max_x as f64).powi(2) + (max_y as f64).powi(2)).sqrt() * 2f64.sqrt() + 1.5;
    let (a, b) = (1.0, 1.0 / (2.0 * PI));
    let mut theta = 0.0f64;
    let mut r = 1.0f64;
    let mut v = vec![[0.0, 0.0], [1.0, 0.0]];
    while r < rmax {
        theta += 2.0 * (1.0 - resolution / r).acos();
        r = a + b * theta;
        v.push([r * theta.cos(), r * theta.sin()]);
    }
    v
}
fn gen_octagram(max_x: i64, max_y: i64) -> Vec<[f64; 2]> {
    let rmax = ((max_x as f64).powi(2) + (max_y as f64).powi(2)).sqrt() * 2f64.sqrt() + 1.5;
    let mut r = 0.0f64;
    let r_inc = 2f64.sqrt();
    let mut v = vec![[0.0, 0.0]];
    while r < rmax {
        r += r_inc;
        let rx = r / 2f64.sqrt();
        let r2 = r + rx;
        v.extend_from_slice(&[[r, 0.0], [r2, rx], [rx, rx], [rx, r2], [0.0, r], [-rx, r2], [-rx, rx], [-r2, rx], [-r, 0.0], [-r2, -rx], [-rx, -rx], [-rx, -r2], [0.0, -r], [rx, -r2], [rx, -rx], [r2 + r_inc, -rx]]);
    }
    v
}

fn plane_path(poly: &Poly, pat: SurfacePattern, p: &FillParams) -> FillOut {
    let theta = infill_theta(pat, p);
    let rotated = g::rotate_polys(&vec![poly.clone()], -theta);
    // snug bbox in nm
    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for v in &rotated[0].contour {
        let (x, y) = ((v[0] * NM).round(), (v[1] * NM).round());
        bb[0] = bb[0].min(x); bb[1] = bb[1].min(y); bb[2] = bb[2].max(x); bb[3] = bb[3].max(y);
    }
    let infl = 100.0 + (p.spacing * NM).trunc(); // SCALED_EPSILON + scale_(spacing)*multiline(1)
    let snug = [bb[0] - infl, bb[1] - infl, bb[2] + infl, bb[3] + infl];
    let bounding_box = match (p.center_of_surface, p.object_bbox) {
        (CenterOfSurface::EachSurface, _) | (_, None) => snug,
        (mode, Some(ob)) => {
            // object bbox rotated by -theta (EachModel) or the sqrt(2)-extended box (EachAssembly)
            let c = [(ob[0] + ob[2]) * 0.5 * NM, (ob[1] + ob[3]) * 0.5 * NM];
            if mode == CenterOfSurface::EachModel {
                let rr = g::rotate_polys(&vec![Poly { contour: vec![[ob[0], ob[1]], [ob[2], ob[1]], [ob[2], ob[3]], [ob[0], ob[3]]], holes: vec![] }], -theta);
                let b = g::bbox(&rr).unwrap();
                [(b[0] * NM).round(), (b[1] * NM).round(), (b[2] * NM).round(), (b[3] * NM).round()]
            } else {
                let (hx, hy) = ((ob[2] - ob[0]) * 0.5 * NM, (ob[3] - ob[1]) * 0.5 * NM);
                let h = hx.max(hy) * 2f64.sqrt();
                [(c[0] - h).round(), (c[1] - h).round(), (c[0] + h).round(), (c[1] + h).round()]
            }
        }
    };
    let centered = !matches!(pat, SurfacePattern::HilbertCurve);
    let shift = if centered { [((bounding_box[0] + bounding_box[2]) * 0.5).trunc(), ((bounding_box[1] + bounding_box[3]) * 0.5).trunc()] } else { [bounding_box[0], bounding_box[1]] };
    let d = (p.spacing * NM) / p.density; // distance between lines, nm (double)
    let minx = ((bounding_box[0] - shift[0]) / d).ceil() as i64;
    let miny = ((bounding_box[1] - shift[1]) / d).ceil() as i64;
    let maxx = ((bounding_box[2] - shift[0]) / d).ceil() as i64;
    let maxy = ((bounding_box[3] - shift[1]) / d).ceil() as i64;
    let res = p.resolution * NM / d;
    let pts = match pat {
        SurfacePattern::HilbertCurve => gen_hilbert(minx, miny, maxx, maxy),
        SurfacePattern::ArchimedeanChords => gen_archimedean(maxx, maxy, res),
        _ => gen_octagram(maxx, maxy),
    };
    // scale by d, round to nm, translate by shift back into the rotated frame (mm)
    let line: Vec<[f64; 2]> = pts.iter().map(|q| [((q[0] * d + 0.5).floor() + shift[0]) / NM, ((q[1] * d + 0.5).floor() + shift[1]) / NM]).collect();
    let mut frags = clip_polyline(&line, &rotated[0]);
    if frags.is_empty() { return FillOut { spacing: p.spacing, polylines: vec![] }; }
    if p.fill_order != FillOrder::Default {
        // fragments appear in generation order already (centre outwards)
        if p.fill_order == FillOrder::Inward { frags.reverse(); for f in frags.iter_mut() { f.reverse(); } }
    } else {
        frags = chain_polylines(frags);
    }
    let (s, c) = theta.sin_cos();
    let polylines = frags.into_iter().map(|f| f.into_iter().map(|q| [q[0] * c - q[1] * s, q[0] * s + q[1] * c]).collect()).collect();
    FillOut { spacing: p.spacing, polylines }
}

// ------------------------------------------------------------------ concentric
fn clip_end(pl: &mut Pl, clip: f64) {
    let mut rem = clip;
    while rem > 0.0 && pl.len() >= 2 {
        let n = pl.len();
        let l = (pl[n - 1][0] - pl[n - 2][0]).hypot(pl[n - 1][1] - pl[n - 2][1]);
        if l <= rem { pl.pop(); rem -= l; } else {
            let t = (l - rem) / l;
            pl[n - 1] = [pl[n - 2][0] + (pl[n - 1][0] - pl[n - 2][0]) * t, pl[n - 2][1] + (pl[n - 1][1] - pl[n - 2][1]) * t];
            rem = 0.0;
        }
    }
}

/// Classic (non-Arachne) concentric loops. Orca routes density-100% top/bottom concentric through
/// Arachne (variable-width loops, lane 2); this is the branch it takes for density < 1 or dont_adjust.
fn concentric(poly: &Poly, p: &FillParams) -> FillOut {
    let mut spacing = p.spacing;
    let min_spacing = (p.spacing * NM).trunc();
    let mut distance = (min_spacing / p.density).trunc();
    let bb = g::bbox(&vec![poly.clone()]).unwrap();
    if p.density > 0.9999 && !p.dont_adjust {
        distance = rect::adjust_solid_spacing(((bb[2] - bb[0]) * NM).round(), distance);
        spacing = distance / NM;
    }
    let min_spacing_mm = p.spacing; // Orca keeps min_spacing from the unadjusted spacing
    let mut levels: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
    let mut last: Polys = vec![poly.clone()];
    let mut guard = 0;
    while !last.is_empty() && guard < 10_000 {
        levels.push(rings(&last));
        let step = distance / NM + min_spacing_mm * 0.5;
        let shrunk = g::offset(&last, -step);
        last = if shrunk.is_empty() { shrunk } else { g::offset(&shrunk, min_spacing_mm * 0.5) };
        guard += 1;
    }
    let mut loops: Vec<Vec<[f64; 2]>> = levels.into_iter().flatten().collect();
    if p.fill_order == FillOrder::Outward { loops.reverse(); }
    let mut out = Vec::new();
    let mut last_pos = [0.0f64, 0.0f64];
    for lp in loops {
        let mut best = 0;
        let mut bd = f64::INFINITY;
        for (i, q) in lp.iter().enumerate() { let d = (q[0] - last_pos[0]).hypot(q[1] - last_pos[1]); if d < bd { bd = d; best = i; } }
        let mut pl: Pl = lp[best..].iter().chain(lp[..best].iter()).copied().collect();
        pl.push(pl[0]);
        last_pos = *pl.last().unwrap();
        clip_end(&mut pl, p.loop_clipping);
        if pl.len() >= 2 { out.push(pl); }
    }
    FillOut { spacing, polylines: out }
}

fn rings(p: &Polys) -> Vec<Vec<[f64; 2]>> {
    let mut v = Vec::new();
    for q in p { v.push(q.contour.clone()); for h in &q.holes { v.push(h.clone()); } }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    fn rect(cx: f64, cy: f64, hw: f64, hh: f64) -> Polys {
        vec![Poly { contour: vec![[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]], holes: vec![] }]
    }
    fn circle(cx: f64, cy: f64, r: f64, n: usize, hole: bool) -> Vec<[f64; 2]> {
        let mut v: Vec<[f64; 2]> = (0..n).map(|i| { let a = 2.0 * PI * i as f64 / n as f64; [cx + r * a.cos(), cy + r * a.sin()] }).collect();
        if hole { v.reverse(); }
        v
    }
    fn total_len(pls: &[Pl]) -> f64 { pls.iter().map(|p| g::polyline_len(p)).sum() }
    fn sp() -> f64 { 0.42 - 0.2 * (1.0 - PI / 4.0) }

    /// Measured: OrcaSlicer 2.5.0-dev X2D 0.20mm, 20 mm cube, layer 99 top surface, monotonicline:
    /// 70 two-point paths, 982.77 mm. Region = square half width 9.696 (fitted from the line ends).
    #[test]
    fn monotonicline_cube_top_matches_orca() {
        let p = FillParams { spacing: sp(), layer_id: 99, anchor_length_max: 0.0, ..FillParams::default() };
        let out = fill_surface(&rect(0.0, 0.0, 9.696, 9.696), SurfacePattern::MonotonicLine, &p);
        assert_eq!(out.len(), 1);
        let pls = &out[0].polylines;
        assert_eq!(pls.len(), 70);
        assert!(pls.iter().all(|l| l.len() == 2));
        let l = total_len(pls);
        assert!((l - 982.77).abs() < 0.5, "{l}");
        // zig-zag: consecutive lines alternate direction in the rotated frame
        let d0 = [pls[0][1][0] - pls[0][0][0], pls[0][1][1] - pls[0][0][1]];
        let d1 = [pls[1][1][0] - pls[1][0][0], pls[1][1][1] - pls[1][0][1]];
        assert!(d0[0] * d1[0] + d0[1] * d1[1] < 0.0);
    }
    /// Negative control: the same region with perimeter links enabled must NOT stay 70 separate lines.
    #[test]
    fn monotonic_links_lines_into_one_polyline() {
        let p = FillParams { spacing: sp(), layer_id: 99, ..FillParams::default() };
        let out = fill_surface(&rect(0.0, 0.0, 9.696, 9.696), SurfacePattern::Monotonic, &p);
        assert_eq!(out[0].polylines.len(), 1);
        assert!((total_len(&out[0].polylines) - 986.79).abs() < 0.6); // Orca 986.79
    }
    #[test]
    fn alignedrectilinear_ignores_layer_parity() {
        let r = rect(0.0, 0.0, 9.0, 9.0);
        let mk = |layer| FillParams { spacing: sp(), layer_id: layer, ..FillParams::default() };
        let a = fill_surface(&r, SurfacePattern::AlignedRectilinear, &mk(0));
        let b = fill_surface(&r, SurfacePattern::AlignedRectilinear, &mk(1));
        assert_eq!(a[0].polylines, b[0].polylines);
        let c = fill_surface(&r, SurfacePattern::Rectilinear, &mk(0));
        let d = fill_surface(&r, SurfacePattern::Rectilinear, &mk(1));
        assert_ne!(c[0].polylines, d[0].polylines); // plain rectilinear alternates by 90 degrees
    }
    #[test]
    fn solid_spacing_is_adjusted_up_to_twenty_percent_only() {
        let p = FillParams { spacing: 0.4, ..FillParams::default() };
        let out = fill_surface(&rect(0.0, 0.0, 5.05, 5.05), SurfacePattern::MonotonicLine, &p);
        assert!(out[0].spacing >= 0.4 && out[0].spacing <= 0.4 * 1.2 + 1e-9);
        let off = FillParams { dont_adjust: true, ..p.clone() };
        let out2 = fill_surface(&rect(0.0, 0.0, 5.05, 5.05), SurfacePattern::MonotonicLine, &off);
        assert!((out2[0].spacing - 0.4).abs() < 1e-12);
    }
    #[test]
    fn region_with_hole_never_crosses_the_hole() {
        let mut ring = rect(0.0, 0.0, 10.0, 10.0);
        ring[0].holes.push(vec![[-3.0, -3.0], [-3.0, 3.0], [3.0, 3.0], [3.0, -3.0]]);
        for pat in [SurfacePattern::Monotonic, SurfacePattern::MonotonicLine, SurfacePattern::AlignedRectilinear, SurfacePattern::Rectilinear] {
            let p = FillParams { spacing: 0.4, layer_id: 0, ..FillParams::default() };
            let out = fill_surface(&ring, pat, &p);
            let pls: Vec<Pl> = out.into_iter().flat_map(|o| o.polylines).collect();
            assert!(!pls.is_empty(), "{pat:?}");
            // no sampled point of any polyline lies strictly inside the hole (shrunk a bit for the 0.5*spacing inset)
            for pl in &pls { for w in pl.windows(2) { for k in 0..=10 {
                let t = k as f64 / 10.0;
                let (x, y) = (w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t);
                assert!(!(x.abs() < 2.7 && y.abs() < 2.7), "{pat:?} crosses hole at {x},{y}");
            } } }
            // and fills the material: covered area ~ total length * spacing within 15%
            let area = 400.0 - 36.0;
            let covered = total_len(&pls) * 0.4;
            assert!(covered > 0.85 * area && covered < 1.15 * area, "{pat:?}: {covered} vs {area}");
        }
    }
    /// A test of the test: an obviously wrong fill (a straight line through the hole) must be detected by the same predicate.
    #[test]
    fn hole_crossing_predicate_has_teeth() {
        let line: [[f64; 2]; 2] = [[-5.0, 0.0], [5.0, 0.0]];
        let crosses = (0..=10).any(|k| { let x = -5.0 + k as f64; x.abs() < 2.7 && line[0][1].abs() < 2.7 });
        assert!(crosses);
    }
    #[test]
    fn plane_path_patterns_cover_region_and_stay_inside() {
        let r = vec![Poly { contour: circle(0.0, 0.0, 9.696, 180, false), holes: vec![] }];
        for pat in [SurfacePattern::HilbertCurve, SurfacePattern::ArchimedeanChords, SurfacePattern::OctagramSpiral] {
            let p = FillParams { spacing: sp(), ..FillParams::default() };
            let out = fill_surface(&r, pat, &p);
            let pls: Vec<Pl> = out.into_iter().flat_map(|o| o.polylines).collect();
            // fill region is the polygon shrunk by half the spacing; every vertex must lie within it
            for pl in &pls { for q in pl { assert!(q[0].hypot(q[1]) <= 9.696 - 0.5 * sp() + 1e-3, "{pat:?} outside: {q:?}"); } }
            // Orca on a 9.696 radius disc: 751 +- 1 mm (cylinder top, measured)
            let l = total_len(&pls);
            assert!((l - 751.0).abs() < 8.0, "{pat:?} {l}");
        }
    }
    #[test]
    fn concentric_loops_are_nested_and_spaced() {
        let r = rect(0.0, 0.0, 6.0, 6.0);
        let p = FillParams { spacing: 0.4, density: 1.0, dont_adjust: true, ..FillParams::default() };
        let out = fill_surface(&r, SurfacePattern::Concentric, &p);
        let pls = &out[0].polylines;
        assert!(pls.len() >= 10 && pls.len() <= 16, "{}", pls.len());
        // outermost loop first (outside-in)
        let ext = |pl: &Pl| pl.iter().fold(0.0f64, |m, q| m.max(q[0].abs().max(q[1].abs())));
        for w in pls.windows(2) { assert!(ext(&w[0]) >= ext(&w[1]) - 1e-9); }
    }
    #[test]
    fn empty_and_tiny_regions_yield_nothing() {
        let p = FillParams { spacing: 0.4, ..FillParams::default() };
        assert!(fill_surface(&vec![], SurfacePattern::Monotonic, &p).is_empty());
        assert!(fill_surface(&rect(0.0, 0.0, 0.1, 0.1), SurfacePattern::Monotonic, &p).is_empty());
    }
    #[test]
    fn from_key_roundtrip() {
        for (k, v) in [("monotonic", SurfacePattern::Monotonic), ("monotonicline", SurfacePattern::MonotonicLine), ("alignedrectilinear", SurfacePattern::AlignedRectilinear),
                       ("concentric", SurfacePattern::Concentric), ("hilbertcurve", SurfacePattern::HilbertCurve), ("archimedeanchords", SurfacePattern::ArchimedeanChords),
                       ("octagramspiral", SurfacePattern::OctagramSpiral)] { assert_eq!(SurfacePattern::from_key(k), Some(v)); }
        assert_eq!(SurfacePattern::from_key("gyroid"), None);
    }
}
