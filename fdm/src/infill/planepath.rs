//! `FillPlanePath` family: Archimedean chords, Hilbert curve (optionally smoothed), octagram spiral.
use super::connect::connect_infill;
use super::gx::{self, P};
use super::rect::clipper_order;
use super::{chain_polylines, Ctx};
use crate::types::Poly;
use std::f64::consts::PI;

const NM: f64 = 1e6;
const EPSILON: f64 = 1e-4;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind { Archimedean, Hilbert, Octagram }

/// `InfillPolylineOutput` / `InfillPolylineClipper`.
struct Out { scale: f64, clip: Option<([i64; 2], [i64; 2])>, pts: Vec<[i64; 2]>, prev: i32, this: i32 }
impl Out {
    fn scaled(&self, p: [f64; 2]) -> [i64; 2] { [(p[0] * self.scale + 0.5).floor() as i64, (p[1] * self.scale + 0.5).floor() as i64] }
    fn sides(&self, p: [i64; 2]) -> i32 {
        let (lo, hi) = self.clip.unwrap();
        (p[0] < lo[0]) as i32 * 1 + (p[0] > hi[0]) as i32 * 2 + (p[1] < lo[1]) as i32 * 8 + (p[1] > hi[1]) as i32 * 4
    }
    fn add(&mut self, fp: [f64; 2]) {
        let pt = self.scaled(fp);
        if self.clip.is_none() { self.pts.push(pt); return; }
        if self.pts.len() < 2 {
            let s = self.sides(pt);
            if self.pts.is_empty() { self.prev = s; } else { self.this = s; }
            self.pts.push(pt);
        } else {
            let next = self.sides(pt);
            if self.this == 0 || (self.prev & self.this & next) == 0 { self.prev = self.this; } else { self.pts.pop(); }
            self.pts.push(pt);
            self.this = next;
        }
    }
}

fn hilbert_n_to_xy(n: usize) -> [i64; 2] {
    const NEXT_STATE: [usize; 16] = [4, 0, 0, 12, 0, 4, 4, 8, 12, 8, 8, 4, 8, 12, 12, 0];
    const DX: [i64; 16] = [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0];
    const DY: [i64; 16] = [0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1];
    let mut ndigits = 0;
    let mut nc = n;
    while nc > 0 { nc >>= 2; ndigits += 1; }
    let mut state = if ndigits & 1 == 1 { 4 } else { 0 };
    let (mut x, mut y) = (0i64, 0i64);
    for i in (0..ndigits).rev() {
        let digit = (n >> (i * 2)) & 3;
        state += digit;
        x |= DX[state] << i;
        y |= DY[state] << i;
        state = NEXT_STATE[state];
    }
    [x, y]
}

fn flatten_bezier(curve: &[[f64; 2]; 6], deviation: f64) -> Vec<[f64; 2]> {
    let is_flat = |c: &[[f64; 2]; 6]| -> bool {
        let chord = [c[5][0] - c[0][0], c[5][1] - c[0][1]];
        let max_cross_sq = deviation * deviation * (chord[0] * chord[0] + chord[1] * chord[1]);
        (1..5).all(|i| { let o = [c[i][0] - c[0][0], c[i][1] - c[0][1]]; let cr = chord[0] * o[1] - chord[1] * o[0]; cr * cr <= max_cross_sq })
    };
    let subdivide = |c: &[[f64; 2]; 6]| -> ([[f64; 2]; 6], [[f64; 2]; 6]) {
        let mut sub = *c;
        let mut left = [[0.0; 2]; 6];
        let mut right = [[0.0; 2]; 6];
        left[0] = sub[0];
        right[5] = sub[5];
        for level in 1..6 {
            for i in 0..6 - level { sub[i] = [0.5 * (sub[i][0] + sub[i + 1][0]), 0.5 * (sub[i][1] + sub[i + 1][1])]; }
            left[level] = sub[0];
            right[6 - level - 1] = sub[6 - level - 1];
        }
        (left, right)
    };
    let (l, r) = subdivide(curve);
    let mut subs = vec![l, r];
    for _depth in 1..16 {
        if subs.iter().all(|c| is_flat(c)) { break; }
        let mut finer = Vec::with_capacity(subs.len() * 2);
        for c in &subs { let (a, b) = subdivide(c); finer.push(a); finer.push(b); }
        subs = finer;
    }
    subs.iter().map(|c| c[5]).collect()
}

fn norm(v: [f64; 2]) -> [f64; 2] { let l = (v[0] * v[0] + v[1] * v[1]).sqrt(); if l == 0.0 { v } else { [v[0] / l, v[1] / l] } }

fn generate(kind: Kind, min: [i64; 2], max: [i64; 2], resolution: f64, smooth: f64, out: &mut Out) {
    match kind {
        Kind::Archimedean => {
            let rmax = ((max[0] as f64).powi(2) + (max[1] as f64).powi(2)).sqrt() * 2f64.sqrt() + 1.5;
            let (a, b) = (1.0, 1.0 / (2.0 * PI));
            let (mut theta, mut r) = (0.0f64, 1.0f64);
            out.add([0.0, 0.0]);
            out.add([1.0, 0.0]);
            while r < rmax {
                theta += 2.0 * (1.0 - resolution / r).acos();
                r = a + b * theta;
                out.add([r * theta.cos(), r * theta.sin()]);
            }
        }
        Kind::Octagram => {
            let rmax = ((max[0] as f64).powi(2) + (max[1] as f64).powi(2)).sqrt() * 2f64.sqrt() + 1.5;
            let mut r = 0.0f64;
            let r_inc = 2f64.sqrt();
            out.add([0.0, 0.0]);
            while r < rmax {
                r += r_inc;
                let rx = r / 2f64.sqrt();
                let r2 = r + rx;
                for p in [[r, 0.0], [r2, rx], [rx, rx], [rx, r2], [0.0, r], [-rx, r2], [-rx, rx], [-r2, rx], [-r, 0.0], [-r2, -rx], [-rx, -rx], [-rx, -r2], [0.0, -r], [rx, -r2], [rx, -rx], [r2 + r_inc, -rx]] { out.add(p); }
            }
        }
        Kind::Hilbert => {
            let sz0 = ((max[0] + 1 - min[0]).max(max[1] + 1 - min[1])) as usize;
            let mut sz = 2usize;
            while sz < sz0 { sz <<= 1; }
            let n = sz * sz;
            let tp = |i: usize| -> [f64; 2] { let p = hilbert_n_to_xy(i); [(p[0] + min[0]) as f64, (p[1] + min[1]) as f64] };
            if smooth == 0.0 {
                for i in 0..n { out.add(tp(i)); }
            } else {
                let corner_distance = 0.5 * smooth;
                let deviation = if resolution > 0.0 && resolution.is_finite() { resolution } else { EPSILON };
                let cd = corner_distance;
                let curve = [[-cd, 0.0], [-0.7 * cd, 0.0], [-0.4 * cd, 0.0], [0.0, 0.4 * cd], [0.0, 0.7 * cd], [0.0, cd]];
                let coeffs = flatten_bezier(&curve, deviation);
                let mut last: Option<[f64; 2]> = None;
                let mut add = |p: [f64; 2], out: &mut Out| { if last != Some(p) { out.add(p); last = Some(p); } };
                let mut previous = tp(0);
                let mut corner = tp(1);
                add(previous, out);
                for i in 1..n - 1 {
                    let next = tp(i + 1);
                    let incoming = norm([corner[0] - previous[0], corner[1] - previous[1]]);
                    let outgoing = norm([next[0] - corner[0], next[1] - corner[1]]);
                    let cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
                    if cross.abs() < EPSILON { add(corner, out); } else {
                        add([corner[0] - cd * incoming[0], corner[1] - cd * incoming[1]], out);
                        for c in &coeffs { add([corner[0] + c[0] * incoming[0] + c[1] * outgoing[0], corner[1] + c[0] * incoming[1] + c[1] * outgoing[1]], out); }
                    }
                    previous = corner;
                    corner = next;
                }
                add(corner, out);
            }
        }
    }
}

fn rot0(p: P, a: f64) -> P { let (s, c) = (a.sin(), a.cos()); [p[0] * c - p[1] * s, p[0] * s + p[1] * c] }

pub fn fill_plane_path(poly: &Poly, cx: &Ctx, kind: Kind) -> Vec<Vec<P>> {
    let o = cx.origin;
    // direction.first = angle + _layer_angle(0) + 90deg
    let dir = cx.c.angle_deg.to_radians() + std::f64::consts::FRAC_PI_2;
    let t = |p: P| rot0([p[0] - o[0], p[1] - o[1]], -dir);
    let mut ex = Poly { contour: poly.contour.iter().map(|&p| t(p)).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|&p| t(p)).collect()).collect() };
    // sparse infill is always aligned to the object bounding box
    let (olo, ohi) = match cx.c.object_bbox {
        Some((l, h)) => ([l[0] - o[0], l[1] - o[1]], [h[0] - o[0], h[1] - o[1]]),
        None => { let (l, h) = gx::bbox_pts(poly.contour.iter()).unwrap(); ([l[0] - o[0], l[1] - o[1]], [h[0] - o[0], h[1] - o[1]]) }
    };
    let corners = [[olo[0], olo[1]], [ohi[0], ohi[1]], [olo[0], ohi[1]], [ohi[0], olo[1]]];
    let rc: Vec<P> = corners.iter().map(|&c| rot0(c, -dir)).collect();
    let (blo, bhi) = gx::bbox_pts(rc.iter()).unwrap();
    let (mut blo, mut bhi) = ([(blo[0] * NM).round(), (blo[1] * NM).round()], [(bhi[0] * NM).round(), (bhi[1] * NM).round()]);
    let (elo, ehi) = gx::bbox_pts(ex.contour.iter()).unwrap();
    let infl = cx.spacing * NM * cx.multiline as f64 + 100.0;
    let mut slo = [(elo[0] * NM).round() - infl, (elo[1] * NM).round() - infl];
    let mut shi = [(ehi[0] * NM).round() + infl, (ehi[1] * NM).round() + infl];
    let centered = kind != Kind::Hilbert;
    let shift = if centered { [((blo[0] + bhi[0]) / 2.0).trunc(), ((blo[1] + bhi[1]) / 2.0).trunc()] } else { blo };
    let sh_mm = [shift[0] / NM, shift[1] / NM];
    let tr = |p: P| [p[0] - sh_mm[0], p[1] - sh_mm[1]];
    ex = Poly { contour: ex.contour.iter().map(|&p| tr(p)).collect(), holes: ex.holes.iter().map(|h| h.iter().map(|&p| tr(p)).collect()).collect() };
    for k in 0..2 { blo[k] -= shift[k]; bhi[k] -= shift[k]; slo[k] -= shift[k]; shi[k] -= shift[k]; }
    let dist = cx.spacing * NM * cx.multiline as f64 / cx.density;
    let min_x = (blo[0] / dist).ceil() as i64;
    let min_y = (blo[1] / dist).ceil() as i64;
    let max_x = (bhi[0] / dist).ceil() as i64;
    let max_y = (bhi[1] / dist).ceil() as i64;
    let resolution = cx.c.resolution * NM / dist;
    let smooth = if kind == Kind::Hilbert && cx.c.smooth_factor.is_finite() { cx.c.smooth_factor.clamp(0.0, 1.0) } else { 0.0 };
    let mut out = Out { scale: dist, clip: Some(([slo[0] as i64, slo[1] as i64], [shi[0] as i64, shi[1] as i64])), pts: Vec::new(), prev: 0, this: 0 };
    generate(kind, [min_x, min_y], [max_x, max_y], resolution, smooth, &mut out);
    let polyline: Vec<P> = out.pts.iter().map(|p| [p[0] as f64 / NM, p[1] as f64 / NM]).collect();
    if polyline.len() < 2 { return Vec::new(); }
    let polylines = vec![polyline];
    let polylines = if cx.multiline > 1 { super::rect::multiline_offsets_pub(polylines, cx.multiline, cx.spacing) } else { polylines };
    let region = vec![ex.clone()];
    let mut pl = gx::clip_lines(&polylines, &region);
    if pl.is_empty() { return pl; }
    clipper_order(&mut pl);
    let chained = if cx.anchor_max < 0.05 || cx.density > 0.5 { chain_polylines(pl, None) } else { connect_infill(pl, &gx::rings(&region), cx.spacing, cx.anchor, cx.anchor_max, cx.multiline) };
    chained.into_iter().map(|l| l.into_iter().map(|p| { let p = rot0([p[0] + sh_mm[0], p[1] + sh_mm[1]], dir); [p[0] + o[0], p[1] + o[1]] }).collect()).collect()
}
