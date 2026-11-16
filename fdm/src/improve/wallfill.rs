//! Lane 9 (opt-in): fill thin walls with wall loops instead of zig-zag infill.
//!
//! The defect it removes: a part wall a little thicker than the preset's walls (a 2.4 mm saucer wall against
//! 2 loops per side, about 1.8 mm) leaves a narrow strip in the middle. The slicer fills that strip with sparse infill:
//! dozens of short zig-zag pieces per layer, each one a travel, a retraction and a wipe. Measured on the pot saucer
//! (`hardware/cad/2bee_household/pot_saucer_18cm_3d.scad`, X2D 0.4, 0.20 mm Standard, PETG): 684 travels over 2 mm,
//! 357 retractions, 1 h 8 m with 2 loops; 248 travels, 253 retractions, 1 h 5.7 m with 3 loops, and the wall is solid.
//!
//! The geometry here is a DETECTOR and a first guess, not the decision: whether a loop fits at all depends on the wall
//! generator (classic places whole loops only; a 2.0 mm cup wall keeps a 0.4 mm gap that becomes gap fill), so
//! `fdmslice --auto-walls` slices the candidates and keeps the one whose EMITTED G-code retracts least.
//!
//! Rule: take the region left for infill after N loops (the layer inset by the wall widths) and the part of it that is
//! narrower than `NARROW_LINES` infill lines. Raise N, one loop at a time up to `MAX_LOOPS`, while that narrow area
//! keeps shrinking, and stop at the first N where it is gone. Only recommend when the narrow strips are a real share of
//! the infill area (`MIN_SHARE`), so one thin rib does not add a loop to every wall of a big part.
//!
//! What this does NOT do: it does not change wall widths, it does not add loops per region (one `wall_loops` for the
//! whole object, like the preset), and it has not printed anything. The flow spacing is Orca's
//! `Flow::spacing` (width - h(1 - pi/4)); the infill/wall overlap is ignored, which makes the leftover slightly
//! smaller than the real one, i.e. the rule errs towards fewer loops.
use crate::config::Config;
use crate::geom;
use crate::types::{Layer, Polys};

/// Highest wall count this rule will set.
pub const MAX_LOOPS: i64 = 6;
/// A leftover strip narrower than this many infill line widths counts as narrow.
pub const NARROW_LINES: f64 = 3.0;
/// A layer is thin-walled when its narrow area is at least this share of its infill area; the rule needs this share of
/// the sampled layers to be thin-walled.
pub const MIN_SHARE: f64 = 0.3;
/// Narrow area per sampled layer (mm^2) below which nothing is worth changing.
pub const MIN_NARROW_MM2: f64 = 2.0;
/// At most this many layers are measured (evenly sampled).
pub const MAX_SAMPLED: usize = 40;

#[derive(Clone, Debug, PartialEq)]
pub struct WallFill {
    pub from_loops: i64,
    pub to_loops: i64,
    /// Narrow leftover area summed over the sampled layers, mm^2, for from_loops and to_loops.
    pub narrow_before_mm2: f64,
    pub narrow_after_mm2: f64,
    pub layers_sampled: usize,
    pub reason: String,
}

fn num(cfg: &Config, k: &str, d: f64) -> f64 { cfg.f64(k).ok().filter(|v| *v > 0.0).unwrap_or(d) }

/// The leftover after `n` loops and the narrow part of it, summed over `layers`.
fn measure(layers: &[&Layer], n: i64, outer_sp: f64, inner_sp: f64, narrow_r: f64, sliver_r: f64) -> (f64, f64) {
    let d = outer_sp + (n - 1).max(0) as f64 * inner_sp;
    let (mut left, mut narrow) = (0.0, 0.0);
    for l in layers {
        // a sliver under half an infill line gets no sparse infill (gap fill or nothing), so it is not counted
        let rest: Polys = geom::opening(&geom::inset(&l.region, d), sliver_r);
        let a = geom::area(&rest);
        if a <= 0.0 { continue; }
        left += a;
        narrow += (a - geom::area(&geom::opening(&rest, narrow_r))).max(0.0);
    }
    (left, narrow)
}

/// `Some` when more wall loops would remove narrow infill strips; `None` when the preset's count is right.
pub fn thin_wall_loops(layers: &[Layer], cfg: &Config) -> Option<WallFill> {
    let n0 = cfg.i64("wall_loops").unwrap_or(2).max(1);
    if n0 >= MAX_LOOPS { return None; }
    let nozzle = num(cfg, "nozzle_diameter", 0.4);
    let lw = num(cfg, "line_width", 0.42);
    let h = num(cfg, "layer_height", 0.2);
    let k = h * (1.0 - std::f64::consts::FRAC_PI_4);
    let outer_sp = num(cfg, "outer_wall_line_width", lw) - k;
    let inner_sp = num(cfg, "inner_wall_line_width", lw) - k;
    let infill_w = num(cfg, "sparse_infill_line_width", lw.max(nozzle));
    let narrow_r = 0.5 * NARROW_LINES * infill_w;
    let sliver_r = 0.25 * infill_w;
    let step = (layers.len() as f64 / MAX_SAMPLED as f64).ceil().max(1.0) as usize;
    let sampled: Vec<&Layer> = layers.iter().step_by(step).filter(|l| !l.region.is_empty()).collect();
    if sampled.is_empty() { return None; }
    let (left0, narrow0) = measure(&sampled, n0, outer_sp, inner_sp, narrow_r, sliver_r);
    // per layer, not per part: a solid base under a thin wall (the saucer) must not outvote the wall layers
    let thin_layers = sampled.iter().filter(|l| {
        let (lf, nr) = measure(&[*l], n0, outer_sp, inner_sp, narrow_r, sliver_r);
        nr >= MIN_NARROW_MM2 && nr >= MIN_SHARE * lf
    }).count();
    if narrow0 < MIN_NARROW_MM2 * sampled.len() as f64 || (thin_layers as f64) < MIN_SHARE * sampled.len() as f64 { return None; }
    let (mut best, mut best_narrow) = (n0, narrow0);
    for n in n0 + 1..=MAX_LOOPS {
        let (_, nar) = measure(&sampled, n, outer_sp, inner_sp, narrow_r, sliver_r);
        // a loop that does not shrink the narrow area is a loop for nothing
        if nar >= best_narrow - 1e-6 { break; }
        best = n;
        best_narrow = nar;
        if nar < MIN_NARROW_MM2 * sampled.len() as f64 { break; }
    }
    if best == n0 { return None; }
    Some(WallFill {
        from_loops: n0, to_loops: best, narrow_before_mm2: narrow0, narrow_after_mm2: best_narrow, layers_sampled: sampled.len(),
        reason: format!(
            "{} wall loops leave strips narrower than {:.1} mm that would be zig-zag infill ({:.0} of {:.0} mm2 over {} sampled layers); {} loops fill them with walls, fewer travels and retractions",
            n0, 2.0 * narrow_r, narrow0, left0, sampled.len(), best),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    fn ring(r_out: f64, r_in: f64) -> Polys {
        let circle = |r: f64, rev: bool| -> Vec<[f64; 2]> {
            let mut v: Vec<[f64; 2]> = (0..160).map(|i| { let a = i as f64 * std::f64::consts::TAU / 160.0; [100.0 + r * a.cos(), 100.0 + r * a.sin()] }).collect();
            if rev { v.reverse(); }
            v
        };
        vec![Poly { contour: circle(r_out, false), holes: vec![circle(r_in, true)] }]
    }
    fn layers(p: Polys, n: usize) -> Vec<Layer> { (0..n).map(|i| Layer { index: i, z: 0.2 * (i + 1) as f64, h: 0.2, region: p.clone() }).collect() }
    fn cfg(loops: i64) -> Config {
        let mut c = Config::from_map(Default::default());
        for (k, v) in [("nozzle_diameter", "0.4"), ("line_width", "0.42"), ("outer_wall_line_width", "0.42"), ("inner_wall_line_width", "0.45"), ("sparse_infill_line_width", "0.45"), ("layer_height", "0.2")] { c.set(k, v); }
        c.set("wall_loops", &loops.to_string());
        c
    }

    #[test]
    fn saucer_wall_gets_three_loops() {
        // the saucer: 2.4 mm wall (outer d 139.8, inner d 135)
        let w = thin_wall_loops(&layers(ring(69.9, 67.5), 20), &cfg(2)).expect("2 loops leave a strip");
        assert_eq!(w.to_loops, 3, "{w:?}");
        assert!(w.narrow_after_mm2 < w.narrow_before_mm2 * 0.1, "{w:?}");
    }

    #[test]
    fn already_enough_loops_is_none() {
        assert_eq!(thin_wall_loops(&layers(ring(69.9, 67.5), 20), &cfg(3)), None);
    }

    #[test]
    fn solid_disc_with_wide_infill_is_none() {
        // a 40 mm disc: the leftover is wide, nothing narrow worth a loop
        let disc = vec![Poly { contour: ring(20.0, 1.0)[0].contour.clone(), holes: vec![] }];
        assert_eq!(thin_wall_loops(&layers(disc, 20), &cfg(2)), None);
    }

    #[test]
    fn thicker_wall_gets_more_loops_within_the_cap() {
        // a 2.8 mm wall: 2 loops leave a 1.2 mm strip, 3 leave 0.4 mm (still infill), 4 fill it
        let w = thin_wall_loops(&layers(ring(70.0, 67.2), 10), &cfg(2)).expect("strip");
        assert_eq!(w.to_loops, 4, "{w:?}");
        assert!(w.to_loops <= MAX_LOOPS);
    }

    #[test]
    fn wide_wall_keeps_its_infill() {
        // a 6 mm wall: the strip after 2 loops is wide enough for real infill, so no change
        assert_eq!(thin_wall_loops(&layers(ring(70.0, 64.0), 10), &cfg(2)), None);
    }

    #[test]
    fn plant_a_rule_that_ignores_the_strip_would_fail_here() {
        // negative control for the saucer test: with the narrow width set to 0 nothing counts as narrow
        let mut c = cfg(2);
        c.set("sparse_infill_line_width", "0.0001");
        let w = thin_wall_loops(&layers(ring(69.9, 67.5), 20), &c);
        assert_eq!(w, None, "a 0-width narrow test must find nothing, which is why the real test can fail");
    }
}
