//! Support-relevant slice of the Orca config. Built from the `key = value` pairs of an Orca
//! CONFIG_BLOCK (see [`SupportConfig::from_kv`]). Names are Orca's own.
//!
//! TODO(lead): once lane 1's `config::Config` exists, add a `From<&Config>` that fills this struct,
//! or replace it; nothing in the generator depends on how the values got here.
use crate::types::FdmError;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportType { NormalAuto, TreeAuto, NormalManual, TreeManual }
impl SupportType {
    pub fn is_tree(self) -> bool { matches!(self, SupportType::TreeAuto | SupportType::TreeManual) }
    pub fn is_auto(self) -> bool { matches!(self, SupportType::NormalAuto | SupportType::TreeAuto) }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportStyle { Default, Grid, Snug, TreeSlim, TreeStrong, TreeHybrid, TreeOrganic }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BasePattern { Default, Rectilinear, RectilinearGrid, Honeycomb, Lightning, None }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterfacePattern { Auto, Rectilinear, Concentric, RectilinearInterlaced, Grid }

#[derive(Clone, Debug)]
pub struct SupportConfig {
    pub enable_support: bool,
    pub support_type: SupportType,
    pub support_style: SupportStyle,
    pub support_threshold_angle: f64,
    /// fraction of the external wall width that must be supported (0.5 = "50%")
    pub support_threshold_overlap_frac: f64,
    pub support_on_build_plate_only: bool,
    pub support_critical_regions_only: bool,
    pub support_remove_small_overhang: bool,
    pub support_expansion: f64,
    pub support_base_pattern: BasePattern,
    pub support_base_pattern_spacing: f64,
    pub support_angle: f64,
    pub support_interface_top_layers: i32,
    /// -1 = same as top
    pub support_interface_bottom_layers: i32,
    pub support_interface_pattern: InterfacePattern,
    pub support_interface_spacing: f64,
    pub support_bottom_interface_spacing: f64,
    pub support_interface_loop_pattern: bool,
    pub support_top_z_distance: f64,
    pub support_bottom_z_distance: f64,
    pub support_object_xy_distance: f64,
    pub support_object_first_layer_gap: f64,
    /// mm; 0 = fall back to line_width
    pub support_line_width: f64,
    pub support_flow_ratio: f64,
    pub support_interface_flow_ratio: f64,
    pub support_ironing: bool,
    pub enforce_support_layers: i32,
    pub bridge_no_support: bool,
    pub thick_bridges: bool,
    pub bridge_flow: f64,
    pub independent_support_layer_height: bool,
    pub max_bridge_length: f64,
    // raft
    pub raft_layers: i32,
    pub raft_contact_distance: f64,
    pub raft_expansion: f64,
    pub raft_first_layer_density: f64,
    pub raft_first_layer_expansion: f64,
    // generic print settings the support code needs
    pub layer_height: f64,
    pub initial_layer_print_height: f64,
    pub line_width: f64,
    pub initial_layer_line_width: f64,
    pub outer_wall_line_width: f64,
    pub nozzle_diameter: f64,
    pub min_layer_height: f64,
    pub max_layer_height: f64,
    // tree supports
    pub tree_support_branch_distance: f64,
    pub tree_support_branch_distance_organic: f64,
    pub tree_support_branch_diameter: f64,
    pub tree_support_branch_diameter_organic: f64,
    pub tree_support_branch_diameter_angle: f64,
    pub tree_support_branch_angle: f64,
    pub tree_support_branch_angle_organic: f64,
    pub tree_support_tip_diameter: f64,
    pub tree_support_top_rate: f64,
    pub tree_support_wall_count: i32,
    pub tree_support_angle_slow: f64,
    pub tree_support_auto_brim: bool,
    pub tree_support_brim_width: f64,
    /// `resolution` (mm) of the print config
    pub resolution: f64,
    /// `min_feature_size` as the raw percent number (Orca feeds it unconverted to the tree code)
    pub min_feature_size_percent: f64,
}

impl Default for SupportConfig {
    /// Orca defaults as they appear in the BBL X2D 0.20mm Standard profile.
    fn default() -> Self {
        SupportConfig {
            enable_support: false, support_type: SupportType::NormalAuto, support_style: SupportStyle::Default,
            support_threshold_angle: 30.0, support_threshold_overlap_frac: 0.5,
            support_on_build_plate_only: false, support_critical_regions_only: false, support_remove_small_overhang: true,
            support_expansion: 0.0, support_base_pattern: BasePattern::Default, support_base_pattern_spacing: 2.5,
            support_angle: 0.0, support_interface_top_layers: 2, support_interface_bottom_layers: 2,
            support_interface_pattern: InterfacePattern::Auto, support_interface_spacing: 0.5,
            support_bottom_interface_spacing: 0.5, support_interface_loop_pattern: false,
            support_top_z_distance: 0.2, support_bottom_z_distance: 0.2, support_object_xy_distance: 0.35,
            support_object_first_layer_gap: 0.2, support_line_width: 0.42, support_flow_ratio: 1.0,
            support_interface_flow_ratio: 1.0, support_ironing: false, enforce_support_layers: 0,
            bridge_no_support: false, thick_bridges: false, bridge_flow: 1.0, independent_support_layer_height: true,
            max_bridge_length: 0.0,
            raft_layers: 0, raft_contact_distance: 0.1, raft_expansion: 1.5, raft_first_layer_density: 0.9,
            raft_first_layer_expansion: 2.0,
            layer_height: 0.2, initial_layer_print_height: 0.2, line_width: 0.42, initial_layer_line_width: 0.5,
            outer_wall_line_width: 0.42, nozzle_diameter: 0.4, min_layer_height: 0.07, max_layer_height: 0.0,
            tree_support_branch_distance: 5.0, tree_support_branch_distance_organic: 1.0,
            tree_support_branch_diameter: 2.0, tree_support_branch_diameter_organic: 2.0,
            tree_support_branch_diameter_angle: 5.0, tree_support_branch_angle: 45.0,
            tree_support_branch_angle_organic: 40.0, tree_support_tip_diameter: 0.8, tree_support_top_rate: 0.3,
            tree_support_wall_count: 0, tree_support_angle_slow: 25.0, tree_support_auto_brim: true,
            tree_support_brim_width: 3.0,
            resolution: 0.012, min_feature_size_percent: 25.0,
        }
    }
}

fn first<'a>(v: &'a str) -> &'a str { v.split(',').next().unwrap_or("").trim() }

impl SupportConfig {
    /// Parse from Orca's resolved settings (`key -> raw text`, exactly the CONFIG_BLOCK lines
    /// without the `; ` prefix). Unknown keys are ignored, a key that is present but unparseable is
    /// an error (refuse, never approximate). Absent keys keep the profile default.
    pub fn from_kv(kv: &BTreeMap<String, String>) -> Result<Self, FdmError> {
        let mut c = SupportConfig::default();
        let err = |k: &str, v: &str| FdmError::Parse(format!("support config: bad value for {k}: {v:?}"));
        macro_rules! num { ($f:ident, $k:literal) => { if let Some(v) = kv.get($k) { c.$f = first(v).parse().map_err(|_| err($k, v))?; } } }
        macro_rules! int { ($f:ident, $k:literal) => { if let Some(v) = kv.get($k) { c.$f = first(v).parse().map_err(|_| err($k, v))?; } } }
        macro_rules! flag { ($f:ident, $k:literal) => { if let Some(v) = kv.get($k) { c.$f = match first(v) { "1" | "true" => true, "0" | "false" => false, _ => return Err(err($k, v)) }; } } }
        // percent or fraction -> fraction
        let pct = |k: &str, v: &str| -> Result<f64, FdmError> {
            let t = first(v);
            if let Some(p) = t.strip_suffix('%') { Ok(p.trim().parse::<f64>().map_err(|_| err(k, v))? / 100.0) } else { t.parse::<f64>().map_err(|_| err(k, v)) }
        };
        // percent given as `25%` -> 25 (NOT divided by 100); a bare number is returned as is
        let pct_raw = |k: &str, v: &str| -> Result<f64, FdmError> { first(v).trim_end_matches('%').trim().parse::<f64>().map_err(|_| err(k, v)) };
        flag!(enable_support, "enable_support");
        if let Some(v) = kv.get("support_type") {
            c.support_type = match first(v) {
                "normal(auto)" => SupportType::NormalAuto, "tree(auto)" => SupportType::TreeAuto,
                "normal(manual)" => SupportType::NormalManual, "tree(manual)" => SupportType::TreeManual,
                _ => return Err(err("support_type", v)),
            };
        }
        if let Some(v) = kv.get("support_style") {
            c.support_style = match first(v) {
                "default" => SupportStyle::Default, "grid" => SupportStyle::Grid, "snug" => SupportStyle::Snug,
                "tree_slim" => SupportStyle::TreeSlim, "tree_strong" => SupportStyle::TreeStrong,
                "tree_hybrid" => SupportStyle::TreeHybrid, "tree_organic" => SupportStyle::TreeOrganic,
                _ => return Err(err("support_style", v)),
            };
        }
        num!(support_threshold_angle, "support_threshold_angle");
        if let Some(v) = kv.get("support_threshold_overlap") { c.support_threshold_overlap_frac = pct("support_threshold_overlap", v)?; }
        flag!(support_on_build_plate_only, "support_on_build_plate_only");
        flag!(support_critical_regions_only, "support_critical_regions_only");
        flag!(support_remove_small_overhang, "support_remove_small_overhang");
        num!(support_expansion, "support_expansion");
        if let Some(v) = kv.get("support_base_pattern") {
            c.support_base_pattern = match first(v) {
                "default" => BasePattern::Default, "rectilinear" => BasePattern::Rectilinear,
                "rectilinear-grid" => BasePattern::RectilinearGrid, "honeycomb" => BasePattern::Honeycomb,
                "lightning" => BasePattern::Lightning, "hollow" | "none" => BasePattern::None,
                _ => return Err(err("support_base_pattern", v)),
            };
        }
        num!(support_base_pattern_spacing, "support_base_pattern_spacing");
        num!(support_angle, "support_angle");
        int!(support_interface_top_layers, "support_interface_top_layers");
        int!(support_interface_bottom_layers, "support_interface_bottom_layers");
        if let Some(v) = kv.get("support_interface_pattern") {
            c.support_interface_pattern = match first(v) {
                "auto" => InterfacePattern::Auto, "rectilinear" => InterfacePattern::Rectilinear,
                "concentric" => InterfacePattern::Concentric, "rectilinear_interlaced" => InterfacePattern::RectilinearInterlaced,
                "grid" => InterfacePattern::Grid,
                _ => return Err(err("support_interface_pattern", v)),
            };
        }
        num!(support_interface_spacing, "support_interface_spacing");
        num!(support_bottom_interface_spacing, "support_bottom_interface_spacing");
        flag!(support_interface_loop_pattern, "support_interface_loop_pattern");
        num!(support_top_z_distance, "support_top_z_distance");
        num!(support_bottom_z_distance, "support_bottom_z_distance");
        num!(support_object_xy_distance, "support_object_xy_distance");
        num!(support_object_first_layer_gap, "support_object_first_layer_gap");
        num!(support_flow_ratio, "support_flow_ratio");
        num!(support_interface_flow_ratio, "support_interface_flow_ratio");
        flag!(support_ironing, "support_ironing");
        int!(enforce_support_layers, "enforce_support_layers");
        flag!(bridge_no_support, "bridge_no_support");
        flag!(thick_bridges, "thick_bridges");
        num!(bridge_flow, "bridge_flow");
        flag!(independent_support_layer_height, "independent_support_layer_height");
        num!(max_bridge_length, "max_bridge_length");
        int!(raft_layers, "raft_layers");
        num!(raft_contact_distance, "raft_contact_distance");
        num!(raft_expansion, "raft_expansion");
        if let Some(v) = kv.get("raft_first_layer_density") { c.raft_first_layer_density = pct("raft_first_layer_density", v)?; }
        num!(raft_first_layer_expansion, "raft_first_layer_expansion");
        num!(layer_height, "layer_height");
        num!(initial_layer_print_height, "initial_layer_print_height");
        num!(nozzle_diameter, "nozzle_diameter");
        // widths may be percentages of the nozzle
        let nozzle = c.nozzle_diameter;
        let width = |k: &str, v: &str| -> Result<f64, FdmError> {
            let t = first(v);
            if let Some(p) = t.strip_suffix('%') { Ok(p.trim().parse::<f64>().map_err(|_| err(k, v))? / 100.0 * nozzle) } else { t.parse::<f64>().map_err(|_| err(k, v)) }
        };
        if let Some(v) = kv.get("line_width") { c.line_width = width("line_width", v)?; }
        if let Some(v) = kv.get("initial_layer_line_width") { c.initial_layer_line_width = width("initial_layer_line_width", v)?; }
        if let Some(v) = kv.get("outer_wall_line_width") { c.outer_wall_line_width = width("outer_wall_line_width", v)?; }
        if let Some(v) = kv.get("support_line_width") { c.support_line_width = width("support_line_width", v)?; }
        num!(min_layer_height, "min_layer_height");
        num!(max_layer_height, "max_layer_height");
        num!(tree_support_branch_distance, "tree_support_branch_distance");
        num!(tree_support_branch_distance_organic, "tree_support_branch_distance_organic");
        num!(tree_support_branch_diameter, "tree_support_branch_diameter");
        num!(tree_support_branch_diameter_organic, "tree_support_branch_diameter_organic");
        num!(tree_support_branch_diameter_angle, "tree_support_branch_diameter_angle");
        num!(tree_support_branch_angle, "tree_support_branch_angle");
        num!(tree_support_branch_angle_organic, "tree_support_branch_angle_organic");
        num!(tree_support_tip_diameter, "tree_support_tip_diameter");
        if let Some(v) = kv.get("tree_support_top_rate") { c.tree_support_top_rate = pct("tree_support_top_rate", v)?; }
        int!(tree_support_wall_count, "tree_support_wall_count");
        num!(tree_support_angle_slow, "tree_support_angle_slow");
        flag!(tree_support_auto_brim, "tree_support_auto_brim");
        num!(tree_support_brim_width, "tree_support_brim_width");
        num!(resolution, "resolution");
        if let Some(v) = kv.get("min_feature_size") { c.min_feature_size_percent = pct_raw("min_feature_size", v)?; }
        Ok(c)
    }

    /// Parse the `; key = value` lines of an Orca G-code CONFIG_BLOCK (used by tests and the parity tool).
    pub fn from_gcode_config_block(text: &str) -> Result<Self, FdmError> {
        let mut kv = BTreeMap::new();
        let mut inb = false;
        for l in text.lines() {
            if l.starts_with("; CONFIG_BLOCK_START") { inb = true; continue; }
            if l.starts_with("; CONFIG_BLOCK_END") { break; }
            if !inb { continue; }
            if let Some(r) = l.strip_prefix("; ") { if let Some((k, v)) = r.split_once(" = ") { kv.insert(k.trim().to_string(), v.trim().to_string()); } }
        }
        if kv.is_empty() { return Err(FdmError::Parse("no CONFIG_BLOCK found".into())); }
        Self::from_kv(&kv)
    }

    pub fn style_resolved(&self) -> SupportStyle {
        let tree = self.support_type.is_tree();
        let mut s = self.support_style;
        if s != SupportStyle::Default {
            if (s == SupportStyle::Snug || s == SupportStyle::Grid) && tree { s = SupportStyle::Default; }
            if matches!(s, SupportStyle::TreeSlim | SupportStyle::TreeStrong | SupportStyle::TreeHybrid | SupportStyle::TreeOrganic) && !tree { s = SupportStyle::Default; }
        }
        if s == SupportStyle::Default { if tree { SupportStyle::TreeOrganic } else { SupportStyle::Grid } } else { s }
    }
    pub fn n_bottom_interface(&self) -> i32 {
        if self.support_interface_bottom_layers < 0 { self.support_interface_top_layers } else { self.support_interface_bottom_layers }
    }
}
