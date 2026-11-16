//! Influence areas of the organic tree supports: element state, `increase_single_area`,
//! `increase_areas_one_layer`, merging and `create_layer_pathing` (Support/TreeSupport3D.cpp).
use super::settings::*;
use super::volumes::*;
use crate::supports::poly;
use crate::types::Polys;

pub type Pt = [C; 2];
pub const PT_UNSET: Pt = [i64::MAX, i64::MAX];
pub fn pt_mm(p: Pt) -> [f64; 2] { [p[0] as f64 * 1e-6, p[1] as f64 * 1e-6] }
pub fn mm_pt(p: [f64; 2]) -> Pt { [(p[0] * 1e6).round() as i64, (p[1] * 1e6).round() as i64] }

pub const TINY_AREA: f64 = 1e-6; // sqr(scaled(0.001)) in scaled^2 == 1e-6 mm^2

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct AreaIncrease {
    pub increase_speed: C,
    pub ty: AvoidanceType,
    pub increase_radius: bool,
    pub no_error: bool,
    pub use_min_distance: bool,
    pub mv: bool,
}
impl AreaIncrease {
    pub fn new(ty: AvoidanceType, increase_speed: C, increase_radius: bool, no_error: bool, use_min_distance: bool, mv: bool) -> Self {
        AreaIncrease { increase_speed, ty, increase_radius, no_error, use_min_distance, mv }
    }
}
impl Default for AreaIncrease { fn default() -> Self { AreaIncrease::new(AvoidanceType::Fast, 0, false, false, false, false) } }

#[derive(Clone, Debug)]
pub struct ElemState {
    pub to_buildplate: bool,
    pub to_model_gracious: bool,
    pub use_min_xy_dist: bool,
    pub supports_roof: bool,
    pub can_use_safe_radius: bool,
    pub skip_ovalisation: bool,
    pub lost: bool,
    pub verylost: bool,
    pub deleted: bool,
    pub marked: bool,
    pub target_height: LayerIndex,
    pub target_position: Pt,
    pub next_position: Pt,
    pub layer_idx: LayerIndex,
    pub effective_radius_height: u32,
    pub distance_to_top: u32,
    pub result_on_layer: Pt,
    pub increased_to_model_radius: C,
    pub elephant_foot_increases: f64,
    pub dont_move_until: u32,
    pub last_area_increase: AreaIncrease,
    pub missing_roof_layers: u32,
    pub roof_recovery_dtt: u32,
}
impl Default for ElemState {
    fn default() -> Self {
        ElemState {
            to_buildplate: false, to_model_gracious: false, use_min_xy_dist: false, supports_roof: false, can_use_safe_radius: false,
            skip_ovalisation: false, lost: false, verylost: false, deleted: false, marked: false,
            target_height: 0, target_position: [0, 0], next_position: [0, 0], layer_idx: 0, effective_radius_height: 0,
            distance_to_top: 0, result_on_layer: PT_UNSET, increased_to_model_radius: 0, elephant_foot_increases: 0.0,
            dont_move_until: 0, last_area_increase: AreaIncrease::default(), missing_roof_layers: 0, roof_recovery_dtt: 0,
        }
    }
}
impl ElemState {
    pub fn result_set(&self) -> bool { self.result_on_layer != PT_UNSET }
    pub fn result_reset(&mut self) { self.result_on_layer = PT_UNSET; }
    pub fn has_pending_roof_recovery(&self) -> bool { self.missing_roof_layers > 0 }
    pub fn set_pending_roof_recovery(&mut self, pending: u32, depth: u32) {
        self.missing_roof_layers = pending;
        self.roof_recovery_dtt = if pending > 0 { depth } else { 0 };
    }
    pub fn locked(&self) -> bool { self.distance_to_top < self.dont_move_until }
    pub fn propagate_down(src: &ElemState) -> ElemState {
        let mut d = src.clone();
        d.distance_to_top += 1;
        d.layer_idx -= 1;
        if d.has_pending_roof_recovery() { d.missing_roof_layers -= 1; d.roof_recovery_dtt += 1; }
        d.result_reset();
        d.skip_ovalisation = false;
        d
    }
}

pub fn get_effective_dtt(cfg: &TreeSettings, e: &ElemState) -> usize {
    if (e.effective_radius_height as usize) < cfg.increase_radius_until_layer {
        if (e.distance_to_top as usize) < cfg.increase_radius_until_layer { e.distance_to_top as usize } else { cfg.increase_radius_until_layer }
    } else { e.effective_radius_height as usize }
}
pub fn element_radius(cfg: &TreeSettings, e: &ElemState) -> C { cfg.get_radius(get_effective_dtt(cfg, e), e.elephant_foot_increases) }
pub fn element_collision_radius(cfg: &TreeSettings, e: &ElemState) -> C { cfg.get_radius(e.effective_radius_height as usize, e.elephant_foot_increases) }

#[derive(Clone, Debug)]
pub struct Elem {
    pub state: ElemState,
    pub parents: Vec<i32>,
    pub influence_area: Polys,
}

// ------------------------------------------------------------------ helpers
pub fn area_of(p: &Polys) -> f64 { poly::area(p) }
pub fn contains(p: &Polys, pt: Pt) -> bool { poly::contains_point(p, pt_mm(pt)) }

pub fn safe_union(first: &Polys, second: &Polys) -> Polys {
    if first.is_empty() && second.is_empty() { return Vec::new(); }
    let mut r = poly::union2(first, second);
    if r.is_empty() {
        // area destroying union: grow the remains a tiny bit (the C++ offsets the polylines)
        let a = poly::offset_miter(first, 0.002, 1.2);
        let b = poly::offset_miter(second, 0.002, 1.2);
        r = poly::union2(&a, &b);
    }
    r
}

#[allow(clippy::too_many_arguments)]
pub fn safe_offset_inc(me: &Polys, distance: C, collision: &Polys, safe_step_size: C, last_step_offset_without_check: C, min_amount_offset: usize) -> Polys {
    let mut do_final_difference = last_step_offset_without_check == 0;
    let mut ret = safe_union(me, &Vec::new());
    if distance == 0 {
        return if do_final_difference { poly::diff(&ret, collision) } else { poly::union(&ret) };
    }
    if safe_step_size < 0 || last_step_offset_without_check < 0 {
        return if do_final_difference { poly::diff(&ret, collision) } else { poly::union(&ret) };
    }
    let mut step_size = safe_step_size;
    let mut steps: i64 = if distance > last_step_offset_without_check { (distance - last_step_offset_without_check) / step_size } else { 0 };
    if distance - steps * step_size > last_step_offset_without_check {
        if (steps + 1) * step_size <= distance { steps += 1; } else { do_final_difference = true; }
    }
    let cond = steps + if distance < last_step_offset_without_check || (distance % step_size) != 0 { 1 } else { 0 };
    if cond < min_amount_offset as i64 && min_amount_offset > 1 {
        step_size = distance / min_amount_offset as i64;
        if step_size >= safe_step_size { step_size = safe_step_size; steps = min_amount_offset as i64; }
        else { steps = distance / step_size; }
    }
    for i in 0..steps {
        ret = poly::diff(&poly::offset_round(&ret, mm(step_size), 0.01), collision);
        if i % 10 == 7 { ret = poly::simplify(&ret, 0.015); }
    }
    let last_offset = distance - steps * step_size;
    if last_offset as f64 > 100.0 {
        ret = poly::offset_round(&ret, mm(distance - steps * step_size), 0.01);
    }
    ret = poly::simplify(&ret, 0.015);
    if do_final_difference { ret = poly::diff(&ret, collision); }
    poly::union(&ret)
}

/// Closest point on the boundary of `polys` (the `distance == 0` case of Orca's move_inside).
pub fn move_inside(polys: &Polys, from: Pt) -> Pt {
    let mut best = from;
    let mut best_d2 = f64::MAX;
    let f = [from[0] as f64, from[1] as f64];
    for r in poly::rings(polys) {
        let n = r.len();
        if n < 2 { continue; }
        for i in 0..n {
            let a = [r[i][0] * 1e6, r[i][1] * 1e6];
            let b = [r[(i + 1) % n][0] * 1e6, r[(i + 1) % n][1] * 1e6];
            let a = [a[0].round(), a[1].round()];
            let b = [b[0].round(), b[1].round()];
            let ab = [b[0] - a[0], b[1] - a[1]];
            let l2 = ab[0] * ab[0] + ab[1] * ab[1];
            if l2 <= 0.0 { continue; }
            let dot = ab[0] * (f[0] - a[0]) + ab[1] * (f[1] - a[1]);
            let x = if dot <= 0.0 { a } else if dot >= l2 { b } else {
                let t = dot / l2;
                [a[0] + (ab[0] * t).trunc(), a[1] + (ab[1] * t).trunc()]
            };
            let d2 = (f[0] - x[0]).powi(2) + (f[1] - x[1]).powi(2);
            if d2 < best_d2 { best_d2 = d2; best = [x[0] as i64, x[1] as i64]; }
        }
    }
    best
}
pub fn move_inside_if_outside(polys: &Polys, from: Pt) -> Pt {
    if !contains(polys, from) { move_inside(polys, from) } else { from }
}

// ------------------------------------------------------------- increase_single_area
#[allow(clippy::too_many_arguments)]
pub fn increase_single_area(
    volumes: &Volumes, cfg: &TreeSettings, settings: &AreaIncrease, layer_idx: LayerIndex, parent: &Elem,
    relevant_offset: &Polys, to_bp_data: &mut Polys, to_model_data: &mut Polys, increased: &mut Polys, overspeed: C, mergelayer: bool,
) -> Option<ElemState> {
    let mut cur = ElemState::propagate_down(&parent.state);
    if settings.increase_radius { cur.effective_radius_height += 1; }
    let mut radius = element_collision_radius(cfg, &cur);
    if settings.mv {
        *increased = relevant_offset.clone();
        if overspeed > 0 {
            let mut safe_movement_distance = (if cur.use_min_xy_dist { cfg.xy_min_distance } else { cfg.xy_distance })
                + if cfg.z_distance_top_layers.min(cfg.z_distance_bottom_layers) > 0 { cfg.min_feature_size } else { 0 };
            if safe_movement_distance == 0 { safe_movement_distance = sc(0.1); }
            let wr = volumes.get_wall_restriction(element_collision_radius(cfg, &parent.state), layer_idx, parent.state.use_min_xy_dist);
            *increased = safe_offset_inc(increased, overspeed, &wr, safe_movement_distance, safe_movement_distance + radius, 1);
        }
        if settings.no_error && settings.mv {
            // polygons_simplify(increased, scaled<float>(0.025)) result is discarded in the C++ (value ignored)
        }
    } else {
        *increased = parent.influence_area.clone();
    }
    if mergelayer || cur.to_buildplate {
        let av = volumes.get_avoidance(radius, layer_idx - 1, settings.ty, false, settings.use_min_distance);
        *to_bp_data = safe_union(&poly::diff(increased, &av), &Vec::new());
        if !cur.to_buildplate && area_of(to_bp_data) > TINY_AREA { cur.to_buildplate = true; }
    }
    if cfg.support_rests_on_model {
        if mergelayer || cur.to_model_gracious {
            let av = volumes.get_avoidance(radius, layer_idx - 1, settings.ty, true, settings.use_min_distance);
            *to_model_data = safe_union(&poly::diff(increased, &av), &Vec::new());
        }
        if !cur.to_model_gracious {
            if mergelayer && area_of(to_model_data) >= TINY_AREA {
                cur.to_model_gracious = true;
            } else {
                let col = volumes.get_collision(radius, layer_idx - 1, settings.use_min_distance);
                *to_model_data = safe_union(&poly::diff(increased, &col), &Vec::new());
            }
        }
    }
    let mut check_area = if cur.to_buildplate { area_of(to_bp_data) } else { area_of(to_model_data) };
    if settings.increase_radius && check_area > TINY_AREA {
        let valid_with_radius = |cur: &ElemState, radius: C, next_radius: C| -> bool {
            if volumes.ceil_radius_xy(next_radius, settings.use_min_distance) <= volumes.ceil_radius_xy(radius, settings.use_min_distance) { return true; }
            let mut bp2: Polys = Vec::new();
            let mut tm2: Polys = Vec::new();
            if cur.to_buildplate {
                bp2 = poly::diff(increased, &volumes.get_avoidance(next_radius, layer_idx - 1, settings.ty, false, settings.use_min_distance));
            }
            if cfg.support_rests_on_model && !cur.to_buildplate {
                let sub = if cur.to_model_gracious {
                    volumes.get_avoidance(next_radius, layer_idx - 1, settings.ty, true, settings.use_min_distance)
                } else {
                    volumes.get_collision(next_radius, layer_idx - 1, settings.use_min_distance)
                };
                tm2 = poly::diff(increased, &sub);
            }
            let a2 = if cur.to_buildplate { area_of(&bp2) } else { area_of(&tm2) };
            a2 > TINY_AREA
        };
        let ceil_radius_before = volumes.ceil_radius_xy(radius, settings.use_min_distance);
        if element_collision_radius(cfg, &cur) < cfg.increase_radius_until_radius && element_collision_radius(cfg, &cur) < element_radius(cfg, &cur) {
            let target_radius = element_radius(cfg, &cur).min(cfg.increase_radius_until_radius);
            let mut current_ceil_radius = volumes.get_radius_next_ceil(radius, settings.use_min_distance);
            while current_ceil_radius < target_radius && valid_with_radius(&cur, radius, volumes.get_radius_next_ceil(current_ceil_radius + 1, settings.use_min_distance)) {
                current_ceil_radius = volumes.get_radius_next_ceil(current_ceil_radius + 1, settings.use_min_distance);
            }
            let mut resulting_eff_dtt = cur.effective_radius_height as usize;
            while resulting_eff_dtt + 1 < cur.distance_to_top as usize
                && cfg.get_radius(resulting_eff_dtt + 1, cur.elephant_foot_increases) <= current_ceil_radius
                && cfg.get_radius(resulting_eff_dtt + 1, cur.elephant_foot_increases) <= element_radius(cfg, &cur) {
                resulting_eff_dtt += 1;
            }
            cur.effective_radius_height = resulting_eff_dtt as u32;
        }
        radius = element_collision_radius(cfg, &cur);
        let foot_radius_increase = (cfg.bp_radius_increase_per_layer - cfg.branch_radius_increase_per_layer).max(0.0) as C;
        let planned_foot_increase = {
            let num = (cfg.recommended_min_radius(layer_idx - 1) - element_radius(cfg, &cur)) as f64;
            let v = num / foot_radius_increase as f64; // may be +-inf / NaN exactly like the C++ double division
            if v < 1.0 { v } else { 1.0 } // std::min(1.0, v): NaN -> 1.0
        };
        let increase_bp_foot = planned_foot_increase > 0.0 && cur.to_buildplate;
        if increase_bp_foot && element_radius(cfg, &cur) >= cfg.branch_radius && element_radius(cfg, &cur) >= cfg.increase_radius_until_radius {
            if valid_with_radius(&cur, radius, cfg.get_radius(cur.effective_radius_height as usize, cur.elephant_foot_increases + planned_foot_increase)) {
                cur.elephant_foot_increases += planned_foot_increase;
                radius = element_collision_radius(cfg, &cur);
            }
        }
        if ceil_radius_before != volumes.ceil_radius_xy(radius, settings.use_min_distance) {
            if cur.to_buildplate {
                let av = volumes.get_avoidance(radius, layer_idx - 1, settings.ty, false, settings.use_min_distance);
                *to_bp_data = safe_union(&poly::diff(increased, &av), &Vec::new());
            }
            if cfg.support_rests_on_model && (!cur.to_buildplate || mergelayer) {
                let sub = if cur.to_model_gracious {
                    volumes.get_avoidance(radius, layer_idx - 1, settings.ty, true, settings.use_min_distance)
                } else {
                    volumes.get_collision(radius, layer_idx - 1, settings.use_min_distance)
                };
                *to_model_data = safe_union(&poly::diff(increased, &sub), &Vec::new());
            }
            check_area = if cur.to_buildplate { area_of(to_bp_data) } else { area_of(to_model_data) };
        }
    }
    if check_area > TINY_AREA { Some(cur) } else { None }
}

// ---------------------------------------------------------------- merging structures
#[derive(Clone, Debug, Default)]
pub struct InfluenceAreas {
    pub influence_areas: Polys,
    pub to_bp_areas: Polys,
    pub to_model_areas: Polys,
}
impl InfluenceAreas { pub fn clear(&mut self) { self.influence_areas.clear(); self.to_bp_areas.clear(); self.to_model_areas.clear(); } }

#[derive(Clone, Debug)]
pub struct Merging {
    pub state: ElemState,
    pub parents: Vec<i32>,
    pub areas: InfluenceAreas,
    /// bounding box (min, max) in scaled units
    pub bbox: ([C; 2], [C; 2]),
}
impl Merging {
    pub fn new(state: ElemState, parents: Vec<i32>) -> Merging {
        Merging { state, parents, areas: InfluenceAreas::default(), bbox: ([0, 0], [0, 0]) }
    }
    pub fn set_bbox(&mut self, b: Option<([f64; 2], [f64; 2])>) {
        if let Some((mn, mx)) = b {
            let eps = 100; // SCALED_EPSILON
            self.bbox = ([sc(mn[0]) - eps, sc(mn[1]) - eps], [sc(mx[0]) + eps, sc(mx[1]) + eps]);
        }
    }
    pub fn centroid(&self) -> [C; 2] { [(self.bbox.0[0] + self.bbox.1[0]) / 2, (self.bbox.0[1] + self.bbox.1[1]) / 2] }
}
fn bbox_of(p: &Polys) -> Option<([f64; 2], [f64; 2])> { poly::bbox(p) }

// ----------------------------------------------------------------------- increase_areas_one_layer
#[allow(clippy::too_many_arguments)]
pub fn increase_areas_one_layer(
    volumes: &Volumes, cfg: &TreeSettings, merging_areas: &mut Vec<Merging>, layer_idx: LayerIndex,
    layer_elements: &mut Vec<Elem>, mergelayer: bool,
) {
    for ma in merging_areas.iter_mut() {
        let parent_idx = ma.parents[0] as usize;
        let parent = layer_elements[parent_idx].clone();
        let mut elem = ElemState::propagate_down(&parent.state);
        let wall_restriction = volumes.get_wall_restriction(element_collision_radius(cfg, &parent.state), layer_idx, parent.state.use_min_xy_dist);
        let mut to_bp_data: Polys = Vec::new();
        let mut to_model_data: Polys = Vec::new();
        let mut radius = element_collision_radius(cfg, &elem);
        let mut extra_speed: C = 5;
        let mut extra_slow_speed: C = 0;
        let ceiled_parent_radius = volumes.ceil_radius_xy(element_collision_radius(cfg, &parent.state), parent.state.use_min_xy_dist);
        let projected_radius_increased = cfg.get_radius(parent.state.effective_radius_height as usize + 1, parent.state.elephant_foot_increases);
        let projected_radius_delta = projected_radius_increased - element_collision_radius(cfg, &parent.state);
        let mut safe_movement_distance = (if elem.use_min_xy_dist { cfg.xy_min_distance } else { cfg.xy_distance })
            + if cfg.z_distance_top_layers.min(cfg.z_distance_bottom_layers) > 0 { cfg.min_feature_size } else { 0 };
        if safe_movement_distance == 0 { safe_movement_distance = sc(0.1); }
        if ceiled_parent_radius == volumes.ceil_radius_xy(projected_radius_increased, parent.state.use_min_xy_dist) || projected_radius_increased < cfg.increase_radius_until_radius {
            extra_speed += projected_radius_delta;
        } else {
            extra_slow_speed += projected_radius_delta.min((cfg.maximum_move_distance + extra_speed) - (cfg.maximum_move_distance_slow + extra_slow_speed));
        }
        if cfg.layer_start_bp_radius > layer_idx
            && cfg.recommended_min_radius(layer_idx - 1) < cfg.get_radius(elem.effective_radius_height as usize + 1, elem.elephant_foot_increases) {
            if ceiled_parent_radius == volumes.ceil_radius_xy(cfg.get_radius(parent.state.effective_radius_height as usize + 1, parent.state.elephant_foot_increases + 1.0), parent.state.use_min_xy_dist) {
                extra_speed += cfg.bp_radius_increase_per_layer as C;
            } else {
                extra_slow_speed += (cfg.bp_radius_increase_per_layer as C).min(cfg.maximum_move_distance - (cfg.maximum_move_distance_slow + extra_slow_speed));
            }
        }
        let fast_speed = cfg.maximum_move_distance + extra_speed;
        let slow_speed = cfg.maximum_move_distance_slow + extra_speed + extra_slow_speed;
        let mut offset_slow: Polys = Vec::new();
        let mut offset_fast: Polys = Vec::new();
        let mut add = false;
        let mut bypass_merge = false;
        let (increase_radius, no_error, use_min_radius, mv) = (true, true, true, true);
        let mut order: Vec<AreaIncrease> = Vec::new();
        let mut insert_setting = |order: &mut Vec<AreaIncrease>, s: AreaIncrease, back: bool| {
            if !order.contains(&s) { if back { order.push(s); } else { order.insert(0, s); } }
        };
        use AvoidanceType::*;
        let parent_moved_slow = elem.last_area_increase.increase_speed < cfg.maximum_move_distance;
        let avoidance_speed_mismatch = parent_moved_slow && elem.last_area_increase.ty != Slow;
        if elem.last_area_increase.mv && elem.last_area_increase.no_error && elem.can_use_safe_radius && !mergelayer
            && !avoidance_speed_mismatch && (elem.distance_to_top as usize >= cfg.tip_layers || parent_moved_slow) {
            let sp = if elem.last_area_increase.increase_speed < cfg.maximum_move_distance { slow_speed } else { fast_speed };
            insert_setting(&mut order, AreaIncrease::new(elem.last_area_increase.ty, sp, increase_radius, elem.last_area_increase.no_error, !use_min_radius, elem.last_area_increase.mv), true);
            insert_setting(&mut order, AreaIncrease::new(elem.last_area_increase.ty, sp, !increase_radius, elem.last_area_increase.no_error, !use_min_radius, elem.last_area_increase.mv), true);
        }
        if !elem.can_use_safe_radius {
            insert_setting(&mut order, AreaIncrease::new(Slow, slow_speed, increase_radius, no_error, !use_min_radius, !mv), true);
            if (elem.distance_to_top as usize) < (cfg.tip_layers + 1) / 2 {
                insert_setting(&mut order, AreaIncrease::new(Fast, slow_speed, increase_radius, no_error, !use_min_radius, !mv), true);
            }
            insert_setting(&mut order, AreaIncrease::new(FastSafe, fast_speed, increase_radius, no_error, !use_min_radius, !mv), true);
            insert_setting(&mut order, AreaIncrease::new(FastSafe, fast_speed, !increase_radius, no_error, !use_min_radius, mv), true);
            insert_setting(&mut order, AreaIncrease::new(Fast, fast_speed, !increase_radius, no_error, !use_min_radius, mv), true);
        } else {
            insert_setting(&mut order, AreaIncrease::new(Slow, slow_speed, increase_radius, no_error, !use_min_radius, mv), true);
            insert_setting(&mut order, AreaIncrease::new(Slow, slow_speed, !increase_radius, no_error, !use_min_radius, mv), true);
            if (elem.distance_to_top as usize) < cfg.tip_layers {
                insert_setting(&mut order, AreaIncrease::new(FastSafe, slow_speed, increase_radius, no_error, !use_min_radius, mv), true);
            }
            insert_setting(&mut order, AreaIncrease::new(FastSafe, fast_speed, increase_radius, no_error, !use_min_radius, mv), true);
            insert_setting(&mut order, AreaIncrease::new(FastSafe, fast_speed, !increase_radius, no_error, !use_min_radius, mv), true);
        }
        if elem.use_min_xy_dist {
            let mut new_order: Vec<AreaIncrease> = Vec::new();
            for s in &order {
                new_order.push(*s);
                new_order.push(AreaIncrease::new(s.ty, s.increase_speed, s.increase_radius, s.no_error, use_min_radius, s.mv));
            }
            order = new_order;
        }
        if elem.to_buildplate || (elem.to_model_gracious && poly::intersect(&parent.influence_area, &volumes.get_placeable_areas(radius, layer_idx)).is_empty()) {
            insert_setting(&mut order, AreaIncrease::new(Fast, fast_speed, !increase_radius, !no_error, elem.use_min_xy_dist, mv), true);
        }
        if elem.distance_to_top < elem.dont_move_until && elem.can_use_safe_radius {
            insert_setting(&mut order, AreaIncrease::new(Slow, 0, increase_radius, no_error, !use_min_radius, !mv), false);
        }
        let mut inc_wo_collision: Polys = Vec::new();
        let offset_independant_faster = (radius / safe_movement_distance) as i64 - (if cfg.maximum_move_distance + extra_speed < radius + safe_movement_distance { 1 } else { 0 })
            > ((extra_speed + extra_slow_speed + cfg.maximum_move_distance_slow + safe_movement_distance - 1) / safe_movement_distance);
        for settings in &order {
            if settings.mv {
                if offset_slow.is_empty() && (settings.increase_speed == slow_speed || !offset_independant_faster) {
                    offset_slow = safe_offset_inc(&parent.influence_area, extra_speed + extra_slow_speed + cfg.maximum_move_distance_slow,
                        &wall_restriction, safe_movement_distance, if offset_independant_faster { safe_movement_distance + radius } else { 0 }, 2);
                }
                if offset_fast.is_empty() && settings.increase_speed != slow_speed {
                    if offset_independant_faster {
                        offset_fast = safe_offset_inc(&parent.influence_area, extra_speed + cfg.maximum_move_distance, &wall_restriction,
                            safe_movement_distance, if offset_independant_faster { safe_movement_distance + radius } else { 0 }, 1);
                    } else {
                        let delta_slow_fast = cfg.maximum_move_distance - (cfg.maximum_move_distance_slow + extra_slow_speed);
                        offset_fast = safe_offset_inc(&offset_slow, delta_slow_fast, &wall_restriction, safe_movement_distance,
                            safe_movement_distance + radius, if offset_independant_faster { 2 } else { 1 });
                    }
                }
            }
            let result: Option<ElemState>;
            inc_wo_collision.clear();
            if !settings.no_error {
                // error case: keep the area at any price
                let lines_offset = poly::offset_miter(&line_remnants(&parent.influence_area), 0.005, 1.2);
                let base_error_area = poly::union2(&parent.influence_area, &lines_offset);
                result = increase_single_area(volumes, cfg, settings, layer_idx, &parent, &base_error_area, &mut to_bp_data, &mut to_model_data,
                    &mut inc_wo_collision, ((cfg.maximum_move_distance + extra_speed) as f64 * 1.5) as C, mergelayer);
                if let Some(mut r) = result.clone() { r.lost = true; let _ = r; }
            } else {
                let off = if settings.increase_speed == slow_speed { &offset_slow } else { &offset_fast };
                result = increase_single_area(volumes, cfg, settings, layer_idx, &parent, off, &mut to_bp_data, &mut to_model_data, &mut inc_wo_collision, 0, mergelayer);
            }
            if let Some(r) = result {
                elem = r;
                radius = element_collision_radius(cfg, &elem);
                elem.last_area_increase = *settings;
                add = true;
                bypass_merge = !settings.mv || (settings.use_min_distance && (elem.distance_to_top as usize) < cfg.tip_layers);
                if settings.mv { elem.dont_move_until = 0; } else { elem.result_on_layer = parent.state.result_on_layer; }
                elem.can_use_safe_radius = settings.ty != Fast;
                if !settings.use_min_distance { elem.use_min_xy_dist = false; }
                if !settings.no_error { elem.lost = true; }
                break;
            }
        }
        if add {
            let col = volumes.get_collision(radius, layer_idx - 1, elem.use_min_xy_dist);
            let max_influence_area = safe_union(&poly::diff(&inc_wo_collision, &col), &safe_union(&to_bp_data, &to_model_data));
            ma.state = elem.clone();
            ma.set_bbox(bbox_of(&max_influence_area));
            ma.areas.influence_areas = max_influence_area;
            if !bypass_merge {
                if elem.to_buildplate { ma.areas.to_bp_areas = std::mem::take(&mut to_bp_data); }
                if cfg.support_rests_on_model { ma.areas.to_model_areas = std::mem::take(&mut to_model_data); }
            }
        } else {
            let p = &mut layer_elements[parent_idx];
            p.state.result_reset();
            p.state.to_model_gracious = false;
            p.state.verylost = true;
        }
    }
}

/// Degenerate "area becomes a line" fallback: the C++ offsets the polylines of the influence area; we use
/// the boundary rings as lines (an empty result is returned when there is nothing left).
fn line_remnants(p: &Polys) -> Polys { p.iter().filter(|pg| poly::poly_area(pg) < 1e-9).cloned().collect() }

// ------------------------------------------------------------------------------- merging
fn merge_support_element_states(first: &ElemState, second: &ElemState, next_position: Pt, layer_idx: LayerIndex, cfg: &TreeSettings) -> ElemState {
    let mut out = ElemState::default();
    out.next_position = next_position;
    out.layer_idx = layer_idx;
    out.use_min_xy_dist = first.use_min_xy_dist || second.use_min_xy_dist;
    out.supports_roof = first.supports_roof || second.supports_roof;
    out.dont_move_until = first.dont_move_until.max(second.dont_move_until);
    out.can_use_safe_radius = first.can_use_safe_radius || second.can_use_safe_radius;
    out.set_pending_roof_recovery(first.missing_roof_layers.max(second.missing_roof_layers), first.roof_recovery_dtt.max(second.roof_recovery_dtt));
    out.skip_ovalisation = false;
    if first.target_height > second.target_height { out.target_height = first.target_height; out.target_position = first.target_position; }
    else { out.target_height = second.target_height; out.target_position = second.target_position; }
    out.effective_radius_height = first.effective_radius_height.max(second.effective_radius_height);
    out.distance_to_top = first.distance_to_top.max(second.distance_to_top);
    out.to_buildplate = first.to_buildplate && second.to_buildplate;
    out.to_model_gracious = first.to_model_gracious && second.to_model_gracious;
    out.elephant_foot_increases = 0.0;
    if cfg.bp_radius_increase_per_layer > 0.0 {
        let foot_increase_radius = (element_collision_radius(cfg, second).max(element_collision_radius(cfg, first)) - element_collision_radius(cfg, &out)).abs();
        // (coord_t / double) -> double
        out.elephant_foot_increases = foot_increase_radius as f64 / (cfg.bp_radius_increase_per_layer - cfg.branch_radius_increase_per_layer);
    }
    let (a, b) = (&first.last_area_increase, &second.last_area_increase);
    out.last_area_increase = AreaIncrease {
        ty: a.ty.min(b.ty),
        increase_speed: a.increase_speed.min(b.increase_speed),
        increase_radius: a.increase_radius || b.increase_radius,
        no_error: a.no_error || b.no_error,
        use_min_distance: a.use_min_distance && b.use_min_distance,
        mv: a.mv || b.mv,
    };
    out
}

fn bbox_intersects(a: &([C; 2], [C; 2]), b: &([C; 2], [C; 2])) -> bool {
    !(a.1[0] < b.0[0] || b.1[0] < a.0[0] || a.1[1] < b.0[1] || b.1[1] < a.0[1])
}

fn merge_two_elements(volumes: &Volumes, cfg: &TreeSettings, layer_idx: LayerIndex, v: &mut Vec<Merging>, di: usize, si: usize) -> bool {
    let (dst, src) = (&v[di], &v[si]);
    let merging_gracious_and_non_gracious = dst.state.to_model_gracious != src.state.to_model_gracious;
    let merging_min_and_regular_xy = dst.state.use_min_xy_dist != src.state.use_min_xy_dist;
    if merging_gracious_and_non_gracious || merging_min_and_regular_xy { return false; }
    let dst_radius_bigger = element_collision_radius(cfg, &dst.state) > element_collision_radius(cfg, &src.state);
    let (smaller, bigger) = if dst_radius_bigger { (src, dst) } else { (dst, src) };
    let real_radius_delta = (element_radius(cfg, &bigger.state) - element_radius(cfg, &smaller.state)).abs();
    {
        let sb = ([smaller.bbox.0[0] - real_radius_delta, smaller.bbox.0[1] - real_radius_delta], [smaller.bbox.1[0] + real_radius_delta, smaller.bbox.1[1] + real_radius_delta]);
        if !bbox_intersects(&sb, &bigger.bbox) { return false; }
    }
    let mut increased_to_model_radius: C = 0;
    let merging_to_bp = dst.state.to_buildplate && src.state.to_buildplate;
    if !merging_to_bp {
        if dst.state.to_buildplate != src.state.to_buildplate {
            let rdst = element_radius(cfg, &dst.state);
            let rsrc = element_radius(cfg, &src.state);
            if dst.state.to_buildplate {
                if rsrc < rdst { increased_to_model_radius = src.state.increased_to_model_radius + rdst - rsrc; }
            } else if rsrc > rdst {
                increased_to_model_radius = dst.state.increased_to_model_radius + rsrc - rdst;
            }
            if increased_to_model_radius > cfg.max_to_model_radius_increase { return false; }
        }
        if !dst.state.supports_roof && !src.state.supports_roof && (src.state.distance_to_top.max(dst.state.distance_to_top) as usize) < cfg.min_dtt_to_model {
            return false;
        }
    }
    if !bigger.state.can_use_safe_radius && smaller.state.can_use_safe_radius { return false; }
    let use_min_radius = bigger.state.use_min_xy_dist && smaller.state.use_min_xy_dist;
    let smaller_collision_radius = element_collision_radius(cfg, &smaller.state);
    let collision = volumes.get_collision(smaller_collision_radius, layer_idx - 1, use_min_radius);
    let intersect_small_with_bigger = |small: &Polys, big: &Polys| -> Polys {
        poly::intersect(&safe_offset_inc(small, real_radius_delta, &collision, 2 * (cfg.xy_distance + smaller_collision_radius - 3), 0, 0), big)
    };
    let intersect = intersect_small_with_bigger(
        if merging_to_bp { &smaller.areas.to_bp_areas } else { &smaller.areas.to_model_areas },
        if merging_to_bp { &bigger.areas.to_bp_areas } else { &bigger.areas.to_model_areas });
    if area_of(&intersect) <= TINY_AREA { return false; }
    if area_of(&poly::offset_miter(&intersect, -0.025, 1.2)) <= TINY_AREA { return false; }
    let new_pos = move_inside_if_outside(&intersect, dst.state.next_position);
    let mut new_state = merge_support_element_states(&dst.state, &src.state, new_pos, layer_idx - 1, cfg);
    new_state.increased_to_model_radius = if increased_to_model_radius == 0 {
        dst.state.increased_to_model_radius.max(src.state.increased_to_model_radius)
    } else { increased_to_model_radius };
    let influence_areas = safe_union(&intersect_small_with_bigger(&smaller.areas.influence_areas, &bigger.areas.influence_areas), &intersect);
    let mut to_model_areas: Polys = Vec::new();
    if merging_to_bp && cfg.support_rests_on_model {
        to_model_areas = if new_state.to_model_gracious {
            safe_union(&intersect_small_with_bigger(&smaller.areas.to_model_areas, &bigger.areas.to_model_areas), &intersect)
        } else { influence_areas.clone() };
    }
    let src_parents = src.parents.clone();
    drop((dst, src));
    let d = &mut v[di];
    d.parents.extend(src_parents);
    d.state = new_state;
    d.areas.influence_areas = influence_areas;
    d.areas.to_bp_areas.clear();
    d.areas.to_model_areas.clear();
    if merging_to_bp {
        d.areas.to_bp_areas = intersect;
        if cfg.support_rests_on_model { d.areas.to_model_areas = to_model_areas; }
    } else {
        d.areas.to_model_areas = intersect;
    }
    let mut bb = bbox_of(&d.areas.influence_areas);
    for p in [&d.areas.to_bp_areas, &d.areas.to_model_areas] {
        if let Some(b2) = bbox_of(p) {
            bb = Some(match bb { None => b2, Some(b1) => ([b1.0[0].min(b2.0[0]), b1.0[1].min(b2.0[1])], [b1.1[0].max(b2.1[0]), b1.1[1].max(b2.1[1])]) });
        }
    }
    d.set_bbox(bb);
    let s = &mut v[si];
    s.areas.clear();
    s.parents.clear();
    true
}

fn empty_merging() -> Merging { Merging::new(ElemState::default(), Vec::new()) }

fn merge_leaves(volumes: &Volumes, cfg: &TreeSettings, layer_idx: LayerIndex, v: &mut Vec<Merging>, begin: usize, mut end: usize) -> usize {
    let mut i = begin;
    while i + 1 < end {
        let mut merged = false;
        let mut j = i + 1;
        while j != end {
            if merge_two_elements(volumes, cfg, layer_idx, v, i, j) {
                end -= 1;
                if j != end { let m = std::mem::replace(&mut v[end], empty_merging()); v[j] = m; }
                merged = true;
                break;
            } else { j += 1; }
        }
        if !merged { i += 1; }
    }
    end
}

fn merge_two_sets(volumes: &Volumes, cfg: &TreeSettings, layer_idx: LayerIndex, v: &mut Vec<Merging>,
                  dst_begin: usize, mut dst_end: usize, mut src_begin: usize, src_end: usize) -> usize {
    let mut src = src_begin;
    while src != src_end {
        let mut dst = dst_begin;
        let mut merged: Option<usize> = None;
        while dst != dst_end {
            if merge_two_elements(volumes, cfg, layer_idx, v, dst, src) {
                merged = Some(dst);
                dst += 1;
                if src != src_begin { let m = std::mem::replace(&mut v[src_begin], empty_merging()); v[src] = m; }
                src_begin += 1;
                break;
            }
            dst += 1;
        }
        if let Some(mg) = merged {
            while dst != dst_end {
                if merge_two_elements(volumes, cfg, layer_idx, v, mg, dst) {
                    dst_end -= 1;
                    if dst != dst_end { let m = std::mem::replace(&mut v[dst_end], empty_merging()); v[dst] = m; }
                } else { dst += 1; }
            }
        }
        src += 1;
    }
    if dst_end == src_begin { dst_end = src_end; }
    else {
        while src_begin != src_end {
            let m = std::mem::replace(&mut v[src_begin], empty_merging());
            v[dst_end] = m;
            dst_end += 1;
            src_begin += 1;
        }
    }
    dst_end
}

/// Port of AABBTreeIndirect::Tree::build_modify_input: only the reordering of the input matters.
fn aabb_reorder(input: &mut Vec<Merging>, left: usize, right: usize) {
    if left == right { return; }
    let (mut mn, mut mx) = (input[left].bbox.0, input[left].bbox.1);
    for i in left + 1..=right {
        for k in 0..2 { mn[k] = mn[k].min(input[i].bbox.0[k]); mx[k] = mx[k].max(input[i].bbox.1[k]); }
    }
    let dimension = if (mx[1] - mn[1]) > (mx[0] - mn[0]) { 1 } else { 0 };
    let center = (left + right) / 2;
    partition_input(input, dimension, left, right, center);
    aabb_reorder(input, left, center);
    aabb_reorder(input, center + 1, right);
}
fn partition_input(input: &mut Vec<Merging>, dimension: usize, mut left: usize, mut right: usize, k: usize) {
    let cen = |input: &Vec<Merging>, i: usize| input[i].centroid()[dimension];
    while left < right {
        let center = (left + right) / 2;
        let pivot;
        {
            let mut left_value = cen(input, left);
            let mut center_value = cen(input, center);
            let mut right_value = cen(input, right);
            if left_value > center_value { input.swap(left, center); std::mem::swap(&mut left_value, &mut center_value); }
            if left_value > right_value { input.swap(left, right); right_value = left_value; }
            if center_value > right_value { input.swap(center, right); center_value = right_value; }
            pivot = center_value;
        }
        if right <= left + 2 { break; }
        let mut i = left;
        let mut j = right - 1;
        input.swap(center, j);
        loop {
            loop { i += 1; if !(cen(input, i) < pivot) { break; } }
            loop { j -= 1; if !(cen(input, j) > pivot && i < j) { break; } }
            if i >= j { break; }
            input.swap(i, j);
        }
        input.swap(i, right - 1);
        if k < i { right = i - 1; }
        else if k == i { break; }
        else { left = i + 1; }
    }
}

pub const NUM_THREADS: usize = 24;

pub fn merge_influence_areas(volumes: &Volumes, cfg: &TreeSettings, layer_idx: LayerIndex, influence_areas: &mut Vec<Merging>) {
    let input_size = influence_areas.len();
    if input_size == 0 { return; }
    aabb_reorder(influence_areas, 0, input_size - 1);
    let mut buckets: Vec<(usize, usize)> = Vec::new();
    let num_buckets_min = (input_size + 2) / 4;
    let num_buckets_max = input_size / 2;
    let (num_buckets_initial, bucket_size) = if num_buckets_min >= NUM_THREADS { (num_buckets_min, 4) } else { (num_buckets_max, 2) };
    let mut it = 0usize;
    for _ in 0..num_buckets_initial { buckets.push((it, it + bucket_size)); it += bucket_size; }
    let it_end = input_size;
    if buckets.last().map(|b| b.1 >= it_end).unwrap_or(false) {
        let l = buckets.last_mut().unwrap();
        l.1 = l.1.min(it_end);
    } else {
        buckets.push((it, it_end));
    }
    for idx in 0..num_buckets_initial {
        let (b, e) = buckets[idx];
        buckets[idx].1 = merge_leaves(volumes, cfg, layer_idx, influence_areas, b, e);
    }
    while buckets.len() > 1 {
        for idx in 0..buckets.len() / 2 {
            let pair = idx * 2;
            let (db, de) = buckets[pair];
            let (sb, se) = buckets[pair + 1];
            buckets[pair].1 = merge_two_sets(volumes, cfg, layer_idx, influence_areas, db, de, sb, se);
        }
        let new_size = (buckets.len() + 1) / 2;
        for i in 1..new_size { buckets[i] = buckets[i * 2]; }
        buckets.truncate(new_size);
    }
}

/// Port of `create_layer_pathing`.
pub fn create_layer_pathing(volumes: &Volumes, cfg: &TreeSettings, move_bounds: &mut Vec<Vec<Elem>>) {
    let mut last_merge_layer_idx = move_bounds.len() as i64;
    let mut new_element = false;
    let max_merge_every_x_layers: i64 = {
        let a = 5000 / cfg.maximum_move_distance.max(100);
        let b = 1000 / cfg.maximum_move_distance_slow.max(20);
        let c = 3000 / cfg.layer_height;
        a.min(b).min(c)
    };
    let mut merge_every_x_layers: i64 = 1;
    let mut layer_idx = move_bounds.len() as i64 - 1;
    while layer_idx > 0 {
        if !move_bounds[layer_idx as usize].is_empty() {
            let had_new_element = new_element;
            let merge_this_layer = had_new_element || (last_merge_layer_idx - layer_idx) >= merge_every_x_layers;
            if had_new_element { merge_every_x_layers = 1; }
            // ### increase the influence areas by the allowed movement distance
            let mut influence_areas: Vec<Merging> = Vec::new();
            {
                let prev_layer = &move_bounds[layer_idx as usize];
                for (element_idx, el) in prev_layer.iter().enumerate() {
                    influence_areas.push(Merging::new(el.state.clone(), vec![element_idx as i32]));
                }
            }
            {
                let mut prev_layer = std::mem::take(&mut move_bounds[layer_idx as usize]);
                increase_areas_one_layer(volumes, cfg, &mut influence_areas, layer_idx as LayerIndex, &mut prev_layer, merge_this_layer);
                move_bounds[layer_idx as usize] = prev_layer;
            }
            // place already fully constructed elements into the layer below
            let mut this_layer: Vec<Elem> = Vec::new();
            let mut remaining: Vec<Merging> = Vec::new();
            for elem in influence_areas {
                if elem.areas.influence_areas.is_empty() { continue; }
                if elem.areas.to_bp_areas.is_empty() && elem.areas.to_model_areas.is_empty() {
                    this_layer.push(Elem { state: elem.state, parents: elem.parents, influence_area: elem.areas.influence_areas });
                    continue;
                }
                remaining.push(elem);
            }
            let mut influence_areas = remaining;
            new_element = !move_bounds[layer_idx as usize - 1].is_empty() || !this_layer.is_empty();
            if merge_this_layer {
                let mut reduced_by_merging = false;
                let count_before = influence_areas.len();
                if count_before > 1 {
                    merge_influence_areas(volumes, cfg, layer_idx as LayerIndex, &mut influence_areas);
                    // the C++ compares with influence_areas.size(), which merge_influence_areas never shrinks
                    reduced_by_merging = count_before > influence_areas.len();
                }
                last_merge_layer_idx = layer_idx;
                if !reduced_by_merging && !had_new_element {
                    merge_every_x_layers = max_merge_every_x_layers.min(merge_every_x_layers + 1);
                }
            }
            for elem in influence_areas {
                if !elem.areas.influence_areas.is_empty() {
                    let new_area = safe_union(&elem.areas.influence_areas, &Vec::new());
                    this_layer.push(Elem { state: elem.state, parents: elem.parents, influence_area: new_area });
                }
            }
            // C++ appends to move_bounds[layer_idx-1] which may already contain the tips inserted at that layer
            move_bounds[layer_idx as usize - 1].extend(this_layer);
        }
        layer_idx -= 1;
    }
}
