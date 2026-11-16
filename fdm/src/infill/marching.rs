//! Port of libslic3r `MarchingSquares.hpp` (the Prusa-derived coarse grid + per-edge bisection variant)
//! plus `Polyline::simplify` (Douglas-Peucker). Used by TPMS-FK and the "optimized" gyroid.
use super::gx::P;

const RSIZE_NM: i64 = 4000; // 0.004 mm raster pixel
const WINDOW: i64 = 100; // 0.4 mm cell

pub struct Field<'a> {
    pub offs_nm: [i64; 2],
    pub size_nm: [i64; 2],
    /// field value at (x mm, y mm)
    pub f: &'a dyn Fn(f64, f64) -> f32,
}
impl Field<'_> {
    fn rows(&self) -> i64 { self.size_nm[1] / RSIZE_NM }
    fn cols(&self) -> i64 { self.size_nm[0] / RSIZE_NM }
    fn val(&self, r: i64, c: i64) -> f32 {
        let x = (c * RSIZE_NM + self.offs_nm[0]) as f64 * 1e-6;
        let y = (r * RSIZE_NM + self.offs_nm[1]) as f64 * 1e-6;
        (self.f)(x, y)
    }
}

const LEFT: u8 = 1;
const DOWN: u8 = 2;
const RIGHT: u8 = 4;
const UP: u8 = 8;

fn next_ccw(cbda: u32) -> u8 {
    let dcba = (cbda & 1) | ((cbda >> 1) & 0b0110) | ((cbda << 2) & 0b1000);
    let adcb = (dcba >> 1) | ((dcba << 3) & 0b1000);
    ((!dcba) & adcb & 0xf) as u8
}

/// Closed rings of the iso-contour as polylines in mm (first point repeated at the end), before simplification.
pub fn contour_polylines(fld: &Field, iso: f32) -> Vec<Vec<P>> {
    let (rows, cols) = (fld.rows(), fld.cols());
    if rows <= 0 || cols <= 0 { return Vec::new(); }
    let (gr, gc) = (2 + rows / WINDOW, 2 + cols / WINDOW);
    let glen = (gr * gc) as usize;
    let mut tags = vec![false; glen];
    for r in 0..gr {
        for c in 0..gc {
            let (pr, pc) = ((r - 1) * WINDOW, (c - 1) * WINDOW);
            if pr >= 0 && pr < rows && pc >= 0 && pc < cols && fld.val(pr, pc) > iso { tags[(r * gc + c) as usize] = true; }
        }
    }
    let tag = |r: i64, c: i64| -> bool { if r < 0 || c < 0 || r >= gr || c >= gc { false } else { tags[(r * gc + c) as usize] } };
    let mut dirs = vec![0u8; glen];
    for r in 0..gr {
        for c in 0..gc {
            let (a, d, b, cc) = (tag(r, c) as u32, tag(r, c + 1) as u32, tag(r + 1, c) as u32, tag(r + 1, c + 1) as u32);
            // wrap-around of the last column reads the next row's border (always clear)
            let cbda = a | (d << 1) | (b << 2) | (cc << 3);
            if cbda != 0 && cbda != 0xf { dirs[(r * gc + c) as usize] = next_ccw(cbda); }
        }
    }
    let next_dir = |dirs: &Vec<u8>, idx: usize, prev: u8| -> u8 {
        let n = dirs[idx];
        match n {
            x if x == LEFT | RIGHT => if prev == UP { LEFT } else { RIGHT },
            x if x == UP | DOWN => if prev == RIGHT { UP } else { DOWN },
            x => x,
        }
    };
    let step = |idx: usize, d: u8| -> usize {
        match d { LEFT => idx - 1, DOWN => idx + gc as usize, RIGHT => idx + 1, UP => idx - gc as usize, _ => idx }
    };
    let mut rings: Vec<Vec<(usize, u8)>> = Vec::new();
    let mut start = 0usize;
    loop {
        while start < glen && dirs[start] == 0 { start += 1; }
        if start >= glen { break; }
        let mut ring = Vec::new();
        let mut idx = start;
        let mut next = next_dir(&dirs, idx, 0xf);
        loop {
            if next == 0 { break; }
            ring.push((idx, next));
            dirs[idx] &= !next;
            idx = step(idx, next);
            next = next_dir(&dirs, idx, next);
            if idx == start { break; }
        }
        if ring.len() > 1 { rings.push(ring); }
    }
    // interpolate every ring vertex along its cell edge
    let to_mm = |r: i64, c: i64| -> P { [(c * RSIZE_NM + fld.offs_nm[0]) as f64 * 1e-6, (r * RSIZE_NM + fld.offs_nm[1]) as f64 * 1e-6] };
    let mut out = Vec::new();
    for ring in rings {
        let mut pl: Vec<P> = Vec::with_capacity(ring.len() + 1);
        for (idx, d) in ring {
            let (cr, cc) = ((idx as i64) / gc, (idx as i64) % gc);
            let (tlr, tlc) = ((cr - 1) * WINDOW, (cc - 1) * WINDOW);
            // edge from -> to (+1 step), walking direction
            let (from, step_dir, to): ((i64, i64), (i64, i64), (i64, i64)) = match d {
                LEFT => ((tlr, tlc), (1, 0), (tlr + WINDOW, tlc)),
                DOWN => ((tlr + WINDOW, tlc), (0, 1), (tlr + WINDOW, tlc + WINDOW)),
                RIGHT => ((tlr + WINDOW, tlc + WINDOW), (-1, 0), (tlr, tlc + WINDOW)),
                _ => ((tlr, tlc + WINDOW), (0, -1), (tlr, tlc)),
            };
            let to = (to.0 + step_dir.0, to.1 + step_dir.1);
            let from_c = (from.0.clamp(0, rows - 1), from.1.clamp(0, cols - 1));
            let to_c = (to.0.clamp(0, rows), to.1.clamp(0, cols));
            let n = ((to_c.0 - from_c.0) * step_dir.0 + (to_c.1 - from_c.1) * step_dir.1).max(0);
            let (mut first, mut len) = (0i64, n);
            while len > 0 {
                let half = len >> 1;
                let mid = first + half;
                let (r, c) = (from_c.0 + step_dir.0 * mid, from_c.1 + step_dir.1 * mid);
                if fld.val(r.clamp(0, rows - 1), c.clamp(0, cols - 1)) < iso { first = mid + 1; len -= half + 1; } else { len = half; }
            }
            let (mut r, mut c) = (from_c.0 + step_dir.0 * first, from_c.1 + step_dir.1 * first);
            if step_dir == (-1, 0) { r += 1; } else if step_dir == (0, -1) { c += 1; }
            pl.push(to_mm(r, c));
        }
        let f0 = pl[0];
        pl.push(f0);
        out.push(pl);
    }
    out
}

/// `Polyline::simplify` / `MultiPoint::douglas_peucker` (tolerance in mm).
pub fn simplify(pts: &[P], tolerance: f64) -> Vec<P> {
    if pts.is_empty() { return Vec::new(); }
    let tol2 = tolerance * tolerance;
    let dist2_seg = |p: P, a: P, b: P| -> f64 {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        let t = if l2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) };
        (p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)
    };
    let mut res = vec![pts[0]];
    let (mut anchor, mut floater) = (0usize, pts.len() - 1);
    if anchor != floater {
        let mut stack = vec![floater];
        loop {
            let (mut maxd, mut far) = (0.0f64, anchor);
            for i in anchor + 1..floater {
                let d = dist2_seg(pts[i], pts[anchor], pts[floater]);
                if d > maxd { maxd = d; far = i; }
            }
            if maxd <= tol2 {
                res.push(pts[floater]);
                anchor = floater;
                stack.pop();
                if stack.is_empty() { break; }
                floater = *stack.last().unwrap();
            } else {
                floater = far;
                stack.push(floater);
            }
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn circle_field_gives_a_closed_ring_of_the_right_radius() {
        let f = |x: f64, y: f64| (25.0 - ((x - 10.0).powi(2) + (y - 10.0).powi(2))) as f32; // > 0 inside r = 5
        let fld = Field { offs_nm: [0, 0], size_nm: [20_000_000, 20_000_000], f: &f };
        let rings = contour_polylines(&fld, 0.0);
        assert_eq!(rings.len(), 1);
        let r = &rings[0];
        assert_eq!(r.first(), r.last(), "a ring is closed");
        for p in r { let d = ((p[0] - 10.0).powi(2) + (p[1] - 10.0).powi(2)).sqrt(); assert!((d - 5.0).abs() < 0.2, "{d}"); }
        let s = simplify(r, 0.04);
        assert!(s.len() < r.len() || r.len() < 100);
    }
    #[test]
    fn douglas_peucker_keeps_corners_drops_collinear() {
        let pts = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [2.0, 2.0]];
        let s = simplify(&pts, 0.01);
        assert_eq!(s, vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0]]);
    }
}
