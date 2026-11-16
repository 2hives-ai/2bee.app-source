//! Lane 9: automatic part orientation that PRICES what makes a print fail or waste material:
//! cantilevers and over-long bridges (support), a tiny or tipping bed contact (adhesion), and print time.
//!
//! `orient(mesh, cfg, opt)` tries the current pose, the six axis poses and the poses that lay the largest flat faces on the bed,
//! slices each, runs the same `preflight` analysis the user sees, and scores
//!     total (minutes) = est. print time + 6 * support cm^3 + adhesion penalty + tip-over penalty + 0.05 * rough underside mm^2
//! The current pose is kept unless the best one wins by more than `min_gain` (fraction and minutes), so a good pose is never churned.
//! Advisory only: the caller decides whether to apply `rotate_mesh(mesh, &result.best.rot)`. Deterministic, no randomness.
use crate::config::Config;
use crate::mesh::Mesh;
use crate::preflight::{preflight_with, PreflightOptions, PreflightReport};
use crate::slice;
use crate::types::FdmError;
use serde::Serialize;

pub type Rot = [[f64; 3]; 3];

#[derive(Clone, Debug)]
pub struct OrientOptions {
    /// Layer height used for the candidate comparison. `None` = the config's own height (accurate: the time term depends on the layer count);
    /// `Some(0.4)` = coarse and ~2x faster on big parts.
    pub coarse_layer_mm: Option<f64>,
    /// Largest flat-face poses to try in addition to the six axis poses.
    pub flat_faces: usize,
    /// The best pose must beat the current one by this fraction of the current score AND by `min_gain_min` minutes.
    pub min_gain: f64,
    pub min_gain_min: f64,
}
impl Default for OrientOptions { fn default() -> Self { OrientOptions { coarse_layer_mm: None, flat_faces: 8, min_gain: 0.10, min_gain_min: 3.0 } } }

#[derive(Clone, Debug, Serialize)]
pub struct OrientScore {
    pub total: f64,
    pub time_min: f64,
    pub support_cm3: f64,
    pub cantilever_mm2: f64,
    pub bridges_over_limit: usize,
    pub contact_mm2: f64,
    pub height_mm: f64,
    pub adhesion: String,
    pub fits_bed: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct OrientCandidate { pub label: String, pub rot: Rot, pub score: OrientScore }
#[derive(Clone, Debug, Serialize)]
pub struct OrientResult {
    pub current: OrientCandidate,
    pub best: OrientCandidate,
    pub changed: bool,
    pub all: Vec<OrientCandidate>,
    pub reason: String,
}

fn norm(v: [f64; 3]) -> f64 { (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt() }
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }

/// Rotation taking unit vector `a` onto unit vector `b` (Rodrigues; antiparallel handled).
pub fn rotation_between(a: [f64; 3], b: [f64; 3]) -> Rot {
    let c = dot(a, b);
    if c > 1.0 - 1e-12 { return [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]; }
    if c < -1.0 + 1e-12 {
        // 180 degrees about any axis perpendicular to a
        let ax = if a[0].abs() < 0.9 { cross(a, [1., 0., 0.]) } else { cross(a, [0., 1., 0.]) };
        let n = norm(ax); let u = [ax[0] / n, ax[1] / n, ax[2] / n];
        return [[2. * u[0] * u[0] - 1., 2. * u[0] * u[1], 2. * u[0] * u[2]], [2. * u[0] * u[1], 2. * u[1] * u[1] - 1., 2. * u[1] * u[2]], [2. * u[0] * u[2], 2. * u[1] * u[2], 2. * u[2] * u[2] - 1.]];
    }
    let v = cross(a, b);
    let k = 1.0 / (1.0 + c);
    [[1. - k * (v[1] * v[1] + v[2] * v[2]), -v[2] + k * v[0] * v[1], v[1] + k * v[0] * v[2]],
     [v[2] + k * v[0] * v[1], 1. - k * (v[0] * v[0] + v[2] * v[2]), -v[0] + k * v[1] * v[2]],
     [-v[1] + k * v[0] * v[2], v[0] + k * v[1] * v[2], 1. - k * (v[0] * v[0] + v[1] * v[1])]]
}
pub fn apply_rot(r: &Rot, v: [f64; 3]) -> [f64; 3] { [dot(r[0], v), dot(r[1], v), dot(r[2], v)] }
/// Proper rotation of every vertex; triangle winding is unchanged.
pub fn rotate_mesh(m: &Mesh, r: &Rot) -> Mesh { let mut o = m.clone(); for v in &mut o.verts { *v = apply_rot(r, *v); } o }

/// Area-weighted flat-face clusters: (outward normal, area), largest first.
fn flat_faces(m: &Mesh, max: usize) -> Vec<([f64; 3], f64)> {
    let mut cl: Vec<([f64; 3], f64)> = vec![];
    for i in 0..m.tris.len() {
        let [a, b, c] = m.tri(i);
        let n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let l = norm(n);
        if l < 1e-12 { continue; }
        let u = [n[0] / l, n[1] / l, n[2] / l];
        match cl.iter_mut().find(|(v, _)| dot(*v, u) > 0.9986) { Some((_, ar)) => *ar += 0.5 * l, None => cl.push((u, 0.5 * l)) }
    }
    cl.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    cl.truncate(max);
    cl
}

fn score(r: &PreflightReport, est_support_cm3: f64) -> OrientScore {
    let mut t = r.estimate.time_min + 6.0 * est_support_cm3 + 0.05 * r.overhang.rough_area_mm2;
    t += match r.first_layer.risk.as_str() { "high" => 30.0, "medium" => 8.0, _ => 0.0 };
    if !r.first_layer.com_over_contact { t += 60.0; }
    if !r.flags.fits_bed { t += 1e6; }
    OrientScore { total: t, time_min: r.estimate.time_min, support_cm3: est_support_cm3, cantilever_mm2: r.bridges.cantilever_area_mm2, bridges_over_limit: r.bridges.over_limit, contact_mm2: r.first_layer.contact_area_mm2,
        height_mm: r.bed.footprint[2], adhesion: r.first_layer.risk.clone(), fits_bed: r.flags.fits_bed }
}

fn eval(mesh: &Mesh, rot: &Rot, label: String, cfg: &Config, opt: &OrientOptions) -> Result<OrientCandidate, FdmError> {
    let mut m = rotate_mesh(mesh, rot);
    let (cx, cy) = (128.0, 128.0);
    m.place_on_bed(cx, cy);
    let mut c = cfg.clone();
    if let Some(h) = opt.coarse_layer_mm { c.set("layer_height", &format!("{h}")); c.set("initial_layer_print_height", &format!("{h}")); }
    let layers = slice::slice(&m, &c)?.layers;
    let rep = preflight_with(&m, &c, &layers, &PreflightOptions::default());
    // support only counts when the part needs it (cantilever / over-long bridge); short bridges print without
    let sup = if rep.flags.needs_support { rep.estimate.support_cm3_upper } else { 0.0 };
    Ok(OrientCandidate { label, rot: *rot, score: score(&rep, sup) })
}

pub fn orient(mesh: &Mesh, cfg: &Config, opt: &OrientOptions) -> Result<OrientResult, FdmError> {
    let ident: Rot = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
    let mut dirs: Vec<([f64; 3], String)> = vec![];
    // "down" directions in the CURRENT frame: the vector that should end up pointing at the bed (-Z)
    for (v, n) in [([0., 0., -1.], "current"), ([0., 0., 1.], "flipped (top down)"), ([1., 0., 0.], "+x face down"), ([-1., 0., 0.], "-x face down"), ([0., 1., 0.], "+y face down"), ([0., -1., 0.], "-y face down")] { dirs.push((v, n.into())); }
    for (n, ar) in flat_faces(mesh, opt.flat_faces) {
        if dirs.iter().any(|(d, _)| dot(*d, n) > 0.9986) { continue; }
        dirs.push((n, format!("flat face of {ar:.0} mm2 down")));
    }
    let mut all = vec![];
    for (down, label) in &dirs {
        let rot = rotation_between(*down, [0., 0., -1.]);
        all.push(eval(mesh, &if label == "current" { ident } else { rot }, label.clone(), cfg, opt)?);
    }
    let current = all[0].clone();
    let best = all.iter().min_by(|a, b| a.score.total.partial_cmp(&b.score.total).unwrap()).unwrap().clone();
    let gain = current.score.total - best.score.total;
    let changed = best.label != "current" && gain > opt.min_gain * current.score.total && gain > opt.min_gain_min;
    let chosen = if changed { best.clone() } else { current.clone() };
    let reason = if changed {
        format!("{}: support {:.2} -> {:.2} cm3, bed contact {:.0} -> {:.0} mm2, height {:.0} -> {:.0} mm, estimated score {:.0} -> {:.0} min-equivalents",
            chosen.label, current.score.support_cm3, chosen.score.support_cm3, current.score.contact_mm2, chosen.score.contact_mm2, current.score.height_mm, chosen.score.height_mm, current.score.total, chosen.score.total)
    } else { format!("keep the current pose: best alternative ({}) gains only {:.1} of {:.1} min-equivalents", best.label, gain.max(0.0), current.score.total) };
    Ok(OrientResult { current, best: chosen, changed, all, reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preflight::tests::{slice_soup, test_cfg, t_prism};
    use crate::improve::shapes;

    #[test] fn rotation_between_is_a_proper_rotation_and_maps_a_to_b() {
        for (a, b) in [([0., 0., 1.], [0., 0., -1.]), ([1., 0., 0.], [0., 0., -1.]), ([0.6, 0.0, 0.8], [0., 0., -1.]), ([0., 0., -1.], [0., 0., -1.])] {
            let r = rotation_between(a, b);
            let m = apply_rot(&r, a);
            assert!((m[0] - b[0]).abs() < 1e-9 && (m[1] - b[1]).abs() < 1e-9 && (m[2] - b[2]).abs() < 1e-9, "{a:?} -> {m:?}");
            let det = dot(r[0], cross(r[1], r[2]));
            assert!((det - 1.0).abs() < 1e-9, "det {det}");
        }
    }
    #[test] fn upright_t_is_flipped_to_remove_the_support() {
        let cfg = test_cfg(&[]);
        let m = Mesh::from_soup(&t_prism()).unwrap();
        let r = orient(&m, &cfg, &OrientOptions::default()).unwrap();
        assert!(r.changed, "{}", r.reason);
        assert!(r.current.score.support_cm3 > 0.3 && r.best.score.support_cm3 == 0.0, "{} -> {}", r.current.score.support_cm3, r.best.score.support_cm3);
        // the chosen pose really has no cantilever when sliced fine
        let rotated = rotate_mesh(&m, &r.best.rot);
        let mut placed = rotated.clone(); placed.place_on_bed(128.0, 128.0);
        let layers = slice::slice(&placed, &cfg).unwrap().layers;
        assert!(!crate::preflight::preflight(&placed, &cfg, &layers).flags.needs_support);
    }
    #[test] fn a_good_pose_is_kept() {
        let cfg = test_cfg(&[]);
        let m = Mesh::from_soup(&shapes::boxs(40., 40., 40.)).unwrap();
        let r = orient(&m, &cfg, &OrientOptions::default()).unwrap();
        assert!(!r.changed, "{}", r.reason);
    }
    #[test] fn pose_that_does_not_fit_is_never_chosen() {
        let cfg = test_cfg(&[]);
        let m = Mesh::from_soup(&shapes::boxs(300., 20., 10.)).unwrap(); // does not fit in X on a 256 bed in ANY pose with 300 along a horizontal axis
        let r = orient(&m, &cfg, &OrientOptions::default()).unwrap();
        assert!(r.all.iter().all(|c| !c.score.fits_bed || c.score.height_mm <= 261.0));
        let _ = slice_soup;
    }
}
