//! Route ordering — reduce the rapid travel BETWEEN operations without moving
//! anything the safety rules already decided.
//!
//! Copyright (C) 2026 2BEE FARM PTY LTD.
//! Licensed under the GNU Affero General Public License v3 or later.
//!
//! # What this is, said plainly
//!
//! Ordering cuts to minimise travel is a travelling-salesman problem. **Nothing
//! in this file is optimal and nothing in it is named "optimal".** What it does
//! is: nearest-neighbour from the previous exit point, then a bounded 2-opt
//! pass, inside a set of constraints it is not allowed to trade against. The
//! claim it supports is *"shorter than the order it was given, measured"* —
//! [`RouteReport::link_travel_before_mm`] and
//! [`RouteReport::link_travel_after_mm`] are the measurement, and
//! [`RouteReport::basis`] says exactly what those two numbers do and do not
//! include.
//!
//! # Why reordering is safe to do here, and what makes it safe
//!
//! 🔴 **This module moves no coordinate.** It permutes a `Vec<Operation>`; it
//! never edits a contour, a depth, a tab, a lead or a direction. So every gate
//! that inspects geometry — fixture keepout (P7), tabs (P1), climb direction
//! (G-DIR), travel limits — sees the *same set of moves* it would have seen,
//! only in a different sequence. That is the entire argument for running this
//! BEFORE those gates, and it is why it is not a substitute for any of them.
//! **Run it first. Never instead.**
//!
//! # The four constraints. None of them is tradeable for travel.
//!
//! 1. **Every interior feature of a part is cut before that part's outer
//!    profile.** Cut the outline first and the part is loose; everything after
//!    is cutting a part held by its tabs alone. Encoded as a hard precedence
//!    edge, and re-checked on the OUTPUT (not on the intent) by
//!    `verify_interior_before_outer`, whose findings land in
//!    [`RouteReport::refusals`] — **a refusal, not a warning** (TODO #33,
//!    decision option 4, founder-approved 2026-08-09).
//! 2. **Operations stay grouped by tool, and the GROUPS are ordered so a tool
//!    doing interior work runs before the tool that releases the part.** A job
//!    with N distinct tools costs N−1 changes, and this module cannot make it
//!    N. Interleaving tools to save rapid buys seconds of travel and pays a
//!    minute of operator time plus a Z re-reference per extra change.
//!    ⚠ **What changed on 2026-08-09:** this rule used to end at "grouped by
//!    tool in first-appearance order", and first appearance is a property of
//!    how the *caller* happened to build the vector — so the same three
//!    operations, the same two tools and the same single tool change were safe
//!    or lethal depending on input order. The groups are now **topologically
//!    sorted** on the edge `tool(interior of P) → tool(release of P)`, ties
//!    broken by first appearance so the result stays deterministic (gate K3).
//!    **This buys the safety for zero extra tool changes** on every job shape
//!    this lane produces — see `docs/decision-33-tool-grouping-vs-part-restraint.md`,
//!    Part 3. The output is still emitted already grouped by tool, so
//!    `toolpath::group_by_tool` downstream preserves this order instead of
//!    undoing it.
//! 3. **Shallow before deep, within a part.** ⚠ NOT in the request — found by
//!    reading `toolpath::order_operations`, which sorts interior features
//!    *"deepest last so shallow work happens while the workpiece is at its most
//!    rigid"*. A free nearest-neighbour reorder silently overturns that. So two
//!    interior features of the same part may only swap when their total depths
//!    are equal (within [`DEPTH_EPS_MM`]). Uniform-depth panels — the case with
//!    the travel to save — are therefore fully free, and a mixed-depth part
//!    keeps its stiffness ordering.
//!    Where rule 3 and rule 1 disagree (an interior feature deeper than the
//!    outer profile), **rule 1 wins**: depth precedence is applied only between
//!    two interior features, never between an interior feature and an outer
//!    profile. Keeping the part held down beats keeping the workpiece stiff.
//! 4. **An operation this module cannot reason about is a BARRIER, not a
//!    guess.** No anchor point (empty contour), or no part it can be attributed
//!    to, and it stays at exactly the index it arrived at and nothing crosses
//!    it. Every one of them is NAMED in [`RouteReport::pinned`]. An
//!    unattributable operation that got quietly shuffled is the failure this
//!    rule exists to prevent.
//!
//! # What it cannot know
//!
//! * **Where the tool is when the program starts.** The post decides that. So
//!   the very first operation is left where the caller put it and everything
//!   after it is what gets improved.
//! * **Where the machine goes for a tool change.** The link across a change is
//!   counted as exit→entry in XY like any other, which is wrong in an unknown
//!   direction. Named in [`TravelBasis::blind_spots`] rather than hidden.
//! * **The rapid distance in the emitted program.** That is `job.rs`'s number,
//!   read back out of the G-code text. This module's number is a different,
//!   smaller thing — see [`TravelBasis`]. **A caller that wants to report the
//!   real reduction posts the job twice and subtracts;** this report is what
//!   lets it say *why* the number moved.

use crate::toolpath::{Operation, Refusal};
use crate::types::{CutSide, OpType, Vec2};

/// Two interior features of the same part count as the same depth — and so may
/// swap — when their total depths agree to within this.
pub const DEPTH_EPS_MM: f64 = 1e-6;

/// A point must be inside an outer profile's bounding box by more than this to
/// be attributed to it. Negative would attribute features sitting exactly on
/// the boundary; zero attributes them; a small positive slack attributes a hole
/// whose start vertex lands a hair outside because of arc extents.
pub const ATTRIBUTION_SLACK_MM: f64 = 1e-6;

/// 2-opt is skipped on any segment longer than this. It costs O(n³) here
/// because an open contour's entry and exit differ, so a reversal changes the
/// interior link costs too and there is no cheap delta. A skip is REPORTED
/// ([`RouteReport::two_opt_skipped`]) — silence would read as "it ran".
pub const TWO_OPT_MAX_OPS: usize = 96;

/// Improvement passes before giving up, even if the last one still improved.
pub const TWO_OPT_MAX_PASSES: usize = 8;

pub const ROUTE_METHOD: &str =
    "HEURISTIC: nearest-neighbour from the previous exit point, then a bounded 2-opt pass, \
     inside hard precedence constraints (interior features before their own outer profile; \
     shallow before deep within a part; tool grouping preserved). NOT optimal — ordering cuts \
     to minimise travel is a travelling-salesman problem and this does not solve it";

// ---------------------------------------------------------------------------
// What the two numbers mean
// ---------------------------------------------------------------------------

/// What [`RouteReport`]'s travel figures were computed from, and what they are
/// blind to.
///
/// Carried as data rather than left in a doc comment for the same reason
/// `job::EstimateBasis` is: a caller deciding how loudly to hedge should not
/// have to read this file to find out.
#[derive(Clone, Debug)]
pub struct TravelBasis {
    /// Always `false`. These numbers are computed from the PLAN — contour
    /// anchor points — not by parsing emitted G-code. `job::JobSummary`'s
    /// `rapid_distance_mm` is the emitted-program figure and is a different,
    /// larger number.
    pub from_emitted_program: bool,
    /// Always `true`. Only the link travel BETWEEN operations is counted: the
    /// rapid inside an operation (lead-ins, tab lifts, pass-to-pass returns) is
    /// unchanged by reordering, so including it would dilute the reduction with
    /// a constant.
    pub inter_operation_only: bool,
    /// Always `true`. Z is not counted. Every link is a retract to safe Z, a
    /// traverse and a plunge; the Z part is the same whatever the order.
    pub xy_only: bool,
    /// Always `true`. The "before" figure is measured on the input **already
    /// grouped by tool**, because `job.rs` groups it downstream whether this
    /// module runs or not. Measuring against the raw ungrouped input would
    /// credit this module with the grouping's saving, which it did not make.
    pub before_is_tool_grouped: bool,
    /// Operations whose anchor is the contour's first vertex rather than the
    /// point the tool actually enters at. The real entry is on the offset path,
    /// up to one tool radius away.
    pub anchored_on_unoffset_contour: usize,
    /// Links counted here that the machine will not actually travel that way.
    pub blind_spots: Vec<&'static str>,
}

impl Default for TravelBasis {
    fn default() -> Self {
        Self {
            from_emitted_program: false,
            inter_operation_only: true,
            xy_only: true,
            before_is_tool_grouped: true,
            anchored_on_unoffset_contour: 0,
            blind_spots: vec![
                "the link across a tool change is counted exit->entry in XY; the machine really \
                 visits the change position, which this module cannot know",
                "the program's start position is unknown, so no travel is charged before the \
                 first operation",
                "an operation's anchor is a point on its unoffset contour, so every link is out \
                 by up to one tool radius at each end",
            ],
        }
    }
}

/// What the reorder did, and what it refused to touch.
#[derive(Clone, Debug)]
pub struct RouteReport {
    pub method: &'static str,
    pub basis: TravelBasis,

    pub operations: usize,
    pub tool_groups: usize,
    /// N−1 for N tool groups. Reported twice on purpose: equal before and after
    /// is the *check*, not an assumption.
    pub tool_changes_before: usize,
    pub tool_changes_after: usize,

    /// `false` when the output sequence is the input sequence. A one-operation
    /// job is `false` — it was not "optimised by 0%", there was nothing to
    /// order.
    pub reordered: bool,
    /// How many operations ended up at a different index than they started.
    pub moved_operations: usize,

    pub link_travel_before_mm: f64,
    pub link_travel_after_mm: f64,

    /// Runs of freely-orderable operations the search actually worked on.
    pub segments_considered: usize,
    pub two_opt_passes: usize,
    /// Segments 2-opt was not run on, and why. Named so a caller can see the
    /// heuristic was weaker here rather than assume it ran everywhere.
    pub two_opt_skipped: Vec<String>,

    /// Operations left exactly where they arrived, and why. Each one is also a
    /// barrier: nothing was moved across it.
    pub pinned: Vec<String>,
    /// 🔴 **FATAL.** A part that is still worked on after the operation that
    /// releases it, measured on the FINAL order this module emitted.
    ///
    /// These used to be `warnings`, and `job::report_route` used to copy them
    /// into `notes` — a 🔴 in front of a program that would still run and still
    /// be posted. Since TODO #33 the ordering below removes the *ordinary*
    /// cause of them (tool groups in accident-of-input order), so what is left
    /// here is a residue no grouped order can fix: a precedence **cycle**
    /// between two tools, or a part released inside the very group that must
    /// work on it again. **The lane's rule is refuse rather than approximate**,
    /// and a residue that cannot be ordered correctly is exactly the case the
    /// rule is about. `job::report_route` turns each of these into a
    /// [`crate::toolpath::Refusal`], which makes `JobResult::is_runnable()`
    /// false and stops any G-code being emitted at all.
    pub refusals: Vec<Refusal>,
    /// 🔴 Physical hazards found while ordering that are NOT fatal. These are
    /// findings about the INPUT, not things this module did.
    ///
    /// ⚠ The interior-before-release finding no longer lands here — it is in
    /// [`RouteReport::refusals`]. Left in place because other findings may want
    /// it and because an empty vector is a truthful answer; **it is not a
    /// second, quieter channel for the same fact.**
    pub warnings: Vec<String>,
    pub notes: Vec<String>,
}

impl Default for RouteReport {
    fn default() -> Self {
        Self {
            method: ROUTE_METHOD,
            basis: TravelBasis::default(),
            operations: 0,
            tool_groups: 0,
            tool_changes_before: 0,
            tool_changes_after: 0,
            reordered: false,
            moved_operations: 0,
            link_travel_before_mm: 0.0,
            link_travel_after_mm: 0.0,
            segments_considered: 0,
            two_opt_passes: 0,
            two_opt_skipped: Vec::new(),
            pinned: Vec::new(),
            refusals: Vec::new(),
            warnings: Vec::new(),
            notes: Vec::new(),
        }
    }
}

impl RouteReport {
    /// Millimetres of link travel removed. Negative would mean the reorder made
    /// it worse — which the search never accepts, so a negative value is a bug
    /// report, not a result.
    pub fn reduction_mm(&self) -> f64 {
        self.link_travel_before_mm - self.link_travel_after_mm
    }

    /// Percentage reduction, or `None` when there was no travel to reduce.
    ///
    /// 🔴 `None` rather than `0.0`. A single-operation job has no link travel
    /// at all, and reporting "0% improvement" on it states that an optimisation
    /// ran and found nothing — which is a different, false claim.
    pub fn reduction_pct(&self) -> Option<f64> {
        if self.link_travel_before_mm <= 0.0 {
            return None;
        }
        Some(100.0 * self.reduction_mm() / self.link_travel_before_mm)
    }
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/// Where an operation starts and where it finishes, in XY.
#[derive(Clone, Copy, Debug)]
struct Anchor {
    entry: Vec2,
    exit: Vec2,
}

/// A drill is at its centre. A closed contour returns to where it started, so
/// entry and exit are the same point. An OPEN contour — an engraved line —
/// finishes at the far end, and pretending otherwise is what makes a route
/// planner order a set of engravings badly.
///
/// Returns `None` for an operation with no usable point, which pins it.
fn anchor_of(op: &Operation) -> Option<Anchor> {
    if op.params.op_type == OpType::Drill {
        if let Some((cx, cy, _)) = op.contour.as_circle() {
            let p = Vec2::new(cx, cy);
            return Some(Anchor { entry: p, exit: p });
        }
    }
    let first = op.contour.verts.first()?;
    let entry = Vec2::new(first.x, first.y);
    let exit = if op.contour.closed {
        entry
    } else {
        let last = op.contour.verts.last()?;
        Vec2::new(last.x, last.y)
    };
    Some(Anchor { entry, exit })
}

fn dist(a: Vec2, b: Vec2) -> f64 {
    ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
}

// ---------------------------------------------------------------------------
// Part attribution
// ---------------------------------------------------------------------------

/// Per-operation facts the ordering needs. Index is into the caller's `ops`.
#[derive(Clone, Debug)]
struct Rec {
    idx: usize,
    /// Index of the outer-profile operation this belongs to. An outer profile
    /// is its own part. `None` = unattributable ⇒ pinned.
    part: Option<usize>,
    is_outer: bool,
    depth_mm: f64,
    anchor: Option<Anchor>,
}

/// Which operation is an outer profile, and which part each other operation
/// belongs to.
///
/// 🔴 The signal for "outer profile" is `CutSide::Outside`, not the operation's
/// name. `toolpath::order_operations` keys on a name string supplied by the
/// caller; that works inside `operations_for_part`, which builds the names, and
/// does not survive a job assembled from imported DXF where nobody promised a
/// naming convention. `CutSide` is a machining fact the planner already relies
/// on for the offset sign.
///
/// Attribution is by bounding-box containment of the entry anchor, smallest box
/// wins so a part nested inside a frame goes to the part. **Ambiguous (two
/// equally small boxes) or contained by none ⇒ `None` ⇒ pinned.** Guessing here
/// would mean guessing which outline has to stay uncut, which is the one thing
/// that must not be guessed.
///
/// # ⚠ `CutSide::Outside` is a HEURISTIC for "this operation releases the part",
/// not a proof
///
/// It is right for the shape this lane cuts — a part whose own outline frees it
/// from the workpiece — and it is **wrong for at least one real shape**: a small
/// part nested inside a LARGER part's hole is freed the moment that hole is
/// cut, and that hole is `CutSide::Inside`. Estlcam automates the same rule and
/// documents the same failure (`docs/decision-33-…`, Part 1.1). Anything built
/// on this classifier — including the group ordering in [`order_groups`] —
/// inherits the blind spot, which is exactly why
/// [`verify_interior_before_outer`] still runs on the emitted order afterwards
/// instead of being deleted once the ordering "fixed" the problem.
/// **What neither of them can see is a release that is not an outer profile.**
fn attribute(ops: &[Operation]) -> Vec<Rec> {
    struct Box_ {
        idx: usize,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        area: f64,
    }

    let mut boxes: Vec<Box_> = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        if op.params.side != CutSide::Outside {
            continue;
        }
        if let Some((min_x, min_y, max_x, max_y)) = op.contour.bounds() {
            boxes.push(Box_ {
                idx: i,
                min_x,
                min_y,
                max_x,
                max_y,
                area: (max_x - min_x) * (max_y - min_y),
            });
        }
    }

    ops.iter()
        .enumerate()
        .map(|(i, op)| {
            let anchor = anchor_of(op);
            let is_outer = op.params.side == CutSide::Outside;
            let part = if is_outer {
                // An outer profile with no bounds never made it into `boxes`,
                // so it cannot host anything — but it is still its own part.
                Some(i)
            } else {
                anchor.and_then(|a| {
                    let p = a.entry;
                    let mut best: Option<&Box_> = None;
                    let mut tied = false;
                    for b in &boxes {
                        let inside = p.x >= b.min_x - ATTRIBUTION_SLACK_MM
                            && p.x <= b.max_x + ATTRIBUTION_SLACK_MM
                            && p.y >= b.min_y - ATTRIBUTION_SLACK_MM
                            && p.y <= b.max_y + ATTRIBUTION_SLACK_MM;
                        if !inside {
                            continue;
                        }
                        match best {
                            None => {
                                best = Some(b);
                                tied = false;
                            }
                            Some(cur) => {
                                if b.area < cur.area - 1e-9 {
                                    best = Some(b);
                                    tied = false;
                                } else if (b.area - cur.area).abs() <= 1e-9 {
                                    tied = true;
                                }
                            }
                        }
                    }
                    if tied {
                        None
                    } else {
                        best.map(|b| b.idx)
                    }
                })
            };
            Rec { idx: i, part, is_outer, depth_mm: op.params.depth_total_mm, anchor }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Which tool group runs first
// ---------------------------------------------------------------------------

/// `(before, after)` pairs over TOOL GROUPS: the group doing interior work on a
/// part must run before the group that releases it.
///
/// Only cross-group pairs produce an edge. Two features of the same part cut
/// with the same tool are already ordered by [`precedence_edges`] inside the
/// group, and an edge from a group to itself would be a false cycle.
///
/// ⚠ Built on the `CutSide::Outside` release heuristic — see [`attribute`] for
/// what that cannot see.
fn group_precedence(recs: &[Rec], group_of: &[usize]) -> Vec<(usize, usize)> {
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for r in recs {
        if r.is_outer {
            continue;
        }
        let Some(part) = r.part else { continue };
        let (gi, gr) = (group_of[r.idx], group_of[part]);
        if gi != gr && !edges.contains(&(gi, gr)) {
            edges.push((gi, gr));
        }
    }
    edges
}

/// Topologically sort the tool groups.
///
/// `Ok(order)` — a group order in which no tool releases a part another tool
/// still has work inside. Ties break by **lowest group index**, i.e. first
/// appearance, so the result is deterministic: gate K3 compares the browser's
/// bytes to the CLI's and an order that depended on iteration luck would make
/// that a coin toss.
///
/// `Err(cycle)` — the groups still unplaced when no edge-free group remained.
/// That is a genuine cycle (tool A does P's interior and Q's release while tool
/// B does Q's interior and P's release) and **no grouped order satisfies the
/// rule**. The caller does not paper over it: it keeps first-appearance order,
/// which makes [`verify_interior_before_outer`] fire on the emitted order, and
/// that becomes a refusal.
fn order_groups(n_groups: usize, edges: &[(usize, usize)]) -> Result<Vec<usize>, Vec<usize>> {
    let mut placed = vec![false; n_groups];
    let mut order: Vec<usize> = Vec::with_capacity(n_groups);

    while order.len() < n_groups {
        // Lowest unplaced group with every predecessor already placed.
        let next = (0..n_groups).find(|&g| {
            !placed[g] && edges.iter().all(|(a, b)| *b != g || placed[*a])
        });
        match next {
            Some(g) => {
                placed[g] = true;
                order.push(g);
            }
            None => return Err((0..n_groups).filter(|&g| !placed[g]).collect()),
        }
    }
    Ok(order)
}

// ---------------------------------------------------------------------------
// The knob — and it exists for ONE reason
// ---------------------------------------------------------------------------

/// How the tool GROUPS are ordered relative to one another.
///
/// 🔴 **This enum is a negative-control knob, not a user setting.** There is one
/// correct value and it is the default; the other reproduces a hazard on
/// purpose. Nothing in the UI, the config file or any CLI flag reaches it —
/// [`crate::fixtures::JobPlant::ReleaseOrder`] is the only thing that sets it,
/// and gate **REL** is the only thing that drives that plant.
///
/// It is here rather than in the gate because the gate had no way to produce
/// this defect at all: `optimise_route` called [`order_groups`] unconditionally,
/// so REL's control had to be *rebuilt in JavaScript* from the core's own note.
/// A control that reconstructs what it is checking is asserting on its own
/// arithmetic; this one asserts on a program the core really emitted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum GroupOrder {
    /// Topologically sorted on `tool(interior of P) → tool(release of P)`, ties
    /// broken by first appearance. The only value any real job uses.
    #[default]
    ReleaseSorted,
    /// 🔴 **PLANTED DEFECT.** The pre-2026-08-09 behaviour: tool groups run in
    /// the order they happened to appear in the caller's operation vector, so
    /// whether a part's outline is cut before or after its own holes is decided
    /// by nothing anybody chose.
    ///
    /// It does not merely skip the sort — it **reports whether skipping it
    /// changed anything on this job**, because a plant driven on a job whose
    /// first-appearance order was already safe would run clean and read as a
    /// passing control. That is the exact failure `--plant` exists to prevent,
    /// so the answer is stated in the report rather than left for a gate to
    /// infer from an exit code.
    FirstAppearance,
}

/// Emitted by [`optimise_route_with`] under [`GroupOrder::FirstAppearance`], and
/// the token a control must assert on. `YES` means the plant genuinely moved the
/// group order on this job; `NO` means it did not, and any control hung on it is
/// vacuous.
pub const PLANT_DIFFERENCE_KEY: &str = "planted-difference:";

// ---------------------------------------------------------------------------
// The reorder
// ---------------------------------------------------------------------------

/// [`optimise_route_with`] with the only group ordering a real job may use.
///
/// Kept as the plain entry point so every caller that has no business choosing
/// an ordering cannot accidentally choose the wrong one.
pub fn optimise_route(ops: Vec<Operation>) -> (Vec<Operation>, RouteReport) {
    optimise_route_with(ops, GroupOrder::ReleaseSorted)
}

/// Reorder `ops` to shorten the rapid travel between them, without breaking
/// anything in the module header's constraint list.
///
/// Returns the new order and a report carrying the measured before/after link
/// travel, everything it refused to move, and every hazard it noticed on the
/// way.
///
/// The output is **already grouped by tool**, in first-appearance order, so
/// `toolpath::group_by_tool` downstream preserves it rather than undoing it.
///
/// It is deterministic: every tie — equal distance, equal depth — breaks by the
/// caller's original index, and nothing iterates a hash map. Two hosts running
/// the same core must produce the same order, or gate K3's byte parity is a
/// coin toss.
///
/// 🔴 `group_order_mode` is a **negative-control knob** — see [`GroupOrder`].
/// Pass [`GroupOrder::ReleaseSorted`], or call [`optimise_route`], which is the
/// same thing without the opportunity to get it wrong.
pub fn optimise_route_with(
    ops: Vec<Operation>,
    group_order_mode: GroupOrder,
) -> (Vec<Operation>, RouteReport) {
    let mut report = RouteReport { operations: ops.len(), ..RouteReport::default() };

    // Tool groups, first-appearance order. Same keying as
    // `toolpath::group_by_tool` (tool NAME), so the two agree about what a
    // group is.
    let mut group_names: Vec<String> = Vec::new();
    let mut group_of: Vec<usize> = Vec::with_capacity(ops.len());
    for op in &ops {
        let g = match group_names.iter().position(|n| *n == op.tool.name) {
            Some(g) => g,
            None => {
                group_names.push(op.tool.name.clone());
                group_names.len() - 1
            }
        };
        group_of.push(g);
    }
    report.tool_groups = group_names.len();
    report.tool_changes_before = group_names.len().saturating_sub(1);
    report.tool_changes_after = report.tool_changes_before;

    if ops.len() < 2 {
        report.notes.push(
            "fewer than two operations — there is no travel between operations to shorten, so \
             the order is returned unchanged. This is NOT a 0% improvement."
                .into(),
        );
        return (ops, report);
    }

    let recs = attribute(&ops);
    report.basis.anchored_on_unoffset_contour = recs
        .iter()
        .filter(|r| r.anchor.is_some() && ops[r.idx].params.op_type != OpType::Drill)
        .count();

    // The baseline order: the input, grouped by tool. This is what would run if
    // this module did not exist, so it is what the "before" figure must measure.
    let mut baseline: Vec<usize> = Vec::with_capacity(ops.len());
    for g in 0..group_names.len() {
        for (i, _) in ops.iter().enumerate() {
            if group_of[i] == g {
                baseline.push(i);
            }
        }
    }
    report.link_travel_before_mm = link_travel(&baseline, &recs);

    // ---- WHICH GROUP RUNS FIRST (TODO #33) --------------------------------
    //
    // 🔴 This is the whole fix, and it costs nothing. Before 2026-08-09 the
    // loop below walked `0..group_names.len()` — first-appearance order — so
    // whether the tool that cuts a part's outline ran before or after the tool
    // that drills its holes was decided by how the caller happened to build the
    // vector. Same operations, same tools, same single tool change, and a
    // program that is safe or lethal depending on nothing that anybody chose.
    let g_edges = group_precedence(&recs, &group_of);
    let sorted = order_groups(group_names.len(), &g_edges);

    // 🔴 THE NEGATIVE CONTROL, and it is deliberately NOT a bare `if`.
    //
    // Skipping the sort is easy; skipping it *and being able to prove the skip
    // mattered* is the part this lane owed. So the plant still computes what the
    // sort WOULD have produced — it just does not apply it — and then states
    // whether the two differ. A plant driven on `plate`, `pocket`, `socket`,
    // `multi-tool` or `clamped` says `NO`: those five produce no reorder at all,
    // so a control hung on any of them would run clean and read as passing. That
    // is the vacuous control this flag exists to prevent, and it is now said out
    // loud in the report instead of being left for a gate to infer from an exit
    // code that could have moved for a dozen other reasons.
    let planted_order: Option<Vec<usize>> = if group_order_mode == GroupOrder::FirstAppearance {
        let kept: Vec<usize> = (0..group_names.len()).collect();
        let name_list = |v: &[usize]| -> String {
            v.iter().map(|g| group_names[*g].as_str()).collect::<Vec<_>>().join(", ")
        };
        let (would, differs) = match &sorted {
            Ok(o) => (name_list(o), *o != kept),
            Err(_) => ("<none — the groups form a precedence cycle>".to_string(), false),
        };
        report.notes.push(format!(
            "🔴 PLANTED (release-order): the tool-group sort was NEUTERED and the pre-2026-08-09 \
             first-appearance order is kept: {}. The release-sorted order would have been: {}. \
             {} {}",
            name_list(&kept),
            would,
            PLANT_DIFFERENCE_KEY,
            if differs {
                "YES — this job really does exercise the group reorder, so the release hazard \
                 below is the one that was planted and not an accident of the fixture"
            } else {
                "NO — the two orders are identical, so this plant changed NOTHING on this job and \
                 any control hung on it is VACUOUS: it would run clean and read as a passing \
                 control"
            }
        ));
        Some(kept)
    } else {
        None
    };

    let group_order = if let Some(kept) = planted_order {
        kept
    } else {
        match sorted {
            Ok(o) => {
                if o.iter().enumerate().any(|(k, g)| k != *g) {
                    let before: Vec<&str> =
                        group_names.iter().map(String::as_str).collect();
                    let after: Vec<&str> =
                        o.iter().map(|g| group_names[*g].as_str()).collect();
                    report.notes.push(format!(
                        "tool groups reordered so interior work precedes the tool that releases \
                         the part: {} -> {}. The number of tool changes is UNCHANGED ({}) — this \
                         is a different order of the same groups, not a broken grouping",
                        before.join(", "),
                        after.join(", "),
                        report.tool_changes_after
                    ));
                }
                o
            }
            Err(cycle) => {
                // Refuse rather than approximate. Keeping first-appearance order
                // here is NOT a fallback that hides the problem: it is the order
                // that makes `verify_interior_before_outer` fire below, and that
                // finding is fatal.
                let names: Vec<&str> =
                    cycle.iter().map(|g| group_names[*g].as_str()).collect();
                report.notes.push(format!(
                    "🔴 the tool groups ({}) form a PRECEDENCE CYCLE — each of them releases a \
                     part another one still has interior work inside, so NO order of these groups \
                     is correct. Nothing was reordered; the job is refused below rather than run \
                     in the least-bad order",
                    names.join(", ")
                ));
                (0..group_names.len()).collect()
            }
        }
    };

    // Per group: cut the group into segments at pinned operations, order each
    // segment, splice back.
    //
    // Group ordering moves WHOLE groups, so every within-group relation
    // survives it untouched — including constraint 4's pins, which are barriers
    // inside their own group and are not crossed by moving another group past
    // them.
    let mut out: Vec<usize> = Vec::with_capacity(ops.len());
    for &g in &group_order {
        let members: Vec<usize> = baseline.iter().copied().filter(|i| group_of[*i] == g).collect();

        let mut segment: Vec<usize> = Vec::new();
        for &i in &members {
            let pinned_reason = if recs[i].anchor.is_none() {
                Some("no anchor point — the contour has no vertices, so its position is unknown")
            } else if recs[i].part.is_none() {
                Some(
                    "not attributable to a part — its start point lies inside no outer profile, \
                     or inside two of equal size",
                )
            } else {
                None
            };

            match pinned_reason {
                None => segment.push(i),
                Some(why) => {
                    flush_segment(&mut segment, &mut out, &recs, &mut report);
                    report.pinned.push(format!("{}: {}", ops[i].name, why));
                    out.push(i);
                }
            }
        }
        flush_segment(&mut segment, &mut out, &recs, &mut report);
    }

    report.link_travel_after_mm = link_travel(&out, &recs);
    report.moved_operations =
        baseline.iter().zip(out.iter()).filter(|(a, b)| a != b).count();
    report.reordered = report.moved_operations > 0;

    // 🔴 Assert the safety property on the RESULT, never on the intent — and
    // keep asserting it now that the ordering above is supposed to make it
    // true. **A control that is deleted because the bug it caught was fixed
    // stops covering the case the fix does not reach**, and this one has a
    // named case: the release classifier is `CutSide::Outside`, so a small part
    // freed by a LARGER part's hole is released during the interior phase and
    // the group ordering buys it nothing (see [`attribute`]).
    //
    // Anything still standing here is FATAL, not a note. See
    // [`RouteReport::refusals`].
    report.refusals.extend(verify_interior_before_outer(&out, &recs, &ops));

    // The part map, emitted so a gate can cross-check the EMITTED program's
    // section order against it without re-deriving part attribution from a
    // naming convention the core deliberately does not use. One line, stable
    // shape: `route-parts: <release-op><-<interior>|<interior>; …`.
    // ⚠ An operation name containing `<-`, `|` or `; ` would make this line
    // ambiguous. Names come from the caller; nothing here can stop that, so it
    // is said out loud rather than assumed away.
    {
        let mut parts: Vec<String> = Vec::new();
        for r in recs.iter().filter(|r| r.is_outer) {
            let inner: Vec<&str> = recs
                .iter()
                .filter(|c| !c.is_outer && c.part == Some(r.idx))
                .map(|c| ops[c.idx].name.as_str())
                .collect();
            if !inner.is_empty() {
                parts.push(format!("{}<-{}", ops[r.idx].name, inner.join("|")));
            }
        }
        if !parts.is_empty() {
            report.notes.push(format!("route-parts: {}", parts.join("; ")));
        }
    }

    if !report.reordered {
        report.notes.push(
            "the order was already the one this heuristic would have chosen — nothing moved"
                .into(),
        );
    }

    let reordered: Vec<Operation> = {
        let mut slots: Vec<Option<Operation>> = ops.into_iter().map(Some).collect();
        out.iter().map(|&i| slots[i].take().expect("each index placed exactly once")).collect()
    };

    (reordered, report)
}

/// Order one run of freely-movable operations and append it to `out`.
fn flush_segment(
    segment: &mut Vec<usize>,
    out: &mut Vec<usize>,
    recs: &[Rec],
    report: &mut RouteReport,
) {
    if segment.is_empty() {
        return;
    }
    let seg = std::mem::take(segment);
    if seg.len() == 1 {
        out.push(seg[0]);
        return;
    }
    report.segments_considered += 1;

    // Seed. The program's start position is unknown, so the first segment of
    // the whole job starts from its own first operation — which leaves that
    // operation where the caller put it and improves everything after it.
    let seed = match out.last() {
        Some(&prev) => recs[prev].anchor.map(|a| a.exit),
        None => recs[seg[0]].anchor.map(|a| a.entry),
    };

    let edges = precedence_edges(&seg, recs);
    let mut order = nearest_neighbour(&seg, recs, seed, &edges);

    if seg.len() > TWO_OPT_MAX_OPS {
        report.two_opt_skipped.push(format!(
            "segment of {} operations exceeds TWO_OPT_MAX_OPS={}; nearest-neighbour only, so \
             this run is ordered more weakly than the rest",
            seg.len(),
            TWO_OPT_MAX_OPS
        ));
    } else {
        report.two_opt_passes += two_opt(&mut order, recs, seed, &edges);
    }

    out.extend(order);
}

/// `(before, after)` pairs that the ordering may not invert.
///
/// Two rules, and where they collide the first one wins:
///   * every interior feature of a part precedes that part's own outer profile;
///   * within a part, a shallower interior feature precedes a deeper one.
///
/// The second is deliberately NOT applied between an interior feature and an
/// outer profile: an interior pocket deeper than the outline would otherwise
/// generate an edge saying "cut the outline first", which is the exact failure
/// the first rule exists to stop.
fn precedence_edges(seg: &[usize], recs: &[Rec]) -> Vec<(usize, usize)> {
    let mut edges = Vec::new();
    for (a_pos, &a) in seg.iter().enumerate() {
        for &b in seg.iter().skip(a_pos + 1) {
            let (ra, rb) = (&recs[a], &recs[b]);
            if ra.part != rb.part {
                continue;
            }
            match (ra.is_outer, rb.is_outer) {
                (false, true) => edges.push((a, b)),
                (true, false) => edges.push((b, a)),
                (true, true) => {}
                (false, false) => {
                    if ra.depth_mm < rb.depth_mm - DEPTH_EPS_MM {
                        edges.push((a, b));
                    } else if rb.depth_mm < ra.depth_mm - DEPTH_EPS_MM {
                        edges.push((b, a));
                    }
                }
            }
        }
    }
    edges
}

fn feasible(order: &[usize], edges: &[(usize, usize)]) -> bool {
    edges.iter().all(|(a, b)| {
        match (order.iter().position(|x| x == a), order.iter().position(|x| x == b)) {
            (Some(pa), Some(pb)) => pa < pb,
            _ => true,
        }
    })
}

/// Greedy nearest-neighbour, restricted at every step to operations whose
/// predecessors are already placed. Ties break by original index so the result
/// does not depend on iteration luck.
fn nearest_neighbour(
    seg: &[usize],
    recs: &[Rec],
    seed: Option<Vec2>,
    edges: &[(usize, usize)],
) -> Vec<usize> {
    let mut remaining: Vec<usize> = seg.to_vec();
    let mut order: Vec<usize> = Vec::with_capacity(seg.len());
    let mut cur = seed;

    while !remaining.is_empty() {
        let mut best: Option<(usize, f64)> = None;
        for (pos, &cand) in remaining.iter().enumerate() {
            let blocked = edges
                .iter()
                .any(|(a, b)| *b == cand && remaining.contains(a));
            if blocked {
                continue;
            }
            let d = match (cur, recs[cand].anchor) {
                (Some(c), Some(a)) => dist(c, a.entry),
                _ => 0.0,
            };
            match best {
                None => best = Some((pos, d)),
                Some((_, bd)) if d < bd - 1e-12 => best = Some((pos, d)),
                _ => {}
            }
        }
        // `None` would mean the precedence graph has a cycle. It cannot: both
        // rules are strict orders over the same part. Falling back to input
        // order rather than panicking keeps a hypothetical bug from throwing a
        // job away.
        let pos = best.map(|(p, _)| p).unwrap_or(0);
        let chosen = remaining.remove(pos);
        cur = recs[chosen].anchor.map(|a| a.exit).or(cur);
        order.push(chosen);
    }
    order
}

/// Cost of a segment order: seed→first entry, then each exit→next entry.
fn segment_cost(order: &[usize], recs: &[Rec], seed: Option<Vec2>) -> f64 {
    let mut total = 0.0;
    let mut cur = seed;
    for &i in order {
        if let (Some(c), Some(a)) = (cur, recs[i].anchor) {
            total += dist(c, a.entry);
        }
        if let Some(a) = recs[i].anchor {
            cur = Some(a.exit);
        }
    }
    total
}

/// 2-opt: reverse a sub-range and keep it if it is shorter AND still feasible.
///
/// Returns the number of improving passes. Reversal is checked for feasibility
/// every time rather than assumed — a reversal is exactly the operation that
/// inverts a precedence pair.
fn two_opt(
    order: &mut Vec<usize>,
    recs: &[Rec],
    seed: Option<Vec2>,
    edges: &[(usize, usize)],
) -> usize {
    let n = order.len();
    if n < 3 {
        return 0;
    }
    let mut passes = 0;
    let mut best = segment_cost(order, recs, seed);
    for _ in 0..TWO_OPT_MAX_PASSES {
        let mut improved = false;
        for i in 0..n - 1 {
            for j in i + 1..n {
                let mut cand = order.clone();
                cand[i..=j].reverse();
                if !feasible(&cand, edges) {
                    continue;
                }
                let c = segment_cost(&cand, recs, seed);
                if c < best - 1e-9 {
                    best = c;
                    *order = cand;
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
        passes += 1;
    }
    passes
}

/// Total link travel of a whole sequence, on the basis described by
/// [`TravelBasis`].
fn link_travel(order: &[usize], recs: &[Rec]) -> f64 {
    let mut total = 0.0;
    let mut cur: Option<Vec2> = None;
    for &i in order {
        if let (Some(c), Some(a)) = (cur, recs[i].anchor) {
            total += dist(c, a.entry);
        }
        if let Some(a) = recs[i].anchor {
            cur = Some(a.exit);
        }
    }
    total
}

/// Check the sequencing rule on the FINAL order and name every part that
/// breaks it. **Each finding is a refusal.**
///
/// 🔴 This runs on the OUTPUT, not on the intent, and it must keep doing so
/// even though [`order_groups`] is now supposed to make it vacuous. Two reasons,
/// and the second is the one that matters:
///
/// * The ordering can genuinely fail — a precedence **cycle** between two tools
///   has no correct grouped order at all, and this is what turns that into a
///   refusal instead of a program.
/// * **The ordering is built on a heuristic that has a named blind spot.**
///   "Releases the part" is read off `CutSide::Outside` (see [`attribute`]), so
///   a small part nested inside a LARGER part's hole is freed while that hole
///   is cut — during the interior phase, by a tool the scheme deliberately put
///   FIRST. The phase ordering buys that part nothing. This check is keyed on
///   part attribution and on the emitted position, not on the phase, so it is
///   the thing that can still catch what the ordering cannot.
///
/// ⚠ *What this doc comment said until 2026-08-09:* "Tool grouping is not
/// tradeable, so the answer is to SAY SO, not to break the grouping — the fix
/// is upstream, in which tool is assigned to which feature." That was the
/// position the founder was asked to revisit, and it is now wrong twice over:
/// the groups are ordered (nothing was broken to do it, and it cost no tool
/// change), and what is left is refused rather than said. **A stale comment
/// explaining why a control is right is the least-audited thing in the repo**,
/// so it is corrected here rather than deleted.
fn verify_interior_before_outer(
    order: &[usize],
    recs: &[Rec],
    ops: &[Operation],
) -> Vec<Refusal> {
    let mut out = Vec::new();
    let pos: Vec<usize> = {
        let mut p = vec![usize::MAX; recs.len()];
        for (k, &i) in order.iter().enumerate() {
            p[i] = k;
        }
        p
    };
    for r in recs.iter().filter(|r| r.is_outer) {
        let late: Vec<&str> = recs
            .iter()
            .filter(|c| !c.is_outer && c.part == Some(r.idx) && pos[c.idx] > pos[r.idx])
            .map(|c| ops[c.idx].name.as_str())
            .collect();
        if !late.is_empty() {
            out.push(Refusal {
                what: ops[r.idx].name.clone(),
                why: format!(
                    "it is cut before {} of its own interior features ({}) — after the outline \
                     the part is held by its tabs alone, and every cut after it is made on a \
                     part that can lift into the spindle. Ordering the tool groups did not fix \
                     it, which means no grouped order can: either these tools form a precedence \
                     cycle (each releases a part the other still works inside), or the release \
                     and the later work share one tool group. The fix is upstream — assign the \
                     interior features and the outline to tools that can be ordered, or cut this \
                     part in a separate job",
                    late.len(),
                    late.join(", ")
                ),
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Contour;
    use crate::types::{Direction, EntryMode, OperationParams, Tool};

    fn tool6() -> Tool {
        Tool { name: "6mm 2F".into(), diameter_mm: 6.0, ..Tool::default() }
    }
    fn tool3() -> Tool {
        Tool { name: "3mm 1F".into(), diameter_mm: 3.0, ..Tool::default() }
    }

    fn hole(name: &str, cx: f64, cy: f64, r: f64) -> Operation {
        let (part, role) = crate::toolpath::test_part_and_role(name);
        Operation {
            name: name.into(),
            part,
            role,
            contour: Contour::circle(cx, cy, r),
            tool: tool6(),
            params: OperationParams { side: CutSide::Inside, ..OperationParams::default() },
        }
    }

    fn outline(name: &str, x: f64, y: f64, w: f64, h: f64) -> Operation {
        let (part, role) = crate::toolpath::test_part_and_role(name);
        Operation {
            name: name.into(),
            part,
            role,
            contour: Contour::rect(x, y, w, h),
            tool: tool6(),
            params: OperationParams { side: CutSide::Outside, ..OperationParams::default() },
        }
    }

    fn names(ops: &[Operation]) -> Vec<String> {
        ops.iter().map(|o| o.name.clone()).collect()
    }

    fn index_of(ops: &[Operation], name: &str) -> usize {
        ops.iter().position(|o| o.name == name).expect("operation present")
    }

    /// 🔴 The physical one. The naive nearest-neighbour choice at step 2 IS the
    /// outer profile — the test proves that before asserting the reorder
    /// refused it — and taking it would leave the part loose for the remaining
    /// hole.
    #[test]
    fn interior_before_outer_survives_a_reorder_that_wanted_to_break_it() {
        // Part 200x100. First op is a hole in the bottom-left corner; the
        // outline's start vertex (0,0) is ~11mm away, the far hole's start
        // vertex is ~120mm away. Nearest-neighbour, left alone, cuts the
        // outline second.
        let ops = vec![hole("near", 10.0, 10.0, 5.0), hole("far", 100.0, 90.0, 5.0), outline("plate", 0.0, 0.0, 200.0, 100.0)];

        // Prove the trap is real rather than asserting it is.
        let from = Vec2::new(5.0, 10.0); // circle start vertex = (cx-r, cy)
        let to_outline = dist(from, Vec2::new(0.0, 0.0));
        let to_far = dist(from, Vec2::new(95.0, 90.0));
        assert!(
            to_outline < to_far,
            "test is not testing anything: the outline ({to_outline:.1}mm) must be the nearer \
             candidate than the remaining hole ({to_far:.1}mm)"
        );

        let (out, report) = optimise_route(ops);
        assert_eq!(names(&out).last().unwrap(), "plate", "outer profile must be LAST: {:?}", names(&out));
        assert!(
            index_of(&out, "far") < index_of(&out, "plate"),
            "the far hole was cut after the outline: {:?}",
            names(&out)
        );
        assert!(report.warnings.is_empty(), "unexpected warnings: {:?}", report.warnings);
    }

    /// Constraint 2. Tools stay grouped and the change count does not move.
    #[test]
    fn tool_grouping_survives_and_costs_no_extra_change() {
        let mut a1 = hole("a1", 20.0, 20.0, 5.0);
        let mut b1 = hole("b1", 180.0, 20.0, 5.0);
        let mut a2 = hole("a2", 20.0, 80.0, 5.0);
        let mut b2 = hole("b2", 180.0, 80.0, 5.0);
        a1.tool = tool6();
        a2.tool = tool6();
        b1.tool = tool3();
        b2.tool = tool3();
        // Interleaved on input: 6mm, 3mm, 6mm, 3mm.
        let ops = vec![a1, b1, a2, b2, outline("plate", 0.0, 0.0, 200.0, 100.0)];

        let (out, report) = optimise_route(ops);
        let tools: Vec<&str> = out.iter().map(|o| o.tool.name.as_str()).collect();
        // Contiguous runs only — no tool appears twice in non-adjacent places.
        let mut runs: Vec<&str> = Vec::new();
        for t in &tools {
            if runs.last() != Some(t) {
                runs.push(t);
            }
        }
        // ⚠ This asserted `["6mm 2F", "3mm 1F"]` — first-appearance order —
        // until TODO #33. The claim it is making is **grouping**, not order:
        // each tool appears as ONE contiguous run. The order is now decided by
        // the release precedence (the 3mm holes sit inside the part the 6mm
        // outline releases), which is a different rule tested in
        // `an_outline_cut_before_its_holes_by_tool_grouping_is_repaired_at_no_extra_tool_change`.
        // Pinning the order here would have made this test fail for the right
        // change, which is how a test stops being about what its name says.
        assert_eq!(runs.len(), 2, "tools interleaved: {tools:?}");
        assert_eq!(runs, vec!["3mm 1F", "6mm 2F"], "{tools:?}");
        assert_eq!(report.tool_groups, 2);
        assert_eq!(report.tool_changes_after, report.tool_changes_before);
        assert_eq!(report.tool_changes_after, 1);
        assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    }

    /// The point of the exercise: scattered holes in a deliberately bad order.
    #[test]
    fn rapid_travel_actually_decreases_on_scattered_holes() {
        // A 5x4 grid of holes, fed in an order that zig-zags the full width of
        // the workpiece on every step.
        let mut ops = Vec::new();
        let mut k = 0;
        for row in 0..4 {
            for col in 0..5 {
                // Alternate ends so consecutive input ops are far apart.
                let c = if k % 2 == 0 { col } else { 4 - col };
                ops.push(hole(
                    &format!("h{k}"),
                    30.0 + c as f64 * 130.0,
                    30.0 + row as f64 * 60.0,
                    5.0,
                ));
                k += 1;
            }
        }
        ops.push(outline("panel", 0.0, 0.0, 600.0, 250.0));

        let (out, report) = optimise_route(ops);
        assert_eq!(names(&out).last().unwrap(), "panel");
        assert!(report.reordered);
        assert!(
            report.link_travel_after_mm < report.link_travel_before_mm,
            "no reduction: {} -> {}",
            report.link_travel_before_mm,
            report.link_travel_after_mm
        );
        assert!(report.reduction_pct().unwrap() > 20.0, "{:?}", report.reduction_pct());
        println!(
            "MEASURED link travel {:.1}mm -> {:.1}mm ({:.1}mm, {:.1}% shorter), 2-opt passes {}",
            report.link_travel_before_mm,
            report.link_travel_after_mm,
            report.reduction_mm(),
            report.reduction_pct().unwrap(),
            report.two_opt_passes,
        );
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    }

    /// 🔴 A one-operation job is UNCHANGED, not "improved by 0%".
    #[test]
    fn a_single_feature_job_is_returned_unchanged_not_optimised_by_zero_percent() {
        let (out, report) = optimise_route(vec![outline("lonely", 0.0, 0.0, 100.0, 100.0)]);
        assert_eq!(names(&out), vec!["lonely"]);
        assert!(!report.reordered);
        assert_eq!(report.moved_operations, 0);
        assert_eq!(report.link_travel_before_mm, 0.0);
        assert_eq!(report.link_travel_after_mm, 0.0);
        assert!(
            report.reduction_pct().is_none(),
            "a percentage on a job with no travel asserts an optimisation happened"
        );
        assert!(report.notes.iter().any(|n| n.contains("NOT a 0% improvement")));
    }

    /// Constraint 3, which was not in the brief: `order_operations` puts the
    /// deepest interior feature last so shallow work happens while the workpiece is
    /// stiffest. A free reorder would undo that silently.
    #[test]
    fn shallow_before_deep_within_a_part_is_preserved() {
        let mut shallow = hole("shallow", 190.0, 90.0, 5.0);
        shallow.params.depth_total_mm = 4.0;
        let mut deep = hole("deep", 10.0, 10.0, 5.0);
        deep.params.depth_total_mm = 18.0;
        // Input order already correct; the deep hole is nearer the start, so an
        // unconstrained nearest-neighbour would pull it forward.
        let ops = vec![hole("first", 12.0, 12.0, 5.0), shallow, deep, outline("plate", 0.0, 0.0, 200.0, 100.0)];
        let mut first = ops[0].clone();
        first.params.depth_total_mm = 4.0;
        let ops = vec![first, ops[1].clone(), ops[2].clone(), ops[3].clone()];

        let (out, _) = optimise_route(ops);
        assert!(
            index_of(&out, "shallow") < index_of(&out, "deep"),
            "deep feature pulled ahead of a shallow one: {:?}",
            names(&out)
        );
    }

    /// Constraint 4: an operation this module cannot attribute is a barrier and
    /// is NAMED, not shuffled.
    #[test]
    fn an_unattributable_operation_is_pinned_and_named() {
        // A hole nowhere near any outer profile.
        let ops = vec![
            hole("in-part", 20.0, 20.0, 5.0),
            hole("orphan", 5000.0, 5000.0, 5.0),
            hole("also-in-part", 180.0, 80.0, 5.0),
            outline("plate", 0.0, 0.0, 200.0, 100.0),
        ];
        let (out, report) = optimise_route(ops);
        assert_eq!(out[1].name, "orphan", "the orphan moved: {:?}", names(&out));
        assert!(
            report.pinned.iter().any(|p| p.starts_with("orphan:")),
            "pinned operations must be named: {:?}",
            report.pinned
        );
    }

    /// 🔴 TODO #33, and the evidence that the fix is FREE.
    ///
    /// ⚠ **This test used to be named
    /// `an_outline_cut_before_its_holes_by_tool_grouping_is_reported_not_repaired`
    /// and it asserted `out[0].name == "plate"`** — the outline first, the part
    /// loose, a warning about a program that would still run. That was the
    /// documented behaviour, not an oversight: tool grouping was held to be
    /// untradeable, so the hazard was *said* rather than fixed.
    ///
    /// The decision (`docs/decision-33-…`, option 4, founder-approved
    /// 2026-08-09) found that nothing was ever being traded. The 6mm group ran
    /// first only **because the outline appeared first in the input vector**.
    /// Ordering the GROUPS puts the 3mm holes first and leaves everything else
    /// identical — which is what the tool-change assertion below is for: it was
    /// 1 before the change and it is 1 after, so the safety cost nothing.
    #[test]
    fn an_outline_cut_before_its_holes_by_tool_grouping_is_repaired_at_no_extra_tool_change() {
        let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
        plate.tool = tool6();
        let mut h1 = hole("h1", 50.0, 50.0, 5.0);
        let mut h2 = hole("h2", 150.0, 50.0, 5.0);
        h1.tool = tool3();
        h2.tool = tool3();

        // The outline still appears FIRST in the input — the condition that
        // used to decide the group order. Nothing about the input changed.
        let (out, report) = optimise_route(vec![plate, h1, h2]);

        assert_eq!(
            names(&out).last().unwrap(),
            "plate",
            "the releasing operation must be LAST: {:?}",
            names(&out)
        );
        assert!(
            index_of(&out, "h1") < index_of(&out, "plate")
                && index_of(&out, "h2") < index_of(&out, "plate"),
            "a hole is still cut after the outline: {:?}",
            names(&out)
        );
        // The tools are still grouped — 3mm run contiguous, then 6mm.
        let tools: Vec<&str> = out.iter().map(|o| o.tool.name.as_str()).collect();
        assert_eq!(tools, vec!["3mm 1F", "3mm 1F", "6mm 2F"], "{tools:?}");
        // 🔴 THE POINT. One change before, one change after.
        assert_eq!(report.tool_changes_before, 1);
        assert_eq!(
            report.tool_changes_after, 1,
            "the fix must not have cost a tool change: {:?}",
            report.tool_changes_after
        );
        assert!(
            report.refusals.is_empty(),
            "an orderable job was refused: {:?}",
            report.refusals
        );
        assert!(
            report.notes.iter().any(|n| n.contains("tool groups reordered")),
            "the group swap must be reported, not silent: {:?}",
            report.notes
        );
    }

    /// The residue option 4 cannot fix, and the reason the refusal half is not
    /// optional: tool A releases P while cutting Q's interior, tool B releases Q
    /// while cutting P's interior. **No order of two groups satisfies both.**
    #[test]
    fn a_precedence_cycle_between_two_tool_groups_is_refused_not_warned() {
        // P at x 0..200, Q at x 300..500 — disjoint boxes, so attribution is
        // unambiguous.
        let mut p = outline("P", 0.0, 0.0, 200.0, 100.0);
        let mut q = outline("Q", 300.0, 0.0, 200.0, 100.0);
        let mut p_hole = hole("P-hole", 100.0, 50.0, 5.0);
        let mut q_hole = hole("Q-hole", 400.0, 50.0, 5.0);
        // A releases P and cuts Q's interior; B releases Q and cuts P's.
        p.tool = tool6();
        q_hole.tool = tool6();
        q.tool = tool3();
        p_hole.tool = tool3();

        let (out, report) = optimise_route(vec![p, p_hole, q, q_hole]);

        assert!(
            !report.refusals.is_empty(),
            "a cycle was not refused: notes={:?} warnings={:?}",
            report.notes,
            report.warnings
        );
        assert!(
            report.refusals.iter().any(|r| r.what == "P" || r.what == "Q"),
            "the refusal must NAME the part: {:?}",
            report.refusals
        );
        assert!(
            report.refusals.iter().any(|r| r.why.contains("P-hole") || r.why.contains("Q-hole")),
            "the refusal must NAME the operations left stranded: {:?}",
            report.refusals
        );
        assert!(
            report.notes.iter().any(|n| n.contains("PRECEDENCE CYCLE")),
            "the cycle itself must be named: {:?}",
            report.notes
        );
        // It did not silently reorder into a least-bad guess.
        assert_eq!(out.len(), 4);
    }

    /// A job with one tool cannot have a group-order problem, and must not
    /// acquire a note claiming one was fixed. A control that announces work it
    /// did not do is the reason nobody reads the notes.
    #[test]
    fn a_single_tool_job_reports_no_group_reorder_and_no_refusal() {
        let ops = vec![
            hole("h1", 50.0, 50.0, 5.0),
            hole("h2", 150.0, 50.0, 5.0),
            outline("plate", 0.0, 0.0, 200.0, 100.0),
        ];
        let (_, report) = optimise_route(ops);
        assert_eq!(report.tool_groups, 1);
        assert!(report.refusals.is_empty(), "{:?}", report.refusals);
        assert!(
            !report.notes.iter().any(|n| n.contains("tool groups reordered")),
            "claimed a reorder on a one-tool job: {:?}",
            report.notes
        );
    }

    /// Constraint 4 survives the group reorder. A pinned operation is a barrier
    /// **inside its own group**; moving whole groups cannot cross it.
    #[test]
    fn a_pinned_operation_keeps_its_place_inside_a_group_that_moved() {
        let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
        plate.tool = tool6();
        let mut h1 = hole("h1", 50.0, 50.0, 5.0);
        let mut orphan = hole("orphan", 5000.0, 5000.0, 5.0);
        let mut h2 = hole("h2", 150.0, 50.0, 5.0);
        h1.tool = tool3();
        orphan.tool = tool3();
        h2.tool = tool3();

        // Outline first again, so the 6mm group has to be moved to the back.
        let (out, report) = optimise_route(vec![plate, h1, orphan, h2]);
        let n = names(&out);
        assert_eq!(n.last().unwrap(), "plate", "{n:?}");
        // The orphan sits where it arrived within its group: after h1, before h2.
        assert!(
            index_of(&out, "h1") < index_of(&out, "orphan")
                && index_of(&out, "orphan") < index_of(&out, "h2"),
            "the pinned operation was crossed: {n:?}"
        );
        assert!(
            report.pinned.iter().any(|p| p.starts_with("orphan:")),
            "{:?}",
            report.pinned
        );
    }

    /// The group order is a topological sort, so it must be the same one every
    /// time regardless of which order the caller happened to hand the groups in.
    #[test]
    fn the_group_order_does_not_depend_on_which_tool_appeared_first() {
        let build = |outline_first: bool| {
            let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
            plate.tool = tool6();
            let mut h1 = hole("h1", 50.0, 50.0, 5.0);
            let mut h2 = hole("h2", 150.0, 50.0, 5.0);
            h1.tool = tool3();
            h2.tool = tool3();
            if outline_first {
                vec![plate, h1, h2]
            } else {
                vec![h1, h2, plate]
            }
        };
        let (a, ra) = optimise_route(build(true));
        let (b, rb) = optimise_route(build(false));
        assert_eq!(names(&a), names(&b), "the input order still decides the program");
        assert_eq!(ra.tool_changes_after, rb.tool_changes_after);
        assert!(ra.refusals.is_empty() && rb.refusals.is_empty());
    }

    /// Determinism: the same input gives the same order, twice, byte for byte.
    /// Gate K3 compares the browser's bytes to the CLI's; a route that depended
    /// on iteration luck would make that a coin toss.
    #[test]
    fn the_order_is_deterministic() {
        let build = || {
            let mut v: Vec<Operation> = (0..12)
                .map(|i| hole(&format!("h{i}"), 20.0 + (i % 4) as f64 * 40.0, 20.0 + (i / 4) as f64 * 30.0, 5.0))
                .collect();
            v.push(outline("plate", 0.0, 0.0, 200.0, 100.0));
            v
        };
        let (a, _) = optimise_route(build());
        let (b, _) = optimise_route(build());
        assert_eq!(names(&a), names(&b));
    }

    /// 🔴 The knob gate REL's `--plant release-order` drives. It must restore
    /// the pre-2026-08-09 hazard on a job that has one — the outline emitted
    /// before its own holes, which `verify_interior_before_outer` then refuses.
    #[test]
    fn the_group_order_knob_restores_the_pre_fix_hazard_and_the_refusal_catches_it() {
        let build = || {
            let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
            plate.tool = tool6();
            let mut h1 = hole("h1", 50.0, 50.0, 5.0);
            let mut h2 = hole("h2", 150.0, 50.0, 5.0);
            h1.tool = tool3();
            h2.tool = tool3();
            vec![plate, h1, h2]
        };

        // Sorted: safe, and it said it reordered.
        let (safe, rs) = optimise_route_with(build(), GroupOrder::ReleaseSorted);
        assert_eq!(names(&safe).last().unwrap(), "plate", "{:?}", names(&safe));
        assert!(rs.refusals.is_empty(), "{:?}", rs.refusals);

        // Planted: the outline runs FIRST and the refusal names the part and
        // every interior feature stranded behind it.
        let (bad, rp) = optimise_route_with(build(), GroupOrder::FirstAppearance);
        assert_eq!(
            names(&bad)[0],
            "plate",
            "the plant did not restore the first-appearance order: {:?}",
            names(&bad)
        );
        assert_eq!(rp.refusals.len(), 1, "{:?}", rp.refusals);
        assert_eq!(rp.refusals[0].what, "plate");
        assert!(rp.refusals[0].why.contains("h1") && rp.refusals[0].why.contains("h2"), "{:?}", rp.refusals);
        // The tool-change count is the same in both — the plant restores an
        // ORDER, it does not break the grouping.
        assert_eq!(rp.tool_changes_after, rs.tool_changes_after);
    }

    /// 🔴 **The plant must say when it planted NOTHING.** A job whose
    /// first-appearance order is already safe — which is all five reference
    /// fixtures — neuters a sort that was never going to fire, runs clean, and
    /// would read as a passing control. That is the vacuous control `--plant`
    /// exists to prevent, so the answer is stated rather than inferred.
    #[test]
    fn the_plant_reports_yes_only_when_it_actually_changed_the_group_order() {
        // Safe on input: holes (3mm) first, outline (6mm) last.
        let mut h1 = hole("h1", 50.0, 50.0, 5.0);
        let mut h2 = hole("h2", 150.0, 50.0, 5.0);
        h1.tool = tool3();
        h2.tool = tool3();
        let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
        plate.tool = tool6();
        let (_, vacuous) = optimise_route_with(vec![h1, h2, plate], GroupOrder::FirstAppearance);
        let note = vacuous
            .notes
            .iter()
            .find(|n| n.contains(PLANT_DIFFERENCE_KEY))
            .expect("the plant must state whether it changed anything");
        assert!(
            note.contains(&format!("{PLANT_DIFFERENCE_KEY} NO")),
            "a plant that changed nothing claimed it did: {note}"
        );
        assert!(vacuous.refusals.is_empty(), "{:?}", vacuous.refusals);

        // Unsafe on input: the same job with the outline written first.
        let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
        plate.tool = tool6();
        let mut h1 = hole("h1", 50.0, 50.0, 5.0);
        let mut h2 = hole("h2", 150.0, 50.0, 5.0);
        h1.tool = tool3();
        h2.tool = tool3();
        let (_, real) = optimise_route_with(vec![plate, h1, h2], GroupOrder::FirstAppearance);
        let note = real
            .notes
            .iter()
            .find(|n| n.contains(PLANT_DIFFERENCE_KEY))
            .expect("the plant must state whether it changed anything");
        assert!(
            note.contains(&format!("{PLANT_DIFFERENCE_KEY} YES")),
            "a plant that DID change the order reported otherwise: {note}"
        );
        assert!(!real.refusals.is_empty(), "planted and nothing was refused");
    }

    /// The default entry point is the sorted one. A caller that reaches for
    /// `optimise_route` cannot get the plant by accident.
    #[test]
    fn the_plain_entry_point_is_the_sorted_ordering() {
        assert_eq!(GroupOrder::default(), GroupOrder::ReleaseSorted);
        let build = || {
            let mut plate = outline("plate", 0.0, 0.0, 200.0, 100.0);
            plate.tool = tool6();
            let mut h1 = hole("h1", 50.0, 50.0, 5.0);
            h1.tool = tool3();
            vec![plate, h1]
        };
        let (a, _) = optimise_route(build());
        let (b, _) = optimise_route_with(build(), GroupOrder::ReleaseSorted);
        assert_eq!(names(&a), names(&b));
    }

    /// An open contour finishes at its far end. Ordering that ignores it plans
    /// the return trip from the wrong place.
    #[test]
    fn an_open_contour_exits_at_its_far_end() {
        let mut engrave = Operation {
            name: "line".into(),
            part: "line".into(),
            role: crate::toolpath::OpRole::Interior,
            contour: Contour::open(vec![
                crate::geometry::Vertex::line(0.0, 0.0),
                crate::geometry::Vertex::line(100.0, 0.0),
            ]),
            tool: tool6(),
            params: OperationParams {
                side: CutSide::OnLine,
                op_type: OpType::Engrave,
                direction: Direction::Climb,
                entry: EntryMode::Plunge,
                ..OperationParams::default()
            },
        };
        engrave.params.depth_total_mm = 1.0;
        let a = anchor_of(&engrave).expect("anchored");
        assert_eq!(a.entry, Vec2::new(0.0, 0.0));
        assert_eq!(a.exit, Vec2::new(100.0, 0.0), "an open path does not end where it started");
    }
}
