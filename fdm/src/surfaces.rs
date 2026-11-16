//! Lane 3: top / bottom / internal-solid / bridge / internal-bridge classification and the fill
//! paths of the solid surfaces, plus overhang-wall splitting.
//!
//! Spec: OrcaSlicer 2.5.0-dev `PrintObject::prepare_infill()` and what it calls --
//! `detect_surfaces_type`, `prepare_fill_surfaces`, `discover_vertical_shells`,
//! `discover_horizontal_shells`, `process_external_surfaces` (`LayerRegion`), `bridge_over_infill`;
//! `Layer::make_fills` / `group_fills` for the surface -> fill parameter mapping; `FillRectilinear`
//! (monotonic, monotonic-line) for the line fill; `PerimeterGenerator` for the overhang split.
//!
//! One printing region (no multi-material / modifier regions). Anything the lane does not implement is
//! refused with `FdmError::Unsupported` instead of being approximated (see `SurfaceCfg::from_config`).
//!
//! Pipeline order (what the lead wires):
//! 1. walls lane -> per layer `fill` region (`LayerGeom::fill`)
//! 2. `classify()` -> `Classified` (typed fill surfaces per layer)
//! 3. infill lane fills `Classified::sparse(layer)`; `fill_layer()` extrudes everything solid
//! 4. `split_overhang_walls()` retypes the wall paths of a layer
use crate::config::Config;
use crate::types::*;

mod bridge_infill;
mod detect;
mod external;
mod fill;
mod flow;
mod narrow;
mod ops;
mod overhang;

pub use flow::Flow;
pub use overhang::split_overhang_walls;

use ops::{Pt, EPS};

/// Deterministic ordered parallel map over independent per-layer work (`slice::par_map`: `out[i] == f(i, &items[i])`
/// whatever the thread count, `FDM_THREADS=1` runs it serially).
pub(crate) fn pmap<T: Sync, R: Send>(items: &[T], f: impl Fn(usize, &T) -> R + Sync) -> Vec<R> {
    crate::slice::par_map(items, crate::slice::default_threads(), f)
}

type Res<T> = Result<T, FdmError>;
fn unsupported<T>(s: impl Into<String>) -> Res<T> { Err(FdmError::Unsupported(s.into())) }

// ================================================================================================ types
/// Orca `SurfaceType` restricted to what survives into the fill stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SurfaceType { Top, Bottom, BottomBridge, Internal, InternalSolid, InternalBridge }

impl SurfaceType {
    pub fn is_top(self) -> bool { self == SurfaceType::Top }
    pub fn is_bottom(self) -> bool { matches!(self, SurfaceType::Bottom | SurfaceType::BottomBridge) }
    pub fn is_bridge(self) -> bool { matches!(self, SurfaceType::BottomBridge | SurfaceType::InternalBridge) }
    pub fn is_external(self) -> bool { self.is_top() || self.is_bottom() }
    pub fn is_solid(self) -> bool { self.is_external() || matches!(self, SurfaceType::InternalSolid | SurfaceType::InternalBridge) }
}

/// One surface = one island (`ExPolygon`) of one type. `bridge_angle` in radians, `< 0` = none.
#[derive(Clone, Debug)]
pub struct Surface { pub ty: SurfaceType, pub poly: Poly, pub bridge_angle: f64 }

impl Surface {
    pub fn new(ty: SurfaceType, poly: Poly) -> Surface { Surface { ty, poly, bridge_angle: -1.0 } }
}

/// Per-layer input from the walls lane.
#[derive(Clone, Debug, Default)]
pub struct LayerGeom {
    /// Top of the layer (mm) and its thickness.
    pub z: f64,
    pub h: f64,
    /// The sliced layer region (Orca `lslices`).
    pub slice: Polys,
    /// Area the walls leave to infill (`LayerRegion::fill_expolygons`); on layers with a top surface it already
    /// contains the wall-free top area (`only_one_wall_top`, `top_bottom_infill_wall_overlap`).
    pub fill: Polys,
    /// `LayerRegion::fill_no_overlap_expolygons` (reserved for gap fill; may be empty).
    pub fill_no_overlap: Polys,
}

/// Sparse infill polylines of one layer as the infill lane would extrude them (Orca
/// `Layer::generate_sparse_infill_polylines_for_anchoring`). Used for the internal bridge direction and anchors.
pub trait SparseLines {
    /// Polylines of the sparse infill of `layer` inside `region` (its `Internal` surfaces at that moment).
    fn lines(&self, layer: usize, region: &Polys) -> Vec<Vec<Pt>>;
}

/// Closure adapter: `SparseFn(|layer, region| ...)` implements `SparseLines`.
pub struct SparseFn<F: Fn(usize, &Polys) -> Vec<Vec<Pt>>>(pub F);
impl<F: Fn(usize, &Polys) -> Vec<Vec<Pt>>> SparseLines for SparseFn<F> {
    fn lines(&self, layer: usize, region: &Polys) -> Vec<Vec<Pt>> { (self.0)(layer, region) }
}

/// Result of `classify`.
#[derive(Clone, Debug, Default)]
pub struct Classified {
    /// Typed slices (whole layer region, including the wall band): what Orca keeps in `LayerRegion::slices`.
    pub slices: Vec<Vec<Surface>>,
    /// Typed fill surfaces (inside `LayerGeom::fill`): `LayerRegion::fill_surfaces`.
    pub fill: Vec<Vec<Surface>>,
}

impl Classified {
    pub fn layer_count(&self) -> usize { self.fill.len() }
    /// Union of the fill surfaces of the given types.
    pub fn region(&self, layer: usize, tys: &[SurfaceType]) -> Polys {
        ops::un_all(&[&self.fill[layer].iter().filter(|s| tys.contains(&s.ty)).map(|s| s.poly.clone()).collect::<Polys>()])
    }
    /// Area the infill lane fills with its sparse pattern on `layer`.
    pub fn sparse(&self, layer: usize) -> Polys { self.region(layer, &[SurfaceType::Internal]) }
    /// Whole-layer slice area that is exposed from above (the walls lane needs this for `only_one_wall_top`).
    pub fn top_slice(&self, layer: usize) -> Polys {
        ops::un_all(&[&self.slices[layer].iter().filter(|s| s.ty == SurfaceType::Top).map(|s| s.poly.clone()).collect::<Polys>()])
    }
}

// ================================================================================================ config
/// Solid-surface fill pattern. Only the line patterns Orca's top / bottom / solid fills use by default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolidPattern { Rectilinear, Monotonic, MonotonicLine }

fn parse_pattern(key: &str, v: &str) -> Res<SolidPattern> {
    match v {
        "rectilinear" => Ok(SolidPattern::Rectilinear),
        "monotonic" => Ok(SolidPattern::Monotonic),
        "monotonicline" => Ok(SolidPattern::MonotonicLine),
        o => unsupported(format!("{key} = '{o}': only rectilinear / monotonic / monotonicline are implemented")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnsureVertical { All, CriticalOnly, None }

/// Every setting the lane reads, resolved to numbers.
#[derive(Clone, Debug)]
pub struct SurfaceCfg {
    pub nozzle: f64,
    pub layer_height: f64,
    pub initial_layer_height: f64,
    // line widths (mm, resolved against the nozzle)
    pub w_initial: f64,
    pub w_outer: f64,
    pub w_inner: f64,
    pub w_solid: f64,
    pub w_top: f64,
    pub w_sparse: f64,
    pub w_bridge: f64,
    pub wall_loops: usize,
    pub top_shell_layers: usize,
    pub bottom_shell_layers: usize,
    pub top_shell_thickness: f64,
    pub bottom_shell_thickness: f64,
    pub ensure_vertical: EnsureVertical,
    /// 0..1
    pub sparse_density: f64,
    pub min_sparse_area: f64,
    pub extra_solid_infills: String,
    pub top_pattern: SolidPattern,
    pub bottom_pattern: SolidPattern,
    pub solid_pattern: SolidPattern,
    pub top_density: f64,
    pub bottom_density: f64,
    /// radians
    pub solid_direction: f64,
    /// radians, `None` = not fixed
    pub top_layer_direction: Option<f64>,
    pub bottom_layer_direction: Option<f64>,
    pub bridge_angle: f64,
    pub relative_bridge_angle: bool,
    pub internal_bridge_angle: f64,
    pub bridge_density: f64,
    pub internal_bridge_density: f64,
    pub bridge_flow: f64,
    pub thick_bridges: bool,
    pub thick_internal_bridges: bool,
    pub detect_narrow_internal_solid: bool,
    pub elefant_foot_density: f64,
    pub elefant_foot_layers: usize,
    pub infill_wall_overlap: f64,
    pub top_bottom_infill_wall_overlap: f64,
    pub detect_overhang_wall: bool,
    pub overhang_flow_ratio: f64,
    /// `seam_gap` resolved against the nozzle (mm): concentric loops end this short of their start.
    pub seam_gap: f64,
    pub wall_max_resolution: f64,
    pub wall_max_deviation: f64,
    pub min_length_factor: f64,
    /// Raft layers under the object (Orca `Layer::id()` of the first object layer). `from_config` reads `raft_layers`;
    /// a caller that hands the lane a config with the raft zeroed (the object stack is sliced without it) must set this
    /// field itself. Offsets the layer id used for the first-layer line widths, `id() > 0` bridge test and the fill
    /// direction parity.
    pub raft_layers: usize,
}

fn width_of(c: &Config, key: &str, nozzle: f64) -> Res<f64> {
    let v = c.float_or_percent(key)?.resolve(nozzle);
    if v <= 0.0 { return unsupported(format!("{key} = 0 (automatic line width) is not implemented")); }
    Ok(v)
}

impl SurfaceCfg {
    pub fn from_config(c: &Config) -> Res<SurfaceCfg> {
        let nozzle = c.f64_at("nozzle_diameter", 0)?;
        for (k, ok) in [
            ("spiral_mode", "0"), ("interface_shells", "0"), ("infill_combination", "0"),
            ("counterbore_hole_bridging", "none"), ("enable_extra_bridge_layer", "disabled"),
            ("dont_filter_internal_bridges", "disabled"),
            // bughunt 2026-11-15: Orca's Fill::_create_gap_fill fills the gaps of solid surfaces unless this is
            // `nowhere` (its default); no fill here does that, so `topbottom` / `everywhere` were ignored with exit 0.
            ("gap_fill_target", "nowhere"),
        ] {
            let v = c.str(k).unwrap_or_else(|_| ok.to_string());
            if v != ok { return unsupported(format!("{k} = '{v}': not implemented by the surfaces lane")); }
        }
        if c.bool_("enable_support").unwrap_or(false) && c.f64("support_top_z_distance").unwrap_or(0.1) == 0.0 {
            return unsupported("enable_support with support_top_z_distance = 0 (soluble support): bottoms become fully supported, not implemented");
        }
        if c.f64("top_surface_expansion").unwrap_or(0.0) != 0.0 { return unsupported("top_surface_expansion != 0"); }
        for k in ["top_surface_density", "bottom_surface_density", "bridge_density", "internal_bridge_density"] {
            let v = c.float_or_percent(k).map(|f| f.resolve(1.0)).unwrap_or(1.0);
            if (v - 1.0).abs() > 1e-9 { return unsupported(format!("{k} != 100%: partial-density solid fills need the grid-aligned (refpt) line phase, not implemented")); }
        }
        if !c.str("extra_solid_infills").unwrap_or_default().trim().is_empty() { return unsupported("extra_solid_infills (solid layer pattern) is not implemented"); }
        if (c.float_or_percent("elefant_foot_layers_density").map(|f| f.resolve(1.0)).unwrap_or(1.0) - 1.0).abs() > 1e-6 {
            return unsupported("elefant_foot_layers_density != 100%");
        }
        if c.str("slicing_mode").unwrap_or_else(|_| "regular".into()) != "regular" { return unsupported("slicing_mode != regular"); }
        let ensure = match c.str("ensure_vertical_shell_thickness")?.as_str() {
            "ensure_all" => EnsureVertical::All,
            "ensure_critical_only" => EnsureVertical::CriticalOnly,
            "none" => EnsureVertical::None,
            o => return unsupported(format!("ensure_vertical_shell_thickness = '{o}'")),
        };
        let angle = |k: &str| -> Res<Option<f64>> { let v = c.f64(k).unwrap_or(-1.0); Ok(if v >= 0.0 { Some(v.to_radians()) } else { None }) };
        let pct = |k: &str| -> Res<f64> { Ok(c.percent(k)? / 100.0) };
        let bridge_line = c.float_or_percent("bridge_line_width").map(|f| f.resolve(nozzle)).unwrap_or(0.0);
        Ok(SurfaceCfg {
            nozzle,
            layer_height: c.f64("layer_height")?,
            initial_layer_height: c.f64("initial_layer_print_height")?,
            w_initial: width_of(c, "initial_layer_line_width", nozzle)?,
            w_outer: width_of(c, "outer_wall_line_width", nozzle)?,
            w_inner: width_of(c, "inner_wall_line_width", nozzle)?,
            w_solid: width_of(c, "internal_solid_infill_line_width", nozzle)?,
            w_top: width_of(c, "top_surface_line_width", nozzle)?,
            w_sparse: width_of(c, "sparse_infill_line_width", nozzle)?,
            w_bridge: bridge_line,
            wall_loops: c.usize("wall_loops")?,
            top_shell_layers: c.usize("top_shell_layers")?,
            bottom_shell_layers: c.usize("bottom_shell_layers")?,
            top_shell_thickness: c.f64("top_shell_thickness")?,
            bottom_shell_thickness: c.f64("bottom_shell_thickness")?,
            ensure_vertical: ensure,
            sparse_density: pct("sparse_infill_density")?,
            min_sparse_area: c.f64("minimum_sparse_infill_area")?,
            extra_solid_infills: c.str("extra_solid_infills").unwrap_or_default(),
            top_pattern: parse_pattern("top_surface_pattern", &c.str("top_surface_pattern")?)?,
            bottom_pattern: parse_pattern("bottom_surface_pattern", &c.str("bottom_surface_pattern")?)?,
            solid_pattern: parse_pattern("internal_solid_infill_pattern", &c.str("internal_solid_infill_pattern")?)?,
            top_density: pct("top_surface_density")?,
            bottom_density: pct("bottom_surface_density")?,
            solid_direction: c.f64("solid_infill_direction")?.to_radians(),
            top_layer_direction: angle("top_layer_direction")?,
            bottom_layer_direction: angle("bottom_layer_direction")?,
            bridge_angle: c.f64("bridge_angle")?.to_radians(),
            relative_bridge_angle: c.bool_("relative_bridge_angle").unwrap_or(false),
            internal_bridge_angle: c.f64("internal_bridge_angle").unwrap_or(0.0).to_radians(),
            bridge_density: pct("bridge_density")?,
            internal_bridge_density: pct("internal_bridge_density")?,
            bridge_flow: c.f64("bridge_flow")?,
            thick_bridges: c.bool_("thick_bridges")?,
            thick_internal_bridges: c.bool_("thick_internal_bridges").unwrap_or(true),
            detect_narrow_internal_solid: c.bool_("detect_narrow_internal_solid_infill")?,
            elefant_foot_density: pct("elefant_foot_layers_density").unwrap_or(1.0),
            elefant_foot_layers: c.usize("elefant_foot_compensation_layers").unwrap_or(1),
            infill_wall_overlap: pct("infill_wall_overlap")?,
            top_bottom_infill_wall_overlap: pct("top_bottom_infill_wall_overlap")?,
            detect_overhang_wall: c.bool_("detect_overhang_wall")?,
            overhang_flow_ratio: c.f64("overhang_flow_ratio").unwrap_or(1.0),
            seam_gap: c.float_or_percent("seam_gap").map(|f| f.resolve(nozzle)).unwrap_or(0.1 * nozzle),
            wall_max_resolution: c.f64("wall_maximum_resolution").unwrap_or(0.5),
            wall_max_deviation: c.f64("wall_maximum_deviation").unwrap_or(0.025),
            min_length_factor: c.f64("min_length_factor").unwrap_or(0.5),
            raft_layers: c.usize("raft_layers").unwrap_or(0),
        })
    }

    // ------------------------------------------------------------------------------------ flows
    /// Region flow of a role on object layer `idx` (Orca layer id = idx + raft_layers) with thickness `h` (`PrintRegion::flow`): the first layer uses
    /// `initial_layer_line_width` for every role.
    pub fn flow(&self, role: FlowRole, idx: usize, h: f64) -> Flow {
        let w = if idx + self.raft_layers == 0 { self.w_initial } else {
            match role {
                FlowRole::ExternalPerimeter => self.w_outer,
                FlowRole::Perimeter => self.w_inner,
                FlowRole::SolidInfill => self.w_solid,
                FlowRole::TopSolidInfill => self.w_top,
                FlowRole::Infill => self.w_sparse,
            }
        };
        Flow::rect(w, h)
    }

    /// `LayerRegion::bridging_flow(role, thick)`.
    pub fn bridging_flow(&self, role: FlowRole, idx: usize, h: f64, thick: bool) -> Flow {
        let has_w = self.w_bridge > 0.0;
        if thick {
            let mut d = if has_w { self.w_bridge } else { self.nozzle };
            if self.bridge_flow > 0.0 { d *= self.bridge_flow.sqrt(); }
            Flow::bridging(d)
        } else {
            let mut base = self.flow(role, idx, h);
            if has_w { base = Flow::rect(self.w_bridge, base.height); }
            base.with_flow_ratio(self.bridge_flow)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowRole { ExternalPerimeter, Perimeter, SolidInfill, TopSolidInfill, Infill }

// ================================================================================================ API
/// Run `prepare_infill()`'s surface part over all layers.
///
/// `sparse`: the infill lane's sparse polylines per layer; used for the internal bridge direction and
/// anchoring. `None` falls back to Orca's own "no infill lines" branch (boundary as anchors), which gives
/// different angles on sparse-infill layers -- pass the provider when you have it.
pub fn classify(layers: &[LayerGeom], cfg: &SurfaceCfg, sparse: Option<&dyn SparseLines>) -> Res<Classified> {
    let mut st = detect::State::new(layers, cfg)?;
    st.detect_surfaces_type();
    st.prepare_fill_surfaces();
    st.discover_vertical_shells();
    st.discover_horizontal_shells();
    external::process_external_surfaces(&mut st);
    bridge_infill::bridge_over_infill(&mut st, sparse);
    Ok(Classified { slices: st.slices, fill: st.fill })
}

/// Extrude the solid surfaces (top, bottom, internal solid, bridges, internal bridges) of one layer.
pub fn fill_layer(layer: usize, layers: &[LayerGeom], cl: &Classified, cfg: &SurfaceCfg) -> Vec<ExtPath> {
    fill::fill_layer(layer, layers, cl, cfg)
}

#[allow(dead_code)]
const _: f64 = EPS;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::geom as g;

    #[test]
    fn surface_gap_fill_targets_other_than_nowhere_are_refused() {
        let err = |v: &str| {
            let c = Config::from_gcode(&format!("; CONFIG_BLOCK_START\n; nozzle_diameter = 0.4\n; gap_fill_target = {v}\n; CONFIG_BLOCK_END\n")).unwrap();
            match SurfaceCfg::from_config(&c) { Err(e) => e.to_string(), Ok(_) => String::new() }
        };
        assert!(err("topbottom").contains("gap_fill_target"));
        assert!(err("everywhere").contains("gap_fill_target"));
        assert!(!err("nowhere").contains("gap_fill_target"), "nowhere is what this engine does");
    }

    /// The X2D 0.4 preset values the lane depends on.
    pub(crate) fn cfg() -> SurfaceCfg {
        SurfaceCfg {
            nozzle: 0.4, layer_height: 0.2, initial_layer_height: 0.2,
            w_initial: 0.5, w_outer: 0.42, w_inner: 0.45, w_solid: 0.42, w_top: 0.42, w_sparse: 0.45, w_bridge: 0.4,
            wall_loops: 2, top_shell_layers: 5, bottom_shell_layers: 3, top_shell_thickness: 1.0, bottom_shell_thickness: 0.0,
            ensure_vertical: EnsureVertical::All, sparse_density: 0.15, min_sparse_area: 15.0, extra_solid_infills: String::new(),
            top_pattern: SolidPattern::MonotonicLine, bottom_pattern: SolidPattern::Monotonic, solid_pattern: SolidPattern::Monotonic,
            top_density: 1.0, bottom_density: 1.0, solid_direction: 45f64.to_radians(), top_layer_direction: None, bottom_layer_direction: None,
            bridge_angle: 0.0, relative_bridge_angle: false, internal_bridge_angle: 0.0, bridge_density: 1.0, internal_bridge_density: 1.0,
            bridge_flow: 1.0, thick_bridges: false, thick_internal_bridges: true, detect_narrow_internal_solid: true,
            elefant_foot_density: 1.0, elefant_foot_layers: 1, infill_wall_overlap: 0.15, top_bottom_infill_wall_overlap: 0.25,
            detect_overhang_wall: true, overhang_flow_ratio: 1.0,
            seam_gap: 0.04, wall_max_resolution: 0.5, wall_max_deviation: 0.025, min_length_factor: 0.5, raft_layers: 0,
        }
    }
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polys {
        vec![Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }]
    }
    /// A layer whose infill region is the slice shrunk by 1 mm (stand-in for the walls lane).
    fn layer(i: usize, slice: Polys) -> LayerGeom {
        let fill = g::offset(&slice, -1.0);
        LayerGeom { z: 0.2 * (i as f64 + 1.0), h: 0.2, fill_no_overlap: fill.clone(), fill, slice }
    }
    fn prism(n: usize) -> Vec<LayerGeom> { (0..n).map(|i| layer(i, rect(0.0, 0.0, 30.0, 30.0))).collect() }
    fn count(cl: &Classified, layer: usize, ty: SurfaceType) -> f64 {
        g::area(&cl.region(layer, &[ty]))
    }
    /// Solid area of a shell layer: the first one above sparse infill is an internal bridge, the rest internal solid.
    fn shell(cl: &Classified, layer: usize) -> f64 {
        g::area(&cl.region(layer, &[SurfaceType::InternalSolid, SurfaceType::InternalBridge]))
    }

    #[test]
    fn raft_offsets_the_layer_id() {
        let mut c = cfg();
        assert!((c.flow(FlowRole::ExternalPerimeter, 0, 0.2).width - c.w_initial).abs() < 1e-12);
        c.raft_layers = 2;
        // the first object layer over a raft is not Orca layer 0: normal widths
        assert!((c.flow(FlowRole::ExternalPerimeter, 0, 0.2).width - c.w_outer).abs() < 1e-12);
        // fill direction parity follows layer id (object layer 0 is id 2 -> even; object layer 1 -> odd)
        let layers = prism(12);
        let cl = classify(&layers, &c, None).unwrap();
        let p = |l: usize| fill_layer(l, &layers, &cl, &c).into_iter().find(|q| q.feature == Feature::BottomSurface || q.feature == Feature::InternalSolidInfill);
        let c0 = cfg();
        let cl0 = classify(&layers, &c0, None).unwrap();
        let p0 = fill_layer(1, &layers, &cl0, &c0).into_iter().find(|q| q.feature == Feature::InternalSolidInfill).unwrap();
        let p1 = p(1).unwrap();
        // raft of 1 would flip parity; 2 keeps it: same direction as without a raft on layer 1
        let dir = |q: &ExtPath| (q.pts[1].y - q.pts[0].y).atan2(q.pts[1].x - q.pts[0].x);
        assert!((dir(&p0) - dir(&p1)).abs() < 1e-6 || ((dir(&p0) - dir(&p1)).abs() - std::f64::consts::PI).abs() < 1e-6);
        let mut c1 = cfg();
        c1.raft_layers = 1;
        let cl1 = classify(&layers, &c1, None).unwrap();
        let q1 = fill_layer(1, &layers, &cl1, &c1).into_iter().find(|q| q.feature == Feature::InternalSolidInfill).unwrap();
        let d = (dir(&p0) - dir(&q1)).abs().rem_euclid(std::f64::consts::PI);
        assert!(d > 0.1 && d < std::f64::consts::PI - 0.1, "odd raft must rotate the solid fill: {d}");
    }

    #[test]
    fn prism_has_exact_shell_layers() {
        let c = cfg();
        let n = 40;
        let cl = classify(&prism(n), &c, None).unwrap();
        let fill_area = g::area(&g::offset(&rect(0.0, 0.0, 30.0, 30.0), -1.0));
        // bottom: layer 0 Bottom; layers 1..2 internal solid (3 bottom layers); layer 3 sparse
        assert!((count(&cl, 0, SurfaceType::Bottom) - fill_area).abs() < 0.01);
        for l in 1..=2 { assert!(shell(&cl, l) > fill_area * 0.99, "layer {l}"); }
        assert!(count(&cl, 3, SurfaceType::Internal) > fill_area * 0.9);
        // top: layer n-1 Top, layers n-5..n-2 internal solid (5 top layers), layer n-6 is the last sparse layer
        assert!((count(&cl, n - 1, SurfaceType::Top) - fill_area).abs() < 0.01);
        for l in n - 5..n - 1 { assert!(shell(&cl, l) > fill_area * 0.9, "layer {l}"); }
        assert!(count(&cl, n - 6, SurfaceType::Internal) > fill_area * 0.9);
        // the middle layers carry no solid at all
        for l in 6..n - 8 { assert!(shell(&cl, l) < 1.0, "layer {l}"); }
    }

    #[test]
    fn shell_count_follows_the_setting_negative_control() {
        // the test above would also pass for a classifier that ignores top_shell_layers if the preset had 5;
        // change the setting and the solid band must move
        let mut c = cfg();
        c.top_shell_layers = 3;
        c.top_shell_thickness = 0.0;
        let n = 40;
        let cl = classify(&prism(n), &c, None).unwrap();
        let fill_area = g::area(&g::offset(&rect(0.0, 0.0, 30.0, 30.0), -1.0));
        assert!(shell(&cl, n - 3) > fill_area * 0.9);
        assert!(count(&cl, n - 4, SurfaceType::Internal) > fill_area * 0.9, "the 4th layer from the top must be sparse with 3 top layers");
        assert!(shell(&cl, n - 4) < fill_area * 0.1, "only the anchor band may be solid under the bridge: {}", shell(&cl, n - 4));
    }

    /// Orca prints unconnected (monotonicline) top lines as a zig-zag: every line starts next to where the previous
    /// one ended (travel ~ one spacing, below retract_before_travel), never at the same side again.
    #[test]
    fn monotonicline_top_lines_alternate_direction() {
        let layers = prism(30);
        let c = cfg();
        let cl = classify(&layers, &c, None).unwrap();
        let top: Vec<ExtPath> = fill_layer(29, &layers, &cl, &c).into_iter().filter(|p| p.feature == Feature::TopSurface).collect();
        assert!(top.len() > 20, "{} top paths", top.len());
        let d = |a: &ExtPath, b: &ExtPath| {
            let (e, s) = (a.pts.last().unwrap(), &b.pts[0]);
            (e.x - s.x).hypot(e.y - s.y)
        };
        let worst = top.windows(2).map(|w| d(&w[0], &w[1])).fold(0.0, f64::max);
        assert!(worst < 1.5, "line-to-line travel {worst} mm: lines are all printed in the same direction");
        // negative control: the same paths with every other line reversed back must fail the bound
        let mut bad: Vec<ExtPath> = top.clone();
        for (i, p) in bad.iter_mut().enumerate() { if i % 2 == 1 { p.pts.reverse(); } }
        assert!(bad.windows(2).map(|w| d(&w[0], &w[1])).fold(0.0, f64::max) > 1.5);
    }

    #[test]
    fn bridge_across_a_gap_runs_along_the_short_span() {
        // two blocks with a 4 mm gap (x in 13..17) under a full slab
        let mut layers: Vec<LayerGeom> = (0..10).map(|i| {
            let mut s = rect(0.0, 0.0, 13.0, 30.0);
            s.extend(rect(17.0, 0.0, 30.0, 30.0));
            layer(i, s)
        }).collect();
        for i in 10..20 { layers.push(layer(i, rect(0.0, 0.0, 30.0, 30.0))); }
        let cl = classify(&layers, &cfg(), None).unwrap();
        let br: Vec<&Surface> = cl.fill[10].iter().filter(|s| s.ty == SurfaceType::BottomBridge).collect();
        assert!(!br.is_empty(), "no bridge over the gap");
        let area_b: f64 = br.iter().map(|s| g::area(&vec![s.poly.clone()])).sum();
        assert!(area_b > 4.0 * 28.0, "bridge area {area_b}");
        for s in &br {
            // threads span the gap, i.e. run along x: angle = 0 or pi (mod pi)
            let a = s.bridge_angle.rem_euclid(std::f64::consts::PI);
            assert!(a < 0.05 || a > std::f64::consts::PI - 0.05, "bridge angle {} deg", s.bridge_angle.to_degrees());
        }
        let paths = fill_layer(10, &layers, &cl, &cfg());
        assert!(paths.iter().any(|p| p.feature == Feature::Bridge));
        let b = paths.iter().find(|p| p.feature == Feature::Bridge).unwrap();
        // normal rectilinear bead (thick_bridges = 0): width follows the layer flow
        assert!((b.pts[0].w - 0.42).abs() < 0.05, "{}", b.pts[0].w);
    }

    #[test]
    fn internal_bridge_over_sparse_infill() {
        let c = cfg();
        let n = 40;
        let cl = classify(&prism(n), &c, None).unwrap();
        // first solid layer above sparse infill = n-5 becomes an internal bridge; the layer below gets an anchor band
        let fill_area = g::area(&g::offset(&rect(0.0, 0.0, 30.0, 30.0), -1.0));
        let ib = count(&cl, n - 5, SurfaceType::InternalBridge);
        assert!(ib > fill_area * 0.8, "internal bridge {ib} of {fill_area}");
        assert!(count(&cl, n - 6, SurfaceType::InternalSolid) > 5.0, "anchor band under the bridge");
        let layers = prism(n);
        let paths = fill_layer(n - 5, &layers, &cl, &c);
        let ibp: Vec<&ExtPath> = paths.iter().filter(|p| p.feature == Feature::InternalBridge).collect();
        assert!(!ibp.is_empty());
        // thick internal bridge: round thread of the nozzle diameter, E multiplier pi d^2/4 over the rect model
        assert!((ibp[0].pts[0].w - 0.4).abs() < 1e-9 && (ibp[0].layer_h - 0.4).abs() < 1e-9);
        assert!((ibp[0].flow_ratio - std::f64::consts::PI * 0.04 / ((0.4 - 0.4 * (1.0 - std::f64::consts::PI / 4.0)) * 0.4)).abs() < 1e-9);
        // negative control: 100 % sparse density means no sparse infill, so nothing to bridge over
        let mut c2 = cfg();
        c2.sparse_density = 1.0;
        let cl2 = classify(&prism(n), &c2, None).unwrap();
        for l in 0..n { assert!(count(&cl2, l, SurfaceType::InternalBridge) == 0.0, "layer {l}"); }
    }

    #[test]
    fn overhang_split_keeps_total_length() {
        let c = cfg();
        // wall loop of a 20 mm square on a layer whose lower layer is shifted 5 mm to the left
        let sq = [[5.0, 5.0], [25.0, 5.0], [25.0, 25.0], [5.0, 25.0]];
        let mut pts: Vec<PathPt> = sq.iter().map(|p| PathPt { x: p[0], y: p[1], w: 0.42 }).collect();
        pts.push(pts[0]);
        let wall = ExtPath { feature: Feature::OuterWall, pts, closed: false, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 };
        let lower = rect(0.0, 0.0, 20.0, 30.0);
        let out = split_overhang_walls(vec![wall.clone()], &lower, &c, false);
        let len = |ps: &[&ExtPath]| ps.iter().map(|p| p.pts.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum::<f64>()).sum::<f64>();
        let all: Vec<&ExtPath> = out.iter().collect();
        assert!((len(&all) - 80.0).abs() < 1e-6, "{}", len(&all));
        let over: Vec<&ExtPath> = out.iter().filter(|p| p.feature == Feature::OverhangWall).collect();
        // the lower layer grown by half a nozzle ends at x = 20.2: the wall beyond it overhangs
        // (the right edge x = 25 fully, the top and bottom edges from x = 20.2)
        assert!((len(&over) - (20.0 + 2.0 * (25.0 - 20.2))).abs() < 0.05, "{}", len(&over));
        // negative control: no lower region -> not retyped; detect_overhang_wall off -> untouched
        assert_eq!(split_overhang_walls(vec![wall.clone()], &vec![], &c, false).len(), 1);
        let mut c2 = cfg();
        c2.detect_overhang_wall = false;
        assert!(split_overhang_walls(vec![wall], &lower, &c2, false).iter().all(|p| p.feature == Feature::OuterWall));
    }

    #[test]
    fn empty_and_disjoint_layers_do_not_panic() {
        // a hole in the stack (empty layer) and an island that appears mid-air
        let mut layers = prism(12);
        layers[5] = layer(5, vec![]);
        layers.push(layer(12, rect(100.0, 100.0, 110.0, 110.0)));
        let cl = classify(&layers, &cfg(), None).unwrap();
        for l in 0..layers.len() { let _ = fill_layer(l, &layers, &cl, &cfg()); }
        // the island on layer 12 sits on nothing: a bridge / bottom with no anchors, and the first layer above the gap
        assert!(count(&cl, 6, SurfaceType::BottomBridge) > 100.0, "layer 6 rests on the empty layer 5");
        assert!(count(&cl, 12, SurfaceType::BottomBridge) + count(&cl, 12, SurfaceType::Top) > 10.0);
    }

    #[test]
    fn config_refuses_what_it_does_not_implement() {
        let mut m = std::collections::BTreeMap::new();
        m.insert("top_surface_pattern".to_string(), "hilbertcurve".to_string());
        assert!(parse_pattern("top_surface_pattern", "hilbertcurve").is_err());
        let _ = m;
    }
}
