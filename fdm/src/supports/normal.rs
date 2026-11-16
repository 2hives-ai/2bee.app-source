//! Normal supports: port of Support/SupportMaterial.cpp + the layer generation half of SupportCommon.cpp.
//! Stage names follow the C++ (`top_contact_layers`, `bottom_contact_layers_and_layer_support_areas`,
//! `raft_and_intermediate_support_layers`, `generate_base_layers`, `trim_support_layers_by_object`,
//! `generate_interface_layers`, `generate_raft_base`, `generate_support_layers`).
use super::config::*;
use super::grid::{GridParams, SupportGridPattern};
use super::params::{Flow, SlicingParams};
use super::poly::{self, Join};
use crate::types::{FdmError, Poly, Polys};

pub const EPS: f64 = 1e-4; // Orca EPSILON (mm)
pub const SCALED_EPS: f64 = 1e-4; // SCALED_EPSILON is 100 units == 1e-4 mm

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LT { Unknown, RaftBase, RaftInterface, BottomContact, BottomInterface, Base, TopInterface, TopContact, Intermediate }

pub type Id = usize;

#[derive(Clone, Debug)]
pub struct SL {
    pub ty: LT,
    pub print_z: f64,
    pub bottom_z: f64,
    pub height: f64,
    pub idx_above: Option<usize>,
    pub idx_below: Option<usize>,
    pub bridging: bool,
    pub polygons: Polys,
    pub contact: Option<Polys>,
    pub overhang: Option<Polys>,
    pub enforcer: Option<Polys>,
    /// debug / bookkeeping: the id this layer carries in `Store`
    pub id: Id,
}
impl SL {
    fn new(ty: LT) -> SL {
        SL { ty, print_z: 0.0, bottom_z: 0.0, height: 0.0, idx_above: None, idx_below: None, bridging: false,
             polygons: vec![], contact: None, overhang: None, enforcer: None, id: 0 }
    }
    pub fn bottom_print_z(&self) -> f64 { self.print_z - self.height }
    pub fn extreme_z(&self) -> f64 { if self.ty == LT::TopContact { self.bottom_z } else { self.print_z } }
}

#[derive(Default)]
pub struct Store { pub v: Vec<SL> }
impl Store {
    pub fn alloc(&mut self, ty: LT) -> Id {
        let id = self.v.len();
        let mut l = SL::new(ty);
        l.id = id;
        self.v.push(l);
        id
    }
    pub fn merge(&mut self, dst: Id, src: Id) {
        if dst == src { return; }
        let s = std::mem::replace(&mut self.v[src], SL::new(LT::Unknown));
        self.v[src].id = src;
        let d = &mut self.v[dst];
        d.polygons = poly::union2(&d.polygons, &s.polygons);
        fn merge_opt(dst: &mut Option<Polys>, src: Option<Polys>) {
            let dst_empty = dst.as_ref().map(|d| d.is_empty()).unwrap_or(true);
            if dst_empty { *dst = src; }
            else if let Some(s) = src { if !s.is_empty() { let d = dst.take().unwrap(); *dst = Some(poly::union2(&d, &s)); } }
        }
        merge_opt(&mut d.contact, s.contact);
        merge_opt(&mut d.overhang, s.overhang);
        merge_opt(&mut d.enforcer, s.enforcer);
    }
}

/// One object layer as the support generator sees it.
#[derive(Clone, Debug, Default)]
pub struct OL {
    pub print_z: f64,
    pub height: f64,
    pub slices: Polys,
    /// top surfaces (layer minus the next layer, opened)
    pub top: Polys,
    pub sharp_tails: Polys,
    pub sharp_tails_h: Vec<f64>,
    pub cantilevers: Polys,
}
impl OL { pub fn bottom_z(&self) -> f64 { self.print_z - self.height } }

pub struct GenInput<'a> {
    pub cfg: &'a SupportConfig,
    pub layers: Vec<OL>,
    pub enforcers: Vec<Polys>,
    pub blockers: Vec<Polys>,
}

/// Everything needed by every stage.
pub struct Gen<'a> {
    pub cfg: &'a SupportConfig,
    pub sp: SlicingParams,
    pub layers: Vec<OL>,
    pub store: Store,
    pub enforcers: Vec<Polys>,
    pub blockers: Vec<Polys>,
    pub buildplate_covered: Vec<Polys>,
    /// organic tree supports: sheath always on (SupportParameters::with_sheath = true)
    pub tree_mode: bool,
    // derived support parameters
    pub p: SupportParams,
}

#[derive(Clone, Debug)]
pub struct SupportParams {
    pub zero_gap_interface_top: bool,
    pub zero_gap_interface_bottom: bool,
    pub num_top_interface: usize,
    pub num_bottom_interface: usize,
    pub has_top_contacts: bool,
    pub has_bottom_contacts: bool,
    pub first_layer_flow: Flow,
    pub flow: Flow,
    pub interface_flow: Flow,
    pub bottom_interface_flow: Flow,
    pub raft_interface_flow: Flow,
    pub layer_height_min: f64,
    pub gap_xy: f64,
    pub gap_xy_first_layer: f64,
    pub base_angle: f64,
    pub interface_angle: f64,
    pub top_interface_spacing: f64,
    pub bottom_interface_spacing: f64,
    pub top_interface_density: f64,
    pub bottom_interface_density: f64,
    pub raft_interface_density: f64,
    pub support_spacing: f64,
    pub support_density: f64,
    pub style: SupportStyle,
    pub independent_layer_height: bool,
    pub raft_angle_1st_layer: f64,
    pub raft_angle_base: f64,
    pub raft_angle_interface: f64,
    pub ext_perimeter_width: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FillKind { Rectilinear, SupportBase, Concentric, Grid, Honeycomb }

impl SupportParams {
    pub fn new(cfg: &SupportConfig, sp: &SlicingParams, min_object_layer_height: f64) -> SupportParams {
        let nozzle = cfg.nozzle_diameter;
        let width = if cfg.support_line_width > 0.0 { cfg.support_line_width } else { cfg.line_width };
        let lh = cfg.layer_height;
        let first_w = if cfg.initial_layer_line_width > 0.0 { cfg.initial_layer_line_width } else if cfg.support_line_width > 0.0 { cfg.support_line_width } else { cfg.line_width };
        let first_layer_flow = Flow::from_width(first_w, nozzle, sp.first_print_layer_height);
        let flow = Flow::from_width(width, nozzle, lh);
        let mut interface_flow = Flow::from_width(width, nozzle, lh);
        let raft_interface_flow = interface_flow;
        let num_top = cfg.support_interface_top_layers.max(0) as usize;
        let num_bottom = cfg.n_bottom_interface().max(0) as usize;
        if num_top == 0 && num_bottom == 0 { interface_flow = flow; }
        // support_layer_height_min = min over (0.01, extruder min layer heights, object layer heights)
        let mut lmin = 0.01f64;
        lmin = lmin.min(cfg.min_layer_height.max(0.01));
        lmin = lmin.min(min_object_layer_height.max(0.01));
        let bridge_ratio = cfg.bridge_flow;
        let bottom_interface_flow = if sp.zero_gap_interface_bottom || !cfg.thick_bridges {
            // with_flow_ratio(bridge_flow): ratio 1 in all profiles we target; apply by shrinking width
            if (bridge_ratio - 1.0).abs() < 1e-9 { interface_flow } else { interface_flow }
        } else {
            Flow::bridging(bridge_ratio * nozzle, nozzle)
        };
        let ironing = cfg.support_ironing;
        let top_interface_spacing = (if ironing { 0.0 } else { cfg.support_interface_spacing }) + interface_flow.spacing;
        let mut top_interface_density = (interface_flow.spacing / top_interface_spacing).min(1.0);
        let bottom_interface_spacing = cfg.support_bottom_interface_spacing + interface_flow.spacing;
        let bottom_interface_density = (interface_flow.spacing / bottom_interface_spacing).min(1.0);
        let raft_interface_spacing = (if ironing { 0.0 } else { cfg.support_interface_spacing }) + raft_interface_flow.spacing;
        let raft_interface_density = (raft_interface_flow.spacing / raft_interface_spacing).min(1.0);
        let support_spacing = cfg.support_base_pattern_spacing + flow.spacing;
        let support_density = (flow.spacing / support_spacing).min(1.0);
        let mut top_interface_spacing = top_interface_spacing;
        if num_top == 0 {
            top_interface_spacing = support_spacing;
            top_interface_density = support_density;
        }
        let base_angle = cfg.support_angle.to_radians();
        let interface_angle = (cfg.support_angle + 90.0).to_radians();
        let (mut a1, mut ab, mut ai) = (0.0, 0.0, 0.0);
        if sp.base_raft_layers > 1 {
            a1 = interface_angle; ab = base_angle; ai = interface_angle;
            if sp.interface_raft_layers & 1 == 0 { ai += 0.5 * std::f64::consts::PI; }
        } else if sp.base_raft_layers == 1 || sp.interface_raft_layers > 1 {
            a1 = base_angle; ai = interface_angle + 0.5 * std::f64::consts::PI;
        } else if sp.interface_raft_layers == 1 {
            a1 = 0.5 * std::f64::consts::PI; ai = a1;
        }
        SupportParams {
            zero_gap_interface_top: sp.zero_gap_interface_top, zero_gap_interface_bottom: sp.zero_gap_interface_bottom,
            num_top_interface: num_top, num_bottom_interface: num_bottom,
            has_top_contacts: num_top > 0, has_bottom_contacts: num_bottom > 0,
            first_layer_flow, flow, interface_flow, bottom_interface_flow, raft_interface_flow,
            layer_height_min: lmin, gap_xy: cfg.support_object_xy_distance, gap_xy_first_layer: cfg.support_object_first_layer_gap,
            base_angle, interface_angle, top_interface_spacing, bottom_interface_spacing,
            top_interface_density, bottom_interface_density, raft_interface_density, support_spacing, support_density,
            style: cfg.style_resolved(), independent_layer_height: cfg.independent_support_layer_height,
            raft_angle_1st_layer: a1, raft_angle_base: ab, raft_angle_interface: ai,
            ext_perimeter_width: cfg.outer_wall_line_width,
        }
    }
    pub fn interface_fill_is_rect(&self) -> bool { self.top_interface_density > 0.95 }
    pub fn base_fill_is_rect(&self, cfg: &SupportConfig) -> bool { self.support_density > 0.95 || cfg.tree_support_wall_count > 0 }
    pub fn has_interfaces(&self) -> bool { self.num_top_interface + self.num_bottom_interface > 0 }
    pub fn grid_params(&self, cfg: &SupportConfig) -> GridParams {
        GridParams::new(self.style, cfg.support_base_pattern_spacing, cfg.support_angle, self.flow.spacing)
    }
    /// contact (top) interface fill kind, `Fill::new_from_type(contact_fill_pattern)`
    pub fn contact_fill_kind(&self, cfg: &SupportConfig) -> FillKind {
        let density = if self.num_top_interface > 0 { self.top_interface_density } else { self.bottom_interface_density };
        let zero_gap = if self.num_top_interface > 0 { self.zero_gap_interface_top } else { self.zero_gap_interface_bottom };
        match cfg.support_interface_pattern {
            InterfacePattern::Grid => FillKind::Grid,
            InterfacePattern::RectilinearInterlaced => FillKind::Rectilinear,
            p => {
                if (p == InterfacePattern::Auto && zero_gap) || p == InterfacePattern::Concentric { FillKind::Concentric }
                else if density > 0.95 { FillKind::Rectilinear } else { FillKind::SupportBase }
            }
        }
    }
    pub fn base_fill_kind(&self, cfg: &SupportConfig) -> FillKind {
        if cfg.support_base_pattern == BasePattern::Honeycomb { FillKind::Honeycomb }
        else if self.support_density > 0.95 || cfg.tree_support_wall_count > 0 { FillKind::Rectilinear } else { FillKind::SupportBase }
    }
    pub fn raft_interface_fill_kind(&self) -> FillKind { if self.raft_interface_density > 0.95 { FillKind::Rectilinear } else { FillKind::SupportBase } }
    /// Produce support interface angle for a given interface_id (SupportParameters::support_interface_angle)
    pub fn support_interface_angle(&self, cfg: &SupportConfig, interface_id: usize) -> f64 {
        use std::f64::consts::FRAC_PI_4;
        match cfg.support_interface_pattern {
            InterfacePattern::Rectilinear => if self.style == SupportStyle::Snug { self.interface_angle - FRAC_PI_4 } else { self.interface_angle },
            InterfacePattern::RectilinearInterlaced => self.interface_angle + if interface_id & 1 == 1 { FRAC_PI_4 } else { -FRAC_PI_4 },
            InterfacePattern::Grid => self.base_angle,
            _ => self.interface_angle,
        }
    }
    pub fn raft_interface_angle(&self, interface_id: usize) -> f64 {
        use std::f64::consts::FRAC_PI_4;
        self.raft_angle_interface + if interface_id & 1 == 1 { -FRAC_PI_4 } else { FRAC_PI_4 }
    }
}

// ---------------------------------------------------------------------------------------------
// constants from SupportMaterial.cpp
const LENGTH_THRESH_WELL_SUPPORTED: f64 = 6.0; // mm
const AREA_THRESH_WELL_SUPPORTED: f64 = 36.0; // mm^2
const SHARP_TAIL_XY_GAP: f64 = 0.2;
const NO_OVERLAP_XY_GAP: f64 = 0.2;
const SHARP_TAIL_MAX_SUPPORT_HEIGHT: f64 = 16.0;

fn bbox_size(p: &Polys) -> [f64; 2] {
    match poly::bbox(p) { Some((a, b)) => [b[0] - a[0], b[1] - a[1]], None => [0.0, 0.0] }
}
fn poly1(p: &Poly) -> Polys { vec![p.clone()] }

impl<'a> Gen<'a> {
    pub fn new(inp: GenInput<'a>) -> Result<Gen<'a>, FdmError> {
        let cfg = inp.cfg;
        let sp = SlicingParams::create(cfg);
        let min_h = inp.layers.iter().map(|l| l.height).fold(f64::MAX, f64::min);
        let p = SupportParams::new(cfg, &sp, if min_h.is_finite() { min_h } else { cfg.layer_height });
        Ok(Gen { cfg, sp, layers: inp.layers, store: Store::default(), enforcers: inp.enforcers, blockers: inp.blockers,
                 buildplate_covered: Vec::new(), tree_mode: false, p })
    }
    pub fn has_support(&self) -> bool { self.cfg.enable_support || self.cfg.enforce_support_layers > 0 }
    pub fn has_raft(&self) -> bool { self.sp.has_raft() }
    pub fn build_plate_only(&self) -> bool { self.has_support() && self.cfg.support_on_build_plate_only }
    pub fn synchronize_layers(&self) -> bool { !self.cfg.independent_support_layer_height }

    // -- buildplate_covered -------------------------------------------------------------------
    pub fn compute_buildplate_covered(&mut self) {
        self.buildplate_covered.clear();
        if !self.build_plate_only() { return; }
        let n = self.layers.len();
        let mut cov: Vec<Polys> = vec![Vec::new(); n];
        for id in 1..n {
            let mut covered = cov[id - 1].clone();
            let grown = poly::offset(&self.layers[id - 1].slices, 0.01);
            covered.extend(grown);
            cov[id] = poly::union(&covered);
        }
        self.buildplate_covered = cov;
    }

    // -- detect_overhangs ---------------------------------------------------------------------
    /// Returns (overhang areas, new sharp tails (poly, height), cantilever regions).
    fn detect_overhangs(&self, layer_id: usize) -> (Polys, Vec<(Poly, f64)>, Polys) {
        let c = self.cfg;
        let layer = &self.layers[layer_id];
        let fw = self.p.ext_perimeter_width;
        let auto_normal = c.support_type == SupportType::NormalAuto;
        let buildplate_only = !self.buildplate_covered.is_empty();
        let mut thresh_angle = if c.support_threshold_angle > 0.0 { c.support_threshold_angle + 1.0 } else { 0.0 };
        thresh_angle = thresh_angle.min(89.0);
        let threshold_rad = thresh_angle.to_radians();
        let xy_expansion = c.support_expansion;
        let mut overhang_polygons: Polys = Vec::new();
        let mut sharp: Vec<(Poly, f64)> = Vec::new();
        let mut lower_layer_offset = 0.0f64;
        if layer_id == 0 {
            overhang_polygons = layer.slices.clone();
            for s in &layer.slices {
                let sz = bbox_size(&poly1(s));
                if !(sz[0] > LENGTH_THRESH_WELL_SUPPORTED && sz[1] > LENGTH_THRESH_WELL_SUPPORTED) {
                    sharp.push((s.clone(), layer.height));
                }
            }
        } else if !layer.slices.is_empty() {
            let lower = &self.layers[layer_id - 1];
            let lower_polys = &lower.slices;
            // lower_layer_expolys: lslices which survive an offset of -fw/2
            let lower_expolys: Polys = lower.slices.iter().filter(|e| !poly::offset(&poly1(e), -fw / 2.0).is_empty()).cloned().collect();
            lower_layer_offset = if (layer_id as i32) < c.enforce_support_layers { 0.0 }
                else if threshold_rad > 0.0 { lower.height / threshold_rad.tan() }
                else { fw - c.support_threshold_overlap_frac * fw };
            let layerm = &layer.slices;
            let mut diff_polygons: Polys = Vec::new();
            if lower_layer_offset == 0.0 {
                diff_polygons = poly::diff(layerm, lower_polys);
                if buildplate_only { diff_polygons = poly::diff(&diff_polygons, &self.buildplate_covered[layer_id]); }
            } else if auto_normal {
                diff_polygons = poly::diff(layerm, &poly::offset_sq(lower_polys, lower_layer_offset));
                if buildplate_only && !self.buildplate_covered[layer_id].is_empty() {
                    diff_polygons = poly::diff(&diff_polygons, &self.buildplate_covered[layer_id]);
                }
                if !diff_polygons.is_empty() {
                    let grown = poly::offset_sq(&diff_polygons, lower_layer_offset);
                    diff_polygons = poly::diff(&poly::intersect(&grown, layerm), lower_polys);
                }
                // sharp tails (g_config_support_sharp_tails == true)
                for expoly in layerm {
                    let e1 = poly1(expoly);
                    if poly::offset(&e1, -0.5 * fw).is_empty() { continue; }
                    let mut is_sharp = false;
                    if !poly::overlaps(&poly::offset(&e1, 0.5 * fw), &lower_expolys) {
                        is_sharp = poly::poly_area(expoly) < AREA_THRESH_WELL_SUPPORTED && !poly::offset(&e1, -0.1 * fw).is_empty();
                    }
                    if is_sharp {
                        let overhang = poly::diff(&e1, &lower_expolys);
                        sharp.push((expoly.clone(), layer.height));
                        let overhang = poly::offset(&overhang, 0.05 * fw);
                        diff_polygons.extend(overhang);
                    }
                }
            }
            if !diff_polygons.is_empty() {
                if !self.blockers.is_empty() && !self.blockers[layer_id].is_empty() {
                    diff_polygons = poly::diff(&diff_polygons, &self.blockers[layer_id]);
                }
                // (bridge_no_support: remove_bridges_from_contacts is not ported, see Gen::generate)
                if !(diff_polygons.is_empty() || poly::offset(&diff_polygons, -0.1 * fw).is_empty()) {
                    if xy_expansion != 0.0 { diff_polygons = poly::offset_sq(&diff_polygons, xy_expansion); }
                    overhang_polygons.extend(diff_polygons);
                }
            }
        }
        let overhang_areas = poly::union(&overhang_polygons);
        let mut cant: Polys = Vec::new();
        if layer_id > 0 {
            let lower = &self.layers[layer_id - 1];
            let grown_lower = poly::offset(&lower.slices, fw.max(lower_layer_offset) + 0.1);
            for ex in &overhang_areas {
                let boundary = poly::intersect(&poly1(ex), &grown_lower);
                if boundary.is_empty() { continue; }
                let mut dist_max = 0.0f64;
                for pt in &ex.contour {
                    let d = poly::dist_to_boundary(&boundary, *pt);
                    dist_max = dist_max.max(d);
                }
                if dist_max > 3.0 { cant.push(ex.clone()); }
            }
        }
        (overhang_areas, sharp, cant)
    }
}

// =============================================================================================
// top contact layers
// =============================================================================================
#[derive(Clone)]
struct Cluster {
    members: Vec<(usize, usize)>, // (layer, poly index)
    merged_dilated: Polys,
    min_layer: i64,
    max_layer: i64,
    offset: f64,
    is_cantilever: bool,
    is_sharp_tail: bool,
    is_small: bool,
}
impl Cluster {
    fn new(layer: usize, idx: usize, poly: &Poly, offset: f64) -> Cluster {
        let mut c = Cluster { members: vec![], merged_dilated: vec![], min_layer: 10_000_000, max_layer: 0, offset,
                              is_cantilever: false, is_sharp_tail: false, is_small: false };
        c.insert(layer, idx, poly);
        c
    }
    fn insert(&mut self, layer: usize, idx: usize, poly: &Poly) {
        self.members.push((layer, idx));
        let dil = if self.offset > EPS { poly::offset(&poly1(poly), self.offset) } else { poly1(poly) };
        if !dil.is_empty() { self.merged_dilated = poly::union2(&self.merged_dilated, &dil); }
        self.min_layer = self.min_layer.min(layer as i64);
        self.max_layer = self.max_layer.max(layer as i64);
    }
    fn intersects(&self, poly: &Poly, layer: usize) -> bool {
        if layer < 1 { return false; }
        let l = layer as i64;
        if l < self.min_layer - 1 || l > self.max_layer + 1 { return false; }
        let dil = poly::offset(&poly1(poly), self.offset);
        poly::overlaps(&dil, &self.merged_dilated)
    }
}

/// Result of `top_contact_layers`
pub struct TopContacts { pub ids: Vec<Id> }

impl<'a> Gen<'a> {
    fn sync_gap_with_object_layer(&self, layer: usize, gap: f64, is_top: bool) -> usize {
        let n = self.layers.len();
        if is_top {
            // lower layers
            let mut lower: Option<usize> = if layer > 0 { Some(layer - 1) } else { None };
            let mut last_valid = lower.unwrap_or(layer);
            let mut synced = 0.0f64;
            while let Some(l) = lower {
                if synced >= gap { break; }
                last_valid = l;
                synced += self.layers[l].height;
                lower = if l > 0 { Some(l - 1) } else { None };
            }
            if (synced - self.layers[last_valid].height - gap).abs() < (synced - gap).abs() {
                synced -= self.layers[last_valid].height;
                let _ = synced;
                if last_valid + 1 < n { last_valid += 1; }
            }
            if last_valid > 0 { last_valid - 1 } else { last_valid }
        } else {
            let mut upper: Option<usize> = if layer + 1 < n { Some(layer + 1) } else { None };
            let mut last_valid = upper.unwrap_or(layer);
            let mut synced = 0.0f64;
            while let Some(u) = upper {
                if synced >= gap { break; }
                last_valid = u;
                synced += self.layers[u].height;
                upper = if u + 1 < n { Some(u + 1) } else { None };
            }
            if (synced - self.layers[last_valid].height - gap).abs() < (synced - gap).abs() {
                synced -= self.layers[last_valid].height;
                let _ = synced;
                if last_valid > 0 { last_valid -= 1; }
            }
            if gap > 0.0 {
                if last_valid + 1 < n { last_valid + 1 } else { last_valid }
            } else { last_valid }
        }
    }

    /// Port of `new_contact_layer` (no bridging-layer variant: thick_bridges is refused up front).
    fn new_contact_layer(&mut self, layer_id: usize) -> Option<Id> {
        let sp = &self.sp;
        let layer = &self.layers[layer_id];
        let (print_z, bottom_z, height);
        if layer_id == 0 {
            print_z = sp.raft_contact_top_z; bottom_z = sp.raft_interface_top_z; height = sp.contact_raft_layer_height;
        } else if sp.zero_gap_interface_top {
            let lower = &self.layers[layer_id - 1];
            print_z = layer.bottom_z();
            height = lower.height;
            bottom_z = if layer_id == 1 { sp.object_print_z_min } else { self.layers[layer_id - 2].print_z };
        } else {
            let (mut pz, mut hh);
            if self.cfg.independent_support_layer_height {
                pz = layer.bottom_z() - sp.gap_support_object;
                hh = 0.0;
            } else {
                let sl = self.sync_gap_with_object_layer(layer_id, sp.gap_support_object, true);
                pz = self.layers[sl].print_z;
                hh = self.layers[sl].height;
            }
            let mut bz = pz - hh;
            if pz < sp.first_print_layer_height - EPS { return None; }
            let has_raft = sp.raft_layers() > 1;
            let min_print_z = if has_raft { sp.raft_contact_top_z } else { sp.first_print_layer_height };
            if pz < min_print_z + self.p.layer_height_min {
                pz = min_print_z;
                bz = if has_raft { sp.raft_interface_top_z } else { 0.0 };
                hh = if has_raft { sp.contact_raft_layer_height } else { min_print_z };
            }
            print_z = pz; bottom_z = bz; height = hh;
        }
        let id = self.store.alloc(LT::TopContact);
        let l = &mut self.store.v[id];
        l.idx_above = Some(layer_id);
        l.print_z = print_z; l.bottom_z = bottom_z; l.height = height;
        Some(id)
    }

    /// Port of `detect_contacts` for one layer. Returns (contact_polygons, enforcer_polygons, no_interface_offset, slices_margin_polygons, slices_margin_all)
    fn detect_contacts(&self, layer_id: usize, overhang_polygons: &mut Polys) -> (Polys, Polys, f64, Polys, Polys) {
        let c = self.cfg;
        let buildplate_only = !self.buildplate_covered.is_empty();
        let layer = &self.layers[layer_id];
        let mut contact: Polys = Vec::new();
        let mut enforcer_out: Polys = Vec::new();
        let mut no_interface_offset = 0.0;
        let mut margin_polys: Polys = Vec::new();
        let mut margin_all: Polys = Vec::new();
        if layer_id == 0 {
            contact = if c.raft_expansion > 0.0 { poly::offset(overhang_polygons, c.raft_expansion) } else { overhang_polygons.clone() };
        } else if !layer.slices.is_empty() {
            let lower = &self.layers[layer_id - 1];
            let has_enforcer = !self.enforcers.is_empty() && !self.enforcers[layer_id].is_empty();
            no_interface_offset = self.p.ext_perimeter_width;
            let lower_layer_polygons = &lower.slices;
            // slices_margin_update(min(lower_layer_offset == 0, gap_xy) == 0, no_interface_offset): offset 0 -> polygons = lower layer polygons
            let mut margin = lower_layer_polygons.clone();
            if buildplate_only && !self.buildplate_covered[layer_id].is_empty() {
                if has_enforcer { margin_all = margin.clone(); }
                margin = poly::union2(&margin, &self.buildplate_covered[layer_id]);
            }
            let diff_polygons = poly::intersect(overhang_polygons, &layer.slices);
            if !diff_polygons.is_empty() {
                contact.extend(poly::diff(&diff_polygons, &margin));
            }
            if has_enforcer {
                let src = &self.enforcers[layer_id];
                if !src.is_empty() {
                    enforcer_out = poly::diff(&poly::intersect(&layer.slices, src), &poly::offset_sq(lower_layer_polygons, 0.05 * no_interface_offset));
                    if !enforcer_out.is_empty() {
                        overhang_polygons.extend(enforcer_out.clone());
                        let trim = if margin_all.is_empty() { &margin } else { &margin_all };
                        contact.extend(poly::diff(&enforcer_out, trim));
                    }
                }
            }
            margin_polys = margin;
        }
        (contact, enforcer_out, no_interface_offset, margin_polys, margin_all)
    }

    /// Port of `fill_contact_layer`.
    fn fill_contact_layer(&mut self, id: Id, layer_id: usize, margin: &Polys, margin_all: &Polys, overhang: &Polys,
                          contact: &Polys, enforcer: &Polys, no_interface_offset: f64) {
        let gp = self.p.grid_params(self.cfg);
        let lower_polys: Polys = if layer_id == 0 { Vec::new() } else { self.layers[layer_id - 1].slices.clone() };
        let lower_dense = || poly::opening_sq(&lower_polys, no_interface_offset * 0.5, no_interface_offset * (0.6f32 + 0.5f32) as f64);
        let grid = SupportGridPattern::new(contact, margin, &gp);
        let contact_polygons = grid.extract_support(gp.expansion_to_propagate, true);
        let reduce_interfaces = self.p.style != SupportStyle::Snug && layer_id > 0 && !self.sp.zero_gap_interface_top;
        let mut polygons: Polys = Vec::new();
        if reduce_interfaces {
            let dense = poly::diff(overhang, &lower_dense());
            if !dense.is_empty() {
                let dense = poly::diff(&poly::offset(&dense, no_interface_offset * 0.1), margin);
                let dense_trimmed = poly::intersect(&dense, &contact_polygons);
                let g2 = SupportGridPattern::new(&dense_trimmed, margin, &gp);
                polygons = g2.extract_support(gp.expansion_to_slice, false);
            }
        } else {
            polygons = grid.extract_support(gp.expansion_to_slice, true);
        }
        let mut enforcer_polys: Option<Polys> = None;
        if !enforcer.is_empty() && !margin_all.is_empty() && layer_id > 0 {
            let g3 = SupportGridPattern::new(enforcer, margin_all, &gp);
            let ep = g3.extract_support(gp.expansion_to_propagate, true);
            let mut new_polygons: Polys = Vec::new();
            if reduce_interfaces {
                let dense = poly::diff(enforcer, &lower_dense());
                if !dense.is_empty() {
                    let dense = poly::diff(&poly::offset(&dense, no_interface_offset * 0.1), margin_all);
                    let dense_trimmed = poly::intersect(&dense, &ep);
                    let g4 = SupportGridPattern::new(&dense_trimmed, margin_all, &gp);
                    new_polygons = g4.extract_support(gp.expansion_to_slice, false);
                }
            } else {
                new_polygons = g3.extract_support(gp.expansion_to_slice, true);
            }
            let needs_union = !polygons.is_empty();
            polygons.extend(new_polygons);
            if needs_union { polygons = poly::union(&polygons); }
            enforcer_polys = Some(ep);
        }
        let l = &mut self.store.v[id];
        l.polygons = polygons;
        l.contact = Some(contact_polygons);
        l.overhang = Some(overhang.clone());
        if !enforcer.is_empty() { l.enforcer = Some(enforcer_polys.unwrap_or_else(|| enforcer.clone())); }
    }

    fn merge_contact_layers(&mut self, layers: &mut Vec<Id>) {
        let min_h = self.p.layer_height_min;
        layers.sort_by(|a, b| self.store.v[*a].print_z.partial_cmp(&self.store.v[*b].print_z).unwrap());
        let first_h = self.sp.first_print_layer_height;
        let mut i = 0usize;
        let mut k = 0usize;
        {
            let mut j = 0usize;
            while j < layers.len() && self.store.v[layers[j]].print_z < first_h + min_h - EPS { j += 1; }
            if j > 0 {
                let dst = layers[0];
                for u in 1..j { let src = layers[u]; self.store.merge(dst, src); }
                let d = &mut self.store.v[dst];
                d.print_z = first_h; d.height = first_h; d.bottom_z = 0.0;
                k += 1;
            }
            i = j;
        }
        while i < layers.len() {
            let mut j = i + 1;
            let zmax = self.store.v[layers[i]].print_z + min_h + EPS;
            while j < layers.len() && self.store.v[layers[j]].print_z < zmax { j += 1; }
            if i + 1 < j {
                let dst = layers[i];
                for u in i + 1..j { let src = layers[u]; self.store.merge(dst, src); }
            }
            if k < i { layers[k] = layers[i]; }
            i = j;
            k += 1;
        }
        layers.truncate(k);
    }

    /// Port of `PrintObjectSupportMaterial::top_contact_layers`.
    pub fn top_contact_layers(&mut self) -> Vec<Id> {
        let c = self.cfg;
        if c.enable_support && !matches!(c.support_type, SupportType::NormalAuto | SupportType::NormalManual) {
            return Vec::new();
        }
        let n = self.layers.len();
        let num_layers = if self.has_support() { n } else { 1.min(n) };
        let layer_id_start = if self.has_raft() { 0 } else { 1 };
        let mut overhangs_per_layer: Vec<Polys> = vec![Vec::new(); num_layers];
        // detect overhangs (+ own sharp tails / cantilevers)
        for layer_id in layer_id_start..num_layers {
            let (ov, sharp, cant) = self.detect_overhangs(layer_id);
            overhangs_per_layer[layer_id] = ov;
            let l = &mut self.layers[layer_id];
            for (p, h) in sharp { l.sharp_tails.push(p); l.sharp_tails_h.push(h); }
            l.cantilevers = cant;
        }
        // propagate sharp tails upwards
        let extrusion_width = c.line_width;
        if c.support_type.is_auto() {
            for layer_nr in layer_id_start..num_layers {
                if layer_nr == 0 { continue; }
                let lower_tails: Polys = self.layers[layer_nr - 1].sharp_tails.clone();
                let lower_tails_h: Vec<f64> = self.layers[layer_nr - 1].sharp_tails_h.clone();
                let lower_slices = self.layers[layer_nr - 1].slices.clone();
                let slices = self.layers[layer_nr].slices.clone();
                let height = self.layers[layer_nr].height;
                for expoly in &slices {
                    let e1 = poly1(expoly);
                    let mut is_sharp = false;
                    let mut accum = height;
                    'once: loop {
                        let supported = poly::intersect(&e1, &lower_tails);
                        if supported.is_empty() { break 'once; }
                        let sz = bbox_size(&supported);
                        if sz[0] > LENGTH_THRESH_WELL_SUPPORTED && sz[1] > LENGTH_THRESH_WELL_SUPPORTED { break 'once; }
                        for (i, t) in lower_tails.iter().enumerate() {
                            if poly::overlaps(&poly1(t), &e1) { accum += lower_tails_h[i]; break; }
                        }
                        if accum > SHARP_TAIL_MAX_SUPPORT_HEIGHT { break 'once; }
                        let new_overhang = poly::diff(&e1, &lower_tails);
                        let s_new = bbox_size(&new_overhang);
                        let s_low = bbox_size(&lower_tails);
                        if (s_new[0] - s_low[0] > 5.0 && s_new[1] - s_low[1] > 5.0) || !poly::offset(&new_overhang, -5.0 * extrusion_width).is_empty() { break 'once; }
                        is_sharp = true;
                        break 'once;
                    }
                    if is_sharp {
                        let mut overhang = poly::diff(&e1, &lower_slices);
                        let l = &mut self.layers[layer_nr];
                        l.sharp_tails.push(expoly.clone());
                        l.sharp_tails_h.push(accum);
                        if !self.blockers.is_empty() && !self.blockers[layer_nr].is_empty() {
                            overhang = poly::diff(&overhang, &self.blockers[layer_nr]);
                        }
                        overhangs_per_layer[layer_nr].extend(overhang);
                    }
                }
            }
        }
        // group overhang clusters, remove small overhangs
        if c.support_remove_small_overhang {
            let fw = extrusion_width;
            let mut clusters: Vec<Cluster> = Vec::new();
            for layer_id in layer_id_start..num_layers {
                for (pi, ov) in overhangs_per_layer[layer_id].clone().iter().enumerate() {
                    let mut found: Option<usize> = None;
                    for (ci, cl) in clusters.iter().enumerate() {
                        if cl.intersects(ov, layer_id) { found = Some(ci); break; }
                    }
                    let ci = match found {
                        Some(ci) => { clusters[ci].insert(layer_id, pi, ov); ci }
                        None => { clusters.push(Cluster::new(layer_id, pi, ov, fw)); clusters.len() - 1 }
                    };
                    if poly::overlaps(&poly1(ov), &self.layers[layer_id].cantilevers) { clusters[ci].is_cantilever = true; }
                }
            }
            let mut removed: Vec<(usize, usize)> = Vec::new();
            for cl in clusters.iter_mut() {
                cl.is_sharp_tail = false;
                for layer_id in cl.min_layer as usize..=cl.max_layer as usize {
                    if poly::overlaps(&self.layers[layer_id].sharp_tails, &cl.merged_dilated) { cl.is_sharp_tail = true; break; }
                }
                if !cl.is_sharp_tail && !cl.is_cantilever {
                    cl.is_small = false;
                    let erode = poly::offset(&cl.merged_dilated, -1.0 * fw);
                    let sz = bbox_size(&erode);
                    if sz[0] < 2.0 * fw || sz[1] < 2.0 * fw { cl.is_small = true; }
                }
                if cl.is_small { removed.extend(cl.members.iter().cloned()); }
            }
            // clear removed overhangs (mark by index, remove afterwards to keep indices stable)
            let mut keep: Vec<Vec<bool>> = overhangs_per_layer.iter().map(|v| vec![true; v.len()]).collect();
            for (l, i) in removed { keep[l][i] = false; }
            for (l, v) in overhangs_per_layer.iter_mut().enumerate() {
                let mut k = 0;
                v.retain(|_| { let r = keep[l][k]; k += 1; r });
            }
        }
        // contacts
        let mut contact_out: Vec<Id> = Vec::new();
        for layer_id in layer_id_start..num_layers {
            let mut overhang_polygons = overhangs_per_layer[layer_id].clone();
            let (contact, enforcer, nio, margin, margin_all) = self.detect_contacts(layer_id, &mut overhang_polygons);
            if !contact.is_empty() || !overhang_polygons.is_empty() {
                if let Some(id) = self.new_contact_layer(layer_id) {
                    self.fill_contact_layer(id, layer_id, &margin, &margin_all, &overhang_polygons, &contact, &enforcer, nio);
                    contact_out.push(id);
                }
            }
        }
        self.merge_contact_layers(&mut contact_out);
        contact_out
    }
}

// =============================================================================================
// bottom contacts + per-object-layer support areas
// =============================================================================================
/// index of the last element satisfying `pred` (a prefix predicate), -1 if none
pub fn idx_lower_or_equal<T>(v: &[T], pred: impl Fn(&T) -> bool) -> i64 {
    let mut lo = 0usize; let mut hi = v.len();
    while lo < hi { let m = (lo + hi) / 2; if pred(&v[m]) { lo = m + 1; } else { hi = m; } }
    lo as i64 - 1
}
/// index of the first element satisfying `pred` (a suffix predicate), len if none
pub fn idx_higher_or_equal<T>(v: &[T], pred: impl Fn(&T) -> bool) -> usize {
    let mut lo = 0usize; let mut hi = v.len();
    while lo < hi { let m = (lo + hi) / 2; if pred(&v[m]) { hi = m; } else { lo = m + 1; } }
    lo
}

impl<'a> Gen<'a> {
    /// `project_support_to_grid`: returns (polygons to print, polygons to propagate down)
    fn project_support_to_grid(&self, layer_id: usize, overhangs: &Polys, buildplate_covered: Option<Polys>) -> (Polys, Polys) {
        let gp = self.p.grid_params(self.cfg);
        let layer = &self.layers[layer_id];
        let trimming = match buildplate_covered { Some(b) => b, None => poly::offset(&layer.slices, SCALED_EPS) };
        let projection = poly::diff(overhangs, &trimming);
        // remove_sticks / remove_degenerate: the integer union already drops zero-area spikes.
        let grid = SupportGridPattern::new(&projection, &trimming, &gp);
        let first = grid.extract_support(gp.expansion_to_slice, true);
        let second = grid.extract_support(gp.expansion_to_propagate, true);
        (first, second)
    }

    fn detect_bottom_contacts(&mut self, layer_id: usize, top_contacts: &[Id], contact_idx: i64, layer_support_areas: &mut Vec<Polys>,
                              supports_projected: &Polys) -> Option<Id> {
        let layer_top = self.layers[layer_id].top.clone();
        if layer_top.is_empty() { return None; }
        let touching = poly::intersect(&layer_top, supports_projected);
        if touching.is_empty() { return None; }
        let layer_print_z = self.layers[layer_id].print_z;
        let id = self.store.alloc(LT::BottomContact);
        let (height, print_z);
        if self.cfg.independent_support_layer_height {
            let upper = &self.layers[layer_id + 1];
            height = if self.sp.zero_gap_interface_bottom { upper.height } else { self.p.bottom_interface_flow.height };
            print_z = if self.sp.zero_gap_interface_bottom { upper.print_z } else { layer_print_z + height + self.sp.gap_object_support };
        } else {
            let up = self.sync_gap_with_object_layer(layer_id, self.sp.gap_object_support, false);
            height = self.layers[up].height;
            print_z = self.layers[up].print_z;
        }
        let mut height = height; let mut print_z = print_z;
        let polygons = poly::offset_sq(&touching, self.p.flow.width);
        if !self.sp.zero_gap_interface_bottom {
            let mut top_idx = contact_idx.max(0) as usize;
            while top_idx < top_contacts.len() && self.store.v[top_contacts[top_idx]].print_z < print_z + self.p.layer_height_min + EPS {
                let tz = self.store.v[top_contacts[top_idx]].print_z;
                if tz > print_z - self.p.layer_height_min - EPS {
                    let diff = print_z - tz;
                    if diff > 0.0 {
                        if height - diff > self.p.layer_height_min {
                            print_z = tz; height -= diff;
                        } else { top_idx += 1; continue; }
                    } else {
                        print_z = tz; height -= diff;
                    }
                    break;
                }
                top_idx += 1;
            }
        }
        {
            let l = &mut self.store.v[id];
            l.height = height; l.print_z = print_z; l.bottom_z = layer_print_z; l.idx_below = Some(layer_id);
            l.bridging = !self.sp.zero_gap_interface_bottom && self.cfg.thick_bridges;
            l.polygons = polygons;
        }
        let touching_e = poly::offset(&touching, SCALED_EPS);
        for above_id in layer_id + 1..self.layers.len() {
            if self.layers[above_id].print_z > print_z - EPS { break; }
            if !layer_support_areas[above_id].is_empty() {
                layer_support_areas[above_id] = poly::diff(&layer_support_areas[above_id], &touching_e);
            }
        }
        Some(id)
    }

    pub fn bottom_contact_layers_and_layer_support_areas(&mut self, top_contacts: &[Id]) -> (Vec<Id>, Vec<Polys>) {
        let n = self.layers.len();
        let mut layer_support_areas: Vec<Polys> = vec![Vec::new(); n];
        if top_contacts.is_empty() { return (Vec::new(), layer_support_areas); }
        let buildplate_only = !self.buildplate_covered.is_empty();
        let mut bottom_contacts: Vec<Id> = Vec::new();
        let mut overhangs_projection: Polys = Vec::new();
        let mut enforcers_projection: Polys = Vec::new();
        let mut contact_idx: i64 = top_contacts.len() as i64 - 1;
        for layer_id in (0..n.saturating_sub(1)).rev() {
            let layer_print_z = self.layers[layer_id].print_z;
            while contact_idx >= 0 && self.store.v[top_contacts[contact_idx as usize]].print_z > layer_print_z - EPS {
                let tid = top_contacts[contact_idx as usize];
                let mut polygons_new: Polys = Vec::new();
                let mut enforcers_new: Polys = Vec::new();
                let t = &mut self.store.v[tid];
                if let Some(cp) = t.contact.take() { polygons_new.extend(cp); }
                if let Some(ep) = t.enforcer.take() { enforcers_new.extend(ep); }
                if let Some(op) = &t.overhang { polygons_new.extend(poly::offset(op, SCALED_EPS)); }
                overhangs_projection.extend(poly::union(&polygons_new));
                enforcers_projection.extend(enforcers_new);
                contact_idx -= 1;
            }
            if overhangs_projection.is_empty() && enforcers_projection.is_empty() { continue; }
            let overhangs_raw = poly::union(&std::mem::take(&mut overhangs_projection));
            let enforcers_raw = poly::union(&std::mem::take(&mut enforcers_projection));
            let for_bottom = if buildplate_only { &enforcers_raw } else { &overhangs_raw };
            if !for_bottom.is_empty() {
                if let Some(bid) = self.detect_bottom_contacts(layer_id, top_contacts, contact_idx, &mut layer_support_areas, for_bottom) {
                    bottom_contacts.push(bid);
                }
            }
            let bp = if self.buildplate_covered.is_empty() { None } else { Some(std::mem::take(&mut self.buildplate_covered[layer_id])) };
            let (area, proj) = self.project_support_to_grid(layer_id, &overhangs_raw, bp);
            layer_support_areas[layer_id] = area;
            overhangs_projection = proj;
            let mut enf_area: Polys = Vec::new();
            if !enforcers_raw.is_empty() {
                let (a, p2) = self.project_support_to_grid(layer_id, &enforcers_raw, None);
                enf_area = a;
                enforcers_projection = p2;
            }
            if !enf_area.is_empty() {
                if layer_support_areas[layer_id].is_empty() { layer_support_areas[layer_id] = enf_area; }
                else { layer_support_areas[layer_id] = poly::union2(&layer_support_areas[layer_id], &enf_area); }
            }
        }
        bottom_contacts.reverse();
        let (gso, gos, gxy) = (self.sp.gap_support_object, self.sp.gap_object_support, self.p.gap_xy);
        self.trim_support_layers_by_object(&bottom_contacts, gso, gos, gxy);
        (bottom_contacts, layer_support_areas)
    }

    pub fn trim_top_contacts_by_bottom_contacts(&mut self, bottom_contacts: &[Id], top_contacts: &[Id]) {
        for idx_top in (0..top_contacts.len()).rev() {
            let (top_bottom_z, top_print_z) = { let t = &self.store.v[top_contacts[idx_top]]; (t.bottom_z, t.print_z) };
            let first = idx_lower_or_equal(bottom_contacts, |b| self.store.v[*b].bottom_print_z() - EPS <= top_bottom_z);
            let mut i = first;
            while i >= 0 {
                let b = &self.store.v[bottom_contacts[i as usize]];
                if top_print_z < b.print_z + EPS {
                    let bp = b.polygons.clone();
                    let t = &mut self.store.v[top_contacts[idx_top]];
                    t.polygons = poly::diff(&t.polygons, &bp);
                } else { break; }
                i -= 1;
            }
        }
    }

    pub fn trim_support_layers_by_object(&mut self, support_layers: &[Id], gap_extra_above: f64, gap_extra_below: f64, gap_xy: f64) {
        let gap_xy_scaled = gap_xy;
        for &sid in support_layers {
            let (pz, bz_print, empty) = { let s = &self.store.v[sid]; (s.print_z, s.bottom_print_z(), s.polygons.is_empty()) };
            if empty || pz < self.sp.raft_contact_top_z + EPS { continue; }
            let (support_bottom_z, support_print_z) = { let s = &self.store.v[sid]; (s.bottom_z, s.print_z) };
            let z_threshold = bz_print - gap_extra_below + EPS;
            let first = idx_higher_or_equal(&self.layers, |l| l.print_z >= z_threshold);
            let mut trimming: Polys = Vec::new();
            let is_overlap = |ol: &OL| -> bool {
                if (support_print_z - ol.print_z).abs() < EPS { return true; }
                let object_lh = ol.height;
                if support_print_z < ol.print_z && support_print_z > ol.print_z - object_lh { return true; }
                if support_print_z > ol.print_z && support_bottom_z < ol.print_z - EPS { return true; }
                false
            };
            for i in first..self.layers.len() {
                let ol = &self.layers[i];
                if ol.bottom_z() > support_print_z + gap_extra_above - EPS { break; }
                let ov = is_overlap(ol);
                for ex in &ol.slices {
                    let is_sharptail = !poly::intersect(&poly1(ex), &ol.sharp_tails).is_empty();
                    let off = if is_sharptail { SHARP_TAIL_XY_GAP } else if ov { gap_xy_scaled } else { NO_OVERLAP_XY_GAP };
                    trimming.extend(poly::offset_sq(&poly1(ex), off));
                }
            }
            let polys = std::mem::take(&mut self.store.v[sid].polygons);
            self.store.v[sid].polygons = poly::diff(&polys, &trimming);
        }
    }
}

// =============================================================================================
// intermediate (base) layers, interfaces, raft
// =============================================================================================
impl<'a> Gen<'a> {
    pub fn raft_and_intermediate_support_layers(&mut self, bottom_contacts: &[Id], top_contacts: &[Id]) -> Vec<Id> {
        let mut intermediate: Vec<Id> = Vec::new();
        let mut extremes: Vec<Id> = Vec::new();
        extremes.extend_from_slice(top_contacts);
        extremes.extend_from_slice(bottom_contacts);
        if extremes.is_empty() { return intermediate; }
        {
            let st = &self.store;
            extremes.sort_by(|a, b| {
                let (la, lb) = (&st.v[*a], &st.v[*b]);
                let (z1, z2) = (la.extreme_z(), lb.extreme_z());
                let a_lt_b = z1 < z2 || (z1 == z2 && la.ty == LT::TopContact && lb.ty == LT::BottomContact);
                let b_lt_a = z2 < z1 || (z1 == z2 && lb.ty == LT::TopContact && la.ty == LT::BottomContact);
                if a_lt_b { std::cmp::Ordering::Less } else if b_lt_a { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal }
            });
        }
        let synchronize = self.synchronize_layers();
        let first_h = self.sp.first_print_layer_height;
        let raft_if_top = self.sp.raft_interface_top_z;
        let mut idx_layer_object = 0usize;
        let mut idx_extreme_first = 0usize;
        if (self.store.v[extremes[0]].extreme_z() - raft_if_top).abs() < EPS { idx_extreme_first = 1; }
        for idx_extreme in idx_extreme_first..extremes.len() {
            let e2 = extremes[idx_extreme];
            let mut extr2z = self.store.v[e2].extreme_z();
            if (extr2z - first_h).abs() < EPS {
                if intermediate.is_empty() || self.store.v[*intermediate.last().unwrap()].print_z < first_h {
                    let id = self.store.alloc(LT::Intermediate);
                    let l = &mut self.store.v[id];
                    l.bottom_z = 0.0; l.print_z = first_h; l.height = first_h;
                    intermediate.push(id);
                }
                continue;
            }
            let e1: Option<Id> = if idx_extreme == idx_extreme_first { None } else { Some(extremes[idx_extreme - 1]) };
            let mut extr1z = match e1 { None => raft_if_top, Some(e) => self.store.v[e].extreme_z() };
            if extr1z.abs() < EPS {
                let id = self.store.alloc(LT::Intermediate);
                let l = &mut self.store.v[id];
                l.bottom_z = 0.0; l.print_z = first_h; l.height = first_h;
                extr1z = first_h;
                intermediate.push(id);
            }
            let mut dist = extr2z - extr1z;
            if dist == 0.0 { continue; }
            if synchronize {
                while idx_layer_object < self.layers.len() && self.layers[idx_layer_object].print_z < extr1z + EPS { idx_layer_object += 1; }
                if idx_layer_object == 0 && extr1z == raft_if_top {
                    let id = self.store.alloc(LT::Intermediate);
                    let l = &mut self.store.v[id];
                    l.print_z = self.sp.object_print_z_min; l.bottom_z = raft_if_top; l.height = l.print_z - l.bottom_z;
                    intermediate.push(id);
                }
                while idx_layer_object < self.layers.len() && self.layers[idx_layer_object].print_z < extr2z + EPS {
                    let ol = &self.layers[idx_layer_object];
                    let (pz, h) = (ol.print_z, ol.height);
                    let bz = if idx_layer_object > 0 { self.layers[idx_layer_object - 1].print_z } else { pz - h };
                    let id = self.store.alloc(LT::Intermediate);
                    let l = &mut self.store.v[id];
                    l.print_z = pz; l.height = h; l.bottom_z = bz;
                    intermediate.push(id);
                    idx_layer_object += 1;
                }
            } else {
                let max_h = self.sp.max_support_layer_height;
                let mut n_extra = ((dist - EPS) / max_h).ceil() as usize;
                let mut step = dist / n_extra as f64;
                if let Some(e1) = e1 {
                    let (e1ty, e1pz, e1bz, e1h) = { let l = &self.store.v[e1]; (l.ty, l.print_z, l.bottom_z, l.height) };
                    if e1ty == LT::TopContact && e1pz + self.p.layer_height_min > e1bz + step {
                        let id = self.store.alloc(LT::Intermediate);
                        let l = &mut self.store.v[id];
                        l.bottom_z = e1bz; l.print_z = e1pz; l.height = e1h;
                        extr1z = e1pz;
                        intermediate.push(id);
                        dist = extr2z - extr1z;
                        n_extra = ((dist - EPS) / max_h).ceil() as usize;
                        if n_extra == 0 { continue; }
                        step = dist / n_extra as f64;
                    }
                }
                if !self.sp.zero_gap_interface_top && self.store.v[e2].ty == LT::TopContact {
                    let l = &mut self.store.v[e2];
                    l.height = step;
                    extr2z = l.print_z - step;
                    l.bottom_z = extr2z;
                    n_extra -= 1;
                    if n_extra == 0 { continue; }
                }
                let extr2z_large = extr2z;
                for i in 0..n_extra {
                    let id = self.store.alloc(LT::Intermediate);
                    let prev_pz = intermediate.last().map(|p| self.store.v[*p].print_z);
                    let l = &mut self.store.v[id];
                    if i + 1 == n_extra {
                        l.bottom_z = if i == 0 { extr1z } else { prev_pz.unwrap() };
                        l.print_z = extr2z_large;
                        l.height = l.print_z - l.bottom_z;
                    } else {
                        l.height = step;
                        l.bottom_z = extr1z + i as f64 * step;
                        l.print_z = l.bottom_z + step;
                    }
                    intermediate.push(id);
                }
            }
        }
        intermediate
    }

    pub fn generate_base_layers(&mut self, bottom_contacts: &[Id], top_contacts: &[Id], intermediate: &[Id], layer_support_areas: &[Polys]) {
        if top_contacts.is_empty() { return; }
        for &iid in intermediate {
            let (ipz, ibz) = { let l = &self.store.v[iid]; (l.print_z, l.bottom_z) };
            let mut trimming: Polys = Vec::new();
            let idx_top_above = idx_lower_or_equal(top_contacts, |t| self.store.v[*t].bottom_z <= ipz - EPS);
            let mut k = idx_top_above;
            while k >= 0 {
                let t = &self.store.v[top_contacts[k as usize]];
                if t.print_z < ibz + EPS { break; }
                if ipz <= t.print_z + EPS && ibz >= t.bottom_z - EPS { trimming.extend(t.polygons.iter().cloned()); }
                k -= 1;
            }
            let idx_obj_above = idx_lower_or_equal(&self.layers, |l| l.print_z <= ipz + EPS);
            let mut new_polys: Polys;
            if idx_obj_above < 0 {
                new_polys = layer_support_areas[0].clone();
                let first_layer_z = self.layers[0].print_z;
                for i in (idx_top_above + 1) as usize..top_contacts.len() {
                    let c = &self.store.v[top_contacts[i]];
                    if c.print_z > first_layer_z + EPS { break; }
                    new_polys.extend(c.polygons.iter().cloned());
                }
            } else {
                new_polys = layer_support_areas[idx_obj_above as usize].clone();
            }
            let idx_bottom = idx_lower_or_equal(bottom_contacts, |b| self.store.v[*b].bottom_print_z() <= ipz - EPS);
            let mut k = idx_bottom;
            while k >= 0 {
                let b = &self.store.v[bottom_contacts[k as usize]];
                if b.print_z < ibz_print(&self.store.v[iid]) + EPS { break; }
                if ipz <= b.print_z + EPS && ibz >= b.bottom_print_z() - EPS { trimming.extend(b.polygons.iter().cloned()); }
                k -= 1;
            }
            let res = if trimming.is_empty() { new_polys } else { poly::diff(&new_polys, &trimming) };
            let l = &mut self.store.v[iid];
            l.polygons = res;
            l.ty = LT::Base;
        }
        let (gso, gos, gxy) = (self.sp.gap_support_object, self.sp.gap_object_support, self.p.gap_xy);
        self.trim_support_layers_by_object(intermediate, gso, gos, gxy);
    }

    /// Returns the top (+bottom) interface layers, in intermediate-layer order. Base-interface layers
    /// (soluble interface over non-soluble base) are not generated: single material supports only.
    pub fn generate_interface_layers(&mut self, bottom_contacts: &[Id], top_contacts: &[Id], intermediate: &[Id], pre: &[Id]) -> Vec<Id> {
        let mut out: Vec<Id> = Vec::new();
        if intermediate.is_empty() || !self.p.has_interfaces() { return out; }
        let mut pre_used = vec![false; pre.len()];
        let snug = self.p.style == SupportStyle::Snug;
        let smooth = self.p.style != SupportStyle::Grid;
        let num_top = if self.p.has_top_contacts { self.p.num_top_interface - 1 } else { 0 };
        let num_bottom = if self.p.has_bottom_contacts { self.p.num_bottom_interface - 1 } else { 0 };
        let n_int = intermediate.len();
        let smoothing = self.p.interface_flow.spacing * 1.5;
        let min_island_top = self.p.interface_flow.spacing / self.p.top_interface_density;
        let min_island_bottom = self.p.interface_flow.spacing / self.p.bottom_interface_density;
        for idx in 0..n_int {
            let iid = intermediate[idx];
            let (ipz, ibz) = { let l = &self.store.v[iid]; (l.print_z, l.bottom_z) };
            let mut top_proj: Polys = Vec::new();
            let mut bottom_proj: Polys = Vec::new();
            if num_top > 0 {
                let top_z = self.store.v[intermediate[(n_int - 1).min(idx + num_top - 1)]].print_z;
                let first = idx_higher_or_equal(top_contacts, |t| self.store.v[*t].print_z >= ipz);
                for k in first..top_contacts.len() {
                    let t = &self.store.v[top_contacts[k]];
                    if t.bottom_z - EPS > top_z { break; }
                    if snug { if let Some(o) = &t.overhang { top_proj.extend(o.iter().cloned()); } }
                    else { top_proj.extend(t.polygons.iter().cloned()); }
                }
            }
            if num_bottom > 0 {
                let bottom_z = self.store.v[intermediate[idx.saturating_sub(num_bottom - 1)]].bottom_z;
                let first = idx_higher_or_equal(bottom_contacts, |b| self.store.v[*b].print_z >= bottom_z - EPS);
                for k in first..bottom_contacts.len() {
                    let b = &self.store.v[bottom_contacts[k]];
                    if b.print_z - EPS > ibz { break; }
                    bottom_proj.extend(b.polygons.iter().cloned());
                }
            }
            // precomputed (organic) top interface at this print_z
            let pre_idx = pre.iter().position(|&p| (self.store.v[p].print_z - ipz).abs() < EPS);
            let pre_nonempty = pre_idx.map(|k| !self.store.v[pre[k]].polygons.is_empty()).unwrap_or(false);
            if bottom_proj.is_empty() && top_proj.is_empty() && !pre_nonempty { continue; }
            let ty = if top_proj.is_empty() { LT::BottomInterface } else { LT::TopInterface };
            // insert_layer
            let regularize = |polys: Polys, min_island: f64| -> Polys {
                if polys.is_empty() { return polys; }
                if smooth {
                    // closing(polys, closing_distance + minimum_island_radius, closing_distance); smooth_outward is approximated
                    // by omission (see approximations in mod.rs)
                    poly::closing_sq(&polys, smoothing + min_island, smoothing)
                } else { poly::union(&polys) }
            };
            let mut b = regularize(bottom_proj, min_island_bottom);
            let t = regularize(top_proj, min_island_top);
            b.extend(t);
            let inter_polys = self.store.v[iid].polygons.clone();
            let mut bottom = poly::intersect(&poly::union(&b), &inter_polys);
            let mut reuse: Option<Id> = None;
            if pre_nonempty {
                let k = pre_idx.unwrap();
                let pp = std::mem::take(&mut self.store.v[pre[k]].polygons);
                bottom = poly::union2(&pp, &bottom);
                reuse = Some(pre[k]);
                pre_used[k] = true;
            }
            if bottom.is_empty() { continue; }
            let id = match reuse { Some(r) => r, None => self.store.alloc(ty) };
            let (print_z, bottom_z, height, bridging) = { let l = &self.store.v[iid]; (l.print_z, l.bottom_z, l.height, l.bridging) };
            {
                let l = &mut self.store.v[id];
                l.polygons = bottom.clone();
                l.print_z = print_z; l.bottom_z = bottom_z; l.height = height; l.bridging = bridging;
            }
            let lp = &mut self.store.v[iid];
            lp.polygons = poly::diff(&lp.polygons, &bottom);
            out.push(id);
        }
        // unmatched precomputed layers are merged in print_z order
        let mut extra: Vec<Id> = Vec::new();
        for (k, &p) in pre.iter().enumerate() { if !pre_used[k] && !self.store.v[p].polygons.is_empty() { extra.push(p); } }
        if !extra.is_empty() {
            out.extend(extra);
            let st = &self.store;
            out.sort_by(|a, b| st.v[*a].print_z.partial_cmp(&st.v[*b].print_z).unwrap());
        }
        out
    }

    /// Port of `generate_raft_base`. Returns the raft layers (excluding the contact layer).
    pub fn generate_raft_base(&mut self, top_contacts: &[Id], interface_layers: &[Id], base_layers: &[Id], brim: &Polys) -> Vec<Id> {
        let sp = self.sp.clone();
        let inflate_fine = if sp.raft_layers() > 1 { 0.5 } else { EPS };
        let inflate_1st = (self.cfg.raft_first_layer_expansion - inflate_fine).max(0.0);
        let mut contacts = top_contacts.first().copied();
        let mut interfaces = interface_layers.first().copied();
        let mut columns_base = base_layers.first().copied();
        if let Some(c) = contacts { if self.store.v[c].print_z > sp.first_print_layer_height.max(sp.raft_contact_top_z) + EPS { contacts = None; } }
        if let Some(c) = interfaces { if self.store.v[c].bottom_print_z() > sp.raft_interface_top_z + EPS { interfaces = None; } }
        if let Some(c) = columns_base { if self.store.v[c].bottom_print_z() > sp.raft_interface_top_z + EPS { columns_base = None; } }
        let mut interface_polygons: Polys = Vec::new();
        for id in [contacts, interfaces].into_iter().flatten() {
            let p = &self.store.v[id].polygons;
            if !p.is_empty() { interface_polygons.extend(poly::offset_sq(p, inflate_fine)); }
        }
        let mut raft_layers: Vec<Id> = Vec::new();
        if sp.raft_layers() > 1 {
            let mut base: Polys = Vec::new();
            let mut columns: Polys = Vec::new();
            let mut first_layer: Polys = Vec::new();
            if let Some(cb) = columns_base {
                if self.store.v[cb].bottom_print_z() > sp.raft_interface_top_z - EPS {
                    base = self.store.v[cb].polygons.clone();
                    columns = base.clone();
                    if !interface_polygons.is_empty() { columns = poly::diff(&columns, &interface_polygons); }
                } else {
                    first_layer = self.store.v[cb].polygons.clone();
                }
            }
            if !interface_polygons.is_empty() { base = poly::union2(&base, &interface_polygons); }
            {
                let id = self.store.alloc(if sp.base_raft_layers > 0 { LT::RaftBase } else { LT::RaftInterface });
                raft_layers.push(id);
                first_layer = poly::union2(&first_layer, &base);
                let polys = if inflate_1st > 0.0 { poly::offset(&first_layer, inflate_1st) } else { first_layer };
                let l = &mut self.store.v[id];
                l.print_z = sp.first_print_layer_height; l.height = sp.first_print_layer_height; l.bottom_z = 0.0;
                l.polygons = polys;
            }
            for _ in 1..sp.base_raft_layers {
                let pz = self.store.v[*raft_layers.last().unwrap()].print_z;
                let id = self.store.alloc(LT::RaftBase);
                raft_layers.push(id);
                let l = &mut self.store.v[id];
                l.print_z = pz + sp.base_raft_layer_height; l.height = sp.base_raft_layer_height; l.bottom_z = pz; l.polygons = base.clone();
            }
            for _ in 1..sp.interface_raft_layers {
                let pz = self.store.v[*raft_layers.last().unwrap()].print_z;
                let id = self.store.alloc(LT::RaftInterface);
                raft_layers.push(id);
                let l = &mut self.store.v[id];
                l.print_z = pz + sp.interface_raft_layer_height; l.height = sp.interface_raft_layer_height; l.bottom_z = pz;
                l.polygons = interface_polygons.clone();
                l.contact = Some(columns.clone()); // misused for support columns, as in Orca
            }
        } else {
            if let Some(cb) = columns_base {
                let mut raft = self.store.v[cb].polygons.clone();
                let trimming = poly::offset_sq(&self.layers[0].slices, self.p.gap_xy_first_layer);
                if inflate_1st > SCALED_EPS {
                    let nsteps = 5.max((inflate_1st / self.p.first_layer_flow.width).ceil() as usize);
                    let step = inflate_1st / nsteps as f64;
                    for _ in 0..nsteps { raft = poly::diff(&poly::offset(&raft, step), &trimming); }
                } else { raft = poly::diff(&raft, &trimming); }
                self.store.v[cb].polygons = raft;
                if !interface_polygons.is_empty() {
                    let p = std::mem::take(&mut self.store.v[cb].polygons);
                    self.store.v[cb].polygons = poly::diff(&p, &interface_polygons);
                }
            }
            if !brim.is_empty() {
                for id in [columns_base, contacts, interfaces].into_iter().flatten() {
                    let p = std::mem::take(&mut self.store.v[id].polygons);
                    self.store.v[id].polygons = poly::diff(&p, brim);
                }
            }
        }
        raft_layers
    }
}

fn ibz_print(l: &SL) -> f64 { l.bottom_print_z() }

// =============================================================================================
// support layer list + toolpaths
// =============================================================================================
use super::fill::{self, FillParams, Pl};
use crate::types::Feature;

#[derive(Clone, Debug)]
pub struct SupportLayerDesc {
    pub print_z: f64,
    pub height: f64,
    pub interface_id: usize,
    pub ids: Vec<Id>,
}

/// One extruded path before it becomes an `ExtPath`.
#[derive(Clone, Debug)]
pub struct PathOut {
    pub pts: Pl,
    pub feature: Feature,
    pub width: f64,
    pub height: f64,
    pub flow_ratio: f64,
    pub closed: bool,
    pub group: u32,
    pub no_sort: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role { Material, Interface }
impl Role { fn feature(self) -> Feature { match self { Role::Material => Feature::Support, Role::Interface => Feature::SupportInterface } } }

#[derive(Default, Clone)]
struct Extruded {
    id: Option<Id>,
    to_extrude: Option<Polys>,
    paths: Vec<PathOut>,
}

impl<'a> Gen<'a> {
    fn is_interface_type(t: LT) -> bool { matches!(t, LT::RaftInterface | LT::BottomContact | LT::BottomInterface | LT::TopContact | LT::TopInterface) }

    /// Port of `generate_support_layers`: sort, group by print_z, assign interface ids. Mutates print_z of grouped layers.
    pub fn generate_support_layers(&mut self, lists: &[&[Id]]) -> Vec<SupportLayerDesc> {
        let mut all: Vec<Id> = Vec::new();
        for l in lists { all.extend_from_slice(l); }
        all.sort_unstable();
        all.dedup();
        {
            let st = &self.store;
            all.sort_by(|a, b| {
                let (la, lb) = (&st.v[*a], &st.v[*b]);
                la.print_z.partial_cmp(&lb.print_z).unwrap()
                    .then(lb.height.partial_cmp(&la.height).unwrap())
                    .then((lb.bridging as u8).cmp(&(la.bridging as u8)))
            });
        }
        let mut out: Vec<SupportLayerDesc> = Vec::new();
        let mut layer_id_interface = 0usize;
        let mut i = 0usize;
        while i < all.len() {
            let mut j = i + 1;
            let zmax = self.store.v[all[i]].print_z + EPS;
            while j < all.len() && self.store.v[all[j]].print_z <= zmax { j += 1; }
            let zavg = 0.5 * (self.store.v[all[i]].print_z + self.store.v[all[j - 1]].print_z);
            let mut height_min = self.store.v[all[i]].height;
            let mut empty = true;
            let mut num_interfaces = 0usize;
            let mut num_top_contacts = 0usize;
            let mut top_contact_bottom_z = 0.0;
            for u in i..j {
                let l = &mut self.store.v[all[u]];
                if !l.polygons.is_empty() {
                    empty = false;
                    if Self::is_interface_type(l.ty) { num_interfaces += 1; }
                    if l.ty == LT::TopContact { num_top_contacts += 1; top_contact_bottom_z = l.bottom_z; }
                }
                l.print_z = zavg;
                height_min = height_min.min(l.height);
            }
            if !empty {
                let contacts_only = num_top_contacts > 0 && num_top_contacts == num_interfaces;
                let mut this_iid = layer_id_interface;
                if contacts_only {
                    for other in out.iter().rev() {
                        if (other.print_z - top_contact_bottom_z).abs() < EPS { this_iid = other.interface_id + 1; }
                    }
                }
                out.push(SupportLayerDesc { print_z: zavg, height: height_min, interface_id: this_iid, ids: all[i..j].to_vec() });
                if num_interfaces > 0 && !contacts_only { layer_id_interface += 1; }
            }
            i = j;
        }
        out
    }

    fn mk_path(&self, pl: Pl, role: Role, flow: &Flow, ratio: f64, group: u32, no_sort: bool, closed: bool) -> PathOut {
        PathOut { pts: pl, feature: role.feature(), width: flow.width, height: flow.height, flow_ratio: ratio, closed, group, no_sort }
    }

    /// `fill_expolygons_generate_paths` with the given pattern.
    fn fill_expolygons(&self, polys: &Polys, kind: FillKind, angle: f64, spacing: f64, density: f64, role: Role, flow: &Flow, ratio: f64, group: &mut u32, no_sort: bool, out: &mut Vec<PathOut>) {
        for ex in polys {
            let params = FillParams { spacing, density, angle };
            let pls: Vec<Pl> = match kind {
                FillKind::Rectilinear => fill::fill_rectilinear(ex, &params),
                FillKind::SupportBase => fill::fill_support_base(ex, &params),
                FillKind::Concentric => fill::fill_concentric(ex, &params),
                FillKind::Grid => fill::fill_grid(ex, &params),
                FillKind::Honeycomb => fill::fill_rectilinear(ex, &params), // approximation, see mod.rs
            };
            for pl in pls {
                if pl.len() < 2 { continue; }
                out.push(self.mk_path(pl, role, flow, ratio, *group, no_sort, false));
                if !no_sort { *group += 1; }
            }
        }
    }


    /// `tree_supports_generate_paths` (SupportCommon.cpp): hollow organic branches, one wall (or two) + a seam anchor.
    pub fn tree_supports_generate_paths(&self, polygons: &Polys, flow: &Flow, ratio: f64, double_wall_area: f64, group: &mut u32, out: &mut Vec<PathOut>) {
        let sp = flow.spacing;
        let clip_length = sp * 0.15;
        let anchor_length = sp * 6.0;
        const EPSILON: f64 = 1e-4;
        let d2 = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2);
        let closed = poly::closing(polygons, SCALED_EPS, SCALED_EPS + 0.5 * flow.width);
        for ex0 in closed {
            let mut expoly = ex0.clone();
            let mut regions: Vec<Poly> = vec![ex0.clone()];
            let mut eec: Option<Vec<Pl>> = None;
            if double_wall_area > 0.0 && poly::poly_area(&ex0) > double_wall_area {
                let mut e: Vec<Pl> = Vec::new();
                let level2 = poly::offset2(&vec![ex0.clone()], -1.5 * flow.width, 0.5 * flow.width);
                if !level2.is_empty() {
                    regions = level2.clone();
                    // draw_perimeters
                    let mut loops: Vec<Pl> = Vec::new();
                    let mut c = ex0.contour.clone(); if let Some(f) = c.first().cloned() { c.push(f); }
                    clip_end(&mut c, clip_length);
                    loops.push(c);
                    for h in &ex0.holes {
                        let mut hh = h.clone(); if let Some(f) = hh.first().cloned() { hh.push(f); }
                        hh.reverse();
                        clip_end(&mut hh, clip_length);
                        loops.push(hh);
                    }
                    e = loops;
                    expoly = level2[0].clone();
                }
                eec = Some(e);
            }
            let _ = &expoly;
            let mut eec_entities: Vec<Pl> = eec.clone().unwrap_or_default();
            for region in &regions {
                // anchor candidates: the region shrunk by one line width, vertices tagged with the source contour index
                let mut cand: Vec<Vec<([f64; 2], i32)>> = Vec::new();
                {
                    let contour_off = poly::offset_miter(&vec![Poly { contour: region.contour.clone(), holes: vec![] }], -flow.width, 1.2);
                    if !contour_off.is_empty() {
                        let mut src_rings: Vec<(i32, Vec<[f64; 2]>)> = Vec::new();
                        for r in poly::rings(&contour_off) { src_rings.push((0, r.clone())); }
                        let mut hole_off_all: Polys = Vec::new();
                        for (hi, h) in region.holes.iter().enumerate() {
                            let ho = poly::offset_miter(&vec![Poly { contour: { let mut hh = h.clone(); hh.reverse(); hh }, holes: vec![] }], flow.width, 1.2);
                            for r in poly::rings(&ho) { src_rings.push((1 + hi as i32, r.clone())); }
                            hole_off_all.extend(ho);
                        }
                        let paths: Vec<Vec<[f64; 2]>> = if hole_off_all.is_empty() {
                            poly::rings(&contour_off).into_iter().cloned().collect()
                        } else {
                            let df = poly::diff(&contour_off, &hole_off_all);
                            poly::rings(&df).into_iter().cloned().collect()
                        };
                        let seg_d2 = |p: [f64; 2], a: [f64; 2], b: [f64; 2]| -> f64 {
                            let v = [b[0] - a[0], b[1] - a[1]]; let l2 = v[0] * v[0] + v[1] * v[1];
                            let t = if l2 == 0.0 { 0.0 } else { (((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / l2).clamp(0.0, 1.0) };
                            d2(p, [a[0] + v[0] * t, a[1] + v[1] * t])
                        };
                        for path in paths {
                            let mut tagged: Vec<([f64; 2], i32)> = Vec::with_capacity(path.len());
                            for &p in &path {
                                let mut tags: Vec<i32> = Vec::new();
                                for (idx, r) in &src_rings {
                                    let n = r.len();
                                    let on = (0..n).any(|i| seg_d2(p, r[i], r[(i + 1) % n]) < 1e-8);
                                    if on && !tags.contains(idx) { tags.push(*idx); }
                                }
                                tagged.push((p, if tags.len() == 1 { tags[0] } else { -1 }));
                            }
                            // orient CW
                            if poly::ring_area(&path) > 0.0 { tagged.reverse(); }
                            cand.push(tagged);
                        }
                    }
                }
                let mut polylines: Vec<Pl> = Vec::new();
                let mut loops: Vec<(i32, Vec<[f64; 2]>)> = vec![(0, region.contour.clone())];
                for (hi, h) in region.holes.iter().enumerate() { loops.push((1 + hi as i32, h.clone())); }
                for (idx_loop, ring) in loops {
                    let mut pl: Pl = ring.clone();
                    if idx_loop == 0 { pl.reverse(); }
                    if let Some(f) = pl.first().cloned() { pl.push(f); }
                    clip_end(&mut pl, clip_length);
                    if pl.len() < 2 { continue; }
                    let seam = *pl.last().unwrap();
                    let mut best: Option<(usize, [f64; 2], usize, f64)> = None; // contour, point, idx, t
                    let mut d2min = f64::MAX;
                    for (ci, path) in cand.iter().enumerate() {
                        let n = path.len();
                        for i in 0..n {
                            let j = (i + 1) % n;
                            if path[i].1 == idx_loop || path[j].1 == idx_loop {
                                let (pi, pj) = (path[i].0, path[j].0);
                                let v = [pj[0] - pi[0], pj[1] - pi[1]];
                                let w = [seam[0] - pi[0], seam[1] - pi[1]];
                                let l2 = v[0] * v[0] + v[1] * v[1];
                                let t = (if l2 == 0.0 { 0.0 } else { (v[0] * w[0] + v[1] * w[1]) / l2 }).clamp(0.0, 1.0);
                                if (path[i].1 == idx_loop || t > EPSILON) && (path[j].1 == idx_loop || t < 1.0 - EPSILON) {
                                    let fp = [pi[0] + v[0] * t, pi[1] + v[1] * t];
                                    let dd = d2(fp, seam);
                                    if dd < d2min { d2min = dd; best = Some((ci, fp, i, t)); }
                                }
                            }
                        }
                    }
                    if let Some((ci, cp, cidx, ct)) = best {
                        if d2min < (flow.width * 3.0).powi(2) {
                            pl.push(cp);
                            let path = &cand[ci];
                            let n = path.len();
                            let mut remaining = anchor_length - d2(seam, cp).sqrt();
                            let mut i = cidx;
                            let mut j = (i + 1) % n;
                            let mut pi = path[i].0; let mut pj = path[j].0;
                            let mut v = [pj[0] - pi[0], pj[1] - pi[1]];
                            let mut l = (v[0] * v[0] + v[1] * v[1]).sqrt();
                            if remaining < (1.0 - ct) * l {
                                pl.push([cp[0] + v[0] * (remaining / l), cp[1] + v[1] * (remaining / l)]);
                            } else {
                                pl.push(pj);
                                pi = pj;
                                i = j;
                                while path[i].1 == idx_loop && remaining > 0.0 {
                                    j = (i + 1) % n;
                                    pj = path[j].0;
                                    v = [pj[0] - pi[0], pj[1] - pi[1]];
                                    l = (v[0] * v[0] + v[1] * v[1]).sqrt();
                                    if i == cidx { break; }
                                    if remaining <= l {
                                        pl.push([pi[0] + v[0] * (remaining / l), pi[1] + v[1] * (remaining / l)]);
                                        break;
                                    }
                                    pl.push(pj);
                                    remaining -= l;
                                    i = j; pi = pj;
                                }
                            }
                        }
                    }
                    pl.reverse();
                    polylines.push(pl);
                }
                if eec.is_some() { eec_entities.extend(polylines); } else {
                    for pl in polylines {
                        if pl.len() < 2 { continue; }
                        out.push(self.mk_path(pl, Role::Material, flow, ratio, *group, false, false));
                        *group += 1;
                    }
                }
            }
            if eec.is_some() {
                eec_entities.reverse();
                let g0 = *group;
                for pl in eec_entities {
                    if pl.len() < 2 { continue; }
                    out.push(self.mk_path(pl, Role::Material, flow, ratio, g0, true, false));
                }
                *group += 1;
            }
        }
    }

    /// `fill_expolygons_with_sheath_generate_paths` (sheath only for with_sheath).
    fn fill_with_sheath(&self, polygons: &Polys, kind: FillKind, angle: f64, spacing: f64, density: f64, role: Role, flow: &Flow, ratio: f64,
                        with_sheath: bool, no_sort: bool, group: &mut u32, out: &mut Vec<PathOut>) {
        if polygons.is_empty() { return; }
        if !with_sheath {
            let closed = poly::closing(polygons, SCALED_EPS, SCALED_EPS);
            self.fill_expolygons(&closed, kind, angle, spacing, density, role, flow, ratio, group, no_sort, out);
            return;
        }
        let sp = flow.spacing;
        let clip_length = sp * 0.15;
        let closed = poly::closing(polygons, SCALED_EPS, SCALED_EPS + 0.5 * flow.width);
        for ex in closed {
            let g0 = *group;
            // perimeters
            let mut rings: Vec<Pl> = Vec::new();
            let mut c = ex.contour.clone(); if let Some(f) = c.first().cloned() { c.push(f); }
            rings.push(c);
            for h in &ex.holes {
                let mut hh = h.clone(); if let Some(f) = hh.first().cloned() { hh.push(f); }
                hh.reverse(); // holes reversed so all contours are CCW
                rings.push(hh);
            }
            for mut r in rings {
                clip_end(&mut r, clip_length);
                if r.len() >= 2 {
                    out.push(self.mk_path(r, role, flow, ratio, if no_sort { g0 } else { *group }, no_sort, false));
                    if !no_sort { *group += 1; }
                }
            }
            // fill inside offset_ex(expoly, -0.4*spacing)
            let inner = poly::offset(&vec![ex.clone()], -0.4 * sp);
            let mut gg = if no_sort { g0 } else { *group };
            self.fill_expolygons(&inner, kind, angle, spacing, density, role, flow, ratio, &mut gg, no_sort, out);
            if !no_sort { *group = gg; } else { *group = g0 + 1; }
        }
    }
}

/// Remove `len` mm from the end of a polyline (Polyline::clip_end)
pub fn clip_end(pl: &mut Pl, mut len: f64) {
    while len > 0.0 && pl.len() >= 2 {
        let n = pl.len();
        let (a, b) = (pl[n - 2], pl[n - 1]);
        let l = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        if l <= len { len -= l; pl.pop(); }
        else {
            let t = (l - len) / l;
            pl[n - 1] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            return;
        }
    }
}

// ---- toolpaths --------------------------------------------------------------------------------
pub struct LayerPaths { pub print_z: f64, pub height: f64, pub bottom_z: f64, pub interface_id: usize, pub is_raft: bool, pub paths: Vec<PathOut>, pub islands: Polys }

impl<'a> Gen<'a> {
    fn ex_empty(&self, e: &Extruded) -> bool { match e.id { None => true, Some(i) => self.store.v[i].polygons.is_empty() } }
    fn ex_polys(&self, e: &Extruded) -> Polys {
        match &e.to_extrude { Some(p) => p.clone(), None => e.id.map(|i| self.store.v[i].polygons.clone()).unwrap_or_default() }
    }
    fn ex_could_merge(&self, a: &Extruded, b: &Extruded) -> bool {
        if self.ex_empty(a) || self.ex_empty(b) { return false; }
        let (la, lb) = (&self.store.v[a.id.unwrap()], &self.store.v[b.id.unwrap()]);
        (la.height - lb.height).abs() < EPS && la.bridging == lb.bridging
    }
    fn ex_merge(&mut self, dst: &mut Extruded, mut src: Extruded) {
        let (did, sid) = (dst.id.unwrap(), src.id.unwrap());
        if src.to_extrude.is_some() {
            if dst.to_extrude.is_none() { dst.to_extrude = Some(self.store.v[did].polygons.clone()); }
            let mut m = dst.to_extrude.take().unwrap();
            m.extend(src.to_extrude.take().unwrap());
            dst.to_extrude = Some(poly::union(&m));
        } else if dst.to_extrude.is_some() {
            let mut m = dst.to_extrude.take().unwrap();
            m.extend(self.store.v[sid].polygons.iter().cloned());
            dst.to_extrude = Some(poly::union(&m));
        }
        dst.paths.append(&mut src.paths);
        let sp = std::mem::take(&mut self.store.v[sid].polygons);
        let mut dp = std::mem::take(&mut self.store.v[did].polygons);
        dp.extend(sp);
        self.store.v[did].polygons = poly::union(&dp);
    }

    pub fn generate_support_toolpaths(&mut self, descs: &[SupportLayerDesc], raft_layers: &[Id], bottom_contacts: &[Id], top_contacts: &[Id],
                                      intermediate: &[Id], interface_layers: &[Id]) -> Result<Vec<LayerPaths>, FdmError> {
        let cfg = self.cfg;
        if cfg.support_interface_loop_pattern && self.p.num_top_interface > 0 {
            return Err(FdmError::Unsupported("support_interface_loop_pattern=1 (LoopInterfaceProcessor) is not ported".into()));
        }
        let sp = self.sp.clone();
        let mut angles = vec![self.p.base_angle];
        if cfg.support_base_pattern == BasePattern::RectilinearGrid { angles.push(self.p.interface_angle); }
        let n_raft = descs.len().min(sp.raft_layers().saturating_sub(1));
        let with_sheath = cfg.tree_support_wall_count > 0 || self.tree_mode;
        let mut results: Vec<LayerPaths> = Vec::new();
        let base_kind = self.p.base_fill_kind(cfg);
        let contact_kind = self.p.contact_fill_kind(cfg);
        let first_layer_kind = FillKind::Rectilinear;
        for (sl, desc) in descs.iter().enumerate() {
            let mut paths: Vec<PathOut> = Vec::new();
            let mut group = 0u32;
            let mut islands_src: Polys = Vec::new();
            let mut is_raft = false;
            if sl < n_raft {
                is_raft = true;
                let rid = raft_layers[sl];
                let (rpolys, rcols, rheight, rbottom) = { let r = &self.store.v[rid]; (r.polygons.clone(), r.contact.clone(), r.height, r.bottom_z) };
                let _ = rbottom;
                if sl > 0 {
                    let to_infill: Polys = if sl < sp.base_raft_layers { rpolys.clone() } else { rcols.clone().unwrap_or_default() };
                    let flow = Flow { width: self.p.flow.width, height: rheight, spacing: Flow::rounded_spacing(self.p.flow.width, rheight), nozzle: self.p.flow.nozzle, bridge: false };
                    if !to_infill.is_empty() {
                        self.fill_with_sheath(&to_infill, base_kind, self.p.raft_angle_base, self.p.flow.spacing, self.p.support_density,
                                              Role::Material, &flow, cfg.support_flow_ratio, with_sheath, false, &mut group, &mut paths);
                    }
                }
                let (flow, angle, spacing, density, kind);
                if sl == 0 {
                    flow = self.p.first_layer_flow; angle = self.p.raft_angle_1st_layer; spacing = self.p.first_layer_flow.spacing;
                    density = cfg.raft_first_layer_density; kind = self.p.raft_interface_fill_kind();
                } else if sl >= sp.base_raft_layers {
                    angle = self.p.raft_interface_angle(desc.interface_id);
                    spacing = self.p.flow.spacing;
                    flow = Flow { width: self.p.raft_interface_flow.width, height: rheight, spacing: Flow::rounded_spacing(self.p.raft_interface_flow.width, rheight), nozzle: self.p.raft_interface_flow.nozzle, bridge: false };
                    density = self.p.raft_interface_density; kind = self.p.raft_interface_fill_kind();
                } else {
                    // base raft layers above the first: only the base fill was printed
                    islands_src = rpolys.clone();
                    results.push(LayerPaths { print_z: desc.print_z, height: desc.height, bottom_z: desc.print_z - desc.height, interface_id: desc.interface_id, is_raft, paths, islands: poly::union(&islands_src) });
                    continue;
                }
                let role = if sl < sp.base_raft_layers { Role::Material } else { Role::Interface };
                let ratio = if role == Role::Interface { cfg.support_interface_flow_ratio } else { cfg.support_flow_ratio };
                self.fill_with_sheath(&rpolys, kind, angle, spacing, density, role, &flow, ratio, sl == 0, sl == 0, &mut group, &mut paths);
                islands_src.extend(rpolys.clone());
                results.push(LayerPaths { print_z: desc.print_z, height: desc.height, bottom_z: desc.print_z - desc.height, interface_id: desc.interface_id, is_raft, paths, islands: poly::union(&islands_src) });
                continue;
            }
            // pick the layers of this support layer by kind
            let find = |list: &[Id]| -> Option<Id> { desc.ids.iter().copied().find(|id| list.contains(id)) };
            let mut bottom = Extruded { id: find(bottom_contacts), ..Default::default() };
            let mut top = Extruded { id: find(top_contacts), ..Default::default() };
            let mut base = Extruded { id: find(intermediate), ..Default::default() };
            let mut interface = Extruded { id: find(interface_layers), ..Default::default() };
            let raft_layer = sp.interface_raft_layers > 0 && top.id.map(|t| (self.store.v[t].print_z - sp.raft_contact_top_z).abs() < EPS).unwrap_or(false);
            let top_interfaces = self.p.num_top_interface > 0;
            let bottom_interfaces = self.p.num_bottom_interface > 0;
            let can_merge = true; // single material (support_filament == support_interface_filament)
            if !top_interfaces {
                if can_merge && !raft_layer {
                    if self.ex_could_merge(&base, &top) { let t = std::mem::take(&mut top); self.ex_merge(&mut base, t); }
                    else if self.ex_empty(&base) { base = std::mem::take(&mut top); }
                }
            } else if self.ex_could_merge(&top, &interface) && !raft_layer {
                let i = std::mem::take(&mut interface); self.ex_merge(&mut top, i);
            }
            if !bottom_interfaces && can_merge {
                if self.ex_could_merge(&base, &bottom) { let b = std::mem::take(&mut bottom); self.ex_merge(&mut base, b); }
                else if self.ex_empty(&base) && !self.ex_empty(&bottom) && !self.store.v[bottom.id.unwrap()].bridging { base = std::mem::take(&mut bottom); }
            } else if self.ex_could_merge(&bottom, &top) && !raft_layer {
                if top_interfaces && bottom_interfaces {
                    let b = std::mem::take(&mut bottom); self.ex_merge(&mut top, b);
                } else if bottom_interfaces {
                    let d = poly::diff(&self.ex_polys(&top), &self.ex_polys(&bottom));
                    top.to_extrude = Some(d);
                } else {
                    let d = poly::diff(&self.ex_polys(&bottom), &self.ex_polys(&top));
                    bottom.to_extrude = Some(d);
                }
            } else if self.ex_could_merge(&bottom, &interface) {
                let interface_is_bottom = self.store.v[interface.id.unwrap()].ty == LT::BottomInterface;
                if bottom_interfaces && interface_is_bottom {
                    let i = std::mem::take(&mut interface); self.ex_merge(&mut bottom, i);
                } else {
                    let d = poly::diff(&self.ex_polys(&bottom), &self.ex_polys(&interface));
                    bottom.to_extrude = Some(d);
                }
            }
            // extrusions
            #[derive(Clone, Copy, PartialEq)]
            enum IT { TopContact, BottomContact, RaftContact, Interface, InterfaceAsBase }
            let mut items: Vec<(Extruded, f64)> = Vec::new();
            let mut do_interface = |this: &Gen, ex: &mut Extruded, it: IT, paths_out: &mut Vec<PathOut>, group: &mut u32| {
                if this.ex_empty(ex) { return; }
                let polys = this.ex_polys(ex);
                if polys.is_empty() { return; }
                let lid = ex.id.unwrap();
                let l = &this.store.v[lid];
                let as_base = it == IT::InterfaceAsBase;
                let raft_contact = it == IT::RaftContact;
                let bottom_interface = it == IT::BottomContact || (it == IT::Interface && l.ty == LT::BottomInterface);
                let flow = if l.bridging {
                    Flow::bridging(l.height, this.p.bottom_interface_flow.nozzle)
                } else {
                    let base_flow = if raft_contact { &this.p.raft_interface_flow } else if as_base { &this.p.flow } else { &this.p.interface_flow };
                    base_flow.with_height(l.height)
                };
                let angle = if as_base { angles[sl % angles.len()] }
                    else if raft_contact { this.p.raft_interface_angle(desc.interface_id) }
                    else { this.p.support_interface_angle(cfg, desc.interface_id) };
                let density = if raft_contact { this.p.raft_interface_density } else if as_base { this.p.support_density }
                    else if bottom_interface { this.p.bottom_interface_density } else { this.p.top_interface_density };
                let spacing = if raft_contact { this.p.raft_interface_flow.spacing } else if as_base { this.p.flow.spacing } else { this.p.interface_flow.spacing };
                let kind = if raft_contact { if top_interfaces { contact_kind } else { this.p.raft_interface_fill_kind() } } else { contact_kind };
                let role = if as_base { Role::Material } else { Role::Interface };
                let ratio = if as_base { cfg.support_flow_ratio } else { cfg.support_interface_flow_ratio };
                let u = poly::union(&polys);
                this.fill_expolygons(&u, kind, angle, spacing, density, role, &flow, ratio, group, false, paths_out);
            };
            let mut top_paths: Vec<PathOut> = Vec::new();
            let mut bottom_paths: Vec<PathOut> = Vec::new();
            let mut interface_paths: Vec<PathOut> = Vec::new();
            let mut base_paths: Vec<PathOut> = Vec::new();
            do_interface(self, &mut top, if raft_layer { IT::RaftContact } else if top_interfaces { IT::TopContact } else { IT::InterfaceAsBase }, &mut top_paths, &mut group);
            let organic = self.tree_mode && self.p.style == SupportStyle::TreeOrganic;
            if !organic { do_interface(self, &mut bottom, if bottom_interfaces { IT::BottomContact } else { IT::InterfaceAsBase }, &mut bottom_paths, &mut group); }
            let iface_enabled = !self.ex_empty(&interface) && (if self.store.v[interface.id.unwrap()].ty == LT::BottomInterface { bottom_interfaces } else { top_interfaces });
            do_interface(self, &mut interface, if iface_enabled { IT::Interface } else { IT::InterfaceAsBase }, &mut interface_paths, &mut group);
            // base support / first layer flange
            if !self.ex_empty(&base) {
                let polys = self.ex_polys(&base);
                if !polys.is_empty() {
                    let lid = base.id.unwrap();
                    let (lh, lbz) = { let l = &self.store.v[lid]; (l.height, l.bottom_z) };
                    let mut kind = base_kind;
                    let mut angle = angles[sl % angles.len()];
                    let mut flow = self.p.flow.with_height(lh);
                    let mut spacing = self.p.flow.spacing;
                    let mut density = self.p.support_density;
                    let mut sheath = with_sheath;
                    let mut no_sort = false;
                    if lbz < EPS {
                        kind = first_layer_kind;
                        angle = (cfg.support_angle + 90.0).to_radians();
                        density = cfg.raft_first_layer_density;
                        flow = self.p.first_layer_flow;
                        spacing = flow.spacing;
                        sheath = true; no_sort = true;
                    }
                    let mut g = group + 1000;
                    if lbz >= EPS && organic && matches!(cfg.support_base_pattern, BasePattern::Default | BasePattern::None) {
                        let dw = if cfg.tree_support_wall_count > 1 { 1e-13 } else if cfg.tree_support_wall_count == 0 { 0.25 * std::f64::consts::PI * 25.0 } else { f64::MAX };
                        let dw = if base.id.map(|i| self.store.v[i].print_z > 100.0).unwrap_or(false) { 1e-13 } else { dw };
                        self.tree_supports_generate_paths(&polys, &flow, cfg.support_flow_ratio, dw, &mut g, &mut base_paths);
                    } else {
                        self.fill_with_sheath(&polys, kind, angle, spacing, density, Role::Material, &flow, cfg.support_flow_ratio, sheath, no_sort, &mut g, &mut base_paths);
                    }
                }
            }
            // collect in Orca order: items sorted by layer height, thickest first (stable)
            let mut cache: Vec<(f64, Vec<PathOut>, Option<Id>)> = Vec::new();
            for (ex, ps) in [(&bottom, bottom_paths), (&top, top_paths), (&interface, interface_paths), (&base, base_paths)] {
                if !self.ex_empty(ex) {
                    let h = self.store.v[ex.id.unwrap()].height;
                    cache.push((h, ps, ex.id));
                }
            }
            cache.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            let mut gbase = 0u32;
            for (_, ps, id) in cache {
                let mut maxg = 0;
                for mut p in ps { maxg = maxg.max(p.group + 1); p.group += gbase; paths.push(p); }
                gbase += maxg;
                if let Some(id) = id { islands_src.extend(self.store.v[id].polygons.iter().cloned()); }
            }
            let _ = items.len();
            items.clear();
            results.push(LayerPaths { print_z: desc.print_z, height: desc.height, bottom_z: desc.print_z - desc.height, interface_id: desc.interface_id, is_raft, paths, islands: poly::union(&islands_src) });
        }
        Ok(results)
    }
}
