//! Lane 9: pure post-processors over per-layer path lists (`types::LayerPlan`).
//!
//!  * `optimize_travel`   island + infill ordering to cut travel length and retractions,
//!  * `rotate_seams`      seam placement alternatives (concave corner / aligned with the layer below) for exactly closed outer loops,
//!  * `balance_layer_time` which paths absorb a minimum-layer-time slowdown (hidden features first, outer wall last),
//!  * `verify_same_extrusion` the PROOF obligation: the extruded segment multiset is unchanged (same segments, different order/direction).
//!
//! Every function takes the plan by reference and returns a new one. Nothing here is called by the Orca-parity path.
//! Rules that keep print quality: walls, top/bottom surface and bridge lines keep their order AND direction; only runs of consecutive
//! sparse-infill / solid-infill / gap-fill / support paths of the SAME feature are reordered (and reversed), and islands are reordered only
//! when every island is printed as one contiguous block in the input (so "walls before infill" is never broken).
use crate::types::{ExtPath, Feature, LayerPlan, PathPt};
use std::collections::BTreeMap;

type P = [f64; 2];
fn d(a: P, b: P) -> f64 { (a[0] - b[0]).hypot(a[1] - b[1]) }

pub fn is_wall(f: Feature) -> bool { matches!(f, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall) }
/// Paths that may be reordered and reversed without changing the print (internal, never visible, order-insensitive).
pub fn reorderable(f: Feature) -> bool { matches!(f, Feature::SparseInfill | Feature::InternalSolidInfill | Feature::GapInfill | Feature::InternalBridge | Feature::Support) }
/// Orca `reduce_infill_retraction` (GCode.cpp `needs_retraction`, line ~8798, and `RetractWhenCrossingPerimeters::travel_inside_internal_regions`):
/// a non-perimeter move does not retract when the whole travel lies inside an INTERNAL slice (sparse / internal solid / internal bridge; not top or
/// bottom surfaces). Approximated here by 'previous and next path are internal infill kinds and the straight travel crosses no wall'.
/// Orca also skips the retraction for travel inside a support island; that is NOT modelled (support paths retract in the model).
fn is_infill_kind(f: Feature) -> bool { matches!(f, Feature::SparseInfill | Feature::InternalSolidInfill | Feature::GapInfill | Feature::InternalBridge) }

fn first(p: &ExtPath) -> P { [p.pts[0].x, p.pts[0].y] }
fn last(p: &ExtPath) -> P { let q = p.pts[p.pts.len() - 1]; if p.closed { [p.pts[0].x, p.pts[0].y] } else { [q.x, q.y] } }
fn reversed(p: &ExtPath) -> ExtPath { let mut q = p.clone(); q.pts.reverse(); q }

// ------------------------------------------------------------------------------------------------ travel model
#[derive(Clone, Debug)]
pub struct TravelModel {
    /// Orca `retraction_minimum_travel`.
    pub min_travel: f64,
    /// Orca `reduce_infill_retraction`: no retraction when an infill-to-infill travel crosses no wall.
    pub reduce_infill_retraction: bool,
    /// Two paths closer than this belong to the same island (ordering unit).
    pub island_gap: f64,
}
impl Default for TravelModel { fn default() -> Self { TravelModel { min_travel: 2.0, reduce_infill_retraction: true, island_gap: 1.0 } } }

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TravelStats {
    pub layers: usize,
    pub paths: usize,
    pub travels: usize,
    pub travel_mm: f64,
    pub retractions: usize,
    /// Islands (clusters at `island_gap`), summed over layers.
    pub islands: usize,
    /// Proven lower bound on `retractions` for ANY ordering of the same paths: sum over layers of (components at `min_travel` - 1).
    pub retraction_lower_bound: usize,
}

struct Walls { segs: Vec<(P, P)>, bb: Vec<[f64; 4]> }
fn walls_of(l: &LayerPlan) -> Walls {
    let mut w = Walls { segs: vec![], bb: vec![] };
    for p in l.paths.iter().filter(|p| is_wall(p.feature)) {
        let n = p.pts.len();
        let m = if p.closed { n } else { n - 1 };
        for i in 0..m { let (a, b) = (p.pts[i], p.pts[(i + 1) % n]); w.segs.push(([a.x, a.y], [b.x, b.y])); w.bb.push([a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y)]); }
    }
    w
}
fn cross2(o: P, a: P, b: P) -> f64 { (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]) }
/// Does the travel a->b properly cross a wall segment? Ends are shrunk by 0.1 mm so a travel that starts/ends ON a wall is not a crossing.
fn crosses(w: &Walls, a: P, b: P) -> bool {
    let l = d(a, b);
    if l < 0.3 { return false; }
    let (ux, uy) = ((b[0] - a[0]) / l, (b[1] - a[1]) / l);
    let (a, b) = ([a[0] + 0.1 * ux, a[1] + 0.1 * uy], [b[0] - 0.1 * ux, b[1] - 0.1 * uy]);
    let bb = [a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])];
    for (i, (c, e)) in w.segs.iter().enumerate() {
        let s = w.bb[i];
        if s[2] < bb[0] || s[0] > bb[2] || s[3] < bb[1] || s[1] > bb[3] { continue; }
        let (d1, d2, d3, d4) = (cross2(a, b, *c), cross2(a, b, *e), cross2(*c, *e, a), cross2(*c, *e, b));
        if d1 * d2 < 0.0 && d3 * d4 < 0.0 { return true; }
    }
    false
}

fn retracts(m: &TravelModel, w: &Walls, prev: &ExtPath, next: &ExtPath, a: P, b: P) -> bool {
    let dist = d(a, b);
    if dist < m.min_travel { return false; }
    if m.reduce_infill_retraction && is_infill_kind(prev.feature) && is_infill_kind(next.feature) && !crosses(w, a, b) { return false; }
    true
}

/// Union-find clusters of the paths of one layer: two paths are in one cluster when some sampled points are closer than `gap`.
pub fn clusters(l: &LayerPlan, gap: f64) -> Vec<usize> {
    let n = l.paths.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut Vec<usize>, x: usize) -> usize { let mut r = x; while p[r] != r { r = p[r]; } let mut c = x; while p[c] != r { let nx = p[c]; p[c] = r; c = nx; } r }
    let step = gap / 4.0; // sample spacing; the union radius is widened by it so connectivity is only ever over-estimated (keeps the lower bound valid)
    let rad = gap + step;
    let cell = rad;
    let mut grid: BTreeMap<(i64, i64), Vec<(usize, P)>> = BTreeMap::new();
    for (i, p) in l.paths.iter().enumerate() {
        let m = if p.closed { p.pts.len() } else { p.pts.len() - 1 };
        for k in 0..m {
            let (a, b) = (p.pts[k], p.pts[(k + 1) % p.pts.len()]);
            let len = d([a.x, a.y], [b.x, b.y]);
            let ns = ((len / step).ceil() as usize).max(1);
            for s in 0..=ns { let t = s as f64 / ns as f64; let q = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]; grid.entry(((q[0] / cell).floor() as i64, (q[1] / cell).floor() as i64)).or_default().push((i, q)); }
        }
    }
    for (&(cx, cy), pts) in &grid {
        for dx in -1..=1 { for dy in -1..=1 {
            if let Some(o) = grid.get(&(cx + dx, cy + dy)) {
                for &(i, p) in pts { for &(j, q) in o {
                    if i == j { continue; }
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    if a == b { continue; } // already one cluster: skip the distance test (this is what keeps dense layers fast)
                    if d(p, q) <= rad { parent[a.max(b)] = a.min(b); }
                } }
            }
        } }
    }
    let mut ids: BTreeMap<usize, usize> = BTreeMap::new();
    (0..n).map(|i| { let r = find(&mut parent, i); let k = ids.len(); *ids.entry(r).or_insert(k) }).collect()
}

/// Travel length and retraction count of a plan under `m`, travelling in print order (layer start from the previous layer's last point).
pub fn travel_stats(plans: &[LayerPlan], start: P, m: &TravelModel) -> TravelStats {
    let mut s = TravelStats::default();
    let mut pos = start;
    for l in plans {
        s.layers += 1;
        s.paths += l.paths.len();
        let w = walls_of(l);
        for (i, p) in l.paths.iter().enumerate() {
            let a = first(p);
            let dist = d(pos, a);
            if !(s.layers == 1 && i == 0 && start == [0.0, 0.0]) {
                if dist > 1e-9 {
                    s.travels += 1; s.travel_mm += dist;
                    let prev = if i > 0 { &l.paths[i - 1] } else { p };
                    if i == 0 { if dist >= m.min_travel { s.retractions += 1; } } else if retracts(m, &w, prev, p, pos, a) { s.retractions += 1; }
                }
            }
            pos = last(p);
        }
        let cl = clusters(l, m.island_gap);
        s.islands += cl.iter().copied().max().map_or(0, |x| x + 1);
        let cb = clusters(l, m.min_travel);
        s.retraction_lower_bound += cb.iter().copied().max().map_or(0, |x| x + 1).saturating_sub(1);
    }
    s
}

/// Per-travel model decisions in print order: `(layer, path index, retracts_per_model)` for every travel between paths (the layer's first path
/// travels from the previous layer's last point). Used to validate the retraction rule against Orca's actual retractions.
pub fn model_decisions(plans: &[LayerPlan], start: P, m: &TravelModel) -> Vec<(usize, usize, bool)> {
    let mut v = vec![];
    let mut pos = start;
    for (li, l) in plans.iter().enumerate() {
        let w = walls_of(l);
        for (i, p) in l.paths.iter().enumerate() {
            let a = first(p);
            let dec = if i == 0 { d(pos, a) >= m.min_travel } else { d(pos, a) > 1e-9 && retracts(m, &w, &l.paths[i - 1], p, pos, a) };
            v.push((li, i, dec));
            pos = last(p);
        }
    }
    v
}

/// Retractions between two consecutive paths that BOTH keep their order under the quality rules (walls, top/bottom surface, bridges, ...).
/// The optimiser cannot remove these, so `retractions - fixed_pair_retractions` is the part of the count it works on.
pub fn fixed_pair_retractions(plans: &[LayerPlan], start: P, m: &TravelModel) -> usize {
    let mut n = 0;
    let mut pos = start;
    for l in plans {
        let w = walls_of(l);
        for (i, p) in l.paths.iter().enumerate() {
            let a = first(p);
            if i > 0 && !reorderable(l.paths[i - 1].feature) && !reorderable(p.feature) && d(pos, a) > 1e-9 && retracts(m, &w, &l.paths[i - 1], p, pos, a) { n += 1; }
            pos = last(p);
        }
    }
    n
}

/// Retractions by (feature before, feature after, same island?) under the model (diagnostic; what is left to win).
pub fn retraction_breakdown(plans: &[LayerPlan], start: P, m: &TravelModel) -> BTreeMap<(&'static str, &'static str, bool), usize> {
    let mut out = BTreeMap::new();
    let mut pos = start;
    for l in plans {
        let w = walls_of(l);
        let cl = clusters(l, m.island_gap);
        for (i, p) in l.paths.iter().enumerate() {
            let a = first(p);
            if i > 0 && d(pos, a) > 1e-9 && retracts(m, &w, &l.paths[i - 1], p, pos, a) {
                *out.entry((l.paths[i - 1].feature.orca_name(), p.feature.orca_name(), cl[i - 1] == cl[i])).or_default() += 1;
            }
            pos = last(p);
        }
    }
    out
}

// ------------------------------------------------------------------------------------------------ run ordering
/// Travel cost used by the optimiser: distance plus `RETRACT_MM` when the model says this travel retracts (a retraction costs about as much
/// time as a long travel: retract + unretract + prime + the pressure loss).
pub const RETRACT_MM: f64 = 30.0;

/// Order `items` (each with endpoints a -> b, reversible) to minimise the travel cost from `from` through all of them to `to` (if given).
/// `edge(p, q)` is the cost of travelling p -> q (symmetric). Nearest neighbour, then 2-opt segment reversal, then or-opt for small runs.
fn order_run(items: &[(P, P)], from: P, to: Option<P>, edge: &dyn Fn(P, P) -> f64) -> Vec<(usize, bool)> {
    let n = items.len();
    if n == 0 { return vec![]; }
    // cache: points are the item endpoints plus from/to; index = 2k (start), 2k+1 (end), 2n (from), 2n+1 (to)
    let np = 2 * n + 2;
    let pt = |i: usize| -> P { if i == 2 * n { from } else if i == 2 * n + 1 { to.unwrap_or(from) } else if i % 2 == 0 { items[i / 2].0 } else { items[i / 2].1 } };
    let cache = std::cell::RefCell::new(vec![f64::NAN; np * np]);
    let ec = |i: usize, j: usize| -> f64 { let (a, b) = if i <= j { (i, j) } else { (j, i) }; let mut c = cache.borrow_mut(); let v = &mut c[a * np + b]; if v.is_nan() { *v = edge(pt(a), pt(b)); } *v };
    let (fi, ti) = (2 * n, 2 * n + 1);
    // nearest neighbour
    let mut used = vec![false; n];
    let mut seq: Vec<(usize, bool)> = Vec::with_capacity(n);
    let mut cur = fi;
    for _ in 0..n {
        let (mut best, mut bd) = ((0usize, false), f64::INFINITY);
        for i in 0..n { if used[i] { continue; } let (da, db) = (ec(cur, 2 * i), ec(cur, 2 * i + 1)); if da < bd { bd = da; best = (i, false); } if db < bd { bd = db; best = (i, true); } }
        used[best.0] = true; seq.push(best);
        cur = if best.1 { 2 * best.0 } else { 2 * best.0 + 1 };
    }
    // indices: (start point index, end point index) of an oriented item
    let io = |e: (usize, bool)| if e.1 { (2 * e.0 + 1, 2 * e.0) } else { (2 * e.0, 2 * e.0 + 1) };
    let cost = |seq: &[(usize, bool)]| { let mut c = 0.0; let mut p = fi; for &e in seq { let (a, b) = io(e); c += ec(p, a); p = b; } if to.is_some() { c += ec(p, ti); } c };
    // 2-opt
    for _ in 0..50 {
        let mut improved = false;
        for i in 0..n {
            for j in i + 1..n {
                let prev_end = if i == 0 { fi } else { io(seq[i - 1]).1 };
                let next_start = if j + 1 < n { Some(io(seq[j + 1]).0) } else { to.map(|_| ti) };
                let (si, ej) = (io(seq[i]).0, io(seq[j]).1);
                let before = ec(prev_end, si) + next_start.map_or(0.0, |ns| ec(ej, ns));
                let after = ec(prev_end, ej) + next_start.map_or(0.0, |ns| ec(si, ns));
                if after + 1e-9 < before {
                    seq[i..=j].reverse();
                    for e in &mut seq[i..=j] { e.1 = !e.1; }
                    improved = true;
                }
            }
        }
        if !improved { break; }
    }
    // or-opt: move one item (either orientation) elsewhere; O(n^3) so only for small runs
    if n <= 40 {
        for _ in 0..20 {
            let base = cost(&seq);
            let mut best = (base, None::<(usize, usize, bool)>);
            for i in 0..n {
                let mut rest = seq.clone(); let it = rest.remove(i);
                for k in 0..n { for flip in [false, true] {
                    let mut t = rest.clone(); t.insert(k, (it.0, it.1 ^ flip));
                    let c = cost(&t);
                    if c + 1e-9 < best.0 { best = (c, Some((i, k, flip))); }
                } }
            }
            match best.1 { Some((i, k, flip)) => { let it = seq.remove(i); seq.insert(k, (it.0, it.1 ^ flip)); } None => break }
        }
    }
    seq
}

/// Reorder the reorderable runs inside one block of paths. `from`: where the nozzle is when the block starts; `to`: where it should end up.
fn optimize_block(block: &[ExtPath], from: Option<P>, to: Option<P>, w: &Walls, m: &TravelModel) -> Vec<ExtPath> {
    // split into runs
    let mut runs: Vec<(usize, usize)> = vec![]; // [lo, hi)
    let mut i = 0;
    while i < block.len() {
        let mut j = i + 1;
        if reorderable(block[i].feature) { while j < block.len() && block[j].feature == block[i].feature && !block[j].closed && !block[i].closed { j += 1; } }
        runs.push((i, j)); i = j;
    }
    let mut out: Vec<ExtPath> = Vec::with_capacity(block.len());
    let mut pos = from.unwrap_or_else(|| first(&block[0]));
    for (ri, &(lo, hi)) in runs.iter().enumerate() {
        let run = &block[lo..hi];
        if run.len() == 1 || !reorderable(run[0].feature) || run.iter().any(|p| p.closed) {
            for p in run { pos = last(p); out.push(p.clone()); }
            continue;
        }
        let target = if ri + 1 < runs.len() { Some(first(&block[runs[ri + 1].0])) } else { to };
        let items: Vec<(P, P)> = run.iter().map(|p| (first(p), last(p))).collect();
        let feat = run[0].feature;
        let edge = |a: P, b: P| { let dist = d(a, b); dist + if dist >= m.min_travel && !(m.reduce_infill_retraction && is_infill_kind(feat) && !crosses(w, a, b)) { RETRACT_MM } else { 0.0 } };
        for (idx, rev) in order_run(&items, pos, target, &edge) {
            let p = if rev { reversed(&run[idx]) } else { run[idx].clone() };
            pos = last(&p); out.push(p);
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct PathOptOptions { pub model: TravelModel, pub reorder_islands: bool, pub reorder_infill: bool }
impl Default for PathOptOptions { fn default() -> Self { PathOptOptions { model: TravelModel::default(), reorder_islands: true, reorder_infill: true } } }

/// Island blocks of a layer in print order, if every cluster is one contiguous run (else None: islands must not be reordered).
fn blocks_of(l: &LayerPlan, gap: f64) -> Option<Vec<Vec<ExtPath>>> {
    let cl = clusters(l, gap);
    let mut blocks: Vec<(usize, Vec<ExtPath>)> = vec![];
    for (i, p) in l.paths.iter().enumerate() {
        match blocks.last_mut() { Some((c, v)) if *c == cl[i] => v.push(p.clone()), _ => blocks.push((cl[i], vec![p.clone()])) }
    }
    let mut seen = std::collections::BTreeSet::new();
    for (c, _) in &blocks { if !seen.insert(*c) { return None; } }
    Some(blocks.into_iter().map(|b| b.1).collect())
}

fn tsp_blocks(entries: &[P], exits: &[P], from: P, min_travel: f64) -> Vec<usize> {
    let dd = |a: P, b: P| { let x = d(a, b); x + if x >= min_travel { RETRACT_MM } else { 0.0 } };
    let n = entries.len();
    if n <= 1 { return (0..n).collect(); }
    let cost = |o: &[usize]| { let mut c = 0.0; let mut p = from; for &b in o { c += dd(p, entries[b]); p = exits[b]; } c };
    // nearest neighbour start
    let mut used = vec![false; n]; let mut order = vec![]; let mut pos = from;
    for _ in 0..n { let mut best = (usize::MAX, f64::INFINITY); for b in 0..n { if !used[b] { let x = dd(pos, entries[b]); if x < best.1 { best = (b, x); } } } used[best.0] = true; order.push(best.0); pos = exits[best.0]; }
    // relocate + swap local search (asymmetric: blocks keep their direction)
    for _ in 0..100 {
        let mut improved = false;
        let base = cost(&order);
        let mut best = (base, None::<(bool, usize, usize)>);
        for i in 0..n {
            let mut rest = order.clone(); let it = rest.remove(i);
            for k in 0..n { if k == i { continue; } let mut t = rest.clone(); t.insert(k, it); let c = cost(&t); if c + 1e-9 < best.0 { best = (c, Some((false, i, k))); } }
            for j in i + 1..n { let mut t = order.clone(); t.swap(i, j); let c = cost(&t); if c + 1e-9 < best.0 { best = (c, Some((true, i, j))); } }
        }
        if let Some((swap, i, k)) = best.1 { if swap { order.swap(i, k) } else { let it = order.remove(i); order.insert(k, it); } improved = true; }
        if !improved { break; }
    }
    order
}

/// Reduce travel length and retractions. Extruded geometry is unchanged (see `verify_same_extrusion`).
pub fn optimize_travel(plans: &[LayerPlan], start: P, o: &PathOptOptions) -> Vec<LayerPlan> {
    let mut out: Vec<LayerPlan> = Vec::with_capacity(plans.len());
    let mut pos = start;
    for l in plans {
        if l.paths.is_empty() { out.push(l.clone()); continue; }
        let mut paths: Vec<ExtPath>;
        let walls = walls_of(l);
        match (o.reorder_islands, blocks_of(l, o.model.island_gap)) {
            (true, Some(blocks)) if blocks.len() > 1 => {
                // phase 1: greedy internal order per block, entry/exit points
                let pre: Vec<Vec<ExtPath>> = blocks.iter().map(|b| if o.reorder_infill { optimize_block(b, None, None, &walls, &o.model) } else { b.clone() }).collect();
                let entries: Vec<P> = pre.iter().map(|b| first(&b[0])).collect();
                let exits: Vec<P> = pre.iter().map(|b| last(&b[b.len() - 1])).collect();
                let order = tsp_blocks(&entries, &exits, pos, o.model.min_travel);
                // phase 2: re-optimise each block knowing where it is entered from and where the next one starts
                paths = vec![];
                let mut cur = pos;
                for (k, &b) in order.iter().enumerate() {
                    let next = order.get(k + 1).map(|&nb| entries[nb]);
                    let blk = if o.reorder_infill { optimize_block(&blocks[b], Some(cur), next, &walls, &o.model) } else { blocks[b].clone() };
                    cur = last(&blk[blk.len() - 1]);
                    paths.extend(blk);
                }
            }
            _ => {
                paths = if o.reorder_infill { optimize_block(&l.paths, Some(pos), None, &walls, &o.model) } else { l.paths.clone() };
            }
        }
        pos = last(&paths[paths.len() - 1]);
        out.push(LayerPlan { z: l.z, h: l.h, paths });
    }
    out
}

// ------------------------------------------------------------------------------------------------ the proof obligation
type SegKey = (u8, u64, [i64; 4]);
fn q(v: f64) -> i64 { (v * 1e6).round() as i64 }
fn seg_keys(l: &LayerPlan, directed_only_fixed: bool) -> Vec<SegKey> {
    let mut v: Vec<SegKey> = vec![];
    for p in &l.paths {
        let n = p.pts.len();
        let m = if p.closed { n } else { n.saturating_sub(1) };
        for i in 0..m {
            let (a, b) = (p.pts[i], p.pts[(i + 1) % n]);
            let (ka, kb) = ([q(a.x), q(a.y)], [q(b.x), q(b.y)]);
            // width of a segment = mean of its end widths
            let w = (((a.w + b.w) / 2.0) * 1e6).round() as u64;
            let (lo, hi) = if directed_only_fixed && !reorderable(p.feature) { (ka, kb) } else if ka <= kb { (ka, kb) } else { (kb, ka) };
            v.push((p.feature as u8, w, [lo[0], lo[1], hi[0], hi[1]]));
        }
    }
    v.sort();
    v
}
/// PROOF that `after` extrudes exactly what `before` extrudes. Checks, per layer: z/h equal; the multiset of
/// (feature, width, segment) equal where segments of reorderable features are compared undirected and every other feature DIRECTED
/// (so a wall that was reversed is caught); path counts per feature equal. Err = the first difference found.
pub fn verify_same_extrusion(before: &[LayerPlan], after: &[LayerPlan]) -> Result<usize, String> {
    if before.len() != after.len() { return Err(format!("layer count {} -> {}", before.len(), after.len())); }
    let mut total = 0;
    for (i, (a, b)) in before.iter().zip(after).enumerate() {
        if (a.z - b.z).abs() > 1e-12 || (a.h - b.h).abs() > 1e-12 { return Err(format!("layer {i}: z/h changed")); }
        let (ka, kb) = (seg_keys(a, true), seg_keys(b, true));
        if ka != kb { return Err(format!("layer {i}: segment multiset differs ({} vs {} segments)", ka.len(), kb.len())); }
        let mut ca: BTreeMap<u8, usize> = BTreeMap::new(); let mut cb: BTreeMap<u8, usize> = BTreeMap::new();
        for p in &a.paths { *ca.entry(p.feature as u8).or_default() += 1; }
        for p in &b.paths { *cb.entry(p.feature as u8).or_default() += 1; }
        if ca != cb { return Err(format!("layer {i}: path count per feature differs")); }
        total += ka.len();
    }
    Ok(total)
}

// ------------------------------------------------------------------------------------------------ seams
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeamMode { Off, /// concave corner, else the flattest vertex; supported by the layer below
    Concave, /// same, plus pull towards the previous layer's seam so the seam forms a straight vertical line
    Aligned }

/// Signed turn angle (radians) at vertex i of a closed ring: positive = convex for a counter-clockwise ring.
fn turn(ring: &[P], i: usize) -> f64 {
    let n = ring.len();
    let (a, b, c) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
    let (u, v) = ([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
    (u[0] * v[1] - u[1] * v[0]).atan2(u[0] * v[0] + u[1] * v[1])
}
fn ring_area2(r: &[P]) -> f64 { let n = r.len(); (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum() }
fn in_ring(ring: &[P], x: f64, y: f64) -> bool {
    let n = ring.len(); let mut inside = false; let mut j = n - 1;
    for i in 0..n { let (a, b) = (ring[i], ring[j]); if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] { inside = !inside; } j = i; }
    inside
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    d(p, [a[0] + t * dx, a[1] + t * dy])
}
/// Is vertex `v` held up by the layer below? On (within 0.4 mm of) one of its outlines, or inside an odd number of its rings (contours and holes).
pub fn supported_by(below: &[Vec<P>], v: P) -> bool {
    if below.is_empty() { return true; }
    for r in below { let n = r.len(); for i in 0..n { if seg_dist(v, r[i], r[(i + 1) % n]) <= 0.4 { return true; } } }
    below.iter().filter(|r| in_ring(r, v[0], v[1])).count() % 2 == 1
}

/// Seam cost of starting `ring` at vertex `i` (lower is better). `below`: outer rings of the layer below (for support), `prev`: previous seam.
pub fn seam_cost(ring: &[P], i: usize, below: &[Vec<P>], prev: Option<P>, mode: SeamMode) -> f64 {
    let ccw = ring_area2(ring) > 0.0;
    let t = if ccw { turn(ring, i) } else { -turn(ring, i) }; // >0 convex
    let deg = t.to_degrees();
    // concave hides best, then flat; convex is the most visible; scaled so a 90 degree corner costs 1.5
    let shape = if deg < -15.0 { -1.0 } else if deg.abs() <= 15.0 { 0.0 } else { 0.5 + deg / 90.0 };
    let v = ring[i];
    let supported = supported_by(below, v);
    let mut c = shape + if supported { 0.0 } else { 3.0 };
    if mode == SeamMode::Aligned { if let Some(p) = prev { let dd = d(v, p); if dd < 6.0 { c += 0.25 * dd; } } }
    c
}
/// Best start vertex (lowest cost; ties -> lowest index).
pub fn choose_seam(ring: &[P], below: &[Vec<P>], prev: Option<P>, mode: SeamMode) -> usize {
    let mut best = (0usize, f64::INFINITY);
    for i in 0..ring.len() { let c = seam_cost(ring, i, below, prev, mode); if c < best.1 - 1e-12 { best = (i, c); } }
    best.0
}

/// Rotate the start vertex of every EXACTLY closed outer wall (`closed == true`). Segments are untouched (the edge set of a ring does not depend on
/// where it starts), only the start moves, to a vertex that exists. Open paths are never touched.
pub fn rotate_seams(plans: &[LayerPlan], mode: SeamMode) -> Vec<LayerPlan> {
    if mode == SeamMode::Off { return plans.to_vec(); }
    let mut out = vec![];
    let mut prev_seams: Vec<P> = vec![];
    let mut below: Vec<Vec<P>> = vec![];
    for l in plans {
        let mut paths = l.paths.clone();
        let mut seams: Vec<P> = vec![];
        let mut rings: Vec<Vec<P>> = vec![];
        for p in paths.iter_mut().filter(|p| p.feature == Feature::OuterWall && p.closed && p.pts.len() >= 3) {
            let ring: Vec<P> = p.pts.iter().map(|q| [q.x, q.y]).collect();
            let cen = [ring.iter().map(|v| v[0]).sum::<f64>() / ring.len() as f64, ring.iter().map(|v| v[1]).sum::<f64>() / ring.len() as f64];
            // reference seam: nearest previous seam to this ring
            let prev = prev_seams.iter().copied().min_by(|a, b| d(*a, cen).partial_cmp(&d(*b, cen)).unwrap()).filter(|s| ring.iter().any(|v| d(*v, *s) < 6.0));
            let k = choose_seam(&ring, &below, prev, mode);
            p.pts.rotate_left(k);
            seams.push(ring[k]);
            rings.push(ring);
        }
        out.push(LayerPlan { z: l.z, h: l.h, paths });
        if !rings.is_empty() { prev_seams = seams; below = rings; }
    }
    out
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeamMetrics { pub loops: usize, pub concave_share: f64, pub unsupported_share: f64, pub mean_jump_mm: f64, pub jumps: usize }

/// Seam quality of a set of outer-wall rings per layer with the CHOSEN start vertex index per ring (used for both Orca's and our choice).
pub fn seam_metrics(layers: &[Vec<(Vec<P>, usize)>]) -> SeamMetrics {
    let mut m = SeamMetrics::default();
    let (mut concave, mut unsup, mut jump_sum) = (0usize, 0usize, 0.0);
    let mut prev: Vec<P> = vec![];
    let mut below: Vec<Vec<P>> = vec![];
    for l in layers {
        let mut seams = vec![]; let mut rings = vec![];
        for (ring, k) in l {
            if ring.len() < 3 { continue; }
            m.loops += 1;
            let ccw = ring_area2(ring) > 0.0;
            let t = if ccw { turn(ring, *k) } else { -turn(ring, *k) }.to_degrees();
            if t < -15.0 { concave += 1; }
            if !supported_by(&below, ring[*k]) { unsup += 1; }
            if let Some(p) = prev.iter().copied().min_by(|a, b| d(*a, ring[*k]).partial_cmp(&d(*b, ring[*k])).unwrap()) { let dd = d(p, ring[*k]); if dd < 6.0 { jump_sum += dd; m.jumps += 1; } }
            seams.push(ring[*k]); rings.push(ring.clone());
        }
        if !rings.is_empty() { prev = seams; below = rings; }
    }
    if m.loops > 0 { m.concave_share = concave as f64 / m.loops as f64; m.unsupported_share = unsup as f64 / m.loops as f64; }
    if m.jumps > 0 { m.mean_jump_mm = jump_sum / m.jumps as f64; }
    m
}

// ------------------------------------------------------------------------------------------------ min layer time
#[derive(Clone, Debug)]
pub struct SpeedTable { pub by_feature: BTreeMap<u8, f64>, pub default: f64, pub travel: f64 }
impl SpeedTable {
    pub fn speed(&self, f: Feature) -> f64 { *self.by_feature.get(&(f as u8)).unwrap_or(&self.default) }
    /// From an Orca-style Config (the first element of each per-extruder list).
    pub fn from_config(c: &crate::config::Config) -> SpeedTable {
        let g = |k: &str, d: f64| c.f64(k).unwrap_or(d);
        let mut m = BTreeMap::new();
        for (f, k, dd) in [(Feature::OuterWall, "outer_wall_speed", 60.0), (Feature::InnerWall, "inner_wall_speed", 80.0), (Feature::OverhangWall, "outer_wall_speed", 60.0),
            (Feature::SparseInfill, "sparse_infill_speed", 80.0), (Feature::InternalSolidInfill, "internal_solid_infill_speed", 100.0), (Feature::TopSurface, "top_surface_speed", 60.0),
            (Feature::BottomSurface, "internal_solid_infill_speed", 100.0), (Feature::GapInfill, "gap_infill_speed", 100.0), (Feature::Bridge, "bridge_speed", 50.0), (Feature::InternalBridge, "bridge_speed", 50.0),
            (Feature::Support, "support_speed", 80.0), (Feature::SupportInterface, "support_interface_speed", 80.0)] { m.insert(f as u8, g(k, dd)); }
        SpeedTable { by_feature: m, default: 60.0, travel: g("travel_speed", 500.0) }
    }
}
fn plan_len(p: &ExtPath) -> f64 { let n = p.pts.len(); let m = if p.closed { n } else { n - 1 }; (0..m).map(|i| d([p.pts[i].x, p.pts[i].y], [p.pts[(i + 1) % n].x, p.pts[(i + 1) % n].y])).sum() }
fn eff_speed(p: &ExtPath, t: &SpeedTable) -> f64 { if p.speed > 0.0 { p.speed } else { t.speed(p.feature) } }
pub fn layer_time_s(l: &LayerPlan, t: &SpeedTable) -> f64 {
    let ext: f64 = l.paths.iter().map(|p| plan_len(p) / eff_speed(p, t).max(1e-6)).sum();
    let mut trav = 0.0; for w in l.paths.windows(2) { trav += d(last(&w[0]), first(&w[1])); }
    ext + trav / t.travel.max(1.0)
}

#[derive(Clone, Debug, Default)]
pub struct BalanceReport { pub layers: usize, pub short_layers: usize, pub added_s_uniform: f64, pub added_s_balanced: f64, pub outer_wall_untouched_layers: usize, pub unreachable_layers: usize }

fn priority(f: Feature) -> u8 { match f { Feature::SparseInfill | Feature::InternalSolidInfill | Feature::GapInfill | Feature::InternalBridge | Feature::Support => 0, Feature::InnerWall => 1, _ => 2 } }

/// Slow layers shorter than `min_layer_s` down to `min_layer_s`, never below `min_speed` mm/s per path.
/// Uniform (Orca-like): one factor on every path. Balanced: priority 0 (hidden infill/support) first, then inner walls, then everything visible.
/// Only `ExtPath::speed` changes. Returns the balanced plan and both totals so the comparison is explicit.
pub fn balance_layer_time(plans: &[LayerPlan], t: &SpeedTable, min_layer_s: f64, min_speed: f64) -> (Vec<LayerPlan>, BalanceReport) {
    let mut rep = BalanceReport { layers: plans.len(), ..Default::default() };
    let mut out = vec![];
    for l in plans {
        let t0 = layer_time_s(l, t);
        if t0 >= min_layer_s || l.paths.is_empty() { out.push(l.clone()); continue; }
        rep.short_layers += 1;
        let mut trav = 0.0; for w in l.paths.windows(2) { trav += d(last(&w[0]), first(&w[1])); }
        let trav_t = trav / t.travel.max(1.0);
        let need = min_layer_s - trav_t; // extrusion time wanted
        // uniform factor f<1 on all paths: sum len/(v*f) = need, floored per path at min_speed
        let ext_t: f64 = l.paths.iter().map(|p| plan_len(p) / eff_speed(p, t).max(1e-6)).sum();
        let uniform_t = { let f = (ext_t / need).clamp(1e-3, 1.0); l.paths.iter().map(|p| { let v = (eff_speed(p, t) * f).max(min_speed.min(eff_speed(p, t))); plan_len(p) / v }).sum::<f64>() };
        rep.added_s_uniform += (uniform_t + trav_t).max(min_layer_s).min(uniform_t + trav_t + 1e9) - t0;
        // balanced: stretch classes in priority order until the layer reaches `need`
        let mut paths = l.paths.clone();
        let mut cur_t = ext_t;
        for pri in 0..=2u8 {
            if cur_t >= need - 1e-9 { break; }
            // time if every path of this class ran at min_speed (or its own speed if already slower)
            let class: Vec<usize> = (0..paths.len()).filter(|&i| priority(paths[i].feature) == pri).collect();
            if class.is_empty() { continue; }
            let cur_c: f64 = class.iter().map(|&i| plan_len(&paths[i]) / eff_speed(&paths[i], t).max(1e-6)).sum();
            let floor_c: f64 = class.iter().map(|&i| plan_len(&paths[i]) / min_speed.min(eff_speed(&paths[i], t)).max(1e-6)).sum();
            let want_c = (cur_c + (need - cur_t)).min(floor_c);
            let f = cur_c / want_c; // speed factor <= 1
            for &i in &class { let v = (eff_speed(&paths[i], t) * f).max(min_speed.min(eff_speed(&paths[i], t))); paths[i].speed = v; }
            cur_t += want_c - cur_c;
        }
        let new_t = layer_time_s(&LayerPlan { z: l.z, h: l.h, paths: paths.clone() }, t);
        if new_t + 1e-6 < min_layer_s { rep.unreachable_layers += 1; }
        rep.added_s_balanced += new_t - t0;
        if !paths.iter().any(|p| p.feature == Feature::OuterWall && p.speed > 0.0) { rep.outer_wall_untouched_layers += 1; }
        out.push(LayerPlan { z: l.z, h: l.h, paths });
    }
    (out, rep)
}

#[allow(dead_code)]
fn pp(x: f64, y: f64) -> PathPt { PathPt { x, y, w: 0.42 } }

#[cfg(test)]
mod tests {
    use super::*;
    fn path(f: Feature, pts: &[(f64, f64)]) -> ExtPath { ExtPath { feature: f, pts: pts.iter().map(|&(x, y)| pp(x, y)).collect(), closed: false, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 } }
    fn ring(f: Feature, pts: &[(f64, f64)]) -> ExtPath { let mut p = path(f, pts); p.closed = true; p }
    fn sq(x: f64, y: f64, s: f64) -> Vec<(f64, f64)> { vec![(x, y), (x + s, y), (x + s, y + s), (x, y + s)] }
    /// 3 islands in a deliberately bad order (A far, B near, C middle), each: wall ring then 6 infill lines in a bad order.
    fn bad_layer() -> LayerPlan {
        let mut paths = vec![];
        for &(x, y) in &[(0.0, 0.0), (60.0, 0.0), (20.0, 0.0), (40.0, 0.0), (80.0, 0.0)] {
            paths.push(ring(Feature::OuterWall, &sq(x, y, 10.0)));
            // infill lines inside, bad order: left,right,left,right...
            for k in [0, 5, 1, 4, 2, 3] { let yy = y + 1.0 + k as f64 * 1.6; paths.push(path(Feature::SparseInfill, &if k % 2 == 0 { [(x + 1.0, yy), (x + 9.0, yy)] } else { [(x + 9.0, yy), (x + 1.0, yy)] })); }
        }
        LayerPlan { z: 0.2, h: 0.2, paths }
    }
    #[test] fn optimizer_cuts_travel_and_retractions_and_preserves_geometry() {
        let before = vec![bad_layer(), bad_layer()];
        let m = TravelModel::default();
        let s0 = travel_stats(&before, [0.0, -20.0], &m);
        let after = optimize_travel(&before, [0.0, -20.0], &PathOptOptions::default());
        let s1 = travel_stats(&after, [0.0, -20.0], &m);
        assert!(s1.travel_mm < s0.travel_mm * 0.7, "{} -> {}", s0.travel_mm, s1.travel_mm);
        assert!(s1.retractions <= s0.retractions);
        assert!(s1.retractions >= s1.retraction_lower_bound);
        let n = verify_same_extrusion(&before, &after).expect("same segments");
        assert!(n > 0);
        // walls keep their direction and relative order
        for (a, b) in before.iter().zip(&after) {
            let wa: Vec<_> = a.paths.iter().filter(|p| is_wall(p.feature)).map(|p| (p.pts[0].x, p.pts[0].y)).collect();
            let mut wb: Vec<_> = b.paths.iter().filter(|p| is_wall(p.feature)).map(|p| (p.pts[0].x, p.pts[0].y)).collect();
            let mut wa2 = wa.clone(); wa2.sort_by(|x, y| x.partial_cmp(y).unwrap()); wb.sort_by(|x, y| x.partial_cmp(y).unwrap());
            assert_eq!(wa2, wb);
        }
    }
    #[test] fn proof_catches_a_tampered_plan() {
        let before = vec![bad_layer()];
        let mut after = optimize_travel(&before, [0.0, 0.0], &PathOptOptions::default());
        assert!(verify_same_extrusion(&before, &after).is_ok());
        // negative controls: drop a path, shift a point by 2 um, reverse a wall, change a feature
        let mut a1 = after.clone(); a1[0].paths.pop();
        assert!(verify_same_extrusion(&before, &a1).is_err());
        let mut a2 = after.clone(); a2[0].paths[3].pts[0].x += 2e-6;
        assert!(verify_same_extrusion(&before, &a2).is_err());
        let mut a3 = after.clone(); let k = a3[0].paths.iter().position(|p| p.feature == Feature::OuterWall).unwrap(); a3[0].paths[k].pts.reverse();
        assert!(verify_same_extrusion(&before, &a3).is_err(), "a reversed wall must be caught (walls are compared directed)");
        let k = after[0].paths.iter().position(|p| p.feature == Feature::SparseInfill).unwrap(); after[0].paths[k].feature = Feature::InternalSolidInfill;
        assert!(verify_same_extrusion(&before, &after).is_err());
    }
    #[test] fn interleaved_islands_are_not_reordered() {
        // walls of both islands first, then infill of both: reordering islands would break walls-before-infill
        let mut l = LayerPlan { z: 0.2, h: 0.2, paths: vec![] };
        l.paths.push(ring(Feature::OuterWall, &sq(0.0, 0.0, 10.0)));
        l.paths.push(ring(Feature::OuterWall, &sq(50.0, 0.0, 10.0)));
        l.paths.push(path(Feature::SparseInfill, &[(1.0, 5.0), (9.0, 5.0)]));
        l.paths.push(path(Feature::SparseInfill, &[(51.0, 5.0), (59.0, 5.0)]));
        assert!(blocks_of(&l, 1.0).is_none());
        let after = optimize_travel(&[l.clone()], [0.0, 0.0], &PathOptOptions::default());
        let kinds: Vec<_> = after[0].paths.iter().map(|p| p.feature).collect();
        assert_eq!(kinds, vec![Feature::OuterWall, Feature::OuterWall, Feature::SparseInfill, Feature::SparseInfill]);
        verify_same_extrusion(&[l], &after).unwrap();
    }
    #[test] fn lower_bound_is_valid_for_every_ordering_tried() {
        let l = bad_layer();
        let m = TravelModel::default();
        let lb = travel_stats(&[l.clone()], [0.0, 0.0], &m).retraction_lower_bound;
        assert_eq!(lb, 4, "5 islands 20 mm apart -> 4 unavoidable inter-island retractions");
        let best = optimize_travel(&[l], [0.0, 0.0], &PathOptOptions::default());
        assert!(travel_stats(&best, [0.0, 0.0], &m).retractions >= lb);
    }
    #[test] fn seam_rotation_keeps_segments_and_picks_a_concave_corner() {
        // L-shaped ring (CCW) with one concave vertex at (10,10)
        let l_ring = [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (10.0, 10.0), (10.0, 20.0), (0.0, 20.0)];
        let mk = |start: usize| { let mut v: Vec<(f64, f64)> = l_ring.to_vec(); v.rotate_left(start); LayerPlan { z: 0.2, h: 0.2, paths: vec![ring(Feature::OuterWall, &v)] } };
        for s in 0..6 {
            let before = vec![mk(s)];
            let after = rotate_seams(&before, SeamMode::Concave);
            verify_same_extrusion(&before, &after).unwrap();
            let p = &after[0].paths[0];
            assert_eq!((p.pts[0].x, p.pts[0].y), (10.0, 10.0), "start {s}");
        }
        // open paths are untouched
        let mut open = mk(0); open.paths[0].closed = false;
        assert_eq!(rotate_seams(&[open.clone()], SeamMode::Aligned)[0].paths[0].pts[0], open.paths[0].pts[0]);
        assert_eq!(rotate_seams(&[mk(2)], SeamMode::Off)[0].paths[0].pts[0], mk(2).paths[0].pts[0]);
    }
    #[test] fn aligned_seam_is_straighter_than_nearest_start() {
        // a rounded square (many vertices, no concave corner) whose given start wanders layer to layer
        let mut layers = vec![];
        for k in 0..10 { let mut v: Vec<(f64, f64)> = (0..40).map(|i| { let a = std::f64::consts::TAU * i as f64 / 40.0; (10.0 * a.cos(), 10.0 * a.sin()) }).collect(); v.rotate_left((k * 2) % 40); layers.push(LayerPlan { z: 0.2 * (k + 1) as f64, h: 0.2, paths: vec![ring(Feature::OuterWall, &v)] }); }
        let metr = |pl: &[LayerPlan]| seam_metrics(&pl.iter().map(|l| l.paths.iter().filter(|p| p.feature == Feature::OuterWall).map(|p| (p.pts.iter().map(|q| [q.x, q.y]).collect::<Vec<P>>(), 0usize)).collect()).collect::<Vec<_>>());
        let m0 = metr(&layers);
        let m1 = metr(&rotate_seams(&layers, SeamMode::Aligned));
        assert!(m0.jumps > 0 && m0.mean_jump_mm > 1.0, "the control population must have jumps: {m0:?}");
        assert!(m1.mean_jump_mm < 0.2 * m0.mean_jump_mm, "{} vs {}", m1.mean_jump_mm, m0.mean_jump_mm);
        verify_same_extrusion(&layers, &rotate_seams(&layers, SeamMode::Aligned)).unwrap();
    }
    #[test] fn time_balance_only_changes_speed_and_spares_the_outer_wall() {
        let t = SpeedTable { by_feature: [(Feature::OuterWall as u8, 60.0), (Feature::SparseInfill as u8, 100.0)].into_iter().collect(), default: 60.0, travel: 500.0 };
        let l = bad_layer(); // ~ short layer
        let t0 = layer_time_s(&l, &t);
        assert!(t0 < 12.0, "{t0}");
        let (b, rep) = balance_layer_time(&[l.clone()], &t, 12.0, 10.0);
        verify_same_extrusion(&[l.clone()], &b).unwrap();
        assert_eq!(rep.short_layers, 1);
        assert!(layer_time_s(&b[0], &t) >= 12.0 - 1e-6, "{}", layer_time_s(&b[0], &t));
        assert_eq!(rep.outer_wall_untouched_layers, 1, "hidden infill absorbs the slowdown first");
        let (same, r2) = balance_layer_time(&[l.clone()], &t, 1.0, 10.0);
        assert_eq!(r2.short_layers, 0); assert!(same[0].paths.iter().all(|p| p.speed == 0.0));
    }
}
