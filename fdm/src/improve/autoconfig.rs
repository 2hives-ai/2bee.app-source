//! Lane 9: rule-based settings recommender. `autoconfig(&PreflightReport, &Config, &AutoOptions) -> SettingsDelta`.
//!
//! The delta is OPT-IN: it is a list of (key, value, reason) that the caller may `apply` on top of a `Config`.
//! Nothing here changes the Orca-parity path unless `apply` is called; with an empty delta `apply` is a no-op.
//! Every change names its BASIS so a reader can tell a measurement from a rule of thumb:
//!   `measured: ...`  a comparison run against Orca on this machine (numbers in IMPROVEMENTS.md / `improve eval-autoconfig`)
//!   `rule: ...`      geometry-derived threshold or textbook practice, NOT measured here
use crate::config::Config;
use crate::preflight::PreflightReport;
use crate::types::FdmError;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UseCase { Auto, Prototype, Functional, Display }

#[derive(Clone, Debug)]
pub struct AutoOptions {
    pub use_case: UseCase,
    /// Rules may only change these keys (empty = all rules on). Lets a caller opt out of e.g. layer height.
    pub allow_layer_height: bool,
}
impl Default for AutoOptions { fn default() -> Self { AutoOptions { use_case: UseCase::Auto, allow_layer_height: true } } }

#[derive(Clone, Debug, Serialize)]
pub struct Change { pub key: String, pub old: Option<String>, pub value: String, pub reason: String, pub basis: String }

#[derive(Clone, Debug, Default, Serialize)]
pub struct SettingsDelta {
    pub changes: Vec<Change>,
    /// Rules that looked at the model and decided to change nothing, with the reason (so silence is explained).
    pub considered: Vec<String>,
}

impl SettingsDelta {
    pub fn is_empty(&self) -> bool { self.changes.is_empty() }
    pub fn get(&self, key: &str) -> Option<&str> { self.changes.iter().find(|c| c.key == key).map(|c| c.value.as_str()) }
    /// Apply on top of `cfg`. A key the config does not have is an ERROR (a typo or a profile without it must not pass silently);
    /// nothing is modified in that case. Returns the number of keys written.
    pub fn apply(&self, cfg: &mut Config) -> Result<usize, FdmError> {
        for c in &self.changes { if !cfg.contains(&c.key) { return Err(FdmError::Unsupported(format!("autoconfig key '{}' is not in the base config", c.key))); } }
        for c in &self.changes { cfg.set(&c.key, &c.value); }
        Ok(self.changes.len())
    }
    pub fn as_overrides(&self) -> Vec<(String, String)> { self.changes.iter().map(|c| (c.key.clone(), c.value.clone())).collect() }
    /// `--explain` text.
    pub fn explain(&self) -> String {
        let mut o = String::new();
        if self.changes.is_empty() { o += "AUTOCONFIG: no change - the base settings already suit this part.\n"; }
        else { o += &format!("AUTOCONFIG: {} change(s) on top of the base settings\n", self.changes.len()); }
        for c in &self.changes { o += &format!("  {} : {} -> {}\n      why  : {}\n      basis: {}\n", c.key, c.old.as_deref().unwrap_or("(unset)"), c.value, c.reason, c.basis); }
        if !self.considered.is_empty() { o += "LEFT UNCHANGED\n"; for l in &self.considered { o += &format!("  - {l}\n"); } }
        o
    }
    pub fn to_json(&self) -> serde_json::Value { serde_json::to_value(self).expect("serialisable") }
}

fn s(cfg: &Config, key: &str) -> Option<String> { cfg.str(key).ok() }
fn pct(cfg: &Config, key: &str) -> Option<f64> { cfg.float_or_percent(key).ok().map(|v| v.value) }

pub fn autoconfig(r: &PreflightReport, base: &Config, opt: &AutoOptions) -> SettingsDelta {
    let mut d = SettingsDelta::default();
    let put = |d: &mut SettingsDelta, key: &str, value: String, reason: String, basis: String| {
        let old = s(base, key);
        if old.as_deref() == Some(value.as_str()) { return; }
        d.changes.push(Change { key: key.into(), old, value, reason, basis });
    };
    let f = &r.flags;

    // ---- R1 support: on only when the geometry cannot print without it, off when it would be wasted
    let base_on = base.bool_("enable_support").unwrap_or(false);
    if f.needs_support {
        let why = if r.bridges.over_limit > 0 && r.bridges.cantilever_area_mm2 < 1.0 {
            format!("a {:.0} mm bridge is beyond the {:.0} mm {} can span", r.bridges.max_span_mm, r.bridges.limit_mm, r.warp.material)
        } else { format!("{:.0} mm2 of the part hangs out flatter than {:.0} degrees with a free edge (cantilever {:.0} mm2)", r.overhang.needs_support_area_mm2, r.overhang.threshold_deg, r.bridges.cantilever_area_mm2) };
        if !base_on { put(&mut d, "enable_support", "1".into(), why.clone(), "rule: Orca layer-difference overhang test (same rule as Orca's SupportMaterial); precision/recall in improve eval-preflight".into()); }
        else { d.considered.push(format!("enable_support already on ({why})")); }
        // normal supports print ~25% faster than tree supports in this profile (X2D, Orca 2.5.0-dev) for wide overhangs
        if r.overhang.needs_support_area_mm2 >= 100.0 && s(base, "support_type").as_deref() == Some("tree(auto)") {
            put(&mut d, "support_type", "normal(auto)".into(), format!("overhang area {:.0} mm2 is wide; normal supports are much faster than tree supports for wide overhangs", r.overhang.needs_support_area_mm2),
                "measured: Orca normal(auto) vs tree(auto) on 6 overhang shapes: model time change -38,-26,-25,-24,-10,0 % (median -25%), filament -2..+6%; see IMPROVEMENTS.md".into());
        }
    } else if base_on {
        let why = if f.has_overhang { format!("the only overhangs are short bridges (longest {:.0} mm, limit {:.0} mm) that print without support", r.bridges.max_span_mm, r.bridges.limit_mm) } else { "no surface is flatter than the support threshold".to_string() };
        put(&mut d, "enable_support", "0".into(), format!("{why}; support would only add time and filament"), "measured: support-on vs support-off on cases without a cantilever, see eval-autoconfig".into());
    } else { d.considered.push(if f.has_overhang { format!("support stays off: overhangs are short bridges (longest {:.0} mm <= {:.0} mm)", r.bridges.max_span_mm, r.bridges.limit_mm) } else { "support stays off: no overhang".into() }); }

    // ---- R2 brim
    let brim_t = s(base, "brim_type").unwrap_or_else(|| "no_brim".into());
    if (f.adhesion_risk_medium_or_high || f.warp_high) && brim_t == "no_brim" {
        let w = if r.recommend.brim_mm > 0.0 { r.recommend.brim_mm } else { 5.0 };
        put(&mut d, "brim_type", "outer_only".into(), format!("adhesion risk {} ({}){}", r.first_layer.risk, r.first_layer.reasons.join("; "), if f.warp_high { format!("; {} warp risk high", r.warp.material) } else { String::new() }), "rule: adhesion points / warp heuristic in preflight".into());
        put(&mut d, "brim_width", format!("{w}"), format!("{w:.0} mm brim for risk {}", r.first_layer.risk), "rule: 5 mm medium, 8 mm high".into());
    } else { d.considered.push(format!("brim: adhesion risk {} and warp {} -> {}", r.first_layer.risk, r.warp.risk, if brim_t == "no_brim" { "none needed".into() } else { format!("base already has brim_type={brim_t}") })); }

    // ---- R3 wall generator
    let gen = s(base, "wall_generator").unwrap_or_else(|| "classic".into());
    if gen == "classic" && (f.thin_unprintable || r.thin.wall_only_area_mm2 >= 3.0) {
        let why = if f.thin_unprintable { format!("{:.1} mm2 per layer is narrower than one line ({:.2} mm): classic walls drop it, Arachne prints down to about {:.2} mm", r.thin.unprintable_area_mm2, r.thin.unprintable_below_mm, 0.475 * base.f64("nozzle_diameter").unwrap_or(0.4)) }
            else { format!("{:.1} mm2 per layer is 1-2 lines wide: Arachne fits variable-width beads there, classic leaves gaps or overlap", r.thin.wall_only_area_mm2) };
        put(&mut d, "wall_generator", "arachne".into(), why, if f.thin_unprintable { "measured: Orca on 0.15..0.35 mm walls: classic prints none; arachne prints 0.20 mm and up (0.18 not), see eval-preflight/eval-autoconfig".into() } else { "rule: Arachne exists for thin features (Kuipers et al. 2020)".into() });
    } else { d.considered.push(format!("wall generator stays {gen}: thin<1 line {:.1} mm2, 1-2 lines {:.1} mm2", r.thin.unprintable_area_mm2, r.thin.wall_only_area_mm2)); }

    // ---- R4 layer height
    if opt.allow_layer_height {
        let cur = base.f64("layer_height").unwrap_or(0.2);
        let nozzle = base.f64("nozzle_diameter").unwrap_or(0.4);
        let max_dim = r.bed.footprint[0].max(r.bed.footprint[1]).max(r.bed.footprint[2]);
        let slant = r.surface.slant_share;
        let gentle = r.surface.gentle_share;
        // stair-step (cusp) error scales with layer height: c = h * |cos(theta)|; the visible part is the gently slanted surface (5..45 degrees)
        let want: Option<(f64, String)> = if opt.use_case == UseCase::Display {
            Some((0.12, format!("display part: finer layers cut the stair-step error on the {:.0}% gently slanted surface from {cur} to 0.12 mm", 100.0 * gentle)))
        } else if opt.use_case == UseCase::Auto && gentle >= 0.15 && max_dim <= 100.0 {
            Some((0.16, format!("{:.0}% of the surface is gently slanted (5-45 degrees) on a small part ({max_dim:.0} mm): stair-step error falls from {cur} to 0.16 mm at about +25% print time", 100.0 * gentle)))
        } else if matches!(opt.use_case, UseCase::Auto | UseCase::Prototype) && slant < 0.03 && r.estimate.time_min > 60.0 && r.thin.smallest_feature_mm.map_or(true, |w| w >= 0.8) {
            Some((0.28, format!("no slanted surface ({:.0}%), no fine feature and a long print ({:.0} min): thicker layers save time", 100.0 * slant, r.estimate.time_min)))
        } else { None };
        match want {
            Some((h, why)) if (h - cur).abs() > 1e-9 && h <= 0.8 * nozzle + 1e-9 => put(&mut d, "layer_height", format!("{h}"), why, "rule: cusp-height practice; time effect measured in eval-autoconfig where applicable".into()),
            _ => d.considered.push(format!("layer height stays {cur} mm: slanted surface {:.0}%, time {:.0} min", 100.0 * slant, r.estimate.time_min)),
        }
    }

    // ---- R5 walls and infill from use
    let dens = pct(base, "sparse_infill_density").unwrap_or(15.0);
    let loops = base.i64("wall_loops").unwrap_or(2);
    let sparse_share = if r.estimate.volume_cm3 > 0.0 { r.estimate.sparse_cm3 / (r.estimate.shell_cm3 + r.estimate.solid_cm3 + r.estimate.sparse_cm3).max(1e-9) } else { 0.0 };
    let (want_loops, want_dens, why): (i64, f64, String) = match opt.use_case {
        UseCase::Functional => (loops.max(3), dens.max(25.0), "functional part: 3 walls and 25% infill".into()),
        UseCase::Prototype => (loops, dens.min(10.0), "prototype: 10% infill is enough for a fit check".into()),
        _ if f.tall_slender => (loops.max(3), dens.max(20.0), format!("tall and slender (height / smallest footprint {:.1}): extra wall and infill resist bending", r.stability.slenderness)),
        _ => (loops, dens, String::new()),
    };
    if want_loops != loops { put(&mut d, "wall_loops", format!("{want_loops}"), why.clone(), "rule: stiffness grows with wall count more than with infill".into()); }
    if (want_dens - dens).abs() > 1e-9 {
        if sparse_share < 0.05 { d.considered.push(format!("infill density: wanted {want_dens:.0}% but infill is only {:.0}% of the part", 100.0 * sparse_share)); }
        else { put(&mut d, "sparse_infill_density", format!("{want_dens:.0}%"), why.clone(), "rule: use-case table".into()); }
    }
    if want_loops == loops && (want_dens - dens).abs() <= 1e-9 { d.considered.push(format!("walls/infill: {loops} walls, {dens:.0}% suit use case {:?}", opt.use_case)); }

    // ---- R6 bridges
    if f.has_bridge && !f.bridge_over_limit && r.bridges.max_span_mm >= 6.0 && base.bool_("thick_bridges").map_or(false, |b| !b) {
        put(&mut d, "thick_bridges", "1".into(), format!("longest bridge {:.0} mm: a round thick bead sags less than a flat one over that span", r.bridges.max_span_mm), "rule: Orca documents thick bridges for long spans; effect not visible in G-code beyond bead size".into());
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preflight::{preflight, tests::*};
    use crate::mesh::tests::box_soup;

    fn base(extra: &[(&str, &str)]) -> Config {
        let mut ex = vec![("enable_support", "0"), ("support_type", "tree(auto)"), ("brim_type", "no_brim"), ("brim_width", "5"), ("thick_bridges", "0")];
        ex.extend_from_slice(extra);
        test_cfg(&ex)
    }
    fn run(soup: &[[f64; 9]], cfg: &Config, opt: &AutoOptions) -> SettingsDelta {
        let (m, l) = slice_soup(soup, cfg);
        autoconfig(&preflight(&m, cfg, &l), cfg, opt)
    }

    #[test] fn cube_changes_nothing_and_apply_is_a_noop() {
        let cfg = base(&[]);
        let d = run(&box_soup(20.0, 20.0, 20.0), &cfg, &AutoOptions::default());
        assert!(d.is_empty(), "{}", d.explain());
        let mut c2 = cfg.clone();
        assert_eq!(d.apply(&mut c2).unwrap(), 0);
        assert_eq!(c2.raw_map(), cfg.raw_map());
    }
    #[test] fn t_overhang_turns_support_on_with_normal_type() {
        let cfg = base(&[]);
        let d = run(&t_prism(), &cfg, &AutoOptions::default());
        assert_eq!(d.get("enable_support"), Some("1"), "{}", d.explain());
        assert_eq!(d.get("support_type"), Some("normal(auto)"));
        assert!(d.explain().contains("why"));
    }
    #[test] fn support_on_is_turned_off_when_not_needed() {
        let cfg = base(&[("enable_support", "1")]);
        let d = run(&box_soup(20.0, 20.0, 20.0), &cfg, &AutoOptions::default());
        assert_eq!(d.get("enable_support"), Some("0"));
        let short = run(&crate::improve::shapes::prism(&[[-15., 0.], [-4., 0.], [-4., 10.], [4., 10.], [4., 0.], [15., 0.], [15., 14.], [-15., 14.]], 20.0), &cfg, &AutoOptions::default());
        assert_eq!(short.get("enable_support"), Some("0"), "8 mm PETG bridge needs no support: {}", short.explain());
    }
    #[test] fn thin_wall_switches_to_arachne_and_tower_gets_brim_and_walls() {
        let cfg = base(&[]);
        let mut soup = crate::improve::shapes::boxs(20., 20., 1.);
        soup.extend(crate::improve::shapes::translate(&crate::improve::shapes::boxs(0.3, 20., 10.), [30., 0., 0.]));
        assert_eq!(run(&soup, &cfg, &AutoOptions::default()).get("wall_generator"), Some("arachne"));
        let d = run(&box_soup(5.0, 5.0, 50.0), &cfg, &AutoOptions::default());
        assert_eq!(d.get("brim_type"), Some("outer_only"));
        assert_eq!(d.get("wall_loops"), Some("3"));
    }
    #[test] fn unknown_key_is_refused_and_nothing_is_written() {
        let cfg = base(&[]);
        let mut d = SettingsDelta::default();
        d.changes.push(Change { key: "brim_width".into(), old: None, value: "9".into(), reason: String::new(), basis: String::new() });
        d.changes.push(Change { key: "no_such_key".into(), old: None, value: "1".into(), reason: String::new(), basis: String::new() });
        let mut c2 = cfg.clone();
        assert!(d.apply(&mut c2).is_err());
        assert_eq!(c2.raw("brim_width"), cfg.raw("brim_width"));
    }
    #[test] fn use_case_controls_infill() {
        let cfg = base(&[]);
        let f = run(&box_soup(40.0, 40.0, 40.0), &cfg, &AutoOptions { use_case: UseCase::Functional, ..Default::default() });
        assert_eq!(f.get("sparse_infill_density"), Some("25%"));
        assert_eq!(f.get("wall_loops"), Some("3"));
        let p = run(&box_soup(40.0, 40.0, 40.0), &cfg, &AutoOptions { use_case: UseCase::Prototype, ..Default::default() });
        assert_eq!(p.get("sparse_infill_density"), Some("10%"));
    }
}
