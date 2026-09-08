//! One job assembled from N PLACED drawings — and the check that two of them do
//! not try to occupy the same material.
//!
//! # What this exists for
//!
//! Until now a job was ONE drawing: `plan_import` took one blob of text, and the
//! only placement question was where that single drawing sat relative to the
//! datum. The founder asked to *"add/remove multiple drawing to the canvas"*
//! (TODO #31), and the moment there are two, a question appears that nothing in
//! this core has ever asked:
//!
//! 🔴 **Do these two parts fit on this workpiece WITHOUT the cutter destroying
//! either of them?**
//!
//! That is two separate failures, and they have different fixes:
//!
//! * **Overlap** — the parts share material. Cutting one removes the other's
//!   edge; at best the second part is scrap, at worst it is a loose offcut under
//!   a 2.2 kW spindle while the program is still running. Fix: re-nest, one of
//!   them has to come off this material.
//! * **Too close** — the parts do NOT share material, but the space between them
//!   is narrower than the cutter. A 6mm cutter driven down a 3mm channel removes
//!   the edge of *both* parts. Fix: move them apart. Nothing is wrong with the
//!   nest except the spacing.
//!
//! ⚠ The second is the dangerous one, because **snapping two parts flush is the
//! most natural gesture a person will make** (TODO #32 item 3). A grid snap
//! invites exactly the placement that produces an unrunnable job, and a check
//! that only looked for overlap would call it clean.
//!
//! # The placement model is `Stock`'s, not a second one
//!
//! A [`PlacedDrawing`] is positioned and rotated by handing its local
//! coordinates to a [`Stock`] built for the purpose — see [`PlacedDrawing::frame`].
//! That is deliberate and it is the whole reason there is no rotation arithmetic
//! in this file: [`Stock`] already carries the exact quarter turns
//! (`(90f64).to_radians().cos()` is 6.1e-17, not 0) and the push-back that keeps
//! `origin_*` meaning *"where the corner of the thing is"* — the number a person
//! measures with a tape. **Two placement models would eventually disagree, and
//! the disagreement would be a program cut at an angle nobody chose.**
//!
//! For the same reason the extent type is [`Extent`] from [`crate::placement`],
//! not a local one, and the workpiece-fit / travel question is answered by handing
//! the UNION extent to [`crate::placement::plan_datum_shift`] rather than by
//! re-deriving the limits here.
//!
//! # What this module does NOT do — read before trusting it
//!
//! * **It is not a nester.** It checks a placement a human (or a UI) chose. It
//!   never moves a part to resolve an interference, for the same reason
//!   [`crate::placement`] never applies its own shift: the clamps do not move
//!   with the parts.
//! * **It checks OUTER boundaries against OUTER boundaries.** A part deliberately
//!   nested inside another part's hole is therefore refused as an overlap even
//!   though that material is a drop-out and genuinely available. That is a false
//!   RED, it is named here rather than discovered, and the workaround is to draw
//!   the nested part as part of the same drawing. Refusing a legal nest costs a
//!   re-draw; permitting an illegal one costs a cutter.
//! * **It says nothing about tabs.** P1's failure is per part (TODO #31 item 2):
//!   three parts with one of them tabbed still leaves two loose pieces. Tabs are
//!   [`OperationParams`]' business and the caller sets them per part.
//! * **It takes the SAFE operation order and says so.** [`Layout::operations`]
//!   emits each part's operations complete before the next part starts, which is
//!   "finish one part before releasing the next". Grouping every part's pockets
//!   under one tool is faster and is what [`crate::job`] does when it groups by
//!   tool. That trade-off (TODO #31 item 3) is stated, not silently taken, and it
//!   is not resolved here.

use serde::{Deserialize, Serialize};

use cavalier_contours::polyline::{
    BooleanOp, BooleanResultInfo, PlineCreation, PlineSource, PlineSourceMut, Polyline,
};

use crate::geometry::{Contour, Part, Vertex};
use crate::placement::{plan_datum_shift, Extent, Placement};
use crate::toolpath::{operations_for_part, Operation, Refusal};
use crate::types::{Machine, OperationParams, Stock, Tool};

/// Numbers below this are noise, not measurements.
const EPS: f64 = 1e-9;

/// Bisection steps used to measure a gap that has already been refused. 18 steps
/// over a required clearance of 7mm resolves to 2.7e-5 mm, which is four orders
/// finer than anything a router can hold.
const GAP_BISECTIONS: u32 = 18;

// ---------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------

/// How much clear material two parts must have between them.
///
/// 🔴 **The cutter diameter is a parameter and is never guessed.** The whole
/// point of the gap check is that it is a machining constraint: the space
/// between two parts has to be wide enough for the tool to travel down it
/// without touching either wall. A default would make the check pass or fail on
/// a number nobody chose, which is worse than not having the check — a person
/// would trust it.
///
/// The fields are private and [`Clearance::new`] refuses a non-positive or
/// non-finite diameter, so a zero-diameter "clearance" (which would silently
/// weaken the check to the margin alone) cannot be constructed. For the same
/// reason this type is `Serialize` but **not** `Deserialize`: a deserialised
/// value would walk straight past `new`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Clearance {
    cutter_diameter_mm: f64,
    margin_mm: f64,
}

impl Clearance {
    /// `None` when the cutter diameter is not a positive finite number, or when
    /// the margin is negative or not finite. A negative margin would be a
    /// licence to place parts closer than the tool is wide.
    pub fn new(cutter_diameter_mm: f64, margin_mm: f64) -> Option<Self> {
        if !cutter_diameter_mm.is_finite() || cutter_diameter_mm <= 0.0 {
            return None;
        }
        if !margin_mm.is_finite() || margin_mm < 0.0 {
            return None;
        }
        Some(Self { cutter_diameter_mm, margin_mm })
    }

    /// The clearance implied by a tool actually selected for the job, plus a
    /// margin the caller still has to choose. The margin covers what the
    /// diameter does not: cutter runout, workpiece bow, and the fact that a pass
    /// down the exact centre of a diameter-wide channel leaves zero material on
    /// either side and no chip clearance at all.
    pub fn from_tool(tool: &Tool, margin_mm: f64) -> Option<Self> {
        Self::new(tool.diameter_mm, margin_mm)
    }

    pub fn cutter_diameter_mm(&self) -> f64 {
        self.cutter_diameter_mm
    }

    pub fn margin_mm(&self) -> f64 {
        self.margin_mm
    }

    /// Minimum clear material between two parts, in mm.
    pub fn required_mm(&self) -> f64 {
        self.cutter_diameter_mm + self.margin_mm
    }
}

// ---------------------------------------------------------------------------
// Naming — a finding has to say WHICH drawing is at fault
// ---------------------------------------------------------------------------

/// Which part of which drawing. Both halves, always: with several drawings on a
/// workpiece, "part1" is ambiguous the moment two drawings each have one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartRef {
    /// The drawing's id, as the user added it.
    pub drawing: String,
    /// The part's name inside that drawing, as imported.
    pub part: String,
}

impl PartRef {
    /// `drawing/part` — **the same string that names this part's operations**.
    /// A caller can take a refusal, read this, and strike exactly the operations
    /// it condemns without matching on anything looser.
    pub fn qualified(&self) -> String {
        qualified_name(&self.drawing, &self.part)
    }
}

/// The one place the qualified name is spelled, so a refusal, a placed part and
/// an operation cannot drift apart.
fn qualified_name(drawing: &str, part: &str) -> String {
    format!("{drawing}/{part}")
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/// Something about a PAIR of parts that stops this job being cut.
///
/// All three variants are refusals. `NotChecked` is not a warning: a pair whose
/// check could not run is not a pair that passed, and a green that means
/// "unchecked" is worse than a red.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "finding", rename_all = "snake_case")]
pub enum Interference {
    /// The parts share material.
    Overlap {
        a: PartRef,
        b: PartRef,
        /// The shared region, measured on the actual boundaries (arcs included).
        region: Extent,
        /// How far they interpenetrate on each axis — `region`'s width and
        /// height. This is the number a person moves a part by.
        over_x_mm: f64,
        over_y_mm: f64,
        /// Area of shared material. Distinguishes "these two are stacked" from
        /// "these two touch at a corner".
        area_mm2: f64,
    },
    /// The parts do not share material, but the channel between them is
    /// narrower than the tool that has to travel down it.
    TooClose {
        a: PartRef,
        b: PartRef,
        /// Clear material between them, measured by the same offset that
        /// produced the refusal — so the number and the verdict cannot disagree.
        gap_mm: f64,
        required_mm: f64,
        cutter_diameter_mm: f64,
        margin_mm: f64,
    },
    /// The check could not be run on this pair. **Not a pass.**
    NotChecked { a: PartRef, b: PartRef, why: String },
}

impl Interference {
    pub fn parts(&self) -> (&PartRef, &PartRef) {
        match self {
            Interference::Overlap { a, b, .. }
            | Interference::TooClose { a, b, .. }
            | Interference::NotChecked { a, b, .. } => (a, b),
        }
    }

    /// One line for an operator. Names both parts and every number, because
    /// "parts overlap" is not something anyone can act on.
    ///
    /// The two machining failures are worded so they cannot be mistaken for each
    /// other: only [`Interference::Overlap`] uses the word OVERLAP, and only
    /// [`Interference::TooClose`] uses TOO CLOSE. They have different fixes —
    /// re-nest versus move apart — and a message that blurred them would send a
    /// person to the wrong one.
    pub fn describe(&self) -> String {
        match self {
            Interference::Overlap { a, b, region, over_x_mm, over_y_mm, area_mm2 } => format!(
                "part `{}` and part `{}` OVERLAP — they are cut from the same material: \
                 {:.3}mm in X and {:.3}mm in Y ({:.3}mm² shared, over X {:.3} .. {:.3}, \
                 Y {:.3} .. {:.3}). Cutting one destroys the other and leaves it loose under \
                 the spindle. MOVE ONE OF THEM off this material — re-nest, do not \
                 nudge: nothing here will move a part for you, because the clamps stay \
                 bolted to the machine while the parts do not",
                a.qualified(),
                b.qualified(),
                over_x_mm,
                over_y_mm,
                area_mm2,
                region.min_x,
                region.max_x,
                region.min_y,
                region.max_y,
            ),
            Interference::TooClose {
                a,
                b,
                gap_mm,
                required_mm,
                cutter_diameter_mm,
                margin_mm,
            } => format!(
                "part `{}` and part `{}` are TOO CLOSE to cut between: {:.3}mm of clear \
                 material where {:.3}mm is required ({:.3}mm cutter + {:.3}mm margin). \
                 The tool does not fit down the channel and would take the edge off BOTH. \
                 The material between them is intact — move them {:.3}mm further apart",
                a.qualified(),
                b.qualified(),
                gap_mm,
                required_mm,
                cutter_diameter_mm,
                margin_mm,
                (required_mm - gap_mm).max(0.0),
            ),
            Interference::NotChecked { a, b, why } => format!(
                "part `{}` and part `{}` could NOT be checked against each other: {why}. \
                 An unchecked pair is not a clear pair — this job must not be posted",
                a.qualified(),
                b.qualified(),
            ),
        }
    }

    /// As a [`Refusal`], so a caller can push it into a `JobResult` without this
    /// module knowing anything about job assembly.
    pub fn to_refusal(&self) -> Refusal {
        let (a, b) = self.parts();
        Refusal { what: format!("{} vs {}", a.qualified(), b.qualified()), why: self.describe() }
    }
}

// ---------------------------------------------------------------------------
// Errors at the door
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LayoutError {
    /// A drawing with no id cannot name its own parts, so nothing could say
    /// which drawing a refusal is about.
    EmptyId,
    /// Two drawings with one id: `remove` becomes ambiguous and their operations
    /// collide by name.
    DuplicateId(String),
    /// No parts, or no measurable extent. A drawing with nothing in it cannot be
    /// placed, and placing it at "nowhere" would be a silent no-op the user
    /// would read as an added drawing.
    NoGeometry(String),
}

impl LayoutError {
    pub fn describe(&self) -> String {
        match self {
            LayoutError::EmptyId => {
                "a drawing must have an id — its parts and operations are named from it".into()
            }
            LayoutError::DuplicateId(id) => format!(
                "there is already a drawing called `{id}` on this workpiece — two would share \
                 operation names and `remove` could not tell them apart"
            ),
            LayoutError::NoGeometry(id) => format!(
                "drawing `{id}` has no measurable geometry, so there is nothing to place"
            ),
        }
    }
}

impl std::fmt::Display for LayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.describe())
    }
}

impl std::error::Error for LayoutError {}

// ---------------------------------------------------------------------------
// A drawing, placed
// ---------------------------------------------------------------------------

/// One imported drawing, with a position and a rotation on the workpiece.
///
/// The geometry is held as imported and transformed on demand
/// ([`PlacedDrawing::placed_parts`]), so moving a drawing is a change of two
/// numbers rather than a re-transform that accumulates rounding every time
/// somebody drags it.
#[derive(Clone, Debug)]
pub struct PlacedDrawing {
    id: String,
    parts: Vec<Part>,
    /// Extent of `parts` AS IMPORTED. Cached at construction because the
    /// rotation is about this extent's lower-left corner; if it were recomputed
    /// from already-placed geometry the corner would move each time.
    drawn: Extent,

    /// Where the drawing's lower-left corner sits, in workpiece coordinates.
    pub x_mm: f64,
    pub y_mm: f64,
    /// Degrees anticlockwise about the drawing's own lower-left corner, with the
    /// drawing then pushed back so that corner stays on `(x_mm, y_mm)`. Exactly
    /// [`Stock::rotation_deg`]'s meaning, because it is computed by the same
    /// code.
    pub rotation_deg: f64,

    /// 🔴 **WHICH WORKPIECE THIS DRAWING IS ON — the SCOPE the pair check compares
    /// within, made explicit while there is still only one of them.**
    ///
    /// Every placement in this module is in WORKPIECE-LOCAL millimetres; the workpiece's
    /// own datum is applied afterwards by [`crate::job::Job::place`]. So two
    /// parts at the same workpiece-local coordinates are the same piece of material
    /// **only if they are on the same workpiece** — and today they always are,
    /// because there is exactly one.
    ///
    /// ⚠ **AN INVARIANT THAT IS TRUE BECAUSE THERE IS ONLY ONE OF SOMETHING IS
    /// NOT AN INVARIANT, IT IS A COINCIDENCE.** It reads as a rule until the
    /// second one arrives. When multiple workpieces land (TODO #64, which the
    /// founder has asked for twice), two copies of one part sitting on two
    /// DIFFERENT workpieces would read as a 100% overlap and the job would be
    /// refused with zero bytes — a total false red on a perfectly good nest,
    /// produced by a check that was right when it was written.
    ///
    /// So the comparison is keyed on this field NOW, while it is always
    /// [`ONE_SHEET`]. #64 then relaxes a value rather than rewriting the check
    /// and the gate that holds it.
    ///
    /// 🔴 **It does not make this crate multi-workpiece, and nothing else here has
    /// been changed to pretend otherwise.** Two facts that would have to move
    /// first, recorded so they are not discovered by a wrong cut: SVG intake
    /// Y-FLIPS against `stock.size_y_mm` at INTAKE, before any placement is
    /// applied, so a part's workpiece has to be known before its geometry is read;
    /// and `material` is a field of [`crate::job::Job`], not of [`Stock`], so
    /// two materials on one workpiece cannot be expressed at all.
    pub sheet_id: String,
}

/// The one workpiece, while there is one. Not `""`: an empty scope reads as
/// "unscoped", and the whole point of the field is that a comparison always has
/// a scope even when there is only one.
pub const ONE_SHEET: &str = "sheet";

impl PlacedDrawing {
    /// `parts` are the drawing's parts as imported ([`crate::import::to_parts`]).
    pub fn new(id: impl Into<String>, parts: Vec<Part>) -> Result<Self, LayoutError> {
        let id = id.into();
        if id.trim().is_empty() {
            return Err(LayoutError::EmptyId);
        }
        let drawn = Extent::from_parts(&parts).ok_or_else(|| LayoutError::NoGeometry(id.clone()))?;
        Ok(Self {
            id,
            parts,
            drawn,
            x_mm: 0.0,
            y_mm: 0.0,
            rotation_deg: 0.0,
            sheet_id: ONE_SHEET.to_string(),
        })
    }

    pub fn at(mut self, x_mm: f64, y_mm: f64) -> Self {
        self.x_mm = x_mm;
        self.y_mm = y_mm;
        self
    }

    pub fn rotated(mut self, deg: f64) -> Self {
        self.rotation_deg = deg;
        self
    }

    /// Put this drawing on a named workpiece. Nothing outside this crate calls it
    /// yet — see [`PlacedDrawing::sheet_id`] for why it exists before it is
    /// needed.
    pub fn on_sheet(mut self, sheet_id: impl Into<String>) -> Self {
        self.sheet_id = sheet_id.into();
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The parts as imported — untransformed.
    pub fn parts(&self) -> &[Part] {
        &self.parts
    }

    /// Extent of the drawing as imported.
    pub fn drawn_extent(&self) -> Extent {
        self.drawn
    }

    /// The placement frame — **a [`Stock`], on purpose**.
    ///
    /// A drawing on a workpiece and a workpiece on a machine are the same transform: rotate
    /// about the lower-left corner, push back so that corner lands on the datum,
    /// then offset. [`Stock::place`] already does it, with exact quarter turns
    /// and the push-back that keeps the datum a number a person can measure. Any
    /// second implementation here would be a second placement model, and the day
    /// the two disagreed the difference would be a part cut at an angle nobody
    /// chose.
    ///
    /// Only `size_*`, `origin_*` and `rotation_deg` are meaningful; the rest is
    /// `Stock::default()` and is never read by [`Stock::place`].
    pub fn frame(&self) -> Stock {
        Stock {
            size_x_mm: self.drawn.width(),
            size_y_mm: self.drawn.height(),
            origin_x_mm: self.x_mm,
            origin_y_mm: self.y_mm,
            rotation_deg: self.rotation_deg,
            ..Stock::default()
        }
    }

    /// True when this drawing is laid square to the workpiece. Anything else is
    /// runnable arithmetic and a fixturing problem — see
    /// [`Stock::is_square_to_the_bed`], whose reasoning applies unchanged.
    pub fn is_square(&self) -> bool {
        self.frame().is_square_to_the_bed()
    }

    /// The parts with the placement applied, renamed `drawing/part`.
    ///
    /// 🔴 The transform is applied to the **full** geometry — outer boundary and
    /// every interior hole. That is gate P8's failure, per part: a placed
    /// outline whose holes stayed behind looks entirely correct and cuts parts
    /// with no rabbets and no bores.
    pub fn placed_parts(&self) -> Vec<Part> {
        let frame = self.frame();
        let (ox, oy) = (self.drawn.min_x, self.drawn.min_y);
        let move_vertex = |v: &mut Vertex| {
            let (x, y) = frame.place(v.x - ox, v.y - oy);
            v.x = x;
            v.y = y;
            // The bulge is untouched: it encodes SWEEP, not orientation, and the
            // frame is a rotation plus a translation — no reflection, no scale.
        };

        self.parts
            .iter()
            .map(|p| {
                let mut p = p.clone();
                p.name = qualified_name(&self.id, &p.name);
                p.outer.verts.iter_mut().for_each(move_vertex);
                for h in &mut p.inners {
                    h.verts.iter_mut().for_each(move_vertex);
                }
                p
            })
            .collect()
    }

    /// Extent of this drawing where it now sits.
    pub fn placed_extent(&self) -> Option<Extent> {
        Extent::from_parts(&self.placed_parts())
    }
}

/// A part after placement, with the drawing it came from still attached.
#[derive(Clone, Debug)]
pub struct LaidOutPart {
    /// The drawing's id.
    pub drawing: String,
    /// The workpiece this part is cut from — the SCOPE the pair check compares
    /// within. See [`PlacedDrawing::sheet_id`].
    pub sheet_id: String,
    /// The part's name as imported — `part.name` is the qualified form.
    pub source_name: String,
    /// Geometry in workpiece coordinates, holes included.
    pub part: Part,
}

impl LaidOutPart {
    pub fn part_ref(&self) -> PartRef {
        PartRef { drawing: self.drawing.clone(), part: self.source_name.clone() }
    }
}

// ---------------------------------------------------------------------------
// The workpiece
// ---------------------------------------------------------------------------

/// Every drawing currently on the workpiece, in the order they were added.
#[derive(Clone, Debug, Default)]
pub struct Layout {
    drawings: Vec<PlacedDrawing>,
}

impl Layout {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a drawing. Refuses a duplicate id rather than disambiguating one,
    /// because a silently renamed drawing is a drawing the user cannot find
    /// again.
    pub fn add(&mut self, drawing: PlacedDrawing) -> Result<(), LayoutError> {
        if self.drawings.iter().any(|d| d.id == drawing.id) {
            return Err(LayoutError::DuplicateId(drawing.id));
        }
        self.drawings.push(drawing);
        Ok(())
    }

    /// Remove a drawing and hand it back, so a UI can offer an undo without
    /// re-importing.
    ///
    /// Removing is the harder half of the founder's ask (TODO #31) and this is
    /// where it is made safe: **nothing is numbered by position**. Operation
    /// names come from `drawing/part`, so removing one drawing cannot renumber
    /// another one's operations — the names a person was reading a moment ago
    /// still say the same thing.
    pub fn remove(&mut self, id: &str) -> Option<PlacedDrawing> {
        let i = self.drawings.iter().position(|d| d.id == id)?;
        Some(self.drawings.remove(i))
    }

    pub fn get(&self, id: &str) -> Option<&PlacedDrawing> {
        self.drawings.iter().find(|d| d.id == id)
    }

    /// Mutable access for moving and rotating. The id and the geometry are not
    /// reachable this way — changing either would break the uniqueness `add`
    /// checked and the extent the rotation is measured about.
    pub fn get_mut(&mut self, id: &str) -> Option<&mut PlacedDrawing> {
        self.drawings.iter_mut().find(|d| d.id == id)
    }

    pub fn drawings(&self) -> &[PlacedDrawing] {
        &self.drawings
    }

    pub fn len(&self) -> usize {
        self.drawings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.drawings.is_empty()
    }

    /// Every part on the workpiece, placed, with its drawing still attached.
    pub fn laid_out(&self) -> Vec<LaidOutPart> {
        let mut out = Vec::new();
        for d in &self.drawings {
            for (placed, source) in d.placed_parts().into_iter().zip(d.parts().iter()) {
                out.push(LaidOutPart {
                    drawing: d.id.clone(),
                    sheet_id: d.sheet_id.clone(),
                    source_name: source.name.clone(),
                    part: placed,
                });
            }
        }
        out
    }

    /// Every part on the workpiece, placed.
    pub fn parts(&self) -> Vec<Part> {
        self.laid_out().into_iter().map(|l| l.part).collect()
    }

    /// The UNION extent of everything on the workpiece.
    ///
    /// 🔴 This is the extent the workpiece-fit and travel questions are asked about,
    /// **not** each part's. A job whose parts each fit but whose union does not
    /// is a job that cannot be cut in one setup. `None` when the workpiece is empty —
    /// an absent extent and a zero extent are different facts.
    pub fn extent(&self) -> Option<Extent> {
        Extent::from_parts(&self.parts())
    }

    /// The travel question, asked of the union — answered by
    /// [`crate::placement`], which owns it.
    ///
    /// `tool_radius_mm` is how far outside the geometry the tool centre runs, and
    /// it is the caller's to supply for the same reason it is there: this module
    /// cannot see which side of which contour the tool runs on. `None` when the
    /// workpiece is empty.
    ///
    /// 🔴 The answer comes back on [`crate::placement::ExtentBasis::Drawing`],
    /// because that is what a union of placed OUTLINES is. Leads, lead-outs and
    /// ramp entries are cut outside those outlines and are not in it, so the
    /// shift this reports is a **floor** — a UI must not word it as "apply this
    /// and it will run". The final answer comes from the planned path, in
    /// [`crate::job`].
    pub fn plan_placement(
        &self,
        tool_radius_mm: f64,
        margin_mm: f64,
        machine: &Machine,
    ) -> Option<Placement> {
        Some(plan_datum_shift(self.extent()?, tool_radius_mm, margin_mm, machine))
    }

    /// Operations for every part on the workpiece, each part complete before the
    /// next starts.
    ///
    /// Names are `drawing/part` and `drawing/part-holeN`, from
    /// [`operations_for_part`] — so a refusal's [`PartRef::qualified`] is a
    /// prefix of exactly the operations that refusal is about, and of no others.
    ///
    /// ⚠ The order here is the SAFE one (finish a part before starting the
    /// next). [`crate::job`] regroups by tool, which is the fast one and
    /// interleaves parts. See the module header — this module states the
    /// trade-off and does not decide it.
    pub fn operations(&self, tool: &Tool, params: &OperationParams) -> Vec<Operation> {
        self.parts().iter().flat_map(|p| operations_for_part(p, tool, params)).collect()
    }

    /// 🔴 **The check.** Every pair of parts on the workpiece, against each other.
    ///
    /// An empty result means every pair was examined and every pair is clear.
    /// It does NOT mean "nothing was wrong" when a pair could not be examined —
    /// that pair comes back as [`Interference::NotChecked`].
    pub fn check(&self, clearance: &Clearance) -> Vec<Interference> {
        check_interference(&self.laid_out(), clearance)
    }

    /// Non-fatal observations. Placement that is not a quarter turn is runnable
    /// arithmetic and a fixturing problem, so it warns rather than refuses — the
    /// reasoning is [`Stock::is_square_to_the_bed`]'s and is not restated here.
    pub fn notes(&self) -> Vec<String> {
        self.drawings
            .iter()
            .filter(|d| !d.is_square())
            .map(|d| {
                format!(
                    "drawing `{}` is placed at {:.3} degrees, which is not a quarter turn: it \
                     cannot be registered against the machine's own axes, so the whole part \
                     inherits whatever angle it actually ends up at",
                    d.id, d.rotation_deg
                )
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// The check itself
// ---------------------------------------------------------------------------

/// Every pair, checked for shared material first and for cutter clearance
/// second.
///
/// **Pairs from the SAME drawing are checked too.** A nest file that puts two
/// parts 3mm apart is as unrunnable as two drawings dropped 3mm apart — the
/// cutter does not know which file a part came from. Such a finding is a defect
/// in the drawing and belongs upstream with `cad` as a ticket, but it is still
/// this job's refusal.
pub fn check_interference(parts: &[LaidOutPart], clearance: &Clearance) -> Vec<Interference> {
    let required = clearance.required_mm();
    let mut findings = Vec::new();

    for i in 0..parts.len() {
        for j in (i + 1)..parts.len() {
            let (a, b) = (&parts[i], &parts[j]);
            // 🔴 TWO PARTS ARE COMPARED BECAUSE THEY SHARE A WORKPIECE, NOT BECAUSE
            // THEY ARE BOTH IN THE LIST. Every coordinate here is WORKPIECE-LOCAL —
            // the datum is applied later, by `Job::place` — so identical
            // coordinates on two different workpieces are two different pieces of
            // material, and comparing them would refuse a perfectly good nest
            // with zero bytes of G-code.
            //
            // Today every part carries `ONE_SHEET` and this never skips
            // anything. It is written now anyway, because the alternative is an
            // invariant that holds only while there is one workpiece — which is a
            // coincidence wearing a rule's clothes, and it stops being true
            // silently.
            if a.sheet_id != b.sheet_id {
                continue;
            }
            let (ra, rb) = (a.part_ref(), b.part_ref());

            // Sound fast path, in the CLEAR direction only. A bounding box
            // contains its shape, so boxes that are `required` apart guarantee
            // the shapes are at least that far apart. Boxes that are closer
            // guarantee nothing at all, and fall through to the real test.
            match (a.part.outer.bounds(), b.part.outer.bounds()) {
                (Some(ba), Some(bb)) if box_gap(ba, bb) >= required - EPS => continue,
                _ => {}
            }

            match shared_material(&a.part.outer, &b.part.outer) {
                Err(why) => {
                    findings.push(Interference::NotChecked { a: ra, b: rb, why });
                    continue;
                }
                Ok(Some(shared)) => {
                    findings.push(Interference::Overlap {
                        a: ra,
                        b: rb,
                        region: shared.region,
                        over_x_mm: shared.region.width(),
                        over_y_mm: shared.region.height(),
                        area_mm2: shared.area_mm2,
                    });
                    continue;
                }
                Ok(None) => {}
            }

            // Not overlapping. Is there room for the cutter?
            match within(&a.part.outer, &b.part.outer, required) {
                Err(why) => findings.push(Interference::NotChecked { a: ra, b: rb, why }),
                Ok(false) => {}
                Ok(true) => {
                    let gap = measure_gap(&a.part.outer, &b.part.outer, required);
                    match gap {
                        Err(why) => findings.push(Interference::NotChecked { a: ra, b: rb, why }),
                        Ok(gap_mm) => findings.push(Interference::TooClose {
                            a: ra,
                            b: rb,
                            gap_mm,
                            required_mm: required,
                            cutter_diameter_mm: clearance.cutter_diameter_mm(),
                            margin_mm: clearance.margin_mm(),
                        }),
                    }
                }
            }
        }
    }

    findings
}

/// Minimum distance between two axis-aligned boxes, `0.0` when they touch or
/// intersect.
fn box_gap(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> f64 {
    let dx = (b.0 - a.2).max(a.0 - b.2).max(0.0);
    let dy = (b.1 - a.3).max(a.1 - b.3).max(0.0);
    (dx * dx + dy * dy).sqrt()
}

struct Shared {
    region: Extent,
    area_mm2: f64,
}

/// Material claimed by both contours, measured on the real boundaries — arcs
/// included, not on their bounding boxes.
///
/// 🔴 Bounding boxes were rejected here deliberately. Two L-shaped parts can
/// interlock so that each sits inside the other's box while sharing no material
/// at all; a box test refuses that nest, and refusing a legal nest teaches people
/// to ignore the check that also catches the illegal one.
///
/// `Err` when the question could not be asked — an unclosed boundary, or a
/// boolean the library rejected. Never a silent `Ok(None)`: "no shared material"
/// and "could not tell" are different facts and only the first is safe.
fn shared_material(a: &Contour, b: &Contour) -> Result<Option<Shared>, String> {
    if !a.closed || a.verts.len() < 2 {
        return Err("the first part's outer boundary is not a closed loop, so it encloses no \
                    material to compare"
            .into());
    }
    if !b.closed || b.verts.len() < 2 {
        return Err("the second part's outer boundary is not a closed loop, so it encloses no \
                    material to compare"
            .into());
    }

    // Both counter-clockwise so "positive space" means material for both.
    let (mut ca, mut cb) = (a.clone(), b.clone());
    ca.normalise_winding(true);
    cb.normalise_winding(true);
    let (pa, pb) = (to_pline(&ca), to_pline(&cb));

    let res = pa.boolean(&pb, BooleanOp::And);
    match res.result_info {
        BooleanResultInfo::InvalidInput => {
            return Err("the geometry library refused the intersection as invalid input \
                        (a self-intersecting boundary will do this)"
                .into())
        }
        BooleanResultInfo::Disjoint => return Ok(None),
        _ => {}
    }

    let mut region: Option<Extent> = None;
    let mut area = 0.0;
    for r in &res.pos_plines {
        area += r.pline.area().abs();
        if let Some(e) = r.pline.extents() {
            let next = Extent::new(e.min_x, e.min_y, e.max_x, e.max_y)
                .ok_or_else(|| "the shared region has no measurable extent".to_string())?;
            region = Some(match region {
                None => next,
                Some(acc) => Extent {
                    min_x: acc.min_x.min(next.min_x),
                    min_y: acc.min_y.min(next.min_y),
                    max_x: acc.max_x.max(next.max_x),
                    max_y: acc.max_y.max(next.max_y),
                },
            });
        }
    }

    if let Some(region) = region {
        return Ok(Some(Shared { region, area_mm2: area }));
    }

    // Total containment and exact coincidence are reported by `result_info`
    // without necessarily handing back a region. The smaller shape IS the shared
    // material in both cases, so the answer is still a measurement and not a
    // guess.
    let whole = |c: &Contour| -> Result<Shared, String> {
        let (min_x, min_y, max_x, max_y) =
            c.bounds().ok_or_else(|| "a contained part has no bounds".to_string())?;
        let region = Extent::new(min_x, min_y, max_x, max_y)
            .ok_or_else(|| "a contained part has an inverted extent".to_string())?;
        Ok(Shared { region, area_mm2: c.signed_area().abs() })
    };
    match res.result_info {
        BooleanResultInfo::Pline1InsidePline2 | BooleanResultInfo::Overlapping => {
            Ok(Some(whole(&ca)?))
        }
        BooleanResultInfo::Pline2InsidePline1 => Ok(Some(whole(&cb)?)),
        other => Err(format!(
            "the intersection reported `{other:?}` but returned no region, so the amount of \
             shared material could not be measured"
        )),
    }
}

/// Is there less than `d` mm of clear material between `a` and `b`?
///
/// Asked by growing `a` outward by `d` and intersecting: the grown shape reaches
/// `b` exactly when the gap is under `d`. Same boolean, same arcs, same library
/// as the overlap test — so the two questions cannot answer on different
/// geometry.
fn within(a: &Contour, b: &Contour, d: f64) -> Result<bool, String> {
    if d <= 0.0 {
        return Ok(false);
    }
    let grown = a.offset(d);
    if grown.is_empty() {
        return Err(format!(
            "growing the first part by {d:.3}mm produced no boundary, so the clearance \
             between the two could not be measured"
        ));
    }
    for g in &grown {
        match shared_material(g, b) {
            Err(why) => return Err(why),
            Ok(Some(_)) => return Ok(true),
            Ok(None) => {}
        }
    }
    Ok(false)
}

/// The clear material between two NON-overlapping contours, in mm.
///
/// Found by bisecting the same offset that produced the refusal: the largest
/// growth of `a` that still does not reach `b` is the gap. The number therefore
/// comes from the identical operation as the verdict — it cannot report a gap
/// the check disagrees with, which a separate distance estimator could.
///
/// Returns a LOWER bound, within `upper / 2^GAP_BISECTIONS`. Under-reading a gap
/// in a refusal is the safe direction.
fn measure_gap(a: &Contour, b: &Contour, upper: f64) -> Result<f64, String> {
    // Invariant: `lo` is known clear, `hi` is known to touch. Growth is
    // monotone, so bisection is sound.
    let (mut lo, mut hi) = (0.0f64, upper);
    for _ in 0..GAP_BISECTIONS {
        let mid = 0.5 * (lo + hi);
        if within(a, b, mid)? {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    Ok(lo)
}

/// Local bridge to the geometry library.
///
/// `Contour`'s own conversion is private to [`crate::geometry`], and this module
/// does not edit that file. This is the same six lines and nothing more — no
/// second geometry model, no second winding convention.
fn to_pline(c: &Contour) -> Polyline {
    let mut p = Polyline::with_capacity(c.verts.len(), c.closed);
    for v in &c.verts {
        p.add(v.x, v.y, v.bulge);
    }
    p
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CutSide, OperationParams, Tool};

    fn tool6() -> Tool {
        Tool { name: "6mm 2F".into(), diameter_mm: 6.0, ..Tool::default() }
    }

    /// 6mm cutter + 1mm margin = 7mm of clear material required.
    fn clearance() -> Clearance {
        Clearance::from_tool(&tool6(), 1.0).expect("a 6mm tool is a valid clearance basis")
    }

    fn plate(name: &str) -> Part {
        Part::new(name, Contour::rect(0.0, 0.0, 100.0, 50.0))
    }

    /// 🔴 The SCOPE of the pair check, asserted while there is only one workpiece.
    ///
    /// Nothing outside this crate can put two drawings on different workpieces yet,
    /// and that is exactly why this exists: the day #64 makes it possible, the
    /// check has to already know that identical WORKPIECE-LOCAL coordinates on two
    /// different workpieces are two different pieces of material. Without it, two
    /// copies of one part on two workpieces read as a 100% overlap and the whole job
    /// is refused with zero bytes — a total false red, produced by a check that
    /// was right when it was written.
    #[test]
    fn parts_on_different_sheets_are_not_compared_with_each_other() {
        let a = PlacedDrawing::new("a", vec![plate("p1")]).unwrap().at(0.0, 0.0);
        let b = PlacedDrawing::new("b", vec![plate("p1")]).unwrap().at(0.0, 0.0);

        // Same workpiece, same spot: an overlap, and it must be found.
        let mut one = Layout::new();
        one.add(a.clone()).unwrap();
        one.add(b.clone()).unwrap();
        let found = one.check(&clearance());
        assert_eq!(found.len(), 1, "two parts on one workpiece at one spot were not refused");
        assert!(matches!(found[0], Interference::Overlap { .. }));

        // Different workpieces, same workpiece-local spot: NOT the same material.
        let mut two = Layout::new();
        two.add(a.on_sheet("board 1")).unwrap();
        two.add(b.on_sheet("board 2")).unwrap();
        assert!(
            two.check(&clearance()).is_empty(),
            "two parts on DIFFERENT workpieces were compared against each other — the pair check is \
             scoped by list membership rather than by the material the parts are cut from"
        );
    }

    fn drawing(id: &str, x: f64, y: f64) -> PlacedDrawing {
        PlacedDrawing::new(id, vec![plate("p1")]).expect("a plate is geometry").at(x, y)
    }

    fn sheet(a: PlacedDrawing, b: PlacedDrawing) -> Layout {
        let mut l = Layout::new();
        l.add(a).expect("first drawing");
        l.add(b).expect("second drawing");
        l
    }

    // -----------------------------------------------------------------------
    // 🔴 The two refusals this module exists for
    // -----------------------------------------------------------------------

    #[test]
    fn two_parts_on_the_same_material_are_refused_by_name_with_the_amount() {
        // `a` spans X 0..100, Y 0..50. `b` is dropped so it laps 12.4mm into it
        // in X and 30mm in Y.
        let l = sheet(drawing("a", 0.0, 0.0), drawing("b", 87.6, 20.0));
        let found = l.check(&clearance());
        assert_eq!(found.len(), 1, "expected exactly one finding: {found:?}");

        let Interference::Overlap { a, b, over_x_mm, over_y_mm, area_mm2, region } = &found[0]
        else {
            panic!("two parts cut from the same material were not refused as an overlap: {found:?}");
        };

        // Both parts named, drawing AND part — "part1 overlaps" would be
        // ambiguous the moment two drawings each have a part1.
        assert_eq!(a.qualified(), "a/p1");
        assert_eq!(b.qualified(), "b/p1");

        // ...and the amount, measured, not "they overlap".
        assert!((over_x_mm - 12.4).abs() < 1e-6, "over_x {over_x_mm}");
        assert!((over_y_mm - 30.0).abs() < 1e-6, "over_y {over_y_mm}");
        assert!((area_mm2 - 12.4 * 30.0).abs() < 1e-3, "area {area_mm2}");
        assert!((region.min_x - 87.6).abs() < 1e-6, "{region:?}");
        assert!((region.max_x - 100.0).abs() < 1e-6, "{region:?}");
        assert!((region.min_y - 20.0).abs() < 1e-6, "{region:?}");
        assert!((region.max_y - 50.0).abs() < 1e-6, "{region:?}");

        let d = found[0].describe();
        assert!(d.contains("a/p1") && d.contains("b/p1"), "{d}");
        assert!(d.contains("OVERLAP"), "{d}");
        assert!(d.contains("12.400mm in X"), "{d}");
        assert!(d.contains("30.000mm in Y"), "{d}");
        // The fixes differ, so the words must too.
        assert!(!d.contains("TOO CLOSE"), "an overlap was described as a spacing problem: {d}");

        // And it converts to something a job can refuse on.
        let r = found[0].to_refusal();
        assert_eq!(r.what, "a/p1 vs b/p1");
    }

    #[test]
    fn two_parts_closer_than_the_cutter_are_refused_as_too_close_and_not_as_an_overlap() {
        // 🔴 The trap: these parts do NOT share a single square millimetre. A
        // check that only looked for overlap calls this clean, and a 6mm cutter
        // driven down the 3mm channel takes the edge off both.
        let l = sheet(drawing("a", 0.0, 0.0), drawing("b", 103.0, 0.0));
        let found = l.check(&clearance());
        assert_eq!(found.len(), 1, "expected exactly one finding: {found:?}");

        let Interference::TooClose { a, b, gap_mm, required_mm, cutter_diameter_mm, margin_mm } =
            &found[0]
        else {
            panic!("parts 3mm apart with a 6mm cutter were not refused as too close: {found:?}");
        };
        assert_eq!(a.qualified(), "a/p1");
        assert_eq!(b.qualified(), "b/p1");
        assert!((gap_mm - 3.0).abs() < 1e-3, "the measured gap is wrong: {gap_mm}");
        assert!(*gap_mm <= 3.0 + 1e-9, "the gap must not be over-read: {gap_mm}");
        assert!((required_mm - 7.0).abs() < 1e-9, "{required_mm}");
        assert!((cutter_diameter_mm - 6.0).abs() < 1e-9);
        assert!((margin_mm - 1.0).abs() < 1e-9);

        let d = found[0].describe();
        assert!(d.contains("a/p1") && d.contains("b/p1"), "{d}");
        assert!(d.contains("TOO CLOSE"), "{d}");
        assert!(d.contains("3.000mm of clear material"), "{d}");
        assert!(d.contains("7.000mm is required"), "{d}");
        assert!(d.contains("6.000mm cutter"), "{d}");
        // 🔴 The two failures have different fixes — re-nest vs move apart — so
        // the message must not read as the other one.
        assert!(
            !d.to_ascii_uppercase().contains("OVERLAP"),
            "a spacing problem was described as shared material, which sends a person to the \
             wrong fix: {d}"
        );
        assert!(d.contains("move them 4.000mm further apart"), "{d}");
    }

    #[test]
    fn properly_spaced_parts_plan_with_nothing_to_report() {
        // 10mm apart, 7mm required.
        let l = sheet(drawing("a", 0.0, 0.0), drawing("b", 110.0, 0.0));
        assert!(l.check(&clearance()).is_empty(), "{:?}", l.check(&clearance()));

        // Exactly on the limit is legal — the refusal is for LESS than required,
        // not for "not comfortably more".
        let on_limit = sheet(drawing("a", 0.0, 0.0), drawing("b", 107.0, 0.0));
        assert!(on_limit.check(&clearance()).is_empty(), "{:?}", on_limit.check(&clearance()));

        // And one millimetre under it is not.
        let under = sheet(drawing("a", 0.0, 0.0), drawing("b", 106.0, 0.0));
        assert!(
            matches!(under.check(&clearance()).as_slice(), [Interference::TooClose { .. }]),
            "6.000mm of clearance for a 7.000mm requirement was accepted"
        );
    }

    #[test]
    fn the_required_clearance_is_the_cutters_and_a_bigger_cutter_refuses_more() {
        // The gap that a 6mm cutter cannot use is fine for a 3mm one — which is
        // the whole reason the diameter is a parameter and not a constant.
        let l = sheet(drawing("a", 0.0, 0.0), drawing("b", 105.0, 0.0));
        let small = Clearance::new(3.0, 1.0).unwrap();
        assert!(l.check(&small).is_empty(), "5mm is enough for a 3mm cutter: {:?}", l.check(&small));
        assert!(!l.check(&clearance()).is_empty(), "5mm is not enough for a 6mm cutter");
    }

    #[test]
    fn a_clearance_cannot_be_built_without_a_declared_cutter() {
        assert!(Clearance::new(0.0, 1.0).is_none(), "a zero-diameter cutter was accepted");
        assert!(Clearance::new(-6.0, 1.0).is_none(), "a negative diameter was accepted");
        assert!(Clearance::new(f64::NAN, 1.0).is_none(), "NaN diameter was accepted");
        assert!(Clearance::new(6.0, -1.0).is_none(), "a negative margin was accepted");
        assert_eq!(Clearance::new(6.0, 1.0).unwrap().required_mm(), 7.0);
    }

    #[test]
    fn a_pair_that_cannot_be_checked_is_reported_rather_than_passed() {
        // 🔴 Negative control for the whole module: a check that cannot run must
        // not come back clean. An open outer boundary encloses nothing, so there
        // is no material to compare — that is a finding, not a pass.
        let open = Part {
            name: "p1".into(),
            outer: Contour::open(vec![
                Vertex::line(0.0, 0.0),
                Vertex::line(100.0, 0.0),
                Vertex::line(100.0, 50.0),
            ]),
            inners: Vec::new(),
        };
        let mut l = Layout::new();
        l.add(PlacedDrawing::new("a", vec![open]).unwrap().at(0.0, 0.0)).unwrap();
        l.add(drawing("b", 20.0, 10.0)).unwrap();

        let found = l.check(&clearance());
        assert_eq!(found.len(), 1, "{found:?}");
        let Interference::NotChecked { a, b, why } = &found[0] else {
            panic!("an unrunnable check reported a verdict: {found:?}");
        };
        assert_eq!(a.qualified(), "a/p1");
        assert_eq!(b.qualified(), "b/p1");
        assert!(why.contains("closed"), "{why}");
        assert!(found[0].describe().contains("NOT be checked"), "{}", found[0].describe());
    }

    #[test]
    fn parts_from_the_same_drawing_are_checked_against_each_other_too() {
        // A nest file with two parts 3mm apart is as unrunnable as two drawings
        // 3mm apart. The cutter does not know which file a part came from.
        let mut a = plate("left");
        a.name = "left".into();
        let mut b = Part::new("right", Contour::rect(103.0, 0.0, 100.0, 50.0));
        b.name = "right".into();
        let mut l = Layout::new();
        l.add(PlacedDrawing::new("nest", vec![a, b]).unwrap()).unwrap();

        let found = l.check(&clearance());
        assert_eq!(found.len(), 1, "{found:?}");
        let (ra, rb) = found[0].parts();
        assert_eq!(ra.qualified(), "nest/left");
        assert_eq!(rb.qualified(), "nest/right");
    }

    // -----------------------------------------------------------------------
    // Placement
    // -----------------------------------------------------------------------

    #[test]
    fn a_placed_drawings_holes_travel_and_turn_with_its_outline() {
        // 🔴 P8, per part. A placed outline whose holes stayed behind looks
        // entirely correct and cuts a plate with no bores.
        let p = Part::new("plate", Contour::rect(0.0, 0.0, 100.0, 50.0))
            .with_hole(Contour::circle(50.0, 25.0, 5.0));
        let d = PlacedDrawing::new("dxf", vec![p]).unwrap().at(200.0, 300.0).rotated(90.0);

        let placed = d.placed_parts();
        assert_eq!(placed.len(), 1);
        assert_eq!(placed[0].inners.len(), 1, "the hole did not survive placement");

        // A quarter turn of a 100x50 drawing lands its corner exactly on the
        // datum: X 200..250, Y 300..400.
        let (ox0, oy0, ox1, oy1) = placed[0].outer.bounds().unwrap();
        assert_eq!((ox0, oy0), (200.0, 300.0), "the corner is not exactly on the datum");
        assert!((ox1 - 250.0).abs() < 1e-9 && (oy1 - 400.0).abs() < 1e-9, "outer {ox1} {oy1}");

        // The hole was at 45..55 x 20..30 in the drawing; turned and placed it is
        // at 220..230 x 345..355. A transform applied to the outline alone would
        // have left it at 45..55 x 20..30.
        let (hx0, hy0, hx1, hy1) = placed[0].inners[0].bounds().unwrap();
        assert!((hx0 - 220.0).abs() < 1e-6 && (hx1 - 230.0).abs() < 1e-6, "hole x {hx0}..{hx1}");
        assert!((hy0 - 345.0).abs() < 1e-6 && (hy1 - 355.0).abs() < 1e-6, "hole y {hy0}..{hy1}");

        // And it is still a circle — the bulges came through the rotation intact,
        // so it will still be recognised as drillable.
        let (cx, cy, r) = placed[0].inners[0]
            .as_circle()
            .expect("the rotation turned a circle into something that is not one");
        assert!((cx - 225.0).abs() < 1e-6 && (cy - 350.0).abs() < 1e-6, "centre {cx},{cy}");
        assert!((r - 5.0).abs() < 1e-6, "radius {r}");
    }

    #[test]
    fn the_union_extent_is_the_union_and_not_the_first_drawings() {
        let l = sheet(drawing("a", 0.0, 0.0), drawing("b", 300.0, 200.0));
        let e = l.extent().expect("two drawings have an extent");

        // `a` alone is 0..100 x 0..50. The union has to reach `b`'s far corner.
        assert!((e.min_x - 0.0).abs() < 1e-9, "{e:?}");
        assert!((e.min_y - 0.0).abs() < 1e-9, "{e:?}");
        assert!((e.max_x - 400.0).abs() < 1e-9, "the union stopped at the first drawing: {e:?}");
        assert!((e.max_y - 250.0).abs() < 1e-9, "the union stopped at the first drawing: {e:?}");

        // ...and the travel question is asked of that union, by placement.rs.
        let m = Machine::default(); // 600 x 900
        let p = l.plan_placement(3.0, 0.0, &m).expect("a non-empty workpiece has a placement");
        assert!(p.fits(), "{p:?}");

        // A drawing far enough out to break the union breaks the job, even though
        // each drawing on its own fits comfortably.
        let far = sheet(drawing("a", 0.0, 0.0), drawing("b", 550.0, 0.0));
        let p = far.plan_placement(3.0, 0.0, &m).unwrap();
        assert!(!p.fits(), "a union 656mm wide was accepted on 600mm of travel: {p:?}");

        assert!(Layout::new().extent().is_none(), "an empty workpiece is not a zero extent");
        assert!(Layout::new().plan_placement(3.0, 0.0, &m).is_none());
    }

    #[test]
    fn the_union_answer_is_a_drawing_basis_answer_and_says_so() {
        // 🔴 A union of placed OUTLINES is not the program. The browser asks
        // this question (`wasm::plan_placement`) and would otherwise render a
        // shift that reads as final — while a lead-in on the outermost part sits
        // outside every outline this measured. `placement.rs`'s module header
        // carries the measured case: 2mm short, on a real `cad` drawing.
        use crate::placement::ExtentBasis;

        let m = Machine::default();
        let l = sheet(drawing("a", 0.0, 0.0), drawing("b", 300.0, 200.0));

        let p = l.plan_placement(3.0, 0.0, &m).expect("a non-empty workpiece has a placement");
        assert_eq!(p.basis(), ExtentBasis::Drawing { tool_radius_mm: 3.0 }, "{p:?}");
        assert!(!p.basis().is_final(), "the union answer was reported as final");

        // ...and a union that has to move says the same thing in its own words.
        let mut off = sheet(drawing("a", -20.0, -10.0), drawing("b", 100.0, 0.0));
        off.get_mut("b").expect("b is on the workpiece").y_mm = 200.0;
        let moved = off.plan_placement(3.0, 0.0, &m).expect("a non-empty workpiece has a placement");
        let d = moved.describe();
        assert!(d.contains("move the datum by"), "{d}");
        assert!(
            !d.contains("the whole program fits"),
            "a union of outlines was described as the whole program: {d}"
        );
        assert!(d.contains("FLOOR") && d.contains("lead-ins"), "{d}");
    }

    #[test]
    fn a_drawing_that_is_not_square_to_the_sheet_is_noted_and_not_refused() {
        let mut l = Layout::new();
        l.add(drawing("a", 0.0, 0.0).rotated(37.0)).unwrap();
        l.add(drawing("b", 300.0, 0.0).rotated(180.0)).unwrap();
        let notes = l.notes();
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("`a`") && notes[0].contains("37.000"), "{}", notes[0]);
    }

    // -----------------------------------------------------------------------
    // Add and remove
    // -----------------------------------------------------------------------

    #[test]
    fn removing_a_drawing_removes_exactly_its_operations_and_renumbers_nothing() {
        let with_hole = Part::new("p1", Contour::rect(0.0, 0.0, 100.0, 50.0))
            .with_hole(Contour::circle(50.0, 25.0, 8.0));
        let mut l = Layout::new();
        l.add(drawing("a", 0.0, 0.0)).unwrap();
        l.add(PlacedDrawing::new("b", vec![with_hole]).unwrap().at(200.0, 0.0)).unwrap();
        l.add(drawing("c", 400.0, 0.0)).unwrap();

        let params = OperationParams { side: CutSide::Outside, ..OperationParams::default() };
        let before: Vec<String> =
            l.operations(&tool6(), &params).iter().map(|o| o.name.clone()).collect();
        assert_eq!(before, vec!["a/p1", "b/p1-hole1", "b/p1", "c/p1"], "{before:?}");

        let removed = l.remove("b").expect("b was on the workpiece");
        assert_eq!(removed.id(), "b");

        let after: Vec<String> =
            l.operations(&tool6(), &params).iter().map(|o| o.name.clone()).collect();

        // Exactly b's operations are gone...
        let expected: Vec<String> =
            before.iter().filter(|n| !n.starts_with("b/")).cloned().collect();
        assert_eq!(after, expected, "removing `b` did not remove exactly b's operations");

        // ...and nothing was renumbered. The names a person was reading a moment
        // ago still say the same thing, because nothing is numbered by position.
        assert_eq!(after, vec!["a/p1", "c/p1"]);

        // Removing something that is not there is not an error and not a
        // silent success either.
        assert!(l.remove("b").is_none(), "a second removal reported success");
        assert_eq!(l.len(), 2);
    }

    #[test]
    fn a_refusal_names_exactly_the_operations_it_condemns() {
        // The link between a finding and the program: `PartRef::qualified()` is
        // the operation-name prefix, so a UI can strike the right rows without
        // matching on anything looser.
        let with_hole = Part::new("p1", Contour::rect(0.0, 0.0, 100.0, 50.0))
            .with_hole(Contour::circle(50.0, 25.0, 8.0));
        let mut l = Layout::new();
        l.add(PlacedDrawing::new("a", vec![with_hole]).unwrap()).unwrap();
        l.add(drawing("b", 90.0, 0.0)).unwrap();

        let found = l.check(&clearance());
        assert_eq!(found.len(), 1, "{found:?}");
        let (ra, rb) = found[0].parts();

        let names: Vec<String> = l
            .operations(&tool6(), &OperationParams::default())
            .iter()
            .map(|o| o.name.clone())
            .collect();
        let condemned: Vec<&String> = names
            .iter()
            .filter(|n| n.starts_with(&ra.qualified()) || n.starts_with(&rb.qualified()))
            .collect();
        assert_eq!(condemned.len(), 3, "{names:?}");
        assert!(condemned.iter().any(|n| n.as_str() == "a/p1-hole1"), "{condemned:?}");
    }

    #[test]
    fn a_drawing_that_cannot_be_named_or_placed_is_refused_at_the_door() {
        assert_eq!(PlacedDrawing::new("", vec![plate("p1")]).unwrap_err(), LayoutError::EmptyId);
        assert_eq!(PlacedDrawing::new("  ", vec![plate("p1")]).unwrap_err(), LayoutError::EmptyId);
        assert_eq!(
            PlacedDrawing::new("a", Vec::new()).unwrap_err(),
            LayoutError::NoGeometry("a".into())
        );

        let mut l = Layout::new();
        l.add(drawing("a", 0.0, 0.0)).unwrap();
        let err = l.add(drawing("a", 300.0, 0.0)).unwrap_err();
        assert_eq!(err, LayoutError::DuplicateId("a".into()));
        assert_eq!(l.len(), 1, "the duplicate was added anyway");
        assert!(err.describe().contains("already a drawing called `a`"), "{}", err.describe());
    }

    #[test]
    fn moving_a_drawing_moves_its_parts_and_nothing_else() {
        let mut l = sheet(drawing("a", 0.0, 0.0), drawing("b", 110.0, 0.0));
        assert!(l.check(&clearance()).is_empty());

        l.get_mut("b").expect("b is on the workpiece").x_mm = 103.0;
        assert!(
            matches!(l.check(&clearance()).as_slice(), [Interference::TooClose { .. }]),
            "a drag into the cutter's way was not caught"
        );

        // `a` did not move.
        let a = l.get("a").unwrap().placed_extent().unwrap();
        assert!((a.min_x).abs() < 1e-9 && (a.max_x - 100.0).abs() < 1e-9, "{a:?}");
    }
}
