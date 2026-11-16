//! `FillGyroid` (libslic3r/Fill/FillGyroid.cpp): parametric gyroid waves, z dependent.
use super::connect::connect_infill;
use super::gx::{self, P};
use super::rect::clipper_order;
use super::{chain_polylines, Ctx};
use crate::types::{FdmError, Poly};
use std::f64::consts::{FRAC_PI_2, PI};

const EPSILON: f64 = 1e-4;
const CORRECTION_ANGLE_DEG: f64 = -45.0;
const DENSITY_ADJUST: f64 = 2.44;
const PATTERN_TOLERANCE: f64 = 0.2;

fn f(x: f64, z_sin: f64, z_cos: f64, vertical: bool, flip: bool) -> f64 {
    if vertical {
        let phase_offset = (if z_cos < 0.0 { PI } else { 0.0 }) + PI;
        let a = (x + phase_offset).sin();
        let b = -z_cos;
        let res = z_sin * (x + phase_offset + if flip { PI } else { 0.0 }).cos();
        let r = (a * a + b * b).sqrt();
        (a / r).asin() + (res / r).asin() + PI
    } else {
        let phase_offset = if z_sin < 0.0 { PI } else { 0.0 };
        let a = (x + phase_offset).cos();
        let b = -z_sin;
        let res = z_cos * (x + phase_offset + if flip { 0.0 } else { PI }).sin();
        let r = (a * a + b * b).sqrt();
        (a / r).asin() + (res / r).asin() + 0.5 * PI
    }
}

fn make_one_period(width: f64, z_cos: f64, z_sin: f64, vertical: bool, flip: bool, tolerance: f64) -> Vec<P> {
    let mut points: Vec<P> = Vec::new();
    let dx = FRAC_PI_2;
    let limit = (2.0 * PI).min(width);
    let mut x = 0.0;
    while x < limit - EPSILON {
        points.push([x, f(x, z_sin, z_cos, vertical, flip)]);
        x += dx;
    }
    points.push([limit, f(limit, z_sin, z_cos, vertical, flip)]);
    loop {
        let size = points.len();
        for i in 1..size {
            let lp = points[i - 1];
            let rp = points[i];
            let x = lp[0] + (rp[0] - lp[0]) / 2.0;
            let y = f(x, z_sin, z_cos, vertical, flip);
            let ip = [x, y];
            let cross = (ip[0] - lp[0]) * (ip[1] - rp[1]) - (ip[1] - lp[1]) * (ip[0] - rp[0]);
            if cross.abs() > tolerance * tolerance { points.push(ip); }
        }
        if size == points.len() { break; }
        points.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap());
    }
    points
}

#[allow(clippy::too_many_arguments)]
fn make_wave(one_period: &[P], width: f64, height: f64, offset: f64, scale: f64, z_cos: f64, z_sin: f64, vertical: bool, flip: bool) -> Vec<P> {
    let mut points: Vec<P> = one_period.to_vec();
    let period = points.last().unwrap()[0];
    if width != period {
        points.pop();
        let n = points.len();
        loop {
            let s = points.len() - n;
            let np = [points[s][0] + period, points[s][1]];
            points.push(np);
            if points.last().unwrap()[0] >= width - EPSILON { break; }
        }
        points.push([width, f(width, z_sin, z_cos, vertical, flip)]);
    }
    points.into_iter().map(|mut p| {
        p[1] += offset;
        p[1] = p[1].clamp(0.0, height);
        if vertical { p.swap(0, 1); }
        [p[0] * scale, p[1] * scale]
    }).collect()
}

fn make_gyroid_waves(grid_z: f64, density_adj: f64, spacing: f64, mut width: f64, mut height: f64) -> Vec<Vec<P>> {
    let scale = spacing / density_adj; // mm per wave unit (scaleFactor)
    let tolerance = (spacing / 2.0).min(PATTERN_TOLERANCE) / scale;
    let z = grid_z * density_adj / spacing; // grid_z [mm] / scale
    let (z_sin, z_cos) = (z.sin(), z.cos());
    let vertical = z_sin.abs() <= z_cos.abs();
    let mut lower = 0.0;
    let mut upper = height;
    let mut flip = true;
    if vertical {
        flip = false;
        lower = -PI;
        upper = width - FRAC_PI_2;
        std::mem::swap(&mut width, &mut height);
    }
    let odd = make_one_period(width, z_cos, z_sin, vertical, flip, tolerance);
    flip = !flip;
    let even = make_one_period(width, z_cos, z_sin, vertical, flip, tolerance);
    let mut result = Vec::new();
    let mut y0 = lower;
    while y0 < upper + EPSILON {
        result.push(make_wave(&odd, width, height, y0, scale, z_cos, z_sin, vertical, flip));
        y0 += PI;
        if y0 < upper + EPSILON {
            result.push(make_wave(&even, width, height, y0, scale, z_cos, z_sin, vertical, flip));
        }
        y0 += PI;
    }
    result
}

fn rot(p: P, a: f64) -> P { let (c, s) = (a.cos(), a.sin()); [p[0] * c - p[1] * s, p[0] * s + p[1] * c] }

pub fn fill_gyroid(poly: &Poly, cx: &Ctx) -> Result<Vec<Vec<P>>, FdmError> {
    let spacing = cx.spacing;
    let expp = gx::offset(&vec![poly.clone()], -0.5 * spacing);
    let mut out = Vec::new();
    for ex in expp {
        let infill_angle = cx.c.angle_deg.to_radians() + CORRECTION_ANGLE_DEG.to_radians();
        let o = cx.origin;
        let rotp = |p: P| { let p = [p[0] - o[0], p[1] - o[1]]; if infill_angle.abs() >= EPSILON { rot(p, -infill_angle) } else { p } };
        let exr = Poly { contour: ex.contour.iter().map(|&p| rotp(p)).collect(), holes: ex.holes.iter().map(|h| h.iter().map(|&p| rotp(p)).collect()).collect() };
        let (lo, hi) = gx::bbox_pts(exr.contour.iter()).unwrap();
        let density_adj = (cx.density * DENSITY_ADJUST / cx.multiline as f64).max(0.0);
        if density_adj <= 0.0 { continue; }
        // distance in nm as libslic3r truncates it to coord_t
        let distance_nm = (spacing * 1e6 / density_adj).trunc();
        let period_nm = (2.0 * PI * distance_nm).trunc();
        let to_nm = |v: f64| (v * 1e6).round();
        let aligned = [(to_nm(lo[0]) / period_nm).floor() * period_nm, (to_nm(lo[1]) / period_nm).floor() * period_nm];
        let bb_min = [to_nm(lo[0]).min(aligned[0]), to_nm(lo[1]).min(aligned[1])];
        let bb_max = [to_nm(hi[0]), to_nm(hi[1])];
        let expand = (10.0 * spacing * 1e6).trunc();
        let (bmin, bmax) = ([bb_min[0] - expand, bb_min[1] - expand], [bb_max[0] + expand, bb_max[1] + expand]);
        let width = ((bmax[0] - bmin[0]) / distance_nm).ceil() + 1.0;
        let height = ((bmax[1] - bmin[1]) / distance_nm).ceil() + 1.0;
        let polylines: Vec<Vec<P>> = if cx.c.gyroid_optimized {
            // marching-squares gyroid (params.gyroid_optimized)
            let lh = if cx.c.layer_h > 0.0 { cx.c.layer_h } else { spacing };
            let lh_ratio = if spacing * cx.multiline as f64 > 0.0 { lh / (spacing * cx.multiline as f64) } else { 0.5 };
            let correction = 1.0 / (1.0 + lh_ratio).sqrt();
            let omega = ((1.0 / density_adj.max(0.1)).sqrt() * correction).clamp(1.0, 2.0) as f32;
            let density_factor = ((cx.density * DENSITY_ADJUST / cx.multiline as f64) as f32).max(0.001);
            let period = (2.0 * std::f32::consts::PI) * spacing as f32 / density_factor;
            let baseline = (2.0 * std::f32::consts::PI) / period.max(1e-3);
            let (fx, fy, fz) = (baseline, baseline, omega * baseline);
            let z = cx.z;
            let f = move |x: f64, y: f64| -> f32 {
                let (a, b, c) = (fx * x as f32, fy * y as f32, fz * z as f32);
                a.sin() * b.cos() + b.sin() * c.cos() + c.sin() * a.cos()
            };
            let fld = super::marching::Field { offs_nm: [bmin[0] as i64, bmin[1] as i64], size_nm: [(bmax[0] - bmin[0]) as i64, (bmax[1] - bmin[1]) as i64], f: &f };
            super::marching::contour_polylines(&fld, 0.0).into_iter().map(|r| super::marching::simplify(&r, 0.04)).collect()
        } else {
            let waves = make_gyroid_waves(cx.z, density_adj, spacing, width, height);
            let org = [bmin[0] * 1e-6, bmin[1] * 1e-6];
            waves.into_iter().map(|w| w.into_iter().map(|p| [p[0] + org[0], p[1] + org[1]]).collect()).collect()
        };
        let mut polylines = if cx.multiline > 1 { super::rect::multiline_offsets_pub(polylines, cx.multiline, spacing) } else { polylines };
        polylines = gx::clip_lines(&polylines, &vec![exr.clone()]);
        let minlength = 0.8 * spacing;
        polylines.retain(|pl| gx::polyline_len(pl) >= minlength);
        if polylines.is_empty() { continue; }
        clipper_order(&mut polylines);
        let connected = if cx.anchor_max < 0.05 {
            chain_polylines(polylines, None)
        } else {
            connect_infill(polylines, &gx::rings(&vec![exr.clone()]), spacing, cx.anchor, cx.anchor_max, cx.multiline)
        };
        for pl in connected { out.push(pl.into_iter().map(|p| { let p = if infill_angle.abs() >= EPSILON { rot(p, infill_angle) } else { p }; [p[0] + o[0], p[1] + o[1]] }).collect()); }
    }
    Ok(out)
}
