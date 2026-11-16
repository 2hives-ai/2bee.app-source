//! Lane 9: pre-print analysis. `preflight(mesh, config, layers) -> PreflightReport`
//!
//! Answers, deterministically and without any AI call: *what must the user know / set up before this part
//! can be sent to the printer?*  Bed fit and placement, filament/time estimate, overhang area that needs
//! support, bridge spans, features too thin to print, first-layer adhesion risk, tall-slender stability,
//! warp risk by material, recommended filament/nozzle/plate/temperatures/AMS slots, and a list of plain
//! language `setup` lines.  Output is a serde struct (`to_json`) and a text rendering (`to_text`).
//!
//! Provenance of every number (rule of this crate: say which one is measured and which one is a rule of thumb):
//!  * geometry numbers (areas, spans, widths, volumes, centre of mass) are computed from the mesh / layer polygons;
//!  * the overhang test is Orca's own layer-difference rule (`SupportMaterial`: a layer area is an overhang where it
//!    sticks out of the layer below offset by `h / tan(threshold+1deg)`);
//!  * the material table (`material_profile`) is HEURISTIC knowledge (typical values), NOT measured here;
//!  * the filament/time estimate is a model, its error against Orca is measured in `improve::eval` (see IMPROVEMENTS.md).
//!
//! `layers` must come from the same placed mesh (`slice::slice`). Missing config keys fall back to a stated
//! default and are listed in `assumptions` (never silently).
use crate::config::Config;
use crate::geom;
use crate::mesh::Mesh;
use crate::types::{Layer, Polys};
use serde::Serialize;

type Pt = [f64; 2];

// ------------------------------------------------------------------ options
#[derive(Clone, Debug)]
pub struct PreflightOptions {
    /// The accumulated overhang area (mm^2 over all layers) below this is ignored (slivers from slicing noise).
    pub min_overhang_area_mm2: f64,
    /// A cantilever (overhang with a free edge) smaller than this accumulated area (mm^2) prints with a rough underside and is not
    /// called 'needs support' (the raw `has_overhang` flag still reports it). 20 mm^2: the pnp coupon has 13.8 mm^2 of tiny ledges.
    pub min_cantilever_area_mm2: f64,
    /// Bridge direction sweep step (degrees).
    pub bridge_angle_step_deg: f64,
    /// Cap on layers analysed for thin-feature / feature-width scans (evenly sampled); the count is reported.
    pub max_thin_layers: usize,
    /// Cap on overhang components analysed per layer for bridges (largest first).
    pub max_bridge_components: usize,
}
impl Default for PreflightOptions {
    fn default() -> Self { PreflightOptions { min_overhang_area_mm2: 1.0, min_cantilever_area_mm2: 20.0, bridge_angle_step_deg: 7.5, max_thin_layers: 60, max_bridge_components: 12 } }
}

// ------------------------------------------------------------------ report types
#[derive(Clone, Debug, Serialize)]
pub struct BedFit {
    pub printable_bbox: [f64; 4],
    pub printable_height: f64,
    pub footprint: [f64; 3],
    pub fits_xy: bool,
    pub fits_xy_rotated_90: bool,
    pub fits_height: bool,
    /// Smallest clearance to the bed edge when centred (mm); negative = does not fit.
    pub margin_mm: f64,
    pub centre_xy: [f64; 2],
}

#[derive(Clone, Debug, Serialize)]
pub struct Estimate {
    pub height_mm: f64,
    pub layer_count: usize,
    pub volume_cm3: f64,
    pub shell_cm3: f64,
    pub solid_cm3: f64,
    pub sparse_cm3: f64,
    pub filament_mm: f64,
    pub filament_g: f64,
    pub time_min: f64,
    /// Rough upper bound for support material (cm^3), 0 when no support is needed.
    pub support_cm3_upper: f64,
}

/// Surface area by slope from horizontal (both facings). Drives the layer-height rule: slanted faces show stair-stepping.
#[derive(Clone, Debug, Serialize)]
pub struct Surface { pub total_mm2: f64, pub flat_mm2: f64, pub vertical_mm2: f64, pub gentle_slant_mm2: f64, pub steep_slant_mm2: f64, pub slant_share: f64, pub gentle_share: f64 }

#[derive(Clone, Debug, Serialize)]
pub struct Band { pub z0: f64, pub z1: f64, pub area_mm2: f64, pub bbox: [f64; 4] }

#[derive(Clone, Debug, Serialize)]
pub struct Overhang {
    pub threshold_deg: f64,
    /// Sum over layers of the area that sticks out beyond the printable-without-support limit (mm^2).
    pub needs_support_area_mm2: f64,
    /// Same quantity from the mesh normals (projected area of down-facing triangles flatter than the threshold, not on the bed).
    /// `None` when the mesh winding is not trustworthy (see `MeshHealth`), so the normals cannot be oriented.
    pub needs_support_area_normals_mm2: Option<f64>,
    pub layers_affected: usize,
    pub bands: Vec<Band>,
    /// Area that will print but with a rough underside (sticks out more than half a line width, within the threshold).
    pub rough_area_mm2: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Bridge { pub z: f64, pub span_mm: f64, pub angle_deg: f64, pub area_mm2: f64, pub bbox: [f64; 4] }

#[derive(Clone, Debug, Serialize)]
pub struct Bridges {
    pub count: usize,
    pub max_span_mm: f64,
    pub limit_mm: f64,
    pub over_limit: usize,
    /// Overhang area that is NOT a bridge (free end on at least one side in every direction): a cantilever.
    pub cantilever_area_mm2: f64,
    pub list: Vec<Bridge>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThinFeatures {
    pub line_width_mm: f64,
    pub wall_generator: String,
    /// Width below which a feature produces no extrusion at all with this wall generator.
    pub unprintable_below_mm: f64,
    /// Max over sampled layers of the area narrower than `unprintable_below_mm`.
    pub unprintable_area_mm2: f64,
    pub unprintable_layers: usize,
    /// Area narrower than two line widths (single bead / wall-only, no infill).
    pub wall_only_area_mm2: f64,
    pub smallest_feature_mm: Option<f64>,
    pub layers_sampled: usize,
    pub bands: Vec<Band>,
    pub will_print: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct FirstLayer {
    pub contact_area_mm2: f64,
    pub contact_bbox: [f64; 4],
    pub com_xy: [f64; 2],
    pub com_height_mm: f64,
    pub com_over_contact: bool,
    pub slenderness: f64,
    pub points: u32,
    pub risk: String,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Column { pub z0: f64, pub z1: f64, pub width_mm: f64, pub aspect: f64, pub at: [f64; 2] }

#[derive(Clone, Debug, Serialize)]
pub struct Stability { pub slenderness: f64, pub tall_slender: bool, pub columns: Vec<Column> }

/// What the STL itself looks like (reported, never repaired). Volume/centre of mass below come from the SLICED
/// layers, which is what will print; the mesh numbers are shown so a disagreement is visible.
#[derive(Clone, Debug, Serialize)]
pub struct MeshHealth { pub watertight: bool, pub open_edges: usize, pub flipped_edges: usize, pub nonmanifold_edges: usize, pub mesh_volume_cm3: f64, pub layer_volume_cm3: f64, pub volume_agrees: bool }

#[derive(Clone, Debug, Serialize)]
pub struct Warp { pub material: String, pub factor: f64, pub score: f64, pub risk: String }

#[derive(Clone, Debug, Serialize)]
pub struct AmsSlot { pub role: String, pub filament_type: String, pub note: String }

#[derive(Clone, Debug, Serialize)]
pub struct Recommend {
    pub filament_type: String,
    pub filament_reason: String,
    pub nozzle_mm: f64,
    pub nozzle_reason: String,
    pub bed_plate: String,
    pub nozzle_temp: f64,
    pub bed_temp: f64,
    pub temp_note: String,
    pub ams_slots: Vec<AmsSlot>,
    pub brim_mm: f64,
}

/// The booleans a downstream rule (autoconfig) or a validation reads. Defined once, here.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Flags {
    pub fits_bed: bool,
    /// Any surface flatter than the support threshold exists (what Orca would put support under).
    pub has_overhang: bool,
    /// Cannot be printed well without support: a cantilever, or a bridge longer than the material limit.
    pub needs_support: bool,
    pub bridge_over_limit: bool,
    pub has_bridge: bool,
    pub thin_unprintable: bool,
    pub thin_wall_only: bool,
    pub adhesion_risk_high: bool,
    pub adhesion_risk_medium_or_high: bool,
    pub tall_slender: bool,
    pub warp_high: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreflightReport {
    pub bed: BedFit,
    pub estimate: Estimate,
    pub overhang: Overhang,
    pub surface: Surface,
    pub bridges: Bridges,
    pub thin: ThinFeatures,
    pub first_layer: FirstLayer,
    pub stability: Stability,
    pub mesh_health: MeshHealth,
    pub warp: Warp,
    pub recommend: Recommend,
    pub flags: Flags,
    /// Plain-language things the user must do or know. Ordered by importance.
    pub setup: Vec<String>,
    /// Config keys that were missing and the default used instead.
    pub assumptions: Vec<String>,
    /// Population examined (layers, triangles) so an empty input cannot read as a clean pass.
    pub population: Population,
}
#[derive(Clone, Debug, Serialize)]
pub struct Population { pub layers: usize, pub triangles: usize, pub layers_with_region: usize, /// contours + holes summed over layers
    pub rings_total: usize }

impl PreflightReport {
    pub fn to_json(&self) -> serde_json::Value { serde_json::to_value(self).expect("serialisable") }
    pub fn to_text(&self) -> String { render_text(self) }
}

// ------------------------------------------------------------------ material table (HEURISTIC)
/// Typical values per filament family. NOT measured here; each entry is a rule of thumb.
#[derive(Clone, Debug)]
pub struct MatProfile {
    pub family: String,
    pub warp: f64,
    pub bridge_limit_mm: f64,
    pub plate: &'static str,
    pub bed_temp: f64,
    pub enclosure: bool,
    pub dry: bool,
    pub abrasive: bool,
    pub ams_ok: bool,
}
pub fn material_profile(filament_type: &str) -> MatProfile {
    let t = filament_type.to_ascii_uppercase();
    let abrasive = t.contains("CF") || t.contains("GF");
    let fam = if t.starts_with("PLA") { "PLA" } else if t.starts_with("PETG") || t == "PET" || t.starts_with("PET-") { "PETG" }
        else if t.starts_with("ABS") { "ABS" } else if t.starts_with("ASA") { "ASA" } else if t.starts_with("PC") { "PC" }
        else if t.starts_with("PA") { "PA" } else if t.starts_with("TPU") { "TPU" } else { "OTHER" };
    let (warp, bridge, plate, bed, enc, dry, ams) = match fam {
        "PLA" => (0.10, 25.0, "Textured PEI Plate", 55.0, false, false, true),
        "PETG" => (0.30, 12.0, "Textured PEI Plate", 70.0, false, true, true),
        "ABS" => (0.90, 10.0, "Engineering Plate", 100.0, true, false, true),
        "ASA" => (0.80, 10.0, "Engineering Plate", 100.0, true, false, true),
        "PC" => (1.00, 8.0, "Engineering Plate", 100.0, true, true, true),
        "PA" => (0.90, 8.0, "Engineering Plate", 90.0, true, true, true),
        "TPU" => (0.05, 5.0, "Textured PEI Plate", 35.0, false, true, false),
        _ => (0.40, 10.0, "Textured PEI Plate", 60.0, false, false, true),
    };
    // fibre filled grades warp noticeably less than the base polymer
    let warp = if abrasive { warp * 0.6 } else { warp };
    MatProfile { family: fam.to_string(), warp, bridge_limit_mm: bridge, plate, bed_temp: bed, enclosure: enc, dry, abrasive, ams_ok: ams }
}

// ------------------------------------------------------------------ small helpers
struct Cfg<'a> { c: &'a Config, assumptions: Vec<String> }
impl<'a> Cfg<'a> {
    fn f(&mut self, key: &str, default: f64) -> f64 {
        match self.c.f64(key) { Ok(v) => v, Err(_) => { self.assumptions.push(format!("{key} missing -> assumed {default}")); default } }
    }
    fn fp(&mut self, key: &str, base: f64, default: f64) -> f64 {
        match self.c.float_or_percent(key) { Ok(v) => { let r = v.resolve(base); if r > 0.0 { r } else { default } } Err(_) => { self.assumptions.push(format!("{key} missing -> assumed {default}")); default } }
    }
    fn s(&mut self, key: &str, default: &str) -> String {
        match self.c.str_list(key) { Ok(v) if !v.is_empty() => v[0].clone(), _ => { self.assumptions.push(format!("{key} missing -> assumed {default}")); default.to_string() } }
    }
    fn i(&mut self, key: &str, default: i64) -> i64 {
        match self.c.i64(key) { Ok(v) => v, Err(_) => { self.assumptions.push(format!("{key} missing -> assumed {default}")); default } }
    }
}

fn bbox_of(p: &Polys) -> [f64; 4] { geom::bbox(p).unwrap_or([0.0; 4]) }
fn poly_area(q: &crate::types::Poly) -> f64 { geom::area(&vec![q.clone()]) }
fn dist(a: Pt, b: Pt) -> f64 { (a[0] - b[0]).hypot(a[1] - b[1]) }

fn convex_hull(mut pts: Vec<Pt>) -> Vec<Pt> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 { return pts; }
    let cross = |o: Pt, a: Pt, b: Pt| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut h: Vec<Pt> = Vec::new();
    for &p in &pts { while h.len() >= 2 && cross(h[h.len() - 2], h[h.len() - 1], p) <= 0.0 { h.pop(); } h.push(p); }
    let lo = h.len() + 1;
    for &p in pts.iter().rev().skip(1) { while h.len() >= lo && cross(h[h.len() - 2], h[h.len() - 1], p) <= 0.0 { h.pop(); } h.push(p); }
    h.pop();
    h
}
fn in_hull(h: &[Pt], p: Pt) -> bool {
    if h.len() < 3 { return false; }
    h.iter().zip(h.iter().cycle().skip(1)).all(|(a, b)| (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9)
}

/// Centre of mass and signed volume of a closed mesh (divergence theorem, tetrahedra to the origin).
pub fn mesh_com(mesh: &Mesh) -> ([f64; 3], f64) {
    let (mut v, mut c) = (0.0, [0.0; 3]);
    for i in 0..mesh.tris.len() {
        let [a, b, d] = mesh.tri(i);
        let vol = (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6.0;
        v += vol;
        for k in 0..3 { c[k] += vol * (a[k] + b[k] + d[k]) / 4.0; }
    }
    if v.abs() < 1e-12 { return ([0.0; 3], 0.0); }
    ([c[0] / v, c[1] / v, c[2] / v], v)
}

/// Centre of mass (x, y, z) and volume (mm^3) of the sliced layers: what will actually be printed. Robust to bad STL winding.
pub fn layers_com(layers: &[Layer], h_of: &dyn Fn(usize) -> f64) -> ([f64; 3], f64) {
    let (mut v, mut c) = (0.0, [0.0; 3]);
    for (i, l) in layers.iter().enumerate() {
        let h = h_of(i);
        for q in &l.region {
            // area-weighted centroid of (contour - holes)
            let (a, cx, cy) = ring_centroid(&q.contour);
            let (mut sa, mut sx, mut sy) = (a.abs(), a.abs() * cx, a.abs() * cy);
            for hole in &q.holes { let (ha, hx, hy) = ring_centroid(hole); sa -= ha.abs(); sx -= ha.abs() * hx; sy -= ha.abs() * hy; }
            if sa <= 1e-12 { continue; }
            let vol = sa * h;
            v += vol;
            c[0] += vol * sx / sa; c[1] += vol * sy / sa; c[2] += vol * (l.z - 0.5 * h);
        }
    }
    if v <= 0.0 { return ([0.0; 3], 0.0); }
    ([c[0] / v, c[1] / v, c[2] / v], v)
}
/// (signed area, cx, cy) of a ring.
fn ring_centroid(r: &[Pt]) -> (f64, f64, f64) {
    let n = r.len();
    if n < 3 { return (0.0, 0.0, 0.0); }
    let (mut a, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..n { let (p, q) = (r[i], r[(i + 1) % n]); let w = p[0] * q[1] - q[0] * p[1]; a += w; cx += (p[0] + q[0]) * w; cy += (p[1] + q[1]) * w; }
    a *= 0.5;
    if a.abs() < 1e-12 { return (0.0, r[0][0], r[0][1]); }
    (a, cx / (6.0 * a), cy / (6.0 * a))
}

// ------------------------------------------------------------------ the analysis
pub fn preflight(mesh: &Mesh, cfg: &Config, layers: &[Layer]) -> PreflightReport { preflight_with(mesh, cfg, layers, &PreflightOptions::default()) }

pub fn preflight_with(mesh: &Mesh, cfg: &Config, layers: &[Layer], opt: &PreflightOptions) -> PreflightReport {
    let mut c = Cfg { c: cfg, assumptions: vec![] };
    let (mn, mx) = mesh.bbox();
    let dims = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    let health = mesh.validate();
    let (_mcom, signed_vol) = mesh_com(mesh);
    let (com, volume_mm3) = layers_com(layers, &|i| if layers[i].h > 0.0 { layers[i].h } else if i > 0 { layers[i].z - layers[i - 1].z } else { layers[i].z });
    let com = [com[0], com[1], com[2]];
    let trust_normals = health.is_watertight();

    // ---- config
    let line_w = c.f("line_width", 0.42);
    let outer_w = c.f("outer_wall_line_width", line_w);
    let nozzle = c.s("nozzle_diameter", "0.4").parse::<f64>().unwrap_or(0.4);
    let wall_gen = c.s("wall_generator", "classic");
    let thr = { let a = c.f("support_threshold_angle", 30.0); if a < 1e-6 { 30.0 } else { a } };
    let wall_loops = c.i("wall_loops", 2).max(1) as f64;
    let top_layers = c.i("top_shell_layers", 5).max(0) as usize;
    let bot_layers = c.i("bottom_shell_layers", 3).max(0) as usize;
    let density = { let d = c.fp("sparse_infill_density", 100.0, 15.0); d / 100.0 };
    let flow_ratio = c.f("filament_flow_ratio", 1.0);
    let fil_d = c.f("filament_diameter", 1.75);
    let fil_density = c.f("filament_density", 1.24);
    let ftype = c.s("filament_type", "PLA");
    let mat = material_profile(&ftype);
    if mat.family == "OTHER" { c.assumptions.push(format!("filament_type '{ftype}' not in the material table -> generic profile")); }

    // ---- bed
    let bed_pts = cfg.points("printable_area").ok().filter(|p| p.len() >= 3);
    if bed_pts.is_none() { c.assumptions.push("printable_area missing -> assumed 256x256".into()); }
    let pb = bed_pts.map(|p| { let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]; for q in &p { b[0] = b[0].min(q[0]); b[1] = b[1].min(q[1]); b[2] = b[2].max(q[0]); b[3] = b[3].max(q[1]); } b }).unwrap_or([0.0, 0.0, 256.0, 256.0]);
    let pheight = c.f("printable_height", 250.0);
    let (bw, bh) = (pb[2] - pb[0], pb[3] - pb[1]);
    let fits_xy = dims[0] <= bw + 1e-6 && dims[1] <= bh + 1e-6;
    let fits_rot = dims[1] <= bw + 1e-6 && dims[0] <= bh + 1e-6;
    let bed = BedFit {
        printable_bbox: pb, printable_height: pheight, footprint: dims, fits_xy, fits_xy_rotated_90: fits_rot, fits_height: dims[2] <= pheight + 1e-6,
        margin_mm: ((bw - dims[0]) / 2.0).min((bh - dims[1]) / 2.0),
        centre_xy: [(pb[0] + pb[2]) / 2.0, (pb[1] + pb[3]) / 2.0],
    };

    let nl = layers.len();
    let h_of = |i: usize| if layers[i].h > 0.0 { layers[i].h } else if i > 0 { layers[i].z - layers[i - 1].z } else { layers[i].z };

    // ---- overhang (Orca layer-difference rule) + bridges
    let thr_eff = (thr + 1.0).to_radians();
    let mut ov_area = 0.0;
    let mut support_col = 0.0; // sum over overhang layers of area * height above the bed: a support column straight down
    let mut rough_area = 0.0;
    let mut ov_layers = 0usize;
    let mut bands: Vec<Band> = Vec::new();
    let mut open_band: Option<Band> = None;
    let mut bridges: Vec<Bridge> = Vec::new();
    let mut cantilever = 0.0;
    let mut bridge_area_total = 0.0;
    for i in 1..nl {
        if layers[i].region.is_empty() { continue; }
        let h = h_of(i);
        let off = h / thr_eff.tan();
        let lower = &layers[i - 1].region;
        let ov = geom::opening(&geom::diff(&layers[i].region, &geom::offset(lower, off)), 0.004);
        let ov: Polys = ov.into_iter().filter(|q| poly_area(q) >= 0.05).collect(); // per-layer noise floor; the decision uses the accumulated area
        let a = geom::area(&ov);
        // rough underside: sticks out > half a line width but within the threshold
        let ov_soft = geom::opening(&geom::diff(&layers[i].region, &geom::offset(lower, 0.5 * outer_w)), 0.1);
        rough_area += (geom::area(&ov_soft) - a).max(0.0);
        if a > 0.0 {
            ov_area += a;
            support_col += a * (layers[i].z - h);
            ov_layers += 1;
            let bb = bbox_of(&ov);
            match &mut open_band {
                Some(b) if (layers[i].z - b.z1 - h).abs() < 1e-6 || layers[i].z - b.z1 <= h * 1.5 => {
                    b.z1 = layers[i].z; b.area_mm2 += a;
                    b.bbox = [b.bbox[0].min(bb[0]), b.bbox[1].min(bb[1]), b.bbox[2].max(bb[2]), b.bbox[3].max(bb[3])];
                }
                _ => { if let Some(b) = open_band.take() { bands.push(b); } open_band = Some(Band { z0: layers[i].z - h, z1: layers[i].z, area_mm2: a, bbox: bb }); }
            }
            // bridges: components of the unsupported region anchored on both sides along some direction
            let mut comps: Vec<&crate::types::Poly> = ov.iter().collect();
            comps.sort_by(|p, q| poly_area(q).partial_cmp(&poly_area(p)).unwrap());
            let anchor = geom::offset(lower, off + 0.05);
            for q in comps.into_iter().take(opt.max_bridge_components) {
                let qa = poly_area(q);
                match bridge_span(&vec![q.clone()], &anchor, opt.bridge_angle_step_deg) {
                    Some((span, ang)) => { bridge_area_total += qa; bridges.push(Bridge { z: layers[i].z, span_mm: span, angle_deg: ang, area_mm2: qa, bbox: bbox_of(&vec![q.clone()]) }); }
                    None => cantilever += qa,
                }
            }
        } else if let Some(b) = open_band.take() { bands.push(b); }
    }
    if let Some(b) = open_band.take() { bands.push(b); }
    let _ = bridge_area_total;

    // normals method
    let z_bed = mn[2];
    let mut normals_area = 0.0;
    let mut surf = Surface { total_mm2: 0.0, flat_mm2: 0.0, vertical_mm2: 0.0, gentle_slant_mm2: 0.0, steep_slant_mm2: 0.0, slant_share: 0.0, gentle_share: 0.0 };
    for i in 0..mesh.tris.len() {
        let [a, b, d] = mesh.tri(i);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len < 1e-12 { continue; }
        // mesh may be inside-out: orient by the sign of the volume
        let s = if signed_vol < 0.0 { -1.0 } else { 1.0 };
        let nz = s * n[2] / len;
        {
            let ar = 0.5 * len;
            let alpha = nz.abs().clamp(0.0, 1.0).acos().to_degrees(); // slope from horizontal
            surf.total_mm2 += ar;
            if alpha < 5.0 { surf.flat_mm2 += ar } else if alpha > 85.0 { surf.vertical_mm2 += ar } else if alpha < 45.0 { surf.gentle_slant_mm2 += ar } else { surf.steep_slant_mm2 += ar }
        }
        if nz >= 0.0 || !trust_normals { continue; }
        let zmax = a[2].max(b[2]).max(d[2]);
        if zmax <= z_bed + 0.05 { continue; }
        // slope from horizontal alpha = acos(|nz|); needs support when alpha < threshold (same rule as above, effective angle)
        let alpha = (-nz).clamp(-1.0, 1.0).acos();
        if alpha < thr_eff { normals_area += 0.5 * len * (-nz); }
    }
    let mesh_health = MeshHealth { watertight: trust_normals, open_edges: health.open_edges, flipped_edges: health.flipped_edges, nonmanifold_edges: health.nonmanifold_edges,
        mesh_volume_cm3: signed_vol.abs() / 1000.0, layer_volume_cm3: volume_mm3 / 1000.0, volume_agrees: volume_mm3 > 0.0 && (signed_vol.abs() - volume_mm3).abs() / volume_mm3 < 0.03 };
    surf.gentle_share = if surf.total_mm2 > 0.0 { surf.gentle_slant_mm2 / surf.total_mm2 } else { 0.0 };
    surf.slant_share = if surf.total_mm2 > 0.0 { (surf.gentle_slant_mm2 + surf.steep_slant_mm2) / surf.total_mm2 } else { 0.0 };
    let overhang = Overhang { threshold_deg: thr, needs_support_area_mm2: ov_area, needs_support_area_normals_mm2: if trust_normals { Some(normals_area) } else { None }, layers_affected: ov_layers, bands, rough_area_mm2: rough_area };

    let limit = mat.bridge_limit_mm;
    let max_span = bridges.iter().map(|b| b.span_mm).fold(0.0, f64::max);
    let over = bridges.iter().filter(|b| b.span_mm > limit).count();
    // keep the report short: the longest spans first
    bridges.sort_by(|a, b| b.span_mm.partial_cmp(&a.span_mm).unwrap());
    let nb = bridges.len();
    bridges.truncate(8);
    let bridges_r = Bridges { count: nb, max_span_mm: max_span, limit_mm: limit, over_limit: over, cantilever_area_mm2: cantilever, list: bridges };

    // ---- thin features (sampled layers)
    let is_arachne = wall_gen == "arachne";
    let min_feat = c.fp("min_feature_size", nozzle, 0.25 * nozzle).max(0.0);
    // Arachne: measured on this profile (0.4 nozzle): walls of 0.18 mm are not printed, 0.20 mm are => 0.475 * nozzle (min_feature_size alone, 0.1 mm, is NOT the limit)
    let unprintable_below = if is_arachne { (0.475 * nozzle).max(min_feat) } else { outer_w.max(line_w) };
    let step = ((nl as f64) / (opt.max_thin_layers as f64)).ceil().max(1.0) as usize;
    let sampled: Vec<usize> = (0..nl).step_by(step).filter(|&i| !layers[i].region.is_empty()).collect();
    let (mut thin_max, mut wall_only_max, mut thin_layers) = (0.0f64, 0.0f64, 0usize);
    let mut thin_bands: Vec<Band> = Vec::new();
    let widths = [0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.2, 1.6, 2.4, 3.2];
    let mut smallest: Option<f64> = None;
    for &i in &sampled {
        let reg = &layers[i].region;
        let total = geom::area(reg);
        // features narrower than w: A minus opening by w/2; residue below 0.3 mm^2 is corner noise
        let thin1: Polys = geom::diff(reg, &geom::opening(reg, 0.5 * unprintable_below)).into_iter().filter(|q| poly_area(q) >= 0.3).collect();
        let a1 = geom::area(&thin1);
        let two_w = 2.0 * line_w.max(outer_w);
        let thin2: Polys = geom::diff(reg, &geom::opening(reg, 0.5 * two_w)).into_iter().filter(|q| poly_area(q) >= 0.3).collect();
        wall_only_max = wall_only_max.max(geom::area(&thin2) + 0.0);
        if a1 > 0.0 {
            thin_layers += 1;
            thin_max = thin_max.max(a1);
            let h = h_of(i);
            let bb = bbox_of(&thin1);
            match thin_bands.last_mut() {
                Some(b) if layers[i].z - b.z1 <= h * (step as f64) * 1.5 => { b.z1 = layers[i].z; b.area_mm2 = b.area_mm2.max(a1); b.bbox = [b.bbox[0].min(bb[0]), b.bbox[1].min(bb[1]), b.bbox[2].max(bb[2]), b.bbox[3].max(bb[3])]; }
                _ => thin_bands.push(Band { z0: layers[i].z - h, z1: layers[i].z, area_mm2: a1, bbox: bb }),
            }
        }
        // smallest feature width present with >=0.5% (and >=0.5 mm^2) of the layer area
        for &w in &widths {
            let lost = total - geom::area(&geom::opening(reg, 0.5 * w));
            if lost >= (0.005 * total).max(0.5) { smallest = Some(smallest.map_or(w, |s: f64| s.min(w))); break; }
        }
    }
    thin_bands.truncate(8);
    let thin = ThinFeatures {
        line_width_mm: line_w, wall_generator: wall_gen.clone(), unprintable_below_mm: unprintable_below, unprintable_area_mm2: thin_max.max(0.0) + 0.0,
        unprintable_layers: thin_layers, wall_only_area_mm2: if wall_only_max > 0.0 { wall_only_max } else { 0.0 }, smallest_feature_mm: smallest, layers_sampled: sampled.len(),
        bands: thin_bands, will_print: thin_max < 0.3,
    };

    // ---- first layer / adhesion / stability
    let a0: Polys = layers.first().map(|l| l.region.clone()).unwrap_or_default();
    let contact = geom::area(&a0);
    let cbb = bbox_of(&a0);
    let height = dims[2];
    let hull = convex_hull(a0.iter().flat_map(|q| q.contour.iter().copied()).collect());
    let com_over = in_hull(&hull, [com[0], com[1]]);
    let eq_d = 2.0 * (contact / std::f64::consts::PI).sqrt();
    let slender = if eq_d > 1e-6 { height / eq_d } else { f64::INFINITY };
    let mut pts = 0u32;
    let mut reasons: Vec<String> = Vec::new();
    if contact < 25.0 { pts += 3; reasons.push(format!("tiny bed contact ({contact:.1} mm2)")); }
    else if contact < 100.0 { pts += 2; reasons.push(format!("small bed contact ({contact:.0} mm2)")); }
    else if contact < 400.0 { pts += 1; reasons.push(format!("modest bed contact ({contact:.0} mm2)")); }
    if slender > 3.0 { pts += 2; reasons.push(format!("tall for its footprint (height / footprint diameter = {slender:.1})")); }
    else if slender > 1.5 { pts += 1; reasons.push(format!("height is {slender:.1}x the footprint diameter")); }
    if !com_over { pts += 3; reasons.push("centre of mass is outside the bed-contact area (will tip over without support)".into()); }
    let l_max = (cbb[2] - cbb[0]).max(cbb[3] - cbb[1]);
    if mat.warp * (l_max / 150.0).min(1.0) >= 0.3 { pts += 2; reasons.push(format!("{} warps; first layer spans {:.0} mm", mat.family, l_max)); }
    let risk = if pts >= 4 { "high" } else if pts >= 2 { "medium" } else { "low" };
    let first = FirstLayer {
        contact_area_mm2: contact, contact_bbox: cbb, com_xy: [com[0], com[1]], com_height_mm: com[2] - z_bed, com_over_contact: com_over, slenderness: if slender.is_finite() { slender } else { 1e9 },
        points: pts, risk: risk.to_string(), reasons,
    };

    // slender columns: components < 40 mm^2 tracked by bbox overlap across layers
    let mut columns: Vec<Column> = Vec::new();
    {
        struct Tr { z0: f64, z1: f64, bb: [f64; 4], amin: f64, amax: f64 }
        let mut act: Vec<Tr> = Vec::new();
        let mut done: Vec<Tr> = Vec::new();
        for i in 0..nl {
            let mut next: Vec<Tr> = Vec::new();
            for q in &layers[i].region {
                let a = poly_area(q);
                if a >= 40.0 || a < 0.3 { continue; }
                let bb = bbox_of(&vec![q.clone()]);
                let h = h_of(i);
                if let Some(k) = act.iter().position(|t| t.bb[0] <= bb[2] && bb[0] <= t.bb[2] && t.bb[1] <= bb[3] && bb[1] <= t.bb[3]) {
                    let mut t = act.remove(k);
                    t.z1 = layers[i].z; t.bb = bb; t.amin = t.amin.min(a); t.amax = t.amax.max(a); next.push(t);
                } else { next.push(Tr { z0: layers[i].z - h, z1: layers[i].z, bb, amin: a, amax: a }); }
            }
            done.append(&mut act);
            act = next;
        }
        done.append(&mut act);
        for t in done {
            let w = 2.0 * (t.amax / std::f64::consts::PI).sqrt();
            let hh = t.z1 - t.z0;
            if hh >= 8.0 && hh / w >= 5.0 { columns.push(Column { z0: t.z0, z1: t.z1, width_mm: w, aspect: hh / w, at: [(t.bb[0] + t.bb[2]) / 2.0, (t.bb[1] + t.bb[3]) / 2.0] }); }
        }
        columns.sort_by(|a, b| b.aspect.partial_cmp(&a.aspect).unwrap());
        columns.truncate(6);
    }
    let foot_min = (cbb[2] - cbb[0]).min(cbb[3] - cbb[1]).max(1e-6);
    let slend_box = height / foot_min;
    let tall_slender = slend_box > 4.0 || !columns.is_empty();
    let stability = Stability { slenderness: slend_box, tall_slender, columns };

    // ---- warp
    let wscore = (mat.warp * (l_max / 200.0).min(1.0) * (0.5 + 0.5 * (contact / 2000.0).min(1.0))).min(1.0);
    let warp = Warp { material: mat.family.clone(), factor: mat.warp, score: wscore, risk: (if wscore >= 0.35 { "high" } else if wscore >= 0.12 { "medium" } else { "low" }).to_string() };

    // ---- estimate
    let est = estimate(&mut c, layers, &|i| h_of(i), wall_loops, outer_w, line_w, top_layers, bot_layers, density, flow_ratio, fil_d, fil_density, volume_mm3, ov_area, support_col, dims[2]);

    // ---- recommendations
    let flags = Flags {
        fits_bed: (fits_xy || fits_rot) && bed.fits_height,
        has_overhang: ov_area >= opt.min_overhang_area_mm2,
        needs_support: cantilever >= opt.min_cantilever_area_mm2 || over > 0,
        bridge_over_limit: over > 0,
        has_bridge: nb > 0,
        thin_unprintable: thin_max >= 0.3,
        thin_wall_only: wall_only_max >= 0.3,
        adhesion_risk_high: risk == "high",
        adhesion_risk_medium_or_high: risk != "low",
        tall_slender,
        warp_high: warp.risk == "high",
    };
    let recommend = recommend(&mut c, &mat, &ftype, nozzle, &flags, &thin, &est, &first, &warp, bed.printable_height, dims[2], cfg, overhang.needs_support_area_mm2);

    let population = Population { layers: nl, triangles: mesh.tris.len(), layers_with_region: layers.iter().filter(|l| !l.region.is_empty()).count(), rings_total: layers.iter().map(|l| l.region.iter().map(|q| 1 + q.holes.len()).sum::<usize>()).sum() };
    let mut rep = PreflightReport { bed, estimate: est, overhang, surface: surf, bridges: bridges_r, thin, first_layer: first, stability, mesh_health, warp, recommend, flags, setup: vec![], assumptions: vec![], population };
    rep.setup = setup_lines(&rep, &mat, &ftype);
    rep.assumptions = c.assumptions;
    rep
}

// ------------------------------------------------------------------ bridge span
/// Minimum over sweep directions of the longest chord of `region` whose BOTH ends rest on `anchor`
/// (the lower layer, slightly grown). `None` when no direction has all chords anchored on both sides (cantilever).
fn bridge_span(region: &Polys, anchor: &Polys, step_deg: f64) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64)> = None;
    let mut a = 0.0;
    while a < 180.0 - 1e-9 {
        let segs = geom::hatch(region, a, 1.0, 0.0);
        let (ca, sa) = (a.to_radians().cos(), a.to_radians().sin());
        let mut worst = 0.0f64;
        let mut ok = !segs.is_empty();
        for s in &segs {
            let (p, q) = (s[0], s[1]);
            let l = dist(p, q);
            if l < 0.2 { continue; }
            let pb = [p[0] - 0.1 * ca, p[1] - 0.1 * sa];
            let qb = [q[0] + 0.1 * ca, q[1] + 0.1 * sa];
            if !(geom::point_in_polys(anchor, pb[0], pb[1]) && geom::point_in_polys(anchor, qb[0], qb[1])) { ok = false; break; }
            worst = worst.max(l);
        }
        if ok && worst > 0.0 && best.map_or(true, |(w, _)| worst < w) { best = Some((worst, a)); }
        a += step_deg;
    }
    best
}

// ------------------------------------------------------------------ filament / time estimate
#[allow(clippy::too_many_arguments)]
/// Sparse infill carries more material than `density * area` (boundary connections, crossings). Measured once on a 20 mm cube with
/// crosshatch at 15%: Orca's sparse volume / the naive volume = 1.35 (1.177 / 0.874 cm3). Pattern dependent; calibrated on ONE pattern.
const SPARSE_FACTOR: f64 = 1.30;
fn estimate(c: &mut Cfg, layers: &[Layer], h_of: &dyn Fn(usize) -> f64, wall_loops: f64, outer_w: f64, line_w: f64, top: usize, bot: usize, density: f64,
            flow: f64, fil_d: f64, fil_density: f64, volume_mm3: f64, _ov_area: f64, support_col: f64, height: f64) -> Estimate {
    let nl = layers.len();
    let inner_w = c.f("inner_wall_line_width", line_w);
    let shell_t = outer_w + (wall_loops - 1.0) * inner_w;
    // infill region: inside the walls
    let inner: Vec<Polys> = layers.iter().map(|l| if l.region.is_empty() { vec![] } else { geom::offset(&l.region, -shell_t) }).collect();
    let (mut shell, mut solid, mut sparse) = (0.0, 0.0, 0.0);
    let sp_w = c.f("sparse_infill_line_width", line_w).max(0.1);
    // speeds (mm/s), capped by the volumetric limit
    let vmax = c.f("filament_max_volumetric_speed", 15.0);
    let h_mean = if nl > 0 { height / nl as f64 } else { 0.2 };
    let cap = |v: f64, w: f64| v.min(vmax / (w * h_mean).max(1e-6));
    let v_wall = cap(0.5 * (c.f("outer_wall_speed", 60.0) + c.f("inner_wall_speed", 80.0)), line_w).max(1.0);
    let v_sparse = cap(c.f("sparse_infill_speed", 80.0), sp_w).max(1.0);
    let v_solid = cap(c.f("internal_solid_infill_speed", 100.0), line_w).max(1.0);
    let v_first = c.f("initial_layer_speed", 30.0).max(1.0);
    let min_layer_t = c.f("slow_down_layer_time", 0.0).max(0.0);
    let v_min_slow = c.f("slow_down_min_speed", 10.0).max(1.0);
    let mut t_total = 0.0;
    for i in 0..nl {
        let h = h_of(i);
        let a_all = geom::area(&layers[i].region);
        let a_in = geom::area(&inner[i]);
        let sh = (a_all - a_in).max(0.0);
        shell += sh * h;
        let len_wall = sh / (0.5 * (outer_w + inner_w));
        let (mut len_solid, mut len_sparse) = (0.0, 0.0);
        if a_in > 0.0 {
            // region of this layer that has `top` inner layers above and `bot` below -> sparse
            let mut cover = inner[i].clone();
            for k in 1..=top { if cover.is_empty() { break; } let j = i + k; cover = if j < nl { geom::intersect(&cover, &inner[j]) } else { vec![] }; }
            for k in 1..=bot { if cover.is_empty() { break; } cover = if i >= k { geom::intersect(&cover, &inner[i - k]) } else { vec![] }; }
            let a_sparse = if i == 0 { 0.0 } else { geom::area(&cover) };
            let a_solid = (a_in - a_sparse).max(0.0);
            solid += a_solid * h;
            sparse += a_sparse * h * density * SPARSE_FACTOR;
            len_solid = a_solid / line_w;
            len_sparse = a_sparse * density / sp_w;
        }
        // per-layer time: lengths at speed, +12% for corners/acceleration, +2 s for travel/z/retraction; the first layer runs at its own speed;
        // layers faster than the cooling minimum are stretched to it (Orca slow_down_for_layer_cooling)
        // walls are accelerated/decelerated at every corner (outer wall accel ~1.5k mm/s2): +40% on their time; every ring (island or hole)
        // costs a retraction + wipe + lift (~1.5 s). Both factors were fitted by eye on the 5 pnp trays and the 43 synthetic cases (see eval).
        let rings = layers[i].region.iter().map(|q| 1 + q.holes.len()).sum::<usize>() as f64;
        let mut t = if i == 0 { (len_wall * 1.4 + len_solid + len_sparse) / v_first } else { len_wall * 1.4 / v_wall + len_solid / v_solid + len_sparse / v_sparse };
        t = t * 1.08 + 2.0 + 1.5 * rings;
        // slowing is limited by slow_down_min_speed: a layer cannot take longer than length / min speed
        if i > 0 && t < min_layer_t { t = t.max(min_layer_t.min((len_wall + len_solid + len_sparse) / v_min_slow)); }
        t_total += t;
    }
    let vol = shell + solid + sparse;
    let time_min = t_total / 60.0;
    let fil_area = std::f64::consts::PI * fil_d * fil_d / 4.0;
    let fil_mm = vol * flow / fil_area;
    let g = vol * flow * fil_density / 1000.0;
    let _ = volume_mm3;
    Estimate {
        height_mm: height, layer_count: nl, volume_cm3: volume_mm3 / 1000.0, shell_cm3: shell / 1000.0, solid_cm3: solid / 1000.0, sparse_cm3: sparse / 1000.0,
        filament_mm: fil_mm, filament_g: g, time_min,
        // 0.24 = material fraction of a support column, measured on 3 Orca normal(auto) runs: T 0.28, mushroom 0.24, 20 mm bridge 0.22
        support_cm3_upper: support_col * 0.24 / 1000.0,
    }
}

// ------------------------------------------------------------------ recommendations
#[allow(clippy::too_many_arguments)]
fn recommend(c: &mut Cfg, mat: &MatProfile, ftype: &str, nozzle: f64, fl: &Flags, thin: &ThinFeatures, est: &Estimate, first: &FirstLayer, warp: &Warp,
             _pheight: f64, _h: f64, cfg: &Config, ov_area: f64) -> Recommend {
    let (mut ft, mut why) = (ftype.to_string(), format!("current filament {ftype} is suitable"));
    if fl.warp_high && matches!(mat.family.as_str(), "ABS" | "ASA" | "PC" | "PA") {
        ft = "PETG".into(); why = format!("{} is likely to warp on a part this wide; PETG warps far less (keep {} only if heat resistance is required, and print in a closed chamber)", mat.family, mat.family);
    } else if fl.bridge_over_limit && mat.family == "PETG" {
        ft = "PLA".into(); why = format!("the longest bridge ({:.0} mm) is beyond what PETG bridges cleanly; PLA bridges better if heat resistance is not needed", 0.0f64);
        why = why.replace("0 mm", "span");
    }
    // nozzle
    let (mut noz, mut nwhy) = (nozzle, format!("{nozzle} mm nozzle fits the model"));
    if let Some(s) = thin.smallest_feature_mm {
        if s <= 0.3 && nozzle >= 0.4 && thin.unprintable_area_mm2 >= 0.3 { noz = 0.2; nwhy = format!("features down to {s:.1} mm exist; a 0.2 mm nozzle would print them (0.4 mm cannot)"); }
        else if s >= 1.6 && est.volume_cm3 > 150.0 && nozzle <= 0.4 && !fl.thin_wall_only { noz = 0.6; nwhy = format!("no feature is thinner than {s:.1} mm and the part is large ({:.0} cm3): a 0.6 mm nozzle would roughly halve print time", est.volume_cm3); }
    }
    // temperatures
    let nz = cfg.f64("nozzle_temperature").unwrap_or(f64::NAN);
    let (lo, hi) = (cfg.f64("nozzle_temperature_range_low").unwrap_or(f64::NAN), cfg.f64("nozzle_temperature_range_high").unwrap_or(f64::NAN));
    let bed_key = match cfg.str("curr_bed_type").unwrap_or_default().as_str() {
        "Cool Plate" => "cool_plate_temp", "Engineering Plate" => "eng_plate_temp", "Smooth PEI Plate / High Temp Plate" => "hot_plate_temp",
        "Textured PEI Plate" => "textured_plate_temp", "Textured Cool Plate" => "textured_cool_plate_temp", "Supertack Plate" => "supertack_plate_temp", _ => "",
    };
    let bt = if bed_key.is_empty() { f64::NAN } else { cfg.f64(bed_key).unwrap_or(f64::NAN) };
    let mut tnote = String::new();
    if nz.is_finite() && lo.is_finite() && hi.is_finite() && (nz < lo || nz > hi) { tnote = format!("nozzle {nz} C is outside the filament's {lo}-{hi} C range"); }
    if nz.is_nan() { c.assumptions.push("nozzle_temperature missing".into()); }
    let mut ams = vec![AmsSlot { role: "model".into(), filament_type: ft.clone(), note: String::new() }];
    if !mat.ams_ok { ams[0].note = "flexible filament: feed from the external spool, not the AMS".into(); }
    else if mat.dry { ams[0].note = "keep dry (hygroscopic); dry before long prints".into(); }
    if fl.needs_support && ov_area > 2000.0 { ams.push(AmsSlot { role: "support interface (optional)".into(), filament_type: ft.clone(), note: "same filament works; a second slot only if you want a separate support colour/material".into() }); }
    let brim = if first.risk == "high" { 8.0 } else if first.risk == "medium" { 5.0 } else if warp.risk == "high" { 5.0 } else { 0.0 };
    Recommend {
        filament_type: ft, filament_reason: why, nozzle_mm: noz, nozzle_reason: nwhy, bed_plate: mat.plate.to_string(),
        nozzle_temp: nz, bed_temp: if bt.is_finite() { bt } else { mat.bed_temp }, temp_note: tnote, ams_slots: ams, brim_mm: brim,
    }
}

fn setup_lines(r: &PreflightReport, mat: &MatProfile, ftype: &str) -> Vec<String> {
    let mut s: Vec<String> = Vec::new();
    let b = &r.bed;
    if !b.fits_height { s.push(format!("BLOCKER: the part is {:.0} mm tall but the printer's limit is {:.0} mm.", b.footprint[2], b.printable_height)); }
    if !b.fits_xy {
        if b.fits_xy_rotated_90 { s.push("Rotate the part 90 degrees on the plate: it only fits that way.".into()); }
        else { s.push(format!("BLOCKER: the part footprint {:.0} x {:.0} mm does not fit the {:.0} x {:.0} mm bed. Scale it down or split it.", b.footprint[0], b.footprint[1], b.printable_bbox[2] - b.printable_bbox[0], b.printable_bbox[3] - b.printable_bbox[1])); }
    }
    if !r.mesh_health.watertight { s.push(format!("The model file has defects ({} open, {} flipped, {} non-manifold edges). It still slices, but check the preview for missing or doubled surfaces; re-export a closed solid if possible.", r.mesh_health.open_edges, r.mesh_health.flipped_edges, r.mesh_health.nonmanifold_edges)); }
    if r.population.layers_with_region == 0 { s.push("BLOCKER: slicing produced no material at all (empty layers). The model may be open, inverted or too small.".into()); }
    s.push(format!("Put the {} filament on the {} (bed {:.0} C, nozzle {} C).", r.recommend.filament_type, r.recommend.bed_plate, r.recommend.bed_temp, if r.recommend.nozzle_temp.is_finite() { format!("{:.0}", r.recommend.nozzle_temp) } else { "?".into() }));
    if r.recommend.filament_type != ftype { s.push(format!("Filament suggestion: {} instead of {} ({}).", r.recommend.filament_type, ftype, r.recommend.filament_reason)); }
    if (r.recommend.nozzle_mm - 0.4).abs() > 1e-9 || r.recommend.nozzle_reason.contains("would") { s.push(format!("Nozzle: {}.", r.recommend.nozzle_reason)); }
    if mat.abrasive { s.push("This filament is abrasive (CF/GF): use a hardened-steel nozzle.".into()); }
    if !mat.ams_ok { s.push("Feed this flexible filament from the external spool, not the AMS.".into()); }
    else if mat.dry { s.push(format!("{} absorbs moisture: use freshly dried filament.", mat.family)); }
    if mat.enclosure { s.push(format!("{} needs a closed chamber and no draughts.", mat.family)); }
    if !r.recommend.temp_note.is_empty() { s.push(r.recommend.temp_note.clone()); }
    if r.flags.has_overhang && !r.flags.needs_support {
        s.push(format!("Overhangs of {:.0} mm2 exist but they are short bridges that print without support (longest {:.0} mm).", r.overhang.needs_support_area_mm2, r.bridges.max_span_mm));
    }
    if r.flags.needs_support {
        s.push(format!("Supports are needed: about {:.0} mm2 of the part hangs out beyond {:.0} degrees (layers {:.1}-{:.1} mm). Expect extra ~{:.1} cm3 of material at most and some surface marks where they touch.", r.overhang.needs_support_area_mm2, r.overhang.threshold_deg, r.overhang.bands.first().map_or(0.0, |b| b.z0), r.overhang.bands.last().map_or(0.0, |b| b.z1), r.estimate.support_cm3_upper));
    } else { s.push("No supports needed.".into()); }
    if r.flags.has_bridge {
        s.push(format!("Bridges: {} found, longest {:.0} mm (limit for {} about {:.0} mm).{}", r.bridges.count, r.bridges.max_span_mm, mat.family, r.bridges.limit_mm, if r.flags.bridge_over_limit { " The longest will sag; add support under it or reduce the span." } else { " They should print cleanly." }));
    }
    if r.flags.thin_unprintable {
        let where_ = if let Some(b) = r.thin.bands.first() { format!(" (first at z {:.1}-{:.1} mm, {} of {} sampled layers{})", b.z0, b.z1, r.thin.unprintable_layers, r.thin.layers_sampled, if r.thin.unprintable_layers == 1 { "; one layer only: probably a thin ledge or edge, cosmetic" } else { "" }) } else { String::new() };
        s.push(format!("Some features are thinner than {:.2} mm (up to {:.1} mm2 per layer){} and will NOT print with the {} wall generator; thicken them or switch the wall generator.", r.thin.unprintable_below_mm, r.thin.unprintable_area_mm2, where_, r.thin.wall_generator));
    } else if r.flags.thin_wall_only {
        s.push("Some walls are thinner than two line widths: they print as a single line with no infill (fine for walls, weak for load).".into());
    }
    match r.first_layer.risk.as_str() {
        "high" => s.push(format!("Adhesion risk HIGH ({}). Use a {:.0} mm brim and clean the plate{}.", r.first_layer.reasons.join("; "), r.recommend.brim_mm, if mat.family == "PETG" { " (PETG: a thin glue-stick layer helps, and never print PETG on a smooth plate without it)" } else { "" })),
        "medium" => s.push(format!("Adhesion risk medium ({}). A {:.0} mm brim is advised.", r.first_layer.reasons.join("; "), r.recommend.brim_mm)),
        _ => {}
    }
    if r.flags.tall_slender {
        s.push(format!("Tall and slender (height / smallest footprint = {:.1}{}): print slower near the top and consider a brim so it does not wobble or detach.", r.stability.slenderness, if r.stability.columns.is_empty() { String::new() } else { format!("; thin column {:.1} mm wide, {:.0} mm tall", r.stability.columns[0].width_mm, r.stability.columns[0].z1 - r.stability.columns[0].z0) }));
    }
    if r.flags.warp_high { s.push(format!("Warp risk high for {} on a {:.0} mm wide first layer: heat the bed, close the chamber, avoid draughts.", mat.family, r.first_layer.contact_bbox[2] - r.first_layer.contact_bbox[0])); }
    s.push(format!("Estimated {:.1} g of filament ({:.1} m) and about {:.0} min.", r.estimate.filament_g, r.estimate.filament_mm / 1000.0, r.estimate.time_min));
    s.push(format!("Place the part centred at ({:.0}, {:.0}).", b.centre_xy[0], b.centre_xy[1]));
    s
}

fn render_text(r: &PreflightReport) -> String {
    let mut o = String::new();
    o += "PREFLIGHT\n";
    o += &format!("  part {:.1} x {:.1} x {:.1} mm, {} layers, fits bed: {}\n", r.bed.footprint[0], r.bed.footprint[1], r.bed.footprint[2], r.estimate.layer_count, r.flags.fits_bed);
    o += &format!("  est: {:.1} g, {:.0} m filament, {:.0} min  (shell {:.2} / solid {:.2} / sparse {:.2} cm3)\n", r.estimate.filament_g, r.estimate.filament_mm / 1000.0, r.estimate.time_min, r.estimate.shell_cm3, r.estimate.solid_cm3, r.estimate.sparse_cm3);
    o += &format!("  overhang >{:.0} deg: {:.1} mm2 over {} layers (normals check {}); rough {:.1} mm2\n", r.overhang.threshold_deg, r.overhang.needs_support_area_mm2, r.overhang.layers_affected, r.overhang.needs_support_area_normals_mm2.map_or("n/a: mesh winding unreliable".to_string(), |v| format!("{v:.1} mm2")), r.overhang.rough_area_mm2);
    o += &format!("  bridges: {} (max span {:.1} mm, limit {:.0}); cantilever area {:.1} mm2\n", r.bridges.count, r.bridges.max_span_mm, r.bridges.limit_mm, r.bridges.cantilever_area_mm2);
    o += &format!("  thin (<{:.2} mm): {:.1} mm2 in {} of {} sampled layers; wall-only {:.1} mm2; smallest feature {:?}\n", r.thin.unprintable_below_mm, r.thin.unprintable_area_mm2, r.thin.unprintable_layers, r.thin.layers_sampled, r.thin.wall_only_area_mm2, r.thin.smallest_feature_mm);
    o += &format!("  first layer: {:.0} mm2 contact, risk {} ({} pts); warp {} ({:.2}); slenderness {:.1}\n", r.first_layer.contact_area_mm2, r.first_layer.risk, r.first_layer.points, r.warp.risk, r.warp.score, r.stability.slenderness);
    o += "SETUP NEEDED\n";
    for (i, l) in r.setup.iter().enumerate() { o += &format!("  {}. {}\n", i + 1, l); }
    if !r.assumptions.is_empty() { o += "ASSUMED (config key missing)\n"; for a in &r.assumptions { o += &format!("  - {a}\n"); } }
    o
}

// ------------------------------------------------------------------ tests
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::mesh::tests::box_soup;
    use std::collections::BTreeMap;

    pub fn test_cfg(extra: &[(&str, &str)]) -> Config {
        let mut m: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in [
            ("line_width", "0.42"), ("outer_wall_line_width", "0.42"), ("inner_wall_line_width", "0.45"), ("sparse_infill_line_width", "0.45"), ("nozzle_diameter", "0.4,0.4"), ("wall_generator", "classic"),
            ("support_threshold_angle", "30"), ("wall_loops", "2"), ("top_shell_layers", "5"), ("bottom_shell_layers", "3"), ("sparse_infill_density", "15%"), ("filament_flow_ratio", "0.95"),
            ("filament_diameter", "1.75"), ("filament_density", "1.25"), ("filament_type", "PETG"), ("printable_area", "0x0,256x0,256x256,0x256"), ("printable_height", "261"), ("layer_height", "0.2"),
            ("initial_layer_print_height", "0.2"), ("min_feature_size", "25%"), ("nozzle_temperature", "235"), ("nozzle_temperature_range_low", "230"), ("nozzle_temperature_range_high", "260"),
            ("curr_bed_type", "Textured PEI Plate"), ("textured_plate_temp", "70"), ("outer_wall_speed", "60,60"), ("inner_wall_speed", "80,80"), ("sparse_infill_speed", "80,80"),
            ("internal_solid_infill_speed", "250,200"), ("filament_max_volumetric_speed", "15"),
        ] { m.insert(k.into(), v.into()); }
        for (k, v) in extra { m.insert((*k).into(), (*v).into()); }
        Config::from_map(m)
    }
    pub fn slice_soup(soup: &[[f64; 9]], cfg: &Config) -> (Mesh, Vec<Layer>) {
        let mut m = Mesh::from_soup(soup).unwrap();
        m.place_on_bed(128.0, 128.0);
        let r = crate::slice::slice(&m, cfg).unwrap();
        (m, r.layers)
    }
    fn translate(soup: &[[f64; 9]], d: [f64; 3]) -> Vec<[f64; 9]> { soup.iter().map(|t| { let mut a = *t; for k in 0..3 { a[k * 3] += d[0]; a[k * 3 + 1] += d[1]; a[k * 3 + 2] += d[2]; } a }).collect() }
    /// Union of overlapping box soups is not a valid manifold; for stacked boxes that only touch on a face
    /// we rely on the slicer's per-layer union (coplanar internal faces cancel in the polygon union).
    fn bx(x0: f64, y0: f64, z0: f64, x: f64, y: f64, z: f64) -> Vec<[f64; 9]> { translate(&box_soup(x, y, z), [x0, y0, z0]) }

    #[test] fn cube_is_clean() {
        let cfg = test_cfg(&[]);
        let (m, l) = slice_soup(&box_soup(20.0, 20.0, 20.0), &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(r.flags.fits_bed && !r.flags.needs_support && !r.flags.has_bridge && !r.flags.thin_unprintable && !r.flags.tall_slender);
        assert_eq!(r.overhang.needs_support_area_mm2, 0.0);
        assert_eq!(r.overhang.needs_support_area_normals_mm2, Some(0.0));
        assert!((r.estimate.volume_cm3 - 8.0).abs() < 1e-6 && r.mesh_health.watertight && r.mesh_health.volume_agrees);
        assert_eq!(r.population.layers, 100);
    }
    #[test] fn too_big_does_not_fit() {
        let cfg = test_cfg(&[]);
        let (m, l) = slice_soup(&box_soup(300.0, 20.0, 5.0), &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(!r.flags.fits_bed && !r.bed.fits_xy && !r.bed.fits_xy_rotated_90 && r.setup.iter().any(|s| s.contains("BLOCKER")));
        let (m, l) = slice_soup(&box_soup(250.0, 100.0, 5.0), &test_cfg(&[("printable_area", "0x0,120x0,120x300,0x300")]));
        let r = preflight(&m, &test_cfg(&[("printable_area", "0x0,120x0,120x300,0x300")]), &l);
        assert!(!r.bed.fits_xy && r.bed.fits_xy_rotated_90);
    }
    #[test] fn t_overhang_needs_support_and_matches_normals() {
        // stem 8 x 20 x 10, cap 30 x 20 x 4 -> two 11 x 20 cantilevers
        let mut soup = bx(11.0, 0.0, 0.0, 8.0, 20.0, 10.0);
        soup.extend(bx(0.0, 0.0, 10.0, 30.0, 20.0, 4.0));
        // cap bottom face is split by the stem; build the T as a single prism instead to keep the mesh manifold
        let _ = soup;
        let cfg = test_cfg(&[]);
        let soup = crate::preflight::tests::t_prism();
        let (m, l) = slice_soup(&soup, &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(r.flags.needs_support, "{:?}", r.overhang);
        let want = 2.0 * 11.0 * 20.0; // two wings
        let nm = r.overhang.needs_support_area_normals_mm2.expect("watertight");
        assert!((nm - want).abs() < 1.0, "normals {} vs {}", nm, want);
        assert!((r.overhang.needs_support_area_mm2 - want).abs() / want < 0.15, "layers {} vs {}", r.overhang.needs_support_area_mm2, want);
        assert!(!r.flags.has_bridge, "a cantilever is not a bridge: {:?}", r.bridges);
        assert!(r.bridges.cantilever_area_mm2 > 0.5 * want);
    }
    /// T profile extruded along Y by 20: stem x in [-4,4] z 0..10, cap x in [-15,15] z 10..14 (same as mkoverhang.js 't').
    pub fn t_prism() -> Vec<[f64; 9]> { prism(&[[-4., 0.], [4., 0.], [4., 10.], [15., 10.], [15., 14.], [-15., 14.], [-15., 10.], [-4., 10.]], 20.0) }
    pub fn bridge_prism() -> Vec<[f64; 9]> { prism(&[[-15., 0.], [-10., 0.], [-10., 10.], [10., 10.], [10., 0.], [15., 0.], [15., 14.], [-15., 14.]], 20.0) }
    /// Extrude a simple (x,z) polygon (CCW in x-z) along y in [0, len]. Ear clipping.
    pub fn prism(prof: &[[f64; 2]], len: f64) -> Vec<[f64; 9]> {
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
        let mut out: Vec<[f64; 9]> = vec![];
        let t = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]];
        for [a, b, c] in tris {
            out.push(t(p3(a, 0.0), p3(b, 0.0), p3(c, 0.0)));   // front face normal -y
            out.push(t(p3(a, len), p3(c, len), p3(b, len)));   // back face normal +y
        }
        for i in 0..n {
            let j = (i + 1) % n;
            let (a, b, c, d) = (p3(i, 0.0), p3(j, 0.0), p3(j, len), p3(i, len));
            out.push(t(a, d, c)); out.push(t(a, c, b));
        }
        out
    }
    #[test] fn bridge_span_measured() {
        let cfg = test_cfg(&[]);
        let (m, l) = slice_soup(&bridge_prism(), &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(r.flags.has_bridge && r.bridges.count >= 1, "{:?}", r.bridges);
        // gap between the pillars is 20 mm; best direction is along x (span 20) or along y (anchored? no - y ends are free)
        assert!((r.bridges.max_span_mm - 20.0).abs() < 1.5, "{:?}", r.bridges);
        assert!(r.flags.bridge_over_limit, "PETG limit 12");
        assert!(r.flags.needs_support);
    }
    #[test] fn thin_wall_flags() {
        let cfg = test_cfg(&[]);
        // 0.3 mm wall: below 1 line width -> unprintable with classic
        let mut soup = bx(0.0, 0.0, 0.0, 20.0, 20.0, 1.0); // base so the mesh is a single manifold? use separate solids: fine for the slicer
        soup.extend(bx(30.0, 0.0, 0.0, 0.3, 20.0, 10.0));
        let (m, l) = slice_soup(&soup, &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(r.flags.thin_unprintable, "{:?}", r.thin);
        // 0.6 mm wall: prints (>= 1 line) but wall-only
        let mut soup = bx(0.0, 0.0, 0.0, 20.0, 20.0, 1.0);
        soup.extend(bx(30.0, 0.0, 0.0, 0.6, 20.0, 10.0));
        let (m, l) = slice_soup(&soup, &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(!r.flags.thin_unprintable && r.flags.thin_wall_only, "{:?}", r.thin);
        // arachne prints 0.3 mm
        let cfg2 = test_cfg(&[("wall_generator", "arachne")]);
        let mut soup = bx(0.0, 0.0, 0.0, 20.0, 20.0, 1.0);
        soup.extend(bx(30.0, 0.0, 0.0, 0.3, 20.0, 10.0));
        let (m, l) = slice_soup(&soup, &cfg2);
        assert!(!preflight(&m, &cfg2, &l).flags.thin_unprintable);
    }
    #[test] fn tall_tower_and_tiny_contact() {
        let cfg = test_cfg(&[]);
        let (m, l) = slice_soup(&box_soup(6.0, 6.0, 60.0), &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(r.flags.tall_slender && r.flags.adhesion_risk_high, "{:?} {:?}", r.stability, r.first_layer);
        assert!(!r.stability.columns.is_empty());
    }
    #[test] fn warp_by_material() {
        let (m, l) = slice_soup(&box_soup(150.0, 150.0, 10.0), &test_cfg(&[("filament_type", "ABS")]));
        assert!(preflight(&m, &test_cfg(&[("filament_type", "ABS")]), &l).flags.warp_high);
        assert!(!preflight(&m, &test_cfg(&[("filament_type", "PLA")]), &l).flags.warp_high);
    }
    #[test] fn missing_keys_are_listed_not_hidden() {
        let cfg = Config::from_map(BTreeMap::new());
        let (m, l) = slice_soup(&box_soup(20.0, 20.0, 5.0), &test_cfg(&[]));
        let r = preflight(&m, &cfg, &l);
        assert!(r.assumptions.len() >= 5, "{:?}", r.assumptions);
    }
    #[test] fn empty_layers_is_a_blocker_not_a_pass() {
        let cfg = test_cfg(&[]);
        let m = Mesh::from_soup(&box_soup(20.0, 20.0, 5.0)).unwrap();
        let r = preflight(&m, &cfg, &[]);
        assert!(r.setup.iter().any(|s| s.contains("BLOCKER")) && r.population.layers == 0);
    }
    #[test] fn json_and_text_render() {
        let cfg = test_cfg(&[]);
        let (m, l) = slice_soup(&box_soup(20.0, 20.0, 5.0), &cfg);
        let r = preflight(&m, &cfg, &l);
        assert!(r.to_json()["flags"]["fits_bed"].as_bool().unwrap());
        assert!(r.to_text().contains("SETUP NEEDED"));
    }
}
