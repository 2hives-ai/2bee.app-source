//! Lane 9: synthetic test solids with analytically known properties (the "truth" for precision/recall).
//! Triangle soups in mm, outward-facing, built from profiles (prism along Y, revolve about Z) and boxes.
use std::f64::consts::PI;

pub type Soup = Vec<[f64; 9]>;

fn tri(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 9] { [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]] }

pub fn translate(soup: &[[f64; 9]], d: [f64; 3]) -> Soup {
    soup.iter().map(|t| { let mut a = *t; for k in 0..3 { for j in 0..3 { a[k * 3 + j] += d[j]; } } a }).collect()
}

/// Axis-aligned box [0,x]x[0,y]x[0,z].
pub fn boxs(x: f64, y: f64, z: f64) -> Soup {
    let c = [[0., 0., 0.], [x, 0., 0.], [x, y, 0.], [0., y, 0.], [0., 0., z], [x, 0., z], [x, y, z], [0., y, z]];
    let quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    let mut t = vec![];
    for q in quads { for tr in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] { t.push(tri(c[tr[0]], c[tr[1]], c[tr[2]])); } }
    t
}

/// Extrude a simple CCW polygon given in (x, z) along y in [0, len].
pub fn prism(prof: &[[f64; 2]], len: f64) -> Soup {
    let n = prof.len();
    let cross = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let mut idx: Vec<usize> = (0..n).collect();
    let mut tris: Vec<[usize; 3]> = vec![];
    let mut guard = 0;
    while idx.len() > 3 && guard < 10000 {
        guard += 1;
        let mut cut = false;
        for k in 0..idx.len() {
            let (i0, i1, i2) = (idx[(k + idx.len() - 1) % idx.len()], idx[k], idx[(k + 1) % idx.len()]);
            let (a, b, c) = (prof[i0], prof[i1], prof[i2]);
            if cross(a, b, c) <= 1e-9 { continue; }
            let inside = idx.iter().any(|&j| { if j == i0 || j == i1 || j == i2 { return false; } let p = prof[j]; cross(a, b, p) >= 0.0 && cross(b, c, p) >= 0.0 && cross(c, a, p) >= 0.0 });
            if inside { continue; }
            tris.push([i0, i1, i2]); idx.remove(k); cut = true; break;
        }
        if !cut { break; }
    }
    if idx.len() == 3 { tris.push([idx[0], idx[1], idx[2]]); }
    let p3 = |i: usize, y: f64| [prof[i][0], y, prof[i][1]];
    let mut out: Soup = vec![];
    for [a, b, c] in tris {
        out.push(tri(p3(a, 0.0), p3(b, 0.0), p3(c, 0.0)));
        out.push(tri(p3(a, len), p3(c, len), p3(b, len)));
    }
    for i in 0..n {
        let j = (i + 1) % n;
        let (a, b, c, d) = (p3(i, 0.0), p3(j, 0.0), p3(j, len), p3(i, len));
        out.push(tri(a, d, c)); out.push(tri(a, c, b));
    }
    out
}

/// Revolve a closed (r, z) polygon about Z. Profile must be CCW in (r, z) with r >= 0 (r = 0 points lie on the axis).
pub fn revolve(prof: &[[f64; 2]], seg: usize) -> Soup {
    let n = prof.len();
    let p = |r: f64, z: f64, k: usize| { let a = 2.0 * PI * (k % seg) as f64 / seg as f64; [r * a.cos(), r * a.sin(), z] };
    let mut out: Soup = vec![];
    for k in 0..seg {
        for i in 0..n {
            let j = (i + 1) % n;
            let ([r0, z0], [r1, z1]) = (prof[i], prof[j]);
            if r0 == 0.0 && r1 == 0.0 { continue; }
            let (a, b, c, d) = (p(r0, z0, k), p(r1, z1, k), p(r1, z1, k + 1), p(r0, z0, k + 1));
            // outward for a CCW (r,z) profile: right of the edge direction = (dz, -dr)
            if r0 == 0.0 { out.push(tri(a, c, b)); } else if r1 == 0.0 { out.push(tri(a, d, c)); } else { out.push(tri(a, d, c)); out.push(tri(a, c, b)); }
        }
    }
    out
}

/// Box [0,x]x[0,y]x[0,h] with a rectangular pocket cut from the bottom: pocket [px0,px1]x[py0,py1], ceiling at z = c.
/// The ceiling is a bridge anchored on all four sides: spans (px1-px0) along x and (py1-py0) along y.
pub fn pocket_box(x: f64, y: f64, h: f64, p: [f64; 4], c: f64) -> Soup {
    let mut t: Soup = vec![];
    // quad with the desired outward normal `n`: the winding is flipped when the vertex order disagrees
    let mut quad = |a: [f64; 3], b: [f64; 3], cc: [f64; 3], d: [f64; 3], n: [f64; 3]| {
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; let w = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
        let nn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        if nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] >= 0.0 { t.push(tri(a, b, cc)); t.push(tri(a, cc, d)); } else { t.push(tri(a, cc, b)); t.push(tri(a, d, cc)); }
    };
    let (px0, px1, py0, py1) = (p[0], p[1], p[2], p[3]);
    quad([0., 0., h], [x, 0., h], [x, y, h], [0., y, h], [0., 0., 1.]);
    quad([0., 0., 0.], [x, 0., 0.], [x, 0., h], [0., 0., h], [0., -1., 0.]);
    quad([x, 0., 0.], [x, y, 0.], [x, y, h], [x, 0., h], [1., 0., 0.]);
    quad([x, y, 0.], [0., y, 0.], [0., y, h], [x, y, h], [0., 1., 0.]);
    quad([0., y, 0.], [0., 0., 0.], [0., 0., h], [0., y, h], [-1., 0., 0.]);
    // bottom with a hole: four trapezoids facing down
    quad([0., 0., 0.], [x, 0., 0.], [px1, py0, 0.], [px0, py0, 0.], [0., 0., -1.]);
    quad([x, 0., 0.], [x, y, 0.], [px1, py1, 0.], [px1, py0, 0.], [0., 0., -1.]);
    quad([x, y, 0.], [0., y, 0.], [px0, py1, 0.], [px1, py1, 0.], [0., 0., -1.]);
    quad([0., y, 0.], [0., 0., 0.], [px0, py0, 0.], [px0, py1, 0.], [0., 0., -1.]);
    // pocket walls face INTO the pocket (out of the solid); ceiling faces down
    quad([px0, py0, 0.], [px1, py0, 0.], [px1, py0, c], [px0, py0, c], [0., 1., 0.]);
    quad([px1, py0, 0.], [px1, py1, 0.], [px1, py1, c], [px1, py0, c], [-1., 0., 0.]);
    quad([px1, py1, 0.], [px0, py1, 0.], [px0, py1, c], [px1, py1, c], [0., -1., 0.]);
    quad([px0, py1, 0.], [px0, py0, 0.], [px0, py0, c], [px0, py1, c], [1., 0., 0.]);
    quad([px0, py0, c], [px1, py0, c], [px1, py1, c], [px0, py1, c], [0., 0., -1.]);
    t
}

/// What is known about a case without slicing it (None = not asserted).
#[derive(Clone, Debug, Default)]
pub struct Truth {
    /// Any surface flatter than the support threshold exists (Orca would emit support if enabled).
    pub overhang: Option<bool>,
    /// Cannot be printed well without support (cantilever, or a bridge longer than the material limit).
    pub needs_support: Option<bool>,
    pub bridge_over_limit: Option<bool>,
    pub thin_unprintable: Option<bool>,
    pub adhesion_high: Option<bool>,
    pub tall_slender: Option<bool>,
    pub warp_high: Option<bool>,
    pub fits_bed: Option<bool>,
}

pub struct Case { pub name: &'static str, pub soup: Soup, pub set: Vec<(&'static str, &'static str)>, pub truth: Truth, pub note: &'static str }

fn t() -> Truth { Truth::default() }

pub fn cases() -> Vec<Case> {
    let tpr = prism(&[[-4., 0.], [4., 0.], [4., 10.], [15., 10.], [15., 14.], [-15., 14.], [-15., 10.], [-4., 10.]], 20.0);
    let br20 = prism(&[[-15., 0.], [-10., 0.], [-10., 10.], [10., 10.], [10., 0.], [15., 0.], [15., 14.], [-15., 14.]], 20.0);
    let br8 = prism(&[[-15., 0.], [-4., 0.], [-4., 10.], [4., 10.], [4., 0.], [15., 0.], [15., 14.], [-15., 14.]], 20.0);
    let slope = |dz: f64| revolve(&[[0., 0.], [6., 0.], [6., 6.], [14., 6. + dz], [14., 10. + dz], [0., 10. + dz]], 64);
    let mush = revolve(&[[0., 0.], [4., 0.], [4., 10.], [14., 10.], [14., 14.], [0., 14.]], 64);
    let cone = revolve(&[[0., 0.], [1.0, 0.], [10., 10.], [0., 10.]], 64);
    let tube = revolve(&[[5., 0.], [10., 0.], [10., 20.], [5., 20.]], 64);
    let sphere = { let mut p = vec![[0.0, 0.0]]; for i in 1..=24 { let a = PI * i as f64 / 24.0; p.push([15.0 * a.sin(), 15.0 - 15.0 * a.cos()]); } p.pop(); p.push([0.0, 30.0]); revolve(&p, 64) };
    let wall = |w: f64| { let mut s = boxs(20., 20., 1.); s.extend(translate(&boxs(w, 20., 10.), [30., 0., 0.])); s };
    let mut v: Vec<Case> = vec![];
    v.push(Case { name: "cube20", soup: boxs(20., 20., 20.), set: vec![], truth: Truth { overhang: Some(false), needs_support: Some(false), bridge_over_limit: Some(false), thin_unprintable: Some(false), adhesion_high: Some(false), tall_slender: Some(false), warp_high: Some(false), fits_bed: Some(true) }, note: "plain cube" });
    v.push(Case { name: "tube", soup: tube, set: vec![], truth: Truth { overhang: Some(false), needs_support: Some(false), thin_unprintable: Some(false), adhesion_high: Some(false), tall_slender: Some(false), ..t() }, note: "cylinder with through hole" });
    v.push(Case { name: "t_overhang", soup: tpr, set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(true), bridge_over_limit: Some(false), thin_unprintable: Some(false), ..t() }, note: "T: two 11 mm cantilevers" });
    v.push(Case { name: "bridge20", soup: br20, set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(true), bridge_over_limit: Some(true), thin_unprintable: Some(false), ..t() }, note: "20 mm bridge, PETG limit 12" });
    v.push(Case { name: "bridge8", soup: br8, set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(false), bridge_over_limit: Some(false), thin_unprintable: Some(false), ..t() }, note: "8 mm bridge: prints without support" });
    v.push(Case { name: "mushroom", soup: mush, set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(true), thin_unprintable: Some(false), ..t() }, note: "flat-underside cap on a stem" });
    v.push(Case { name: "slope25", soup: slope(8.0 * 25f64.to_radians().tan()), set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(true), thin_unprintable: Some(false), ..t() }, note: "25 deg underside (below the 31 deg limit)" });
    v.push(Case { name: "slope45", soup: slope(8.0), set: vec![], truth: Truth { overhang: Some(false), needs_support: Some(false), thin_unprintable: Some(false), ..t() }, note: "45 deg underside (printable)" });
    v.push(Case { name: "slope37", soup: slope(6.0), set: vec![], truth: Truth { overhang: Some(false), needs_support: Some(false), thin_unprintable: Some(false), ..t() }, note: "36.9 deg underside (printable, 6 deg above the limit)" });
    v.push(Case { name: "sphere", soup: sphere, set: vec![], truth: Truth { overhang: Some(true), thin_unprintable: Some(false), adhesion_high: Some(true), ..t() }, note: "R15 sphere: polar cap flatter than 31 deg, point contact with the bed" });
    v.push(Case { name: "cone_tip_down", soup: cone, set: vec![], truth: Truth { overhang: Some(false), needs_support: Some(false), adhesion_high: Some(true), ..t() }, note: "cone resting on its 1 mm radius tip" });
    v.push(Case { name: "wall0p3", soup: wall(0.3), set: vec![], truth: Truth { overhang: Some(false), thin_unprintable: Some(true), ..t() }, note: "0.3 mm wall: below one line width" });
    v.push(Case { name: "wall0p6", soup: wall(0.6), set: vec![], truth: Truth { overhang: Some(false), thin_unprintable: Some(false), ..t() }, note: "0.6 mm wall: prints as a single line" });
    v.push(Case { name: "wall1p2", soup: wall(1.2), set: vec![], truth: Truth { overhang: Some(false), thin_unprintable: Some(false), ..t() }, note: "1.2 mm wall" });
    v.push(Case { name: "tower5x50", soup: boxs(5., 5., 50.), set: vec![], truth: Truth { overhang: Some(false), adhesion_high: Some(true), tall_slender: Some(true), ..t() }, note: "5x5x50 tower" });
    v.push(Case { name: "slab100", soup: boxs(100., 100., 2.), set: vec![], truth: Truth { overhang: Some(false), adhesion_high: Some(false), tall_slender: Some(false), ..t() }, note: "100x100x2 plate" });
    v.push(Case { name: "cube40", soup: boxs(40., 40., 40.), set: vec![], truth: Truth { overhang: Some(false), adhesion_high: Some(false), tall_slender: Some(false), ..t() }, note: "40 mm cube" });
    // parametric sweeps (truth from the geometry; borderline values are left unasserted on purpose)
    for ang in [15.0f64, 20.0, 25.0, 28.0, 30.0, 32.0, 35.0, 40.0, 50.0, 60.0] {
        let name: &'static str = Box::leak(format!("slope_{ang:.0}").into_boxed_str());
        let truth = if ang <= 28.0 { Some(true) } else if ang >= 35.0 { Some(false) } else { None };
        v.push(Case { name, soup: slope(8.0 * ang.to_radians().tan()), set: vec![], truth: Truth { overhang: truth, needs_support: truth, thin_unprintable: Some(false), ..t() }, note: "underside slope sweep, limit 31 deg" });
    }
    for g in [4.0f64, 6.0, 8.0, 10.0, 11.0, 13.0, 16.0, 20.0, 25.0, 30.0] {
        let name: &'static str = Box::leak(format!("bridge_{g:.0}").into_boxed_str());
        let h = g / 2.0;
        let b = prism(&[[-(h + 5.0), 0.], [-h, 0.], [-h, 10.], [h, 10.], [h, 0.], [h + 5.0, 0.], [h + 5.0, 14.], [-(h + 5.0), 14.]], 20.0);
        v.push(Case { name, soup: b, set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(g > 12.0), bridge_over_limit: Some(g > 12.0), thin_unprintable: Some(false), ..t() }, note: "bridge span sweep, PETG limit 12" });
    }
    for w in [0.15f64, 0.18, 0.2, 0.22, 0.25, 0.35, 0.5, 0.7, 1.0] {
        let name: &'static str = Box::leak(format!("wall_{}", (w * 100.0).round() as i32).into_boxed_str());
        v.push(Case { name, soup: wall(w), set: vec![], truth: Truth { overhang: Some(false), thin_unprintable: Some(w < 0.4), ..t() }, note: "wall thickness sweep, one line = 0.42" });
    }
    // hold-out: values chosen AFTER the thresholds were fixed, not used to tune anything
    for ang in [22.0f64, 27.0, 34.0, 38.0, 55.0] {
        let name: &'static str = Box::leak(format!("ho_slope_{ang:.0}").into_boxed_str());
        let truth = if ang <= 28.0 { Some(true) } else if ang >= 34.0 { Some(false) } else { None };
        v.push(Case { name, soup: slope(8.0 * ang.to_radians().tan()), set: vec![], truth: Truth { overhang: truth, needs_support: truth, thin_unprintable: Some(false), ..t() }, note: "hold-out slope" });
    }
    for g in [9.0f64, 14.0, 22.0] {
        let name: &'static str = Box::leak(format!("ho_bridge_{g:.0}").into_boxed_str());
        let h = g / 2.0;
        let b = prism(&[[-(h + 4.0), 0.], [-h, 0.], [-h, 12.], [h, 12.], [h, 0.], [h + 4.0, 0.], [h + 4.0, 15.], [-(h + 4.0), 15.]], 15.0);
        v.push(Case { name, soup: b, set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(g > 12.0), bridge_over_limit: Some(g > 12.0), thin_unprintable: Some(false), ..t() }, note: "hold-out bridge" });
    }
    for w in [0.3f64, 0.38, 0.46, 0.55, 0.9] {
        let name: &'static str = Box::leak(format!("ho_wall_{}", (w * 100.0).round() as i32).into_boxed_str());
        v.push(Case { name, soup: wall(w), set: vec![], truth: Truth { overhang: Some(false), thin_unprintable: Some(w < 0.4), ..t() }, note: "hold-out wall" });
    }
    v.push(Case { name: "window30x12", soup: pocket_box(50., 30., 16., [10., 40., 9., 21.], 8.), set: vec![], truth: Truth { overhang: Some(true), needs_support: Some(false), bridge_over_limit: Some(false), thin_unprintable: Some(false), ..t() }, note: "30 x 12 mm pocket ceiling anchored on 4 sides: shortest span 12 mm across y" });
    v.push(Case { name: "plate_abs", soup: boxs(200., 150., 4.), set: vec![("filament_type", "ABS")], truth: Truth { warp_high: Some(true), fits_bed: Some(true), ..t() }, note: "200x150 ABS plate warps (config override only)" });
    v.push(Case { name: "plate_pla", soup: boxs(200., 150., 4.), set: vec![("filament_type", "PLA")], truth: Truth { warp_high: Some(false), fits_bed: Some(true), ..t() }, note: "same plate in PLA" });
    v.push(Case { name: "too_wide", soup: boxs(300., 50., 5.), set: vec![], truth: Truth { fits_bed: Some(false), ..t() }, note: "300 mm on a 256 bed" });
    v.push(Case { name: "too_tall", soup: boxs(100., 100., 300.), set: vec![], truth: Truth { fits_bed: Some(false), ..t() }, note: "300 mm tall, limit 261" });
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Mesh;
    #[test] fn every_case_is_a_closed_solid_with_positive_volume() {
        for c in cases() {
            let m = Mesh::from_soup(&c.soup).unwrap();
            let r = m.validate();
            assert!(r.is_watertight() && r.volume > 0.0, "{}: {:?}", c.name, r);
        }
    }
}
