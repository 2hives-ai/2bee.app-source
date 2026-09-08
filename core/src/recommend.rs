//! Tool recommendation - which cutter can actually cut each feature, and why.
//!
//! # What this module is for
//!
//! A human choosing a cutter checks four things in their head and gets one of
//! them wrong at 11pm: does it fit the corner, does it make the right hole, does
//! it reach the bottom, and can the machine even hold it. This module does those
//! four checks in the open, per feature, and **states the reason for every
//! answer it gives** - including the reasons the runners-up lost.
//!
//! 🔴 **A recommendation whose basis is invisible looks like a decision somebody
//! made.** That is why nothing here returns a bare tool id. Every [`ToolChoice`]
//! carries the sentence that justifies it and the list of tools that were
//! refused, each with the rule it broke. A UI that shows only the winner is
//! throwing away the half of the output that makes it safe.
//!
//! # The rules, and the physical failure each one guards
//!
//! 1. **Internal radius caps cutter diameter.** A round tool cannot cut a corner
//!    tighter than its own radius. A 6mm cutter asked to cut a 2mm internal
//!    radius leaves 2mm of material standing in every one of those corners, the
//!    program completes, the part looks cut, and it does not fit its mate. This
//!    is the rule that matters most because its failure is silent.
//! 2. **A hole gets a drill on an EXACT diameter match only.** A 5.2mm hole
//!    drilled 6mm is a hole of the wrong size; a 5.2mm hole drilled 5mm is a hole
//!    the bolt does not enter. Rounding to the nearest cutter you happen to own is the one
//!    approximation that is guaranteed to be wrong. Without an exact drill the
//!    hole is INTERPOLATED with an end mill, or it is refused.
//! 3. **The tool must reach.** Cutting length must exceed the depth to be cut, or
//!    the shank rubs the wall at the bottom of the cut and burns or snaps.
//! 4. **The machine must be able to hold it.** Delegated to
//!    [`crate::tools::shank_fit`] - a recommendation must NEVER name a tool the
//!    machine cannot hold, which is the entire reason this function takes the
//!    machine.
//! 5. **Material caps rpm and depth per pass.** From [`Material`]. Aluminium at
//!    24,000rpm welds its chips to the flutes.
//! 6. **Prefer fewer distinct tools.** Given two tools that both satisfy a
//!    feature, take the one already used elsewhere in the job. A tool change is a
//!    spindle stop, an operator at the machine, and a Z re-reference - minutes,
//!    every time, and a chance to fit the wrong bit.
//!
//! # What this module does NOT do
//!
//! It does not order operations, assign operations to features, decide
//! pocket-vs-cutout for an ambiguous inner loop, or emit anything. It answers
//! "which tool, and why" and stops there.

use crate::drill;
use crate::feeds::{chip_verdict, resolve_feed, ChipVerdict, FeedResolution};
use crate::geometry::{Contour, Part, Vertex};
use crate::tools::{shank_fit, Material, ShankFit, ToolCategory, ToolSpec};
use crate::types::{Flute, Machine, Stock};

// ===========================================================================
//  Geometry: the internal radius, which is the rule that matters most
// ===========================================================================

/// What the geometry of one closed loop says about the largest tool that can cut
/// it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InternalGeometry {
    /// Smallest radius of curvature at a point where the MATERIAL is concave -
    /// that is, where the wall wraps around the tool. `None` means the loop has
    /// no such point and imposes no cap of its own.
    pub min_internal_radius_mm: Option<f64>,
    /// Sharp internal corners: zero radius, so **no round tool can cut them
    /// square**.
    ///
    /// 🔴 This deliberately does NOT cap the diameter. Capping at zero would
    /// refuse every ordinary rectangular pocket, which is wrong - a round tool
    /// cuts it correctly and leaves a fillet of its own radius in each corner.
    /// It is reported instead, because "leaves a fillet" and "cuts it square"
    /// are different facts and a square mating part cares which one happened.
    /// The fix is a relief cut (see [`crate::types::DogboneStyle`]), which is a
    /// joinery decision and not this module's to make.
    pub sharp_internal_corners: usize,
}

fn seg_indices(c: &Contour) -> Vec<(usize, usize)> {
    let n = c.verts.len();
    if n < 2 {
        return Vec::new();
    }
    if c.closed {
        (0..n).map(|i| (i, (i + 1) % n)).collect()
    } else {
        (0..n - 1).map(|i| (i, i + 1)).collect()
    }
}

/// Swept angle of the arc leaving `a`. `0` for a straight segment.
fn sweep(a: Vertex) -> f64 {
    4.0 * a.bulge.atan()
}

/// Radius of the arc from `a` to `b`, or `None` when the segment is straight or
/// degenerate.
fn arc_radius(a: Vertex, b: Vertex) -> Option<f64> {
    let theta = sweep(a);
    let half = (theta * 0.5).sin().abs();
    if half < 1e-12 {
        return None;
    }
    let chord = ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt();
    if chord < 1e-12 {
        return None;
    }
    Some(chord / (2.0 * half))
}

fn unit(dx: f64, dy: f64) -> Option<(f64, f64)> {
    let l = (dx * dx + dy * dy).sqrt();
    if l < 1e-12 {
        None
    } else {
        Some((dx / l, dy / l))
    }
}

fn rot((x, y): (f64, f64), ang: f64) -> (f64, f64) {
    let (s, c) = ang.sin_cos();
    (x * c - y * s, x * s + y * c)
}

/// Direction of travel leaving `a`. For an arc the tangent at the start is the
/// chord rotated by `-theta/2`; getting this sign backwards inverts every corner
/// classification, so it is pinned by a test on a known circle.
fn start_tangent(a: Vertex, b: Vertex) -> Option<(f64, f64)> {
    unit(b.x - a.x, b.y - a.y).map(|d| rot(d, -sweep(a) * 0.5))
}

/// Direction of travel arriving at `b`.
fn end_tangent(a: Vertex, b: Vertex) -> Option<(f64, f64)> {
    unit(b.x - a.x, b.y - a.y).map(|d| rot(d, sweep(a) * 0.5))
}

/// Measure the internal geometry of a closed loop.
///
/// `tool_runs_inside` says which side of the loop the CUTTER is on: `false` for
/// a part outline (the tool runs outside the material), `true` for a hole or
/// pocket (the tool runs inside the void).
///
/// 🔴 The loop is re-wound internally from that flag rather than trusted. This
/// module's whole answer flips sign with the winding, and a caller handing over
/// an un-normalised contour would otherwise get "no cap" for a loop that caps at
/// 2mm - a false green on the one rule whose failure is silent. `Part` normalises
/// on construction; nothing here assumes the caller did.
///
/// Both cases reduce to the same question once the loop is wound so that
/// **material is on the left of travel**, which is this repo's convention
/// (`geometry.rs`: CCW for material, CW for holes). A left-curving segment is
/// then convex material and imposes nothing; a right-curving segment is a wall
/// wrapping around the tool, and its radius is a cap.
pub fn internal_geometry(contour: &Contour, tool_runs_inside: bool) -> InternalGeometry {
    let mut g = InternalGeometry::default();
    if !contour.closed || contour.verts.len() < 2 {
        // An open path has no inside and no material side. It is an engraving
        // path; it caps nothing and it is not silently treated as a loop.
        return g;
    }
    let mut c = contour.clone();
    c.normalise_winding(!tool_runs_inside);

    let segs = seg_indices(&c);
    for &(i, j) in &segs {
        let (a, b) = (c.verts[i], c.verts[j]);
        // Right-curving (negative bulge, once material is on the left) is the
        // concave case: the wall closes around the tool.
        if a.bulge < 0.0 {
            if let Some(r) = arc_radius(a, b) {
                g.min_internal_radius_mm =
                    Some(g.min_internal_radius_mm.map_or(r, |m: f64| m.min(r)));
            }
        }
    }

    // Kinks between segments. A right turn with material on the left is a sharp
    // internal corner.
    let n = segs.len();
    for k in 0..n {
        let prev = segs[(k + n - 1) % n];
        let cur = segs[k];
        let inc = end_tangent(c.verts[prev.0], c.verts[prev.1]);
        let out = start_tangent(c.verts[cur.0], c.verts[cur.1]);
        if let (Some(i), Some(o)) = (inc, out) {
            let cross = i.0 * o.1 - i.1 * o.0;
            let dot = i.0 * o.0 + i.1 * o.1;
            // Ignore tangent-continuous joins (a fillet meeting its straight).
            if cross < -1e-9 && !(cross.abs() < 1e-9 && dot > 0.0) {
                g.sharp_internal_corners += 1;
            }
        }
    }
    g
}

/// Whether a tool of `radius_mm` can physically get inside a closed loop.
///
/// The curvature cap does not answer this: a 40x4mm slot with square corners has
/// no arcs at all, so nothing about its corners refuses a 6mm cutter - and a 6mm
/// cutter does not fit in a 4mm slot. This offsets the loop inward by the tool
/// radius and asks whether anything survives, which is the same test
/// `geometry.rs` uses to prove a slot narrower than the tool vanishes.
///
/// ⚠ The EXACTLY-equal case (a 4mm cutter in a 4mm slot) is knife-edge: the
/// offset collapses to a zero-width loop and whether it survives is a
/// floating-point coin toss in the offset library. Either answer is physically
/// defensible - it is a full-width slotting cut, not a refusal - so nothing here
/// is asserted about it, and no caller should depend on which way it lands.
fn fits_inside(contour: &Contour, radius_mm: f64) -> bool {
    if !contour.closed || contour.verts.len() < 2 || radius_mm <= 0.0 {
        return true;
    }
    let mut c = contour.clone();
    c.normalise_winding(true);
    !c.offset(-radius_mm).is_empty()
}

// ===========================================================================
//  Features
// ===========================================================================

#[derive(Clone, Debug, PartialEq)]
pub enum FeatureKind {
    /// The outer boundary of a part. The tool runs OUTSIDE it.
    Profile,
    /// A closed interior loop of arbitrary shape. The tool runs INSIDE it.
    Pocket,
    /// A round interior hole. The tool runs inside it, and it is the one feature
    /// where an exact-diameter drill beats a milled path.
    Hole { diameter_mm: f64 },
}

impl FeatureKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Profile => "profile",
            Self::Pocket => "pocket",
            Self::Hole { .. } => "hole",
        }
    }

    fn tool_runs_inside(&self) -> bool {
        !matches!(self, Self::Profile)
    }
}

/// One thing to be cut, with the depth it must be cut to.
#[derive(Clone, Debug)]
pub struct Feature {
    pub id: String,
    pub kind: FeatureKind,
    pub contour: Contour,
    /// Depth of material to remove, mm. For a through cut this is the workpiece
    /// thickness; for a pocket it is the floor depth.
    pub depth_mm: f64,
    /// Where `depth_mm` CAME FROM.
    ///
    /// 🔴 A DXF CARRIES NO Z, SO THE DEPTH IS NOT IN THE DRAWING. `from_part`
    /// substitutes the workpiece thickness — a reasonable default and a real
    /// assumption — and until 2026-09-04 nothing said so at the number.
    ///
    /// ⚠ IT WAS ALREADY DISCLOSED, AND THAT WAS THE PROBLEM. The caveat block
    /// has always carried *"every feature here is priced as a THROUGH cut at the
    /// workpiece thickness"* — at the BOTTOM of the output, while the feature
    /// line asserted `18.000mm deep` as a bare fact and the reach rule said
    /// "cannot cut 18mm deep" as though measured. Measured consequence
    /// 2026-09-04, on a terraced relief whose own filename said 4.5 mm: the
    /// command recommended a 12 mm cutter for a 4.5 mm terrace and REJECTED the
    /// 3 and 4 mm cutters as "too short to reach the depth". Both conclusions
    /// are wrong, and the reader who acted on them had read the caveat.
    /// ⇒ **A correction below its claim only reaches the readers who were not
    /// going to get it wrong.**
    pub depth: DepthSource,
}

/// Whether a feature's depth was DECLARED or assumed by this command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepthSource {
    /// The caller said so — `--depth`, or a planner that knows the operation.
    Declared,
    /// Nobody said; the workpiece thickness was substituted. A through cut.
    AssumedThroughStock,
}

impl DepthSource {
    /// The words that ride BESIDE the number, never in a footer.
    pub fn note(self) -> &'static str {
        match self {
            Self::Declared => "declared",
            Self::AssumedThroughStock => {
                "ASSUMED — a through cut at stock thickness; the drawing carries no Z. Pass --depth <mm> to declare it"
            }
        }
    }
    pub fn is_assumed(self) -> bool {
        matches!(self, Self::AssumedThroughStock)
    }
}

impl Feature {
    /// A feature whose depth the caller DECLARED.
    pub fn new(id: impl Into<String>, kind: FeatureKind, contour: Contour, depth_mm: f64) -> Self {
        Self { id: id.into(), kind, contour, depth_mm, depth: DepthSource::Declared }
    }

    /// The same, with the depth marked as this command's assumption.
    pub fn assumed(id: impl Into<String>, kind: FeatureKind, contour: Contour, depth_mm: f64) -> Self {
        Self { id: id.into(), kind, contour, depth_mm, depth: DepthSource::AssumedThroughStock }
    }

    /// Classify an interior loop: a full circle is a hole, anything else is a
    /// pocket.
    ///
    /// ⚠ **This is not the pocket-vs-cutout decision** (TODO #8). It only
    /// separates "round, so a drill is an option" from "not round, so it is
    /// not". Whether the loop is cleared to a floor or cut through is the
    /// caller's to say, via `depth_mm`.
    pub fn classify(id: impl Into<String>, contour: Contour, depth_mm: f64) -> Self {
        Self::classify_with(id, contour, depth_mm, DepthSource::Declared)
    }

    pub fn classify_with(
        id: impl Into<String>,
        contour: Contour,
        depth_mm: f64,
        depth: DepthSource,
    ) -> Self {
        let kind = match contour.as_circle() {
            Some((_, _, r)) => FeatureKind::Hole { diameter_mm: r * 2.0 },
            None => FeatureKind::Pocket,
        };
        Self { id: id.into(), kind, contour, depth_mm, depth }
    }

    /// Every feature of a part, cut THROUGH the workpiece.
    ///
    /// Convenience for the common case; a caller with real per-feature depths
    /// should build the features itself rather than cut every pocket through.
    pub fn from_part(part: &Part, stock: &Stock) -> Vec<Feature> {
        Self::from_part_at(part, stock.thickness_mm, DepthSource::AssumedThroughStock)
    }

    /// Every feature of a part at `depth_mm`, saying where that depth came from.
    ///
    /// 🔴 THE `DepthSource` IS NOT DECORATION. A DXF has no Z, so `from_part`
    /// substitutes stock thickness; a caller with a real depth (`--depth`, or a
    /// planner that knows the operation) passes `Declared` and the output stops
    /// hedging. Both paths print the number — only one of them prints it as a
    /// fact.
    pub fn from_part_at(part: &Part, depth_mm: f64, depth: DepthSource) -> Vec<Feature> {
        let name = if part.name.is_empty() { "part" } else { part.name.as_str() };
        let mut v = vec![Feature {
            id: format!("{name}/outer"),
            kind: FeatureKind::Profile,
            contour: part.outer.clone(),
            depth_mm,
            depth,
        }];
        for (i, inner) in part.inners.iter().enumerate() {
            v.push(Feature::classify_with(
                format!("{name}/inner-{}", i + 1),
                inner.clone(),
                depth_mm,
                depth,
            ));
        }
        v
    }
}

// ===========================================================================
//  Verdicts
// ===========================================================================

/// Why a tool was refused. Every variant carries the numbers that decided it,
/// so the UI can render the arithmetic rather than the conclusion.
#[derive(Clone, Debug, PartialEq)]
pub enum RejectReason {
    /// The tool itself is nonsense (see [`ToolSpec::faults`]).
    InvalidTool { faults: String },
    /// The category cannot perform this operation.
    WrongCategory { category: &'static str, why: &'static str },
    /// 🔴 Rule 4. The reason this function takes the machine.
    MachineCannotHoldIt { why: String },
    /// 🔴 Rule 1. The corner is tighter than the tool's own radius.
    InternalRadiusTooSmall { tool_diameter_mm: f64, internal_radius_mm: f64 },
    /// Rule 1, stated for a round hole where "internal radius" reads oddly.
    LargerThanTheHole { tool_diameter_mm: f64, hole_diameter_mm: f64 },
    /// Rule 1, the case curvature cannot see: the tool does not fit the width.
    WillNotFitInside { tool_diameter_mm: f64 },
    /// Rule 3.
    TooShortToReach { cutting_length_mm: f64, depth_mm: f64 },
    /// 🔴 Rule 2. Never rounded to the nearest bit.
    NotAnExactDrill { drill_mm: f64, hole_mm: f64, tolerance_mm: f64 },
    /// Rule 5, in the direction that refuses rather than clamps.
    MaterialRpmFloorAboveCap { floor_rpm: f64, cap_rpm: f64, material: &'static str },
    /// 🔴 Rule 7. The machine's feed ceiling and this cutter's rated chip cannot
    /// both be honoured at any speed the spindle will turn.
    ///
    /// The sibling of [`Self::MaterialRpmFloorAboveCap`] and refused for the
    /// same reason: obeying the ceiling at an unchanged rpm would thin the chip
    /// below the cutter's own minimum, which is rubbing rather than cutting, and
    /// the rpm that would hold it is below the floor. There is no speed that is
    /// both runnable and in-window, so no number is invented.
    NoSpeedHoldsTheChip {
        rpm_required: f64,
        rpm_floor: f64,
        ceiling_mm_min: f64,
        chip_mm: f64,
    },
}

/// 🔴 THE REACH RULE, IN ONE PLACE, because it was in two and only one of them ran.
///
/// A cutter whose flute is shorter than the cut drags PLAIN SHANK through the
/// material on every pass: no flutes to clear the chip, so it rubs, heats, and
/// snaps — and the program that does it looks exactly like one that does not.
///
/// Strictly greater: a flute exactly as long as the cut puts the shank at the
/// surface at the bottom of the last pass.
///
/// 🔴 AUDITED 2026-08-10 AND THIS IS WHY IT IS A FUNCTION. The rule lived only in
/// `recommend`, which the `tool_ids` (tool-SET) path consults and the `tool_id`
/// (single-cutter) path did not. Measured on the same tool and the same drawing,
/// 18mm ply:
///
/// ```text
/// --config {"tool_id":  "End Mill - Down-cut 3.175mm 2F"}
///   -> ok=true cut=17179mm deepest=-18.00mm   (32kB of runnable G-code, no note)
/// --config {"tool_ids": ["End Mill - Down-cut 3.175mm 2F"]}
///   -> refused: 12mm of cutting length cannot cut 18mm deep; the shank would be
///      in the cut
/// ```
///
/// **Selecting a SECOND tool turned the safety check on**, and the single-cutter
/// case — the ordinary one, and what the browser sends whenever one cutter is
/// picked — was the one without it. Both paths now call this; a rule that exists
/// twice is a rule that runs once.
pub fn reach_rejection(tool: &crate::types::Tool, depth_mm: f64) -> Option<RejectReason> {
    if tool.cutting_length_mm <= depth_mm {
        return Some(RejectReason::TooShortToReach {
            cutting_length_mm: tool.cutting_length_mm,
            depth_mm,
        });
    }
    None
}

impl RejectReason {
    /// A whole sentence, because this is what the operator reads.
    pub fn why(&self) -> String {
        match self {
            Self::InvalidTool { faults } => {
                format!("the tool definition is invalid: {faults}")
            }
            Self::WrongCategory { category, why } => {
                format!("a {category} cannot do this: {why}")
            }
            Self::MachineCannotHoldIt { why } => {
                format!("the machine cannot hold it: {why}")
            }
            Self::InternalRadiusTooSmall { tool_diameter_mm, internal_radius_mm } => format!(
                "{tool_diameter_mm}mm diameter is {}mm of radius, and the tightest internal radius \
                 in this feature is {internal_radius_mm}mm; it would leave that corner uncut",
                tool_diameter_mm * 0.5
            ),
            Self::LargerThanTheHole { tool_diameter_mm, hole_diameter_mm } => format!(
                "{tool_diameter_mm}mm will not go into a {hole_diameter_mm}mm hole"
            ),
            Self::WillNotFitInside { tool_diameter_mm } => format!(
                "{tool_diameter_mm}mm does not fit inside this loop; offsetting the loop in by the \
                 tool radius leaves nothing to cut"
            ),
            Self::TooShortToReach { cutting_length_mm, depth_mm } => format!(
                "{cutting_length_mm}mm of cutting length cannot cut {depth_mm}mm deep; the shank \
                 would be in the cut"
            ),
            Self::NotAnExactDrill { drill_mm, hole_mm, tolerance_mm } => format!(
                "a {drill_mm}mm drill makes a {drill_mm}mm hole, and this hole is {hole_mm}mm \
                 (outside the {tolerance_mm}mm match tolerance); a hole is the diameter of the tool \
                 that made it, so this is never rounded"
            ),
            Self::MaterialRpmFloorAboveCap { floor_rpm, cap_rpm, material } => format!(
                "{material} caps the spindle at {cap_rpm}rpm and this tool on this machine cannot \
                 turn below {floor_rpm}rpm"
            ),
            Self::NoSpeedHoldsTheChip { rpm_required, rpm_floor, ceiling_mm_min, chip_mm } => {
                crate::feeds::FeedResolution::NoSpeedHoldsTheChip {
                    rpm_required: *rpm_required,
                    rpm_floor: *rpm_floor,
                    ceiling_mm_min: *ceiling_mm_min,
                    chip_mm: *chip_mm,
                }
                .why()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rejection {
    pub tool_id: String,
    pub reason: RejectReason,
}

impl Rejection {
    pub fn sentence(&self) -> String {
        format!("{}: {}", self.tool_id, self.reason.why())
    }
}

/// The cutting parameters the material and the machine allow for the chosen
/// tool. Rule 5 lands here rather than in a rejection, because a material cap is
/// normally a limit to obey and not a reason to refuse.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CutLimits {
    pub rpm: f64,
    pub feed_mm_min: f64,
    /// For a milling tool, depth of cut per pass. For a drill, the peck
    /// increment - the same number bounding the same thing.
    pub depth_per_pass_mm: f64,
    pub passes: u32,
}

/// One feature's answer.
#[derive(Clone, Debug)]
pub struct ToolChoice {
    pub feature_id: String,
    pub kind: FeatureKind,
    pub depth_mm: f64,
    /// Where `depth_mm` came from — carried through so the ANSWER can say it,
    /// not only the input. See `Feature::depth`.
    pub depth: DepthSource,
    /// `None` means **no tool in this library can cut this feature**. It is not
    /// a fallback to something plausible, and `reason` says why.
    pub tool_id: Option<String>,
    /// Why this tool, or why nothing.
    pub reason: String,
    /// Every tool that broke a rule, with the rule it broke.
    pub rejected: Vec<Rejection>,
    /// Tools that broke no rule and lost on preference, best first. The first
    /// entry is the runner-up.
    pub alternatives: Vec<String>,
    /// How the machine holds the chosen tool. `Undeclared` is carried through
    /// rather than flattened: an unchecked collet is not a collet that passed.
    pub shank_fit: Option<ShankFit>,
    pub limits: Option<CutLimits>,
    pub geometry: InternalGeometry,
    /// Facts that change nothing about the choice but that the operator needs -
    /// sharp corners left filleted, an undeclared collet, a plunge instead of an
    /// interpolation.
    pub notes: Vec<String>,
}

impl ToolChoice {
    pub fn is_satisfied(&self) -> bool {
        self.tool_id.is_some()
    }
}

/// The whole answer for one part.
#[derive(Clone, Debug, Default)]
pub struct Recommendation {
    pub choices: Vec<ToolChoice>,
    /// Distinct tools, in the order they are first needed.
    pub tool_set: Vec<String>,
    /// Feature ids with no tool. Non-empty means the job cannot be cut as drawn
    /// with this library.
    pub unsatisfied: Vec<String>,
    pub notes: Vec<String>,
}

impl Recommendation {
    /// `N` distinct tools cost `N-1` changes. This is the number rule 6 exists
    /// to reduce.
    pub fn tool_changes(&self) -> usize {
        self.tool_set.len().saturating_sub(1)
    }

    pub fn is_complete(&self) -> bool {
        self.unsatisfied.is_empty() && !self.choices.is_empty()
    }
}

#[derive(Clone, Debug)]
pub struct RecommendOptions {
    /// Rule 6. Off is the negative control: it shows what the preference
    /// actually bought, rather than asserting it bought something.
    pub prefer_fewer_tool_changes: bool,
    /// How close a drill has to be to count as an EXACT match.
    ///
    /// 🔴 This is a manufacturing tolerance, not a rounding window. It exists
    /// because a "6mm" drill is 5.98mm, not because 5.2 should become 5.
    /// Widening it past about half the gap between stocked sizes turns rule 2
    /// into the defect it was written to prevent.
    pub drill_tolerance_mm: f64,
}

impl Default for RecommendOptions {
    fn default() -> Self {
        Self { prefer_fewer_tool_changes: true, drill_tolerance_mm: 0.05 }
    }
}

// ===========================================================================
//  The engine
// ===========================================================================

struct Candidate<'a> {
    spec: &'a ToolSpec,
    fit: ShankFit,
    limits: CutLimits,
    /// 0 best. End mill, then ball nose, then anything else that can do the job.
    cat_rank: u8,
    /// Negative diameter for milling (biggest first: stiffer, fewer passes),
    /// `0.0` where size is not a preference (an exact drill is exact).
    size_key: f64,
    /// 0 fitted, 1 needs a collet from the drawer, 2 unchecked.
    shank_rank: u8,
    /// 🔴 A LIST, not an `Option<String>`. It was a single slot until #38 §A3
    /// needed a second note on the same candidate, and a single slot does not
    /// refuse a second note — it silently overwrites the first. On a 6mm
    /// compression cutter boring a 6mm hole BOTH notes apply (a full-width
    /// plunge on the tool tip, and a veneer that will tear), and whichever was
    /// written second would have been the only one the operator saw.
    notes: Vec<String>,
}

fn shank_rank(f: &ShankFit) -> u8 {
    match f {
        ShankFit::Fitted => 0,
        ShankFit::NeedsCollet { .. } => 1,
        ShankFit::Undeclared => 2,
        ShankFit::None { .. } => 3,
    }
}

fn cmp_candidate(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.cat_rank
        .cmp(&b.cat_rank)
        .then(a.size_key.total_cmp(&b.size_key))
        .then(a.shank_rank.cmp(&b.shank_rank))
        // Deterministic, and deliberately arbitrary: where two tools are equal on
        // every rule and every preference, the tie is broken by name and the
        // losers are listed in `alternatives` so the operator can see the choice
        // was not a judgement.
        .then(a.spec.id.cmp(&b.spec.id))
}

/// The spindle speed this tool would actually turn at, given the tool's own
/// window, the spindle's, and the material's cap. The three are read together
/// because taking any two of them is a number that is safe for the wrong reason.
fn rpm_cap(spec: &ToolSpec, machine: &Machine, material: Material) -> f64 {
    spec.tool.rpm_max.min(machine.spindle_max_rpm).min(material.max_rpm())
}

/// 🔴 RULE 5's REFUSING HALF, IN ONE PLACE — for exactly the reason
/// [`reach_rejection`] is a function.
///
/// A material cap is normally a limit to OBEY, not a refusal: plywood capping a
/// cutter at 18,000rpm just means the program runs at 18,000. It becomes a
/// refusal only when the cap lands **below the floor** — the slowest this
/// spindle turns this tool is faster than the fastest this material will take,
/// so there is no speed that is both runnable and safe. Aluminium at 24,000rpm
/// welds its chips to the flutes.
///
/// It is a `pub fn` rather than a branch inside [`limits_for`] because the rule
/// is now asked from two directions: per FEATURE by [`recommend`], and per TOOL
/// by [`tool_verdicts`]. A rule that exists twice is a rule that runs once, and
/// this lane has already paid for that once with the reach check.
pub fn rpm_rejection(spec: &ToolSpec, machine: &Machine, material: Material) -> Option<RejectReason> {
    let cap = rpm_cap(spec, machine, material);
    let floor = spec.tool.rpm_min.max(machine.spindle_min_rpm);
    if floor > cap {
        return Some(RejectReason::MaterialRpmFloorAboveCap {
            floor_rpm: floor,
            cap_rpm: cap,
            material: material.as_str(),
        });
    }
    None
}

/// The slowest this pairing can actually be turned: the tool's own floor and the
/// spindle's, whichever binds. The mirror of [`rpm_cap`], and it is a function
/// for the same reason — `rpm_rejection` and the feed resolution both need it,
/// and a rule that exists twice is a rule that runs once.
fn rpm_floor(spec: &ToolSpec, machine: &Machine) -> f64 {
    spec.tool.rpm_min.max(machine.spindle_min_rpm)
}

/// Rule 5 and rule 7, applied to one tool — and every note the numbers earn.
///
/// 🔴 **THE FEED CEILING IS OBEYED BY TAKING THE SPINDLE DOWN, NOT BY THINNING
/// THE CHIP.** This line used to read:
///
/// ```text
/// let feed = feed_for(&spec.tool, rpm, material).min(machine.max_feed_mm_min);
/// ```
///
/// which is the whole defect in one `.min()`. Measured 2026-08-10 on the shipped
/// ⌀12 2F in plywood at the core's own default 6,000mm/min ceiling: the emitted
/// program ran **0.125mm of chip per tooth against that tool's own declared
/// minimum of 0.150**, and nothing said so. A safety clamp produced an
/// under-chipped program — rubbing, not cutting. See `crate::feeds` for the
/// arithmetic and `docs/materials-research.md` §4.1 for the measurement.
///
/// The notes returned beside the limits are not decoration: they are the only
/// thing that distinguishes *"the chip is where the cutter wants it"* from
/// *"nothing looked"*.
fn limits_for(
    spec: &ToolSpec,
    machine: &Machine,
    material: Material,
    depth_mm: f64,
) -> Result<(CutLimits, Vec<String>), RejectReason> {
    if let Some(r) = rpm_rejection(spec, machine, material) {
        return Err(r);
    }
    let mut notes: Vec<String> = Vec::new();
    let rpm_wanted = rpm_cap(spec, machine, material);
    let doc = (spec.tool.diameter_mm * material.max_doc_ratio(machine.machine_class)).min(depth_mm.max(0.0));
    let doc = if doc > 0.0 { doc } else { depth_mm.max(0.0) };

    // The chip this pairing is aiming for, material factor applied. `feeds` is
    // material-blind on purpose, so the factor is applied here and the
    // arithmetic lives there.
    let chip_mm = spec.tool.chipload_mm * material.chipload_factor();
    let resolution = resolve_feed(
        &spec.tool,
        rpm_wanted,
        chip_mm,
        machine.max_feed_mm_min,
        rpm_floor(spec, machine),
    );
    let (rpm, feed) = match resolution {
        FeedResolution::NoSpeedHoldsTheChip {
            rpm_required,
            rpm_floor,
            ceiling_mm_min,
            chip_mm,
        } => {
            return Err(RejectReason::NoSpeedHoldsTheChip {
                rpm_required,
                rpm_floor,
                ceiling_mm_min,
                chip_mm,
            })
        }
        other => other.rpm_feed().expect("every non-refusing resolution carries a pair"),
    };
    if !resolution.why().is_empty() {
        notes.push(resolution.why());
    }

    // 🔴 `chipload_in_window()` had NO PRODUCTION CALLER until this line — it
    // was exported, tested, and armed only by its own tests. This is the check
    // asking about the EMITTED pair, which is the only version of the question
    // that is about the program rather than about the plan.
    //
    // ⚠ It is a NOTE and not a refusal, and the reason is the evidence, not
    // squeamishness: every chipload window in `default_library()` bar one is
    // unsourced (`docs/materials-research.md` §3.2), so refusing on it would be
    // a false red resting on the same sand as the false green. The one case that
    // IS refused above is refused on an arithmetic impossibility — no speed
    // exists — which does not depend on the window being the right number.
    let delivered = chip_verdict(&spec.tool, rpm, feed);
    if !delivered.in_window() {
        notes.push(delivered.why());
        if matches!(delivered, ChipVerdict::Below { .. }) && material.chipload_factor() < 1.0 {
            notes.push(format!(
                "and the {} multiplier (x{}) is what put it there, not the machine: this cutter's \
                 window was declared for the tool, and nothing in this crate reconciles a material \
                 factor against it",
                material.as_str(),
                material.chipload_factor()
            ));
        }
    }

    // 🔴 A DRILL IS NOT BEING RATED HERE, IT IS BEING RUN ON A ROUTER-BIT MODEL.
    // `rpm` above is `Material::max_rpm()`, sourced to Techno's sentence about
    // router *tooling*, and `feed` is chip-per-tooth x flutes. A drill is rated
    // in feed per revolution against surface speed. See `crate::drill` — nothing
    // is declared, so the numbers travel with the fact that nothing vouched for
    // them.
    if spec.category() == ToolCategory::Drill && !drill::rating_for(spec).is_declared() {
        notes.push(drill::unvouched_speed_note(spec, rpm, feed));
    }

    let passes = if doc > 0.0 { (depth_mm / doc).ceil().max(1.0) as u32 } else { 1 };
    Ok((CutLimits { rpm, feed_mm_min: feed, depth_per_pass_mm: doc, passes }, notes))
}

/// Category gate for one feature. `Ok(rank)` or the reason the category cannot.
fn category_gate(kind: &FeatureKind, spec: &ToolSpec) -> Result<u8, RejectReason> {
    let cat = spec.category();
    // An angular tool's WIDTH is a function of depth, so it cannot hold a wall
    // vertical. `width_at_depth` exists in tools.rs for exactly this reason.
    let angular = RejectReason::WrongCategory {
        category: cat.as_str(),
        why: "its cutting width changes with depth, so it cannot hold a vertical wall",
    };
    match kind {
        FeatureKind::Profile | FeatureKind::Pocket => {
            if cat.is_angular() {
                return Err(angular);
            }
            let ok = match kind {
                FeatureKind::Profile => cat.can_profile(),
                _ => cat.can_pocket(),
            };
            if !ok {
                return Err(RejectReason::WrongCategory {
                    category: cat.as_str(),
                    why: "its cutting geometry is on the point, not the flank",
                });
            }
            Ok(match cat {
                ToolCategory::EndMill => 0,
                ToolCategory::BallNose => 1,
                _ => 2,
            })
        }
        FeatureKind::Hole { .. } => {
            if cat == ToolCategory::Drill {
                return Ok(0);
            }
            if cat.is_angular() {
                // Includes the countersink, which `can_drill()` allows: it makes
                // a conical seat, which is a different feature from a hole.
                return Err(angular);
            }
            if !cat.can_pocket() {
                return Err(RejectReason::WrongCategory {
                    category: cat.as_str(),
                    why: "it cannot interpolate a bore",
                });
            }
            Ok(match cat {
                ToolCategory::EndMill => 1,
                ToolCategory::BallNose => 2,
                _ => 3,
            })
        }
    }
}

fn evaluate<'a>(
    feature: &Feature,
    machine: &Machine,
    material: Material,
    library: &'a [ToolSpec],
    opts: &RecommendOptions,
) -> (Vec<Candidate<'a>>, Vec<Rejection>, InternalGeometry, Vec<String>) {
    let geom = internal_geometry(&feature.contour, feature.kind.tool_runs_inside());
    let mut cands = Vec::new();
    let mut rejected = Vec::new();
    let mut notes = Vec::new();

    if geom.sharp_internal_corners > 0 {
        notes.push(format!(
            "{} sharp internal corner(s): a round tool leaves a fillet of its own radius there. \
             Add relief if a square part has to seat in it.",
            geom.sharp_internal_corners
        ));
    }

    for spec in library {
        let mut push = |reason: RejectReason| {
            rejected.push(Rejection { tool_id: spec.id.clone(), reason });
        };

        let faults = spec.faults();
        if !faults.is_empty() {
            push(RejectReason::InvalidTool { faults: format!("{faults:?}") });
            continue;
        }

        let cat_rank = match category_gate(&feature.kind, spec) {
            Ok(r) => r,
            Err(e) => {
                push(e);
                continue;
            }
        };

        // --- Rule 4: the machine must be able to hold it -------------------
        // Checked before geometry on purpose. A tool the machine cannot hold is
        // not a near miss to be reported as "almost right"; it is not a tool
        // this shop has.
        let fit = shank_fit(spec.tool.shank_mm, machine.collet_mm, &machine.spare_collets_mm);
        if !fit.selectable() {
            push(RejectReason::MachineCannotHoldIt { why: fit.why() });
            continue;
        }

        // --- Rule 3: it must reach ------------------------------------------
        if let Some(r) = reach_rejection(&spec.tool, feature.depth_mm) {
            push(r);
            continue;
        }

        let d = spec.tool.diameter_mm;
        let mut note: Vec<String> = Vec::new();
        let size_key;

        match &feature.kind {
            FeatureKind::Hole { diameter_mm } => {
                if spec.category() == ToolCategory::Drill {
                    // --- Rule 2: EXACT match only ------------------------
                    if (d - diameter_mm).abs() > opts.drill_tolerance_mm {
                        push(RejectReason::NotAnExactDrill {
                            drill_mm: d,
                            hole_mm: *diameter_mm,
                            tolerance_mm: opts.drill_tolerance_mm,
                        });
                        continue;
                    }
                    size_key = 0.0;
                } else {
                    // Milled bore. Rule 1 in its round-hole form.
                    if d > diameter_mm + 1e-9 {
                        push(RejectReason::LargerThanTheHole {
                            tool_diameter_mm: d,
                            hole_diameter_mm: *diameter_mm,
                        });
                        continue;
                    }
                    if d >= diameter_mm - 1e-9 {
                        note.push(
                            "the same diameter as the hole, so this is a PLUNGE and not an \
                             interpolation: no helix, full width of cut, all of it on the tool tip"
                                .to_string(),
                        );
                    }
                    size_key = -d;
                }
            }
            FeatureKind::Profile | FeatureKind::Pocket => {
                // --- Rule 1: internal radius caps diameter ----------------
                if let Some(r) = geom.min_internal_radius_mm {
                    if d * 0.5 > r + 1e-9 {
                        push(RejectReason::InternalRadiusTooSmall {
                            tool_diameter_mm: d,
                            internal_radius_mm: r,
                        });
                        continue;
                    }
                }
                if feature.kind == FeatureKind::Pocket && !fits_inside(&feature.contour, d * 0.5) {
                    push(RejectReason::WillNotFitInside { tool_diameter_mm: d });
                    continue;
                }
                size_key = -d;
            }
        }

        // --- Rules 5 and 7 ---------------------------------------------------
        let limits = match limits_for(spec, machine, material, feature.depth_mm) {
            Ok((l, cut_notes)) => {
                note.extend(cut_notes);
                l
            }
            Err(e) => {
                push(e);
                continue;
            }
        };

        // --- #38 §A3: a compression cutter only compresses in ONE pass -------
        //
        // 🔴 This warning is HALF OF THE DEPTH CHANGE, not a follow-up to it.
        // A compression spiral works by having its up-cut section span the
        // whole material thickness, so the up-shear and the down-shear meet
        // inside the workpiece and neither face splinters. Capping the depth of cut
        // at 0.5xD (#38 §A1) puts the pass floor ABOVE the top of the up-cut
        // section on every pass after the first — from there the tool is a
        // plain up-cut, and an up-cut lifts the chip and tears the top veneer:
        // exactly the defect the operator bought this cutter to avoid.
        //
        // The program runs, every gate stays green, and the part comes off the
        // machine with a chipped top face. So the reduction ACTIVELY CREATES
        // this failure and must not ship without saying so.
        //
        // ⚠ It is a warning keyed on the PASS COUNT, deliberately, and NOT a
        // depth exemption. The up-cut section length of our 6mm cutter is not
        // modelled and the secondary sources for the 1/4" class disagree with
        // each other by 2.6x (#38 Part 10 item 8) — so we can be certain the
        // tool is being asked to do something it cannot, without being able to
        // say at what depth it could. A silent exemption would reintroduce
        // full-depth slotting through the back door on the exact tool people
        // reach for in ply.
        if spec.tool.flute_type == Flute::Compression && limits.passes > 1 {
            note.push(format!(
                "a COMPRESSION cutter run in {} passes is NOT a compression cutter. It compresses \
                 only when its up-cut section spans the full material in ONE pass; {} caps this \
                 {:.2}mm cutter at {:.2}mm per pass, so {:.2}mm of depth takes {} of them. From \
                 the second pass down it is a plain UP-CUT, and an up-cut lifts the chip and \
                 TEARS OUT THE TOP VENEER — the face this cutter exists to keep clean. Nothing \
                 downstream will show this: the program runs, the preview is correct, and the \
                 part comes off the machine chipped on the good face. Cut it in one pass with a \
                 tool this material will take at that depth, or fit a down-cut and accept the \
                 tear-out on the BOTTOM face instead — but do not run it as-is and expect a \
                 clean top",
                limits.passes,
                material.as_str(),
                spec.tool.diameter_mm,
                limits.depth_per_pass_mm,
                feature.depth_mm,
                limits.passes,
            ));
        }

        cands.push(Candidate {
            spec,
            shank_rank: shank_rank(&fit),
            fit,
            limits,
            cat_rank,
            size_key,
            notes: note,
        });
    }

    cands.sort_by(cmp_candidate);
    (cands, rejected, geom, notes)
}

fn why_chosen(feature: &Feature, c: &Candidate, geom: &InternalGeometry, material: Material, machine_class: crate::types::MachineClass) -> String {
    let mut parts: Vec<String> = Vec::new();
    let d = c.spec.tool.diameter_mm;

    match &feature.kind {
        FeatureKind::Hole { diameter_mm } => {
            if c.spec.category() == ToolCategory::Drill {
                parts.push(format!(
                    "a {d}mm drill is an exact match for the {diameter_mm}mm hole, so the hole is \
                     the size the drawing says"
                ));
            } else {
                parts.push(format!(
                    "no drill in the library is exactly {diameter_mm}mm, so the bore is \
                     interpolated with a {d}mm cutter rather than drilled to the wrong size"
                ));
            }
        }
        _ => match geom.min_internal_radius_mm {
            Some(r) => parts.push(format!(
                "the tightest internal radius here is {r}mm, which caps the cutter at {}mm \
                 diameter; {d}mm is the largest that fits it",
                r * 2.0
            )),
            None => parts.push(format!(
                "nothing in this feature caps the cutter radius, so {d}mm is the largest usable \
                 cutter in the library"
            )),
        },
    }

    parts.push(format!(
        "{}mm of cutting length clears the {}mm depth",
        c.spec.tool.cutting_length_mm, feature.depth_mm
    ));

    parts.push(match &c.fit {
        ShankFit::Fitted => {
            format!("the {}mm shank runs on the collet already fitted", c.spec.tool.shank_mm)
        }
        ShankFit::NeedsCollet { collet_mm } => {
            format!("the {}mm shank needs the {collet_mm}mm collet fitted", c.spec.tool.shank_mm)
        }
        ShankFit::Undeclared => format!(
            "the machine declared no collet, so the {}mm shank is UNCHECKED, not verified",
            c.spec.tool.shank_mm
        ),
        // Unreachable: an unholdable tool never becomes a candidate. Stated
        // rather than unwrapped, because a panic here would be a safety check
        // failing loudly in the wrong place.
        ShankFit::None { why } => format!("MACHINE CANNOT HOLD THIS: {why}"),
    });

    // 🔴 THE SENTENCE THAT ASSERTED A DRILL SPEED. For a router cutter this line
    // is a recommendation and it is defensible — `Material::max_rpm()` and
    // `chipload_factor()` are both sourced (`docs/materials-research.md` §1).
    // For a DRILL it was the same sentence with the same confidence and none of
    // the same evidence: it read *"Plywood caps it at 24000rpm … so 6 pass(es)
    // at 5760mm/min"* over a brad point, which is a router-bit ceiling and a
    // chip-per-tooth feed handed to a tool nobody rates that way. The numbers
    // still travel — an operator needs to know what the program will do — but
    // they are no longer stated as the material's recommendation.
    if c.spec.category() == ToolCategory::Drill && !drill::rating_for(c.spec).is_declared() {
        parts.push(format!(
            "the program will run it at {}rpm, {}mm per peck and {}mm/min, which is {} of \
             {}mm depth — but NO DRILL SPEED OR FEED HAS BEEN DECLARED for this cutter and those \
             numbers are the ROUTER-BIT ones, not a recommendation for a drill",
            c.limits.rpm,
            (c.limits.depth_per_pass_mm * 100.0).round() / 100.0,
            (c.limits.feed_mm_min * 10.0).round() / 10.0,
            c.limits.passes,
            feature.depth_mm,
        ));
    } else {
        let class_note = match machine_class {
            crate::types::MachineClass::Desktop => " (reduced for desktop frame rigidity)",
            crate::types::MachineClass::Gantry => "",
            crate::types::MachineClass::Industrial => "",
        };
        parts.push(format!(
            "{} caps it at {}rpm and {}mm per pass{}, so {} pass(es) at {}mm/min",
            material.as_str(),
            c.limits.rpm,
            (c.limits.depth_per_pass_mm * 100.0).round() / 100.0,
            class_note,
            c.limits.passes,
            (c.limits.feed_mm_min * 10.0).round() / 10.0
        ));
    }

    format!("{}: {}", c.spec.id, parts.join("; "))
}

/// Recommend a tool per feature, and report the tool set that results.
///
/// Pure: no I/O, no globals, same answer for the same inputs. The `material` is
/// a separate argument because [`Stock`] carries size and placement, not what the
/// workpiece is made of, and rule 5 needs the material.
pub fn recommend(
    features: &[Feature],
    machine: &Machine,
    stock: &Stock,
    material: Material,
    library: &[ToolSpec],
    opts: &RecommendOptions,
) -> Recommendation {
    let mut out = Recommendation::default();
    let mut chosen_ids: Vec<String> = Vec::new();

    for feature in features {
        let (cands, rejected, geom, mut notes) =
            evaluate(feature, machine, material, library, opts);

        if feature.depth_mm > stock.thickness_mm + 1e-9 {
            notes.push(format!(
                "the {}mm depth is deeper than the {}mm workpiece: this cuts into whatever is under it",
                feature.depth_mm, stock.thickness_mm
            ));
        }

        let mut choice = ToolChoice {
            feature_id: feature.id.clone(),
            kind: feature.kind.clone(),
            depth_mm: feature.depth_mm,
            depth: feature.depth,
            tool_id: None,
            reason: String::new(),
            rejected,
            alternatives: Vec::new(),
            shank_fit: None,
            limits: None,
            geometry: geom,
            notes,
        };

        if cands.is_empty() {
            // 🔴 The explicit no-answer. Never a fallback to something plausible.
            choice.reason = format!(
                "NO TOOL IN THIS LIBRARY CAN CUT THIS {}. {} tool(s) were considered and every one \
                 broke a rule; see `rejected` for which rule each broke.",
                feature.kind.as_str().to_uppercase(),
                choice.rejected.len()
            );
            out.unsatisfied.push(feature.id.clone());
            out.choices.push(choice);
            continue;
        }

        // --- Rule 6: prefer a tool already in the job ------------------------
        let best = 0usize;
        let pick = if opts.prefer_fewer_tool_changes {
            cands
                .iter()
                .position(|c| chosen_ids.iter().any(|id| id == &c.spec.id))
                .unwrap_or(best)
        } else {
            best
        };

        let c = &cands[pick];
        let mut reason = why_chosen(feature, c, &geom, material, machine.machine_class);
        if pick != best {
            reason.push_str(&format!(
                ". Chosen over {} because it is ALREADY IN THIS JOB: a tool change is a spindle \
                 stop, a bit change and a Z re-reference, and that costs more than the difference \
                 between these two cutters",
                cands[best].spec.id
            ));
        }
        for n in &c.notes {
            choice.notes.push(format!("{}: {n}", c.spec.id));
        }
        if matches!(c.fit, ShankFit::Undeclared) {
            choice.notes.push(
                "the machine has not declared a collet, so the shank check is UNCHECKED rather \
                 than passed"
                    .to_string(),
            );
        }
        let tied: Vec<&str> = cands
            .iter()
            .enumerate()
            .filter(|(i, o)| {
                *i != pick && cmp_candidate(o, c) != std::cmp::Ordering::Less && equal_rank(o, c)
            })
            .map(|(_, o)| o.spec.id.as_str())
            .collect();
        if !tied.is_empty() {
            choice.notes.push(format!(
                "the tie against {} was broken by name, not by a rule; any of them would do",
                tied.join(", ")
            ));
        }

        choice.tool_id = Some(c.spec.id.clone());
        choice.reason = reason;
        choice.shank_fit = Some(c.fit.clone());
        choice.limits = Some(c.limits);
        choice.alternatives =
            cands.iter().enumerate().filter(|(i, _)| *i != pick).map(|(_, o)| o.spec.id.clone()).collect();

        if !chosen_ids.iter().any(|id| id == &c.spec.id) {
            chosen_ids.push(c.spec.id.clone());
        }
        out.choices.push(choice);
    }

    out.tool_set = chosen_ids;
    if !out.unsatisfied.is_empty() {
        out.notes.push(format!(
            "{} feature(s) have no tool in this library: {}",
            out.unsatisfied.len(),
            out.unsatisfied.join(", ")
        ));
    }
    out
}

fn equal_rank(a: &Candidate, b: &Candidate) -> bool {
    a.cat_rank == b.cat_rank
        && (a.size_key - b.size_key).abs() < 1e-12
        && a.shank_rank == b.shank_rank
}

/// The common case: every feature of one part, cut through the workpiece, with the
/// default options.
pub fn recommend_for_part(
    part: &Part,
    machine: &Machine,
    stock: &Stock,
    material: Material,
    library: &[ToolSpec],
) -> Recommendation {
    let features = Feature::from_part(part, stock);
    recommend(&features, machine, stock, material, library, &RecommendOptions::default())
}

// ===========================================================================
//  Per-TOOL verdicts — the same rules, asked the other way round
// ===========================================================================
//
// [`recommend`] answers *"for this FEATURE, which tool"*. A tool LIST needs the
// transpose: *"for this SETUP, what about THIS tool"* — once per row, whether or
// not a drawing is loaded. This section is that transpose, and it is here rather
// than in a host because a verdict computed beside the list is a second copy of
// a machining rule in the one place no gate can see it. The tool row's
// material-blind feed, the `uncut <= 20` threshold and the travel-fit rule were
// all that defect; the list must ASK and RENDER, never decide.
//
// 🔴 TWO QUESTIONS, TWO ANSWERS, AND THEY ARE NOT ONE BOOLEAN.
//
//   * [`Usability`] — *can this tool be used at all in this setup?* A shank no
//     collet can hold, a flute shorter than the workpiece, an rpm floor above the
//     material's cap: the job cannot be cut with it. This is the RED one.
//   * [`Advice`] — *is it the tool this drawing wants?* A perfectly usable 3mm
//     cutter on an unconstrained outline is valid and is not the recommendation.
//     This is the FILTER one.
//
// Collapsing them would tell an operator that a preference is a refusal, and
// the next time a real refusal appears it will be read as a preference.
//
// 🔴 AND A THIRD STATE. A check that cannot run reports UNKNOWN, never PASS.
// No workpiece declared and the reach rule has no depth to measure against; no
// material and rule 5 has no cap; no machine and the collet is `Undeclared`,
// which is the core's own word for the same thing. UNKNOWN is not usable and
// must never be rendered as though it were — a green meaning "unchecked" is
// worse than a red.

/// The setup a tool is judged against — and, field by field, whether anybody
/// DECLARED it.
///
/// Every field is an `Option` on purpose. `Stock::default()` has an 18mm
/// thickness and `Machine::default()` a 24,000rpm spindle, and judging a cutter
/// against either of those while nobody chose them produces a confident verdict
/// about a machine that does not exist.
#[derive(Clone, Debug, Default)]
pub struct Setup {
    /// `None` = no machine declared, so the collet and the spindle are both
    /// UNCHECKED. Note that a machine which IS declared but names no collet
    /// still reaches [`ShankFit::Undeclared`] — the same answer by the core's
    /// own route.
    pub machine: Option<Machine>,
    /// The depth the reach rule measures against, and the depth the planner
    /// plans every imported operation at. `None` = no workpiece declared.
    pub stock_thickness_mm: Option<f64>,
    /// `None` = nobody chose one, or the name was not recognised (in which case
    /// `notes` says so, exactly as the planner does).
    pub material: Option<Material>,
    /// Facts about the setup itself that the caller should see — currently the
    /// unrecognised-material case.
    pub notes: Vec<String>,
}

impl Setup {
    /// The setup as the PLANNER will resolve it, read from the very
    /// [`crate::fixtures::JobConfig`] the planner is handed.
    ///
    /// 🔴 It takes the config struct rather than a set of scalars so that a host
    /// asking *"is this tool usable"* and a host asking *"plan this job"* cannot
    /// be describing two different machines. One object, one setup, one answer.
    ///
    /// ⚠ **Only the fields a rule in this module READS are copied**, and that is
    /// a hazard worth naming rather than a tidy optimisation: if a rule is ever
    /// added here that reads, say, `travel_x_mm`, it will silently be judging
    /// against `Machine::default()`'s 600mm rather than the operator's machine.
    /// Add the copy in the same commit as the rule. `machine_fields_are_carried`
    /// is the test that fails when one of these five stops arriving.
    pub fn from_job_config(cfg: &crate::fixtures::JobConfig) -> Self {
        let mut notes = Vec::new();
        let machine = cfg.machine.as_ref().map(|m| {
            let mut d = Machine::default();
            if let Some(v) = m.collet_mm {
                d.collet_mm = v;
            }
            if let Some(v) = &m.spare_collets_mm {
                d.spare_collets_mm = v.clone();
            }
            if let Some(v) = m.spindle_min_rpm {
                d.spindle_min_rpm = v;
            }
            if let Some(v) = m.spindle_max_rpm {
                d.spindle_max_rpm = v;
            }
            if let Some(v) = m.max_feed_mm_min {
                d.max_feed_mm_min = v;
            }
            d
        });
        let material = match cfg.material.as_deref() {
            None => None,
            Some(name) => match Material::from_str(name) {
                Some(m) => Some(m),
                None => {
                    // 🔴 Reported, never defaulted to plywood — the same
                    // direction `JobConfig::apply` takes for the same reason.
                    // "Aluminium " with a stray space silently becoming plywood
                    // would judge every rpm against the wrong cap.
                    notes.push(format!(
                        "material '{name}' is not one this core knows, so NOTHING was judged \
                         against a material: the spindle-rpm rule is UNCHECKED for every tool"
                    ));
                    None
                }
            },
        };
        Self {
            machine,
            stock_thickness_mm: cfg.stock.as_ref().and_then(|s| s.thickness_mm),
            material,
            notes,
        }
    }

    /// The workpiece the recommender needs. `None` when no thickness was declared —
    /// there is no fallback workpiece, because a recommendation computed against a
    /// thickness nobody chose is trusted exactly as if somebody had.
    fn stock(&self) -> Option<Stock> {
        self.stock_thickness_mm.map(|thickness_mm| Stock { thickness_mm, ..Stock::default() })
    }

    /// Whether every input the recommender needs is present. All three or none:
    /// a partial recommendation is a recommendation with a rule silently off.
    fn complete(&self) -> Option<(&Machine, Stock, Material)> {
        match (self.machine.as_ref(), self.stock(), self.material) {
            (Some(m), Some(s), Some(mat)) => Some((m, s, mat)),
            _ => None,
        }
    }
}

/// What one blocking rule said about one tool.
#[derive(Clone, Debug, PartialEq)]
pub enum RuleOutcome {
    /// The rule ran and the tool cleared it.
    Passed,
    /// The rule ran and the tool broke it. **This invalidates the job.**
    Refused(RejectReason),
    /// 🔴 The rule COULD NOT RUN. Carries the reason nothing could be checked.
    /// It is not a pass and it is not a refusal, and flattening it into either
    /// is the failure this whole third state exists to stop.
    Unchecked(String),
}

impl RuleOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Refused(_) => "refused",
            Self::Unchecked(_) => "unchecked",
        }
    }

    /// The sentence, in the core's words. Empty for a pass — deliberately, and
    /// the same convention as [`ShankFit::why`], so a host cannot write
    /// `why || "fits"` and have it read as an answer when nothing answered.
    pub fn why(&self) -> String {
        match self {
            Self::Passed => String::new(),
            Self::Refused(r) => r.why(),
            Self::Unchecked(w) => w.clone(),
        }
    }
}

/// One blocking rule's answer, with the rule named so a host can say WHICH
/// condition marked the row. "Invalidates the job" is not one condition, and a
/// red square that will not say which one it is cannot be acted on.
#[derive(Clone, Debug, PartialEq)]
pub struct RuleVerdict {
    /// `"tool-definition" | "collet" | "reach" | "spindle-rpm"`.
    pub rule: &'static str,
    pub outcome: RuleOutcome,
}

/// Can this tool be used at all, in this setup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Usability {
    /// Every blocking rule ran, and every one passed.
    Usable,
    /// At least one blocking rule refused it. 🔴 **The job cannot be cut with
    /// this tool** — this is the red mark.
    Invalidates,
    /// At least one blocking rule could not run, and none refused. **Not
    /// usable**: nothing has vouched for this tool.
    Unknown,
}

impl Usability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Usable => "usable",
            Self::Invalidates => "invalidates",
            Self::Unknown => "unknown",
        }
    }
}

/// Is this the tool the drawing wants — a different question from whether it
/// can be used at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Advice {
    /// [`recommend`] chose it for at least one feature.
    Recommended,
    /// It broke no rule on at least one feature and lost on preference. Valid,
    /// and not the recommendation.
    Usable,
    /// It broke a rule on every feature of this drawing.
    NotForThisJob,
    /// 🔴 Nothing was asked: no drawing, or a setup too incomplete to run the
    /// recommender. Not "not recommended".
    Unknown,
}

impl Advice {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::Usable => "usable",
            Self::NotForThisJob => "not-for-this-job",
            Self::Unknown => "unknown",
        }
    }
}

/// Why a tool was refused for one particular feature.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureRefusal {
    pub feature_id: String,
    pub why: String,
}

/// One row of the tool list, as the core sees it.
#[derive(Clone, Debug)]
pub struct ToolVerdict {
    pub tool_id: String,
    pub usability: Usability,
    /// The core's own sentence for [`Self::usability`] — the refusals joined for
    /// `Invalidates`, the unchecked reasons for `Unknown`, **empty** for
    /// `Usable`. A host renders this verbatim; a paraphrase of a safety message
    /// is a second copy that drifts.
    pub why: String,
    /// Every blocking rule, whether it passed, refused or could not run. The
    /// detail behind `usability`, so a red row can name its condition.
    pub rules: Vec<RuleVerdict>,
    pub advice: Advice,
    /// The core's sentence for [`Self::advice`]. For `Recommended` this is
    /// [`ToolChoice::reason`] itself — the same text `2bee-slice recommend`
    /// prints.
    pub why_advice: String,
    pub recommended_for: Vec<String>,
    pub usable_for: Vec<String>,
    pub refused_for: Vec<FeatureRefusal>,
}

/// 🔴 The two sentences a host will be tempted to invent, written here so it
/// does not have to.
pub const USABLE_IS_NOT_RECOMMENDED: &str =
    "`usability` and `advice` answer DIFFERENT QUESTIONS and must not be merged. `usability` is \
     whether the job can be cut with this tool at all — a shank no collet holds, a flute shorter \
     than the workpiece, an rpm floor above what the material takes. `advice` is whether this drawing \
     wants it. A tool can be perfectly usable and simply not the best choice, and an operator who \
     cannot tell a preference from a refusal will eventually override the wrong one.";

pub const UNKNOWN_IS_NOT_USABLE: &str =
    "UNKNOWN IS NOT USABLE. It means a rule could not run — no workpiece thickness declared, no \
     material chosen, no collet on the machine — so nothing has vouched for this tool. Render it \
     as unjudged, never as cleared, and never fall back to `usable` for it. A green that means \
     'unchecked' is worse than a red, and the planner may still refuse a tool this call could not \
     judge.";

/// 🔴 **The tool list's verdicts** — one per tool, for this setup and (if there
/// is one) this drawing.
///
/// Nothing new is decided here. Every blocking answer comes from the predicate
/// the planner and the recommender already use — [`ToolSpec::faults`],
/// [`shank_fit`], [`reach_rejection`], [`rpm_rejection`] — and every advice
/// answer is READ OUT of a [`Recommendation`] this function runs, rather than
/// re-derived beside it. That is what makes the list and the planner unable to
/// disagree: they are the same code, asked from two sides.
///
/// `parts` is the drawing, as imported. Empty means no drawing, and every
/// `advice` comes back [`Advice::Unknown`] — which is a different fact from "no
/// tool is recommended".
pub fn tool_verdicts(library: &[ToolSpec], setup: &Setup, parts: &[Part]) -> Vec<ToolVerdict> {
    // ---- the advice half: ONE recommender run, read per tool ---------------
    //
    // 🔴 Run once over every feature of every part, then transposed. Evaluating
    // each tool separately here would be a second implementation of rule 6 (the
    // fewer-tool-changes preference), which is exactly the kind of duplicate
    // that ends up disagreeing with the program.
    let recommendation = setup.complete().filter(|_| !parts.is_empty()).map(|(m, s, mat)| {
        let features: Vec<Feature> = parts.iter().flat_map(|p| Feature::from_part(p, &s)).collect();
        recommend(&features, m, &s, mat, library, &RecommendOptions::default())
    });

    library
        .iter()
        .map(|spec| {
            let mut rules = Vec::new();

            // --- the tool itself ------------------------------------------
            let faults = spec.faults();
            rules.push(RuleVerdict {
                rule: "tool-definition",
                outcome: if faults.is_empty() {
                    RuleOutcome::Passed
                } else {
                    RuleOutcome::Refused(RejectReason::InvalidTool {
                        faults: format!("{faults:?}"),
                    })
                },
            });

            // --- rule 4: can the machine hold it --------------------------
            rules.push(RuleVerdict {
                rule: "collet",
                outcome: match setup.machine.as_ref() {
                    None => RuleOutcome::Unchecked(
                        "no machine is declared, so no collet could be checked against this \
                         shank — UNCHECKED, not held"
                            .into(),
                    ),
                    Some(m) => {
                        let fit = shank_fit(spec.tool.shank_mm, m.collet_mm, &m.spare_collets_mm);
                        match fit {
                            // The core's own third state, carried across rather
                            // than flattened: an unchecked collet is not a
                            // collet that passed.
                            ShankFit::Undeclared => RuleOutcome::Unchecked(fit.why()),
                            _ if !fit.selectable() => {
                                RuleOutcome::Refused(RejectReason::MachineCannotHoldIt {
                                    why: fit.why(),
                                })
                            }
                            _ => RuleOutcome::Passed,
                        }
                    }
                },
            });

            // --- rule 3: does it reach ------------------------------------
            //
            // 🔴 THE SAME PREDICATE, AT THE SAME DEPTH, AS THE PLANNER'S OWN
            // REFUSAL. `plan_report_import_many` calls `reach_rejection(&tool,
            // stock.thickness_mm)` and refuses the whole job on it; this asks it
            // per tool. If these two ever disagree it is because someone gave
            // them different depths, not different rules.
            rules.push(RuleVerdict {
                rule: "reach",
                outcome: match setup.stock_thickness_mm {
                    None => RuleOutcome::Unchecked(
                        "no workpiece thickness is declared, so there is no depth to measure this \
                         cutter's reach against — UNCHECKED, not long enough"
                            .into(),
                    ),
                    Some(t) => match reach_rejection(&spec.tool, t) {
                        Some(r) => RuleOutcome::Refused(r),
                        None => RuleOutcome::Passed,
                    },
                },
            });

            // --- rule 5: is there an rpm that is both runnable and safe ----
            rules.push(RuleVerdict {
                rule: "spindle-rpm",
                outcome: match (setup.machine.as_ref(), setup.material) {
                    (Some(m), Some(mat)) => match rpm_rejection(spec, m, mat) {
                        Some(r) => RuleOutcome::Refused(r),
                        None => RuleOutcome::Passed,
                    },
                    (None, _) => RuleOutcome::Unchecked(
                        "no machine is declared, so the spindle's own speed range is unknown and \
                         no rpm could be checked — UNCHECKED"
                            .into(),
                    ),
                    (_, None) => RuleOutcome::Unchecked(
                        "no material is chosen, so nothing caps the spindle speed and no rpm \
                         could be checked — UNCHECKED"
                            .into(),
                    ),
                },
            });

            // --- rule 7: is this cutter rated in the model it will be run on --
            //
            // 🔴 THE LIST AND THE PLANNER MUST NOT DISAGREE, and this rule is
            // what keeps them in step for drills. `limits_for` plans a drill
            // with a loud unvouched note; a list that answered `usable` beside
            // it would be vouching for numbers the planner explicitly does not.
            // `Unknown` is the honest third state: a rule that could not run.
            //
            // ⚠ Vacuous for a non-drill BY CONSTRUCTION — a cutter that is never
            // asked for a per-revolution feed cannot be run on the wrong drill
            // model. It is still asked on every row so the rule count is
            // uniform: a row that quietly stopped asking a rule looks identical
            // to one that passed it.
            rules.push(RuleVerdict {
                rule: "drill-feed-model",
                outcome: if spec.category() != ToolCategory::Drill {
                    RuleOutcome::Passed
                } else {
                    match drill::rating_for(spec) {
                        drill::DrillRating::Declared(_) => RuleOutcome::Passed,
                        drill::DrillRating::Undeclared { why } => RuleOutcome::Unchecked(format!(
                            "{why}. The planner will still emit a program for this drill — it does \
                             not refuse — so this row is UNJUDGED rather than cleared, and the \
                             numbers in that program carry the same warning"
                        )),
                    }
                },
            });

            let refusals: Vec<String> = rules
                .iter()
                .filter(|r| matches!(r.outcome, RuleOutcome::Refused(_)))
                .map(|r| r.outcome.why())
                .collect();
            let unchecked: Vec<String> = rules
                .iter()
                .filter(|r| matches!(r.outcome, RuleOutcome::Unchecked(_)))
                .map(|r| r.outcome.why())
                .collect();

            // 🔴 Refused wins over unchecked, and unchecked wins over usable.
            // Never the other way: a tool with one broken rule and one unrun
            // rule is refused, and a tool with one unrun rule is not cleared by
            // the rules that did run.
            let (usability, why) = if !refusals.is_empty() {
                (Usability::Invalidates, refusals.join("; "))
            } else if !unchecked.is_empty() {
                (Usability::Unknown, unchecked.join("; "))
            } else {
                (Usability::Usable, String::new())
            };

            let mut recommended_for = Vec::new();
            let mut usable_for = Vec::new();
            let mut refused_for = Vec::new();
            let mut why_advice = String::new();

            let advice = match &recommendation {
                None => Advice::Unknown,
                Some(rec) => {
                    for choice in &rec.choices {
                        if choice.tool_id.as_deref() == Some(spec.id.as_str()) {
                            if why_advice.is_empty() {
                                // The recommender's own sentence, verbatim —
                                // the same text the CLI prints under REASON.
                                why_advice = choice.reason.clone();
                            }
                            recommended_for.push(choice.feature_id.clone());
                        } else if choice.alternatives.iter().any(|a| a == &spec.id) {
                            usable_for.push(choice.feature_id.clone());
                        } else if let Some(r) =
                            choice.rejected.iter().find(|r| r.tool_id == spec.id)
                        {
                            refused_for.push(FeatureRefusal {
                                feature_id: choice.feature_id.clone(),
                                why: r.reason.why(),
                            });
                        }
                    }
                    if !recommended_for.is_empty() {
                        Advice::Recommended
                    } else if !usable_for.is_empty() {
                        why_advice = format!(
                            "it broke no rule on {}, and lost on preference — a valid cutter for \
                             this drawing, and not the one the recommender chose",
                            usable_for.join(", ")
                        );
                        Advice::Usable
                    } else {
                        why_advice = match refused_for.first() {
                            Some(f) => format!(
                                "it broke a rule on every feature of this drawing; on {} — {}",
                                f.feature_id, f.why
                            ),
                            // Reachable when a drawing yields no features at
                            // all. Said rather than left empty: a blank reason
                            // beside a verdict reads as a verdict nobody stood
                            // behind.
                            None => "this drawing has no feature this tool was asked about".into(),
                        };
                        Advice::NotForThisJob
                    }
                }
            };

            ToolVerdict {
                tool_id: spec.id.clone(),
                usability,
                why,
                rules,
                advice,
                why_advice,
                recommended_for,
                usable_for,
                refused_for,
            }
        })
        .collect()
}

/// [`tool_verdicts`], serialised for a host that cannot hold a Rust type.
///
/// 🔴 **Every sentence in this payload is composed HERE**, in the core, and a
/// host renders it verbatim. Returning a code for a host to turn back into a
/// sentence would be a second copy of a safety message, and the two would drift
/// — the pattern this lane settled on for the spoilboard refusals and for
/// `Interference::describe`.
pub fn tool_verdicts_json(
    library: &[ToolSpec],
    setup: &Setup,
    parts: &[Part],
    extra_notes: &[String],
) -> String {
    let verdicts = tool_verdicts(library, setup, parts);
    let rows: Vec<serde_json::Value> = verdicts
        .iter()
        .map(|v| {
            serde_json::json!({
                "id": v.tool_id,
                "usability": v.usability.as_str(),
                "why": v.why,
                "rules": v.rules.iter().map(|r| serde_json::json!({
                    "rule": r.rule,
                    "outcome": r.outcome.as_str(),
                    "why": r.outcome.why(),
                })).collect::<Vec<_>>(),
                "advice": v.advice.as_str(),
                "why_advice": v.why_advice,
                "recommended_for": v.recommended_for,
                "usable_for": v.usable_for,
                "refused_for": v.refused_for.iter().map(|f| serde_json::json!({
                    "feature_id": f.feature_id,
                    "why": f.why,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    let mut notes = setup.notes.clone();
    notes.extend(extra_notes.iter().cloned());

    serde_json::json!({
        "ok": true,
        // What was actually judged, echoed so the answer says what produced it.
        // A verdict quoted without its setup is a verdict about a machine the
        // reader has to guess at.
        "setup": {
            "machine_declared": setup.machine.is_some(),
            "collet_mm": setup.machine.as_ref().map(|m| m.collet_mm),
            "spare_collets_mm": setup.machine.as_ref().map(|m| m.spare_collets_mm.clone()),
            "stock_thickness_mm": setup.stock_thickness_mm,
            "material": setup.material.map(|m| m.as_str()),
            // 0 means NO DRAWING, and every `advice` is `unknown` in that case.
            "parts": parts.len(),
        },
        "verdicts": rows,
        "notes": notes,
        "caveats": [USABLE_IS_NOT_RECOMMENDED, UNKNOWN_IS_NOT_USABLE],
    })
    .to_string()
}

// ===========================================================================
//  Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::default_library;

    /// A machine that owns the collets for the whole built-in library, so a test
    /// about geometry is not accidentally a test about collets.
    fn well_stocked_machine() -> Machine {
        Machine {
            collet_mm: 6.0,
            spare_collets_mm: vec![3.175, 4.0, 8.0, 10.0, 12.0],
            ..Machine::default()
        }
    }

    fn stock(thickness_mm: f64) -> Stock {
        Stock { thickness_mm, ..Stock::default() }
    }

    fn chosen_diameter(c: &ToolChoice, lib: &[ToolSpec]) -> f64 {
        let id = c.tool_id.as_ref().expect("a tool was expected");
        lib.iter().find(|t| &t.id == id).unwrap().tool.diameter_mm
    }

    fn rejection_for<'a>(c: &'a ToolChoice, tool_id: &str) -> &'a RejectReason {
        &c.rejected
            .iter()
            .find(|r| r.tool_id == tool_id)
            .unwrap_or_else(|| panic!("{tool_id} was not even considered for {}", c.feature_id))
            .reason
    }

    // --- geometry ---------------------------------------------------------

    #[test]
    fn a_hole_reads_its_own_radius_as_the_internal_radius() {
        // The tangent-sign derivation is pinned here: get it backwards and a
        // 10mm hole reports "no cap", which is the silent failure this whole
        // module exists to stop.
        let mut c = Contour::circle(0.0, 0.0, 5.0);
        c.normalise_winding(false);
        let g = internal_geometry(&c, true);
        assert!((g.min_internal_radius_mm.unwrap() - 5.0).abs() < 1e-9, "{g:?}");
        assert_eq!(g.sharp_internal_corners, 0);
    }

    #[test]
    fn a_plain_rectangular_outline_caps_nothing_and_reports_no_sharp_internal_corners() {
        // Negative control for the classifier: the outside corners of a part are
        // CONVEX. Counting them as internal would refuse every cutter on every
        // rectangle.
        let g = internal_geometry(&Contour::rect(0.0, 0.0, 100.0, 50.0), false);
        assert_eq!(g.min_internal_radius_mm, None, "{g:?}");
        assert_eq!(g.sharp_internal_corners, 0, "{g:?}");
    }

    #[test]
    fn a_square_pocket_reports_four_sharp_corners_and_still_caps_nothing() {
        // The corners of a POCKET are internal, and they are sharp. Sharp must
        // not cap the diameter at zero - that would refuse an ordinary pocket.
        let mut c = Contour::rect(0.0, 0.0, 60.0, 40.0);
        c.normalise_winding(false);
        let g = internal_geometry(&c, true);
        assert_eq!(g.sharp_internal_corners, 4, "{g:?}");
        assert_eq!(g.min_internal_radius_mm, None, "{g:?}");
    }

    #[test]
    fn winding_is_normalised_from_the_role_not_trusted_from_the_caller() {
        // Same loop, handed over CCW (un-normalised for a hole). The answer must
        // still be 5mm, because the role says the tool is inside.
        let c = Contour::circle(0.0, 0.0, 5.0);
        assert!(c.signed_area() > 0.0, "fixture must be CCW for this test to mean anything");
        let g = internal_geometry(&c, true);
        assert!((g.min_internal_radius_mm.unwrap() - 5.0).abs() < 1e-9, "{g:?}");
    }

    // --- rule 1: the internal radius caps the cutter ----------------------

    #[test]
    fn an_oversize_cutter_is_refused_by_the_internal_radius_and_says_which_corner() {
        // 🔴 Rule 1. A 2mm internal radius caps the cutter at 4mm diameter. The
        // 6mm cutter would run the whole program and leave 2mm of material
        // standing in every corner.
        let lib = default_library();
        let pocket = {
            let mut c = Contour::rounded_rect(0.0, 0.0, 60.0, 40.0, 2.0);
            c.normalise_winding(false);
            c
        };
        let f = Feature::new("pocket", FeatureKind::Pocket, pocket, 9.0);
        let r = recommend(
            &[f],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];

        assert!((c.geometry.min_internal_radius_mm.unwrap() - 2.0).abs() < 1e-9, "{:?}", c.geometry);
        assert!(chosen_diameter(c, &lib) <= 4.0 + 1e-9, "chose {}", c.reason);

        match rejection_for(c, "End Mill - Down-cut 6mm 2F") {
            RejectReason::InternalRadiusTooSmall { tool_diameter_mm, internal_radius_mm } => {
                assert!((*tool_diameter_mm - 6.0).abs() < 1e-9);
                assert!((*internal_radius_mm - 2.0).abs() < 1e-9);
            }
            other => panic!("6mm cutter rejected for the wrong reason: {other:?}"),
        }
        // The reason has to be readable, not just present.
        assert!(rejection_for(c, "End Mill - Down-cut 6mm 2F").why().contains("uncut"));
    }

    // --- rule 2: an exact drill, or no drill ------------------------------

    #[test]
    fn a_hole_gets_an_exact_drill_and_5_2mm_is_refused_rather_than_rounded() {
        // 🔴 Rule 2, both directions in one test: the exact case must succeed or
        // the refusal proves nothing.
        let lib = default_library();
        let m = well_stocked_machine();
        let s = stock(12.0);

        let six = Feature::classify("six", Contour::circle(0.0, 0.0, 3.0), 12.0);
        let odd = Feature::classify("odd", Contour::circle(0.0, 0.0, 2.6), 12.0);
        assert_eq!(six.kind, FeatureKind::Hole { diameter_mm: 6.0 });

        let r = recommend(&[six, odd], &m, &s, Material::Plywood, &lib, &RecommendOptions::default());

        let a = &r.choices[0];
        let id = a.tool_id.as_ref().unwrap();
        assert!(id.contains("Drill"), "a 6mm hole should be drilled, got {id}");
        assert!((chosen_diameter(a, &lib) - 6.0).abs() < 1e-9);

        let b = &r.choices[1];
        // 🔴 The defect this refuses: 5.2 -> 5.0 or 5.5 is a hole in the wrong
        // place at the wrong size.
        if let Some(id) = &b.tool_id {
            assert!(!id.contains("Drill"), "5.2mm hole was rounded to a stocked drill: {id}");
        }
        for near in ["Drill - Brad Point 5mm 2F", "Drill - Twist Carbide 5mm 2F", "Drill - Brad Point 5.5mm 2F"] {
            match rejection_for(b, near) {
                RejectReason::NotAnExactDrill { hole_mm, .. } => {
                    assert!((*hole_mm - 5.2).abs() < 1e-9)
                }
                other => panic!("{near} was refused for the wrong reason: {other:?}"),
            }
        }
    }

    #[test]
    fn with_only_drills_in_the_library_an_odd_hole_gets_no_tool_at_all() {
        // Same rule with the escape hatch removed: no end mill means no
        // interpolation, and the honest answer is nothing.
        let lib: Vec<ToolSpec> = default_library()
            .into_iter()
            .filter(|t| t.category() == ToolCategory::Drill)
            .collect();
        let f = Feature::classify("odd", Contour::circle(0.0, 0.0, 2.6), 12.0);
        let r = recommend(
            &[f],
            &well_stocked_machine(),
            &stock(12.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        assert!(r.choices[0].tool_id.is_none(), "{}", r.choices[0].reason);
        assert_eq!(r.unsatisfied, vec!["odd".to_string()]);
        assert!(r.choices[0].reason.contains("NO TOOL IN THIS LIBRARY"), "{}", r.choices[0].reason);
    }

    // --- rule 3: it must reach --------------------------------------------

    #[test]
    fn a_tool_that_cannot_reach_the_depth_is_refused_with_that_as_the_reason() {
        let lib = default_library();
        let f = Feature::new("deep", FeatureKind::Profile, Contour::rect(0.0, 0.0, 300.0, 200.0), 30.0);
        let r = recommend(
            &[f],
            &well_stocked_machine(),
            &stock(30.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        match rejection_for(c, "End Mill - Down-cut 3.175mm 2F") {
            RejectReason::TooShortToReach { cutting_length_mm, depth_mm } => {
                assert!((*cutting_length_mm - 12.0).abs() < 1e-9);
                assert!((*depth_mm - 30.0).abs() < 1e-9);
            }
            other => panic!("wrong reason: {other:?}"),
        }
        // And the tool that CAN reach is the one chosen, or the check proved
        // nothing but that everything failed.
        let id = c.tool_id.as_ref().unwrap();
        let t = lib.iter().find(|t| &t.id == id).unwrap();
        assert!(t.tool.cutting_length_mm > 30.0, "{id} has {}mm of flute", t.tool.cutting_length_mm);
    }

    // --- rule 4: the machine must be able to hold it ----------------------

    #[test]
    fn a_tool_the_machine_cannot_hold_is_never_recommended_even_when_ideal() {
        // 🔴 Rule 4. On this machine the 12mm cutter is geometrically ideal for
        // an unconstrained profile - biggest, stiffest, fewest passes - and the
        // shop owns nothing that grips a 12mm shank.
        let lib = default_library();
        let m = Machine { collet_mm: 3.175, spare_collets_mm: vec![], ..Machine::default() };
        let f = Feature::new("outline", FeatureKind::Profile, Contour::rect(0.0, 0.0, 300.0, 200.0), 9.0);
        let r = recommend(&[f], &m, &stock(18.0), Material::Plywood, &lib, &RecommendOptions::default());
        let c = &r.choices[0];

        match rejection_for(c, "End Mill - Up-cut 12mm 2F") {
            RejectReason::MachineCannotHoldIt { why } => {
                assert!(why.contains("12mm shank"), "{why}");
                assert!(why.contains("3.175mm"), "{why}");
            }
            other => panic!("wrong reason: {other:?}"),
        }

        // The property, not the example: NOTHING recommended, and nothing listed
        // as a usable alternative, may be a tool this machine cannot hold.
        let holdable = |id: &String| {
            let t = lib.iter().find(|t| &t.id == id).unwrap();
            shank_fit(t.tool.shank_mm, m.collet_mm, &m.spare_collets_mm).selectable()
        };
        for id in &r.tool_set {
            assert!(holdable(id), "recommended {id}, which this machine cannot hold");
        }
        for id in &c.alternatives {
            assert!(holdable(id), "offered {id} as an alternative, which this machine cannot hold");
        }
        assert!((chosen_diameter(c, &lib) - 3.175).abs() < 1e-9, "{}", c.reason);
    }

    // --- rule 5: material caps rpm and depth per pass ---------------------

    /// ⚠ **CORRECTED, NOT WEAKENED, when the feed ceiling started holding the
    /// chip.** This test used to run on `well_stocked_machine()` and assert
    /// `alu.rpm < ply.rpm` outright. That premise silently depended on the
    /// machine's feed ceiling never binding: on the ⌀12 this test's fixture
    /// actually selects, plywood's 24,000rpm now comes DOWN to 10,000 to stay
    /// under the default 6,000mm/min ceiling, so plywood runs **slower** than
    /// aluminium's 12,000 and the old assertion went red for a correct program.
    ///
    /// 🔴 The rule it was written to guard is still real, so it is asserted on a
    /// machine where **only the material can be the cause** — and the ceiling
    /// case is asserted separately below rather than deleted from view. Merging
    /// them was what made the original test able to fail for a reason it was not
    /// about.
    #[test]
    fn material_caps_rpm_and_depth_per_pass() {
        let lib = default_library();
        // A ceiling high enough that nothing here can bind on it: whatever
        // differs between the two runs is the MATERIAL.
        let m = Machine { max_feed_mm_min: 60_000.0, ..well_stocked_machine() };
        let f = || Feature::new("outline", FeatureKind::Profile, Contour::rect(0.0, 0.0, 300.0, 200.0), 9.0);

        let ply = recommend(&[f()], &m, &stock(18.0), Material::Plywood, &lib, &RecommendOptions::default());
        let alu = recommend(&[f()], &m, &stock(18.0), Material::Aluminium, &lib, &RecommendOptions::default());

        let lp = ply.choices[0].limits.unwrap();
        let la = alu.choices[0].limits.unwrap();
        assert!(lp.rpm <= Material::Plywood.max_rpm());
        assert!(la.rpm <= Material::Aluminium.max_rpm(), "{la:?}");
        assert!(la.rpm < lp.rpm, "aluminium did not cap rpm: {la:?} vs {lp:?}");
        assert!(la.depth_per_pass_mm < lp.depth_per_pass_mm, "{la:?} vs {lp:?}");
        assert!(la.passes > lp.passes, "{la:?} vs {lp:?}");
        assert!(ply.choices[0].reason.contains("Plywood"), "{}", ply.choices[0].reason);
    }

    /// 🔴 The half the correction above moved out: **the machine's feed ceiling
    /// can bind harder than the material's rpm cap, and when it does the
    /// spindle — not the chip — is what comes down.**
    ///
    /// This is the ⌀12 case from `docs/materials-research.md` §4.1, asserted at
    /// the numbers the planner hands to the emitted program. Before this change
    /// the same setup produced `S24000 F6000` = 0.125mm/tooth against that
    /// cutter's own declared minimum of 0.150.
    #[test]
    fn the_feed_ceiling_takes_the_spindle_down_rather_than_the_chip() {
        let lib = only("End Mill - Up-cut 12mm 2F");
        let m = Machine { collet_mm: 12.0, ..Machine::default() };
        assert_eq!(m.max_feed_mm_min, 6_000.0, "this test is about the core's own default ceiling");

        let r = recommend(
            &[profile(18.0)],
            &m,
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let l = r.choices[0].limits.expect("the ⌀12 is holdable on a 12mm collet");

        // The pair the program will carry.
        assert!((l.rpm - 10_000.0).abs() < 1e-9, "{l:?}");
        assert!((l.feed_mm_min - 6_000.0).abs() < 1e-9, "{l:?}");
        // 🔴 And the assertion that is actually about the physics: the chip the
        // pair DELIVERS is the one the cutter is rated for.
        let t = &lib[0].tool;
        assert!(
            crate::feeds::chipload_in_window(t, l.rpm, l.feed_mm_min),
            "{:?}",
            crate::feeds::chip_verdict(t, l.rpm, l.feed_mm_min)
        );
        assert!(
            (crate::feeds::chipload_from_feed(t, l.rpm, l.feed_mm_min) - 0.30).abs() < 1e-9,
            "the chip moved off the tool's nominal"
        );
        // The negative control for the whole change: the naive clamp, on the
        // same tool at the same ceiling, is OUT of window. Without this the test
        // above passes on a rule that never had anything to catch.
        assert!(
            !crate::feeds::chipload_in_window(t, 24_000.0, 6_000.0),
            "the pre-change pairing is no longer out of window, so this fixture proves nothing"
        );
        // ...and the operator is told, in the core's own sentence.
        assert!(
            r.choices[0].notes.iter().any(|n| n.contains("SPINDLE came down")),
            "{:?}",
            r.choices[0].notes
        );
    }

    /// 🔴 THE REFUSAL. Drop the ceiling far enough and there is no speed that
    /// both runs and holds the chip — and no number is invented.
    #[test]
    fn a_feed_ceiling_the_rpm_floor_cannot_meet_is_refused_and_not_approximated() {
        let lib = only("End Mill - Down-cut 6mm 2F");
        // 900mm/min on a ⌀6 2F at 0.10mm/tooth needs 4,500rpm; the tool's own
        // floor is 8,000 and the spindle's is 6,000.
        let m = Machine { max_feed_mm_min: 900.0, ..well_stocked_machine() };
        let r = recommend(
            &[profile(9.0)],
            &m,
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        assert!(c.tool_id.is_none(), "a cutter that cannot be run in-window was still chosen");
        match rejection_for(c, "End Mill - Down-cut 6mm 2F") {
            RejectReason::NoSpeedHoldsTheChip { rpm_required, rpm_floor, .. } => {
                assert!((*rpm_required - 4_500.0).abs() < 1e-9, "{rpm_required}");
                assert!((*rpm_floor - 8_000.0).abs() < 1e-9, "{rpm_floor}");
            }
            other => panic!("refused for the wrong reason: {other:?}"),
        }
        // The sentence has to be actable: both numbers, and the reason it is a
        // refusal rather than a quieter program.
        let why = rejection_for(c, "End Mill - Down-cut 6mm 2F").why();
        assert!(why.contains("4500rpm") && why.contains("8000rpm"), "{why}");

        // 🔴 THE NEGATIVE CONTROL. The same cutter, the same material, an
        // ordinary ceiling — chosen, not refused. Without this the rule above is
        // indistinguishable from one that refuses everything.
        let ok = recommend(
            &[profile(9.0)],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        assert_eq!(ok.choices[0].tool_id.as_deref(), Some("End Mill - Down-cut 6mm 2F"));
    }

    /// A chip driven below the cutter's window by the MATERIAL factor rather
    /// than by the machine is a note, not a refusal — and the note says which of
    /// the two put it there.
    ///
    /// ⚠ Deliberately not a refusal: every chipload window in
    /// `default_library()` bar one is unsourced (`docs/materials-research.md`
    /// §3.2), so a red here would rest on the same sand as the green it
    /// replaced. The refusal above does not depend on the window being right —
    /// it depends on an rpm that does not exist.
    #[test]
    fn a_material_factor_that_thins_the_chip_below_the_window_is_said_out_loud() {
        let lib = only("End Mill - Down-cut 6mm 2F");
        // Aluminium: 0.10 nominal x 0.35 = 0.035mm/tooth, under the ⌀6's own
        // declared minimum of 0.05. Nothing clamps here — 12,000 x 2 x 0.035 =
        // 840mm/min, far under any ceiling.
        let r = recommend(
            &[profile(9.0)],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Aluminium,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        assert!(c.tool_id.is_some(), "an out-of-window chip must not refuse the tool");
        let l = c.limits.unwrap();
        assert!(
            matches!(
                crate::feeds::chip_verdict(&lib[0].tool, l.rpm, l.feed_mm_min),
                crate::feeds::ChipVerdict::Below { .. }
            ),
            "the fixture no longer produces an under-chipped cut, so this test proves nothing"
        );
        assert!(c.notes.iter().any(|n| n.contains("rubs")), "{:?}", c.notes);
        assert!(
            c.notes.iter().any(|n| n.contains("Aluminium multiplier")),
            "the note must name the material as the cause, not the machine: {:?}",
            c.notes
        );

        // The negative control: the same cutter in plywood is IN window and says
        // nothing at all.
        let ply = recommend(
            &[profile(9.0)],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        assert!(
            !ply.choices[0].notes.iter().any(|n| n.contains("rubs")),
            "{:?}",
            ply.choices[0].notes
        );
    }

    // --- the drill, run on a model it is not rated in ---------------------

    /// 🔴 THE ⌀6 BRAD POINT, MEASURED 2026-08-10: `M3 S24000` and
    /// `G98 G83 … F5760.0`. The numbers are still emitted — refusing here would
    /// take `job.rs`, gate `REL` and the reference fixtures with it, and that is
    /// another lane's change — but the sentence beside them no longer asserts
    /// that a material recommends them for a drill.
    ///
    /// This asserts on `limits`, which `core/src/job.rs` copies verbatim into
    /// `op.params.rpm` / `feed_mm_min`, so it is the pair that reaches the `S`
    /// and `F` words.
    #[test]
    fn a_drill_still_gets_the_router_numbers_and_is_no_longer_told_they_are_right() {
        let lib = only("Drill - Brad Point 6mm 2F");
        let f = Feature::classify("hole", Contour::circle(60.0, 60.0, 3.0), 18.0);
        let r = recommend(
            &[f],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        let l = c.limits.expect("the drill is still planned");

        // The measured emission, unchanged — this is a naming change, not a
        // numbers change, and saying so is the point.
        assert!((l.rpm - 24_000.0).abs() < 1e-9, "{l:?}");
        assert!((l.feed_mm_min - 5_760.0).abs() < 1e-9, "{l:?}");

        // 🔴 The sentence that used to read "Plywood caps it at 24000rpm … so 6
        // pass(es) at 5760mm/min" — a recommendation — must no longer make that
        // claim for a drill.
        assert!(
            !c.reason.contains("Plywood caps it at"),
            "the drill is still being told the material recommends this speed: {}",
            c.reason
        );
        assert!(c.reason.contains("NO DRILL SPEED OR FEED HAS BEEN DECLARED"), "{}", c.reason);
        // ...and the numbers still travel, because an operator needs to know
        // what the program will actually do.
        assert!(c.reason.contains("24000rpm") && c.reason.contains("5760mm/min"), "{}", c.reason);

        // The note carries the model the figure would have to be compared in.
        assert!(
            c.notes.iter().any(|n| n.contains("0.240mm per revolution")),
            "{:?}",
            c.notes
        );
        assert!(
            c.notes.iter().any(|n| n.contains("FEED PER REVOLUTION")),
            "{:?}",
            c.notes
        );
    }

    /// The negative control for the sentence above: an END MILL is rated in the
    /// model this crate uses, so it keeps the material's recommendation
    /// verbatim. Without this, the drill assertion is satisfied by a change that
    /// simply stopped anything ever saying "caps it at".
    #[test]
    fn a_router_cutter_keeps_the_materials_recommendation_word_for_word() {
        let lib = only("End Mill - Down-cut 6mm 2F");
        let r = recommend(
            &[profile(9.0)],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        assert!(c.reason.contains("Plywood caps it at"), "{}", c.reason);
        assert!(!c.reason.contains("NO DRILL SPEED"), "{}", c.reason);
        assert!(!c.notes.iter().any(|n| n.contains("ROUTER-BIT NUMBERS")), "{:?}", c.notes);
    }

    // --- #38 §A3: the compression cutter the depth cap turns into an up-cut ---

    /// The library reduced to ONE tool, on purpose. Choosing the compression
    /// cutter by sort order would make these tests assertions about
    /// `cmp_candidate`, and a later tie-break change would silently retire
    /// them.
    fn only(id: &str) -> Vec<ToolSpec> {
        let lib: Vec<ToolSpec> = default_library().into_iter().filter(|t| t.id == id).collect();
        assert_eq!(lib.len(), 1, "the library no longer contains exactly one {id}");
        lib
    }

    const COMPRESSION: &str = "End Mill - Compression 6mm 2F";
    const UPCUT: &str = "End Mill - Up-cut 6mm 2F";

    fn profile(depth_mm: f64) -> Feature {
        Feature::new("outline", FeatureKind::Profile, Contour::rect(0.0, 0.0, 300.0, 200.0), depth_mm)
    }

    fn notes_of(lib: &[ToolSpec], depth_mm: f64) -> (Vec<String>, CutLimits) {
        let r = recommend(
            &[profile(depth_mm)],
            &well_stocked_machine(),
            &stock(depth_mm.max(18.0)),
            Material::Plywood,
            lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        (c.notes.clone(), c.limits.expect("a tool was expected"))
    }

    #[test]
    fn a_compression_tool_forced_into_more_than_one_pass_says_the_top_veneer_will_tear() {
        // 🔴 This is the defect the DEPTH CAP CREATES, which is why the warning
        // and the cap are one change. At 0.50xD an 18mm through-cut is 6 passes
        // with a 6mm cutter, so the up-cut section never spans the workpiece and the
        // tool is an up-cut from pass 2 down — a torn top face, with every gate
        // green and a correct-looking preview.
        let (notes, limits) = notes_of(&only(COMPRESSION), 18.0);
        assert!(limits.passes > 1, "fixture is wrong — one pass proves nothing: {limits:?}");

        let warn = notes
            .iter()
            .find(|n| n.contains("COMPRESSION"))
            .unwrap_or_else(|| panic!("no compression warning in {notes:?}"));
        // The wording has to name the PHYSICAL consequence, not the pass count.
        // "runs in more than one pass" is a fact about the plan; "tears the top
        // veneer" is the thing that arrives on the operator's bench.
        assert!(warn.contains("TEARS OUT THE TOP VENEER"), "{warn}");
        assert!(warn.contains("UP-CUT"), "{warn}");
        assert!(warn.contains(&format!("{} passes", limits.passes)), "{warn}");
    }

    #[test]
    fn the_same_compression_tool_in_one_pass_is_silent() {
        // Negative control 1. Without this, a warning hard-coded to fire on
        // every compression tool would pass the test above — and would then be
        // noise on the one job where the cutter is doing exactly what it is
        // for.
        let (notes, limits) = notes_of(&only(COMPRESSION), 2.5);
        assert_eq!(limits.passes, 1, "fixture is wrong: {limits:?}");
        assert!(
            !notes.iter().any(|n| n.contains("COMPRESSION")),
            "warned about a compression cutter doing its job in one pass: {notes:?}"
        );
    }

    #[test]
    fn an_up_cut_tool_in_six_passes_is_silent() {
        // Negative control 2. Same geometry, same depth, same pass count — only
        // the flute type differs. An up-cut is ALREADY an up-cut; there is no
        // down-shear section for the pass depth to strand, so there is nothing
        // to warn about and warning anyway would train the operator to ignore
        // the message.
        let (up_notes, up_limits) = notes_of(&only(UPCUT), 18.0);
        let (comp_notes, comp_limits) = notes_of(&only(COMPRESSION), 18.0);
        assert_eq!(up_limits.passes, comp_limits.passes, "the controls must differ only in flute type");
        assert!(up_limits.passes > 1, "{up_limits:?}");
        assert!(
            !up_notes.iter().any(|n| n.contains("COMPRESSION")),
            "warned about an up-cut: {up_notes:?}"
        );
        assert!(comp_notes.iter().any(|n| n.contains("COMPRESSION")), "{comp_notes:?}");
    }

    #[test]
    fn a_second_note_on_the_same_candidate_does_not_evict_the_first() {
        // 🔴 The reason `Candidate::notes` is a Vec. A 6mm compression cutter
        // boring a 6mm hole earns BOTH notes — a full-width plunge on the tool
        // tip, and a veneer that will tear — and the old `Option<String>` would
        // have shown whichever was written last, with no sign the other
        // existed.
        let r = recommend(
            &[Feature::classify("bore", Contour::circle(0.0, 0.0, 3.0), 18.0)],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &only(COMPRESSION),
            &RecommendOptions::default(),
        );
        let notes = &r.choices[0].notes;
        assert!(notes.iter().any(|n| n.contains("PLUNGE and not an")), "{notes:?}");
        assert!(notes.iter().any(|n| n.contains("TEARS OUT THE TOP VENEER")), "{notes:?}");
    }

    // --- rule 6: prefer fewer distinct tools ------------------------------

    #[test]
    fn preferring_a_tool_already_in_the_job_actually_reduces_the_tool_count() {
        // Two pockets. Alone, the second wants a 12mm cutter (bigger, fewer
        // passes). The first cannot take one - its 3mm internal radius caps at
        // 6mm. Rule 6 says the second takes the 6mm too.
        let lib = default_library();
        let m = well_stocked_machine();
        let mk = |id: &str, r: f64| {
            let mut c = Contour::rounded_rect(0.0, 0.0, 200.0, 120.0, r);
            c.normalise_winding(false);
            Feature::new(id, FeatureKind::Pocket, c, 9.0)
        };
        let feats = vec![mk("tight", 3.0), mk("loose", 6.0)];

        let off = recommend(
            &feats,
            &m,
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions { prefer_fewer_tool_changes: false, ..Default::default() },
        );
        let on = recommend(
            &feats,
            &m,
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );

        // The negative control: with the preference off the answers genuinely
        // differ, so the preference is doing work rather than agreeing with a
        // choice that was already the same.
        assert_eq!(off.tool_set.len(), 2, "{:?}", off.tool_set);
        assert_eq!(off.tool_changes(), 1);
        assert!((chosen_diameter(&off.choices[1], &lib) - 12.0).abs() < 1e-9);

        assert_eq!(on.tool_set.len(), 1, "{:?}", on.tool_set);
        assert_eq!(on.tool_changes(), 0);
        assert_eq!(on.choices[0].tool_id, on.choices[1].tool_id);
        assert!(
            on.choices[1].reason.contains("ALREADY IN THIS JOB"),
            "the reuse must SAY it is reuse: {}",
            on.choices[1].reason
        );
        // Reuse is a preference, never a rule breaker: the tool it reused had to
        // be a legal candidate for the second pocket on its own merits.
        assert!(chosen_diameter(&on.choices[1], &lib) <= 12.0);
    }

    // --- the no-answer ----------------------------------------------------

    #[test]
    fn no_tool_in_the_library_can_cut_this_and_it_says_so_instead_of_guessing() {
        // 0.5mm internal radius caps the cutter at 1mm diameter. The smallest
        // milling cutter in the library is 3mm. There is no plausible fallback
        // and none is offered.
        let lib = default_library();
        let pocket = {
            let mut c = Contour::rounded_rect(0.0, 0.0, 40.0, 40.0, 0.5);
            c.normalise_winding(false);
            c
        };
        let f = Feature::new("fine-pocket", FeatureKind::Pocket, pocket, 9.0);
        let r = recommend(
            &[f],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];

        assert!(c.tool_id.is_none(), "picked {:?} for an uncuttable feature", c.tool_id);
        assert!(!c.is_satisfied());
        assert!(c.alternatives.is_empty(), "offered alternatives for a feature nothing can cut");
        assert!(r.tool_set.is_empty());
        assert!(!r.is_complete());
        assert_eq!(r.unsatisfied, vec!["fine-pocket".to_string()]);
        assert!(c.reason.contains("NO TOOL IN THIS LIBRARY"), "{}", c.reason);
        // And the reason it could not is per-tool, not a shrug.
        assert!(matches!(
            rejection_for(c, "End Mill - Down-cut 3.175mm 2F"),
            RejectReason::InternalRadiusTooSmall { .. }
        ));
    }

    // --- the shape of the output -----------------------------------------

    #[test]
    fn every_choice_carries_a_reason_and_every_rejection_carries_one_too() {
        // The output contract the UI depends on. A blank reason is a decision
        // with no visible basis, which is the thing this module exists to stop.
        let lib = default_library();
        let part = Part::new("plate", Contour::rect(0.0, 0.0, 300.0, 200.0))
            .with_hole(Contour::circle(60.0, 60.0, 3.0))
            .with_hole(Contour::rounded_rect(120.0, 40.0, 60.0, 40.0, 5.0));
        let r = recommend_for_part(&part, &well_stocked_machine(), &stock(12.0), Material::Plywood, &lib);

        assert_eq!(r.choices.len(), 3);
        assert_eq!(r.choices[1].kind, FeatureKind::Hole { diameter_mm: 6.0 });
        assert_eq!(r.choices[2].kind, FeatureKind::Pocket);
        for c in &r.choices {
            assert!(!c.reason.trim().is_empty(), "{} has no reason", c.feature_id);
            assert!(!c.rejected.is_empty(), "{} rejected nothing at all", c.feature_id);
            for rj in &c.rejected {
                assert!(!rj.reason.why().trim().is_empty(), "{} gave a blank reason", rj.tool_id);
                assert!(rj.sentence().starts_with(&rj.tool_id));
            }
            if let Some(id) = &c.tool_id {
                assert!(c.reason.starts_with(id.as_str()), "{}", c.reason);
                assert!(c.limits.is_some() && c.shank_fit.is_some());
                assert!(!c.alternatives.contains(id), "the chosen tool is also listed as its own alternative");
            }
        }
        assert_eq!(r.tool_changes(), r.tool_set.len() - 1);
    }

    #[test]
    fn an_undeclared_collet_is_carried_as_unchecked_and_never_as_verified() {
        // Mirrors tools.rs: `Undeclared` is selectable, and saying so is not the
        // same as saying it passed.
        let lib = default_library();
        let m = Machine { collet_mm: 0.0, spare_collets_mm: vec![], ..Machine::default() };
        let f = Feature::new("outline", FeatureKind::Profile, Contour::rect(0.0, 0.0, 300.0, 200.0), 9.0);
        let r = recommend(&[f], &m, &stock(18.0), Material::Plywood, &lib, &RecommendOptions::default());
        let c = &r.choices[0];
        assert_eq!(c.shank_fit, Some(ShankFit::Undeclared));
        assert!(c.notes.iter().any(|n| n.contains("UNCHECKED")), "{:?}", c.notes);
        assert!(c.reason.contains("UNCHECKED"), "{}", c.reason);
    }

    #[test]
    fn a_cutter_wider_than_the_pocket_is_refused_even_with_no_arcs_to_cap_it() {
        // The gap curvature cannot see: a square-cornered 4mm slot has no
        // internal radius at all, and a 6mm cutter does not go in it.
        let lib = default_library();
        let slot = {
            let mut c = Contour::rect(0.0, 0.0, 60.0, 4.0);
            c.normalise_winding(false);
            c
        };
        let f = Feature::new("slot", FeatureKind::Pocket, slot, 9.0);
        let r = recommend(
            &[f],
            &well_stocked_machine(),
            &stock(18.0),
            Material::Plywood,
            &lib,
            &RecommendOptions::default(),
        );
        let c = &r.choices[0];
        assert_eq!(c.geometry.min_internal_radius_mm, None, "no arcs, so nothing to cap");
        assert!(matches!(
            rejection_for(c, "End Mill - Down-cut 6mm 2F"),
            RejectReason::WillNotFitInside { .. }
        ));
        // The property: nothing WIDER than the slot. A cutter exactly the slot
        // width is a full-width slotting cut and is not asserted either way.
        assert!(chosen_diameter(c, &lib) <= 4.0 + 1e-9, "{}", c.reason);
    }

    #[test]
    fn an_angular_tool_is_never_offered_for_a_vertical_wall() {
        // A V-bit's width is a function of depth, so it cannot hold a wall
        // vertical - and a countersink is not a way to make a hole.
        let lib = default_library();
        let part = Part::new("plate", Contour::rect(0.0, 0.0, 300.0, 200.0))
            .with_hole(Contour::circle(60.0, 60.0, 3.15));
        let r = recommend_for_part(&part, &well_stocked_machine(), &stock(12.0), Material::Plywood, &lib);
        for c in &r.choices {
            for id in c.alternatives.iter().chain(c.tool_id.iter()) {
                let t = lib.iter().find(|t| &t.id == id).unwrap();
                assert!(!t.category().is_angular(), "{id} offered for {}", c.feature_id);
            }
        }
        assert!(matches!(
            rejection_for(&r.choices[1], "Countersink 6.3mm 3F"),
            RejectReason::WrongCategory { .. }
        ));
    }

    #[test]
    fn the_engine_is_pure_and_gives_the_same_answer_twice() {
        // Determinism matters here for a specific reason: the tie-break is
        // arbitrary by design, so it has to be arbitrary the SAME way every run
        // or a golden file starts flapping.
        let lib = default_library();
        let part = Part::new("plate", Contour::rect(0.0, 0.0, 300.0, 200.0))
            .with_hole(Contour::circle(60.0, 60.0, 4.0));
        let m = well_stocked_machine();
        let a = recommend_for_part(&part, &m, &stock(12.0), Material::Plywood, &lib);
        let b = recommend_for_part(&part, &m, &stock(12.0), Material::Plywood, &lib);
        assert_eq!(a.tool_set, b.tool_set);
        for (x, y) in a.choices.iter().zip(b.choices.iter()) {
            assert_eq!(x.tool_id, y.tool_id);
            assert_eq!(x.reason, y.reason);
            assert_eq!(x.alternatives, y.alternatives);
        }
    }
}

// ===========================================================================
//  Tests — the per-TOOL verdicts
// ===========================================================================

#[cfg(test)]
mod tool_verdict_tests {
    use super::*;
    use crate::fixtures::JobConfig;
    use crate::tools::default_library;

    /// A tool whose flute is 12mm — shorter than an 18mm workpiece, which is the
    /// case the planner refuses the whole job over.
    const SHORT: &str = "End Mill - Down-cut 3.175mm 2F";
    /// A 12mm shank, which a 6mm collet and no spares cannot hold.
    const FAT_SHANK: &str = "End Mill - Up-cut 12mm 2F";

    fn cfg(json: &str) -> JobConfig {
        serde_json::from_str(json).expect("the test config is not valid JobConfig JSON")
    }

    /// A complete, ordinary setup: 18mm ply, a machine with the whole collet
    /// drawer. Nothing here is UNKNOWN, so a test about a refusal is not
    /// accidentally a test about an undeclared field.
    fn full_setup() -> Setup {
        Setup::from_job_config(&cfg(
            r#"{"machine":{"collet_mm":6.0,"spare_collets_mm":[3.175,4.0,8.0,10.0]},
                "stock":{"thickness_mm":18.0},
                "material":"Plywood"}"#,
        ))
    }

    fn plate() -> Part {
        Part::new("plate", Contour::rect(0.0, 0.0, 300.0, 200.0))
    }

    fn verdict<'a>(v: &'a [ToolVerdict], id: &str) -> &'a ToolVerdict {
        v.iter()
            .find(|t| t.tool_id == id)
            .unwrap_or_else(|| panic!("{id} is not in the verdict list at all"))
    }

    fn rule<'a>(v: &'a ToolVerdict, name: &str) -> &'a RuleOutcome {
        &v.rules
            .iter()
            .find(|r| r.rule == name)
            .unwrap_or_else(|| panic!("no `{name}` rule on {}", v.tool_id))
            .outcome
    }

    // --- the config crossing into a setup ---------------------------------

    #[test]
    fn machine_fields_are_carried() {
        // 🔴 The guard on `Setup::from_job_config`'s documented hazard: only the
        // fields a rule reads are copied, so a field that silently stops
        // arriving would judge every tool against `Machine::default()` while
        // looking exactly as confident.
        let s = Setup::from_job_config(&cfg(
            r#"{"machine":{"collet_mm":6.35,"spare_collets_mm":[3.175],
                 "spindle_min_rpm":8000.0,"spindle_max_rpm":18000.0,"max_feed_mm_min":4200.0},
                "stock":{"thickness_mm":12.0},"material":"MDF"}"#,
        ));
        let m = s.machine.as_ref().expect("a machine was declared");
        assert_eq!(m.collet_mm, 6.35);
        assert_eq!(m.spare_collets_mm, vec![3.175]);
        assert_eq!(m.spindle_min_rpm, 8000.0);
        assert_eq!(m.spindle_max_rpm, 18000.0);
        assert_eq!(m.max_feed_mm_min, 4200.0);
        assert_eq!(s.stock_thickness_mm, Some(12.0));
        assert_eq!(s.material, Some(Material::Mdf));
        // And the negative control: none of these came from a default that
        // happens to match.
        let d = Machine::default();
        assert_ne!(m.collet_mm, d.collet_mm);
        assert_ne!(m.spindle_max_rpm, d.spindle_max_rpm);
    }

    #[test]
    fn an_unrecognised_material_leaves_the_rule_unchecked_and_says_so() {
        // Never plywood-by-default. `"Aluminium "` with a stray space fed as
        // plywood is three times too fast, which is the defect `apply` refuses
        // in the same direction.
        let s = Setup::from_job_config(&cfg(
            r#"{"machine":{"collet_mm":6.0},"stock":{"thickness_mm":18.0},"material":"Unobtainium"}"#,
        ));
        assert_eq!(s.material, None);
        assert!(s.notes.iter().any(|n| n.contains("Unobtainium")), "{:?}", s.notes);
        let v = tool_verdicts(&default_library(), &s, &[]);
        let t = verdict(&v, "End Mill - Down-cut 6mm 2F");
        assert!(matches!(rule(t, "spindle-rpm"), RuleOutcome::Unchecked(_)), "{:?}", t.rules);
        assert_eq!(t.usability, Usability::Unknown);
    }

    // --- verdict A: what invalidates the job ------------------------------

    #[test]
    fn a_flute_shorter_than_the_sheet_invalidates_the_job_in_the_planners_own_words() {
        // 🔴 THE AGREEMENT THAT MATTERS. `plan_report_import_many` refuses the
        // whole job with `reach_rejection(&tool, stock.thickness_mm)`; this
        // asserts the list's red mark is that same predicate producing that same
        // sentence, rather than a second rule that happens to agree today.
        let lib = default_library();
        let v = tool_verdicts(&lib, &full_setup(), &[]);
        let t = verdict(&v, SHORT);

        assert_eq!(t.usability, Usability::Invalidates, "{}", t.why);
        match rule(t, "reach") {
            RuleOutcome::Refused(RejectReason::TooShortToReach { cutting_length_mm, depth_mm }) => {
                assert!((*cutting_length_mm - 12.0).abs() < 1e-9);
                assert!((*depth_mm - 18.0).abs() < 1e-9);
            }
            other => panic!("the reach rule said {other:?}"),
        }
        // Byte-for-byte the planner's sentence, from the shared predicate.
        let spec = lib.iter().find(|s| s.id == SHORT).unwrap();
        let planner = reach_rejection(&spec.tool, 18.0).expect("the planner refuses this tool");
        assert_eq!(t.why, planner.why());
        assert!(t.why.contains("the shank would be in the cut"), "{}", t.why);
    }

    #[test]
    fn a_shank_no_collet_holds_invalidates_the_job_and_names_the_collets_the_shop_has() {
        let s = Setup::from_job_config(&cfg(
            r#"{"machine":{"collet_mm":6.0,"spare_collets_mm":[]},
                "stock":{"thickness_mm":18.0},"material":"Plywood"}"#,
        ));
        let v = tool_verdicts(&default_library(), &s, &[]);
        let t = verdict(&v, FAT_SHANK);
        assert_eq!(t.usability, Usability::Invalidates, "{}", t.why);
        assert!(matches!(rule(t, "collet"), RuleOutcome::Refused(_)), "{:?}", t.rules);
        // The reason has to name the shop's collets, or a wrong tool and a
        // wrongly-set-up machine look identical.
        assert!(t.why.contains("12mm shank"), "{}", t.why);
        assert!(t.why.contains("6mm"), "{}", t.why);
        // And the same tool with the collet in the drawer is NOT marked — the
        // negative control, without which this test passes on a rule that
        // refuses everything.
        let stocked = Setup::from_job_config(&cfg(
            r#"{"machine":{"collet_mm":6.0,"spare_collets_mm":[12.0]},
                "stock":{"thickness_mm":18.0},"material":"Plywood"}"#,
        ));
        let ok = tool_verdicts(&default_library(), &stocked, &[]);
        assert_eq!(verdict(&ok, FAT_SHANK).usability, Usability::Usable);
    }

    #[test]
    fn an_ordinary_cutter_on_an_ordinary_setup_is_not_marked() {
        // The negative control for the whole red mark: if this ever goes
        // `Invalidates`, the list is refusing work the machine can do, and an
        // operator who is refused work they can do learns to ignore the colour.
        let v = tool_verdicts(&default_library(), &full_setup(), &[]);
        let t = verdict(&v, "End Mill - Down-cut 6mm 2F");
        assert_eq!(t.usability, Usability::Usable, "{}", t.why);
        assert_eq!(t.why, "", "a usable tool carries no refusal sentence: {}", t.why);
        assert!(t.rules.iter().all(|r| r.outcome == RuleOutcome::Passed), "{:?}", t.rules);
    }

    // --- the third state --------------------------------------------------

    #[test]
    fn no_sheet_declared_makes_reach_unknown_and_the_tool_is_not_usable() {
        // 🔴 The rule this lane runs on: a check that cannot run reports
        // PENDING, never PASS. `Stock::default()` is 18mm and judging against
        // it here would be a confident verdict about a workpiece nobody chose.
        let s = Setup::from_job_config(&cfg(
            r#"{"machine":{"collet_mm":6.0,"spare_collets_mm":[3.175]},"material":"Plywood"}"#,
        ));
        assert_eq!(s.stock_thickness_mm, None);
        let v = tool_verdicts(&default_library(), &s, &[]);
        let t = verdict(&v, SHORT);
        assert!(matches!(rule(t, "reach"), RuleOutcome::Unchecked(_)), "{:?}", t.rules);
        assert_eq!(t.usability, Usability::Unknown, "{}", t.why);
        assert_ne!(t.usability, Usability::Usable);
        assert!(t.why.contains("UNCHECKED"), "{}", t.why);
    }

    #[test]
    fn an_undeclared_collet_is_unknown_rather_than_held() {
        // `ShankFit::Undeclared` is the core's own third state and it crosses
        // unflattened. A machine with no collet declared must not read as a
        // machine that can hold everything.
        let s = Setup::from_job_config(&cfg(
            r#"{"machine":{"travel_x_mm":600.0},"stock":{"thickness_mm":18.0},"material":"Plywood"}"#,
        ));
        let v = tool_verdicts(&default_library(), &s, &[]);
        let t = verdict(&v, "End Mill - Down-cut 6mm 2F");
        assert!(matches!(rule(t, "collet"), RuleOutcome::Unchecked(_)), "{:?}", t.rules);
        assert_eq!(t.usability, Usability::Unknown);
    }

    #[test]
    fn no_machine_at_all_leaves_both_machine_rules_unchecked() {
        let s = Setup::from_job_config(&cfg(r#"{"stock":{"thickness_mm":18.0},"material":"Plywood"}"#));
        assert!(s.machine.is_none());
        let v = tool_verdicts(&default_library(), &s, &[]);
        let t = verdict(&v, "End Mill - Down-cut 6mm 2F");
        assert!(matches!(rule(t, "collet"), RuleOutcome::Unchecked(_)));
        assert!(matches!(rule(t, "spindle-rpm"), RuleOutcome::Unchecked(_)));
        // But the rule that CAN run still ran — an unknown verdict is not an
        // excuse to stop checking.
        assert_eq!(*rule(t, "reach"), RuleOutcome::Passed);
        assert_eq!(t.usability, Usability::Unknown);
    }

    #[test]
    fn a_refusal_beats_an_unchecked_rule() {
        // Order matters and it is the safe direction: a tool with one broken
        // rule and one unrun rule is REFUSED, not merely unjudged.
        let s = Setup::from_job_config(&cfg(r#"{"stock":{"thickness_mm":18.0}}"#));
        let v = tool_verdicts(&default_library(), &s, &[]);
        let t = verdict(&v, SHORT);
        assert!(matches!(rule(t, "collet"), RuleOutcome::Unchecked(_)));
        assert!(matches!(rule(t, "reach"), RuleOutcome::Refused(_)));
        assert_eq!(t.usability, Usability::Invalidates, "{}", t.why);
    }

    // --- verdict B: the recommendation, and that it is a DIFFERENT answer ---

    #[test]
    fn no_drawing_means_the_advice_is_unknown_and_not_not_recommended() {
        let v = tool_verdicts(&default_library(), &full_setup(), &[]);
        assert!(
            v.iter().all(|t| t.advice == Advice::Unknown),
            "a tool was advised on with no drawing loaded"
        );
        // And the usability half still answered — the two are independent.
        assert!(v.iter().any(|t| t.usability == Usability::Usable));
    }

    #[test]
    fn recommended_and_merely_usable_are_different_answers_on_the_same_drawing() {
        // 🔴 The founder's two questions, in one assertion. Both cutters are
        // perfectly usable in this setup; only one is what the recommender
        // chose. Collapsing these into one boolean tells the operator a
        // preference is a refusal.
        let lib = default_library();
        let s = full_setup();
        let v = tool_verdicts(&lib, &s, &[plate()]);

        let recommended: Vec<&ToolVerdict> =
            v.iter().filter(|t| t.advice == Advice::Recommended).collect();
        assert!(!recommended.is_empty(), "nothing was recommended for a plain rectangle");
        for t in &recommended {
            assert!(!t.recommended_for.is_empty());
            // The recommender's own sentence, not a summary of it.
            assert!(t.why_advice.contains(&t.tool_id), "{}", t.why_advice);
            assert!(t.why_advice.contains("cutting length"), "{}", t.why_advice);
        }

        let also_usable: Vec<&ToolVerdict> =
            v.iter().filter(|t| t.advice == Advice::Usable).collect();
        assert!(
            !also_usable.is_empty(),
            "every tool was either recommended or refused — this fixture cannot show that a \
             preference and a refusal are different things"
        );
        for t in &also_usable {
            // The whole point: valid here, and not the pick.
            assert_eq!(t.usability, Usability::Usable, "{}", t.why);
            assert_ne!(t.advice, Advice::Recommended);
            assert!(!t.usable_for.is_empty());
        }
    }

    #[test]
    fn the_advice_is_read_out_of_the_recommender_and_never_re_derived() {
        // The property, not an example: for every feature of this drawing, the
        // tool the recommender chose is the tool whose verdict says
        // `recommended_for` that feature. If these two ever drift, the list is
        // advising on a run of its own.
        let lib = default_library();
        let s = full_setup();
        let part = plate().with_hole(Contour::circle(60.0, 60.0, 3.0));
        let v = tool_verdicts(&lib, &s, &[part.clone()]);

        let stock = Stock { thickness_mm: 18.0, ..Stock::default() };
        let rec = recommend_for_part(
            &part,
            s.machine.as_ref().unwrap(),
            &stock,
            Material::Plywood,
            &lib,
        );
        assert!(rec.choices.len() >= 2, "fixture needs more than one feature");
        for choice in &rec.choices {
            let id = choice.tool_id.as_ref().expect("every feature here has a tool");
            assert!(
                verdict(&v, id).recommended_for.contains(&choice.feature_id),
                "the recommender chose {id} for {} and the verdict list did not say so",
                choice.feature_id
            );
        }
    }

    #[test]
    fn a_tool_that_invalidates_the_setup_is_also_refused_for_every_feature() {
        // The two answers are separate questions, not contradictory ones: a
        // cutter the workpiece is too thick for cannot be the drawing's answer
        // either, and the reason travels per feature so a UI can say where.
        let v = tool_verdicts(&default_library(), &full_setup(), &[plate()]);
        let t = verdict(&v, SHORT);
        assert_eq!(t.usability, Usability::Invalidates);
        assert_eq!(t.advice, Advice::NotForThisJob);
        assert!(t.recommended_for.is_empty() && t.usable_for.is_empty());
        assert!(
            t.refused_for.iter().any(|f| f.why.contains("cutting length")),
            "{:?}",
            t.refused_for
        );
    }

    /// 🔴 The list and the planner must not disagree. The planner emits a
    /// program for a drill with a warning; the list must therefore say
    /// UNJUDGED, never `usable` — a row that vouches for numbers the planner
    /// refuses to vouch for is the two of them contradicting each other in front
    /// of the operator.
    #[test]
    fn the_tool_list_will_not_vouch_for_a_drill_the_planner_does_not_vouch_for() {
        let lib = default_library();
        let v = tool_verdicts(&lib, &full_setup(), &[]);
        let d = verdict(&v, "Drill - Brad Point 6mm 2F");
        assert!(matches!(rule(d, "drill-feed-model"), RuleOutcome::Unchecked(_)), "{:?}", d.rules);
        assert_eq!(d.usability, Usability::Unknown, "{}", d.why);
        assert_ne!(d.usability, Usability::Usable);
        assert!(d.why.contains("FEED PER REVOLUTION"), "{}", d.why);

        // Every drill, not just the one that happened to be checked.
        for t in &v {
            let spec = lib.iter().find(|s| s.id == t.tool_id).unwrap();
            if spec.category() == ToolCategory::Drill {
                assert_ne!(t.usability, Usability::Usable, "{} reads as vouched-for", t.tool_id);
            }
        }

        // 🔴 THE NEGATIVE CONTROL, and it is the one that matters: an ordinary
        // end mill on the same setup is untouched. A rule that marked everything
        // would be indistinguishable from this one on the assertions above.
        let e = verdict(&v, "End Mill - Down-cut 6mm 2F");
        assert_eq!(*rule(e, "drill-feed-model"), RuleOutcome::Passed);
        assert_eq!(e.usability, Usability::Usable, "{}", e.why);
        assert_eq!(e.why, "");
    }

    // --- the wire ---------------------------------------------------------

    #[test]
    fn the_json_carries_both_verdicts_the_caveats_and_the_setup_it_judged() {
        let json: serde_json::Value = serde_json::from_str(&tool_verdicts_json(
            &default_library(),
            &full_setup(),
            &[plate()],
            &[],
        ))
        .expect("the payload is not JSON");

        assert_eq!(json["ok"], true);
        assert_eq!(json["setup"]["stock_thickness_mm"], 18.0);
        assert_eq!(json["setup"]["material"], "Plywood");
        assert_eq!(json["setup"]["machine_declared"], true);
        assert_eq!(json["setup"]["parts"], 1);
        // The caveats are always present, including when nothing is unknown: a
        // limitation that only appears once it has bitten is one nobody read.
        let caveats = json["caveats"].as_array().expect("no caveats");
        assert!(caveats.iter().any(|c| c.as_str().unwrap().contains("UNKNOWN IS NOT USABLE")));

        let rows = json["verdicts"].as_array().expect("no verdicts");
        assert_eq!(rows.len(), default_library().len());
        const USABILITY: [&str; 3] = ["usable", "invalidates", "unknown"];
        const ADVICE: [&str; 4] = ["recommended", "usable", "not-for-this-job", "unknown"];
        for r in rows {
            assert!(USABILITY.contains(&r["usability"].as_str().unwrap()), "{r}");
            assert!(ADVICE.contains(&r["advice"].as_str().unwrap()), "{r}");
            // Five rules on every row, always — a row that quietly stopped
            // asking one of them would look identical to one that passed it.
            assert_eq!(r["rules"].as_array().unwrap().len(), 5, "{r}");
        }
        let short = rows.iter().find(|r| r["id"] == SHORT).expect("the short cutter is missing");
        assert_eq!(short["usability"], "invalidates");
        assert!(short["why"].as_str().unwrap().contains("shank would be in the cut"));
    }
}

// ===========================================================================
//  Per-DRAWING verdicts — the same shape, asked of the geometry
// ===========================================================================
//
// [`tool_verdicts`] answers *"for this setup, what about THIS cutter"*. A
// DRAWING list needs the same answer about the other half of the job: the
// operator has several drawings on one workpiece and wants to know which of them
// this job can actually be cut from. This section is that, and it is here rather
// than in a host for the reason the tool section already gives — a verdict
// computed beside the list is a second copy of a machining rule in the one place
// no gate can see it.
//
// 🔴 TWO QUESTIONS, TWO ANSWERS, AND THEY ARE NOT ONE BOOLEAN. The split is the
// tool section's, kept deliberately identical so an operator reads one idea
// twice rather than two ideas once:
//
//   * [`Usability`] — *would the planner refuse the job because of this
//     drawing?* No cuttable outline, two names that collide, a part that shares
//     material with another part. This is the RED one, and every one of these
//     rules is a condition `fixtures::plan_report_import_many` refuses on, in
//     that function's own words.
//   * [`DrawingFit`] — *does this drawing belong on the workpiece that is
//     declared?* A drawing hanging off the material is not refused by the
//     planner today; it cuts air, or the work holding, or the spoilboard where
//     no part is. This is the FILTER one — the founder's *"not for this
//     workpiece"*.
//
// 🔴 AND A THIRD STATE, for the same reason and with the same word. A check that
// could not run reports UNKNOWN. No workpiece size declared and the fit rule has
// no rectangle to measure against; no cutter resolved and the pair check has no
// clearance to build. UNKNOWN is not usable and must never be rendered as though
// it were.
//
// # 🔴 What this section deliberately does NOT answer, and why
//
// Each of these is reachable-looking, and answering the easy neighbour of a
// question is the defect this lane finds most often. They are named here rather
// than left to be discovered:
//
//   * **Did the file import, and if not why** — *no closed outline, an entity
//     the importer refused by name, a spline it degraded, an STL section that
//     missed the solid.* Those facts are produced by `fixtures::intake_one`,
//     which is the planner's own door and is not public. This section is handed
//     the parts that came OUT of that door, so it cannot see what happened at
//     it. What it CAN say is the one condition the planner refuses on with a
//     sentence this module can reproduce exactly — a drawing carrying no
//     measurable geometry ([`crate::layout::LayoutError::NoGeometry`]) — and it
//     says the CAUSE is in the import notes it never saw.
//   * **Is it inside the machine's travel** — a drawing's parts are in
//     WORKPIECE-LOCAL millimetres (see `crate::layout::check_interference`); the
//     datum is applied later by `Job::place`. Turning workpiece-local into
//     machine coordinates is `crate::job`'s, and reading the origin fields off
//     the config here would be a second implementation of *where the workpiece
//     is*. It is also the wrong SHAPE of question per drawing:
//     [`crate::layout::Layout::plan_placement`] answers travel for the UNION of
//     everything on the workpiece, and says in its own doc that this is not each
//     part's question. That export already exists.
//   * **Is it clear of the declared work holding** — the keepout check runs on
//     an emitted toolpath (`crate::fixture`), not on an outline, and a drawing
//     has no toolpath yet.
//   * **`selected` / `not chosen`** — HOST STATE. The core does not know which
//     row a person clicked and must not be asked to guess; see
//     [`SELECTED_IS_NOT_A_CORE_FACT`].

/// One drawing on the workpiece, as the host holds it.
///
/// `offset_mm` and `rotation_deg` mean exactly what they mean on
/// `fixtures::ImportSource`: a DELTA from where the drawing was drawn, in
/// workpiece millimetres, and degrees anticlockwise about the drawing's own
/// lower-left corner. They are spelled the same because they are converted into
/// a [`crate::layout::PlacedDrawing`] by the same two lines the planner uses.
#[derive(Clone, Copy, Debug)]
pub struct DrawingIn<'a> {
    pub id: &'a str,
    /// The parts as imported — `Report.drawing` handed back, never rebuilt.
    pub parts: &'a [Part],
    pub offset_mm: [f64; 2],
    pub rotation_deg: f64,
}

impl DrawingIn<'_> {
    /// True when this drawing is where it was drawn, unturned. EXACT equality,
    /// no tolerance — `fixtures::ImportSource::is_as_drawn`'s rule and its
    /// reason: it decides whether the geometry is passed through untouched or
    /// run through the placement arithmetic, and `(v - o) + o` is NOT exactly
    /// `v` in binary floating point.
    fn is_as_drawn(&self) -> bool {
        self.offset_mm == [0.0, 0.0] && self.rotation_deg == 0.0
    }
}

/// The setup a DRAWING is judged against — and, field by field, whether anybody
/// DECLARED it.
///
/// Every field is an `Option` on purpose, on [`Setup`]'s precedent and for
/// [`Setup`]'s reason.
///
/// ⚠ **This diverges from `fixtures::intake_stock` KNOWINGLY.** That function
/// starts from `Stock::default()`, so a config declaring no workpiece size plans
/// against 600x900mm — a rectangle nobody chose. Judging a drawing's fit against
/// it would produce a confident verdict about a workpiece that does not exist,
/// so an undeclared (or half-declared) size is `None` here and the fit rule
/// reports UNKNOWN. Under-declaring costs a grey row; over-declaring vouches for
/// material that is not on the machine.
#[derive(Clone, Debug, Default)]
pub struct DrawingSetup {
    /// `[size_x_mm, size_y_mm]`, and **both or neither** — see the type doc.
    pub workpiece_size_mm: Option<[f64; 2]>,
    /// The cutter the pair check measures the channel with, resolved from the
    /// config by the SAME precedence `plan_report_import_many` uses: `tool_id`
    /// first, then the first resolvable entry of `tool_ids`.
    pub cutter: Option<crate::types::Tool>,
    /// Which library entry [`Self::cutter`] came from, echoed so an answer says
    /// what produced it.
    pub cutter_id: Option<String>,
    /// `None` = nobody declared one. The pair check still runs, at the cutter
    /// diameter alone — the planner's behaviour, and its report carries the long
    /// form of this warning.
    pub part_gap_margin_mm: Option<f64>,
    /// Facts about the setup itself the caller should see.
    pub notes: Vec<String>,
}

impl DrawingSetup {
    /// The setup as the PLANNER will resolve it, read from the very
    /// [`crate::fixtures::JobConfig`] the planner is handed.
    ///
    /// 🔴 It takes the config struct rather than a set of scalars so that a host
    /// asking *"does this drawing belong here"* and a host asking *"plan this
    /// job"* cannot be describing two different workpieces. One object, one
    /// setup, one answer.
    ///
    /// ⚠ **Only the fields a rule below READS are copied**, which is the same
    /// hazard [`Setup::from_job_config`] names: a rule added here that reads,
    /// say, `machine.travel_x_mm` would silently be judging against
    /// `Machine::default()`. Add the copy in the same commit as the rule.
    /// `the_cutter_this_call_resolves_is_the_one_the_planner_plans_with` is the
    /// test that fails when the cutter stops arriving.
    pub fn from_job_config(cfg: &crate::fixtures::JobConfig) -> Self {
        let mut notes = Vec::new();
        // The SAME merged library the planner resolves its cutter from, so a
        // shop tool declared in `extra_tools` is measured with here exactly as
        // it will be planned.
        let lib = cfg.merged_library(&mut notes);

        // An EMPTY id is an ABSENT choice, not a failed lookup — the form the
        // browser sends when the picker still reads `choose…`. This whole match
        // mirrors `plan_report_import_many`'s tool resolution; the test named in
        // this type's doc pins the two together against the planner's own
        // `tools_used`.
        let named = cfg.tool_id.as_deref().filter(|id| !id.trim().is_empty());
        let (cutter, cutter_id) = match (named, cfg.tool_ids.as_deref()) {
            (Some(id), _) => match lib.iter().find(|t| t.id == id) {
                Some(t) => (Some(t.tool.clone()), Some(t.id.clone())),
                None => {
                    // The planner REFUSES the whole job here. This call reports
                    // it and leaves the pair rule UNCHECKED rather than
                    // substituting a cutter: a Ø6mm end mill quietly standing in
                    // would measure every channel with a tool nobody chose.
                    notes.push(format!(
                        "'{id}' is not a cutter in this library, so no clearance could be built and \
                         NO PAIR OF PARTS WAS CHECKED against another. The planner refuses the whole \
                         job for the same reason"
                    ));
                    (None, None)
                }
            },
            (None, Some(ids)) if ids.iter().any(|id| !id.trim().is_empty()) => {
                let chosen: Vec<&str> =
                    ids.iter().map(String::as_str).filter(|id| !id.trim().is_empty()).collect();
                match chosen.iter().find_map(|id| lib.iter().find(|t| t.id == **id)) {
                    Some(t) => (Some(t.tool.clone()), Some(t.id.clone())),
                    None => {
                        notes.push(format!(
                            "none of the {} chosen cutters is in this library, so no clearance could \
                             be built and NO PAIR OF PARTS WAS CHECKED against another. The planner \
                             refuses the whole job for the same reason",
                            chosen.len()
                        ));
                        (None, None)
                    }
                }
            }
            _ => (None, None),
        };

        let workpiece_size_mm = match cfg.stock.as_ref() {
            None => None,
            Some(s) => match (s.size_x_mm, s.size_y_mm) {
                (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0 => {
                    Some([x, y])
                }
                (None, None) => None,
                // Half a rectangle, or one that is not a rectangle. Said out
                // loud: the planner would fill the missing half from
                // `Stock::default()` and this call will not.
                _ => {
                    notes.push(
                        "the workpiece does not declare a usable size in BOTH X and Y, so no \
                         rectangle could be measured against and every drawing's fit is UNCHECKED. \
                         It is not 'it fits'"
                            .into(),
                    );
                    None
                }
            },
        };

        Self {
            workpiece_size_mm,
            cutter,
            cutter_id,
            part_gap_margin_mm: cfg.part_gap_margin_mm,
            notes,
        }
    }
}

/// What one blocking rule said about one drawing.
///
/// 🔴 The sibling of [`RuleOutcome`], and **the three words are pinned equal to
/// it** by `the_two_rule_vocabularies_are_the_same_three_words`. It is a
/// separate type only because its `Refused` carries a SENTENCE rather than a
/// [`RejectReason`]: a drawing is refused by
/// [`crate::layout::Interference::describe`] and
/// [`crate::layout::LayoutError::describe`], which are the producers the planner
/// itself refuses with, and re-encoding their sentences into a tool-shaped enum
/// would be a paraphrase of a safety message.
#[derive(Clone, Debug, PartialEq)]
pub enum DrawingRuleOutcome {
    /// The rule ran and the drawing cleared it.
    Passed,
    /// The rule ran and the drawing broke it. **This invalidates the job**, and
    /// the sentence is the one the planner refuses with.
    Refused(String),
    /// 🔴 The rule COULD NOT RUN. Carries the reason nothing could be checked.
    /// It is not a pass and it is not a refusal.
    Unchecked(String),
}

impl DrawingRuleOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Refused(_) => "refused",
            Self::Unchecked(_) => "unchecked",
        }
    }

    /// The sentence. Empty for a pass — deliberately, and the same convention as
    /// [`RuleOutcome::why`], so a host cannot write `why || "fits"` and have it
    /// read as an answer when nothing answered.
    pub fn why(&self) -> String {
        match self {
            Self::Passed => String::new(),
            Self::Refused(w) | Self::Unchecked(w) => w.clone(),
        }
    }
}

/// One blocking rule's answer, with the rule named so a host can say WHICH
/// condition marked the row.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawingRuleVerdict {
    /// `"identity" | "geometry" | "placement" | "pair-clearance"`.
    pub rule: &'static str,
    pub outcome: DrawingRuleOutcome,
}

/// Does this drawing belong on the workpiece that is declared — a different
/// question from whether the job can be cut at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawingFit {
    /// Every point of the placed outline lies inside the declared workpiece.
    OnWorkpiece,
    /// Some of it does not. 🔴 **The planner does not refuse this today**, so it
    /// is not [`Usability::Invalidates`] — it is the filter answer, and the
    /// sentence says which way it hangs off.
    OffWorkpiece,
    /// 🔴 Nothing was asked: no workpiece size declared, or the drawing has no
    /// measurable extent. Not "it fits".
    Unknown,
}

impl DrawingFit {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OnWorkpiece => "on-workpiece",
            Self::OffWorkpiece => "off-workpiece",
            Self::Unknown => "unknown",
        }
    }
}

/// What this drawing would cost to cut, counted rather than estimated.
///
/// 🔴 These are COUNTS OF GEOMETRY, not a time and not a price. Nothing here has
/// seen a cutter, a feed or a depth — `Report.estimated_seconds` is the job's
/// own answer and it is measured on the emitted program.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrawingCost {
    /// Closed regions that would be cut out — the thing the pair check compares.
    pub parts: usize,
    /// Outer boundaries and holes together, counted as CLOSED.
    pub closed_contours: usize,
    /// 🔴 Boundaries that are NOT closed. `import::to_parts` drops these, so a
    /// non-zero count here means a host built the parts itself — and an open
    /// boundary reaches the pair check as [`crate::layout::Interference::NotChecked`].
    pub open_contours: usize,
    /// Holes, pockets and any other loop inside a part's boundary.
    pub interior_features: usize,
}

/// One row of the drawing list, as the core sees it.
#[derive(Clone, Debug)]
pub struct DrawingVerdict {
    pub drawing_id: String,
    pub usability: Usability,
    /// The core's own sentence for [`Self::usability`] — the refusals joined for
    /// `Invalidates`, the unchecked reasons for `Unknown`, **empty** for
    /// `Usable`. A host renders this verbatim.
    pub why: String,
    /// Every blocking rule, whether it passed, refused or could not run.
    pub rules: Vec<DrawingRuleVerdict>,
    pub fit: DrawingFit,
    /// The core's sentence for [`Self::fit`], on every value including
    /// `OnWorkpiece` — a blank beside a verdict reads as a verdict nobody stood
    /// behind.
    pub why_fit: String,
    /// A quarter turn that would make it fit the workpiece BY SIZE, when it does
    /// not fit as it lies. `None` for both "it already fits" and "no turn
    /// helps"; the caller must not treat those as one, which is why [`Self::fit`]
    /// is the real answer and this is the detail behind it.
    pub turn_that_fits_deg: Option<f64>,
    pub cost: DrawingCost,
    /// Where the placed outline sits, in WORKPIECE-LOCAL millimetres:
    /// `[min_x, min_y, max_x, max_y]`. `None` when there is no measurable
    /// geometry.
    pub placed_extent_mm: Option<[f64; 4]>,
}

/// 🔴 The three sentences a host will be tempted to invent, written here so it
/// does not have to.
pub const FIT_IS_NOT_USABILITY: &str =
    "`usability` and `fit` answer DIFFERENT QUESTIONS and must not be merged. `usability` is \
     whether the planner refuses the job because of this drawing — no cuttable outline, a name \
     that collides, a part sharing material with another part. `fit` is whether the drawing \
     belongs on the workpiece that is declared, and a drawing hanging off the material is NOT \
     refused by the planner today: it posts, and the cutter goes where the material is not.";

pub const DRAWING_UNKNOWN_IS_NOT_USABLE: &str =
    "UNKNOWN IS NOT USABLE, in either field. It means a rule could not run — no workpiece size \
     declared, no cutter resolved, no measurable geometry — so nothing has vouched for this \
     drawing. Render it as unjudged, never as cleared, and never fall back to `usable` or to \
     `on-workpiece` for it. A green that means 'unchecked' is worse than a red.";

pub const SELECTED_IS_NOT_A_CORE_FACT: &str =
    "`selected` and `not chosen` are HOST STATE and are deliberately absent from this payload. \
     Which drawing a person clicked is not a fact about the geometry, the workpiece or the \
     machine, and a core that guessed at it would be asserting something it cannot check. Keep \
     that state in the host and combine it with these verdicts there.";

/// ⚠ The fit rule measures the DRAWING, and the cutter runs outside it.
pub const THE_CUTTER_RUNS_OUTSIDE_THE_OUTLINE: &str =
    "`fit` is measured on the drawing's own outline, NOT grown by a cutter radius. An outside \
     profile puts the tool centre one radius further out on every side, so an outline that \
     reaches the workpiece edge is cut with the cutter off the material. That is a real setup \
     and not always a defect — it is what `use_workpiece_edge` exists for — so it is REPORTED \
     here rather than folded into the verdict, because growing the outline would refuse the \
     legitimate case and only this caller knows which one it has.";

/// 🔴 **The drawing list's verdicts** — one per drawing, for this setup.
///
/// Nothing new is decided about a refusal. Every blocking answer comes from the
/// predicate the planner already refuses on —
/// [`crate::layout::PlacedDrawing::new`], [`crate::layout::Layout::add`],
/// [`crate::layout::check_interference`] — and each refusal is that producer's
/// own sentence, so the list and the planner cannot disagree: they are the same
/// code, asked from two sides.
///
/// The FIT half is this module's own rule, and it is new. It is here rather than
/// in a host for the same reason the rest is, and it deliberately does not
/// refuse — see [`DrawingFit::OffWorkpiece`].
///
/// # 🔴 The as-drawn branch is not an optimisation
///
/// A drawing left exactly where it was drawn is passed through untouched rather
/// than run through an identity transform, because `(v - o) + o` is not exactly
/// `v` in binary floating point. `plan_report_import_many` takes that branch for
/// the same reason, and this function takes it **so that the geometry handed to
/// `check_interference` here is bit-for-bit the geometry the planner hands it**.
/// Any other arrangement would compare two nearly-equal numbers and could
/// produce a refusal sentence that differs from the planner's in its last
/// decimal place.
pub fn drawing_verdicts(setup: &DrawingSetup, drawings: &[DrawingIn<'_>]) -> Vec<DrawingVerdict> {
    use crate::layout::{
        check_interference, Clearance, LaidOutPart, Layout, LayoutError, PlacedDrawing, ONE_SHEET,
    };
    use crate::placement::Extent;

    // ---- per drawing: can it be placed at all ------------------------------
    let mut seen: Vec<&str> = Vec::new();
    let mut identity: Vec<DrawingRuleOutcome> = Vec::new();
    let mut geometry: Vec<DrawingRuleOutcome> = Vec::new();
    let mut placement: Vec<DrawingRuleOutcome> = Vec::new();
    let mut placed: Vec<Option<PlacedDrawing>> = Vec::new();

    for d in drawings {
        // --- the drawing's NAME ----------------------------------------------
        //
        // Both halves are the core's own sentence. The duplicate one carries the
        // planner's suffix too, because the planner appends it before it
        // refuses and an operator comparing the two would otherwise see two
        // different messages for one condition.
        let id_outcome = if d.id.trim().is_empty() {
            DrawingRuleOutcome::Refused(LayoutError::EmptyId.describe())
        } else if seen.contains(&d.id) {
            DrawingRuleOutcome::Refused(format!(
                "{} — give the drawings different names",
                LayoutError::DuplicateId(d.id.to_string()).describe()
            ))
        } else {
            seen.push(d.id);
            DrawingRuleOutcome::Passed
        };

        // --- is there anything to cut ---------------------------------------
        //
        // `Extent::from_parts` is the very predicate `PlacedDrawing::new` fails
        // on, so this is the planner's condition and not a lookalike. It also
        // refuses a non-finite coordinate rather than bounding everything except
        // it — see `Extent::from_points`.
        let drawn = Extent::from_parts(d.parts);
        let geom_outcome = match drawn {
            Some(_) => DrawingRuleOutcome::Passed,
            None => DrawingRuleOutcome::Refused(format!(
                "{}. WHY it has none is not visible from here — an unclosed outline, an entity the \
                 importer refused by name, or a section that missed the solid are all facts the \
                 IMPORT produced, and this call was handed the parts that came out of it. The \
                 import notes on the report carry the cause",
                LayoutError::NoGeometry(d.id.to_string()).describe()
            )),
        };

        // --- where the operator put it ---------------------------------------
        //
        // Refused, never clamped. NaN compares false against every window test,
        // so a drawing placed there would pass the fit rule having tested
        // nothing, and drop silently out of every `min`/`max` that measures
        // where the program goes.
        let finite = d.offset_mm[0].is_finite()
            && d.offset_mm[1].is_finite()
            && d.rotation_deg.is_finite();
        let place_outcome = if finite {
            DrawingRuleOutcome::Passed
        } else {
            DrawingRuleOutcome::Refused(format!(
                "drawing `{}` is placed at an offset or a turn that is not a finite number \
                 ({:?} mm, {} degrees), so where it sits on the workpiece is unknown and nothing \
                 involving it could be checked or measured",
                d.id, d.offset_mm, d.rotation_deg
            ))
        };

        let can_place = matches!(id_outcome, DrawingRuleOutcome::Passed)
            && matches!(geom_outcome, DrawingRuleOutcome::Passed)
            && finite;
        let this_placed = if can_place {
            // The same two lines `plan_report_import_many` uses: the delta is
            // turned into an ABSOLUTE corner by adding the corner the drawing
            // already had, so zero means AS DRAWN.
            PlacedDrawing::new(d.id, d.parts.to_vec()).ok().map(|p| {
                let e = p.drawn_extent();
                p.at(e.min_x + d.offset_mm[0], e.min_y + d.offset_mm[1]).rotated(d.rotation_deg)
            })
        } else {
            None
        };

        identity.push(id_outcome);
        geometry.push(geom_outcome);
        placement.push(place_outcome);
        placed.push(this_placed);
    }

    // ---- the pair check, ONCE, over the whole workpiece ---------------------
    //
    // 🔴 A workpiece with one drawing missing is not a workpiece. If any drawing
    // could not be placed, the planner refuses the whole job at step 1 and never
    // reaches this check — so every row reports UNCHECKED with the failing
    // drawing named, rather than a clear result computed from the drawings that
    // happened to work.
    let missing: Vec<&str> = drawings
        .iter()
        .zip(placed.iter())
        .filter(|(_, p)| p.is_none())
        .map(|(d, _)| d.id)
        .collect();

    // The parts on this workpiece, PLACED — the same list the planner builds
    // and the same list it checks. `Err` carries the reason the check could not
    // run at all, and that reason reaches every row as UNCHECKED.
    let laid_out: Result<Vec<LaidOutPart>, String> = if !missing.is_empty() {
        Err(format!(
            "{} drawing(s) on this workpiece could not be placed at all ({}), so NO PAIR OF PARTS \
             WAS CHECKED against another — the planner refuses the whole job before this check, \
             and a workpiece checked without one of its drawings is not this workpiece",
            missing.len(),
            missing.join(", ")
        ))
    } else if drawings.iter().all(DrawingIn::is_as_drawn) {
        // The as-drawn branch — see this function's header. It is what makes the
        // geometry handed to the check here bit-for-bit the geometry the planner
        // hands it.
        let mut out = Vec::new();
        for d in drawings {
            for p in d.parts {
                let mut part = p.clone();
                part.name = format!("{}/{}", d.id, p.name);
                out.push(LaidOutPart {
                    drawing: d.id.to_string(),
                    // One workpiece, said explicitly — `plan_report_import_many`
                    // hard-codes it here too, so that the pair check comparing
                    // parts that SHARE A WORKPIECE stays a rule rather than a
                    // coincidence.
                    sheet_id: ONE_SHEET.to_string(),
                    source_name: p.name.clone(),
                    part,
                });
            }
        }
        Ok(out)
    } else {
        let mut layout = Layout::new();
        let mut refused: Option<String> = None;
        for p in placed.iter().flatten() {
            // Unreachable today — a duplicate id is refused above and never
            // reaches here — but the answer is CARRIED rather than discarded.
            // An `add` whose result is thrown away is a drawing that silently
            // stops being compared against the others.
            if let Err(e) = layout.add(p.clone()) {
                refused = Some(format!("{} — give the drawings different names", e.describe()));
                break;
            }
        }
        match refused {
            Some(why) => Err(why),
            None => Ok(layout.laid_out()),
        }
    };

    let pair: Result<Vec<crate::layout::Interference>, String> =
        laid_out.and_then(|parts| match setup.cutter.as_ref() {
            None => Err(
                "no cutter is resolved from this configuration, so no clearance could be built and \
                 NO PAIR OF PARTS WAS CHECKED against another — UNCHECKED, not clear. The channel \
                 between two parts is measured with the tool that has to travel down it"
                    .into(),
            ),
            Some(tool) => match Clearance::from_tool(tool, setup.part_gap_margin_mm.unwrap_or(0.0))
            {
                // A margin that is not a usable number is not clamped here for
                // the same reason the planner refuses it: a NaN margin compares
                // false against every gap test, so the check would report a
                // clear workpiece having tested nothing.
                None => Err(format!(
                    "a clearance could not be built from a {:.3}mm cutter and a part-gap margin of \
                     {:?}, so NO PAIR OF PARTS WAS CHECKED. The planner refuses the whole job on \
                     this same condition; an UNCHECKED workpiece is not a clear workpiece",
                    tool.diameter_mm, setup.part_gap_margin_mm
                )),
                Some(clearance) => Ok(check_interference(&parts, &clearance)),
            },
        });

    // ---- one row per drawing ------------------------------------------------
    drawings
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let mut rules = vec![
                DrawingRuleVerdict { rule: "identity", outcome: identity[i].clone() },
                DrawingRuleVerdict { rule: "geometry", outcome: geometry[i].clone() },
                DrawingRuleVerdict { rule: "placement", outcome: placement[i].clone() },
            ];

            rules.push(DrawingRuleVerdict {
                rule: "pair-clearance",
                outcome: match &pair {
                    Err(why) => DrawingRuleOutcome::Unchecked(why.clone()),
                    Ok(findings) => {
                        // Only the findings that NAME this drawing. A pair
                        // condemns both of its drawings and neither of the
                        // others: a row that inherited another pair's refusal
                        // would send a person to re-nest geometry that is fine.
                        let mine: Vec<String> = findings
                            .iter()
                            .filter(|f| {
                                let (a, b) = f.parts();
                                a.drawing == d.id || b.drawing == d.id
                            })
                            .map(|f| f.describe())
                            .collect();
                        if mine.is_empty() {
                            DrawingRuleOutcome::Passed
                        } else {
                            DrawingRuleOutcome::Refused(mine.join("; "))
                        }
                    }
                },
            });

            let refusals: Vec<String> = rules
                .iter()
                .filter(|r| matches!(r.outcome, DrawingRuleOutcome::Refused(_)))
                .map(|r| r.outcome.why())
                .collect();
            let unchecked: Vec<String> = rules
                .iter()
                .filter(|r| matches!(r.outcome, DrawingRuleOutcome::Unchecked(_)))
                .map(|r| r.outcome.why())
                .collect();

            // 🔴 Refused wins over unchecked, and unchecked wins over usable.
            // Never the other way — [`tool_verdicts`]'s rule, unchanged.
            let (usability, why) = if !refusals.is_empty() {
                (Usability::Invalidates, refusals.join("; "))
            } else if !unchecked.is_empty() {
                (Usability::Unknown, unchecked.join("; "))
            } else {
                (Usability::Usable, String::new())
            };

            let (fit, why_fit, turn_that_fits_deg, placed_extent_mm) =
                fit_of(setup, d, placed[i].as_ref());

            DrawingVerdict {
                drawing_id: d.id.to_string(),
                usability,
                why,
                rules,
                fit,
                why_fit,
                turn_that_fits_deg,
                cost: cost_of(d.parts),
                placed_extent_mm,
            }
        })
        .collect()
}

/// The geometry counts. Nothing is estimated and nothing is scaled.
fn cost_of(parts: &[Part]) -> DrawingCost {
    let mut c = DrawingCost { parts: parts.len(), ..DrawingCost::default() };
    for p in parts {
        for contour in std::iter::once(&p.outer).chain(p.inners.iter()) {
            if contour.closed {
                c.closed_contours += 1;
            } else {
                c.open_contours += 1;
            }
        }
        c.interior_features += p.inners.len();
    }
    c
}

/// 🔴 **Does this drawing belong on the declared workpiece** — the filter half.
///
/// Measured in WORKPIECE-LOCAL millimetres, where the workpiece is
/// `0..size_x` by `0..size_y`: that is the frame every placed part is already
/// in (`crate::layout::check_interference` states it), and the datum is applied
/// later by `crate::job`. So this question needs no datum and borrows none.
///
/// The two failures are separated because they have DIFFERENT FIXES, which is
/// this crate's rule for the overlap-versus-too-close pair as well:
///
/// * **larger than the workpiece** — no move helps; turn it, re-draw it, or buy
///   bigger material. A quarter turn is offered when one would fit BY SIZE,
///   which is `crate::job`'s own wording for the workpiece-against-machine
///   question one object along.
/// * **off the workpiece** — it fits by size and is not on the material. Move
///   it. ⚠ Nothing here moves it: the work holding does not travel with the
///   drawing.
fn fit_of(
    setup: &DrawingSetup,
    d: &DrawingIn<'_>,
    placed: Option<&crate::layout::PlacedDrawing>,
) -> (DrawingFit, String, Option<f64>, Option<[f64; 4]>) {
    let extent = placed.and_then(|p| p.placed_extent());
    let extent_out = extent.map(|e| [e.min_x, e.min_y, e.max_x, e.max_y]);

    let Some(size) = setup.workpiece_size_mm else {
        return (
            DrawingFit::Unknown,
            "no workpiece size is declared, so there is no rectangle to measure this drawing \
             against — UNCHECKED, not on the workpiece"
                .into(),
            None,
            extent_out,
        );
    };
    let Some(e) = extent else {
        return (
            DrawingFit::Unknown,
            format!(
                "drawing `{}` has no measurable extent, so nothing could be measured against the \
                 {:.1} x {:.1}mm workpiece — UNCHECKED, not on it",
                d.id, size[0], size[1]
            ),
            None,
            extent_out,
        );
    };

    let (w, h) = (e.width(), e.height());
    let inside = e.min_x >= 0.0 && e.min_y >= 0.0 && e.max_x <= size[0] && e.max_y <= size[1];
    if inside {
        return (
            DrawingFit::OnWorkpiece,
            format!(
                "the whole outline is on the workpiece: X {:.3} .. {:.3} and Y {:.3} .. {:.3}, \
                 inside {:.1} x {:.1}mm. {THE_CUTTER_RUNS_OUTSIDE_THE_OUTLINE}",
                e.min_x, e.max_x, e.min_y, e.max_y, size[0], size[1]
            ),
            None,
            extent_out,
        );
    }

    // Bigger than the material, on at least one axis: no move can help.
    if w > size[0] || h > size[1] {
        // A quarter turn swaps the axes exactly, so the size question is
        // answerable without moving anything — and moving is what this crate
        // never does.
        let turn = if h <= size[0] && w <= size[1] { Some(90.0) } else { None };
        let advice = match turn {
            Some(deg) => format!(
                " — it would fit BY SIZE turned {deg:.0} degrees, {:.3} x {:.3} into {:.1} x \
                 {:.1}mm. That is a size answer only: it does not say where on the workpiece to \
                 then put it, and nothing here turns or moves a drawing for you",
                h, w, size[0], size[1]
            ),
            None => " — and no quarter turn helps: it is larger than the workpiece either way"
                .to_string(),
        };
        return (
            DrawingFit::OffWorkpiece,
            format!(
                "drawing `{}` is LARGER THAN THE WORKPIECE: it needs {:.3} x {:.3}mm and the \
                 workpiece is {:.1} x {:.1}mm{advice}",
                d.id, w, h, size[0], size[1]
            ),
            turn,
            extent_out,
        );
    }

    // It fits by size and is not on the material. Name every edge it hangs
    // over, with the number a person moves it by.
    let mut over: Vec<String> = Vec::new();
    if e.min_x < 0.0 {
        over.push(format!("{:.3}mm past the workpiece's X=0 edge", -e.min_x));
    }
    if e.min_y < 0.0 {
        over.push(format!("{:.3}mm past the workpiece's Y=0 edge", -e.min_y));
    }
    if e.max_x > size[0] {
        over.push(format!("{:.3}mm past the far X edge", e.max_x - size[0]));
    }
    if e.max_y > size[1] {
        over.push(format!("{:.3}mm past the far Y edge", e.max_y - size[1]));
    }
    (
        DrawingFit::OffWorkpiece,
        format!(
            "drawing `{}` FITS THE WORKPIECE BY SIZE AND IS NOT ON IT: it hangs {}. Where it \
             hangs over there is no material — the cutter goes down into whatever is under the \
             workpiece there. Move the drawing on the workpiece; nothing here moves it for you, \
             because the work holding stays bolted to the machine while the drawing does not",
            d.id,
            over.join(", and ")
        ),
        None,
        extent_out,
    )
}

/// [`drawing_verdicts`], serialised for a host that cannot hold a Rust type.
///
/// 🔴 **Every sentence in this payload is composed in the CORE** — here, in
/// [`crate::layout`] or in [`crate::placement`] — and a host renders it verbatim.
/// Returning a code for a host to turn back into a sentence would be a second
/// copy of a safety message, and the two would drift.
///
/// # The export this is written for, spelled out
///
/// `wasm/src/lib.rs` is not this section's file. The boundary it needs is
/// written here rather than left to be inferred, so the two cannot be designed
/// twice:
///
/// ```text
/// #[wasm_bindgen]
/// pub fn drawing_verdicts(config_json: &str, drawings_json: &str) -> String
/// ```
///
/// * `config_json` — **the same `JobConfig` the browser sends to `plan` and
///   `plan_import_many`**, so a row saying a drawing belongs here and a planner
///   refusing it cannot be describing two different workpieces. An empty string
///   is `JobConfig::default()`; a config that will not parse must be REFUSED
///   (`{ ok: false, why }`), never replaced with defaults — `wasm::tool_verdicts`
///   already takes exactly that shape.
/// * `drawings_json` — an array of
///   `{ id: string, parts: DrawingPart[], offset_mm?: [number, number],
///   rotation_deg?: number }`. `parts` is `Report.drawing` handed back, through
///   the existing `to_part`. `offset_mm` and `rotation_deg` are
///   `ImportDrawingIn`'s, with `ImportDrawingIn`'s meaning — a DELTA from where
///   the drawing was drawn — and **not** `PlacedDrawingIn`'s absolute
///   `x_mm`/`y_mm`. Two fields, two questions, deliberately not spelled the same.
///   `"[]"` or an empty string is a legitimate answer of zero rows: the drawing
///   list exists before a file is dropped.
///
/// The payload is this function's, unchanged:
///
/// ```text
/// { ok: true,
///   setup: { workpiece_size_mm: [number, number] | null,
///            cutter_id: string | null, cutter_diameter_mm: number | null,
///            part_gap_margin_mm: number | null, part_gap_margin_declared: bool,
///            drawings: number },
///   verdicts: [ { id: string,
///                 usability: "usable" | "invalidates" | "unknown",
///                 why: string,
///                 rules: [ { rule: "identity" | "geometry" | "placement"
///                                  | "pair-clearance",
///                            outcome: "passed" | "refused" | "unchecked",
///                            why: string } ],
///                 fit: "on-workpiece" | "off-workpiece" | "unknown",
///                 why_fit: string,
///                 turn_that_fits_deg: number | null,
///                 cost: { parts, closed_contours, open_contours,
///                         interior_features },
///                 placed_extent_mm: [number, number, number, number] | null } ],
///   notes: string[],
///   caveats: string[] }
/// ```
///
/// 🔴 **`usability` and `fit` are the two answers and a host must not merge
/// them** ([`FIT_IS_NOT_USABILITY`]), `"unknown"` is not usable in either field
/// ([`DRAWING_UNKNOWN_IS_NOT_USABLE`]), and `selected` / `not chosen` are the
/// host's own state and are not in this payload ([`SELECTED_IS_NOT_A_CORE_FACT`]).
/// All three sentences travel in `caveats`; render them rather than rewriting
/// them.
pub fn drawing_verdicts_json(
    setup: &DrawingSetup,
    drawings: &[DrawingIn<'_>],
    extra_notes: &[String],
) -> String {
    let verdicts = drawing_verdicts(setup, drawings);
    let rows: Vec<serde_json::Value> = verdicts
        .iter()
        .map(|v| {
            serde_json::json!({
                "id": v.drawing_id,
                "usability": v.usability.as_str(),
                "why": v.why,
                "rules": v.rules.iter().map(|r| serde_json::json!({
                    "rule": r.rule,
                    "outcome": r.outcome.as_str(),
                    "why": r.outcome.why(),
                })).collect::<Vec<_>>(),
                "fit": v.fit.as_str(),
                "why_fit": v.why_fit,
                "turn_that_fits_deg": v.turn_that_fits_deg,
                "cost": {
                    "parts": v.cost.parts,
                    "closed_contours": v.cost.closed_contours,
                    "open_contours": v.cost.open_contours,
                    "interior_features": v.cost.interior_features,
                },
                "placed_extent_mm": v.placed_extent_mm,
            })
        })
        .collect();

    let mut notes = setup.notes.clone();
    notes.extend(extra_notes.iter().cloned());

    serde_json::json!({
        "ok": true,
        // What was actually judged, echoed so the answer says what produced it.
        "setup": {
            "workpiece_size_mm": setup.workpiece_size_mm,
            "cutter_id": setup.cutter_id,
            "cutter_diameter_mm": setup.cutter.as_ref().map(|t| t.diameter_mm),
            "part_gap_margin_mm": setup.part_gap_margin_mm,
            "part_gap_margin_declared": setup.part_gap_margin_mm.is_some(),
            "drawings": drawings.len(),
        },
        "verdicts": rows,
        "notes": notes,
        "caveats": [
            FIT_IS_NOT_USABILITY,
            DRAWING_UNKNOWN_IS_NOT_USABLE,
            SELECTED_IS_NOT_A_CORE_FACT,
            THE_CUTTER_RUNS_OUTSIDE_THE_OUTLINE,
        ],
    })
    .to_string()
}

// ===========================================================================
//  Tests — the per-DRAWING verdicts
// ===========================================================================

#[cfg(test)]
mod drawing_verdict_tests {
    use super::*;
    use crate::fixtures::{plan_report_import_many, ImportSource, JobConfig};
    use crate::geometry::Contour;

    /// A 6mm cutter the whole built-in library and every default machine can
    /// hold. Named once so a test about geometry is not accidentally a test
    /// about collets.
    const CUTTER: &str = "End Mill - Down-cut 6mm 2F";

    fn cfg(json: &str) -> JobConfig {
        serde_json::from_str(json).expect("the test config is not valid JobConfig JSON")
    }

    /// One square part, `w` x `h`, with its lower-left corner at `x,y`.
    fn square(name: &str, x: f64, y: f64, w: f64, h: f64) -> Part {
        Part::new(name, Contour::rect(x, y, w, h))
    }

    /// The same square as a DXF, so a test can hand identical geometry to this
    /// module and to the planner and compare their two answers.
    fn square_dxf(x: f64, y: f64, w: f64, h: f64) -> String {
        let pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)];
        let mut s = String::from("0\nSECTION\n2\nENTITIES\n");
        s.push_str("0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n");
        for (px, py) in pts {
            s.push_str(&format!("10\n{px}\n20\n{py}\n"));
        }
        s.push_str("0\nENDSEC\n0\nEOF\n");
        s
    }

    fn drawing<'a>(id: &'a str, parts: &'a [Part]) -> DrawingIn<'a> {
        DrawingIn { id, parts, offset_mm: [0.0, 0.0], rotation_deg: 0.0 }
    }

    fn rule<'a>(v: &'a DrawingVerdict, name: &str) -> &'a DrawingRuleOutcome {
        &v.rules
            .iter()
            .find(|r| r.rule == name)
            .unwrap_or_else(|| panic!("rule `{name}` is missing from {:?}", v.drawing_id))
            .outcome
    }

    // --- the vocabulary is one vocabulary ---------------------------------

    #[test]
    fn the_two_rule_vocabularies_are_the_same_three_words() {
        // 🔴 The drawing rules and the tool rules are separate types and MUST
        // render as the same three words. A host writing `outcome === 'refused'`
        // against one list and reading the other is the drift this pins.
        assert_eq!(DrawingRuleOutcome::Passed.as_str(), RuleOutcome::Passed.as_str());
        assert_eq!(
            DrawingRuleOutcome::Refused(String::new()).as_str(),
            RuleOutcome::Refused(RejectReason::InvalidTool { faults: String::new() }).as_str()
        );
        assert_eq!(
            DrawingRuleOutcome::Unchecked(String::new()).as_str(),
            RuleOutcome::Unchecked(String::new()).as_str()
        );
        // And a PASS says nothing, so a host cannot render `why || "fits"`.
        assert_eq!(DrawingRuleOutcome::Passed.why(), "");
    }

    // --- 🔴 agreement with the planner, both directions -------------------

    #[test]
    fn an_overlap_this_module_refuses_is_refused_by_the_planner_in_the_same_words() {
        // 🔴 THE ARM THAT MATTERS. Two parts on the same material: the planner
        // refuses the whole job with `Interference::describe`, and this module
        // must produce that sentence character for character. If it ever
        // composes its own, an operator gets two different messages for one
        // physical fault and will trust whichever is nearer.
        let a = square_dxf(0.0, 0.0, 100.0, 100.0);
        let b = square_dxf(50.0, 50.0, 100.0, 100.0);
        let config = cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":600,"size_y_mm":900,"thickness_mm":18}}}}"#
        ));

        let report = plan_report_import_many(
            &[
                ImportSource::as_drawn("a", a.as_bytes(), "dxf"),
                ImportSource::as_drawn("b", b.as_bytes(), "dxf"),
            ],
            &config,
            3.0,
            None,
            None,
        );
        assert!(!report.ok, "the planner was expected to refuse this nest: {:?}", report.errors);
        assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);

        // The same two drawings, imported the same way, asked of this module.
        let pa = crate::import::to_parts(&crate::import::parse_dxf(&a, 0.02), "part");
        let pb = crate::import::to_parts(&crate::import::parse_dxf(&b, 0.02), "part");
        let setup = DrawingSetup::from_job_config(&config);
        let v = drawing_verdicts(&setup, &[drawing("a", &pa), drawing("b", &pb)]);

        assert_eq!(v.len(), 2);
        for row in &v {
            assert_eq!(row.usability, Usability::Invalidates, "{row:?}");
            assert_eq!(
                rule(row, "pair-clearance").why(),
                report.refusals[0],
                "the drawing verdict and the planner must refuse in the SAME WORDS"
            );
        }
    }

    #[test]
    fn a_nest_the_planner_accepts_comes_back_usable_and_on_the_workpiece() {
        // 🔴 The second arm. Without it the test above proves only that this
        // module refuses everything.
        // 🔴 Drawn at 10,10 rather than 0,0 ON PURPOSE. An outside profile puts
        // the tool centre 3mm outside the outline, so a part drawn on the datum
        // posts moves at X -3 and the planner refuses it for TRAVEL — see
        // `docs/off-table-audit.md` §1. That refusal is real and is not this
        // test's subject; a test that tripped over it would be measuring the
        // wrong thing.
        let a = square_dxf(10.0, 10.0, 100.0, 100.0);
        let b = square_dxf(210.0, 10.0, 100.0, 100.0);
        let config = cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":600,"size_y_mm":900,"thickness_mm":18}}}}"#
        ));

        let report = plan_report_import_many(
            &[
                ImportSource::as_drawn("a", a.as_bytes(), "dxf"),
                ImportSource::as_drawn("b", b.as_bytes(), "dxf"),
            ],
            &config,
            3.0,
            None,
            None,
        );
        assert!(report.ok, "the planner was expected to accept this nest: {:?}", report.errors);
        assert!(report.refusals.is_empty(), "{:?}", report.refusals);

        let pa = crate::import::to_parts(&crate::import::parse_dxf(&a, 0.02), "part");
        let pb = crate::import::to_parts(&crate::import::parse_dxf(&b, 0.02), "part");
        let setup = DrawingSetup::from_job_config(&config);
        let v = drawing_verdicts(&setup, &[drawing("a", &pa), drawing("b", &pb)]);

        for row in &v {
            assert_eq!(row.usability, Usability::Usable, "{row:?}");
            assert_eq!(row.why, "", "a usable row says nothing, exactly as a tool row does");
            assert_eq!(*rule(row, "pair-clearance"), DrawingRuleOutcome::Passed, "{row:?}");
            assert_eq!(row.fit, DrawingFit::OnWorkpiece, "{row:?}");
        }
    }

    #[test]
    fn the_cutter_this_call_resolves_is_the_one_the_planner_plans_with() {
        // The pair check measures a channel with a cutter, so the two must
        // resolve the SAME one. This walks the branch a config takes when it
        // names a tool SET rather than one tool — the branch a hand-written
        // lookup gets wrong.
        // Off the datum, for the reason given in the accepted-nest test above.
        let dxf = square_dxf(10.0, 10.0, 100.0, 100.0);
        let config = cfg(&format!(
            r#"{{"tool_ids":["","{CUTTER}"],"stock":{{"size_x_mm":600,"size_y_mm":900,"thickness_mm":18}}}}"#
        ));
        let report = plan_report_import_many(
            &[ImportSource::as_drawn("a", dxf.as_bytes(), "dxf")],
            &config,
            3.0,
            None,
            None,
        );
        assert!(report.ok, "{:?}", report.errors);
        let setup = DrawingSetup::from_job_config(&config);
        assert_eq!(
            setup.cutter_id.as_deref(),
            report.tools_used.first().map(String::as_str),
            "this call and the planner resolved different cutters"
        );
    }

    #[test]
    fn a_drawing_with_no_geometry_is_refused_in_the_planners_own_sentence() {
        // `LayoutError::NoGeometry` is the condition `PlacedDrawing::new` fails
        // on and the planner refuses with, so the first clause is quoted from
        // the same producer. The rest of the sentence says the CAUSE is not
        // visible from here — which is the honest limit of this call.
        let empty: Vec<Part> = Vec::new();
        let setup = DrawingSetup::from_job_config(&cfg(&format!(r#"{{"tool_id":"{CUTTER}"}}"#)));
        let v = drawing_verdicts(&setup, &[drawing("a", &empty)]);
        assert_eq!(v[0].usability, Usability::Invalidates);
        let why = rule(&v[0], "geometry").why();
        assert!(
            why.starts_with(&crate::layout::LayoutError::NoGeometry("a".into()).describe()),
            "{why}"
        );
        assert!(why.contains("import notes"), "{why}");
        // And the pair check did NOT quietly pass over the wreckage.
        assert_eq!(rule(&v[0], "pair-clearance").as_str(), "unchecked");
    }

    #[test]
    fn two_drawings_with_one_name_are_refused_exactly_as_the_planner_refuses_them() {
        let parts = vec![square("part1", 0.0, 0.0, 10.0, 10.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(r#"{{"tool_id":"{CUTTER}"}}"#)));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts), drawing("a", &parts)]);
        assert_eq!(v[0].usability, Usability::Unknown, "the FIRST `a` is not the duplicate");
        assert_eq!(v[1].usability, Usability::Invalidates);
        assert_eq!(
            rule(&v[1], "identity").why(),
            format!(
                "{} — give the drawings different names",
                crate::layout::LayoutError::DuplicateId("a".into()).describe()
            )
        );
    }

    // --- 🔴 the third state, and it must not be reachable as a pass --------

    #[test]
    fn no_cutter_leaves_the_pair_check_unchecked_and_the_row_is_not_usable() {
        let parts = vec![square("part1", 0.0, 0.0, 10.0, 10.0)];
        // No `tool_id` at all — what the browser sends before a cutter is picked.
        let setup = DrawingSetup::from_job_config(&cfg(r#"{"stock":{"size_x_mm":600,"size_y_mm":900}}"#));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(rule(&v[0], "pair-clearance").as_str(), "unchecked");
        // 🔴 THE PLANT THIS TEST EXISTS FOR: `unknown` must never arrive as
        // `usable`. Every other rule on this row passed, and a row that let the
        // passes outvote the unrun rule would read as cleared.
        assert_ne!(v[0].usability, Usability::Usable);
        assert_eq!(v[0].usability, Usability::Unknown);
        assert!(v[0].why.contains("UNCHECKED, not clear"), "{}", v[0].why);
        // Fit is a different question and it WAS answerable.
        assert_eq!(v[0].fit, DrawingFit::OnWorkpiece);
    }

    #[test]
    fn no_declared_workpiece_size_leaves_fit_unknown_rather_than_on_the_workpiece() {
        // 🔴 `fixtures::intake_stock` would plan this against `Stock::default()`
        // — 600x900mm nobody chose. This call refuses to vouch for a rectangle
        // that was never declared.
        let parts = vec![square("part1", 0.0, 0.0, 10.0, 10.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(r#"{{"tool_id":"{CUTTER}"}}"#)));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(v[0].fit, DrawingFit::Unknown);
        assert_ne!(v[0].fit, DrawingFit::OnWorkpiece);
        assert!(v[0].why_fit.contains("UNCHECKED, not on the workpiece"), "{}", v[0].why_fit);
        // And a half-declared rectangle is the same answer, said out loud.
        let half = DrawingSetup::from_job_config(&cfg(r#"{"stock":{"size_x_mm":600}}"#));
        assert!(half.workpiece_size_mm.is_none());
        assert!(half.notes.iter().any(|n| n.contains("It is not 'it fits'")), "{:?}", half.notes);
    }

    // --- the fit half: two failures, two fixes ----------------------------

    #[test]
    fn a_drawing_bigger_than_the_workpiece_says_so_and_offers_the_quarter_turn() {
        // 500 x 300 on a 400 x 600 workpiece: no move helps, a quarter turn does
        // — and this is `job.rs`'s workpiece-against-machine wording, one object
        // along.
        let parts = vec![square("part1", 0.0, 0.0, 500.0, 300.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":400,"size_y_mm":600}}}}"#
        )));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(v[0].fit, DrawingFit::OffWorkpiece);
        assert_eq!(v[0].turn_that_fits_deg, Some(90.0));
        assert!(v[0].why_fit.contains("LARGER THAN THE WORKPIECE"), "{}", v[0].why_fit);
        assert!(v[0].why_fit.contains("BY SIZE turned 90 degrees"), "{}", v[0].why_fit);
        // 🔴 And it is NOT a refusal: the planner posts this program.
        assert_eq!(v[0].usability, Usability::Usable);
    }

    #[test]
    fn a_drawing_that_fits_but_hangs_off_names_every_edge_and_offers_no_turn() {
        // Fits by size (100 x 100 into 400 x 600) and is placed off the corner.
        // A different failure with a different fix, so a different sentence.
        let parts = vec![square("part1", -20.0, -5.0, 100.0, 100.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":400,"size_y_mm":600}}}}"#
        )));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(v[0].fit, DrawingFit::OffWorkpiece);
        assert_eq!(v[0].turn_that_fits_deg, None, "turning does not fix a placement");
        assert!(v[0].why_fit.contains("FITS THE WORKPIECE BY SIZE AND IS NOT ON IT"), "{}", v[0].why_fit);
        assert!(v[0].why_fit.contains("20.000mm past the workpiece's X=0 edge"), "{}", v[0].why_fit);
        assert!(v[0].why_fit.contains("5.000mm past the workpiece's Y=0 edge"), "{}", v[0].why_fit);
    }

    #[test]
    fn dragging_a_drawing_moves_the_fit_answer_because_the_offset_is_applied() {
        // The offset is a DELTA from where the drawing was drawn, exactly as
        // `ImportSource::offset_mm`. A fit rule that ignored it would grade the
        // drawing where CAD left it and not where the operator put it.
        let parts = vec![square("part1", 0.0, 0.0, 100.0, 100.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":150,"size_y_mm":150}}}}"#
        )));
        let home = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(home[0].fit, DrawingFit::OnWorkpiece);

        let dragged = DrawingIn { id: "a", parts: &parts, offset_mm: [100.0, 0.0], rotation_deg: 0.0 };
        let out = drawing_verdicts(&setup, &[dragged]);
        assert_eq!(out[0].fit, DrawingFit::OffWorkpiece);
        assert!(out[0].why_fit.contains("50.000mm past the far X edge"), "{}", out[0].why_fit);
        assert_eq!(out[0].placed_extent_mm, Some([100.0, 0.0, 200.0, 100.0]));
    }

    #[test]
    fn a_non_finite_placement_is_refused_rather_than_measured() {
        let parts = vec![square("part1", 0.0, 0.0, 10.0, 10.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":400,"size_y_mm":600}}}}"#
        )));
        let bad = DrawingIn { id: "a", parts: &parts, offset_mm: [f64::NAN, 0.0], rotation_deg: 0.0 };
        let v = drawing_verdicts(&setup, &[bad]);
        assert_eq!(v[0].usability, Usability::Invalidates);
        assert_eq!(rule(&v[0], "placement").as_str(), "refused");
        // 🔴 And nothing downstream vouched for it: NaN passes every window test
        // by comparing false, so a fit answer here would be a green that
        // measured nothing.
        assert_eq!(v[0].fit, DrawingFit::Unknown);
        assert_eq!(rule(&v[0], "pair-clearance").as_str(), "unchecked");
    }

    // --- what it would cost -----------------------------------------------

    #[test]
    fn the_cost_counts_holes_rather_than_just_parts() {
        // "1 part" is equally true of a plate with four holes and of the same
        // plate with every hole dropped — the failure the import notes are
        // arranged against, counted here per drawing.
        let plate = square("part1", 0.0, 0.0, 100.0, 100.0)
            .with_hole(Contour::circle(20.0, 20.0, 5.0))
            .with_hole(Contour::circle(80.0, 80.0, 5.0));
        let parts = vec![plate, square("part2", 200.0, 0.0, 10.0, 10.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(r#"{{"tool_id":"{CUTTER}"}}"#)));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(
            v[0].cost,
            DrawingCost {
                parts: 2,
                closed_contours: 4,
                open_contours: 0,
                interior_features: 2
            }
        );
    }

    #[test]
    fn an_open_boundary_is_counted_and_reaches_the_pair_check_as_not_checked() {
        // `import::to_parts` drops open contours, so this only arrives from a
        // host that built the parts itself — and it must not read as a closed
        // one. The pair check's own answer for it is NOT_CHECKED, which is a
        // refusal.
        let mut open = Contour::rect(0.0, 0.0, 50.0, 50.0);
        open.closed = false;
        // 🔴 2mm apart, not 10mm. `check_interference` has a fast path that
        // skips any pair whose BOXES are already `required` apart — sound in the
        // clear direction and it does not care whether a boundary is closed. A
        // test that put them far apart would pass while asking nothing.
        let parts = vec![Part::new("part1", open), square("part2", 52.0, 0.0, 50.0, 50.0)];
        let setup = DrawingSetup::from_job_config(&cfg(&format!(r#"{{"tool_id":"{CUTTER}"}}"#)));
        let v = drawing_verdicts(&setup, &[drawing("a", &parts)]);
        assert_eq!(v[0].cost.open_contours, 1);
        assert_eq!(v[0].cost.closed_contours, 1);
        assert_eq!(rule(&v[0], "pair-clearance").as_str(), "refused");
        assert!(rule(&v[0], "pair-clearance").why().contains("could NOT be checked"));
    }

    // --- the payload -------------------------------------------------------

    #[test]
    fn the_json_carries_every_rule_the_caveats_and_the_setup_it_judged() {
        let parts = vec![square("part1", 0.0, 0.0, 100.0, 100.0)];
        let config = cfg(&format!(
            r#"{{"tool_id":"{CUTTER}","stock":{{"size_x_mm":600,"size_y_mm":900,"thickness_mm":18}}}}"#
        ));
        let setup = DrawingSetup::from_job_config(&config);
        let json: serde_json::Value =
            serde_json::from_str(&drawing_verdicts_json(&setup, &[drawing("a", &parts)], &[]))
                .expect("the payload is not valid JSON");

        assert_eq!(json["ok"], true);
        assert_eq!(json["setup"]["cutter_id"], CUTTER);
        assert_eq!(json["setup"]["workpiece_size_mm"][0], 600.0);
        assert_eq!(json["setup"]["part_gap_margin_declared"], false);
        assert_eq!(json["setup"]["drawings"], 1);

        let caveats = json["caveats"].as_array().expect("no caveats");
        // 🔴 The boundary the host must not go looking for in the core.
        assert!(caveats
            .iter()
            .any(|c| c.as_str().unwrap().contains("`selected` and `not chosen` are HOST STATE")));
        assert!(caveats.iter().any(|c| c.as_str().unwrap().contains("UNKNOWN IS NOT USABLE")));

        let rows = json["verdicts"].as_array().expect("no verdicts");
        assert_eq!(rows.len(), 1);
        const USABILITY: [&str; 3] = ["usable", "invalidates", "unknown"];
        const FIT: [&str; 3] = ["on-workpiece", "off-workpiece", "unknown"];
        for r in rows {
            assert!(USABILITY.contains(&r["usability"].as_str().unwrap()), "{r}");
            assert!(FIT.contains(&r["fit"].as_str().unwrap()), "{r}");
            // Four rules on every row, always — a row that quietly stopped
            // asking one would look identical to one that passed it.
            assert_eq!(r["rules"].as_array().unwrap().len(), 4, "{r}");
        }
        assert_eq!(rows[0]["cost"]["parts"], 1);
        assert_eq!(rows[0]["placed_extent_mm"][2], 100.0);
    }
}

#[cfg(test)]
mod depth_source_tests {
    use super::*;
    fn square(size: f64) -> Contour {
        let v = |x: f64, y: f64| Vertex { x, y, bulge: 0.0 };
        Contour::closed(vec![v(0.0, 0.0), v(size, 0.0), v(size, size), v(0.0, size)])
    }

    fn part_with_hole() -> Part {
        Part { name: "p".into(), outer: square(100.0), inners: vec![square(10.0)] }
    }

    /// 🔴 THE DEFECT: a DXF carries no Z, so the depth is SUBSTITUTED — and the
    /// substitution used to be indistinguishable from a measurement.
    ///
    /// It was disclosed the whole time, in the caveat block at the FOOT of the
    /// output: *"every feature here is priced as a THROUGH cut at the workpiece
    /// thickness"*. That is not enough, and 2026-09-04 measured why: on a
    /// terraced relief whose own filename read `depth4.5mm`, the command printed
    /// `18.000mm deep`, recommended a 12 mm cutter, and REJECTED the 3 mm,
    /// 3.175 mm and 4 mm cutters as *"too short to reach the depth"*. A reader
    /// who had read the caveat acted on the number anyway.
    /// ⇒ **A correction below its claim only reaches the readers who were not
    /// going to get it wrong.** The assumption now rides beside the number.
    #[test]
    fn from_part_marks_its_depth_as_assumed_not_measured() {
        let stock = Stock { thickness_mm: 18.0, ..Default::default() };
        let fs = Feature::from_part(&part_with_hole(), &stock);
        assert!(!fs.is_empty());
        for f in &fs {
            assert_eq!(f.depth_mm, 18.0, "the substituted depth is still stock thickness");
            assert!(f.depth.is_assumed(), "{} must not present a substitution as a fact", f.id);
        }
    }

    /// The escape, and the half that makes the mark worth having: a caller who
    /// KNOWS the depth says so, and the output stops hedging. Same move
    /// `--collet` already makes for the shank rule.
    #[test]
    fn a_declared_depth_is_not_marked_assumed() {
        let fs = Feature::from_part_at(&part_with_hole(), 4.5, DepthSource::Declared);
        for f in &fs {
            assert_eq!(f.depth_mm, 4.5);
            assert!(!f.depth.is_assumed(), "{} was declared and must not hedge", f.id);
        }
    }

    /// 🔴 THE CONSEQUENCE THAT REACHES A SPINDLE. The reach rule rejects a
    /// cutter whose flute is shorter than the depth. On an ASSUMED 18 mm it
    /// rejects short cutters that would cut a 4.5 mm terrace perfectly well —
    /// a wrong rejection wearing the words of a measured rule.
    #[test]
    fn the_reach_rule_depends_on_the_depth_and_so_inherits_the_assumption() {
        let short = crate::types::Tool { cutting_length_mm: 12.0, ..Default::default() };
        assert!(
            reach_rejection(&short, 18.0).is_some(),
            "12mm of flute cannot reach an 18mm through cut"
        );
        assert!(
            reach_rejection(&short, 4.5).is_none(),
            "the SAME cutter reaches 4.5mm — so the rejection was about the assumed depth, \
             not about the cutter"
        );
    }

    /// The words are asserted, not just the flag: a reader sees the sentence,
    /// never the enum, and the sentence must name the escape.
    #[test]
    fn the_assumed_note_names_the_escape_and_the_reason() {
        let n = DepthSource::AssumedThroughStock.note();
        assert!(n.contains("ASSUMED"), "{n}");
        assert!(n.contains("--depth"), "an assumption with no escape is a dead end: {n}");
        assert!(n.contains("no Z"), "it must say WHY it is assumed: {n}");
        assert_eq!(DepthSource::Declared.note(), "declared");
    }
}
