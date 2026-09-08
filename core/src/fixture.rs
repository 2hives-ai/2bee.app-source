//! Work-holding — clamps, and the check that keeps the tool out of them.
//!
//! The CAM never chooses a hold-down. It is TOLD where the obstructions are and
//! must route around them.
//!
//! 🔴 An empty clamp list means **"nothing declared"**, which is not the same
//! fact as "verified clear". Only one of those is safe, and the type system
//! here is arranged so the unsafe one cannot be mistaken for the safe one.
//!
//! 🔴 **THE KEEPOUT IS A SWEPT PATH, NOT A SET OF POINTS.** [`Fixturing::check`]
//! walks every move as the line or arc the tool actually travels. It sampled
//! move DESTINATIONS until 2026-08-10, and a 124mm cut whose two ends were both
//! clear of a declared 40mm clamp went out as a green, downloadable program with
//! a 6mm cutter through the clamp at full depth. The exactness matters as much
//! as the fix: [`Clamp::segment_span`] and [`Clamp::arc_hit`] CLIP rather than
//! sample, so this bound does not move with how finely the path happened to be
//! emitted — which is a block-rate concern that nothing in this tree pins.
//!
//! ⚠ **This module DETECTS and REFUSES; it never edits a program to make it
//! safe.** [`Fixturing::clearance_z`] is a threshold, not a lift — read its doc
//! before quoting it, because the previous wording said the opposite.

use crate::geometry::{Contour, Vertex};
// `Move` is used only by this module's tests; the import stays because removing
// it builds clean and breaks `cargo test`, which is a red nobody sees until the
// suite runs.
#[cfg(test)]
use crate::types::Move;
use crate::types::{Machine, MoveKind, Toolpath};

/// A physical obstruction standing on the spoilboard.
#[derive(Clone, Debug)]
pub struct Clamp {
    pub name: String,
    /// The clamp's ANCHOR — machine coordinates, mm. With `rotation_deg == 0`
    /// this is the lower-left corner of the footprint; at any other angle it is
    /// the point the footprint is turned ABOUT, and stays exactly where it is.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// How far the clamp stands above the SPOILBOARD. A rapid must clear this, not
    /// merely clear the workpiece.
    pub height_mm: f64,
    /// How the clamp is laid on the spoilboard: **degrees anticlockwise, about its own
    /// `(x, y)` anchor**.
    ///
    /// 🔴 SAME SIGN AND SAME PIVOT AS [`crate::types::Stock::rotation_deg`], and
    /// that is not a stylistic choice — the workpiece and the clamps share one spoilboard.
    /// If positive meant clockwise here and anticlockwise there, a job turned a
    /// quarter turn would move the work one way and the keepout the other, and
    /// every check downstream would be answering about a setup nobody has. The
    /// agreement is pinned by a test
    /// (`the_clamp_turns_the_same_way_the_sheet_does`) that measures both
    /// against each other rather than trusting this comment.
    ///
    /// ⚠ ONE DELIBERATE DIFFERENCE FROM `Stock`, named so it is not read as a
    /// drift: `Stock::place` pushes the rotated workpiece back so its bounding box
    /// still starts at the datum, because `origin_*` means *"where the corner of
    /// the workpiece is"* — a workpiece is a thing you slide up against a fence. **A
    /// clamp is bolted at a point.** Its `(x, y)` IS that bolt, so there is no
    /// push-back: turning a clamp pivots it and does not walk it. A push-back
    /// here would slide the keepout out from under the thing the clamp is
    /// holding, which is the failure this field exists to make visible.
    ///
    /// 🔴 THIS ROTATES THE KEEPOUT, NOT THE PICTURE. [`Clamp::contains`] — which
    /// is what `CutsClamp` and `RapidBelowClamp` are decided by — and
    /// [`Clamp::contour`] — which is what a viewport draws — are both computed
    /// from [`Clamp::corners`], off this one number. A rotation the render
    /// honoured and the check did not would give an operator a clamp that LOOKS
    /// right and is CHECKED wrong, in two directions and both of them wrong:
    /// a cut into the real clamp passes because the axis-aligned box misses
    /// where the clamp is, or a sound program is refused because that box covers
    /// where the clamp is not.
    pub rotation_deg: f64,
}

impl Clamp {
    /// A clamp square to the machine's axes. Kept at six arguments on purpose: every
    /// existing caller then goes on meaning *"square to the machine's axes"* explicitly,
    /// rather than acquiring an angle it never stated.
    pub fn new(name: impl Into<String>, x: f64, y: f64, w: f64, h: f64, height_mm: f64) -> Self {
        Self { name: name.into(), x, y, w, h, height_mm, rotation_deg: 0.0 }
    }

    /// The same clamp, turned about its own anchor.
    pub fn rotated(mut self, deg: f64) -> Self {
        self.rotation_deg = deg;
        self
    }

    /// Sine and cosine of the placement angle, exact on the quarter turns.
    ///
    /// 🔴 The same arithmetic as `Stock::sin_cos`, and for the same reason:
    /// `(90f64).to_radians().cos()` is 6.1e-17, not 0, so a clamp "turned a
    /// quarter turn" would sit a few times 1e-14 mm out of square and turn every
    /// equality in a test and every golden file into a near-miss. The quarter
    /// turns are the placements a person can actually set against a fence, so
    /// they are the ones that must be exact.
    ///
    /// ⚠ It is duplicated rather than shared because `Stock::sin_cos` is private
    /// to `types.rs` and this lane does not own that file today. **A duplicated
    /// convention is a convention that can drift**, so the duplication is
    /// checked, not trusted: `the_clamp_turns_the_same_way_the_sheet_does`
    /// measures this against `Stock::place` at quarter turns AND at a free
    /// angle. If the two ever disagree, that test goes red rather than the
    /// difference reaching a keepout.
    fn sin_cos(&self) -> (f64, f64) {
        let turns = self.rotation_deg / 90.0;
        if (turns - turns.round()).abs() < 1e-9 {
            match (turns.round() as i64).rem_euclid(4) {
                0 => (0.0, 1.0),
                1 => (1.0, 0.0),
                2 => (0.0, -1.0),
                _ => (-1.0, 0.0),
            }
        } else {
            let r = self.rotation_deg.to_radians();
            (r.sin(), r.cos())
        }
    }

    /// The four corners of the footprint AS PLACED, anticlockwise from the
    /// anchor. **This is the single source both the check and the picture come
    /// from.**
    pub fn corners(&self) -> [(f64, f64); 4] {
        let (s, c) = self.sin_cos();
        // Local footprint corners, anticlockwise: (0,0) (w,0) (w,h) (0,h),
        // each turned about the anchor and offset to it.
        let put = |lx: f64, ly: f64| (self.x + lx * c - ly * s, self.y + lx * s + ly * c);
        [put(0.0, 0.0), put(self.w, 0.0), put(self.w, self.h), put(0.0, self.h)]
    }

    /// A world point in the clamp's own frame, where the footprint is the
    /// axis-aligned rectangle `0..w` x `0..h`.
    fn to_local(&self, px: f64, py: f64) -> (f64, f64) {
        let (s, c) = self.sin_cos();
        let (dx, dy) = (px - self.x, py - self.y);
        (dx * c + dy * s, -dx * s + dy * c)
    }

    /// The inverse of [`Clamp::to_local`] — a point measured in the clamp's
    /// frame, put back in machine coordinates. Findings are reported in MACHINE
    /// coordinates, because that is where the operator has to go and look.
    fn to_world(&self, lx: f64, ly: f64) -> (f64, f64) {
        let (s, c) = self.sin_cos();
        (self.x + lx * c - ly * s, self.y + lx * s + ly * c)
    }

    /// Is `(px, py)` inside the footprint, widened by `margin`?
    ///
    /// The point is taken back into the clamp's own frame and tested against
    /// `0..w` x `0..h` — the same rectangle, asked in the frame where it is
    /// axis-aligned, so a free angle costs no accuracy.
    ///
    /// ⚠ `margin` widens the rectangle, it does not round it, so the corners
    /// over-cover by up to `margin * (sqrt(2) - 1)`. That is what the
    /// axis-aligned version did too, and it errs toward REFUSING a cut that
    /// would have skimmed a corner — the direction this file is allowed to be
    /// wrong in.
    ///
    /// 🔴 THIS ANSWERS ABOUT A POINT, AND A CUTTER TRAVELS A LINE. It is the
    /// right question only where the tool genuinely stops — a drill cycle. For
    /// anything that moves, ask [`Clamp::segment_span`] or [`Clamp::arc_hit`];
    /// asking this one about a move's destination is the defect that let a 6mm
    /// cutter through a 40mm clamp at full depth with every check green.
    pub fn contains(&self, px: f64, py: f64, margin: f64) -> bool {
        let (lx, ly) = self.to_local(px, py);
        lx >= -margin && lx <= self.w + margin && ly >= -margin && ly <= self.h + margin
    }

    /// The part of the straight move `from -> to` that lies inside the
    /// footprint widened by `margin`, as the parametric interval `(t0, t1)` of
    /// that move. `None` when the tool never enters it.
    ///
    /// **Exact, not sampled.** The two ends are taken into the clamp's own
    /// frame and the segment is clipped against the rectangle by the slab
    /// method, so the answer does not depend on how finely anything happens to
    /// be emitted. That matters: the density of the emitted path is a block-rate
    /// concern that nothing pins, and a safety bound that moved with it would be
    /// a bound in name only.
    ///
    /// A zero-length segment reduces to [`Clamp::contains`] on that point — so a
    /// move whose origin is unknown (the first move of a program: `Move` carries
    /// no `from`) degrades to the point test rather than inventing an origin.
    ///
    /// ⚠ A non-finite coordinate returns `Some((0.0, 1.0))` — i.e. it
    /// OVER-reports, where [`Clamp::contains`] silently answered `false`. A NaN
    /// move is refused upstream ([`crate::toolpath::nonfinite_refusal`]); if one
    /// ever reaches here, a keepout is the wrong place to be quietly permissive.
    pub fn segment_span(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        margin: f64,
    ) -> Option<(f64, f64)> {
        let a = self.to_local(from.0, from.1);
        let b = self.to_local(to.0, to.1);
        let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
        for (a1, b1, lo, hi) in [
            (a.0, b.0, -margin, self.w + margin),
            (a.1, b.1, -margin, self.h + margin),
        ] {
            let d = b1 - a1;
            if d.abs() < 1e-12 {
                // Parallel to this slab: in or out for the whole move. The
                // comparison is written so a NaN falls through to "in", which is
                // the over-reporting direction.
                if a1 < lo || a1 > hi {
                    return None;
                }
            } else {
                let (mut ta, mut tb) = ((lo - a1) / d, (hi - a1) / d);
                if ta > tb {
                    std::mem::swap(&mut ta, &mut tb);
                }
                t0 = t0.max(ta);
                t1 = t1.min(tb);
                if t0 > t1 {
                    return None;
                }
            }
        }
        Some((t0, t1))
    }

    /// A point on the ARC `from -> to` about `centre` that lies inside the
    /// footprint widened by `margin`, in machine coordinates. `None` when the
    /// arc never enters it.
    ///
    /// 🔴 **AN ARC IS NOT ITS CHORD, AND THIS IS WHERE THAT IS PAID FOR.** The
    /// core emits a bulged segment as ONE `G2`/`G3`, so the controller travels
    /// the curve while the move's two endpoints — and the straight line between
    /// them — can both be clear of a clamp the arc goes straight through. For a
    /// 180-degree arc the chord misses by the full radius.
    ///
    /// **Exact, not sampled.** A rotation maps a circle to a circle, so in the
    /// clamp's own frame this is an arc against an axis-aligned rectangle: the
    /// arc enters the rectangle if and only if one of its ENDS is inside it, or
    /// it crosses one of the four EDGES at an angle within its own sweep.
    ///
    /// ⚠ A move whose two ends coincide is treated as a FULL circle, which is
    /// what `G2`/`G3` with `I`/`J` and no endpoint change means to grblHAL.
    /// [`crate::sim::simulate`] normalises the same degenerate case to a zero
    /// sweep and stamps a single point; the two disagree deliberately and in
    /// opposite directions, and a keepout is the one that must over-report.
    pub fn arc_hit(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        centre: (f64, f64),
        cw: bool,
        margin: f64,
    ) -> Option<(f64, f64)> {
        use std::f64::consts::TAU;
        if self.contains(from.0, from.1, margin) {
            return Some(from);
        }
        if self.contains(to.0, to.1, margin) {
            return Some(to);
        }
        let a = self.to_local(from.0, from.1);
        let b = self.to_local(to.0, to.1);
        let c = self.to_local(centre.0, centre.1);
        let r = ((a.0 - c.0).powi(2) + (a.1 - c.1).powi(2)).sqrt();
        if !(r > 1e-9) || !r.is_finite() {
            // Degenerate radius: the ends ARE the arc, and both were tested.
            return None;
        }
        let a0 = (a.1 - c.1).atan2(a.0 - c.0);
        let a1 = (b.1 - c.1).atan2(b.0 - c.0);
        let chord = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        // Sweep as a POSITIVE magnitude in the travel direction, so the
        // in-sweep test below is one comparison and needs no loop — a `while`
        // over an angle is how a NaN turns a check into a hang.
        let span = if chord < 1e-9 {
            TAU
        } else if cw {
            (a0 - a1).rem_euclid(TAU)
        } else {
            (a1 - a0).rem_euclid(TAU)
        };
        let in_sweep = |ang: f64| {
            let d = if cw { (a0 - ang).rem_euclid(TAU) } else { (ang - a0).rem_euclid(TAU) };
            d <= span + 1e-12
        };

        let (lo_x, hi_x) = (-margin, self.w + margin);
        let (lo_y, hi_y) = (-margin, self.h + margin);
        let corners =
            [(lo_x, lo_y), (hi_x, lo_y), (hi_x, hi_y), (lo_x, hi_y)];
        for i in 0..4 {
            let p = corners[i];
            let q = corners[(i + 1) % 4];
            let d = (q.0 - p.0, q.1 - p.1);
            let f = (p.0 - c.0, p.1 - c.1);
            let qa = d.0 * d.0 + d.1 * d.1;
            if qa < 1e-18 {
                continue;
            }
            let qb = 2.0 * (f.0 * d.0 + f.1 * d.1);
            let qc = f.0 * f.0 + f.1 * f.1 - r * r;
            let disc = qb * qb - 4.0 * qa * qc;
            if !(disc >= 0.0) {
                continue;
            }
            let sq = disc.sqrt();
            for t in [(-qb - sq) / (2.0 * qa), (-qb + sq) / (2.0 * qa)] {
                if !(0.0..=1.0).contains(&t) {
                    continue;
                }
                let (lx, ly) = (p.0 + d.0 * t, p.1 + d.1 * t);
                if in_sweep((ly - c.1).atan2(lx - c.0)) {
                    let (wx, wy) = self.to_world(lx, ly);
                    return Some((wx, wy));
                }
            }
        }
        None
    }

    /// The footprint as drawn — the rotated quadrilateral, anticlockwise.
    ///
    /// 🔴 Derived from [`Clamp::corners`], the same call [`Clamp::contains`]
    /// agrees with, because a picture and a keepout computed from two numbers
    /// are two different clamps.
    pub fn contour(&self) -> Contour {
        Contour::closed(self.corners().iter().map(|&(x, y)| Vertex::line(x, y)).collect())
    }
}

/// The declared work-holding for a job.
#[derive(Clone, Debug, Default)]
pub struct Fixturing {
    pub clamps: Vec<Clamp>,
    /// Set ONLY by a human confirming they looked at the machine. Defaults false,
    /// and an export with `false` warns every time.
    pub confirmed_clear: bool,
}

/// One phase in a multi-phase clamping sequence.
///
/// 🔴 THE SAFETY PROPERTY IS THE ORDER. A program declares phases so that at
/// each boundary the new clamps go on BEFORE the old ones come off — the part
/// is never loose mid-program. The fixture check runs PER PHASE against that
/// phase's own clamp set, and after a phase boundary the program re-probes
/// because the datum may have shifted.
///
/// Phases are numbered starting at 0. Phase 0 is the initial setup (no
/// preceding boundary); every subsequent phase inserts `M5` + comment + `M0`
/// + re-probe before its first cut.
#[derive(Clone, Debug)]
pub struct ClampPhase {
    /// The clamps that ARE PRESENT during this phase. Different from the
    /// previous phase's set = work has been re-holded.
    pub clamps: Vec<Clamp>,
    /// An optional human-readable note (e.g. "remove centre clamp, add right
    /// stop"). Emitted in the program as a comment at the phase boundary.
    pub note: Option<String>,
}

impl ClampPhase {
    pub fn new(clamps: Vec<Clamp>) -> Self {
        Self { clamps, note: None }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }

    /// The `Fixturing` for this phase alone.
    pub fn as_fixturing(&self) -> Fixturing {
        Fixturing { clamps: self.clamps.clone(), confirmed_clear: false }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum FixtureFinding {
    /// A cutting move passes through a clamp. `x`/`y` are where the tool
    /// ENTERS the footprint — a point the cutter genuinely reaches, in machine
    /// coordinates, so the operator can go and look at it.
    CutsClamp { clamp: String, x: f64, y: f64 },
    /// A rapid crosses a clamp lower than the clamp is tall. `z` is the lowest
    /// the tool gets **while it is over the clamp**, which on a rapid that also
    /// changes height is neither end of the move.
    RapidBelowClamp { clamp: String, z: f64, clamp_height: f64 },
    /// Nothing was declared and nobody confirmed the machine is clear.
    Undeclared,
    /// 🔴 A clamp was declared with no HEIGHT — a footprint nobody measured the
    /// top of.
    ///
    /// [`Fixturing::clearance_z`] takes the TALLEST clamp and REFUSES a rapid
    /// below it. A clamp whose height reads `0.0` contributes nothing to that
    /// maximum, so the threshold falls back to `machine.safe_z_mm` — **5mm by
    /// default** — the rapid clears it on paper, and the gantry crosses the spoilboard
    /// 5mm up with a 40-60mm toggle clamp standing in its path.
    /// `RapidBelowClamp` cannot catch it either: that check compares the rapid's
    /// Z against the same threshold, and a zero height raises it by nothing.
    ///
    /// ⚠ **This paragraph said "lifts every rapid above it" until 2026-08-10 and
    /// that was FALSE** — see the correction on [`Fixturing::clearance_z`].
    /// Nothing in this tree lifts a rapid. The failure above is real either way:
    /// an unmeasured height buys no clearance and therefore no refusal.
    ///
    /// ⚠ This is the shape a BED SCANNER introduces (ml's proposal, 2026-08-09):
    /// a camera returns a 2D `bbox_bed_mm` and no height, because a single
    /// overhead view cannot measure one. Accepting that into `Clamp` would put a
    /// zero in the one field that sets how high the machine flies — a keepout
    /// that looks declared, checks clean, and is invisible to the clearance
    /// arithmetic. "Nobody measured the height" and "the clamp is flat" are
    /// different facts and only the second is safe to fly over.
    ClampHeightUndeclared { clamp: String },
}

impl Fixturing {
    /// The height a rapid **must have reached** to cross the tallest declared
    /// clamp — the threshold [`Fixturing::check`] refuses a rapid below.
    ///
    /// 🔴 **IT LIFTS NOTHING, AND UNTIL 2026-08-10 THIS FILE SAID IT DID.** The
    /// wording here and on [`FixtureFinding::ClampHeightUndeclared`] was
    /// *"takes the TALLEST clamp and lifts every rapid above it"*, and there is
    /// no such mechanism anywhere in the crate. Measured: the only callers of
    /// this function are `check` below and this module's tests, while **every**
    /// rapid the planner emits is at bare `machine.safe_z_mm`
    /// ([`crate::toolpath`], five emission sites) and every retract the post
    /// writes is `G0 Z{safe_z_mm}` ([`crate::post_grblhal`]). A comment claiming
    /// a control raises the machine, when the control is only ever read as a
    /// comparison, is a false green in the one number that decides how high the
    /// gantry flies — and it had propagated into three more places
    /// (`web/src/workholding.ts:325`, `:354`, `:594`), where it warns operators
    /// about a false red that does not exist while the real state is a false
    /// green.
    ///
    /// **The refusal IS the answer here, and that is deliberate rather than a
    /// half-finished lift.** This module's first line is that the CAM never
    /// chooses a hold-down: it is TOLD where the obstructions are and must route
    /// around them. Silently flying higher because a clamp was declared would be
    /// the CAM choosing — it would also change the program an operator already
    /// dry-ran, on data nobody has verified against the machine
    /// ([`FixtureFinding::ClampHeightUndeclared`] exists because that number is
    /// taken on trust). A job whose rapids cross a clamp too low is REFUSED and
    /// named, so a human moves the clamp or raises `safe_z_mm` themselves.
    ///
    /// ⚠ **What this does NOT cover, stated rather than implied:** `safe_z_mm`
    /// is the machine's own setting and this function never writes it back, so
    /// raising the threshold cannot make a program safe — it can only make an
    /// unsafe one refuse. If a future change does wire a lift, it has to reach
    /// [`crate::toolpath`]'s rapid emission AND the post's own retract lines, or
    /// the plan and the emitted program will disagree about how high the machine
    /// flies, which is the failure this lane has already been bitten by four
    /// times.
    ///
    /// ⚠ `Clamp::rotation_deg` turns the footprint about the Z axis, so it
    /// cannot change how tall a clamp stands and this number is rotation-
    /// invariant BY CONSTRUCTION rather than by oversight. Asserted in
    /// `turning_a_clamp_changes_its_footprint_and_not_its_height`, so a future
    /// tilt — which WOULD change the height — cannot land here silently.
    /// **Which clamps a rapid meets is rotation-dependent**, and that half is
    /// decided by [`Clamp::segment_span`] in `check` below, not here.
    pub fn clearance_z(&self, machine: &Machine, stock_thickness: f64) -> f64 {
        let tallest = self.clamps.iter().map(|c| c.height_mm).fold(0.0_f64, f64::max);
        // Clamp heights are measured from the SPOILBOARD; toolpath Z is measured from
        // the WORKPIECE TOP. Converting between the two is exactly the sort of
        // mixed datum that produces a confident, wrong number, so it is done
        // here once and named.
        let clamp_above_stock = (tallest - stock_thickness).max(0.0);
        machine.safe_z_mm.max(clamp_above_stock + 2.0)
    }

    /// Check a toolpath against the declared fixturing.
    ///
    /// `tool_r` widens each clamp by the cutter radius — the tool CENTRE may be
    /// outside a clamp while the cutter is still eating it.
    ///
    /// 🔴 **EVERY MOVE IS WALKED AS THE PATH THE TOOL TRAVELS, NOT AS THE POINT
    /// IT STOPS AT.** [`Move`] carries `to` and no `from`, so this keeps a
    /// cursor — the same shape [`crate::sim::simulate`] uses — and asks each
    /// clamp about the whole swept segment or arc.
    ///
    /// Until 2026-08-10 it asked [`Clamp::contains`] about `m.to` and nothing
    /// else. The material-removal simulation had been segment-aware the whole
    /// time, ~150 lines away in the same crate, while the SAFETY keepout sampled
    /// endpoints: a 124mm cut whose two ends were both clear of a declared 40mm
    /// clamp was emitted, downloadable and green, with a 6mm cutter driven
    /// through the clamp at the full 18mm depth of the workpiece. Proven at the
    /// emitted G-code through the shipping import path, not read off the source.
    ///
    /// ⚠ The cursor is `None` before the first positioning move, and a move with
    /// no known origin is checked as a POINT rather than as a segment from an
    /// invented origin. That is the one place this remains as narrow as it was —
    /// named here rather than papered over, because the first move of a program
    /// is a rapid to safe Z and the tool is wherever the last job left it.
    pub fn check(
        &self,
        path: &Toolpath,
        tool_r: f64,
        stock_thickness: f64,
        machine: &Machine,
    ) -> Vec<FixtureFinding> {
        let mut out = Vec::new();

        if self.clamps.is_empty() && !self.confirmed_clear {
            out.push(FixtureFinding::Undeclared);
        }

        // Reported per clamp, not once for the set: an operator fixing this has
        // to know WHICH clamp nobody measured, and a job with four cams and one
        // unmeasured bar is a different problem from four unmeasured cams.
        for c in &self.clamps {
            if !(c.height_mm > 0.0) {
                out.push(FixtureFinding::ClampHeightUndeclared { clamp: c.name.clone() });
            }
        }

        let clear_z = self.clearance_z(machine, stock_thickness);

        // Where the tool is now. `None` until something positions it — see the
        // caveat in this method's doc.
        let mut cur: Option<crate::types::Vec3> = None;

        for m in &path.moves {
            // A move with no known origin degenerates to its destination, which
            // makes the segment tests below answer exactly what the old point
            // test answered rather than inventing a starting corner.
            let from = cur.unwrap_or(m.to);
            match m.kind {
                MoveKind::Feed => {
                    for c in &self.clamps {
                        if let Some((t0, _)) =
                            c.segment_span((from.x, from.y), (m.to.x, m.to.y), tool_r)
                        {
                            out.push(FixtureFinding::CutsClamp {
                                clamp: c.name.clone(),
                                x: from.x + (m.to.x - from.x) * t0,
                                y: from.y + (m.to.y - from.y) * t0,
                            });
                        }
                    }
                    cur = Some(m.to);
                }
                MoveKind::ArcCW | MoveKind::ArcCCW => {
                    for c in &self.clamps {
                        if let Some((x, y)) = c.arc_hit(
                            (from.x, from.y),
                            (m.to.x, m.to.y),
                            (m.centre.x, m.centre.y),
                            m.kind == MoveKind::ArcCW,
                            tool_r,
                        ) {
                            out.push(FixtureFinding::CutsClamp { clamp: c.name.clone(), x, y });
                        }
                    }
                    cur = Some(m.to);
                }
                MoveKind::DrillCycle => {
                    // Two different motions live in one move, and only one of
                    // them is a plunge. `G81 X.. Y.. Z..` at a NEW XY first
                    // TRAVERSES there at the initial plane and then drills — so
                    // a canned cycle is not simply a point, and calling it one
                    // would drop a real traverse on the floor. In practice the
                    // planner emits a rapid to the hole immediately before
                    // (`crate::toolpath`), which makes this traverse
                    // zero-length; it is checked anyway, because "the planner
                    // happens to position it first" is a property of today's
                    // planner and not of the move.
                    for c in &self.clamps {
                        // `cur.is_some()` and not `from`: with no known origin
                        // there is no traverse to judge, and `from` has already
                        // degenerated to the hole itself — reading its Z there
                        // would report the BORE depth as a traverse height.
                        if cur.is_some()
                            && c.segment_span((from.x, from.y), (m.to.x, m.to.y), tool_r).is_some()
                        {
                            // The traverse rides at the initial plane, not at
                            // the hole's depth.
                            if from.z < clear_z {
                                out.push(FixtureFinding::RapidBelowClamp {
                                    clamp: c.name.clone(),
                                    z: from.z,
                                    clamp_height: c.height_mm,
                                });
                            }
                        }
                        // The plunge itself is a cut, and it happens at ONE
                        // point.
                        if c.contains(m.to.x, m.to.y, tool_r) {
                            out.push(FixtureFinding::CutsClamp {
                                clamp: c.name.clone(),
                                x: m.to.x,
                                y: m.to.y,
                            });
                        }
                    }
                    // A canned cycle retracts to the plane it started from, so
                    // the cursor keeps the ENTRY height. Carrying the hole's
                    // depth forward would make the next rapid look like it
                    // starts 18mm below the workpiece top and would refuse sound jobs.
                    cur = Some(crate::types::Vec3::new(m.to.x, m.to.y, from.z));
                }
                MoveKind::Rapid => {
                    for c in &self.clamps {
                        let Some((t0, t1)) =
                            c.segment_span((from.x, from.y), (m.to.x, m.to.y), tool_r)
                        else {
                            continue;
                        };
                        // Z varies linearly along a rapid, so the lowest the
                        // gantry gets WHILE OVER THE CLAMP is at one end of the
                        // crossing — not necessarily at either end of the move.
                        let z_at = |t: f64| from.z + (m.to.z - from.z) * t;
                        let z = z_at(t0).min(z_at(t1));
                        if z < clear_z {
                            out.push(FixtureFinding::RapidBelowClamp {
                                clamp: c.name.clone(),
                                z,
                                clamp_height: c.height_mm,
                            });
                        }
                    }
                    cur = Some(m.to);
                }
                // Tool change, clamp change, probe, spindle, dwell and comment
                // carry no destination — `to` is the default zero — so they
                // must NOT move the cursor. A comment that dragged the tool to
                // the origin would plant a phantom cut across the whole
                // workpiece.
                _ => {}
            }
        }
        out
    }

    /// Common hold-downs. A vacuum zone declares **no keepout** — and that is
    /// recorded as an explicit zero-height entry rather than an empty list, so
    /// "vacuum, nothing in the way" cannot be confused with "nobody looked".
    pub fn preset(name: &str, stock_x: f64, stock_y: f64) -> Option<Fixturing> {
        let f = match name {
            "pressure-bar" => Fixturing {
                clamps: vec![
                    Clamp::new("bar-left", -10.0, 0.0, 60.0, stock_y, 40.0),
                    Clamp::new("bar-right", stock_x - 50.0, 0.0, 60.0, stock_y, 40.0),
                ],
                confirmed_clear: false,
            },
            "cam-clamps" => Fixturing {
                clamps: vec![
                    Clamp::new("cam-1", -5.0, stock_y * 0.25, 40.0, 40.0, 35.0),
                    Clamp::new("cam-2", -5.0, stock_y * 0.75 - 40.0, 40.0, 40.0, 35.0),
                    Clamp::new("cam-3", stock_x - 35.0, stock_y * 0.25, 40.0, 40.0, 35.0),
                    Clamp::new("cam-4", stock_x - 35.0, stock_y * 0.75 - 40.0, 40.0, 40.0, 35.0),
                ],
                confirmed_clear: false,
            },
            "vacuum" => Fixturing { clamps: Vec::new(), confirmed_clear: true },
            "screws" => Fixturing {
                clamps: vec![
                    Clamp::new("screw-bl", 5.0, 5.0, 12.0, 12.0, 6.0),
                    Clamp::new("screw-br", stock_x - 17.0, 5.0, 12.0, 12.0, 6.0),
                    Clamp::new("screw-tl", 5.0, stock_y - 17.0, 12.0, 12.0, 6.0),
                    Clamp::new("screw-tr", stock_x - 17.0, stock_y - 17.0, 12.0, 12.0, 6.0),
                ],
                confirmed_clear: false,
            },
            _ => return None,
        };
        Some(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Stock, Tool, Vec3};

    fn path_of(moves: Vec<Move>) -> Toolpath {
        let mut p = Toolpath { moves, tool: Tool::default(), ..Default::default() };
        p.recompute_bounds();
        p
    }

    #[test]
    fn a_cut_through_a_clamp_is_found() {
        // 🔴 P7. A toolpath through a clamp destroys the clamp, the cutter and
        // usually the part.
        let f = Fixturing {
            clamps: vec![Clamp::new("bar-left", 0.0, 0.0, 60.0, 900.0, 40.0)],
            confirmed_clear: false,
        };
        let p = path_of(vec![Move::feed_to(Vec3::new(30.0, 400.0, -5.0), 1000.0)]);
        let found = f.check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
            "the cut through the clamp was not found: {found:?}"
        );
    }

    #[test]
    fn a_cut_clear_of_every_clamp_is_not_flagged() {
        // Negative control: if this also reported, the check would be stuck red
        // and would get muted within a week.
        let f = Fixturing {
            clamps: vec![Clamp::new("bar-left", 0.0, 0.0, 60.0, 900.0, 40.0)],
            confirmed_clear: false,
        };
        let p = path_of(vec![Move::feed_to(Vec3::new(300.0, 400.0, -5.0), 1000.0)]);
        let found = f.check(&p, 3.0, 18.0, &Machine::default());
        assert!(found.is_empty(), "clean path flagged: {found:?}");
    }

    #[test]
    fn the_tool_radius_widens_the_clamp() {
        // The tool CENTRE at x=62 is outside a clamp ending at x=60, but a 6mm
        // cutter is still eating it. Checking the centre alone misses this.
        let f = Fixturing {
            clamps: vec![Clamp::new("bar", 0.0, 0.0, 60.0, 900.0, 40.0)],
            confirmed_clear: false,
        };
        let p = path_of(vec![Move::feed_to(Vec3::new(62.0, 400.0, -5.0), 1000.0)]);
        assert!(!f.check(&p, 3.0, 18.0, &Machine::default()).is_empty(), "radius not applied");
        assert!(f.check(&p, 0.5, 18.0, &Machine::default()).is_empty(), "radius over-applied");
    }

    #[test]
    fn a_rapid_below_a_clamp_is_found() {
        let f = Fixturing {
            clamps: vec![Clamp::new("tall-cam", 100.0, 100.0, 40.0, 40.0, 35.0)],
            confirmed_clear: false,
        };
        // safe_z of 5mm clears the 18mm workpiece but NOT a 35mm clamp.
        let p = path_of(vec![Move::rapid(Vec3::new(120.0, 120.0, 5.0))]);
        let found = f.check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::RapidBelowClamp { .. })),
            "a rapid at Z5 over a 35mm clamp was accepted: {found:?}"
        );
    }

    #[test]
    fn clearance_converts_between_the_bed_datum_and_the_stock_datum() {
        // Clamp heights are from the SPOILBOARD, toolpath Z is from the WORKPIECE TOP.
        let f = Fixturing {
            clamps: vec![Clamp::new("cam", 0.0, 0.0, 10.0, 10.0, 35.0)],
            confirmed_clear: false,
        };
        let z = f.clearance_z(&Machine::default(), 18.0);
        // 35mm clamp on an 18mm workpiece stands 17mm proud, +2mm margin.
        assert!((z - 19.0).abs() < 1e-9, "clearance {z}, expected 19");
        // A clamp shorter than the workpiece cannot raise the THRESHOLD at all, so
        // it can never produce a refusal. (This line said "cannot force a lift"
        // until 2026-08-10; nothing here lifts anything — see `clearance_z`.)
        let low = Fixturing {
            clamps: vec![Clamp::new("low", 0.0, 0.0, 10.0, 10.0, 6.0)],
            confirmed_clear: false,
        };
        assert!((low.clearance_z(&Machine::default(), 18.0) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn nothing_declared_is_reported_and_is_not_the_same_as_confirmed_clear() {
        // 🔴 E5. The distinction this whole module is arranged around.
        let nothing = Fixturing::default();
        let p = path_of(vec![Move::feed_to(Vec3::new(10.0, 10.0, -5.0), 1000.0)]);
        assert_eq!(nothing.check(&p, 3.0, 18.0, &Machine::default()), vec![FixtureFinding::Undeclared]);

        let vacuum = Fixturing::preset("vacuum", 600.0, 900.0).unwrap();
        assert!(vacuum.clamps.is_empty(), "a vacuum table declares no keepout");
        assert!(vacuum.confirmed_clear, "...but it IS confirmed clear, which is a different fact");
        assert!(vacuum.check(&p, 3.0, 18.0, &Machine::default()).is_empty());
    }

    #[test]
    fn presets_place_clamps_off_the_stock_or_at_its_edges() {
        let s = Stock::default();
        for name in ["pressure-bar", "cam-clamps", "screws"] {
            let f = Fixturing::preset(name, s.size_x_mm, s.size_y_mm).unwrap();
            assert!(!f.clamps.is_empty(), "{name} declared no clamps");
            assert!(!f.confirmed_clear, "{name} must not self-certify the machine as clear");
        }
        assert!(Fixturing::preset("nonexistent", 600.0, 900.0).is_none());
    }
}

/// 🔴 B1 — THE CUTTER TRAVELS A LINE, AND THE KEEPOUT USED TO SAMPLE POINTS.
///
/// Every test here plants a clamp that a move **passes over without landing
/// on**, which is the case the check was blind to and the case gate P7's own
/// plant cannot express: P7 puts its clamp over a drill point and a profile
/// vertex, both move ENDPOINTS, so it went green with the endpoint-only check
/// and would have gone green with it forever.
///
/// Each test asserts its own vacuity first — both endpoints clear of the clamp —
/// so it cannot quietly become an endpoint test again.
#[cfg(test)]
mod swept_segment_tests {
    use super::*;
    use crate::types::{Machine, Tool, Vec2, Vec3};

    fn path_of(moves: Vec<Move>) -> Toolpath {
        let mut p = Toolpath { moves, tool: Tool::default(), ..Default::default() };
        p.recompute_bounds();
        p
    }

    fn fixturing(c: Clamp) -> Fixturing {
        Fixturing { clamps: vec![c], confirmed_clear: false }
    }

    /// The shipped `cam-clamps` preset's first clamp on a 600x900 workpiece:
    /// x -5..35, y 225..265, 35mm tall. Chosen because it is a REAL preset
    /// entry, not a shape invented to make the test work.
    fn cam_1() -> Clamp {
        Clamp::new("cam-1", -5.0, 225.0, 40.0, 40.0, 35.0)
    }

    /// 🔴 THE FINDING, at the shape the audit proved reachable through the
    /// shipping import path: one long cut whose two ENDPOINTS are both clear of
    /// the clamp and whose middle goes straight through it.
    #[test]
    fn a_cut_between_two_clear_endpoints_that_passes_through_a_clamp_is_found() {
        let c = cam_1();
        let (a, b) = (Vec3::new(20.0, 100.0, -5.0), Vec3::new(20.0, 400.0, -5.0));

        // The control, asserted rather than eyeballed: an endpoint-only check
        // must see NOTHING here, or this test proves nothing about segments.
        assert!(!c.contains(a.x, a.y, 3.0), "endpoint A is in the clamp — the plant is vacuous");
        assert!(!c.contains(b.x, b.y, 3.0), "endpoint B is in the clamp — the plant is vacuous");
        // ...and the middle of the move must genuinely be inside it.
        assert!(c.contains(20.0, 245.0, 3.0), "the plant does not cross the clamp at all");

        let p = path_of(vec![Move::rapid(a), Move::feed_to(b, 1000.0)]);
        let found = fixturing(c).check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
            "a 300mm cut straight through a 35mm clamp, with both endpoints clear, was \
             accepted: {found:?}"
        );
    }

    /// The reported point must be a point the tool actually reaches INSIDE the
    /// clamp. A finding that names a coordinate outside the footprint sends the
    /// operator to the wrong place on the machine.
    #[test]
    fn the_reported_point_is_inside_the_clamp_and_on_the_move() {
        let c = cam_1();
        let p = path_of(vec![
            Move::rapid(Vec3::new(20.0, 100.0, -5.0)),
            Move::feed_to(Vec3::new(20.0, 400.0, -5.0), 1000.0),
        ]);
        let found = fixturing(c.clone()).check(&p, 3.0, 18.0, &Machine::default());
        let Some(FixtureFinding::CutsClamp { x, y, .. }) =
            found.iter().find(|f| matches!(f, FixtureFinding::CutsClamp { .. }))
        else {
            panic!("no CutsClamp to check the coordinates of: {found:?}");
        };
        assert!(c.contains(*x, *y, 3.0), "the finding names ({x}, {y}), which is not in the clamp");
        assert!((*x - 20.0).abs() < 1e-9, "the finding names an X the move never visits: {x}");
        assert!(
            (100.0..=400.0).contains(y),
            "the finding names a Y outside the move it is about: {y}"
        );
    }

    /// 🔴 B2's real cost, and the reason the missing lift is a refusal rather
    /// than a silent flight: the gantry crossing a 35mm clamp at the 5mm default
    /// safe Z, between two endpoints that are both clear.
    #[test]
    fn a_rapid_between_two_clear_endpoints_that_crosses_a_clamp_is_found() {
        let c = cam_1();
        let (a, b) = (Vec3::new(20.0, 100.0, 5.0), Vec3::new(20.0, 400.0, 5.0));
        assert!(!c.contains(a.x, a.y, 3.0) && !c.contains(b.x, b.y, 3.0), "the plant is vacuous");

        let p = path_of(vec![Move::rapid(a), Move::rapid(b)]);
        let found = fixturing(c).check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::RapidBelowClamp { .. })),
            "the gantry crossed a 35mm clamp 5mm off the workpiece and nothing objected: {found:?}"
        );
    }

    /// The mirror. A check that reported every move once the clamp was declared
    /// would pass all of the above and be useless — and a false red gets muted.
    #[test]
    fn a_cut_that_passes_beside_a_clamp_is_not_flagged() {
        let c = cam_1();
        // 3mm cutter centre at x=40: 5mm clear of the clamp's x=35 edge, 2mm
        // clear once the radius is applied. Same long move, same Y span.
        let p = path_of(vec![
            Move::rapid(Vec3::new(40.0, 100.0, -5.0)),
            Move::feed_to(Vec3::new(40.0, 400.0, -5.0), 1000.0),
        ]);
        assert!(
            fixturing(c).check(&p, 3.0, 18.0, &Machine::default()).is_empty(),
            "a cut 5mm clear of the clamp was refused"
        );
    }

    /// A rapid ABOVE the tallest clamp crosses it freely. Without this the
    /// segment walk would refuse every linking move on any job with a clamp,
    /// which is the false red that gets the whole check switched off.
    #[test]
    fn a_rapid_that_clears_the_clamp_is_not_flagged_even_though_it_crosses_it() {
        let c = cam_1();
        let f = fixturing(c);
        // 35mm clamp, 18mm workpiece: 17mm proud, +2mm margin = 19mm.
        let clear = f.clearance_z(&Machine::default(), 18.0);
        assert!((clear - 19.0).abs() < 1e-9, "the control rests on the wrong number: {clear}");
        let p = path_of(vec![
            Move::rapid(Vec3::new(20.0, 100.0, clear)),
            Move::rapid(Vec3::new(20.0, 400.0, clear)),
        ]);
        assert!(
            f.check(&p, 3.0, 18.0, &Machine::default()).is_empty(),
            "a rapid ABOVE the clamp was refused for crossing it"
        );
    }

    /// 🔴 AN ARC IS NOT ITS CHORD. The endpoints are clear, the straight line
    /// between them is clear, and the arc the controller actually travels goes
    /// through the clamp. Sampling the chord — the obvious half-fix — passes
    /// this and is exactly as wrong as sampling the endpoints.
    #[test]
    fn an_arc_that_bulges_into_a_clamp_is_found_where_its_chord_would_have_missed() {
        // Semicircle, centre (100, 100), r = 60, from (160,100) to (40,100),
        // travelling anticlockwise over the top: the arc reaches y = 160.
        let c = Clamp::new("bar", 80.0, 145.0, 40.0, 20.0, 40.0);
        let (a, b) = (Vec3::new(160.0, 100.0, -5.0), Vec3::new(40.0, 100.0, -5.0));

        assert!(!c.contains(a.x, a.y, 3.0) && !c.contains(b.x, b.y, 3.0), "endpoints not clear");
        // The CHORD is the straight line y = 100 from x 160 to x 40 — assert it
        // misses, so a chord-sampling check cannot pass this test.
        assert!(
            Clamp::segment_span(&c, (a.x, a.y), (b.x, b.y), 3.0).is_none(),
            "the chord itself enters the clamp — a chord-sampling check would pass this test"
        );

        let p = path_of(vec![
            Move::rapid(a),
            Move::arc(false, b, Vec2::new(100.0, 100.0), 1000.0),
        ]);
        let found = fixturing(c).check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
            "an arc through a clamp was accepted because its endpoints and its chord are \
             clear: {found:?}"
        );
    }

    /// The other mirror, and it is not a formality: a check that widened an arc
    /// to its bounding box, or that tested the chord, would fail here. The
    /// clamp sits ON the chord and nowhere near the arc.
    #[test]
    fn an_arc_that_bulges_away_from_a_clamp_on_its_chord_is_not_flagged() {
        // Same semicircle. The clamp sits just above the chord, in the middle,
        // where the arc never goes because the arc is 60mm higher there.
        let c = Clamp::new("bar", 90.0, 101.0, 20.0, 10.0, 40.0);
        let (a, b) = (Vec3::new(160.0, 100.0, -5.0), Vec3::new(40.0, 100.0, -5.0));

        assert!(
            Clamp::segment_span(&c, (a.x, a.y), (b.x, b.y), 3.0).is_some(),
            "the control is vacuous: the CHORD must hit this clamp, or a chord-sampling \
             check would pass this test too"
        );

        let p = path_of(vec![
            Move::rapid(a),
            Move::arc(false, b, Vec2::new(100.0, 100.0), 1000.0),
        ]);
        assert!(
            fixturing(c).check(&p, 3.0, 18.0, &Machine::default()).is_empty(),
            "a sound arc was refused because its CHORD crosses a clamp the tool never reaches"
        );
    }

    /// A clamp that is TURNED must be crossed by the same arithmetic. The
    /// rotation work rebuilt `contains`; the segment walk has to go through the
    /// same frame or a turned clamp is back to being checked as a box.
    #[test]
    fn a_cut_across_a_rotated_clamp_between_clear_endpoints_is_found() {
        let turned = Clamp::new("bar", 100.0, 100.0, 200.0, 20.0, 40.0).rotated(45.0);
        let (a, b) = (Vec3::new(120.0, 220.0, -5.0), Vec3::new(260.0, 220.0, -5.0));
        assert!(
            !turned.contains(a.x, a.y, 3.0) && !turned.contains(b.x, b.y, 3.0),
            "the plant is vacuous — an endpoint is already inside the turned clamp"
        );
        let square = turned.clone().rotated(0.0);
        assert!(
            Clamp::segment_span(&square, (a.x, a.y), (b.x, b.y), 3.0).is_none(),
            "the control is vacuous: this move must MISS the clamp when it is square to the machine's axes"
        );

        let p = path_of(vec![Move::rapid(a), Move::feed_to(b, 1000.0)]);
        let found = fixturing(turned).check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
            "a cut across a TURNED clamp was accepted: {found:?}"
        );
    }

    /// 🔴 A canned cycle at a NEW XY traverses there before it drills — `G81 X..
    /// Y.. Z..` is a move, not only a hole — and that traverse rides at the
    /// initial plane, so it is checked exactly like a rapid.
    ///
    /// Today the planner always emits a rapid to the hole first, which makes
    /// this traverse zero-length; the test exists because that is a property of
    /// today's planner, not of the move, and a keepout that relies on it is
    /// relying on something nothing pins.
    #[test]
    fn a_drill_cycle_that_traverses_to_its_hole_has_that_traverse_checked() {
        let c = cam_1();
        let (a, hole) = (Vec3::new(20.0, 100.0, 5.0), Vec3::new(20.0, 400.0, -18.0));
        assert!(!c.contains(a.x, a.y, 3.0), "the plant is vacuous");
        assert!(!c.contains(hole.x, hole.y, 3.0), "the plant is vacuous — the hole is IN the clamp");

        let p = path_of(vec![Move::rapid(a), Move::drill(hole, 3.0, 300.0)]);
        let found = fixturing(c).check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::RapidBelowClamp { .. })),
            "a canned cycle traversed 300mm across a 35mm clamp at 5mm and nothing \
             objected: {found:?}"
        );
    }

    /// The mirror, and the false red it prevents: after the hole, the tool is
    /// back at the initial plane, NOT at the bottom of the bore. A cursor that
    /// carried the drilled depth forward would make the very next rapid look
    /// like it starts 18mm below the workpiece top and would refuse a sound job.
    #[test]
    fn a_drill_cycle_does_not_poison_the_height_of_the_rapid_after_it() {
        let c = cam_1();
        let f = fixturing(c);
        let clear = f.clearance_z(&Machine::default(), 18.0); // 19mm
        let p = path_of(vec![
            Move::rapid(Vec3::new(20.0, 100.0, clear + 6.0)),
            Move::drill(Vec3::new(20.0, 100.0, -18.0), 3.0, 300.0),
            // Crosses the clamp, but WELL above it, at both ends.
            Move::rapid(Vec3::new(20.0, 400.0, clear + 6.0)),
        ]);
        assert!(
            f.check(&p, 3.0, 18.0, &Machine::default()).is_empty(),
            "a rapid 6mm above the clearance height was refused because the hole before it \
             was deep — the cursor is carrying the bore depth, not the retract plane"
        );
    }

    /// 🔴 The failure the whole segment walk exists for, stated as the physical
    /// event rather than as a code path: the linking rapid between two
    /// operations. `plan_job` concatenates per-operation paths and its own
    /// comment says "an operation is clear of the clamps on its own while the
    /// rapid that links it to the next one is not" — which was true of the
    /// comment and not of the check.
    #[test]
    fn the_rapid_that_links_two_operations_is_walked_across_the_clamp() {
        let c = cam_1();
        let p = path_of(vec![
            // op A finishes below the clamp...
            Move::feed_to(Vec3::new(20.0, 120.0, -5.0), 1000.0),
            Move::rapid(Vec3::new(20.0, 120.0, 5.0)),
            // ...the link rapid crosses it at safe Z...
            Move::rapid(Vec3::new(20.0, 380.0, 5.0)),
            // ...and op B starts above it, clear.
            Move::feed_to(Vec3::new(20.0, 400.0, -5.0), 1000.0),
        ]);
        let found = fixturing(c).check(&p, 3.0, 18.0, &Machine::default());
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::RapidBelowClamp { .. })),
            "the linking rapid crossed a 35mm clamp at 5mm and nothing objected: {found:?}"
        );
    }
}

#[cfg(test)]
mod clamp_height_tests {
    use super::*;
    use crate::types::{Machine, Move, Toolpath};

    fn rapid_across_the_bed(z: f64) -> Toolpath {
        let mut p = Toolpath::default();
        p.moves.push(Move { kind: MoveKind::Rapid, ..Default::default() });
        if let Some(m) = p.moves.last_mut() {
            m.to.x = 200.0;
            m.to.y = 50.0;
            m.to.z = z;
        }
        p
    }

    /// 🔴 A clamp with no height is a footprint nobody measured the top of, and
    /// the clearance arithmetic reads it as FLAT.
    ///
    /// `clearance_z` is the height a rapid must have REACHED to cross the
    /// tallest clamp — it is a refusal threshold and it lifts nothing (see the
    /// correction on that function; this doc claimed a lift until 2026-08-10).
    /// A `0.0` height contributes nothing to that maximum, so the threshold
    /// falls back to `machine.safe_z_mm` — 5mm by default — every rapid clears
    /// it on paper, and the gantry crosses the spoilboard 5mm up with a toggle clamp
    /// standing in the way. `RapidBelowClamp` cannot save it: an unmeasured
    /// height raises the threshold by nothing, so there is nothing to be below.
    #[test]
    fn a_clamp_with_no_height_is_reported_because_the_clearance_maths_reads_it_as_flat() {
        let f = Fixturing {
            clamps: vec![Clamp::new("scan-proposed", 100.0, 20.0, 45.0, 45.0, 0.0)],
            confirmed_clear: false,
        };
        let findings = f.check(&rapid_across_the_bed(5.0), 3.0, 18.0, &Machine::default());
        assert!(
            findings.contains(&FixtureFinding::ClampHeightUndeclared {
                clamp: "scan-proposed".into()
            }),
            "an unmeasured clamp height was not reported: {findings:?}"
        );
    }

    /// The arithmetic that makes the above dangerous, asserted directly so the
    /// finding cannot be "fixed" by deleting it and leaving the maths.
    #[test]
    fn a_zero_height_clamp_buys_no_clearance_at_all() {
        let machine = Machine::default();
        let flat = Fixturing {
            clamps: vec![Clamp::new("unmeasured", 0.0, 0.0, 40.0, 40.0, 0.0)],
            confirmed_clear: false,
        };
        let real = Fixturing {
            clamps: vec![Clamp::new("measured", 0.0, 0.0, 40.0, 40.0, 55.0)],
            confirmed_clear: false,
        };
        let z_flat = flat.clearance_z(&machine, 18.0);
        let z_real = real.clearance_z(&machine, 18.0);
        assert_eq!(
            z_flat, machine.safe_z_mm,
            "a zero-height clamp raised the rapid height, so this test proves nothing"
        );
        assert!(
            z_real > z_flat,
            "a 55mm clamp bought no more clearance than an unmeasured one: {z_real} vs {z_flat}"
        );
    }

    /// A rotated clamp with no height is STILL reported. The rotation work
    /// rebuilt `contains`, and a keepout whose geometry moved is exactly the
    /// place an unrelated finding gets lost — this finding is decided on
    /// `height_mm` alone and must stay independent of where the footprint
    /// points.
    #[test]
    fn rotating_a_clamp_does_not_hide_that_nobody_measured_its_height() {
        let f = Fixturing {
            clamps: vec![Clamp::new("scan-proposed", 100.0, 20.0, 45.0, 45.0, 0.0).rotated(37.0)],
            confirmed_clear: false,
        };
        let findings = f.check(&rapid_across_the_bed(5.0), 3.0, 18.0, &Machine::default());
        assert!(
            findings.contains(&FixtureFinding::ClampHeightUndeclared {
                clamp: "scan-proposed".into()
            }),
            "an unmeasured clamp height stopped being reported once the clamp was turned: {findings:?}"
        );
    }

    /// A measured clamp must NOT trip the new finding — otherwise every real job
    /// carries a warning and the warning stops being read.
    #[test]
    fn a_measured_clamp_is_not_reported() {
        let f = Fixturing {
            clamps: vec![Clamp::new("cam-1", 100.0, 20.0, 45.0, 45.0, 35.0)],
            confirmed_clear: false,
        };
        let findings = f.check(&rapid_across_the_bed(60.0), 3.0, 18.0, &Machine::default());
        assert!(
            !findings
                .iter()
                .any(|f| matches!(f, FixtureFinding::ClampHeightUndeclared { .. })),
            "a measured clamp was reported as unmeasured: {findings:?}"
        );
    }
}

#[cfg(test)]
mod rotated_clamp_tests {
    use super::*;
    use crate::types::{Machine, Move, Stock, Tool, Vec3};

    fn path_of(moves: Vec<Move>) -> Toolpath {
        let mut p = Toolpath { moves, tool: Tool::default(), ..Default::default() };
        p.recompute_bounds();
        p
    }

    /// The clamp both traps below are built from. Anchor (100,100), 200 long,
    /// 20 wide, turned 45 degrees anticlockwise about that anchor. Square to the
    /// machine's axes it occupies x 100..300, y 100..120; turned, it sweeps up to y ~255
    /// and away from most of that box.
    fn diagonal_bar() -> Clamp {
        Clamp::new("bar", 100.0, 100.0, 200.0, 20.0, 40.0).rotated(45.0)
    }

    fn fixturing(c: Clamp) -> Fixturing {
        Fixturing { clamps: vec![c], confirmed_clear: false }
    }

    /// 🔴 THE TRAP, and the reason `contains` was rebuilt rather than left
    /// alone. `(190, 200)` is 80mm clear of the axis-aligned box and squarely
    /// inside the turned clamp. A keepout still testing the box would let this
    /// cut through, and the viewport would have drawn the clamp exactly where
    /// the cutter is about to arrive.
    #[test]
    fn a_cut_that_clears_the_axis_aligned_box_but_hits_the_rotated_clamp_is_found() {
        let square = diagonal_bar().rotated(0.0);
        let turned = diagonal_bar();
        let p = path_of(vec![Move::feed_to(Vec3::new(190.0, 200.0, -5.0), 1000.0)]);
        let m = Machine::default();

        assert!(
            fixturing(square).check(&p, 3.0, 18.0, &m).is_empty(),
            "the control is vacuous: this cut must MISS the unrotated clamp, or the test below \
             would pass with the rotation ignored"
        );
        let found = fixturing(turned).check(&p, 3.0, 18.0, &m);
        assert!(
            found.iter().any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
            "a cut into a clamp that is TURNED was accepted — the check is still reading the \
             axis-aligned box: {found:?}"
        );
    }

    /// The mirror, and it is not a formality: a check that widened the keepout
    /// to the rotated clamp's BOUNDING BOX would pass the test above and fail
    /// this one. Refusing a sound program is the cheaper failure of the two, but
    /// it is still a false red, and a false red gets muted.
    ///
    /// 🔴 THE POINT WAS CHOSEN BY PLANTING, NOT BY EYE, and the first one was
    /// VACUOUS. `(280, 110)` is inside the axis-aligned box and outside the
    /// turned clamp, which reads like a perfectly good mirror — but it is also
    /// outside the turned clamp's BOUNDING BOX, so the half-fix this test claims
    /// to catch (test the bbox of the rotated corners) passed it. Measured: with
    /// that plant in place only `the_tool_radius_widens_a_rotated_clamp…` went
    /// red, by 0.5mm, and this test scored green while proving nothing.
    /// `(200, 110)` is inside the axis-aligned box, inside the rotated bounding
    /// box, and outside the clamp — so it can only be answered by the clamp.
    #[test]
    fn a_cut_that_hits_the_axis_aligned_box_but_clears_the_rotated_clamp_is_not_flagged() {
        let square = diagonal_bar().rotated(0.0);
        let turned = diagonal_bar();
        let p = path_of(vec![Move::feed_to(Vec3::new(200.0, 110.0, -5.0), 1000.0)]);
        let m = Machine::default();

        // The bounding box is asserted to be the WRONG answer here, so this test
        // cannot quietly stop distinguishing the two.
        let k = turned.corners();
        let inside_bbox = |px: f64, py: f64| {
            px >= k.iter().map(|p| p.0).fold(f64::INFINITY, f64::min)
                && px <= k.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max)
                && py >= k.iter().map(|p| p.1).fold(f64::INFINITY, f64::min)
                && py <= k.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max)
        };
        assert!(
            inside_bbox(200.0, 110.0),
            "the control is vacuous against a bounding-box keepout: pick a point INSIDE the \
             rotated clamp's bounding box, or this test passes on a check that never looked \
             at the clamp"
        );

        assert!(
            fixturing(square).check(&p, 3.0, 18.0, &m).iter().any(|x| matches!(
                x,
                FixtureFinding::CutsClamp { .. }
            )),
            "the control is vacuous: this cut must HIT the unrotated clamp"
        );
        assert!(
            fixturing(turned).check(&p, 3.0, 18.0, &m).is_empty(),
            "a sound program was refused for a clamp that is not there — the keepout is the \
             rotated clamp's bounding box, not the clamp"
        );
    }

    /// A rapid is decided by the same geometry, so it inherits the same trap.
    /// Checked separately because `CutsClamp` and `RapidBelowClamp` are two
    /// arms of `check` and only one of them was exercised above.
    #[test]
    fn a_rapid_over_a_rotated_clamp_is_found_where_the_box_would_have_missed_it() {
        let m = Machine::default();
        // safe_z 5mm clears the 18mm workpiece and not a 40mm clamp.
        let p = path_of(vec![Move::rapid(Vec3::new(190.0, 200.0, 5.0))]);

        assert!(
            !fixturing(diagonal_bar().rotated(0.0))
                .check(&p, 3.0, 18.0, &m)
                .iter()
                .any(|x| matches!(x, FixtureFinding::RapidBelowClamp { .. })),
            "the control is vacuous: this rapid must MISS the unrotated clamp"
        );
        assert!(
            fixturing(diagonal_bar())
                .check(&p, 3.0, 18.0, &m)
                .iter()
                .any(|x| matches!(x, FixtureFinding::RapidBelowClamp { .. })),
            "the gantry crossed a turned clamp 5mm up and nothing objected"
        );
    }

    /// 🔴 THE SHARED CONVENTION, measured rather than asserted in a comment.
    ///
    /// `Stock::place` translates as well as rotates, so the ROTATION is the
    /// difference between two placed points — the push-back cancels. Comparing
    /// the clamp's own edge vectors against that difference pins the sign and
    /// the axis order for the workpiece and the clamps together: flip one and this
    /// goes red, instead of a job turning its work one way and its keepouts the
    /// other.
    ///
    /// It also pins the ONE deliberate difference — the anchor does not move.
    #[test]
    fn the_clamp_turns_the_same_way_the_sheet_does() {
        for deg in [0.0, 90.0, 180.0, 270.0, -90.0, 37.0] {
            let c = Clamp::new("t", 17.0, -4.0, 60.0, 25.0, 40.0).rotated(deg);
            let s = Stock { rotation_deg: deg, ..Stock::default() };
            let (ox, oy) = s.place(0.0, 0.0);
            let (wx, wy) = s.place(60.0, 0.0);
            let (hx, hy) = s.place(0.0, 25.0);
            let k = c.corners();

            assert!(
                (k[1].0 - k[0].0 - (wx - ox)).abs() < 1e-9
                    && (k[1].1 - k[0].1 - (wy - oy)).abs() < 1e-9,
                "at {deg} deg the clamp's w axis and the workpiece's disagree: clamp \
                 {:?} workpiece {:?}",
                (k[1].0 - k[0].0, k[1].1 - k[0].1),
                (wx - ox, wy - oy)
            );
            assert!(
                (k[3].0 - k[0].0 - (hx - ox)).abs() < 1e-9
                    && (k[3].1 - k[0].1 - (hy - oy)).abs() < 1e-9,
                "at {deg} deg the clamp's h axis and the workpiece's disagree"
            );
            assert_eq!(
                k[0],
                (17.0, -4.0),
                "the anchor moved at {deg} deg — a clamp is bolted at a point and does not \
                 walk when it is turned (this is the one place Stock's push-back does NOT apply)"
            );
        }
    }

    /// Quarter turns must be EXACT, for the same reason `Stock::sin_cos` says:
    /// they are the placements a person can set against a fence, and 6.1e-17
    /// turns every golden file into a near-miss. Asserted with `==` on purpose.
    #[test]
    fn a_quarter_turn_lands_exactly_on_the_axis() {
        let c = Clamp::new("bar", 0.0, 0.0, 200.0, 20.0, 40.0).rotated(90.0);
        assert_eq!(c.corners(), [(0.0, 0.0), (0.0, 200.0), (-20.0, 200.0), (-20.0, 0.0)]);

        let back = Clamp::new("bar", 0.0, 0.0, 200.0, 20.0, 40.0).rotated(-90.0);
        assert_eq!(back.corners(), [(0.0, 0.0), (0.0, -200.0), (20.0, -200.0), (20.0, 0.0)]);
    }

    /// 🔴 One number, two consumers. If the picture and the keepout ever come
    /// from different arithmetic, the operator is looking at a clamp that is not
    /// the one being checked — which is the whole ticket.
    #[test]
    fn the_picture_and_the_check_are_computed_from_the_same_number() {
        let c = diagonal_bar();
        let drawn = c.contour();
        assert!(drawn.closed);
        assert_eq!(drawn.verts.len(), 4);
        for (v, k) in drawn.verts.iter().zip(c.corners()) {
            assert_eq!((v.x, v.y), k, "the drawn footprint is not the checked footprint");
            assert!(
                c.contains(v.x, v.y, 1e-6),
                "a corner of the drawn clamp is outside the checked clamp"
            );
        }
        // The far corner of the AXIS-ALIGNED box is not in the clamp any more —
        // so neither the drawing nor the check is still that rectangle.
        assert!(!c.contains(300.0, 100.0, 0.0));
    }

    /// The tool radius must widen the TURNED clamp, measured normal to its own
    /// edge. A point 1mm off the long edge is caught by a 6mm cutter and not by
    /// a 1mm one; checking the centre alone, or widening the wrong rectangle,
    /// fails one of the two.
    #[test]
    fn the_tool_radius_widens_a_rotated_clamp_normal_to_its_own_edge() {
        let c = diagonal_bar();
        let (s, cos) = (45f64.to_radians().sin(), 45f64.to_radians().cos());
        // Local (100, 21): 1mm outside the long edge at ly = h = 20.
        let px = 100.0 + 100.0 * cos - 21.0 * s;
        let py = 100.0 + 100.0 * s + 21.0 * cos;
        assert!(c.contains(px, py, 3.0), "radius not applied to the rotated clamp");
        assert!(!c.contains(px, py, 0.5), "radius over-applied to the rotated clamp");
    }

    /// Rotation is about Z. It turns the footprint and CANNOT change how tall
    /// the clamp stands — asserted rather than assumed, so a future tilt (which
    /// would change it) cannot land here quietly.
    #[test]
    fn turning_a_clamp_changes_its_footprint_and_not_its_height() {
        let m = Machine::default();
        let flat = fixturing(diagonal_bar().rotated(0.0));
        let turned = fixturing(diagonal_bar());
        assert_eq!(flat.clearance_z(&m, 18.0), turned.clearance_z(&m, 18.0));
        assert_ne!(
            flat.clamps[0].corners(),
            turned.clamps[0].corners(),
            "the control is vacuous: the two clamps have the same footprint"
        );
    }

    /// 🔴 REGRESSION PIN. Every clamp in the tree today is square to the machine's axes,
    /// and the new arithmetic must be BYTE-for-byte the old answer there — the
    /// old formula is written out longhand rather than cited, so this test does
    /// not go green by being changed alongside the code it guards.
    #[test]
    fn a_clamp_square_to_the_bed_answers_exactly_as_the_axis_aligned_test_did() {
        let c = Clamp::new("bar", 12.5, -7.25, 60.0, 33.5, 40.0);
        assert_eq!(c.rotation_deg, 0.0, "`new` must still mean square to the machine's axes");
        let old = |px: f64, py: f64, margin: f64| {
            px >= c.x - margin
                && px <= c.x + c.w + margin
                && py >= c.y - margin
                && py <= c.y + c.h + margin
        };
        let mut probed = 0;
        for i in -20..=120 {
            for j in -20..=120 {
                let (px, py) = (i as f64 * 1.0, j as f64 * 0.75);
                for margin in [0.0, 0.5, 3.0] {
                    assert_eq!(
                        c.contains(px, py, margin),
                        old(px, py, margin),
                        "unrotated keepout moved at ({px}, {py}) margin {margin}"
                    );
                    probed += 1;
                }
            }
        }
        assert!(probed > 10_000, "the grid is too small to be a regression pin");
        assert_eq!(c.contour().verts.len(), 4);
    }
}

// ===========================================================================
//  HOLD-DOWN — does the declared work holding actually HOLD the work, and does
//  it still hold it at every moment of the program?
// ===========================================================================
//
// 🔴 **THIS IS THE OPPOSITE QUESTION TO [`Fixturing::check`], AND THE TWO ARE
// SILENT ABOUT EACH OTHER.** `check` asks *does the fixturing get in the way* —
// will the cutter or the gantry hit a clamp. This asks *does the fixturing do
// its job*. A part can be perfectly clear of every clamp and still be
// unrestrained: held at one end while the cutter works the other, or released
// entirely the moment its outline closes. Same clamps, same program, two
// different failures, and until 2026-08-10 nothing in this crate asked the
// second one.
//
// The physical failure named, because this file's rule is that every check
// names one: **an unrestrained offcut in a spinning cutter lifts, climbs the
// tool and is thrown.** It is the classic router injury. This is not a
// tidiness check.
//
// # Three properties this is built on, each of which has bitten this lane
//
// 1. **IT READS THE EMITTED PROGRAM, NOT THE PLAN.** [`check_hold_down`] takes
//    G-code text. A restraint check written on `Job::operations`, on
//    `TabSpec::enabled`, or even on `Toolpath::moves` would be green about an
//    intention; the thing that goes on the machine is the text. This lane has
//    been bitten by the plan/program gap five times (`P3`, `P4`, `ENT`,
//    `JobSummary`, `REL`) and the rule is in `AGENTS.md`.
//
//    ⚠ **The cost, named rather than discovered later:** this is a SECOND
//    reader of the dialect in the core (`job::summarize_program` is the first),
//    and two readers can drift from one writer. It is mitigated the same way
//    `summarize_program` mitigates it — anything this reader does not
//    understand is **named** into [`HoldDownBasis::pending`] and suppresses the
//    answer, rather than being skipped — and by taking the operation banners
//    through [`crate::toolpath::parse_banner`], the format's one reader, rather
//    than a regex of its own.
//
// 2. **RESTRAINT CHANGES *DURING* THE JOB.** A part held by its own uncut
//    material is restrained until the cut that frees it, so the question is
//    *when*, not only *whether*. The state at the start of the program is not
//    the state at the end. **Tabs need no special handling and deliberately get
//    none**: `toolpath` raises Z inside a tab window, so a tab is simply a
//    bridge of cells the program never takes to through-depth. Keying this on a
//    `TabSpec` would be reading the plan again, and would be blind to a tab the
//    engine planned and did not emit.
//
// 3. **ABSENCE IS NOT SAFETY.** No clamps declared can never read as *held*:
//    every algorithm below is trivially satisfied by an empty clamp list
//    ("no clamp stands on removed material" is *true* when there are no
//    clamps), so zero declared clamps makes every check **PENDING**, never
//    clean — the same distinction [`FixtureFinding::Undeclared`] and
//    `sim::check`'s spoilboard wording already draw. A check that cannot run
//    reports PENDING with the reason; it never passes.
//
// # What is computable here, and what is INVENTED and therefore refused
//
// Computable from geometry and program order: where the clamps bear, what
// material is gone and *when*, what is still joined to what, and which pieces
// carry a clamp. Everything below lives inside that.
//
// 🔴 **NOT computable, and it must be SAID rather than guessed: whether the
// clamping FORCE is enough.** That needs clamp preload, the friction
// coefficient of the pair, cutting force from engagement x feed x material, and
// vibration. **None of them is in this tool and none may be invented** — see
// [`HoldDownBasis::force_checked`], which is `false` on every job forever.
// `docs/workholding-research.md` records that no vacuum vendor publishes a
// holding force at all, and that there are no published shear/lift figures for
// tape or tape+CA on plywood. A fabricated hold-down number would be the first
// figure in this tool that a person stands next to a spindle because of.

/// How wrong the answer can be, stated as data rather than as a paragraph
/// somebody may not scroll to — the shape [`crate::optimise::TravelBasis`]
/// already uses: fields that are *always* the same value, and say why.
///
/// 🔴 **It is emitted on EVERY job, clean or not.** A caveat that appears only
/// when something else is wrong is a caveat nobody sees on the day it matters.
#[derive(Clone, Debug, PartialEq)]
pub struct HoldDownBasis {
    /// **Always false.** This tool has no clamp preload, no friction
    /// coefficient, no cutting-force model and no vibration model, and it never
    /// will until somebody measures them.
    pub force_checked: bool,
    /// **Always false.** Contact area is taken as the DECLARED FOOTPRINT. A
    /// toggle clamp bears on a pad smaller than its outline and no catalogue
    /// entry publishes that pad, so the held area is an over-estimate of the
    /// truth by an unknown amount — which is the unsafe direction. The honest
    /// margin would be *negative*, and a negative margin nobody sourced is
    /// exactly the invented number this module refuses to write.
    pub contact_area_measured: bool,
    /// **Always false.** [`Clamp`] cannot tell a fence from a toggle clamp:
    /// there is no `resists: lift | lateral`, so every finding below treats
    /// side pressure and downward pressure as the same restraint. The field
    /// exists in the catalogue (`web/src/workholding.ts`) and is consumed by
    /// nothing; carrying it through `ClampCfg` into `Clamp` is the prerequisite
    /// `docs/workholding-research.md` already identified.
    pub restraint_direction_modelled: bool,
    /// **Always false, and it is a defect in the PROGRAM's self-description,
    /// not in this check.** The post writes a diameter — `D6.00mm` — only for
    /// the FIRST tool; a `( TOOL CHANGE -> … )` names the cutter and not its
    /// width. So the kerf widths here come from the tool table the caller
    /// declared, matched by the name the program prints, and a name that does
    /// not resolve is PENDING rather than a guess.
    pub tool_widths_from_program: bool,
    /// The cell the connectivity actually ran at — never the one that was
    /// asked for.
    pub cell_mm: f64,
    /// How far the severed set is DILATED before any connectivity question,
    /// in mm. See [`check_hold_down`]: the error direction for restraint is the
    /// opposite of `sim::check`'s, so removal must be OVER-reported here.
    pub dilation_mm: f64,
    /// Checks that could not run on this job, each naming why **and what would
    /// let it run**. An unrunnable check that names its own remedy is the
    /// difference between a PENDING and a dead row.
    ///
    /// 🔴 Non-empty means the findings below are NOT an answer.
    pub pending: Vec<String>,
}

impl HoldDownBasis {
    fn new(cell_mm: f64, dilation_mm: f64) -> Self {
        Self {
            force_checked: false,
            contact_area_measured: false,
            restraint_direction_modelled: false,
            tool_widths_from_program: false,
            cell_mm,
            dilation_mm,
            pending: Vec::new(),
        }
    }

    /// The sentence that must ship with every result, including a clean one.
    ///
    /// 🔴 There is deliberately no way to render "no hold-down problem found".
    /// The true sentence is *"the geometry and the ordering were checked;
    /// HOLDING FORCE IS UNCHECKED"*, and both halves ship together or neither
    /// does. This is the `colony_health_band` shape — a constant rendered as a
    /// measurement — except that this one ends with a part thrown from a 2.2 kW
    /// spindle rather than a wrong dashboard.
    pub fn caveat(&self) -> String {
        "HOLDING FORCE IS UNCHECKED: this tool has no clamp preload, no friction coefficient, no \
         cutting-force model and no vibration model, and the held area is the DECLARED FOOTPRINT \
         rather than a measured bearing pad. It also cannot tell a fence from a toggle clamp \
         (nothing carries `resists: lift|lateral`), so nothing below distinguishes restraint \
         against LIFT from restraint against SLIDING. What was checked is geometry and program \
         order, and only that."
            .to_string()
    }
}

/// Whether a finding stops the program or describes it.
///
/// 🔴 Split deliberately. **A check that goes red on every real job gets muted
/// within a week** — a pressure bar spanning a workpiece legitimately loses contact
/// area over a cut-out and still holds, and a tab-free drop-out at the end of a
/// program is a real thing to do. There is no sourced threshold at which
/// "partial" becomes fatal, so those are reported with their numbers and are
/// not graded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldDownSeverity {
    /// The program must not run. Machining material nothing holds.
    Refusal,
    /// Reported with its numbers so an operator can decide. Not graded.
    Note,
}

/// What the restraint pass found.
///
/// Every variant names the PART or region, the MOMENT in the program, and what
/// would fix it — a finding an operator standing at a machine cannot act on is
/// not a finding.
#[derive(Clone, Debug, PartialEq)]
pub enum HoldDownFinding {
    /// 🔴 A cutting move enters material that nothing is holding. **Refusal.**
    UnrestrainedMaterialMachined {
        /// Where the cutter is, in machine coordinates — somewhere to go and look.
        x: f64,
        y: f64,
        /// Operation index (1-based) and name, plus how many operations there are.
        at: String,
        /// The declared clamps that were still bearing on material at that
        /// moment, and are holding a DIFFERENT piece. Empty means every clamp
        /// had already lost the work — a different fix, so a different sentence.
        clamps_elsewhere: Vec<String>,
        /// Area of the piece being cut, mm^2 — a 4mm^2 crumb and a 200x120
        /// blank are the same refusal and very different objects.
        piece_area_mm2: f64,
    },
    /// A piece of the workpiece is separated and carries no clamp while the program
    /// keeps running. **Note** — a tab-free drop-out is a legitimate thing to
    /// do, so this reports and does not grade.
    PieceFreeWhileProgramContinues {
        area_mm2: f64,
        /// `[x0, y0, x1, y1]` in machine coordinates.
        bbox: [f64; 4],
        /// The operation during which it lost its last connection to restrained
        /// material, or `None` when it never had any.
        freed_at: Option<String>,
        ops_remaining: usize,
        cutting_moves_remaining: usize,
        /// How many rapids pass over it after it is free. A part that lifts into
        /// a crossing gantry is the reason this number is counted at all.
        rapids_over: usize,
    },
    /// A clamp's whole bearing area is cut away by the program. **Refusal** —
    /// after that operation the declared restraint is a fiction, while the
    /// setup workpiece, the picture and the keepout check all still show a clamp
    /// holding the work.
    /// 🔴 A REPORT THAT WAS CUT SHORT SAYS SO, IN THE FINDINGS.
    ///
    /// Three checks in this module cap how many instances they list. Until
    /// 2026-09-07 they capped silently, so a reader fixed the listed ones,
    /// re-ran, and met the next batch — never learning the true count. The
    /// worst was `UnrestrainedMaterialMachined`, which is a REFUSAL and is
    /// ADDITIVE: this lane's own fixture produces 354 of them and listed 3.
    ///
    /// ⚠ This is a FINDING and not a `basis.pending` entry, and the difference
    /// is load-bearing: `pending` means *the check could not run*, which makes
    /// `ran()` false and reads as "nothing was assessed". Everything WAS
    /// assessed; the LISTING was truncated. Different claims, different actions.
    FindingsTruncated { kind: &'static str, listed: usize, total: usize },
    ClampContactLost { clamp: String, at: String },
    /// A clamp keeps some bearing area and loses the rest. **Note**, and not
    /// graded: there is no sourced fraction at which partial becomes fatal.
    ClampContactReduced { clamp: String, at: String, fraction_remaining: f64 },
    /// A declared clamp bears on no workpiece cell at all — it is somewhere else on
    /// the machine, or the workpiece has been dragged out from under it. **Note**, but
    /// the loud kind: a clamp that holds nothing is indistinguishable from a
    /// clamp that holds, in every other view this tool offers.
    ClampBearsOnNoSheet { clamp: String },
    /// Every clamp bears along one line. **Note.** The workpiece is unrestrained
    /// against rotation about that line, and an operator can act on this in ten
    /// seconds.
    ClampContactsCollinear { axis: String, span_mm: f64 },
    /// A standing piece's area centroid lies outside the polygon of clamp
    /// contacts. **Note.**
    ///
    /// 🔴 This is a GEOMETRIC statement and not a stability calculation. It
    /// assumes nothing about cutting force, friction or vibration, and a job can
    /// satisfy it and still throw a part. The clause travels in
    /// [`HoldDownFinding::describe`] because it is exactly the sentence a reader
    /// would otherwise promote to a verdict.
    RegionCentroidOutsideClampHull { area_mm2: f64, cx: f64, cy: f64 },
    /// How much of each workpiece edge lies under a clamp footprint. **Note**, and
    /// printed on every job that gets this far, because "all four edges" and
    /// "one edge" are the difference between a workpiece that pivots and one that
    /// does not.
    EdgeRestraintSpan { edge: &'static str, covered_mm: f64, total_mm: f64 },
}

impl HoldDownFinding {
    pub fn severity(&self) -> HoldDownSeverity {
        match self {
            HoldDownFinding::UnrestrainedMaterialMachined { .. }
            | HoldDownFinding::ClampContactLost { .. } => HoldDownSeverity::Refusal,
            _ => HoldDownSeverity::Note,
        }
    }

    /// One line, naming the thing, the moment, and the fix.
    pub fn describe(&self) -> String {
        match self {
            HoldDownFinding::FindingsTruncated { kind, listed, total } => format!(
                "{total} {kind} were found and only {listed} are listed here. The remaining {} are \
                 NOT listed — clearing the listed ones does not clear them, and this count is the \
                 only place the difference appears.",
                total - listed
            ),
            HoldDownFinding::UnrestrainedMaterialMachined {
                x,
                y,
                at,
                clamps_elsewhere,
                piece_area_mm2,
            } => {
                let held = if clamps_elsewhere.is_empty() {
                    "no declared clamp is bearing on any standing material at that moment"
                        .to_string()
                } else {
                    format!(
                        "the declared clamp(s) {} are still bearing, but on a DIFFERENT piece",
                        clamps_elsewhere.join(", ")
                    )
                };
                format!(
                    "NOTHING IS HOLDING THE MATERIAL BEING CUT: at {at} the cutter enters a piece \
                     of {piece_area_mm2:.0}mm^2 at ({x:.1}, {y:.1}) that is no longer joined to \
                     anything a clamp bears on — {held}. Fix by holding that piece (a clamp on it, \
                     or tabs left on the cut that frees it) or by cutting it LAST; an unrestrained \
                     offcut in a spinning cutter lifts, climbs the tool and is thrown."
                )
            }
            HoldDownFinding::PieceFreeWhileProgramContinues {
                area_mm2,
                bbox,
                freed_at,
                ops_remaining,
                cutting_moves_remaining,
                rapids_over,
            } => {
                let when = match freed_at {
                    Some(a) => format!("is free after {a}"),
                    None => "carries no restraint at any point in this program".to_string(),
                };
                format!(
                    "a piece of {area_mm2:.0}mm^2 ({:.1},{:.1} to {:.1},{:.1}) {when}, and the \
                     program then runs for {ops_remaining} more operation(s) and \
                     {cutting_moves_remaining} more cutting move(s), with {rapids_over} rapid(s) \
                     passing over it. This is not graded: a tab-free drop-out is a real thing to \
                     do. If it is not deliberate, hold it or leave tabs on the cut that frees it.",
                    bbox[0], bbox[1], bbox[2], bbox[3]
                )
            }
            HoldDownFinding::ClampContactLost { clamp, at } => format!(
                "CLAMP `{clamp}` HOLDS NOTHING FROM {at} ONWARD: the program cuts away every cell \
                 of workpiece it bears on, so from that operation the declared restraint is a fiction \
                 while the setup workpiece, the viewport and the keepout check all still show a clamp \
                 holding the work. Move the clamp off the material this program removes, or cut \
                 that material last."
            ),
            HoldDownFinding::ClampContactReduced { clamp, at, fraction_remaining } => format!(
                "clamp `{clamp}` keeps {:.0}% of its bearing area from {at} onward. Not graded — \
                 a pressure bar spanning a workpiece legitimately loses area over a cut-out and still \
                 holds, and there is no sourced fraction at which partial becomes fatal.",
                fraction_remaining * 100.0
            ),
            HoldDownFinding::ClampBearsOnNoSheet { clamp } => format!(
                "clamp `{clamp}` bears on NO part of the workpiece — it is elsewhere on the machine, or \
                 the workpiece has been dragged out from under it. It contributes no restraint to \
                 this job, and every other view in this tool draws it exactly like one that does."
            ),
            HoldDownFinding::ClampContactsCollinear { axis, span_mm } => format!(
                "every clamp bears along ONE line, {span_mm:.0}mm of it, running {axis}. The workpiece \
                 is unrestrained against rotation about that line. Add restraint on the other side."
            ),
            HoldDownFinding::RegionCentroidOutsideClampHull { area_mm2, cx, cy } => format!(
                "the area centroid of a {area_mm2:.0}mm^2 standing piece is at ({cx:.1}, {cy:.1}), \
                 OUTSIDE the polygon of clamp contacts. ⚠ This is a GEOMETRIC statement, not a \
                 stability calculation: it assumes nothing about cutting force, friction or \
                 vibration, and a job can satisfy it and still throw a part."
            ),
            HoldDownFinding::EdgeRestraintSpan { edge, covered_mm, total_mm } => format!(
                "workpiece edge {edge}: {covered_mm:.0}mm of {total_mm:.0}mm lies under a clamp footprint"
            ),
        }
    }
}

/// The answer, and everything that qualifies it.
#[derive(Clone, Debug, PartialEq)]
pub struct HoldDownReport {
    pub basis: HoldDownBasis,
    pub findings: Vec<HoldDownFinding>,
}

impl HoldDownReport {
    /// Findings that must stop the program. Empty on a job whose checks could
    /// not run — read [`HoldDownBasis::pending`] before reading this as clean.
    pub fn refusals(&self) -> Vec<&HoldDownFinding> {
        self.findings.iter().filter(|f| f.severity() == HoldDownSeverity::Refusal).collect()
    }

    pub fn notes(&self) -> Vec<&HoldDownFinding> {
        self.findings.iter().filter(|f| f.severity() == HoldDownSeverity::Note).collect()
    }

    /// Did the geometry and ordering checks actually run?
    pub fn ran(&self) -> bool {
        self.basis.pending.is_empty()
    }

    /// Every line a host should show, caveat first.
    ///
    /// 🔴 The caveat is index 0 on a clean job as much as on a dirty one, and
    /// a PENDING is rendered as a PENDING rather than as silence.
    pub fn lines(&self) -> Vec<String> {
        let mut out = vec![format!("hold-down: {}", self.basis.caveat())];
        for p in &self.basis.pending {
            out.push(format!("hold-down PENDING (this is NOT a pass): {p}"));
        }
        // ⚠ The four edge spans are collapsed into ONE line, deliberately.
        // They are kept as four separate FINDINGS because a host wants the
        // numbers per edge — but four notes on every job that declares a clamp
        // is the kind of noise that gets a whole family scrolled past, and this
        // one is not worth four lines of somebody's attention.
        let mut edges: Vec<String> = Vec::new();
        for f in &self.findings {
            match f {
                HoldDownFinding::EdgeRestraintSpan { edge, covered_mm, total_mm } => {
                    edges.push(format!("{edge} {covered_mm:.0}/{total_mm:.0}mm"))
                }
                _ => out.push(format!("hold-down: {}", f.describe())),
            }
        }
        if !edges.is_empty() {
            out.push(format!(
                "hold-down: workpiece edge under a clamp footprint — {}. All four at 0 means nothing \
                 bears on an edge at all.",
                edges.join(", ")
            ));
        }
        out
    }
}

// ---------------------------------------------------------------------------
//  Reading the emitted program back
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProgKind {
    Rapid,
    Feed,
    Arc { cw: bool },
    Drill,
}

impl ProgKind {
    fn cuts(self) -> bool {
        !matches!(self, ProgKind::Rapid)
    }
}

#[derive(Clone, Debug)]
struct ProgMove {
    kind: ProgKind,
    /// Index into `ProgramRead::sections`.
    section: usize,
    from: (f64, f64, f64),
    to: (f64, f64, f64),
    /// Arc centre, machine coordinates. Meaningless unless `kind` is an arc.
    centre: (f64, f64),
    tool_r: f64,
}

#[derive(Clone, Debug)]
struct ProgSection {
    name: String,
}

struct ProgramRead {
    sections: Vec<ProgSection>,
    moves: Vec<ProgMove>,
    /// Constructs this reader does not model. **Fatal** — an unmodelled motion
    /// UNDER-reports removal, material then reads as standing, restraint reads
    /// as present, and the failure is MISSED. That is the unsafe direction, so
    /// it suppresses the answer rather than shrinking it.
    unread: Vec<String>,
    /// Tool names the program prints that the caller's tool table does not
    /// carry. Fatal for the same reason: an unknown kerf width is an unknown
    /// severance.
    unresolved_tools: Vec<String>,
    smallest_tool_r: f64,
}

impl ProgramRead {
    /* 🔴 THE ONE PLACE THE "NAME IT ONCE" RULE LIVES, BECAUSE IT WAS TYPED IN
     * SEVEN PLACES AND ONLY ONE OF THEM HELD IT.
     *
     * A construct this reader cannot model is reported ONCE, WITHOUT the block
     * it was found in, and no more than `UNREAD_CAP` distinct findings are kept:
     *
     *   - WITHOUT THE BLOCK, because a message carrying `{raw}` is unique per
     *     line, so the `sort(); dedup()` at the end of `read_program` — whose
     *     own comment is about "a wall of text nobody reads" — cannot collapse
     *     it. Every entry becomes a `basis.pending` an operator reads, and a
     *     program with 500 unmodelled blocks produced 500 of them. That is a
     *     control an operator learns to scroll past. The first occurrence is
     *     representative; the rest are the same finding.
     *   - CAPPED, matching `job.rs`'s `name_unread`, which caps at 8 for the
     *     same reason. Capping is safe here in a way it would not be for a
     *     count: `unread` is FATAL and NOT additive — a single entry already
     *     suppresses the answer (see the field's doc), so a 9th DISTINCT kind
     *     cannot change any decision this reader feeds. It can only lengthen a
     *     list that is already saying "do not trust this".
     *
     * What is NOT dropped is what a reader acts on: WHICH construct, and for a
     * `G` code the code NUMBER — that is the word that says which feature is
     * missing. Three unmodelled kinds stay three distinguishable messages.
     *
     * Route every `unread` finding through here. A `push` straight at the field
     * is the defect this exists to stop, and it also silently disarms the cap
     * for the callers that DO use it, by filling the eight slots first. */
    fn name_unread(&mut self, what: String) {
        if self.unread.len() < UNREAD_CAP && !self.unread.contains(&what) {
            self.unread.push(what);
        }
    }
}

/// How many DISTINCT unmodelled constructs `read_program` will name. The same
/// number `job.rs` uses, and for the same reason — see [`ProgramRead::name_unread`].
const UNREAD_CAP: usize = 8;

/// Split a G-code block into `(letter, value)` words.
///
/// ⚠ A THIRD reader of this dialect would be one too many, so this one is
/// deliberately tiny and refuses rather than interprets: it understands the
/// words this post writes and names everything else (see
/// [`ProgramRead::unread`]).
fn hd_words(line: &str) -> Vec<(char, f64)> {
    /* 🔴 `feeds::word_value_at`, THE SAME SCANNER THE OTHER TWO READERS USE.
     *
     * This function re-authored the scan by hand on 2026-08-28 — in the commit
     * whose stated purpose was closing the drift between the readers — and the
     * copy accepted a sign ANYWHERE in the run rather than only as the first
     * character. `G1 X10-20` therefore gave `X = 10` in `job::block_words` and
     * `X = NaN` here: one program, two answers, from a rule typed twice. That is
     * the third time a re-typed rule has produced a divergence in this lane, and
     * it is why the rule is now in one place and called from three.
     *
     * A letter with nothing numeric after it is still pushed as NaN so the
     * caller can NAME it — this reader used to DROP such a word, which made a
     * block it could not read look like a block with fewer words. */
    let up = line.to_ascii_uppercase();
    let b = up.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i] as char;
        if c.is_ascii_alphabetic() {
            match crate::feeds::word_value_at(b, i + 1) {
                Some((v, j)) => {
                    out.push((c, v));
                    i = j.max(i + 1);
                }
                None => {
                    out.push((c, f64::NAN));
                    i += 1;
                }
            }
        } else {
            i += 1;
        }
    }
    out
}

/// `G38.2` -> 382, `G1` -> 10. The same tenths encoding `job.rs` uses, so the
/// two readers at least agree about what a code IS.
fn hd_code(v: f64) -> i64 {
    (v * 10.0).round() as i64
}

fn read_program(gcode: &str, tools: &[(String, f64)]) -> ProgramRead {
    let mut r = ProgramRead {
        sections: Vec::new(),
        moves: Vec::new(),
        unread: Vec::new(),
        unresolved_tools: Vec::new(),
        smallest_tool_r: f64::INFINITY,
    };

    // The tool the spindle is holding, by the NAME the program prints. `None`
    // until something says — never "the usual one", for the reason
    // `toolpath::MoveOrigin` gives: on a multi-tool program the first tool is
    // the wrong answer for every move after the first change, plausibly.
    let mut tool_name: Option<String> = None;
    let mut section: Option<usize> = None;
    let mut absolute = true;
    let (mut x, mut y, mut z): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
    let mut motion: Option<i64> = None;
    let mut unresolved: Vec<String> = Vec::new();

    let radius_of = |name: &Option<String>| -> Option<f64> {
        let n = name.as_ref()?;
        tools.iter().find(|(t, _)| t == n).map(|(_, rr)| *rr)
    };

    for raw in gcode.lines() {
        // ---- comments: banners, tool changes -------------------------------
        let code_part = match raw.find('(') {
            Some(o) => {
                let close = raw[o..].find(')').map(|c| o + c);
                let inner = match close {
                    Some(c) => raw[o + 1..c].trim().to_string(),
                    None => raw[o + 1..].trim().to_string(),
                };
                // 🔴 Through `toolpath::parse_banner`, the format's ONE reader —
                // not a regex here. A `format!` at the writer and a regex at
                // each consumer is the same string described in four places,
                // and the first rename unhooks the consumers silently.
                if let Some((name, tool)) = crate::toolpath::parse_banner(&inner) {
                    r.sections.push(ProgSection { name: name.to_string() });
                    section = Some(r.sections.len() - 1);
                    if !tool.is_empty() {
                        tool_name = Some(tool.to_string());
                    }
                } else if let Some(rest) = inner.strip_prefix("TOOL CHANGE -> ") {
                    // ⚠ Names the cutter and NOT its width — see
                    // `HoldDownBasis::tool_widths_from_program`.
                    tool_name = Some(rest.trim().to_string());
                    section = None;
                } else if let Some(rest) = inner.strip_prefix("tool: ") {
                    // The opening banner: `<name> D6.00mm F2`. The name is
                    // everything before the ` D<..>mm` suffix. The DIAMETER
                    // here is rounded to 2dp by the post and is therefore NOT
                    // used as the kerf — the tool table is.
                    let n = match rest.rfind(" D") {
                        Some(i) => rest[..i].trim(),
                        None => rest.trim(),
                    };
                    if !n.is_empty() {
                        tool_name = Some(n.to_string());
                    }
                } else if inner.contains("corner relief") {
                    r.sections.push(ProgSection { name: inner.clone() });
                    section = Some(r.sections.len() - 1);
                }
                /* 🔴 THE CODE HALF IS `feeds::strip_comments`, NOT THIS
                 * SPLICE (TODO #143, fixed 2026-08-28). The comment half above
                 * still reads `inner`, because this reader PARSES the banner —
                 * that is why the scan was hand-written, and it is not a reason
                 * to hand-write the other half too.
                 *
                 * What the splice did: it removed the FIRST `( … )` and nothing
                 * else, did not count depth, and did not know `;` at all. So
                 * `( a ( b ) c )` left `c )` standing as CODE, and
                 * `G1 X10 ; Z-5` was scanned with the comment text as words —
                 * in the reader whose answer decides whether a part is reported
                 * HELD. `RunTab::words` was corrected for the identical input
                 * hours earlier; this was the FIFTH copy of a rule the census
                 * two files away claimed lived in one place. */
                let _ = close;
                crate::feeds::strip_comments(raw)
            }
            None => crate::feeds::strip_comments(raw),
        };
        if code_part.trim().is_empty() {
            continue;
        }

        let words = hd_words(&code_part);
        /* 🔴 A WORD THIS READER COULD NOT PARSE IS NAMED, NEVER COMPUTED WITH.
         * `hd_words` used to DROP such a word, so a block it could not read
         * looked like a block with fewer words — dx=dy=0, no removal, and
         * nothing in `unread` for the suppression path to act on. It now pushes
         * NaN, and this is where that becomes a finding instead of arithmetic:
         * NaN propagates silently through every distance and comparison below,
         * which is the same silence one layer down. */
        /* The LETTER is kept because it is what a reader acts on; the line is
         * dropped, and the finding capped, by `name_unread` — read its comment
         * before adding a caller. */
        for (c, v) in &words {
            if !v.is_finite() {
                r.name_unread(format!("a `{c}` word whose value this reader could not parse"));
            }
        }
        let get = |l: char| words.iter().rev().find(|(c, _)| *c == l).map(|(_, v)| *v);
        /* 🔴 `hd_code` CASTS f64 -> i64, AND THAT MAPS NaN TO 0. An unparsable
         * `G` word would therefore match the G0 arm and be modelled as a RAPID.
         * Filtered here rather than trusted below; `unread` already carries it. */
        let gs: Vec<i64> = words
            .iter()
            .filter(|(c, v)| *c == 'G' && v.is_finite())
            .map(|(_, v)| hd_code(*v))
            .collect();

        // ---- modes, before any motion in the same block --------------------
        let mut motion_this_block: Option<i64> = None;
        for g in &gs {
            match g {
                // Settings that cannot move an axis and cannot change what a
                // word MEANS. 🔴 The list is short on purpose: an ignore list is
                // where a reader goes blind, and four codes that LOOK harmless
                // are deliberately NOT here —
                //   G18/G19 put arcs in a different plane, so an `I`/`J` would
                //     mean something else and a bulge would be mapped as a chord;
                //   G43 (tool length offset) shifts every following Z;
                //   G53 makes the next block machine coordinates, so an X/Y
                //     would land somewhere else on the machine.
                // None is emitted by this post. If one ever is, it must be a
                // PENDING rather than a silently wrong map.
                170 | 210 | 400 | 490 | 540 | 550 | 560 | 570 | 580 | 590 | 610 | 640 | 940
                | 980 | 990 | 40 => {}
                900 => absolute = true,
                910 => absolute = false,
                200 => r.name_unread(
                    "the program declares G20 (inches) — every coordinate below would mean \
                     something else and this reader works in millimetres"
                        .into(),
                ),
                800 => motion = None,
                100 => {
                    // `G10 L20 P1 Z<v>` re-datums Z at the current position:
                    // after it the machine IS at Z = v in the new offset.
                    // Mixing that up would put every following depth in the
                    // wrong frame — which is the mixed-datum error
                    // `clearance_z` already names.
                    if get('L').map(hd_code) == Some(200) {
                        if let Some(v) = get('Z') {
                            z = Some(v);
                        }
                        if get('X').is_some() || get('Y').is_some() {
                            r.name_unread(
                                "G10 L20 sets an X or Y work offset; this reader only follows the \
                                 Z datum, so every following coordinate would be in an unknown \
                                 frame"
                                    .into(),
                            );
                        }
                    } else {
                        r.name_unread("G10 in a form this reader does not model".into());
                    }
                }
                382 | 383 | 384 | 385 => {
                    // A probe stops on CONTACT, so where it ends is unknown.
                    // Saying "it went where it was told" would put a phantom
                    // depth in the map.
                    z = None;
                    if section.is_some() {
                        r.name_unread(
                            "a probe runs INSIDE an operation, so the tool's height during that \
                             operation is not known from the text"
                                .into(),
                        );
                    }
                }
                0 | 10 | 20 | 30 | 810 | 820 | 830 => motion_this_block = Some(*g),
                other => r.name_unread(format!(
                    "G{} is a code this reader does not model",
                    *other as f64 / 10.0
                )),
            }
        }
        if let Some(m) = motion_this_block {
            motion = Some(m);
        }
        let has_axis = get('X').is_some() || get('Y').is_some() || get('Z').is_some();
        let Some(mode) = motion else {
            continue;
        };
        if !has_axis && motion_this_block.is_none() {
            continue;
        }
        if matches!(mode, 0 | 10 | 20 | 30) && !has_axis {
            continue;
        }

        let from = (x, y, z);
        let axis = |cur: Option<f64>, w: Option<f64>| -> Option<f64> {
            match (w, cur) {
                (None, c) => c,
                (Some(v), _) if absolute => Some(v),
                (Some(v), Some(c)) => Some(c + v),
                (Some(_), None) => None,
            }
        };
        let nx = axis(x, get('X'));
        let ny = axis(y, get('Y'));

        let tool_r = match radius_of(&tool_name) {
            Some(v) => v,
            None => {
                if let Some(n) = &tool_name {
                    if !unresolved.iter().any(|u| u == n) {
                        unresolved.push(n.clone());
                    }
                } else if !unresolved.iter().any(|u| u == "(no tool named in the program)") {
                    unresolved.push("(no tool named in the program)".into());
                }
                0.0
            }
        };

        match mode {
            810 | 820 | 830 => {
                // A canned cycle bores at (X, Y) to Z and RETRACTS to the plane
                // it started from, so the modal Z afterwards is the entry
                // height and not the hole's depth. Carrying the depth forward
                // would make every following move look like it runs 18mm below
                // the workpiece top.
                let hz = get('Z');
                if let (Some(px), Some(py), Some(hz)) = (nx, ny, hz) {
                    if let Some(sec) = section {
                        r.moves.push(ProgMove {
                            kind: ProgKind::Drill,
                            section: sec,
                            from: (px, py, z.unwrap_or(hz)),
                            to: (px, py, hz),
                            centre: (0.0, 0.0),
                            tool_r,
                        });
                        if tool_r > 0.0 {
                            r.smallest_tool_r = r.smallest_tool_r.min(tool_r);
                        }
                    }
                }
                x = nx;
                y = ny;
            }
            0 | 10 => {
                let nz = axis(z, get('Z'));
                if let (Some(ax), Some(ay), Some(az), Some(bx), Some(by), Some(bz)) =
                    (from.0, from.1, from.2, nx, ny, nz)
                {
                    if let Some(sec) = section {
                        let kind = if mode == 0 { ProgKind::Rapid } else { ProgKind::Feed };
                        r.moves.push(ProgMove {
                            kind,
                            section: sec,
                            from: (ax, ay, az),
                            to: (bx, by, bz),
                            centre: (0.0, 0.0),
                            tool_r,
                        });
                        if mode == 10 && tool_r > 0.0 {
                            r.smallest_tool_r = r.smallest_tool_r.min(tool_r);
                        }
                    }
                }
                x = nx;
                y = ny;
                z = nz;
            }
            20 | 30 => {
                let nz = axis(z, get('Z'));
                let (i, j) = (get('I'), get('J'));
                if i.is_none() && j.is_none() {
                    r.name_unread(
                        "an arc given by R rather than I/J, which this reader does not model"
                            .into(),
                    );
                } else if let (Some(ax), Some(ay), Some(az), Some(bx), Some(by), Some(bz)) =
                    (from.0, from.1, from.2, nx, ny, nz)
                {
                    if let Some(sec) = section {
                        r.moves.push(ProgMove {
                            kind: ProgKind::Arc { cw: mode == 20 },
                            section: sec,
                            from: (ax, ay, az),
                            to: (bx, by, bz),
                            centre: (ax + i.unwrap_or(0.0), ay + j.unwrap_or(0.0)),
                            tool_r,
                        });
                        if tool_r > 0.0 {
                            r.smallest_tool_r = r.smallest_tool_r.min(tool_r);
                        }
                    }
                }
                x = nx;
                y = ny;
                z = nz;
            }
            _ => {}
        }
    }

    r.unresolved_tools = unresolved;
    if !r.smallest_tool_r.is_finite() {
        r.smallest_tool_r = 0.0;
    }
    // The same construct reported once per occurrence is a wall of text nobody
    // reads; the fact is "this program contains one".
    r.unread.sort();
    r.unread.dedup();
    r
}

// ---------------------------------------------------------------------------
//  Where the material is, and WHEN it stopped being there
// ---------------------------------------------------------------------------

const HD_NEVER: u32 = u32::MAX;
/// A ceiling on the grid, so a big workpiece at a fine cell cannot turn a re-plan
/// into a stall. Exceeding it COARSENS the cell, and the coarser cell is what
/// the kerf-resolution rule is then judged against — so the cost of the ceiling
/// shows up as a PENDING rather than as a quietly worse answer.
const HD_MAX_CELLS: usize = 1_500_000;

struct Severance {
    cols: usize,
    rows: usize,
    cell: f64,
    ox: f64,
    oy: f64,
    /// Move index at which this cell FIRST reached through-depth. `HD_NEVER` =
    /// still standing at the end of the program.
    severed_at: Vec<u32>,
    in_sheet: Vec<bool>,
}

impl Severance {
    fn idx(&self, c: usize, rr: usize) -> usize {
        rr * self.cols + c
    }
    fn world(&self, c: usize, rr: usize) -> (f64, f64) {
        (self.ox + (c as f64 + 0.5) * self.cell, self.oy + (rr as f64 + 0.5) * self.cell)
    }
    /// Every in-workpiece cell whose centre is within `r` of `(x, y)`.
    fn disc(&self, x: f64, y: f64, r: f64, out: &mut Vec<usize>) {
        if !(r > 0.0) || !x.is_finite() || !y.is_finite() {
            return;
        }
        let c0 = (((x - r - self.ox) / self.cell).floor()).max(0.0) as usize;
        let r0 = (((y - r - self.oy) / self.cell).floor()).max(0.0) as usize;
        let c1 = ((((x + r - self.ox) / self.cell).ceil()) as usize).min(self.cols.saturating_sub(1));
        let r1 = ((((y + r - self.oy) / self.cell).ceil()) as usize).min(self.rows.saturating_sub(1));
        if c0 >= self.cols || r0 >= self.rows {
            return;
        }
        let rr2 = r * r;
        for j in r0..=r1 {
            for i in c0..=c1 {
                let k = self.idx(i, j);
                if !self.in_sheet[k] {
                    continue;
                }
                let (wx, wy) = self.world(i, j);
                if (wx - x).powi(2) + (wy - y).powi(2) <= rr2 {
                    out.push(k);
                }
            }
        }
    }
}

/// Points along a move, `step` apart — the shape `sim::simulate` uses, so the
/// two agree about what "walking a move" means.
fn hd_points(m: &ProgMove, step: f64, out: &mut Vec<(f64, f64, f64)>) {
    out.clear();
    match m.kind {
        ProgKind::Drill => out.push(m.to),
        ProgKind::Arc { cw } => {
            let (cx, cy) = m.centre;
            let r = ((m.from.0 - cx).powi(2) + (m.from.1 - cy).powi(2)).sqrt();
            let a0 = (m.from.1 - cy).atan2(m.from.0 - cx);
            let a1 = (m.to.1 - cy).atan2(m.to.0 - cx);
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
            let n = (((r * sweep).abs() / step).ceil() as usize).max(1).min(20_000);
            out.push(m.from);
            for i in 1..=n {
                let t = i as f64 / n as f64;
                let a = a0 + sweep * t;
                out.push((
                    cx + r * a.cos(),
                    cy + r * a.sin(),
                    m.from.2 + (m.to.2 - m.from.2) * t,
                ));
            }
        }
        _ => {
            let d = ((m.to.0 - m.from.0).powi(2) + (m.to.1 - m.from.1).powi(2)).sqrt();
            let n = ((d / step).ceil() as usize).max(1).min(20_000);
            for i in 0..=n {
                let t = i as f64 / n as f64;
                out.push((
                    m.from.0 + (m.to.0 - m.from.0) * t,
                    m.from.1 + (m.to.1 - m.from.1) * t,
                    m.from.2 + (m.to.2 - m.from.2) * t,
                ));
            }
        }
    }
}

/// Disjoint set over cells, carrying how many LIVE clamp-contact cells each
/// component holds. The counter is what makes "is this piece held?" an O(1)
/// question during the reverse walk.
struct Dsu {
    parent: Vec<u32>,
    size: Vec<u32>,
    clamped: Vec<u32>,
}

impl Dsu {
    fn new(n: usize) -> Self {
        Self { parent: vec![0; n], size: vec![0; n], clamped: vec![0; n] }
    }
    fn find(&mut self, a: usize) -> usize {
        let mut x = a;
        while self.parent[x] as usize != x {
            let p = self.parent[x] as usize;
            self.parent[x] = self.parent[p];
            x = self.parent[x] as usize;
        }
        x
    }
    fn union(&mut self, a: usize, b: usize) {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        if self.size[ra] < self.size[rb] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb] = ra as u32;
        self.size[ra] += self.size[rb];
        self.clamped[ra] += self.clamped[rb];
    }
}

/// Is `p` inside the convex quadrilateral `q`? The placed workpiece is convex at
/// every angle, so one sign test per edge answers it exactly — no sampling.
fn in_quad(q: &[(f64, f64); 4], p: (f64, f64)) -> bool {
    let mut neg = false;
    let mut pos = false;
    for i in 0..4 {
        let a = q[i];
        let b = q[(i + 1) % 4];
        let cross = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
        if cross < -1e-12 {
            neg = true;
        }
        if cross > 1e-12 {
            pos = true;
        }
    }
    !(neg && pos)
}

/// Convex hull, monotone chain. Used for the clamp support polygon; **built
/// from [`Clamp::corners`] and never from bounding boxes**, because a bbox
/// OVERSTATES the hull — a support polygon larger than the clamps provide is
/// the unsafe direction, and it is the same trap `fixture.rs` already plants a
/// test against for the keepout.
fn hull_of(mut pts: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
    };
    let mut lower: Vec<(f64, f64)> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<(f64, f64)> = Vec::new();
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

fn poly_area(p: &[(f64, f64)]) -> f64 {
    if p.len() < 3 {
        return 0.0;
    }
    let mut a = 0.0;
    for i in 0..p.len() {
        let q = p[(i + 1) % p.len()];
        a += p[i].0 * q.1 - q.0 * p[i].1;
    }
    (a * 0.5).abs()
}

fn in_poly(p: &[(f64, f64)], pt: (f64, f64)) -> bool {
    if p.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = p.len() - 1;
    for i in 0..p.len() {
        let (xi, yi) = p[i];
        let (xj, yj) = p[j];
        if (yi > pt.1) != (yj > pt.1)
            && pt.0 < (xj - xi) * (pt.1 - yi) / (yj - yi + f64::EPSILON) + xi
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// One standing piece of the workpiece at the end of the program.
struct HdPiece {
    /// A cell in it, kept because the DSU root moves as material is added back.
    rep: usize,
    root: u32,
    cells: usize,
    area_mm2: f64,
    bbox: [f64; 4],
    centroid: (f64, f64),
    clamped: bool,
    /// The move that severed its last connection to restrained material.
    /// `None` = it never had any.
    freed_at: Option<usize>,
}

/// Union a newly-standing cell with its standing 4-neighbours.
///
/// 🔴 **4-connectivity, not 8.** A diagonal cell contact is not a bridge of
/// material, and counting it as one reads as HELD.
fn hd_link(dsu: &mut Dsu, alive: &[bool], k: usize, cols: usize, n: usize) {
    let (i, j) = (k % cols, k / cols);
    if i + 1 < cols && alive[k + 1] {
        dsu.union(k, k + 1);
    }
    if i > 0 && alive[k - 1] {
        dsu.union(k, k - 1);
    }
    if k + cols < n && alive[k + cols] {
        dsu.union(k, k + cols);
    }
    if j > 0 && alive[k - cols] {
        dsu.union(k, k - cols);
    }
}

/// 🔴 **THE CHECK: does the declared work holding hold the work, at every
/// moment of the EMITTED program?**
///
/// * `gcode` — the program the post produced. Not the plan, not the settings.
/// * `tools` — `(name as the program prints it, radius mm)`. The kerf widths;
///   see [`HoldDownBasis::tool_widths_from_program`] for why they cannot be
///   read out of the text.
/// * `cell_mm` — resolution of the connectivity grid.
///
/// # The error direction is the OPPOSITE of `sim::check`'s, and that decides
/// the whole design
///
/// | error | `Gouge` | `Uncut` | **restraint** |
/// |---|---|---|---|
/// | over-report removal | false alarm — safe | island reads as cleared — MISSED | reads as LOST — **false alarm, safe** |
/// | under-report removal | gouge reads as untouched — MISSED | false alarm — safe | reads as PRESENT — **MISSED** |
///
/// [`crate::sim::simulate`] is an INNER approximation (it can miss removal in a
/// sliver bounded by [`crate::sim::edge_miss_mm`]) and `sim::check` SHRINKS its
/// regions by a cell. Both are right for their questions and both are the
/// unsafe direction for this one. So this pass keeps its own map and
/// **DILATES**: every stamp is taken at `tool radius + one cell`. The
/// consequence is stated rather than hidden — a surviving bridge narrower than
/// about two cells reads as severed, which is a FALSE RED. It is bounded, it is
/// printed in [`HoldDownBasis::dilation_mm`], and it errs toward refusing.
///
/// # Why a reverse walk and not a snapshot per operation
///
/// A part is usually released **inside** an operation, not at a boundary — the
/// last lap of a profile frees it a few moves before that operation ends — so
/// evaluating only at operation boundaries would miss precisely the moves that
/// matter. Removal is monotone ([`crate::sim::HeightMap::stamp`] never raises a
/// cell and neither does this), so walking the program BACKWARDS turns the
/// question into incremental union-find: material is only ever ADDED, each
/// component carries a count of the live clamp cells in it, and *"is the piece
/// I am cutting held, right now?"* is one `find` per move. Exact, per move, no
/// snapshots.
pub fn check_hold_down(
    gcode: &str,
    fixturing: &Fixturing,
    stock: &crate::types::Stock,
    tools: &[(String, f64)],
    cell_mm: f64,
) -> HoldDownReport {
    let quad = [
        stock.place(0.0, 0.0),
        stock.place(stock.size_x_mm, 0.0),
        stock.place(stock.size_x_mm, stock.size_y_mm),
        stock.place(0.0, stock.size_y_mm),
    ];
    let (mut x0, mut y0, mut x1, mut y1) =
        (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (px, py) in quad {
        x0 = x0.min(px);
        y0 = y0.min(py);
        x1 = x1.max(px);
        y1 = y1.max(py);
    }
    let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));

    let mut cell = cell_mm.max(0.1);
    let mut coarsened = false;
    while ((w / cell).ceil() as usize + 1) * ((h / cell).ceil() as usize + 1) > HD_MAX_CELLS {
        cell *= 1.5;
        coarsened = true;
    }
    let mut basis = HoldDownBasis::new(cell, cell);
    let mut findings: Vec<HoldDownFinding> = Vec::new();

    // ---- can any of this run at all? --------------------------------------
    //
    // 🔴 THE GUARD IS HERE, AT THE ENTRY POINT, and not inside each check.
    // Every algorithm below is trivially satisfied by an empty clamp list —
    // "no clamp stands on removed material" is TRUE when there are no clamps —
    // and that is the single most likely way this feature could ship a false
    // green.
    if fixturing.clamps.is_empty() {
        basis.pending.push(if fixturing.confirmed_clear {
            "NO WORK HOLDING IS DECLARED. The machine is marked confirmed-clear, which says the cutter \
             will not HIT anything; it says nothing about what HOLDS the workpiece. A vacuum table, \
             tape or dog-holes restrain with NO FOOTPRINT AT ALL and this model cannot represent \
             them, so restraint here is UNCHECKED — not clean. Declare the clamps to run this \
             check."
                .into()
        } else {
            "NO WORK HOLDING IS DECLARED, so nothing can be said about whether the work is held. \
             'Nothing declared' and 'checked and held' are different facts and only the second is \
             safe. Declare the clamps to run this check."
                .into()
        });
        return HoldDownReport { basis, findings };
    }

    let prog = read_program(gcode, tools);
    let cutting: Vec<usize> =
        (0..prog.moves.len()).filter(|i| prog.moves[*i].kind.cuts()).collect();

    if gcode.trim().is_empty() {
        basis.pending.push(
            "NO PROGRAM WAS EMITTED, so there is nothing to check restraint against. A refused job \
             produces no G-code by design; clear the refusals and re-plan."
                .into(),
        );
    } else if prog.sections.is_empty() || cutting.is_empty() {
        basis.pending.push(
            "the emitted program contains no operation section with a cutting move in it, so this \
             reader found no material being removed and cannot say when anything was released"
                .into(),
        );
    }
    for u in &prog.unread {
        basis.pending.push(format!(
            "the emitted program contains something this reader does not model, and unmodelled \
             motion makes material read as STILL STANDING — which reads as HELD, the unsafe \
             direction: {u}"
        ));
    }
    for t in &prog.unresolved_tools {
        basis.pending.push(format!(
            "the program runs a cutter named `{t}` that the declared tool table does not carry, so \
             its kerf width is unknown and the material it removes cannot be mapped. Declare that \
             tool, or make the names match."
        ));
    }
    // 🔴 A PENDING FOR A BOTTOM DATUM STOOD HERE AND IS DELETED IN THE SAME
    // CHANGE THAT TAUGHT `through_z` THE FRAME (below). Never before, and the
    // ordering is the safety property, not the tidiness.
    //
    // The old text was true when written: `Stock::z_zero_at_top` reached no code
    // in the planner or the post, so a setup declaring a bottom datum got a
    // top-datum program and this reader said so. That PENDING was also the only
    // thing standing between two states — because it returns before the
    // severance walk, it is what stopped this check from running its severance
    // test against a `through_z` that assumed the other frame and finding
    // NOTHING. Remove it while `through_z` is still `-thickness` and every job
    // under a bottom datum reports every part still held, with an empty findings
    // list, which is the same colour as "checked and clear".
    if !cutting.is_empty() && 2.0 * prog.smallest_tool_r < 3.0 * cell {
        basis.pending.push(format!(
            "CONNECTIVITY UNRESOLVED at this resolution: the narrowest kerf in this program is \
             {:.3}mm (a cutter of radius {:.3}mm) and the grid cell is {cell:.3}mm. Two pieces \
             separated by a cut that narrow can read as STILL JOINED, which reads as held. Re-run \
             at a cell of {:.2}mm or finer.{}",
            2.0 * prog.smallest_tool_r,
            prog.smallest_tool_r,
            (2.0 * prog.smallest_tool_r / 3.0).max(0.1),
            if coarsened {
                " (The requested cell was coarsened to keep the grid inside its cell ceiling.)"
            } else {
                ""
            }
        ));
    }

    // ---- the grid ---------------------------------------------------------
    let cols = (w / cell).ceil() as usize + 1;
    let rows = (h / cell).ceil() as usize + 1;
    let n = cols * rows;
    let mut sev = Severance {
        cols,
        rows,
        cell,
        ox: x0,
        oy: y0,
        severed_at: vec![HD_NEVER; n],
        in_sheet: vec![false; n],
    };
    for j in 0..rows {
        for i in 0..cols {
            let k = sev.idx(i, j);
            let p = sev.world(i, j);
            sev.in_sheet[k] = in_quad(&quad, p);
        }
    }

    // ---- clamp contact ----------------------------------------------------
    //
    // 🔴 MARGIN `0.0`, NEVER `tool_r`. [`Fixturing::check`] passes the cutter
    // radius because widening a keepout is conservative FOR AVOIDANCE. Widening
    // it here would OVERSTATE the held area, which is the unsafe direction —
    // and the honest margin would be NEGATIVE, because a toggle clamp bears on
    // a pad smaller than its outline and nobody publishes that pad. A negative
    // margin nobody sourced is exactly the invented number this module refuses
    // to write, so the assumption is declared in
    // [`HoldDownBasis::contact_area_measured`] and left visible instead.
    let mut contact_of: Vec<Vec<usize>> = Vec::with_capacity(fixturing.clamps.len());
    let mut is_contact = vec![false; n];
    for c in &fixturing.clamps {
        let mut cells = Vec::new();
        for j in 0..rows {
            for i in 0..cols {
                let k = sev.idx(i, j);
                if !sev.in_sheet[k] {
                    continue;
                }
                let (px, py) = sev.world(i, j);
                if c.contains(px, py, 0.0) {
                    cells.push(k);
                    is_contact[k] = true;
                }
            }
        }
        if cells.is_empty() {
            findings.push(HoldDownFinding::ClampBearsOnNoSheet { clamp: c.name.clone() });
        }
        contact_of.push(cells);
    }

    // ---- the clamps against the workpiece, which needs no program -------------
    //
    // 🔴 The support polygon is built from where each clamp BEARS ON THE WORKPIECE,
    // not from its footprint. `Clamp::corners()` is the right input for the
    // keepout and the wrong one here: a clamp overhanging the workpiece edge
    // contributes its whole outline to a hull while bearing on a sliver, which
    // OVERSTATES the support polygon — the unsafe direction, and the same
    // bounding-box-instead-of-clamp trap `fixture.rs` already plants a test
    // against for the keepout.
    //
    // ⚠ Eight extreme contact cells per clamp rather than every one of them:
    // a hull over 70,000 points on a full workpiece would ride on every re-plan.
    // Sampling extremes can only SHRINK the hull, never grow it, so the cost
    // of the shortcut is a slightly more suspicious answer rather than a
    // slightly more generous one.
    let mut hull_pts: Vec<(f64, f64)> = Vec::new();
    for cells in contact_of.iter() {
        if cells.is_empty() {
            continue;
        }
        for (ax, ay) in [
            (1.0, 0.0),
            (-1.0, 0.0),
            (0.0, 1.0),
            (0.0, -1.0),
            (1.0, 1.0),
            (1.0, -1.0),
            (-1.0, 1.0),
            (-1.0, -1.0),
        ] {
            let mut best = f64::NEG_INFINITY;
            let mut at = (0.0, 0.0);
            for &k in cells {
                let p = sev.world(k % cols, k / cols);
                let v = p.0 * ax + p.1 * ay;
                if v > best {
                    best = v;
                    at = p;
                }
            }
            hull_pts.push(at);
        }
    }
    let hull = hull_of(hull_pts.clone());
    if !hull_pts.is_empty() {
        let area = poly_area(&hull);
        let mut perim = 0.0;
        for i in 0..hull.len() {
            let a = hull[i];
            let b = hull[(i + 1) % hull.len()];
            perim += ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        }
        let mut span = 0.0;
        let (mut dx, mut dy) = (0.0, 0.0);
        for a in &hull_pts {
            for b in &hull_pts {
                let d = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
                if d > span {
                    span = d;
                    dx = (b.0 - a.0).abs();
                    dy = (b.1 - a.1).abs();
                }
            }
        }
        // 🔴 No percentage, no "clamps within 20% of an edge", no rule of thumb.
        // The moment a threshold appears it is an invented number wearing an
        // engineering face. This is a degeneracy test at the grid's own
        // resolution and nothing more.
        if hull.len() < 3 || area < perim * cell {
            findings.push(HoldDownFinding::ClampContactsCollinear {
                axis: if dx >= dy { "along X".into() } else { "along Y".into() },
                span_mm: span,
            });
        }
    }
    for (name, a, b) in [
        ("y-min", quad[0], quad[1]),
        ("x-max", quad[1], quad[2]),
        ("y-max", quad[2], quad[3]),
        ("x-min", quad[3], quad[0]),
    ] {
        let len = ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
        let steps = ((len / (cell * 0.5)).ceil() as usize).max(1);
        let mut covered = 0usize;
        for s in 0..steps {
            let t = (s as f64 + 0.5) / steps as f64;
            let p = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            if fixturing.clamps.iter().any(|c| c.contains(p.0, p.1, 0.0)) {
                covered += 1;
            }
        }
        findings.push(HoldDownFinding::EdgeRestraintSpan {
            edge: name,
            covered_mm: covered as f64 / steps as f64 * len,
            total_mm: len,
        });
    }

    if !basis.pending.is_empty() {
        // 🔴 The program-dependent half did NOT run. What ran — the clamps
        // against the workpiece — is reported; what did not is a PENDING, and never
        // an absence of findings.
        return HoldDownReport { basis, findings };
    }

    // ---- when did each cell go through? -----------------------------------
    //
    // 🔴 THE DATUM IS ASKED, NOT ASSUMED, AND THIS IS THE MOST DANGEROUS
    // NUMBER IN THE FILE.
    //
    // `prog.moves` are parsed out of the EMITTED G-code, so their Zs are in
    // whatever frame the operator declared — not in the plan's. This line read
    // `-stock.thickness_mm` until 2026-08-11, which is the workpiece underside
    // in the workpiece-top frame **and nothing at all in the other one**. Under
    // a spoilboard datum no emitted Z ever goes below `0`, so every cutting move
    // fails the test below, is skipped, and NO CELL IS EVER MARKED SEVERED: zero
    // components come loose, zero clamps lose their bearing area, and the report
    // returns with **no findings**.
    //
    // ⚠ **Empty is what PASS looks like here.** "No findings" and "checked and
    // clear" are the same colour to anyone not reading carefully, so the failure
    // is silent and it is in the direction that says a loose part is held —
    // under a 2.2 kW spindle. That is why `ZDatum::through_z_mm` exists, why its
    // doc block says the same thing, and why the test
    // `a_freed_part_is_still_reported_freed_when_z_is_zeroed_on_the_spoilboard`
    // asserts on NON-EMPTINESS with the old constant planted.
    let through_z = stock.z_datum.through_z_mm(stock) + 1e-6;
    let step = crate::sim::stamp_step_mm(cell);
    let mut pts: Vec<(f64, f64, f64)> = Vec::new();
    let mut hit: Vec<usize> = Vec::new();
    for (mi, m) in prog.moves.iter().enumerate() {
        if !m.kind.cuts() || (m.from.2 > through_z && m.to.2 > through_z) {
            continue;
        }
        hd_points(m, step, &mut pts);
        for p in &pts {
            if p.2 > through_z {
                continue;
            }
            hit.clear();
            // The DILATION, applied at the one place material is recorded as
            // gone — not as a second pass over the map, which would be a second
            // place for the stated bound to stop being true.
            sev.disc(p.0, p.1, m.tool_r + cell, &mut hit);
            for &k in &hit {
                if sev.severed_at[k] > mi as u32 {
                    sev.severed_at[k] = mi as u32;
                }
            }
        }
    }

    let at_of = |mi: usize| -> String {
        let s = prog.moves[mi].section;
        format!(
            "operation {} of {} (`{}`)",
            s + 1,
            prog.sections.len(),
            prog.sections.get(s).map(|x| x.name.as_str()).unwrap_or("?")
        )
    };

    // ---- clamps whose bearing area the program cuts away -------------------
    let mut clamp_live_until: Vec<u32> = Vec::with_capacity(fixturing.clamps.len());
    for (ci, c) in fixturing.clamps.iter().enumerate() {
        let cells = &contact_of[ci];
        if cells.is_empty() {
            clamp_live_until.push(0);
            continue;
        }
        let mut standing = 0usize;
        let mut last = 0u32;
        let mut first_cut: Option<u32> = None;
        for &k in cells {
            let s = sev.severed_at[k];
            if s == HD_NEVER {
                standing += 1;
            } else {
                last = last.max(s);
                first_cut = Some(first_cut.map_or(s, |f: u32| f.min(s)));
            }
        }
        clamp_live_until.push(if standing > 0 { HD_NEVER } else { last });
        // ⚠ **REACHABLE ONLY TOGETHER WITH `CutsClamp` TODAY, and that is a
        // property of the MODEL rather than of this check.** A `Clamp` has one
        // rectangle and it serves as both the keepout and the bearing area, so
        // the only way the program can remove the material a clamp bears on is
        // to drive the cutter through the clamp — which `Fixturing::check`
        // refuses first. The finding becomes independently live the moment a
        // BEARING PAD smaller than the footprint exists (`padMm`, §5 of
        // docs/design-68-hold-down-validation.md): a pressure bar bridging over
        // the work bears on two end pads, and the cut between them is clear of
        // neither the clamp's outline nor the bar. It is built now, and named as
        // currently-redundant, rather than left out and forgotten when the model
        // grows.
        if standing == 0 {
            findings.push(HoldDownFinding::ClampContactLost {
                clamp: c.name.clone(),
                at: at_of(last as usize),
            });
        } else if let Some(f) = first_cut {
            findings.push(HoldDownFinding::ClampContactReduced {
                clamp: c.name.clone(),
                at: at_of(f as usize),
                fraction_remaining: standing as f64 / cells.len() as f64,
            });
        }
    }

    // ---- the final state, and the pieces it leaves -------------------------
    let mut alive: Vec<bool> =
        (0..n).map(|k| sev.in_sheet[k] && sev.severed_at[k] == HD_NEVER).collect();
    let mut dsu = Dsu::new(n);
    for k in 0..n {
        dsu.parent[k] = k as u32;
        if alive[k] {
            dsu.size[k] = 1;
            dsu.clamped[k] = is_contact[k] as u32;
        }
    }
    for k in 0..n {
        if alive[k] {
            hd_link(&mut dsu, &alive, k, cols, n);
        }
    }

    use std::collections::HashMap;
    let mut agg: HashMap<u32, HdPiece> = HashMap::new();
    // The root AT THE FINAL STATE, kept because the reverse walk rewinds the
    // DSU to the start of the program and it can no longer answer this.
    let mut final_root: Vec<u32> = vec![u32::MAX; n];
    for k in 0..n {
        if !alive[k] {
            continue;
        }
        let r = dsu.find(k) as u32;
        final_root[k] = r;
        let (px, py) = sev.world(k % cols, k / cols);
        let clamped = dsu.clamped[r as usize] > 0;
        let e = agg.entry(r).or_insert(HdPiece {
            rep: k,
            root: r,
            cells: 0,
            area_mm2: 0.0,
            bbox: [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
            centroid: (0.0, 0.0),
            clamped,
            freed_at: None,
        });
        e.cells += 1;
        e.centroid.0 += px;
        e.centroid.1 += py;
        e.bbox[0] = e.bbox[0].min(px);
        e.bbox[1] = e.bbox[1].min(py);
        e.bbox[2] = e.bbox[2].max(px);
        e.bbox[3] = e.bbox[3].max(py);
    }
    for p in agg.values_mut() {
        p.area_mm2 = p.cells as f64 * cell * cell;
        p.centroid.0 /= p.cells as f64;
        p.centroid.1 /= p.cells as f64;
    }

    // Which final pieces each RAPID passes over. Collected here, in one forward
    // pass, because the reverse walk below is where `freed_at` is learned and
    // asking this per piece afterwards would re-walk the program once each.
    let mut rapid_over: Vec<(usize, Vec<u32>)> = Vec::new();
    for (i, m) in prog.moves.iter().enumerate() {
        if m.kind != ProgKind::Rapid {
            continue;
        }
        hd_points(m, step.max(cell), &mut pts);
        let mut roots: Vec<u32> = Vec::new();
        for p in &pts {
            hit.clear();
            sev.disc(p.0, p.1, m.tool_r.max(cell * 0.5), &mut hit);
            for &k in &hit {
                let r = final_root[k];
                if r != u32::MAX && !roots.contains(&r) {
                    roots.push(r);
                }
            }
        }
        if !roots.is_empty() {
            rapid_over.push((i, roots));
        }
    }

    // Pieces that end the program held by nothing, largest first.
    let mut free: Vec<HdPiece> = agg
        .values()
        .filter(|a| !a.clamped)
        .map(|a| HdPiece {
            rep: a.rep,
            root: a.root,
            cells: a.cells,
            area_mm2: a.area_mm2,
            bbox: a.bbox,
            centroid: a.centroid,
            clamped: a.clamped,
            freed_at: None,
        })
        .collect();
    free.sort_by(|a, b| b.cells.cmp(&a.cells));
    // 🔴 A CAP THAT DROPS FINDINGS MUST SAY SO. These are pieces the program
    // leaves held by nothing; the 9th loose offcut is as free as the 1st, and
    // silently examining only the largest 8 reads as "8 is all there were".
    // `pending` is the channel that exists for exactly this — it suppresses a
    // clean read of `ran()` rather than hiding behind a count.
    let free_total = free.len();
    free.truncate(8);
    let free_truncated = (free_total, free.len());

    let mut by_move: Vec<Vec<u32>> = vec![Vec::new(); prog.moves.len().max(1)];
    for k in 0..n {
        let s = sev.severed_at[k];
        if s != HD_NEVER {
            by_move[s as usize].push(k as u32);
        }
    }

    // ---- the reverse walk --------------------------------------------------
    let mut events: Vec<(usize, f64, f64, f64)> = Vec::new();
    for i in (0..prog.moves.len()).rev() {
        // state(i) = state(i+1) + everything this move removed. Adding it back
        // BEFORE judging move i is what makes the judgement about the material
        // as it stood when the cutter arrived.
        for &kk in &by_move[i] {
            let k = kk as usize;
            alive[k] = true;
            dsu.parent[k] = k as u32;
            dsu.size[k] = 1;
            dsu.clamped[k] = is_contact[k] as u32;
        }
        for &kk in &by_move[i] {
            hd_link(&mut dsu, &alive, kk as usize, cols, n);
        }

        let m = &prog.moves[i];
        if m.kind.cuts() {
            hd_points(m, step, &mut pts);
            'outer: for p in &pts {
                hit.clear();
                // The TRUE radius here, NOT the dilated one: this asks which
                // material the cutter is ENTERING, and overstating that would
                // manufacture false reds in a check whose entire value is that
                // it is believed.
                sev.disc(p.0, p.1, m.tool_r.max(cell * 0.5), &mut hit);
                for &k in &hit {
                    if !alive[k] {
                        continue;
                    }
                    let r = dsu.find(k);
                    if dsu.clamped[r] == 0 {
                        events.push((i, p.0, p.1, dsu.size[r] as f64 * cell * cell));
                        break 'outer;
                    }
                }
            }
        }

        for f in free.iter_mut() {
            if f.freed_at.is_none() {
                let r = dsu.find(f.rep);
                if dsu.clamped[r] > 0 {
                    f.freed_at = Some(i);
                }
            }
        }
    }

    // ---- machining material nothing holds ----------------------------------
    events.sort_by_key(|e| e.0);
    // 🔴 EACH OF THESE IS A REFUSAL, AND THEY ARE ADDITIVE. Every event names a
    // distinct (x, y, at) where the cutter enters material nothing is holding —
    // `UnrestrainedMaterialMachined` is `HoldDownSeverity::Refusal`. Reporting
    // the first 3 silently means an operator fixes 3, re-runs, and meets the
    // next 3, never learning there were 40.
    // ⚠ The cap elsewhere in this file is justified because `unread` is FATAL
    // and NOT additive, so a 9th distinct kind changes no decision. That
    // reasoning does not transfer here: each event is a separate place a person
    // must go and clamp.
    if events.len() > 3 {
        findings.push(HoldDownFinding::FindingsTruncated {
            kind: "moment(s) machining material nothing holds",
            listed: 3,
            total: events.len(),
        });
    }
    if free_truncated.0 > free_truncated.1 {
        findings.push(HoldDownFinding::FindingsTruncated {
            kind: "piece(s) left held by nothing",
            listed: free_truncated.1,
            total: free_truncated.0,
        });
    }
    for e in events.iter().take(3) {
        let live: Vec<String> = fixturing
            .clamps
            .iter()
            .enumerate()
            .filter(|(ci, _)| !contact_of[*ci].is_empty() && clamp_live_until[*ci] >= e.0 as u32)
            .map(|(_, c)| c.name.clone())
            .collect();
        findings.push(HoldDownFinding::UnrestrainedMaterialMachined {
            x: e.1,
            y: e.2,
            at: at_of(e.0),
            clamps_elsewhere: live,
            piece_area_mm2: e.3,
        });
    }

    // ---- pieces free while the program runs on -----------------------------
    //
    // A piece smaller than the cutter that made it cannot exist as a separate
    // object, so below that this is dilation noise rather than an offcut.
    let min_area = (std::f64::consts::PI * prog.smallest_tool_r.powi(2)).max(cell * cell);
    for f in &free {
        if f.area_mm2 < min_area {
            continue;
        }
        let after = f.freed_at.map(|i| i + 1).unwrap_or(0);
        let cutting_after = cutting.iter().filter(|i| **i >= after).count();
        let ops_after = {
            let mut secs: Vec<usize> =
                prog.moves[after.min(prog.moves.len())..].iter().map(|m| m.section).collect();
            secs.sort_unstable();
            secs.dedup();
            secs.len()
        };
        let rapids =
            rapid_over.iter().filter(|(i, rs)| *i >= after && rs.contains(&f.root)).count();
        findings.push(HoldDownFinding::PieceFreeWhileProgramContinues {
            area_mm2: f.area_mm2,
            bbox: f.bbox,
            freed_at: f.freed_at.map(at_of),
            ops_remaining: ops_after,
            cutting_moves_remaining: cutting_after,
            rapids_over: rapids,
        });
    }

    // ---- centroid against the support polygon ------------------------------
    if hull.len() >= 3 {
        let sheet_area = stock.size_x_mm * stock.size_y_mm;
        let mut big: Vec<&HdPiece> =
            agg.values().filter(|a| a.area_mm2 > sheet_area * 0.01).collect();
        big.sort_by(|a, b| b.cells.cmp(&a.cells));
        if big.len() > 4 {
            findings.push(HoldDownFinding::FindingsTruncated {
                kind: "region(s) over 1% of the sheet tested for a centroid outside the clamp hull",
                listed: 4,
                total: big.len(),
            });
        }
        for a in big.iter().take(4) {
            if !in_poly(&hull, a.centroid) {
                findings.push(HoldDownFinding::RegionCentroidOutsideClampHull {
                    area_mm2: a.area_mm2,
                    cx: a.centroid.0,
                    cy: a.centroid.1,
                });
            }
        }
    }

    HoldDownReport { basis, findings }
}

/// 🔴 HOLD-DOWN — and every test here is driven through the **EMITTED
/// PROGRAM**, not through a `Toolpath` and not through a `Job`.
///
/// The helper builds a reference job, plans it and RUNS THE POST, then hands
/// the G-code text to [`check_hold_down`]. A restraint test written against
/// `Job::operations` or `TabSpec::enabled` would be asserting on an intention;
/// this lane has been bitten by that five times.
#[cfg(test)]
mod hold_down_tests {
    use super::*;
    use crate::fixtures::JobPlant;
    use crate::types::{OperationParams, Stock, ZDatum};

    struct Emitted {
        gcode: String,
        stock: Stock,
        tools: Vec<(String, f64)>,
        fixturing: Fixturing,
    }

    /// Plan a reference job and POST it. Panics if the job refuses — a refused
    /// job emits no program, and a test asserting on an empty string would pass
    /// for the wrong reason.
    fn emit(name: &str, plant: JobPlant) -> Emitted {
        emit_with_datum(name, plant, ZDatum::WorkpieceTop)
    }

    /// The same, with **where Z0 is** chosen by the caller.
    ///
    /// The datum is set on the SETUP before planning, exactly as the CLI's
    /// `--spoilboard-zero` and a config's `stock.z_zero_at_top` do, so the plan
    /// is identical and only the emitted Z words move. That is the property
    /// under test: this reader parses the EMITTED program, so it inherits
    /// whatever frame the operator declared and must be told which one.
    fn emit_with_datum(name: &str, plant: JobPlant, datum: ZDatum) -> Emitted {
        let mut built = crate::fixtures::build(name, plant).expect("no such fixture job");
        built.job.stock.z_datum = datum;
        let r = crate::job::plan_job(&built.job);
        assert!(
            r.is_runnable(),
            "the {name} job refused before this test could run: {:?}",
            r.refusals
        );
        let post = crate::post::for_technology(built.job.technology).expect("no post");
        let out = post.write(
            &r.path,
            &built.job.machine,
            &built.job.stock,
            &OperationParams::default(),
            &built.job.post,
        );
        assert!(!out.gcode.trim().is_empty(), "the {name} job emitted no G-code");
        let mut tools: Vec<(String, f64)> = Vec::new();
        for op in &built.job.operations {
            if !tools.iter().any(|(n, _)| *n == op.tool.name) {
                tools.push((op.tool.name.clone(), op.tool.radius_mm()));
            }
        }
        Emitted {
            gcode: out.gcode,
            stock: built.job.stock.clone(),
            tools,
            fixturing: built.job.fixturing.clone(),
        }
    }

    fn refusals(r: &HoldDownReport) -> Vec<String> {
        r.refusals().iter().map(|f| f.describe()).collect()
    }

    /// The clamps the `clamped` reference job declares: two bars up the workpiece,
    /// clear of the part. A REAL fixture entry, not a shape invented to make a
    /// test work.
    fn real_bars() -> Fixturing {
        Fixturing {
            clamps: vec![
                Clamp::new("bar-left", 5.0, 0.0, 40.0, 900.0, 40.0),
                Clamp::new("bar-right", 500.0, 0.0, 40.0, 900.0, 40.0),
            ],
            confirmed_clear: false,
        }
    }

    // -----------------------------------------------------------------------
    //  NEGATIVE CONTROL alpha — a clamp that holds nothing
    // -----------------------------------------------------------------------

    /// 🔴 THE PLANT. Same emitted program, same workpiece, same cutter: the ONLY
    /// thing that changes is that the declared clamp is bolted to the machine
    /// somewhere the workpiece is not. Nothing holds the work, and the program
    /// starts cutting it.
    ///
    /// `Fixturing::check` is SILENT on this by construction — a clamp nothing
    /// goes near cannot produce `CutsClamp` or `RapidBelowClamp` — which is the
    /// whole reason this check exists beside it.
    #[test]
    fn a_clamp_that_holds_nothing_is_a_refusal_naming_the_piece_and_the_moment() {
        let e = emit("clamped", JobPlant::None);
        let nothing = Fixturing {
            // 700mm out along X on a 600mm workpiece: declared, measured, turned
            // the right way, and bearing on air.
            clamps: vec![Clamp::new("cam-on-the-bed", 700.0, 100.0, 40.0, 40.0, 35.0)],
            confirmed_clear: false,
        };
        let r = check_hold_down(&e.gcode, &nothing, &e.stock, &e.tools, 1.0);

        assert!(r.ran(), "the check declined to run, so it proves nothing: {:?}", r.basis.pending);
        let refs = refusals(&r);
        assert!(
            refs.iter().any(|s| s.contains("NOTHING IS HOLDING THE MATERIAL BEING CUT")),
            "a program cutting a workpiece nothing holds was accepted: {:#?}",
            r.findings
        );
        // Actionable, per the rule: the piece, the moment, and the fix.
        let first = refs.iter().find(|s| s.contains("NOTHING IS HOLDING")).unwrap();
        assert!(first.contains("operation 1 of"), "the refusal names no moment: {first}");
        assert!(first.contains("mm^2"), "the refusal names no piece: {first}");
        assert!(first.contains("Fix by"), "the refusal names no fix: {first}");
        // And the clamp that holds nothing is called out in its own right.
        assert!(
            r.findings.iter().any(|f| matches!(
                f,
                HoldDownFinding::ClampBearsOnNoSheet { clamp } if clamp == "cam-on-the-bed"
            )),
            "a clamp bearing on no workpiece at all was not reported: {:#?}",
            r.findings
        );
    }

    /// 🔴 A TRUNCATED REPORT MUST SAY IT WAS TRUNCATED.
    ///
    /// `UnrestrainedMaterialMachined` is a REFUSAL and it is ADDITIVE: every
    /// event names a distinct place and time a person must go and clamp. The
    /// listing caps at 3, and until 2026-09-07 it capped SILENTLY — this very
    /// fixture produces 354 events and reported 3, so an operator could clear
    /// the 3, re-run, and meet the next 3 forever without learning the count.
    ///
    /// ⚠ The disclosure is a FINDING, not `basis.pending`. `pending` means the
    /// check could not run, which would make `ran()` false and read as "nothing
    /// was assessed" — false here, since every event WAS found. Truncating the
    /// listing and failing to assess are different claims.
    #[test]
    fn a_truncated_hold_down_listing_names_how_many_it_did_not_list() {
        let e = emit("clamped", JobPlant::None);
        let nothing = Fixturing {
            clamps: vec![Clamp::new("cam-on-the-bed", 700.0, 100.0, 40.0, 40.0, 35.0)],
            confirmed_clear: false,
        };
        let r = check_hold_down(&e.gcode, &nothing, &e.stock, &e.tools, 1.0);

        // The check RAN — the truncation must not be reported as an inability.
        assert!(r.ran(), "truncation was reported as the check declining: {:?}", r.basis.pending);

        let trunc: Vec<&HoldDownFinding> = r
            .findings
            .iter()
            .filter(|f| matches!(f, HoldDownFinding::FindingsTruncated { .. }))
            .collect();
        assert!(
            !trunc.is_empty(),
            "354 unrestrained-material events are listed 3 at a time and NOTHING said so"
        );
        let listed_events = r
            .findings
            .iter()
            .filter(|f| matches!(f, HoldDownFinding::UnrestrainedMaterialMachined { .. }))
            .count();
        for f in &trunc {
            if let HoldDownFinding::FindingsTruncated { listed, total, .. } = f {
                assert!(total > listed, "a truncation notice that hid nothing: {listed}/{total}");
                // The notice must carry the real total, not the capped count.
                assert!(
                    *total > listed_events,
                    "the notice reports {total} but {listed_events} were listed — it is not \
                     disclosing a truncation at all"
                );
                assert!(
                    f.describe().contains(&total.to_string()),
                    "the human-readable line omits the total: {}",
                    f.describe()
                );
            }
        }
    }

    /// 🔴 THE MIRROR, and it is the half that says the plant is about the CODE
    /// and not about the harness. Same program, same cell, real clamps: no
    /// refusal. Without this, "everything is red" would satisfy the test above.
    #[test]
    fn the_same_program_held_by_the_real_bars_is_not_refused() {
        let e = emit("clamped", JobPlant::None);
        let r = check_hold_down(&e.gcode, &e.fixturing, &e.stock, &e.tools, 1.0);
        assert!(r.ran(), "the check declined to run: {:?}", r.basis.pending);
        assert!(
            !e.fixturing.clamps.is_empty(),
            "the control is vacuous: the `clamped` job declared no clamps"
        );
        assert_eq!(
            refusals(&r),
            Vec::<String>::new(),
            "a correctly held job was refused: {:#?}",
            r.findings
        );
    }

    // -----------------------------------------------------------------------
    //  NEGATIVE CONTROL beta — a part released while the program runs on
    // -----------------------------------------------------------------------

    /// 🔴 RESTRAINT CHANGES DURING THE JOB, and this is the pair that proves
    /// the check is about WHEN — driven by TABS, which is the mechanism that
    /// decides it on every real job.
    ///
    /// **The tabs are never read from a setting.** A tab is a bridge of cells
    /// the program never takes to through-depth (`toolpath` raises Z inside a
    /// tab window), so `TabSpec::enabled` is invisible here and the difference
    /// between these two runs is visible in the emitted motion alone. With tabs
    /// the blank is never severed from the workpiece and there is no free piece at
    /// all; with `--plant no-tabs` it comes off, and the check says which piece,
    /// when, and what is still to come.
    ///
    /// ⚠ **What this pair does NOT prove, said here rather than left to be
    /// assumed: that the release is EARLY.** `optimise_route`'s group ordering
    /// (gate REL) already moves every release to the end on all six reference
    /// fixtures, so the blank comes off during the last operation and only the
    /// tail of that operation remains. The freed-early-with-the-program-running
    /// case has no reference fixture and is covered by
    /// [`a_piece_freed_early_counts_the_operations_and_the_rapids_that_follow`],
    /// which builds the program explicitly.
    #[test]
    fn a_part_freed_early_is_reported_with_what_is_still_to_come() {
        let held = emit("two-part", JobPlant::None);
        let loose = emit("two-part", JobPlant::NoTabs);
        assert_ne!(held.gcode, loose.gcode, "the plant changed no motion — it is vacuous");

        let bars = real_bars();
        let clean = check_hold_down(&held.gcode, &bars, &held.stock, &held.tools, 1.0);
        let planted = check_hold_down(&loose.gcode, &bars, &loose.stock, &loose.tools, 1.0);
        assert!(clean.ran() && planted.ran(), "the check declined: {:?} {:?}", clean.basis.pending, planted.basis.pending);

        let free_of = |r: &HoldDownReport| -> Vec<(f64, usize, usize)> {
            r.findings
                .iter()
                .filter_map(|f| match f {
                    HoldDownFinding::PieceFreeWhileProgramContinues {
                        area_mm2,
                        ops_remaining,
                        cutting_moves_remaining,
                        ..
                    } => Some((*area_mm2, *ops_remaining, *cutting_moves_remaining)),
                    _ => None,
                })
                .collect()
        };

        assert!(
            free_of(&clean).is_empty(),
            "the TABBED job reported a loose piece — tabs are cells the program never takes \
             through-depth, and reporting one here would be a false red on every real job: {:#?}",
            clean.findings
        );
        let loose_pieces = free_of(&planted);
        assert!(
            !loose_pieces.is_empty(),
            "a part cut free while the spindle was still turning was not reported: {:#?}",
            planted.findings
        );
        // The numbers are what an operator can act on. A finding that says
        // "a piece may be loose" and stops is not a finding.
        let (area, ops, cuts) = loose_pieces[0];
        assert!(
            (area - 24_000.0).abs() < 2_000.0,
            "the freed piece should be the 200x120 blank (24,000mm^2); got {area}mm^2"
        );
        assert!(ops > 0 && cuts > 0, "nothing is reported as still to come: {ops} ops, {cuts} cuts");
    }

    /// 🔴🔴 **THE ONE THAT MATTERS. A program that frees a part must still
    /// report it freed when Z0 moves to the spoilboard — and the negative
    /// control asserts on EMPTINESS, because empty is what PASS looks like
    /// here.**
    ///
    /// # The failure this guards
    ///
    /// [`check_hold_down`] decides a cell is severed by comparing Zs parsed out
    /// of the EMITTED program against a through-depth. That number was
    /// hard-coded to `-stock.thickness_mm` — the workpiece underside in the
    /// workpiece-top frame, and nothing at all in the other one. Under a
    /// spoilboard datum every emitted cutting Z lies between `+thickness` and
    /// `0`, so **every move fails the test, every move is skipped, no cell is
    /// ever marked severed, no component is ever unrestrained, and the report
    /// comes back with no findings.**
    ///
    /// "No findings" and "checked and clear" are the same colour to anyone not
    /// reading carefully. At the machine that is a part reported restrained
    /// which is loose under a 2.2 kW spindle — gate `P1`'s physical failure,
    /// arriving through a different door.
    ///
    /// # Why the control is built this way
    ///
    /// The pre-fix constant is exactly what a reader in the **wrong frame**
    /// computes, so the defect is reproduced by handing the bottom-datum
    /// program to a `Stock` that declares the top datum — no `#[cfg(test)]`
    /// hole in the checker, no second code path, and the plant is the same
    /// arithmetic that shipped. If `through_z` ever stops asking the datum, the
    /// third limb below is what the fixed code produces and the second limb goes
    /// red.
    #[test]
    fn a_freed_part_is_still_reported_freed_when_z_is_zeroed_on_the_spoilboard() {
        let bars = real_bars();
        let top = emit_with_datum("two-part", JobPlant::NoTabs, ZDatum::WorkpieceTop);
        let bottom = emit_with_datum("two-part", JobPlant::NoTabs, ZDatum::SpoilboardTop);

        // The premise, asserted rather than assumed: the datum moved the
        // PROGRAM. If these were equal the rest of the test would be comparing
        // one program with itself and would pass for the wrong reason.
        assert_ne!(
            top.gcode, bottom.gcode,
            "the datum changed no emitted byte — this test is vacuous"
        );
        // …and it moved it by exactly one workpiece thickness, on every Z word
        // that is a COORDINATE, and by nothing at all on every Z word that is a
        // DISTANCE. A forgotten site is one value that did not move; a doubled
        // site is one that moved twice; a distance that moved is a probe seek
        // that no longer reaches the plate. All three fail here, and all three
        // would otherwise be invisible to the limbs below.
        //
        // 🔴 The `G91` split is not a parsing convenience. Inside incremental
        // mode a `Z` is how far to travel, and a datum has nothing to say about
        // a distance — which is exactly why the probe's two `G38.2` seeks and
        // their retract sit inside a `G91` block (see `post_grblhal::emit_probe`).
        // `R` on a canned cycle is a plane, so it moves with the coordinates.
        let z_values = |g: &str| -> (Vec<f64>, Vec<f64>, Vec<f64>) {
            let (mut abs, mut inc, mut set_datum) = (Vec::new(), Vec::new(), Vec::new());
            let mut incremental = false;
            for line in g.lines() {
                let line = line.trim();
                if line.starts_with('(') {
                    continue; // a comment is prose, not a coordinate
                }
                // 🔴 `G10 L20 P1 Z<v>` is not a move — it is the program SAYING
                // WHERE Z0 IS, and it is the one line the founder's decision
                // changes. It does NOT shift today, and that is correct under
                // two of the three answers in `docs/design-87-z-datum.md` §3
                // (plate on the spoilboard, or no plate at all) and wrong under
                // the third (plate on the workpiece top). It is bucketed apart
                // so that this test states the fact rather than encoding one of
                // the answers into a gate before the founder has given it.
                if line.contains("G10") {
                    let mut rest = line;
                    while let Some(i) = rest.find('Z') {
                        rest = &rest[i + 1..];
                        let end = rest
                            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                            .unwrap_or(rest.len());
                        if let Ok(z) = rest[..end].parse::<f64>() {
                            set_datum.push(z);
                        }
                    }
                    continue;
                }
                if line.contains("G91") {
                    incremental = true;
                }
                let canned = line.contains("G8");
                let mut rest = line;
                let mut here: Vec<f64> = Vec::new();
                while let Some(i) = rest.find(|c| c == 'Z' || (canned && c == 'R')) {
                    rest = &rest[i + 1..];
                    let end = rest
                        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                        .unwrap_or(rest.len());
                    if let Ok(z) = rest[..end].parse::<f64>() {
                        here.push(z);
                    }
                }
                if incremental {
                    inc.extend(here);
                } else {
                    abs.extend(here);
                }
                if line.contains("G90") {
                    incremental = false;
                }
            }
            (abs, inc, set_datum)
        };
        let ((abs_t, inc_t, dat_t), (abs_b, inc_b, dat_b)) =
            (z_values(&top.gcode), z_values(&bottom.gcode));
        let thickness = bottom.stock.thickness_mm;
        assert!(!abs_t.is_empty(), "no Z coordinates were found at all — the reader is broken");
        assert_eq!(
            (abs_t.len(), inc_t.len(), dat_t.len()),
            (abs_b.len(), inc_b.len(), dat_b.len()),
            "the two programs do not carry the same Z words in the same modes, so the datum did \
             more than translate"
        );
        // ⚠ RECORDED, NOT RULED ON. `G10 L20 P1 Z` is unchanged by the datum,
        // which is what the shipped post does and what design-87 §3 leaves open.
        // If this ever starts differing, somebody answered the founder's
        // question in code — and this line is where they have to say so.
        assert_eq!(
            dat_t, dat_b,
            "the emitted Z DATUM line moved with the datum. That is design-87 §3's answer P2 \
             (the plate rests on the workpiece top) and it has not been ruled on — see §3 before \
             changing this assertion"
        );
        // ⚠ The tolerance is ONE PRINTING QUANTUM, not a fudge. The post writes
        // 3 decimals, so each of the two values carries up to 5e-4 of rounding
        // and their difference up to 1e-3 — `-4.7625` prints as `-4.763` while
        // `13.2375` prints as `13.238`. Anything looser would let a real
        // half-shift hide; anything tighter is a test of `format!`.
        for (i, (a, b)) in abs_t.iter().zip(abs_b.iter()).enumerate() {
            assert!(
                (b - a - thickness).abs() < 1.0005e-3,
                "Z COORDINATE {i} moved by {:.6} and not by one workpiece thickness \
                 ({thickness:.3}): {a:.3} -> {b:.3}",
                b - a
            );
        }
        for (i, (a, b)) in inc_t.iter().zip(inc_b.iter()).enumerate() {
            assert!(
                (b - a).abs() < 1e-12,
                "Z DISTANCE {i} moved by {:.6} — a datum has nothing to say about how far to \
                 travel, and a probe seek that moved no longer reaches the plate: {a:.3} -> {b:.3}",
                b - a
            );
        }
        // 🔴 AND NOTHING ELSE MOVED. X, Y, I, J, R, F and every word of prose
        // must be byte-identical: masking out the Z VALUES only, the two
        // programs are the same file.
        let mask_z = |g: &str| -> String {
            let mut out = String::with_capacity(g.len());
            for line in g.lines() {
                if line.trim_start().starts_with('(') {
                    out.push_str(line);
                    out.push('\n');
                    continue;
                }
                let canned = line.contains("G8");
                let mut rest = line;
                while let Some(i) = rest.find(|c| c == 'Z' || (canned && c == 'R')) {
                    out.push_str(&rest[..=i]);
                    rest = &rest[i + 1..];
                    let end = rest
                        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
                        .unwrap_or(rest.len());
                    if rest[..end].parse::<f64>().is_ok() {
                        out.push('*');
                        rest = &rest[end..];
                    }
                }
                out.push_str(rest);
                out.push('\n');
            }
            out
        };
        assert_eq!(
            mask_z(&top.gcode),
            mask_z(&bottom.gcode),
            "the two programs differ somewhere other than in their Z values"
        );

        let free_of = |r: &HoldDownReport| -> Vec<(u64, usize, usize)> {
            r.findings
                .iter()
                .filter_map(|f| match f {
                    HoldDownFinding::PieceFreeWhileProgramContinues {
                        area_mm2,
                        ops_remaining,
                        cutting_moves_remaining,
                        ..
                    } => Some((area_mm2.round() as u64, *ops_remaining, *cutting_moves_remaining)),
                    _ => None,
                })
                .collect()
        };

        // ---- limb 1: the top datum still works (nothing was traded away) ----
        let a = check_hold_down(&top.gcode, &bars, &top.stock, &top.tools, 1.0);
        assert!(a.ran(), "the check declined on the top datum: {:?}", a.basis.pending);
        let freed_top = free_of(&a);
        assert!(
            !freed_top.is_empty(),
            "the CONTROL is vacuous: this program frees nothing even at the top datum, so a \
             blind reader below could not be distinguished from a correct one: {:#?}",
            a.findings
        );

        // ---- limb 2: the bottom datum reports the SAME release --------------
        let b = check_hold_down(&bottom.gcode, &bars, &bottom.stock, &bottom.tools, 1.0);
        assert!(b.ran(), "the check declined on the bottom datum: {:?}", b.basis.pending);
        assert_eq!(
            freed_top,
            free_of(&b),
            "the same motion released a different set of pieces once Z0 moved — the reader is \
             not in the frame the program is written in"
        );
        // Every finding that can only exist because a cell was marked SEVERED.
        // These are the ones the blind reader cannot produce, and the ones an
        // operator acts on.
        let severance_of = |r: &HoldDownReport| -> usize {
            r.findings
                .iter()
                .filter(|f| {
                    matches!(
                        f,
                        HoldDownFinding::UnrestrainedMaterialMachined { .. }
                            | HoldDownFinding::PieceFreeWhileProgramContinues { .. }
                            | HoldDownFinding::ClampContactLost { .. }
                            | HoldDownFinding::ClampContactReduced { .. }
                    )
                })
                .count()
        };
        assert!(
            severance_of(&b) > 0,
            "a program that frees a part under the spoilboard datum produced NO severance \
             finding at all: {:#?}",
            b.findings
        );
        assert_eq!(
            severance_of(&a),
            severance_of(&b),
            "the two datums disagree about how much this program releases"
        );

        // ---- limb 3: 🔴 THE NEGATIVE CONTROL — the reader in the WRONG frame -
        //
        // This is the pre-fix code, exactly: a `through_z` of `-thickness`
        // against a program whose Zs never go below zero. Assert on EMPTY.
        let mut wrong_frame = bottom.stock.clone();
        wrong_frame.z_datum = ZDatum::WorkpieceTop;
        let blind = check_hold_down(&bottom.gcode, &bars, &wrong_frame, &bottom.tools, 1.0);
        assert!(
            blind.ran(),
            "the blind reader DECLINED, which is a safe answer — the defect is that it does not \
             decline, it reports: {:?}",
            blind.basis.pending
        );
        assert!(
            free_of(&blind).is_empty(),
            "the negative control did not go blind, so limb 2 proves nothing about the frame"
        );
        // 🔴 THE ASSERTION THIS TEST EXISTS FOR: **EMPTY**. Not "fewer", not
        // "different" — the blind reader marks NO cell severed at all, so every
        // finding downstream of severance disappears and the report says the
        // work is held.
        assert_eq!(
            severance_of(&blind),
            0,
            "the negative control did not go blind, so limb 2 proves nothing about the frame: \
             {:#?}",
            blind.findings
        );
        assert!(
            refusals(&blind).is_empty(),
            "the blind reader still refused, so the defect it models is not the silent one"
        );
        // Said out loud, because it is the whole point: the blind report has no
        // pending, no refusal and no freed piece — which is exactly what a
        // correct, fully-held job looks like from every angle a caller has.
        assert!(
            blind.ran() && refusals(&blind).is_empty() && free_of(&blind).is_empty(),
            "PASS and BLIND must be indistinguishable in shape — that is why the frame has to \
             be asked rather than assumed"
        );
    }

    /// 🔴 THE CASE NO REFERENCE FIXTURE PRODUCES, built as a program because
    /// that is the artefact this module reads.
    ///
    /// A square is cut free in operation 1 and the spindle then works
    /// elsewhere for two more operations, with a rapid crossing back over the
    /// loose piece on the way. That is the founder's question in its sharpest
    /// form — *"during the job the work holding holds down the required
    /// pieces?"* — and the answer has to carry NUMBERS, because "a piece may be
    /// loose" is useless to somebody standing at a machine.
    ///
    /// The mirror is the same three operations with the freeing cut left at a
    /// depth that does not go through: nothing comes loose, and nothing is
    /// reported. Without it, a check that reported a free piece on every job
    /// would pass the first half.
    #[test]
    fn a_piece_freed_early_counts_the_operations_and_the_rapids_that_follow() {
        let stock =
            Stock { size_x_mm: 300.0, size_y_mm: 200.0, thickness_mm: 6.0, ..Stock::default() };
        let held = Fixturing {
            clamps: vec![Clamp::new("bar", 270.0, 0.0, 25.0, 200.0, 20.0)],
            confirmed_clear: false,
        };
        let tools = vec![("cutter".to_string(), 2.0_f64)];
        // `depth` is the only difference between the two runs: -6.5 goes
        // through a 6mm workpiece, -3.0 does not.
        let program = |depth: f64| {
            format!(
                "( tool: cutter D4.00mm F2 )
                 G17 G21 G90
                 ( op: free-the-square [cutter] )
                 G0 X40.000 Y40.000 Z5.000
                 G1 Z{depth:.3} F300.0
                 G1 X120.000 F1000.0
                 G1 Y120.000
                 G1 X40.000
                 G1 Y40.000
                 G0 Z5.000
                 ( op: work-elsewhere-1 [cutter] )
                 G0 X200.000 Y40.000
                 G1 Z-3.000 F300.0
                 G1 Y160.000 F1000.0
                 G0 Z5.000
                 ( op: work-elsewhere-2 [cutter] )
                 G0 X80.000 Y80.000
                 G0 X220.000 Y80.000
                 G1 Z-3.000 F300.0
                 G1 Y160.000 F1000.0
                 G0 Z5.000
                 M30
"
            )
        };
        let loose = check_hold_down(&program(-6.5), &held, &stock, &tools, 0.5);
        let intact = check_hold_down(&program(-3.0), &held, &stock, &tools, 0.5);
        assert!(loose.ran() && intact.ran(), "{:?} {:?}", loose.basis.pending, intact.basis.pending);

        let free: Vec<&HoldDownFinding> = loose
            .findings
            .iter()
            .filter(|f| matches!(f, HoldDownFinding::PieceFreeWhileProgramContinues { .. }))
            .collect();
        assert_eq!(free.len(), 1, "expected exactly the freed square: {:#?}", loose.findings);
        let HoldDownFinding::PieceFreeWhileProgramContinues {
            area_mm2,
            freed_at,
            ops_remaining,
            cutting_moves_remaining,
            rapids_over,
            ..
        } = free[0]
        else {
            unreachable!()
        };
        // ~80x80mm inside the kerf, minus the one-cell dilation.
        assert!(
            (5_000.0..7_000.0).contains(area_mm2),
            "the freed square measured {area_mm2}mm^2, which is not an 80x80 square"
        );
        assert!(
            freed_at.as_deref().unwrap_or("").contains("free-the-square"),
            "the finding does not name the operation that freed it: {freed_at:?}"
        );
        assert!(
            *ops_remaining >= 2 && *cutting_moves_remaining >= 2,
            "the finding says nothing is still to come, on a program with two operations left: \
             {ops_remaining} ops, {cutting_moves_remaining} cuts"
        );
        assert!(
            *rapids_over >= 1,
            "the rapid that crosses back over the loose square at X80 Y80 was not counted — a \
             part that lifts into a crossing gantry is why this number exists"
        );

        // THE MIRROR. Same three operations, same clamp, same rapid: the
        // freeing cut simply does not go through, so nothing comes loose.
        assert!(
            !intact
                .findings
                .iter()
                .any(|f| matches!(f, HoldDownFinding::PieceFreeWhileProgramContinues { .. })),
            "a square whose outline never reached through-depth was reported as free — this check \
             is firing on the cut rather than on the severance: {:#?}",
            intact.findings
        );
    }

    // -----------------------------------------------------------------------
    //  Absence is not safety
    // -----------------------------------------------------------------------

    /// 🔴 E5, one level along. Every algorithm in this module is trivially
    /// satisfied by an empty clamp list — "no clamp stands on removed material"
    /// is TRUE when there are no clamps — so zero declared clamps must PEND,
    /// never pass.
    #[test]
    fn no_work_holding_declared_is_pending_and_can_never_read_as_held() {
        let e = emit("clamped", JobPlant::None);
        let r = check_hold_down(&e.gcode, &Fixturing::default(), &e.stock, &e.tools, 1.0);
        assert!(!r.ran(), "a job with no declared work holding ran the checks and found nothing");
        assert!(r.findings.is_empty(), "findings were reported off an undeclared fixture");
        assert!(
            r.basis.pending[0].contains("NO WORK HOLDING IS DECLARED"),
            "{:?}",
            r.basis.pending
        );
    }

    /// A vacuum table declares `confirmed_clear` with NO footprint at all —
    /// which is a statement about the KEEPOUT and says nothing about restraint.
    /// Reading it as "held" would be a false GREEN on the most common shop
    /// setup; reporting the whole workpiece unrestrained would be a false RED on
    /// it. It pends, and the pending says which.
    #[test]
    fn a_vacuum_table_pends_rather_than_reading_as_held_or_as_unheld() {
        let e = emit("clamped", JobPlant::None);
        let vac = Fixturing::preset("vacuum", 600.0, 900.0).unwrap();
        assert!(vac.confirmed_clear && vac.clamps.is_empty(), "the control is vacuous");
        let r = check_hold_down(&e.gcode, &vac, &e.stock, &e.tools, 1.0);
        assert!(!r.ran(), "a vacuum table was treated as a checkable restraint");
        assert!(
            r.basis.pending[0].contains("NO FOOTPRINT AT ALL"),
            "the pending does not say why a vacuum table cannot be checked: {:?}",
            r.basis.pending
        );
        assert!(refusals(&r).is_empty(), "a vacuum table produced a REFUSAL — a false red on the \
             most common shop hold-down is how this whole family gets muted");
    }

    // -----------------------------------------------------------------------
    //  The caveat that must never be droppable
    // -----------------------------------------------------------------------

    /// 🔴 `force_checked: false` prints on EVERY job, including a clean one. A
    /// caveat that appears only when something else is wrong is a caveat nobody
    /// sees on the day it matters.
    #[test]
    fn the_force_is_unchecked_on_a_clean_job_too_and_says_so_first() {
        let e = emit("clamped", JobPlant::None);
        let r = check_hold_down(&e.gcode, &e.fixturing, &e.stock, &e.tools, 1.0);
        assert!(refusals(&r).is_empty(), "the control is vacuous — this job is not clean");
        assert!(!r.basis.force_checked);
        assert!(!r.basis.contact_area_measured);
        assert!(!r.basis.restraint_direction_modelled);
        assert!(!r.basis.tool_widths_from_program);
        assert!(
            r.lines()[0].contains("HOLDING FORCE IS UNCHECKED"),
            "the first line a host renders does not carry the caveat: {:?}",
            r.lines()[0]
        );
        // There is deliberately no way to render the sentence that would be a lie.
        assert!(
            !r.lines().iter().any(|l| l.contains("no hold-down problem")),
            "something rendered 'no hold-down problem found'"
        );
    }

    // -----------------------------------------------------------------------
    //  A check that cannot run says so
    // -----------------------------------------------------------------------

    /// An unmodelled construct makes material read as STILL STANDING, which
    /// reads as HELD — the unsafe direction — so it suppresses the answer
    /// rather than shrinking it.
    #[test]
    fn a_construct_this_reader_does_not_model_pends_instead_of_answering() {
        let e = emit("clamped", JobPlant::None);
        // G20 switches the program to inches. Every coordinate below it means
        // something else, and this reader works in millimetres.
        let planted = e.gcode.replacen("G17 G21", "G17 G20", 1);
        assert_ne!(planted, e.gcode, "the plant changed nothing — it is vacuous");
        let r = check_hold_down(&planted, &e.fixturing, &e.stock, &e.tools, 1.0);
        assert!(!r.ran(), "a program in inches was read as if it were millimetres");
        assert!(
            r.basis.pending.iter().any(|p| p.contains("G20")),
            "the pending does not name what could not be read: {:?}",
            r.basis.pending
        );
        // ...and the same program without the plant DOES answer, or the test
        // above is about a broken harness.
        assert!(check_hold_down(&e.gcode, &e.fixturing, &e.stock, &e.tools, 1.0).ran());
    }

    /// 🔴 The kerf width comes from the DECLARED TOOL TABLE, because the post
    /// prints a diameter for the FIRST tool only — a `( TOOL CHANGE -> … )`
    /// names the cutter and not its width. A name that does not resolve is an
    /// unknown kerf, and an unknown kerf is an unknown severance.
    #[test]
    fn a_cutter_the_tool_table_does_not_carry_pends_rather_than_being_guessed() {
        let e = emit("clamped", JobPlant::None);
        let r = check_hold_down(&e.gcode, &e.fixturing, &e.stock, &[], 1.0);
        assert!(!r.ran(), "an unknown cutter width was guessed");
        assert!(
            r.basis.pending.iter().any(|p| p.contains("kerf width is unknown")),
            "{:?}",
            r.basis.pending
        );
    }

    /// Connectivity over cells cannot see a cut narrower than a cell: two
    /// pieces separated by such a kerf read as STILL JOINED, which reads as
    /// held. The rule is stated against the program's own narrowest cutter, and
    /// the pending names the cell that would resolve it.
    #[test]
    fn a_kerf_the_grid_cannot_resolve_pends_and_names_the_cell_that_would() {
        let e = emit("clamped", JobPlant::None);
        let coarse = check_hold_down(&e.gcode, &e.fixturing, &e.stock, &e.tools, 20.0);
        assert!(!coarse.ran(), "a 20mm grid answered a question about a 6mm kerf");
        assert!(
            coarse.basis.pending.iter().any(|p| p.contains("CONNECTIVITY UNRESOLVED")),
            "{:?}",
            coarse.basis.pending
        );
        assert!(
            coarse.basis.pending.iter().any(|p| p.contains("Re-run at a cell of")),
            "the pending does not name its own remedy: {:?}",
            coarse.basis.pending
        );
        // The mirror: at a cell that CAN resolve the kerf, it answers.
        assert!(check_hold_down(&e.gcode, &e.fixturing, &e.stock, &e.tools, 1.0).ran());
    }

    // -----------------------------------------------------------------------
    //  The direction the map is allowed to be wrong in
    // -----------------------------------------------------------------------

    /// 🔴 THE DILATION, asserted directly so it cannot be "tidied away" while
    /// the findings are left behind — the shape
    /// `a_zero_height_clamp_buys_no_clearance_at_all` already uses.
    ///
    /// Over-reporting removal makes restraint read as LOST (a false alarm,
    /// safe); under-reporting makes it read as PRESENT (MISSED). So a bridge
    /// thinner than the dilation must come out as SEVERED. The mirror is the
    /// same bridge made comfortably wider, which must survive — without it,
    /// "dilate by a metre" would pass.
    #[test]
    fn a_bridge_thinner_than_the_dilation_reads_as_severed_and_a_wide_one_does_not() {
        let stock = Stock { size_x_mm: 200.0, size_y_mm: 100.0, thickness_mm: 6.0, ..Stock::default() };
        let bars = Fixturing {
            clamps: vec![Clamp::new("bar", 0.0, 0.0, 10.0, 100.0, 20.0)],
            confirmed_clear: false,
        };
        let tools = vec![("cutter".to_string(), 1.0_f64)];
        // A through cut straight up the workpiece at x = 100, stopping `gap` short
        // of the far edge. The uncut strip is the bridge.
        let program = |gap: f64| {
            format!(
                "( tool: cutter D2.00mm F2 )\nG17 G21 G90\n( op: split [cutter] )\n\
                 G0 X100.000 Y0.000 Z5.000\nG1 Z-6.000 F300.0\nG1 Y{:.3} F1000.0\n\
                 G0 Z5.000\nM30\n",
                100.0 - gap
            )
        };
        // 0.5mm, so the 2mm kerf this program cuts is resolvable — at 1.0mm
        // the check would correctly PEND and this test would prove nothing.
        let cell = 0.5;
        let thin = check_hold_down(&program(0.25), &bars, &stock, &tools, cell);
        let wide = check_hold_down(&program(12.0), &bars, &stock, &tools, cell);
        assert!(thin.ran() && wide.ran(), "{:?} {:?}", thin.basis.pending, wide.basis.pending);
        assert_eq!(thin.basis.dilation_mm, cell, "the dilation is not one cell");

        let has_free = |r: &HoldDownReport| {
            r.findings
                .iter()
                .any(|f| matches!(f, HoldDownFinding::PieceFreeWhileProgramContinues { .. }))
        };
        assert!(
            has_free(&thin),
            "a 0.25mm bridge — thinner than the stated dilation — survived as material, which is \
             the direction that reads as HELD: {:#?}",
            thin.findings
        );
        assert!(
            !has_free(&wide),
            "a 12mm bridge was reported severed; the dilation is eating real material and this \
             check is a false red: {:#?}",
            wide.findings
        );
    }

    /// 🔴 A clamp whose whole bearing area the program CUTS AWAY. After that
    /// operation the declared restraint is a fiction while the setup workpiece, the
    /// viewport and the keepout check all still show a clamp holding the work.
    ///
    /// ⚠ **The test asserts the redundancy as well as the finding, because the
    /// redundancy is the honest state of the model.** With one rectangle
    /// serving as both keepout and bearing area, the only way to remove the
    /// material under a clamp is to drive the cutter through the clamp — so
    /// `Fixturing::check` fires too. Asserting BOTH here means the day a
    /// bearing pad smaller than the footprint lands, this test says so by
    /// starting to disagree with itself rather than by quietly staying green.
    #[test]
    fn a_clamp_whose_bearing_area_the_program_removes_is_a_refusal_and_today_p7_fires_too() {
        let stock =
            Stock { size_x_mm: 200.0, size_y_mm: 200.0, thickness_mm: 6.0, ..Stock::default() };
        // A small pad at the top of the workpiece, and a through cut straight
        // across it.
        let f = Fixturing {
            clamps: vec![
                Clamp::new("pad", 90.0, 150.0, 20.0, 20.0, 30.0),
                Clamp::new("anchor", 0.0, 0.0, 20.0, 200.0, 30.0),
            ],
            confirmed_clear: false,
        };
        let tools = vec![("cutter".to_string(), 2.0_f64)];
        // ONE list of points, used to build BOTH the program and the plan the
        // keepout check is driven on — so the two halves of this test cannot
        // drift into being about different motion. A zigzag clearing the pad:
        // 3mm apart with a 2mm-radius cutter, so the pad is genuinely gone.
        let mut pts: Vec<(f64, f64)> = Vec::new();
        let mut left = true;
        let mut yy = 148.0;
        while yy <= 172.0 {
            pts.push(if left { (115.0, yy) } else { (85.0, yy) });
            pts.push(if left { (85.0, yy) } else { (115.0, yy) });
            left = !left;
            yy += 3.0;
        }
        let mut gcode = String::from(
            "( tool: cutter D4.00mm F2 )\nG17 G21 G90\n( op: across-the-pad [cutter] )\n\
             G0 X115.000 Y148.000 Z5.000\nG1 Z-6.500 F300.0\n",
        );
        for (px, py) in &pts {
            gcode.push_str(&format!("G1 X{px:.3} Y{py:.3} F1000.0\n"));
        }
        gcode.push_str("G0 Z5.000\nM30\n");

        let r = check_hold_down(&gcode, &f, &stock, &tools, 0.5);
        assert!(r.ran(), "{:?}", r.basis.pending);
        assert!(
            r.findings.iter().any(|x| matches!(
                x,
                HoldDownFinding::ClampContactLost { clamp, .. } if clamp == "pad"
            )),
            "a clamp whose whole bearing area the program removed still reads as holding: {:#?}",
            r.findings
        );
        // The anchor keeps its material, so it must NOT be reported — otherwise
        // this finding fires on every clamp and gets muted.
        assert!(
            !r.findings.iter().any(|x| matches!(
                x,
                HoldDownFinding::ClampContactLost { clamp, .. } if clamp == "anchor"
            )),
            "a clamp standing on material nothing touches was reported as lost: {:#?}",
            r.findings
        );
        // And the redundancy, asserted rather than assumed.
        let mut path = Toolpath::default();
        for (px, py) in &pts {
            path.moves.push(Move::feed_to(crate::types::Vec3::new(*px, *py, -6.5), 1000.0));
        }
        path.recompute_bounds();
        assert!(
            f.check(&path, 2.0, 6.0, &Machine::default())
                .iter()
                .any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
            "P7 did not fire on the same motion — the two checks have come apart and this test's \
             claim about the model is stale"
        );
    }

    // -----------------------------------------------------------------------
    //  Clamps against the workpiece — no program needed
    // -----------------------------------------------------------------------

    /// An operator can act on "everything is clamped along one edge" in ten
    /// seconds, which is why it is worth computing even though it grades
    /// nothing. The hull is built from [`Clamp::corners`] and never from
    /// bounding boxes: a bbox OVERSTATES the support polygon, which is the
    /// unsafe direction.
    #[test]
    fn clamps_along_one_edge_are_reported_and_clamps_on_two_edges_are_not() {
        let e = emit("clamped", JobPlant::None);
        // Three clamps hooked over the y=0 edge, bearing on about a
        // millimetre of workpiece each. ⚠ A 20mm-DEEP band along the same edge is
        // deliberately NOT reported: 20mm of bearing depth does resist rotation,
        // and the moment this fires on it the finding has become a rule of thumb
        // with a threshold nobody sourced. The question "is everything clamped
        // along one edge?" is answered by `EdgeRestraintSpan`, which is printed
        // on every job; this one answers the narrower, degenerate case.
        let one_edge = Fixturing {
            clamps: vec![
                Clamp::new("a", 50.0, -19.0, 40.0, 20.0, 35.0),
                Clamp::new("b", 250.0, -19.0, 40.0, 20.0, 35.0),
                Clamp::new("c", 450.0, -19.0, 40.0, 20.0, 35.0),
            ],
            confirmed_clear: false,
        };
        let collinear = |f: &Fixturing| {
            check_hold_down(&e.gcode, f, &e.stock, &e.tools, 1.0)
                .findings
                .iter()
                .any(|x| matches!(x, HoldDownFinding::ClampContactsCollinear { .. }))
        };
        assert!(
            collinear(&one_edge),
            "three clamps bearing on one row of cells along y=0 were not reported as one line"
        );
        // And the band case, asserted rather than left implicit, so nobody
        // "fixes" the finding by widening it until it fires on everything.
        let band = Fixturing {
            clamps: vec![
                Clamp::new("a", 50.0, 5.0, 40.0, 20.0, 35.0),
                Clamp::new("b", 250.0, 5.0, 40.0, 20.0, 35.0),
                Clamp::new("c", 450.0, 5.0, 40.0, 20.0, 35.0),
            ],
            confirmed_clear: false,
        };
        assert!(!collinear(&band), "a 20mm-deep bearing band was called a line");
        assert!(
            !collinear(&real_bars()),
            "two bars up opposite sides of the workpiece were called collinear — a false red here \
             would appear on every properly held job"
        );
    }

    /// Printed on every job that gets this far, because "all four edges" and
    /// "one edge" are the difference between a workpiece that pivots and one that
    /// does not.
    #[test]
    fn every_sheet_edge_reports_how_much_of_it_lies_under_a_clamp() {
        let e = emit("clamped", JobPlant::None);
        let r = check_hold_down(&e.gcode, &e.fixturing, &e.stock, &e.tools, 1.0);
        let spans: Vec<&str> = r
            .findings
            .iter()
            .filter_map(|f| match f {
                HoldDownFinding::EdgeRestraintSpan { edge, .. } => Some(*edge),
                _ => None,
            })
            .collect();
        assert_eq!(spans.len(), 4, "not every edge was reported: {spans:?}");
        // The `clamped` bars run the full length of the workpiece in Y and cover
        // 40mm of each 600mm edge in X.
        for f in &r.findings {
            if let HoldDownFinding::EdgeRestraintSpan { edge, covered_mm, total_mm } = f {
                if *edge == "x-min" {
                    // 🔴 ZERO, and that is the finding rather than a defect:
                    // the `clamped` bars start 5mm in from the workpiece edge, so
                    // NOTHING bears on the edge itself. An operator reading
                    // "0mm of 900mm" knows the workpiece can lift at that side.
                    assert!(
                        *covered_mm < 1.0 && (*total_mm - 900.0).abs() < 1.0,
                        "x-min: {covered_mm} of {total_mm}"
                    );
                }
                if *edge == "y-min" {
                    assert!(
                        *covered_mm > 60.0 && *covered_mm < 100.0 && (*total_mm - 600.0).abs() < 1.0,
                        "y-min: {covered_mm} of {total_mm}"
                    );
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    //  The reader itself
    // -----------------------------------------------------------------------

    /// 🔴 The program re-datums Z at the probe (`G10 L20 P1 Z…`). A reader that
    /// carried the pre-probe Z forward would put every following depth in the
    /// wrong frame, which is exactly the mixed-datum error `clearance_z` names.
    /// Asserted by measuring the depths the reader ends up with.
    #[test]
    fn the_probe_datum_is_followed_so_depths_are_measured_in_the_frame_the_cuts_are_in() {
        let e = emit("clamped", JobPlant::None);
        let prog = read_program(&e.gcode, &e.tools);
        assert!(prog.unread.is_empty(), "the reference program is not fully read: {:?}", prog.unread);
        assert!(prog.unresolved_tools.is_empty(), "{:?}", prog.unresolved_tools);
        let deepest = prog
            .moves
            .iter()
            .map(|m| m.to.2.min(m.from.2))
            .fold(f64::INFINITY, f64::min);
        assert!(
            (deepest + 18.0).abs() < 0.5,
            "the deepest move read {deepest}mm; the workpiece is 18mm and the program cuts through it, \
             so the Z datum is not being followed"
        );
    }

    /// Moves before the first operation banner belong to no operation — the
    /// probe, the spindle start, the retract — and attributing them to one
    /// would put a phantom cut wherever the tool happened to be.
    #[test]
    fn moves_outside_an_operation_banner_are_attributed_to_nothing() {
        let e = emit("clamped", JobPlant::None);
        let prog = read_program(&e.gcode, &e.tools);
        assert!(!prog.sections.is_empty(), "no sections were read at all");
        assert!(
            prog.moves.iter().all(|m| m.section < prog.sections.len()),
            "a move was attributed to a section that does not exist"
        );
        // The probe travels to Z-30 before any banner. If it had been kept it
        // would be the deepest thing in the program and would sever the workpiece.
        assert!(
            prog.moves.iter().all(|m| m.to.2 > -25.0 && m.from.2 > -25.0),
            "a pre-banner probe move was kept as a cutting move"
        );
    }

    /// 🔴 A FINDING IS REPORTED ONCE, NOT ONCE PER BLOCK — and the operator
    /// reads every one of them.
    ///
    /// Each `unread` entry becomes a `basis.pending` line. Three of the four
    /// branches that name an unmodelled construct used to embed the offending
    /// BLOCK, which made every entry unique and put the end-of-read
    /// `sort(); dedup()` — the thing that is supposed to collapse them — out of
    /// reach. A program with 500 unmodelled blocks produced 500 pendings: the
    /// wall of text an operator learns to scroll past, which is the same
    /// failure as no control at all.
    ///
    /// The property asserted is not "short" but **INDEPENDENT OF PROGRAM
    /// LENGTH**: the same four constructs at 5 blocks each and at 500 blocks
    /// each must read identically. A length bound alone would pass on a cap
    /// that silently truncates; equality says the collapse is real.
    ///
    /// What must SURVIVE is asserted beside it, because a cap that loses the
    /// distinction between the causes trades one bad control for another: the
    /// four kinds stay four messages, and the unmodelled `G` code keeps its
    /// NUMBER, which is the word that says which feature is missing.
    #[test]
    fn the_hold_down_reader_strips_comments_the_way_the_core_does() {
        /* TODO #143 — the FIFTH copy of the comment rule, in the reader whose
         * answer decides whether a part is reported HELD. Its hand-written
         * splice removed the first `( … )` only, counted no depth, and did not
         * know `;` at all, so comment TEXT was scanned as words.
         *
         * ⚠ THE FIRST VERSION OF THIS TEST WAS VACUOUS: it called
         * `hd_words(&strip_comments(line))` — the shared stripper directly —
         * which is not the path `read_program` takes and would have passed
         * before the fix as happily as after it. It must go through
         * `read_program`, which is where the splice lived. */
        // A REAL emitted program, because moves are only recorded inside an
        // operation banner with a resolvable tool — a hand-written snippet
        // records nothing and every assertion below it would be vacuous.
        let e = emit("clamped", JobPlant::None);
        let base = read_program(&e.gcode, &e.tools);
        assert!(!base.moves.is_empty(), "the reference program recorded no moves at all");
        let deepest = |p: &ProgramRead| {
            p.moves
                .iter()
                .map(|m| m.to.2.min(m.from.2))
                .fold(f64::INFINITY, f64::min)
        };

        for tail in [
            "G1 X20 Y0 ( a ( b ) Z-999 )",
            "G1 X20 Y0 ; Z-999",
            "G1 X20 Y0 ( c ) ( Z-999 )",
        ] {
            let got = read_program(&format!("{}{tail}\n", e.gcode), &e.tools);
            assert_eq!(
                got.moves.len(),
                base.moves.len() + 1,
                "{tail:?} — comment text was scanned as code"
            );
            assert!(
                (deepest(&got) - deepest(&base)).abs() < 1e-9,
                "{tail:?} — a Z inside a comment reached a MOVE: {} vs {}",
                deepest(&got),
                deepest(&base)
            );
        }

        // ...and the code either side of a comment still survives.
        let kept = read_program(&format!("{}G1 X20 ( c ) Y7\n", e.gcode), &e.tools);
        assert!(
            kept.moves.last().is_some_and(|m| (m.to.1 - 7.0).abs() < 1e-9),
            "the code after a comment was lost: {:?}",
            kept.moves.last().map(|m| m.to)
        );
    }

    #[test]
    fn an_unmodelled_construct_is_named_once_however_many_blocks_contain_it() {
        // Every block carries the marker 777 so a message that kept the raw
        // block text is visible as such, whatever else changes about it.
        let program = |blocks: usize| {
            let mut g = String::new();
            for i in 0..blocks {
                let n = i as f64;
                g.push_str(&format!("G1 X{n}.0 Y777.0 F600\n"));
                g.push_str(&format!("G1 X Y777.0 (a word with no value)\n"));
                g.push_str(&format!("G10 L2 P1 X{n}.0 Y777.0\n"));
                g.push_str(&format!("G5 X{n}.0 Y777.0\n"));
                g.push_str(&format!("G2 X{n}.0 Y777.0 R5.0\n"));
            }
            g
        };
        let few = read_program(&program(5), &[]);
        let many = read_program(&program(500), &[]);

        assert_eq!(
            few.unread, many.unread,
            "the same constructs read differently at 5 blocks and at 500, so a finding is being \
             reported per BLOCK rather than per CONSTRUCT: {} vs {} entries",
            few.unread.len(),
            many.unread.len()
        );
        assert!(
            many.unread.len() <= UNREAD_CAP,
            "{} unread entries — every one of them becomes a pending line an operator reads: {:?}",
            many.unread.len(),
            many.unread
        );
        assert!(
            many.unread.iter().all(|u| !u.contains("777")),
            "an unread entry carries the block it was found in, which is what makes it unique per \
             line and uncollapsible: {:?}",
            many.unread
        );

        // The distinctions the cap must not cost.
        for needle in [
            "could not parse",                       // a word with no value
            "G10 in a form this reader does not model",
            "G5 is a code this reader does not model", // the NUMBER survives
            "an arc given by R rather than I/J",
        ] {
            assert!(
                many.unread.iter().any(|u| u.contains(needle)),
                "collapsing the entries lost the finding `{needle}`: {:?}",
                many.unread
            );
        }
    }
}

