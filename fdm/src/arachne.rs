//! Lane 2: Arachne variable-width wall generator (`wall_generator = arachne`).
//!
//! A port of libslic3r `Arachne/` (WallToolPaths, SkeletalTrapezoidation, the beading strategies, ExtrusionLine) and of
//! `PerimeterGenerator::process_arachne`, on top of `boostvoronoi` (a Rust port of boost::polygon::voronoi, the same
//! Voronoi construction Orca uses). All Arachne arithmetic runs in Orca's integer units (1 unit = 1e-6 mm) so the
//! thresholds and rounding match; conversion to/from the f64 millimetre `types::Polys` happens at the boundary.
//!
//! Orca references: Arachne/WallToolPaths.cpp, Arachne/SkeletalTrapezoidation.cpp (+Graph/Edge/Joint),
//! Arachne/BeadingStrategy/*.cpp, Arachne/utils/{ExtrusionLine,PolylineStitcher}.cpp, Geometry/VoronoiUtils.cpp,
//! PerimeterGenerator.cpp (process_arachne, traverse_extrusions, clip_extrusion).
//!
//! What is NOT ported (documented limits): fuzzy skin (refused by `walls::refuse_unsupported`), `overhang_reverse`,
//! counterbore bridging, `generateExtraRibs` (a no-op for Orca's strategy chain: the outermost LimitedBeadingStrategy
//! does not override `getNonlinearThicknesses`, so it always returns an empty list).

use crate::types::*;
use crate::walls::{geo, WallParams, WallResult, WallSequence, P2};
use std::collections::BTreeSet;
use std::f64::consts::PI;

pub type Pt = [i64; 2];
pub const SCALE: f64 = 1e6;

#[inline]
fn sc(mm: f64) -> i64 {
    (mm * SCALE).round() as i64
}
#[inline]
fn to_mm(p: Pt) -> P2 {
    [p[0] as f64 / SCALE, p[1] as f64 / SCALE]
}
#[inline]
fn to_int(p: P2) -> Pt {
    [(p[0] * SCALE).round() as i64, (p[1] * SCALE).round() as i64]
}
#[inline]
fn sub(a: Pt, b: Pt) -> Pt {
    [a[0] - b[0], a[1] - b[1]]
}
#[inline]
fn add(a: Pt, b: Pt) -> Pt {
    [a[0] + b[0], a[1] + b[1]]
}
/// Eigen `Vec2i64::norm()` converted to coord_t: truncated.
#[inline]
fn norm_i(a: Pt) -> i64 {
    ((a[0] as f64) * (a[0] as f64) + (a[1] as f64) * (a[1] as f64)).sqrt() as i64
}
#[inline]
fn dist_i(a: Pt, b: Pt) -> i64 {
    norm_i(sub(a, b))
}
/// libslic3r `shorter_then(p0, len)`: |p0| <= len.
#[inline]
fn shorter_then(p: Pt, len: i64) -> bool {
    if p[0] > len || p[0] < -len || p[1] > len || p[1] < -len {
        return false;
    }
    (p[0] as i128 * p[0] as i128 + p[1] as i128 * p[1] as i128) <= (len as i128 * len as i128)
}
#[inline]
fn perp(p: Pt) -> Pt {
    [-p[1], p[0]]
}
#[inline]
fn dot(a: Pt, b: Pt) -> i64 {
    a[0] * b[0] + a[1] * b[1]
}
#[inline]
fn cross(a: Pt, b: Pt) -> i64 {
    a[0] * b[1] - a[1] * b[0]
}

// =====================================================================================================================
// beading strategies (Arachne/BeadingStrategy)
// =====================================================================================================================
#[derive(Clone, Debug, Default)]
pub struct Beading {
    pub total_thickness: i64,
    pub bead_widths: Vec<i64>,
    pub toolpath_locations: Vec<i64>,
    pub left_over: i64,
}

#[derive(Clone, Copy, Debug)]
pub struct BeadingBase {
    pub optimal_width: i64,
    pub split_middle_threshold: f64,
    pub add_middle_threshold: f64,
    pub default_transition_length: i64,
    pub transitioning_angle: f64,
}

pub trait BeadingStrategy {
    fn base(&self) -> &BeadingBase;
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading;
    fn optimal_bead_count(&self, thickness: i64) -> i64;
    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.base().optimal_width * bead_count
    }
    fn transition_thickness(&self, lower_bead_count: i64) -> i64 {
        let lower = self.optimal_thickness(lower_bead_count);
        let higher = self.optimal_thickness(lower_bead_count + 1);
        let b = self.base();
        let threshold = if lower_bead_count % 2 == 1 { b.split_middle_threshold } else { b.add_middle_threshold };
        (lower as f64 + threshold * (higher - lower) as f64) as i64
    }
    fn transitioning_length(&self, lower_bead_count: i64) -> i64 {
        if lower_bead_count == 0 {
            return 10_000; // scaled(0.01)
        }
        self.base().default_transition_length
    }
    fn transition_anchor_pos(&self, lower_bead_count: i64) -> f32 {
        let lower_optimum = self.optimal_thickness(lower_bead_count);
        let transition_point = self.transition_thickness(lower_bead_count);
        let upper_optimum = self.optimal_thickness(lower_bead_count + 1);
        1.0 - (transition_point - lower_optimum) as f32 / (upper_optimum - lower_optimum) as f32
    }
    fn nonlinear_thicknesses(&self, _lower_bead_count: i64) -> Vec<i64> {
        vec![]
    }
    fn split_middle_threshold(&self) -> f64 {
        self.base().split_middle_threshold
    }
    fn transitioning_angle(&self) -> f64 {
        self.base().transitioning_angle
    }
}

pub struct Distributed {
    base: BeadingBase,
    one_over_distribution_radius_squared: f32,
}
impl Distributed {
    pub fn new(optimal_width: i64, default_transition_length: i64, transitioning_angle: f64, split: f64, add: f64, distribution_radius: i32) -> Self {
        let r = if distribution_radius >= 2 { 1.0f32 / (distribution_radius - 1) as f32 * 1.0 / (distribution_radius - 1) as f32 } else { 1.0 };
        Distributed {
            base: BeadingBase { optimal_width, split_middle_threshold: split, add_middle_threshold: add, default_transition_length, transitioning_angle },
            one_over_distribution_radius_squared: r,
        }
    }
}
impl BeadingStrategy for Distributed {
    fn base(&self) -> &BeadingBase {
        &self.base
    }
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let ow = self.base.optimal_width;
        let mut ret = Beading { total_thickness: thickness, ..Default::default() };
        if bead_count > 2 {
            let to_be_divided = thickness - bead_count * ow;
            let middle = (bead_count - 1) as f32 / 2.0;
            let weight = |i: i64| -> f32 {
                let dev = i as f32 - middle;
                (1.0 - self.one_over_distribution_radius_squared * dev * dev).max(0.0)
            };
            let weights: Vec<f32> = (0..bead_count).map(weight).collect();
            let total_weight: f32 = weights.iter().sum();
            let mut accumulated = 0i64;
            for i in 0..bead_count {
                let weight_fraction = weights[i as usize] / total_weight;
                let splitup = (to_be_divided as f32 * weight_fraction) as i64;
                let width = if i == bead_count - 1 { thickness - accumulated } else { ow + splitup };
                if i == 0 {
                    ret.toolpath_locations.push(width / 2);
                } else {
                    let last = *ret.toolpath_locations.last().unwrap();
                    ret.toolpath_locations.push(last + (ret.bead_widths.last().unwrap() + width) / 2);
                }
                ret.bead_widths.push(width);
                accumulated += width;
            }
            ret.left_over = 0;
        } else if bead_count == 2 {
            let outer_width = thickness / 2;
            ret.bead_widths.push(outer_width);
            ret.bead_widths.push(outer_width);
            ret.toolpath_locations.push(outer_width / 2);
            ret.toolpath_locations.push(thickness - outer_width / 2);
            ret.left_over = 0;
        } else if bead_count == 1 {
            ret.bead_widths.push(thickness);
            ret.toolpath_locations.push(thickness / 2);
            ret.left_over = 0;
        } else {
            ret.left_over = thickness;
        }
        ret
    }
    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        let ow = self.base.optimal_width;
        let naive_count = thickness / ow;
        let remainder = thickness - naive_count * ow;
        let minimum_line_width = (ow as f64 * if naive_count % 2 == 1 { self.base.split_middle_threshold } else { self.base.add_middle_threshold }) as i64;
        naive_count + (remainder >= minimum_line_width) as i64
    }
}

pub struct Redistribute {
    base: BeadingBase,
    optimal_width_outer: i64,
    minimum_variable_line_ratio: f64,
    parent: Box<dyn BeadingStrategy>,
}
impl Redistribute {
    pub fn new(optimal_width_outer: i64, minimum_variable_line_ratio: f64, parent: Box<dyn BeadingStrategy>) -> Self {
        Redistribute { base: *parent.base(), optimal_width_outer, minimum_variable_line_ratio, parent }
    }
}
impl BeadingStrategy for Redistribute {
    fn base(&self) -> &BeadingBase {
        &self.base
    }
    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        let inner = (bead_count - 2).max(0);
        let outer = bead_count - inner;
        self.parent.optimal_thickness(inner) + self.optimal_width_outer * outer
    }
    fn transition_thickness(&self, lower: i64) -> i64 {
        match lower {
            0 => (self.minimum_variable_line_ratio * self.optimal_width_outer as f64) as i64,
            1 => ((1.0 + self.parent.split_middle_threshold()) * self.optimal_width_outer as f64) as i64,
            _ => self.parent.transition_thickness(lower - 2) + 2 * self.optimal_width_outer,
        }
    }
    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        if (thickness as f64) < self.minimum_variable_line_ratio * self.optimal_width_outer as f64 {
            return 0;
        }
        if thickness <= 2 * self.optimal_width_outer {
            return if thickness as f64 > (1.0 + self.parent.split_middle_threshold()) * self.optimal_width_outer as f64 { 2 } else { 1 };
        }
        self.parent.optimal_bead_count(thickness - 2 * self.optimal_width_outer) + 2
    }
    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }
    fn transition_anchor_pos(&self, lower: i64) -> f32 {
        self.parent.transition_anchor_pos(lower)
    }
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let mut ret = Beading::default();
        if bead_count == 0 || (thickness as f64) < self.minimum_variable_line_ratio * self.optimal_width_outer as f64 {
            ret.left_over = thickness;
            ret.total_thickness = thickness;
            return ret;
        }
        let inner_bead_count = bead_count - 2;
        let inner_thickness = thickness - 2 * self.optimal_width_outer;
        if inner_bead_count > 0 && inner_thickness > 0 {
            ret = self.parent.compute(inner_thickness, inner_bead_count);
            for l in ret.toolpath_locations.iter_mut() {
                *l += self.optimal_width_outer;
            }
        }
        let actual_outer_thickness = if bead_count > 2 { (thickness / 2).min(self.optimal_width_outer) } else { thickness / bead_count };
        ret.bead_widths.insert(0, actual_outer_thickness);
        ret.toolpath_locations.insert(0, actual_outer_thickness / 2);
        if bead_count > 1 {
            ret.bead_widths.push(actual_outer_thickness);
            ret.toolpath_locations.push(thickness - actual_outer_thickness / 2);
        }
        ret.total_thickness = thickness;
        ret.left_over = thickness - ret.bead_widths.iter().sum::<i64>();
        ret
    }
}

pub struct Widening {
    base: BeadingBase,
    min_input_width: i64,
    min_output_width: i64,
    parent: Box<dyn BeadingStrategy>,
}
impl Widening {
    pub fn new(parent: Box<dyn BeadingStrategy>, min_input_width: i64, min_output_width: i64) -> Self {
        Widening { base: *parent.base(), min_input_width, min_output_width, parent }
    }
}
impl BeadingStrategy for Widening {
    fn base(&self) -> &BeadingBase {
        &self.base
    }
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        if bead_count <= 1 && thickness < self.transition_thickness(1) {
            let mut ret = Beading { total_thickness: thickness, ..Default::default() };
            if thickness >= self.min_input_width {
                ret.bead_widths.push(thickness.max(self.min_output_width));
                ret.toolpath_locations.push(thickness / 2);
                ret.left_over = 0;
            } else {
                ret.left_over = thickness;
            }
            ret
        } else {
            self.parent.compute(thickness, bead_count)
        }
    }
    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.parent.optimal_thickness(bead_count)
    }
    fn transition_thickness(&self, lower: i64) -> i64 {
        if lower == 0 {
            self.min_input_width
        } else {
            self.parent.transition_thickness(lower)
        }
    }
    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        if thickness < self.min_input_width {
            return 0;
        }
        let ret = self.parent.optimal_bead_count(thickness);
        if thickness >= self.min_input_width && ret < 1 {
            return 1;
        }
        ret
    }
    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }
    fn transition_anchor_pos(&self, lower: i64) -> f32 {
        self.parent.transition_anchor_pos(lower)
    }
    fn nonlinear_thicknesses(&self, lower: i64) -> Vec<i64> {
        let mut r = vec![self.min_output_width];
        r.extend(self.parent.nonlinear_thicknesses(lower));
        r
    }
}

pub struct OuterWallInset {
    base: BeadingBase,
    outer_wall_offset: i64,
    parent: Box<dyn BeadingStrategy>,
}
impl OuterWallInset {
    pub fn new(outer_wall_offset: i64, parent: Box<dyn BeadingStrategy>) -> Self {
        OuterWallInset { base: *parent.base(), outer_wall_offset, parent }
    }
}
impl BeadingStrategy for OuterWallInset {
    fn base(&self) -> &BeadingBase {
        &self.base
    }
    fn compute(&self, thickness: i64, bead_count: i64) -> Beading {
        let mut ret = self.parent.compute(thickness, bead_count);
        let n = ret.bead_widths.iter().filter(|&&w| w > 0).count();
        if n < 2 {
            return ret;
        }
        ret.toolpath_locations[0] = (ret.toolpath_locations[0] + self.outer_wall_offset).min(thickness / 2);
        ret
    }
    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        self.parent.optimal_thickness(bead_count)
    }
    fn transition_thickness(&self, lower: i64) -> i64 {
        self.parent.transition_thickness(lower)
    }
    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        self.parent.optimal_bead_count(thickness)
    }
    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }
}

pub struct Limited {
    base: BeadingBase,
    max_bead_count: i64,
    parent: Box<dyn BeadingStrategy>,
}
impl Limited {
    pub fn new(max_bead_count: i64, parent: Box<dyn BeadingStrategy>) -> Self {
        Limited { base: *parent.base(), max_bead_count, parent }
    }
}
impl BeadingStrategy for Limited {
    fn base(&self) -> &BeadingBase {
        &self.base
    }
    fn compute(&self, thickness: i64, mut bead_count: i64) -> Beading {
        let max = self.max_bead_count;
        if bead_count <= max {
            let mut ret = self.parent.compute(thickness, bead_count);
            bead_count = ret.toolpath_locations.len() as i64;
            if bead_count % 2 == 0 && bead_count == max {
                let h = (max / 2) as usize;
                let innermost_loc = ret.toolpath_locations[h - 1];
                let innermost_w = ret.bead_widths[h - 1];
                ret.toolpath_locations.insert(h, innermost_loc + innermost_w / 2);
                ret.bead_widths.insert(h, 0);
            }
            return ret;
        }
        let optimal_thickness = self.parent.optimal_thickness(max);
        let mut ret = self.parent.compute(optimal_thickness, max);
        bead_count = ret.toolpath_locations.len() as i64;
        ret.left_over += thickness - ret.total_thickness;
        ret.total_thickness = thickness;
        // Enforce symmetry
        if bead_count % 2 == 1 {
            ret.toolpath_locations[(bead_count / 2) as usize] = thickness / 2;
            ret.bead_widths[(bead_count / 2) as usize] = thickness - optimal_thickness;
        }
        for i in 0..(bead_count + 1) / 2 {
            ret.toolpath_locations[(bead_count - 1 - i) as usize] = thickness - ret.toolpath_locations[i as usize];
        }
        // A "fake" inner wall with 0 width marking the edge of the walled area.
        let h = (max / 2) as usize;
        let innermost_loc = ret.toolpath_locations[h - 1];
        let innermost_w = ret.bead_widths[h - 1];
        ret.toolpath_locations.insert(h, innermost_loc + innermost_w / 2);
        ret.bead_widths.insert(h, 0);
        // Symmetry on both sides.
        let opposite = (bead_count - (max / 2 - 1)) as usize;
        let innermost_loc = ret.toolpath_locations[opposite];
        let innermost_w = ret.bead_widths[opposite];
        ret.toolpath_locations.insert(opposite, innermost_loc - innermost_w / 2);
        ret.bead_widths.insert(opposite, 0);
        ret
    }
    fn optimal_thickness(&self, bead_count: i64) -> i64 {
        if bead_count <= self.max_bead_count {
            return self.parent.optimal_thickness(bead_count);
        }
        1_000_000_000 // 1 meter
    }
    fn transition_thickness(&self, lower: i64) -> i64 {
        if lower < self.max_bead_count {
            return self.parent.transition_thickness(lower);
        }
        if lower == self.max_bead_count {
            return self.parent.optimal_thickness(lower + 1) - 10_000;
        }
        900_000_000
    }
    fn optimal_bead_count(&self, thickness: i64) -> i64 {
        let parent_count = self.parent.optimal_bead_count(thickness);
        if parent_count <= self.max_bead_count {
            parent_count
        } else if parent_count == self.max_bead_count + 1 {
            if thickness < self.parent.optimal_thickness(self.max_bead_count + 1) - 10_000 {
                self.max_bead_count
            } else {
                self.max_bead_count + 1
            }
        } else {
            self.max_bead_count + 1
        }
    }
    fn transitioning_length(&self, lower: i64) -> i64 {
        self.parent.transitioning_length(lower)
    }
    fn transition_anchor_pos(&self, lower: i64) -> f32 {
        self.parent.transition_anchor_pos(lower)
    }
}

/// `BeadingStrategyFactory::makeStrategy`.
#[allow(clippy::too_many_arguments)]
pub fn make_strategy(
    preferred_bead_width_outer: i64,
    preferred_bead_width_inner: i64,
    preferred_transition_length: i64,
    transitioning_angle: f32,
    print_thin_walls: bool,
    min_bead_width: i64,
    min_feature_size: i64,
    wall_split_middle_threshold: f64,
    wall_add_middle_threshold: f64,
    max_bead_count: i64,
    outer_wall_offset: i64,
    inward_distributed_center_wall_count: i32,
) -> Box<dyn BeadingStrategy> {
    let optimal_width = if max_bead_count <= 2 { preferred_bead_width_outer } else { preferred_bead_width_inner };
    let mut ret: Box<dyn BeadingStrategy> = Box::new(Distributed::new(
        optimal_width,
        preferred_transition_length,
        transitioning_angle as f64,
        wall_split_middle_threshold,
        wall_add_middle_threshold,
        inward_distributed_center_wall_count,
    ));
    ret = Box::new(Redistribute::new(preferred_bead_width_outer, 0.5, ret));
    if print_thin_walls {
        ret = Box::new(Widening::new(ret, min_feature_size, min_bead_width));
    }
    if outer_wall_offset != 0 {
        ret = Box::new(OuterWallInset::new(outer_wall_offset, ret));
    }
    Box::new(Limited::new(max_bead_count, ret))
}

#[cfg(test)]
mod tests_beading {
    use super::*;
    #[test]
    fn strategy_chain_counts_and_bead_sums() {
        // Orca defaults for the X2D 0.4: outer spacing 0.4071 mm, inner spacing 0.4571 - 0.0429... use round values
        let outer = 407_000;
        let inner = 407_000;
        let s = make_strategy(outer, inner, 400_000, (10.0f64.to_radians()) as f32, true, 340_000, 100_000, 0.5, 0.5, 4, 0, 1);
        // thin: nothing below the widening threshold, one bead above it
        assert_eq!(s.optimal_bead_count(50_000), 0);
        assert_eq!(s.optimal_bead_count(150_000), 1);
        // ~1 line, 2 lines, 3 lines...
        assert_eq!(s.optimal_bead_count(400_000), 1);
        assert_eq!(s.optimal_bead_count(900_000), 2);
        assert_eq!(s.optimal_bead_count(1_300_000), 3);
        // every computed beading with n beads and thickness t covers t exactly (sum of widths + left_over == t)
        for t in [500_000i64, 800_000, 1_000_000, 1_250_000, 1_700_000, 2_500_000] {
            let n = s.optimal_bead_count(t);
            let b = s.compute(t, n);
            let w: i64 = b.bead_widths.iter().sum();
            assert_eq!(w + b.left_over, t, "thickness {t} beads {n}: {:?}", b);
            assert_eq!(b.bead_widths.len(), b.toolpath_locations.len());
        }
        // widening: a feature of 0.2 mm is printed as one 0.34 mm (min_bead_width) bead
        let b = s.compute(200_000, 1);
        assert_eq!(b.bead_widths, vec![340_000]);
        // negative control: a plain strategy without Limited would not insert the zero-width marker; Limited with max 4 does
        let b = s.compute(3_000_000, 5);
        assert!(b.bead_widths.contains(&0), "limited: zero-width marker bead expected {:?}", b);
    }
}

// =====================================================================================================================
// integer polygon preparation (WallToolPaths.cpp: simplify, fixSelfIntersections, removeDegenerateVerts, ...)
// =====================================================================================================================
pub type Ring = Vec<Pt>;

fn dist_infinite_sq(p: Pt, a: Pt, b: Pt) -> (f64, Pt) {
    // line_alg::distance_to_infinite_squared with truncating closest point
    let v = [(b[0] - a[0]) as f64, (b[1] - a[1]) as f64];
    let va = [(p[0] - a[0]) as f64, (p[1] - a[1]) as f64];
    let l2 = v[0] * v[0] + v[1] * v[1];
    if l2 == 0.0 {
        return (va[0] * va[0] + va[1] * va[1], a);
    }
    let t = (va[0] * v[0] + va[1] * v[1]) / l2;
    let closest = [(a[0] as f64 + t * v[0]) as i64, (a[1] as f64 + t * v[1]) as i64];
    let d = [t * v[0] - va[0], t * v[1] - va[1]];
    (d[0] * d[0] + d[1] * d[1], closest)
}
fn dist_to_infinite(p: Pt, a: Pt, b: Pt) -> f64 {
    dist_infinite_sq(p, a, b).0.sqrt()
}
fn intersection_infinite(a1: Pt, a2: Pt, b1: Pt, b2: Pt) -> Option<Pt> {
    let a = [a1[0] as f64, a1[1] as f64];
    let v12 = [(b1[0] - a1[0]) as f64, (b1[1] - a1[1]) as f64];
    let v1 = [(a2[0] - a1[0]) as f64, (a2[1] - a1[1]) as f64];
    let v2 = [(b2[0] - b1[0]) as f64, (b2[1] - b1[1]) as f64];
    let denom = v1[0] * v2[1] - v1[1] * v2[0];
    if denom.abs() < 1e-4 {
        return None;
    }
    let t1 = (v12[0] * v2[1] - v12[1] * v2[0]) / denom;
    let r = [a[0] + t1 * v1[0], a[1] + t1 * v1[1]];
    if r[0].abs() > 9.0e18 || r[1].abs() > 9.0e18 {
        return None;
    }
    Some([r[0] as i64, r[1] as i64])
}

/// WallToolPaths.cpp `simplify(Polygon&, ...)`.
fn simplify_polygon(pts: &mut Ring, smallest_line_segment_squared: i64, allowed_error_distance_squared: i64) {
    let n = pts.len();
    if n < 3 {
        pts.clear();
        return;
    }
    if n == 3 {
        return;
    }
    let mut new_path: Ring = vec![];
    let mut previous = pts[n - 1];
    let mut previous_previous = pts[n - 2];
    let mut current = pts[0];
    let mut accumulated_area_removed: i64 = previous[0] * current[1] - previous[1] * current[0];
    let tiny2 = (5000i64) * (5000i64); // sqr(scaled(0.005))
    for point_idx in 0..n {
        current = pts[point_idx % n];
        let next = if point_idx + 1 < n {
            pts[point_idx + 1]
        } else if point_idx + 1 == n && new_path.len() > 1 {
            new_path[0]
        } else {
            pts[(point_idx + 1) % n]
        };
        let removed_area_next = current[0] * next[1] - current[1] * next[0];
        let negative_area_closing = next[0] * previous[1] - next[1] * previous[0];
        accumulated_area_removed += removed_area_next;
        let d = sub(current, previous);
        let length2 = d[0] * d[0] + d[1] * d[1];
        if length2 < tiny2 {
            continue;
        }
        let area_removed_so_far = accumulated_area_removed + negative_area_closing;
        let bd = sub(next, previous);
        let base_length_2 = bd[0] * bd[0] + bd[1] * bd[1];
        if base_length_2 == 0 {
            continue;
        }
        let height_2 = (area_removed_so_far as f64 * area_removed_so_far as f64 / base_length_2 as f64) as i64;
        if height_2 <= tiny2 && dist_to_infinite(current, previous, next) <= 5000.0 {
            continue;
        }
        if length2 < smallest_line_segment_squared && height_2 <= allowed_error_distance_squared {
            let nd = sub(current, next);
            let next_length2 = nd[0] * nd[0] + nd[1] * nd[1];
            if next_length2 > 4 * smallest_line_segment_squared {
                let ip = intersection_infinite(previous_previous, previous, current, next);
                let bad = match ip {
                    None => true,
                    Some(ip) => {
                        dist_infinite_sq(ip, previous, current).0 > allowed_error_distance_squared as f64
                            || {
                                let q = sub(ip, previous);
                                q[0] * q[0] + q[1] * q[1] > smallest_line_segment_squared
                            }
                            || {
                                let q = sub(ip, next);
                                q[0] * q[0] + q[1] * q[1] > smallest_line_segment_squared
                            }
                    }
                };
                if !bad {
                    current = ip.unwrap();
                    if !new_path.is_empty() {
                        new_path.pop();
                        previous = previous_previous;
                    }
                }
            } else {
                continue;
            }
        }
        accumulated_area_removed = removed_area_next;
        previous_previous = previous;
        previous = current;
        new_path.push(current);
    }
    *pts = new_path;
}

fn simplify_polygons(polys: &mut Vec<Ring>, smallest_line_segment: i64, allowed_error_distance: i64) {
    let a2 = allowed_error_distance * allowed_error_distance;
    let s2 = smallest_line_segment * smallest_line_segment;
    let mut p = 0;
    while p < polys.len() {
        simplify_polygon(&mut polys[p], s2, a2);
        if polys[p].len() < 3 {
            polys.remove(p);
        } else {
            p += 1;
        }
    }
}

fn point_is_left_of_line(p: Pt, a: Pt, b: Pt) -> i64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/// ClipperLib::SimplifyPolygons with pftEvenOdd.
fn simplify_evenodd(polys: &[Ring]) -> Vec<Ring> {
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::core::overlay_rule::OverlayRule;
    use i_overlay::float::single::SingleFloatOverlay;
    let rings: Vec<Vec<[f64; 2]>> = polys.iter().filter(|r| r.len() >= 3).map(|r| r.iter().map(|p| [p[0] as f64, p[1] as f64]).collect()).collect();
    if rings.is_empty() {
        return vec![];
    }
    let empty: Vec<Vec<[f64; 2]>> = vec![];
    let shapes = rings.overlay(&empty, OverlayRule::Subject, FillRule::EvenOdd);
    let mut out = vec![];
    for s in shapes {
        for r in s {
            out.push(r.iter().map(|p| [p[0].round() as i64, p[1].round() as i64]).collect());
        }
    }
    out
}

/// WallToolPaths.cpp `fixSelfIntersections(epsilon, polys)`.
fn fix_self_intersections(epsilon: i64, polys: &mut Vec<Ring>) {
    if epsilon < 1 {
        *polys = simplify_evenodd(polys);
        return;
    }
    let half_epsilon = (epsilon + 1) / 2;
    let move_dist = 2i64.max(half_epsilon - 2);
    let half_epsilon_sqrd = half_epsilon * half_epsilon;
    // uniform grid over segments (cell 2 mm), as SparseLineGrid
    let cell = sc(2.0);
    use std::collections::BTreeMap;
    let mut grid: BTreeMap<(i64, i64), Vec<(usize, usize)>> = BTreeMap::new();
    for (pi, r) in polys.iter().enumerate() {
        let n = r.len();
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            let (x0, x1) = (a[0].min(b[0]).div_euclid(cell), a[0].max(b[0]).div_euclid(cell));
            let (y0, y1) = (a[1].min(b[1]).div_euclid(cell), a[1].max(b[1]).div_euclid(cell));
            for cx in x0..=x1 {
                for cy in y0..=y1 {
                    grid.entry((cx, cy)).or_default().push((pi, i));
                }
            }
        }
    }
    for poly_idx in 0..polys.len() {
        let pathlen = polys[poly_idx].len();
        for point_idx in 0..pathlen {
            let pt = polys[poly_idx][point_idx];
            let (cx0, cx1) = ((pt[0] - epsilon).div_euclid(cell), (pt[0] + epsilon).div_euclid(cell));
            let (cy0, cy1) = ((pt[1] - epsilon).div_euclid(cell), (pt[1] + epsilon).div_euclid(cell));
            let mut seen: BTreeSet<(usize, usize)> = BTreeSet::new();
            let mut cur = pt;
            for cx in cx0..=cx1 {
                for cy in cy0..=cy1 {
                    if let Some(v) = grid.get(&(cx, cy)) {
                        for &(lp, li) in v {
                            if !seen.insert((lp, li)) {
                                continue;
                            }
                            let line_next_idx = (li + 1) % polys[lp].len();
                            if poly_idx == lp && (point_idx == li || point_idx == line_next_idx) {
                                continue;
                            }
                            let (sa, sb) = (polys[lp][li], polys[lp][line_next_idx]);
                            // closest point on the SEGMENT
                            let closest = closest_on_segment(cur, sa, sb);
                            let d = sub(cur, closest);
                            if half_epsilon_sqrd >= d[0] * d[0] + d[1] * d[1] {
                                let other = polys[poly_idx][(point_idx + 1) % pathlen];
                                let vec = if point_is_left_of_line(other, sa, sb) > 0 { sub(sb, sa) } else { sub(sa, sb) };
                                let len = ((vec[0] as f64).hypot(vec[1] as f64)) as i64;
                                if len > 0 {
                                    cur[0] += (-vec[1] * move_dist) / len;
                                    cur[1] += (vec[0] * move_dist) / len;
                                }
                            }
                        }
                    }
                }
            }
            polys[poly_idx][point_idx] = cur;
        }
    }
    *polys = simplify_evenodd(polys);
}

fn closest_on_segment(p: Pt, a: Pt, b: Pt) -> Pt {
    let v = [(b[0] - a[0]) as f64, (b[1] - a[1]) as f64];
    let va = [(p[0] - a[0]) as f64, (p[1] - a[1]) as f64];
    let l2 = v[0] * v[0] + v[1] * v[1];
    if l2 == 0.0 {
        return a;
    }
    let t = ((va[0] * v[0] + va[1] * v[1]) / l2).clamp(0.0, 1.0);
    [(a[0] as f64 + t * v[0]) as i64, (a[1] as f64 + t * v[1]) as i64]
}

fn remove_degenerate_verts(polys: &mut Vec<Ring>) {
    // `last_line.dot(next_line) == -1 * last_line.norm() * next_line.norm()` with Eigen's integer norms (truncated)
    let is_degenerate = |last: Pt, now: Pt, next: Pt| -> bool {
        let l = sub(now, last);
        let n = sub(next, now);
        dot(l, n) == -norm_i(l) * norm_i(n)
    };
    let mut poly_idx = 0;
    while poly_idx < polys.len() {
        let poly = polys[poly_idx].clone();
        let mut result: Ring = vec![];
        let mut changed = false;
        for idx in 0..poly.len() {
            let last = if result.is_empty() { *poly.last().unwrap() } else { *result.last().unwrap() };
            if idx + 1 == poly.len() && result.is_empty() {
                break;
            }
            let next = if idx + 1 == poly.len() { result[0] } else { poly[idx + 1] };
            if is_degenerate(last, poly[idx], next) {
                changed = true;
                while result.len() > 1 && is_degenerate(result[result.len() - 2], *result.last().unwrap(), next) {
                    result.pop();
                }
            } else {
                result.push(poly[idx]);
            }
        }
        if changed {
            if result.len() > 2 {
                polys[poly_idx] = result;
                poly_idx += 1;
            } else {
                polys.remove(poly_idx);
            }
        } else {
            poly_idx += 1;
        }
    }
}

fn ring_area_i(r: &Ring) -> f64 {
    // ClipperLib::Area
    let n = r.len();
    if n < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n {
        a += (r[j][0] as f64 + r[i][0] as f64) * (r[j][1] as f64 - r[i][1] as f64);
        j = i;
    }
    -a * 0.5
}

fn remove_small_areas(polys: &mut Vec<Ring>, min_area_size: f64) {
    // remove_holes = false variant
    let mut outlines_removed: Vec<Ring> = vec![];
    let mut small_holes: Vec<usize> = vec![];
    let mut keep: Vec<bool> = vec![true; polys.len()];
    for (i, p) in polys.iter().enumerate() {
        let area = ring_area_i(p);
        if area.abs() < min_area_size {
            if area >= 0.0 {
                keep[i] = false;
                outlines_removed.push(p.clone());
            } else {
                small_holes.push(i);
            }
        }
    }
    for &h in small_holes.iter().rev() {
        for o in &outlines_removed {
            if geo::ring_contains(&o.iter().map(|p| to_mm(*p)).collect::<Vec<_>>(), to_mm(polys[h][0])) {
                keep[h] = false;
                break;
            }
        }
    }
    let mut i = 0;
    polys.retain(|_| {
        let k = keep[i];
        i += 1;
        k
    });
}

fn angle_left(a: Pt, b: Pt, c: Pt) -> f32 {
    let ba = sub(a, b);
    let bc = sub(c, b);
    let dott = dot(ba, bc);
    let det = cross(ba, bc);
    if det == 0 {
        if (ba[0] != 0 && (ba[0] > 0) == (bc[0] > 0)) || (ba[0] == 0 && (ba[1] > 0) == (bc[1] > 0)) {
            return 0.0;
        }
        return PI as f32;
    }
    let angle = -(det as f64).atan2(dott as f64) as f32;
    if angle >= 0.0 {
        angle
    } else {
        (PI * 2.0) as f32 + angle
    }
}

fn remove_colinear_edges_poly(poly: &mut Ring, max_deviation_angle: f64) {
    loop {
        let mut num_removed_in_iteration = 0usize;
        let mut process_indices: Vec<bool> = vec![true; poly.len()];
        let mut go = true;
        while go {
            go = false;
            let rpath = poly.clone();
            let pathlen = rpath.len();
            if pathlen <= 3 {
                return;
            }
            let mut skip_indices: Vec<bool> = vec![false; poly.len()];
            let mut new_path: Ring = vec![];
            let mut point_idx = 0usize;
            while point_idx < pathlen {
                if !process_indices[point_idx] {
                    new_path.push(rpath[point_idx]);
                    point_idx += 1;
                    continue;
                }
                if point_idx == pathlen - 1 && skip_indices[0] {
                    let l = new_path.len();
                    if l < skip_indices.len() {
                        skip_indices[l] = true;
                    }
                    go = true;
                    new_path.push(rpath[point_idx]);
                    break;
                }
                let prev = rpath[(point_idx + pathlen - 1) % pathlen];
                let pt = rpath[point_idx];
                let next = rpath[(point_idx + 1) % pathlen];
                let mut angle = angle_left(prev, pt, next);
                if angle >= PI as f32 {
                    angle -= PI as f32;
                }
                if angle as f64 > max_deviation_angle && (angle as f64) < PI - max_deviation_angle {
                    new_path.push(pt);
                } else if point_idx != pathlen - 1 {
                    let l = new_path.len();
                    if l < skip_indices.len() {
                        skip_indices[l] = true;
                    }
                    go = true;
                    new_path.push(next);
                    point_idx += 1;
                }
                point_idx += 1;
            }
            *poly = new_path;
            num_removed_in_iteration += pathlen - poly.len();
            process_indices = skip_indices;
        }
        if num_removed_in_iteration == 0 {
            break;
        }
    }
}

fn remove_colinear_edges(polys: &mut Vec<Ring>, max_deviation_angle: f64) {
    let mut p = 0;
    while p < polys.len() {
        remove_colinear_edges_poly(&mut polys[p], max_deviation_angle);
        if polys[p].len() < 3 {
            polys.remove(p);
        } else {
            p += 1;
        }
    }
}

// =====================================================================================================================
// extrusion lines
// =====================================================================================================================
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Junction {
    pub p: Pt,
    pub w: i64,
    pub perimeter_index: usize,
}

#[derive(Clone, Debug)]
pub struct ExtrusionLine {
    pub inset_idx: usize,
    pub is_odd: bool,
    pub is_closed: bool,
    pub junctions: Vec<Junction>,
}
impl ExtrusionLine {
    pub fn new(inset_idx: usize, is_odd: bool) -> Self {
        ExtrusionLine { inset_idx, is_odd, is_closed: false, junctions: vec![] }
    }
    pub fn length(&self) -> i64 {
        if self.junctions.is_empty() {
            return 0;
        }
        let mut len = 0;
        let mut prev = self.junctions[0].p;
        for j in &self.junctions {
            len += dist_i(j.p, prev);
            prev = j.p;
        }
        if self.is_closed {
            len += dist_i(self.junctions[0].p, self.junctions.last().unwrap().p);
        }
        len
    }
    /// `ExtrusionLine::is_contour`: closed and clockwise (Arachne emits contours clockwise, holes counter-clockwise).
    pub fn is_contour(&self) -> bool {
        if !self.is_closed {
            return false;
        }
        let pts: Ring = self.junctions.iter().map(|j| j.p).collect();
        ring_area_i(&pts) < 0.0 // clockwise (Clipper Area is positive for CCW)
    }
    fn calc_area_deviation_error(a: &Junction, b: &Junction, c: &Junction) -> i64 {
        let ab_length = dist_i(b.p, a.p);
        let bc_length = dist_i(c.p, b.p);
        let width_diff = (b.w - a.w).abs().max((c.w - b.w).abs());
        if width_diff > 1 {
            let ab_weight = (a.w + b.w) / 2;
            let bc_weight = (b.w + c.w) / 2;
            let weighted_average_width = (ab_length * ab_weight + bc_length * bc_weight) / (ab_length + bc_length).max(1);
            let ac_length = dist_i(c.p, a.p);
            ((ab_weight * ab_length + bc_weight * bc_length) - (weighted_average_width * ac_length)).abs()
        } else if ab_length > bc_length {
            width_diff * bc_length
        } else {
            width_diff * ab_length
        }
    }
    /// `ExtrusionLine::simplify`
    pub fn simplify(&mut self, smallest_line_segment_squared: i64, allowed_error_distance_squared: i64, maximum_extrusion_area_deviation: i64) {
        let min_path_size = if self.is_closed { 3 } else { 2 };
        let jn = &self.junctions;
        if jn.len() <= min_path_size {
            return;
        }
        let mut new_junctions: Vec<Junction> = vec![jn[0]];
        let mut previous = jn[0];
        let mut previous_previous = if self.is_closed { jn[jn.len() - 2] } else { jn[0] };
        let initial = jn[1];
        let mut accumulated_area_removed: i64 = previous.p[0] * initial.p[1] - previous.p[1] * initial.p[0];
        let tiny2 = 5000i64 * 5000i64;
        let end = jn.len() - if self.is_closed { 0 } else { 1 };
        let mut junctions = self.junctions.clone();
        let mut point_idx = 1usize;
        while point_idx < end {
            let is_last = point_idx + 1 == junctions.len();
            let current = if is_last { new_junctions[0] } else { junctions[point_idx] };
            if self.is_closed && new_junctions.len() + (junctions.len() - point_idx) <= 3 {
                new_junctions.push(current);
                point_idx += 1;
                continue;
            }
            let spill_over = self.is_closed && point_idx + 2 >= junctions.len() && point_idx + 2 - junctions.len() < new_junctions.len();
            let next = if spill_over { new_junctions[point_idx + 2 - junctions.len()] } else { junctions[(point_idx + 1).min(junctions.len() - 1)] };
            let removed_area_next = current.p[0] * next.p[1] - current.p[1] * next.p[0];
            let negative_area_closing = next.p[0] * previous.p[1] - next.p[1] * previous.p[0];
            accumulated_area_removed += removed_area_next;
            let d = sub(current.p, previous.p);
            let length2 = d[0] * d[0] + d[1] * d[1];
            if length2 < tiny2 {
                point_idx += 1;
                continue;
            }
            let area_removed_so_far = accumulated_area_removed + negative_area_closing;
            let bd = sub(next.p, previous.p);
            let base_length_2 = bd[0] * bd[0] + bd[1] * bd[1];
            if base_length_2 == 0 {
                point_idx += 1;
                continue;
            }
            let height_2 = (area_removed_so_far as f64 * area_removed_so_far as f64 / base_length_2 as f64) as i64;
            let extrusion_area_error = Self::calc_area_deviation_error(&previous, &current, &next);
            if height_2 <= tiny2 && dist_to_infinite(current.p, previous.p, next.p) <= 5000.0 && extrusion_area_error <= maximum_extrusion_area_deviation {
                point_idx += 1;
                continue;
            }
            if length2 < smallest_line_segment_squared && height_2 <= allowed_error_distance_squared {
                let nd = sub(current.p, next.p);
                let next_length2 = nd[0] * nd[0] + nd[1] * nd[1];
                if next_length2 > 4 * smallest_line_segment_squared {
                    let ip = intersection_infinite(previous_previous.p, previous.p, current.p, next.p);
                    let dist_greater = |p1: Pt, p2: Pt, threshold: i64| -> bool {
                        let v = [(p1[0] - p2[0]).unsigned_abs(), (p1[1] - p2[1]).unsigned_abs()];
                        if v[0] > threshold as u64 || v[1] > threshold as u64 {
                            return true;
                        }
                        (v[0] * v[0] + v[1] * v[1]) as i64 > threshold
                    };
                    let bad = match ip {
                        None => true,
                        Some(ip) => dist_infinite_sq(ip, previous.p, current.p).0 > allowed_error_distance_squared as f64 || dist_greater(ip, previous.p, smallest_line_segment_squared) || dist_greater(ip, current.p, smallest_line_segment_squared),
                    };
                    if !bad {
                        let new_to_add = Junction { p: ip.unwrap(), w: current.w, perimeter_index: current.perimeter_index };
                        if !new_junctions.is_empty() {
                            new_junctions.pop();
                            previous = previous_previous;
                        }
                        accumulated_area_removed = removed_area_next;
                        previous_previous = previous;
                        previous = new_to_add;
                        new_junctions.push(new_to_add);
                        point_idx += 1;
                        continue;
                    }
                } else {
                    point_idx += 1;
                    continue;
                }
            }
            accumulated_area_removed = removed_area_next;
            previous_previous = previous;
            previous = current;
            new_junctions.push(current);
            point_idx += 1;
        }
        if self.is_closed {
            let last = new_junctions.last().unwrap().p;
            new_junctions[0].p = last;
        } else {
            new_junctions.push(*junctions.last().unwrap());
        }
        junctions.clear();
        self.junctions = new_junctions;
    }
}
pub type VariableWidthLines = Vec<ExtrusionLine>;

// =====================================================================================================================
// the skeletal trapezoidation graph (SkeletalTrapezoidationGraph / Edge / Joint) as an index arena
// =====================================================================================================================
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EdgeType {
    Normal,
    ExtraVd,
    TransitionEnd,
}
#[derive(Clone, Debug)]
struct TMid {
    pos: i64,
    lower_bead_count: i64,
    feature_radius: i64,
    id: u64,
}
#[derive(Clone, Debug)]
struct TEnd {
    pos: i64,
    lower_bead_count: i64,
    is_lower_end: bool,
}
#[derive(Clone)]
struct BeadingProp {
    beading: Beading,
    dist_to_bottom_source: i64,
    dist_from_top_source: i64,
    is_upward_propagated_only: bool,
}
impl BeadingProp {
    fn new(b: Beading) -> Self {
        BeadingProp { beading: b, dist_to_bottom_source: 0, dist_from_top_source: 0, is_upward_propagated_only: false }
    }
}

#[derive(Clone)]
struct Node {
    p: Pt,
    dist: i64,
    bead_count: i64,
    transition_ratio: f32,
    incident_edge: Option<usize>,
    beading: Option<usize>,
    key: i64,
    alive: bool,
}
#[derive(Clone)]
struct Edge {
    from: usize,
    to: usize,
    twin: Option<usize>,
    next: Option<usize>,
    prev: Option<usize>,
    ty: EdgeType,
    central: i8, // -1 unknown, 0 no, 1 yes
    transitions: Option<Vec<TMid>>,
    transition_ends: Option<Vec<TEnd>>,
    junctions: Option<Vec<Junction>>,
    key: i64,
    alive: bool,
}

#[derive(Default)]
struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    front_key: i64,
    back_key: i64,
}

impl Graph {
    fn new_node(&mut self, p: Pt, front: bool) -> usize {
        let key = if front {
            self.front_key -= 1;
            self.front_key
        } else {
            self.back_key += 1;
            self.back_key
        };
        self.nodes.push(Node { p, dist: -1, bead_count: -1, transition_ratio: 0.0, incident_edge: None, beading: None, key, alive: true });
        self.nodes.len() - 1
    }
    fn new_edge(&mut self, ty: EdgeType, front: bool) -> usize {
        let key = if front {
            self.front_key -= 1;
            self.front_key
        } else {
            self.back_key += 1;
            self.back_key
        };
        self.edges.push(Edge { from: usize::MAX, to: usize::MAX, twin: None, next: None, prev: None, ty, central: -1, transitions: None, transition_ends: None, junctions: None, key, alive: true });
        self.edges.len() - 1
    }
    /// Edge ids in `std::list` order (emplace_front items most recent first, then emplace_back items in order).
    fn edge_order(&self) -> Vec<usize> {
        let mut v: Vec<usize> = (0..self.edges.len()).filter(|&i| self.edges[i].alive).collect();
        v.sort_by_key(|&i| self.edges[i].key);
        v
    }
    fn node_order(&self) -> Vec<usize> {
        let mut v: Vec<usize> = (0..self.nodes.len()).filter(|&i| self.nodes[i].alive).collect();
        v.sort_by_key(|&i| self.nodes[i].key);
        v
    }
    #[inline]
    fn tw(&self, e: usize) -> usize {
        self.edges[e].twin.expect("edge without twin")
    }
    #[inline]
    fn len(&self, e: usize) -> i64 {
        dist_i(self.nodes[self.edges[e].to].p, self.nodes[self.edges[e].from].p)
    }
    #[inline]
    fn to_dist(&self, e: usize) -> i64 {
        self.nodes[self.edges[e].to].dist
    }
    #[inline]
    fn from_dist(&self, e: usize) -> i64 {
        self.nodes[self.edges[e].from].dist
    }
    fn is_central(&self, e: usize) -> bool {
        self.edges[e].central == 1
    }
    fn central_is_set(&self, e: usize) -> bool {
        self.edges[e].central != -1
    }
    fn set_central(&mut self, e: usize, b: bool) {
        self.edges[e].central = if b { 1 } else { 0 };
    }
    fn has_transitions(&self, e: usize, ignore_empty: bool) -> bool {
        match &self.edges[e].transitions {
            Some(v) => ignore_empty || !v.is_empty(),
            None => false,
        }
    }
    fn has_transition_ends(&self, e: usize, ignore_empty: bool) -> bool {
        match &self.edges[e].transition_ends {
            Some(v) => ignore_empty || !v.is_empty(),
            None => false,
        }
    }

    // ---- STHalfEdge
    fn can_go_up(&self, e: usize, strict: bool) -> bool {
        if self.to_dist(e) > self.from_dist(e) {
            return true;
        }
        if self.to_dist(e) < self.from_dist(e) || strict {
            return false;
        }
        let twin = self.edges[e].twin;
        let mut o = self.edges[e].next;
        while let Some(oi) = o {
            if Some(oi) == twin {
                break;
            }
            if self.can_go_up(oi, false) {
                return true;
            }
            let Some(ot) = self.edges[oi].twin else { return false };
            match self.edges[ot].next {
                None => return true,
                Some(n) => o = Some(n),
            }
        }
        false
    }
    fn dist_to_go_up(&self, e: usize) -> Option<i64> {
        if self.to_dist(e) > self.from_dist(e) {
            return Some(0);
        }
        if self.to_dist(e) < self.from_dist(e) {
            return None;
        }
        let mut ret: Option<i64> = None;
        let twin = self.edges[e].twin;
        let mut o = self.edges[e].next;
        while let Some(oi) = o {
            if Some(oi) == twin {
                break;
            }
            if let Some(d) = self.dist_to_go_up(oi) {
                ret = Some(match ret {
                    Some(r) => r.min(d),
                    None => d,
                });
            }
            let Some(ot) = self.edges[oi].twin else { return None };
            match self.edges[ot].next {
                None => return Some(0),
                Some(n) => o = Some(n),
            }
        }
        ret.map(|r| r + self.len(e))
    }
    fn is_upward(&self, e: usize) -> bool {
        if self.to_dist(e) > self.from_dist(e) {
            return true;
        }
        if self.to_dist(e) < self.from_dist(e) {
            return false;
        }
        let fwd = self.dist_to_go_up(e);
        let bwd = self.dist_to_go_up(self.tw(e));
        if let (Some(f), Some(b)) = (fwd, bwd) {
            return f < b;
        }
        if fwd.is_some() {
            return true;
        }
        if bwd.is_some() {
            return false;
        }
        let (to, from) = (self.nodes[self.edges[e].to].p, self.nodes[self.edges[e].from].p);
        to < from // lexicographic like Eigen `operator<` on Points (x then y)
    }
    fn get_next_unconnected(&self, e: usize) -> Option<usize> {
        let mut result = e;
        while let Some(n) = self.edges[result].next {
            result = n;
            if result == e {
                return None;
            }
        }
        self.edges[result].twin
    }
    // ---- STHalfEdgeNode
    fn is_multi_intersection(&self, n: usize) -> bool {
        let Some(inc) = self.nodes[n].incident_edge else { return false };
        let mut odd = 0;
        let mut o = inc;
        loop {
            if self.is_central(o) {
                odd += 1;
            }
            let Some(t) = self.edges[o].twin else { return false };
            match self.edges[t].next {
                None => return false,
                Some(nx) => o = nx,
            }
            if o == inc {
                break;
            }
        }
        odd > 2
    }
    fn node_is_central(&self, n: usize) -> bool {
        let Some(inc) = self.nodes[n].incident_edge else { return false };
        let mut e = inc;
        loop {
            if self.is_central(e) {
                return true;
            }
            let Some(t) = self.edges[e].twin else { return false };
            match self.edges[t].next {
                None => return false,
                Some(nx) => e = nx,
            }
            if e == inc {
                break;
            }
        }
        false
    }
    fn is_local_maximum(&self, n: usize, strict: bool) -> bool {
        if self.nodes[n].dist == 0 {
            return false;
        }
        let Some(inc) = self.nodes[n].incident_edge else { return false };
        let mut e = inc;
        loop {
            if self.can_go_up(e, strict) {
                return false;
            }
            let Some(t) = self.edges[e].twin else { return false };
            match self.edges[t].next {
                None => return false, // on the boundary
                Some(nx) => e = nx,
            }
            if e == inc {
                break;
            }
        }
        true
    }

    // ---- graph operations
    fn make_rib(&mut self, prev_edge: &mut usize, start_source: Pt, end_source: Pt) {
        let to = self.edges[*prev_edge].to;
        let (_, p) = dist_infinite_sq(self.nodes[to].p, start_source, end_source);
        let dist = dist_i(self.nodes[to].p, p);
        self.nodes[to].dist = dist;
        let node = self.new_node(p, true);
        self.nodes[node].dist = 0;
        let forth = self.new_edge(EdgeType::ExtraVd, true);
        let back = self.new_edge(EdgeType::ExtraVd, true);
        self.edges[*prev_edge].next = Some(forth);
        self.edges[forth].prev = Some(*prev_edge);
        self.edges[forth].from = to;
        self.edges[forth].to = node;
        self.edges[forth].twin = Some(back);
        self.edges[back].twin = Some(forth);
        self.edges[back].from = node;
        self.edges[back].to = to;
        self.nodes[node].incident_edge = Some(back);
        *prev_edge = back;
    }

    fn get_source(&self, e: usize) -> (Pt, Pt) {
        let mut from_edge = e;
        while let Some(p) = self.edges[from_edge].prev {
            from_edge = p;
        }
        let mut to_edge = e;
        while let Some(n) = self.edges[to_edge].next {
            to_edge = n;
        }
        (self.nodes[self.edges[from_edge].from].p, self.nodes[self.edges[to_edge].to].p)
    }

    fn insert_rib(&mut self, edge: usize, mid_node: usize) -> (usize, usize) {
        let edge_before = self.edges[edge].prev;
        let edge_after = self.edges[edge].next;
        let node_before = self.edges[edge].from;
        let node_after = self.edges[edge].to;
        let p = self.nodes[mid_node].p;
        let (sa, sb) = self.get_source(edge);
        // source_segment.distance_to_squared(p, &px): closest point on the SEGMENT
        let px = closest_on_segment(p, sa, sb);
        let dist = dist_i(p, px);
        self.nodes[mid_node].dist = dist;
        self.nodes[mid_node].transition_ratio = 0.0;
        let source_node = self.new_node(px, false);
        self.nodes[source_node].dist = 0;
        let first = edge;
        let second = self.new_edge(EdgeType::Normal, false);
        let outward = self.new_edge(EdgeType::TransitionEnd, false);
        let inward = self.new_edge(EdgeType::TransitionEnd, false);
        if let Some(eb) = edge_before {
            self.edges[eb].next = Some(first);
        }
        self.edges[first].next = Some(outward);
        self.edges[outward].next = None;
        self.edges[inward].next = Some(second);
        self.edges[second].next = edge_after;
        if let Some(ea) = edge_after {
            self.edges[ea].prev = Some(second);
        }
        self.edges[second].prev = Some(inward);
        self.edges[inward].prev = None;
        self.edges[outward].prev = Some(first);
        self.edges[first].prev = edge_before;
        self.edges[first].to = mid_node;
        self.edges[outward].to = source_node;
        self.edges[inward].to = mid_node;
        self.edges[second].to = node_after;
        self.edges[first].from = node_before;
        self.edges[outward].from = mid_node;
        self.edges[inward].from = source_node;
        self.edges[second].from = mid_node;
        self.nodes[node_before].incident_edge = Some(first);
        self.nodes[mid_node].incident_edge = Some(outward);
        self.nodes[source_node].incident_edge = Some(inward);
        if let Some(ea) = edge_after {
            self.nodes[node_after].incident_edge = Some(ea);
        }
        self.set_central(first, true);
        self.set_central(outward, false);
        self.set_central(inward, false);
        self.set_central(second, true);
        self.edges[outward].twin = Some(inward);
        self.edges[inward].twin = Some(outward);
        self.edges[first].twin = None;
        self.edges[second].twin = None;
        (first, second)
    }

    fn insert_node(&mut self, edge: usize, mid: Pt, mid_node_bead_count: i64) -> usize {
        let mid_node = self.new_node(mid, false);
        let twin = self.tw(edge);
        self.edges[edge].twin = None;
        self.edges[twin].twin = None;
        let left = self.insert_rib(edge, mid_node);
        let right = self.insert_rib(twin, mid_node);
        let (first_in, last_in) = left;
        let (first_tw, last_tw) = right;
        self.edges[first_in].twin = Some(last_tw);
        self.edges[last_tw].twin = Some(first_in);
        self.edges[last_in].twin = Some(first_tw);
        self.edges[first_tw].twin = Some(last_in);
        self.nodes[mid_node].bead_count = mid_node_bead_count;
        last_in
    }

    fn collapse_small_edges(&mut self, snap_dist: i64) {
        let should_collapse = |g: &Graph, a: usize, b: usize| shorter_then(sub(g.nodes[a].p, g.nodes[b].p), snap_dist);
        let order = self.edge_order();
        for eid in order {
            if !self.edges[eid].alive {
                continue;
            }
            if self.edges[eid].prev.is_some() {
                continue;
            }
            let quad_start = eid;
            let mut quad_end = quad_start;
            while let Some(n) = self.edges[quad_end].next {
                quad_end = n;
            }
            let quad_mid = if self.edges[quad_start].next == Some(quad_end) { None } else { self.edges[quad_start].next };
            if let Some(qm) = quad_mid {
                let (qm_from, qm_to) = (self.edges[qm].from, self.edges[qm].to);
                if should_collapse(self, qm_from, qm_to) {
                    let Some(qm_twin) = self.edges[qm].twin else { continue };
                    let mut count = 0;
                    let mut edge_from_3 = Some(quad_end);
                    while let Some(ef) = edge_from_3 {
                        if ef == qm_twin {
                            break;
                        }
                        self.edges[ef].from = qm_from;
                        let t = self.tw(ef);
                        self.edges[t].to = qm_from;
                        count += 1;
                        if count > 1000 {
                            break;
                        }
                        edge_from_3 = self.edges[t].next;
                    }
                    if self.nodes[qm_from].incident_edge == Some(qm) {
                        if let Some(n) = self.edges[qm_twin].next {
                            self.nodes[qm_from].incident_edge = Some(n);
                        } else {
                            let pv = self.edges[qm].prev.unwrap();
                            self.nodes[qm_from].incident_edge = self.edges[pv].twin;
                        }
                    }
                    self.nodes[qm_to].alive = false;
                    let (qm_prev, qm_next) = (self.edges[qm].prev.unwrap(), self.edges[qm].next.unwrap());
                    self.edges[qm_prev].next = Some(qm_next);
                    self.edges[qm_next].prev = Some(qm_prev);
                    let (tn, tp) = (self.edges[qm_twin].next.unwrap(), self.edges[qm_twin].prev.unwrap());
                    self.edges[tn].prev = Some(tp);
                    self.edges[tp].next = Some(tn);
                    self.edges[qm_twin].alive = false;
                    self.edges[qm].alive = false;
                }
            }
            // collapse sides
            let (qs_from, qs_to) = (self.edges[quad_start].from, self.edges[quad_start].to);
            let (qe_from, qe_to) = (self.edges[quad_end].from, self.edges[quad_end].to);
            if should_collapse(self, qs_from, qe_to) && should_collapse(self, qs_to, qe_from) {
                let qs_twin = self.tw(quad_start);
                let qe_twin = self.tw(quad_end);
                self.edges[qs_twin].to = qe_to;
                self.nodes[qe_to].incident_edge = Some(qe_twin);
                if self.nodes[qe_from].incident_edge == Some(quad_end) {
                    if let Some(n) = self.edges[qe_twin].next {
                        self.nodes[qe_from].incident_edge = Some(n);
                    } else {
                        let pv = self.edges[quad_end].prev.unwrap();
                        self.nodes[qe_from].incident_edge = self.edges[pv].twin;
                    }
                }
                self.nodes[qs_from].alive = false;
                self.edges[qs_twin].twin = Some(qe_twin);
                self.edges[qe_twin].twin = Some(qs_twin);
                self.edges[quad_start].alive = false;
                self.edges[quad_end].alive = false;
            }
        }
    }
}

// =====================================================================================================================
// SkeletalTrapezoidation
// =====================================================================================================================
use crate::walls::voro;
use std::collections::BTreeMap;

struct Polygons<'a> {
    polys: &'a Vec<Ring>,
    /// (poly index, point index): one entry per polygon edge, in polygon order, exactly like `PolygonsSegmentIndex`.
    segs: Vec<(usize, usize)>,
}
impl<'a> Polygons<'a> {
    fn new(polys: &'a Vec<Ring>) -> Self {
        let mut segs = vec![];
        for (pi, r) in polys.iter().enumerate() {
            for i in 0..r.len() {
                segs.push((pi, i));
            }
        }
        Polygons { polys, segs }
    }
    fn from(&self, s: usize) -> Pt {
        let (p, i) = self.segs[s];
        self.polys[p][i]
    }
    fn to(&self, s: usize) -> Pt {
        let (p, i) = self.segs[s];
        self.polys[p][(i + 1) % self.polys[p].len()]
    }
    fn prev_of(&self, s: usize) -> Pt {
        let (p, i) = self.segs[s];
        let n = self.polys[p].len();
        self.polys[p][(i + n - 1) % n]
    }
    fn next_next(&self, s: usize) -> Pt {
        let (p, i) = self.segs[s];
        let n = self.polys[p].len();
        self.polys[p][(i + 2) % n]
    }
}

/// `Geometry::is_point_inside_polygon_corner`
fn is_point_inside_polygon_corner(a: Pt, b: Pt, c: Pt, q: Pt) -> bool {
    let norm = |v: Pt| -> [f64; 2] {
        let n = (v[0] as f64).hypot(v[1] as f64);
        [v[0] as f64 / n, v[1] as f64 / n]
    };
    let ba = norm(sub(a, b));
    let bc = norm(sub(c, b));
    let bq = norm(sub(q, b));
    let bq_left_normal = [-bq[1], bq[0]];
    let dotf = |x: [f64; 2], y: [f64; 2]| x[0] * y[0] + x[1] * y[1];
    let proj_a_on_bq_normal = dotf(ba, bq_left_normal);
    let proj_c_on_bq_normal = dotf(bc, bq_left_normal);
    if (proj_a_on_bq_normal > 0.0 && proj_c_on_bq_normal <= 0.0) || (proj_a_on_bq_normal <= 0.0 && proj_c_on_bq_normal > 0.0) {
        proj_a_on_bq_normal > 0.0
    } else {
        let proj_a_on_bq = dotf(ba, bq);
        let proj_c_on_bq = dotf(bc, bq);
        (proj_a_on_bq_normal > 0.0 && proj_c_on_bq < proj_a_on_bq) || (proj_a_on_bq_normal <= 0.0 && proj_c_on_bq >= proj_a_on_bq)
    }
}

pub struct Skeleton<'a> {
    g: Graph,
    bs: &'a dyn BeadingStrategy,
    transitioning_angle: f64,
    discretization_step_size: i64,
    transition_filter_dist: i64,
    allowed_filter_deviation: i64,
    beading_propagation_transition_dist: i64,
    snap_dist: i64,
    beadings: Vec<BeadingProp>,
    toolpaths: Vec<VariableWidthLines>,
    next_tid: u64,
}

struct CellRange {
    start_pt: Pt,
    end_pt: Pt,
    edge_begin: Option<usize>,
    edge_end: Option<usize>,
}

impl<'a> Skeleton<'a> {
    pub fn new(
        polys: &Vec<Ring>,
        bs: &'a dyn BeadingStrategy,
        transitioning_angle: f64,
        discretization_step_size: i64,
        transition_filter_dist: i64,
        allowed_filter_deviation: i64,
        beading_propagation_transition_dist: i64,
    ) -> Result<Skeleton<'a>, FdmError> {
        let mut s = Skeleton {
            g: Graph::default(),
            bs,
            transitioning_angle,
            discretization_step_size,
            transition_filter_dist,
            allowed_filter_deviation,
            beading_propagation_transition_dist,
            snap_dist: 20_000,
            beadings: vec![],
            toolpaths: vec![],
            next_tid: 0,
        };
        s.construct_from_polygons(polys)?;
        Ok(s)
    }

    fn vd_point(vd: &voro::Vd, v: usize) -> Pt {
        let p = vd.verts[v];
        [p[0].round() as i64, p[1].round() as i64]
    }

    fn discretize(&self, vd: &voro::Vd, polys: &Polygons, e: usize) -> Vec<Pt> {
        let edge = &vd.edges[e];
        let left_cell = edge.cell;
        let right_cell = vd.edges[edge.twin].cell;
        let start = Self::vd_point(vd, edge.v0.unwrap());
        let end = Self::vd_point(vd, vd.v1(e).unwrap());
        let point_left = vd.cells[left_cell].cat != voro::Src::Segment;
        let point_right = vd.cells[right_cell].cat != voro::Src::Segment;
        let source_point = |c: usize| -> Pt {
            let cell = &vd.cells[c];
            if cell.cat == voro::Src::Start {
                polys.from(cell.src)
            } else {
                polys.to(cell.src)
            }
        };
        if (!point_left && !point_right) || !edge.primary {
            return vec![start, end];
        } else if point_left != point_right {
            let p = source_point(if point_left { left_cell } else { right_cell });
            let sc_ = vd.cells[if point_left { right_cell } else { left_cell }].src;
            return self.discretize_parabola(p, polys.from(sc_), polys.to(sc_), start, end);
        } else {
            let left_point = source_point(left_cell);
            let right_point = source_point(right_cell);
            let d = norm_i(sub(right_point, left_point));
            let middle = [(left_point[0] + right_point[0]) / 2, (left_point[1] + right_point[1]) / 2];
            let x_axis_dir = perp(sub(right_point, left_point));
            let x_axis_length = norm_i(x_axis_dir);
            let projected_x = |from: Pt| -> i64 {
                let vec = sub(from, middle);
                dot(vec, x_axis_dir) / x_axis_length
            };
            let start_x = projected_x(start);
            let end_x = projected_x(end);
            let bound = (0.5 / ((PI - self.transitioning_angle) * 0.5).tan()) as f32;
            let mut marking_start_x: i64 = (-(d as f32) * bound) as i64;
            let mut marking_end_x: i64 = (d as f32 * bound) as i64;
            let mut marking_start = add(middle, [x_axis_dir[0] * marking_start_x / x_axis_length, x_axis_dir[1] * marking_start_x / x_axis_length]);
            let mut marking_end = add(middle, [x_axis_dir[0] * marking_end_x / x_axis_length, x_axis_dir[1] * marking_end_x / x_axis_length]);
            let mut direction: i64 = 1;
            if start_x > end_x {
                direction = -1;
                std::mem::swap(&mut marking_start, &mut marking_end);
                std::mem::swap(&mut marking_start_x, &mut marking_end_x);
            }
            let a = start;
            let b = end;
            let mut ret = vec![a];
            let mut add_marking_start = marking_start_x * direction > start_x * direction;
            let mut add_marking_end = marking_end_x * direction > start_x * direction;
            let ab = sub(b, a);
            let ab_size = norm_i(ab);
            let mut step_count = (ab_size + self.discretization_step_size / 2) / self.discretization_step_size;
            if step_count % 2 == 1 {
                step_count += 1;
            }
            for step in 1..step_count {
                let here = [a[0] + ab[0] * step / step_count, a[1] + ab[1] * step / step_count];
                let x_here = projected_x(here);
                if add_marking_start && marking_start_x * direction < x_here * direction {
                    ret.push(marking_start);
                    add_marking_start = false;
                }
                if add_marking_end && marking_end_x * direction < x_here * direction {
                    ret.push(marking_end);
                    add_marking_end = false;
                }
                ret.push(here);
            }
            if add_marking_end && marking_end_x * direction < end_x * direction {
                ret.push(marking_end);
            }
            ret.push(b);
            ret
        }
    }

    /// `VoronoiUtils::discretize_parabola`
    fn discretize_parabola(&self, source_point: Pt, a: Pt, b: Pt, start: Pt, end: Pt) -> Vec<Pt> {
        let ab = sub(b, a);
        let as_ = sub(start, a);
        let ae = sub(end, a);
        let ab_size = norm_i(ab);
        let sx = dot(as_, ab) / ab_size;
        let ex = dot(ae, ab) / ab_size;
        let sxex = ex - sx;
        let ap = sub(source_point, a);
        let px = dot(ap, ab) / ab_size;
        let (_, pxx) = dist_infinite_sq(source_point, a, b);
        let ppxx = sub(pxx, source_point);
        let d = norm_i(ppxx);
        let rot_len = (ppxx[0] as f64).hypot(ppxx[1] as f64);
        // rot = perp(ppxx).normalized()
        let (rot_cos, rot_sin) = (-(ppxx[1] as f64) / rot_len, ppxx[0] as f64 / rot_len);
        if d == 0 {
            return vec![start, end];
        }
        let rotated = |x: i64, y: i64| -> Pt { [(rot_cos * x as f64 - rot_sin * y as f64).round() as i64, (rot_cos * y as f64 + rot_sin * x as f64).round() as i64] };
        let marking_bound = (self.transitioning_angle * 0.5).atan();
        let mut msx: i64 = (-marking_bound * d as f64) as i64;
        let mut mex: i64 = (marking_bound * d as f64) as i64;
        let marking_start_end_h = msx * msx / (2 * d) + d / 2;
        let mut marking_start = add(rotated(msx, marking_start_end_h), pxx);
        let mut marking_end = add(rotated(mex, marking_start_end_h), pxx);
        let dir: i64 = if sx > ex { -1 } else { 1 };
        if dir < 0 {
            std::mem::swap(&mut marking_start, &mut marking_end);
            std::mem::swap(&mut msx, &mut mex);
        }
        let mut add_marking_start = msx * dir > (sx - px) * dir && msx * dir < (ex - px) * dir;
        let mut add_marking_end = mex * dir > (sx - px) * dir && mex * dir < (ex - px) * dir;
        let apex = add(rotated(0, d / 2), pxx);
        let mut add_apex = (sx - px) * dir < 0 && (ex - px) * dir > 0;
        let step_count = ((ex - sx).abs() as f64 / self.discretization_step_size as f64).round() as i64;
        let mut discretized = vec![start];
        for step in 1..step_count {
            let x = sx + sxex * step / step_count - px;
            let y = x * x / (2 * d) + d / 2;
            if add_marking_start && msx * dir < x * dir {
                discretized.push(marking_start);
                add_marking_start = false;
            }
            if add_apex && x * dir > 0 {
                discretized.push(apex);
                add_apex = false;
            }
            if add_marking_end && mex * dir < x * dir {
                discretized.push(marking_end);
                add_marking_end = false;
            }
            discretized.push(add(rotated(x, y), pxx));
        }
        if add_apex {
            discretized.push(apex);
        }
        if add_marking_end {
            discretized.push(marking_end);
        }
        discretized.push(end);
        discretized
    }

    fn make_node(&mut self, map: &mut BTreeMap<usize, usize>, vd_vertex: usize, p: Pt) -> usize {
        if let Some(&n) = map.get(&vd_vertex) {
            return n;
        }
        let n = self.g.new_node(p, true);
        map.insert(vd_vertex, n);
        n
    }

    #[allow(clippy::too_many_arguments)]
    fn transfer_edge(
        &mut self,
        vd: &voro::Vd,
        polys: &Polygons,
        from: Pt,
        to: Pt,
        vd_edge: usize,
        prev_edge: &mut Option<usize>,
        start_source: Pt,
        end_source: Pt,
        edge_map: &mut BTreeMap<usize, usize>,
        node_map: &mut BTreeMap<usize, usize>,
    ) {
        let vd_twin = vd.edges[vd_edge].twin;
        if let Some(&source_twin) = edge_map.get(&vd_twin) {
            let Some(&end_node) = vd.v1(vd_edge).and_then(|v| node_map.get(&v)) else { return };
            let mut twin = source_twin;
            loop {
                let edge = self.g.new_edge(EdgeType::Normal, true);
                self.g.edges[edge].from = self.g.edges[twin].to;
                self.g.edges[edge].to = self.g.edges[twin].from;
                self.g.edges[edge].twin = Some(twin);
                self.g.edges[twin].twin = Some(edge);
                let f = self.g.edges[edge].from;
                self.g.nodes[f].incident_edge = Some(edge);
                if let Some(pe) = *prev_edge {
                    self.g.edges[edge].prev = Some(pe);
                    self.g.edges[pe].next = Some(edge);
                }
                *prev_edge = Some(edge);
                if self.g.edges[edge].to == end_node {
                    return;
                }
                let Some(tp) = self.g.edges[twin].prev else { return };
                let Some(tpt) = self.g.edges[tp].twin else { return };
                let Some(tptp) = self.g.edges[tpt].prev else { return };
                let mut pe = prev_edge.unwrap();
                self.g.make_rib(&mut pe, start_source, end_source);
                *prev_edge = Some(pe);
                twin = tptp;
            }
        } else {
            let discretized = self.discretize(vd, polys, vd_edge);
            let v0 = match *prev_edge {
                Some(pe) => self.g.edges[pe].to,
                None => {
                    let v = vd.edges[vd_edge].v0.unwrap();
                    self.make_node(node_map, v, from)
                }
            };
            let mut v0 = v0;
            for p1_idx in 1..discretized.len() {
                let p1 = discretized[p1_idx];
                let v1 = if p1_idx < discretized.len() - 1 {
                    self.g.new_node(p1, true)
                } else {
                    let v = vd.v1(vd_edge).unwrap();
                    self.make_node(node_map, v, to)
                };
                let edge = self.g.new_edge(EdgeType::Normal, true);
                self.g.edges[edge].from = v0;
                self.g.edges[edge].to = v1;
                self.g.nodes[v0].incident_edge = Some(edge);
                if let Some(pe) = *prev_edge {
                    self.g.edges[edge].prev = Some(pe);
                    self.g.edges[pe].next = Some(edge);
                }
                *prev_edge = Some(edge);
                v0 = v1;
                if p1_idx < discretized.len() - 1 {
                    let mut pe = edge;
                    self.g.make_rib(&mut pe, start_source, end_source);
                    *prev_edge = Some(pe);
                }
            }
            edge_map.insert(vd_edge, prev_edge.unwrap());
        }
    }

    fn compute_segment_cell_range(vd: &voro::Vd, polys: &Polygons, cell: usize) -> CellRange {
        let src = vd.cells[cell].src;
        let from = polys.from(src);
        let to = polys.to(src);
        let mut r = CellRange { start_pt: to, end_pt: from, edge_begin: None, edge_end: None };
        let mut seen_possible_start = false;
        let mut after_start = false;
        let mut ending_edge_is_set_before_start = false;
        let Some(inc) = vd.cells[cell].incident_edge else { return r };
        let mut edge = inc;
        loop {
            let finite = vd.is_finite(edge);
            if finite {
                let v0 = Self::vd_point(vd, vd.edges[edge].v0.unwrap());
                let v1 = Self::vd_point(vd, vd.v1(edge).unwrap());
                if v0 == to && !after_start {
                    r.edge_begin = Some(edge);
                    seen_possible_start = true;
                } else if seen_possible_start {
                    after_start = true;
                }
                if v1 == from && (r.edge_end.is_none() || ending_edge_is_set_before_start) {
                    ending_edge_is_set_before_start = !after_start;
                    r.edge_end = Some(edge);
                }
            }
            edge = vd.edges[edge].next;
            if edge == inc {
                break;
            }
        }
        r
    }

    fn compute_point_cell_range(vd: &voro::Vd, polys: &Polygons, cell: usize) -> CellRange {
        let c = &vd.cells[cell];
        let source_point = if c.cat == voro::Src::Start { polys.from(c.src) } else { polys.to(c.src) };
        let mut r = CellRange { start_pt: source_point, end_pt: source_point, edge_begin: None, edge_end: None };
        let Some(inc) = c.incident_edge else { return r };
        if !vd.is_finite(inc) {
            return r;
        }
        let (a, b, cc) = if c.cat == voro::Src::Start { (polys.prev_of(c.src), polys.from(c.src), polys.to(c.src)) } else { (polys.from(c.src), polys.to(c.src), polys.next_next(c.src)) };
        let edge_v0 = Self::vd_point(vd, vd.edges[inc].v0.unwrap());
        let edge_v1 = Self::vd_point(vd, vd.v1(inc).unwrap());
        let edge_query_point = if edge_v0 == source_point { edge_v1 } else { edge_v0 };
        if !is_point_inside_polygon_corner(a, b, cc, edge_query_point) {
            return r;
        }
        let mut edge = inc;
        loop {
            if let Some(v1) = vd.v1(edge) {
                if Self::vd_point(vd, v1) == source_point {
                    r.edge_begin = Some(vd.edges[edge].next);
                    r.edge_end = Some(edge);
                }
            }
            edge = vd.edges[edge].next;
            if edge == inc {
                break;
            }
        }
        r
    }

    fn construct_from_polygons(&mut self, polys_v: &Vec<Ring>) -> Result<(), FdmError> {
        let polys = Polygons::new(polys_v);
        let segs: Vec<[i64; 4]> = (0..polys.segs.len()).map(|s| {
            let (a, b) = (polys.from(s), polys.to(s));
            [a[0], a[1], b[0], b[1]]
        }).collect();
        let vd = voro::build(&segs).ok_or_else(|| FdmError::Geometry("arachne: voronoi construction failed".into()))?;
        let mut edge_map: BTreeMap<usize, usize> = BTreeMap::new();
        let mut node_map: BTreeMap<usize, usize> = BTreeMap::new();
        for cell in 0..vd.cells.len() {
            if vd.cells[cell].incident_edge.is_none() {
                continue;
            }
            let range = if vd.cells[cell].cat != voro::Src::Segment {
                let r = Self::compute_point_cell_range(&vd, &polys, cell);
                if !(r.edge_begin.is_some() && r.edge_end.is_some() && r.edge_begin != r.edge_end) {
                    continue;
                }
                r
            } else {
                Self::compute_segment_cell_range(&vd, &polys, cell)
            };
            let (Some(starting), Some(ending)) = (range.edge_begin, range.edge_end) else { continue };
            if starting == ending {
                continue;
            }
            let (start_source, end_source) = (range.start_pt, range.end_pt);
            let mut prev_edge: Option<usize> = None;
            let v1_start = Self::vd_point(&vd, vd.v1(starting).unwrap());
            self.transfer_edge(&vd, &polys, start_source, v1_start, starting, &mut prev_edge, start_source, end_source, &mut edge_map, &mut node_map);
            let starting_node = node_map[&vd.edges[starting].v0.unwrap()];
            self.g.nodes[starting_node].dist = 0;
            let mut pe = prev_edge.unwrap();
            self.g.make_rib(&mut pe, start_source, end_source);
            prev_edge = Some(pe);
            let mut vd_edge = vd.edges[starting].next;
            while vd_edge != ending {
                if !vd.is_finite(vd_edge) {
                    break;
                }
                let v1 = Self::vd_point(&vd, vd.edges[vd_edge].v0.unwrap());
                let v2 = Self::vd_point(&vd, vd.v1(vd_edge).unwrap());
                self.transfer_edge(&vd, &polys, v1, v2, vd_edge, &mut prev_edge, start_source, end_source, &mut edge_map, &mut node_map);
                let mut pe = prev_edge.unwrap();
                self.g.make_rib(&mut pe, start_source, end_source);
                prev_edge = Some(pe);
                vd_edge = vd.edges[vd_edge].next;
            }
            let v0_end = Self::vd_point(&vd, vd.edges[ending].v0.unwrap());
            self.transfer_edge(&vd, &polys, v0_end, end_source, ending, &mut prev_edge, start_source, end_source, &mut edge_map, &mut node_map);
            let last = prev_edge.unwrap();
            let to = self.g.edges[last].to;
            self.g.nodes[to].dist = 0;
        }
        self.separate_pointy_quad_end_nodes();
        self.g.collapse_small_edges(5);
        for e in self.g.edge_order() {
            if self.g.edges[e].prev.is_none() {
                let f = self.g.edges[e].from;
                self.g.nodes[f].incident_edge = Some(e);
            }
        }
        Ok(())
    }

    fn separate_pointy_quad_end_nodes(&mut self) {
        let mut visited: BTreeSet<usize> = BTreeSet::new();
        for e in self.g.edge_order() {
            if self.g.edges[e].prev.is_some() {
                continue;
            }
            let from = self.g.edges[e].from;
            if !visited.contains(&from) {
                visited.insert(from);
            } else {
                let mut n = self.g.nodes[from].clone();
                n.incident_edge = Some(e);
                self.g.back_key += 1;
                n.key = self.g.back_key;
                self.g.nodes.push(n);
                let new_node = self.g.nodes.len() - 1;
                self.g.edges[e].from = new_node;
                let t = self.g.tw(e);
                self.g.edges[t].to = new_node;
            }
        }
    }
}

// =====================================================================================================================
// SkeletalTrapezoidation: centrality, bead counts, transitions
// =====================================================================================================================
impl<'a> Skeleton<'a> {
    /// `generateToolpaths`: runs every stage and returns the raw variable-width lines per inset.
    pub fn generate_toolpaths(mut self) -> Vec<VariableWidthLines> {
        self.update_is_central();
        // filterCentral(central_filter_dist): its trigger in Orca is `isEndOfCentral && isLocalMaximum && !isLocalMaximum`,
        // a contradiction, so it never fires; reproduced by omission.
        self.update_bead_count();
        self.filter_noncentral_regions();
        self.generate_transitioning_ribs();
        // generateExtraRibs(): a no-op for Orca's strategy chain (getNonlinearThicknesses of the outermost Limited
        // strategy is the empty default).
        self.generate_segments();
        self.toolpaths
    }

    fn update_is_central(&mut self) {
        let outer_edge_filter_length = self.bs.transition_thickness(0) / 2;
        let cap = (self.bs.transitioning_angle() as f32 * 0.5).sin();
        for e in self.g.edge_order() {
            let Some(tw) = self.g.edges[e].twin else { continue };
            if self.g.central_is_set(tw) {
                let c = self.g.is_central(tw);
                self.g.set_central(e, c);
            } else if self.g.edges[e].ty == EdgeType::ExtraVd {
                self.g.set_central(e, false);
            } else if self.g.from_dist(e).max(self.g.to_dist(e)) < outer_edge_filter_length {
                self.g.set_central(e, false);
            } else {
                let a = self.g.nodes[self.g.edges[e].from].p;
                let b = self.g.nodes[self.g.edges[e].to].p;
                let d_r = (self.g.to_dist(e) - self.g.from_dist(e)).abs();
                let d_d = norm_i(sub(b, a));
                self.g.set_central(e, (d_r as f32) < (d_d as f32) * cap);
            }
        }
    }

    fn is_end_of_central(&self, edge_to: usize) -> bool {
        if !self.g.is_central(edge_to) {
            return false;
        }
        let Some(next) = self.g.edges[edge_to].next else { return true };
        let twin = self.g.edges[edge_to].twin;
        let mut e = Some(next);
        while let Some(ei) = e {
            if Some(ei) == twin {
                break;
            }
            if self.g.is_central(ei) {
                return false;
            }
            let t = self.g.tw(ei);
            e = self.g.edges[t].next;
        }
        true
    }

    fn update_bead_count(&mut self) {
        for e in self.g.edge_order() {
            if self.g.is_central(e) {
                let to = self.g.edges[e].to;
                self.g.nodes[to].bead_count = self.bs.optimal_bead_count(self.g.nodes[to].dist * 2);
            }
        }
        for n in self.g.node_order() {
            if self.g.is_local_maximum(n, false) {
                if self.g.nodes[n].dist < 0 {
                    self.g.nodes[n].dist = i64::MAX;
                    if let Some(inc) = self.g.nodes[n].incident_edge {
                        let mut e = inc;
                        loop {
                            let cand = self.g.to_dist(e) + self.g.len(e);
                            self.g.nodes[n].dist = self.g.nodes[n].dist.min(cand);
                            let t = self.g.tw(e);
                            match self.g.edges[t].next {
                                Some(nx) => e = nx,
                                None => break,
                            }
                            if e == inc {
                                break;
                            }
                        }
                    }
                }
                let bc = self.bs.optimal_bead_count(self.g.nodes[n].dist * 2);
                self.g.nodes[n].bead_count = bc;
            }
        }
    }

    fn filter_noncentral_regions(&mut self) {
        for e in self.g.edge_order() {
            if !self.is_end_of_central(e) {
                continue;
            }
            let to = self.g.edges[e].to;
            let max_dist = 400_000;
            let bc = self.g.nodes[to].bead_count;
            self.filter_noncentral_regions_rec(e, bc, 0, max_dist);
        }
    }

    fn filter_noncentral_regions_rec(&mut self, to_edge: usize, bead_count: i64, traveled_dist: i64, max_dist: i64) -> bool {
        let r = self.g.to_dist(to_edge);
        let twin = self.g.edges[to_edge].twin;
        let mut next_edge = self.g.edges[to_edge].next;
        while let Some(ne) = next_edge {
            if Some(ne) == twin {
                break;
            }
            if self.g.to_dist(ne) >= r || shorter_then(sub(self.g.nodes[self.g.edges[ne].to].p, self.g.nodes[self.g.edges[ne].from].p), 10_000) {
                break;
            }
            let t = self.g.tw(ne);
            next_edge = self.g.edges[t].next;
        }
        let Some(ne) = next_edge else { return false };
        if Some(ne) == twin {
            return false;
        }
        let length = self.g.len(ne);
        let to_node = self.g.edges[ne].to;
        let dissolve;
        if self.g.nodes[to_node].bead_count == bead_count {
            dissolve = true;
        } else if self.g.nodes[to_node].bead_count < 0 {
            dissolve = self.filter_noncentral_regions_rec(ne, bead_count, traveled_dist + length, max_dist);
        } else {
            dissolve = (traveled_dist + length < max_dist) && (self.g.nodes[to_node].bead_count - bead_count).abs() == 1;
        }
        if dissolve {
            self.g.set_central(ne, true);
            let t = self.g.tw(ne);
            self.g.set_central(t, true);
            self.g.nodes[to_node].bead_count = self.bs.optimal_bead_count(self.g.nodes[to_node].dist * 2);
            self.g.nodes[to_node].transition_ratio = 0.0;
        }
        dissolve
    }

    fn generate_transitioning_ribs(&mut self) {
        self.generate_transition_mids();
        self.filter_transition_mids();
        self.generate_all_transition_ends();
        self.apply_transitions();
        // the shared lists go out of scope here in Orca; only weak pointers remain
        for e in 0..self.g.edges.len() {
            self.g.edges[e].transitions = None;
            self.g.edges[e].transition_ends = None;
        }
    }

    fn generate_transition_mids(&mut self) {
        for e in self.g.edge_order() {
            if !self.g.is_central(e) {
                continue;
            }
            let start_r = self.g.from_dist(e);
            let end_r = self.g.to_dist(e);
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            let start_bead_count = self.g.nodes[from].bead_count;
            let end_bead_count = self.g.nodes[to].bead_count;
            if start_r == end_r {
                continue;
            } else if start_r > end_r {
                continue;
            }
            if start_bead_count == end_bead_count {
                continue;
            }
            let edge_size = self.g.len(e);
            for transition_lower_bead_count in start_bead_count..end_bead_count {
                let mut mid_r = self.bs.transition_thickness(transition_lower_bead_count) / 2;
                if mid_r > end_r {
                    mid_r = end_r;
                }
                if mid_r < start_r {
                    mid_r = start_r;
                }
                let mid_pos = edge_size * (mid_r - start_r) / (end_r - start_r);
                if !self.g.has_transitions(e, true) {
                    self.g.edges[e].transitions = Some(vec![]);
                }
                self.next_tid += 1;
                let id = self.next_tid;
                self.g.edges[e].transitions.as_mut().unwrap().push(TMid { pos: mid_pos, lower_bead_count: transition_lower_bead_count, feature_radius: mid_r, id });
            }
        }
    }

    fn filter_transition_mids(&mut self) {
        for e in self.g.edge_order() {
            if !self.g.has_transitions(e, false) {
                continue;
            }
            let ab_size = self.g.len(e);
            // ---- back
            let back = self.g.edges[e].transitions.as_ref().unwrap().last().cloned().unwrap();
            let to_be_dissolved_back = self.dissolve_nearby_transitions(e, &back, ab_size - back.pos, self.transition_filter_dist, true);
            let mut should_dissolve_back = !to_be_dissolved_back.is_empty();
            for (ref_edge, ref_id) in to_be_dissolved_back {
                let back_cnt = self.g.edges[e].transitions.as_ref().unwrap().last().map(|t| t.lower_bead_count).unwrap_or(back.lower_bead_count);
                self.dissolve_bead_count_region(e, back_cnt + 1, back_cnt);
                if let Some(v) = self.g.edges[ref_edge].transitions.as_mut() {
                    v.retain(|t| t.id != ref_id);
                }
            }
            {
                let Some(back) = self.g.edges[e].transitions.as_ref().and_then(|v| v.last().cloned()) else { continue };
                let trans_bead_count = back.lower_bead_count;
                let upper_transition_half_length = ((1.0 - self.bs.transition_anchor_pos(trans_bead_count) as f64) * self.bs.transitioning_length(trans_bead_count) as f64) as i64;
                should_dissolve_back |= self.filter_end_of_central_transition(e, ab_size - back.pos, upper_transition_half_length, trans_bead_count);
            }
            if should_dissolve_back {
                if let Some(v) = self.g.edges[e].transitions.as_mut() {
                    v.pop();
                }
            }
            if self.g.edges[e].transitions.as_ref().map_or(true, |v| v.is_empty()) {
                continue;
            }
            // ---- front
            let front = self.g.edges[e].transitions.as_ref().unwrap().first().cloned().unwrap();
            let twin = self.g.tw(e);
            let to_be_dissolved_front = self.dissolve_nearby_transitions(twin, &front, front.pos, self.transition_filter_dist, false);
            let mut should_dissolve_front = !to_be_dissolved_front.is_empty();
            for (ref_edge, ref_id) in to_be_dissolved_front {
                let front_cnt = self.g.edges[e].transitions.as_ref().unwrap().first().map(|t| t.lower_bead_count).unwrap_or(front.lower_bead_count);
                self.dissolve_bead_count_region(twin, front_cnt, front_cnt + 1);
                if let Some(v) = self.g.edges[ref_edge].transitions.as_mut() {
                    v.retain(|t| t.id != ref_id);
                }
            }
            {
                let Some(front) = self.g.edges[e].transitions.as_ref().and_then(|v| v.first().cloned()) else { continue };
                let trans_bead_count = front.lower_bead_count;
                let lower_transition_half_length = (self.bs.transition_anchor_pos(trans_bead_count) as f64 * self.bs.transitioning_length(trans_bead_count) as f64) as i64;
                should_dissolve_front |= self.filter_end_of_central_transition(twin, front.pos, lower_transition_half_length, trans_bead_count + 1);
            }
            if should_dissolve_front {
                if let Some(v) = self.g.edges[e].transitions.as_mut() {
                    if !v.is_empty() {
                        v.remove(0);
                    }
                }
            }
        }
    }

    fn dissolve_nearby_transitions(&mut self, edge_to_start: usize, origin: &TMid, traveled_dist: i64, max_dist: i64, going_up: bool) -> Vec<(usize, u64)> {
        let mut to_be_dissolved: Vec<(usize, u64)> = vec![];
        if traveled_dist > max_dist {
            return to_be_dissolved;
        }
        let mut should_dissolve = true;
        let twin_start = self.g.edges[edge_to_start].twin;
        let mut edge_o = self.g.edges[edge_to_start].next;
        while let Some(edge) = edge_o {
            if Some(edge) == twin_start {
                break;
            }
            let et = self.g.tw(edge);
            let next_iter = self.g.edges[et].next;
            if !self.g.is_central(edge) {
                edge_o = next_iter;
                continue;
            }
            let ab_size = self.g.len(edge);
            let is_aligned = self.g.is_upward(edge);
            let aligned_edge = if is_aligned { edge } else { et };
            let mut seen_transition_on_this_edge = false;
            let origin_radius = origin.feature_radius;
            let radius_here = self.g.from_dist(edge);
            let dissolve_result_is_odd = (origin.lower_bead_count % 2 != 0) == going_up;
            let width_deviation = (origin_radius - radius_here).abs() * 2;
            let line_width_deviation = if dissolve_result_is_odd { width_deviation } else { width_deviation / 2 };
            if line_width_deviation > self.allowed_filter_deviation {
                should_dissolve = false;
            }
            if should_dissolve && self.g.has_transitions(aligned_edge, false) {
                let transitions = self.g.edges[aligned_edge].transitions.clone().unwrap();
                for t in transitions.iter() {
                    let pos = if is_aligned { t.pos } else { ab_size - t.pos };
                    if traveled_dist + pos < max_dist && t.lower_bead_count == origin.lower_bead_count {
                        to_be_dissolved.push((aligned_edge, t.id));
                        seen_transition_on_this_edge = true;
                    }
                }
            }
            if should_dissolve && !seen_transition_on_this_edge {
                let here = self.dissolve_nearby_transitions(edge, origin, traveled_dist + ab_size, max_dist, going_up);
                if here.is_empty() {
                    to_be_dissolved.clear();
                    return to_be_dissolved;
                }
                to_be_dissolved.extend(here);
                should_dissolve = should_dissolve && !to_be_dissolved.is_empty();
            }
            edge_o = next_iter;
        }
        if !should_dissolve {
            to_be_dissolved.clear();
        }
        to_be_dissolved
    }

    fn dissolve_bead_count_region(&mut self, edge_to_start: usize, from_bead_count: i64, to_bead_count: i64) {
        let to = self.g.edges[edge_to_start].to;
        if self.g.nodes[to].bead_count != from_bead_count {
            return;
        }
        self.g.nodes[to].bead_count = to_bead_count;
        let twin = self.g.edges[edge_to_start].twin;
        let mut e = self.g.edges[edge_to_start].next;
        while let Some(ei) = e {
            if Some(ei) == twin {
                break;
            }
            let et = self.g.tw(ei);
            let nx = self.g.edges[et].next;
            if self.g.is_central(ei) {
                self.dissolve_bead_count_region(ei, from_bead_count, to_bead_count);
            }
            e = nx;
        }
    }

    fn filter_end_of_central_transition(&mut self, edge_to_start: usize, traveled_dist: i64, max_dist: i64, replacing_bead_count: i64) -> bool {
        if traveled_dist > max_dist {
            return false;
        }
        let mut is_end_of_central = true;
        let mut should_dissolve = false;
        let twin = self.g.edges[edge_to_start].twin;
        let mut e = self.g.edges[edge_to_start].next;
        while let Some(ei) = e {
            if Some(ei) == twin {
                break;
            }
            let et = self.g.tw(ei);
            let nx = self.g.edges[et].next;
            if self.g.is_central(ei) {
                let length = self.g.len(ei);
                should_dissolve |= self.filter_end_of_central_transition(ei, traveled_dist + length, max_dist, replacing_bead_count);
                is_end_of_central = false;
            }
            e = nx;
        }
        if is_end_of_central && traveled_dist < max_dist {
            should_dissolve = true;
        }
        if should_dissolve {
            let to = self.g.edges[edge_to_start].to;
            self.g.nodes[to].bead_count = replacing_bead_count;
        }
        should_dissolve
    }

    fn generate_all_transition_ends(&mut self) {
        for e in self.g.edge_order() {
            if !self.g.has_transitions(e, false) {
                continue;
            }
            let positions = self.g.edges[e].transitions.clone().unwrap();
            for tm in positions.iter() {
                self.generate_transition_ends(e, tm.pos, tm.lower_bead_count);
            }
        }
    }

    fn generate_transition_ends(&mut self, edge: usize, mid_pos: i64, lower_bead_count: i64) {
        let ab_size = self.g.len(edge);
        let transition_length = self.bs.transitioning_length(lower_bead_count);
        let transition_mid_position: f32 = self.bs.transition_anchor_pos(lower_bead_count);
        let inner_bead_width_ratio_after_transition: f32 = 1.0;
        let start_rest = 0.0f64;
        let mid_rest = (transition_mid_position * inner_bead_width_ratio_after_transition) as f64;
        let end_rest = inner_bead_width_ratio_after_transition as f64;
        {
            // lower bead count transition end
            let start_pos = ab_size - mid_pos;
            let transition_half_length = (transition_mid_position * transition_length as f32) as i64;
            let end_pos = start_pos + transition_half_length;
            let twin = self.g.tw(edge);
            self.generate_transition_end(twin, start_pos, end_pos, transition_half_length, mid_rest, start_rest, lower_bead_count);
        }
        {
            // upper bead count transition end
            let start_pos = mid_pos;
            let transition_half_length = ((1.0 - transition_mid_position as f64) * transition_length as f64) as i64;
            let end_pos = mid_pos + transition_half_length;
            self.generate_transition_end(edge, start_pos, end_pos, transition_half_length, mid_rest, end_rest, lower_bead_count);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn generate_transition_end(&mut self, edge: usize, start_pos: i64, end_pos: i64, transition_half_length: i64, start_rest: f64, end_rest: f64, lower_bead_count: i64) -> bool {
        let ab_size = self.g.len(edge);
        let going_up = end_rest > start_rest;
        if !self.g.is_central(edge) {
            return false;
        }
        if end_pos > ab_size {
            // recurse on all further edges
            let rest: f32 = (end_rest - (start_rest - end_rest) * (end_pos - ab_size) as f64 / (start_pos - end_pos) as f64) as f32;
            let twin = self.g.edges[edge].twin;
            let mut central_edge_count = 0;
            let mut o = self.g.edges[edge].next;
            while let Some(oi) = o {
                if Some(oi) == twin {
                    break;
                }
                if self.g.is_central(oi) {
                    central_edge_count += 1;
                }
                let t = self.g.tw(oi);
                o = self.g.edges[t].next;
            }
            let mut is_only_going_down = true;
            let mut has_recursed = false;
            let mut o = self.g.edges[edge].next;
            while let Some(oi) = o {
                if Some(oi) == twin {
                    break;
                }
                let t = self.g.tw(oi);
                let next = self.g.edges[t].next;
                if !self.g.is_central(oi) {
                    o = next;
                    continue;
                }
                if central_edge_count > 1 && going_up && self.is_going_down(oi, 0, end_pos - ab_size + transition_half_length, lower_bead_count) {
                    o = next;
                    continue;
                }
                let is_going_down = self.generate_transition_end(oi, 0, end_pos - ab_size, transition_half_length, rest as f64, end_rest, lower_bead_count);
                is_only_going_down &= is_going_down;
                o = next;
                has_recursed = true;
            }
            if !going_up || (has_recursed && !is_only_going_down) {
                let to = self.g.edges[edge].to;
                self.g.nodes[to].transition_ratio = rest;
                self.g.nodes[to].bead_count = lower_bead_count;
            }
            is_only_going_down
        } else {
            let is_lower_end = end_rest == 0.0;
            let (upward_edge, pos) = if self.g.is_upward(edge) { (edge, end_pos) } else { (self.g.tw(edge), ab_size - end_pos) };
            if !self.g.has_transition_ends(upward_edge, true) {
                self.g.edges[upward_edge].transition_ends = Some(vec![]);
            }
            let list = self.g.edges[upward_edge].transition_ends.as_mut().unwrap();
            let te = TEnd { pos, lower_bead_count, is_lower_end };
            if list.is_empty() || pos < list[0].pos {
                list.insert(0, te);
            } else {
                list.push(te);
            }
            false
        }
    }

    fn is_going_down(&self, outgoing: usize, traveled_dist: i64, max_dist: i64, lower_bead_count: i64) -> bool {
        if self.g.to_dist(outgoing) == 0 {
            return true;
        }
        let is_upward = self.g.to_dist(outgoing) >= self.g.from_dist(outgoing);
        let upward_edge = if is_upward { outgoing } else { self.g.tw(outgoing) };
        let to = self.g.edges[outgoing].to;
        if self.g.nodes[to].bead_count > lower_bead_count + 1 {
            return false;
        }
        let length = self.g.len(outgoing);
        if self.g.has_transitions(upward_edge, false) {
            let tm = self.g.edges[upward_edge].transitions.as_ref().unwrap();
            let mid = if is_upward { tm.first().unwrap() } else { tm.last().unwrap() };
            if mid.lower_bead_count == lower_bead_count && ((is_upward && mid.pos + traveled_dist < max_dist) || (!is_upward && length - mid.pos + traveled_dist < max_dist)) {
                return true;
            }
        }
        if traveled_dist + length > max_dist {
            return false;
        }
        if self.g.nodes[to].bead_count <= lower_bead_count && !(self.g.nodes[to].bead_count == lower_bead_count && self.g.nodes[to].transition_ratio > 0.0) {
            return true;
        }
        let mut is_only_going_down = true;
        let mut has_recursed = false;
        let twin = self.g.edges[outgoing].twin;
        let mut next = self.g.edges[outgoing].next;
        while let Some(ne) = next {
            if Some(ne) == twin {
                break;
            }
            let t = self.g.tw(ne);
            let nx = self.g.edges[t].next;
            if self.g.is_central(ne) {
                let is_going_down = self.is_going_down(ne, traveled_dist + length, max_dist, lower_bead_count);
                is_only_going_down &= is_going_down;
                has_recursed = true;
            }
            next = nx;
        }
        has_recursed && is_only_going_down
    }

    fn apply_transitions(&mut self) {
        let snap = self.snap_dist;
        for e in self.g.edge_order() {
            let Some(tw) = self.g.edges[e].twin else { continue };
            if self.g.has_transition_ends(tw, false) {
                let length = self.g.len(e);
                let twin_ends = self.g.edges[tw].transition_ends.clone().unwrap();
                if !self.g.has_transition_ends(e, true) {
                    self.g.edges[e].transition_ends = Some(vec![]);
                }
                let ends = self.g.edges[e].transition_ends.as_mut().unwrap();
                for end in twin_ends {
                    ends.push(TEnd { pos: length - end.pos, lower_bead_count: end.lower_bead_count, is_lower_end: end.is_lower_end });
                }
                self.g.edges[tw].transition_ends.as_mut().unwrap().clear();
            }
        }
        for e in self.g.edge_order() {
            if !self.g.has_transition_ends(e, false) {
                continue;
            }
            let mut transitions = self.g.edges[e].transition_ends.clone().unwrap();
            transitions.sort_by_key(|t| t.pos); // std::list::sort is stable
            let from = self.g.edges[e].from;
            let to = self.g.edges[e].to;
            let a = self.g.nodes[from].p;
            let b = self.g.nodes[to].p;
            let ab = sub(b, a);
            let ab_size = norm_i(ab);
            let mut last_edge_replacing_input = e;
            for te in transitions.iter() {
                let new_node_bead_count = if te.is_lower_end { te.lower_bead_count } else { te.lower_bead_count + 1 };
                let end_pos = te.pos;
                let close_node = if end_pos < ab_size / 2 { from } else { to };
                if (end_pos < snap || end_pos > ab_size - snap) && self.g.nodes[close_node].bead_count == new_node_bead_count {
                    self.g.nodes[close_node].transition_ratio = 0.0;
                    continue;
                }
                let mid = add(a, normal(ab, end_pos));
                last_edge_replacing_input = self.g.insert_node(last_edge_replacing_input, mid, new_node_bead_count);
            }
        }
    }
}

fn normal(p0: Pt, len: i64) -> Pt {
    let l = norm_i(p0);
    if l < 1 {
        return [len, 0];
    }
    [p0[0] * len / l, p0[1] * len / l]
}

// =====================================================================================================================
// SkeletalTrapezoidation: toolpath generation
// =====================================================================================================================
fn interpolate(left: &Beading, ratio_left_to_whole: f64, right: &Beading) -> Beading {
    let ratio_right_to_whole: f32 = 1.0 - ratio_left_to_whole as f32;
    let mut ret = if left.total_thickness > right.total_thickness { left.clone() } else { right.clone() };
    for inset_idx in 0..left.bead_widths.len().min(right.bead_widths.len()) {
        if left.bead_widths[inset_idx] == 0 || right.bead_widths[inset_idx] == 0 {
            ret.bead_widths[inset_idx] = 0;
        } else {
            ret.bead_widths[inset_idx] = (ratio_left_to_whole * left.bead_widths[inset_idx] as f64 + ratio_right_to_whole as f64 * right.bead_widths[inset_idx] as f64) as i64;
        }
        ret.toolpath_locations[inset_idx] = (ratio_left_to_whole * left.toolpath_locations[inset_idx] as f64 + ratio_right_to_whole as f64 * right.toolpath_locations[inset_idx] as f64) as i64;
    }
    ret
}

fn interpolate_switching(left: &Beading, ratio_left_to_whole: f64, right: &Beading, switching_radius: i64) -> Beading {
    let ret = interpolate(left, ratio_left_to_whole, right);
    let mut next_inset_idx: i64 = left.toolpath_locations.len() as i64 - 1;
    while next_inset_idx >= 0 {
        if switching_radius > left.toolpath_locations[next_inset_idx as usize] {
            break;
        }
        next_inset_idx -= 1;
    }
    if next_inset_idx < 0 {
        return ret;
    }
    if next_inset_idx + 1 == left.toolpath_locations.len() as i64 {
        return ret;
    }
    if next_inset_idx >= ret.toolpath_locations.len() as i64 {
        return ret;
    }
    let n = next_inset_idx as usize;
    if ret.toolpath_locations[n] > switching_radius {
        let mut new_ratio = (switching_radius - right.toolpath_locations[n]) as f32 / (left.toolpath_locations[n] - right.toolpath_locations[n]) as f32;
        new_ratio = (1.0f32).min(new_ratio + 0.1);
        return interpolate(left, new_ratio as f64, right);
    }
    ret
}

impl<'a> Skeleton<'a> {
    fn generate_segments(&mut self) {
        let mut upward_quad_mids: Vec<usize> = vec![];
        for e in self.g.edge_order() {
            if self.g.edges[e].prev.is_some() && self.g.edges[e].next.is_some() && self.g.is_upward(e) {
                upward_quad_mids.push(e);
            }
        }
        // std::sort with the comparator of Orca (not a strict weak ordering in corner cases: merge sort never panics)
        let g = &self.g;
        let less = |a: usize, b: usize| -> bool {
            if g.to_dist(a) == g.to_dist(b) {
                let a_flat = g.from_dist(a) == g.to_dist(a);
                let b_flat = g.from_dist(b) == g.to_dist(b);
                if a_flat && b_flat {
                    let max = i64::MAX;
                    let ad = g.dist_to_go_up(a).unwrap_or(max).min(g.dist_to_go_up(g.tw(a)).unwrap_or(max)) - g.len(a);
                    let bd = g.dist_to_go_up(b).unwrap_or(max).min(g.dist_to_go_up(g.tw(b)).unwrap_or(max)) - g.len(b);
                    return ad < bd;
                } else if a_flat {
                    return true;
                } else if b_flat {
                    return false;
                }
            }
            g.to_dist(a) > g.to_dist(b)
        };
        upward_quad_mids = merge_sort(upward_quad_mids, &less);

        // store beading
        for n in self.g.node_order() {
            if self.g.nodes[n].bead_count <= 0 {
                continue;
            }
            let dist2 = self.g.nodes[n].dist * 2;
            if self.g.nodes[n].transition_ratio == 0.0 {
                let b = self.bs.compute(dist2, self.g.nodes[n].bead_count);
                self.beadings.push(BeadingProp::new(b));
                self.g.nodes[n].beading = Some(self.beadings.len() - 1);
            } else {
                let low = self.bs.compute(dist2, self.g.nodes[n].bead_count);
                let high = self.bs.compute(dist2, self.g.nodes[n].bead_count + 1);
                let merged = interpolate(&low, 1.0 - self.g.nodes[n].transition_ratio as f64, &high);
                self.beadings.push(BeadingProp::new(merged));
                self.g.nodes[n].beading = Some(self.beadings.len() - 1);
            }
        }
        self.propagate_beadings_upward(&upward_quad_mids);
        self.propagate_beadings_downward_all(&upward_quad_mids);
        self.generate_junctions();
        self.connect_junctions();
        self.generate_local_maxima_single_beads();
    }

    fn propagate_beadings_upward(&mut self, upward_quad_mids: &[usize]) {
        for &upward_edge in upward_quad_mids.iter().rev() {
            let (from, to) = (self.g.edges[upward_edge].from, self.g.edges[upward_edge].to);
            if self.g.nodes[to].bead_count >= 0 {
                continue;
            }
            let Some(lb) = self.g.nodes[from].beading else { continue };
            if self.g.nodes[to].beading.is_some() {
                continue;
            }
            let length = self.g.len(upward_edge);
            let mut upper = self.beadings[lb].clone();
            upper.dist_to_bottom_source += length;
            upper.is_upward_propagated_only = true;
            self.beadings.push(upper);
            self.g.nodes[to].beading = Some(self.beadings.len() - 1);
        }
    }

    fn propagate_beadings_downward_all(&mut self, upward_quad_mids: &[usize]) {
        for &e in upward_quad_mids {
            if !self.g.is_central(e) {
                let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
                if self.g.nodes[from].dist == self.g.nodes[to].dist && self.g.nodes[from].beading.is_some() && self.g.nodes[to].beading.is_none() {
                    let t = self.g.tw(e);
                    self.propagate_beadings_downward(t);
                } else {
                    self.propagate_beadings_downward(e);
                }
            }
        }
    }

    fn propagate_beadings_downward(&mut self, edge_to_peak: usize) {
        let length = self.g.len(edge_to_peak);
        let (from, to) = (self.g.edges[edge_to_peak].from, self.g.edges[edge_to_peak].to);
        let top_idx = self.get_or_create_beading(to);
        let top = self.beadings[top_idx].clone();
        if self.g.nodes[from].beading.is_none() {
            let mut propagated = top;
            propagated.dist_from_top_source += length;
            self.beadings.push(propagated);
            self.g.nodes[from].beading = Some(self.beadings.len() - 1);
        } else {
            let bidx = self.g.nodes[from].beading.unwrap();
            let bottom = self.beadings[bidx].clone();
            let total_dist = top.dist_from_top_source + length + bottom.dist_to_bottom_source;
            let mut ratio_of_top = bottom.dist_to_bottom_source as f32 / total_dist.min(self.beading_propagation_transition_dist) as f32;
            ratio_of_top = (ratio_of_top as f64).max(0.0) as f32;
            if ratio_of_top as f64 >= 1.0 {
                let mut nb = top;
                nb.dist_from_top_source += length;
                self.beadings[bidx] = nb;
            } else {
                let merged = interpolate_switching(&top.beading, ratio_of_top as f64, &bottom.beading, self.g.nodes[from].dist);
                let mut nb = BeadingProp::new(merged);
                nb.is_upward_propagated_only = false;
                self.beadings[bidx] = nb;
            }
        }
    }

    fn get_or_create_beading(&mut self, node: usize) -> usize {
        if self.g.nodes[node].beading.is_none() {
            if self.g.nodes[node].bead_count == -1 {
                let nearby_dist = 100_000;
                if let Some(nearest) = self.get_nearest_beading(node, nearby_dist) {
                    return nearest;
                }
                let mut dist = i64::MAX;
                if let Some(inc) = self.g.nodes[node].incident_edge {
                    let mut e = inc;
                    loop {
                        dist = dist.min(self.g.to_dist(e) + self.g.len(e));
                        let Some(t) = self.g.edges[e].twin else { break };
                        match self.g.edges[t].next {
                            Some(nx) => e = nx,
                            None => break,
                        }
                        if e == inc {
                            break;
                        }
                    }
                }
                if dist == i64::MAX {
                    dist = self.g.nodes[node].dist.max(0);
                }
                self.g.nodes[node].bead_count = self.bs.optimal_bead_count(dist * 2);
            }
            let b = self.bs.compute(self.g.nodes[node].dist * 2, self.g.nodes[node].bead_count);
            self.beadings.push(BeadingProp::new(b));
            self.g.nodes[node].beading = Some(self.beadings.len() - 1);
        }
        self.g.nodes[node].beading.unwrap()
    }

    fn get_nearest_beading(&self, node: usize, max_dist: i64) -> Option<usize> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        let mut further: BinaryHeap<Reverse<(i64, usize)>> = BinaryHeap::new();
        if let Some(inc) = self.g.nodes[node].incident_edge {
            let mut o = inc;
            loop {
                further.push(Reverse((self.g.len(o), o)));
                let Some(t) = self.g.edges[o].twin else { break };
                match self.g.edges[t].next {
                    Some(nx) => o = nx,
                    None => break,
                }
                if o == inc {
                    break;
                }
            }
        }
        for _ in 0..1000 {
            let Some(Reverse((dist, edge_to))) = further.pop() else { return None };
            if dist > max_dist {
                return None;
            }
            let to = self.g.edges[edge_to].to;
            if let Some(b) = self.g.nodes[to].beading {
                return Some(b);
            }
            let twin = self.g.edges[edge_to].twin;
            let mut fe = self.g.edges[edge_to].next;
            while let Some(f) = fe {
                if Some(f) == twin {
                    break;
                }
                further.push(Reverse((dist + self.g.len(f), f)));
                let t = self.g.tw(f);
                fe = self.g.edges[t].next;
            }
        }
        None
    }

    fn generate_junctions(&mut self) {
        for e in self.g.edge_order() {
            if self.g.from_dist(e) > self.g.to_dist(e) {
                continue;
            }
            let start_r = self.g.to_dist(e);
            let end_r = self.g.from_dist(e);
            let (from, to) = (self.g.edges[e].from, self.g.edges[e].to);
            if (self.g.nodes[from].bead_count == self.g.nodes[to].bead_count && self.g.nodes[from].bead_count >= 0) || end_r >= start_r {
                continue;
            }
            let bidx = self.get_or_create_beading(to);
            let beading = self.beadings[bidx].beading.clone();
            let a = self.g.nodes[to].p;
            let b = self.g.nodes[from].p;
            let ab = sub(b, a);
            let num_junctions = beading.toolpath_locations.len();
            let mut ret: Vec<Junction> = vec![];
            // starting junction index
            // for (junction_idx = (max(1, n) - 1) / 2; junction_idx < n; junction_idx--) with size_t wrap-around
            let mut junction_idx: usize = (num_junctions.max(1) - 1) / 2;
            while junction_idx < num_junctions {
                if beading.toolpath_locations[junction_idx] <= start_r + 1 {
                    break;
                }
                junction_idx = junction_idx.wrapping_sub(1);
            }
            let j1 = junction_idx.wrapping_add(1);
            if j1 < num_junctions && beading.toolpath_locations[j1] <= start_r + 5_000 && beading.total_thickness < start_r + 5_000 {
                junction_idx = j1;
            }
            while junction_idx < num_junctions {
                let bead_r = beading.toolpath_locations[junction_idx];
                if bead_r < end_r {
                    break;
                }
                let mut junction = [a[0] + ab[0] * (bead_r - start_r) / (end_r - start_r), a[1] + ab[1] * (bead_r - start_r) / (end_r - start_r)];
                if bead_r > start_r - 5_000 {
                    junction = a;
                }
                ret.push(Junction { p: junction, w: beading.bead_widths[junction_idx], perimeter_index: junction_idx });
                junction_idx = junction_idx.wrapping_sub(1);
            }
            self.g.edges[e].junctions = Some(ret);
        }
    }

    fn add_toolpath_segment(&mut self, from: Junction, to: Junction, is_odd: bool, mut force_new_path: bool, from_is_3way: bool, to_is_3way: bool) {
        if from == to {
            return;
        }
        let inset_idx = from.perimeter_index;
        if inset_idx >= self.toolpaths.len() {
            self.toolpaths.resize(inset_idx + 1, vec![]);
        }
        let list = &mut self.toolpaths[inset_idx];
        if list.is_empty() || list.last().unwrap().is_odd != is_odd || list.last().unwrap().junctions.last().unwrap().perimeter_index != inset_idx {
            force_new_path = true;
        }
        if !force_new_path && shorter_then(sub(list.last().unwrap().junctions.last().unwrap().p, from.p), 10_000) && (list.last().unwrap().junctions.last().unwrap().w - from.w).abs() < 10_000 && !from_is_3way {
            list.last_mut().unwrap().junctions.push(to);
        } else if !force_new_path && shorter_then(sub(list.last().unwrap().junctions.last().unwrap().p, to.p), 10_000) && (list.last().unwrap().junctions.last().unwrap().w - to.w).abs() < 10_000 && !to_is_3way {
            list.last_mut().unwrap().junctions.push(from);
        } else {
            let mut l = ExtrusionLine::new(inset_idx, is_odd);
            l.junctions.push(from);
            l.junctions.push(to);
            list.push(l);
        }
    }

    fn get_quad_max_redge_to(&self, quad_start_edge: usize) -> Option<usize> {
        let mut max_r = -1;
        let mut ret: Option<usize> = None;
        let mut e = Some(quad_start_edge);
        while let Some(ei) = e {
            let r = self.g.to_dist(ei);
            if r > max_r {
                max_r = r;
                ret = Some(ei);
            }
            e = self.g.edges[ei].next;
        }
        let r = ret?;
        if self.g.edges[r].next.is_none() && self.g.to_dist(r) - 5_000 < self.g.from_dist(r) {
            return self.g.edges[r].prev;
        }
        Some(r)
    }

    fn connect_junctions(&mut self) {
        let mut unprocessed: BTreeSet<usize> = BTreeSet::new();
        for e in self.g.edge_order() {
            if self.g.edges[e].prev.is_none() {
                unprocessed.insert(e);
            }
        }
        let mut passed_odd_edges: BTreeSet<usize> = BTreeSet::new();
        while let Some(&poly_domain_start) = unprocessed.iter().next() {
            let mut quad_start = poly_domain_start;
            let mut new_domain_start = true;
            loop {
                let mut quad_end = quad_start;
                while let Some(n) = self.g.edges[quad_end].next {
                    quad_end = n;
                }
                let Some(edge_to_peak) = self.get_quad_max_redge_to(quad_start) else {
                    unprocessed.remove(&quad_start);
                    match self.g.get_next_unconnected(quad_start) {
                        Some(n) if n != poly_domain_start => {
                            quad_start = n;
                            continue;
                        }
                        _ => break,
                    }
                };
                let Some(edge_from_peak) = self.g.edges[edge_to_peak].next else {
                    unprocessed.remove(&quad_start);
                    match self.g.get_next_unconnected(quad_start) {
                        Some(n) if n != poly_domain_start => {
                            quad_start = n;
                            continue;
                        }
                        _ => break,
                    }
                };
                unprocessed.remove(&quad_start);
                if self.g.edges[edge_to_peak].junctions.is_none() {
                    self.g.edges[edge_to_peak].junctions = Some(vec![]);
                }
                let mut from_junctions = self.g.edges[edge_to_peak].junctions.clone().unwrap();
                let efp_twin = self.g.tw(edge_from_peak);
                if self.g.edges[efp_twin].junctions.is_none() {
                    self.g.edges[efp_twin].junctions = Some(vec![]);
                }
                let mut to_junctions = self.g.edges[efp_twin].junctions.clone().unwrap();
                if let Some(prev) = self.g.edges[edge_to_peak].prev {
                    let from_prev = self.g.edges[prev].junctions.clone().unwrap_or_default();
                    while !from_junctions.is_empty() && !from_prev.is_empty() && from_junctions.last().unwrap().perimeter_index <= from_prev[0].perimeter_index {
                        from_junctions.pop();
                    }
                    from_junctions.extend(from_prev);
                }
                if let Some(nxt) = self.g.edges[edge_from_peak].next {
                    let nt = self.g.tw(nxt);
                    let to_next = self.g.edges[nt].junctions.clone().unwrap_or_default();
                    while !to_junctions.is_empty() && !to_next.is_empty() && to_junctions.last().unwrap().perimeter_index <= to_next[0].perimeter_index {
                        to_junctions.pop();
                    }
                    to_junctions.extend(to_next);
                }
                let segment_count = from_junctions.len().min(to_junctions.len());
                for junction_rev_idx in 0..segment_count {
                    let from = from_junctions[from_junctions.len() - 1 - junction_rev_idx];
                    let to = to_junctions[to_junctions.len() - 1 - junction_rev_idx];
                    let qs_to = self.g.edges[quad_start].to;
                    let qe_from = self.g.edges[quad_end].from;
                    let from_is_odd = self.g.nodes[qs_to].bead_count > 0
                        && self.g.nodes[qs_to].bead_count % 2 == 1
                        && self.g.nodes[qs_to].transition_ratio == 0.0
                        && junction_rev_idx == segment_count - 1
                        && shorter_then(sub(from.p, self.g.nodes[qs_to].p), 5_000);
                    let to_is_odd = self.g.nodes[qe_from].bead_count > 0
                        && self.g.nodes[qe_from].bead_count % 2 == 1
                        && self.g.nodes[qe_from].transition_ratio == 0.0
                        && junction_rev_idx == segment_count - 1
                        && shorter_then(sub(to.p, self.g.nodes[qe_from].p), 5_000);
                    let is_odd_segment = from_is_odd && to_is_odd;
                    let qs_next = self.g.edges[quad_start].next;
                    if is_odd_segment {
                        if let Some(qn) = qs_next {
                            if let Some(qnt) = self.g.edges[qn].twin {
                                if passed_odd_edges.contains(&qnt) {
                                    continue;
                                }
                            }
                        }
                    }
                    let from_is_3way = from_is_odd && self.g.is_multi_intersection(qs_to);
                    let to_is_3way = to_is_odd && self.g.is_multi_intersection(qe_from);
                    if let Some(qn) = qs_next {
                        passed_odd_edges.insert(qn);
                    }
                    self.add_toolpath_segment(from, to, is_odd_segment, new_domain_start, from_is_3way, to_is_3way);
                }
                new_domain_start = false;
                match self.g.get_next_unconnected(quad_start) {
                    Some(n) if n != poly_domain_start => quad_start = n,
                    _ => break,
                }
            }
            unprocessed.remove(&poly_domain_start);
        }
    }

    fn generate_local_maxima_single_beads(&mut self) {
        for n in self.g.node_order() {
            let Some(bi) = self.g.nodes[n].beading else { continue };
            let beading = self.beadings[bi].beading.clone();
            if beading.bead_widths.len() % 2 == 1 && self.g.is_local_maximum(n, true) && !self.g.node_is_central(n) {
                let inset_index = beading.bead_widths.len() / 2;
                if inset_index >= self.toolpaths.len() {
                    self.toolpaths.resize(inset_index + 1, vec![]);
                }
                let mut line = ExtrusionLine::new(inset_index, true);
                let width = beading.bead_widths[inset_index];
                let r = width / 8;
                let n_segments = 6;
                for segment in 0..n_segments {
                    let a = 2.0 * PI / n_segments as f64 * segment as f64;
                    let p = self.g.nodes[n].p;
                    line.junctions.push(Junction { p: [p[0] + (r as f64 * a.cos()).round() as i64, p[1] + (r as f64 * a.sin()).round() as i64], w: width, perimeter_index: inset_index });
                }
                self.toolpaths[inset_index].push(line);
            }
        }
    }
}

/// Stable merge sort tolerant of inconsistent comparators.
fn merge_sort(v: Vec<usize>, less: &dyn Fn(usize, usize) -> bool) -> Vec<usize> {
    if v.len() <= 1 {
        return v;
    }
    let mid = v.len() / 2;
    let right = merge_sort(v[mid..].to_vec(), less);
    let left = merge_sort(v[..mid].to_vec(), less);
    let mut out = Vec::with_capacity(left.len() + right.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        if less(right[j], left[i]) {
            out.push(right[j]);
            j += 1;
        } else {
            out.push(left[i]);
            i += 1;
        }
    }
    out.extend_from_slice(&left[i..]);
    out.extend_from_slice(&right[j..]);
    out
}

// =====================================================================================================================
// WallToolPaths (Arachne/WallToolPaths.cpp)
// =====================================================================================================================
#[derive(Clone, Debug)]
pub struct WallToolPathsParams {
    pub min_bead_width: i64,
    pub min_feature_size: i64,
    pub min_length_factor: f32,
    pub wall_transition_length: i64,
    pub wall_transition_angle: f32, // degrees
    pub wall_transition_filter_deviation: i64,
    pub wall_distribution_count: i32,
    pub is_top_or_bottom_layer: bool,
    pub wall_maximum_resolution: i64,
    pub wall_maximum_deviation: i64,
}
impl WallToolPathsParams {
    pub fn from_params(p: &WallParams, is_top_or_bottom_layer: bool) -> Self {
        WallToolPathsParams {
            min_bead_width: sc(p.min_bead_width),
            min_feature_size: sc(p.min_feature_size),
            min_length_factor: p.min_length_factor as f32,
            wall_transition_length: sc(p.wall_transition_length),
            wall_transition_angle: p.wall_transition_angle as f32,
            wall_transition_filter_deviation: sc(p.wall_transition_filter_deviation),
            wall_distribution_count: p.wall_distribution_count,
            is_top_or_bottom_layer,
            wall_maximum_resolution: sc(p.wall_maximum_resolution),
            wall_maximum_deviation: sc(p.wall_maximum_deviation),
        }
    }
}

/// mm ring -> Orca integer units. Vertices that land on the same integer point (sub-micron pairs left by float booleans)
/// are merged, as they are in Orca where coordinates are integers to begin with.
fn ring_to_int(r: &[[f64; 2]]) -> Ring {
    let mut o: Ring = Vec::with_capacity(r.len());
    for p in r {
        let q = to_int(*p);
        if o.last() != Some(&q) {
            o.push(q);
        }
    }
    while o.len() > 1 && o.first() == o.last() {
        o.pop();
    }
    o
}

fn rings_of(polys: &Polys) -> Vec<Ring> {
    let mut v = vec![];
    for q in polys {
        v.push(ring_to_int(&q.contour));
        for h in &q.holes {
            v.push(ring_to_int(h));
        }
    }
    v
}

/// i_overlay EvenOdd union of loose rings -> regions in mm.
fn evenodd_regions(rings: &[Ring]) -> Polys {
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::core::overlay_rule::OverlayRule;
    use i_overlay::float::single::SingleFloatOverlay;
    let r: Vec<Vec<[f64; 2]>> = rings.iter().filter(|r| r.len() >= 3).map(|r| r.iter().map(|p| [p[0] as f64 / SCALE, p[1] as f64 / SCALE]).collect()).collect();
    if r.is_empty() {
        return vec![];
    }
    let empty: Vec<Vec<[f64; 2]>> = vec![];
    r.overlay(&empty, OverlayRule::Subject, FillRule::EvenOdd)
        .into_iter()
        .map(|mut s| {
            let contour = s.remove(0);
            Poly { contour, holes: s }
        })
        .collect()
}

/// i_overlay NonZero union of loose rings (ClipperUtils `union_(Polygons)`), as rings.
fn nonzero_union_rings(rings: &[Ring]) -> Vec<Ring> {
    use i_overlay::core::fill_rule::FillRule;
    use i_overlay::core::overlay_rule::OverlayRule;
    use i_overlay::float::single::SingleFloatOverlay;
    let r: Vec<Vec<[f64; 2]>> = rings.iter().filter(|r| r.len() >= 3).map(|r| r.iter().map(|p| [p[0] as f64, p[1] as f64]).collect()).collect();
    if r.is_empty() {
        return vec![];
    }
    let empty: Vec<Vec<[f64; 2]>> = vec![];
    let mut out = vec![];
    for s in r.overlay(&empty, OverlayRule::Subject, FillRule::NonZero) {
        for ring in s {
            out.push(ring.iter().map(|p| [p[0].round() as i64, p[1].round() as i64]).collect());
        }
    }
    out
}

pub struct WallToolPathsResult {
    pub toolpaths: Vec<VariableWidthLines>,
    /// `getInnerContour()`: region inside the 0-width marker wall (mm).
    pub inner_contour: Polys,
}

/// `WallToolPaths::generate()` + `getInnerContour()`.
pub fn wall_tool_paths(
    outline: &Polys,
    bead_width_0: i64,
    bead_width_x: i64,
    inset_count: i64,
    wall_0_inset: i64,
    layer_height: f64,
    params: &WallToolPathsParams,
) -> Result<WallToolPathsResult, FdmError> {
    if inset_count < 1 {
        return Ok(WallToolPathsResult { toolpaths: vec![], inner_contour: outline.clone() });
    }
    let smallest_segment = params.wall_maximum_resolution;
    let allowed_distance = params.wall_maximum_deviation;
    let epsilon_offset = (allowed_distance / 2) - 1;
    let transitioning_angle = (params.wall_transition_angle as f64).to_radians();
    let discretization_step_size = 800_000;
    let small_area_length = bead_width_0 as f64 / 2.0;

    let eps_mm = epsilon_offset as f64 / SCALE;
    let o = geo::offset(&geo::offset(&geo::offset(outline, -eps_mm), eps_mm * 2.0), -eps_mm);
    let mut prepared: Vec<Ring> = rings_of(&o);
    simplify_polygons(&mut prepared, smallest_segment, allowed_distance);
    fix_self_intersections(epsilon_offset, &mut prepared);
    remove_degenerate_verts(&mut prepared);
    remove_colinear_edges(&mut prepared, 0.005);
    fix_self_intersections(epsilon_offset, &mut prepared);
    remove_degenerate_verts(&mut prepared);
    remove_small_areas(&mut prepared, small_area_length * small_area_length);
    prepared = nonzero_union_rings(&prepared);
    let area: f64 = prepared.iter().map(ring_area_i).sum();
    if area <= 0.0 {
        return Ok(WallToolPathsResult { toolpaths: vec![], inner_contour: vec![] });
    }

    let k = 1.0 - 0.25 * PI;
    let external_perimeter_extrusion_width = (bead_width_0 as f64 / SCALE + layer_height * k) as f32;
    let perimeter_extrusion_width = (bead_width_x as f64 / SCALE + layer_height * k) as f32;
    let wall_transition_length = params.wall_transition_length;
    let wall_split_middle_threshold = (2.0 * (params.min_bead_width as f64 / SCALE) / external_perimeter_extrusion_width as f64 - 1.0).clamp(0.01, 0.99);
    let wall_add_middle_threshold = ((params.min_bead_width as f64 / SCALE) / perimeter_extrusion_width as f64).clamp(0.01, 0.99);
    let max_bead_count = if inset_count < i64::MAX / 2 { 2 * inset_count } else { i64::MAX };
    let strat = make_strategy(
        bead_width_0,
        bead_width_x,
        wall_transition_length,
        transitioning_angle as f32,
        true,
        params.min_bead_width,
        params.min_feature_size,
        wall_split_middle_threshold,
        wall_add_middle_threshold,
        max_bead_count,
        wall_0_inset,
        params.wall_distribution_count,
    );
    let transition_filter_dist = 100_000_000;
    let skeleton = Skeleton::new(
        &prepared,
        strat.as_ref(),
        strat.transitioning_angle(),
        discretization_step_size,
        transition_filter_dist,
        params.wall_transition_filter_deviation,
        wall_transition_length,
    )?;
    let mut toolpaths = skeleton.generate_toolpaths();

    stitch_tool_paths(&mut toolpaths, bead_width_x);
    remove_small_lines(&mut toolpaths, params);
    let inner_contour = separate_out_inner_contour(&mut toolpaths);
    // simplifyToolPaths
    let s2 = params.wall_maximum_resolution * params.wall_maximum_resolution;
    let a2 = params.wall_maximum_deviation * params.wall_maximum_deviation;
    for lines in toolpaths.iter_mut() {
        for line in lines.iter_mut() {
            line.simplify(s2, a2, 2_000_000);
        }
    }
    toolpaths.retain(|l| !l.is_empty());
    Ok(WallToolPathsResult { toolpaths, inner_contour })
}

fn shorter_than_line(line: &ExtrusionLine, check_length: i64) -> bool {
    let n = line.junctions.len();
    if n == 0 {
        return true;
    }
    let mut p0 = line.junctions[n - 1].p;
    let mut length: i64 = 0;
    for j in &line.junctions {
        length += dist_i(p0, j.p);
        if length >= check_length {
            return false;
        }
        p0 = j.p;
    }
    true
}

fn remove_small_lines(toolpaths: &mut Vec<VariableWidthLines>, params: &WallToolPathsParams) {
    for inset in toolpaths.iter_mut() {
        let mut idx = 0;
        while idx < inset.len() {
            let min_width = inset[idx].junctions.iter().map(|j| j.w).min().unwrap_or(i64::MAX);
            let check = if params.is_top_or_bottom_layer { min_width / 2 } else { (min_width as f32 * params.min_length_factor) as i64 };
            if inset[idx].is_odd && !inset[idx].is_closed && shorter_than_line(&inset[idx], check) {
                let last = inset.len() - 1;
                inset.swap(idx, last);
                inset.pop();
            } else {
                idx += 1;
            }
        }
    }
}

fn separate_out_inner_contour(toolpaths: &mut Vec<VariableWidthLines>) -> Polys {
    let mut actual: Vec<VariableWidthLines> = vec![];
    let mut inner_contour_rings: Vec<Ring> = vec![];
    for inset in toolpaths.iter() {
        if inset.is_empty() {
            continue;
        }
        let mut is_contour = false;
        for line in inset {
            if let Some(j) = line.junctions.first() {
                is_contour = j.w == 0;
            }
        }
        if is_contour {
            for line in inset {
                if line.is_odd {
                    continue;
                } else if line.is_closed {
                    inner_contour_rings.push(line.junctions.iter().map(|j| j.p).collect());
                }
            }
        } else {
            actual.push(inset.clone());
        }
    }
    *toolpaths = actual;
    evenodd_regions(&inner_contour_rings)
}

// ---- PolylineStitcher<VariableWidthLines, ExtrusionLine, ExtrusionJunction>::stitch
fn stitch_lines(lines: &[ExtrusionLine], max_stitch_distance: i64, snap_distance: i64) -> (Vec<ExtrusionLine>, Vec<ExtrusionLine>) {
    let mut result_lines: Vec<ExtrusionLine> = vec![];
    let mut result_polygons: Vec<ExtrusionLine> = vec![];
    if lines.is_empty() {
        return (result_lines, result_polygons);
    }
    // endpoint index (poly_idx, point_idx)
    let mut endpoints: Vec<(usize, usize)> = vec![];
    for (i, l) in lines.iter().enumerate() {
        endpoints.push((i, 0));
        endpoints.push((i, l.junctions.len() - 1));
    }
    let mut processed = vec![false; lines.len()];
    for line_idx in 0..lines.len() {
        if processed[line_idx] {
            continue;
        }
        processed[line_idx] = true;
        let line = &lines[line_idx];
        let mut should_close = line.is_odd;
        let mut chain = line.clone();
        let mut closest_is_closing_polygon = false;
        for go_in_reverse_direction in [false, true] {
            if go_in_reverse_direction {
                chain.junctions.reverse();
            }
            let mut chain_length = chain.length();
            loop {
                let from = chain.junctions.last().unwrap().p;
                let mut closest: Option<(usize, usize)> = None;
                let mut closest_distance = i64::MAX;
                for &(pi, pidx) in &endpoints {
                    let np = lines[pi].junctions[pidx].p;
                    let mut is_closing_segment = false;
                    let mut dist = dist_i(np, from);
                    if dist > max_stitch_distance {
                        continue;
                    }
                    let d = sub(np, chain.junctions[0].p);
                    if d[0] * d[0] + d[1] * d[1] < snap_distance * snap_distance {
                        if chain_length + dist < 3 * max_stitch_distance || chain.junctions.len() <= 2 {
                            continue;
                        }
                        is_closing_segment = true;
                        if !should_close {
                            dist += 10_000;
                        } else {
                            dist -= 10_000;
                        }
                    } else if processed[pi] {
                        continue;
                    }
                    let nearby_would_be_reversed = (pidx != 0) != go_in_reverse_direction;
                    if !lines[pi].is_odd && nearby_would_be_reversed {
                        continue;
                    }
                    if chain.is_odd != lines[pi].is_odd {
                        continue;
                    }
                    if dist < closest_distance {
                        closest_distance = dist;
                        closest = Some((pi, pidx));
                        closest_is_closing_polygon = is_closing_segment;
                    }
                    if dist < snap_distance {
                        break;
                    }
                }
                let Some((cpi, cpidx)) = closest else { break };
                if closest_is_closing_polygon {
                    break;
                }
                let segment_dist = dist_i(chain.junctions.last().unwrap().p, lines[cpi].junctions[cpidx].p);
                let old_size = chain.junctions.len();
                let src = &lines[cpi].junctions;
                if cpidx == 0 {
                    let start = if segment_dist < snap_distance { 1 } else { 0 };
                    chain.junctions.extend(src[start..].iter().cloned());
                } else {
                    let start = if segment_dist < snap_distance { 1 } else { 0 };
                    chain.junctions.extend(src.iter().rev().skip(start).cloned());
                }
                for i in old_size..chain.junctions.len() {
                    chain_length += dist_i(chain.junctions[i].p, chain.junctions[i - 1].p);
                }
                should_close = should_close && !lines[cpi].is_odd;
                processed[cpi] = true;
            }
            if closest_is_closing_polygon {
                if go_in_reverse_direction {
                    chain.junctions.reverse();
                }
                break;
            }
        }
        if closest_is_closing_polygon {
            result_polygons.push(chain);
        } else {
            if !line.is_odd {
                chain.junctions.reverse();
            }
            result_lines.push(chain);
        }
    }
    (result_lines, result_polygons)
}

fn stitch_tool_paths(toolpaths: &mut Vec<VariableWidthLines>, bead_width_x: i64) {
    let stitch_distance = bead_width_x - 1;
    for wall_lines in toolpaths.iter_mut() {
        let (stitched, closed) = stitch_lines(wall_lines, stitch_distance, 10_000);
        *wall_lines = stitched;
        for mut wp in closed {
            if wp.junctions.is_empty() {
                continue;
            }
            let (f, l) = (wp.junctions[0], *wp.junctions.last().unwrap());
            if f.p != l.p && (((l.p[0] - f.p[0]) as f64).hypot((l.p[1] - f.p[1]) as f64)) < stitch_distance as f64 {
                wp.junctions.push(f);
            }
            wp.is_closed = true;
            wall_lines.push(wp);
        }
    }
}

// =====================================================================================================================
// PerimeterGenerator::process_arachne
// =====================================================================================================================
/// `VariableWidth.cpp::thick_polyline_to_multi_path`: widths are spacing-like junction widths (scaled ints); result paths carry the
/// Orca extrusion width in mm (`w + h*(1-pi/4)`) unless `keep_flow_width` (bridge overhang flow).
fn thick_polyline_to_multi_path(pts: &[Pt], widths: &[i64], height: f64, keep_flow_width: Option<f64>, tolerance: i64, merge_tolerance: i64) -> Vec<(Vec<Pt>, f64)> {
    #[derive(Clone, Copy)]
    struct TL {
        a: Pt,
        b: Pt,
        aw: i64,
        bw: i64,
    }
    let mut lines: Vec<TL> = (0..pts.len().saturating_sub(1)).map(|i| TL { a: pts[i], b: pts[i + 1], aw: widths[i], bw: widths[i + 1] }).collect();
    let mut paths: Vec<(Vec<Pt>, f64)> = vec![];
    let mut cur: Vec<Pt> = vec![];
    let mut cur_w = 0.0f64;
    let k = 1.0 - 0.25 * PI;
    let mut i: usize = 0;
    while i < lines.len() {
        let line = lines[i];
        let line_len = norm_i(sub(line.b, line.a)) as f64;
        if line_len < 100.0 {
            if !cur.is_empty() {
                *cur.last_mut().unwrap() = line.b;
            } else if i + 1 < lines.len() {
                lines[i + 1].a = line.a;
            } else if let Some(last) = paths.last_mut() {
                *last.0.last_mut().unwrap() = line.b;
            }
            i += 1;
            continue;
        }
        let thickness_delta = (line.aw - line.bw).abs();
        if thickness_delta > tolerance {
            let segments = ((thickness_delta as f64 / tolerance as f64).ceil() as usize).max(2);
            let seg_len = line_len / segments as f64;
            let dir = [(line.b[0] - line.a[0]) as f64 / line_len, (line.b[1] - line.a[1]) as f64 / line_len];
            let mut pp: Vec<Pt> = vec![line.a];
            let mut wd: Vec<i64> = vec![line.aw];
            for j in 1..segments {
                pp.push([(line.a[0] as f64 + dir[0] * (j as f64 * seg_len)) as i64, (line.a[1] as f64 + dir[1] * (j as f64 * seg_len)) as i64]);
                let w = (line.aw as f64 + (j as f64 * seg_len) * (line.bw - line.aw) as f64 / line_len) as i64;
                wd.push(w);
                wd.push(w);
            }
            pp.push(line.b);
            wd.push(line.bw);
            lines.remove(i);
            for j in 0..segments {
                lines.insert(i + j, TL { a: pp[j], b: pp[j + 1], aw: wd[2 * j], bw: wd[2 * j + 1] });
            }
            continue;
        }
        let w = line.aw.max(line.bw);
        let new_width = keep_flow_width.unwrap_or(w as f64 / SCALE + height * k);
        if cur.is_empty() {
            cur.push(line.a);
            cur.push(line.b);
            cur_w = new_width;
        } else {
            let d = ((cur_w - new_width).abs() * SCALE) as i64; // scaled(|path.width - new_flow.width()|)
            if d as f64 <= merge_tolerance as f64 {
                cur.push(line.b);
            } else {
                paths.push((std::mem::take(&mut cur), cur_w));
                continue; // --i; re-process this line as the first of a new path
            }
        }
        i += 1;
    }
    if cur.len() >= 2 {
        paths.push((cur, cur_w));
    }
    paths
}

/// Clip an open polyline with per-point widths against `region` (mm); returns the pieces inside (or outside) with widths
/// interpolated at the cut points (ClipperLib_Z + the ZFillFunction of `clip_extrusion`).
fn clip_path_by_region(path: &[(Pt, i64)], region: &Polys, keep_inside: bool) -> Vec<Vec<(Pt, i64)>> {
    let idx = geo::RegionIndex::new(region);
    let mut cand: Vec<u32> = vec![];
    let mut out: Vec<Vec<(Pt, i64)>> = vec![];
    let mut cur: Vec<(Pt, i64)> = vec![];
    let mut cur_in: Option<bool> = None;
    for w in path.windows(2) {
        let ((a, wa), (b, wb)) = (w[0], w[1]);
        let (am, bm) = (to_mm(a), to_mm(b));
        let l = geo::len(am, bm);
        let mut ts: Vec<f64> = vec![0.0, 1.0];
        if l > 0.0 {
            idx.seg_candidates(am, bm, &mut cand);
            for &ek in &cand {
                let (c, d) = idx.edge(ek);
                if let Some(ip) = geo::seg_intersection(am, bm, c, d) {
                    let t = geo::len(am, ip) / l;
                    if t > 1e-9 && t < 1.0 - 1e-9 {
                        ts.push(t);
                    }
                }
            }
        }
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap());
        ts.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
        let at = |t: f64| -> (Pt, i64) {
            if t <= 0.0 {
                (a, wa)
            } else if t >= 1.0 {
                (b, wb)
            } else {
                ([(a[0] as f64 + (b[0] - a[0]) as f64 * t).round() as i64, (a[1] as f64 + (b[1] - a[1]) as f64 * t).round() as i64], (wa as f64 + (wb - wa) as f64 * t) as i64)
            }
        };
        for tw in ts.windows(2) {
            let (p0, p1) = (at(tw[0]), at(tw[1]));
            let mid = [(to_mm(p0.0)[0] + to_mm(p1.0)[0]) * 0.5, (to_mm(p0.0)[1] + to_mm(p1.0)[1]) * 0.5];
            let is_in = idx.contains(mid) || idx.near_boundary(mid, 1e-7);
            if cur_in != Some(is_in) {
                if cur.len() >= 2 && cur_in == Some(keep_inside) {
                    out.push(std::mem::take(&mut cur));
                } else {
                    cur.clear();
                }
                cur_in = Some(is_in);
                cur.push(p0);
            }
            if cur_in == Some(keep_inside) {
                cur.push(p1);
            }
        }
    }
    if cur.len() >= 2 && cur_in == Some(keep_inside) {
        out.push(cur);
    }
    out
}

fn line_to_wpts(l: &ExtrusionLine) -> Vec<(Pt, i64)> {
    l.junctions.iter().map(|j| (j.p, j.w)).collect()
}

fn chain_wpaths(paths: &mut Vec<(Feature, Vec<Pt>, f64, f64)>, start: Pt) {
    // chain_and_reorder_extrusion_paths: greedy nearest endpoint, reversals allowed
    let n = paths.len();
    let mut used = vec![false; n];
    let mut out: Vec<(Feature, Vec<Pt>, f64, f64)> = vec![];
    let mut cur = start;
    for _ in 0..n {
        let mut best: Option<(usize, bool, i64)> = None;
        for i in 0..n {
            if used[i] {
                continue;
            }
            let d0 = dist_i(cur, paths[i].1[0]);
            if best.map_or(true, |b| d0 < b.2) {
                best = Some((i, false, d0));
            }
            let d1 = dist_i(cur, *paths[i].1.last().unwrap());
            if best.map_or(true, |b| d1 < b.2) {
                best = Some((i, true, d1));
            }
        }
        let (i, rev, _) = best.unwrap();
        used[i] = true;
        let mut p = paths[i].clone();
        if rev {
            p.1.reverse();
        }
        cur = *p.1.last().unwrap();
        out.push(p);
    }
    *paths = out;
}

/// Minimum distance between two polylines (`MultiPoint::minimumDistanceBetweenLinesDefinedByPoints`).
fn min_distance_between_polylines(a: &[Pt], b: &[Pt]) -> f64 {
    let am: Vec<P2> = a.iter().map(|p| to_mm(*p)).collect();
    let bm: Vec<P2> = b.iter().map(|p| to_mm(*p)).collect();
    let mut best = f64::INFINITY;
    for i in 0..am.len().saturating_sub(1) {
        for j in 0..bm.len().saturating_sub(1) {
            if geo::seg_intersection(am[i], am[i + 1], bm[j], bm[j + 1]).is_some() {
                return 0.0;
            }
        }
    }
    for p in &am {
        for j in 0..bm.len().saturating_sub(1) {
            best = best.min(geo::dist_pt_seg(*p, bm[j], bm[j + 1]));
        }
    }
    for p in &bm {
        for j in 0..am.len().saturating_sub(1) {
            best = best.min(geo::dist_pt_seg(*p, am[j], am[j + 1]));
        }
    }
    best * SCALE
}

/// `WallToolPaths::getRegionOrder`
fn get_region_order(input: &[ExtrusionLine], outer_to_inner: bool) -> BTreeSet<(usize, usize)> {
    let mut order: BTreeSet<(usize, usize)> = BTreeSet::new();
    let mut max_line_w = 0;
    for l in input {
        for j in &l.junctions {
            max_line_w = max_line_w.max(j.w);
        }
    }
    if max_line_w == 0 {
        return order;
    }
    let diagonal_extension = 1.9f32;
    let searching_radius = (max_line_w as f32 * diagonal_extension) as i64;
    // grid
    let cell = searching_radius.max(1);
    let mut grid: BTreeMap<(i64, i64), Vec<(usize, usize)>> = BTreeMap::new();
    for (li, l) in input.iter().enumerate() {
        for (ji, j) in l.junctions.iter().enumerate() {
            grid.entry((j.p[0].div_euclid(cell), j.p[1].div_euclid(cell))).or_default().push((li, ji));
        }
    }
    for (li, l) in input.iter().enumerate() {
        for j in l.junctions.iter() {
            let (cx, cy) = (j.p[0].div_euclid(cell), j.p[1].div_euclid(cell));
            for gx in cx - 1..=cx + 1 {
                for gy in cy - 1..=cy + 1 {
                    let Some(v) = grid.get(&(gx, gy)) else { continue };
                    for &(ni, nj) in v {
                        let nearby = &input[ni];
                        if ni == li {
                            continue;
                        }
                        let nj_ = &nearby.junctions[nj];
                        if dist_i(nj_.p, j.p) > searching_radius {
                            continue;
                        }
                        if nearby.inset_idx == l.inset_idx {
                            continue;
                        }
                        if nearby.inset_idx > l.inset_idx + 1 {
                            continue;
                        }
                        if l.inset_idx > nearby.inset_idx + 1 {
                            continue;
                        }
                        if !shorter_then(sub(j.p, nj_.p), (((j.w + nj_.w) / 2) as f32 * diagonal_extension) as i64) {
                            continue;
                        }
                        let (here, nb) = (li, ni);
                        if l.is_odd || nearby.is_odd {
                            if l.is_odd && !nearby.is_odd && nearby.inset_idx < l.inset_idx {
                                order.insert((nb, here));
                            }
                            if nearby.is_odd && !l.is_odd && l.inset_idx < nearby.inset_idx {
                                order.insert((here, nb));
                            }
                        } else if (nearby.inset_idx < l.inset_idx) == outer_to_inner {
                            order.insert((nb, here));
                        } else {
                            order.insert((here, nb));
                        }
                    }
                }
            }
        }
    }
    order
}

struct ArachneExtrusion {
    idx: usize, // index into the flat line list
    is_contour: bool,
}

pub fn generate_arachne(region: &Polys, lower: Option<&Polys>, upper: Option<&Polys>, p: &WallParams) -> Result<WallResult, FdmError> {
    crate::walls::refuse_unsupported(p)?;
    let h = p.layer_h;
    let k = 1.0 - 0.25 * PI;
    let spacing_of = |w: f64| w - h * k;
    let ext_sp = spacing_of(p.ext_width);
    let sp = spacing_of(p.inner_width);
    if ext_sp <= 0.0 || sp <= 0.0 {
        return Err(FdmError::Unsupported("Flow::spacing() produced negative spacing".into()));
    }
    let ext_perimeter_spacing2 = 0.5 * (ext_sp + sp);
    let solid_sp = spacing_of(p.solid_infill_width);
    let grown_lower: Option<Polys> = match (lower, p.detect_overhang_wall) {
        (Some(l), true) => Some(geo::offset(l, p.nozzle / 2.0)),
        _ => None,
    };
    let surface_simplify_resolution = if p.enable_arc_fitting && !p.fuzzy_skin { 0.2 * p.resolution } else { p.resolution };
    let has_top_shell = p.top_shell_layers > 0;
    let has_bottom_shell = p.bottom_shell_layers > 0;
    let only_one_wall_top = p.only_one_wall_top && has_top_shell;
    let only_one_wall_first_layer = p.only_one_wall_first_layer && has_bottom_shell;
    let top_fill_replaces = has_top_shell && p.top_surface_density > 0.0 && p.top_surface_expansion > 0.0;

    let mut result = WallResult::default();
    let mut infill_all: Polys = vec![];
    let mut no_overlap_all: Polys = vec![];

    for surface in region.iter() {
        let bead_width_0 = sc(ext_sp);
        let perimeter_spacing = sc(sp);
        let mut loop_number: i32 = p.wall_loops + p.extra_perimeters - 1;
        if p.alternate_extra_wall && p.layer_id % 2 == 1 && !p.spiral_vase && p.sparse_infill_density > 0.0 {
            loop_number += 1;
        }
        let is_bottom_layer = p.layer_id == p.raft_layers;
        if is_bottom_layer && only_one_wall_first_layer {
            loop_number = 0;
        }
        let is_topmost_layer = upper.is_none();
        if is_topmost_layer && loop_number > 0 && only_one_wall_top {
            loop_number = 0;
        }
        let apply_precise_outer_wall = p.precise_outer_wall && p.wall_sequence == WallSequence::InnerOuter;
        let simp = geo::simplify_polys(&vec![surface.clone()], surface_simplify_resolution);
        let last: Polys = geo::offset(&simp, if apply_precise_outer_wall { -(p.ext_width - ext_sp) } else { -(p.ext_width / 2.0 - ext_sp / 2.0) });
        let mut input_params = WallToolPathsParams::from_params(p, false);
        input_params.is_top_or_bottom_layer = is_bottom_layer || is_topmost_layer;
        let wall_0_inset: i64 = if apply_precise_outer_wall { -sc(p.ext_width / 2.0 - ext_sp / 2.0) } else { 0 };

        let mut top_expolygons: Polys = vec![];
        let inner_loop_number: i32 = if only_one_wall_top && upper.is_some() { loop_number - 1 } else { -1 };
        if only_one_wall_top && loop_number > 0 {
            loop_number = 0;
        }
        let wtp = wall_tool_paths(&last, bead_width_0, perimeter_spacing, loop_number as i64 + 1, wall_0_inset, h, &input_params)?;
        let mut perimeters: Vec<VariableWidthLines> = wtp.toolpaths;
        let mut infill_contour: Polys = geo::union(&wtp.inner_contour);

        if inner_loop_number >= 0 {
            let perimeter_width = p.inner_width;
            let upper_clipped = upper.cloned().unwrap_or_default();
            top_expolygons = geo::diff(&infill_contour, &upper_clipped);
            if !top_expolygons.is_empty() {
                if let Some(lo) = lower {
                    let bridge_offset = ext_sp.max(perimeter_width);
                    let bridges = geo::offset(&geo::diff(&top_expolygons, lo), bridge_offset);
                    top_expolygons = geo::diff(&top_expolygons, &bridges);
                }
                let mw = if p.min_width_top_surface_percent { perimeter_width * p.min_width_top_surface / 100.0 } else { p.min_width_top_surface };
                let top_surface_min_width = (ext_sp / 4.0 + 0.00001).max(mw / 4.0);
                top_expolygons = geo::offset2(&top_expolygons, -top_surface_min_width, top_surface_min_width + perimeter_width * 0.85);
                top_expolygons = geo::inter(&top_expolygons, &infill_contour);
                let clip_walls_over_top = top_fill_replaces;
                let inner_region = geo::offset(&if clip_walls_over_top { infill_contour.clone() } else { geo::diff(&infill_contour, &top_expolygons) }, wall_0_inset as f64 / SCALE);
                let iw = wall_tool_paths(&inner_region, perimeter_spacing, perimeter_spacing, inner_loop_number as i64 + 1, 0, h, &input_params)?;
                let mut inner_perimeters = iw.toolpaths;
                if clip_walls_over_top {
                    let kept_over_top = clip_inner_walls_over_top(&mut inner_perimeters, &top_expolygons, sc(perimeter_width));
                    if !kept_over_top.is_empty() {
                        top_expolygons = geo::diff(&top_expolygons, &kept_over_top);
                    }
                }
                if !perimeters.is_empty() {
                    for ip in inner_perimeters.iter_mut() {
                        for el in ip.iter_mut() {
                            el.inset_idx += 1;
                        }
                    }
                }
                perimeters.extend(inner_perimeters);
                infill_contour = geo::union2(&top_expolygons, &iw.inner_contour);
            } else {
                let ns = wall_tool_paths(&last, bead_width_0, perimeter_spacing, inner_loop_number as i64 + 2, wall_0_inset, h, &input_params)?;
                perimeters = ns.toolpaths;
                infill_contour = geo::union(&ns.inner_contour);
            }
        }
        let loop_number_final = perimeters.len() as i32 - 1;

        // ---- ordering
        let mut is_outer_wall_first = p.wall_sequence == WallSequence::OuterInner || p.wall_sequence == WallSequence::InnerOuterInner;
        if p.layer_id == 0 {
            is_outer_wall_first = p.wall_sequence == WallSequence::OuterInner;
        }
        let (start_perimeter, end_perimeter, direction): (i64, i64, i64) = if is_outer_wall_first { (0, perimeters.len() as i64, 1) } else { (perimeters.len() as i64 - 1, -1, -1) };
        let mut all_lines: Vec<ExtrusionLine> = vec![];
        let mut pi = start_perimeter;
        while pi != end_perimeter {
            for w in perimeters[pi as usize].iter() {
                all_lines.push(w.clone());
            }
            pi += direction;
        }
        let constraints = get_region_order(&all_lines, is_outer_wall_first);
        let n = all_lines.len();
        let mut blocked = vec![0usize; n];
        let mut blocking: Vec<Vec<usize>> = vec![vec![]; n];
        for &(before, after) in &constraints {
            blocked[after] += 1;
            blocking[before].push(after);
        }
        let mut processed = vec![false; n];
        let mut current_position = all_lines.first().and_then(|l| l.junctions.first()).map(|j| j.p).unwrap_or([0, 0]);
        let mut ordered: Vec<ArachneExtrusion> = vec![];
        while ordered.len() < n {
            let mut best_candidate = 0usize;
            let mut best_distance = f64::MAX;
            let mut is_best_closed = false;
            let mut available: Vec<usize> = (0..n).filter(|&c| !processed[c] && blocked[c] == 0).collect();
            if available.is_empty() {
                // dependency cycle (should not happen): release everything
                available = (0..n).filter(|&c| !processed[c]).collect();
            }
            available.sort_by_key(|&a| all_lines[a].is_closed as u8);
            for &cand in &available {
                let path = &all_lines[cand];
                if path.junctions.is_empty() {
                    if best_distance == f64::MAX {
                        best_candidate = cand;
                        is_best_closed = path.is_closed;
                    }
                    continue;
                }
                let cp = path.junctions[0].p;
                let d = ((current_position[0] - cp[0]) as f64).hypot((current_position[1] - cp[1]) as f64);
                if d < best_distance && (path.is_closed || (!path.is_closed && best_distance != f64::MAX) || (!path.is_closed && !is_best_closed)) {
                    best_candidate = cand;
                    best_distance = d;
                    is_best_closed = path.is_closed;
                }
            }
            if available.iter().all(|&c| c != best_candidate) {
                best_candidate = available[0];
            }
            let best = &all_lines[best_candidate];
            ordered.push(ArachneExtrusion { idx: best_candidate, is_contour: best.is_contour() });
            processed[best_candidate] = true;
            for &u in &blocking[best_candidate] {
                if blocked[u] > 0 {
                    blocked[u] -= 1;
                }
            }
            if !best.junctions.is_empty() {
                current_position = if best.is_closed { best.junctions[0].p } else { best.junctions.last().unwrap().p };
            }
        }

        if p.wall_sequence == WallSequence::InnerOuterInner && p.layer_id > 0 && ordered.len() > 2 {
            ordered = inner_outer_inner_reorder(&all_lines, ordered, p, apply_precise_outer_wall, ext_sp, sp);
        }

        // ---- extrusions -> paths
        let wall_paths = traverse_extrusions(&all_lines, &ordered, p, grown_lower.as_ref());
        result.paths.extend(wall_paths);

        // ---- infill region
        let spacing = if perimeters.len() == 1 { ext_perimeter_spacing2 } else { sp };
        if geo::offset(&infill_contour, -(spacing / 2.0)).is_empty() {
            infill_contour.clear();
        }
        let mut inset = if loop_number_final < 0 { 0.0 } else if loop_number_final == 0 { ext_sp } else { sp };
        let top_inset = p.top_bottom_infill_wall_overlap * inset / 100.0;
        if is_topmost_layer || is_bottom_layer {
            inset = p.top_bottom_infill_wall_overlap * inset / 100.0;
        } else {
            inset = p.infill_wall_overlap * inset / 100.0;
        }
        let not_filled = geo::union(&geo::simplify_polys(&infill_contour, p.resolution));
        let min_pis = solid_sp * (1.0 - crate::walls::INSET_OVERLAP_TOLERANCE);
        let mut infill_exp = geo::offset2(&not_filled, -min_pis / 2.0, inset + min_pis / 2.0);
        if !top_expolygons.is_empty() {
            infill_exp = geo::union2(&infill_exp, &geo::offset(&top_expolygons, top_inset));
        }
        infill_all.extend(infill_exp);
        let mut without_overlap = geo::offset2(&not_filled, -min_pis / 2.0, min_pis / 2.0);
        if !top_expolygons.is_empty() {
            without_overlap = geo::union2(&without_overlap, &top_expolygons);
        }
        no_overlap_all.extend(without_overlap);
    }
    result.infill_region = geo::union(&infill_all);
    result.infill_no_overlap = no_overlap_all;
    Ok(result)
}

/// `clip_inner_walls_over_top` (only_one_wall_top with top_surface_expansion > 0).
fn clip_inner_walls_over_top(inner_perimeters: &mut Vec<VariableWidthLines>, top_region: &Polys, perimeter_width: i64) -> Polys {
    let mut kept_over_top: Polys = vec![];
    let clip_region = geo::offset(top_region, perimeter_width as f64 / SCALE / 2.0);
    for inner in inner_perimeters.iter_mut() {
        let mut kept: VariableWidthLines = vec![];
        for el in inner.drain(..) {
            if el.junctions.is_empty() {
                continue;
            }
            let inside = el.junctions.iter().filter(|j| geo::region_contains(top_region, to_mm(j.p))).count();
            if inside == 0 {
                kept.push(el);
                continue;
            }
            if inside == el.junctions.len() {
                continue;
            }
            let subject = line_to_wpts(&el);
            let mut pieces = clip_path_by_region(&subject, &clip_region, false);
            // stitch pieces that share an endpoint
            let mut i = 0;
            while i < pieces.len() {
                let mut j = i + 1;
                while j < pieces.len() {
                    let same = |a: Pt, b: Pt| (a[0] - b[0]).abs() <= 100 && (a[1] - b[1]).abs() <= 100;
                    let (af, al) = (pieces[i][0].0, pieces[i].last().unwrap().0);
                    let (bf, bl) = (pieces[j][0].0, pieces[j].last().unwrap().0);
                    if same(af, bf) || same(af, bl) {
                        pieces[i].reverse();
                    }
                    let al2 = pieces[i].last().unwrap().0;
                    if same(al2, bl) {
                        pieces[j].reverse();
                    }
                    let _ = (al, af);
                    let bf2 = pieces[j][0].0;
                    if same(pieces[i].last().unwrap().0, bf2) {
                        let b = pieces.remove(j);
                        pieces[i].extend(b.into_iter().skip(1));
                        j = i + 1;
                    } else {
                        j += 1;
                    }
                }
                i += 1;
            }
            let kept_length: f64 = pieces.iter().map(|pc| pc.windows(2).map(|w| dist_i(w[0].0, w[1].0) as f64).sum::<f64>()).sum();
            let subject_len: f64 = subject.windows(2).map(|w| dist_i(w[0].0, w[1].0) as f64).sum();
            if subject_len - kept_length < 2.0 * perimeter_width as f64 {
                let width = el.junctions.iter().map(|j| j.w).max().unwrap_or(0);
                let pts: Vec<P2> = el.junctions.iter().map(|j| to_mm(j.p)).collect();
                kept_over_top.extend(crate::walls::stroke_polys(&pts, width as f64 / SCALE / 2.0));
                kept.push(el);
                continue;
            }
            for pc in pieces {
                let mut c = ExtrusionLine::new(el.inset_idx, el.is_odd);
                c.junctions = pc.iter().map(|(pt, w)| Junction { p: *pt, w: *w, perimeter_index: el.inset_idx }).collect();
                if c.junctions.len() >= 2 && c.length() >= perimeter_width {
                    kept.push(c);
                }
            }
        }
        *inner = kept;
    }
    geo::union(&kept_over_top)
}

/// `traverse_extrusions`: overhang splitting, variable-width path conversion, loop orientation.
fn traverse_extrusions(all_lines: &[ExtrusionLine], ordered: &[ArachneExtrusion], p: &WallParams, grown_lower: Option<&Polys>) -> Vec<ExtPath> {
    let h = p.layer_h;
    let mut entities: Vec<Vec<ExtPath>> = vec![];
    let n_ext = ordered.len();
    for pg in ordered {
        let line = &all_lines[pg.idx];
        if line.junctions.is_empty() {
            continue;
        }
        let is_external = line.inset_idx == 0;
        let role_feature = if is_external { Feature::OuterWall } else { Feature::InnerWall };
        let is_closed = line.is_closed;
        // loop orientation (closed): ccw iff (wall_direction == ccw) == (is_contour || pg_extrusions.size() == 2)
        let mut junctions = line.junctions.clone();
        if is_closed {
            let want_ccw = p.wall_ccw == (pg.is_contour || n_ext == 2);
            let pts: Ring = junctions.iter().map(|j| j.p).collect();
            let is_ccw = ring_area_i(&pts) > 0.0;
            if is_ccw != want_ccw {
                junctions.reverse();
            }
        }
        let subject: Vec<(Pt, i64)> = junctions.iter().map(|j| (j.p, j.w)).collect();
        let bridge_flow = p.overhang_height != h || p.thick_bridges;
        let mut paths: Vec<(Feature, Vec<Pt>, f64, f64)> = vec![]; // feature, pts, width(mm), height
        if let (true, true, Some(gl)) = (p.detect_overhang_wall, p.layer_id > p.raft_layers, grown_lower) {
            let inside = clip_path_by_region(&subject, gl, true);
            for pc in &inside {
                let pts: Vec<Pt> = pc.iter().map(|x| x.0).collect();
                let ws: Vec<i64> = pc.iter().map(|x| x.1).collect();
                for (pp, w) in thick_polyline_to_multi_path(&pts, &ws, h, None, 50_000, 100) {
                    paths.push((role_feature, pp, w, h));
                }
            }
            let outside = clip_path_by_region(&subject, gl, false);
            for pc in &outside {
                let pts: Vec<Pt> = pc.iter().map(|x| x.0).collect();
                let ws: Vec<i64> = pc.iter().map(|x| x.1).collect();
                let keep = if bridge_flow { Some(p.overhang_width) } else { None };
                for (pp, w) in thick_polyline_to_multi_path(&pts, &ws, p.overhang_height, keep, 50_000, 100) {
                    paths.push((Feature::OverhangWall, pp, w, p.overhang_height));
                }
            }
            if !paths.is_empty() {
                let mut start_point = paths[0].1[0];
                if !is_closed {
                    // prefer a non-overhang end as the starting point
                    let mut occ: BTreeMap<Pt, (usize, bool)> = BTreeMap::new();
                    for (f, pp, _, _) in &paths {
                        for pt in [pp[0], *pp.last().unwrap()] {
                            let e = occ.entry(pt).or_insert((0, false));
                            e.0 += 1;
                            if *f == Feature::OverhangWall {
                                e.1 = true;
                            }
                        }
                    }
                    for (pt, (cnt, is_oh)) in &occ {
                        if *cnt == 1 {
                            start_point = *pt;
                            if !*is_oh {
                                break;
                            }
                        }
                    }
                }
                chain_wpaths(&mut paths, start_point);
            }
        } else {
            let pts: Vec<Pt> = junctions.iter().map(|j| j.p).collect();
            let ws: Vec<i64> = junctions.iter().map(|j| j.w).collect();
            for (pp, w) in thick_polyline_to_multi_path(&pts, &ws, h, None, 50_000, 100) {
                paths.push((role_feature, pp, w, h));
            }
        }
        if paths.is_empty() {
            continue;
        }
        let thin_wall_hole = !pg.is_contour && n_ext == 2;
        let mut loop_paths: Vec<ExtPath> = vec![];
        for (feat, pp, w, hh) in &paths {
            let mut pts: Vec<PathPt> = pp.iter().map(|q| PathPt { x: q[0] as f64 / SCALE, y: q[1] as f64 / SCALE, w: *w }).collect();
            let mut closed = false;
            if is_closed && paths.len() == 1 && pp.len() > 2 && pp[0] == *pp.last().unwrap() {
                pts.pop();
                closed = true;
            }
            loop_paths.push(ExtPath { feature: *feat, pts, closed, layer_h: *hh, speed: 0.0, flow_ratio: 1.0 });
        }
        entities.push(loop_paths);
        if is_closed && thin_wall_hole && p.wall_sequence != WallSequence::OuterInner {
            // Orca: reverse(extrusion_coll.entities) -- the whole collection built so far
            entities.reverse();
        }
    }
    entities.into_iter().flatten().collect()
}

/// InnerOuterInner for Arachne: `reorderPerimetersByProximity` followed by the sandwich re-ordering.
fn inner_outer_inner_reorder(all_lines: &[ExtrusionLine], mut ordered: Vec<ArachneExtrusion>, p: &WallParams, apply_precise_outer_wall: bool, ext_sp: f64, sp: f64) -> Vec<ArachneExtrusion> {
    // bringContoursToFront: stable partition of (is_contour && inset_idx == 0)
    let (mut front, back): (Vec<ArachneExtrusion>, Vec<ArachneExtrusion>) = ordered.drain(..).partition(|e| e.is_contour && all_lines[e.idx].inset_idx == 0);
    front.extend(back);
    let ordered = front;
    let threshold_external = sc(if apply_precise_outer_wall { ext_sp + sp / 2.0 } else { ext_sp / 2.0 + sp / 2.0 });
    let threshold_internal = sc(sp);
    let _ = p;
    // reorderPerimetersByProximity
    let touching = |reference: &BTreeSet<usize>, considered_inset_idx: usize| -> Vec<usize> {
        let mut t: BTreeSet<usize> = BTreeSet::new();
        for &ri in reference {
            let rl = &all_lines[ordered[ri].idx];
            let rp: Vec<Pt> = rl.junctions.iter().map(|j| j.p).collect();
            for i in 0..ordered.len() {
                if reference.contains(&i) {
                    continue;
                }
                let l = &all_lines[ordered[i].idx];
                if l.inset_idx == 0 || l.inset_idx != considered_inset_idx {
                    continue;
                }
                let pts: Vec<Pt> = l.junctions.iter().map(|j| j.p).collect();
                let d = min_distance_between_polylines(&rp, &pts);
                let thr = if rl.inset_idx == 0 { threshold_external } else { threshold_internal };
                if d <= thr as f64 {
                    t.insert(i);
                }
            }
        }
        t.into_iter().collect()
    };
    let mut reordered: Vec<usize> = vec![]; // indices into `ordered`
    let mut included: BTreeSet<usize> = BTreeSet::new();
    let len_of = |i: usize| all_lines[ordered[i].idx].length();
    for ref_idx in 0..ordered.len() {
        if all_lines[ordered[ref_idx].idx].inset_idx == 0 && !included.contains(&ref_idx) {
            let mut first_level = touching(&BTreeSet::from([ref_idx]), 1);
            if !first_level.is_empty() {
                let max_i = (0..first_level.len()).fold(0, |m, i| if len_of(first_level[i]) > len_of(first_level[m]) { i } else { m });
                let last = first_level.len() - 1;
                first_level.swap(max_i, last);
            }
            reordered.push(ref_idx);
            included.insert(ref_idx);
            for &idx in &first_level {
                if included.insert(idx) {
                    reordered.push(idx);
                }
            }
            let mut current_inset = 2usize;
            loop {
                let cur: BTreeSet<usize> = first_level.iter().cloned().collect();
                let mut next = touching(&cur, current_inset);
                if next.is_empty() {
                    break;
                }
                next.retain(|i| !included.contains(i));
                if !next.is_empty() {
                    let max_i = (0..next.len()).fold(0, |m, i| if len_of(next[i]) > len_of(next[m]) { i } else { m });
                    next.swap(max_i, 0);
                }
                for &idx in &next {
                    if included.insert(idx) {
                        reordered.push(idx);
                    }
                }
                first_level = next;
                current_inset += 1;
            }
        }
    }
    for i in 0..ordered.len() {
        if !included.contains(&i) {
            reordered.push(i);
        }
    }
    let reordered_ext: Vec<usize> = reordered.iter().map(|&i| ordered[i].idx).collect();
    let is_contour: Vec<bool> = reordered.iter().map(|&i| ordered[i].is_contour).collect();
    let mut result_idx: Vec<usize> = reordered_ext.clone();
    let mut result_ctr: Vec<bool> = is_contour.clone();
    // sandwich
    let inset = |i: usize| all_lines[reordered_ext[i]].inset_idx;
    let n = reordered_ext.len();
    let mut position = 0usize;
    while position < n {
        let (mut outer, mut first_internal, mut second_internal): (i64, i64, i64) = (-1, -1, -1);
        let mut max_internal = n - 1;
        let mut arr_i = position;
        while arr_i < n {
            match inset(arr_i) {
                0 => {
                    if outer == -1 {
                        outer = arr_i as i64;
                    }
                }
                1 => {
                    if first_internal == -1 && arr_i as i64 > outer && outer != -1 {
                        first_internal = arr_i as i64;
                    }
                }
                2 => {
                    if second_internal == -1 && arr_i as i64 > first_internal && outer != -1 {
                        second_internal = arr_i as i64;
                    }
                }
                _ => {}
            }
            if outer > -1 && first_internal > -1 && inset(arr_i) == 0 {
                arr_i -= 1;
                max_internal = arr_i;
                break;
            }
            arr_i += 1;
        }
        if outer > -1 && first_internal > -1 && second_internal > -1 {
            let second_internal = second_internal as usize;
            let mut tmp: Vec<(usize, bool)> = vec![];
            let mut aj = max_internal as i64;
            while aj >= position as i64 {
                if aj as usize >= second_internal {
                    tmp.push((reordered_ext[aj as usize], is_contour[aj as usize]));
                }
                aj -= 1;
            }
            for aj in position..second_internal {
                tmp.push((reordered_ext[aj], is_contour[aj]));
            }
            for aj in position..=max_internal {
                result_idx[aj] = tmp[aj - position].0;
                result_ctr[aj] = tmp[aj - position].1;
            }
        }
        position = arr_i + 1;
    }
    result_idx.into_iter().zip(result_ctr).map(|(idx, is_contour)| ArachneExtrusion { idx, is_contour }).collect()
}

#[cfg(test)]
mod tests_arachne {
    use super::*;

    /// bughunt 2026-11-15: schools_kit_enclosure.stl, concentric fill of a narrow solid region
    /// (a ring with two 0.02mm-thick tabs) panicked "edge without twin".
    ///
    /// 🔴 OPEN, NOT FIXED. The graph built from the Voronoi diagram already has edges with no
    /// twin (a point cell skipped for its range, or a cell walk cut at a non-finite edge), and
    /// `collapse_small_edges` and `filter_noncentral_regions_rec` both reach one. Guarding one
    /// `tw()` moved the panic to the next. Until the construction is fixed the slice is REFUSED
    /// (pipeline::guard, now live in release) rather than printed. Run with `--ignored`.
    #[test]
    #[ignore = "open defect: arachne graph has twinless edges on this ring; slice is refused, not fixed"]
    fn a_ring_with_hairline_tabs_does_not_panic() {
        let one = vec![Poly { contour: vec![[143.528126, 109.389954], [143.528126, 108.987804], [143.662766, 108.585718], [143.894308, 108.264804], [144.261877, 108.039111], [144.496297, 107.948629], [144.749998, 107.929345], [145.003702, 107.948628], [145.238123, 108.039111], [145.60569, 108.264803], [145.837234, 108.585717], [145.971874, 108.987803], [145.971874, 109.389955], [145.837235, 109.792036], [145.562279, 110.173121], [145.562279, 114.237408], [145.700268, 114.237408], [145.700268, 114.257793], [145.069366, 114.257793], [145.069366, 110.102925], [145.449808, 109.69832], [145.603159, 109.346912], [145.603159, 109.030846], [145.449807, 108.679434], [145.281749, 108.500703], [145.104221, 108.382018], [145.042918, 108.358356], [144.75, 108.319792], [144.457083, 108.358356], [144.395779, 108.382018], [144.218251, 108.500704], [144.050192, 108.679435], [143.89684, 109.030846], [143.89684, 109.346912], [144.050192, 109.698321], [144.430634, 110.102926], [144.430634, 114.257793], [143.799732, 114.257793], [143.799732, 114.237408], [143.937721, 114.237408], [143.937721, 110.173123], [143.662766, 109.792038]], holes: vec![] }];
        let params = WallToolPathsParams {
            min_bead_width: 340_000, min_feature_size: 100_000, min_length_factor: 0.5,
            wall_transition_length: 400_000, wall_transition_angle: 10.0, wall_transition_filter_deviation: 100_000,
            wall_distribution_count: 1, is_top_or_bottom_layer: false, wall_maximum_resolution: 500_000, wall_maximum_deviation: 25_000,
        };
        let r = wall_tool_paths(&one, 377_080, 377_080, 17, 0, 0.2, &params);
        assert!(r.is_ok());
    }
    use crate::walls::{generate_walls, WallGenerator};
    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Poly {
        Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }
    }
    fn len(p: &ExtPath) -> f64 {
        let pts: Vec<[f64; 2]> = p.pts.iter().map(|q| [q.x, q.y]).collect();
        geo::path_length(&pts, p.closed)
    }
    fn params() -> WallParams {
        let mut p = WallParams::default();
        p.generator = WallGenerator::Arachne;
        p.top_bottom_infill_wall_overlap = 25.0;
        p
    }
    fn total(r: &WallResult, f: Feature) -> f64 {
        r.paths.iter().filter(|p| p.feature == f).map(len).sum()
    }

    #[test]
    fn square_has_outer_and_inner_loops_like_classic() {
        let island = vec![rect(0.0, 0.0, 20.0, 20.0)];
        let p = params();
        let a = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        let mut c = p.clone();
        c.generator = WallGenerator::Classic;
        let k = generate_walls(&island, Some(&island), Some(&island), &c).unwrap();
        for f in [Feature::OuterWall, Feature::InnerWall] {
            let (la, lk) = (total(&a, f), total(&k, f));
            assert!(la > 50.0 && (la - lk).abs() / lk < 0.01, "{:?}: arachne {la} classic {lk}", f);
        }
        assert_eq!(a.paths.iter().filter(|q| q.feature == Feature::OuterWall).count(), 1);
        assert_eq!(a.paths.iter().filter(|q| q.feature == Feature::InnerWall).count(), 1);
        // bead widths: outer = ext width, inner = inner width (within a micron-scale tolerance)
        let ow = a.paths.iter().find(|q| q.feature == Feature::OuterWall).unwrap().pts[0].w;
        let iw = a.paths.iter().find(|q| q.feature == Feature::InnerWall).unwrap().pts[0].w;
        assert!((ow - p.ext_width).abs() < 0.01, "outer width {ow}");
        assert!((iw - p.inner_width).abs() < 0.01, "inner width {iw}");
        // infill region exists and is smaller than the island
        let ar = geo::polys_area(&a.infill_region);
        assert!(ar > 200.0 && ar < 400.0, "{ar}");
    }

    #[test]
    fn thin_bar_becomes_one_widened_bead_and_no_gap_fill() {
        let island = vec![rect(0.0, 0.0, 20.0, 0.3)];
        let r = generate_walls(&island, Some(&island), Some(&island), &params()).unwrap();
        assert_eq!(r.paths.iter().filter(|q| q.feature == Feature::GapInfill).count(), 0);
        let l = total(&r, Feature::OuterWall) + total(&r, Feature::InnerWall);
        assert!(l > 19.0 && l < 21.0, "single centre bead length {l}");
        // min_bead_width (0.34, spacing) widening: the bead is at least that wide
        let w = r.paths[0].pts[0].w;
        assert!(w >= 0.34, "bead width {w}");
    }

    #[test]
    fn taper_gets_variable_widths_and_wall_count_transition() {
        // 0.2 mm -> 3.0 mm wedge over 30 mm: 1 bead at the thin end, several at the thick end
        let wedge = Poly { contour: vec![[0.0, 0.0], [30.0, 0.0], [30.0, 3.0], [0.0, 0.2]], holes: vec![] };
        let island = vec![wedge];
        let r = generate_walls(&island, Some(&island), Some(&island), &params()).unwrap();
        let ws: Vec<f64> = r.paths.iter().flat_map(|q| q.pts.iter().map(|p| p.w)).collect();
        let (mn, mx) = ws.iter().fold((f64::MAX, 0.0f64), |(a, b), &w| (a.min(w), b.max(w)));
        assert!(mx - mn > 0.02, "widths must vary along the taper: {mn}..{mx}");
        // negative control: a constant-thickness strip has (nearly) constant widths
        let strip = vec![rect(0.0, 0.0, 30.0, 1.7)];
        let r2 = generate_walls(&strip, Some(&strip), Some(&strip), &params()).unwrap();
        let ws2: Vec<f64> = r2.paths.iter().flat_map(|q| q.pts.iter().map(|p| p.w)).collect();
        let (mn2, mx2) = ws2.iter().fold((f64::MAX, 0.0f64), |(a, b), &w| (a.min(w), b.max(w)));
        assert!(mx2 - mn2 < 0.3, "strip widths {mn2}..{mx2}");
        // the taper has more width variation than the strip
        assert!(mx - mn > mx2 - mn2, "taper {mn}..{mx} vs strip {mn2}..{mx2}");
    }

    #[test]
    fn wall_loops_and_sequence_are_honoured() {
        let island = vec![rect(0.0, 0.0, 20.0, 20.0)];
        let mut p = params();
        p.wall_loops = 1;
        let r = generate_walls(&island, Some(&island), Some(&island), &p).unwrap();
        assert_eq!(r.paths.iter().filter(|q| q.feature == Feature::InnerWall).count(), 0);
        let mut p3 = params();
        p3.wall_loops = 3;
        let r3 = generate_walls(&island, Some(&island), Some(&island), &p3).unwrap();
        assert_eq!(r3.paths.iter().filter(|q| q.feature == Feature::InnerWall).count(), 2);
        // inner/outer: the outer loop is last; outer/inner: first
        assert_eq!(r3.paths.last().unwrap().feature, Feature::OuterWall);
        let mut po = p3.clone();
        po.wall_sequence = WallSequence::OuterInner;
        let ro = generate_walls(&island, Some(&island), Some(&island), &po).unwrap();
        assert_eq!(ro.paths[0].feature, Feature::OuterWall);
    }

    #[test]
    fn unsupported_options_refuse_and_output_is_deterministic() {
        let island = vec![rect(0.0, 0.0, 20.0, 1.3), rect(0.0, 5.0, 20.0, 9.0)];
        let mut q = params();
        q.fuzzy_skin = true;
        assert!(matches!(generate_walls(&island, None, None, &q), Err(FdmError::Unsupported(_))));
        let a = generate_walls(&island, Some(&island), Some(&island), &params()).unwrap();
        let b = generate_walls(&island, Some(&island), Some(&island), &params()).unwrap();
        assert_eq!(a.paths.len(), b.paths.len());
        for (x, y) in a.paths.iter().zip(b.paths.iter()) {
            assert_eq!(x.pts, y.pts);
        }
    }

    #[test]
    fn near_duplicate_vertices_do_not_lose_the_island() {
        // vertex pairs closer than 1 micron (and off the 1e-6 grid) must not make Arachne return nothing
        let base: Vec<[f64; 2]> = vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
        let mut fails = vec![];
        let mut n = 0;
        for corner in 0..4 {
            for (k, d) in [(0usize, [0.0004, 0.0]), (1, [0.0, 0.0003]), (2, [0.0004999, 0.0004999]), (3, [-0.0002, 0.0007]), (4, [3e-7, 0.0]), (5, [1e-6, 1e-6])] {
                let mut c: Vec<[f64; 2]> = vec![];
                for (i, q) in base.iter().enumerate() {
                    c.push(*q);
                    if i == corner {
                        c.push([q[0] + d[0], q[1] + d[1]]);
                    }
                }
                n += 1;
                let island = vec![Poly { contour: c, holes: vec![] }];
                let r = generate_walls(&island, Some(&island), Some(&island), &params());
                match r {
                    Ok(r) if total(&r, Feature::OuterWall) > 70.0 && total(&r, Feature::InnerWall) > 60.0 => {}
                    Ok(r) => fails.push(format!("corner {corner} case {k}: outer {} inner {}", total(&r, Feature::OuterWall), total(&r, Feature::InnerWall))),
                    Err(e) => fails.push(format!("corner {corner} case {k}: {e:?}")),
                }
            }
        }
        assert!(fails.is_empty(), "{} of {} cases failed: {:?}", fails.len(), n, fails);
    }

    #[test]
    fn direct_entry_points_survive_sub_micron_vertex_pairs() {
        // circle (r=10) with a hole (r=4), every vertex followed by a twin at a deterministic sub-micron offset
        let mk = |r: f64, n: usize, twin: bool| -> Vec<[f64; 2]> {
            let mut v = vec![];
            for i in 0..n {
                let a = i as f64 / n as f64 * 2.0 * PI;
                let q = [30.0 + r * a.cos(), 30.0 + r * a.sin()];
                v.push(q);
                if twin && i % 3 == 0 {
                    let d = 1e-4 * (1 + i % 5) as f64 * 0.9;
                    v.push([q[0] + d * (i as f64).sin(), q[1] + d * (i as f64).cos()]);
                }
            }
            v
        };
        for twin in [false, true] {
            let mut hole = mk(4.0, 90, twin);
            hole.reverse();
            let island = vec![Poly { contour: mk(10.0, 120, twin), holes: vec![hole] }];
            let p = params();
            let r = crate::arachne::generate_arachne(&island, Some(&island), Some(&island), &p).unwrap();
            let outer = total(&r, Feature::OuterWall);
            assert!(outer > 2.0 * PI * 10.0 * 0.95, "twin={twin}: outer wall length {outer} (loops {})", r.paths.len());
            let q = WallToolPathsParams::from_params(&p, false);
            let t = wall_tool_paths(&island, 450_000, 450_000, 2, 0, 0.2, &q).unwrap();
            let nlines: usize = t.toolpaths.iter().map(|l| l.len()).sum();
            assert!(nlines >= 4, "twin={twin}: wall_tool_paths returned {nlines} lines");
        }
    }

    #[test]
    fn fuzz_sub_micron_pairs_never_empty() {
        // deterministic LCG; star-shaped polygons, vertices snapped to the 1e-6 grid, random twin vertices 0..3 units away
        let mut st: u64 = 0x2545F4914F6CDD1D;
        let mut rnd = move || {
            st = st.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((st >> 33) as f64) / ((1u64 << 31) as f64)
        };
        let q = WallToolPathsParams::from_params(&params(), false);
        let mut bad: Vec<String> = vec![];
        for case in 0..300 {
            let n = 6 + (rnd() * 40.0) as usize;
            let mut ring: Vec<[f64; 2]> = vec![];
            for i in 0..n {
                let a = i as f64 / n as f64 * 2.0 * PI;
                let r = 6.0 + 4.0 * rnd();
                let p = [(20.0 + r * a.cos()) * 1e6, (20.0 + r * a.sin()) * 1e6];
                let p = [p[0].round() / 1e6, p[1].round() / 1e6];
                ring.push(p);
                if rnd() < 0.4 {
                    let d = [((rnd() * 4.0) as i64 - 1) as f64 / 1e6, ((rnd() * 4.0) as i64 - 1) as f64 / 1e6];
                    ring.push([p[0] + d[0], p[1] + d[1]]);
                }
            }
            let island = vec![Poly { contour: ring.clone(), holes: vec![] }];
            match wall_tool_paths(&island, 450_000, 450_000, 2, 0, 0.2, &q) {
                Ok(t) if t.toolpaths.iter().map(|l| l.len()).sum::<usize>() >= 2 => {}
                Ok(_) => bad.push(format!("case {case}: empty ({} verts)", ring.len())),
                Err(e) => bad.push(format!("case {case}: {e:?}")),
            }
        }
        assert!(bad.is_empty(), "{} of 300 failed: {:?}", bad.len(), &bad[..bad.len().min(8)]);
    }

    #[test]
    fn fuzz_annulus_with_unsnapped_sub_micron_twins() {
        // the syn_hollow_cylinder failure: annulus (1.2 mm wall), vertex twins 1e-8..1e-6 mm apart, coordinates off the grid
        let mut st: u64 = 0x9E3779B97F4A7C15;
        let mut rnd = move || {
            st = st.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((st >> 33) as f64) / ((1u64 << 31) as f64)
        };
        let q = WallToolPathsParams::from_params(&params(), false);
        let mut bad: Vec<String> = vec![];
        for case in 0..500 {
            let n = 8 + (rnd() * 400.0) as usize;
            let mut mk = |r: f64, hole: bool| -> Vec<[f64; 2]> {
                let mut v = vec![];
                for i in 0..n {
                    let a = i as f64 / n as f64 * 2.0 * PI;
                    let p = [127.0 + r * a.cos() + (rnd() - 0.5) * 1e-7, 127.0 + r * a.sin() + (rnd() - 0.5) * 1e-7];
                    v.push(p);
                    if rnd() < 0.3 {
                        let m = 10f64.powf(-9.0 + 3.3 * rnd());
                        let ang = rnd() * 2.0 * PI;
                        v.push([p[0] + m * ang.cos(), p[1] + m * ang.sin()]);
                    }
                }
                if hole { v.reverse(); }
                v
            };
            let island = vec![Poly { contour: mk(13.9, false), holes: vec![mk(12.7, true)] }];
            // the surfaces caller: bead = one spacing, as many insets as fit across the island
            let mut qq = q.clone();
            qq.min_bead_width = 340_000;
            qq.min_feature_size = 100_000;
            qq.wall_distribution_count = 1;
            qq.wall_transition_length = 400_000;
            match wall_tool_paths(&island, 382_000, 382_000, 70, 0, 0.2, &qq) {
                Ok(t) if t.toolpaths.iter().map(|l| l.len()).sum::<usize>() >= 2 => {}
                Ok(_) => bad.push(format!("case {case}: empty")),
                Err(e) => bad.push(format!("case {case}: {e:?}")),
            }
        }
        assert!(bad.is_empty(), "{} of 500 failed: {:?}", bad.len(), &bad[..bad.len().min(8)]);
    }

    #[test]
    fn thin_ring_loops_are_contiguous_closed_chains() {
        // 9.7 mm square ring, 0.94 mm wall (orcatest_two_hollow_squares): variable-width pieces of one loop must chain
        // end-to-start and the last piece must end EXACTLY on the first piece's start (the motion stage merges chains
        // into a loop; a near-miss closure used to leave a 0.09 mm stub behind)
        let c = vec![[0.0, 0.0], [9.7, 0.0], [9.7, 9.7], [0.0, 9.7]];
        let h = vec![[0.94, 0.94], [0.94, 8.76], [8.76, 8.76], [8.76, 0.94]];
        let island = vec![Poly { contour: c, holes: vec![h] }];
        let r = generate_walls(&island, Some(&island), Some(&island), &params()).unwrap();
        let walls: Vec<&ExtPath> = r.paths.iter().filter(|q| matches!(q.feature, Feature::OuterWall | Feature::InnerWall)).collect();
        let mut chains = 0;
        let mut i = 0;
        while i < walls.len() {
            let start = walls[i].pts[0];
            let mut end = *walls[i].pts.last().unwrap();
            let mut j = i;
            while (end.x - start.x).hypot(end.y - start.y) > 1e-9 && j + 1 < walls.len() {
                let n = walls[j + 1];
                assert!((n.pts[0].x - end.x).hypot(n.pts[0].y - end.y) < 1e-9, "piece {} does not continue piece {}", j + 1, j);
                j += 1;
                end = *walls[j].pts.last().unwrap();
            }
            assert!((end.x - start.x).hypot(end.y - start.y) <= 1e-9, "chain starting at piece {i} never closes");
            chains += 1;
            i = j + 1;
        }
        assert_eq!(chains, 2, "outer and hole loop");
    }
}
