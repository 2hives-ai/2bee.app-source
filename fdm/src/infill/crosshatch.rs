//! `FillCrossHatch` (Bambu cross hatch): alternating line directions with transform layers.
use super::connect::connect_infill;
use super::gx::{self, P};
use super::rect::clipper_order;
use super::{chain_polylines, Ctx};
use crate::types::Poly;

const NM: f64 = 1e6;
type NP = [f64; 2]; // nm, integer valued (truncated like libslic3r Point)

fn tr(v: f64) -> f64 { v.trunc() }

fn generate_one_cycle(progress: f64, period: f64) -> Vec<NP> {
    let offset = progress * 1.0 / 8.0 * period;
    vec![[tr(0.25 * period - offset), tr(offset)], [tr(0.25 * period + offset), tr(offset)], [tr(0.75 * period - offset), tr(-offset)], [tr(0.75 * period + offset), tr(-offset)]]
}

fn transform_pattern(progress: f64, direction: i32, in_grid: f64, in_w: f64, in_h: f64) -> Vec<Vec<NP>> {
    let (mut width, mut height) = (in_w, in_h);
    let grid = in_grid * 2.0;
    let one = generate_one_cycle(progress, grid);
    if direction < 0 { width = in_h; height = in_w; }
    let num_of_cycle = (width / grid + 2.0) as usize;
    let mut odd_poly: Vec<NP> = Vec::new();
    for i in 0..num_of_cycle {
        let dx = tr(i as f64 * grid);
        for p in &one { odd_poly.push([p[0] + dx, p[1]]); }
    }
    let num_of_lines = (height / grid + 2.0) as usize;
    let mut out: Vec<Vec<NP>> = Vec::new();
    for i in 0..num_of_lines {
        let dy = tr(grid * i as f64);
        out.push(odd_poly.iter().map(|p| [p[0], p[1] + dy]).collect());
    }
    for i in 0..num_of_lines {
        let (dx, dy) = (tr(-0.5 * grid), tr((i as f64 + 0.5) * grid));
        out.push(odd_poly.iter().map(|p| [p[0] + dx, p[1] + dy]).collect());
    }
    if direction < 0 { for pl in &mut out { for p in pl.iter_mut() { p.swap(0, 1); } } }
    out
}

fn repeat_pattern(direction: i32, grid: f64, in_w: f64, in_h: f64) -> Vec<Vec<NP>> {
    let (mut width, mut height) = (in_w, in_h);
    if direction < 0 { width = in_h; height = in_w; }
    let n = (height / grid + 1.0) as usize;
    let mut out: Vec<Vec<NP>> = Vec::new();
    for i in 0..n { out.push(vec![[0.0, tr(grid * i as f64)], [width, tr(grid * i as f64)]]); }
    if direction < 0 { for pl in &mut out { for p in pl.iter_mut() { p.swap(0, 1); } } }
    out
}

fn infill_layers(z_height: f64, repeat_ratio: f64, grid: f64, width: f64, height: f64) -> Vec<Vec<NP>> {
    let trans_layer = grid * 0.4;
    let repeat_layer = grid * repeat_ratio;
    let z_height = z_height + repeat_layer / 2.0 + trans_layer;
    let period = trans_layer + repeat_layer;
    let remains = z_height - (z_height / period).floor() * period;
    let trans_z = remains - repeat_layer;
    let phase = ((z_height % (period * 2.0)) - (period - 1.0)) as i64; // truncation like `int phase = ...`
    let direction = if phase <= 0 { -1 } else { 1 };
    if trans_z < 0.0 {
        repeat_pattern(direction, grid, width, height)
    } else {
        let progress = (trans_z % trans_layer) / trans_layer;
        if progress < 0.5 { transform_pattern((progress + 0.1) * 2.0, direction, grid, width, height) }
        else { transform_pattern((1.1 - progress) * 2.0, -direction, grid, width, height) }
    }
}

fn rot0(p: P, a: f64) -> P { let (s, c) = (a.sin(), a.cos()); [p[0] * c - p[1] * s, p[0] * s + p[1] * c] }

pub fn fill_crosshatch(poly: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    let o = cx.origin;
    let angle = cx.c.angle_deg.to_radians();
    let t = |p: P| { let p = [p[0] - o[0], p[1] - o[1]]; if angle.abs() >= 1e-4 { rot0(p, -angle) } else { p } };
    let ex = Poly { contour: poly.contour.iter().map(|&p| t(p)).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|&p| t(p)).collect()).collect() };
    let (lo, hi) = gx::bbox_pts(ex.contour.iter()).unwrap();
    let (lo, hi) = ([(lo[0] * NM).round(), (lo[1] * NM).round()], [(hi[0] * NM).round(), (hi[1] * NM).round()]);
    let dens = cx.density / cx.multiline as f64;
    let mut line_spacing = (cx.spacing * NM / dens).trunc();
    if cx.density < 0.999 { line_spacing = (line_spacing * 1.08).trunc(); }
    let al = [(lo[0] / (line_spacing * 4.0)).floor() * line_spacing * 4.0, (lo[1] / (line_spacing * 4.0)).floor() * line_spacing * 4.0];
    let bmin = [lo[0].min(al[0]), lo[1].min(al[1])];
    let mut repeat_ratio = 1.0;
    if cx.density < 0.3 { repeat_ratio = (1.0 - (-5.0 * cx.density).exp()).clamp(0.2, 1.0); }
    let pls = infill_layers(cx.z * NM, repeat_ratio, line_spacing, hi[0] - bmin[0], hi[1] - bmin[1]);
    let pls: Vec<Vec<P>> = pls.into_iter().map(|pl| pl.into_iter().map(|p| [(p[0] + bmin[0]) / NM, (p[1] + bmin[1]) / NM]).collect()).collect();
    let pls = if cx.multiline > 1 { super::rect::multiline_offsets_pub(pls, cx.multiline, cx.spacing) } else { pls };
    let region = vec![ex.clone()];
    let mut pl = gx::clip_lines(&pls, &region);
    let m = 0.8 * cx.spacing;
    pl.retain(|p| gx::polyline_len(p) >= m);
    if pl.is_empty() { return pl; }
    clipper_order(&mut pl);
    let conn = if cx.anchor_max < 0.05 { chain_polylines(pl, None) } else { connect_infill(pl, &gx::rings(&region), cx.spacing, cx.anchor, cx.anchor_max, cx.multiline) };
    conn.into_iter().map(|l| l.into_iter().map(|p| { let p = if angle.abs() >= 1e-4 { rot0(p, angle) } else { p }; [p[0] + o[0], p[1] + o[1]] }).collect()).collect()
}
