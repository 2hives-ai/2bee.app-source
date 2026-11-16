//! Wall post-processing helpers that act on a layer's finished wall `ExtPath`s:
//!
//! * `wall_sequence` (inner wall/outer wall | outer wall/inner wall | inner-outer-inner wall), ported
//!   from `PerimeterGenerator::process_classic` / `process_arachne` including the sandwich reorder and
//!   the Arachne proximity reorder (`reorderPerimetersByProximity`, `bringContoursToFront`);
//! * `only_one_wall_first_layer` / `only_one_wall_top`: the wall-count rule and the Arachne-style
//!   "cut the inner walls where they run under the top fill" (`clip_inner_walls_over_top`);
//! * the `detect_thin_wall` output stage: thick (variable width) polyline -> constant-width paths
//!   (`thick_polyline_to_extrusion_paths_2`, tolerance 0.05 mm), the part every thin-wall / gap-fill
//!   producer shares;
//! * nearest-neighbour chaining of loops (`chain_extrusion_entities` at the top of `traverse_loops`).
//!
//! The geometry that DECIDES which walls exist (onion shells, medial axes) stays in the walls lane.
use super::adapter as g;
use crate::types::{ExtPath, Feature, PathPt, Polys};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WallSequence { InnerOuter, OuterInner, InnerOuterInner }
impl WallSequence {
    pub fn from_key(k: &str) -> Option<Self> {
        Some(match k { "inner wall/outer wall" => Self::InnerOuter, "outer wall/inner wall" => Self::OuterInner, "inner-outer-inner wall" => Self::InnerOuterInner, _ => return None })
    }
}

/// A wall path plus the metadata Orca keeps on `ExtrusionLoop` / `ExtrusionLine`.
#[derive(Clone, Debug)]
pub struct WallItem {
    pub path: ExtPath,
    /// 0 = outermost wall, 1 = first inner wall, ...
    pub inset_idx: usize,
    /// Contour loop (true) or loop around a hole (false). Only used by `bring_contours_to_front`.
    pub is_contour: bool,
}

fn first_pt(p: &ExtPath) -> [f64; 2] { p.pts.first().map(|q| [q.x, q.y]).unwrap_or([0.0, 0.0]) }
fn last_pt(p: &ExtPath) -> [f64; 2] { p.pts.last().map(|q| [q.x, q.y]).unwrap_or([0.0, 0.0]) }

/// Greedy nearest-start chaining from `start` (Orca `chain_extrusion_entities`): closed loops are entered at
/// their first point, open paths may be reversed. Returns the new order (open paths are reversed in place).
pub fn chain_wall_items(items: Vec<WallItem>, start: [f64; 2]) -> Vec<WallItem> {
    let mut rest = items;
    let mut out = Vec::with_capacity(rest.len());
    let mut cur = start;
    while !rest.is_empty() {
        let mut best = (0usize, false, f64::INFINITY);
        for (i, it) in rest.iter().enumerate() {
            let a = first_pt(&it.path);
            let d0 = (a[0] - cur[0]).hypot(a[1] - cur[1]);
            if d0 < best.2 { best = (i, false, d0); }
            if !it.path.closed {
                let b = last_pt(&it.path);
                let d1 = (b[0] - cur[0]).hypot(b[1] - cur[1]);
                if d1 < best.2 { best = (i, true, d1); }
            }
        }
        let mut it = rest.remove(best.0);
        if best.1 { it.path.pts.reverse(); }
        cur = if it.path.closed { first_pt(&it.path) } else { last_pt(&it.path) };
        out.push(it);
    }
    out
}

// ---------------------------------------------------------------- sandwich (inner-outer-inner)
/// The shared position/outer/first_internal/second_internal scan of Orca's IOI reorder.
/// `classic` selects the island-boundary test of the classic generator (needs all three indices found)
/// instead of the Arachne one (first internal suffices). `base` is the outside-in list (outer first).
fn ioi_reorder(base: &mut Vec<WallItem>, scan: &Vec<WallItem>, classic: bool) {
    let n = scan.len();
    let mut position = 0usize;
    while position < n {
        let (mut outer, mut first_internal, mut second_internal): (i64, i64, i64) = (-1, -1, -1);
        let mut max_internal = n as i64 - 1;
        let mut arr_i = position;
        while arr_i < n {
            match scan[arr_i].inset_idx {
                0 => if outer == -1 { outer = arr_i as i64; },
                1 => if first_internal == -1 && arr_i as i64 > outer && outer != -1 { first_internal = arr_i as i64; },
                2 => if second_internal == -1 && arr_i as i64 > first_internal && outer != -1 { second_internal = arr_i as i64; },
                _ => {}
            }
            let new_island = if classic { outer > -1 && first_internal > -1 && second_internal > -1 && scan[arr_i].inset_idx == 0 }
                             else { outer > -1 && first_internal > -1 && scan[arr_i].inset_idx == 0 };
            if new_island {
                arr_i -= 1;
                max_internal = arr_i as i64;
                break;
            }
            arr_i += 1;
        }
        if outer > -1 && first_internal > -1 && second_internal > -1 {
            let mut reordered: Vec<WallItem> = Vec::new();
            let mut j = max_internal;
            while j >= position as i64 {
                if j >= second_internal { reordered.push(scan[j as usize].clone()); }
                j -= 1;
            }
            for j in position as i64..second_internal { reordered.push(scan[j as usize].clone()); }
            for (k, it) in reordered.into_iter().enumerate() {
                let idx = position + k;
                if idx < base.len() { base[idx] = it; }
            }
        } else if classic {
            break;
        } else {
            // Arachne: Orca falls through to the next position as well; with no reorderable island the
            // outside-in order stays.
        }
        position = arr_i + 1;
    }
}

/// Classic generator ordering. `items` arrive in `traverse_loops` order (inner walls before the wall around
/// them, per island: the InnerOuter order). `brim_outer_first_layer`: layer 0 with an outer-only brim prints
/// outer first regardless of the setting.
pub fn order_walls_classic(items: Vec<WallItem>, seq: WallSequence, layer_id: usize, brim_outer_first_layer: bool) -> Vec<WallItem> {
    let mut entities = items;
    if seq == WallSequence::OuterInner || (layer_id == 0 && brim_outer_first_layer) {
        entities.reverse();
        return entities;
    }
    if seq == WallSequence::InnerOuterInner && layer_id > 0 {
        entities.reverse(); // outer -> inner
        if entities.len() > 2 {
            let mut reordered: Vec<WallItem> = Vec::new();
            let mut skipped: Vec<WallItem> = Vec::new();
            let mut found_second = false;
            for e in entities.iter() {
                match e.inset_idx {
                    0 => { if found_second { reordered.append(&mut skipped); } reordered.push(e.clone()); }
                    1 => reordered.push(e.clone()),
                    _ => { skipped.push(e.clone()); found_second = true; }
                }
            }
            if entities.len() > reordered.len() { reordered.append(&mut skipped); }
            ioi_reorder(&mut entities, &reordered, true);
        }
    }
    entities
}

/// Minimum distance between two polylines defined by their vertices (Orca `minimumDistanceBetweenLinesDefinedByPoints`).
fn min_line_distance(a: &[PathPt], b: &[PathPt]) -> f64 {
    fn seg_d(p: &PathPt, s0: &PathPt, s1: &PathPt) -> f64 {
        let (dx, dy) = (s1.x - s0.x, s1.y - s0.y);
        let l2 = dx * dx + dy * dy;
        let t = if l2 == 0.0 { 0.0 } else { (((p.x - s0.x) * dx + (p.y - s0.y) * dy) / l2).clamp(0.0, 1.0) };
        (s0.x + dx * t - p.x).hypot(s0.y + dy * t - p.y)
    }
    let mut m = f64::INFINITY;
    if a.len() >= 2 { for i in 0..a.len() - 1 { for p in b { m = m.min(seg_d(p, &a[i], &a[i + 1])); } } }
    if b.len() >= 2 { for i in 0..b.len() - 1 { for p in a { m = m.min(seg_d(p, &b[i], &b[i + 1])); } } }
    m
}
fn path_length(p: &ExtPath) -> f64 {
    let n = p.pts.len();
    let mut l: f64 = p.pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum();
    if p.closed && n > 2 && (p.pts[0].x != p.pts[n - 1].x || p.pts[0].y != p.pts[n - 1].y) { l += (p.pts[0].x - p.pts[n - 1].x).hypot(p.pts[0].y - p.pts[n - 1].y); }
    l
}

fn find_touching(entities: &[WallItem], refs: &[usize], th_ext: f64, th_int: f64, inset: usize) -> Vec<usize> {
    let mut touching: Vec<usize> = Vec::new();
    for &r in refs {
        let rp = &entities[r];
        for (i, e) in entities.iter().enumerate() {
            if refs.contains(&i) || e.inset_idx == 0 || e.inset_idx != inset { continue; }
            let d = min_line_distance(&rp.path.pts, &e.path.pts);
            let th = if rp.inset_idx == 0 { th_ext } else { th_int };
            if d <= th && !touching.contains(&i) { touching.push(i); }
        }
    }
    touching.sort();
    touching
}

/// Orca `reorderPerimetersByProximity` (Arachne IOI pre-ordering). Thresholds in mm.
pub fn reorder_by_proximity(entities: &[WallItem], th_ext: f64, th_int: f64) -> Vec<WallItem> {
    let mut reordered: Vec<WallItem> = Vec::new();
    let mut included: Vec<usize> = Vec::new();
    let max_by_len = |v: &Vec<usize>, pick_last: bool| -> Option<usize> {
        let mut best: Option<usize> = None;
        for (k, &i) in v.iter().enumerate() {
            if best.map_or(true, |b| path_length(&entities[i].path) > path_length(&entities[v[b]].path)) { best = Some(k); }
        }
        let _ = pick_last;
        best
    };
    for ref_idx in 0..entities.len() {
        if entities[ref_idx].inset_idx != 0 || included.contains(&ref_idx) { continue; }
        let mut first = find_touching(entities, &[ref_idx], th_ext, th_int, 1);
        if let Some(k) = max_by_len(&first, true) { let last = first.len() - 1; first.swap(k, last); }
        reordered.push(entities[ref_idx].clone());
        included.push(ref_idx);
        for &i in &first { if !included.contains(&i) { reordered.push(entities[i].clone()); included.push(i); } }
        let mut level = first;
        let mut inset = 2usize;
        loop {
            let mut cur = find_touching(entities, &level, th_ext, th_int, inset);
            if cur.is_empty() { break; }
            cur.retain(|i| !included.contains(i));
            if let Some(k) = max_by_len(&cur, false) { cur.swap(k, 0); }
            for &i in &cur { if !included.contains(&i) { reordered.push(entities[i].clone()); included.push(i); } }
            level = cur;
            inset += 1;
        }
    }
    for i in 0..entities.len() { if !included.contains(&i) { reordered.push(entities[i].clone()); } }
    reordered
}

/// Arachne generator ordering. `perimeters[k]` holds the walls of inset index k. Region-order constraints
/// (`WallToolPaths::getRegionOrder`) are NOT ported: walls are taken in inset order with nearest-start
/// selection among the equal-inset candidates (closed first), which is what the constraint graph reduces to
/// for non-nested thin features. `th_*` are the IOI proximity thresholds in mm (ext_spacing/2 + int_spacing/2,
/// or ext_spacing + int_spacing/2 with precise_outer_wall; internal = int_spacing).
pub fn order_walls_arachne(perimeters: Vec<Vec<WallItem>>, seq: WallSequence, layer_id: usize, th_ext: f64, th_int: f64) -> Vec<WallItem> {
    let outer_first = (seq == WallSequence::OuterInner || seq == WallSequence::InnerOuterInner) && !(layer_id == 0 && seq == WallSequence::InnerOuterInner);
    let order: Vec<usize> = if outer_first { (0..perimeters.len()).collect() } else { (0..perimeters.len()).rev().collect() };
    let mut ordered: Vec<WallItem> = Vec::new();
    let mut cur_pos = perimeters.iter().flatten().next().map(|w| first_pt(&w.path)).unwrap_or([0.0, 0.0]);
    for k in order {
        let mut cand = perimeters[k].clone();
        cand.sort_by_key(|w| !w.path.closed); // closed last, like the `is_closed <` sort (false < true)
        cand.sort_by_key(|w| w.path.closed);
        while !cand.is_empty() {
            let mut best = 0usize;
            let mut bd = f64::INFINITY;
            for (i, w) in cand.iter().enumerate() {
                let p = first_pt(&w.path);
                let d = (p[0] - cur_pos[0]).hypot(p[1] - cur_pos[1]);
                if d < bd { bd = d; best = i; }
            }
            let w = cand.remove(best);
            cur_pos = if w.path.closed { first_pt(&w.path) } else { last_pt(&w.path) };
            ordered.push(w);
        }
    }
    if seq == WallSequence::InnerOuterInner && layer_id > 0 && ordered.len() > 2 {
        // bringContoursToFront (stable partition)
        let (mut front, back): (Vec<WallItem>, Vec<WallItem>) = ordered.into_iter().partition(|w| w.is_contour && w.inset_idx == 0);
        front.extend(back);
        let prox = reorder_by_proximity(&front, th_ext, th_int);
        let mut base = prox.clone();
        ioi_reorder(&mut base, &prox, false);
        return base;
    }
    ordered
}

// ---------------------------------------------------------------- only_one_wall_*
#[derive(Clone, Debug)]
pub struct WallCountInput {
    pub wall_loops: i32,
    /// `surface.extra_perimeters`.
    pub extra_perimeters: i32,
    pub alternate_extra_wall: bool,
    pub layer_id: usize,
    pub spiral_mode: bool,
    pub sparse_infill_density: f64,
    pub only_one_wall_first_layer: bool,
    pub only_one_wall_top: bool,
    pub top_shell_layers: u32,
    pub bottom_shell_layers: u32,
    pub raft_layers: usize,
    /// `upper_slices == nullptr`: no layer above this one.
    pub is_topmost: bool,
}
/// Number of wall loops of an island (Orca's `loop_number + 1`; 0 = no walls). Classic and Arachne apply
/// the same first-layer / topmost rules; for Arachne's *partial* top reduction (`inner_loop_number`) see
/// [`arachne_inner_loops_left`].
pub fn wall_loop_count(i: &WallCountInput) -> i32 {
    let one_top = i.only_one_wall_top && i.top_shell_layers > 0;
    let one_first = i.only_one_wall_first_layer && i.bottom_shell_layers > 0;
    let mut loop_number = i.wall_loops + i.extra_perimeters - 1;
    if i.alternate_extra_wall && i.layer_id % 2 == 1 && !i.spiral_mode && i.sparse_infill_density > 0.0 { loop_number += 1; }
    if i.layer_id == i.raft_layers && one_first { loop_number = 0; }
    if loop_number > 0 && one_top && i.is_topmost { loop_number = 0; }
    (loop_number + 1).max(0)
}
/// Arachne `only_one_wall_top` on a layer that has a layer above: all but the outer wall are "inner loops"
/// that are generated over the not-top part only. Returns how many inner loops remain (>= 0), -1 if the
/// feature is off for this layer.
pub fn arachne_inner_loops_left(i: &WallCountInput) -> i32 {
    let one_top = i.only_one_wall_top && i.top_shell_layers > 0;
    if one_top && !i.is_topmost { wall_loop_count(&WallCountInput { is_topmost: false, ..i.clone() }) - 1 - 1 } else { -1 }
}

/// Cut pieces of inner walls that run over the top region (Orca `clip_inner_walls_over_top`): the walls are
/// clipped against the top region grown by half a wall width; pieces shorter than a wall width are dropped; a
/// wall that would lose less than two wall widths is kept whole and its footprint is returned in `kept_over_top`
/// (the caller withholds it from the top fill). `top_region` and widths in mm.
pub fn clip_inner_walls_over_top(walls: Vec<ExtPath>, top_region: &Polys, perimeter_width: f64) -> (Vec<ExtPath>, Polys) {
    let clip = g::offset(top_region, perimeter_width / 2.0);
    let bb = g::bbox(&g::offset(top_region, 1e-4)).unwrap_or([0.0; 4]);
    let over = |x: f64, y: f64| -> bool { x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3] && g::contains(top_region, x, y) };
    let mut kept_over_top: Polys = vec![];
    let mut out: Vec<ExtPath> = Vec::new();
    for w in walls {
        if w.pts.is_empty() { continue; }
        let inside = w.pts.iter().filter(|p| over(p.x, p.y)).count();
        if inside == 0 { out.push(w); continue; }
        if inside == w.pts.len() { continue; }
        // clip against `clip` (difference): split the polyline at ring crossings
        let pieces = difference_polyline(&w.pts, w.closed, &clip);
        let total = path_length(&w);
        let kept: f64 = pieces.iter().map(|p| p.windows(2).map(|s| (s[1].x - s[0].x).hypot(s[1].y - s[0].y)).sum::<f64>()).sum();
        if total - kept < 2.0 * perimeter_width {
            // footprint of the kept wall
            let max_w = w.pts.iter().fold(0.0f64, |m, p| m.max(p.w));
            let line: Vec<[f64; 2]> = w.pts.iter().map(|p| [p.x, p.y]).collect();
            kept_over_top.extend(stroke_footprint(&line, w.closed, max_w / 2.0));
            out.push(w);
            continue;
        }
        for pc in pieces {
            let len: f64 = pc.windows(2).map(|s| (s[1].x - s[0].x).hypot(s[1].y - s[0].y)).sum();
            if pc.len() >= 2 && len >= perimeter_width {
                let mut np = w.clone();
                np.pts = pc;
                np.closed = false;
                out.push(np);
            }
        }
    }
    (out, kept_over_top)
}

fn stroke_footprint(line: &[[f64; 2]], closed: bool, half: f64) -> Polys {
    // union of per-segment rectangles (cheap stand-in for Clipper's polyline offset)
    let mut polys: Polys = vec![];
    let n = line.len();
    let nseg = if closed { n } else { n.saturating_sub(1) };
    for i in 0..nseg {
        let (a, b) = (line[i], line[(i + 1) % n]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l = dx.hypot(dy);
        if l < 1e-9 { continue; }
        let (nx, ny) = (-dy / l * half, dx / l * half);
        polys.push(crate::types::Poly { contour: vec![[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], holes: vec![] });
    }
    if polys.is_empty() { return vec![]; }
    g::union(&polys, &vec![])
}

/// Pieces of `pts` lying outside `region` (width interpolated at cut points). A closed loop whose start point is
/// outside has its first and last pieces merged.
fn difference_polyline(pts: &[PathPt], closed: bool, region: &Polys) -> Vec<Vec<PathPt>> {
    let n = pts.len();
    let mut seq: Vec<PathPt> = pts.to_vec();
    if closed && n > 1 && (pts[0].x != pts[n - 1].x || pts[0].y != pts[n - 1].y) { seq.push(pts[0]); }
    let mut rings: Vec<&Vec<[f64; 2]>> = vec![];
    for q in region { rings.push(&q.contour); for h in &q.holes { rings.push(h); } }
    let mut pieces: Vec<Vec<PathPt>> = Vec::new();
    let mut cur: Vec<PathPt> = Vec::new();
    for wdw in seq.windows(2) {
        let (a, b) = (wdw[0], wdw[1]);
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let mut ts = vec![0.0f64, 1.0];
        for r in &rings {
            let m = r.len();
            for i in 0..m {
                let (c, d) = (r[i], r[(i + 1) % m]);
                let (ex, ey) = (d[0] - c[0], d[1] - c[1]);
                let den = dx * ey - dy * ex;
                if den.abs() < 1e-18 { continue; }
                let t = ((c[0] - a.x) * ey - (c[1] - a.y) * ex) / den;
                let u = ((c[0] - a.x) * dy - (c[1] - a.y) * dx) / den;
                if t > 0.0 && t < 1.0 && (0.0..=1.0).contains(&u) { ts.push(t); }
            }
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
        for k in 0..ts.len() - 1 {
            let (t0, t1) = (ts[k], ts[k + 1]);
            if t1 - t0 < 1e-12 { continue; }
            let tm = 0.5 * (t0 + t1);
            let outside = !g::contains(region, a.x + dx * tm, a.y + dy * tm);
            let lerp = |t: f64| PathPt { x: a.x + dx * t, y: a.y + dy * t, w: a.w + (b.w - a.w) * t };
            if outside {
                if cur.is_empty() { cur.push(lerp(t0)); }
                cur.push(lerp(t1));
            } else if !cur.is_empty() {
                pieces.push(std::mem::take(&mut cur));
            }
        }
    }
    if !cur.is_empty() { pieces.push(cur); }
    if closed && pieces.len() >= 2 {
        let (f, l) = (pieces[0][0], *pieces.last().unwrap().last().unwrap());
        if (f.x - l.x).abs() < 1e-4 && (f.y - l.y).abs() < 1e-4 {
            let mut last = pieces.pop().unwrap();
            last.extend_from_slice(&pieces[0][1..]);
            pieces[0] = last;
        }
    }
    pieces
}

// ---------------------------------------------------------------- thin walls / variable width
/// Orca `variable_width` -> `thick_polyline_to_extrusion_paths_2`: quantise a thick polyline (per-point
/// width) into constant-width paths: a new path starts when the width drifts more than `tolerance` (0.05)
/// from the running min/max; very different segments are split into `ceil(delta/tolerance)` steps.
/// Output widths are the length-weighted mean width of each run. `feature` is the role (external perimeter
/// for thin walls, gap fill for gaps).
pub fn variable_width_paths(thick: &[PathPt], feature: Feature, layer_h: f64, tolerance: f64) -> Vec<ExtPath> {
    // Build thick lines, splitting steep width ramps exactly like Orca (insert/erase loop).
    #[derive(Clone, Copy)]
    struct TL { a: [f64; 2], b: [f64; 2], wa: f64, wb: f64 }
    let len = |l: &TL| (l.b[0] - l.a[0]).hypot(l.b[1] - l.a[1]);
    let mut lines: Vec<TL> = thick.windows(2).map(|w| TL { a: [w[0].x, w[0].y], b: [w[1].x, w[1].y], wa: w[0].w, wb: w[1].w }).collect();
    let mut paths: Vec<ExtPath> = Vec::new();
    let mk = |pts: Vec<[f64; 2]>, w: f64| ExtPath {
        feature, pts: pts.into_iter().map(|p| PathPt { x: p[0], y: p[1], w }).collect(), closed: false, layer_h, speed: 0.0, flow_ratio: 1.0,
    };
    let eps = 1e-4;
    let mut start = 0usize;
    let (mut maxw, mut minw) = (0.0f64, 0.0f64);
    let mut i: i64 = 0;
    while (i as usize) < lines.len() {
        let l = lines[i as usize];
        if i == 0 { maxw = l.wa; minw = l.wa; }
        let ll = len(&l);
        if ll < eps { i += 1; continue; }
        let mut delta = (maxw - l.wb).abs().max((minw - l.wb).abs());
        if delta > tolerance {
            if start as i64 != i {
                let mut pts = vec![lines[start].a];
                let mut length = len(&lines[start]);
                let mut sum = length * 0.5 * (lines[start].wa + lines[start].wb);
                for idx in start + 1..i as usize { length += len(&lines[idx]); sum += len(&lines[idx]) * 0.5 * (lines[idx].wa + lines[idx].wb); pts.push(lines[idx].a); }
                pts.push(lines[i as usize].a);
                if length > eps { paths.push(mk(pts, sum / length)); }
            }
            start = i as usize;
            maxw = l.wa; minw = l.wa;
            delta = (l.wa - l.wb).abs();
            if delta > tolerance {
                let segs = (delta / tolerance).ceil() as usize;
                let seg_len = ll / segs as f64;
                let dir = [(l.b[0] - l.a[0]) / ll, (l.b[1] - l.a[1]) / ll];
                let mut pp = vec![l.a];
                let mut ws = vec![l.wa];
                for j in 1..segs {
                    pp.push([l.a[0] + dir[0] * j as f64 * seg_len, l.a[1] + dir[1] * j as f64 * seg_len]);
                    let w = l.wa + (j as f64 * seg_len) * (l.wb - l.wa) / ll;
                    ws.push(w); ws.push(w);
                }
                pp.push(l.b); ws.push(l.wb);
                lines.remove(i as usize);
                for j in 0..segs { lines.insert(i as usize + j, TL { a: pp[j], b: pp[j + 1], wa: ws[2 * j], wb: ws[2 * j + 1] }); }
                continue; // re-evaluate index i (Orca: --i; continue;)
            }
        } else {
            maxw = maxw.max(l.wa.max(l.wb));
            minw = minw.min(l.wa.min(l.wb));
        }
        i += 1;
    }
    if start < lines.len() {
        let mut pts = vec![lines[start].a];
        let mut length = len(&lines[start]);
        let mut sum = length * lines[start].wa;
        for idx in start + 1..lines.len() { length += len(&lines[idx]); sum += len(&lines[idx]) * lines[idx].wa; pts.push(lines[idx].a); }
        pts.push(lines[lines.len() - 1].b);
        if length > eps { paths.push(mk(pts, sum / length)); }
    }
    paths
}

/// `Flow::with_width(w).mm3_per_mm()` helper for the rounded-rectangle model: cross-section of a bead
/// of width `w` and height `h` (stadium model used throughout Orca).
pub fn bead_mm3_per_mm(w: f64, h: f64) -> f64 { (w - h * (1.0 - PI / 4.0)) * h }

// ---------------------------------------------------------------- detect_thin_wall region
/// The geometry `process_classic` hands to the medial axis when `detect_thin_wall` is on: the part of `last`
/// that cannot hold a normal outer loop (opening of the leftover after an offset2 by the minimum loop size).
/// The caller (walls lane) runs the medial axis over each returned polygon with
/// `min_width = nozzle/3`, `max_width = ext_width + ext_spacing2` and feeds the resulting thick polylines to
/// [`variable_width_paths`]. All lengths in mm. `ext_min_spacing` = `ext_spacing * (1 - 0.4)`.
pub fn thin_wall_region(last: &Polys, ext_width: f64, ext_min_spacing: f64, nozzle_diameter: f64) -> Polys {
    let eps = 1e-6;
    let offsets = g::offset(&g::offset(last, -(ext_width / 2.0 + ext_min_spacing / 2.0 - eps)), ext_min_spacing / 2.0 - eps);
    let min_width = nozzle_diameter / 3.0;
    let covered = g::offset(&offsets, ext_width / 2.0 + 1e-5);
    let leftover = g::diff(last, &covered);
    g::offset(&g::offset(&leftover, -(min_width / 2.0)), min_width / 2.0)
}

// ---------------------------------------------------------------- wall_direction / overhang_reverse
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WallDirection { CounterClockwise, Clockwise }
impl WallDirection {
    pub fn from_key(k: &str) -> Option<Self> { Some(match k { "ccw" => Self::CounterClockwise, "cw" => Self::Clockwise, _ => return None }) }
}

fn loop_area(p: &ExtPath) -> f64 {
    let n = p.pts.len();
    let mut s = 0.0;
    for i in 0..n { let (a, b) = (&p.pts[i], &p.pts[(i + 1) % n]); s += a.x * b.y - b.x * a.y; }
    0.5 * s
}
/// `ExtrusionLoop::make_counter_clockwise / make_clockwise`: reverse a closed loop in place if needed.
/// The loop keeps its start point (Orca reverses the point order of each path; the start becomes the end).
pub fn orient_loop(p: &mut ExtPath, ccw: bool) {
    if !p.closed || p.pts.len() < 3 { return; }
    let a = loop_area(p);
    if (a > 0.0) != ccw {
        let first = p.pts[0];
        p.pts.reverse();
        // keep the seam point first: [last..first] reversed puts old first at the end -> rotate it back to the front
        let n = p.pts.len();
        p.pts.rotate_right(1);
        debug_assert!(p.pts[0].x == first.x && p.pts[0].y == first.y && n == p.pts.len());
    }
}
/// `wall_direction` for every closed wall: contours follow the setting, hole loops go the opposite way
/// (`(wall_direction == CCW) == is_contour` -> make CCW else CW).
pub fn apply_wall_direction(items: &mut [WallItem], dir: WallDirection) {
    for it in items.iter_mut() {
        let ccw = (dir == WallDirection::CounterClockwise) == it.is_contour;
        orient_loop(&mut it.path, ccw);
    }
}

/// `detect_steep_overhang`: does any part of this loop lie outside the lower layer grown by
/// `threshold - width/2`? `threshold_mm` = `overhang_reverse_threshold.get_abs_value(width)`; 0 = reverse on
/// every odd layer regardless of geometry.
pub fn detect_steep_overhang(loop_pts: &[PathPt], width: f64, threshold_mm: f64, lower_slices: &Polys) -> bool {
    if threshold_mm < 1e-4 { return true; }
    let grown = g::offset(lower_slices, threshold_mm - 0.5 * width);
    if grown.is_empty() { return true; }
    !difference_polyline(loop_pts, true, &grown).is_empty()
}

/// `reorient_perimeters`: reverse loops (not the external one when `internal_only`) when a steep overhang was
/// found for their class. `layer_id` must be odd for the feature to act (Orca only evaluates odd layers).
pub fn reorient_for_overhang(items: &mut [WallItem], steep_contour: bool, steep_hole: bool, internal_only: bool) {
    if !(steep_contour || steep_hole) { return; }
    for it in items.iter_mut() {
        if !it.path.closed { continue; }
        let need = if it.is_contour { steep_contour } else { steep_hole };
        let external = internal_only && it.inset_idx == 0;
        if need && !external { it.path.pts.reverse(); it.path.pts.rotate_right(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    fn sq(hw: f64, w: f64, start: f64) -> ExtPath {
        let pts = [(start, hw), (-hw, hw), (-hw, -hw), (hw, -hw), (hw, hw)];
        ExtPath { feature: Feature::InnerWall, pts: pts.iter().map(|&(x, y)| PathPt { x, y, w }).collect(), closed: true, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 }
    }
    /// walls of one island in Orca's native InnerOuter order: deepest first
    fn island(n: usize) -> Vec<WallItem> {
        (0..n).rev().map(|d| WallItem { path: sq(10.0 - 0.45 * d as f64, 0.45, 0.0), inset_idx: d, is_contour: true }).collect()
    }
    fn idx(v: &[WallItem]) -> Vec<usize> { v.iter().map(|w| w.inset_idx).collect() }

    #[test]
    fn wall_sequence_classic() {
        assert_eq!(idx(&order_walls_classic(island(3), WallSequence::InnerOuter, 5, false)), vec![2, 1, 0]);
        assert_eq!(idx(&order_walls_classic(island(3), WallSequence::OuterInner, 5, false)), vec![0, 1, 2]);
        // sandwich: deepest walls first, then outer, then the first inner wall (Orca: inner-outer-inner)
        assert_eq!(idx(&order_walls_classic(island(4), WallSequence::InnerOuterInner, 5, false)), vec![3, 2, 0, 1]);
        assert_eq!(idx(&order_walls_classic(island(3), WallSequence::InnerOuterInner, 5, false)), vec![2, 0, 1]);
        // fewer than 3 walls: plain outer->inner; first layer: sandwich disabled, Orca's native inner->outer order stays
        assert_eq!(idx(&order_walls_classic(island(2), WallSequence::InnerOuterInner, 5, false)), vec![0, 1]);
        assert_eq!(idx(&order_walls_classic(island(3), WallSequence::InnerOuterInner, 0, false)), vec![2, 1, 0]);
        // an outer-only brim forces outer first on layer 0 whatever the setting says
        assert_eq!(idx(&order_walls_classic(island(3), WallSequence::InnerOuter, 0, true)), vec![0, 1, 2]);
        assert_eq!(idx(&order_walls_classic(island(3), WallSequence::InnerOuter, 1, true)), vec![2, 1, 0]);
    }
    #[test]
    fn sandwich_handles_two_islands_independently() {
        let mut v = island(3);
        v.extend(island(3).into_iter().map(|mut w| { for p in w.path.pts.iter_mut() { p.x += 50.0; } w }));
        let o = order_walls_classic(v, WallSequence::InnerOuterInner, 7, false);
        // the reversed input is [0,1,2] [0,1,2]... Orca's reordering gives [2,0,1] per island
        assert_eq!(idx(&o).len(), 6);
        assert_eq!(idx(&o)[0..3], [2, 0, 1]);
    }
    #[test]
    fn wall_sequence_arachne_orders_by_inset() {
        let per: Vec<Vec<WallItem>> = (0..3).map(|d| vec![WallItem { path: sq(10.0 - 0.45 * d as f64, 0.45, 0.0), inset_idx: d, is_contour: true }]).collect();
        assert_eq!(idx(&order_walls_arachne(per.clone(), WallSequence::InnerOuter, 5, 0.43, 0.42)), vec![2, 1, 0]);
        assert_eq!(idx(&order_walls_arachne(per.clone(), WallSequence::OuterInner, 5, 0.43, 0.42)), vec![0, 1, 2]);
        assert_eq!(idx(&order_walls_arachne(per, WallSequence::InnerOuterInner, 5, 0.43, 0.42)), vec![2, 0, 1]);
    }
    #[test]
    fn chaining_visits_nearest_first() {
        let mk = |x: f64| WallItem { path: sq(1.0, 0.4, 0.0).clone(), inset_idx: 0, is_contour: true }.with_shift(x);
        let o = chain_wall_items(vec![mk(30.0), mk(2.0), mk(10.0)], [0.0, 0.0]);
        let xs: Vec<f64> = o.iter().map(|w| w.path.pts[0].x).collect();
        assert!(xs[0] < xs[1] && xs[1] < xs[2], "{xs:?}");
    }
    impl WallItem { fn with_shift(mut self, dx: f64) -> Self { for p in self.path.pts.iter_mut() { p.x += dx; } self } }

    #[test]
    fn wall_count_rules() {
        let base = WallCountInput { wall_loops: 3, extra_perimeters: 0, alternate_extra_wall: false, layer_id: 10, spiral_mode: false, sparse_infill_density: 15.0,
            only_one_wall_first_layer: false, only_one_wall_top: false, top_shell_layers: 5, bottom_shell_layers: 3, raft_layers: 0, is_topmost: false };
        assert_eq!(wall_loop_count(&base), 3);
        assert_eq!(wall_loop_count(&WallCountInput { layer_id: 0, only_one_wall_first_layer: true, ..base.clone() }), 1);
        assert_eq!(wall_loop_count(&WallCountInput { layer_id: 0, only_one_wall_first_layer: true, bottom_shell_layers: 0, ..base.clone() }), 3, "no bottom shell: option has nothing to act on");
        assert_eq!(wall_loop_count(&WallCountInput { is_topmost: true, only_one_wall_top: true, ..base.clone() }), 1);
        assert_eq!(wall_loop_count(&WallCountInput { is_topmost: true, only_one_wall_top: true, top_shell_layers: 0, ..base.clone() }), 3);
        assert_eq!(wall_loop_count(&WallCountInput { is_topmost: false, only_one_wall_top: true, ..base.clone() }), 3);
        assert_eq!(wall_loop_count(&WallCountInput { alternate_extra_wall: true, layer_id: 11, ..base.clone() }), 4);
        assert_eq!(wall_loop_count(&WallCountInput { alternate_extra_wall: true, layer_id: 11, spiral_mode: true, ..base.clone() }), 3);
        assert_eq!(wall_loop_count(&WallCountInput { wall_loops: 0, ..base.clone() }), 0);
        assert_eq!(arachne_inner_loops_left(&WallCountInput { only_one_wall_top: true, ..base.clone() }), 1);
        assert_eq!(arachne_inner_loops_left(&base), -1);
    }
    #[test]
    fn inner_walls_are_cut_where_they_run_over_the_top() {
        // a straight inner wall along y = 0 from x=-10 to x=10; the top region covers x in [2, 6]
        let w = ExtPath { feature: Feature::InnerWall, pts: vec![PathPt { x: -10.0, y: 0.0, w: 0.45 }, PathPt { x: 10.0, y: 0.0, w: 0.45 }], closed: false, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 };
        let top = vec![Poly { contour: vec![[2.0, -3.0], [6.0, -3.0], [6.0, 3.0], [2.0, 3.0]], holes: vec![] }];
        // endpoints are outside the top region -> classification says Partial only if a vertex is inside; add one
        let mut w2 = w.clone();
        w2.pts.insert(1, PathPt { x: 4.0, y: 0.0, w: 0.45 });
        let (out, kept) = clip_inner_walls_over_top(vec![w2], &top, 0.45);
        assert_eq!(out.len(), 2, "wall splits into the two pieces beside the top fill");
        let xs: Vec<(f64, f64)> = out.iter().map(|p| (p.pts[0].x.min(p.pts.last().unwrap().x), p.pts[0].x.max(p.pts.last().unwrap().x))).collect();
        assert!(xs.iter().any(|&(a, b)| (a + 10.0).abs() < 1e-6 && (b - (2.0 - 0.225)).abs() < 1e-3), "{xs:?}");
        assert!(xs.iter().any(|&(a, b)| (a - (6.0 + 0.225)).abs() < 1e-3 && (b - 10.0).abs() < 1e-6), "{xs:?}");
        assert!(kept.is_empty());
        // wall entirely over the top is removed; wall not touching it is kept
        let inside = ExtPath { pts: vec![PathPt { x: 3.0, y: 0.0, w: 0.45 }, PathPt { x: 5.0, y: 0.0, w: 0.45 }], ..w.clone() };
        let far = ExtPath { pts: vec![PathPt { x: -9.0, y: 5.0, w: 0.45 }, PathPt { x: -5.0, y: 5.0, w: 0.45 }], ..w.clone() };
        let (o2, _) = clip_inner_walls_over_top(vec![inside, far.clone()], &top, 0.45);
        assert_eq!(o2.len(), 1);
        assert_eq!(o2[0].pts, far.pts);
        // a wall that only grazes the top (loses < 2 widths) is kept whole and reported
        let graze = ExtPath { pts: vec![PathPt { x: -10.0, y: 0.0, w: 0.45 }, PathPt { x: 2.1, y: 0.0, w: 0.45 }, PathPt { x: 10.0, y: 0.0, w: 0.45 }], ..w };
        let sliver = vec![Poly { contour: vec![[2.0, -3.0], [2.2, -3.0], [2.2, 3.0], [2.0, 3.0]], holes: vec![] }];
        let (o3, k3) = clip_inner_walls_over_top(vec![graze], &sliver, 0.45);
        assert_eq!(o3.len(), 1);
        assert!(!k3.is_empty());
    }
    #[test]
    fn variable_width_quantisation() {
        // constant width -> one path with that width
        let thick: Vec<PathPt> = (0..=10).map(|i| PathPt { x: i as f64, y: 0.0, w: 0.4 }).collect();
        let p = variable_width_paths(&thick, Feature::GapInfill, 0.2, 0.05);
        assert_eq!(p.len(), 1);
        assert!((p[0].pts[0].w - 0.4).abs() < 1e-12 && p[0].pts.len() == 11);
        // a ramp 0.2 -> 0.6 over 10 mm splits into >= 8 steps of <= 0.05 width change
        let ramp: Vec<PathPt> = (0..=10).map(|i| PathPt { x: i as f64, y: 0.0, w: 0.2 + 0.04 * i as f64 }).collect();
        let r = variable_width_paths(&ramp, Feature::OuterWall, 0.2, 0.05);
        assert!(r.len() >= 8, "{}", r.len());
        for w in r.windows(2) { assert!((w[1].pts[0].w - w[0].pts[0].w).abs() <= 0.06); }
        // total length is preserved
        let tot: f64 = r.iter().map(|p| p.pts.windows(2).map(|s| (s[1].x - s[0].x).hypot(s[1].y - s[0].y)).sum::<f64>()).sum();
        assert!((tot - 10.0).abs() < 1e-6, "{tot}");
    }
    #[test]
    fn wall_direction_and_overhang_reverse() {
        let mut items = vec![
            WallItem { path: sq(5.0, 0.4, 0.0), inset_idx: 0, is_contour: true },
            WallItem { path: sq(2.0, 0.4, 0.0), inset_idx: 0, is_contour: false },
        ];
        // sq() is counter-clockwise (start top, go left, down, right, up)
        assert!(loop_area(&items[0].path) > 0.0);
        apply_wall_direction(&mut items, WallDirection::Clockwise);
        assert!(loop_area(&items[0].path) < 0.0, "contour CW");
        assert!(loop_area(&items[1].path) > 0.0, "hole CCW (opposite)");
        apply_wall_direction(&mut items, WallDirection::CounterClockwise);
        assert!(loop_area(&items[0].path) > 0.0 && loop_area(&items[1].path) < 0.0);
        assert_eq!((items[0].path.pts[0].x, items[0].path.pts[0].y), (0.0, 5.0), "seam point stays first");
        // reorient: only the external loop is spared with internal_only
        let mut v = vec![WallItem { path: sq(5.0, 0.4, 0.0), inset_idx: 0, is_contour: true }, WallItem { path: sq(4.0, 0.4, 0.0), inset_idx: 1, is_contour: true }];
        let before: Vec<f64> = v.iter().map(|w| loop_area(&w.path)).collect();
        reorient_for_overhang(&mut v, true, false, true);
        assert_eq!(loop_area(&v[0].path).signum(), before[0].signum());
        assert_eq!(loop_area(&v[1].path).signum(), -before[1].signum());
        // steep-overhang detector: lower layer smaller than this loop -> steep; same size -> not
        let lower_small = vec![Poly { contour: vec![[-4.0, -4.0], [4.0, -4.0], [4.0, 4.0], [-4.0, 4.0]], holes: vec![] }];
        let lower_same = vec![Poly { contour: vec![[-5.2, -5.2], [5.2, -5.2], [5.2, 5.2], [-5.2, 5.2]], holes: vec![] }];
        let lp = sq(5.0, 0.4, 0.0).pts;
        assert!(detect_steep_overhang(&lp, 0.4, 0.2, &lower_small));
        assert!(!detect_steep_overhang(&lp, 0.4, 0.2, &lower_same));
        assert!(detect_steep_overhang(&lp, 0.4, 0.0, &lower_same), "threshold 0 = every odd layer");
    }
}

#[cfg(test)]
mod thin_tests {
    use super::*;
    use crate::types::Poly;
    #[test]
    fn thin_wall_region_is_the_strip_too_narrow_for_a_loop() {
        // a 10 mm square with a 0.5 mm wide, 6 mm long tab: a 0.42 mm wall fits but two loops would not
        let sq = Poly { contour: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]], holes: vec![] };
        let tab = Poly { contour: vec![[10.0, 4.75], [16.0, 4.75], [16.0, 5.25], [10.0, 5.25]], holes: vec![] };
        let both = g::union(&vec![sq.clone()], &vec![tab]);
        let t = thin_wall_region(&both, 0.42, 0.42 * 0.6, 0.4);
        let a = g::area(&t);
        assert!(a > 2.0 && a < 3.2, "tab ~ 5.9 x 0.5 = 3 mm2 minus tips, got {a}");
        // a plain square has no thin wall
        assert!(g::area(&thin_wall_region(&vec![sq], 0.42, 0.42 * 0.6, 0.4)) < 1e-6);
    }
}
