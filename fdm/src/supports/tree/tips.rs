//! Tree tip placement: `generate_initial_areas`, `sample_overhang_area` and the interface placer
//! (Support/TreeSupport3D.cpp + TreeSupportCommon.hpp InterfacePlacer).
use super::areas::*;
use super::settings::*;
use super::volumes::*;
use crate::supports::fill::{self, FillParams, Pl};
use crate::supports::normal::{Gen, LT};
use crate::supports::poly;
use crate::types::Polys;
use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineStatus { Invalid, ToModel, ToModelGracious, ToModelGraciousSafe, ToBp, ToBpSafe }
pub type LineInformation = Vec<(Pt, LineStatus)>;
pub type LineInformations = Vec<LineInformation>;

pub struct TreeCtx<'a, 'b> {
    pub g: &'a mut Gen<'b>,
    pub tcfg: TreeSettings,
    pub volumes: Volumes,
    pub move_bounds: Vec<Vec<Elem>>,
    pub top_contacts: Vec<Option<usize>>,
    pub top_interfaces: Vec<Option<usize>>,
    pub top_base_interfaces: Vec<Option<usize>>,
    pub bottom_contacts: Vec<Option<usize>>,
    pub intermediate: Vec<Option<usize>>,
    pub already_inserted: Vec<HashSet<(C, C)>>,
    pub force_tip_to_roof: bool,
    pub min_xy_dist: bool,
    pub base_circle_radius: C,
}

pub fn layer_z(g: &Gen, tcfg: &TreeSettings, layer_idx: usize) -> f64 {
    if layer_idx >= tcfg.raft_layers.len() {
        g.sp.object_print_z_min + g.sp.first_object_layer_height + (layer_idx - tcfg.raft_layers.len()) as f64 * g.sp.layer_height
    } else { tcfg.raft_layers[layer_idx] }
}

fn avoid_get(v: &Volumes, r: C, layer: i32, ty: AvoidanceType, to_model: bool, min_xy: bool) -> std::rc::Rc<Polys> { v.get_avoidance(r, layer, ty, to_model, min_xy) }

impl<'a, 'b> TreeCtx<'a, 'b> {
    pub fn num_top_interface(&self) -> usize { self.g.p.num_top_interface }

    // ---- InterfacePlacer ----
    pub fn add_roof_unguarded(&mut self, new_roofs: Polys, insert_layer_idx: usize, dtt_roof: usize) {
        let interface_threshold = self.g.p.num_top_interface; // num_top_interface_layers_only (no base interfaces)
        let (list_idx, ty) = if dtt_roof == 0 { (0, LT::TopContact) } else if dtt_roof <= interface_threshold { (1, LT::TopInterface) } else { (2, LT::TopInterface) };
        let existing = match list_idx { 0 => self.top_contacts[insert_layer_idx], 1 => self.top_interfaces[insert_layer_idx], _ => self.top_base_interfaces[insert_layer_idx] };
        let id = match existing {
            Some(id) => id,
            None => {
                let id = self.g.store.alloc(ty);
                let pz = layer_z(self.g, &self.tcfg, insert_layer_idx);
                let bz = if insert_layer_idx > 0 { layer_z(self.g, &self.tcfg, insert_layer_idx - 1) } else { 0.0 };
                let l = &mut self.g.store.v[id];
                l.print_z = pz; l.bottom_z = bz; l.height = pz - bz;
                match list_idx { 0 => self.top_contacts[insert_layer_idx] = Some(id), 1 => self.top_interfaces[insert_layer_idx] = Some(id), _ => self.top_base_interfaces[insert_layer_idx] = Some(id) }
                id
            }
        };
        self.g.store.v[id].polygons.extend(new_roofs);
    }
    pub fn add_roofs(&mut self, new_roofs: Vec<Polys>, insert_layer_idx: usize) {
        for (idx, r) in new_roofs.into_iter().enumerate() {
            if !r.is_empty() { self.add_roof_unguarded(r, insert_layer_idx - idx, idx); }
        }
    }

    // ---- line status helpers ----
    fn convert_lines_to_internal(&self, polylines: &[Pl], layer_idx: i32) -> LineInformations {
        let min_xy = self.min_xy_dist;
        let cfg = &self.tcfg;
        let v = &self.volumes;
        let r0 = cfg.get_radius(0, 0.0);
        let mut result: LineInformations = Vec::new();
        for line in polylines {
            let mut res_line: LineInformation = Vec::new();
            for q in line {
                let p = mm_pt(*q);
                if !contains(&avoid_get(v, r0, layer_idx, AvoidanceType::FastSafe, false, min_xy), p) { res_line.push((p, LineStatus::ToBpSafe)); }
                else if !contains(&avoid_get(v, r0, layer_idx, AvoidanceType::Fast, false, min_xy), p) { res_line.push((p, LineStatus::ToBp)); }
                else if cfg.support_rests_on_model && !contains(&avoid_get(v, r0, layer_idx, AvoidanceType::FastSafe, true, min_xy), p) { res_line.push((p, LineStatus::ToModelGraciousSafe)); }
                else if cfg.support_rests_on_model && !contains(&avoid_get(v, r0, layer_idx, AvoidanceType::Fast, true, min_xy), p) { res_line.push((p, LineStatus::ToModelGracious)); }
                else if cfg.support_rests_on_model && !contains(&v.get_collision(r0, layer_idx, min_xy), p) { res_line.push((p, LineStatus::ToModel)); }
                else if !res_line.is_empty() { result.push(std::mem::take(&mut res_line)); }
            }
            if !res_line.is_empty() { result.push(res_line); }
        }
        result
    }

    fn evaluate_point_for_next_layer(&self, current_layer: i32, p: &(Pt, LineStatus)) -> bool {
        let cfg = &self.tcfg;
        let v = &self.volumes;
        let min_xy = self.min_xy_dist;
        let r0 = cfg.get_radius(0, 0.0);
        let ty = if p.1 == LineStatus::ToBpSafe { AvoidanceType::FastSafe } else { AvoidanceType::Fast };
        if !contains(&avoid_get(v, r0, current_layer - 1, ty, false, min_xy), p.0) { return true; }
        if cfg.support_rests_on_model && (p.1 != LineStatus::ToBp && p.1 != LineStatus::ToBpSafe) {
            let area = if p.1 == LineStatus::ToModelGracious || p.1 == LineStatus::ToModelGraciousSafe {
                avoid_get(v, r0, current_layer - 1, if p.1 == LineStatus::ToModelGraciousSafe { AvoidanceType::FastSafe } else { AvoidanceType::Fast }, true, min_xy)
            } else { v.get_collision(r0, current_layer - 1, min_xy) };
            return !contains(&area, p.0);
        }
        false
    }

    fn split_lines(&self, lines: &LineInformations, eval: &dyn Fn(&(Pt, LineStatus)) -> bool) -> (LineInformations, LineInformations) {
        let mut keep: LineInformations = Vec::new();
        let mut set_free: LineInformations = Vec::new();
        for line in lines {
            let mut current_keep = true;
            let mut resulting: LineInformation = Vec::new();
            for me in line {
                if eval(me) != current_keep {
                    if !resulting.is_empty() { (if current_keep { &mut keep } else { &mut set_free }).push(std::mem::take(&mut resulting)); }
                    current_keep = !current_keep;
                }
                resulting.push(*me);
            }
            if !resulting.is_empty() { (if current_keep { &mut keep } else { &mut set_free }).push(resulting); }
        }
        (keep, set_free)
    }

    /// `generate_support_infill_lines` using the support fill patterns of this lane.
    pub fn generate_support_infill_lines(&self, polygon: &Polys, roof: bool, layer_idx: i32, support_infill_distance: C) -> Vec<Pl> {
        let p = &self.g.p;
        let flow = if roof { &p.interface_flow } else { &p.flow };
        let spacing = flow.spacing;
        let angle = if roof {
            p.interface_angle + if layer_idx & 1 == 1 { -std::f64::consts::FRAC_PI_4 } else { std::f64::consts::FRAC_PI_4 }
        } else { p.base_angle };
        let density = if roof { p.top_interface_density } else {
            let sc_sp = (spacing * 1e6) as f32; // scaled<float>(spacing)
            (sc_sp / (sc_sp + support_infill_distance as f32)) as f64
        };
        let kind_support_base = if roof { p.interface_fill_is_rect() } else { p.base_fill_is_rect(self.g.cfg) };
        let mut out: Vec<Pl> = Vec::new();
        for ex in poly::union(polygon) {
            let fp = FillParams { spacing, density, angle };
            let mut pls = if kind_support_base { fill::fill_rectilinear(&ex, &fp) } else { fill::fill_support_base(&ex, &fp) };
            out.append(&mut pls);
        }
        out
    }

    /// RichInterfacePlacer::add_points_along_lines
    fn add_points_along_lines(&mut self, lines_in: LineInformations, insert_layer_idx: i32, roof_tip_layers: usize, supports_roof_layers: usize, dont_move_until: usize) {
        let mut lines = lines_in;
        let mut dtt_roof_tip = 0usize;
        while dtt_roof_tip < roof_tip_layers && insert_layer_idx - dtt_roof_tip as i32 >= 1 {
            let this_layer_idx = insert_layer_idx - dtt_roof_tip as i32;
            let roof_recovery_depth = dtt_roof_tip + supports_roof_layers;
            let (keep, free) = self.split_lines(&lines, &|p| self.evaluate_point_for_next_layer(this_layer_idx, p));
            // evaluateRoofWillGenerate is always true
            let points = free;
            lines = keep;
            for line in &points {
                for pd in line {
                    self.add_point_as_influence_area(*pd, this_layer_idx, roof_tip_layers - dtt_roof_tip, roof_recovery_depth > 0, roof_recovery_depth, false);
                }
            }
            // add all tips as roof to the roof storage
            let mut new_roofs: Polys = Vec::new();
            for line in &lines {
                for p in line {
                    let r = self.tcfg.min_radius;
                    new_roofs.push(poly::circle_poly(pt_mm(p.0), mm(r), 25));
                }
            }
            self.add_roof_unguarded(new_roofs, this_layer_idx as usize, roof_recovery_depth);
            dtt_roof_tip += 1;
        }
        let roof_recovery_depth = dtt_roof_tip + supports_roof_layers;
        for line in &lines {
            let disable_ovalisation = self.tcfg.min_radius < 3 * self.tcfg.support_line_width && roof_tip_layers == 0 && dtt_roof_tip == 0 && line.len() > 5;
            for pd in line {
                self.add_point_as_influence_area(*pd, insert_layer_idx - dtt_roof_tip as i32,
                    if dont_move_until > dtt_roof_tip { dont_move_until - dtt_roof_tip } else { 0 },
                    roof_recovery_depth > 0, roof_recovery_depth, disable_ovalisation);
            }
        }
    }

    fn add_point_as_influence_area(&mut self, p: (Pt, LineStatus), insert_layer: i32, dont_move_until: usize, roof: bool, roof_recovery_dtt: usize, skip_ovalisation: bool) {
        let to_bp = p.1 == LineStatus::ToBp || p.1 == LineStatus::ToBpSafe;
        let gracious = to_bp || p.1 == LineStatus::ToModelGracious || p.1 == LineStatus::ToModelGraciousSafe;
        let safe_radius = p.1 == LineStatus::ToBpSafe || p.1 == LineStatus::ToModelGraciousSafe;
        if !self.tcfg.support_rests_on_model && !to_bp { return; }
        let circle = poly::circle_poly(pt_mm(p.0), mm(self.base_circle_radius), 25);
        let div = (self.tcfg.min_radius + 1) / 10;
        let hash_pos = (p.0[0] / div, p.0[1] / div);
        if insert_layer < 0 || insert_layer as usize >= self.already_inserted.len() { return; }
        if self.already_inserted[insert_layer as usize].insert(hash_pos) {
            let mut state = ElemState::default();
            state.target_height = insert_layer;
            state.target_position = p.0;
            state.next_position = p.0;
            state.layer_idx = insert_layer;
            state.effective_radius_height = 0;
            state.to_buildplate = to_bp;
            state.distance_to_top = 0;
            state.result_on_layer = p.0;
            state.increased_to_model_radius = 0;
            state.to_model_gracious = gracious;
            state.elephant_foot_increases = 0.0;
            state.use_min_xy_dist = self.min_xy_dist;
            state.supports_roof = roof;
            state.dont_move_until = dont_move_until as u32;
            state.can_use_safe_radius = safe_radius;
            state.set_pending_roof_recovery(if self.force_tip_to_roof { dont_move_until as u32 } else { 0 }, roof_recovery_dtt as u32);
            state.skip_ovalisation = skip_ovalisation;
            self.move_bounds[insert_layer as usize].push(Elem { state, parents: Vec::new(), influence_area: vec![circle] });
        }
    }
}

// ----------------------------------------------------------------------- polyline helpers
fn dist2d(a: Pt, b: Pt) -> f64 { (((a[0] - b[0]) as f64).powi(2) + ((a[1] - b[1]) as f64).powi(2)).sqrt() }

fn polyline_sample_next_point_at_distance(polyline: &[Pt], start_pt: Pt, start_idx: usize, dist: f64) -> Option<(Pt, usize)> {
    let dist2 = dist * dist;
    let dist2i = dist2 as i64 as f64;
    let eps = 10000.0; // scaled(0.01)
    for i in start_idx + 1..polyline.len() {
        let p1 = polyline[i];
        let d2 = ((p1[0] - start_pt[0]) as f64).powi(2) + ((p1[1] - start_pt[1]) as f64).powi(2);
        if d2 >= dist2i {
            let p0 = polyline[i - 1];
            let v = [(p1[0] - p0[0]) as f64, (p1[1] - p0[1]) as f64];
            let l2v = v[0] * v[0] + v[1] * v[1];
            if l2v < eps * eps {
                let c = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
                if (dist2d(start_pt, c) - dist).abs() < eps { return Some((c, i - 1)); } else { continue; }
            }
            let p0f = [(start_pt[0] - p0[0]) as f64, (start_pt[1] - p0[1]) as f64];
            let k = (p0f[0] * v[0] + p0f[1] * v[1]) / l2v;
            let foot = [v[0] * k, v[1] * k];
            let xf = [p0f[0] - foot[0], p0f[1] - foot[1]];
            let l2_from_line = xf[0] * xf[0] + xf[1] * xf[1];
            let mut l2_intersection = dist2 - l2_from_line;
            if l2_intersection > -100.0 {
                l2_intersection = l2_intersection.max(0.0);
                let vf = [v[0] - foot[0], v[1] - foot[1]];
                if vf[0] * vf[0] + vf[1] * vf[1] >= l2_intersection {
                    let t = (l2_intersection / l2v).sqrt();
                    let p = [p0[0] + (foot[0] + v[0] * t) as i64, p0[1] + (foot[1] + v[1] * t) as i64];
                    return Some((p, i - 1));
                }
            }
        }
    }
    None
}

fn pl_length_pt(p: &[Pt]) -> f64 { p.windows(2).map(|w| dist2d(w[0], w[1])).sum() }

/// `ensure_maximum_distance_polyline`
pub fn ensure_maximum_distance_polyline(input: &[Vec<Pt>], distance: f64, min_points: usize) -> Vec<Vec<Pt>> {
    let mut result: Vec<Vec<Pt>> = Vec::new();
    for part_in in input {
        if part_in.is_empty() { continue; }
        let mut part: Vec<Pt> = part_in.clone();
        let len = pl_length_pt(&part);
        let mut line: Vec<Pt> = Vec::new();
        let mut current_distance = distance.max(10_0000.0); // scaled(0.1)
        if len < 2.0 * distance && min_points <= 1 {
            // opposite point: clip half of the length from the end
            let mut pl: Vec<[f64; 2]> = part.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
            let mut rem = len / 2.0;
            while rem > 0.0 && pl.len() >= 2 {
                let n = pl.len();
                let (a, b) = (pl[n - 2], pl[n - 1]);
                let l = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
                if l <= rem { rem -= l; pl.pop(); } else { let t = (l - rem) / l; pl[n - 1] = [(a[0] + (b[0] - a[0]) * t).trunc(), (a[1] + (b[1] - a[1]) * t).trunc()]; break; }
            }
            let last = pl.last().unwrap();
            line.push([last[0] as i64, last[1] as i64]);
        } else {
            let mut optimal_end_index = part.len() - 1;
            if part.first() == part.last() {
                let mut optimal_start_index = 0usize;
                let mut max_d2: i64 = 0;
                for idx in 0..part.len() - 1 {
                    for inner in 0..part.len() - 1 {
                        let d2 = ((part[idx][0] - part[inner][0]) as f64).powi(2) + ((part[idx][1] - part[inner][1]) as f64).powi(2);
                        if d2 as i64 > max_d2 { optimal_start_index = idx; optimal_end_index = inner; max_d2 = d2 as i64; }
                    }
                }
                let n = part.len();
                // rotate part[0..n-1] so that optimal_start_index comes first
                let mut body: Vec<Pt> = part[..n - 1].to_vec();
                body.rotate_left(optimal_start_index);
                let first = body[0];
                body.push(first);
                part = body;
                optimal_end_index = (part.len() + optimal_end_index - optimal_start_index - 1) % (part.len() - 1);
            }
            while line.len() < min_points && current_distance >= 10_0000.0 {
                line.clear();
                let mut current_point = part[0];
                line.push(part[0]);
                if min_points > 1 || dist2d(part[0], part[optimal_end_index]) > current_distance { line.push(part[optimal_end_index]); }
                let mut current_index = 0usize;
                let mut next_distance = current_distance;
                loop {
                    let Some(next_point) = polyline_sample_next_point_at_distance(&part, current_point, current_index, next_distance) else { break };
                    let mut min_dist = f64::MAX;
                    for p in &line { min_dist = min_dist.min(dist2d(*p, next_point.0)); }
                    if min_dist >= current_distance {
                        line.push(next_point.0);
                        current_point = next_point.0;
                        current_index = next_point.1;
                        next_distance = current_distance;
                    } else {
                        if current_point == next_point.0 {
                            if next_distance > 2.0 * current_distance { break; }
                            next_distance += current_distance;
                            continue;
                        }
                        next_distance = (current_distance - min_dist).max(10_0000.0);
                        current_point = next_point.0;
                        current_index = next_point.1;
                    }
                }
                current_distance *= 0.9;
            }
        }
        result.push(line);
    }
    result
}

fn polys_to_polylines(p: &Polys) -> Vec<Vec<Pt>> {
    let mut out = Vec::new();
    for r in poly::rings(p) {
        let mut v: Vec<Pt> = r.iter().map(|q| mm_pt(*q)).collect();
        if let Some(f) = v.first().cloned() { v.push(f); }
        out.push(v);
    }
    out
}
fn total_length(p: &Polys) -> f64 {
    poly::rings(p).iter().map(|r| { let n = r.len(); (0..n).map(|i| { let a = r[i]; let b = r[(i + 1) % n]; ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt() * 1e6 }).sum::<f64>() }).sum()
}

// ------------------------------------------------------------------------- sample_overhang_area
impl<'a, 'b> TreeCtx<'a, 'b> {
    #[allow(clippy::too_many_arguments)]
    fn sample_overhang_area(&mut self, overhang_area_in: Polys, large_horizontal_roof: bool, layer_idx: i32, num_support_roof_layers: usize, connect_length: C) {
        let m = self.tcfg.settings.clone();
        let mut overhang_area = overhang_area_in;
        let mut overhang_lines: LineInformations = Vec::new();
        let mut dtt_roof: usize = 0;
        let mut layer_generation_dtt: usize = 0;
        let r0 = self.tcfg.get_radius(0, 0.0);
        let min_xy = self.min_xy_dist;
        if large_horizontal_roof {
            let mut added_roofs: Vec<Polys> = vec![Vec::new(); num_support_roof_layers];
            let mut last_overhang = overhang_area.clone();
            dtt_roof = 0;
            while dtt_roof < num_support_roof_layers && layer_idx - dtt_roof as i32 >= 1 {
                let forbidden_raw = if self.tcfg.support_rests_on_model {
                    self.volumes.get_collision(r0, layer_idx - (dtt_roof as i32 + 1), min_xy)
                } else {
                    self.volumes.get_avoidance(r0, layer_idx - (dtt_roof as i32 + 1), AvoidanceType::Fast, false, min_xy)
                };
                let forbidden_next = poly::offset_miter(&poly::union(&forbidden_raw), 0.005, 1.2);
                let overhang_area_next = poly::diff(&overhang_area, &forbidden_next);
                if area_of(&overhang_area_next) * 1e12 < m.minimum_roof_area {
                    if dtt_roof > 0 {
                        let dtt_before = dtt_roof - 1;
                        let lines = self.generate_support_infill_lines(&last_overhang, true, layer_idx - dtt_before as i32, m.support_roof_line_distance);
                        let pts: Vec<Vec<Pt>> = lines.iter().map(|l| l.iter().map(|q| mm_pt(*q)).collect()).collect();
                        let ens = ensure_maximum_distance_polyline(&pts, connect_length as f64, 1);
                        let ens_mm: Vec<Pl> = ens.iter().map(|l| l.iter().map(|p| pt_mm(*p)).collect()).collect();
                        let internal = self.convert_lines_to_internal(&ens_mm, layer_idx - dtt_before as i32);
                        let lidx = layer_idx - dtt_before as i32;
                        overhang_lines = self.split_lines(&internal, &|p| self.evaluate_point_for_next_layer(lidx, p)).0;
                    }
                    break;
                }
                added_roofs[dtt_roof] = overhang_area.clone();
                last_overhang = std::mem::take(&mut overhang_area);
                overhang_area = overhang_area_next;
                dtt_roof += 1;
            }
            layer_generation_dtt = dtt_roof.max(1) - 1;
            if overhang_lines.is_empty() && dtt_roof != 0
                && self.generate_support_infill_lines(&overhang_area, true, layer_idx - layer_generation_dtt as i32, m.support_roof_line_distance).is_empty() {
                for idx in 0..dtt_roof {
                    if self.generate_support_infill_lines(&added_roofs[idx], true, layer_idx - idx as i32, m.support_roof_line_distance).is_empty() {
                        dtt_roof = idx;
                        layer_generation_dtt = dtt_roof.max(1) - 1;
                        break;
                    }
                }
            }
            added_roofs.truncate(dtt_roof);
            self.add_roofs(added_roofs, layer_idx as usize);
        }
        if overhang_lines.is_empty() {
            let supports_roof = dtt_roof > 0;
            let continuous_tips = !supports_roof && large_horizontal_roof;
            let lines = self.generate_support_infill_lines(&overhang_area, supports_roof, layer_idx - layer_generation_dtt as i32,
                if supports_roof { m.support_roof_line_distance } else { m.support_tree_branch_distance });
            let pts: Vec<Vec<Pt>> = lines.iter().map(|l| l.iter().map(|q| mm_pt(*q)).collect()).collect();
            let mut polylines = ensure_maximum_distance_polyline(&pts, if continuous_tips { (self.tcfg.min_radius / 2) as f64 } else { connect_length as f64 }, 1);
            let point_count: usize = polylines.iter().map(|p| p.len()).sum();
            let min_support_points = 1.max(3.min((total_length(&overhang_area) / connect_length as f64) as i64)) as usize;
            if point_count <= min_support_points {
                let reduced = poly::offset_miter(&poly::union(&overhang_area), -(self.tcfg.support_line_width as f64) / 2.2 * 1e-6, 1.2);
                let grown = poly::offset_miter(&poly::diff(&overhang_area, &reduced), mm(self.tcfg.support_line_width.max(connect_length)), 1.2);
                let use_reduced = !reduced.is_empty() && area_of(&grown) * 1e12 < 1e6;
                polylines = ensure_maximum_distance_polyline(&polys_to_polylines(if use_reduced { &reduced } else { &overhang_area }), connect_length as f64, min_support_points);
            }
            let ml: Vec<Pl> = polylines.iter().map(|l| l.iter().map(|p| pt_mm(*p)).collect()).collect();
            overhang_lines = self.convert_lines_to_internal(&ml, layer_idx - dtt_roof as i32);
        }
        if dtt_roof as i32 >= layer_idx && large_horizontal_roof {
            let d = dtt_roof.min(self.g.p.num_top_interface);
            self.add_roof_unguarded(overhang_area, 0, d);
        } else {
            let roof_enabled = num_support_roof_layers > 0;
            self.add_points_along_lines(overhang_lines, layer_idx - dtt_roof as i32,
                if self.force_tip_to_roof { num_support_roof_layers - dtt_roof } else { 0 },
                dtt_roof,
                if roof_enabled { num_support_roof_layers - dtt_roof } else { 0 });
        }
    }

    /// `generate_raft_contact`: returns the raft contact layer index or -1.
    pub fn generate_raft_contact(&mut self) -> i32 {
        if !self.g.sp.has_raft() || self.g.layers.is_empty() { return -1; }
        let mut idx = self.tcfg.raft_layers.len() as i32 - 1;
        while idx > 0 && self.tcfg.raft_layers[idx as usize] > self.g.sp.raft_contact_top_z + 1e-4 { idx -= 1; }
        let exp = self.g.cfg.raft_expansion;
        let l0 = self.g.layers[0].slices.clone();
        let polys = if exp > 0.0 { poly::offset(&l0, exp) } else { l0 };
        self.add_roof_unguarded(polys, idx as usize, 0);
        idx
    }

    /// `finalize_raft_contact`
    pub fn finalize_raft_contact(&mut self, raft_contact_layer_idx: i32) {
        if raft_contact_layer_idx < 0 { return; }
        let first_tree_layer = self.g.sp.raft_layers() - 1;
        for i in 0..first_tree_layer.min(self.move_bounds.len()) {
            self.top_contacts[i] = None;
            self.move_bounds[i].clear();
        }
        let exp = self.g.cfg.raft_expansion;
        if exp > 0.0 && first_tree_layer < self.move_bounds.len() {
            if let Some(id) = self.top_contacts.get(raft_contact_layer_idx as usize).copied().flatten() {
                let raft_polys = self.g.store.v[id].polygons.clone();
                let threshold = exp * 2.0;
                self.move_bounds[first_tree_layer].retain(|el| {
                    let p = pt_mm(if el.state.result_set() { el.state.result_on_layer } else { el.state.target_position });
                    let d = poly::dist_to_boundary(&raft_polys, p);
                    !(d < threshold && poly::contains_point(&raft_polys, p))
                });
            }
        }
    }

    /// Port of `generate_initial_areas`.
    pub fn generate_initial_areas(&mut self, overhangs: &[Polys], n_support_layers_total: usize) {
        let m = self.tcfg.settings.clone();
        let cfg = self.tcfg.clone();
        let z_distance_delta = cfg.z_distance_top_layers + 1;
        let min_xy_dist = self.min_xy_dist;
        let connect_length: C = ((cfg.support_line_width as f64 * 100.0 / m.support_tree_top_rate) + (2.0 * cfg.min_radius as f64 - 1.0 * cfg.support_line_width as f64).max(0.0)) as C;
        let circle_length_to_half_linewidth_change: C = if cfg.min_radius < cfg.support_line_width {
            cfg.min_radius / 2
        } else {
            sc(((mm(cfg.min_radius)).powi(2) - (mm(cfg.min_radius - cfg.support_line_width / 2)).powi(2)).sqrt())
        };
        let extra_outset: C = (cfg.min_radius - cfg.support_line_width / 2).max(0) + if min_xy_dist { cfg.support_line_width / 2 } else { 0 };
        let num_support_roof_layers = m.support_roof_layers;
        let roof_enabled = num_support_roof_layers > 0;
        self.force_tip_to_roof = roof_enabled && (self.g.p.zero_gap_interface_top || (cfg.min_radius as f64).powi(2) * std::f64::consts::PI > m.minimum_roof_area);
        let num_raft_layers = cfg.raft_layers.len();
        let first_support_layer = (num_raft_layers as i64 - z_distance_delta as i64).max(1) as usize;
        let num_support_layers = (self.g.layers.len() as i64 + num_raft_layers as i64 - z_distance_delta as i64).max(0) as usize;
        let _ = n_support_layers_total;
        let raft_contact_layer_idx = self.generate_raft_contact();
        let mut raw_overhangs: Vec<(usize, usize)> = Vec::new();
        for layer_idx in first_support_layer..num_support_layers {
            let oi = layer_idx + z_distance_delta;
            if oi < overhangs.len() && !overhangs[oi].is_empty() { raw_overhangs.push((layer_idx, oi)); }
        }
        let r0 = cfg.get_radius(0, 0.0);
        for (layer_idx, oi) in raw_overhangs {
            let overhang_raw = overhangs[oi].clone();
            let li = layer_idx as i32;
            let relevant_forbidden_raw = if cfg.support_rests_on_model {
                self.volumes.get_collision(r0, li, min_xy_dist)
            } else {
                self.volumes.get_avoidance(r0, li, AvoidanceType::Fast, false, min_xy_dist)
            };
            let relevant_forbidden = poly::offset_miter(&poly::union(&relevant_forbidden_raw), 0.005, 1.2);
            let mut overhang_regular = safe_offset_inc(&overhang_raw, m.support_offset, &relevant_forbidden, (cfg.min_radius as f64 * 1.75 + cfg.xy_min_distance as f64) as C, 0, 1);
            let covered = poly::offset_miter(&poly::union(&overhang_regular), mm(cfg.support_line_width) * 0.5, 1.2);
            let mut remaining_overhang = poly::intersect(&poly::diff(&overhang_raw, &covered), &relevant_forbidden);
            let mut extra_total_offset_acc: C = 0;
            while !remaining_overhang.is_empty() && extra_total_offset_acc + cfg.support_line_width / 8 < extra_outset {
                let offset_current_step = (if extra_total_offset_acc + 2 * cfg.support_line_width > cfg.min_radius { cfg.support_line_width / 8 } else { circle_length_to_half_linewidth_change })
                    .min(extra_outset - extra_total_offset_acc);
                extra_total_offset_acc += offset_current_step;
                let raw_collision = self.volumes.get_collision(0, li, true);
                let offset_step = cfg.xy_min_distance + cfg.support_line_width;
                remaining_overhang = poly::diff(&remaining_overhang, &safe_offset_inc(&overhang_regular, (1.5 * extra_total_offset_acc as f64) as C, &raw_collision, offset_step, 0, 1));
                let grown = poly::diff(&safe_offset_inc(&remaining_overhang, extra_total_offset_acc, &raw_collision, offset_step, 0, 1), &relevant_forbidden);
                overhang_regular = poly::union2(&overhang_regular, &grown);
            }
            if roof_enabled {
                let overhang_roofs = safe_offset_inc(&overhang_raw, 0, &relevant_forbidden, cfg.min_radius * 2 + cfg.xy_min_distance, 0, 1);
                overhang_regular = poly::diff(&overhang_regular, &overhang_roofs);
                for roof_part in poly::union(&overhang_roofs) {
                    self.sample_overhang_area(vec![roof_part], true, li, num_support_roof_layers, connect_length);
                }
            }
            for support_part in poly::union(&overhang_regular) {
                self.sample_overhang_area(vec![support_part], false, li, num_support_roof_layers, connect_length);
            }
        }
        self.finalize_raft_contact(raft_contact_layer_idx);
    }
}
