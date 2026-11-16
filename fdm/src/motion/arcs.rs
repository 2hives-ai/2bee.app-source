//! Arc fitting of extrusion paths: a port of Orca's `ArcFitter::do_arc_fitting_and_simplify` with `Circle` /
//! `ArcSegment::try_create_arc` (BBS ArcWelderLib heritage). The arithmetic is done on integer micrometre-scaled
//! coordinates (1e-6 mm units, like libslic3r's `coord_t`) so tolerances, truncating casts and the 5 % length check
//! behave as in Orca. Input and output are millimetres.
//!
//! `Seg::Arc` carries what `G2/G3 X Y I J` needs: the end point is `pts[b]`, the start point `pts[a]`, `center`.

use super::geo::P2;

const SC: f64 = 1e6;
const SCALED_EPSILON: f64 = 100.0; // scale_(1e-4)
const ZERO_TOLERANCE: f64 = 0.000005;
const EPSILON_ANGLE: f64 = 1e-4;
const MAX_RADIUS: f64 = 2000.0 * SC;
const LEN_PERCENT_TOL: f64 = 0.05;

type Pt = [f64; 2];

#[derive(Clone, Debug, PartialEq)]
pub enum Seg {
    Line { a: usize, b: usize },
    Arc { a: usize, b: usize, center: P2, ccw: bool, length: f64 },
}

fn to_sc(p: P2) -> Pt { [(p[0] * SC).round(), (p[1] * SC).round()] }
fn from_sc(p: Pt) -> P2 { [p[0] / SC, p[1] / SC] }

#[derive(Clone, Copy)]
struct Circle { c: Pt, r: f64 }

fn polar(c: &Circle, p: Pt) -> f64 {
    let mut a = (p[1] - c.c[1]).atan2(p[0] - c.c[0]);
    if a < 0.0 { a += 2.0 * std::f64::consts::PI; }
    a
}

fn approx_eq(x: f64, y: f64) -> bool { (x - y).abs() < ZERO_TOLERANCE }

fn try_circle3(p1: Pt, p2: Pt, p3: Pt) -> Option<Circle> {
    let (x1, y1, x2, y2, x3, y3) = (p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    if ((y1 - y2) * (x1 - x3) - (y1 - y3) * (x1 - x2)).abs() <= SC * SC * 0.0001 { return None; }
    let a = x1 * (y2 - y3) - y1 * (x2 - x3) + x2 * y3 - x3 * y2;
    if a.abs() < SCALED_EPSILON { return None; }
    let b = (x1 * x1 + y1 * y1) * (y3 - y2) + (x2 * x2 + y2 * y2) * (y1 - y3) + (x3 * x3 + y3 * y3) * (y2 - y1);
    let c = (x1 * x1 + y1 * y1) * (x2 - x3) + (x2 * x2 + y2 * y2) * (x3 - x1) + (x3 * x3 + y3 * y3) * (x1 - x2);
    let cx = -b / (2.0 * a);
    let cy = -c / (2.0 * a);
    let (dx, dy) = (cx - x1, cy - y1);
    let radius = (dx * dx + dy * dy).sqrt();
    if radius > MAX_RADIUS { return None; }
    // `Point(center_x, center_y)` truncates the doubles toward zero
    Some(Circle { c: [cx.trunc(), cy.trunc()], r: radius })
}

fn closest_perpendicular(p1: Pt, p2: Pt, c: Pt) -> Option<Pt> {
    let (xd, yd) = (p2[0] - p1[0], p2[1] - p1[1]);
    let num = (c[0] - p1[0]) * xd + (c[1] - p1[1]) * yd;
    let den = xd * xd + yd * yd;
    let t = num / den;
    if t < 0.0 || approx_eq(t, 0.0) || t > 1.0 || approx_eq(t, 1.0) { return None; }
    // coordinates are assigned into an integer Point: truncation toward zero
    Some([(p1[0] + t * (p2[0] - p1[0])).trunc(), (p1[1] + t * (p2[1] - p1[1])).trunc()])
}

fn is_over_deviation(c: &Circle, pts: &[Pt], tol: f64) -> bool {
    for i in 0..pts.len() - 1 {
        if i != 0 {
            let d = ((pts[i][0] - c.c[0]).powi(2) + (pts[i][1] - c.c[1]).powi(2)).sqrt();
            if (d - c.r).abs() > tol { return true; }
        }
        if let Some(cp) = closest_perpendicular(pts[i], pts[i + 1], c.c) {
            let d = ((cp[0] - c.c[0]).powi(2) + (cp[1] - c.c[1]).powi(2)).sqrt();
            if (d - c.r).abs() > tol { return true; }
        }
    }
    false
}

fn deviation_sum_squared(c: &Circle, pts: &[Pt], tol: f64) -> Option<f64> {
    let mut total = 0.0;
    for i in 1..pts.len() - 1 {
        let d = ((pts[i][0] - c.c[0]).powi(2) + (pts[i][1] - c.c[1]).powi(2)).sqrt();
        let dev = (d - c.r).abs();
        total += dev * dev;
        if dev > tol { return None; }
    }
    for i in 0..pts.len() - 1 {
        if let Some(cp) = closest_perpendicular(pts[i], pts[i + 1], c.c) {
            let d = ((cp[0] - c.c[0]).powi(2) + (cp[1] - c.c[1]).powi(2)).sqrt();
            let dev = (d - c.r).abs();
            total += dev * dev;
            if dev > tol { return None; }
        }
    }
    Some(total)
}

fn try_circle(pts: &[Pt], tol: f64) -> Option<Circle> {
    let count = pts.len();
    let mid = count / 2;
    if count == 3 {
        return try_circle3(pts[0], pts[mid], pts[count - 1]).filter(|c| !is_over_deviation(c, pts, tol));
    }
    let mp: Pt = if count % 2 == 0 { [((pts[mid][0] + pts[mid - 1][0]) / 2.0).trunc(), ((pts[mid][1] + pts[mid - 1][1]) / 2.0).trunc()] }
        else { [((pts[mid - 1][0] + pts[mid + 1][0]) / 2.0).trunc(), ((pts[mid - 1][1] + pts[mid + 1][1]) / 2.0).trunc()] };
    if let Some(c) = try_circle3(pts[0], mp, pts[count - 1]) { if !is_over_deviation(&c, pts, tol) { return Some(c); } }
    let mut best: Option<(Circle, f64)> = None;
    for i in 1..count - 1 {
        if i == mid { continue; }
        if let Some(c) = try_circle3(pts[0], pts[i], pts[count - 1]) {
            if let Some(dev) = deviation_sum_squared(&c, pts, tol) {
                if best.map_or(true, |b| dev < b.1) { best = Some((c, dev)); }
            }
        }
    }
    best.map(|b| b.0)
}

#[derive(Clone, Copy)]
struct Arc {
    c: Circle,
    start: Pt,
    end: Pt,
    ccw: bool,
    length: f64,
    ts: f64,
    te: f64,
}

fn try_arc(c: &Circle, start: Pt, mid: Pt, end: Pt, approx_len: f64) -> Option<Arc> {
    let (ts, tm, te) = (polar(c, start), polar(c, mid), polar(c, end));
    let pi2 = 2.0 * std::f64::consts::PI;
    let mut angle = 0.0;
    let mut dir: Option<bool> = None; // Some(true)=CCW
    if te > ts {
        if ts < tm && tm < te { dir = Some(true); angle = te - ts; }
        else if (0.0 <= tm && tm < ts) || (te < tm && tm < pi2) { dir = Some(false); angle = ts + (pi2 - te); }
    } else if ts > te {
        if (ts < tm && tm < pi2) || (0.0 < tm && tm < te) { dir = Some(true); angle = te + (pi2 - ts); }
        else if te < tm && tm < ts { dir = Some(false); angle = ts - te; }
    }
    let mut ccw = dir?;
    if angle.abs() < EPSILON_ANGLE { return None; }
    let mut arc_len = c.r * angle;
    let mut diff = (arc_len - approx_len) / approx_len;
    if diff.abs() >= LEN_PERCENT_TOL {
        let test_rad = (angle - pi2).abs();
        let test_len = c.r * test_rad;
        diff = (test_len - approx_len) / approx_len;
        if diff.abs() >= LEN_PERCENT_TOL { return None; }
        arc_len = test_len;
        ccw = !ccw;
    }
    Some(Arc { c: *c, start, end, ccw, length: arc_len, ts, te })
}

fn ray_intersects_segment(origin: Pt, dir: [f64; 2], a: Pt, b: Pt) -> bool {
    let v1 = [origin[0] - a[0], origin[1] - a[1]];
    let v2 = [b[0] - a[0], b[1] - a[1]];
    let v3 = [-dir[1], dir[0]];
    let dot = v2[0] * v3[0] + v2[1] * v3[1];
    if dot.abs() < SCALED_EPSILON { return false; }
    let t1 = (v2[0] * v1[1] - v2[1] * v1[0]) / dot;
    let t2 = (v1[0] * v3[0] + v1[1] * v3[1]) / dot;
    t1 >= 0.0 && (t2 >= 0.0 && t2 <= 1.0)
}

fn points_within_slice(arc: &Arc, pts: &[Pt]) -> bool {
    let n = pts.len() as i64;
    let mut previous = arc.ts;
    let mut crossed_zero = false;
    let r = arc.c.r;
    let start_norm = [(arc.start[0] - arc.c.c[0]) / r, (arc.start[1] - arc.c.c[1]) / r];
    let end_norm = [(arc.end[0] - arc.c.c[0]) / r, (arc.end[1] - arc.c.c[1]) / r];
    let will_cross_zero = if arc.ccw { arc.ts > arc.te } else { arc.ts < arc.te };
    let mut index = n - 2;
    while index < n {
        let polar_test = if index < n - 1 { polar(&arc.c, pts[index as usize]) } else { arc.te };
        if arc.ccw {
            if index < n - 1 {
                if will_cross_zero { if !(polar_test > arc.ts || polar_test < arc.te) { return false; } }
                else if !(arc.ts < polar_test && polar_test < arc.te) { return false; }
            }
            if previous > polar_test {
                if !will_cross_zero { return false; }
                if crossed_zero { return false; }
                crossed_zero = true;
            }
        } else {
            if index < n - 1 {
                if will_cross_zero { if !(polar_test < arc.ts || polar_test > arc.te) { return false; } }
                else if !(arc.ts > polar_test && polar_test > arc.te) { return false; }
            }
            if previous < polar_test {
                if !will_cross_zero { return false; }
                if crossed_zero { return false; }
                crossed_zero = true;
            }
        }
        let (sa, sb) = (pts[(index - 1) as usize], pts[index as usize]);
        if (index != 1 && ray_intersects_segment(arc.c.c, start_norm, sa, sb)) || (index != n - 1 && ray_intersects_segment(arc.c.c, end_norm, sa, sb)) { return false; }
        previous = polar_test;
        index += 1;
    }
    will_cross_zero == crossed_zero
}

fn polyline_len(p: &[Pt]) -> f64 { p.windows(2).map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt()).sum() }

fn try_create_arc(pts: &[Pt], tol: f64, approx_len: f64) -> Option<Arc> {
    let c = try_circle(pts, tol)?;
    let mid = ((pts.len() - 2) / 2) + 1;
    let arc = try_arc(&c, pts[0], pts[mid], pts[pts.len() - 1], approx_len)?;
    if points_within_slice(&arc, pts) { Some(arc) } else { None }
}

#[derive(Clone)]
struct Fit { a: usize, b: usize, arc: Option<Arc> }

fn do_arc_fitting(points: &[Pt], tol: f64) -> Vec<Fit> {
    let mut result: Vec<Fit> = Vec::new();
    if points.len() < 3 { return vec![Fit { a: 0, b: points.len() - 1, arc: None }]; }
    let (mut front, mut back) = (0usize, 0usize);
    let mut last_arc: Option<Arc> = None;
    let mut current: Vec<Pt> = Vec::new();
    for i in 0..points.len() {
        back = i;
        current.push(points[i]);
        if back - front < 2 { continue; }
        let len = polyline_len(&current);
        if let Some(arc) = try_create_arc(&current, tol, len) {
            last_arc = Some(arc);
            if back == points.len() - 1 {
                result.push(Fit { a: front, b: back, arc: last_arc });
                front = back;
            }
        } else {
            if back - front > 2 {
                result.push(Fit { a: front, b: back - 1, arc: last_arc });
            } else {
                match result.last_mut() {
                    Some(l) if l.arc.is_none() => l.b = front + 1,
                    _ => result.push(Fit { a: front, b: front + 1, arc: None }),
                }
            }
            front = back - 1;
            current.clear();
            current.push(points[front]);
            current.push(points[front + 1]);
        }
    }
    if front != back {
        match result.last_mut() {
            Some(l) if l.arc.is_none() => l.b = back,
            _ => result.push(Fit { a: front, b: back, arc: None }),
        }
    }
    result
}

fn douglas_peucker(pts: &[Pt], tol: f64) -> Vec<Pt> {
    let n = pts.len();
    if n < 3 { return pts.to_vec(); }
    let mut keep = vec![false; n];
    keep[0] = true; keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((lo, hi)) = stack.pop() {
        if hi <= lo + 1 { continue; }
        let (a, b) = (pts[lo], pts[hi]);
        let ab = [b[0] - a[0], b[1] - a[1]];
        let l = (ab[0] * ab[0] + ab[1] * ab[1]).sqrt();
        let mut best = -1.0; let mut bi = lo;
        for i in lo + 1..hi {
            let ap = [pts[i][0] - a[0], pts[i][1] - a[1]];
            let d = if l < 1e-12 { (ap[0] * ap[0] + ap[1] * ap[1]).sqrt() } else { (ab[0] * ap[1] - ab[1] * ap[0]).abs() / l };
            if d > best { best = d; bi = i; }
        }
        if best > tol { keep[bi] = true; stack.push((lo, bi)); stack.push((bi, hi)); }
    }
    (0..n).filter(|&i| keep[i]).map(|i| pts[i]).collect()
}

/// `ArcFitter::do_arc_fitting_and_simplify`: returns the simplified polyline (mm) and its line / arc pieces.
/// `tol_mm` is the slicing resolution (Orca: `resolution` = 0.012 mm).
pub fn fit_and_simplify(pts_mm: &[P2], tol_mm: f64) -> (Vec<P2>, Vec<Seg>) {
    let n = pts_mm.len();
    if n < 2 { return (pts_mm.to_vec(), vec![]); }
    let mut points: Vec<Pt> = pts_mm.iter().map(|p| to_sc(*p)).collect();
    let tol = tol_mm * SC;
    let mut result: Vec<Fit>;
    if tol.abs() > SCALED_EPSILON { result = do_arc_fitting(&points, tol); } else { result = vec![Fit { a: 0, b: points.len() - 1, arc: None }]; }
    if result.len() == 1 && result[0].arc.is_none() {
        points = douglas_peucker(&points, tol);
        result[0].b = points.len() - 1;
    } else {
        let mut simplified: Vec<Pt> = vec![points[0]];
        let mut reduce = vec![0usize; result.len()];
        for (i, f) in result.iter().enumerate() {
            let part: Vec<Pt> = points[f.a..=f.b].to_vec();
            let part = douglas_peucker(&part, tol);
            reduce[i] = f.b - f.a + 1 - part.len();
            for p in part.iter().skip(1) { simplified.push(*p); }
        }
        points = simplified;
        for j in 1..reduce.len() { reduce[j] += reduce[j - 1]; }
        for j in 0..result.len() {
            result[j].b -= reduce[j];
            if j != result.len() - 1 { let b = result[j].b; result[j + 1].a = b; }
        }
    }
    let out_pts: Vec<P2> = points.iter().map(|p| from_sc(*p)).collect();
    let segs = result.iter().map(|f| match f.arc {
        Some(a) => Seg::Arc { a: f.a, b: f.b, center: from_sc(a.c.c), ccw: a.ccw, length: a.length / SC },
        None => Seg::Line { a: f.a, b: f.b },
    }).collect();
    (out_pts, segs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circle_polyline_becomes_arcs() {
        // 40 points of a 5 mm radius circle arc over 270 degrees
        let pts: Vec<P2> = (0..=60).map(|i| { let a = 3.0 * i as f64 / 60.0 * std::f64::consts::FRAC_PI_2; [10.0 + 5.0 * a.cos(), 10.0 + 5.0 * a.sin()] }).collect();
        let (out, segs) = fit_and_simplify(&pts, 0.012);
        assert!(segs.iter().any(|s| matches!(s, Seg::Arc { .. })), "{:?}", segs.len());
        let arcs: Vec<&Seg> = segs.iter().filter(|s| matches!(s, Seg::Arc { .. })).collect();
        if let Seg::Arc { center, ccw, length, .. } = arcs[0] {
            assert!(*ccw);
            assert!((center[0] - 10.0).abs() < 0.01 && (center[1] - 10.0).abs() < 0.01, "{:?}", center);
            assert!((*length - 5.0 * 4.712).abs() < 0.3, "arc length {}", length);
        }
        assert!(out.len() <= pts.len());
    }

    #[test]
    fn straight_line_is_simplified() {
        let pts: Vec<P2> = (0..=20).map(|i| [i as f64 * 0.5, 0.0]).collect();
        let (out, segs) = fit_and_simplify(&pts, 0.012);
        assert_eq!(out.len(), 2);
        assert_eq!(segs, vec![Seg::Line { a: 0, b: 1 }]);
    }
}
