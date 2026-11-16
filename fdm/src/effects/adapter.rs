//! Thin adapter over the shared geometry kernel (`crate::geom`, lane 1: i_overlay 9.x, mm / f64, contours
//! CCW, holes CW). Everything in the effects lane goes through here, so swapping the kernel is a one-file change.
use crate::geom;
use crate::types::{Poly, Polys};

pub type Pt = [f64; 2];

pub use geom::{area, bbox, diff, intersect, offset, polyline_len, ring_area, union};

/// Point inside the region (contour and not in a hole); boundary points unspecified.
pub fn contains(p: &Polys, x: f64, y: f64) -> bool { geom::point_in_polys(p, x, y) }

/// Rotate every ring counter-clockwise by `ang` radians about the origin (Orca rotates about (0,0)).
pub fn rotate_polys(p: &Polys, ang: f64) -> Polys {
    let (s, c) = ang.sin_cos();
    let rot = |r: &Vec<Pt>| -> Vec<Pt> { r.iter().map(|v| [v[0] * c - v[1] * s, v[0] * s + v[1] * c]).collect() };
    p.iter().map(|q| Poly { contour: rot(&q.contour), holes: q.holes.iter().map(rot).collect() }).collect()
}
