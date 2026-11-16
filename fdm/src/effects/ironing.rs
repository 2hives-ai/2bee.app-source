//! Ironing: port of `Layer::make_ironing` (Fill/Fill.cpp). Per layer, collect the surfaces to iron,
//! trim them by the ironing inset against the layer outline, fill them at `ironing_spacing` with a
//! monotonic rectilinear (or concentric) fill, and emit `Feature::Ironing` paths whose cross-section
//! is the tiny `layer_height * ironing_flow * spacing / nozzle` bead Orca extrudes.
//!
//! Config key mapping (Orca): ironing_type no ironing|top|topmost|solid, ironing_speed (mm/s),
//! ironing_flow (percent of layer height), ironing_spacing, ironing_inset (0 = nozzle/2),
//! ironing_angle (deg), ironing_angle_fixed, ironing_pattern rectilinear|concentric.
//! NOTE: the task brief's `ironing_direction` does not exist in Orca 2.5.0-dev; the equivalents are
//! `ironing_angle` + `ironing_angle_fixed`.
use super::adapter as g;
use super::patterns::{fill_surface, FillParams, SurfacePattern};
use crate::types::{ExtPath, Feature, PathPt, Polys};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IroningType { NoIroning, TopSurfaces, TopmostOnly, AllSolid }
impl IroningType {
    pub fn from_key(k: &str) -> Option<Self> {
        Some(match k { "no ironing" => Self::NoIroning, "top" => Self::TopSurfaces, "topmost" => Self::TopmostOnly, "solid" => Self::AllSolid, _ => return None })
    }
}

#[derive(Clone, Debug)]
pub struct IroningConfig {
    pub kind: IroningType,
    /// mm/s (ironing_speed).
    pub speed: f64,
    /// Percent, as the config stores it (10 for "10%").
    pub flow_percent: f64,
    pub spacing: f64,
    /// 0 = use nozzle_diameter / 2.
    pub inset: f64,
    pub angle_deg: f64,
    pub angle_fixed: bool,
    pub pattern: SurfacePattern,
    pub nozzle_diameter: f64,
    /// The OBJECT layer height (`layer_height`), not the current layer's.
    pub layer_height: f64,
    pub top_shell_layers: u32,
    pub bottom_shell_layers: u32,
    pub spiral_mode: bool,
    /// sparse_infill_density in percent (the "> 95% counts as solid" test of `iron_completely`).
    pub sparse_infill_density: f64,
}
impl Default for IroningConfig {
    /// X2D 0.20mm profile values (ironing itself off).
    fn default() -> Self {
        IroningConfig {
            kind: IroningType::NoIroning, speed: 30.0, flow_percent: 10.0, spacing: 0.15, inset: 0.21, angle_deg: 0.0, angle_fixed: false,
            pattern: SurfacePattern::Rectilinear, nozzle_diameter: 0.4, layer_height: 0.2, top_shell_layers: 5, bottom_shell_layers: 3,
            spiral_mode: false, sparse_infill_density: 15.0,
        }
    }
}

/// What the surface classifier (lane 3) knows about one layer region.
#[derive(Clone, Debug, Default)]
pub struct IroningRegion {
    /// Region slices of type stTop.
    pub top: Polys,
    /// Region slices of type stBottom (bridges excluded; they are never ironed).
    pub bottom: Polys,
    /// All region slices (used when the whole face is ironed).
    pub all: Polys,
    /// fill_surfaces of type stInternalSolid.
    pub internal_solid: Polys,
    /// True when fill_surfaces contain stInternal (with sparse density <= 95%), stInternalBridge or stInternalVoid.
    pub has_non_solid_fill: bool,
}

/// Per-layer inputs besides the regions.
#[derive(Clone, Debug)]
pub struct IroningLayer {
    pub layer_id: usize,
    /// No layer above (topmost layer of the object).
    pub is_topmost: bool,
    /// Layer outline (`Layer::lslices`).
    pub lslices: Polys,
    /// `calculate_infill_rotation_angle(solid_infill_direction ...)` or top_layer_direction, radians.
    pub top_layer_base_angle: f64,
    /// top_layer_direction set, or a rotate template given: the fill does not alternate per layer.
    pub direction_fixed: bool,
    /// Object bbox centre (object frame) for pattern alignment, and bbox for completeness.
    pub ref_point: [f64; 2],
    /// Object-frame mm. `ironing_angle += atan2(m10, m00)` when align_infill_direction_to_model is set; pass the rotation.
    pub model_rotation: f64,
}

/// Does `Layer::make_ironing` iron this region on this layer at all?
pub fn ironing_applies(c: &IroningConfig, layer: &IroningLayer) -> bool {
    c.kind != IroningType::NoIroning
        && (c.kind == IroningType::AllSolid
            || ((c.top_shell_layers > 0 || (c.spiral_mode && c.bottom_shell_layers > 1))
                && (c.kind == IroningType::TopSurfaces || (c.kind == IroningType::TopmostOnly && layer.is_topmost))))
}

/// Areas to iron on this layer (before filling): the union of the selected surfaces, trimmed by the inset.
pub fn ironing_areas(c: &IroningConfig, layer: &IroningLayer, regions: &[IroningRegion]) -> Polys {
    if !ironing_applies(c, layer) { return vec![]; }
    let iron_everything = c.kind == IroningType::AllSolid;
    let mut polys: Polys = vec![];
    let mut infills: Polys = vec![];
    for r in regions {
        let iron_completely = iron_everything && !r.has_non_solid_fill;
        if iron_completely {
            polys.extend(r.all.iter().cloned());
        } else {
            if c.top_shell_layers > 0 || c.spiral_mode { polys.extend(r.top.iter().cloned()); }
            if iron_everything && c.bottom_shell_layers > 0 { polys.extend(r.bottom.iter().cloned()); }
        }
        if iron_everything && !iron_completely { infills.extend(r.internal_solid.iter().cloned()); }
    }
    polys.extend(infills);
    if polys.is_empty() { return vec![]; }
    let polys = g::union(&polys, &vec![]);
    let inset = if c.inset == 0.0 { 0.5 * c.nozzle_diameter } else { c.inset };
    let inner = g::offset(&layer.lslices, -inset);
    g::intersect(&polys, &inner)
}

/// Orca `make_ironing`, one filler group: returns `Feature::Ironing` paths in print order.
pub fn make_ironing(c: &IroningConfig, layer: &IroningLayer, regions: &[IroningRegion]) -> Vec<ExtPath> {
    let areas = ironing_areas(c, layer, regions);
    if areas.is_empty() { return vec![]; }
    let angle = (if c.angle_fixed { 0.0 } else { layer.top_layer_base_angle }) + c.angle_deg * PI / 180.0 + layer.model_rotation;
    let height = c.layer_height * 0.01 * c.flow_percent;
    let extrusion_height = height * c.spacing / c.nozzle_diameter;
    let extrusion_width = c.nozzle_diameter + extrusion_height * (1.0 - 0.25 * PI); // Flow::rounded_rectangle_extrusion_width_from_spacing
    let fp = FillParams {
        spacing: c.spacing, density: 1.0, angle,
        layer_id: layer.layer_id, thickness_layers: 1,
        fixed_angle: c.angle_fixed || layer.direction_fixed,
        dont_alternate: false,
        dont_adjust: true,                 // FillParams default in make_ironing
        link_max_length: 3.0 * c.spacing,  // f->link_max_length = scale_(3 * spacing)
        anchor_length_max: 1000.0,
        ref_point: layer.ref_point,
        overlap: 0.0,
        ..FillParams::default()
    };
    // the Fill object is a monotonic FillRectilinear (params.monotonic = true) or FillConcentric
    let pat = match c.pattern { SurfacePattern::Concentric => SurfacePattern::Concentric, _ => SurfacePattern::Monotonic };
    let mut out = Vec::new();
    for ex in &areas {
        for o in fill_surface(&vec![ex.clone()], pat, &fp) {
            for pl in o.polylines {
                out.push(ExtPath {
                    feature: Feature::Ironing,
                    pts: pl.iter().map(|p| PathPt { x: p[0], y: p[1], w: extrusion_width }).collect(),
                    closed: false,
                    layer_h: extrusion_height,
                    speed: c.speed,
                    flow_ratio: 1.0,
                });
            }
        }
    }
    out
}

/// mm^3 of plastic per mm of ironing path (`nozzle * extrusion_height`), before any flow-ratio scaling.
pub fn ironing_mm3_per_mm(c: &IroningConfig) -> f64 { c.nozzle_diameter * (c.layer_height * 0.01 * c.flow_percent * c.spacing / c.nozzle_diameter) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    fn rect(cx: f64, cy: f64, hw: f64) -> Polys {
        vec![Poly { contour: vec![[cx - hw, cy - hw], [cx + hw, cy - hw], [cx + hw, cy + hw], [cx - hw, cy + hw]], holes: vec![] }]
    }
    fn cfg(kind: IroningType) -> IroningConfig { IroningConfig { kind, ..IroningConfig::default() } }
    fn layer(id: usize, topmost: bool, full: &Polys) -> IroningLayer {
        IroningLayer { layer_id: id, is_topmost: topmost, lslices: full.clone(), top_layer_base_angle: std::f64::consts::PI / 4.0, direction_fixed: false, ref_point: [0.0, 0.0], model_rotation: 0.0 }
    }
    fn top_region(full: &Polys) -> IroningRegion {
        IroningRegion { top: full.clone(), bottom: vec![], all: full.clone(), internal_solid: vec![], has_non_solid_fill: true }
    }
    fn plen(p: &ExtPath) -> f64 { p.pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum() }

    /// Measured on OrcaSlicer 2.5.0-dev: 20 mm cube, ironing_type=top, layer 99 (the only ironed layer):
    /// ONE path, 369 points, 2555.79 mm, flow 0.4 * 0.0075 mm^3/mm, F1800 (30 mm/s).
    #[test]
    fn cube_top_matches_orca() {
        let full = rect(0.0, 0.0, 10.0);
        let out = make_ironing(&cfg(IroningType::TopSurfaces), &layer(99, true, &full), &[top_region(&full)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pts.len(), 369);
        assert!((plen(&out[0]) - 2555.79).abs() < 0.5, "{}", plen(&out[0]));
        assert_eq!(out[0].feature, Feature::Ironing);
        assert!((out[0].layer_h - 0.0075).abs() < 1e-9);
        assert!((out[0].pts[0].w - 0.40161).abs() < 1e-4);
        assert!((out[0].speed - 30.0).abs() < 1e-12);
        // cross-section the G-code lane will derive: (w - h(1-pi/4)) * h == nozzle * h
        let x = (out[0].pts[0].w - out[0].layer_h * (1.0 - PI / 4.0)) * out[0].layer_h;
        assert!((x - 0.003).abs() < 1e-9 && (ironing_mm3_per_mm(&cfg(IroningType::TopSurfaces)) - 0.003).abs() < 1e-12);
    }
    /// The same measured quantity in extrusion terms: Orca's G-code extrudes 3.03 mm of 1.75 mm filament for those 2555.79 mm.
    #[test]
    fn extruded_volume_matches_orca_filament_length() {
        let full = rect(0.0, 0.0, 10.0);
        let out = make_ironing(&cfg(IroningType::TopSurfaces), &layer(99, true, &full), &[top_region(&full)]);
        let vol = plen(&out[0]) * 0.003;
        let filament_mm = vol / (PI / 4.0 * 1.75 * 1.75);
        assert!((filament_mm - 3.03).abs() / 3.03 < 0.06, "{filament_mm}"); // Orca also applies the filament flow ratio
    }
    #[test]
    fn selection_rules() {
        let full = rect(0.0, 0.0, 10.0);
        let l_top = layer(99, true, &full);
        let l_mid = layer(50, false, &full);
        assert!(!ironing_applies(&cfg(IroningType::NoIroning), &l_top));
        assert!(ironing_applies(&cfg(IroningType::TopSurfaces), &l_mid));
        assert!(!ironing_applies(&cfg(IroningType::TopmostOnly), &l_mid));
        assert!(ironing_applies(&cfg(IroningType::TopmostOnly), &l_top));
        assert!(ironing_applies(&cfg(IroningType::AllSolid), &l_mid));
        // top_shell_layers == 0 disables top/topmost ironing unless spiral mode with >1 bottom layers
        let c0 = IroningConfig { top_shell_layers: 0, ..cfg(IroningType::TopSurfaces) };
        assert!(!ironing_applies(&c0, &l_mid));
        assert!(ironing_applies(&IroningConfig { spiral_mode: true, bottom_shell_layers: 3, ..c0.clone() }, &l_mid));
        assert!(!ironing_applies(&IroningConfig { spiral_mode: true, bottom_shell_layers: 1, ..c0 }, &l_mid));
        // negative control: no ironing type => nothing produced even with a top surface present
        assert!(make_ironing(&cfg(IroningType::NoIroning), &l_top, &[top_region(&full)]).is_empty());
        assert!(make_ironing(&cfg(IroningType::TopmostOnly), &l_mid, &[top_region(&full)]).is_empty());
    }
    #[test]
    fn inset_trims_the_ironed_area_and_zero_means_half_nozzle() {
        let full = rect(0.0, 0.0, 10.0);
        let r = top_region(&full);
        let a = ironing_areas(&cfg(IroningType::TopSurfaces), &layer(10, false, &full), &[r.clone()]);
        let bb = g::bbox(&a).unwrap();
        assert!((bb[2] - 9.79).abs() < 1e-6, "{bb:?}");
        let c0 = IroningConfig { inset: 0.0, ..cfg(IroningType::TopSurfaces) };
        let a0 = ironing_areas(&c0, &layer(10, false, &full), &[r]);
        assert!((g::bbox(&a0).unwrap()[2] - 9.8).abs() < 1e-6);
    }
    #[test]
    fn all_solid_irons_everything_only_when_nothing_is_sparse() {
        let full = rect(0.0, 0.0, 10.0);
        let all_solid = IroningRegion { top: vec![], bottom: vec![], all: full.clone(), internal_solid: vec![], has_non_solid_fill: false };
        assert!(g::area(&ironing_areas(&cfg(IroningType::AllSolid), &layer(10, false, &full), &[all_solid])) > 380.0);
        // with sparse infill present only top (+bottom) surfaces and the internal-solid patches are ironed
        let patch = rect(0.0, 0.0, 3.0);
        let sparse = IroningRegion { top: vec![], bottom: vec![], all: full.clone(), internal_solid: patch.clone(), has_non_solid_fill: true };
        let a = g::area(&ironing_areas(&cfg(IroningType::AllSolid), &layer(10, false, &full), &[sparse]));
        assert!((a - 36.0).abs() < 0.5, "{a}");
    }
    #[test]
    fn angle_alternates_per_layer_unless_fixed() {
        let full = rect(0.0, 0.0, 10.0);
        let first_dir = |l: &IroningLayer, c: &IroningConfig| -> f64 {
            let o = make_ironing(c, l, &[top_region(&full)]);
            let (a, b) = (&o[0].pts[0], &o[0].pts[1]);
            ((b.y - a.y).atan2(b.x - a.x)).rem_euclid(PI)
        };
        let c = cfg(IroningType::TopSurfaces);
        let (even, odd) = (first_dir(&layer(10, false, &full), &c), first_dir(&layer(11, false, &full), &c));
        assert!((even - odd).abs() > 0.5, "layers must differ: {even} {odd}");
        let fixed = IroningConfig { angle_fixed: true, ..c };
        assert!((first_dir(&layer(10, false, &full), &fixed) - first_dir(&layer(11, false, &full), &fixed)).abs() < 1e-6 || ((first_dir(&layer(10, false, &full), &fixed) - first_dir(&layer(11, false, &full), &fixed)).abs() - PI).abs() < 1e-6);
    }
    #[test]
    fn concentric_pattern_produces_nested_loops() {
        let full = rect(0.0, 0.0, 10.0);
        let c = IroningConfig { pattern: SurfacePattern::Concentric, ..cfg(IroningType::TopSurfaces) };
        let o = make_ironing(&c, &layer(10, false, &full), &[top_region(&full)]);
        assert!(o.len() > 20, "{}", o.len());
    }
    #[test]
    fn config_key_parsing() {
        assert_eq!(IroningType::from_key("no ironing"), Some(IroningType::NoIroning));
        assert_eq!(IroningType::from_key("top"), Some(IroningType::TopSurfaces));
        assert_eq!(IroningType::from_key("topmost"), Some(IroningType::TopmostOnly));
        assert_eq!(IroningType::from_key("solid"), Some(IroningType::AllSolid));
        assert_eq!(IroningType::from_key("top surface"), None); // the label, not the key: easy to get wrong
    }
}
