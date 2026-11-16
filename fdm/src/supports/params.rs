//! Flow model and SlicingParameters, ported from Flow.cpp / Slicing.cpp (support-relevant subset).
use super::config::*;

#[derive(Clone, Copy, Debug)]
pub struct Flow { pub width: f64, pub height: f64, pub spacing: f64, pub nozzle: f64, pub bridge: bool }
pub const BRIDGE_EXTRA_SPACING: f64 = 0.05;
impl Flow {
    /// Orca computes flows in `float`; mirror that (it matters at the 1e-6 mm lattice).
    pub fn rounded_spacing(w: f64, h: f64) -> f64 {
        let k = (1.0 - 0.25 * std::f64::consts::PI) as f32;
        ((w as f32) - (h as f32) * k) as f64
    }
    pub fn from_width(width: f64, nozzle: f64, height: f64) -> Flow {
        let (w, h) = (width as f32 as f64, height as f32 as f64);
        Flow { width: w, height: h, spacing: Self::rounded_spacing(w, h), nozzle: nozzle as f32 as f64, bridge: false }
    }
    pub fn with_height(&self, h: f64) -> Flow {
        if self.bridge { return *self; }
        let h = h as f32 as f64;
        Flow { width: self.width, height: h, spacing: Self::rounded_spacing(self.width, h), nozzle: self.nozzle, bridge: false }
    }
    pub fn bridging(dmr: f64, nozzle: f64) -> Flow {
        let d = dmr as f32;
        Flow { width: d as f64, height: d as f64, spacing: (d + BRIDGE_EXTRA_SPACING as f32) as f64, nozzle: nozzle as f32 as f64, bridge: true }
    }
    pub fn mm3_per_mm(&self) -> f64 {
        if self.bridge { self.width * self.width * 0.25 * std::f64::consts::PI }
        else { self.height * (self.width - self.height * (1.0 - 0.25 * std::f64::consts::PI)) }
    }
    /// Cross section of the rounded-rectangle model the G-code lane uses: (w - h(1-pi/4)) h.
    pub fn rect_section(w: f64, h: f64) -> f64 { h * (w - h * (1.0 - 0.25 * std::f64::consts::PI)) }
    /// `flow_ratio` to put on an ExtPath so that gcode's (w,h) model yields this flow's cross section.
    pub fn flow_ratio_for(&self, path_w: f64, path_h: f64, ratio: f64) -> f64 { self.mm3_per_mm() * ratio / Self::rect_section(path_w, path_h) }
}

/// Subset of Orca's SlicingParameters needed by the support generator.
#[derive(Clone, Debug, Default)]
pub struct SlicingParams {
    pub layer_height: f64,
    pub first_print_layer_height: f64,
    pub first_object_layer_height: f64,
    pub object_print_z_min: f64,
    pub base_raft_layers: usize,
    pub interface_raft_layers: usize,
    pub base_raft_layer_height: f64,
    pub interface_raft_layer_height: f64,
    pub contact_raft_layer_height: f64,
    pub raft_base_top_z: f64,
    pub raft_interface_top_z: f64,
    pub raft_contact_top_z: f64,
    pub gap_raft_object: f64,
    pub gap_object_support: f64,
    pub gap_support_object: f64,
    pub zero_gap_interface_top: bool,
    pub zero_gap_interface_bottom: bool,
    pub zero_gap_interface_raft: bool,
    pub min_layer_height: f64,
    pub max_layer_height: f64,
    pub max_support_layer_height: f64,
    pub has_raft_flag: bool,
}
impl SlicingParams {
    pub fn raft_layers(&self) -> usize { self.base_raft_layers + self.interface_raft_layers }
    pub fn has_raft(&self) -> bool { self.raft_layers() > 0 }
    pub fn create(c: &SupportConfig) -> SlicingParams {
        const EPS: f64 = 1e-4;
        let initial = if c.initial_layer_print_height <= 0.0 { c.layer_height } else { c.initial_layer_print_height };
        let top_gap = c.support_top_z_distance;
        let bottom_gap = c.support_bottom_z_distance;
        let raft_gap = c.raft_contact_distance;
        let zero_top = top_gap == 0.0;
        let zero_gap_interface_top = c.support_interface_top_layers > 0 && zero_top;
        let zero_gap_interface_bottom = c.n_bottom_interface() > 0 && (bottom_gap == 0.0 || zero_top);
        let zero_gap_interface_raft = raft_gap == 0.0 || zero_top;
        let mut p = SlicingParams::default();
        p.layer_height = c.layer_height;
        p.first_print_layer_height = initial;
        p.first_object_layer_height = initial;
        p.object_print_z_min = 0.0;
        p.base_raft_layers = c.raft_layers.max(0) as usize;
        p.zero_gap_interface_top = zero_gap_interface_top;
        p.zero_gap_interface_bottom = zero_gap_interface_bottom;
        p.zero_gap_interface_raft = zero_gap_interface_raft;
        // min / max layer height from the nozzle (Slicing.cpp)
        let min_lh = if c.min_layer_height == 0.0 { 0.07 } else { c.min_layer_height.max(0.01) };
        let max_lh = if c.max_layer_height == 0.0 { 0.75 * c.nozzle_diameter } else { c.max_layer_height };
        let max_lh = min_lh.max(max_lh);
        p.min_layer_height = min_lh;
        p.max_layer_height = max_lh;
        if c.enable_support || p.base_raft_layers > 0 || c.enforce_support_layers > 0 {
            p.max_support_layer_height = max_lh;
        }
        p.min_layer_height = p.min_layer_height.min(p.layer_height);
        p.max_layer_height = p.max_layer_height.max(p.layer_height);
        let round_gap = |g: f64| -> f64 {
            if c.independent_support_layer_height { g } else { (g / c.layer_height + EPS).round() * c.layer_height }
        };
        p.gap_raft_object = if zero_gap_interface_raft { 0.0 } else { round_gap(raft_gap) };
        p.gap_object_support = if zero_gap_interface_bottom { 0.0 } else { round_gap(bottom_gap) };
        p.gap_support_object = if zero_gap_interface_top { 0.0 } else { round_gap(top_gap) };
        if p.base_raft_layers > 0 {
            p.interface_raft_layers = (p.base_raft_layers + 1) / 2;
            p.base_raft_layers -= p.interface_raft_layers;
            p.base_raft_layer_height = p.layer_height.max(0.75 * c.nozzle_diameter);
            p.interface_raft_layer_height = p.layer_height.max(0.75 * c.nozzle_diameter);
            p.contact_raft_layer_height = p.layer_height.max(0.75 * c.nozzle_diameter);
            p.first_object_layer_height = p.layer_height;
        }
        if p.has_raft() {
            p.has_raft_flag = true;
            if p.raft_layers() == 1 {
                p.contact_raft_layer_height = initial;
                p.raft_contact_top_z = initial;
            } else {
                p.raft_base_top_z = initial + (p.base_raft_layers as f64 - 1.0) * p.base_raft_layer_height;
                p.raft_interface_top_z = p.raft_base_top_z + (p.interface_raft_layers as f64 - 1.0) * p.interface_raft_layer_height;
                p.raft_contact_top_z = p.raft_interface_top_z + p.contact_raft_layer_height;
            }
            p.object_print_z_min = p.raft_contact_top_z + p.gap_raft_object;
        }
        p
    }
}
