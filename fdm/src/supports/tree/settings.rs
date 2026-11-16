//! TreeSupportMeshGroupSettings / TreeSupportSettings (Support/TreeSupportCommon.hpp).
//! All lengths are Orca `coord_t` (1e-6 mm integers, i64 here).
use crate::supports::config::*;
use crate::supports::params::*;
use crate::supports::poly::scale_trunc;

pub type C = i64;
pub type LayerIndex = i32;

pub fn sc(mm: f64) -> C { scale_trunc(mm) }
pub fn mm(c: C) -> f64 { c as f64 * 1e-6 }

#[derive(Clone, Debug)]
pub struct MeshGroupSettings {
    pub layer_height: C,
    pub resolution: C,
    pub min_feature_size: C,
    pub support_angle: f64,
    pub support_line_width: C,
    pub support_roof_line_width: C,
    pub support_bottom_enable: bool,
    pub support_bottom_height: C,
    pub support_material_buildplate_only: bool,
    pub support_xy_distance: C,
    pub support_xy_distance_1st_layer: C,
    pub support_xy_distance_overhang: C,
    pub support_top_distance: C,
    pub support_bottom_distance: C,
    pub support_roof_enable: bool,
    pub support_roof_layers: usize,
    pub support_floor_enable: bool,
    pub support_floor_layers: usize,
    pub support_line_spacing: C,
    pub support_wall_count: i32,
    pub support_roof_line_distance: C,
    pub support_tree_branch_distance: C,
    pub support_tree_angle: f64,
    pub support_tree_angle_slow: f64,
    pub support_tree_branch_diameter: C,
    pub support_tree_branch_diameter_angle: f64,
    pub support_tree_top_rate: f64,
    pub support_tree_tip_diameter: C,
    // defaults of the C++ struct that Orca never overrides
    pub minimum_roof_area: f64,
    pub support_tree_max_diameter_increase_by_merges_when_support_to_model: C,
    pub support_tree_min_height_to_model: C,
    pub support_tree_bp_diameter: C,
    pub minimum_support_area: C,
    pub support_offset: C,
    pub support_bottom_offset: C,
}

impl MeshGroupSettings {
    pub fn new(cfg: &SupportConfig, sp: &SlicingParams, flow: &Flow, interface_flow: &Flow, ext_perimeter_width: f64) -> MeshGroupSettings {
        let layer_height = sc(cfg.layer_height);
        let bottom_layers = cfg.n_bottom_interface();
        let support_bottom_enable = bottom_layers > 0;
        let support_xy_distance = sc(cfg.support_object_xy_distance);
        let support_line_width = sc(flow.width);
        let support_roof_line_width = sc(interface_flow.width);
        let tree_angle = (cfg.tree_support_branch_angle_organic.to_radians()).clamp(0.0, 0.5 * std::f64::consts::PI - 1e-4);
        let branch_diameter = sc(cfg.tree_support_branch_diameter_organic);
        MeshGroupSettings {
            layer_height,
            resolution: sc(cfg.resolution),
            min_feature_size: sc(cfg.min_feature_size_percent),
            support_angle: 0.5 * std::f64::consts::PI - ((cfg.support_threshold_angle + 1.0) * std::f64::consts::PI / 180.0).clamp(0.0, 0.5 * std::f64::consts::PI),
            support_line_width,
            support_roof_line_width,
            support_bottom_enable,
            support_bottom_height: if support_bottom_enable { bottom_layers as i64 * layer_height } else { 0 },
            support_material_buildplate_only: cfg.support_on_build_plate_only,
            support_xy_distance,
            support_xy_distance_1st_layer: sc(cfg.support_object_first_layer_gap),
            support_xy_distance_overhang: support_xy_distance.min(sc(0.5 * ext_perimeter_width)),
            support_top_distance: sc(sp.gap_support_object),
            support_bottom_distance: sc(sp.gap_object_support),
            support_roof_enable: cfg.support_interface_top_layers > 0,
            support_roof_layers: cfg.support_interface_top_layers.max(0) as usize,
            support_floor_enable: bottom_layers > 0,
            support_floor_layers: bottom_layers.max(0) as usize,
            support_line_spacing: sc(cfg.support_base_pattern_spacing),
            support_wall_count: cfg.tree_support_wall_count.max(1),
            support_roof_line_distance: sc(cfg.support_interface_spacing) + support_roof_line_width,
            support_tree_branch_distance: sc(cfg.tree_support_branch_distance_organic),
            support_tree_angle: tree_angle,
            support_tree_angle_slow: (cfg.tree_support_angle_slow.to_radians()).clamp(0.0, (tree_angle - 1e-4).max(0.0)),
            support_tree_branch_diameter: branch_diameter,
            support_tree_branch_diameter_angle: (cfg.tree_support_branch_diameter_angle.to_radians()).clamp(0.0, 0.5 * std::f64::consts::PI - 1e-4),
            support_tree_top_rate: cfg.tree_support_top_rate * 100.0,
            support_tree_tip_diameter: sc(cfg.tree_support_tip_diameter).clamp(0, branch_diameter),
            minimum_roof_area: (sc(1.0) as f64) * (sc(1.0) as f64),
            support_tree_max_diameter_increase_by_merges_when_support_to_model: sc(1.0),
            support_tree_min_height_to_model: sc(1.0),
            support_tree_bp_diameter: sc(7.5),
            minimum_support_area: 0,
            support_offset: 0,
            support_bottom_offset: 0,
        }
    }
}

fn round_up_divide(a: i64, b: i64) -> i64 { (a + b - 1) / b }

#[derive(Clone, Debug)]
pub struct TreeSettings {
    pub support_line_width: C,
    pub layer_height: C,
    pub branch_radius: C,
    pub min_radius: C,
    pub maximum_move_distance: C,
    pub maximum_move_distance_slow: C,
    pub support_bottom_layers: usize,
    pub tip_layers: usize,
    pub branch_radius_increase_per_layer: f64,
    pub max_to_model_radius_increase: C,
    pub min_dtt_to_model: usize,
    pub increase_radius_until_radius: C,
    pub increase_radius_until_layer: usize,
    pub support_rests_on_model: bool,
    pub xy_distance: C,
    pub bp_radius: C,
    pub layer_start_bp_radius: LayerIndex,
    pub bp_radius_increase_per_layer: f64,
    pub xy_min_distance: C,
    pub z_distance_top_layers: usize,
    pub z_distance_bottom_layers: usize,
    pub support_roof_line_width: C,
    pub support_line_spacing: C,
    pub support_wall_count: i32,
    pub resolution: C,
    pub support_roof_line_distance: C,
    pub min_feature_size: C,
    /// object z of the extra layers below the first object layer (raft + gap steps)
    pub raft_layers: Vec<f64>,
    pub settings: MeshGroupSettings,
    pub zero_top_z_gap: bool,
}

impl TreeSettings {
    pub fn new(m: &MeshGroupSettings, sp: &SlicingParams) -> TreeSettings {
        let support_line_width = m.support_line_width;
        let layer_height = m.layer_height;
        let branch_radius = m.support_tree_branch_diameter / 2;
        let min_radius = m.support_tree_tip_diameter / 2;
        let maximum_move_distance = if m.support_tree_angle < std::f64::consts::FRAC_PI_2 { (m.support_tree_angle.tan() * layer_height as f64) as C } else { i32::MAX as C };
        let maximum_move_distance_slow = if m.support_tree_angle_slow < std::f64::consts::FRAC_PI_2 { (m.support_tree_angle_slow.tan() * layer_height as f64) as C } else { i32::MAX as C };
        let support_bottom_layers = if m.support_bottom_enable { ((m.support_bottom_height + layer_height / 2) / layer_height) as usize } else { 0 };
        let tip_layers = (((branch_radius - min_radius) / (support_line_width / 3)).max(branch_radius / layer_height)) as usize;
        let branch_radius_increase_per_layer = m.support_tree_branch_diameter_angle.tan() * layer_height as f64;
        let max_to_model_radius_increase = m.support_tree_max_diameter_increase_by_merges_when_support_to_model / 2;
        let min_dtt_to_model = round_up_divide(m.support_tree_min_height_to_model, layer_height) as usize;
        let increase_radius_until_radius = m.support_tree_branch_diameter / 2;
        let increase_radius_until_layer = if increase_radius_until_radius <= branch_radius {
            (tip_layers as f64 * (increase_radius_until_radius as f64 / branch_radius as f64)) as usize
        } else {
            ((increase_radius_until_radius - branch_radius) as f64 / branch_radius_increase_per_layer) as usize
        };
        let support_rests_on_model = !m.support_material_buildplate_only;
        let mut xy_distance = m.support_xy_distance;
        let mut xy_min_distance = m.support_xy_distance.min(m.support_xy_distance_overhang);
        let bp_radius = m.support_tree_bp_diameter / 2;
        let bp_radius_increase_per_layer = ((0.7f64).tan() * layer_height as f64).min(0.5 * support_line_width as f64);
        let z_distance_bottom_layers = ((m.support_bottom_distance as f64 / layer_height as f64).round()) as usize;
        let z_distance_top_layers = ((m.support_top_distance as f64 / layer_height as f64).round()) as usize;
        let layer_start_bp_radius = ((bp_radius - branch_radius) as f64 / bp_radius_increase_per_layer) as LayerIndex;
        let zero_top_z_gap = m.support_top_distance < 100; // object_config.support_top_z_distance < EPSILON (1e-4 mm)
        if zero_top_z_gap {
            xy_min_distance = xy_min_distance.max(sc(0.1));
            xy_distance = xy_distance.max(xy_min_distance);
        }
        // raft layers
        let mut raft_layers: Vec<f64> = Vec::new();
        if sp.raft_layers() > 0 {
            let mut z = sp.first_print_layer_height;
            raft_layers.push(z);
            for _ in 1..sp.base_raft_layers { z += sp.base_raft_layer_height; raft_layers.push(z); }
            for _ in 0..sp.interface_raft_layers.saturating_sub(1) { z += sp.interface_raft_layer_height; raft_layers.push(z); }
            if sp.raft_layers() > 1 { z = sp.raft_contact_top_z; raft_layers.push(z); }
            let dist_to_go = sp.object_print_z_min - z;
            if dist_to_go > 1e-4 {
                let nsteps = ((dist_to_go - 1e-4) / sp.max_support_layer_height).ceil() as i64;
                let step = dist_to_go / nsteps as f64;
                for _ in 0..nsteps { z += step; raft_layers.push(z); }
            }
        }
        TreeSettings {
            support_line_width, layer_height, branch_radius, min_radius, maximum_move_distance, maximum_move_distance_slow,
            support_bottom_layers, tip_layers, branch_radius_increase_per_layer, max_to_model_radius_increase, min_dtt_to_model,
            increase_radius_until_radius, increase_radius_until_layer, support_rests_on_model, xy_distance, bp_radius,
            layer_start_bp_radius, bp_radius_increase_per_layer, xy_min_distance, z_distance_top_layers, z_distance_bottom_layers,
            support_roof_line_width: m.support_roof_line_width, support_line_spacing: m.support_line_spacing,
            support_wall_count: m.support_wall_count, resolution: m.resolution, support_roof_line_distance: m.support_roof_line_distance,
            min_feature_size: m.min_feature_size, raft_layers, settings: m.clone(), zero_top_z_gap,
        }
    }

    /// `getRadius(distance_to_top, elephant_foot_increases)`
    pub fn get_radius(&self, distance_to_top: usize, elephant_foot_increases: f64) -> C {
        let base = if distance_to_top <= self.tip_layers {
            // integer arithmetic in the C++ (size_t), converted to double afterwards
            (self.min_radius + (self.branch_radius - self.min_radius) * distance_to_top as i64 / self.tip_layers as i64) as f64
        } else {
            self.branch_radius as f64 + (distance_to_top - self.tip_layers) as f64 * self.branch_radius_increase_per_layer
        };
        // the C++ expression is evaluated in double and truncated to coord_t on return
        (base + elephant_foot_increases * (self.bp_radius_increase_per_layer - self.branch_radius_increase_per_layer).max(0.0)) as C
    }

    /// `recommendedMinRadius`
    pub fn recommended_min_radius(&self, layer_idx: LayerIndex) -> C {
        let num_layers_widened = (self.layer_start_bp_radius - layer_idx) as f64;
        if num_layers_widened > 0.0 { (self.branch_radius as f64 + num_layers_widened * self.bp_radius_increase_per_layer) as C } else { 0 }
    }
}
