//! `PrintObject::combine_infill` (infill_combination): print sparse infill every N layers with N times the
//! thickness where the region is internal on all N layers. This module does the layer bookkeeping and the
//! region arithmetic; the pipeline calls `fill_sparse` with `thickness_layers = n`, `layer_h = thickness`.
use super::gx;
use super::Pattern;
use crate::types::Polys;

const EPSILON: f64 = 1e-4;

/// `combine[layer_idx]` = number of layers merged into layer `layer_idx` (<= 1: nothing). `layer_heights` is the
/// height of every object layer (layer 0 first). `nozzle_diameter` is the smaller nozzle of the sparse / solid
/// infill extruders; `max_layer_height` is `infill_combination_max_layer_height` already resolved to mm
/// (0 or negative = no extra limit).
pub fn combine_plan(layer_heights: &[f64], nozzle_diameter: f64, max_layer_height: f64) -> Vec<usize> {
    let n = layer_heights.len();
    let mut combine = vec![0usize; n];
    if n == 0 { return combine; }
    let limit = if max_layer_height > 0.0 { max_layer_height.min(nozzle_diameter) } else { nozzle_diameter };
    let mut current = 0.0;
    let mut num = 0usize;
    for (idx, &h) in layer_heights.iter().enumerate() {
        if idx == 0 { continue; } // first print layer is skipped
        if current + h >= limit + EPSILON {
            combine[idx - 1] = num;
            current = 0.0;
            num = 0;
        }
        current += h;
        num += 1;
    }
    combine[n - 1] = num;
    combine
}

/// Clearance by which the combined region is grown before it is removed from the single layers:
/// half the perimeter width plus (1.5 or 0.5) solid-infill widths, depending on the pattern.
pub fn combine_clearance(perimeter_width: f64, solid_infill_width: f64, pattern: Pattern) -> f64 {
    let grown = matches!(pattern, Pattern::Rectilinear | Pattern::Grid | Pattern::LateralLattice | Pattern::Line | Pattern::Honeycomb | Pattern::LateralHoneycomb);
    0.5 * perimeter_width + (if grown { 1.5 } else { 0.5 }) * solid_infill_width
}

#[derive(Clone, Debug, Default)]
pub struct CombinedLayer {
    /// Remaining single-layer sparse infill of this layer.
    pub sparse: Polys,
    /// Region of this layer that is covered by a combined fill printed on a higher layer (`stInternalVoid`).
    pub void: Polys,
    /// Combined infill printed on this layer: region, merged layer count, total thickness (mm).
    pub combined: Option<(Polys, usize, f64)>,
}

/// Apply the combination plan. `sparse[i]` is layer i's internal (sparse) region. `area_threshold` is
/// `infill_area_threshold` (mm^2) of the lowest layer of a group (regions not larger are dropped).
pub fn combine_infill(sparse: &[Polys], layer_heights: &[f64], plan: &[usize], clearance: f64, area_threshold: f64) -> Vec<CombinedLayer> {
    let mut out: Vec<CombinedLayer> = sparse.iter().map(|s| CombinedLayer { sparse: s.clone(), void: Polys::new(), combined: None }).collect();
    for idx in 0..sparse.len() {
        let n = plan.get(idx).copied().unwrap_or(0);
        if n <= 1 { continue; }
        let first = idx + 1 - n;
        let mut inter = sparse[first].clone();
        for i in first + 1..=idx { inter = gx::inter(&sparse[i], &inter); }
        if area_threshold > 0.0 { inter.retain(|p| gx::poly_area(p) > area_threshold); }
        if inter.is_empty() { continue; }
        let clear = gx::offset(&inter, clearance);
        for i in first..=idx {
            let internal = out[i].sparse.clone();
            out[i].sparse = gx::diff(&internal, &clear);
            if i == idx {
                let thickness: f64 = layer_heights[first..=idx].iter().sum();
                out[i].combined = Some((inter.clone(), n, thickness));
            } else {
                out[i].void = gx::inter(&internal, &clear);
            }
        }
    }
    out
}
