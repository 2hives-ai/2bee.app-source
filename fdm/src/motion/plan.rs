//! Per-layer ordering: `ExtPath`s -> `Stroke`s (merged wall loops) -> islands -> print order, following
//! `GCode::process_layer` / `extrude_perimeters` / `extrude_infill`:
//!
//! * the wall loops of one island are printed first (lane 2 already applied `wall_sequence`; the order it gives
//!   is kept), infill after them unless `is_infill_first` (never on the first layer), ironing last;
//! * islands are the layer's slices; they are visited by nearest-neighbour chaining of their centroids from the
//!   nozzle position (`chain_points`);
//! * infill "runs" (consecutive paths of one feature, i.e. what Orca keeps together in one collection) are chained
//!   nearest-first from the nozzle position, each run keeps its internal order.

use crate::types::{ExtPath, Feature, Poly, Polys};

use super::chain;
use super::geo::{self, P2};

/// One extrusion unit as emitted: a polyline (or closed loop) with a width and a feature per segment.
#[derive(Clone, Debug)]
pub struct Stroke {
    /// Vertices. A closed stroke has no repeated closing vertex.
    pub pts: Vec<P2>,
    /// Bead width of segment i (pts[i] -> pts[i+1], wrapping when closed).
    pub w: Vec<f64>,
    /// Feature of segment i.
    pub feat: Vec<Feature>,
    pub h: f64,
    /// mm/s requested by the producing lane, 0 = pick from the configuration by feature.
    pub speed: f64,
    pub flow_ratio: f64,
    pub closed: bool,
}

impl Stroke {
    pub fn n_segs(&self) -> usize { if self.closed { self.pts.len() } else { self.pts.len().saturating_sub(1) } }
    pub fn seg(&self, i: usize) -> (P2, P2) { (self.pts[i], self.pts[(i + 1) % self.pts.len()]) }
    pub fn first(&self) -> P2 { self.pts[0] }
    pub fn last(&self) -> P2 { if self.closed { self.pts[0] } else { *self.pts.last().unwrap() } }
    pub fn length(&self) -> f64 { (0..self.n_segs()).map(|i| { let (a, b) = self.seg(i); geo::dist(a, b) }).sum() }
    /// The dominant feature (first segment's).
    pub fn feature(&self) -> Feature { self.feat.first().copied().unwrap_or(Feature::Custom) }

    pub fn from_ext(p: &ExtPath) -> Option<Stroke> {
        let mut pts: Vec<P2> = Vec::with_capacity(p.pts.len());
        let mut ws: Vec<f64> = Vec::with_capacity(p.pts.len());
        for q in &p.pts {
            // drop immediate duplicates, they would be zero-length segments
            if let Some(l) = pts.last() { if geo::dist(*l, [q.x, q.y]) < 1e-9 { continue; } }
            pts.push([q.x, q.y]);
            ws.push(q.w);
        }
        let mut closed = p.closed;
        if closed && pts.len() > 2 && geo::dist(pts[0], *pts.last().unwrap()) < 1e-9 { pts.pop(); ws.pop(); }
        if pts.len() < 2 { return None; }
        if pts.len() == 2 { closed = false; }
        let n = if closed { pts.len() } else { pts.len() - 1 };
        let w: Vec<f64> = (0..n).map(|i| 0.5 * (ws[i] + ws[(i + 1) % pts.len()])).collect();
        let fr = if p.flow_ratio > 0.0 { p.flow_ratio } else { 1.0 };
        Some(Stroke { feat: vec![p.feature; n], pts, w, h: p.layer_h, speed: p.speed, flow_ratio: fr, closed })
    }

    /// Reverse the direction of an open stroke.
    pub fn reversed(&self) -> Stroke {
        let mut s = self.clone();
        if s.closed {
            // keep the first vertex, flip the rest
            let n = s.pts.len();
            let mut pts = vec![s.pts[0]];
            pts.extend(s.pts[1..].iter().rev().copied());
            let mut w = Vec::with_capacity(n);
            let mut f = Vec::with_capacity(n);
            // segment i of the reversed loop is old segment (n-1-i)
            for i in 0..n { w.push(s.w[n - 1 - i]); f.push(s.feat[n - 1 - i]); }
            s.pts = pts; s.w = w; s.feat = f;
        } else {
            s.pts.reverse(); s.w.reverse(); s.feat.reverse();
        }
        s
    }
}

pub fn is_wall(f: Feature) -> bool { matches!(f, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall) }
pub fn is_external(f: Feature) -> bool { f == Feature::OuterWall }
pub fn is_infill_like(f: Feature) -> bool {
    matches!(f, Feature::SparseInfill | Feature::InternalSolidInfill | Feature::TopSurface | Feature::BottomSurface
        | Feature::InternalBridge | Feature::Bridge | Feature::GapInfill)
}

/// Merge consecutive open wall paths that chain end-to-start and close on the first start into closed loops
/// (lane 2 may split a loop where its role changes to an overhang wall).
fn merge_wall_chains(strokes: Vec<Stroke>) -> Vec<Stroke> {
    let tol = 2e-3;
    // Orca stops a wall loop `seam_gap` short of its start, so a loop that was split at role changes closes within
    // a few tenths of a millimetre rather than exactly
    let close_tol = 0.1;
    let mut out: Vec<Stroke> = Vec::with_capacity(strokes.len());
    let mut i = 0;
    while i < strokes.len() {
        let s = &strokes[i];
        if !s.closed && s.feat.iter().all(|f| is_wall(*f)) {
            // try to extend
            let mut j = i;
            let mut closed_at = None;
            let mut end = s.last();
            let start = s.first();
            while j + 1 < strokes.len() {
                let n = &strokes[j + 1];
                if n.closed || !n.feat.iter().all(|f| is_wall(*f)) || geo::dist(end, n.first()) > tol { break; }
                j += 1;
                end = n.last();
                if geo::dist(end, start) <= close_tol && j > i { closed_at = Some(j); break; }
            }
            if let Some(j) = closed_at {
                let mut pts: Vec<P2> = Vec::new();
                let mut w = Vec::new();
                let mut f = Vec::new();
                for k in i..=j {
                    let t = &strokes[k];
                    // vertices pts[0..m-1): the last vertex of piece k equals the first of piece k+1 (or the loop start)
                    for v in 0..t.pts.len() - 1 { pts.push(t.pts[v]); }
                    for sgi in 0..t.n_segs() { w.push(t.w[sgi]); f.push(t.feat[sgi]); }
                }
                let n = pts.len();
                if w.len() == n {
                    out.push(Stroke { pts, w, feat: f, h: strokes[i].h, speed: strokes[i].speed, flow_ratio: strokes[i].flow_ratio, closed: true });
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(strokes[i].clone());
        i += 1;
    }
    out
}

pub fn strokes_of(paths: &[ExtPath]) -> Vec<Stroke> {
    merge_wall_chains(paths.iter().filter_map(Stroke::from_ext).collect())
}

/// One island's worth of strokes.
#[derive(Clone, Debug, Default)]
pub struct Island {
    pub contour: Vec<P2>,
    pub centroid: P2,
    pub walls: Vec<Stroke>,
    pub infill: Vec<Vec<Stroke>>, // runs
    pub ironing: Vec<Stroke>,
    pub other: Vec<Stroke>, // everything else (supports, custom) in given order
}

/// Island polygons for a layer. If the caller supplied the layer's slices they are used; otherwise the contours
/// are recovered from the closed outer-wall loops (nesting parity: even = contour, odd = hole).
pub fn island_contours(strokes: &[Stroke], slices: Option<&Polys>) -> Vec<Poly> {
    if let Some(s) = slices { if !s.is_empty() { return s.clone(); } }
    let loops: Vec<&Stroke> = strokes.iter().filter(|s| s.closed && s.feat.iter().any(|f| *f == Feature::OuterWall)).collect();
    let rings: Vec<Vec<P2>> = loops.iter().map(|l| l.pts.clone()).collect();
    let areas: Vec<f64> = rings.iter().map(|r| geo::signed_area(r).abs()).collect();
    let mut depth = vec![0usize; rings.len()];
    for i in 0..rings.len() {
        for j in 0..rings.len() {
            if i != j && areas[j] > areas[i] && geo::in_ring(rings[i][0], &rings[j]) { depth[i] += 1; }
        }
    }
    // The slice boundary is half a bead outside the outer-wall centre line (sharp corners: mitre join).
    let half: Vec<f64> = loops.iter().map(|l| l.w.first().copied().unwrap_or(0.0) * 0.5).collect();
    let mut polys: Vec<Poly> = Vec::new();
    let mut idx_of: Vec<Option<usize>> = vec![None; rings.len()];
    for i in 0..rings.len() {
        if depth[i] % 2 == 0 {
            let mut c = rings[i].clone();
            if geo::signed_area(&c) < 0.0 { c.reverse(); }
            let c = geo::offset_ring_miter(&c, half[i]).into_iter().next().unwrap_or(c);
            idx_of[i] = Some(polys.len());
            polys.push(Poly { contour: c, holes: vec![] });
        }
    }
    for i in 0..rings.len() {
        if depth[i] % 2 == 1 {
            // hole of the smallest enclosing contour
            let mut best: Option<usize> = None;
            for j in 0..rings.len() {
                if depth[j] % 2 == 0 && areas[j] > areas[i] && geo::in_ring(rings[i][0], &rings[j]) {
                    if best.map_or(true, |b| areas[j] < areas[b]) { best = Some(j); }
                }
            }
            if let Some(b) = best {
                let mut h = rings[i].clone();
                if geo::signed_area(&h) > 0.0 { h.reverse(); }
                // a hole boundary lies half a bead INSIDE the hole's outer-wall centre line
                let mut hh = h.clone(); hh.reverse();
                let grown = geo::offset_ring_miter(&hh, -half[i]).into_iter().next().map(|mut r| { r.reverse(); r }).unwrap_or(h);
                polys[idx_of[b].unwrap()].holes.push(grown);
            }
        }
    }
    polys
}

/// Group a layer's strokes into islands (Orca: the first point of each entity decides, smallest bbox first).
pub fn group_islands(strokes: Vec<Stroke>, polys: &[Poly]) -> (Vec<Island>, Island) {
    let mut order: Vec<usize> = (0..polys.len()).collect();
    let area = |p: &Poly| geo::bbox(&p.contour).map(|(lo, hi)| (hi[0] - lo[0]) * (hi[1] - lo[1])).unwrap_or(0.0);
    order.sort_by(|a, b| area(&polys[*a]).partial_cmp(&area(&polys[*b])).unwrap().then(a.cmp(b)));
    let mut islands: Vec<Island> = polys.iter().map(|p| Island { contour: p.contour.clone(), centroid: geo::centroid(&p.contour), ..Default::default() }).collect();
    let mut extra = Island::default();
    // runs are formed per island in input order
    let mut last_feat: Vec<Option<Feature>> = vec![None; islands.len()];
    let mut last_run_extra: Option<Feature> = None;
    for s in strokes {
        let f = s.feature();
        let p = s.first();
        let target = order.iter().copied().find(|&i| geo::in_ring(p, &polys[i].contour));
        let isl = match target { Some(i) => &mut islands[i], None => &mut extra };
        let lf = match target { Some(i) => &mut last_feat[i], None => &mut last_run_extra };
        if is_wall(f) {
            isl.walls.push(s);
        } else if f == Feature::Ironing {
            isl.ironing.push(s);
        } else if is_infill_like(f) {
            if lf.map_or(true, |l| l != f) || isl.infill.is_empty() { isl.infill.push(Vec::new()); }
            *lf = Some(f);
            isl.infill.last_mut().unwrap().push(s);
        } else {
            isl.other.push(s);
        }
    }
    (islands, extra)
}

/// Squared distance between two segments.
fn seg_seg_d2(a: P2, b: P2, c: P2, d: P2) -> f64 {
    fn pt_seg(p: P2, a: P2, b: P2) -> f64 {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
        let (qx, qy) = (a[0] + t * dx, a[1] + t * dy);
        (p[0] - qx).powi(2) + (p[1] - qy).powi(2)
    }
    // proper crossing -> 0
    let o = |p: P2, q: P2, r: P2| (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    let (o1, o2, o3, o4) = (o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b));
    if o1 * o2 < 0.0 && o3 * o4 < 0.0 { return 0.0; }
    pt_seg(a, c, d).min(pt_seg(b, c, d)).min(pt_seg(c, a, b)).min(pt_seg(d, a, b))
}

/// Is the closest approach of two strokes at most `tau`?
fn strokes_within(a: &Stroke, b: &Stroke, tau: f64) -> bool {
    let bb = |s: &Stroke| {
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for p in &s.pts { for k in 0..2 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } }
        (lo, hi)
    };
    let (alo, ahi) = bb(a);
    let (blo, bhi) = bb(b);
    if alo[0] > bhi[0] + tau || blo[0] > ahi[0] + tau || alo[1] > bhi[1] + tau || blo[1] > ahi[1] + tau { return false; }
    let t2 = tau * tau;
    for i in 0..a.n_segs() {
        let (p, q) = a.seg(i);
        let (slo, shi) = ([p[0].min(q[0]) - tau, p[1].min(q[1]) - tau], [p[0].max(q[0]) + tau, p[1].max(q[1]) + tau]);
        if slo[0] > bhi[0] || blo[0] > shi[0] || slo[1] > bhi[1] || blo[1] > shi[1] { continue; }
        for j in 0..b.n_segs() {
            let (c, d) = b.seg(j);
            if c[0].min(d[0]) > shi[0] || c[0].max(d[0]) < slo[0] || c[1].min(d[1]) > shi[1] || c[1].max(d[1]) < slo[1] { continue; }
            if seg_seg_d2(p, q, c, d) <= t2 { return true; }
        }
    }
    false
}

/// Split a run of `no_sort` fill paths (monotonic, concentric: Orca keeps one `ExtrusionEntityCollection` per fill island
/// whole) into its collections. The run is the concatenation of those collections in print order and the producer does
/// not record where one ends, so the boundary is recovered geometrically: paths of ONE island lie one fill spacing apart
/// (neighbouring threads / nested loops), paths of two islands are separated by at least the walls between them.
pub fn split_collections(run: &[Stroke]) -> Vec<Vec<Stroke>> {
    let mut out: Vec<Vec<Stroke>> = Vec::new();
    for s in run {
        let tau = 1.35 * s.w.iter().cloned().fold(0.0, f64::max).max(0.1);
        let joins = out.last().map_or(false, |c: &Vec<Stroke>| c.iter().rev().take(2).any(|t| strokes_within(t, s, tau)));
        if joins { out.last_mut().unwrap().push(s.clone()); } else { out.push(vec![s.clone()]); }
    }
    out
}

/// `chain_and_reorder_extrusion_entities` over units (a unit is a single path, or a whole `no_sort` collection): the
/// visiting order as (unit index, reversed). `can_reverse(i)` is `ExtrusionEntity::can_reverse()` of unit `i`.
pub fn chain_units(units: &[Vec<Stroke>], from: P2, can_reverse: &dyn Fn(usize) -> bool) -> Vec<(usize, bool)> {
    if units.is_empty() { return Vec::new(); }
    let ends: Vec<([f64; 2], [f64; 2])> = units.iter().map(|r| (chain::scaled(r[0].first()), chain::scaled(r.last().unwrap().last()))).collect();
    chain::chain_segments_greedy(&ends, can_reverse, true, Some(chain::scaled(from)))
}

/// Order the infill runs like `chain_and_reorder_extrusion_entities` (Orca's greedy multi-fragment chaining, see
/// `motion::chain`; a run may be walked backwards -- its paths reversed and their order flipped -- when
/// `can_reverse(run)`), keeping each run's internal order.
pub fn chain_runs(runs: Vec<Vec<Stroke>>, from: P2, can_reverse: &dyn Fn(&[Stroke]) -> bool) -> Vec<Vec<Stroke>> {
    if runs.is_empty() { return runs; }
    let ends: Vec<([f64; 2], [f64; 2])> = runs.iter().map(|r| (chain::scaled(r[0].first()), chain::scaled(r.last().unwrap().last()))).collect();
    let order = chain::chain_segments_greedy(&ends, &|i| can_reverse(&runs[i]), true, Some(chain::scaled(from)));
    let mut slots: Vec<Option<Vec<Stroke>>> = runs.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(slots.len());
    for (i, rev) in order {
        let mut run = slots[i].take().expect("chain order repeats a run");
        if rev {
            run.reverse();
            run = run.into_iter().map(|s| s.reversed()).collect();
        }
        out.push(run);
    }
    out
}

/// `ExtrusionEntityCollection::chained_path_from`: Orca's greedy chaining of the paths of one (sortable) collection.
/// `can_reverse(path)` is `ExtrusionEntity::can_reverse()` (loops are always reversible): Orca marks the paths of a
/// `grid` sparse infill as not reversible (`Fill.cpp`: `if pattern == ipGrid then params.can_reverse = false`).
pub fn chain_paths(paths: Vec<Stroke>, from: P2, can_reverse: &dyn Fn(&Stroke) -> bool) -> Vec<Stroke> {
    if paths.is_empty() { return paths; }
    let ends: Vec<([f64; 2], [f64; 2])> = paths.iter().map(|s| (chain::scaled(s.first()), chain::scaled(s.last()))).collect();
    let order = chain::chain_segments_greedy(&ends, &|i| paths[i].closed || can_reverse(&paths[i]), true, Some(chain::scaled(from)));
    let mut slots: Vec<Option<Stroke>> = paths.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(slots.len());
    for (i, rev) in order {
        let s = slots[i].take().expect("chain order repeats a path");
        out.push(if rev { s.reversed() } else { s });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PathPt;

    fn path(f: Feature, pts: &[(f64, f64)], closed: bool) -> ExtPath {
        ExtPath { feature: f, pts: pts.iter().map(|p| PathPt { x: p.0, y: p.1, w: 0.42 }).collect(), closed, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 }
    }

    #[test]
    fn merges_split_wall_loop() {
        let a = path(Feature::OuterWall, &[(0., 0.), (10., 0.), (10., 10.)], false);
        let b = path(Feature::OverhangWall, &[(10., 10.), (0., 10.), (0., 0.)], false);
        let s = strokes_of(&[a, b]);
        assert_eq!(s.len(), 1);
        assert!(s[0].closed);
        assert_eq!(s[0].pts.len(), 4);
        assert_eq!(s[0].feat, vec![Feature::OuterWall, Feature::OuterWall, Feature::OverhangWall, Feature::OverhangWall]);
    }

    #[test]
    fn no_sort_run_splits_into_fill_islands() {
        // threads one bead apart are ONE Orca collection (kept whole), a path a wall away starts the next island
        let line = |y: f64, x0: f64, x1: f64| path(Feature::InternalSolidInfill, &[(x0, y), (x1, y)], false);
        let st = strokes_of(&[line(0.0, 0.0, 10.0), line(0.45, 10.0, 0.0), line(0.9, 0.0, 10.0), line(2.5, 0.0, 10.0), line(2.95, 10.0, 0.0), line(40.0, 0.0, 3.0)]);
        let c = split_collections(&st);
        assert_eq!(c.iter().map(|g| g.len()).collect::<Vec<_>>(), vec![3, 2, 1]);
        // crossing / touching strokes are within reach too
        let x = strokes_of(&[path(Feature::InternalSolidInfill, &[(0., 0.), (10., 10.)], false), path(Feature::InternalSolidInfill, &[(0., 10.), (10., 0.)], false)]);
        assert_eq!(split_collections(&x).len(), 1);
    }

    #[test]
    fn islands_from_outer_walls() {
        let sq = |x0: f64, y0: f64, x1: f64, y1: f64| vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
        let paths = vec![
            path(Feature::OuterWall, &sq(0., 0., 20., 20.), true),
            path(Feature::OuterWall, &sq(5., 5., 8., 8.), true), // a hole
            path(Feature::OuterWall, &sq(30., 0., 40., 10.), true),
            path(Feature::SparseInfill, &[(2., 2.), (4., 2.)], false),
            path(Feature::SparseInfill, &[(32., 2.), (36., 2.)], false),
        ];
        let st = strokes_of(&paths);
        let polys = island_contours(&st, None);
        assert_eq!(polys.len(), 2);
        assert_eq!(polys[0].holes.len(), 1);
        let (isl, extra) = group_islands(st, &polys);
        assert_eq!(isl.len(), 2);
        assert_eq!(isl[0].walls.len(), 2);
        assert_eq!(isl[0].infill.len(), 1);
        assert_eq!(isl[1].infill.len(), 1);
        assert!(extra.walls.is_empty());
    }
}
