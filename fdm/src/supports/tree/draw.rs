//! Organic branch drawing (Support/TreeSupport3D.cpp: `organic_draw_branches`, `extrude_branch`,
//! `organic_smooth_branches_avoid_collisions` (new version)). Branches are tubes of circles; the mesh
//! is sliced at the layer mid-heights with a private slicer (loops combined with a positive fill).
use super::areas::*;
use super::settings::*;
use super::tips::*;
use crate::supports::normal::LT;
use crate::supports::poly;
use crate::types::{Poly, Polys, Ring};
use std::collections::HashMap;

type V3 = [f32; 3];
fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn add(a: V3, b: V3) -> V3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
fn mul(a: V3, k: f32) -> V3 { [a[0] * k, a[1] * k, a[2] * k] }
fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn norm(a: V3) -> f32 { (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt() }
fn normalized(a: V3) -> V3 { let n = norm(a); if n == 0.0 { a } else { mul(a, 1.0 / n) } }
fn sq3(a: V3) -> f32 { a[0] * a[0] + a[1] * a[1] + a[2] * a[2] }

struct Its { vertices: Vec<V3>, indices: Vec<[usize; 3]> }

fn triangulate_fan(its: &mut Its, flip: bool, ifan: usize, ibegin: usize, iend: usize) {
    let mut u = iend - 1;
    for v in ibegin..iend {
        if flip { its.indices.push([ifan, u, v]); } else { its.indices.push([ifan, v, u]); }
        u = v;
    }
}

fn triangulate_strip(its: &mut Its, ibegin1: usize, iend1: usize, ibegin2: usize, iend2: usize) {
    let mut n1 = iend1 - ibegin1;
    let mut n2 = iend2 - ibegin2;
    let mut istart2 = ibegin2;
    {
        let p1 = its.vertices[ibegin1];
        let mut d2min = f32::MAX;
        for i in ibegin2..iend2 {
            let d2 = sq3(sub(its.vertices[i], p1));
            if d2 < d2min { d2min = d2; istart2 = i; }
        }
    }
    let mut u = ibegin1;
    let mut v = istart2;
    while n1 > 0 || n2 > 0 {
        let take_first;
        let (mut u2, mut v2) = (u, v);
        let upd_u2 = |u: usize| -> usize { let mut x = u + 1; if x == iend1 { x = ibegin1; } x };
        let upd_v2 = |v: usize| -> usize { let mut x = v + 1; if x == iend2 { x = ibegin2; } x };
        if n1 == 0 { take_first = false; v2 = upd_v2(v); }
        else if n2 == 0 { take_first = true; u2 = upd_u2(u); }
        else {
            u2 = upd_u2(u);
            v2 = upd_v2(v);
            let l1 = sq3(sub(its.vertices[u2], its.vertices[v]));
            let l2 = sq3(sub(its.vertices[v2], its.vertices[u]));
            take_first = l1 < l2;
        }
        if take_first { its.indices.push([u, u2, v]); n1 -= 1; u = u2; }
        else { its.indices.push([u, v2, v]); n2 -= 1; v = v2; }
    }
}

fn discretize_circle(center: V3, normal: V3, radius: f32, eps: f32, pts: &mut Vec<V3>) -> (usize, usize) {
    let mut angle_step = 2.0 * (1.0 - eps / radius).acos();
    let nsteps = (2.0 * std::f32::consts::PI / angle_step).ceil() as i32;
    angle_step = 2.0 * std::f32::consts::PI / nsteps as f32;
    let x = normalized(cross(normal, [0.0, -1.0, 0.0]));
    let y = normalized(cross(normal, x));
    let begin = pts.len();
    let (x, y) = (mul(x, radius), mul(y, radius));
    let mut angle = 0.0f32;
    for _ in 0..nsteps {
        pts.push(add(center, add(mul(x, angle.cos()), mul(y, angle.sin()))));
        angle += angle_step;
    }
    (begin, pts.len())
}

#[derive(Clone)]
pub struct PathElem { pub layer_idx: LayerIndex, pub pos: Pt, pub radius: C, pub z: f64 }

fn extrude_branch(path: &[PathElem], has_root: bool, result: &mut Its) -> (f32, f32) {
    const EPS: f32 = 0.015;
    let mut prev_strip = (0usize, 0usize);
    let (mut zmin, mut zmax) = (0.0f32, 0.0f32);
    let p3d = |e: &PathElem| -> [f64; 3] { let m = pt_mm(e.pos); [m[0], m[1], e.z] };
    let v3 = |a: [f64; 3], b: [f64; 3]| -> [f64; 3] { let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt(); if n == 0.0 { d } else { [d[0] / n, d[1] / n, d[2] / n] } };
    let f3 = |a: [f64; 3]| -> V3 { [a[0] as f32, a[1] as f32, a[2] as f32] };
    let mut nprev = [0.0f64; 3];
    for ipath in 1..path.len() {
        let prev = &path[ipath - 1];
        let current = &path[ipath];
        let p1 = p3d(prev);
        let p2 = p3d(current);
        let v1 = v3(p2, p1);
        if ipath == 1 {
            nprev = v1;
            let radius = mm(prev.radius) as f32;
            if has_root && prev.layer_idx == 0 {
                let normal: V3 = [0.0, 0.0, 1.0];
                let bottom_center: V3 = [p1[0] as f32, p1[1] as f32, 0.0];
                let top_center: V3 = [p1[0] as f32, p1[1] as f32, p1[2] as f32];
                let ifan = result.vertices.len();
                result.vertices.push(bottom_center);
                let bottom_strip = discretize_circle(bottom_center, normal, radius, EPS, &mut result.vertices);
                triangulate_fan(result, false, ifan, bottom_strip.0, bottom_strip.1);
                prev_strip = discretize_circle(top_center, normal, radius, EPS, &mut result.vertices);
                triangulate_strip(result, bottom_strip.0, bottom_strip.1, prev_strip.0, prev_strip.1);
                zmin = 0.0;
            } else {
                let mut angle_step = 2.0 * (1.0 - EPS / radius).acos();
                let nsteps = (std::f32::consts::PI / (2.0 * angle_step)).ceil() as i32;
                angle_step = std::f32::consts::PI / (2.0 * nsteps as f32);
                let ifan = result.vertices.len();
                let nprev_f = f3(nprev);
                result.vertices.push(sub(f3(p1), mul(nprev_f, radius)));
                zmin = result.vertices.last().unwrap()[2];
                let mut angle = angle_step;
                for i in 1..nsteps {
                    let c = sub(f3(p1), mul(nprev_f, radius * angle.cos()));
                    let strip = discretize_circle(c, nprev_f, radius * angle.sin(), EPS, &mut result.vertices);
                    if i == 1 { triangulate_fan(result, false, ifan, strip.0, strip.1); }
                    else { triangulate_strip(result, prev_strip.0, prev_strip.1, strip.0, strip.1); }
                    prev_strip = strip;
                    angle += angle_step;
                }
            }
        }
        let ncurrent;
        if ipath + 1 == path.len() {
            ncurrent = v1;
            let radius = mm(current.radius) as f32;
            let mut angle_step = 2.0 * (1.0 - EPS / radius).acos();
            let nsteps = (std::f32::consts::PI / (2.0 * angle_step)).ceil() as i32;
            angle_step = std::f32::consts::PI / (2.0 * nsteps as f32);
            let mut angle = std::f32::consts::FRAC_PI_2;
            let nc = f3(ncurrent);
            for _ in 0..nsteps {
                let c = add(f3(p2), mul(nc, radius * angle.cos()));
                let strip = discretize_circle(c, nc, radius * angle.sin(), EPS, &mut result.vertices);
                triangulate_strip(result, prev_strip.0, prev_strip.1, strip.0, strip.1);
                prev_strip = strip;
                angle -= angle_step;
            }
            let ifan = result.vertices.len();
            result.vertices.push(add(f3(p2), mul(nc, radius)));
            zmax = result.vertices.last().unwrap()[2];
            triangulate_fan(result, true, ifan, prev_strip.0, prev_strip.1);
        } else {
            let next = &path[ipath + 1];
            let p3 = p3d(next);
            let v2 = v3(p3, p2);
            let s = [v1[0] + v2[0], v1[1] + v2[1], v1[2] + v2[2]];
            let n = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
            ncurrent = if n == 0.0 { s } else { [s[0] / n, s[1] / n, s[2] / n] };
            let radius = mm(current.radius) as f32;
            let strip = discretize_circle(f3(p2), f3(ncurrent), radius, EPS, &mut result.vertices);
            triangulate_strip(result, prev_strip.0, prev_strip.1, strip.0, strip.1);
            prev_strip = strip;
        }
    }
    (zmin, zmax)
}

// -------------------------------------------------------------------------- slicing of the tube mesh
fn slice_its(its: &Its, zs: &[f64]) -> Vec<Polys> {
    let n = zs.len();
    let mut buckets: Vec<Vec<([f64; 2], [f64; 2], (usize, usize), (usize, usize))>> = vec![Vec::new(); n];
    let cut = |i: usize, j: usize, s: f64| -> ([f64; 2], (usize, usize)) {
        let (lo, hi) = if i < j { (i, j) } else { (j, i) };
        let (p, q) = (its.vertices[lo], its.vertices[hi]);
        let (pz, qz) = (p[2] as f64, q[2] as f64);
        let t = (s - pz) / (qz - pz);
        ([p[0] as f64 + t * (q[0] as f64 - p[0] as f64), p[1] as f64 + t * (q[1] as f64 - p[1] as f64)], (lo, hi))
    };
    for t in &its.indices {
        let v = [its.vertices[t[0]], its.vertices[t[1]], its.vertices[t[2]]];
        let zmin = v[0][2].min(v[1][2]).min(v[2][2]) as f64;
        let zmax = v[0][2].max(v[1][2]).max(v[2][2]) as f64;
        if zmin == zmax { continue; }
        let first = zs.partition_point(|&s| s <= zmin);
        let last = zs.partition_point(|&s| s <= zmax);
        for li in first..last {
            let s = zs[li];
            let mut up: Option<([f64; 2], (usize, usize))> = None;
            let mut down: Option<([f64; 2], (usize, usize))> = None;
            for e in 0..3 {
                let (i, j) = (t[e], t[(e + 1) % 3]);
                let (zi, zj) = (v[e][2] as f64, v[(e + 1) % 3][2] as f64);
                let (bi, bj) = (zi < s, zj < s);
                if bi == bj { continue; }
                let c = cut(i, j, s);
                if bi { up = Some(c); } else { down = Some(c); }
            }
            if let (Some(u), Some(d)) = (up, down) { buckets[li].push((d.0, u.0, d.1, u.1)); }
        }
    }
    let mut out: Vec<Polys> = Vec::with_capacity(n);
    for segs in buckets {
        let mut by_start: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
        for (i, s) in segs.iter().enumerate() { by_start.entry(s.2).or_default().push(i); }
        let mut used = vec![false; segs.len()];
        let mut rings: Vec<Ring> = Vec::new();
        for s0 in 0..segs.len() {
            if used[s0] { continue; }
            used[s0] = true;
            let mut pts = vec![segs[s0].0, segs[s0].1];
            let mut cur_end = segs[s0].3;
            let start_key = segs[s0].2;
            loop {
                if cur_end == start_key { pts.pop(); if pts.len() >= 3 { rings.push(pts); } break; }
                let next = by_start.get(&cur_end).and_then(|v| v.iter().copied().find(|&i| !used[i]));
                match next {
                    Some(i) => { used[i] = true; pts.push(segs[i].1); cur_end = segs[i].3; }
                    None => break, // open chain (numerical), dropped
                }
            }
        }
        out.push(poly::union_rings(&rings));
    }
    out
}

// -------------------------------------------------------------------------- smoothing / nudging
struct Sphere {
    layer: LayerIndex,
    link_down: i32,
    locked: bool,
    radius: f32,
    position: [f32; 3],
    prev_position: [f32; 3],
    min_z: f32,
    max_z: f32,
    layer_begin: u32,
    layer_end: u32,
    parents: Vec<i32>,
    r_scaled: C,
}

struct LayerLines { lines: Vec<([f64; 2], [f64; 2])>, grid: HashMap<(i32, i32), Vec<u32>>, cell: f64 }
impl LayerLines {
    fn new(polys: &Polys) -> LayerLines {
        let mut lines = Vec::new();
        for r in poly::rings(polys) { let n = r.len(); for i in 0..n { lines.push((r[i], r[(i + 1) % n])); } }
        let cell = 2.0;
        let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, l) in lines.iter().enumerate() {
            let (x0, x1) = (l.0[0].min(l.1[0]), l.0[0].max(l.1[0]));
            let (y0, y1) = (l.0[1].min(l.1[1]), l.0[1].max(l.1[1]));
            for cx in (x0 / cell).floor() as i32..=(x1 / cell).floor() as i32 { for cy in (y0 / cell).floor() as i32..=(y1 / cell).floor() as i32 { grid.entry((cx, cy)).or_default().push(i as u32); } }
        }
        LayerLines { lines, grid, cell }
    }
    /// squared distance to the closest line if it is below `max_sqr` (None otherwise), with the closest point
    fn nearest(&self, p: [f64; 2], max_sqr: f64) -> Option<(f64, [f64; 2])> {
        let r = max_sqr.sqrt();
        let (cx0, cx1) = (((p[0] - r) / self.cell).floor() as i32, ((p[0] + r) / self.cell).floor() as i32);
        let (cy0, cy1) = (((p[1] - r) / self.cell).floor() as i32, ((p[1] + r) / self.cell).floor() as i32);
        let mut best: Option<(f64, [f64; 2])> = None;
        let mut seen: std::collections::HashSet<u32> = Default::default();
        for cx in cx0..=cx1 { for cy in cy0..=cy1 {
            if let Some(v) = self.grid.get(&(cx, cy)) {
                for &li in v {
                    if !seen.insert(li) { continue; }
                    let (a, b) = self.lines[li as usize];
                    let ab = [b[0] - a[0], b[1] - a[1]];
                    let l2 = ab[0] * ab[0] + ab[1] * ab[1];
                    let t = if l2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2).clamp(0.0, 1.0) };
                    let q = [a[0] + t * ab[0], a[1] + t * ab[1]];
                    let d2 = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2);
                    if d2 <= max_sqr && best.map(|b| d2 < b.0).unwrap_or(true) { best = Some((d2, q)); }
                }
            }
        } }
        best
    }
}

fn layer_idx_ceil(ctx: &TreeCtx, z: f64) -> LayerIndex {
    let first_object_z = ctx.g.sp.object_print_z_min + ctx.g.sp.first_object_layer_height;
    let rl = &ctx.tcfg.raft_layers;
    if !rl.is_empty() && z < first_object_z - 1e-4 {
        let it = rl.partition_point(|&x| x < z - 1e-4);
        return it as LayerIndex;
    }
    rl.len() as LayerIndex + ((z - first_object_z) / ctx.g.sp.layer_height).ceil().max(0.0) as LayerIndex
}
fn layer_idx_floor(ctx: &TreeCtx, z: f64) -> LayerIndex {
    let first_object_z = ctx.g.sp.object_print_z_min + ctx.g.sp.first_object_layer_height;
    let rl = &ctx.tcfg.raft_layers;
    if !rl.is_empty() && z < first_object_z - 1e-4 {
        let it = rl.partition_point(|&x| x <= z + 1e-4);
        return if it == 0 { 0 } else { it as LayerIndex - 1 };
    }
    rl.len() as LayerIndex + ((z - first_object_z) / ctx.g.sp.layer_height).floor().max(0.0) as LayerIndex
}

fn organic_smooth(ctx: &mut TreeCtx, elems: &[(usize, usize, i32)], linear_data_layers: &[usize]) {
    let cfg = ctx.tcfg.clone();
    let layer_height_mm = ctx.g.sp.layer_height;
    // per layer collision lines (radius 0)
    let mut max_layer = 0usize;
    for e in elems { max_layer = max_layer.max(e.0); }
    let mut known: Vec<bool> = vec![false; max_layer + 1];
    for e in elems { known[e.0] = true; }
    let mut caches: Vec<Option<LayerLines>> = Vec::with_capacity(max_layer + 1);
    for l in 0..=max_layer {
        if !known[l] { caches.push(None); continue; }
        let col = ctx.volumes.collision_radius0(l as i32);
        caches.push(Some(LayerLines::new(&col)));
    }
    let mut spheres: Vec<Sphere> = Vec::with_capacity(elems.len());
    for &(l, i, link) in elems {
        let e = &ctx.move_bounds[l][i];
        let locked = e.parents.is_empty() || (link == -1 && e.state.layer_idx > 0);
        let r = element_radius(&cfg, &e.state);
        let pm = pt_mm(e.state.result_on_layer);
        let z = layer_z(ctx.g, &ctx.tcfg, e.state.layer_idx as usize) as f32;
        let mut sp = Sphere { layer: e.state.layer_idx, link_down: link, locked, radius: mm(r) as f32, position: [pm[0] as f32, pm[1] as f32, z],
                              prev_position: [0.0; 3], min_z: f32::MIN, max_z: f32::MAX, layer_begin: 0, layer_end: 0, parents: e.parents.clone(), r_scaled: r };
        if link != -1 {
            let off_below = linear_data_layers[e.state.layer_idx as usize - 1];
            sp.min_z = spheres[off_below + link as usize].min_z;
        } else { sp.min_z = sp.position[2]; }
        spheres.push(sp);
    }
    for id in (0..spheres.len()).rev() {
        if spheres[id].parents.is_empty() { spheres[id].max_z = spheres[id].position[2]; }
        else {
            let off_above = linear_data_layers[spheres[id].layer as usize + 1];
            let mut mz = spheres[id].max_z;
            for &ip in &spheres[id].parents { mz = mz.min(spheres[off_above + ip as usize].max_z); }
            spheres[id].max_z = mz;
        }
    }
    for s in spheres.iter_mut() {
        s.min_z = s.min_z.max(s.position[2] - s.radius);
        s.max_z = s.max_z.min(s.position[2] + s.radius);
    }
    let ncache = caches.len() as i32;
    for s in spheres.iter_mut() {
        s.layer_begin = s.layer.min(layer_idx_ceil(ctx, s.min_z as f64)) as u32;
        s.layer_end = (ncache).min(s.layer.max(layer_idx_floor(ctx, s.max_z as f64)) + 1) as u32;
    }
    let collision_extra_gap = 0.1f64;
    let max_nudge_collision_avoidance = 0.5f64;
    let max_nudge_smoothing = 0.2f64;
    let maxd_slow = cfg.maximum_move_distance_slow as f64;
    for _iter in 0..100 {
        for s in spheres.iter_mut() { s.prev_position = s.position; }
        let mut num_moved = 0usize;
        for id in 0..spheres.len() {
            if spheres[id].locked { continue; }
            // limit candidate to linked layers (reads prev positions of neighbours)
            let limit = |spheres: &Vec<Sphere>, id: usize, cand: [f64; 2]| -> [f64; 2] {
                let constrain = |cand: [f64; 2], current: [f64; 2], anchor: [f64; 2], allowed_in: f64| -> [f64; 2] {
                    let d = [cand[0] - anchor[0], cand[1] - anchor[1]];
                    let cd = (d[0] * d[0] + d[1] * d[1]).sqrt();
                    let cur = ((current[0] - anchor[0]).powi(2) + (current[1] - anchor[1]).powi(2)).sqrt();
                    let allowed = allowed_in.max(cur);
                    if cd > allowed && cd > 1e-4 { [anchor[0] + d[0] * (allowed / cd), anchor[1] + d[1] * (allowed / cd)] } else { cand }
                };
                let sp = &spheres[id];
                let cur_pos = [sp.position[0] as f64, sp.position[1] as f64];
                let cur_r = sp.r_scaled as f64;
                let mut cand = cand;
                if sp.link_down != -1 && sp.layer > 0 {
                    let lower_id = linear_data_layers[sp.layer as usize - 1] + sp.link_down as usize;
                    if lower_id < spheres.len() {
                        let lower = &spheres[lower_id];
                        let allowed = ((lower.r_scaled as f64 - cur_r).max(0.0) + maxd_slow) * 1e-6;
                        cand = constrain(cand, cur_pos, [lower.prev_position[0] as f64, lower.prev_position[1] as f64], allowed);
                    }
                }
                let upper_layer_idx = sp.layer as usize + 1;
                if !sp.parents.is_empty() && upper_layer_idx < linear_data_layers.len() {
                    let off = linear_data_layers[upper_layer_idx];
                    for &ip in &sp.parents {
                        let uid = off + ip as usize;
                        if uid >= spheres.len() { continue; }
                        let up = &spheres[uid];
                        let allowed = ((cur_r - up.r_scaled as f64).max(0.0) + maxd_slow) * 1e-6;
                        cand = constrain(cand, cur_pos, [up.prev_position[0] as f64, up.prev_position[1] as f64], allowed);
                    }
                }
                cand
            };
            // collision
            let (pos, radius, layer, lb, le) = { let s = &spheres[id]; (s.position, s.radius as f64, s.layer, s.layer_begin, s.layer_end) };
            let mut last_depth = -f64::MAX;
            let mut last_collision = [0.0f64; 2];
            for layer_id in lb..le {
                let dz = (layer_id as i64 - layer as i64) as f64 * layer_height_mm;
                let r2 = radius * radius - dz * dz;
                if r2 > 0.0 {
                    if let Some(Some(cache)) = caches.get(layer_id as usize) {
                        if let Some((d2, hit)) = cache.nearest([pos[0] as f64, pos[1] as f64], r2) {
                            let depth = r2.sqrt() - d2.sqrt();
                            if depth > last_depth { last_depth = depth; last_collision = hit; }
                        }
                    }
                }
            }
            if last_depth > 0.0 {
                if last_depth > 1e-4 { num_moved += 1; }
                let nudge_dist = (last_depth + collision_extra_gap).max(0.0).min(max_nudge_collision_avoidance);
                let d = [pos[0] as f64 - last_collision[0], pos[1] as f64 - last_collision[1]];
                let dn = (d[0] * d[0] + d[1] * d[1]).sqrt();
                let dirv = if dn > 0.0 { [d[0] / dn, d[1] / dn] } else { [0.0, 0.0] };
                let nudge_vector = [dirv[0] * nudge_dist, dirv[1] * nudge_dist];
                let cand = [pos[0] as f64 + nudge_vector[0] * nudge_dist, pos[1] as f64 + nudge_vector[1] * nudge_dist];
                let cand = limit(&spheres, id, cand);
                spheres[id].position[0] = cand[0] as f32; spheres[id].position[1] = cand[1] as f32;
            }
            // Laplacian smoothing
            {
                let off_above = linear_data_layers[spheres[id].layer as usize + 1];
                let mut avg = [0.0f64; 2];
                let mut weight = 0.0f64;
                let r = spheres[id].radius as f64;
                for &ip in &spheres[id].parents {
                    let p = spheres[off_above + ip as usize].prev_position;
                    avg[0] += r * p[0] as f64; avg[1] += r * p[1] as f64; weight += r;
                }
                if spheres[id].link_down != -1 {
                    let off_below = linear_data_layers[spheres[id].layer as usize - 1];
                    let w = weight;
                    let p = spheres[off_below + spheres[id].link_down as usize].prev_position;
                    avg[0] += w * p[0] as f64; avg[1] += w * p[1] as f64; weight += w;
                }
                if weight > 0.0 {
                    avg[0] /= weight; avg[1] /= weight;
                    let old = [spheres[id].position[0] as f64, spheres[id].position[1] as f64];
                    let new_pos = [0.5 * old[0] + 0.5 * avg[0], 0.5 * old[1] + 0.5 * avg[1]];
                    let shift = [new_pos[0] - old[0], new_pos[1] - old[1]];
                    let nmax = (shift[0] * shift[0] + shift[1] * shift[1]).sqrt();
                    let nudge_dist = nmax.max(0.0).min(max_nudge_smoothing);
                    if nudge_dist > 0.0 {
                        let cand = [old[0] + shift[0] * (nudge_dist / nmax), old[1] + shift[1] * (nudge_dist / nmax)];
                        let cand = limit(&spheres, id, cand);
                        spheres[id].position[0] = cand[0] as f32; spheres[id].position[1] = cand[1] as f32;
                    }
                }
            }
        }
        if num_moved == 0 { break; }
    }
    for (i, &(l, ei, _)) in elems.iter().enumerate() {
        let p = spheres[i].position;
        ctx.move_bounds[l][ei].state.result_on_layer = [(p[0] / 1e-6) as i64, (p[1] / 1e-6) as i64];
    }
}

// --------------------------------------------------------------------------- the main drawing function
struct Branch { path: Vec<(usize, usize)>, has_root: bool, has_tip: bool }
#[derive(Default, Clone)]
struct Slice { polygons: Polys, bottom_contacts: Polys, num_branches: usize }
#[derive(Default)]
struct Tree { branches: Vec<Branch>, slices: Vec<Slice>, first_layer_id: i32 }

fn visit_recursive(mb: &mut Vec<Vec<Elem>>, start: (usize, usize), out: &mut Tree) {
    mb[start.0][start.1].state.marked = true;
    let root = out.branches.is_empty();
    let np = mb[start.0][start.1].parents.len();
    for parent_idx in 0..np {
        let mut path: Vec<(usize, usize)> = vec![start];
        let first_parent = (start.0 + 1, mb[start.0][start.1].parents[parent_idx] as usize);
        path.push(first_parent);
        let fp_parents = mb[first_parent.0][first_parent.1].parents.len();
        if fp_parents < 2 { mb[first_parent.0][first_parent.1].state.marked = true; }
        let mut next_branch: Option<(usize, usize)> = None;
        if fp_parents == 1 {
            let mut parent = first_parent;
            loop {
                let next_parent = (parent.0 + 1, mb[parent.0][parent.1].parents[0] as usize);
                path.push(next_parent);
                if mb[next_parent.0][next_parent.1].parents.len() > 1 { next_branch = Some(next_parent); break; }
                mb[next_parent.0][next_parent.1].state.marked = true;
                if mb[next_parent.0][next_parent.1].parents.is_empty() { break; }
                parent = next_parent;
            }
        } else if fp_parents > 1 { next_branch = Some(first_parent); }
        out.branches.push(Branch { path, has_root: root, has_tip: next_branch.is_none() });
        if let Some(nb) = next_branch { visit_recursive(mb, nb, out); }
    }
}

pub fn organic_draw_branches(ctx: &mut TreeCtx) {
    let cfg = ctx.tcfg.clone();
    let n_layers = ctx.move_bounds.len();
    // elements with link down
    let mut elems: Vec<(usize, usize, i32)> = Vec::new();
    let mut linear_data_layers: Vec<usize> = vec![0];
    {
        let mut map_old: HashMap<(usize, usize), usize> = HashMap::new();
        for layer_idx in 0..n_layers {
            let mut map_new: HashMap<(usize, usize), usize> = HashMap::new();
            for ei in 0..ctx.move_bounds[layer_idx].len() {
                let child: i32 = if layer_idx > 0 { map_old.get(&(layer_idx, ei)).map(|c| *c as i32).unwrap_or(-1) } else { -1 };
                if layer_idx + 1 < n_layers {
                    for &p in &ctx.move_bounds[layer_idx][ei].parents {
                        if ctx.move_bounds[layer_idx + 1][p as usize].state.result_set() { map_new.insert((layer_idx + 1, p as usize), ei); }
                    }
                }
                elems.push((layer_idx, ei, child));
            }
            map_old = map_new;
            linear_data_layers.push(elems.len());
        }
    }
    organic_smooth(ctx, &elems, &linear_data_layers);
    for l in ctx.move_bounds.iter_mut() { for e in l.iter_mut() { e.state.marked = false; } }
    // trees
    let mut trees: Vec<Tree> = Vec::new();
    for layer_idx in 0..n_layers.saturating_sub(1) {
        for ei in 0..ctx.move_bounds[layer_idx].len() {
            let e = &ctx.move_bounds[layer_idx][ei];
            if !e.state.marked && !e.parents.is_empty() {
                let mut t = Tree { first_layer_id: -1, ..Default::default() };
                visit_recursive(&mut ctx.move_bounds, (layer_idx, ei), &mut t);
                trees.push(t);
            }
        }
    }
    let tiny = 1e-6;
    let bed = ctx.volumes.bed_area.clone();
    for ti in 0..trees.len() {
        let nb = trees[ti].branches.len();
        for bi in 0..nb {
            let (path_ids, has_root, has_tip) = { let b = &trees[ti].branches[bi]; (b.path.clone(), b.has_root, b.has_tip) };
            let path: Vec<PathElem> = path_ids.iter().map(|&(l, i)| {
                let e = &ctx.move_bounds[l][i];
                PathElem { layer_idx: e.state.layer_idx, pos: e.state.result_on_layer, radius: element_radius(&cfg, &e.state), z: layer_z(ctx.g, &ctx.tcfg, e.state.layer_idx as usize) }
            }).collect();
            let mut mesh = Its { vertices: Vec::new(), indices: Vec::new() };
            let zspan = extrude_branch(&path, has_root, &mut mesh);
            let first = &ctx.move_bounds[path_ids[0].0][path_ids[0].1];
            let last = &ctx.move_bounds[path_ids.last().unwrap().0][path_ids.last().unwrap().1];
            let mut layer_begin: LayerIndex = if has_root { first.state.layer_idx } else { first.state.layer_idx.min(layer_idx_ceil(ctx, zspan.0 as f64)) };
            let layer_end: LayerIndex = (if has_tip { last.state.layer_idx } else { last.state.layer_idx.max(layer_idx_floor(ctx, zspan.1 as f64)) }) + 1;
            if layer_end <= layer_begin { continue; }
            let mut slice_z: Vec<f64> = Vec::new();
            for li in layer_begin..layer_end {
                let print_z = layer_z(ctx.g, &ctx.tcfg, li as usize);
                let bottom_z = if li > 0 { layer_z(ctx.g, &ctx.tcfg, li as usize - 1) } else { 0.0 };
                slice_z.push(0.5 * (bottom_z + print_z));
            }
            let mut slices = slice_its(&mesh, &slice_z);
            if slices.is_empty() { continue; }
            for (i, s) in slices.iter_mut().enumerate() {
                let col = ctx.volumes.get_collision(0, layer_begin + i as i32, true);
                *s = poly::diff(s, &col);
                if !bed.is_empty() { *s = poly::intersect(s, &bed); }
                s.retain(|p| poly::poly_area(p) >= tiny);
            }
            let mut num_empty = 0usize;
            if slices[0].is_empty() { num_empty = slices.iter().position(|s| !s.is_empty()).unwrap_or(slices.len()); }
            if num_empty >= slices.len() { continue; }
            if num_empty > 0 { slices.drain(0..num_empty); layer_begin += num_empty as i32; }
            let slice_front_contact = slices[0].clone();
            let mut bottom_contacts: Vec<Polys> = Vec::new();
            if has_root {
                let front_state = ctx.move_bounds[path_ids[0].0][path_ids[0].1].state.clone();
                if front_state.to_model_gracious {
                    if ctx.tcfg.settings.support_floor_layers > 0 {
                        let contacts;
                        if ctx.tcfg.support_rests_on_model && ctx.tcfg.z_distance_bottom_layers > 0 && layer_begin > 0 {
                            contacts = slice_front_contact.clone();
                        } else {
                            let placeable = ctx.volumes.get_placeable_areas(0, layer_begin);
                            contacts = poly::intersect(&slice_front_contact, &placeable);
                        }
                        let mut contacts = contacts;
                        contacts.retain(|p| poly::poly_area(p) >= tiny);
                        if contacts.is_empty() && ctx.tcfg.support_rests_on_model && layer_begin > 0 && !slice_front_contact.is_empty() { contacts = slice_front_contact.clone(); }
                        if !contacts.is_empty() { bottom_contacts.push(contacts); }
                    }
                } else if layer_begin > 0 {
                    let mut bottom_extra: Vec<(Polys, f64)> = Vec::new();
                    let mut rest_support: Polys = Vec::new();
                    let bottom_radius = element_radius(&cfg, &front_state_to_elem(&front_state));
                    let layers_propagate_max = 5 * bottom_radius / cfg.layer_height;
                    let layer_bottommost: LayerIndex = if front_state.verylost { 0 } else { (layer_begin - layers_propagate_max as i32).max(0) };
                    let support_area_min_radius = std::f64::consts::PI * (mm(cfg.branch_radius)).powi(2);
                    let support_area_stop = (0.2 * std::f64::consts::PI * (mm(bottom_radius)).powi(2)).max(0.5 * support_area_min_radius);
                    let mut li = layer_begin - 1;
                    while li >= layer_bottommost {
                        let collision_layer = if li == layer_begin - 1 { layer_begin } else { li };
                        let collision = ctx.volumes.get_collision(0, collision_layer, false);
                        rest_support = poly::diff(if rest_support.is_empty() { &slice_front_contact } else { &rest_support }, &collision);
                        rest_support.retain(|p| poly::poly_area(p) >= tiny);
                        let a = poly::area(&rest_support);
                        if a < support_area_stop { break; }
                        bottom_extra.push((rest_support.clone(), a));
                        li -= 1;
                    }
                    if ctx.tcfg.settings.support_floor_layers > 0 {
                        let mut contacts: Polys;
                        if !bottom_extra.is_empty() {
                            let contact_idx = bottom_extra.len() - 1;
                            if ctx.tcfg.support_rests_on_model && ctx.tcfg.z_distance_bottom_layers > 0 && layer_begin > 0 {
                                contacts = if bed.is_empty() { bottom_extra[contact_idx].0.clone() } else { poly::intersect(&bottom_extra[contact_idx].0, &bed) };
                            } else {
                                let placeable = ctx.volumes.get_placeable_areas(0, layer_begin);
                                contacts = poly::intersect(&bottom_extra[contact_idx].0, &placeable);
                            }
                        } else if ctx.tcfg.support_rests_on_model && ctx.tcfg.z_distance_bottom_layers > 0 && layer_begin > 0 {
                            contacts = slice_front_contact.clone();
                        } else {
                            let placeable = ctx.volumes.get_placeable_areas(0, layer_begin);
                            contacts = poly::intersect(&slice_front_contact, &placeable);
                        }
                        contacts.retain(|p| poly::poly_area(p) >= tiny);
                        if !contacts.is_empty() { bottom_contacts.push(contacts); }
                        if bottom_contacts.is_empty() && ctx.tcfg.support_rests_on_model && layer_begin > 0 && !slice_front_contact.is_empty() {
                            bottom_contacts.push(slice_front_contact.clone());
                        }
                    }
                    layer_begin -= bottom_extra.len() as i32;
                    let mut new_front: Vec<Polys> = bottom_extra.iter().rev().map(|x| x.0.clone()).collect();
                    new_front.append(&mut slices);
                    slices = new_front;
                }
                if has_root && ctx.tcfg.support_rests_on_model && front_state.layer_idx > 0 && ctx.tcfg.settings.support_floor_layers > 0
                    && ctx.tcfg.z_distance_bottom_layers > 0 && bottom_contacts.is_empty() && !slice_front_contact.is_empty() {
                    bottom_contacts.push(slice_front_contact.clone());
                }
            }
            // recover_pending_branch_roofs
            if ctx.g.p.has_top_contacts {
                for &(l, i) in path_ids.iter().rev() {
                    let el = &ctx.move_bounds[l][i];
                    if !el.state.has_pending_roof_recovery() { break; }
                    let slice_idx = el.state.layer_idx - layer_begin;
                    if slice_idx < 0 || slice_idx as usize >= slices.len() { continue; }
                    if slices[slice_idx as usize].is_empty() { continue; }
                    if el.state.roof_recovery_dtt as usize > ctx.g.p.num_top_interface { continue; }
                    let dtt = el.state.roof_recovery_dtt as usize;
                    let li = el.state.layer_idx as usize;
                    let sl = std::mem::take(&mut slices[slice_idx as usize]);
                    ctx.add_roof_unguarded(sl, li, dtt);
                }
            }
            while slices.last().map(|s| s.is_empty()).unwrap_or(false) { slices.pop(); }
            let layer_end = layer_begin + slices.len() as i32;
            if layer_begin < layer_end {
                let tree = &mut trees[ti];
                let new_begin = if tree.first_layer_id == -1 { layer_begin } else { tree.first_layer_id.min(layer_begin) };
                let new_end = if tree.first_layer_id == -1 { layer_end } else { (tree.first_layer_id + tree.slices.len() as i32).max(layer_end) };
                let new_size = (new_end - new_begin) as usize;
                if tree.first_layer_id != -1 {
                    let dif = tree.first_layer_id - new_begin;
                    if dif > 0 { let mut v = vec![Slice::default(); dif as usize]; v.append(&mut tree.slices); tree.slices = v; }
                }
                while tree.slices.len() < new_size { tree.slices.push(Slice::default()); }
                for i in layer_begin..layer_end {
                    let j = (i - layer_begin) as usize;
                    let src = std::mem::take(&mut slices[j]);
                    let has_bc = j < bottom_contacts.len() && !bottom_contacts[j].is_empty();
                    if !src.is_empty() || has_bc {
                        let dst = &mut tree.slices[(i - new_begin) as usize];
                        dst.num_branches += 1;
                        if dst.num_branches > 1 {
                            if !src.is_empty() { dst.polygons.extend(src); }
                            if has_bc { dst.bottom_contacts.extend(std::mem::take(&mut bottom_contacts[j])); }
                        } else {
                            if !src.is_empty() { dst.polygons = src; }
                            if has_bc { dst.bottom_contacts = std::mem::take(&mut bottom_contacts[j]); }
                        }
                    }
                }
                tree.first_layer_id = new_begin;
            }
        }
    }
    // union slices of each tree, then merge all trees
    for t in trees.iter_mut() {
        for s in t.slices.iter_mut() {
            if s.num_branches > 1 {
                if !s.polygons.is_empty() { s.polygons = poly::union(&s.polygons); }
                if !s.bottom_contacts.is_empty() { s.bottom_contacts = poly::union(&s.bottom_contacts); }
                s.num_branches = 1;
            }
        }
    }
    let mut num_layers = 0usize;
    for t in &trees { if t.first_layer_id >= 0 { num_layers = num_layers.max(t.first_layer_id as usize + t.slices.len()); } }
    let mut slices: Vec<Slice> = vec![Slice::default(); num_layers];
    for t in trees.iter_mut() {
        if t.first_layer_id >= 0 {
            for i in 0..t.slices.len() {
                let src = std::mem::take(&mut t.slices[i]);
                let idx = t.first_layer_id as usize + i;
                let has_bc = !src.bottom_contacts.is_empty();
                if !src.polygons.is_empty() || has_bc {
                    let dst = &mut slices[idx];
                    dst.num_branches += 1;
                    if dst.num_branches > 1 {
                        dst.polygons.extend(src.polygons);
                        dst.bottom_contacts.extend(src.bottom_contacts);
                    } else {
                        dst.polygons = src.polygons;
                        dst.bottom_contacts = src.bottom_contacts;
                    }
                }
            }
        }
    }
    let nl = ctx.move_bounds.len().min(slices.len());
    for layer_idx in 0..nl {
        let slice = std::mem::take(&mut slices[layer_idx]);
        let mut base: Polys = if slice.polygons.is_empty() { Vec::new() } else if slice.num_branches > 1 { poly::union(&slice.polygons) } else { slice.polygons };
        let mut bottom: Polys = if slice.bottom_contacts.is_empty() { Vec::new() } else if slice.num_branches > 1 { poly::union(&slice.bottom_contacts) } else { slice.bottom_contacts };
        if !base.is_empty() {
            base = poly::union(&base);
            // smooth_outward(base, support_line_width) is not ported (see approximations)
            base = poly::simplify(&base, (0.03f64).min(mm(cfg.resolution)));
        }
        if let Some(Some(tc)) = ctx.top_contacts.get(layer_idx).cloned().map(Some) {
            if let Some(tcid) = tc {
                let tp = ctx.g.store.v[tcid].polygons.clone();
                if !tp.is_empty() && !base.is_empty() {
                    base = poly::diff(&base, &tp);
                    if !bottom.is_empty() { bottom = poly::diff(&bottom, &tp); }
                }
            }
        }
        if !bottom.is_empty() {
            base = poly::diff(&base, &bottom);
            let id = ctx.g.store.alloc(LT::BottomContact);
            let pz = layer_z(ctx.g, &ctx.tcfg, layer_idx);
            let bz = if layer_idx > 0 { layer_z(ctx.g, &ctx.tcfg, layer_idx - 1) } else { 0.0 };
            let l = &mut ctx.g.store.v[id];
            l.print_z = pz; l.bottom_z = bz; l.height = pz - bz;
            l.polygons = bottom;
            ctx.bottom_contacts[layer_idx] = Some(id);
        }
        if !base.is_empty() {
            let id = ctx.g.store.alloc(LT::Base);
            let pz = layer_z(ctx.g, &ctx.tcfg, layer_idx);
            let bz = if layer_idx > 0 { layer_z(ctx.g, &ctx.tcfg, layer_idx - 1) } else { 0.0 };
            let l = &mut ctx.g.store.v[id];
            l.print_z = pz; l.bottom_z = bz; l.height = pz - bz;
            l.polygons = poly::union(&base);
            ctx.intermediate[layer_idx] = Some(id);
        }
    }
}

fn front_state_to_elem(s: &ElemState) -> ElemState { s.clone() }

#[allow(dead_code)]
fn _unused(_: Poly) {}
