//! Where inside the travel a program would have to sit — **reported, never applied**.
//!
//! # The finding this exists for
//!
//! A drawing straight out of CAD does not land inside the travel. `cad`'s own
//! `super_end.dxf` imports cleanly — one part, 21 interior features — and is
//! then refused:
//!
//! ```text
//! error: move outside X travel: -3 (allowed 0 .. 600)
//! error: move outside Y travel: -3.5 (allowed 0 .. 900)
//! ```
//!
//! Nothing is wrong with that drawing. Its geometry spans `X 0 .. 243`,
//! `Y -0.5 .. 406.5`; a 6mm cutter running **outside** the profile puts the tool
//! centre a 3mm radius further out on every side, which is the whole of the -3
//! and -3.5. **Every real drawing does this**, because CAD does not put a part's
//! corner on the machine origin and would be wrong to. Today the first thing a
//! user meets is a refusal they have to solve by hand in the datum fields. This
//! module works out the answer for them.
//!
//! # 🔴 Why this returns a value instead of moving the job
//!
//! Nothing here mutates a job, and the planner does not call it. **The datum is
//! the part's position relative to the CLAMPS, and the clamps are bolted to the
//! machine** — they do not travel with the workpiece. Shifting the datum by 3mm to
//! clear a soft limit moves the program 3mm into whatever is holding the work
//! down, which is gate P7's physical failure: a toolpath through a clamp
//! destroys the clamp, the cutter, and usually the part.
//!
//! So the honest shape is: this module answers *"what shift would fit?"*, and a
//! human — or a UI putting the number in front of one — decides whether the
//! fixturing survives it. An auto-shift would be a silent change of a physical
//! relationship the program cannot see.
//!
//! # 🔴 The answer is only as wide as the thing it was measured on
//!
//! Every [`Placement`] carries an [`ExtentBasis`] saying what its extent came
//! from, because **the two available bases answer different questions and only
//! one of them is about the program that will run**:
//!
//! * [`ExtentBasis::Drawing`] — the drawing's outer boundaries grown by a tool
//!   radius the caller supplied. Lead-ins, lead-outs and ramp entries are cut
//!   OUTSIDE that outline and are not in it.
//! * [`ExtentBasis::PlannedPath`] — a planned toolpath's own bounding box. Every
//!   move the plan makes is in it.
//!
//! This is not a formality; it is measured. `cad`'s `super_end.dxf` with a 5mm
//! lead, on the default machine (`2bee-slice import … --config`, 2026-08-09):
//!
//! ```text
//! fit  →  move the datum by X +3.000 Y +3.500        (drawing basis)
//! apply exactly that, then plan the job:
//!         error: move outside Y travel: -2 (allowed 0 .. 900)
//!         move the datum by Y +2.000                  (planned-path basis)
//! ```
//!
//! The drawing-basis answer was **2mm short**, and the sentence carrying it said
//! *"and the whole program fits"* — a claim about a program nothing had measured.
//! An operator who trusts it moves the workpiece relative to the clamps, is
//! refused again, and moves it a second time. **A drawing-basis answer is a floor
//! under the shift, never the shift**, and it now says so in its own words rather
//! than in one host's printout — the same reason `JobSummary` carries
//! `EstimateBasis` instead of leaving each UI to remember that a run time is an
//! estimate.
//!
//! ⚠ Worse in the other direction, and the reason [`Placement::AlreadyInside`]
//! carries the basis too: on the same drawing shifted by `+3.0 / +3.5`, a
//! drawing-basis question answers **already inside** for a job that is then
//! refused for travel. A false green on the check that keeps the gantry out of
//! its own frame.
//!
//! # And the refusal matters as much as the shift
//!
//! [`Placement::WillNotFit`] carries **no shift at all**, deliberately. A shift
//! clamped to "as close as we could get" is worse than a refusal: it reads as an
//! answer, the extent still hangs outside the travel, and the limit error the user was
//! trying to clear comes back with the datum now somewhere nobody chose. When a
//! program is wider than the travel, the only true answers are a smaller program,
//! a different placement of the WORKPIECE (see [`crate::types::Stock::rotation_deg`]
//! and `quarter_turn_that_fits`, which are a different question from this one) or
//! a bigger machine.
//!
//! # Applying the answer, if a human says yes
//!
//! The shift is a **datum** shift: add `dx_mm` to [`Stock::origin_x_mm`] and
//! `dy_mm` to [`Stock::origin_y_mm`]. Every emitted coordinate goes through
//! [`Stock::place`], which adds the datum last, so a datum shift translates the
//! whole program rigidly — including the coordinates the travel-limit check
//! reads.
//!
//! [`Stock::origin_x_mm`]: crate::types::Stock::origin_x_mm
//! [`Stock::origin_y_mm`]: crate::types::Stock::origin_y_mm
//! [`Stock::place`]: crate::types::Stock::place

use serde::{Deserialize, Serialize};

use crate::geometry::Part;
use crate::types::{Machine, Toolpath};

/// Tolerance for "is it already inside", in mm. A program sitting 1e-12 mm
/// outside the limit is inside; reporting a shift of 1e-12 would be noise
/// dressed as an instruction.
const EPS: f64 = 1e-9;

/// An axis-aligned XY window, in millimetres, in MACHINE coordinates.
///
/// This is the extent of a *program*, not of the workpiece. The two are different
/// questions and conflating them is how a job gets generated that the machine
/// cannot run — see [`crate::types::Machine::travel_x_mm`].
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Extent {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Extent {
    /// `None` when the bounds are inverted or not finite. An inverted extent is
    /// a caller bug, and silently swapping the ends would answer a question
    /// nobody asked.
    pub fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Option<Self> {
        let ok = [min_x, min_y, max_x, max_y].iter().all(|v| v.is_finite());
        if !ok || max_x < min_x || max_y < min_y {
            return None;
        }
        Some(Self { min_x, min_y, max_x, max_y })
    }

    /// Extent of a set of XY points. `None` for an empty set — an absent extent
    /// and a zero extent are different facts.
    ///
    /// 🔴 **A non-finite point makes this `None`, and the check is on the INPUT,
    /// not on the answer.** `f64::min` and `f64::max` return the *other* operand
    /// when one is `NaN`, so accumulating with them and then testing the result
    /// for finiteness is a test that can never fail: a `NaN` point is silently
    /// left out and what comes back is a perfectly finite extent of everything
    /// except the coordinate that was unmachinable. An extent is a claim to have
    /// bounded every point it was given, so a point it cannot bound is a refusal.
    pub fn from_points(points: impl IntoIterator<Item = (f64, f64)>) -> Option<Self> {
        let mut it = points.into_iter();
        let (x0, y0) = it.next()?;
        if !x0.is_finite() || !y0.is_finite() {
            return None;
        }
        let mut e = Self { min_x: x0, min_y: y0, max_x: x0, max_y: y0 };
        for (x, y) in it {
            if !x.is_finite() || !y.is_finite() {
                return None;
            }
            e.min_x = e.min_x.min(x);
            e.min_y = e.min_y.min(y);
            e.max_x = e.max_x.max(x);
            e.max_y = e.max_y.max(y);
        }
        if !e.is_finite() {
            return None;
        }
        Some(e)
    }

    /// Extent of a planned toolpath, read from its bounding box.
    ///
    /// 🔴 These coordinates are **tool-centre** coordinates and the radius is
    /// already in them — the offsetting happened when the path was generated.
    /// Pass `tool_radius_mm = 0.0` to [`plan_datum_shift`] for this extent, or
    /// use [`plan_datum_shift_for_toolpath`], which cannot get it wrong.
    /// Counting the radius twice moves the answer by a whole diameter.
    ///
    /// 🔴 **The cached bounds are NOT trusted on their own — the moves are read.**
    /// `Toolpath::recompute_bounds` accumulates with `f64::min` / `f64::max`,
    /// which **discard `NaN`**, so a move with a non-finite coordinate never
    /// widens the box and the box stays perfectly finite. Answering off it would
    /// hand back a confident extent for a program containing moves that extent
    /// does not cover — and the travel check that keeps the gantry out of its own
    /// frame is built on this number.
    ///
    /// Measured 2026-08-09, and this is not hypothetical: a closed `LWPOLYLINE`
    /// whose last vertex repeats its first (which is what
    /// `hardware/cad/export/generate_hive_box_dxf.py::rect()` writes) plans to a
    /// path carrying `G1 XNaN YNaN` blocks, and the whole job reported
    /// `ok=true cut=NaNmm` with the travel check green.
    ///
    /// ⚠ **`None` here is not a fix for that** — it removes a false answer and
    /// puts nothing in its place, because [`plan_datum_shift_for_toolpath`]'s
    /// callers treat `None` as *"no extent, nothing to say"*. The defect belongs
    /// to whatever emitted the `NaN` and to `recompute_bounds`; this function's
    /// only obligation is to stop **vouching** for it.
    ///
    /// Only the move kinds `recompute_bounds` counts are read: a comment or a
    /// spindle record carries no coordinate.
    ///
    /// 🔴 **CORRECTED 2026-08-10 (audit B3).** This paragraph used to end *"and
    /// an arc's `centre` is not part of the box this returns"* — a true sentence
    /// about a defect, written as a note. It was: the box was folded from move
    /// ENDPOINTS, so an arc bulging past its own ends was outside every answer
    /// built on it, by up to a full radius. `recompute_bounds` now folds the
    /// arc's real extent ([`crate::types::arc_xy_extent`]), so the centre IS in
    /// the box — through the curve, not as a point. **A `fit` or `layout`
    /// verdict is only as wide as the box it reads, and this one is now as wide
    /// as the program.**
    ///
    /// ⚠ The finiteness scan asks [`Move::geometry_is_finite`] rather than
    /// re-testing `to` here, because the fold now EXCLUDES an arc whose centre
    /// is not a number — there is no finite window that contains a path nobody
    /// can compute. A scan that only checked `to` would return a confident
    /// extent for a box that had silently dropped that arc, which is the exact
    /// shape of the `NaN` defect this function was written to stop vouching for.
    ///
    /// [`Move::geometry_is_finite`]: crate::types::Move::geometry_is_finite
    pub fn from_toolpath(path: &Toolpath) -> Option<Self> {
        if path.is_empty() {
            return None;
        }
        let positions_all_finite =
            path.moves.iter().all(|m| !Toolpath::positions(m.kind) || m.geometry_is_finite());
        if !positions_all_finite {
            return None;
        }
        Self::new(path.min_x, path.min_y, path.max_x, path.max_y)
    }

    /// Extent of imported DRAWING geometry, outer boundaries only — the holes
    /// are inside the outer boundary, so they cannot widen it.
    ///
    /// These are drawing coordinates with no cutter in them, so the caller
    /// supplies the tool radius separately. That is the case the -3 came from.
    pub fn from_parts(parts: &[Part]) -> Option<Self> {
        let mut acc: Option<Self> = None;
        for p in parts {
            let (min_x, min_y, max_x, max_y) = p.bounds()?;
            let e = Self::new(min_x, min_y, max_x, max_y)?;
            acc = Some(match acc {
                None => e,
                Some(a) => Self {
                    min_x: a.min_x.min(e.min_x),
                    min_y: a.min_y.min(e.min_y),
                    max_x: a.max_x.max(e.max_x),
                    max_y: a.max_y.max(e.max_y),
                },
            });
        }
        acc
    }

    fn is_finite(&self) -> bool {
        self.min_x.is_finite()
            && self.min_y.is_finite()
            && self.max_x.is_finite()
            && self.max_y.is_finite()
    }

    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    pub fn height(&self) -> f64 {
        self.max_y - self.min_y
    }

    /// Grow on every side — the tool centre's window around a drawing whose
    /// outer profile is cut on the outside.
    ///
    /// A negative `by` is treated as zero: shrinking an extent to make a job fit
    /// would be a lie about where the cutter goes.
    pub fn grown(self, by: f64) -> Self {
        let by = if by.is_finite() { by.max(0.0) } else { 0.0 };
        Self {
            min_x: self.min_x - by,
            min_y: self.min_y - by,
            max_x: self.max_x + by,
            max_y: self.max_y + by,
        }
    }

    pub fn shifted(self, dx: f64, dy: f64) -> Self {
        Self {
            min_x: self.min_x + dx,
            min_y: self.min_y + dy,
            max_x: self.max_x + dx,
            max_y: self.max_y + dy,
        }
    }

    /// Whether this extent sits inside `margin_mm .. travel - margin_mm` on both
    /// axes. The same window [`plan_datum_shift`] aims at, so a caller can check
    /// an answer without re-deriving it.
    pub fn inside(&self, machine: &Machine, margin_mm: f64) -> bool {
        let m = margin_mm.max(0.0);
        self.min_x >= m - EPS
            && self.min_y >= m - EPS
            && self.max_x <= machine.travel_x_mm - m + EPS
            && self.max_y <= machine.travel_y_mm - m + EPS
    }
}

/// Which axis a refusal is about. Named rather than a string so a UI cannot
/// mis-spell it and a test cannot pass on the wrong one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    X,
    Y,
}

impl Axis {
    pub fn as_str(self) -> &'static str {
        match self {
            Axis::X => "X",
            Axis::Y => "Y",
        }
    }
}

/// What a [`Placement`]'s extent was measured ON.
///
/// 🔴 This is not provenance trivia. The two bases answer **different
/// questions**, and only one of them is about the thing the machine will run —
/// see the module header for the measured case where the difference is 2mm of
/// real travel and a second physical move of the workpiece.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "basis", rename_all = "snake_case")]
pub enum ExtentBasis {
    /// The DRAWING's outer boundaries, grown by a tool radius the caller
    /// supplied.
    ///
    /// **What is not in it:** lead-in and lead-out arcs, ramp entries, and any
    /// pass that leaves the profile. All of those are cut outside the outline,
    /// so the shift this basis produces is a **floor** under the shift the job
    /// will need. It can also over-read in the opposite direction — the radius
    /// is a parameter and this core cannot see which side of which contour the
    /// tool runs on, so a contour cut on the inside was grown when it should not
    /// have been. The one thing it is not, in either direction, is final.
    Drawing { tool_radius_mm: f64 },
    /// A planned toolpath's own bounding box — every move in the plan is in it,
    /// leads and ramps included.
    ///
    /// ⚠ The **PLAN**, not the posted text. Anything a post adds or transforms
    /// after this point is outside what was measured — a probe sequence it
    /// writes as raw text, a Z offset it applies, an arc it degrades to a chord.
    ///
    /// 🔴 **CORRECTED 2026-08-10 (audit B3).** This used to end *"and the arc
    /// bound is endpoint-based: an arc that bulges outside its own endpoints is
    /// not in this box"*. It is now: arcs are bounded by their curve, so every
    /// move the PLAN makes really is inside these coordinates. The remaining gap
    /// is the post, and it is named above rather than implied.
    PlannedPath,
}

impl ExtentBasis {
    /// Whether an answer on this basis is the whole answer. `false` for
    /// [`ExtentBasis::Drawing`] — deliberately, so a caller that wants to say
    /// "apply this" has to look at the basis first.
    pub fn is_final(self) -> bool {
        matches!(self, ExtentBasis::PlannedPath)
    }

    /// What an answer on this basis is about, for the middle of a sentence.
    /// Never *"the whole program"* on a drawing basis — that was the exact
    /// overstatement this type exists to remove.
    pub fn subject(self) -> &'static str {
        match self {
            ExtentBasis::Drawing { .. } => "the drawing's outline",
            ExtentBasis::PlannedPath => "the whole program",
        }
    }

    /// The sentence that travels WITH the number, so a host does not have to
    /// remember to print it.
    pub fn caveat(self) -> String {
        match self {
            ExtentBasis::Drawing { tool_radius_mm } => format!(
                "⚠ measured on the DRAWING's outer boundaries grown by a {tool_radius_mm:.3}mm \
                 tool radius, not on a planned path: lead-ins, lead-outs and ramp entries are cut \
                 outside that outline and are not counted, so this is a FLOOR and the planned job \
                 can still be refused for travel. Re-ask once the path is planned"
            ),
            ExtentBasis::PlannedPath => "measured on the planned toolpath, so every move the plan \
                                         makes is counted — the PLAN, not the posted text"
                .into(),
        }
    }
}

/// One axis on which the program is simply bigger than the travel.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Overhang {
    pub axis: Axis,
    /// What the program needs on this axis, cutter included.
    pub needed_mm: f64,
    /// What the machine has, margins already taken off.
    pub available_mm: f64,
    /// `needed - available`. The number a person can act on: shorten the part by
    /// this much, or find this much more machine.
    pub over_mm: f64,
}

/// The answer. Three outcomes, and they are genuinely different facts.
///
/// `AlreadyInside` is not `ShiftDatum { dx: 0, dy: 0 }` — a UI that offers to
/// "move the datum by 0mm" is inviting a person to accept a change that is not
/// one, and the next time it offers a real shift it will be trusted less.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Placement {
    /// The measured extent is inside the travel as it stands. Nothing to offer.
    ///
    /// ⚠ On [`ExtentBasis::Drawing`] this is **not** "the job will run": the
    /// module header records a real drawing that answers `AlreadyInside` on its
    /// outline and is then refused for travel once its leads are planned.
    AlreadyInside { extent: Extent, basis: ExtentBasis },
    /// A datum shift would put the measured extent inside travel. **Offer this;
    /// do not apply it** — see the module header.
    ShiftDatum {
        dx_mm: f64,
        dy_mm: f64,
        /// Where the measured extent is now, cutter included.
        current: Extent,
        /// Where it would be after the shift.
        shifted: Extent,
        /// What was measured — and therefore whether `dx_mm`/`dy_mm` is the
        /// shift or the smallest shift that could possibly work.
        basis: ExtentBasis,
    },
    /// No shift can help: the measured extent is larger than the travel. Carries
    /// no shift, on purpose.
    WillNotFit {
        /// Where the measured extent is now, cutter included.
        current: Extent,
        /// One entry per failing axis. Both axes can fail at once and that is
        /// two facts, not one.
        overhangs: Vec<Overhang>,
        basis: ExtentBasis,
    },
}

impl Placement {
    /// What this answer was measured on. A caller deciding whether to word
    /// something as "apply this" must ask.
    pub fn basis(&self) -> ExtentBasis {
        match self {
            Placement::AlreadyInside { basis, .. }
            | Placement::ShiftDatum { basis, .. }
            | Placement::WillNotFit { basis, .. } => *basis,
        }
    }

    /// The datum shift, when there is one. `None` for both "nothing to do" and
    /// "cannot be done" — the caller must not treat those as the same, which is
    /// why the enum is the real return value and this is a convenience.
    pub fn datum_shift(&self) -> Option<(f64, f64)> {
        match self {
            Placement::ShiftDatum { dx_mm, dy_mm, .. } => Some((*dx_mm, *dy_mm)),
            _ => None,
        }
    }

    /// Where the program ends up if the answer is taken. `None` when it cannot
    /// be made to fit.
    pub fn resulting_extent(&self) -> Option<Extent> {
        match self {
            Placement::AlreadyInside { extent, .. } => Some(*extent),
            Placement::ShiftDatum { shifted, .. } => Some(*shifted),
            Placement::WillNotFit { .. } => None,
        }
    }

    pub fn fits(&self) -> bool {
        !matches!(self, Placement::WillNotFit { .. })
    }

    /// One line for an operator. The refusal names the axis and the overhang,
    /// because "it does not fit" is not something anyone can act on — and every
    /// answer names **what it was measured on**, because a shift that fits the
    /// drawing and a shift that fits the program are different numbers and only
    /// one of them is worth moving a workpiece for.
    pub fn describe(&self) -> String {
        let basis = self.basis();
        match self {
            Placement::AlreadyInside { extent, .. } => format!(
                "{} is already inside travel: X {:.3} .. {:.3}, Y {:.3} .. {:.3} \
                 — no datum shift needed ({})",
                basis.subject(),
                extent.min_x,
                extent.max_x,
                extent.min_y,
                extent.max_y,
                basis.caveat(),
            ),
            Placement::ShiftDatum { dx_mm, dy_mm, current, shifted, .. } => {
                // Only the axes that actually move are named. "X +0.000" is the
                // same lie as an `AlreadyInside` reported as a zero shift, one
                // axis down: it asks a person to accept a change that is not one.
                let mut moved = Vec::new();
                if dx_mm.abs() > EPS {
                    moved.push(format!("X {dx_mm:+.3}"));
                }
                if dy_mm.abs() > EPS {
                    moved.push(format!("Y {dy_mm:+.3}"));
                }
                format!(
                    "move the datum by {} and {} fits: \
                     X {:.3} .. {:.3} becomes {:.3} .. {:.3}, \
                     Y {:.3} .. {:.3} becomes {:.3} .. {:.3} \
                     — check the clamps first, they do not move with the workpiece ({})",
                    moved.join(" "),
                    basis.subject(),
                    current.min_x,
                    current.max_x,
                    shifted.min_x,
                    shifted.max_x,
                    current.min_y,
                    current.max_y,
                    shifted.min_y,
                    shifted.max_y,
                    basis.caveat(),
                )
            }
            Placement::WillNotFit { overhangs, .. } => {
                let reasons: Vec<String> = overhangs
                    .iter()
                    .map(|o| {
                        format!(
                            "it is larger than the travel in {} by {:.3}mm \
                             (needs {:.3}mm, {:.3}mm available)",
                            o.axis.as_str(),
                            o.over_mm,
                            o.needed_mm,
                            o.available_mm
                        )
                    })
                    .collect();
                format!(
                    "no shift can make this fit, because {} ({})",
                    reasons.join(", and "),
                    basis.caveat(),
                )
            }
        }
    }
}

/// What datum shift would put the whole program inside the machine's travel.
///
/// * `extent` — the program's extent. Drawing geometry ([`Extent::from_parts`])
///   or a planned toolpath ([`Extent::from_toolpath`]).
/// * `tool_radius_mm` — how far outside `extent` the tool CENTRE runs. For
///   drawing geometry cut on the outside this is the cutter's radius, and it is
///   the whole reason a part drawn at `X 0 ..` reports `-3`. **It is a parameter
///   and not a guess**: this module cannot see which side of which contour the
///   tool runs on, and inventing a radius would move a physical answer. For a
///   toolpath, the radius is already in the coordinates — pass `0.0`, or use
///   [`plan_datum_shift_for_toolpath`].
/// * `margin_mm` — how far to stay clear of each soft limit. `0.0` puts the
///   program exactly on the limit, which is legal and unforgiving. Negative is
///   treated as `0.0`; a "margin" past the limit is not a thing.
///
/// The result is a report. Nothing is mutated, and the caller decides — see the
/// module header for why that is a safety property and not politeness.
///
/// 🔴 **The answer is stamped [`ExtentBasis::Drawing`]**, because that is what
/// this signature means: an extent plus a radius the caller supplied for a
/// cutter running outside it. A toolpath's coordinates already carry their
/// radius and its leads and ramps, so a toolpath goes through
/// [`plan_datum_shift_for_toolpath`] and gets stamped as such. The basis is
/// decided by **which function you called**, not inferred from
/// `tool_radius_mm == 0.0` — one number answering two questions is how a
/// drawing-basis answer would end up wearing a planned-path label.
pub fn plan_datum_shift(
    extent: Extent,
    tool_radius_mm: f64,
    margin_mm: f64,
    machine: &Machine,
) -> Placement {
    plan(extent, tool_radius_mm, margin_mm, machine, ExtentBasis::Drawing { tool_radius_mm })
}

/// The arithmetic, with the basis handed in rather than guessed.
fn plan(
    extent: Extent,
    tool_radius_mm: f64,
    margin_mm: f64,
    machine: &Machine,
    basis: ExtentBasis,
) -> Placement {
    let margin = if margin_mm.is_finite() { margin_mm.max(0.0) } else { 0.0 };
    let current = extent.grown(tool_radius_mm);

    let avail_x = machine.travel_x_mm - 2.0 * margin;
    let avail_y = machine.travel_y_mm - 2.0 * margin;

    let mut overhangs = Vec::new();
    if current.width() > avail_x + EPS {
        overhangs.push(Overhang {
            axis: Axis::X,
            needed_mm: current.width(),
            available_mm: avail_x,
            over_mm: current.width() - avail_x,
        });
    }
    if current.height() > avail_y + EPS {
        overhangs.push(Overhang {
            axis: Axis::Y,
            needed_mm: current.height(),
            available_mm: avail_y,
            over_mm: current.height() - avail_y,
        });
    }
    if !overhangs.is_empty() {
        // No shift, not even for the axis that would have fitted. Half an answer
        // to a physical question reads as a whole one.
        return Placement::WillNotFit { current, overhangs, basis };
    }

    // It fits by size, so at most one end of each axis can be out.
    let axis_shift = |lo: f64, hi: f64, limit_hi: f64| -> f64 {
        if lo < margin - EPS {
            margin - lo
        } else if hi > limit_hi + EPS {
            limit_hi - hi
        } else {
            0.0
        }
    };
    let dx = axis_shift(current.min_x, current.max_x, machine.travel_x_mm - margin);
    let dy = axis_shift(current.min_y, current.max_y, machine.travel_y_mm - margin);

    if dx.abs() <= EPS && dy.abs() <= EPS {
        return Placement::AlreadyInside { extent: current, basis };
    }

    Placement::ShiftDatum {
        dx_mm: dx,
        dy_mm: dy,
        current,
        shifted: current.shifted(dx, dy),
        basis,
    }
}

/// Same question, asked of a planned toolpath.
///
/// Exists so the radius cannot be double-counted: a toolpath's coordinates are
/// tool-centre coordinates and already carry the offset, so the radius passed
/// here is `0.0` and there is no second place to get that wrong.
///
/// `None` when the path has no moves — an empty program has no extent, and a
/// zero extent at the origin would answer "already inside" about nothing. Also
/// `None` when a positioning move carries a non-finite coordinate, for the
/// reason on [`Extent::from_toolpath`]: a box that silently drops the one move
/// nobody can machine is not a measurement of this path.
///
/// The answer is stamped [`ExtentBasis::PlannedPath`] — leads, ramps and every
/// other move the plan makes are inside the coordinates it was read from.
pub fn plan_datum_shift_for_toolpath(
    path: &Toolpath,
    margin_mm: f64,
    machine: &Machine,
) -> Option<Placement> {
    let e = Extent::from_toolpath(path)?;
    Some(plan(e, 0.0, margin_mm, machine, ExtentBasis::PlannedPath))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Move, Tool, Vec3};

    fn machine_600x900() -> Machine {
        Machine::default()
    }

    fn ext(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Extent {
        Extent::new(min_x, min_y, max_x, max_y).expect("test extent is inverted")
    }

    #[test]
    fn a_drawing_at_negative_coordinates_gets_a_shift_that_lands_inside_travel() {
        // These are `cad`'s real numbers. super_end.dxf spans X 0..243,
        // Y -0.5..406.5; a 6mm cutter outside the profile is what produces the
        // -3 / -3.5 the machine refuses.
        let m = machine_600x900();
        let p = plan_datum_shift(ext(0.0, -0.5, 243.0, 406.5), 3.0, 0.0, &m);

        let (dx, dy) = p.datum_shift().unwrap_or_else(|| panic!("no shift offered: {p:?}"));
        assert!((dx - 3.0).abs() < 1e-9, "dx {dx}");
        assert!((dy - 3.5).abs() < 1e-9, "dy {dy}");

        let after = p.resulting_extent().expect("a shift must say where it lands");
        assert!(after.inside(&m, 0.0), "the offered shift does not land inside travel: {after:?}");
        assert!((after.min_x - 0.0).abs() < 1e-9);
        assert!((after.min_y - 0.0).abs() < 1e-9);
        assert!((after.max_x - 249.0).abs() < 1e-9);
        assert!((after.max_y - 413.0).abs() < 1e-9);

        // And the answer is stable: re-asking about the shifted program must say
        // there is nothing left to do, not offer another shift.
        assert!(matches!(
            plan_datum_shift(after, 0.0, 0.0, &m),
            Placement::AlreadyInside { .. }
        ));
    }

    #[test]
    fn a_program_wider_than_the_table_is_refused_by_name_with_no_shift() {
        let m = machine_600x900();
        let p = plan_datum_shift(ext(0.0, 0.0, 700.0, 100.0), 0.0, 0.0, &m);

        let Placement::WillNotFit { overhangs, .. } = &p else {
            panic!("a 700mm program on 600mm of travel was not refused: {p:?}");
        };
        assert_eq!(overhangs.len(), 1, "only X is over: {overhangs:?}");
        assert_eq!(overhangs[0].axis, Axis::X);
        assert!((overhangs[0].over_mm - 100.0).abs() < 1e-9, "{:?}", overhangs[0]);
        assert!((overhangs[0].available_mm - 600.0).abs() < 1e-9);

        // A clamped-to-something shift is worse than a refusal, so there must be
        // no shift at all and no landing extent to mistake for one.
        assert!(p.datum_shift().is_none(), "a refusal offered a shift");
        assert!(p.resulting_extent().is_none());
        assert!(!p.fits());

        let d = p.describe();
        assert!(d.contains("no shift can make this fit"), "{d}");
        assert!(d.contains("larger than the travel in X by 100.000mm"), "{d}");
        assert!(!d.contains(" in Y "), "Y is fine and must not be named: {d}");
    }

    #[test]
    fn both_axes_over_are_reported_as_two_facts() {
        let m = machine_600x900();
        let p = plan_datum_shift(ext(0.0, 0.0, 610.0, 1000.0), 0.0, 0.0, &m);
        let Placement::WillNotFit { overhangs, .. } = &p else {
            panic!("not refused: {p:?}");
        };
        assert_eq!(overhangs.len(), 2, "{overhangs:?}");
        assert_eq!(overhangs[0].axis, Axis::X);
        assert_eq!(overhangs[1].axis, Axis::Y);
        assert!((overhangs[0].over_mm - 10.0).abs() < 1e-9);
        assert!((overhangs[1].over_mm - 100.0).abs() < 1e-9);
    }

    #[test]
    fn a_program_already_inside_is_not_a_zero_shift_dressed_up_as_a_change() {
        let m = machine_600x900();
        let p = plan_datum_shift(ext(10.0, 10.0, 200.0, 300.0), 3.0, 0.0, &m);
        assert!(
            matches!(p, Placement::AlreadyInside { .. }),
            "a program inside the travel was offered a move: {p:?}"
        );
        assert!(p.datum_shift().is_none(), "AlreadyInside must not hand out a shift");
        assert!(p.describe().contains("no datum shift needed"), "{}", p.describe());
    }

    #[test]
    fn the_tool_radius_genuinely_moves_the_answer() {
        let m = machine_600x900();
        let drawing = ext(0.0, 0.0, 243.0, 400.0);

        // Drawn at the origin, no cutter: nothing to do.
        assert!(
            matches!(plan_datum_shift(drawing, 0.0, 0.0, &m), Placement::AlreadyInside { .. }),
            "radius 0 should need no shift"
        );

        // The same drawing with a 6mm cutter running outside it needs 3mm.
        let with_cutter = plan_datum_shift(drawing, 3.0, 0.0, &m);
        assert_eq!(with_cutter.datum_shift(), Some((3.0, 3.0)), "{with_cutter:?}");

        // And the radius can decide FIT, not just position: 598mm of geometry
        // fits 600mm of travel, and 598 + two 3mm radii does not.
        let tight = ext(0.0, 0.0, 598.0, 100.0);
        assert!(plan_datum_shift(tight, 0.0, 0.0, &m).fits());
        let refused = plan_datum_shift(tight, 3.0, 0.0, &m);
        let Placement::WillNotFit { overhangs, .. } = &refused else {
            panic!("the radius was not counted in the fit: {refused:?}");
        };
        assert_eq!(overhangs[0].axis, Axis::X);
        assert!((overhangs[0].over_mm - 4.0).abs() < 1e-9, "{:?}", overhangs[0]);
    }

    #[test]
    fn a_program_off_the_far_end_shifts_back_toward_the_datum() {
        let m = machine_600x900();
        let p = plan_datum_shift(ext(700.0, 10.0, 800.0, 110.0), 0.0, 0.0, &m);
        let (dx, dy) = p.datum_shift().expect("should be shiftable");
        assert!((dx + 200.0).abs() < 1e-9, "dx {dx}");
        assert!(dy.abs() < 1e-9, "Y was already fine, it must not be touched: {dy}");
        assert!(p.resulting_extent().unwrap().inside(&m, 0.0));

        // And the sentence must not instruct anyone to move Y by nothing.
        let d = p.describe();
        assert!(d.contains("move the datum by X -200.000 and"), "{d}");
        assert!(!d.contains("Y +0.000"), "a non-move was offered as a move: {d}");
    }

    #[test]
    fn a_margin_keeps_the_program_clear_of_the_soft_limit() {
        let m = machine_600x900();
        let p = plan_datum_shift(ext(0.0, 0.0, 100.0, 100.0), 0.0, 5.0, &m);
        assert_eq!(p.datum_shift(), Some((5.0, 5.0)), "{p:?}");
        let after = p.resulting_extent().unwrap();
        assert!(after.inside(&m, 5.0), "{after:?}");

        // A negative margin is not a licence to run past the limit.
        let neg = plan_datum_shift(ext(-1.0, -1.0, 100.0, 100.0), 0.0, -5.0, &m);
        assert_eq!(neg.datum_shift(), Some((1.0, 1.0)), "{neg:?}");
    }

    #[test]
    fn a_toolpaths_radius_is_already_in_its_coordinates() {
        let m = machine_600x900();
        let mut path = Toolpath { tool: Tool::default(), ..Default::default() };
        path.moves.push(Move::comment("comments carry no coordinate"));
        path.moves.push(Move::feed_to(Vec3::new(-3.0, -3.5, -5.0), 1000.0));
        path.moves.push(Move::feed_to(Vec3::new(246.0, 409.5, -5.0), 1000.0));
        path.recompute_bounds();

        let p = plan_datum_shift_for_toolpath(&path, 0.0, &m).expect("path has moves");
        // 3.0 / 3.5 — NOT 6.0 / 6.5, which is what counting the 3mm radius a
        // second time would produce.
        assert_eq!(p.datum_shift(), Some((3.0, 3.5)), "{p:?}");
        assert!(p.resulting_extent().unwrap().inside(&m, 0.0));
    }

    // -----------------------------------------------------------------------
    // 🔴 The basis. Measured 2026-08-09 on `cad`'s super_end.dxf with a 5mm
    // lead: `fit` offered X +3.000 Y +3.500 on the drawing's outline, the
    // operator applies exactly that, and the planned job is refused with
    // `move outside Y travel: -2`. The number was 2mm short and the sentence
    // carrying it said "and the whole program fits".
    // -----------------------------------------------------------------------

    #[test]
    fn a_drawing_basis_answer_never_claims_the_whole_program_fits() {
        let m = machine_600x900();

        // Same geometry, same shift, asked the two different ways.
        let drawn = plan_datum_shift(ext(0.0, -0.5, 243.0, 406.5), 3.0, 0.0, &m);
        assert_eq!(drawn.datum_shift(), Some((3.0, 3.5)), "{drawn:?}");

        let mut path = Toolpath { tool: Tool::default(), ..Default::default() };
        path.moves.push(Move::feed_to(Vec3::new(-3.0, -3.5, -5.0), 1000.0));
        path.moves.push(Move::feed_to(Vec3::new(246.0, 409.5, -5.0), 1000.0));
        path.recompute_bounds();
        let planned = plan_datum_shift_for_toolpath(&path, 0.0, &m).expect("path has moves");
        assert_eq!(planned.datum_shift(), Some((3.0, 3.5)), "{planned:?}");

        // Identical numbers, and they are NOT the same claim.
        assert_eq!(drawn.basis(), ExtentBasis::Drawing { tool_radius_mm: 3.0 });
        assert_eq!(planned.basis(), ExtentBasis::PlannedPath);
        assert!(!drawn.basis().is_final(), "a drawing-basis answer was reported as final");
        assert!(planned.basis().is_final());

        let d = drawn.describe();
        assert!(
            !d.contains("the whole program fits"),
            "a shift measured on the DRAWING claimed the whole program fits — the exact \
             overstatement that sent an operator to move the workpiece twice: {d}"
        );
        assert!(d.contains("and the drawing's outline fits"), "{d}");
        assert!(d.contains("FLOOR"), "the answer must say it is a lower bound: {d}");
        assert!(d.contains("lead-ins"), "the answer must say WHAT is missing from it: {d}");
        // The instruction a person acts on is still there, unchanged.
        assert!(d.contains("move the datum by X +3.000 Y +3.500"), "{d}");
        assert!(d.contains("they do not move with the workpiece"), "{d}");

        let p = planned.describe();
        assert!(p.contains("and the whole program fits"), "{p}");
        assert!(
            !p.contains("FLOOR"),
            "a planned-path answer was hedged as a floor, which trains people to ignore the \
             hedge on the answers that need it: {p}"
        );
        assert!(p.contains("the PLAN, not the posted text"), "{p}");
    }

    #[test]
    fn already_inside_and_will_not_fit_carry_the_basis_too() {
        let m = machine_600x900();

        // 🔴 The dangerous direction: on the drawing's outline this program is
        // inside travel, and a lead can still put it outside. A bare "already
        // inside" here is a false green on the check that keeps the gantry out
        // of its own frame.
        let inside = plan_datum_shift(ext(3.0, 3.0, 243.0, 413.0), 3.0, 0.0, &m);
        assert!(matches!(inside, Placement::AlreadyInside { .. }), "{inside:?}");
        let d = inside.describe();
        assert!(d.contains("no datum shift needed"), "{d}");
        assert!(
            d.contains("FLOOR") && d.contains("lead-ins"),
            "an ALREADY-INSIDE measured on the drawing did not say it can still be refused: {d}"
        );
        assert!(
            !d.starts_with("the program is already inside"),
            "the drawing's outline was described as `the program`: {d}"
        );

        let refused = plan_datum_shift(ext(0.0, 0.0, 700.0, 100.0), 0.0, 0.0, &m);
        assert!(refused.describe().contains("no shift can make this fit"), "{}", refused.describe());
        assert_eq!(refused.basis(), ExtentBasis::Drawing { tool_radius_mm: 0.0 });
    }

    #[test]
    fn a_toolpath_with_a_non_finite_move_has_no_extent_rather_than_one_that_omits_it() {
        // 🔴 Reproduced from a real file, not invented: a closed LWPOLYLINE whose
        // last vertex repeats its first (what
        // `hardware/cad/export/generate_hive_box_dxf.py::rect()` writes) plans to
        // a path carrying `G1 XNaN YNaN`, and the job reported
        // `ok=true cut=NaNmm` with the travel check green.
        let m = machine_600x900();
        let mut path = Toolpath { tool: Tool::default(), ..Default::default() };
        path.moves.push(Move::feed_to(Vec3::new(10.0, 10.0, -5.0), 1000.0));
        path.moves.push(Move::feed_to(Vec3::new(f64::NAN, f64::NAN, -5.0), 1000.0));
        path.moves.push(Move::feed_to(Vec3::new(100.0, 100.0, -5.0), 1000.0));
        path.recompute_bounds();

        // THE MECHANISM, asserted rather than described: `f64::min` / `f64::max`
        // return the other operand for NaN, so the cached box is perfectly
        // finite and describes only the moves it could see. A guard that tested
        // these four numbers for finiteness would never fire.
        assert!(
            path.min_x.is_finite() && path.max_x.is_finite(),
            "the cached bounds went non-finite, so this test is no longer exercising the silent \
             drop it exists for: {} .. {}",
            path.min_x,
            path.max_x
        );
        assert_eq!((path.min_x, path.max_x), (10.0, 100.0));

        assert!(
            Extent::from_toolpath(&path).is_none(),
            "an extent was returned for a path containing a move it does not bound — the travel \
             check is built on this number"
        );
        assert!(
            plan_datum_shift_for_toolpath(&path, 0.0, &m).is_none(),
            "a placement verdict was reported for a path that could not be measured"
        );

        // A comment carries no coordinate and must not be read as one — the
        // guard covers the same move kinds `recompute_bounds` counts, and no
        // more.
        let mut ok = Toolpath { tool: Tool::default(), ..Default::default() };
        ok.moves.push(Move::comment("comments carry no coordinate"));
        ok.moves.push(Move::feed_to(Vec3::new(10.0, 10.0, -5.0), 1000.0));
        ok.moves.push(Move::feed_to(Vec3::new(100.0, 100.0, -5.0), 1000.0));
        ok.recompute_bounds();
        assert!(Extent::from_toolpath(&ok).is_some(), "a clean path was refused");
    }

    // -----------------------------------------------------------------------
    // 🔴 Audit finding B3, 2026-08-10: every travel, spoilboard, workpiece-edge and
    // datum check bounds a program by move ENDPOINTS, and an arc bulges outside
    // that box. Proven on the planner path with shipped defaults: a bore whose
    // tool centre reaches Y901 on 900mm of Y travel reported `max_y 893.871`
    // and `check_machine_limits == []`.
    // -----------------------------------------------------------------------

    /// One inside bore, planned the way the audit planned it. `r_mm` is the
    /// DRAWING radius; a 6mm cutter on the inside puts the tool centre 3mm in.
    fn bore_job(cy: f64, r_mm: f64, entry: crate::types::EntryMode, tabs: bool) -> crate::job::Job {
        use crate::geometry::Contour;
        use crate::toolpath::Operation;
        use crate::types::{CutSide, OpType, OperationParams, Stock, TabSpec, Tool};

        let mut job = crate::job::Job::new("bore", machine_600x900(), Stock::default());
        job.operations.push(Operation {
            name: "bore".into(),
            part: "bore".into(),
            role: crate::toolpath::OpRole::Interior,
            contour: Contour::circle(300.0, cy, r_mm),
            tool: Tool::default(), // 6mm
            params: OperationParams {
                op_type: OpType::Profile,
                side: CutSide::Inside,
                entry,
                depth_total_mm: 18.0,
                tabs: TabSpec { enabled: tabs, ..TabSpec::default() },
                ..OperationParams::default()
            },
        });
        job
    }

    #[test]
    fn a_bore_whose_arcs_bulge_past_the_soft_limit_is_refused() {
        use crate::post_grblhal::check_machine_limits;
        use crate::types::EntryMode;

        let m = machine_600x900();
        // Tool centre arc: centred Y892, radius 12 - 3 = 9  =>  top at Y901.0,
        // on a machine with 900mm of Y travel.
        for (entry, tabs, how) in [
            (EntryMode::Plunge, false, "plunge entry, tabs off — one arc per segment"),
            (EntryMode::Ramp, true, "the shipped defaults — the Z-stepping loop subdivides"),
        ] {
            let res = crate::job::plan_job(&bore_job(892.0, 12.0, entry, tabs));
            assert!(res.refusals.is_empty(), "the job did not plan at all ({how}): {:?}", res.refusals);
            let errs = check_machine_limits(&res.path, &m);
            assert!(
                errs.iter().any(|e| e.contains("Y travel")),
                "G3 is GREEN on a program 1.0mm past the Y soft limit ({how}): box max_y {:.3}, \
                 travel {:.3}, errors {:?} — the gantry runs into its own frame",
                res.path.max_y,
                m.travel_y_mm,
                errs
            );
            assert!(
                res.path.max_y >= 901.0 - 1e-6,
                "the box tops out at Y{:.3} and the tool reaches Y901.000 ({how}) — the bound is \
                 being set by how finely something upstream happened to emit, not by the geometry",
                res.path.max_y
            );
        }
    }

    #[test]
    fn a_bore_that_genuinely_fits_is_still_accepted() {
        // ⚠ THE OTHER DIRECTION. Getting this wrong loosely leaves the defect;
        // getting it wrong tightly starts refusing good programs, and a false
        // red on a travel check gets muted. Same bore, 20mm further down the
        // Y travel: the tool centre tops out at Y897.0 and every part of it is on
        // the machine.
        use crate::post_grblhal::check_machine_limits;
        use crate::types::EntryMode;

        let m = machine_600x900();
        for (entry, tabs) in [(EntryMode::Plunge, false), (EntryMode::Ramp, true)] {
            let res = crate::job::plan_job(&bore_job(888.0, 12.0, entry, tabs));
            let errs = check_machine_limits(&res.path, &m);
            assert!(
                errs.is_empty(),
                "a program that fits was refused: box Y {:.3} .. {:.3} against 0 .. {:.3}, {errs:?}",
                res.path.min_y,
                res.path.max_y,
                m.travel_y_mm
            );
            assert!(
                res.path.max_y <= 897.0 + 1e-6,
                "the bound grew past the arc's true extreme (Y897.000): {:.3}",
                res.path.max_y
            );
        }
    }

    #[test]
    fn an_extent_read_off_a_toolpath_contains_the_arc_bulge() {
        // The same defect one consumer along: `fit` and `layout` answer off this
        // extent, so an endpoint box hands back a datum shift that still leaves
        // the arc outside the travel.
        use crate::types::Vec2;

        let mut path = Toolpath { tool: Tool::default(), ..Default::default() };
        path.moves.push(Move::rapid(Vec3::new(270.0, 890.0, 5.0)));
        path.moves.push(Move::arc(
            true,
            Vec3::new(330.0, 890.0, -5.0),
            Vec2::new(300.0, 890.0),
            1000.0,
        ));
        path.recompute_bounds();

        let e = Extent::from_toolpath(&path).expect("a finite path has an extent");
        assert!(
            (e.max_y - 920.0).abs() < 1e-9,
            "the extent tops out at Y{:.3} while the arc reaches Y920.000",
            e.max_y
        );

        // ...and the placement verdict built on it must not say the program is
        // inside 900mm of Y travel.
        let m = machine_600x900();
        let p = plan_datum_shift_for_toolpath(&path, 0.0, &m).expect("path has moves");
        assert!(
            !matches!(p, Placement::AlreadyInside { .. }),
            "a program whose arc runs 20mm past the end of the Y travel was reported as already \
             inside travel: {p:?}"
        );
    }

    #[test]
    fn a_point_set_containing_a_non_finite_point_has_no_extent() {
        // Same silent drop, one layer down: accumulate with `f64::min` and then
        // test the ANSWER for finiteness and the test can never fail.
        assert!(
            Extent::from_points([(0.0, 0.0), (f64::NAN, 50.0), (100.0, 100.0)]).is_none(),
            "a NaN point was left out and the remaining points were reported as the extent"
        );
        assert!(
            Extent::from_points([(f64::NAN, f64::NAN), (100.0, 100.0)]).is_none(),
            "a NaN FIRST point was recovered from by the very min/max that hides it"
        );
        assert!(Extent::from_points([(0.0, 0.0), (f64::INFINITY, 1.0)]).is_none());
        assert!(Extent::from_points([(0.0, 0.0), (100.0, 100.0)]).is_some());
    }

    #[test]
    fn an_empty_toolpath_has_no_extent_rather_than_a_zero_one() {
        let m = machine_600x900();
        let empty = Toolpath { tool: Tool::default(), ..Default::default() };
        assert!(
            plan_datum_shift_for_toolpath(&empty, 0.0, &m).is_none(),
            "an empty program must not report as placed"
        );
        assert!(Extent::from_toolpath(&empty).is_none());
    }

    #[test]
    fn an_inverted_or_infinite_extent_is_refused_at_the_door() {
        assert!(Extent::new(10.0, 0.0, 5.0, 100.0).is_none(), "max_x < min_x accepted");
        assert!(Extent::new(0.0, 10.0, 100.0, 5.0).is_none(), "max_y < min_y accepted");
        assert!(Extent::new(0.0, 0.0, f64::INFINITY, 5.0).is_none(), "infinite bound accepted");
        assert!(Extent::from_points(Vec::<(f64, f64)>::new()).is_none(), "empty point set");
        assert_eq!(
            Extent::from_points([(5.0, 2.0), (-1.0, 9.0), (3.0, 3.0)]),
            Extent::new(-1.0, 2.0, 5.0, 9.0)
        );
    }

    #[test]
    fn growing_by_a_negative_radius_does_not_shrink_the_program() {
        let e = ext(0.0, 0.0, 100.0, 100.0);
        assert_eq!(e.grown(-5.0), e, "a negative radius shrank the cutter's window");
        assert_eq!(e.grown(f64::NAN), e, "NaN radius changed the window");
    }

    #[test]
    fn extents_come_off_parts_including_every_part_on_the_sheet() {
        use crate::geometry::{Contour, Part};
        let parts = vec![
            Part::new("a", Contour::rect(10.0, 20.0, 100.0, 50.0)),
            Part::new("b", Contour::rect(-5.0, 200.0, 30.0, 30.0)),
        ];
        let e = Extent::from_parts(&parts).expect("two parts have an extent");
        assert!((e.min_x + 5.0).abs() < 1e-9, "{e:?}");
        assert!((e.min_y - 20.0).abs() < 1e-9, "{e:?}");
        assert!((e.max_x - 110.0).abs() < 1e-9, "{e:?}");
        assert!((e.max_y - 230.0).abs() < 1e-9, "{e:?}");
        assert!(Extent::from_parts(&[]).is_none(), "no parts is not a zero extent");
    }
}
