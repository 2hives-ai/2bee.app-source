//! `TreeSupport::detect_overhangs` (Support/TreeSupport.cpp): overhang detection used by the organic tree
//! supports (sharp tails, cantilevers, small-overhang clusters, enforcers/blockers).
use crate::supports::config::*;
use crate::supports::poly;
use crate::types::{Poly, Polys};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OverhangType { Detected, Enforced, SharpTail }

fn p1(p: &Poly) -> Polys { vec![p.clone()] }
fn bbox_size(p: &Polys) -> [f64; 2] { match poly::bbox(p) { Some((a, b)) => [b[0] - a[0], b[1] - a[1]], None => [0.0, 0.0] } }

struct Cluster {
    overhangs: Vec<(usize, usize)>, // (layer, index into overhangs_all[layer])
    last_by_layer: std::collections::BTreeMap<usize, usize>,
    merged: Polys,
    bbox: Option<([f64; 2], [f64; 2])>,
    min_layer: usize,
    max_layer: usize,
    is_cantilever: bool,
}
fn bbox_overlap(a: &Option<([f64; 2], [f64; 2])>, b: &Option<([f64; 2], [f64; 2])>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => !(x.1[0] < y.0[0] || y.1[0] < x.0[0] || x.1[1] < y.0[1] || y.1[1] < x.0[1]),
        _ => false,
    }
}
fn bbox_merge(a: Option<([f64; 2], [f64; 2])>, b: Option<([f64; 2], [f64; 2])>) -> Option<([f64; 2], [f64; 2])> {
    match (a, b) {
        (None, x) | (x, None) => x,
        (Some(x), Some(y)) => Some(([x.0[0].min(y.0[0]), x.0[1].min(y.0[1])], [x.1[0].max(y.1[0]), x.1[1].max(y.1[1])])),
    }
}

/// Returns, per object layer, the overhang polygons (sharp tail ones already grown by 0.2 mm).
pub fn detect_overhangs(cfg: &SupportConfig, slices: &[Polys], heights: &[f64], enforcers: &[Polys], blockers: &[Polys]) -> Vec<Polys> {
    let n = slices.len();
    let ew = cfg.line_width; // config.get_abs_value("line_width", nozzle)
    let ew_scaled = ew * 1e6;
    let _ = ew_scaled;
    let auto = cfg.support_type.is_auto();
    let enforce_layers = cfg.enforce_support_layers.max(0) as usize;
    let mut thresh_angle = if cfg.support_threshold_angle > 1e-4 { cfg.support_threshold_angle + 1.0 } else { 30.0 };
    thresh_angle = thresh_angle.min(89.0);
    let threshold_rad = thresh_angle.to_radians();
    let enforcer_overhang_offset = 0.8; // scaled(0.8) fudge constant
    let config_remove_small = cfg.support_remove_small_overhang;
    let detect_sharp = true; // g_config_support_sharp_tails
    const LENGTH_THRESH: f64 = 6.0;
    const SHARP_TAIL_MAX_HEIGHT: f64 = 16.0;

    // lslices_extrudable
    let mut extrudable: Vec<Polys> = Vec::with_capacity(n);
    for i in 0..n {
        let opened = poly::offset2(&slices[i], -ew / 2.0, ew);
        extrudable.push(poly::intersect(&slices[i], &opened));
    }
    let mut sharp_tails: Vec<Polys> = vec![Vec::new(); n];
    let mut sharp_h: Vec<Vec<f64>> = vec![Vec::new(); n];
    let mut cantilevers: Vec<Polys> = vec![Vec::new(); n];
    let mut overhangs_all: Vec<Polys> = vec![Vec::new(); n];

    for nr in 0..n {
        if !auto && nr > enforce_layers { continue; }
        if nr == 0 {
            for slice in &extrudable[0] {
                let sz = bbox_size(&p1(slice));
                if !(sz[0] > LENGTH_THRESH && sz[1] > LENGTH_THRESH) && detect_sharp {
                    sharp_tails[0].push(slice.clone());
                    sharp_h[0].push(heights[0]);
                }
            }
            continue;
        }
        let lower_height = heights[nr - 1];
        let lower_layer_offset = if nr < enforce_layers { -0.15 * ew } else { lower_height / threshold_rad.tan() };
        let curr = &extrudable[nr];
        let lower = &extrudable[nr - 1];
        let lower_offseted = poly::offset_sq(lower, lower_layer_offset);
        overhangs_all[nr] = poly::diff(curr, &lower_offseted);
        if auto && detect_sharp {
            for expoly in curr {
                let e = p1(expoly);
                let mut is_sharp = false;
                if !poly::overlaps(&poly::offset(&e, 0.1 * ew), lower) {
                    is_sharp = !poly::offset(&e, -0.1 * ew).is_empty();
                }
                if is_sharp { sharp_tails[nr].push(expoly.clone()); sharp_h[nr].push(0.0); }
            }
        }
        // cantilever
        let grown = poly::offset(&lower_offseted, (ew - lower_layer_offset).max(0.0) + 0.1);
        for ex in &overhangs_all[nr] {
            let boundary = poly::intersect(&p1(ex), &grown);
            if boundary.is_empty() { continue; }
            let mut dist_max = 0.0f64;
            for pt in &ex.contour { dist_max = dist_max.max(poly::dist_to_boundary(&boundary, *pt)); }
            if dist_max > 3.0 { cantilevers[nr].push(ex.clone()); }
        }
    }

    // extend sharp tails upwards
    if auto && detect_sharp {
        for nr in 0..n {
            if nr == 0 { continue; }
            let lower_tails = sharp_tails[nr - 1].clone();
            let lower_tails_h = sharp_h[nr - 1].clone();
            let height = heights[nr];
            let curr = extrudable[nr].clone();
            for expoly in &curr {
                let e = p1(expoly);
                let mut is_sharp = false;
                let mut accum = height;
                'once: loop {
                    let supported = poly::intersect(&e, &lower_tails);
                    if supported.is_empty() { break 'once; }
                    let sz = bbox_size(&supported);
                    if sz[0] > LENGTH_THRESH && sz[1] > LENGTH_THRESH { break 'once; }
                    for (i, t) in lower_tails.iter().enumerate() {
                        if poly::overlaps(&p1(t), &e) { accum += lower_tails_h[i]; break; }
                    }
                    if accum > SHARP_TAIL_MAX_HEIGHT { break 'once; }
                    let new_overhang = poly::diff(&e, &lower_tails);
                    let s_new = bbox_size(&new_overhang);
                    let s_low = bbox_size(&lower_tails);
                    if (s_new[0] - s_low[0] > 5.0 && s_new[1] - s_low[1] > 5.0) || !poly::offset(&new_overhang, -5.0 * ew).is_empty() { break 'once; }
                    is_sharp = true;
                    break 'once;
                }
                if is_sharp { sharp_tails[nr].push(expoly.clone()); sharp_h[nr].push(accum); }
            }
        }
    }

    // cluster overhangs
    let mut clusters: Vec<Cluster> = Vec::new();
    for nr in 0..n {
        for oi in 0..overhangs_all[nr].len() {
            let region = overhangs_all[nr][oi].clone();
            let mut found: Option<usize> = None;
            let mut dil: Polys = Vec::new();
            let mut bb = None;
            for (ci, c) in clusters.iter().enumerate() {
                // push_back_if_intersects
                if nr < 1 { break; }
                let Some(&prev) = c.last_by_layer.get(&(nr - 1)) else { continue };
                let overhang_prev = p1(&overhangs_all[nr - 1][prev]);
                let d = poly::offset(&p1(&region), ew);
                if d.is_empty() { continue; }
                let b = poly::bbox(&d);
                if !bbox_overlap(&c.bbox, &b) { continue; }
                if poly::overlaps(&overhang_prev, &d) { found = Some(ci); dil = d; bb = b; break; }
            }
            let ci = match found {
                Some(ci) => {
                    let c = &mut clusters[ci];
                    // std::map::emplace keeps the first overhang of a layer
                    if !c.last_by_layer.contains_key(&nr) { c.overhangs.push((nr, oi)); c.last_by_layer.insert(nr, oi); }
                    c.merged = poly::union2(&c.merged, &dil);
                    c.min_layer = c.min_layer.min(nr);
                    c.max_layer = c.max_layer.max(nr);
                    c.bbox = bbox_merge(c.bbox, bb);
                    ci
                }
                None => {
                    // the constructor dilates by the (still zero) member `offset`: the first overhang is not grown
                    let d = poly::union(&p1(&region));
                    let b = poly::bbox(&d);
                    let mut c = Cluster { overhangs: vec![(nr, oi)], last_by_layer: Default::default(), merged: d.clone(), bbox: b, min_layer: nr, max_layer: nr, is_cantilever: false };
                    c.last_by_layer.insert(nr, oi);
                    clusters.push(c);
                    clusters.len() - 1
                }
            };
            if poly::overlaps(&p1(&region), &cantilevers[nr]) { clusters[ci].is_cantilever = true; }
        }
    }
    let mut small = vec![false; clusters.len()];
    if auto && config_remove_small {
        for (ci, c) in clusters.iter().enumerate() {
            let mut is_sharp_tail = false;
            for layer in c.min_layer..=c.max_layer {
                if poly::overlaps(&sharp_tails[layer], &c.merged) { is_sharp_tail = true; break; }
            }
            if !is_sharp_tail && !c.is_cantilever {
                let erode = poly::offset(&c.merged, -1.0 * ew);
                let sz = bbox_size(&erode);
                if sz[0] < 2.0 * ew || sz[1] < 2.0 * ew { small[ci] = true; }
            }
        }
    }
    let mut loverhangs: Vec<Vec<(Poly, OverhangType)>> = vec![Vec::new(); n];
    for (ci, c) in clusters.iter().enumerate() {
        if small[ci] { continue; }
        for &(nr, oi) in &c.overhangs { loverhangs[nr].push((overhangs_all[nr][oi].clone(), OverhangType::Detected)); }
    }
    // order inside a layer follows the std::map iteration (by layer) per cluster; a union later makes order irrelevant

    let mut out: Vec<Polys> = vec![Vec::new(); n];
    for nr in 0..n {
        let lower_extr = if nr > 0 { Some(&extrudable[nr - 1]) } else { None };
        // sharp tails: every 0.5 mm of accumulated height
        let mut sharp_tail_overhangs: Polys = Vec::new();
        if nr == 0 {
            sharp_tail_overhangs = sharp_tails[0].clone();
        } else {
            let lower_expanded = poly::offset(lower_extr.unwrap(), 0.012);
            for (i, t) in sharp_tails[nr].iter().enumerate() {
                let areas = poly::diff(&p1(t), &lower_expanded);
                let accum = sharp_h[nr][i];
                if !areas.is_empty() && (((accum * 10.0) as i64) % 5 == 0) { sharp_tail_overhangs.extend(areas); }
            }
        }
        let mut loh: Vec<(Poly, OverhangType)> = std::mem::take(&mut loverhangs[nr]);
        if nr < blockers.len() && !blockers[nr].is_empty() {
            let blocker = poly::offset(&poly::union(&blockers[nr]), 0.2); // radius_sample_resolution
            let only: Polys = loh.iter().map(|x| x.0.clone()).collect();
            let kept = poly::diff(&only, &blocker);
            loh = kept.into_iter().map(|p| (p, OverhangType::Detected)).collect();
            sharp_tail_overhangs = poly::diff(&sharp_tail_overhangs, &blocker);
        }
        if cfg.support_critical_regions_only && auto {
            loh = cantilevers[nr].iter().map(|p| (p.clone(), OverhangType::Detected)).collect();
        }
        if nr < enforcers.len() && nr > 0 && !enforcers[nr].is_empty() {
            let enforced = poly::intersect(&poly::diff(&extrudable[nr], lower_extr.unwrap()), &enforcers[nr]);
            if !enforced.is_empty() {
                let e2 = poly::diff(&poly::offset(&enforced, enforcer_overhang_offset), lower_extr.unwrap());
                for p in e2 { loh.push((p, OverhangType::Enforced)); }
            }
        }
        let mut polys: Polys = Vec::new();
        for (p, _) in &loh { polys.push(p.clone()); }
        // sharp tail overhangs are grown by 0.2 mm
        for t in sharp_tail_overhangs { polys.extend(poly::offset(&p1(&t), 0.2)); }
        out[nr] = polys;
    }
    out
}
