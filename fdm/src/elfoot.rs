//! Elephant foot compensation (Orca `PrintObject::slice_volumes` + `ElephantFootCompensation.cpp`).
//!
//! Until 2026-11-12 `elefant_foot_compensation` was read by nobody: the X2D 0.20 mm Standard preset sets 0.15 and the
//! G-code with 0 and with 0.15 was byte-identical, so every first layer printed 0.15 mm per side wider than the preset
//! intends, while the CONFIG_BLOCK said 0.15. Found by the 2026-11-12 slicer review.
//!
//! What Orca does (source read, not run; `PrintObjectSlice.cpp`, main):
//!   * only when `raft_layers == 0`;
//!   * layer k < N = `elefant_foot_compensation_layers` gets `S - (S / N) * k` (layer N-1 gets S/N, then 0);
//!   * per ExPolygon, `min_contour_width = ext_perimeter.width + ext_perimeter.spacing` (first-layer flow);
//!     a contour whose bbox side is under `min + 2c`, or whose area is under `(min + 2c)^2 * 5`, is left as is;
//!     a place narrower than `min` gets no inset, a place wider than `min + 2c` gets the full `c`;
//!   * if the offset does not give exactly one polygon, the input is returned unchanged;
//!   * the UNcompensated outline stays the layer's `lslices` (used for travel, neighbours); the compensated one is
//!     what the perimeters are generated from.
//!
//! ⚠ DIVERGENCE (named, not hidden): between `min` and `min + 2c` Orca insets by `(d - min) / 2` from a per-vertex
//! width estimate and smooths it (`variable_offset_inner_ex`); here that band gets the full `c`, and narrow parts are
//! found by a morphological opening rather than per-vertex distances. Effect: at most `c` (0.15 mm) more inset in a
//! band of width `2c` around narrow features, on the compensated layers only.
use crate::geom;
use crate::types::{Poly, Polys};

fn bbox(p: &Poly) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for q in &p.contour { b[0] = b[0].min(q[0]); b[1] = b[1].min(q[1]); b[2] = b[2].max(q[0]); b[3] = b[3].max(q[1]); }
    b
}

/// Orca's per-layer amount: `S - (S / N) * k` for `k < N`, else 0. `raft_layers > 0` turns it off.
pub fn amount(s: f64, n_layers: usize, layer: usize, raft_layers: usize) -> f64 {
    if raft_layers > 0 || s <= 0.0 || n_layers == 0 || layer >= n_layers { return 0.0; }
    s - (s / n_layers as f64) * layer as f64
}

/// One ExPolygon, compensated by `c` (mm) with `min_w` = external perimeter width + spacing.
pub fn compensate_poly(p: &Poly, min_w: f64, c: f64) -> Poly {
    if c <= 0.0 { return p.clone(); }
    let minc = min_w + 2.0 * c;
    let b = bbox(p);
    let one: Polys = vec![p.clone()];
    if b[2] - b[0] < minc || b[3] - b[1] < minc || geom::area(&one) < minc * minc * 5.0 { return p.clone(); }
    let wide = geom::inset(&one, c);
    // a narrow part is a real feature only above a small area: an opening leaves corner slivers on a polygonised curve
    // (160 of them on the saucer disc), and keeping those made the result many polygons, so the whole layer bailed out
    let narrow = geom::clean(&geom::diff(&one, &geom::opening(&one, 0.5 * min_w)), 0.25 * min_w * min_w);
    let out = geom::intersect(&geom::union(&wide, &narrow), &one);
    if out.len() == 1 { out.into_iter().next().unwrap() } else { p.clone() }
}

pub fn compensate(region: &Polys, min_w: f64, c: f64) -> Polys {
    if c <= 0.0 { return region.clone(); }
    region.iter().map(|p| compensate_poly(p, min_w, c)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Poly { Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] } }
    fn bb(r: &Polys) -> [f64; 4] { let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN]; for p in r { let q = bbox(p); b = [b[0].min(q[0]), b[1].min(q[1]), b[2].max(q[2]), b[3].max(q[3])]; } b }

    #[test]
    fn orca_taper() {
        assert_eq!(amount(0.15, 1, 0, 0), 0.15);
        assert_eq!(amount(0.15, 1, 1, 0), 0.0);
        assert!((amount(0.3, 3, 2, 0) - 0.1).abs() < 1e-12, "layer N-1 gets S/N, not 0");
        assert_eq!(amount(0.15, 1, 0, 2), 0.0, "a raft turns it off");
    }

    #[test]
    fn a_20mm_square_shrinks_by_c_each_side() {
        let out = compensate(&vec![rect(0.0, 0.0, 20.0, 20.0)], 0.83, 0.15);
        let b = bb(&out);
        for (got, want) in b.iter().zip([0.15, 0.15, 19.85, 19.85]) { assert!((got - want).abs() < 1e-3, "{b:?}"); }
    }

    #[test]
    fn a_thin_rib_is_not_eaten() {
        // a 20 x 20 plate with a 0.6 mm x 10 mm rib: the rib is narrower than min_w and must keep its width
        let plate = rect(0.0, 0.0, 20.0, 20.0);
        let rib = rect(20.0, 9.7, 30.0, 10.3);
        let region = geom::union(&vec![plate], &vec![rib]);
        let out = compensate(&region, 0.83, 0.15);
        assert_eq!(out.len(), 1);
        let b = bb(&out);
        assert!((b[2] - 30.0).abs() < 0.2, "rib end kept (x max {})", b[2]);
        let rib_area = geom::area(&geom::intersect(&out, &vec![rect(22.0, 0.0, 28.0, 20.0)]));
        assert!((rib_area - 6.0 * 0.6).abs() < 0.05, "rib width kept: area {rib_area}");
    }

    #[test]
    fn a_polygonised_disc_is_compensated_not_bailed_out() {
        // the saucer base: a 160-gon of d 139.8; before the sliver filter this returned the input unchanged
        let ring: Vec<[f64; 2]> = (0..160).map(|i| { let a = i as f64 * std::f64::consts::TAU / 160.0; [69.9 * a.cos(), 69.9 * a.sin()] }).collect();
        let p = Poly { contour: ring, holes: vec![] };
        let out = compensate_poly(&p, 0.83, 0.15);
        let b = bbox(&out);
        assert!((b[2] - b[0] - (2.0 * 69.9 - 0.3)).abs() < 0.02, "width {}", b[2] - b[0]);
    }

    #[test]
    fn a_tiny_contour_is_left_alone() {
        let p = rect(0.0, 0.0, 1.0, 1.0);
        assert_eq!(compensate_poly(&p, 0.83, 0.15), p);
    }

    #[test]
    fn plant_zero_compensation_changes_nothing() {
        let r = vec![rect(0.0, 0.0, 20.0, 20.0)];
        assert_eq!(compensate(&r, 0.83, 0.0), r);
    }
}
