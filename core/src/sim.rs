//! Material-removal simulation.
//!
//! A height map of the workpiece, swept by the tool along every cutting move. It
//! answers the question no dialect check can: **did the program cut the right
//! material away, and only that material?**
//!
//! # Honest about resolution
//!
//! This is a Z-map, not a solid model. It cannot see undercuts (a 2.5D router
//! makes none), and a feature narrower than the cell size is below its
//! resolution. `cell_mm` is therefore reported with every result, and a gouge
//! smaller than one cell is invisible — which is why the simulation is one
//! check among several and not the only one.
//!
//! # 🔴 There is no single "safe direction", and this file claimed there was
//!
//! *(Measured 2026-08-09 against the analytic swept region; the numbers are in
//! [`docs/sim-resolution.md`](../../docs/sim-resolution.md) and the assertions
//! are in [`precision_tests`].)*
//!
//! The two finding classes want **opposite** errors, so an approximation that is
//! conservative for one is anti-conservative for the other:
//!
//! | error | [`SimFinding::Gouge`] | [`SimFinding::Uncut`] |
//! |---|---|---|
//! | over-report removal | false alarm — **safe** | the standing island reads as cleared — **MISSED** |
//! | under-report removal | the gouge reads as untouched — **MISSED** | false alarm — **safe** |
//!
//! ⚠ The `simulate` doc below asserted the opposite for a year: *"over-reporting
//! removal means a missed island is still caught"*. It does not. Over-reporting
//! removal is exactly what hides an island, because [`check`] fires `Uncut` on
//! material **still standing** and over-reported removal is material reported
//! **gone**. The sentence was a rationale nobody re-derived, attached to a
//! modelling choice (flat cylinder for every cutter) that is genuinely
//! conservative — for gouges only.
//!
//! # What the grid actually does, measured
//!
//! * **At the simulation's own cell the map is a POINT SAMPLE of the true swept
//!   region, and therefore an INNER approximation — it does not over-report.**
//!   A sample is lowered only if the tool centre passed within `radius` of that
//!   exact point, so the sim never marks material the tool did not reach:
//!   **0 false positives** over 192 straight cuts spanning cells 0.3–3.0 mm,
//!   radii 1.5/3.0 mm, two headings and every sub-cell offset.
//! * **It can MISS removal, but only in a sliver at the very edge of the cut.**
//!   The sweep is stamped at discrete points `cell/2` apart, so a sample within
//!   `radius` of the *path* but not within `radius` of any *stamp* is missed.
//!   That sliver is bounded by [`edge_miss_mm`] — 0.0038 mm at the default
//!   0.6 mm cell, 0.20 mm at a 3 mm cell. It never reaches the interior of a
//!   cut, which is why a gouge deeper than a hair is still seen.
//! * **The OVERSIZE, square-cornered surface an operator sees is produced
//!   downstream, by the display reduction**, not here — see
//!   `fixtures::stock_surface_of`, which takes the deepest sample of each
//!   `k x k` block. That step is a strict dilation and is the one place the
//!   "never shallower, never smaller" claim actually holds.

use crate::geometry::Contour;
use crate::types::{MoveKind, Toolpath, Vec3};

pub struct HeightMap {
    pub cols: usize,
    pub rows: usize,
    pub cell_mm: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    /// Surface height per cell, measured from the workpiece top: `0.0` = uncut,
    /// negative = material removed to that depth.
    pub z: Vec<f32>,
}

impl HeightMap {
    /// A map covering `size_x` x `size_y` with its lower-left corner at
    /// `origin_x, origin_y` in MACHINE coordinates.
    ///
    /// 🔴 The origin used to be hardcoded to `0,0` while the toolpath handed in
    /// was PLACED — offset by the workpiece datum. `cut()` clamps out-of-range
    /// indices, so a displaced cut was smeared onto the edge column instead of
    /// falling outside the map, and the gouge check compared a placed path
    /// against unplaced regions. Measured on the `plate` fixture: 0 gouges at
    /// datum 0, **1027 at datum 150**, and **0 again at datum 300** — where the
    /// path and the regions had stopped overlapping entirely, so the check had
    /// nothing to compare and returned a green it never earned.
    ///
    /// ⚠ The 0 is the dangerous one, not the 1027. A false red announces
    /// itself; a vacuous green looks exactly like a clean part.
    pub fn new(size_x: f64, size_y: f64, cell_mm: f64, origin_x: f64, origin_y: f64) -> Self {
        let cell = cell_mm.max(0.1);
        let cols = (size_x / cell).ceil() as usize + 1;
        let rows = (size_y / cell).ceil() as usize + 1;
        Self { cols, rows, cell_mm: cell, origin_x, origin_y, z: vec![0.0; cols * rows] }
    }

    #[inline]
    pub fn at(&self, c: usize, r: usize) -> f32 {
        self.z[r * self.cols + c]
    }

    pub fn world_of(&self, c: usize, r: usize) -> (f64, f64) {
        (self.origin_x + c as f64 * self.cell_mm, self.origin_y + r as f64 * self.cell_mm)
    }

    /// Lower every cell within `radius` of (x, y) to `depth`, never raising one.
    /// Material does not come back.
    fn stamp(&mut self, x: f64, y: f64, radius: f64, depth: f64) {
        let cell = self.cell_mm;
        let c0 = (((x - radius - self.origin_x) / cell).floor()).max(0.0) as usize;
        let r0 = (((y - radius - self.origin_y) / cell).floor()).max(0.0) as usize;
        let c1 = ((((x + radius - self.origin_x) / cell).ceil()) as usize).min(self.cols - 1);
        let r1 = ((((y + radius - self.origin_y) / cell).ceil()) as usize).min(self.rows - 1);
        let r2 = radius * radius;
        for r in r0..=r1 {
            for c in c0..=c1 {
                let (wx, wy) = self.world_of(c, r);
                if (wx - x).powi(2) + (wy - y).powi(2) <= r2 {
                    let i = r * self.cols + c;
                    if (depth as f32) < self.z[i] {
                        self.z[i] = depth as f32;
                    }
                }
            }
        }
    }
}

/// Flatten an arc segment into points fine enough for the sim's cell size.
fn arc_points(from: Vec3, to: Vec3, cx: f64, cy: f64, cw: bool, step: f64) -> Vec<Vec3> {
    let r = ((from.x - cx).powi(2) + (from.y - cy).powi(2)).sqrt();
    let a0 = (from.y - cy).atan2(from.x - cx);
    let a1 = (to.y - cy).atan2(to.x - cx);
    let mut sweep = a1 - a0;
    // Normalise into the direction the arc actually travels.
    if cw {
        while sweep > 0.0 {
            sweep -= std::f64::consts::TAU;
        }
    } else {
        while sweep < 0.0 {
            sweep += std::f64::consts::TAU;
        }
    }
    let arc_len = (r * sweep).abs();
    let n = ((arc_len / step).ceil() as usize).max(1);
    (1..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            let a = a0 + sweep * t;
            Vec3::new(cx + r * a.cos(), cy + r * a.sin(), from.z + (to.z - from.z) * t)
        })
        .collect()
}

/// Sweep the toolpath through a block of workpiece material.
///
/// The tool is modelled as a flat cylinder of `tool_r`. A ball nose or V-bit
/// removes LESS than this at a given depth, so for those the model over-reports
/// removal.
///
/// 🔴 **That is conservative for [`SimFinding::Gouge`] and anti-conservative for
/// [`SimFinding::Uncut`]** — see the table in the module header. This paragraph
/// used to say over-reporting removal meant *"a missed island is still caught"*,
/// which is backwards: an island reported as removed is an island the `Uncut`
/// check does not fire on. Say which finding a direction is safe for, or the
/// sentence is worse than no sentence.
///
/// ⚠ **The grid itself does not over-report.** Every sample is lowered only if
/// the tool centre passed within `radius` of that exact point, so the map is an
/// inner approximation of the true swept region — never an outer one. The
/// oversize surface an operator sees comes from the display reduction, not from
/// here. `precision_tests` holds the measurement.
pub fn simulate(
    path: &Toolpath,
    tool_r: f64,
    size_x: f64,
    size_y: f64,
    cell_mm: f64,
    origin_x: f64,
    origin_y: f64,
) -> HeightMap {
    let mut hm = HeightMap::new(size_x, size_y, cell_mm, origin_x, origin_y);
    // 🔴 Through the shared helper, never a local expression: `edge_miss_mm`
    // states a bound that is only true while it and this line agree, and two
    // copies of the same constant is how a stated precision quietly stops
    // describing the thing it is printed next to.
    let step = stamp_step_mm(cell_mm);
    // Per-move radius where the planner stamped one; the toolpath's tool only as
    // a fallback for paths built before stamping existed.
    let radius_of = |m: &crate::types::Move| if m.tool_r_mm > 0.0 { m.tool_r_mm } else { tool_r };
    let mut cur: Option<Vec3> = None;

    for m in &path.moves {
        match m.kind {
            MoveKind::Rapid => cur = Some(m.to),
            MoveKind::Feed => {
                if let Some(p) = cur {
                    let d = ((m.to.x - p.x).powi(2) + (m.to.y - p.y).powi(2)).sqrt();
                    let n = ((d / step).ceil() as usize).max(1);
                    for i in 0..=n {
                        let t = i as f64 / n as f64;
                        hm.stamp(
                            p.x + (m.to.x - p.x) * t,
                            p.y + (m.to.y - p.y) * t,
                            radius_of(m),
                            p.z + (m.to.z - p.z) * t,
                        );
                    }
                } else {
                    hm.stamp(m.to.x, m.to.y, radius_of(m), m.to.z);
                }
                cur = Some(m.to);
            }
            MoveKind::ArcCW | MoveKind::ArcCCW => {
                if let Some(p) = cur {
                    for q in arc_points(p, m.to, m.centre.x, m.centre.y, m.kind == MoveKind::ArcCW, step) {
                        hm.stamp(q.x, q.y, radius_of(m), q.z);
                    }
                }
                cur = Some(m.to);
            }
            MoveKind::DrillCycle => {
                hm.stamp(m.to.x, m.to.y, radius_of(m), m.to.z);
                cur = Some(Vec3::new(m.to.x, m.to.y, 0.0));
            }
            _ => {}
        }
    }
    hm
}

/// The spacing at which [`simulate`] stamps the tool along a move.
///
/// Public because [`edge_miss_mm`] is only true while it matches what
/// `simulate` does, and a constant copied into a doc comment is the classic way
/// for the two to drift apart without a diff.
#[inline]
pub fn stamp_step_mm(cell_mm: f64) -> f64 {
    (cell_mm.max(0.1) * 0.5).max(0.05)
}

/// How far INSIDE the true swept band this simulation can fail to see removal.
///
/// The sweep is stamped at points [`stamp_step_mm`] apart, so the union of the
/// stamped discs scallops between them. A sample at perpendicular distance `p`
/// from the path has its nearest stamp at most `step/2` away along the path, so
/// it is stamped whenever `p^2 + (step/2)^2 <= r^2` — and the deepest a missed
/// sample can lie inside the band is
///
/// ```text
///     r - sqrt(r^2 - (step/2)^2)
/// ```
///
/// This is the ONLY way the raw height map under-reports removal, and it is
/// bounded, which is the whole reason to state it: an unbounded under-report
/// could hide a gouge, and this one cannot hide anything thicker than the
/// number it returns. Measured against the analytic swept region in
/// [`precision_tests::a_missed_sample_lies_only_at_the_very_edge_of_the_cut`].
///
/// Returns `0.0` for a degenerate radius rather than a NaN — a precision figure
/// that comes back NaN is a figure nobody can put in front of an operator.
pub fn edge_miss_mm(tool_r_mm: f64, cell_mm: f64) -> f64 {
    let half = stamp_step_mm(cell_mm) * 0.5;
    if !(tool_r_mm > 0.0) || !tool_r_mm.is_finite() {
        return 0.0;
    }
    tool_r_mm - (tool_r_mm * tool_r_mm - half * half).max(0.0).sqrt()
}

/// What the simulation's own resolution does to the numbers it reports.
///
/// 🔴 This exists because the counts were shipping without it. `gouge`,
/// `uncut` and `spoilboard` are cell counts at a resolution the operator chose,
/// with an error whose DIRECTION is different for each of them, and a bare
/// integer reads as a measurement. Everything here is derived from the two cell
/// sizes and the smallest tool in the job — nothing is a stored opinion.
#[derive(Clone, Debug, PartialEq)]
pub struct Precision {
    /// The cell the simulation itself ran at.
    pub sim_cell_mm: f64,
    /// The cell the drawn surface was reduced to, if one was asked for. `None`
    /// means no surface was emitted, not that it was drawn at `sim_cell_mm`.
    pub display_cell_mm: Option<f64>,
    /// Radius of the SMALLEST cutter in the job — the worst case, because the
    /// edge sliver and the "narrower than a cell" blindness both bite hardest
    /// on the smallest feature.
    pub smallest_tool_r_mm: f64,
}

impl Precision {
    pub fn new(sim_cell_mm: f64, display_cell_mm: Option<f64>, smallest_tool_r_mm: f64) -> Self {
        Self { sim_cell_mm, display_cell_mm, smallest_tool_r_mm }
    }

    /// See [`edge_miss_mm`].
    pub fn edge_miss_mm(&self) -> f64 {
        edge_miss_mm(self.smallest_tool_r_mm, self.sim_cell_mm)
    }

    /// The most a drawn feature can exceed its true size, total across both
    /// sides, once the map is reduced to `display_cell_mm`.
    ///
    /// A sim cell of `s` reduced to a display cell of `d = k*s` is drawn as
    /// whole display cells, and the block containing a removed sample can begin
    /// up to `d - s` before it — on both sides. `None` when nothing was reduced.
    pub fn display_widening_mm(&self) -> Option<f64> {
        let d = self.display_cell_mm?;
        if d <= self.sim_cell_mm {
            return Some(0.0);
        }
        let k = (d / self.sim_cell_mm).round().max(1.0);
        let true_d = self.sim_cell_mm * k;
        Some(2.0 * (true_d - self.sim_cell_mm))
    }

    /// The sentence that must ride with the DRAWN surface — the answer to both
    /// halves of TODO #46, in the operator's own words.
    ///
    /// 🔴 Two complaints, one note, because they have one cause between them:
    /// the surface is a coarse single-valued Z-map. It comes out **oversize and
    /// square-cornered**, and a through hole in it is a **pit**, not a hole.
    /// `None` when no surface was reduced — a warning about a picture nobody
    /// drew is noise, and noise is what gets a real warning muted.
    pub fn surface_note(&self) -> Option<String> {
        let d = self.display_cell_mm?;
        let w = self.display_widening_mm()?;
        if w <= 0.0 {
            return None;
        }
        Some(format!(
            "the DRAWN surface is coarser still, at {d}mm cells taken as the deepest sample of each block: it \
             reads OVERSIZE by up to {w:.1}mm and its corners are the CELL GRID, not the cutter — a round hole \
             comes out square-cornered and larger than it is. Measured: a 6.0mm hole draws 9.0mm wide at a \
             3.0mm display cell over a 0.6mm simulation. Do not measure a feature off it. And a through cut is \
             drawn as a PIT whose floor sits at the underside of the workpiece, not as an opening: a height map \
             holds one surface per cell and cannot say \"no material here\", only \"removed down to here\""
        ))
    }

    /// The sentences to put in front of whoever reads the counts.
    ///
    /// 🔴 They are built in the CORE, not in a UI, so the wording travels with
    /// the data to every host — CLI, browser and gate alike. A precision caveat
    /// that lives in one renderer is absent from every other consumer, and the
    /// consumer that lacks it cannot tell that it is missing.
    pub fn notes(&self) -> Vec<String> {
        let s = self.sim_cell_mm;
        let mut out = vec![format!(
            "the simulation is a height map at {s}mm cells: gouge/uncut/spoilboard are COUNTS OF CELLS at that \
             resolution, not measurements of the part"
        )];
        out.push(format!(
            "a feature narrower than {s}mm can fall between samples and be absent from the map — so an UNCUT \
             count of 0 is not proof the pocket cleared, and a GOUGE count of 0 is not proof nothing was hit"
        ));
        out.push(format!(
            "removal is missed only within {:.4}mm of the outer edge of a cut (smallest cutter r={:.3}mm at \
             {s}mm cells); the interior of a cut is never missed",
            self.edge_miss_mm(),
            self.smallest_tool_r_mm
        ));
        // One source for the wording, so the panel and the layer caption cannot
        // drift into saying different things about the same picture.
        out.extend(self.surface_note());
        out.push(
            "over-reporting removal is the SAFE error for a gouge and the UNSAFE one for an uncut island; \
             there is no single conservative direction here"
                .to_string(),
        );
        out
    }
}

/// Flatten a contour to a point ring for point-in-polygon tests.
fn ring(c: &Contour, step: f64) -> Vec<(f64, f64)> {
    let n = c.verts.len();
    if n < 2 {
        return Vec::new();
    }
    let mut pts = Vec::new();
    let last = if c.closed { n } else { n - 1 };
    for i in 0..last {
        let a = c.verts[i];
        let b = c.verts[(i + 1) % n];
        pts.push((a.x, a.y));
        if a.bulge.abs() > 1e-12 {
            // Re-derive the arc and walk it; a chord here would report points
            // just inside a curved boundary as outside.
            let theta = 4.0 * a.bulge.atan();
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let chord = (dx * dx + dy * dy).sqrt();
            if chord < 1e-12 {
                continue;
            }
            let r = chord / (2.0 * (theta / 2.0).sin());
            let (mx, my) = (a.x + dx * 0.5, a.y + dy * 0.5);
            let h = (r * r - chord * chord * 0.25).abs().sqrt();
            let (px, py) = (-dy / chord, dx / chord);
            let s = if theta.abs() > std::f64::consts::PI { -1.0 } else { 1.0 } * a.bulge.signum();
            let (cx, cy) = (mx + px * h * s, my + py * h * s);
            let a0 = (a.y - cy).atan2(a.x - cx);
            let steps = ((r.abs() * theta.abs() / step).ceil() as usize).max(2);
            for k in 1..steps {
                let ang = a0 + theta * (k as f64 / steps as f64);
                pts.push((cx + r.abs() * ang.cos(), cy + r.abs() * ang.sin()));
            }
        }
    }
    pts
}

fn point_in_ring(pts: &[(f64, f64)], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = pts.len();
    if n < 3 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = pts[i];
        let (xj, yj) = pts[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// **WHAT THE CUTTER REACHED** when it went below the underside of the workpiece.
///
/// 🔴 THE DISTINCTION THIS ENUM EXISTS FOR IS PHYSICAL, AND UNTIL 2026-08-10
/// THIS MODULE COULD NOT MAKE IT. [`check`] fired its spoilboard finding on
/// **depth alone** — `z < -(thickness + allowance)` — and had no idea where any
/// board was, so a normal sacrificial through-cut and a 2.2 kW spindle driving a
/// cutter into an aluminium extrusion produced the **same variant, the same
/// name and the same count**. A finding that cannot tell those apart is a
/// finding an operator learns to wave through, because most of the time it is
/// the harmless one.
///
/// The three states are three different facts and each gets its own sentence.
/// In particular [`SpoilboardUndeclared`](Self::SpoilboardUndeclared) is not a
/// midpoint between the other two: it is the absence of an answer, and it must
/// read as **UNCHECKED**, never as either verdict.
///
/// ⚠ **Why this rides as a FIELD on [`SimFinding::Spoilboard`] rather than as a
/// fourth variant.** `cli/src/main.rs` matches `SimFinding` **exhaustively with
/// no wildcard arm**; a new variant does not fail a test there, it fails the
/// **build**, and the CLI is the binary every gate drives. Adding a field to an
/// existing struct variant is source-compatible with `SimFinding::Spoilboard {
/// .. }`, so the counts and the harness keep working while the new class becomes
/// expressible.
///
/// ✅ **CLOSED 2026-08-11 — kept visible because a stale RED lies exactly like a
/// stale green.** This paragraph used to read *"the CLI's own `spoilboard=N`
/// line still CONFLATES the two … until it lands, read the classes off
/// [`crate::fixtures::SimCounts`]"*, and it was true only until
/// `cli/src/main.rs` grew `below_sheet_counts`. The summary line now carries
/// `below_sheet=over-spoilboard:N past-spoilboard-edge:N
/// spoilboard-undeclared:N` alongside the unchanged total, so the CLI no longer
/// conflates them and the redirection above is obsolete advice. ⚠ `spoilboard=N`
/// is deliberately **first and unchanged** — the gate harness reads
/// `/spoilboard=(\d+)/` off this stream — and the class fields use a **colon**
/// so `over-spoilboard:3` cannot alias `spoilboard=3`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BelowSheet {
    /// A spoilboard is declared **and this XY is over it**. Sacrificial and
    /// intended — this is what a through-cut is supposed to do.
    OverSpoilboard,
    /// A spoilboard is declared **and this XY is past its edge**. There is no
    /// sacrificial material here: the cutter is descending onto whatever the
    /// machine is built of — a rail, an extrusion, a T-slot, the frame.
    PastSpoilboardEdge,
    /// 🔴 **NOBODY DECLARED A SPOILBOARD.** Not "there is one", not "there is
    /// none". The depth was measured and the position was not, so this cell is
    /// **UNCHECKED** in the only dimension that separates a sacrificial pass
    /// from a strike on the frame.
    SpoilboardUndeclared,
}

impl BelowSheet {
    /// Is this the class that puts a cutter into the machine?
    pub fn is_strike_on_the_machine(&self) -> bool {
        matches!(self, BelowSheet::PastSpoilboardEdge)
    }

    /// A short, unambiguous name per class. Deliberately **not** the `Debug`
    /// spelling: a host keying on one of these must not be able to match another
    /// by prefix, and `Debug` is not a contract.
    pub fn as_str(&self) -> &'static str {
        match self {
            BelowSheet::OverSpoilboard => "over-spoilboard",
            BelowSheet::PastSpoilboardEdge => "past-spoilboard-edge",
            BelowSheet::SpoilboardUndeclared => "spoilboard-undeclared",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SimFinding {
    /// Material was removed from a region that had to remain.
    Gouge { x: f64, y: f64, depth_mm: f64 },
    /// Material that should have been removed is still standing.
    Uncut { x: f64, y: f64, standing_mm: f64 },
    /// The cutter went below the underside of the workpiece by more than the
    /// sacrificial allowance.
    ///
    /// 🔴 `below` says **what was underneath**, and it is the difference between
    /// an intended cut and a broken cutter. See [`BelowSheet`]. The variant name
    /// is unchanged so every existing consumer keeps counting the same total;
    /// the classes are separated in [`crate::fixtures::SimCounts`].
    Spoilboard { x: f64, y: f64, past_mm: f64, below: BelowSheet },
}

/// What the [`SimFinding::Uncut`] limb of [`check`] was actually able to EXAMINE.
///
/// # 🔴 Why a count needed a companion
///
/// `Uncut` fires only on cells inside a declared **removal region**, and for
/// most of this core's life nothing declared one: the set is populated in
/// exactly one place — the built-in `pocket` fixture — and every imported
/// drawing is built with `remove: Vec::new()`. So on 100% of real jobs the check
/// did not run, and the report said `uncut: 0`.
///
/// **`0` in a counter reads as PASS.** This lane's second duty is that *a check
/// that cannot run reports PENDING, never PASS* — and an integer cannot say
/// PENDING, because "nobody asked" and "asked and nothing was standing" are the
/// same three glyphs. This struct is the difference between them, and it travels
/// with the findings so no consumer can read one without the other.
///
/// # It counts the WORK, not the inputs
///
/// [`cells_tested`](Self::cells_tested) is incremented inside the scan loop, at
/// the cell, when a cell actually fell inside a removal ring. It is deliberately
/// **not** `remove.len()`: a region can be handed in and still test nothing —
/// dropped by the one-cell shrink, or sitting off the map entirely, which is the
/// exact shape of the datum defect [`HeightMap::new`] records (0 findings meaning
/// *"nothing overlapped"*, not *"nothing is wrong"*). Reading the input list
/// would have called both of those a measurement.
///
/// ⚠ It is conservative in the safe direction: cells that were consumed by the
/// spoilboard or keep branches before the removal test is reached are not
/// counted, so a region overlapping only those reports PENDING rather than
/// measured. For `Uncut`, over-reporting *pending* is the harmless error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UncutCoverage {
    /// Removal regions handed to [`check`] — the request, before any of it was
    /// tested. `0` is the case B4 named: no caller asked.
    pub regions_given: usize,
    /// Rings that survived the one-cell shrink **and** carry enough points for
    /// [`point_in_ring`] to answer. A ring with fewer cannot contain anything,
    /// and counting it would vouch for a test that never ran.
    pub rings_tested: usize,
    /// Map cells that fell inside one of those rings — the ones that could have
    /// produced an `Uncut` finding. This, not the region count, is what makes
    /// `uncut = 0` a measurement.
    pub cells_tested: usize,
    /// The floor the regions were judged against. `<= 0` disables the test
    /// outright.
    pub depth_mm: f64,
}

impl UncutCoverage {
    /// Did the `Uncut` check examine anything at all?
    ///
    /// `false` means the reported count is PENDING, whatever its value — and its
    /// value is always `0`, because a check that visits no cell finds nothing.
    pub fn ran(&self) -> bool {
        self.cells_tested > 0
    }

    /// Why it did not run, in the operator's words. `None` when it did.
    ///
    /// The branches are ordered from the outermost cause inward, so the sentence
    /// names the thing to fix rather than the last condition that happened to be
    /// false.
    pub fn why_not(&self) -> Option<String> {
        if self.ran() {
            return None;
        }
        Some(if self.regions_given == 0 {
            "no region on this job was declared as material that must be CLEARED, so there was \
             nothing for the check to test against. Every operation here cuts a BOUNDARY, and a \
             boundary cut is not a request to empty an area: an interior loop taken through the \
             workpiece drops its slug out, which is a correct program with nothing left standing"
                .to_string()
        } else if !(self.depth_mm > 0.0) {
            format!(
                "{} region(s) were declared as material to be cleared, against a floor of \
                 {:.3}mm — with no depth asked for there is nothing to judge a floor against",
                self.regions_given, self.depth_mm
            )
        } else if self.rings_tested == 0 {
            format!(
                "all {} declared removal region(s) were narrower than one simulation cell and \
                 were dropped: at this resolution the check cannot tell their inside from their \
                 boundary. Simulate at a finer cell, or accept that this feature is below the \
                 simulation",
                self.regions_given
            )
        } else {
            format!(
                "{} declared removal region(s) lie OUTSIDE the simulated area — not one map cell \
                 fell inside one, so the check compared nothing. That is the datum defect this \
                 module was built to refuse, arriving from the other side: no finding because \
                 nothing overlapped, not because nothing is wrong",
                self.regions_given
            )
        })
    }
}

/// What the **position** limb of the spoilboard check was able to examine.
///
/// # 🔴 Why the depth count needed a companion
///
/// The same shape as [`UncutCoverage`], for the same reason and one rung more
/// dangerous. `SimFinding::Spoilboard` fired on depth alone until 2026-08-10:
/// it knew the cutter had gone below the workpiece and **not what was under it**.
/// The count was real, so it never looked like a pending check — it looked like
/// a working one. And the missing half was the half that decides whether the
/// program is fine or the cutter is in an extrusion.
///
/// `declared == false` ⇒ **every** cell counted below the floor is
/// [`BelowSheet::SpoilboardUndeclared`], the position was never asked, and no
/// number here may be read as "it went into the spoilboard". It went **below the
/// workpiece**; where it landed is unknown.
///
/// # ⚠ What this limb cannot see even when it IS declared
///
/// The height map covers **the workpiece's footprint on the machine** and nothing
/// else ([`crate::fixtures::simulate_and_check_with_coverage`] builds it from
/// the placed workpiece), so a cutting move that leaves the workpiece entirely — a lead
/// that overshoots, a ramp run off the edge — is not in the map and is not
/// judged here. The case this limb DOES see is the physical one that motivated
/// it: **a workpiece that overhangs the spoilboard**, where the program cuts through
/// at an XY the board does not reach. Stated rather than implied, because a
/// coverage struct that overstates its own reach is the defect it exists to
/// prevent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpoilboardCoverage {
    /// Was a spoilboard declared at all — size AND position?
    pub declared: bool,
    /// Cells that went below the underside of the workpiece by more than the
    /// allowance, all classes. This is the number that has always been reported.
    pub cells_below_floor: usize,
    /// Of those, the ones at an XY the declared board does **not** cover.
    /// Always `0` when `declared == false`, because the question was never
    /// asked — and `0` there is PENDING, not clean.
    pub cells_past_edge: usize,
}

impl SpoilboardCoverage {
    /// Did the POSITION limb run? `false` ⇒ `cells_past_edge` is **PENDING**.
    pub fn ran(&self) -> bool {
        self.declared
    }

    /// Why it did not run, in the operator's words. `None` when it did.
    ///
    /// ⚠ **It answers even when nothing went below the workpiece, and that is
    /// deliberate.** "No board is declared" is a fact about the SETUP, not about
    /// this program, and the caller warns on every export for the same reason
    /// [`crate::fixture::FixtureFinding::Undeclared`] does: *"nothing declared"
    /// and "verified clear" are different facts, and only one of them is safe*.
    /// A silence that appears only on jobs that already went deep would tell the
    /// operator nothing on the run where they still had time to bolt the board
    /// down.
    pub fn why_not(&self) -> Option<String> {
        if self.ran() {
            return None;
        }
        let measured = if self.cells_below_floor == 0 {
            "nothing on this program went below the underside of the workpiece, so nothing needed \
             judging today — but the same program on a workpiece laid past the board's edge would \
             not have been judged either"
                .to_string()
        } else {
            format!(
                "the {} cell(s) that went below the underside of the workpiece were judged on DEPTH \
                 ALONE — the check knows the cutter went past the workpiece and NOT what was under \
                 it when it did",
                self.cells_below_floor
            )
        };
        Some(format!(
            "no spoilboard is declared on this machine, so {measured}. An absent spoilboard is \
             not a spoilboard covering the whole travel envelope — those are different facts and \
             only one of them is safe: over the board a through-cut is sacrificial and intended, \
             past its edge the same cut is a cutter descending into the machine's own frame, and \
             with nothing declared they read identically. Declare the board's SIZE and its \
             POSITION on the machine and this becomes an answer instead of an assumption"
        ))
    }

    /// The sentence for cells that reached bare machine. `None` when there are
    /// none — including when nobody asked, which [`why_not`](Self::why_not)
    /// covers instead.
    pub fn strike_note(&self, board: &str, first: Option<(f64, f64, f64)>) -> Option<String> {
        if self.cells_past_edge == 0 {
            return None;
        }
        let where_ = match first {
            Some((x, y, past)) => {
                format!(" First at X{x:.1} Y{y:.1}, {past:.2}mm below the underside of the workpiece.")
            }
            None => String::new(),
        };
        Some(format!(
            "🔴 PAST THE EDGE OF THE SPOILBOARD — {} of the {} below-the-workpiece cell(s) are at an \
             XY that the declared board '{board}' does NOT cover. A through-cut over the \
             spoilboard is intended and sacrificial; the same cut past its edge has no \
             sacrificial material under it at all, so the whole of it is cutter descending onto \
             whatever is there — a rail, an extrusion, a T-slot, the frame. ⚠ This core knows \
             only that NO DECLARED BOARD covers these points; it cannot see what does, and \
             'probably fresh air' is a guess about a machine it has never looked at. Note the \
             depths are small BY CONSTRUCTION: the planner clamps a through-cut to the workpiece \
             plus the sacrificial allowance, and off the board that allowance is spent in \
             metal.{where_} Move the workpiece onto the board, declare the board this machine really \
             has, or do not cut through here.",
            self.cells_past_edge, self.cells_below_floor
        ))
    }
}

/// **DID THE CUTTER GO THROUGH THE BOARD?** — the DEPTH limb of the spoilboard
/// check, and a different question from [`SpoilboardCoverage`]'s.
///
/// # 🔴 Two limbs, and they must not be allowed to blur
///
/// | limb | asks | answered by |
/// |---|---|---|
/// | **position** | is there a board under this XY at all? | [`SpoilboardCoverage`] / [`BelowSheet`] |
/// | **depth** (this) | the board is under here — did the cut go PAST ITS UNDERSIDE? | this struct |
///
/// They are orthogonal and each has its own PENDING state, because **a job can
/// be over the board with an unknown thickness, or past the board's edge with a
/// perfectly known one**. A single blurred verdict would hide half of each: an
/// operator told "spoilboard: checked" would not know which half ran. That is
/// also why this is **not** a fourth [`BelowSheet`] variant — a cell that is
/// `OverSpoilboard` *and* through the board would have to pick one of the two
/// facts to report, and picking is how the position limb's own defect
/// (`through-cut` and `into the frame` sharing a name) happened in the first
/// place.
///
/// # What this limb needs, and why it usually cannot run yet
///
/// It needs [`crate::types::Spoilboard::thickness_mm`], and **absent means
/// UNKNOWN, not "thick enough"**. With no thickness there is no underside, and
/// with no underside the honest answer is [`why_not`](Self::why_not) — never a
/// clean `0`. This is the third counter in this module to be given a companion
/// for the same reason (`uncut` was the first, `past_spoilboard_edge` the
/// second): **`0` in an integer reads as PASS**, and "nobody asked" and "asked
/// and nothing happened" are the same three glyphs.
///
/// # ⚠ What it does not see
///
/// * **Cells past the board's edge are NOT counted here at all.** There is no
///   board under them, so "through the board" is not a question about them —
///   the position limb has already reported them as a strike on the machine.
///   Counting them in both places would double-report one cell as two hazards.
/// * Anything between the workpiece and the board — packers, a sub-board, a vacuum
///   jig — moves the real underside **up**, toward the cutter, and this core
///   cannot see it. See [`crate::types::Spoilboard::top_face_z_mm`].
/// * The same footprint limit [`SpoilboardCoverage`] has: the height map covers
///   the workpiece's footprint, so a move that leaves the workpiece entirely is not in
///   the map and is not judged here either.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpoilboardDepth {
    /// Was a usable board RECTANGLE declared? `false` ⇒ there is nothing for a
    /// thickness to be the thickness *of*.
    pub board_declared: bool,
    /// The thickness exactly as declared — including a value that is present and
    /// unusable, which is a different fact from never having said.
    /// 🔴 `None` is **UNKNOWN**, not "thick enough".
    pub declared_thickness_mm: Option<f64>,
    /// The board's underside in the map's Z frame (`z = 0` at the workpiece top).
    /// `Some` **iff** this limb had a floor to compare against.
    pub underside_z_mm: Option<f64>,
    /// Map cells OVER the declared board whose depth was actually compared
    /// against that underside. Counted at the cell, like
    /// [`UncutCoverage::cells_tested`] and for the same reason: a declared board
    /// that no simulated cell lies over has tested nothing, and reading the
    /// declaration instead of the work would call that a measurement.
    pub cells_tested: usize,
    /// 🔴 Of those, the cells that went **past the underside** — cutter below
    /// the board, in whatever the machine is built of.
    pub cells_through_board: usize,
    /// The deepest of them, measured **from the board's underside** so one
    /// number means one thing. `0.0` when there are none.
    pub deepest_past_underside_mm: f64,
    /// The first such cell — `(x, y, mm past the underside)` — so the operator
    /// has somewhere to go and look.
    pub first_through: Option<(f64, f64, f64)>,
}

/// The three states of the depth limb, named so a host cannot render two of them
/// the same way.
///
/// 🔴 [`Unknown`](Self::Unknown) is **not** a midpoint between the other two and
/// must never be drawn as one — it is the absence of an answer. Same rule as
/// [`BelowSheet::SpoilboardUndeclared`], and it is here because the browser has
/// to paint a board whose thickness nobody declared, and painting it as a slab
/// of some plausible depth would assert a measurement nobody made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoardDepth {
    /// PENDING. The limb could not run — see [`SpoilboardDepth::why_not`].
    Unknown,
    /// It ran, and nothing reached the board's underside.
    InsideBoard,
    /// 🔴 It ran, and the cutter went past the underside into the machine.
    ThroughBoard,
}

impl BoardDepth {
    /// A short, unambiguous name per state. Like [`BelowSheet::as_str`] these are
    /// deliberately not the `Debug` spelling, and deliberately not prefixes of
    /// one another.
    pub fn as_str(&self) -> &'static str {
        match self {
            BoardDepth::Unknown => "board-depth-unknown",
            BoardDepth::InsideBoard => "inside-board",
            BoardDepth::ThroughBoard => "through-board",
        }
    }
}

impl SpoilboardDepth {
    /// Did the depth limb run? `false` ⇒ [`cells_through_board`](Self::cells_through_board)
    /// is **PENDING**, and its value is always `0` because a limb with no floor
    /// compares nothing.
    ///
    /// It requires BOTH a floor and a cell that was tested against it — the
    /// `UncutCoverage` rule, not the `SpoilboardCoverage` one, because a
    /// perfectly declared board the workpiece does not overlap tests nothing and
    /// would otherwise report a clean zero.
    pub fn ran(&self) -> bool {
        self.underside_z_mm.is_some() && self.cells_tested > 0
    }

    /// The verdict, as one of three named states. Never `InsideBoard` when the
    /// limb did not run.
    pub fn verdict(&self) -> BoardDepth {
        if !self.ran() {
            BoardDepth::Unknown
        } else if self.cells_through_board > 0 {
            BoardDepth::ThroughBoard
        } else {
            BoardDepth::InsideBoard
        }
    }

    /// Why it did not run, in the operator's words. `None` when it did.
    ///
    /// Branches run from the outermost cause inward, so the sentence names the
    /// thing to fix rather than the last condition that happened to be false.
    ///
    /// ⚠ Like [`SpoilboardCoverage::why_not`] it answers **even when nothing on
    /// this program went deep**, and for the same reason: "this board's
    /// thickness is unknown" is a fact about the SETUP. A sentence that appeared
    /// only on jobs that had already gone through would arrive one job too late.
    pub fn why_not(&self) -> Option<String> {
        if self.ran() {
            return None;
        }
        Some(if !self.board_declared {
            "no spoilboard is declared on this machine, so it has no underside anywhere in Z and \
             'did the cutter go through the board' cannot be asked at all. This is the POSITION \
             limb's answer arriving at the depth limb: with no board, both are unchecked"
                .to_string()
        } else if self.declared_thickness_mm.is_none() {
            "🔴 THE DECLARED SPOILBOARD CARRIES NO THICKNESS, so this check has no floor and did \
             NOT run. Read that as UNKNOWN and never as 'thick enough' — an absent thickness is \
             exactly as consistent with a 6mm board a through-cut goes straight past as with a \
             32mm one it never reaches, and this core cannot tell them apart. A cut over the \
             board is reported as sacrificial and intended on that basis alone; whether it also \
             reached the machine UNDER the board is not known. Declare the board's thickness and \
             this becomes an answer"
                .to_string()
        } else {
            match self.declared_thickness_mm {
                Some(t) if !(t.is_finite() && t > 0.0) => format!(
                    "the declared spoilboard thickness of {t}mm is not a slab — somebody typed a \
                     thickness and this is not one. It is NOT treated as unknown-by-omission and \
                     it is NOT treated as thick enough: the check has no floor, so nothing on \
                     this job says whether a cut reached the machine under the board"
                ),
                _ => format!(
                    "the spoilboard is declared with a thickness, but NOT ONE SIMULATED CELL lies \
                     over it — the workpiece's footprint and the board do not overlap in the \
                     simulated area, so the check compared nothing. A depth limb with a floor and \
                     no cell to test against it is the datum defect arriving from the other side: \
                     {} cell(s) tested. Check the board's corner and the workpiece's origin are in \
                     the same frame",
                    self.cells_tested
                ),
            }
        })
    }

    /// The sentence for cells that went past the board's underside. `None` when
    /// there are none — including when nobody asked, which
    /// [`why_not`](Self::why_not) covers instead.
    pub fn through_note(&self, board: &str) -> Option<String> {
        if self.cells_through_board == 0 {
            return None;
        }
        let where_ = match self.first_through {
            Some((x, y, past)) => {
                format!(" First at X{x:.1} Y{y:.1}, {past:.2}mm past the underside.")
            }
            None => String::new(),
        };
        let thickness = match self.declared_thickness_mm {
            Some(t) => format!("{t}mm"),
            None => "(undeclared)".to_string(),
        };
        Some(format!(
            "🔴 THROUGH THE SPOILBOARD — {} of the {} cell(s) tested over the declared board \
             '{board}' ({thickness} thick) went PAST ITS UNDERSIDE, deepest {:.2}mm past. Under \
             the board is not sacrificial material: it is whatever the machine is built of — the \
             frame, a rail, a T-slot, the bolts holding the board down. A through-cut INTO the \
             spoilboard is what a through-cut is for; a cut through the WHOLE board is a 2.2 kW \
             spindle in the machine. ⚠ The thickness this was judged against is what was \
             DECLARED, and a spoilboard is dressed in service and gets thinner — if yours has \
             been resurfaced, the real underside is nearer than this.{where_} Cut shallower, put \
             a thicker board under the work, or measure the board you actually have.",
            self.cells_through_board, self.cells_tested, self.deepest_past_underside_mm
        ))
    }
}

/// [`check`]'s answer: the findings, and **what it was able to look at**.
///
/// 🔴 One struct rather than a bare `Vec` so the coverage cannot be dropped on
/// the floor by a caller who only wanted the counts. That is precisely how
/// `uncut: 0` shipped as a measurement for a year.
#[derive(Clone, Debug)]
pub struct SimCheck {
    pub findings: Vec<SimFinding>,
    /// See [`UncutCoverage`]. `ran() == false` ⇒ the `Uncut` count is **PENDING**,
    /// not zero-because-clean.
    pub uncut: UncutCoverage,
    /// See [`SpoilboardCoverage`]. `ran() == false` ⇒ the below-the-workpiece cells
    /// were judged on DEPTH ONLY and nothing here says what they reached.
    ///
    /// ⚠ This is the **POSITION** limb. *"Did the cut go through the board"* is
    /// [`board_depth`](Self::board_depth) and is a separate answer with a
    /// separate PENDING state — reading either as the other hides half of it.
    pub spoilboard: SpoilboardCoverage,
    /// See [`SpoilboardDepth`]. `ran() == false` ⇒ the board's thickness is
    /// **UNKNOWN** and nothing on this job says whether the cutter reached the
    /// machine underneath the board.
    pub board_depth: SpoilboardDepth,
}

/// Compare the simulated workpiece against what the job intended.
///
/// `keep` are regions that must survive intact (the parts). `remove` are
/// regions that must be gone to at least `remove_depth_mm`.
///
/// 🔴 Returns [`SimCheck`], not a bare finding list: an empty `remove` set makes
/// the `Uncut` limb unreachable, and the caller has to be able to tell that from
/// a clean result. See [`UncutCoverage`].
///
/// `spoilboard` is the sacrificial board **and where it is on the machine**, in
/// the same coordinate frame as `hm`'s origin — i.e. machine coordinates. `None`
/// means **nobody declared one**, and every below-the-floor cell is then
/// [`BelowSheet::SpoilboardUndeclared`]: the depth was measured, the position
/// was not, and [`SpoilboardCoverage::ran`] says so. It is deliberately NOT
/// defaulted to "a board covering the whole travel envelope" — that assumption
/// is what let a cut into the machine's frame report as a sacrificial pass.
pub fn check(
    hm: &HeightMap,
    keep: &[Contour],
    remove: &[Contour],
    remove_depth_mm: f64,
    stock_thickness_mm: f64,
    spoilboard_allowance_mm: f64,
    spoilboard: Option<&crate::types::Spoilboard>,
) -> SimCheck {
    let mut out = Vec::new();
    let step = hm.cell_mm;

    // 🔴 Shrink both region sets by one cell before testing.
    //
    // A profile cut is TANGENT to the boundary of the part it produces, and a
    // pocket's first pass is tangent to the pocket wall. At the boundary the
    // tool legitimately touches cells on both sides, so testing the region as
    // drawn reports the entire outline as a gouge and the entire pocket wall as
    // uncut. On a clean plate job that was 2,696 "gouges" and 25 "uncut" cells
    // — a check firing on every correct program, which is a check that gets
    // muted in a week.
    //
    // One cell is the honest tolerance: it is exactly the resolution below
    // which this simulation cannot distinguish "tangent" from "into".
    let shrink = |c: &Contour| -> Vec<Contour> {
        let r = c.offset(-step);
        if r.is_empty() {
            // A region narrower than one cell cannot be judged at this
            // resolution. Keeping it unshrunk would false-fire; dropping it
            // silently would hide a real region. It is dropped, and the caller
            // knows the cell size because it chose it.
            Vec::new()
        } else {
            r
        }
    };
    let keep_rings: Vec<Vec<(f64, f64)>> =
        keep.iter().flat_map(shrink).map(|c| ring(&c, step)).collect();
    let remove_rings: Vec<Vec<(f64, f64)>> =
        remove.iter().flat_map(shrink).map(|c| ring(&c, step)).collect();

    // 🔴 EVEN-ODD across ALL rings of a set, never `any()`.
    //
    // A region with holes comes back from the boolean as SEPARATE loops: one
    // outer boundary and one loop per hole. Asking "is the point inside ANY of
    // them" answers yes for a point in the middle of a hole — so a pocket that
    // was correctly subtracted from the keep region still read as material that
    // must survive, and the whole pocket reported as gouged (10,449 cells).
    // Counting containments and taking the parity is the standard
    // polygon-with-holes test and is what the loops actually mean.
    let inside = |rings: &[Vec<(f64, f64)>], x: f64, y: f64| -> bool {
        rings.iter().filter(|r| point_in_ring(r, x, y)).count() % 2 == 1
    };
    let floor = -(stock_thickness_mm + spoilboard_allowance_mm);

    // 🔴 The coverage of the `Uncut` limb, accumulated BY THE SCAN rather than
    // read off the arguments. `rings_tested` counts only rings `point_in_ring`
    // can actually answer for (`n < 3` returns false unconditionally), so a
    // degenerate loop cannot vouch for a test it could never have performed.
    let mut uncut = UncutCoverage {
        regions_given: remove.len(),
        rings_tested: remove_rings.iter().filter(|r| r.len() >= 3).count(),
        cells_tested: 0,
        depth_mm: remove_depth_mm,
    };

    // 🔴 A FAULTED DECLARATION IS TREATED AS AN ABSENT ONE, NOT AS A STRICT
    // BOARD. A zero-sized or non-finite rectangle answers `covers == false`
    // everywhere, which would report every legitimate through-cut as a strike on
    // the frame — a false red across a whole job, and a false red is how a real
    // one stops being read. The fault itself is reported by the caller
    // (`fixtures::report_of_with_surface`); here it simply means the position
    // question was not answerable, which is exactly what `declared: false` says.
    let board = spoilboard.filter(|b| b.faults().is_empty());
    let mut spoil = SpoilboardCoverage {
        declared: board.is_some(),
        cells_below_floor: 0,
        cells_past_edge: 0,
    };

    // 🔴 THE DEPTH LIMB'S FLOOR, RESOLVED ONCE AND ALLOWED TO BE ABSENT.
    //
    // `underside_z_mm` is `Some` only when a board is declared AND carries a
    // usable thickness. There is deliberately no `unwrap_or` here and no
    // fallback anywhere below it: a floor invented from the workpiece thickness, or
    // from the thickest board in the catalogue, would put a number nobody
    // measured in the one place that decides whether a cut reached the frame.
    // Absent stays absent, and `SpoilboardDepth::why_not` says so.
    let underside_z = board.and_then(|b| b.underside_z_mm(stock_thickness_mm));
    let mut depth = SpoilboardDepth {
        board_declared: board.is_some(),
        // The RAW declared value, not the usable one: "nobody said" and
        // "somebody said something that is not a thickness" are different facts
        // and `why_not` gives them different sentences.
        declared_thickness_mm: board.and_then(|b| b.thickness_mm),
        underside_z_mm: underside_z,
        cells_tested: 0,
        cells_through_board: 0,
        deepest_past_underside_mm: 0.0,
        first_through: None,
    };

    for r in 0..hm.rows {
        for c in 0..hm.cols {
            let z = hm.at(c, r) as f64;
            let (x, y) = hm.world_of(c, r);

            // 🔴 The class is decided HERE, at the cell, from the board's own
            // rectangle — never from the machine's travel, which is a MOTION
            // bound and not a material one. `hm.world_of` returns MACHINE
            // coordinates (the map carries the placed workpiece's origin), which is
            // the same frame the board is declared in; a workpiece-local comparison
            // here would answer about a board nobody has.
            let below = match board {
                None => BelowSheet::SpoilboardUndeclared,
                Some(b) if b.covers(x, y) => BelowSheet::OverSpoilboard,
                Some(_) => BelowSheet::PastSpoilboardEdge,
            };
            // ── DEPTH LIMB ──────────────────────────────────────────────────
            //
            // 🔴 EVALUATED BEFORE THE FLOOR TEST BELOW, AND INDEPENDENTLY OF IT.
            // The floor branch `continue`s, so anything placed after it is
            // invisible to exactly the cells that went deepest. It is also a
            // different question: the floor asks "past the WORKPIECE plus the
            // allowance", this asks "past the BOARD'S UNDERSIDE", and on a board
            // thinner than the allowance those are not even in the same order.
            //
            // ⚠ ONLY cells over the board are counted. Past the edge there is no
            // board to go through — the position limb has already reported that
            // cell as a strike on the machine, and counting it here as well
            // would render one hazard as two.
            if let Some(uz) = underside_z {
                if below == BelowSheet::OverSpoilboard {
                    // Counted at the cell, one line above the test it qualifies,
                    // so `cells_through_board == 0` cannot drift away from the
                    // question of whether anything was compared at all.
                    depth.cells_tested += 1;
                    if z < uz - 1e-6 {
                        depth.cells_through_board += 1;
                        let past = uz - z;
                        if past > depth.deepest_past_underside_mm {
                            depth.deepest_past_underside_mm = past;
                        }
                        if depth.first_through.is_none() {
                            depth.first_through = Some((x, y, past));
                        }
                    }
                }
            }

            // 🔴 THE ALLOWANCE IS A PROPERTY OF HAVING A SPOILBOARD, AND THIS IS
            // THE HALF THAT MAKES THE CHECK REACH REAL PROGRAMS.
            //
            // `SPOILBOARD_ALLOWANCE_MM` exists because a through-cut has to go a
            // few tenths past the underside for the part to release cleanly, and
            // those tenths land in **sacrificial material**. Past the board's
            // edge there is no sacrificial material, so there is nothing for the
            // allowance to be spent in and it is **zero**.
            //
            // That is not a refinement, it is what makes this limb reachable at
            // all: `crate::toolpath` CLAMPS every profile to
            // `thickness + 0.3` — exactly the floor below — so a planned program
            // can never trip the depth-only test, and `sim.spoilboard` is `0` on
            // every reference fixture for that reason. With the allowance
            // removed off the board, an ORDINARY through-cut on a workpiece that
            // overhangs its spoilboard reports 0.3mm of cutter into whatever is
            // under there, which is precisely the case that has always been
            // silent.
            let floor_here = if below == BelowSheet::PastSpoilboardEdge {
                -stock_thickness_mm
            } else {
                floor
            };
            if z < floor_here - 1e-6 {
                spoil.cells_below_floor += 1;
                if below == BelowSheet::PastSpoilboardEdge {
                    spoil.cells_past_edge += 1;
                }
                out.push(SimFinding::Spoilboard {
                    x,
                    y,
                    // Measured from the UNDERSIDE OF THE WORKPIECE in every class,
                    // so one number means one thing. Off the board every
                    // millimetre of it is in the machine; over the board the
                    // first `allowance` of it is intended.
                    past_mm: -z - stock_thickness_mm,
                    below,
                });
                continue;
            }
            // A cell inside a keep region must be untouched. The tolerance is
            // one cell of depth: a cutter tangent to the boundary clips the
            // edge cell by construction, and reporting that would drown the
            // real findings.
            if z < -1e-6 && inside(&keep_rings, x, y) {
                if z < -hm.cell_mm {
                    out.push(SimFinding::Gouge { x, y, depth_mm: -z });
                }
                continue;
            }
            if remove_depth_mm > 0.0 && inside(&remove_rings, x, y) {
                // Counted HERE, at the cell that could have produced a finding.
                // One line above the test it qualifies, so the two cannot drift.
                uncut.cells_tested += 1;
                let standing = remove_depth_mm + z; // z is negative
                if standing > hm.cell_mm {
                    out.push(SimFinding::Uncut { x, y, standing_mm: standing });
                }
            }
        }
    }
    SimCheck { findings: out, uncut, spoilboard: spoil, board_depth: depth }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Contour;
    use crate::types::{Move, Tool, Toolpath};

    fn path(moves: Vec<Move>) -> Toolpath {
        let mut p = Toolpath { moves, tool: Tool::default(), ..Default::default() };
        p.recompute_bounds();
        p
    }

    #[test]
    fn a_straight_cut_removes_a_slot_of_the_tool_width() {
        // Plunge first, THEN cut flat. An earlier version of this test fed
        // straight from Z+5 to Z-5 across the whole span, so the midpoint was
        // legitimately at Z0 and the test read that as "not cut". The sim was
        // right and the fixture was wrong — a linear feed IS a ramp.
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -5.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -5.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        // On the centreline, cut.
        let c = (50.0 / 0.5) as usize;
        let r = (50.0 / 0.5) as usize;
        assert!(hm.at(c, r) < -4.0, "centreline not cut: {}", hm.at(c, r));
        // 4mm off the centreline with a 3mm radius tool, untouched.
        let r_off = ((50.0 + 4.0) / 0.5) as usize;
        assert!(hm.at(c, r_off) > -1e-6, "cut wider than the tool: {}", hm.at(c, r_off));
    }

    #[test]
    fn material_never_comes_back() {
        // A later shallow pass over a deep one must not raise the floor.
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -10.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -10.0), 1000.0),
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -2.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -2.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let c = (50.0 / 0.5) as usize;
        assert!(hm.at(c, c) < -9.0, "a shallow pass healed a deep cut: {}", hm.at(c, c));
    }

    #[test]
    fn a_rapid_removes_nothing() {
        // 🔴 If rapids cut in the model, every gouge check becomes noise and
        // gets muted. A rapid at negative Z is a different defect, caught by
        // the fixture and spoilboard checks, not by pretending it removes material.
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, -5.0)),
            Move::rapid(Vec3::new(90.0, 50.0, -5.0)),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        assert!(hm.z.iter().all(|z| *z > -1e-6), "a rapid removed material");
    }

    #[test]
    fn a_gouge_into_a_kept_part_is_found() {
        // 🔴 P9. The part is a 40x40 square that must survive; the program cuts
        // straight through the middle of it.
        let keep = Contour::rect(30.0, 30.0, 40.0, 40.0);
        let p = path(vec![
            Move::rapid(Vec3::new(0.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(0.0, 50.0, -5.0), 300.0),
            Move::feed_to(Vec3::new(100.0, 50.0, -5.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let found = check(&hm, &[keep], &[], 0.0, 18.0, 0.3, None).findings;
        assert!(
            found.iter().any(|f| matches!(f, SimFinding::Gouge { .. })),
            "a cut straight through the part was not reported"
        );
    }

    #[test]
    fn a_program_that_misses_the_part_reports_no_gouge() {
        // Negative control: without this, a check that always fires would look
        // like a working gouge detector.
        let keep = Contour::rect(30.0, 30.0, 40.0, 40.0);
        let p = path(vec![
            Move::rapid(Vec3::new(0.0, 90.0, 5.0)),
            Move::feed_to(Vec3::new(0.0, 90.0, -5.0), 300.0),
            Move::feed_to(Vec3::new(100.0, 90.0, -5.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let found = check(&hm, &[keep], &[], 0.0, 18.0, 0.3, None).findings;
        assert!(found.is_empty(), "clean program reported: {found:?}");
    }

    #[test]
    fn an_uncleared_pocket_is_found() {
        // 🔴 P2 seen from the other side: outline a pocket instead of clearing
        // it, and the simulation must see the island still standing.
        let pocket = Contour::rect(20.0, 20.0, 60.0, 60.0);
        // One lap only, around the inside of the boundary.
        let p = path(vec![
            Move::rapid(Vec3::new(23.0, 23.0, 5.0)),
            Move::feed_to(Vec3::new(23.0, 23.0, -5.0), 300.0),
            Move::feed_to(Vec3::new(77.0, 23.0, -5.0), 1000.0),
            Move::feed_to(Vec3::new(77.0, 77.0, -5.0), 1000.0),
            Move::feed_to(Vec3::new(23.0, 77.0, -5.0), 1000.0),
            Move::feed_to(Vec3::new(23.0, 23.0, -5.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let found = check(&hm, &[], &[pocket], 5.0, 18.0, 0.3, None).findings;
        assert!(
            found.iter().any(|f| matches!(f, SimFinding::Uncut { .. })),
            "the island left by an outlined pocket was not reported"
        );
    }

    #[test]
    fn cutting_into_the_spoilboard_is_found() {
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -25.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -25.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let found = check(&hm, &[], &[], 0.0, 18.0, 0.3, None).findings;
        assert!(found.iter().any(|f| matches!(f, SimFinding::Spoilboard { .. })));
    }

    // ── THE DEPTH LIMB: through the board, into the machine ─────────────────
    //
    // 🔴 EVERY TEST IN THIS BLOCK RUNS THE SAME PROGRAM. It plunges to Z-25 in
    // an 18mm workpiece — 7mm past the underside — and the ONLY thing that changes
    // between them is what board is declared under it. That is deliberate: if a
    // verdict moves when the program did not, the verdict is about the
    // declaration, which is exactly the fact this limb exists to report.

    /// The program used by the whole depth-limb block: 7mm past the underside
    /// of an 18mm workpiece, straight across the middle of the map.
    fn seven_mm_past_the_underside() -> HeightMap {
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -25.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -25.0), 1000.0),
        ]);
        simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0)
    }

    #[test]
    fn a_cut_through_a_declared_board_of_known_thickness_goes_red() {
        // 🔴 THE PLANT. A 6mm board under an 18mm workpiece puts the machine at
        // Z-24; this program reaches Z-25. That is a 2.2 kW spindle 1mm into
        // whatever the machine is made of, and until this limb existed it was
        // reported as an ordinary sacrificial through-cut — `OverSpoilboard`,
        // intended, green.
        use crate::types::Spoilboard;
        let hm = seven_mm_past_the_underside();
        let board = Spoilboard::new("thin mdf", 0.0, 0.0, 100.0, 100.0).with_thickness(6.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));

        assert!(r.board_depth.ran(), "the limb did not run with a thickness declared");
        assert_eq!(r.board_depth.verdict(), BoardDepth::ThroughBoard);
        assert!(
            r.board_depth.cells_through_board > 0,
            "a cut 1mm past a declared 6mm board reported nothing: {:?}",
            r.board_depth
        );
        assert_eq!(r.board_depth.underside_z_mm, Some(-24.0));
        // Measured FROM THE UNDERSIDE, so one number means one thing.
        let deepest = r.board_depth.deepest_past_underside_mm;
        assert!(
            (deepest - 1.0).abs() < 0.05,
            "1mm past a 6mm board under an 18mm workpiece, got {deepest}"
        );
        let note = r.board_depth.through_note("thin mdf").expect("a red must carry its sentence");
        assert!(note.contains("THROUGH THE SPOILBOARD"), "{note}");
        assert!(note.contains("thin mdf"), "the note must name the board: {note}");
        assert!(r.board_depth.why_not().is_none(), "a limb that ran must not also say why not");

        // ⚠ AND THE POSITION LIMB IS UNMOVED. The cut is over the board — it is
        // not past its edge — so the two limbs disagree about this program and
        // both are right. A single blurred verdict would have to pick one.
        assert!(r.spoilboard.ran());
        assert_eq!(
            r.spoilboard.cells_past_edge, 0,
            "the position limb was dragged red by a DEPTH finding"
        );
        for f in &r.findings {
            let SimFinding::Spoilboard { below, .. } = f else { continue };
            assert_eq!(*below, BelowSheet::OverSpoilboard, "{f:?}");
        }
    }

    #[test]
    fn the_same_plant_on_a_thicker_board_stays_green() {
        // 🔴 THE SPECIFICITY CONTROL, and it is the half that decides whether
        // the test above means anything. A check that fires on every job is
        // telling you about the harness, not about the machine. Identical
        // program, identical board rectangle, identical everything except a
        // 12mm slab instead of a 6mm one: the cutter stops 5mm inside the board,
        // which is what a spoilboard is FOR.
        use crate::types::Spoilboard;
        let hm = seven_mm_past_the_underside();
        let board = Spoilboard::new("thick mdf", 0.0, 0.0, 100.0, 100.0).with_thickness(12.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));

        assert!(r.board_depth.ran(), "the limb must RUN here — a green only counts if it ran");
        assert_eq!(r.board_depth.verdict(), BoardDepth::InsideBoard);
        assert_eq!(
            r.board_depth.cells_through_board, 0,
            "a cut 5mm short of the underside was called a strike on the machine"
        );
        assert!(r.board_depth.cells_tested > 0, "a green with nothing tested is not a green");
        assert!(r.board_depth.through_note("thick mdf").is_none());
        assert_eq!(r.board_depth.deepest_past_underside_mm, 0.0);

        // And the below-the-workpiece cells are still counted and still classified —
        // the depth limb going quiet does not silence the position limb.
        assert!(r.spoilboard.cells_below_floor > 0);
    }

    #[test]
    fn a_board_with_no_declared_thickness_is_pending_and_never_a_pass() {
        // 🔴 THE ABSENCE PLANT — the failure this whole item exists to prevent.
        // Same program, same rectangle, thickness simply not declared. The
        // count is `0` and the count is MEANINGLESS, and something has to say
        // so: `0` in an integer reads as PASS, and "nobody asked" and "asked and
        // nothing happened" are the same glyph.
        use crate::types::Spoilboard;
        let hm = seven_mm_past_the_underside();
        let board = Spoilboard::new("mdf of unknown thickness", 0.0, 0.0, 100.0, 100.0);
        assert_eq!(board.thickness_mm, None, "the fixture declared a thickness by accident");
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));

        assert!(!r.board_depth.ran(), "the depth limb claimed to run with no thickness");
        assert_eq!(
            r.board_depth.verdict(),
            BoardDepth::Unknown,
            "an unrun limb rendered as a verdict"
        );
        assert_ne!(
            r.board_depth.verdict(),
            BoardDepth::InsideBoard,
            "🔴 PENDING was rendered as the SAFE verdict — this is the exact failure"
        );
        assert_eq!(r.board_depth.cells_through_board, 0);
        assert_eq!(r.board_depth.underside_z_mm, None, "a floor was invented");

        let why = r.board_depth.why_not().expect("an unrun limb must say why");
        assert!(why.contains("NO THICKNESS"), "{why}");
        assert!(
            why.contains("UNKNOWN") && why.contains("thick enough"),
            "the sentence must refuse the 'thick enough' reading in terms: {why}"
        );

        // ⚠ AND THE OTHER LIMB STILL RAN. Unknown thickness does not cost the
        // operator the answer to "is there a board under here at all" — that is
        // a different question and it was answered.
        assert!(r.spoilboard.ran(), "an unknown thickness switched off the position limb");
        assert_eq!(r.spoilboard.cells_past_edge, 0);
    }

    #[test]
    fn past_the_boards_edge_is_the_position_limbs_finding_and_is_not_counted_twice() {
        // The mirror of the test above: the thickness is perfectly known and the
        // cut is off the board, so the DEPTH limb has nothing to say about those
        // cells — there is no board there to go through. One hazard, reported
        // once, by the limb whose question it answers.
        use crate::types::Spoilboard;
        let hm = seven_mm_past_the_underside();
        // Half a board: covers X 0..50, so the cut at X 50..90 runs off it.
        let board = Spoilboard::new("half board", 0.0, 0.0, 50.0, 100.0).with_thickness(6.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));

        assert!(r.spoilboard.ran());
        assert!(r.spoilboard.cells_past_edge > 0, "the position limb found no bare machine");
        assert!(r.board_depth.ran(), "the depth limb should still run over the covered half");
        // 🔴 Cells off the board are not in the depth limb's denominator at all.
        // Compared against the map's own size rather than a copied constant: a
        // literal here would silently stop being an upper bound the day the
        // fixture's cell size changed, and the assertion would pass for the
        // wrong reason. The board covers a little over half the map in X.
        let map_cells = hm.rows * hm.cols;
        assert!(
            r.board_depth.cells_tested < map_cells,
            "cells past the edge were counted as tested against an underside that is not there \
             ({} tested of {map_cells} cells)",
            r.board_depth.cells_tested
        );
        assert!(
            r.board_depth.cells_tested > map_cells / 4,
            "the covered half of the map was not tested at all ({} of {map_cells})",
            r.board_depth.cells_tested
        );
        // The covered half still goes through the 6mm board, so this program is
        // BOTH — and both are reported, separately.
        assert!(r.board_depth.cells_through_board > 0);
        assert_eq!(r.board_depth.verdict(), BoardDepth::ThroughBoard);
        assert!(r.spoilboard.strike_note("half board", None).is_some());
        assert!(r.board_depth.through_note("half board").is_some());
    }

    #[test]
    fn a_declared_thickness_that_is_not_a_thickness_is_its_own_reason() {
        // Present-and-unusable is a THIRD state: somebody typed a thickness and
        // it is not one. It must not be laundered into "nobody said", because
        // the fix is different — and it must not be judged against either.
        use crate::types::Spoilboard;
        let hm = seven_mm_past_the_underside();
        for bad in [0.0, -18.0, f64::NAN] {
            let board = Spoilboard::new("typo", 0.0, 0.0, 100.0, 100.0).with_thickness(bad);
            let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));
            assert!(!r.board_depth.ran(), "{bad} was accepted as a floor");
            assert_eq!(r.board_depth.verdict(), BoardDepth::Unknown);
            let why = r.board_depth.why_not().expect("must say why");
            assert!(
                why.contains("is not a slab"),
                "a typo'd thickness got the never-declared sentence: {why}"
            );
            // 🔴 And it did NOT take the position limb down with it — the
            // rectangle is fine and the rectangle is a different question.
            assert!(
                r.spoilboard.ran(),
                "a thickness typo switched off the check that answers whether there is a board \
                 under here at all"
            );
            assert!(!board.thickness_faults().is_empty(), "the declaration fault is unreported");
            assert!(board.faults().is_empty(), "a thickness fault leaked into the rectangle list");
        }
    }

    #[test]
    fn a_declared_board_the_sheet_does_not_overlap_reports_pending_not_clean() {
        // A floor with nothing tested against it is a `0` that measured
        // nothing — the `UncutCoverage` lesson, arriving at the newest limb.
        use crate::types::Spoilboard;
        let hm = seven_mm_past_the_underside();
        let far_away = Spoilboard::new("elsewhere", 5000.0, 5000.0, 100.0, 100.0)
            .with_thickness(18.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&far_away));
        assert!(r.board_depth.underside_z_mm.is_some(), "the floor itself is known here");
        assert_eq!(r.board_depth.cells_tested, 0);
        assert!(!r.board_depth.ran(), "a limb that compared nothing reported a measurement");
        assert_eq!(r.board_depth.verdict(), BoardDepth::Unknown);
        let why = r.board_depth.why_not().expect("must say why");
        assert!(why.contains("NOT ONE SIMULATED CELL"), "{why}");
    }

    #[test]
    fn the_three_depth_states_are_named_apart_and_none_is_a_prefix_of_another() {
        // Same rule as `BelowSheet::as_str`: a host keying on one of these must
        // not be able to match another by prefix.
        let all = [BoardDepth::Unknown, BoardDepth::InsideBoard, BoardDepth::ThroughBoard];
        for a in all {
            for b in all {
                if a == b {
                    continue;
                }
                assert!(
                    !a.as_str().starts_with(b.as_str()),
                    "{} is a prefix of {}",
                    b.as_str(),
                    a.as_str()
                );
            }
        }
    }

    #[test]
    fn with_no_spoilboard_declared_the_finding_says_unchecked_and_not_into_the_spoilboard() {
        // 🔴 THE FIX FOR THE SILENT ASSUMPTION. Nobody declared a board, so the
        // depth is known and the position is not. It must NOT come back as
        // `OverSpoilboard`, which is what the variant's NAME implied for the
        // whole of this module's life.
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -25.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -25.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, None);
        assert!(!r.spoilboard.ran(), "the position limb claimed to have run with no board");
        assert!(r.spoilboard.cells_below_floor > 0);
        assert_eq!(
            r.spoilboard.cells_past_edge, 0,
            "a question that was never asked must not produce an answer"
        );
        for f in &r.findings {
            let SimFinding::Spoilboard { below, .. } = f else { continue };
            assert_eq!(*below, BelowSheet::SpoilboardUndeclared, "{f:?}");
        }
        let why = r.spoilboard.why_not().expect("an unrun limb must say why");
        assert!(why.contains("no spoilboard is declared"), "{why}");
        assert!(
            why.contains("DEPTH ALONE"),
            "the sentence must name what was and was not measured: {why}"
        );
    }

    #[test]
    fn over_the_declared_board_a_through_cut_is_sacrificial_and_named_as_such() {
        use crate::types::Spoilboard;
        // The board covers the whole 100x100 map, so every below-floor cell is
        // over material that is meant to be cut.
        let board = Spoilboard::new("mdf", 0.0, 0.0, 100.0, 100.0);
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -25.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -25.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));
        assert!(r.spoilboard.ran());
        assert!(r.spoilboard.cells_below_floor > 0);
        assert_eq!(
            r.spoilboard.cells_past_edge, 0,
            "a cut entirely over the board reported a strike on the machine"
        );
        assert!(r.spoilboard.strike_note("mdf", None).is_none());
        for f in &r.findings {
            let SimFinding::Spoilboard { below, .. } = f else { continue };
            assert_eq!(*below, BelowSheet::OverSpoilboard, "{f:?}");
        }
    }

    #[test]
    fn past_the_board_edge_is_a_different_finding_with_its_own_name() {
        use crate::types::Spoilboard;
        // 🔴 THE PHYSICAL CASE, AND THE ONE THE OLD CHECK COULD NOT SEE. The
        // workpiece spans X0..100; the board stops at X50. The same single cutting
        // move goes through the workpiece along Y50 for its whole length, so the
        // first half is a normal sacrificial through-cut and the second half is
        // a 6mm cutter descending 7mm into whatever the machine is made of —
        // and until 2026-08-10 both halves produced the identical finding.
        let board = Spoilboard::new("half-board", 0.0, 0.0, 50.0, 100.0);
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -25.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -25.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));

        assert!(r.spoilboard.ran());
        assert!(
            r.spoilboard.cells_past_edge > 0,
            "the half of the cut that left the board was not distinguished"
        );
        assert!(
            r.spoilboard.cells_past_edge < r.spoilboard.cells_below_floor,
            "BOTH classes must be present on this program — {} past edge of {} below floor. \
             A check that called the whole cut a strike would pass a weaker assertion and \
             would be a false red on every through-cut",
            r.spoilboard.cells_past_edge,
            r.spoilboard.cells_below_floor
        );

        // Every past-edge finding is genuinely past X50, and every over-board
        // one genuinely is not. The classes are not merely counted, they are
        // attached to the right cells.
        for f in &r.findings {
            let SimFinding::Spoilboard { x, below, .. } = f else { continue };
            match below {
                BelowSheet::PastSpoilboardEdge => {
                    assert!(*x > 50.0, "classed past the edge at X{x}, which is ON the board")
                }
                BelowSheet::OverSpoilboard => {
                    assert!(*x <= 50.0, "classed as over the board at X{x}, which is past it")
                }
                BelowSheet::SpoilboardUndeclared => {
                    panic!("a declared board produced an UNCHECKED cell")
                }
            }
        }

        let note = r
            .spoilboard
            .strike_note("half-board", Some((70.0, 50.0, 7.0)))
            .expect("cells past the edge must produce their own sentence");
        assert!(note.contains("PAST THE EDGE OF THE SPOILBOARD"), "{note}");
        assert!(note.contains("half-board"), "the sentence must name the board: {note}");
        assert!(
            note.contains("frame") || note.contains("extrusion"),
            "the sentence must name the physical failure, not just the geometry: {note}"
        );
        // And the two sentences are distinguishable: a host keying on one must
        // not match the other.
        assert!(r.spoilboard.why_not().is_none(), "a limb that ran must not also say why not");
    }

    #[test]
    fn a_faulted_board_is_treated_as_undeclared_and_not_as_a_board_that_covers_nothing() {
        use crate::types::Spoilboard;
        // 🔴 A zero-sized rectangle answers `covers == false` everywhere. Taken
        // literally it would report EVERY through-cut as a strike on the frame —
        // a false red across a whole job, which is how a real one gets muted.
        let broken = Spoilboard::new("typo", 0.0, 0.0, 0.0, 0.0);
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -25.0), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -25.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&broken));
        assert!(!r.spoilboard.ran(), "a faulted declaration was accepted as an answer");
        assert_eq!(r.spoilboard.cells_past_edge, 0);
        for f in &r.findings {
            let SimFinding::Spoilboard { below, .. } = f else { continue };
            assert_eq!(*below, BelowSheet::SpoilboardUndeclared, "{f:?}");
        }
    }

    #[test]
    fn a_cut_off_the_board_that_stays_inside_the_sheet_is_not_a_strike() {
        use crate::types::Spoilboard;
        // The control that stops the position limb firing on geometry alone: a
        // cut entirely past the board's edge in XY, but 1mm shy of the workpiece's
        // underside, reaches nothing at all. Without this a check that fired on
        // "off the board" would look like a working one.
        let board = Spoilboard::new("half-board", 0.0, 0.0, 50.0, 100.0);
        let p = path(vec![
            Move::rapid(Vec3::new(60.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(60.0, 50.0, -17.0), 300.0),
            Move::feed_to(Vec3::new(95.0, 50.0, -17.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&board));
        assert_eq!(r.spoilboard.cells_below_floor, 0);
        assert_eq!(r.spoilboard.cells_past_edge, 0);
        assert!(r.findings.is_empty(), "{:?}", r.findings);
    }

    #[test]
    fn the_sacrificial_allowance_is_spent_only_where_there_is_sacrificial_material() {
        use crate::types::Spoilboard;
        // 🔴 THE HALF THAT MAKES THIS LIMB REACH REAL PROGRAMS. The identical
        // 0.2mm-past-the-underside cut — the depth `crate::toolpath` CLAMPS
        // every through-profile to — is intended over the board and is 0.2mm of
        // cutter in a rail past its edge. Same program, same depth, two answers,
        // and the only difference is what the board covers.
        let deep_enough = || {
            path(vec![
                Move::rapid(Vec3::new(60.0, 50.0, 5.0)),
                Move::feed_to(Vec3::new(60.0, 50.0, -18.2), 300.0),
                Move::feed_to(Vec3::new(95.0, 50.0, -18.2), 1000.0),
            ])
        };

        let covering = Spoilboard::new("full", 0.0, 0.0, 100.0, 100.0);
        let hm = simulate(&deep_enough(), 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let over = check(&hm, &[], &[], 0.0, 18.0, 0.3, Some(&covering));
        assert_eq!(
            over.spoilboard.cells_below_floor, 0,
            "the sacrificial allowance was not applied where there IS sacrificial material — \
             this would false-red every correct through-cut in the tree"
        );

        let half = Spoilboard::new("half-board", 0.0, 0.0, 50.0, 100.0);
        let hm2 = simulate(&deep_enough(), 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let off = check(&hm2, &[], &[], 0.0, 18.0, 0.3, Some(&half));
        assert!(
            off.spoilboard.cells_past_edge > 0,
            "past the board's edge there is nothing for the allowance to be spent in, and the \
             same 0.2mm went unreported"
        );
        // The reported depth is measured from the workpiece's underside in both
        // classes, so one number means one thing.
        let first = off
            .findings
            .iter()
            .find_map(|f| match f {
                SimFinding::Spoilboard { past_mm, below, .. }
                    if *below == BelowSheet::PastSpoilboardEdge =>
                {
                    Some(*past_mm)
                }
                _ => None,
            })
            .expect("a strike finding");
        assert!((first - 0.2).abs() < 0.05, "past_mm is not measured from the underside: {first}");
    }

    #[test]
    fn the_class_names_do_not_prefix_match_each_other() {
        // A host keying on one class must not be able to match another by
        // prefix — the same rule the verdict strings are held to.
        let all = [
            BelowSheet::OverSpoilboard,
            BelowSheet::PastSpoilboardEdge,
            BelowSheet::SpoilboardUndeclared,
        ];
        for a in all {
            for b in all {
                if a != b {
                    assert!(
                        !a.as_str().starts_with(b.as_str()),
                        "{} is a prefix of {}",
                        b.as_str(),
                        a.as_str()
                    );
                }
            }
        }
        assert!(BelowSheet::PastSpoilboardEdge.is_strike_on_the_machine());
        assert!(!BelowSheet::OverSpoilboard.is_strike_on_the_machine());
        // 🔴 UNDECLARED IS NOT A STRIKE AND IS NOT A PASS. It must not answer
        // `true` here — that would turn every undeclared job into a false red —
        // and the UNCHECKED sentence is what carries it instead.
        assert!(!BelowSheet::SpoilboardUndeclared.is_strike_on_the_machine());
    }

    #[test]
    fn a_through_cut_within_the_allowance_is_not_a_spoilboard_strike() {
        // Negative control: through-cuts legitimately go 0.2-0.3mm past.
        let p = path(vec![
            Move::rapid(Vec3::new(10.0, 50.0, 5.0)),
            Move::feed_to(Vec3::new(10.0, 50.0, -18.2), 300.0),
            Move::feed_to(Vec3::new(90.0, 50.0, -18.2), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        let found = check(&hm, &[], &[], 0.0, 18.0, 0.3, None).findings;
        assert!(found.is_empty(), "a normal through-cut was flagged: {found:?}");
    }

    #[test]
    fn arcs_are_swept_along_their_curve_not_their_chord() {
        // A 90 degree arc's chord passes well inside the arc. If the sim walked
        // the chord it would report material cut where the tool never went, and
        // leave uncut what it did.
        let b = (std::f64::consts::FRAC_PI_8).tan();
        let c = Contour::closed(vec![
            crate::geometry::Vertex::arc(50.0, 20.0, b),
            crate::geometry::Vertex::line(80.0, 50.0),
        ]);
        let _ = c;
        let p = path(vec![
            Move::rapid(Vec3::new(50.0, 20.0, 5.0)),
            Move::feed_to(Vec3::new(50.0, 20.0, -5.0), 1000.0),
            Move::arc(false, Vec3::new(80.0, 50.0, -5.0), crate::types::Vec2::new(50.0, 50.0), 1000.0),
        ]);
        let hm = simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0);
        // Midpoint of the arc is at 45 degrees: (50 + 30*cos(-45), 50 + 30*sin(-45))
        let mx = 50.0 + 30.0 * (-std::f64::consts::FRAC_PI_4).cos();
        let my = 50.0 + 30.0 * (-std::f64::consts::FRAC_PI_4).sin();
        let (c, r) = ((mx / 0.5) as usize, (my / 0.5) as usize);
        assert!(hm.at(c, r) < -4.0, "the arc midpoint was never cut: {}", hm.at(c, r));
        // The chord midpoint is inside the arc and must be untouched.
        let (cx, cy) = ((65.0 / 0.5) as usize, (35.0 / 0.5) as usize);
        assert!(hm.at(cx, cy) > -1e-6, "the sim walked the chord: {}", hm.at(cx, cy));
    }
}

/// **Audit finding B4** — `uncut: 0` was reported by a check that had visited no
/// cell, on every job a user has ever run.
///
/// 🔴 These assert the DIFFERENCE between the two zeros. Every one of them
/// passes trivially on a build that reports coverage from `remove.len()` instead
/// of from the scan, which is why three of the four hand in a region that is
/// real and still untestable: off the map, below the cell, or with no floor
/// asked for. The positive control at the end is what stops the whole module
/// being satisfied by a constant `false`.
#[cfg(test)]
mod uncut_coverage_tests {
    use super::*;
    use crate::geometry::Contour;
    use crate::types::{Move, Tool, Toolpath};

    fn path(moves: Vec<Move>) -> Toolpath {
        let mut p = Toolpath { moves, tool: Tool::default(), ..Default::default() };
        p.recompute_bounds();
        p
    }

    /// One lap around the inside of a 60x60 pocket at (20,20) — the same motion
    /// `tests::an_uncleared_pocket_is_found` uses, so the two modules are
    /// describing one program from two sides.
    fn outlined_pocket() -> HeightMap {
        let p = path(vec![
            Move::rapid(Vec3::new(23.0, 23.0, 5.0)),
            Move::feed_to(Vec3::new(23.0, 23.0, -5.0), 300.0),
            Move::feed_to(Vec3::new(77.0, 23.0, -5.0), 1000.0),
            Move::feed_to(Vec3::new(77.0, 77.0, -5.0), 1000.0),
            Move::feed_to(Vec3::new(23.0, 77.0, -5.0), 1000.0),
            Move::feed_to(Vec3::new(23.0, 23.0, -5.0), 1000.0),
        ]);
        simulate(&p, 3.0, 100.0, 100.0, 0.5, 0.0, 0.0)
    }

    #[test]
    fn with_no_removal_region_the_uncut_check_reports_pending_not_clean() {
        // 🔴 B4 itself: this is the shape of 100% of imported jobs. The findings
        // are empty and that empty list means NOBODY ASKED.
        let hm = outlined_pocket();
        let r = check(&hm, &[], &[], 0.0, 18.0, 0.3, None);
        assert!(
            r.findings.is_empty(),
            "the fixture is meant to be finding-free; it reported {:?}",
            r.findings
        );
        assert!(
            !r.uncut.ran(),
            "a check handed NO removal region called itself measured: {:?}",
            r.uncut
        );
        assert_eq!(r.uncut.regions_given, 0);
        assert_eq!(r.uncut.cells_tested, 0);
        let why = r.uncut.why_not().expect("a check that did not run must say so");
        assert!(
            why.contains("CLEARED"),
            "the reason never names what was missing: {why}"
        );
    }

    #[test]
    fn a_removal_region_off_the_simulated_area_is_pending_not_clean() {
        // 🔴 THE TEST THAT SEPARATES COVERAGE FROM INPUTS. A region IS declared,
        // with a real floor — and it sits outside the map, so not one cell was
        // compared. A coverage answer derived from `remove.len()` calls this
        // measured and hands back the vacuous green `HeightMap::new`'s own header
        // records (0 gouges at datum 300).
        let hm = outlined_pocket();
        let far = Contour::rect(400.0, 400.0, 60.0, 60.0);
        let r = check(&hm, &[], &[far], 5.0, 18.0, 0.3, None);
        assert!(r.findings.is_empty(), "{:?}", r.findings);
        assert_eq!(r.uncut.regions_given, 1, "the region was handed in");
        assert!(r.uncut.rings_tested >= 1, "and it survived the shrink: {:?}", r.uncut);
        assert!(
            !r.uncut.ran(),
            "a region nowhere near the map was reported as tested: {:?}",
            r.uncut
        );
        let why = r.uncut.why_not().expect("must say so");
        assert!(why.contains("OUTSIDE"), "the reason does not name the cause: {why}");
    }

    #[test]
    fn a_removal_region_narrower_than_a_cell_is_pending_not_clean() {
        // The shrink drops it — deliberately, and documented in `check`. What was
        // NOT said until now is that dropping it leaves the count reading zero.
        let hm = outlined_pocket();
        let sliver = Contour::rect(40.0, 40.0, 0.4, 20.0); // 0.4mm wide, 0.5mm cell
        let r = check(&hm, &[], &[sliver], 5.0, 18.0, 0.3, None);
        assert_eq!(r.uncut.regions_given, 1);
        assert_eq!(r.uncut.rings_tested, 0, "a sub-cell region survived the shrink: {:?}", r.uncut);
        assert!(!r.uncut.ran(), "{:?}", r.uncut);
        assert!(
            r.uncut.why_not().unwrap().contains("narrower than one simulation cell"),
            "{:?}",
            r.uncut.why_not()
        );
    }

    #[test]
    fn a_removal_region_with_no_floor_is_pending_not_clean() {
        let hm = outlined_pocket();
        let pocket = Contour::rect(20.0, 20.0, 60.0, 60.0);
        let r = check(&hm, &[], &[pocket], 0.0, 18.0, 0.3, None);
        assert!(!r.uncut.ran(), "a zero-depth removal was reported as measured: {:?}", r.uncut);
        assert!(r.uncut.why_not().unwrap().contains("no depth asked for"), "{:?}", r.uncut.why_not());
    }

    #[test]
    fn a_real_pocket_reports_the_check_as_having_run() {
        // 🔴 THE NEGATIVE CONTROL FOR THIS WHOLE MODULE. Without it, hard-wiring
        // `ran() == false` passes every test above — a PENDING that is always
        // PENDING is as useless as the zero it replaced, and it would silence the
        // one gate (P2) that does work today.
        let hm = outlined_pocket();
        let pocket = Contour::rect(20.0, 20.0, 60.0, 60.0);
        let r = check(&hm, &[], &[pocket], 5.0, 18.0, 0.3, None);
        assert!(r.uncut.ran(), "the pocket fixture's own check did not run: {:?}", r.uncut);
        assert!(r.uncut.cells_tested > 100, "only {} cells tested", r.uncut.cells_tested);
        assert_eq!(r.uncut.why_not(), None, "a check that ran still claimed a reason");
        assert!(
            r.findings.iter().any(|f| matches!(f, SimFinding::Uncut { .. })),
            "the island left by an outlined pocket was not reported"
        );
    }
}

/// The direction of the simulation's error, PROVED against the analytic swept
/// region rather than asserted in a doc comment.
///
/// 🔴 Every claim the module header makes about precision has an assertion
/// here. The claims are deliberately the uncomfortable ones — the header used
/// to say the sim "will over-report removal, never under-report it", and the
/// first test below shows the raw map does the OPPOSITE: it is an inner
/// approximation. A rationale that has never been run is a guess with a
/// confident voice.
#[cfg(test)]
mod precision_tests {
    use super::*;
    use crate::types::{Move, Tool, Toolpath};

    fn path(moves: Vec<Move>) -> Toolpath {
        let mut p = Toolpath { moves, tool: Tool::default(), ..Default::default() };
        p.recompute_bounds();
        p
    }

    /// Analytic truth: perpendicular distance from a point to the segment.
    fn dist_to_seg(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
        let (dx, dy) = (bx - ax, by - ay);
        let l2 = dx * dx + dy * dy;
        let t = (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0);
        ((px - (ax + dx * t)).powi(2) + (py - (ay + dy * t)).powi(2)).sqrt()
    }

    /// A straight cut whose swept region is `{p : dist(p, segment) <= r}`.
    /// Every sample is then either inside that region or outside it, with no
    /// approximation on the truth side — which is what makes the comparison a
    /// measurement and not a second opinion.
    fn cut(ax: f64, ay: f64, bx: f64, by: f64, r: f64, cell: f64) -> HeightMap {
        let p = path(vec![
            Move::rapid(Vec3::new(ax, ay, 5.0)),
            Move::feed_to(Vec3::new(ax, ay, -5.0), 300.0),
            Move::feed_to(Vec3::new(bx, by, -5.0), 1000.0),
        ]);
        simulate(&p, r, 140.0, 140.0, cell, 0.0, 0.0)
    }

    /// The full sweep both tests below run over: cells from finer than default
    /// to the coarsest a user could type, both a grid-aligned and an off-grid
    /// heading, and every sub-cell offset of the cut relative to the grid.
    fn cases() -> Vec<(f64, f64, f64, f64)> {
        let mut v = Vec::new();
        for &cell in &[0.3_f64, 0.6, 1.0, 3.0] {
            for &r in &[1.5_f64, 3.0] {
                for &ang in &[0.0_f64, 30.0] {
                    for i in 0..12 {
                        v.push((cell, r, ang, cell * (i as f64) / 12.0));
                    }
                }
            }
        }
        v
    }

    #[test]
    fn the_map_never_marks_material_the_tool_did_not_reach() {
        // 🔴 THE DIRECTION CLAIM, and it comes out the other way round from
        // what this file used to say. At its own cell the height map is a POINT
        // SAMPLE of the true swept region: a sample is lowered only if the tool
        // centre passed within `r` of that exact point. So it cannot report
        // removal that did not happen — 0 false positives — and it is therefore
        // an INNER approximation, not the outer one the old comment promised.
        //
        // The oversize surface an operator sees is made downstream, by
        // `fixtures::stock_surface_of`. That is where "never smaller" is true,
        // and it is proved there, not here.
        let mut checked = 0usize;
        for (cell, r, ang, off) in cases() {
            let (ax, ay) = (30.0, 60.0 + off);
            let th: f64 = (ang as f64).to_radians();
            let (bx, by) = (ax + 60.0 * th.cos(), ay + 60.0 * th.sin());
            let hm = cut(ax, ay, bx, by, r, cell);
            for row in 0..hm.rows {
                for col in 0..hm.cols {
                    let (x, y) = hm.world_of(col, row);
                    if hm.at(col, row) < -1e-9 {
                        let d = dist_to_seg(x, y, ax, ay, bx, by);
                        assert!(
                            d <= r + 1e-9,
                            "cell={cell} r={r} ang={ang} off={off}: sample ({x:.3},{y:.3}) reads \
                             removed but the cutter never came within {r}mm of it — nearest \
                             approach {d:.6}mm. The map is claiming material it did not remove."
                        );
                        checked += 1;
                    }
                }
            }
        }
        // A vacuous pass is the failure mode this whole file exists to refuse:
        // if nothing were ever marked removed, the loop above would be green.
        assert!(checked > 100_000, "the sweep marked only {checked} cells — it proved nothing");
    }

    #[test]
    fn a_missed_sample_lies_only_at_the_very_edge_of_the_cut() {
        // The other half of the same fact. The map CAN miss removal, because
        // the sweep is stamped at discrete points; `edge_miss_mm` says how far
        // inside the band a miss can be. If a miss were ever found deeper than
        // that bound, the under-report would be unbounded and could hide a
        // gouge — which is the one outcome this simulation may not have.
        let mut worst = 0.0_f64;
        let mut worst_case = (0.0, 0.0);
        for (cell, r, ang, off) in cases() {
            let (ax, ay) = (30.0, 60.0 + off);
            let th: f64 = (ang as f64).to_radians();
            let (bx, by) = (ax + 60.0 * th.cos(), ay + 60.0 * th.sin());
            let hm = cut(ax, ay, bx, by, r, cell);
            let bound = edge_miss_mm(r, cell);
            for row in 0..hm.rows {
                for col in 0..hm.cols {
                    let (x, y) = hm.world_of(col, row);
                    let d = dist_to_seg(x, y, ax, ay, bx, by);
                    // Inside the true swept band, and the map says untouched.
                    if d <= r - 1e-9 && hm.at(col, row) > -1e-9 {
                        let inside = r - d;
                        assert!(
                            inside <= bound + 1e-9,
                            "cell={cell} r={r} ang={ang} off={off}: sample ({x:.3},{y:.3}) is \
                             {inside:.6}mm INSIDE the cut and reads untouched, past the stated \
                             bound of {bound:.6}mm. An unbounded under-report can hide a gouge."
                        );
                        if inside > worst {
                            worst = inside;
                            worst_case = (cell, r);
                        }
                    }
                }
            }
        }
        // Recorded so the number in the docs is the number the code produces.
        let (c, r) = worst_case;
        assert!(
            worst < 0.25,
            "deepest miss {worst:.4}mm at cell={c} r={r} — docs/sim-resolution.md quotes 0.20mm"
        );
    }

    #[test]
    fn the_raw_map_draws_a_slot_no_wider_than_the_cutter_and_sometimes_narrower() {
        // 🔴 The finding that contradicts the ticket's premise, pinned so it
        // cannot quietly stop being true. TODO #46 says the simulated surface
        // "reads OVERSIZE" — it does, but ONLY after the display reduction. At
        // the simulation's own cell the opposite holds: counting removed
        // samples across a slot cut by a 6.00mm cutter gives 5.4mm to 6.0mm,
        // never more. The 5.4mm case is a tool whose sweep is exactly tangent
        // to a row of samples, dropped by `<= r*r` in floating point — a real
        // 10% narrow reading at the shipping default cell.
        //
        // This is the direction that can hide removal, so it is asserted rather
        // than described, and the assertion is two-sided: a future change that
        // dilated the stamp would break the upper bound, and one that coarsened
        // the sweep would break the lower.
        const CELL: f64 = 0.6; // the app default and the wasm fallback
        let (mut narrowest, mut widest) = (f64::INFINITY, 0.0_f64);
        for i in 0..24 {
            let y = 50.0 + CELL * (i as f64) / 24.0;
            let hm = cut(10.0, y, 90.0, y, 3.0, CELL);
            let col = (50.0 / CELL) as usize;
            let n = (0..hm.rows).filter(|r| hm.at(col, *r) < -1e-9).count();
            let w = n as f64 * CELL;
            narrowest = narrowest.min(w);
            widest = widest.max(w);
        }
        assert!(
            (widest - 6.0).abs() < 1e-9,
            "the raw map drew a 6.00mm cutter's slot {widest}mm wide — wider than the cutter. The \
             height map is a point sample of the swept region and must never exceed it."
        );
        assert!(
            (narrowest - 5.4).abs() < 1e-9,
            "the raw map's narrowest reading of a 6.00mm slot is {narrowest}mm; 5.4mm was measured \
             2026-08-09 and docs/sim-resolution.md quotes it"
        );
    }

    #[test]
    fn the_stated_bound_is_the_step_the_sweep_actually_uses() {
        // `edge_miss_mm` is only true while `stamp_step_mm` is what `simulate`
        // walks with. This pins the two together so a change to one fails here
        // rather than silently making the printed precision a fiction.
        assert_eq!(stamp_step_mm(0.6), 0.3);
        assert_eq!(stamp_step_mm(0.05), 0.05, "the step is floored, and so is the bound");
        let b = edge_miss_mm(3.0, 0.6);
        let half = 0.15_f64;
        assert!((b - (3.0 - (9.0 - half * half).sqrt())).abs() < 1e-12, "{b}");
        assert!((b - 0.00375).abs() < 5e-5, "0.6mm cell, 6mm cutter: expected ~0.0038mm, got {b}");
        assert!(
            (edge_miss_mm(1.5, 3.0) - 0.201).abs() < 5e-3,
            "3mm cell, 3mm cutter: expected ~0.20mm, got {}",
            edge_miss_mm(1.5, 3.0)
        );
        // A degenerate radius must not put a NaN in front of an operator.
        assert_eq!(edge_miss_mm(0.0, 0.6), 0.0);
        assert_eq!(edge_miss_mm(f64::NAN, 0.6), 0.0);
    }

    #[test]
    fn the_notes_say_the_cell_the_direction_and_the_oversize() {
        // The wording is the deliverable of TODO #46: an operator reading the
        // counts must be told the resolution, that the drawn surface is
        // OVERSIZE and square-cornered, and that there is no single safe
        // direction. A note that omits any of those reads as a measurement.
        let p = Precision::new(0.6, Some(3.0), 3.0);
        let all = p.notes().join(" | ").to_lowercase();
        for needle in [
            "0.6mm cells",   // the resolution it ran at
            "counts of cells",
            "oversize",      // the founder's complaint, said out loud
            "cell grid",     // the square corners, attributed to the grid
            "3.0mm display cell",
            "9.0mm",         // the measured number, not a hand-wave
            "safe error for a gouge and the unsafe one for an uncut",
        ] {
            assert!(all.contains(&needle.to_lowercase()), "note set never says {needle:?}: {all}");
        }
        assert_eq!(p.display_widening_mm(), Some(4.8), "3.0 over 0.6 dilates by up to 2*(3.0-0.6)");
        // No surface asked for = no oversize sentence. Saying it anyway would
        // warn about a picture that was never drawn.
        let none = Precision::new(0.6, None, 3.0);
        assert_eq!(none.display_widening_mm(), None);
        assert!(
            !none.notes().join(" ").to_lowercase().contains("oversize"),
            "warned about a drawn surface that was never emitted"
        );
    }
}
