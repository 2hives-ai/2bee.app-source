//! Job assembly — many operations and many tools into one program.
//!
//! This is where the sequencing safety rules live:
//!   * interior features before the outer profile (the part stays held down),
//!   * operations grouped by tool (N tools ⇒ N−1 changes, never more),
//!   * spindle stopped across a change,
//!   * Z re-referenced after a change, because the new tool is a different
//!     length and the old zero is now wrong by that difference.

use serde::{Deserialize, Serialize};

use crate::feeds::{
    chip_verdict, pinned_feed, plunge_feed, resolve_feed, PinnedFeed, PlungeFeed,
};
use crate::fixture::{FixtureFinding, Fixturing};
use crate::layout::{Clearance, Layout};
// `optimise_route` is used only by this module's tests — see the same note in
// `fixture.rs`. A lib-only build reports it unused; deleting it breaks `cargo
// test`, which is a red nobody sees until the suite runs.
#[cfg(test)]
use crate::optimise::optimise_route;
use crate::optimise::{optimise_route_with, RouteReport};
use crate::placement::{plan_datum_shift_for_toolpath, Placement};
use crate::post_grblhal::PostOptions;
use crate::recommend::{recommend, Feature, FeatureKind, RecommendOptions, Recommendation};
use crate::toolpath::{Operation, Refusal};
use crate::tools::{check_collet, ColletVerdict, Material, ToolSpec};
use crate::types::*;

#[derive(Clone, Debug)]
pub struct Job {
    pub name: String,
    pub machine: Machine,
    pub stock: Stock,
    pub fixturing: Fixturing,
    /// An ordered sequence of clamping phases for multi-phase jobs where
    /// work-holding changes mid-program. Each phase's moves are checked
    /// against that phase's own clamp set. `None` = single-phase (normal).
    pub clamp_phases: Option<Vec<crate::fixture::ClampPhase>>,
    /// Re-probe Z after a work-holding change. Default true.
    pub probe_after_clamp_change: bool,
    pub operations: Vec<Operation>,
    /// Re-probe Z after every tool change. Default **true**: skipping it is a
    /// deliberate choice with a physical consequence, not a default.
    pub probe_after_toolchange: bool,
    /// What is being cut. Bounds feed, depth per pass and rpm.
    pub material: Material,
    /// The process. Only [`Technology::Cnc`] is implemented; a job declaring
    /// anything else is refused rather than quietly posted as CNC.
    pub technology: crate::tech::Technology,
    /// Features that the tool SET the user selected cannot cut, recorded by
    /// [`assign_tools_from_set`] and refused by [`plan_job`].
    ///
    /// 🔴 It lives on the job because the decision is taken BEFORE planning and
    /// has to survive to the refusal channel. The alternative — returning the
    /// refusals to whoever called the assignment and trusting them to act — is a
    /// safety check with an optional caller, which is the defect this whole pass
    /// exists to remove. Nothing clears this field except assigning again.
    pub tool_set_refusals: Vec<Refusal>,
    /// 🔴 **NEGATIVE-CONTROL KNOB. Every real job leaves this at the default.**
    ///
    /// Which order the tool GROUPS run in — see [`crate::optimise::GroupOrder`].
    /// The only thing that ever sets it to anything else is
    /// [`crate::fixtures::JobPlant::ReleaseOrder`], and the only thing that sets
    /// *that* is gate REL's `--plant release-order`. It is reachable from no
    /// config file, no CLI flag and no UI control, deliberately: this field
    /// reproduces the pre-2026-08-09 hazard on demand, and a hazard a user can
    /// switch on is not a control, it is a defect with a checkbox.
    ///
    /// It lives on the `Job` rather than being passed at the call site because
    /// `plan_job` takes a `&Job` and nothing else — the same reasoning as
    /// [`Job::post`]: a knob held beside the call is a knob a second call site
    /// can forget.
    pub group_order: crate::optimise::GroupOrder,
    /// How this job is to be written out.
    ///
    /// 🔴 It lives on the JOB, not at the call that writes the file, because
    /// [`JobSummary`] is derived by posting the program and reading the numbers
    /// back out of it. A host that writes the file with DIFFERENT options than
    /// these gets a summary describing a program it did not download — which is
    /// exactly the defect this field exists to close. If you change the options
    /// at a write site, change them here.
    pub post: PostOptions,

    /// Where the operator has put this job's GEOMETRY on the workpiece, in **workpiece
    /// millimetres**, before the workpiece is laid on the machine.
    ///
    /// 🔴 THIS IS NOT [`Stock::origin_x_mm`] AND THE TWO ARE NOT
    /// INTERCHANGEABLE. The datum moves the WORKPIECE on the machine and takes the
    /// clamps' relationship to the work with it; this moves the PART ON THE
    /// WORKPIECE and leaves the workpiece where it is. They compose in one direction
    /// only — see [`Job::place`] — because the part is on the workpiece and the
    /// workpiece is on the machine, never the other way round. Turning it
    /// therefore carries the part round with it, which is what a person laying
    /// a workpiece would expect and what a datum-only model cannot express.
    ///
    /// 🔴 IT IS SET BY A HUMAN DRAGGING SOMETHING, AND BY NOTHING ELSE. Nothing
    /// in this crate writes it to resolve an interference, clear a soft limit or
    /// escape a clamp. [`crate::placement::plan_datum_shift`] still REPORTS a
    /// shift and refuses to apply one, and `layout` still grades a placement a
    /// human chose — because the clamps do not travel with the parts, so a
    /// program moved 3mm to clear a limit is a program moved 3mm into whatever
    /// is holding the work down. **An operator dragging a part is a different
    /// act from the software relocating it, and only the first one is allowed.**
    /// Gate P7 sees the moved coordinates like any others: a drag INTO a
    /// declared clamp is refused, not corrected.
    pub drawing_offset_x_mm: f64,
    pub drawing_offset_y_mm: f64,

    /// 🔴 **NEGATIVE-CONTROL KNOB. Every real job leaves this `false`.**
    ///
    /// Makes [`Job::place`] discard `drawing_offset_*` while every host keeps
    /// reporting and displaying it — i.e. it restores the state this lane has
    /// shipped four times already: a setting that is stored, shown, and changes
    /// not one coordinate of the emitted program. The picture and the panel move;
    /// the machine does not.
    ///
    /// Reachable from no config file, no CLI flag and no UI control — only from
    /// [`crate::fixtures::JobPlant::DrawingOffsetIgnored`], on the same reasoning
    /// as [`Job::group_order`]: a hazard a user can switch on is not a control,
    /// it is a defect with a checkbox.
    pub plant_ignores_drawing_offset: bool,

    /// **Leave an outline edge that lies on the workpiece edge UNCUT.**
    ///
    /// 🔴 **DEFAULT `false`, and that is not timidity.** Turning it on changes
    /// WHAT GEOMETRY GETS CUT from what the drawing says. The drawing is the
    /// operator's statement of intent, and this app should need permission to
    /// cut less than it — a default that silently alters the emitted shape is
    /// the wrong kind of default.
    ///
    /// What the operator is accepting when they turn it on: the workpiece edge
    /// must actually be straight and square, the part's dimension on that side
    /// becomes the material supplier's tolerance, and the datum on that side
    /// becomes wherever the workpiece actually is rather than where it was
    /// probed. All three are printed on every job that carries it.
    ///
    /// The decision itself is taken in
    /// [`crate::toolpath::plan_profile_with_edge_rule`], on the PLACED outline —
    /// never at import. See its header for why that is a safety property.
    pub use_workpiece_edge: bool,

    /// How close an outline edge must lie to the workpiece edge to count as
    /// coincident, in mm. Only read when [`Job::use_workpiece_edge`] is on.
    ///
    /// 🔴 **A DECLARED NUMBER, NOT A CONSTANT, because the dangerous case is the
    /// near-miss.** An outline 0.2mm inside the workpiece, skipped, leaves a
    /// 0.2mm ribbon of material holding the part — worse than either cutting it
    /// or leaving it properly. An edge further inside than this is cut normally.
    ///
    /// ⚠ [`DEFAULT_WORKPIECE_EDGE_TOLERANCE_MM`] is a **chosen** default and not
    /// a measured one: the physical basis is the material supplier's own size
    /// tolerance on the panel, and this lane has not sourced that number for any
    /// stock it lists. So the default is a starting point the operator is
    /// expected to move, and it is printed on every job for exactly that reason
    /// — a tolerance nobody can see is a constant with extra steps.
    pub workpiece_edge_tolerance_mm: f64,
}

/// The starting tolerance for *"this edge is the workpiece edge"*, in mm.
///
/// ⚠ **CHOSEN, NOT MEASURED.** It is the operator's number to set; see
/// [`Job::workpiece_edge_tolerance_mm`].
pub const DEFAULT_WORKPIECE_EDGE_TOLERANCE_MM: f64 = 0.1;

impl Job {
    pub fn new(name: impl Into<String>, machine: Machine, stock: Stock) -> Self {
        Self {
            name: name.into(),
            machine,
            stock,
            fixturing: Fixturing::default(),
            clamp_phases: None,
            probe_after_clamp_change: true,
            operations: Vec::new(),
            probe_after_toolchange: true,
            material: Material::Plywood,
            technology: crate::tech::Technology::Cnc,
            tool_set_refusals: Vec::new(),
            group_order: crate::optimise::GroupOrder::ReleaseSorted,
            post: PostOptions::default(),
            drawing_offset_x_mm: 0.0,
            drawing_offset_y_mm: 0.0,
            plant_ignores_drawing_offset: false,
            use_workpiece_edge: false,
            workpiece_edge_tolerance_mm: DEFAULT_WORKPIECE_EDGE_TOLERANCE_MM,
        }
    }

    /// **Drawing coordinates to machine coordinates.** The ONE transform every
    /// coordinate of this job's geometry goes through.
    ///
    /// ```text
    ///   drawing mm  --(+ drawing offset)-->  workpiece mm  --(Stock::place)-->  machine mm
    /// ```
    ///
    /// 🔴 THE ORDER IS NOT A PREFERENCE. The offset is added BEFORE the workpiece's
    /// rotation, so it is measured on the WORKPIECE: drag a part 50mm along the
    /// workpiece, turn it a quarter turn, and the part is still 50mm along
    /// the workpiece — which is where it physically is. Adding it afterwards would
    /// measure the drag in machine axes, and turning the workpiece would then slide
    /// the part across the material it is cut from.
    ///
    /// 🔴 EVERY CONSUMER OF PART GEOMETRY MUST USE THIS, NOT
    /// [`Stock::place`] — the toolpath in [`plan_job`] and the verification
    /// regions in [`crate::fixtures::simulate_and_check`] both do. The two
    /// diverging is not a hypothetical: `simulate_and_check`'s own header
    /// records the last time a placed path was checked against unplaced
    /// regions — 0 gouges at datum 0, 1027 at datum 150, 0 again at datum 300,
    /// the last being a green that compared nothing because the two had stopped
    /// overlapping at all. Things that describe the WORKPIECE — its corners, the
    /// height-map window, [`Stock::corner_placement`] and therefore the touch
    /// plate hooked over it — must keep using [`Stock::place`]: a plate hooked
    /// over the workpiece does not move when a part is dragged across it.
    pub fn place(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = self.drawing_offset();
        self.stock.place(x + dx, y + dy)
    }

    /// The offset actually applied — `(0.0, 0.0)` under the plant.
    fn drawing_offset(&self) -> (f64, f64) {
        if self.plant_ignores_drawing_offset {
            (0.0, 0.0)
        } else {
            (self.drawing_offset_x_mm, self.drawing_offset_y_mm)
        }
    }

    /// [`Job::place`] as four numbers, **measured out of `place` itself**.
    ///
    /// 🔴 It is MEASURED and not re-derived, and that is the whole point of the
    /// function existing. A renderer needs the same rigid transform the program
    /// went through, and the last time this app wrote a placement rule a second
    /// time in TypeScript the copy was orientation-blind and refused a workpiece
    /// that fits turned. So the terms are read back out of the one
    /// implementation — `place(0,0)` is the translation, and the unit vectors
    /// are what `place` does to (1,0) and (0,1) — rather than rebuilt from
    /// `rotation_deg` and the push-back.
    ///
    /// ⚠ It is only a complete description while `place` is AFFINE, which it is:
    /// a rotation, a push-back and a translation. A future `place` that scaled
    /// per-axis or sheared would still be measurable this way; one that was
    /// non-linear would not, and this function would then be a lie of the most
    /// convincing kind. `placement_is_the_transform_place_applies` in this
    /// module is the test that would go red.
    pub fn placement(&self) -> Placement2D {
        let (dx, dy) = self.place(0.0, 0.0);
        let (ux, uy) = self.place(1.0, 0.0);
        let (vx, vy) = self.place(0.0, 1.0);
        let (ox, oy) = self.drawing_offset();
        Placement2D {
            cos: ux - dx,
            sin: uy - dy,
            // Carried rather than assumed to be `(-sin, cos)`: measuring both
            // basis vectors is what makes this a reading of `place` instead of
            // an assumption about it.
            row_y: [vx - dx, vy - dy],
            dx_mm: dx,
            dy_mm: dy,
            drawing_offset_mm: [ox, oy],
        }
    }
}

/// The rigid transform [`Job::place`] applies, for a host that has to DRAW in
/// the same frame the program is cut in.
///
/// `machine = (cos * x + row_y[0] * y + dx_mm, sin * x + row_y[1] * y + dy_mm)`
///
/// 🔴 A viewport that positions the imported object by anything else is drawing
/// a picture the program does not agree with — and a picture asserts far more
/// strongly than a note can withdraw. Before 2026-08-09 the browser drew the
/// loaded mesh at its raw model coordinates while the workpiece was drawn at its
/// datum, so any non-zero datum or rotation left the object standing beside the
/// workpiece.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Placement2D {
    /// x-basis vector: what `place` does to (1,0), less the translation.
    pub cos: f64,
    pub sin: f64,
    /// y-basis vector, same reading, taken from (0,1).
    pub row_y: [f64; 2],
    /// The translation — literally `place(0.0, 0.0)`.
    pub dx_mm: f64,
    pub dy_mm: f64,
    /// The drawing offset this transform CARRIES, echoed so a reader can tell a
    /// part that was dragged from a workpiece that was moved. Under the plant it is
    /// `[0,0]`, because that is what was applied — the field says what the
    /// program got, not what the operator typed.
    pub drawing_offset_mm: [f64; 2],
}

/// 🔴 THE IDENTITY, hand-written, NOT `#[derive(Default)]`.
///
/// A derived default is all-zero, which is not "no placement" — it is a
/// SINGULAR matrix that collapses every point in the drawing onto one spot at
/// the machine origin. This struct's job is to position an object on screen, so
/// the wrong default does not read as missing data, it draws a part that is not
/// there. `Report` carries `#[serde(default)]` on this field so an older
/// report still deserialises, which is exactly the path that would have taken
/// the zero.
impl Default for Placement2D {
    fn default() -> Self {
        Self { cos: 1.0, sin: 0.0, row_y: [0.0, 1.0], dx_mm: 0.0, dy_mm: 0.0, drawing_offset_mm: [0.0, 0.0] }
    }
}

impl Placement2D {
    /// True when this transform moves nothing — so a caller can skip the work
    /// without keeping its own list of which fields `place` reads.
    ///
    /// EXACT equality, not a tolerance. `Stock::sin_cos` is exact on the quarter
    /// turns on purpose, so an untouched job's terms are literally
    /// `1, 0, 0, 1, 0, 0`; anything else is a placement somebody asked for, and
    /// a tolerance here would decide for them that a 0.0005mm nudge was noise.
    pub fn is_identity(&self) -> bool {
        self.cos == 1.0
            && self.sin == 0.0
            && self.row_y == [0.0, 1.0]
            && self.dx_mm == 0.0
            && self.dy_mm == 0.0
    }
}

#[derive(Clone, Debug, Default)]
pub struct JobSummary {
    /// 🔴 The ONE plan-derived field, and it is labelled here rather than left
    /// to be assumed: the emitted program does not carry tool identity. This
    /// dialect has no tool table — a tool's name appears only inside a comment,
    /// and comments can be switched off (`PostOptions::emit_comments`). So the
    /// NAMES come from the plan; the COUNT of changes below does not.
    pub tools_used: Vec<String>,
    /// Operator pauses actually emitted (`M0`). In this dialect an `M0` is
    /// written for a manual tool change and for nothing else.
    pub tool_changes: usize,
    pub cutting_distance_mm: f64,
    pub rapid_distance_mm: f64,
    pub estimated_seconds: f64,
    /// Deepest Z **word in the emitted program**, so it carries the
    /// [`crate::types::ZDatum`] shift and the post's rounding — it is the number
    /// the controller is told, not the number the planner intended.
    ///
    /// 🔴 **IT IS IN THE EMITTED FRAME, AND A HOST MUST SAY WHICH ONE.** Under
    /// [`crate::types::ZDatum::SpoilboardTop`] a perfectly correct through-cut
    /// reports `0.00`, and `0.00` beside the words "Deepest Z" reads as *it did
    /// not cut* — an operator re-running a job that already went through. Any
    /// label on this number states the datum (`ZDatum::label`); the number alone
    /// is not self-describing.
    pub deepest_z_mm: f64,
    /// What the numbers above were computed from, and what they cannot know.
    pub basis: EstimateBasis,
}

/// A move at or below this length is where the missing acceleration model hurts
/// most: the machine never reaches the commanded feed, so distance ÷ feed is
/// furthest from the truth. Counted so a UI can say how exposed THIS program is
/// rather than repeating a generic disclaimer.
pub const SHORT_MOVE_MM: f64 = 2.0;

/// Grid resolution for the restraint pass
/// ([`crate::fixture::check_hold_down`]).
///
/// 🔴 **It is NOT the simulation's cell and must not be tied to it.** The two
/// answer different questions with opposite safe directions: `sim` wants a fine
/// inner approximation of the swept region, and this wants a coarse OUTER one
/// over the whole workpiece plus a connected-components pass at every move. 1mm on
/// a 600x900 workpiece is 541,000 cells, which is what a re-plan can afford; the
/// simulation's 0.6mm default would be 1.5 million.
///
/// ⚠ **The cost of the choice is PRINTED, not swallowed.** A cutter narrow
/// enough that this grid cannot resolve its kerf makes the check report PENDING
/// naming both numbers and the cell that would resolve it — never "connected",
/// which is the answer that reads as *held*.
pub const HOLD_DOWN_CELL_MM: f64 = 1.0;

/// The rate charged for a manual tool change **when the machine declares
/// none** — [`Machine::tool_change_seconds`] is the value the estimate uses,
/// and this is only what stands in for it.
///
/// 🔴 **NOTHING ADDS THIS CONSTANT.** It is read in exactly one place — the
/// fallback in [`summarize_program`] — and the report says when that fallback
/// was taken (`EstimateBasis::tool_change_rate_declared`). It was a bare
/// `TOOL_CHANGE_SECONDS = 60.0` that the estimator added directly until
/// 2026-08-10, with a **second copy of the same literal in TypeScript**
/// (`web/src/App.tsx`) whose own comment said it was a copy. Two copies of a
/// number in two languages agree only until somebody changes one.
///
/// 🔴 **PROVENANCE, stated because a preset with a number and no provenance is
/// a claim about a real object that nobody made.** This figure is **the
/// founder's**, given verbatim as *"like 2 mins"* on 2026-08-10. **It is not a
/// measurement**, of this machine or any other.
///
/// That is not for want of looking. `docs/decision-33-tool-grouping-vs-part-
/// restraint.md` Part 2 searched ATC-vendor material, Vectric and CNCZone
/// forums and touch-plate documentation for a per-change figure and found
/// **only qualitative claims** — automatic changes *"within seconds"*, manual
/// ones *"interrupt production"* — and recorded the absence as open item 1 of
/// its Part 5: *"No published measurement was found."* The previous `60.0`
/// came from the lane's own unsourced *"a minute of operator time plus a Z
/// re-reference"* (`core/src/optimise.rs`), which that document labels
/// **GENERIC** — plausible and unverified.
///
/// ⚠ So the honest reading of this number is: **the founder's estimate of his
/// own shop, replacing an author's estimate of nothing in particular.** It is
/// the better of two guesses and it is still a guess. `ops` can measure it in
/// one afternoon — stopwatch on a spindle stop, collet swap and Z re-reference
/// — and the moment they do, the answer belongs in
/// [`Machine::tool_change_seconds`] on that machine, not here.
pub const DEFAULT_TOOL_CHANGE_SECONDS: f64 = 120.0;

pub const ESTIMATE_CAVEAT: &str =
    "the run time is an ESTIMATE read back out of the emitted program: it sums each block's \
     distance at that block's commanded feed and does NOT model acceleration or deceleration. \
     grblHAL ramps into and out of every corner, so this figure UNDER-reads, and it under-reads \
     worst on programs made of many short segments";

/// Where the summary's numbers came from and what they are blind to.
///
/// Carried as data rather than left in a doc comment so a UI can say "estimate"
/// **and say why** without re-deriving the caveat — and so a program that is
/// unusually exposed to the missing acceleration model can say so with its own
/// numbers.
#[derive(Clone, Debug)]
pub struct EstimateBasis {
    /// `true` when the numbers were parsed out of emitted G-code. `false` means
    /// no program was produced (nothing to read), and the numbers are zeros —
    /// not "a job that takes no time".
    pub from_emitted_program: bool,
    /// Always `false`. Stated as a field rather than as prose because a caller
    /// deciding how loudly to hedge should not have to read this file.
    pub models_acceleration: bool,
    /// Motion blocks in the emitted program.
    pub motion_blocks: usize,
    /// ...of which are at or under [`SHORT_MOVE_MM`].
    pub short_moves: usize,
    /// Motion blocks whose distance could not be measured because the program
    /// had not established where the tool was. 🔴 This is NOT a reader defect
    /// and it is never zero: a program starts from an unknown position, and an
    /// `M0` and a `G38.2` both make it unknown again on purpose. A block
    /// carrying a word the reader could not read makes it unknown too — that
    /// one IS a reader limit, and it is counted here rather than left as a
    /// stale position, because the alternative is a confident wrong distance.
    /// Those blocks
    /// contribute no distance and no time, which is one of the reasons the
    /// estimate is a floor.
    pub unmeasured_moves: usize,
    /// Blocks the reader did not understand. 🔴 NAMED, never skipped silently —
    /// an unread motion block is a distance and a time missing from the total,
    /// and a total that quietly lost some of the program is worse than no total.
    pub unread: Vec<String>,
    /// Motion the program commands but does not spell out, so it cannot be
    /// measured from the text.
    pub blind_spots: Vec<String>,
    /// Manual tool changes (`M0`) the estimate charged operator time for.
    ///
    /// The same number as [`JobSummary::tool_changes`], carried here as well
    /// because this struct's job is to make the estimate re-derivable from its
    /// own fields: `tool_changes_charged * tool_change_seconds` is the operator
    /// time inside `estimated_seconds`, and without both terms a 20-minute job
    /// that is 16 minutes of standing at the machine reads as 20 minutes of
    /// cutting.
    pub tool_changes_charged: usize,
    /// Seconds charged per change — the rate above was multiplied by.
    pub tool_change_seconds: f64,
    /// `true` when the rate came from [`Machine::tool_change_seconds`].
    ///
    /// 🔴 `false` means the machine declared nothing and the rate above is
    /// [`DEFAULT_TOOL_CHANGE_SECONDS`], **which is the founder's figure and not
    /// a measurement of this machine**. A caller must be able to tell those two
    /// apart: a declared 120 and a defaulted 120 are the same number and
    /// different facts, and only the first is somebody's decision.
    pub tool_change_rate_declared: bool,
    pub caveat: &'static str,
}

impl EstimateBasis {
    /// Operator time inside `estimated_seconds` — the part of the figure that
    /// is NOT motion and NOT read out of the program.
    pub fn tool_change_seconds_total(&self) -> f64 {
        self.tool_changes_charged as f64 * self.tool_change_seconds
    }
}

impl Default for EstimateBasis {
    fn default() -> Self {
        Self {
            from_emitted_program: false,
            models_acceleration: false,
            motion_blocks: 0,
            short_moves: 0,
            unmeasured_moves: 0,
            unread: Vec::new(),
            blind_spots: Vec::new(),
            tool_changes_charged: 0,
            // Matches the fallback `summarize_program` takes, so a basis that
            // never saw a program does not advertise a rate no code would use.
            tool_change_seconds: DEFAULT_TOOL_CHANGE_SECONDS,
            tool_change_rate_declared: false,
            caveat: ESTIMATE_CAVEAT,
        }
    }
}

// ---------------------------------------------------------------------------
// Offered fixes — computed here, applied by a person, never by this crate
// ---------------------------------------------------------------------------

/// 🔴 The sentence that has to travel with **every** fix in this file, because
/// it is the reason none of them is applied automatically.
///
/// The datum is the part's position relative to the CLAMPS, and the clamps are
/// bolted to the machine. A shift that clears a soft limit moves the program that
/// far into whatever is holding the work down — gate P7's physical failure. The
/// error going away is not the job becoming safe.
pub const FIX_RECHECK_CLAMPS: &str =
    "the clamps do NOT move with the workpiece: after this change the fixture keepout check (P7) has \
     to run again on the new coordinates. A shift that clears a travel limit can put the toolpath \
     through a clamp, and the travel error disappearing says nothing about that";

/// The re-plan every fix requires. Stated as data on the fix rather than as
/// prose in a doc comment, so a host cannot render the button without also
/// having the reason it must re-check in its hand.
pub const FIX_RECHECK_REPLAN: &str =
    "this is a PROPOSAL, not a result: the numbers above were measured on the CURRENT program, \
     and taking the fix invalidates every check in this report. Re-plan and read the new one";

/// A change the core has computed that would clear a specific refusal —
/// **offered, never applied**.
///
/// # Why this is data and not a sentence
///
/// A UI that has to parse `"move outside X travel: -3"` and work out that the
/// answer is `+3` is re-deriving a machining rule where no gate can see it. The
/// core already knows the number ([`crate::placement`]); this type is how it
/// leaves the core intact.
///
/// # Why it is `Serialize` and NOT `Deserialize`
///
/// Same reason [`crate::layout::Clearance`] is: every value here is produced by
/// a computation this crate can defend. A deserialised fix would be a machining
/// instruction that walked past that computation, and it would look exactly like
/// one that did not.
///
/// # Reading `from` / `to`
///
/// Both are vectors of the SAME length in the SAME order, in `units`, and
/// `what_it_changes` names the setting they belong to. Two numbers for the
/// datum (`origin_x_mm`, `origin_y_mm`), one for a rotation. They are absolute
/// values to store, not deltas to add — a delta applied twice is a part 6mm from
/// where anyone intended.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OfferedFix {
    /// Stable id of the KIND of fix: `"datum-shift"`, `"sheet-quarter-turn"`.
    /// A `&'static str` so the vocabulary is the core's and a host cannot mint
    /// one.
    pub id: &'static str,
    /// Stable id of the FAILURE this clears: `"outside-travel"`,
    /// `"stock-larger-than-travel"`. It names the failure, **not** a message
    /// string — matching on rendered prose is how a fix ends up attached to the
    /// wrong refusal.
    pub fixes: &'static str,
    /// The setting the host changes, in the config vocabulary the host already
    /// has.
    pub what_it_changes: &'static str,
    pub from: Vec<f64>,
    pub to: Vec<f64>,
    /// `"mm"` or `"degrees"`.
    pub units: &'static str,
    /// Why this number and not another — the arithmetic, not the conclusion.
    pub why: String,
    /// 🔴 **Never empty.** What must be re-checked after taking this fix. A fix
    /// with nothing to re-check would be a fix that could be applied blindly,
    /// and there is no such fix here — see [`FIX_RECHECK_CLAMPS`].
    pub recheck: Vec<String>,
}

impl OfferedFix {
    /// Move the datum so the whole program lands inside travel.
    ///
    /// `from` / `to` are `[origin_x_mm, origin_y_mm]` — the WORKPIECE datum, which
    /// is what a host stores, not the shift.
    fn datum_shift(from: (f64, f64), to: (f64, f64), why: String) -> Self {
        Self {
            id: "datum-shift",
            fixes: "outside-travel",
            what_it_changes: "stock.origin_x_mm, stock.origin_y_mm",
            from: vec![from.0, from.1],
            to: vec![to.0, to.1],
            units: "mm",
            why,
            recheck: vec![FIX_RECHECK_CLAMPS.to_string(), FIX_RECHECK_REPLAN.to_string()],
        }
    }

    /// Lay the workpiece on a different quarter turn so it fits the travel.
    fn sheet_quarter_turn(from_deg: f64, to_deg: f64, why: String) -> Self {
        Self {
            id: "sheet-quarter-turn",
            fixes: "stock-larger-than-travel",
            what_it_changes: "stock.rotation_deg",
            from: vec![from_deg],
            to: vec![to_deg],
            units: "degrees",
            why,
            recheck: vec![
                "turning the WORKPIECE turns every coordinate on it: the datum, the clamps and the \
                 registration edge are all different afterwards, and the workpiece has to be physically \
                 re-laid to match"
                    .to_string(),
                FIX_RECHECK_CLAMPS.to_string(),
                FIX_RECHECK_REPLAN.to_string(),
            ],
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct JobResult {
    pub path: Toolpath,
    pub summary: JobSummary,
    pub refusals: Vec<Refusal>,
    pub notes: Vec<String>,
    pub fixture_findings: Vec<FixtureFinding>,
    /// Changes that would clear a refusal above, each naming the failure it
    /// clears. **Empty is the honest answer** for a refusal nothing can fix —
    /// a button that cannot explain itself is worse than no button.
    ///
    /// 🔴 Nothing in this crate applies one. See [`OfferedFix`].
    pub offered_fixes: Vec<OfferedFix>,
}

impl JobResult {
    /// A job with any refusal must not be posted. Fixture findings other than
    /// `Undeclared` are equally fatal; `Undeclared` warns, because "nobody told
    /// us where the clamps are" is a state a user can legitimately be in while
    /// still needing to see the program.
    /// Whether this report describes a program that may be produced.
    ///
    /// # 🔴 THIS IS ALSO WHAT MAKES A REFUSAL VISIBLE (recorded 2026-08-30)
    ///
    /// The browser renders refusals under one predicate — `App.tsx`:
    /// `const blocked = report && !report.ok`, and the `blocked` block is the
    /// only place `report.refusals` is listed. So **a refusal is shown to the
    /// operator if and only if `ok` is false**, and `ok` is this function.
    ///
    /// That makes `refusals.is_empty()` load-bearing across a core→UI boundary
    /// rather than merely descriptive: relax it — return `true` while a refusal
    /// stands, for any reason that looks local and sensible here — and the
    /// refusal is still in the JSON, still correct, and **invisible on screen**,
    /// over a program the operator can now download. Verified by driving it: a
    /// drawing with one good square and one self-intersecting outline came back
    /// `ok: false`, **0 bytes**, refusal named.
    ///
    /// ⚠ `Undeclared` is exempt on purpose — "no clamps declared" is a fact
    /// about the setup, not a fault in the program, and blocking on it would
    /// make every un-clamped job unrunnable. It is the one finding that reports
    /// without refusing.
    pub fn is_runnable(&self) -> bool {
        self.refusals.is_empty()
            && !self
                .fixture_findings
                .iter()
                .any(|f| !matches!(f, FixtureFinding::Undeclared))
    }
}

// ---------------------------------------------------------------------------
// Where the summary's numbers come from
// ---------------------------------------------------------------------------
//
// 🔴 THE DECISION, stated once, here: **the summary is read back out of the
// EMITTED PROGRAM** — the G-code text the post produced — and not out of
// `path.moves`, which is the plan that was handed to the post.
//
// This function used to walk `path.moves`. Everything the post does AFTERWARDS
// was therefore invisible to it: a probe it refuses because the machine has no
// probe, an arc it degrades to a straight chord because the controller cannot
// do G2/G3, a move it drops because every axis word was modally suppressed, a Z
// shifted by the declared `ZDatum`. The time, the distances and the deepest
// Z could all describe a program that was never written. This is the same defect
// class as gate P4's dogbone count, which "described the plan, not the output"
// for weeks — a number about the intention reads exactly like a check on the
// result.
//
// THE ALTERNATIVE, and why it was not taken: the post could return a per-move
// trace and the summary could be computed from that. It is less code and it
// cannot drift from the writer. But it only ever knows what the post REMEMBERS
// to record — a post that drops a block has to be taught to say so, and the day
// someone adds a branch and forgets, the summary agrees with the omission.
// Parsing the program cannot be lied to by omission: a block that is not in the
// text did not happen, and a block in the text that this reader does not
// understand is NAMED (`EstimateBasis::unread`) rather than skipped.
//
// WHAT IT COSTS, plainly:
//   * a SECOND reader of the dialect, in this file, which can drift from the
//     writer in `post_grblhal.rs`. Mitigated by naming what it cannot read, and
//     by a test that requires a post option change to MOVE these numbers.
//   * the post runs twice for a job that is also written out — once here for
//     the numbers, once at the host for the file. The post is pure and cheap
//     beside the geometry, and the alternative is a summary describing a
//     different program than the one downloaded.
//   * the numbers describe the program AS ROUNDED to `PostOptions::decimals`,
//     because that is what the controller is actually told.
//
// WHAT THE ESTIMATE STILL CANNOT KNOW — this is not a caveat, it is a property:
//   * ACCELERATION AND DECELERATION ARE NOT MODELLED. Every block is charged
//     distance ÷ commanded feed, i.e. as if the machine were already at feed and
//     stayed there. grblHAL's planner ramps into and out of every corner, so this
//     SYSTEMATICALLY UNDER-ESTIMATES, and it under-estimates worst on programs
//     made of many short segments. `EstimateBasis::short_moves` counts this
//     program's exposure so a UI can hedge with a number instead of a shrug.
//   * a canned cycle's PECKING is expanded by the controller, not by the text —
//     the plunge is measured, the peck retract/return laps are not (blind spot).
//   * a probe stops on contact, so the travel it commands is a maximum; where
//     the probe's starting height is unknown it contributes nothing at all.
//   * operator time at an `M0` is not in the file. It is the ONE quantity here
//     that is DECLARED rather than read — [`Machine::tool_change_seconds`], or
//     [`DEFAULT_TOOL_CHANGE_SECONDS`] when the machine declares nothing — and
//     `EstimateBasis` carries the count, the rate and WHICH of those two it
//     used, so the operator time can be subtracted back out of the total by
//     anyone who wants the cutting figure alone.
// Every one of these omits time. None of them invents any. The estimate is a
// floor, and that is the safe direction for a number someone plans a day around.
//
// ⚠ THE DECLARED INPUT IS THE ONE THAT CAN OVER-READ, and it is the only one:
// a rate typed too high makes the estimate too big, which is the opposite
// direction to every other property above. That is why it is reported as its
// own term rather than folded silently into a total that is otherwise a floor.

/// Everything the reader could work out about the emitted program.
#[derive(Default)]
struct Emitted {
    cut_mm: f64,
    rapid_mm: f64,
    seconds: f64,
    deepest_z: Option<f64>,
    pauses: usize,
    basis: EstimateBasis,
}

impl Emitted {
    fn name_unread(&mut self, what: String) {
        if self.basis.unread.len() < 8 && !self.basis.unread.contains(&what) {
            self.basis.unread.push(what);
        }
    }
    fn name_blind_spot(&mut self, what: &str) {
        if !self.basis.blind_spots.iter().any(|s| s == what) {
            self.basis.blind_spots.push(what.to_string());
        }
    }
}

/// `G38.2` is one word, not `G38` followed by `.2` — scale by ten so every code
/// is an exact integer and `G4` (dwell) can never be confused with `G40`
/// (cutter comp off).
fn code_of(g: f64) -> i64 {
    (g * 10.0).round() as i64
}

/// Split one block into its words. A letter with no parsable number becomes NaN
/// so the caller can name it rather than silently treat it as zero.
fn block_words(line: &str) -> Vec<(char, f64)> {
    /* Bytes, so the shared scanner can index them. A G-code word letter is
     * ASCII by definition, and a multi-byte character in a comment is never a
     * word letter — so byte indexing cannot land inside one. */
    let up = line.to_ascii_uppercase();
    let b_bytes = up.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b_bytes.len() {
        let c = b_bytes[i] as char;
        if c.is_ascii_alphabetic() {
            /* 🔴 `feeds::word_value_at`, NOT A RE-TYPED SCAN. All three
             * readers of this dialect now call it. It was re-authored by hand
             * once — in the commit whose stated purpose was closing the drift
             * between them — and the copy accepted a sign anywhere in the run,
             * so `G1 X10-20` gave X=10 here and NaN in the hold-down reader.
             * Same program, two answers, from a rule typed twice. */
            let (v, j) = match crate::feeds::word_value_at(b_bytes, i + 1) {
                Some(x) => x,
                None => {
                    // A letter with nothing numeric after it. NaN so the caller
                    // can name it, rather than a word that quietly vanishes.
                    out.push((c, f64::NAN));
                    i += 1;
                    continue;
                }
            };
            out.push((c, v));
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Comments do not nest in this dialect, and the post guarantees it by
/// sanitising every interpolated string — so a single scan is enough.
///
/// ⚠ **AND IT IS `feeds::strip_comments`, NOT A THIRD COPY OF IT.** This was a
/// byte-identical reimplementation sitting under a comment that said *"comments
/// do not nest in this dialect"* while `feeds::strip_comments` says *"`(` NESTS
/// and `;` only counts outside it"* — two functions, same behaviour, contrary
/// explanations, and a reader who found one would have taken its account as the
/// rule. Both statements describe the same code; the depth counter is what makes
/// the nesting claim the accurate one.
fn strip_comment(line: &str) -> String {
    crate::feeds::strip_comments(line)
}

/// Distance an axis moves in this block. `None` = the axis had a target but the
/// machine's current value is unknown, so the distance cannot be known either.
fn axis_delta(cur: Option<f64>, word: Option<f64>, absolute: bool) -> Option<f64> {
    match (word, absolute) {
        (None, _) => Some(0.0),
        // An incremental word IS the distance, even from an unknown position —
        // which is how the `G91 G0 Z2` retract between the two probe passes gets
        // counted at all.
        (Some(v), false) => Some(v),
        (Some(v), true) => cur.map(|c| v - c),
    }
}

fn axis_target(cur: Option<f64>, word: Option<f64>, absolute: bool) -> Option<f64> {
    match (word, absolute) {
        (None, _) => cur,
        (Some(v), true) => Some(v),
        (Some(v), false) => cur.map(|c| c + v),
    }
}

/// Read the numbers back out of an emitted program.
///
/// `machine` is consulted for exactly TWO things the text does not carry: the
/// rapid rate, because `G0` has no F word, and the operator time at an `M0`,
/// because how long a person takes is not in the file. Everything else — every
/// coordinate, every feed, every dwell — comes from the program.
fn summarize_program(gcode: &str, machine: &Machine) -> Emitted {
    let mut e = Emitted::default();

    // 🔴 Recorded BEFORE the empty-program return, not after. A basis that said
    // `tool_change_seconds: <default>` for a machine that declares 300 would be
    // describing a rate this core would never charge — the report's account of
    // itself has to be true even on the path where there is nothing to account
    // for.
    let (tool_change_seconds, declared) = match machine.tool_change_seconds {
        Some(v) => (v, true),
        None => (DEFAULT_TOOL_CHANGE_SECONDS, false),
    };
    e.basis.tool_change_seconds = tool_change_seconds;
    e.basis.tool_change_rate_declared = declared;

    if gcode.trim().is_empty() {
        return e;
    }
    e.basis.from_emitted_program = true;

    let rapid_mm_s = machine.rapid_mm_min.max(1.0) / 60.0;
    let (mut x, mut y, mut z): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    let mut absolute = true;
    let mut feed: Option<f64> = None;
    /* WHY `feed` is `None`, which is not the same question as WHETHER it is.
     * "no F word has been seen yet" and "an F word was seen and refused" are
     * different events with different fixes, and the message below reported the
     * first for both. */
    let mut feed_rejected = false;

    for raw in gcode.lines() {
        let line = strip_comment(raw);
        if line.trim().is_empty() {
            continue;
        }
        let words = block_words(&line);
        let get = |l: char| words.iter().rev().find(|(c, _)| *c == l).map(|(_, v)| *v);
        /* Set when the `F` arm below has already named this block's F word, so
         * the non-finite sweep does not name the SAME word a second time.
         * `G1 X10 F6.0.0` produced two distinct strings — the F rejection and
         * the sweep — and because they differ, `name_unread`'s dedup cannot
         * collapse them: two of the eight slots for one block. */
        let mut f_named = false;
        if let Some(f) = get('F') {
            if f.is_finite() && f > 0.0 {
                feed = Some(f);
                feed_rejected = false;
            } else {
                /* 🔴 AND THE REJECTION IS NAMED. Without this `else` the PREVIOUS
                 * feed silently governed the block — which is the exact defect
                 * the whitespace fix closed, on the other input class: `F0` and
                 * a negative both fell through here and the summary showed a
                 * confident run time for a program grblHAL halts on (`error:22`,
                 * tool down). Not dividing by zero and SAYING NOTHING are
                 * separable, and only the first is required.
                 *
                 * ⚠ `feed = None` PERSISTS, and the reason it gave downstream
                 * was wrong: every later cutting block reported *"a cutting block
                 * before any F word"*, which is not what happened — an `F` was
                 * seen and REFUSED. grblHAL halts at `error:22` so nothing after
                 * it runs on a machine, but the estimator does not know that, and
                 * a named reason that describes the wrong event sends a reader to
                 * the wrong place.
                 *
                 * 🔴 THIS PARAGRAPH SAID "was wrong UNTIL 2026-08-28" FOR A DAY
                 * WHILE THE CODE STILL DID IT. The distinction now exists —
                 * `feed_rejected` carries it and the arm downstream reads it —
                 * but the sentence claiming so landed a round before the code.
                 * A comment explaining why a control is right is the least
                 * audited thing in this file. */
                e.name_unread(
                    "an F word that is zero, negative or unreadable — this block's time is not \
                     counted, the feed before it does not carry into it, and every cutting block \
                     after it is uncounted for the same reason until a valid F word appears"
                        .to_string(),
                );
                feed = None;
                feed_rejected = true;
                f_named = true;
            }
        }

        // Modes first: a block may carry both a mode and a motion word
        // (`G98 G83 ...`), and the mode has to be in force when the motion is
        // read.
        /* 🔴 `code_of` IS `(g * 10.0).round() as i64`, AND A RUST FLOAT->INT CAST
         * MAPS NaN TO 0. So an unparsable `G` word — exactly the NaN this
         * splitter produces "so the caller can name it" — matched the
         * `0 | 10 | 20 | 30` arm and was CHARGED AS A G0 RAPID, using the
         * block's X/Y/Z, into `rapid_mm` and into `seconds`. That is the
         * "silently treat it as zero" failure the splitter's own doc says cannot
         * happen, one cast along. Named here instead; the `other =>` arm below
         * could never see it. */
        /* 🔴 EVERY WORD, NOT JUST THE ONES THAT SELECT A BRANCH. The first
         * version of this audit covered `G`, `M` and `F` — the words whose value
         * chooses a code path — and left the ones that carry a DISTANCE. A NaN
         * `X` reaches `axis_delta`, `cur.map(|c| NaN - c)` is `Some(NaN)`,
         * `known` is true, and `cut_mm`/`rapid_mm`/`seconds` become NaN for the
         * rest of the program with nothing named. The operator then reads `—`
         * with no reason beside it.
         *
         * ⚠ THE BELT THIS COMMENT USED TO CITE IS NOT A BELT (corrected
         * 2026-08-28). It read "latent — the post cannot emit an unparsable word
         * and `audit_finite_words` checks the bytes". `audit_finite_words`
         * refuses only words whose value PARSES to a non-finite float, and its
         * own body says a word that does not parse at all is *"a separate defect
         * and not this function's"*; it also splits on whitespace, so it cannot
         * see `F 600` or `G1X1`. `X1.2.3` and `X10-20` both walk past it. What
         * makes this latent for lane-emitted programs is the by-construction
         * float formatting and nothing else — and this reader is pointed at
         * files this lane did NOT emit, where neither holds. Naming a control
         * that does not cover the case is worse than naming none, because the
         * next reader stops checking. */
        let gs: Vec<i64> = words
            .iter()
            .filter(|(c, v)| *c == 'G' && v.is_finite())
            .map(|(_, v)| code_of(*v))
            .collect();
        for g in &gs {
            match g {
                900 => absolute = true,
                910 => absolute = false,
                200 => e.name_blind_spot(
                    "the program declares G20 (inches); these distances are reported in \
                     millimetres and are NOT converted",
                ),
                _ => {}
            }
        }

        /* 🔴 THE MODE WORDS ARE APPLIED **BEFORE** THIS SKIP, and the first
         * version of this guard was above them — which traded a NaN for a
         * SILENTLY WRONG NUMBER, the worse of the two.
         *
         * `G91 X1.2.3` carries an unreadable axis word AND a mode change. With
         * the skip first, `absolute = false` never ran and every distance in the
         * REST OF THE PROGRAM was computed in absolute mode against an
         * incremental program. A NaN reaches the operator as `—`; a wrong
         * distance reaches them as a number.
         *
         * So: modes above, motion below. What is skipped is this block's
         * DISTANCE AND TIME — which is unmodelled and said so — not the state
         * every later block reads. */
        /* WHY THIS BLOCK IS SKIPPED AT ALL — Naming alone was not enough, and the test
         * for this failed on its first run: a NaN `X` still reached
         * `axis_delta`, `cur.map(|c| NaN - c)` gave `Some(NaN)` with `known ==
         * true`, and `cut_mm` / `rapid_mm` / `seconds` went NaN for the REST OF
         * THE PROGRAM. The operator then reads `—` with no reason beside it.
         *
         * A block this reader cannot parse contributes NOTHING and says so. That
         * under-reports the estimate, which is the direction `EstimateBasis`
         * already models and reports; poisoning every later figure is not. */
        if let Some((c, _)) = words
            .iter()
            .find(|(c, v)| !v.is_finite() && !(*c == 'F' && f_named))
        {
            e.name_unread(format!(
                "a `{c}` word whose value could not be read — this block is not modelled, its \
                 distance and time are not counted, and the tool's position is unknown from here \
                 until the program states it again"
            ));
            /* 🔴 THE MAGNITUDE, NOT ONLY THE DIRECTION. `name_unread` dedups and
             * caps at 8, and the message above is byte-identical for every `X`
             * word — so 500 skipped blocks produced ONE line and moved no
             * counter. The direction of the error was modelled and reported;
             * how much of the program it ate was not, and "1 unread" reads like
             * one bad block.
             *
             * A block carrying an axis word is a motion block by G-code's modal
             * rule whether or not it names a motion code, so it is counted as
             * one whose distance could not be measured — which is what it is. */
            if words
                .iter()
                .any(|(c, _)| matches!(c, 'X' | 'Y' | 'Z' | 'I' | 'J'))
            {
                e.basis.motion_blocks += 1;
                e.basis.unmeasured_moves += 1;
            }
            /* 🔴 AND THE POSITION IS NOW UNKNOWN — the second half of the same
             * defect, found by review after the mode-order fix (2026-08-28).
             *
             * Skipping the block left `x`/`y`/`z` at their PREVIOUS values, so
             * `G0 X200 Y0 Z1.2.3` was skipped with `x` still 0 and the next
             * block `G1 X200 Y0 Z-3 F600` charged `dx = 200` as CUTTING at F600
             * instead of a 200 mm rapid plus a 4 mm plunge. The mirror case
             * under-reports: `G1 X100 F6.0.0` skipped, then `G1 X0 F600` gives
             * `dx = 0` and 200 mm of real cutting vanishes.
             *
             * So the comment that used to sit here — "contributes NOTHING, which
             * under-reports" — was wrong in BOTH directions. It is a wrong
             * number, not a missing one, which is the exact trade the mode-order
             * fix exists to prevent, one line further down.
             *
             * `None` is the honest state: the next motion block reads
             * `known == false` and lands in `unmeasured_moves` instead of
             * producing a confident delta from a point the tool may not be at.
             * Cleared unconditionally, including for a block with no axis word
             * (`M6 T1.2.3`): the letter of a word is always readable but its
             * value is not, and this reader cannot rule out a motion it could
             * not parse. The cost is one extra unmeasured move; the cost of the
             * other choice is a number.
             *
             * ⚠ `M0`'s `z = None`, `G10 L20`'s re-datum and `G38.x`'s position
             * invalidation are ALL below this `continue` too. Clearing here
             * covers each of them for position — but a `G10 L20` this reader
             * skipped still leaves later blocks in the OLD work offset, which
             * only a `G10` it can read will correct. Named, not silently
             * assumed. */
            x = None;
            y = None;
            z = None;
            continue;
        }

        let mut motion_seen = false;
        for g in &gs {
            match g {
                // Modes and settings with no motion of their own — and this list
                // is deliberately SHORT. It holds what this post actually writes
                // plus codes that cannot move an axis or change what a word
                // means. `G43` (tool length offset) and `G93` (inverse time) are
                // NOT here on purpose: both would silently change what the
                // following blocks mean, so they must be named rather than
                // waved through. An ignore list is where a reader goes blind.
                170 | 180 | 190 | 200 | 210 | 400 | 490 | 540 | 550 | 560 | 570 | 580 | 590
                | 800 | 900 | 910 | 940 | 980 | 990 => {}

                // G4 P<seconds> — the spin-up dwell after M3, and any explicit
                // pause. Real machine time, and it is in the text.
                40 => {
                    motion_seen = true;
                    if let Some(p) = get('P') {
                        if p.is_finite() {
                            e.seconds += p;
                        }
                    }
                }

                // G10 L20 — the probe result written to the WCS. It REDEFINES
                // the frame rather than moving the machine: no distance, and the
                // position becomes exactly known again in the new frame. A
                // reader that treated this as a move would charge the whole
                // touch-plate offset as travel.
                100 => {
                    motion_seen = true;
                    // Only L20 ("the tool is HERE, and here is called this").
                    // G10 L2 rewrites a work offset the tool is not standing in,
                    // which is a different fact about a different frame — named
                    // rather than guessed at.
                    if get('L').map(|l| (l - 20.0).abs() < 1e-9).unwrap_or(false) {
                        if let Some(v) = get('X') {
                            x = Some(v);
                        }
                        if let Some(v) = get('Y') {
                            y = Some(v);
                        }
                        if let Some(v) = get('Z') {
                            z = Some(v);
                        }
                    } else {
                        e.name_unread(
                            "a G10 that is not L20 — it moves a coordinate system this reader \
                             does not track, so positions after it are not trusted"
                                .into(),
                        );
                        x = None;
                        y = None;
                        z = None;
                    }
                }

                // G0/G1/G2/G3
                0 | 10 | 20 | 30 => {
                    motion_seen = true;
                    let dx = axis_delta(x, get('X'), absolute);
                    let dy = axis_delta(y, get('Y'), absolute);
                    let dz = axis_delta(z, get('Z'), absolute);
                    let known = dx.is_some() && dy.is_some() && dz.is_some();
                    let (dx, dy, dz) = (dx.unwrap_or(0.0), dy.unwrap_or(0.0), dz.unwrap_or(0.0));

                    let d = if *g == 20 || *g == 30 {
                        // An emitted arc travels the ARC, not the chord. This is
                        // the whole reason an arc degraded to G1 by the post
                        // must change these numbers: same endpoints, shorter
                        // path, different time.
                        match (x, y, get('I'), get('J')) {
                            (Some(cx), Some(cy), Some(i), Some(j)) => {
                                let (ox, oy) = (cx + i, cy + j);
                                let r = ((cx - ox).powi(2) + (cy - oy).powi(2)).sqrt();
                                let a0 = (cy - oy).atan2(cx - ox);
                                let a1 = (cy + dy - oy).atan2(cx + dx - ox);
                                let mut sweep = a1 - a0;
                                if *g == 20 {
                                    while sweep >= 0.0 {
                                        sweep -= std::f64::consts::TAU;
                                    }
                                } else {
                                    while sweep <= 0.0 {
                                        sweep += std::f64::consts::TAU;
                                    }
                                }
                                ((r * sweep).powi(2) + dz.powi(2)).sqrt()
                            }
                            // No start position: already counted as unmeasured
                            // below, and an arc's length genuinely cannot be
                            // known without one.
                            (_, _, Some(_), Some(_)) => 0.0,
                            _ => {
                                e.name_unread(
                                    "an arc block with no I/J centre — grblHAL would reject it, \
                                     and its length is not counted here"
                                        .into(),
                                );
                                0.0
                            }
                        }
                    } else {
                        (dx * dx + dy * dy + dz * dz).sqrt()
                    };

                    if !known {
                        e.basis.unmeasured_moves += 1;
                    }
                    e.basis.motion_blocks += 1;
                    if d > 0.0 && d <= SHORT_MOVE_MM {
                        e.basis.short_moves += 1;
                    }
                    if *g == 0 {
                        e.rapid_mm += d;
                        e.seconds += d / rapid_mm_s;
                    } else {
                        e.cut_mm += d;
                        match feed {
                            Some(f) => e.seconds += d / (f / 60.0),
                            /* This block's OWN F word was just named, three
                             * screens up, in a message that already says its
                             * time is not counted. Saying it again spends a
                             * second of the eight `name_unread` slots on one
                             * block. */
                            None if f_named => {}
                            /* 🔴 THE REASON, NOT A REASON. This arm reported "a
                             * cutting block before any F word" for BOTH causes,
                             * and a comment above `feed = None` claimed the
                             * distinction had been fixed on 2026-08-28 — it
                             * described a fix that was never in the code, which
                             * is the least-audited kind of wrong thing in this
                             * lane. An operator reading "before any F word" on a
                             * program whose first line is `F600` goes looking
                             * for a missing word instead of a refused one. */
                            None if feed_rejected => e.name_unread(
                                "a cutting block after an F word this reader refused — the feed \
                                 before that word does not carry into it and its time is not \
                                 counted, until a valid F word appears"
                                    .into(),
                            ),
                            None => e.name_unread(
                                "a cutting block before any F word — its time is not counted".into(),
                            ),
                        }
                    }

                    x = axis_target(x, get('X'), absolute);
                    y = axis_target(y, get('Y'), absolute);
                    z = axis_target(z, get('Z'), absolute);
                    if let Some(zz) = z {
                        e.deepest_z = Some(e.deepest_z.map_or(zz, |d: f64| d.min(zz)));
                    }
                }

                // G38.x — probing. Charged as a feed move to the commanded
                // target, and its distance is added to NEITHER total: a probe is
                // not cutting and it is not positioning. The tool then stops
                // wherever the plate is, so the probed axes become UNKNOWN —
                // getting that wrong would charge the next move a distance from
                // a place the tool is not.
                380..=389 => {
                    motion_seen = true;
                    let dz = axis_delta(z, get('Z'), absolute).unwrap_or(0.0);
                    let dx = axis_delta(x, get('X'), absolute).unwrap_or(0.0);
                    let dy = axis_delta(y, get('Y'), absolute).unwrap_or(0.0);
                    let d = (dx * dx + dy * dy + dz * dz).sqrt();
                    match feed {
                        Some(f) if d > 0.0 => e.seconds += d / (f / 60.0),
                        _ => {}
                    }
                    if get('X').is_some() {
                        x = None;
                    }
                    if get('Y').is_some() {
                        y = None;
                    }
                    if get('Z').is_some() {
                        z = None;
                    }
                }

                // G81/G82/G83 — a canned cycle. The block states the hole and
                // the depth, so the positioning rapid and the plunge ARE
                // measurable. The pecking is expanded by the CONTROLLER and
                // appears nowhere in the text, so it is named as a blind spot
                // rather than guessed at.
                810 | 820 | 830 => {
                    motion_seen = true;
                    e.basis.motion_blocks += 1;
                    let initial_z = z;
                    let tx = axis_target(x, get('X'), absolute);
                    let ty = axis_target(y, get('Y'), absolute);
                    let dxy = match (x, y, tx, ty) {
                        (Some(cx), Some(cy), Some(nx), Some(ny)) => {
                            ((nx - cx).powi(2) + (ny - cy).powi(2)).sqrt()
                        }
                        _ => 0.0,
                    };
                    e.rapid_mm += dxy;
                    e.seconds += dxy / rapid_mm_s;

                    let r_plane = get('R').or(initial_z);
                    let depth = get('Z');
                    if let (Some(r), Some(zt)) = (r_plane, depth) {
                        // Down to the R plane at rapid, then cut to depth.
                        if let Some(cz) = initial_z {
                            let d = (cz - r).abs();
                            e.rapid_mm += d;
                            e.seconds += d / rapid_mm_s;
                        }
                        let plunge = (r - zt).abs();
                        e.cut_mm += plunge;
                        if let Some(f) = feed {
                            e.seconds += plunge / (f / 60.0);
                        }
                        // ...and back out. G98 retracts to the initial Z, G99 to
                        // the R plane; the post writes G98.
                        let back_to = if gs.contains(&990) { r } else { initial_z.unwrap_or(r) };
                        let d = (back_to - zt).abs();
                        e.rapid_mm += d;
                        e.seconds += d / rapid_mm_s;
                        e.deepest_z = Some(e.deepest_z.map_or(zt, |d: f64| d.min(zt)));
                        z = Some(back_to);
                    }
                    if let Some(p) = get('P') {
                        if *g == 820 && p.is_finite() {
                            e.seconds += p;
                        }
                    }
                    if get('Q').is_some() {
                        e.name_blind_spot(
                            "a peck cycle's retract/return laps are expanded by the controller and \
                             are not in the program — only the plunge is counted",
                        );
                    }
                    x = tx;
                    y = ty;
                }

                other => {
                    motion_seen = true;
                    e.name_unread(format!("G{} — not understood by the estimator", *other as f64 / 10.0));
                }
            }
        }

        for (c, v) in &words {
            if *c != 'M' {
                continue;
            }
            /* Same cast, same trap: an unparsable `M` mapped to 0 and matched
             * the M0 arm — `pauses += 1` and a full tool-change charge added to
             * the operator's estimate for a word nobody could read. */
            // Already named by the sweep above; this only stops the NaN->0 cast
            // charging a tool-change pause for a word nobody could read.
            if !v.is_finite() {
                continue;
            }
            motion_seen = true;
            match code_of(*v) {
                // The manual tool change. Position in XY is unchanged — nothing
                // moved — but Z is now referenced to a DIFFERENT tool length, so
                // it is unknown until the re-probe writes a new WCS.
                0 => {
                    e.pauses += 1;
                    // The DECLARED rate — resolved once at the top of this
                    // function, never re-read and never a literal. `+=
                    // TOOL_CHANGE_SECONDS` is what this line used to be, and
                    // that constant no longer exists to be added.
                    e.seconds += tool_change_seconds;
                    e.basis.tool_changes_charged += 1;
                    z = None;
                }
                // M3/M5/M8/M9/M30 cost no motion of their own; the spin-up is
                // the G4 the post writes after M3, and that is counted above.
                30 | 40 | 50 | 70 | 80 | 90 | 300 => {}
                other => e.name_unread(format!("M{} — not understood by the estimator", other / 10)),
            }
        }

        if !motion_seen && words.iter().any(|(c, _)| matches!(c, 'X' | 'Y' | 'Z' | 'I' | 'J')) {
            // A block with coordinates and no motion word relies on a modal
            // motion mode this reader does not track. The post never writes one
            // — and if it starts to, the distance would silently vanish from the
            // total, so it is named.
            e.name_unread(format!("a block with coordinates and no motion word: {}", line.trim()));
        }
    }

    e
}

/// The collet fact, short enough to live in the program the operator reads at
/// the machine. `None` when the collet already in the spindle holds this shank
/// and there is genuinely nothing to say.
///
/// # Why this exists rather than a `format!` at the call site
///
/// Four outcomes, and **three of them are different sentences that a boolean
/// would collapse into one**:
///
///   * **fit by a spare, spindle collet DECLARED** — an instruction. Go and get
///     that collet before you fit this cutter.
///   * **fit by a spare, spindle collet UNDECLARED** — *not* an instruction. A
///     collet in the drawer would hold the shank, and nothing has said what is
///     in the spindle right now, so "fit the 3.175mm one" would assert a change
///     nobody has established is needed. It is UNCHECKED, said as UNCHECKED.
///   * **[`ColletVerdict::Undeclared`] with no spare that fits** — nothing
///     anywhere in this machine's description has been compared against this
///     shank. A check that did not run, never a check that passed.
///   * **too large / too small** — `None`, **and that is the measured answer,
///     not an omission.** These two are already [`JobResult::refusals`], which
///     makes [`JobResult::is_runnable`] false, and every host withholds the file
///     on that: `report plate --config '{"machine":{"collet_mm":3.175}}'` →
///     `ok=false`, `len(gcode)==0`. A comment on a branch whose program is never
///     written would be a control with no consumer, and this lane has been
///     bitten by exactly that shape before. If a host ever starts emitting text
///     for a refused job, the sentence belongs here — but it is not written
///     today on the strength of a `match` arm looking complete.
///

/// ⚠ **No parentheses in any branch** — grblHAL cannot nest them and the post
/// rewrites them to `_`, the constraint [`crate::toolpath::OffMaterial::program_comment`]
/// records. And **no bare `X`/`Y`/`Z` followed by a number**, because
/// `RunTab.tsx`'s sender reads coordinate words and has to special-case words
/// inside comments already.
fn collet_program_comment(
    tool_name: &str,
    shank_mm: f64,
    verdict: &ColletVerdict,
    fit_by_spare: Option<f64>,
    machine_collet_mm: f64,
) -> Option<String> {
    match (verdict, fit_by_spare) {
        (ColletVerdict::Fits, None) => None,
        (ColletVerdict::Fits, Some(c)) if machine_collet_mm > 0.0 => Some(format!(
            "collet: FIT THE {c:.3}mm COLLET before {tool_name} — its shank is {shank_mm:.3}mm \
             and the collet this machine declares as fitted is {machine_collet_mm:.3}mm. A shank \
             in the wrong collet does not grip and is thrown"
        )),
        // A spare would hold it, but nothing declared what is in the spindle, so
        // "fit the spare" would be an instruction resting on an unknown.
        (ColletVerdict::Fits, Some(c)) => Some(format!(
            "collet UNCHECKED for {tool_name}: this machine declares NO fitted collet, so nothing \
             has established what is in the spindle. A {c:.3}mm collet is listed in the drawer and \
             would hold the {shank_mm:.3}mm shank — check the spindle yourself before starting"
        )),
        (ColletVerdict::Undeclared, _) => Some(format!(
            "collet UNCHECKED for {tool_name}: this machine declares no collet size and lists no \
             spare that holds a {shank_mm:.3}mm shank, so the fit was NOT checked. That is a check \
             which did not run, not a check that passed"
        )),
        // See the header: both are refusals, a refused job emits no program, and
        // a comment nobody can ever read is not a warning.
        (ColletVerdict::TooLarge { .. } | ColletVerdict::TooSmall { .. }, _) => None,
    }
}

/// Plan the whole job.
pub fn plan_job(job: &Job) -> JobResult {
    let mut res = JobResult::default();

    // 🔴 Technology first, before anything is planned. A job for a process this
    // build cannot make is refused HERE — posting it through the CNC dialect
    // would emit spindle commands for a machine that has no spindle, and the
    // program would look entirely well-formed.
    if crate::post::for_technology(job.technology).is_none() {
        res.refusals.push(Refusal {
            what: job.name.clone(),
            why: format!(
                "this build has no post-processor for {} — the process is declared but not \
                 implemented, and posting it as CNC would emit commands for hardware it does \
                 not have",
                job.technology.as_str()
            ),
        });
        return res;
    }

    // 🔴 Second, and for the same reason: a feature the selected tool set cannot
    // cut. The operation still carries whatever tool it was built with, so
    // planning on would emit a program cut with a tool nobody chose — the exact
    // shape of failure that made `JobConfig::tool_id` collapse a multi-tool job
    // to one tool without saying so. No path is produced, so there is nothing to
    // post by mistake.
    if !job.tool_set_refusals.is_empty() {
        res.refusals.extend(job.tool_set_refusals.iter().cloned());
        return res;
    }

    // 🔴 A tool-change rate that is not a duration. NaN and a negative both
    // reach `estimated_seconds` and both survive every check downstream of it:
    // NaN makes the total NaN while the program stays perfectly runnable, and a
    // negative SUBTRACTS operator time, so more tool changes make the job read
    // as shorter — the exact direction an operator would never suspect.
    //
    // ⚠ Said plainly, because this lane's refusals normally guard a cut and
    // this one does not: **the failure here is a wrong NUMBER, not a wrong
    // cut.** It is refused rather than clamped for the same reason a substituted
    // tool was — a value silently corrected to something plausible is a value
    // nobody is told about — and NOT because it endangers anything. Absent is a
    // different case entirely and is not refused: see
    // [`Machine::tool_change_seconds`].
    if let Some(v) = job.machine.tool_change_seconds {
        if !v.is_finite() || v < 0.0 {
            res.refusals.push(Refusal {
                what: job.name.clone(),
                why: format!(
                    "the machine declares a tool-change time of {v} seconds, which is not a \
                     duration. It is charged once per `M0` in the run-time estimate, so a \
                     non-finite value makes the whole estimate NaN and a negative one makes a \
                     job with more tool changes read as shorter — in both cases beside a program \
                     that looks entirely runnable. Declare 0 for an ATC or a shop that does not \
                     count operator time, or leave it undeclared to fall back to \
                     {DEFAULT_TOOL_CHANGE_SECONDS:.0}s. This refusal is about the NUMBER in the \
                     report, not about the safety of the cut"
                ),
            });
            return res;
        }
    }

    if !job.stock.fits(&job.machine) {
        let (fx, fy) = job.stock.footprint();
        // Say what would work. A refusal that names the quarter turn is the
        // difference between "this machine cannot cut your workpiece" and "turn the
        // workpiece" — and for a 600x900 workpiece on 1250x670 the second is the truth.
        let turn = job.stock.quarter_turn_that_fits(&job.machine);
        let advice = match turn {
            Some(deg) => format!(" — it fits turned {deg:.0} degrees"),
            None => String::new(),
        };
        // ...and the same answer as a fix a UI can offer as a button. When there
        // is no quarter turn that fits, NOTHING is offered: the workpiece is bigger
        // than the machine and no setting in this program changes that.
        if let Some(deg) = turn {
            res.offered_fixes.push(OfferedFix::sheet_quarter_turn(
                job.stock.rotation_deg,
                job.stock.rotation_deg + deg,
                format!(
                    "the {:.0}x{:.0}mm workpiece laid at {:.0} degrees covers {:.0}x{:.0}mm of the \
                     machine's {:.0}x{:.0}mm travel; at {:.0} degrees it does not",
                    job.stock.size_x_mm,
                    job.stock.size_y_mm,
                    job.stock.rotation_deg,
                    fx,
                    fy,
                    job.machine.travel_x_mm,
                    job.machine.travel_y_mm,
                    job.stock.rotation_deg + deg,
                ),
            ));
        }
        res.refusals.push(Refusal {
            what: job.name.clone(),
            why: format!(
                "workpiece {:.0}x{:.0}mm laid at {:.0} degrees covers {:.0}x{:.0}mm of the machine's \
                 {:.0}x{:.0}mm travel{advice}",
                job.stock.size_x_mm,
                job.stock.size_y_mm,
                job.stock.rotation_deg,
                fx,
                fy,
                job.machine.travel_x_mm,
                job.machine.travel_y_mm
            ),
        });
        return res;
    }

    // A workpiece off the quarter turns is arithmetic we can do and a registration
    // we cannot check. Warned, not refused: with a jig it is a real placement,
    // and refusing it would be inventing a constraint the machine does not have.
    if !job.stock.is_square_to_the_bed() {
        res.notes.push(format!(
            "the workpiece is laid at {:.2} degrees, which is not a quarter turn — it cannot be \
             registered against the machine's own axes, so every coordinate below assumes the \
             workpiece ended up at EXACTLY that angle",
            job.stock.rotation_deg
        ));
    }

    // ---- material and datum, applied ONCE, before anything is planned -----
    //
    // 🔴 Both of these were fields nothing read. A setting that is stored,
    // displayed, and consumed nowhere reads as configured and changes no
    // coordinate — the same defect as a Z-datum option that moved no Z.
    let mut ops = job.operations.clone();
    let m = job.material;
    // 🔴 THE MACHINE'S OWN FEED CEILING, ON THIS DOOR AT LAST. Measured on the
    // control binary at HEAD `4e9bb8c758`, `job plate --config
    // '{"tool_id":"End Mill - Down-cut 6mm 2F","machine":{"max_feed_mm_min":900}}'`:
    // the emitted program carried **F3600.0**, byte-identical to the run with no
    // ceiling declared at all. `recommend.rs` has obeyed it since
    // `a6c3816e66`; this door derived its feed here and never asked.
    //
    // ⚠ Which door a job enters is not a developer's choice — `web/src/App.tsx`
    // sends `tool_ids` when more than one cutter is selected and `tool_id`
    // otherwise, so **selecting a second cutter used to be what turned the feed
    // ceiling on.**
    let ceiling = job.machine.max_feed_mm_min;
    for op in &mut ops {
        // 🔴 A feed the CALLER TYPED, read before anything below can move it.
        // `<= 0.0` is this repo's "derive one" and it is a different fact from a
        // declaration — the two are told apart HERE, once, and never re-guessed
        // from a value further down.
        let pinned = op.params.feed_mm_min;
        // Depth per pass is bounded by what the material will take. Aluminium
        // at a full-diameter depth of cut stalls the spindle or snaps the tool.
        let max_doc = op.tool.diameter_mm * m.max_doc_ratio(job.machine.machine_class);
        if op.params.depth_per_pass_mm > max_doc {
            res.notes.push(format!(
                "{}: depth per pass reduced from {:.2} to {:.2}mm — {} will not take a deeper \
                 cut with a {:.2}mm tool",
                op.name,
                op.params.depth_per_pass_mm,
                max_doc,
                m.as_str(),
                op.tool.diameter_mm
            ));
            op.params.depth_per_pass_mm = max_doc;
        }
        if op.params.rpm > m.max_rpm() {
            res.notes.push(format!(
                "{}: spindle reduced from {:.0} to {:.0} rpm — above that, {} welds to the flutes",
                op.name,
                op.params.rpm,
                m.max_rpm(),
                m.as_str()
            ));
            op.params.rpm = m.max_rpm();
        }

        // ---- the feed, and the machine's ceiling, and never the chip --------
        //
        // 🔴 THE CEILING IS OBEYED BY TAKING THE SPINDLE DOWN, NOT BY THINNING
        // THE CHIP. `feed.min(ceiling)` at unchanged rpm can only come out of
        // the chip — `feed = rpm x flutes x chip` — and a chip below the
        // cutter's own rated minimum does not cut, it rubs. `crate::feeds`
        // carries the arithmetic and the measurement; this is its second
        // production caller, `recommend::limits_for` being the first. The two
        // doors now answer the same question with the same function rather than
        // with two copies of a machining rule.
        //
        // Whether THIS operation came out of the block below with a pair to
        // run. 🔴 It gates the window check, and it has to: on a refusal
        // `feed_mm_min` is still 0, and a window check run over it reported
        // *"the emitted feed delivers 0.000mm of chip per tooth"* — a sentence
        // about an emitted program that does not exist, printed 21 times beside
        // the refusal that stopped it existing. A note that describes a
        // non-program is the verdict outrunning the check.
        let resolved;
        if pinned > 0.0 {
            // A typed feed is a DECLARATION, and so is the machine's ceiling.
            // When they contradict each other only the person who made both can
            // resolve it, so this refuses and names both numbers. There is no
            // arm of `PinnedFeed` that can hand back a reduced one.
            //
            // ⚠ And the pinned number now SURVIVES the material's rpm cap. Until
            // this change the branch above overwrote it with a derived feed
            // whenever the material took the spindle down — a feed the operator
            // typed, replaced by one they did not, silently. The rpm note beside
            // it says the spindle moved; the note below says what that did to
            // their number.
            match pinned_feed(pinned, ceiling) {
                PinnedFeed::Runnable { feed_mm_min } => {
                    op.params.feed_mm_min = feed_mm_min;
                    resolved = true;
                }
                v @ PinnedFeed::AboveCeiling { .. } => {
                    res.refusals.push(Refusal { what: op.name.clone(), why: v.why() });
                    resolved = false;
                }
            }
        } else {
            // The chip this pairing is aiming for, material factor applied here
            // because `crate::feeds` is material-blind on purpose.
            let chip_mm = op.tool.chipload_mm * m.chipload_factor();
            let rpm_floor = op.tool.rpm_min.max(job.machine.spindle_min_rpm);
            let r = resolve_feed(&op.tool, op.params.rpm, chip_mm, ceiling, rpm_floor);
            match r.rpm_feed() {
                Some((rpm, feed)) => {
                    // BOTH, from the one resolution. Setting the feed and
                    // leaving the rpm behind is the naive clamp wearing a
                    // different shape.
                    op.params.rpm = rpm;
                    op.params.feed_mm_min = feed;
                    let why = r.why();
                    if !why.is_empty() {
                        res.notes.push(format!("{}: {why}", op.name));
                    }
                    resolved = true;
                }
                // 🔴 No number is returned, so none is invented. There is no
                // speed that both runs on this spindle and holds the chip.
                None => {
                    res.refusals.push(Refusal { what: op.name.clone(), why: r.why() });
                    resolved = false;
                }
            }
        }

        // ---- the PLUNGE, which is also a cutting feed -----------------------
        //
        // 🔴 A PLUNGE IS CUTTING. Measured on the control binary at HEAD
        // `026a6c9523`, `job plate --config
        // '{"machine":{"max_feed_mm_min":150},"op":{"feed_mm_min":100}}'`: the
        // lateral feed obeyed the ceiling at F100.0 and the emitted program
        // still carried **22 `G1 Z` lines at F300.0** — 16 plunges to `Z-0.400`
        // and 6 returns to `Z0.000`, all at twice the declared ceiling, on the
        // one move where the tool is driven into solid stock on the part of it
        // that has no cutting edge. The ceiling had been closed on three doors
        // and this axis was not one of them.
        //
        // ⚠ It is judged even when `resolved == false`. An operation that
        // already refused on its lateral feed can ALSO have an over-ceiling
        // plunge, and reporting one fault per run is how the second one is found
        // by the machine — the same reason every operation is judged before the
        // early return below.
        match plunge_feed(op.params.plunge_mm_min, ceiling) {
            PlungeFeed::Runnable { .. } => {}
            v @ PlungeFeed::AboveCeiling { .. } => {
                res.refusals.push(Refusal { what: op.name.clone(), why: v.why() });
            }
        }

        // 🔴 The window check on the EMITTED pair, not on the plan. It is a NOTE
        // and not a refusal for the reason `recommend::limits_for` gives at the
        // same call: every chipload window in `default_library()` bar one is
        // unsourced (`docs/materials-research.md` §3.2), so refusing on it would
        // be a false red resting on the same sand as the false green. The
        // derived path cannot reach it — `resolve_feed` holds the chip by
        // construction — so in practice this speaks about a PINNED feed, which
        // is the one number in this loop nobody has checked against anything.
        if resolved {
            let delivered = chip_verdict(&op.tool, op.params.rpm, op.params.feed_mm_min);
            if !delivered.in_window() {
                res.notes.push(format!("{}: {}", op.name, delivered.why()));
            }
        }

        // Placement: where the part sits on the workpiece, where the workpiece sits on
        // the machine, and which way round it is laid. Applied to the GEOMETRY so
        // every emitted coordinate moves with it — including the travel-limit
        // check and the fixture keepout, which is the point.
        //
        // 🔴 `Job::place`, NOT `Stock::place`. The stock transform alone leaves
        // out the drawing offset, and a part the operator has dragged would then
        // move on screen and in no coordinate the controller ever sees.
        //
        // ⚠ The guard is on the TRANSFORM, not on a list of fields. It used to
        // read `origin_x != 0 || origin_y != 0 || rotation != 0`, which is a
        // hand-maintained copy of "what does `place` depend on" — and the day a
        // fourth term was added (this one) that copy would have skipped it
        // silently, which is a setting that changes nothing while reading as
        // applied. `Placement2D::is_identity` is derived from `place` itself.
        if !job.placement().is_identity() {
            for v in &mut op.contour.verts {
                let (x, y) = job.place(v.x, v.y);
                v.x = x;
                v.y = y;
            }
        }
    }

    // 🔴 A feed that could not be resolved stops the job HERE, with no path
    // built and therefore nothing to post by mistake — the same shape as the
    // tool-set refusal above. Every operation is judged first, so an operator
    // who declared a ceiling nothing in the job can meet is told about all of
    // them at once rather than one per run.
    if !res.refusals.is_empty() {
        return res;
    }

    // ---- the workpiece-edge rule, validated ONCE before anything is planned --
    //
    // 🔴 It is built here, from the JOB, and handed down. The alternative — each
    // planner reading a flag — is the shape that lets one operation take the
    // rule and another miss it, and a part with three edges skipped and the
    // fourth cut for no reason a person can see.
    //
    // ⚠ The rule is NOT applied to the contours here. The decision belongs where
    // the placed geometry and the workpiece meet, which is
    // `plan_profile_with_edge_rule` — deciding it up here would mean deciding it
    // once for a set of operations whose placements differ.
    let edge_rule = if job.use_workpiece_edge {
        let tol = job.workpiece_edge_tolerance_mm;
        // A tolerance that is not a length. NaN compares false against every
        // test, so a NaN tolerance would skip NOTHING while the panel read
        // "on" — a control that is switched on and consumed by nowhere. A
        // negative one is the same, said differently. Refused rather than
        // clamped: a value silently corrected to something plausible is a value
        // nobody is told about.
        if !tol.is_finite() || tol < 0.0 {
            res.refusals.push(Refusal {
                what: job.name.clone(),
                why: format!(
                    "'use the workpiece edge' is on and its tolerance is {tol}mm, which is not a \
                     distance. It decides whether an outline edge is cut or left as the \
                     workpiece's own edge, so it cannot be guessed at: declare a tolerance in \
                     millimetres (the built-in starting point is \
                     {DEFAULT_WORKPIECE_EDGE_TOLERANCE_MM:.3}mm, which is a chosen number and \
                     not a measured one), or turn the option off"
                ),
            });
            return res;
        }
        // 🔴 On every job that carries it, before any per-edge line. What the
        // operator is accepting is a property of the OPTION, not of whichever
        // edges happened to qualify today — so it is said even when nothing was
        // skipped, and the count that follows tells them which case they are in.
        res.notes.push(format!(
            "'use the workpiece edge' is ON at a declared tolerance of {tol:.3}mm: an outline \
             edge lying within that of the workpiece edge is left as the workpiece's own. What it \
             removes is a pass with no material under it — cutting an edge that IS the workpiece \
             edge runs the cutter a tool radius beyond the stock, over bare spoilboard, or past \
             the spoilboard onto frame. What it costs on such an edge: the \
             workpiece edge must be straight and square, the part's dimension becomes the \
             material supplier's tolerance rather than the drawing's, and the datum on that side \
             becomes wherever the workpiece actually is rather than where it was probed. An edge \
             further inside than {tol:.3}mm is cut normally — a near miss left uncut would leave \
             a ribbon of material holding the part, and a near miss CUT still takes the cutter \
             off the stock, which is what the 'cutting off the material' line reports"
        ));
        Some(crate::toolpath::WorkpieceEdgeRule { tolerance_mm: tol })
    } else {
        None
    };

    // ---- route ordering, BEFORE every geometric check, never instead of one --
    //
    // 🔴 `optimise_route` permutes the vector and moves no coordinate. So the
    // fixture keepout (P7), the tab placement (P1), the climb direction (G-DIR)
    // and the travel-limit check all see the SAME SET OF MOVES they would have
    // seen without it — only in a different sequence. That is the whole argument
    // for running it here, and it is exactly why it is not a substitute for any
    // of them. Everything below this line still runs.
    //
    // It runs AFTER the datum has been applied on purpose: the datum is a rigid
    // translation, so it cannot change which order is shortest, and reporting the
    // travel in machine coordinates keeps this number in the same frame as every
    // other number in the report.
    let (ops, route) = optimise_route_with(ops, job.group_order);

    // Group by tool, preserving the caller's ordering within each group.
    let groups = crate::toolpath::group_by_tool(ops);

    // ---- multi-phase clamping ------------------------------------------------
    //
    // When `clamp_phases` is set, the program runs in sequential phases. Each
    // phase uses its own clamp set, and `Move::clamp_change` + `Move::probe()`
    // are inserted at boundaries. Operations are split evenly across phases:
    // with N phases and G groups, phase i gets groups [i*G/N .. (i+1)*G/N).
    //
    // The fixture check runs PER PHASE against that phase's clamps. The global
    // `fixturing.clamps` is ignored when phases are present — the phases carry
    // their own clamp sets.
    let phase_count = job.clamp_phases.as_ref().map_or(1, |p| p.len().max(1));
    let phase_of_group = |gi: usize| -> usize {
        if phase_count <= 1 { 0 } else { gi * phase_count / groups.len() }
    };
    // Validate: each phase must have at least one group.
    if phase_count > 1 && groups.len() < phase_count {
        res.refusals.push(Refusal {
            what: job.name.clone(),
            why: format!(
                "{} clamp phases declared but only {} tool group(s) — each phase needs at least \
                 one group to run",
                phase_count,
                groups.len()
            ),
        });
        return res;
    }
    // Validate: no empty clamp sets.
    if let Some(phases) = &job.clamp_phases {
        for (i, phase) in phases.iter().enumerate() {
            if phase.clamps.is_empty() {
                res.refusals.push(Refusal {
                    what: job.name.clone(),
                    why: format!(
                        "clamp phase {} declares no clamps — every phase must hold the work down",
                        i
                    ),
                });
            }
        }
        if !res.refusals.is_empty() {
            return res;
        }
    }

    let mut moves: Vec<Move> = vec![Move::comment(format!("job: {}", job.name))];
    let mut used: Vec<String> = Vec::new();
    let mut current_phase: Option<usize> = None;

    for (gi, (tool, ops)) in groups.iter().enumerate() {
        // ---- phase boundary --------------------------------------------------
        let phase_idx = phase_of_group(gi);
        let phase_changed = current_phase.map_or(true, |p| p != phase_idx);
        if phase_changed && phase_count > 1 {
            current_phase = Some(phase_idx);
            let phase_label = if let Some(phases) = &job.clamp_phases {
                if let Some(phase) = phases.get(phase_idx) {
                    let label = format!("phase {} — {} clamp(s)", phase_idx, phase.clamps.len());
                    if let Some(note) = &phase.note {
                        format!("{label}: {note}")
                    } else {
                        label
                    }
                } else {
                    format!("phase {phase_idx}")
                }
            } else {
                format!("phase {phase_idx}")
            };
            // Insert clamp-change boundary: retract, M5, comment, M0.
            // The post handles the actual G-code (MoveKind::ClampChange).
            moves.push(Move::clamp_change(&phase_label));
            if job.probe_after_clamp_change {
                moves.push(Move::probe());
            } else {
                res.notes.push(format!(
                    "{phase_label}: Z was NOT re-referenced after the clamp change — every cut \
                     in this phase is wrong by how much the part shifted"
                ));
            }
        }
        // Collet check per tool — a tool that cannot be fitted stops the job
        // here rather than at the machine with a workpiece already clamped down.
        //
        // The fitted collet is tried first, then the spares. A tool change on a
        // router is routinely a collet change as well, so refusing a 3.175mm
        // bit because a 6mm collet happens to be in the spindle right now
        // refuses an ordinary, safe job. What must still be refused is a shank
        // no collet in the shop can hold.
        let fitted = check_collet(tool.shank_mm, job.machine.collet_mm);
        // Which collet out of the drawer settled it, when one did. The size is
        // kept, not just the verdict: `collet_program_comment` has to name the
        // collet an operator must go and fetch, and "a spare fits" does not.
        let mut fit_by_spare: Option<f64> = None;
        let verdict = if fitted == ColletVerdict::Fits {
            fitted
        } else {
            let spare = job
                .machine
                .spare_collets_mm
                .iter()
                .copied()
                .find(|c| check_collet(tool.shank_mm, *c) == ColletVerdict::Fits);
            match spare {
                Some(c) => {
                    fit_by_spare = Some(c);
                    res.notes.push(format!(
                        "{}: needs a collet change to {:.3}mm before it can be fitted",
                        tool.name, tool.shank_mm
                    ));
                    ColletVerdict::Fits
                }
                None => fitted,
            }
        };
        match verdict {
            ColletVerdict::Fits => {}
            ColletVerdict::Undeclared => res.notes.push(format!(
                "{}: the machine declares no collet size, so shank fit was NOT checked",
                tool.name
            )),
            ColletVerdict::TooLarge { shank_mm, collet_mm } => res.refusals.push(Refusal {
                what: tool.name.clone(),
                why: format!(
                    "{shank_mm:.2}mm shank does not fit the {collet_mm:.2}mm collet — \
                     it will not enter the spindle"
                ),
            }),
            ColletVerdict::TooSmall { shank_mm, collet_mm } => res.refusals.push(Refusal {
                what: tool.name.clone(),
                why: format!(
                    "{shank_mm:.2}mm shank is undersize for the {collet_mm:.2}mm collet — \
                     it will slip under load and be thrown"
                ),
            }),
        }

        used.push(tool.name.clone());

        // 🔴 THE COLLET FACT GOES INTO THE PROGRAM, NOT ONLY INTO THE REPORT.
        //
        // Every branch above wrote to `res.notes` or `res.refusals`, and both of
        // those are a PANEL. The person who fits the cutter is holding the `.nc`
        // file, and until 2026-08-12 that file said `( TOOL CHANGE -> End Mill -
        // Down-cut 3.175mm 2F )` and nothing else while the report — somewhere
        // else, on a screen that may not be open — said *"needs a collet change
        // to 3.175mm before it can be fitted"*. Measured on the `multi-tool`
        // fixture: report note present, `gcode.contains("collet") == false`. A
        // 3.175mm shank pushed into the 6mm collet that is actually in the
        // spindle does not grip; it is thrown at 18,000rpm.
        //
        // This is the same argument `off_material.program_comment()` makes forty
        // lines below and it is made in the same function: the physical half of
        // a finding belongs in the artefact the operator reads at the machine.
        //
        // ⚠ It is a SEPARATE comment move and NOT an addition to the tool-change
        // text. `fixture.rs:1913` reads the tool NAME by
        // `strip_prefix("TOOL CHANGE -> ")` and taking the rest, so a clause
        // appended there would silently become part of the cutter's name in
        // `tool_widths_from_program` and every consumer of `MoveOrigin::tool`.
        //
        // ⚠ No parentheses, for the reason `SkippedEdge::describe` gives —
        // grblHAL cannot nest them and the post rewrites them to `_`.
        if let Some(c) = collet_program_comment(&tool.name, tool.shank_mm, &verdict, fit_by_spare, job.machine.collet_mm) {
            moves.push(Move::comment(c));
        }

        // 🔴 A group boundary is NOT always a tool change. `group_by_tool`'s
        // second pass (decision #33) SPLITS one tool's group so a part's holes
        // cut before its outline — two consecutive groups, SAME cutter. Pausing
        // there (`M0` + re-probe) asks the operator to swap a tool for itself
        // and re-reference Z against a length that never changed; worse, on a
        // machine with no probe it REFUSES a single-tool job outright (measured
        // 2026-08-27: `hive-super-end.stl` at one 3.175mm cutter, split into
        // holes+outline groups, refused with "a Z re-reference was requested but
        // the machine has no probe"). Compare by NAME, the same key
        // `group_by_tool` groups on.
        let tool_changed = gi > 0 && groups[gi - 1].0.name != tool.name;
        if tool_changed {
            moves.push(Move::tool_change(tool.name.clone()));
            // 🔴 NOT counted here. `summary.tool_changes` is the number of `M0`
            // blocks in the EMITTED program — planning a change and emitting one
            // are different facts, and only the second reaches the operator.
            if job.probe_after_toolchange {
                moves.push(Move::probe());
            } else {
                res.notes.push(format!(
                    "{}: Z was NOT re-referenced after the tool change — every cut with this \
                     tool is wrong by the difference in tool length",
                    tool.name
                ));
            }
        }

        // rpm belongs to the operation, so the spindle starts after the change
        // with the NEW tool's speed rather than inheriting the old one.
        let rpm = ops.first().map(|o| o.params.rpm).unwrap_or(18_000.0);
        moves.push(Move::spindle_on(rpm));

        for op in ops {
            let r = crate::toolpath::plan_operation_with_edge_rule(
                op,
                &job.machine,
                &job.stock,
                edge_rule.as_ref(),
            );
            res.refusals.extend(r.refusals);
            res.notes.extend(r.notes);
            // 🔴 Stamp the cutter that makes these moves. `Toolpath` carries one
            // tool and a program uses several; the simulation lowers every cell
            // within RADIUS of a move, so an unstamped move is simulated with
            // whichever tool happened to be first. Measured on `multi-tool`:
            // holes at 3.175mm, profiles at 6mm, `path.tool` = 3.175 — every 6mm
            // cut modelled at half its width, which leaves material standing in
            // the model that the real cutter removes.
            let op_r = op.tool.radius_mm();
            moves.extend(r.path.moves.into_iter().map(|mut m| {
                m.tool_r_mm = op_r;
                m
            }));
        }

        moves.push(Move::spindle_off());
    }

    let mut path = Toolpath { moves, tool: groups.first().map(|g| g.0.clone()).unwrap_or_default(), ..Default::default() };
    path.recompute_bounds();

    // ---- does the program still land on the material? ----------------------
    //
    // 🔴 THE SIMULATION'S WINDOW IS THE WORKPIECE, and nothing else told anyone.
    // `simulate_and_check` builds the height map over the placed workpiece
    // footprint, and `sim::check` walks map CELLS — so geometry that has been
    // dragged past the workpiece edge is not judged clean, it is **not visited**.
    // Its keep regions produce no gouges and its remove regions produce no
    // uncut, and the report comes back with the same zeros a correct job has.
    // That is the identical shape as the bed-anchored-sim defect gate DINV
    // exists for: 0 findings meaning "nothing overlapped" rather than "nothing
    // is wrong.
    //
    // It is a NOTE, not a refusal, and that is the honest verdict rather than a
    // soft one: cutting past the edge of the workpiece is a real thing to do (an
    // edge trim, a tab-free drop-out, a fixture cut into the spoilboard), the
    // travel-limit check already refuses what the machine cannot reach, and P7
    // already refuses what would hit a clamp. What nobody could see is that the
    // SIM's silence covered less than it appeared to.
    //
    // 🔴 AND THAT WAS THE WHOLE OF WHAT IT SAID, WHICH IS THE HALF THAT DOES NOT
    // HURT ANYONE (2026-08-11). "Not simulated" is a fact about a CHECK. The fact
    // about the MACHINE is that there is no material out there: past the
    // workpiece edge the cutter is over bare spoilboard, or past the spoilboard
    // onto frame. So the excursion is now measured per MOVE — cutting apart from
    // rapid, because a rapid over the boundary at clearance height is air — and a
    // cutting move out there gets `OffMaterial::strike_note`, which names what is
    // under the cutter instead of what the height map did not cover.
    //
    // ⚠ The measurement changed with it. It was the PROGRAM's bounding box
    // against the WORKPIECE's bounding box; it is now each move against the
    // workpiece's four real edges. Those agree exactly while the workpiece is
    // square to the machine and differ on a free angle, where the box is the
    // forgiving one — so this fires at least as often as it used to and
    // sometimes more. That is the fix, not a regression.
    let off_material = if !path.is_empty() && path.first_nonfinite_move().is_none() {
        crate::toolpath::off_material(&path, &job.stock)
    } else {
        crate::toolpath::OffMaterial::default()
    };
    if off_material.worst_out_mm > 1e-6 {
        res.notes.push(format!(
            "the program reaches {:.2}mm PAST THE EDGE of the workpiece ({:.1}x{:.1}mm at \
             datum {:.1},{:.1}, drawing offset {:.1},{:.1}) — in {} cutting move(s) and {} \
             rapid(s). The simulation now covers the toolpath extent (not just the workpiece), \
             so cuts past the edge ARE checked against the spoilboard where one is declared",
            off_material.worst_out_mm,
            job.stock.size_x_mm,
            job.stock.size_y_mm,
            job.stock.origin_x_mm,
            job.stock.origin_y_mm,
            job.drawing_offset_x_mm,
            job.drawing_offset_y_mm,
            off_material.cutting_moves,
            off_material.rapid_moves,
        ));
    }
    // 🔴 The physical half, and it goes into the PROGRAM as well as the report.
    // Whoever stands at the machine reads the file — the same argument
    // `plan_profile_with_edge_rule` makes for the skipped-edge comments, and the
    // same one that keeps this out of a panel somebody closed an hour ago.
    if let Some(note) = off_material.strike_note() {
        res.notes.push(note);
    }
    if let Some(comment) = off_material.program_comment() {
        path.moves.insert(1.min(path.moves.len()), Move::comment(comment));
    }

    // Fixture check runs on the ASSEMBLED path — an operation is clear of the
    // clamps on its own while the rapid that links it to the next one is not.
    //
    // 🔴 MULTI-PHASE: when `clamp_phases` is set, the check runs PER PHASE
    // against that phase's own clamp set. The global `fixturing.clamps` is
    // ignored — the phases carry their own clamps.
    let biggest_r = groups.iter().map(|(t, _)| t.radius_mm()).fold(0.0_f64, f64::max);
    if let Some(phases) = &job.clamp_phases {
        // Split the path at ClampChange boundaries and check each segment
        // against its phase's clamps.
        let mut seg_start = 0;
        let mut phase_idx = 0;
        for (i, mv) in path.moves.iter().enumerate() {
            if mv.kind == crate::types::MoveKind::ClampChange {
                // Check the segment before this boundary.
                if let Some(phase) = phases.get(phase_idx) {
                    let seg = crate::types::Toolpath {
                        moves: path.moves[seg_start..i].to_vec(),
                        tool: path.tool.clone(),
                        ..Default::default()
                    };
                    let findings = phase.as_fixturing().check(
                        &seg, biggest_r, job.stock.thickness_mm, &job.machine,
                    );
                    res.fixture_findings.extend(findings);
                }
                seg_start = i;
                phase_idx += 1;
            }
        }
        // Check the final segment (after the last boundary).
        if let Some(phase) = phases.get(phase_idx) {
            let seg = crate::types::Toolpath {
                moves: path.moves[seg_start..].to_vec(),
                tool: path.tool.clone(),
                ..Default::default()
            };
            let findings = phase.as_fixturing().check(
                &seg, biggest_r, job.stock.thickness_mm, &job.machine,
            );
            res.fixture_findings.extend(findings);
        }
    } else {
        // Single-phase: the normal path.
        res.fixture_findings =
            job.fixturing.check(&path, biggest_r, job.stock.thickness_mm, &job.machine);
    }

    // ---- the summary, read back out of the emitted program -----------------
    //
    // The post is run HERE, through the technology seam, purely to be read. Its
    // G-code is thrown away: writing the file is the host's job, and a refused
    // job must still produce no file (`is_runnable`). What is kept is the
    // arithmetic over the text.
    //
    // 🔴 Summarising a refused job is deliberate. The numbers describe the
    // program this path WOULD post to, which is what a person needs while they
    // fix the refusal; `is_runnable()` — not an empty summary — is what stops it
    // reaching a spindle.
    //
    // ⚠ COUPLING, named because it is the way this can go wrong again: the
    // `OperationParams` below must match what the host passes when it writes the
    // file (`fixtures::report_of` passes the default), because a drill dwell
    // changes G81 into G82. If those two disagree, the summary once again
    // describes a program nobody downloaded.
    let posted = crate::post::for_technology(job.technology).map(|p| {
        p.write(&path, &job.machine, &job.stock, &OperationParams::default(), &job.post)
    });
    let em = match &posted {
        Some(p) => summarize_program(&p.gcode, &job.machine),
        None => Emitted::default(),
    };

    // ---- does the work holding still HOLD it, at every moment? -------------
    //
    // 🔴 THE OPPOSITE QUESTION TO THE FIXTURE CHECK ABOVE, and the two are
    // silent about each other. `Fixturing::check` asks whether the cutter or
    // the gantry HITS a clamp; this asks whether the clamps still hold the
    // work. A part can be clear of every clamp and be unrestrained — held at
    // one end while the cutter works the other, or released the moment its
    // outline closes — and an unrestrained offcut in a spinning cutter lifts,
    // climbs the tool and is thrown.
    //
    // It reads `posted.gcode` — THE EMITTED PROGRAM — and not `path`, and it
    // sits here because this is the one place in the crate that has both the
    // posted text and the ability to REFUSE. A hold-down finding printed above
    // a downloadable file is a file that gets run (gate G13's property), so the
    // refusals go into `res.refusals` and `is_runnable()` suppresses the
    // program the same way every other refusal does.
    //
    // ⚠ The tool table is passed in rather than read out of the text: the post
    // prints a diameter for the FIRST tool only, so a program is not
    // self-describing about kerf width after a tool change. A name the table
    // does not carry is a PENDING, never a guess.
    {
        let mut tool_table: Vec<(String, f64)> = Vec::new();
        for (t, _) in &groups {
            if !tool_table.iter().any(|(n, _)| *n == t.name) {
                tool_table.push((t.name.clone(), t.radius_mm()));
            }
        }
        let hd = crate::fixture::check_hold_down(
            posted.as_ref().map(|p| p.gcode.as_str()).unwrap_or(""),
            &job.fixturing,
            &job.stock,
            &tool_table,
            HOLD_DOWN_CELL_MM,
        );
        for f in hd.refusals() {
            res.refusals.push(Refusal { what: job.name.clone(), why: f.describe() });
        }
        // 🔴 Every line, on every job — the caveat included, and FIRST. A
        // "holding force is unchecked" sentence that only appears when
        // something else went wrong is a sentence nobody sees on the day it
        // matters.
        res.notes.extend(hd.lines());
    }

    res.summary.tools_used = used;
    res.summary.tool_changes = em.pauses;
    res.summary.cutting_distance_mm = em.cut_mm;
    res.summary.rapid_distance_mm = em.rapid_mm;
    res.summary.estimated_seconds = em.seconds;
    res.summary.deepest_z_mm = em.deepest_z.unwrap_or(0.0);
    res.summary.basis = em.basis;

    // The caveat travels with the job, not only with this struct. `notes` is the
    // channel every host already renders, so a UI can say "estimate" and say WHY
    // without any host having to know this module exists.
    res.notes.push(format!(
        "{} — {} of {} emitted motion blocks are {:.0}mm or shorter here, and {} start from a \
         position the program has not established (program start, after a tool change, after a \
         probe, or after a block carrying a word this reader could not read) so they are not \
         counted at all",
        ESTIMATE_CAVEAT,
        res.summary.basis.short_moves,
        res.summary.basis.motion_blocks,
        SHORT_MOVE_MM,
        res.summary.basis.unmeasured_moves
    ));
    // 🔴 The operator time, as its own line, whenever there is any.
    //
    // The DATA is on `basis` unconditionally; this PROSE fires only when
    // `tool_changes_charged > 0`, and the split is deliberate. A host that wants
    // the rate always has it as a field; a note reading "0 tool changes charged
    // at 120s = 0s" on every single-tool job is a line that teaches an operator
    // to skip the paragraph, which is how the line that matters gets skipped
    // too.
    //
    // ⚠ It prints the TOTAL and the SHARE, not just the rate. "2 changes at
    // 120s" still requires the reader to do the arithmetic and then compare it
    // to a total printed elsewhere; the case this exists for — a 20-minute job
    // that is 16 minutes of standing at the machine — is invisible until those
    // two numbers are put next to each other by whoever already has both.
    if res.summary.basis.tool_changes_charged > 0 {
        let operator = res.summary.basis.tool_change_seconds_total();
        let total = res.summary.estimated_seconds;
        let share = if total > 0.0 { operator / total * 100.0 } else { 0.0 };
        res.notes.push(format!(
            "{} manual tool change(s) are charged at {:.0}s each = {:.0}s of the {:.0}s estimate \
             ({:.0}% of it) — operator time, NOT machine time: the program writes `M0` and waits, \
             and how long a person takes is not in the file. The rate is {}",
            res.summary.basis.tool_changes_charged,
            res.summary.basis.tool_change_seconds,
            operator,
            total,
            share,
            if res.summary.basis.tool_change_rate_declared {
                "declared on this machine".to_string()
            } else {
                format!(
                    "NOT declared on this machine — {:.0}s is the built-in default, which is the \
                     founder's figure and has not been measured on any machine",
                    res.summary.basis.tool_change_seconds
                )
            }
        ));
    }
    for b in &res.summary.basis.blind_spots {
        res.notes.push(format!("run time excludes motion the program does not spell out: {b}"));
    }
    for u in &res.summary.basis.unread {
        res.notes.push(format!(
            "the run-time estimator did not understand part of the emitted program, so the \
             figure is missing that block: {u}"
        ));
    }

    // ---- what the reorder actually bought, in its own measured numbers ------
    //
    // 🔴 The two travel figures in this report are DIFFERENT QUANTITIES and the
    // note says so rather than leaving a UI to subtract one from the other:
    // `route.link_travel_*` is the plan's inter-operation XY travel, measured
    // against the input already grouped by tool; `summary.rapid_distance_mm` is
    // every rapid in the emitted program, lead-ins and tab lifts and pass
    // returns included. Reporting the first as a reduction in the second would
    // be a number nobody measured.
    report_route(&mut res, &route);

    // ---- where the program would have to sit, REPORTED, never applied -------
    //
    // The coordinates below are tool-centre coordinates and already carry the
    // radius, so the radius passed is 0 and there is no second place to
    // double-count it.
    if let Some(p) = plan_datum_shift_for_toolpath(&path, 0.0, &job.machine) {
        match &p {
            // Nothing to say. An "already inside" note would train a reader to
            // skip the line that matters.
            Placement::AlreadyInside { .. } => {}
            Placement::ShiftDatum { dx_mm, dy_mm, .. } => {
                res.notes.push(format!(
                    "this program is outside the machine's travel and the controller will refuse \
                     it — {}",
                    p.describe()
                ));
                // 🔴 OFFERED, not taken. `plan_job` does not touch
                // `job.stock.origin_*`, here or anywhere.
                res.offered_fixes.push(OfferedFix::datum_shift(
                    (job.stock.origin_x_mm, job.stock.origin_y_mm),
                    (job.stock.origin_x_mm + dx_mm, job.stock.origin_y_mm + dy_mm),
                    p.describe(),
                ));
            }
            // No fix at all, deliberately: the program is bigger than the travel,
            // and a shift clamped to "as close as we could get" reads as an
            // answer while the extent still hangs outside the travel.
            Placement::WillNotFit { .. } => {
                res.notes.push(format!(
                    "this program is outside the machine's travel and NO datum shift can help — {}",
                    p.describe()
                ));
            }
        }
    }

    res.path = path;
    res
}

/// Put the [`RouteReport`]'s measured numbers into `notes`, hedged with the
/// basis they were measured on.
fn report_route(res: &mut JobResult, route: &RouteReport) {
    if route.operations >= 2 {
        let pct = match route.reduction_pct() {
            Some(p) => format!("{p:.1}% shorter"),
            // 🔴 Not "0%". `reduction_pct` returns `None` when there was no link
            // travel to reduce, and "0% improvement" asserts that something ran
            // and found nothing — a different, false claim.
            None => "no percentage: there was no link travel to reduce, which is not 0%".into(),
        };
        res.notes.push(format!(
            "route ({}): {} of {} operations moved; link travel {:.1}mm before, {:.1}mm after \
             ({:.1}mm, {}). 🔴 That is the PLAN's inter-operation XY travel only, measured on the \
             input already grouped by tool — it is NOT the emitted program's rapid distance \
             ({:.1}mm here), which also carries lead-ins, tab lifts and pass returns and is a \
             larger number. The reorder moved no coordinate: every check in this report saw the \
             same set of moves, in a different order",
            route.method,
            route.moved_operations,
            route.operations,
            route.link_travel_before_mm,
            route.link_travel_after_mm,
            route.reduction_mm(),
            pct,
            res.summary.rapid_distance_mm,
        ));
    }
    if route.basis.anchored_on_unoffset_contour > 0 {
        res.notes.push(format!(
            "{} of the travel figures' anchors are points on an UNOFFSET contour, so each such \
             link is out by up to one tool radius at each end",
            route.basis.anchored_on_unoffset_contour
        ));
    }
    if !route.pinned.is_empty() {
        res.notes.push(format!(
            "{} operation(s) were pinned where they were and nothing crossed them: {}",
            route.pinned.len(),
            route.pinned.join("; ")
        ));
    }
    // 🔴 FATAL, and this is the line that makes it fatal. Until 2026-08-09 the
    // route module's interior-before-release findings arrived here as
    // `warnings` and were pushed into `notes` — a red paragraph in front of a
    // program that was still posted and could still be run, which is the
    // arrangement TODO #33 was raised about. `optimise_route` now ORDERS the
    // tool groups so the ordinary case never reaches here at all (at zero extra
    // tool changes), and what is left is a residue no grouped order can fix.
    // Refusing it makes `is_runnable()` false, so no G-code is emitted for it.
    for r in &route.refusals {
        res.refusals.push(r.clone());
    }
    // Non-fatal route findings still travel as notes.
    for w in &route.warnings {
        res.notes.push(w.clone());
    }
    for n in &route.notes {
        res.notes.push(format!("route: {n}"));
    }
}

// ---------------------------------------------------------------------------
// A tool SET, assigned per feature — instead of one tool imposed on everything
// ---------------------------------------------------------------------------

/// What [`assign_tools_from_set`] decided, and why.
#[derive(Clone, Debug, Default)]
pub struct ToolSetAssignment {
    /// The recommender's full answer — every choice with its reason, every tool
    /// it refused with the rule it broke. 🔴 A UI that renders only
    /// `tool_id` throws away the half of this that makes it safe.
    pub recommendation: Recommendation,
    pub notes: Vec<String>,
    /// Features no tool in the SET can cut. Also written to
    /// [`Job::tool_set_refusals`], which is what makes them reach the planner.
    pub refusals: Vec<Refusal>,
}

/// Which feature an operation is, in the recommender's vocabulary.
///
/// The signal is [`CutSide`], not the operation's name: an outside cut is the
/// part's profile and the tool runs outside it; anything else runs inside. A
/// round interior loop is a hole (a drill is an option for it); anything else
/// is a pocket. That is [`Feature::classify`]'s rule, not a second one.
fn feature_of(op: &Operation) -> Feature {
    let depth = op.params.depth_total_mm;
    if op.params.side == CutSide::Outside {
        Feature::new(op.name.clone(), FeatureKind::Profile, op.contour.clone(), depth)
    } else {
        Feature::classify(op.name.clone(), op.contour.clone(), depth)
    }
}

/// Assign a tool PER FEATURE from a set of tools the user selected.
///
/// # The defect this replaces
///
/// `JobConfig::tool_id` **used to be** singular and overwrite the tool on
/// **every** operation, so a job that needs a 5mm drill and a 6mm cutter was
/// silently collapsed to whichever one was picked — and the 5mm hole was then
/// cut with a 6mm tool, which is a hole of the wrong size or no hole at all.
/// 🔴 It also left `rpm`, `feed_mm_min` and `depth_per_pass_mm` on the numbers
/// the operation was BUILT with while moving the tool under them, which is the
/// "3mm cutter at a 12mm cutter's rate" failure named below — measured on
/// `socket` and `clamped` as `M3 S18000`/`F3600.0` through that door against
/// `M3 S24000`/`F4800.0` through this one, same cutter, same fixture.
/// **Since 2026-08-11 `JobConfig::apply` prepends a resolvable `tool_id` to the
/// set and there is no other assigning path**, so what follows describes the
/// only door, not the safer of two. This function
/// asks [`crate::recommend`] which tool from the set fits each feature, and
/// **refuses the ones nothing in the set can cut** rather than leaving them on
/// the tool they happened to arrive with.
///
/// # What moves with the tool
///
/// The rpm, feed and depth per pass move with it. They were derived FOR that
/// cutter in this material by the recommender; leaving the previous tool's feed
/// on a new tool is how a 3mm cutter ends up fed at a 12mm cutter's rate. So is
/// the operation type: an interior circle whose new tool matches its diameter is
/// DRILLED, and one whose new tool does not is INTERPOLATED — the same rule
/// `toolpath::operations_for_part` uses, applied again because the tool changed
/// under it.
///
/// # What it will not do
///
/// * It does not touch engraving operations. The recommender has no engraving
///   feature kind, and a V-carve is chosen by included angle; picking an end
///   mill for it would be an approximation wearing a recommendation's clothes.
/// * It does not fall back. A feature with no tool in the set becomes a
///   [`Refusal`] on the job, and [`plan_job`] then produces no path at all.
/// * An empty `tool_ids` is "the user selected nothing", and nothing happens.
///   ⚠ That last line used to end *"— which is how `tool_id`'s behaviour
///   survives unchanged"*, and it is struck rather than deleted because it
///   recorded the asymmetry as a feature. `tool_id` no longer has behaviour of
///   its own to survive: since 2026-08-11 `JobConfig::apply` prepends a
///   resolvable singular id to the set, so **this function is the only planner
///   that assigns a tool**, and the empty case now means only what it says.
pub fn assign_tools_from_set(
    job: &mut Job,
    tool_ids: &[String],
    library: &[ToolSpec],
) -> ToolSetAssignment {
    let mut out = ToolSetAssignment::default();
    if tool_ids.is_empty() {
        return out;
    }

    // --- resolve the set, in the order the user gave it ---------------------
    let mut set: Vec<ToolSpec> = Vec::new();
    for id in tool_ids {
        if set.iter().any(|s| &s.id == id) {
            continue;
        }
        match library.iter().find(|s| &s.id == id) {
            Some(s) => set.push(s.clone()),
            None => out.notes.push(format!(
                "tool '{id}' was selected but is not in the library — it is NOT part of the set, \
                 and no feature was assigned to it"
            )),
        }
    }
    if set.is_empty() {
        let r = Refusal {
            what: job.name.clone(),
            why: format!(
                "{} tool(s) were selected and none of them is in the library, so no operation \
                 could be assigned a tool. Planning on would cut this job with whatever tool the \
                 operations happened to be built with, which is not a tool anybody chose",
                tool_ids.len()
            ),
        };
        out.refusals.push(r);
        job.tool_set_refusals = out.refusals.clone();
        return out;
    }

    // --- which operations are ours to assign --------------------------------
    let mut targets: Vec<usize> = Vec::new();
    for (i, op) in job.operations.iter().enumerate() {
        if op.params.op_type == OpType::Engrave {
            out.notes.push(format!(
                "{}: an engraving keeps the tool it was given — this recommender has no \
                 engraving feature, and a V-carve is chosen by its included angle, not by \
                 diameter",
                op.name
            ));
            continue;
        }
        targets.push(i);
    }
    if targets.is_empty() {
        return out;
    }

    let features: Vec<Feature> = targets.iter().map(|&i| feature_of(&job.operations[i])).collect();
    let rec = recommend(
        &features,
        &job.machine,
        &job.stock,
        job.material,
        &set,
        &RecommendOptions::default(),
    );

    for (k, choice) in rec.choices.iter().enumerate() {
        let idx = targets[k];
        let Some(tool_id) = &choice.tool_id else {
            // 🔴 The explicit no-answer, carried through with the rules that
            // produced it. Every tool in the set is named with what it broke,
            // because the set is small and the person who chose it is the person
            // who has to change it.
            let mut why = choice.reason.clone();
            for r in &choice.rejected {
                why.push_str(&format!("\n  - {}", r.sentence()));
            }
            out.refusals.push(Refusal { what: job.operations[idx].name.clone(), why });
            continue;
        };
        let Some(spec) = set.iter().find(|s| &s.id == tool_id) else {
            // Unreachable: the recommender only ever names a tool from the
            // library it was handed. Stated rather than unwrapped — a panic here
            // would be a safety check failing in the wrong place.
            out.refusals.push(Refusal {
                what: job.operations[idx].name.clone(),
                why: format!("'{tool_id}' was recommended but is not in the set that was offered"),
            });
            continue;
        };

        let op = &mut job.operations[idx];
        let was = op.tool.name.clone();
        op.tool = spec.tool.clone();
        if let Some(l) = choice.limits {
            op.params.rpm = l.rpm;
            op.params.feed_mm_min = l.feed_mm_min;
            op.params.depth_per_pass_mm = l.depth_per_pass_mm;
        }

        // Drill or interpolate — re-decided, because the tool changed under the
        // decision that was made when these operations were built.
        if op.params.side != CutSide::Outside
            && matches!(op.params.op_type, OpType::Drill | OpType::Profile)
        {
            if let Some((_, _, r)) = op.contour.as_circle() {
                let exact = (r - op.tool.radius_mm()).abs() <= 0.05;
                let want = if exact { OpType::Drill } else { OpType::Profile };
                if want != op.params.op_type {
                    out.notes.push(format!(
                        "{}: now {} — the tool changed from {} to {}, and the two are different \
                         programs for the same hole",
                        op.name,
                        if want == OpType::Drill { "DRILLED" } else { "INTERPOLATED" },
                        was,
                        spec.tool.name,
                    ));
                    op.params.op_type = want;
                }
            }
        }

        out.notes.push(format!("{}: {}", op.name, choice.reason));
        for n in &choice.notes {
            out.notes.push(format!("{}: {n}", op.name));
        }
    }

    out.notes.extend(rec.notes.iter().cloned());
    if rec.tool_set.len() > 1 {
        out.notes.push(format!(
            "{} tools are needed for this job ({}), which costs {} tool change(s)",
            rec.tool_set.len(),
            rec.tool_set.join(", "),
            rec.tool_changes()
        ));
    }
    out.recommendation = rec;
    job.tool_set_refusals = out.refusals.clone();
    out
}

/// The host adapter: apply a tool set from a config, if one was given.
///
/// `None` and an empty list both mean "the user selected no cutter at all", and
/// both leave the job exactly as it was — which is what keeps a fixture run with
/// no tool in its config planning on the tools it was built with.
///
/// ⚠ This doc used to end *"which is what keeps the singular `tool_id` path
/// behaving as it does today"*. There is no singular path left: `JobConfig`
/// hands this function ONE list built from `tool_id` and `tool_ids` together, so
/// `None` no longer distinguishes a door — it only says the list was empty.
pub fn apply_tool_set(
    job: &mut Job,
    tool_ids: Option<&[String]>,
    library: &[ToolSpec],
    notes: &mut Vec<String>,
) {
    let Some(ids) = tool_ids else { return };
    if ids.is_empty() {
        return;
    }
    let a = assign_tools_from_set(job, ids, library);
    notes.extend(a.notes);
}

/// [`plan_job`], with the tools assigned from a set first.
///
/// The assignment's reasoning is prepended to the result's notes, so a host that
/// only ever renders `notes` still sees why each feature got the cutter it got.
pub fn plan_job_with_tools(job: &Job, tool_ids: &[String], library: &[ToolSpec]) -> JobResult {
    let mut j = job.clone();
    let a = assign_tools_from_set(&mut j, tool_ids, library);
    let mut res = plan_job(&j);
    let mut notes = a.notes;
    notes.append(&mut res.notes);
    res.notes = notes;
    res
}

// ---------------------------------------------------------------------------
// Several drawings on one workpiece — with the interference check on the ONLY path
// ---------------------------------------------------------------------------

/// Plan a job from a [`Layout`] of placed drawings.
///
/// # 🔴 Why this function exists at all
///
/// [`Layout::check`] answers "do these parts destroy each other" — and until
/// now a caller could build an overlapping layout, never call it, take
/// `Layout::operations` and post the result. **A safety check with an optional
/// caller is not a check.** This is the path from a layout to a program, and the
/// check is not optional on it: any [`crate::layout::Interference`] becomes a
/// refusal and **no toolpath is produced**, so there is nothing to post by
/// mistake.
///
/// All three interference variants refuse, including `NotChecked` — a pair whose
/// check could not run is not a pair that passed.
///
/// # The clearance comes from the tool, and from THIS tool
///
/// The gap check asks whether the cutter fits down the channel between two
/// parts, so it is built from `tool` with [`Clearance::from_tool`]. ⚠ That makes
/// it correct for the tool this call cuts with and for no other: if a tool SET
/// is applied afterwards and it contains something fatter, the gap that passed
/// here is not the gap that will be cut. Assign the set first, then lay out with
/// the largest cutter in it.
///
/// `clearance_margin_mm` is the caller's, never a default — a check that passes
/// or fails on a number nobody chose is worse than no check, because a person
/// would trust it.
pub fn plan_layout_job(
    base: &Job,
    layout: &Layout,
    tool: &Tool,
    params: &OperationParams,
    clearance_margin_mm: f64,
) -> JobResult {
    let mut res = JobResult::default();
    res.notes.extend(layout.notes());

    let Some(clearance) = Clearance::from_tool(tool, clearance_margin_mm) else {
        res.refusals.push(Refusal {
            what: base.name.clone(),
            why: format!(
                "the cutter-gap check could not be built from '{}' ({:.3}mm diameter, {:.3}mm \
                 margin), so no pair of parts on this workpiece was checked against any other. A \
                 check that cannot run is not a check that passed",
                tool.name, tool.diameter_mm, clearance_margin_mm
            ),
        });
        return res;
    };

    let findings = layout.check(&clearance);
    if !findings.is_empty() {
        for f in &findings {
            res.refusals.push(f.to_refusal());
        }
        // The travel question is still worth answering while somebody re-nests:
        // it is the other thing they will hit, and finding out about it on the
        // second attempt is a wasted attempt.
        if let Some(p) = layout.plan_placement(tool.radius_mm(), 0.0, &base.machine) {
            if !matches!(p, Placement::AlreadyInside { .. }) {
                res.notes.push(p.describe());
            }
        }
        return res;
    }

    let mut job = base.clone();
    job.operations = layout.operations(tool, params);
    let mut planned = plan_job(&job);
    let mut notes = res.notes;
    notes.append(&mut planned.notes);
    planned.notes = notes;
    planned
}

#[cfg(test)]
mod tests {

    /// A refusal must never be able to ride on a runnable result.
    ///
    /// 🔴 The browser lists `report.refusals` under exactly one predicate —
    /// `const blocked = report && !report.ok` in `App.tsx` — so a refusal is
    /// visible to the operator **if and only if `ok` is false**. If
    /// `is_runnable()` ever returns true with a refusal standing, the refusal
    /// stays in the JSON, stays correct, and disappears from the screen, over a
    /// program the operator can then download.
    ///
    /// This asserts the invariant directly rather than through a fixture, so it
    /// holds for refusals that do not exist yet.
    #[test]
    fn a_report_carrying_any_refusal_is_never_runnable() {
        let mut r = JobResult::default();
        assert!(r.is_runnable(), "an empty result should be runnable");

        r.refusals.push(Refusal {
            what: "any operation".into(),
            why: "any reason at all".into(),
        });
        assert!(
            !r.is_runnable(),
            "a result with a refusal reported itself RUNNABLE. The browser shows refusals only \
             when `ok` is false, so this one would be invisible on screen while the operator \
             downloads the program it refused"
        );

        // And the one deliberate exemption stays exempt: "no clamps declared" is
        // a fact about the setup, not a fault in the program, and blocking on it
        // would make every un-clamped job unrunnable.
        let mut u = JobResult::default();
        u.fixture_findings.push(FixtureFinding::Undeclared);
        assert!(
            u.is_runnable(),
            "`Undeclared` must report without refusing — it is the one finding that does"
        );
    }

    #[test]
    fn an_unreadable_word_does_not_swallow_the_mode_change_in_its_own_block() {
        /* 🔴 THE BAD TRADE THE FIRST VERSION OF THAT GUARD MADE. A block can
         * carry BOTH a mode word and an unreadable one — `G91 X1.2.3`. Skipping
         * the whole block skipped `absolute = false`, so every distance in the
         * REST OF THE PROGRAM was computed in absolute mode against an
         * incremental program: a NaN traded for a SILENTLY WRONG NUMBER, which
         * is the worse of the two. A NaN reaches the operator as `—`; a wrong
         * distance reaches them as a number.
         *
         * Asserted through the distance, not through a flag: after a skipped
         * `G91` block, an incremental `X10` is a 10mm move. Read as absolute
         * from X=0 it is also 10 — so the second move is what separates them.
         * `G91 X10` twice is 20mm; misread as absolute it is 10. */
        let out = super::summarize_program(
            "G90\nG0 X0 Y0 Z0\nG91 X1.2.3\nG1 X10 F600\nG1 X10 F600\n",
            &Default::default(),
        );
        assert!(
            out.basis.unread.iter().any(|u| u.contains("`X` word")),
            "the unreadable word was not named: {:?}",
            out.basis.unread
        );
        assert!(
            (out.cut_mm - 20.0).abs() < 1e-9,
            "the G91 in the skipped block was lost, so two 10mm incremental moves measured {} \
             instead of 20 — a wrong number, not an unmodelled one",
            out.cut_mm
        );
    }

    #[test]
    fn an_unreadable_axis_word_is_named_and_does_not_poison_the_estimate() {
        // 🔴 The audit covered G, M and F — the words whose value selects a
        // branch — and left the ones that carry a DISTANCE. A NaN X reaches
        // axis_delta, `cur.map(|c| NaN - c)` is Some(NaN), `known` is true, and
        // cut_mm/rapid_mm/seconds go NaN for the rest of the program with
        // nothing named. The operator then reads `—` with no reason beside it.
        let out = super::summarize_program(
            "G90\nG0 X0 Y0 Z0\nG1 X1.2.3 F600\nG1 X10 F600\n",
            &Default::default(),
        );
        assert!(
            out.basis.unread.iter().any(|u| u.contains("`X` word")),
            "the unreadable axis word was not named: {:?}",
            out.basis.unread
        );
        assert!(out.seconds.is_finite(), "a NaN axis word poisoned the estimate");
        assert!(out.cut_mm.is_finite(), "a NaN axis word poisoned the cutting distance");
    }

    #[test]
    fn an_unreadable_g_word_is_named_and_not_charged_as_a_rapid() {
        // 🔴 `code_of` is `(g*10.0).round() as i64`, and a Rust float→int cast
        // maps NaN to 0 — so an unparsable `G` matched the G0 arm and was timed
        // as a RAPID over the block's X/Y/Z. The splitter's own doc says a word
        // it cannot parse becomes NaN "so the caller can name it"; the caller
        // could not, because the cast had already answered.
        let out = super::summarize_program("G1.2.3 X10 F600\nG1 X20 F600\n", &Default::default());
        assert!(
            out.basis.unread.iter().any(|u| u.contains("`G` word")),
            "the unreadable G word was not named: {:?}",
            out.basis.unread
        );
    }

    #[test]
    fn a_skipped_block_leaves_the_position_unknown_rather_than_stale() {
        /* 🔴 THE SECOND HALF OF THE MODE-ORDER DEFECT. Skipping an unreadable
         * block used to leave `x`/`y`/`z` at their PREVIOUS values, so the next
         * block measured its delta from a point the tool is not at.
         *
         * Here the rapid to X200 is unreadable. With the position left stale at
         * X0, the following cutting block computed `dx = 200` and charged 200 mm
         * of CUTTING at F600 (~20 s) in place of a 200 mm rapid plus a 4 mm
         * plunge (~4 s). A wrong number, not a missing one. */
        let g = "G21 G90\nG0 X0 Y0 Z5\nG0 X200 Y0 Z1.2.3\nG1 X200 Y0 Z-3 F600\n";
        let out = super::summarize_program(g, &Default::default());
        assert!(
            out.cut_mm < 100.0,
            "the block after an unreadable one measured its distance from a stale position: \
             cut_mm = {}",
            out.cut_mm
        );
        assert!(
            out.basis.unmeasured_moves >= 1,
            "the move from an unknown position was not counted as unmeasured: {:?}",
            out.basis
        );
    }

    #[test]
    fn the_magnitude_of_what_was_skipped_is_visible_not_just_its_direction() {
        /* `name_unread` dedups and caps at 8, and the message is byte-identical
         * for every `X` word — so 500 skipped blocks produced ONE line and moved
         * no counter, and "1 unread" reads like one bad block. */
        let mut g = String::from("G21 G90\nG0 X0 Y0 Z5\n");
        for _ in 0..50 {
            g.push_str("G1 X1.2.3 Y1 F600\n");
        }
        let out = super::summarize_program(&g, &Default::default());
        assert!(
            out.basis.unread.len() <= 8,
            "the operator got a wall of identical lines: {}",
            out.basis.unread.len()
        );
        assert!(
            out.basis.unmeasured_moves >= 50,
            "50 skipped motion blocks left no trace in the counters: {:?}",
            out.basis
        );
    }

    #[test]
    fn an_unreadable_feed_is_named_once_not_twice() {
        /* The F rejection and the non-finite sweep are two DISTINCT strings, so
         * `name_unread`'s dedup cannot collapse them: `G1 X10 F6.0.0` spent two
         * of the eight slots naming one word. The block is also no longer
         * skipped — its distance is knowable even when its time is not. */
        let out = super::summarize_program("G1 X10 F6.0.0\n", &Default::default());
        let named: Vec<_> = out
            .basis
            .unread
            .iter()
            .filter(|u| u.contains("F word") || u.contains("`F` word"))
            .collect();
        assert_eq!(named.len(), 1, "the same F word was named twice: {named:?}");
    }

    #[test]
    fn a_refused_feed_and_a_missing_one_are_named_as_different_events() {
        /* An operator reading "a cutting block before any F word" on a program
         * whose first line carries `F600` goes looking for a missing word
         * instead of a refused one. */
        let refused = super::summarize_program("G1 X10 F0\nG1 X20\n", &Default::default());
        assert!(
            refused.basis.unread.iter().any(|u| u.contains("refused")),
            "a block after a REFUSED feed was reported as one before any feed: {:?}",
            refused.basis.unread
        );
        assert!(
            !refused
                .basis
                .unread
                .iter()
                .any(|u| u.contains("before any F word")),
            "the wrong reason is still reported: {:?}",
            refused.basis.unread
        );

        let missing = super::summarize_program("G1 X10\n", &Default::default());
        assert!(
            missing
                .basis
                .unread
                .iter()
                .any(|u| u.contains("before any F word")),
            "a genuinely missing feed lost its own message: {:?}",
            missing.basis.unread
        );
    }

    #[test]
    fn an_unreadable_m_word_charges_no_tool_change() {
        // Same cast: NaN → 0 → the M0 arm → a pause and a full tool-change
        // charge added to the operator's estimate for a word nobody could read.
        let out = super::summarize_program("M X\nG1 X10 F600\n", &Default::default());
        assert!(
            out.basis.unread.iter().any(|u| u.contains("`M` word")),
            "the unreadable M word was not named: {:?}",
            out.basis.unread
        );
    }

    #[test]
    fn a_zero_or_negative_feed_does_not_let_the_previous_feed_carry_into_the_block() {
        // The other road into the same trap the whitespace fix closed: `F0` fell
        // through the `f > 0.0` filter with no `else`, so the feed before it
        // governed — a confident run time for a program grblHAL halts on.
        let out = super::summarize_program("G1 X10 F600\nG1 X10 F0\n", &Default::default());
        assert!(
            out.basis.unread.iter().any(|u| u.contains("F word")),
            "the zero feed was not named: {:?}",
            out.basis.unread
        );
    }

    #[test]
    fn a_spaced_word_is_read_and_does_not_silently_keep_the_previous_feed() {
        // 🔴 THE DEFECT: `block_words` required the value adjacent to its
        // letter, so `F 5000` parsed as NaN, `summarize_program`'s
        // `f.is_finite()` rejected it, and the PREVIOUS feed governed the rest
        // of the estimate. A wrong run time on the operator's summary, silently.
        let w = super::block_words("G1 X1 F 5000");
        let f = w.iter().rev().find(|(c, _)| *c == 'F').map(|(_, v)| *v);
        assert_eq!(f, Some(5000.0), "a spaced feed word must be read: {w:?}");
        // …and the adjacent form still works, so this is a widening not a swap.
        let w2 = super::block_words("G1 X1 F5000");
        assert_eq!(w2.iter().rev().find(|(c, _)| *c == 'F').map(|(_, v)| *v), Some(5000.0));
        // The rule is per-WORD, not per-F: a spaced axis word reads too.
        let w3 = super::block_words("G1 X 12.5");
        assert_eq!(w3.iter().find(|(c, _)| *c == 'X').map(|(_, v)| *v), Some(12.5));
    }

    #[test]
    fn the_estimator_and_the_feed_readers_agree_on_a_spaced_program() {
        /* ⚠ THIS TEST DID NOT TEST THE ESTIMATOR UNTIL 2026-08-28. It called
         * `block_words` — the word SPLITTER — while its name and the census
         * entry citing it both claimed it pinned `summarize_program`. Deleting
         * the estimator's whole `F` block left it green.
         *
         * It goes through the estimator now, and asserts on the thing that
         * would actually be wrong: a spaced feed must produce the SAME run time
         * as the adjacent form, because the only difference between the two
         * programs is a space. */
        /* ⚠ THE POSITION IS ESTABLISHED FIRST, and the `> 0` assertion below is
         * what forced it: without `G90 G0 X0 Y0 Z0` the estimator counts NOTHING
         * — a move from a position the program has not established has no
         * knowable distance, which `EstimateBasis` reports as its own class. The
         * first version of this test compared 0 against 0 and would have passed
         * with the whole `F` block deleted. A comparison between two runs is
         * only a test if at least one of them measured something. */
        const PRELUDE: &str = "G90\nG0 X0 Y0 Z0\n";
        let spaced =
            super::summarize_program(&format!("{PRELUDE}G1 X10 F 600\n"), &Default::default());
        let adjacent =
            super::summarize_program(&format!("{PRELUDE}G1 X10 F600\n"), &Default::default());
        assert!(spaced.seconds > 0.0, "a spaced feed produced no run time at all");
        assert!(
            (spaced.seconds - adjacent.seconds).abs() < 1e-9,
            "a space changed the estimate: spaced {} vs adjacent {}",
            spaced.seconds,
            adjacent.seconds
        );
        // And the two SHIPPING readers still agree on the same bytes.
        assert_eq!(crate::feeds::cutting_feeds_in_program("G1 X10 F 600\n"), vec![600.0]);
    }
    use super::*;
    use crate::geometry::Contour;
    use crate::post_grblhal::{post_grblhal, PostOptions};

    fn tool(name: &str, d: f64, shank: f64) -> Tool {
        Tool { name: name.into(), diameter_mm: d, shank_mm: shank, flutes: 2, chipload_mm: 0.1, ..Tool::default() }
    }

    fn op(name: &str, t: Tool) -> Operation {
        let (part, role) = crate::toolpath::test_part_and_role(name);
        Operation {
            name: name.into(),
            part,
            role,
            contour: Contour::rect(50.0, 50.0, 120.0, 80.0),
            tool: t,
            params: OperationParams { depth_total_mm: 18.0, ..OperationParams::default() },
        }
    }

    fn machine6() -> Machine {
        // 🔴 The plate thickness is TYPED, not inherited. `Machine::default()`
        // leaves `touch_plate_mm` at `None` — undeclared and REFUSED — since
        // decision #43 P0, so a test that wants a probe in the emitted program
        // has to declare one, exactly as an operator does. Without this line
        // the three probe tests below compare two refusals and pass.
        Machine {
            collet_mm: 6.0,
            probe_enabled: true,
            touch_plate_mm: Some(1.6),
            ..Machine::default()
        }
    }

    fn job_with(ops: Vec<Operation>) -> Job {
        Job { operations: ops, ..Job::new("test", machine6(), Stock::default()) }
    }

    /// The same job, on a machine that declares (or declines to declare) a
    /// tool-change time. Everything else is `machine6()`, so a difference
    /// between two of these is attributable to that one field.
    fn job_at_rate(ops: Vec<Operation>, tool_change_seconds: Option<f64>) -> Job {
        let machine = Machine { tool_change_seconds, ..machine6() };
        Job { operations: ops, ..Job::new("test", machine, Stock::default()) }
    }

    /// The emitted program, so a test can assert that two runs differ ONLY in
    /// the number and not in the motion.
    fn posted(job: &Job) -> String {
        let r = plan_job(job);
        post_grblhal(&r.path, &job.machine, &job.stock, &OperationParams::default(), &PostOptions::default())
            .gcode
    }

    #[test]
    fn three_tools_cost_exactly_two_changes() {
        // 🔴 D2. More changes than N-1 means the grouping failed, and every
        // extra change is another chance to fit the wrong cutter.
        let j = job_with(vec![
            op("a", tool("6mm", 6.0, 6.0)),
            op("b", tool("3mm", 3.0, 6.0)),
            op("c", tool("6mm", 6.0, 6.0)),
            op("d", tool("12mm", 12.0, 6.0)),
        ]);
        let r = plan_job(&j);
        assert_eq!(r.summary.tool_changes, 2, "expected 2 changes for 3 tools");
        assert_eq!(r.summary.tools_used.len(), 3);
    }

    #[test]
    fn one_tool_needs_no_change_at_all() {
        let r = plan_job(&job_with(vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("6mm", 6.0, 6.0))]));
        assert_eq!(r.summary.tool_changes, 0);
    }

    #[test]
    fn a_tool_change_stops_the_spindle_pauses_and_names_the_tool() {
        // 🔴 D3/D5. M0 alone makes the operator guess which cutter to fit.
        let j = job_with(vec![op("a", tool("6mm end mill", 6.0, 6.0)), op("b", tool("3mm end mill", 3.0, 6.0))]);
        let r = plan_job(&j);
        let g = post_grblhal(
            &r.path,
            &j.machine,
            &j.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        );
        assert!(g.ok(), "{:?}", g.errors);
        let idx_m0 = g.gcode.find("M0").expect("no pause emitted");
        let before = &g.gcode[..idx_m0];
        assert!(before.rfind("M5").is_some(), "the spindle was not stopped before the pause");
        assert!(
            g.gcode.contains("TOOL CHANGE -> 3mm end mill"),
            "the change does not name the tool to fit"
        );
        // ...and the spindle restarts afterwards.
        assert!(g.gcode[idx_m0..].contains("M3 S"), "the spindle never restarts after the change");
    }

    #[test]
    fn z_is_re_referenced_after_every_tool_change() {
        // 🔴 D4. A new tool has a different length; without a re-probe the next
        // cut is wrong by that difference, which can be tens of millimetres.
        let j = job_with(vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))]);
        let r = plan_job(&j);
        let g = post_grblhal(&r.path, &j.machine, &j.stock, &OperationParams::default(), &PostOptions::default());
        let after = &g.gcode[g.gcode.find("M0").unwrap()..];
        assert!(after.contains("G38.2"), "no probe after the tool change");
        assert!(after.contains("G10 L20 P1"), "the probe result was never written to the WCS");
    }

    #[test]
    fn skipping_the_reprobe_is_allowed_but_never_silent() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))]);
        j.probe_after_toolchange = false;
        let r = plan_job(&j);
        assert!(
            r.notes.iter().any(|n| n.contains("wrong by the difference in tool length")),
            "skipping the re-probe was silent: {:?}",
            r.notes
        );
    }

    #[test]
    fn asking_to_probe_on_a_machine_with_no_probe_is_an_error_not_a_shrug() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))]);
        j.machine.probe_enabled = false;
        let r = plan_job(&j);
        let g = post_grblhal(&r.path, &j.machine, &j.stock, &OperationParams::default(), &PostOptions::default());
        assert!(!g.ok(), "a probe was requested and silently skipped");
        assert!(g.errors.iter().any(|e| e.contains("no probe")));
    }

    #[test]
    fn an_unfittable_shank_stops_the_job() {
        // 🔴 P6. Discovered at the machine in the fork, with a workpiece clamped.
        let j = job_with(vec![op("a", tool("12mm shank", 12.0, 12.0))]);
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        assert!(r.refusals.iter().any(|x| x.why.contains("will not enter the spindle")));
    }

    #[test]
    fn an_undeclared_collet_is_reported_and_does_not_block() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        j.machine.collet_mm = 0.0;
        let r = plan_job(&j);
        assert!(r.notes.iter().any(|n| n.contains("shank fit was NOT checked")));
        assert!(r.is_runnable(), "an unknown collet must not block, only report");
    }

    // =======================================================================
    //  The collet fact in the PROGRAM, not only in the report
    // =======================================================================
    //
    // 🔴 THE DEFECT THESE GUARD, MEASURED 2026-08-12 BEFORE THE FIX. On the
    // `multi-tool` fixture — a shop machine with a 6mm collet fitted and 3.175,
    // 6.35 and 8mm in the drawer, running a program whose FIRST cutter has a
    // 3.175mm shank — `report multi-tool` carried the note *"End Mill -
    // Down-cut 3.175mm 2F: needs a collet change to 3.175mm before it can be
    // fitted"*, and `gcode.contains("collet")` was **false**. The report is a
    // panel. The `.nc` file is what the person holding the cutter reads, and it
    // said only `( tool: End Mill - Down-cut 3.175mm 2F D3.17mm F2 )`. A
    // 3.175mm shank in a 6mm collet does not grip: it is thrown at 18,000rpm.
    //
    // The four tests below are the four different sentences, and the third one
    // is the specificity control — a comment that appears on every job is a
    // banner nobody reads, which is the other way to fail this.

    #[test]
    fn a_needed_collet_change_is_named_in_the_program_and_not_only_in_the_report() {
        // machine6(): 6mm fitted. A 3.175mm shank fits only a spare.
        let mut j = job_with(vec![op("a", tool("3.175mm cutter", 3.175, 3.175))]);
        j.machine.spare_collets_mm = vec![3.175, 6.35, 8.0];
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        // The report still says it — this ADDS a reader, it does not move one.
        assert!(r.notes.iter().any(|n| n.contains("needs a collet change")), "{:?}", r.notes);
        let g = posted(&j);
        assert!(
            g.contains("FIT THE 3.175mm COLLET"),
            "the program does not name the collet the operator must fetch:\n{g}"
        );
        // It must name the collet that is IN the spindle too, or the operator
        // cannot tell whether the one already fitted is the right one.
        assert!(g.contains("6.000mm"), "the program does not say what is fitted now:\n{g}");
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn an_undeclared_collet_says_UNCHECKED_in_the_program_rather_than_saying_nothing() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        j.machine.collet_mm = 0.0;
        j.machine.spare_collets_mm = vec![];
        let r = plan_job(&j);
        assert!(r.is_runnable(), "an unknown collet must not block, only report");
        let g = posted(&j);
        assert!(g.contains("collet UNCHECKED"), "{g}");
        // 🔴 The WORD matters. "not checked" and "checked and fine" are the two
        // readings, and only one of them is true.
        assert!(g.contains("did not run"), "{g}");
        assert!(!g.contains("FIT THE"), "an undeclared collet must not issue an instruction:\n{g}");
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn a_shank_the_fitted_collet_already_holds_writes_NOTHING_INTO_THE_PROGRAM() {
        // 🔴 THE SPECIFICITY CONTROL. The sensitivity tests above pass just as
        // well if the comment is emitted unconditionally, and a line that is on
        // every program is a line nobody reads by the third job.
        let j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        let g = posted(&j);
        assert!(
            !g.to_lowercase().contains("collet"),
            "a 6mm shank in the declared 6mm collet wrote a collet line anyway:\n{g}"
        );
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn a_spare_that_fits_while_the_SPINDLE_is_undeclared_is_unchecked_not_an_instruction() {
        // 🔴 The branch a boolean would collapse. A 3.175mm collet is in the
        // drawer and would hold this shank — but nothing has said what is in the
        // spindle, so "fit the 3.175mm one" would assert a change nobody has
        // established is needed, on a machine that may already have it in.
        let mut j = job_with(vec![op("a", tool("3.175mm cutter", 3.175, 3.175))]);
        j.machine.collet_mm = 0.0;
        j.machine.spare_collets_mm = vec![3.175];
        let g = posted(&j);
        assert!(g.contains("collet UNCHECKED"), "{g}");
        assert!(g.contains("3.175mm collet is listed in the drawer"), "{g}");
        assert!(!g.contains("FIT THE"), "{g}");
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn the_collet_line_precedes_the_M0_of_the_tool_change_it_is_about() {
        // A warning printed after the pause is a warning read after the cutter
        // is already in the spindle.
        let mut j = job_with(vec![
            op("a", tool("6mm", 6.0, 6.0)),
            op("b", tool("3.175mm cutter", 3.175, 3.175)),
        ]);
        j.machine.spare_collets_mm = vec![3.175];
        let g = posted(&j);
        let collet = g.find("FIT THE 3.175mm COLLET").unwrap_or_else(|| panic!("{g}"));
        let change = g.find("TOOL CHANGE -> 3.175mm cutter").unwrap_or_else(|| panic!("{g}"));
        assert!(collet < change, "the collet line came after the tool-change banner:\n{g}");
        let m0 = g[change..].find("\nM0\n").map(|i| change + i).unwrap_or_else(|| panic!("{g}"));
        assert!(collet < m0, "the collet line came after the pause:\n{g}");
    }

    #[test]
    fn the_collet_line_never_carries_a_parenthesis_or_a_bare_axis_word() {
        // grblHAL cannot nest comment parentheses and the post rewrites them to
        // `_`; and `RunTab.tsx` reads axis words, so a bare `Z-1` inside a
        // comment is a coordinate to somebody's parser.
        let cases: Vec<(ColletVerdict, Option<f64>, f64)> = vec![
            (ColletVerdict::Fits, Some(3.175), 6.0),
            (ColletVerdict::Fits, Some(3.175), 0.0),
            (ColletVerdict::Undeclared, None, 0.0),
        ];
        for (v, spare, fitted) in cases {
            let s = collet_program_comment("6mm", 6.0, &v, spare, fitted).expect("a sentence");
            assert!(!s.contains('(') && !s.contains(')'), "{s}");
            for axis in ['X', 'Y', 'Z'] {
                assert!(
                    !s.chars().zip(s.chars().skip(1)).any(|(a, b)| a == axis && (b.is_ascii_digit() || b == '-')),
                    "an axis word in a comment: {s}"
                );
            }
        }
    }

    #[test]
    fn a_refused_shank_writes_no_program_comment_because_no_program_is_written() {
        // 🔴 NOT an omission — the measured reason the arm returns `None`.
        // `is_runnable()` is false, every host withholds the file on that, and a
        // sentence nobody can read is a control with no consumer.
        let v = ColletVerdict::TooLarge { shank_mm: 12.0, collet_mm: 6.0 };
        assert_eq!(collet_program_comment("12mm", 12.0, &v, None, 6.0), None);
        let j = job_with(vec![op("a", tool("12mm shank", 12.0, 12.0))]);
        let r = plan_job(&j);
        assert!(!r.is_runnable(), "the premise of the None above no longer holds");
    }

    #[test]
    fn stock_larger_than_the_machine_is_refused_before_anything_else() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        j.stock = Stock { size_x_mm: 2400.0, size_y_mm: 1200.0, ..Stock::default() };
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        assert!(r.refusals[0].why.contains("travel"), "{}", r.refusals[0].why);
        // 2400x1200 does not fit any way round, so the refusal must NOT offer a
        // quarter turn. Offering one that does not help is worse than offering
        // none: it sends someone to re-clamp a workpiece for nothing.
        assert!(!r.refusals[0].why.contains("turned"), "{}", r.refusals[0].why);
    }

    #[test]
    fn a_sheet_that_only_fits_turned_is_refused_with_the_turn_that_works() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        // The founder's machine and the shop's workpiece: 900 exceeds 670 of Y
        // travel, and 900 sits inside 1250 of X. It fits, turned.
        j.machine.travel_x_mm = 1250.0;
        j.machine.travel_y_mm = 670.0;
        j.stock = Stock { size_x_mm: 600.0, size_y_mm: 900.0, ..Stock::default() };
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        assert!(r.refusals[0].why.contains("turned 90 degrees"), "{}", r.refusals[0].why);

        j.stock.rotation_deg = 90.0;
        let turned = plan_job(&j);
        assert!(turned.is_runnable(), "{:?}", turned.refusals);
    }

    #[test]
    fn a_quarter_turn_moves_the_program_not_only_the_picture() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        j.machine.travel_x_mm = 2000.0;
        j.machine.travel_y_mm = 2000.0;
        let flat = plan_job(&j);
        j.stock.rotation_deg = 90.0;
        let turned = plan_job(&j);
        // The point of the whole feature: turning the workpiece must change the
        // COORDINATES that reach the controller. A rotation that changed only
        // the render would leave these two identical and cut the part lying the
        // wrong way round.
        let xs = |r: &JobResult| {
            r.path
                .moves
                .iter()
                .map(|m| format!("{:.3},{:.3}", m.to.x, m.to.y))
                .collect::<Vec<_>>()
        };
        assert_ne!(xs(&flat), xs(&turned));
        assert!(turned.is_runnable(), "{:?}", turned.refusals);
    }

    #[test]
    fn a_quarter_turn_is_exact_and_keeps_the_sheet_on_its_datum() {
        let s = Stock { size_x_mm: 600.0, size_y_mm: 900.0, rotation_deg: 90.0, ..Stock::default() };
        assert_eq!(s.footprint(), (900.0, 600.0));

        // The property is about the WORKPIECE, not about any one corner. Turning it
        // changes WHICH corner lands on the datum — here the workpiece's (0,900)
        // corner does — so asserting that (0,0) stays put would be asserting
        // that the workpiece did not turn.
        let corners = [(0.0, 0.0), (600.0, 0.0), (600.0, 900.0), (0.0, 900.0)];
        let placed: Vec<(f64, f64)> = corners.iter().map(|(x, y)| s.place(*x, *y)).collect();
        assert!(placed.contains(&(0.0, 0.0)), "a corner must sit exactly on the datum: {placed:?}");
        assert!(placed.contains(&(900.0, 600.0)), "{placed:?}");
        // Exact, not near: every value here is a whole number of millimetres, so
        // any 6e-17 from a naive cos(90) would show up as an inequality.
        for (x, y) in &placed {
            assert!((0.0..=900.0).contains(x) && (0.0..=600.0).contains(y), "{placed:?}");
            assert_eq!(*x, x.round(), "{placed:?}");
            assert_eq!(*y, y.round(), "{placed:?}");
        }
    }

    #[test]
    fn a_free_angle_plans_and_says_it_cannot_be_registered() {
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        j.machine.travel_x_mm = 3000.0;
        j.machine.travel_y_mm = 3000.0;
        j.stock.rotation_deg = 37.0;
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        assert!(
            r.notes.iter().any(|n| n.contains("not a quarter turn")),
            "a free angle must not pass silently: {:?}",
            r.notes
        );
    }

    /// 🔴 J3. The acceptance is a PROVENANCE claim — "summary numbers derive
    /// from the emitted program, not the plan" — so the only test that can prove
    /// it is one where the PLAN IS IDENTICAL and the PROGRAM IS NOT.
    ///
    /// Turning arcs off changes nothing upstream: `plan_job` produces the same
    /// `path.moves`, with the same `ArcCW`/`ArcCCW` records between the same
    /// endpoints. The post is what differs — it degrades each arc to a straight
    /// `G1` to the same endpoint, which is a SHORTER path travelled in LESS
    /// time. A summary walking `path.moves` reports the identical number for
    /// both, because from the plan's point of view nothing happened.
    ///
    /// On the old code both sides of every assertion below were equal.
    #[test]
    fn degrading_the_arcs_moves_the_summary_because_it_moves_the_program() {
        let with_arcs = || {
            let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
            // Tangential lead-in/lead-out arcs, so there is something to degrade.
            j.operations[0].params.lead_mm = 4.0;
            j
        };

        let arcs = plan_job(&with_arcs());
        let mut flat_job = with_arcs();
        flat_job.post.emit_arcs = false;
        let flat = plan_job(&flat_job);

        // The plans are the same program-in-waiting...
        let kinds = |r: &JobResult| r.path.moves.iter().map(|m| m.kind).collect::<Vec<_>>();
        assert_eq!(kinds(&arcs), kinds(&flat), "the PLAN must be identical — otherwise this test proves nothing about provenance");
        let planned_arcs = arcs
            .path
            .moves
            .iter()
            .filter(|m| matches!(m.kind, MoveKind::ArcCW | MoveKind::ArcCCW))
            .count();
        assert!(planned_arcs > 0, "no arcs were planned, so nothing was degraded");

        // ...and the emitted programs are not.
        let g_arcs = post_grblhal(
            &arcs.path,
            &flat_job.machine,
            &flat_job.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        );
        assert!(g_arcs.gcode.contains("G2") || g_arcs.gcode.contains("G3"));
        let g_flat = post_grblhal(
            &flat.path,
            &flat_job.machine,
            &flat_job.stock,
            &OperationParams::default(),
            &flat_job.post,
        );
        assert!(!g_flat.gcode.contains("\nG2 ") && !g_flat.gcode.contains("\nG3 "));

        // What the OLD code reported: a straight-line walk over `path.moves`.
        // Demonstrated rather than asserted — it comes out IDENTICAL for the two
        // jobs, so no plan-derived summary could have told them apart, and this
        // test would have failed on it.
        let plan_walk = |r: &JobResult| {
            let mut d = 0.0;
            let mut cur: Option<Vec3> = None;
            for m in &r.path.moves {
                if matches!(
                    m.kind,
                    MoveKind::Rapid | MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW
                ) {
                    if let Some(p) = cur {
                        if m.kind != MoveKind::Rapid {
                            d += ((m.to.x - p.x).powi(2)
                                + (m.to.y - p.y).powi(2)
                                + (m.to.z - p.z).powi(2))
                            .sqrt();
                        }
                    }
                    cur = Some(m.to);
                }
            }
            d
        };
        assert!(
            (plan_walk(&arcs) - plan_walk(&flat)).abs() < 1e-9,
            "the plan-derived number DOES differ, so this test is not proving what it claims"
        );

        // An arc travels the arc; the chord that replaces it is shorter. If this
        // is equal, the summary is describing the plan.
        assert!(
            arcs.summary.cutting_distance_mm > flat.summary.cutting_distance_mm + 1e-6,
            "arcs {:.4}mm vs degraded {:.4}mm — the summary did not notice the post",
            arcs.summary.cutting_distance_mm,
            flat.summary.cutting_distance_mm
        );
        assert!(
            arcs.summary.estimated_seconds > flat.summary.estimated_seconds + 1e-9,
            "the shorter program was not estimated as shorter"
        );
    }

    /// The same property on a different field, through the Z DATUM.
    ///
    /// 🔴 **INVERTED, NOT DELETED, when `PostOptions::z_offset_mm` was removed
    /// on 2026-08-11.** This test used to set `post.z_offset_mm = 7.0` — an
    /// arbitrary shift with no physical meaning — purely to prove that
    /// `JobSummary::deepest_z_mm` is read out of the EMITTED PROGRAM and not off
    /// `path.min_z`. That property is the single most load-bearing thing in the
    /// Z-datum change: it is what makes a datum error visible in the summary at
    /// all. Deleting the test with the field would have removed the only
    /// assertion that the summary is not plan-derived, and nothing would have
    /// gone red.
    ///
    /// Re-expressed through the thing that now shifts every emitted Z word:
    /// under [`ZDatum::SpoilboardTop`] the plan is untouched and every Z word
    /// rises by exactly one workpiece thickness, so a through-cut's deepest Z
    /// reads `0.000` rather than `-thickness`.
    #[test]
    fn the_z_datum_moves_the_reported_depth_because_it_moves_every_z_word() {
        let base = plan_job(&job_with(vec![op("a", tool("6mm", 6.0, 6.0))]));
        let mut shifted_job = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        shifted_job.stock.z_datum = ZDatum::SpoilboardTop;
        let thickness = shifted_job.stock.thickness_mm;
        assert!(thickness > 1.0, "a zero-thickness workpiece would make this test vacuous");
        let shifted = plan_job(&shifted_job);

        assert!(
            (base.path.min_z - shifted.path.min_z).abs() < 1e-9,
            "the PLAN must be identical for this to be a provenance test — the datum is \
             translated at the POST, so a moved plan means the frame decision leaked inward"
        );
        assert!(
            (shifted.summary.deepest_z_mm - base.summary.deepest_z_mm - thickness).abs() < 1e-6,
            "deepest Z {:.3} vs {:.3} (thickness {thickness:.3}) — the summary is not reading \
             the emitted Z words",
            shifted.summary.deepest_z_mm,
            base.summary.deepest_z_mm
        );
    }

    /// A probe the machine cannot do is REFUSED by the post, so the program
    /// contains no probe — and the time must not contain one either. The plan
    /// still carries the `Probe` record, so a plan-derived estimate charges for
    /// a sequence that was never written.
    #[test]
    fn a_refused_probe_costs_no_time_because_it_was_never_emitted() {
        let two_tools =
            || vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))];
        let probed = plan_job(&job_with(two_tools()));
        let mut no_probe_job = job_with(two_tools());
        no_probe_job.machine.probe_enabled = false;
        let refused = plan_job(&no_probe_job);

        let probes = |r: &JobResult| {
            r.path.moves.iter().filter(|m| m.kind == MoveKind::Probe).count()
        };
        assert_eq!(probes(&probed), probes(&refused), "both PLANS must still ask for the probe");
        assert!(probes(&refused) > 0);
        assert!(
            probed.summary.estimated_seconds > refused.summary.estimated_seconds + 1e-9,
            "a probe the post refused was still charged: {:.3}s vs {:.3}s",
            probed.summary.estimated_seconds,
            refused.summary.estimated_seconds
        );
    }

    /// The estimate must say what it is, in a channel a UI already renders. A
    /// number this size in the largest text in the window is the thing everyone
    /// trusts; it has to carry its own hedge.
    #[test]
    fn the_estimate_says_it_is_an_estimate_and_says_what_it_leaves_out() {
        let r = plan_job(&job_with(vec![op("a", tool("6mm", 6.0, 6.0))]));
        assert!(r.summary.basis.from_emitted_program);
        assert!(!r.summary.basis.models_acceleration);
        assert!(r.summary.basis.motion_blocks > 0);
        assert!(
            r.notes.iter().any(|n| n.contains("ESTIMATE") && n.contains("acceleration")),
            "the acceleration caveat never reached the notes a host renders: {:?}",
            r.notes
        );
    }

    /// Anything in the emitted program this reader cannot account for is NAMED.
    /// A silently-skipped block is distance and time missing from a total that
    /// still looks complete.
    #[test]
    fn a_clean_program_leaves_nothing_unread() {
        let r = plan_job(&job_with(vec![
            op("a", tool("6mm", 6.0, 6.0)),
            op("b", tool("3mm", 3.0, 6.0)),
        ]));
        assert!(
            r.summary.basis.unread.is_empty(),
            "our own post emitted blocks the estimator cannot read: {:?}",
            r.summary.basis.unread
        );
        // ...and the reader really is capable of complaining — a negative
        // control, so "empty" above is not just an assertion nobody has seen
        // fail.
        let planted = summarize_program("G17 G21 G90\nG73 X10 Y10 Z-5 F100\n", &machine6());
        assert!(
            planted.basis.unread.iter().any(|u| u.contains("G73")),
            "an unknown motion word was swallowed: {:?}",
            planted.basis.unread
        );
    }

    #[test]
    fn the_estimate_walks_the_emitted_moves() {
        let r = plan_job(&job_with(vec![op("a", tool("6mm", 6.0, 6.0))]));
        assert!(r.summary.cutting_distance_mm > 0.0);
        assert!(r.summary.estimated_seconds > 0.0);
        // Sanity: cutting 6 passes around a 120x80 part at 3600mm/min is minutes,
        // not seconds and not hours. A wildly wrong estimate is worse than none.
        assert!(
            r.summary.estimated_seconds > 10.0 && r.summary.estimated_seconds < 3600.0,
            "{}s is not a plausible run time",
            r.summary.estimated_seconds
        );
    }

    #[test]
    fn a_tool_change_is_counted_as_operator_time() {
        let one = plan_job(&job_with(vec![op("a", tool("6mm", 6.0, 6.0))]));
        let two = plan_job(&job_with(vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))]));
        // ⚠ The threshold is the RATE THE JOB DECLARES, not a literal. This
        // line read `+ 60.0` until 2026-08-10 — a third copy of a number that
        // was already duplicated in Rust and TypeScript, sitting in the test
        // that was supposed to be watching it.
        let rate = two.summary.basis.tool_change_seconds;
        assert!(
            two.summary.estimated_seconds > one.summary.estimated_seconds + rate,
            "the change and re-probe cost nothing in the estimate"
        );
    }

    /// Three tools, two changes, and a job built the same way twice at two
    /// different declared rates.
    ///
    /// 🔴 **The load-bearing test for the declared tool-change time**, and it is
    /// written as a DIFFERENCE through a real `plan_job` rather than as an
    /// assertion about the estimator's arithmetic, because the failure it exists
    /// to catch is *"something still charges a constant"*. Reverting
    /// `e.seconds += tool_change_seconds` to any literal makes both runs equal
    /// and this goes red naming the disagreement, which no test that merely
    /// reads `basis.tool_change_seconds` back out would do.
    #[test]
    fn the_estimate_charges_the_declared_rate_once_per_change() {
        let ops = || {
            vec![
                op("a", tool("6mm", 6.0, 6.0)),
                op("b", tool("3mm", 3.0, 6.0)),
                op("c", tool("12mm", 12.0, 6.0)),
            ]
        };
        const RATE: f64 = 90.0;
        let free = job_at_rate(ops(), Some(0.0));
        let paid = job_at_rate(ops(), Some(RATE));
        let (rf, rp) = (plan_job(&free), plan_job(&paid));

        assert_eq!(rf.summary.tool_changes, 2, "expected 2 changes for 3 tools");
        assert_eq!(rp.summary.tool_changes, 2);

        // 🔴 THE PAIRED CONTROL, and it is what makes the delta attributable.
        // Both runs must be the SAME PROGRAM — otherwise a difference in
        // seconds could be a difference in motion, and the test would be
        // measuring the planner instead of the rate.
        assert_eq!(posted(&free), posted(&paid), "the declared rate changed the emitted program");

        let delta = rp.summary.estimated_seconds - rf.summary.estimated_seconds;
        assert!(
            (delta - 2.0 * RATE).abs() < 1e-9,
            "2 tool changes at {RATE}s must cost exactly {}s more than the same job at 0s; the \
             estimate moved by {delta}s. A charge that does not track the declared value is a \
             constant somewhere ({}s vs {}s)",
            2.0 * RATE,
            rp.summary.estimated_seconds,
            rf.summary.estimated_seconds
        );

        // ...and the basis accounts for exactly that much of the total, so the
        // operator time can be subtracted back out by a reader who wants the
        // cutting figure alone.
        assert_eq!(rp.summary.basis.tool_changes_charged, 2);
        assert!((rp.summary.basis.tool_change_seconds - RATE).abs() < 1e-9);
        assert!((rp.summary.basis.tool_change_seconds_total() - 2.0 * RATE).abs() < 1e-9);
        assert!(
            rp.summary.estimated_seconds - rp.summary.basis.tool_change_seconds_total()
                > 0.0,
            "the whole estimate turned out to be operator time, which means no motion was counted"
        );
    }

    /// An undeclared rate is a FALLBACK and every report says so. A declared
    /// value that happens to equal the default is a different fact, and the two
    /// must not render the same.
    #[test]
    fn an_undeclared_rate_falls_back_to_the_default_and_admits_it() {
        let ops = || vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))];
        let silent = plan_job(&job_at_rate(ops(), None));
        assert!(
            !silent.summary.basis.tool_change_rate_declared,
            "a machine that declared nothing reported a declared rate"
        );
        assert!(
            (silent.summary.basis.tool_change_seconds - DEFAULT_TOOL_CHANGE_SECONDS).abs() < 1e-9,
            "the fallback is not the default: {}",
            silent.summary.basis.tool_change_seconds
        );
        assert!(
            silent.notes.iter().any(|n| n.contains("NOT declared") && n.contains("founder")),
            "the report did not say the rate was a fallback nobody measured: {:?}",
            silent.notes
        );

        // The same number, TYPED. Same arithmetic, different fact, different
        // sentence — a shop that has decided 120s is right must not be
        // indistinguishable from a shop that never opened the box.
        let typed = plan_job(&job_at_rate(ops(), Some(DEFAULT_TOOL_CHANGE_SECONDS)));
        assert!(typed.summary.basis.tool_change_rate_declared);
        assert!(
            (typed.summary.estimated_seconds - silent.summary.estimated_seconds).abs() < 1e-9,
            "declaring the default changed the estimate"
        );
        assert!(
            !typed.notes.iter().any(|n| n.contains("NOT declared")),
            "a declared rate was reported as undeclared: {:?}",
            typed.notes
        );
    }

    /// `Some(0.0)` is an ATC, or a shop that has decided not to count operator
    /// time. It is reachable by choice and never by omission, so it must not
    /// collapse into the undeclared case.
    #[test]
    fn a_declared_zero_charges_nothing_and_is_still_a_declaration() {
        let r = plan_job(&job_at_rate(
            vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))],
            Some(0.0),
        ));
        assert!(r.summary.basis.tool_change_rate_declared, "a typed 0 was read as an absence");
        assert_eq!(r.summary.basis.tool_changes_charged, 1);
        assert_eq!(r.summary.basis.tool_change_seconds_total(), 0.0);
        // The note still fires: a change HAPPENED, and "0s of operator time" is
        // a claim about this shop worth reading, unlike "no changes at all".
        assert!(
            r.notes.iter().any(|n| n.contains("manual tool change(s) are charged at 0s each")),
            "a declared zero went unreported: {:?}",
            r.notes
        );
    }

    /// The note exists so a job that is mostly standing at the machine cannot
    /// read as a job that is mostly cutting.
    #[test]
    fn the_operator_time_is_printed_beside_the_estimate_it_is_part_of() {
        let r = plan_job(&job_at_rate(
            vec![
                op("a", tool("6mm", 6.0, 6.0)),
                op("b", tool("3mm", 3.0, 6.0)),
                op("c", tool("12mm", 12.0, 6.0)),
            ],
            Some(600.0),
        ));
        let note = r
            .notes
            .iter()
            .find(|n| n.contains("manual tool change(s) are charged"))
            .unwrap_or_else(|| panic!("no operator-time note: {:?}", r.notes));
        assert!(note.contains("2 manual tool change(s)"), "{note}");
        assert!(note.contains("600s each"), "{note}");
        assert!(note.contains("1200s of the"), "{note}");
        assert!(note.contains("% of it)"), "{note}");
        assert!(note.contains("operator time, NOT machine time"), "{note}");

        // A single-tool job says nothing, deliberately: a line reading "0
        // changes at 600s = 0s" on every job is a line that trains the reader
        // to skip the paragraph.
        let quiet = plan_job(&job_at_rate(vec![op("a", tool("6mm", 6.0, 6.0))], Some(600.0)));
        assert_eq!(quiet.summary.basis.tool_changes_charged, 0);
        assert!(
            !quiet.notes.iter().any(|n| n.contains("manual tool change(s) are charged")),
            "a job with no tool change printed an operator-time note: {:?}",
            quiet.notes
        );
        // ...but the DATA is there unconditionally, so a host is never left to
        // re-derive the rate from prose.
        assert!((quiet.summary.basis.tool_change_seconds - 600.0).abs() < 1e-9);
    }

    /// 🔴 A rate that is not a duration is REFUSED, and the refusal says it is
    /// about the number rather than about the cut. Each limb is asserted beside
    /// a valid rate on the same path that must still emit — a refusing branch
    /// that refuses everything would pass the negative half alone.
    #[test]
    fn a_tool_change_time_that_is_not_a_duration_is_refused() {
        let ops = || vec![op("a", tool("6mm", 6.0, 6.0)), op("b", tool("3mm", 3.0, 6.0))];
        for bad in [-1.0f64, f64::NAN, f64::INFINITY] {
            let r = plan_job(&job_at_rate(ops(), Some(bad)));
            assert!(!r.is_runnable(), "a tool-change time of {bad} planned a runnable job");
            assert!(
                r.refusals.iter().any(|f| f.why.contains("not a duration")),
                "{bad} was refused for the wrong reason: {:?}",
                r.refusals
            );
            assert!(
                r.refusals.iter().any(|f| f.why.contains("not about the safety of the cut")),
                "the refusal borrowed a safety justification it has not earned: {:?}",
                r.refusals
            );
            // G13's property: a refusal means no program exists, not a warning
            // printed above one.
            assert!(
                r.path.moves.is_empty(),
                "a refused job still produced {} moves to post",
                r.path.moves.len()
            );
        }
        // The paired positive, on the same path.
        let ok = plan_job(&job_at_rate(ops(), Some(150.0)));
        assert!(ok.is_runnable(), "a valid rate was refused too: {:?}", ok.refusals);
        assert!((ok.summary.basis.tool_change_seconds - 150.0).abs() < 1e-9);
    }

    #[test]
    fn the_fixture_check_runs_on_the_assembled_path() {
        // An operation can be clear of the clamps while the rapid that links it
        // to the next one is not. Checking each operation alone misses that.
        let mut j = job_with(vec![op("a", tool("6mm", 6.0, 6.0))]);
        j.fixturing = Fixturing {
            clamps: vec![crate::fixture::Clamp::new("bar", 40.0, 40.0, 60.0, 200.0, 40.0)],
            confirmed_clear: false,
        };
        let r = plan_job(&j);
        assert!(!r.is_runnable(), "a job cutting through a clamp was called runnable");
    }
}

#[cfg(test)]
mod technology_tests {
    use super::*;
    use crate::geometry::Contour;
    use crate::tech::Technology;

    fn job_of(t: Technology) -> Job {
        let mut j = Job::new(
            "t",
            Machine { collet_mm: 6.0, probe_enabled: true, ..Machine::default() },
            Stock::default(),
        );
        j.technology = t;
        j.operations = vec![Operation {
            name: "p".into(),
            part: "p".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(50.0, 50.0, 120.0, 80.0),
            tool: Tool { name: "6mm".into(), diameter_mm: 6.0, flutes: 2, chipload_mm: 0.1, ..Tool::default() },
            params: OperationParams { depth_total_mm: 18.0, ..Default::default() },
        }];
        j
    }

    #[test]
    fn a_cnc_job_plans_and_an_unimplemented_one_is_refused() {
        assert!(plan_job(&job_of(Technology::Cnc)).is_runnable());
        let r = plan_job(&job_of(Technology::Fdm));
        assert!(!r.is_runnable(), "an unimplemented process produced a runnable job");
        assert!(r.refusals[0].why.contains("no post-processor"));
        // ...and it produced NO toolpath, so there is nothing to post by mistake.
        assert!(r.path.moves.is_empty());
    }
}

#[cfg(test)]
mod material_datum_tests {
    use super::*;
    use crate::geometry::Contour;

    fn base() -> Job {
        let mut j = Job::new(
            "t",
            Machine { collet_mm: 6.0, probe_enabled: true, ..Machine::default() },
            Stock::default(),
        );
        j.operations = vec![Operation {
            name: "p".into(),
            part: "p".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(50.0, 50.0, 120.0, 80.0),
            tool: Tool { name: "6mm".into(), diameter_mm: 6.0, flutes: 2, chipload_mm: 0.1, ..Tool::default() },
            params: OperationParams { depth_total_mm: 18.0, depth_per_pass_mm: 4.0, ..Default::default() },
        }];
        j
    }

    #[test]
    fn the_material_reaches_the_emitted_feed() {
        let mut ply = base();
        ply.material = Material::Plywood;
        let mut alu = base();
        alu.material = Material::Aluminium;
        let a = plan_job(&ply);
        let b = plan_job(&alu);
        let feed_of = |r: &JobResult| {
            r.path.moves.iter().filter(|m| m.feed > 400.0).map(|m| m.feed).fold(0.0, f64::max)
        };
        assert!(feed_of(&a) > feed_of(&b) * 2.0, "ply {} vs alu {}", feed_of(&a), feed_of(&b));
    }

    #[test]
    fn a_material_that_cannot_take_the_depth_says_so_and_reduces_it() {
        let mut alu = base();
        alu.material = Material::Aluminium;
        let r = plan_job(&alu);
        assert!(
            r.notes.iter().any(|n| n.contains("depth per pass reduced")),
            "the depth was clamped silently: {:?}",
            r.notes
        );
        assert!(r.notes.iter().any(|n| n.contains("spindle reduced")));
    }

    #[test]
    fn the_datum_moves_every_coordinate_by_exactly_the_offset() {
        // 🔴 B2. A datum that moves nothing reads as configured and changes no
        // program.
        let a = plan_job(&base());
        let mut moved = base();
        moved.stock.origin_x_mm = 100.0;
        moved.stock.origin_y_mm = 25.0;
        let b = plan_job(&moved);
        assert!((b.path.min_x - a.path.min_x - 100.0).abs() < 1e-6, "x {} vs {}", b.path.min_x, a.path.min_x);
        assert!((b.path.min_y - a.path.min_y - 25.0).abs() < 1e-6);
        assert!((b.path.max_x - a.path.max_x - 100.0).abs() < 1e-6);
    }

    #[test]
    fn a_datum_that_pushes_the_part_off_the_table_is_refused() {
        // The offset must reach the LIMIT CHECK, not just the coordinates.
        let mut moved = base();
        moved.stock.origin_x_mm = 500.0;
        let r = plan_job(&moved);
        let post = crate::post_grblhal::post_grblhal(
            &r.path,
            &moved.machine,
            &moved.stock,
            &OperationParams::default(),
            &crate::post_grblhal::PostOptions::default(),
        );
        assert!(!post.ok(), "a part pushed outside travel by its datum was accepted");
    }
}

#[cfg(test)]
mod feed_ceiling_tests {
    //! `machine.max_feed_mm_min` on the `tool_id` door — and every assertion here
    //! is on the EMITTED PROGRAM.
    //!
    //! 🔴 **The measurement this module exists for**, taken on a control binary
    //! built from `4e9bb8c758` with only these files reverted:
    //!
    //! ```text
    //! job plate --config '{"tool_id":"End Mill - Down-cut 6mm 2F",
    //!                      "machine":{"max_feed_mm_min":900}}'
    //!   before: exit 0, F3600.0        <- byte-identical to declaring nothing
    //!   after : exit 1, no G-code, "needs 4500rpm, the slowest this tool can be
    //!                                turned on this spindle is 8000rpm"
    //!
    //! job plate --config '{…,"machine":{"max_feed_mm_min":900},
    //!                      "op":{"feed_mm_min":20000}}'
    //!   before: exit 0, F20000.0       <- never reduced, and never refused either
    //!   after : exit 1, no G-code, naming BOTH declarations
    //!
    //! job plate --config '{"tool_ids":["End Mill - Down-cut 6mm 2F"],
    //!                      "machine":{"max_feed_mm_min":1700}}'
    //!   before: F1700 on the ops `recommend` reassigned and F1800 on all
    //!           SIXTEEN part-marking strokes, which keep their own cutter
    //!   after : F1700 throughout, at S17000 with the chip held at 0.050mm
    //! ```
    //!
    //! ⚠ Reading the settings back would make every one of these green about the
    //! plan. `machine.max_feed_mm_min` was *declared* on this door for months and
    //! reached no `F` word; a control that asks the config what it asked for
    //! could never have seen that.

    use super::*;
    use crate::geometry::Contour;
    use crate::post_grblhal::{post_grblhal, PostOptions};
    use crate::tools::default_library;

    fn machine(ceiling: f64) -> Machine {
        Machine { collet_mm: 6.0, max_feed_mm_min: ceiling, ..Machine::default() }
    }

    /// ⌀6 2F at 0.10mm of chip. At the default 18,000rpm it wants
    /// `18000 x 2 x 0.10` = **3,600mm/min**, so a ceiling above that does not
    /// bind and a ceiling below it does — which is what makes one helper enough
    /// for both the positive and the negative case.
    fn six_mm() -> Tool {
        Tool {
            name: "6mm".into(),
            diameter_mm: 6.0,
            shank_mm: 6.0,
            flutes: 2,
            chipload_mm: 0.1,
            ..Tool::default()
        }
    }

    fn job(ceiling: f64) -> Job {
        let mut j = Job::new("t", machine(ceiling), Stock { thickness_mm: 18.0, ..Stock::default() });
        j.operations = vec![Operation {
            name: "p".into(),
            part: "p".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(50.0, 50.0, 120.0, 80.0),
            tool: six_mm(),
            params: OperationParams { depth_total_mm: 6.0, ..Default::default() },
        }];
        j
    }

    fn gcode(j: &Job, r: &JobResult) -> String {
        post_grblhal(&r.path, &j.machine, &j.stock, &OperationParams::default(), &PostOptions::default())
            .gcode
    }

    /// Every `F` word in the emitted text, with parenthesised comments stripped
    /// first — `( tool: … D6.00mm F2 )` is a real line of our own output and the
    /// `F2` in it is a FLUTE COUNT. A reader that took it for a feed would report
    /// 2 as this program's maximum and never fire again.
    fn feeds(gcode: &str) -> Vec<f64> {
        let mut out = Vec::new();
        for line in gcode.lines() {
            let line = line.split(';').next().unwrap_or("");
            let mut depth = 0usize;
            let mut bare = String::new();
            for c in line.chars() {
                match c {
                    '(' => depth += 1,
                    ')' => depth = depth.saturating_sub(1),
                    _ if depth == 0 => bare.push(c),
                    _ => {}
                }
            }
            for tok in bare.split_whitespace() {
                if let Some(v) = tok.strip_prefix('F').and_then(|r| r.parse::<f64>().ok()) {
                    out.push(v);
                }
            }
        }
        out
    }

    /// Every `S` word, same stripping.
    fn speeds(gcode: &str) -> Vec<f64> {
        let mut out = Vec::new();
        for line in gcode.lines() {
            let line = line.split('(').next().unwrap_or("");
            for tok in line.split_whitespace() {
                if let Some(v) = tok.strip_prefix('S').and_then(|r| r.parse::<f64>().ok()) {
                    out.push(v);
                }
            }
        }
        out
    }

    // -- door 1: a derived feed, against a declared ceiling -------------------

    /// 🔴 THE PLANT FOR DOOR 1, ASSERTED FIRST SO THE FIX IS NOT A FIX TO A
    /// PROBLEM NOBODY HAD — and asserted on **one job**, so the plant and the
    /// behaviour it justifies are about the same numbers.
    ///
    /// The ⌀12 2F exactly as `default_library()` ships it (0.15 / 0.30 / 0.50mm
    /// of chip) at the default 18,000rpm wants 10,800mm/min. Under a 5,000
    /// ceiling:
    ///
    /// ```text
    /// feed.min(ceiling) at unchanged rpm -> 5000 / (18000 x 2) = 0.139mm  <- BELOW its own 0.150
    /// spindle down to hold the chip      -> S8333 F5000        = 0.300mm  <- where it was
    /// ```
    ///
    /// ⚠ The ⌀6 used elsewhere in this module CANNOT show this: its declared
    /// minimum is 0.02mm, so every ceiling that would thin its chip out of
    /// window is already a ceiling no runnable speed can meet. A plant has to be
    /// built on a tool whose window is narrow enough to be left.
    #[test]
    fn the_naive_clamp_this_door_did_not_even_do_would_have_been_out_of_window() {
        let t = Tool {
            name: "12mm".into(),
            diameter_mm: 12.0,
            shank_mm: 12.0,
            flutes: 2,
            chipload_mm: 0.30,
            chipload_min_mm: 0.15,
            chipload_max_mm: 0.50,
            ..Tool::default()
        };
        let naive = (18_000.0 * 2.0 * 0.30_f64).min(5_000.0);
        assert_eq!(naive, 5_000.0);
        let v = crate::feeds::chip_verdict(&t, 18_000.0, naive);
        assert!(!v.in_window(), "the naive clamp was supposed to leave the window: {v:?}");
        assert!(v.why().contains("rubs"), "{}", v.why());

        // ...and the same cutter through the real door holds the chip instead.
        let mut j = job(5_000.0);
        j.operations[0].tool = t.clone();
        j.machine.spare_collets_mm = vec![12.0];
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        let g = gcode(&j, &r);
        assert!(feeds(&g).contains(&5_000.0), "{:?}", feeds(&g));
        let s = *speeds(&g).first().expect("the program starts the spindle");
        assert!((s - 8_333.0).abs() < 1.0, "S{s} is not the speed that holds a 0.300 chip");
        assert!(
            crate::feeds::chip_verdict(&t, s, 5_000.0).in_window(),
            "the emitted pair is out of window: {:?}",
            crate::feeds::chip_verdict(&t, s, 5_000.0)
        );
    }

    #[test]
    fn a_binding_ceiling_takes_the_spindle_down_in_the_emitted_program() {
        let j = job(2_000.0);
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        let g = gcode(&j, &r);

        // The feed word obeys the ceiling…
        let hi = feeds(&g).into_iter().fold(0.0_f64, f64::max);
        assert!(hi <= 2_000.0 + 1e-9, "the emitted program commands F{hi} under a 2000 ceiling");
        assert!(feeds(&g).contains(&2_000.0), "nothing was cut at the ceiling: {:?}", feeds(&g));

        // …and the SPINDLE is what came down to let it, not the chip.
        assert!(speeds(&g).contains(&10_000.0), "S words were {:?}", speeds(&g));
        // 🔴 The assertion that matters: what the emitted pair DELIVERS.
        assert!(
            crate::feeds::chip_verdict(&six_mm(), 10_000.0, 2_000.0).in_window(),
            "the emitted pair left the cutter's window"
        );
        assert!(
            (crate::feeds::chipload_from_feed(&six_mm(), 10_000.0, 2_000.0) - 0.10).abs() < 1e-9,
            "the chip moved"
        );
        assert!(
            r.notes.iter().any(|n| n.contains("SPINDLE came down")),
            "the program changed and said nothing: {:?}",
            r.notes
        );
    }

    /// 🔴 THE NEGATIVE CONTROL, and it is the one that matters: a job that was
    /// correct before must be byte-identical after. A resolution that always
    /// "helps" has moved every job it touched.
    #[test]
    fn a_ceiling_that_does_not_bind_changes_not_one_byte_and_says_nothing() {
        let undeclared = job(0.0);
        let generous = job(6_000.0);
        let a = plan_job(&undeclared);
        let b = plan_job(&generous);
        assert_eq!(gcode(&undeclared, &a), gcode(&generous, &b));
        assert_eq!(a.notes, b.notes);
        assert!(
            !b.notes.iter().any(|n| n.contains("SPINDLE came down")),
            "an untouched cut announced a change: {:?}",
            b.notes
        );
        // …and the feed is still the one the tool and the material derive.
        assert!(feeds(&gcode(&generous, &b)).contains(&3_600.0));
    }

    #[test]
    fn when_no_speed_holds_the_chip_the_job_is_refused_and_no_program_is_built() {
        let j = job(900.0);
        let r = plan_job(&j);
        assert!(!r.is_runnable(), "a job with no runnable in-window speed was called runnable");
        // 🔴 Not "no G-code was printed" — no PATH was built, so there is nothing
        // for a caller to post by mistake.
        assert!(r.path.moves.is_empty(), "a refused job produced a program to post");
        let said = r.refusals.iter().map(|x| x.why.clone()).collect::<Vec<_>>().join("\n");
        assert!(said.contains("4500rpm"), "the rpm it needs is not named: {said}");
        assert!(said.contains("8000rpm"), "the floor that blocks it is not named: {said}");
        assert!(said.contains("under-chipped"), "{said}");
    }

    /// 🔴 A defect whose only symptom is an ABSENCE, so it gets a test. The
    /// first cut of this change ran the chip-window check over every operation
    /// unconditionally — including the ones that had just been refused, whose
    /// feed is still 0. `job plate` under a 900 ceiling then printed **21**
    /// copies of *"the emitted feed delivers 0.000mm of chip per tooth"*: a
    /// sentence about an emitted program, beside the refusal that stopped one
    /// existing. An operator reading it would go looking for a cut that is not
    /// in the file.
    #[test]
    fn a_refused_operation_gets_no_note_about_the_program_it_did_not_produce() {
        for j in [
            job(900.0), // no runnable speed
            {
                let mut j = job(900.0); // pinned over the ceiling
                j.operations[0].params.feed_mm_min = 20_000.0;
                j
            },
        ] {
            let r = plan_job(&j);
            assert!(!r.is_runnable());
            assert!(
                !r.notes.iter().any(|n| n.contains("the emitted feed delivers")),
                "a refused job described the chip of a program it never emitted: {:?}",
                r.notes
            );
        }
    }

    // -- door 2: a feed the operator TYPED ------------------------------------

    #[test]
    fn a_pinned_feed_above_the_ceiling_is_refused_rather_than_quietly_reduced() {
        let mut j = job(900.0);
        j.operations[0].params.feed_mm_min = 20_000.0;
        let r = plan_job(&j);
        assert!(!r.is_runnable(), "F20000 against a declared 900 was accepted");
        assert!(r.path.moves.is_empty(), "a refused job produced a program to post");
        let said = r.refusals.iter().map(|x| x.why.clone()).collect::<Vec<_>>().join("\n");
        // Both declarations, or the operator cannot tell which one to change.
        assert!(said.contains("20000") && said.contains("900"), "{said}");
        assert!(said.contains("REFUSED"), "{said}");
        // 🔴 And the refusal must not be reachable by reading it as a clamp: no
        // program exists, so nothing ran at 900 either.
        assert!(
            !r.refusals.is_empty() && r.summary.tools_used.is_empty(),
            "something was planned anyway: {:?}",
            r.summary.tools_used
        );
    }

    #[test]
    fn a_pinned_feed_inside_the_ceiling_reaches_the_program_exactly_as_typed() {
        // The negative control for door 2, and the one that proves the rule is
        // not "refuse every pinned feed".
        let mut j = job(900.0);
        j.operations[0].params.feed_mm_min = 800.0;
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        let f = feeds(&gcode(&j, &r));
        assert!(f.contains(&800.0), "the typed feed is not in the program: {f:?}");
        assert!(
            !f.iter().any(|v| *v > 800.0 && *v < 3_600.1 && *v != 300.0),
            "something derived a feed over a pinned one: {f:?}"
        );
    }

    /// A pinned feed that is inside the ceiling can still be nowhere near the
    /// cutter's own window, and until now **nothing looked**. It is a note and
    /// not a refusal — every chipload window in `default_library()` bar one is
    /// unsourced — but silence and a check are different facts.
    #[test]
    fn a_pinned_feed_out_of_the_cutters_window_is_named_even_though_it_is_allowed() {
        let mut j = job(0.0); // no ceiling declared at all
        j.operations[0].params.feed_mm_min = 20_000.0;
        let r = plan_job(&j);
        assert!(r.is_runnable(), "an unsourced window must not refuse: {:?}", r.refusals);
        assert!(feeds(&gcode(&j, &r)).contains(&20_000.0), "the typed feed was moved");
        assert!(
            r.notes.iter().any(|n| n.contains("ABOVE this cutter's")),
            "0.556mm of chip per tooth against a 0.300 maximum went unmentioned: {:?}",
            r.notes
        );
    }

    /// 🔴 The behaviour this change alters beyond the three doors, pinned so it
    /// cannot drift back: **the material's rpm cap no longer overwrites a feed
    /// the operator typed.** It used to re-derive it (`feed_for` at the capped
    /// rpm), which is the same overrule `PinnedFeed` has no arm for.
    #[test]
    fn the_material_rpm_cap_moves_the_spindle_and_leaves_a_pinned_feed_alone() {
        let mut j = job(0.0);
        j.material = Material::Aluminium; // caps rpm at 12,000
        j.operations[0].params.feed_mm_min = 500.0;
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        let g = gcode(&j, &r);
        assert!(speeds(&g).contains(&12_000.0), "the material cap did not reach the S word: {:?}", speeds(&g));
        assert!(
            feeds(&g).contains(&500.0),
            "the typed feed was replaced by a derived one: {:?}",
            feeds(&g)
        );
        assert!(r.notes.iter().any(|n| n.contains("spindle reduced")));
    }

    // -- door 3: the operations `recommend` never reassigns -------------------

    /// 🔴 THE MARKING LEAK. `recommend` clamps only what it assigns; a
    /// part-marking operation keeps its own cutter and derives its feed here, so
    /// the clamped door leaked on exactly the operations it declined to touch.
    /// Measured on the control binary: sixteen `plate-markN` strokes at **F1800
    /// against a declared 1700** while every reassigned operation sat at F1700.
    #[test]
    fn an_operation_the_recommender_declines_still_meets_the_ceiling() {
        let lib = default_library();
        let mut j = Job::new(
            "mark",
            machine(1_700.0),
            Stock { thickness_mm: 18.0, ..Stock::default() },
        );
        j.operations = vec![
            Operation {
                name: "panel".into(),
                part: "panel".into(),
                role: crate::toolpath::OpRole::Releasing,
                contour: Contour::rect(50.0, 50.0, 120.0, 80.0),
                tool: six_mm(),
                params: OperationParams { depth_total_mm: 18.0, ..Default::default() },
            },
            Operation {
                name: "mark".into(),
                part: "panel".into(),
                role: crate::toolpath::OpRole::Interior,
                contour: Contour::rect(60.0, 60.0, 20.0, 20.0),
                // The 3.175mm marking cutter, exactly as `default_library()`
                // ships it: 2F at 0.05mm, so 18,000rpm wants 1,800mm/min.
                tool: Tool {
                    name: "3.175mm".into(),
                    diameter_mm: 3.175,
                    shank_mm: 3.175,
                    flutes: 2,
                    chipload_mm: 0.05,
                    chipload_min_mm: 0.02,
                    chipload_max_mm: 0.10,
                    ..Tool::default()
                },
                params: OperationParams {
                    op_type: OpType::Engrave,
                    side: CutSide::OnLine,
                    depth_total_mm: 0.4,
                    depth_per_pass_mm: 0.4,
                    tabs: TabSpec { enabled: false, ..TabSpec::default() },
                    ..Default::default()
                },
            },
        ];
        j.machine.spare_collets_mm = vec![3.175];

        let r = plan_job_with_tools(&j, &["End Mill - Down-cut 6mm 2F".to_string()], &lib);
        assert!(r.is_runnable(), "{:?} {:?}", r.refusals, r.fixture_findings);

        // The engraving kept its own cutter — that is the premise, and if it ever
        // stops being true this test is measuring something else.
        assert!(
            r.summary.tools_used.iter().any(|t| t.contains("3.175")),
            "the marking cutter was reassigned, so the leak this test is about \
             cannot occur here: {:?}",
            r.summary.tools_used
        );

        let g = gcode(&j, &r);
        let hi = feeds(&g).into_iter().fold(0.0_f64, f64::max);
        assert!(
            hi <= 1_700.0 + 1e-9,
            "an operation the recommender declined emitted F{hi} against a declared 1700"
        );
        assert!(feeds(&g).contains(&1_700.0), "nothing reached the ceiling: {:?}", feeds(&g));
        assert!(
            speeds(&g).contains(&17_000.0),
            "the marking spindle did not come down: {:?}",
            speeds(&g)
        );
    }

    // -- door 4: the plunge, which is a cutting feed on the Z axis ------------

    /// 🔴 THE PLANT FOR DOOR 4, AND IT IS AT THE EMITTED PROGRAM. Measured on
    /// the control binary at HEAD `026a6c9523`:
    ///
    /// ```text
    /// job plate --config '{"machine":{"max_feed_mm_min":150},"op":{"feed_mm_min":100}}'
    ///   before: exit 0, 515 lines, 22 x "G1 Z… F300.0"   <- 2x the declared ceiling
    ///           (16 plunges to Z-0.400, 6 returns to Z0.000)
    ///           while every lateral cut sat at F100.0
    ///   after : exit 1, no G-code, 21 refusals — one per operation, both numbers named
    /// ```
    ///
    /// ⚠ It asserts on `G1 Z…` lines specifically, not on the maximum `F` in the
    /// program. The maximum would have been satisfied by the pinned lateral feed
    /// alone on a job where the plunge happened to be lower — a check that can
    /// be answered by the wrong line is a check about the wrong thing.
    #[test]
    fn a_plunge_over_the_ceiling_is_refused_and_no_program_comes_back() {
        // The premise first: at a ceiling ABOVE the plunge, the program is
        // emitted and the plunge is in it. Without this, "no program" below
        // could be caused by anything.
        let mut ok = job(6_000.0);
        ok.operations[0].params.feed_mm_min = 100.0;
        let r_ok = plan_job(&ok);
        assert!(r_ok.is_runnable(), "{:?}", r_ok.refusals);
        let g_ok = gcode(&ok, &r_ok);
        let plunges: Vec<f64> = g_ok
            .lines()
            .filter(|l| l.starts_with("G1 Z"))
            .filter_map(|l| {
                l.split_whitespace()
                    .find_map(|t| t.strip_prefix('F').and_then(|v| v.parse::<f64>().ok()))
            })
            .collect();
        assert!(
            plunges.contains(&300.0),
            "the plunge this test is about is not in the emitted program: {plunges:?}"
        );

        // ...and now the same job under a ceiling BELOW it.
        let mut low = job(150.0);
        low.operations[0].params.feed_mm_min = 100.0;
        let r = plan_job(&low);
        assert!(!r.is_runnable(), "a 300mm/min plunge ran under a declared 150 ceiling");
        assert!(
            r.path.moves.is_empty(),
            "a refused job built a path anyway — there is something to post by mistake"
        );
        let why = r.refusals.iter().map(|x| x.why.clone()).collect::<Vec<_>>().join(" ");
        assert!(why.contains("plunge"), "{why}");
        assert!(why.contains("300") && why.contains("150"), "{why}");
        assert!(why.contains("CUTTING MOVE"), "{why}");
    }

    /// The negative control for door 4: a ceiling that does not bind the plunge
    /// must change **not one byte**. A refusal that fires on every job is a
    /// refusal that gets switched off.
    #[test]
    fn a_ceiling_above_the_plunge_changes_nothing_and_says_nothing_about_it() {
        let mut j = job(6_000.0);
        j.operations[0].params.feed_mm_min = 100.0;
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?}", r.refusals);
        assert!(
            !r.notes.iter().chain(r.refusals.iter().map(|x| &x.why)).any(|n| n.contains("plunge")),
            "an untouched plunge spoke: {:?} {:?}",
            r.notes,
            r.refusals
        );
        // Byte-for-byte against the same job with NO ceiling declared at all.
        let mut none = job(0.0);
        none.operations[0].params.feed_mm_min = 100.0;
        let r_none = plan_job(&none);
        assert_eq!(
            gcode(&j, &r),
            gcode(&none, &r_none),
            "declaring a ceiling that does not bind moved the program"
        );
    }

    /// 🔴 AND THE PLUNGE IS JUDGED EVEN WHEN THE LATERAL FEED ALREADY REFUSED.
    /// Reporting one fault per run is how the second one is found at the
    /// machine: an operator fixes the feed, re-runs, and meets the plunge.
    #[test]
    fn a_job_that_breaks_both_the_feed_and_the_plunge_is_told_about_both() {
        let mut j = job(150.0);
        j.operations[0].params.feed_mm_min = 20_000.0; // a pinned feed over the ceiling
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        let why = r.refusals.iter().map(|x| x.why.clone()).collect::<Vec<_>>().join(" | ");
        assert!(why.contains("20000"), "the pinned feed was not reported: {why}");
        assert!(why.contains("plunge"), "the plunge was not reported: {why}");
    }
}

#[cfg(test)]
mod wiring_tests {
    //! The four engines, exercised through the planning path a host actually
    //! uses — not through their own front doors.
    //!
    //! Each test names the failure it guards. A test that only proved the
    //! function was *called* would pass just as well with the check disarmed,
    //! which is the class of green this lane keeps finding in other people's
    //! code and has just spent a night manufacturing four of.

    use super::*;
    use crate::geometry::{Contour, Part};
    use crate::layout::PlacedDrawing;
    use crate::post_grblhal::post_grblhal;
    use crate::tools::default_library;

    fn machine6() -> Machine {
        Machine { collet_mm: 6.0, probe_enabled: true, ..Machine::default() }
    }

    fn tool6() -> Tool {
        Tool {
            name: "6mm".into(),
            diameter_mm: 6.0,
            shank_mm: 6.0,
            flutes: 2,
            chipload_mm: 0.1,
            ..Tool::default()
        }
    }

    fn profile_op(name: &str, c: Contour) -> Operation {
        let (part, role) = crate::toolpath::test_part_and_role(name);
        Operation {
            name: name.into(),
            part,
            role,
            contour: c,
            tool: tool6(),
            params: OperationParams {
                side: CutSide::Outside,
                depth_total_mm: 12.0,
                ..OperationParams::default()
            },
        }
    }

    fn drill_op(name: &str, x: f64, y: f64) -> Operation {
        // A drilled hole is interior work whatever it is called — this helper
        // builds holes and nothing else, so it states the role outright rather
        // than routing through the name mapping.
        Operation {
            name: name.into(),
            part: crate::toolpath::test_part_and_role(name).0,
            role: crate::toolpath::OpRole::Interior,
            contour: Contour::circle(x, y, 3.0),
            tool: tool6(),
            params: OperationParams {
                side: CutSide::Inside,
                op_type: OpType::Drill,
                depth_total_mm: 12.0,
                ..OperationParams::default()
            },
        }
    }

    fn job_with(ops: Vec<Operation>) -> Job {
        Job { operations: ops, ..Job::new("wiring", machine6(), Stock::default()) }
    }

    // -- 2. layout: interference is a REFUSAL, not an optional call -----------

    fn square(id: &str, x: f64, y: f64) -> PlacedDrawing {
        PlacedDrawing::new(id, vec![Part::new("p", Contour::rect(0.0, 0.0, 100.0, 100.0))])
            .expect("a drawing with an id and a part is valid")
            .at(x, y)
    }

    fn layout_of(a: PlacedDrawing, b: PlacedDrawing) -> Layout {
        let mut l = Layout::new();
        l.add(a).expect("first drawing");
        l.add(b).expect("second drawing");
        l
    }

    #[test]
    fn two_overlapping_parts_are_refused_and_both_are_named() {
        // 🔴 The physical failure: cutting one part removes the other's edge and
        // leaves it loose under a 2.2 kW spindle while the program is still
        // running. Before this wiring a caller could reach G-code by simply
        // never calling `Layout::check`.
        let l = layout_of(square("a", 50.0, 50.0), square("b", 90.0, 50.0));
        let r = plan_layout_job(
            &Job::new("nest", machine6(), Stock::default()),
            &l,
            &tool6(),
            &OperationParams { depth_total_mm: 12.0, ..OperationParams::default() },
            1.0,
        );

        assert!(!r.is_runnable(), "an overlapping nest was called runnable");
        assert!(r.path.moves.is_empty(), "an overlapping nest produced a toolpath to post");

        let said = r
            .refusals
            .iter()
            .map(|x| format!("{} :: {}", x.what, x.why))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(said.contains("a/p"), "the refusal does not name the first part: {said}");
        assert!(said.contains("b/p"), "the refusal does not name the second part: {said}");
        assert!(said.contains("OVERLAP"), "the refusal does not say what is wrong: {said}");
    }

    #[test]
    fn parts_closer_than_the_cutter_are_refused_even_though_they_do_not_overlap() {
        // The dangerous one: snapping two parts nearly flush is the most natural
        // gesture a person makes, and a check that only looked for shared
        // material would call a 3mm channel clean.
        let l = layout_of(square("a", 50.0, 50.0), square("b", 153.0, 50.0));
        let r = plan_layout_job(
            &Job::new("nest", machine6(), Stock::default()),
            &l,
            &tool6(),
            &OperationParams { depth_total_mm: 12.0, ..OperationParams::default() },
            1.0,
        );
        assert!(!r.is_runnable(), "a 3mm channel for a 6mm cutter was called runnable");
        let said = r.refusals.iter().map(|x| x.why.clone()).collect::<Vec<_>>().join("\n");
        assert!(said.contains("TOO CLOSE"), "{said}");
    }

    #[test]
    fn a_clear_nest_is_not_refused_so_the_two_tests_above_are_not_vacuous() {
        // The negative control. Without it, a `plan_layout_job` that refused
        // everything would pass both tests above.
        let l = layout_of(square("a", 50.0, 50.0), square("b", 250.0, 50.0));
        let r = plan_layout_job(
            &Job::new("nest", machine6(), Stock::default()),
            &l,
            &tool6(),
            &OperationParams { depth_total_mm: 12.0, ..OperationParams::default() },
            1.0,
        );
        assert!(r.is_runnable(), "a clear nest was refused: {:?}", r.refusals);
        assert!(!r.path.moves.is_empty(), "a clear nest produced no program");
    }

    // -- 3. placement: a NOTE and an OFFER, never an action -------------------

    #[test]
    fn a_program_outside_travel_carries_the_shift_that_would_fix_it() {
        // `cad`'s real failure: geometry straight from CAD starts at or below
        // zero, the cutter centre runs a radius further out, and the controller
        // refuses the program. The answer is reported with its numbers.
        let j = job_with(vec![profile_op("part", Contour::rect(-10.0, -10.0, 100.0, 100.0))]);
        let r = plan_job(&j);

        let fix = r
            .offered_fixes
            .iter()
            .find(|f| f.id == "datum-shift")
            .unwrap_or_else(|| panic!("no datum shift offered: {:?}", r.notes));

        assert_eq!(fix.from, vec![0.0, 0.0], "the fix does not say where the datum is now");
        assert_eq!(fix.what_it_changes, "stock.origin_x_mm, stock.origin_y_mm");
        assert_eq!(fix.units, "mm");
        assert_eq!(fix.fixes, "outside-travel");
        assert!(fix.to[0] > 0.0 && fix.to[1] > 0.0, "the shift does not move it inside: {fix:?}");

        // ...and the same numbers are in the note, so a host that renders only
        // notes is not left with a refusal it cannot act on.
        let want = format!("X {:+.3}", fix.to[0] - fix.from[0]);
        assert!(
            r.notes.iter().any(|n| n.contains("move the datum by") && n.contains(&want)),
            "the note does not carry the numbers ({want}): {:?}",
            r.notes
        );

        // 🔴 AND NOTHING MOVED. Applying it would move the part relative to
        // clamps bolted to the machine — gate P7's physical failure.
        assert_eq!(j.stock.origin_x_mm, 0.0, "plan_job applied the datum shift");
        assert_eq!(j.stock.origin_y_mm, 0.0, "plan_job applied the datum shift");
        assert!(r.path.min_x < 0.0, "the program was silently moved inside travel");
    }

    #[test]
    fn a_program_bigger_than_the_table_is_told_so_and_offered_nothing() {
        // A shift clamped to "as close as we could get" reads as an answer while
        // the extent still hangs outside the travel. An empty offer is the honest one.
        let mut j = job_with(vec![profile_op("huge", Contour::rect(0.0, 0.0, 1200.0, 100.0))]);
        j.machine.travel_x_mm = 600.0;
        let r = plan_job(&j);
        assert!(
            r.notes.iter().any(|n| n.contains("NO datum shift can help")),
            "an unfittable program was not named as such: {:?}",
            r.notes
        );
        assert!(
            !r.offered_fixes.iter().any(|f| f.id == "datum-shift"),
            "a shift was offered for a program larger than the travel"
        );
    }

    #[test]
    fn a_program_already_inside_travel_is_offered_nothing_and_told_nothing() {
        let r = plan_job(&job_with(vec![profile_op("part", Contour::rect(50.0, 50.0, 100.0, 100.0))]));
        assert!(r.offered_fixes.is_empty(), "{:?}", r.offered_fixes);
        assert!(
            !r.notes.iter().any(|n| n.contains("move the datum by")),
            "a job that fits was told to move: {:?}",
            r.notes
        );
    }

    #[test]
    fn a_sheet_that_only_fits_turned_is_offered_the_turn() {
        let mut j = job_with(vec![profile_op("part", Contour::rect(10.0, 10.0, 50.0, 50.0))]);
        j.stock.size_x_mm = 900.0;
        j.stock.size_y_mm = 600.0;
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        let fix = r
            .offered_fixes
            .iter()
            .find(|f| f.id == "sheet-quarter-turn")
            .unwrap_or_else(|| panic!("no turn offered: {:?}", r.refusals));
        assert_eq!(fix.fixes, "stock-larger-than-travel");
        assert_eq!(fix.units, "degrees");
        assert_eq!(fix.from, vec![0.0]);
        assert_eq!(fix.to, vec![90.0]);
    }

    #[test]
    fn every_offered_fix_says_what_must_be_re_checked_afterwards() {
        // 🔴 The property, asserted rather than left in a doc comment: there is
        // no fix here that a person may take without re-checking, because a
        // shift that clears a travel limit can put the toolpath through a clamp.
        let mut turned = job_with(vec![profile_op("part", Contour::rect(10.0, 10.0, 50.0, 50.0))]);
        turned.stock.size_x_mm = 900.0;
        turned.stock.size_y_mm = 600.0;

        let outside = plan_job(&job_with(vec![profile_op(
            "part",
            Contour::rect(-10.0, -10.0, 100.0, 100.0),
        )]));

        let all: Vec<OfferedFix> = plan_job(&turned)
            .offered_fixes
            .into_iter()
            .chain(outside.offered_fixes)
            .collect();
        assert!(all.len() >= 2, "this test stopped covering both fixes: {all:?}");
        for f in &all {
            assert!(!f.recheck.is_empty(), "{} is offered with nothing to re-check", f.id);
            assert!(
                f.recheck.iter().any(|r| r.contains("clamps")),
                "{} does not warn about the clamps",
                f.id
            );
            assert!(!f.why.is_empty(), "{} does not say why", f.id);
            assert_eq!(f.from.len(), f.to.len(), "{} changes a different number of values", f.id);
        }
    }

    // -- 1. the route report's own measured numbers reach the notes -----------

    fn scattered_panel() -> Vec<Operation> {
        // Deliberately the worst order: every hole is followed by the one
        // furthest from it.
        vec![
            drill_op("h1", 20.0, 20.0),
            drill_op("h2", 380.0, 380.0),
            drill_op("h3", 30.0, 20.0),
            drill_op("h4", 370.0, 380.0),
            drill_op("h5", 40.0, 20.0),
            drill_op("h6", 360.0, 380.0),
            profile_op("panel", Contour::rect(0.0, 0.0, 400.0, 400.0)),
        ]
    }

    #[test]
    fn the_route_reports_the_reduction_it_measured_and_not_a_promise() {
        let ops = scattered_panel();
        let (_, expected) = optimise_route(ops.clone());
        assert!(
            expected.reduction_mm() > 1.0,
            "the fixture no longer has travel to save, so this test proves nothing: {expected:?}"
        );

        let r = plan_job(&job_with(ops));
        let want = format!(
            "{:.1}mm before, {:.1}mm after",
            expected.link_travel_before_mm, expected.link_travel_after_mm
        );
        let note = r
            .notes
            .iter()
            .find(|n| n.starts_with("route ("))
            .unwrap_or_else(|| panic!("no route note: {:?}", r.notes));
        assert!(note.contains(&want), "the note is not the measurement ({want}): {note}");
        // The two travel numbers are different quantities and the note has to
        // say so, or a UI will subtract one from the other.
        assert!(note.contains("NOT the emitted program's rapid distance"), "{note}");
    }

    #[test]
    fn reordering_moves_no_coordinate() {
        // 🔴 The property the whole "run it BEFORE the gates" argument rests on.
        // Two different input orders of the same operations must cut exactly the
        // same material; only the travel between cuts may differ.
        let a = plan_job(&job_with(scattered_panel()));
        let mut rotated = scattered_panel();
        rotated.rotate_left(3);
        let b = plan_job(&job_with(rotated));
        assert!(
            (a.summary.cutting_distance_mm - b.summary.cutting_distance_mm).abs() < 1e-6,
            "reordering changed what is cut: {} vs {}",
            a.summary.cutting_distance_mm,
            b.summary.cutting_distance_mm
        );
        assert!((a.summary.deepest_z_mm - b.summary.deepest_z_mm).abs() < 1e-9);
    }

    #[test]
    fn a_single_operation_is_not_reported_as_a_zero_percent_improvement() {
        let r = plan_job(&job_with(vec![profile_op("part", Contour::rect(50.0, 50.0, 100.0, 100.0))]));
        assert!(
            !r.notes.iter().any(|n| n.starts_with("route (")),
            "a one-operation job claimed an optimisation ran: {:?}",
            r.notes
        );
    }

    // -- 4. a tool SET, per feature — and the singular path untouched ---------

    fn set_job() -> Job {
        // A 5mm hole and a profile: no single cutter does both, which is exactly
        // the job `tool_id` collapses.
        let mut j = Job::new("set", machine6(), Stock { thickness_mm: 18.0, ..Stock::default() });
        j.operations = vec![
            Operation {
                name: "hole".into(),
                part: "set".into(),
                role: crate::toolpath::OpRole::Interior,
                contour: Contour::circle(200.0, 200.0, 2.5),
                tool: tool6(),
                params: OperationParams {
                    side: CutSide::Inside,
                    op_type: OpType::Profile,
                    depth_total_mm: 18.0,
                    ..OperationParams::default()
                },
            },
            profile_op("panel", Contour::rect(100.0, 100.0, 200.0, 200.0)),
        ];
        j.operations[1].params.depth_total_mm = 18.0;
        j
    }

    #[test]
    fn a_tool_set_assigns_a_different_tool_to_a_different_feature() {
        let lib = default_library();
        let set = vec![
            "End Mill - Down-cut 6mm 2F".to_string(),
            "Drill - Brad Point 5mm 2F".to_string(),
        ];

        let mut j = set_job();
        let a = assign_tools_from_set(&mut j, &set, &lib);
        assert!(a.refusals.is_empty(), "{:?}", a.refusals);

        assert_eq!(j.operations[0].tool.name, "Drill - Brad Point 5mm 2F");
        assert_eq!(j.operations[1].tool.name, "End Mill - Down-cut 6mm 2F");
        // ...and the operation type followed the tool: a 5mm drill in a 5mm hole
        // is a drilled hole, not an interpolated bore around a path that has no
        // width left.
        assert_eq!(j.operations[0].params.op_type, OpType::Drill);
        // ...and so did the cutting parameters. A tool assigned without its
        // feeds is a tool running at another tool's feeds. Asserted against what
        // the NEW tool derives, not against the old value — the two cutters here
        // happen to share a chipload, so a "they differ" test would prove
        // nothing about where the number came from.
        //
        // ⚠ This used to compute the expectation as
        // `feed_for(..).min(machine.max_feed_mm_min)` — the naive clamp, written
        // into the test as the definition of correct. It agreed with the code
        // only because nothing here binds; on a job where the ceiling DID bind
        // it would have demanded the under-chipped program `a6c3816e66` removed.
        // A test that re-states a defect vouches for it, so the expectation is
        // now taken from the same resolution the code uses.
        for op in &j.operations {
            let want = crate::feeds::resolve_feed(
                &op.tool,
                op.params.rpm,
                op.tool.chipload_mm * j.material.chipload_factor(),
                j.machine.max_feed_mm_min,
                op.tool.rpm_min.max(j.machine.spindle_min_rpm),
            )
            .rpm_feed()
            .expect("both cutters here are runnable");
            assert!(
                (op.params.feed_mm_min - want.1).abs() < 1e-6
                    && (op.params.rpm - want.0).abs() < 1e-6,
                "{}: {}rpm/{}mm/min is not this tool's ({:?})",
                op.name,
                op.params.rpm,
                op.params.feed_mm_min,
                want
            );
        }
        assert!(
            (j.operations[0].params.depth_per_pass_mm - j.operations[1].params.depth_per_pass_mm)
                .abs()
                > 0.1,
            "the 5mm and 6mm cutters took the same depth per pass"
        );

        let r = plan_job_with_tools(&set_job(), &set, &lib);
        assert!(r.is_runnable(), "{:?} {:?}", r.refusals, r.fixture_findings);
        assert_eq!(r.summary.tools_used.len(), 2, "{:?}", r.summary.tools_used);
        assert_eq!(r.summary.tool_changes, 1);
        assert!(
            r.notes.iter().any(|n| n.contains("exact match for the 5mm hole")),
            "the choice was made without saying why: {:?}",
            r.notes
        );
    }

    #[test]
    fn a_feature_no_selected_tool_can_cut_is_refused_and_produces_no_program() {
        // 🔴 Never a fallback to the tool the operation happened to arrive with.
        // A 12mm cutter in a 5mm hole is not a near miss.
        let lib = default_library();
        let mut j = set_job();
        j.machine.spare_collets_mm = vec![12.0];
        let r = plan_job_with_tools(&j, &["End Mill - Up-cut 12mm 2F".to_string()], &lib);

        assert!(!r.is_runnable(), "a job with an uncuttable hole was called runnable");
        assert!(r.path.moves.is_empty(), "an uncuttable job produced a program to post");
        let said = r.refusals.iter().map(|x| format!("{} :: {}", x.what, x.why)).collect::<Vec<_>>().join("\n");
        assert!(said.contains("hole"), "the refusal does not name the feature: {said}");
        assert!(
            said.contains("NO TOOL IN THIS LIBRARY CAN CUT THIS HOLE"),
            "the refusal does not say what is wrong: {said}"
        );
        assert!(
            said.contains("12mm"),
            "the refusal does not name the tool that was refused: {said}"
        );
    }

    #[test]
    fn a_selected_tool_that_does_not_exist_is_said_out_loud() {
        let lib = default_library();
        let mut j = set_job();
        let a = assign_tools_from_set(
            &mut j,
            &["Nonexistent 9mm".to_string(), "Drill - Brad Point 5mm 2F".to_string()],
            &lib,
        );
        assert!(
            a.notes.iter().any(|n| n.contains("Nonexistent 9mm") && n.contains("not in the library")),
            "{:?}",
            a.notes
        );
    }

    #[test]
    fn the_singular_tool_path_is_byte_for_byte_what_it_was() {
        // 🔴 THE REGRESSION. `JobConfig::tool_id` leaves every operation on one
        // tool; that job must plan and post exactly as before, and applying no
        // set must be indistinguishable from never having called the new code.
        let lib = default_library();
        let mut base = set_job();
        let one = lib.iter().find(|t| t.id == "End Mill - Down-cut 6mm 2F").unwrap();
        for op in &mut base.operations {
            op.tool = one.tool.clone(); // exactly what `tool_id` does today
        }

        let before = plan_job(&base);
        let gcode_before = post_grblhal(
            &before.path,
            &base.machine,
            &base.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        )
        .gcode;

        let mut after_job = base.clone();
        let mut notes = Vec::new();
        apply_tool_set(&mut after_job, None, &lib, &mut notes);
        apply_tool_set(&mut after_job, Some(&[]), &lib, &mut notes);
        assert!(notes.is_empty(), "applying no set said something: {notes:?}");
        assert!(after_job.tool_set_refusals.is_empty());

        let after = plan_job(&after_job);
        let gcode_after = post_grblhal(
            &after.path,
            &after_job.machine,
            &after_job.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        )
        .gcode;

        assert_eq!(gcode_before, gcode_after, "the singular tool path changed");
        assert_eq!(before.summary.tools_used, after.summary.tools_used);
        assert_eq!(before.summary.tools_used.len(), 1, "one tool_id produced more than one tool");
        assert_eq!(before.summary.tool_changes, 0);
        assert_eq!(before.notes.len(), after.notes.len());
    }

    #[test]
    fn an_engraving_keeps_the_tool_it_was_given() {
        // Refuse rather than approximate: there is no engraving feature kind, so
        // this recommender has no answer for a V-carve and does not invent one.
        let lib = default_library();
        let mut j = set_job();
        j.operations.push(Operation {
            name: "mark".into(),
            part: "mark".into(),
            role: crate::toolpath::OpRole::Interior,
            contour: Contour::rect(150.0, 150.0, 20.0, 20.0),
            tool: tool6(),
            params: OperationParams {
                side: CutSide::OnLine,
                op_type: OpType::Engrave,
                depth_total_mm: 1.0,
                ..OperationParams::default()
            },
        });
        let set = vec![
            "End Mill - Down-cut 6mm 2F".to_string(),
            "Drill - Brad Point 5mm 2F".to_string(),
        ];
        let a = assign_tools_from_set(&mut j, &set, &lib);
        assert_eq!(j.operations[2].tool.name, "6mm", "the engraving was reassigned");
        assert!(
            a.notes.iter().any(|n| n.contains("mark") && n.contains("included angle")),
            "{:?}",
            a.notes
        );
    }
}

#[cfg(test)]
mod drawing_offset_tests {
    //! Dragging the part on the workpiece — and the four ways that can be a lie.
    //!
    //! 🔴 EVERY ASSERTION HERE IS ON THE EMITTED PROGRAM OR ON A VERDICT, never
    //! on `Job::drawing_offset_x_mm`. This lane has shipped the same defect four
    //! times — `EntryMode::Ramp` with a full-depth plunge in the program, P4's
    //! dogbone counts, P3's `pocketFloorZ` helper, a `JobSummary` walked off
    //! `path.moves` — and every one of them was a control reading the intent
    //! back out of the setting that produced it.

    use super::*;
    use crate::geometry::Contour;
    use crate::post_grblhal::{post_grblhal, PostOptions};

    fn tool6() -> Tool {
        Tool { name: "6mm".into(), diameter_mm: 6.0, shank_mm: 6.0, flutes: 2, chipload_mm: 0.1, ..Tool::default() }
    }

    fn job_at(dx: f64, dy: f64) -> Job {
        let mut j = Job::new(
            "drag",
            Machine { collet_mm: 6.0, travel_x_mm: 2000.0, travel_y_mm: 2000.0, ..Machine::default() },
            Stock::default(),
        );
        j.operations.push(Operation {
            name: "profile".into(),
            part: "profile".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(50.0, 50.0, 120.0, 80.0),
            tool: tool6(),
            params: OperationParams { depth_total_mm: 18.0, ..OperationParams::default() },
        });
        j.drawing_offset_x_mm = dx;
        j.drawing_offset_y_mm = dy;
        j
    }

    /// Every X/Y word the post actually wrote, as `(x, y)` pairs.
    fn coords(job: &Job) -> Vec<(f64, f64)> {
        let r = plan_job(job);
        let g = post_grblhal(
            &r.path,
            &job.machine,
            &job.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        );
        let mut out = Vec::new();
        let (mut x, mut y) = (f64::NAN, f64::NAN);
        for line in g.gcode.lines() {
            let mut moved = false;
            for w in line.split_whitespace() {
                // G-code is MODAL: a block writes a word only when it changes,
                // so the pair has to be tracked rather than read per line. A
                // test that only collected lines carrying both words would
                // silently skip most of the program.
                if let Some(v) = w.strip_prefix('X').and_then(|v| v.parse::<f64>().ok()) {
                    x = v;
                    moved = true;
                }
                if let Some(v) = w.strip_prefix('Y').and_then(|v| v.parse::<f64>().ok()) {
                    y = v;
                    moved = true;
                }
            }
            if moved && x.is_finite() && y.is_finite() {
                out.push((x, y));
            }
        }
        assert!(!out.is_empty(), "the post emitted no positioned move to measure");
        out
    }

    #[test]
    fn the_offset_moves_every_coordinate_in_the_emitted_program_by_exactly_that_much() {
        // 🔴 THE WHOLE FEATURE. A drag that moves the picture and not the
        // program is the founder's complaint with the sign flipped: he could
        // not move the object at all, and the failure one step past that is an
        // object that moves on screen while the machine cuts where it was.
        let home = coords(&job_at(0.0, 0.0));
        let moved = coords(&job_at(50.0, 25.0));
        assert_eq!(home.len(), moved.len(), "the offset changed the SHAPE of the program");
        for (i, ((hx, hy), (mx, my))) in home.iter().zip(&moved).enumerate() {
            assert!(
                (mx - hx - 50.0).abs() < 1e-6 && (my - hy - 25.0).abs() < 1e-6,
                "move {i}: ({hx},{hy}) -> ({mx},{my}), which is not +50,+25"
            );
        }
    }

    #[test]
    fn an_offset_of_zero_changes_not_one_byte() {
        // The negative control for the test above. Without it, an
        // implementation that displaced every program by a constant would pass
        // the difference assertion and cut every job in the wrong place.
        assert_eq!(coords(&job_at(0.0, 0.0)), coords(&job_at(0.0, 0.0)));
        let home = job_at(0.0, 0.0);
        let a = plan_job(&home);
        let g = |j: &Job, r: &JobResult| {
            post_grblhal(&r.path, &j.machine, &j.stock, &OperationParams::default(), &PostOptions::default())
                .gcode
        };
        assert_eq!(g(&home, &a), g(&home, &plan_job(&home)));
    }

    #[test]
    fn the_drag_is_measured_on_the_sheet_and_turns_with_it() {
        // 🔴 THE COMPOSITION ORDER, asserted at the controller's coordinates.
        // The offset is added BEFORE the workpiece's rotation, so a part dragged
        // 50mm along the workpiece stays 50mm along it when the workpiece is
        // turned — it does not slide across the material it is cut from.
        // Applied AFTER the rotation it would be a machine-axis nudge, and the
        // same drag would land somewhere different on the plywood.
        let mut a = job_at(0.0, 0.0);
        a.stock.rotation_deg = 90.0;
        let mut b = job_at(50.0, 0.0);
        b.stock.rotation_deg = 90.0;
        let home = coords(&a);
        let moved = coords(&b);
        for ((hx, hy), (mx, my)) in home.iter().zip(&moved) {
            // A quarter turn anticlockwise sends the workpiece's +X into the
            // machine's +Y. Exact, because `Stock::sin_cos` is exact on the
            // quarter turns on purpose.
            assert!(
                (mx - hx).abs() < 1e-6 && (my - hy - 50.0).abs() < 1e-6,
                "a 50mm drag along the WORKPIECE's X landed as ({}, {}) in machine coordinates",
                mx - hx,
                my - hy
            );
        }
    }

    #[test]
    fn placement_is_the_transform_place_applies() {
        // `Job::placement` exists so a host can DRAW in the frame the program
        // is cut in without writing the rule a second time. It is only worth
        // anything while it agrees with `place` at every point, which is what
        // this pins — including at a free angle, where the exact-quarter-turn
        // shortcut in `sin_cos` does not apply.
        for deg in [0.0, 90.0, 180.0, 270.0, 37.0] {
            for (ox, oy) in [(0.0, 0.0), (50.0, 25.0), (-12.5, 300.0)] {
                let mut j = job_at(ox, oy);
                j.stock.rotation_deg = deg;
                let p = j.placement();
                for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (123.5, -7.25), (600.0, 900.0)] {
                    let (px, py) = j.place(x, y);
                    let tx = p.cos * x + p.row_y[0] * y + p.dx_mm;
                    let ty = p.sin * x + p.row_y[1] * y + p.dy_mm;
                    assert!(
                        (px - tx).abs() < 1e-9 && (py - ty).abs() < 1e-9,
                        "at {deg} deg offset {ox},{oy}: place({x},{y}) = ({px},{py}) but the \
                         reported transform gives ({tx},{ty})"
                    );
                }
                assert_eq!(p.drawing_offset_mm, [ox, oy]);
                assert_eq!(
                    p.is_identity(),
                    deg == 0.0 && ox == 0.0 && oy == 0.0,
                    "is_identity disagreed with the transform at {deg} deg, offset {ox},{oy}"
                );
            }
        }
    }

    #[test]
    fn the_plant_leaves_the_setting_visible_and_the_program_where_it_was() {
        // The negative control for the gate: with the plant on, the offset is
        // still stored and still reported, and the emitted coordinates are
        // exactly the unmoved ones. That is the defect restored — a setting
        // that reads as applied and moves nothing.
        let mut planted = job_at(50.0, 25.0);
        planted.plant_ignores_drawing_offset = true;
        assert_eq!(coords(&planted), coords(&job_at(0.0, 0.0)));
        // ...and the field the panel would render is untouched, which is
        // exactly why a control that read it would be green.
        assert_eq!(planted.drawing_offset_x_mm, 50.0);
        // What the report carries is what was APPLIED, not what was typed.
        assert_eq!(planted.placement().drawing_offset_mm, [0.0, 0.0]);
    }

    #[test]
    fn a_part_dragged_past_the_sheet_says_the_simulation_did_not_cover_it() {
        // 🔴 The silent-green this feature would otherwise create. The height
        // map is built over the WORKPIECE, and `sim::check` walks map cells — so
        // geometry dragged past the edge is not judged clean, it is not judged.
        // Zero findings and zero findings look identical in a report.
        let clean = plan_job(&job_at(0.0, 0.0));
        assert!(
            !clean.notes.iter().any(|n| n.contains("PAST THE EDGE")),
            "a part sitting on the workpiece was reported as off it: {:?}",
            clean.notes
        );
        let off = plan_job(&job_at(700.0, 0.0));
        assert!(
            off.notes.iter().any(|n| n.contains("PAST THE EDGE") && n.contains("checked against the spoilboard")),
            "a part dragged 700mm along a 600mm workpiece was not reported as past-the-edge: {:?}",
            off.notes
        );
    }
}

#[cfg(test)]
mod workpiece_edge_tests {
    //! **An edge that lies on the workpiece edge does not have to be cut.**
    //!
    //! 🔴 EVERY ASSERTION HERE IS ON THE EMITTED PROGRAM — the posted G-code,
    //! not the plan and never `Job::use_workpiece_edge`. The whole feature is
    //! *"this material is not removed"*, and the only artefact that settles
    //! whether material is removed is the file the controller runs. This lane
    //! has shipped the other kind of check four times.
    //!
    //! The plants that were watched go RED, on this code, before it was
    //! believed:
    //!
    //! | Plant | What went red |
    //! |---|---|
    //! | tolerance widened so a 0.2mm near miss is skipped | `a_near_miss_leaves_the_cut_in_the_program` |
    //! | decision moved to the unplaced contour (i.e. taken at import) | `dragging_the_drawing_after_the_edge_was_flush_puts_the_cut_back` |
    //! | the per-edge program comments removed | `the_skipped_edge_is_named_in_the_program_it_is_missing_from` |

    use super::*;
    use crate::fixture::{Clamp, Fixturing};
    use crate::geometry::Contour;
    use crate::post_grblhal::{post_grblhal, PostOptions};

    fn tool6() -> Tool {
        Tool {
            name: "6mm".into(),
            diameter_mm: 6.0,
            shank_mm: 6.0,
            flutes: 2,
            chipload_mm: 0.1,
            ..Tool::default()
        }
    }

    /// A 200x120 part drawn hard into the corner of a 600x900 workpiece: its
    /// y-min and x-min edges ARE the workpiece's, and its other two are 397mm
    /// and 780mm inside. Two edges that must go and two that must not, so a
    /// change that skipped everything and a change that skipped nothing both
    /// fail.
    fn job_flush_in_the_corner() -> Job {
        let mut j = Job::new(
            "flush",
            Machine {
                collet_mm: 6.0,
                travel_x_mm: 2000.0,
                travel_y_mm: 2000.0,
                ..Machine::default()
            },
            Stock::default(),
        );
        j.operations.push(Operation {
            name: "plate".into(),
            part: "plate".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(0.0, 0.0, 200.0, 120.0),
            tool: tool6(),
            params: OperationParams { depth_total_mm: 18.0, ..OperationParams::default() },
        });
        j
    }

    /// The rule on, at a declared tolerance — **and `EntryMode::Plunge`,
    /// because the core refuses a ramp on an open path and says so.**
    ///
    /// ⚠ That is not a convenience for the tests. An operator turning this
    /// option on meets the same refusal and makes the same choice, and the
    /// refusal is exercised on its own in
    /// `a_ramp_entry_on_an_open_profile_is_refused_rather_than_cut_across_the_part`.
    fn with_rule(mut j: Job, tolerance_mm: f64) -> Job {
        j.use_workpiece_edge = true;
        j.workpiece_edge_tolerance_mm = tolerance_mm;
        for o in &mut j.operations {
            o.params.entry = EntryMode::Plunge;
        }
        j
    }

    struct Emitted {
        gcode: String,
        res: JobResult,
    }

    fn emit(job: &Job) -> Emitted {
        let res = plan_job(job);
        let gcode = post_grblhal(
            &res.path,
            &job.machine,
            &job.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        )
        .gcode;
        Emitted { gcode, res }
    }

    /// Every XY position the emitted program actually commands.
    ///
    /// G-code is MODAL — a block writes a word only when it changes — so the
    /// pair is tracked across lines. A reader that only took lines carrying both
    /// words would skip most of the program and could not tell a missing edge
    /// from a missing word.
    fn positions(gcode: &str) -> Vec<(f64, f64)> {
        let mut out = Vec::new();
        let (mut x, mut y) = (f64::NAN, f64::NAN);
        for line in gcode.lines() {
            let code = match line.find('(') {
                Some(i) => &line[..i],
                None => line,
            };
            let mut moved = false;
            for w in code.split_whitespace() {
                if let Some(v) = w.strip_prefix('X').and_then(|v| v.parse::<f64>().ok()) {
                    x = v;
                    moved = true;
                }
                if let Some(v) = w.strip_prefix('Y').and_then(|v| v.parse::<f64>().ok()) {
                    y = v;
                    moved = true;
                }
            }
            if moved && x.is_finite() && y.is_finite() {
                out.push((x, y));
            }
        }
        out
    }

    fn notes_containing<'a>(res: &'a JobResult, needle: &str) -> Vec<&'a String> {
        res.notes.iter().filter(|n| n.contains(needle)).collect()
    }

    /// The PER-EDGE lines only.
    ///
    /// ⚠ Not `contains("is NOT cut")`: the job-level line that says what the
    /// option costs used to contain that phrase too, so the count came back one
    /// too high on every job and a test asserting "none skipped" passed on a
    /// job where the option had merely spoken. The needle is the shape only a
    /// per-edge line has.
    fn skipped_edge_lines<'a>(res: &'a JobResult) -> Vec<&'a String> {
        notes_containing(res, "lies on the workpiece's")
    }

    // -----------------------------------------------------------------------
    //  The cut is gone from the file
    // -----------------------------------------------------------------------

    #[test]
    fn the_skipped_edge_is_absent_from_the_emitted_program_and_the_other_edges_are_not() {
        // 🔴 THE POSITIVE CONTROL FIRST. With the option off this program runs
        // the cutter centre one radius PAST the workpiece on both flush sides —
        // X-3 and Y-3 — which is the pass this feature exists to remove. If that
        // is not there, the absence below proves nothing.
        let off = emit(&job_flush_in_the_corner());
        let p_off = positions(&off.gcode);
        assert!(
            p_off.iter().any(|(x, _)| *x <= -3.0 + 1e-6),
            "the option is OFF and nothing reaches X-3: this drawing does not exercise the \
             feature at all"
        );
        assert!(p_off.iter().any(|(_, y)| *y <= -3.0 + 1e-6), "nothing reaches Y-3 with it off");

        let on = emit(&with_rule(job_flush_in_the_corner(), 0.1));
        assert!(on.res.refusals.is_empty(), "{:?}", on.res.refusals);
        let p_on = positions(&on.gcode);
        assert!(!p_on.is_empty(), "the option ON emitted no motion at all");

        // 🔴 The whole claim: nothing in the FILE goes past the workpiece on
        // either flush side any more.
        let past: Vec<(f64, f64)> =
            p_on.iter().copied().filter(|(x, y)| *x < -1e-6 || *y < -1e-6).collect();
        assert!(
            past.is_empty(),
            "{} emitted position(s) still run past the workpiece edge the option was told to \
             use: {:?}",
            past.len(),
            &past[..past.len().min(6)]
        );

        // ...and the two edges that are NOT on the workpiece are still cut, at
        // the same tool-centre coordinates as before. A feature that removed the
        // whole profile would pass every assertion above.
        assert!(
            p_on.iter().any(|(x, _)| (*x - 203.0).abs() < 1e-6),
            "the x-max wall is no longer cut at X203: {:?}",
            &p_on[..p_on.len().min(8)]
        );
        assert!(p_on.iter().any(|(_, y)| (*y - 123.0).abs() < 1e-6), "the y-max wall is gone");

        // The program got SHORTER, and by cutting rather than by refusing.
        assert!(
            on.gcode.lines().count() < off.gcode.lines().count(),
            "skipping two of four edges did not shorten the program: {} lines against {}",
            on.gcode.lines().count(),
            off.gcode.lines().count()
        );
    }

    #[test]
    fn the_skipped_edge_is_named_in_the_program_it_is_missing_from() {
        // 🔴 An edge silently not cut is uncut material that LOOKS intended, and
        // the `uncut` counter cannot see it: that fires only on a region
        // declared as must-be-cleared, and nobody declared this one. So the
        // program says so itself — whoever stands at the machine reads the file,
        // and a fact that lives only in a panel they closed an hour ago did not
        // reach them.
        let on = emit(&with_rule(job_flush_in_the_corner(), 0.1));
        let comments: Vec<&str> =
            on.gcode.lines().filter(|l| l.contains("workpiece edge:")).collect();
        assert!(
            comments.iter().any(|c| c.contains("2 of 4 outline edges cut, 2 skipped")),
            "the program does not say how many edges it cut: {comments:?}"
        );
        assert!(
            comments.iter().any(|c| c.contains("0.100mm")),
            "the tolerance that decided it is not in the program: {comments:?}"
        );
        // PER EDGE, named, with the side of the workpiece and the coordinates.
        for want in ["y-min", "x-min"] {
            assert!(
                comments.iter().any(|c| c.contains(want) && c.contains("is NOT cut")),
                "no per-edge line for the {want} edge: {comments:?}"
            );
        }
        assert!(
            comments.iter().any(|c| c.contains("X0.000 Y0.000 to X200.000 Y0.000")),
            "the per-edge line does not say WHERE the edge is: {comments:?}"
        );
        // ⚠ The post rewrites `(` and `)` to `_`, so a message written with
        // bracketed coordinates reaches the operator mangled. Assert the shape
        // that survives, not the shape that was typed.
        assert!(
            !comments.iter().any(|c| c.contains('_')),
            "a comment came through the post's paren sanitiser mangled: {comments:?}"
        );

        // ...and the same facts are in the REPORT, per edge, for a host that
        // renders notes rather than G-code.
        assert_eq!(
            skipped_edge_lines(&on.res).len(),
            2,
            "the report does not carry one line per skipped edge: {:?}",
            on.res.notes
        );
        assert!(
            !notes_containing(&on.res, "'use the workpiece edge' is ON").is_empty(),
            "the report never says the option is on, or what it costs: {:?}",
            on.res.notes
        );
        assert!(
            notes_containing(&on.res, "supplier's tolerance")
                .iter()
                .any(|n| n.contains("wherever the workpiece actually is")),
            "the report does not state what the operator is accepting: {:?}",
            on.res.notes
        );

        // Negative control: with the option off the program says none of it.
        let off = emit(&job_flush_in_the_corner());
        assert!(
            !off.gcode.contains("workpiece edge:"),
            "the option is OFF and the program is talking about it"
        );
        assert!(notes_containing(&off.res, "'use the workpiece edge'").is_empty());
    }

    #[test]
    fn no_cutting_move_crosses_the_part_once_the_profile_is_open() {
        // 🔴 **THE ASSERTION THAT WAS MISSING WHEN THIS FEATURE FIRST PASSED ITS
        // OWN TESTS.** Every check above was green while the emitted program
        // carried this, at full depth, on the ramped default:
        //
        //     G1 X0.000            <- ramp lap ends at the far end, Z-18.000
        //     G1 X203.000 Y2.000   <- finishing lap restarts, STILL Z-18.000
        //
        // A 234mm chord straight through the finished part — and it broke none
        // of the earlier assertions, because it never leaves the workpiece and
        // never touches a skipped edge. The property that catches it is the one
        // that defines an OUTSIDE profile: the tool centre is never inside the
        // outline.
        //
        // The ramped case is now refused by name; this holds the plunged case
        // that is allowed, and it holds it for the multi-path shape too.
        for (name, outline) in [
            ("corner", Contour::rect(0.0, 0.0, 200.0, 120.0)),
            ("full-height", Contour::rect(50.0, 0.0, 200.0, 900.0)),
        ] {
            let mut j = with_rule(job_flush_in_the_corner(), 0.1);
            j.operations[0].contour = outline.clone();
            let e = emit(&j);
            assert!(e.res.refusals.is_empty(), "{name}: {:?}", e.res.refusals);
            let (x0, y0, x1, y1) = outline.bounds().expect("the outline has bounds");
            for (x, y) in positions(&e.gcode) {
                assert!(
                    !(x > x0 + 1e-6 && x < x1 - 1e-6 && y > y0 + 1e-6 && y < y1 - 1e-6),
                    "{name}: an emitted position X{x:.3} Y{y:.3} is INSIDE the outline \
                     X{x0:.3}..{x1:.3} Y{y0:.3}..{y1:.3} — on an outside profile the tool centre \
                     never enters the part"
                );
            }
        }
    }

    #[test]
    fn a_ramp_entry_on_an_open_profile_is_refused_rather_than_cut_across_the_part() {
        // The refusal, on its own, with the two ways out named. A ramp is the
        // DEFAULT entry mode, so this is the first thing an operator meets when
        // they turn the option on — which is why the sentence has to carry the
        // fix and not just the complaint.
        let mut j = job_flush_in_the_corner();
        j.use_workpiece_edge = true;
        j.workpiece_edge_tolerance_mm = 0.1;
        assert_eq!(
            j.operations[0].params.entry,
            EntryMode::Ramp,
            "the default entry mode is no longer Ramp, so this test is not about the default"
        );
        let r = plan_job(&j);
        assert_eq!(r.refusals.len(), 1, "{:?}", r.refusals);
        assert!(r.refusals[0].why.contains("OPEN path with two ends"), "{}", r.refusals[0].why);
        assert!(
            r.refusals[0].why.contains("Use Plunge entry"),
            "the refusal does not say what to do instead: {}",
            r.refusals[0].why
        );
        assert!(!r.is_runnable(), "a refused job was runnable");

        // ⚠ Both negative controls. A ramp is fine when NO edge is skipped —
        // otherwise this refusal would fire on every job the moment the option
        // was switched on — and a plunge is fine when one is.
        let mut clear = j.clone();
        clear.operations[0].contour = Contour::rect(40.0, 40.0, 200.0, 120.0);
        assert!(
            plan_job(&clear).refusals.is_empty(),
            "a ramped profile with no edge on the workpiece edge was refused"
        );
        assert!(plan_job(&with_rule(job_flush_in_the_corner(), 0.1)).refusals.is_empty());
    }

    // -----------------------------------------------------------------------
    //  🔴 The decision is taken AFTER placement
    // -----------------------------------------------------------------------

    #[test]
    fn dragging_the_drawing_after_the_edge_was_flush_puts_the_cut_back() {
        // 🔴 THE FAILURE THIS GUARDS: an edge flush at import and interior after
        // a drag, left uncut. That is an unmachined interior edge, and an
        // unmachined interior edge looks like a finished part until it is
        // measured.
        //
        // A decision taken at import answers the same way for both jobs below.
        let flush = emit(&with_rule(job_flush_in_the_corner(), 0.1));
        assert_eq!(
            skipped_edge_lines(&flush.res).len(),
            2,
            "{:?}",
            flush.res.notes
        );

        let mut dragged = with_rule(job_flush_in_the_corner(), 0.1);
        dragged.drawing_offset_y_mm = 30.0;
        let dragged = emit(&dragged);
        assert!(dragged.res.refusals.is_empty(), "{:?}", dragged.res.refusals);

        // One edge, not two: the y-min edge is now 30mm inside the workpiece and
        // is cut like any other; the x-min edge did not move and is still the
        // workpiece's.
        let named = skipped_edge_lines(&dragged.res);
        assert_eq!(
            named.len(),
            1,
            "dragging the part 30mm off the workpiece edge did not put its cut back — the \
             decision is being taken somewhere the drag cannot reach: {:?}",
            dragged.res.notes
        );
        assert!(named[0].contains("x-min"), "the wrong edge survived: {}", named[0]);

        // 🔴 And in the FILE: the dragged edge is cut again, one radius below the
        // outline at Y27.
        let p = positions(&dragged.gcode);
        assert!(
            p.iter().any(|(_, y)| (*y - 27.0).abs() < 1e-6),
            "the dragged edge is not cut in the emitted program: no move at Y27"
        );
        assert!(
            !p.iter().any(|(x, _)| *x < -1e-6),
            "the edge that did NOT move lost its skip when the other one moved"
        );

        // The other direction, which is the one an operator does on purpose: a
        // part drawn 30mm clear and then dragged ONTO the workpiece edge.
        let mut clear = with_rule(job_flush_in_the_corner(), 0.1);
        clear.operations[0].contour = Contour::rect(0.0, 30.0, 200.0, 120.0);
        let stayed = emit(&clear);
        assert_eq!(
            skipped_edge_lines(&stayed.res).len(),
            1,
            "a part drawn 30mm off the y-min edge lost that edge anyway: {:?}",
            stayed.res.notes
        );
        clear.drawing_offset_y_mm = -30.0;
        let moved_on = emit(&clear);
        assert_eq!(
            skipped_edge_lines(&moved_on.res).len(),
            2,
            "dragging a part ONTO the workpiece edge did not make that edge the workpiece's: {:?}",
            moved_on.res.notes
        );
    }

    #[test]
    fn a_near_miss_leaves_the_cut_in_the_program() {
        // 🔴 The ribbon. An outline 0.2mm inside the workpiece, skipped, leaves
        // 0.2mm of material holding the part — worse than either cutting it or
        // leaving it properly. At a declared 0.1mm it is CUT, and the proof is
        // that the pass is still in the file.
        let mut near = with_rule(job_flush_in_the_corner(), 0.1);
        near.operations[0].contour = Contour::rect(0.2, 0.2, 200.0, 120.0);
        let e = emit(&near);
        assert!(e.res.refusals.is_empty(), "{:?}", e.res.refusals);
        assert!(
            skipped_edge_lines(&e.res).is_empty(),
            "an outline 0.2mm inside the workpiece was skipped at a declared 0.1mm tolerance: {:?}",
            e.res.notes
        );
        let p = positions(&e.gcode);
        assert!(
            p.iter().any(|(_, y)| (*y + 2.8).abs() < 1e-6),
            "the near-miss edge is not cut in the emitted program: nothing at Y-2.8"
        );

        // ...and the operator can declare their way past it, knowingly. Same
        // geometry, 0.3mm: both edges go, and the report says how far inside
        // each of them actually was.
        let mut wide = near.clone();
        wide.workpiece_edge_tolerance_mm = 0.3;
        let w = emit(&wide);
        assert_eq!(skipped_edge_lines(&w.res).len(), 2, "{:?}", w.res.notes);
        assert!(
            notes_containing(&w.res, "0.200mm inside it").len() == 2,
            "the report does not say how deep the near miss was: {:?}",
            w.res.notes
        );
    }

    // -----------------------------------------------------------------------
    //  ✅ The restraint gain, verified rather than assumed
    // -----------------------------------------------------------------------

    /// Two bars bolted well clear of the part, bearing on the workpiece.
    fn bars() -> Fixturing {
        Fixturing {
            clamps: vec![
                Clamp::new("bar-left", 300.0, 100.0, 60.0, 400.0, 20.0),
                Clamp::new("bar-right", 450.0, 100.0, 60.0, 400.0, 20.0),
            ],
            confirmed_clear: true,
        }
    }

    fn tab_lifts(gcode: &str) -> usize {
        // A tab is a CUTTING move that rises back toward the surface. Read off
        // the file, because a tab that was planned and machined away by a later
        // lap is exactly the defect the tab code carries a comment about.
        let mut z = f64::NAN;
        let mut lifts = 0;
        for line in gcode.lines() {
            let code = match line.find('(') {
                Some(i) => &line[..i],
                None => line,
            };
            if !(code.starts_with("G1") || code.starts_with("G2") || code.starts_with("G3")) {
                continue;
            }
            if let Some(v) = code
                .split_whitespace()
                .find_map(|w| w.strip_prefix('Z').and_then(|v| v.parse::<f64>().ok()))
            {
                if z.is_finite() && v > z + 1e-6 && v < -1e-9 {
                    lifts += 1;
                }
                z = v;
            }
        }
        lifts
    }

    #[test]
    fn a_skipped_edge_does_not_hold_the_part_and_the_tabs_are_still_needed() {
        // 🔴 **THE PLAUSIBLE CLAIM THIS TEST EXISTS TO REFUTE**, and it was
        // believed before it was measured: *"a skipped edge leaves the part
        // joined to the stock there, so it needs no tab — and the part is better
        // held than the tabbed version."*
        //
        // It is false, and false in the direction that throws a part. A skipped
        // edge lies on the workpiece's OUTER BOUNDARY. There is no stock on the
        // far side of it to hold anything, so cutting the outline's remaining
        // edges separates the part exactly as a full profile would — with the
        // tabs gone.
        //
        // The measurement, made by the check that owns the question, on the
        // EMITTED PROGRAM.
        let mut untabbed = with_rule(job_flush_in_the_corner(), 0.1);
        untabbed.fixturing = bars();
        untabbed.operations[0].params.tabs.enabled = false;
        let loose = emit(&untabbed);
        let freed = notes_containing(&loose.res, "hold-down:")
            .into_iter()
            .filter(|n| n.contains("is free after"))
            .count();
        assert!(
            freed > 0,
            "a part with two edges skipped and no tabs was NOT reported as coming free, so \
             either the check did not run or this drawing does not exercise it: {:?}",
            loose.res.notes
        );
        assert!(
            notes_containing(&loose.res, "hold-down PENDING").is_empty(),
            "the hold-down check did not run, so the finding above is not a measurement: {:?}",
            loose.res.notes
        );

        // ...and with tabs left ON — which is the default, and the state an
        // operator who has not thought about it is in — the tabs are IN THE
        // FILE and the part is held.
        let mut j = with_rule(job_flush_in_the_corner(), 0.1);
        j.fixturing = bars();
        assert!(j.operations[0].params.tabs.enabled, "the default is tabs on; this test needs it");
        let on = emit(&j);
        assert!(on.res.refusals.is_empty(), "{:?}", on.res.refusals);
        assert!(
            tab_lifts(&on.gcode) > 0,
            "an open profile emitted NO tabs: the part is separated by the edges that ARE cut \
             and nothing holds it — this is the defect the 'it needs no tab' argument would have \
             shipped"
        );
        let still_free = notes_containing(&on.res, "hold-down:")
            .into_iter()
            .filter(|n| n.contains("is free after"))
            .count();
        assert_eq!(
            still_free, 0,
            "the tabs on the open profile do not hold the part: {:?}",
            on.res.notes
        );

        // ⚠ Positive control on the READER, so the zero above is a measurement
        // and not a reader that counts nothing: the same job with the option off
        // and tabs on shows tabs too.
        let mut tabbed = job_flush_in_the_corner();
        tabbed.fixturing = bars();
        assert!(
            tab_lifts(&emit(&tabbed).gcode) > 0,
            "the tab reader found no tabs on an ordinary tabbed job, so its answers mean nothing"
        );
    }

    // -----------------------------------------------------------------------
    //  The option's own edges
    // -----------------------------------------------------------------------

    #[test]
    fn a_tolerance_that_is_not_a_distance_is_refused_rather_than_quietly_skipping_nothing() {
        // NaN compares false against every test, so a NaN tolerance would skip
        // NOTHING while the panel read "on" — a control switched on and consumed
        // by nowhere, which is the defect this lane has shipped four times.
        for bad in [f64::NAN, -0.5, f64::INFINITY] {
            let j = with_rule(job_flush_in_the_corner(), bad);
            let r = plan_job(&j);
            assert_eq!(r.refusals.len(), 1, "tolerance {bad} was accepted: {:?}", r.notes);
            assert!(r.refusals[0].why.contains("not a distance"), "{}", r.refusals[0].why);
            assert!(!r.is_runnable());
            assert!(r.path.is_empty(), "a refused job planned a path");
        }
        // Zero is a DECLARATION, not an error: it means "only an exact match",
        // and the report still says the option ran and skipped nothing.
        let z = plan_job(&with_rule(job_flush_in_the_corner(), 0.0));
        assert!(z.refusals.is_empty(), "{:?}", z.refusals);
        assert!(
            z.notes.iter().any(|n| n.contains("2 of 4 outline edges cut")),
            "a zero tolerance still matched the flush edges, or said nothing: {:?}",
            z.notes
        );
    }

    #[test]
    fn a_whole_outline_on_the_workpiece_edge_is_refused_and_emits_no_program() {
        let mut j = with_rule(job_flush_in_the_corner(), 0.1);
        j.stock = Stock { size_x_mm: 200.0, size_y_mm: 120.0, ..Stock::default() };
        let r = plan_job(&j);
        assert_eq!(r.refusals.len(), 1, "{:?}", r.refusals);
        assert!(r.refusals[0].why.contains("all 4 edges"), "{}", r.refusals[0].why);
        assert!(!r.is_runnable(), "a part that is never separated was runnable");
    }

    #[test]
    fn an_open_profile_takes_no_lead_and_says_which_lead_it_did_not_take() {
        // The inside-cut precedent, one case across: a lead exists to put the
        // witness mark in the waste, and at an END of an open path the geometry
        // that proves the arc clears the wall is not written. So it is skipped
        // and SAID — a lead silently not applied is a finish nobody can explain.
        let mut j = with_rule(job_flush_in_the_corner(), 0.1);
        j.operations[0].params.lead_mm = 4.0;
        let e = emit(&j);
        let said = notes_containing(&e.res, "lead was NOT applied");
        assert_eq!(said.len(), 1, "the lead was skipped silently: {:?}", e.res.notes);
        assert!(said[0].contains("open path with two ends"), "{}", said[0]);

        // Positive control: the same lead on the same drawing with the option
        // off IS applied, so the note above is about this feature and not about
        // leads being broken.
        let mut plain = job_flush_in_the_corner();
        plain.operations[0].params.lead_mm = 4.0;
        let p = emit(&plain);
        assert!(
            notes_containing(&p.res, "lead was NOT applied").is_empty(),
            "the lead is refused with the option OFF too: {:?}",
            p.res.notes
        );
    }

    #[test]
    fn two_opposite_edges_on_the_workpiece_leave_two_paths_each_entered_on_its_own() {
        // A part as tall as the workpiece: y-min and y-max are both the
        // workpiece's, and what is left is two separate walls.
        let mut j = with_rule(job_flush_in_the_corner(), 0.1);
        j.operations[0].contour = Contour::rect(50.0, 0.0, 200.0, 900.0);
        let e = emit(&j);
        assert!(e.res.refusals.is_empty(), "{:?}", e.res.refusals);
        assert_eq!(skipped_edge_lines(&e.res).len(), 2, "{:?}", e.res.notes);
        assert!(
            e.res.notes.iter().any(|n| n.contains("separate open path")),
            "several open paths were reported as a pinched shape, or not at all: {:?}",
            e.res.notes
        );

        // 🔴 Each path is ENTERED AND RETRACTED ON ITS OWN, and the retract
        // happens where the pass ENDED. A `G0` that changes X, Y and Z in one
        // block is executed as one diagonal move, so retracting at the far end
        // of an open path drags the cutter back through the work at rapid feed.
        let mut prev: Option<(f64, f64, f64)> = None;
        let (mut x, mut y, mut z) = (f64::NAN, f64::NAN, f64::NAN);
        for line in e.gcode.lines() {
            let code = match line.find('(') {
                Some(i) => &line[..i],
                None => line,
            };
            let is_rapid = code.starts_with("G0");
            let mut moved = false;
            for w in code.split_whitespace() {
                if let Some(v) = w.strip_prefix('X').and_then(|v| v.parse::<f64>().ok()) {
                    x = v;
                    moved = true;
                }
                if let Some(v) = w.strip_prefix('Y').and_then(|v| v.parse::<f64>().ok()) {
                    y = v;
                    moved = true;
                }
                if let Some(v) = w.strip_prefix('Z').and_then(|v| v.parse::<f64>().ok()) {
                    z = v;
                    moved = true;
                }
            }
            if moved {
                if is_rapid {
                    if let Some((px, py, pz)) = prev {
                        let lateral = (x - px).hypot(y - py);
                        assert!(
                            !(pz < -1e-6 && lateral > 1e-6),
                            "a rapid moves {lateral:.3}mm in XY starting from Z{pz:.3}, below \
                             the surface — the cutter is dragged through the work on the way up"
                        );
                    }
                }
                prev = Some((x, y, z));
            }
        }
    }
}

#[cfg(test)]
mod off_material_tests {
    //! **Is the cutter still over material?** — the question
    //! [`Job::use_workpiece_edge`] does *not* answer, asked on the emitted
    //! program.
    //!
    //! # Why this module exists (cad → 2bee_app, 2026-08-11)
    //!
    //! `cad` measured the first real-corpus evidence against the workpiece-edge
    //! flag: on `2bee_hive_panels_18mm_outer_wcnc.scad`, sheet 2700 x 1200, the
    //! closest placements are **x ~ 8.01 · y ~ 8.43**. No part in our nests is
    //! flush with the stock edge, so the flag — which is off by default — is
    //! unreachable on our own work today, and turning it on would change nothing.
    //!
    //! 🔴 **And that made the more important question visible: nothing asserts
    //! that margin.** `placement::plan_datum_shift`'s `margin_mm` is clearance
    //! from the machine's SOFT LIMITS. `layout` checks part against part, never
    //! part against sheet edge. The ~8mm is where that layout landed. A safety
    //! margin nobody asserts can vanish in one placement edit, and the flag
    //! being `false` by default protects nothing about a placement that is
    //! ALREADY flush — with the flag off, a flush outline is simply planned, and
    //! the cutter runs a tool radius past the stock over whatever is under it.
    //!
    //! ⚠ **What was there before this, and why it was not enough.** One note did
    //! fire — *"the program reaches 3.00mm PAST THE EDGE of the workpiece … it
    //! is unjudged, which is not the same fact as judged clean"*. That is a fact
    //! about a CHECK's coverage. The fact about the machine — no stock under the
    //! cutter, bare spoilboard if a board reaches that XY, frame if it does not —
    //! appears **nowhere in this crate except `sim::SpoilboardCoverage`**, whose
    //! window IS the workpiece footprint (`sim.rs`, "a cutting move that leaves
    //! the workpiece entirely … is not in the map and is not judged here"). The
    //! one message that named the harm belonged to the one check that structurally
    //! cannot see this case.

    use super::*;
    use crate::geometry::Contour;
    use crate::post_grblhal::{post_grblhal, PostOptions};

    fn tool6() -> Tool {
        Tool {
            name: "6mm".into(),
            diameter_mm: 6.0,
            shank_mm: 6.0,
            flutes: 2,
            chipload_mm: 0.1,
            ..Tool::default()
        }
    }

    /// A 200x120 part sitting `margin` mm in from the corner of a 600x900
    /// workpiece, **at a datum of 50,50** so the travel-limit check is not the
    /// thing answering. At datum 0,0 a flush part is also outside the machine's
    /// travel, and the travel refusal would do this check's work by coincidence.
    fn job_inset_by(margin: f64) -> Job {
        let mut j = Job::new(
            "nest",
            Machine {
                collet_mm: 6.0,
                travel_x_mm: 2000.0,
                travel_y_mm: 2000.0,
                ..Machine::default()
            },
            Stock { origin_x_mm: 50.0, origin_y_mm: 50.0, ..Stock::default() },
        );
        j.operations.push(Operation {
            name: "panel".into(),
            part: "panel".into(),
            role: crate::toolpath::OpRole::Releasing,
            contour: Contour::rect(margin, margin, margin + 200.0, margin + 120.0),
            tool: tool6(),
            params: OperationParams { depth_total_mm: 18.0, ..OperationParams::default() },
        });
        j
    }

    fn gcode_of(job: &Job, res: &JobResult) -> String {
        post_grblhal(
            &res.path,
            &job.machine,
            &job.stock,
            &OperationParams::default(),
            &PostOptions::default(),
        )
        .gcode
    }

    fn note_with<'a>(res: &'a JobResult, needle: &str) -> Option<&'a String> {
        res.notes.iter().find(|n| n.contains(needle))
    }

    #[test]
    fn a_part_flush_with_the_sheet_edge_says_the_cutter_is_over_bare_spoilboard() {
        let job = job_inset_by(0.0);
        assert!(!job.use_workpiece_edge, "this is the DEFAULT state, not a configured one");
        let res = plan_job(&job);
        assert!(res.refusals.is_empty(), "{:?}", res.refusals);
        let gcode = gcode_of(&job, &res);

        // 🔴 POSITIVE CONTROL ON THE GEOMETRY FIRST. The workpiece starts at
        // X50 Y50; an outside profile on a flush outline puts the cutter centre
        // a 3mm radius further out, at X47 Y47. If the file does not contain
        // that, the assertions below prove nothing about anything.
        assert!(
            gcode.lines().any(|l| l.contains("X47.000")),
            "the emitted program never leaves the workpiece — this drawing does not exercise it"
        );

        // The harm, named, in the report.
        let strike = note_with(&res, "CUTTING OFF THE MATERIAL")
            .unwrap_or_else(|| panic!("a flush part cut past the sheet said nothing: {:?}", res.notes));
        for needle in [
            "BARE SPOILBOARD",
            "frame",
            "NO CHECK IN THIS CORE ASSERTS ONE",
            "Y47.000",
        ] {
            assert!(strike.contains(needle), "the strike does not say `{needle}`: {strike}");
        }

        // 🔴 ...and in the PROGRAM. Whoever stands at the machine reads the
        // file; a hazard that lives only in a panel is a hazard that did not
        // reach them. Same argument `plan_profile_with_edge_rule` makes for the
        // skipped-edge comments.
        let comment = gcode
            .lines()
            .find(|l| l.contains("off material:"))
            .unwrap_or_else(|| panic!("the program does not carry the strike:\n{gcode}"));
        assert!(comment.contains("Y47.000"), "the program comment does not say where: {comment}");
        // The post rewrites parens to `_`; a mangled comment means the text was
        // written with characters grblHAL's parser cannot nest.
        assert!(!comment.contains('_'), "the comment came through the sanitiser mangled: {comment}");

        // 🔴 GATE G2 CANNOT SEE THIS LINE, so it is checked here. G2 reads the
        // fixtures' programs, and no fixture cuts off the material — so a banned
        // word introduced by THIS comment would ship past the dialect gate
        // unread. The CNC ban that free prose can plausibly trip is the extruder
        // `E` word (`\bE-?\d`); the rest are M- and G-codes. Checked by hand
        // rather than by regex, because this crate has no regex dependency and
        // adding one to assert a sentence would be the wrong trade.
        let bytes: Vec<char> = comment.chars().collect();
        for (i, c) in bytes.iter().enumerate() {
            if *c != 'E' {
                continue;
            }
            let before_is_word = i > 0 && (bytes[i - 1].is_alphanumeric() || bytes[i - 1] == '_');
            let mut j = i + 1;
            if bytes.get(j) == Some(&'-') {
                j += 1;
            }
            let after_is_digit = bytes.get(j).is_some_and(|d| d.is_ascii_digit());
            assert!(
                before_is_word || !after_is_digit,
                "the strike comment contains an extruder E word at char {i}, which gate G2 bans \
                 and cannot see on any fixture: {comment}"
            );
        }

        // The coverage note is still there — now says the area IS checked against
        // the spoilboard, since the height map was extended to cover the toolpath.
        let coverage = note_with(&res, "PAST THE EDGE")
            .unwrap_or_else(|| panic!("the coverage note went missing: {:?}", res.notes));
        assert!(coverage.contains("checked against the spoilboard"));
        assert!(
            coverage.contains("cutting move(s)") && coverage.contains("rapid(s)"),
            "the excursion is still reported as one undifferentiated number: {coverage}"
        );
    }

    #[test]
    fn the_margin_in_our_nests_is_where_the_layout_landed_and_nothing_asserts_it() {
        // 🔴 THE FINDING, PINNED AS A TEST. `cad` measured ~8mm in the real
        // nests. This shows what that 8mm is doing: it is the ONLY thing keeping
        // the cutter on material, and it is a property of the placement, not of
        // any check.
        //
        // The discriminating pair is a tenth of a millimetre wide, and it is the
        // cutter's radius that decides it — not a number anyone declared.
        let quiet = plan_job(&job_inset_by(8.0)); // cad's measured nest
        assert!(
            note_with(&quiet, "CUTTING OFF THE MATERIAL").is_none()
                && note_with(&quiet, "PAST THE EDGE").is_none(),
            "the check fires on a nest that is 8mm clear — it is not specific: {:?}",
            quiet.notes
        );
        // Exactly one radius of clearance: the cutter centre lands ON the
        // boundary. That is on the material, and still silent.
        let exact = plan_job(&job_inset_by(3.0));
        assert!(
            note_with(&exact, "CUTTING OFF THE MATERIAL").is_none(),
            "a cutter centre exactly on the workpiece edge was called off it: {:?}",
            exact.notes
        );
        // 0.1mm less, and the same part, same tool, same sheet is off the
        // material. **Nothing between 8.0 and 2.9 asserted anything** — the only
        // thing that changed is where a human put the part.
        let over = plan_job(&job_inset_by(2.9));
        let strike = note_with(&over, "CUTTING OFF THE MATERIAL").unwrap_or_else(|| {
            panic!("0.1mm of cutter past the sheet edge went unreported: {:?}", over.notes)
        });
        assert!(strike.contains("0.10mm"), "the distance is wrong or unstated: {strike}");
    }

    #[test]
    fn the_workpiece_edge_option_is_the_fix_for_the_flush_case_and_it_is_off() {
        // ⚠ The other half of `cad`'s finding: the option *would* remove these
        // moves, and on our own corpus it is unreachable — no part is flush, so
        // turning it on today changes nothing. That is a better position than
        // "off by default", and it is why this module exists instead of a change
        // to the default.
        let mut on = job_inset_by(0.0);
        on.use_workpiece_edge = true;
        on.workpiece_edge_tolerance_mm = 0.1;
        on.operations[0].params.entry = EntryMode::Plunge; // a ramp on an open path is refused
        let res = plan_job(&on);
        assert!(res.refusals.is_empty(), "{:?}", res.refusals);
        assert!(
            note_with(&res, "CUTTING OFF THE MATERIAL").is_none(),
            "the option deleted the flush passes and the strike still fired: {:?}",
            res.notes
        );
        let gcode = gcode_of(&on, &res);
        assert!(
            !gcode.lines().any(|l| l.contains("X47.000")),
            "the option is on and the program still runs the cutter past the sheet"
        );
        // And it now says what it removes, not only what it costs.
        let says = note_with(&res, "'use the workpiece edge' is ON")
            .unwrap_or_else(|| panic!("{:?}", res.notes));
        assert!(
            says.contains("bare spoilboard"),
            "the option describes its price and not the hazard it removes: {says}"
        );
    }
}
