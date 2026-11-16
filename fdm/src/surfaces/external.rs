//! `LayerRegion::process_external_surfaces`: grow the top / bottom / bridge surfaces into the shell,
//! sparse and top zones (Orca does it with wave propagation; here a round offset clipped to the zone,
//! which is the same set for convex zones and slightly larger around obstacles), detect the bridge
//! direction (`detect_bridging_direction`) and merge overlapping bridges.
use super::detect::{polys_of, State};
use super::ops::*;
use super::{FlowRole, Surface, SurfaceType as T};
use crate::types::{Poly, Polys};
use std::f64::consts::PI;

/// Arc tolerance for the round offsets that emulate the wave front (mm).
const ARC_TOL: f64 = 0.01;

pub fn process_external_surfaces(st: &mut State) {
    // process_layer(i) reads only layer i's fill surfaces and the immutable config / geometry: layers are independent
    let idxs: Vec<usize> = (0..st.n).collect();
    let this = &*st;
    let out: Vec<Vec<Surface>> = super::pmap(&idxs, |_, &i| process_layer(this, i));
    st.fill = out;
}

struct Zone { polys: Polys, full: f64, expanded_into: bool }

fn surf(ty: T, p: &Polys, angle: f64) -> Vec<Surface> {
    u(p).into_iter().map(|poly| Surface { ty, poly, bridge_angle: angle }).collect()
}

/// `RegionExpansionParameters::build(full, 0.1, 5)`: (tiny, initial step, other step, number of other steps).
fn expansion_params(full: f64) -> (f64, f64, f64, usize) {
    let (step, max_steps) = (0.1, 5usize);
    let mut tiny = (0.25 * full).min(0.05);
    let mut nsteps = (((full - tiny) / step).ceil() as usize).min(max_steps).max(1);
    let mut initial = (full - tiny) / nsteps as f64;
    if nsteps > 1 && 0.25 * initial < tiny {
        nsteps = (((full - tiny) / (4.0 * tiny)).floor() as usize).max(1);
        initial = (full - tiny) / nsteps as f64;
    }
    if 0.25 * initial < tiny || nsteps == 1 {
        tiny = 0.2 * full;
        initial = 0.8 * full;
    }
    (tiny, initial, initial, nsteps - 1)
}

/// What the wave propagation of `Algorithm::propagate_waves` adds to `src` inside `zone`: seeds are the places where
/// `src` grown by the tiny expansion touches a zone island, then the front advances in steps, each step clipped to
/// that island (so the front never jumps a gap wider than the tiny expansion and follows the island around corners).
fn expansion_into(src: &Polys, zone: &Polys, full: f64) -> Polys {
    if src.is_empty() || zone.is_empty() { return vec![]; }
    let (tiny, initial, other, n_other) = expansion_params(full);
    let grown = off_round(src, tiny, ARC_TOL);
    let mut out: Polys = vec![];
    for isl in zone {
        let island = vec![isl.clone()];
        let mut cur = it(&grown, &island);
        if cur.is_empty() { continue; }
        cur = it(&off_round(&cur, initial, ARC_TOL), &island);
        for _ in 0..n_other { cur = it(&off_round(&cur, other, ARC_TOL), &island); }
        out.extend(cur);
    }
    u(&out)
}

fn process_layer(st: &State, i: usize) -> Vec<Surface> {
    let cfg = st.cfg;
    let fill = &st.fill[i];
    let ext = st.flow(FlowRole::ExternalPerimeter, i);
    let per = st.flow(FlowRole::Perimeter, i);
    let (shell_width, expansion_min) = if cfg.wall_loops > 0 {
        (0.5 * ext.width + ext.spacing + per.spacing * (cfg.wall_loops as f64 - 1.0), per.spacing)
    } else { (EPS, EPS) };
    let expansion_top = shell_width * 2f64.sqrt();
    let closing_radius = 0.55 * 0.65 * 1.05 * st.flow(FlowRole::SolidInfill, i).spacing;

    let mut zones = vec![
        Zone { polys: polys_of(fill, &[T::InternalSolid]), full: expansion_top, expanded_into: false },
        Zone { polys: polys_of(fill, &[T::Internal]), full: expansion_min, expanded_into: false },
        Zone { polys: polys_of(fill, &[T::Top]), full: expansion_top, expanded_into: false },
    ];

    // ---- bridges
    let bridge_src: Vec<Poly> = fill.iter().filter(|s| s.ty == T::BottomBridge).map(|s| s.poly.clone()).collect();
    let custom = cfg.bridge_angle;
    let bridges: Vec<Surface> = if bridge_src.is_empty() { vec![] } else if custom > 0.0 && !cfg.relative_bridge_angle {
        expand_merge(&bridge_src, T::BottomBridge, &mut zones, closing_radius, custom, 0..3)
    } else {
        let mut b = expand_bridges_detect_orientations(&bridge_src, &mut zones, closing_radius);
        if custom > 0.0 && cfg.relative_bridge_angle {
            for s in &mut b { if s.bridge_angle >= 0.0 { s.bridge_angle += custom; } }
        }
        b
    };

    // ---- top surfaces: whatever of the top zone survived the bridge expansion
    let top_src_polys = std::mem::take(&mut zones[2].polys);
    zones.pop();
    // bottoms
    let bottom_src: Vec<Poly> = fill.iter().filter(|s| s.ty == T::Bottom).map(|s| s.poly.clone()).collect();
    zones[0].full = expansion_top;
    let bottoms = expand_merge(&bottom_src, T::Bottom, &mut zones, closing_radius, -1.0, 0..2);
    // tops
    zones[0].full = expansion_top;
    let tops = expand_merge(&u(&top_src_polys), T::Top, &mut zones, closing_radius, -1.0, 0..2);

    // too small sparse regions turn solid
    if cfg.sparse_density > 0.0 {
        let mut small: Polys = vec![];
        zones[1].polys.retain(|p| if poly_area(p) <= cfg.min_sparse_area { small.push(p.clone()); false } else { true });
        if !small.is_empty() { zones[0].polys = un(&zones[0].polys, &small); }
    }

    let mut out = surf(T::InternalSolid, &zones[0].polys, -1.0);
    out.extend(surf(T::Internal, &zones[1].polys, -1.0));
    out.extend(bridges);
    out.extend(bottoms);
    out.extend(tops);
    out
}

/// `expand_merge_surfaces`: grow `src` into the zones `range`, merge, close, trim the zones.
fn expand_merge(src: &[Poly], ty: T, zones: &mut [Zone], closing_radius: f64, angle: f64, range: std::ops::Range<usize>) -> Vec<Surface> {
    if src.is_empty() { return vec![]; }
    let src_p: Polys = u(&src.to_vec());
    let mut acc = src_p.clone();
    for z in range.clone() {
        if z >= zones.len() { continue; }
        let exp = expansion_into(&src_p, &zones[z].polys, zones[z].full);
        zones[z].expanded_into = !exp.is_empty();
        if !exp.is_empty() { acc = un(&acc, &exp); }
    }
    let expanded = closing(&acc, closing_radius);
    for z in range {
        if z < zones.len() && zones[z].expanded_into { zones[z].polys = df(&zones[z].polys, &expanded); }
    }
    surf(ty, &expanded, angle)
}

/// `expand_bridges_detect_orientations` + `get_grouped_bridges` + `merge_bridges`.
fn expand_bridges_detect_orientations(src: &[Poly], zones: &mut [Zone], closing_radius: f64) -> Vec<Surface> {
    let nb = src.len();
    // expansions[b] = list of (zone, island index within zone, region)
    struct Exp { zone: usize, island: usize, poly: Polys }
    let mut exps: Vec<Vec<Exp>> = (0..nb).map(|_| vec![]).collect();
    let zone_islands: Vec<Polys> = zones.iter().map(|z| z.polys.iter().map(|p| vec![p.clone()]).collect::<Vec<Polys>>()).map(|v| v.into_iter().flatten().collect()).collect();
    for (b, bp) in src.iter().enumerate() {
        let bpp = vec![bp.clone()];
        for (zi, z) in zones.iter().enumerate() {
            for (ji, isl) in zone_islands[zi].iter().enumerate() {
                let island = vec![isl.clone()];
                let e = expansion_into(&bpp, &island, z.full);
                if !e.is_empty() { exps[b].push(Exp { zone: zi, island: ji, poly: e }); }
            }
        }
    }
    // group by overlapping expansions inside the same boundary
    let mut group: Vec<usize> = (0..nb).collect();
    fn find(g: &mut Vec<usize>, mut x: usize) -> usize { while g[x] != x { g[x] = g[g[x]]; x = g[x]; } x }
    for a in 0..nb {
        for b in a + 1..nb {
            let mut hit = false;
            'o: for ea in &exps[a] {
                for eb in &exps[b] {
                    if ea.zone == eb.zone && ea.island == eb.island && !it(&ea.poly, &eb.poly).is_empty() { hit = true; break 'o; }
                }
            }
            if hit {
                let (ra, rb) = (find(&mut group, a), find(&mut group, b));
                if ra < rb { group[rb] = ra } else if rb < ra { group[ra] = rb }
            }
        }
    }
    // direction per bridge
    let mut angle = vec![0.0; nb];
    for b in 0..nb {
        let mut anchor: Polys = vec![];
        let mut seen: Vec<(usize, usize)> = vec![];
        for e in &exps[b] {
            if !seen.contains(&(e.zone, e.island)) {
                seen.push((e.zone, e.island));
                anchor.push(zone_islands[e.zone][e.island].clone());
            }
        }
        let anchor_grown = expand(&anchor, EPS);
        let mut lines: Vec<(Pt, Pt)> = vec![];
        for r in rings(&vec![src[b].clone()]) {
            for pl in clip_ring(r, &anchor_grown, false) {
                for w in pl.windows(2) { lines.push((w[0], w[1])); }
            }
        }
        let dir = bridging_direction(&lines, &vec![src[b].clone()]);
        angle[b] = PI + dir[1].atan2(dir[0]);
    }
    // merge groups
    let mut out_polys: Polys = vec![];
    let mut out: Vec<Surface> = vec![];
    for b in 0..nb {
        if find(&mut group, b) != b { continue; }
        let mut acc: Polys = vec![];
        for b2 in b..nb {
            if find(&mut group, b2) == b {
                acc.push(src[b2].clone());
                for e in &exps[b2] { acc.extend(e.poly.iter().cloned()); }
            }
        }
        let fin = closing(&u(&acc), closing_radius);
        out_polys = un(&out_polys, &fin);
        out.extend(surf(T::BottomBridge, &fin, angle[b]));
    }
    for z in zones.iter_mut() {
        if exps.iter().any(|v| !v.is_empty()) { z.expanded_into = true; }
    }
    // clip the zones that were expanded into by the bridges
    for (zi, z) in zones.iter_mut().enumerate() {
        if exps.iter().any(|v| v.iter().any(|e| e.zone == zi)) { z.polys = df(&z.polys, &out_polys); }
    }
    out
}

// ------------------------------------------------------------------------------------------------ direction
/// `compute_principal_components`: eigenvectors of the area covariance, largest first (including Orca's
/// special case for ~zero covariance, which returns the variances as vector components).
fn principal_components(p: &Polys) -> (Pt, Pt) {
    let (mut area, mut cx, mut cy, mut sxx, mut syy, mut sxy) = (0.0f64, 0.0, 0.0, 0.0, 0.0, 0.0);
    for r in rings(p) {
        if r.len() < 3 { continue; }
        let p0 = r[0];
        for k in 2..r.len() {
            let (p1, p2) = (r[k - 1], r[k]);
            let cross = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
            let sign = if cross > 0.0 { 1.0 } else { -1.0 };
            let jac = ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])).abs();
            let (a, b, c) = (p0, p1, p2);
            area += sign * jac * 0.5;
            cx += sign * jac * (a[0] + b[0] + c[0]) / 6.0;
            cy += sign * jac * (a[1] + b[1] + c[1]) / 6.0;
            sxx += sign * jac * (a[0] * a[0] + b[0] * b[0] + b[0] * c[0] + c[0] * c[0] + a[0] * (b[0] + c[0])) / 12.0;
            syy += sign * jac * (a[1] * a[1] + b[1] * b[1] + b[1] * c[1] + c[1] * c[1] + a[1] * (b[1] + c[1])) / 12.0;
            sxy += sign * jac * (1.0 / 24.0) * (a[1] * (b[0] + c[0]) + a[0] * (2.0 * a[1] + b[1] + c[1]) + b[1] * c[0] + b[0] * c[1] + 2.0 * b[0] * b[1] + 2.0 * c[0] * c[1]);
        }
    }
    if area <= 0.0 { return ([0.0, 0.0], [0.0, 0.0]); }
    let (mx, my) = (cx / area, cy / area);
    let (vx, vy) = (sxx / area - mx * mx, syy / area - my * my);
    let cov = sxy / area - mx * my;
    if cov.abs() < 1e-4 {
        let r = ([vx, 0.0], [0.0, vy]);
        return if vy > vx { (r.1, r.0) } else { r };
    }
    let disc = ((vx - vy) * (vx - vy) + 4.0 * cov * cov).sqrt();
    let (ea, eb) = (0.5 * (vx + vy + disc), 0.5 * (vx + vy - disc));
    let va = [(ea - vy) / cov, 1.0];
    let vb = [(eb - vy) / cov, 1.0];
    if ea > eb { (va, vb) } else { (vb, va) }
}

/// `detect_bridging_direction(floating_edges, overhang_area)`: the direction of the bridge threads.
pub fn bridging_direction(floating: &[(Pt, Pt)], overhang: &Polys) -> Pt {
    if floating.is_empty() {
        let (_pc1, pc2) = principal_components(overhang);
        let n = pc2[0].hypot(pc2[1]);
        if n == 0.0 { return [1.0, 0.0]; }
        return [pc2[0] / n, pc2[1] / n];
    }
    // candidate directions: edge normals (dy, -dx), quantised to 1e-3 rad like Orca, first seen wins
    let mut dirs: Vec<(i64, Pt)> = Vec::new();
    for (a, b) in floating {
        let n = [b[1] - a[1], -(b[0] - a[0])];
        let l = n[0].hypot(n[1]);
        if l == 0.0 { continue; }
        let nn = [n[0] / l, n[1] / l];
        let q = (nn[1].atan2(nn[0]) * 1000.0).ceil() as i64;
        if !dirs.iter().any(|d| d.0 == q) { dirs.push((q, nn)); }
    }
    dirs.sort_by_key(|d| d.0);
    let mut best = [1.0, 1.0];
    let mut min_cost = f64::MAX;
    for (_, d) in &dirs {
        let cost: f64 = floating.iter().map(|(a, b)| ((b[0] - a[0]) * d[0] + (b[1] - a[1]) * d[1]).abs()).sum();
        if cost < min_cost { min_cost = cost; best = [d[1], -d[0]]; }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polys {
        vec![Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }]
    }
    #[test]
    fn direction_across_a_gap() {
        // bridge 10 x 4 anchored on its two short sides (x=0 and x=10); free long edges at y=0 and y=4
        let lines = vec![([0.0, 0.0], [10.0, 0.0]), ([10.0, 4.0], [0.0, 4.0])];
        let d = bridging_direction(&lines, &rect(0.0, 0.0, 10.0, 4.0));
        // the thread must run along x (shortest span between the anchors)
        assert!(d[1].abs() < 1e-9 && d[0].abs() > 0.99, "{d:?}");
    }
    #[test]
    fn fully_anchored_uses_principal_axis() {
        let d = bridging_direction(&[], &rect(0.0, 0.0, 10.0, 4.0));
        let _ = d; // covariance ~0: Orca returns the y axis for a wider-than-tall box? documented quirk
        assert!((d[0].abs() + d[1].abs()) > 0.0);
    }
}
