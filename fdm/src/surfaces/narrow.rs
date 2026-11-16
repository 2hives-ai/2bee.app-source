//! `split_solid_surface` (Fill.cpp, `detect_narrow_internal_solid_infill`): split an internal solid region into the
//! part the line fill can cover with threads of useful length ("normal") and the narrow remainder, which Orca fills
//! with concentric loops (`ipConcentricInternal`).
use super::ops::*;
use crate::types::{Poly, Polys};
use std::f64::consts::PI;

const MAX_LINE_LENGTH_TO_FILTER: f64 = 4.0;
const MAX_SKIPS_ALLOWED: i32 = 2;
const MIN_DEPTH_FOR_LINE_REMOVING: i32 = 5;

#[derive(Clone, Copy)]
struct Line { a: Pt, b: Pt }
impl Line { fn len(&self) -> f64 { dist(self.a, self.b) } }

#[derive(Clone)]
struct Node {
    line: Line,
    next: Vec<(usize, usize)>,
    prev: Vec<(usize, usize)>,
    removed: bool,
    min_skips: i32,
    total_short: i32,
    initial_touches_long: bool,
    initialized: bool,
}

fn overlap_y(f: &Line, s: &Line) -> bool {
    (s.a[1] <= f.a[1] && f.a[1] <= s.b[1]) || (s.a[1] <= f.b[1] && f.b[1] <= s.b[1])
        || (f.a[1] <= s.a[1] && s.a[1] <= f.b[1]) || (f.a[1] <= s.b[1] && s.b[1] <= f.b[1])
}

/// `filter_vibrating_extrusions` (anti-vibration filter from PrusaSlicer).
fn filter_vibrating(sections: &[Vec<Line>]) -> Vec<Vec<Line>> {
    let mut ns: Vec<Vec<Node>> = sections.iter().map(|s| s.iter().map(|l| Node {
        line: *l, next: vec![], prev: vec![], removed: false, min_skips: 0, total_short: 0, initial_touches_long: false, initialized: false,
    }).collect()).collect();
    for si in 0..ns.len() {
        if si > 0 {
            for ci in 0..ns[si].len() {
                let cl = ns[si][ci].line;
                let pv: Vec<(usize, usize)> = (0..ns[si - 1].len()).filter(|&pi| overlap_y(&cl, &ns[si - 1][pi].line)).map(|pi| (si - 1, pi)).collect();
                ns[si][ci].prev = pv;
            }
        }
        if si + 1 < ns.len() {
            for ci in 0..ns[si].len() {
                let cl = ns[si][ci].line;
                let nx: Vec<(usize, usize)> = (0..ns[si + 1].len()).filter(|&ni| overlap_y(&cl, &ns[si + 1][ni].line)).map(|ni| (si + 1, ni)).collect();
                ns[si][ci].next = nx;
            }
        }
    }
    let is_touching_long_prev = |ns: &Vec<Vec<Node>>, n: &Node| -> bool {
        n.prev.iter().any(|&(s, i)| !ns[s][i].removed && ns[s][i].line.len() >= MAX_LINE_LENGTH_TO_FILTER)
    };
    let initial_touches = |ns: &Vec<Vec<Node>>, n: &Node| -> bool { n.prev.iter().any(|&(s, i)| ns[s][i].initial_touches_long) };
    let has_next = |ns: &Vec<Vec<Node>>, n: &Node| -> bool { n.next.iter().any(|&(s, i)| !ns[s][i].removed) };
    let can_remove = |ns: &Vec<Vec<Node>>, n: &Node| -> bool {
        n.line.len() < MAX_LINE_LENGTH_TO_FILTER && (n.total_short > MIN_DEPTH_FOR_LINE_REMOVING || (!initial_touches(ns, n) && !has_next(ns, n)))
    };
    let nsec = ns.len();
    for init in 0..nsec {
        for ci in 0..ns[init].len() {
            if ns[init][ci].removed || ns[init][ci].line.len() >= MAX_LINE_LENGTH_TO_FILTER { continue; }
            let touches = { let n = ns[init][ci].clone(); is_touching_long_prev(&ns, &n) };
            let n = &mut ns[init][ci];
            n.min_skips = 0; n.total_short = 1; n.initial_touches_long = touches; n.initialized = true;
        }
        for prop in init..nsec {
            // the state only travels to the right: once a section holds no live initialised node nothing after it can
            if !ns[prop].iter().any(|n| !n.removed && n.initialized) { break; }
            if prop + 1 < nsec {
                for n in ns[prop + 1].iter_mut() { n.min_skips = 0; n.total_short = 0; n.initial_touches_long = false; n.initialized = false; }
            }
            for pi in 0..ns[prop].len() {
                if ns[prop][pi].removed || !ns[prop][pi].initialized { continue; }
                let pl = ns[prop][pi].clone();
                for &(s, i) in &pl.next {
                    if ns[s][i].removed { continue; }
                    let is_short = ns[s][i].line.len() < MAX_LINE_LENGTH_TO_FILTER;
                    let skip_allowed = pl.min_skips < MAX_SKIPS_ALLOWED;
                    if !is_short && !skip_allowed { continue; }
                    let nts = pl.total_short + is_short as i32;
                    let nms = pl.min_skips + (!is_short) as i32;
                    let nb = &mut ns[s][i];
                    if nb.initialized {
                        nb.min_skips = nb.min_skips.max(nts);
                        nb.min_skips = nb.min_skips.min(nms);
                        if nb.initial_touches_long { nb.initial_touches_long = pl.initial_touches_long; }
                    } else {
                        nb.total_short = nts; nb.min_skips = nms; nb.initial_touches_long = pl.initial_touches_long; nb.initialized = true;
                    }
                }
                let cur = ns[prop][pi].clone();
                if can_remove(&ns, &cur) {
                    ns[prop][pi].removed = true;
                    // propagate the removal to the previous sections
                    let mut queue: std::collections::VecDeque<(usize, usize)> = std::collections::VecDeque::new();
                    for &(s, i) in &cur.prev { if !ns[s][i].removed { queue.push_back((s, i)); } }
                    while let Some((s, i)) = queue.pop_front() {
                        let nn = ns[s][i].clone();
                        if can_remove(&ns, &nn) {
                            ns[s][i].removed = true;
                            for &(ps, pi2) in &nn.prev { if !ns[ps][pi2].removed { queue.push_back((ps, pi2)); } }
                        }
                    }
                }
            }
        }
    }
    ns.into_iter().map(|s| s.into_iter().filter(|n| !n.removed).map(|n| n.line).collect()).collect()
}

/// Returns (normal, narrow). `narrow` empty = no split needed (normal is then left empty, like Orca).
/// `angle`: thread direction before the layer alternation (`SurfaceFillParams::angle`), `layer`: layer index.
pub fn split_solid_surface(regions: &Polys, spacing: f64, angle: f64, layer: usize) -> (Polys, Polys) {
    let mut base_angle = angle + PI / 2.0;
    if layer % 2 == 1 { base_angle += PI / 2.0; }
    let aligning = -base_angle + PI;
    let sp = spacing;
    let mut normal_areas: Polys = vec![];
    for isl in regions {
        let filled = rotate_polys(&vec![isl.clone()], aligning);
        let Some(bb) = bbox(&filled) else { continue };
        let inner = it(&filled, &off(&off(&filled, -2.0 * sp), 3.0 * sp));
        let inner = shrink(&inner, sp * 0.5);
        let n_v = (((bb[2] - bb[0]) + sp - 1e-6) / sp).floor().max(0.0) as usize;
        let edges: Vec<(Pt, Pt)> = rings(&inner).iter().flat_map(|r| { let m = r.len(); (0..m).map(move |i| (r[i], r[(i + 1) % m])) }).collect();
        // bucket the edges by the section columns they can cross (exact predicate re-tested below, edge order kept)
        let xi = |i: usize| bb[0] + i as f64 * sp;
        let mut per_col: Vec<Vec<u32>> = vec![vec![]; n_v];
        for (ei, &(a, b)) in edges.iter().enumerate() {
            if n_v == 0 { break; }
            let (lo, hi) = (a[0].min(b[0]), a[0].max(b[0]));
            let c0 = (((lo - bb[0]) / sp).floor() - 1.0).max(0.0) as usize;
            let c1 = ((((hi - bb[0]) / sp).ceil() + 1.0).max(0.0) as usize).min(n_v - 1);
            for i in c0..=c1 { if (a[0] <= xi(i)) != (b[0] <= xi(i)) { per_col[i].push(ei as u32); } }
        }
        let idx = PolyIdx::new(&inner);
        let mut sections: Vec<Vec<Line>> = vec![vec![]; n_v];
        for i in 0..n_v {
            let x = xi(i);
            let mut ys: Vec<f64> = vec![];
            for &ei in &per_col[i] {
                let (a, b) = edges[ei as usize];
                ys.push(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]));
            }
            ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for k in 0..ys.len().saturating_sub(1) {
                if (ys[k + 1] - ys[k]).abs() > sp && idx.inside(x, (ys[k] + ys[k + 1]) / 2.0) {
                    sections[i].push(Line { a: [x, ys[k]], b: [x, ys[k + 1]] });
                }
            }
        }
        let sections = filter_vibrating(&sections);
        // widen every thread by half a spacing at both ends, then trace polygons through adjacent sections
        let sections: Vec<Vec<Line>> = sections.into_iter().map(|s| s.into_iter().map(|l| Line { a: [l.a[0], l.a[1] - 0.5 * sp], b: [l.b[0], l.b[1] + 0.5 * sp] }).collect()).collect();
        let lim2 = (2.0 * sp) * (2.0 * sp);
        struct Tr { lows: Vec<Pt>, highs: Vec<Pt> }
        let half = [sp / 2.0, 0.0];
        let add = |p: Pt| [p[0] + half[0], p[1]];
        let sub = |p: Pt| [p[0] - half[0], p[1]];
        let mut cur: Vec<Tr> = vec![];
        let mut recon: Vec<Vec<Pt>> = vec![];
        for slice in &sections {
            let mut used = vec![false; slice.len()];
            for tp in cur.iter_mut() {
                let low_y = tp.lows.last().unwrap()[1];
                let high_y = tp.highs.last().unwrap()[1];
                let begin = slice.iter().position(|s| s.b[1] > low_y).unwrap_or(slice.len());
                let end = slice.iter().position(|s| s.a[1] > high_y).unwrap_or(slice.len());
                let mut added = false;
                let mut k = begin;
                while k < end && !added {
                    if used[k] { k += 1; continue; }
                    // Orca reads the first candidate's endpoints here (candidates_begin), not the iterated one
                    let c = slice[begin];
                    let ll = *tp.lows.last().unwrap();
                    if (ll[0] - c.a[0]).powi(2) + (ll[1] - c.a[1]).powi(2) < lim2 { tp.lows.push(c.a); } else { tp.lows.push(add(ll)); tp.lows.push(sub(c.a)); tp.lows.push(c.a); }
                    let hl = *tp.highs.last().unwrap();
                    if (hl[0] - c.b[0]).powi(2) + (hl[1] - c.b[1]).powi(2) < lim2 { tp.highs.push(c.b); } else { tp.highs.push(add(hl)); tp.highs.push(sub(c.b)); tp.highs.push(c.b); }
                    added = true;
                    used[begin] = true;
                    k += 1;
                }
                if !added {
                    let ll = *tp.lows.last().unwrap();
                    let hl = *tp.highs.last().unwrap();
                    tp.lows.push(add(ll));
                    tp.highs.push(add(hl));
                    let mut poly = std::mem::take(&mut tp.lows);
                    poly.extend(tp.highs.drain(..).rev());
                    recon.push(poly);
                }
            }
            cur.retain(|t| !t.lows.is_empty());
            for (k, seg) in slice.iter().enumerate() {
                if !used[k] { cur.push(Tr { lows: vec![sub(seg.a), seg.a], highs: vec![sub(seg.b), seg.b] }); }
            }
        }
        for tp in cur { let mut poly = tp.lows; poly.extend(tp.highs.into_iter().rev()); recon.push(poly); }
        let polys: Polys = recon.into_iter().filter(|p| p.len() >= 3).map(|mut p| {
            if ring_area(&p) < 0.0 { p.reverse(); }
            Poly { contour: p, holes: vec![] }
        }).collect();
        normal_areas.extend(rotate_polys(&polys, -aligning));
    }
    let normal_ex = off(&u(&normal_areas), 1e-5);
    let mut narrow = df(regions, &normal_ex);
    // merge areas smaller than one thread into the normal fill when they touch it
    let mut normal_all = normal_ex.clone();
    let mut kept: Polys = vec![];
    for p in narrow.drain(..) {
        let pp = vec![p.clone()];
        if off(&pp, -sp * 0.5).is_empty() {
            let grown = off(&pp, sp * 0.3);
            if !it(&normal_all, &grown).is_empty() { normal_all.push(p); continue; }
        }
        kept.push(p);
    }
    if kept.is_empty() { return (vec![], vec![]); }
    let normal = it(&off(&u(&normal_all), sp * 0.5), regions);
    (normal, kept)
}

/// Beads of a narrow region (`FillConcentricInternal` runs Arachne; this approximates its bead count rule):
/// parts thinner than 1.5 spacings get ONE bead along their medial axis (returned in `thin`), thicker parts get closed
/// loops half a spacing in from the boundary, then one spacing apart. Loops are outermost first.
pub fn concentric_beads(region: &Polys, spacing: f64) -> (Vec<Vec<Pt>>, Polys) {
    let mut loops: Vec<Vec<Pt>> = vec![];
    let mut thin: Polys = vec![];
    let mut cur = u(region);
    for _ in 0..400 {
        if cur.is_empty() { break; }
        let thick = off(&off(&cur, -0.75 * spacing), 0.75 * spacing);
        let thick = it(&thick, &cur);
        for p in df(&cur, &thick) {
            if poly_area(&p) > 0.01 { thin.push(p); }
        }
        let inner = off(&thick, -spacing / 2.0);
        for ring in rings(&inner) { loops.push(ring.clone()); }
        cur = off(&thick, -spacing);
    }
    (loops, thin)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polys {
        vec![Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }]
    }
    #[test]
    fn wide_block_needs_no_split_and_a_thin_strip_is_all_narrow() {
        let sp = 0.377;
        // a 20 x 20 block filled along its axes: every thread is long, nothing is narrow
        let (normal, narrow) = split_solid_surface(&rect(0.0, 0.0, 20.0, 20.0), sp, 0.0, 0);
        assert!(narrow.is_empty() && normal.is_empty());
        // a 0.9 mm strip: threads are shorter than the filter limit and the whole region goes to the narrow fill
        let (normal, narrow) = split_solid_surface(&rect(0.0, 0.0, 0.9, 20.0), sp, std::f64::consts::FRAC_PI_2, 0);
        assert!(area(&narrow) > 0.9 * 20.0 * 0.9, "{}", area(&narrow));
        assert!(area(&normal) < 1.0);
    }
    #[test]
    fn narrow_beads_split_thin_and_thick_parts() {
        let sp = 0.377;
        // 0.5 mm strip (thinner than 1.5 spacings): one medial bead, no loops
        let (loops, thin) = concentric_beads(&rect(0.0, 0.0, 0.5, 20.0), sp);
        assert!(loops.is_empty() && !thin.is_empty());
        // 4 x 4 block: loops half a spacing in, then one spacing apart, until the core is thin
        let (loops, _thin) = concentric_beads(&rect(0.0, 0.0, 4.0, 4.0), sp);
        assert!(loops.len() >= 4, "{}", loops.len());
        let first = ring_len(&loops[0]);
        assert!((first - 4.0 * (4.0 - sp)).abs() < 0.05, "{first}");
    }
}
