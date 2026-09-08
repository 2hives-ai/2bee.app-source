//! Drilling — rated in FEED PER REVOLUTION against SURFACE SPEED, which is not
//! the quantity the rest of this crate reasons in.
//!
//! # 🔴 The defect this module exists to name
//!
//! Measured 2026-08-10, a ⌀6 brad point through 18mm plywood, `tool_ids` door,
//! default machine:
//!
//! ```text
//! M3 S24000
//! G98 G83 X230.000 Y90.000 Z-18.000 R5.000 Q4.000 F5760.0
//! ```
//!
//! and the sentence the operator was given beside it:
//!
//! > *"Plywood caps it at 24000rpm and 3mm per pass, so 6 pass(es) at 5760mm/min"*
//!
//! Every number in that line came from a **router-bit** model. `S24000` is
//! `Material::max_rpm()`, whose citation is Techno CNC's *"The general operating
//! RPM for Techno CNC **Tooling** is between 12,000 – 24,000 RPM"* — a sentence
//! about router cutters, on a router-cutter page. `F5760` is
//! `rpm x flutes x chipload`, the chip-per-tooth formula, applied to a tool whose
//! manufacturer does not rate it that way.
//!
//! **A drill is not a small end mill.** It cuts on its point, its outer corner
//! runs at the full peripheral speed with no relief and no chip clearance behind
//! it, and it is buried in a closed hole for the whole cut. LMT Onsrud's *Drill
//! Cutting Data Recommendations* (read 2026-08-10,
//! <https://onsrud.com/images/Drill.pdf>) rates wood drills in **inches per
//! revolution against surface speed**, and prints exactly one spindle speed for
//! wood drilling: a footnote reading ***"Gang drills run at 4,500 RPM and 150
//! IPM"***.
//!
//! ⚠ **4,500 rpm is not our number and must not be pasted in.** It describes a
//! production gang borer, not a brad point held in a 24,000 rpm router spindle
//! whose own declared floor is 6,000 rpm. Substituting one table for another is
//! how this whole class of defect started — `Material::chipload_factor(Acrylic)`
//! sat at 1.15 for months because a real published remedy (Onsrud's *"increase
//! feedrate or go to a single edge tool"*) was applied through the wrong control.
//!
//! # What this module therefore does
//!
//! It carries the **model** — the two published conversions, keyed on the right
//! quantity — and an **empty table of declared ratings**. Every drill in
//! `default_library()` comes back [`DrillRating::Undeclared`] with the reason,
//! and the caller decides what to do with that.
//!
//! 🔴 **The empty table is the finding, not an omission to be filled in.** A
//! number goes into [`DECLARED`] only with a source and a read date, on the
//! `core/src/spoilboards.rs` rule, and the drills this shop actually owns are
//! unbranded AliExpress carbide with no published table of any kind
//! (`docs/materials-research.md` §3.2). The real ceiling on this is a coupon
//! `ops` has not cut — not a better PDF.

use crate::tools::{ToolCategory, ToolSpec};

/// A drill's cutting data, in the quantities its manufacturer publishes.
///
/// 🔴 **Feed per REVOLUTION, not per tooth.** A drill's two lips are not two
/// independent cutting edges sweeping a wall — they are a single point splitting
/// one advance per turn between them, which is why every drill chart in the
/// corpus is stated per revolution and no chart in it is stated per tooth.
/// Storing this as a chipload would let it be multiplied by a flute count, and
/// the flute count is exactly what it must not be multiplied by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrillFeedModel {
    /// Feed per revolution, mm. (Onsrud publishes it as in/rev — `IPR`.)
    pub feed_per_rev_mm: f64,
    /// Cutting speed at the drill's outer corner, m/min. (Onsrud publishes it as
    /// surface feet per minute — `SFM`.)
    pub surface_speed_m_min: f64,
    /// 🔴 Manufacturer, document and READ DATE. A number in this table without
    /// one is the defect this module was written to stop.
    pub source: &'static str,
}

/// What is known about how to run one drill.
#[derive(Clone, Debug, PartialEq)]
pub enum DrillRating {
    /// A published figure for this cutter, with its source.
    Declared(DrillFeedModel),
    /// 🔴 Nothing has been declared for this cutter. **This is not "use the
    /// router numbers"** and it is not a rating of zero.
    Undeclared { why: String },
}

impl DrillRating {
    pub fn is_declared(&self) -> bool {
        matches!(self, Self::Declared(_))
    }

    /// Empty when a rating exists — a sentence that always speaks is one nobody
    /// reads, and the same convention as [`crate::tools::ShankFit::why`].
    pub fn why(&self) -> String {
        match self {
            Self::Declared(_) => String::new(),
            Self::Undeclared { why } => why.clone(),
        }
    }
}

/// 🔴 **DELIBERATELY EMPTY.** No drill in this crate has a published feed model.
///
/// The rules for adding a row, so that the next person does not have to guess:
///
/// 1. The figure must be **for the cutter it is attached to** — the same series,
///    the same point geometry, at the same diameter. A figure for a different
///    cutter of the same nominal size is a substitution, and every substitution
///    in this crate is now labelled as one.
/// 2. It must be **rated in the quantities of [`DrillFeedModel`]** — feed per
///    revolution and surface speed. A chip-per-tooth figure converted into these
///    units is still a chip-per-tooth figure.
/// 3. It must carry **manufacturer, document and read date** in `source`.
/// 4. A figure published for a **gang drill, a production borer or a drill
///    press** does not become ours by conversion. The spindle is part of the
///    rating: our brad points sit in a router spindle whose declared floor is
///    6,000 rpm, above the only wood-drilling speed the corpus prints.
///
/// ⚠ And the honest ceiling on all four rules: **no output of this program has
/// ever cut anything.** A chart is not a coupon.
pub const DECLARED: &[(&str, DrillFeedModel)] = &[];

/// Why nothing is declared, composed once so the planner, the tool list and the
/// CLI cannot each write their own version of it.
fn undeclared_why(spec: &ToolSpec) -> String {
    format!(
        "no drill feed model is declared for '{}'. A drill is rated in FEED PER REVOLUTION \
         against SURFACE SPEED (LMT Onsrud, Drill Cutting Data Recommendations, read \
         2026-08-10); this crate's cutting data is chip-per-tooth against a ROUTER-BIT rpm \
         ceiling, and the two are different models, not two units of one. The only wood-drilling \
         spindle speed in the corpus is Onsrud's 4,500 rpm footnote for GANG DRILLS, which does \
         not transfer to a brad point in a 24,000 rpm router spindle — so no number is published \
         here rather than a plausible one. Until one is declared with its source, the speed and \
         feed this program gives this drill are UNVOUCHED: they are the router-cutter figures, \
         and nothing has defended them for a drill",
        spec.id
    )
}

/// What is known about running this cutter as a drill.
///
/// Non-drills come back `Undeclared` too, with a reason saying so — asking a
/// V-bit for its drill rating is a caller error and returning a cheerful
/// `Declared` for it would be worse than saying nothing.
pub fn rating_for(spec: &ToolSpec) -> DrillRating {
    if spec.category() != ToolCategory::Drill {
        return DrillRating::Undeclared {
            why: format!(
                "'{}' is a {}, not a drill, so it has no drill feed model",
                spec.id,
                spec.category().as_str()
            ),
        };
    }
    match DECLARED.iter().find(|(id, _)| *id == spec.id.as_str()) {
        Some((_, m)) => DrillRating::Declared(*m),
        None => DrillRating::Undeclared { why: undeclared_why(spec) },
    }
}

// ===========================================================================
//  The two published conversions
// ===========================================================================
//
// 🔴 The FORMULAS are sourced even though no VALUE is, and the distinction is
// the point of this section. Onsrud prints the speed relation on the face of
// every one of its data sheets:
//
//     RPM = (3.82 x SFM) / tool diameter in inches
//
// which is the same relation as `rpm = surface speed / (pi x diameter)` once the
// units are carried through — 3.82 is `12 / pi`, the inch/foot conversion folded
// into the constant. Working it in millimetres and metres per minute avoids
// inheriting a rounded constant:
//
//     rpm = 1000 x v [m/min] / (pi x d [mm])
//
// and the feed follows from the definition of feed per revolution:
//
//     feed [mm/min] = feed_per_rev [mm] x rpm

/// Spindle speed that puts a drill of `diameter_mm` at `surface_speed_m_min` at
/// its outer corner.
///
/// Returns `None` for a non-positive diameter rather than dividing by it: a
/// tool with no diameter is a tool-definition fault
/// ([`crate::tools::ToolFault::NonPositiveDiameter`]) and is reported by the
/// validator, not invented around here.
pub fn rpm_for_surface_speed(surface_speed_m_min: f64, diameter_mm: f64) -> Option<f64> {
    if diameter_mm <= 0.0 {
        return None;
    }
    Some(1_000.0 * surface_speed_m_min / (std::f64::consts::PI * diameter_mm))
}

/// Feed in mm/min from a feed per revolution and a spindle speed.
///
/// 🔴 No flute count appears here, and that is the whole difference from
/// [`crate::feeds::feed_from_chipload`]. Multiplying a per-revolution feed by
/// the flutes would double the feed of a 2-flute drill, which is precisely the
/// mistake this module is named after.
pub fn feed_for_drill(feed_per_rev_mm: f64, rpm: f64) -> f64 {
    feed_per_rev_mm * rpm
}

/// The feed per revolution an emitted `rpm`/`feed` pair actually delivers — the
/// quantity a drill chart could be compared against, read off the **program**
/// rather than off the plan.
pub fn feed_per_rev_from(rpm: f64, feed_mm_min: f64) -> f64 {
    if rpm > 0.0 {
        feed_mm_min / rpm
    } else {
        0.0
    }
}

/// The note that must travel with any drilling this crate emits while
/// [`DECLARED`] is empty.
///
/// It states the emitted numbers, the model they came from, the model a drill is
/// actually rated in, and the figure the program delivers in that model — so an
/// operator can compare it against any chart they have, which is the one thing
/// this crate cannot do for them.
///
/// ⚠ **This is a note and not a refusal, and the reason is a lane boundary, not
/// a judgement that a note is enough.** The refusal belongs where the number is
/// selected for the emitted program; the `tool_id` door selects it in
/// `core/src/job.rs` and the reference fixtures and gate `REL` both plan drills
/// today. See the handover recorded with the change that added this module.
pub fn unvouched_speed_note(spec: &ToolSpec, rpm: f64, feed_mm_min: f64) -> String {
    format!(
        "🔴 THIS IS A DRILL RUN AT ROUTER-BIT NUMBERS. {rpm:.0}rpm comes from the material's \
         router-cutter ceiling and {feed_mm_min:.0}mm/min from chip-per-tooth x flutes — neither \
         is a drilling figure. In the model a drill IS rated in, this program delivers {:.3}mm \
         per revolution at {rpm:.0}rpm. {}",
        feed_per_rev_from(rpm, feed_mm_min),
        rating_for(spec).why()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{default_library, ToolCategory};

    fn drill(id: &str) -> ToolSpec {
        default_library().into_iter().find(|t| t.id == id).expect("no such tool")
    }

    /// 🔴 The state of the world, asserted rather than described: **nothing is
    /// declared.** If a row is ever added to `DECLARED` this test goes red and
    /// whoever added it has to come here and say what changed — which is the
    /// point, because a drill number arriving quietly is the defect.
    #[test]
    fn no_drill_in_this_crate_has_a_published_feed_model() {
        assert!(
            DECLARED.is_empty(),
            "a drill rating was declared; every row needs a source and a read date, and this \
             test is where that is acknowledged"
        );
        let lib = default_library();
        let drills: Vec<&ToolSpec> =
            lib.iter().filter(|t| t.category() == ToolCategory::Drill).collect();
        assert!(drills.len() >= 25, "only {} drills in the library", drills.len());
        for d in &drills {
            assert!(!rating_for(d).is_declared(), "{} claims a rating", d.id);
        }
    }

    /// The reason has to be readable and has to name the RIGHT QUANTITY, or the
    /// next person fills the gap with a chip-per-tooth number and the defect
    /// comes back wearing a citation.
    #[test]
    fn the_undeclared_reason_names_the_quantity_and_refuses_the_gang_drill_figure() {
        let why = rating_for(&drill("Drill - Brad Point 6mm 2F")).why();
        assert!(why.contains("FEED PER REVOLUTION"), "{why}");
        assert!(why.contains("SURFACE SPEED"), "{why}");
        assert!(why.contains("4,500"), "{why}");
        assert!(why.contains("GANG DRILLS"), "{why}");
        assert!(why.contains("Drill - Brad Point 6mm 2F"), "{why}");
    }

    #[test]
    fn asking_a_non_drill_for_a_drill_rating_says_so_rather_than_answering() {
        let r = rating_for(&drill("End Mill - Down-cut 6mm 2F"));
        assert!(!r.is_declared());
        assert!(r.why().contains("not a drill"), "{}", r.why());
    }

    /// The speed relation, checked against Onsrud's own printed form
    /// `RPM = (3.82 x SFM) / D_inches`. Two routes to one number: if the metric
    /// derivation here ever drifts, it drifts away from the published constant.
    #[test]
    fn the_surface_speed_relation_agrees_with_onsruds_printed_constant() {
        // 300 SFM on a 1/4" drill, by Onsrud's formula.
        let onsrud = 3.82 * 300.0 / 0.25;
        // The same cut in metric: 300 ft/min = 91.44 m/min, 1/4" = 6.35mm.
        let ours = rpm_for_surface_speed(300.0 * 0.3048, 6.35).unwrap();
        // Onsrud's 3.82 is 12/pi rounded, so the two agree to ~0.1%.
        assert!(
            ((ours - onsrud) / onsrud).abs() < 2e-3,
            "metric {ours} vs Onsrud's printed form {onsrud}"
        );
    }

    /// 🔴 The distinction the whole module is named for: a drill's feed does NOT
    /// scale with its flute count.
    #[test]
    fn a_per_revolution_feed_is_not_multiplied_by_the_flutes() {
        let rpm = 4_500.0;
        let per_rev = 0.35;
        assert!((feed_for_drill(per_rev, rpm) - 1_575.0).abs() < 1e-9);
        // ...and the same figure fed through the ROUTER formula, which is what
        // the crate does today, comes out at twice that on a 2-flute drill.
        let t = crate::types::Tool { flutes: 2, chipload_mm: per_rev, ..Default::default() };
        assert!(
            (crate::feeds::feed_from_chipload(&t, rpm) - 3_150.0).abs() < 1e-9,
            "if this stops being 2x, the two models have been quietly merged"
        );
    }

    #[test]
    fn feed_per_rev_is_read_back_off_the_emitted_pair() {
        // The measured emission: F5760 at S24000 on the ⌀6 brad point.
        assert!((feed_per_rev_from(24_000.0, 5_760.0) - 0.24).abs() < 1e-9);
        assert_eq!(feed_per_rev_from(0.0, 5_760.0), 0.0);
    }

    /// The note must carry the emitted numbers AND the quantity a chart could be
    /// compared against — a warning that only says "this may be wrong" cannot be
    /// acted on at a machine.
    #[test]
    fn the_unvouched_note_names_the_emitted_numbers_and_the_delivered_per_rev() {
        let n = unvouched_speed_note(&drill("Drill - Brad Point 6mm 2F"), 24_000.0, 5_760.0);
        assert!(n.contains("24000rpm"), "{n}");
        assert!(n.contains("5760mm/min"), "{n}");
        assert!(n.contains("0.240mm"), "{n}");
        assert!(n.contains("router"), "{n}");
    }

    #[test]
    fn a_drill_with_no_diameter_gets_no_speed_rather_than_a_division() {
        assert_eq!(rpm_for_surface_speed(90.0, 0.0), None);
        assert_eq!(rpm_for_surface_speed(90.0, -1.0), None);
    }
}
