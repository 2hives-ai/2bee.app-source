//! Skirt and brim: ports of `Print::_make_skirt` (combined skirt of one convex hull), `Skirt::find_start_point`
//! (`skirt_start_angle`), and `Brim.cpp` (`brim_type` outer/inner/both, `brim_object_gap`, loop spacing from the
//! first-layer flow).
//!
//! * The skirt hull is the convex hull of the first `skirt_height` layers' slice contours; loops are offset with
//!   Clipper's `jtRound` join (arc tolerance 0.1 mm, replicated step for step), simplified at 0.05 mm, printed
//!   outermost first.
//! * `skirt_type = per_object` for a single object is identical to `combined`; with several objects only the
//!   combined hull is produced here (the lead's pipeline places one object).
//! * Brim ears / mouse ears and the auto-brim width heuristic (`configBrimWidthByVolumeGroups`) are NOT implemented:
//!   `brim_type = auto_brim` uses the configured `brim_width`, ears are reported as unsupported.

use super::geo::{self, P2};
use super::plan::Stroke;
use super::settings::Settings;
use crate::types::{Feature, Poly, Polys};

/// First-layer flow of the skirt/brim: `Flow::new_from_config_width(frPerimeter, initial_layer_line_width,
/// nozzle, initial_layer_print_height)`. Returns (width, height, spacing, mm3_per_mm).
pub fn first_layer_flow(cfg: &Settings) -> (f64, f64, f64, f64) {
    let nozzle = cfg.num_or("nozzle_diameter", 0.4);
    let h = cfg.num_or("initial_layer_print_height", cfg.num_or("layer_height", 0.2));
    let mut w = cfg.abs("initial_layer_line_width", nozzle);
    if w <= 0.0 { w = cfg.abs("inner_wall_line_width", nozzle); }
    if w <= 0.0 { w = cfg.abs("line_width", nozzle); }
    if w <= 0.0 { w = 1.125 * nozzle; }
    let spacing = rect_spacing(w, h);
    (w, h, spacing, rect_mm3(w, h))
}

/// Orca `Flow::rounded_rectangle_extrusion_spacing`: `w - h*(1 - pi/4)`.
pub fn rect_spacing(w: f64, h: f64) -> f64 { w - h * (1.0 - std::f64::consts::FRAC_PI_4) }
/// Cross-section of an extrusion bead (`Flow::mm3_per_mm`, rectangle with semicircular ends).
pub fn rect_mm3(w: f64, h: f64) -> f64 { (w - h * (1.0 - std::f64::consts::FRAC_PI_4)) * h }

/// Clipper `ClipperOffset` round-join offset of a convex CCW polygon (outward, `delta` > 0) with the given arc tolerance.
/// Reproduces Clipper's vertex placement (steps per radian, rotation from the previous normal).
pub fn clipper_round_offset_convex(poly: &[P2], delta: f64, arc_tol: f64) -> Vec<P2> {
    let n = poly.len();
    if n < 3 { return poly.to_vec(); }
    // normals of each edge (outward for CCW polygons: right-hand normal)
    let mut normals: Vec<P2> = Vec::with_capacity(n);
    for i in 0..n {
        let a = poly[i]; let b = poly[(i + 1) % n];
        let d = geo::sub(b, a);
        let l = geo::norm(d);
        normals.push(if l > 0.0 { [d[1] / l, -d[0] / l] } else { [0.0, 0.0] });
    }
    let y = if arc_tol <= 0.0 { 0.25 } else if arc_tol > delta.abs() * 0.25 { delta.abs() * 0.25 } else { arc_tol };
    let steps = std::f64::consts::PI / (1.0 - y / delta.abs()).acos();
    let steps_per_rad = steps / (2.0 * std::f64::consts::PI);
    let sin = (2.0 * std::f64::consts::PI / steps).sin() * if delta < 0.0 { -1.0 } else { 1.0 };
    let cos = (2.0 * std::f64::consts::PI / steps).cos();
    let round = |v: f64| (v * 1e6).round() / 1e6;
    let mut out: Vec<P2> = Vec::new();
    // Clipper walks j = i, k = i-1: join between the incoming edge (normal[k]) and the outgoing edge (normal[j]).
    for j in 0..n {
        let k = (j + n - 1) % n;
        let sin_a = (normals[k][0] * normals[j][1] - normals[j][0] * normals[k][1]).clamp(-1.0, 1.0);
        if sin_a.abs() < 0.00005 { out.push([round(poly[j][0] + normals[k][0] * delta), round(poly[j][1] + normals[k][1] * delta)]); continue; }
        let a = sin_a.atan2(normals[k][0] * normals[j][0] + normals[k][1] * normals[j][1]);
        let st = ((steps_per_rad * a.abs()).round() as i64).max(1);
        let (mut x, mut yv) = (normals[k][0], normals[k][1]);
        for _ in 0..st {
            out.push([round(poly[j][0] + x * delta), round(poly[j][1] + yv * delta)]);
            let x2 = x;
            x = x * cos - sin * yv;
            yv = x2 * sin + yv * cos;
        }
        out.push([round(poly[j][0] + normals[j][0] * delta), round(poly[j][1] + normals[j][1] * delta)]);
    }
    out
}

/// Douglas-Peucker on a closed ring as Orca's `Polygon::douglas_peucker` (open polyline p0..pn-1,p0).
pub fn dp_closed(ring: &[P2], tol: f64) -> Vec<P2> {
    if ring.len() < 4 { return ring.to_vec(); }
    let mut pts: Vec<P2> = ring.to_vec();
    pts.push(ring[0]);
    let n = pts.len();
    let mut keep = vec![false; n];
    keep[0] = true; keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 { continue; }
        let (a, b) = (pts[lo], pts[hi]);
        let ab = geo::sub(b, a);
        let l = geo::norm(ab);
        let mut best = -1.0; let mut bi = lo;
        for i in lo + 1..hi {
            let d = if l < 1e-12 { geo::dist(pts[i], a) } else { geo::cross(ab, geo::sub(pts[i], a)).abs() / l };
            if d > best { best = d; bi = i; }
        }
        if best > tol { keep[bi] = true; stack.push((lo, bi)); stack.push((bi, hi)); }
    }
    let mut out: Vec<P2> = (0..n - 1).filter(|&i| keep[i]).map(|i| pts[i]).collect();
    if out.len() < 3 { out = ring.to_vec(); }
    out
}

pub struct SkirtLoops {
    /// Loops, outermost first (Orca reverses the generation order before export).
    pub loops: Vec<Vec<P2>>,
    pub width: f64,
    pub spacing: f64,
}

/// Skirt loops around the convex hull of `hull_points`. `None` when the configuration has no skirt.
pub fn make_skirt(hull_points: &[P2], cfg: &Settings) -> Option<SkirtLoops> {
    let loops_n = cfg.int("skirt_loops").max(0) as usize;
    if loops_n == 0 || hull_points.len() < 3 { return None; }
    let (width, _h, spacing, _) = first_layer_flow(cfg);
    let hull = geo::convex_hull(hull_points);
    if hull.len() < 3 { return None; }
    let mut distance = cfg.num("skirt_distance") - spacing / 2.0;
    let mut loops = Vec::new();
    for _ in 0..loops_n {
        distance += spacing;
        let off = clipper_round_offset_convex(&hull, distance, 0.1);
        let simp = dp_closed(&off, 0.05);
        if simp.is_empty() { break; }
        loops.push(simp);
    }
    loops.reverse();
    Some(SkirtLoops { loops, width, spacing })
}

/// `Skirt::find_start_point`: the point at `start_angle` degrees on the circle through the bbox min corner.
pub fn find_start_point(loop_pts: &[P2], start_angle_deg: f64) -> P2 {
    let (lo, hi) = geo::bbox(loop_pts).unwrap();
    let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];
    let r = geo::dist(c, lo);
    let deg = start_angle_deg * std::f64::consts::PI / 180.0;
    [c[0] + r * deg.cos(), c[1] + r * deg.sin()]
}

/// Brim strokes (closed loops, outermost first) for the first-layer `slices`.
/// Also returns the outer boundary points of the brim areas (they enlarge the skirt hull like Orca's occupied points).
pub fn make_brim(slices: &Polys, cfg: &Settings, issues: &mut Vec<String>) -> (Vec<Stroke>, Vec<P2>) {
    let kind = if cfg.has("brim_type") { cfg.text("brim_type") } else { "no_brim".into() };
    let (width, h, spacing, _) = first_layer_flow(cfg);
    let gap = cfg.num("brim_object_gap");
    let bw_cfg = cfg.num("brim_width");
    // floor(brim_width / spacing / 2) * spacing * 2 (Orca quantises to an even number of loops)
    let bw = (bw_cfg / spacing / 2.0).floor() * spacing * 2.0;
    let (outer, inner) = match kind.as_str() {
        "no_brim" => return (Vec::new(), Vec::new()),
        "outer_only" => (true, false),
        "inner_only" => (false, true),
        "outer_and_inner" => (true, true),
        "auto_brim" => {
            issues.push("brim_type auto_brim: the auto width heuristic is not implemented, using brim_width".into());
            (true, false)
        }
        other => { issues.push(format!("brim_type {} (ears) is not implemented; no brim generated", other)); return (Vec::new(), Vec::new()); }
    };
    if bw <= 0.0 { return (Vec::new(), Vec::new()); }
    let tol = 0.0125;
    let mut areas: Polys = Vec::new();
    for p in slices {
        if outer {
            let outer_poly = Poly { contour: p.contour.clone(), holes: vec![] };
            let o = geo::offset_poly(&outer_poly, gap + bw, tol);
            let i = geo::offset_poly(&outer_poly, gap, tol);
            for (mut a, b) in o.into_iter().zip(i.into_iter()) {
                a.holes.push({ let mut c = b.contour; if geo::signed_area(&c) > 0.0 { c.reverse(); } c });
                areas.push(a);
            }
        }
        if inner {
            for hole in &p.holes {
                // hole boundary offset into the hole by gap, then by gap+width: an inner ring of width bw inside the hole
                let mut hr = hole.clone();
                if geo::signed_area(&hr) < 0.0 { hr.reverse(); }
                let shape = Poly { contour: hr, holes: vec![] };
                let a = geo::offset_poly(&shape, -gap, tol);
                let b = geo::offset_poly(&shape, -(gap + bw), tol);
                for (mut x, y) in a.into_iter().zip(b.into_iter()) {
                    x.holes.push({ let mut c = y.contour; if geo::signed_area(&c) > 0.0 { c.reverse(); } c });
                    areas.push(x);
                }
            }
        }
    }
    let area_pts: Vec<P2> = areas.iter().flat_map(|a| a.contour.iter().copied()).collect();
    // tryExPolygonOffset
    let mut loops: Vec<(usize, Vec<P2>)> = Vec::new();
    for a in &areas {
        let mut cur: Polys = geo::offset_poly(a, -0.5 * spacing, tol);
        let mut depth = 0usize;
        while !cur.is_empty() && depth < 10_000 {
            for p in &cur {
                loops.push((depth, p.contour.clone()));
                for hh in &p.holes { loops.push((depth, hh.clone())); }
            }
            let shrunk = geo::offset_polys(&cur, -1.3 * spacing, tol);
            cur = geo::offset_polys(&shrunk, 0.3 * spacing, tol);
            depth += 1;
        }
    }
    loops.sort_by_key(|l| l.0);
    let strokes = loops.into_iter().map(|(_, r)| {
        let n = r.len();
        Stroke { w: vec![width; n], feat: vec![Feature::Brim; n], pts: r, h, speed: 0.0, flow_ratio: 1.0, closed: true }
    }).collect();
    (strokes, area_pts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Settings {
        Settings::from_config_block("; skirt_loops = 1\n; skirt_distance = 2\n; initial_layer_line_width = 0.5\n; initial_layer_print_height = 0.2\n; nozzle_diameter = 0.4,0.4\n; layer_height = 0.2\n; skirt_start_angle = -135\n; brim_type = no_brim\n; brim_width = 5\n; brim_object_gap = 0.1\n")
    }

    #[test]
    fn skirt_matches_orca_cube_reference() {
        // Reference: Orca skirt around the 128.25..148.25 x 118..138 cube (cube_ref.gcode, FEATURE: Skirt)
        let hull = [[128.25, 118.0], [148.25, 118.0], [148.25, 138.0], [128.25, 138.0]];
        let sk = make_skirt(&hull, &cfg()).unwrap();
        assert_eq!(sk.loops.len(), 1);
        let l = &sk.loops[0];
        // 4 straight edges, 4 corners of 4 points each = 16 points
        assert_eq!(l.len(), 16, "{:?}", l);
        let (lo, hi) = geo::bbox(l).unwrap();
        assert!((lo[0] - 126.021).abs() < 0.002 && (hi[0] - 150.479).abs() < 0.002);
        assert!((lo[1] - 115.771).abs() < 0.002 && (hi[1] - 140.229).abs() < 0.002);
        // the corner vertices Orca printed: (149.511,116.162) (150.329,117.198)
        let has = |x: f64, y: f64| l.iter().any(|p| (p[0] - x).abs() < 0.002 && (p[1] - y).abs() < 0.002);
        assert!(has(149.511, 116.162) && has(150.329, 117.198) && has(150.479, 118.0) && has(148.25, 115.771), "{:?}", l);
        let sp = find_start_point(l, -135.0);
        assert!((sp[0] - 126.021).abs() < 0.01 && (sp[1] - 115.771).abs() < 0.01, "{:?}", sp);
    }

    #[test]
    fn brim_loops_fill_the_ring() {
        let mut c = cfg();
        c.set("brim_type", "outer_only");
        c.set("brim_width", "3");
        let slices = vec![Poly { contour: vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]], holes: vec![] }];
        let mut issues = Vec::new();
        let (b, _) = make_brim(&slices, &c, &mut issues);
        assert!(issues.is_empty());
        // 3 mm width at 0.4571 spacing -> floor(3/0.4571/2)*2 = 6 loops
        assert!(b.len() >= 5 && b.len() <= 7, "{} loops", b.len());
        let outer = geo::bbox(&b[0].pts).unwrap();
        assert!(outer.0[0] < -2.0 && outer.0[0] > -3.2, "{:?}", outer);
    }
}
