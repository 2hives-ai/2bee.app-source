//! Port of `Fill::connect_infill` and its helpers (libslic3r/Fill/FillBase.cpp, OrcaSlicer 2.5.0-dev):
//! infill line ends that touch the region boundary are joined along the boundary when the arc is
//! shorter than `anchor_max`, otherwise they receive a boundary "hook" of at most `anchor` length.
use super::gx::{dist, polyline_len, P};

/// libslic3r SCALED_EPSILON. This module runs entirely in libslic3r's integer grid (1 nm units held in f64), so that
/// every length comparison and tie behaves as in `FillBase.cpp`.
const EPS: f64 = 100.0;

/// `Point lerp(const Point&, const Point&, double t)`: `((1-t)*a + t*b).cast<coord_t>()` TRUNCATES toward zero.
fn lerp(a: P, b: P, t: f64) -> P { [((1.0 - t) * a[0] + t * b[0]).trunc(), ((1.0 - t) * a[1] + t * b[1]).trunc()] }

const NONE: usize = usize::MAX;

#[derive(Clone)]
struct Cp {
    contour: usize,
    pt: usize,
    param: f64,
    prev: usize,
    next: usize,
    not_prev: f64,
    not_next: f64,
    consumed: bool,
    prev_trim: bool,
    next_trim: bool,
}
impl Cp {
    fn unconnected() -> Self {
        Cp { contour: NONE, pt: NONE, param: 0.0, prev: NONE, next: NONE, not_prev: f64::MAX, not_next: f64::MAX, consumed: false, prev_trim: false, next_trim: false }
    }
}

struct Graph {
    boundary: Vec<Vec<P>>,
    params: Vec<Vec<f64>>,
    cps: Vec<Cp>,
}

impl Graph {
    fn consume_prev(&mut self, i: usize) { let c = &mut self.cps[i]; c.not_prev = 0.0; c.prev_trim = true; c.consumed = true; }
    fn consume_next(&mut self, i: usize) { let c = &mut self.cps[i]; c.not_next = 0.0; c.next_trim = true; c.consumed = true; }
    fn trim_prev(&mut self, i: usize, l: f64) { let c = &mut self.cps[i]; if l < c.not_prev { c.not_prev = l; c.prev_trim = true; } }
    fn trim_next(&mut self, i: usize, l: f64) { let c = &mut self.cps[i]; if l < c.not_next { c.not_next = l; c.next_trim = true; } }
    fn could_take_prev(&self, i: usize) -> bool { let c = &self.cps[i]; !c.consumed && c.not_prev > EPS }
    fn could_take_next(&self, i: usize) -> bool { let c = &self.cps[i]; !c.consumed && c.not_next > EPS }
    fn could_connect_prev(&self, i: usize) -> bool {
        let c = &self.cps[i];
        !c.consumed && c.prev != i && !self.cps[c.prev].consumed && !c.prev_trim && !self.cps[c.prev].next_trim
    }
    fn could_connect_next(&self, i: usize) -> bool {
        let c = &self.cps[i];
        !c.consumed && c.next != i && !self.cps[c.next].consumed && !c.next_trim && !self.cps[c.next].prev_trim
    }
    fn clen(&self, contour: usize) -> f64 { *self.params[contour].last().unwrap() }
}

fn dist_ccw(p1: f64, p2: f64, len: f64) -> f64 { let d = p2 - p1; if d < 0.0 { d + len } else { d } }
fn dist_cw(p1: f64, p2: f64, len: f64) -> f64 { dist_ccw(p2, p1, len) }

fn take_cw_full(pl: &mut Vec<P>, contour: &[P], start: usize, end: usize) {
    let mut i = if start == 0 { contour.len() - 1 } else { start - 1 };
    while i != end { pl.push(contour[i]); i = if i == 0 { contour.len() - 1 } else { i - 1 }; }
    pl.push(contour[i]);
}
fn take_ccw_full(pl: &mut Vec<P>, contour: &[P], start: usize, end: usize) {
    let mut i = start + 1;
    if i == contour.len() { i = 0; }
    while i != end { pl.push(contour[i]); i += 1; if i == contour.len() { i = 0; } }
    pl.push(contour[i]);
}
fn take_cw_limited(pl: &mut Vec<P>, contour: &[P], params: &[f64], start: usize, end: usize, to_take: f64) -> f64 {
    let length = *params.last().unwrap();
    let p0 = params[start];
    let mut i = if start == 0 { contour.len() - 1 } else { start - 1 };
    let mut iprev = start;
    let mut lprev = 0.0;
    loop {
        let l = dist_cw(p0, params[i], length);
        if l >= to_take {
            let t = (to_take - lprev) / (l - lprev);
            pl.push(lerp(contour[iprev], contour[i], t));
            return to_take;
        }
        pl.push(contour[i]);
        if i == end { return l; }
        iprev = i; lprev = l;
        i = if i == 0 { contour.len() - 1 } else { i - 1 };
    }
}
fn take_ccw_limited(pl: &mut Vec<P>, contour: &[P], params: &[f64], start: usize, end: usize, to_take: f64) -> f64 {
    let length = *params.last().unwrap();
    let p0 = params[start];
    let mut i = start + 1;
    if i == contour.len() { i = 0; }
    let mut iprev = start;
    let mut lprev = 0.0;
    loop {
        let l = dist_ccw(p0, params[i], length);
        if l >= to_take {
            let t = (to_take - lprev) / (l - lprev);
            pl.push(lerp(contour[iprev], contour[i], t));
            return to_take;
        }
        pl.push(contour[i]);
        if i == end { return l; }
        iprev = i; lprev = l;
        i += 1;
        if i == contour.len() { i = 0; }
    }
}

/// `take(pl1, pl2, contour, cp_start, cp_end, clockwise)`: append the boundary path and pl2 to pl1.
fn take_connect(g: &mut Graph, pl1: &mut Vec<P>, pl2: &[P], cp_start: usize, cp_end: usize, clockwise: bool) {
    let contour_idx = g.cps[cp_start].contour;
    {
        let contour = &g.boundary[contour_idx];
        let (s, e) = (g.cps[cp_start].pt, g.cps[cp_end].pt);
        if clockwise { take_cw_full(pl1, contour, s, e); } else { take_ccw_full(pl1, contour, s, e); }
    }
    pl1.extend_from_slice(&pl2[1..]);
    let (mut a, mut b) = (cp_start, cp_end);
    if clockwise { std::mem::swap(&mut a, &mut b); }
    if g.cps[a].next != b {
        let mut cp = g.cps[a].next;
        while g.cps[cp].next != b {
            g.consume_prev(cp);
            g.consume_next(cp);
            cp = g.cps[cp].next;
        }
    }
    g.consume_next(a);
    g.consume_prev(b);
}

#[allow(clippy::too_many_arguments)]
fn take_limited(g: &mut Graph, pl1: &mut Vec<P>, cp_start: usize, cp_end: usize, clockwise: bool, take_max: f64, half_w: f64) {
    if !(if clockwise { g.could_take_prev(cp_start) } else { g.could_take_next(cp_start) }) { return; }
    let contour_idx = g.cps[cp_start].contour;
    let pt = g.boundary[contour_idx][g.cps[cp_start].pt];
    let add_at_start = pl1[0] == pt;
    let mut tmp: Vec<P> = Vec::new();
    if add_at_start { tmp = std::mem::take(pl1); }
    let length = g.clen(contour_idx);
    let mut to_go = take_max;
    g.cps[cp_start].consumed = true;
    // Split borrows: contour/params are immutable data, cps are mutated through `g`.
    let contour = g.boundary[contour_idx].clone();
    let params = g.params[contour_idx].clone();
    if cp_start == cp_end {
        to_go = (to_go.min(length - half_w)).max(0.0);
        to_go = to_go.min(if clockwise { g.cps[cp_start].not_prev } else { g.cps[cp_start].not_next });
        g.consume_prev(cp_start);
        g.consume_next(cp_start);
        if to_go > EPS {
            let s = g.cps[cp_start].pt;
            if clockwise { take_cw_limited(pl1, &contour, &params, s, s, to_go); } else { take_ccw_limited(pl1, &contour, &params, s, s, to_go); }
        }
    } else if clockwise {
        let mut cp = cp_start;
        while cp != cp_end {
            let prev = g.cps[cp].prev;
            let l = dist_cw(g.cps[cp].param, g.cps[prev].param, length);
            to_go = to_go.min(g.cps[cp].not_prev);
            to_go = to_go.min(l - half_w).max(0.0);
            g.consume_prev(cp);
            if l >= to_go {
                if to_go > EPS {
                    g.trim_next(prev, l - to_go);
                    take_cw_limited(pl1, &contour, &params, g.cps[cp].pt, g.cps[prev].pt, to_go);
                }
                break;
            } else {
                g.trim_next(prev, 0.0);
                take_cw_full(pl1, &contour, g.cps[cp].pt, g.cps[prev].pt);
                to_go -= l;
            }
            cp = prev;
        }
    } else {
        let mut cp = cp_start;
        while cp != cp_end {
            let next = g.cps[cp].next;
            let l = dist_ccw(g.cps[cp].param, g.cps[next].param, length);
            to_go = to_go.min(g.cps[cp].not_next);
            to_go = to_go.min(l - half_w).max(0.0);
            g.consume_next(cp);
            if l >= to_go {
                if to_go > EPS {
                    g.trim_prev(next, l - to_go);
                    take_ccw_limited(pl1, &contour, &params, g.cps[cp].pt, g.cps[next].pt, to_go);
                }
                break;
            } else {
                g.trim_prev(next, 0.0);
                take_ccw_full(pl1, &contour, g.cps[cp].pt, g.cps[next].pt);
                to_go -= l;
            }
            cp = next;
        }
    }
    if add_at_start {
        pl1.reverse();
        pl1.extend_from_slice(&tmp);
    }
}

fn sq_norm(v: P) -> f64 { v[0] * v[0] + v[1] * v[1] }
fn dot(a: P, b: P) -> f64 { a[0] * b[0] + a[1] * b[1] }

/// `line_alg::distance_to_squared(Linef, Vec2d)`.
fn dist_sq_to_segment(a: P, b: P, p: P) -> f64 {
    let v = [b[0] - a[0], b[1] - a[1]];
    let va = [p[0] - a[0], p[1] - a[1]];
    let l2 = sq_norm(v);
    if l2 == 0.0 { return sq_norm(va); }
    let t = dot(va, v) / l2;
    if t <= 0.0 { sq_norm(va) } else if t >= 1.0 { sq_norm([p[0] - b[0], p[1] - b[1]]) }
    else { sq_norm([t * v[0] - va[0], t * v[1] - va[1]]) }
}

/// `Geometry::ray_circle_intersections_r2_lv2_c`.
fn ray_circle(r2: f64, a: f64, b: f64, lv2: f64, c: f64) -> Option<(P, P)> {
    let x0 = -a * c;
    let y0 = -b * c;
    let d2 = r2 * lv2 - c * c;
    if d2 < 0.0 { return None; }
    let d = d2.sqrt();
    Some((([(x0 + b * d) / lv2, (y0 - a * d) / lv2]), ([(x0 - b * d) / lv2, (y0 + a * d) / lv2])))
}

/// `line_rounded_thick_segment_collision(line_a, line_b, segment_a, segment_b, offset, out_interval)`: the interval
/// (Euclidean length along the line) that lies within `offset` of the segment (rounded ends).
fn line_rounded_thick_segment(line_a: P, line_b: P, segment_a: P, segment_b: P, offset: f64) -> Option<(f64, f64)> {
    let line_v0 = [line_b[0] - line_a[0], line_b[1] - line_a[1]];
    let mut lv = sq_norm(line_v0);
    let segment_v = [segment_b[0] - segment_a[0], segment_b[1] - segment_a[1]];
    let segment_l = sq_norm(segment_v).sqrt();
    let offset2 = offset * offset;
    if lv < EPS * EPS {
        let lpt = [0.5 * (line_a[0] + line_b[0]), 0.5 * (line_a[1] + line_b[1])];
        let intersects = if segment_l > EPS { dist_sq_to_segment(segment_a, segment_b, lpt) < offset2 }
            else { sq_norm([0.5 * (segment_a[0] + segment_b[0]) - lpt[0], 0.5 * (segment_a[1] + segment_b[1]) - lpt[1]]) < offset2 };
        return if intersects { Some((0.0, lv.sqrt())) } else { None };
    }
    let mut tmin = f64::MAX;
    let mut tmax = -tmin;
    let mut extend = |lo: f64, hi: f64| { tmin = tmin.min(lo); tmax = tmax.max(hi); };
    let circle = |segment_pt: P, off2: f64, line_pt: P, line_vec: P, extend: &mut dyn FnMut(f64, f64)| {
        let p0 = [line_pt[0] - segment_pt[0], line_pt[1] - segment_pt[1]];
        let lv2 = sq_norm(line_vec);
        if let Some((f, s)) = ray_circle(off2, line_vec[1], -line_vec[0], lv2, -line_vec[1] * p0[0] + line_vec[0] * p0[1]) {
            let mut tmin = dot([f[0] - p0[0], f[1] - p0[1]], line_vec) / lv2;
            let mut tmax = dot([s[0] - p0[0], s[1] - p0[1]], line_vec) / lv2;
            if tmin > tmax { std::mem::swap(&mut tmin, &mut tmax); }
            tmin = tmin.max(0.0);
            tmax = tmax.min(1.0);
            if tmin <= tmax { extend(tmin, tmax); }
        }
    };
    if segment_l > EPS {
        circle(segment_a, offset2, line_a, line_v0, &mut extend);
        circle(segment_b, offset2, line_a, line_v0, &mut extend);
        let dir_x = [segment_v[0] / segment_l, segment_v[1] / segment_l];
        let dir_y = [-dir_x[1], dir_x[0]];
        let line_p0 = [line_a[0] - segment_a[0], line_a[1] - segment_a[1]];
        let x0 = [dot(line_p0, dir_x), dot(line_p0, dir_y)];
        let v = [dot(line_v0, dir_x), dot(line_v0, dir_y)];
        let (bmin, bmax) = ([0.0, -offset], [segment_l, offset]);
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        let mut clip_side = |p: f64, q: f64| -> bool {
            if p == 0.0 {
                if q < 0.0 { return false; }
            } else {
                let r = q / p;
                if p < 0.0 {
                    if r > t1 { return false; }
                    if r > t0 { t0 = r; }
                } else {
                    if r < t0 { return false; }
                    if r < t1 { t1 = r; }
                }
            }
            true
        };
        let ok = clip_side(-v[0], -bmin[0] + x0[0]) && clip_side(v[0], bmax[0] - x0[0]) && clip_side(-v[1], -bmin[1] + x0[1]) && clip_side(v[1], bmax[1] - x0[1]);
        if ok { extend(t0, t1); }
    } else {
        // (sic) libslic3r passes `offset`, not `offset2`, for the degenerate segment
        circle([0.5 * (segment_a[0] + segment_b[0]), 0.5 * (segment_a[1] + segment_b[1])], offset, line_a, line_v0, &mut extend);
    }
    if tmin <= tmax {
        lv = lv.sqrt();
        Some((tmin * lv, tmax * lv))
    } else { None }
}

/// `clip_start_segment_and_point` / `clip_end_segment_and_point`: (segment index, parameter along the segment, point).
fn clip_start_segment_and_point(pl: &[P], mut distance: f64) -> Option<(usize, f64, P)> {
    if pl.len() < 2 { return None; }
    let mut pt_prev = pl[0];
    for i in 1..pl.len() {
        let pt = pl[i];
        let v = [pt[0] - pt_prev[0], pt[1] - pt_prev[1]];
        let l = sq_norm(v).sqrt();
        if l > distance {
            let t = distance / l;
            return Some((i - 1, t, [pt_prev[0] + t * v[0], pt_prev[1] + t * v[1]]));
        }
        distance -= l;
        pt_prev = pt;
    }
    None
}
fn clip_end_segment_and_point(pl: &[P], mut distance: f64) -> Option<(usize, f64, P)> {
    if pl.len() < 2 { return None; }
    let mut pt_next = *pl.last().unwrap();
    for i in (0..pl.len() - 1).rev() {
        let pt = pl[i];
        let v = [pt[0] - pt_next[0], pt[1] - pt_next[1]];
        let l = sq_norm(v).sqrt();
        if l > distance {
            let t = distance / l;
            return Some((i, 1.0 - t, [pt_next[0] + t * v[0], pt_next[1] + t * v[1]]));
        }
        distance -= l;
        pt_next = pt;
    }
    None
}

fn lower_bound_by(list: &[usize], g: &Graph, thr: f64) -> usize {
    let (mut lo, mut hi) = (0usize, list.len());
    while lo < hi {
        let m = (lo + hi) >> 1;
        if g.cps[list[m]].param < thr { lo = m + 1; } else { hi = m; }
    }
    lo
}

/// `Fill::connect_infill`. `boundary` = rings of the (contracted) region, contours CCW, holes CW.
/// `lines` must be in the order the line generator emitted them (index parity identifies line ends).
pub fn connect_infill(lines: Vec<Vec<P>>, boundary_src: &[Vec<P>], spacing: f64, anchor: f64, anchor_max: f64, multiline: usize) -> Vec<Vec<P>> {
    const SC: f64 = 1e6;
    let q = |p: &P| -> P { [(p[0] * SC).round(), (p[1] * SC).round()] };
    let lines_nm: Vec<Vec<P>> = lines.iter().map(|l| l.iter().map(q).collect()).collect();
    let rings_nm: Vec<Vec<P>> = boundary_src.iter().map(|r| r.iter().map(q).collect()).collect();
    let out = connect_nm(lines_nm, &rings_nm, spacing * SC, anchor * SC, anchor_max * SC, multiline);
    out.into_iter().map(|l| l.into_iter().map(|p| [p[0] / SC, p[1] / SC]).collect()).collect()
}

/// `connect_infill` in nm units (all coordinates and lengths integer-valued f64).
fn connect_nm(mut lines: Vec<Vec<P>>, boundary_src: &[Vec<P>], spacing: f64, anchor: f64, anchor_max: f64, multiline: usize) -> Vec<Vec<P>> {
    let n_lines = lines.len();
    if n_lines == 0 { return Vec::new(); }
    let anchor = anchor.min(anchor_max);
    let half_w = 0.5 * spacing;

    // ---- create_boundary_infill_graph: project the infill end points onto the boundary
    struct End { idx: usize, pt: P, contour: usize, seg: usize, t: f64 }
    let mut ends: Vec<End> = Vec::new();
    for li in 0..n_lines {
        for w in 0..2 {
            let pt = if w == 0 { lines[li][0] } else { *lines[li].last().unwrap() };
            let mut best: Option<(f64, usize, usize, f64)> = None;
            for (ci, ring) in boundary_src.iter().enumerate() {
                let n = ring.len();
                for i in 0..n {
                    let (a, b) = (ring[i], ring[(i + 1) % n]);
                    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
                    let l2 = dx * dx + dy * dy;
                    if l2 == 0.0 { continue; }
                    let t = (((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2).clamp(0.0, 1.0);
                    let d = ((pt[0] - (a[0] + t * dx)).powi(2) + (pt[1] - (a[1] + t * dy)).powi(2)).sqrt();
                    if d <= EPS && best.map_or(true, |b| d < b.0 - 1e-9) { best = Some((d, ci, i, t)); }
                }
            }
            if let Some((_, ci, i, t)) = best { ends.push(End { idx: li * 2 + w, pt, contour: ci, seg: i, t }); }
        }
    }
    ends.sort_by(|p, q| p.contour.cmp(&q.contour).then(p.seg.cmp(&q.seg)).then(p.t.partial_cmp(&q.t).unwrap()));
    let mut g = Graph { boundary: vec![Vec::new(); boundary_src.len()], params: vec![Vec::new(); boundary_src.len()], cps: vec![Cp::unconnected(); n_lines * 2] };
    let mut inter: Vec<Vec<usize>> = vec![Vec::new(); boundary_src.len()];
    let mut ei = 0usize;
    for ci in 0..boundary_src.len() {
        let src = &boundary_src[ci];
        let mut dst: Vec<P> = Vec::new();
        let mut list: Vec<usize> = Vec::new();
        let mut pfirst = NONE;
        let mut pprev = NONE;
        for ip in 0..src.len() {
            let ipt = src[ip];
            if dst.last().map_or(true, |l| *l != ipt) { dst.push(ipt); }
            while ei < ends.len() && ends[ei].contour == ci && ends[ei].seg == ip {
                let e = &ends[ei];
                let mut idx_t = 0usize;
                if ip + 1 < src.len() || e.pt != dst[0] {
                    if e.pt != *dst.last().unwrap() { dst.push(e.pt); }
                    idx_t = dst.len() - 1;
                }
                let cp = e.idx;
                g.cps[cp].contour = ci;
                g.cps[cp].pt = idx_t;
                if pprev != NONE { g.cps[pprev].next = cp; g.cps[cp].prev = pprev; } else { pfirst = cp; }
                list.push(cp);
                pprev = cp;
                ei += 1;
            }
        }
        if pfirst != NONE { g.cps[pprev].next = pfirst; g.cps[pfirst].prev = pprev; }
        let mut pr = vec![0.0; dst.len() + 1];
        for i in 1..dst.len() { pr[i] = pr[i - 1] + dist(dst[i], dst[i - 1]); }
        let last = pr.len() - 1;
        pr[last] = pr[last - 1] + dist(dst[dst.len() - 1], dst[0]);
        let clen = pr[last];
        for &cp in &list { g.cps[cp].param = pr[g.cps[cp].pt]; }
        for &cp in &list {
            if g.cps[cp].next == cp {
                g.cps[cp].not_prev = clen;
                g.cps[cp].not_next = clen;
            } else {
                let (p, n) = (g.cps[cp].prev, g.cps[cp].next);
                g.cps[cp].not_prev = dist_ccw(g.cps[p].param, g.cps[cp].param, clen);
                g.cps[cp].not_next = dist_ccw(g.cps[cp].param, g.cps[n].param, clen);
            }
        }
        g.boundary[ci] = dst;
        g.params[ci] = pr;
        inter[ci] = list;
    }

    // ---- mark_boundary_segments_touching_infill
    {
        let clip = 1.7 * spacing;
        let coll = 0.8 * spacing;
        for pl in &lines {
            let (Some(sp), Some(ep)) = (clip_start_segment_and_point(pl, clip), clip_end_segment_and_point(pl, clip)) else { continue };
            if !(sp.0 < ep.0 || (sp.0 == ep.0 && sp.1 < ep.1)) { continue; }
            for point_idx in sp.0..=ep.0 {
                let p1 = if point_idx == sp.0 { sp.2 } else { pl[point_idx] };
                let p2 = if point_idx == ep.0 { ep.2 } else { pl[point_idx + 1] };
                let rad = coll + EPS;
                let (bx0, bx1) = (p1[0].min(p2[0]) - rad, p1[0].max(p2[0]) + rad);
                let (by0, by1) = (p1[1].min(p2[1]) - rad, p1[1].max(p2[1]) + rad);
                for ci in 0..g.boundary.len() {
                    if inter[ci].is_empty() { continue; }
                    let nb = g.boundary[ci].len();
                    let clen = g.clen(ci);
                    for si in 0..nb {
                        let s1 = g.boundary[ci][si];
                        let s2 = g.boundary[ci][(si + 1) % nb];
                        if s1[0].max(s2[0]) < bx0 || s1[0].min(s2[0]) > bx1 || s1[1].max(s2[1]) < by0 || s1[1].min(s2[1]) > by1 { continue; }
                        let Some(iv) = line_rounded_thick_segment(s1, s2, p1, p2, coll) else { continue };
                        let (ps1, ps2) = (g.params[ci][si], g.params[ci][si + 1]);
                        let po1 = ps2.min(ps1 + iv.0);
                        let po2 = ps2.min(ps1 + iv.1);
                        let list = &inter[ci];
                        let (low, high);
                        if list.len() == 1 {
                            low = list[0];
                            high = list[0];
                        } else {
                            let il = lower_bound_by(list, &g, po1);
                            let ih = lower_bound_by(list, &g, po2);
                            let mut lo = if il == list.len() { list[0] } else { list[il] };
                            let hi = if ih == list.len() { list[0] } else { list[ih] };
                            if g.cps[lo].param != po1 { lo = g.cps[lo].prev; }
                            low = lo;
                            high = hi;
                        }
                        if g.cps[low].next != high {
                            let mut ip = g.cps[low].next;
                            while ip != high {
                                g.consume_prev(ip);
                                g.consume_next(ip);
                                ip = g.cps[ip].next;
                            }
                        }
                        let tl = dist_ccw(g.cps[low].param, po1, clen);
                        g.trim_next(low, tl);
                        let th = dist_ccw(po2, g.cps[high].param, clen);
                        g.trim_prev(high, th);
                    }
                }
            }
        }
    }

    // ---- connection passes
    let mut merged_with: Vec<usize> = (0..n_lines).collect();
    fn root(m: &mut [usize], i: usize) -> usize {
        let mut last = i;
        loop {
            let lower = m[last];
            if lower == last { m[i] = last; return last; }
            last = lower;
        }
    }
    #[derive(Clone)] struct Arc { cp: usize, len: f64 }
    let mut arches: Vec<Arc> = Vec::new();
    for cp in 0..g.cps.len() {
        if g.cps[cp].contour != NONE && g.cps[cp].next != cp && g.could_connect_next(cp) {
            let n = g.cps[cp].next;
            let clen = g.clen(g.cps[cp].contour);
            arches.push(Arc { cp, len: dist_ccw(g.cps[cp].param, g.cps[n].param, clen) });
        }
    }
    super::stdsort::std_sort(&mut arches, |a, b| a.len < b.len);
    for arc in &arches {
        let cp1 = arc.cp;
        let cp2 = g.cps[cp1].next;
        if g.cps[cp1].consumed || g.cps[cp2].consumed { continue; }
        let i1 = root(&mut merged_with, cp1 / 2);
        let i2 = root(&mut merged_with, cp2 / 2);
        if multiline > 1 && arc.len < spacing * multiline as f64 { continue; }
        if i1 != i2 {
            if arc.len < anchor_max {
                let cidx = g.cps[cp1].contour;
                let mut pl1 = std::mem::take(&mut lines[i1]);
                let mut pl2 = std::mem::take(&mut lines[i2]);
                if g.boundary[cidx][g.cps[cp1].pt] == pl1[0] { pl1.reverse(); }
                if g.boundary[cidx][g.cps[cp2].pt] == *pl2.last().unwrap() { pl2.reverse(); }
                take_connect(&mut g, &mut pl1, &pl2, cp1, cp2, false);
                if i2 < i1 {
                    lines[i2] = pl1;
                    merged_with[i1] = merged_with[i2];
                } else {
                    lines[i1] = pl1;
                    merged_with[i2] = merged_with[i1];
                }
            } else if anchor > EPS {
                let mut pl1 = std::mem::take(&mut lines[i1]);
                take_limited(&mut g, &mut pl1, cp1, cp2, false, anchor, half_w);
                lines[i1] = pl1;
                let mut pl2 = std::mem::take(&mut lines[i2]);
                take_limited(&mut g, &mut pl2, cp2, cp1, true, anchor, half_w);
                lines[i2] = pl2;
            }
        }
    }
    for cp in 0..g.cps.len() {
        if g.cps[cp].consumed || g.cps[cp].contour == NONE { continue; }
        let cidx = g.cps[cp].contour;
        let clen = g.clen(cidx);
        let lprev = if g.could_connect_prev(cp) { dist_ccw(g.cps[g.cps[cp].prev].param, g.cps[cp].param, clen) } else { f64::MAX };
        let lnext = if g.could_connect_next(cp) { dist_ccw(g.cps[cp].param, g.cps[g.cps[cp].next].param, clen) } else { f64::MAX };
        let pi = root(&mut merged_with, cp / 2);
        let mut connected = false;
        for l in [lprev.min(lnext), lprev.max(lnext)] {
            if l == f64::MAX || l > anchor_max { break; }
            let reversed = l == lprev;
            let cp2 = if reversed { g.cps[cp].prev } else { g.cps[cp].next };
            let pi2 = root(&mut merged_with, cp2 / 2);
            if pi == pi2 { continue; }
            let mut pl = std::mem::take(&mut lines[pi]);
            if g.boundary[cidx][g.cps[cp].pt] == pl[0] { pl.reverse(); }
            let mut pl2 = std::mem::take(&mut lines[pi2]);
            if g.boundary[cidx][g.cps[cp2].pt] == *pl2.last().unwrap() { pl2.reverse(); }
            take_connect(&mut g, &mut pl, &pl2, cp, cp2, reversed);
            if pi < pi2 {
                merged_with[pi2] = pi;
                lines[pi] = pl;
            } else {
                merged_with[pi] = pi2;
                lines[pi2] = pl;
            }
            connected = true;
            break;
        }
        if !connected && anchor > EPS {
            let (np, nn) = (g.cps[cp].not_prev, g.cps[cp].not_next);
            let l = np.max(nn);
            if l > EPS {
                let mut pl = std::mem::take(&mut lines[pi]);
                if np > nn { let p = g.cps[cp].prev; take_limited(&mut g, &mut pl, cp, p, true, anchor, half_w); }
                else { let n = g.cps[cp].next; take_limited(&mut g, &mut pl, cp, n, false, anchor, half_w); }
                lines[pi] = pl;
            }
        }
    }
    lines.into_iter().filter(|l| l.len() >= 2).collect()
}

/// `connect_infill` on integer nm coordinates (libslic3r's own types): inputs and outputs are integer-valued.
pub fn connect_nm_pub(lines: Vec<Vec<[i64; 2]>>, boundary: &[Vec<[i64; 2]>], spacing_nm: f64, anchor_nm: f64, anchor_max_nm: f64) -> Vec<Vec<[i64; 2]>> {
    let f = |p: &[i64; 2]| -> P { [p[0] as f64, p[1] as f64] };
    let l: Vec<Vec<P>> = lines.iter().map(|l| l.iter().map(f).collect()).collect();
    let b: Vec<Vec<P>> = boundary.iter().map(|r| r.iter().map(f).collect()).collect();
    let out = connect_nm(l, &b, spacing_nm, anchor_nm, anchor_max_nm, 1);
    out.into_iter().map(|l| l.into_iter().map(|p| [p[0] as i64, p[1] as i64]).collect()).collect()
}
