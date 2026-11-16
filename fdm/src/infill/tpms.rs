//! `FillTpmsD` (analytic Schwarz-D waves) and `FillTpmsFK` (Fischer-Koch S via marching squares).
use super::connect::connect_infill;
use super::gx::{self, P};
use super::marching::{contour_polylines, simplify, Field};
use super::rect::clipper_order;
use super::{chain_polylines, Ctx};
use crate::types::Poly;
use std::f64::consts::PI;

const NM: f64 = 1e6;
const EPSILON: f64 = 1e-4;
const CORRECTION_ANGLE_DEG: f64 = -45.0;

fn rot0(p: P, a: f64) -> P { let (s, c) = (a.sin(), a.cos()); [p[0] * c - p[1] * s, p[0] * s + p[1] * c] }

fn rotated_expoly(poly: &Poly, cx: &Ctx, angle: f64) -> Poly {
    let o = cx.origin;
    let t = |p: P| { let p = [p[0] - o[0], p[1] - o[1]]; if angle.abs() >= EPSILON { rot0(p, -angle) } else { p } };
    Poly { contour: poly.contour.iter().map(|&p| t(p)).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|&p| t(p)).collect()).collect() }
}
fn back(pl: Vec<Vec<P>>, cx: &Ctx, angle: f64) -> Vec<Vec<P>> {
    let o = cx.origin;
    pl.into_iter().map(|l| l.into_iter().map(|p| { let p = if angle.abs() >= EPSILON { rot0(p, angle) } else { p }; [p[0] + o[0], p[1] + o[1]] }).collect()).collect()
}

// ---------------------------------------------------------------- TPMS-D
fn make_waves(grid_z: f64, density_adj: f64, spacing: f64, width: f64, height: f64) -> Vec<Vec<P>> {
    const PATTERN_TOLERANCE: f64 = 0.1;
    let scale = spacing / density_adj; // mm per wave unit
    let tolerance = (spacing / 2.0).min(PATTERN_TOLERANCE) / scale;
    let z = grid_z / scale;
    let mut a = z.sin() - z.cos();
    let mut b = z.sin() + z.cos();
    let (mut min_u, mut max_u) = (0.0 - height, width - 0.0);
    let (mut min_v, mut max_v) = (0.0, width + height);
    let swap_uv = a.abs() > b.abs();
    if swap_uv {
        std::mem::swap(&mut a, &mut b);
        std::mem::swap(&mut min_u, &mut min_v);
        std::mem::swap(&mut max_u, &mut max_v);
    }
    let v_of = |u: f64| (a / b * u.cos()).acos();
    let mut wave: Vec<(f64, f64)> = Vec::new();
    let init = 16;
    for c in 0..=init { let u = min_u + 2.0 * PI * c as f64 / init as f64; wave.push((u, v_of(u))); }
    let mut cur = 0usize;
    while cur + 1 < wave.len() {
        let (u1, u2) = (wave[cur].0, wave[cur + 1].0);
        let mid_u = (u1 + u2) / 2.0;
        let (v1, v2) = (wave[cur].1, wave[cur + 1].1);
        let mid_v = v_of((u1 + u2) / 2.0);
        if (mid_v - (v1 + v2) / 2.0).abs() > tolerance { wave.insert(cur + 1, (mid_u, mid_v)); } else { cur += 1; }
    }
    let mut c = 1usize;
    while c < wave.len() && wave.last().unwrap().0 < max_u {
        let (u, v) = wave[c];
        wave.push((u + 2.0 * PI, v));
        c += 1;
    }
    let mut result = Vec::new();
    let mut v_shift = (min_v / (2.0 * PI)).floor() * (2.0 * PI);
    while v_shift < max_v + 2.0 * PI {
        for forward in [false, true] {
            let mut pl = Vec::new();
            for &(u, v0) in &wave {
                let v = (if forward { v0 } else { -v0 }) + v_shift;
                let x = (u + v) / 2.0;
                let y = (v - u) / 2.0 * if swap_uv { -1.0 } else { 1.0 };
                pl.push([x * scale, y * scale]);
            }
            result.push(pl);
        }
        v_shift += 2.0 * PI;
    }
    result
}

pub fn fill_tpms_d(poly: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    const DENSITY_ADJUST: f64 = 2.1;
    let angle = cx.c.angle_deg.to_radians() + CORRECTION_ANGLE_DEG.to_radians();
    let ex = rotated_expoly(poly, cx, angle);
    let (lo, hi) = gx::bbox_pts(ex.contour.iter()).unwrap();
    let spacing = cx.spacing;
    let density_adj = (cx.density * DENSITY_ADJUST / cx.multiline as f64).max(0.0);
    if density_adj <= 0.0 { return Vec::new(); }
    let distance_nm = (spacing * NM / density_adj).trunc();
    let period_nm = (2.0 * PI * distance_nm).trunc();
    let (lo_nm, hi_nm) = ([(lo[0] * NM).round(), (lo[1] * NM).round()], [(hi[0] * NM).round(), (hi[1] * NM).round()]);
    let al = [(lo_nm[0] / period_nm).floor() * period_nm, (lo_nm[1] / period_nm).floor() * period_nm];
    let bmin = [lo_nm[0].min(al[0]), lo_nm[1].min(al[1])];
    let width = ((hi_nm[0] - bmin[0]) / distance_nm).ceil() + 1.0;
    let height = ((hi_nm[1] - bmin[1]) / distance_nm).ceil() + 1.0;
    let waves = make_waves(cx.z, density_adj, spacing, width, height);
    let org = [bmin[0] / NM, bmin[1] / NM];
    let pls: Vec<Vec<P>> = waves.into_iter().map(|w| w.into_iter().map(|p| [p[0] + org[0], p[1] + org[1]]).collect()).collect();
    let pls = if cx.multiline > 1 { super::rect::multiline_offsets_pub(pls, cx.multiline, spacing) } else { pls };
    let region = vec![ex.clone()];
    let mut pl = gx::clip_lines(&pls, &region);
    let m = 0.8 * spacing;
    pl.retain(|p| gx::polyline_len(p) >= m);
    if pl.is_empty() { return pl; }
    clipper_order(&mut pl);
    let conn = if cx.anchor_max < 0.05 { chain_polylines(pl, None) } else { connect_infill(pl, &gx::rings(&region), spacing, cx.anchor, cx.anchor_max, cx.multiline) };
    back(conn, cx, angle)
}

// ---------------------------------------------------------------- TPMS-FK
pub fn fill_tpms_fk(poly: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    let angle = cx.c.angle_deg.to_radians() + CORRECTION_ANGLE_DEG.to_radians();
    let ex = rotated_expoly(poly, cx, angle);
    let spacing = cx.spacing as f32;
    let density_factor = 0.9f32.min(cx.density as f32);
    let vari_t = 4.18f32 * spacing * cx.multiline as f32 / density_factor;
    let (lo, hi) = gx::bbox_pts(ex.contour.iter()).unwrap();
    let off = ((cx.multiline as f64 + 1.0) * cx.spacing * NM).trunc();
    let lo_nm = [(lo[0] * NM).round() - off, (lo[1] * NM).round() - off];
    let hi_nm = [(hi[0] * NM).round() + off, (hi[1] * NM).round() + off];
    let freq = (2.0 * std::f32::consts::PI) / vari_t;
    let z = cx.z;
    let f = move |x: f64, y: f64| -> f32 {
        let fx = freq * x as f32;
        let fy = freq * y as f32;
        let fz = freq * z as f32;
        (2.0 * fx).cos() * fy.sin() * fz.cos() + (2.0 * fy).cos() * fz.sin() * fx.cos() + (2.0 * fz).cos() * fx.sin() * fy.cos()
    };
    let fld = Field { offs_nm: [lo_nm[0] as i64, lo_nm[1] as i64], size_nm: [(hi_nm[0] - lo_nm[0]) as i64, (hi_nm[1] - lo_nm[1]) as i64], f: &f };
    let rings = contour_polylines(&fld, 0.0);
    let pls: Vec<Vec<P>> = rings.into_iter().map(|r| simplify(&r, 0.04)).collect();
    let pls = if cx.multiline > 1 { super::rect::multiline_offsets_pub(pls, cx.multiline, cx.spacing) } else { pls };
    let region = vec![ex.clone()];
    let mut pl = gx::clip_lines(&pls, &region);
    let m = 0.8 * cx.spacing;
    pl.retain(|p| gx::polyline_len(p) >= m);
    if pl.is_empty() { return pl; }
    clipper_order(&mut pl);
    // FillTpmsFK always connects (chain_infill is unsuited to its internal islands).
    let conn = connect_infill(pl, &gx::rings(&region), cx.spacing, cx.anchor, cx.anchor_max, cx.multiline);
    back(conn, cx, angle)
}
