//! SupportGridPattern (SupportMaterial.cpp, SUPPORT_USE_AGG_RASTERIZER branch): stretch support
//! islands into a coarse raster grid so that the support columns of successive layers line up.
//! Ported step by step: rasterize (exact area coverage instead of AGG; nonzero at >= 1/256),
//! seed-fill per macro block up to the eroded trimming mask, trace the pixel boundaries, keep the
//! corner points shifted by `offset_in_grid`, subtract the trimming polygons, keep the islands that
//! contain a sample of the source polygons.
use super::config::SupportStyle;
use super::poly::{self, scaled, unscaled};
use crate::types::{Poly, Polys, Ring};

/// Orca's `SupportGridParams` (lengths in mm).
#[derive(Clone, Copy, Debug)]
pub struct GridParams {
    pub style: SupportStyle,
    pub grid_resolution: f64,
    pub support_angle: f64,
    pub extrusion_width: f64,
    pub support_closing_radius: f64,
    pub expansion_to_slice: f64,
    pub expansion_to_propagate: f64,
}
impl GridParams {
    /// `spacing` = support base pattern spacing, `flow_spacing` = support material flow spacing.
    pub fn new(style: SupportStyle, base_spacing: f64, angle_deg: f64, flow_spacing: f64) -> GridParams {
        GridParams {
            style,
            grid_resolution: base_spacing + flow_spacing, // double + float, as in Orca
            support_angle: angle_deg.to_radians(),
            extrusion_width: flow_spacing,
            support_closing_radius: 2.0,
            // coord_t(scaled_spacing / 2 + 5) in 1e-6 mm units
            expansion_to_slice: unscaled(poly::scale_trunc(flow_spacing) / 2 + 5),
            expansion_to_propagate: unscaled(-3),
        }
    }
}

pub struct SupportGridPattern<'a> {
    style: SupportStyle,
    support: Polys,
    trimming: &'a Polys,
    trimming_rot: Polys,
    spacing: f64,
    angle: f64,
    extrusion_width: f64,
    closing_radius: f64,
    // grid (scaled units)
    bbox_min: [i64; 2],
    pixel: f64,
    gw: usize,
    gh: usize,
    grid: Vec<u8>,
}

// ---------- exact-area scanline rasterizer (accumulation buffer) ----------
fn raster_edge(acc: &mut [f64], stride: usize, w: usize, h: usize, p0: (f64, f64), p1: (f64, f64)) {
    if p0.1 == p1.1 { return; }
    let (dir, p0, p1) = if p0.1 < p1.1 { (1.0, p0, p1) } else { (-1.0, p1, p0) };
    let dxdy = (p1.0 - p0.0) / (p1.1 - p0.1);
    let mut x = p0.0;
    let mut y0 = p0.1;
    if y0 < 0.0 { x -= y0 * dxdy; y0 = 0.0; }
    let y_end = p1.1.min(h as f64);
    if y0 >= y_end { return; }
    let ystart = y0.floor() as usize;
    let yend = y_end.ceil() as usize;
    for y in ystart..yend.min(h) {
        let line = y * stride;
        let dy = ((y + 1) as f64).min(y_end) - (y as f64).max(y0);
        let xnext = x + dxdy * dy;
        let d = dy * dir;
        let (x0, x1) = if x < xnext { (x, xnext) } else { (xnext, x) };
        let x0f = x0.floor();
        let x0i = x0f as usize;
        let x1c = x1.ceil();
        let x1i = x1c as usize;
        if x1i <= x0i + 1 {
            let xmf = 0.5 * (x + xnext) - x0f;
            acc[line + x0i] += d - d * xmf;
            acc[line + x0i + 1] += d * xmf;
        } else {
            let s = 1.0 / (x1 - x0);
            let x0fr = x0 - x0f;
            let a0 = 0.5 * s * (1.0 - x0fr) * (1.0 - x0fr);
            let x1fr = x1 - x1c + 1.0;
            let am = 0.5 * s * x1fr * x1fr;
            acc[line + x0i] += d * a0;
            if x1i == x0i + 2 {
                acc[line + x0i + 1] += d * (1.0 - a0 - am);
            } else {
                let a1 = s * (1.5 - x0fr);
                acc[line + x0i + 1] += d * (a1 - a0);
                for xi in x0i + 2..x1i - 1 { acc[line + xi] += d * s; }
                let a2 = a1 + (x1i - x0i - 3) as f64 * s;
                acc[line + x1i - 1] += d * (1.0 - a2 - am);
            }
            acc[line + x1i] += d * am;
        }
        x = xnext;
    }
    let _ = w;
}

/// Clip a segment against the x range [0, w] by splitting; pieces outside become vertical edges on the border.
fn raster_edge_clipped(acc: &mut [f64], stride: usize, w: usize, h: usize, a: (f64, f64), b: (f64, f64)) {
    let wf = w as f64;
    // split parameters
    let mut ts = vec![0.0f64, 1.0];
    for bound in [0.0, wf] {
        if (a.0 - bound) * (b.0 - bound) < 0.0 { ts.push((bound - a.0) / (b.0 - a.0)); }
    }
    ts.sort_by(|p, q| p.partial_cmp(q).unwrap());
    for k in 0..ts.len() - 1 {
        let (t0, t1) = (ts[k], ts[k + 1]);
        if t1 - t0 <= 0.0 { continue; }
        let p = (a.0 + (b.0 - a.0) * t0, a.1 + (b.1 - a.1) * t0);
        let q = (a.0 + (b.0 - a.0) * t1, a.1 + (b.1 - a.1) * t1);
        let mx = 0.5 * (p.0 + q.0);
        if mx < 0.0 {
            raster_edge(acc, stride, w, h, (0.0, p.1), (0.0, q.1));
        } else if mx > wf {
            raster_edge(acc, stride, w, h, (wf, p.1), (wf, q.1));
        } else {
            let pc = (p.0.clamp(0.0, wf), p.1);
            let qc = (q.0.clamp(0.0, wf), q.1);
            raster_edge(acc, stride, w, h, pc, qc);
        }
    }
}

fn rasterize(gw: usize, gh: usize, pixel: f64, lb: [i64; 2], polys: &Polys) -> Vec<u8> {
    let stride = gw + 2;
    let mut acc = vec![0.0f64; stride * gh + 2];
    for p in polys {
        for ring in std::iter::once(&p.contour).chain(p.holes.iter()) {
            let n = ring.len();
            if n < 3 { continue; }
            let cv = |q: &[f64; 2]| -> (f64, f64) { ((scaled(q[0]) - lb[0]) as f64 / pixel, (scaled(q[1]) - lb[1]) as f64 / pixel) };
            for i in 0..n {
                let a = cv(&ring[i]);
                let b = cv(&ring[(i + 1) % n]);
                raster_edge_clipped(&mut acc, stride, gw, gh, a, b);
            }
        }
    }
    let mut out = vec![0u8; gw * gh];
    for y in 0..gh {
        let mut s = 0.0f64;
        for x in 0..gw {
            s += acc[y * stride + x];
            let cov = s.abs().min(1.0);
            // AGG gray8: alpha = floor(coverage*256) clamped to 255; a pixel is set if alpha >= 1
            if cov >= 1.0 / 256.0 { out[y * gw + x] = 255; }
        }
    }
    out
}

fn align_to_grid(coord: i64, spacing: i64) -> i64 {
    if coord < 0 { ((coord - spacing + 1) / spacing) * spacing } else { (coord / spacing) * spacing }
}

impl<'a> SupportGridPattern<'a> {
    pub fn new(support: &Polys, trimming: &'a Polys, params: &GridParams) -> SupportGridPattern<'a> {
        let mut style = params.style;
        if style == SupportStyle::Default { style = SupportStyle::Grid; }
        if matches!(style, SupportStyle::TreeSlim | SupportStyle::TreeStrong | SupportStyle::TreeHybrid | SupportStyle::TreeOrganic) { style = SupportStyle::Grid; }
        let mut s = SupportGridPattern {
            style, support: support.clone(), trimming, trimming_rot: Vec::new(), spacing: params.grid_resolution,
            angle: params.support_angle, extrusion_width: params.extrusion_width, closing_radius: params.support_closing_radius,
            bbox_min: [0, 0], pixel: 1.0, gw: 0, gh: 0, grid: Vec::new(),
        };
        if style == SupportStyle::Grid {
            if s.angle != 0.0 {
                s.support = poly::rotate(support, -s.angle);
                s.trimming_rot = poly::rotate(trimming, -s.angle);
            }
            let grid_resolution = poly::scale_trunc(s.spacing);
            let (mut bmin, mut bmax) = match poly::bbox(&s.support) {
                Some((a, b)) => ([scaled(a[0]), scaled(a[1])], [scaled(b[0]), scaled(b[1])]),
                None => return s,
            };
            // bbox.offset(20); align_to_grid(grid_resolution) (min only)
            bmin = [bmin[0] - 20, bmin[1] - 20];
            bmax = [bmax[0] + 20, bmax[1] + 20];
            bmin = [align_to_grid(bmin[0], grid_resolution), align_to_grid(bmin[1], grid_resolution)];
            let extrusion_width_scaled = poly::scale_trunc(params.extrusion_width);
            // oversampling = clamp(int(scale_(spacing) / (extrusion_width_scaled + 100)), 1, 8) with double division
            let oversampling = (((s.spacing / 1e-6) / (extrusion_width_scaled + 100) as f64) as i64).clamp(1, 8);
            let pixel_size = ((extrusion_width_scaled + 21) as f64).max((s.spacing / oversampling as f64) / 1e-6);
            // m_bbox.offset(pixel_size)
            let ps = pixel_size as i64; // BoundingBox::offset(coordf_t) -> Point(coord_t) truncation
            let mb_min = [bmin[0] - ps, bmin[1] - ps];
            let mb_max = [bmax[0] + ps, bmax[1] + ps];
            let gw_raw = (((mb_max[0] - mb_min[0]) as f64) / pixel_size).ceil() as i64;
            let gh_raw = (((mb_max[1] - mb_min[1]) as f64) / pixel_size).ceil() as i64;
            let blocks_x = (gw_raw + oversampling - 1 - 2) / oversampling;
            let blocks_y = (gh_raw + oversampling - 1 - 2) / oversampling;
            let gw = (blocks_x * oversampling + 2) as usize;
            let gh = (blocks_y * oversampling + 2) as usize;
            s.bbox_min = mb_min;
            s.pixel = pixel_size;
            s.gw = gw;
            s.gh = gh;
            let mut grid = rasterize(gw, gh, pixel_size, mb_min, &s.support);
            let trim_src: &Polys = if s.angle != 0.0 { &s.trimming_rot } else { s.trimming };
            let trim = rasterize(gw, gh, pixel_size, mb_min, trim_src);
            let trim = dilate_trimming_region(&trim, gw, gh);
            seed_fill_block(&mut grid, gw, &trim, blocks_x as usize, blocks_y as usize, oversampling as usize);
            for v in grid.iter_mut() { *v = if *v != 0 { 255 } else { 0 }; }
            s.grid = grid;
        }
        s
    }

    /// Port of `SupportGridPattern::extract_support`. `offset_in_grid` in mm (may be negative).
    pub fn extract_support(&self, offset_in_grid: f64, fill_holes: bool) -> Polys {
        match self.style {
            SupportStyle::Grid => {
                if self.grid.is_empty() { return Vec::new(); }
                let simplified = contours_simplified(self.gw, self.gh, self.pixel, self.bbox_min, &self.grid, scaled(offset_in_grid), fill_holes);
                let trimming: &Polys = if self.angle != 0.0 { &self.trimming_rot } else { self.trimming };
                let islands = poly::diff(&simplified, trimming);
                // keep only islands holding a sample of the source polygons
                let src_union = poly::union(&self.support);
                let samples_src = if offset_in_grid > 0.0 { src_union } else { poly::intersect(&self.support, &islands) };
                let samples = island_samples(&samples_src);
                let mut out: Polys = Vec::new();
                for isl in islands {
                    let mut keep = false;
                    for s in &samples { if poly::point_in_poly(&isl, *s) { keep = true; break; } }
                    if keep { out.push(isl); }
                }
                if self.angle != 0.0 { poly::rotate(&out, self.angle) } else { out }
            }
            _ => {
                // smsSnug: closing + inward smoothing. smooth_outward is approximated by an opening/closing
                // with the smoothing distance (NOT a port: see supports/mod.rs "approximations").
                let closing = poly::closing(&self.support, self.closing_radius, self.closing_radius);
                let smoothing = self.extrusion_width;
                let _ = smoothing;
                closing
            }
        }
    }
}

/// Up to 4 interior sample points per expolygon (Orca samples a 20-unit shrunken contour).
fn island_samples(polys: &Polys) -> Vec<[f64; 2]> {
    let mut pts = Vec::new();
    for p in polys {
        if p.contour.len() < 3 { continue; }
        let sh = poly::offset(&vec![p.clone()], -unscaled(20));
        for q in &sh {
            let n = q.contour.len();
            if n == 0 { continue; }
            let ns = n.min(4);
            let stride = (n / ns).max(1);
            let mut i = 0;
            while i < n { pts.push(q.contour[i]); i += stride; }
            break;
        }
    }
    pts
}

fn dilate_trimming_region(t: &[u8], gw: usize, gh: usize) -> Vec<u8> {
    let mut d = vec![0u8; t.len()];
    for r in 1..gh.saturating_sub(1) {
        for c in 1..gw.saturating_sub(1) {
            let mut b = true;
            'o: for dr in 0..3usize {
                for dc in 0..3usize {
                    if t[(r + dr - 1) * gw + (c + dc - 1)] == 0 { b = false; break 'o; }
                }
            }
            d[r * gw + c] = b as u8;
        }
    }
    d
}

fn seed_fill_block(grid: &mut [u8], gw: usize, mask: &[u8], blocks_x: usize, blocks_y: usize, size: usize) {
    let stride = gw as isize;
    for br in 0..blocks_y {
        for bc in 0..blocks_x {
            let base = (bc * size + 1 + (br * size + 1) * gw) as isize;
            let step = |grid: &mut [u8], r: usize, c: usize, off: isize| {
                let addr = base + (r as isize) * stride + c as isize;
                let addr2 = addr + off;
                if grid[addr2 as usize] != 0 && mask[addr as usize] == 0 && mask[addr2 as usize] == 0 {
                    grid[addr as usize] = 1;
                }
            };
            for r in 0..size {
                if r > 0 { for c in 0..size { step(grid, r, c, -stride); } }
                for c in 1..size { step(grid, r, c, -1); }
                for c in (0..=size.saturating_sub(2)).rev() { if size >= 2 { step(grid, r, c, 1); } }
            }
            if size >= 2 {
                for r in (0..=size - 2).rev() {
                    for c in 0..size { step(grid, r, c, stride); }
                    for c in 1..size { step(grid, r, c, -1); }
                    for c in (0..=size - 2).rev() { step(grid, r, c, 1); }
                }
            }
        }
    }
}

/// Trace the boundaries of the set pixels. Returns polygons (world mm), each corner shifted by `offset`.
fn contours_simplified(gw: usize, gh: usize, pixel: f64, lb: [i64; 2], grid: &[u8], offset: i64, fill_holes: bool) -> Polys {
    let mut inside_data;
    let cell: &[u8] = if fill_holes {
        inside_data = grid.to_vec();
        for r in 1..gh.saturating_sub(1) {
            for c in 1..gw.saturating_sub(1) {
                let a = r * gw + c;
                if (grid[a - 1] != 0 && grid[a + 1] != 0) || (grid[a - gw] != 0 && grid[a + gw] != 0) { inside_data[a] = 1; }
            }
        }
        &inside_data
    } else { grid };
    type P = (i64, i64);
    let mut lines: Vec<(P, P)> = Vec::new();
    for r in 1..gh {
        for c in 1..gw {
            let a = r * gw + c;
            let left = cell[a - 1] != 0;
            let top = cell[a - gw] != 0;
            let cur = cell[a] != 0;
            let (c, r) = (c as i64, r as i64);
            if left != cur {
                lines.push(if left { ((c, r + 1), (c, r)) } else { ((c, r), (c, r + 1)) });
            }
            if top != cur {
                lines.push(if top { ((c, r), (c + 1, r)) } else { ((c + 1, r), (c, r)) });
            }
        }
    }
    // index by start point
    let mut by_start: Vec<(P, usize)> = lines.iter().enumerate().map(|(i, l)| (l.0, i)).collect();
    by_start.sort();
    let mut processed = vec![false; lines.len()];
    let mut out_pts: Vec<Vec<P>> = Vec::new();
    for cand in 0..lines.len() {
        if processed[cand] { continue; }
        processed[cand] = true;
        let mut poly_pts: Vec<P> = vec![lines[cand].1];
        let mut cur = cand;
        loop {
            let b = lines[cur].1;
            let lo = by_start.partition_point(|e| e.0 < b);
            let hi = by_start.partition_point(|e| e.0 <= b);
            if lo == hi { break; } // should not happen
            let mut next: Option<usize> = None;
            let mut closed = false;
            for e in &by_start[lo..hi] {
                let idx = e.1;
                if idx == cand { closed = true; break; }
                if processed[idx] { continue; }
                match next {
                    None => next = Some(idx),
                    Some(_) => {
                        let lc = lines[cur]; let ln = lines[idx];
                        let v1 = (lc.1 .0 - lc.0 .0, lc.1 .1 - lc.0 .1);
                        let v2 = (ln.1 .0 - ln.0 .0, ln.1 .1 - ln.0 .1);
                        let cross = v1.0 * v2.1 - v2.0 * v1.1;
                        if cross > 0 { next = Some(idx); break; }
                    }
                }
            }
            if closed { break; }
            let Some(nx) = next else { break };
            processed[nx] = true;
            cur = nx;
            poly_pts.push(lines[cur].1);
        }
        out_pts.push(poly_pts);
    }
    // world coordinates + corner filtering/shift
    let mut rings: Vec<Ring> = Vec::new();
    for pts in out_pts {
        let n = pts.len();
        if n < 3 { continue; }
        let mut ring: Ring = Vec::new();
        // world integer coordinates
        let wp: Vec<(i64, i64)> = pts.iter().map(|p| (((p.0 as f64) * pixel) as i64 + lb[0], ((p.1 as f64) * pixel) as i64 + lb[1])).collect();
        // NOTE Orca scales the pixel indices first (p *= pixel_size) with truncation to coord_t, then adds left_bottom
        for j in 0..n {
            let j0 = if j == 0 { n - 1 } else { j - 1 };
            let j2 = if j + 1 == n { 0 } else { j + 1 };
            let v = (wp[j2].0 - wp[j0].0, wp[j2].1 - wp[j0].1);
            if v.0 != 0 && v.1 != 0 {
                let mut p = wp[j];
                p.1 += if v.0 < 0 { -offset } else { offset };
                p.0 += if v.1 > 0 { -offset } else { offset };
                ring.push([unscaled(p.0), unscaled(p.1)]);
            }
        }
        if ring.len() >= 3 { rings.push(ring); }
    }
    // The trace keeps the filled region on its right (y up), so filled outer loops come out CW and
    // holes CCW. Flip to the CCW-outer convention and let NonZero winding build outers and holes.
    let mut flipped: Vec<Ring> = Vec::new();
    for mut r in rings { r.reverse(); flipped.push(r); }
    poly::union_rings(&flipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn gp() -> GridParams { GridParams::new(SupportStyle::Grid, 2.5, 0.0, 0.377) }
    #[test]
    fn grid_stretches_island_to_cells_and_respects_trim() {
        let sup = vec![poly::rect(10.3, 20.2, 21.0, 26.0)];
        let trim: Polys = Vec::new();
        let g = SupportGridPattern::new(&sup, &trim, &gp());
        let a = g.extract_support(gp().expansion_to_slice, true);
        let ar = poly::area(&a);
        let src = poly::area(&sup);
        assert!(!a.is_empty());
        assert!(ar >= src - 1e-6, "grid result must cover the source: {ar} vs {src}");
        assert!(ar < src * 2.2, "grid result implausibly big: {ar} vs {src}");
        // result is rectilinear
        let bb = poly::bbox(&a).unwrap();
        println!("grid bbox {:?} area {} src {}", bb, ar, src);
        // trimming region removes its area
        let trim = vec![poly::rect(14.0, 15.0, 18.0, 40.0)];
        let g2 = SupportGridPattern::new(&sup, &trim, &gp());
        let b = g2.extract_support(gp().expansion_to_slice, true);
        assert!(poly::area(&poly::intersect(&b, &trim)) < 1e-6);
        assert!(poly::area(&b) > 10.0);
    }
    #[test]
    fn rasterizer_counts_area() {
        let r = vec![poly::rect(1.0, 1.0, 4.0, 3.0)];
        let g = rasterize(8, 6, 1e6, [0, 0], &r);
        let n = g.iter().filter(|v| **v != 0).count();
        assert_eq!(n, 6);
    }
}
