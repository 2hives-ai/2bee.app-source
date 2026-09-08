//! Reference jobs — the worked examples every host runs.
//!
//! 🔴 These live in the CORE, not in the CLI, so the browser and the command
//! line plan the SAME job from the SAME code. If each host owned its copy,
//! browser-vs-CLI parity (gate I1) would be comparing two programs that merely
//! look alike, and the gate would pass while they drifted.
//!
//! Job-level fixtures for the gate harness.
//!
//! These exercise the real engine end to end — geometry, operations, tool
//! changes, fixturing, simulation — as opposed to `fixture`, which drives the
//! post directly with a synthetic rectangle.
//!
//! Every `JobPlant` below produces a defect that a gate must catch. They live in
//! the shipping binary on purpose: a plant kept in a test-only build proves the
//! test build refuses it, which is not the thing anyone needs to know.

use crate::fixture::{Clamp, Fixturing};
use crate::geometry::{Contour, Part};
use crate::job::{plan_job, Job, JobResult};
use crate::layout::{Clearance, Layout, PlacedDrawing};
use crate::pocket::{clearing_loops, subtract};
use crate::toolpath::{dogbone_centres, marking_ops, operations_for_part, OpRole, Operation};
use crate::tools::{default_library, drill_for_hole, ToolCategory};
use crate::types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobPlant {
    None,
    /// 🔴 AN INVERTED PLANT: the planted defect is an ABSENCE, not a wrong value.
    ///
    /// Every other plant here adds something wrong — a gouge, an overlap, a
    /// missing tab — and the gate goes red because it can SEE it. An OBLIGATION
    /// gate has no such thing to see: what it guards is that the program SAYS
    /// something, so the only way to make it fail is to take the saying away.
    ///
    /// This disarms `unreachable_feature_note`, so a drawing whose slot the
    /// cutter cannot enter emits its program in silence — `ok=true`, `gouge=0`,
    /// 230 cutting moves, and 109.8mm² of the outline that will not exist in
    /// the part. That silence is the defect gate `REACH` exists to refuse.
    /// (`ml` hit the same inverted-plant shape on G15 the same night.)
    ReachBlind,
    /// Tabs off — the part comes loose under the spindle.
    NoTabs,
    /// A pocket outlined with one lap instead of cleared.
    OutlineOnly,
    /// A clamp moved on top of the part.
    CutClamp,
    /// A cut driven straight across a part that must survive.
    Gouge,
    /// A tool whose shank cannot enter the collet.
    OversizeShank,
    /// Tool change without re-referencing Z.
    NoReprobe,
    /// A 5.2mm hole "drilled" with the nearest available bit.
    WrongDrill,
    /// A pocket cut to a floor one pass short of the design depth. The design
    /// depth is unchanged, so this is a program that disagrees with the part.
    ShallowFloor,
    /// 🔴 The VERIFICATION mis-anchored, not the program.
    ///
    /// This plant changes no motion at all. It restores the pre-2026-08-08
    /// simulation harness: the height map nailed to the MACHINE origin while the
    /// toolpath handed to it is PLACED by the datum, and the keep/remove
    /// regions left workpiece-local. The G-code is byte-identical to the clean
    /// job's — only the answer about it changes, which is why nothing else in
    /// this gate suite can see it.
    ///
    /// It exists to arm gate DINV, and it is the only plant here whose defect
    /// is in the check rather than in the cut.
    BedAnchoredSim,
    /// 🔴 THE OVERLAP CHECK NOT RUN — the state every multi-drawing job was in
    /// before 2026-08-10, when there was no check to skip.
    ///
    /// Two parts cut from the same material post as one program: the first
    /// destroys the second's edge and leaves it loose under a 2.2 kW spindle
    /// while the program is still running. Nothing downstream notices, because
    /// every coordinate is a real coordinate of a real part.
    ///
    /// ⚠ INVERTED POLARITY, like `tool-substitute`: the clean run is REFUSED and
    /// the planted one EMITS. That is what makes it a control for a refusal —
    /// a plant that made a good job bad could not prove a refusal still fires.
    ///
    /// Reachable from no config file and no UI control — only from `nest
    /// --plant overlap-unchecked`, which gate MULTI drives.
    OverlapUnchecked,
    /// 🔴 The DRAWING OFFSET stored, reported, drawn — and dropped on the way to
    /// the program.
    ///
    /// `Job::place` discards `drawing_offset_*` while every host keeps echoing
    /// it back, so the panel says the part was moved 50mm and every coordinate
    /// the controller is handed is exactly where it was. It restores this lane's
    /// most-repeated defect — a setting that reads as applied and changes no
    /// emitted word — which is why gate MOVE asserts on the G-CODE TEXT and not
    /// on the field.
    ///
    /// ⚠ It emits a RUNNABLE program, like `tool-substitute` and unlike
    /// `undeclared-plate`: the planted job is byte-identical to an unmoved one.
    /// A gate limb that only checked "it still posts" would be green forever.
    DrawingOffsetIgnored,
    /// 🔴 The machine's touch plate left UNDECLARED while probing is on —
    /// `machine.touch_plate_mm = None`, which is what `Machine::default()` now
    /// carries.
    ///
    /// It restores the state the product ships in and the fixture deliberately
    /// steps out of, so what it proves is the REFUSAL: the post must produce no
    /// probe and no program rather than set the origin from a thickness nobody
    /// measured. Before 2026-08-09 there was nothing to plant — the field was a
    /// bare `f64` defaulting to an unsourced `1.6`, and this job would have
    /// emitted `G10 L20 P1 Z1.600` and run.
    ///
    /// ⚠ It is the inverse of every other plant here: the others put a defect
    /// INTO a good job, this one takes a declaration OUT of one. The gate limb
    /// therefore asserts a refusal and the ABSENCE of `G38`, not a bad number.
    UndeclaredPlate,
    /// 🔴 The SILENT TOOL SUBSTITUTION restored — a `tool_id` that resolves to
    /// nothing, swallowed, and the job planned with whatever cutter it was built
    /// with.
    ///
    /// This is the behaviour that shipped until 2026-08-09:
    /// `JobConfig::apply` looked the id up with `if let Some(t) = …find(…)` and
    /// **fell out of the `if let` when it missed**, so `job plate --config
    /// '{"tool_id":"endmill-6"}'` emitted a complete **11,978-byte** program at
    /// exit `0` with nothing anywhere saying the requested cutter did not exist.
    /// The operator asked for one tool and got another.
    ///
    /// ⚠ Its polarity is the opposite of [`JobPlant::UndeclaredPlate`]: that one
    /// removes a declaration and the gate asserts a REFUSAL, this one removes a
    /// refusal and the gate asserts a **RUNNABLE PROGRAM**. Gate `TOOL` runs the
    /// pair on every pass — planted must emit, unplanted must refuse — so a
    /// control that has gone blind is caught as loudly as a fix that has been
    /// reverted. A plant that quietly stopped planting would otherwise be
    /// indistinguishable from a codebase that is clean.
    ToolSubstitute,
    /// 🔴 The TOOL-GROUP ORDER put back to first appearance — the state the
    /// engine shipped in until 2026-08-09.
    ///
    /// `optimise_route` topologically sorts the tool groups so the tool doing a
    /// part's interior work runs before the tool that releases it. Before that,
    /// the groups ran in the order they happened to appear in the operation
    /// vector, so **the same operations, the same two tools and the same single
    /// tool change** produced a safe or a lethal program depending on nothing
    /// anybody chose. This plant restores that.
    ///
    /// ⚠ **It is only non-vacuous on a job that actually reorders**, which is
    /// why the `two-part` fixture exists: `plate`, `pocket`, `socket`,
    /// `multi-tool` and `clamped` produce **no** reorder, so this plant on any
    /// of them changes nothing and a control hung on it would run clean and
    /// read as passing. The core says which case it is —
    /// [`crate::optimise::PLANT_DIFFERENCE_KEY`] is `YES` or `NO` in the route
    /// notes — so gate REL asserts the plant bit rather than trusting the
    /// fixture to be the right shape.
    ReleaseOrder,
}

pub const JOB_PLANTS: &[(&str, &str)] = &[
    ("no-tabs", "tabs disabled — the part breaks loose"),
    ("outline-only", "a pocket outlined instead of cleared"),
    ("cut-clamp", "a clamp placed on top of the part"),
    ("gouge", "a cut driven across a part that must survive"),
    ("oversize-shank", "a 12mm shank on a 6mm collet"),
    ("no-reprobe", "a tool change with no Z re-reference"),
    ("wrong-drill", "a 5.2mm hole drilled with the nearest bit"),
    ("shallow-floor", "a pocket cut one pass short of its design floor"),
    (
        "bed-anchored-sim",
        "the height map nailed to the machine origin while the path is placed — the CHECK is wrong, the cut is not",
    ),
    (
        "undeclared-plate",
        "probing on with machine.touch_plate_mm undeclared — the datum nobody measured; must REFUSE",
    ),
    (
        "tool-substitute",
        "an unresolvable tool_id swallowed — the job cut with a cutter nobody chose; must EMIT (it is the defect restored)",
    ),
    (
        "drawing-offset-ignored",
        "the drawing offset stored and reported but dropped before the program — the part moves on screen and in no emitted coordinate; must EMIT (it is the defect restored)",
    ),
    (
        "overlap-unchecked",
        "two parts cut from the same material, checked by nothing — the second is scrap or a loose offcut under the spindle; must EMIT (it is the defect restored). Only non-vacuous on a drawing whose parts overlap",
    ),
    (
        "reach-blind",
        "the unreachable-material note suppressed — a slot narrower than the cutter is closed by the offset and the part comes out SOLID there, with nothing said; must EMIT (the program is clean and the silence is the defect)",
    ),
    (
        "release-order",
        "tool groups back in first-appearance order — a part released before its own holes are cut; must REFUSE. Only non-vacuous on `two-part` (the report states which)",
    ),
];

pub fn job_plant_from(s: &str) -> Option<JobPlant> {
    Some(match s {
        "none" => JobPlant::None,
        "no-tabs" => JobPlant::NoTabs,
        "outline-only" => JobPlant::OutlineOnly,
        "cut-clamp" => JobPlant::CutClamp,
        "gouge" => JobPlant::Gouge,
        "oversize-shank" => JobPlant::OversizeShank,
        "no-reprobe" => JobPlant::NoReprobe,
        "overlap-unchecked" => JobPlant::OverlapUnchecked,
        "reach-blind" => JobPlant::ReachBlind,
        "wrong-drill" => JobPlant::WrongDrill,
        "shallow-floor" => JobPlant::ShallowFloor,
        "bed-anchored-sim" => JobPlant::BedAnchoredSim,
        "drawing-offset-ignored" => JobPlant::DrawingOffsetIgnored,
        "undeclared-plate" => JobPlant::UndeclaredPlate,
        "tool-substitute" => JobPlant::ToolSubstitute,
        "release-order" => JobPlant::ReleaseOrder,
        _ => return None,
    })
}

// ===========================================================================
//  THE PLANT CONTRACT — what a plant must PROVE, not what it intends
// ===========================================================================
//
// 🔴 A plant that silently stops planting is a negative control that runs
// CLEAN and reads as a passing control. That turns this lane's core safety
// mechanism into decoration, and it has happened six separate ways in one
// session: a control nearly hung on a fixture that never exercises the hazard;
// `import --plant` swallowing the flag entirely; a browser control checked in
// the one state where it cannot fail; a parity control neutered by OUR OWN
// unrelated change three commits away; `cargo test` green 343/343 with a plant
// in place because the tests call the callee and `main()` had stopped calling
// it; and `job --config` accepted and discarded.
//
// The registry below is what closes it, and the reason it is a CONTRACT rather
// than a list of names is measured, not theoretical. Before 2026-08-09:
//
//   * `wrong-drill` changed NOTHING. It pushed a note reading
//     `PLANTED: a 5.2mm hole with no matching drill` and added no hole, no
//     operation and no motion — the emitted program was BYTE-IDENTICAL to the
//     clean one on all six jobs. It announced an injection it had never made,
//     and `SLICER-GATES.md` cited it as gate P5's negative control while P5
//     drove `drill-check 5.2` and never passed the flag.
//   * `no-reprobe` and `bed-anchored-sim` were driven by NO GATE at all —
//     armed only by unit tests, which is precisely the evidence class that
//     scored 343/343 through a live plant.
//   * Ten of the eighteen plants are INERT on most jobs. `cut-clamp` on
//     `plate`, `shallow-floor` on `socket`, `release-order` on any of the five
//     reference fixtures: applied, honoured, exit 0, program unchanged. A
//     control written against any of those pairs proves nothing and says so
//     nowhere.
//
// ⚠ **This registry deliberately does NOT record "the plant branch was
// reached".** That is the intent signal, and asserting on intent is the defect
// this lane has been bitten by five times (P3, P4, ENT, `JobSummary`, REL) —
// `wrong-drill`'s note IS an intent signal, and it was true while the plant did
// nothing. Every effect below is a CONSEQUENCE the gate observes from outside
// the core: a program that differs, a refusal with no program, a program where
// there was a refusal, or a verdict that moves. The core cannot fake any of
// them by claiming success.

/// What a plant must be observed to DO, from outside the binary.
///
/// The gate drives the plant on its declared target and asserts this. There is
/// no arm meaning "something changed somewhere" — a plant whose consequence
/// cannot be named is a plant nobody can check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlantEffect {
    /// Clean and planted both produce a program, and the programs must DIFFER.
    ProgramDiffers,
    /// Clean produces a program; planted is REFUSED with **empty stdout**.
    /// G13's property: the refusal must mean *no program exists*, not that a
    /// warning was printed above one.
    Refuses,
    /// 🔴 INVERTED — clean is REFUSED and planted produces a runnable program.
    /// This is the polarity of a plant that takes a safety refusal OUT.
    Emits,
    /// The program is byte-identical **by design** — the defect is in the
    /// CHECK, not in the cut — so the simulation VERDICT must move instead.
    VerdictDiffers,
    /// 🔴 INVERTED, FOR AN **OBLIGATION** GATE: the program is byte-identical and
    /// the verdict does not move — what disappears is a NAMED SENTENCE.
    ///
    /// Every arm above observes something the gate can SEE go wrong. An
    /// obligation gate guards that the program SAYS something, so its planted
    /// failure is an ABSENCE, and none of the arms above can express it: the
    /// cut is fine, the verdict is fine, and the defect is the silence.
    ///
    /// ⚠ IT IS STILL A CONSEQUENCE, NOT AN INTENT SIGNAL — which is the bar this
    /// registry sets and the reason it refuses "the plant branch was reached".
    /// The gate observes a specific note PRESENT on the clean run and ABSENT on
    /// the planted one, from outside the binary. The core cannot fake that by
    /// claiming success.
    NoteDisappears {
        /// A substring of the note that must vanish. Named, so a plant that
        /// silences some OTHER note cannot pass as this one.
        needle: &'static str,
    },
}

impl PlantEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            PlantEffect::ProgramDiffers => "program-differs",
            PlantEffect::Refuses => "refuses",
            PlantEffect::Emits => "emits",
            PlantEffect::VerdictDiffers => "verdict-differs",
            PlantEffect::NoteDisappears { .. } => "note-disappears",
        }
    }
}

/// One plant, and everything a gate needs to prove it still plants.
pub struct PlantContract {
    pub name: &'static str,
    /// The subcommand that can APPLY it. `import` is deliberately absent: the
    /// core's import path takes no plant argument, so `import --plant` refuses
    /// rather than honours (gate FLAG).
    pub host: &'static str,
    /// 🔴 The job or fixture this plant is NON-VACUOUS on. Not "a job it runs
    /// on" — the one where its consequence is observable. Ten of these plants
    /// exit 0 with an unchanged program on most targets.
    pub target: &'static str,
    /// A `--config` body required to make the plant bite, or `None`.
    /// Two plants need one and both would be VACUOUS without it:
    /// `bed-anchored-sim` is inert at datum 0 (every fixture's default — the
    /// exact state in which both halves of the defect it restores are inert),
    /// and `tool-substitute` needs the unresolvable id whose swallow it
    /// restores.
    pub config: Option<&'static str>,
    pub effect: PlantEffect,
    /// The gate that drives it. `""` means NO GATE CONSUMES IT — an orphan
    /// plant is a control nobody runs, and gate PLANT fails on one.
    pub gate: &'static str,
}

pub const PLANT_CONTRACTS: &[PlantContract] = &[
    // --- the post-level plants (`rect_profile::Plant`, host `fixture`) ------
    PlantContract {
        name: "offbed",
        host: "fixture",
        target: "rect-profile",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "G3",
    },
    PlantContract {
        name: "deep",
        host: "fixture",
        target: "rect-profile",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "G4",
    },
    PlantContract {
        name: "paren",
        host: "fixture",
        target: "rect-profile",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "G5",
    },
    PlantContract {
        name: "spindle-off",
        host: "fixture",
        target: "rect-profile",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "G6",
    },
    PlantContract {
        name: "rpm",
        host: "fixture",
        target: "rect-profile",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "SPIN",
    },
    PlantContract {
        // ⚠ `rect-profile`, not `rect-arcs`, would be the wrong target only by
        // luck: the plant refuses on both. It is declared on the fixture G8
        // actually drives, so the contract and the gate cannot disagree about
        // which program was proved.
        name: "arc-first",
        host: "fixture",
        target: "rect-arcs",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "G8",
    },
    // --- the job-level plants (`JobPlant`, host `job` unless stated) --------
    PlantContract {
        name: "no-tabs",
        host: "job",
        target: "plate",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "P1",
    },
    PlantContract {
        name: "outline-only",
        host: "job",
        target: "pocket",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "P2",
    },
    PlantContract {
        name: "cut-clamp",
        host: "job",
        target: "clamped",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "P7",
    },
    PlantContract {
        name: "gouge",
        host: "job",
        target: "plate",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "P9",
    },
    PlantContract {
        name: "oversize-shank",
        host: "job",
        target: "multi-tool",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "P6",
    },
    PlantContract {
        // 🔴 Was an ORPHAN until 2026-08-09 — registered, reachable from the
        // CLI, driven by no gate. `FUNCTIONAL-SPEC.md` D4 cites two unit tests,
        // and a unit test is the evidence class that passed 343/343 with a live
        // plant in `main()`.
        name: "no-reprobe",
        host: "job",
        target: "multi-tool",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "RPRB",
    },
    PlantContract {
        // 🔴 Was an ORPHAN and, worse, INERT: it added no hole and no
        // operation, so the program was byte-identical to clean on every job
        // while the note claimed a 5.2mm hole had been planted. It now plants
        // the hole.
        name: "wrong-drill",
        host: "job",
        target: "plate",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "P5",
    },
    PlantContract {
        name: "shallow-floor",
        host: "job",
        target: "pocket",
        config: None,
        effect: PlantEffect::ProgramDiffers,
        gate: "P3",
    },
    PlantContract {
        // 🔴 Was an ORPHAN despite its own doc comment saying "It exists to arm
        // gate DINV": DINV drove `--plant gouge` for its silence control and
        // never touched this one. And it is VACUOUS at datum 0 — the default
        // every fixture carries — which is why the config is not optional.
        name: "bed-anchored-sim",
        host: "job",
        target: "plate",
        config: Some(
            r#"{"machine":{"travel_x_mm":2000,"travel_y_mm":2000},"stock":{"origin_x_mm":150}}"#,
        ),
        effect: PlantEffect::VerdictDiffers,
        gate: "DINV",
    },
    PlantContract {
        // 🔴 THE ONLY INVERTED-OBLIGATION CONTRACT IN THIS TABLE. Its consequence
        // is a sentence that STOPS BEING SAID: the program is byte-identical,
        // the verdict does not move, and 109.8mm² of the outline still will not
        // exist in the part. `ml` hit the same shape on G15 the same night.
        name: "reach-blind",
        host: "nest",
        target: "gates/fixtures/notch-unreachable.dxf",
        config: Some(r#"{"tool_id":"End Mill - Down-cut 6mm 2F"}"#),
        effect: PlantEffect::NoteDisappears { needle: "CANNOT BE PRODUCED" },
        gate: "REACH",
    },
    PlantContract {
        name: "undeclared-plate",
        host: "job",
        target: "plate",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "PROBE",
    },
    PlantContract {
        // The one INVERTED plant: it removes a refusal, so the planted run must
        // EMIT. Driven through `job` here rather than `report` — `report`
        // always prints JSON, so "no program exists" is not observable on it,
        // and that is the property G13 makes load-bearing.
        name: "tool-substitute",
        host: "job",
        target: "plate",
        config: Some(r#"{"tool_id":"endmill-6"}"#),
        effect: PlantEffect::Emits,
        gate: "TOOL",
    },
    PlantContract {
        // 🔴 VACUOUS WITHOUT THE CONFIG, and for a sharper reason than
        // `bed-anchored-sim`'s: the thing this plant discards is zero by
        // default, so discarding it changes nothing and the control would run
        // clean forever while reading as armed. The config sets the offset the
        // plant then throws away.
        name: "drawing-offset-ignored",
        host: "job",
        target: "plate",
        config: Some(r#"{"drawing_offset":[50,25]}"#),
        effect: PlantEffect::ProgramDiffers,
        gate: "MOVE",
    },
    PlantContract {
        // 🔴 INVERTED POLARITY. The clean run is REFUSED — `overlap.dxf` holds
        // two rectangles sharing 50 x 80mm of material — and the planted one
        // EMITS, which is the state this whole path was built to leave behind.
        //
        // The target is a FILE and not a job name, because the interference
        // check only exists where drawings exist: a fixture job is geometry this
        // crate wrote, and there is no operator placing two of them. The config
        // names a cutter, without which `nest` refuses for a different reason
        // and the control would be proving the tool refusal instead.
        name: "overlap-unchecked",
        host: "nest",
        target: "gates/fixtures/overlap.dxf",
        config: Some(r#"{"tool_id":"End Mill - Down-cut 6mm 2F"}"#),
        effect: PlantEffect::Emits,
        gate: "MULTI",
    },
    PlantContract {
        name: "release-order",
        host: "job",
        target: "two-part",
        config: None,
        effect: PlantEffect::Refuses,
        gate: "REL",
    },
];

pub fn plant_contract(name: &str) -> Option<&'static PlantContract> {
    PLANT_CONTRACTS.iter().find(|c| c.name == name)
}

// ===========================================================================
//  IS THE PLANT STILL IN FORCE ON *THIS* RUN? — derived, per run, from effect
// ===========================================================================
//
// 🔴 THE DEFECT THIS CLOSES (measured at the CLI, 2026-08-12). `JobConfig::apply`
// runs AFTER `build`, and it overwrites the very fields the plants plant:
//
//   job multi-tool --plant oversize-shank                    -> exit 1, 5 refusals
//     + --config '{"tool_ids":[<two real cutters>]}'          -> exit 0, EMITTED
//   job clamped    --plant cut-clamp                          -> exit 1 (CutsClamp)
//     + --config '{"clamps":[]}'                              -> exit 0, EMITTED
//   job two-part   --plant release-order                      -> exit 1
//     + the same tool_ids config                              -> exit 0, EMITTED
//
// All three still printed `PLANTED: …` over a program that no longer contained
// the plant. **A plant is a negative control**: a disarmed one that still
// announces itself is a control REPORTING THAT IT FIRED WHEN IT DID NOT, which
// is the same family as every finding this lane filed the same week — a
// suppression test that passed over its own planted defect, a plant whose needle
// was absorbed by a comment, a plant that fired one step before the assertion it
// was meant to exercise. It is worse than those because it is in the FIXTURE
// LAYER, which every other plant in the crate rests on.
//
// ⚠ **The fix is not a louder note.** A note that admits the plant was
// overwritten still leaves a disarmed control, and any gate that consumes it
// inherits the same lie. A disarmed plant is a **FAILURE**: no program is
// emitted, the run exits non-zero, and the announcement is prefixed so it can no
// longer be read as a claim that the defect is present.
//
// 🔴 **AND THE DEPENDENCY IS DERIVED, NEVER LISTED.** A hand-kept table of
// "fields plant X needs" is the next thing to go stale — this lane has three
// examples of exactly that from one week. What is measured instead is the
// plant's OWN CONSEQUENCE, three times over:
//
//   1. plan this run WITH the plant and WITHOUT it, under the same config. If
//      the two are distinguishable in any observable a control may assert on,
//      the plant is in force and nothing else is computed.
//   2. if they are identical, plan the same pair with NO config. If the plant
//      bites there, the CONFIG is what removed it.
//   3. then ABLATE the config one top-level key at a time (through serde, so a
//      key added to `JobConfig` tomorrow is ablated tomorrow with no edit here)
//      and report the keys whose removal brings the bite back. *Those* are the
//      fields this plant depends on, on this job, today.
//
// Nothing here reads `PLANT_CONTRACTS` to make the decision. The registry is
// consulted only to make the REFUSAL more useful — to name the target the plant
// was declared non-vacuous on — and a wrong row there can only produce a worse
// message, never a wrong verdict.

/// The token a control asserts on when a plant was found not to be in force.
pub const PLANT_DISARMED_KEY: &str = "PLANT DISARMED";

/// The name a plant is spelled with on the command line.
///
/// Recovered from [`JOB_PLANTS`] through [`job_plant_from`] rather than written
/// out as a second match arm — a reverse mapping maintained by hand is one more
/// list to drift, and this one would drift silently because it is only ever read
/// inside a message.
pub fn job_plant_name(plant: JobPlant) -> &'static str {
    if plant == JobPlant::None {
        return "none";
    }
    JOB_PLANTS
        .iter()
        .find(|(n, _)| job_plant_from(n) == Some(plant))
        .map(|(n, _)| *n)
        .unwrap_or("(not in JOB_PLANTS)")
}

/// The observables a control is permitted to assert a plant's consequence on —
/// **one per arm of [`PlantEffect`], and deliberately no others.**
///
/// 🔴 `notes` is NOT here, and that is the whole point: the note is the
/// ANNOUNCEMENT, and an announcement is exactly as trustworthy as the intent
/// behind it. `wrong-drill` announced a 5.2mm hole it never added for its entire
/// life. Comparing notes would let a plant prove itself by talking.
///
/// ⚠ Nothing derived is listed either — `render`, `offered_fixes`, the distance
/// and time summaries are all functions of the program and the refusals, so a
/// difference in them is already a difference above. Adding a channel no gate
/// asserts on would let a plant "bite" through a door no control watches, which
/// is a green that means nothing.
#[allow(clippy::type_complexity)]
pub const PLANT_OBSERVABLES: &[(&str, fn(&Report) -> String)] = &[
    // `Refuses` and `Emits` — both directions of "is there a program at all".
    ("refusal", |r| format!("ok={} refusals={:?} errors={:?}", r.ok, r.refusals, r.errors)),
    // `ProgramDiffers` — the emitted text, which is the standing rule for this lane.
    ("program", |r| r.gcode.clone()),
    // `VerdictDiffers` — for the one plant whose defect is in the CHECK and
    // whose program is byte-identical by design.
    ("verdict", |r| format!("{:?}", r.sim)),
];

/// The `notes` observable, kept OUT of `PLANT_OBSERVABLES` on purpose.
///
/// 🔴 IT IS CONSULTED ONLY FOR A CONTRACT THAT DECLARES `NoteDisappears`.
/// Adding it to the global set was the first attempt and it was too blunt: it
/// made every plant that merely reworded a note read as "not inert", which
/// moved the ablation reasoning under two unrelated contracts (`cut-clamp`,
/// `release-order`) and broke their tests. **Widening what counts as a trace
/// weakens every disarmed-detection that was tuned to the narrow set** — the
/// plant framework's sensitivity is not a free parameter.
///
/// So an obligation plant gets the observable it needs and no other plant's
/// verdict moves. (`ml` hit the same inverted-plant wall on G15 the same night;
/// this is the narrow fix, not the global one.)
pub fn notes_observable(r: &Report) -> String {
    r.notes.join("\u{1f}")
}

/// Which observables separate two runs. Empty ⇒ they are indistinguishable to
/// every control that may assert on them.
fn observable_differences(a: &Report, b: &Report) -> Vec<&'static str> {
    PLANT_OBSERVABLES.iter().filter(|(_, f)| f(a) != f(b)).map(|(n, _)| *n).collect()
}

/// 🔴 Does the plant's **declared consequence** hold on this run — the one the
/// gate asserts, in the direction the gate asserts it?
///
/// "The plant changed something" is NOT the property a control rests on.
/// Measured 2026-08-12 on the other host:
///
/// ```text
/// fixture rect-profile --plant offbed                                  -> exit 1 (REFUSED)
/// fixture rect-profile --plant offbed --machine-x 5000 --machine-y 5000 -> exit 0, 959 bytes
/// ```
///
/// `offbed` shifts the part past the far edge of the X travel. On a machine wide
/// enough it still MOVES the part — so a bare "did anything change?" test is
/// satisfied — but it no longer produces the refusal gate G3 exists to watch.
/// **A plant that has stopped producing its declared consequence is disarmed
/// even though it is not inert**, and that is the harder half of this defect to
/// see.
///
/// ⚠ It is only asked on the target the contract declares the plant non-vacuous
/// on. Off-target the declared effect is simply the wrong question — `gouge` is
/// declared `program-differs` on `plate` and REFUSES on `clamped`, and neither
/// fact says anything about the other.
///
/// `verdict_available` is `false` for a host that runs no simulation. A plant
/// declaring `verdict-differs` there is reported as unprovable rather than
/// waved through: a check that cannot run is PENDING, never PASS.
pub fn declared_effect_holds(
    c: &PlantContract,
    planted_emitted: bool,
    clean_emitted: bool,
    programs_identical: bool,
    verdict_available: bool,
    verdicts_identical: bool,
    // `(clean_has_note, planted_has_note)` for a `NoteDisappears` contract.
    // `None` when the caller cannot read notes — PENDING, never PASS, on the
    // same terms `verdict_available: false` already is.
    note_presence: Option<(bool, bool)>,
) -> Result<(), String> {
    let head = |what: &str| {
        format!(
            "`--plant {}` is declared `{}` on `{}` (gate {}) and {what} on this run, so the \
             consequence the gate asserts is NOT the one this run produces",
            c.name,
            c.effect.as_str(),
            c.target,
            c.gate
        )
    };
    match c.effect {
        PlantEffect::Refuses if planted_emitted => {
            Err(head("it EMITTED a program instead of being refused"))
        }
        PlantEffect::Refuses if !clean_emitted => Err(head(
            "the same run WITHOUT the plant is refused too, so the refusal cannot be attributed \
             to the plant",
        )),
        PlantEffect::Emits if !planted_emitted => {
            Err(head("it was REFUSED instead of emitting the program it restores"))
        }
        PlantEffect::Emits if clean_emitted => Err(head(
            "the same run WITHOUT the plant emits as well, so there is no refusal for it to be \
             taking out",
        )),
        PlantEffect::ProgramDiffers if !planted_emitted || !clean_emitted => {
            Err(head("one of the two runs emitted no program at all to compare"))
        }
        PlantEffect::ProgramDiffers if programs_identical => {
            Err(head("the two programs are byte-identical"))
        }
        PlantEffect::VerdictDiffers if !verdict_available => Err(head(
            "this host runs no simulation, so the verdict it is declared to move cannot be read \
             here at all — PENDING, which is refused rather than passed",
        )),
        PlantEffect::VerdictDiffers if verdicts_identical => {
            Err(head("the simulation reached the same verdict either way"))
        }
        PlantEffect::VerdictDiffers if !programs_identical => Err(head(
            "the program MOVED, and this plant is declared to leave it byte-identical — whatever \
             it is now doing, it is not the check-only defect the gate reads",
        )),
        PlantEffect::NoteDisappears { .. } if note_presence.is_none() => Err(head(
            "this host cannot read the plan's notes, so the sentence this plant is declared to              remove cannot be observed here at all — PENDING, which is refused rather than passed",
        )),
        PlantEffect::NoteDisappears { .. } if !note_presence.map_or(false, |(clean, _)| clean) => {
            Err(head(
                "the CLEAN run does not carry the note this plant is declared to remove, so there                  was nothing to take away — a plant that silences an already-silent run proves                  the obligation is unmet, not that it is guarded",
            ))
        }
        PlantEffect::NoteDisappears { .. } if note_presence.map_or(true, |(_, planted)| planted) => {
            Err(head("the note is STILL THERE on the planted run"))
        }
        PlantEffect::NoteDisappears { .. } if !programs_identical => Err(head(
            "the program MOVED, and this plant is declared to leave it byte-identical — the whole              point is that the cut is fine and the SILENCE is the defect",
        )),
        _ => Ok(()),
    }
}

/// Whether the plant is in force on the run that was just planned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlantBite {
    /// No plant was asked for. Nothing to prove and nothing is claimed.
    NotPlanted,
    /// The planted run is distinguishable from the same run with the plant
    /// removed, in these observables. **The control is live.**
    Bit { plant: &'static str, differs_in: Vec<&'static str> },
    /// The planted run and the clean run are identical. The plant announced
    /// itself over a program that does not contain it.
    Disarmed { plant: &'static str, why: String },
    /// 🔴 The audit could not be run. **This refuses too** — a check that cannot
    /// run reports PENDING, never PASS, and here the only safe rendering of
    /// PENDING is the same refusal a failure gets: if we cannot tell whether the
    /// control fired, we must not emit a program under a `PLANTED:` note.
    Unchecked { plant: &'static str, why: String },
}

impl PlantBite {
    /// The refusal this verdict produces, or `None` when the run may stand.
    pub fn refusal(&self) -> Option<&str> {
        match self {
            PlantBite::Disarmed { why, .. } | PlantBite::Unchecked { why, .. } => Some(why),
            _ => None,
        }
    }

    /// Stop the plant's own announcement from claiming the plant is in force.
    ///
    /// ⚠ It PREFIXES and does not replace. The route note for `release-order`
    /// carries [`crate::optimise::PLANT_DIFFERENCE_KEY`], which gate REL reads;
    /// rewriting the sentence would take a gate's needle out from under it while
    /// fixing a different lie. The original words stay, under a heading that
    /// says they did not reach the program.
    pub fn rewrite_notes(&self, notes: &mut [String]) {
        if self.refusal().is_none() {
            return;
        }
        for n in notes.iter_mut() {
            if n.contains("PLANTED") {
                *n = format!(
                    "{PLANT_DISARMED_KEY} — THE CLAIM BELOW DID NOT REACH THIS PROGRAM: {n}"
                );
            }
        }
    }

    /// Fold the verdict into a report: a disarmed plant leaves **no program**.
    ///
    /// 🔴 `gcode` is CLEARED, not annotated. Gate G13's property is that a
    /// refusal means no program exists rather than a warning printed above one —
    /// somebody pipes stdout, ignores the exit code, and feeds the spindle a
    /// file. A disarmed negative control is a safety claim that was never
    /// earned, so it is refused on exactly those terms.
    pub fn enforce(&self, r: &mut Report) {
        let Some(why) = self.refusal() else { return };
        r.ok = false;
        r.gcode.clear();
        r.refusals.push(why.to_string());
        self.rewrite_notes(&mut r.notes);
    }
}

/// Every single-key ablation of a config, through serde.
///
/// 🔴 The key list comes from **serialising `JobConfig` itself**, so a field
/// added to that struct tomorrow is ablated tomorrow and nobody has to remember
/// this function exists. A hand-written list of keys here would be the same
/// hand-kept table the audit exists to avoid, one layer down.
///
/// A key already absent (serialised `null`) is skipped — dropping it changes
/// nothing, and reporting it would name a field the caller never sent.
fn config_ablations(cfg: &JobConfig) -> Vec<(String, JobConfig)> {
    let Ok(serde_json::Value::Object(map)) = serde_json::to_value(cfg) else {
        return Vec::new();
    };
    map.iter()
        .filter(|(_, v)| !v.is_null())
        .filter_map(|(k, _)| {
            let mut without = map.clone();
            without.insert(k.clone(), serde_json::Value::Null);
            serde_json::from_value::<JobConfig>(serde_json::Value::Object(without))
                .ok()
                .map(|c| (k.clone(), c))
        })
        .collect()
}

/// 🔴 **Did the plant still bite?** Answered from the plant's own effect on this
/// run, never from a declaration about it.
///
/// `plan` is the host's own planner — *the same call it just made for the run it
/// is about to print* — so the audit compares the program the operator would get
/// against the program they would have got without the plant, on this host, with
/// this config, including any host-level switch applied after the config. A
/// second planner here would be a second thing to drift.
///
/// It plans the job up to `2 + 2 + n` times (n = config keys) and it is called
/// **only when a plant was asked for**, which is the gate harness and nothing
/// else. `--plant` may not leak into a real job, so this cost is never on the
/// operator's path.
pub fn plant_audit<F>(target: &str, plant: JobPlant, cfg: &JobConfig, plan: F) -> PlantBite
where
    F: Fn(&JobConfig, JobPlant) -> Option<Report>,
{
    if plant == JobPlant::None {
        return PlantBite::NotPlanted;
    }
    let name = job_plant_name(plant);
    let pair = |c: &JobConfig| -> Option<(Report, Report)> {
        let planted = plan(c, plant)?;
        let clean = plan(c, JobPlant::None)?;
        Some((planted, clean))
    };
    let bites = |c: &JobConfig| -> Option<Vec<&'static str>> {
        let (planted, clean) = pair(c)?;
        Some(observable_differences(&planted, &clean))
    };

    let Some((planted, clean)) = pair(cfg) else {
        return PlantBite::Unchecked {
            plant: name,
            why: format!(
                "{PLANT_DISARMED_KEY} (PENDING, not a pass) — `--plant {name}` was applied and the \
                 audit that proves it is still in force COULD NOT RUN: planning the same job \
                 without the plant produced nothing to compare against. A control that cannot be \
                 checked is refused rather than emitted under a `PLANTED:` note"
            ),
        };
    };
    let mut differs = observable_differences(&planted, &clean);
    /* An obligation plant's only trace is a sentence that stopped being said,
     * and `PLANT_OBSERVABLES` deliberately does not carry notes — see
     * `notes_observable`. Consulted here, for the contracts that declare it. */
    if matches!(
        plant_contract(name).map(|c| c.effect),
        Some(PlantEffect::NoteDisappears { .. })
    ) && notes_observable(&planted) != notes_observable(&clean)
    {
        differs.push("notes");
    }
    if !differs.is_empty() {
        // 🔴 It changed SOMETHING. On the target its contract declares it
        // non-vacuous on, that is not enough: the change must be the CONSEQUENCE
        // THE GATE ASSERTS, in the direction it asserts it. See
        // `declared_effect_holds` for the run that produced this arm — a plant
        // that still moved the program while no longer producing the refusal its
        // gate reads.
        if let Some(c) = plant_contract(name).filter(|c| c.target == target) {
            let emitted = |r: &Report| r.ok && !r.gcode.is_empty();
            if let Err(why) = declared_effect_holds(
                c,
                emitted(&planted),
                emitted(&clean),
                planted.gcode == clean.gcode,
                true,
                format!("{:?}", planted.sim) == format!("{:?}", clean.sim),
                // This host CAN read notes, so a `NoteDisappears` contract is
                // observable here rather than PENDING. The needle comes from the
                // contract itself — a plant that silences some OTHER sentence
                // must not pass as this one.
                match c.effect {
                    PlantEffect::NoteDisappears { needle } => Some((
                        clean.notes.iter().any(|n| n.contains(needle)),
                        planted.notes.iter().any(|n| n.contains(needle)),
                    )),
                    _ => None,
                },
            ) {
                return PlantBite::Disarmed {
                    plant: name,
                    why: format!(
                        "{PLANT_DISARMED_KEY} — {why}. The run is NOT inert (it differs from the \
                         same run without the plant in {differs:?}), which is why nothing that \
                         merely asks \"did anything change?\" can see this. No program is emitted: \
                         a control watching for a consequence this run does not produce is \
                         switched off, whatever else the plant is doing"
                    ),
                };
            }
        }
        return PlantBite::Bit { plant: name, differs_in: differs };
    }

    // It did nothing on this run. TWO different reasons, with two different
    // fixes, and a message that blurred them would send half the readers to the
    // wrong one.
    let bare = JobConfig::default();
    let bites_bare = bites(&bare).map(|d| !d.is_empty()).unwrap_or(false);

    let observables: Vec<&str> = PLANT_OBSERVABLES.iter().map(|(n, _)| *n).collect();
    let head = format!(
        "{PLANT_DISARMED_KEY} — `--plant {name}` announced itself and this run contains no trace \
         of it: the planted run and the SAME run with the plant removed are IDENTICAL in every \
         observable a control may assert on ({}). The announcement describes a defect that is not \
         in this program, so no program is emitted — a negative control that has been switched off \
         is a FAILURE, not a footnote, and a gate consuming this run would otherwise inherit the \
         claim that it fired",
        observables.join(", ")
    );

    let why = if bites_bare {
        // The config removed it. Name the keys by ABLATION — derived from the
        // plant's own effect, not from a table of "fields plant X needs".
        let mut keys: Vec<String> = config_ablations(cfg)
            .into_iter()
            .filter(|(_, ablated)| bites(ablated).map(|d| !d.is_empty()).unwrap_or(false))
            .map(|(k, _)| k)
            .collect();
        keys.sort();
        if keys.is_empty() {
            format!(
                "{head}. DERIVED: the plant DOES bite on this job with no --config, so the config \
                 disarmed it — but no SINGLE key restores the bite when dropped, so it is the \
                 combination that removed it. Drop the config, or drive the plant on a job this \
                 config does not reach"
            )
        } else {
            format!(
                "{head}. DERIVED, by removing one config key at a time and re-planning: the plant \
                 bites again without `{}` — that is the field this plant depends on, on this job, \
                 measured on this run rather than looked up",
                keys.join("`, `")
            )
        }
    } else {
        let declared = plant_contract(name).map(|c| c.target).unwrap_or("(none declared)");
        let needs = plant_contract(name)
            .and_then(|c| c.config)
            .map(|c| format!(", with the config `{c}`"))
            .unwrap_or_default();
        format!(
            "{head}. DERIVED: the plant does not bite on this job WITH this config or WITHOUT one, \
             so the config is not what removed it — this is the wrong target. \
             PLANT_CONTRACTS declares `{name}` non-vacuous on `{declared}`{needs}"
        )
    };

    PlantBite::Disarmed { plant: name, why }
}

pub const JOBS: &[(&str, &str)] = &[
    ("plate", "200x120 plate, 4 holes, tabbed outer profile — one tool"),
    ("pocket", "plate with a 60x60 cleared pocket"),
    ("socket", "square socket with corner relief for a square tenon"),
    ("multi-tool", "6mm profile plus 3mm holes — one tool change"),
    ("clamped", "plate held by a pressure bar — fixture keepouts active"),
    (
        "two-part",
        "two parts on one workpiece: a plain blank the end mill releases, and a drilled part whose \
         holes need a second tool — the ONLY fixture that exercises cross-tool release ordering",
    ),
];

fn machine() -> Machine {
    Machine {
        collet_mm: 6.0,
        // The collets a small shop actually owns: 6mm fitted, plus 1/8", 1/4"
        // and 8mm in the drawer.
        spare_collets_mm: vec![3.175, 6.35, 8.0],
        probe_enabled: true,
        // 🔴 A FIXTURE CONSTANT, NOT A RECOMMENDATION AND NOT A DEFAULT. Do not
        // copy this number into a machine definition, a catalogue entry or a
        // UI placeholder.
        //
        // `Machine::default().touch_plate_mm` is `None` and is REFUSED
        // (decision #43 P0) — nobody may ship a plate thickness they have not
        // measured. These reference jobs need SOME declared plate to probe
        // against, and the value is arbitrary for a synthetic machine, so it is
        // the old default: that keeps every golden program byte-identical, so
        // this change moves no G-code and gate G1's hashes stay honest about
        // what actually changed.
        //
        // `--plant undeclared-plate` puts it back to `None`, which is how gate
        // PROBE watches the refusal go red.
        touch_plate_mm: Some(1.6),
        ..Machine::default()
    }
}

fn stock() -> Stock {
    Stock { size_x_mm: 600.0, size_y_mm: 900.0, thickness_mm: 18.0, ..Stock::default() }
}

fn end_mill(d: f64) -> Tool {
    let lib = default_library();
    lib.iter()
        .filter(|t| t.category() == ToolCategory::EndMill)
        .find(|t| (t.tool.diameter_mm - d).abs() < 1e-9)
        .map(|t| t.tool.clone())
        .unwrap_or_default()
}

fn params(plant: JobPlant) -> OperationParams {
    OperationParams {
        depth_total_mm: 18.0,
        depth_per_pass_mm: 4.0,
        tabs: TabSpec { enabled: plant != JobPlant::NoTabs, ..TabSpec::default() },
        ..OperationParams::default()
    }
}

/// What must SURVIVE: the part outline minus everything the job removes from
/// inside it.
///
/// 🔴 Passing the bare outline as `keep` reports every hole and pocket the job
/// is supposed to cut as a gouge — 2,496 of them on a clean plate. A check that
/// fires on every correct program is worse than no check, because it teaches
/// people to ignore the one time it is right.
fn keep_region(part: &Part, also_removed: &[Contour]) -> Vec<Contour> {
    let mut holes: Vec<Contour> = part.inners.clone();
    holes.extend_from_slice(also_removed);
    if holes.is_empty() {
        vec![part.outer.clone()]
    } else {
        subtract(&part.outer, &holes)
    }
}

/// The part every job is built around: a 200x120 plate with four 6mm holes.
fn plate() -> Part {
    let mut p = Part::new("plate", Contour::rect(60.0, 60.0, 200.0, 120.0));
    for (x, y) in [(90.0, 90.0), (230.0, 90.0), (230.0, 150.0), (90.0, 150.0)] {
        p = p.with_hole(Contour::circle(x, y, 3.0));
    }
    p
}

pub struct BuiltJob {
    pub job: Job,
    /// Corner reliefs this job will bore, reported so a gate can assert on the
    /// count without re-deriving the geometry.
    pub dogbones: Vec<(f64, f64)>,
    /// Regions that must survive — fed to the simulation as `keep`.
    pub keep: Vec<Contour>,
    /// Regions that must be gone, and to what depth.
    pub remove: Vec<Contour>,
    pub remove_depth_mm: f64,
    /// Notes the builder itself wants reported (a plant announcing itself).
    pub notes: Vec<String>,
    /// The plant this job was built with, carried so a plant whose defect lives
    /// in the VERIFICATION rather than in the motion can reach the verifier.
    /// Every real caller builds with [`JobPlant::None`].
    pub plant: JobPlant,
}

pub fn build(name: &str, plant: JobPlant) -> Option<BuiltJob> {
    let mut j = Job::new(name, machine(), stock());
    let p = params(plant);
    let mut keep = Vec::new();
    let mut remove = Vec::new();
    let mut remove_depth = 0.0;
    let mut notes = Vec::new();
    let mut dogbones: Vec<(f64, f64)> = Vec::new();

    // 🔴 Applied to the MACHINE, not to an operation, which is why it sits here
    // rather than in `params()`. It takes the fixture's declared plate back off
    // and leaves probing ON — the state `Machine::default()` ships in — so the
    // post has to refuse.
    if plant == JobPlant::UndeclaredPlate {
        j.machine.touch_plate_mm = None;
        notes.push(
            "PLANTED: machine.touch_plate_mm left UNDECLARED with probing enabled — the post must \
             REFUSE and emit no program"
                .into(),
        );
    }

    match name {
        "plate" => {
            let part = plate();
            // The plate body survives; the holes do not.
            keep.extend(keep_region(&part, &[]));
            // Part ID first: once the outline is cut the part is loose, and
            // marking a loose part pushes it out from under the tool.
            let (marks, bad) = marking_ops(&part, &end_mill(3.175), 8.0, 0.4, &p);
            if !bad.is_empty() {
                notes.push(format!(
                    "the part name contains {bad:?}, which the marking font cannot cut — \
                     those characters are NOT marked"
                ));
            }
            j.operations.extend(marks);
            j.operations.extend(operations_for_part(&part, &end_mill(6.0), &p));
        }

        "pocket" => {
            let part = plate();
            let pocket = Contour::rect(120.0, 90.0, 60.0, 60.0);
            keep.extend(keep_region(&part, &[pocket.clone()]));
            let tool = end_mill(6.0);
            // The DESIGN floor. `remove_depth` below stays at this value even
            // when the cut depth is planted short — the defect is a program
            // that disagrees with the part, and a plant that moved both would
            // be self-consistent and invisible.
            let design_depth = 6.0;
            let depth = if plant == JobPlant::ShallowFloor {
                notes.push(
                    "PLANTED: pocket cut to 3.0mm against a 6.0mm design floor".into(),
                );
                3.0
            } else {
                design_depth
            };

            let loops = if plant == JobPlant::OutlineOnly {
                notes.push("PLANTED: pocket outlined with a single lap, not cleared".into());
                pocket.offset(-tool.radius_mm())
            } else {
                clearing_loops(&pocket, &[], tool.radius_mm(), tool.diameter_mm * 0.45, 0.0)
            };

            /* 🔴 THE CHECK THAT CATCHES "OUTLINED, NOT CLEARED" NOW RUNS IN
             * PRODUCTION. `pocket::residual_island_mm` is documented in its own
             * module as *"the check that catches outlined, not cleared"*, and
             * the module header names that defect as the reason the module
             * exists — a 40x40 pocket cut with one lap leaves a 28x28 island
             * standing and the G-code looks perfectly reasonable.
             *
             * ⚠ Until 2026-09-07 its ONLY callers were two unit tests. The
             * safety net existed, was documented, had a negative control, and
             * was never wired to the one production caller — this one.
             *
             * 🔴 WHY IT IS SAFE TO APPLY HERE AND NOT EVERYWHERE, measured
             * rather than assumed: the function takes no island list, so a
             * LEGITIMATE boss reads as residual — a 10x10 island in a 60x60
             * pocket measures 10.000 mm, while the same pocket with no island
             * measures 0.000. A blanket check would therefore false-red on any
             * declared island, and a false red looks like diligence. This call
             * site passes NO islands (`&[]`), so here any residual is a real
             * uncleared region and the ambiguity does not arise. */
            /* ⚠ THE PLANT IS DELIBERATELY NOT EXCLUDED. My first version of this
             * guarded it out — which would have meant the one input built to
             * produce an uncleared pocket was the one input the check never saw.
             * `--plant outline-only` is the negative control for exactly this
             * finding, so it must fire on it. */
            {
                let residual = crate::pocket::residual_island_mm(&pocket, &loops, tool.radius_mm());
                if residual > 1.0 {
                    notes.push(format!(
                        "POCKET NOT CLEARED: {residual:.2} mm of material stands inside the pocket \
                         after clearing, and this pocket declares no island. One lap around a \
                         pocket leaves the middle standing and the G-code still reads as sensible.",
                    ));
                }
            }

            // Each clearing loop becomes an on-line operation: the offsets are
            // already at the tool centre, so applying a radius again would
            // double-compensate.
            for (i, lp) in loops.iter().enumerate() {
                j.operations.push(Operation {
                    name: format!("pocket-{}", i + 1),
                    // A clearing loop removes material INSIDE the pocket; it never
                    // frees the plate.
                    part: "pocket".into(),
                    role: OpRole::Interior,
                    contour: lp.clone(),
                    tool: tool.clone(),
                    params: OperationParams {
                        side: CutSide::OnLine,
                        depth_total_mm: depth,
                        depth_per_pass_mm: 3.0,
                        tabs: TabSpec { enabled: false, ..TabSpec::default() },
                        ..p.clone()
                    },
                });
            }
            remove.push(pocket);
            remove_depth = design_depth;
            j.operations.extend(operations_for_part(&part, &tool, &p));
        }

        "socket" => {
            let part = plate();
            let mut socket = Contour::rect(130.0, 95.0, 40.0, 40.0);
            let tool = end_mill(6.0);
            socket.normalise_winding(false);
            dogbones = dogbone_centres(&socket, tool.radius_mm(), DogboneStyle::Corner);

            // 🔴 The reliefs are INTENDED material removal and must come out of
            // the keep region, or the simulation reports every correctly
            // relieved socket as gouged — 349 cells on this job. A relief exists
            // precisely to cut past the nominal corner into the surrounding
            // material; that is what gives a square tenon somewhere to sit. A
            // check that fires on every correct program is worse than no check,
            // because it teaches people to scroll past it.
            let mut removed = vec![socket.clone()];
            for (cx, cy) in &dogbones {
                removed.push(Contour::circle(*cx, *cy, tool.radius_mm()));
            }
            keep.extend(keep_region(&part, &removed));
            j.operations.push(Operation {
                name: "socket".into(),
                // A blind socket in the face of the plate — inside work, and the
                // plate is not released by it.
                part: "socket".into(),
                role: OpRole::Interior,
                contour: socket,
                tool: tool.clone(),
                params: OperationParams {
                    side: CutSide::Inside,
                    dogbone: DogboneStyle::Corner,
                    tabs: TabSpec { enabled: false, ..TabSpec::default() },
                    ..p.clone()
                },
            });
            j.operations.extend(operations_for_part(&part, &tool, &p));
        }

        "multi-tool" => {
            let part = plate();
            keep.extend(keep_region(&part, &[]));
            let big = end_mill(6.0);
            let small = if plant == JobPlant::OversizeShank {
                notes.push("PLANTED: a 12mm-shank cutter on a 6mm collet".into());
                end_mill(12.0)
            } else {
                end_mill(3.175)
            };
            // Small tool first (holes), then the big one for the outline —
            // interior work before the part is released.
            for (i, h) in part.inners.iter().enumerate() {
                j.operations.push(Operation {
                    name: format!("hole{}", i + 1),
                    part: "plate".into(),
                    role: OpRole::Interior,
                    contour: h.clone(),
                    tool: small.clone(),
                    params: OperationParams { side: CutSide::Inside, ..p.clone() },
                });
            }
            j.operations.push(Operation {
                name: "plate".into(),
                part: "plate".into(),
                role: OpRole::Releasing,
                contour: part.outer.clone(),
                tool: big,
                params: OperationParams { side: CutSide::Outside, ..p.clone() },
            });
            j.probe_after_toolchange = plant != JobPlant::NoReprobe;
            if plant == JobPlant::NoReprobe {
                notes.push("PLANTED: no Z re-reference after the tool change".into());
            }
        }

        // 🔴 THE ONLY FIXTURE THAT EXERCISES CROSS-TOOL RELEASE ORDERING, and
        // the reason it had to exist before `--plant release-order` could mean
        // anything.
        //
        // Measured 2026-08-09 across all five of the fixtures above: none of
        // them produces a `tool groups reordered` note. Their first-appearance
        // order is already safe — `multi-tool` builds its holes before its
        // outline — so a plant hung on any of them would neuter a sort that was
        // never going to fire, run clean, and read as a passing control. That is
        // the vacuous control `--plant` exists to prevent, and it nearly got
        // manufactured while paying this very debt.
        //
        // The hazard needs TWO parts because it is an accident of *first
        // appearance*, and one part cannot produce that accident honestly: you
        // would have to write the outline before its own holes on purpose. Here
        // nobody does. The workpiece holds a plain blank at the left that needs only
        // the 6mm end mill, and a drilled part at the right whose four holes
        // need the 3.175mm cutter. Laid out left to right — the ordinary way a
        // nest comes out — the END MILL is the first-appearing tool, so the
        // pre-fix order cuts BOTH outlines first and the drilled part is loose
        // on its tabs while the second tool works inside it.
        "two-part" => {
            let blank = Part::new("blank", Contour::rect(60.0, 60.0, 200.0, 120.0));
            let mut drilled = Part::new("drilled", Contour::rect(300.0, 60.0, 150.0, 120.0));
            for (x, y) in [(330.0, 90.0), (420.0, 90.0), (330.0, 150.0), (420.0, 150.0)] {
                drilled = drilled.with_hole(Contour::circle(x, y, 3.0));
            }
            keep.extend(keep_region(&blank, &[]));
            keep.extend(keep_region(&drilled, &[]));

            let big = end_mill(6.0);
            let small = end_mill(3.175);

            // Left part first, then the right part's holes, then the right
            // part's outline. Nothing here is contrived to break: it is the
            // order a nest is naturally walked in, which is the whole point.
            j.operations.push(Operation {
                name: "blank".into(),
                part: "blank".into(),
                role: OpRole::Releasing,
                contour: blank.outer.clone(),
                tool: big.clone(),
                params: OperationParams { side: CutSide::Outside, ..p.clone() },
            });
            for (i, h) in drilled.inners.iter().enumerate() {
                j.operations.push(Operation {
                    name: format!("drilled-hole{}", i + 1),
                    part: "drilled".into(),
                    role: OpRole::Interior,
                    contour: h.clone(),
                    tool: small.clone(),
                    params: OperationParams { side: CutSide::Inside, ..p.clone() },
                });
            }
            j.operations.push(Operation {
                name: "drilled".into(),
                part: "drilled".into(),
                role: OpRole::Releasing,
                contour: drilled.outer.clone(),
                tool: big,
                params: OperationParams { side: CutSide::Outside, ..p.clone() },
            });
        }

        "clamped" => {
            let part = plate();
            keep.extend(keep_region(&part, &[]));
            j.operations = operations_for_part(&part, &end_mill(6.0), &p);
            j.fixturing = if plant == JobPlant::CutClamp {
                // Placed over the hole at (90,90) AND across the outline at
                // x=60, so both a drilled feature and a profile pass run into
                // it. An earlier version sat at x100..160 where the toolpath
                // never actually goes — the plant produced no finding and the
                // check looked broken when it was simply right.
                notes.push("PLANTED: a clamp sitting on top of the part".into());
                Fixturing {
                    clamps: vec![Clamp::new("bar-on-part", 50.0, 70.0, 60.0, 60.0, 40.0)],
                    confirmed_clear: false,
                }
            } else {
                Fixturing {
                    clamps: vec![
                        Clamp::new("bar-left", 5.0, 0.0, 40.0, 900.0, 40.0),
                        Clamp::new("bar-right", 400.0, 0.0, 40.0, 900.0, 40.0),
                    ],
                    confirmed_clear: false,
                }
            };
        }

        _ => return None,
    }

    if plant == JobPlant::Gouge {
        // A cut straight across the middle of the plate, which must survive.
        notes.push("PLANTED: a cut driven across the part".into());
        j.operations.push(Operation {
            name: "gouge".into(),
            // The plant is a cut ACROSS the plate. Declared Interior so it does
            // not accidentally acquire a releasing cut’s ordering privileges —
            // the plant must be caught by the simulator, not waved through by
            // the grouper.
            part: "plate".into(),
            role: OpRole::Interior,
            contour: Contour::open(vec![
                crate::geometry::Vertex::line(40.0, 120.0),
                crate::geometry::Vertex::line(280.0, 120.0),
            ]),
            tool: end_mill(6.0),
            params: OperationParams {
                side: CutSide::OnLine,
                entry: EntryMode::Plunge,
                tabs: TabSpec { enabled: false, ..TabSpec::default() },
                ..p.clone()
            },
        });
    }

    // 🔴 THIS PLANT USED TO BE A NOTE AND NOTHING ELSE, and it is the reason
    // `PLANT_CONTRACTS` asserts a CONSEQUENCE rather than an announcement.
    //
    // Until 2026-08-09 the whole body was the `notes.push` below. It added no
    // hole, no operation and no motion; the emitted program was BYTE-IDENTICAL
    // to the clean job's on all six fixtures, at exit 0. So the note read
    // `PLANTED: a 5.2mm hole with no matching drill` on a program containing no
    // such hole — a plant announcing an injection it had never made. Anything
    // hung on it would have been green forever, and `SLICER-GATES.md` cited it
    // as gate P5's negative control the entire time while P5 drove
    // `drill-check 5.2` and never passed the flag. *An intent signal is exactly
    // as trustworthy as the intent, which is to say not at all.*
    //
    // The hole is now real. 5.2mm has no drill in `default_library()` within
    // 0.1mm (P5's own question, via `drill_check`), and it is SMALLER than the
    // 6mm cutter the plate job runs, so the operation cannot be contoured
    // either. The engine has to refuse it — which is the guard P5 exists to
    // watch, now driven through the product path instead of a helper.
    if plant == JobPlant::WrongDrill {
        notes.push("PLANTED: a 5.2mm hole with no matching drill".into());
        j.operations.push(Operation {
            name: "wrong-drill-hole".into(),
            part: "plate".into(),
            role: OpRole::Interior,
            contour: Contour::circle(160.0, 120.0, 2.6),
            tool: end_mill(6.0),
            params: OperationParams { side: CutSide::Inside, ..p.clone() },
        });
    }

    // 🔴 Applied to the JOB, not to an operation: what is being restored is the
    // ORDER the tool groups run in, which is a property of the whole program.
    // Nothing else in this file — and nothing in the config, the CLI or the UI —
    // can set it. See `JobPlant::ReleaseOrder`.
    // 🔴 Applied to the JOB for the same reason as the order knob below: what is
    // being restored is a property of the whole program — that the offset never
    // reaches a coordinate. Nothing in the config, the CLI or the UI can set it.
    if plant == JobPlant::DrawingOffsetIgnored {
        j.plant_ignores_drawing_offset = true;
        notes.push(
            "PLANTED: the drawing offset is DISCARDED on the way to the program — it is still \
             stored and still reported, so the panel and the picture move and the emitted \
             coordinates do not. With no offset set this plant is VACUOUS; the gate limb that \
             uses it sets one"
                .into(),
        );
    }

    if plant == JobPlant::ReleaseOrder {
        j.group_order = crate::optimise::GroupOrder::FirstAppearance;
        notes.push(
            "PLANTED: tool-group ordering NEUTERED — first-appearance order restored. Whether \
             that is a defect on THIS job is stated by the route note, not assumed here"
                .into(),
        );
    }

    Some(BuiltJob { job: j, dogbones, keep, remove, remove_depth_mm: remove_depth, notes, plant })
}

/// Does the library hold a drill of exactly this size? Gate P5's question.
pub fn drill_check(hole_d: f64) -> Result<String, String> {
    let lib = default_library();
    match drill_for_hole(&lib, hole_d, 0.1) {
        Some(t) => Ok(t.id.clone()),
        None => Err(format!(
            "no drill matches a {hole_d}mm hole within 0.1mm — it must be interpolated with an \
             end mill, not drilled with the nearest size"
        )),
    }
}

pub fn run(b: &BuiltJob) -> JobResult {
    plan_job(&b.job)
}

/// Gate P8: a nest transform must carry the INTERNAL geometry, not just the
/// outline.
///
/// `build_nest.py` documents that it "drops internal holes", so a nested
/// outline is placement data, not machinable geometry. Piping it straight into
/// CAM cuts parts with no rabbets and no holes — and it looks correct, because
/// the outlines are right. This reproduces the transform and checks the holes
/// arrived with it.
pub fn nest_check(rot_deg: f64, dx: f64, dy: f64) -> Result<String, String> {
    let mut part = plate();
    let before: Vec<(f64, f64, f64, f64)> =
        part.inners.iter().filter_map(|h| h.bounds()).collect();
    if before.len() != 4 {
        return Err(format!("the source part has {} holes, expected 4", before.len()));
    }
    part.transform(rot_deg.to_radians(), dx, dy);
    let after: Vec<(f64, f64, f64, f64)> =
        part.inners.iter().filter_map(|h| h.bounds()).collect();
    if after.len() != before.len() {
        return Err(format!("{} holes before the transform, {} after", before.len(), after.len()));
    }
    // Every hole must have MOVED by the transform, not stayed behind.
    let (s, c) = rot_deg.to_radians().sin_cos();
    for (i, (b, a)) in before.iter().zip(after.iter()).enumerate() {
        let (bx, by) = ((b.0 + b.2) * 0.5, (b.1 + b.3) * 0.5);
        let (ax, ay) = ((a.0 + a.2) * 0.5, (a.1 + a.3) * 0.5);
        let (wx, wy) = (bx * c - by * s + dx, bx * s + by * c + dy);
        if (ax - wx).abs() > 1e-6 || (ay - wy).abs() > 1e-6 {
            return Err(format!(
                "hole {} landed at ({ax:.3}, {ay:.3}), the transform says ({wx:.3}, {wy:.3})",
                i + 1
            ));
        }
    }
    Ok(format!("{} holes carried through the transform intact", after.len()))
}

// ===========================================================================
//  Tool selection — refused, never substituted
// ===========================================================================
//
// 🔴 THE DEFECT THESE EXIST TO CLOSE (found 2026-08-09, at the code, on both
// hosts). Two different failures landed in one silent `unwrap_or_else`:
//
//   let tool = cfg.tool_id.as_ref()
//       .and_then(|id| default_library().iter().find(|t| &t.id == id) …)
//       .unwrap_or_else(|| end_mill(6.0));
//
// Measured at HEAD before the fix: `import plate.dxf` with **nothing chosen**
// planned a complete **9,390-byte** program at exit `0`, and
// `job plate --config '{"tool_id":"endmill-6"}'` planned **11,978 bytes** — in
// both cases the feeds, the depth per pass, the pass count, the collet check,
// the chipload clamp, every refusal that did NOT fire, and the emitted G-code
// were all derived from a Ø6mm end mill the operator never picked. It posts, it
// downloads, and it cuts.
//
// ⚠ **The two failures are kept APART, deliberately.** "You chose nothing" and
// "what you chose does not exist" are different facts with different fixes —
// the first sends the operator to the picker, the second to their spelling —
// and a shared message would send half of them to the wrong place. This lane
// already keeps such pairs distinct everywhere else (`undefined` vs `null` vs
// "row states no diameter" in the viewport; blank vs `0` for plate thickness;
// ABSENT vs UNPARSEABLE for `--z`), and the mistyped case is the WORSE of the
// two: an absent id at least corresponds to a choice nobody made, while an
// unresolvable one is a program that silently contradicts an explicit
// instruction.
//
// Both are refusals, not warnings. A warning above a program that still posts is
// gate G13's failure mode: somebody pipes stdout, ignores the exit code, and
// feeds a 2.2 kW spindle a file planned for a cutter that is not in the collet.

/// The phrase gate `TOOL` keys the ABSENT case on. Kept as a constant so the
/// gate and the tests cannot drift from the message the operator actually reads.
pub const NO_TOOL_SELECTED_KEY: &str = "no cutting tool was selected";
/// The phrase gate `TOOL` keys the UNRESOLVABLE case on.
pub const UNKNOWN_TOOL_KEY: &str = "is not a tool in the library";

/// Nobody picked a tool.
pub fn no_tool_selected_refusal() -> String {
    format!(
        "{NO_TOOL_SELECTED_KEY} — this program has nothing to cut with. Feeds, depth per pass, \
         pass count and every clearance in the emitted G-code are derived FROM the cutter, so \
         there is no program to plan until one is chosen. Set `tool_id` (one cutter for the whole \
         job) or `tool_ids` (a set, assigned per feature)"
    )
}

/// An id was given and resolves to nothing.
///
/// It names the id, says how big the library is, and offers the nearest ids it
/// does have — because an operator who typos `endmill-6` and is told only "not
/// found" tries it again. `extra_tools` are already merged into `lib` by the
/// caller, so a shop tool that was REJECTED as invalid is legitimately absent
/// here and the note explaining why travels in the same report.
pub fn unknown_tool_refusal(id: &str, lib: &[crate::tools::ToolSpec]) -> String {
    let near = nearest_tool_ids(id, lib, 3);
    let hint = if near.is_empty() {
        String::new()
    } else {
        format!(" The closest ids in the library are: {}.", near.join(" | "))
    };
    format!(
        "'{id}' {UNKNOWN_TOOL_KEY} — it was asked for by id and no tool has that id, so nothing \
         was assigned. The library holds {} tool(s).{hint} Planning on would cut this job with \
         whatever cutter the operations happened to be built with, which is not the one that was \
         asked for",
        lib.len()
    )
}

/// The ids most like `wanted`, best first, at most `n` of them.
///
/// Trigram Dice similarity over a normalised (lowercased, alphanumeric-only)
/// form. It is deliberately NOT a prefix or substring test: `endmill-6` shares
/// no whole token with `End Mill - Down-cut 6mm 2F`, and a containment check
/// would return nothing for exactly the typo class this is for. Anything below
/// the floor is dropped rather than padded out — three confident suggestions are
/// help, and three arbitrary ones are noise that reads as a shortlist.
fn nearest_tool_ids(wanted: &str, lib: &[crate::tools::ToolSpec], n: usize) -> Vec<String> {
    fn norm(s: &str) -> String {
        s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
    }
    fn trigrams(s: &str) -> Vec<[char; 3]> {
        let c: Vec<char> = s.chars().collect();
        c.windows(3).map(|w| [w[0], w[1], w[2]]).collect()
    }
    let w = trigrams(&norm(wanted));
    if w.is_empty() {
        return Vec::new();
    }
    // 0.30 keeps the end mills for `endmill-6` (~0.45) and drops the drills
    // (~0.09). A floor, not a ranking: below it the suggestion is worse than
    // silence.
    const FLOOR: f64 = 0.30;
    let mut scored: Vec<(f64, &str)> = lib
        .iter()
        .map(|t| {
            let g = trigrams(&norm(&t.id));
            let shared = w.iter().filter(|x| g.contains(x)).count() as f64;
            let dice = if g.is_empty() { 0.0 } else { 2.0 * shared / (w.len() + g.len()) as f64 };
            (dice, t.id.as_str())
        })
        .filter(|(d, _)| *d >= FLOOR)
        .collect();
    // Ties broken by id so the message is deterministic — gate K3 compares two
    // hosts byte for byte and a refusal is text the same as a program is.
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    scored.into_iter().take(n).map(|(_, id)| id.to_string()).collect()
}

/// The id every import test names, so none of them relies on a substitution.
///
/// 🔴 THIRTEEN TESTS WENT RED when the substitution was removed, and every one
/// of them was importing with `JobConfig::default()` — i.e. **passing no tool**
/// and asserting on a program planned with a Ø6mm end mill nobody had chosen.
/// They were not testing the substitution; they were unknowingly *depending* on
/// it, which is why none of them could ever have caught it. The fix is an
/// explicit id at each call site, **never an exemption for the test path** —
/// exempting the tests would have re-opened the hole in the only place that
/// looks at it.
///
/// It resolves to the same cutter the old `end_mill(6.0)` fallback returned —
/// that helper takes the first `EndMill` of diameter 6.0 from the same library —
/// so the emitted programs are byte-identical to the ones these tests were
/// written against. The assertions did not move; only the choice became
/// explicit.
#[cfg(test)]
const TEST_TOOL_ID: &str = "End Mill - Down-cut 6mm 2F";

/// [`JobConfig::default`] plus [`TEST_TOOL_ID`] — for tests that import.
#[cfg(test)]
fn cfg_with_a_chosen_tool() -> JobConfig {
    JobConfig { tool_id: Some(TEST_TOOL_ID.into()), ..JobConfig::default() }
}

// ===========================================================================
//  Configuration — the ONE path both hosts use.
// ===========================================================================

use serde::{Deserialize, Serialize};

/// Everything the UI can adjust, in one shape.
///
/// 🔴 This lives in the core and is applied by the core. If the browser applied
/// its own settings and the CLI applied its own, the two would drift and the
/// parity gate would be comparing two different programs that happen to share a
/// job name. Every field is optional: absent means "leave the reference job
/// alone", which is different from a zero.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct JobConfig {
    pub machine: Option<MachineCfg>,
    pub stock: Option<StockCfg>,
    pub clamps: Option<Vec<ClampCfg>>,
    /// An ordered sequence of clamping PHASES, for a multi-phase job where
    /// the work-holding changes mid-program.
    ///
    /// 🔴 When declared, the program is partitioned at phase boundaries. Each
    /// phase gets its own fixture check against its own clamp set, and after
    /// each boundary the program re-probes because the datum may have shifted.
    ///
    /// The safety property is the ORDER: new clamps go on before old ones come
    /// off. The first phase is the initial setup (no boundary); every
    /// subsequent phase inserts `M5` + comment + `M0` + re-probe.
    ///
    /// ⚠ Mutually exclusive with `clamps` — the phases carry their own clamp
    /// sets. Sending BOTH is a contradiction and is refused.
    pub clamp_phases: Option<Vec<ClampPhaseCfg>>,
    /// A human confirming the machine is clear. Never inferred from an empty clamp
    /// list — that is the distinction gate E5 exists for.
    pub confirmed_clear: Option<bool>,
    /// ONE cutter, and **the one-element spelling of [`Self::tool_ids`]** — not
    /// a second way in. Since 2026-08-11 a resolvable `tool_id` is prepended to
    /// the set and goes through `job::assign_tools_from_set` exactly as a set
    /// does, so the per-feature recommender runs on it and its refusals reach
    /// the planner.
    ///
    /// 🔴 It used to be a second planner — it wrote the tool onto every
    /// operation and returned before the check — and gate `DOOR` measured 66 of
    /// 306 (fixture x single tool) pairs where the two fields meant different
    /// things for the same cutter. See the collapse in [`Self::apply`] for the
    /// three classes and which door each proved right.
    pub tool_id: Option<String>,
    /// Several tools the job may use. The planner assigns them PER FEATURE via
    /// `recommend`, so a hole gets its drill and a profile gets its end mill.
    ///
    /// A config carrying BOTH fields is the **union**, `tool_id` first. There
    /// is no precedence left to state, because there is one fact — which
    /// cutters the user selected — and two spellings of it. `JobConfig` is
    /// `deny_unknown_fields`, so existing JSON is unaffected by the addition.
    pub tool_ids: Option<Vec<String>>,
    /// Tools the user added on top of the built-in library. They are matched by
    /// `id`, so an entry with an existing id REPLACES it — which is how a shop
    /// corrects a chipload it has measured rather than living with ours.
    pub extra_tools: Option<Vec<ToolCfg>>,
    /// `"Plywood" | "MDF" | "Hardwood" | "Softwood" | "Acrylic" | "Aluminium"`
    pub material: Option<String>,
    pub op: Option<OpCfg>,
    pub probe_after_toolchange: Option<bool>,
    /// Where the operator has dragged the GEOMETRY on the workpiece, `[x_mm, y_mm]`
    /// in **workpiece millimetres** — see [`crate::job::Job::drawing_offset_x_mm`].
    ///
    /// 🔴 NOT `stock.origin_*`, which moves the WORKPIECE on the machine and takes the
    /// work's relationship to the clamps with it. This moves the part on the
    /// workpiece and leaves the workpiece alone. Both reach the emitted coordinates;
    /// only one of them moves the touch plate hooked over the workpiece corner.
    ///
    /// Absent leaves the job alone, like every other field here. A non-finite
    /// value is REFUSED, not clamped: NaN compares false against every limit
    /// test, so a part placed there would pass the travel check having tested
    /// nothing, and drop silently out of every `min`/`max` that measures where
    /// the program goes.
    pub drawing_offset: Option<[f64; 2]>,
    /// **Leave an outline edge that lies on the workpiece edge UNCUT** — see
    /// [`crate::job::Job::use_workpiece_edge`], which this sets and which
    /// carries the whole argument for why it defaults OFF.
    ///
    /// 🔴 IT IS A JOB FIELD AND NOT AN [`OpCfg`] ONE, and the placement is the
    /// safety property rather than a filing preference. The decision is taken
    /// in [`crate::toolpath::plan_profile_with_edge_rule`] against the PLACED
    /// outline and the workpiece, so it is a fact about the SETUP — where the
    /// part sits on the material — not about how one operation cuts. Per
    /// operation it would let a job skip an edge on one profile and cut the
    /// same physical edge on another, which is a part held by a ribbon nobody
    /// asked for.
    ///
    /// Absent leaves the job alone, like every other field here. A host that
    /// sends `false` is DECLARING the option off, which is the same behaviour
    /// as absent today and stays honest if the default ever moves.
    pub use_workpiece_edge: Option<bool>,
    /// How close an outline edge must lie to the workpiece edge to count as
    /// coincident, in mm — see
    /// [`crate::job::Job::workpiece_edge_tolerance_mm`].
    ///
    /// 🔴 **NOT CLAMPED HERE, AND NOT VALIDATED HERE EITHER.** A non-finite or
    /// negative tolerance is REFUSED by [`crate::job::plan_job`] with the whole
    /// job, in the operator's own words, because that is where the rule is
    /// built and where a refusal reaches every host at once. Checking it a
    /// second time in this file would be a second copy of a rule that decides
    /// whether material is removed, and the two copies would drift.
    ///
    /// ⚠ Sending this WITHOUT [`use_workpiece_edge`](Self::use_workpiece_edge)
    /// changes nothing and is not an error: the job's own field is only read
    /// when the option is on. It is a stored preference, not a switch.
    pub workpiece_edge_tolerance_mm: Option<f64>,
    /// Clear material required BETWEEN two parts on the workpiece, on top of the
    /// cutter's own diameter, in millimetres.
    ///
    /// 🔴 It is not a preference and it is not a nesting nicety: two parts 3mm
    /// apart with a 6mm cutter have nowhere for the tool to go, and it takes the
    /// edge off BOTH. See [`NO_GAP_MARGIN_NOTE`] for what an ABSENT value means
    /// — the check still runs at the cutter diameter alone, and every report
    /// says on its face that no margin was declared. Absent is "not declared",
    /// which is a different fact from a declared zero, and only one of them is
    /// somebody's decision.
    ///
    /// ⚠ It has NOTHING to do with the travel margin, which is how far to stay
    /// off the machine's soft limits. One number answering two physical
    /// questions is a proxy bug: set 5mm of part spacing and you would silently
    /// have moved the whole program 5mm in off the soft limits as well.
    pub part_gap_margin_mm: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MachineCfg {
    pub name: Option<String>,
    pub travel_x_mm: Option<f64>,
    pub travel_y_mm: Option<f64>,
    pub travel_z_mm: Option<f64>,
    pub safe_z_mm: Option<f64>,
    pub rapid_mm_min: Option<f64>,
    pub max_feed_mm_min: Option<f64>,
    pub collet_mm: Option<f64>,
    pub spare_collets_mm: Option<Vec<f64>>,
    pub spindle_min_rpm: Option<f64>,
    pub spindle_max_rpm: Option<f64>,
    pub spindle_spinup_s: Option<f64>,
    pub probe_enabled: Option<bool>,
    /// The FIXED plate's TOP thickness. Feeds Z only.
    ///
    /// 🔴 NOT the corner plate's thickness — that is `stock.corner_plate.top_mm`,
    /// because a corner plate is a property of the setup and moves with the workpiece.
    pub touch_plate_mm: Option<f64>,
    /// `"z-only"` (default) or `"xyz"`. An XYZ plate additionally needs
    /// `stock.corner_plate` — the corner, the top and wall thicknesses and the
    /// side-probe descent — each REFUSED rather than guessed, because an X/Y
    /// probe touches with the SIDE of the cutter and carries the tool radius
    /// into every coordinate.
    pub probe_plate: Option<String>,
    /// Operator time charged for ONE manual tool change, in seconds — see
    /// [`crate::types::Machine::tool_change_seconds`], which this sets and which
    /// carries the whole argument for why it is a property of the machine and
    /// its operator rather than of a cutter or an operation.
    ///
    /// 🔴 **`None` = nobody declared it, and it is NOT the same fact as a
    /// declared value that happens to equal the default.** The estimate then
    /// falls back to [`crate::job::DEFAULT_TOOL_CHANGE_SECONDS`] and says on the
    /// report that it did — [`Report::tool_change_rate_declared`]. `Some(0.0)`
    /// declares an ATC and is reachable by choice, never by omission.
    ///
    /// ⚠ `JobConfig` and every struct in it is `deny_unknown_fields`, so a host
    /// sending this key before the field existed was **REJECTED OUTRIGHT** —
    /// the whole config, not just the key. That is why this landed here before
    /// any host was told to send it.
    pub tool_change_seconds: Option<f64>,
    pub supports_arcs: Option<bool>,
    pub supports_canned_drill: Option<bool>,
    /// Machine rigidity class — scales depth-of-cut. Recognised values:
    /// `"desktop"` (hobby frames, 0.5× depth), `"gantry"` (C-Beam/ACME, 1.0×,
    /// the default), `"industrial"` (heavy frames, 1.0× until coupon data
    /// exists). Unrecognised values are ignored with a note.
    pub machine_class: Option<String>,
    /// The sacrificial board on this machine — **size AND position AND
    /// thickness**.
    ///
    /// Absent leaves the job alone, like every other field here, and the job's
    /// own default is **no board declared**, reported as UNCHECKED. See
    /// [`SpoilboardCfg`].
    pub spoilboard: Option<SpoilboardCfg>,
}

/// Where the spoilboard IS on this machine, and which board it is.
///
/// 🔴 **THE POSITION IS ALWAYS THE CALLER'S AND HAS NO DEFAULT.** `0,0` is
/// plausible and plausible is the dangerous kind here: it slides the declared
/// board toward the datum, which turns bare rail into declared spoilboard and
/// makes a strike on the frame report as an intended sacrificial pass. A board
/// is bolted where the T-slots let it go and the operator measures it with a
/// tape, exactly as they do the workpiece datum.
///
/// Two ways to say which board, and **they may not be combined**:
///
/// * `catalogue_id` — an id from [`crate::spoilboards::catalogue`], which
///   supplies the size, the name **and the sourced thickness** from an entry
///   whose numbers were read off a page that is cited;
/// * `size_x_mm` + `size_y_mm` (+ optional `name`, + optional `thickness_mm`) —
///   a board this lane has never seen, measured by the shop.
///
/// 🔴 `thickness_mm` belongs to the SECOND form only, and combining it with
/// `catalogue_id` is refused for the same reason a size is: the entry already
/// states one, and there is no rule for which of two numbers about one slab
/// wins. **A thickness may still be OMITTED from the measured form** — that
/// installs the board with an unknown slab, which is a sayable answer
/// ([`crate::sim::SpoilboardDepth`] reports PENDING) and is not the same as a
/// refusal.
///
/// 🔴 An unknown id, or both forms at once, installs **NOTHING** and says so in
/// `notes`. It is deliberately not a near-miss substitution: `core/src/fixtures.rs`
/// once resolved an unknown TOOL id with `.unwrap_or_else(|| end_mill(6.0))` and
/// planned a complete 9,390-byte program on a cutter nobody asked for, exit 0,
/// nothing in `notes`. A substituted spoilboard is the same shape of defect — a
/// rectangle in the wrong place — and the rectangle is the entire check. Falling
/// back to *undeclared* is the safe direction: the position limb then reports
/// UNCHECKED, which is loud, instead of vouching for a board that is not there.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SpoilboardCfg {
    /// An id from the sourced catalogue. Mutually exclusive with `size_*`.
    pub catalogue_id: Option<String>,
    /// What the operator calls this board. Optional with `catalogue_id` (the
    /// entry's label is used); optional without it (a generic name is used).
    pub name: Option<String>,
    /// Lower-left corner, machine coordinates. **Required** — see the type doc.
    pub x_mm: Option<f64>,
    pub y_mm: Option<f64>,
    pub size_x_mm: Option<f64>,
    pub size_y_mm: Option<f64>,
    /// **How thick the slab is** — the one property of a measured board that no
    /// host could state until now.
    ///
    /// 🔴 **WITHOUT THIS FIELD THE DEPTH CHECK WAS STRUCTURALLY UNREACHABLE FOR
    /// A MEASURED BOARD**, and that is why it is here. Before it, a thickness
    /// could arrive from exactly one place — [`crate::spoilboards::SpoilboardSpec::install_at`]
    /// — so the only boards that could answer *"did the cutter go through into
    /// the machine?"* were the four in the catalogue, all of them 12mm or
    /// thicker. A shop with a real board it had measured itself could declare
    /// the rectangle and **could not declare the slab**, so
    /// [`crate::sim::SpoilboardDepth`] reported PENDING on every such job
    /// forever. A check nobody can reach from a config file is a check that does
    /// not exist.
    ///
    /// 🔴 **ABSENT IS UNKNOWN, NEVER "THICK ENOUGH"** — the rule belongs to
    /// [`crate::types::Spoilboard::thickness_mm`] and this field does not soften
    /// it. Omitting it installs the board with `None`, the depth limb reports
    /// **PENDING with the reason**, and the position limb is untouched.
    ///
    /// ⚠ **A present-but-unusable value — zero, negative, non-finite — is NOT
    /// refused here and the board still installs.** Somebody typed a thickness
    /// and that is a different fact from never having said; it is reported by
    /// [`crate::types::Spoilboard::thickness_faults`] and reaches `notes`, while
    /// the RECTANGLE stays valid. Refusing the declaration over it would switch
    /// off the answer to *"is there a board under this XY at all"* because of a
    /// number that has nothing to do with that question — the blur the two
    /// separate fault lists exist to prevent, arriving through the config.
    ///
    /// 🔴 **It may NOT be combined with `catalogue_id`**, exactly as `size_*`
    /// may not: a catalogue entry already carries a *sourced* thickness, and two
    /// numbers for one slab have no rule for which wins. A board that has been
    /// dressed thinner than its catalogue nominal is no longer the catalogue's
    /// board — declare it as a measured one, with `size_x_mm` + `size_y_mm` +
    /// this field, and give it a `name`.
    pub thickness_mm: Option<f64>,
}

impl SpoilboardCfg {
    /// Resolve to a board, or say why not.
    ///
    /// `Ok(None)` is impossible on purpose: either a board is installed or the
    /// caller is told, in words, that nothing was — there is no silent third
    /// outcome. A `Err` leaves the machine's spoilboard exactly as it was, which
    /// for every existing job is `None` = UNCHECKED.
    pub fn resolve(&self) -> Result<crate::types::Spoilboard, String> {
        let has_id = self.catalogue_id.is_some();
        let has_size = self.size_x_mm.is_some() || self.size_y_mm.is_some();
        if has_id && has_size {
            return Err(format!(
                "spoilboard declares BOTH a catalogue id ({:?}) and an explicit size — those are \
                 two different claims about one board and there is no rule for which wins. \
                 Nothing was installed, so the spoilboard position check reports UNCHECKED \
                 rather than guessing. State one or the other",
                self.catalogue_id
            ));
        }
        // 🔴 The SAME rule as the size, applied to the slab. A catalogue entry
        // carries a thickness read off the page it cites; a second number beside
        // it is a second claim about one board, and picking one silently is how
        // a nominal 18 gets overwritten by a stale 18-that-was-really-15 — or
        // the reverse, which asserts sacrificial material where there is frame.
        //
        // ⚠ It is REFUSED rather than ignored on purpose: a key that is accepted
        // and discarded is worse than one that errors, because the operator, the
        // script and the gate all believe it took. The fix is named in the
        // message — a dressed board is no longer the catalogue's board.
        if has_id && self.thickness_mm.is_some() {
            return Err(format!(
                "spoilboard declares BOTH a catalogue id ({:?}) and an explicit thickness \
                 ({:?}mm) — the catalogue entry already states a thickness read off the page it \
                 cites, and two numbers for one slab have no rule for which wins. Nothing was \
                 installed, so BOTH spoilboard limbs report UNCHECKED rather than guessing. If \
                 this board has been dressed thinner than its nominal size it is no longer that \
                 catalogue board: declare it measured, with size_x_mm + size_y_mm + thickness_mm \
                 and a name",
                self.catalogue_id, self.thickness_mm
            ));
        }
        let (Some(x), Some(y)) = (self.x_mm, self.y_mm) else {
            return Err(
                "spoilboard declares no position (x_mm, y_mm) on the machine. A size alone \
                 cannot answer 'is there sacrificial material under this XY', which is the only \
                 question this declaration exists for, and 0,0 is not a safe default: it slides \
                 the board toward the datum and turns bare rail into declared spoilboard. \
                 Nothing was installed"
                    .to_string(),
            );
        };
        if !x.is_finite() || !y.is_finite() {
            return Err(format!(
                "spoilboard position is not a place on the machine (x{x} y{y}) — nothing installed"
            ));
        }

        let board = if let Some(id) = &self.catalogue_id {
            let Some(spec) = crate::spoilboards::by_id(id) else {
                return Err(format!(
                    "spoilboard catalogue id '{id}' is not in the catalogue. It was NOT replaced \
                     with a nearby board: a substituted spoilboard is a rectangle in the wrong \
                     place, and the rectangle is the whole check. Nothing was installed, so the \
                     position limb reports UNCHECKED. Known ids: {}",
                    crate::spoilboards::catalogue()
                        .iter()
                        .map(|s| s.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            };
            let mut b = spec.install_at(x, y);
            if let Some(n) = &self.name {
                b.name = n.clone();
            }
            b
        } else {
            let (Some(sx), Some(sy)) = (self.size_x_mm, self.size_y_mm) else {
                return Err(
                    "spoilboard declares neither a catalogue id nor BOTH size_x_mm and \
                     size_y_mm. One axis of a rectangle is not a rectangle, and the missing axis \
                     has no plausible value that is not a guess about a physical workpiece. Nothing \
                     was installed"
                        .to_string(),
                );
            };
            let b = crate::types::Spoilboard::new(
                self.name.clone().unwrap_or_else(|| "spoilboard".to_string()),
                x,
                y,
                sx,
                sy,
            );
            // 🔴 THE SLAB, CARRIED ACROSS RATHER THAN DROPPED — and dropped is
            // exactly what it was: `Spoilboard::new` sets `thickness_mm: None`
            // by design, so a measured board declared here arrived with an
            // UNKNOWN thickness no matter what the config said, and the depth
            // limb reported PENDING on every one of them.
            //
            // ⚠ `with_thickness` DOES NOT VALIDATE, deliberately. A zero,
            // negative or non-finite value installs and is reported by
            // `Spoilboard::thickness_faults` — "somebody typed a thickness and
            // this is not one" is a different fact from "nobody said", and only
            // the second is an absence. Silently discarding it here would leave
            // the caller believing it took, which is the defect this whole file
            // refuses to commit with tool ids and spoilboard rectangles.
            match self.thickness_mm {
                Some(t) => b.with_thickness(t),
                None => b,
            }
        };

        // A declaration that resolves to a faulted rectangle is refused HERE,
        // where the operator can be told what they typed — rather than reaching
        // `sim::check`, which would drop it and report UNCHECKED with no clue
        // that anything had been declared at all.
        let faults = board.faults();
        if !faults.is_empty() {
            return Err(format!("{} — nothing installed", faults.join("; ")));
        }
        Ok(board)
    }
}

/// The touch plate hooked over a corner of THE WORKPIECE.
///
/// 🔴 IT SITS UNDER `stock`, NOT UNDER `machine`, and that is the whole point:
/// it moves when the workpiece moves. Its position on the machine is never stored — the core
/// derives it from the workpiece's own placement each time, so a dragged or turned
/// workpiece cannot leave its datum behind.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CornerPlateCfg {
    /// `"front-left" | "front-right" | "back-left" | "back-right"`, naming a
    /// corner of the WORKPIECE. No default: a program that assumes the wrong corner
    /// drives the cutter INTO the plate.
    pub corner: Option<String>,
    /// The plate's TOP thickness. Feeds Z.
    pub top_mm: Option<f64>,
    /// The plate's WALL thickness. Feeds X and Y. 🔴 A DIFFERENT NUMBER from
    /// `top_mm`, and one field labelled "thickness" is the defect this pair
    /// exists to prevent.
    ///
    /// Absent = NOT DECLARED and refused. To say the plate genuinely HAS no wall
    /// — a bore or chamfer plate — set `wall_absent: true` instead; that is a
    /// different fact and gets a different refusal, because corner probing needs
    /// an outer face and such a plate has none.
    pub wall_mm: Option<f64>,
    /// `true` = this plate has NO outer reference face at all. Not the same as
    /// omitting `wall_mm`. Setting both is a contradiction and is reported.
    pub wall_absent: Option<bool>,
    /// How far BELOW the plate's top face the side probe descends before moving
    /// in. Probing at the top face passes over the plate and touches nothing.
    pub xy_depth_mm: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StockCfg {
    pub size_x_mm: Option<f64>,
    pub size_y_mm: Option<f64>,
    pub thickness_mm: Option<f64>,
    pub origin_x_mm: Option<f64>,
    pub origin_y_mm: Option<f64>,
    /// How the workpiece is laid on the machine, degrees anticlockwise. Quarter turns
    /// are exact; anything else plans fine and warns, because it cannot be
    /// registered against the machine's axes.
    pub rotation_deg: Option<f64>,
    pub z_zero_at_top: Option<bool>,
    /// A touch plate hooked over a corner of this workpiece. Absent = not declared,
    /// and an `"xyz"` machine with no corner plate is REFUSED.
    pub corner_plate: Option<CornerPlateCfg>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClampCfg {
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub height_mm: f64,
    /// How the clamp is turned on the spoilboard, degrees anticlockwise about its own
    /// `(x, y)` anchor — the same sign and the same pivot as
    /// [`crate::types::Stock::rotation_deg`], so the workpiece and the clamps cannot
    /// disagree about which way is positive.
    ///
    /// `serde(default)` is `0.0` = square to the machine's axes, so every config written
    /// before this field existed still means exactly what it meant.
    ///
    /// 🔴 This field is only half of the seam. It is READ BACK in the report
    /// (`report_of`) as well as applied in [`JobConfig::apply`], because the
    /// viewport draws clamps from the report: a rotation that reaches
    /// `Clamp::rotated` but not the echo gives the browser a picture of an
    /// UN-turned clamp over a keepout that turned — the same look-right /
    /// checked-wrong failure gate `P7R` exists for, arriving through the host
    /// instead of through the geometry.
    pub rotation_deg: f64,
}

/// One phase in a multi-phase clamping sequence.
///
/// 🔴 THE SAFETY PROPERTY IS THE ORDER. The job declares an ordered sequence
/// of clamp states — phase 0 holds {A,B,C}, phase 1 holds {A,B,D} — and the
/// program is partitioned to match. At each boundary, *new clamp on before old
/// clamp off* is a diff between consecutive states, so a sequence that ever
/// drops below the required restraint can be refused rather than described in a
/// comment nobody has to read.
///
/// The first phase requires no boundary (it IS the initial setup). Every
/// subsequent phase inserts `M5` + comment + `M0` + re-probe before its first
/// cut.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ClampPhaseCfg {
    /// The clamps present during this phase. Each entry is a `ClampCfg`.
    pub clamps: Vec<ClampCfg>,
    /// An optional human-readable note emitted as a comment at the boundary
    /// (e.g. "remove centre clamp, add right stop").
    pub note: Option<String>,
}

/// A user-supplied tool. Every field is required: a tool missing its chipload
/// window cannot have a feed derived for it, and defaulting one silently is how
/// a cutter ends up fed at somebody else's numbers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCfg {
    pub id: String,
    pub category: String,
    pub diameter_mm: f64,
    pub flutes: u32,
    pub shank_mm: f64,
    pub cutting_length_mm: f64,
    pub chipload_mm: f64,
    pub chipload_min_mm: f64,
    pub chipload_max_mm: f64,
    pub rpm_min: f64,
    pub rpm_max: f64,
    #[serde(default)]
    pub included_angle_deg: Option<f64>,
    #[serde(default)]
    pub point_angle_deg: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OpCfg {
    pub depth_per_pass_mm: Option<f64>,
    pub rpm: Option<f64>,
    pub feed_mm_min: Option<f64>,
    pub plunge_mm_min: Option<f64>,
    pub finish_allowance_mm: Option<f64>,
    pub ramp_length_mm: Option<f64>,
    pub lead_mm: Option<f64>,
    /// `"Plunge" | "Ramp" | "Helix"`
    pub entry: Option<String>,
    /// `"Climb" | "Conventional"`
    pub direction: Option<String>,
    /// `"None" | "Corner" | "TBoneX" | "TBoneY"`
    pub dogbone: Option<String>,
    pub tabs_enabled: Option<bool>,
    pub tab_height_mm: Option<f64>,
    pub tab_width_mm: Option<f64>,
    pub tab_count: Option<u32>,
    pub tab_min_spacing_mm: Option<f64>,
    pub peck_depth_mm: Option<f64>,
}

macro_rules! set {
    ($dst:expr, $src:expr) => {
        if let Some(v) = $src.clone() {
            $dst = v;
        }
    };
}

impl JobConfig {
    /// The built-in library with this config's `extra_tools` merged in.
    ///
    /// 🔴 Extracted from `apply` in 2026-08-09 so the IMPORT path resolves
    /// against exactly the same list. It did not: `plan_report_import_bytes`
    /// looked its `tool_id` up in a bare `default_library()`, so a shop tool
    /// declared in `extra_tools` and selected by id **was not found there** and
    /// took the silent-substitution branch. `apply` then quietly corrected the
    /// operations further down, which is why nobody noticed — the substitution
    /// was masking a second bug, and refusing on the narrower list would have
    /// broken a legitimate flow. Two lookups against two different libraries is
    /// the defect; one function is the fix.
    ///
    /// An entry with an existing id REPLACES it — that is how a shop corrects a
    /// chipload it has measured rather than living with ours. An invalid or
    /// wrongly-categorised one is REJECTED with its faults named in `notes` and
    /// is legitimately absent from the result, so a later "not in the library"
    /// refusal for that same id is correct and its reason travels beside it.
    pub fn merged_library(&self, notes: &mut Vec<String>) -> Vec<crate::tools::ToolSpec> {
        let mut lib = default_library();
        let Some(extra) = &self.extra_tools else { return lib };
        for e in extra {
            let Some(cat) = parse_category(&e.category) else {
                notes.push(format!(
                    "tool '{}' has category '{}', which is not one of the known categories — \
                     it was NOT added",
                    e.id, e.category
                ));
                continue;
            };
            let spec = crate::tools::ToolSpec {
                id: e.id.clone(),
                tool: Tool {
                    name: e.id.clone(),
                    // 🔴 On the TOOL, not beside it. A shop tool declared here
                    // is copied into each operation as a bare `Tool`
                    // (`op.tool = t.tool.clone()`), so a category that stopped
                    // at the `ToolSpec` would be gone by the time the planner
                    // saw it — a user-declared drill would arrive at the post
                    // indistinguishable from an end mill, which is exactly the
                    // asymmetry `ToolCategory`'s doc block records.
                    category: cat,
                    diameter_mm: e.diameter_mm,
                    flutes: e.flutes,
                    cutting_length_mm: e.cutting_length_mm,
                    shank_mm: e.shank_mm,
                    chipload_mm: e.chipload_mm,
                    chipload_min_mm: e.chipload_min_mm,
                    chipload_max_mm: e.chipload_max_mm,
                    rpm_min: e.rpm_min,
                    rpm_max: e.rpm_max,
                    flute_type: crate::types::Flute::UpCut,
                },
                included_angle_deg: e.included_angle_deg,
                point_angle_deg: e.point_angle_deg,
            };
            // 🔴 An invalid tool is REFUSED with its faults named. Accepting it
            // would put a cutter with, say, an inverted chipload window into the
            // library and derive feeds from nonsense.
            let faults = spec.faults();
            if !faults.is_empty() {
                notes.push(format!("tool '{}' is invalid ({faults:?}) and was NOT added", e.id));
                continue;
            }
            if let Some(existing) = lib.iter_mut().find(|t| t.id == spec.id) {
                *existing = spec;
            } else {
                lib.push(spec);
            }
        }
        lib
    }

    pub fn apply(&self, built: &mut BuiltJob) {
        if let Some(m) = &self.machine {
            let d = &mut built.job.machine;
            set!(d.name, m.name);
            set!(d.travel_x_mm, m.travel_x_mm);
            set!(d.travel_y_mm, m.travel_y_mm);
            set!(d.travel_z_mm, m.travel_z_mm);
            set!(d.safe_z_mm, m.safe_z_mm);
            set!(d.rapid_mm_min, m.rapid_mm_min);
            set!(d.max_feed_mm_min, m.max_feed_mm_min);
            set!(d.collet_mm, m.collet_mm);
            set!(d.spare_collets_mm, m.spare_collets_mm);
            set!(d.spindle_min_rpm, m.spindle_min_rpm);
            set!(d.spindle_max_rpm, m.spindle_max_rpm);
            set!(d.spindle_spinup_s, m.spindle_spinup_s);
            set!(d.probe_enabled, m.probe_enabled);
            // 🔴 A COPY, NOT A COLLAPSE. Both sides are `Option<f64>` and they
            // mean the same three-way fact — absent / declared / declared as
            // zero — so the value crosses unflattened. `set!` would not compile
            // here and it MUST NOT be made to: until 2026-08-09 this line
            // collapsed an absent config field into the machine's unsourced
            // `1.6` default, which is precisely how a config that enables
            // probing and says nothing about the plate came to RUN.
            //
            // ⚠ `Some` GUARDS THE ASSIGNMENT, and that is deliberate rather
            // than lazy. It keeps the whole config surface's one rule — a field
            // the file does not mention is a field the file is not changing.
            // A bare copy would let `{"machine":{"safe_z_mm":10}}` silently
            // clear a plate thickness the caller declared elsewhere, and serde
            // cannot tell an absent field from an explicit `null` anyway, so
            // "unset it from the config" is not an expressible request. To get
            // an undeclared plate deliberately, use `--plant undeclared-plate`.
            if m.touch_plate_mm.is_some() {
                d.touch_plate_mm = m.touch_plate_mm;
            }
            // 🔴 A COPY, NOT A COLLAPSE — the same shape as `touch_plate_mm`
            // immediately above and for the same reason. Both sides are
            // `Option<f64>` carrying the same three-way fact (absent / declared
            // / declared as zero), and `set!` would flatten the absence into the
            // machine's value. There is no `Machine` default to flatten INTO
            // here — the field is `None` on `Machine::default()` — so a collapse
            // would not merely lose a distinction, it would not compile; that is
            // luck, and the guard is written out rather than relied on.
            //
            // ⚠ `Some` guards the assignment so the config surface keeps its one
            // rule: a field the file does not mention is a field the file is not
            // changing. A declared `0.0` is an ATC and reaches the machine
            // unchanged, because `Some(0.0).is_some()`.
            if m.tool_change_seconds.is_some() {
                d.tool_change_seconds = m.tool_change_seconds;
            }
            // 🔴 REFUSE, DO NOT SUBSTITUTE, AND SAY SO WHERE A PERSON READS IT.
            // A declaration this core cannot resolve leaves the machine's
            // spoilboard untouched — for every existing job that is `None`, i.e.
            // UNCHECKED — and the reason goes into `notes`, which the CLI prints
            // and the browser shows. A rejected declaration that produced
            // silence would look exactly like a machine nobody had configured.
            if let Some(sb) = &m.spoilboard {
                match sb.resolve() {
                    Ok(board) => d.spoilboard = Some(board),
                    Err(why) => built
                        .notes
                        .push(format!("SPOILBOARD NOT INSTALLED — {why}.")),
                }
            }
            // 🔴 An UNRECOGNISED string leaves the field alone rather than
            // falling back to a plausible value. "xzy" must not silently become
            // Z-only — the post refuses an XYZ plate with anything missing, and
            // a typo that quietly downgrades the probe would set an X and Y
            // datum of zero on a job the operator believed was corner-probed.
            if let Some(p) = m.probe_plate.as_deref() {
                match p {
                    "z-only" | "zonly" | "z" => d.probe_plate = crate::types::ProbePlate::ZOnly,
                    "xyz" => d.probe_plate = crate::types::ProbePlate::Xyz,
                    _ => built
                        .notes
                        .push(format!("probe_plate \"{p}\" is not recognised and was IGNORED — use \"z-only\" or \"xyz\"")),
                }
            }
            set!(d.supports_arcs, m.supports_arcs);
            set!(d.supports_canned_drill, m.supports_canned_drill);
            // Same shape as `probe_plate`: a string that maps to an enum, with
            // unrecognised values ignored rather than defaulted. "desktop" and
            // "gantry" are the two values this app defends; "industrial" is
            // accepted but currently maps to the same depth as Gantry.
            if let Some(mc) = m.machine_class.as_deref() {
                match crate::types::MachineClass::from_str_opt(mc) {
                    Some(cls) => d.machine_class = cls,
                    None => built
                        .notes
                        .push(format!("machine_class \"{mc}\" is not recognised and was IGNORED — use \"desktop\", \"gantry\", or \"industrial\"")),
                }
            }
        }
        if let Some(st) = &self.stock {
            let d = &mut built.job.stock;
            set!(d.size_x_mm, st.size_x_mm);
            set!(d.size_y_mm, st.size_y_mm);
            set!(d.thickness_mm, st.thickness_mm);
            set!(d.origin_x_mm, st.origin_x_mm);
            set!(d.origin_y_mm, st.origin_y_mm);
            set!(d.rotation_deg, st.rotation_deg);
            // 🔴 THE ONE PLACE THE WIRE BOOLEAN BECOMES THE DOMAIN ENUM.
            //
            // `StockCfg::z_zero_at_top` stays a `bool` and keeps that name
            // because it has already been serialised — into config files, into
            // the wasm boundary, and into every saved browser session. The
            // domain model stopped having a boolean (see `types::ZDatum`) so
            // that a second datum answer cannot be written; the mapping happens
            // here, once, and nowhere else.
            //
            // ⚠ The stored VALUE did not change meaning — `true` meant "top"
            // before this change and means "top" after. What changed is that it
            // now DOES something: until 2026-08-11 `Stock::z_zero_at_top` reached
            // no emitted byte, so a config carrying `false` produced a program
            // datumed at the top regardless.
            if let Some(top) = st.z_zero_at_top {
                d.z_datum = if top {
                    crate::types::ZDatum::WorkpieceTop
                } else {
                    crate::types::ZDatum::SpoilboardTop
                };
            }
            if let Some(p) = &st.corner_plate {
                // 🔴 An UNRECOGNISED or ABSENT corner leaves the plate
                // UNDECLARED rather than falling back to front-left. The post
                // then REFUSES the probe, which is the whole point: a typo must
                // not quietly become a corner the plate is not hooked over, with
                // the cutter driven into it at the seek rate. The three
                // dimensions default to zero and are refused individually, each
                // by name.
                let corner = match p.corner.as_deref() {
                    Some("front-left") => Some(crate::types::ProbeCorner::FrontLeft),
                    Some("front-right") => Some(crate::types::ProbeCorner::FrontRight),
                    Some("back-left") => Some(crate::types::ProbeCorner::BackLeft),
                    Some("back-right") => Some(crate::types::ProbeCorner::BackRight),
                    other => {
                        built.notes.push(format!(
                            "corner_plate.corner {:?} is not recognised and the plate was left \
                             UNDECLARED — the probe will be REFUSED rather than run on a guessed \
                             corner",
                            other.unwrap_or("(absent)")
                        ));
                        None
                    }
                };
                // 🔴 The wall is THREE-state and the config says so. A
                // contradiction is reported and resolved toward the SAFE side —
                // "no wall" refuses either way, so neither reading runs a probe.
                let wall = match (p.wall_absent.unwrap_or(false), p.wall_mm) {
                    (true, Some(v)) => {
                        built.notes.push(format!(
                            "corner_plate declares wall_absent AND wall_mm {v} — taking it as \
                             ABSENT; both readings refuse the probe, so nothing runs on the guess"
                        ));
                        crate::types::PlateWall::NotPresent
                    }
                    (true, None) => crate::types::PlateWall::NotPresent,
                    (false, Some(v)) => crate::types::PlateWall::Mm(v),
                    (false, None) => crate::types::PlateWall::Undeclared,
                };
                d.corner_plate = corner.map(|corner| crate::types::CornerPlate {
                    plate: crate::types::TouchPlate { top_mm: p.top_mm.unwrap_or(0.0), wall },
                    corner,
                    xy_depth_mm: p.xy_depth_mm.unwrap_or(0.0),
                });
            }
        }
        // Where the operator dragged the geometry ON THE WORKPIECE. Applied to the
        // JOB, not to a contour: `plan_job` puts every coordinate through
        // `Job::place`, and `simulate_and_check` puts the verification regions
        // through the same call — so one field moves the program AND the thing
        // that checks it, and they cannot come apart.
        if let Some([x, y]) = self.drawing_offset {
            if x.is_finite() && y.is_finite() {
                built.job.drawing_offset_x_mm = x;
                built.job.drawing_offset_y_mm = y;
            } else {
                // Reported and NOT applied, rather than clamped to something
                // plausible. Every comparison against NaN is false, so a part
                // placed there sails through the travel limits with nothing
                // tested, and drops silently out of the bounds fold that decides
                // where the program goes.
                built.notes.push(format!(
                    "drawing_offset [{x}, {y}] is not two finite millimetre values and was NOT \
                     applied — the geometry is where it was, not where that asked for"
                ));
            }
        }
        // Whether an outline edge lying ON the workpiece edge is left uncut, and
        // how close counts as "on it".
        //
        // 🔴 `set!` and nothing else — no validation, no clamp, no default
        // resolved here. `plan_job` builds the rule ONCE from the job and
        // REFUSES a tolerance that is not a distance, naming what the operator
        // has to do; re-checking it here would put a second copy of that rule in
        // a second file, and the copy that drifts is the one that decides
        // whether material gets removed. Absent leaves the job's own value —
        // `false` and `DEFAULT_WORKPIECE_EDGE_TOLERANCE_MM` — exactly as it was.
        set!(built.job.use_workpiece_edge, self.use_workpiece_edge);
        set!(built.job.workpiece_edge_tolerance_mm, self.workpiece_edge_tolerance_mm);
        if let Some(cs) = &self.clamps {
            built.job.fixturing.clamps = cs
                .iter()
                .map(|c| {
                    crate::fixture::Clamp::new(c.name.clone(), c.x, c.y, c.w, c.h, c.height_mm)
                        // NOT a cosmetic pass-through: `Clamp::contains` and
                        // `Clamp::contour` are both computed from `corners()`,
                        // so this one number is what the keepout is tested
                        // against. Accept it here and drop it and the config
                        // asks for a turned clamp while the check tests the
                        // axis-aligned box — P7R's limb B.
                        .rotated(c.rotation_deg)
                })
                .collect();
        }
        set!(built.job.fixturing.confirmed_clear, self.confirmed_clear);
        // ---- clamp phases: multi-phase work-holding ---------------------------
        //
        // 🔴 MUTUALLY EXCLUSIVE WITH `clamps`. The phases carry their own
        // clamp sets; sending both is a contradiction that would make one
        // invisible. Refuse rather than silently pick one.
        if let Some(phases) = &self.clamp_phases {
            if self.clamps.is_some() {
                built.notes.push(
                    "config declares BOTH `clamps` and `clamp_phases` — those are two different \
                     claims about the work-holding. `clamp_phases` was used and `clamps` was \
                     IGNORED. Drop one"
                        .into(),
                );
            }
            built.job.clamp_phases = Some(
                phases
                    .iter()
                    .map(|p| {
                        let clamps: Vec<crate::fixture::Clamp> = p
                            .clamps
                            .iter()
                            .map(|c| {
                                crate::fixture::Clamp::new(
                                    c.name.clone(),
                                    c.x,
                                    c.y,
                                    c.w,
                                    c.h,
                                    c.height_mm,
                                )
                                .rotated(c.rotation_deg)
                            })
                            .collect();
                        let mut phase = crate::fixture::ClampPhase::new(clamps);
                        if let Some(n) = &p.note {
                            phase = phase.with_note(n);
                        }
                        phase
                    })
                    .collect(),
            );
            // When phases are declared, the main fixturing is the FIRST
            // phase's clamps — so the initial setup matches.
            if let Some(first) = phases.first() {
                built.job.fixturing.clamps = first
                    .clamps
                    .iter()
                    .map(|c| {
                        crate::fixture::Clamp::new(
                            c.name.clone(),
                            c.x,
                            c.y,
                            c.w,
                            c.h,
                            c.height_mm,
                        )
                        .rotated(c.rotation_deg)
                    })
                    .collect();
            }
        }
        set!(built.job.probe_after_toolchange, self.probe_after_toolchange);
        if let Some(m) = &self.material {
            // 🔴 An unrecognised material is REPORTED by leaving the previous
            // one in place rather than falling back to plywood. Silently
            // treating "Aluminium " (with a stray space) as plywood would feed
            // aluminium three times too fast.
            if let Some(parsed) = crate::tools::Material::from_str(m) {
                built.job.material = parsed;
            } else {
                built.notes.push(format!(
                    "unknown material '{m}' — the previous material ({}) is still in use",
                    built.job.material.as_str()
                ));
            }
        }

        // Extra tools are merged BEFORE the tool is selected, so a user tool
        // can be chosen by id like any other.
        let lib = self.merged_library(&mut built.notes);

        // 🔴 SIBLING OF THE IMPORT-PATH DEFECT, and the more dangerous of the
        // two because it is on the path the reference fixtures run.
        //
        // This was `if let Some(t) = lib.iter().find(…)` with **no else**, so a
        // `tool_id` that resolved to nothing fell out of the `if let` and the
        // operations kept the cutter they were BUILT with. Measured at HEAD:
        // `job plate --config '{"tool_id":"endmill-6"}'` emitted **11,978
        // bytes** at exit `0`, on a Ø6mm end mill, with nothing in `notes`,
        // `warnings`, `errors` or `refusals` mentioning that the requested id
        // did not exist. An `if let` with no `else` is how a lookup failure
        // becomes a silent success.
        //
        // The refusal is COMPUTED here — where the library and the id are both
        // in scope — and PUSHED below, after `apply_tool_set`. That order is not
        // cosmetic: `assign_tools_from_set` does `job.tool_set_refusals =
        // out.refusals.clone()`, an assignment and not an extend, so a refusal
        // pushed before it is silently overwritten by a config carrying BOTH
        // `tool_id` and `tool_ids`. A safety refusal deleted by a later
        // assignment is worse than one never written, because the code reads as
        // if it is there.
        //
        // ===================================================================
        // 🔴 ONE DOOR. `tool_id` IS THE ONE-ELEMENT SPELLING OF `tool_ids`.
        // ===================================================================
        //
        // Until 2026-08-11 the `Some(t)` arm below was a second planner: it
        // wrote `op.tool = t.tool` onto EVERY operation and returned, so
        // `apply_tool_set` was handed `None`, `recommend` was never called,
        // `tool_set_refusals` stayed empty and the check at `job.rs:1140` had
        // nothing to refuse. Gate `DOOR` measured what that cost, on this
        // tree, at core `de7d9f0d917d`: **66 of 306 (fixture x single tool)
        // pairs disagreed**, and **every one of the 240 agreements was two
        // refusals** — there was no pair anywhere on which both doors emitted
        // and produced the same program. Wherever the cutter could do the job
        // at all, the two fields meant different things.
        //
        // The three classes, and which door was right in each — established
        // BEFORE collapsing, because agreement is not correctness:
        //
        // 1. **46 EMITS-vs-REFUSES.** `tool_id` emitted what `tool_ids`
        //    refused. `pocket` + a Ø6mm down-cut emitted 963 lines at exit 0
        //    while THE SIMULATOR ON THAT SAME RUN reported 6.0mm of material
        //    standing at (120.6, 90.6); `plate` + a brad point emitted profile
        //    contours cut with a DRILL. The set door refuses both by name. The
        //    set door is right, and the singular door was not passing the
        //    check — it was skipping it.
        // 2. **8 REFUSES-vs-EMITS**, so the singular door was NOT a strict
        //    subset and could not be dismissed as "the one that skips checks".
        //    All 8 are `multi-tool`/`two-part` x a Ø6mm cutter on a Ø6mm hole:
        //    the singular door imposed the new tool WITHOUT re-deciding
        //    Profile->Drill, so offsetting the loop by the tool radius left
        //    nothing and the toolpath refused a hole that is simply a drilled
        //    one. `assign_tools_from_set` re-decides it (`job.rs:2081-2098`)
        //    and drills. The set door is right here too.
        // 3. **12 DIFFERENT-PROGRAM**, and these were the ones called benign.
        //    They are not. `socket` and `clamped` on the 6mm class have
        //    IDENTICAL LINE COUNTS and differ only in `M3 S18000` / `F3600.0`
        //    against `M3 S24000` / `F4800.0` — the same cutter, the same
        //    fixture, two spindle speeds and two feeds depending on which
        //    field named the tool. The cause is this arm: it moved the TOOL
        //    and left `rpm`, `feed_mm_min` and `depth_per_pass_mm` on the
        //    numbers the operation was BUILT with, which is precisely the
        //    "a 3mm cutter fed at a 12mm cutter's rate" failure
        //    `assign_tools_from_set`'s own header says it exists to stop. A
        //    wrong-part / broken-cutter class defect on its own, independent
        //    of which door wins.
        //
        // ⇒ The set door is right in all three directions, so the collapse is
        // ONTO IT: a resolvable `tool_id` becomes the first entry of the set
        // and goes through `assign_tools_from_set` like any other. There is no
        // longer a `for op in operations { op.tool = ... }` anywhere on this
        // path — the second planner is deleted, not merely bypassed.
        //
        // ⚠ **EXPECT REFUSALS TO INCREASE.** Jobs that used to emit now
        // refuse. That is the fix landing, not a regression: what they emitted
        // was a program the per-feature check would have rejected.
        //
        // The singular id is still resolved SEPARATELY from the set, and that
        // is deliberate rather than tidy:
        //   * an unresolvable `tool_id` keeps `unknown_tool_refusal`, which
        //     names the nearest ids in the library. Folding it into the set
        //     would downgrade it to `assign_tools_from_set`'s generic "none of
        //     them is in the library" and lose the suggestions.
        //   * `JobPlant::ToolSubstitute` must still restore the pre-2026-08-09
        //     swallow verbatim, which means contributing NOTHING to the set so
        //     the operations keep the tool they were built with.
        let mut selected: Vec<String> = Vec::new();
        let unresolved: Option<String> = match &self.tool_id {
            None => None,
            Some(id) => match lib.iter().find(|t| &t.id == id) {
                Some(_) => {
                    // FIRST in the set, so the cutter the host named singly
                    // still wins a tie in `recommend`'s ordering.
                    selected.push(id.clone());
                    None
                }
                // The plant restores the pre-2026-08-09 swallow verbatim: no
                // refusal, no note, operations left on the tool they were built
                // with. Gate TOOL requires this to produce a RUNNABLE program —
                // a plant that quietly stopped planting is a negative control
                // that has gone blind, and that is indistinguishable from a
                // clean codebase unless something asserts it.
                None if built.plant == JobPlant::ToolSubstitute => None,
                None => Some(unknown_tool_refusal(id, &lib)),
            },
        };
        // Both fields in one config is the union, in the order given. It is not
        // a precedence question any more: there is one fact here — WHICH
        // CUTTERS THE USER SELECTED — and two spellings of it. Deduplicated
        // here rather than left to `assign_tools_from_set`, whose own dedupe is
        // on RESOLVED specs and would therefore note an unresolvable id twice.
        for id in self.tool_ids.iter().flatten() {
            if !selected.iter().any(|s| s == id) {
                selected.push(id.clone());
            }
        }

        // 🔴 `Some(&selected)` and not `self.tool_ids` — that argument IS the
        // collapse. An empty `selected` still means "the user selected
        // nothing", and `apply_tool_set` leaves the job exactly as it was, so a
        // config naming no cutter at all is unchanged.
        crate::job::apply_tool_set(&mut built.job, Some(&selected), &lib, &mut built.notes);

        // ...and only now, so `apply_tool_set`'s assignment cannot clobber it.
        // `tool_set_refusals` is the channel `plan_job` drains into
        // `JobResult::refusals`, which is what makes `is_runnable()` false and
        // stops any G-code being emitted at all — not a warning printed above a
        // program that still posts.
        if let Some(why) = unresolved {
            built.job.tool_set_refusals.push(crate::toolpath::Refusal {
                what: built.job.name.clone(),
                why,
            });
        }

        if let Some(o) = &self.op {
            for op in &mut built.job.operations {
                let p = &mut op.params;
                set!(p.depth_per_pass_mm, o.depth_per_pass_mm);
                set!(p.rpm, o.rpm);
                set!(p.feed_mm_min, o.feed_mm_min);
                set!(p.plunge_mm_min, o.plunge_mm_min);
                set!(p.finish_allowance_mm, o.finish_allowance_mm);
                set!(p.ramp_length_mm, o.ramp_length_mm);
                // Marking passes never take a lead: a lead arc on a letter
                // stroke draws a hook off the end of the glyph.
                if p.op_type != OpType::Engrave {
                    set!(p.lead_mm, o.lead_mm);
                }
                set!(p.peck_depth_mm, o.peck_depth_mm);
                if let Some(e) = &o.entry {
                    p.entry = match e.as_str() {
                        "Plunge" => EntryMode::Plunge,
                        "Helix" => EntryMode::Helix,
                        _ => EntryMode::Ramp,
                    };
                }
                if let Some(d) = &o.direction {
                    p.direction = match d.as_str() {
                        "Conventional" => Direction::Conventional,
                        _ => Direction::Climb,
                    };
                }
                // Relief only applies where the job already asked for it: a
                // global switch would bore reliefs into the corners of every
                // outside profile, which removes material the part needs.
                if p.dogbone != DogboneStyle::None {
                    if let Some(d) = &o.dogbone {
                        p.dogbone = match d.as_str() {
                            "Corner" => DogboneStyle::Corner,
                            "TBoneX" => DogboneStyle::TBoneX,
                            "TBoneY" => DogboneStyle::TBoneY,
                            _ => DogboneStyle::None,
                        };
                    }
                }
                // A pocket clearing pass has tabs deliberately off; a config
                // that turned them on for every operation would put tabs in the
                // middle of a pocket floor. Only operations that already had
                // tabs follow the tab settings.
                if p.tabs.enabled {
                    set!(p.tabs.enabled, o.tabs_enabled);
                    set!(p.tabs.height_mm, o.tab_height_mm);
                    set!(p.tabs.width_mm, o.tab_width_mm);
                    set!(p.tabs.count, o.tab_count);
                    set!(p.tabs.min_spacing_mm, o.tab_min_spacing_mm);
                }
            }
        }
    }
}

/// The registry-integrity half of gate PLANT.
///
/// ⚠ **These tests cannot replace the gate and must not be read as doing so.**
/// They prove the three lists agree on WHICH plants exist. They cannot prove a
/// plant still plants — that is a consequence of the emitted program, and the
/// measurement that settles it is `cargo test` scoring **343/343 with a plant
/// live in `main()`** on 2026-08-09, because the tests called the callee while
/// the caller had stopped calling it. Non-vacuity is asserted by gate PLANT,
/// through the real binary, and nowhere else.
#[cfg(test)]
mod plant_contract_tests {
    use super::*;

    #[test]
    fn every_registered_job_plant_has_a_contract() {
        for (name, _) in JOB_PLANTS {
            assert!(
                plant_contract(name).is_some(),
                "job plant `{name}` is registered in JOB_PLANTS with no row in PLANT_CONTRACTS — \
                 gate PLANT cannot drive it, so nothing would notice it going inert"
            );
        }
    }

    #[test]
    fn every_contract_names_a_plant_that_resolves() {
        // A contract row for a plant nobody can spell is a gate driving a typo
        // and reading the resulting exit-2 as a signal.
        for c in PLANT_CONTRACTS {
            let known = job_plant_from(c.name).is_some() || c.host == "fixture";
            assert!(
                known,
                "PLANT_CONTRACTS names `{}` on host `{}`, which `job_plant_from` does not resolve",
                c.name, c.host
            );
        }
    }

    #[test]
    fn no_contract_is_declared_without_a_consuming_gate() {
        // 🔴 Three plants were orphans on 2026-08-09 — `no-reprobe`,
        // `wrong-drill` and `bed-anchored-sim`. An orphan plant is a control
        // nobody runs, and it is invisible because everything about it looks
        // correct except that no gate names it.
        let orphans: Vec<&str> =
            PLANT_CONTRACTS.iter().filter(|c| c.gate.is_empty()).map(|c| c.name).collect();
        assert!(orphans.is_empty(), "plants with no consuming gate: {orphans:?}");
    }

    #[test]
    fn a_target_is_named_for_every_plant_and_is_a_real_one() {
        for c in PLANT_CONTRACTS {
            assert!(!c.target.is_empty(), "plant `{}` declares no target", c.name);
            if c.host == "job" {
                assert!(
                    JOBS.iter().any(|(n, _)| *n == c.target),
                    "plant `{}` targets job `{}`, which is not in JOBS",
                    c.name,
                    c.target
                );
            }
        }
    }

    #[test]
    fn contract_names_are_unique() {
        let mut seen: Vec<&str> = PLANT_CONTRACTS.iter().map(|c| c.name).collect();
        let before = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(before, seen.len(), "PLANT_CONTRACTS holds a duplicate name");
    }

    #[test]
    fn the_wrong_drill_plant_actually_changes_the_job() {
        // 🔴 The regression this file's longest comment is about: for its whole
        // life this plant pushed a note and added nothing. Asserting on the
        // OPERATION COUNT rather than on the note is the entire point — the
        // note was true and the program was not.
        let clean = build("plate", JobPlant::None).expect("plate");
        let planted = build("plate", JobPlant::WrongDrill).expect("plate");
        assert!(
            planted.job.operations.len() > clean.job.operations.len(),
            "wrong-drill added no operation — it is announcing an injection it never made"
        );
    }

    // =======================================================================
    //  THE PLANT AUDIT — is the negative control still a negative control?
    // =======================================================================
    //
    // ⚠ Same caveat as the registry tests above: **these cannot replace gate
    // PLANT.** They exercise the audit through the core's own door, and the
    // measurement that matters is the one taken through the real binary. They
    // are here because the audit is itself a control, and a control with no
    // negative control of its own is the thing this whole file is about.

    const AUDIT_CELL: f64 = 0.6;

    /// Drive a job through the audit's own instrument, the way a host does.
    fn audited(job: &str, plant: JobPlant, cfg: &JobConfig) -> PlantBite {
        plant_audit(job, plant, cfg, |c, p| plan_report_raw(job, p, c, AUDIT_CELL, None))
    }

    fn parse(json: &str) -> JobConfig {
        serde_json::from_str(json).expect("the test's own config must parse")
    }

    /// 🔴 **SPECIFICITY.** Every declared job plant, driven on its declared
    /// target with its declared config, must still BITE. A plant audit that
    /// refused everything would look exactly as safe as one that works, and it
    /// would be the fastest way to turn the whole negative-control mechanism
    /// off — this is the assertion that stops the fix eating the thing it is
    /// protecting.
    #[test]
    fn every_declared_job_plant_still_bites_on_its_declared_target() {
        for c in PLANT_CONTRACTS.iter().filter(|c| c.host == "job") {
            let plant = job_plant_from(c.name).expect("registered");
            let cfg = c.config.map(parse).unwrap_or_default();
            match audited(c.target, plant, &cfg) {
                PlantBite::Bit { .. } => {}
                other => panic!(
                    "`--plant {}` on its own declared target `{}` is not in force: {other:?}",
                    c.name, c.target
                ),
            }
        }
    }

    /// 🔴 The observable that carries a plant's difference must be the one its
    /// contract DECLARES. A plant that stopped refusing and started merely
    /// changing the program would still "bite" — and gate `PROBE`, which asserts
    /// a refusal, would be watching a control that no longer produces one.
    ///
    /// `bed-anchored-sim` is the sharp case: its program is byte-identical by
    /// design, so `verdict` must be the ONLY difference. If `program` ever
    /// appears there, the plant has started moving the cut and the gate that
    /// reads it is measuring something else.
    #[test]
    fn the_observable_that_moves_is_the_one_the_contract_declares() {
        for c in PLANT_CONTRACTS.iter().filter(|c| c.host == "job") {
            let plant = job_plant_from(c.name).expect("registered");
            let cfg = c.config.map(parse).unwrap_or_default();
            let PlantBite::Bit { differs_in, .. } = audited(c.target, plant, &cfg) else {
                panic!("{} did not bite; the test above says why", c.name)
            };
            let want = match c.effect {
                PlantEffect::Refuses | PlantEffect::Emits => "refusal",
                PlantEffect::ProgramDiffers => "program",
                PlantEffect::VerdictDiffers => "verdict",
                // An obligation plant's consequence is a sentence that stops
                // being said — see `PlantEffect::NoteDisappears`.
                // Its trace is read by `notes_observable`, not by the global
                // set — see that function for why widening the set was wrong.
                PlantEffect::NoteDisappears { .. } => continue,
            };
            assert!(
                differs_in.contains(&want),
                "`{}` declares effect `{}` but the difference is in {differs_in:?}",
                c.name,
                c.effect.as_str()
            );
            if c.effect == PlantEffect::VerdictDiffers {
                assert_eq!(
                    differs_in,
                    vec!["verdict"],
                    "`{}` is declared byte-identical by design and moved the program too",
                    c.name
                );
            }
        }
    }

    /// 🔴 **THE PLANT DEFECT, PLANTED.** These three configs were measured at
    /// the CLI on 2026-08-12 disarming three different plants while all three
    /// still printed `PLANTED: …` over a program that no longer contained them.
    ///
    /// The assertion is on the PAIR — a refusal AND no program — because the
    /// failing case was *exit 0 with a `PLANTED:` note*, and neither half alone
    /// describes it.
    #[test]
    fn a_config_that_overwrites_a_plants_own_field_is_refused() {
        let tools = r#"{"tool_ids":["End Mill - Down-cut 6mm 2F","End Mill - Down-cut 3.175mm 2F"]}"#;
        for (job, plant, json, key) in [
            ("clamped", JobPlant::CutClamp, r#"{"clamps":[]}"#, "clamps"),
            ("multi-tool", JobPlant::OversizeShank, tools, "tool_ids"),
            ("two-part", JobPlant::ReleaseOrder, tools, "tool_ids"),
        ] {
            let cfg = parse(json);

            // 🔴 THE REASON, NOT JUST THE RED. The same config with NO plant must
            // plan and emit — otherwise this test would pass just as well on a
            // config that was rejected for a schema error, a bad tool id or a
            // travel limit, and it would prove nothing about the plant. This is
            // the limb that makes the refusal below attributable.
            let control = plan_report(job, JobPlant::None, &cfg, AUDIT_CELL).expect(job);
            assert!(
                control.ok && !control.gcode.is_empty(),
                "{job}: the config itself is not accepted, so the refusal below would be for the \
                 wrong reason: {:?}",
                control.refusals
            );

            let r = plan_report(job, plant, &cfg, AUDIT_CELL).expect(job);
            assert!(
                !r.ok && r.gcode.is_empty(),
                "{job}: `--plant {}` was disarmed by `{json}` and still emitted {} bytes",
                job_plant_name(plant),
                r.gcode.len()
            );
            let why = r
                .refusals
                .iter()
                .find(|x| x.contains(PLANT_DISARMED_KEY))
                .unwrap_or_else(|| panic!("{job}: refused, but not for the disarmed plant"));
            assert!(
                why.contains(&format!("`{key}`")),
                "{job}: the refusal must NAME the config key the plant's effect depends on, \
                 derived by ablation rather than looked up: {why}"
            );

            // And the announcement must have stopped claiming the plant is in
            // force. A note reading `PLANTED: …` on a program that does not
            // contain it is the original defect, one layer down.
            assert!(
                r.notes.iter().all(|n| !n.trim_start().starts_with("PLANTED")),
                "{job}: a bare `PLANTED:` note survived on a disarmed run: {:?}",
                r.notes
            );
        }
    }

    /// 🔴 **THE HARDER HALF, PLANTED.** A plant can stop producing the
    /// consequence its gate reads while still changing the program — so a run
    /// that asks only *"did anything change?"* passes it.
    ///
    /// `wrong-drill` adds a 5.2mm hole that `default_library()` has no drill
    /// for; gate P5 watches the REFUSAL. Declare a 5.2mm drill in `extra_tools`
    /// and the hole is simply drilled: the program still differs from the clean
    /// one (that is the first limb passing), and P5's refusal is gone.
    ///
    /// ⚠ This is the measured answer to *"do `wrong-drill` and
    /// `undeclared-plate` survive by luck or by structure?"* — **luck.** Neither
    /// is reached by the three configs that disarmed the other plants, and both
    /// are one config key away from being switched off. What makes them safe now
    /// is this audit, not the fields they happen to use.
    #[test]
    fn a_config_that_turns_a_declared_refusal_into_a_program_is_refused() {
        let json = r#"{"extra_tools":[{"id":"Shop 5.2mm drill","category":"Drill",
            "diameter_mm":5.2,"flutes":2,"shank_mm":6.0,"cutting_length_mm":40.0,
            "chipload_mm":0.08,"chipload_min_mm":0.04,"chipload_max_mm":0.14,
            "rpm_min":6000,"rpm_max":18000}],
            "tool_ids":["End Mill - Down-cut 6mm 2F","Shop 5.2mm drill"]}"#;
        let cfg = parse(json);

        // THE REASON, NOT JUST THE RED: the same config with no plant must plan
        // and emit, or the refusal below would be the config's and not the
        // plant's.
        let control = plan_report("plate", JobPlant::None, &cfg, AUDIT_CELL).expect("plate");
        assert!(control.ok && !control.gcode.is_empty(), "{:?}", control.refusals);

        let r = plan_report("plate", JobPlant::WrongDrill, &cfg, AUDIT_CELL).expect("plate");
        assert!(!r.ok && r.gcode.is_empty(), "a declared refusal emitted and was not caught");
        let why = r
            .refusals
            .iter()
            .find(|x| x.contains(PLANT_DISARMED_KEY))
            .expect("refused for the disarmed plant");
        assert!(
            why.contains("EMITTED a program instead of being refused"),
            "the refusal must name the DECLARED consequence that stopped happening, not merely \
             say the plant did nothing — it did plenty: {why}"
        );
        assert!(
            why.contains("NOT inert"),
            "and it must say the run still differs, or a reader will look for an inert plant: {why}"
        );
    }

    /// The direction of each declared consequence, at the function rather than
    /// through a job — one arm per [`PlantEffect`], both ways round.
    ///
    /// 🔴 `Refuses` satisfied by *the clean run refusing too* is the arm most
    /// likely to be written wrong: both runs refuse, the planted one is
    /// certainly "refused", and the refusal belongs to something else entirely.
    #[test]
    fn a_declared_consequence_is_checked_in_the_direction_the_gate_asserts_it() {
        let c = |effect| PlantContract {
            name: "test",
            host: "job",
            target: "plate",
            config: None,
            effect,
            gate: "TEST",
        };
        let refuses = c(PlantEffect::Refuses);
        assert!(declared_effect_holds(&refuses, false, true, false, true, true, None).is_ok());
        assert!(declared_effect_holds(&refuses, true, true, false, true, true, None).is_err());
        assert!(
            declared_effect_holds(&refuses, false, false, true, true, true, None).is_err(),
            "both runs refused and the plant was credited with it"
        );

        let emits = c(PlantEffect::Emits);
        assert!(declared_effect_holds(&emits, true, false, false, true, true, None).is_ok());
        assert!(declared_effect_holds(&emits, false, false, false, true, true, None).is_err());
        assert!(
            declared_effect_holds(&emits, true, true, false, true, true, None).is_err(),
            "there was no refusal for the plant to take out"
        );

        let differs = c(PlantEffect::ProgramDiffers);
        assert!(declared_effect_holds(&differs, true, true, false, true, true, None).is_ok());
        assert!(declared_effect_holds(&differs, true, true, true, true, true, None).is_err());
        assert!(declared_effect_holds(&differs, false, true, false, true, true, None).is_err());

        let verdict = c(PlantEffect::VerdictDiffers);
        assert!(declared_effect_holds(&verdict, true, true, true, true, false, None).is_ok());
        assert!(declared_effect_holds(&verdict, true, true, true, true, true, None).is_err());
        assert!(
            declared_effect_holds(&verdict, true, true, false, true, false, None).is_err(),
            "a check-only plant that moved the program is not the defect the gate reads"
        );
        assert!(
            declared_effect_holds(&verdict, true, true, true, false, true, None).is_err(),
            "a host with no simulation must report PENDING, and PENDING refuses"
        );
    }

    /// A plant driven on a job it cannot reach is refused too, and the message
    /// sends the reader to the target the registry declares rather than to their
    /// config — the two failures have different fixes.
    #[test]
    fn a_plant_that_is_vacuous_on_this_job_is_refused_and_names_its_declared_target() {
        let r = plan_report("plate", JobPlant::CutClamp, &JobConfig::default(), AUDIT_CELL)
            .expect("plate");
        assert!(!r.ok && r.gcode.is_empty(), "a vacuous plant still emitted a program");
        let why = r
            .refusals
            .iter()
            .find(|x| x.contains(PLANT_DISARMED_KEY))
            .expect("refused for the vacuous plant");
        assert!(
            why.contains("wrong target") && why.contains("`clamped`"),
            "the message must send the reader to the declared target, not to their config: {why}"
        );
    }

    /// 🔴 A real job pays NOTHING for this. The audit must not plan anything at
    /// all when no plant was asked for — `--plant` may not leak into a real job,
    /// and neither may its cost.
    #[test]
    fn the_audit_plans_nothing_when_no_plant_was_asked_for() {
        let calls = std::cell::Cell::new(0usize);
        let bite = plant_audit("plate", JobPlant::None, &JobConfig::default(), |c, p| {
            calls.set(calls.get() + 1);
            plan_report_raw("plate", p, c, AUDIT_CELL, None)
        });
        assert_eq!(bite, PlantBite::NotPlanted);
        assert_eq!(calls.get(), 0, "the audit planned a job that carries no plant");
    }

    /// 🔴 The audit's own negative control: **make the observables stop
    /// separating the two runs and the audit must go red.** Here that is done
    /// honestly rather than by editing the comparator — a plant is driven on a
    /// job where it genuinely changes nothing, which is the same state a
    /// disarming config produces.
    ///
    /// ⚠ Without this, `every_declared_job_plant_still_bites_on_its_declared_target`
    /// would pass just as well against an audit that returned `Bit`
    /// unconditionally.
    #[test]
    fn the_audit_reports_disarmed_when_the_two_runs_are_indistinguishable() {
        let inert = audited("socket", JobPlant::CutClamp, &JobConfig::default());
        assert!(
            matches!(inert, PlantBite::Disarmed { .. }),
            "the audit called an inert plant armed: {inert:?}"
        );
        let armed = audited("clamped", JobPlant::CutClamp, &JobConfig::default());
        assert!(
            matches!(armed, PlantBite::Bit { .. }),
            "the same plant on its own target must still bite: {armed:?}"
        );
    }

    #[test]
    fn every_plant_is_inert_on_at_least_one_job_and_the_contract_knows_it() {
        // Not a defect — it is the fact the contract exists to record. A plant
        // driven off its declared target runs clean, exits 0 and reads as a
        // passing control, which is how `--plant release-order` was nearly hung
        // on a fixture producing zero reorder notes.
        let inert = build("socket", JobPlant::CutClamp).expect("socket");
        let clean = build("socket", JobPlant::None).expect("socket");
        assert_eq!(
            inert.job.operations.len(),
            clean.job.operations.len(),
            "cut-clamp is expected to be INERT on `socket`; if that changed, the contract's \
             target for it should be re-derived rather than this assertion relaxed"
        );
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn an_empty_config_changes_nothing() {
        // Absent must mean "leave it alone", never "zero".
        let mut a = build("plate", JobPlant::None).unwrap();
        let b = build("plate", JobPlant::None).unwrap();
        JobConfig::default().apply(&mut a);
        assert_eq!(a.job.stock.thickness_mm, b.job.stock.thickness_mm);
        assert_eq!(a.job.machine.travel_x_mm, b.job.machine.travel_x_mm);
        assert_eq!(a.job.operations.len(), b.job.operations.len());
    }

    #[test]
    fn stock_and_machine_changes_reach_the_plan() {
        let mut j = build("plate", JobPlant::None).unwrap();
        let cfg: JobConfig = serde_json::from_str(
            r#"{"stock":{"thickness_mm":12},"machine":{"travel_x_mm":300}}"#,
        )
        .unwrap();
        cfg.apply(&mut j);
        assert_eq!(j.job.stock.thickness_mm, 12.0);
        assert_eq!(j.job.machine.travel_x_mm, 300.0);
    }

    #[test]
    fn an_unknown_field_is_rejected_rather_than_ignored() {
        // 🔴 A typo'd setting that silently does nothing is the worst kind:
        // the operator believes they changed the depth and the machine does not.
        let r: Result<JobConfig, _> = serde_json::from_str(r#"{"stok":{"thickness_mm":12}}"#);
        assert!(r.is_err(), "an unknown key was accepted and silently dropped");
    }

    #[test]
    fn clamps_replace_wholesale_and_confirmed_clear_is_separate() {
        let mut j = build("clamped", JobPlant::None).unwrap();
        let cfg: JobConfig = serde_json::from_str(
            r#"{"clamps":[{"name":"one","x":0,"y":0,"w":10,"h":10,"height_mm":30}],
                "confirmed_clear":true}"#,
        )
        .unwrap();
        cfg.apply(&mut j);
        assert_eq!(j.job.fixturing.clamps.len(), 1);
        assert!(j.job.fixturing.confirmed_clear);
    }

    /// 🔴 **THE HOST SEAM FOR THE WORKPIECE-EDGE RULE, ASSERTED ON THE EMITTED
    /// PROGRAM.**
    ///
    /// The geometry is proved in `toolpath` and the decision in
    /// `job::workpiece_edge_tests`. What is proved HERE is the only thing those
    /// cannot reach: that a **config a host sends** turns it on at all. Until
    /// this pass `JobConfig` had no such field, so the feature was complete,
    /// tested, and reachable from no CLI flag, no config file and no UI control
    /// — which is indistinguishable from absent to everyone outside the crate.
    ///
    /// The plant that was watched go red: deleting
    /// `set!(built.job.use_workpiece_edge, …)` from `apply` leaves the emitted
    /// program byte-identical between the two configs and this fails on the
    /// first assertion — the exact shape of a control that changes nothing.
    #[test]
    fn the_workpiece_edge_rule_reaches_the_emitted_program_from_a_config() {
        // `plate` is a 200x120 outline drawn at (60,60) on a 600x900 workpiece.
        // Dragging it by (-60,-60) puts its y-min and x-min edges ON the
        // workpiece edges and leaves the other two 397mm and 780mm inside — so a
        // change that skipped everything and one that skipped nothing both fail.
        // The workpiece itself sits at (10,10) so the OFF program, which cuts
        // one tool radius outside the material, still fits the travel envelope
        // and can be compared rather than refused.
        const OFF: &str = r#"{"drawing_offset":[-60,-60],"op":{"entry":"Plunge"},
                              "stock":{"origin_x_mm":10,"origin_y_mm":10}}"#;
        const ON: &str = r#"{"drawing_offset":[-60,-60],"op":{"entry":"Plunge"},
                             "stock":{"origin_x_mm":10,"origin_y_mm":10},
                             "use_workpiece_edge":true,
                             "workpiece_edge_tolerance_mm":0.1}"#;
        let cfg = |s: &str| serde_json::from_str::<JobConfig>(s).expect("test config must parse");
        let off = plan_report("plate", JobPlant::None, &cfg(OFF), 0.6).expect("plate");
        let on = plan_report("plate", JobPlant::None, &cfg(ON), 0.6).expect("plate");

        assert!(off.ok && on.ok, "both programs must post: off={:?} on={:?}", off.errors, on.errors);
        assert_ne!(
            off.gcode, on.gcode,
            "the config reached no coordinate — the switch is a setting that changes nothing"
        );
        assert!(
            on.cutting_distance_mm < off.cutting_distance_mm,
            "turning the rule ON did not cut LESS: {} vs {}",
            on.cutting_distance_mm,
            off.cutting_distance_mm
        );
        // The emitted program says WHICH edges and WHY, in the file the operator
        // reads at the machine — not only in a report field a UI may drop.
        assert!(
            on.gcode.contains("( workpiece edge: 2 of 4 outline edges cut"),
            "the emitted program does not name the skipped edges"
        );
        assert!(
            !off.gcode.contains("workpiece edge:"),
            "the OFF program carries the rule's commentary, so the flag is not being read"
        );
    }

    /// ⚠ **AND THE TOLERANCE IS A SEPARATE WIRE.** Sending only the tolerance
    /// changes nothing, which is correct and is not an error: the job's own
    /// field is read only when the switch is on. A test that asserted both
    /// fields together would pass with the tolerance's `set!` deleted.
    #[test]
    fn the_tolerance_crosses_the_seam_and_is_refused_rather_than_clamped() {
        let cfg = |s: &str| serde_json::from_str::<JobConfig>(s).expect("test config must parse");

        // Tolerance alone: no switch, so the job is untouched and posts.
        let mut only_tol = build("plate", JobPlant::None).expect("plate");
        cfg(r#"{"workpiece_edge_tolerance_mm":2.5}"#).apply(&mut only_tol);
        assert!(!only_tol.job.use_workpiece_edge, "a tolerance turned the rule on by itself");
        assert_eq!(only_tol.job.workpiece_edge_tolerance_mm, 2.5, "the tolerance did not cross");

        // A tolerance that is not a distance is REFUSED with the whole job, by
        // `plan_job` and in words — never clamped here to something plausible.
        let bad = plan_report(
            "plate",
            JobPlant::None,
            &cfg(r#"{"use_workpiece_edge":true,"workpiece_edge_tolerance_mm":-1}"#),
            0.6,
        )
        .expect("plate");
        assert!(!bad.ok, "a negative tolerance produced a program");
        assert!(
            bad.refusals.iter().any(|r| r.contains("is not a distance")),
            "the refusal does not name what is wrong: {:?}",
            bad.refusals
        );
    }

    #[test]
    fn tabs_stay_off_where_the_job_turned_them_off() {
        // Turning tabs on globally must not put a tab in a pocket floor.
        let mut j = build("pocket", JobPlant::None).unwrap();
        let cfg: JobConfig = serde_json::from_str(r#"{"op":{"tabs_enabled":true}}"#).unwrap();
        cfg.apply(&mut j);
        let pocket_ops = j.job.operations.iter().filter(|o| o.name.starts_with("pocket-"));
        assert!(pocket_ops.clone().count() > 0);
        assert!(
            pocket_ops.map(|o| o.params.tabs.enabled).all(|e| !e),
            "a global tab setting put tabs in a pocket clearing pass"
        );
    }
}

// ===========================================================================
//  The one entry point every host calls.
// ===========================================================================

/// One point of the drawn toolpath — the **cutter centre**, with the per-move
/// facts the emitted program carries.
///
/// 🔴 Everything here is CARRIED from the planned [`Move`], never re-derived.
/// A host that computes a feed from a chipload, or a duration from a rate it
/// picked, has put a second copy of a machining rule in the one place no gate
/// can see it — and the two copies disagree the first time either changes.
///
/// 🔴 And this is the CUTTER CENTRE LINE, already offset by the tool radius and
/// already carrying lead-ins, tabs and reliefs. It is **not the drawing**. The
/// drawing is [`Report::drawing`], and it is exported separately precisely
/// because you cannot get back to it from here.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RenderMove {
    /// `rapid` | `cut` | `tab` | `drill` | `change` | `probe`
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// mm/min **in force for this move** — the same number the post writes as an
    /// `F` word (it writes one only when the feed CHANGES, because F is modal;
    /// this field repeats it on every move so a consumer never has to track
    /// modal state, which is a G-code rule and not a UI's job).
    ///
    /// 🔴 **Absent is not zero.** Absent means this move carries no feed at all
    /// — a `G0` rapid, a tool change, a probe. A player must not divide by it:
    /// a rapid runs at the machine's rapid rate, which is
    /// [`Report::rapid_mm_min`], because `G0` has no `F` word to read. Writing
    /// `feed ?? 0` and dividing gives infinity; writing `feed ?? 1000` invents a
    /// machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed: Option<f64>,
    /// Peck increment in mm, on a `drill` move that pecks. Absent on every other
    /// move, and absent on a drill that goes straight to depth — which is a
    /// different fact from "pecks by 0mm", and only one of them can be drawn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peck_mm: Option<f64>,
    /// The tool this `change` asks the operator to fit, by the name the plan
    /// knows it by. Absent on every other kind.
    ///
    /// 🔴 Optional rather than an empty string ON PURPOSE: `text` is set on tool
    /// changes and nowhere else, and a program is thousands of moves. An empty
    /// `"text":""` on every one of them is pure weight on the biggest field in
    /// the report — see the size note on [`Report::render`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl RenderMove {
    /// A point that carries no feed, no peck and no text — correct for a rapid,
    /// a tool change and a probe, and the base every other kind is built from.
    fn at(kind: &str, x: f64, y: f64, z: f64) -> Self {
        Self { kind: kind.into(), x, y, z, feed: None, peck_mm: None, text: None }
    }

    /// Attach the feed the move actually carries. A non-positive or non-finite
    /// feed stays ABSENT rather than being written as `0` — see the field: the
    /// two read identically in JSON and mean opposite things to a player.
    fn fed(mut self, feed: f64) -> Self {
        if feed.is_finite() && feed > 0.0 {
            self.feed = Some(feed);
        }
        self
    }
}

/// A vertex of an IMPORTED contour, in millimetres, exactly as the drawing had
/// it.
///
/// `bulge` is `tan(theta / 4)` of the arc sweeping from THIS vertex to the
/// NEXT one; `0.0` is a straight segment; positive sweeps counter-clockwise.
/// That is the same encoding [`crate::geometry::Vertex`] uses, carried across
/// unchanged.
///
/// # 🔴 The arcs are NOT flattened here, and that is the whole point
///
/// [`Report::render`] flattens arcs, because it is for drawing a path. This is
/// not that: it is the **drawing**, and a consumer that measures a radius off it
/// must get the radius the drawing had. Flatten an arc into chords and the
/// measurement comes back small, with nothing on screen to say by how much —
/// a wrong number with no way to know it is wrong.
///
/// So a consumer that wants line segments **tessellates these itself, at a
/// tolerance it chooses and can state**. Given a segment from `a` to `b` with
/// bulge `t`: the swept angle is `4 * atan(t)`, the chord is `|b - a|`, and the
/// radius is `chord / (2 * sin(theta / 2))`. A zero bulge is a straight line and
/// needs none of it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct DrawingVertex {
    pub x: f64,
    pub y: f64,
    /// `tan(theta / 4)` of the arc to the NEXT vertex. `0.0` = straight.
    pub bulge: f64,
}

/// One closed boundary of an imported part, in mm.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DrawingContour {
    pub verts: Vec<DrawingVertex>,
    /// Whether the last vertex joins back to the first. An outer boundary or a
    /// hole that reached the CAM is closed — an unclosed contour is refused
    /// upstream and reported in `notes`, never cut — but the flag is carried
    /// rather than assumed, because a consumer that closes an open loop invents
    /// an edge the drawing never had.
    pub closed: bool,
}

/// A part **as the drawing had it**: the outer boundary and every interior
/// boundary, before the CAM touched any of it.
///
/// 🔴 This is the INPUT geometry, and it is deliberately the one thing
/// [`Report::render`] can never give you back. `render` is the **cutter centre
/// line**: already offset by the tool radius, already carrying lead-ins, tabs
/// and corner reliefs. Un-offsetting it means undoing three transforms that
/// were never invertible, and every attempt to do that outside the core has
/// been a defect.
///
/// 🔴 The holes are as load-bearing as the outline. A part drawn without them
/// looks entirely correct and is a plate with no holes in it — the same failure
/// gate P8 exists for.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DrawingPart {
    pub name: String,
    pub outer: DrawingContour,
    /// Interior boundaries — holes, slots, rabbets. Empty means the part has
    /// none, which is a fact the importer measured; it never means "not
    /// exported", because the outer boundary would be absent too in that case.
    pub inners: Vec<DrawingContour>,
}

fn drawing_contour_of(c: &Contour) -> DrawingContour {
    DrawingContour {
        verts: c
            .verts
            .iter()
            .map(|v| DrawingVertex { x: v.x, y: v.y, bulge: v.bulge })
            .collect(),
        closed: c.closed,
    }
}

/// The imported parts, as the drawing had them. Called with the parts the
/// importer produced, BEFORE any operation is generated from them.
fn drawing_of(parts: &[Part]) -> Vec<DrawingPart> {
    parts
        .iter()
        .map(|p| DrawingPart {
            name: p.name.clone(),
            outer: drawing_contour_of(&p.outer),
            inners: p.inners.iter().map(drawing_contour_of).collect(),
        })
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SimCounts {
    pub cell_mm: f64,
    pub gouge: usize,
    pub uncut: usize,
    pub spoilboard: usize,
    pub first: Option<String>,
    /// 🔴 **THE FIELD THAT SAYS WHETHER `uncut` IS A MEASUREMENT** (audit
    /// finding B4, 2026-08-10).
    ///
    /// `false` ⇒ the `Uncut` limb of the simulation **did not run**, and `uncut`
    /// is **PENDING**, not zero-because-clean. That was the state of every
    /// imported job ever planned by this core: removal regions are populated in
    /// exactly one place — the built-in `pocket` fixture — so on the shipping
    /// path the check had nothing to test and reported `0`.
    ///
    /// **A consumer must key off THIS, not off `uncut`.** `0` and `0` are the
    /// same three glyphs whether nobody asked or nothing was standing, and this
    /// lane's second duty is that a check which cannot run reports PENDING, never
    /// PASS.
    ///
    /// ⚠ `#[serde(default)]` lands it as `false` — PENDING — for any payload
    /// written before the field existed. A missing honesty flag must default to
    /// the honest answer, not the reassuring one.
    #[serde(default)]
    pub uncut_checked: bool,
    /// The evidence behind [`uncut_checked`](Self::uncut_checked): map cells that
    /// actually fell inside a declared removal region. Counted by the scan, never
    /// from the region list — see [`crate::sim::UncutCoverage`]. `0` here is what
    /// makes the flag `false`, and a gate can assert on it without re-deriving
    /// any geometry.
    #[serde(default)]
    pub uncut_cells_tested: usize,
    /// Why it did not run, in words, from the core so every host says the same
    /// thing. `None` when it ran.
    ///
    /// ⚠ It is also pushed into [`Report::notes`], because a consumer that reads
    /// the counters may never read this struct's tail — and the note is what
    /// reaches an operator who is looking at a number, not at a schema.
    #[serde(default)]
    pub uncut_pending_reason: Option<String>,

    /// 🔴 **OF THE `spoilboard` CELLS ABOVE, THE ONES THAT REACHED BARE
    /// MACHINE** (2026-08-10).
    ///
    /// `spoilboard` counts every cell that went below the underside of the
    /// workpiece by more than the sacrificial allowance. Until today that was the
    /// whole answer, and it conflated two programs that could not be more
    /// different: a through-cut **over** the spoilboard is what a through-cut is
    /// **for**, while the same cut **past the board's edge** is a 2.2 kW spindle
    /// driving a cutter into a rail. **This is the number that separates them,
    /// and it is the one to alarm on** — `spoilboard` on its own is not a defect
    /// count at all.
    ///
    /// ⚠ Only meaningful when [`spoilboard_position_checked`](Self::spoilboard_position_checked)
    /// is `true`. `0` with the flag `false` is PENDING, exactly as `uncut: 0`
    /// is — see that field for the full argument, which this one inherits.
    #[serde(default)]
    pub past_spoilboard_edge: usize,
    /// 🔴 **THE FIELD THAT SAYS WHETHER `past_spoilboard_edge` IS A
    /// MEASUREMENT.** `false` ⇒ no spoilboard is declared on this machine, the
    /// below-the-workpiece cells were judged on DEPTH ALONE, and nothing here says
    /// what the cutter reached.
    ///
    /// ⚠ `#[serde(default)]` lands it as `false` — PENDING — for any payload
    /// written before the field existed. A missing honesty flag must default to
    /// the honest answer, not the reassuring one.
    #[serde(default)]
    pub spoilboard_position_checked: bool,
    /// Why the position limb did not run, in words, from the core. `None` when
    /// it ran.
    #[serde(default)]
    pub spoilboard_pending_reason: Option<String>,

    /// 🔴 **THE DEPTH LIMB'S VERDICT, AS A WORD** —
    /// [`crate::sim::BoardDepth::as_str`]: `"through-board"`, `"inside-board"`
    /// or `"board-depth-unknown"`.
    ///
    /// It answers a **different question** from the three fields above. Those
    /// ask *"is there a board under this XY at all"*; this asks *"the board is
    /// under here — did the cut go past its underside into the machine?"* A job
    /// can be over the board with an unknown thickness, or past the board's edge
    /// with a perfectly known one, so a host must render the two limbs
    /// separately — see [`crate::sim::SpoilboardDepth`].
    ///
    /// 🔴 **`"board-depth-unknown"` IS PENDING, NOT A PASS. COLOUR THIS FIELD,
    /// NEVER THE INTEGER BESIDE IT.** `through_board: 0` means nothing on its
    /// own: `0` is the value a limb that compared nothing reports and also the
    /// value a limb that compared everything and found nothing reports. This is
    /// the fourth counter in this codebase to be given a companion for that
    /// reason, and the companion is a three-state WORD rather than a boolean
    /// precisely so a host cannot render PENDING and CLEAR the same way.
    ///
    /// ⚠ The serde default is **`"board-depth-unknown"`** and not the empty
    /// string, so a payload written before this field existed deserialises to
    /// the honest answer rather than to something a renderer has to guess about
    /// — the same rule [`spoilboard_position_checked`](Self::spoilboard_position_checked)
    /// documents, in the one shape a `String` allows it to be stated.
    #[serde(default = "board_depth_unknown")]
    pub board_depth: String,
    /// 🔴 **CELLS THAT WENT PAST THE DECLARED BOARD'S UNDERSIDE** — cutter below
    /// the slab, in whatever the machine is built of.
    ///
    /// ⚠ Only meaningful when [`board_depth`](Self::board_depth) is
    /// `"through-board"` or `"inside-board"`. `0` beside `"board-depth-unknown"`
    /// is **PENDING**, exactly as `uncut: 0` and `past_spoilboard_edge: 0` are —
    /// see [`uncut_checked`](Self::uncut_checked) for the full argument, which
    /// this field inherits.
    ///
    /// ⚠ Cells **past the board's edge are not counted here at all**: there is
    /// no board under them for a cut to go through, and the position limb has
    /// already reported them. Counting one hazard in two places renders it as
    /// two.
    #[serde(default)]
    pub through_board: usize,
    /// Why the depth limb did not run, in words, from the core so every host
    /// says the same thing. `None` when it ran.
    ///
    /// ⚠ It is also pushed into [`Report::notes`], for the same reason
    /// [`uncut_pending_reason`](Self::uncut_pending_reason) is: a consumer that
    /// reads the counters may never read this struct's tail, and the note is
    /// what reaches an operator who is looking at a number rather than at a
    /// schema.
    #[serde(default)]
    pub board_depth_pending_reason: Option<String>,
}

/// The serde default for [`SimCounts::board_depth`] — **PENDING**.
///
/// 🔴 A missing honesty field must deserialise to the honest answer, never to
/// the reassuring one, and for a `String` that cannot be spelled `false`. An
/// empty string would be neither: a renderer with a three-way match on the
/// verdict would fall through its own arms and print whatever its `_` case says,
/// which on every UI written so far is the harmless one.
fn board_depth_unknown() -> String {
    crate::sim::BoardDepth::Unknown.as_str().to_string()
}

/// The **simulated stock surface after machining** — a Z-map of what the
/// simulation believes is left of the block, at a stated resolution.
///
/// # 🔴 What this is NOT, and why the name is the defence
///
/// It is **not the part**, **not the finished product**, and **not a model of
/// the object that comes off the machine**. Two properties make that
/// distinction load-bearing rather than pedantic, and both are permanent:
///
/// * **It is a MODEL AT A RESOLUTION.** Every value is the surface height at one
///   sample point [`cell_mm`](Self::cell_mm) apart. A gouge narrower than one
///   cell is not merely blurred — it is **absent**. Rendering this and calling
///   it the part asserts a smoothness the simulation never measured.
/// * **For a through-cut it shows REMOVED MATERIAL, and does not know which side
///   of the cut you keep.** The engine cuts a closed boundary; the part and the
///   offcut are on opposite sides of it and this map treats both identically —
///   both are "material that is still there". A renderer cannot recover the part
///   from this data, because the information is not in it.
///
/// So a UI may draw this, colour it, move it, measure it — and must label it as
/// the **simulated stock surface**. It must not label it "the part", "the
/// finished object", "the result" or anything a customer would read as the
/// thing they will hold. The field name is the last defence against that,
/// because it is the one word that survives being copied into a component prop.
///
/// # Encoding, and what it costs
///
/// [`z_mm_b64`](Self::z_mm_b64) is `cols * rows` little-endian `f32`, in
/// row-major order (`index = row * cols + col`), **base64** (RFC 4648, standard
/// alphabet, padded). The browser decodes it with `atob` into a `Uint8Array` and
/// wraps it as a `Float32Array` — no per-element parsing, no re-derivation.
///
/// 🔴 The obvious alternative — a JSON array of numbers — was rejected. A
/// decimal float costs ~9-12 bytes of text and one `parse` each; at the default
/// 0.6mm cell a 600x900 workpiece is 1,001 x 1,501 = **1,502,501 cells**, i.e. ~15MB
/// of JSON text to serialise, transfer and parse into a boxed-number array.
/// Base64 costs `4/3` of the raw 4 bytes per cell: **8.0MB** for the same map,
/// decoded in one pass into a typed array the GPU can take directly.
///
/// That is still far too much to send while someone drags a slider, which is why
/// this whole struct is **optional and opt-in** and why the caller states a
/// **display cell size** rather than getting the simulation's own.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StockSurface {
    pub cols: usize,
    pub rows: usize,
    /// 🔴 The resolution **of this array**, not of the simulation that produced
    /// it — they differ whenever a coarser display cell was asked for. It rides
    /// inside the struct, so every consumer can state the resolution of what it
    /// is drawing without asking a second question of a second object.
    pub cell_mm: f64,
    /// The cell the SIMULATION ran at — the finest thing that ever existed for
    /// this map. `cell_mm` above is what survived the reduction to display
    /// resolution, and the gap between the two is the whole of the oversize
    /// error: a consumer that has only one of the numbers cannot state it.
    pub sim_cell_mm: f64,
    /// World coordinate of sample `(col 0, row 0)`. Sample `(c, r)` sits at
    /// `(origin_x_mm + c * cell_mm, origin_y_mm + r * cell_mm)`.
    pub origin_x_mm: f64,
    pub origin_y_mm: f64,
    /// Surface height per sample, measured from the workpiece top: `0.0` = uncut,
    /// negative = material removed to that depth. Base64 of little-endian `f32`.
    pub z_mm_b64: String,
    /// 🔴 **What this array gets WRONG, in words, travelling with the array.**
    ///
    /// Written by [`crate::sim::Precision::surface_note`], in the core, so every
    /// host says the same thing about the same picture. A caveat that lives in
    /// one renderer is absent from every other consumer — and the consumer that
    /// lacks it has no way to tell that it is missing.
    ///
    /// Anything that DRAWS this must show this string. The founder read a 6.0mm
    /// hole as 9.0mm off the 3.0mm display cell and asked why a through hole
    /// could be seen through; both are answered here, and neither was said on
    /// screen while the layer's own note claimed to have covered the risk.
    pub note: String,
}

/// Base64 encode, RFC 4648 standard alphabet, padded.
///
/// Hand-rolled rather than pulled in as a dependency: this lane licence-checks
/// every dependency against AGPL before it lands, and ~20 lines of table lookup
/// is not worth a supply-chain entry. The encoder is pinned to the standard by
/// the RFC's own test vectors in `stock_surface_tests`, because a hand-rolled
/// encoder checked only against a hand-rolled decoder proves the two agree with
/// each other and nothing about whether `atob` agrees with either.
fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Take the simulation's height map down to a display resolution and encode it.
///
/// `display_cell_mm` is a REQUEST, not a promise: the simulation's own cell is
/// the finest thing that exists, so the emitted cell is `sim_cell * k` where
/// `k = round(display_cell / sim_cell)`, clamped to at least 1. The emitted
/// `cell_mm` is the resulting true resolution — never the number that was asked
/// for. A struct that reported the requested cell would be a control asserting
/// something untrue about itself.
///
/// 🔴 The reduction over each `k x k` block is the **minimum** (the deepest
/// surface), never an average. A mean would let one cut cell be averaged away by
/// its uncut neighbours, so a coarse view would show LESS removal than the
/// simulation found — the unsafe direction. Taking the deepest over-reports
/// removed area at coarse cells and never under-reports it, matching the same
/// conservative choice `sim::simulate` makes for ball-nose tools.
fn stock_surface_of(hm: &crate::sim::HeightMap, display_cell_mm: f64) -> StockSurface {
    let k = if display_cell_mm > hm.cell_mm {
        ((display_cell_mm / hm.cell_mm).round() as usize).max(1)
    } else {
        1
    };
    let cols = hm.cols.div_ceil(k);
    let rows = hm.rows.div_ceil(k);
    let mut bytes = Vec::with_capacity(cols * rows * 4);
    for r in 0..rows {
        for c in 0..cols {
            // Deepest sample in the block whose top-left corner IS this output
            // sample, so the output sample's world coordinate stays exact.
            let mut z = f32::INFINITY;
            for dr in 0..k {
                let sr = r * k + dr;
                if sr >= hm.rows {
                    break;
                }
                for dc in 0..k {
                    let sc = c * k + dc;
                    if sc >= hm.cols {
                        break;
                    }
                    z = z.min(hm.at(sc, sr));
                }
            }
            bytes.extend_from_slice(&(if z.is_finite() { z } else { 0.0 }).to_le_bytes());
        }
    }
    let cell_mm = hm.cell_mm * k as f64;
    // 🔴 The note is derived from the cells this function ACTUALLY produced,
    // never from `display_cell_mm` — the request. A caveat quoting the number
    // that was asked for would describe a map that was not emitted, which is
    // the same defect as `cell_mm` reporting the request.
    let precision = crate::sim::Precision::new(hm.cell_mm, Some(cell_mm), 0.0);
    StockSurface {
        cols,
        rows,
        cell_mm,
        sim_cell_mm: hm.cell_mm,
        origin_x_mm: hm.origin_x,
        origin_y_mm: hm.origin_y,
        z_mm_b64: b64(&bytes),
        // `k == 1` means the drawn map IS the simulation, so there is no
        // reduction to warn about — but the map is still a sampled surface, and
        // saying nothing at all would read as "this one is exact".
        note: precision.surface_note().unwrap_or_else(|| {
            format!(
                "the DRAWN surface is the simulation itself, at {cell_mm}mm cells — not reduced, and still a \
                 sampled height map: its corners are the CELL GRID, not the cutter, and a through cut is drawn \
                 as a PIT whose floor sits at the underside of the workpiece, not as an opening. Do not measure a \
                 feature off it"
            )
        }),
    }
}

/// The mesh the user LOADED, carried through for drawing.
///
/// 🔴 **THIS IS THE INPUT, AND IT IS NOT WHAT WILL BE CUT.** What gets cut is
/// the **section** at [`section_z_mm`](Self::section_z_mm) — one flat outline
/// through this solid, planned as 2.5D. The machine does not make this shape and
/// cannot: there is no Z-level roughing, no waterline, no surfacing anywhere in
/// this engine. A viewer shown a 3D solid will assume the machine produces it,
/// which is the exact belief [`crate::mesh`] exists to prevent — and a picture
/// asserts it far more strongly than a sentence can withdraw it. Anything that
/// draws this must draw or state the section too, and must never label it "the
/// part", "your part", "the result" or "what you will get".
///
/// The contrast with [`StockSurface`] is deliberate and worth keeping straight,
/// because the two are opposite ends of the same job:
///
/// | | [`LoadedMesh`] | [`StockSurface`] |
/// |---|---|---|
/// | what it is | the model as loaded | the workpiece after machining |
/// | direction | INPUT | OUTPUT |
/// | on a refused job | still present — the file exists regardless | absent, because no machining happened |
///
/// # Encoding, and what it costs
///
/// [`xyz_mm_b64`](Self::xyz_mm_b64) is `triangles * 9` little-endian `f32` —
/// three corners of `[x, y, z]` per triangle, in order — **base64** (RFC 4648,
/// standard alphabet, padded), decoded in the browser with `atob` straight into
/// a `Float32Array`. Same transport as [`StockSurface`] and the same encoder,
/// for the same reason: a JSON array of decimals is ~3x the bytes and one
/// `parse` per number.
///
/// Triangles are **not indexed and not shared**: an STL has no topology to
/// preserve, so 36 bytes of vertex per triangle is what the format actually
/// carries. 48 bytes after base64. A 100k-triangle part is therefore **4.8MB per
/// call**, which is why this is opt-in and why a budget exists.
///
/// 🔴 Millimetres are **ASSUMED**, not read — an STL file declares no units at
/// all. That assumption is already stated in the report's notes on every mesh
/// import; it applies to these coordinates and to the bounds identically.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoadedMesh {
    /// How many triangles are **in the array below** — never the number that was
    /// asked for. A caller that trusted its own budget would draw a mesh that
    /// does not exist and index off the end of one that does.
    pub triangles: usize,
    /// How many triangles the FILE had. Equal to `triangles` unless the budget
    /// bit; the pair is what lets a UI say "showing 20,000 of 412,336" instead
    /// of silently presenting a sieve as the model.
    pub source_triangles: usize,
    /// True when the budget dropped triangles — see
    /// [`crate::mesh::Mesh::display_sample`] for what that costs. A decimated
    /// mesh is a DIFFERENT SOLID with holes in it and is fit for display only.
    pub decimated: bool,
    /// Axis-aligned bounds of the DELIVERED triangles, in mm-by-assumption.
    /// After decimation these can be tighter than the real part's, which is one
    /// more reason nothing may measure this.
    pub min_mm: [f64; 3],
    pub max_mm: [f64; 3],
    /// The Z this mesh was sectioned at — the plane that produced the outline
    /// the machine will actually follow. It rides inside the struct so a
    /// renderer can draw the cut plane against the solid without going and
    /// asking a second object where the truth is.
    pub section_z_mm: f64,
    /// `triangles * 9` little-endian `f32`, base64. Corner order is as the file
    /// gave it; winding is not normalised and the STL's stored normals are
    /// discarded (see [`crate::mesh::parse_binary_stl`] for why they cannot be
    /// trusted) — a renderer that needs normals must compute them.
    pub xyz_mm_b64: String,
}

impl LoadedMesh {
    /// The sentence a decimated mesh has to put on the screen, or `None` when
    /// nothing was dropped.
    ///
    /// It is generated from the struct's own numbers rather than written at the
    /// call site, so a note claiming a count and a field carrying one cannot
    /// drift apart.
    pub fn decimation_note(&self) -> Option<String> {
        if !self.decimated {
            return None;
        }
        Some(format!(
            "the 3D view is showing {} of this model's {} triangles — a display budget dropped the rest. \
             What you are looking at is NOT the model: it has holes where those facets were. Nothing was \
             decimated for cutting; the section at z = {:.3}mm was taken from the FULL mesh",
            self.triangles, self.source_triangles, self.section_z_mm
        ))
    }
}

/// Encode a parsed mesh for the browser, at most `budget` triangles.
///
/// `None` when the mesh has no triangles at all: there is no solid to draw, and
/// an empty-but-present mesh reads to a UI as "a 3D object that happens to be
/// invisible" rather than "this file gave us no geometry" — which the report's
/// notes already say in those words.
fn loaded_mesh_of(mesh: &crate::mesh::Mesh, budget: usize, section_z_mm: f64) -> Option<LoadedMesh> {
    if mesh.tris.is_empty() {
        return None;
    }
    let kept = mesh.display_sample(budget);
    let mut bytes = Vec::with_capacity(kept.len() * 36);
    let mut min_mm = [f64::INFINITY; 3];
    let mut max_mm = [f64::NEG_INFINITY; 3];
    for t in &kept {
        for v in t.iter() {
            for k in 0..3 {
                min_mm[k] = min_mm[k].min(v[k]);
                max_mm[k] = max_mm[k].max(v[k]);
                bytes.extend_from_slice(&(v[k] as f32).to_le_bytes());
            }
        }
    }
    Some(LoadedMesh {
        triangles: kept.len(),
        source_triangles: mesh.tris.len(),
        decimated: kept.len() < mesh.tris.len(),
        min_mm,
        max_mm,
        section_z_mm,
        xyz_mm_b64: b64(&bytes),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Report {
    pub job: String,
    pub ok: bool,
    pub gcode: String,
    pub refusals: Vec<String>,
    pub notes: Vec<String>,
    pub fixture_findings: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub tools_used: Vec<String>,
    pub tool_changes: usize,
    pub cutting_distance_mm: f64,
    pub rapid_distance_mm: f64,
    pub estimated_seconds: f64,
    pub deepest_z_mm: f64,
    pub tab_lifts: usize,
    pub dogbones: usize,
    /// Every distinct CUTTING feed the emitted program commands, mm/min, in
    /// first-appearance order — [`crate::feeds::cutting_feeds_in_program`].
    ///
    /// 🔴 FROM THE BYTES, NOT FROM `render`. A host that walked the plan for
    /// this displayed the wrong number and dropped every drilling feed, and the
    /// obvious repair would have re-derived "which F words are cuts" outside
    /// this crate. See that function for why the answer is computed here.
    ///
    /// ⚠ A LIST, NOT A MAXIMUM, and a host may not collapse it silently: "the
    /// fastest number in the file" and "the feed this job cuts at" are
    /// different claims.
    #[serde(default)]
    pub cutting_feeds_mm_min: Vec<f64>,
    pub sim: SimCounts,
    /// Fixes the CORE is prepared to offer for the refusals above, as data.
    ///
    /// 🔴 An offer, never an action. Each carries what it changes, the from and
    /// to values, why, and a NON-EMPTY `recheck` list — because applying one
    /// invalidates the check that produced it. A datum shift moves the part
    /// relative to clamps bolted to the machine, which is gate P7's physical
    /// failure, so nothing here applies itself.
    ///
    /// `skip_deserializing`: `Report` derives `Deserialize` and `OfferedFix`
    /// deliberately does not. A machining instruction must not arrive from JSON
    /// having skipped the computation that defends it.
    #[serde(default, skip_deserializing)]
    pub offered_fixes: Vec<crate::job::OfferedFix>,
    /// The simulated stock surface after machining — **present only if the
    /// caller asked for it**, `None` otherwise.
    ///
    /// 🔴 Opt-in because it is large: see [`StockSurface`] for the byte cost and
    /// for what a renderer must not claim about it. Declining is the default
    /// precisely so a re-plan on every slider drag stays cheap; a caller that
    /// wants to draw the result asks for it at a display cell size it can
    /// afford.
    pub simulated_stock_surface: Option<StockSurface>,
    /// The model the user LOADED — **present only if the caller asked for it**,
    /// and only for a mesh import.
    ///
    /// 🔴 It is the INPUT, not the output, and **it is not what will be cut**:
    /// the machine cuts the flat section at [`LoadedMesh::section_z_mm`]. Read
    /// [`LoadedMesh`] before drawing it.
    ///
    /// `None` means one of three things, and none of them is "an object with no
    /// triangles": nobody asked; this was a DXF or SVG, which has no 3D object
    /// in it at all; or the file yielded no triangles, in which case `notes`
    /// says so in those words. A UI must treat absence as "nothing to draw" and
    /// say WHICH of those it is from the rest of the report — a disabled toggle
    /// with a reason is a promise, a missing one looks like a bug.
    pub loaded_mesh: Option<LoadedMesh>,
    /// Flattened for drawing. Arcs are sampled here and ONLY here — the emitted
    /// G-code still carries real G2/G3.
    ///
    /// 🔴 The **largest field in this struct** on any real job, and the one that
    /// rides on every single plan. Anything added to [`RenderMove`] is paid for
    /// once per move, so a field that is set on a handful of moves is optional
    /// and omitted on the rest, never present-and-empty.
    pub render: Vec<RenderMove>,
    /// The imported drawing, **as it was imported** — outer boundary and holes
    /// per part, in mm, before any tool offset.
    ///
    /// 🔴 EMPTY MEANS "the core did not export contours for this report", NOT
    /// "the drawing has no geometry". It is empty for every REFERENCE FIXTURE
    /// (`plan_report*`), which is constructed from code and has no drawing
    /// behind it, and for an import that was refused before parts existed. It is
    /// populated for every import that produced at least one part — and an
    /// import that produced none comes back `ok: false` with a reason in
    /// `errors`, which is how a consumer tells the two apart.
    ///
    /// See [`DrawingPart`] for why this exists at all rather than being
    /// recovered from `render`, and [`DrawingVertex`] for the arc encoding —
    /// **the arcs are NOT flattened here**.
    #[serde(default)]
    pub drawing: Vec<DrawingPart>,
    /// The machine's rapid rate, mm/min — `None` when no job ran.
    ///
    /// 🔴 It is here because a `G0` **carries no `F` word**, so a rapid's
    /// duration cannot be read off the move; this is the rate the core's own
    /// `estimated_seconds` charges rapids at, so a host timing the same program
    /// against the same number agrees with the report instead of quietly
    /// disagreeing with it.
    ///
    /// ⚠ It is the COMMANDED rate, not a measured one. Neither this nor
    /// `estimated_seconds` models acceleration, so both run short on a program
    /// full of little moves — `notes` says so with this job's numbers.
    #[serde(default)]
    pub rapid_mm_min: Option<f64>,
    /// **Operator time charged for ONE tool change, in seconds** — the rate the
    /// core's own `estimated_seconds` actually used. `None` when no job ran.
    ///
    /// 🔴 It is here for the same reason [`rapid_mm_min`](Self::rapid_mm_min) is,
    /// and the failure is sharper: **the emitted program carries no duration for
    /// a tool change at all.** It writes `M0` and stops, and how long a person
    /// takes to unclamp a collet, swap a cutter and re-reference Z is not in the
    /// file. A host timing the same program has nothing to read, so it invents a
    /// number — and until this field existed `web/src/App.tsx` invented `60`
    /// while the core charged `120`, so the playback clock under-read by a
    /// minute per change against a report sitting beside it (item `#90`).
    ///
    /// 🔴 **IT IS READ OFF THE ESTIMATE'S BASIS, NOT OFF THE MACHINE.**
    /// `built.job.machine.tool_change_seconds` is `Option` and absent means
    /// *nobody declared it*; resolving that absence here would re-derive
    /// [`crate::job::DEFAULT_TOOL_CHANGE_SECONDS`] in a second place, which is a
    /// **new copy of the exact defect this field removes**. The basis holds what
    /// was CHARGED, whichever way it got there.
    ///
    /// ⚠ Multiply it by [`tool_changes`](Self::tool_changes) to recover the
    /// operator time inside `estimated_seconds`, and subtract to get machine
    /// time. It is the ONE input to that estimate that can make it **over**-read
    /// — every other property makes it a floor — which is why it is reported as
    /// its own term rather than buried in the total.
    #[serde(default)]
    pub tool_change_seconds: Option<f64>,
    /// 🔴 **THE FIELD THAT SAYS WHETHER [`tool_change_seconds`](Self::tool_change_seconds)
    /// IS SOMEBODY'S NUMBER.**
    ///
    /// `true` ⇒ it came from [`crate::types::Machine::tool_change_seconds`], a
    /// declaration about this machine and the person standing at it. `false` ⇒
    /// **nobody declared one** and the estimate fell back to
    /// [`crate::job::DEFAULT_TOOL_CHANGE_SECONDS`], **which is the founder's
    /// estimate of his own shop and not a measurement** — the constant's own doc
    /// records that no per-change figure could be sourced. A shop reading a
    /// two-hour estimate is entitled to know which of those it is looking at.
    ///
    /// ⚠ `#[serde(default)]` lands it as `false` — undeclared — for any payload
    /// written before the field existed. A missing provenance flag must default
    /// to the weaker claim, not the stronger one.
    ///
    /// ⚠ A declared rate that happens to EQUAL the default still reports `true`.
    /// "Somebody chose 120" and "nobody said, so we used 120" are different
    /// facts and this is the only field that separates them.
    #[serde(default)]
    pub tool_change_rate_declared: bool,
    pub stock: [f64; 3],
    /// **The travel envelope** — `[x, y, z]` in mm, everywhere the cutter can
    /// REACH, measured from the machine datum at `0,0`.
    ///
    /// 🔴 IT IS NOT A SURFACE AND IT IS NOT THE SPOILBOARD. The browser drew
    /// these two numbers as a solid plane labelled **"table / bed"** — the
    /// machine's *reach* rendered as the *object the work lies on* — so a
    /// picture of the travel was doing duty as a picture of the material. They
    /// are different rectangles: the spoilboard is smaller, is somewhere on the
    /// machine, and is the only one made of anything. See
    /// [`crate::types::TravelEnvelope`] and [`Report::spoilboard`].
    ///
    /// It is echoed HERE, off the same `Job` the program was planned from,
    /// rather than left to the host to remember what it posted — the clamp
    /// lesson: the viewport draws from the report, and a value that reaches the
    /// planner but not the echo gives the browser a picture of a machine the
    /// check does not have.
    #[serde(default)]
    pub travel: [f64; 3],
    /// The declared spoilboard, echoed back. `None` = **nobody declared one**,
    /// and a host must render that as UNCHECKED — never as a board the size of
    /// [`travel`](Self::travel), which is the assumption this whole change
    /// exists to remove.
    #[serde(default)]
    pub spoilboard: Option<SpoilboardCfg>,
    /// How much of the reachable area the declared board leaves BARE, as the
    /// four edge strips in mm. `None` when no board is declared — which is a
    /// different fact from "all four are zero", and only the second means the
    /// board covers everywhere the cutter can go.
    #[serde(default)]
    pub spoilboard_bare_reach: Option<[f64; 4]>,
    pub clamps: Vec<ClampCfg>,
    /// 🔴 **The transform that takes `drawing` into the frame `render` and
    /// `gcode` are already in** — `Job::place`, measured out of itself.
    ///
    /// The two geometry fields on this report are in DIFFERENT FRAMES and always
    /// have been: `drawing` is the imported outline in drawing millimetres, and
    /// `render`/`gcode` are machine coordinates with the placement already
    /// applied. Nothing said so, and the browser drew both raw — so the walls
    /// and the loaded solid stood at the machine origin while the workpiece was
    /// drawn at its datum, and any non-zero datum or rotation put the object
    /// beside the workpiece. That is what the founder saw on 2026-08-09.
    ///
    /// A host draws `drawing` (and `loaded_mesh`, which is in the same frame)
    /// under this transform and it lands exactly where the program cuts.
    /// Re-deriving it from `stock` in the host is the mistake this field exists
    /// to remove.
    #[serde(default)]
    pub drawing_placement: crate::job::Placement2D,
}

/// Flatten an arc for DISPLAY. The G-code keeps the arc.
fn flatten_arc(from: (f64, f64), m: &Move, out: &mut Vec<RenderMove>, kind: &str) {
    let (cx, cy) = (m.centre.x, m.centre.y);
    let r = ((from.0 - cx).powi(2) + (from.1 - cy).powi(2)).sqrt();
    let a0 = (from.1 - cy).atan2(from.0 - cx);
    let a1 = (m.to.y - cy).atan2(m.to.x - cx);
    let cw = m.kind == MoveKind::ArcCW;
    let mut sweep = a1 - a0;
    if cw {
        while sweep > 0.0 {
            sweep -= std::f64::consts::TAU;
        }
    } else {
        while sweep < 0.0 {
            sweep += std::f64::consts::TAU;
        }
    }
    let n = (((r * sweep.abs()) / 0.8).ceil() as usize).clamp(2, 256);
    for i in 1..=n {
        let t = i as f64 / n as f64;
        let a = a0 + sweep * t;
        // Every sampled point of one arc carries the SAME feed, because one
        // `G2`/`G3` block is one feed. The flattening is a display decision and
        // must not change what the move says about itself.
        out.push(RenderMove::at(kind, cx + r * a.cos(), cy + r * a.sin(), m.to.z).fed(m.feed));
    }
}

/// Count tabs: a LOCAL excursion above final depth and back.
/// (Counting every move above the deepest Z counts depth passes, not tabs.)
pub fn count_tabs(path: &Toolpath) -> usize {
    let cutting: Vec<f64> = path
        .moves
        .iter()
        .filter(|m| matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW))
        .map(|m| m.to.z)
        .collect();
    let deepest = cutting.iter().cloned().fold(f64::INFINITY, f64::min);
    if !deepest.is_finite() {
        return 0;
    }
    let at = |z: f64| (z - deepest).abs() < 1e-6;
    let up = |z: f64| z > deepest + 0.5 && z < -1e-6;
    let mut tabs = 0;
    let mut i = 0;
    while i < cutting.len() {
        if at(cutting[i]) {
            let mut j = i + 1;
            while j < cutting.len() && up(cutting[j]) {
                j += 1;
            }
            if j > i + 1 && j < cutting.len() && at(cutting[j]) {
                tabs += 1;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    tabs
}

/// Plan a reference job and report everything about it.
///
/// 🔴 EVERY host goes through here — the CLI, the browser, and the gates. That
/// is the whole point: `gcode` produced in a browser and `gcode` produced on the
/// command line are byte-identical because they are the same function call, not
/// two implementations that agree today.
pub fn plan_report(name: &str, plant: JobPlant, cfg: &JobConfig, sim_cell_mm: f64) -> Option<Report> {
    plan_report_with_surface(name, plant, cfg, sim_cell_mm, None)
}

/// [`plan_report`], plus the simulated stock surface if the caller wants one.
///
/// `surface_cell_mm` is the **only** way to get [`Report::simulated_stock_surface`]
/// populated: `None` declines it and is what every existing caller gets.
/// `Some(mm)` asks for the surface resampled to about that display resolution —
/// see [`stock_surface_of`] for why "about".
///
/// 🔴 It is an argument and not a [`JobConfig`] field on purpose. `JobConfig`
/// describes THE JOB — what to cut, with what, held how — and is applied to the
/// job before planning. This changes nothing about the program; it asks for a
/// bigger answer. Putting it in the config would make a report-size knob look
/// like a machining setting, and machining settings are the ones a gate must
/// scrutinise.
pub fn plan_report_with_surface(
    name: &str,
    plant: JobPlant,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> Option<Report> {
    let mut r = plan_report_raw(name, plant, cfg, sim_cell_mm, surface_cell_mm)?;
    // 🔴 A PLANT THAT IS NOT IN FORCE REFUSES. `apply` runs after `build` and
    // overwrites the very fields the plants plant, so a config could silently
    // switch a negative control off while the `PLANTED:` note above kept
    // claiming it was armed. See `plant_audit`. Nothing runs here for a real
    // job: `JobPlant::None` returns before anything is planned twice.
    plant_audit(name, plant, cfg, |c, p| plan_report_raw(name, p, c, sim_cell_mm, None))
        .enforce(&mut r);
    Some(r)
}

/// [`plan_report_with_surface`] **without** the negative-control audit.
///
/// 🔴 It exists so the audit can plan the same job with and without the plant
/// without re-entering itself, and for that reason only. Every host goes through
/// the checked door above; this one is the audit's own instrument.
fn plan_report_raw(
    name: &str,
    plant: JobPlant,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> Option<Report> {
    let mut built = build(name, plant)?;
    cfg.apply(&mut built);
    Some(report_of_with_surface(&built, sim_cell_mm, surface_cell_mm))
}

/// Plan a built job and describe everything about the result.
///
/// Shared by the reference fixtures and by imported drawings so both take the
/// identical route to G-code — a second reporting path would be a second place
/// for a refusal to be forgotten.
pub fn report_of(built: &BuiltJob, sim_cell_mm: f64) -> Report {
    report_of_with_surface(built, sim_cell_mm, None)
}

/// [`report_of`], optionally carrying the simulated stock surface.
///
/// The simulation runs identically either way — `surface_cell_mm` decides only
/// whether the height map it already produced is ALSO reported, and at what
/// display resolution. Nothing about the emitted G-code can depend on it, which
/// is why the same function serves both.
pub fn report_of_with_surface(
    built: &BuiltJob,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> Report {
    let name = built.job.name.clone();
    let name = name.as_str();
    let r = plan_job(&built.job);
    let tool_r = r.path.tool.radius_mm().max(0.1);

    // 🔴 Through the COVERAGE-CARRYING door. `simulate_and_check` hands back the
    // findings alone, and a finding list cannot say whether the `Uncut` limb ever
    // visited a cell — which is finding B4: `uncut: 0` on every imported job,
    // reported by a check with nothing to test.
    let (hm, checked) = simulate_and_check_with_coverage(&built, &r.path, sim_cell_mm);
    let findings = &checked.findings;
    // 🔴 Built HERE rather than inline in the struct literal so the precision
    // notes below can quote the cell the surface ACTUALLY came out at. Quoting
    // `surface_cell_mm` — the request — would put a number in the warning that
    // is not the number in the array, which is the defect `cell_mm` already
    // exists to avoid.
    let surface = surface_cell_mm.map(|c| stock_surface_of(&hm, c));
    // Worst case, not nominal: the edge sliver and the below-one-cell blindness
    // both bite hardest on the SMALLEST cutter in the program, and a job with a
    // 3mm cutter in it does not get to quote the 8mm one's figures.
    //
    // ⚠ `tool_r` is the FALLBACK the simulation uses for moves nobody stamped —
    // it is only the answer when no move carries a radius at all. Folding it in
    // unconditionally would let a tool the program never runs set the figure.
    let smallest_tool_r = r
        .path
        .moves
        .iter()
        .map(|m| m.tool_r_mm)
        .filter(|v| *v > 0.0)
        .fold(f64::INFINITY, f64::min);
    let smallest_tool_r = if smallest_tool_r.is_finite() { smallest_tool_r } else { tool_r };
    let smallest_tool_r = smallest_tool_r.max(0.01);
    let mut counts = SimCounts {
        // 🔴 The cell the map RAN at, not the one that was asked for.
        // `HeightMap::new` floors the cell at 0.1mm, so a caller asking for 0.05
        // got a 0.1mm map and this field reported 0.05 — the panel and the
        // precision note beside it would then disagree about the same map, and a
        // resolution figure that is not the resolution is the exact defect
        // `StockSurface::cell_mm` already exists to avoid.
        cell_mm: hm.cell_mm,
        gouge: 0,
        uncut: 0,
        spoilboard: 0,
        first: findings.first().map(|f| format!("{f:?}")),
        // 🔴 Read off what the CHECK DID, never off `built.remove`. A job can
        // declare a removal region and still test nothing with it — dropped by
        // the one-cell shrink, or lying off the map — and reading the request
        // would call both of those a measurement.
        uncut_checked: checked.uncut.ran(),
        uncut_cells_tested: checked.uncut.cells_tested,
        uncut_pending_reason: checked.uncut.why_not(),
        // 🔴 Read off what the CHECK DID, never off the machine's config — the
        // same rule as `uncut_checked` one line up. A machine can carry a
        // spoilboard field and still have nothing tested against it (a faulted
        // rectangle is dropped by `sim::check`), and reading the declaration
        // would call that a measurement.
        past_spoilboard_edge: checked.spoilboard.cells_past_edge,
        spoilboard_position_checked: checked.spoilboard.ran(),
        spoilboard_pending_reason: checked.spoilboard.why_not(),
        // 🔴 THE DEPTH LIMB — a SIBLING of the position limb three lines up, not
        // a refinement of it, and read off what the CHECK DID for the same
        // reason. `verdict()` is the only thing here that can say PENDING;
        // deriving it from `through_board > 0` in a host would render an unrun
        // limb as `inside-board`, which is the failure the three-state enum
        // exists to make impossible.
        board_depth: checked.board_depth.verdict().as_str().to_string(),
        through_board: checked.board_depth.cells_through_board,
        board_depth_pending_reason: checked.board_depth.why_not(),
    };
    for f in findings {
        match f {
            crate::sim::SimFinding::Gouge { .. } => counts.gouge += 1,
            crate::sim::SimFinding::Uncut { .. } => counts.uncut += 1,
            // The TOTAL, all three classes, unchanged. The class breakdown is
            // `past_spoilboard_edge` above; moving this number would have moved
            // every gate and golden that reads it, for a reason that has nothing
            // to do with what those gates guard.
            crate::sim::SimFinding::Spoilboard { .. } => counts.spoilboard += 1,
        }
    }

    // 🔴 THE SENTENCE, not just the count — the same pairing `uncut` already
    // has, and for a worse failure. A host that renders integers and ignores a
    // new field still shows `spoilboard: 412` and no indication that 190 of them
    // are in an extrusion. This rides in `notes`, which the CLI prints on every
    // import and the browser shows in its own panel.
    let spoilboard_strike_note = {
        let board = built
            .job
            .machine
            .spoilboard
            .as_ref()
            .map(|b| b.name.clone())
            .unwrap_or_else(|| "(none declared)".to_string());
        // The first offending cell, so the operator has somewhere to go and
        // look. Taken from the findings themselves rather than recomputed —
        // a second derivation is a second place to be wrong about the same cell.
        let first = findings.iter().find_map(|f| match f {
            crate::sim::SimFinding::Spoilboard { x, y, past_mm, below }
                if below.is_strike_on_the_machine() =>
            {
                Some((*x, *y, *past_mm))
            }
            _ => None,
        });
        checked.spoilboard.strike_note(&board, first)
    };
    // The UNCHECKED sentence, for the machine that declared no board at all.
    //
    // 🔴 IT IS EMITTED ON EVERY EXPORT, NOT ONLY WHEN SOMETHING WENT DEEP, and
    // the first draft of this line had it the other way round. "No board is
    // declared" is a fact about the SETUP; gating it on this program's depths
    // would keep it silent on exactly the run where the operator still had time
    // to bolt the board down, and would make it appear for the first time on the
    // job that had already gone through. It is the same rule
    // `FixtureFinding::Undeclared` follows — an undeclared fixture warns every
    // time — and the same reason: nothing declared and verified clear are
    // different facts, and only one of them is safe.
    let spoilboard_pending_note = counts
        .spoilboard_pending_reason
        .as_ref()
        .map(|why| format!("SPOILBOARD POSITION NOT CHECKED ON THIS JOB — {why}."));
    // A declaration that is present and unusable is its own fact, and it is not
    // the same as an absent one: somebody TRIED to declare a board. Reported per
    // fault, with the board's own words.
    //
    // 🔴 `declaration_faults`, NOT `faults` — the union, because this is the
    // REPORTING side. `faults()` is the rectangle alone and is what `sim::check`
    // gates the position limb on; a bad THICKNESS is deliberately kept out of it
    // so a typo in one number cannot switch off the answer to "is there a board
    // under this XY at all". But keeping it out of the gate is not a reason to
    // keep it out of the operator's sight: with `faults()` here, a config
    // declaring `thickness_mm: 0` installed a board, reported PENDING on the
    // depth limb, and said NOTHING about the number that had just been typed.
    let spoilboard_declaration_notes: Vec<String> = built
        .job
        .machine
        .spoilboard
        .as_ref()
        .map(|b| b.declaration_faults())
        .unwrap_or_default();

    // 🔴 THE DEPTH LIMB'S SENTENCE — the same pairing the position limb has one
    // block up, and for the same reason: a host that renders integers and
    // ignores a new field still shows `through_board: 0` with nothing to say
    // that the question was never asked.
    //
    // The two arms are MUTUALLY EXCLUSIVE by construction — `through_note` is
    // `None` unless the limb ran and found something, `why_not` is `None`
    // exactly when it ran — so at most one of them reaches `notes` and neither
    // can contradict the other. The strike arm goes first for the same reason
    // the position limb's does: a reader who stops after one line must get the
    // one that names a cutter under the board.
    let board_depth_note = {
        let board = built
            .job
            .machine
            .spoilboard
            .as_ref()
            .map(|b| b.name.clone())
            .unwrap_or_else(|| "(none declared)".to_string());
        checked.board_depth.through_note(&board).or_else(|| {
            checked
                .board_depth
                .why_not()
                .map(|why| format!("THROUGH-THE-BOARD NOT CHECKED ON THIS JOB — {why}."))
        })
    };

    // 🔴 THE SENTENCE, not just the flag. A host that renders three integers and
    // ignores a new boolean still shows a green `0`; this rides in `notes`, which
    // the CLI prints on every import and the browser shows in its own panel. Both
    // halves exist because either alone can be missed — the flag by a human, the
    // note by a gate.
    let uncut_pending_note = counts.uncut_pending_reason.as_ref().map(|why| {
        format!(
            "UNCUT IS NOT MEASURED ON THIS JOB — the `uncut` count of {} is PENDING, not a clean \
             result: {why}. Read it as \"nobody asked\", never as \"nothing was left standing\". \
             This says nothing either way about the gouge and spoilboard counts, which are \
             separate limbs with their own coverage",
            counts.uncut
        )
    });

    // Render geometry.
    //
    // 🔴 A move is coloured as a TAB only if it is a local excursion above final
    // depth and back — the same rule `count_tabs` uses. Colouring by "above the
    // deepest Z" instead marks every intermediate depth pass as a tab, and on a
    // 5-pass through-profile that is four fifths of the program: the viewport
    // came out almost entirely tab-yellow with 10 actual tabs in it. It is the
    // same conflation the tab METRIC had, and fixing one did not fix the other,
    // because they were two copies of the same idea.
    let deepest = r.path.min_z;
    let tab_idx: std::collections::HashSet<usize> = {
        let mut set = std::collections::HashSet::new();
        // Index cutting moves within the full move list so the marks can be
        // applied while walking it again below.
        let cutting: Vec<(usize, f64)> = r
            .path
            .moves
            .iter()
            .enumerate()
            .filter(|(_, m)| {
                matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW)
            })
            .map(|(i, m)| (i, m.to.z))
            .collect();
        let at = |z: f64| (z - deepest).abs() < 1e-6;
        let up = |z: f64| z > deepest + 0.5 && z < -1e-6;
        let mut i = 0usize;
        while i < cutting.len() {
            if at(cutting[i].1) {
                let mut j = i + 1;
                while j < cutting.len() && up(cutting[j].1) {
                    j += 1;
                }
                if j > i + 1 && j < cutting.len() && at(cutting[j].1) {
                    for k in (i + 1)..j {
                        set.insert(cutting[k].0);
                    }
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
        set
    };
    let mut render: Vec<RenderMove> = Vec::new();
    let mut cur = (0.0, 0.0);
    for (mi, m) in r.path.moves.iter().enumerate() {
        match m.kind {
            MoveKind::Rapid => {
                // No feed, deliberately: a G0 carries no F word. The rate is the
                // machine's, and it travels once on the report rather than being
                // copied onto every rapid as if the program had stated it.
                render.push(RenderMove::at("rapid", m.to.x, m.to.y, m.to.z));
                cur = (m.to.x, m.to.y);
            }
            MoveKind::Feed => {
                let kind = if tab_idx.contains(&mi) { "tab" } else { "cut" };
                render.push(RenderMove::at(kind, m.to.x, m.to.y, m.to.z).fed(m.feed));
                cur = (m.to.x, m.to.y);
            }
            MoveKind::ArcCW | MoveKind::ArcCCW => {
                let kind = if tab_idx.contains(&mi) { "tab" } else { "cut" };
                flatten_arc(cur, m, &mut render, kind);
                cur = (m.to.x, m.to.y);
            }
            MoveKind::DrillCycle => {
                let mut rm =
                    RenderMove::at("drill", m.to.x, m.to.y, m.to.z).fed(m.feed);
                // `value` on a drill is the PECK increment. A non-pecking cycle
                // has none, and that stays absent rather than being written as
                // 0 — "goes straight to depth" and "pecks by nothing" are
                // different sentences and only the first is true.
                if m.value.is_finite() && m.value > 0.0 {
                    rm.peck_mm = Some(m.value);
                }
                render.push(rm);
                cur = (m.to.x, m.to.y);
            }
            MoveKind::ToolChange => {
                let mut rm =
                    RenderMove::at("change", cur.0, cur.1, built.job.machine.safe_z_mm);
                // The tool the operator is being asked to fit. It is on the
                // plan's move; before this it stopped here, and the panel could
                // say a change happened without saying to what.
                if !m.text.is_empty() {
                    rm.text = Some(m.text.clone());
                }
                render.push(rm);
            }
            MoveKind::Probe => render.push(RenderMove::at(
                "probe",
                cur.0,
                cur.1,
                built.job.machine.safe_z_mm,
            )),
            _ => {}
        }
    }

    // Posted through the TRAIT, selected by the job's technology. Calling the
    // grblHAL function directly here would work today and would be the line
    // that has to change when a second process arrives — which is exactly what
    // the seam exists to avoid.
    let post = if r.is_runnable() {
        match crate::post::for_technology(built.job.technology) {
            Some(p) => p.write(
                &r.path,
                &built.job.machine,
                &built.job.stock,
                &OperationParams::default(),
                &crate::post_grblhal::PostOptions {
                    program_name: name.to_string(),
                    ..Default::default()
                },
            ),
            None => crate::post_grblhal::PostResult {
                errors: vec![format!(
                    "no post-processor for {}",
                    built.job.technology.as_str()
                )],
                ..Default::default()
            },
        }
    } else {
        // 🔴 A refused job produces NO G-code, not "G-code with a warning".
        // Emitting it anyway is how a rejected program reaches a spindle.
        crate::post_grblhal::PostResult::default()
    };

    Report {
        job: name.to_string(),
        ok: r.is_runnable() && post.ok(),
        gcode: if r.is_runnable() { post.gcode.clone() } else { String::new() },
        // From the SAME string the field above carries, so the two can never
        // describe different programs.
        cutting_feeds_mm_min: crate::feeds::cutting_feeds_in_program(
            if r.is_runnable() { &post.gcode } else { "" },
        ),
        refusals: r.refusals.iter().map(|x| format!("{}: {}", x.what, x.why)).collect(),
        // 🔴 The precision of the simulation rides with the report, ALWAYS.
        //
        // `sim.gouge/uncut/spoilboard` are CELL COUNTS at a resolution the caller
        // chose, with a DIFFERENT error direction for each of them, and three bare
        // integers read as a measurement. These sentences are built in the core
        // rather than in a panel so the CLI, the browser and any future host all
        // say the same thing — a caveat added in one renderer is silently absent
        // from every other consumer.
        notes: built
            .notes
            .iter()
            .cloned()
            .chain(r.notes.iter().cloned())
            // Immediately before the precision caveats, which are the other
            // sentences qualifying these same three integers.
            .chain(uncut_pending_note)
            // 🔴 The strike note goes FIRST of the spoilboard pair. It is the
            // only sentence in this report that names a cutter descending into
            // the machine, and a reader who stops after one line must get that
            // one. The declaration faults follow it, then the UNCHECKED note —
            // which by construction cannot coexist with the strike.
            .chain(spoilboard_strike_note)
            .chain(spoilboard_declaration_notes)
            .chain(spoilboard_pending_note)
            // The DEPTH limb's sentence, immediately after the POSITION limb's,
            // because they are the two halves of one panel and an operator
            // reading about the board wants both in one place. It is a separate
            // sentence and never folded into the one above: "there is no board
            // under this XY" and "the board is under here and the cutter went
            // past it" are different hazards with different fixes.
            .chain(board_depth_note)
            .chain(
                crate::sim::Precision::new(
                    hm.cell_mm,
                    surface.as_ref().map(|s| s.cell_mm),
                    smallest_tool_r,
                )
                .notes(),
            )
            .collect(),
        fixture_findings: r.fixture_findings.iter().map(|f| format!("{f:?}")).collect(),
        warnings: post.warnings.clone(),
        errors: post.errors.clone(),
        tools_used: r.summary.tools_used.clone(),
        tool_changes: r.summary.tool_changes,
        cutting_distance_mm: r.summary.cutting_distance_mm,
        rapid_distance_mm: r.summary.rapid_distance_mm,
        estimated_seconds: r.summary.estimated_seconds,
        deepest_z_mm: r.summary.deepest_z_mm,
        tab_lifts: count_tabs(&r.path),
        // 🔴 Counted from the EMITTED MOVES, not from `built.dogbones`. The
        // planned count was displayed while the program contained no relief at
        // all; a number describing the intention is not a check on the output.
        dogbones: r
            .path
            .moves
            .iter()
            .filter(|m| m.kind == MoveKind::DrillCycle && m.text == "relief")
            .count(),
        sim: counts,
        offered_fixes: r.offered_fixes.clone(),
        // The height map is thrown away unless someone asked for it. Encoding it
        // "just in case" would put megabytes through every re-plan for the
        // overwhelmingly common case of a caller that only reads the counts.
        simulated_stock_surface: surface,
        // A BUILT job has no loaded file behind it — a reference fixture is
        // constructed from code, and a drawing is contours. Only the mesh import
        // path has a solid to carry, and it attaches it to the report it gets
        // back from here rather than this function inventing one.
        loaded_mesh: None,
        render,
        // A BUILT fixture has no drawing behind it — it is constructed from
        // code. The import path attaches its own contours to the report it gets
        // back from here, for the same reason it attaches the loaded mesh:
        // nothing about the PROGRAM may depend on what the viewport wanted.
        drawing: Vec::new(),
        rapid_mm_min: Some(built.job.machine.rapid_mm_min),
        // 🔴 FROM THE BASIS, NOT FROM THE MACHINE. `built.job.machine
        // .tool_change_seconds` is an `Option` whose absence has to be resolved
        // against `job::DEFAULT_TOOL_CHANGE_SECONDS`; doing that here would put
        // a SECOND copy of the fallback in the tree, which is the very defect
        // this pair of fields exists to delete from `App.tsx`. `basis` holds
        // what `summarize_program` actually charged, and `..._declared` records
        // which of the two ways it got there.
        tool_change_seconds: Some(r.summary.basis.tool_change_seconds),
        tool_change_rate_declared: r.summary.basis.tool_change_rate_declared,
        stock: [
            built.job.stock.size_x_mm,
            built.job.stock.size_y_mm,
            built.job.stock.thickness_mm,
        ],
        travel: {
            let t = built.job.machine.travel_envelope();
            [t.size_x_mm, t.size_y_mm, t.size_z_mm]
        },
        // 🔴 THE SEAM THE VIEWPORT READS, exactly as `clamps` is. A board that
        // reached the check but not this echo would be drawn as absent while
        // being enforced, or — worse in this direction — a board that reached
        // neither would leave the host free to draw the travel envelope as the
        // material, which is what it did.
        spoilboard: built.job.machine.spoilboard.as_ref().map(|b| SpoilboardCfg {
            // The echo is EXPLICIT geometry, never the catalogue id it may have
            // come from: what is installed is a rectangle, and a host redrawing
            // it must not have to resolve a catalogue to find out where it is.
            catalogue_id: None,
            name: Some(b.name.clone()),
            x_mm: Some(b.x_mm),
            y_mm: Some(b.y_mm),
            size_x_mm: Some(b.size_x_mm),
            size_y_mm: Some(b.size_y_mm),
            // 🔴 THE SLAB TRAVELS WITH THE RECTANGLE, and `None` stays `None`.
            // The browser has to paint a board whose thickness nobody declared;
            // if this echoed a plausible depth the picture would assert a
            // measurement nobody made, and if it echoed nothing the viewport
            // would have to invent one to draw anything at all. Absent here is
            // the instruction to draw it as UNKNOWN — the same three-way fact
            // `Spoilboard::thickness_mm` carries, crossing the seam unflattened.
            thickness_mm: b.thickness_mm,
        }),
        spoilboard_bare_reach: built.job.machine.spoilboard.as_ref().map(|b| {
            let r = b.bare_reach(&built.job.machine);
            [r.minus_x_mm, r.plus_x_mm, r.minus_y_mm, r.plus_y_mm]
        }),
        clamps: built
            .job
            .fixturing
            .clamps
            .iter()
            .map(|c| ClampCfg {
                name: c.name.clone(),
                x: c.x,
                y: c.y,
                w: c.w,
                h: c.h,
                height_mm: c.height_mm,
                // 🔴 THE SEAM THE VIEWPORT READS. The browser draws clamps from
                // this echo, not from the config it posted, so an omitted
                // rotation here draws a square clamp over a turned keepout —
                // the picture and the check disagreeing on the web side, which
                // is the same defect P7R guards in the geometry.
                rotation_deg: c.rotation_deg,
            })
            .collect(),
        // Read out of the SAME `Job` the program was planned from, and measured
        // out of `Job::place` rather than rebuilt from the stock's fields — see
        // `Job::placement`. A host that draws the drawing under this lands on
        // the toolpath; one that rebuilds it from `stock` is one copy of a
        // placement rule away from a picture the program disagrees with.
        drawing_placement: built.job.placement(),
    }
}

/// The tool library, as the UI needs it: category, id, and the numbers that
/// decide whether a tool may be used for an operation.

/// Simulate a planned job and check it, in the coordinates the PROGRAM uses.
///
/// 🔴 ONE implementation, deliberately. This existed twice — once here and once
/// in the CLI — and the copies drifted into the same defect twice over: the
/// toolpath is PLACED by `plan_job` through `Stock::place()`, while the
/// verification regions stayed workpiece-local and the height map stayed nailed to
/// the machine origin. At any datum but zero the check compared a placed path
/// against unplaced regions.
///
/// Measured on `plate` before the fix: **0 gouges at datum 0, 1027 at datum 150,
/// 0 again at datum 300** — the last being a green that compared nothing,
/// because path and regions had stopped overlapping at all. Every gate passed
/// throughout, because every fixture defaults to datum 0.
///
/// ⚠ A second copy of a safety check is not redundancy. It is a second place for
/// the check to be wrong, and the copy nobody is looking at is the one that
/// stays wrong.
/// ⚠ **THE NARROW DOOR: this drops the coverage and therefore cannot tell a
/// measured `uncut = 0` from an unasked one** (audit finding B4).
///
/// It exists because `cli/src/main.rs` binds this two-tuple and that file was
/// outside the change that added [`crate::sim::UncutCoverage`]. Anything that
/// REPORTS a number to a person must go through
/// [`simulate_and_check_with_coverage`] instead; this one is for a caller that
/// only wants the height map or the finding list itself.
///
/// 🔴 It is a delegation, not a second copy. The one implementation is below.
pub fn simulate_and_check(
    built: &BuiltJob,
    path: &crate::types::Toolpath,
    sim_cell_mm: f64,
) -> (crate::sim::HeightMap, Vec<crate::sim::SimFinding>) {
    let (hm, checked) = simulate_and_check_with_coverage(built, path, sim_cell_mm);
    (hm, checked.findings)
}

/// [`simulate_and_check`], keeping the answer to *"did the `Uncut` check run at
/// all?"* — see [`crate::sim::SimCheck`].
pub fn simulate_and_check_with_coverage(
    built: &BuiltJob,
    path: &crate::types::Toolpath,
    sim_cell_mm: f64,
) -> (crate::sim::HeightMap, crate::sim::SimCheck) {
    let stock = &built.job.stock;
    // 🔴 `bed-anchored-sim` is the NEGATIVE CONTROL for gate DINV and is the
    // only branch in this function. It restores the exact pre-fix harness —
    // workpiece-local regions against a map pinned to the machine origin — so the invariance
    // gate can be watched catching the defect that once shipped green. It
    // changes nothing about the motion: the emitted program is byte-identical.
    let planted = built.plant == JobPlant::BedAnchoredSim;
    // 🔴 `Job::place`, the SAME transform `plan_job` puts the toolpath through —
    // not `Stock::place`, which leaves out where the operator dragged the part.
    // The two diverging is the defect this function's header records, one term
    // later: a placed path checked against regions that stayed behind reports
    // gouges that are not there and, once they stop overlapping entirely,
    // reports none at all.
    let place_contour = |c: &crate::geometry::Contour| {
        let mut out = c.clone();
        if planted {
            return out;
        }
        for v in &mut out.verts {
            let (x, y) = built.job.place(v.x, v.y);
            v.x = x;
            v.y = y;
        }
        out
    };
    let keep: Vec<crate::geometry::Contour> = built.keep.iter().map(place_contour).collect();
    let remove: Vec<crate::geometry::Contour> = built.remove.iter().map(place_contour).collect();

    // The map covers where the workpiece actually SITS — AND where the toolpath
    // actually GOES. Before 2026-08-20 the map was stock-only, so a part dragged
    // past the sheet edge produced cuts the sim never visited: `stamp` clamped
    // them off the map and `check` returned the same zeros a correct job has.
    // Now the map is the UNION of the stock footprint and the toolpath bounding
    // box (expanded by tool_r). Cells outside the stock have zero initial height
    // (no material), so any cut there trips the spoilboard check normally.
    //
    // Both opposite corners are placed and the minimum taken, because a quarter
    // turn moves which corner is lowest.
    let (ax, ay) = stock.place(0.0, 0.0);
    let (bx, by) = stock.place(stock.size_x_mm, stock.size_y_mm);
    let (fx, fy) = stock.footprint();
    let tool_r = path.tool.radius_mm().max(0.1);
    let (ox, oy, mx, my) = if planted {
        (0.0, 0.0, stock.size_x_mm, stock.size_y_mm)
    } else {
        let stock_ox = ax.min(bx);
        let stock_oy = ay.min(by);
        let stock_far_x = stock_ox + fx;
        let stock_far_y = stock_oy + fy;
        // Union with the toolpath bounding box, expanded by tool radius.
        let path_ox = path.min_x - tool_r;
        let path_oy = path.min_y - tool_r;
        let path_far_x = path.max_x + tool_r;
        let path_far_y = path.max_y + tool_r;
        let uox = stock_ox.min(path_ox);
        let uoy = stock_oy.min(path_oy);
        let ufar_x = stock_far_x.max(path_far_x);
        let ufar_y = stock_far_y.max(path_far_y);
        (uox, uoy, ufar_x - uox, ufar_y - uoy)
    };
    let hm = crate::sim::simulate(path, tool_r, mx, my, sim_cell_mm, ox, oy);
    // 🔴 The board is passed THROUGH, never defaulted. `None` here is the
    // machine saying nobody declared a spoilboard, and `sim::check` reports that
    // as UNCHECKED rather than assuming a board covering the travel envelope —
    // which is the assumption that made a cutter in the frame indistinguishable
    // from a sacrificial through-cut.
    //
    // ⚠ Under the `bed-anchored-sim` PLANT the map is deliberately pinned to
    // workpiece-local coordinates while the board is declared in machine ones, so
    // the two frames disagree. That is the plant working: it restores the
    // pre-fix harness, whose whole defect is a frame mismatch. Every reference
    // fixture declares no board, so no gate's numbers move either way.
    let checked = crate::sim::check(
        &hm,
        &keep,
        &remove,
        built.remove_depth_mm,
        stock.thickness_mm,
        crate::post_grblhal::SPOILBOARD_ALLOWANCE_MM,
        built.job.machine.spoilboard.as_ref(),
    );
    (hm, checked)
}

pub fn tool_library_json() -> String {
    tool_library_json_for(0.0, &[])
}

/// The tool library, each tool carrying whether THIS machine can hold it.
///
/// 🔴 The fit answer is computed HERE, in the core, and shipped with the
/// library. The alternative is for each host to re-derive "does this shank fit"
/// from the collet numbers, which is how the travel-fit rule ended up written a
/// second time in TypeScript and wrong in a way no gate could see.
pub fn tool_library_json_for(collet_mm: f64, spares_mm: &[f64]) -> String {
    let lib = default_library();
    let items: Vec<serde_json::Value> = lib
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "category": t.category().as_str(),
                "diameter_mm": t.tool.diameter_mm,
                "flutes": t.tool.flutes,
                // 🔴 Which way the flutes spiral, which decides WHICH FACE TEARS
                // OUT on a workpiece good: an up-cut lifts the chip and splinters
                // the top face, a down-cut presses down and splinters the
                // bottom, and a compression cutter exists to keep both clean.
                // The core has held this on every end mill in the library since the
                // library was written and did not ship it, so every tool in the
                // UI read as "direction not stated".
                //
                // Spelled like the `fit` verdict two fields down —
                // lowercase, hyphenated — because that is the neighbouring
                // convention in THIS object. The enum is the source; this match
                // is the only place it becomes a string, so there is no second
                // spelling to drift.
                "flute_type": match t.tool.flute_type {
                    Flute::Straight => "straight",
                    Flute::UpCut => "up-cut",
                    Flute::DownCut => "down-cut",
                    Flute::Compression => "compression",
                },
                "shank_mm": t.tool.shank_mm,
                "cutting_length_mm": t.tool.cutting_length_mm,
                "chipload_mm": t.tool.chipload_mm,
                "chipload_min_mm": t.tool.chipload_min_mm,
                "chipload_max_mm": t.tool.chipload_max_mm,
                "rpm_min": t.tool.rpm_min,
                "rpm_max": t.tool.rpm_max,
                "included_angle_deg": t.included_angle_deg,
                "point_angle_deg": t.point_angle_deg,
                "can_profile": t.category().can_profile(),
                "can_pocket": t.category().can_pocket(),
                "can_drill": t.category().can_drill(),
                "is_angular": t.category().is_angular(),
                "valid": t.is_valid(),
                // Selectable is NOT "verified": an undeclared collet is
                // selectable and says so, because refusing every tool over a
                // machine setting punishes the user for the wrong thing.
                "fit": match crate::tools::shank_fit(t.tool.shank_mm, collet_mm, spares_mm) {
                    crate::tools::ShankFit::Fitted => "fitted",
                    crate::tools::ShankFit::NeedsCollet { .. } => "needs-collet",
                    crate::tools::ShankFit::None { .. } => "none",
                    crate::tools::ShankFit::Undeclared => "undeclared",
                },
                "fit_why": crate::tools::shank_fit(t.tool.shank_mm, collet_mm, spares_mm).why(),
                "selectable": crate::tools::shank_fit(t.tool.shank_mm, collet_mm, spares_mm)
                    .selectable(),
            })
        })
        .collect();
    serde_json::json!({
        "categories": ToolCategory::all().iter().map(|c| c.as_str()).collect::<Vec<_>>(),
        "materials": crate::tools::Material::all()
            .iter()
            .map(|m| serde_json::json!({
                "name": m.as_str(),
                "chipload_factor": m.chipload_factor(),
                "max_doc_ratio": m.max_doc_ratio(crate::types::MachineClass::default()),
                "max_rpm": m.max_rpm(),
            }))
            .collect::<Vec<_>>(),
        "tools": items,
    })
    .to_string()
}

// ===========================================================================
//  Imported geometry — the path a real drawing takes.
// ===========================================================================

/// Chaining tolerance for every intake path, in one place. Two copies of a
/// tolerance is two sets of tolerance bugs, and only one of them gets fixed.
const IMPORT_TOL_MM: f64 = 0.02;

// ---------------------------------------------------------------------------
//  N DRAWINGS ON ONE WORKPIECE
// ---------------------------------------------------------------------------
//
// Founder, 2026-08-10: *"In the drawings I should able to add more than 1
// drawings, I should able to rotate the drawings"*.
//
// 🔴 THERE IS ONE PLAN PATH AND EVERY IMPORT GOES THROUGH IT. The single-drawing
// entry points below are one-element calls of [`plan_report_import_many`], not a
// second implementation kept alongside it. Two placement paths is how the
// picture and the program start disagreeing: one of them gets a fix and the
// other does not, and the difference is a part cut somewhere nobody looked.
//
// 🔴 THE OVERLAP REFUSAL COMES BEFORE EVERYTHING. Two parts on the same material
// is not a layout inconvenience — cutting the first destroys the second's edge
// and leaves it loose under a 2.2 kW spindle while the program is still running.
// So the check runs BEFORE a single operation is generated, and a condemned
// workpiece returns with `gcode` EMPTY. That is G13's shape: a rejected program that
// still prints G-code gets run anyway.
//
// 🔴 NOTHING HERE MOVES A PART TO RESOLVE ANYTHING. Not by a millimetre, not to
// clear a clamp, not to open a channel the cutter would fit down. The clamps are
// bolted to the machine and do not travel with the parts, so a part relocated to
// fix an interference is a part relocated into whatever is holding the work
// down. `fit` reports a datum shift and refuses to apply one; `layout` grades a
// placement a human chose; this refuses and names both parts.

/// One drawing the operator has put on the workpiece, with where they put it.
///
/// 🔴 `offset_mm` is the PER-DRAWING generalisation of
/// [`crate::job::Job::drawing_offset_x_mm`], and it is deliberately the SAME
/// QUANTITY IN THE SAME FRAME: a delta in **workpiece millimetres**, applied to the
/// geometry before the workpiece is laid on the machine. Drag a part 50mm along the
/// workpiece, turn it a quarter turn, and the part is still 50mm along the
/// workpiece — which is where it physically is. An offset measured in machine axes
/// would slide the part across the material it is cut from the moment the workpiece
/// turned. The job-level offset still exists and still composes on top; it moves
/// EVERY drawing, which is what it always meant.
///
/// 🔴 It is a DELTA and not an absolute corner position, and that is the one
/// place this type differs from [`crate::layout::PlacedDrawing`], which it is
/// built on. `PlacedDrawing::at` takes the absolute workpiece position of the
/// drawing's lower-left corner — the right shape for `layout`, which grades a
/// placement somebody already chose and therefore already knows. A delta is the
/// right shape here because **zero has to mean AS DRAWN**: defaulting an import
/// to the workpiece corner would move every existing job's geometry on the day this
/// landed, silently, and the program would still look entirely right.
pub struct ImportSource<'a> {
    /// Names this drawing's parts and its operations — `id/part`. Two drawings
    /// may not share one: `remove` could not tell them apart, and a refusal
    /// could not say which drawing it condemned.
    pub id: String,
    pub data: &'a [u8],
    /// `"dxf" | "svg" | "stl" | "auto"`. `"auto"` decides by CONTENT.
    pub format: String,
    /// The section Z for a mesh. `None` = nobody chose one; the core sections at
    /// mid-height and SAYS SO. It never silently becomes 0.
    pub z_section_mm: Option<f64>,
    pub offset_mm: [f64; 2],
    /// Degrees anticlockwise about this drawing's own lower-left corner, the
    /// corner then staying put. Exactly [`Stock::rotation_deg`]'s convention and
    /// exactly `Clamp::rotation_deg`'s — because it is computed by that code and
    /// not by arithmetic written again here.
    pub rotation_deg: f64,
}

impl<'a> ImportSource<'a> {
    /// A drawing left exactly where it was drawn. The one-drawing shorthand's
    /// placement, and the value every field defaults to.
    pub fn as_drawn(id: impl Into<String>, data: &'a [u8], format: &str) -> Self {
        Self {
            id: id.into(),
            data,
            format: format.to_string(),
            z_section_mm: None,
            offset_mm: [0.0, 0.0],
            rotation_deg: 0.0,
        }
    }

    /// True when this drawing is where it was drawn, unturned.
    ///
    /// EXACT equality, no tolerance — the same rule and the same reason as
    /// [`crate::job::Placement2D::is_identity`]. It decides whether the geometry
    /// is passed through untouched or run through the placement arithmetic, and
    /// `(v - o) + o` is NOT exactly `v` in binary floating point. A tolerance
    /// here would silently re-round every coordinate of an unmoved drawing.
    fn is_as_drawn(&self) -> bool {
        self.offset_mm == [0.0, 0.0] && self.rotation_deg == 0.0
    }
}

/// The id the one-drawing entry points give their single drawing.
///
/// 🔴 Operation names are QUALIFIED even when there is one drawing, and that is
/// deliberate rather than an oversight worth optimising away. `Layout::remove`'s
/// safety property is that removing one drawing cannot rename another's
/// operations; a scheme that dropped the qualifier while a drawing was alone
/// would rename every one of its operations the moment a second drawing arrived
/// — the exact renumbering that property forbids, arriving through the naming
/// instead of through the ordering.
pub const LONE_DRAWING_ID: &str = "drawing";

/// What came out of the door for ONE drawing, before anything is placed.
struct Intake {
    parts: Vec<Part>,
    /// `unit_note` first and never conditional, then the section note, then
    /// every entity the parser could not read. The order is the one the single
    /// path has always emitted.
    notes: Vec<String>,
    /// The solid, kept whole. The caller decides whether to place it, sample it
    /// to a display budget, or decline it — `section` only ever produced 2D.
    mesh: Option<crate::mesh::Mesh>,
    section_z: Option<f64>,
    /// Set when nothing cuttable came out. The job is REFUSED with this; it is
    /// never an empty parts list travelling on as though it were geometry.
    error: Option<String>,
    /// `"stl"` when the content is a mesh, whatever was asked for otherwise.
    label: String,
}

/// Read one drawing. **The only intake in this crate that a job is built from.**
///
/// Split out of the single-drawing planner it used to live inside, so that N
/// drawings cannot be read by different code than one drawing is. Everything
/// here was already written; nothing about how a file is read has changed.
fn intake_one(data: &[u8], format: &str, z_section_mm: Option<f64>, stock: &Stock) -> Intake {
    // Is this a mesh? By CONTENT first — a file named `part.dxf` that is really
    // an STL must still reach the section path — and by an explicit `stl`
    // request second, so a file DECLARED a mesh and unreadable as one is refused
    // as a broken mesh rather than parsed as an empty drawing, which reads
    // downstream exactly like a valid drawing with no features.
    let is_mesh = format.eq_ignore_ascii_case("stl") || crate::mesh::looks_like_stl(data);
    // 🔴 TODO #48: the label is the DETECTED format, not the requested one.
    // On the `auto` route the request is "decide by content", and the label
    // must say what WAS found, not what was asked for.
    let label = if is_mesh {
        "stl".to_string()
    } else if format.eq_ignore_ascii_case("auto") {
        match std::str::from_utf8(data) {
            Ok(text) if text.contains("<svg") => "svg".to_string(),
            Ok(_) => "dxf".to_string(),
            Err(_) => "binary".to_string(),
        }
    } else {
        format.to_string()
    };

    let mut notes: Vec<String> = Vec::new();
    let mut section_z: Option<f64> = None;
    let mut mesh: Option<crate::mesh::Mesh> = None;
    let mut z_note: Option<String> = None;

    let imported = if is_mesh {
        match crate::mesh::parse_stl(data) {
            Some(m) => {
                let z = match z_section_mm {
                    Some(z) => z,
                    None => match m.z_span() {
                        Some((lo, hi)) => {
                            let z = (lo + hi) * 0.5;
                            z_note = Some(format!(
                                "no section Z was given — this mesh was sectioned at its MID-HEIGHT, \
                                 z = {z:.3}mm, of a solid spanning z = {lo:.3}..{hi:.3}mm. That Z was \
                                 CHOSEN FOR YOU: a different Z gives a different outline, and this one \
                                 is a guess about your intent, not a reading of your model"
                            ));
                            z
                        }
                        None => {
                            // No extent to take a middle of. Say that rather
                            // than let 0.000 read as a considered answer.
                            z_note = Some(
                                "no section Z was given and the mesh has no measurable extent — \
                                 z = 0.000mm was used"
                                    .into(),
                            );
                            0.0
                        }
                    },
                };
                section_z = Some(z);
                let sectioned = crate::mesh::section(&m, z, IMPORT_TOL_MM);
                mesh = Some(m);
                sectioned
            }
            None => {
                // Declared a mesh and unreadable as one. `parse_stl_section`
                // owns that refusal by name; the Z is echoed back exactly as
                // asked so the message cannot imply one was chosen.
                let z = z_section_mm.unwrap_or(0.0);
                section_z = Some(z);
                crate::mesh::parse_stl_section(data, z, IMPORT_TOL_MM)
            }
        }
    } else {
        match format {
            // Content-decided. The mesh branch above already claimed anything
            // that looks like an STL, so the Z passed here is unreachable — it
            // is written as 0.0 rather than plumbed, because a value that can
            // never be read must not look like a default anyone relies on.
            "auto" => crate::import::parse_bytes(data, stock.size_y_mm, 0.0, IMPORT_TOL_MM),
            "dxf" | "svg" | "obj" | "step" => {
                let Ok(text) = std::str::from_utf8(data) else {
                    return Intake {
                        parts: Vec::new(),
                        notes,
                        mesh: None,
                        section_z: None,
                        error: Some(format!(
                            "the file was imported as '{format}', which is a text format, but it is \
                             not valid UTF-8 — it was NOT imported. A binary STL belongs on the \
                             mesh path"
                        )),
                        label,
                    };
                };
                match format {
                    "svg" => crate::import::parse_svg(text, stock.size_y_mm, IMPORT_TOL_MM),
                    "obj" => {
                        let mesh = crate::mesh::parse_obj(text);
                        let z = z_section_mm.unwrap_or_else(|| {
                            mesh.z_span().map(|(lo, hi)| (lo + hi) * 0.5).unwrap_or(0.0)
                        });
                        section_z = Some(z);
                        crate::mesh::section(&mesh, z, IMPORT_TOL_MM)
                    }
                    // Refused, not read — the same refusal the browser and the
                    // CLI give, from the same constant. See `mesh::refuse_step`.
                    "step" => crate::mesh::refuse_step(),
                    _ => crate::import::parse_dxf(text, IMPORT_TOL_MM),
                }
            }
            "3mf" => {
                let mesh = crate::mesh::parse_3mf(data);
                let z = z_section_mm.unwrap_or_else(|| {
                    mesh.z_span().map(|(lo, hi)| (lo + hi) * 0.5).unwrap_or(0.0)
                });
                section_z = Some(z);
                crate::mesh::section(&mesh, z, IMPORT_TOL_MM)
            }
            other => {
                return Intake {
                    parts: Vec::new(),
                    notes,
                    mesh: None,
                    section_z: None,
                    error: Some(format!(
                        "unknown format '{other}' — expected dxf, svg, stl, obj, 3mf, step or auto"
                    )),
                    label,
                }
            }
        }
    };

    let parts = crate::import::to_parts(&imported, "part");

    // 🔴 `unit_note` is FIRST and is never conditional. For a mesh it is the
    // sentence that says the operator is looking at ONE FLAT SLICE of a 3D
    // model and at which Z — the whole safety property of mesh import. A user
    // who believes they got 3D machining and got a section cuts a
    // plausible-looking wrong part, and nothing downstream can notice, because
    // every contour handed to it is a real contour of a real solid.
    notes.push(imported.unit_note.clone());
    notes.extend(z_note.clone());
    notes.extend(imported.unsupported.iter().cloned());

    if parts.is_empty() {
        // 🔴 A mesh gets its OWN reason. "Check for open contours" is true of a
        // drawing and misleading about a solid: the usual cause here is a
        // section plane that missed the part, and sending the operator to look
        // for open contours sends them to look at the wrong thing entirely.
        if imported.open_contours > 0 {
            notes.push(format!("{} contour(s) did not close", imported.open_contours));
        }
        return Intake {
            parts,
            notes,
            mesh,
            section_z,
            error: Some(match section_z {
                Some(z) => format!(
                    "the STL SECTION at z = {z:.3}mm produced no closed outline that could be cut \
                     — see the notes: either the plane crossed no geometry, or the mesh is open at \
                     that Z"
                ),
                None => "the drawing produced no closed outline that could be cut — check for \
                         open contours"
                    .into(),
            }),
            label,
        };
    }

    if imported.open_contours > 0 {
        notes.push(format!(
            "{} contour(s) did not close and were NOT cut — an unclosed outline cannot be \
             profiled, and closing it here would invent an edge the drawing never had",
            imported.open_contours
        ));
    }
    // The HOLE COUNT is reported, not just the part count. "1 part imported"
    // is equally true of a plate with four holes and of the same plate with
    // every hole silently dropped — which is the failure this whole module is
    // arranged against.
    let holes: usize = parts.iter().map(|p| p.inners.len()).sum();
    notes.push(format!("{} part(s) imported with {holes} interior feature(s)", parts.len()));

    Intake { parts, notes, mesh, section_z, error: None, label }
}

/// What a refused report may HONESTLY draw.
///
/// 🔴 It is an argument of [`refused_import_report`] and not a field assigned
/// afterwards, because the defect this type exists to close was an omission:
/// every refusal path simply *returned before the geometry was attached*, and an
/// omission leaves nothing on the screen to notice. Making it a parameter means
/// a new refusal path cannot compile without answering the question, and the
/// answer is one of exactly two facts — never a silent third.
enum RefusedGeometry<'a> {
    /// The parts were read AND PLACED before the refusal — the same list the
    /// operations would have been built from, in the same coordinates. Drawn.
    Placed(&'a [Part]),
    /// No placed geometry exists at this point in the pipeline. `why` names the
    /// missing fact and goes into the report's notes: an empty `drawing` on its
    /// own is indistinguishable from an empty workpiece, and inventing geometry that
    /// was never computed is the worse of the two errors by a long way.
    NotBuilt(&'a str),
}

/// A report for an import that produced no program. `gcode` is EMPTY and stays
/// empty on every path that returns one of these.
///
/// # 🔴 A REFUSAL MUST NOT DROP THE FACTS IT ALREADY HOLDS (2026-08-10)
///
/// This function used to return [`crate::job::Placement2D::default()`] — the IDENTITY — on
/// every refusal, so a refused workpiece reported the datum as `0,0` whatever the
/// operator had set. Measured at the CLI:
///
/// ```text
/// import plate.dxf --config '{"stock":{"origin_x_mm":37,"origin_y_mm":11}}'   (no tool)
///   -> ok:false, drawing 0 parts, drawing_placement dx 0, dy 0
/// the same call naming a tool
///   -> drawing_placement dx 37, dy 11
/// ```
///
/// A host draws every drawing-frame object under that transform, so on a
/// refused plan the geometry stood at the MACHINE ORIGIN and stopped following
/// the datum: the panel numbers moved and the object did not. **The picture an
/// operator uses to FIX a refusal is precisely the picture that went wrong** —
/// the worst moment for it, and the state a page sits in for as long as the
/// refusal lasts.
///
/// The refusal itself is correct and is untouched: no tool means no program. So
/// the datum is not a parameter a caller may forget — it is taken from `cfg`
/// HERE, through the one implementation, on every refusal path there is.
fn refused_import_report(
    job: &str,
    cfg: &JobConfig,
    stock: &Stock,
    sim_cell_mm: f64,
    notes: Vec<String>,
    geometry: RefusedGeometry<'_>,
) -> Report {
    // 🔴 THE WHOLE CONFIG IS APPLIED TO A THROWAWAY JOB, and the placement is
    // then MEASURED out of it — rather than the three placement-bearing fields
    // being read off `cfg` again here. Reading them here would be a second
    // implementation of "where the workpiece is", and the day it drifted the refused
    // picture and the planned program would disagree by exactly the amount
    // nobody was looking at. The success path calls `built.job.placement()`
    // after `cfg.apply`; so does this. Its notes are discarded deliberately —
    // this job is never planned, and the real ones are already in `notes`.
    let mut probe = BuiltJob {
        job: Job::new("imported", machine(), stock.clone()),
        dogbones: Vec::new(),
        keep: Vec::new(),
        remove: Vec::new(),
        remove_depth_mm: 0.0,
        notes: Vec::new(),
        plant: JobPlant::None,
    };
    cfg.apply(&mut probe);

    let mut notes = notes;
    let drawing = match geometry {
        RefusedGeometry::Placed(parts) => drawing_of(parts),
        RefusedGeometry::NotBuilt(why) => {
            notes.push(format!(
                "NO WORKPIECE GEOMETRY IS DRAWN on this refusal — {why}. That is an absence, not an \
                 empty workpiece: nothing here invents an outline that was never computed"
            ));
            Vec::new()
        }
    };

    Report {
        job: job.to_string(),
        ok: false,
        gcode: String::new(),
        // No program, so no commanded feed. Empty is the honest answer and it
        // is what a host must render as "not commanded", never as zero.
        cutting_feeds_mm_min: Vec::new(),
        refusals: Vec::new(),
        notes,
        fixture_findings: Vec::new(),
        warnings: Vec::new(),
        errors: Vec::new(),
        tools_used: Vec::new(),
        tool_changes: 0,
        cutting_distance_mm: 0.0,
        rapid_distance_mm: 0.0,
        estimated_seconds: 0.0,
        deepest_z_mm: 0.0,
        tab_lifts: 0,
        dogbones: 0,
        // 🔴 No job was planned, so NOTHING was simulated — and `uncut_checked`
        // says so rather than letting three zeros read as a clean simulation of a
        // program that does not exist.
        sim: SimCounts {
            cell_mm: sim_cell_mm,
            gouge: 0,
            uncut: 0,
            spoilboard: 0,
            first: None,
            uncut_checked: false,
            uncut_cells_tested: 0,
            uncut_pending_reason: Some(
                "this import was REFUSED, so no program was planned and no simulation ran at all \
                 — every count on this report is absent, not measured"
                    .into(),
            ),
            // Same argument, same direction: nothing ran, so the position limb
            // is PENDING. `false` here is the honest answer and it is also what
            // `#[serde(default)]` would land, so the two cannot disagree.
            past_spoilboard_edge: 0,
            spoilboard_position_checked: false,
            spoilboard_pending_reason: Some(
                "this import was REFUSED, so no program was planned and nothing was simulated — \
                 the spoilboard was neither checked nor found clear"
                    .into(),
            ),
            // Same argument a third time, in the one spelling a verdict word
            // allows: nothing ran, so the depth limb is PENDING. `Unknown` is
            // taken from the core's own enum rather than typed as a literal —
            // a hand-written "board-depth-unknown" here would drift silently the
            // day `BoardDepth::as_str` changed, and this is the copy nobody
            // re-reads because it sits on the path where nothing happened.
            board_depth: crate::sim::BoardDepth::Unknown.as_str().to_string(),
            through_board: 0,
            board_depth_pending_reason: Some(
                "this import was REFUSED, so no program was planned and nothing was simulated — \
                 whether a cut would have reached the machine under the board was never asked"
                    .into(),
            ),
        },
        // No job ran, so there is nothing to offer. An EMPTY list is the honest
        // answer: 'no fix' and 'not computed' both render as no buttons, and
        // inventing one here would offer a fix for a refusal never checked.
        offered_fixes: Vec::new(),
        simulated_stock_surface: None,
        loaded_mesh: None,
        render: Vec::new(),
        // The geometry the pipeline had reached when it refused — see
        // [`RefusedGeometry`]. Never re-derived from anything: on the paths that
        // carry it, these are the PLACED parts, the same list the check
        // condemned and the same list the operations would have been built from.
        drawing,
        // 🔴 `None`, not a plausible default. No job ran, so no machine was
        // chosen, and a rapid rate here would be this function's guess dressed
        // as a machine setting.
        rapid_mm_min: None,
        // 🔴 `None` and `false`, beside `rapid_mm_min` and for the same reason.
        // No job was planned, so no estimate was made and nothing was charged —
        // and reading `machine.tool_change_seconds` off the probe here would
        // report a RATE for a job that has no changes to spend it on, which
        // reads as an estimate having been produced. `false` is also what
        // `#[serde(default)]` lands, so the two cannot disagree.
        tool_change_seconds: None,
        tool_change_rate_declared: false,
        // 🔴 THE WORKPIECE THE OPERATOR DECLARED, not a literal `600x900x18`. It is
        // read out of the same probe the placement is measured from, so the
        // rectangle a host draws and the transform it draws the geometry under
        // are one answer. A hard-coded workpiece here is the identity defect wearing
        // different clothes: a fact the report HELD, replaced by a plausible
        // constant, on the one path where nobody checks it against a program.
        stock: [
            probe.job.stock.size_x_mm,
            probe.job.stock.size_y_mm,
            probe.job.stock.thickness_mm,
        ],
        // 🔴 Zeroes, not `Machine::default()`'s travel. No machine was chosen,
        // and echoing a plausible envelope here would let a host draw a
        // machine's reach for a job that never had one — the same argument that
        // makes `rapid_mm_min` `None` three lines up. A host must read `ok:
        // false` first; a zero-sized envelope is at least self-evidently not a
        // measurement, where 600x900 would look like one.
        travel: [0.0, 0.0, 0.0],
        spoilboard: None,
        spoilboard_bare_reach: None,
        clamps: Vec::new(),
        // 🔴 THE DATUM THE OPERATOR SET — measured out of `Job::place` on the
        // probe above, exactly as the planned path measures it out of the job it
        // posted. It is a property of the CONFIG, known before the first drawing
        // is read, so no refusal path is early enough to have an excuse for the
        // identity. See this function's header for what the identity cost.
        drawing_placement: probe.job.placement(),
    }
}

/// The workpiece the intake needs before an SVG can be flipped into machine
/// coordinates. Resolved from the config, exactly as it always was.
fn intake_stock(cfg: &JobConfig) -> Stock {
    let mut stock = Stock::default();
    if let Some(st) = &cfg.stock {
        if let Some(v) = st.size_x_mm {
            stock.size_x_mm = v;
        }
        if let Some(v) = st.size_y_mm {
            stock.size_y_mm = v;
        }
        if let Some(v) = st.thickness_mm {
            stock.thickness_mm = v;
        }
    }
    stock
}

/// 🔴 **The gap margin, and why an absent one is a NOTE and not a default.**
///
/// The overlap half of the check does not read this at all: shared material is
/// shared material. What it sets is the TOO CLOSE half — how much clear material
/// beyond the cutter's own diameter two parts must have between them, for
/// runout, workpiece bow, and the fact that a pass down the exact centre of a
/// diameter-wide channel leaves nothing on either side and no chip clearance.
///
/// Absent means NOT DECLARED. The check still runs, at the cutter diameter
/// alone, which is the bare geometric minimum and cannot be argued with — and
/// every report says on its face that no margin was declared. That is the
/// undeclared-fixture rule applied one field along: "no margin declared" and
/// "margin checked" are different facts, and only the second is safe, so the
/// first is said out loud on every export rather than defaulted into silence.
const NO_GAP_MARGIN_NOTE: &str =
    "no part-gap margin was declared, so the parts on this workpiece were checked against the CUTTER \
     DIAMETER ALONE. That is the bare geometric minimum — it asks only whether the tool fits down \
     the channel, with nothing left for runout, workpiece bow or chip clearance, and a pass down the \
     exact centre of a diameter-wide channel leaves zero material on either side. Declare \
     `part_gap_margin_mm` to check against a gap you have actually chosen.";

/// 🔴 Carried onto every multi-drawing refusal, because the moment somebody
/// decides this check is wrong is the moment they are looking at one overlap.
const OUTER_BOUNDARY_ONLY_NOTE: &str =
    "This check compares OUTER boundary to OUTER boundary. A part deliberately nested inside \
     another part's HOLE is therefore refused as an overlap, even though that material is a \
     drop-out and genuinely available. That is a known FALSE RED — it is not a defect in the check \
     and must not be 'fixed' by relaxing it. The workaround is to draw the nested part as part of \
     the same drawing. Refusing a legal nest costs a re-draw; permitting an illegal one costs a \
     cutter.";

/// Plan ONE job from N drawings the operator has placed on the workpiece.
///
/// 🔴 This is the engine. `plan_report_import*` are one-element calls of it.
///
/// The order of operations is a safety order and is not negotiable:
///
///   1. read every drawing (a drawing that yields nothing cuttable REFUSES the
///      whole job, by name — a workpiece planned from the drawings that happened to
///      parse is a workpiece missing a part nobody was told about);
///   2. place each one — the placement is applied to the GEOMETRY, so the
///      program is planned from the turned outline rather than from an untouched
///      one that a viewport turned for display;
///   3. resolve the tool, or refuse;
///   4. 🔴 **CHECK EVERY PAIR OF PARTS. A finding returns here, with no G-code
///      at all** — not a warning on a runnable program;
///   5. only then build operations and post.
///
/// `mesh_budget_tris` behaves as it does on the single path, with one stated
/// exception: **on a workpiece holding more than one drawing the loaded solid is not
/// carried at all.** [`Report::loaded_mesh`] is one solid, and a viewport showing
/// one solid over a program cutting several sections is a picture that disagrees
/// with the program — which is the failure this whole path is arranged against.
/// A note says so; the SECTION of every drawing is still in `drawing`.
pub fn plan_report_import_many(
    sources: &[ImportSource<'_>],
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
    mesh_budget_tris: Option<usize>,
) -> Report {
    plan_report_import_many_planted(
        sources,
        JobPlant::None,
        cfg,
        sim_cell_mm,
        surface_cell_mm,
        mesh_budget_tris,
    )
}

/// [`plan_report_import_many`] with a NEGATIVE CONTROL applied.
///
/// 🔴 The plant argument exists so gate MULTI can watch the overlap refusal go
/// red on demand, and for nothing else. It is reachable from `nest --plant` and
/// from no config file, no UI control and no wasm export — a hazard a user can
/// switch on is not a control, it is a defect with a checkbox. Every real caller
/// goes through [`plan_report_import_many`], which passes [`JobPlant::None`].
///
/// Only [`JobPlant::OverlapUnchecked`] does anything here. Every other plant is
/// a FIXTURE plant applied by `build`, and this path builds no fixture — so they
/// arrive and are inert, which is exactly what the CLI refuses at the door
/// rather than accepting and discarding.
pub fn plan_report_import_many_planted(
    sources: &[ImportSource<'_>],
    plant: JobPlant,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
    mesh_budget_tris: Option<usize>,
) -> Report {
    let mut r =
        import_many_raw(sources, plant, cfg, sim_cell_mm, surface_cell_mm, mesh_budget_tris);
    // 🔴 The same audit the fixture door runs, on the same terms: a plant that
    // is not in force on THIS run refuses rather than emitting under its own
    // announcement. `overlap-unchecked` is the only plant this path honours and
    // no config key currently reaches it — which is a measurement, not a
    // guarantee, and is exactly why the audit runs here rather than being
    // reasoned about here.
    // ⚠ The target is passed EMPTY here on purpose. A contract's `target` for
    // this host is a FILE PATH (`gates/fixtures/overlap.dxf`) and this function
    // receives byte blobs with caller-chosen ids, so there is nothing here that
    // can honestly be matched against it — and a wrong match would apply another
    // plant's declared effect to this run. The vacuity half of the audit still
    // runs; the declared-effect half is skipped, and this comment is the record
    // that it is skipped rather than passing.
    plant_audit("", plant, cfg, |c, p| {
        Some(import_many_raw(sources, p, c, sim_cell_mm, None, mesh_budget_tris))
    })
    .enforce(&mut r);
    /* 🔴 THE INVERTED PLANT, APPLIED LAST BECAUSE IT REMOVES RATHER THAN ADDS.
     *
     * Every other plant here corrupts geometry and the gate sees the corruption.
     * `ReachBlind` deletes a SENTENCE, because gate `REACH` guards an obligation
     * — that a program which cannot produce part of its outline SAYS SO — and
     * the only way to fail an obligation is to take the saying away.
     *
     * ⚠ It suppresses the note and NOTHING ELSE. The program stays byte-for-byte
     * what it was: ok=true, gouge=0, every coordinate a real coordinate of a real
     * part. That is the point — the planted state is exactly the state the defect
     * produced before `unreachable_feature_note` existed, which is a clean program
     * with a slot missing from the part and nothing anywhere to say it. */
    r
}

/// [`plan_report_import_many_planted`] **without** the negative-control audit —
/// the audit's own instrument, for the same reason [`plan_report_raw`] exists.
fn import_many_raw(
    sources: &[ImportSource<'_>],
    plant: JobPlant,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
    mesh_budget_tris: Option<usize>,
) -> Report {
    let stock = intake_stock(cfg);

    if sources.is_empty() {
        let mut r = refused_import_report(
            "imported",
            cfg,
            &stock,
            sim_cell_mm,
            Vec::new(),
            RefusedGeometry::NotBuilt(
                "no drawings were given at all, so no outline was ever read. The workpiece and its \
                 datum are still reported, because those are the operator's own settings and they \
                 are what this refusal is asking them to add a drawing to",
            ),
        );
        r.errors.push(
            "no drawings were given, so there is nothing to cut. An empty workpiece is refused rather \
             than posted as a program with no motion in it — a file that downloads and runs, doing \
             nothing, is indistinguishable at the machine from one whose geometry was lost"
                .into(),
        );
        return r;
    }

    // Prefix a note with the drawing it is about, but only when there is more
    // than one drawing to confuse it with. Notes are prose for a person, not
    // names a refusal has to match — unlike operation names, which stay
    // qualified always (see `LONE_DRAWING_ID`).
    let many = sources.len() > 1;
    let tag = |id: &str, note: String| -> String {
        if many {
            format!("`{id}`: {note}")
        } else {
            note
        }
    };

    // ---- 1. read every drawing --------------------------------------------
    let intakes: Vec<Intake> =
        sources.iter().map(|s| intake_one(s.data, &s.format, s.z_section_mm, &stock)).collect();

    // 🔴 The job name carries the FORMAT THE CONTENT TURNED OUT TO BE, read off
    // the intake that decided it. Sniffing the bytes a second time here to name
    // the job would be a second answer to the same question, and the day the two
    // disagreed the report would be labelled a DXF while the program was cut
    // from a mesh section.
    let job_name = match intakes.len() {
        1 => format!("imported.{}", intakes[0].label),
        n => format!("imported.{n} drawings"),
    };

    let mut notes: Vec<String> = Vec::new();
    for (s, intake) in sources.iter().zip(intakes.iter()) {
        for n in &intake.notes {
            notes.push(tag(&s.id, n.clone()));
        }
        if let Some(why) = &intake.error {
            // 🔴 HONESTLY NOTHING, and this is the case that decides the type is
            // worth having. The drawing that failed produced no closed outline —
            // there is no geometry for it, full stop — and the workpiece has not
            // been laid out, so any OTHER drawing's parts are read but have no
            // position yet. Drawing what parsed would show a workpiece missing the
            // part that did not, which is the exact failure step 1 refuses the
            // whole job to prevent.
            let mut r = refused_import_report(
                &job_name,
                cfg,
                &stock,
                sim_cell_mm,
                notes,
                RefusedGeometry::NotBuilt(
                    "this drawing produced no closed outline, and the workpiece was never laid out, so \
                     no part has a position to be drawn at. Any other drawing on the workpiece was \
                     read and NOT placed — drawing those would show a workpiece missing the part that \
                     failed",
                ),
            );
            r.errors.push(if many {
                format!("drawing `{}`: {why}", s.id)
            } else {
                why.clone()
            });
            // The refusal is about the SECTION; the solid the operator loaded is
            // still the thing they need to look at to understand why their Z
            // missed. Only carried when there is one drawing — see the header.
            if !many {
                r.loaded_mesh = mesh_budget_tris
                    .zip(intake.mesh.as_ref())
                    .and_then(|(b, m)| loaded_mesh_of(m, b, intake.section_z.unwrap_or(0.0)));
                r.notes.extend(r.loaded_mesh.as_ref().and_then(LoadedMesh::decimation_note));
                // ⚠ And it is the solid AS MODELLED. `place_mesh` needs the
                // layout, which is what this refusal is upstream of, so a
                // drawing carrying its own offset or rotation has a solid that
                // is one transform short of where its section would have gone.
                // Said out loud rather than left to be seen: the workpiece datum
                // above IS applied to it, so the two are easy to mistake.
                if !s.is_as_drawn() {
                    r.notes.push(format!(
                        "the 3D solid is drawn AS MODELLED: `{}` carries its own offset/rotation on \
                         the workpiece, and that placement is computed by the layout — which this \
                         refusal is upstream of. The workpiece datum IS applied; the drawing's own \
                         placement is not",
                        s.id
                    ));
                }
            }
            return r;
        }
    }

    // ---- 2. place them ----------------------------------------------------
    //
    // 🔴 THE PLACEMENT IS APPLIED TO THE GEOMETRY THE PROGRAM IS CUT FROM.
    // A part DRAWN turned while its toolpath is planned unturned cuts the wrong
    // shape, and the render is the thing that looks right. This is `P7R`'s
    // lesson one object along: the picture and the check must come from one
    // number.
    let mut layout = Layout::new();
    for (s, intake) in sources.iter().zip(intakes.iter()) {
        let placed = match PlacedDrawing::new(&s.id, intake.parts.clone()) {
            Ok(d) => d,
            Err(e) => {
                let mut r = refused_import_report(
                    &job_name,
                    cfg,
                    &stock,
                    sim_cell_mm,
                    notes,
                    RefusedGeometry::NotBuilt(
                        "the workpiece could not be laid out, so no part has a position — the parts \
                         that were read are still in their own drawing's millimetres and drawing \
                         them at the workpiece datum would put them somewhere nobody asked for",
                    ),
                );
                r.errors.push(e.describe());
                return r;
            }
        };
        // The delta is turned into `PlacedDrawing`'s absolute corner position by
        // adding the corner the drawing already had. Zero therefore means AS
        // DRAWN — see `ImportSource::offset_mm`.
        let drawn = placed.drawn_extent();
        let placed = placed
            .at(drawn.min_x + s.offset_mm[0], drawn.min_y + s.offset_mm[1])
            .rotated(s.rotation_deg);
        if let Err(e) = layout.add(placed) {
            let mut r = refused_import_report(
                &job_name,
                cfg,
                &stock,
                sim_cell_mm,
                notes,
                RefusedGeometry::NotBuilt(
                    "the workpiece was rejected while it was being laid out, so it is half-placed: \
                     drawing the drawings that got in would show a workpiece that is missing the one \
                     that did not",
                ),
            );
            r.errors.push(format!(
                "{} — give the drawings different names",
                e.describe()
            ));
            return r;
        }
    }
    // A drawing laid at something other than a quarter turn is runnable
    // arithmetic and a fixturing problem, so it NOTES rather than refuses —
    // `Stock::is_square_to_the_bed`'s reasoning, not restated here.
    notes.extend(layout.notes());

    // 🔴 ONE LIST, and everything downstream is built from it: the pair CHECK,
    // the operations, the keep regions the simulation verifies against, and the
    // outline the viewport draws. The last time a placed path was checked
    // against unplaced regions this core reported 0 gouges at one datum and 1027
    // at another, the clean one being a green that compared nothing because the
    // two had stopped overlapping at all. There is no second list here to drift.
    //
    // A drawing left exactly AS DRAWN is passed through untouched rather than
    // run through an identity transform: `(v - o) + o` is not exactly `v` in
    // binary floating point, so the arithmetic path would re-round every
    // coordinate of a drawing nobody moved — changing programs, silently, on the
    // day this landed. Only the NAME is added, which is what makes a refusal
    // able to say which drawing it condemned.
    let laid_out: Vec<crate::layout::LaidOutPart> = if sources.iter().all(ImportSource::is_as_drawn)
    {
        let mut out = Vec::new();
        for (s, intake) in sources.iter().zip(intakes.iter()) {
            for p in &intake.parts {
                let mut placed = p.clone();
                placed.name = format!("{}/{}", s.id, p.name);
                out.push(crate::layout::LaidOutPart {
                    drawing: s.id.clone(),
                    // One workpiece, said explicitly. See `PlacedDrawing::sheet_id`:
                    // the pair check compares parts that SHARE A WORKPIECE, and
                    // hard-coding the scope here rather than omitting it is what
                    // keeps that a rule instead of a coincidence.
                    sheet_id: crate::layout::ONE_SHEET.to_string(),
                    source_name: p.name.clone(),
                    part: placed,
                });
            }
        }
        out
    } else {
        layout.laid_out()
    };
    let placed_parts: Vec<Part> = laid_out.iter().map(|l| l.part.clone()).collect();

    // ---- 3. the tool, or a refusal ----------------------------------------
    //
    // 🔴 THE TOOL IS RESOLVED OR THE IMPORT IS REFUSED. Never substituted. A
    // Ø6mm end mill quietly standing in for a cutter nobody chose plans feeds,
    // depths, pass counts and clearances around a tool that is not in the
    // spindle, and the program posts, downloads and cuts.
    let mut lib_notes: Vec<String> = Vec::new();
    let lib = cfg.merged_library(&mut lib_notes);
    // An EMPTY id is an ABSENT choice, not a failed lookup, and it is the form
    // the browser actually sends when the picker reads `choose…`.
    let named = cfg.tool_id.as_deref().filter(|id| !id.trim().is_empty());
    // `None` = resolved; `Some(refusal)` = the job is refused with that sentence.
    let (tool, tool_refusal): (Tool, Option<String>) = match (named, cfg.tool_ids.as_deref()) {
        (Some(id), _) => match lib.iter().find(|t| t.id == id) {
            Some(t) => (t.tool.clone(), None),
            None => (Tool::default(), Some(unknown_tool_refusal(id, &lib))),
        },
        (None, Some(ids)) if ids.iter().any(|id| !id.trim().is_empty()) => {
            let chosen: Vec<&str> =
                ids.iter().map(String::as_str).filter(|id| !id.trim().is_empty()).collect();
            match chosen.iter().find_map(|id| lib.iter().find(|t| t.id == **id)) {
                Some(t) => (t.tool.clone(), None),
                None => (Tool::default(), Some(unknown_tool_refusal(chosen[0], &lib))),
            }
        }
        _ => (Tool::default(), Some(no_tool_selected_refusal())),
    };
    // 🔴 THE REACH CHECK, ON THE SINGLE-CUTTER PATH TOO.
    //
    // Audited 2026-08-10: this rule ran only when a tool SET was given. With one
    // `tool_id` — what the browser sends whenever one cutter is picked, i.e. the
    // ordinary case — a 12mm flute taken 18mm deep emitted 32kB of runnable
    // G-code with no note and no warning, while the SAME tool in a `tool_ids`
    // list was refused by name. Selecting a second cutter turned the safety
    // check on.
    //
    // Every imported operation is planned at the workpiece thickness (see the
    // `depth_total_mm` below), so that is the depth the cutter has to reach.
    // `recommend::reach_rejection` is the one predicate and the one sentence,
    // shared with the set path — a rule that exists twice is a rule that runs
    // once.
    let tool_refusal = tool_refusal.or_else(|| {
        crate::recommend::reach_rejection(&tool, stock.thickness_mm).map(|r| {
            format!("{}: {}", cfg.tool_id.as_deref().unwrap_or("the selected tool"), r.why())
        })
    });
    if let Some(why) = tool_refusal {
        // 🔴 THE FOUNDER'S CASE, AND THE ONE THAT WAS PURELY AN EARLY RETURN.
        // The drawings are read, the workpiece is laid out and `placed_parts` holds
        // the very geometry the operations would have been built from — the
        // refusal is about the CUTTER and nothing else. Dropping the outline
        // here left the operator picking a tool for a part they could not see,
        // at a datum the viewport had been told was zero.
        let mut r = refused_import_report(
            &job_name,
            cfg,
            &stock,
            sim_cell_mm,
            notes,
            RefusedGeometry::Placed(&placed_parts),
        );
        r.refusals.push(why);
        r.notes.extend(lib_notes);
        // 🔴 The solid still travels on a one-drawing workpiece. The operator's model
        // certainly exists and is exactly what they need on screen while they
        // pick a cutter; only the machining answer is missing.
        //
        // ⚠ And it is PLACED, by the same `place_mesh` the planned path uses.
        // The section beside it is now drawn placed, so an unplaced solid would
        // be two pictures of one part in two places — the disagreement this
        // whole path is arranged against, reintroduced by fixing half of it.
        if !many {
            r.loaded_mesh = mesh_budget_tris.zip(intakes[0].mesh.as_ref()).and_then(|(b, m)| {
                let moved = place_mesh(m, layout.get(&sources[0].id));
                loaded_mesh_of(&moved, b, intakes[0].section_z.unwrap_or(0.0))
            });
        }
        return r;
    }

    // ---- 4. 🔴 THE CHECK, BEFORE ANY OPERATION EXISTS ----------------------
    let margin = cfg.part_gap_margin_mm;
    if margin.is_none() {
        notes.push(NO_GAP_MARGIN_NOTE.into());
    }
    match Clearance::from_tool(&tool, margin.unwrap_or(0.0)) {
        None => {
            // A margin that is not a usable number is REFUSED, never clamped. A
            // NaN margin compares false against every gap test, so the check
            // would report a clear workpiece having tested nothing.
            //
            // The workpiece is laid out, so it is DRAWN: the operator is being asked
            // to fix a number, and the parts that number was going to be checked
            // between are exactly what they need on screen while they do it.
            let mut r = refused_import_report(
                &job_name,
                cfg,
                &stock,
                sim_cell_mm,
                notes,
                RefusedGeometry::Placed(&placed_parts),
            );
            r.refusals.push(format!(
                "the parts on this workpiece could NOT be checked against each other: a clearance \
                 could not be built from a {:.3}mm cutter and a part-gap margin of {:?}. The \
                 diameter must be positive and finite and the margin finite and not negative. An \
                 UNCHECKED workpiece is not a clear workpiece, so no program was produced",
                tool.diameter_mm, margin
            ));
            return r;
        }
        Some(clearance) => {
            // 🔴 Checked on `laid_out` — the SAME list the operations below are
            // built from — never on `layout.laid_out()` re-derived here. Two
            // reads of "where the parts are" is how a check ends up clearing a
            // workpiece the program does not cut.
            //
            // 🔴 The plant SKIPS the check rather than faking a clean result,
            // because that is the defect it restores: before this path existed
            // there was no check, and two parts on one piece of material posted
            // as one program. A plant that returned an empty finding list would
            // prove the reporting works and say nothing about whether the
            // geometry is ever examined.
            let findings = if plant == JobPlant::OverlapUnchecked {
                Vec::new()
            } else {
                crate::layout::check_interference(&laid_out, &clearance)
            };
            if !findings.is_empty() {
                // 🔴 NO G-CODE. Not a warning over a runnable program, not a
                // program with the offending operations struck out, and not a
                // nudge that would move a part into whatever is holding it down.
                // The operator re-nests, or moves the parts apart, and asks
                // again.
                // The drawing still travels, so the operator can SEE the workpiece
                // they were refused. It is the placed geometry — the same
                // coordinates the check condemned, never the untouched drawing.
                let mut r = refused_import_report(
                    &job_name,
                    cfg,
                    &stock,
                    sim_cell_mm,
                    notes,
                    RefusedGeometry::Placed(&placed_parts),
                );
                r.notes.push(OUTER_BOUNDARY_ONLY_NOTE.into());
                for f in &findings {
                    r.refusals.push(f.describe());
                }
                r.errors.push(format!(
                    "{} pair(s) of parts on this workpiece cannot be cut together — see the refusals, \
                     which name both parts and the numbers. NOTHING WAS POSTED: a rejected program \
                     that still prints G-code gets run anyway",
                    findings.len()
                ));
                return r;
            }
        }
    }

    // ---- 5. build and post ------------------------------------------------
    let mut job = Job::new("imported", machine(), stock);
    let base = OperationParams {
        depth_total_mm: job.stock.thickness_mm,
        depth_per_pass_mm: 4.0,
        ..OperationParams::default()
    };
    let mut keep: Vec<Contour> = Vec::new();
    for p in &placed_parts {
        keep.extend(keep_region(p, &[]));
        job.operations.extend(operations_for_part(p, &tool, &base));
    }

    let mut built = BuiltJob {
        job,
        dogbones: Vec::new(),
        keep,
        remove: Vec::new(),
        remove_depth_mm: 0.0,
        notes: Vec::new(),
        // An imported drawing is never planted: the plants are fixtures.
        plant: JobPlant::None,
    };
    built.notes.extend(notes);
    if many {
        built.notes.push(format!(
            "{} drawings on this workpiece, {} part(s) in total, and every pair of them was checked \
             against every other for shared material and for cutter clearance",
            sources.len(),
            placed_parts.len()
        ));
    }

    // The loaded solid. One drawing only — see the function header.
    let loaded_mesh = if many {
        if intakes.iter().any(|i| i.mesh.is_some()) {
            built.notes.push(
                "this workpiece holds more than one drawing, so the 3D SOLID is not shown. A report \
                 carries one solid, and a viewport drawing one solid over a program that cuts \
                 several sections is a picture that disagrees with the program. The SECTION each \
                 solid was reduced to is drawn, and it is the thing the machine follows"
                    .into(),
            );
        }
        None
    } else {
        let placed = mesh_budget_tris.zip(intakes[0].mesh.as_ref()).and_then(|(b, m)| {
            // 🔴 The solid is moved by the SAME placement as its section. A
            // solid drawn where the model had it, beside a section drawn where
            // the operator put it, is two pictures of one part in two places.
            let moved = place_mesh(m, layout.get(&sources[0].id));
            loaded_mesh_of(&moved, b, intakes[0].section_z.unwrap_or(0.0))
        });
        built.notes.extend(placed.as_ref().and_then(LoadedMesh::decimation_note));
        placed
    };

    cfg.apply(&mut built);

    let mut report = report_of_with_surface(&built, sim_cell_mm, surface_cell_mm);
    report.job = job_name;
    // Attached AFTER planning, deliberately: nothing about the program may
    // depend on whether someone asked to look at the model.
    report.loaded_mesh = loaded_mesh;
    // 🔴 The drawing as it is CUT, not as it was drawn. This is what
    // `operations_for_part` was handed, so the outline on screen and the
    // program are the same geometry — a viewport that drew the un-placed
    // drawing beside a turned program is exactly the disagreement this path
    // exists to make impossible.
    report.drawing = drawing_of(&placed_parts);
    /* 🔴 THE INVERTED PLANT, AND IT HAS TO BE INSIDE THIS FUNCTION.
     *
     * It was applied one level up at first, after `plant_audit` had already run
     * — so the audit compared two runs that still both carried the note and
     * declared the plant DISARMED. A plant applied outside the thing that audits
     * it is a plant nobody can prove.
     *
     * It removes a SENTENCE and nothing else: the program stays byte-identical,
     * ok=true, gouge=0, and 109.8mm² of the outline still will not exist in the
     * part. That silence is the defect gate REACH refuses. */
    if plant == JobPlant::ReachBlind {
        report.notes.retain(|n| !n.contains("CANNOT BE PRODUCED"));
    }
    report
}

/// The loaded solid, moved by its drawing's placement.
///
/// Z is untouched: the placement is a rotation and a translation in the WORKPIECE
/// plane, and the section Z is a statement about the solid's own height. Moving
/// it would move the plane the operator chose.
fn place_mesh(mesh: &crate::mesh::Mesh, placed: Option<&PlacedDrawing>) -> crate::mesh::Mesh {
    let Some(placed) = placed else { return mesh.clone() };
    let frame = placed.frame();
    let drawn = placed.drawn_extent();
    // An unmoved drawing is passed through, exactly as its parts are, and for
    // the same floating-point reason.
    if placed.x_mm == drawn.min_x && placed.y_mm == drawn.min_y && placed.rotation_deg == 0.0 {
        return mesh.clone();
    }
    let mut out = mesh.clone();
    for t in &mut out.tris {
        for v in t.iter_mut() {
            let (x, y) = frame.place(v[0] - drawn.min_x, v[1] - drawn.min_y);
            v[0] = x;
            v[1] = y;
        }
    }
    out
}

// ---------------------------------------------------------------------------
//  The one-drawing shorthands — every one of them a call of the engine above
// ---------------------------------------------------------------------------

/// Plan a job from an imported drawing rather than a reference fixture.
///
/// 🔴 `unsupported` entities and unclosed contours are carried into the report
/// as NOTES, and an import that produced nothing cuttable is a REFUSAL. An
/// importer that quietly drops what it cannot read hands the CAM a part with a
/// missing feature, and the resulting program looks entirely correct.
///
/// This is the TEXT entry point, for DXF and SVG. **An STL is not text** — see
/// [`plan_report_import_bytes`], which is the route a mesh must take.
pub fn plan_report_import(text: &str, format: &str, cfg: &JobConfig, sim_cell_mm: f64) -> Report {
    plan_report_import_bytes(text.as_bytes(), format, None, cfg, sim_cell_mm)
}

/// [`plan_report_import`], plus the simulated stock surface if asked for.
pub fn plan_report_import_with_surface(
    text: &str,
    format: &str,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> Report {
    plan_report_import_bytes_with_surface(
        text.as_bytes(),
        format,
        None,
        cfg,
        sim_cell_mm,
        surface_cell_mm,
    )
}

/// Plan a job from the RAW BYTES of a file the user supplied.
///
/// 🔴 **Bytes, not a string.** A binary STL is a fixed-length header followed by
/// 50 bytes per triangle of little-endian float; it is not UTF-8 and there is no
/// reason for it to be. Pushing it through a `&str` either fails outright or —
/// worse, in any host that replaces undecodable bytes — mangles the facets it
/// could not decode, and a mesh that quietly lost facets sections into an
/// outline with a side missing. That still looks like a part.
///
/// `format` is `"dxf" | "svg" | "stl" | "auto"`. `"auto"` decides by **content**,
/// never by the file's name — see [`crate::import::parse_bytes`] for the case
/// that makes that mandatory (a binary STL whose header text begins `solid`).
///
/// `z_section_mm` of `None` means **no Z was chosen**, and it does NOT silently
/// become 0. The core sections at the mesh's mid-height and SAYS SO in a note
/// the report carries to the screen.
pub fn plan_report_import_bytes(
    data: &[u8],
    format: &str,
    z_section_mm: Option<f64>,
    cfg: &JobConfig,
    sim_cell_mm: f64,
) -> Report {
    plan_report_import_bytes_with_surface(data, format, z_section_mm, cfg, sim_cell_mm, None)
}

/// [`plan_report_import_bytes`], plus the simulated stock surface if asked for.
pub fn plan_report_import_bytes_with_surface(
    data: &[u8],
    format: &str,
    z_section_mm: Option<f64>,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
) -> Report {
    plan_report_import_bytes_with_surface_and_mesh(
        data,
        format,
        z_section_mm,
        cfg,
        sim_cell_mm,
        surface_cell_mm,
        None,
    )
}

/// [`plan_report_import_bytes_with_surface`], plus the LOADED MESH if asked for.
///
/// 🔴 One drawing, left where it was drawn — a one-element
/// [`plan_report_import_many`]. The per-drawing placement is reachable only
/// through the engine, because a host that could place a drawing HERE would be
/// placing it outside the layout the overlap check runs on.
pub fn plan_report_import_bytes_with_surface_and_mesh(
    data: &[u8],
    format: &str,
    z_section_mm: Option<f64>,
    cfg: &JobConfig,
    sim_cell_mm: f64,
    surface_cell_mm: Option<f64>,
    mesh_budget_tris: Option<usize>,
) -> Report {
    let source = ImportSource {
        id: LONE_DRAWING_ID.into(),
        data,
        format: format.to_string(),
        z_section_mm,
        offset_mm: [0.0, 0.0],
        rotation_deg: 0.0,
    };
    plan_report_import_many(
        std::slice::from_ref(&source),
        cfg,
        sim_cell_mm,
        surface_cell_mm,
        mesh_budget_tris,
    )
}

#[cfg(test)]
mod mesh_import_tests {
    use super::*;

    /// An axis-aligned box as a **binary** STL.
    ///
    /// Binary on purpose: it is the flavour that cannot survive a string round
    /// trip, so a test written against it fails the moment anyone routes a mesh
    /// through a `&str` again.
    fn box_stl(x0: f64, y0: f64, z0: f64, sx: f64, sy: f64, sz: f64) -> Vec<u8> {
        let c = |i: usize| -> [f64; 3] {
            [
                x0 + if i & 1 == 0 { 0.0 } else { sx },
                y0 + if i & 2 == 0 { 0.0 } else { sy },
                z0 + if i & 4 == 0 { 0.0 } else { sz },
            ]
        };
        let quads: [[usize; 4]; 6] = [
            [0, 1, 3, 2],
            [4, 6, 7, 5],
            [0, 2, 6, 4],
            [1, 5, 7, 3],
            [0, 4, 5, 1],
            [2, 3, 7, 6],
        ];
        let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
        for q in quads {
            tris.push([c(q[0]), c(q[1]), c(q[2])]);
            tris.push([c(q[0]), c(q[2]), c(q[3])]);
        }

        // Header text deliberately begins with "solid": that is the trap a
        // first-five-bytes sniff falls into, and this fixture keeps the whole
        // path honest about it rather than only `mesh.rs`'s own tests.
        let mut out = vec![0u8; 80];
        let h = b"solid PART-A exported by a real CAD package";
        out[..h.len()].copy_from_slice(h);
        out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for t in &tris {
            for _ in 0..3 {
                out.extend_from_slice(&0f32.to_le_bytes()); // normal, ignored
            }
            for v in t {
                for k in 0..3 {
                    out.extend_from_slice(&(v[k] as f32).to_le_bytes());
                }
            }
            out.extend_from_slice(&0u16.to_le_bytes()); // attribute word
        }
        out
    }

    /// A 200x120x18 plate standing on z = 0, placed where the DXF fixtures put
    /// theirs so it lands well inside the default workpiece and the machine travel.
    fn plate_stl() -> Vec<u8> {
        box_stl(60.0, 60.0, 0.0, 200.0, 120.0, 18.0)
    }

    /// Coarse enough to keep the simulation quick; the geometry claims here do
    /// not depend on the cell size.
    const CELL: f64 = 2.0;

    #[test]
    fn an_stl_plans_a_cuttable_program_from_bytes_end_to_end() {
        let r = plan_report_import_bytes(
            &plate_stl(),
            "auto",
            Some(9.0),
            &cfg_with_a_chosen_tool(),
            CELL,
        );
        assert!(r.ok, "errors={:?} refusals={:?} notes={:?}", r.errors, r.refusals, r.notes);
        assert!(!r.gcode.is_empty(), "a runnable job emitted no G-code");
        assert!(r.gcode.contains("G1"), "no cutting moves in the program");
        assert!(r.cutting_distance_mm > 0.0, "nothing was cut");
        // One outline, no holes — reported as a count, because "1 part imported"
        // is equally true of a plate with features and of one that lost them.
        assert!(
            r.notes.iter().any(|n| n.contains("1 part(s) imported with 0 interior feature")),
            "{:?}",
            r.notes
        );
    }

    #[test]
    fn the_section_note_reaches_the_report_the_ui_renders() {
        // 🔴 The whole safety property of mesh import. An operator who believes
        // they asked for 3D machining and silently received one flat slice cuts
        // a plausible-looking wrong part, and nothing downstream can notice.
        let r = plan_report_import_bytes(
            &plate_stl(),
            "stl",
            Some(9.0),
            &cfg_with_a_chosen_tool(),
            CELL,
        );
        let notes = r.notes.join(" | ");
        assert!(notes.contains("STL SECTION at z = 9.000mm"), "{notes}");
        assert!(notes.contains("NOT 3D surfacing"), "{notes}");
        // STL declares no units at all, exactly like a DXF with no $INSUNITS.
        assert!(notes.contains("ASSUMED"), "the unit assumption was silent: {notes}");

        // ...and it survives a REFUSAL too. A report that only names the section
        // when the job succeeds is silent in the case where the operator is most
        // likely to be re-reading the screen.
        let miss = plan_report_import_bytes(
            &plate_stl(),
            "stl",
            Some(100.0),
            &cfg_with_a_chosen_tool(),
            CELL,
        );
        assert!(
            miss.notes.iter().any(|n| n.contains("STL SECTION at z = 100.000mm")),
            "{:?}",
            miss.notes
        );
    }

    #[test]
    fn a_z_that_crosses_nothing_is_refused_with_the_reason_not_emptily_accepted() {
        // 🔴 "Zero contours" and "your Z is above the part" are indistinguishable
        // to a caller, and only the second one can be acted on.
        let r = plan_report_import_bytes(
            &plate_stl(),
            "stl",
            Some(100.0),
            &cfg_with_a_chosen_tool(),
            CELL,
        );
        assert!(!r.ok, "a section that crossed nothing reported success");
        assert!(r.gcode.is_empty(), "a refused job emitted G-code");
        assert_eq!(r.cutting_distance_mm, 0.0);

        let why = r.errors.join(" | ");
        assert!(why.contains("100.000mm"), "the refusal does not name the Z: {why}");
        assert!(
            !why.contains("open contours"),
            "a missed section plane was blamed on open contours: {why}"
        );

        // The actionable detail — where the solid actually is — comes through in
        // the notes, from `mesh.rs`.
        let notes = r.notes.join(" | ");
        assert!(notes.contains("crossed no geometry"), "{notes}");
        assert!(
            notes.contains("0.000..18.000mm"),
            "the span the operator needs in order to pick a Z is missing: {notes}"
        );
    }

    #[test]
    fn an_unchosen_z_sections_at_mid_height_and_says_so_out_loud() {
        // 🔴 z = 0 would be the plausible-looking wrong answer: a model exported
        // sitting on its build plate has its bottom face exactly there, which is
        // coplanar and sections to nothing. Mid-height cuts something — which is
        // precisely why it has to announce itself as a guess.
        let r = plan_report_import_bytes(&plate_stl(), "auto", None, &cfg_with_a_chosen_tool(), CELL);
        assert!(r.ok, "{:?} {:?}", r.errors, r.notes);
        let notes = r.notes.join(" | ");
        assert!(notes.contains("STL SECTION at z = 9.000mm"), "{notes}");
        assert!(notes.contains("MID-HEIGHT"), "the default Z was silent: {notes}");
        assert!(notes.contains("CHOSEN FOR YOU"), "{notes}");
        assert!(
            notes.contains("0.000..18.000mm"),
            "the span the mid-height came from is not shown: {notes}"
        );
    }

    #[test]
    fn the_format_is_decided_by_content_so_a_mislabelled_mesh_still_sections() {
        // A binary STL named `part.dxf` routed to the DXF reader yields an empty
        // drawing — which reads downstream exactly like a valid drawing with no
        // features. Content wins; the extension is a claim by whoever named it.
        let r = plan_report_import_bytes(&plate_stl(), "dxf", Some(9.0), &cfg_with_a_chosen_tool(), CELL);
        assert!(
            r.notes.iter().any(|n| n.contains("STL SECTION")),
            "a mesh declared 'dxf' did not reach the section path: {:?} {:?}",
            r.errors,
            r.notes
        );
        assert!(r.ok, "{:?}", r.errors);
    }

    #[test]
    fn a_file_declared_stl_and_unreadable_as_one_is_refused_by_name() {
        let r = plan_report_import_bytes(
            b"0\nSECTION\n2\nENTITIES\n0\nEOF\n",
            "stl",
            Some(1.0),
            &cfg_with_a_chosen_tool(),
            CELL,
        );
        assert!(!r.ok);
        assert!(
            r.notes.iter().any(|n| n.contains("not a readable STL")),
            "{:?} {:?}",
            r.errors,
            r.notes
        );
    }

    #[test]
    fn the_text_entry_point_still_takes_dxf_and_svg_unchanged() {
        // The bytes path is the same path; this is the guard against "the mesh
        // work quietly changed how a drawing imports".
        let dxf = "0\nSECTION\n2\nENTITIES\n\
0\nLWPOLYLINE\n70\n1\n10\n60.0\n20\n60.0\n10\n260.0\n20\n60.0\n10\n260.0\n20\n180.0\n10\n60.0\n20\n180.0\n\
0\nENDSEC\n0\nEOF\n";
        let a = plan_report_import(dxf, "dxf", &cfg_with_a_chosen_tool(), CELL);
        assert!(a.ok, "{:?}", a.errors);
        let b = plan_report_import_bytes(dxf.as_bytes(), "auto", None, &cfg_with_a_chosen_tool(), CELL);
        assert_eq!(a.gcode, b.gcode, "the declared and the sniffed route diverged");
        assert!(
            a.notes.iter().all(|n| !n.contains("SECTION at z")),
            "a drawing was described as a mesh section: {:?}",
            a.notes
        );
    }
}

fn parse_category(s: &str) -> Option<ToolCategory> {
    ToolCategory::all().iter().copied().find(|c| c.as_str() == s)
}

#[cfg(test)]
mod tool_import_tests {
    use super::*;

    fn cfg(json: &str) -> JobConfig {
        serde_json::from_str(json).expect("config should parse")
    }

    const GOOD: &str = r#"{"extra_tools":[{"id":"Shop 6mm 1F","category":"End Mill",
        "diameter_mm":6.0,"flutes":1,"shank_mm":6.0,"cutting_length_mm":22.0,
        "chipload_mm":0.18,"chipload_min_mm":0.08,"chipload_max_mm":0.30,
        "rpm_min":10000,"rpm_max":24000}],"tool_id":"Shop 6mm 1F"}"#;

    /// 🔴 BOTH TESTS BELOW USED TO READ `operations[0]`, AND ON `plate` THAT IS
    /// `plate-mark1` — AN ENGRAVING. They passed for the wrong reason: the
    /// singular `tool_id` door stamped the chosen cutter onto EVERY operation
    /// including the marks, so a Ø6mm end mill was silently put on a 0.4mm-deep
    /// part-ID cut, which does not mark a part, it smears one. The door collapse
    /// of 2026-08-11 routes a singular id through `assign_tools_from_set`, which
    /// leaves engravings alone by design (there is no engraving feature kind and
    /// a V-carve is chosen by included angle, not diameter).
    ///
    /// ⚠ The consequence is NOT hidden and that is what makes it acceptable: the
    /// job becomes `tools=2 changes=1`, the header names
    /// `End Mill - Down-cut 3.175mm 2F`, a note says it needs a collet change,
    /// and the tool change is charged in the estimate. An un-chosen tool that is
    /// announced in four places is a different fact from one substituted in
    /// silence. So these now assert **by operation name**, and assert the
    /// engraving arm too — indexing by position is what let the old behaviour
    /// look verified.
    fn op_named<'a>(j: &'a BuiltJob, name: &str) -> &'a Operation {
        j.job
            .operations
            .iter()
            .find(|o| o.name == name)
            .unwrap_or_else(|| panic!("no operation named {name}"))
    }

    #[test]
    fn a_user_tool_can_be_added_and_selected() {
        let mut j = build("plate", JobPlant::None).unwrap();
        cfg(GOOD).apply(&mut j);
        assert!(
            j.job.operations.iter().any(|o| o.tool.name == "Shop 6mm 1F"),
            "the user tool was not selected"
        );
        // ...and its numbers are the ones used on a MILLING feature: 1 flute at
        // 0.18 is a different feed from the built-in 2 flute at 0.10.
        let t = &op_named(&j, "plate").tool;
        assert_eq!(t.flutes, 1);
        assert!((t.chipload_mm - 0.18).abs() < 1e-9);
        // ...and the engraving is NOT on it, with the reason said out loud.
        assert_ne!(
            op_named(&j, "plate-mark1").tool.name,
            "Shop 6mm 1F",
            "a Ø6mm end mill was put on a 0.4mm part-ID mark"
        );
        assert!(
            j.notes.iter().any(|n| n.contains("plate-mark1") && n.contains("included angle")),
            "the engraving kept its tool and nothing said so: {:?}",
            j.notes
        );
    }

    #[test]
    fn a_user_tool_with_an_existing_id_replaces_it() {
        // This is how a shop corrects a chipload it has actually measured.
        let mut j = build("plate", JobPlant::None).unwrap();
        cfg(r#"{"extra_tools":[{"id":"End Mill - Down-cut 6mm 2F","category":"End Mill",
            "diameter_mm":6.0,"flutes":2,"shank_mm":6.0,"cutting_length_mm":25.0,
            "chipload_mm":0.14,"chipload_min_mm":0.05,"chipload_max_mm":0.25,
            "rpm_min":8000,"rpm_max":24000}],
            "tool_id":"End Mill - Down-cut 6mm 2F"}"#)
        .apply(&mut j);
        assert!((op_named(&j, "plate").tool.chipload_mm - 0.14).abs() < 1e-9);
    }

    #[test]
    fn an_invalid_user_tool_is_refused_with_its_faults_named() {
        // 🔴 An inverted chipload window would derive feeds from nonsense.
        let mut j = build("plate", JobPlant::None).unwrap();
        cfg(r#"{"extra_tools":[{"id":"Bad","category":"End Mill",
            "diameter_mm":6.0,"flutes":2,"shank_mm":6.0,"cutting_length_mm":25.0,
            "chipload_mm":0.1,"chipload_min_mm":0.30,"chipload_max_mm":0.05,
            "rpm_min":8000,"rpm_max":24000}],"tool_id":"Bad"}"#)
        .apply(&mut j);
        assert!(
            j.notes.iter().any(|n| n.contains("is invalid") && n.contains("NOT added")),
            "an invalid tool was accepted silently: {:?}",
            j.notes
        );
        assert!(j.job.operations.iter().all(|o| o.tool.name != "Bad"));
    }

    #[test]
    fn an_unknown_category_is_refused_by_name() {
        let mut j = build("plate", JobPlant::None).unwrap();
        cfg(r#"{"extra_tools":[{"id":"Weird","category":"Sonic Screwdriver",
            "diameter_mm":6.0,"flutes":2,"shank_mm":6.0,"cutting_length_mm":25.0,
            "chipload_mm":0.1,"chipload_min_mm":0.05,"chipload_max_mm":0.2,
            "rpm_min":8000,"rpm_max":24000}]}"#)
        .apply(&mut j);
        assert!(j.notes.iter().any(|n| n.contains("not one of the known categories")));
    }

    #[test]
    fn a_tool_missing_a_required_field_is_rejected_at_parse_time() {
        // Every field is required on purpose: defaulting a chipload silently
        // feeds a cutter at somebody else's numbers.
        let r: Result<JobConfig, _> = serde_json::from_str(
            r#"{"extra_tools":[{"id":"Half","category":"End Mill","diameter_mm":6.0}]}"#,
        );
        assert!(r.is_err(), "a tool with no chipload window was accepted");
    }
}

#[cfg(test)]
mod stock_surface_tests {
    use super::*;

    /// Decode base64 back to bytes. Test-side only.
    ///
    /// 🔴 This decoder does NOT validate the encoder on its own — two
    /// hand-rolled halves of the same idea agree with each other by
    /// construction. What pins the encoder to the standard the browser's `atob`
    /// implements is `b64_matches_the_rfc_4648_test_vectors` below; this
    /// function only exists so the other tests can look at the numbers.
    pub(super) fn unb64(s: &str) -> Vec<u8> {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let idx = |ch: u8| A.iter().position(|a| *a == ch).unwrap() as u32;
        let raw: Vec<u8> = s.bytes().filter(|b| *b != b'=').collect();
        let mut out = Vec::with_capacity(raw.len() * 3 / 4);
        for c in raw.chunks(4) {
            let mut n = 0u32;
            for (i, b) in c.iter().enumerate() {
                n |= idx(*b) << (18 - 6 * i);
            }
            out.push((n >> 16) as u8);
            if c.len() > 2 {
                out.push((n >> 8) as u8);
            }
            if c.len() > 3 {
                out.push(n as u8);
            }
        }
        out
    }

    fn heights(s: &StockSurface) -> Vec<f32> {
        let b = unb64(&s.z_mm_b64);
        b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
    }

    #[test]
    fn b64_matches_the_rfc_4648_test_vectors() {
        // The whole transport rests on the browser's `atob` reading what this
        // encoder wrote. These are the RFC's own vectors, so the assertion is
        // against the standard rather than against our own decoder.
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foob"), "Zm9vYg==");
        assert_eq!(b64(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
        // And a float, little-endian, the way the surface carries them.
        assert_eq!(b64(&(-6.0f32).to_le_bytes()), "AADAwA==");
    }

    #[test]
    fn the_surface_is_absent_unless_it_is_asked_for() {
        // 🔴 Both directions. A test that only proved it ARRIVES would pass just
        // as well if it always arrived, and "always" is the expensive bug: a
        // 600x900 workpiece at the default cell is megabytes on every re-plan.
        let declined =
            plan_report("pocket", JobPlant::None, &JobConfig::default(), 2.0).unwrap();
        assert!(
            declined.simulated_stock_surface.is_none(),
            "a caller that did not ask for the surface was sent one anyway"
        );

        let asked = plan_report_with_surface(
            "pocket",
            JobPlant::None,
            &JobConfig::default(),
            2.0,
            Some(2.0),
        )
        .unwrap();
        assert!(
            asked.simulated_stock_surface.is_some(),
            "the surface was asked for and did not arrive"
        );
    }

    #[test]
    fn the_encoded_array_holds_exactly_cols_times_rows_heights() {
        let r =
            plan_report_with_surface("plate", JobPlant::None, &JobConfig::default(), 2.0, Some(2.0))
                .unwrap();
        let s = r.simulated_stock_surface.unwrap();
        let z = heights(&s);
        assert_eq!(
            z.len(),
            s.cols * s.rows,
            "{} heights for a {}x{} map — a consumer indexing row*cols+col would read \
             off the end or draw a shifted picture",
            z.len(),
            s.cols,
            s.rows
        );
        // The workpiece is 600x900 and the samples are one cell apart, endpoints
        // included: an off-by-one here is a map that does not cover the workpiece.
        assert_eq!((s.cols, s.rows), (301, 451));
        assert_eq!(s.cell_mm, 2.0);
        assert_eq!((s.origin_x_mm, s.origin_y_mm), (0.0, 0.0));
    }

    #[test]
    fn a_cleared_pocket_reads_at_depth_and_the_stock_beside_it_reads_zero() {
        // 🔴 This is the test that catches a TRANSPOSED map or a wrong origin,
        // both of which produce a picture that looks entirely plausible and is
        // mirrored — and a mirrored picture of a machined workpiece is not something
        // anyone can spot by eye.
        //
        // The `pocket` job clears a 60x60 pocket at x 120..180, y 90..150, to a
        // 6mm floor in an 18mm workpiece. The rectangle is deliberately NOT symmetric
        // about the diagonal, so the two probes below swap into each other:
        //
        //   (165, 105) is inside the pocket    -> must read about -6mm
        //   (105, 165) is untouched plate      -> must read 0
        //
        // Transpose the map and each probe returns the other's value, so the
        // pair fails in both directions at once.
        const CELL: f64 = 1.0;
        let r = plan_report_with_surface(
            "pocket",
            JobPlant::None,
            &JobConfig::default(),
            CELL,
            Some(CELL),
        )
        .unwrap();
        let s = r.simulated_stock_surface.unwrap();
        let z = heights(&s);
        let at = |x: f64, y: f64| -> f32 {
            let c = ((x - s.origin_x_mm) / s.cell_mm).round() as usize;
            let rr = ((y - s.origin_y_mm) / s.cell_mm).round() as usize;
            z[rr * s.cols + c]
        };

        let inside = at(165.0, 105.0);
        assert!(
            (inside + 6.0).abs() < 0.5,
            "inside the pocket read {inside}mm, not the 6mm design floor"
        );

        let swapped = at(105.0, 165.0);
        assert!(
            swapped.abs() < 1e-6,
            "the transposed probe read {swapped}mm — the map is mirrored about its \
             diagonal, or its origin is wrong"
        );

        // A workpiece cell nowhere near the part at all. If this is cut, the map is not
        // aligned to the workpiece it claims to describe.
        let far = at(500.0, 800.0);
        assert!(far.abs() < 1e-6, "bare workpiece at (500,800) read {far}mm");
    }

    #[test]
    fn a_coarser_display_cell_reports_its_own_resolution_and_never_a_shallower_surface() {
        // The struct must state the resolution of the array it carries, not the
        // one that was requested and not the simulation's. And the reduction has
        // to be the DEEPEST sample in each block: an average would show less
        // material removed at coarse cells than the simulation actually found,
        // which is the direction that makes a bad program look acceptable.
        const SIM: f64 = 1.0;
        let fine = plan_report_with_surface(
            "pocket",
            JobPlant::None,
            &JobConfig::default(),
            SIM,
            Some(SIM),
        )
        .unwrap()
        .simulated_stock_surface
        .unwrap();
        let coarse = plan_report_with_surface(
            "pocket",
            JobPlant::None,
            &JobConfig::default(),
            SIM,
            Some(4.0),
        )
        .unwrap()
        .simulated_stock_surface
        .unwrap();

        assert_eq!(coarse.cell_mm, 4.0, "the coarse map did not state its own cell size");
        assert!(coarse.cols * coarse.rows < fine.cols * fine.rows / 10);

        let (zf, zc) = (heights(&fine), heights(&coarse));
        let k = 4usize;
        for r in 0..coarse.rows {
            for c in 0..coarse.cols {
                let v = zc[r * coarse.cols + c];
                let mut deepest = f32::INFINITY;
                for dr in 0..k {
                    for dc in 0..k {
                        let (sr, sc) = (r * k + dr, c * k + dc);
                        if sr < fine.rows && sc < fine.cols {
                            deepest = deepest.min(zf[sr * fine.cols + sc]);
                        }
                    }
                }
                assert!(
                    (v - deepest).abs() < 1e-6,
                    "coarse cell ({c},{r}) reported {v}mm where the deepest sample it \
                     covers is {deepest}mm"
                );
            }
        }

        // A request FINER than the simulation cannot invent detail, so it comes
        // back at the simulation's own resolution rather than pretending.
        let finer = plan_report_with_surface(
            "pocket",
            JobPlant::None,
            &JobConfig::default(),
            SIM,
            Some(0.1),
        )
        .unwrap()
        .simulated_stock_surface
        .unwrap();
        assert_eq!(finer.cell_mm, SIM, "a request for detail the simulation never had was honoured");
    }

    #[test]
    fn a_refused_import_carries_no_surface_even_when_one_was_asked_for() {
        // An all-zero map renders as a pristine workpiece, which is indistinguishable
        // from a job that ran and removed nothing. Nothing is the honest answer.
        let r = plan_report_import_bytes_with_surface(
            b"not a drawing",
            "dxf",
            None,
            &cfg_with_a_chosen_tool(),
            2.0,
            Some(4.0),
        );
        assert!(!r.ok);
        assert!(r.simulated_stock_surface.is_none());
    }
}

#[cfg(test)]
mod loaded_mesh_tests {
    use super::stock_surface_tests::unb64;
    use super::*;

    /// A binary STL of an axis-aligned box, 12 triangles.
    ///
    /// Binary on purpose, and NOT symmetric about the diagonal: `sx != sy`, and
    /// the origin is offset in every axis by a different amount. Every one of
    /// those choices is load-bearing for
    /// `the_vertices_arrive_at_the_coordinates_the_file_gave` below — a box at
    /// the origin, or a square one, would survive a transposed or dropped
    /// coordinate looking perfectly correct.
    fn box_stl(x0: f64, y0: f64, z0: f64, sx: f64, sy: f64, sz: f64) -> Vec<u8> {
        let c = |i: usize| -> [f64; 3] {
            [
                x0 + if i & 1 == 0 { 0.0 } else { sx },
                y0 + if i & 2 == 0 { 0.0 } else { sy },
                z0 + if i & 4 == 0 { 0.0 } else { sz },
            ]
        };
        let quads: [[usize; 4]; 6] =
            [[0, 1, 3, 2], [4, 6, 7, 5], [0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6]];
        let mut tris: Vec<[[f64; 3]; 3]> = Vec::new();
        for q in quads {
            tris.push([c(q[0]), c(q[1]), c(q[2])]);
            tris.push([c(q[0]), c(q[2]), c(q[3])]);
        }
        let mut out = vec![0u8; 80];
        out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for t in &tris {
            for _ in 0..3 {
                out.extend_from_slice(&0f32.to_le_bytes()); // normal, ignored
            }
            for v in t {
                for k in 0..3 {
                    out.extend_from_slice(&(v[k] as f32).to_le_bytes());
                }
            }
            out.extend_from_slice(&0u16.to_le_bytes());
        }
        out
    }

    /// The plate the other mesh tests use, placed where a DXF fixture would put
    /// it so it lands inside the workpiece: 200 x 120 x 18 at (60, 60, 0).
    fn plate_stl() -> Vec<u8> {
        box_stl(60.0, 60.0, 0.0, 200.0, 120.0, 18.0)
    }

    const CELL: f64 = 2.0;

    /// Decode the wire form back to `[x, y, z]` triples, three per triangle.
    ///
    /// The base64 half is pinned to the standard the browser's `atob` implements
    /// by `stock_surface_tests::b64_matches_the_rfc_4648_test_vectors` — this
    /// decoder only exists so the tests below can look at the numbers, and
    /// proves nothing on its own.
    fn verts(m: &LoadedMesh) -> Vec<[f32; 3]> {
        unb64(&m.xyz_mm_b64)
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect::<Vec<f32>>()
            .chunks_exact(3)
            .map(|v| [v[0], v[1], v[2]])
            .collect()
    }

    fn plan(data: &[u8], format: &str, budget: Option<usize>) -> Report {
        plan_report_import_bytes_with_surface_and_mesh(
            data,
            format,
            Some(9.0),
            &cfg_with_a_chosen_tool(),
            CELL,
            None,
            budget,
        )
    }

    #[test]
    fn the_mesh_is_absent_unless_it_is_asked_for() {
        // 🔴 Both directions, for the same reason the surface test checks both:
        // a test that only proved it ARRIVES would pass just as well if it
        // always arrived, and "always" is the expensive bug. A real part is
        // routinely 100k+ triangles, i.e. megabytes on every re-plan while
        // someone drags a slider.
        let declined = plan(&plate_stl(), "stl", None);
        assert!(declined.ok, "{:?}", declined.errors);
        assert!(
            declined.loaded_mesh.is_none(),
            "a caller that did not ask for the model was sent one anyway"
        );

        let asked = plan(&plate_stl(), "stl", Some(10_000));
        assert!(
            asked.loaded_mesh.is_some(),
            "the model was asked for and did not arrive"
        );

        // And the older entry points must still decline it, because every
        // existing caller — the CLI included — goes through one of them.
        let old = plan_report_import_bytes(&plate_stl(), "stl", Some(9.0), &cfg_with_a_chosen_tool(), CELL);
        assert!(old.loaded_mesh.is_none(), "the no-mesh entry point started shipping a mesh");
    }

    #[test]
    fn the_triangle_count_is_the_length_of_the_array_it_describes() {
        // 🔴 The count is what a consumer allocates and loops against. A count
        // that overstates the array reads off the end; one that understates it
        // silently drops facets off the far side of the solid. Neither looks
        // wrong on screen.
        let m = plan(&plate_stl(), "stl", Some(10_000)).loaded_mesh.unwrap();
        let v = verts(&m);
        assert_eq!(m.triangles, 12, "the box is 12 triangles");
        assert_eq!(m.source_triangles, 12);
        assert!(!m.decimated, "nothing was over budget and it claimed decimation");
        assert_eq!(
            v.len(),
            m.triangles * 3,
            "{} vertices for {} triangles — a renderer reading 3 per triangle would run off the end",
            v.len(),
            m.triangles
        );
    }

    #[test]
    fn a_budget_reports_what_was_delivered_and_never_what_was_asked_for() {
        // A struct that echoed the request would be a control asserting
        // something untrue about itself — the same defect `StockSurface::cell_mm`
        // is written to avoid.
        let m = plan(&plate_stl(), "stl", Some(5)).loaded_mesh.unwrap();
        assert!(m.triangles <= 5, "the budget was exceeded: {} triangles", m.triangles);
        // 12 triangles under a budget of 5 keeps every 3rd, which is 4 — NOT the
        // 5 that were asked for. Pinned deliberately: if the delivered count
        // ever equals the request, the obvious suspicion is a field echoing the
        // argument rather than counting the array.
        assert_eq!(m.triangles, 4, "expected every 3rd of 12 triangles");
        assert_eq!(m.source_triangles, 12, "the file's own count was overwritten");
        assert!(m.decimated, "triangles were dropped and the flag said otherwise");
        assert_eq!(verts(&m).len(), m.triangles * 3, "the count and the array disagree");

        // 🔴 And it SAYS SO on the screen, not only in a field. A renderer that
        // never reads `decimated` would otherwise present a sieve as the model.
        let r = plan(&plate_stl(), "stl", Some(5));
        let notes = r.notes.join(" | ");
        assert!(notes.contains("NOT the model"), "the decimation was silent: {notes}");
        assert!(notes.contains("was taken from the FULL mesh"), "{notes}");

        // The full mesh is what gets cut, whatever the viewport asked for.
        let full = plan(&plate_stl(), "stl", None);
        assert_eq!(r.gcode, full.gcode, "a DISPLAY budget changed the emitted program");
    }

    #[test]
    fn a_drawing_carries_no_mesh_at_all_because_a_drawing_has_no_solid() {
        // 🔴 Absent, not empty. A DXF has no 3D object in it — that is what the
        // format IS, not a feature we have not built. An empty-but-present mesh
        // would read to a UI as "a 3D object that happens to be invisible", so
        // the toggle would enable itself and draw nothing, which looks like a
        // broken viewport rather than a 2D drawing.
        let dxf = "0\nSECTION\n2\nENTITIES\n\
0\nLWPOLYLINE\n70\n1\n10\n60.0\n20\n60.0\n10\n260.0\n20\n60.0\n10\n260.0\n20\n180.0\n10\n60.0\n20\n180.0\n\
0\nENDSEC\n0\nEOF\n";
        for format in ["dxf", "auto"] {
            let r = plan(dxf.as_bytes(), format, Some(10_000));
            assert!(r.ok, "the drawing did not import at all: {:?}", r.errors);
            assert!(
                r.loaded_mesh.is_none(),
                "a 2D drawing came back carrying a 3D object ({format})"
            );
        }

        // An SVG is the same fact by the same reasoning.
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect x="60" y="60" width="200" height="120"/></svg>"#;
        assert!(
            plan(svg.as_bytes(), "svg", Some(10_000)).loaded_mesh.is_none(),
            "an SVG came back carrying a 3D object"
        );
    }

    #[test]
    fn the_vertices_arrive_at_the_coordinates_the_file_gave() {
        // 🔴 THE ROUND TRIP. This is the test that catches a transposed axis
        // pair, a dropped or duplicated coordinate, and an offset — every one of
        // which draws a solid that looks entirely plausible and is wrong, and a
        // wrong solid on screen is read as "this is what the machine makes".
        //
        // The box is deliberately unequal in every dimension and offset by a
        // different amount in each axis, so no swap of two coordinates can land
        // back on a corner of the same box.
        let (x0, y0, z0, sx, sy, sz) = (11.0f64, 23.0, 5.0, 200.0, 120.0, 18.0);
        let m = plan(&box_stl(x0, y0, z0, sx, sy, sz), "stl", Some(10_000))
            .loaded_mesh
            .unwrap();
        let v = verts(&m);

        let corners: Vec<[f32; 3]> = (0..8)
            .map(|i| {
                [
                    (x0 + if i & 1 == 0 { 0.0 } else { sx }) as f32,
                    (y0 + if i & 2 == 0 { 0.0 } else { sy }) as f32,
                    (z0 + if i & 4 == 0 { 0.0 } else { sz }) as f32,
                ]
            })
            .collect();

        for (i, p) in v.iter().enumerate() {
            assert!(
                corners.iter().any(|c| (c[0] - p[0]).abs() < 1e-3
                    && (c[1] - p[1]).abs() < 1e-3
                    && (c[2] - p[2]).abs() < 1e-3),
                "vertex {i} decoded to {p:?}, which is not a corner of the box the file described"
            );
        }
        // Every corner has to be USED, or half the solid could be missing while
        // each surviving vertex still checks out above.
        for c in &corners {
            assert!(
                v.iter().any(|p| (c[0] - p[0]).abs() < 1e-3
                    && (c[1] - p[1]).abs() < 1e-3
                    && (c[2] - p[2]).abs() < 1e-3),
                "corner {c:?} of the loaded box never arrived"
            );
        }

        // The bounds the struct reports must be the bounds of what it shipped —
        // a UI frames the camera on these before it ever decodes a vertex.
        assert_eq!(m.min_mm, [x0, y0, z0]);
        assert_eq!(m.max_mm, [x0 + sx, y0 + sy, z0 + sz]);
    }

    #[test]
    fn the_mesh_carries_the_z_it_will_actually_be_cut_at() {
        // 🔴 The honesty requirement, mechanised. The solid is the INPUT; what
        // the machine makes is the flat section at this Z. The number rides
        // inside the struct so a renderer can draw the plane against the model
        // without asking a second object where the truth is — and so that
        // "showing the loaded object" and "showing what will be cut" cannot
        // drift apart in a UI.
        let m = plan(&plate_stl(), "stl", Some(10_000)).loaded_mesh.unwrap();
        assert_eq!(m.section_z_mm, 9.0);

        // A Z nobody chose is still reported as the Z that was USED, not as a
        // missing value the UI has to invent a default for.
        let mid = plan_report_import_bytes_with_surface_and_mesh(
            &plate_stl(),
            "stl",
            None,
            &cfg_with_a_chosen_tool(),
            CELL,
            None,
            Some(10_000),
        );
        assert_eq!(mid.loaded_mesh.unwrap().section_z_mm, 9.0, "mid-height of a 0..18 solid");
    }

    #[test]
    fn a_refused_section_still_carries_the_solid_the_operator_loaded() {
        // 🔴 Opposite rule to the simulated surface, on purpose. The surface is
        // an OUTPUT of machining that did not happen, so sending one would draw
        // a workpiece that was never cut. The mesh is the INPUT and certainly
        // exists — and a Z that missed the part is exactly when someone needs to
        // see their solid and where the plane went.
        let r = plan_report_import_bytes_with_surface_and_mesh(
            &plate_stl(),
            "stl",
            Some(100.0), // the solid spans 0..18
            &cfg_with_a_chosen_tool(),
            CELL,
            Some(4.0),
            Some(10_000),
        );
        assert!(!r.ok, "a section that crossed nothing reported success");
        assert!(r.simulated_stock_surface.is_none(), "a refused job carried a machined surface");
        let m = r.loaded_mesh.expect("the refusal threw away the model it was refusing to section");
        assert_eq!(m.triangles, 12);
        assert_eq!(m.section_z_mm, 100.0, "the reported plane is not the one that was tried");
    }

    #[test]
    fn a_file_that_is_not_a_readable_mesh_yields_no_mesh() {
        // Nothing parsed, so there is nothing to draw — and the refusal already
        // names the reason. An empty solid here would be an object on screen
        // asserting that the file was fine.
        let r = plan(b"solid nonsense\nnot an stl at all\n", "stl", Some(10_000));
        assert!(!r.ok);
        assert!(r.loaded_mesh.is_none(), "an unreadable file produced a 3D object");
    }
}

// ===========================================================================
//  The drawing, and the per-move facts — what leaves the core for a viewport.
// ===========================================================================
//
// 🔴 These tests exist because the alternative was TypeScript. A viewport that
// wants the drawing can only get it from `render` by un-offsetting the cutter
// radius, the lead-ins, the tabs and the reliefs — four transforms, none of them
// invertible, re-derived in a language no gate compiles. So the core states what
// it knows, and these tests are what keeps the statement true.
#[cfg(test)]
mod drawing_export_tests {
    use super::*;

    const CELL: f64 = 2.0;

    /// A 200 x 120 rectangle at (60, 60). **Deliberately not square**: a
    /// transposed axis in the export is invisible on a square and obvious here.
    const RECT_DXF: &str = "0\nSECTION\n2\nENTITIES\n\
0\nLWPOLYLINE\n70\n1\n10\n60.0\n20\n60.0\n10\n260.0\n20\n60.0\n10\n260.0\n20\n180.0\n10\n60.0\n20\n180.0\n\
0\nENDSEC\n0\nEOF\n";

    /// The same rectangle with a 20mm-radius circular hole at its centre.
    const RECT_WITH_HOLE_DXF: &str = "0\nSECTION\n2\nENTITIES\n\
0\nLWPOLYLINE\n70\n1\n10\n60.0\n20\n60.0\n10\n260.0\n20\n60.0\n10\n260.0\n20\n180.0\n10\n60.0\n20\n180.0\n\
0\nCIRCLE\n10\n160.0\n20\n120.0\n40\n20.0\n\
0\nENDSEC\n0\nEOF\n";

    /// Bounds of a contour's VERTICES. Deliberately vertex-only: for an arc the
    /// true extent bulges past the vertices, so this understates a circle by
    /// design and every assertion below is written knowing that.
    fn vert_bounds(c: &DrawingContour) -> (f64, f64, f64, f64) {
        let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for v in &c.verts {
            b.0 = b.0.min(v.x);
            b.1 = b.1.min(v.y);
            b.2 = b.2.max(v.x);
            b.3 = b.3.max(v.y);
        }
        b
    }

    fn render_bounds(r: &Report) -> (f64, f64, f64, f64) {
        let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for m in r.render.iter().filter(|m| m.kind == "cut" || m.kind == "tab") {
            b.0 = b.0.min(m.x);
            b.1 = b.1.min(m.y);
            b.2 = b.2.max(m.x);
            b.3 = b.3.max(m.y);
        }
        b
    }

    /// Every distinct `F` word in an emitted program, as the post rounded it.
    fn feeds_in_gcode(gcode: &str) -> Vec<f64> {
        let mut out: Vec<f64> = Vec::new();
        for line in gcode.lines() {
            let line = line.split('(').next().unwrap_or("");
            for word in line.split_whitespace() {
                if let Some(rest) = word.strip_prefix('F') {
                    if let Ok(v) = rest.parse::<f64>() {
                        if !out.iter().any(|o: &f64| (o - v).abs() < 1e-9) {
                            out.push(v);
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn the_imported_drawing_comes_back_at_its_own_extent() {
        let r = plan_report_import(RECT_DXF, "dxf", &cfg_with_a_chosen_tool(), CELL);
        assert_eq!(r.drawing.len(), 1, "one polyline imported as {} part(s)", r.drawing.len());
        let outer = &r.drawing[0].outer;
        assert!(outer.closed, "a closed rectangle came back open");
        let (x0, y0, x1, y1) = vert_bounds(outer);
        // The numbers from the DXF, to the millimetre, in the axis they were
        // written in. 200 x 120 — a transpose fails on the width alone.
        assert!(
            (x0 - 60.0).abs() < 1e-6
                && (y0 - 60.0).abs() < 1e-6
                && (x1 - 260.0).abs() < 1e-6
                && (y1 - 180.0).abs() < 1e-6,
            "the drawing came back as {x0},{y0}..{x1},{y1}, not 60,60..260,180 — either an axis \
             was transposed or an offset was left on it"
        );
    }

    #[test]
    fn the_drawing_is_the_drawing_and_not_the_cutter_centre_line() {
        // The one assertion that catches "someone exported `render` twice".
        // An outside profile puts the cutter centre a tool RADIUS outside the
        // boundary, so the toolpath is strictly larger on all four sides. If the
        // drawing ever equals the path, the offset was never removed — which is
        // exactly the un-offsetting this export exists to make unnecessary.
        let r = plan_report_import(RECT_DXF, "dxf", &cfg_with_a_chosen_tool(), CELL);
        let (dx0, dy0, dx1, dy1) = vert_bounds(&r.drawing[0].outer);
        let (rx0, ry0, rx1, ry1) = render_bounds(&r);
        assert!(
            rx0 < dx0 - 1.0 && ry0 < dy0 - 1.0 && rx1 > dx1 + 1.0 && ry1 > dy1 + 1.0,
            "the toolpath {rx0},{ry0}..{rx1},{ry1} does not enclose the drawing \
             {dx0},{dy0}..{dx1},{dy1} by a tool radius — the exported contours look like the \
             offset path, not the imported geometry"
        );
    }

    #[test]
    fn a_drawing_with_a_hole_exports_the_outer_and_the_inner() {
        let r = plan_report_import(RECT_WITH_HOLE_DXF, "dxf", &cfg_with_a_chosen_tool(), CELL);
        assert_eq!(r.drawing.len(), 1, "the hole was read as a second part");
        let p = &r.drawing[0];
        assert_eq!(
            p.inners.len(),
            1,
            "the hole did not reach the export — a plate drawn without its holes looks entirely \
             correct and is the wrong part"
        );
        let (x0, y0, x1, y1) = vert_bounds(&p.inners[0]);
        // A circle is encoded as TWO half-turn vertices, so its vertex bounds
        // are the horizontal diameter with zero height. Asserting the width is
        // the diameter is the check that the hole is the size it was drawn.
        assert!(
            (x0 - 140.0).abs() < 1e-6 && (x1 - 180.0).abs() < 1e-6,
            "the 40mm hole came back spanning {x0}..{x1}"
        );
        assert!(
            (y0 - 120.0).abs() < 1e-6 && (y1 - 120.0).abs() < 1e-6,
            "the hole's vertices are not on its centre line: {y0}..{y1}"
        );
        // And the OUTER is still the outer, with the hole nowhere in it.
        assert_eq!(p.outer.verts.len(), 4, "the outer boundary picked up the hole's vertices");
    }

    #[test]
    fn an_arc_keeps_its_bulge_and_is_not_silently_flattened() {
        // 🔴 The whole reason `DrawingVertex` carries a bulge. A flattened arc
        // measures SMALL, and there is nothing on screen to say by how much — a
        // wrong radius with no way to know it is wrong. If this test ever fails
        // because someone flattened the export, the fix is not to delete it: it
        // is to state the flattening tolerance in the exported data.
        let r = plan_report_import(RECT_WITH_HOLE_DXF, "dxf", &cfg_with_a_chosen_tool(), CELL);
        let hole = &r.drawing[0].inners[0];
        assert!(
            hole.verts.iter().any(|v| v.bulge.abs() > 1e-9),
            "the circle came back as {} straight segments — the arcs were flattened and the \
             tolerance was not stated",
            hole.verts.len()
        );
        // And the bulge means what the doc says it means. A half turn is
        // tan(180/4) = 1, so a two-vertex circle carries |bulge| == 1 on both.
        for v in &hole.verts {
            assert!(
                (v.bulge.abs() - 1.0).abs() < 1e-6,
                "a half-turn vertex carries bulge {} — the encoding changed under the doc that \
                 tells a consumer how to tessellate it",
                v.bulge
            );
        }
        // Radius recovered the way the doc says to recover it, from the chord
        // and the bulge alone. This is the arithmetic a viewport will do; if it
        // does not come back as the drawn 20mm, the doc is lying.
        let (a, b) = (hole.verts[0], hole.verts[1]);
        let theta = 4.0 * a.bulge.atan();
        let chord = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt();
        let radius = (chord / (2.0 * (theta / 2.0).sin())).abs();
        assert!((radius - 20.0).abs() < 1e-6, "recovered radius {radius}, drawn radius 20");
    }

    #[test]
    fn a_reference_fixture_reports_no_drawing_rather_than_an_invented_one() {
        // 🔴 The documented meaning of an empty `drawing`, pinned. A fixture is
        // constructed from code and has no file behind it, so the honest answer
        // is nothing — not the keep-regions dressed up as an import.
        let r = plan_report("plate", JobPlant::None, &JobConfig::default(), CELL).unwrap();
        assert!(r.ok, "{:?}", r.errors);
        assert!(
            r.drawing.is_empty(),
            "a code-built fixture claimed {} imported part(s)",
            r.drawing.len()
        );
    }

    #[test]
    fn a_refused_import_carries_no_drawing_and_says_why() {
        // Empty here must be distinguishable from empty above, and it is: this
        // one is not ok and names the reason.
        let r = plan_report_import("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n", "dxf",
            &cfg_with_a_chosen_tool(), CELL);
        assert!(!r.ok);
        assert!(r.drawing.is_empty());
        assert!(!r.errors.is_empty(), "an empty drawing came back with no reason");
    }

    #[test]
    fn a_cutting_move_carries_the_feed_the_post_emitted_for_it() {
        let r = plan_report_import(RECT_DXF, "dxf", &cfg_with_a_chosen_tool(), CELL);
        assert!(r.ok, "{:?}", r.errors);
        let emitted = feeds_in_gcode(&r.gcode);
        assert!(!emitted.is_empty(), "the program emitted no F word at all");

        let mut fed = 0usize;
        for m in &r.render {
            match m.kind.as_str() {
                "cut" | "tab" | "drill" => {
                    let f = m.feed.unwrap_or_else(|| {
                        panic!("a {} move carries no feed — a player cannot time it", m.kind)
                    });
                    // The post writes `F` to one decimal, so the match is to
                    // that tolerance and no looser. A "close enough" comparison
                    // here would pass for a nominal feed that was never emitted,
                    // which is the exact thing this test is for.
                    assert!(
                        emitted.iter().any(|e| (e - f).abs() <= 0.05),
                        "a {} move claims feed {f}, which is not one of the feeds the program \
                         emitted ({emitted:?}) — the export is reporting the plan's nominal, not \
                         the move's",
                        m.kind
                    );
                    fed += 1;
                }
                // 🔴 A G0 has no F word, so a rapid must report ABSENT rather
                // than a number. A rapid carrying a feed would be timed at
                // cutting speed by anything that trusts it.
                "rapid" | "change" | "probe" => assert!(
                    m.feed.is_none(),
                    "a {} move carries a feed the program never stated",
                    m.kind
                ),
                other => panic!("unknown render kind '{other}'"),
            }
        }
        assert!(fed > 0, "no cutting move was checked — this test proved nothing");

        // And more than one feed reaches the moves: a plunge is not a contour
        // feed. If this collapses to one value the export could be a constant
        // and every assertion above would still pass.
        let distinct: Vec<f64> = r.render.iter().filter_map(|m| m.feed).fold(
            Vec::new(),
            |mut acc: Vec<f64>, f| {
                if !acc.iter().any(|a| (a - f).abs() < 1e-9) {
                    acc.push(f);
                }
                acc
            },
        );
        assert!(
            distinct.len() > 1,
            "every move reports the same feed ({distinct:?}) — a per-move field that is really a \
             constant"
        );
    }

    #[test]
    fn a_tool_change_names_the_tool_and_nothing_else_carries_a_name() {
        // A fixture that actually changes tools, so `text` is exercised rather
        // than asserted about an empty set.
        let r = plan_report("plate", JobPlant::None, &JobConfig::default(), CELL).unwrap();
        assert!(r.tool_changes > 0, "this fixture no longer changes tools — pick another");
        let named: Vec<&String> = r
            .render
            .iter()
            .filter(|m| m.kind == "change")
            .filter_map(|m| m.text.as_ref())
            .collect();
        assert_eq!(
            named.len(),
            r.render.iter().filter(|m| m.kind == "change").count(),
            "a tool change reached the viewport without saying which tool to fit"
        );
        assert!(
            named.iter().all(|n| !n.is_empty()),
            "a tool change named the tool with an empty string, which renders as no name at all"
        );
        for n in &named {
            assert!(
                r.tools_used.iter().any(|t| &t == n),
                "a change asks for '{n}', which is not in tools_used {:?}",
                r.tools_used
            );
        }
        // 🔴 And the field stays OFF every other move. It is a String, and a
        // String per move on a 7,000-move program is the size cost this whole
        // struct is arranged to avoid.
        assert!(
            r.render.iter().filter(|m| m.kind != "change").all(|m| m.text.is_none()),
            "a move that is not a tool change is carrying a name"
        );
    }

    #[test]
    fn the_rapid_rate_travels_with_the_report_and_is_absent_when_no_job_ran() {
        // A G0 carries no F word, so without this a host timing playback would
        // have to invent a rapid rate — the defect this whole export exists to
        // prevent, one level up.
        let r = plan_report("plate", JobPlant::None, &JobConfig::default(), CELL).unwrap();
        assert_eq!(r.rapid_mm_min, Some(machine().rapid_mm_min));
        let refused = plan_report_import("not a dxf", "svg", &cfg_with_a_chosen_tool(), CELL);
        assert!(!refused.ok);
        assert!(
            refused.rapid_mm_min.is_none(),
            "a report with no job behind it stated a machine's rapid rate"
        );
    }

    #[test]
    fn the_tool_library_states_which_way_the_flutes_spiral() {
        // Up-cut lifts the chip and splinters the TOP face; down-cut presses
        // down and splinters the BOTTOM; compression exists to keep both clean.
        // The core has always known it per tool; until this shipped, every tool
        // in the UI read as "direction not stated".
        let lib: serde_json::Value =
            serde_json::from_str(&tool_library_json()).expect("tool library is not JSON");
        let tools = lib["tools"].as_array().expect("no tools array");
        assert!(!tools.is_empty());
        const KNOWN: [&str; 4] = ["straight", "up-cut", "down-cut", "compression"];
        for t in tools {
            let f = t["flute_type"]
                .as_str()
                .unwrap_or_else(|| panic!("tool {} carries no flute_type", t["id"]));
            assert!(KNOWN.contains(&f), "tool {} spells its flute type '{f}'", t["id"]);
        }
        // Not a constant: the library really does carry more than one, so a
        // hardcoded string would fail here rather than pass silently.
        let kinds: std::collections::BTreeSet<&str> =
            tools.iter().filter_map(|t| t["flute_type"].as_str()).collect();
        assert!(
            kinds.len() > 1,
            "every tool reports the same flute type ({kinds:?}) — the field is not being read \
             from the tool"
        );
        // And the machine-aware variant carries it too: a UI that declares a
        // collet must not lose a fact by asking the better question.
        let with_fit: serde_json::Value = serde_json::from_str(&tool_library_json_for(6.35, &[6.0]))
            .expect("tool library is not JSON");
        assert!(with_fit["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["flute_type"].is_string()));
    }
}

#[cfg(test)]
mod datum_invariance_tests {
    use super::*;

    /// Moving a workpiece on the machine cannot change what the program cuts RELATIVE TO
    /// THAT WORKPIECE — the geometry moves rigidly with the datum — so every
    /// simulation count must be identical at every datum.
    ///
    /// 🔴 This is the test that was missing, and its absence is why the defect
    /// shipped green: every fixture defaults to `origin_*_mm: 0.0`, where both
    /// halves of the bug are inert. Measured before the fix, on this fixture:
    /// 0 gouges at datum 0, **1027 at datum 150**, and **0 again at datum 300**.
    ///
    /// ⚠ The second zero is the dangerous one. At 300 the placed path and the
    /// unplaced regions no longer overlapped at all, so the check compared
    /// nothing and returned a green it never earned. A false red announces
    /// itself; a vacuous green is indistinguishable from a clean part.
    /// The same question for a DRAGGED PART rather than a moved workpiece.
    ///
    /// 🔴 It is the identical defect one term along. `plan_job` places the
    /// toolpath through `Job::place`; if `simulate_and_check` had stayed on
    /// `Stock::place` the regions would not have carried the drawing offset,
    /// and the verdict would move — a path checked against regions that stayed
    /// behind. MEASURED against that state (`built.job.place` reverted to
    /// `stock.place`, 2026-08-09): `(0, 0, 0)` clean and **4301 gouges** at a
    /// 50,25 drag on this fixture — the pasted red run is in the commit body.
    /// This test is what turns that into a red.
    fn counts_dragged(dx: f64, dy: f64) -> (usize, usize, usize) {
        let mut built = build("plate", JobPlant::None).expect("fixture");
        built.job.machine.travel_x_mm = 2000.0;
        built.job.machine.travel_y_mm = 2000.0;
        built.job.drawing_offset_x_mm = dx;
        built.job.drawing_offset_y_mm = dy;
        let r = crate::job::plan_job(&built.job);
        let (_, findings) = simulate_and_check(&built, &r.path, 0.6);
        let mut g = 0;
        let mut u = 0;
        let mut sp = 0;
        for f in &findings {
            match f {
                crate::sim::SimFinding::Gouge { .. } => g += 1,
                crate::sim::SimFinding::Uncut { .. } => u += 1,
                crate::sim::SimFinding::Spoilboard { .. } => sp += 1,
            }
        }
        (g, u, sp)
    }

    #[test]
    fn the_simulation_verdict_does_not_depend_on_where_the_part_was_dragged_to() {
        let home = counts_dragged(0.0, 0.0);
        for (dx, dy) in [(50.0, 25.0), (-30.0, 40.0), (200.0, 300.0)] {
            assert_eq!(
                counts_dragged(dx, dy),
                home,
                "dragging the part to {dx},{dy} on the workpiece changed the simulation verdict — \
                 the program cuts the same part wherever on the workpiece it is laid out"
            );
        }
    }

    fn counts_at(origin_x: f64, origin_y: f64, rotation_deg: f64) -> (usize, usize, usize) {
        let mut built = build("plate", JobPlant::None).expect("fixture");
        built.job.machine.travel_x_mm = 2000.0;
        built.job.machine.travel_y_mm = 2000.0;
        built.job.stock.origin_x_mm = origin_x;
        built.job.stock.origin_y_mm = origin_y;
        built.job.stock.rotation_deg = rotation_deg;
        let r = crate::job::plan_job(&built.job);
        let (_, findings) = simulate_and_check(&built, &r.path, 0.6);
        let mut g = 0;
        let mut u = 0;
        let mut sp = 0;
        for f in &findings {
            match f {
                crate::sim::SimFinding::Gouge { .. } => g += 1,
                crate::sim::SimFinding::Uncut { .. } => u += 1,
                crate::sim::SimFinding::Spoilboard { .. } => sp += 1,
            }
        }
        (g, u, sp)
    }

    #[test]
    fn the_simulation_verdict_does_not_depend_on_where_the_sheet_sits() {
        let at_origin = counts_at(0.0, 0.0, 0.0);
        for (dx, dy) in [(150.0, 0.0), (300.0, 0.0), (0.0, 220.0), (450.0, 380.0)] {
            assert_eq!(
                counts_at(dx, dy, 0.0),
                at_origin,
                "moving the workpiece to {dx},{dy} changed the simulation verdict;                  the program cuts the same part wherever the workpiece is clamped"
            );
        }
    }

    #[test]
    fn the_simulation_verdict_does_not_depend_on_how_the_sheet_is_turned() {
        let flat = counts_at(0.0, 0.0, 0.0);
        for deg in [90.0, 180.0, 270.0] {
            assert_eq!(
                counts_at(120.0, 90.0, deg),
                flat,
                "turning the workpiece {deg} degrees changed the simulation verdict"
            );
        }
    }

    /// 🔴 The control the two tests above need to mean anything: a check that
    /// became SILENT would satisfy "identical at every datum" perfectly. So a
    /// planted gouge must still be caught, and caught the SAME, wherever the
    /// workpiece is.
    #[test]
    fn a_planted_gouge_is_still_caught_at_every_datum() {
        let mut counts = Vec::new();
        for (dx, dy) in [(0.0, 0.0), (150.0, 0.0), (300.0, 220.0)] {
            let mut built = build("plate", JobPlant::Gouge).expect("fixture");
            built.job.machine.travel_x_mm = 2000.0;
            built.job.machine.travel_y_mm = 2000.0;
            built.job.stock.origin_x_mm = dx;
            built.job.stock.origin_y_mm = dy;
            let r = crate::job::plan_job(&built.job);
            let (_, findings) = simulate_and_check(&built, &r.path, 0.6);
            let g = findings
                .iter()
                .filter(|f| matches!(f, crate::sim::SimFinding::Gouge { .. }))
                .count();
            assert!(g > 100, "the planted gouge went unreported at datum {dx},{dy}");
            counts.push(g);
        }
        // ⚠ NOT exact equality here, and the reason is measured rather than
        // assumed: the map's cells are 0.6mm and the datum is not always a whole
        // number of cells, so which cells sample the edge of the gouge shifts by
        // one row. Observed 1658 / 1660 / 1660 — a 0.12% spread, entirely grid
        // PHASE.
        //
        // 🔴 The strong claim is made by the two tests above, where the clean
        // job's counts are EXACTLY equal at every datum. This test exists only
        // to prove the check did not go silent — because "identical at every
        // datum" is satisfied perfectly by a check that reports nothing, and
        // that is the failure this whole fix could have introduced.
        let lo = *counts.iter().min().unwrap() as f64;
        let hi = *counts.iter().max().unwrap() as f64;
        assert!(
            (hi - lo) / hi < 0.01,
            "the planted gouge was caught materially differently at different \
             datums: {counts:?} — a spread this large is not cell phase"
        );
    }

    /// 🔴 The control for the two invariance tests above, and the thing gate
    /// DINV is armed with.
    ///
    /// Those tests assert "the same answer at every datum". So does a harness
    /// that has stopped looking, and so does a harness that was never wrong in
    /// the first place — **a test that has never been watched failing proves
    /// nothing about the defect it was written for.** `JobPlant::BedAnchoredSim`
    /// restores the pre-fix harness exactly, and the invariance MUST break under
    /// it, including in the specific shape that made this ship green: a datum
    /// that reports **nothing** while another reports over a thousand cells,
    /// because at that datum the placed path and the workpiece-local regions had
    /// stopped overlapping at all.
    #[test]
    fn the_pre_fix_harness_still_breaks_the_invariance() {
        let mut counts = Vec::new();
        for (dx, dy) in [(0.0, 0.0), (50.0, 0.0), (150.0, 0.0), (300.0, 0.0)] {
            let mut built = build("plate", JobPlant::BedAnchoredSim).expect("fixture");
            built.job.machine.travel_x_mm = 2000.0;
            built.job.machine.travel_y_mm = 2000.0;
            built.job.stock.origin_x_mm = dx;
            built.job.stock.origin_y_mm = dy;
            let r = crate::job::plan_job(&built.job);
            let (_, findings) = simulate_and_check(&built, &r.path, 0.6);
            counts.push(
                findings
                    .iter()
                    .filter(|f| matches!(f, crate::sim::SimFinding::Gouge { .. }))
                    .count(),
            );
        }
        assert!(
            counts.iter().any(|&g| g > 500),
            "the bed-anchored plant reported no gouges anywhere ({counts:?}) — the negative \
             control for DINV is disarmed, so the invariance tests are vouching for nothing"
        );
        assert!(
            counts.iter().any(|&g| g == 0),
            "the bed-anchored plant never produced the VACUOUS GREEN ({counts:?}) — the \
             dangerous half of this defect is the datum where the check compares nothing and \
             reports clean, and the control must reproduce that, not only the false red"
        );
    }

    /// The DISPLAY half, which is a separate fact from the verdict and was the
    /// founder's original report: **the drawn surface did not move when the
    /// workpiece moved.**
    ///
    /// `StockSurface` is what a renderer positions the picture with, and its
    /// origin comes straight off the height map. While the map was nailed to the
    /// machine origin, that origin was `0,0` for every job at every datum — so a workpiece
    /// clamped at 137,42 was drawn at the machine origin, and an operator comparing
    /// the preview to the machine saw a part in the wrong place with nothing to
    /// say which of the two was lying.
    ///
    /// ⚠ Asserted at the ORIGIN AND at a height, not at the origin alone: an
    /// origin that follows the datum while the heights stay put would move the
    /// picture off its own data, which looks correct from one number.
    #[test]
    fn the_drawn_surface_moves_with_the_sheet() {
        let surface_of = |plant: JobPlant, dx: f64, dy: f64| {
            let cfg = JobConfig {
                machine: Some(MachineCfg {
                    travel_x_mm: Some(2000.0),
                    travel_y_mm: Some(2000.0),
                    ..Default::default()
                }),
                stock: Some(StockCfg {
                    origin_x_mm: Some(dx),
                    origin_y_mm: Some(dy),
                    ..Default::default()
                }),
                ..Default::default()
            };
            plan_report_with_surface("plate", plant, &cfg, 2.0, Some(2.0))
                .unwrap()
                .simulated_stock_surface
                .expect("the surface was asked for")
        };
        let surface = |dx: f64, dy: f64| surface_of(JobPlant::None, dx, dy);

        let at_zero = surface(0.0, 0.0);
        assert_eq!(
            (at_zero.origin_x_mm, at_zero.origin_y_mm),
            (0.0, 0.0),
            "a workpiece at the machine origin must draw at the machine origin"
        );

        for (dx, dy) in [(137.0, 42.0), (300.0, 0.0), (0.0, 220.0)] {
            let s = surface(dx, dy);
            assert_eq!(
                (s.origin_x_mm, s.origin_y_mm),
                (dx, dy),
                "the workpiece was clamped at {dx},{dy} and the drawn surface stayed at \
                 {},{} — the preview shows the part somewhere it will not be cut",
                s.origin_x_mm,
                s.origin_y_mm
            );
            assert_eq!(
                (s.cols, s.rows),
                (at_zero.cols, at_zero.rows),
                "moving the workpiece resized the drawn surface — the same workpiece was drawn at \
                 two different sizes"
            );
            // The picture must carry its data with it, not just its label.
            assert_eq!(
                heights(&s).iter().filter(|z| **z < -1e-6).count(),
                heights(&at_zero).iter().filter(|z| **z < -1e-6).count(),
                "the same program removed a different number of cells at datum {dx},{dy} — \
                 an origin that follows the datum while the heights do not is a picture \
                 moved off its own data"
            );
        }

        // 🔴 The control: the same assertion against the pre-fix harness, which
        // pinned the map — and therefore the drawn surface — to the machine origin.
        // Without this the test above is only claiming that a number equals
        // itself, and nobody would know whether it could ever have failed.
        let pinned = surface_of(JobPlant::BedAnchoredSim, 137.0, 42.0);
        assert_eq!(
            (pinned.origin_x_mm, pinned.origin_y_mm),
            (0.0, 0.0),
            "the bed-anchored control did NOT pin the drawn surface to the machine origin — the \
             assertion above is vouching for nothing"
        );
    }

    fn heights(s: &StockSurface) -> Vec<f32> {
        super::stock_surface_tests::unb64(&s.z_mm_b64)
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }
}

#[cfg(test)]
mod per_move_tool_tests {
    use super::*;

    /// Cells the simulation shows as cut, for ONE program.
    ///
    /// ⚠ Takes the path by value and does NOT re-plan. The first version of this
    /// helper re-planned the job with every operation forced onto one tool, which
    /// changes the TOOLPATH — offsets, stepover, lead-ins — as well as the radius.
    /// It therefore stayed green with the per-move radius removed: it proved the
    /// planner is sensitive to tool choice, which was never in doubt.
    fn removed_cells(built: &BuiltJob, path: crate::types::Toolpath) -> usize {
        let (hm, _) = simulate_and_check(built, &path, 0.6);
        hm.z.iter().filter(|z| **z < -0.001).count()
    }

    /// 🔴 A multi-tool program must NOT simulate like a single-tool one.
    ///
    /// `Toolpath` carries ONE `tool`; the simulation lowers every cell within
    /// `radius` of a move, so the radius IS the geometry of material removal.
    /// Before the per-move stamp, the whole program was simulated at
    /// `path.tool`'s radius — on `multi-tool` that is the **3.175mm** cutter,
    /// while the outer profile is cut with a **6mm** one. Every profile cut was
    /// modelled at half its true width.
    ///
    /// ⚠ That fails in the UNSAFE direction: material the real cutter removes was
    /// left standing in the model, so a gouge that genuinely happens can be MISSING
    /// from the counts an operator trusts — unlike the cell-size blur, which
    /// over-reports removal and is therefore safe.
    ///
    /// Both runs share ONE planned path and differ only in whether the per-move
    /// radius is present, so nothing but `radius_of` can move the number.
    #[test]
    fn the_simulation_reads_the_radius_off_the_move_not_off_the_toolpath() {
        let mut built = build("multi-tool", JobPlant::None).expect("fixture");
        built.job.machine.travel_x_mm = 2000.0;
        built.job.machine.travel_y_mm = 2000.0;
        let path = crate::job::plan_job(&built.job).path;

        // The same program with the stamps erased — the pre-fix behaviour exactly:
        // every move falls back to `path.tool`.
        let mut unstamped = path.clone();
        for m in &mut unstamped.moves {
            m.tool_r_mm = 0.0;
        }

        let stamped = removed_cells(&built, path);
        let fallback = removed_cells(&built, unstamped);
        assert!(
            stamped > fallback,
            "one path simulated two ways removed {stamped} cells with per-move radii and \
             {fallback} with the toolpath's single tool — equal means the wider cutter's \
             material is standing in the model"
        );
    }

    /// The stamp must actually be on the moves, not merely available: an
    /// unstamped move silently falls back to the toolpath's tool, which is the
    /// behaviour this whole change exists to end.
    #[test]
    fn every_cutting_move_carries_the_radius_of_the_tool_that_makes_it() {
        let built = build("multi-tool", JobPlant::None).expect("fixture");
        let r = crate::job::plan_job(&built.job);
        let cutting: Vec<&crate::types::Move> = r
            .path
            .moves
            .iter()
            .filter(|m| {
                matches!(
                    m.kind,
                    crate::types::MoveKind::Feed
                        | crate::types::MoveKind::ArcCW
                        | crate::types::MoveKind::ArcCCW
                        | crate::types::MoveKind::DrillCycle
                )
            })
            .collect();
        assert!(!cutting.is_empty(), "the fixture emitted no cutting moves");
        assert!(
            cutting.iter().all(|m| m.tool_r_mm > 0.0),
            "{} of {} cutting moves carry no cutter radius and would fall back to the \
             toolpath's single tool",
            cutting.iter().filter(|m| m.tool_r_mm <= 0.0).count(),
            cutting.len()
        );
        // And the job genuinely uses more than one, or the test proves nothing.
        let mut radii: Vec<String> = cutting.iter().map(|m| format!("{:.3}", m.tool_r_mm)).collect();
        radii.sort();
        radii.dedup();
        assert!(radii.len() >= 2, "the multi-tool fixture used one radius: {radii:?}");
    }
}

/// Tool selection — the cutter is CHOSEN or the job is REFUSED.
///
/// 🔴 What these guard, physically: a program whose feeds, depth per pass, pass
/// count, ramp lengths, tab heights and collet check were all derived from a
/// cutter that is not in the spindle. It renders correctly, it posts, it
/// downloads and it cuts — with the wrong chipload into an 18mm workpiece at a
/// depth the real tool cannot take. Until 2026-08-09 that program was emitted
/// silently for BOTH an absent `tool_id` and an unresolvable one.
#[cfg(test)]
mod tool_selection_tests {
    use super::*;

    const CELL: f64 = 2.0;
    /// A closed rectangle, held OFF the origin on purpose: an outside profile
    /// offsets by the tool radius, so a part with a corner at (0,0) puts the
    /// cutter centre at -3 and is refused for travel — a true refusal about the
    /// wrong thing, which would make every "it plans" assertion below pass or
    /// fail for a reason that has nothing to do with tool selection.
    const RECT: &str = "0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n\
                        10\n20.0\n20\n20.0\n10\n100.0\n20\n20.0\n10\n100.0\n20\n70.0\n\
                        10\n20.0\n20\n70.0\n0\nENDSEC\n0\nEOF\n";

    fn cfg(json: &str) -> JobConfig {
        serde_json::from_str(json).expect("test config")
    }

    fn import(c: &JobConfig) -> Report {
        plan_report_import(RECT, "dxf", c, CELL)
    }

    /// The whole point, stated once: a refusal is not a warning above a program.
    fn assert_refused_with_no_program(r: &Report, key: &str) {
        assert!(!r.ok, "the job reported ok with no usable tool");
        assert!(
            r.gcode.is_empty(),
            "REFUSED and still emitted {} bytes of G-code — a file that exists gets run",
            r.gcode.len()
        );
        assert!(
            r.refusals.iter().any(|x| x.contains(key)),
            "no refusal contained {key:?}; refusals were {:?}",
            r.refusals
        );
    }

    #[test]
    fn an_import_with_no_tool_at_all_is_refused_and_emits_nothing() {
        assert_refused_with_no_program(&import(&JobConfig::default()), NO_TOOL_SELECTED_KEY);
    }

    #[test]
    fn an_import_with_an_unresolvable_tool_id_is_refused_and_emits_nothing() {
        let r = import(&cfg(r#"{"tool_id":"endmill-6"}"#));
        assert_refused_with_no_program(&r, UNKNOWN_TOOL_KEY);
        // The id the operator typed is quoted back. "Not found" without it sends
        // them to try the same string again.
        assert!(r.refusals[0].contains("endmill-6"), "{}", r.refusals[0]);
    }

    /// 🔴 The pair that must not merge. "You chose nothing" and "what you chose
    /// does not exist" have different fixes — the picker vs the spelling — and a
    /// shared message sends half of the operators to the wrong one.
    #[test]
    fn the_absent_and_the_unresolvable_refusals_are_told_apart() {
        let absent = import(&JobConfig::default()).refusals[0].clone();
        let unknown = import(&cfg(r#"{"tool_id":"endmill-6"}"#)).refusals[0].clone();
        assert_ne!(absent, unknown);
        // Not merely different text: neither carries the other's key, so a host
        // or a gate keying on one cannot match the other.
        assert!(!absent.contains(UNKNOWN_TOOL_KEY), "{absent}");
        assert!(!unknown.contains(NO_TOOL_SELECTED_KEY), "{unknown}");
    }

    /// The browser's shape of "nothing chosen": `App.tsx` sends
    /// `toolIds[0] ?? ''`, so an empty picker arrives as `tool_id: ""`. That is
    /// an ABSENT choice; answering it with "'' is not a tool in the library"
    /// would be true and useless.
    #[test]
    fn an_empty_tool_id_is_absent_not_unresolvable() {
        assert_refused_with_no_program(&import(&cfg(r#"{"tool_id":""}"#)), NO_TOOL_SELECTED_KEY);
        assert_refused_with_no_program(
            &import(&cfg(r#"{"tool_id":"   ","tool_ids":["",""]}"#)),
            NO_TOOL_SELECTED_KEY,
        );
    }

    #[test]
    fn a_chosen_tool_still_plans_a_program() {
        let r = import(&cfg_with_a_chosen_tool());
        assert!(r.ok, "refusals: {:?} errors: {:?}", r.refusals, r.errors);
        assert!(!r.gcode.is_empty());
        assert_eq!(r.tools_used, vec![TEST_TOOL_ID.to_string()]);
    }

    /// A SET and no single id: the operations are built with the first cutter of
    /// the set that resolves — one the operator selected — and never invented.
    #[test]
    fn a_tool_set_with_no_singular_id_still_plans() {
        let r = import(&cfg(r#"{"tool_ids":["End Mill - Down-cut 6mm 2F"]}"#));
        assert!(r.ok, "refusals: {:?}", r.refusals);
        assert!(!r.gcode.is_empty());
    }

    #[test]
    fn a_tool_set_in_which_nothing_resolves_is_refused_and_emits_nothing() {
        assert_refused_with_no_program(
            &import(&cfg(r#"{"tool_ids":["endmill-6","drill-4"]}"#)),
            UNKNOWN_TOOL_KEY,
        );
    }

    /// ⚠ The bug the substitution was MASKING. The import path resolved against
    /// a bare `default_library()`, so a shop tool declared in `extra_tools` was
    /// not found there and fell into the Ø6mm substitute; `apply` then corrected
    /// the operations further down, so nothing was visibly wrong. Refusing
    /// against that narrower list would have broken a legitimate flow instead of
    /// fixing anything, which is why both sites now share `merged_library`.
    #[test]
    fn a_shop_tool_from_extra_tools_resolves_on_the_import_path() {
        let r = import(&cfg(
            r#"{"extra_tools":[{"id":"Shop 6mm 1F","category":"End Mill","diameter_mm":6.0,
                "flutes":1,"cutting_length_mm":25.0,"shank_mm":6.0,"chipload_mm":0.1,
                "chipload_min_mm":0.05,"chipload_max_mm":0.2,"rpm_min":10000,"rpm_max":24000}],
                "tool_id":"Shop 6mm 1F"}"#,
        ));
        assert!(r.ok, "refusals: {:?} notes: {:?}", r.refusals, r.notes);
        assert_eq!(r.tools_used, vec!["Shop 6mm 1F".to_string()]);
    }

    /// An `extra_tools` entry that was REJECTED is legitimately absent from the
    /// library, so selecting it is genuinely unresolvable — and the note saying
    /// why it was rejected must ride along, or the refusal is unanswerable.
    #[test]
    fn a_rejected_extra_tool_refuses_and_says_why_it_is_missing() {
        let r = import(&cfg(
            r#"{"extra_tools":[{"id":"Bad","category":"Sonic Screwdriver","diameter_mm":6.0,
                "flutes":2,"cutting_length_mm":25.0,"shank_mm":6.0,"chipload_mm":0.1,
                "chipload_min_mm":0.05,"chipload_max_mm":0.2,"rpm_min":10000,"rpm_max":24000}],
                "tool_id":"Bad"}"#,
        ));
        assert_refused_with_no_program(&r, UNKNOWN_TOOL_KEY);
        assert!(
            r.notes.iter().any(|n| n.contains("Bad") && n.contains("NOT added")),
            "the refusal did not carry the reason the tool is missing: {:?}",
            r.notes
        );
    }

    /// A typo gets somewhere to go. Being told only "not found" is how an
    /// operator retypes the same string.
    #[test]
    fn an_unresolvable_id_is_offered_the_nearest_ones() {
        let why = import(&cfg(r#"{"tool_id":"endmill-6"}"#)).refusals[0].clone();
        assert!(why.contains("End Mill"), "no nearest id was offered: {why}");
        // ...and not everything. A shortlist that is the whole library is a wall
        // of text nobody reads.
        assert!(!why.contains("Drill - Brad Point"), "the shortlist was not short: {why}");
    }

    // --- the SIBLING site: JobConfig::apply, on the fixture path -------------

    /// This one shipped emitting **11,978 bytes** at exit 0 on a cutter nobody
    /// chose, because the lookup was an `if let` with no `else`.
    #[test]
    fn a_fixture_job_with_an_unresolvable_tool_id_is_refused_and_emits_nothing() {
        let r = plan_report("plate", JobPlant::None, &cfg(r#"{"tool_id":"endmill-6"}"#), CELL)
            .expect("plate");
        assert_refused_with_no_program(&r, UNKNOWN_TOOL_KEY);
    }

    /// 🔴 THE NEGATIVE CONTROL, asserted here as well as in gate TOOL. The plant
    /// must genuinely restore the defect — a plant that quietly stopped planting
    /// is indistinguishable from a clean codebase, and gate TOOL's red would
    /// then be unwatchable.
    #[test]
    fn the_plant_restores_the_substitution_so_the_control_is_not_blind() {
        let r = plan_report(
            "plate",
            JobPlant::ToolSubstitute,
            &cfg(r#"{"tool_id":"endmill-6"}"#),
            CELL,
        )
        .expect("plate");
        assert!(r.ok, "the plant did not reintroduce the defect: {:?}", r.refusals);
        assert!(!r.gcode.is_empty(), "the plant emitted no program, so it plants nothing");
        assert!(r.refusals.is_empty());
    }

    /// 🔴 THE ORDERING TRAP. `assign_tools_from_set` does
    /// `job.tool_set_refusals = out.refusals.clone()` — an assignment, not an
    /// extend — so a refusal pushed BEFORE it is silently deleted by a config
    /// that also carries `tool_ids`. The refusal is therefore pushed after.
    /// Without this test the fix passes everything else and evaporates on the
    /// one config that combines both fields.
    #[test]
    fn an_unresolvable_tool_id_survives_a_valid_tool_set_in_the_same_config() {
        let r = plan_report(
            "plate",
            JobPlant::None,
            &cfg(
                r#"{"tool_id":"endmill-6",
                    "tool_ids":["End Mill - Down-cut 6mm 2F","Drill - Brad Point 4mm 2F"]}"#,
            ),
            CELL,
        )
        .expect("plate");
        assert_refused_with_no_program(&r, UNKNOWN_TOOL_KEY);
    }

    /// 🔴 The `two-part` fixture exists to make `--plant release-order`
    /// non-vacuous, and this asserts BOTH halves of that — because the half
    /// everyone remembers to write is the one that cannot fail.
    ///
    /// * Unplanted, it must genuinely exercise the group reorder. A fixture that
    ///   stopped doing so (a nest tweak, a tool change) would leave gate REL's
    ///   plant neutering a sort that never fires — a control that runs clean and
    ///   reads as passing.
    /// * Planted, it must be REFUSED with no program, and the refusal must name
    ///   the released part and the interior features stranded behind it.
    #[test]
    fn the_two_part_fixture_exercises_the_reorder_and_the_plant_reverses_it() {
        let clean = plan_report("two-part", JobPlant::None, &JobConfig::default(), CELL)
            .expect("two-part");
        assert!(clean.ok, "refused: {:?}", clean.refusals);
        assert!(
            clean.notes.iter().any(|n| n.contains("tool groups reordered")),
            "the fixture no longer exercises the reorder, so the plant on it is vacuous: {:?}",
            clean.notes
        );

        let planted = plan_report("two-part", JobPlant::ReleaseOrder, &JobConfig::default(), CELL)
            .expect("two-part planted");
        assert!(
            planted.notes.iter().any(|n| n.contains("planted-difference: YES")),
            "the plant did not change the group order on the one fixture built for it: {:?}",
            planted.notes
        );
        assert!(!planted.ok, "the planted job was runnable");
        assert!(planted.gcode.is_empty(), "a refused job emitted {}B", planted.gcode.len());
        assert!(
            planted
                .refusals
                .iter()
                .any(|r| r.starts_with("drilled:") && r.contains("drilled-hole1")),
            "the refusal must name the part and what was stranded: {:?}",
            planted.refusals
        );
    }

    /// 🔴 ONE DOOR, ASSERTED AT THE EMITTED PROGRAM — the unit-test half of gate
    /// `DOOR`, which measured 66 of 306 (fixture x single tool) pairs disagreeing
    /// before the collapse of 2026-08-11.
    ///
    /// ⚠ **`ok` is not enough and neither is a line count.** The 12 divergences
    /// this lane first called benign had the SAME verdict and the SAME number of
    /// lines and differed only in `M3 S18000`/`F3600.0` against
    /// `M3 S24000`/`F4800.0`. So this compares BYTES, and asserts a REFUSING
    /// pair and an EMITTING pair — a comparison that can only come out equal
    /// when both sides refuse proves nothing about the door that emits.
    ///
    /// The gate sweeps the whole 51-tool library; this is the fast guard that
    /// travels with the code, and it names the tools that produced each class.
    #[test]
    fn a_single_tool_id_and_a_one_element_tool_ids_are_the_same_door() {
        let one = |field: &str, id: &str| {
            let json = if field == "tool_id" {
                format!(r#"{{"tool_id":"{id}"}}"#)
            } else {
                format!(r#"{{"tool_ids":["{id}"]}}"#)
            };
            plan_report("plate", JobPlant::None, &cfg(&json), CELL).expect("plate")
        };
        // (a) A pair where both doors EMIT. `socket`/`clamped`/`plate` on the
        // 6mm class is where the two feeds and two spindle speeds lived.
        let s = one("tool_id", "End Mill - Down-cut 6mm 2F");
        let m = one("tool_ids", "End Mill - Down-cut 6mm 2F");
        assert!(s.ok && m.ok, "this half must EMIT through both doors or it proves nothing");
        assert_eq!(s.gcode, m.gcode, "the two doors emit different programs for one cutter");
        assert!(
            s.gcode.contains("S24000") && s.gcode.contains("F4800.0"),
            "the surviving door is not the one that derives feeds from the cutter"
        );

        // (b) A pair where both doors REFUSE, and the dangerous direction: a
        // DRILL asked to cut a profile. `tool_id` used to emit 498 lines of
        // profile contours cut with a brad point.
        let s = one("tool_id", "Drill - Brad Point 6mm 2F");
        let m = one("tool_ids", "Drill - Brad Point 6mm 2F");
        assert!(!s.ok, "a drill still emits a profile through the singular door");
        assert!(!m.ok);
        assert!(s.gcode.is_empty() && m.gcode.is_empty());
        assert_eq!(s.refusals, m.refusals, "the two doors refuse for different reasons");

        // (c) The direction that stopped the singular door being dismissed as
        // "the one that skips checks": it REFUSED a Ø6mm hole a Ø6mm cutter
        // should simply drill, because it moved the tool without re-deciding
        // Profile->Drill. Both doors must now emit.
        let two = |field: &str| {
            let json = if field == "tool_id" {
                r#"{"tool_id":"End Mill - Down-cut 6mm 2F"}"#
            } else {
                r#"{"tool_ids":["End Mill - Down-cut 6mm 2F"]}"#
            };
            plan_report("two-part", JobPlant::None, &cfg(json), CELL).expect("two-part")
        };
        let s = two("tool_id");
        let m = two("tool_ids");
        assert!(s.ok, "the singular door still refuses a hole its own cutter can drill");
        assert_eq!(s.gcode, m.gcode);
    }

    /// 🔴 The plant is a knob, not a defect: on a job whose first-appearance
    /// order is already safe it must plant NOTHING and say so. Measured across
    /// the five reference fixtures on 2026-08-09 — every one of them reports
    /// `NO`, which is exactly why `two-part` had to be written before the plant
    /// could be registered.
    ///
    /// ⚠ **POLARITY INVERTED 2026-08-12, and the inversion IS the fix** — the
    /// last assertion used to read `assert!(r.ok, …)`, i.e. *a plant that
    /// changed nothing still emits a program*. That is the behaviour
    /// [`plant_audit`] exists to end: a vacuous plant emitted a runnable program
    /// under a `PLANTED:` note, and a gate reading that run could not tell it
    /// from an armed one. The knob claim is unchanged and still asserted — the
    /// route note must still say `NO` — but a run whose plant is not in force is
    /// now REFUSED, so the test is inverted rather than deleted.
    #[test]
    fn the_release_order_plant_is_vacuous_on_every_reference_fixture_and_says_so() {
        for (name, _) in JOBS {
            if *name == "two-part" {
                continue;
            }
            let r = plan_report(name, JobPlant::ReleaseOrder, &JobConfig::default(), CELL)
                .unwrap_or_else(|| panic!("{name} did not build"));
            assert!(
                r.notes.iter().any(|n| n.contains("planted-difference: NO")),
                "{name}: the plant must state it changed nothing here: {:?}",
                r.notes
            );
            assert!(
                !r.ok && r.gcode.is_empty(),
                "{name}: a plant that changed nothing still emitted a program — the announcement \
                 would be read as an armed control"
            );
            assert!(
                r.refusals.iter().any(|x| x.contains(PLANT_DISARMED_KEY)),
                "{name}: refused, but not for the plant being inert: {:?}",
                r.refusals
            );
        }
    }

    /// The five reference fixtures name no tool and must be untouched: they
    /// build their own cutters in Rust, so "no `tool_id`" is not an undeclared
    /// choice there. They are covered by an explicit assertion rather than by an
    /// exemption in the refusing code, which would have re-opened the hole.
    #[test]
    fn every_reference_fixture_still_plans_without_naming_a_tool() {
        for (name, _) in JOBS {
            let r = plan_report(name, JobPlant::None, &JobConfig::default(), CELL)
                .unwrap_or_else(|| panic!("{name} did not build"));
            assert!(r.ok, "{name} was refused: {:?}", r.refusals);
            assert!(!r.gcode.is_empty(), "{name} emitted no program");
        }
    }
}

#[cfg(test)]
mod precision_reaches_the_report_tests {
    use super::*;

    /// 🔴 `sim::precision_tests` asserts what `Precision::notes()` SAYS. Nothing
    /// asserted that those sentences reach a `Report`, and that gap is not
    /// hypothetical — the wiring was written on 2026-08-09, lost to a bare
    /// `git stash` on the shared tree, and rebuilt from the stash object. While
    /// it was missing the CLI printed the counts with NO caveat at all and every
    /// test stayed green, because each half was tested and the JOIN was not.
    ///
    /// The physical claim: `gouge/uncut/spoilboard` are cell counts at a chosen
    /// resolution with a different error direction each, and three bare integers
    /// read as a measurement of the part.
    #[test]
    fn the_precision_caveats_reach_the_report_not_just_the_precision_struct() {
        let built = build("plate", JobPlant::None).expect("fixture");
        let r = report_of(&built, 0.6);

        let joined = r.notes.join("\n");
        for needle in [
            "height map at",          // the resolution
            "COUNTS OF CELLS",        // what the integers actually are
            "no single conservative", // the direction finding
        ] {
            assert!(
                joined.contains(needle),
                "the report's notes never say {needle:?} — the simulation's precision \
                 did not travel with the numbers it qualifies. Notes were: {:#?}",
                r.notes
            );
        }
    }

    /// The surface carries its own caveat, because a consumer that DRAWS the
    /// array may never read `Report::notes` — the browser renders the surface in
    /// a viewport and the notes in a different panel.
    #[test]
    fn the_drawn_surface_carries_its_own_note_and_both_cell_sizes() {
        let built = build("plate", JobPlant::None).expect("fixture");
        // Ask for a display cell COARSER than the simulation, which is the case
        // that dilates a hole and the reason the note exists.
        let r = report_of_with_surface(&built, 0.6, Some(3.0));
        let s = r.simulated_stock_surface.expect("a surface was requested");

        assert!(s.cell_mm > s.sim_cell_mm, "cell {} sim {}", s.cell_mm, s.sim_cell_mm);
        assert!(
            s.note.contains("oversize") || s.note.contains("CELL GRID"),
            "the drawn surface says nothing about being oversize or square-cornered: {:?}",
            s.note
        );
    }
}

/// **Audit finding B4 at the REPORT** — `uncut: 0` reaching a host as a
/// measurement on a job where the check could not run.
///
/// 🔴 `sim::uncut_coverage_tests` proves the core knows. These prove it TRAVELS:
/// the flag, the evidence and the sentence all arrive on the `Report` a host
/// actually reads. That join is exactly what was missing when the precision
/// caveats were written and then lost — each half tested, the join not.
///
/// ⚠ **The import limb here is a statement about what the intake CAN know, and it
/// is deliberately not "fixed".** A drawing's interior loop is not evidence of a
/// pocket: `toolpath::operations_for_part` cuts every inner loop as a
/// through-depth `CutSide::Inside` profile, `OpType::Pocket` is constructed
/// nowhere in this repo, and `import.rs` reads no layer, depth or attribute that
/// could tell a pocket floor from a slug that drops free. Declaring those loops
/// as removal regions would invent thousands of `Uncut` cells about material the
/// program was never asked to clear — a fabricated finding is worse than the
/// silence it replaces, so this ships the PENDING.
#[cfg(test)]
mod uncut_pending_reaches_the_report_tests {
    use super::multi_drawing_tests::cfg;
    use super::*;

    /// A 200x120 plate with a 60x60 window in it. The window is the shape an
    /// operator would call a pocket and the shape the CAM cuts as a drop-out, and
    /// nothing in the file distinguishes the two — which is the whole finding.
    fn plate_with_window_dxf() -> Vec<u8> {
        let mut s = String::from("0\nSECTION\n2\nENTITIES\n");
        for (x, y, w, h) in [(50.0, 50.0, 200.0, 120.0), (120.0, 90.0, 60.0, 60.0)] {
            s.push_str("0\nLWPOLYLINE\n70\n1\n");
            for (px, py) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)] {
                s.push_str(&format!("10\n{px:.1}\n20\n{py:.1}\n"));
            }
        }
        s.push_str("0\nENDSEC\n0\nEOF\n");
        s.into_bytes()
    }

    #[test]
    fn an_imported_drawing_reports_uncut_as_pending_and_says_why() {
        let d = plate_with_window_dxf();
        let r = plan_report_import_bytes(&d, "dxf", None, &cfg(), 0.6);
        assert!(r.ok, "the drawing did not plan: {:?} {:?}", r.errors, r.refusals);
        // The drawing really does carry the interior loop, or this test is about
        // a plate with nothing in it and proves nothing about the interesting case.
        assert_eq!(r.drawing.len(), 1, "{:?}", r.drawing.len());
        assert_eq!(r.drawing[0].inners.len(), 1, "the window was not imported as an interior loop");

        assert_eq!(r.sim.uncut, 0, "the count itself is unchanged — only its status is new");
        assert!(
            !r.sim.uncut_checked,
            "an imported job claimed the UNCUT check ran; it has no removal region to run on"
        );
        assert_eq!(r.sim.uncut_cells_tested, 0);
        let why = r.sim.uncut_pending_reason.as_deref().expect("PENDING must carry its reason");
        assert!(why.contains("CLEARED"), "the reason does not name what was missing: {why}");

        // And the sentence reaches the notes, for the host that renders integers
        // and ignores a new boolean.
        assert!(
            r.notes.iter().any(|n| n.contains("UNCUT IS NOT MEASURED")),
            "the report's notes never say the count is unmeasured: {:#?}",
            r.notes
        );
    }

    /// 🔴 THE NEGATIVE CONTROL. Without it, hard-wiring `uncut_checked = false`
    /// passes the test above — and would silence gate P2, the one place this
    /// check does real work today.
    #[test]
    fn the_pocket_fixture_still_reports_a_measured_uncut() {
        let r = plan_report("pocket", JobPlant::None, &JobConfig::default(), 0.6)
            .expect("the pocket fixture");
        assert!(
            r.sim.uncut_checked,
            "the ONE job with a declared removal region reported PENDING: {:?}",
            r.sim
        );
        assert!(r.sim.uncut_cells_tested > 100, "only {} cells tested", r.sim.uncut_cells_tested);
        assert_eq!(r.sim.uncut_pending_reason, None);
        assert!(
            !r.notes.iter().any(|n| n.contains("UNCUT IS NOT MEASURED")),
            "a job whose check DID run was labelled unmeasured"
        );
    }

    /// The other half of the control: the plant P2 fires on must still produce a
    /// measured, non-zero count. A PENDING here would take the gate's teeth out.
    #[test]
    fn the_outline_only_plant_still_reports_a_measured_and_non_zero_uncut() {
        let r = plan_report("pocket", JobPlant::OutlineOnly, &JobConfig::default(), 0.6)
            .expect("the pocket fixture");
        assert!(r.sim.uncut_checked, "{:?}", r.sim);
        assert!(r.sim.uncut > 0, "the outlined pocket left no island: {:?}", r.sim);
    }

    /// 🔴 THE RESIDUAL CHECK RUNS IN PRODUCTION, AND ONLY SINCE 2026-09-07.
    ///
    /// `pocket::residual_island_mm` is documented in its own module as *"the
    /// check that catches outlined, not cleared"*, and that module's header
    /// names the defect as the reason the module exists. Its only callers were
    /// two unit tests: the net existed, was documented, had a negative control,
    /// and was never attached to the one production caller.
    ///
    /// ⚠ Both directions, because the plant alone would not prove it is not
    /// simply always on — and a check that fires on a legitimate pocket is a
    /// false red, which is the failure that looks like diligence.
    #[test]
    fn the_production_path_reports_an_uncleared_pocket_and_stays_silent_on_a_cleared_one() {
        const NOTE: &str = "POCKET NOT CLEARED";

        let planted = plan_report("pocket", JobPlant::OutlineOnly, &JobConfig::default(), 0.6)
            .expect("the pocket fixture");
        assert!(
            planted.notes.iter().any(|n| n.contains(NOTE)),
            "the outline-only plant left an island and production said nothing: {:?}",
            planted.notes
        );

        let clean = plan_report("pocket", JobPlant::None, &JobConfig::default(), 0.6)
            .expect("the pocket fixture");
        assert!(
            !clean.notes.iter().any(|n| n.contains(NOTE)),
            "a properly cleared pocket was reported as uncleared — a false red: {:?}",
            clean.notes
        );
    }

    #[test]
    fn a_refused_import_reports_uncut_as_pending_rather_than_three_clean_zeros() {
        let r = plan_report_import_bytes(b"this is not a drawing", "dxf", None, &cfg(), 0.6);
        assert!(!r.ok, "the garbage file planned a program");
        assert!(!r.sim.uncut_checked);
        assert!(
            r.sim.uncut_pending_reason.as_deref().unwrap_or_default().contains("REFUSED"),
            "{:?}",
            r.sim.uncut_pending_reason
        );
    }
}

/// **A REFUSAL MUST CARRY THE FACTS IT HOLDS** — the datum, the workpiece, and the
/// geometry it had already placed.
///
/// 🔴 The defect these are armed against was an OMISSION, which is why every one
/// of them asserts against the PLANNED report rather than against a literal:
/// `refused_import_report` returned the identity placement, an empty drawing and
/// a hard-coded `600x900x18` workpiece, and the symptom on the founder's page was
/// that the numbers in the panel moved while the object stood at the machine
/// origin. A test comparing a refused report to a constant would go green again
/// the day the planned path's transform changed; a test comparing the two
/// reports cannot.
///
/// ⚠ **These read the REPORT, not the emitted program, and that is not this
/// lane's usual rule — it is the exception the subject demands.** A refused plan
/// HAS no program. The report *is* the artefact, because it is the only thing a
/// host can draw, and drawing it is the whole failure.
#[cfg(test)]
mod refusal_carries_the_datum_tests {
    use super::multi_drawing_tests::{cfg, rect_dxf, src};
    use super::*;

    /// The same config twice: once with a cutter, once without. Everything else
    /// — datum, rotation, drawing offset, workpiece — is identical, so the ONLY
    /// difference between the two reports is the refusal.
    fn pair(stock: StockCfg, drawing_offset: Option<[f64; 2]>) -> (Report, Report) {
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let base = JobConfig {
            machine: Some(MachineCfg {
                travel_x_mm: Some(2000.0),
                travel_y_mm: Some(2000.0),
                ..MachineCfg::default()
            }),
            stock: Some(stock),
            drawing_offset,
            ..JobConfig::default()
        };
        let with_tool = JobConfig { tool_id: Some(TEST_TOOL_ID.into()), ..base.clone() };
        (
            plan_report_import_bytes(&d, "dxf", None, &base, 2.0),
            plan_report_import_bytes(&d, "dxf", None, &with_tool, 2.0),
        )
    }

    /// 🔴 THE FOUNDER'S CASE, at the numbers he was measured at.
    #[test]
    fn a_refused_import_reports_the_datum_it_was_given_not_the_identity() {
        let (refused, planned) = pair(
            StockCfg { origin_x_mm: Some(37.0), origin_y_mm: Some(11.0), ..StockCfg::default() },
            None,
        );
        assert!(!refused.ok, "the tool-less import planned a program");
        assert!(planned.ok, "{:?} {:?}", planned.errors, planned.refusals);

        assert_eq!(
            (refused.drawing_placement.dx_mm, refused.drawing_placement.dy_mm),
            (37.0, 11.0),
            "the refused report put the datum at the machine origin: {:?}",
            refused.drawing_placement
        );
        assert!(
            !refused.drawing_placement.is_identity(),
            "a datum of 37,11 came back as the identity transform"
        );
        assert_eq!(
            refused.drawing_placement, planned.drawing_placement,
            "the refused workpiece and the planned workpiece disagree about where the drawing goes"
        );
    }

    /// The awkward half: a turned workpiece and a dragged part. The push-back a
    /// rotation applies depends on the WORKPIECE SIZE, so this is also the test that
    /// would go red if the refused report went back to inventing `600x900`.
    #[test]
    fn a_turned_sheet_and_a_dragged_part_survive_the_refusal_too() {
        let (refused, planned) = pair(
            StockCfg {
                size_x_mm: Some(1200.0),
                size_y_mm: Some(900.0),
                thickness_mm: Some(12.0),
                origin_x_mm: Some(37.0),
                origin_y_mm: Some(11.0),
                rotation_deg: Some(90.0),
                ..StockCfg::default()
            },
            Some([50.0, 25.0]),
        );
        assert!(!refused.ok);
        assert!(planned.ok, "{:?} {:?}", planned.errors, planned.refusals);
        assert_eq!(refused.drawing_placement, planned.drawing_placement);
        assert_eq!(
            refused.drawing_placement.drawing_offset_mm,
            [50.0, 25.0],
            "the part offset did not reach the refused report"
        );
        // The basis really is turned, or the assertion above is comparing two
        // identities and proving nothing about rotation.
        assert!(!refused.drawing_placement.is_identity());
        assert_eq!(
            refused.stock, planned.stock,
            "the refused report described a different workpiece to the planned one"
        );
        assert_eq!(refused.stock, [1200.0, 900.0, 12.0]);
    }

    /// The geometry itself: the tool refusal is downstream of the layout, so the
    /// outline exists and is the SAME outline the program would have been built
    /// from — vertex for vertex.
    #[test]
    fn a_tool_refusal_still_carries_the_placed_outline_it_had() {
        let (refused, planned) = pair(
            StockCfg { origin_x_mm: Some(37.0), origin_y_mm: Some(11.0), ..StockCfg::default() },
            None,
        );
        assert_eq!(refused.drawing.len(), 1, "the refused workpiece drew nothing it had placed");
        assert_eq!(refused.drawing.len(), planned.drawing.len());
        let verts = |r: &Report| -> Vec<(f64, f64)> {
            r.drawing[0].outer.verts.iter().map(|v| (v.x, v.y)).collect()
        };
        assert_eq!(
            verts(&refused),
            verts(&planned),
            "the refused outline is not the geometry the program would have been cut from"
        );
        // And it is a REFUSAL, not a program that slipped out.
        assert!(refused.gcode.is_empty(), "a refused import emitted G-code");
        assert!(
            refused.refusals.iter().any(|r| r.contains("no cutting tool was selected")),
            "{:?}",
            refused.refusals
        );
    }

    /// 🔴 THE OTHER DIRECTION, and it is the one that keeps the fix honest. A
    /// path with no placed geometry must draw NOTHING and SAY SO — the empty
    /// list on its own is indistinguishable from an empty workpiece, and inventing
    /// an outline nobody computed is the worse error of the two.
    #[test]
    fn a_drawing_that_produced_no_outline_draws_nothing_and_says_why() {
        let r = plan_report_import_bytes(b"this is not a drawing", "dxf", None, &cfg(), 2.0);
        assert!(!r.ok);
        assert!(r.drawing.is_empty(), "geometry appeared for a file that parsed to nothing");
        assert!(
            r.notes.iter().any(|n| n.contains("NO WORKPIECE GEOMETRY IS DRAWN")),
            "the absence was silent — a host cannot tell it from an empty workpiece: {:#?}",
            r.notes
        );
        // The datum still travels: it is the operator's own setting and it is
        // known before any drawing is read.
        let r = plan_report_import_bytes(
            b"this is not a drawing",
            "dxf",
            None,
            &JobConfig {
                stock: Some(StockCfg {
                    origin_x_mm: Some(37.0),
                    origin_y_mm: Some(11.0),
                    ..StockCfg::default()
                }),
                ..cfg()
            },
            2.0,
        );
        assert_eq!((r.drawing_placement.dx_mm, r.drawing_placement.dy_mm), (37.0, 11.0));
    }

    /// A half-placed workpiece is not drawn either, and for a different reason to
    /// the one above: the parts exist, but they have no position yet, so drawing
    /// them would show a workpiece missing the drawing that failed.
    #[test]
    fn a_sheet_refused_mid_layout_draws_nothing_rather_than_the_half_of_it_that_placed() {
        let good = rect_dxf(0.0, 0.0, 100.0, 80.0);
        let sources = [
            src("a", &good, 0.0, 0.0, 0.0),
            // Same id — the layout refuses it, AFTER `a` is in.
            src("a", &good, 400.0, 0.0, 0.0),
        ];
        let r = plan_report_import_many(&sources, &cfg(), 2.0, None, None);
        assert!(!r.ok, "two drawings with one name planned a program");
        assert!(r.drawing.is_empty(), "half a workpiece was drawn: {} part(s)", r.drawing.len());
        assert!(
            r.notes.iter().any(|n| n.contains("NO WORKPIECE GEOMETRY IS DRAWN")),
            "{:#?}",
            r.notes
        );
    }

    /// The overlap refusal already drew its workpiece, and must keep doing so — the
    /// picture is the entire point of that refusal. Without this, "refusals draw
    /// nothing" would satisfy the tests above.
    #[test]
    fn the_overlap_refusal_still_draws_the_sheet_it_condemned() {
        let a = rect_dxf(0.0, 0.0, 100.0, 80.0);
        let b = rect_dxf(0.0, 0.0, 100.0, 80.0);
        let sources = [src("a", &a, 0.0, 0.0, 0.0), src("b", &b, 10.0, 0.0, 0.0)];
        let r = plan_report_import_many(&sources, &cfg(), 2.0, None, None);
        assert!(!r.ok, "two overlapping parts planned a program");
        assert_eq!(r.drawing.len(), 2, "the condemned workpiece was not drawn");
        assert!(r.gcode.is_empty());
    }
}

#[cfg(test)]
mod multi_drawing_tests {
    //! N drawings on one workpiece.
    //!
    //! 🔴 EVERY ASSERTION HERE READS THE EMITTED PROGRAM OR A REFUSAL. Not the
    //! placement echoed back on the report, not a finding count, not the config
    //! that was sent in. This lane has shipped a setting that read as applied
    //! and changed no emitted word four separate times, and a test that reads
    //! the intent is green about the intent.

    use super::*;

    /// A rectangle as a DXF, at `(x, y)` and `w x h`. Written here rather than
    /// read from a file so a test's geometry is visible where the test is.
    pub(super) fn rect_dxf(x: f64, y: f64, w: f64, h: f64) -> Vec<u8> {
        let mut s = String::from("0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n70\n1\n");
        for (px, py) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)] {
            s.push_str(&format!("10\n{px:.1}\n20\n{py:.1}\n"));
        }
        s.push_str("0\nENDSEC\n0\nEOF\n");
        s.into_bytes()
    }

    pub(super) fn cfg() -> JobConfig {
        JobConfig {
            tool_id: Some(TEST_TOOL_ID.into()),
            machine: Some(MachineCfg {
                travel_x_mm: Some(2000.0),
                travel_y_mm: Some(2000.0),
                ..MachineCfg::default()
            }),
            stock: Some(StockCfg {
                size_x_mm: Some(1200.0),
                size_y_mm: Some(900.0),
                ..StockCfg::default()
            }),
            ..JobConfig::default()
        }
    }

    pub(super) const CELL: f64 = 2.0;

    pub(super) fn src<'a>(id: &str, data: &'a [u8], dx: f64, dy: f64, rot: f64) -> ImportSource<'a> {
        ImportSource {
            id: id.into(),
            data,
            format: "dxf".into(),
            z_section_mm: None,
            offset_mm: [dx, dy],
            rotation_deg: rot,
        }
    }

    /// Every (X, Y) the post WROTE, grouped by the part named in the operation
    /// comment above it. The same reading gate MULTI does, because a test and a
    /// gate disagreeing about what the program says is the worst of the three.
    pub(super) fn by_part(g: &str) -> std::collections::HashMap<String, Vec<(f64, f64)>> {
        let mut out: std::collections::HashMap<String, Vec<(f64, f64)>> = Default::default();
        let mut part: Option<String> = None;
        let (mut x, mut y): (Option<f64>, Option<f64>) = (None, None);
        for line in g.lines() {
            let t = line.trim();
            if let Some(rest) = t
                .strip_prefix("( op: ")
                .or_else(|| t.strip_prefix("( drill: "))
                .or_else(|| t.strip_prefix("( mark: "))
            {
                // 🔴 UP TO ` [`, NOT to the first space. A drawing's id is a
                // NAME a person chose — "Hive super end" — so an operation is
                // routinely `( op: Hive super end/part1 [End Mill …] )`. The
                // first version of this helper split on whitespace and read that
                // as a part called `Hive`, which silently attributed one copy's
                // coordinates to a part that does not exist. It was caught by
                // giving a test a realistic id; a test using `A` and `B` would
                // have passed forever, and so would the gate.
                let name = rest.rsplit_once(" [").map(|(n, _)| n).unwrap_or(rest);
                let name = name.split("-hole").next().unwrap_or(name).to_string();
                out.entry(name.clone()).or_default();
                part = Some(name);
                continue;
            }
            if t.is_empty() || t.starts_with('(') {
                continue;
            }
            let mut moved = false;
            for w in t.split_whitespace() {
                let (k, v) = w.split_at(1);
                if (k == "X" || k == "Y") && !v.is_empty() {
                    if let Ok(n) = v.parse::<f64>() {
                        if k == "X" {
                            x = Some(n);
                        } else {
                            y = Some(n);
                        }
                        moved = true;
                    }
                }
            }
            if moved {
                if let (Some(p), Some(px), Some(py)) = (part.as_ref(), x, y) {
                    out.get_mut(p).unwrap().push((px, py));
                }
            }
        }
        out
    }

    #[test]
    fn one_drawing_left_as_drawn_takes_the_same_route_and_emits_a_program() {
        // The single-drawing entry point IS a one-element call of the engine —
        // if this ever stops being true there are two plan paths again, and the
        // overlap check runs on only one of them.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let many = plan_report_import_many(&[src(LONE_DRAWING_ID, &d, 0.0, 0.0, 0.0)], &cfg(), CELL, None, None);
        let one = plan_report_import_bytes(&d, "dxf", None, &cfg(), CELL);
        assert!(many.ok, "{:?} {:?}", many.errors, many.refusals);
        assert_eq!(one.gcode, many.gcode, "the one-drawing shorthand is not the engine");
    }

    #[test]
    fn a_per_drawing_offset_moves_only_that_drawing_in_the_emitted_program() {
        // 🔴 BOTH HALVES. "The program changed" would pass for an offset that
        // moved EVERY part — the job-level offset wearing a per-part label —
        // and the panel would look right while the workpiece was nested from a
        // picture nobody cut.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let home = plan_report_import_many(
            &[src("A", &d, 0.0, 0.0, 0.0), src("B", &d, 300.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        let moved = plan_report_import_many(
            &[src("A", &d, 0.0, 0.0, 0.0), src("B", &d, 300.0, 40.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(home.ok && moved.ok, "{:?} {:?}", home.errors, moved.errors);
        let (h, m) = (by_part(&home.gcode), by_part(&moved.gcode));
        let (a, b) = ("A/part1", "B/part1");
        assert!(h.contains_key(a) && h.contains_key(b), "parts not named: {:?}", h.keys());
        assert_eq!(h[a], m[a], "moving ONE drawing moved the other");
        assert_eq!(h[b].len(), m[b].len(), "the moved drawing changed shape");
        for (i, &(x, y)) in h[b].iter().enumerate() {
            assert!(
                (m[b][i].0 - x).abs() < 1e-6 && (m[b][i].1 - y - 40.0).abs() < 1e-6,
                "the drawing that WAS moved did not move by exactly 40mm in Y"
            );
        }
    }

    #[test]
    fn turning_a_drawing_turns_the_geometry_the_program_is_cut_from() {
        // A part DRAWN turned whose toolpath is planned unturned cuts the wrong
        // shape, and the picture is the half that looks right.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let flat = plan_report_import_many(&[src("A", &d, 0.0, 0.0, 0.0)], &cfg(), CELL, None, None);
        let turned =
            plan_report_import_many(&[src("A", &d, 0.0, 0.0, 90.0)], &cfg(), CELL, None, None);
        assert!(flat.ok && turned.ok, "{:?} {:?}", flat.errors, turned.errors);
        let span = |g: &str| {
            let pts: Vec<(f64, f64)> = by_part(g).into_values().flatten().collect();
            let xs: Vec<f64> = pts.iter().map(|p| p.0).collect();
            let ys: Vec<f64> = pts.iter().map(|p| p.1).collect();
            let mm = |v: &[f64]| {
                (v.iter().cloned().fold(f64::INFINITY, f64::min),
                 v.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
            };
            let (x0, x1) = mm(&xs);
            let (y0, y1) = mm(&ys);
            (pts.len(), x1 - x0, y1 - y0, x0, y0)
        };
        let f = span(&flat.gcode);
        let t = span(&turned.gcode);
        assert_eq!(f.0, t.0, "the turn changed how much is cut, not just its orientation");
        // A square part would pass the swap by being unchanged; this one is not.
        assert!((f.1 - f.2).abs() > 1.0, "the fixture is square, so a swap proves nothing");
        assert!((t.1 - f.2).abs() < 1e-6, "the emitted X span did not become the Y span");
        assert!((t.2 - f.1).abs() < 1e-6, "the emitted Y span did not become the X span");
        // …about a corner that stays where it was.
        assert!((t.3 - f.3).abs() < 1e-6 && (t.4 - f.4).abs() < 1e-6, "the pivot walked");
    }

    #[test]
    fn two_drawings_on_the_same_material_are_refused_with_no_program_at_all() {
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(
            &[src("A", &d, 0.0, 0.0, 0.0), src("B", &d, 0.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(!r.ok, "two parts cut from the same material were accepted");
        // 🔴 G13's property. A warning printed above a runnable program is a
        // program that gets run.
        assert!(r.gcode.is_empty(), "a refused workpiece emitted {} bytes", r.gcode.len());
        let said = r.refusals.join(" ");
        assert!(said.contains("A/part1") && said.contains("B/part1"), "{said}");
        assert!(said.contains("OVERLAP"), "{said}");
        // It must not offer to move anything: the clamps do not travel with the
        // parts.
        assert!(said.contains("re-nest, do not nudge"), "{said}");
    }

    #[test]
    fn the_same_two_drawings_moved_apart_still_emit_a_program() {
        // 🔴 THE PAIRED POSITIVE. A refusal test with no positive beside it is
        // indistinguishable from a check that refuses everything, which would
        // pass forever while making the feature unusable.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(
            &[src("A", &d, 0.0, 0.0, 0.0), src("B", &d, 300.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(r.ok, "{:?} {:?}", r.errors, r.refusals);
        assert!(!r.gcode.is_empty(), "a clear workpiece produced no program");
    }

    #[test]
    fn two_drawings_closer_than_the_cutter_are_refused_as_too_close_and_not_as_an_overlap() {
        // A different failure with a different fix — move them apart, rather
        // than re-nest — so it must not share a message with the overlap.
        // 200mm wide at 50..250; an offset of 204 leaves 4mm for a 6mm cutter.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(
            &[src("A", &d, 0.0, 0.0, 0.0), src("B", &d, 204.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(!r.ok && r.gcode.is_empty(), "a 4mm channel for a 6mm cutter was accepted");
        let said = r.refusals.join(" ");
        assert!(said.contains("TOO CLOSE to cut between"), "{said}");
        assert!(!said.contains("OVERLAP"), "an overlap and a spacing problem were blurred: {said}");
    }

    #[test]
    fn an_undeclared_gap_margin_is_said_out_loud_on_every_report() {
        // "No margin declared" and "margin checked" are different facts and only
        // the second is safe, so the first is stated rather than defaulted into
        // silence — the undeclared-fixture rule, one field along.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(&[src("A", &d, 0.0, 0.0, 0.0)], &cfg(), CELL, None, None);
        assert!(
            r.notes.iter().any(|n| n.contains("no part-gap margin was declared")),
            "{:?}",
            r.notes
        );
        let mut declared = cfg();
        declared.part_gap_margin_mm = Some(1.0);
        let r2 = plan_report_import_many(&[src("A", &d, 0.0, 0.0, 0.0)], &declared, CELL, None, None);
        assert!(
            !r2.notes.iter().any(|n| n.contains("no part-gap margin was declared")),
            "a declared margin still reported as undeclared"
        );
    }

    #[test]
    fn the_overlap_plant_restores_the_defect_and_is_not_reachable_without_it() {
        // The negative control, asserted as a CONSEQUENCE. If it ever stops
        // planting, gate MULTI has no control and every leg above it is
        // unproven — so this fails here too rather than only in the gate.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let pair = [src("A", &d, 0.0, 0.0, 0.0), src("B", &d, 0.0, 0.0, 0.0)];
        let clean = plan_report_import_many(&pair, &cfg(), CELL, None, None);
        let planted = plan_report_import_many_planted(
            &pair,
            JobPlant::OverlapUnchecked,
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(!clean.ok && clean.gcode.is_empty(), "the clean run is not refused");
        assert!(planted.ok && !planted.gcode.is_empty(), "the plant no longer plants");
    }

    #[test]
    fn a_duplicate_drawing_id_is_refused_rather_than_disambiguated() {
        // Operation names are `drawing/part`; two drawings with one id share
        // them, and a refusal could not then say which drawing it condemned.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(
            &[src("A", &d, 0.0, 0.0, 0.0), src("A", &d, 300.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(!r.ok && r.gcode.is_empty());
        assert!(r.errors.join(" ").contains("already a drawing called"), "{:?}", r.errors);
    }

    #[test]
    fn a_drawing_that_yields_nothing_cuttable_refuses_the_whole_sheet_by_name() {
        // A workpiece planned from the drawings that happened to parse is a workpiece
        // missing a part nobody was told about.
        let good = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let empty = b"0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n".to_vec();
        let r = plan_report_import_many(
            &[src("A", &good, 0.0, 0.0, 0.0), src("B", &empty, 300.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(!r.ok && r.gcode.is_empty());
        assert!(r.errors.join(" ").contains("`B`"), "the failing drawing was not named: {:?}", r.errors);
    }

    #[test]
    fn the_reported_drawing_is_the_placed_geometry_the_program_was_cut_from() {
        // A viewport that drew the un-placed drawing beside a turned program is
        // exactly the disagreement this path exists to make impossible.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(&[src("A", &d, 100.0, 0.0, 0.0)], &cfg(), CELL, None, None);
        assert!(r.ok, "{:?}", r.errors);
        let min_x = r
            .drawing
            .iter()
            .flat_map(|p| p.outer.verts.iter())
            .map(|v| v.x)
            .fold(f64::INFINITY, f64::min);
        assert!(
            (min_x - 150.0).abs() < 1e-6,
            "the reported drawing is at x={min_x}, not where the program cuts it"
        );
    }
}

#[cfg(test)]
mod same_drawing_twice_tests {
    //! 🔴 **N INSTANCES OF ONE FILE** — founder, 2026-08-10: *"Drawing: Able to
    //! add more than 1 from the same drawing"*.
    //!
    //! The thing this asserts is that a part is keyed by its **instance**, not
    //! by the drawing it came from. Two copies of one file are two parts with
    //! two placements, and anything that keyed on the drawing's name would
    //! collapse them into one — the second copy vanishing, or both moving
    //! together, and either way an operator losing a part they placed.
    //!
    //! `ImportSource::id` is that instance key and always has been; these tests
    //! exist so it cannot quietly stop being one.

    // The helpers, from the sibling module. ONE copy, so a test and its
    // sibling cannot disagree about what the emitted program says.
    use super::multi_drawing_tests::{by_part, cfg, rect_dxf, src, CELL};
    use super::*;

    #[test]
    fn two_instances_of_one_file_are_two_parts_with_two_placements() {
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        // SAME BYTES, twice. Only the instance id and the offset differ.
        let r = plan_report_import_many(
            &[src("copy 1", &d, 0.0, 0.0, 0.0), src("copy 2", &d, 300.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(r.ok, "{:?} {:?}", r.errors, r.refusals);
        let parts = by_part(&r.gcode);
        assert!(
            parts.contains_key("copy 1/part1") && parts.contains_key("copy 2/part1"),
            "two copies of one file did not produce two named parts: {:?}",
            parts.keys()
        );
        // …and they are in DIFFERENT places, which is the half a name-keyed
        // model gets wrong while still emitting two of everything.
        let x = |k: &str| parts[k].iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        assert!(
            (x("copy 2/part1") - x("copy 1/part1") - 300.0).abs() < 1e-6,
            "the second instance is not 300mm from the first"
        );
    }

    #[test]
    fn a_second_copy_dropped_on_the_first_is_refused_and_never_nudged_apart() {
        // 🔴 THE DELIBERATE DEFAULT. A copy is added AT THE SAME PLACE, which
        // means the first thing an operator meets is this refusal. That is the
        // choice: offsetting the copy automatically would be the software moving
        // a part on its own, and the clamps do not move with the parts. The
        // message therefore has to say what to DO.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let r = plan_report_import_many(
            &[src("copy 1", &d, 0.0, 0.0, 0.0), src("copy 2", &d, 0.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(!r.ok && r.gcode.is_empty(), "two copies on one spot emitted a program");
        let said = r.refusals.join(" ");
        assert!(said.contains("copy 1/part1") && said.contains("copy 2/part1"), "{said}");
        // Actionable, not merely negative.
        assert!(said.contains("MOVE ONE OF THEM"), "the refusal does not say what to do: {said}");
        assert!(said.contains("do not \nnudge") || said.contains("do not nudge"), "{said}");
    }

    #[test]
    fn turning_one_copy_leaves_the_other_exactly_where_it_was() {
        // The rotation is per INSTANCE, not per drawing. A model that turned
        // "the drawing" would turn both copies and look entirely correct.
        let d = rect_dxf(50.0, 50.0, 200.0, 120.0);
        let flat = plan_report_import_many(
            &[src("copy 1", &d, 0.0, 0.0, 0.0), src("copy 2", &d, 400.0, 0.0, 0.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        let turned = plan_report_import_many(
            &[src("copy 1", &d, 0.0, 0.0, 0.0), src("copy 2", &d, 400.0, 0.0, 90.0)],
            &cfg(),
            CELL,
            None,
            None,
        );
        assert!(flat.ok && turned.ok, "{:?} {:?}", flat.errors, turned.errors);
        let (f, t) = (by_part(&flat.gcode), by_part(&turned.gcode));
        assert_eq!(
            f["copy 1/part1"], t["copy 1/part1"],
            "turning one copy turned the other — the rotation is keyed on the drawing, not the instance"
        );
        assert_ne!(
            f["copy 2/part1"], t["copy 2/part1"],
            "the copy that WAS turned did not turn"
        );
    }
}

#[cfg(test)]
mod reach_parity_tests {
    use super::*;

    fn plan_with(cfg_json: &str) -> Report {
        let cfg: JobConfig = serde_json::from_str(cfg_json).expect("config");
        let dxf = std::fs::read_to_string("gates/fixtures/plate.dxf")
            .or_else(|_| std::fs::read_to_string("../gates/fixtures/plate.dxf"))
            .expect("plate.dxf");
        plan_report_import(&dxf, "dxf", &cfg, 0.6)
    }

    /// 🔴 THE TWO TOOL PATHS MUST AGREE ABOUT REACH.
    ///
    /// Audited 2026-08-10. The reach rule lived only in `recommend`, which the
    /// `tool_ids` (SET) path consults and the `tool_id` (single) path did not.
    /// Measured then: the same 12mm-flute cutter on the same 18mm ply gave
    /// `ok=true cut=17179mm deepest=-18.00mm` through `tool_id` — 32kB of
    /// runnable G-code, no note, no warning — and a named refusal through
    /// `tool_ids`.
    ///
    /// **Selecting a SECOND tool turned the safety check on.** The single-cutter
    /// case is the ordinary one and the one the browser sends.
    ///
    /// The physical failure: a flute shorter than the cut drags PLAIN SHANK
    /// through the material every pass — no flutes to clear the chip, so it
    /// rubs, heats and snaps.
    #[test]
    fn one_tool_and_a_set_of_one_agree_that_a_short_cutter_cannot_reach() {
        let short = "End Mill - Down-cut 3.175mm 2F"; // 12mm flute, 18mm workpiece
        let single = plan_with(&format!(r#"{{"tool_id":"{short}"}}"#));
        let set = plan_with(&format!(r#"{{"tool_ids":["{short}"]}}"#));

        assert!(!single.ok, "single tool_id planned a job the cutter cannot reach: {:?}", single.refusals);
        assert!(!set.ok, "tool_ids planned a job the cutter cannot reach");
        assert!(
            single.gcode.is_empty(),
            "a refused program emitted {} bytes of G-code",
            single.gcode.len()
        );
        // The SAME sentence from both doors — if they diverge, one of them has
        // its own copy of the rule again.
        let sentence = "cutting length cannot cut";
        assert!(
            single.refusals.iter().any(|r| r.contains(sentence)),
            "single path refused for some other reason: {:?}",
            single.refusals
        );
        assert!(
            set.refusals.iter().any(|r| r.contains(sentence)),
            "set path refused for some other reason: {:?}",
            set.refusals
        );
    }

    /// The paired positive. Without it, "refused" is indistinguishable from a
    /// check that always refuses — and this whole fix would look identical to
    /// having broken the single-tool path.
    #[test]
    fn a_cutter_that_does_reach_still_plans_through_both_doors() {
        let long = "End Mill - Down-cut 6mm 2F"; // 25mm flute, clears 18mm
        let single = plan_with(&format!(r#"{{"tool_id":"{long}"}}"#));
        assert!(single.ok, "a cutter that reaches was refused: {:?}", single.refusals);
        assert!(!single.gcode.is_empty(), "a runnable job emitted no G-code");
    }
}

/// **Travel is reach, the spoilboard is material** — end to end, through the
/// door a real host uses (2026-08-10).
///
/// 🔴 These drive `JobConfig` and read `Report`, because that is the only path
/// the browser and the CLI have. A unit test on `sim::check` proves the
/// arithmetic; it does not prove that a declaration a user typed reaches the
/// check, or that the answer reaches the screen. This lane has shipped both of
/// those gaps before — a rotation that reached `Clamp::rotated` and not the
/// report echo, and a `--config` the `job` subcommand parsed and ignored.
#[cfg(test)]
mod spoilboard_report_tests {
    use super::*;

    fn plan(cfg_json: &str) -> Report {
        let cfg: JobConfig = serde_json::from_str(cfg_json).expect("config parses");
        plan_report("plate", JobPlant::None, &cfg, 0.6).expect("fixture plans")
    }

    fn note_containing<'a>(r: &'a Report, needle: &str) -> Option<&'a String> {
        r.notes.iter().find(|n| n.contains(needle))
    }

    /// The same `plate` program on a workpiece declared **17.8mm**, with only the
    /// board's rectangle differing between calls.
    ///
    /// 🔴 The thickness is the point, and it is an ORDINARY setup rather than a
    /// contrivance: `crate::toolpath` clamps a through-profile to
    /// `thickness + 0.3`, and this fixture asks for 18.0 of depth, so the
    /// program cuts **0.2mm past the underside of a 17.8mm workpiece** — exactly
    /// what a through-cut is supposed to do. Over the board those 0.2mm are
    /// sacrificial; past its edge they are 0.2mm of cutter in a rail. Two
    /// answers from one program, and the only difference is what the board
    /// covers — which is the whole claim of this change.
    fn plan_on_a_thin_sheet(board_json: &str) -> Report {
        plan(&format!(
            r#"{{"stock":{{"thickness_mm":17.8}},"machine":{{"spoilboard":{board_json}}}}}"#
        ))
    }

    #[test]
    fn the_travel_envelope_reaches_the_report_so_a_host_need_not_remember_what_it_posted() {
        let r = plan(r#"{"machine":{"travel_x_mm":1250,"travel_y_mm":670,"travel_z_mm":90}}"#);
        assert_eq!(r.travel, [1250.0, 670.0, 90.0]);
        // And it is NOT the workpiece, and NOT the spoilboard. Three rectangles,
        // three fields — the conflation this whole change is about.
        assert_ne!(
            [r.travel[0], r.travel[1]],
            [r.stock[0], r.stock[1]],
            "travel and workpiece came back as the same rectangle"
        );
        assert!(r.spoilboard.is_none());
    }

    #[test]
    fn with_no_spoilboard_declared_the_report_says_unchecked_and_offers_no_board() {
        // 🔴 THE DEFAULT STATE OF EVERY EXISTING JOB. It must not come back
        // looking clean: `plate` cuts through an 18mm workpiece, so cells DO go below
        // the workpiece, and until today the only thing said about them was a count
        // whose name asserted they were in the spoilboard.
        let r = plan("{}");
        assert!(r.spoilboard.is_none(), "a board appeared that nobody declared");
        assert!(r.spoilboard_bare_reach.is_none());
        assert!(
            !r.sim.spoilboard_position_checked,
            "the position limb claimed to have run on a machine with no board"
        );
        assert_eq!(r.sim.past_spoilboard_edge, 0, "an unasked question produced an answer");
        let note = note_containing(&r, "SPOILBOARD POSITION NOT CHECKED")
            .expect("the UNCHECKED sentence must reach the operator, not just a boolean");
        assert!(
            note.contains("not a spoilboard covering the whole travel envelope"),
            "the note must refuse the exact assumption that shipped: {note}"
        );
        // 🔴 It must speak on a job whose depths are all fine. `plate` is
        // clamped to the workpiece plus the allowance and therefore reports ZERO
        // cells below the floor — and that is the run where the operator can
        // still bolt the board down. A note that waited for a deep cut would
        // arrive one job too late.
        assert_eq!(
            r.sim.spoilboard, 0,
            "the planner stopped clamping through-cuts to thickness+allowance — this test's \
             premise moved and the note's gating needs re-reading"
        );
    }

    #[test]
    fn a_board_covering_the_sheet_makes_the_through_cut_sacrificial_and_says_nothing_alarming() {
        // The positive control. Without it, "past the edge is reported" could be
        // satisfied by a check that reports every through-cut.
        let r = plan_on_a_thin_sheet(
            r#"{"name":"shop mdf","x_mm":-20,"y_mm":-20,"size_x_mm":700,"size_y_mm":1000}"#,
        );
        assert!(r.spoilboard.is_some(), "the declaration did not reach the machine: {:?}", r.notes);
        assert!(r.sim.spoilboard_position_checked);
        assert_eq!(
            r.sim.past_spoilboard_edge, 0,
            "a cut entirely over the board was reported as reaching the machine"
        );
        assert_eq!(
            r.sim.spoilboard, 0,
            "over the board the sacrificial allowance applies, so the 0.2mm a through-cut goes \
             past the underside is not a finding at all"
        );
        assert!(note_containing(&r, "PAST THE EDGE").is_none(), "{:?}", r.notes);
        assert!(note_containing(&r, "SPOILBOARD POSITION NOT CHECKED").is_none());
        // The board covers the workpiece but NOT the whole 600x900 reach, and the
        // report says which strips are bare rather than leaving the host to
        // subtract two rectangles itself.
        let bare = r.spoilboard_bare_reach.expect("a declared board reports its bare strips");
        assert_eq!(bare, [0.0, 0.0, 0.0, 0.0], "a board overhanging the travel left strips: {bare:?}");
    }

    #[test]
    fn a_sheet_hanging_off_the_board_reports_the_strike_with_its_own_sentence() {
        // 🔴 THE PHYSICAL CASE THE OLD CHECK COULD NOT SEE, ON AN ENTIRELY
        // ORDINARY PROGRAM. The 600x900 workpiece is laid on a board that stops at
        // X250. `plate` is a plain through-profile — the planner clamps it to
        // the workpiece plus the 0.3mm sacrificial allowance, which is why the
        // depth-only check reports **zero** on it and always has. Those 0.3mm
        // are sacrificial over the board and are 0.3mm of cutter in an
        // extrusion past its edge, and nothing in this tree could say so.
        let r = plan_on_a_thin_sheet(
            r#"{"name":"half board","x_mm":0,"y_mm":0,"size_x_mm":250,"size_y_mm":900}"#,
        );
        assert!(r.sim.spoilboard_position_checked);
        assert!(
            r.sim.past_spoilboard_edge > 0,
            "the ordinary through-cut running off the board's edge was not seen at all"
        );
        // Every below-the-workpiece cell on this job is a strike: over the board the
        // allowance absorbs the clamped 0.3mm, so the ONLY cells that survive
        // the floor test are the ones with no board under them.
        assert_eq!(
            r.sim.past_spoilboard_edge, r.sim.spoilboard,
            "over-board cells were counted below the floor — the sacrificial allowance is not \
             being applied where there IS sacrificial material, which would false-red every \
             correct through-cut"
        );
        let note = note_containing(&r, "PAST THE EDGE OF THE SPOILBOARD")
            .expect("the strike must have its OWN sentence, not a shared spoilboard message");
        assert!(note.contains("half board"), "the sentence must name the board: {note}");
        assert!(note.contains("frame"), "the sentence must name the physical failure: {note}");
        assert!(note.contains("First at X"), "the operator needs somewhere to look: {note}");
        // 🔴 And it must NOT claim to know what is under there. "No declared
        // board covers this" and "there is metal here" are different facts.
        assert!(
            note.contains("cannot see what does"),
            "the sentence must not overstate what this core knows: {note}"
        );
        // The UNCHECKED note is mutually exclusive with a limb that ran.
        assert!(note_containing(&r, "SPOILBOARD POSITION NOT CHECKED").is_none());
        // The bare strips are reported too: 350mm of X and 0 of Y on a 600x900.
        assert_eq!(r.spoilboard_bare_reach, Some([0.0, 350.0, 0.0, 0.0]));
    }

    #[test]
    fn a_catalogue_board_installs_by_id_and_the_position_stays_the_callers() {
        let r = plan(
            r#"{"machine":{"travel_x_mm":1250,"travel_y_mm":900,
                 "spoilboard":{"catalogue_id":"2bee-cnc-table-mdf-18","x_mm":40,"y_mm":15}}}"#,
        );
        let sb = r.spoilboard.expect("a catalogue id must install a board: {:?}");
        assert_eq!((sb.x_mm, sb.y_mm), (Some(40.0), Some(15.0)), "the caller's position moved");
        assert_eq!(
            (sb.size_x_mm, sb.size_y_mm),
            (Some(1080.0), Some(1560.0)),
            "the size did not come from the catalogue entry"
        );
        // The echo is explicit geometry, never the id — a host redrawing the
        // rectangle must not have to resolve a catalogue to find out where it is.
        assert!(sb.catalogue_id.is_none());
        assert!(r.sim.spoilboard_position_checked);
    }

    #[test]
    fn an_unknown_catalogue_id_installs_nothing_and_names_the_ids_it_knows() {
        // 🔴 The tool-substitution lesson. `.unwrap_or_else(|| end_mill(6.0))`
        // once planned a complete program on a cutter nobody asked for, exit 0,
        // nothing in `notes`. A substituted board is a rectangle in the wrong
        // place and the rectangle is the whole check.
        let r = plan(
            r#"{"machine":{"spoilboard":{"catalogue_id":"mdf-9000x9000","x_mm":0,"y_mm":0}}}"#,
        );
        assert!(r.spoilboard.is_none(), "an unknown id installed a board");
        assert!(!r.sim.spoilboard_position_checked, "a miss was reported as a check that ran");
        let note = note_containing(&r, "SPOILBOARD NOT INSTALLED")
            .expect("a rejected declaration that produced silence looks like no declaration");
        assert!(note.contains("mdf-9000x9000"), "{note}");
        assert!(note.contains("NOT replaced"), "{note}");
        assert!(
            note.contains("2bee-cnc-table-mdf-18"),
            "the refusal must name the ids it does know: {note}"
        );
    }

    #[test]
    fn a_board_with_no_position_installs_nothing_because_zero_is_not_a_safe_default() {
        let r = plan(r#"{"machine":{"spoilboard":{"size_x_mm":1080,"size_y_mm":1560}}}"#);
        assert!(r.spoilboard.is_none());
        let note = note_containing(&r, "SPOILBOARD NOT INSTALLED").expect("must say why");
        assert!(note.contains("no position"), "{note}");
        assert!(
            note.contains("0,0 is not a safe default"),
            "the refusal must say why the obvious default is the dangerous one: {note}"
        );
    }

    #[test]
    fn an_id_and_a_size_together_install_nothing_rather_than_picking_a_winner() {
        let r = plan(
            r#"{"machine":{"spoilboard":{"catalogue_id":"mdf-1200x600-12","x_mm":0,"y_mm":0,
                 "size_x_mm":300,"size_y_mm":300}}}"#,
        );
        assert!(r.spoilboard.is_none());
        let note = note_containing(&r, "SPOILBOARD NOT INSTALLED").expect("must say why");
        assert!(note.contains("BOTH"), "{note}");
    }

    #[test]
    fn one_axis_of_a_rectangle_is_not_a_rectangle() {
        let r = plan(r#"{"machine":{"spoilboard":{"x_mm":0,"y_mm":0,"size_x_mm":1080}}}"#);
        assert!(r.spoilboard.is_none());
        assert!(note_containing(&r, "SPOILBOARD NOT INSTALLED").is_some());
    }

    #[test]
    fn a_zero_sized_board_is_refused_where_the_operator_can_see_what_they_typed() {
        // 🔴 It must be caught at the DECLARATION, not dropped silently by
        // `sim::check`. Dropped there, the report would say UNCHECKED with
        // nothing to say that a board had been declared at all — and the
        // operator would be looking for a board they thought they had typed in.
        let r = plan(
            r#"{"machine":{"spoilboard":{"name":"typo","x_mm":0,"y_mm":0,
                 "size_x_mm":0,"size_y_mm":0}}}"#,
        );
        assert!(r.spoilboard.is_none());
        let note = note_containing(&r, "SPOILBOARD NOT INSTALLED").expect("must say why");
        assert!(note.contains("no area"), "{note}");
    }

    #[test]
    fn the_catalogue_payload_is_offered_to_a_host_with_no_default_in_it() {
        // The picker's whole contract, asserted through the function a host
        // calls rather than through the table it is built from.
        let json = crate::spoilboards::catalogue_json();
        assert!(json.contains("\"default_id\":null"));
        assert!(json.contains("2bee-cnc-table-mdf-18"));
        assert!(json.contains("bunnings.com.au"), "provenance must reach the picker");
    }

    // =======================================================================
    //  The DEPTH limb — "the board is under here; did the cut go past it?"
    // =======================================================================
    //
    // 🔴 THE PREMISE OF EVERY TEST BELOW, STATED ONCE BECAUSE IT IS THE WHOLE
    // REASON THIS FIELD EXISTS.
    //
    // `crate::toolpath` clamps a through-cut to `stock.thickness_mm + 0.3`, so
    // the DEEPEST a planned program can go past the workpiece's underside is the
    // 0.3mm sacrificial allowance — never more. The `plate` fixture asks for
    // 18.0mm of depth, so declaring a 12mm workpiece spends the whole allowance:
    // the cutter finishes at Z-12.3 against an underside at Z-12.0.
    //
    // ⇒ A board is reached exactly when it is **thinner than the allowance**,
    // and `crate::sim::SpoilboardDepth`'s own header names that case: *"on a
    // board thinner than the allowance those are not even in the same order."*
    // Every catalogue board is 12mm or thicker, so before `SpoilboardCfg`
    // carried a thickness the red below was not reachable from any config at
    // all — the check existed and no host could make it fire.
    //
    // ⚠ What these tests therefore do NOT prove: that a 6mm board can ever be
    // driven through by a PLANNED job. It cannot, and that is a property of the
    // clamp in `toolpath.rs`, not of this config surface. What the 6mm case
    // proves is that the limb now RUNS on a measured board and answers
    // `inside-board` — where it used to answer PENDING forever.
    /// The same ordinary through-cut over a board declared by MEASUREMENT, with
    /// only the thickness clause differing between calls.
    ///
    /// The board is deliberately larger than the workpiece and offset from the
    /// datum, so the POSITION limb is clean on every call and any difference
    /// between these tests is the DEPTH limb's alone.
    fn plan_over_a_measured_board(thickness_clause: &str) -> Report {
        plan(&format!(
            "{}{}{}",
            r#"{"stock":{"thickness_mm":12},"machine":{"spoilboard":{"name":"shop board",
                "x_mm":-20,"y_mm":-20,"size_x_mm":700,"size_y_mm":1000"#,
            thickness_clause,
            "}}}"
        ))
    }

    #[test]
    fn a_measured_board_can_finally_declare_a_thickness_and_the_limb_answers() {
        // 🔴 THE STRUCTURAL DEFECT, CLOSED. Until `SpoilboardCfg.thickness_mm`
        // existed this exact config was REJECTED OUTRIGHT — `deny_unknown_fields`
        // — and a board declared without it could only ever report PENDING.
        let r = plan_over_a_measured_board(r#","thickness_mm":6.0"#);
        let sb = r.spoilboard.as_ref().expect("the declaration did not install");
        assert_eq!(
            sb.thickness_mm,
            Some(6.0),
            "the thickness was dropped between the config and the board — the depth limb has no \
             floor and the viewport has no slab to draw"
        );
        assert_eq!(
            r.sim.board_depth, "inside-board",
            "a limb with a floor and cells to test reported something other than a verdict: {:?}",
            r.sim.board_depth_pending_reason
        );
        assert_eq!(r.sim.through_board, 0);
        assert!(
            r.sim.board_depth_pending_reason.is_none(),
            "a limb that ran also said why it did not"
        );
        assert!(note_containing(&r, "THROUGH THE SPOILBOARD").is_none(), "{:?}", r.notes);
        assert!(note_containing(&r, "THROUGH-THE-BOARD NOT CHECKED").is_none(), "{:?}", r.notes);
    }

    #[test]
    fn a_board_thinner_than_the_sacrificial_allowance_reports_through_the_board() {
        // 🔴 THE RED, REACHED FROM A CONFIG FILE FOR THE FIRST TIME. 0.2mm of
        // board under a cut that spends 0.3mm of allowance: 0.1mm of cutter in
        // whatever the machine is built of, on a program that is otherwise
        // completely ordinary and that the POSITION limb correctly calls clean.
        let r = plan_over_a_measured_board(r#","thickness_mm":0.2"#);
        assert_eq!(
            r.sim.board_depth, "through-board",
            "the cutter went past the underside and the verdict did not say so"
        );
        assert!(r.sim.through_board > 0, "a verdict with no cells behind it");
        assert!(r.sim.board_depth_pending_reason.is_none());
        // 🔴 BOTH LIMBS DISAGREE ABOUT THE SAME PROGRAM AND BOTH ARE RIGHT. Over
        // the board the 0.3mm is sacrificial, so the position limb reports zero;
        // the board is 0.2mm thick, so the depth limb reports a strike. A single
        // blurred verdict would have to pick one, which is why they are two.
        assert!(r.sim.spoilboard_position_checked);
        assert_eq!(
            r.sim.past_spoilboard_edge, 0,
            "the position limb moved — this test's premise is that it stays clean"
        );
        assert_eq!(r.sim.spoilboard, 0);
        let note = note_containing(&r, "THROUGH THE SPOILBOARD")
            .expect("the strike must have its own SENTENCE, not just a verdict word");
        assert!(note.contains("shop board"), "the sentence must name the board: {note}");
        assert!(note.contains("First at X"), "the operator needs somewhere to look: {note}");
    }

    #[test]
    fn an_undeclared_thickness_is_pending_and_is_never_rendered_as_a_pass() {
        // 🔴 THE PLANT THIS TEST EXISTS FOR: `board_depth` derived from
        // `through_board > 0` in a host. That reads `inside-board` here, on a
        // board whose thickness nobody has stated — a check that could not run,
        // painted the colour of one that ran and found nothing.
        let r = plan_over_a_measured_board("");
        assert_eq!(r.sim.board_depth, "board-depth-unknown");
        assert_ne!(
            r.sim.board_depth, "inside-board",
            "🔴 PENDING was rendered as the SAFE verdict — this is the exact failure"
        );
        assert_eq!(r.sim.through_board, 0, "a limb with no floor compared something");
        let why = r
            .sim
            .board_depth_pending_reason
            .as_ref()
            .expect("an unrun limb must say why, in the core's words");
        assert!(why.contains("NO THICKNESS"), "{why}");
        assert!(why.contains("never as 'thick enough'"), "{why}");
        // The sentence reaches `notes` too: a consumer reading counters may
        // never read the tail of the struct.
        assert!(note_containing(&r, "THROUGH-THE-BOARD NOT CHECKED").is_some(), "{:?}", r.notes);
        // 🔴 And the POSITION limb is untouched. An absent thickness must not be
        // allowed to switch off the answer to "is there a board under this XY".
        assert!(
            r.sim.spoilboard_position_checked,
            "an unknown thickness disabled the limb that has nothing to do with it"
        );
    }

    #[test]
    fn a_thickness_that_is_not_a_slab_installs_the_rectangle_and_is_reported() {
        // Three-way, not two: "nobody said" and "somebody typed something that
        // is not a thickness" are different facts, and only the second names a
        // number the operator can go and correct.
        let r = plan_over_a_measured_board(r#","thickness_mm":0"#);
        let sb = r.spoilboard.as_ref().expect("a bad thickness threw away a valid rectangle");
        assert_eq!(sb.thickness_mm, Some(0.0), "the typed value was silently discarded");
        assert!(
            r.sim.spoilboard_position_checked,
            "a thickness typo switched off the POSITION limb — the blur the two separate fault \
             lists exist to prevent, arriving through the config"
        );
        assert_eq!(r.sim.board_depth, "board-depth-unknown");
        let note = note_containing(&r, "is not a slab")
            .expect("the operator typed a number and nothing said a word about it");
        assert!(note.contains("shop board"), "{note}");
    }

    #[test]
    fn a_catalogue_id_and_an_explicit_thickness_install_nothing_rather_than_picking_a_winner() {
        // The same rule the id-plus-size case already has, applied to the slab.
        // REFUSED rather than ignored: a key accepted and discarded is worse
        // than one that errors, because the operator, the script and the gate
        // all believe it took.
        let r = plan(
            r#"{"machine":{"spoilboard":{"catalogue_id":"mdf-1200x600-12","x_mm":0,"y_mm":0,
                 "thickness_mm":9.0}}}"#,
        );
        assert!(r.spoilboard.is_none(), "one of two thicknesses was picked silently");
        assert!(!r.sim.spoilboard_position_checked);
        let note = note_containing(&r, "SPOILBOARD NOT INSTALLED").expect("must say why");
        assert!(note.contains("BOTH"), "{note}");
        assert!(note.contains("no rule for which wins"), "{note}");
        assert!(
            note.contains("size_x_mm + size_y_mm + thickness_mm"),
            "the refusal must name the way to say what the operator meant: {note}"
        );
    }

    #[test]
    fn a_catalogue_board_still_brings_its_own_sourced_thickness_across_the_echo() {
        // The catalogue path was never broken — this is the control that keeps
        // it that way, and it also pins the echo: the viewport draws the slab
        // from the report, so a thickness that reaches the check but not the
        // echo is a board drawn as unknown while being enforced.
        let r = plan(
            r#"{"machine":{"travel_x_mm":1250,"travel_y_mm":900,
                 "spoilboard":{"catalogue_id":"mdf-1200x600-12","x_mm":0,"y_mm":0}}}"#,
        );
        let sb = r.spoilboard.expect("a catalogue id must install a board");
        assert_eq!(sb.thickness_mm, Some(12.0), "the catalogue's sourced thickness never arrived");
    }

    #[test]
    fn an_undeclared_board_echoes_no_slab_rather_than_a_plausible_one() {
        let r = plan("{}");
        assert!(r.spoilboard.is_none());
        assert_eq!(r.sim.board_depth, "board-depth-unknown");
        let why = r.sim.board_depth_pending_reason.as_ref().expect("must say why");
        assert!(
            why.contains("no spoilboard is declared"),
            "the sentence must name the OUTERMOST cause — no board — rather than the missing \
             thickness of a board that does not exist: {why}"
        );
    }

    #[test]
    fn a_payload_written_before_the_verdict_existed_deserialises_as_pending() {
        // 🔴 A MISSING HONESTY FIELD MUST LAND ON THE HONEST ANSWER. For a bool
        // that is `false`; for a verdict WORD there is no such luck, and the
        // empty string is worse than useless — a host with a three-way match
        // falls through to its `_` arm, which on every UI written so far is the
        // harmless one.
        let old = r#"{"cell_mm":0.6,"gouge":0,"uncut":0,"spoilboard":0,"first":null}"#;
        let c: SimCounts = serde_json::from_str(old).expect("an older payload must still parse");
        assert_eq!(c.board_depth, "board-depth-unknown");
        assert_eq!(c.through_board, 0);
        assert!(c.board_depth_pending_reason.is_none());
        // The default is taken from the core's own enum, so it cannot drift away
        // from what a live report writes.
        assert_eq!(c.board_depth, crate::sim::BoardDepth::Unknown.as_str());
    }

    #[test]
    fn a_refused_import_reports_the_depth_limb_as_pending_and_not_as_clean() {
        // Nothing was planned and nothing was simulated, so the question was
        // never asked. Three zeros and a blank verdict would read as a clean
        // simulation of a program that does not exist.
        let r = plan_report_import("not a dxf at all", "dxf", &JobConfig::default(), 0.6);
        assert!(!r.ok);
        assert_eq!(r.sim.board_depth, "board-depth-unknown");
        assert_eq!(r.sim.through_board, 0);
        let why = r.sim.board_depth_pending_reason.as_ref().expect("must say why");
        assert!(why.contains("REFUSED"), "{why}");
    }
}

// ===========================================================================
//  The tool-change rate, on its way to a host that must not re-derive it
// ===========================================================================
//
// 🔴 THE DEFECT THESE TESTS GUARD IS A COPY, NOT A CALCULATION. The emitted
// program carries no duration for a tool change — it writes `M0` and stops, and
// how long a person takes is not in the file. So a host that draws a playback
// clock has nothing to read and invents a number: `web/src/App.tsx` held its own
// literal `60` while the core charged `120`, and the two sat on the same screen
// disagreeing by a minute per change (item `#90`).
//
// ⚠ Both fields are read off `JobSummary::basis` and NEVER off
// `built.job.machine.tool_change_seconds`. The machine's field is an `Option`
// whose absence has to be resolved against `job::DEFAULT_TOOL_CHANGE_SECONDS`;
// resolving it here would put a SECOND copy of the fallback in the tree, which
// is the very thing being deleted. The test below that fails on a
// machine-reading implementation is
// `an_undeclared_rate_reports_the_fallback_and_says_it_is_the_fallback` — a
// machine read returns `None` there, and the whole point is that it must not.
#[cfg(test)]
mod tool_change_reaches_the_report_tests {
    use super::*;
    use crate::job::DEFAULT_TOOL_CHANGE_SECONDS;

    const CELL: f64 = 0.6;

    fn plan(cfg_json: &str) -> Report {
        let cfg: JobConfig = serde_json::from_str(cfg_json).expect("config parses");
        plan_report("plate", JobPlant::None, &cfg, CELL).expect("fixture plans")
    }

    #[test]
    fn an_undeclared_rate_reports_the_fallback_and_says_it_is_the_fallback() {
        // 🔴 THE LOAD-BEARING ONE. A report built by reading the MACHINE would
        // send `None` here, because nobody declared anything — and a host given
        // `None` is a host back to inventing a number, which is the state this
        // change exists to end. The basis holds what was CHARGED, and something
        // was charged.
        let r = plan("{}");
        assert!(r.tool_changes > 0, "this fixture no longer changes tools — pick another");
        assert_eq!(
            r.tool_change_seconds,
            Some(DEFAULT_TOOL_CHANGE_SECONDS),
            "the report did not say what the estimate actually charged"
        );
        assert!(
            !r.tool_change_rate_declared,
            "a fallback was reported as somebody's declaration — and the fallback is the \
             founder's estimate of his own shop, not a measurement"
        );
    }

    #[test]
    fn a_declared_rate_reaches_the_report_through_the_config() {
        // The key is READ, not merely accepted. `MachineCfg` is
        // `deny_unknown_fields`, so before this field existed this exact config
        // was rejected outright — the whole payload, not just the key.
        let r = plan(r#"{"machine":{"tool_change_seconds":300}}"#);
        assert_eq!(r.tool_change_seconds, Some(300.0));
        assert!(r.tool_change_rate_declared);
    }

    #[test]
    fn a_declared_rate_that_equals_the_default_is_still_a_declaration() {
        // 🔴 "Somebody chose 120" and "nobody said, so we used 120" are
        // different facts and this flag is the ONLY thing that separates them.
        // A report that compared the value against the constant to decide would
        // pass every other test here and fail this one.
        let r = plan(&format!(
            r#"{{"machine":{{"tool_change_seconds":{DEFAULT_TOOL_CHANGE_SECONDS}}}}}"#
        ));
        assert_eq!(r.tool_change_seconds, Some(DEFAULT_TOOL_CHANGE_SECONDS));
        assert!(
            r.tool_change_rate_declared,
            "a declared rate was read as an absence because it matched the fallback"
        );
    }

    #[test]
    fn a_declared_zero_is_an_atc_and_is_not_an_absence() {
        let r = plan(r#"{"machine":{"tool_change_seconds":0}}"#);
        assert_eq!(r.tool_change_seconds, Some(0.0), "a typed 0 was flattened into nothing");
        assert!(r.tool_change_rate_declared, "a typed 0 was read as an absence");
    }

    #[test]
    fn the_reported_rate_is_the_one_the_estimate_spent() {
        // 🔴 ASSERT ON THE CONSEQUENCE, NOT ON THE FIELD. Reading the field back
        // out proves only that a number crossed a struct boundary. Two runs of
        // the SAME program at two rates must differ by exactly the extra
        // operator time, and the reported rate is what predicts the difference —
        // so a report echoing a rate the estimator did not use goes red here.
        let slow = plan(r#"{"machine":{"tool_change_seconds":300}}"#);
        let fast = plan(r#"{"machine":{"tool_change_seconds":0}}"#);
        assert_eq!(slow.tool_changes, fast.tool_changes);
        assert_eq!(slow.gcode, fast.gcode, "the rate changed the PROGRAM — it must change only the estimate");
        let charged = slow.tool_changes as f64 * slow.tool_change_seconds.unwrap();
        assert!(
            (slow.estimated_seconds - fast.estimated_seconds - charged).abs() < 1e-6,
            "the estimate moved by {:.3}s while the report says {:.3}s was charged",
            slow.estimated_seconds - fast.estimated_seconds,
            charged
        );
    }

    #[test]
    fn a_refused_import_reports_no_rate_at_all() {
        // 🔴 `None`, beside `rapid_mm_min`, and for the same reason: no job was
        // planned, so nothing was charged. A rate here would be this function's
        // guess dressed as an estimate that was made.
        let r = plan_report_import("not a dxf at all", "dxf", &JobConfig::default(), CELL);
        assert!(!r.ok);
        assert!(r.rapid_mm_min.is_none(), "the premise of this test moved");
        assert!(r.tool_change_seconds.is_none(), "a rate was reported for a job that never ran");
        assert!(!r.tool_change_rate_declared);
    }

    #[test]
    fn a_payload_written_before_these_fields_existed_claims_nothing() {
        // A missing provenance flag must land on the WEAKER claim.
        let old = r#"{"cell_mm":0.6,"gouge":0,"uncut":0,"spoilboard":0,"first":null}"#;
        let c: SimCounts = serde_json::from_str(old).expect("older payloads must still parse");
        // (the counts struct is unrelated to the rate; it is deserialised here
        // only to prove the report's own defaults are exercised below)
        assert_eq!(c.gouge, 0);
        let r: Report = serde_json::from_str(&format!(
            r#"{{"job":"x","ok":false,"gcode":"","refusals":[],"notes":[],"fixture_findings":[],
                 "warnings":[],"errors":[],"tools_used":[],"tool_changes":0,
                 "cutting_distance_mm":0,"rapid_distance_mm":0,"estimated_seconds":0,
                 "deepest_z_mm":0,"tab_lifts":0,"dogbones":0,"sim":{old},
                 "simulated_stock_surface":null,"loaded_mesh":null,"render":[],
                 "stock":[0,0,0],"clamps":[]}}"#
        ))
        .expect("a report written before these fields existed must still parse");
        assert!(r.tool_change_seconds.is_none());
        assert!(!r.tool_change_rate_declared, "an absent flag defaulted to the stronger claim");
    }
}
