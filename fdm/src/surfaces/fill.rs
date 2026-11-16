//! Solid-surface fills: `group_fills` (surface -> pattern / density / flow / angle / feature) and the line
//! fill of `FillRectilinear::fill_surface_by_lines` for the rectilinear, monotonic and monotonic-line patterns.
//!
//! Geometry of one island, in the frame where the threads are vertical (x = const):
//! * threads are cut from the region shrunk by 0.05 spacing ("outer") and the region shrunk by 0.5 spacing ("inner");
//! * a thread that is linked to a neighbour spans the inner polygon, the link follows the inner contour, and only
//!   the two ends of a polyline are stretched out to the outer polygon;
//! * 100 % fills adjust the spacing so a whole number of threads fills the bounding box (max +20 %), which also
//!   widens the bead (`Flow::with_spacing`).
use super::ops::*;
use super::{Classified, FlowRole, LayerGeom, SolidPattern, Surface, SurfaceCfg, SurfaceType as T};
use crate::types::{ExtPath, Feature, PathPt, Poly, Polys};
use std::f64::consts::PI;

use super::flow::Flow;
use super::narrow;

// ------------------------------------------------------------------------------------------------ grouping
#[derive(Clone, Debug)]
struct Params {
    feature: Feature,
    pattern: SolidPattern,
    density: f64,
    /// Thread direction in radians (before the per-layer alternation); `bridge_angle >= 0` overrides it.
    angle: f64,
    fixed_angle: bool,
    bridge_angle: f64,
    flow: Flow,
    bridge: bool,
    dont_adjust: bool,
    connect: bool,
}

impl Params {
    fn same(&self, o: &Params) -> bool {
        self.feature == o.feature && self.pattern == o.pattern && (self.density - o.density).abs() < 1e-12
            && (self.angle - o.angle).abs() < 1e-12 && self.fixed_angle == o.fixed_angle
            && (self.bridge_angle - o.bridge_angle).abs() < 1e-12 && self.flow == o.flow && self.bridge == o.bridge
            && self.dont_adjust == o.dont_adjust
    }
}

fn params_for(s: &Surface, layer: usize, h: f64, cfg: &SurfaceCfg) -> Option<Params> {
    let ty = s.ty;
    if ty == T::Internal { return None; }
    let role = if ty.is_top() { FlowRole::TopSolidInfill } else { FlowRole::SolidInfill };
    let is_bridge = layer + cfg.raft_layers > 0 && ty.is_bridge();
    let pattern;
    let mut density;
    if ty.is_external() && !is_bridge {
        if ty.is_top() {
            pattern = cfg.top_pattern;
            density = cfg.top_density;
            if density <= 0.0 { return None; }
        } else {
            pattern = cfg.bottom_pattern;
            density = cfg.bottom_density;
        }
    } else if ty == T::InternalSolid {
        pattern = cfg.solid_pattern;
        density = 1.0;
    } else {
        // bridges, and external surfaces on layer 0 that are typed as bridges
        pattern = if matches!(cfg.top_pattern, SolidPattern::Monotonic | SolidPattern::MonotonicLine) { SolidPattern::Monotonic } else { SolidPattern::Rectilinear };
        density = 1.0;
    }
    let feature = if is_bridge {
        if ty == T::InternalBridge { Feature::InternalBridge } else { Feature::Bridge }
    } else if ty.is_top() { Feature::TopSurface } else if ty.is_bottom() { Feature::BottomSurface } else { Feature::InternalSolidInfill };
    let (mut angle, mut fixed) = (cfg.solid_direction, false);
    if ty.is_top() { if let Some(a) = cfg.top_layer_direction { angle = a; fixed = true; } }
    if ty.is_bottom() { if let Some(a) = cfg.bottom_layer_direction { angle = a; fixed = true; } }
    let thick = ty.is_bridge() && if ty == T::InternalBridge { cfg.thick_internal_bridges } else { cfg.thick_bridges };
    let flow = if is_bridge { cfg.bridging_flow(role, layer, h, thick) } else { cfg.flow(role, layer, h) };
    let mut dont_adjust = false;
    if is_bridge && ty.is_external() && density > 0.99 {
        density = cfg.bridge_density;
        dont_adjust = true;
    }
    if ty == T::InternalBridge {
        density = cfg.internal_bridge_density;
        dont_adjust = true;
    }
    let connect = pattern != SolidPattern::MonotonicLine;
    Some(Params { feature, pattern, density, angle, fixed_angle: fixed, bridge_angle: if is_bridge { s.bridge_angle } else { -1.0 }, flow, bridge: is_bridge, dont_adjust, connect })
}

pub fn fill_layer(layer: usize, layers: &[LayerGeom], cl: &Classified, cfg: &SurfaceCfg) -> Vec<ExtPath> {
    let h = layers[layer].h;
    let mut groups: Vec<(Params, Polys)> = vec![];
    for s in &cl.fill[layer] {
        let Some(p) = params_for(s, layer, h, cfg) else { continue };
        match groups.iter_mut().find(|g| g.0.same(&p)) {
            Some(g) => g.1.push(s.poly.clone()),
            None => groups.push((p, vec![s.poly.clone()])),
        }
    }
    // Bridges are processed first (decreasing bridge angle), then the rest in surface order.
    groups.sort_by(|a, b| b.0.bridge_angle.partial_cmp(&a.0.bridge_angle).unwrap());
    let mut out = vec![];
    let mut done: Polys = vec![];
    for (p, polys) in groups {
        let region = if done.is_empty() { u(&polys) } else { df(&polys, &done) };
        done = un(&done, &polys);
        if p.feature == Feature::InternalSolidInfill && cfg.detect_narrow_internal_solid {
            let (normal, narrow) = narrow::split_solid_surface(&region, p.flow.spacing, p.angle, layer + cfg.raft_layers);
            if narrow.is_empty() {
                for isl in &region { out.extend(fill_island(isl, layer, &p, cfg, h)); }
            } else {
                // after a split Orca's normal part keeps the nominal spacing
                let mut q = p.clone();
                q.dont_adjust = true;
                for isl in &normal { out.extend(fill_island(isl, layer, &q, cfg, h)); }
                    out.extend(concentric_internal(&narrow, &layers[layer].fill_no_overlap, object_center(layers), &p, h, cfg));
                }
        } else {
            for isl in &region { out.extend(fill_island(isl, layer, &p, cfg, h)); }
        }
    }
    out
}

/// `FillConcentricInternal::fill_surface_extrusion`: Arachne (`WallToolPaths`) over the no-overlap region of each narrow
/// island, loops/lines turned into variable-width paths by `variable_width` (VariableWidth.cpp).
fn concentric_internal(narrow: &Polys, no_overlap: &Polys, origin: Pt, p: &Params, h: f64, cfg: &SurfaceCfg) -> Vec<ExtPath> {
    use crate::arachne::{wall_tool_paths, WallToolPathsParams};
    use crate::walls::{variable_width, ThickPolyline};
    let mut out = vec![];
    let sp = p.flow.spacing;
    let min_spacing = (sp * 1e6).round() as i64;
    let nozzle = cfg.nozzle;
    let params = WallToolPathsParams {
        min_bead_width: (0.85 * nozzle * 1e6).round() as i64,
        min_feature_size: (0.25 * nozzle * 1e6).round() as i64,
        min_length_factor: cfg.min_length_factor as f32,
        wall_transition_length: 400_000,
        wall_transition_angle: 10.0,
        wall_transition_filter_deviation: (0.25 * nozzle * 1e6).round() as i64,
        wall_distribution_count: 1,
        is_top_or_bottom_layer: false,
        wall_maximum_resolution: (cfg.wall_max_resolution * 1e6).round() as i64,
        wall_maximum_deviation: (cfg.wall_max_deviation * 1e6).round() as i64,
    };
    let mut thick: Vec<ThickPolyline> = vec![];
    for isl in narrow {
        // intersection_ex(no_overlap, expoly, ApplySafetyOffset::Yes)
        let pieces: Polys = if no_overlap.is_empty() { vec![isl.clone()] } else { it(&off(no_overlap, 1e-5), &vec![isl.clone()]) };
        for piece in &pieces {
            let one = vec![snap_poly(piece)];
            let Some(bb) = bbox(&one) else { continue };
            let size = ((bb[2] - bb[0]).max(bb[3] - bb[1]) * 1e6).round() as i64;
            let loops_count = size / min_spacing.max(1) + 1;
            // 🔴 An Err here used to `continue`: the narrow solid region was dropped with no word, a hole in
            // a solid layer. It is raised instead, and `pipeline::guard` turns it into a refusal (bughunt 2026-11-15).
            let res = match wall_tool_paths(&one, min_spacing, min_spacing, loops_count, 0, h, &params) {
                Ok(r) => r,
                Err(e) => panic!("concentric fill of a narrow solid region failed ({e:?}); the layer would have a hole there"),
            };
            let first_idx = thick.len();
            let origin_mm = [origin[0], origin[1]];
            for inset in &res.toolpaths {
                for line in inset {
                    if line.junctions.len() < 2 { continue; }
                    let mut pts: Vec<Pt> = line.junctions.iter().map(|j| [j.p[0] as f64 / 1e6, j.p[1] as f64 / 1e6]).collect();
                    let mut ws: Vec<f64> = line.junctions.iter().map(|j| j.w as f64 / 1e6).collect();
                    if line.is_closed && (pts[0] != *pts.last().unwrap()) { pts.push(pts[0]); ws.push(ws[0]); }
                    let closed_same = line.is_closed && pts.first() == pts.last() && ws.first() == ws.last();
                    if closed_same && pts.len() > 3 {
                        // start at the vertex nearest to the (object-space) origin; `last_pos` is never updated in Orca
                        pts.pop(); ws.pop();
                        let ni = (0..pts.len()).min_by(|&a, &b| dist(pts[a], origin_mm).partial_cmp(&dist(pts[b], origin_mm)).unwrap()).unwrap();
                        pts.rotate_left(ni); ws.rotate_left(ni);
                        pts.push(pts[0]); ws.push(ws[0]);
                    }
                    let mut width = Vec::with_capacity(2 * (pts.len() - 1));
                    for i in 0..pts.len() - 1 { width.push(ws[i]); width.push(ws[i + 1]); }
                    thick.push(ThickPolyline { points: pts, width, endpoints: (false, false) });
                }
            }
            // clip the end by seam_gap, keep valid polylines only
            let mut j = first_idx;
            for i in first_idx..thick.len() {
                let mut t = thick[i].clone();
                clip_end_pts(&mut t.points, cfg.seam_gap);
                if t.points.len() >= 2 { thick[j] = t; j += 1; }
            }
            thick.truncate(j);
            // Orca's G-code prints each narrow piece innermost bead first (dot, then loops inner -> outer): the reverse of
            // the Arachne inset order. Measured on gk_edges_223x223 (the chained order of the pieces follows piece order).
            thick[first_idx..].reverse();
        }
    }
    let flow = p.flow;
    for group in variable_width(&thick, crate::walls::Flow::new(flow.width, h)) {
        for w in group {
            out.push(ExtPath { feature: p.feature, pts: w.pts.iter().map(|q| PathPt { x: q[0], y: q[1], w: w.width }).collect(), closed: false, layer_h: h, speed: 0.0, flow_ratio: 1.0 });
        }
    }
    out
}

/// `Polyline::clip_end`.
fn clip_end_pts(pts: &mut Vec<Pt>, mut distance: f64) {
    while distance > 0.0 {
        let last = *pts.last().unwrap();
        pts.pop();
        if pts.is_empty() { return; }
        let l = *pts.last().unwrap();
        let v = [l[0] - last[0], l[1] - last[1]];
        let len = v[0].hypot(v[1]);
        if len > distance {
            pts.push([last[0] + v[0] * (distance / len), last[1] + v[1] * (distance / len)]);
            break;
        }
        distance -= len;
    }
}

fn fill_island(isl: &Poly, layer: usize, p: &Params, cfg: &SurfaceCfg, h: f64) -> Vec<ExtPath> {
    // thread direction
    let dir = if p.bridge_angle >= 0.0 { p.bridge_angle } else {
        let alt = if !p.fixed_angle && (layer + cfg.raft_layers) % 2 == 1 { PI / 2.0 } else { 0.0 };
        p.angle + alt
    };
    // Full-density fills (top / bottom / internal solid / bridges): Orca's FillRectilinear chaining
    // (monotonic ordering, zig-zag alternation of unconnected lines) as ported in effects::rect.
    let (lines, spacing) = if p.density > 0.9999 {
        let rp = crate::effects::rect::RectParams {
            spacing: p.flow.spacing, density: p.density, theta: dir - PI / 2.0, overlap: 0.0,
            dont_adjust: p.dont_adjust, link_max_length: 0.0, dont_connect: !p.connect,
            monotonic: p.pattern != SolidPattern::Rectilinear, consistent_pattern: false, ref_point: [0.0, 0.0],
        };
        crate::effects::rect::fill_by_lines(isl, &rp)
    } else {
        line_fill(isl, dir, p.flow.spacing, p.density, !p.dont_adjust, p.connect)
    };
    if lines.is_empty() { return vec![]; }
    let flow = if p.flow.bridge { p.flow } else { p.flow.with_spacing(spacing) };
    let layer_h = if flow.bridge { flow.height } else { h };
    let rect_area = (flow.width - layer_h * (1.0 - PI / 4.0)) * layer_h;
    let flow_ratio = if flow.bridge && rect_area > 0.0 { flow.mm3_per_mm() / rect_area } else { 1.0 };
    let _ = cfg;
    lines.into_iter().map(|pl| ExtPath {
        feature: p.feature,
        pts: pl.into_iter().map(|q| PathPt { x: q[0], y: q[1], w: flow.width }).collect(),
        closed: false,
        layer_h,
        speed: 0.0,
        flow_ratio,
    }).collect()
}

// ------------------------------------------------------------------------------------------------ line fill
/// `Fill::_adjust_solid_spacing`.
fn adjust_solid_spacing(width: f64, distance: f64) -> f64 {
    let n = ((width - 1e-9) / distance).floor();
    let new = if n < 1.0 { distance } else { (width - 1e-9) / n };
    if new / distance > 1.2 { distance * 1.2 } else { new }
}

#[derive(Clone, Copy, Debug)]
struct Seg { k: usize, lo: f64, hi: f64, ext_lo: f64, ext_hi: f64 }

#[derive(Clone, Copy, Debug)]
struct Ev { s: f64, k: usize, y: f64, seg: usize, high: bool }

/// Fill one island with threads at `dir` radians. Returns the polylines and the spacing actually used.
pub fn line_fill(isl: &Poly, dir: f64, spacing: f64, density: f64, adjust: bool, connect: bool) -> (Vec<Vec<Pt>>, f64) {
    if density <= 0.0 { return (vec![], spacing); }
    let rotation = PI / 2.0 - dir;
    let src = rotate_polys(&vec![isl.clone()], rotation);
    let outer = off(&src, -0.05 * spacing);
    let inner = off(&outer, -0.45 * spacing);
    if inner.is_empty() { return (vec![], spacing); }
    let Some(bb) = bbox(&src) else { return (vec![], spacing) };
    let full = density > 0.9999;
    let mut ls = spacing / density;
    if full && adjust { ls = adjust_solid_spacing(bb[2] - bb[0], ls); }
    let spacing_out = if full { ls } else { spacing };
    let x0 = bb[0] + (if full { (ls + EPS * 0.5) / 2.0 } else { 0.0 });
    let n_v = (((bb[2] - bb[0]) + ls * 0.5 - 1e-9) / ls).ceil().max(0.0) as usize + 1;

    // ---- crossings of the thread positions with the inner / outer rings
    let in_rings: Vec<&Vec<Pt>> = rings(&inner);
    let mut evs: Vec<Ev> = vec![];
    let mut per_k: Vec<Vec<usize>> = vec![vec![]; n_v];
    let mut ring_events: Vec<Vec<usize>> = vec![vec![]; in_rings.len()];
    for (ri, r) in in_rings.iter().enumerate() {
        let m = r.len();
        let mut cum = 0.0;
        for i in 0..m {
            let (a, b) = (r[i], r[(i + 1) % m]);
            let el = dist(a, b);
            let (lx, rx) = (a[0].min(b[0]), a[0].max(b[0]));
            if rx >= x0 && lx <= x0 + (n_v as f64) * ls {
                let k0 = (((lx - x0) / ls).floor().max(0.0)) as usize;
                let k1 = (((rx - x0) / ls).ceil().max(0.0)) as usize;
                for k in k0..=k1.min(n_v - 1) {
                    let x = x0 + k as f64 * ls;
                    if (a[0] <= x) != (b[0] <= x) {
                        let t = (x - a[0]) / (b[0] - a[0]);
                        let y = a[1] + t * (b[1] - a[1]);
                        let s = cum + el * t;
                        evs.push(Ev { s, k, y, seg: usize::MAX, high: false });
                        per_k[k].push(evs.len() - 1);
                        ring_events[ri].push(evs.len() - 1);
                    }
                }
            }
            cum += el;
        }
    }
    // outer intervals per thread
    let out_rings: Vec<&Vec<Pt>> = rings(&outer);
    let mut segs: Vec<Seg> = vec![];
    for k in 0..n_v {
        let x = x0 + k as f64 * ls;
        let mut ys: Vec<(f64, usize)> = per_k[k].iter().map(|&e| (evs[e].y, e)).collect();
        ys.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
        if ys.len() < 2 { continue; }
        let mut oy: Vec<f64> = vec![];
        for r in &out_rings {
            let m = r.len();
            for i in 0..m {
                let (a, b) = (r[i], r[(i + 1) % m]);
                if (a[0] <= x) != (b[0] <= x) { oy.push(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1])); }
            }
        }
        oy.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let ointervals: Vec<(f64, f64)> = oy.chunks(2).filter(|c| c.len() == 2).map(|c| (c[0], c[1])).collect();
        let mut i = 0;
        while i + 1 < ys.len() {
            let (lo, hi) = (ys[i].0, ys[i + 1].0);
            let (elo, ehi) = (ys[i].1, ys[i + 1].1);
            i += 2;
            if hi - lo < 1e-9 { continue; }
            let cont = ointervals.iter().find(|o| o.0 <= lo + 1e-7 && o.1 >= hi - 1e-7).copied().unwrap_or((lo, hi));
            let id = segs.len();
            segs.push(Seg { k, lo, hi, ext_lo: cont.0, ext_hi: cont.1 });
            evs[elo].seg = id; evs[elo].high = false;
            evs[ehi].seg = id; evs[ehi].high = true;
        }
    }
    // a segment that shares its outer interval with a lower / higher neighbour on the same thread is not extended there
    {
        let orig = segs.clone();
        for i in 0..segs.len() {
            for j in 0..orig.len() {
                if i != j && orig[i].k == orig[j].k && orig[j].ext_hi == orig[i].ext_hi && orig[j].ext_lo == orig[i].ext_lo {
                    if orig[j].hi < orig[i].lo + 1e-9 { segs[i].ext_lo = segs[i].lo; }
                    if orig[j].lo > orig[i].hi - 1e-9 { segs[i].ext_hi = segs[i].hi; }
                }
            }
        }
    }
    if segs.is_empty() { return (vec![], spacing_out); }

    // ---- links: consecutive crossings along a ring on neighbouring threads, same end type
    // link_of[seg][end] = list of (other seg, other end high?, points from this end to the other end)
    #[derive(Clone)]
    struct Link { to: usize, to_high: bool, pts: Vec<Pt> }
    let mut links: Vec<[Vec<Link>; 2]> = (0..segs.len()).map(|_| [vec![], vec![]]).collect();
    if connect {
        for (ri, r) in in_rings.iter().enumerate() {
            let mut order = ring_events[ri].clone();
            order.sort_by(|&a, &b| evs[a].s.partial_cmp(&evs[b].s).unwrap());
            let m = order.len();
            if m < 2 { continue; }
            let total = ring_len(r);
            let mut cum: Vec<f64> = Vec::with_capacity(r.len());
            let mut cacc = 0.0;
            for i in 0..r.len() { cum.push(cacc); cacc += dist(r[i], r[(i + 1) % r.len()]); }
            for j in 0..m {
                let (ea, eb) = (order[j], order[(j + 1) % m]);
                if ea == eb { continue; }
                let (a, b) = (evs[ea], evs[eb]);
                if a.seg == usize::MAX || b.seg == usize::MAX { continue; }
                if a.high != b.high { continue; }
                if (a.k as isize - b.k as isize).abs() != 1 { continue; }
                // arc points a -> b along the ring
                let mut pts = vec![[x0 + a.k as f64 * ls, a.y]];
                let s_end = if b.s >= a.s { b.s } else { b.s + total };
                for lap in 0..2 {
                    for i in 0..r.len() {
                        let sv = cum[i] + lap as f64 * total;
                        if sv > a.s + 1e-12 && sv < s_end - 1e-12 { pts.push(r[i]); }
                    }
                }
                pts.push([x0 + b.k as f64 * ls, b.y]);
                let rev: Vec<Pt> = pts.iter().rev().cloned().collect();
                links[a.seg][a.high as usize].push(Link { to: b.seg, to_high: b.high, pts });
                links[b.seg][b.high as usize].push(Link { to: a.seg, to_high: a.high, pts: rev });
            }
        }
    }

    // ---- chains
    let mut order: Vec<usize> = (0..segs.len()).collect();
    order.sort_by(|&a, &b| segs[a].k.cmp(&segs[b].k).then(segs[a].lo.partial_cmp(&segs[b].lo).unwrap()));
    let mut used = vec![false; segs.len()];
    let mut polylines: Vec<Vec<Pt>> = vec![];
    let xk = |k: usize| x0 + k as f64 * ls;
    let mut flip = false;
    for &s0 in &order {
        if used[s0] { continue; }
        // follow links to the right from segment `s`, exiting through `exit_high`
        let follow = |s: usize, exit_high: bool, used: &Vec<bool>| -> Vec<(usize, bool, usize)> {
            // (segment, exit_high, link index used to get *into* the next one)
            let mut chain = vec![(s, exit_high, usize::MAX)];
            let mut seen = vec![s];
            let (mut cs, mut ce) = (s, exit_high);
            loop {
                let cand = links[cs][ce as usize].iter().enumerate().find(|(_, l)| segs[l.to].k == segs[cs].k + 1 && !used[l.to] && !seen.contains(&l.to));
                let Some((li, l)) = cand else { break };
                let next = l.to;
                // enter `next` through the end we linked to, leave through the other one
                let next_exit_high = !l.to_high;
                chain.last_mut().unwrap().2 = li;
                chain.push((next, next_exit_high, usize::MAX));
                seen.push(next);
                cs = next; ce = next_exit_high;
            }
            chain
        };
        let up = follow(s0, true, &used);
        let down = follow(s0, false, &used);
        let chain = if down.len() > up.len() || (down.len() == up.len() && flip) { down } else { up };
        flip = !flip;
        for c in &chain { used[c.0] = true; }
        // build the polyline
        let mut pl: Vec<Pt> = vec![];
        for (j, &(s, exit_high, li)) in chain.iter().enumerate() {
            let sg = segs[s];
            let x = xk(sg.k);
            let entry_high = !exit_high;
            if j == 0 { pl.push([x, if entry_high { sg.ext_hi } else { sg.ext_lo }]); }
            pl.push([x, if exit_high { sg.hi } else { sg.lo }]);
            if j + 1 < chain.len() {
                let l = &links[s][exit_high as usize][li];
                for q in l.pts.iter().skip(1) { pl.push(*q); }
            }
        }
        let last = chain.last().unwrap();
        let sg = segs[last.0];
        *pl.last_mut().unwrap() = [xk(sg.k), if last.1 { sg.ext_hi } else { sg.ext_lo }];
        polylines.push(pl);
    }
    let back = -rotation;
    let (c, s) = (back.cos(), back.sin());
    let mut out: Vec<Vec<Pt>> = polylines.into_iter().map(|pl| {
        let mut o: Vec<Pt> = Vec::with_capacity(pl.len());
        for q in pl { let r = rot(q, c, s); if o.last().map_or(true, |l| dist(*l, r) > 1e-9) { o.push(r); } }
        o
    }).filter(|p| p.len() >= 2 && poly_len(p) > 1e-6).collect();
    // unconnected patterns: zigzag the thread directions to shorten the travel
    if !connect {
        for (i, pl) in out.iter_mut().enumerate() { if i % 2 == 1 { pl.reverse(); } }
    }
    (out, spacing_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Poly {
        Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }
    }
    fn total(l: &[Vec<Pt>]) -> f64 { l.iter().map(|p| poly_len(p)).sum() }
    #[test]
    fn square_unconnected_matches_area_over_spacing() {
        let (l, sp) = line_fill(&rect(0.0, 0.0, 10.0, 10.0), 0.0, 0.4, 1.0, true, false);
        // Orca truncates (width - eps) / spacing, so an exact multiple loses one interval: 24 threads at 10/24
        assert_eq!(l.len(), 24);
        assert!((sp - 10.0 / 24.0).abs() < 1e-9);
        // threads run between the outer polygon (region shrunk 0.05 * 0.4 per side)
        assert!((total(&l) - 24.0 * 9.96).abs() < 0.2, "{}", total(&l));
    }
    #[test]
    fn connected_square_is_one_zigzag() {
        let (l, sp) = line_fill(&rect(0.0, 0.0, 10.0, 10.0), 0.0, 0.4, 1.0, true, true);
        assert_eq!(l.len(), 1, "{}", l.len());
        // 24 threads over the inner span (10 - 0.4) + 23 links of one adjusted spacing + two end stretches of 0.18
        let want = 24.0 * 9.6 + 23.0 * sp + 2.0 * 0.18;
        assert!((total(&l) - want).abs() < 0.05, "{} vs {}", total(&l), want);
    }
    #[test]
    fn spacing_adjust_widens_up_to_20_percent() {
        // exact multiple: Orca's (width - EPSILON) truncation gives one interval less
        assert!((adjust_solid_spacing(10.0, 0.4) - 10.0 / 24.0).abs() < 1e-9);
        assert!((adjust_solid_spacing(10.1, 0.4) - 10.1 / 25.0).abs() < 1e-9);
        assert!((adjust_solid_spacing(0.5, 0.4) - 0.48).abs() < 1e-9);
    }
    #[test]
    fn hole_splits_threads_and_links_go_around() {
        let mut p = rect(0.0, 0.0, 20.0, 10.0);
        p.holes.push(vec![[8.0, 3.0], [8.0, 7.0], [12.0, 7.0], [12.0, 3.0]]);
        let (l, _) = line_fill(&p, 0.0, 0.4, 1.0, true, true);
        let t = total(&l);
        // area ~ 200 - 16 = 184 -> ~460 mm of 0.4 threads (within the links / edge shortening)
        assert!(t > 440.0 && t < 480.0, "{t}");
    }
}

/// Object-space origin Orca slices in (centre of the object's bounding box).
fn object_center(layers: &[LayerGeom]) -> Pt {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for l in layers {
        if let Some(b) = bbox(&l.slice) { x0 = x0.min(b[0]); y0 = y0.min(b[1]); x1 = x1.max(b[2]); y1 = y1.max(b[3]); }
    }
    if x0 > x1 { [0.0, 0.0] } else { [(x0 + x1) / 2.0, (y0 + y1) / 2.0] }
}

/// Snap a polygon to Orca's 1e-6 mm integer grid and drop repeated vertices (the float booleans leave sub-unit pairs).
fn snap_poly(p: &Poly) -> Poly {
    let snap = |r: &Vec<Pt>| -> Vec<Pt> {
        let mut o: Vec<Pt> = vec![];
        for q in r {
            let q = [(q[0] * 1e6).round() / 1e6, (q[1] * 1e6).round() / 1e6];
            if o.last() != Some(&q) { o.push(q); }
        }
        while o.len() > 1 && o.first() == o.last() { o.pop(); }
        o
    };
    Poly { contour: snap(&p.contour), holes: p.holes.iter().map(snap).collect() }
}


#[cfg(test)]
mod narrow_tests {
    use super::*;

    fn ring(r: f64, n: usize, ccw: bool) -> Vec<Pt> {
        let mut v: Vec<Pt> = (0..n).map(|i| { let a = 2.0 * PI * i as f64 / n as f64; [r * a.cos(), r * a.sin()] }).collect();
        if !ccw { v.reverse(); }
        v
    }
    fn test_params() -> Params {
        let flow = Flow::rect(0.42, 0.2);
        Params { feature: Feature::InternalSolidInfill, pattern: SolidPattern::Monotonic, density: 1.0, angle: 0.0, fixed_angle: false, bridge_angle: -1.0, flow, bridge: false, dont_adjust: true, connect: true }
    }
    fn cfg() -> SurfaceCfg { super::super::tests::cfg() }

    /// A 1.2 mm wide annulus (the wall of a 30 mm tube between its two wall loops): Arachne puts two 0.42-ish loops and a
    /// wider odd bead in it -- Orca prints E = 8.7 per layer for this ring (syn_hollow_cylinder, layers 1/2/145-148).
    #[test]
    fn annulus_gets_variable_width_beads_covering_the_ring() {
        let cfg = cfg();
        let p = test_params();
        let r: Polys = vec![Poly { contour: ring(13.9, 400, true), holes: vec![ring(12.7, 400, false)] }];
        let paths = concentric_internal(&r, &r, [0.0, 0.0], &p, 0.2, &cfg);
        assert!(paths.len() >= 3 && paths.len() <= 4, "{} paths", paths.len());
        // filament cross-section of everything printed ~ ring area * layer height (full coverage)
        let vol: f64 = paths.iter().map(|q| {
            let len: f64 = q.pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum();
            len * (q.pts[0].w - 0.2 * (1.0 - PI / 4.0)) * 0.2
        }).sum();
        let ring_vol = area(&r) * 0.2;
        assert!((vol / ring_vol - 1.0).abs() < 0.06, "printed {vol} vs ring volume {ring_vol}");
        // negative control: a ring thinner than the minimum feature gives no bead at all
        let thin: Polys = vec![Poly { contour: ring(13.9, 400, true), holes: vec![ring(13.85, 400, false)] }];
        assert!(concentric_internal(&thin, &thin, [0.0, 0.0], &p, 0.2, &cfg).is_empty());
    }

    /// The float booleans leave vertex pairs closer than a micron (syn_hollow_cylinder: 6.5e-7 mm apart); Arachne returned
    /// NOTHING for such a polygon (Orca prints 8.7 mm of filament per layer for that ring). `snap_poly` puts the polygon on
    /// Orca's 1e-6 mm grid and drops repeated vertices.
    #[test]
    fn snap_poly_merges_sub_micron_vertex_pairs() {
        let c: Vec<Pt> = vec![[124.569484, 127.530000327], [124.569484, 127.529999672], [124.59978265, 126.60447833], [130.0, 120.0], [135.0, 130.0]];
        let q = snap_poly(&Poly { contour: c, holes: vec![vec![[126.0, 124.0], [128.0, 124.0], [128.0, 126.0], [126.0, 126.0]]] });
        assert_eq!(q.contour.len(), 4, "{:?}", q.contour);
        assert!(q.contour.windows(2).all(|w| dist(w[0], w[1]) > 1e-6));
        assert_eq!(q.holes[0].len(), 4);
    }
}

