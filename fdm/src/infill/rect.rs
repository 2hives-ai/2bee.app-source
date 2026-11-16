//! Line-sweep based patterns: `FillRectilinear::fill_surface_by_multilines` (grid, triangles, tri-hexagon,
//! cubic, quarter cubic, lateral lattice / honeycomb) and `FillLine`.
use super::connect::connect_infill;
use super::gx::{self, P, EPS};
use super::{chain_polylines, Ctx};
use crate::types::{Poly, Polys};

#[derive(Clone, Copy, Debug)]
pub struct Sweep {
    /// `SweepParams::angle_base` (radians, added to the infill direction).
    pub angle: f64,
    /// `SweepParams::pattern_shift` (mm, shifts the line lattice along its normal).
    pub shift: f64,
}

/// Infinite lines of one sweep: direction angle `a_c + 90deg`, lattice `x' = ref.n - shift (mod ls)`.
/// Lines nearer than `margin` to the extent of the source polygon are dropped (`make_fill_lines` x_margin).
pub fn make_fill_lines(poly: &Poly, a_c: f64, refpt: P, line_spacing: f64, shift: f64, margin: f64) -> Vec<Vec<P>> {
    let n = [a_c.cos(), a_c.sin()];
    let d = [-a_c.sin(), a_c.cos()];
    let (mut lo, mut hi, mut ulo, mut uhi) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for q in &poly.contour {
        let c = q[0] * n[0] + q[1] * n[1];
        let u = q[0] * d[0] + q[1] * d[1];
        lo = lo.min(c); hi = hi.max(c); ulo = ulo.min(u); uhi = uhi.max(u);
    }
    let ref0 = refpt[0] * n[0] + refpt[1] * n[1] - shift;
    let x_min = lo + margin;
    let x_max = hi - margin;
    let k0 = ((x_min - ref0) / line_spacing - 1e-9).ceil();
    let mut out = Vec::new();
    let mut k = k0;
    loop {
        let c = ref0 + k * line_spacing;
        if c > x_max + 1e-9 { break; }
        out.push(vec![
            [c * n[0] + (ulo - 1.0) * d[0], c * n[1] + (ulo - 1.0) * d[1]],
            [c * n[0] + (uhi + 1.0) * d[0], c * n[1] + (uhi + 1.0) * d[1]],
        ]);
        k += 1.0;
    }
    out
}

/// `fill_surface_by_multilines` for one ExPolygon: the integer-exact port in `rectint` (libslic3r's own Clipper, line
/// sweeps and `connect_infill`). Returns polylines in the order libslic3r emits them.
pub fn fill_by_multilines(poly: &Poly, cx: &Ctx, sweeps: &[Sweep], layer_angle: f64) -> Vec<Vec<P>> {
    use super::rectint::{self, MlParams, SweepF};
    let fr = cx.frame();
    let ex = rectint::poly_to_iex(poly, &fr);
    if ex.contour.len() < 3 { return Vec::new(); }
    if cx.multiline > 1 { return fill_by_multilines_float(poly, cx, sweeps, layer_angle); }
    let params = MlParams {
        spacing: cx.spacing,
        density: cx.density as f32,
        multiline: cx.multiline as i32,
        angle: cx.angle_f32(),
        layer_angle: layer_angle as f32,
        bbox: cx.bbox_int(poly),
        anchor: cx.anchor as f32,
        anchor_max: cx.anchor_max as f32,
    };
    let sw: Vec<SweepF> = sweeps.iter().map(|s| SweepF { angle: s.angle as f32, shift: s.shift as f32 }).collect();
    rectint::fill_by_multilines_int(&ex, &params, &sw).into_iter().map(|l| l.into_iter().map(|q| fr.to_mm(q)).collect()).collect()
}

/// The previous float implementation (kept for `fill_multiline > 1`).
pub fn fill_by_multilines_float(poly: &Poly, cx: &Ctx, sweeps: &[Sweep], layer_angle: f64) -> Vec<Vec<P>> {
    let density = cx.density / sweeps.len() as f64;
    let spacing = cx.spacing;
    let multiline = cx.multiline.max(1) as f64;
    let line_spacing = spacing * multiline / density;
    let base = vec![poly.clone()];
    let a0 = cx.direction_angle(layer_angle);
    let mut raw: Vec<Vec<P>> = Vec::new();
    for sw in sweeps {
        raw.extend(make_fill_lines(poly, a0 + sw.angle, cx.center, line_spacing, sw.shift, spacing + EPS));
    }
    let contracted = gx::offset(&base, -0.5 * spacing);
    let region = if contracted.is_empty() { base.clone() } else { contracted };
    let mut lines = gx::clip_lines(&raw, &region);
    clipper_order(&mut lines);
    if cx.multiline > 1 { lines = multiline_offsets(lines, cx.multiline, spacing); }
    if lines.is_empty() { return lines; }
    if cx.anchor_max < 0.05 {
        return chain_polylines(lines, None);
    }
    connect_infill(lines, &gx::rings(&region), spacing, cx.anchor, cx.anchor_max, cx.multiline)
}

/// `multiline_fill` (FillBase.cpp): n parallel copies of every polyline at +-k*spacing (round joins/ends).
/// Approximation: only straight 2-point polylines are supported, which is all the sweeps produce.
pub fn multiline_offsets_pub(lines: Vec<Vec<P>>, n: usize, spacing: f64) -> Vec<Vec<P>> { multiline_offsets(lines, n, spacing) }
fn multiline_offsets(lines: Vec<Vec<P>>, n: usize, spacing: f64) -> Vec<Vec<P>> {
    let rings = n / 2;
    let mut offs: Vec<f64> = Vec::new();
    if n % 2 != 0 {
        offs.push(0.0);
        for i in 1..=rings { offs.push(i as f64 * spacing); }
    } else {
        for i in 0..rings { offs.push(0.5 * spacing + i as f64 * spacing); }
    }
    let mut out: Vec<Vec<P>> = Vec::new();
    for t in offs {
        if t == 0.0 { out.extend(lines.iter().cloned()); continue; }
        for l in &lines {
            if l.len() < 2 { continue; }
            let (a, b) = (l[0], l[l.len() - 1]);
            let len = gx::dist(a, b);
            if len < EPS { continue; }
            let u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
            let nrm = [-u[1], u[0]];
            // Clipper2 round-offset of an open path yields a closed outline (stadium) around the line.
            let mut ring = vec![[a[0] + nrm[0] * t, a[1] + nrm[1] * t], [b[0] + nrm[0] * t, b[1] + nrm[1] * t]];
            let steps = 8;
            for s in 1..steps {
                let th = std::f64::consts::PI * s as f64 / steps as f64;
                let (c, sn) = (th.cos(), th.sin());
                ring.push([b[0] + t * (nrm[0] * c + u[0] * sn), b[1] + t * (nrm[1] * c + u[1] * sn)]);
            }
            ring.push([b[0] - nrm[0] * t, b[1] - nrm[1] * t]);
            ring.push([a[0] - nrm[0] * t, a[1] - nrm[1] * t]);
            for s in 1..steps {
                let th = std::f64::consts::PI * s as f64 / steps as f64;
                let (c, sn) = (th.cos(), th.sin());
                ring.push([a[0] + t * (-nrm[0] * c - u[0] * sn), a[1] + t * (-nrm[1] * c - u[1] * sn)]);
            }
            let first = ring[0];
            ring.push(first);
            out.push(ring);
        }
    }
    out
}

/// `FillLine::_fill_surface_single`.
pub fn fill_line(poly: &Poly, cx: &Ctx, layer_angle: f64) -> Vec<Vec<P>> {
    let spacing = cx.spacing;
    let expp = gx::offset(&vec![poly.clone()], -0.5 * spacing); // Fill::fill_surface: overlap - 0.5 * spacing
    let mut out: Vec<Vec<P>> = Vec::new();
    let a_dir = cx.direction_angle(layer_angle);
    for ex in expp {
        let rot = |p: P, a: f64| -> P { let (c, s) = (a.cos(), a.sin()); [p[0] * c - p[1] * s, p[0] * s + p[1] * c] };
        let unrot = |p: P| rot(p, -a_dir);
        let ex_rot = Poly { contour: ex.contour.iter().map(|&p| unrot(p)).collect(), holes: ex.holes.iter().map(|h| h.iter().map(|&p| unrot(p)).collect()).collect() };
        let min_spacing = spacing;
        let line_spacing = min_spacing / cx.density;
        let diag = line_spacing * 2.0;
        let osc = line_spacing - min_spacing;
        let (lo, hi) = gx::bbox_pts(ex_rot.contour.iter()).unwrap();
        let refp = unrot(cx.center);
        // align_to_grid(bbox.min, (ls, ls), ref)
        let x0 = refp[0] + ((lo[0] - refp[0]) / line_spacing).floor() * line_spacing;
        let y_min = lo[1].min(refp[1] + ((lo[1] - refp[1]) / line_spacing).floor() * line_spacing);
        let x_max = hi[0] + EPS;
        let mut lines: Vec<Vec<P>> = Vec::new();
        let mut x = x0;
        let mut i = 0usize;
        while x <= x_max {
            let o = if i & 1 == 1 { osc } else { 0.0 };
            lines.push(vec![[x - o, y_min], [x + o, hi[1]]]);
            x += line_spacing;
            i += 1;
        }
        let grown = gx::offset(&vec![ex_rot.clone()], 0.02);
        let mut polylines = gx::clip_lines(&lines, &grown);
        let extra = (min_spacing * 1e6 * 0.3 + 0.5).floor() / 1e6;
        for pl in &mut polylines {
            let n = pl.len();
            let (fi, la) = if pl[0][1] > pl[n - 1][1] { (n - 1, 0) } else { (0, n - 1) };
            pl[fi][1] -= extra;
            pl[la][1] += extra;
        }
        if polylines.is_empty() { continue; }
        let off = gx::offset(&vec![ex_rot.clone()], min_spacing / 2.0);
        let mut first = true;
        let chained = chain_polylines(polylines, None);
        let mut cur: Vec<Vec<P>> = Vec::new();
        for pl in chained {
            if !first {
                let last_point = *cur.last().unwrap().last().unwrap();
                let first_point = pl[0];
                let (dx, dy) = ((last_point[0] - first_point[0]).abs(), (last_point[1] - first_point[1]).abs());
                let tol = 10.0 * EPS;
                let can = dx >= (line_spacing - osc) - tol && dx <= (line_spacing + osc) + tol && dy <= diag;
                if can && segment_inside(&off, last_point, first_point) {
                    cur.last_mut().unwrap().extend(pl);
                    continue;
                }
            }
            cur.push(pl);
            first = false;
        }
        for pl in cur {
            out.push(pl.into_iter().map(|p| rot(p, a_dir)).collect());
        }
    }
    out
}


/// `ExPolygon::contains(Line)`: the whole segment lies inside the polygon.
fn segment_inside(region: &Polys, a: P, b: P) -> bool {
    let c = gx::clip_lines(&[vec![a, b]], region);
    if c.len() != 1 { return false; }
    let l = gx::polyline_len(&c[0]);
    (l - gx::dist(a, b)).abs() < 1e-3
}

/// Emulate the output order of ClipperLib's open-path intersection (scanbeam sweep, Y descending then X
/// ascending of the polyline start; polylines start at their larger-Y end). Needed because
/// `connect_infill` breaks ties between equal-length boundary arcs by input order.
pub fn clipper_order(lines: &mut Vec<Vec<P>>) {
    for l in lines.iter_mut() {
        let n = l.len();
        let (a, b) = (l[0], l[n - 1]);
        if b[1] > a[1] + 1e-9 || ((b[1] - a[1]).abs() <= 1e-9 && b[0] < a[0]) { l.reverse(); }
    }
    lines.sort_by(|a, b| {
        let (pa, pb) = (a[0], b[0]);
        let ya = (pa[1] * 1e4).round(); let yb = (pb[1] * 1e4).round();
        yb.partial_cmp(&ya).unwrap().then(pa[0].partial_cmp(&pb[0]).unwrap())
    });
}
