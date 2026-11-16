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
    /// Restore the 2026-11 defect: close each ramped pass at the START point
    /// instead of the ramp END, so the ramp stretch is never cut at that pass's
    /// depth and the last pass leaves a wedge (Z0 -> full depth) attached along
    /// the first edge. The part does not come free.
    ///
    /// ⚠ CORE-ONLY. It is the negative control for the emitted-program test
    /// `every_point_of_the_perimeter_is_cut_at_full_depth_in_the_emitted_program`
    /// and is deliberately NOT a `--plant` name in the CLI: exposing it there
    /// makes it a registry plant that gate PLANT requires a consuming gate row
    /// for, and no gate row walks the perimeter yet (left open, see that test).
    RampStretchUncut,
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
    let mut x1 = job.x0 + job.width_mm + grow;
    let y1 = job.y0 + job.height_mm + grow;

    if job.plant == Plant::OffBed {
        // Shift the whole part past the far edge of 600mm of X travel. BOTH edges: until
        // 2026-11-13 only x0 moved, so the planted part was inside out (x1 < x0, a negative first
        // edge) and reached the travel check only because nothing looked at its shape first.
        x0 += 900.0;
        x1 += 900.0;
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

    // 🔴 A ramp needs a straight edge to ride. When the corner arcs eat the whole first edge
    // (10 mm wide part, 8 mm corners, 6 mm cutter outside: 16 - 16 = 0) the clamp below took
    // `ramp_len` to 0 and "Ramp" emitted a VERTICAL plunge to full pass depth at the CUTTING feed,
    // not the plunge feed (bughunt 2026-11-13) — the program reading Ramp while plunging. Refused,
    // like Helix: ask for Plunge, which descends at the plunge feed, or give the part an edge.
    if job.op.entry == EntryMode::Ramp && (x1 - cr) - (x0 + cr) <= 1e-6 {
        return Err(format!(
            "ramp entry refused: the first straight edge of the tool path is {:.3} mm long, so there is \
             nothing to ramp along and the descent would be a vertical plunge at the cutting feed. \
             Use plunge entry, or a part whose corners leave a straight edge.",
            ((x1 - cr) - (x0 + cr)).max(0.0)
        ));
    }

    for z in depth_passes(depth_total, job.op.depth_per_pass_mm) {
        mv.push(Move::rapid(Vec3::new(x0 + cr, y0, safe_z)));

        // Ramp entry: descend along the first edge instead of plunging. A
        // straight plunge in ply burns the bit and the work.
        //
        // 🔴 The ramp must END ON THE FIRST STRAIGHT EDGE, because the pass is
        // closed by cutting back along that edge to the ramp end (below). This
        // was clamped to `width_mm`, the PART width, while the straight edge the
        // tool centre runs is `x1 - x0 - 2*cr` — on a small rounded part the
        // ramp overran the corner arc's tangent point and descended through
        // waste off the contour. Same rule as the engine's `ramp_len` clamp in
        // `toolpath.rs` (`.min(perim * 0.5)`): the ramp has to fit what it rides.
        let first_edge = (x1 - cr) - (x0 + cr);
        let ramp_len = job.op.ramp_length_mm.min(job.width_mm.max(1.0)).min(first_edge.max(0.0));
        let ramped = job.op.entry == EntryMode::Ramp;
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
                // The path below CONTINUES from the ramp end, runs the whole
                // loop back to the start, and then CUTS ON TO THE RAMP END at
                // depth — see the close below.
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

        // 🔴 CLOSE AT THE RAMP END, NOT AT THE START. Everything between the
        // start and the ramp end was cut while descending — shallower than `z`
        // everywhere except the ramp's last point. Until 2026-11-13 this file
        // closed the loop at the start and its comment claimed it closed at the
        // ramp end; on the last pass that left a wedge from Z0 at X47 to Z-18 at
        // X67 along Y47 (the `fixture rect-profile` numbers) and the part did
        // not come free. The engine (`toolpath.rs::plan_profile`) completes the
        // ramped stretch with a full finishing lap; here the stretch is a
        // straight run on the first edge, so cutting on to the ramp end at depth
        // covers exactly what the ramp left — and nothing else.
        let mut lap_end = (x0 + cr, y0);
        if ramped && ramp_len > 1e-9 && job.plant != Plant::RampStretchUncut {
            mv.push(Move::feed_to(Vec3::new(x0 + cr + ramp_len, y0, z), feed));
            lap_end = (x0 + cr + ramp_len, y0);
        }

        // A pure Z lift where the cut ended — a retract that moves XY as well
        // drags the cutter sideways while it is still in the cut.
        mv.push(Move::rapid(Vec3::new(lap_end.0, lap_end.1, safe_z)));
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

    /// Bughunt 2026-11-13: corners that eat the whole first straight edge left a 0 mm ramp, and
    /// "Ramp" emitted a vertical plunge at the CUTTING feed. Refused; Plunge still builds there.
    #[test]
    fn a_ramp_with_no_straight_edge_to_ride_is_refused_and_plunge_still_builds() {
        let mut j = job_with_entry(EntryMode::Ramp);
        j.op.side = CutSide::Outside;
        j.width_mm = 10.0;
        j.corner_r_mm = j.width_mm / 2.0 + j.tool.radius_mm(); // first edge = 10 + 2r - 2cr = 0
        let err = build(&j).expect_err("a 0 mm ramp must be refused, not emitted as a plunge at cutting feed");
        assert!(err.contains("ramp entry refused"), "{err}");
        j.op.entry = EntryMode::Plunge;
        build(&j).unwrap_or_else(|e| panic!("plunge entry must still build here: {e}"));
        // Control: a part with an edge left still ramps.
        j.op.entry = EntryMode::Ramp;
        j.corner_r_mm -= 1.0;
        build(&j).unwrap_or_else(|e| panic!("a 2 mm edge must still ramp: {e}"));
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

    // ---- the emitted-program perimeter walk --------------------------------
    //
    // 🔴 ASSERTS ON THE G-CODE TEXT, NOT ON `Toolpath::moves`. The defect this
    // guards (the ramp stretch never cut at depth) was invisible to every check
    // that read the plan's Z range: the plan reached -18 and the bounds were
    // right. What it got wrong was WHERE it reached -18, and only a walk of the
    // posted program over the perimeter can see that.

    /// Every cutting point the posted program visits, sampled every `step` mm
    /// along each G1/G2/G3 block. Modal motion, absolute XYZ, incremental IJ
    /// (the grblHAL post's arc form). Rapids are not cutting and are skipped.
    fn cut_points(gcode: &str, step: f64) -> Vec<(f64, f64, f64)> {
        let (mut x, mut y, mut z) = (0.0_f64, 0.0_f64, 0.0_f64);
        let mut mode = 0u32;
        let mut pts = Vec::new();
        for raw in gcode.lines() {
            // Strip `( ... )` comments and `;` tails.
            let mut line = String::new();
            let mut depth = 0;
            for c in raw.chars() {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    ';' if depth == 0 => break,
                    _ if depth == 0 => line.push(c),
                    _ => {}
                }
            }
            let up = line.to_ascii_uppercase();
            let mut words: Vec<(char, f64)> = Vec::new();
            let b = up.as_bytes();
            let mut i = 0;
            while i < b.len() {
                let c = b[i] as char;
                if c.is_ascii_alphabetic() {
                    let st = i + 1;
                    let mut e = st;
                    while e < b.len() && (b[e] == b'-' || b[e] == b'.' || b[e].is_ascii_digit()) {
                        e += 1;
                    }
                    if let Ok(v) = up[st..e].parse::<f64>() {
                        words.push((c, v));
                    }
                    i = e;
                } else {
                    i += 1;
                }
            }
            for &(c, v) in &words {
                if c == 'G' && [0.0, 1.0, 2.0, 3.0].contains(&v) {
                    mode = v as u32;
                }
            }
            let get = |k: char| words.iter().find(|w| w.0 == k).map(|w| w.1);
            // No axis word (G4 P2, G17 G21 ..., M3 S...): no motion.
            if get('X').is_none() && get('Y').is_none() && get('Z').is_none() {
                continue;
            }
            let (nx, ny, nz) = (get('X').unwrap_or(x), get('Y').unwrap_or(y), get('Z').unwrap_or(z));
            match mode {
                1 => {
                    let l = ((nx - x).powi(2) + (ny - y).powi(2) + (nz - z).powi(2)).sqrt();
                    let n = ((l / step).ceil() as usize).max(1);
                    for k in 0..=n {
                        let f = k as f64 / n as f64;
                        pts.push((x + (nx - x) * f, y + (ny - y) * f, z + (nz - z) * f));
                    }
                }
                2 | 3 => {
                    let (cx, cy) = (x + get('I').unwrap_or(0.0), y + get('J').unwrap_or(0.0));
                    let r = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                    let a0 = (y - cy).atan2(x - cx);
                    let a1 = (ny - cy).atan2(nx - cx);
                    let mut sweep = a1 - a0;
                    if mode == 2 {
                        while sweep >= 0.0 {
                            sweep -= std::f64::consts::TAU;
                        }
                    } else {
                        while sweep <= 0.0 {
                            sweep += std::f64::consts::TAU;
                        }
                    }
                    let n = (((sweep.abs() * r) / step).ceil() as usize).max(1);
                    for k in 0..=n {
                        let f = k as f64 / n as f64;
                        let a = a0 + sweep * f;
                        pts.push((cx + r * a.cos(), cy + r * a.sin(), z + (nz - z) * f));
                    }
                }
                _ => {}
            }
            x = nx;
            y = ny;
            z = nz;
        }
        pts
    }

    /// Sample the tool-centre perimeter the job asks for — derived from the
    /// JOB's fields, not from the generator's moves, so a generator that
    /// changes its contour cannot change what is checked.
    fn perimeter_samples(job: &RectJob, step: f64) -> Vec<(f64, f64)> {
        let g = job.tool.radius_mm(); // outside profile
        let (x0, y0) = (job.x0 - g, job.y0 - g);
        let (x1, y1) = (job.x0 + job.width_mm + g, job.y0 + job.height_mm + g);
        let cr = job.corner_r_mm;
        let mut out = Vec::new();
        let mut line = |a: (f64, f64), b: (f64, f64), out: &mut Vec<(f64, f64)>| {
            let l = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
            let n = ((l / step).ceil() as usize).max(1);
            for k in 0..n {
                let f = k as f64 / n as f64;
                out.push((a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f));
            }
        };
        line((x0 + cr, y0), (x1 - cr, y0), &mut out);
        line((x1, y0 + cr), (x1, y1 - cr), &mut out);
        line((x1 - cr, y1), (x0 + cr, y1), &mut out);
        line((x0, y1 - cr), (x0, y0 + cr), &mut out);
        if cr > 1e-9 {
            for (cx, cy, a0) in [
                (x1 - cr, y0 + cr, -90.0_f64),
                (x1 - cr, y1 - cr, 0.0),
                (x0 + cr, y1 - cr, 90.0),
                (x0 + cr, y0 + cr, 180.0),
            ] {
                let n = ((cr * std::f64::consts::FRAC_PI_2 / step).ceil() as usize).max(1);
                for k in 0..n {
                    let a = (a0 + 90.0 * k as f64 / n as f64).to_radians();
                    out.push((cx + cr * a.cos(), cy + cr * a.sin()));
                }
            }
        }
        out
    }

    /// Post `job` and return, for each perimeter sample, the DEEPEST emitted
    /// cutting Z within `tol` of it (`None` = the program never cut there).
    fn deepest_z_along_perimeter(job: &RectJob) -> Vec<((f64, f64), Option<f64>)> {
        use crate::post_grblhal::{post_grblhal, PostOptions};
        let (path, name) = build(job).expect("buildable");
        let post = post_grblhal(
            &path,
            &Machine::default(),
            &job.stock,
            &job.op,
            &PostOptions { program_name: name, ..PostOptions::default() },
        );
        assert!(post.errors.is_empty(), "post refused the job: {:?}", post.errors);
        assert!(!post.gcode.is_empty(), "post produced no program");
        let pts = cut_points(&post.gcode, 0.05);
        let tol = 0.05;
        perimeter_samples(job, 1.0)
            .into_iter()
            .map(|s| {
                let deepest = pts
                    .iter()
                    .filter(|p| (p.0 - s.0).powi(2) + (p.1 - s.1).powi(2) <= tol * tol)
                    .map(|p| p.2)
                    .fold(None, |m: Option<f64>, z| Some(m.map_or(z, |m| m.min(z))));
                (s, deepest)
            })
            .collect()
    }

    /// The fixtures `fixture rect-profile` / `rect-arcs` post: 18mm ply cut
    /// through at exactly `stock.thickness_mm`, as the CLI sets it.
    fn through_job(corner_r_mm: f64, plant: Plant) -> RectJob {
        let stock = Stock::default();
        RectJob {
            corner_r_mm,
            plant,
            op: OperationParams { depth_total_mm: stock.thickness_mm, ..OperationParams::default() },
            stock,
            ..RectJob::default()
        }
    }

    fn shallow_samples(job: &RectJob) -> Vec<((f64, f64), Option<f64>)> {
        let want = -job.op.depth_total_mm;
        deepest_z_along_perimeter(job)
            .into_iter()
            .filter(|(_, z)| z.map_or(true, |z| z > want + 1e-6))
            .collect()
    }

    /// 🔴 THE PART COMES FREE: every point of the profile perimeter is cut at
    /// the final depth somewhere in the EMITTED program. Square and rounded,
    /// ramp and plunge.
    #[test]
    fn every_point_of_the_perimeter_is_cut_at_full_depth_in_the_emitted_program() {
        for cr in [0.0, 8.0] {
            for entry in [EntryMode::Ramp, EntryMode::Plunge] {
                let mut job = through_job(cr, Plant::None);
                job.op.entry = entry;
                let total = deepest_z_along_perimeter(&job).len();
                let bad = shallow_samples(&job);
                assert!(
                    bad.is_empty(),
                    "corner_r={cr} {entry:?}: {} of {total} perimeter samples not cut to Z{:.3}; \
                     first {:?}, last {:?}",
                    bad.len(),
                    -job.op.depth_total_mm,
                    bad.first(),
                    bad.last()
                );
            }
        }
    }

    /// The negative control. `RampStretchUncut` restores closing at the start;
    /// the walk must see the wedge — at the ramp START the deepest cut is Z0,
    /// and the shallow samples sit on the first edge between ramp start and end.
    #[test]
    fn the_ramp_stretch_plant_leaves_a_wedge_the_walk_sees() {
        for cr in [0.0, 8.0] {
            let job = through_job(cr, Plant::RampStretchUncut);
            let bad = shallow_samples(&job);
            assert!(!bad.is_empty(), "corner_r={cr}: plant is VACUOUS — the walk saw no wedge");
            let g = job.tool.radius_mm();
            let (sx, y) = (job.x0 - g + cr, job.y0 - g);
            let ex = sx + job.op.ramp_length_mm;
            for ((px, py), _) in &bad {
                assert!(
                    (py - y).abs() < 1e-9 && *px >= sx - 1e-9 && *px < ex,
                    "corner_r={cr}: shallow sample ({px},{py}) is outside the ramp stretch"
                );
            }
            // The ramp start itself is also the end of the closing edge, cut at
            // depth, so the wedge is the OPEN interval (start, end): 19 samples
            // at 1mm over a 20mm ramp. Its thin end is cut less than 1mm deep.
            assert_eq!(bad.len(), 19, "corner_r={cr}: wedge sample count {}", bad.len());
            let shallowest = bad.iter().filter_map(|(_, z)| *z).fold(f64::MIN, f64::max);
            assert!(
                shallowest > -1.0,
                "corner_r={cr}: the wedge's thin end should be cut <1mm deep, got Z{shallowest:.3}"
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
