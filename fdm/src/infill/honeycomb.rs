//! `FillHoneycomb` (2D hexagons, rotating 60 deg per layer) and `Fill3DHoneycomb` (truncated octahedron slices).
use super::connect::connect_infill;
use super::gx::{self, P};
use super::rect::clipper_order;
use super::{chain_polylines, Ctx};
use crate::types::Poly;

const NM: f64 = 1e6;

fn rot_about(p: P, a: f64, c: P) -> P {
    let (s, co) = (a.sin(), a.cos());
    let (x, y) = (p[0] - c[0], p[1] - c[1]);
    [c[0] + x * co - y * s, c[1] + x * s + y * co]
}
fn rot0(p: P, a: f64) -> P { rot_about(p, a, [0.0, 0.0]) }

fn finish(polylines: Vec<Vec<P>>, ex: &Poly, cx: &Ctx, minlen: bool) -> Vec<Vec<P>> {
    let region = vec![ex.clone()];
    let mut pl = gx::clip_lines(&polylines, &region);
    if minlen { let m = 0.8 * cx.spacing; pl.retain(|p| gx::polyline_len(p) >= m); }
    if pl.is_empty() { return pl; }
    clipper_order(&mut pl);
    if cx.anchor_max < 0.05 { chain_polylines(pl, None) } else { connect_infill(pl, &gx::rings(&region), cx.spacing, cx.anchor, cx.anchor_max, cx.multiline) }
}

/// `FillHoneycomb::_fill_surface_single` for one (already contracted) ExPolygon, in the region's frame.
pub fn fill_honeycomb(poly: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    let o = cx.origin;
    let ex = Poly { contour: poly.contour.iter().map(|p| [p[0] - o[0], p[1] - o[1]]).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|p| [p[0] - o[0], p[1] - o[1]]).collect()).collect() };
    // cached hexagon maths, in integer nm exactly as libslic3r truncates it
    let min_spacing = (cx.spacing * NM).trunc() * cx.multiline as f64;
    let distance = (min_spacing / cx.density).trunc();
    let hex_side = (distance / (3f64.sqrt() / 2.0)).trunc();
    let hex_width = distance * 2.0;
    let hex_height = hex_side * 2.0;
    let pattern_height = hex_height + hex_side;
    let y_short = (distance * 3f64.sqrt() / 3.0).trunc();
    let x_offset = (min_spacing / 2.0).trunc();
    let y_offset = (x_offset * 3f64.sqrt() / 3.0).trunc();
    let hex_center = [(hex_width / 2.0).trunc(), hex_side];
    // direction = angle + _layer_angle(idx) + 90deg ; _layer_angle = pi/3 * (idx % 3)
    let idx = cx.layer_id / cx.c.thickness_layers.max(1);
    let dir = cx.c.angle_deg.to_radians() + std::f64::consts::FRAC_PI_3 * (idx % 3) as f64 + std::f64::consts::FRAC_PI_2;

    let (lo, hi) = gx::bbox_pts(ex.contour.iter()).unwrap();
    let (lo, hi) = ([lo[0] * NM, lo[1] * NM], [hi[0] * NM, hi[1] * NM]);
    let corners = [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]];
    let rc: Vec<P> = corners.iter().map(|&c| rot_about(c, dir, hex_center)).collect();
    let (mut bmin, bmax) = gx::bbox_pts(rc.iter()).unwrap();
    let bmax = bmax;
    // merge(align_to_grid(bb.min, (hex_width, pattern_height)))
    let al = [(bmin[0] / hex_width).floor() * hex_width, (bmin[1] / pattern_height).floor() * pattern_height];
    bmin = [bmin[0].min(al[0]), bmin[1].min(al[1])];

    let mut all: Vec<Vec<P>> = Vec::new();
    let mut x = bmin[0].trunc();
    let ymin = bmin[1].trunc();
    while x <= bmax[0] {
        let mut p: Vec<P> = Vec::new();
        let mut ax = [x + x_offset, x + distance - x_offset];
        for _ in 0..2 {
            p.reverse();
            let mut y = ymin;
            while y <= bmax[1] {
                p.push([ax[1], y + y_offset]);
                p.push([ax[0], y + y_short - y_offset]);
                p.push([ax[0], y + y_short + hex_side + y_offset]);
                p.push([ax[1], y + y_short + hex_side + y_short - y_offset]);
                p.push([ax[1], y + y_short + hex_side + y_short + hex_side + y_offset]);
                y += y_short + hex_side + y_short + hex_side;
            }
            ax[0] += distance;
            ax[1] += distance;
            ax.swap(0, 1);
            x += distance;
        }
        let q: Vec<P> = p.into_iter().map(|pt| { let r = rot_about(pt, -dir, hex_center); [r[0] / NM, r[1] / NM] }).collect();
        all.push(q);
    }
    let all = if cx.multiline > 1 { super::rect::multiline_offsets_pub(all, cx.multiline, cx.spacing) } else { all };
    finish(all, &ex, cx, false).into_iter().map(|pl| pl.into_iter().map(|p| [p[0] + o[0], p[1] + o[1]]).collect()).collect()
}

// ---------------------------------------------------------------- 3D honeycomb (Fill3DHoneycomb.cpp)
fn sgn(v: f64) -> f64 { if v > 0.0 { 1.0 } else if v < 0.0 { -1.0 } else { 0.0 } }
fn tri_wave(pos: f64, grid: f64) -> f64 {
    let mut t = (pos / (grid * 2.0) + 0.25) as f32; // float arithmetic, like the C++
    t -= (t as i32) as f32;
    (1.0 - (t as f64 * 8.0 - 4.0).abs()) * (grid / 4.0) + (grid / 4.0)
}
fn troct_wave(pos: f64, grid: f64, zpos: f64) -> f64 {
    let zcycle = tri_wave(zpos, grid);
    let perp = zcycle / 2.0;
    let y = tri_wave(pos, grid);
    if y.abs() > perp.abs() { sgn(y) * perp } else { y * sgn(perp) }
}
fn critical_points(zpos: f64, grid: f64) -> Vec<f64> {
    let mut res = vec![0.0];
    let perp = (tri_wave(zpos, grid) / 2.0).abs();
    let n = perp / grid;
    if n > 0.0 {
        res.push(grid * n);
        res.push(grid * (1.0 - n));
        res.push(grid * (1.0 + n));
        res.push(grid * (2.0 - n));
    }
    res
}
fn colinear_points(grid: f64, crit: &[f64], base: f64, len: f64) -> Vec<f64> {
    let mut pts = vec![base];
    let mut c = base;
    while c < len {
        for &cp in crit { pts.push(base + c + cp); }
        c += grid * 2.0;
    }
    pts.push(len);
    pts
}
fn perpend_points(zpos: f64, grid: f64, crit: &[f64], base: f64, len: f64, offset_base: f64, dir: f64) -> Vec<f64> {
    let mut pts = vec![offset_base];
    let mut c = base;
    while c < len {
        for &cp in crit { pts.push(offset_base + troct_wave(cp, grid, zpos) * dir); }
        c += grid * 2.0;
    }
    pts.push(offset_base);
    pts
}
fn make_actual_grid(zpos: f64, grid: f64, bx: f64, by: f64) -> Vec<Vec<P>> {
    let crit = critical_points(zpos, grid);
    let zcycle = ((zpos + grid / 2.0) % (grid * 2.0)) / (grid * 2.0);
    let print_vert = zcycle < 0.5;
    let mut out = Vec::new();
    let zip = |a: Vec<f64>, b: Vec<f64>| -> Vec<P> { a.into_iter().zip(b).map(|(x, y)| [x, y]).collect() };
    if print_vert {
        let mut perp = -1.0;
        let mut x = 0.0;
        while x <= bx {
            let mut np = zip(perpend_points(zpos, grid, &crit, 0.0, by, x, perp), colinear_points(grid, &crit, 0.0, by));
            if perp == 1.0 { np.reverse(); }
            out.push(np);
            x += grid;
            perp *= -1.0;
        }
    } else {
        let mut perp = 1.0;
        let mut y = grid;
        while y <= by {
            let mut np = zip(colinear_points(grid, &crit, 0.0, bx), perpend_points(zpos, grid, &crit, 0.0, bx, y, perp));
            if perp == -1.0 { np.reverse(); }
            out.push(np);
            y += grid;
            perp *= -1.0;
        }
    }
    out
}

pub fn fill_3d_honeycomb(poly: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    let o = cx.origin;
    let infill_angle = cx.c.angle_deg.to_radians();
    let tr = |p: P| { let p = [p[0] - o[0], p[1] - o[1]]; if infill_angle.abs() >= 1e-4 { rot0(p, -infill_angle) } else { p } };
    let ex = Poly { contour: poly.contour.iter().map(|&p| tr(p)).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|&p| tr(p)).collect()).collect() };
    let (lo, hi) = gx::bbox_pts(ex.contour.iter()).unwrap();
    let expand = (5.0 * cx.spacing * NM).trunc();
    let (mut bmin, mut bmax) = ([lo[0] * NM - expand, lo[1] * NM - expand], [hi[0] * NM + expand, hi[1] * NM + expand]);
    let spacing_nm = cx.spacing * NM;
    let mult = cx.multiline as f64;
    let mut z_scale = 2f64.sqrt();
    let mut grid = spacing_nm * ((z_scale + 1.0) / 2.0) * mult / cx.density;
    let layer_height = NM; // Orca: fixed layer height
    let mut layers_per_module = ((grid * 2.0) / (z_scale * layer_height) + 0.05).floor();
    if cx.density > 0.42 {
        layers_per_module = 2.0;
        grid = spacing_nm * 1.1 * mult / cx.density;
        z_scale = (grid * 2.0) / (layers_per_module * layer_height);
    } else {
        if layers_per_module < 2.0 { layers_per_module = 2.0; }
        z_scale = (grid * 2.0) / (layers_per_module * layer_height);
        grid = spacing_nm * ((z_scale + 1.0) / 2.0) * mult / cx.density;
        layers_per_module = ((grid * 2.0) / (z_scale * layer_height) + 0.05).floor();
        if layers_per_module < 2.0 { layers_per_module = 2.0; }
        z_scale = (grid * 2.0) / (layers_per_module * layer_height);
    }
    let g4 = (grid * 4.0).trunc();
    let al = [(bmin[0] / g4).floor() * g4, (bmin[1] / g4).floor() * g4];
    bmin = [bmin[0].min(al[0]), bmin[1].min(al[1])];
    let _ = &mut bmax;
    let (w, h) = ((bmax[0] - bmin[0]).trunc(), (bmax[1] - bmin[1]).trunc());
    let pls = make_actual_grid(cx.z * NM * z_scale, grid, w, h);
    let pls: Vec<Vec<P>> = pls.into_iter().map(|pl| pl.into_iter().map(|p| [(p[0].trunc() + bmin[0]) / NM, (p[1].trunc() + bmin[1]) / NM]).collect()).collect();
    let pls = if cx.multiline > 1 { super::rect::multiline_offsets_pub(pls, cx.multiline, cx.spacing) } else { pls };
    finish(pls, &ex, cx, true).into_iter().map(|pl| pl.into_iter().map(|p| { let p = if infill_angle.abs() >= 1e-4 { rot0(p, infill_angle) } else { p }; [p[0] + o[0], p[1] + o[1]] }).collect()).collect()
}
