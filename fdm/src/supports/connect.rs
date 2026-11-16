//! Port of `Fill::connect_base_support` and the boundary/infill graph it works on
//! (Fill/FillBase.cpp). Everything here runs in Orca's integer lattice: coordinates are
//! integer-valued f64 in units of 1e-6 mm, so the thresholds (SCALED_EPSILON = 100, ...) are the
//! C++ ones. Pointers of the C++ graph are indices into `Graph::cps`.
//!
//! Input: the vertical (in the rotated frame) infill lines of FillSupportBase and the boundary
//! rings they end on; output: connected polylines, still in the rotated frame.
type P = [f64; 2];
type Pl = Vec<P>;

const SCALED_EPS: f64 = 100.0;
const NONE: usize = usize::MAX;

#[derive(Clone, Debug)]
struct Cp {
    contour: usize,
    point_idx: usize,
    param: f64,
    prev: usize,
    next: usize,
    ntp: f64, // contour_not_taken_length_prev
    ntn: f64, // contour_not_taken_length_next
    consumed: bool,
    prev_trimmed: bool,
    next_trimmed: bool,
}
impl Cp {
    fn blank() -> Cp {
        Cp { contour: NONE, point_idx: NONE, param: 0.0, prev: NONE, next: NONE, ntp: f64::MAX, ntn: f64::MAX, consumed: false, prev_trimmed: false, next_trimmed: false }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dir { Left, Right, Up, Down, Taken }

struct Graph {
    boundary: Vec<Vec<P>>,
    params: Vec<Vec<f64>>,
    cps: Vec<Cp>,
}

fn dist(a: P, b: P) -> f64 { ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt() }
fn lerp_i(a: P, b: P, t: f64) -> P {
    // Point lerp(Point, Point, t) -> coord_t (truncating cast)
    [(a[0] + (b[0] - a[0]) * t).trunc(), (a[1] + (b[1] - a[1]) * t).trunc()]
}
fn ccw_dist(p1: f64, p2: f64, len: f64) -> f64 { let d = p2 - p1; if d < 0.0 { d + len } else { d } }
fn cw_dist(p1: f64, p2: f64, len: f64) -> f64 { ccw_dist(p2, p1, len) }

impl Graph {
    fn pt(&self, i: usize) -> P { self.boundary[self.cps[i].contour][self.cps[i].point_idx] }
    fn first(&self, i: usize) -> bool { i & 1 == 0 }
    fn other(&self, i: usize) -> usize { i ^ 1 }
    fn could_take_prev(&self, i: usize) -> bool { !self.cps[i].consumed && self.cps[i].ntp > SCALED_EPS }
    fn could_take_next(&self, i: usize) -> bool { !self.cps[i].consumed && self.cps[i].ntn > SCALED_EPS }
    fn trim_prev(&mut self, i: usize, len: f64) { let c = &mut self.cps[i]; if len < c.ntp { c.ntp = len; c.prev_trimmed = true; } }
    fn trim_next(&mut self, i: usize, len: f64) { let c = &mut self.cps[i]; if len < c.ntn { c.ntn = len; c.next_trimmed = true; } }
    fn consume_prev(&mut self, i: usize) { let c = &mut self.cps[i]; c.ntp = 0.0; c.prev_trimmed = true; c.consumed = true; }
    fn consume_next(&mut self, i: usize) { let c = &mut self.cps[i]; c.ntn = 0.0; c.next_trimmed = true; c.consumed = true; }
    fn dir(p1: P, p2: P) -> Dir {
        if p1[0] == p2[0] { if p1[1] < p2[1] { Dir::Up } else { Dir::Down } }
        else if p1[0] < p2[0] { Dir::Right } else { Dir::Left }
    }
    fn dir_prev(&self, i: usize) -> Dir { if self.could_take_prev(i) { Self::dir(self.pt(i), self.pt(self.cps[i].prev)) } else { Dir::Taken } }
    fn dir_next(&self, i: usize) -> Dir { if self.could_take_next(i) { Self::dir(self.pt(i), self.pt(self.cps[i].next)) } else { Dir::Taken } }
    fn prev_vertical(&self, i: usize) -> bool { self.pt(i)[0] == self.pt(self.cps[i].prev)[0] }
    fn next_vertical(&self, i: usize) -> bool { self.pt(i)[0] == self.pt(self.cps[i].next)[0] }
}

fn take_cw_full(pl: &mut Pl, contour: &[P], idx_start: usize, idx_end: usize) {
    let n = contour.len();
    let mut i = if idx_start == 0 { n - 1 } else { idx_start - 1 };
    while i != idx_end {
        pl.push(contour[i]);
        i = if i == 0 { n - 1 } else { i - 1 };
    }
    pl.push(contour[i]);
}
fn take_ccw_full(pl: &mut Pl, contour: &[P], idx_start: usize, idx_end: usize) {
    let n = contour.len();
    let mut i = idx_start + 1;
    if i == n { i = 0; }
    while i != idx_end {
        pl.push(contour[i]);
        i += 1;
        if i == n { i = 0; }
    }
    pl.push(contour[i]);
}
fn take_cw_limited(pl: &mut Pl, contour: &[P], params: &[f64], idx_start: usize, idx_end: usize, length_to_take: f64) -> f64 {
    let n = contour.len();
    let length = *params.last().unwrap();
    let p0 = params[idx_start];
    let mut i = if idx_start == 0 { n - 1 } else { idx_start - 1 };
    let mut iprev = idx_start;
    let mut lprev = 0.0;
    loop {
        let l = cw_dist(p0, params[i], length);
        if l >= length_to_take {
            let t = (length_to_take - lprev) / (l - lprev);
            pl.push(lerp_i(contour[iprev], contour[i], t));
            return length_to_take;
        }
        pl.push(contour[i]);
        if i == idx_end { return l; }
        iprev = i;
        lprev = l;
        i = if i == 0 { n - 1 } else { i - 1 };
    }
}
fn take_ccw_limited(pl: &mut Pl, contour: &[P], params: &[f64], idx_start: usize, idx_end: usize, length_to_take: f64) -> f64 {
    let n = contour.len();
    let length = *params.last().unwrap();
    let p0 = params[idx_start];
    let mut i = idx_start + 1;
    if i == n { i = 0; }
    let mut iprev = idx_start;
    let mut lprev = 0.0;
    loop {
        let l = ccw_dist(p0, params[i], length);
        if l >= length_to_take {
            let t = (length_to_take - lprev) / (l - lprev);
            pl.push(lerp_i(contour[iprev], contour[i], t));
            return length_to_take;
        }
        pl.push(contour[i]);
        if i == idx_end { return l; }
        iprev = i;
        lprev = l;
        i += 1;
        if i == n { i = 0; }
    }
}

fn pl_length(p: &Pl) -> f64 { p.windows(2).map(|w| dist(w[0], w[1])).sum() }
fn pl_clip_end(pl: &mut Pl, mut len: f64) {
    while len > 0.0 && pl.len() >= 2 {
        let n = pl.len();
        let (a, b) = (pl[n - 2], pl[n - 1]);
        let l = dist(a, b);
        if l <= len { len -= l; pl.pop(); } else {
            let t = (l - len) / l;
            pl[n - 1] = lerp_i(a, b, t);
            return;
        }
    }
}
fn pl_clip_start(pl: &mut Pl, mut len: f64) {
    pl.reverse();
    pl_clip_end(pl, len);
    pl.reverse();
    len = 0.0; let _ = len;
}

// ---------- thick segment collision ----------
fn ray_circle_interval(center: P, r2: f64, line_pt: P, line_vec: P) -> Option<(f64, f64)> {
    // solve |line_pt + t*v - center|^2 = r2 for t
    let p0 = [line_pt[0] - center[0], line_pt[1] - center[1]];
    let a = line_vec[0] * line_vec[0] + line_vec[1] * line_vec[1];
    let b = 2.0 * (p0[0] * line_vec[0] + p0[1] * line_vec[1]);
    let c = p0[0] * p0[0] + p0[1] * p0[1] - r2;
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 { return None; }
    let sq = disc.sqrt();
    let mut t0 = (-b - sq) / (2.0 * a);
    let mut t1 = (-b + sq) / (2.0 * a);
    if t0 > t1 { std::mem::swap(&mut t0, &mut t1); }
    let t0 = t0.max(0.0);
    let t1 = t1.min(1.0);
    if t0 <= t1 { Some((t0, t1)) } else { None }
}
fn liang_barsky(x0: P, v: P, bmin: P, bmax: P) -> Option<(f64, f64)> {
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let mut clip = |p: f64, q: f64| -> bool {
        if p == 0.0 { if q < 0.0 { return false; } }
        else {
            let r = q / p;
            if p < 0.0 { if r > t1 { return false; } if r > t0 { t0 = r; } }
            else { if r < t0 { return false; } if r < t1 { t1 = r; } }
        }
        true
    };
    if clip(-v[0], -bmin[0] + x0[0]) && clip(v[0], bmax[0] - x0[0]) && clip(-v[1], -bmin[1] + x0[1]) && clip(v[1], bmax[1] - x0[1]) {
        Some((t0, t1))
    } else { None }
}
/// `line_rounded_thick_segment_collision`: interval (Euclidean length along the line) of the part of
/// line a-b that is closer than `offset` to the segment sa-sb.
fn thick_segment_collision(la: P, lb: P, sa: P, sb: P, offset: f64) -> Option<(f64, f64)> {
    let lv0 = [lb[0] - la[0], lb[1] - la[1]];
    let lv = lv0[0] * lv0[0] + lv0[1] * lv0[1];
    let sv = [sb[0] - sa[0], sb[1] - sa[1]];
    let sl = (sv[0] * sv[0] + sv[1] * sv[1]).sqrt();
    let offset2 = offset * offset;
    if lv < SCALED_EPS * SCALED_EPS {
        let lpt = [0.5 * (la[0] + lb[0]), 0.5 * (la[1] + lb[1])];
        let inter = if sl > SCALED_EPS {
            let t = (((lpt[0] - sa[0]) * sv[0] + (lpt[1] - sa[1]) * sv[1]) / (sl * sl)).clamp(0.0, 1.0);
            let d = [sa[0] + t * sv[0] - lpt[0], sa[1] + t * sv[1] - lpt[1]];
            d[0] * d[0] + d[1] * d[1] < offset2
        } else {
            let m = [0.5 * (sa[0] + sb[0]) - lpt[0], 0.5 * (sa[1] + sb[1]) - lpt[1]];
            m[0] * m[0] + m[1] * m[1] < offset2
        };
        return if inter { Some((0.0, lv.sqrt())) } else { None };
    }
    let mut tmin = f64::MAX;
    let mut tmax = -f64::MAX;
    let mut ext = |a: f64, b: f64| { tmin = tmin.min(a); tmax = tmax.max(b); };
    if sl > SCALED_EPS {
        if let Some((a, b)) = ray_circle_interval(sa, offset2, la, lv0) { ext(a, b); }
        if let Some((a, b)) = ray_circle_interval(sb, offset2, la, lv0) { ext(a, b); }
        let dx = [sv[0] / sl, sv[1] / sl];
        let dy = [-dx[1], dx[0]];
        let lp0 = [la[0] - sa[0], la[1] - sa[1]];
        let x0 = [lp0[0] * dx[0] + lp0[1] * dx[1], lp0[0] * dy[0] + lp0[1] * dy[1]];
        let v = [lv0[0] * dx[0] + lv0[1] * dx[1], lv0[0] * dy[0] + lv0[1] * dy[1]];
        if let Some((a, b)) = liang_barsky(x0, v, [0.0, -offset], [sl, offset]) { ext(a, b); }
    } else if let Some((a, b)) = ray_circle_interval([0.5 * (sa[0] + sb[0]), 0.5 * (sa[1] + sb[1])], offset2, la, lv0) {
        ext(a, b);
    }
    if tmin <= tmax { let l = lv.sqrt(); Some((tmin * l, tmax * l)) } else { None }
}

// ---------- graph creation ----------
pub struct LineIn {
    pub a: P,
    pub b: P,
    /// (contour index, edge index (start point index), t along edge) of each end
    pub ea: (usize, usize, f64),
    pub eb: (usize, usize, f64),
}

fn create_graph(lines: &[LineIn], rings: &[Vec<P>], spacing: f64) -> Graph {
    let mut g = Graph { boundary: vec![Vec::new(); rings.len()], params: vec![Vec::new(); rings.len()], cps: vec![Cp::blank(); lines.len() * 2] };
    // collect intersection points: (contour, start_point_idx, t, cp_index)
    let mut ips: Vec<(usize, usize, f64, usize)> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        ips.push((l.ea.0, l.ea.1, l.ea.2, i * 2));
        ips.push((l.eb.0, l.eb.1, l.eb.2, i * 2 + 1));
    }
    ips.sort_by(|x, y| x.0.cmp(&y.0).then(x.1.cmp(&y.1)).then(x.2.partial_cmp(&y.2).unwrap()).then(x.3.cmp(&y.3)));
    let mut it = 0usize;
    let mut boundary_ips: Vec<Vec<usize>> = vec![Vec::new(); rings.len()];
    for ci in 0..rings.len() {
        let src = &rings[ci];
        let dst = &mut g.boundary[ci];
        let mut pfirst = NONE;
        let mut pprev = NONE;
        for idx_point in 0..src.len() {
            let ipt = src[idx_point];
            if dst.is_empty() || *dst.last().unwrap() != ipt { dst.push(ipt); }
            while it < ips.len() && ips[it].0 == ci && ips[it].1 == idx_point {
                let cpi = ips[it].3;
                let l = &lines[cpi / 2];
                let pt = if cpi & 1 == 1 { l.b } else { l.a };
                let mut idx_tjoint = 0usize;
                if idx_point + 1 < src.len() || pt != dst[0] {
                    if pt != *dst.last().unwrap() { dst.push(pt); }
                    idx_tjoint = dst.len() - 1;
                }
                g.cps[cpi] = Cp { contour: ci, point_idx: idx_tjoint, ..Cp::blank() };
                if pprev != NONE { g.cps[pprev].next = cpi; g.cps[cpi].prev = pprev; } else { pfirst = cpi; }
                boundary_ips[ci].push(cpi);
                pprev = cpi;
                it += 1;
            }
        }
        if pfirst != NONE { g.cps[pprev].next = pfirst; g.cps[pfirst].prev = pprev; }
        // parametrise
        let dst = &g.boundary[ci];
        let mut params = vec![0.0f64; dst.len() + 1];
        for i in 1..dst.len() { params[i] = params[i - 1] + dist(dst[i], dst[i - 1]); }
        let n = dst.len();
        params[n] = params[n - 1] + dist(dst[n - 1], dst[0]);
        let clen = params[n];
        for &cpi in &boundary_ips[ci] { g.cps[cpi].param = params[g.cps[cpi].point_idx]; }
        for &cpi in &boundary_ips[ci] {
            if g.cps[cpi].next == cpi {
                g.cps[cpi].ntp = clen; g.cps[cpi].ntn = clen;
            } else {
                let (pv, nx) = (g.cps[cpi].prev, g.cps[cpi].next);
                g.cps[cpi].ntp = ccw_dist(g.cps[pv].param, g.cps[cpi].param, clen);
                g.cps[cpi].ntn = ccw_dist(g.cps[cpi].param, g.cps[nx].param, clen);
            }
        }
        g.params[ci] = params;
    }
    // mark boundary segments touching infill
    let clip_distance = 1.7 * spacing;
    let distance_colliding = 0.8 * spacing;
    mark_boundary_segments_touching_infill(&mut g, &boundary_ips, lines, clip_distance, distance_colliding);
    g
}

/// returns (idx_segment, t, point) of the point at `distance` from the start/end, None if the polyline is shorter
fn clip_start_seg(p: &[P], mut distance: f64) -> Option<(usize, f64, P)> {
    let mut prev = p[0];
    for i in 1..p.len() {
        let pt = p[i];
        let v = [pt[0] - prev[0], pt[1] - prev[1]];
        let l = (v[0] * v[0] + v[1] * v[1]).sqrt();
        if l > distance {
            let t = distance / l;
            return Some((i - 1, t, [prev[0] + t * v[0], prev[1] + t * v[1]]));
        }
        distance -= l;
        prev = pt;
    }
    None
}
fn clip_end_seg(p: &[P], mut distance: f64) -> Option<(usize, f64, P)> {
    let mut next = *p.last().unwrap();
    for i in (0..p.len() - 1).rev() {
        let pt = p[i];
        let v = [pt[0] - next[0], pt[1] - next[1]];
        let l = (v[0] * v[0] + v[1] * v[1]).sqrt();
        if l > distance {
            let t = distance / l;
            return Some((i, 1.0 - t, [next[0] + t * v[0], next[1] + t * v[1]]));
        }
        distance -= l;
        next = pt;
    }
    None
}

fn mark_boundary_segments_touching_infill(g: &mut Graph, bips: &[Vec<usize>], lines: &[LineIn], clip_distance: f64, radius: f64) {
    for l in lines {
        let pl = [l.a, l.b];
        let (Some(sp), Some(ep)) = (clip_start_seg(&pl, clip_distance), clip_end_seg(&pl, clip_distance)) else { continue };
        if !(sp.0 < ep.0 || (sp.0 == ep.0 && sp.1 < ep.1)) { continue; }
        for point_idx in sp.0..=ep.0 {
            let pt1 = if point_idx == sp.0 { sp.2 } else { pl[point_idx] };
            let pt2 = if point_idx == ep.0 { ep.2 } else { pl[point_idx + 1] };
            let bb = (pt1[0].min(pt2[0]) - radius - SCALED_EPS, pt1[1].min(pt2[1]) - radius - SCALED_EPS, pt1[0].max(pt2[0]) + radius + SCALED_EPS, pt1[1].max(pt2[1]) + radius + SCALED_EPS);
            for ci in 0..g.boundary.len() {
                if bips[ci].is_empty() { continue; }
                let n = g.boundary[ci].len();
                for si in 0..n {
                    let s1 = g.boundary[ci][si];
                    let s2 = g.boundary[ci][(si + 1) % n];
                    // bbox overlap test
                    if s1[0].max(s2[0]) < bb.0 || s1[0].min(s2[0]) > bb.2 || s1[1].max(s2[1]) < bb.1 || s1[1].min(s2[1]) > bb.3 { continue; }
                    let Some((i0, i1)) = thick_segment_collision(s1, s2, pt1, pt2, radius) else { continue };
                    let clen = *g.params[ci].last().unwrap();
                    let p1 = g.params[ci][si];
                    let p2 = g.params[ci][si + 1];
                    let po1 = p2.min(p1 + i0);
                    let po2 = p2.min(p1 + i1);
                    let ints = &bips[ci];
                    let (ip_low, ip_high);
                    if ints.len() == 1 { ip_low = ints[0]; ip_high = ints[0]; }
                    else {
                        let lo = ints.partition_point(|&c| g.cps[c].param < po1);
                        let hi = ints.partition_point(|&c| g.cps[c].param < po2);
                        let mut a = if lo == ints.len() { ints[0] } else { ints[lo] };
                        let b = if hi == ints.len() { ints[0] } else { ints[hi] };
                        if g.cps[a].param != po1 { a = g.cps[a].prev; }
                        ip_low = a; ip_high = b;
                    }
                    if g.cps[ip_low].next != ip_high {
                        let mut ip = g.cps[ip_low].next;
                        let mut guard = 0;
                        while ip != ip_high && guard < 100000 {
                            g.consume_prev(ip); g.consume_next(ip);
                            ip = g.cps[ip].next; guard += 1;
                        }
                    }
                    let tl = ccw_dist(g.cps[ip_low].param, po1, clen);
                    g.trim_next(ip_low, tl);
                    let tl = ccw_dist(po2, g.cps[ip_high].param, clen);
                    g.trim_prev(ip_high, tl);
                }
            }
        }
    }
}

fn mark_boundary_segments_overlapping_infill(g: &mut Graph, lines: &[LineIn], spacing: f64) {
    for ci in 0..g.cps.len() {
        if g.cps[ci].contour == NONE { continue; }
        let contour = g.boundary[g.cps[ci].contour].clone();
        let params = g.params[g.cps[ci].contour].clone();
        let l = &lines[ci / 2];
        let radius = 0.5 * (spacing + SCALED_EPS);
        let (la, lb) = (l.a, l.b);
        let n = contour.len();
        let dist2_line = |p: P| -> f64 {
            let v = [lb[0] - la[0], lb[1] - la[1]];
            let l2 = v[0] * v[0] + v[1] * v[1];
            let t = if l2 == 0.0 { 0.0 } else { (((p[0] - la[0]) * v[0] + (p[1] - la[1]) * v[1]) / l2).clamp(0.0, 1.0) };
            let d = [la[0] + t * v[0] - p[0], la[1] + t * v[1] - p[1]];
            d[0] * d[0] + d[1] * d[1]
        };
        let clen = *params.last().unwrap();
        if g.could_take_next(ci) {
            let mut inside = true;
            let nxt = g.cps[ci].next;
            let target = g.cps[nxt].point_idx;
            let mut i = g.cps[ci].point_idx;
            let mut guard = 0;
            while i != target && guard < n + 2 {
                let j = (i + 1) % n;
                let seg2 = contour[j];
                if dist2_line(seg2) < radius * radius { /* completely inside */ }
                else {
                    if let Some((_, i1)) = thick_segment_collision(contour[i], seg2, la, lb, radius) {
                        let len_out = ccw_dist(params[g.cps[ci].point_idx], params[i], clen) + i1;
                        if len_out < g.cps[ci].ntn { inside = false; break; }
                    } else {
                        // no collision at all: leaves the region immediately
                        let len_out = ccw_dist(params[g.cps[ci].point_idx], params[i], clen);
                        if len_out < g.cps[ci].ntn { inside = false; break; }
                    }
                }
                if ccw_dist(params[g.cps[ci].point_idx], params[j], clen) >= g.cps[ci].ntn { break; }
                i = j; guard += 1;
            }
            if inside {
                if !g.cps[ci].next_trimmed { g.trim_prev(nxt, 0.0); }
                g.trim_next(ci, 0.0);
            }
        } else { g.trim_next(ci, 0.0); }
        if g.could_take_prev(ci) {
            let mut inside = true;
            let pv = g.cps[ci].prev;
            let target = g.cps[pv].point_idx;
            let mut i = g.cps[ci].point_idx;
            let mut guard = 0;
            while i != target && guard < n + 2 {
                let j = if i == 0 { n - 1 } else { i - 1 };
                let seg2 = contour[j];
                if dist2_line(seg2) < radius * radius { }
                else {
                    if let Some((_, i1)) = thick_segment_collision(contour[i], seg2, la, lb, radius) {
                        let len_out = cw_dist(params[g.cps[ci].point_idx], params[i], clen) + i1;
                        if len_out < g.cps[ci].ntp { inside = false; break; }
                    } else {
                        let len_out = cw_dist(params[g.cps[ci].point_idx], params[i], clen);
                        if len_out < g.cps[ci].ntp { inside = false; break; }
                    }
                }
                if cw_dist(params[g.cps[ci].point_idx], params[j], clen) >= g.cps[ci].ntp { break; }
                i = j; guard += 1;
            }
            if inside {
                if !g.cps[ci].prev_trimmed { g.trim_next(pv, 0.0); }
                g.trim_prev(ci, 0.0);
            }
        } else { g.trim_prev(ci, 0.0); }
    }
}

// ---------- emit loops in a vertical band ----------
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side { Left, Right, Mid, Unknown }
#[derive(Clone, Copy, PartialEq, Eq)]
enum InOut { Entering, Leaving }

struct BandState<'a> {
    left: f64,
    right: f64,
    min_length: f64,
    out: &'a mut Vec<Pl>,
    polyline: Pl,
    polyline_end: usize,
    side1: Side,
}
impl<'a> BandState<'a> {
    fn add_inner(&mut self, p: P) { self.polyline.push(p); }
    fn add_outer(&mut self, p: P) { if self.polyline_end > 0 { self.polyline.push(p); } }
    fn add_interp(&mut self, p1: P, p2: P, side: Side, inout: InOut) {
        let x = if side == Side::Left { self.left } else { self.right };
        let y = (p1[1] + (x - p1[0]) * (p2[1] - p1[1]) / (p2[0] - p1[0])).trunc();
        if inout == InOut::Leaving {
            self.polyline_end = self.polyline.len();
            self.polyline.push([x, y]);
        } else if self.polyline_end > 0 {
            if (self.side1 == Side::Left) == (y - self.polyline[self.polyline_end][1] < 0.0) {
                self.polyline.remove(self.polyline_end);
            } else {
                self.finalize();
                self.polyline.push([x, y]);
            }
            self.polyline_end = 0;
        } else {
            self.polyline.push([x, y]);
        }
    }
    fn finalize(&mut self) {
        if self.polyline_end <= self.polyline.len() { self.polyline.truncate(self.polyline_end); }
        if !self.polyline.is_empty() {
            let pts = std::mem::take(&mut self.polyline);
            if let Some(last) = self.out.last_mut() {
                let b = *last.last().unwrap();
                let f = pts[0];
                let d2 = (b[0] - f[0]).powi(2) + (b[1] - f[1]).powi(2);
                if d2 < SCALED_EPS {
                    last.extend(pts.into_iter().skip(1));
                    return;
                }
            }
            if pl_length(&pts) > self.min_length { self.out.push(pts); }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_loops_in_band(left: f64, right: f64, contour: &[P], params: &[f64], tbegin: f64, tend: f64, min_length: f64, out: &mut Vec<Pl>) {
    let n = contour.len();
    if n < 3 { return; }
    let lo = |t: f64| params.partition_point(|&p| p < t);
    let mut ibegin = lo(tbegin);
    let mut iend = lo(tend);
    if ibegin >= params.len() || iend >= params.len() { return; }
    if params[ibegin] != tbegin { if ibegin == 0 { return; } ibegin -= 1; }
    if ibegin == n { ibegin = 0; }
    if iend == n { iend = 0; }
    if ibegin == iend { return; }
    let next_i = |i: usize| (i + 1) % n;
    let prev_i = |i: usize| (i + n - 1) % n;
    let t1 = params[ibegin];
    let t2 = params[next_i(ibegin)];
    let pbegin = lerp_i(contour[ibegin], contour[next_i(ibegin)], (tbegin - t1) / (t2 - t1));
    let t1e = params[iend];
    let t2e = params[prev_i(iend)];
    let pend = lerp_i(contour[iend], contour[prev_i(iend)], (tend - t1e) / (t2e - t1e));
    let mut state = BandState { left, right, min_length, out, polyline: Vec::new(), polyline_end: 0, side1: Side::Unknown };
    let side = |p: P| if p[0] < left { Side::Left } else if p[0] > right { Side::Right } else { Side::Mid };
    let mut p1 = pbegin;
    state.side1 = side(p1);
    if state.side1 == Side::Mid { state.add_inner(p1); }
    let mut i = ibegin;
    let mut guard = 0;
    while i != iend && guard < 4 * n {
        let inext = next_i(i);
        let p2 = if inext == iend { pend } else { contour[inext] };
        let side2 = side(p2);
        if state.side1 == Side::Mid {
            if side2 == Side::Mid { state.add_inner(p2); }
            else { state.add_interp(p1, p2, side2, InOut::Leaving); state.add_outer(p2); }
        } else if side2 == Side::Mid {
            let s1 = state.side1;
            state.add_interp(p1, p2, s1, InOut::Entering);
            state.add_inner(p2);
        } else if state.side1 != side2 {
            let s1 = state.side1;
            state.add_interp(p1, p2, s1, InOut::Entering);
            state.add_interp(p1, p2, side2, InOut::Leaving);
        } else {
            state.add_outer(p2);
        }
        state.side1 = side2;
        p1 = p2;
        i = inext;
        guard += 1;
    }
    state.finalize();
}

// ---------- the connect_base_support driver ----------
#[derive(Clone, Copy, Default)]
struct ArcCost { self_loop: bool, open: bool, cost: f64 }

fn evaluate_arch_cost(pl: &Pl) -> f64 {
    let front = pl[0];
    let back = *pl.last().unwrap();
    let (mut ymin, mut ymax) = (front[1], back[1]);
    if ymin > ymax { std::mem::swap(&mut ymin, &mut ymax); }
    let mut dmax = 0.0f64;
    let v = [back[0] - front[0], back[1] - front[1]];
    let l2 = v[0] * v[0] + v[1] * v[1];
    for pt in pl {
        let d = if l2 == 0.0 { dist(*pt, front) } else {
            let t = (((pt[0] - front[0]) * v[0] + (pt[1] - front[1]) * v[1]) / l2).clamp(0.0, 1.0);
            dist(*pt, [front[0] + t * v[0], front[1] + t * v[1]])
        };
        dmax = dmax.max(d).max((pt[1] - ymax).max(ymin - pt[1]));
    }
    dmax
}

struct Ctx<'a> {
    g: Graph,
    infill: Vec<Pl>,
    merged: Vec<usize>,
    out: &'a mut Vec<Pl>,
    line_half_width: f64,
    trim_length: f64,
}
impl<'a> Ctx<'a> {
    fn gam(&mut self, cp: usize) -> usize { self.gam_idx(cp / 2) }
    fn gam_idx(&mut self, polyline_idx: usize) -> usize {
        let mut last = polyline_idx;
        loop {
            let lower = self.merged[last];
            if lower == last { self.merged[polyline_idx] = last; return last; }
            last = lower;
        }
    }

    fn take(&mut self, pl1_idx: usize, pl2_idx: usize, cp_start: usize, cp_end: usize, clockwise: bool) {
        let ci = self.g.cps[cp_start].contour;
        let (s_idx, e_idx) = (self.g.cps[cp_start].point_idx, self.g.cps[cp_end].point_idx);
        let contour = &self.g.boundary[ci];
        let pl2 = self.infill[pl2_idx].clone();
        let pl1 = &mut self.infill[pl1_idx];
        if clockwise { take_cw_full(pl1, contour, s_idx, e_idx); } else { take_ccw_full(pl1, contour, s_idx, e_idx); }
        pl1.extend(pl2.into_iter().skip(1));
        let (mut a, mut b) = (cp_start, cp_end);
        if clockwise { std::mem::swap(&mut a, &mut b); }
        if self.g.cps[a].next != b {
            let mut cp = self.g.cps[a].next;
            let mut guard = 0;
            while self.g.cps[cp].next != b && guard < 100000 {
                self.g.consume_prev(cp); self.g.consume_next(cp);
                cp = self.g.cps[cp].next; guard += 1;
            }
        }
        self.g.consume_next(a);
        self.g.consume_prev(b);
    }

    fn take_limited(&mut self, pl_idx: usize, cp_start: usize, cp_end: usize, clockwise: bool, take_max_length: f64) {
        let lhw = self.line_half_width;
        if !(if clockwise { self.g.could_take_prev(cp_start) } else { self.g.could_take_next(cp_start) }) { return; }
        let ci = self.g.cps[cp_start].contour;
        let contour = self.g.boundary[ci].clone();
        let params = self.g.params[ci].clone();
        let sp = contour[self.g.cps[cp_start].point_idx];
        let add_at_start = self.infill[pl_idx].first() == Some(&sp);
        let mut pl_tmp: Pl = Vec::new();
        if add_at_start { pl_tmp = std::mem::take(&mut self.infill[pl_idx]); }
        let mut pl1: Pl = if add_at_start { Vec::new() } else { std::mem::take(&mut self.infill[pl_idx]) };
        let length = *params.last().unwrap();
        let mut length_to_go = take_max_length;
        self.g.cps[cp_start].consumed = true;
        if cp_start == cp_end {
            length_to_go = 0.0f64.max(length_to_go.min(length - lhw));
            length_to_go = length_to_go.min(if clockwise { self.g.cps[cp_start].ntp } else { self.g.cps[cp_start].ntn });
            self.g.consume_prev(cp_start);
            self.g.consume_next(cp_start);
            if length_to_go > SCALED_EPS {
                let pi = self.g.cps[cp_start].point_idx;
                if clockwise { take_cw_limited(&mut pl1, &contour, &params, pi, pi, length_to_go); }
                else { take_ccw_limited(&mut pl1, &contour, &params, pi, pi, length_to_go); }
            }
        } else if clockwise {
            let mut cp = cp_start;
            let mut guard = 0;
            while cp != cp_end && guard < 100000 {
                let pv = self.g.cps[cp].prev;
                let l = cw_dist(self.g.cps[cp].param, self.g.cps[pv].param, length);
                length_to_go = length_to_go.min(self.g.cps[cp].ntp);
                length_to_go = 0.0f64.max(length_to_go.min(l - lhw));
                self.g.consume_prev(cp);
                if l >= length_to_go {
                    if length_to_go > SCALED_EPS {
                        self.g.trim_next(pv, l - length_to_go);
                        take_cw_limited(&mut pl1, &contour, &params, self.g.cps[cp].point_idx, self.g.cps[pv].point_idx, length_to_go);
                    }
                    break;
                } else {
                    self.g.trim_next(pv, 0.0);
                    take_cw_full(&mut pl1, &contour, self.g.cps[cp].point_idx, self.g.cps[pv].point_idx);
                    length_to_go -= l;
                }
                cp = pv; guard += 1;
            }
        } else {
            let mut cp = cp_start;
            let mut guard = 0;
            while cp != cp_end && guard < 100000 {
                let nx = self.g.cps[cp].next;
                let l = ccw_dist(self.g.cps[cp].param, self.g.cps[nx].param, length);
                length_to_go = length_to_go.min(self.g.cps[cp].ntn);
                length_to_go = 0.0f64.max(length_to_go.min(l - lhw));
                self.g.consume_next(cp);
                if l >= length_to_go {
                    if length_to_go > SCALED_EPS {
                        self.g.trim_prev(nx, l - length_to_go);
                        take_ccw_limited(&mut pl1, &contour, &params, self.g.cps[cp].point_idx, self.g.cps[nx].point_idx, length_to_go);
                    }
                    break;
                } else {
                    self.g.trim_prev(nx, 0.0);
                    take_ccw_full(&mut pl1, &contour, self.g.cps[cp].point_idx, self.g.cps[nx].point_idx);
                    length_to_go -= l;
                }
                cp = nx; guard += 1;
            }
        }
        if add_at_start { pl1.reverse(); pl1.extend(pl_tmp); }
        self.infill[pl_idx] = pl1;
    }

    /// Connect infill lines at cp and cp.next (see C++ `take_next` lambda).
    fn take_next(&mut self, cp: usize, take_first: bool) {
        let cp1 = cp;
        let cp2 = self.g.cps[cp].next;
        if if take_first { self.g.cps[cp1].consumed } else { self.g.cps[cp2].consumed } { return; }
        let pi1 = self.gam(cp1);
        let pi2 = self.gam(cp2);
        let ci = self.g.cps[cp1].contour;
        let clen = *self.g.params[ci].last().unwrap();
        let mut trimmed = if take_first { self.g.cps[cp1].next_trimmed } else { self.g.cps[cp2].prev_trimmed };
        if !trimmed {
            trimmed = cp1 == cp2 || pi1 == pi2 || (if take_first { self.g.cps[cp2].consumed } else { self.g.cps[cp1].consumed });
            if !trimmed {
                let cp1_first = cp1 & 1 == 0;
                let cp1_other = if cp1_first { cp1 + 1 } else { cp1 - 1 };
                trimmed = cp2 == cp1_other;
            }
            if trimmed {
                let len = if cp1 == cp2 { clen } else { ccw_dist(self.g.cps[cp1].param, self.g.cps[cp2].param, clen) };
                if take_first {
                    self.g.trim_next(cp1, 0.0f64.max(len - self.trim_length - SCALED_EPS));
                    self.g.trim_prev(cp2, 0.0);
                } else {
                    self.g.trim_next(cp1, 0.0);
                    self.g.trim_prev(cp2, 0.0f64.max(len - self.trim_length - SCALED_EPS));
                }
            }
        }
        let lhw = self.line_half_width;
        if trimmed {
            if take_first { self.take_limited(pi1, cp1, cp2, false, 1e10); }
            else { self.take_limited(pi2, cp2, cp1, true, 1e10); }
            let _ = lhw;
        } else if !self.g.cps[cp1].consumed && !self.g.cps[cp2].consumed {
            let contour = &self.g.boundary[ci];
            let p1pt = contour[self.g.cps[cp1].point_idx];
            let p2pt = contour[self.g.cps[cp2].point_idx];
            if self.infill[pi1].first() == Some(&p1pt) { self.infill[pi1].reverse(); }
            if self.infill[pi2].last() == Some(&p2pt) { self.infill[pi2].reverse(); }
            self.take(pi1, pi2, cp1, cp2, false);
            if pi2 < pi1 {
                let moved = std::mem::take(&mut self.infill[pi1]);
                self.infill[pi2] = moved;
                self.merged[pi1] = self.merged[pi2];
            } else {
                self.infill[pi2].clear();
                self.merged[pi2] = self.merged[pi1];
            }
        }
    }
}

fn evaluate_support_arches(g: &Graph) -> Vec<ArcCost> {
    let mut arches = vec![ArcCost::default(); g.cps.len() * 2];
    for i in 0..g.cps.len() {
        let cp = &g.cps[i];
        if cp.contour == NONE { continue; }
        let first = i & 1 == 0;
        let other = if first { i + 1 } else { i - 1 };
        let ci = cp.contour;
        {
            let o = &mut arches[i * 2];
            o.self_loop = cp.prev == other;
            o.open = cp.prev_trimmed;
        }
        {
            let o = &mut arches[i * 2 + 1];
            o.self_loop = cp.next == other;
            o.open = cp.next_trimmed;
        }
        if cp.ntn > SCALED_EPS {
            let mut pl: Pl = vec![g.pt(i)];
            if cp.next_trimmed { take_ccw_limited(&mut pl, &g.boundary[ci], &g.params[ci], cp.point_idx, g.cps[cp.next].point_idx, cp.ntn); }
            else { take_ccw_full(&mut pl, &g.boundary[ci], cp.point_idx, g.cps[cp.next].point_idx); }
            arches[i * 2 + 1].cost = evaluate_arch_cost(&pl);
        }
        if cp.ntp > SCALED_EPS {
            let mut pl: Pl = vec![g.pt(i)];
            if cp.prev_trimmed { take_cw_limited(&mut pl, &g.boundary[ci], &g.params[ci], cp.point_idx, g.cps[cp.prev].point_idx, cp.ntp); }
            else { take_cw_full(&mut pl, &g.boundary[ci], cp.point_idx, g.cps[cp.prev].point_idx); }
            arches[i * 2].cost = evaluate_arch_cost(&pl);
        }
    }
    arches
}

fn base_support_extend_infill_lines(infill: &mut [Pl], g: &mut Graph, spacing: f64, density: f64) {
    let line_spacing = spacing / density;
    let dist_max_x = (line_spacing * 0.33).trunc();
    let dist_min_y = (line_spacing * 0.5).trunc();
    for i in 0..g.cps.len() {
        if g.cps[i].contour == NONE { continue; }
        let ci = g.cps[i].contour;
        let contour = g.boundary[ci].clone();
        let cparam = g.params[ci].clone();
        let n = contour.len();
        let pt = contour[g.cps[i].point_idx];
        let first = g.first(i);
        let mut extend_next: i64 = -1;
        let mut extend_prev: i64 = -1;
        let (mut dist_y_prev, mut dist_y_next) = (0.0f64, 0.0f64);
        let (mut arc_prev, mut arc_next) = (0.0f64, 0.0f64);
        if !g.next_vertical(i) {
            let mut ii = g.cps[i].point_idx;
            let mut j = (ii + 1) % n;
            let target = g.cps[g.cps[i].next].point_idx;
            let mut guard = 0;
            while j != target && guard < n {
                if (contour[j][0] - pt[0]).abs() > dist_max_x { break; }
                ii = j; j = (j + 1) % n; guard += 1;
            }
            if ii != g.cps[i].point_idx {
                let mut dy = contour[ii][1] - pt[1];
                if first { dy = -dy; }
                if dy > dist_min_y {
                    arc_next = ccw_dist(cparam[g.cps[i].point_idx], cparam[ii], *cparam.last().unwrap());
                    if arc_next < g.cps[i].ntn { extend_next = ii as i64; dist_y_next = dy; }
                }
            }
        }
        if !g.prev_vertical(i) {
            let mut ii = g.cps[i].point_idx;
            let mut j = (ii + n - 1) % n;
            let target = g.cps[g.cps[i].prev].point_idx;
            let mut guard = 0;
            while j != target && guard < n {
                if (contour[j][0] - pt[0]).abs() > dist_max_x { break; }
                ii = j; j = (j + n - 1) % n; guard += 1;
            }
            if ii != g.cps[i].point_idx {
                let mut dy = contour[ii][1] - pt[1];
                if first { dy = -dy; }
                if dy > dist_min_y {
                    arc_prev = ccw_dist(cparam[ii], cparam[g.cps[i].point_idx], *cparam.last().unwrap());
                    if arc_prev < g.cps[i].ntp { extend_prev = ii as i64; dist_y_prev = dy; }
                }
            }
        }
        if extend_prev >= 0 && extend_next >= 0 {
            // C++: `dist_y_prev < dist_y_next ? extend_prev_idx : extend_next_idx = -1;` -> assigns -1 to the
            // branch selected by the conditional (the one with the smaller distance loses)
            if dist_y_prev < dist_y_next { extend_prev = -1; } else { extend_next = -1; }
        }
        let line = &mut infill[i / 2];
        let clen = *cparam.last().unwrap();
        if extend_prev >= 0 {
            let ep = extend_prev as usize;
            if first { line.reverse(); }
            take_cw_full(line, &contour, g.cps[i].point_idx, ep);
            if first { line.reverse(); }
            g.cps[i].point_idx = ep;
            if g.cps[i].prev_trimmed { g.cps[i].ntp -= arc_prev; }
            else {
                let pv = g.cps[i].prev;
                let v = ccw_dist(cparam[g.cps[pv].point_idx], cparam[g.cps[i].point_idx], clen);
                g.cps[i].ntp = v; g.cps[pv].ntn = v;
            }
            g.trim_next(i, 0.0);
            let nx = g.cps[i].next;
            g.cps[nx].prev_trimmed = true;
        } else if extend_next >= 0 {
            let en = extend_next as usize;
            if first { line.reverse(); }
            take_ccw_full(line, &contour, g.cps[i].point_idx, en);
            if first { line.reverse(); }
            g.cps[i].point_idx = en;
            g.trim_prev(i, 0.0);
            let pv = g.cps[i].prev;
            g.cps[pv].next_trimmed = true;
            if g.cps[i].next_trimmed { g.cps[i].ntn -= arc_next; }
            else {
                let nx = g.cps[i].next;
                let v = ccw_dist(cparam[g.cps[i].point_idx], cparam[g.cps[nx].point_idx], clen);
                g.cps[i].ntn = v; g.cps[nx].ntp = v;
            }
        }
    }
}

/// `Fill::connect_base_support`. `lines`: infill lines (2 points each) with their boundary attachments;
/// `rings`: the boundary rings (outer contour then holes) the lines end on. Returns polylines.
pub fn connect_base_support(lines: &[LineIn], rings: &[Vec<P>], spacing: f64, density: f64) -> Vec<Pl> {
    let mut out: Vec<Pl> = Vec::new();
    if lines.is_empty() {
        // loops without infill lines are emitted as perimeters by the driver below; nothing attaches
    }
    let mut g = if lines.is_empty() {
        Graph { boundary: rings.to_vec(), params: rings.iter().map(|r| { let mut p = vec![0.0; r.len() + 1]; for i in 1..r.len() { p[i] = p[i - 1] + dist(r[i], r[i - 1]); } let n = r.len(); p[n] = p[n - 1] + dist(r[n - 1], r[0]); p }).collect(), cps: Vec::new() }
    } else { create_graph(lines, rings, spacing) };
    let line_half_width = 0.5 * spacing;
    let line_spacing = spacing / (density as f32 as f64);
    let min_arch_length = 1.3 * line_spacing;
    let trim_length = line_half_width * 0.3;
    mark_boundary_segments_overlapping_infill(&mut g, lines, spacing);
    // loops with no infill end points: perimeters
    {
        let mut count = vec![0usize; g.boundary.len()];
        for cp in &g.cps { if cp.contour != NONE { count[cp.contour] += 1; } }
        for i in 0..g.boundary.len() {
            if count[i] == 0 && *g.params[i].last().unwrap() > trim_length + 0.5 * line_spacing {
                let mut pl = g.boundary[i].clone();
                pl.push(pl[0]);
                pl_clip_end(&mut pl, trim_length);
                if pl.len() > 1 { out.push(pl); }
            }
        }
    }
    // arches trimmed by infill lines at both sides
    for i in 0..g.cps.len() {
        let cp = g.cps[i].clone();
        if cp.next != NONE && cp.next_trimmed && g.cps[cp.next].prev_trimmed {
            let first = g.first(i);
            let mut left = g.pt(i)[0];
            let mut right = left;
            if first { left += line_half_width; right += line_spacing - line_half_width; }
            else { left -= line_spacing - line_half_width; right -= line_half_width; }
            let clen = *g.params[cp.contour].last().unwrap();
            let mut param_start = cp.param + cp.ntn;
            let mut param_end = g.cps[cp.next].param - g.cps[cp.next].ntp;
            if param_start >= clen { param_start -= clen; }
            if param_end < 0.0 { param_end += clen; }
            emit_loops_in_band(left, right, &g.boundary[cp.contour], &g.params[cp.contour], param_start, param_end, 0.5 * line_spacing, &mut out);
        }
    }
    let mut infill: Vec<Pl> = lines.iter().map(|l| vec![l.a, l.b]).collect();
    base_support_extend_infill_lines(&mut infill, &mut g, spacing, density as f32 as f64);
    let n_lines = infill.len();
    let mut ctx = Ctx { g, infill, merged: (0..n_lines).collect(), out: &mut Vec::new(), line_half_width, trim_length };
    // `out` of the ctx is unused; collected separately below
    let mut emitted: Vec<Pl> = Vec::new();
    std::mem::swap(&mut emitted, &mut out);
    let nc = ctx.g.cps.len();
    let vertical = |d: Dir| d == Dir::Up || d == Dir::Down;
    // consume all vertical arches
    for i in 0..nc {
        if ctx.g.cps[i].contour == NONE || ctx.g.cps[i].consumed { continue; }
        let other = ctx.g.other(i);
        let dir_prev = ctx.g.dir_prev(i);
        let dir_next = ctx.g.dir_next(i);
        let prev = ctx.g.cps[i].prev;
        let next = ctx.g.cps[i].next;
        let can_prev = vertical(dir_prev) && !ctx.g.cps[prev].consumed && prev != other;
        let can_next = vertical(dir_next) && !ctx.g.cps[next].consumed && next != other;
        let take_prev_pref = {
            let c = &ctx.g.cps[i];
            if c.prev_trimmed == c.next_trimmed { c.ntp > c.ntn } else { !c.prev_trimmed && c.next_trimmed }
        };
        if can_prev && (!can_next || take_prev_pref) {
            if !ctx.g.cps[i].prev_trimmed || ctx.g.cps[i].ntp > min_arch_length { ctx.take_next(prev, false); }
        } else if can_next {
            if !ctx.g.cps[i].next_trimmed || ctx.g.cps[i].ntn > min_arch_length { ctx.take_next(i, true); }
        }
    }
    let arches = evaluate_support_arches(&ctx.g);
    let cost_low = line_spacing * 1.3;
    let cost_high = line_spacing * 2.0;
    let cost_veryhigh = line_spacing * 3.0;
    {
        let mut selected: Vec<usize> = Vec::new();
        for i in 0..nc {
            if ctx.g.cps[i].contour == NONE || ctx.g.cps[i].consumed { continue; }
            let (cp_, cn_) = (arches[i * 2], arches[i * 2 + 1]);
            let (mut cmin, mut cmax) = (cp_.cost, cn_.cost);
            if cmin > cmax { std::mem::swap(&mut cmin, &mut cmax); }
            if cmax < cost_low || cmin > cost_high { continue; }
            if (cmax - cmin) / cmax < 0.25 { continue; }
            if cp_.cost > cost_low { selected.push(i * 2); }
            if cn_.cost > cost_low { selected.push(i * 2 + 1); }
        }
        selected.sort_by(|a, b| arches[*b].cost.partial_cmp(&arches[*a].cost).unwrap().then(a.cmp(b)));
        for s in selected {
            let cp = s / 2;
            if !ctx.g.cps[cp].consumed {
                let prev = s & 1 == 0;
                if prev { let pv = ctx.g.cps[cp].prev; ctx.take_next(pv, false); } else { ctx.take_next(cp, true); }
            }
        }
    }
    // zig-zag
    for i in 0..nc {
        if ctx.g.cps[i].contour == NONE || ctx.g.cps[i].consumed { continue; }
        if ctx.g.first(i) {
            let nx = ctx.g.cps[i].next;
            if ctx.gam(i) != ctx.gam(nx) { ctx.take_next(i, true); }
        } else {
            let pv = ctx.g.cps[i].prev;
            if ctx.gam(i) != ctx.gam(pv) { ctx.take_next(pv, false); }
        }
    }
    // left caps
    for i in 0..nc {
        if ctx.g.cps[i].contour == NONE { continue; }
        let other = ctx.g.other(i);
        let loop_next = ctx.g.cps[i].next == other;
        let loop_prev = ctx.g.cps[other].next == i;
        if loop_prev && ctx.g.could_take_prev(i) { let pv = ctx.g.cps[i].prev; ctx.take_next(pv, false); }
        if loop_next && ctx.g.could_take_next(i) { ctx.take_next(i, true); }
    }
    // T joints with long arches
    {
        let mut cand: Vec<usize> = Vec::new();
        for i in 0..nc {
            if ctx.g.cps[i].contour == NONE { continue; }
            if ctx.g.could_take_prev(i) { cand.push(i * 2); }
            if ctx.g.could_take_next(i) { cand.push(i * 2 + 1); }
        }
        cand.sort_by(|a, b| arches[*b].cost.partial_cmp(&arches[*a].cost).unwrap().then(a.cmp(b)));
        for c in cand {
            let cp = c / 2;
            let prev = c & 1 == 0;
            if prev {
                let pv = ctx.g.cps[cp].prev;
                if ctx.g.could_take_prev(cp) && (ctx.gam(cp) != ctx.gam(pv) || arches[c].cost > cost_high) { ctx.take_next(pv, false); }
            } else {
                let nx = ctx.g.cps[cp].next;
                if ctx.g.could_take_next(cp) && (ctx.gam(cp) != ctx.gam(nx) || arches[c].cost > cost_high) { ctx.take_next(cp, true); }
            }
        }
    }
    // very long arches and reasonably long caps
    let cap_cost = 0.5 * line_spacing;
    for i in 0..nc {
        if ctx.g.cps[i].contour == NONE { continue; }
        let (cost_prev, cost_next) = (arches[i * 2], arches[i * 2 + 1]);
        if ctx.g.cps[i].ntp > SCALED_EPS && (if cost_prev.self_loop { cost_prev.cost > cap_cost } else { cost_prev.cost > cost_veryhigh }) {
            let ci = ctx.g.cps[i].contour;
            let mut pl: Pl = vec![ctx.g.pt(i)];
            if !ctx.g.cps[i].prev_trimmed {
                let v = ctx.g.cps[i].ntp - line_half_width;
                ctx.g.trim_prev(i, v);
                let pv = ctx.g.cps[i].prev;
                ctx.g.trim_next(pv, 0.0);
            }
            if ctx.g.cps[i].ntp > SCALED_EPS {
                let pv = ctx.g.cps[i].prev;
                take_cw_limited(&mut pl, &ctx.g.boundary[ci], &ctx.g.params[ci], ctx.g.cps[i].point_idx, ctx.g.cps[pv].point_idx, ctx.g.cps[i].ntp);
                ctx.g.trim_prev(i, 0.0);
                pl_clip_start(&mut pl, line_half_width);
                emitted.push(pl);
            }
        }
        if ctx.g.cps[i].ntn > SCALED_EPS && (if cost_next.self_loop { cost_next.cost > cap_cost } else { cost_next.cost > cost_veryhigh }) {
            let ci = ctx.g.cps[i].contour;
            let mut pl: Pl = vec![ctx.g.pt(i)];
            if !ctx.g.cps[i].next_trimmed {
                let v = ctx.g.cps[i].ntn - line_half_width;
                ctx.g.trim_next(i, v);
                let nx = ctx.g.cps[i].next;
                ctx.g.trim_prev(nx, 0.0);
            }
            if ctx.g.cps[i].ntn > SCALED_EPS {
                let nx = ctx.g.cps[i].next;
                take_ccw_limited(&mut pl, &ctx.g.boundary[ci], &ctx.g.params[ci], ctx.g.cps[i].point_idx, ctx.g.cps[nx].point_idx, ctx.g.cps[i].ntn);
                ctx.g.trim_next(i, 0.0);
                pl_clip_start(&mut pl, line_half_width);
                emitted.push(pl);
            }
        }
    }
    for pl in ctx.infill.drain(..) { if !pl.is_empty() { emitted.push(pl); } }
    emitted
}
