//! Tool library — categorised cutters and drill bits.
//!
//! # Why category is not a label
//!
//! The category **constrains what the CAM may do with the tool**. A drill has no
//! side-cutting edge, so a drill asked to cut a profile rubs its margin against
//! the wall until it snaps. A V-bit's width is a function of depth, so treating
//! it as a cylinder of its nominal diameter cuts a slot of the wrong size at
//! every depth except one. Those are physical facts, so the category is checked,
//! not displayed.

use crate::types::{Flute, Tool};

/// 🔴 **`ToolCategory` MOVED to [`crate::types`] on 2026-08-11 and is
/// re-exported here so every existing `crate::tools::ToolCategory` path still
/// resolves.** It moved because it is now a field of [`Tool`] itself rather than
/// of the library entry that wraps one — see the enum's own doc block for the
/// measured door asymmetry that forced it. Nothing about the categories changed;
/// only where the type is defined.
pub use crate::types::ToolCategory;

/// A tool in the library: the cutting geometry plus the metadata the CAM needs
/// to refuse a bad pairing.
#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub id: String,
    pub tool: Tool,
    /// Full included angle, degrees. Required for angular tools, meaningless
    /// otherwise — `None` on an angular tool is an invalid tool, not a default.
    pub included_angle_deg: Option<f64>,
    /// Drill point angle, degrees (118 twist, 135 split point, 180 brad point).
    pub point_angle_deg: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ToolFault {
    MissingAngle,
    AngleOnNonAngularTool,
    NonPositiveDiameter,
    ZeroFlutes,
    ChiploadWindowInverted,
    ChiploadOutsideWindow,
    RpmRangeInverted,
    CuttingLengthShorterThanDiameter,
    /// A dimension on this tool is not a finite number.
    ///
    /// 🔴 CHECKED FIRST, AND IT HAD TO BE ADDED (2026-08-29). Every other fault
    /// in this list is a COMPARISON, and **every comparison against NaN is
    /// false** — so a tool whose numbers were all NaN passed `faults()` with an
    /// empty list and was added to the library. The validator whose entire job
    /// is to refuse nonsense could not see the one value that is nonsense by
    /// construction: not `<= 0`, not inverted, not too short. Just absent.
    ///
    /// ⚠ NOT REACHABLE THROUGH ANY DOOR TODAY, and that is measured rather than
    /// assumed: `serde_json` refuses `NaN`/`Infinity` outright and rejects
    /// `1e999` with *"number out of range"*, and the browser's `JSON.stringify`
    /// turns both into `null`, which does not deserialise into an `f64`. It is
    /// fixed anyway, because a validator that is blind to NaN is a trap armed
    /// for whoever adds the next input path — and the cost of the fix is four
    /// lines.
    NonFiniteDimension,
}

impl ToolSpec {
    /// What kind of cutter this is.
    ///
    /// 🔴 **It reads through to `self.tool.category`; there is no second copy.**
    /// This used to be a `ToolSpec` FIELD beside `tool`, which made the category
    /// a fact stated twice the moment `Tool` gained one — and two copies of a
    /// machining rule is one rule that runs once. The accessor is what makes the
    /// duplicate inexpressible rather than merely discouraged.
    pub fn category(&self) -> ToolCategory {
        self.tool.category
    }

    /// Every way a tool can be nonsense. Returned as a list, not a bool: an
    /// operator fixing a tool wants all of them at once, and a `bool` here would
    /// make the second fault invisible until the first was fixed.
    pub fn faults(&self) -> Vec<ToolFault> {
        let mut f = Vec::new();
        let t = &self.tool;
        // FIRST, and it short-circuits: every check below is a comparison, and a
        // comparison against NaN is false — so a NaN would walk past all of them
        // and be reported as a tool with nothing wrong with it. See
        // `ToolFault::NonFiniteDimension`.
        if ![
            t.diameter_mm,
            t.cutting_length_mm,
            t.shank_mm,
            t.chipload_mm,
            t.chipload_min_mm,
            t.chipload_max_mm,
            t.rpm_min,
            t.rpm_max,
        ]
        .iter()
        .chain(self.included_angle_deg.iter())
        .chain(self.point_angle_deg.iter())
        .all(|v| v.is_finite())
        {
            return vec![ToolFault::NonFiniteDimension];
        }
        if t.diameter_mm <= 0.0 {
            f.push(ToolFault::NonPositiveDiameter);
        }
        if t.flutes == 0 {
            f.push(ToolFault::ZeroFlutes);
        }
        if t.chipload_min_mm > t.chipload_max_mm {
            f.push(ToolFault::ChiploadWindowInverted);
        } else if t.chipload_mm < t.chipload_min_mm || t.chipload_mm > t.chipload_max_mm {
            f.push(ToolFault::ChiploadOutsideWindow);
        }
        if t.rpm_min > t.rpm_max {
            f.push(ToolFault::RpmRangeInverted);
        }
        // A flute shorter than the diameter cannot reach through a workpiece
        // its own width. That is a fault on a cutter meant to go THROUGH
        // material, and normal on one that is not:
        //   * Drill / countersink — geometry is on the point.
        //   * Surfacing — a 25mm flycutter with an 8mm flute is the standard
        //     shape of the tool; it skims a face and never cuts a full profile.
        // Applying the rule to surfacing marked every flycutter in the library invalid,
        // which is the validator being wrong about the tool, not the tool.
        if t.cutting_length_mm < t.diameter_mm
            && matches!(
                self.category(),
                ToolCategory::EndMill | ToolCategory::BallNose | ToolCategory::ThreadMill
            )
        {
            f.push(ToolFault::CuttingLengthShorterThanDiameter);
        }
        if self.category().is_angular() && self.included_angle_deg.is_none() {
            f.push(ToolFault::MissingAngle);
        }
        if !self.category().is_angular() && self.included_angle_deg.is_some() {
            f.push(ToolFault::AngleOnNonAngularTool);
        }
        f
    }

    pub fn is_valid(&self) -> bool {
        self.faults().is_empty()
    }

    /// Width of cut at a given depth. Constant for a cylindrical tool; a
    /// function of depth for a V-bit or chamfer.
    ///
    /// 🔴 Treating a 90 degree V-bit as a cylinder of its nominal diameter is
    /// wrong at every depth but one — this is why `is_angular` exists.
    pub fn width_at_depth(&self, depth_mm: f64) -> f64 {
        match (self.category().is_angular(), self.included_angle_deg) {
            (true, Some(a)) => {
                let half = (a * 0.5).to_radians();
                (2.0 * depth_mm.abs() * half.tan()).min(self.tool.diameter_mm)
            }
            _ => self.tool.diameter_mm,
        }
    }

    /// Depth at which an angular tool reaches a given width — the inverse, used
    /// to cut a V-groove of a specified width.
    pub fn depth_for_width(&self, width_mm: f64) -> Option<f64> {
        match (self.category().is_angular(), self.included_angle_deg) {
            (true, Some(a)) => {
                let half = (a * 0.5).to_radians();
                if half.tan().abs() < 1e-9 {
                    None
                } else {
                    Some(width_mm * 0.5 / half.tan())
                }
            }
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ColletVerdict {
    /// Shank matches the collet within tolerance.
    Fits,
    /// The shank is larger than the collet bore — it physically will not enter.
    TooLarge { shank_mm: f64, collet_mm: f64 },
    /// The shank is smaller — it will slip under load and be thrown.
    TooSmall { shank_mm: f64, collet_mm: f64 },
    /// The machine did not declare a collet. **This is not "fits".**
    Undeclared,
}

/// Check a tool against a machine's collet.
///
/// 🔴 `Undeclared` is its own verdict on purpose. An undeclared collet cannot be
/// checked, and reporting that as a pass is the exact shape of a green that
/// means "unchecked".
pub fn check_collet(shank_mm: f64, collet_mm: f64) -> ColletVerdict {
    if collet_mm <= 0.0 {
        return ColletVerdict::Undeclared;
    }
    // Real collets grip over a narrow range; ER collets nominally 1mm, but a
    // straight router collet is effectively exact. 0.1mm is the practical
    // tolerance for "the same size".
    const TOL: f64 = 0.1;
    if shank_mm > collet_mm + TOL {
        ColletVerdict::TooLarge { shank_mm, collet_mm }
    } else if shank_mm < collet_mm - TOL {
        ColletVerdict::TooSmall { shank_mm, collet_mm }
    } else {
        ColletVerdict::Fits
    }
}

fn mk(
    id: &str,
    category: ToolCategory,
    diameter_mm: f64,
    flutes: u32,
    shank_mm: f64,
    cutting_length_mm: f64,
    chipload: (f64, f64, f64),
    flute_type: Flute,
) -> ToolSpec {
    ToolSpec {
        id: id.into(),
        tool: Tool {
            name: id.into(),
            category,
            diameter_mm,
            flutes,
            cutting_length_mm,
            shank_mm,
            chipload_mm: chipload.1,
            chipload_min_mm: chipload.0,
            chipload_max_mm: chipload.2,
            rpm_min: 8_000.0,
            rpm_max: 24_000.0,
            flute_type,
        },
        included_angle_deg: None,
        point_angle_deg: None,
    }
}

/// The built-in library. Chiploads are the published windows for hardwood/ply in
/// the diameter class; they are the INPUT to `feed = rpm x flutes x chipload`
/// and are never a feed themselves.
pub fn default_library() -> Vec<ToolSpec> {
    let mut v = vec![
        // --- End mills -------------------------------------------------------
        mk("End Mill - Down-cut 3.175mm 2F", ToolCategory::EndMill, 3.175, 2, 3.175, 12.0, (0.02, 0.05, 0.10), Flute::DownCut),
        mk("End Mill - Down-cut 4mm 2F", ToolCategory::EndMill, 4.0, 2, 4.0, 17.0, (0.03, 0.07, 0.13), Flute::DownCut),
        mk("End Mill - Down-cut 6mm 2F", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::DownCut),
        mk("End Mill - Up-cut 6mm 2F", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::UpCut),
        mk("End Mill - Compression 6mm 2F", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::Compression),
        mk("End Mill - Up-cut 8mm 2F", ToolCategory::EndMill, 8.0, 2, 8.0, 32.0, (0.10, 0.21, 0.35), Flute::UpCut),
        mk("End Mill - Up-cut 12mm 2F", ToolCategory::EndMill, 12.0, 2, 12.0, 42.0, (0.15, 0.30, 0.50), Flute::UpCut),
        // --- Ball nose -------------------------------------------------------
        mk("Ball Nose 3mm 2F", ToolCategory::BallNose, 3.0, 2, 3.175, 12.0, (0.02, 0.05, 0.09), Flute::Straight),
        mk("Ball Nose 6mm 2F", ToolCategory::BallNose, 6.0, 2, 6.0, 25.0, (0.05, 0.09, 0.18), Flute::Straight),
        // --- Surfacing -------------------------------------------------------
        mk("Surfacing 25mm 2F", ToolCategory::Surfacing, 25.0, 2, 8.0, 8.0, (0.10, 0.20, 0.40), Flute::Straight),
    ];

    // --- Drills: brad point, twist, dowel -----------------------------------
    // Brad point is the woodworking default — the centre spur stops the bit
    // wandering on the grain, which a twist drill will do every time.
    for d in [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 8.0, 9.0, 10.0, 12.0, 14.0, 16.0] {
        let mut t = mk(
            &format!("Drill - Brad Point {d}mm 2F"),
            ToolCategory::Drill,
            d,
            2,
            if d <= 6.5 { 6.0 } else { 10.0 },
            (d * 6.0).min(90.0),
            (0.02, (d * 0.02).clamp(0.05, 0.25), 0.40),
            Flute::Straight,
        );
        t.point_angle_deg = Some(180.0);
        v.push(t);
    }
    for d in [1.0, 2.0, 3.0, 5.0, 6.0, 8.0, 10.0, 12.0] {
        let mut t = mk(
            &format!("Drill - Twist Carbide {d}mm 2F"),
            ToolCategory::Drill,
            d,
            2,
            if d <= 6.0 { 6.0 } else { 10.0 },
            (d * 8.0).min(100.0),
            (0.01, (d * 0.015).clamp(0.03, 0.20), 0.30),
            Flute::Straight,
        );
        t.point_angle_deg = Some(118.0);
        v.push(t);
    }
    for d in [5.0, 6.0, 8.0, 10.0, 12.0, 14.0] {
        let mut t = mk(
            &format!("Drill - Dowel {d}mm 2F"),
            ToolCategory::Drill,
            d,
            2,
            10.0,
            70.0,
            (0.02, 0.10, 0.30),
            Flute::Straight,
        );
        t.point_angle_deg = Some(180.0);
        v.push(t);
    }

    // --- Countersinks: angle is REQUIRED, not decoration ---------------------
    for (d, ang) in [(6.3, 90.0), (8.3, 90.0), (10.4, 90.0), (12.4, 90.0), (16.5, 90.0), (20.5, 90.0)] {
        let mut t = mk(
            &format!("Countersink {d}mm 3F"),
            ToolCategory::Countersink,
            d,
            3,
            8.0,
            d * 0.5,
            (0.02, 0.06, 0.15),
            Flute::Straight,
        );
        t.included_angle_deg = Some(ang);
        v.push(t);
    }

    // --- V-bits and chamfer --------------------------------------------------
    for (d, ang) in [(6.0, 60.0), (6.0, 90.0), (12.0, 90.0), (12.0, 120.0)] {
        let mut t = mk(
            &format!("V-Bit {d}mm {ang}deg"),
            ToolCategory::VBit,
            d,
            1,
            6.0,
            d,
            (0.02, 0.05, 0.12),
            Flute::Straight,
        );
        t.included_angle_deg = Some(ang);
        v.push(t);
    }
    let mut ch = mk("Chamfer 12mm 45deg", ToolCategory::Chamfer, 12.0, 2, 6.0, 10.0, (0.03, 0.08, 0.15), Flute::Straight);
    ch.included_angle_deg = Some(90.0);
    v.push(ch);

    // --- Engraving -----------------------------------------------------------
    let mut en = mk("Engraving 0.5mm tip 30deg", ToolCategory::Engraving, 3.175, 1, 3.175, 6.0, (0.01, 0.03, 0.06), Flute::Straight);
    en.included_angle_deg = Some(30.0);
    v.push(en);

    v
}

/// Tools in a category, smallest first.
pub fn by_category(lib: &[ToolSpec], cat: ToolCategory) -> Vec<&ToolSpec> {
    let mut v: Vec<&ToolSpec> = lib.iter().filter(|t| t.category() == cat).collect();
    // `total_cmp`, not `partial_cmp(..).unwrap()`, which PANICS on a NaN
    // diameter. `faults()` now refuses such a tool at the door so one should
    // never arrive — but a sort is not the place to discover that the door
    // failed, and a panic in the browser host poisons the wasm instance.
    v.sort_by(|a, b| a.tool.diameter_mm.total_cmp(&b.tool.diameter_mm));
    v
}

/// The drill whose diameter matches `hole_d` within tolerance, if any.
///
/// 🔴 This is gate P5. A hole is the diameter of the tool that made it — a 5mm
/// hole "drilled" with a 6mm bit is a 6mm hole, and the fastener does not care
/// what the drawing said. Anything without an exact-enough drill must be
/// interpolated with an end mill instead, never drilled with the nearest size.
pub fn drill_for_hole(lib: &[ToolSpec], hole_d: f64, tol_mm: f64) -> Option<&ToolSpec> {
    lib.iter()
        .filter(|t| t.category() == ToolCategory::Drill)
        .filter(|t| (t.tool.diameter_mm - hole_d).abs() <= tol_mm)
        .min_by(|a, b| {
            (a.tool.diameter_mm - hole_d)
                .abs()
                .partial_cmp(&(b.tool.diameter_mm - hole_d).abs())
                .unwrap()
        })
}

#[cfg(test)]
mod tests {

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // 🔴 ABOVE `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line
    // directly above a cited function to decide whether it is a test at all.
    #[allow(non_snake_case)]
    #[test]
    fn a_tool_whose_numbers_are_not_NUMBERS_is_refused_by_the_validator() {
        // 🔴 Before 2026-08-29 this returned an EMPTY fault list. Every check in
        // `faults()` is a comparison and every comparison against NaN is false,
        // so a tool that is nonsense by construction — not `<= 0`, not inverted,
        // not too short, just absent — was reported as a tool with nothing wrong
        // with it, and went into the library.
        let mut spec = mk("probe 6mm", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::UpCut);
        spec.tool.diameter_mm = f64::NAN;
        assert_eq!(
            spec.faults(),
            vec![ToolFault::NonFiniteDimension],
            "a NaN diameter must be the ONLY fault reported, and it must be reported"
        );

        // Every dimension, one at a time — a guard that covers the first field
        // and not the rest is the same blind spot one column over.
        for (what, apply) in [
            ("cutting_length_mm", (|t: &mut ToolSpec| t.tool.cutting_length_mm = f64::NAN) as fn(&mut ToolSpec)),
            ("shank_mm", |t: &mut ToolSpec| t.tool.shank_mm = f64::INFINITY),
            ("chipload_mm", |t: &mut ToolSpec| t.tool.chipload_mm = f64::NAN),
            ("chipload_min_mm", |t: &mut ToolSpec| t.tool.chipload_min_mm = f64::NAN),
            ("chipload_max_mm", |t: &mut ToolSpec| t.tool.chipload_max_mm = f64::NAN),
            ("rpm_min", |t: &mut ToolSpec| t.tool.rpm_min = f64::NAN),
            ("rpm_max", |t: &mut ToolSpec| t.tool.rpm_max = f64::NEG_INFINITY),
        ] {
            let mut s = mk("probe 6mm", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::UpCut);
            apply(&mut s);
            assert!(
                s.faults().contains(&ToolFault::NonFiniteDimension),
                "a non-finite {what} was not reported: {:?}",
                s.faults()
            );
        }

        // Specificity: an ordinary tool must still report nothing. A validator
        // that faults everything is a validator nobody can use.
        assert!(
            mk("probe 6mm", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::UpCut).faults().is_empty(),
            "a valid tool was faulted"
        );
    }

    #[test]
    fn sorting_by_diameter_cannot_panic_on_a_tool_that_should_never_exist() {
        // `by_category` sorted with `partial_cmp(..).unwrap()`, which panics on
        // NaN. `faults()` now refuses such a tool at the door — but a sort is
        // not the place to discover the door failed, and a panic in the browser
        // host poisons the wasm instance.
        let mut bad = mk("probe 6mm", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::UpCut);
        bad.tool.diameter_mm = f64::NAN;
        let good = mk("probe 6mm", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.10, 0.20), Flute::UpCut);
        let lib = vec![good, bad];
        let sorted = by_category(&lib, ToolCategory::EndMill);
        assert_eq!(sorted.len(), 2, "sorting must not lose or duplicate a tool");
    }
    use super::*;

    #[test]
    fn every_stock_tool_is_valid() {
        for t in default_library() {
            assert!(t.is_valid(), "{} is invalid: {:?}", t.id, t.faults());
        }
    }

    /// 🔴 **THE FIELD IS ON `Tool`, AND IT SURVIVES THE COPY.** `job.rs` and
    /// `fixtures.rs` both assign an operation's cutter with
    /// `op.tool = spec.tool.clone()`, dropping the `ToolSpec` — so anything the
    /// category is needed for downstream can only work if it rides on the
    /// `Tool`. This asserts the clone, not the field's existence: a field that
    /// compiles and is lost at the door it is needed on is the exact defect
    /// being fixed.
    #[test]
    fn category_is_carried_on_the_tool_itself_and_survives_the_clone() {
        let lib = default_library();
        let brad = lib.iter().find(|t| t.id == "Drill - Brad Point 6mm 2F").unwrap();
        assert_eq!(brad.category(), ToolCategory::Drill);
        // The copy every door actually makes.
        let bare: Tool = brad.tool.clone();
        assert_eq!(
            bare.category,
            ToolCategory::Drill,
            "a ⌀6 brad point arrived at the planner describing itself as a {}",
            bare.category.as_str()
        );
        // ...and the negative control, or "it is a drill" is true of everything.
        let em = lib.iter().find(|t| t.id == "End Mill - Down-cut 6mm 2F").unwrap();
        assert_eq!(em.tool.clone().category, ToolCategory::EndMill);
        assert_ne!(bare.category, em.tool.category);
    }

    /// Every tool in the library carries its OWN category rather than inheriting
    /// `Tool::default()`'s `EndMill`. If a new `mk` call ever forgets, this goes
    /// red — a defaulted category on a drill is a drill claiming to be an end
    /// mill, silently.
    #[test]
    fn no_library_tool_leans_on_the_default_category() {
        let lib = default_library();
        let drills = by_category(&lib, ToolCategory::Drill);
        assert!(!drills.is_empty());
        for t in &drills {
            assert_eq!(t.tool.category, ToolCategory::Drill, "{}", t.id);
        }
        // The whole library, by the id it names itself with — the categories are
        // derived from the id text here ON PURPOSE, so this test does not simply
        // re-read the field it is checking.
        for t in &lib {
            if t.id.starts_with("Drill - ") {
                assert_eq!(t.tool.category, ToolCategory::Drill, "{}", t.id);
            } else if t.id.starts_with("End Mill - ") {
                assert_eq!(t.tool.category, ToolCategory::EndMill, "{}", t.id);
            } else if t.id.starts_with("V-Bit ") {
                assert_eq!(t.tool.category, ToolCategory::VBit, "{}", t.id);
            } else if t.id.starts_with("Countersink ") {
                assert_eq!(t.tool.category, ToolCategory::Countersink, "{}", t.id);
            }
        }
    }

    #[test]
    fn every_tool_resolves_to_exactly_one_category() {
        // C1. Counting by category must account for the whole library.
        let lib = default_library();
        let counted: usize =
            ToolCategory::all().iter().map(|c| by_category(&lib, *c).len()).sum();
        assert_eq!(counted, lib.len(), "a tool is in zero or two categories");
    }

    #[test]
    fn the_library_covers_the_drill_categories_we_actually_stock() {
        let lib = default_library();
        let drills = by_category(&lib, ToolCategory::Drill);
        assert!(drills.len() >= 25, "only {} drills", drills.len());
        assert!(drills.iter().any(|t| t.id.contains("Brad Point")));
        assert!(drills.iter().any(|t| t.id.contains("Twist")));
        assert!(drills.iter().any(|t| t.id.contains("Dowel")));
        // Every drill declares a point angle — it is what distinguishes them.
        assert!(drills.iter().all(|t| t.point_angle_deg.is_some()));
    }

    #[test]
    fn a_drill_may_not_cut_a_profile() {
        // 🔴 The physical fact: a drill has no side-cutting edge.
        assert!(!ToolCategory::Drill.can_profile());
        assert!(!ToolCategory::Countersink.can_profile());
        assert!(ToolCategory::EndMill.can_profile());
    }

    #[test]
    fn an_angular_tool_without_an_angle_is_invalid() {
        let mut v = mk("bad v-bit", ToolCategory::VBit, 6.0, 1, 6.0, 6.0, (0.02, 0.05, 0.1), Flute::Straight);
        assert!(v.faults().contains(&ToolFault::MissingAngle));
        v.included_angle_deg = Some(90.0);
        assert!(v.is_valid(), "{:?}", v.faults());
    }

    #[test]
    fn an_angle_on_an_end_mill_is_invalid() {
        // Negative control the other way: the validator must reject nonsense in
        // both directions, or it is only half a check.
        let mut e = mk("weird", ToolCategory::EndMill, 6.0, 2, 6.0, 25.0, (0.05, 0.1, 0.2), Flute::UpCut);
        e.included_angle_deg = Some(90.0);
        assert!(e.faults().contains(&ToolFault::AngleOnNonAngularTool));
    }

    #[test]
    fn a_vbit_width_depends_on_depth() {
        let lib = default_library();
        let v = lib.iter().find(|t| t.id == "V-Bit 6mm 90deg").unwrap();
        // 90 degrees: half angle 45, so width = 2 * depth.
        assert!((v.width_at_depth(1.0) - 2.0).abs() < 1e-9);
        assert!((v.width_at_depth(2.0) - 4.0).abs() < 1e-9);
        // ...and is capped at the tool's own diameter.
        assert!((v.width_at_depth(100.0) - 6.0).abs() < 1e-9);
        // An end mill's width is constant — the case a naive model gets right
        // by accident and then applies to everything.
        let e = lib.iter().find(|t| t.id == "End Mill - Down-cut 6mm 2F").unwrap();
        assert!((e.width_at_depth(1.0) - 6.0).abs() < 1e-9);
        assert!((e.width_at_depth(9.0) - 6.0).abs() < 1e-9);
    }

    #[test]
    fn depth_for_width_inverts_width_at_depth() {
        let lib = default_library();
        let v = lib.iter().find(|t| t.id == "V-Bit 12mm 120deg").unwrap();
        let d = v.depth_for_width(5.0).unwrap();
        assert!((v.width_at_depth(d) - 5.0).abs() < 1e-9);
        // A cylindrical tool has no such depth, and must say so rather than
        // returning a number that would be acted on.
        let e = lib.iter().find(|t| t.id == "End Mill - Down-cut 6mm 2F").unwrap();
        assert!(e.depth_for_width(5.0).is_none());
    }

    #[test]
    fn collet_check_refuses_both_directions_and_admits_ignorance() {
        // 🔴 P6, all four verdicts. The fork discovered the oversize case at the
        // machine.
        assert_eq!(check_collet(6.0, 6.0), ColletVerdict::Fits);
        assert!(matches!(check_collet(12.0, 6.0), ColletVerdict::TooLarge { .. }));
        assert!(matches!(check_collet(3.175, 6.0), ColletVerdict::TooSmall { .. }));
        assert_eq!(check_collet(6.0, 0.0), ColletVerdict::Undeclared);
    }

    #[test]
    fn undeclared_collet_is_not_a_pass() {
        // The distinction the whole verdict enum exists for.
        assert_ne!(check_collet(6.0, 0.0), ColletVerdict::Fits);
    }

    #[test]
    fn a_hole_gets_a_drill_of_its_own_diameter_or_none() {
        let lib = default_library();
        let d = drill_for_hole(&lib, 6.0, 0.1).unwrap();
        assert!((d.tool.diameter_mm - 6.0).abs() < 1e-9);
        // 🔴 5.2mm has no matching drill. Returning the 5mm or the 5.5mm here
        // is how a hole ends up the wrong size; the caller must interpolate.
        assert!(drill_for_hole(&lib, 5.2, 0.1).is_none());
    }
}

// ===========================================================================
//  Material — the other half of a feed.
// ===========================================================================

/// What is being cut.
///
/// 🔴 A chipload window belongs to a TOOL, not to a job. The same 6mm cutter
/// wants a different chip in 18mm ply than in acrylic (which melts and welds
/// behind the cutter if the chip is too small) or in aluminium (which needs a
/// smaller chip and far lower rpm). Feeding all of them at the tool's nominal
/// figure burns one, welds another, and is only right for the third.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Material {
    Plywood,
    Mdf,
    Hardwood,
    Softwood,
    Acrylic,
    Aluminium,
}

impl Material {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plywood => "Plywood",
            Self::Mdf => "MDF",
            Self::Hardwood => "Hardwood",
            Self::Softwood => "Softwood",
            Self::Acrylic => "Acrylic",
            Self::Aluminium => "Aluminium",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "Plywood" => Self::Plywood,
            "MDF" => Self::Mdf,
            "Hardwood" => Self::Hardwood,
            "Softwood" => Self::Softwood,
            "Acrylic" => Self::Acrylic,
            "Aluminium" => Self::Aluminium,
            _ => return None,
        })
    }

    pub fn all() -> &'static [Material] {
        &[
            Self::Plywood,
            Self::Mdf,
            Self::Hardwood,
            Self::Softwood,
            Self::Acrylic,
            Self::Aluminium,
        ]
    }

    /// Multiplier on the tool's nominal chipload. Plywood is the reference at
    /// 1.0; every other value is a published cross-material ratio against it.
    ///
    /// 🔴 **Acrylic is BELOW 1.0, and the comment that used to sit here said the
    /// opposite.** It read: *"Acrylic is ABOVE 1.0 on purpose … the fix for a
    /// melted edge is usually MORE feed, not less."* That is right physics
    /// attached to the wrong control, and it is why `1.15` survived four audits
    /// unexamined. LMT Onsrud's *Hard Plastic Cutting Data Recommendations*
    /// states the actual remedy for chip rewelding: **"increase feedrate or go
    /// to a single edge tool."** Both raise the **chip**; the second does it by
    /// HALVING THE FLUTE COUNT, and this multiplier cannot halve a flute count
    /// — it scales the per-tooth chipload of whatever cutter is fitted, which
    /// on our library is a 2-flute. We have no O-flute/single-edge concept, so
    /// the O-flute half of Onsrud's sentence was folded into a material
    /// multiplier where it also applies to a 2-flute that was never entitled to
    /// it. Onsrud's own per-tooth figures separate the two: 52-200B/BL and the
    /// other 2-flute series run .004–.006" in hard plastic, and only the
    /// **O-flute** series (62-700/63-700/64-000/65-000) run .008–.010".
    /// Same-series cross-material (52-200B/BL: .004–.006" hard plastic vs
    /// .006–.008" soft plywood) gives **acrylic/plywood = 0.71**; Techno 0.74,
    /// Amana 0.63 — a published band of 0.63–1.00. 0.75 is its middle.
    ///
    /// ⚠ If a melted acrylic edge ever shows up, the fix is a **single-flute
    /// O-flute cutter in the library**, not a bigger number here. Raising this
    /// constant re-creates the defect with a plausible story attached.
    ///
    /// Sources read 2026-08-09, recorded in `docs/decision-38-doc-ratio-recommendation.md` §A2.
    pub fn chipload_factor(self) -> f64 {
        match self {
            // The reference. Every other row is a ratio against this one.
            Self::Plywood => 1.0,
            // Published band 0.78–1.00 across six readings; NO chart puts MDF
            // above plywood. 1.00 is the top of the band — the smallest
            // defensible change from the old 1.10. (#38 §A2, HIGH)
            Self::Mdf => 1.0,
            // Inside its published band; unchanged by #38.
            Self::Hardwood => 0.8,
            // Onsrud's own softwood/plywood ratios run 1.06–1.17; Techno puts
            // them equal at 1.00. 1.10 sits inside. Was 1.20, above the band.
            // (#38 §A2, MEDIUM-HIGH — the true value may be lower still.)
            Self::Softwood => 1.1,
            // See the 🔴 above before touching this. Was 1.15, above every
            // published source. (#38 §A2, HIGH)
            Self::Acrylic => 0.75,
            // Conservative and inside the router band; unchanged by #38.
            Self::Aluminium => 0.35,
        }
    }

    /// Depth of cut per pass as a fraction of the tool DIAMETER.
    ///
    /// 🔴 **This constant is a LIMIT on one path and a DEFAULT on the other.**
    /// `job.rs` clamps whatever the caller asked for down to it;
    /// `recommend.rs` **chooses** it (`doc = diameter * max_doc_ratio()`). So
    /// this is not only a guard — it is the number the tool actively tells the
    /// operator to cut at, which is why it is sourced per material rather than
    /// inherited from a chart header.
    ///
    /// **Every through-profile this tool emits is a SLOT** — 100% radial
    /// engagement, 180° of tool wrap, no sideways exit for chips, no unloaded
    /// portion of a revolution. That is the case these numbers are set for.
    ///
    /// **What binds on a C-Beam/ACME gantry is not the spindle and not the
    /// cutter** (2.2 kW against ~170 W of cut; ~50 N against a ~180 N cutter
    /// limit — `cad`, `cnc_e2e_requirements.md` §3.2). It is **tool-tip
    /// deflection against FR3's 0.1 mm joint budget**, then chip evacuation,
    /// then how deep the cutter is buried when a part lets go. Do not argue a
    /// change to this constant on "the spindle will stall" — that is a false
    /// red and a false red lies exactly like a false green.
    ///
    /// 🔴 **The arms below are DELIBERATELY NOT COLLAPSED.** Four woods land on
    /// 0.50 by *coincidence of evidence*, not by design — each has its own
    /// source and its own confidence, and MDF is the one most likely to move
    /// first. A shared arm would make moving one of them a refactor of all
    /// three, which is how they came to share the old 1.0 in the first place.
    /// Aluminium is genuinely different in *mechanism* (chip rewelding, not
    /// deflection), so do not "simplify" this to a constant either.
    ///
    /// Raising any of these back to 0.75 is **coupon-gated** — see
    /// `docs/decision-38-doc-ratio-recommendation.md` §B1. It is not a
    /// judgement call and it is not this file's to make: no output of this
    /// program has ever cut anything.
    pub fn max_doc_ratio(self, machine_class: crate::types::MachineClass) -> f64 {
        let base = match self {
            // 0.50 — HIGH. Four independent readings in our machine class
            // cluster at 0.24–0.51: Carbide 3D's shipped #201 default (0.24),
            // Shapeoko community consensus on a 1.5 kW spindle (0.50),
            // MellowPine's review of the OpenBuilds LEAD 1515 — a C-Beam/ACME
            // gantry, i.e. OUR architecture (0.51), and Onefinity's
            // conservative figure on a heavier machine (0.50). Plus the only
            // published slotting-specific rule (ToolGrit, 0.50).
            // ⚠ Onsrud publishes NO plywood value for the 1/4" up- or down-cut
            // at all, so the old 1.0 was inherited from a chart HEADER on a
            // page with no row for the tool class we use. (#38 §A1)
            Self::Plywood => 0.50,
            // 0.50 — MEDIUM-HIGH, the weakest of the four and flagged as such.
            // Same cluster, but MDF is the lowest-force of the sheet goods here and
            // one secondary source (workshopcalc) allows up to 2xD for it.
            // This is the value most likely to be raised at the coupon; it is a
            // reduction from 1.00 either way. (#38 §A1)
            Self::Mdf => 0.50,
            // 0.50 — HIGH. Same machine-class cluster, and the one published
            // slotting rule is explicit that it applies "regardless of
            // material". (#38 §A1)
            Self::Softwood => 0.50,
            // 0.50 — HIGH, and this one came DOWN from 0.75 on purpose: 0.75
            // was ABOVE the only machine-vendor starter setting found for
            // hardwood (UT Austin / ShopBot: 0.50xD, on a far heavier machine
            // than ours). The earlier audit marked hardwood ✅ because it
            // compared only against tooling charts. (#38 §A1)
            Self::Hardwood => 0.50,
            // 0.50 — HIGH, UNCHANGED. Already at or below every source found;
            // the sources that differ (ShopBot 1.04xD) point the permissive
            // way, so nothing here argues for lowering it either.
            Self::Acrylic => 0.50,
            // 0.15 — HIGH, UNCHANGED. Inside the published router band, upper
            // half. Different mechanism from the woods: aluminium is limited by
            // chip rewelding and evacuation, not by deflection.
            Self::Aluminium => 0.15,
        };
        base * machine_class.doc_ratio_multiplier()
    }

    /// Ceiling on spindle speed **for a ROUTER CUTTER**. Aluminium at 24,000 rpm
    /// with a 6mm cutter cannot clear its chips and welds them to the flutes.
    ///
    /// 🔴 **THE TOOL CLASS IS PART OF THIS NUMBER AND IT USED TO BE MISSING.**
    /// The 24,000 for the woods is sourced — to Techno CNC's *"The general
    /// operating RPM for Techno CNC **Tooling** is between 12,000 – 24,000 RPM"*
    /// (verified verbatim 2026-08-10) — and on that page *tooling* means router
    /// bits. `recommend` then selected it for a **brad-point drill**, and the
    /// measured emission was `M3 S24000` with `G98 G83 … F5760.0`: a router
    /// ceiling and a chip-per-tooth feed on a tool whose manufacturer rates it
    /// in **feed per revolution against surface speed**.
    ///
    /// ⚠ **A correctly sourced number is still wrong when it is asked the wrong
    /// question**, which is why the fix was not a new value here. See
    /// [`crate::drill`]: nothing is declared for a drill, and the planner now
    /// says so beside the numbers instead of presenting them as this material's
    /// recommendation. `docs/materials-research.md` §3.3.
    ///
    /// The other two values are ours, not published: both sit below every
    /// figure found (Onsrud states its acrylic table at 18,000 and footnotes
    /// 16,000 for aluminium series 40-000/57-000), so the direction is safe and
    /// the exact numbers are not sourced. §1.6.
    pub fn max_rpm(self) -> f64 {
        match self {
            Self::Aluminium => 12_000.0,
            Self::Acrylic => 16_000.0,
            _ => 24_000.0,
        }
    }
}

/// Feed for a tool in a material.
pub fn feed_for(t: &Tool, rpm: f64, m: Material) -> f64 {
    rpm * t.flutes as f64 * t.chipload_mm * m.chipload_factor()
}

#[cfg(test)]
mod material_tests {
    use super::*;

    fn t6() -> Tool {
        Tool { diameter_mm: 6.0, flutes: 2, chipload_mm: 0.1, ..Tool::default() }
    }

    #[test]
    fn material_changes_the_feed() {
        // The whole point: the same tool at the same rpm must not feed the same
        // into ply and into aluminium.
        let ply = feed_for(&t6(), 18_000.0, Material::Plywood);
        let alu = feed_for(&t6(), 18_000.0, Material::Aluminium);
        assert!((ply - 3600.0).abs() < 1e-9, "ply feed {ply}");
        assert!(alu < ply * 0.5, "aluminium fed at {alu} against ply {ply}");
    }

    #[test]
    fn acrylic_feeds_slower_than_plywood_because_a_2_flute_is_not_an_o_flute() {
        // 🔴 INVERTED, not deleted (#38 §A2). This test used to assert the
        // opposite — `acrylic_feeds_faster_than_plywood_not_slower` — and it
        // was the mechanised half of the wrong comment above
        // `chipload_factor`. Onsrud's remedy for chip rewelding is "increase
        // feedrate OR GO TO A SINGLE EDGE TOOL"; the second half is a flute
        // count, and this multiplier cannot change a flute count. Every
        // published same-series ratio puts acrylic BELOW plywood per tooth
        // (0.63–1.00). A test asserting the old direction would have to be
        // deleted to make room for the fix, which is exactly why it is
        // inverted here instead — the direction is the finding.
        let acrylic = feed_for(&t6(), 18_000.0, Material::Acrylic);
        let ply = feed_for(&t6(), 18_000.0, Material::Plywood);
        assert!(acrylic < ply, "acrylic {acrylic} must feed under plywood {ply} per tooth");
    }

    #[test]
    fn every_material_bounds_depth_and_rpm() {
        for m in Material::all() {
            assert!(m.max_doc_ratio(crate::types::MachineClass::default()) > 0.0 && m.max_doc_ratio(crate::types::MachineClass::default()) <= 1.0, "{}", m.as_str());
            assert!(m.max_rpm() >= 8_000.0, "{}", m.as_str());
        }
        assert!(Material::Aluminium.max_rpm() < Material::Plywood.max_rpm());
        assert!(Material::Aluminium.max_doc_ratio(crate::types::MachineClass::default()) < Material::Plywood.max_doc_ratio(crate::types::MachineClass::default()));
    }

    /// 🔴 The two assertions above are ORDERINGS. Neither would have caught the
    /// defect #38 found — `Plywood = 1.0` passes `0.0 < r <= 1.0` and passes
    /// `Aluminium < Plywood` — and neither will catch the next one. These pin
    /// the VALUES, at the ceiling the research actually defends.
    ///
    /// Written as `<=` on purpose: this is a **safety ceiling**, not an
    /// equality. A later reduction stays green; any increase goes red and has
    /// to justify itself against a coupon (#38 §B1), which nobody has cut.
    #[test]
    fn no_material_permits_a_deeper_cut_than_the_research_defends() {
        for (m, ceiling) in [
            (Material::Plywood, 0.50),
            (Material::Mdf, 0.50),
            (Material::Softwood, 0.50),
            (Material::Hardwood, 0.50),
            (Material::Acrylic, 0.50),
            (Material::Aluminium, 0.15),
        ] {
            assert!(
                m.max_doc_ratio(crate::types::MachineClass::default()) <= ceiling + 1e-9,
                "{} asks for {}xD, above the {}xD ceiling #38 defends — raising this needs a \
                 physical coupon (§B1), not an edit",
                m.as_str(),
                m.max_doc_ratio(crate::types::MachineClass::default()),
                ceiling
            );
        }
        // And the exact values as landed, so a silent drift in EITHER direction
        // is visible in a diff of this test rather than only in a cut part.
        assert_eq!(Material::Plywood.max_doc_ratio(crate::types::MachineClass::default()), 0.50);
        assert_eq!(Material::Mdf.max_doc_ratio(crate::types::MachineClass::default()), 0.50);
        assert_eq!(Material::Softwood.max_doc_ratio(crate::types::MachineClass::default()), 0.50);
        assert_eq!(Material::Hardwood.max_doc_ratio(crate::types::MachineClass::default()), 0.50);
        assert_eq!(Material::Acrylic.max_doc_ratio(crate::types::MachineClass::default()), 0.50);
        assert_eq!(Material::Aluminium.max_doc_ratio(crate::types::MachineClass::default()), 0.15);
    }

    /// Same shape for the feed side: a ceiling, then the landed values.
    #[test]
    fn no_material_permits_a_bigger_chip_than_the_published_band() {
        for (m, ceiling) in [
            (Material::Plywood, 1.00),
            (Material::Mdf, 1.00),
            (Material::Softwood, 1.10),
            (Material::Hardwood, 0.80),
            (Material::Acrylic, 0.75),
            (Material::Aluminium, 0.35),
        ] {
            assert!(
                m.chipload_factor() <= ceiling + 1e-9,
                "{} asks for x{}, above the x{} top-of-band #38 defends",
                m.as_str(),
                m.chipload_factor(),
                ceiling
            );
        }
        assert_eq!(Material::Plywood.chipload_factor(), 1.0);
        assert_eq!(Material::Mdf.chipload_factor(), 1.0);
        assert_eq!(Material::Softwood.chipload_factor(), 1.1);
        assert_eq!(Material::Hardwood.chipload_factor(), 0.8);
        assert_eq!(Material::Acrylic.chipload_factor(), 0.75);
        assert_eq!(Material::Aluminium.chipload_factor(), 0.35);
    }

    /// 🔴 The invariant the whole of #38 §A rests on: **every change is a
    /// REDUCTION.** Pinned against the pre-#38 table so that "no cut is more
    /// aggressive than it was" is a mechanised fact rather than a claim in a
    /// commit message.
    ///
    /// ⚠ The pre-#38 numbers below are the DEFECT. They are here as the thing
    /// being compared against, never as a target — nothing may read them as
    /// permission.
    #[test]
    fn nothing_in_the_38_change_permits_a_more_aggressive_cut_than_before() {
        // (material, pre-#38 max_doc_ratio, pre-#38 chipload_factor)
        let before = [
            (Material::Plywood, 1.00, 1.00),
            (Material::Mdf, 1.00, 1.10),
            (Material::Softwood, 1.00, 1.20),
            (Material::Hardwood, 0.75, 0.80),
            (Material::Acrylic, 0.50, 1.15),
            (Material::Aluminium, 0.15, 0.35),
        ];
        for (m, was_doc, was_chip) in before {
            assert!(
                m.max_doc_ratio(crate::types::MachineClass::default()) <= was_doc + 1e-9,
                "{}: depth went UP, {was_doc} -> {}",
                m.as_str(),
                m.max_doc_ratio(crate::types::MachineClass::default())
            );
            assert!(
                m.chipload_factor() <= was_chip + 1e-9,
                "{}: chip went UP, {was_chip} -> {}",
                m.as_str(),
                m.chipload_factor()
            );
        }
    }

    /// 🔴 The wrong-class defect, pinned as a PROPERTY of the library rather
    /// than as a comment: **no drill in this crate carries a published feed
    /// model, so no drill may be presented as running at a recommended speed.**
    ///
    /// This test lives here, beside `max_rpm()`, because this is the number that
    /// was handed to drills — and a lesson written only in the module that
    /// consumes it does not reach the module that produces it.
    #[test]
    fn the_material_rpm_ceiling_is_a_router_cutter_figure_and_no_drill_is_rated() {
        // The sourced value, unchanged — this is not a numbers change.
        assert_eq!(Material::Plywood.max_rpm(), 24_000.0);
        // ...and not one drill has anything to defend being run at it.
        for spec in default_library().iter().filter(|t| t.category() == ToolCategory::Drill) {
            assert!(
                !crate::drill::rating_for(spec).is_declared(),
                "{} claims a drill feed model; if a real one was added, this assertion is where \
                 its source and read date get acknowledged",
                spec.id
            );
        }
        // Negative control: the function still answers, and still differs by
        // material. A test that only asserts absences passes on a crate that
        // does nothing.
        assert!(Material::Aluminium.max_rpm() < Material::Plywood.max_rpm());
    }

    #[test]
    fn names_round_trip() {
        for m in Material::all() {
            assert_eq!(Material::from_str(m.as_str()), Some(*m));
        }
        assert_eq!(Material::from_str("Unobtainium"), None);
    }
}

/// Whether a machine can hold a shank at all, counting the collets in the
/// drawer as well as the one in the spindle.
///
/// 🔴 Three outcomes, not two. "Fits the fitted collet" and "fits a collet the
/// shop owns" are BOTH selectable — a router tool change is routinely a collet
/// change, and folding them together would refuse ordinary safe work. What must
/// not be selectable is a shank no collet can hold. `Undeclared` stays its own
/// answer: an unchecked machine is not a machine that passed.
#[derive(Clone, Debug, PartialEq)]
pub enum ShankFit {
    /// Runs with the collet already in the spindle.
    Fitted,
    /// Runs after a collet change, naming the collet to fit.
    NeedsCollet { collet_mm: f64 },
    /// No collet in the shop holds it.
    None { why: String },
    /// The machine declared no collet, so nothing could be checked.
    Undeclared,
}

impl ShankFit {
    /// Whether this tool may be chosen. `Undeclared` is deliberately selectable:
    /// refusing every tool because the machine never declared a collet would
    /// punish the user for a machine setting, and the plan-time check still
    /// reports it. Selectable is not the same as verified.
    pub fn selectable(&self) -> bool {
        !matches!(self, ShankFit::None { .. })
    }

    pub fn why(&self) -> String {
        match self {
            ShankFit::Fitted => String::new(),
            ShankFit::NeedsCollet { collet_mm } => {
                format!("needs the {collet_mm}mm collet fitted")
            }
            ShankFit::None { why } => why.clone(),
            ShankFit::Undeclared => "the machine has not declared a collet, so this is UNCHECKED".into(),
        }
    }
}

/// Can this machine hold this shank, with any collet it owns?
pub fn shank_fit(shank_mm: f64, fitted_mm: f64, spares_mm: &[f64]) -> ShankFit {
    match check_collet(shank_mm, fitted_mm) {
        ColletVerdict::Fits => return ShankFit::Fitted,
        ColletVerdict::Undeclared => {
            // A spare can still settle it: an undeclared SPINDLE collet with a
            // matching collet in the drawer is a fittable tool.
            if let Some(c) = spares_mm.iter().find(|c| check_collet(shank_mm, **c) == ColletVerdict::Fits) {
                return ShankFit::NeedsCollet { collet_mm: *c };
            }
            return ShankFit::Undeclared;
        }
        _ => {}
    }
    if let Some(c) = spares_mm.iter().find(|c| check_collet(shank_mm, **c) == ColletVerdict::Fits) {
        return ShankFit::NeedsCollet { collet_mm: *c };
    }
    let owned: Vec<String> = std::iter::once(fitted_mm)
        .chain(spares_mm.iter().copied())
        .filter(|c| *c > 0.0)
        .map(|c| format!("{c}mm"))
        .collect();
    ShankFit::None {
        why: format!(
            "{shank_mm}mm shank; the shop's collets are {}",
            if owned.is_empty() { "none declared".to_string() } else { owned.join(", ") }
        ),
    }
}

#[cfg(test)]
mod shank_fit_tests {
    use super::*;

    #[test]
    fn a_spare_collet_makes_a_tool_selectable_and_says_which_one() {
        let f = shank_fit(3.175, 6.0, &[3.175, 6.35]);
        assert_eq!(f, ShankFit::NeedsCollet { collet_mm: 3.175 });
        assert!(f.selectable());
        assert!(f.why().contains("3.175mm collet"));
    }

    #[test]
    fn a_shank_no_collet_holds_is_the_only_unselectable_case() {
        let f = shank_fit(12.0, 6.0, &[3.175, 6.35, 8.0]);
        assert!(!f.selectable());
        // The reason must name the shop's collets, or the user cannot tell a
        // wrong tool from a machine that is set up wrong.
        assert!(f.why().contains("12mm shank"), "{}", f.why());
        assert!(f.why().contains("6mm"), "{}", f.why());
    }

    #[test]
    fn an_undeclared_collet_is_selectable_but_never_reads_as_checked() {
        let f = shank_fit(6.0, 0.0, &[]);
        assert_eq!(f, ShankFit::Undeclared);
        assert!(f.selectable());
        assert!(f.why().contains("UNCHECKED"));
    }
}
