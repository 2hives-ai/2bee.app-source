//! `PrintObject::bridge_over_infill`: the first solid layer above sparse infill becomes an *Internal Bridge*
//! (thick round threads across the infill), with the anchor strip below it turned solid.
use super::detect::{polys_of, State};
use super::ops::*;
use super::{FlowRole, SparseLines, Surface, SurfaceType as T};
use crate::types::{Poly, Polys};
use std::collections::BTreeMap;
use std::f64::consts::PI;

#[derive(Clone)]
struct Cand {
    /// Index of the originating InternalSolid surface in `fill[layer]`.
    surf: usize,
    new_polys: Polys,
    angle: f64,
}

type Seg = (Pt, Pt);

fn to_segments(pls: &[Vec<Pt>]) -> Vec<Seg> {
    let mut v = vec![];
    for p in pls { for w in p.windows(2) { v.push((w[0], w[1])); } }
    v
}

pub fn bridge_over_infill(st: &mut State, sparse: Option<&dyn SparseLines>) {
    let n = st.n;
    let cfg = st.cfg;
    // ------------------------------------------------------------------ gather candidates
    let mut by_layer: BTreeMap<usize, Vec<Cand>> = BTreeMap::new();
    // per layer: reads only layers lidx-1 / lidx of the (immutable) classification, so the layers run in parallel
    let lidxs: Vec<usize> = (1..n).collect();
    let this = &*st;
    let gathered: Vec<Vec<Cand>> = super::pmap(&lidxs, |_, &lidx| {
        let st = this;
        let mut found: Vec<Cand> = vec![];
        let spacing = st.flow(FlowRole::SolidInfill, lidx).spacing;
        let lower = lidx - 1;
        let unsupported0 = closing(&u(&st.layers[lower].fill), EPS);
        let mut lower_solids: Polys = vec![];
        for s in &st.fill[lower] {
            if s.ty != T::Internal || cfg.sparse_density >= 1.0 { lower_solids.push(s.poly.clone()); }
        }
        // By expanding the lower solids we avoid bridging tiny internal overhangs that solids below support.
        let expansion_multiplier = 3.0;
        let lower_solids = expand(&shrink(&u(&lower_solids), spacing), (1.0 + expansion_multiplier) * spacing);
        let unsupported_area = df(&shrink(&unsupported0, expansion_multiplier * spacing), &lower_solids);
        for (si, s) in st.fill[lidx].iter().enumerate() {
            if s.ty != T::InternalSolid { continue; }
            let sp = vec![s.poly.clone()];
            let uns = it(&sp, &unsupported_area);
            let partially = area(&uns) < area(&sp) - 1e-9;
            if !uns.is_empty() && (!partially || area(&uns) > 9.0 * spacing * spacing) {
                let mut worth = it(&sp, &expand(&uns, 4.0 * spacing));
                // merge the tiny leftovers back so the surface is not broken up too much
                let rest = df(&sp, &expand(&worth, spacing));
                for p in &rest {
                    let a = ring_area(&p.contour).abs();
                    if a < spacing * 12.0 && a > spacing * spacing { worth.push(p.clone()); }
                }
                let worth = it(&closing(&u(&worth), EPS), &sp);
                found.push(Cand { surf: si, new_polys: worth, angle: 0.0 });
            }
        }
        found
    });
    for (k, cs) in gathered.into_iter().enumerate() { if !cs.is_empty() { by_layer.insert(k + 1, cs); } }
    if by_layer.is_empty() { return; }

    // ------------------------------------------------------------------ cluster layers (thick bridges cannot stack)
    let target_factor = 0.9;
    let bflow = |lidx: usize| cfg.bridging_flow(FlowRole::SolidInfill, lidx, st.layers[lidx].h, true);
    let mut covered: BTreeMap<usize, Polys> = BTreeMap::new();
    for (&lidx, cs) in &by_layer {
        let mut acc: Polys = vec![];
        for c in cs {
            if let Some(b) = bbox(&c.new_polys) {
                let m = 7.0;
                acc.push(Poly { contour: vec![[b[0] - m, b[1] - m], [b[2] + m, b[1] - m], [b[2] + m, b[3] + m], [b[0] - m, b[3] + m]], holes: vec![] });
            }
        }
        covered.insert(lidx, u(&acc));
    }
    let mut clusters: Vec<Vec<usize>> = vec![];
    for &lidx in by_layer.keys() {
        let new_cluster = match clusters.last() {
            None => true,
            Some(c) => {
                let last = *c.last().unwrap();
                st.print_z(last) < st.print_z(lidx) - bflow(lidx).height * target_factor - 1e-4
                    || it(&covered[&last], &covered[&lidx]).is_empty()
            }
        };
        if new_cluster { clusters.push(vec![lidx]); } else { clusters.last_mut().unwrap().push(lidx); }
    }

    // ------------------------------------------------------------------ expand + angle per cluster, in layer order
    for cluster in &clusters {
        for (job, &lidx) in cluster.iter().enumerate() {
            let mut cands = by_layer.remove(&lidx).unwrap();
            let bb = |c: &Cand| bbox(&c.new_polys).unwrap_or([0.0; 4]);
            cands.sort_by(|a, b| { let (x, y) = (bb(a), bb(b)); x[0].partial_cmp(&y[0]).unwrap().then(x[1].partial_cmp(&y[1]).unwrap()) });
            if cands.len() > 2 {
                let o = bb(&cands[0]);
                let origin = [o[2], o[3]];
                let first = cands.remove(0);
                cands.sort_by(|a, b| {
                    let (x, y) = (bb(a), bb(b));
                    let da = (origin[0] - x[0]).powi(2) + (origin[1] - x[1]).powi(2);
                    let db = (origin[0] - y[0]).powi(2) + (origin[1] - y[1]).powi(2);
                    da.partial_cmp(&db).unwrap()
                });
                cands.insert(0, first);
            }
            let flow = bflow(lidx);
            let spacing = flow.spacing;
            let target_h = flow.height * target_factor;

            // sparse infill areas that are deep enough for the thick thread
            let mut deep = gather_areas_w_depth(st, lidx, target_h);
            {
                let bottom_z = st.print_z(lidx) - target_h - 1e-4;
                let mut filled: Polys = vec![];
                for lj in (0..job).rev() {
                    let lower = cluster[lj];
                    if st.print_z(lower) >= bottom_z {
                        if let Some(cs) = by_layer.get(&lower) { for c in cs { filled.extend(c.new_polys.iter().cloned()); } }
                    } else { break; }
                }
                deep = df(&deep, &filled);
            }
            let deep_infill_area = expand(&deep, spacing * 1.5);

            let mut expansion_area = closing(&polys_of(&st.fill[lidx], &[T::Internal, T::InternalSolid]), EPS);
            expansion_area = it(&expansion_area, &deep_infill_area);
            let total_fill_area = closing(&u(&st.layers[lidx].fill), EPS);
            let total_top_area = polys_of(&st.fill[lidx], &[T::Top]);
            let infill_lines: Vec<Vec<Pt>> = sparse.map(|s| s.lines(lidx - 1, &polys_of(&st.fill[lidx - 1], &[T::Internal]))).unwrap_or_default();
            let anchor_region = shrink(&expansion_area, spacing);
            let mut anchors: Vec<Vec<Pt>> = vec![];
            for pl in &infill_lines { anchors.extend(clip_polyline(pl, &anchor_region, true)); }
            let internal_unsupported_area = shrink(&deep_infill_area, spacing * 4.5);

            let mut expanded: Vec<Cand> = Vec::with_capacity(cands.len());
            for cand in &cands {
                let mut area_to_be_bridge = it(&expand(&cand.new_polys, spacing), &deep_infill_area);
                area_to_be_bridge.retain(|p| !it(&vec![p.clone()], &internal_unsupported_area).is_empty());
                let limiting_area = un(&area_to_be_bridge, &expansion_area);
                if area_to_be_bridge.is_empty() { continue; }
                // Orca passes the *unscaled* spacing to expand(), i.e. an expansion of ~0.
                let mut boundary: Vec<Vec<Pt>> = vec![];
                for r in rings(&expand(&total_fill_area, 1.3 * spacing)) { let mut c = r.clone(); c.push(c[0]); boundary.push(c); }
                for r in rings(&limiting_area) { let mut c = r.clone(); c.push(c[0]); boundary.push(c); }

                let mut angle = if !anchors.is_empty() {
                    determine_bridging_angle(&area_to_be_bridge, &to_segments(&anchors))
                } else {
                    determine_bridging_angle(&area_to_be_bridge, &to_segments(&boundary))
                };
                if cfg.internal_bridge_angle > 0.0 {
                    if cfg.relative_bridge_angle { angle += cfg.internal_bridge_angle } else { angle = cfg.internal_bridge_angle }
                }
                boundary.extend(anchors.iter().cloned());
                let bsegs = to_segments(&boundary);
                let mut bridging_area = construct_anchored_polygon(&area_to_be_bridge, &bsegs, spacing, flow.width, angle);
                // reuse a neighbour's angle when their areas would touch
                {
                    let tmp = expand(&bridging_area, 3.0 * spacing);
                    if let Some(s) = expanded.iter().find(|s| !it(&s.new_polys, &tmp).is_empty()) {
                        angle = s.angle;
                        bridging_area = construct_anchored_polygon(&area_to_be_bridge, &bsegs, spacing, flow.width, angle);
                    }
                }
                bridging_area = opening(&bridging_area, spacing * 0.75);
                bridging_area = closing(&bridging_area, spacing);
                bridging_area = it(&bridging_area, &limiting_area);
                bridging_area = it(&bridging_area, &total_fill_area);
                bridging_area = df(&bridging_area, &total_top_area);
                expansion_area = df(&expansion_area, &bridging_area);
                expanded.push(Cand { surf: cand.surf, new_polys: bridging_area, angle });
            }
            by_layer.insert(lidx, expanded);
        }
    }

    // ------------------------------------------------------------------ apply
    let by_layer = by_layer;
    let all: Vec<usize> = (0..n).collect();
    let this = &*st;
    // layer lidx reads and replaces only its own fill surfaces plus the (immutable) candidate map
    let applied: Vec<Option<Vec<Surface>>> = super::pmap(&all, |_, &lidx| {
        let st = this;
        if !by_layer.contains_key(&lidx) && !by_layer.contains_key(&(lidx + 1)) { return None; }
        let mut cut: Polys = vec![];
        if let Some(cs) = by_layer.get(&lidx) { for c in cs { cut.extend(c.new_polys.iter().cloned()); } }
        let solid_sp = st.flow(FlowRole::SolidInfill, lidx).spacing;
        let mut ensuring: Polys = vec![];
        if let Some(cs) = by_layer.get(&(lidx + 1)) {
            for c in cs {
                let sp_up = st.flow(FlowRole::SolidInfill, lidx + 1).spacing;
                ensuring.extend(df(&c.new_polys, &shrink(&c.new_polys, sp_up)));
            }
        }
        let all_fill = polys_of(&st.fill[lidx], &[T::Top, T::Bottom, T::BottomBridge, T::Internal, T::InternalSolid, T::InternalBridge]);
        let near_perimeters = df(&all_fill, &shrink(&all_fill, solid_sp));
        let additional = it(&u(&ensuring), &near_perimeters);

        let old = &st.fill[lidx];
        let mut out: Vec<Surface> = old.iter().filter(|s| !matches!(s.ty, T::Internal | T::InternalSolid)).cloned().collect();
        let new_internal = df(&df(&polys_of(old, &[T::Internal]), &cut), &additional);
        for p in new_internal { out.push(Surface::new(T::Internal, p)); }
        if let Some(cs) = by_layer.get(&lidx) {
            for c in cs {
                for p in u(&c.new_polys) { out.push(Surface { ty: T::InternalBridge, poly: p, bridge_angle: c.angle }); }
            }
        }
        let mut solids = polys_of(old, &[T::InternalSolid]);
        solids = un(&solids, &additional);
        solids = df(&solids, &cut);
        for p in solids { out.push(Surface::new(T::InternalSolid, p)); }
        Some(out)
    });
    for (lidx, o) in applied.into_iter().enumerate() { if let Some(o) = o { st.fill[lidx] = o; } }
}

/// Sparse infill areas that are sparse in every layer the thick thread spans (`gather_areas_w_depth`).
fn gather_areas_w_depth(st: &State, lidx: usize, target_h: f64) -> Polys {
    let mut sparse_all: Polys = vec![];
    let mut not_sparse: Polys = vec![];
    // Orca's lambda receives target_flow_height (= height * 0.9) and multiplies by the 0.9 factor AGAIN
    let bottom_z = st.print_z(lidx) - target_h * 0.9 - 1e-4;
    let mut i = lidx as isize - 1;
    while i >= 0 {
        let iu = i as usize;
        if st.print_z(iu) < bottom_z && iu + 1 < lidx { break; }
        for s in &st.fill[iu] {
            if s.ty == T::Internal && st.cfg.sparse_density < 1.0 { sparse_all.push(s.poly.clone()); } else { not_sparse.push(s.poly.clone()); }
        }
        i -= 1;
    }
    let sa = closing(&u(&sparse_all), EPS);
    let ns = closing(&u(&not_sparse), EPS);
    df(&sa, &ns)
}

/// `determine_bridging_angle`: the direction perpendicular to the nearest anchor lines, voted along the boundary.
fn determine_bridging_angle(bridged: &Polys, anchors: &[Seg]) -> f64 {
    // key: angle in 1e-9 rad units to get a total order
    let mut counted: BTreeMap<i64, (f64, i32)> = BTreeMap::new();
    let key = |a: f64| (a * 1e9).round() as i64;
    for r in rings(bridged) {
        let mut acc = 0.0;
        let m = r.len();
        for k in 0..m.saturating_sub(1) {
            let (start, next) = (r[k], r[k + 1]);
            let v = [next[0] - start[0], next[1] - start[1]];
            let dist = v[0].hypot(v[1]);
            acc += dist;
            if acc > 2.0 {
                acc = 0.0;
                let vn = [v[0] / dist, v[1] / dist];
                let lines_count = (dist / 2.0).ceil() as usize;
                let step = dist / lines_count as f64;
                for i in 0..lines_count {
                    let a = [start[0] + vn[0] * (i as f64 * step), start[1] + vn[1] * (i as f64 * step)];
                    if let Some(l) = nearest_segment(anchors, a) {
                        let mut ang = (l.1[1] - l.0[1]).atan2(l.1[0] - l.0[0]);
                        if ang < 0.0 { ang += 2.0 * PI; }
                        if ang > PI { ang -= PI; }
                        ang += PI * 0.5;
                        counted.entry(key(ang)).or_insert((ang, 0)).1 += 1;
                    }
                }
            }
        }
    }
    let items: Vec<(f64, i32)> = counted.values().cloned().collect();
    let mut best = (0.0f64, 0i32);
    for &(dir, _) in &items {
        let (mut score, mut acc) = (0i32, 0.0f64);
        let ws = dir - PI * 0.1;
        let we = dir + PI * 0.1;
        for &(a, c) in &items { if a >= ws && a <= we { acc += a * c as f64; score += c; } }
        if ws < 0.5 * PI {
            let lo = 1.5 * PI - (0.5 * PI - ws);
            for &(a, c) in &items { if a >= lo { acc += (a - PI) * c as f64; score += c; } }
        }
        if ws > 1.5 * PI {
            let hi = ws - 1.5 * PI;
            for &(a, c) in &items { if a <= hi { acc += (a + PI) * c as f64; score += c; } }
        }
        if score > best.1 { best = (acc / score as f64, score); }
    }
    let mut ang = best.0;
    if ang == 0.0 { ang = 0.001; }
    ang
}

fn nearest_segment(segs: &[Seg], p: Pt) -> Option<Seg> {
    let mut best: Option<(f64, Seg)> = None;
    for &(a, b) in segs {
        let d = dist_point_seg(p, a, b);
        if best.map_or(true, |(bd, _)| d < bd) { best = Some((d, (a, b))); }
    }
    best.map(|b| b.1)
}

fn dist_point_seg(p: Pt, a: Pt, b: Pt) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 { return dist(p, a); }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0);
    dist(p, [a[0] + t * dx, a[1] + t * dy])
}

/// `construct_anchored_polygon`: fill `bridged` with threads along `angle`, stretch each thread to the
/// nearest anchor on both ends, and rebuild a polygon from the stretched threads.
fn construct_anchored_polygon(bridged: &Polys, anchors: &[Seg], spacing: f64, width: f64, angle: f64) -> Polys {
    let aligning = -angle + PI * 0.5;
    let area_r = rotate_polys(bridged, aligning);
    let (c, s) = (aligning.cos(), aligning.sin());
    let anchors_r: Vec<Seg> = anchors.iter().map(|&(a, b)| (rot(a, c, s), rot(b, c, s))).collect();
    let Some(bb_x) = bbox(&area_r) else { return vec![] };
    let n_vlines = (((bb_x[2] - bb_x[0]) + spacing - 1e-9) / spacing).ceil().max(0.0) as usize;
    let area_edges: Vec<Seg> = rings(&area_r).iter().flat_map(|r| { let m = r.len(); (0..m).map(move |i| (r[i], r[(i + 1) % m])) }).collect();

    let cross_x = |edges: &[Seg], x: f64| -> Vec<f64> {
        let mut ys = vec![];
        for &(a, b) in edges {
            if (a[0] <= x) != (b[0] <= x) {
                let t = (x - a[0]) / (b[0] - a[0]);
                ys.push(a[1] + t * (b[1] - a[1]));
            }
        }
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ys
    };
    #[derive(Clone, Copy)]
    struct Sec { a: Pt, b: Pt }
    let mut polygon_sections: Vec<Vec<Sec>> = vec![vec![]; n_vlines];
    for i in 0..n_vlines {
        let x = bb_x[0] + (i as f64 + 0.5) * spacing;
        let ys = cross_x(&area_edges, x);
        let mut secs: Vec<Sec> = vec![];
        for k in 0..ys.len().saturating_sub(1) {
            let mid = (ys[k] + ys[k + 1]) / 2.0;
            if inside(&area_r, x, mid) { secs.push(Sec { a: [x, ys[k]], b: [x, ys[k + 1]] }); }
        }
        let anchors_y = cross_x(&anchors_r, x);
        for sec in &mut secs {
            // closest anchor strictly below the section start / above its end
            if let Some(&y) = anchors_y.iter().rev().find(|&&y| y < sec.a[1]) { sec.a = [x, y - width]; }
            if let Some(&y) = anchors_y.iter().find(|&&y| y > sec.b[1]) { sec.b = [x, y + width]; }
        }
        // merge overlapping sections
        for k in 0..secs.len().saturating_sub(1) {
            let (alow, ahigh, blow, bhigh) = (secs[k].a[1], secs[k].b[1], secs[k + 1].a[1], secs[k + 1].b[1]);
            let overlap = (alow >= blow && alow <= bhigh) || (ahigh >= blow && ahigh <= bhigh) || (blow >= alow && blow <= ahigh) || (bhigh >= alow && bhigh <= ahigh);
            if overlap {
                let sa = secs[k];
                if sa.a[1] < secs[k + 1].a[1] { secs[k + 1].a = sa.a; }
                if !(sa.b[1] < secs[k + 1].b[1]) { secs[k + 1].b = sa.b; }
                secs[k].a = secs[k].b;
            }
        }
        secs.retain(|s| s.a != s.b);
        secs.sort_by(|a, b| a.a[1].partial_cmp(&b.b[1]).unwrap());
        polygon_sections[i] = secs;
    }
    // reconstruct polygons from the sections of adjacent vertical lines
    struct Traced { lows: Vec<Pt>, highs: Vec<Pt> }
    let half = [spacing / 2.0, 0.0];
    let add = |p: Pt, d: Pt| [p[0] + d[0], p[1] + d[1]];
    let sub = |p: Pt, d: Pt| [p[0] - d[0], p[1] - d[1]];
    let mut out_polys: Vec<Vec<Pt>> = vec![];
    let mut current: Vec<Traced> = vec![];
    let thr = 36.0 * spacing * spacing;
    for slice in &polygon_sections {
        let mut used = vec![false; slice.len()];
        for tp in current.iter_mut() {
            let low_y = tp.lows.last().unwrap()[1];
            let high_y = tp.highs.last().unwrap()[1];
            let begin = slice.iter().position(|s| s.b[1] > low_y).unwrap_or(slice.len());
            let end = slice.iter().position(|s| s.a[1] > high_y).unwrap_or(slice.len());
            let mut added = false;
            let mut k = begin;
            while k < end && !added {
                if used[k] { k += 1; continue; }
                let cand = slice[k];
                let ll = *tp.lows.last().unwrap();
                if (ll[0] - cand.a[0]).powi(2) + (ll[1] - cand.a[1]).powi(2) < thr { tp.lows.push(cand.a); } else {
                    tp.lows.push(add(ll, half));
                    tp.lows.push(sub(cand.a, half));
                    tp.lows.push(cand.a);
                }
                let hl = *tp.highs.last().unwrap();
                if (hl[0] - cand.b[0]).powi(2) + (hl[1] - cand.b[1]).powi(2) < thr { tp.highs.push(cand.b); } else {
                    tp.highs.push(add(hl, half));
                    tp.highs.push(sub(cand.b, half));
                    tp.highs.push(cand.b);
                }
                added = true;
                used[k] = true;
                k += 1;
            }
            if !added {
                let ll = *tp.lows.last().unwrap();
                let hl = *tp.highs.last().unwrap();
                tp.lows.push(add(ll, half));
                tp.highs.push(add(hl, half));
                let mut poly = std::mem::take(&mut tp.lows);
                poly.extend(tp.highs.drain(..).rev());
                out_polys.push(poly);
            }
        }
        current.retain(|t| !t.lows.is_empty());
        for (k, seg) in slice.iter().enumerate() {
            if !used[k] {
                current.push(Traced { lows: vec![sub(seg.a, half), seg.a], highs: vec![sub(seg.b, half), seg.b] });
            }
        }
    }
    for tp in current {
        let mut poly = tp.lows;
        poly.extend(tp.highs.into_iter().rev());
        out_polys.push(poly);
    }
    let polys: Polys = out_polys.into_iter().filter(|p| p.len() >= 3).map(|p| Poly { contour: p, holes: vec![] }).collect();
    // union with non-zero fill so orientation does not matter
    let polys = crate::geom::union_all(&[&polys.iter().map(|p| {
        let mut p = p.clone();
        if ring_area(&p.contour) < 0.0 { p.contour.reverse(); }
        p
    }).collect::<Polys>()]);
    rotate_polys(&polys, -aligning)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bridge polygon of a rectangular 48 x 18.4 mm solid area bridged along a 45 degree direction (syn_bridge_span_30mm,
    /// layer 95). Its edges are staircases of half-spacing steps, so `closing` by one spacing must give back at least the
    /// polygon; with the i_overlay offset it lost 5 % of the area (1010 -> 958 mm2), leaving periodic unbridged notches
    /// along the walls that were then printed as 0.9 x 0.4 mm internal-solid slivers.
    #[test]
    fn bridge_polygon_survives_the_closing_step() {
        let rect: Polys = vec![Poly { contour: vec![[114.04, 118.79], [162.46, 118.79], [162.46, 137.21], [114.04, 137.21]], holes: vec![] }];
        let spacing = 0.45;
        let mut boundary: Vec<Vec<Pt>> = vec![];
        for r in rings(&expand(&rect, 1.3 * spacing)) { let mut c = r.clone(); c.push(c[0]); boundary.push(c); }
        let segs = to_segments(&boundary);
        let area_to_be_bridge = expand(&rect, spacing);
        let poly = construct_anchored_polygon(&area_to_be_bridge, &segs, spacing, 0.4, 225f64.to_radians());
        let opened = opening(&poly, spacing * 0.75);
        let closed = closing(&opened, spacing);
        assert!(area(&closed) >= area(&opened) - 1e-3, "closing lost {} of {} mm2", area(&opened) - area(&closed), area(&opened));
        // the bridge, clipped to the fill area, must cover it completely: no unbridged notches
        let covered = it(&closed, &rect);
        assert!(area(&rect) - area(&covered) < 0.05, "{} mm2 of the area stays unbridged", area(&rect) - area(&covered));
    }
}
