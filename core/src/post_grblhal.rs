//! grblHAL post-processor.
//!
//! Ported from the 2bee OrcaSlicer CNC fork (`src/libslic3r/CNC/PostGrblHAL.cpp`,
//! AGPL-3.0). The dialect facts below were verified against grblHAL's own
//! sources and reference, not assumed — see the inline notes.

use crate::types::*;

#[derive(Clone, Debug)]
pub struct PostOptions {
    pub program_name: String,
    pub emit_comments: bool,
    pub metric: bool,
    pub absolute: bool,
    /// 54..59 — G54 is the usual router work offset.
    pub work_offset: u32,
    pub decimals: usize,
    /// Honoured only if [`Machine::supports_arcs`].
    pub emit_arcs: bool,
}

// 🔴 `PostOptions::z_offset_mm` WAS HERE AND IS DELETED (2026-08-11), and the
// deletion is the point rather than a tidy-up.
//
// It was a raw millimetre shift added to every emitted Z word, set by the CLI's
// `--spoilboard-zero` and by nothing else — a SECOND place the question "where
// is Z0" was answered, alongside `Stock::z_zero_at_top`, which answered it and
// reached no emitted byte. Two controls for one question, one of them dead, and
// the field could hold a value that disagreed with the declared datum: a stock
// saying "top" and an offset of 18 produced a program datumed at the bottom with
// every reader of that program still measuring from the top.
//
// The post already receives `&Stock`. It takes the datum from there, through
// [`crate::types::ZDatum`], which is the only function in this crate that
// answers it. `--spoilboard-zero` is now a `Stock` mutation, which is what it
// always meant.

impl Default for PostOptions {
    fn default() -> Self {
        Self {
            // ⚠ Renamed `2bee.slicer` -> `2bee.app` on 2026-08-11 with the lane.
            //
            // 🔴 **AND IT REACHES NO EMITTED PROGRAM TODAY.** It was routed here
            // as *"emitted into the G-code header of every program"*; measured
            // across all 13 programs this crate can produce — 4 fixtures, 6
            // jobs, 2 imports, 1 nest — **zero** carry it. Every emitting door
            // overrides `program_name` with the job/fixture/import name
            // (`cli/src/main.rs` x3, `fixtures.rs::plan_report`), so the default
            // is only ever reached by `PostOptions::default()` inside tests.
            // The rename is still worth making — the trap is a future door that
            // forgets to set the field and ships a dead product name — but the
            // measured diff of this line across the whole corpus is 0 bytes, and
            // recording that here is cheaper than the next person re-measuring
            // it to find out what it changed.
            program_name: "2bee.app".into(),
            emit_comments: true,
            metric: true,
            absolute: true,
            work_offset: 54,
            decimals: 3,
            emit_arcs: true,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct PostResult {
    pub gcode: String,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    /// One entry per planned move that put at least one line into
    /// [`PostResult::gcode`], in emission order. See [`EmittedBlock`].
    ///
    /// 🔴 **EMPTY WHEN `gcode` IS EMPTY, and for the same reason.** A refused
    /// program is discarded whole — there is no half-program to describe, and a
    /// block list surviving a discarded program would be a map of a file that
    /// does not exist.
    pub blocks: Vec<EmittedBlock>,
}

/// The lines one planned move put into the program, and what that move belongs
/// to.
///
/// # Why this exists at all
///
/// The program is the artefact; everything else is a plan. A host that streams
/// it — the run tab, a G-code view that follows the sender — has a **line
/// number** in its hand and nothing to turn it into. The operation names are in
/// the file, as `( op: pocket-1 [6mm 2F] )` comments, so the only alternative to
/// this struct is every host re-parsing the program with a regex of its own.
/// Four regexes for one format is how the format's next change unhooks three of
/// them silently.
///
/// 🔴 **The attribution is NOT re-derived here.** `op` and `tool` are indexed
/// out of [`crate::toolpath::attribute_moves`] — the same vector a host uses to
/// label the drawn path — so the program view and the 3D view cannot disagree
/// about which operation a cut belongs to. One derivation, two consumers.
#[derive(Clone, Debug, PartialEq)]
pub struct EmittedBlock {
    /// Index into `path.moves` of the move that produced these lines.
    pub move_index: usize,
    pub kind: MoveKind,
    /// 1-based line number of the FIRST line this move wrote.
    pub first_line: usize,
    /// How many lines it wrote. Always at least 1 — a move that wrote nothing
    /// gets no entry, because "wrote nothing" and "wrote a blank line" are
    /// different facts and only one of them is on the machine's mind.
    pub lines: usize,
    pub op: Option<String>,
    pub tool: Option<String>,
    /// mm/min in force for this move's CUTTING lines — the same value the `F`
    /// word carries, taken from the same variable that decides whether to write
    /// one. `F` is modal, so a move that changes nothing writes no `F` and this
    /// field repeats the rate still in force.
    ///
    /// 🔴 **`None` is not zero and not "unknown-so-guess".** It means the move
    /// carries no feed at all — a `G0` rapid, a tool change, a dwell. A rapid
    /// runs at [`crate::types::Machine::rapid_mm_min`], which is a machine
    /// property and not in the text, because `G0` has no `F` word.
    ///
    /// # 🔴 A RATE IS NOT A TIME, AND THIS ONE IS ONE DIVISION AWAY FROM BEING
    /// QUOTED AS ONE
    ///
    /// `length / feed` is the **steady-state** duration: it assumes the machine
    /// is already at the commanded rate and stays there for the whole move.
    /// grblHAL ramps into and out of every corner, so a real block takes
    /// **longer** — worst on a program of many short segments, which is exactly
    /// the arc-heavy work this core produces. Nothing here models acceleration
    /// and nothing here is going to.
    ///
    /// So a host deriving a duration from this field is deriving a **floor**,
    /// and it must carry [`crate::job::ESTIMATE_CAVEAT`] wherever it shows the
    /// result — with this program's own exposure, which
    /// [`crate::job::EstimateBasis`] counts (`short_moves` of `motion_blocks`).
    /// A playback labelled `x1` off an unqualified steady-state figure runs
    /// fast, and it runs fast in the direction that reads as "nearly finished".
    ///
    /// ⚠ **And there is no `duration_s` on this struct on purpose.** The core
    /// already derives the job's time in exactly one place — `job.rs` reads it
    /// back out of the emitted text — and a second derivation here would be a
    /// number that agrees with it until the day it does not.
    pub feed_mm_min: Option<f64>,
}

impl PostResult {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// `-0.000` is legal G-code but reads as a defect in a diff; normalise it.
fn fmt(v: f64, decimals: usize) -> String {
    let v = if v.abs() < 5e-7 { 0.0 } else { v };
    format!("{v:.decimals$}")
}

fn near_eq(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

/// grblHAL comments DO NOT NEST — its own parser carries the TODO admitting a
/// `(` inside a comment is not handled (`gcode.c gc_normalize_block`). Anything
/// interpolated into a comment comes from a filename or preset name, so an
/// unescaped `)` ENDS the comment early and the remaining text is parsed as
/// CODE: a part called `bracket (v2) G0 Z0.stl` emits a silently executed rapid.
/// Parentheses are replaced rather than dropped so the name stays readable to
/// the operator.
fn sanitize(t: &str) -> String {
    t.chars()
        .map(|c| match c {
            '(' | ')' => '_',
            '\n' | '\r' | '%' => ' ',
            other => other,
        })
        .collect()
}

/// Every numeric word in a finished program must be a number.
///
/// 🔴 **THE LAST LINE OF DEFENCE, AND IT READS THE TEXT.** Everything above this
/// asserts on the plan; this asserts on the bytes a sender will stream. The two
/// are different facts because the post does arithmetic of its own — the
/// [`ZDatum`] shift, the host-side peck expansion, the arc-to-chord
/// degradation — and a non-finite value born in any of those would pass a
/// plan-side check untouched and still reach the controller.
///
/// What it is guarding against physically: grblHAL is handed `G1 XNaN YNaN`
/// with a 2.2 kW spindle turning. Nothing in grblHAL's documented behaviour
/// tells us what it does with that, and "unspecified" is the one machine state
/// a person standing beside the router cannot plan around.
///
/// ⚠ **Comments are skipped, deliberately.** A program name comes from a
/// filename, and `infill.dxf` contains `inf` while a part called `NaN_test`
/// contains `NaN`. A scanner that false-reds on a filename gets muted, and a
/// muted gate is not a gate.
pub fn audit_finite_words(gcode: &str) -> Vec<String> {
    let mut errs = Vec::new();
    for (n, raw) in gcode.lines().enumerate() {
        // Whole-line comments, and anything after an inline `(`.
        let line = match raw.find('(') {
            Some(i) => &raw[..i],
            None => raw,
        };
        for word in line.split_whitespace() {
            let mut ch = word.chars();
            let Some(letter) = ch.next() else { continue };
            if !letter.is_ascii_alphabetic() {
                continue;
            }
            let rest = ch.as_str();
            if rest.is_empty() {
                continue;
            }
            // A word whose value does not parse at all is a separate defect and
            // not this function's; only a value that parses to something which
            // is not a number is refused here.
            if let Ok(v) = rest.parse::<f64>() {
                if !v.is_finite() {
                    errs.push(format!(
                        "line {}: the word `{word}` is not a number — a non-finite value reached \
                         the emitted program, which must never be streamed to a controller",
                        n + 1
                    ));
                }
            }
        }
    }
    errs
}

pub fn check_machine_limits(path: &Toolpath, machine: &Machine) -> Vec<String> {
    let mut v = Vec::new();
    if path.is_empty() {
        return v;
    }

    // 🔴 THE BOUNDS ARE NOT THE WHOLE ANSWER, AND READING THEM ALONE IS WHAT
    // MADE THIS CHECK BLIND. `Toolpath::recompute_bounds` folds with
    // `f64::min`/`f64::max`, which return the other operand on NaN — so a move
    // with no destination never widened the box, the box stayed comfortably
    // inside the machine, and this function passed a program containing
    // `G1 XNaN YNaN`. The box now describes only the moves it could measure and
    // says so in `nonfinite_moves`; a travel check that ignored that would be
    // bounding a program it has not seen all of.
    if let Some((i, m)) = path.first_nonfinite_move() {
        v.push(format!(
            "move {i} ({:?}) has a non-finite destination (X{} Y{} Z{}) — it is NOT inside the \
             travel, it is nowhere, and the bounding box below describes only the moves that \
             could be measured",
            m.kind, m.to.x, m.to.y, m.to.z
        ));
    }

    let mut report = |axis: &str, got: f64, lo: f64, hi: f64| {
        v.push(format!("move outside {axis} travel: {got} (allowed {lo} .. {hi})"));
    };

    // Z is measured from the workpiece top downwards, so cutting moves are negative
    // and the clearance plane is positive. The travel bound applies to depth.
    //
    // Both ends are reported, not just the first: a path that runs off BOTH
    // ends of the travel is two faults, and collapsing them to one hides work.
    if path.min_x < 0.0 {
        report("X", path.min_x, 0.0, machine.travel_x_mm);
    }
    if path.max_x > machine.travel_x_mm {
        report("X", path.max_x, 0.0, machine.travel_x_mm);
    }
    if path.min_y < 0.0 {
        report("Y", path.min_y, 0.0, machine.travel_y_mm);
    }
    if path.max_y > machine.travel_y_mm {
        report("Y", path.max_y, 0.0, machine.travel_y_mm);
    }
    if -path.min_z > machine.travel_z_mm {
        report("Z", path.min_z, -machine.travel_z_mm, machine.safe_z_mm);
    }

    v
}

/// The workpiece is the only thing that knows where the spoilboard is, and the
/// machine's Z travel does NOT stand in for it: a 100mm Z travel happily
/// accepts a 25mm cut in 18mm ply, which is 7mm of cutter in the spoilboard.
///
/// A through-cut legitimately goes slightly past the underside so the part
/// releases cleanly, so this is a tolerance and not equality. Anything beyond
/// it is a gouge into the machine.
pub fn check_stock_depth(path: &Toolpath, stock: &Stock, allowance_mm: f64) -> Vec<String> {
    let mut v = Vec::new();
    if path.is_empty() {
        return v;
    }
    // Same reason as `check_machine_limits`: `path.min_z` is the deepest move
    // that HAD a depth, and a move with no Z at all never reached the fold.
    if let Some((i, m)) = path.first_nonfinite_move() {
        v.push(format!(
            "move {i} ({:?}) has a non-finite Z ({}) — how deep it cuts is unknown, so the \
             deepest Z below is a floor and not a measurement",
            m.kind, m.to.z
        ));
    }
    // Z is measured down from the workpiece top, so cutting moves are negative.
    let limit = -(stock.thickness_mm + allowance_mm);
    if path.min_z < limit - 1e-9 {
        v.push(format!(
            "cuts {:.3}mm into the spoilboard: deepest Z {:.3} against {:.3}mm of workpiece \
             (allowance {:.3}mm)",
            -path.min_z - stock.thickness_mm,
            path.min_z,
            stock.thickness_mm,
            allowance_mm
        ));
    }
    v
}

/// How far past the underside of the workpiece a through-cut may go before it is
/// called a gouge. 0.3mm is a normal sacrificial pass into the spoilboard.
pub const SPOILBOARD_ALLOWANCE_MM: f64 = 0.3;

/// **The Z CEILING, in the frame the program is actually written in.**
///
/// 🔴 [`check_machine_limits`] asks half the question and always has. It tests
/// `-path.min_z > travel_z_mm` — how far DOWN the program goes — and **never
/// tests `path.max_z` at all.** Nobody noticed because under a workpiece-top
/// datum the highest Z any program emits is `machine.safe_z_mm`, which is
/// typically 5mm against 45–100mm of travel, so the untested half could not
/// fail.
///
/// A bottom datum makes it reachable. Every emitted Z rises by one workpiece
/// thickness, so the opening rapid becomes `safe_z + thickness` — `Z23.000` on
/// the 18mm reference fixture, and on the `Desktop 3018` preset (45mm of Z
/// travel) a 40mm workpiece puts it at `Z45`, exactly on the limit. What the
/// machine does then is hit the top of its own Z travel at rapid, before any
/// cutting move: a stall, a lost step, or a hard stop against the gantry, with
/// the rest of the program still queued and now referenced to a Z that has
/// slipped.
///
/// ⚠ **This is a NEW REFUSAL, not a translation of the old one**, and it is
/// kept in its own function because it asks about a different frame.
/// [`check_machine_limits`] is documented against the PLAN; this reads the plan
/// through [`ZDatum`] and asks about the BYTES. Folding it into the other one
/// would put two frames inside a function whose comments assert one.
pub fn check_emitted_z_ceiling(path: &Toolpath, machine: &Machine, stock: &Stock) -> Vec<String> {
    let mut v = Vec::new();
    if path.is_empty() {
        return v;
    }
    // 🔴 `path.max_z` IS NOT THE HIGHEST Z THE PROGRAM COMMANDS, and reading it
    // alone would have missed the very rapid this check exists for. The opening
    // retract, the closing retract, every tool-change lift and the probe's
    // approach are all `machine.safe_z_mm` and are written BY THE POST — they
    // appear nowhere in `path.moves`, so a plan-side maximum can sit far below
    // the first line of the file. The ceiling is the higher of the two, then
    // translated.
    //
    // ⚠ Same reason as its two siblings: a move with no Z never reached the fold
    // that produced `max_z`, so the bound describes only what could be measured.
    // That is reported by `check_machine_limits`; it is not re-reported here.
    let ceiling = stock.z_datum.emit_z(path.max_z.max(machine.safe_z_mm), stock);
    if ceiling > machine.travel_z_mm + 1e-9 {
        v.push(format!(
            "the highest Z this program COMMANDS is {ceiling:.3} and the machine has {:.3}mm of \
             Z travel: with Z zeroed on the {}, every emitted Z sits {:.3}mm above the planned \
             one, so the retract to safe-Z {:.3} is written as {ceiling:.3} and drives the \
             gantry into the top of its own travel before the first cut. Lower the safe-Z, use \
             a thinner workpiece, or zero Z on the workpiece top",
            machine.travel_z_mm,
            stock.z_datum.label(),
            stock.z_datum.emit_offset_mm(stock),
            path.max_z.max(machine.safe_z_mm),
        ));
    }
    v
}

// ---------------------------------------------------------------------------
// Touch plate.
//
// DIALECT FACTS, VERIFIED AT PUBLISHED SOURCES — not assumed. This lane's rule
// (AGENTS.md: `supports_cutter_comp` exists because someone assumed once):
//
//  * `G38.2`, NEVER `G38.3`. grblHAL's own `core/alarms.c` defines
//    `Alarm_ProbeFailContact` — "Probe fail. Probe did not contact the workpiece
//    within the programmed travel for G38.2 and G38.4." (ALARM:5; the list order
//    in that file is 1 HardLimit, 2 SoftLimit, 3 AbortCycle, 4 ProbeFailInitial,
//    5 ProbeFailContact). `G38.3`/`G38.5` return SILENTLY on no contact
//    (LinuxCNC G-code reference, G38.x: .3 and .5 "do not signal an error"), so
//    the `G10` that follows would write end-of-travel as the datum and PERSIST
//    it. A missed touch must stop the machine, not set a garbage origin.
//    https://github.com/grblHAL/core/blob/master/alarms.c
//    https://linuxcnc.org/docs/html/gcode/g-code.html#gcode:g38
//
//  * `G10 L20 P1` TAKES X AND Y EXACTLY AS IT TAKES Z. grblHAL's README lists
//    `G10L2, G10L20` among the supported non-modal commands; the NIST/LinuxCNC
//    form it implements is `G10 L20 P- axes`, whose own example is
//    "G10 L20 P1 X1.5 (set the X axis current location in coordinate system 1 to
//    1.5)". So one command sets all three, and it writes to non-volatile storage
//    (survives a power cycle) where `G92` does not. `P1` names G54 explicitly
//    rather than `P0` = "whatever is active", so the file does not depend on
//    machine state. https://github.com/grblHAL/core (README, supported G-codes)
//
//  * `G91` APPLIES TO `G38.2`. grbl's `gcode.c` converts axis words to a target
//    inside `if (axis_command != AXIS_COMMAND_TOOL_LENGTH_OFFSET)`, and the
//    `DISTANCE_MODE_ABSOLUTE` / incremental branch runs there for EVERY motion
//    mode — there is no exception for `MOTION_MODE_PROBE_TOWARD`. grblHAL forks
//    that parser. The whole XY sequence below is therefore INCREMENTAL, which is
//    what lets it run from wherever the operator jogged without the post knowing
//    a single absolute coordinate. https://github.com/gnea/grbl/blob/master/grbl/gcode.c
//
//  * A ZERO-LENGTH PROBE IS A PARSE ERROR, not a no-op: the same file fails with
//    `STATUS_GCODE_INVALID_TARGET` when `isequal_position_vector(position,
//    target)`, and with `STATUS_GCODE_NO_AXIS_WORDS` with no axis word. Hence
//    the refusals on non-positive `probe_max_mm` / `probe_retract_mm`.
//
//  * `F` IS EMITTED ON EVERY `G38` BLOCK. grblHAL's `$342`-`$345` govern the M6
//    tool-change probe only, never a probe issued from a program.
//
//  * `G41`/`G42` ARE ABSENT from grblHAL's supported list (only `G40`), which is
//    the reason the radius term below has to be in the COORDINATE. There is no
//    controller-side compensation to fall back on.
//
// THE PHYSICS, which is why this is not a small change:
//
//   A Z probe touches with the TIP. The contact point is on the tool axis, so
//   the offset has no term for the tool's width — which is how this post got
//   away with never knowing the diameter.
//
//   🔴 AN X OR Y PROBE TOUCHES WITH THE SIDE. The contact point is one TOOL
//   RADIUS off the axis, so the offset carries the radius. Wrong radius = every
//   coordinate in the program displaced by that amount, in a direction that
//   looks perfect on screen: the preview renders a correct toolpath and the
//   machine cuts the part in the wrong place. The radius therefore comes from
//   the tool ACTUALLY IN THE SPINDLE (`path.tool`), and an unknown one is
//   refused rather than guessed.
// ---------------------------------------------------------------------------

/// The Z half of every probe: which plate sets Z, how thick its top is, and
/// where the tool must stand to touch it.
///
/// 🔴 RESOLVED ONCE, USED BY BOTH CALLERS. The preamble datum probe and the
/// after-a-tool-change re-reference must describe the SAME plate: a re-reference
/// that measured the machine's fixed plate while the datum came from a corner
/// plate would move Z by the difference between two thicknesses, silently.
struct ZProbe {
    /// The `G10 L20 P1 Z` value — the plate's top thickness.
    top_mm: f64,
    /// Where to stand for the Z touch, in the same frame as every emitted
    /// coordinate. `None` = "probe where the tool already is", which is the
    /// Z-only convention when no plate position is declared.
    station: Option<(f64, f64)>,
}

/// Everything the X/Y half needs, resolved once so the two callers cannot
/// drift apart.
struct ProbeGeometry {
    /// Tool radius — the term an XY probe carries and a Z probe does not.
    radius_mm: f64,
    corner: ProbeCorner,
    wall_mm: f64,
    /// Absolute work Z the cutter descends to for the side passes, AFTER the Z
    /// datum has been set: the plate's top face is at `+top_mm`, so this is
    /// `top_mm - xy_depth_mm` and is normally negative.
    side_z_mm: f64,
    /// Where the plate is ON THE MACHINE and which way the tool stands off, derived
    /// from the workpiece's own placement. 🔴 Never a stored position: a plate that
    /// did not follow its workpiece is the defect this whole struct was rebuilt for.
    placement: CornerPlacement,
    /// The plate's top thickness — the corner plate's, not the machine's.
    top_mm: f64,
}

impl ProbeGeometry {
    fn z_probe(&self) -> ZProbe {
        ZProbe { top_mm: self.top_mm, station: Some((self.placement.x, self.placement.y)) }
    }
}

/// The machine's FIXED plate, which is what a Z-only probe references.
///
/// 🔴 FALLIBLE SINCE 2026-08-09 (decision #43 P0), and that is the whole change:
/// `machine.touch_plate_mm` is `Option<f64>`, `None` means NOBODY HAS DECLARED
/// IT, and an undeclared datum is REFUSED here — in the same error list as the
/// seven refusals in [`probe_geometry`] — rather than defaulted to a number.
/// It used to be `1.6`, unsourced, and it RAN.
///
/// The refusal is raised at POST time, before a single motion block is written
/// and long before anything is offered to a controller: `PostResult::ok()` is
/// false, so the CLI emits no G-code at all (gate G13) and the browser shows the
/// refusal instead of a program. There is no partial file to be run by mistake.
fn fixed_z_probe(machine: &Machine) -> Result<ZProbe, String> {
    let Some(top_mm) = machine.touch_plate_mm else {
        return Err(
            "a Z probe sets the datum every coordinate in this program is measured from, and \
             `machine.touch_plate_mm` is NOT DECLARED — the thickness between your plate's top \
             face and the workpiece top is a number only you can measure, and nothing near a \
             typical value exists (real plates run 5mm to 15.5mm, and the two this shop owns \
             publish nothing). Measure yours with calipers and enter it. If you are probing the \
             workpiece directly with no plate at all, enter 0 — that is a different answer from \
             leaving it blank, and it is the one that says so"
                .into(),
        );
    };
    // A negative thickness is not a measurement of anything. It is refused
    // rather than clamped: `0.0` already means "no plate", so there is nothing
    // for a negative value to have been trying to say.
    if top_mm < 0.0 {
        return Err(format!(
            "`machine.touch_plate_mm` is {top_mm}mm — a plate cannot be thinner than nothing, and \
             a negative top thickness puts work-zero BELOW the work top, which takes the safe-Z \
             retract down with it. Enter the measured thickness, or 0 for no plate"
        ));
    }
    Ok(ZProbe {
        top_mm,
        // 🔴 `0,0` KEEPS ITS MEANING: "probe where the tool already is". This is
        // the branch every existing machine definition takes, and it emits no
        // positioning move at all.
        station: (machine.probe_x != 0.0 || machine.probe_y != 0.0)
            .then_some((machine.probe_x, machine.probe_y)),
    })
}

/// Refusals that make an XYZ probe impossible to emit safely. Each names the
/// setting, because "probe refused" without the field is a support call.
///
/// 🔴 These are ERRORS, not warnings. A warning here would produce a runnable
/// file whose X and Y datums are wrong by an unknown amount — the exact failure
/// that is invisible in the preview.
fn probe_geometry(
    stock: &Stock,
    tool: &Tool,
) -> Result<ProbeGeometry, Vec<String>> {
    let mut errs = Vec::new();

    if tool.diameter_mm <= 0.0 {
        errs.push(format!(
            "an X/Y touch plate offset carries the TOOL RADIUS and the tool '{}' has diameter \
             {}mm — the radius is unknown, and guessing it displaces every coordinate in the \
             program by the error",
            tool.name, tool.diameter_mm
        ));
    }

    let Some(plate) = stock.corner_plate else {
        errs.push(
            "an X/Y touch plate needs the CORNER of the workpiece it is hooked over and \
             `stock.corner_plate` is not declared — the corner decides which way the tool drives \
             to meet the plate, and a program that assumes the wrong one drives the cutter INTO it"
                .into(),
        );
        return Err(errs);
    };

    // 🔴 THE FAILURE DIRECTION IS THE OPPOSITE OF THE OBVIOUS ONE, AND THIS
    // COMMENT SAID THE WRONG ONE UNTIL 2026-08-09 ("runs one plate thickness
    // deep"). The post emits `G10 L20 P1 Z<top_mm>` at the moment of contact
    // (see the emit below), and at contact the tip stands the plate's TRUE
    // thickness `T` above the work. Declaring `Z = top_mm` therefore puts
    // work-zero `T - top_mm` ABOVE the work top:
    //   top_mm < T  (UNDER-declared) -> zero too HIGH -> cuts SHALLOWER, in the
    //                limit entirely in the air. Scrapped part, nothing crashes.
    //   top_mm > T  (OVER-declared)  -> zero too LOW  -> cuts TOWARD THE
    //                SPOILBOARD, and the safe-Z retract is displaced down with
    //                it, so a rapid runs at a height the operator believes clear.
    // Confirmed at a primary source rather than left as arithmetic — Carbide 3D
    // community on the BitZero V2 measuring 13.1mm while the software assumes
    // 13.0: *"the virtual zero surface is now above the actual surface"*, i.e.
    // an under-declaration cuts SHALLOW.
    // <https://community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548>
    // (read 2026-08-09; full derivation in
    // `docs/decision-40-43-touchplate-ownership.md` §3.)
    // ⇒ THE CONSEQUENCE FOR ANY DEFAULT: a too-SMALL stored top fails safe, and a
    // plausible-looking catalogue figure that is too LARGE fails toward the
    // machine. A sourced default is therefore MORE dangerous here than an
    // obviously-unsourced small one — err small, never large.
    // ⚠ Only the stated reason changed. The refusal condition below is unchanged
    // and correct in either direction: an undeclared top is refused, full stop.
    if plate.plate.top_mm <= 0.0 {
        errs.push(
            "an X/Y corner plate needs its TOP thickness `corner_plate.top_mm` and it is not \
             declared — a zero top face zeroes Z at the PLATE's top face, which stands one plate \
             thickness ABOVE the workpiece, so every cut in the program runs one plate thickness \
             SHALLOW and in the limit entirely in the air. (The direction that reaches the \
             spoilboard is the opposite one: a top declared LARGER than the plate really is puts \
             work-zero BELOW the work top and takes the safe-Z retract down with it.)"
                .into(),
        );
    }
    // 🔴 THREE STATES, TWO REFUSALS, AND THEY ARE NOT THE SAME REFUSAL. An
    // undeclared wall sends a person to their calipers; a plate that HAS no wall
    // cannot be used this way at all, and telling them to measure it would send
    // them to measure a face that does not exist.
    let wall_mm = match plate.plate.wall {
        PlateWall::Mm(v) if v > 0.0 => v,
        PlateWall::NotPresent => {
            errs.push(
                "this corner plate has NO WALL (`corner_plate.wall` is NotPresent) — it \
                 references X and Y through a bore or a chamfer, and the corner routine drives \
                 against an outer face it does not have. Bore probing is a different operation \
                 and is NOT implemented"
                    .into(),
            );
            0.0
        }
        _ => {
            errs.push(
                "an X/Y touch plate offset carries the plate's WALL thickness and \
                 `corner_plate.wall_mm` is not declared — `top_mm` is the TOP thickness and is a \
                 different number; using it for X and Y displaces the program by the difference"
                    .into(),
            );
            0.0
        }
    };
    if plate.xy_depth_mm <= 0.0 {
        errs.push(
            "an X/Y touch plate needs `corner_plate.xy_depth_mm`, how far BELOW the plate's top \
             face the cutter descends before probing sideways — at or above the top face it \
             passes over the plate, touches nothing, and the seek runs to its bound"
                .into(),
        );
    }
    // 🔴 A side probe runs along a MACHINE axis. On a workpiece laid at a free angle
    // the edge the plate registers against is not perpendicular to that axis, so
    // the pass measures a slanted face and the datum is wrong by an amount that
    // grows with the workpiece. The planner elsewhere only WARNS about a free angle,
    // because a jig makes it a real placement; here it cannot be run at all.
    if !stock.is_square_to_the_bed() {
        errs.push(format!(
            "an X/Y corner plate needs the workpiece square to the machine's axes and this one is laid at \
             {}deg — a side probe travels along a machine axis, so against an edge at an angle \
             it measures a slanted face and sets a datum that is wrong by an unknown amount",
            fmt(stock.rotation_deg, 3)
        ));
    }

    if !errs.is_empty() {
        return Err(errs);
    }
    Ok(ProbeGeometry {
        radius_mm: tool.radius_mm(),
        corner: plate.corner,
        wall_mm,
        side_z_mm: plate.plate.top_mm - plate.xy_depth_mm,
        placement: stock.corner_placement(plate.corner),
        top_mm: plate.plate.top_mm,
    })
}

/// Emit one complete probe block.
///
/// 🔴 ONE EMITTER, TWO CALLERS. The preamble datum probe and the after-a-tool-
/// change re-reference used to be two copies of the same fifteen lines, and a
/// copy is where a safety property goes to rot: the `M5` added to one would not
/// have reached the other.
///
/// `geom` is `None` for the re-reference, and that is CORRECT rather than an
/// omission: `G10 L20` writes a property of the WORKPIECE, and a new tool does
/// not move the workpiece. Only the tool LENGTH changed, so only Z is stale. Re-
/// probing X and Y after a tool change would also be measuring the new tool's
/// radius against a datum that is already right. The `z` argument is the SAME
/// resolved plate either way, so the re-reference cannot measure a different one.
fn emit_probe(
    g: &mut String,
    machine: &Machine,
    stock: &Stock,
    opts: &PostOptions,
    z: &ZProbe,
    geom: Option<&ProbeGeometry>,
) {
    let d = opts.decimals;
    let safe_z = stock.z_datum.emit_z(machine.safe_z_mm, stock);

    macro_rules! c {
        ($s:expr) => {
            if opts.emit_comments {
                g.push_str("( ");
                g.push_str(&sanitize($s));
                g.push_str(" )\n");
            }
        };
    }

    // 🔴 M5 FIRST, ALWAYS, AND EVEN WHEN THE SPINDLE IS ALREADY OFF. A probe
    // with the spindle running does not measure anything — the cutter's edge
    // sweeps the plate on the way in, so contact fires early, at a radius that
    // is not the radius, and the plate, the cutter or both are destroyed. The
    // "already off" case is exactly the one to keep: this is the program
    // ASSERTING the state, not the planner remembering it, and an M5 that costs
    // one line is not worth trading for an assumption about what ran before.
    g.push_str("M5\n");
    // Any tool length offset in force would shift what the probe measures.
    g.push_str("G49\n");
    g.push_str(&format!("G0 Z{}\n", fmt(safe_z, d)));
    // Where the plate IS. For a fixed plate that is a machine position; for a
    // corner plate it is the workpiece's own corner, resolved through the workpiece's
    // placement — so a moved or turned workpiece moves this line with it.
    if let Some((px, py)) = z.station {
        g.push_str(&format!("G0 X{} Y{}\n", fmt(px, d), fmt(py, d)));
    }

    // ---- Z, from the plate's TOP face (tip contact, no radius term) --------
    //
    // 🔴 INCREMENTAL, FOR THE SAME REASON `axis_pass` IS. Both Z values below
    // are TRAVELS — `probe_max_mm` and `probe_retract_mm * 2.0`, the two
    // distances `probe_travel_errors` refuses when they are not positive. Until
    // 2026-08-10 they were emitted with `G90` still in force, so grblHAL read
    // them as absolute work coordinates (the `G91` APPLIES TO `G38.2` note
    // above cuts both ways: the parser applies the distance mode to probing
    // motion like any other motion). That made the probe depend on the datum it
    // exists to establish — with a stale G54 Z the slow re-probe is a move AWAY
    // from the plate (ALARM:5, datum unset, machine locked), or start == target
    // (error:33). It was correct only when Z was already roughly zeroed by
    // hand, which is exactly the case that hides it.
    //
    // One `G91` opens, every travel sits inside it, one `G90` closes — and the
    // `G10` that follows is deliberately OUTSIDE, because `G10 L20 P1 Z` takes
    // a COORDINATE (the work Z the tip is to read at this position), not a
    // distance. The absolute `G0 Z<safe_z>` after it is valid for the first
    // time in the block: the datum it is measured from was set one line above.
    c!("Z from the plate top face");
    g.push_str("G91\n");
    g.push_str(&format!(
        "G38.2 Z-{} F{}\n",
        fmt(machine.probe_max_mm, d),
        fmt(machine.probe_seek_feed, 1)
    ));
    g.push_str(&format!("G0 Z{}\n", fmt(machine.probe_retract_mm, d)));
    g.push_str(&format!(
        "G38.2 Z-{} F{}\n",
        fmt(machine.probe_retract_mm * 2.0, d),
        fmt(machine.probe_feed, 1)
    ));
    g.push_str("G90\n");
    g.push_str(&format!("G10 L20 P1 Z{}\n", fmt(z.top_mm, d)));
    g.push_str(&format!("G0 Z{}\n", fmt(safe_z, d)));

    let Some(geom) = geom else {
        return;
    };

    // ---- X and Y, from the plate's WALL (side contact, radius term) --------
    //
    // Every move from here is INCREMENTAL, so the sequence needs no absolute
    // coordinate and runs from wherever the operator jogged. The one exception
    // is the X station for the Y pass, which is deliberately absolute — see
    // below.
    //
    //   sign = +1 when the plate is on the MAX side of that MACHINE axis, -1 on
    //          the min side. 🔴 It comes from `Stock::corner_placement`, not from
    //          `ProbeCorner::x_sign` — the corner names a side of the WORKPIECE, and
    //          a quarter turn puts the workpiece's left edge at the machine's front.
    //          It carries the entire geometry: stand off in `sign`, probe back in
    //          `-sign`, and the datum lands at `corner + sign * (wall + radius)`.
    //
    //   stand-off  = wall + radius + probe_max, measured OUTBOARD from the
    //                corner, so the descent happens over air rather than on top
    //                of the plate.
    //   seek       = that whole distance back in, so contact is expected after
    //                `probe_max` of travel with `wall + radius` of margin left.
    //                Bounded: no contact within it raises ALARM:5 and stops.
    //
    //   🔴 THE DATUM IS OFFSET BY WHERE THE CORNER ACTUALLY IS. The program's
    //   coordinates already carry the workpiece's placement (`plan_job` runs every
    //   vertex through `Stock::place`), so writing the corner as 0 would claim
    //   the workpiece is at the machine datum whatever the setup says — and every
    //   coordinate would be displaced by the origin offset, invisibly.
    let reach = geom.wall_mm + geom.radius_mm + machine.probe_max_mm;
    let datum = geom.wall_mm + geom.radius_mm;
    let (corner_x, corner_y) = (geom.placement.x, geom.placement.y);

    let axis_pass = |g: &mut String, axis: char, sign: f64, at: f64, note: &str| {
        if opts.emit_comments {
            g.push_str("( ");
            g.push_str(&sanitize(note));
            g.push_str(" )\n");
        }
        // Stand off outboard, at safe Z, then descend BESIDE the plate.
        g.push_str("G91\n");
        g.push_str(&format!("G0 {axis}{}\n", fmt(sign * reach, d)));
        g.push_str("G90\n");
        // 🔴 NO DATUM SHIFT HERE, AND THAT IS NOT AN OMISSION. `side_z_mm` is
        // `top_mm - xy_depth_mm` — an ABSOLUTE work Z in the frame the
        // `G10 L20 P1 Z<top_mm>` three lines above just established. Adding an
        // offset to it while `top_mm` carried none is what `PostOptions::
        // z_offset_mm` did until 2026-08-11: under a bottom datum the descent
        // became `top_mm - xy_depth + thickness` against a datum set at
        // `top_mm`, so the tool descended one full thickness too high, the side
        // seeks swept air for their whole `reach`, and the program ended in
        // ALARM:5 with the datum half-set. (`docs/design-76-run-tab.md` F2,
        // recorded as underivable; `docs/design-87-z-datum.md` §4.3 derives it.)
        //
        // ⚠ What the CORRECT value is under a bottom datum depends on which
        // surface the plate rests on, which is an OPEN FOUNDER DECISION
        // (design-87 §3). So this arm does not guess: `post_grblhal` REFUSES an
        // XYZ probe under `ZDatum::SpoilboardTop` outright, and this line is
        // therefore only ever evaluated with the datum at the workpiece top.
        g.push_str(&format!("G0 Z{}\n", fmt(geom.side_z_mm, d)));
        // Two stages, per axis — grblHAL's own seek/slow shape, kept because it
        // is what makes the reading repeatable rather than a first-touch guess.
        g.push_str("G91\n");
        g.push_str(&format!(
            "G38.2 {axis}{} F{}\n",
            fmt(-sign * reach, d),
            fmt(machine.probe_seek_feed, 1)
        ));
        g.push_str(&format!("G0 {axis}{}\n", fmt(sign * machine.probe_retract_mm, d)));
        g.push_str(&format!(
            "G38.2 {axis}{} F{}\n",
            fmt(-sign * machine.probe_retract_mm * 2.0, d),
            fmt(machine.probe_feed, 1)
        ));
        g.push_str("G90\n");
        // 🔴 THE RADIUS TERM. At contact the tool CENTRE sits one radius short
        // of the plate face, and the plate face sits one wall thickness short of
        // the workpiece edge. Both are on the same side, so they add — and the
        // whole thing is measured from where that edge actually is on the machine.
        g.push_str(&format!("G10 L20 P1 {axis}{}\n", fmt(at + sign * datum, d)));
        // Clear the wall before lifting, so the flank does not drag on it.
        g.push_str("G91\n");
        g.push_str(&format!("G0 {axis}{}\n", fmt(sign * machine.probe_retract_mm, d)));
        g.push_str("G90\n");
        g.push_str(&format!("G0 Z{}\n", fmt(safe_z, d)));
    };

    axis_pass(
        g,
        'X',
        geom.placement.x_sign,
        corner_x,
        &format!("X from the plate wall, {}", geom.corner.label()),
    );

    // The Y pass has to stand somewhere in X that is still over the plate. The
    // declared plate position is no longer expressible — the X pass just moved
    // the X frame under it — but the WORKPIECE CORNER now is, exactly, at
    // `corner_x`, and the plate is hooked over that corner by definition. So this
    // one move is absolute, in the frame the X pass established one line earlier.
    g.push_str(&format!("G0 X{}\n", fmt(corner_x, d))); // already in G90 — `axis_pass` restores it
    axis_pass(
        g,
        'Y',
        geom.placement.y_sign,
        corner_y,
        &format!("Y from the plate wall, {}", geom.corner.label()),
    );
}

/// Refusals about the two probe DISTANCES. See [`probe_feed_errors`] for the two
/// probe FEEDS — they are separate functions because they were separate gaps,
/// and a single name covering both would make the older one's scope unreadable.
///
/// Both refusals here come straight from grbl's parser: a probe block with no
/// travel is `STATUS_GCODE_INVALID_TARGET`, which halts the program at the
/// controller with the datum unset.
fn probe_travel_errors(machine: &Machine) -> Vec<String> {
    let mut errs = Vec::new();
    if machine.probe_max_mm <= 0.0 {
        errs.push(
            "`probe_max_mm` is not positive — a G38.2 whose target is the current position is \
             rejected by the controller (STATUS_GCODE_INVALID_TARGET), so no datum is set"
                .into(),
        );
    }
    if machine.probe_retract_mm <= 0.0 {
        errs.push(
            "`probe_retract_mm` is not positive — the slow re-probe would have nowhere to travel \
             from and the controller rejects it (STATUS_GCODE_INVALID_TARGET)"
                .into(),
        );
    }
    errs
}

/// Refusals about the two probe FEEDS — the gap
/// [`crate::feeds::FeedRole::Probing`] named on 2026-08-11 and did not close.
///
/// 🔴 **A PROBE FEED IS EXEMPT FROM THE CUTTING CEILING, NOT FROM EVERYTHING.**
/// The feed is what decides whether the tip stops ON contact or drives THROUGH
/// it, and the worst outcome is not the bent cutter — it is a **false Z that is
/// then used as the datum for every cut in the program**, because the operator
/// is handed a number rather than an alarm. This lane's Z0 sits on the workpiece
/// underside / spoilboard top, so a probe result is not a convenience: it is the
/// origin the whole program is written against.
///
/// 🔴 **IT IS CHECKED HERE BECAUSE THIS IS THE ONLY DOOR.** `emit_probe` is
/// called from `post_grblhal` and nowhere else, and `post_grblhal` is the only
/// thing in this crate that writes a `G38.` word — `rect_profile` (the fixture
/// generator) emits no probe at all, and there is no second post. So one call
/// site here covers `fixture`, `job`, `import`, `nest`, the browser and any host
/// added later; a check placed on a host would have been door-asymmetric by
/// construction, which is the defect that kept the plunge invisible.
///
/// ⚠ **Inside `probe_enabled` on purpose.** A machine that is not probing emits
/// no `G38.2`, so its probe feeds reach nothing and refusing on them would be a
/// false red on every non-probing job — the shape that gets a control switched
/// off.
///
/// The judgement itself is [`crate::feeds::probe_feed_faults`], beside every
/// other verdict about a feed against a limit, so the derivation of **why no
/// absolute probing ceiling is invented** lives once, next to the constants it
/// is about.
fn probe_feed_errors(machine: &Machine) -> Vec<String> {
    crate::feeds::probe_feed_faults(
        machine.probe_seek_feed,
        machine.probe_feed,
        machine.rapid_mm_min,
    )
    .iter()
    .map(|f| f.why())
    .collect()
}

pub fn post_grblhal(
    path: &Toolpath,
    machine: &Machine,
    stock: &Stock,
    op: &OperationParams,
    opts: &PostOptions,
) -> PostResult {
    let mut res = PostResult::default();
    let mut g = String::new();

    if path.is_empty() {
        res.errors.push("empty toolpath — nothing to post".into());
        return res;
    }

    // 🔴 NO NON-FINITE NUMBER MAY BECOME A G-CODE WORD, AND THE CHECK IS FIRST
    // BECAUSE THE REFUSAL IS TOTAL.
    //
    // A NaN coordinate is not a bad number, it is the ABSENCE of one, and
    // grblHAL's response to `G1 XNaN YNaN` is unspecified — with a 2.2 kW
    // spindle turning, "unspecified" is the one state an operator standing at
    // the machine cannot plan around. So this returns before a single byte is
    // written: per gate G13 a refused program emits NO G-code at all, which
    // leaves nothing for a hurried person to drag into a sender.
    //
    // ⚠ It is scanned FRESH off `path.moves` rather than read from
    // `Toolpath::nonfinite_moves`, because that field is whatever the last
    // `recompute_bounds` saw and `job.rs` appends moves after planning. A stale
    // clean record reads exactly like a clean path.
    if let Some((i, m)) = path.first_nonfinite_move() {
        res.errors.push(format!(
            "move {i} ({:?}) has a non-finite destination (X{} Y{} Z{}) — a coordinate that is \
             not a number must never be streamed to a controller, so NO program is written. \
             This is a CAM defect: report it rather than editing the file by hand",
            m.kind, m.to.x, m.to.y, m.to.z
        ));
        return res;
    }

    // A file that cannot be run is worse than no file, so limit violations are
    // fatal here rather than advisory.
    res.errors.extend(check_machine_limits(path, machine));
    res.errors.extend(check_emitted_z_ceiling(path, machine, stock));
    res.errors.extend(check_stock_depth(path, stock, SPOILBOARD_ALLOWANCE_MM));

    // 🔴 `spindle_reverse` IS REFUSED, NOT IGNORED. This post emits M3 —
    // clockwise — and nothing else. A machine set to run reversed and handed an
    // M3 program does not merely spin the other way: the whole toolpath was
    // wound so the material sits on the tool's RIGHT for a clockwise cutter
    // (see `toolpath.rs`), so every climb cut becomes a conventional one and
    // every conventional cut a climb. The finish changes, the deflection
    // changes direction, and on a tabbed through-profile a climbing cut that
    // was planned as conventional can snatch the part.
    //
    // Emitting M3 anyway is the shape of defect this lane exists to stop: a
    // setting read by nothing reads as honoured. Implement M4 with the winding
    // inverted, or refuse. Until the first exists, this refuses.
    if machine.spindle_reverse {
        res.errors.push(
            "machine sets spindle_reverse, and this post emits M3 (clockwise) only — reverse \
             is NOT implemented, and it would also invert every climb/conventional decision \
             already baked into these coordinates"
                .into(),
        );
    }

    let d = opts.decimals;

    // 🔴 THE SEAM BETWEEN THE TWO Z FRAMES, RESOLVED ONCE AND NAMED.
    //
    // Everything handed to this function is workpiece-top-local: `path.moves`,
    // `machine.safe_z_mm`, the peck depths. Everything written out of it is in
    // the frame the operator declared. `ez` is the ONLY conversion, and
    // `z_off` is the same conversion for the one site that needs the shift as a
    // number rather than as a value (`axis_words`, which decides modally whether
    // to write a Z word at all and so must compare in the plan frame).
    //
    // A forgotten site is one Z word that did not move; a doubled site is one
    // that moved twice. Both are findable because there is one function to grep
    // for — which was the entire argument for translating at the post rather
    // than re-datuming the planner (`docs/design-87-z-datum.md` §4.2).
    let datum = stock.z_datum;
    let z_off = datum.emit_offset_mm(stock);
    let ez = |plan_z_mm: f64| datum.emit_z(plan_z_mm, stock);

    macro_rules! comment {
        ($s:expr) => {
            if opts.emit_comments {
                g.push_str("( ");
                g.push_str(&sanitize($s));
                g.push_str(" )\n");
            }
        };
    }

    // ---- preamble ----------------------------------------------------------
    comment!(&opts.program_name);
    comment!("post: grblHAL dialect. Cutter comp is NOT used (G41/G42 absent from grblHAL core);");
    comment!("all tool-radius offsets are already applied to these coordinates.");
    comment!(&format!(
        "tool: {} D{}mm F{}",
        path.tool.name,
        fmt(path.tool.diameter_mm, 2),
        path.tool.flutes
    ));

    g.push_str("G17"); // XY plane
    g.push_str(if opts.metric { " G21" } else { " G20" }); // units
    g.push_str(if opts.absolute { " G90" } else { " G91" }); // distance mode
    g.push_str(&format!(" G{}", opts.work_offset)); // work offset
    g.push_str(" G94"); // feed = units/min
    g.push_str(" G40"); // cutter comp explicitly OFF
    g.push('\n');

    // Retract before anything moves in XY.
    g.push_str(&format!("G0 Z{}\n", fmt(ez(machine.safe_z_mm), d)));

    // ---- touch plate -------------------------------------------------------
    // See the block comment above `ProbeGeometry` for every dialect fact this
    // sequence rests on and the published source each was verified at.
    //
    // 🔴 THIS SITS HERE, BEFORE THE BODY, BECAUSE THE PROBE ESTABLISHES THE
    // ORIGIN EVERY LATER COORDINATE IS MEASURED FROM. Emitted after the first
    // cut it would set a datum for work already done, and the part cut before it
    // is scrap referenced to nothing. `audit_probe_order` re-asserts that on the
    // finished text rather than trusting this position in the function.
    //
    // 🔴 RESOLVED HERE, USED TWICE. `z_probe` is also what the after-a-tool-change
    // re-reference in the body emits, so the two cannot end up describing
    // different plates. `None` means the probe was REFUSED, and the re-reference
    // refuses with it rather than quietly falling back to the machine's fixed
    // plate — a fallback there would re-zero Z against a thickness nobody
    // declared for this setup.
    let mut z_probe: Option<ZProbe> = None;
    if machine.probe_enabled {
        // 🔴 THE NUMBERS EVERY PROBE BLOCK IS BUILT FROM, CHECKED BEFORE ONE IS
        // WRITTEN — the two distances and the two feeds, and OUTSIDE the plate
        // match so that `ZOnly` and `Xyz` are covered by one call. An `Xyz`
        // probe emits the same feed pair three times over (once on Z, once per
        // side pass), so a check written inside either arm would have exempted
        // the door that emits the most probing motion.
        //
        // ⚠ **AND THE REFUSAL SUPPRESSES THE EMISSION, which is a fix to the
        // DISTANCE half as well.** `probe_travel_errors` has been pushing an
        // error and letting the block be written since it was added: a
        // `probe_max_mm` of 0 produced `res.ok() == false` *and* a `res.gcode`
        // containing `G38.2 Z-0.000 F200.0`. The CLI never showed it (gate G13
        // prints nothing on a refusal), so the only thing standing between that
        // text and a machine was every host remembering to check `ok()` —
        // "refused" and "emitted anyway" are not two facts a program should
        // carry at once. Every other refusal on this path (`fixed_z_probe`,
        // `probe_geometry`, the bottom-datum arm) already produced no probing
        // moves at all, and four tests assert exactly that; this makes the
        // remaining two refusals behave like their neighbours instead of being
        // the two that do not.
        let setting_errors: Vec<String> =
            probe_travel_errors(machine).into_iter().chain(probe_feed_errors(machine)).collect();
        let settings_ok = setting_errors.is_empty();
        res.errors.extend(setting_errors);
        match machine.probe_plate {
            // A refused SETTING emits no probe of either kind, and leaves
            // `z_probe` as `None` so the after-a-tool-change re-reference
            // refuses with it rather than re-zeroing against the same bad
            // numbers further down the program.
            _ if !settings_ok => {}
            // 🔴 Refused, not defaulted — the same shape as the XYZ arm below.
            // An undeclared plate thickness produces NO probe and no program;
            // the alternative was a number nobody measured setting the origin
            // every later coordinate is taken from.
            ProbePlate::ZOnly => match fixed_z_probe(machine) {
                Ok(z) => {
                    comment!("Z zero from touch plate (Z only — this plate references no X or Y)");
                    emit_probe(&mut g, machine, stock, opts, &z, None);
                    z_probe = Some(z);
                }
                Err(e) => res.errors.push(e),
            },
            // 🔴 AN XYZ PROBE UNDER A BOTTOM DATUM IS REFUSED, NOT TRANSLATED,
            // AND THE REFUSAL LANDS IN THE SAME CHANGE THAT MAKES THE COMBINATION
            // REACHABLE.
            //
            // Until 2026-08-11 this pairing could not be reached: the only route
            // to a bottom datum was the CLI's `--spoilboard-zero`, which the
            // `fixture` subcommand reads and which refuses `--config` by name, so
            // no corner plate could be declared alongside it. Moving the datum
            // onto `Stock` closes that gap — `job <name> --config <bottom.json>`
            // now reaches both at once — and what it would emit is the ALARM:5
            // program described at the `side_z_mm` site above.
            //
            // The correct side descent is `<whatever G10 L20 P1 Z writes> -
            // xy_depth_mm`, and what that G10 writes under a bottom datum
            // depends on which surface the plate rests on: the spoilboard beside
            // the workpiece, the workpiece top, or a bare board with no plate.
            // That is a physical decision about the shop, it is the founder's,
            // and it is open (`docs/design-87-z-datum.md` §3). Refusing costs a
            // setup; guessing costs the datum on all three axes.
            ProbePlate::Xyz if stock.z_datum == ZDatum::SpoilboardTop => {
                res.errors.push(
                    "this setup zeroes Z on the SPOILBOARD and asks for an XYZ corner-plate \
                     probe, and the two cannot both be emitted yet. The X/Y passes descend \
                     beside the plate to a Z derived from the plate's own top face, so where \
                     that descent lands depends on WHAT THE PLATE IS RESTING ON — the \
                     spoilboard beside the workpiece, or the workpiece top — and nothing in \
                     this model records that. Emitting it anyway would descend one workpiece \
                     thickness too high, sweep air for the whole seek and halt on ALARM:5 with \
                     the Z datum set and X and Y unset. Use a Z-only probe with this datum, or \
                     zero Z on the workpiece top, until the plate's reference surface is a \
                     declared setting (design-87 §3, awaiting a founder ruling)"
                        .into(),
                );
            }
            ProbePlate::Xyz => match probe_geometry(stock, &path.tool) {
                Ok(geom) => {
                    comment!(&format!(
                        "XYZ touch plate on the {} corner of the WORKPIECE: top {}mm -> Z, wall \
                         {}mm -> X and Y",
                        geom.corner.label(),
                        fmt(geom.top_mm, 2),
                        fmt(geom.wall_mm, 2)
                    ));
                    comment!(&format!(
                        "that corner sits at X{} Y{} in machine coordinates with this workpiece placement — the \
                         plate follows the workpiece, so moving or turning the workpiece moves it",
                        fmt(geom.placement.x, 3),
                        fmt(geom.placement.y, 3)
                    ));
                    comment!(&format!(
                        "the X and Y datums below carry the tool radius {}mm — an X/Y probe \
                         touches with the SIDE of the cutter, a Z probe with the tip",
                        fmt(geom.radius_mm, 3)
                    ));
                    let z = geom.z_probe();
                    emit_probe(&mut g, machine, stock, opts, &z, Some(&geom));
                    z_probe = Some(z);
                }
                // 🔴 Refused, not degraded to a Z-only probe. Silently dropping
                // to Z would leave X and Y referenced to wherever the operator
                // happened to jog, while the program CLAIMS a corner datum — the
                // failure looks identical to success until the part is scrap.
                Err(errs) => res.errors.extend(errs),
            },
        }
    }

    // ---- body --------------------------------------------------------------
    //
    // 🔴 ONE attribution, indexed — never a second walk of the moves. This is
    // the same vector `Report::render` labels its points from, so the program
    // view and the picture cannot end up naming different operations for the
    // same cut. Computed once here rather than per move because it is a single
    // pass and re-running it per arm would be the second derivation this whole
    // struct exists to avoid.
    let origins = crate::toolpath::attribute_moves(path);
    let mut blocks: Vec<EmittedBlock> = Vec::new();
    // Lines already in the preamble/probe. Counted off the text rather than
    // tallied as it was written: the text is the thing being described, and a
    // counter incremented by hand drifts the first time a `push_str` carries
    // two newlines.
    let mut line_no = g.matches('\n').count();

    let mut last_feed = -1.0_f64;
    let mut spindle_running = false;
    let mut spindle_off_reported = false;
    let mut spindle_pwm_reported = false;
    let mut cur = Vec3::new(f64::NAN, f64::NAN, f64::NAN);

    // Modal suppression: a word equal to the current position is omitted. NaN
    // means "position unknown", which must emit the word rather than assume it.
    fn axis_words(cur: &Vec3, p: &Vec3, d: usize, z_off: f64) -> String {
        let mut s = String::new();
        if cur.x.is_nan() || !near_eq(cur.x, p.x) {
            s.push_str(&format!(" X{}", fmt(p.x, d)));
        }
        if cur.y.is_nan() || !near_eq(cur.y, p.y) {
            s.push_str(&format!(" Y{}", fmt(p.y, d)));
        }
        if cur.z.is_nan() || !near_eq(cur.z, p.z) {
            s.push_str(&format!(" Z{}", fmt(p.z + z_off, d)));
        }
        s
    }

    for (mi, m) in path.moves.iter().enumerate() {
        let block_start = g.len();
        // Set by the arms that command motion at a feed. Left `None` by every
        // arm that does not — a rapid, a dwell, a tool change — because a feed
        // written on a move that carries none is a rate somebody invented.
        let mut block_feed: Option<f64> = None;

        // 🔴 A LABELLED BLOCK, NOT `continue`. Four arms below give up early,
        // and one of them (an arc degraded to a chord) has already WRITTEN its
        // lines by then. A `continue` there would jump the accounting at the
        // bottom, so that program's chord would be missing from `blocks` and
        // every later line number would be off by one — a map of the file that
        // is right at the top and silently wrong after the first degraded arc.
        // `break 'emit` leaves the arm and still lands on the accounting.
        'emit: {
        match m.kind {
            MoveKind::Comment => {
                comment!(&m.text);
            }

            MoveKind::SpindleOn => {
                // 🔴 `M3 S0` IS REFUSED, AND IT USED TO BE THE ONE SPEED NOTHING
                // CHECKED (2026-08-30).
                //
                // Every test below sat inside `if m.value > 0.0`, so the guard
                // excluded exactly the value it most needed to catch: a
                // `SpindleOn` of zero skipped the band check, the ceiling check
                // and the cutter's rating, and the post emitted `M3 S0` with no
                // spindle comment of any kind. Measured through the real door
                // (`job plate --config '{"op":{"rpm":0}}'`): **exit 0, 11,700
                // bytes, `M3 S0` on line 21**, `ok: true`.
                //
                // The feed notes DID fire — "the emitted feed delivers 0.000mm of
                // chip per tooth … it rubs" — but a warning above a runnable
                // program is a program that gets run, which is `MULTI`'s own
                // wording. On a VFD spindle `S0` does not turn, and the machine
                // then feeds the cutter through 18mm of ply: a snapped tool and a
                // workpiece nobody is holding.
                //
                // ⚠ Same shape as #147 and #148 — a guard whose PRECONDITION
                // excludes the case it exists for. There it was `f64::min`
                // swallowing NaN and comparisons that are false for NaN; here it
                // is `> 0.0` swallowing zero.
                if m.value <= 0.0 {
                    res.errors.push(format!(
                        "the program commands the spindle ON at {} rpm — `M3 S{}`. A spindle at \
                         zero does not turn, and the cutting moves that follow feed the tool \
                         through the material anyway: the cutter snaps and the workpiece is loose. \
                         Set a speed inside the spindle's band, or do not start the spindle",
                        fmt(m.value, 0),
                        fmt(m.value, 0)
                    ));
                }
                // The spindle's range and the cutter's rating are both real
                // limits, and they are different limits.
                if m.value > 0.0 {
                    if m.value < machine.spindle_min_rpm {
                        res.warnings.push(
                            "requested spindle speed is below the spindle's minimum — a VFD \
                             spindle stalls or loses torque here"
                                .into(),
                        );
                    }
                    if m.value > machine.spindle_max_rpm {
                        res.warnings
                            .push("requested spindle speed exceeds the spindle's maximum".into());
                    }
                    if path.tool.rpm_max > 0.0 && m.value > path.tool.rpm_max {
                        res.warnings.push(
                            "requested spindle speed exceeds the cutter's rated maximum".into(),
                        );
                    }
                }
                // 🔴 `spindle_pwm` is a CAPABILITY, and S on a machine without
                // it is a word the controller accepts and cannot act on. The
                // operator has to set the VFD by hand, so the program says so
                // once — silently emitting S would let a 24,000 rpm dial cut a
                // job planned at 9,000 and the feed would be wrong by the same
                // factor. Said once, not per M3: a warning repeated per tool
                // change is a warning people learn to scroll past.
                if !machine.spindle_pwm && !spindle_pwm_reported {
                    res.warnings.push(format!(
                        "this machine has no spindle PWM: S{} is emitted but the controller \
                         cannot set the speed — set the VFD to {} rpm by hand before running",
                        fmt(m.value, 0),
                        fmt(m.value, 0)
                    ));
                    spindle_pwm_reported = true;
                }
                g.push_str(&format!("M3 S{}\n", fmt(m.value, 0)));
                spindle_running = true;
                // 🔴 The dwell is not politeness. A 2.2 kW VFD spindle takes
                // seconds to reach speed; the first cutting move after M3 with
                // no G4 engages a cutter turning at a fraction of the planned
                // rpm, which is a chipload several times what the tool is rated
                // for — it stalls, it burns the edge, or it snaps.
                if machine.spindle_spinup_s > 0.0 {
                    g.push_str(&format!("G4 P{}\n", fmt(machine.spindle_spinup_s, 2)));
                }
            }

            MoveKind::SpindleOff => {
                g.push_str("M5\n");
                spindle_running = false;
            }

            MoveKind::ToolChange => {
                // Order is a safety property, not a style choice:
                //   retract  -> the operator's hands go near the cutter
                //   M5       -> a spinning cutter during a manual change is how
                //               fingers are lost
                //   comment  -> tells them WHICH tool to fit; "M0" alone makes
                //               them guess, and a guess here cuts the wrong part
                //   M0       -> the actual pause
                // The spindle is deliberately NOT restarted here. The caller
                // emits SpindleOn afterwards, so the rpm belongs to the new
                // tool rather than being inherited from the old one.
                g.push_str(&format!("G0 Z{}\n", fmt(ez(machine.safe_z_mm), d)));
                if spindle_running {
                    g.push_str("M5\n");
                    spindle_running = false;
                }
                comment!(&format!("TOOL CHANGE -> {}", m.text));
                g.push_str("M0\n");
                // Z is now unknown: a new tool has a different length. Position
                // is invalidated so the next move re-emits every axis word
                // rather than assuming the machine is where it was.
                cur = Vec3::new(f64::NAN, f64::NAN, f64::NAN);
                last_feed = -1.0;
            }

            MoveKind::ClampChange => {
                // 🔴 THE SAME ORDER AS A TOOL CHANGE — safety, not style:
                //   retract  -> the operator's hands go near the clamps
                //   M5       -> a spinning cutter while someone moves a clamp
                //               is how clamps and cutters are destroyed
                //   comment  -> tells them WHAT TO DO (which phase, which
                //               clamps); "M0" alone makes them guess
                //   M0       -> the actual pause
                //
                // DIFFERENT PHYSICS from a tool change: the work-holding is
                // changing, and the instruction is "new clamp on before old
                // clamp off" or the part is loose mid-program. After this
                // pause, Z MUST be re-referenced because the part may have
                // shifted.
                g.push_str(&format!("G0 Z{}\n", fmt(ez(machine.safe_z_mm), d)));
                if spindle_running {
                    g.push_str("M5\n");
                    spindle_running = false;
                }
                comment!(&format!("CLAMP CHANGE -> {}", m.text));
                g.push_str("M0\n");
                // Z and XY are now unknown: the work-holding changed and the
                // part may have moved. Invalidate everything.
                cur = Vec3::new(f64::NAN, f64::NAN, f64::NAN);
                last_feed = -1.0;
            }

            MoveKind::Probe => {
                if !machine.probe_enabled {
                    // 🔴 Not silent. A probe was asked for and cannot be done;
                    // proceeding would leave Z referenced to the PREVIOUS tool.
                    res.errors.push(
                        "a Z re-reference was requested but the machine has no probe —                          Z would stay referenced to the previous tool's length"
                            .into(),
                    );
                    break 'emit;
                }
                // 🔴 The SAME plate the datum came from. A refused touch plate
                // has no plate to re-reference against, and falling back to the
                // machine's fixed one would re-zero Z on a thickness that
                // describes a different device.
                let Some(z) = z_probe.as_ref() else {
                    res.errors.push(
                        "a Z re-reference was requested but the touch plate was REFUSED above — \
                         there is no declared plate to measure against, and Z would stay \
                         referenced to the previous tool's length"
                            .into(),
                    );
                    break 'emit;
                };
                // Z ONLY, deliberately — see `emit_probe`. A tool change moves
                // the tool's length, not the workpiece, so X and Y are still
                // right and re-probing them would measure the new tool's radius
                // against a datum that already holds.
                comment!("re-reference Z from the touch plate (Z only: a new tool is a new LENGTH)");
                emit_probe(&mut g, machine, stock, opts, z, None);
                // The probe emitted M5. If the caller does not restart the
                // spindle, the next cutting move trips the "spindle is off"
                // error below — which is the correct loud failure, not silence.
                spindle_running = false;
                cur = Vec3::new(f64::NAN, f64::NAN, machine.safe_z_mm);
            }

            MoveKind::Dwell => {
                g.push_str(&format!("G4 P{}\n", fmt(m.value, 2)));
            }

            MoveKind::Rapid => {
                let w = axis_words(&cur, &m.to, d, z_off);
                if !w.is_empty() {
                    g.push_str("G0");
                    g.push_str(&w);
                    g.push('\n');
                }
                cur = m.to;
            }

            MoveKind::Feed => {
                // 🔴 DIVERGENCE FROM THE FORK, deliberate: the fork made this a
                // warning. Feeding a stationary cutter into ply does not produce
                // a poor finish, it snaps the tool or stalls the gantry — a
                // physical failure, so it is fatal here. A cutting process that
                // legitimately has no spindle (drag knife, laser) is a different
                // post, not a warning on this one.
                //
                // Latched: one report, not one per move. A hundred identical
                // lines is how a real second finding gets scrolled off.
                if !spindle_running && !spindle_off_reported {
                    res.errors.push("cutting move emitted while the spindle is off".into());
                    spindle_off_reported = true;
                }
                block_feed = if m.feed > 0.0 {
                    Some(m.feed)
                } else if last_feed > 0.0 {
                    Some(last_feed)
                } else {
                    None
                };
                let w = axis_words(&cur, &m.to, d, z_off);
                if !w.is_empty() {
                    g.push_str("G1");
                    g.push_str(&w);
                    if m.feed > 0.0 && !near_eq(m.feed, last_feed) {
                        g.push_str(&format!(" F{}", fmt(m.feed, 1)));
                        last_feed = m.feed;
                    }
                    g.push('\n');
                }
                cur = m.to;
            }

            MoveKind::ArcCW | MoveKind::ArcCCW => {
                if !machine.supports_arcs || !opts.emit_arcs {
                    // Degrade to a straight move rather than emit an unsupported
                    // code. Chord error is the caller's problem to avoid; say so
                    // loudly.
                    res.warnings
                        .push("arc degraded to linear move (arcs disabled or unsupported)".into());
                    let w = axis_words(&cur, &m.to, d, z_off);
                    if !w.is_empty() {
                        g.push_str("G1");
                        g.push_str(&w);
                        if m.feed > 0.0 && !near_eq(m.feed, last_feed) {
                            g.push_str(&format!(" F{}", fmt(m.feed, 1)));
                            last_feed = m.feed;
                        }
                        g.push('\n');
                    }
                    cur = m.to;
                    block_feed = if m.feed > 0.0 {
                        Some(m.feed)
                    } else if last_feed > 0.0 {
                        Some(last_feed)
                    } else {
                        None
                    };
                    break 'emit;
                }
                if cur.x.is_nan() {
                    res.errors.push("arc emitted before any positioning move".into());
                    break 'emit;
                }
                // I/J are the centre RELATIVE to the arc start — the usual
                // source of silently wrong arcs, so it is computed here and
                // nowhere else.
                block_feed = if m.feed > 0.0 {
                    Some(m.feed)
                } else if last_feed > 0.0 {
                    Some(last_feed)
                } else {
                    None
                };
                let i = m.centre.x - cur.x;
                let j = m.centre.y - cur.y;
                g.push_str(if m.kind == MoveKind::ArcCW { "G2" } else { "G3" });
                g.push_str(&format!(" X{} Y{}", fmt(m.to.x, d), fmt(m.to.y, d)));
                if !near_eq(cur.z, m.to.z) {
                    // helical
                    g.push_str(&format!(" Z{}", fmt(ez(m.to.z), d)));
                }
                g.push_str(&format!(" I{} J{}", fmt(i, d), fmt(j, d)));
                if m.feed > 0.0 && !near_eq(m.feed, last_feed) {
                    g.push_str(&format!(" F{}", fmt(m.feed, 1)));
                    last_feed = m.feed;
                }
                g.push('\n');
                cur = m.to;
            }

            MoveKind::DrillCycle => {
                block_feed = if m.feed > 0.0 {
                    Some(m.feed)
                } else if last_feed > 0.0 {
                    Some(last_feed)
                } else {
                    None
                };
                // grblHAL DOES support canned cycles, so a peck drill is G83
                // rather than a hand-expanded ladder of G1s.
                if machine.supports_canned_drill {
                    g.push_str("G98 "); // retract to initial Z
                    if m.value > 0.0 {
                        g.push_str(&format!(
                            "G83 X{} Y{} Z{} R{} Q{}",
                            fmt(m.to.x, d),
                            fmt(m.to.y, d),
                            fmt(ez(m.to.z), d),
                            fmt(ez(machine.safe_z_mm), d),
                            fmt(m.value, d)
                        ));
                    } else {
                        g.push_str(if op.drill_dwell_s > 0.0 { "G82" } else { "G81" });
                        g.push_str(&format!(
                            " X{} Y{} Z{} R{}",
                            fmt(m.to.x, d),
                            fmt(m.to.y, d),
                            fmt(ez(m.to.z), d),
                            fmt(ez(machine.safe_z_mm), d)
                        ));
                        if op.drill_dwell_s > 0.0 {
                            g.push_str(&format!(" P{}", fmt(op.drill_dwell_s, 2)));
                        }
                    }
                    if m.feed > 0.0 {
                        g.push_str(&format!(" F{}", fmt(m.feed, 1)));
                        last_feed = m.feed;
                    }
                    g.push('\n');
                    g.push_str("G80\n"); // cancel motion mode
                    cur = Vec3::new(m.to.x, m.to.y, machine.safe_z_mm);
                } else {
                    // Expand host-side. Correct, just verbose.
                    let target = m.to.z;
                    let step = if m.value > 0.0 { m.value } else { target.abs() };
                    g.push_str(&format!("G0 X{} Y{}\n", fmt(m.to.x, d), fmt(m.to.y, d)));
                    let mut z = 0.0_f64;
                    while z > target {
                        z = target.max(z - step);
                        g.push_str(&format!("G1 Z{}", fmt(ez(z), d)));
                        if m.feed > 0.0 && !near_eq(m.feed, last_feed) {
                            g.push_str(&format!(" F{}", fmt(m.feed, 1)));
                            last_feed = m.feed;
                        }
                        g.push('\n');
                        g.push_str(&format!(
                            "G0 Z{}\n",
                            fmt(ez(machine.safe_z_mm), d)
                        ));
                        if z > target {
                            g.push_str(&format!("G0 Z{}\n", fmt(ez(z + 0.5), d)));
                        }
                    }
                    cur = Vec3::new(m.to.x, m.to.y, machine.safe_z_mm);
                }
            }
        }
        } // 'emit

        // ---- what this move actually put in the file -----------------------
        //
        // 🔴 MEASURED OFF THE TEXT, not predicted from the arm that ran. Half
        // the arms above are conditional (`if !w.is_empty()`, a degraded arc, a
        // peck loop whose length depends on the depth), so "this kind writes
        // one line" is false for every one of them. Counting the newlines this
        // move actually added is the only version that stays true when an arm
        // changes.
        let written = g[block_start..].matches('\n').count();
        if written > 0 {
            let o = origins.get(mi).cloned().unwrap_or_default();
            blocks.push(EmittedBlock {
                move_index: mi,
                kind: m.kind,
                first_line: line_no + 1,
                lines: written,
                op: o.op,
                tool: o.tool,
                feed_mm_min: block_feed,
            });
            line_no += written;
        }
    }

    // ---- epilogue ----------------------------------------------------------
    g.push_str(&format!("G0 Z{}\n", fmt(ez(machine.safe_z_mm), d)));
    if spindle_running {
        g.push_str("M5\n");
        res.warnings
            .push("toolpath ended with the spindle still on; post added M5".into());
    }
    g.push_str("M30\n");

    // 🔴 ASSERTED ON THE EMITTED TEXT, NOT ON THE PLAN. Both properties below
    // are true by construction TODAY — the probe is written into the preamble
    // and `emit_probe` opens with M5. That is exactly why they are re-checked
    // here: "true by construction" is a statement about the current arrangement
    // of this function, and the next refactor is what these exist to catch. A
    // check on the enum would have been green for a program that probed after
    // the first cut.
    res.errors.extend(audit_probe_program(&g));

    // 🔴 AND THE LAST THING ANY PROGRAM PASSES: every numeric word is a number.
    // The plan-side check at the top of this function reads `path.moves`; this
    // one reads the bytes, so it also covers the arithmetic THIS function does
    // — the [`ZDatum`] shift, the host-side peck expansion, an arc degraded
    // to a chord. If it fires, the text is DISCARDED rather than returned with a
    // warning attached: a file that exists gets run.
    let word_errs = audit_finite_words(&g);
    if !word_errs.is_empty() {
        res.errors.extend(word_errs);
        return res; // res.gcode stays empty, and `blocks` with it
    }

    res.gcode = g;
    res.blocks = blocks;
    res
}

/// The code words of one line, uppercased, with `( … )` comments removed.
///
/// 🔴 WORDS, NEVER A LINE PREFIX. The distance mode arrives as the third word of
/// `G17 G21 G90 G54 G94 G40`; a `starts_with("G90")` scan reads that block as
/// setting no mode at all, and every conclusion drawn afterwards is about a
/// program nobody emitted.
///
/// The comment strip is grblHAL's own first step, and it is the difference
/// between scanning the program and scanning the prose that explains it — the
/// block comment above `ProbeGeometry` legitimately contains both `G91` and
/// `G38.2` in a sentence about what they do. This file's gates have been bitten
/// by that twice already (G2, G12).
fn code_words(line: &str) -> Vec<String> {
    let mut code = String::new();
    let mut depth = 0usize;
    for ch in line.chars() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => code.push(ch.to_ascii_uppercase()),
            _ => {}
        }
    }
    code.split_whitespace().map(str::to_string).collect()
}

/// Every probing block in the program, as `(1-based line, incremental?)`.
///
/// A modal walk, not a look at the neighbouring line. *"The line above says
/// `G91`"* and *"incremental distance mode is in force here"* are different
/// claims, and only the second is the one the controller acts on: the mode is
/// modal, so it can have been set thirty lines earlier — or cancelled twenty
/// lines earlier, which is the shape of the defect this exists for.
///
/// Three details that are not incidental:
///
///  * **Exact tokens.** `G90.1` / `G91.1` set the ARC distance mode for I/J/K,
///    not the motion one. A prefix match would read `G91.1` as switching the
///    program to incremental and would then wave an absolute probe through.
///  * **Mode words are applied before the block's motion is read**, because
///    they are modal for the block they appear in — `G91 G38.2 Z-30` on one
///    line is an incremental probe.
///  * **The initial state is ABSOLUTE.** Our preamble always sets one
///    explicitly, so this only decides what a program with no distance-mode
///    word at all counts as — and counting that as incremental would be the
///    scan exempting the one program that never says what frame it is in.
///
/// ⚠ **What it does NOT model, said here rather than left to be found:** `G53`,
/// the non-modal machine-coordinate override, would defeat the walk — a
/// `G53 G38.2` under `G91` would be scored incremental. It is named and not
/// handled because this post emits no `G53` at all, and because grbl's parser
/// accepts `G53` only alongside `G0`/`G1`, so such a block halts at the
/// controller instead of probing to the wrong place. The blindness cannot
/// produce a silent wrong probe; if this post ever emits `G53`, it can.
fn probe_distance_modes(gcode: &str) -> Vec<(usize, bool)> {
    let mut incremental = false;
    let mut out = Vec::new();
    for (n, raw) in gcode.lines().enumerate() {
        let words = code_words(raw);
        for w in &words {
            match w.as_str() {
                "G90" => incremental = false,
                "G91" => incremental = true,
                _ => {}
            }
        }
        if words.iter().any(|w| w.starts_with("G38.")) {
            out.push((n + 1, incremental));
        }
    }
    out
}

/// Three physical properties, read back off the finished program.
///
///  1. **The spindle is off across every probe.** A spinning cutter sweeps the
///     plate on the way in: contact fires early, at a radius that is not the
///     radius, and the plate, the cutter or both are destroyed.
///  2. **The first probe precedes the first cutting move.** The probe sets the
///     origin every later coordinate is measured from; anything cut before it is
///     referenced to nothing.
///  3. **Every probe is issued incrementally.** Every axis word this post gives
///     a `G38.2` is a travel; grblHAL applies the distance mode to probing
///     motion like any other motion, so an absolute one is a seek to a
///     coordinate in the very datum the probe is there to set.
fn audit_probe_program(gcode: &str) -> Vec<String> {
    let mut errs = Vec::new();
    let mut spindle_on_since: Option<usize> = None;
    let mut first_probe: Option<usize> = None;
    let mut first_cut: Option<usize> = None;

    for (n, raw) in gcode.lines().enumerate() {
        let line = raw.trim();
        // Comments legitimately DISCUSS M3, G38.2 and the rest — the preamble
        // says "G41/G42 absent" and the probe block names its own codes. A scan
        // over raw text matches the sentence that explains the ban.
        if line.is_empty() || line.starts_with('(') {
            continue;
        }
        if line.starts_with("M3") {
            spindle_on_since = Some(n + 1);
        } else if line.starts_with("M5") {
            spindle_on_since = None;
        } else if line.starts_with("G38.") {
            if first_probe.is_none() {
                first_probe = Some(n + 1);
            }
            if let Some(m3) = spindle_on_since {
                errs.push(format!(
                    "probe at line {} runs with the spindle started at line {} and never stopped \
                     — a probe with the spindle running destroys the plate, the cutter, or both",
                    n + 1,
                    m3
                ));
            }
        } else if line.starts_with("G1 ")
            || line.starts_with("G2 ")
            || line.starts_with("G3 ")
            || line.starts_with("G81")
            || line.starts_with("G82")
            || line.starts_with("G83")
        {
            if first_cut.is_none() {
                first_cut = Some(n + 1);
            }
        }
    }

    if let (Some(p), Some(c)) = (first_probe, first_cut) {
        if p > c {
            errs.push(format!(
                "the first probe is at line {p} and the first cutting move at line {c} — the \
                 probe sets the origin every later coordinate is measured from, so a cut before \
                 it is referenced to nothing"
            ));
        }
    }

    for (n, incremental) in probe_distance_modes(gcode) {
        if !incremental {
            errs.push(format!(
                "the probe at line {n} is issued with G90 in force — its axis word is a TRAVEL, \
                 and absolute distance mode makes the controller read it as a work coordinate in \
                 the datum this probe exists to establish. With a stale G54 the seek becomes a \
                 move away from the plate (ALARM:5, datum unset, machine locked) or a zero-length \
                 block (error:33). Issue it inside G91, as the X and Y passes are"
            ));
        }
    }
    errs
}

// ---------------------------------------------------------------------------
// Touch-plate tests, and the program dump gate PROBE reads.
//
// 🔴 WHY THE DUMP EXISTS, stated plainly rather than buried: gate PROBE wants to
// ask its questions of the EMITTED PROGRAM, and it drives `2bee-slice`. The CLI
// can turn a probe ON (`--probe`) but has no flag for the plate type, the corner,
// the wall or the descent, and `MachineCfg` — the `--config` route every other
// settings gate uses — carries only `probe_enabled` and `touch_plate_mm`. That
// file is outside this change. So the XYZ programs are emitted HERE, by the same
// `post_grblhal` the CLI calls, and written where the gate can read them.
//
// It is a real program from the real post, not a fixture of expected text. What
// it is NOT is proof that the browser emits the same thing — I1/K3 cover the CLI
// and the wasm, and neither can see this path until the config surface exists.
// That gap is named in the gate's own output rather than left for someone to
// assume away.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::path::PathBuf;

    fn dump_dir() -> PathBuf {
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../target/probe-gate"))
    }

    /// A machine that owns an XYZ plate. 🔴 The PLATE itself is not here — it is
    /// on the WORKPIECE (`Stock::corner_plate`), because it hooks over the work and moves with it.
    fn xyz_machine() -> Machine {
        Machine { probe_enabled: true, probe_plate: ProbePlate::Xyz, ..Machine::default() }
    }

    /// A workpiece with a fully declared corner plate, laid at the machine datum.
    fn xyz_stock(corner: ProbeCorner) -> Stock {
        Stock {
            corner_plate: Some(CornerPlate {
                plate: TouchPlate { top_mm: 1.6, wall: PlateWall::Mm(10.0) },
                corner,
                xy_depth_mm: 3.0,
            }),
            ..Stock::default()
        }
    }

    fn tool(diameter_mm: f64) -> Tool {
        Tool { name: format!("End Mill {diameter_mm}mm"), diameter_mm, ..Tool::default() }
    }

    /// 🔴 The DEFAULT program name, asserted **in emitted text** and not at the
    /// struct field — this is the only path on which that default is ever
    /// reached, so it is the only place the value can be watched at all.
    ///
    /// ⚠ **A plant at the emitted program is IMPOSSIBLE for this string and
    /// that is the finding**, not an omission: every real door
    /// (`cli/src/main.rs` x3, `fixtures::plan_report`) overrides
    /// `program_name`, so restoring the old literal changes **0 bytes** across
    /// all 13 programs this crate can emit. Measured 2026-08-11. This test is
    /// therefore the whole control the value can have, and it is a real one —
    /// reverting the literal turns it red.
    #[test]
    fn the_default_program_name_is_the_live_product_name() {
        let g = program_on(&Machine::default(), &Stock::default(), tool(6.0)).gcode;
        assert!(
            g.contains("( 2bee.app )"),
            "the default program name is not in the emitted header: {}",
            g.lines().take(3).collect::<Vec<_>>().join(" / ")
        );
        // The dead lane name must not come back on any door, including this one.
        assert!(
            !g.contains("2bee.slicer"),
            "the retired product name reached an emitted program: {g}"
        );
    }

    /// One shallow cut, so there IS a first cutting move for the ordering check
    /// to be about.
    fn program_on(machine: &Machine, stock: &Stock, tool: Tool) -> PostResult {
        let mut path = Toolpath {
            moves: vec![
                Move::spindle_on(18_000.0),
                Move::rapid(Vec3::new(10.0, 10.0, machine.safe_z_mm)),
                Move::feed_to(Vec3::new(60.0, 10.0, -3.0), 1200.0),
                Move::spindle_off(),
            ],
            tool,
            ..Default::default()
        };
        path.recompute_bounds();
        post_grblhal(
            &path,
            machine,
            stock,
            &OperationParams::default(),
            &PostOptions::default(),
        )
    }

    /// The XYZ case at the machine datum, which is where every pre-placement
    /// expectation in this module was written.
    fn program(corner: ProbeCorner, tool: Tool) -> PostResult {
        program_on(&xyz_machine(), &xyz_stock(corner), tool)
    }

    /// The Z-only case: no corner plate anywhere.
    fn z_only_program(machine: &Machine, tool: Tool) -> PostResult {
        program_on(machine, &Stock::default(), tool)
    }

    /// The `G10 L20 P1 <axis>` value the program sets, or `None`.
    fn datum(gcode: &str, axis: char) -> Option<f64> {
        gcode
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with(&format!("G10 L20 P1 {axis}")))
            .and_then(|l| l[format!("G10 L20 P1 {axis}").len()..].trim().parse().ok())
    }

    #[test]
    fn the_x_and_y_datums_carry_the_tool_radius_and_the_z_datum_does_not() {
        let six = program(ProbeCorner::FrontLeft, tool(6.0));
        let eight = program(ProbeCorner::FrontLeft, tool(8.0));
        assert!(six.ok(), "{:?}", six.errors);
        assert!(eight.ok(), "{:?}", eight.errors);

        // wall 10 + radius 3 = 13, on the MIN side, so negative.
        assert_eq!(datum(&six.gcode, 'X'), Some(-13.0));
        assert_eq!(datum(&six.gcode, 'Y'), Some(-13.0));
        // A wider tool moves the datum by exactly the radius change, which is
        // the negative control for the line above: a hardcoded 13 would pass it
        // and fail this.
        assert_eq!(datum(&eight.gcode, 'X'), Some(-14.0));
        assert_eq!(datum(&eight.gcode, 'Y'), Some(-14.0));
        // Z is the plate's TOP thickness and nothing else — the tip touches on
        // the axis, so no radius term.
        assert_eq!(datum(&six.gcode, 'Z'), Some(1.6));
        assert_eq!(datum(&eight.gcode, 'Z'), Some(1.6));
    }

    /// Every `G0 X<x> Y<y>` in the program, in order — the positioning moves the
    /// probe block makes.
    fn xy_stations(gcode: &str) -> Vec<(f64, f64)> {
        gcode
            .lines()
            .map(str::trim)
            .filter_map(|l| l.strip_prefix("G0 X"))
            .filter_map(|rest| {
                let (x, y) = rest.split_once(" Y")?;
                Some((x.parse().ok()?, y.parse().ok()?))
            })
            .collect()
    }

    #[test]
    fn the_wall_thickness_is_a_second_number_and_not_the_top_thickness() {
        let mut s = xyz_stock(ProbeCorner::FrontLeft);
        s.corner_plate.as_mut().unwrap().plate.wall = PlateWall::Mm(20.0);
        let r = program_on(&xyz_machine(), &s, tool(6.0));
        assert!(r.ok(), "{:?}", r.errors);
        assert_eq!(datum(&r.gcode, 'X'), Some(-23.0), "X did not follow the WALL thickness");
        assert_eq!(datum(&r.gcode, 'Z'), Some(1.6), "Z followed the wall instead of the top");
    }

    #[test]
    fn the_corner_decides_the_sign_of_every_x_and_y_word() {
        // Workpiece at the machine datum, so the corner's own coordinate is 0 on the min
        // sides and the workpiece size on the max ones — see the placement tests
        // below for what happens when it is not.
        let s = Stock::default();
        let fl = program(ProbeCorner::FrontLeft, tool(6.0));
        let br = program(ProbeCorner::BackRight, tool(6.0));
        assert_eq!(datum(&fl.gcode, 'X'), Some(-13.0));
        assert_eq!(datum(&fl.gcode, 'Y'), Some(-13.0));
        assert_eq!(datum(&br.gcode, 'X'), Some(s.size_x_mm + 13.0));
        assert_eq!(datum(&br.gcode, 'Y'), Some(s.size_y_mm + 13.0));
        // ...and the mixed corners are not two copies of one decision.
        let fr = program(ProbeCorner::FrontRight, tool(6.0));
        assert_eq!(datum(&fr.gcode, 'X'), Some(s.size_x_mm + 13.0));
        assert_eq!(datum(&fr.gcode, 'Y'), Some(-13.0));
    }

    // -----------------------------------------------------------------------
    // TODO #40. The plate is hooked over the WORKPIECE, so it moves when the
    // workpiece moves. These are the tests that would have caught the modelling
    // error: with the plate stored on the machine, every assertion below held
    // the plate still while the workpiece went somewhere else, and the datum the
    // whole program is measured from described a corner that was not there.
    // -----------------------------------------------------------------------

    #[test]
    fn moving_the_workpiece_moves_the_probe_with_it() {
        let at_datum = program(ProbeCorner::FrontLeft, tool(6.0));
        let mut moved_stock = xyz_stock(ProbeCorner::FrontLeft);
        moved_stock.origin_x_mm = 137.0;
        moved_stock.origin_y_mm = 42.0;
        let moved = program_on(&xyz_machine(), &moved_stock, tool(6.0));
        assert!(moved.ok(), "{:?}", moved.errors);

        // The datum follows the workpiece EXACTLY: the corner is now at (137, 42),
        // and the wall+radius term is still measured from it.
        assert_eq!(datum(&at_datum.gcode, 'X'), Some(-13.0));
        assert_eq!(datum(&at_datum.gcode, 'Y'), Some(-13.0));
        assert_eq!(
            datum(&moved.gcode, 'X'),
            Some(137.0 - 13.0),
            "the X datum stayed behind when the workpiece moved"
        );
        assert_eq!(
            datum(&moved.gcode, 'Y'),
            Some(42.0 - 13.0),
            "the Y datum stayed behind when the workpiece moved"
        );
        // ...and so does the place the tool is sent to touch the plate.
        assert_eq!(
            xy_stations(&moved.gcode).first().copied(),
            Some((137.0, 42.0)),
            "the tool was sent to the OLD plate position: {:?}",
            xy_stations(&moved.gcode)
        );
        // Z is a property of the plate, not of where the workpiece is.
        assert_eq!(datum(&moved.gcode, 'Z'), Some(1.6));
    }

    #[test]
    fn turning_the_workpiece_takes_the_plate_round_with_it() {
        // A 600x900 workpiece turned a quarter turn about its own corner and pushed
        // back to the datum measures 900x600 in machine coordinates, and the workpiece's
        // front-LEFT corner ends up at the machine's maximum X. So the plate is now
        // on the machine's RIGHT and the tool must stand off the other way —
        // which `ProbeCorner::x_sign` alone cannot know, because it names a side
        // of the WORKPIECE.
        let mut turned = xyz_stock(ProbeCorner::FrontLeft);
        turned.rotation_deg = 90.0;
        let r = program_on(&xyz_machine(), &turned, tool(6.0));
        assert!(r.ok(), "{:?}", r.errors);

        let placement = turned.corner_placement(ProbeCorner::FrontLeft);
        assert_eq!((placement.x, placement.y), (900.0, 0.0), "the corner did not go round");
        assert_eq!(placement.x_sign, 1.0, "the workpiece's left corner is now the machine's right");
        assert_eq!(placement.y_sign, -1.0);

        assert_eq!(datum(&r.gcode, 'X'), Some(900.0 + 13.0));
        assert_eq!(datum(&r.gcode, 'Y'), Some(-13.0));
        assert_eq!(xy_stations(&r.gcode).first().copied(), Some((900.0, 0.0)));

        // The control: the SAME plate on the SAME workpiece lying flat probes the
        // other way, so the sign above is read from the placement and not baked.
        let flat = program(ProbeCorner::FrontLeft, tool(6.0));
        assert_eq!(datum(&flat.gcode, 'X'), Some(-13.0));
    }

    #[test]
    fn a_sheet_not_square_to_the_bed_is_refused_rather_than_probed_on_a_slant() {
        let mut skew = xyz_stock(ProbeCorner::FrontLeft);
        skew.rotation_deg = 37.0;
        let r = program_on(&xyz_machine(), &skew, tool(6.0));
        assert!(!r.ok(), "a side probe was emitted against an edge lying at 37 degrees");
        assert!(r.errors.iter().any(|e| e.contains("square to the machine's axes")), "{:?}", r.errors);
        assert!(!r.gcode.contains("G38.2"), "a refused probe still emitted probing moves");
        // The control: a quarter turn is square and runs.
        let mut quarter = xyz_stock(ProbeCorner::FrontLeft);
        quarter.rotation_deg = 180.0;
        assert!(program_on(&xyz_machine(), &quarter, tool(6.0)).ok());
    }

    #[test]
    fn an_unspecified_corner_is_refused_rather_than_defaulted() {
        // The plate lives on the WORKPIECE now, so "not declared" is a workpiece with no
        // corner plate on an XYZ machine.
        let r = program_on(&xyz_machine(), &Stock::default(), tool(6.0));
        assert!(!r.ok(), "an XYZ probe with no declared corner produced a runnable program");
        assert!(
            r.errors.iter().any(|e| e.contains("corner_plate")),
            "the refusal does not name the setting: {:?}",
            r.errors
        );
        assert!(!r.gcode.contains("G38.2"), "a refused probe still emitted probing moves");
    }

    #[test]
    fn an_unknown_tool_radius_is_refused_rather_than_guessed() {
        let r = program(ProbeCorner::FrontLeft, tool(0.0));
        assert!(!r.ok(), "an XYZ probe with an unknown tool radius produced a runnable program");
        assert!(
            r.errors.iter().any(|e| e.contains("TOOL RADIUS")),
            "the refusal does not name the radius: {:?}",
            r.errors
        );
        assert!(!r.gcode.contains("G38.2"));
        // The control: the SAME setup with a known tool is fine, so the refusal
        // is about the radius and not about the plate.
        assert!(program(ProbeCorner::FrontLeft, tool(6.0)).ok());
    }

    #[test]
    fn an_undeclared_top_wall_or_descent_is_refused() {
        for (field, mutate) in [
            ("top_mm", (|p: &mut CornerPlate| p.plate.top_mm = 0.0) as fn(&mut CornerPlate)),
            ("wall_mm", |p: &mut CornerPlate| p.plate.wall = PlateWall::Undeclared),
            ("xy_depth_mm", |p: &mut CornerPlate| p.xy_depth_mm = 0.0),
        ] {
            let mut s = xyz_stock(ProbeCorner::FrontLeft);
            mutate(s.corner_plate.as_mut().unwrap());
            let r = program_on(&xyz_machine(), &s, tool(6.0));
            assert!(!r.ok(), "an undeclared {field} produced a runnable program");
            assert!(
                r.errors.iter().any(|e| e.contains(field)),
                "the refusal does not name {field}: {:?}",
                r.errors
            );
            assert!(!r.gcode.contains("G38.2"), "a refused probe emitted probing moves ({field})");
        }
    }

    #[test]
    fn a_plate_with_no_wall_is_refused_differently_from_one_nobody_measured() {
        // 🔴 TWO STATES A SINGLE `f64` COULD NOT TELL APART. 2 of the 13 surveyed
        // products have no wall at all — one probes a bore, where the tool radius
        // CANCELS instead of adding, one measures off a chamfer. Refusing both is
        // right; refusing them with the same message is not, because "measure it"
        // sends a person to look for a face that does not exist.
        let mut absent = xyz_stock(ProbeCorner::FrontLeft);
        absent.corner_plate.as_mut().unwrap().plate.wall = PlateWall::NotPresent;
        let r = program_on(&xyz_machine(), &absent, tool(6.0));
        assert!(!r.ok(), "a plate with no wall produced a corner-probe program");
        assert!(
            r.errors.iter().any(|e| e.contains("NO WALL") && e.contains("NOT implemented")),
            "a wall-less plate was refused as if it were merely unmeasured: {:?}",
            r.errors
        );
        assert!(!r.gcode.contains("G38.2"));

        // The control: the undeclared case must NOT produce that message, or the
        // two states are being told apart in the type and not in the output.
        let mut undeclared = xyz_stock(ProbeCorner::FrontLeft);
        undeclared.corner_plate.as_mut().unwrap().plate.wall = PlateWall::Undeclared;
        let u = program_on(&xyz_machine(), &undeclared, tool(6.0));
        assert!(!u.ok());
        assert!(
            !u.errors.iter().any(|e| e.contains("NO WALL")),
            "an unmeasured wall was reported as an absent one: {:?}",
            u.errors
        );
        // And a zero inside `Mm` is still "not a usable wall", never a zero term.
        let mut zero = xyz_stock(ProbeCorner::FrontLeft);
        zero.corner_plate.as_mut().unwrap().plate.wall = PlateWall::Mm(0.0);
        assert!(!program_on(&xyz_machine(), &zero, tool(6.0)).ok());
    }

    #[test]
    fn a_z_only_plate_needs_neither_corner_nor_radius() {
        // The compatibility limb: nothing that worked before may start refusing.
        //
        // ⚠ The plate thickness is TYPED HERE since 2026-08-09. It used to come
        // from `Machine::default()`, and this test's green was therefore also
        // vouching for an unsourced `1.6` nobody had measured — see
        // `an_undeclared_plate_refuses_and_emits_no_probe` for the other half.
        let m =
            Machine { probe_enabled: true, touch_plate_mm: Some(1.6), ..Machine::default() };
        let r = z_only_program(&m, tool(6.0));
        assert!(r.ok(), "a plain Z probe started refusing: {:?}", r.errors);
        assert_eq!(datum(&r.gcode, 'Z'), Some(1.6));
        assert!(datum(&r.gcode, 'X').is_none(), "a Z-only plate set an X datum");
        assert!(datum(&r.gcode, 'Y').is_none(), "a Z-only plate set a Y datum");
    }

    #[test]
    fn an_undeclared_plate_refuses_and_emits_no_probe() {
        // 🔴 Decision #43 P0. `Machine::default().touch_plate_mm` is `None` —
        // NOBODY HAS DECLARED IT — and a probe against an undeclared datum is
        // refused BEFORE any motion is written, not run against a number the
        // tool invented. Until 2026-08-09 this exact machine emitted
        // `G10 L20 P1 Z1.600` and ran.
        let m = Machine { probe_enabled: true, ..Machine::default() };
        assert_eq!(m.touch_plate_mm, None, "the shipped default declares a plate thickness");
        let r = z_only_program(&m, tool(6.0));
        assert!(!r.ok(), "an undeclared plate produced a runnable probing program");
        assert!(
            r.errors.iter().any(|e| e.contains("touch_plate_mm")),
            "the refusal does not name the field the operator has to fill in: {:?}",
            r.errors
        );
        assert!(
            r.errors.iter().any(|e| e.contains("calipers") && e.contains("enter 0")),
            "the refusal does not say what to measure or how to declare 'no plate': {:?}",
            r.errors
        );
        assert!(!r.gcode.contains("G38.2"), "a refused probe still emitted probing moves");
        assert!(!r.gcode.contains("G10 L20"), "a refused probe still set a datum");

        // 🔴 THE DISTINCTION THE WHOLE CHANGE RESTS ON: `None` and `Some(0.0)`
        // are different facts. Zero is a REAL setup — no plate, the tip zeroes
        // on the surface it touches — and it must run, or the refusal is just a
        // mandatory field rather than a statement about what is known.
        let zero = Machine { touch_plate_mm: Some(0.0), ..m.clone() };
        let z = z_only_program(&zero, tool(6.0));
        assert!(z.ok(), "an explicit 'no plate' (0) was refused: {:?}", z.errors);
        assert_eq!(datum(&z.gcode, 'Z'), Some(0.0));

        // A negative thickness is not a measurement of anything.
        let neg = Machine { touch_plate_mm: Some(-3.0), ..m };
        let n = z_only_program(&neg, tool(6.0));
        assert!(!n.ok(), "a negative plate thickness produced a program");
        assert!(!n.gcode.contains("G38.2"));
    }

    /// 🔴 THE FEED, AT THE EMITTED PROGRAM. `probe_travel_errors` validated the
    /// two probe DISTANCES and no feed at all until 2026-08-11, so a
    /// `probe_seek_feed` of 5,000mm/min emitted `G38.2 Z-30.000 F5000.0` and
    /// nothing said a word — the residual `feeds::FeedRole::Probing` named on
    /// itself. It is refused now, and the refusal is total: no `G38`, no datum.
    #[test]
    fn a_runaway_probe_seek_refuses_and_emits_no_probe() {
        let clean =
            Machine { probe_enabled: true, touch_plate_mm: Some(1.6), ..Machine::default() };
        // The control FIRST, and it is the one that matters: the shipped feeds
        // still emit. A check that refused every probe would pass every
        // assertion below and be worthless.
        let ok = z_only_program(&clean, tool(6.0));
        assert!(ok.ok(), "the shipped probe feeds started refusing: {:?}", ok.errors);
        assert!(ok.gcode.contains("G38.2 Z-30.000 F200.0"), "{}", ok.gcode);
        assert!(ok.gcode.contains("G38.2 Z-4.000 F25.0"), "{}", ok.gcode);

        let m = Machine { probe_seek_feed: 5_000.0, ..clean.clone() };
        let r = z_only_program(&m, tool(6.0));
        assert!(!r.ok(), "a 5000mm/min probe seek produced a runnable program");
        assert!(
            r.errors.iter().any(|e| e.contains("probe_seek_feed")),
            "the refusal does not name the field to change: {:?}",
            r.errors
        );
        assert!(!r.gcode.contains("G38"), "a refused probe still emitted probing moves");
        assert!(!r.gcode.contains("G10 L20"), "a refused probe still set a datum");

        // ...and the re-probe arm, which needs no absolute number to be wrong.
        let slow = Machine { probe_feed: 400.0, ..clean };
        let s = z_only_program(&slow, tool(6.0));
        assert!(!s.ok(), "a re-probe faster than the seek produced a runnable program");
        assert!(!s.gcode.contains("G38"), "{}", s.gcode);
    }

    /// 🔴 DOOR SYMMETRY, WHICH IS WHY THE CALL SITS OUTSIDE THE PLATE MATCH. An
    /// `Xyz` probe emits the same two feeds three times over — once on Z and
    /// once per side pass — so a check written inside the `ZOnly` arm would have
    /// exempted the door that emits the most probing motion.
    #[test]
    fn the_probe_feed_check_covers_the_xyz_plate_too() {
        let clean = xyz_machine();
        let ok = program_on(&clean, &xyz_stock(ProbeCorner::FrontLeft), tool(6.0));
        assert!(ok.ok(), "the XYZ control refuses for an unrelated reason: {:?}", ok.errors);
        assert_eq!(
            ok.gcode.matches("F200.0").count(),
            3,
            "the XYZ door is supposed to emit three seeks: {}",
            ok.gcode
        );

        let m = Machine { probe_seek_feed: 5_000.0, ..clean };
        let r = program_on(&m, &xyz_stock(ProbeCorner::FrontLeft), tool(6.0));
        assert!(!r.ok(), "an XYZ probe escaped the feed check");
        assert!(!r.gcode.contains("G38"), "{}", r.gcode);
    }

    /// ⚠ A machine that is NOT probing emits no `G38.2`, so its probe feeds
    /// reach nothing — and refusing on them would be a false red on every
    /// non-probing job, which is the shape that gets a control switched off.
    #[test]
    fn probe_feeds_are_not_judged_on_a_machine_that_is_not_probing() {
        let m = Machine { probe_enabled: false, probe_seek_feed: 5_000.0, ..Machine::default() };
        let r = z_only_program(&m, tool(6.0));
        assert!(r.ok(), "a machine with no probe was refused over a probe feed: {:?}", r.errors);
        assert!(!r.gcode.contains("G38"));
    }

    #[test]
    fn a_z_only_plate_ignores_the_workpiece_placement_entirely() {
        // 🔴 THE OTHER HALF OF THE SPLIT. A FIXED plate is bolted to the machine:
        // it does NOT move when the work does, and a program that moved it with
        // the workpiece would be exactly as wrong in the other direction. This is
        // the byte-identity check for the compatibility path.
        let m = Machine {
            probe_enabled: true,
            touch_plate_mm: Some(1.6),
            probe_x: 25.0,
            probe_y: 30.0,
            ..Machine::default()
        };
        let at_datum = z_only_program(&m, tool(6.0));
        let moved = program_on(
            &m,
            &Stock { origin_x_mm: 137.0, origin_y_mm: 42.0, ..Stock::default() },
            tool(6.0),
        );
        let probe_of = |g: &str| {
            g.lines()
                .map(str::trim)
                .take_while(|l| !l.starts_with("M3"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(
            probe_of(&at_datum.gcode),
            probe_of(&moved.gcode),
            "a FIXED plate moved with the workpiece — it is bolted to the machine"
        );
        assert_eq!(xy_stations(&moved.gcode).first().copied(), Some((25.0, 30.0)));
    }

    #[test]
    fn the_spindle_is_stopped_before_every_probe_and_the_audit_catches_it_if_not() {
        let r = program(ProbeCorner::FrontLeft, tool(6.0));
        let lines: Vec<&str> = r.gcode.lines().map(str::trim).collect();
        let first_probe = lines.iter().position(|l| l.starts_with("G38.2")).expect("no probe");
        assert!(
            lines[..first_probe].iter().any(|l| *l == "M5"),
            "no M5 before the first probe — the program does not ASSERT the spindle is off"
        );
        assert!(
            !lines[..first_probe].iter().any(|l| l.starts_with("M3")),
            "the spindle is started before the probe"
        );

        // The negative control for the audit itself: hand it a program that
        // probes with the spindle running and watch it object. Without this the
        // assertion above is vouching for an arrangement, not for a check.
        let planted = "M3 S18000\nG38.2 Z-30.000 F200.0\nG1 X10.000\n";
        let errs = audit_probe_program(planted);
        assert!(
            errs.iter().any(|e| e.contains("spindle running")),
            "the audit passed a probe taken with the spindle on: {errs:?}"
        );
    }

    #[test]
    fn the_probe_precedes_the_first_cutting_move_and_the_audit_catches_it_if_not() {
        let r = program(ProbeCorner::FrontLeft, tool(6.0));
        let lines: Vec<&str> = r.gcode.lines().map(str::trim).collect();
        let probe = lines.iter().position(|l| l.starts_with("G38.2")).expect("no probe");
        let cut = lines.iter().position(|l| l.starts_with("G1 ")).expect("no cut");
        assert!(probe < cut, "the probe lands after the first cut, which sets a datum for scrap");

        let planted = "M5\nG1 X10.000 F600.0\nG38.2 Z-30.000 F200.0\n";
        let errs = audit_probe_program(planted);
        assert!(
            errs.iter().any(|e| e.contains("referenced to nothing")),
            "the audit passed a probe taken after the first cut: {errs:?}"
        );
    }

    /// 🔴 THE FRAME, NOT THE NUMBER — TODO #85 P0.
    ///
    /// Every other assertion in this module reads a `G10 L20` datum VALUE or a
    /// `G0 X.. Y..` station. None of them reads the *sentence* those numbers sit
    /// in, which is how `G38.2 Z-30.000` shipped for months as an absolute seek
    /// to a work coordinate while carrying `probe_max_mm` — a travel. The check
    /// and the defect never met.
    ///
    /// This is a MODAL WALK of the emitted text. *"The line above says `G91`"*
    /// is a weaker and different claim from *"incremental mode is in force
    /// here"*, and the defect was precisely a `G90` twenty lines up that nobody
    /// had cancelled.
    #[test]
    fn every_probe_in_an_emitted_program_is_issued_in_g91() {
        // ---- non-vacuity FIRST. A scan that finds no G38.2 and reports
        // success is the shape this lane has been burned by, so the programs
        // this test runs on have to be shown to contain probes at all — and by
        // an exact count, so a program that quietly loses one still fails.
        let xyz = program(ProbeCorner::FrontLeft, tool(6.0));
        assert!(xyz.ok(), "{:?}", xyz.errors);
        let xyz_probes = probe_distance_modes(&xyz.gcode);
        assert_eq!(
            xyz_probes.len(),
            6,
            "the XYZ program should carry two probes per axis; this scan is vacuous or the \
             program changed shape: {xyz_probes:?}"
        );

        let z_only = z_only_program(
            &Machine { probe_enabled: true, touch_plate_mm: Some(1.6), ..Machine::default() },
            tool(6.0),
        );
        assert!(z_only.ok(), "{:?}", z_only.errors);
        let z_probes = probe_distance_modes(&z_only.gcode);
        assert_eq!(
            z_probes.len(),
            2,
            "the Z-only program should carry a seek and a slow re-probe: {z_probes:?}"
        );

        // ---- the property.
        for (name, probes) in [("xyz", &xyz_probes), ("z-only", &z_probes)] {
            for (line, incremental) in probes {
                assert!(
                    incremental,
                    "{name}: the G38.2 at line {line} is issued with G90 in force. Its axis word \
                     is a travel (probe_max_mm / probe_retract_mm * 2), so the controller seeks a \
                     work COORDINATE in the datum the probe exists to establish"
                );
            }
        }

        // ---- and the audit, which is what refuses at post time, agrees.
        assert!(
            !audit_probe_program(&xyz.gcode).iter().any(|e| e.contains("G90 in force")),
            "the emitted program passes the modal scan but the audit objects to it"
        );
    }

    /// The negative control for the scan itself, in four planted programs. The
    /// test above vouches for an arrangement; only these vouch for a check.
    #[test]
    fn the_probe_frame_audit_catches_an_absolute_probe_and_is_not_fooled_by_a_prefix() {
        let objects = |g: &str| audit_probe_program(g).iter().any(|e| e.contains("G90 in force"));

        // 1. The defect itself, as the post wrote it until 2026-08-10 — and
        //    note the G90 is the THIRD WORD of a six-word block. A scan keyed on
        //    a line prefix reads this program as never setting a distance mode.
        let planted = "M5\nG17 G21 G90 G54 G94 G40\nG0 Z5.000\nG38.2 Z-30.000 F200.0\n";
        assert!(objects(planted), "the audit passed a probe issued in absolute mode");

        // 2. The fixed shape must NOT be objected to, or the check is satisfied
        //    by refusing everything.
        let fixed = "M5\nG17 G21 G90 G54 G94 G40\nG91\nG38.2 Z-30.000 F200.0\nG90\n";
        assert!(!objects(fixed), "the audit objected to a correctly incremental probe");

        // 3. `G91.1` is the ARC distance mode for I/J/K. It must not be read as
        //    switching the program to incremental — that is the direction that
        //    waves a real defect through.
        let arc_mode = "M5\nG90\nG91.1\nG38.2 Z-30.000 F200.0\n";
        assert!(objects(arc_mode), "`G91.1` was mistaken for `G91` and hid an absolute probe");

        // 4. The mirror: `G90.1` must not cancel a live `G91`.
        let arc_mode_back = "M5\nG91\nG90.1\nG38.2 Z-30.000 F200.0\n";
        assert!(!objects(arc_mode_back), "`G90.1` was mistaken for `G90`");

        // 5. A comment DISCUSSING the mode is not the mode. This file's own
        //    block comment contains the sentence "`G91` APPLIES TO `G38.2`".
        let discussed = "M5\n( G91 applies to G38.2 )\nG90\nG38.2 Z-30.000 F200.0\n";
        assert!(objects(discussed), "a comment mentioning G91 was read as setting it");

        // 6. The modal group is per-block, so a one-line `G91 G38.2` probes
        //    incrementally.
        let one_line = "M5\nG90\nG91 G38.2 Z-30.000 F200.0\n";
        assert!(!objects(one_line), "a block-local G91 was not applied to its own G38.2");
    }

    #[test]
    fn a_zero_travel_probe_is_refused_because_the_controller_rejects_it() {
        let mut m = Machine { probe_enabled: true, ..Machine::default() };
        m.probe_max_mm = 0.0;
        let r = z_only_program(&m, tool(6.0));
        assert!(!r.ok());
        assert!(r.errors.iter().any(|e| e.contains("probe_max_mm")), "{:?}", r.errors);

        // 🔴 THE EMISSION HALF, ADDED 2026-08-11 — AND IT IS ASSERTED ON A
        // MACHINE WITH A DECLARED PLATE, WHICH IS THE WHOLE CARE TAKEN HERE.
        // `Machine::default().touch_plate_mm` is `None`, so on the machine
        // above `fixed_z_probe` refuses FIRST and no probe is written whatever
        // the travel says. Written that way this assertion could never go red —
        // it would be a green vouching for a suppression it never exercised,
        // which is the defect this file's own header is about. Measured: with
        // the suppression disabled, the version above passes and the version
        // below fails.
        //
        // What it guards: until the feed check landed, a `probe_max_mm` of 0 set
        // `ok() == false` and STILL left `G38.2 Z-0.000 F200.0` in `res.gcode` —
        // the one refusal family on this path that emitted the motion it had
        // just refused. The CLI hid it (gate G13: nothing is printed on a
        // refusal), so the only thing between that text and a sender was every
        // host remembering to check `ok()`.
        let declared = Machine { touch_plate_mm: Some(1.6), ..m };
        let d = z_only_program(&declared, tool(6.0));
        assert!(!d.ok(), "a zero-travel probe with a declared plate produced a runnable program");
        assert!(d.errors.iter().any(|e| e.contains("probe_max_mm")), "{:?}", d.errors);
        assert!(!d.gcode.contains("G38"), "a refused probe still emitted probing moves");
        assert!(!d.gcode.contains("G10 L20"), "a refused probe still set a datum");
    }

    /// Writes the programs gate PROBE reads. Not an assertion — the assertions
    /// above and the gate's own are the check; this only puts the artefact where
    /// a non-Rust harness can see it.
    #[test]
    fn probe_gate_dump() {
        let dir = dump_dir();
        std::fs::create_dir_all(&dir).expect("cannot create the dump directory");

        let write = |name: &str, body: String| {
            std::fs::write(dir.join(name), body).expect("cannot write the dump");
        };

        let render = |r: &PostResult| {
            format!("OK {}\nERRORS {}\n----\n{}", r.ok(), r.errors.join(" | "), r.gcode)
        };

        write("xyz-front-left.nc", render(&program(ProbeCorner::FrontLeft, tool(6.0))));
        write("xyz-back-right.nc", render(&program(ProbeCorner::BackRight, tool(6.0))));
        write("xyz-tool8.nc", render(&program(ProbeCorner::FrontLeft, tool(8.0))));
        // 🔴 The plate thickness is DECLARED here, and that is the point of the
        // pair below: `Some(1.6)` is a shop that measured, `None` is a shop that
        // did not, and only the first may produce a program.
        write(
            "z-only.nc",
            render(&z_only_program(
                &Machine {
                    probe_enabled: true,
                    touch_plate_mm: Some(1.6),
                    ..Machine::default()
                },
                tool(6.0),
            )),
        );
        // Decision #43 P0 — the SHIPPED DEFAULT, untouched: probing on, plate
        // undeclared. Until 2026-08-09 this file would have contained a full
        // probing sequence datumed on an unsourced 1.6.
        write(
            "refuse-no-plate-thickness.nc",
            render(&z_only_program(
                &Machine { probe_enabled: true, ..Machine::default() },
                tool(6.0),
            )),
        );

        // TODO #40 — the plate belongs to the SETUP. The same plate on the same
        // machine, with the workpiece somewhere else, must move with the workpiece.
        let mut moved = xyz_stock(ProbeCorner::FrontLeft);
        moved.origin_x_mm = 137.0;
        moved.origin_y_mm = 42.0;
        write("xyz-moved.nc", render(&program_on(&xyz_machine(), &moved, tool(6.0))));

        let mut turned = xyz_stock(ProbeCorner::FrontLeft);
        turned.rotation_deg = 90.0;
        write("xyz-turned.nc", render(&program_on(&xyz_machine(), &turned, tool(6.0))));

        // A FIXED plate, on a moved workpiece: it must NOT follow, because it is
        // bolted to the machine. The gate reads this as the other half of the split.
        let fixed = Machine {
            probe_enabled: true,
            touch_plate_mm: Some(1.6),
            probe_x: 25.0,
            probe_y: 30.0,
            ..Machine::default()
        };
        write(
            "z-only-moved.nc",
            render(&program_on(
                &fixed,
                &Stock { origin_x_mm: 137.0, origin_y_mm: 42.0, ..Stock::default() },
                tool(6.0),
            )),
        );

        // The refusals, one file each, each named after the setting it refuses.
        write(
            "refuse-no-corner.nc",
            render(&program_on(&xyz_machine(), &Stock::default(), tool(6.0))),
        );
        write("refuse-no-radius.nc", render(&program(ProbeCorner::FrontLeft, tool(0.0))));

        let blank = |name: &str, f: fn(&mut CornerPlate)| {
            let mut s = xyz_stock(ProbeCorner::FrontLeft);
            f(s.corner_plate.as_mut().unwrap());
            let r = program_on(&xyz_machine(), &s, tool(6.0));
            std::fs::write(dump_dir().join(name), render(&r)).expect("cannot write the dump");
        };
        blank("refuse-no-top.nc", |p| p.plate.top_mm = 0.0);
        blank("refuse-no-wall.nc", |p| p.plate.wall = PlateWall::Undeclared);
        blank("refuse-no-depth.nc", |p| p.xy_depth_mm = 0.0);
        // A plate that HAS no wall — a different fact, and a different refusal.
        blank("refuse-wall-absent.nc", |p| p.plate.wall = PlateWall::NotPresent);

        let mut skew = xyz_stock(ProbeCorner::FrontLeft);
        skew.rotation_deg = 37.0;
        write("refuse-not-square.nc", render(&program_on(&xyz_machine(), &skew, tool(6.0))));
    }
}

// ---------------------------------------------------------------------------
// Spindle tests (spec row A2). Gate SPIN asserts the band and the dwell on the
// EMITTED PROGRAM through the CLI; these cover the two machine settings the CLI
// has no flag for, so they would otherwise be settings consumed by nothing.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod spindle_tests {
    use super::*;

    /// The smallest program that cuts: start the spindle, take one shallow cut,
    /// stop. Everything below asks a question about the spindle words only.
    fn one_cut(machine: &Machine, rpm: f64) -> PostResult {
        let mut path = Toolpath {
            moves: vec![
                Move::spindle_on(rpm),
                Move::rapid(Vec3::new(10.0, 10.0, machine.safe_z_mm)),
                Move::feed_to(Vec3::new(10.0, 10.0, 0.0), 300.0),
                Move::feed_to(Vec3::new(60.0, 10.0, -3.0), 1200.0),
                Move::spindle_off(),
            ],
            tool: Tool::default(),
            ..Default::default()
        };
        path.recompute_bounds();
        post_grblhal(
            &path,
            machine,
            &Stock::default(),
            &OperationParams::default(),
            &PostOptions::default(),
        )
    }

    #[test]
    fn the_spin_up_dwell_follows_m3_and_precedes_the_first_cutting_move() {
        let m = Machine::default();
        let r = one_cut(&m, 18_000.0);
        assert!(r.ok(), "{:?}", r.errors);
        let lines: Vec<&str> = r.gcode.lines().map(|l| l.trim()).collect();
        let m3 = lines.iter().position(|l| l.starts_with("M3 ")).expect("no M3");
        assert_eq!(
            lines[m3 + 1],
            format!("G4 P{:.2}", m.spindle_spinup_s),
            "the dwell does not IMMEDIATELY follow M3 — anything between them is a move made \
             while the spindle is still coming up to speed"
        );
        let first_cut = lines
            .iter()
            .position(|l| l.starts_with("G1 ") || l.starts_with("G2 ") || l.starts_with("G3 "))
            .expect("no cutting move");
        assert!(m3 + 1 < first_cut, "the dwell lands after the first cut, which is no dwell");
    }

    #[test]
    fn a_zero_spinup_removes_the_dwell_so_the_setting_is_the_thing_being_read() {
        // The negative control for the test above: if `G4` were hardcoded, this
        // would still find one and the assertion above would be vouching for a
        // constant rather than for the setting.
        let m = Machine { spindle_spinup_s: 0.0, ..Machine::default() };
        let r = one_cut(&m, 18_000.0);
        assert!(r.ok(), "{:?}", r.errors);
        assert!(!r.gcode.contains("G4 P"), "a dwell appeared with the spin-up set to zero");
    }

    #[test]
    fn a_spindle_commanded_to_ZERO_is_refused_and_not_merely_unchecked() {
        // 🔴 EVERY spindle test sat inside `if m.value > 0.0`, so the guard
        // excluded exactly the value it most needed to catch. A `SpindleOn` of
        // zero skipped the band check, the ceiling check AND the cutter's
        // rating, and the post emitted `M3 S0` with no spindle comment at all.
        //
        // Measured through the real door before the fix
        // (`job plate --config '{"op":{"rpm":0}}'`): exit 0, 11,700 bytes,
        // `M3 S0` on line 21, `ok: true`. The FEED notes did fire — "delivers
        // 0.000mm of chip per tooth … it rubs" — but a warning above a runnable
        // program is a program that gets run. On a VFD spindle `S0` does not
        // turn, and the cutting moves feed the tool through the material anyway.
        //
        // ⚠ Same shape as #147 and #148: a guard whose PRECONDITION excludes the
        // case it exists for. There it was `f64::min` swallowing NaN; here it is
        // `> 0.0` swallowing zero.
        let m = Machine::default();
        for rpm in [0.0, -1.0] {
            let r = one_cut(&m, rpm);
            assert!(
                !r.ok(),
                "the post accepted a spindle commanded to {rpm} rpm and emitted a runnable \
                 program — the cutter is fed through material without turning"
            );
            assert!(
                r.errors.iter().any(|e| e.contains("spindle ON at")),
                "the refusal must name what was commanded: {:?}",
                r.errors
            );
            // ⚠ NOT asserted: that `M3 S0` is absent from `r.gcode`. The post
            // accumulates text as it walks the moves and reports errors
            // alongside it — the CONTRACT is `ok() == false`, and every host
            // withholds the file on that (`is_runnable`, the CLI's exit 1 with
            // empty stdout, and the e2e "a refused program offers no download").
            // Asserting on the buffer would be asserting on an intermediate
            // nobody delivers. Verified through the real door instead:
            // `job plate --config '{"op":{"rpm":0}}'` exits 1 with 0 bytes.
            // (No assertion on the buffer's contents: `-1.0` writes `M3 S-1`,
            // not `M3 S0`, and pinning the text here would test the formatter.)
        }

        // Specificity: an ordinary speed inside the band still posts cleanly.
        let good = one_cut(&m, (m.spindle_min_rpm + m.spindle_max_rpm) * 0.5);
        assert!(good.ok(), "a normal spindle speed was refused: {:?}", good.errors);
    }

    #[test]
    fn an_rpm_outside_the_spindle_band_warns_in_both_directions() {
        let m = Machine::default();
        let over = one_cut(&m, m.spindle_max_rpm + 1.0);
        assert!(
            over.warnings.iter().any(|w| w.contains("exceeds the spindle's maximum")),
            "{:?}",
            over.warnings
        );
        let under = one_cut(&m, m.spindle_min_rpm - 1.0);
        assert!(
            under.warnings.iter().any(|w| w.contains("below the spindle's minimum")),
            "{:?}",
            under.warnings
        );
        let inside = one_cut(&m, (m.spindle_min_rpm + m.spindle_max_rpm) * 0.5);
        assert!(
            !inside.warnings.iter().any(|w| w.contains("spindle's")),
            "an in-band speed warned: {:?}",
            inside.warnings
        );
    }

    #[test]
    fn a_reversed_spindle_is_refused_rather_than_posted_as_clockwise() {
        let m = Machine { spindle_reverse: true, ..Machine::default() };
        let r = one_cut(&m, 18_000.0);
        assert!(!r.ok(), "a reversed spindle produced a runnable program");
        assert!(
            r.errors.iter().any(|e| e.contains("spindle_reverse")),
            "the refusal does not name the setting: {:?}",
            r.errors
        );
        // And it must not be an M4 program either — refusing means no program.
        assert!(!r.gcode.contains("M4"), "reverse was posted as M4, which nothing has verified");
    }

    #[test]
    fn a_machine_without_pwm_says_the_speed_must_be_set_by_hand() {
        let m = Machine { spindle_pwm: false, ..Machine::default() };
        let r = one_cut(&m, 18_000.0);
        assert!(r.ok(), "{:?}", r.errors);
        let hits = r.warnings.iter().filter(|w| w.contains("no spindle PWM")).count();
        assert_eq!(hits, 1, "expected exactly one PWM warning, got {:?}", r.warnings);
        assert!(r.gcode.contains("S18000"), "the S word disappeared with PWM off");
        // The control: a PWM machine must not carry the warning.
        let with = one_cut(&Machine::default(), 18_000.0);
        assert!(!with.warnings.iter().any(|w| w.contains("no spindle PWM")), "{:?}", with.warnings);
    }
}

// ---------------------------------------------------------------------------
// The last line of defence: no non-finite number may become a G-code word.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod nonfinite_tests {
    use super::*;

    /// A program that cuts, with ONE move whose XY has no value. This is exactly
    /// what a zero-length segment used to produce upstream — the offset
    /// normalised a segment by its own zero length and both components came back
    /// NaN.
    fn path_with_a_nan_move() -> Toolpath {
        let mut p = Toolpath {
            moves: vec![
                Move::spindle_on(18_000.0),
                Move::rapid(Vec3::new(10.0, 10.0, 5.0)),
                Move::feed_to(Vec3::new(10.0, 10.0, -3.0), 300.0),
                Move::feed_to(Vec3::new(f64::NAN, f64::NAN, -3.0), 1200.0),
                Move::feed_to(Vec3::new(60.0, 40.0, -3.0), 1200.0),
                Move::spindle_off(),
            ],
            tool: Tool::default(),
            ..Default::default()
        };
        p.recompute_bounds();
        p
    }

    #[test]
    fn the_travel_check_can_see_a_move_it_has_no_coordinate_for() {
        // 🔴 WHY EVERY EXISTING CHECK WAS BLIND. `check_machine_limits` reads
        // `path.min_x`..`path.max_x`, and those were folded with
        // `f64::min`/`f64::max`, which RETURN THE OTHER OPERAND on NaN. The box
        // therefore never widened, stayed inside the machine, and the limit
        // check passed on a program containing a move with no destination.
        let p = path_with_a_nan_move();
        let errs = check_machine_limits(&p, &Machine::default());
        assert!(
            !errs.is_empty(),
            "the travel check passed a program whose bounds are {}..{} x {}..{} — it cannot see \
             the move it exists to bound",
            p.min_x,
            p.max_x,
            p.min_y,
            p.max_y
        );
    }

    #[test]
    fn a_non_finite_move_is_refused_and_the_program_is_not_written() {
        // 🔴 THE PHYSICAL FAILURE: grblHAL is handed `G1 XNaN YNaN` with a 2.2 kW
        // spindle turning. The parser's response is not specified anywhere we
        // have verified, so the machine state after it is unknown — which is the
        // one state a person standing next to it cannot plan around.
        //
        // Per this lane's fail-closed rule (gate G13) a refused program emits NO
        // G-code at all, so there is nothing for a hurried operator to drag into
        // a sender.
        let p = path_with_a_nan_move();
        let r = post_grblhal(
            &p,
            &Machine::default(),
            &Stock::default(),
            &OperationParams::default(),
            &PostOptions::default(),
        );
        assert!(!r.ok(), "a program containing XNaN was posted as OK");
        assert!(
            r.errors.iter().any(|e| e.contains("non-finite")),
            "the refusal does not say what is wrong: {:?}",
            r.errors
        );
        // ...and it NAMES the move, so the operator is sent to the feature and
        // not to the whole file.
        assert!(
            r.errors.iter().any(|e| e.contains("move 3")),
            "the refusal does not name the offending move: {:?}",
            r.errors
        );
        assert!(
            r.gcode.is_empty(),
            "a refused program still emitted {} bytes of G-code",
            r.gcode.len()
        );
    }

    #[test]
    fn no_emitted_word_may_carry_a_non_finite_value() {
        // 🔴 ASSERTED ON THE EMITTED TEXT, which is the only place the machine
        // reads from. The check above reads the PLAN; this one reads the
        // PROGRAM, and they are different facts — the post does its own
        // arithmetic (z_offset, peck expansion, arc degradation) and a
        // non-finite value introduced there would pass the plan-side check
        // untouched.
        //
        // Armed directly against the writer's own audit, because a program the
        // post refuses to build cannot exercise the reader.
        let clean = "G17 G21 G90 G54 G94 G40\nG0 Z5.000\nG1 X10.000 Y10.000 F1200.0\nM30\n";
        assert!(audit_finite_words(clean).is_empty(), "a clean program was rejected");

        let poisoned = "G17 G21 G90 G54 G94 G40\nG0 Z5.000\nG1 XNaN YNaN F1200.0\nM30\n";
        let errs = audit_finite_words(poisoned);
        // Both words, not the first: two axes with no value is two faults, and
        // collapsing them hides half of what has to be looked at.
        assert_eq!(errs.len(), 2, "expected both words reported, got {errs:?}");
        assert!(errs[0].contains("XNaN"), "the finding does not quote the word: {}", errs[0]);
        assert!(errs[1].contains("YNaN"), "the finding does not quote the word: {}", errs[1]);

        let infinite = "G0 Z5.000\nG1 X-inf Y10.000\nM30\n";
        assert!(!audit_finite_words(infinite).is_empty(), "an infinite word was accepted");

        // ⚠ A comment may legitimately CONTAIN those letters — "infill.dxf",
        // "NaN" in a part name — and must not trip the scanner. A gate that
        // false-reds on a filename gets muted, and a muted gate is no gate.
        let commented = "( imported from infill_NaN_test.dxf )\nG0 Z5.000\nG1 X10.000\nM30\n";
        assert!(
            audit_finite_words(commented).is_empty(),
            "a comment tripped the scanner: {:?}",
            audit_finite_words(commented)
        );
    }
}

// ===========================================================================
//  Per-block attribution — asserted against the EMITTED PROGRAM
// ===========================================================================
//
// 🔴 EVERY ASSERTION IN THIS MODULE READS `PostResult::gcode`. The attribution
// is computed from the PLAN (`toolpath::attribute_moves`), and the whole value
// of it is the claim that it describes the FILE. A test that compared the
// attribution to the plan it came from would be green for an attribution that
// is one move out of step with every line it claims to label — which is
// precisely the defect a playback or a hover panel would render as a fact.
//
// So the oracle here re-reads the program text with a rule stated in the
// program's own terms: *the operation in force is the one named by the last
// `( op: … )` / `( drill: … )` banner, and a manual tool change (`M0`) ends
// it.* Both halves are visible to anyone opening the file in a sender.
#[cfg(test)]
mod attribution_tests {
    use super::*;
    use crate::fixtures::{build, JobPlant};
    use crate::job::plan_job;
    use crate::toolpath::parse_banner;

    /// Post a named fixture, returning its program and its blocks.
    fn posted(name: &str) -> (PostResult, crate::types::Toolpath) {
        let b = build(name, JobPlant::None).unwrap_or_else(|| panic!("no fixture {name}"));
        let r = plan_job(&b.job);
        assert!(r.refusals.is_empty(), "{name} refused: {:?}", r.refusals);
        let p = post_grblhal(
            &r.path,
            &b.job.machine,
            &b.job.stock,
            &OperationParams::default(),
            &b.job.post,
        );
        assert!(p.ok(), "{name} did not post: {:?}", p.errors);
        assert!(!p.gcode.is_empty(), "{name} posted an empty program");
        (p, r.path)
    }

    /// What the PROGRAM TEXT says is in force at each 1-based line: the
    /// operation and tool named by the last banner, and the modal `F` word.
    ///
    /// ⚠ Deliberately a second, dumber reader. It knows nothing about `Move`s —
    /// only about lines, comments and words — so if it agrees with the
    /// attribution, the attribution describes the file.
    #[derive(Clone, Debug, Default)]
    struct TextState {
        op: Option<String>,
        tool: Option<String>,
        feed: Option<f64>,
    }

    fn text_state(gcode: &str) -> Vec<TextState> {
        let mut out = Vec::new();
        let mut st = TextState::default();
        for line in gcode.lines() {
            let t = line.trim();
            if let Some(inner) = t.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
                if let Some((name, tool)) = parse_banner(inner.trim()) {
                    st.op = Some(name.to_string());
                    st.tool = if tool.is_empty() { None } else { Some(tool.to_string()) };
                }
            } else if let Some(f) = t
                .split_whitespace()
                .find_map(|w| w.strip_prefix('F').and_then(|n| n.parse::<f64>().ok()))
            {
                st.feed = Some(f);
            }
            out.push(st.clone());
        }
        out
    }

    /// 🔴 THE POINT OF THE WHOLE THING. For every line the attribution claims,
    /// the operation it reports is the operation the PROGRAM TEXT has in force
    /// at that line.
    ///
    /// This is the assertion an off-by-one breaks, and an off-by-one is the
    /// failure that renders as a plausible label on the wrong cut.
    ///
    /// # The one documented divergence, asserted rather than excused
    ///
    /// Between a tool change and the next banner — the retract, the `M5`, the
    /// `M0`, the re-probe, the new `M3` — the attribution reports **no
    /// operation**, while the program text still carries the FINISHED
    /// operation's banner. The text is stale there and the attribution is not:
    /// those lines belong to the operation that has ended no more than to the
    /// one that has not been announced. It is called out here because it is
    /// exactly the case a host parsing the program with a regex gets wrong, and
    /// because an unasserted exception is where a real off-by-one would hide.
    #[test]
    fn the_operation_a_block_reports_is_the_one_in_force_in_the_program_text() {
        for name in ["plate", "pocket", "multi-tool"] {
            let (p, _) = posted(name);
            let state = text_state(&p.gcode);
            let mut checked = 0usize;
            let mut gaps = 0usize;
            // True from a tool change until the next banner puts an operation
            // back in force.
            let mut in_change_gap = false;
            for b in &p.blocks {
                let st = &state[b.first_line - 1];
                if b.kind == MoveKind::ToolChange {
                    in_change_gap = true;
                }
                if in_change_gap && b.op.is_none() {
                    gaps += 1;
                    // The text really IS stale here — otherwise this branch is
                    // silently excusing blocks the text agrees about.
                    assert!(
                        st.op.is_some(),
                        "{name}: block {} ({:?}) at line {} is inside a tool-change gap, but the \
                         program text has no operation in force either — the gap is not the \
                         reason it is unattributed",
                        b.move_index,
                        b.kind,
                        b.first_line
                    );
                    continue;
                }
                in_change_gap = false;
                assert_eq!(
                    b.op.as_deref(),
                    st.op.as_deref(),
                    "{name}: block {} ({:?}) at line {} says it belongs to {:?}, but the program \
                     text at that line has {:?} in force — the line is {:?}",
                    b.move_index,
                    b.kind,
                    b.first_line,
                    b.op,
                    st.op,
                    p.gcode.lines().nth(b.first_line - 1)
                );
                assert_eq!(
                    b.tool.as_deref(),
                    st.tool.as_deref(),
                    "{name}: block {} ({:?}) at line {} says it is cut with {:?}, but the banner \
                     in force names {:?}",
                    b.move_index,
                    b.kind,
                    b.first_line,
                    b.tool,
                    st.tool
                );
                checked += 1;
            }
            assert!(checked > 20, "{name}: only {checked} blocks — that is not a real program");
            // ...and the fixture actually exercises more than one operation, or
            // the equality above holds trivially.
            let named: std::collections::BTreeSet<_> =
                p.blocks.iter().filter_map(|b| b.op.clone()).collect();
            assert!(
                named.len() >= 2,
                "{name}: every block reports the same operation ({named:?}), so this test would \
                 pass with the attribution shifted by any number of moves"
            );
            if name == "multi-tool" {
                assert!(gaps > 0, "the multi-tool fixture posted no tool-change gap at all");
            }
        }
    }

    /// A tool change names the cutter being FITTED, not the one just finished —
    /// and no operation, because it belongs to neither.
    #[test]
    fn a_tool_change_block_names_the_new_cutter_and_no_operation() {
        let (p, path) = posted("multi-tool");
        let changes: Vec<&EmittedBlock> =
            p.blocks.iter().filter(|b| b.kind == MoveKind::ToolChange).collect();
        assert!(!changes.is_empty(), "the multi-tool fixture emitted no tool change");
        for b in &changes {
            assert!(b.op.is_none(), "a tool change was attributed to {:?}", b.op);
            let want = path.moves[b.move_index].text.trim();
            assert_eq!(
                b.tool.as_deref(),
                Some(want),
                "the change at line {} names {:?} in the program but reports {:?}",
                b.first_line,
                want,
                b.tool
            );
            // ...and it is genuinely a change, i.e. the program says so on one
            // of this block's own lines.
            let span: Vec<&str> =
                p.gcode.lines().skip(b.first_line - 1).take(b.lines).collect();
            assert!(
                span.iter().any(|l| l.trim() == "M0"),
                "a ToolChange block wrote no M0: {span:?}"
            );
        }
    }

    /// The feed a block reports IS the `F` word in force for it — the same
    /// number, not a number computed beside it.
    #[test]
    fn the_feed_a_block_reports_is_the_f_word_the_post_wrote() {
        for name in ["plate", "pocket", "multi-tool"] {
            let (p, _) = posted(name);
            let state = text_state(&p.gcode);
            let mut cutting = 0usize;
            for b in &p.blocks {
                let text_feed = state[b.first_line - 1].feed;
                match b.kind {
                    MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW | MoveKind::DrillCycle => {
                        let have = b.feed_mm_min.unwrap_or_else(|| {
                            panic!(
                                "{name}: cutting block {} at line {} carries no feed at all",
                                b.move_index, b.first_line
                            )
                        });
                        let want = text_feed.unwrap_or_else(|| {
                            panic!(
                                "{name}: no F word is in force at line {} — the program cuts at a \
                                 rate it never states",
                                b.first_line
                            )
                        });
                        // The post writes F to ONE decimal, so the text is the
                        // rounded form of the same number.
                        assert!(
                            (have - want).abs() < 0.05,
                            "{name}: block {} ({:?}) at line {} reports F{have}, the program says \
                             F{want} — the line is {:?}",
                            b.move_index,
                            b.kind,
                            b.first_line,
                            p.gcode.lines().nth(b.first_line - 1)
                        );
                        cutting += 1;
                    }
                    // 🔴 A rapid, a tool change and a probe carry NO feed, and
                    // the field must be absent rather than inheriting the modal
                    // one. A host dividing a rapid's length by the last cutting
                    // feed times it at a rate the machine never uses.
                    _ => assert!(
                        b.feed_mm_min.is_none(),
                        "{name}: a {:?} block at line {} reports F{:?} — a G0 has no F word",
                        b.kind,
                        b.first_line,
                        b.feed_mm_min
                    ),
                }
            }
            assert!(cutting > 10, "{name}: only {cutting} cutting blocks were checked");
        }
    }

    /// The line numbers are real: each block's span holds the lines that move
    /// commands, the spans do not overlap, and they run in order.
    #[test]
    fn a_blocks_line_span_holds_the_lines_that_move() {
        for name in ["plate", "multi-tool"] {
            let (p, path) = posted(name);
            let lines: Vec<&str> = p.gcode.lines().collect();
            let mut prev_end = 0usize;
            for b in &p.blocks {
                assert!(b.lines >= 1, "{name}: a block claiming zero lines was recorded");
                assert!(
                    b.first_line > prev_end,
                    "{name}: block {} starts at line {} but the previous block ended at {} — \
                     the spans overlap, so a line maps to two operations",
                    b.move_index,
                    b.first_line,
                    prev_end
                );
                assert!(
                    b.first_line - 1 + b.lines <= lines.len(),
                    "{name}: block {} claims lines {}..{} of a {}-line program",
                    b.move_index,
                    b.first_line,
                    b.first_line - 1 + b.lines,
                    lines.len()
                );
                let first = lines[b.first_line - 1].trim();
                let expect_prefix = match b.kind {
                    MoveKind::Rapid => Some("G0"),
                    MoveKind::Feed => Some("G1"),
                    MoveKind::ArcCW => Some("G2"),
                    MoveKind::ArcCCW => Some("G3"),
                    _ => None,
                };
                if let Some(pre) = expect_prefix {
                    // An arc is degraded to G1 when arcs are off; this fixture
                    // has them on, so the code must be the arc's own.
                    assert!(
                        first.starts_with(pre),
                        "{name}: block {} is a {:?} but line {} is {first:?}",
                        b.move_index,
                        b.kind,
                        b.first_line
                    );
                }
                prev_end = b.first_line - 1 + b.lines;
            }
            // Every block indexes a real move, and in order.
            let mut last_mi = None::<usize>;
            for b in &p.blocks {
                assert!(b.move_index < path.moves.len());
                assert_eq!(path.moves[b.move_index].kind, b.kind);
                if let Some(l) = last_mi {
                    assert!(b.move_index > l, "{name}: blocks are not in move order");
                }
                last_mi = Some(b.move_index);
            }
        }
    }

    /// A move that writes nothing gets no block — and a comment written with
    /// `emit_comments` off writes nothing.
    #[test]
    fn a_move_that_writes_no_line_gets_no_block() {
        let b = build("plate", JobPlant::None).unwrap();
        let r = plan_job(&b.job);
        let quiet = post_grblhal(
            &r.path,
            &b.job.machine,
            &b.job.stock,
            &OperationParams::default(),
            &PostOptions { emit_comments: false, ..b.job.post.clone() },
        );
        assert!(quiet.ok(), "{:?}", quiet.errors);
        for blk in &quiet.blocks {
            assert_ne!(
                blk.kind,
                MoveKind::Comment,
                "a comment produced a block with comments switched off"
            );
        }
        // 🔴 ...and the attribution SURVIVES the comments being off. The op
        // names come from the plan, not from the text, so a program with no
        // comments in it is still labelled — which is the reason the reader
        // takes `Move::text` and not the emitted line.
        assert!(
            quiet.blocks.iter().any(|b| b.op.is_some()),
            "with comments off, every block lost its operation — the attribution is reading the \
             emitted text rather than the plan"
        );
    }

    /// A refused program has no blocks, because it has no file.
    ///
    /// 🔴 The refusal used here is the one that DISCARDS the text — a
    /// non-finite coordinate — not merely one that reports an error beside it.
    /// A limit violation still returns the program (with `ok() == false`), and
    /// a block list is a map of whatever text came back; the case that must not
    /// leave a map behind is the one where there is nothing to map.
    #[test]
    fn a_refused_program_describes_no_lines() {
        let b = build("plate", JobPlant::None).unwrap();
        let mut r = plan_job(&b.job);
        // A coordinate that is not a number: the post returns before a byte is
        // written.
        let n = r.path.moves.len() / 2;
        r.path.moves[n].to.x = f64::NAN;
        let p = post_grblhal(
            &r.path,
            &b.job.machine,
            &b.job.stock,
            &OperationParams::default(),
            &b.job.post,
        );
        assert!(!p.ok(), "a NaN coordinate posted cleanly");
        assert!(p.gcode.is_empty(), "a refused program emitted G-code");
        assert!(p.blocks.is_empty(), "a refused program still described {} lines", p.blocks.len());
    }
}

// ---------------------------------------------------------------------------
// The Z DATUM — where Z0 is, asserted on the EMITTED PROGRAM.
//
// 🔴 Every test here reads the G-code text. A test that read `stock.z_datum`
// back would be asserting that a field holds what it was set to, which is the
// defect class this whole change exists to remove: `Stock::z_zero_at_top` held
// its value perfectly for two months and reached no emitted byte.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod z_datum_tests {
    use super::*;

    fn tool() -> Tool {
        Tool { name: "6mm".into(), diameter_mm: 6.0, flutes: 2, ..Tool::default() }
    }

    /// One peck-drilled hole, so the program contains a canned cycle.
    fn drill_path(depth_mm: f64) -> Toolpath {
        let mut p = Toolpath {
            moves: vec![
                Move::spindle_on(12_000.0),
                Move::drill(Vec3::new(60.0, 60.0, -depth_mm), 4.0, 600.0),
                Move::spindle_off(),
            ],
            tool: tool(),
            ..Default::default()
        };
        p.recompute_bounds();
        p
    }

    fn gcode(path: &Toolpath, machine: &Machine, stock: &Stock) -> PostResult {
        post_grblhal(path, machine, stock, &OperationParams::default(), &PostOptions::default())
    }

    /// The two drill DIALECTS must bottom the hole in the same place.
    ///
    /// # 🔴 `supports_canned_drill = false` was driven by NOTHING (2026-08-29)
    ///
    /// `post_grblhal` has two paths for one physical operation: `G98 G83 … Q` on
    /// a controller with canned cycles, and a hand-expanded peck ladder of
    /// `G1`/`G0` pairs on one without. Grepped across `core/`, `cli/` and
    /// `gates/`: **the `false` branch had no test and no gate**. Every program
    /// this repo has ever checked took the `G83` path.
    ///
    /// That is `DOOR`'s shape exactly — *"two different code paths into the
    /// planner for the same one cutter, and they do not agree"* — one layer
    /// down, in the post, where the bytes the machine executes are made. The
    /// failure it would hide is not subtle: a peck ladder that stops one step
    /// early leaves the hole blind, and one that repositions to the wrong Z
    /// rapids the drill into the bottom of its own hole.
    ///
    /// ⚠ Asserted on the EMITTED TEXT of both dialects, not on the settings that
    /// select them.
    #[test]
    fn both_drill_dialects_reach_the_same_depth_and_never_rapid_below_the_last_peck() {
        let stock = Stock { thickness_mm: 18.0, ..Stock::default() };
        let path = drill_path(18.0);

        let canned = Machine { supports_canned_drill: true, ..Machine::default() };
        let expanded = Machine { supports_canned_drill: false, ..Machine::default() };
        let a = gcode(&path, &canned, &stock);
        let b = gcode(&path, &expanded, &stock);
        assert!(a.ok() && b.ok(), "both dialects must post: {:?} {:?}", a.errors, b.errors);

        // The canned cycle states its bottom on the G83 line; the expanded one
        // reaches it as the last G1 Z. Both must be the same hole.
        let g83 = a
            .gcode
            .lines()
            .find(|l| l.contains("G83"))
            .unwrap_or_else(|| panic!("no canned cycle in:\n{}", a.gcode));
        let z_of = |line: &str, key: char| -> f64 {
            let i = line.find(key).expect("word present");
            line[i + 1..]
                .split_whitespace()
                .next()
                .unwrap()
                .parse()
                .expect("number")
        };
        let canned_bottom = z_of(g83, 'Z');

        let mut deepest_cut = 0.0_f64;
        let mut rapids_below_last_peck = Vec::new();
        let mut last_peck = 0.0_f64;
        for l in b.gcode.lines() {
            if l.starts_with("G1 Z") {
                let z = z_of(l, 'Z');
                deepest_cut = deepest_cut.min(z);
                last_peck = z;
            } else if l.starts_with("G0 Z") {
                let z = z_of(l, 'Z');
                // 🔴 A rapid BELOW the last cut depth drives the drill into the
                // bottom of its own hole at rapid rate. The reposition must stop
                // ABOVE it — the post uses `z + 0.5`.
                if z < last_peck - 1e-9 {
                    rapids_below_last_peck.push(format!("{l} (last cut {last_peck:.3})"));
                }
            }
        }

        assert!(
            (deepest_cut - canned_bottom).abs() < 1e-6,
            "the dialects bottom the hole in different places: G83 says Z{canned_bottom:.3} and \
             the expanded ladder reaches Z{deepest_cut:.3}. A ladder that stops early leaves the \
             hole blind and nothing downstream can tell"
        );
        assert!(
            rapids_below_last_peck.is_empty(),
            "the expanded peck rapids BELOW the depth it just cut, which drives the drill into \
             the bottom of its own hole at rapid rate: {rapids_below_last_peck:?}"
        );
        // And the ladder must actually be a ladder — one plunge to full depth is
        // not a peck, whatever the settings said.
        let plunges = b.gcode.lines().filter(|l| l.starts_with("G1 Z")).count();
        assert!(
            plunges >= 4,
            "the expanded dialect made {plunges} plunge(s) for an 18mm hole at 4mm peck — that is \
             not a peck cycle, it is a single full-depth plunge wearing its name"
        );
    }

    /// 🔴 THE CANNED CYCLE WAS THE SITE THAT ESCAPED, and it escaped through
    /// the CLI rather than through the post.
    ///
    /// Measured 2026-08-11 against the pre-change binary:
    /// `2bee-slice fixture drill-peck --spoilboard-zero` emitted
    /// `G0 Z5.000` and `G98 G83 … Z-18.000 R5.000` — **the whole program in the
    /// workpiece-top frame, with the flag accepted and silently doing nothing**,
    /// because `run_drill` built its own `PostOptions::default()` and never read
    /// it. A flag read by nothing reads as honoured.
    ///
    /// Moving the answer onto the setup closed that by construction. This test
    /// holds it closed, and it asserts on `R` as well as on `Z`: `R` is the
    /// retract PLANE, an absolute Z, and a shifted hole bottom with an unshifted
    /// retract plane is a rapid down through one workpiece thickness of material.
    #[test]
    fn a_canned_drill_cycle_moves_its_depth_and_its_retract_plane_with_the_datum() {
        let machine = Machine::default();
        let path = drill_path(18.0);
        let top = Stock::default();
        assert_eq!(top.z_datum, ZDatum::WorkpieceTop, "the default datum moved under this test");
        let bottom = Stock { z_datum: ZDatum::SpoilboardTop, ..Stock::default() };
        let t = gcode(&path, &machine, &top);
        let b = gcode(&path, &machine, &bottom);
        assert!(t.ok() && b.ok(), "the post refused: {:?} {:?}", t.errors, b.errors);

        let cycle = |g: &str| -> String {
            g.lines()
                .find(|l| l.contains("G83"))
                .unwrap_or_else(|| panic!("no canned cycle in:\n{g}"))
                .to_string()
        };
        assert!(
            cycle(&t.gcode).contains("Z-18.000") && cycle(&t.gcode).contains("R5.000"),
            "the top-datum cycle is not what this test assumed: {}",
            cycle(&t.gcode)
        );
        // +18 on both, and on nothing else in the line.
        assert!(
            cycle(&b.gcode).contains("Z0.000") && cycle(&b.gcode).contains("R23.000"),
            "the cycle did not move with the datum: {}",
            cycle(&b.gcode)
        );
        assert_eq!(
            cycle(&t.gcode).replace("Z-18.000", "Z*").replace("R5.000", "R*"),
            cycle(&b.gcode).replace("Z0.000", "Z*").replace("R23.000", "R*"),
            "the cycle changed somewhere other than in its two Z-plane words"
        );
    }

    /// 🔴 A NEW REFUSAL, not a translation — `docs/design-87-z-datum.md` §9
    /// item 6.
    ///
    /// [`check_machine_limits`] tests only how far DOWN a program goes and has
    /// never tested `path.max_z` at all. Under a workpiece-top datum the highest
    /// emitted Z is `safe_z`, so the untested half could not fail. Under a
    /// spoilboard datum it becomes `safe_z + thickness`, and on the `Desktop
    /// 3018` preset (45mm of Z travel) a 40mm workpiece puts the opening rapid
    /// on the limit.
    ///
    /// The pair matters as much as the refusal: the SAME job on the SAME machine
    /// must stay clean at the top datum, or the check is banning a workpiece
    /// rather than a frame.
    #[test]
    fn a_bottom_datum_that_rapids_past_the_top_of_z_travel_is_refused_and_only_then() {
        // A small machine, and a workpiece thick enough that safe-Z + thickness
        // clears its Z travel.
        let machine = Machine { travel_z_mm: 45.0, safe_z_mm: 5.0, ..Machine::default() };
        let path = drill_path(10.0);
        let thick = |datum| Stock { thickness_mm: 41.0, z_datum: datum, ..Stock::default() };

        let clean = check_emitted_z_ceiling(&path, &machine, &thick(ZDatum::WorkpieceTop));
        assert!(
            clean.is_empty(),
            "the top datum was refused, so this check is about the workpiece and not the frame: \
             {clean:?}"
        );

        let refused = check_emitted_z_ceiling(&path, &machine, &thick(ZDatum::SpoilboardTop));
        assert_eq!(refused.len(), 1, "expected exactly one ceiling refusal, got {refused:?}");
        assert!(
            refused[0].contains("46.000") && refused[0].contains("45.000"),
            "the refusal does not name the number it commands and the number it has: {}",
            refused[0]
        );

        // And it is FATAL, not advisory: the whole program is withheld.
        let posted = gcode(&path, &machine, &thick(ZDatum::SpoilboardTop));
        assert!(!posted.ok(), "a program that rapids past the Z limit was posted anyway");
        assert!(
            posted.errors.iter().any(|e| e.contains("Z travel")),
            "the post did not carry the ceiling refusal: {:?}",
            posted.errors
        );
    }

    /// 🔴 THE REACHABILITY THIS CHANGE OPENED, CLOSED IN THE SAME CHANGE.
    ///
    /// Before the datum moved onto `Stock`, a bottom datum and a corner plate
    /// could not be declared together: the only route to the datum was the
    /// CLI's `--spoilboard-zero`, which the `fixture` subcommand reads and which
    /// refuses `--config` by name. Now `job … --config` reaches both, and what
    /// it would emit is the program `design-87` §4.3 derives — the X/Y side
    /// descent one full workpiece thickness too high, the seeks sweeping air,
    /// `ALARM:5` with the Z datum set and X and Y unset.
    ///
    /// The correct descent depends on which surface the plate rests on, which is
    /// an open founder decision (§3). So it refuses, by name, and says why.
    #[test]
    fn an_xyz_probe_under_a_spoilboard_datum_is_refused_by_name() {
        let machine =
            Machine { probe_enabled: true, probe_plate: ProbePlate::Xyz, ..Machine::default() };
        let plate = CornerPlate {
            plate: TouchPlate { top_mm: 1.6, wall: PlateWall::Mm(10.0) },
            corner: ProbeCorner::FrontLeft,
            xy_depth_mm: 3.0,
        };
        let path = drill_path(10.0);

        // The control: the same fully-declared setup at the top datum posts.
        let top = Stock { corner_plate: Some(plate), ..Stock::default() };
        let ok = gcode(&path, &machine, &top);
        assert!(ok.ok(), "the control refused, so the test below proves nothing: {:?}", ok.errors);
        assert!(ok.gcode.contains("G38.2 X"), "the control emitted no X probe pass");

        let bottom = Stock { z_datum: ZDatum::SpoilboardTop, ..top.clone() };
        let refused = gcode(&path, &machine, &bottom);
        assert!(!refused.ok(), "an XYZ probe under a spoilboard datum was emitted");
        assert!(
            !refused.gcode.contains("G38.2 X"),
            "the refused program still contains the X probe pass it refused to plan"
        );
        assert!(
            refused.errors.iter().any(|e| e.contains("SPOILBOARD") && e.contains("XYZ")),
            "the refusal does not name the datum and the probe: {:?}",
            refused.errors
        );

        // ⚠ And a Z-ONLY probe at the same datum is NOT refused — an existing
        // setup must not acquire a refusal it cannot answer. Its `G10 L20 P1 Z`
        // is unchanged by the datum, which is correct under design-87 §3's P1
        // and P3 and wrong under P2, and that is the founder's open question
        // rather than this post's to settle.
        let z_only = Machine { probe_plate: ProbePlate::ZOnly, touch_plate_mm: Some(1.6), ..machine };
        let zres = gcode(&path, &z_only, &bottom);
        assert!(zres.ok(), "a Z-only probe at the spoilboard datum was refused: {:?}", zres.errors);
        assert!(
            zres.gcode.contains("G10 L20 P1 Z1.600"),
            "the Z datum line is not what §3 will decide on: {}",
            zres.gcode
        );
    }
}
