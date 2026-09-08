//! The post-processor seam.
//!
//! A post turns a controller-agnostic [`Toolpath`] into one dialect. Everything
//! above this line has already decided what to cut; a post only writes it down.
//!
//! # Why a trait, with one implementation
//!
//! Because the second one has to be a NEW FILE rather than an edit to the first.
//! The moment a second dialect is added by branching inside `post_grblhal`, the
//! two share every future change and the grblHAL output starts depending on
//! decisions made for something else.
//!
//! The test at the bottom is the part that matters: it implements a second post
//! for a second [`Technology`] **entirely inside the test module**, and requires
//! it to work through this trait without any change to the CNC path. If that
//! test ever needs a change to `post_grblhal.rs` to compile, the seam has closed
//! and the claim in `README.md` — that additive would arrive alongside rather
//! than through — has stopped being true.

use crate::post_grblhal::{post_grblhal, PostOptions, PostResult};
use crate::tech::Technology;
use crate::types::{Machine, OperationParams, Stock, Toolpath};

/// A dialect writer.
pub trait Post {
    /// Human name, for reports and for the program comment.
    fn name(&self) -> &str;

    /// The process this dialect belongs to. A post is asked for by technology,
    /// so a CNC job can never be handed an additive dialect by accident.
    fn technology(&self) -> Technology;

    fn write(
        &self,
        path: &Toolpath,
        machine: &Machine,
        stock: &Stock,
        op: &OperationParams,
        opts: &PostOptions,
    ) -> PostResult;
}

/// grblHAL — the only shipping dialect.
pub struct GrblHal;

impl Post for GrblHal {
    fn name(&self) -> &str {
        "grblHAL"
    }

    fn technology(&self) -> Technology {
        Technology::Cnc
    }

    fn write(
        &self,
        path: &Toolpath,
        machine: &Machine,
        stock: &Stock,
        op: &OperationParams,
        opts: &PostOptions,
    ) -> PostResult {
        post_grblhal(path, machine, stock, op, opts)
    }
}

/// Every post this build can produce.
pub fn available() -> Vec<Box<dyn Post>> {
    vec![Box::new(GrblHal)]
}

/// The post for a technology, if this build has one.
///
/// 🔴 Returns `None` rather than falling back. A job asking for a technology
/// with no post must be REFUSED — silently posting it as grblHAL would emit
/// spindle commands for a process that has no spindle.
pub fn for_technology(t: Technology) -> Option<Box<dyn Post>> {
    available().into_iter().find(|p| p.technology() == t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Move, Tool, Vec3};

    fn a_path() -> Toolpath {
        let mut p = Toolpath {
            moves: vec![
                Move::comment("t"),
                Move::spindle_on(18_000.0),
                Move::rapid(Vec3::new(10.0, 10.0, 5.0)),
                Move::feed_to(Vec3::new(10.0, 10.0, -3.0), 300.0),
                Move::feed_to(Vec3::new(90.0, 10.0, -3.0), 1200.0),
                Move::spindle_off(),
            ],
            tool: Tool::default(),
            ..Default::default()
        };
        p.recompute_bounds();
        p
    }

    #[test]
    fn the_shipping_build_has_a_cnc_post_and_no_additive_one() {
        assert!(for_technology(Technology::Cnc).is_some());
        // 🔴 None, not a fallback. Posting an additive job through a CNC dialect
        // would emit M3 for a process with no spindle.
        assert!(for_technology(Technology::Fdm).is_none());
    }

    #[test]
    fn the_cnc_post_still_produces_what_the_gates_expect_through_the_trait() {
        // The trait must not change the output. If routing through it altered a
        // single byte, every golden file and the browser/CLI parity gate would
        // be describing a program nobody actually posts.
        let p = a_path();
        let (m, st, op, o) = (
            Machine::default(),
            Stock::default(),
            OperationParams::default(),
            PostOptions::default(),
        );
        let direct = post_grblhal(&p, &m, &st, &op, &o);
        let viat = GrblHal.write(&p, &m, &st, &op, &o);
        assert_eq!(direct.gcode, viat.gcode, "the trait changed the emitted program");
    }

    // ======================================================================
    //  THE SEAM TEST
    //
    //  A second technology's post, implemented here and nowhere else. It exists
    //  to prove one property: a new process is a NEW FILE, not an edit to the
    //  CNC path. If this stops compiling without touching post_grblhal.rs, the
    //  seam has closed.
    // ======================================================================
    struct ToyExtruderPost;

    impl Post for ToyExtruderPost {
        fn name(&self) -> &str {
            "toy-extruder"
        }
        fn technology(&self) -> Technology {
            Technology::Fdm
        }
        fn write(
            &self,
            path: &Toolpath,
            _machine: &Machine,
            _stock: &Stock,
            _op: &OperationParams,
            _opts: &PostOptions,
        ) -> PostResult {
            // Deliberately minimal — this is a seam probe, not an FDM post.
            let mut g = String::from("G21 G90\n");
            let mut e = 0.0;
            let mut last: Option<Vec3> = None;
            for m in &path.moves {
                match m.kind {
                    crate::types::MoveKind::Feed => {
                        if let Some(p) = last {
                            e += ((m.to.x - p.x).powi(2) + (m.to.y - p.y).powi(2)).sqrt() * 0.04;
                        }
                        g.push_str(&format!(
                            "G1 X{:.3} Y{:.3} Z{:.3} E{:.4}\n",
                            m.to.x, m.to.y, m.to.z, e
                        ));
                        last = Some(m.to);
                    }
                    crate::types::MoveKind::Rapid => {
                        g.push_str(&format!("G0 X{:.3} Y{:.3} Z{:.3}\n", m.to.x, m.to.y, m.to.z));
                        last = Some(m.to);
                    }
                    _ => {}
                }
            }
            // `..Default::default()` rather than an exhaustive literal: this is
            // a SEAM PROBE, and a probe that has to be edited every time the
            // CNC post gains a field is a seam that resists the second
            // technology it exists to prove is cheap.
            PostResult { gcode: g, ..Default::default() }
        }
    }

    #[test]
    fn a_second_technology_plugs_in_without_touching_the_cnc_post() {
        let p = a_path();
        let out = ToyExtruderPost.write(
            &p,
            &Machine::default(),
            &Stock::default(),
            &OperationParams::default(),
            &PostOptions::default(),
        );
        assert!(out.gcode.contains(" E"), "the seam did not carry an extrusion axis");
        assert!(out.ok());
        assert_eq!(ToyExtruderPost.technology(), Technology::Fdm);
    }

    #[test]
    fn each_technology_rejects_the_other_ones_output() {
        // The scoped ban, exercised end to end: the CNC program must survive the
        // CNC ban list, and the additive program must survive the additive one —
        // AND each must be caught by the other's. That last half is what proves
        // the lists are not both empty.
        let p = a_path();
        let cnc = GrblHal
            .write(
                &p,
                &Machine::default(),
                &Stock::default(),
                &OperationParams::default(),
                &PostOptions { emit_comments: false, ..PostOptions::default() },
            )
            .gcode;
        let fdm = ToyExtruderPost
            .write(
                &p,
                &Machine::default(),
                &Stock::default(),
                &OperationParams::default(),
                &PostOptions::default(),
            )
            .gcode;

        let hits = |text: &str, t: Technology| -> Vec<&'static str> {
            t.banned_output()
                .iter()
                .filter(|(w, _)| simple_match(text, w))
                .map(|(_, why)| *why)
                .collect()
        };

        assert!(hits(&cnc, Technology::Cnc).is_empty(), "CNC output trips its own ban");
        assert!(hits(&fdm, Technology::Fdm).is_empty(), "FDM output trips its own ban");
        assert!(!hits(&fdm, Technology::Cnc).is_empty(), "the CNC ban does not catch an E word");
        assert!(!hits(&cnc, Technology::Fdm).is_empty(), "the FDM ban does not catch M3");
    }

    /// Tiny matcher for the handful of patterns in `banned_output`, so this test
    /// needs no regex dependency. Handles `\b`, `-?`, and character classes of
    /// the shapes actually used.
    fn simple_match(text: &str, pat: &str) -> bool {
        // Reduce the pattern to the literal codes it can match, then look for
        // them as whole words.
        let lits: Vec<String> = match pat {
            r"\bE-?\d" => (0..10).map(|d| format!("E{d}")).collect(),
            r"\bM10[4-9]\b" => (4..10).map(|d| format!("M10{d}")).collect(),
            r"\bM14[01]\b" => (0..2).map(|d| format!("M14{d}")).collect(),
            r"\bM10[6-7]\b" => (6..8).map(|d| format!("M10{d}")).collect(),
            r"\bG4[12]\b" => vec!["G41".into(), "G42".into()],
            r"\bT\d+\s*M6\b" => vec!["M6".into()],
            r"\bM3\b" => vec!["M3".into()],
            r"\bG8[123]\b" => vec!["G81".into(), "G82".into(), "G83".into()],
            other => vec![other.to_string()],
        };
        text.split(|c: char| c.is_whitespace())
            .any(|tok| lits.iter().any(|l| tok == l || tok.starts_with(l.as_str())))
    }
}

// ===========================================================================
//  CONTROLLER CAPABILITIES — asserted on the EMITTED PROGRAM.
//
//  `Machine::supports_arcs` and `Machine::supports_canned_drill` exist so a
//  board that cannot execute `G2/G3` or `G81..G83` receives something it can.
//  Until these tests were written NOTHING IN THE TREE EVER SET EITHER OF THEM
//  FALSE: the degradation was reached only through `PostOptions::emit_arcs`
//  (the CLI's `--no-arcs`, which gate G7 drives), so the line
//
//      if !machine.supports_arcs || !opts.emit_arcs
//
//  was one branch with two inputs and only the second was ever exercised. A
//  build that stopped honouring the capability — read it off the wrong machine,
//  drop it from the config merge, invert it — would have left every check green
//  while a controller with no arc support was handed `G2`. **A capability never
//  exercised in its restrictive state is a capability nobody has tested.**
//
//  The physical failure: a controller that ignores or mis-executes `G2/G3` cuts
//  a straight line where the program says an arc, or stalls mid-cut with the
//  spindle down.
//
//  They live at the seam rather than inside `post_grblhal.rs` because the
//  question is "what does THE POST this build selects do with a declared
//  capability", and it is asked here through the same `Post` trait a caller
//  uses. Every assertion below reads the emitted text; none reads the flag it
//  set, and none reads the plan.
// ===========================================================================
#[cfg(test)]
mod capability_tests {
    use super::*;
    use crate::types::{Move, Tool, Vec2, Vec3};

    /// A machine with NO probe. This module is asking about arcs and canned
    /// cycles; a probe preamble drags an unrelated datum refusal into every
    /// answer, and a test that fails for a reason it is not about teaches the
    /// next reader to ignore it.
    fn machine() -> Machine {
        Machine { probe_enabled: false, ..Machine::default() }
    }

    /// Code lines only. The preamble legitimately NAMES `G41/G42` and discusses
    /// arcs, so a scan over raw text matches the sentence that explains the ban
    /// — the same false failure G2 and G12 both had on their first run.
    fn code_lines(g: &str) -> Vec<&str> {
        g.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('(')).collect()
    }

    fn count_starting(g: &str, prefixes: &[&str]) -> usize {
        code_lines(g).iter().filter(|l| prefixes.iter().any(|p| l.starts_with(p))).count()
    }

    /// The word value on an emitted line, e.g. `word("G1 X80.000 Y100.000", 'X')`.
    fn word(line: &str, w: char) -> Option<f64> {
        line.split_whitespace().find_map(|t| {
            let mut c = t.chars();
            (c.next()? == w).then(|| c.as_str().parse::<f64>().ok())?
        })
    }

    /// The smallest program that cuts an arc: spindle on, down, ONE arc, off.
    /// `to == start` makes it a full circle, which is a legal `Move::arc` and is
    /// the case the last test is about.
    fn one_arc(cw: bool, start: (f64, f64), to: (f64, f64), centre: (f64, f64)) -> Toolpath {
        let z = -3.0;
        let mut p = Toolpath {
            moves: vec![
                Move::spindle_on(18_000.0),
                Move::rapid(Vec3::new(start.0, start.1, 5.0)),
                Move::feed_to(Vec3::new(start.0, start.1, z), 300.0),
                Move::arc(cw, Vec3::new(to.0, to.1, z), Vec2::new(centre.0, centre.1), 1200.0),
                Move::spindle_off(),
            ],
            tool: Tool::default(),
            ..Default::default()
        };
        p.recompute_bounds();
        p
    }

    fn post(path: &Toolpath, m: &Machine, opts: &PostOptions) -> PostResult {
        GrblHal.write(path, m, &Stock::default(), &OperationParams::default(), opts)
    }

    // -- arcs ---------------------------------------------------------------

    #[test]
    fn a_controller_that_declares_no_arcs_receives_no_g2_or_g3() {
        // 90° of R20, so the arc is unambiguously an arc and not a rounding.
        let path = one_arc(false, (120.0, 100.0), (100.0, 120.0), (100.0, 100.0));

        // The vacuity control, FIRST. "0 arcs emitted" is free on a program that
        // never had one — an empty or refused program would pass the assertion
        // this test exists to make.
        let armed = post(&path, &machine(), &PostOptions::default());
        assert!(armed.ok(), "{:?}", armed.errors);
        assert_eq!(
            count_starting(&armed.gcode, &["G2 ", "G3 "]),
            1,
            "the arc-capable machine emitted no arc, so the degradation assertion below would \
             prove nothing"
        );
        let armed_g1 = count_starting(&armed.gcode, &["G1 "]);

        // The capability says no. `emit_arcs` is left TRUE deliberately: this
        // must degrade on the CONTROLLER's answer alone.
        let m = Machine { supports_arcs: false, ..machine() };
        let opts = PostOptions::default();
        assert!(opts.emit_arcs, "the option must stay on or this test is G7 again");
        let degraded = post(&path, &m, &opts);
        assert!(degraded.ok(), "{:?}", degraded.errors);
        assert_eq!(
            count_starting(&degraded.gcode, &["G2 ", "G3 "]),
            0,
            "a controller that declares no arc support was handed G2/G3 — it will ignore the \
             block, mis-execute it, or stall mid-cut with the spindle down:\n{}",
            degraded.gcode
        );
        assert_eq!(
            count_starting(&degraded.gcode, &["G1 "]),
            armed_g1 + 1,
            "the arc did not become a linear move — it was DROPPED, which cuts a part with a \
             feature missing:\n{}",
            degraded.gcode
        );
        // And it says so. A silent substitution is a different part with no
        // symptom in the program.
        assert!(
            degraded.warnings.iter().any(|w| w.contains("arc degraded")),
            "the program was changed and nothing said so: {:?}",
            degraded.warnings
        );
    }

    #[test]
    fn the_capability_and_the_option_are_two_independent_inputs_to_one_branch() {
        let path = one_arc(false, (120.0, 100.0), (100.0, 120.0), (100.0, 100.0));
        // (supports_arcs, emit_arcs) -> arcs expected in the emitted program.
        // Only the first row may contain one. The THIRD row is what G7 covers;
        // the second is the one nothing covered.
        for (cap, emit, want) in
            [(true, true, 1usize), (false, true, 0), (true, false, 0), (false, false, 0)]
        {
            let m = Machine { supports_arcs: cap, ..machine() };
            let r = post(&path, &m, &PostOptions { emit_arcs: emit, ..PostOptions::default() });
            assert!(r.ok(), "{:?}", r.errors);
            assert_eq!(
                count_starting(&r.gcode, &["G2 ", "G3 "]),
                want,
                "supports_arcs={cap} emit_arcs={emit} emitted the wrong number of arcs — the two \
                 inputs are not independent:\n{}",
                r.gcode
            );
        }
    }

    #[test]
    fn a_degraded_arc_is_one_chord_and_its_error_is_bounded_by_nothing() {
        // 🔴 RECORDED, NOT ENDORSED. This test pins today's behaviour and prints
        // the number it is worth: the post replaces each arc MOVE with ONE
        // straight line to the same endpoint. The deviation is the sagitta,
        // R(1-cos(sweep/2)), and NOTHING in the core caps it — how finely an arc
        // was subdivided upstream is decided by tab width and ramping, which are
        // not tolerances. A half-turn therefore deviates by a full RADIUS: a
        // profiled hole becomes a straight line across its own diameter and the
        // hole is not cut at all.
        //
        // If a chord tolerance is ever implemented, this test goes red. Invert
        // it — do not delete it. See FUNCTIONAL-SPEC.md A5.
        let r_mm = 20.0;
        let path = one_arc(false, (120.0, 100.0), (80.0, 100.0), (100.0, 100.0)); // 180°
        let m = Machine { supports_arcs: false, ..machine() };
        let g = post(&path, &m, &PostOptions::default());
        assert!(g.ok(), "{:?}", g.errors);

        let cuts: Vec<&str> = code_lines(&g.gcode)
            .into_iter()
            .filter(|l| l.starts_with("G1 ") && word(l, 'X').is_some())
            .collect();
        assert_eq!(
            cuts.len(),
            1,
            "the half-turn was replaced by {} moves — if that is a tolerance-bounded polyline, \
             this test is out of date and should be inverted, not deleted:\n{}",
            cuts.len(),
            g.gcode
        );
        // G-code words are MODAL: the emitted line carries no Y because the
        // chord's endpoints share one, which is itself the shape of the defect
        // — half a turn of a circle collapses onto a single straight line.
        let (sx, sy) = (120.0f64, 100.0f64);
        let (ex, ey) = (word(cuts[0], 'X').unwrap_or(sx), word(cuts[0], 'Y').unwrap_or(sy));
        assert!((ex - 80.0).abs() < 1e-6 && (ey - 100.0).abs() < 1e-6, "{}", cuts[0]);

        // The deviation, measured from the EMITTED line rather than asserted
        // from theory: how far the far point of the true arc — (100, 120) —
        // lies from the straight move the program actually contains.
        let (fx, fy) = (100.0f64, 120.0f64);
        let (dx, dy) = (ex - sx, ey - sy);
        let t = (((fx - sx) * dx + (fy - sy) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
        let deviation = ((fx - (sx + t * dx)).powi(2) + (fy - (sy + t * dy)).powi(2)).sqrt();
        assert!(
            (deviation - r_mm).abs() < 1e-6,
            "expected the chord to miss the true arc by a full radius ({r_mm}mm); measured \
             {deviation}mm"
        );
    }

    #[test]
    fn a_full_circle_arc_degrades_to_no_motion_at_all() {
        // 🔴 The worst shape of the same defect, and the reason the one above is
        // not the whole story. An arc whose end IS its start is a full turn. The
        // chord has zero length, the post emits no axis words, and the feature
        // leaves the program entirely — with a warning that says "degraded",
        // which reads as "approximated", not as "removed".
        //
        // `geometry::Contour::circle` encodes a circle as TWO half-turns, so the
        // engine does not produce this move today; `Move::arc` accepts it, the
        // post has no guard, and a bore emitted as one turn would vanish.
        let path = one_arc(true, (120.0, 100.0), (120.0, 100.0), (100.0, 100.0));
        let m = Machine { supports_arcs: false, ..machine() };
        let g = post(&path, &m, &PostOptions::default());
        assert!(g.ok(), "{:?}", g.errors);
        assert_eq!(
            count_starting(&g.gcode, &["G2 ", "G3 "]),
            0,
            "arcs are off and one was emitted anyway:\n{}",
            g.gcode
        );
        let xy_cuts = code_lines(&g.gcode)
            .into_iter()
            .filter(|l| l.starts_with("G1 ") && word(l, 'X').is_some())
            .count();
        assert_eq!(
            xy_cuts, 0,
            "today a full-turn arc degrades to NOTHING. If it now emits motion, this defect has \
             been fixed and this test should be inverted to assert the fix:\n{}",
            g.gcode
        );
        assert!(
            g.warnings.iter().any(|w| w.contains("arc degraded")),
            "a whole feature left the program in silence: {:?}",
            g.warnings
        );
    }

    // -- canned cycles ------------------------------------------------------

    #[test]
    fn a_controller_with_no_canned_cycles_gets_no_g8x_and_still_reaches_full_depth() {
        // The failure this guards is not a syntax error: grblHAL's canned cycles
        // are a COMPILE-TIME option, so a build without them answers `error:20`
        // to the G83 gate G9 asserts on — and G9 stays green, because it
        // measures our output against a document. A hole that stops short is the
        // other half: it looks right and will not take its fastener.
        let depth = -18.0;
        let mut path = Toolpath {
            moves: vec![
                Move::spindle_on(18_000.0),
                Move::rapid(Vec3::new(50.0, 50.0, 5.0)),
                Move::drill(Vec3::new(50.0, 50.0, depth), 3.0, 200.0),
                Move::spindle_off(),
            ],
            tool: Tool::default(),
            ..Default::default()
        };
        path.recompute_bounds();

        // Vacuity control first, again: the machine that HAS canned cycles must
        // emit one, or "no G8x" below is free.
        let armed = post(&path, &machine(), &PostOptions::default());
        assert!(armed.ok(), "{:?}", armed.errors);
        assert!(
            count_starting(&armed.gcode, &["G98 G83", "G83", "G81", "G82"]) > 0,
            "the canned-cycle machine emitted no canned cycle:\n{}",
            armed.gcode
        );

        let m = Machine { supports_canned_drill: false, ..machine() };
        let r = post(&path, &m, &PostOptions::default());
        assert!(r.ok(), "{:?}", r.errors);
        assert_eq!(
            count_starting(&r.gcode, &["G98 G8", "G81", "G82", "G83", "G80"]),
            0,
            "a controller built without canned cycles was handed one — it answers error:20 and \
             the program stops with the tool in the work:\n{}",
            r.gcode
        );
        // Depth is read back off the emitted text. An expansion that pecks
        // politely and stops 2mm short is the failure with no symptom.
        let deepest = code_lines(&r.gcode)
            .iter()
            .filter(|l| l.starts_with("G1 "))
            .filter_map(|l| word(l, 'Z'))
            .fold(f64::INFINITY, f64::min);
        assert!(
            (deepest - depth).abs() < 1e-6,
            "the host-side expansion bottoms at {deepest}mm against a commanded {depth}mm — the \
             hole is short and looks finished:\n{}",
            r.gcode
        );
    }

    // -- cutter compensation ------------------------------------------------

    #[test]
    fn cutter_comp_cannot_be_switched_on_because_grblhal_has_none() {
        // `supports_cutter_comp` is false and stays false: grblHAL's supported
        // set lists G40 and NOT G41/G42, so every tool-radius offset is already
        // in the coordinates. Measured 2026-08-09: the field is READ BY NOTHING
        // in the tree and `MachineCfg` does not carry it, so a job config naming
        // it is refused by `deny_unknown_fields` rather than quietly accepted.
        //
        // This asserts the property that matters — a machine that CLAIMS the
        // capability gets exactly the same program, with no G41/G42 in it. If a
        // future post ever reads the flag, that is a decision to be argued with
        // a controller in front of you, and this test is where it lands.
        let path = one_arc(false, (120.0, 100.0), (100.0, 120.0), (100.0, 100.0));
        let off = post(&path, &machine(), &PostOptions::default());
        let claimed = Machine { supports_cutter_comp: true, ..machine() };
        let on = post(&path, &claimed, &PostOptions::default());
        assert_eq!(
            off.gcode, on.gcode,
            "declaring cutter comp changed the program — grblHAL core has no G41/G42 to honour it"
        );
        assert_eq!(
            count_starting(&on.gcode, &["G41", "G42"]),
            0,
            "the post emitted controller-side cutter compensation, which this controller does not \
             implement — every coordinate would be offset by a radius the machine never applies:\n{}",
            on.gcode
        );
    }
}
