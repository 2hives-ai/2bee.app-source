//! Generic 2.5D subtractive machining types — NOT specific to any machine,
//! tool, material or part.
//!
//! Everything in this module is in MILLIMETRES and `f64`. Any scaled-integer
//! space used by a geometry backend is an implementation detail of the toolpath
//! generator and must not leak into these parameter structs — a CAM parameter
//! that is sometimes scaled and sometimes not is a defect generator.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CutSide {
    /// Tool runs outside the contour — the part is what is kept.
    Outside,
    /// Tool runs inside the contour — the hole/pocket is what is kept.
    Inside,
    /// Tool centre follows the contour — engraving/marking.
    OnLine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Climb,
    Conventional,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryMode {
    /// Straight down. Fine in soft material, hard on the tool elsewhere.
    Plunge,
    /// Linear ramp along the path.
    Ramp,
    /// Helical entry — for closed pockets/bores.
    Helix,
}

/// Corner relief so an inside corner cut by a round tool can still accept a
/// square mating part. Which variant is correct is a joinery decision, not ours.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DogboneStyle {
    None,
    Corner,
    TBoneX,
    TBoneY,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpType {
    Profile,
    Pocket,
    Drill,
    Engrave,
}

/// Cutter geometry affects which face tears out. The CAM does not choose this;
/// it only needs to know, because it changes a sensible depth per pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flute {
    Straight,
    UpCut,
    DownCut,
    Compression,
}

/// What KIND of cutter this is.
///
/// 🔴 **The category constrains what the CAM may do with the tool** — it is a
/// physical fact, not a label. A drill has no side-cutting edge, so a drill
/// asked to cut a profile rubs its margin against the wall until it snaps. A
/// V-bit's width is a function of depth, so treating it as a cylinder of its
/// nominal diameter cuts a slot of the wrong size at every depth except one.
///
/// ⚠ **It lives HERE, on [`Tool`], and not only on [`crate::tools::ToolSpec`],
/// because a `Tool` is what every door hands to the planner and the post.**
/// Until 2026-08-11 the category stopped at the library: `ToolSpec` had it,
/// `Tool` did not, and `job.rs` copies `spec.tool` into each operation — so from
/// the planner onwards **a ⌀6 brad point was indistinguishable from a ⌀6 end
/// mill.** Measured on the control binary at HEAD `026a6c9523`,
/// `job plate --config '{"tool_id":"Drill - Brad Point 6mm 2F"}'`:
///
/// ```text
/// M3 S18000
/// G98 G83 X230.000 Y90.000 Z-18.000 R5.000 Q4.000 F4320.0
/// ```
///
/// — a drill run at chip-per-tooth router numbers, with **zero notes**, while
/// the `tool_ids` door (which keeps the `ToolSpec`) says so on every drill. That
/// asymmetry was not a missing check; it was a missing FIELD, and no check could
/// be written on either door until this existed on both.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCategory {
    EndMill,
    BallNose,
    VBit,
    Chamfer,
    Drill,
    Countersink,
    Surfacing,
    Engraving,
    ThreadMill,
}

impl ToolCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EndMill => "End Mill",
            Self::BallNose => "Ball Nose",
            Self::VBit => "V-Bit",
            Self::Chamfer => "Chamfer",
            Self::Drill => "Drill",
            Self::Countersink => "Countersink",
            Self::Surfacing => "Surfacing",
            Self::Engraving => "Engraving",
            Self::ThreadMill => "Thread Mill",
        }
    }

    pub fn all() -> &'static [ToolCategory] {
        &[
            Self::EndMill,
            Self::BallNose,
            Self::VBit,
            Self::Chamfer,
            Self::Drill,
            Self::Countersink,
            Self::Surfacing,
            Self::Engraving,
            Self::ThreadMill,
        ]
    }

    /// Can this tool cut sideways along a contour?
    ///
    /// 🔴 A drill cannot. Neither can a countersink. Their cutting geometry is
    /// on the point, not the flank.
    pub fn can_profile(self) -> bool {
        matches!(self, Self::EndMill | Self::BallNose | Self::Surfacing | Self::ThreadMill)
    }

    /// Can this tool clear a pocket floor?
    pub fn can_pocket(self) -> bool {
        matches!(self, Self::EndMill | Self::BallNose | Self::Surfacing)
    }

    /// Can this tool make a hole by plunging?
    pub fn can_drill(self) -> bool {
        matches!(self, Self::Drill | Self::EndMill | Self::Countersink)
    }

    /// Does this tool cut a V-shaped groove whose WIDTH depends on depth?
    pub fn is_angular(self) -> bool {
        matches!(self, Self::VBit | Self::Chamfer | Self::Countersink | Self::Engraving)
    }
}

#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    /// 🔴 What kind of cutter this is — see [`ToolCategory`]. It travels WITH
    /// the tool through every door, because a check that can only be written on
    /// the door that happens to still hold a `ToolSpec` is a check that is
    /// door-asymmetric by construction.
    pub category: ToolCategory,
    pub diameter_mm: f64,
    pub flutes: u32,
    /// Bounds depth of cut.
    pub cutting_length_mm: f64,
    pub shank_mm: f64,

    /// Manufacturer chipload window (mm per tooth). Feed is derived from these,
    /// never hardcoded — see [`crate::feeds::feed_from_chipload`].
    pub chipload_mm: f64,
    pub chipload_min_mm: f64,
    pub chipload_max_mm: f64,

    pub rpm_min: f64,
    pub rpm_max: f64,
    pub flute_type: Flute,
}

impl Default for Tool {
    fn default() -> Self {
        Self {
            name: "generic".into(),
            // ⚠ `EndMill` is the meaning every un-categorised `Tool` ALREADY
            // carried — every consumer of a bare `Tool` has assumed a
            // side-cutting cylinder since the type existed, so this default
            // changes no fixture's meaning. It is **not evidence about a real
            // cutter**: no tool in `default_library()` relies on it (every one
            // is built through `tools::mk`, which sets its own), and
            // `tools::category_is_carried_on_the_tool_itself` asserts that.
            //
            // 🔴 There is deliberately no `Unspecified` variant. It would have
            // to answer `can_profile`/`can_drill` somehow, and either answer is
            // a guess wearing a neutral name — the `Absent != safe` rule says an
            // absent category must not read as a permission, and the way to
            // achieve that here is for a category to be impossible to omit.
            category: ToolCategory::EndMill,
            diameter_mm: 6.0,
            flutes: 2,
            cutting_length_mm: 25.0,
            shank_mm: 6.0,
            chipload_mm: 0.10,
            chipload_min_mm: 0.02,
            chipload_max_mm: 0.30,
            rpm_min: 8_000.0,
            rpm_max: 24_000.0,
            flute_type: Flute::DownCut,
        }
    }
}

impl Tool {
    pub fn radius_mm(&self) -> f64 {
        self.diameter_mm * 0.5
    }
}

/// What the touch plate is used to reference.
///
/// 🔴 THESE ARE NOT TWO SETTINGS OF ONE THING — they are two different physical
/// operations with different failure modes.
///
/// A **Z** probe touches with the TIP of the cutter. The contact point is on the
/// tool axis, so the work offset carries no term for the tool's width and the
/// post gets away with never knowing the diameter. That is why the Z-only path
/// has survived without one.
///
/// An **X or Y** probe touches with the SIDE of the cutter. The contact point is
/// one TOOL RADIUS off the axis, so the offset carries the radius. Get it wrong
/// and every coordinate in the program is displaced by that amount, in a
/// direction that looks perfect on screen — the toolpath renders correctly and
/// the part is cut in the wrong place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbePlate {
    /// Z only, from the plate's top face. No corner, no radius.
    ZOnly,
    /// X, Y and Z from a corner plate. Requires a declared corner, a declared
    /// wall thickness, a declared side-probe descent, and a KNOWN tool radius.
    /// Every one of those is refused rather than guessed — see
    /// [`crate::post_grblhal::post_grblhal`].
    Xyz,
}

/// Which corner of the workpiece the plate is hooked over.
///
/// 🔴 THE COORDINATES BELOW ARE THE **WORKPIECE'S**, NOT THE MACHINE'S. `Left`/`Right`
/// name the workpiece's own minimum/maximum X, which is only the machine's X
/// while the workpiece happens to be laid square at zero rotation. Turn it a
/// quarter turn and the workpiece's left edge faces the machine's front. Nothing
/// here may be read as a machine direction — see [`Stock::corner_placement`], which
/// is the only thing entitled to answer that question, and answers it from the
/// PLACED rectangle.
///
/// 🔴 THIS IS A SETTING, NEVER AN ASSUMPTION. The corner decides which way the
/// tool travels to meet the plate. A program that assumes front-left and is run
/// on a plate hooked over the back-right drives the cutter INTO the plate at the
/// seek rate instead of away from it — the probe never fires, the travel bound is
/// the only thing that stops it, and by then the plate, the cutter or both are
/// destroyed.
///
/// Naming convention, stated once so nothing has to infer it:
///   * `Left`/`Right`  = the workpiece's MINIMUM / MAXIMUM X.
///   * `Front`/`Back`  = the workpiece's MINIMUM / MAXIMUM Y (front = nearest the
///     operator, which is where a router's Y zero conventionally is).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeCorner {
    FrontLeft,
    FrontRight,
    BackLeft,
    BackRight,
}

impl ProbeCorner {
    /// `-1.0` when the plate sits on the workpiece's MINIMUM side of X,
    /// `+1.0` on the maximum side.
    ///
    /// This single number carries the whole geometry of the corner: the plate's
    /// reference face lies at `sign * wall` from the workpiece edge, the tool
    /// stands off in the `sign` direction, and it probes back in `-sign`.
    pub fn x_sign(self) -> f64 {
        match self {
            ProbeCorner::FrontLeft | ProbeCorner::BackLeft => -1.0,
            ProbeCorner::FrontRight | ProbeCorner::BackRight => 1.0,
        }
    }

    /// `-1.0` on the workpiece's minimum Y, `+1.0` on the maximum Y.
    pub fn y_sign(self) -> f64 {
        match self {
            ProbeCorner::FrontLeft | ProbeCorner::FrontRight => -1.0,
            ProbeCorner::BackLeft | ProbeCorner::BackRight => 1.0,
        }
    }

    /// The name an operator has to read off the screen and match against the
    /// machine in front of them. Deliberately the words on the machine, not the enum
    /// spelling.
    pub fn label(self) -> &'static str {
        match self {
            ProbeCorner::FrontLeft => "front-left (X min, Y min)",
            ProbeCorner::FrontRight => "front-right (X max, Y min)",
            ProbeCorner::BackLeft => "back-left (X min, Y max)",
            ProbeCorner::BackRight => "back-right (X max, Y max)",
        }
    }
}

/// The X/Y reference face of a touch plate, as a THREE-state fact.
///
/// 🔴 "NOT DECLARED" AND "HAS NO WALL" ARE DIFFERENT FACTS AND ONLY ONE OF THEM
/// IS ABOUT THE PLATE. A single `f64` where `0.0` meant both could not tell a
/// shop that had not measured its plate from a plate that has nothing to
/// measure — and 2 of the 13 products surveyed in `docs/touchplate-research.md`
/// genuinely have no wall: one references X and Y through a BORE (where the tool
/// radius cancels instead of adding) and one measures the tool off a chamfer.
///
/// Both non-`Mm` states are REFUSED by the corner-probe path, so nothing is
/// softened here — but they are refused with different messages, because "go and
/// measure it" and "this plate cannot be used this way" send a person to
/// different places.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum PlateWall {
    /// Nobody has measured it. REFUSED: the top thickness is a different number,
    /// and using it for X and Y displaces the program by the difference.
    #[default]
    Undeclared,
    /// This plate has no outer reference face at all — it registers X and Y
    /// through a bore or off a chamfer. REFUSED for corner probing, because that
    /// routine drives against an outer face this object does not have. Bore
    /// probing is a different operation and is NOT implemented.
    NotPresent,
    /// The material between the plate's outer reference face and the workpiece
    /// edge it registers against, in mm.
    Mm(f64),
}

impl PlateWall {
    /// The declared thickness, or `None` if this plate has no usable wall.
    pub fn mm(self) -> Option<f64> {
        match self {
            PlateWall::Mm(v) if v > 0.0 => Some(v),
            _ => None,
        }
    }
}

/// **The purchased object** — a catalogue entry, and the third owner the old
/// model conflated onto [`Machine`].
///
/// Its dimensions belong to neither the machine nor the setup: they are facts
/// about a thing somebody bought. A shop picks "Sienci Standard Block" once, and
/// the setup then says which corner it is hooked over today.
///
/// ⚠ **The wall is in practice a property of the SHOP, not of the object.** Only
/// 1 of the 13 surveyed products publishes one at all, and that figure comes from
/// gSender's shipped defaults — which store ONE `xyThickness` across five plate
/// types while keeping `zThickness` per type. So do not build anything that
/// assumes a vendor will supply this number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TouchPlate {
    /// TOP thickness — the material between the plate's top face and the surface
    /// the datum is wanted at. This is the Z term and only the Z term.
    ///
    /// 🔴 A DIFFERENT PHYSICAL QUANTITY from [`Machine::touch_plate_mm`] even
    /// though both end up in a `G10 L20 P1 Z`. Here it is a THICKNESS SUBTRACTED
    /// from the workpiece top; on a fixed tool setter that field is a STANDING
    /// HEIGHT of a device bolted to the machine. Entering a 90mm setter's height as a plate
    /// thickness zeroes the tool 90mm high.
    pub top_mm: f64,
    /// The X/Y reference face — see [`PlateWall`], which is deliberately not an
    /// `f64`.
    pub wall: PlateWall,
}

/// A touch plate **hooked over a corner of the workpiece** — the SETUP half.
///
/// 🔴 THIS IS A PROPERTY OF THE SETUP, NOT OF THE MACHINE, and that is the whole
/// reason it lives on [`Stock`]. A device FASTENED TO THE MACHINE does not move
/// when the work does; one hooked over the work does. That — not "Z-only versus
/// XYZ" — is the property that decides the owner: the survey found 8
/// workpiece-referenced XYZ devices, 1 workpiece-referenced Z-only, 4
/// machine-referenced Z-only and **zero** machine-referenced XYZ, because an XYZ
/// datum is a property of a PART and a machine has no part.
///
/// Stored on the machine, as it was until 2026-08-08, moving the workpiece left
/// the plate behind — so the datum the whole program is measured from described
/// a corner that was no longer there, every coordinate displaced, and nothing on
/// screen to say so. That is the same failure class as a wrong tool radius:
/// invisible in the preview, wrong at the machine.
///
/// ⚠ NOT MODELLED, deliberately, rather than half-modelled: the survey's one
/// workpiece-referenced **Z-only** plate — a plate simply laid on the workpiece — is
/// as workpiece-referenced as this one, but nothing in the post would read such
/// a field today, and a setting consumed by nothing reads as configured.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CornerPlate {
    /// The object itself, which the shop bought and did not design.
    pub plate: TouchPlate,
    /// Which corner of THIS workpiece it is hooked over.
    pub corner: ProbeCorner,
    /// How far BELOW the plate's top face the cutter descends before probing
    /// sideways. A property of THIS SETUP, not of the plate: it is how the
    /// routine is being run. `0.0` = NOT DECLARED and REFUSED — probing at the
    /// height of the top face runs the cutter over the plate rather than against
    /// its wall, so it contacts nothing and the seek runs to its bound.
    pub xy_depth_mm: f64,
}

/// Where a corner plate actually is **on the machine**, and which way the tool
/// must stand off from it in MACHINE axes.
///
/// ⚠ This said *"on the bed"* until 2026-08-10. The founder's ruling that day
/// retires "table / bed" as a name in this tool — see [`TravelEnvelope`] — and
/// the word was doing real work here: the coordinates below are machine
/// coordinates, which is a FRAME, while "bed" names a SURFACE. There is a
/// surface in this model now and it is [`Spoilboard`]; a plate is not on it, it
/// is hooked over the workpiece.
///
/// 🔴 The signs here are NOT [`ProbeCorner::x_sign`]. That pair answers "which
/// side of the WORKPIECE", this pair answers "which side of the PLACED RECTANGLE" —
/// and a quarter turn makes them different answers. A probe driven on the workpiece's
/// answer for a turned workpiece drives the cutter along the wrong axis, into the
/// plate rather than away from it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CornerPlacement {
    /// MACHINE coordinates of the referenced corner, in the same frame as every
    /// emitted coordinate — and the same frame [`Spoilboard`] is declared in.
    pub x: f64,
    pub y: f64,
    /// `-1.0` when the corner is on the placed rectangle's minimum side of that
    /// machine axis, `+1.0` on the maximum side.
    pub x_sign: f64,
    pub y_sign: f64,
}

/// **The volume the cutter can REACH** — a limit of the machine's motion, and
/// nothing else.
///
/// 🔴 IT IS NOT A SURFACE. NOTHING SITS ON IT AND NOTHING IS CUT INTO IT.
/// Until 2026-08-10 this crate had no name for the thing at all, and the
/// browser drew `travel_x_mm` x `travel_y_mm` as a solid plane labelled
/// **"table / bed"** — so the machine's *reach* was rendered as the *object the
/// work lies on*. **Two different physical things were wearing one name**, and
/// the name belonged to neither:
///
/// | | bounded by | exceeding it does |
/// |---|---|---|
/// | **travel** (this type) | the machine's own axes | the controller refuses the line, or the axis runs into its limit |
/// | **spoilboard** ([`Spoilboard`]) | a sacrificial board bolted somewhere on the machine | the cutter descends into whatever the machine is built of |
///
/// The spoilboard is **smaller than the travel and does not have to start at
/// the datum**, so "inside the travel" and "over the spoilboard" are different
/// questions with different answers, and only one of them is about material.
/// Conflating them is what made an intended through-cut and a cutter in the
/// frame report identically — see [`crate::sim::BelowSheet`].
///
/// ⚠ **The word "bed" is not used for either of them**, deliberately (founder,
/// 2026-08-10). "Bed" names a surface, so it reads as the spoilboard, and it
/// was attached to the travel. Say **travel envelope** for reach and
/// **spoilboard** for the surface; when the machine's own structure is meant, say
/// the frame or the rails.
///
/// The origin is the machine datum: this rectangle is `0 ..= size_x_mm` by
/// `0 ..= size_y_mm`, which is exactly what
/// [`crate::post_grblhal::check_machine_limits`] has always compared against.
/// It carries **no origin fields** — a pair of zeroes nothing can change is a
/// setting consumed by nothing, and this lane already has enough of those.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TravelEnvelope {
    pub size_x_mm: f64,
    pub size_y_mm: f64,
    /// DEPTH available below the workpiece top, positive — the same sign
    /// [`Machine::travel_z_mm`] carries. Z is the one axis whose convention
    /// differs from the other two everywhere in this crate, so it is stated
    /// rather than inferred from the pair above it.
    pub size_z_mm: f64,
}

impl TravelEnvelope {
    /// Can the cutter centre reach this XY at all?
    ///
    /// ⚠ This asks about the **tool centre**, like every other limit test in
    /// this crate. A cutter whose centre is 1mm inside the limit still has half
    /// its diameter beyond it; the travel refusal in
    /// [`crate::post_grblhal::check_machine_limits`] is written against the
    /// planned path, which is already offset, so the radius is accounted for
    /// there and must not be added again here.
    pub fn contains_xy(&self, x: f64, y: f64) -> bool {
        x >= 0.0 && y >= 0.0 && x <= self.size_x_mm && y <= self.size_y_mm
    }
}

/// **The sacrificial board, and WHERE IT IS** — the material a through-cut is
/// allowed to end up in.
///
/// 🔴 THE WHOLE POINT OF THIS TYPE IS THE POSITION. A spoilboard's size alone
/// answers nothing: the check that matters is *"is there sacrificial material
/// under THIS XY"*, and that needs a rectangle on the machine, not a pair of
/// dimensions. Until 2026-08-10 [`crate::sim::check`] fired its spoilboard
/// finding on **depth alone** — `z < -(thickness + allowance)` — with no idea
/// where any board was, so:
///
/// * a through-cut over the spoilboard (**normal, intended, sacrificial**), and
/// * the same cut past the board's edge (**a 2.2 kW spindle driving a cutter
///   into an aluminium extrusion**)
///
/// produced the identical finding, with the identical name and the identical
/// count. One of those is a green light and the other bends the cutter into the
/// frame.
///
/// 🔴 AN ABSENT SPOILBOARD IS A DIFFERENT FACT FROM A ZERO-SIZED ONE, AND FROM
/// ONE THAT COVERS EVERYTHING. [`Machine::spoilboard`] is `Option`, `None`
/// means **nobody declared one**, and the check then reports its position limb
/// as **UNCHECKED** rather than assuming the board covers the travel envelope —
/// which is precisely the silent assumption the depth-only check was making.
/// The same three-way shape as [`Machine::touch_plate_mm`] and
/// [`crate::fixture::Fixturing::confirmed_clear`], for the same reason.
///
/// ⚠ **Square to the machine, deliberately — there is no `rotation_deg`.** A
/// spoilboard is bolted flat to the rails and dressed in place; every one this
/// lane can find is registered to the machine's own axes. [`Clamp`] carries a
/// rotation because a clamp is bolted at a point and gets turned; this does
/// not, and the absence is a decision rather than an omission. If a machine
/// ever turns up with a skewed board, add the field **and** teach
/// [`Spoilboard::covers`] about it in the same change — a rotation the picture
/// honours and the check does not is the look-right / checked-wrong failure
/// gate `P7R` exists for.
///
/// # 🔴 THE SLAB HAS A TOP AND A BOTTOM, AND UNTIL 2026-08-11 IT HAD NEITHER
///
/// This type was an XY rectangle and nothing else, and
/// [`crate::sim::check`] modelled the board as *"an allowance of a few tenths
/// below the workpiece"*. So **a 6mm board and a 25mm board were the same object**,
/// and *through the board, into the machine* was not merely unchecked — it was
/// **inexpressible**. The thin board is the one that puts a cutter into the
/// frame, and it read identically to the thick one.
///
/// [`thickness_mm`](Self::thickness_mm) fixes that, and its **`None` is the
/// whole point**: absent means **UNKNOWN**, never "thick enough". A default here
/// would silently answer the exact question the field exists to ask — see
/// [`crate::sim::SpoilboardDepth`], which reports **PENDING with the reason**
/// rather than a pass whenever the thickness is absent.
///
/// ## Where the board is in Z, said once
///
/// The board's **top face is the workpiece's underside** — [`top_face_z_mm`] — and
/// that is an **assumption about how the work is laid down**, not a measurement:
/// the workpiece rests on the board. It is written here, in one named place a test
/// can bite on, precisely because it used to be nowhere: nothing in this crate
/// stated where the board's top face sat, so the whole stack floated. The
/// underside then follows from the thickness ([`underside_z_mm`]), and is
/// `None` exactly when the thickness is.
///
/// ⚠ **What the assumption does NOT cover**: sacrificial packers, a sub-board, a
/// vacuum jig or a board that has been resurfaced thinner than its nominal size.
/// Each of those moves the underside **up**, toward the cutter, and this crate
/// cannot see any of them. The catalogue says the same thing about the number it
/// hands over — a spoilboard is dressed in service and gets thinner, and nothing
/// here tracks that.
///
/// [`Clamp`]: crate::fixture::Clamp
/// [`top_face_z_mm`]: Spoilboard::top_face_z_mm
/// [`underside_z_mm`]: Spoilboard::underside_z_mm
#[derive(Clone, Debug, PartialEq)]
pub struct Spoilboard {
    /// What the operator calls it. Carried so a finding can name the board the
    /// cutter left, rather than saying "the spoilboard" on a machine that has
    /// two.
    pub name: String,
    /// Lower-left corner, **machine coordinates**, the same frame every emitted
    /// coordinate is in. It is NOT assumed to be `0,0`: a board is bolted where
    /// the T-slots let it go, and a 20mm offset is 20mm of bare rail that the
    /// old depth-only check called spoilboard.
    pub x_mm: f64,
    pub y_mm: f64,
    pub size_x_mm: f64,
    pub size_y_mm: f64,
    /// **How thick the slab is — and `None` means the operator never said.**
    ///
    /// 🔴 **ABSENT IS UNKNOWN. ABSENT IS NOT "THICK ENOUGH".** This is the one
    /// property of this field that matters more than its value. The check it
    /// feeds exists to separate *an intended sacrificial cut* from *a cut into
    /// the machine*; a default — 18mm, or the thickest catalogue entry, or the
    /// workpiece thickness — would answer that question on the operator's behalf
    /// with a number nobody measured, and would answer it in the **dangerous**
    /// direction, because an over-declared thickness says there is sacrificial
    /// material where there is bare frame. So the depth limb reports **PENDING**
    /// instead: [`crate::sim::SpoilboardDepth::why_not`].
    ///
    /// This is the same three-way shape as [`Machine::spoilboard`] itself
    /// (`None` = nobody declared a board, not "there is no board") and
    /// [`Machine::touch_plate_mm`], for the same reason.
    ///
    /// ⚠ **NOMINAL, wherever it came from.** `docs/materials-research.md`
    /// records that sheet goods run under their nominal thickness and grades
    /// MDF's claimed ±0.2mm tolerance **GENERIC and unverified**. A dressed
    /// spoilboard is thinner still. Treat a value here as *what was declared*,
    /// never as *what was measured on your machine*.
    ///
    /// ⚠ A value that is present but **not usable** — non-finite, zero or
    /// negative — is a THIRD state, and it is reported by
    /// [`thickness_faults`](Self::thickness_faults) rather than being folded
    /// into absence: somebody tried to declare a thickness, and that is not the
    /// same fact as never having said.
    pub thickness_mm: Option<f64>,
}

/// The reachable area a declared [`Spoilboard`] does **not** cover, as the four
/// edge strips in mm.
///
/// All four zero ⇒ the board covers everywhere the cutter can go, which is the
/// only case in which "inside the travel" and "over the spoilboard" are the
/// same question. Anything else is bare machine the cutter can reach, and the
/// operator is entitled to know which side it is on and by how much.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct BareReach {
    pub minus_x_mm: f64,
    pub plus_x_mm: f64,
    pub minus_y_mm: f64,
    pub plus_y_mm: f64,
}

impl BareReach {
    /// Is any reachable XY off the board?
    pub fn any(&self) -> bool {
        self.minus_x_mm > 0.0
            || self.plus_x_mm > 0.0
            || self.minus_y_mm > 0.0
            || self.plus_y_mm > 0.0
    }

    /// The strips in words, for whoever has to go and look at the machine.
    /// `None` when the board covers the whole reach.
    pub fn describe(&self) -> Option<String> {
        if !self.any() {
            return None;
        }
        let mut parts = Vec::new();
        for (mm, side) in [
            (self.minus_x_mm, "X-"),
            (self.plus_x_mm, "X+"),
            (self.minus_y_mm, "Y-"),
            (self.plus_y_mm, "Y+"),
        ] {
            if mm > 0.0 {
                parts.push(format!("{mm:.1}mm on {side}"));
            }
        }
        Some(parts.join(", "))
    }
}

impl Spoilboard {
    /// A board square to the machine at a stated corner, of **unknown
    /// thickness**.
    ///
    /// 🔴 The thickness is `None` and that is deliberate, not an oversight in
    /// the signature. A constructor that took a thickness would force every
    /// caller who does not know one to invent one, and an invented thickness is
    /// worse than an absent one: absent reads as unknown and invented reads as
    /// measured. Call [`with_thickness`](Self::with_thickness) when there is a
    /// sourced number to declare — [`crate::spoilboards::SpoilboardSpec::install_at`]
    /// does exactly that, and carries the catalogue's provenance with it.
    pub fn new(
        name: impl Into<String>,
        x_mm: f64,
        y_mm: f64,
        size_x_mm: f64,
        size_y_mm: f64,
    ) -> Self {
        Self { name: name.into(), x_mm, y_mm, size_x_mm, size_y_mm, thickness_mm: None }
    }

    /// The same board with a **declared** thickness.
    ///
    /// It does not validate: an unusable value is reported by
    /// [`thickness_faults`](Self::thickness_faults) and refused by the depth
    /// limb, rather than being silently dropped here — a builder that quietly
    /// discards a bad number leaves the caller believing it took.
    pub fn with_thickness(mut self, thickness_mm: f64) -> Self {
        self.thickness_mm = Some(thickness_mm);
        self
    }

    /// The thickness **if it is one a slab could have**: declared, finite and
    /// positive. `None` covers both "nobody said" and "what was said is not a
    /// thickness", because for the purpose of *can this check run* they are the
    /// same answer — and [`thickness_faults`](Self::thickness_faults) is where
    /// they stop being the same.
    pub fn usable_thickness_mm(&self) -> Option<f64> {
        self.thickness_mm.filter(|t| t.is_finite() && *t > 0.0)
    }

    /// **Where the board's top face sits**, in the frame every simulated Z is in
    /// — `z = 0` at the workpiece top, negative downward.
    ///
    /// 🔴 This is the load-bearing ASSUMPTION of the whole stack, and it is a
    /// function so that it has exactly one home: **the workpiece rests on the
    /// board**, so the board's top is the workpiece's underside. Before this
    /// existed, the relationship was nowhere — not in a field, not in a comment
    /// — and the workpiece bottom sat at the board top *by assumption rather
    /// than by construction*.
    ///
    /// ⚠ Anything between the workpiece and the board — packers, a sub-board, a
    /// vacuum jig, double-sided tape — moves the real top face **up** and this
    /// crate cannot see it. Every such error is in the direction that puts the
    /// underside nearer the cutter than modelled, so a green here is not a
    /// promise about a stack this core has never been told about.
    pub fn top_face_z_mm(&self, stock_thickness_mm: f64) -> f64 {
        -stock_thickness_mm
    }

    /// **Where the board's underside sits**, same frame as
    /// [`top_face_z_mm`](Self::top_face_z_mm). Below this is the machine.
    ///
    /// `None` when the thickness is unknown or unusable — and `None` here is
    /// what makes the depth limb report PENDING instead of guessing a floor.
    /// There is deliberately no fallback: a floor invented from the workpiece
    /// thickness, or from the thickest board in the catalogue, would be a
    /// number nobody measured sitting in the one place that decides whether a
    /// cut reaches the frame.
    pub fn underside_z_mm(&self, stock_thickness_mm: f64) -> Option<f64> {
        let t = self.usable_thickness_mm()?;
        if !stock_thickness_mm.is_finite() {
            return None;
        }
        Some(self.top_face_z_mm(stock_thickness_mm) - t)
    }

    /// What is wrong with the declared THICKNESS — kept apart from
    /// [`faults`](Self::faults) on purpose.
    ///
    /// 🔴 **The two limbs must not be able to disable each other.** `faults()`
    /// describes the RECTANGLE, and [`crate::sim::check`] treats a faulted
    /// rectangle as an absent board, because a rectangle that contains nothing
    /// answers `covers == false` everywhere and would call every legitimate
    /// through-cut a strike on the frame. If a bad *thickness* joined that list,
    /// a typo in one number would silently switch off the **position** check as
    /// well — a job would lose the answer to *"is there any board under here"*
    /// because of a field that has nothing to do with the question. That is the
    /// blur this whole change exists to prevent, arriving from the inside.
    pub fn thickness_faults(&self) -> Vec<String> {
        let mut v = Vec::new();
        if let Some(t) = self.thickness_mm {
            if !t.is_finite() || t <= 0.0 {
                v.push(format!(
                    "spoilboard '{}' declares a thickness of {}mm, which is not a slab. It is NOT \
                     read as 'unknown' — somebody typed a thickness and this is not one — and it \
                     is not read as 'thick enough' either: the depth check reports UNCHECKED, so \
                     nothing on this job says whether a cut reached the machine under the board. \
                     Declare the board's real thickness, or leave it undeclared and be told so",
                    self.name, t
                ));
            }
        }
        v
    }

    /// Everything wrong with this DECLARATION — the rectangle and the thickness
    /// together — for a caller that has to show the operator what they typed.
    ///
    /// ⚠ It is the union for **reporting**, never for gating: see
    /// [`thickness_faults`](Self::thickness_faults) for why the two lists have
    /// to reach the checks separately.
    pub fn declaration_faults(&self) -> Vec<String> {
        let mut v = self.faults();
        v.extend(self.thickness_faults());
        v
    }

    /// Is there sacrificial material under this XY?
    ///
    /// 🔴 **The one question this whole type exists to answer**, and the reason
    /// it is a point test rather than a swept one is that its caller walks a
    /// height map CELL BY CELL — [`crate::sim::check`] — so the sweeping has
    /// already happened. Do **not** copy this into a path check without going
    /// through a clipped span the way [`crate::fixture::Clamp::segment_span`]
    /// does: a keepout asked about move destinations is the defect that put a
    /// 6mm cutter through a declared 40mm clamp at full depth.
    ///
    /// Boundary is INCLUSIVE — a cell exactly on the board's edge counts as
    /// over the board. That is the forgiving direction, and it is the right one
    /// here: the edge of a dressed spoilboard is not a knife line, and reporting a
    /// cutter into the frame for a cell 1e-15mm outside a nominal rectangle is
    /// the sort of false red that gets a real one muted.
    pub fn covers(&self, x: f64, y: f64) -> bool {
        x >= self.x_mm
            && y >= self.y_mm
            && x <= self.x_mm + self.size_x_mm
            && y <= self.y_mm + self.size_y_mm
    }

    /// The four corners as placed, anticlockwise from `(x_mm, y_mm)` — the one
    /// source a picture and a check may both come from.
    pub fn corners(&self) -> [(f64, f64); 4] {
        [
            (self.x_mm, self.y_mm),
            (self.x_mm + self.size_x_mm, self.y_mm),
            (self.x_mm + self.size_x_mm, self.y_mm + self.size_y_mm),
            (self.x_mm, self.y_mm + self.size_y_mm),
        ]
    }

    /// What is wrong with this DECLARATION — not with the program.
    ///
    /// 🔴 A faulty declaration must not be quietly treated as an absent one,
    /// and it must not be treated as a good one either. A board declared with a
    /// zero or non-finite size would answer `false` to [`Spoilboard::covers`]
    /// everywhere, which makes **every** through-cut read as past the edge — a
    /// false red across a whole job, which is how a real one stops being read.
    /// Callers report these and then judge the job as if nothing were declared.
    ///
    /// 🔴 **THIS LIST IS THE RECTANGLE ONLY.** A bad `thickness_mm` is
    /// [`thickness_faults`](Self::thickness_faults) and is deliberately not
    /// here, because [`crate::sim::check`] gates the POSITION limb on this list
    /// — putting a thickness typo in it would switch off the check that answers
    /// *"is there a board under this XY at all"*, which the typo says nothing
    /// about. Use [`declaration_faults`](Self::declaration_faults) to show an
    /// operator everything that is wrong with what they typed.
    pub fn faults(&self) -> Vec<String> {
        let mut v = Vec::new();
        if !(self.x_mm.is_finite()
            && self.y_mm.is_finite()
            && self.size_x_mm.is_finite()
            && self.size_y_mm.is_finite())
        {
            v.push(format!(
                "spoilboard '{}' has a non-finite corner or size (x{} y{} {}x{}) — it is not a \
                 rectangle anywhere on the machine, and every containment test against it \
                 answers false, so nothing would be judged as over it",
                self.name, self.x_mm, self.y_mm, self.size_x_mm, self.size_y_mm
            ));
            return v;
        }
        if !(self.size_x_mm > 0.0) || !(self.size_y_mm > 0.0) {
            v.push(format!(
                "spoilboard '{}' is declared {}x{}mm, which has no area. A board with no size is \
                 not a declaration that there is no board — leave the spoilboard undeclared to \
                 say that, and this limb will report UNCHECKED instead of calling every \
                 through-cut a strike on the frame",
                self.name, self.size_x_mm, self.size_y_mm
            ));
        }
        v
    }

    /// How much of `machine`'s reach this board leaves bare.
    ///
    /// ⚠ It answers about the **rectangles**, not about this program. A bare
    /// strip is only a hazard where something actually cuts through, and
    /// [`crate::sim::check`] is what measures that. This is the setup fact — the
    /// thing an operator wants on screen before pressing go.
    pub fn bare_reach(&self, machine: &Machine) -> BareReach {
        let t = machine.travel_envelope();
        if !self.faults().is_empty() || !(t.size_x_mm > 0.0) || !(t.size_y_mm > 0.0) {
            return BareReach::default();
        }
        BareReach {
            minus_x_mm: (self.x_mm.min(t.size_x_mm) - 0.0).max(0.0),
            plus_x_mm: (t.size_x_mm - (self.x_mm + self.size_x_mm)).max(0.0),
            minus_y_mm: (self.y_mm.min(t.size_y_mm) - 0.0).max(0.0),
            plus_y_mm: (t.size_y_mm - (self.y_mm + self.size_y_mm)).max(0.0),
        }
    }

    /// Does the board cover every XY the cutter can reach?
    pub fn covers_travel(&self, machine: &Machine) -> bool {
        self.faults().is_empty() && !self.bare_reach(machine).any()
    }
}

/// How rigid this machine is — the structural limit on depth of cut that the
/// material's own ratio cannot express. `max_doc_ratio()` is sourced to the
/// GANTRY class (C-Beam/ACME, ~2.2 kW spindle); a Desktop frame deflects more
/// and needs shallower passes; an Industrial frame can go deeper but we have no
/// sourced figure for it, so it defaults to the same as Gantry until a coupon
/// proves otherwise.
///
/// ⚠ THE MULTIPLIERS ARE CONSERVATIVE, NOT SOURCED. Gantry = 1.0 (preserves
/// the existing material constants verbatim). Desktop = 0.5 (a safe default
/// for a frame that is provably less rigid, with the exact figure coupon-
/// gated). Industrial = 1.0 (cannot go higher without data — raising it would
/// be a claim about a machine we have not measured).
///
/// The founder's machine is a 2.2 kW C-Beam gantry and maps to `Gantry`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MachineClass {
    /// Desktop / hobby frames (3018, 3040, MakerBeam-style). Conservative
    /// depth — half the gantry class — because these frames deflect
    /// measurably more under load. The exact multiplier is coupon-gated.
    Desktop,
    /// C-Beam / ACME gantry routers with ~2.2 kW spindles. The class the
    /// published depth-of-cut figures are defended for. THIS IS THE DEFAULT.
    #[default]
    Gantry,
    /// Heavy industrial routers (moving-gantry, moving-table, >5 kW spindle).
    /// Currently mapped to the same depth as Gantry — raising it requires a
    /// coupon run or a sourced manufacturer figure, neither of which exists.
    Industrial,
}

impl MachineClass {
    /// Multiplier on `Material::max_doc_ratio()`. Gantry = 1.0 (the published
    /// figures are defended for this class); Desktop = 0.5 (conservative
    /// default for a less rigid frame); Industrial = 1.0 (cannot go higher
    /// without data).
    pub fn doc_ratio_multiplier(self) -> f64 {
        match self {
            Self::Desktop => 0.5,
            Self::Gantry => 1.0,
            Self::Industrial => 1.0,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Gantry => "gantry",
            Self::Industrial => "industrial",
        }
    }

    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "desktop" | "hobby" | "3018" => Some(Self::Desktop),
            "gantry" | "c-beam" | "cbeam" => Some(Self::Gantry),
            "industrial" | "heavy" => Some(Self::Industrial),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Machine {
    pub name: String,

    /// TRAVEL — how far the axes can move, i.e. everywhere the cutter can
    /// REACH. This is NOT the workpiece size and it is NOT the spoilboard: see
    /// [`TravelEnvelope`] for why those are three different rectangles and
    /// [`Spoilboard`] for the one that is made of material. Conflating travel
    /// with the workpiece lets a job be generated that the machine cannot run;
    /// conflating travel with the spoilboard lets a cutter reach the frame with
    /// every check green.
    pub travel_x_mm: f64,
    pub travel_y_mm: f64,
    pub travel_z_mm: f64,

    /// The sacrificial board on this machine — **size AND position**.
    ///
    /// 🔴 `None` MEANS NOBODY DECLARED ONE, and it is reported as **UNCHECKED**,
    /// never assumed. The tempting default — "it covers the travel envelope" —
    /// is exactly the assumption the depth-only spoilboard check was making
    /// silently, and it fails in the direction that reaches the machine's own
    /// structure: an undeclared board that is assumed to be everywhere makes a
    /// cut into an extrusion report as a normal sacrificial pass.
    ///
    /// There is deliberately **no default board**. Every plausible one would be
    /// a guess about a physical object nobody measured, and the survey behind
    /// [`crate::spoilboards`] found real boards from 600x1200 to 3600x1200 — a
    /// 6x spread on one axis. A plausible number here RUNS, which is the same
    /// argument that took the unsourced `1.6` off `touch_plate_mm`.
    pub spoilboard: Option<Spoilboard>,

    /// Shank size the CURRENTLY FITTED collet accepts. `0.0` = not declared,
    /// which is NOT the same as "any shank fits" — an undeclared collet cannot
    /// be checked.
    pub collet_mm: f64,
    /// Other collets the shop owns. A tool change on a router is routinely a
    /// collet change too, so a 3.175mm bit on a machine with a 3.175mm collet
    /// in the drawer is fine — it just costs the operator time declared in
    /// [`Machine::tool_change_seconds`].
    /// Modelling only the fitted collet refuses ordinary, safe jobs.
    pub spare_collets_mm: Vec<f64>,
    /// Operator time charged for ONE manual tool change, in seconds.
    ///
    /// 🔴 **It is a property of THIS MACHINE AND ITS OPERATOR, which is why it
    /// lives here and not on a tool or on an operation.** The same cutter in
    /// the same drawing costs seconds on an ATC spindle and minutes on a manual
    /// router where a person stops the spindle, unclamps the collet, swaps the
    /// cutter, re-references Z against a plate and restarts. Nothing about the
    /// cutter or the part predicts that number; the machine and the person
    /// standing at it do. A shop that buys an ATC changes this field once and
    /// every estimate it has ever produced becomes right again.
    ///
    /// It is the ONE input to [`crate::job::JobSummary::estimated_seconds`]
    /// that is not read back out of the emitted program: the program writes
    /// `M0` and stops, and how long a person takes is not in the file. A
    /// 12-change program is a substantial part of a morning, and an estimate
    /// that omits it reads as far cheaper than the job is.
    ///
    /// `None` = **nobody declared it**, which is NOT the same fact as a
    /// declared value that happens to equal the default. It is deliberately
    /// **not refused** — unlike [`Machine::touch_plate_mm`], which is refused
    /// because an undeclared plate decides where every cut lands. This number
    /// decides only what a *number in a report* says, so refusing a physically
    /// sound program over it would be a refusal out of proportion to what it
    /// guards. Instead the estimate falls back to
    /// [`crate::job::DEFAULT_TOOL_CHANGE_SECONDS`] and **says on the report
    /// that it did** (`EstimateBasis::tool_change_rate_declared`), so a reader
    /// can tell a measured rate from a fallback.
    ///
    /// `Some(0.0)` is legal but only if TYPED: it declares an ATC, or a shop
    /// that has decided not to count operator time. Reachable by choice, never
    /// by omission.
    ///
    /// 🔴 A negative or non-finite value is **REFUSED** in
    /// [`crate::job::plan_job`], not clamped. A NaN here does not make the
    /// estimate slightly wrong — it makes `estimated_seconds` NaN, and every
    /// number derived from it, while the program still looks perfectly
    /// runnable. That is a wrong *number*, not a wrong *cut*, and the refusal
    /// says so in those words rather than borrowing a safety justification it
    /// has not earned.
    pub tool_change_seconds: Option<f64>,
    /// Clearance plane above the workpiece top.
    pub safe_z_mm: f64,
    pub rapid_mm_min: f64,
    pub max_feed_mm_min: f64,

    /// How rigid this machine's frame is. `max_doc_ratio()` is sourced to the
    /// Gantry class; this multiplier scales it for weaker or stronger frames.
    /// See [`MachineClass`] for the defended values and the sourcing argument.
    pub machine_class: MachineClass,

    /// Controller capabilities. grblHAL supports arcs and canned drill cycles
    /// but NOT cutter radius compensation (G41/G42) — so offsets are always
    /// computed host-side, whatever this says.
    pub supports_arcs: bool,
    pub supports_canned_drill: bool,
    pub supports_cutter_comp: bool,

    pub spindle_pwm: bool,
    /// G4 dwell after M3 before the first cut.
    pub spindle_spinup_s: f64,
    pub spindle_min_rpm: f64,
    pub spindle_max_rpm: f64,
    pub spindle_reverse: bool,

    /// Touch plate. grblHAL supports G38.2 and G10 L20; the two-stage
    /// seek-then-slow-reprobe and these default rates are grblHAL's own.
    ///
    /// 🔴 EVERYTHING IN THIS BLOCK DESCRIBES THE MACHINE AND THE MACHINE ONLY:
    /// how it probes, and a device FASTENED TO THE MACHINE at a known spot, which
    /// does not move when the work does. A plate hooked over the workpiece lives
    /// on [`Stock::corner_plate`], because it moves with the workpiece; the object's
    /// own dimensions live on [`TouchPlate`], because they are facts about a
    /// purchased item. Three owners, and all three were on `Machine` until
    /// 2026-08-08 — which is how a moved workpiece came to leave its plate behind.
    ///
    /// ⚠ The deciding property is **"is it fastened to the machine?"**, NOT
    /// "Z-only versus XYZ" — see [`CornerPlate`] for the counts that establish
    /// it. A Z-only plate laid on the workpiece is workpiece-referenced too.
    pub probe_enabled: bool,
    /// Which axes the plate references. Defaults to [`ProbePlate::ZOnly`], which
    /// is what this post has always emitted — an XYZ plate is opted INTO, so an
    /// existing machine definition cannot silently acquire an X/Y probe it has
    /// no plate for.
    ///
    /// This says the shop OWNS a corner plate; [`Stock::corner_plate`] says where
    /// it is hooked on this setup. `Xyz` with no declared corner plate is
    /// REFUSED, never downgraded to Z.
    pub probe_plate: ProbePlate,
    /// The FIXED device's Z figure — what a `G10 L20 P1 Z` is set to after the
    /// tip touches it. Not the corner plate's thickness: that is
    /// [`TouchPlate::top_mm`] and it lives on the setup.
    ///
    /// 🔴 `None` MEANS NOBODY HAS DECLARED IT, AND IT IS REFUSED — never
    /// defaulted. There is no typical value to fall back on: the published Z
    /// figures across the 13 products surveyed in `docs/touchplate-research.md`
    /// are 5, 13, 15, 15.4 and 15.5mm — a 3x spread — and the two plates this
    /// shop owns publish nothing at all. A plausible number here RUNS.
    ///
    /// `Some(0.0)` is LEGAL BUT ONLY IF TYPED: it declares "no plate — the tool
    /// tip zeroes on the surface it touches", which is a real setup and the one
    /// UGS ships. Reachable by choice, never by omission. **`None` and
    /// `Some(0.0)` are different facts and only one of them is safe to run**,
    /// which is the same three-way shape [`PlateWall`] already uses for the
    /// other axis. `Some(v)` with `v < 0.0` is refused: a negative thickness is
    /// not a measurement of anything.
    ///
    /// 🔴 ONE OPEN DEFECT REMAINS ON THIS FIELD, RECORDED RATHER THAN GUESSED
    /// AT. It is a physical decision and it is not a session's to make.
    ///
    /// **It means two different physical quantities.** On a plate laid on the
    /// work it is a THICKNESS subtracted from the workpiece top; on a fixed
    /// tool setter it is a STANDING HEIGHT of a device bolted to the machine — different
    /// magnitudes measured from different datum surfaces. Entering a 90mm
    /// setter's height here zeroes the tool 90mm high. Separating them needs a
    /// device type on the machine *and* a ruling on which surface Z is wanted
    /// at. (Decision #43 P2.)
    ///
    /// ⚠ **The SURFACE half of that ruling arrived on 2026-08-11** and is
    /// carried by [`ZDatum`]. **The DEVICE half — this field meaning two
    /// physical quantities — is untouched by it and is still open.** Do not read
    /// [`ZDatum`] as closing #43: it says which surface Z is wanted at, and says
    /// nothing about what kind of device measures it. The two halves were always
    /// separate and only one has been ruled on.
    ///
    /// ⚠ **The refusal asymmetry this replaces:** an undeclared WALL was
    /// refused while an undeclared TOP simply RAN — `Machine::default()` used to
    /// carry an unsourced `1.6` (2026-08-09, decision #43 P0). Do not restore a
    /// number here, sourced or not, and see the direction below for why a
    /// *sourced* catalogue figure would be the more dangerous of the two.
    ///
    ///    🔴 **AND THE DIRECTION IS THE OPPOSITE OF THE OBVIOUS ONE.** The post
    ///    emits `G10 L20 P1 Z<value>` at the moment of contact, where the tip
    ///    already stands the plate's TRUE thickness `T` above the work, so
    ///    work-zero lands `T - value` **above** the work top:
    ///    - `value < T` (**under**-declared) — work-zero too HIGH, the machine
    ///      cuts **SHALLOWER**, in the limit entirely in the air. A scrapped
    ///      part; nothing crashes.
    ///    - `value > T` (**over**-declared) — work-zero too LOW, the machine cuts
    ///      **TOWARD THE SPOILBOARD**, and the safe-Z retract is displaced down
    ///      with it, so a rapid runs at a height the operator believes is clear.
    ///
    ///    ⇒ **This is why the argument for `None` is NOT "1.6 is dangerous".**
    ///    `1.6` under-declares against every plate in the survey, so the old
    ///    default failed SHALLOW — a scrapped part, not a crash. **A plausible
    ///    catalogue figure would have been the WORSE fix:** 15mm, the
    ///    most-published number, over-declares by 10mm for anyone holding a 5mm
    ///    AutoZero, and over-declaration is the direction that reaches the
    ///    machine. Sourcing the number moves the defect into the crash direction
    ///    for a subset of users nobody can enumerate. The argument is
    ///    **an unmeasured number must not be guessed**, and the refusal is what
    ///    makes that true in both directions at once.
    ///
    ///    Direction confirmed at a primary source, not derived only: Carbide 3D
    ///    community on the BitZero V2 measuring 13.1mm against an assumed 13.0 —
    ///    *"the virtual zero surface is now above the actual surface"*
    ///    (<https://community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548>,
    ///    read 2026-08-09). ⚠ This block previously said "about 13mm out" with no
    ///    direction at all, and its sibling comment in `post_grblhal.rs` said
    ///    "deep", which was backwards; both corrected 2026-08-09. Full derivation
    ///    in `docs/decision-40-43-touchplate-ownership.md` §3.
    pub touch_plate_mm: Option<f64>,
    /// mm/min, fast first pass.
    pub probe_seek_feed: f64,
    /// mm/min, slow measuring pass.
    pub probe_feed: f64,
    pub probe_max_mm: f64,
    pub probe_retract_mm: f64,
    /// Where the FIXED plate is. `0,0` means "probe where the tool already is",
    /// which is the Z-only convention and what a machine with no declared plate
    /// position has always done.
    ///
    /// 🔴 A CORNER PLATE'S POSITION IS NOT HERE AND MUST NEVER BE PUT HERE. It is
    /// derived from the workpiece, through [`Stock::corner_placement`], so that a
    /// moved or turned workpiece takes its plate with it.
    pub probe_x: f64,
    pub probe_y: f64,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            name: "generic-grblhal".into(),
            travel_x_mm: 600.0,
            travel_y_mm: 900.0,
            travel_z_mm: 100.0,
            // 🔴 NOT DECLARED. See the field's doc block: there is no board to
            // fall back on, and "it covers the travel envelope" is the guess
            // that made a cutter in the frame look like a sacrificial pass.
            spoilboard: None,
            collet_mm: 0.0,
            spare_collets_mm: Vec::new(),
            // 🔴 NOT DECLARED. The estimate falls back to
            // `job::DEFAULT_TOOL_CHANGE_SECONDS` and says on every report that
            // it did — see the field's doc block for why this one is a fallback
            // and `touch_plate_mm` is a refusal.
            tool_change_seconds: None,
            safe_z_mm: 5.0,
            rapid_mm_min: 3_000.0,
            max_feed_mm_min: 6_000.0,
            machine_class: MachineClass::default(),
            supports_arcs: true,
            supports_canned_drill: true,
            supports_cutter_comp: false,
            spindle_pwm: true,
            spindle_spinup_s: 2.0,
            spindle_min_rpm: 6_000.0,
            spindle_max_rpm: 24_000.0,
            spindle_reverse: false,
            probe_enabled: false,
            // 🔴 Z-ONLY, and the corner plate defaults to NOT DECLARED on the
            // workpiece. A plausible default for a corner plate is the dangerous
            // kind: it makes an XYZ probe RUN, using dimensions nobody measured,
            // and the resulting displacement is invisible in the preview.
            // Refusing costs a setup screen; guessing costs the part.
            probe_plate: ProbePlate::ZOnly,
            // 🔴 NOT DECLARED, and REFUSED when a probe is enabled. This read
            // `1.6` until 2026-08-09 — an unsourced number that RAN. The fix is
            // not a better number: see the field's doc block for why a sourced
            // catalogue figure would fail toward the spoilboard where this one
            // failed toward the air. Decision #43 P0.
            touch_plate_mm: None,
            probe_seek_feed: 200.0,
            probe_feed: 25.0,
            probe_max_mm: 30.0,
            probe_retract_mm: 2.0,
            probe_x: 0.0,
            probe_y: 0.0,
        }
    }
}

impl Machine {
    /// Everywhere the cutter can reach, as one named object.
    ///
    /// 🔴 It is DERIVED from the three travel fields, never stored alongside
    /// them. A second copy of the machine's limits is a second place for them to
    /// be wrong, and the copy nobody is looking at is the one that stays wrong —
    /// the same reason [`Stock::corner_placement`] recomputes a plate's position
    /// instead of caching it.
    pub fn travel_envelope(&self) -> TravelEnvelope {
        TravelEnvelope {
            size_x_mm: self.travel_x_mm,
            size_y_mm: self.travel_y_mm,
            size_z_mm: self.travel_z_mm,
        }
    }
}

/// **WHERE Z0 IS, and the only thing in this crate that answers it.**
///
/// 🔴 Every Z word this crate emits, and every reader of an emitted Z word,
/// asks this type. Nothing else may compute a datum offset — a second answer is
/// a program half-planned in one frame and half in the other, which is a cutter
/// driven one full workpiece thickness wrong.
///
/// # The two frames, and the one seam between them
///
/// **PLAN Z is always workpiece-top-local**: `0.0` is the uncut top face,
/// cutting moves are negative, `machine.safe_z_mm` is positive. Everything that
/// PLANS — `depth_passes`, the entry ramp, the safe-Z retracts, the simulation
/// height map, `Spoilboard::top_face_z_mm`, `Fixturing::clearance_z`,
/// `check_stock_depth` — stays in that frame and does not move when the operator
/// moves the datum. The workpiece still rests on the board whatever the
/// controller has been told about Z0.
///
/// **EMITTED Z is whatever the operator declared.** The translation between the
/// two happens exactly once, here. That is the design's whole safety property:
/// a forgotten site is one Z word that did not move, and a doubled site is one
/// that moved twice, and both are findable because there is one function to
/// look for.
///
/// # Why this is an enum and not the `bool` it replaces
///
/// `Stock::z_zero_at_top: bool` existed from 2026-06 and **reached no emitted
/// byte** — its only reader was a warning saying it had no readers — while the
/// CLI's `--spoilboard-zero` did the same job through a second, unrelated field
/// (`PostOptions::z_offset_mm`). Two controls answering one question, one of
/// them dead. Replacing the field rather than adding an accessor beside it makes
/// every present and future second answer a **compile error** instead of a
/// convention: `!stock.z_zero_at_top` no longer compiles anywhere.
///
/// ⚠ The **wire** key stays `z_zero_at_top` (`fixtures::StockCfg`, the wasm
/// boundary, every saved browser session). Renaming an identifier that has
/// already been serialised breaks restores; the domain model is what stops
/// having a boolean.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZDatum {
    /// The usual router convention: work zero on the workpiece TOP face.
    WorkpieceTop,
    /// Founder ruling 2026-08-11 (*"0Z should be on the bottom of the
    /// workpiece, top of the spoilboard"*): work zero on the SPOILBOARD's top
    /// face, which is the workpiece's underside.
    ///
    /// 🔴 The benefit — a through-cut targeting `Z0` exactly, so the last pass
    /// stops depending on the workpiece's real thickness — **exists only if the
    /// datum is ESTABLISHED AGAINST THE BOARD.** A datum that is arithmetically
    /// at the bottom and physically referenced to the workpiece top is strictly
    /// worse than doing nothing: the thickness error is back in full and the
    /// operator now believes it is gone. See `docs/design-87-z-datum.md` §3 —
    /// that decision is the founder's and it is still open.
    SpoilboardTop,
}

impl ZDatum {
    /// The number added to a PLAN Z to get the Z word that is EMITTED.
    ///
    /// The `stock` argument supplies the thickness and nothing else. 🔴 Pass the
    /// stock this datum came off — `stock.z_datum.emit_offset_mm(&stock)` — and
    /// never a datum from one setup with a workpiece from another.
    pub fn emit_offset_mm(self, stock: &Stock) -> f64 {
        match self {
            ZDatum::WorkpieceTop => 0.0,
            ZDatum::SpoilboardTop => stock.thickness_mm,
        }
    }

    /// The emitted Z word for one plan Z. **Every `Z` the post writes goes
    /// here**, cutting move, rapid, plunge, peck retract, tool-change lift and
    /// the program's opening and closing retracts alike.
    pub fn emit_z(self, plan_z_mm: f64, stock: &Stock) -> f64 {
        plan_z_mm + self.emit_offset_mm(stock)
    }

    /// The emitted Z at which the cutter is level with the workpiece UNDERSIDE
    /// — the number every reader of the EMITTED TEXT must compare against.
    /// `-thickness` under [`ZDatum::WorkpieceTop`], `0.0` under
    /// [`ZDatum::SpoilboardTop`].
    ///
    /// 🔴 **This is the one whose failure reads as safe.**
    /// [`crate::fixture::check_hold_down`] decides a cell is severed by testing
    /// emitted Zs against this number. Hard-coded to `-thickness`, a
    /// bottom-datum program has no move below it at all, so **nothing reads as
    /// severed, no component is ever unrestrained, and the report comes back
    /// empty** — and an empty findings list is the same colour as "checked and
    /// clear" to anyone not reading carefully. A loose part reported as held,
    /// under a 2.2 kW spindle.
    pub fn through_z_mm(self, stock: &Stock) -> f64 {
        self.emit_z(-stock.thickness_mm, stock)
    }

    /// The emitted Z of the workpiece TOP face — `0.0` under
    /// [`ZDatum::WorkpieceTop`], `+thickness` under [`ZDatum::SpoilboardTop`].
    /// A reader asking *"is this move cutting or is it above the surface"* asks
    /// this, not `0.0`.
    pub fn surface_z_mm(self, stock: &Stock) -> f64 {
        self.emit_z(0.0, stock)
    }

    /// How to name this datum to an operator, in a sentence that has to say
    /// which frame a number is in.
    pub fn label(self) -> &'static str {
        match self {
            ZDatum::WorkpieceTop => "workpiece top",
            ZDatum::SpoilboardTop => "spoilboard top",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Stock {
    pub thickness_mm: f64,
    pub size_x_mm: f64,
    pub size_y_mm: f64,

    pub origin_x_mm: f64,
    pub origin_y_mm: f64,
    /// How the workpiece is laid on the machine, degrees anticlockwise, about its own
    /// lower-left corner. The workpiece is then pushed back so that corner sits at
    /// the datum — `origin_*` keeps meaning "where the corner of the workpiece is",
    /// which is the thing a person measures with a tape.
    ///
    /// 🔴 This rotates the PROGRAM, not the picture. Every emitted coordinate
    /// goes through `place()`, including the ones the travel-limit check reads.
    /// A rotation that only turned the render would draw a workpiece lying one way
    /// and cut it lying the other.
    ///
    /// A 600x900 workpiece does not fit 1250x670 of travel. Turned a quarter turn
    /// it measures 900x600 and fits with room to spare — so this is not a
    /// convenience, it decides whether a job is refused.
    pub rotation_deg: f64,
    /// **Where Z0 is.** See [`ZDatum`] — it is the only thing in this crate
    /// that answers the question, and this is the only place the answer is
    /// stored.
    ///
    /// ⚠ It replaced a `bool` named `z_zero_at_top` on 2026-08-11. The **wire**
    /// key kept that name (`fixtures::StockCfg::z_zero_at_top`) because it has
    /// already been serialised into saved sessions; the domain model stopped
    /// having a boolean so that a second datum answer cannot be written.
    pub z_datum: ZDatum,
    /// A touch plate hooked over a corner of THIS workpiece. `None` = not declared,
    /// which is what every existing setup is, and an [`ProbePlate::Xyz`] machine
    /// with no declared corner plate is REFUSED rather than run on a guess.
    ///
    /// 🔴 It is here, on the SETUP, because it moves with the workpiece — see
    /// [`CornerPlate`]. Its position on the machine is never stored; it is derived
    /// through [`Stock::corner_placement`] every time it is asked for, so it
    /// cannot go stale when the workpiece is dragged or turned.
    pub corner_plate: Option<CornerPlate>,
}

impl Default for Stock {
    fn default() -> Self {
        Self {
            thickness_mm: 18.0,
            size_x_mm: 600.0,
            size_y_mm: 900.0,
            origin_x_mm: 0.0,
            origin_y_mm: 0.0,
            rotation_deg: 0.0,
            // 🔴 NOT the founder's ruling, DELIBERATELY, and not an oversight.
            // The default is what every fixture, every unit test and every
            // un-configured caller plans against, so flipping it is not a
            // setting change — it re-baselines the whole corpus at once. It
            // flips in its own change, after the probe knows which surface it
            // references (`docs/design-87-z-datum.md` §3, §7 step 5), and never
            // before: a bottom datum with a top-referenced probe is
            // arithmetically right, physically wrong, and it LOOKS solved.
            z_datum: ZDatum::WorkpieceTop,
            corner_plate: None,
        }
    }
}

impl Stock {
    /// Sine and cosine of the placement angle, with exact values on the quarter
    /// turns.
    ///
    /// 🔴 `(90f64).to_radians().cos()` is 6.1e-17, not 0. Left alone, a workpiece
    /// "at 90 degrees" lands 3e-14 mm out of square — harmless on its own, and
    /// it turns every equality in a test and every golden file into a
    /// floating-point near-miss. The quarter turns are the placements a person
    /// can actually register against a fence, so they are the ones that must be
    /// exact.
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

    /// True when the placement is a quarter turn.
    ///
    /// Anything else is runnable arithmetic and a fixturing problem: a workpiece at
    /// 37 degrees cannot be pushed against the machine's own axes, so the whole
    /// program inherits whatever angle the workpiece actually ended up at. The
    /// planner warns rather than refuses — with a jig it is a real placement —
    /// but silence here would be the wrong default.
    pub fn is_square_to_the_bed(&self) -> bool {
        let turns = self.rotation_deg / 90.0;
        (turns - turns.round()).abs() < 1e-9
    }

    /// The workpiece's bounding footprint in the machine's XY, after rotation.
    pub fn footprint(&self) -> (f64, f64) {
        let (s, c) = self.sin_cos();
        (
            (self.size_x_mm * c).abs() + (self.size_y_mm * s).abs(),
            (self.size_x_mm * s).abs() + (self.size_y_mm * c).abs(),
        )
    }

    /// Workpiece coordinates to machine coordinates: rotate, push the rotated workpiece
    /// back to its own corner, then offset by the datum.
    ///
    /// The push-back is what keeps the datum meaningful. Rotating a 600x900
    /// workpiece a quarter turn about its corner puts the whole of it in negative Y;
    /// with the correction, a quarter turn leaves the workpiece exactly where a
    /// person would have laid it — corner on the datum, extending out into the machine's XY.
    pub fn place(&self, x: f64, y: f64) -> (f64, f64) {
        let (s, c) = self.sin_cos();
        let (rx, ry) = (x * c - y * s, x * s + y * c);
        // Corners of the rotated workpiece, to find how far it has walked off the
        // datum. Cheaper closed forms exist per quadrant; this one is right for
        // every angle, including the free ones.
        let corners = [
            (0.0, 0.0),
            (self.size_x_mm * c, self.size_x_mm * s),
            (-self.size_y_mm * s, self.size_y_mm * c),
            (self.size_x_mm * c - self.size_y_mm * s, self.size_x_mm * s + self.size_y_mm * c),
        ];
        let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        (rx - min_x + self.origin_x_mm, ry - min_y + self.origin_y_mm)
    }

    /// The four corners of the workpiece, as placed in machine coordinates.
    fn placed_corners(&self) -> [(f64, f64); 4] {
        [
            self.place(0.0, 0.0),
            self.place(self.size_x_mm, 0.0),
            self.place(0.0, self.size_y_mm),
            self.place(self.size_x_mm, self.size_y_mm),
        ]
    }

    /// Where a corner plate hooked over `corner` actually sits ON THE MACHINE, and
    /// which way the tool must stand off from it in MACHINE axes.
    ///
    /// 🔴 THE POINT OF THIS FUNCTION: the plate follows the workpiece. Drag the workpiece
    /// 200mm across the machine and the returned position moves 200mm; turn it a
    /// quarter turn and the returned position goes round with it AND the stand-off
    /// directions swap axes. Nothing caches this — a stored plate position is
    /// exactly the stale datum this exists to prevent.
    ///
    /// It goes through [`Stock::place`] rather than doing its own arithmetic,
    /// because a second placement transform is a second placement model, and the
    /// day the two disagreed the difference would be a program measured from a
    /// corner that is not there.
    ///
    /// ⚠ The signs come from the PLACED rectangle, not from
    /// [`ProbeCorner::x_sign`]: the workpiece's "left" is the machine's left only at
    /// zero rotation. On a quarter turn the workpiece's left edge faces the machine's
    /// front, and a probe that drove on the workpiece's answer would move along the
    /// wrong axis entirely. Callers must check [`Stock::is_square_to_the_bed`]
    /// first — on a free angle the placed rectangle is not axis-aligned and a
    /// machine-axis side probe measures a slanted face.
    pub fn corner_placement(&self, corner: ProbeCorner) -> CornerPlacement {
        let sheet_x = if corner.x_sign() < 0.0 { 0.0 } else { self.size_x_mm };
        let sheet_y = if corner.y_sign() < 0.0 { 0.0 } else { self.size_y_mm };
        let (x, y) = self.place(sheet_x, sheet_y);

        let all = self.placed_corners();
        let min_x = all.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let max_x = all.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
        let min_y = all.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        let max_y = all.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);

        CornerPlacement {
            x,
            y,
            // Nearest side wins rather than an equality test: `place` is exact on
            // the quarter turns but the free angles are ordinary arithmetic, and
            // an equality here would silently pick the min side on a rounding
            // difference of 1e-14.
            x_sign: if x <= 0.5 * (min_x + max_x) { -1.0 } else { 1.0 },
            y_sign: if y <= 0.5 * (min_y + max_y) { -1.0 } else { 1.0 },
        }
    }

    /// Whether the workpiece fits the machine AS PLACED.
    ///
    /// 🔴 This used to compare `size_x` to `travel_x` and `size_y` to
    /// `travel_y`, which is the unrotated footprint and therefore a different
    /// question. It refused a 600x900 workpiece on a 1250x670 machine — a workpiece
    /// that fits, turned the way anyone would turn it.
    pub fn fits(&self, m: &Machine) -> bool {
        let (fx, fy) = self.footprint();
        fx <= m.travel_x_mm && fy <= m.travel_y_mm
    }

    /// The quarter turn that would make this workpiece fit, if one would and the
    /// current placement does not. Named so the refusal can say what to do
    /// instead of only saying no.
    pub fn quarter_turn_that_fits(&self, m: &Machine) -> Option<f64> {
        if self.fits(m) {
            return None;
        }
        [90.0, 180.0, 270.0].into_iter().find(|deg| {
            let mut t = self.clone();
            t.rotation_deg = self.rotation_deg + deg;
            t.fits(m)
        })
    }
}

#[derive(Clone, Debug)]
pub struct TabSpec {
    pub enabled: bool,
    /// Material left under the tool.
    pub height_mm: f64,
    pub width_mm: f64,
    /// `0` = derive from perimeter / `min_spacing_mm`.
    pub count: u32,
    pub min_spacing_mm: f64,
}

impl Default for TabSpec {
    fn default() -> Self {
        Self { enabled: true, height_mm: 3.0, width_mm: 8.0, count: 0, min_spacing_mm: 150.0 }
    }
}

#[derive(Clone, Debug)]
pub struct OperationParams {
    pub op_type: OpType,
    pub side: CutSide,
    pub direction: Direction,
    pub entry: EntryMode,
    pub dogbone: DogboneStyle,

    pub depth_total_mm: f64,
    pub depth_per_pass_mm: f64,
    /// Left on for a final spring pass.
    pub finish_allowance_mm: f64,
    pub ramp_length_mm: f64,
    /// Radius of the tangential arc the tool enters and leaves on. `0.0` = no
    /// lead: the tool arrives at the wall along the wall, which leaves a witness
    /// mark where it changed from approaching to cutting.
    pub lead_mm: f64,

    pub tabs: TabSpec,

    pub rpm: f64,
    /// `0.0` = derive via [`crate::feeds::feed_from_chipload`].
    pub feed_mm_min: f64,
    pub plunge_mm_min: f64,

    /// Peck drilling ([`OpType::Drill`]). Emitted as G83 when the controller
    /// supports it.
    pub peck_depth_mm: f64,
    pub drill_dwell_s: f64,
}

impl Default for OperationParams {
    fn default() -> Self {
        Self {
            op_type: OpType::Profile,
            side: CutSide::Outside,
            direction: Direction::Climb,
            entry: EntryMode::Ramp,
            dogbone: DogboneStyle::None,
            depth_total_mm: 18.0,
            depth_per_pass_mm: 3.0,
            finish_allowance_mm: 0.0,
            ramp_length_mm: 20.0,
            lead_mm: 0.0,
            tabs: TabSpec::default(),
            rpm: 18_000.0,
            feed_mm_min: 0.0,
            plunge_mm_min: 300.0,
            peck_depth_mm: 4.0,
            drill_dwell_s: 0.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Toolpath representation — controller-agnostic. A post-processor turns this
// into a dialect; nothing here may assume grbl, LinuxCNC or anything else.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveKind {
    /// G0
    Rapid,
    /// G1
    Feed,
    /// G2
    ArcCW,
    /// G3
    ArcCCW,
    /// G81/G83 — or expanded by the post if the controller lacks canned cycles.
    DrillCycle,
    /// Manual tool change: stop the spindle, pause, wait for the operator.
    /// `text` names the tool so the operator knows what to fit.
    ToolChange,
    /// Work-holding change: stop the spindle, pause, wait for the operator to
    /// move clamps. `text` names the phase the program is entering.
    ///
    /// 🔴 DIFFERENT PHYSICS FROM A TOOL CHANGE. A tool change does not alter
    /// what holds the work down; this does, and the instruction is *new clamp
    /// on before old clamp off* or the part is loose mid-program. The post
    /// emits `M5`, a comment, and `M0` — the same observable as a tool change
    /// — because the operator reads the COMMENT, not the M-code, and the two
    /// pauses describe different procedures. The fixture check runs PER PHASE
    /// against that phase's own clamp set, so each segment is independently
    /// verified.
    ///
    /// After a clamp change the DATUM may have shifted (the part may have
    /// moved under the new clamping), so the next move MUST be a re-probe.
    /// [`Job::probe_after_clamp_change`] controls this; the default is `true`
    /// and skipping it is a deliberate choice with a physical consequence.
    ClampChange,
    /// Re-reference Z from the touch plate. Emitted after a tool change, because
    /// a new tool has a different length and the old Z zero is now wrong.
    Probe,
    SpindleOn,
    SpindleOff,
    Dwell,
    Comment,
}

#[derive(Clone, Debug)]
pub struct Move {
    pub kind: MoveKind,
    /// Target, mm, work coordinates.
    pub to: Vec3,
    /// Arc centre (absolute, mm) for [`MoveKind::ArcCW`] / [`MoveKind::ArcCCW`].
    pub centre: Vec2,
    /// mm/min; `0.0` = unchanged/rapid.
    pub feed: f64,
    /// rpm for `SpindleOn`, seconds for `Dwell`, peck increment for `DrillCycle`.
    pub value: f64,
    /// `Comment` only.
    pub text: String,
    /// Radius of the cutter that makes THIS move, mm. `0.0` = not stamped, and
    /// the consumer falls back to the toolpath's tool.
    ///
    /// 🔴 It has to be per MOVE because `Toolpath` carries ONE `tool` while a
    /// program can use several. The material-removal simulation lowers every
    /// cell within `radius` of a move, so the radius IS the geometry of removal
    /// — and simulating a whole multi-tool program at the first tool's radius
    /// models a machine nobody owns.
    ///
    /// ⚠ It fails in the UNSAFE direction. `multi-tool` holes with a 3.175mm
    /// cutter and profiles with a 6mm one, and `path.tool` is the 3.175: every
    /// 6mm cut was simulated at half its true width, so material the real cutter
    /// removes was left standing in the model — and a gouge that genuinely
    /// happens can be MISSING from the counts an operator trusts.
    pub tool_r_mm: f64,
}

impl Default for Move {
    fn default() -> Self {
        Self {
            kind: MoveKind::Feed,
            to: Vec3::default(),
            centre: Vec2::default(),
            feed: 0.0,
            value: 0.0,
            text: String::new(),
            tool_r_mm: 0.0,
        }
    }
}

/// How near zero a centre-format arc's swept angle has to be before it is read
/// as a **full circle** rather than as a zero-length sliver, in radians.
///
/// 🔴 The direction of this choice is deliberate. In **centre-format** `G2`/`G3`
/// an arc whose endpoint coincides with its start is a **full turn** — that is
/// the interpretation of the code itself, not a controller quirk, so a sweep
/// that rounds to nothing is bounded as **the circle**. Reading it as a sliver
/// would leave exactly the `2r` hole in the travel check that this whole
/// arc-extent pass exists to close.
///
/// ⚠ The cost, named rather than hidden: a genuine arc thinner than this is
/// over-bounded, by up to a diameter. At `1e-6` rad that arc is 3e-5 mm long on
/// a 30mm radius — geometry no cutter expresses and nothing this core emits, so
/// the over-bound is paid on programs that are already degenerate, and the
/// under-bound it replaces was paid on ordinary bores.
///
/// ⚠ **The exact tolerance grblHAL itself uses to decide "this is a full turn"
/// is NOT verified here** — this lane's rule is that a dialect fact comes from
/// `pcb` or from a probe transcript, and neither has been asked. `1e-6` is a
/// bounding choice on our side, picked to sit far below any real geometry while
/// still catching float noise; it is not a claim about the firmware. If the
/// firmware's window turns out to be WIDER than this, the safe move is to widen
/// this constant to match, because the gap between the two is a band of arcs the
/// machine would run as circles and this bound would call slivers.
pub const ARC_FULL_TURN_EPS_RAD: f64 = 1e-6;

/// The XY window a `G2`/`G3` actually sweeps — **not** the box of its endpoints.
///
/// 🔴 THE FINDING THIS EXISTS FOR (audit B3, 2026-08-10). An arc leaves the box
/// its two endpoints describe wherever it crosses an axis-aligned tangent, and
/// every travel, spoilboard, workpiece-edge and datum check in this crate is built
/// on that box. A single 180° arc missed by the FULL RADIUS — 30mm measured —
/// and on the planner path a bore whose tool centre reached Y901 on 900mm of Y
/// travel reported `max_y 893.871` with `check_machine_limits` returning `[]`.
///
/// ⚠ And the 6mm miss on that bore was an ACCIDENT, which is the more important
/// half: the tab/ramp Z-stepping loop happened to split the arc finely enough to
/// track the curve. A safety bound whose error is set by an unrelated emission
/// density is not a bound. This function is therefore **exact** — the extremes
/// are the tangent points the arc provably passes through — and not a sampler,
/// because a sampled bound is the same accident wearing a parameter.
///
/// `from` is the previous positioning move's destination. `None` means the arc's
/// start is not known here (an arc as the first positioning move; the post
/// refuses that separately), and the answer is then the **whole circle** at the
/// endpoint's radius — the tightest window that is still true when the direction
/// of travel is unknowable.
///
/// Z is not part of the answer: Z varies linearly along an arc exactly as it
/// does along a straight move, so the endpoint fold already has it.
///
/// Every input must be finite; a caller with a non-finite centre has a move
/// whose path is unknown, not a move to bound (see [`Move::geometry_is_finite`]).
pub fn arc_xy_extent(from: Option<Vec2>, to: Vec2, centre: Vec2, cw: bool) -> (f64, f64, f64, f64) {
    use std::f64::consts::{FRAC_PI_2, PI, TAU};

    let r_of = |p: Vec2| ((p.x - centre.x).powi(2) + (p.y - centre.y).powi(2)).sqrt();
    let ang_of = |p: Vec2| (p.y - centre.y).atan2(p.x - centre.x);

    // The radius is taken as the LARGER of the two ends. They should agree; when
    // they do not the geometry is already inconsistent, and bounding the smaller
    // one would put part of the swept path outside the answer.
    let r = match from {
        Some(f) => r_of(f).max(r_of(to)),
        None => r_of(to),
    };

    // Start from the endpoints as they really are, so an arc whose ends disagree
    // on radius is still bounded by its own coordinates and not by a nominal one.
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (to.x, to.y, to.x, to.y);
    if let Some(f) = from {
        min_x = min_x.min(f.x);
        min_y = min_y.min(f.y);
        max_x = max_x.max(f.x);
        max_y = max_y.max(f.y);
    }

    // Which of the four axis-aligned tangents the arc passes through. Travelling
    // CW the angle decreases, CCW it increases; an angle is on the arc when the
    // turn from the start to it, taken in the direction of travel, is no more
    // than the whole sweep. `None` = the start is unknown, so every tangent is
    // possible and all four are taken.
    let start_and_sweep = from.map(|f| {
        let a0 = ang_of(f);
        let a1 = ang_of(to);
        let raw = if cw { a0 - a1 } else { a1 - a0 };
        let sweep = raw.rem_euclid(TAU);
        (a0, if sweep <= ARC_FULL_TURN_EPS_RAD { TAU } else { sweep })
    });

    for (theta, dx, dy) in [
        (0.0, 1.0, 0.0),
        (FRAC_PI_2, 0.0, 1.0),
        (PI, -1.0, 0.0),
        (3.0 * FRAC_PI_2, 0.0, -1.0),
    ] {
        if let Some((a0, sweep)) = start_and_sweep {
            let d = if cw { a0 - theta } else { theta - a0 };
            if d.rem_euclid(TAU) > sweep + 1e-12 {
                continue;
            }
        }
        let x = centre.x + r * dx;
        let y = centre.y + r * dy;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }

    (min_x, min_y, max_x, max_y)
}

impl Move {
    /// Whether every coordinate this move's PATH depends on is a number.
    ///
    /// 🔴 For an arc that is the destination **and the centre**. A `G2` with a
    /// finite endpoint and a `NaN` centre has a perfectly plausible destination
    /// and a swept path nobody can compute — so it is the same class as a
    /// non-finite destination, and a box folded from its endpoint alone would
    /// look measured while omitting everything between.
    pub fn geometry_is_finite(&self) -> bool {
        let ends = self.to.x.is_finite() && self.to.y.is_finite() && self.to.z.is_finite();
        match self.kind {
            MoveKind::ArcCW | MoveKind::ArcCCW => {
                ends && self.centre.x.is_finite() && self.centre.y.is_finite()
            }
            _ => ends,
        }
    }

    pub fn rapid(p: Vec3) -> Self {
        Self { kind: MoveKind::Rapid, to: p, ..Default::default() }
    }
    pub fn feed_to(p: Vec3, f: f64) -> Self {
        Self { kind: MoveKind::Feed, to: p, feed: f, ..Default::default() }
    }
    pub fn arc(cw: bool, p: Vec3, centre: Vec2, f: f64) -> Self {
        Self {
            kind: if cw { MoveKind::ArcCW } else { MoveKind::ArcCCW },
            to: p,
            centre,
            feed: f,
            ..Default::default()
        }
    }
    pub fn drill(p: Vec3, peck: f64, f: f64) -> Self {
        Self { kind: MoveKind::DrillCycle, to: p, value: peck, feed: f, ..Default::default() }
    }
    pub fn comment(s: impl Into<String>) -> Self {
        Self { kind: MoveKind::Comment, text: s.into(), ..Default::default() }
    }
    pub fn spindle_on(rpm: f64) -> Self {
        Self { kind: MoveKind::SpindleOn, value: rpm, ..Default::default() }
    }
    pub fn spindle_off() -> Self {
        Self { kind: MoveKind::SpindleOff, ..Default::default() }
    }
    pub fn dwell(s: f64) -> Self {
        Self { kind: MoveKind::Dwell, value: s, ..Default::default() }
    }
    pub fn tool_change(name: impl Into<String>) -> Self {
        Self { kind: MoveKind::ToolChange, text: name.into(), ..Default::default() }
    }
    /// A work-holding change — the operator must move clamps.
    /// `text` names the phase being entered.
    pub fn clamp_change(phase_name: impl Into<String>) -> Self {
        Self { kind: MoveKind::ClampChange, text: phase_name.into(), ..Default::default() }
    }
    pub fn probe() -> Self {
        Self { kind: MoveKind::Probe, ..Default::default() }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Toolpath {
    pub moves: Vec<Move>,
    pub tool: Tool,
    /// Bounding box actually used, mm — filled by the generator so a limit check
    /// does not have to re-derive it.
    pub min_x: f64,
    pub min_y: f64,
    pub min_z: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub max_z: f64,
    /// Indices of positioning moves whose geometry carries a non-finite
    /// coordinate — the destination, or an arc's centre — as found by the LAST
    /// [`Toolpath::recompute_bounds`].
    ///
    /// ⚠ It is a SNAPSHOT, not a live property: append a move and this is stale
    /// until the bounds are recomputed, exactly as the bounds themselves are.
    /// Anything deciding whether to emit a program must use
    /// [`Toolpath::first_nonfinite_move`], which always reads the moves.
    pub nonfinite_moves: Vec<usize>,
}

impl Toolpath {
    pub fn is_empty(&self) -> bool {
        self.moves.is_empty()
    }

    /// True for the move kinds that actually position the tool — the only ones
    /// that carry a coordinate a controller will execute.
    ///
    /// Public so a consumer scanning the moves itself (`Extent::from_toolpath`)
    /// asks the same question this fold does. Two copies of this list is how a
    /// guard ends up covering a different set of moves than the box it guards.
    pub fn positions(kind: MoveKind) -> bool {
        matches!(
            kind,
            MoveKind::Rapid
                | MoveKind::Feed
                | MoveKind::ArcCW
                | MoveKind::ArcCCW
                | MoveKind::DrillCycle
        )
    }

    /// The first positioning move whose GEOMETRY is not a number, scanned FRESH
    /// every call — the destination, and for an arc its centre too.
    ///
    /// 🔴 This is the one to ask before emitting anything. `nonfinite_moves` is
    /// whatever the last `recompute_bounds` saw, and a path assembled from
    /// several planned operations (as `job.rs` does) has had moves appended
    /// since — a stale clean record reads exactly like a clean path.
    ///
    /// ⚠ The arc centre was added 2026-08-10 with the arc-extent fix, and it is
    /// not a widening for its own sake: the fold below now EXCLUDES such an arc
    /// from the box, because there is no finite window that contains a path
    /// nobody can compute. A consumer that did not also learn to ask would read
    /// a box that quietly omits a move — which is the NaN-destination defect
    /// again, one field across.
    pub fn first_nonfinite_move(&self) -> Option<(usize, &Move)> {
        self.moves
            .iter()
            .enumerate()
            .find(|(_, m)| Self::positions(m.kind) && !m.geometry_is_finite())
    }

    /// Recompute the bounding box from the moves that actually position the
    /// tool. Comments, spindle and dwell records carry no coordinate and must
    /// not drag the box to the origin — that is how a bogus `min == 0` slips
    /// past a travel-limit check.
    ///
    /// # 🔴 A NON-FINITE COORDINATE MAY NOT BE SWALLOWED HERE
    ///
    /// This fold used to be plain `f64::min` / `f64::max`, and **those return
    /// the OTHER operand when one side is NaN** (IEEE-754 `minNum`/`maxNum`
    /// semantics, which Rust follows). A `G1 XNaN YNaN` move therefore never
    /// widened the box: the box stayed finite, stayed inside the machine, and
    /// **every check built on it — travel limits, spoilboard depth, the
    /// placement extent, the fixture sweep — vouched for a program containing a
    /// move that has no destination.** That is not one blind check, it is every
    /// check downstream of this function, which is why the fix belongs here and
    /// not in any one of them.
    ///
    /// So the fold now **notices**: a non-finite coordinate is excluded from the
    /// envelope (it cannot contribute a number) and its move index is recorded
    /// in [`Toolpath::nonfinite_moves`]. The six numbers therefore describe
    /// exactly the moves they COULD measure, and the fact that there were others
    /// is carried alongside them instead of being lost in an `f64` comparison.
    ///
    /// 🔴 **THE SIX NUMBERS ALONE ARE NO LONGER A COMPLETE ANSWER, AND A
    /// CONSUMER MUST NOT TREAT THEM AS ONE.** Anything asking "does this program
    /// fit / is it deep enough / where does it go" has to check
    /// `nonfinite_moves` (or, if it might be reading a path that has been
    /// appended to since, [`Toolpath::first_nonfinite_move`]) before believing
    /// the box. `check_machine_limits`, `check_stock_depth`, `post_grblhal` and
    /// `Extent::from_toolpath` all do.
    ///
    /// # ⚠ Two poisonings were considered and both rejected — the reasons matter
    ///
    ///  * **NaN bounds.** Every comparison against NaN is `false`, so
    ///    `min_x < 0.0` would be `false` and the travel check would PASS. That is
    ///    the identical blindness moved one level up, and it would be harder to
    ///    find because the number no longer looks plausible.
    ///  * **±infinite bounds** (so that every existing `<`/`>` test fires
    ///    unchanged). Genuinely stronger for consumers nobody has written yet —
    ///    but it silently inverts the precondition of a live negative control in
    ///    `placement.rs`, which asserts the box IS finite in order to prove that
    ///    `Extent::from_toolpath` cannot rely on it. Turning another lane's
    ///    armed test into a vacuous one, in the same change that fixes the bug it
    ///    was written for, buys the wrong thing. If that control is ever
    ///    rewritten in terms of `nonfinite_moves`, widening becomes the better
    ///    option and should be taken.
    /// # 🔴 AN ARC IS BOUNDED BY ITS CURVE, NOT BY ITS TWO ENDS
    ///
    /// This fold used to take `m.to` and nothing else. For `G0`/`G1`/`G81` that
    /// is right — the segment is inside the box of its ends on every axis. **For
    /// `G2`/`G3` it is wrong in the direction of the machine's own frame**: the
    /// arc bulges out to its extreme wherever it crosses an axis-aligned
    /// tangent, and a semicircle therefore left the box by the FULL RADIUS.
    /// Measured on the planner path with shipped defaults (audit B3,
    /// 2026-08-10): a bore whose tool centre reaches **Y901.0** on 900mm of Y
    /// travel reported `max_y 893.871`, and `check_machine_limits` returned
    /// `[]`. Gate G3 green, 1.0mm past the soft limit.
    ///
    /// ⚠ And the 6mm of that miss was an **accident of emission density** — the
    /// tab/ramp Z-stepping loop in `toolpath.rs` splits arcs finely whenever Z
    /// changes, so the endpoint box happened to track the curve to 0.44mm on
    /// that bore. Turn tabs off or ask for a plunge entry and the error returns
    /// to the whole radius. So the fix is not "emit more points": the extremes
    /// are computed exactly, by [`arc_xy_extent`], and the answer no longer
    /// depends on how anything upstream chose to subdivide.
    ///
    /// The arc's START is the previous positioning move's destination, so this
    /// fold carries a cursor. A move whose geometry could not be measured clears
    /// it: an arc cannot be swept from a position nobody knows.
    ///
    /// Z is unchanged and still endpoint-folded — Z varies linearly along every
    /// move kind, arcs included, so the endpoint minimum IS the true minimum.
    pub fn recompute_bounds(&mut self) {
        let mut any = false;
        let (mut nx, mut ny, mut nz) = (f64::INFINITY, f64::INFINITY, f64::INFINITY);
        let (mut xx, mut xy, mut xz) = (f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut bad: Vec<usize> = Vec::new();
        let mut cursor: Option<Vec2> = None;
        for (i, m) in self.moves.iter().enumerate() {
            if !Self::positions(m.kind) {
                continue;
            }
            any = true;
            if !m.geometry_is_finite() {
                bad.push(i);
                // Where the tool is after an unmeasurable move is unknown, so an
                // arc starting here has no start. Bounding it from the last
                // GOOD position would be a curve the machine does not run.
                cursor = None;
                continue;
            }
            let (lo_x, lo_y, hi_x, hi_y) = match m.kind {
                MoveKind::ArcCW | MoveKind::ArcCCW => arc_xy_extent(
                    cursor,
                    Vec2::new(m.to.x, m.to.y),
                    m.centre,
                    m.kind == MoveKind::ArcCW,
                ),
                _ => (m.to.x, m.to.y, m.to.x, m.to.y),
            };
            nx = nx.min(lo_x);
            ny = ny.min(lo_y);
            nz = nz.min(m.to.z);
            xx = xx.max(hi_x);
            xy = xy.max(hi_y);
            xz = xz.max(m.to.z);
            cursor = Some(Vec2::new(m.to.x, m.to.y));
        }
        self.nonfinite_moves = bad;
        if !any {
            return;
        }
        // Every positioning move was non-finite: there is no envelope to state,
        // and leaving the previous one in place would be the stalest possible
        // answer. The sentinels are left as they are (min > max), which is not a
        // box any check can pass.
        if nx > xx {
            return;
        }
        self.min_x = nx;
        self.min_y = ny;
        self.min_z = nz;
        self.max_x = xx;
        self.max_y = xy;
        self.max_z = xz;
    }
}

/// **Travel is reach, the spoilboard is material, and they are not the same
/// rectangle** (2026-08-10).
///
/// Every test here is written so that it FAILS on the model that shipped until
/// today — a machine that knows only `travel_*` and therefore has to answer
/// "is there spoilboard under this XY" with a shrug or with a lie.
#[cfg(test)]
mod spoilboard_tests {
    use super::*;

    fn m600x900() -> Machine {
        Machine::default()
    }

    #[test]
    fn an_undeclared_spoilboard_is_none_and_not_a_board_the_size_of_the_travel() {
        // 🔴 THE ONE THAT MATTERS. The tempting default is "it covers
        // everything", and that default makes a cutter in the frame report as a
        // normal sacrificial pass. A machine nobody has told about its board
        // must hold NOTHING here.
        let m = m600x900();
        assert!(
            m.spoilboard.is_none(),
            "the default machine acquired a spoilboard nobody declared: {:?}",
            m.spoilboard
        );
    }

    #[test]
    fn the_travel_envelope_is_the_three_travel_numbers_and_is_not_stored_twice() {
        let mut m = m600x900();
        m.travel_x_mm = 1250.0;
        m.travel_y_mm = 670.0;
        m.travel_z_mm = 90.0;
        let t = m.travel_envelope();
        assert_eq!((t.size_x_mm, t.size_y_mm, t.size_z_mm), (1250.0, 670.0, 90.0));
        // Derived, not cached: moving the machine's limit moves the envelope
        // with no second field to update.
        m.travel_x_mm = 300.0;
        assert_eq!(m.travel_envelope().size_x_mm, 300.0);
    }

    #[test]
    fn the_travel_envelope_starts_at_the_datum_which_is_what_the_post_checks() {
        let t = m600x900().travel_envelope();
        assert!(t.contains_xy(0.0, 0.0));
        assert!(t.contains_xy(600.0, 900.0));
        assert!(!t.contains_xy(-0.001, 10.0), "negative X is off the machine, not on it");
        assert!(!t.contains_xy(600.001, 10.0));
    }

    #[test]
    fn a_board_that_does_not_start_at_the_datum_leaves_bare_machine_it_can_reach() {
        // 🔴 THE PHYSICAL CASE. 500x700 of MDF bolted 50mm in from the datum on
        // a 600x900 machine. Under the old model the machine knew 600x900 and
        // nothing else, so every one of these XYs was "the spoilboard".
        let b = Spoilboard::new("mdf", 50.0, 100.0, 500.0, 700.0);
        let m = m600x900();
        assert!(b.covers(50.0, 100.0), "the board's own corner is on the board");
        assert!(b.covers(300.0, 400.0));
        assert!(!b.covers(20.0, 400.0), "20mm in X is 30mm short of the board — bare rail");
        assert!(!b.covers(580.0, 400.0), "the board stops at X550; X580 is frame");
        assert!(!b.covers(300.0, 850.0), "the board stops at Y800; Y850 is frame");

        let bare = b.bare_reach(&m);
        assert_eq!(
            (bare.minus_x_mm, bare.plus_x_mm, bare.minus_y_mm, bare.plus_y_mm),
            (50.0, 50.0, 100.0, 100.0)
        );
        assert!(bare.any());
        assert!(!b.covers_travel(&m));
        assert_eq!(
            bare.describe().as_deref(),
            Some("50.0mm on X-, 50.0mm on X+, 100.0mm on Y-, 100.0mm on Y+")
        );
    }

    #[test]
    fn a_board_larger_than_the_travel_leaves_nothing_bare_and_says_so() {
        // The positive control for the test above: without it, a `bare_reach`
        // that always reported strips would look like a working check.
        let b = Spoilboard::new("full sheet", -30.0, -30.0, 2400.0, 1200.0);
        let m = m600x900();
        let bare = b.bare_reach(&m);
        assert!(!bare.any(), "a board overhanging the machine left bare reach: {bare:?}");
        assert!(b.covers_travel(&m));
        assert_eq!(bare.describe(), None);
    }

    #[test]
    fn a_zero_sized_board_is_a_fault_and_not_a_way_to_say_there_is_no_board() {
        // 🔴 A board with no area answers `covers == false` EVERYWHERE, which
        // turns every legitimate through-cut into a strike on the frame. A false
        // red across a whole job is how a real one stops being read, so this has
        // to be a named declaration fault rather than a silently strict board.
        let b = Spoilboard::new("typo", 0.0, 0.0, 0.0, 0.0);
        let faults = b.faults();
        assert_eq!(faults.len(), 1, "{faults:?}");
        assert!(faults[0].contains("no area"), "{}", faults[0]);
        assert!(
            faults[0].contains("leave the spoilboard undeclared"),
            "the fault must say what to do instead: {}",
            faults[0]
        );
        assert!(!b.covers(0.0, 0.0) || b.covers(0.0, 0.0), "covers() must not panic on a fault");
        // And a faulted board reports no bare strips rather than inventing them
        // from nonsense numbers.
        assert!(!b.bare_reach(&m600x900()).any());
    }

    #[test]
    fn a_nonfinite_board_is_a_fault_before_any_arithmetic_is_believed() {
        let b = Spoilboard::new("nan", f64::NAN, 0.0, 500.0, 500.0);
        let faults = b.faults();
        assert_eq!(faults.len(), 1, "{faults:?}");
        assert!(faults[0].contains("non-finite"), "{}", faults[0]);
        assert!(!b.covers(10.0, 10.0), "a NaN rectangle must contain nothing");
    }

    #[test]
    fn a_good_board_has_no_faults() {
        // The control that stops `faults()` being satisfied by a constant
        // complaint.
        assert!(Spoilboard::new("ok", 0.0, 0.0, 1080.0, 1560.0).faults().is_empty());
    }

    #[test]
    fn a_board_declared_without_a_thickness_is_unknown_and_gets_no_default() {
        // 🔴 The single most important property of the field: absent must not
        // acquire a value on the way anywhere. No workpiece-thickness fallback, no
        // catalogue median, no "most boards are 18".
        let b = Spoilboard::new("mdf", 0.0, 0.0, 1080.0, 1560.0);
        assert_eq!(b.thickness_mm, None);
        assert_eq!(b.usable_thickness_mm(), None);
        assert_eq!(b.underside_z_mm(18.0), None, "an underside was invented with no thickness");
        // ⚠ And it is not a FAULT — nobody did anything wrong by not knowing.
        // A fault would push it toward "fix your declaration"; the honest
        // reading is "this check has not run".
        assert!(b.thickness_faults().is_empty());
        assert!(b.declaration_faults().is_empty());
    }

    #[test]
    fn the_board_top_is_the_stock_underside_and_it_is_said_in_one_place() {
        // The stack used to have no height at all: nothing in this crate stated
        // where the board's top face sat, so the workpiece bottom was at the
        // board top by assumption. Now it is by construction, here.
        let b = Spoilboard::new("mdf", 0.0, 0.0, 1080.0, 1560.0).with_thickness(18.0);
        assert_eq!(b.top_face_z_mm(18.0), -18.0);
        assert_eq!(b.underside_z_mm(18.0), Some(-36.0));
        // A thinner workpiece moves the whole board up with it — the board is under
        // the work, not at a fixed depth below the datum.
        assert_eq!(b.top_face_z_mm(12.0), -12.0);
        assert_eq!(b.underside_z_mm(12.0), Some(-30.0));
        // A workpiece thickness that is not a number cannot produce a floor either.
        assert_eq!(b.underside_z_mm(f64::NAN), None);
    }

    #[test]
    fn a_thickness_fault_is_reported_and_does_not_join_the_rectangle_faults() {
        // 🔴 THE LIMB-INDEPENDENCE CONTROL. `sim::check` gates the POSITION limb
        // on `faults()`. If a thickness typo landed in that list, one bad number
        // would switch off the answer to "is there a board under this XY at
        // all" — a question the typo says nothing about.
        for bad in [0.0, -3.0, f64::NAN, f64::INFINITY] {
            let b = Spoilboard::new("typo", 0.0, 0.0, 1080.0, 1560.0).with_thickness(bad);
            assert!(
                b.faults().is_empty(),
                "a thickness of {bad} faulted the RECTANGLE and would disable the position limb"
            );
            let tf = b.thickness_faults();
            assert_eq!(tf.len(), 1, "a thickness of {bad} went unreported");
            assert!(tf[0].contains("is not a slab"), "{}", tf[0]);
            // The union exists for whoever has to show the operator what they
            // typed — reporting, never gating.
            assert_eq!(b.declaration_faults(), tf);
            assert_eq!(b.usable_thickness_mm(), None);
            assert_eq!(b.underside_z_mm(18.0), None);
        }
        // The control that stops the assertion above being satisfied by a
        // constant complaint.
        let ok = Spoilboard::new("fine", 0.0, 0.0, 1080.0, 1560.0).with_thickness(18.0);
        assert!(ok.thickness_faults().is_empty());
        assert!(ok.declaration_faults().is_empty());
    }

    #[test]
    fn the_corners_are_the_rectangle_and_are_the_only_source_a_picture_may_use() {
        let b = Spoilboard::new("mdf", 10.0, 20.0, 100.0, 200.0);
        assert_eq!(
            b.corners(),
            [(10.0, 20.0), (110.0, 20.0), (110.0, 220.0), (10.0, 220.0)]
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_with_one_nan_move() -> Toolpath {
        Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(10.0, 10.0, 5.0)),
                Move::feed_to(Vec3::new(10.0, 10.0, -3.0), 300.0),
                Move::feed_to(Vec3::new(f64::NAN, f64::NAN, -3.0), 1200.0),
                Move::feed_to(Vec3::new(90.0, 60.0, -3.0), 1200.0),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn recompute_bounds_records_the_move_it_could_not_measure() {
        // 🔴 THE SYSTEMIC HALF. `f64::min`/`f64::max` RETURN THE OTHER OPERAND
        // when one side is NaN, so the fold used to run to completion having
        // silently ignored a move — and NOTHING anywhere said so. The box stayed
        // finite, stayed inside the machine, and every check built on it
        // therefore vouched for a program containing a move with no destination.
        let mut p = path_with_one_nan_move();
        p.recompute_bounds();
        assert_eq!(
            p.nonfinite_moves,
            vec![2],
            "the fold ignored a move and said nothing about it — box {}..{} x {}..{}",
            p.min_x,
            p.max_x,
            p.min_y,
            p.max_y
        );
        // ...and the always-fresh scan agrees, which is the one a consumer must
        // use when the path may have been appended to since.
        let (i, _) = p.first_nonfinite_move().expect("the fresh scan missed it");
        assert_eq!(i, 2);
    }

    #[test]
    fn a_clean_path_records_nothing_and_the_fresh_scan_agrees() {
        // The negative control. Without it, an implementation that reported
        // every path as non-finite would pass the test above and read as a
        // working guard while refusing every job.
        let mut p = path_with_one_nan_move();
        p.moves[2] = Move::feed_to(Vec3::new(50.0, 30.0, -3.0), 1200.0);
        p.recompute_bounds();
        assert!(p.nonfinite_moves.is_empty(), "a clean path was flagged: {:?}", p.nonfinite_moves);
        assert!(p.first_nonfinite_move().is_none());
    }

    #[test]
    fn a_comment_carries_no_coordinate_and_is_not_a_finding() {
        // The default `Vec3` is all-zero, but a comment has no destination at
        // all. Counting it would drag the box to the origin (the defect the
        // original doc comment names) and, if it were ever built with NaN, would
        // refuse a perfectly good program.
        let mut p = Toolpath {
            moves: vec![
                Move::comment("no coordinate here"),
                Move::feed_to(Vec3::new(10.0, 10.0, -3.0), 300.0),
                Move::feed_to(Vec3::new(90.0, 60.0, -3.0), 300.0),
            ],
            ..Default::default()
        };
        p.recompute_bounds();
        assert!(p.nonfinite_moves.is_empty());
        assert_eq!((p.min_x, p.max_x), (10.0, 90.0), "a comment widened the box");
    }

    #[test]
    fn a_bounding_box_describes_only_what_it_could_measure() {
        // 🔴 THE SYSTEMIC HALF OF THE NaN DEFECT, and the reason every existing
        // check was blind to it. `f64::min`/`f64::max` RETURN THE OTHER OPERAND
        // when one side is NaN, so a NaN move never widened the box: the box
        // stayed finite and inside the machine, and every travel, spoilboard and
        // extent check built on it therefore vouched for a program containing a
        // move that has no coordinate.
        //
        // The property is stated as an implication rather than as an expected
        // value, because it is the one that has to hold for EVERY future bounds
        // consumer: if the box says "finite", every positioning move is finite.
        // ⚠ The box is deliberately still the envelope of the FINITE moves — see
        // the doc block on `recompute_bounds` for why neither NaN nor infinity
        // was put in it. What must never happen again is that being the WHOLE
        // answer: the box and the record are read together, and this pins the
        // pairing so a later refactor cannot drop one half.
        let mut p = path_with_one_nan_move();
        p.recompute_bounds();
        assert_eq!((p.min_x, p.max_x), (10.0, 90.0), "the finite envelope is wrong");
        assert!(
            !p.nonfinite_moves.is_empty(),
            "the box reads {}..{} as if that were the whole program, and nothing records the \
             move it could not measure",
            p.min_x,
            p.max_x
        );
    }

    // -----------------------------------------------------------------------
    // PLANTED 2026-08-10 for audit finding B3 — an arc bulges outside its own
    // endpoints, and the box was folded from endpoints only.
    // -----------------------------------------------------------------------

    #[test]
    fn an_arc_bulges_outside_its_endpoints_and_the_box_must_contain_the_bulge() {
        // A 180° arc from (270,890) to (330,890) about (300,890), clockwise:
        // the tool goes OVER THE TOP, to Y 920. Both endpoints read Y 890.
        let mut p = Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(270.0, 890.0, 5.0)),
                Move::arc(true, Vec3::new(330.0, 890.0, -5.0), Vec2::new(300.0, 890.0), 1000.0),
            ],
            ..Default::default()
        };
        p.recompute_bounds();
        assert!(
            (p.max_y - 920.0).abs() < 1e-9,
            "the box tops out at Y{} while the tool reaches Y920 — the miss is the FULL RADIUS, \
             and every travel, spoilboard, workpiece-edge and datum check is built on this number",
            p.max_y
        );
    }

    #[test]
    fn an_arc_that_crosses_no_axis_tangent_is_bounded_by_its_endpoints_exactly() {
        // ⚠ THE TIGHT DIRECTION, which matters as much: a bound that always
        // grows to the full circle would pass the test above and start refusing
        // good programs. This arc (10° → 80° CCW) reaches its extremes AT its
        // endpoints, so the correct box IS the endpoint box, to the last bit.
        let c = Vec2::new(100.0, 100.0);
        let r = 30.0;
        let (a0, a1) = (10f64.to_radians(), 80f64.to_radians());
        let s = Vec3::new(c.x + r * a0.cos(), c.y + r * a0.sin(), -5.0);
        let e = Vec3::new(c.x + r * a1.cos(), c.y + r * a1.sin(), -5.0);
        let mut p = Toolpath {
            moves: vec![Move::rapid(Vec3::new(s.x, s.y, 5.0)), Move::arc(false, e, c, 1000.0)],
            ..Default::default()
        };
        p.recompute_bounds();
        assert!((p.min_x - e.x).abs() < 1e-9, "min_x {} widened past the endpoints", p.min_x);
        assert!((p.max_x - s.x).abs() < 1e-9, "max_x {} widened past the endpoints", p.max_x);
        assert!((p.min_y - s.y).abs() < 1e-9, "min_y {} widened past the endpoints", p.min_y);
        assert!((p.max_y - e.y).abs() < 1e-9, "max_y {} widened past the endpoints", p.max_y);
    }

    #[test]
    fn the_bound_does_not_depend_on_how_finely_the_arc_was_emitted() {
        // 🔴 THE POINT OF THE WHOLE FIX. The same physical half circle, emitted as
        // one arc and as sixteen sub-arcs, must produce the SAME box. Today the
        // sixteen-piece version is nearly right by accident (the tab/ramp
        // Z-stepping loop happens to subdivide) and the one-piece version misses
        // by 30mm — a safety bound resting on an unrelated emission density.
        let c = Vec2::new(300.0, 890.0);
        let r = 30.0;
        let at = |a: f64, z: f64| Vec3::new(c.x + r * a.cos(), c.y + r * a.sin(), z);

        let mut one = Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(c.x - r, c.y, 5.0)),
                Move::arc(true, at(0.0, -5.0), c, 1000.0),
            ],
            ..Default::default()
        };
        one.recompute_bounds();

        let mut many = Toolpath {
            moves: vec![Move::rapid(Vec3::new(c.x - r, c.y, 5.0))],
            ..Default::default()
        };
        for i in 1..=16 {
            let a = std::f64::consts::PI * (1.0 - i as f64 / 16.0);
            many.moves.push(Move::arc(true, at(a, -5.0), c, 1000.0));
        }
        many.recompute_bounds();

        assert!(
            (one.max_y - many.max_y).abs() < 1e-9,
            "one arc bounds to Y{} and the same curve in sixteen pieces bounds to Y{} — the \
             safety bound is being set by how finely something upstream happened to emit",
            one.max_y,
            many.max_y
        );
    }

    #[test]
    fn the_direction_of_travel_decides_which_way_the_arc_bulges() {
        // Same two endpoints, same centre, opposite `cw`: one goes over the top
        // and the other under the bottom. A bound that ignored the direction
        // would return the UNION — safe, and wrong by 30mm on every semicircle,
        // which is a false red on half the bores this tool plans.
        let c = Vec2::new(300.0, 890.0);
        let ends = (Vec3::new(270.0, 890.0, 5.0), Vec3::new(330.0, 890.0, -5.0));
        let boxed = |cw: bool| {
            let mut p = Toolpath {
                moves: vec![Move::rapid(ends.0), Move::arc(cw, ends.1, c, 1000.0)],
                ..Default::default()
            };
            p.recompute_bounds();
            (p.min_y, p.max_y)
        };
        assert_eq!(boxed(true), (890.0, 920.0), "clockwise goes over the top");
        assert_eq!(boxed(false), (860.0, 890.0), "counter-clockwise goes under the bottom");
    }

    #[test]
    fn a_full_circle_arc_is_bounded_as_a_circle_and_not_as_a_point() {
        // Centre-format G2/G3 whose endpoint equals its start is a FULL CIRCLE —
        // the documented semantic, and what a grbl-family controller runs. Bound
        // as a zero-length sliver it is a 2r hole in the travel check.
        let c = Vec2::new(100.0, 100.0);
        let mut p = Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(120.0, 100.0, 5.0)),
                Move::arc(false, Vec3::new(120.0, 100.0, -5.0), c, 1000.0),
            ],
            ..Default::default()
        };
        p.recompute_bounds();
        assert_eq!(
            (p.min_x, p.max_x, p.min_y, p.max_y),
            (80.0, 120.0, 80.0, 120.0),
            "a full circle of r20 was bounded as {:?}",
            (p.min_x, p.max_x, p.min_y, p.max_y)
        );
    }

    #[test]
    fn an_arc_whose_start_is_unknown_is_bounded_by_the_whole_circle() {
        // An arc as the first positioning move has no start point in the path,
        // so which way round it goes is unknowable here. The post refuses this
        // ("arc emitted before any positioning move"); the BOX must not answer
        // narrower than the question in the meantime.
        let mut p = Toolpath {
            moves: vec![Move::arc(
                true,
                Vec3::new(120.0, 100.0, -5.0),
                Vec2::new(100.0, 100.0),
                1000.0,
            )],
            ..Default::default()
        };
        p.recompute_bounds();
        assert_eq!(
            (p.min_x, p.max_x, p.min_y, p.max_y),
            (80.0, 120.0, 80.0, 120.0),
            "an arc with no known start was bounded by its endpoint alone"
        );
    }

    #[test]
    fn an_arc_with_a_non_finite_centre_is_recorded_rather_than_bounded_by_its_endpoint() {
        // Same class as the NaN destination above, one field across: the
        // destination is a perfectly good number and the SWEPT PATH is unknown.
        // A box folded from the endpoint alone would look measured.
        let mut p = Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(10.0, 10.0, 5.0)),
                Move::arc(true, Vec3::new(20.0, 10.0, -5.0), Vec2::new(f64::NAN, 10.0), 1000.0),
            ],
            ..Default::default()
        };
        p.recompute_bounds();
        assert_eq!(
            p.nonfinite_moves,
            vec![1],
            "an arc whose centre is not a number was folded into the box as if its path were known"
        );
        let (i, _) = p.first_nonfinite_move().expect("the fresh scan missed the arc centre");
        assert_eq!(i, 1);
    }

    #[test]
    fn a_clean_path_still_gets_its_real_envelope() {
        // Negative control for the test above: without a NaN the box must be the
        // measured envelope, not the widened one. A fix that simply set every
        // bound to infinity would pass the first test and make every travel
        // check useless — this is what stops that.
        let mut p = path_with_one_nan_move();
        p.moves[2] = Move::feed_to(Vec3::new(50.0, 30.0, -3.0), 1200.0);
        p.recompute_bounds();
        assert_eq!((p.min_x, p.max_x), (10.0, 90.0), "x envelope {} .. {}", p.min_x, p.max_x);
        assert_eq!((p.min_y, p.max_y), (10.0, 60.0), "y envelope {} .. {}", p.min_y, p.max_y);
        assert_eq!((p.min_z, p.max_z), (-3.0, 5.0), "z envelope {} .. {}", p.min_z, p.max_z);
    }
}
