//! Support fill patterns. Rectilinear ("lines") and SupportBase (lines + zig-zag/arch connections along
//! the island boundary) after FillRectilinear.cpp / FillBase.cpp `connect_base_support`.
//!
//! STATUS: the line generation (grid anchoring, half-spacing inset, rotation conventions) follows Orca
//! exactly. The boundary connection logic is a reduced port: Orca's multi-stage `connect_base_support`
//! (vertical arches, caps, T-joints, cost-ranked arches) is reduced to its final zig-zag stage plus
//! loop closing. See supports/mod.rs "approximations".
use super::poly::{self, scaled, unscaled};
use crate::types::{Poly, Polys, Ring};

pub type Pl = Vec<[f64; 2]>;

#[derive(Clone, Copy, Debug)]
pub struct FillParams {
    /// extrusion spacing (mm)
    pub spacing: f64,
    pub density: f64,
    /// fill angle (rad), Orca `Fill::angle`; the lines run perpendicular to `angle + pi/2` rotated frame
    pub angle: f64,
}

fn rot(p: [f64; 2], c: f64, s: f64) -> [f64; 2] { [p[0] * c - p[1] * s, p[0] * s + p[1] * c] }

fn align_to_grid(coord: i64, spacing: i64, base: i64) -> i64 {
    // Slic3r::align_to_grid(coord, spacing, base): base + floor((coord-base)/spacing)*spacing
    let d = coord - base;
    let q = if d >= 0 { d / spacing } else { -((-d + spacing - 1) / spacing) };
    base + q * spacing
}

struct Line {
    x: i64,       // scaled x of the vertical line
    y0: f64,      // low end (mm, rotated frame)
    y1: f64,      // high end
    c0: End,
    c1: End,
}
#[derive(Clone, Copy)]
struct End { contour: usize, param: f64, edge: usize }

struct Contours { rings: Vec<Ring>, cum: Vec<Vec<f64>>, len: Vec<f64> }
impl Contours {
    fn new(rings: Vec<Ring>) -> Contours {
        let mut cum = Vec::new(); let mut len = Vec::new();
        for r in &rings {
            let mut c = Vec::with_capacity(r.len() + 1);
            let mut acc = 0.0;
            c.push(0.0);
            for i in 0..r.len() {
                let p = r[i]; let q = r[(i + 1) % r.len()];
                acc += ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
                c.push(acc);
            }
            len.push(acc);
            cum.push(c);
        }
        Contours { rings, cum, len }
    }
}

/// Intersect the vertical lines x = x0 + k*line_spacing (scaled) with all rings (even-odd, half-open rule).
fn vertical_lines(ct: &Contours, x_first: i64, n_lines: usize, line_spacing: i64, x_min: i64, x_max: i64) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for k in 0..n_lines {
        let xs = x_first + k as i64 * line_spacing;
        if xs < x_min { continue; }
        if xs > x_max { break; }
        let xf = unscaled(xs);
        let mut hits: Vec<(f64, End)> = Vec::new();
        for (ci, r) in ct.rings.iter().enumerate() {
            let n = r.len();
            for i in 0..n {
                let p = r[i]; let q = r[(i + 1) % n];
                // work in scaled integers for the half-open decision to stay consistent with the lattice
                let (px, qx) = (scaled(p[0]), scaled(q[0]));
                let crosses = (px <= xs && xs < qx) || (qx <= xs && xs < px);
                if !crosses { continue; }
                let t = (xf - p[0]) / (q[0] - p[0]);
                let y = p[1] + t * (q[1] - p[1]);
                let param = ct.cum[ci][i] + t * (ct.cum[ci][i + 1] - ct.cum[ci][i]);
                hits.push((y, End { contour: ci, param, edge: i }));
            }
        }
        hits.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut i = 0;
        while i + 1 < hits.len() {
            out.push(Line { x: xs, y0: hits[i].0, y1: hits[i + 1].0, c0: hits[i].1, c1: hits[i + 1].1 });
            i += 2;
        }
    }
    out
}

/// `Fill::_infill_direction`-style rotation: polygons are rotated by -(angle + pi/2) so lines are vertical.
fn setup(ex: &Poly, p: &FillParams, inset: f64) -> Option<(Contours, f64, f64, i64, [i64; 2])> {
    let ang = p.angle + std::f64::consts::FRAC_PI_2;
    let (s, c) = ((-ang).sin(), (-ang).cos());
    let rotate_ring = |r: &Ring| -> Ring { r.iter().map(|q| rot(*q, c, s)).collect() };
    let src = Poly { contour: rotate_ring(&ex.contour), holes: ex.holes.iter().map(rotate_ring).collect() };
    let bb = poly::bbox(&vec![src.clone()])?;
    let shrunk = if inset != 0.0 { poly::offset(&vec![src], -inset) } else { vec![src] };
    if shrunk.is_empty() { return None; }
    let mut rings: Vec<Ring> = Vec::new();
    for sp in &shrunk { rings.push(sp.contour.clone()); for h in &sp.holes { rings.push(h.clone()); } }
    let line_spacing = ((p.spacing / 1e-6) / (p.density as f32 as f64)) as i64; // coord_t(scale_(spacing) / float(density))
    let bmin = [scaled(bb.0[0]), scaled(bb.0[1])];
    let bmax = [scaled(bb.1[0]), scaled(bb.1[1])];
    Some((Contours::new(rings), -ang, ang, line_spacing, [bmin[0], bmax[0]]))
}

fn x_range(bx: [i64; 2], line_spacing: i64) -> (i64, usize) {
    // bounding box merged with the grid anchor (reference point is the origin: refpt = (0,0) rotated = (0,0))
    let mut min = bx[0];
    let aligned = align_to_grid(min, line_spacing, 0);
    if aligned < min { min = aligned; }
    let n = ((bx[1] - min + line_spacing - 1) / line_spacing).max(0) as usize;
    (min, n)
}

struct Cp { line: usize, first: bool, contour: usize, param: f64, consumed: bool, next: usize, prev: usize }

/// Join the pieces of a boundary arc (CCW from param a to param b) into `out` (excluding the first point).
fn arc_points(ct: &Contours, contour: usize, a: f64, b: f64, out: &mut Pl) {
    let r = &ct.rings[contour];
    let n = r.len();
    let total = ct.len[contour];
    let cum = &ct.cum[contour];
    // vertices with cum param strictly between a and b going ccw
    let b2 = if b >= a { b } else { b + total };
    for i in 0..(2 * n) {
        let v = i % n;
        let pv = cum[v] + if i >= n { total } else { 0.0 };
        if pv > a + 1e-9 && pv < b2 - 1e-9 { out.push(r[v]); }
    }
}

fn point_at(ct: &Contours, contour: usize, edge: usize, param: f64) -> [f64; 2] {
    let r = &ct.rings[contour];
    let n = r.len();
    let (p, q) = (r[edge], r[(edge + 1) % n]);
    let l = ct.cum[contour][edge + 1] - ct.cum[contour][edge];
    let t = if l > 0.0 { (param - ct.cum[contour][edge]) / l } else { 0.0 };
    [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
}

/// Lines + zig-zag connection along the boundary. `connect_all`: connect every consecutive pair (serpentine).
fn lines_and_zigzag(ex: &Poly, p: &FillParams, inset: f64, close_loops: bool) -> Vec<Pl> {
    let Some((ct, back_ang, _ang, line_spacing, bx)) = setup(ex, p, inset) else { return Vec::new() };
    if line_spacing <= 0 { return Vec::new(); }
    let (xmin, n) = x_range(bx, line_spacing);
    let lines = vertical_lines(&ct, xmin, n + 1, line_spacing, bx[0], bx[1]);
    if lines.is_empty() { return Vec::new(); }
    // order: by x then y (already so)
    let nl = lines.len();
    let mut cps: Vec<Cp> = Vec::with_capacity(nl * 2);
    for (i, l) in lines.iter().enumerate() {
        cps.push(Cp { line: i, first: true, contour: l.c0.contour, param: l.c0.param, consumed: false, next: 0, prev: 0 });
        cps.push(Cp { line: i, first: false, contour: l.c1.contour, param: l.c1.param, consumed: false, next: 0, prev: 0 });
    }
    // neighbours along each contour
    let mut by_contour: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
    for (i, c) in cps.iter().enumerate() { by_contour.entry(c.contour).or_default().push(i); }
    for (_, v) in by_contour.iter_mut() {
        v.sort_by(|a, b| cps[*a].param.partial_cmp(&cps[*b].param).unwrap().then(a.cmp(b)));
        let m = v.len();
        for k in 0..m {
            let (a, nx, pv) = (v[k], v[(k + 1) % m], v[(k + m - 1) % m]);
            cps[a].next = nx;
            cps[a].prev = pv;
        }
    }
    // polylines per line (in the rotated frame)
    let mut polys: Vec<Pl> = lines.iter().map(|l| vec![[unscaled(l.x), l.y0], [unscaled(l.x), l.y1]]).collect();
    let mut alive: Vec<bool> = vec![true; nl];
    let mut merged: Vec<usize> = (0..nl).collect();
    fn find(m: &mut Vec<usize>, i: usize) -> usize { let mut r = i; while m[r] != r { r = m[r]; } let mut c = i; while m[c] != r { let nx = m[c]; m[c] = r; c = nx; } r }
    let ends = |l: &Line, first: bool| -> End { if first { l.c0 } else { l.c1 } };
    // take_next: connect cp1 -> cp2 = cp1.next (ccw) by the boundary arc
    let mut take = |cps: &mut Vec<Cp>, polys: &mut Vec<Pl>, alive: &mut Vec<bool>, merged: &mut Vec<usize>, cp1: usize, cp2: usize| {
        if cps[cp1].consumed || cps[cp2].consumed { return; }
        let l1 = find(merged, cps[cp1].line);
        let l2 = find(merged, cps[cp2].line);
        if l1 == l2 { return; }
        let e1 = ends(&lines[cps[cp1].line], cps[cp1].first);
        let e2 = ends(&lines[cps[cp2].line], cps[cp2].first);
        let pt1 = point_at(&ct, e1.contour, e1.edge, e1.param);
        let pt2 = point_at(&ct, e2.contour, e2.edge, e2.param);
        let mut pa = std::mem::take(&mut polys[l1]);
        let mut pb = std::mem::take(&mut polys[l2]);
        // pa must end at pt1, pb must start at pt2
        let d = |x: [f64; 2], y: [f64; 2]| (x[0] - y[0]).abs() + (x[1] - y[1]).abs();
        if d(*pa.first().unwrap(), pt1) < d(*pa.last().unwrap(), pt1) { pa.reverse(); }
        if d(*pb.last().unwrap(), pt2) < d(*pb.first().unwrap(), pt2) { pb.reverse(); }
        let mut arc = Pl::new();
        arc_points(&ct, e1.contour, cps[cp1].param, cps[cp2].param, &mut arc);
        pa.extend(arc);
        pa.extend(pb);
        polys[l1] = pa;
        alive[l2] = false;
        merged[l2] = l1;
        cps[cp1].consumed = true;
        cps[cp2].consumed = true;
    };
    // rectilinear: first connect free ends facing each other across a contour wall (vertical arcs)
    if close_loops {
        for i in 0..cps.len() {
            if cps[i].consumed { continue; }
            let nx = cps[i].next;
            if nx == i || cps[nx].consumed { continue; }
            let e1 = ends(&lines[cps[i].line], cps[i].first);
            let e2 = ends(&lines[cps[nx].line], cps[nx].first);
            if lines[cps[i].line].x != lines[cps[nx].line].x { continue; } // same vertical line = a wall in between
            let _ = (e1, e2);
            take(&mut cps, &mut polys, &mut alive, &mut merged, i, nx);
        }
    }
    for i in 0..cps.len() {
        if cps[i].consumed { continue; }
        let first = cps[i].first;
        if first {
            let nx = cps[i].next;
            if nx != i { take(&mut cps, &mut polys, &mut alive, &mut merged, i, nx); }
        } else {
            let pv = cps[i].prev;
            if pv != i { take(&mut cps, &mut polys, &mut alive, &mut merged, pv, i); }
        }
    }
    if std::env::var("FILL_DEBUG").is_ok() {
        for (i, c) in cps.iter().enumerate() { eprintln!("cp{} line{} first{} contour{} param{:.3} next{} prev{} consumed{}", i, c.line, c.first, c.contour, c.param, c.next, c.prev, c.consumed); }
        for (i, l) in lines.iter().enumerate() { eprintln!("line{} x{} y0 {:.3} y1 {:.3} alive{} len{}", i, l.x, l.y0, l.y1, alive[i], polys[i].len()); }
    }
    let _ = close_loops;
    // back to the original frame
    let (s, c) = (back_ang.sin(), back_ang.cos());
    let (sb, cb) = (-s, c); // rotate by +ang = -(back_ang)
    let mut out: Vec<Pl> = Vec::new();
    for (i, pl) in polys.into_iter().enumerate() {
        if !alive[i] || pl.len() < 2 { continue; }
        let mut q: Pl = pl.into_iter().map(|pt| rot(pt, cb, sb)).collect();
        q.dedup();
        if q.len() >= 2 { out.push(q); }
    }
    out
}

/// FillSupportBase: sparse lines (vertical in the rotated frame) connected by `connect_base_support`.
pub fn fill_support_base(ex: &Poly, p: &FillParams) -> Vec<Pl> {
    use super::connect::{connect_base_support, LineIn};
    let ang = p.angle + std::f64::consts::FRAC_PI_2;
    // rotate by -ang and snap to the 1e-6 lattice, like Polygon::rotate in ExPolygonWithOffset
    let (s, c) = ((-ang).sin(), (-ang).cos());
    let snap = |q: [f64; 2]| -> [f64; 2] { let r = rot(q, c, s); [unscaled(scaled(r[0])), unscaled(scaled(r[1]))] };
    let rotate_ring = |r: &Ring| -> Ring { r.iter().map(|q| snap(*q)).collect() };
    let src = Poly { contour: rotate_ring(&ex.contour), holes: ex.holes.iter().map(rotate_ring).collect() };
    let Some(bb) = poly::bbox(&vec![src.clone()]) else { return Vec::new() };
    let inset = 0.5 * p.spacing; // scale_(overlap - 0.5 * spacing)
    let shrunk = poly::offset(&vec![src], -unscaled(poly::scale_trunc(inset)));
    if shrunk.is_empty() { return Vec::new(); }
    let mut rings_mm: Vec<Ring> = Vec::new();
    for sp in &shrunk { rings_mm.push(sp.contour.clone()); for h in &sp.holes { rings_mm.push(h.clone()); } }
    let ct = Contours::new(rings_mm.clone());
    let line_spacing = ((p.spacing / 1e-6) / (p.density as f32 as f64)) as i64;
    if line_spacing <= 0 { return Vec::new(); }
    let bx = [scaled(bb.0[0]), scaled(bb.1[0])];
    let (xmin, n) = x_range(bx, line_spacing);
    let lines = vertical_lines(&ct, xmin, n + 1, line_spacing, bx[0], bx[1]);
    // no line fits: connect_base_support still emits the boundary loops as perimeters
    let u = |v: f64| (v * 1e6).round();
    let rings_i: Vec<Vec<[f64; 2]>> = rings_mm.iter().map(|r| r.iter().map(|q| [u(q[0]), u(q[1])]).collect()).collect();
    let edge_t = |e: &End, x: f64| -> f64 {
        let r = &ct.rings[e.contour]; let n = r.len();
        let (a, b) = (r[e.edge], r[(e.edge + 1) % n]);
        if b[0] == a[0] { 0.0 } else { (x - a[0]) / (b[0] - a[0]) }
    };
    let lins: Vec<LineIn> = lines.iter().map(|l| {
        let x = l.x as f64;
        let xf = unscaled(l.x);
        LineIn {
            a: [x, u(l.y0)], b: [x, u(l.y1)],
            ea: (l.c0.contour, l.c0.edge, edge_t(&l.c0, xf)),
            eb: (l.c1.contour, l.c1.edge, edge_t(&l.c1, xf)),
        }
    }).collect();
    let pls = connect_base_support(&lins, &rings_i, p.spacing * 1e6, p.density);
    let (sb, cb) = (ang.sin(), ang.cos());
    let mut out: Vec<Pl> = Vec::new();
    for pl in pls {
        let mut q: Pl = pl.into_iter().map(|pt| { let r = rot([pt[0] / 1e6, pt[1] / 1e6], cb, sb); [unscaled(scaled(r[0])), unscaled(scaled(r[1]))] }).collect();
        q.dedup();
        if q.len() >= 2 { out.push(q); }
    }
    out
}

/// FillRectilinear: lines with boundary links. Lines end 0.5*spacing inside the contour.
pub fn fill_rectilinear(ex: &Poly, p: &FillParams) -> Vec<Pl> {
    // lines end on the inner contour (0.5 * spacing); links follow the boundary, long vertical arcs included
    lines_and_zigzag(ex, p, 0.5 * p.spacing, true)
}

/// Concentric loops: repeated inward offsets of the region (FillConcentric).
pub fn fill_concentric(ex: &Poly, p: &FillParams) -> Vec<Pl> {
    let dist = p.spacing / p.density;
    let mut cur: Polys = poly::offset(&vec![ex.clone()], -0.5 * p.spacing);
    let mut out: Vec<Pl> = Vec::new();
    let mut guard = 0;
    while !cur.is_empty() && guard < 10_000 {
        for pg in &cur {
            let mut c = pg.contour.clone();
            if !c.is_empty() { c.push(c[0]); out.push(c); }
            for h in &pg.holes { let mut c = h.clone(); if !c.is_empty() { c.push(c[0]); out.push(c); } }
        }
        cur = poly::offset(&cur, -dist);
        guard += 1;
    }
    out
}

/// Grid: two perpendicular rectilinear passes, each at half the density.
pub fn fill_grid(ex: &Poly, p: &FillParams) -> Vec<Pl> {
    let mut q = *p;
    q.density *= 0.5;
    let mut out = fill_rectilinear(ex, &q);
    q.angle += std::f64::consts::FRAC_PI_2;
    out.extend(fill_rectilinear(ex, &q));
    out
}

pub fn path_len(p: &Pl) -> f64 { p.windows(2).map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt()).sum() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rectilinear_rows_are_anchored_to_the_origin() {
        let ex = poly::rect(-5.3, -5.3, 5.3, 5.3);
        let p = FillParams { spacing: 0.4, density: 1.0, angle: 0.0 };
        let pls = fill_rectilinear(&ex, &p);
        assert!(!pls.is_empty());
        // angle 0 -> lines along x at y = k * 0.4 (origin anchored)
        for pl in &pls { for w in pl.windows(2) { if (w[0][1] - w[1][1]).abs() < 1e-9 { let k = w[0][1] / 0.4; assert!((k - k.round()).abs() < 1e-3, "row y {} not on grid", w[0][1]); } } }
    }
}
