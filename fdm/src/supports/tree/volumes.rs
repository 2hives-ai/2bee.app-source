//! Port of Support/TreeModelVolumes: collision, hole free collision, avoidance (to build plate / to model),
//! placeable areas and wall restrictions per (radius, layer). Values are computed lazily and memoised; each
//! formula is the one of `calculateCollision` / `calculateAvoidance` / ... (the C++ precalculates in parallel).
use super::settings::*;
use crate::supports::poly::{self, Join};
use crate::types::Polys;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

pub const SUPPORT_TREE_EXPONENTIAL_FACTOR: f64 = 1.5;
fn exponential_threshold() -> C { sc(1.0 * SUPPORT_TREE_EXPONENTIAL_FACTOR) }
fn collision_resolution() -> C { sc(0.5) }

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum AvoidanceType { Slow, FastSafe, Fast }

type P = Rc<Polys>;

pub struct Volumes {
    pub max_move: C,
    pub max_move_slow: C,
    pub min_resolution: C,
    pub current_min_xy_dist: C,
    pub current_min_xy_dist_delta: C,
    pub support_rests_on_model: bool,
    pub increase_until_radius: C,
    pub radius_0: C,
    pub ignorable_radii: Vec<C>,
    // current mesh settings used by the collision code
    layer_height: C,
    z_distance_bottom_layers: i32,
    z_distance_top_layers: i32,
    xy_distance_current_min: C,
    outlines: Vec<Polys>,
    anti_overhang: Vec<Polys>,
    pub bed_area: Polys,
    // caches
    collision: RefCell<HashMap<(C, i32), P>>,
    collision_holefree: RefCell<HashMap<(C, i32), P>>,
    placeable: RefCell<HashMap<(C, i32), P>>,
    wall_restr: RefCell<HashMap<(C, i32, bool), P>>,
    avoidance: RefCell<HashMap<(AvoidanceType, bool, C), Vec<P>>>,
    offsetted: RefCell<HashMap<(C, i32), P>>,
}

impl Volumes {
    pub fn new(cfg: &TreeSettings, outlines: Vec<Polys>, anti_overhang: Vec<Polys>, bed_area: Polys) -> Volumes {
        let m = &cfg.settings;
        let delta = cfg.xy_distance - cfg.xy_min_distance;
        let mut v = Volumes {
            max_move: (cfg.maximum_move_distance - 2).max(0),
            max_move_slow: (cfg.maximum_move_distance_slow - 2).max(0),
            min_resolution: cfg.resolution,
            current_min_xy_dist: cfg.xy_min_distance,
            current_min_xy_dist_delta: delta,
            support_rests_on_model: cfg.support_rests_on_model,
            increase_until_radius: cfg.increase_radius_until_radius,
            radius_0: cfg.get_radius(0, 0.0),
            ignorable_radii: Vec::new(),
            layer_height: m.layer_height,
            z_distance_bottom_layers: ((m.support_bottom_distance as f64 / m.layer_height as f64).round()) as i32,
            z_distance_top_layers: ((m.support_top_distance as f64 / m.layer_height as f64).round()) as i32,
            xy_distance_current_min: cfg.xy_min_distance,
            outlines, anti_overhang, bed_area,
            collision: Default::default(), collision_holefree: Default::default(), placeable: Default::default(),
            wall_restr: Default::default(), avoidance: Default::default(), offsetted: Default::default(),
        };
        v.compute_ignorable_radii(cfg);
        v
    }

    /// The part of `precalculate()` that defines `m_ignorable_radii` (needed by ceilRadius).
    fn compute_ignorable_radii(&mut self, cfg: &TreeSettings) {
        let mut possible: Vec<C> = Vec::new();
        for dtt in 0..=cfg.tip_layers {
            possible.push(self.ceil_radius(cfg.get_radius(dtt, 0.0)));
            possible.push(self.ceil_radius(cfg.get_radius(dtt, 0.0) + self.current_min_xy_dist_delta));
        }
        possible.sort();
        possible.dedup();
        let mut ignorable = Vec::new();
        let mut radius_eval = self.radius_0;
        while radius_eval <= cfg.branch_radius {
            if possible.binary_search(&radius_eval).is_err() { ignorable.push(radius_eval); }
            radius_eval = self.ceil_radius(radius_eval + 1);
        }
        self.ignorable_radii = ignorable;
    }

    // ---------------------------------------------------------------- radii
    fn ignore(&self, r: C) -> bool { self.ignorable_radii.binary_search(&r).is_ok() }

    pub fn ceil_radius(&self, radius: C) -> C {
        if radius == 0 { return 0; }
        let mut out = self.radius_0;
        if radius > self.radius_0 {
            let initial_radius_delta = exponential_threshold() - self.radius_0;
            if initial_radius_delta > collision_resolution() {
                let num_steps = ((initial_radius_delta + exponential_threshold() - 1) / exponential_threshold()) as i64;
                let stepsize = initial_radius_delta / num_steps;
                out += stepsize;
                for _ in 0..num_steps {
                    if out >= radius && !self.ignore(out) { return out; }
                    out += stepsize;
                }
            } else {
                out += collision_resolution();
            }
            while out < radius || self.ignore(out) {
                out = (out as f64 * SUPPORT_TREE_EXPONENTIAL_FACTOR) as C;
            }
        }
        out
    }
    pub fn ceil_radius_xy(&self, radius: C, min_xy_dist: bool) -> C {
        if min_xy_dist { self.ceil_radius(radius) }
        else if radius > 0 { self.ceil_radius(radius + self.current_min_xy_dist_delta) }
        else { self.current_min_xy_dist_delta }
    }
    pub fn get_radius_next_ceil(&self, radius: C, min_xy_dist: bool) -> C {
        if min_xy_dist { self.ceil_radius(radius) } else { self.ceil_radius(radius + self.current_min_xy_dist_delta) - self.current_min_xy_dist_delta }
    }

    // ------------------------------------------------------------- collision
    fn collision_offsetted(&self, radius: C, layer: i32) -> P {
        // collision_areas_offsetted[layer] for (radius + xy_distance)
        if let Some(p) = self.offsetted.borrow().get(&(radius, layer)) { return p.clone(); }
        let offset_value = radius + self.xy_distance_current_min;
        let src = &self.outlines[layer as usize];
        let res = if offset_value == 0 { poly::union(src) } else { poly::offset_miter(src, mm(offset_value), 1.2) };
        let rc = Rc::new(res);
        self.offsetted.borrow_mut().insert((radius, layer), rc.clone());
        rc
    }

    fn calc_collision(&self, radius: C, layer: i32) -> P {
        let n = self.outlines.len() as i32;
        let xy_distance = self.xy_distance_current_min;
        let mut collisions: Polys = Vec::new();
        for i in -self.z_distance_bottom_layers..=0 {
            let j = layer + i;
            if j >= 0 && j < n { collisions.extend(self.collision_offsetted(radius, j).iter().cloned()); }
        }
        let ztop = self.z_distance_top_layers;
        for i in 1..=ztop {
            let j = layer + i;
            if j < n && j >= 0 {
                let required_range_x = (xy_distance as f64 - ((i as f64 - if ztop == 1 { 0.5 } else { 0.0 }) * xy_distance as f64 / ztop as f64)) as C;
                collisions.extend(poly::offset_miter(&self.outlines[j as usize], mm(radius + required_range_x), 1.2));
            }
        }
        if (layer as usize) < self.anti_overhang.len() && !self.anti_overhang[layer as usize].is_empty() {
            let ao = poly::offset_miter(&self.anti_overhang[layer as usize], mm(radius), 1.2);
            collisions.extend(ao);
        }
        let u = poly::union(&collisions);
        Rc::new(poly::simplify(&u, mm(self.min_resolution)))
    }

    /// `getCollision`
    pub fn get_collision(&self, orig_radius: C, layer: i32, min_xy_dist: bool) -> P {
        let radius = self.ceil_radius_xy(orig_radius, min_xy_dist);
        if layer < 0 { return Rc::new(Vec::new()); }
        if let Some(p) = self.collision.borrow().get(&(radius, layer)) { return p.clone(); }
        let p = self.calc_collision(radius, layer);
        self.collision.borrow_mut().insert((radius, layer), p.clone());
        p
    }

    /// Collision area for the radius 0 (used by the nudging step: `get_collision_lower_bound_area(layer, 0)`).
    pub fn collision_radius0(&self, layer: i32) -> P { self.get_collision(0, layer, true) }

    fn get_collision_holefree(&self, radius: C, layer: i32) -> P {
        if let Some(p) = self.collision_holefree.borrow().get(&(radius, layer)) { return p.clone(); }
        let increase_radius_ceil = self.ceil_radius_xy(self.increase_until_radius, false) - radius;
        let base = self.get_collision(self.increase_until_radius, layer, false);
        let off = poly::offset_round(&poly::union(&base), mm(5 - increase_radius_ceil), mm(self.min_resolution));
        let p = Rc::new(poly::simplify(&off, mm(self.min_resolution)));
        self.collision_holefree.borrow_mut().insert((radius, layer), p.clone());
        p
    }

    // ------------------------------------------------------------- placeable
    pub fn get_placeable_areas(&self, orig_radius: C, layer: i32) -> P {
        let radius = self.ceil_radius(orig_radius);
        if let Some(p) = self.placeable.borrow().get(&(radius, layer)) { return p.clone(); }
        let p: P = if orig_radius == 0 {
            // radius 0 placeable areas come from the collision code
            Rc::new(self.calc_placeable0(layer))
        } else {
            let base = self.get_placeable_areas(0, layer);
            let off = poly::offset_miter(&poly::union(&base), -mm(radius + self.current_min_xy_dist + self.current_min_xy_dist_delta), 1.2);
            Rc::new(off)
        };
        self.placeable.borrow_mut().insert((radius, layer), p.clone());
        p
    }

    fn calc_placeable0(&self, layer: i32) -> Polys {
        if !self.support_rests_on_model { return Vec::new(); }
        let z_bottom = self.z_distance_bottom_layers;
        if layer < z_bottom + 1 { return Vec::new(); }
        let layer_idx_below = layer - z_bottom - 1;
        if layer_idx_below < 0 || layer as usize >= self.outlines.len() { return Vec::new(); }
        let current = self.collision_offsetted(0, layer);
        let below = &self.outlines[layer_idx_below as usize];
        let sub = if (layer_idx_below as usize) < self.anti_overhang.len() {
            poly::union2(&current, &self.anti_overhang[layer_idx_below as usize])
        } else { (*current).clone() };
        let placable = poly::diff(&poly::offset(below, mm(self.xy_distance_current_min)), &sub);
        poly::simplify(&placable, mm(self.min_resolution))
    }

    // ---------------------------------------------------------- wall restr.
    pub fn get_wall_restriction(&self, orig_radius: C, layer: i32, min_xy_dist: bool) -> P {
        if layer <= 0 { return self.get_collision(orig_radius, layer.max(0), min_xy_dist); }
        let min_xy = min_xy_dist && self.current_min_xy_dist_delta > 0;
        let radius = self.ceil_radius(orig_radius);
        if let Some(p) = self.wall_restr.borrow().get(&(radius, layer, min_xy)) { return p.clone(); }
        let c0 = self.get_collision(0, layer, min_xy);
        let cr = self.get_collision(radius, layer - 1, true);
        let p = Rc::new(poly::simplify(&poly::intersect(&c0, &cr), mm(self.min_resolution)));
        self.wall_restr.borrow_mut().insert((radius, layer, min_xy), p.clone());
        p
    }

    // -------------------------------------------------------------- avoidance
    pub fn get_avoidance(&self, orig_radius: C, layer: i32, ty: AvoidanceType, to_model: bool, min_xy_dist: bool) -> P {
        if layer <= 0 { return self.get_collision(orig_radius, layer.max(0), min_xy_dist); }
        let radius = self.ceil_radius_xy(orig_radius, min_xy_dist);
        let mut ty = ty;
        if ty == AvoidanceType::FastSafe && radius >= self.increase_until_radius + self.current_min_xy_dist_delta { ty = AvoidanceType::Fast; }
        let key = (ty, to_model, radius);
        {
            let c = self.avoidance.borrow();
            if let Some(v) = c.get(&key) { if (layer as usize) <= v.len() && layer >= 1 { return v[layer as usize - 1].clone(); } }
        }
        self.calculate_avoidance(key, layer);
        let c = self.avoidance.borrow();
        c.get(&key).unwrap()[layer as usize - 1].clone()
    }

    fn calculate_avoidance(&self, key: (AvoidanceType, bool, C), max_layer: i32) {
        let (ty, to_model, radius) = key;
        let have = self.avoidance.borrow().get(&key).map(|v| v.len()).unwrap_or(0) as i32; // layers 1..=have
        let start_layer = 1 + have;
        if start_layer > max_layer { return; }
        let slow = ty == AvoidanceType::Slow;
        let holefree = ty == AvoidanceType::FastSafe;
        let collision_holefree = (slow || holefree) && radius < self.increase_until_radius + self.current_min_xy_dist_delta;
        let max_move = (if slow { self.max_move_slow } else { self.max_move }) as f32;
        let mut move_step: f32 = 1.9f32 * (radius.max(self.current_min_xy_dist) as f32);
        if (move_step as f64) < 1e-4 { return; }
        let mut move_steps: i32 = ((max_move as i32) + (move_step as i32) - 1) / (move_step as i32).max(1);
        let mut last_move_step: f32 = max_move - (move_steps - 1) as f32 * move_step;
        if last_move_step < 0.05f32 * 1e6f32 {
            if move_steps > 1 {
                move_steps -= 1;
                move_step = max_move / move_steps as f32;
                last_move_step = move_step;
            }
        }
        // previous avoidance (layer start-1); layer 0 is the collision area
        let mut latest: Polys = if start_layer == 1 {
            (*self.get_collision(radius, 0, true)).clone()
        } else {
            (*self.avoidance.borrow().get(&key).unwrap()[start_layer as usize - 2]).clone()
        };
        let mut data: Vec<P> = Vec::new();
        for layer_idx in start_layer..=max_layer {
            let cur: P = if collision_holefree { self.get_collision_holefree(radius, layer_idx) } else { self.get_collision(radius, layer_idx, true) };
            for istep in 0..move_steps {
                let d = if istep + 1 == move_steps { -last_move_step } else { -move_step } as f64;
                let off = poly::offset_round(&latest, d * 1e-6, mm(self.min_resolution));
                let mut u = (*cur).clone();
                u.extend(off);
                latest = poly::union(&u);
            }
            if to_model { latest = poly::diff(&latest, &self.get_placeable_areas(radius, layer_idx)); }
            latest = poly::simplify(&latest, mm(self.min_resolution));
            data.push(Rc::new(latest.clone()));
        }
        self.avoidance.borrow_mut().entry(key).or_default().extend(data);
    }
}
