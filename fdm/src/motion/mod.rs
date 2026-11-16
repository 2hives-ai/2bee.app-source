//! Lane 5 (motion): everything between "extrusion paths per layer" and "ordered, routed moves".
//!
//! * `settings`  - `Settings`, the Orca CONFIG_BLOCK reader every other module here uses (`Settings::from_config` adapts lane 1's `Config`).
//! * `template`  - the Orca PlaceholderParser subset used by the machine / layer / filament / time-lapse G-code macros.
//! * `time`      - port of `GCodeProcessor`'s time model (acceleration, jerk, junction, M204/M205/M201/M203, waits) + `M73` data.
//! * `seam`      - seam placement (`seam_position`, `seam_gap`, alignment across layers by spline fit).
//! * `skirt`     - skirt (Clipper-exact round offset of the convex hull) and brim (outer / inner / both).
//! * `plan`      - per-layer ordering: wall loops, islands, infill runs and their greedy chaining.
//! * `cooling`   - `CoolingBuffer`: minimum-layer-time slow-down and fan commands, on text with Orca's markers.
//! * `chain`    - exact port of Orca's greedy end-point chaining (infill/entity ordering, island ordering).
//! * `arcs`      - arc fitting of extrusion paths (`G2/G3`), `ArcFitter` port.
//! * `overhang`  - overhang speed ramp (`ExtrusionQualityEstimator`) and per-point overhang-fan decision.
//! * `visibility` - mesh-visibility raycast (`SeamPlacer` occlusion) feeding the seam score.
//! * `geo`       - small private 2-D helpers (offset via `i_overlay`, hull, point-in-polygon, 2-opt).
//!
//! The retraction / wipe / z-hop / travel decisions need the live writer state (what is retracted, where the nozzle
//! is, whether the head position is "clear"), exactly as in Orca's `GCode::travel_to`, so they live in `gcode.rs`
//! next to the writer.

pub mod arcs;
pub mod chain;
pub mod cooling;
pub mod geo;
pub mod optdefs;
pub mod overhang;
pub mod plan;
pub mod seam;
pub mod settings;
pub mod skirt;
pub mod template;
pub mod time;
pub mod visibility;
#[cfg(test)]
pub mod testutil;

pub use settings::Settings;

/// C `printf("%g")` / C++ `ostream <<` for a double (6 significant digits, trailing zeros removed).
pub fn fmt_g(d: f64) -> String {
    if d == 0.0 { return "0".into(); }
    if !d.is_finite() { return if d.is_nan() { "nan".into() } else if d > 0.0 { "inf".into() } else { "-inf".into() }; }
    // Round to 6 significant digits first; the exponent after rounding picks the style.
    let sci = format!("{:.5e}", d);
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if exp < -4 || exp >= 6 {
        let mant = mant.trim_end_matches('0').trim_end_matches('.');
        format!("{}e{}{:02}", mant, if exp < 0 { '-' } else { '+' }, exp.abs())
    } else {
        let decimals = (5 - exp).max(0) as usize;
        let s = format!("{:.*}", decimals, d);
        if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s }
    }
}

/// Orca `GCodeFormatter::emit_axis` number: `digits` decimals, trailing zeros removed, no leading zero
/// ("0.6" -> ".6", "-0.4" -> "-.4", "0" -> "0").
pub fn fmt_axis(v: f64, digits: usize) -> String {
    let p10 = 10f64.powi(digits as i32);
    let n = (v * p10).round() as i64;
    if n == 0 { return "0".into(); }
    let neg = n < 0;
    let a = n.unsigned_abs();
    let ip = a / (p10 as u64);
    let fp = a % (p10 as u64);
    let mut s = String::new();
    if neg { s.push('-'); }
    if ip > 0 { s.push_str(&ip.to_string()); }
    if fp > 0 {
        let f = format!("{:0w$}", fp, w = digits);
        s.push('.');
        s.push_str(f.trim_end_matches('0'));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g_format() {
        assert_eq!(fmt_g(0.2), "0.2");
        assert_eq!(fmt_g(20.0), "20");
        assert_eq!(fmt_g(0.42), "0.42");
        assert_eq!(fmt_g(0.419999), "0.419999");
        assert_eq!(fmt_g(0.504344), "0.504344");
        assert_eq!(fmt_g(1234567.0), "1.23457e+06");
        assert_eq!(fmt_g(0.00001234), "1.234e-05");
        assert_eq!(fmt_g(102.0), "102");
        assert_eq!(fmt_g(0.1 + 0.2), "0.3");
    }

    #[test]
    fn axis_format() {
        assert_eq!(fmt_axis(0.6, 3), ".6");
        assert_eq!(fmt_axis(-0.4, 5), "-.4");
        assert_eq!(fmt_axis(127.448, 3), "127.448");
        assert_eq!(fmt_axis(0.0, 3), "0");
        assert_eq!(fmt_axis(60000.0, 3), "60000");
        assert_eq!(fmt_axis(0.66796, 5), ".66796");
        assert_eq!(fmt_axis(20.4, 3), "20.4");
        assert_eq!(fmt_axis(0.0004, 3), "0");
    }
}
