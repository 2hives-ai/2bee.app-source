//! Rectangular profile toolpaths — the smallest generator that produces a
//! **real** cut program, used to exercise the post and the gates.
//!
//! 🔴 SCOPE, stated so nobody mistakes this for the CAM engine: this module
//! offsets an **axis-aligned rectangle**, where the offset is exact and needs
//! no geometry library. General polygon offsetting (arbitrary outlines,
//! pockets with islands, dogbones) is the Phase-1 engine and is NOT here.
//! Do not extend this file into one — it exists to give the gates something
//! honest to bite on before that engine lands.

use crate::feeds::feed_from_chipload;
// 🔴 ONE depth schedule, not two. This module carried its own byte-identical
// copy of `depth_passes` — same arithmetic, same 25%-sliver fold, same comment
// — beside the engine's. Two copies of a rule that decides how deep each pass
// cuts is one rename away from a fixture generator and an engine that disagree
// about the cut, with every gate comparing the generator against itself.
use crate::toolpath::depth_passes;
use crate::types::*;

/// Why a helical entry is refused, in the words the ENGINE uses.
///
/// 🔴 The same sentence as `toolpath.rs::plan_profile`'s refusal, on purpose:
/// an operator who meets this refusal from the fixture path and from a real job
/// must not be able to conclude they are two different rules. A test below
/// asserts the two are byte-identical, so the copy cannot rot quietly — it is a
/// copy because the engine's string is inline in a `Refusal` and not a `pub`
/// item to import, and two silently-diverging sentences is exactly the defect
/// this constant exists to have caught.
pub const HELIX_REFUSAL: &str = "helical entry is NOT IMPLEMENTED — it is refused rather than \
                                 silently cut as a linear ramp, because a ramp travels along the \
                                 wall and a helix does not. Use Ramp (the default) or Plunge";

/// Which deliberate defect to plant. Used ONLY by the gate harness: a gate
/// nobody has watched fail is not a gate, so the failure has to be producible
/// on demand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plant {
    None,
    /// Push the path outside the X travel.
    OffBed,
    /// Cut deeper than the workpiece — into the spoilboard.
    ThroughSpoilboard,
    /// A part name containing parentheses, which ends a grblHAL comment early.
    ParenInName,
    /// Emit cutting moves with the spindle never started.
    SpindleNeverOn,
    /// Ask for an rpm the spindle cannot deliver.
    RpmOutOfRange,
    /// Emit an arc as the very first motion, before any positioning move.
    ArcBeforePosition,
}

#[derive(Clone, Debug)]
pub struct RectJob {
    pub name: String,
    pub x0: f64,
    pub y0: f64,
    pub width_mm: f64,
    pub height_mm: f64,
    /// Corner radius. `0.0` = square corners (all linear moves); `> 0.0`
    /// produces real G2/G3 arcs, which is the point of having it.
    pub corner_r_mm: f64,
    pub tool: Tool,
    pub op: OperationParams,
    pub stock: Stock,
    pub plant: Plant,
}

impl Default for RectJob {
    fn default() -> Self {
        Self {
            name: "rect".into(),
            x0: 50.0,
            y0: 50.0,
            width_mm: 120.0,
            height_mm: 80.0,
            corner_r_mm: 0.0,
            tool: Tool::default(),
            op: OperationParams::default(),
            stock: Stock::default(),
            plant: Plant::None,
        }
    }
}


/// Build the profile. Returns the toolpath plus the (possibly planted) job
/// name that the post will put in a comment — or a REFUSAL, in the engine's
/// own words.
///
/// 🔴 A `Result` rather than a bare tuple because this generator can now say
/// NO. It used to be unable to: every `RectJob` produced a program, so an entry
/// mode it did not implement had nowhere to go except into the nearest arm that
/// looked similar. That is how `Helix` came to mean `Ramp` here.
pub fn build(job: &RectJob) -> Result<(Toolpath, String), String> {
    // ---- what the entry mode MEANS, decided once, before any motion exists --
    //
    // 🔴 `EntryMode::Helix` USED TO BE MATCHED HERE TOGETHER WITH `Ramp`, so a
    // caller that asked for a helical bore got a linear ramp along the contour
    // and nothing said so. `core/src/toolpath.rs::plan_profile` — the engine —
    // stopped doing that and REFUSES the mode; this file did not, so the two
    // disagreed about what one word meant. A generator and an engine that
    // disagree is worse than either being wrong alone, because whichever one
    // you read tells you the truth about the other's program.
    //
    // Helical entry is NOT implemented: it needs its own descent geometry
    // (pitch per turn, a clearance circle inside the pocket, and a gouge check
    // against the finished wall) and none of that exists here or there. So it
    // reports that it is not implemented, exactly as `Technology::Fdm` does,
    // rather than quietly behaving like something else. Implement it, or keep
    // refusing — never alias it.
    //
    // Deliberately word-for-word the engine's refusal (asserted by a test
    // below, so the two cannot drift apart in silence).
    if job.op.entry == EntryMode::Helix {
        return Err(HELIX_REFUSAL.to_string());
    }

    let r = job.tool.radius_mm();

    // Tool-radius compensation, host-side. grblHAL has no G41/G42, so the
    // coordinates below are already the TOOL CENTRE path, never the part edge.
    let (grow, inside) = match job.op.side {
        CutSide::Outside => (r, false),
        CutSide::Inside => (-r, true),
        CutSide::OnLine => (0.0, false),
    };
    let _ = inside;

    let mut x0 = job.x0 - grow;
    let y0 = job.y0 - grow;
    let x1 = job.x0 + job.width_mm + grow;
    let y1 = job.y0 + job.height_mm + grow;

    if job.plant == Plant::OffBed {
        // Shift the whole part past the far edge of 600mm of X travel.
        x0 += 900.0;
    }

    let mut depth_total = job.op.depth_total_mm;
    if job.plant == Plant::ThroughSpoilboard {
        // Cut the full model thickness plus 7mm, the exact defect the fork's
        // G2 gate was written for.
        depth_total = job.stock.thickness_mm + 7.0;
    }

    let feed = if job.op.feed_mm_min > 0.0 {
        job.op.feed_mm_min
    } else {
        feed_from_chipload(&job.tool, job.op.rpm)
    };

    let rpm = if job.plant == Plant::RpmOutOfRange { 60_000.0 } else { job.op.rpm };

    let name = if job.plant == Plant::ParenInName {
        format!("{} (v2) G0 Z0", job.name)
    } else {
        job.name.clone()
    };

    let safe_z = 5.0_f64;
    let mut mv: Vec<Move> = Vec::new();

    mv.push(Move::comment(format!("profile: {name}")));

    if job.plant == Plant::ArcBeforePosition {
        // No positioning move first — the post must reject this, not emit it.
        mv.push(Move::arc(false, Vec3::new(x1, y0, 0.0), Vec2::new(x1, y1), feed));
    }

    if job.plant != Plant::SpindleNeverOn {
        mv.push(Move::spindle_on(rpm));
    }

    // Corner centres for the arc variant.
    let cr = job.corner_r_mm.min(r.max(job.corner_r_mm));
    let arcs = cr > 1e-9;

    for z in depth_passes(depth_total, job.op.depth_per_pass_mm) {
        mv.push(Move::rapid(Vec3::new(x0 + cr, y0, safe_z)));

        // Ramp entry: descend along the first edge instead of plunging. A
        // straight plunge in ply burns the bit and the work.
        let ramp_len = job.op.ramp_length_mm.min(job.width_mm.max(1.0));
        match job.op.entry {
            EntryMode::Plunge => {
                mv.push(Move::feed_to(Vec3::new(x0 + cr, y0, z), job.op.plunge_mm_min));
            }
            // Refused above, before any motion existed. Written as its own arm
            // rather than folded into a `_` so that adding a fourth entry mode
            // is a COMPILE ERROR here — a wildcard is how a new mode would
            // inherit the ramp's behaviour without anyone choosing it, which is
            // the defect this arm was split to end.
            EntryMode::Helix => unreachable!("helical entry is refused before any move is built"),
            EntryMode::Ramp => {
                mv.push(Move::feed_to(Vec3::new(x0 + cr, y0, 0.0), job.op.plunge_mm_min));
                mv.push(Move::feed_to(Vec3::new(x0 + cr + ramp_len, y0, z), feed));
                // 🔴 The fork's G1 gate exists because the contour then
                // restarted at index 0 regardless of where the ramp ended,
                // cutting a chord at full depth straight across the part.
                // The path below CONTINUES from the ramp end and closes the
                // loop at the ramp end — it never jumps back to the start.
            }
        }

        // Bottom edge (continuing from wherever the ramp finished), then
        // right, top, left, and close.
        if arcs {
            // Rounded rectangle: straight edges joined by real G2/G3 arcs.
            // Climb direction on an outside profile is clockwise, which is G2.
            mv.push(Move::feed_to(Vec3::new(x1 - cr, y0, z), feed));
            mv.push(Move::arc(false, Vec3::new(x1, y0 + cr, z), Vec2::new(x1 - cr, y0 + cr), feed));
            mv.push(Move::feed_to(Vec3::new(x1, y1 - cr, z), feed));
            mv.push(Move::arc(false, Vec3::new(x1 - cr, y1, z), Vec2::new(x1 - cr, y1 - cr), feed));
            mv.push(Move::feed_to(Vec3::new(x0 + cr, y1, z), feed));
            mv.push(Move::arc(false, Vec3::new(x0, y1 - cr, z), Vec2::new(x0 + cr, y1 - cr), feed));
            mv.push(Move::feed_to(Vec3::new(x0, y0 + cr, z), feed));
            mv.push(Move::arc(false, Vec3::new(x0 + cr, y0, z), Vec2::new(x0 + cr, y0 + cr), feed));
        } else {
            mv.push(Move::feed_to(Vec3::new(x1, y0, z), feed));
            mv.push(Move::feed_to(Vec3::new(x1, y1, z), feed));
            mv.push(Move::feed_to(Vec3::new(x0, y1, z), feed));
            mv.push(Move::feed_to(Vec3::new(x0, y0, z), feed));
            mv.push(Move::feed_to(Vec3::new(x0 + cr, y0, z), feed));
        }

        mv.push(Move::rapid(Vec3::new(x0 + cr, y0, safe_z)));
    }

    mv.push(Move::spindle_off());

    let mut path = Toolpath { moves: mv, tool: job.tool.clone(), ..Default::default() };
    path.recompute_bounds();
    Ok((path, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn depth_schedule_reaches_exactly_the_total() {
        let z = depth_passes(18.0, 3.0);
        assert_eq!(z.len(), 6);
        assert!((z[z.len() - 1] + 18.0).abs() < 1e-9);
    }

    #[test]
    fn depth_schedule_folds_a_sliver_instead_of_emitting_it() {
        // 18.4 / 6.0 would leave a 0.4mm final pass — it must be folded in.
        let z = depth_passes(18.4, 6.0);
        assert_eq!(z.len(), 3, "expected the sliver folded into the last pass, got {z:?}");
        assert!((z[2] + 18.4).abs() < 1e-9);
    }

    #[test]
    fn outside_profile_grows_by_the_tool_radius() {
        let job = RectJob::default();
        let (p, _) = build(&job).expect("the default job is buildable");
        // 120mm wide part, 6mm cutter outside => tool centre spans 126mm.
        assert!((p.max_x - p.min_x - 126.0).abs() < 1e-6, "span {}", p.max_x - p.min_x);
    }

    #[test]
    fn bounds_ignore_non_positioning_records() {
        // A comment carries no coordinate; if it dragged the box to the origin
        // a travel-limit check would silently pass on an out-of-travel path.
        let job = RectJob { x0: 100.0, y0: 100.0, ..Default::default() };
        let (p, _) = build(&job).expect("the default job is buildable");
        assert!(p.min_x > 90.0, "min_x pulled to origin by a non-positioning record: {}", p.min_x);
    }

    fn job_with_entry(entry: EntryMode) -> RectJob {
        RectJob { op: OperationParams { entry, ..OperationParams::default() }, ..Default::default() }
    }

    /// 🔴 The defect this file carried after the engine was fixed: `Helix`
    /// matched alongside `Ramp`, so the fixture path emitted a linear ramp and
    /// called it a helix. NOTHING may come back — not a toolpath with a ramp
    /// in it, not an empty program that reads downstream like a job with no
    /// cuts. A refusal, and no G-code to post.
    #[test]
    fn helix_is_refused_here_and_produces_no_toolpath() {
        let err = build(&job_with_entry(EntryMode::Helix))
            .expect_err("Helix must be REFUSED by the fixture generator, never aliased to Ramp");
        assert!(
            err.contains("NOT IMPLEMENTED"),
            "the refusal must say what it is refusing and why, got: {err}"
        );
    }

    /// The other half, which is the half a refuse-everything "fix" would fail:
    /// the modes that ARE implemented still build a real program.
    #[test]
    fn ramp_and_plunge_still_build() {
        for entry in [EntryMode::Ramp, EntryMode::Plunge] {
            let (p, _) = build(&job_with_entry(entry))
                .unwrap_or_else(|e| panic!("{entry:?} must still build, got refusal: {e}"));
            assert!(
                p.moves.iter().any(|m| matches!(m.kind, MoveKind::Feed)),
                "{entry:?} produced no cutting move"
            );
        }
    }

    /// The generator and the ENGINE must refuse in the SAME WORDS.
    ///
    /// 🔴 This is the test that would have caught the residual: `toolpath.rs`
    /// was corrected and this file was not, and nothing anywhere compared the
    /// two. Asserting byte-equality against the engine's own refusal means the
    /// next divergence is a red test rather than a discovery.
    #[test]
    fn the_generator_refuses_helix_in_the_engines_own_words() {
        use crate::geometry::Contour;
        use crate::toolpath::{plan_profile, Operation};

        let op = Operation {
            name: "helix-consistency".into(),
            part: "helix-consistency".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(0.0, 0.0, 100.0, 60.0),
            tool: Tool::default(),
            params: OperationParams { entry: EntryMode::Helix, ..OperationParams::default() },
        };
        let engine = plan_profile(&op, &Machine::default(), &Stock::default());
        let engine_why = engine
            .refusals
            .first()
            .map(|r| r.why.clone())
            .expect("the engine refuses Helix — if it stopped, THAT is the regression");

        assert_eq!(
            build(&job_with_entry(EntryMode::Helix)).unwrap_err(),
            engine_why,
            "the fixture generator and the engine give different reasons for refusing the same \
             mode; an operator reading one would be wrong about the other"
        );
    }
}
