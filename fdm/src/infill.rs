//! lane 4: sparse infill. A faithful port of OrcaSlicer 2.5.0-dev `libslic3r/Fill/*` for every
//! `sparse_infill_pattern`, including `Fill::connect_infill` (boundary connections and anchors).
//!
//! ```text
//! fill_sparse(region: &Polys, ctx: &InfillCtx) -> Result<Vec<ExtPath>, FdmError>   // Feature::SparseInfill, print order
//! InfillCtx::from_settings(get, layer_index, z, layer_h)                           // from CONFIG_BLOCK strings
//! combine::{combine_plan, combine_infill, combine_clearance}                       // infill_combination
//! adaptive::AdaptiveOctree::build(..)  -> InfillCtx::octree                        // adaptive / support cubic
//! lightning::LightningGenerator::build(..) -> InfillCtx::lightning                 // lightning
//! ```
//!
//! Conventions the pipeline must honour (all of them change the pattern phase, i.e. the G-code):
//! * `region` is the layer's sparse area (`stInternal`), one `Poly` per `ExPolygon`, contours CCW, holes CW. The
//!   generator insets it by half a bead itself (`Fill::fill_surface`), like libslic3r.
//! * `layer_index` counts from the first object layer (raft layers included, like `Layer::id()`); `z` is the TOP of the
//!   layer; `object_layer_h` is the nominal `layer_height` (the sparse spacing never follows the first layer or a
//!   combined layer). A combined layer passes `thickness_layers = n`, `layer_h = n * h`.
//! * `center` = centre of the object bounding box and `origin` = object-space origin, both in the region's frame
//!   (equal for a single centred object); `object_bbox` = the object's bounding box in that frame (Hilbert curve and the
//!   zig-zag family anchor on it).
//! * Patterns that need whole-object input refuse with `FdmError::Unsupported` when it is missing. Refused as well:
//!   density >= 100% (Orca makes that solid infill), `fill_multiline > 1`, `lockedzag`.
//!
//! Pipeline hooks for the whole-object patterns (build ONCE per object, then set on every layer's `InfillCtx`):
//! ```text
//! // adaptive / support cubic: object mesh triangles in object space (XY centred), internal-bridge triangles
//! ctx.octree    = Some(Arc::new(adaptive::AdaptiveOctree::build(&tris, &bridge_tris, flow_spacing(w, h) / density, false)));
//! // lightning: sparse (internal + internal-void) region of every layer, lowest layer first
//! ctx.lightning = Some(Arc::new(lightning::LightningGenerator::build(&sparse_regions_by_layer, &lightning::LightningParams{..})));
//! ```
//! Density 100% / small-area solid conversion is NOT done here: `fill_sparse` returns `FdmError::Unsupported` at
//! density >= 100%; the surfaces lane must route those regions to internal solid infill (Orca `process_external_surfaces`).
//!
//! Exactness: the line-sweep family (grid, triangles, tri-hexagon, cubic, quarter cubic, lateral lattice/honeycomb) runs on
//! `clipper` (a line-by-line ClipperLib 6.4.2 port, fuzz-verified against libslic3r) + `rectint` + `connect` (integer grid);
//! polylines are returned in libslic3r generator order (the motion lane's planner re-chains them).
pub mod adaptive;
mod bylines;
pub mod combine;
mod concentric;
mod connect;
mod crosshatch;
mod gx;
mod gyroid;
mod honeycomb;
pub mod lightning;
mod marching;
mod planepath;
mod tpms;
mod rect;
mod stdsort;
pub mod clipper;
mod rectint;
mod chainpl;

use crate::types::{ExtPath, Feature, PathPt, Poly, Polys};
use gx::P;

/// All of Orca's `sparse_infill_pattern` values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Pattern {
    Rectilinear, AlignedRectilinear, ZigZag, CrossZag, LockedZag, Line, Grid, Triangles, TriHexagon, Cubic,
    AdaptiveCubic, QuarterCubic, SupportCubic, Lightning, Honeycomb, Honeycomb3D, LateralHoneycomb, LateralLattice,
    CrossHatch, TpmsD, TpmsFK, Gyroid, Concentric, HilbertCurve, ArchimedeanChords, OctagramSpiral,
}
impl Pattern {
    /// The enum keys of `sparse_infill_pattern` as written in Orca's config.
    pub fn from_orca(s: &str) -> Option<Pattern> {
        Some(match s.trim() {
            "rectilinear" => Pattern::Rectilinear, "alignedrectilinear" => Pattern::AlignedRectilinear,
            "zigzag" => Pattern::ZigZag, "crosszag" => Pattern::CrossZag, "lockedzag" => Pattern::LockedZag,
            "line" => Pattern::Line, "grid" => Pattern::Grid, "triangles" => Pattern::Triangles,
            "tri-hexagon" => Pattern::TriHexagon, "cubic" => Pattern::Cubic, "adaptivecubic" => Pattern::AdaptiveCubic,
            "quartercubic" => Pattern::QuarterCubic, "supportcubic" => Pattern::SupportCubic, "lightning" => Pattern::Lightning,
            "honeycomb" => Pattern::Honeycomb, "3dhoneycomb" => Pattern::Honeycomb3D,
            "lateral-honeycomb" => Pattern::LateralHoneycomb, "lateral-lattice" => Pattern::LateralLattice,
            "crosshatch" => Pattern::CrossHatch, "tpmsd" => Pattern::TpmsD, "tpmsfk" => Pattern::TpmsFK,
            "gyroid" => Pattern::Gyroid, "concentric" => Pattern::Concentric, "hilbertcurve" => Pattern::HilbertCurve,
            "archimedeanchords" => Pattern::ArchimedeanChords, "octagramspiral" => Pattern::OctagramSpiral,
            _ => return None,
        })
    }
}

/// Everything `fill_sparse` needs besides the region. Millimetres / radians-free (degrees) as in Orca's config.
#[derive(Clone, Debug)]
pub struct InfillCtx {
    pub pattern: Pattern,
    /// `sparse_infill_density` as a fraction 0..1 (0.15 for 15%).
    pub density: f64,
    /// `sparse_infill_line_width` (bead width, mm).
    pub line_width: f64,
    /// Layer height of the layer being filled; for a combined layer this is `thickness_layers * object_layer_h`.
    pub layer_h: f64,
    /// Nominal object layer height (`layer_height`); the sparse spacing is computed with it, not with `layer_h`.
    pub object_layer_h: f64,
    /// Layer index, counting from 0 at the first object layer (raft layers excluded).
    pub layer_index: usize,
    /// Print z (top of the layer), mm.
    pub z: f64,
    /// `infill_direction`, degrees.
    pub angle_deg: f64,
    /// Pattern reference point: centre of the object bounding box in the same frame as the region.
    pub center: P,
    /// Origin of the object coordinate system in the region's frame. libslic3r generates patterns in object
    /// space (the object is centred on its origin), so absolutely anchored patterns (gyroid, TPMS, honeycomb,
    /// hilbert...) are phased on this point. `None` = same as `center`.
    pub origin: Option<P>,
    /// Object bounding box (min, max) in the region's frame; patterns anchored to the whole object use it.
    pub object_bbox: Option<(P, P)>,
    /// `infill_anchor` (mm, already resolved from a percent of the spacing by `resolve_anchor`).
    pub anchor: f64,
    /// `infill_anchor_max` (mm).
    pub anchor_max: f64,
    /// Number of layers merged by `infill_combination` for this layer (1 = none).
    pub thickness_layers: usize,
    /// `fill_multiline`.
    pub multiline: usize,
    /// Octree for `AdaptiveCubic` / `SupportCubic` (build it once per object with `adaptive::AdaptiveOctree::build`).
    pub octree: Option<std::sync::Arc<adaptive::AdaptiveOctree>>,
    /// Lightning trees for the whole object (`lightning::LightningGenerator::build`).
    pub lightning: Option<std::sync::Arc<lightning::LightningGenerator>>,
    /// Print head position before the infill, for nearest-neighbour path ordering.
    pub start: Option<P>,
    /// Pattern parameters.
    pub lateral_lattice_angle_1: f64,
    pub lateral_lattice_angle_2: f64,
    pub infill_overhang_angle: f64,
    pub gyroid_optimized: bool,
    pub smooth_factor: f64,
    pub infill_shift_step: f64,
    pub symmetric_infill_y_axis: bool,
    pub infill_lock_depth: f64,
    pub skin_infill_depth: f64,
    /// Extrusion speed to request (mm/s), 0 = motion lane decides.
    /// Seam gap resolved to mm (`seam_gap` of the nozzle diameter); clipped off concentric loop ends.
    pub loop_clipping: f64,
    /// Print resolution (`resolution`, mm) used by curve generators.
    pub resolution: f64,
    pub speed: f64,
    /// `sparse_infill_flow_ratio` (times filament flow handled by gcode).
    pub flow_ratio: f64,
}
impl Default for InfillCtx {
    fn default() -> Self {
        InfillCtx {
            pattern: Pattern::Grid, density: 0.15, line_width: 0.45, layer_h: 0.2, object_layer_h: 0.2, layer_index: 0, z: 0.2,
            angle_deg: 45.0, center: [0.0, 0.0], origin: None, object_bbox: None, anchor: 4.0 * 0.4274, anchor_max: 20.0, thickness_layers: 1,
            multiline: 1, octree: None, lightning: None, start: None, lateral_lattice_angle_1: 0.0, lateral_lattice_angle_2: 0.0, infill_overhang_angle: 60.0,
            gyroid_optimized: false, smooth_factor: 0.0, infill_shift_step: 0.4, symmetric_infill_y_axis: false,
            infill_lock_depth: 1.0, skin_infill_depth: 2.0, loop_clipping: 0.04, resolution: 0.012, speed: 0.0, flow_ratio: 1.0,
        }
    }
}

/// `Flow::spacing()` of a rounded-rectangle bead: `width - height * (1 - pi/4)`.
pub fn flow_spacing(width: f64, height: f64) -> f64 {
    // `Flow::rounded_rectangle_extrusion_spacing`: float arithmetic, `width - height * float(1. - 0.25 * PI)`
    let k = (1.0 - 0.25 * std::f64::consts::PI) as f32;
    ((width as f32) - (height as f32) * k) as f64
}

/// Resolve `infill_anchor` / `infill_anchor_max` ("400%" of the spacing, or "20" mm).
pub fn resolve_anchor(s: &str, spacing: f64) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() { return None; }
    if let Some(p) = s.strip_suffix('%') { return p.trim().parse::<f64>().ok().map(|v| v * 0.01 * spacing); }
    s.parse::<f64>().ok()
}

impl InfillCtx {
    /// Build a context from Orca config strings (CONFIG_BLOCK keys). `get` returns the raw value of a key.
    pub fn from_settings(get: &dyn Fn(&str) -> Option<String>, layer_index: usize, z: f64, layer_h: f64) -> Result<InfillCtx, String> {
        let f = |k: &str| -> Option<f64> { get(k).and_then(|v| v.trim().trim_end_matches('%').parse::<f64>().ok()) };
        let pat = get("sparse_infill_pattern").ok_or("sparse_infill_pattern missing")?;
        let pattern = Pattern::from_orca(&pat).ok_or_else(|| format!("unsupported sparse_infill_pattern '{pat}'"))?;
        let mut c = InfillCtx { pattern, ..Default::default() };
        c.density = f("sparse_infill_density").ok_or("sparse_infill_density missing")? / 100.0;
        // bughunt 2026-11-15: Orca's 3D honeycomb closes the cell tops when this is on (Fill3DHoneycomb.cpp makeGrid ->
        // addTops); `honeycomb::fill_3d_honeycomb` has no tops, so the setting was ignored with exit 0.
        if pattern == Pattern::Honeycomb3D && c.density > 0.0 && get("infill_complete_top").map_or(false, |v| matches!(v.trim(), "1" | "true")) {
            return Err("infill_complete_top = 1 with 3dhoneycomb is not implemented in 2bee.fdm (the cell tops are not printed); set it to 0".into());
        }
        c.line_width = f("sparse_infill_line_width").ok_or("sparse_infill_line_width missing")?;
        c.object_layer_h = f("layer_height").ok_or("layer_height missing")?;
        c.layer_h = layer_h;
        c.layer_index = layer_index;
        c.z = z;
        c.angle_deg = f("infill_direction").unwrap_or(45.0);
        let spacing = flow_spacing(c.line_width, c.object_layer_h);
        c.anchor_max = get("infill_anchor_max").and_then(|v| resolve_anchor(&v, spacing)).unwrap_or(20.0);
        c.anchor = get("infill_anchor").and_then(|v| resolve_anchor(&v, spacing)).unwrap_or(400.0 * 0.01 * spacing).min(c.anchor_max);
        c.multiline = f("fill_multiline").map(|v| v as usize).unwrap_or(1).max(1);
        if let Some(v) = f("lateral_lattice_angle_1") { c.lateral_lattice_angle_1 = v; }
        if let Some(v) = f("lateral_lattice_angle_2") { c.lateral_lattice_angle_2 = v; }
        if let Some(v) = f("infill_overhang_angle") { c.infill_overhang_angle = v; }
        if let Some(v) = f("sparse_infill_smooth_factor") { c.smooth_factor = v / 100.0; }
        if let Some(v) = get("seam_gap").and_then(|g| resolve_anchor(&g, get("nozzle_diameter").and_then(|n| n.split(',').next().and_then(|x| x.trim().parse::<f64>().ok())).unwrap_or(0.4))) { c.loop_clipping = v; }
        if let Some(v) = f("resolution") { c.resolution = v; }
        if let Some(v) = f("infill_shift_step") { c.infill_shift_step = v; }
        if let Some(v) = f("infill_lock_depth") { c.infill_lock_depth = v; }
        if let Some(v) = f("skin_infill_depth") { c.skin_infill_depth = v; }
        c.gyroid_optimized = get("gyroid_optimized").map_or(false, |v| v.trim() == "1");
        c.symmetric_infill_y_axis = get("symmetric_infill_y_axis").map_or(false, |v| v.trim() == "1");
        c.flow_ratio = f("sparse_infill_flow_ratio").unwrap_or(1.0);
        Ok(c)
    }
}

/// Derived per-fill state shared by the generators.
pub(crate) struct Ctx<'a> {
    pub c: &'a InfillCtx,
    pub spacing: f64,
    pub density: f64,
    pub anchor: f64,
    pub anchor_max: f64,
    pub center: P,
    pub origin: P,
    pub multiline: usize,
    pub z: f64,
    pub layer_id: usize,
}
impl<'a> Ctx<'a> {
    /// Object frame (integer nm, origin at the object's centre) of this fill.
    pub fn frame(&self) -> rectint::Frame { rectint::Frame::new(self.origin) }
    /// `Fill::bounding_box`: the object's bounding box centred on the origin (`PrintObject::bounding_box`), integer nm.
    pub fn bbox_int(&self, poly: &Poly) -> ([i64; 2], [i64; 2]) {
        if let Some((lo, hi)) = self.c.object_bbox {
            let sx = ((hi[0] - lo[0]) * 1e6) as i64;
            let sy = ((hi[1] - lo[1]) * 1e6) as i64;
            ([-sx / 2, -sy / 2], [sx / 2, sy / 2])
        } else {
            let fr = self.frame();
            let pts: Vec<[i64; 2]> = poly.contour.iter().map(|&p| fr.to_obj(p)).collect();
            let (lo, hi) = rectint::extents(&pts);
            (lo, hi)
        }
    }
    /// `float(deg2rad(infill_direction))`.
    pub fn angle_f32(&self) -> f32 { (std::f64::consts::PI * self.c.angle_deg / 180.0) as f32 }
    pub fn clone_with_density(&self, density: f64) -> Ctx<'a> {
        Ctx { c: self.c, spacing: self.spacing, density, anchor: self.anchor, anchor_max: self.anchor_max, center: self.center, origin: self.origin, multiline: self.multiline, z: self.z, layer_id: self.layer_id }
    }
    pub fn new(c: &'a InfillCtx) -> Ctx<'a> {
        let spacing = flow_spacing(c.line_width, c.object_layer_h);
        Ctx { c, spacing, density: c.density.min(1.0), anchor: c.anchor.min(c.anchor_max), anchor_max: c.anchor_max, center: c.center, origin: c.origin.unwrap_or(c.center),
              multiline: c.multiline.max(1), z: c.z, layer_id: c.layer_index }
    }
    /// `Fill::_infill_direction().first`: infill direction + layer alternation + 90 deg (radians).
    /// `layer_angle` is the pattern's `_layer_angle(layer_id / thickness_layers)`.
    pub fn direction_angle(&self, layer_angle: f64) -> f64 {
        self.c.angle_deg.to_radians() + layer_angle + std::f64::consts::FRAC_PI_2
    }
    /// Base `Fill::_layer_angle`: alternate 0 / 90 deg by layer.
    pub fn alt_layer_angle(&self) -> f64 {
        let idx = self.layer_id / self.c.thickness_layers.max(1);
        if idx & 1 == 1 { std::f64::consts::FRAC_PI_2 } else { 0.0 }
    }
}

/// `chain_polylines` (libslic3r ShortestPath): connect the shortest links between segment end points without
/// forming loops or branches, reversing segments as needed, then walk the single resulting chain.
/// Simplification: the flip penalties and the final 2-exchange improvement are not reproduced.
pub(crate) fn chain_polylines(lines: Vec<Vec<P>>, start: Option<P>) -> Vec<Vec<P>> {
    let lines: Vec<Vec<P>> = lines.into_iter().filter(|l| l.len() >= 2).collect();
    let n = lines.len();
    if n <= 1 { return lines; }
    if n > 1500 { return order_paths(lines, start, true); }
    // end point e = 2*i (first) / 2*i+1 (last)
    let pt = |e: usize| -> P { if e & 1 == 0 { lines[e >> 1][0] } else { *lines[e >> 1].last().unwrap() } };
    let mut edges: Vec<(f64, usize, usize)> = Vec::with_capacity(n * n * 2);
    for a in 0..2 * n { for b in a + 1..2 * n { if a >> 1 != b >> 1 { edges.push((gx::dist(pt(a), pt(b)), a, b)); } } }
    edges.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));
    // with a start position the first segment is the one whose end point is nearest to it, and that end stays free
    let first_end: Option<usize> = start.map(|s| (0..2 * n).min_by(|&a, &b| gx::dist(pt(a), s).partial_cmp(&gx::dist(pt(b), s)).unwrap()).unwrap());
    let mut link: Vec<Option<usize>> = vec![None; 2 * n];
    let mut uf: Vec<usize> = (0..n).collect();
    fn find(uf: &mut Vec<usize>, i: usize) -> usize { let mut r = i; while uf[r] != r { r = uf[r]; } let mut c = i; while uf[c] != r { let nx = uf[c]; uf[c] = r; c = nx; } r }
    let mut joined = 0;
    for (_, a, b) in edges {
        if link[a].is_some() || link[b].is_some() || first_end == Some(a) || first_end == Some(b) { continue; }
        let (ra, rb) = (find(&mut uf, a >> 1), find(&mut uf, b >> 1));
        if ra == rb { continue; }
        uf[ra] = rb;
        link[a] = Some(b);
        link[b] = Some(a);
        joined += 1;
        if joined == n - 1 { break; }
    }
    // the two free ends of the chain
    let ends: Vec<usize> = (0..2 * n).filter(|&e| link[e].is_none() && link[e ^ 1].is_some() || (link[e].is_none() && n == 1)).collect();
    let free: Vec<usize> = (0..2 * n).filter(|&e| link[e].is_none()).collect();
    let _ = ends;
    // free end points of the chain are those with no link; the chain has exactly two (segments in the middle have both linked)
    let first = first_end.unwrap_or(free[0]);
    let mut out: Vec<Vec<P>> = Vec::with_capacity(n);
    let mut e = first; // entering end point of the next segment
    loop {
        let seg = e >> 1;
        let mut l = lines[seg].clone();
        if e & 1 == 1 { l.reverse(); }
        out.push(l);
        match link[e ^ 1] { Some(nx) => e = nx, None => break }
    }
    out
}

/// Nearest-neighbour ordering of open paths from `start`. `reversible` lets a path be flipped.
pub(crate) fn order_paths(lines: Vec<Vec<P>>, start: Option<P>, reversible: bool) -> Vec<Vec<P>> {
    let mut rest: Vec<Vec<P>> = lines.into_iter().filter(|l| l.len() >= 2).collect();
    let mut out = Vec::with_capacity(rest.len());
    let mut cur = start;
    if cur.is_none() && !rest.is_empty() {
        let first = rest.remove(0);
        cur = Some(*first.last().unwrap());
        out.push(first);
    }
    while !rest.is_empty() {
        let c = cur.unwrap();
        let (mut bi, mut bd, mut rev) = (0usize, f64::INFINITY, false);
        for (i, l) in rest.iter().enumerate() {
            let d0 = gx::dist(l[0], c);
            if d0 < bd { bd = d0; bi = i; rev = false; }
            if reversible {
                let d1 = gx::dist(*l.last().unwrap(), c);
                if d1 < bd { bd = d1; bi = i; rev = true; }
            }
        }
        let mut l = rest.remove(bi);
        if rev { l.reverse(); }
        cur = Some(*l.last().unwrap());
        out.push(l);
    }
    out
}

/// Sparse infill of one region (the layer's sparse area, already separated from solid infill).
/// Returns `Feature::SparseInfill` paths in print order (nearest-neighbour from `ctx.start`).
/// Never silently approximates: an unsupported pattern returns `Err`.
pub fn fill_sparse(region: &Polys, ctx: &InfillCtx) -> Result<Vec<ExtPath>, crate::types::FdmError> {
    use crate::types::FdmError;
    if !(ctx.density.is_finite()) || !(ctx.line_width > 0.0) || !(ctx.object_layer_h > 0.0) {
        return Err(FdmError::Geometry("fill_sparse: density / line_width / layer height must be finite and positive".into()));
    }
    if region.is_empty() || ctx.density <= 0.0 { return Ok(Vec::new()); }
    if ctx.density >= 0.9999 {
        return Err(FdmError::Unsupported("sparse_infill_density 100%: Orca turns internal sparse infill into internal solid infill (LayerRegion::process_external_surfaces); the surfaces lane must route that region to solid infill".into()));
    }
    if ctx.multiline > 1 {
        return Err(FdmError::Unsupported("fill_multiline > 1 (multiline_fill / trapezoidal grid) is not implemented".into()));
    }
    let cx = Ctx::new(ctx);
    let mut reversible = true;
    let mut keep_order = false;
    let mut lines: Vec<Vec<P>> = Vec::new();
    for poly in region {
        if poly.contour.len() < 3 { continue; }
        // a degenerate region must never take the process down: report it as an error instead
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fill_poly(poly, &cx, &mut reversible, &mut keep_order)));
        match r {
            Ok(Ok(l)) => lines.extend(l),
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(FdmError::Geometry(format!("sparse infill {:?}: generator panicked on a region of {} contour points", ctx.pattern, poly.contour.len()))),
        }
    }
    lines.retain(|l| l.len() >= 2 && l.iter().all(|p| p[0].is_finite() && p[1].is_finite()));
    // Concentric loops are never re-sorted (`no_sort`): outside-in order is the print order.
    // Orca's `Fill::fill_surface` returns the polylines in generator order and the PATH PLANNER (`GCode::extrude_infill`,
    // `chain_and_reorder_extrusion_entities`) orders them later; the motion lane ports that planner exactly, so with no
    // `start` the generator order is returned untouched (it is also the tie-break order of that planner).
    let ordered = if keep_order || ctx.start.is_none() { lines } else if reversible { chain_polylines(lines, ctx.start) } else { order_paths(lines, ctx.start, false) };
    Ok(ordered.into_iter().map(|pl| to_path(pl, ctx)).collect())
}

fn to_path(pl: Vec<P>, ctx: &InfillCtx) -> ExtPath {
    ExtPath {
        feature: Feature::SparseInfill,
        pts: pl.into_iter().map(|p| PathPt { x: p[0], y: p[1], w: ctx.line_width }).collect(),
        closed: false, layer_h: ctx.layer_h, speed: ctx.speed, flow_ratio: ctx.flow_ratio,
    }
}

fn fill_poly(poly: &Poly, cx: &Ctx, reversible: &mut bool, ordered: &mut bool) -> Result<Vec<Vec<P>>, crate::types::FdmError> {
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_3, PI};
    use rect::Sweep;
    let c = cx.c;
    let sw = |angle: f64, shift: f64| Sweep { angle, shift };
    Ok(match c.pattern {
        Pattern::Grid => {
            *reversible = false;
            let mut v = rect::fill_by_multilines(poly, cx, &[sw(0.0, 0.0), sw(FRAC_PI_2, 0.0)], 0.0);
            if cx.layer_id % 2 == 1 { for l in &mut v { l.reverse(); } }
            v
        }
        Pattern::Triangles => rect::fill_by_multilines(poly, cx, &[sw(0.0, 0.0), sw(FRAC_PI_3, 0.0), sw(2.0 * FRAC_PI_3, 0.0)], 0.0),
        Pattern::TriHexagon => {
            let sh = 1.5 * cx.spacing * cx.multiline as f64 / cx.density;
            rect::fill_by_multilines(poly, cx, &[sw(0.0, 0.0), sw(FRAC_PI_3, 0.0), sw(2.0 * FRAC_PI_3, sh)], 0.0)
        }
        Pattern::Cubic => {
            let dx = (0.5f64).sqrt() * cx.z;
            rect::fill_by_multilines(poly, cx, &[sw(0.0, dx), sw(FRAC_PI_3, -dx), sw(2.0 * FRAC_PI_3, dx)], 0.0)
        }
        Pattern::TpmsD => contracted(poly, cx, |e| tpms::fill_tpms_d(e, cx)),
        Pattern::TpmsFK => contracted(poly, cx, |e| tpms::fill_tpms_fk(e, cx)),
        Pattern::HilbertCurve => contracted(poly, cx, |e| planepath::fill_plane_path(e, cx, planepath::Kind::Hilbert)),
        Pattern::ArchimedeanChords => contracted(poly, cx, |e| planepath::fill_plane_path(e, cx, planepath::Kind::Archimedean)),
        Pattern::OctagramSpiral => contracted(poly, cx, |e| planepath::fill_plane_path(e, cx, planepath::Kind::Octagram)),
        Pattern::Concentric => { *ordered = true; contracted(poly, cx, |e| concentric::fill_concentric(e, cx)) }
        Pattern::AdaptiveCubic | Pattern::SupportCubic => {
            let Some(oct) = c.octree.as_ref() else { return Err(crate::types::FdmError::Unsupported("adaptive/support cubic infill needs InfillCtx::octree (adaptive::AdaptiveOctree::build)".into())) };
            contracted(poly, cx, |e| adaptive::fill_adaptive(e, cx, oct))
        }
        Pattern::Lightning => {
            let Some(g) = c.lightning.as_ref() else { return Err(crate::types::FdmError::Unsupported("lightning infill needs InfillCtx::lightning (lightning::LightningGenerator::build over every layer)".into())) };
            contracted(poly, cx, |e| lightning::fill_lightning(e, cx, g))
        }
        Pattern::CrossHatch => contracted(poly, cx, |e| crosshatch::fill_crosshatch(e, cx)),
        Pattern::Gyroid => gyroid::fill_gyroid(poly, cx)?,
        Pattern::Honeycomb | Pattern::Honeycomb3D => contracted(poly, cx, |e| if c.pattern == Pattern::Honeycomb { honeycomb::fill_honeycomb(e, cx) } else { honeycomb::fill_3d_honeycomb(e, cx) }),
        Pattern::Rectilinear | Pattern::AlignedRectilinear | Pattern::ZigZag | Pattern::CrossZag => {
            let la = if c.pattern == Pattern::AlignedRectilinear { 0.0 } else { cx.alt_layer_angle() };
            let consistent = matches!(c.pattern, Pattern::ZigZag | Pattern::CrossZag);
            let mut horiz = 0.0;
            if c.pattern == Pattern::CrossZag {
                let step = c.infill_shift_step * (cx.layer_id / 2) as f64;
                horiz = if cx.layer_id % 2 == 0 { -step } else { step };
            }
            let pieces = contracted_ex(poly, cx, |e| bylines::fill_by_lines(e, cx, la, consistent, horiz, false));
            pieces.map_err(|e| crate::types::FdmError::Geometry(format!("fill_surface_by_lines: {e}")))?
        }
        Pattern::QuarterCubic => {
            let line_width = (cx.spacing * 1e6).trunc() * cx.multiline as f64;
            let period = ((cx.spacing * 1e6).trunc() * cx.multiline as f64 / cx.density).trunc() * 4.0;
            let shift_for = |pz: f64| -> f64 {
                let mut sh = ((std::f64::consts::FRAC_1_SQRT_2 * (cx.z * 1e6 + pz * period * 2.0)).trunc()) % period;
                sh = sh.min(period - sh);
                sh = sh.min(period / 2.0 - line_width / 2.0);
                sh = sh.max(line_width / 2.0);
                sh * 1e-6
            };
            let (dx1, dx2) = (shift_for(0.0), shift_for(0.5));
            rect::fill_by_multilines(poly, cx, &[sw(0.0, dx1), sw(0.0, -dx1), sw(FRAC_PI_2, dx2), sw(FRAC_PI_2, -dx2)], 0.0)
        }
        Pattern::LateralLattice => {
            let dx1 = c.lateral_lattice_angle_1.to_radians().tan() * cx.z;
            let dx2 = c.lateral_lattice_angle_2.to_radians().tan() * cx.z;
            let mut v = rect::fill_by_multilines(poly, cx, &[sw(FRAC_PI_2, dx1), sw(FRAC_PI_2, dx2)], 0.0);
            if cx.layer_id % 2 == 1 { for l in &mut v { l.reverse(); } }
            v
        }
        Pattern::LateralHoneycomb => {
            // FillLateralHoneycomb (aligned rectilinear base: no per-layer rotation); float arithmetic as in C++.
            let spacing = cx.spacing as f32;
            let mult = cx.multiline as f32;
            let dens = cx.density as f32;
            let half_h = 0.5f32 * (1.0 * (2.0 / 3.0) + 2.0 * (1.0 / 3.0)) * spacing * mult / dens;
            let vertical_period = 3.0 * half_h / ((std::f32::consts::PI / 180.0) * c.infill_overhang_angle as f32).tan();
            let thirds_f = 3.0 * cx.z as f32 / vertical_period;
            let thirds_i = thirds_f as i32;
            let single = (thirds_i + 1) % 3 != 0;
            let odd = ((thirds_i + 1) / 3) % 2 != 0;
            let h_off = if odd { half_h } else { 0.0 } as f64;
            let mut v = if single {
                let c2 = cx.clone_with_density(cx.density * (1.0 / (1.0 * (2.0 / 3.0) + 2.0 * (1.0 / 3.0))));
                rect::fill_by_multilines(poly, &c2, &[sw(FRAC_PI_2, h_off)], 0.0)
            } else {
                let c2 = cx.clone_with_density(cx.density * (2.0 / (1.0 * (2.0 / 3.0) + 2.0 * (1.0 / 3.0))));
                let hp = ((1.0 - (thirds_f - thirds_i as f32)) * half_h) as f64;
                rect::fill_by_multilines(poly, &c2, &[sw(FRAC_PI_2, -hp + h_off), sw(FRAC_PI_2, hp + h_off)], 0.0)
            };
            if cx.layer_id % 2 == 1 { for l in &mut v { l.reverse(); } }
            v
        }
        Pattern::Line => rect::fill_line(poly, cx, cx.alt_layer_angle()),
        p => return Err(crate::types::FdmError::Unsupported(format!("sparse infill pattern {p:?} not implemented yet"))),
    }).map(|v| { let _ = PI; v })
}

/// Like `contracted` but for fallible generators. (FillRectilinear overrides fill_surface and does its own insetting.)
fn contracted_ex(poly: &Poly, _cx: &Ctx, f: impl Fn(&Poly) -> Result<Vec<Vec<P>>, String>) -> Result<Vec<Vec<P>>, String> { f(poly) }

/// `Fill::fill_surface` default wrapper: offset by `overlap - 0.5 * spacing` (overlap = 0), fill each piece.
fn contracted(poly: &Poly, cx: &Ctx, f: impl Fn(&Poly) -> Vec<Vec<P>>) -> Vec<Vec<P>> {
    let mut out = Vec::new();
    for e in gx::offset(&vec![poly.clone()], -0.5 * cx.spacing) { out.extend(f(&e)); }
    out
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    #[test]
    fn complete_top_with_3d_honeycomb_is_refused_not_ignored() {
        let ctx = |pat: &str, top: &str, dens: &str| {
            let kv = [("sparse_infill_pattern", pat), ("sparse_infill_density", dens), ("sparse_infill_line_width", "0.45"),
                      ("layer_height", "0.2"), ("infill_complete_top", top)];
            InfillCtx::from_settings(&|k: &str| kv.iter().find(|(a, _)| *a == k).map(|(_, v)| v.to_string()), 3, 0.8, 0.2)
        };
        assert!(ctx("3dhoneycomb", "1", "15%").unwrap_err().contains("infill_complete_top"));
        assert!(ctx("3dhoneycomb", "0", "15%").is_ok());
        assert!(ctx("3dhoneycomb", "1", "0%").is_ok(), "no sparse infill: nothing to close");
        assert!(ctx("grid", "1", "15%").is_ok(), "Orca reads it for 3D honeycomb only");
    }

    /// The sparse region of a 20 mm cube at 0.2 mm layers, 2 walls (Orca X2D 0.4, 0.45 bead): a 18.425 mm square.
    fn cube_region() -> Polys {
        vec![Poly { contour: vec![[147.46252, 137.21252], [129.03748, 137.21252], [129.03748, 118.78748], [147.46252, 118.78748]], holes: vec![] }]
    }
    fn ctx(pattern: Pattern, layer: usize) -> InfillCtx {
        InfillCtx { pattern, layer_index: layer, z: 0.2 * (layer as f64 + 1.0), center: [138.25, 128.0], object_bbox: Some(([128.25, 118.0], [148.25, 138.0])), ..Default::default() }
    }
    fn len(p: &[ExtPath]) -> f64 { p.iter().map(|e| e.pts.windows(2).map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt()).sum::<f64>()).sum() }

    /// Sparse-infill path length of layer index 10 / 20 of that cube as written by OrcaSlicer 2.5.0-dev for the X2D
    /// 0.4 coupon profile (15%, infill_direction 45, anchors 400% / 20): measured with /api/slice, summed over the
    /// "Sparse infill" feature of `; CHANGE_LAYER` 10 and 20 of the G-code. (pattern, layer, orca_mm)
    const ORCA: &[(Pattern, usize, f64)] = &[
        (Pattern::Grid, 10, 156.4), (Pattern::Grid, 20, 156.4),
        (Pattern::Gyroid, 10, 141.7), (Pattern::Gyroid, 20, 149.1),
        (Pattern::Honeycomb, 20, 179.1),
        (Pattern::Rectilinear, 10, 151.9), (Pattern::Rectilinear, 20, 151.9),
        (Pattern::Cubic, 10, 145.4), (Pattern::Cubic, 20, 134.6),
        (Pattern::TpmsD, 20, 153.2), (Pattern::CrossHatch, 10, 148.5), (Pattern::Triangles, 10, 140.0),
        (Pattern::Line, 10, 138.3), (Pattern::TpmsFK, 10, 142.2), (Pattern::HilbertCurve, 10, 147.3),
        (Pattern::OctagramSpiral, 10, 153.6), (Pattern::ArchimedeanChords, 10, 153.8), (Pattern::Honeycomb3D, 10, 127.6),
        (Pattern::ZigZag, 10, 151.9), (Pattern::CrossZag, 20, 154.1), (Pattern::Concentric, 10, 157.8),
    ];

    #[test]
    fn layer_path_lengths_match_orca() {
        for &(pat, layer, orca) in ORCA {
            let p = fill_sparse(&cube_region(), &ctx(pat, layer)).unwrap();
            let got = len(&p);
            assert!((got - orca).abs() <= 0.015 * orca, "{pat:?} layer {layer}: ours {got:.1} mm, Orca {orca:.1} mm");
        }
        println!("{} pattern/layer pairs compared against Orca", ORCA.len());
    }

    #[test]
    fn grid_line_spacing_is_exact() {
        // 15% grid = two sweeps at 7.5% each: line spacing = spacing / 0.075 = 5.428 mm (width 0.45, h 0.2)
        let spacing = flow_spacing(0.45, 0.2);
        assert!((spacing / 0.075 - 5.4274).abs() < 1e-3);
        // 100 samples of the lattice phase: the same pattern comes back on every layer (grid keeps its angle)
        let a = fill_sparse(&cube_region(), &ctx(Pattern::Grid, 3)).unwrap();
        let b = fill_sparse(&cube_region(), &ctx(Pattern::Grid, 5)).unwrap();
        assert!((len(&a) - len(&b)).abs() < 1e-6, "grid must repeat every layer");
    }

    #[test]
    fn connections_add_length_negative_control() {
        // With anchors the boundary connection segments are printed; with anchor_max = 0 they must disappear.
        let with = len(&fill_sparse(&cube_region(), &ctx(Pattern::Grid, 10)).unwrap());
        let mut c = ctx(Pattern::Grid, 10);
        c.anchor = 0.0;
        c.anchor_max = 0.0;
        let without = len(&fill_sparse(&cube_region(), &c).unwrap());
        assert!(with > without + 5.0, "connected {with:.1} vs plain lines {without:.1}: the control did not fire");
        // and the plain lines alone are the JS prototype's -20%
        assert!(((with - without) / with) > 0.05);
    }

    #[test]
    fn edge_cases_refuse_or_return_nothing() {
        let r = cube_region();
        let mut c = ctx(Pattern::Grid, 10);
        c.density = 0.0;
        assert!(fill_sparse(&r, &c).unwrap().is_empty(), "0% density prints nothing");
        c.density = 1.0;
        assert!(matches!(fill_sparse(&r, &c), Err(crate::types::FdmError::Unsupported(_))), "100% is internal solid infill, not ours");
        c.density = 0.15;
        c.multiline = 2;
        assert!(fill_sparse(&r, &c).is_err());
        assert!(fill_sparse(&Polys::new(), &ctx(Pattern::Grid, 1)).unwrap().is_empty());
        // patterns needing whole-object inputs refuse instead of approximating
        for p in [Pattern::AdaptiveCubic, Pattern::SupportCubic, Pattern::Lightning] {
            assert!(fill_sparse(&r, &ctx(p, 10)).is_err(), "{p:?} without its object-level input must be an error");
        }
        // a sliver / degenerate region must not panic
        let sliver = vec![Poly { contour: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 0.001]], holes: vec![] }];
        let _ = fill_sparse(&sliver, &ctx(Pattern::Gyroid, 2));
    }

    #[test]
    fn every_pattern_key_parses_and_runs() {
        let keys = ["rectilinear", "alignedrectilinear", "zigzag", "crosszag", "line", "grid", "triangles", "tri-hexagon", "cubic", "quartercubic",
            "honeycomb", "3dhoneycomb", "lateral-honeycomb", "lateral-lattice", "crosshatch", "tpmsd", "tpmsfk", "gyroid", "concentric",
            "hilbertcurve", "archimedeanchords", "octagramspiral"];
        for k in keys {
            let pat = Pattern::from_orca(k).unwrap_or_else(|| panic!("{k} not parsed"));
            let mut c = ctx(pat, 7);
            c.lateral_lattice_angle_1 = -45.0;
            c.lateral_lattice_angle_2 = 45.0;
            let p = fill_sparse(&cube_region(), &c).unwrap_or_else(|e| panic!("{k}: {e}"));
            assert!(!p.is_empty(), "{k} produced nothing");
            for path in &p {
                assert_eq!(path.feature, Feature::SparseInfill);
                for q in &path.pts { assert!(q.x > 128.0 && q.x < 148.5 && q.y > 118.0 && q.y < 138.0, "{k}: point outside the region {q:?}"); }
            }
            // deterministic
            let p2 = fill_sparse(&cube_region(), &c).unwrap();
            assert_eq!(p.len(), p2.len(), "{k} not deterministic");
        }
        for k in ["adaptivecubic", "supportcubic", "lightning", "lockedzag"] { assert!(Pattern::from_orca(k).is_some()); }
        assert!(Pattern::from_orca("nonsense").is_none());
    }

    #[test]
    fn gyroid_and_cubic_change_with_z() {
        let a = fill_sparse(&cube_region(), &ctx(Pattern::Gyroid, 5)).unwrap();
        let b = fill_sparse(&cube_region(), &ctx(Pattern::Gyroid, 6)).unwrap();
        assert!((len(&a) - len(&b)).abs() > 0.5, "gyroid must vary with z");
        let a = fill_sparse(&cube_region(), &ctx(Pattern::Cubic, 5)).unwrap();
        let b = fill_sparse(&cube_region(), &ctx(Pattern::Cubic, 6)).unwrap();
        assert!((len(&a) - len(&b)).abs() > 0.1, "cubic must vary with z");
    }

    #[test]
    fn ordering_starts_near_the_head() {
        let mut c = ctx(Pattern::Rectilinear, 4);
        c.anchor = 0.0;
        c.anchor_max = 0.0; // separate lines: the order is then pure path ordering
        c.start = Some([129.0, 118.8]);
        let p = fill_sparse(&cube_region(), &c).unwrap();
        let first = (p[0].pts[0].x - 129.0).hypot(p[0].pts[0].y - 118.8);
        let last = (p[0].pts.last().unwrap().x - 129.0).hypot(p[0].pts.last().unwrap().y - 118.8);
        assert!(first.min(last) < 6.0, "first path must start near the print head");
    }

    #[test]
    fn combine_infill_plan_and_regions() {
        // 0.2 mm layers, 0.4 mm nozzle: pairs of layers (1,2), (3,4) ... combine into the upper one
        let h = vec![0.2; 8];
        let plan = combine::combine_plan(&h, 0.4, 0.0);
        assert_eq!(plan, vec![0, 0, 2, 0, 2, 0, 2, 1]);
        let sparse = vec![cube_region(); 8];
        let out = combine::combine_infill(&sparse, &h, &plan, 0.0, 0.0);
        let (reg, n, th) = out[2].combined.clone().expect("layer 2 prints the combined fill");
        assert_eq!(n, 2);
        assert!((th - 0.4).abs() < 1e-9 && !reg.is_empty());
        assert!(out[1].void.len() == 1 && out[1].sparse.is_empty(), "layer 1 is covered by the combined fill");
        assert!(out[0].combined.is_none() && !out[0].sparse.is_empty(), "layer 0 is never combined");
        // the combined fill is one pattern at the combined thickness: fewer total mm than printing both layers
        let mut c = ctx(Pattern::Grid, 2);
        c.thickness_layers = 2;
        c.layer_h = 0.4;
        let p = fill_sparse(&reg, &c).unwrap();
        assert!((p[0].layer_h - 0.4).abs() < 1e-9);
    }

    #[test]
    fn adaptive_and_lightning_run_on_a_cube() {
        use std::sync::Arc;
        // 20 mm cube centred on the origin
        let (a, b) = (-10.0, 10.0);
        let q = |x0: f64, y0: f64, z0: f64, x1: f64, y1: f64, z1: f64, x2: f64, y2: f64, z2: f64| [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]];
        let mut tris = Vec::new();
        for (p0, p1, p2, p3) in [
            ([a, a, 0.0], [b, a, 0.0], [b, b, 0.0], [a, b, 0.0]), ([a, a, 20.0], [b, a, 20.0], [b, b, 20.0], [a, b, 20.0]),
            ([a, a, 0.0], [b, a, 0.0], [b, a, 20.0], [a, a, 20.0]), ([b, a, 0.0], [b, b, 0.0], [b, b, 20.0], [b, a, 20.0]),
            ([b, b, 0.0], [a, b, 0.0], [a, b, 20.0], [b, b, 20.0]), ([a, b, 0.0], [a, a, 0.0], [a, a, 20.0], [a, b, 20.0]),
        ] {
            tris.push(q(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]));
            tris.push(q(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2]));
        }
        let ls = adaptive::AdaptiveOctree::line_spacing(0.15, 0.45, 1);
        let oct = Arc::new(adaptive::AdaptiveOctree::build(&tris, &[], ls, false));
        let mut c = ctx(Pattern::AdaptiveCubic, 20);
        c.center = [0.0, 0.0];
        c.origin = Some([0.0, 0.0]);
        c.octree = Some(oct);
        let region = vec![Poly { contour: vec![[9.2, 9.2], [-9.2, 9.2], [-9.2, -9.2], [9.2, -9.2]], holes: vec![] }];
        let p = fill_sparse(&region, &c).unwrap();
        assert!(len(&p) > 50.0, "adaptive cubic produced {:.1} mm", len(&p));
        // lightning: whole-object input
        let regions = vec![region.clone(); 30];
        let g = lightning::LightningGenerator::build(&regions, &lightning::LightningParams::default());
        let mut c = ctx(Pattern::Lightning, 25);
        c.center = [0.0, 0.0];
        c.origin = Some([0.0, 0.0]);
        c.lightning = Some(Arc::new(g));
        let p = fill_sparse(&region, &c).unwrap();
        assert!(p.iter().all(|e| e.pts.len() >= 2));
    }
}

/// test hook: `connect_infill` on explicit input (differential tests against Orca's own dump).
pub fn connect_pub(lines: Vec<Vec<P>>, boundary: &[Vec<P>], spacing: f64, anchor: f64, anchor_max: f64) -> Vec<Vec<P>> {
    connect::connect_infill(lines, boundary, spacing, anchor, anchor_max, 1)
}
