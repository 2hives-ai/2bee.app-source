//! Exact port of Orca's greedy chaining (`ShortestPath.cpp`: `chain_segments_greedy_constrained_reversals_`), the
//! algorithm behind `chain_and_reorder_extrusion_entities`, `ExtrusionEntityCollection::chained_path_from` and
//! `chain_points`. It is a multi-fragment TSP heuristic: the shortest links between segment end points are taken in
//! order of length, skipping links that would branch or close a loop; the fragments are then walked from the end point
//! closest to the start. Ties are common on regular infill, so the tie behaviour of the supporting structures is
//! ported as well:
//!
//! * `KDTreeIndirect` (2-D): the median-of-three quickselect build and the depth-first visitor, where a candidate of
//!   EQUAL distance replaces the current best (`std::lower_bound` finds the first element not less than the new one);
//! * `MutablePriorityQueue`: a binary heap that swaps a child up when the parent is NOT strictly less than it, so
//!   equal keys move up, and whose `update` is `remove` + `push`;
//! * `EquivalentChains`: union-find with the same (partial) path compression.
//!
//! Coordinates are Orca's scaled integers (1e-6 mm), carried in `f64` exactly like the C++ (`Point` cast to `Vec2d`).

pub const SC: f64 = 1e6;
const EPSILON: f64 = 1e-4; // libslic3r EPSILON, used by KDTreeIndirect::descent_mask

type Pos = [f64; 2];

/// Round a millimetre point to Orca's scaled integer grid.
pub fn scaled(p: [f64; 2]) -> Pos { [(p[0] * SC).round(), (p[1] * SC).round()] }

// ---- KD tree --------------------------------------------------------------------------------------------------------

struct KdTree<'a> {
    pos: &'a [Pos],
    nodes: Vec<usize>, // usize::MAX = npos
}

impl<'a> KdTree<'a> {
    fn new(pos: &'a [Pos]) -> KdTree<'a> {
        let n = pos.len();
        let mut t = KdTree { pos, nodes: Vec::new() };
        if n == 0 { return t; }
        let mut size = 1usize;
        while size < n + 1 { size <<= 1; }
        t.nodes = vec![usize::MAX; size.max(2)];
        let mut input: Vec<usize> = (0..n).collect();
        t.build_recursive(&mut input, 0, 0, 0, n - 1);
        t
    }

    fn coord(&self, idx: usize, dim: usize) -> f64 { self.pos[idx][dim] }

    fn build_recursive(&mut self, input: &mut Vec<usize>, node: usize, dim: usize, left: usize, right: usize) {
        if left > right { return; }
        if node >= self.nodes.len() { self.nodes.resize(node + 1, usize::MAX); }
        if left == right { self.nodes[node] = input[left]; return; }
        let center = (left + right) / 2;
        self.partition_input(input, dim, left, right, center);
        self.nodes[node] = input[center];
        let next = if dim + 1 == 2 { 0 } else { dim + 1 };
        if center > left { self.build_recursive(input, node * 2 + 1, next, left, center - 1); }
        self.build_recursive(input, node * 2 + 2, next, center + 1, right);
    }

    /// `KDTreeIndirect::partition_input` (quickselect, median of three).
    fn partition_input(&self, input: &mut [usize], dim: usize, mut left: usize, mut right: usize, k: usize) {
        while left < right {
            let center = (left + right) / 2;
            let pivot;
            {
                let mut lv = self.coord(input[left], dim);
                let mut cv = self.coord(input[center], dim);
                let mut rv = self.coord(input[right], dim);
                if lv > cv { input.swap(left, center); std::mem::swap(&mut lv, &mut cv); }
                if lv > rv { input.swap(left, right); rv = lv; }
                if cv > rv { input.swap(center, right); cv = rv; }
                pivot = cv;
            }
            if right <= left + 2 { break; }
            let mut i = left;
            let mut j = right - 1;
            input.swap(center, j);
            loop {
                loop { i += 1; if !(self.coord(input[i], dim) < pivot) { break; } }
                loop { j -= 1; if !(self.coord(input[j], dim) > pivot && i < j) { break; } }
                if i >= j { break; }
                input.swap(i, j);
            }
            input.swap(i, right - 1);
            if k < i { right = i - 1; } else if k == i { break; } else { left = i + 1; }
        }
    }

    /// `find_closest_point(kdtree, point, filter)`; `usize::MAX` when nothing passes the filter.
    fn closest(&self, p: Pos, filter: &dyn Fn(usize) -> bool) -> usize {
        let mut best = (usize::MAX, f64::MAX);
        if !self.nodes.is_empty() { self.visit(0, 0, p, filter, &mut best); }
        best.0
    }

    fn visit(&self, node: usize, dim: usize, p: Pos, filter: &dyn Fn(usize) -> bool, best: &mut (usize, f64)) {
        if node >= self.nodes.len() || self.nodes[node] == usize::MAX { return; }
        let idx = self.nodes[node];
        if filter(idx) {
            let mut dist = 0.0;
            for i in 0..2 { let d = p[i] - self.coord(idx, i); dist += d * d; }
            // lower_bound on a one-element array: replace when dist <= best (the current best is not less than it)
            if !(best.1 < dist) { *best = (idx, dist); }
        }
        // descent_mask(point[dim], results.front().second, idx, dim)
        let d = p[dim] - self.coord(idx, dim);
        let (go_left, go_right) = if d * d < best.1 + EPSILON { (true, true) } else if d > 0.0 { (false, true) } else { (true, false) };
        let next = if dim + 1 == 2 { 0 } else { dim + 1 };
        if go_left { self.visit(node * 2 + 1, next, p, filter, best); }
        if go_right { self.visit(node * 2 + 2, next, p, filter, best); }
    }
}

// ---- mutable priority queue ------------------------------------------------------------------------------------------

/// `MutablePriorityQueue` over end point ids with the key `dist[id]`; `heap_idx[id]` follows every move.
struct Queue { heap: Vec<usize> }

impl Queue {
    fn less(dist: &[f64], a: usize, b: usize) -> bool { dist[a] < dist[b] }

    fn push(&mut self, item: usize, dist: &[f64], hi: &mut [usize]) {
        let idx = self.heap.len();
        self.heap.push(item);
        hi[item] = idx;
        self.up(0, idx, dist, hi);
    }
    fn pop(&mut self, dist: &[f64], hi: &mut [usize]) {
        if self.heap.len() > 1 {
            let last = *self.heap.last().unwrap();
            self.heap[0] = last;
            self.heap.pop();
            hi[self.heap[0]] = 0;
            let bottom = self.heap.len() - 1;
            self.down(0, bottom, dist, hi);
        } else {
            self.heap.clear();
        }
    }
    fn remove(&mut self, idx: usize, dist: &[f64], hi: &mut [usize]) {
        if idx + 1 == self.heap.len() { self.heap.pop(); return; }
        let last = *self.heap.last().unwrap();
        self.heap[idx] = last;
        hi[last] = idx;
        self.heap.pop();
        let bottom = self.heap.len() - 1;
        self.down(idx, bottom, dist, hi);
        self.up(0, idx, dist, hi);
    }
    fn update(&mut self, idx: usize, dist: &[f64], hi: &mut [usize]) {
        let item = self.heap[idx];
        self.remove(idx, dist, hi);
        self.push(item, dist, hi);
    }
    fn up(&mut self, top: usize, bottom: usize, dist: &[f64], hi: &mut [usize]) {
        let mut child_idx = bottom;
        loop {
            if child_idx == 0 { break; }
            let parent_idx = (child_idx - 1) >> 1;
            if parent_idx < top { break; }
            let (parent, child) = (self.heap[parent_idx], self.heap[child_idx]);
            if !Self::less(dist, parent, child) {
                hi[parent] = child_idx;
                hi[child] = parent_idx;
                self.heap[parent_idx] = child;
                self.heap[child_idx] = parent;
            }
            child_idx = parent_idx;
        }
    }
    fn down(&mut self, top: usize, bottom: usize, dist: &[f64], hi: &mut [usize]) {
        let mut parent_idx = top;
        loop {
            let mut child_idx = (parent_idx << 1) + 1;
            if child_idx > bottom { break; }
            let child2 = child_idx + 1;
            if child2 <= bottom && !Self::less(dist, self.heap[child_idx], self.heap[child2]) { child_idx = child2; }
            let (parent, child) = (self.heap[parent_idx], self.heap[child_idx]);
            if Self::less(dist, parent, child) { return; }
            hi[parent] = child_idx;
            hi[child] = parent_idx;
            self.heap[parent_idx] = child;
            self.heap[child_idx] = parent;
            parent_idx = child_idx;
        }
    }
}

// ---- equivalent chains ------------------------------------------------------------------------------------------------

struct Equiv { with: Vec<usize>, last: usize }
impl Equiv {
    fn new(cap: usize) -> Equiv { let mut with = Vec::with_capacity(cap + 1); with.push(0); Equiv { with, last: 0 } }
    fn next(&mut self) -> usize { self.last += 1; self.with.push(self.last); self.last }
    fn get(&mut self, chain_id: usize) -> usize {
        let mut id = chain_id;
        if id != 0 {
            let mut last = id;
            loop {
                let lower = self.with[last];
                if lower == last { self.with[id] = lower; id = lower; break; }
                last = lower;
            }
        }
        id
    }
    fn merge(&mut self, a: usize, b: usize) -> usize {
        let c = self.get(a).min(self.get(b));
        self.with[a] = c;
        self.with[b] = c;
        c
    }
}

// ---- the chaining ------------------------------------------------------------------------------------------------------

/// `chain_segments_greedy_constrained_reversals_` with `REVERSE_COULD_FAIL = true` (what `chain_extrusion_entities`
/// uses) when `constrained`, `chain_segments_greedy` otherwise. `ends[i] = (first point, last point)` of segment i.
/// Returns (segment index, reversed) in visiting order.
pub fn chain_segments_greedy(ends: &[(Pos, Pos)], could_reverse: &dyn Fn(usize) -> bool, constrained: bool, start_near: Option<Pos>) -> Vec<(usize, bool)> {
    let n = ends.len();
    let mut out: Vec<(usize, bool)> = Vec::with_capacity(n);
    if n == 0 { return out; }
    if n == 1 {
        let rev = could_reverse(0) && start_near.map_or(false, |s| sq(ends[0].1, s) < sq(ends[0].0, s));
        out.push((0, rev));
        return out;
    }
    // end points: 2*i = first, 2*i+1 = last
    let mut pos: Vec<Pos> = Vec::with_capacity(2 * n);
    for e in ends { pos.push(e.0); pos.push(e.1); }
    let kd = KdTree::new(&pos);
    let m = 2 * n;
    let mut chain_id = vec![0usize; m];
    let mut edge_out: Vec<Option<usize>> = vec![None; m];
    let mut dist_out = vec![f64::MAX; m];
    let mut heap_idx = vec![usize::MAX; m];
    let mut eq = Equiv::new(n);

    let mut first_point: Option<usize> = None;
    let mut first_point_idx = usize::MAX;
    if let Some(s) = start_near {
        let idx = kd.closest(s, &|idx| (idx & 1) == 0 || could_reverse(idx >> 1));
        first_point = Some(idx);
        dist_out[idx] = 0.0;
        chain_id[idx] = eq.next();
        first_point_idx = idx;
    }
    let initial_point = first_point;
    let mut last_point: Option<usize> = None;

    for e in 0..m {
        if Some(e) == first_point { continue; }
        let this_idx = e;
        let next = kd.closest(pos[e], &|idx| idx != first_point_idx && (idx ^ this_idx) > 1);
        edge_out[e] = if next == usize::MAX { None } else { Some(next) };
        if next != usize::MAX { dist_out[e] = sq(pos[next], pos[e]); }
    }

    let mut q = Queue { heap: Vec::with_capacity(m) };
    for e in 0..m { if first_point != Some(e) { q.push(e, &dist_out, &mut heap_idx); } }

    let mut iter: i64 = n as i64 - 2;
    loop {
        let e1 = q.heap[0];
        let Some(e2) = edge_out[e1] else { break };
        let mut valid = true;
        let (mut o1, mut o2) = (0usize, 0usize);
        if chain_id[e2] > 0 {
            valid = false;
        } else {
            o1 = eq.get(chain_id[e1 ^ 1]);
            o2 = eq.get(chain_id[e2 ^ 1]);
            if o1 == o2 && o1 != 0 { valid = false; }
        }
        if valid {
            q.pop(&dist_out, &mut heap_idx);
            let h2 = heap_idx[e2];
            q.remove(h2, &dist_out, &mut heap_idx);
            edge_out[e2] = Some(e1);
            dist_out[e2] = dist_out[e1];
            let cid = if o1 == 0 {
                if o2 == 0 { eq.next() } else { o2 }
            } else if o2 == 0 { o1 } else if o1 == o2 { o1 } else { eq.merge(o1, o2) };
            chain_id[e1] = cid;
            chain_id[e2] = cid;
            if iter == 0 {
                if first_point.is_none() {
                    let t = q.heap[0];
                    q.pop(&dist_out, &mut heap_idx);
                    first_point = Some(t);
                    edge_out[t] = None;
                }
                let t = q.heap[0];
                last_point = Some(t);
                edge_out[t] = None;
                q.pop(&dist_out, &mut heap_idx);
                break;
            }
            iter -= 1;
        } else {
            // the link would branch or close a loop: find another one for e1 and re-sort it
            edge_out[e1] = None;
            let this_idx = e1;
            let this_other = eq.get(chain_id[this_idx ^ 1]);
            let next = kd.closest(pos[e1], &|idx| {
                if (idx ^ this_idx) <= 1 || chain_id[idx] != 0 { return false; }
                let chain2 = eq_find(&eq.with, chain_id[idx ^ 1]);
                this_other != chain2 || this_other == 0
            });
            if next != usize::MAX {
                edge_out[e1] = Some(next);
                dist_out[e1] = sq(pos[next], pos[e1]);
            }
            let h = heap_idx[e1];
            q.update(h, &dist_out, &mut heap_idx);
        }
        if q.heap.is_empty() { break; }
    }

    // walk the chain
    let mut cur = first_point;
    let mut failed = false;
    while let Some(fp) = cur {
        let seg = fp >> 1;
        let reverse = (fp & 1) != 0;
        if constrained && reverse && !could_reverse(seg) { failed = true; break; }
        out.push((seg, reverse));
        cur = edge_out[fp ^ 1];
        if out.len() > n { failed = true; break; }
    }
    if !failed && out.len() != n { failed = true; }
    if constrained && failed {
        if start_near.is_none() {
            out.clear();
            failed = false;
            cur = last_point;
            while let Some(fp) = cur {
                let seg = fp >> 1;
                let reverse = (fp & 1) != 0;
                if reverse && !could_reverse(seg) { failed = true; break; }
                out.push((seg, reverse));
                cur = edge_out[fp ^ 1];
                if out.len() > n { failed = true; break; }
            }
        }
        if failed {
            let start = initial_point.unwrap_or(0);
            out = chain_segments_closest_point(&pos, &kd, could_reverse, start);
        }
    }
    if out.len() != n {
        // cannot happen for well-formed input; never return a short list
        out = chain_segments_closest_point(&pos, &kd, &|_| true, initial_point.unwrap_or(0));
    }
    out
}

/// Read-only union-find lookup (no path compression) for use inside the KD-tree filter.
fn eq_find(with: &[usize], id: usize) -> usize {
    if id == 0 { return 0; }
    let mut last = id;
    loop {
        let lower = with[last];
        if lower == last { return lower; }
        last = lower;
    }
}

fn sq(a: Pos, b: Pos) -> f64 { let (dx, dy) = (a[0] - b[0], a[1] - b[1]); dx * dx + dy * dy }

/// `chain_segments_closest_point`: the dumb nearest-neighbour fallback that respects reversal limits.
fn chain_segments_closest_point(pos: &[Pos], kd: &KdTree, could_reverse: &dyn Fn(usize) -> bool, first_point: usize) -> Vec<(usize, bool)> {
    let num = pos.len() / 2;
    let mut chain = vec![0usize; pos.len()];
    let mut out = Vec::with_capacity(num);
    out.push((first_point / 2, (first_point & 1) != 0));
    chain[first_point] = 1;
    let mut this_idx = first_point ^ 1;
    for _ in 0..num.saturating_sub(1) {
        chain[this_idx] = 1;
        let ti = this_idx;
        let next = kd.closest(pos[this_idx], &|idx| (idx ^ ti) > 1 && chain[idx] == 0 && ((idx & 1) == 0 || could_reverse(idx >> 1)));
        if next == usize::MAX { break; }
        chain[next] = 1;
        out.push((next / 2, (next & 1) != 0));
        this_idx = next ^ 1;
    }
    out
}

/// `chain_points`: each point is a segment whose two ends coincide; returns the visiting order.
pub fn chain_points(points: &[Pos], start_near: Option<Pos>) -> Vec<usize> {
    let ends: Vec<(Pos, Pos)> = points.iter().map(|p| (*p, *p)).collect();
    chain_segments_greedy(&ends, &|_| true, false, start_near).into_iter().map(|(i, _)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_perm(o: &[(usize, bool)], n: usize) -> bool {
        let mut seen = vec![false; n];
        o.len() == n && o.iter().all(|&(i, _)| { let f = !seen[i]; seen[i] = true; f })
    }

    #[test]
    fn single_segment_flips_to_the_near_end() {
        let ends = [([0.0, 0.0], [10.0, 0.0])];
        assert_eq!(chain_segments_greedy(&ends, &|_| true, true, Some([9.0, 0.0])), vec![(0, true)]);
        assert_eq!(chain_segments_greedy(&ends, &|_| true, true, Some([1.0, 0.0])), vec![(0, false)]);
        assert_eq!(chain_segments_greedy(&ends, &|_| false, true, Some([9.0, 0.0])), vec![(0, false)]);
    }

    #[test]
    fn parallel_lines_zigzag_from_the_nearest_end() {
        // three horizontal lines stacked; start near the right end of the bottom line
        let ends = [([0.0, 0.0], [10.0, 0.0]), ([0.0, 1.0], [10.0, 1.0]), ([0.0, 2.0], [10.0, 2.0])];
        let o = chain_segments_greedy(&ends, &|_| true, true, Some([11.0, 0.0]));
        assert_eq!(o, vec![(0, true), (1, false), (2, true)]);
    }

    #[test]
    fn respects_unreversible_segments() {
        let ends = [([0.0, 0.0], [10.0, 0.0]), ([20.0, 0.0], [30.0, 0.0]), ([40.0, 0.0], [50.0, 0.0])];
        let o = chain_segments_greedy(&ends, &|_| false, true, Some([0.0, 0.0]));
        assert!(is_perm(&o, 3));
        assert!(o.iter().all(|&(_, r)| !r), "{:?}", o);
        assert_eq!(o.iter().map(|x| x.0).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn is_a_permutation_on_random_clouds() {
        let mut seed = 99u64;
        let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((seed >> 33) as f64) / (1u64 << 31) as f64 * 1e8 };
        for n in [2usize, 3, 5, 17, 64, 200] {
            let ends: Vec<(Pos, Pos)> = (0..n).map(|_| ([rnd().round(), rnd().round()], [rnd().round(), rnd().round()])).collect();
            for start in [None, Some([0.0, 0.0])] {
                let o = chain_segments_greedy(&ends, &|i| i % 3 != 0, true, start);
                assert!(is_perm(&o, n), "n={} {:?}", n, o);
                assert!(o.iter().all(|&(i, r)| !r || i % 3 != 0), "reversal constraint broken");
                let o2 = chain_segments_greedy(&ends, &|_| true, false, start);
                assert!(is_perm(&o2, n));
            }
        }
    }

    #[test]
    fn chain_points_visits_all_and_starts_near() {
        let pts: Vec<Pos> = vec![[0.0, 0.0], [5e6, 0.0], [1e6, 0.0], [9e6, 0.0]];
        let o = chain_points(&pts, Some([8.0e6, 0.0]));
        assert_eq!(o[0], 3);
        let mut s = o.clone(); s.sort();
        assert_eq!(s, vec![0, 1, 2, 3]);
    }

    #[test]
    fn grid_ties_are_deterministic() {
        // 5x5 lattice of points: many equal distances; the result must not depend on anything but the input
        let pts: Vec<Pos> = (0..25).map(|i| [((i % 5) as f64) * 1e6, ((i / 5) as f64) * 1e6]).collect();
        let a = chain_points(&pts, Some([0.0, 0.0]));
        let b = chain_points(&pts, Some([0.0, 0.0]));
        assert_eq!(a, b);
        assert_eq!(a.len(), 25);
    }
}
