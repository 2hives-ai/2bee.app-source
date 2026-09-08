//! Predefined spoilboards — **boards that exist**, each with the page its
//! numbers were read off and the date they were read.
//!
//! # Why this file has so few entries
//!
//! Because a catalogue entry is a claim about a physical object. This lane has
//! been here before: `web/src/App.tsx` once shipped three workholding presets —
//! pressure bar, cam clamps, screws — that were **invented in this lane**, with
//! plausible numbers and no provenance, and `docs/workholding-research.md`
//! exists because *"a preset with a 35 mm height and no source is a claim about
//! a real object that nobody made: it looks like knowledge and behaves like a
//! guess"*. The sourcing rules from that document apply here without exception:
//!
//! * no dimension is written from memory;
//! * no entry appears unless its numbers were read on the source it cites;
//! * where a size could not be confirmed at a supplier page it is **listed as
//!   refused, with the reason**, and not quietly filled in.
//!
//! # 🔴 THIS FILE OFFERS. IT DOES NOT DEFAULT.
//!
//! There is **no `DEFAULT`, no "recommended", no first-entry-wins**, and
//! [`catalogue_default_id`] exists only to return `None` and say why in one
//! place a test can assert on. The sheet basis is **contested in this repo** —
//! `cnc_nest/README.md` says 2700x1200, `ops` says 600x900, `bom`'s 2026-07-18
//! correction says 2400x1200 — and this lane's standing rule is that the UI
//! offers all three and defaults to none, because picking one here would
//! silently settle an open question that is not this lane's to settle
//! (`AGENTS.md`, *Lane boundaries*). The same reasoning binds the spoilboard:
//! **the operator picks the board they own.**
//!
//! ⚠ **THE WORD "SHEET" SURVIVES IN THIS FILE ON PURPOSE, AND ONLY HERE.**
//! `docs/terminology.md` retires it everywhere else — the material being cut is
//! the **workpiece** and the board bolted to the machine is the **spoilboard**.
//! What is left below is neither: **`sheet goods`**, **`full-sheet size`** and
//! the catalogue labels (*"MDF sheet 2400 x 1200 x 16mm"*) name a **purchasable
//! panel at a supplier**, quoted from the page they were read on, and this
//! file's whole discipline is that no label drifts from its source; **`sheet
//! basis`** is a **cross-lane term for bom + ops' open question**, used under
//! that name in `AGENTS.md`. A sweep that renames either makes the catalogue
//! wrong about the world, or cuts the link to the lane that has to answer.
//! Exceptions X1 and X2 in `docs/terminology.md`.
//!
//! And the safety argument points the same way. An over-declared spoilboard —
//! one asserted larger, or nearer the datum, than the real board — says *"there
//! is sacrificial material here"* about bare frame, so a cut that reaches an
//! extrusion reports as an intended through-cut. **Under-declaring costs a
//! false red; over-declaring reaches the machine.** A default is an
//! over-declaration waiting for the one user whose board is smaller.
//!
//! # What an entry is, and what it is NOT
//!
//! An entry is **a board you can buy or a board we have measured** — a size and
//! a thickness. It is **not a placement**: [`SpoilboardSpec::install_at`]
//! requires the corner, because where the board is bolted is a fact about *that
//! machine* and no catalogue can know it. That split is the same one
//! `docs/decision-40-43-touchplate-ownership.md` settled for touch plates: the
//! purchased object's dimensions belong to the product, its position belongs to
//! the setup.
//!
//! ✅ **CORRECTED 2026-08-11 — kept visible, because a stale caveat reads as an
//! open gap and keeps a finished job open.** This paragraph used to say
//! *"`thickness_mm` is DESCRIPTIVE and is consumed by no check today … it is
//! therefore deliberately absent from [`crate::types::Spoilboard`] rather than
//! carried there unused"*. **That was true when it was written and is false
//! now.** [`crate::types::Spoilboard`] carries `thickness_mm: Option<f64>`,
//! [`SpoilboardSpec::install_at`] hands this catalogue's figure over with the
//! board, and [`crate::sim::SpoilboardDepth`] reads it to answer *"did the
//! cutter go through the board into the machine?"* — the one question the old
//! model could not express at all.
//!
//! 🔴 **The rule the field now answers to is the same one this file already
//! had, and it is stricter than before, not looser: an ABSENT thickness means
//! UNKNOWN and the depth check reports PENDING.** It does not mean "thick
//! enough". So an entry carries a thickness **only where the source it cites
//! states one**; where a page could not be read, the entry carries `None` and
//! says so in its `note`, exactly as a refused SIZE is listed in
//! [`NOT_SHIPPED`] rather than quietly filled in. **An invented thickness is
//! worse than an absent one, because absent reads as unknown and invented reads
//! as measured** — and this number now decides whether a cut is called
//! sacrificial or called a strike on the frame.

use crate::types::Spoilboard;

/// A board that exists, with the page its numbers came from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpoilboardSpec {
    /// Stable id. Hosts key on this; it never changes for an entry.
    pub id: &'static str,
    /// What a person sees in the picker.
    pub label: &'static str,
    pub size_x_mm: f64,
    pub size_y_mm: f64,
    /// Nominal thickness of the board as sold or as modelled — **`None` where
    /// the cited source does not state one.**
    ///
    /// 🔴 **THE OPTION IS THE POINT.** A required `f64` here would force the
    /// next entry whose page gives no thickness to have one invented for it,
    /// and this field now reaches [`crate::sim::SpoilboardDepth`], where an
    /// invented number decides whether a cut is reported as sacrificial or as a
    /// cutter in the frame. Absent is a legitimate, sayable answer and it
    /// travels all the way to the operator as **UNKNOWN**; a plausible guess
    /// does not, because nothing downstream can tell it from a measurement.
    ///
    /// ⚠ **Nominal, even when present.** `docs/materials-research.md` records
    /// that sheet goods are routinely under their nominal thickness and that
    /// MDF's claimed ±0.2mm tolerance is **GENERIC and unverified** — *"MDF is
    /// true to nominal is plausible and unverified — do not encode it"*. And a
    /// spoilboard is **dressed in service**, so the board on the machine is
    /// thinner than the board that was bought, by an amount nothing here
    /// tracks. Every one of those errors is in the direction that puts the
    /// underside nearer the cutter than modelled.
    pub thickness_mm: Option<f64>,
    pub material: &'static str,
    /// Where the numbers were read. A URL, or a path inside this repo.
    pub source: &'static str,
    /// When that source was read, ISO date. A sourced number with no date is a
    /// number nobody can re-check.
    pub read_on: &'static str,
    /// What this entry does **not** tell you. Never empty — every board has a
    /// limit worth stating, and a blank here would read as "nothing to know".
    pub note: &'static str,
}

impl SpoilboardSpec {
    /// This board, bolted with its lower-left corner at `(x_mm, y_mm)` in
    /// machine coordinates.
    ///
    /// 🔴 The corner is REQUIRED and has no default. `0,0` is a plausible
    /// position and a plausible position is the dangerous kind: it moves the
    /// declared board toward the datum, which turns bare rail into declared
    /// spoilboard and makes a strike on the frame read as a sacrificial pass.
    /// The operator measures it with a tape, exactly as they do the workpiece datum.
    ///
    /// ⚠ **The THICKNESS travels with the board and the POSITION does not**, and
    /// the asymmetry is the same one the module header states: thickness is a
    /// property of the purchased object, position is a property of this setup.
    /// An entry with no sourced thickness installs as `None` — **UNKNOWN**, and
    /// the depth check then reports PENDING rather than passing. It is never
    /// backfilled from a sibling entry: two 1200x600 MDF panels of different
    /// thicknesses are the same rectangle and a different hazard.
    pub fn install_at(&self, x_mm: f64, y_mm: f64) -> Spoilboard {
        let mut b = Spoilboard::new(self.label, x_mm, y_mm, self.size_x_mm, self.size_y_mm);
        b.thickness_mm = self.thickness_mm;
        b
    }
}

/// Every board this lane can name a source for.
///
/// Order is stable and is **not** a ranking. A host that takes `[0]` as a
/// default is doing the thing the module header refuses; [`catalogue_default_id`]
/// is the answer to "which one is default", and it is `None`.
pub fn catalogue() -> &'static [SpoilboardSpec] {
    &[
        // ── The board on the machine we actually own ────────────────────────
        SpoilboardSpec {
            id: "2bee-cnc-table-mdf-18",
            label: "2bee CNC table — 18mm MDF",
            // 🔴 THE SMALLER OF TWO IN-REPO NUMBERS, AND THE CHOICE IS THE
            // SAFETY ARGUMENT, NOT A PREFERENCE. Our own repo disagrees with
            // itself about this board's Y:
            //
            //   hardware/cad/2bee_cnc_table/cnc_table.scad   1080 x 1560
            //     (table_w 1100 - 2*mdf_inset 10 = 1080;
            //      table_l 1580 - 2*mdf_inset 10 = 1560; mdf_t = 18)
            //   hardware/cad/2bee_cnc_table/bom_cnc_table.md 1080 x 1580
            //     ("MDF spoilboard 18mm — cut 1080 x 1580")
            //
            // 20mm apart, on the board a cutter is allowed to end up in. The
            // model's figure is taken because an OVER-declared spoilboard is the
            // direction that reaches the frame: if the real board is 1580 we
            // report a false red on the last 20mm, and if it is 1560 the BOM
            // figure would have called 20mm of aluminium "spoilboard".
            //
            // ⚠ This is a WORKAROUND FOR A DISAGREEMENT, NOT A RESOLUTION. The
            // board belongs to `cad` (the model) and `bom` (the cut list);
            // neither has been asked, and this lane may not settle it. Reported
            // out; when one of them rules, this entry changes and this comment
            // goes with it.
            size_x_mm: 1080.0,
            size_y_mm: 1560.0,
            // 🔴 18mm is DOCUMENTARY, from the model — it has never been put to a
            // tape, because THERE IS NO TABLE TO MEASURE. `cad` ruled on
            // 2026-08-11 (handover
            // `2026-08-11-cad-spoilboard-is-1080x1560-the-cut-list-is-wrong-and-there-is-no-table-to-measure.md`)
            // that 1080 x 1560 x 18 is right and labelled the ruling itself "a
            // documentary reconciliation, not a measurement … the table is not
            // built". That label is carried here rather than dropped: this is
            // now the number a depth check judges a cut against, and a
            // model-derived figure wearing the same clothes as a measured one is
            // the failure this file exists to prevent.
            thickness_mm: Some(18.0),
            material: "MDF",
            source: "hardware/cad/2bee_cnc_table/cnc_table.scad (module spoilboard(); \
                     table_w 1100, table_l 1580, mdf_inset 10, mdf_t 18); ruled by `cad` \
                     2026-08-11 as a DOCUMENTARY reconciliation — no physical table exists",
            read_on: "2026-08-11",
            note: "🔴 SIZE AND THICKNESS ARE BOTH FROM THE MODEL, NOT FROM AN OBJECT — `cad` ruled \
                   2026-08-11 that 1080x1560x18 is correct AND that the table is not built, so \
                   there is nothing to measure. The Y was contested (the model computes 1560, the \
                   cut list specifies 1580 in four places); the smaller is offered because an \
                   over-declared board reports frame as spoilboard, and that safety argument \
                   stands on its own even now that the ruling agrees with it. ⚠ The 18mm is what \
                   a through-cut check judges against: a spoilboard is dressed in service and \
                   gets thinner, nothing here tracks that, and every millimetre it has lost puts \
                   the machine nearer the cutter than this number says.",
        },
        // ── AU sheet goods you would cut a spoilboard from ──────────────────
        SpoilboardSpec {
            id: "mdf-1200x600-12",
            label: "MDF panel 1200 x 600 x 12mm (AU precut)",
            size_x_mm: 1200.0,
            size_y_mm: 600.0,
            thickness_mm: Some(12.0),
            material: "MDF",
            source: "https://www.bunnings.com.au/12mm-mdf-panel-standard-1200-x-600mm_p0590037",
            read_on: "2026-08-10",
            note: "A precut handy panel, offered because it is the only SMALL sheet this lane \
                   could confirm at a supplier page. 12mm is thin for a spoilboard that gets \
                   resurfaced — that is a shop decision, not a refusal.",
        },
        SpoilboardSpec {
            id: "mdf-2400x1200-16",
            label: "MDF sheet 2400 x 1200 x 16mm (AU standard)",
            size_x_mm: 2400.0,
            size_y_mm: 1200.0,
            thickness_mm: Some(16.0),
            material: "MDF",
            source: "https://www.bunnings.com.au/16mm-mdf-panel-standard-2400-x-1200mm_p0590059",
            read_on: "2026-08-10",
            note: "The dominant AU full-sheet size. ⚠ It does NOT settle this repo's contested \
                   sheet basis (2700x1200 / 600x900 / 2400x1200) — that is bom + ops' question. \
                   This is the size of a BOARD you can buy, not a ruling on the WORKPIECE we cut.",
        },
        SpoilboardSpec {
            id: "mdf-3600x1200-32",
            label: "MDF sheet 3600 x 1200 x 32mm (AU standard)",
            size_x_mm: 3600.0,
            size_y_mm: 1200.0,
            thickness_mm: Some(32.0),
            material: "MDF",
            source: "https://www.bunnings.com.au/3600-x-1200-x-32mm-mdf-standard-panel_p0590014",
            read_on: "2026-08-10",
            note: "Longer than any travel envelope this lane has seen; offered because a \
                   spoilboard is routinely bigger than the reachable area and being told the \
                   board overhangs is a useful, true answer.",
        },
    ]
}

/// **The default board. It is `None`, and this function exists so that fact has
/// somewhere to be asserted.**
///
/// See the module header: the sheet basis is contested, an over-declared board
/// reaches the machine, and no catalogue can know which board is bolted to your
/// rails. A host that wants a preselected entry is asking this lane to settle
/// another lane's question.
pub fn catalogue_default_id() -> Option<&'static str> {
    None
}

/// Look an entry up by id. `None` is a MISS and must be treated as one — never
/// substituted for a nearby board.
///
/// 🔴 The substitution failure is documented in this tree at full length:
/// `core/src/fixtures.rs` resolved an unknown tool id with
/// `.unwrap_or_else(|| end_mill(6.0))` and planned a complete 9,390-byte program
/// on a cutter nobody asked for, exit 0, nothing in `notes`. A spoilboard is the
/// same shape of fact — a silently substituted board is a rectangle in the wrong
/// place, and the whole point of the rectangle is that it says where the frame
/// starts.
pub fn by_id(id: &str) -> Option<&'static SpoilboardSpec> {
    catalogue().iter().find(|s| s.id == id)
}

/// The catalogue as JSON, for a host that has to draw a picker.
///
/// 🔴 Built in the CORE, like the tool library, so the browser and the CLI offer
/// the same boards with the same sources. A catalogue re-typed in TypeScript is
/// a second list that can drift, and the drift would be invisible: both sides
/// would render confidently and only the machine would disagree.
pub fn catalogue_json() -> String {
    let items: Vec<serde_json::Value> = catalogue()
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "label": s.label,
                "size_x_mm": s.size_x_mm,
                "size_y_mm": s.size_y_mm,
                "thickness_mm": s.thickness_mm,
                "material": s.material,
                "source": s.source,
                "read_on": s.read_on,
                "note": s.note,
            })
        })
        .collect();
    serde_json::json!({
        "spoilboards": items,
        // Named in the payload rather than left to the host to infer. A missing
        // key reads as "the host may choose"; an explicit null reads as "nobody
        // chose, and that is the answer".
        "default_id": catalogue_default_id(),
        "position_required": true,
        "why_no_default":
            "The board bolted to YOUR machine is not knowable from a catalogue, and an \
             over-declared spoilboard reports the machine's own frame as sacrificial \
             material. Pick the board you own and measure where its corner sits.",
        // 🔴 Said in the payload, not left to the host to work out from a null.
        // A picker that renders a missing thickness as a blank makes it look
        // like zero or like nothing-to-know; it is neither, and the difference
        // is whether the through-the-board check runs at all.
        "why_thickness_may_be_null":
            "A null thickness means the source cited for that board does not state one. It means \
             UNKNOWN — it does NOT mean thick enough. Nothing may be substituted for it: the \
             depth check ('did the cutter go through the board into the machine?') reports \
             PENDING for that board, and a picture of it must be visibly different from a board \
             whose thickness is known, or the picture asserts a measurement nobody made.",
    })
    .to_string()
}

/// Sizes that were LOOKED FOR AND NOT SHIPPED, with the reason.
///
/// 🔴 This is not documentation trivia — it is the difference between *"we did
/// not think of it"* and *"we looked and could not source it"*, and only the
/// second is ours. A catalogue whose absences are unexplained invites the next
/// reader to fill them in from memory, which is the exact failure
/// `docs/workholding-research.md` was written to stop.
///
/// | size | why it is not an entry |
/// |---|---|
/// | **2700 x 1200 MDF** | `docs/materials-research.md` grades the MDF form of this size **GENERIC** — *"not independently confirmed at a supplier page"*. The 2700 length is genuinely sourced for **plywood** (Ecoply spec guide) and that is a different product. |
/// | **600 x 900 / 1200 x 900 "handy panel"** | **GENERIC as stated.** The AU precut range clusters on **1200 x 896/897** and **897/896 x 600**, *not* on a round 900. Our own research says in terms: *"Do not hard-code 1200 x 900 or 600 x 900 as literal stocked SKUs."* Shipping a round 900 would put a 3–4mm lie on the edge of the board — which is the edge the whole check turns on. |
/// | **18mm 2400 x 1200 MDF** | A Bunnings SKU for it is indexed, but the product page would not render for the fetcher on 2026-08-10, so **no dimension was read off a page**. It is very probably real; "very probably" is not this file's standard. |
/// | **Shapeoko / Onefinity / X-Carve wasteboards** | The figures that surfaced (31"x31", 32"x32") came from **community forum posts and Etsy listings**, not from a manufacturer page. A vendor's own published wasteboard size would be a legitimate entry; a third-party retelling of it is not. |
pub const NOT_SHIPPED: &str = "see the doc comment on this constant";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_in_this_catalogue_is_a_default() {
        // 🔴 The load-bearing test in this file. The sheet basis is contested,
        // and a default here would settle it silently for every user who never
        // opens the picker.
        assert_eq!(catalogue_default_id(), None);
        let json = catalogue_json();
        assert!(
            json.contains("\"default_id\":null"),
            "the payload must say NOBODY CHOSE, explicitly — a missing key reads as \
             'the host may choose': {json}"
        );
    }

    #[test]
    fn every_entry_carries_a_source_and_the_date_it_was_read() {
        // A number without provenance is a guess wearing a catalogue's clothes.
        for s in catalogue() {
            assert!(!s.source.trim().is_empty(), "{} has no source", s.id);
            assert!(!s.read_on.trim().is_empty(), "{} has no read date", s.id);
            // ISO-ish: this is a shape check, not a calendar.
            assert_eq!(s.read_on.len(), 10, "{} read_on is not an ISO date: {}", s.id, s.read_on);
            assert!(
                s.source.starts_with("https://") || s.source.starts_with("hardware/"),
                "{} cites something that is neither a URL nor a path in this repo: {}",
                s.id,
                s.source
            );
            assert!(!s.note.trim().is_empty(), "{} states no limit on itself", s.id);
        }
    }

    #[test]
    fn every_entry_is_a_real_rectangle() {
        for s in catalogue() {
            assert!(s.size_x_mm > 0.0 && s.size_y_mm > 0.0, "{} has no area", s.id);
            // 🔴 A thickness may be ABSENT — that is a sayable answer and it
            // travels to the operator as UNKNOWN. What it may not be is
            // PRESENT AND NONSENSE: zero, negative or non-finite. Absent
            // reports PENDING; a bad number would be judged against.
            if let Some(t) = s.thickness_mm {
                assert!(
                    t.is_finite() && t > 0.0,
                    "{} declares a thickness of {t}, which is not a slab — leave it None and be \
                     told UNKNOWN instead",
                    s.id
                );
            }
            // The declaration a host would install must itself be fault-free,
            // or the picker offers a board that makes every through-cut a false
            // strike on the frame.
            assert!(s.install_at(0.0, 0.0).faults().is_empty(), "{} installs faulted", s.id);
        }
    }

    #[test]
    fn ids_are_unique_because_hosts_key_on_them() {
        let mut ids: Vec<&str> = catalogue().iter().map(|s| s.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate spoilboard id");
    }

    #[test]
    fn an_unknown_id_is_a_miss_and_never_a_substitution() {
        // 🔴 The tool-substitution lesson, applied before it can happen here: a
        // silently substituted board is a rectangle in the wrong place, and the
        // rectangle is the whole check.
        assert!(by_id("no-such-board").is_none());
        assert!(by_id("").is_none());
        assert!(by_id("2bee-cnc-table-mdf-18").is_some());
    }

    #[test]
    fn installing_a_board_takes_the_size_from_the_catalogue_and_the_position_from_the_caller() {
        let s = by_id("mdf-1200x600-12").expect("entry");
        let b = s.install_at(35.0, 60.0);
        assert_eq!((b.x_mm, b.y_mm), (35.0, 60.0));
        assert_eq!((b.size_x_mm, b.size_y_mm), (1200.0, 600.0));
        // The catalogue supplies no position of its own — installing the same
        // board somewhere else moves it and nothing else.
        let elsewhere = s.install_at(0.0, 0.0);
        assert_eq!((elsewhere.size_x_mm, elsewhere.size_y_mm), (1200.0, 600.0));
        assert_ne!(b.x_mm, elsewhere.x_mm);
    }

    #[test]
    fn the_thickness_travels_with_the_board_and_is_never_invented() {
        // The sourced number reaches the installed board, so a catalogue pick
        // is enough to make the through-the-board check RUN. Before this, the
        // figure sat in the catalogue and the type had nowhere to put it.
        let s = by_id("2bee-cnc-table-mdf-18").expect("entry");
        let b = s.install_at(40.0, 25.0);
        assert_eq!(b.thickness_mm, Some(18.0));
        assert_eq!(b.usable_thickness_mm(), Some(18.0));
        // The stack, stated by construction rather than assumed: the workpiece
        // rests on the board, so the board's top is the workpiece's underside and
        // its underside is one thickness below that.
        assert_eq!(b.top_face_z_mm(18.0), -18.0);
        assert_eq!(b.underside_z_mm(18.0), Some(-36.0));

        // 🔴 And the negative control on the invention path: a board declared
        // WITHOUT the catalogue gets no thickness from anywhere. There is no
        // nearest-entry lookup, no material default, no "most boards are 18".
        let hand = Spoilboard::new("hand-declared", 0.0, 0.0, 1200.0, 600.0);
        assert_eq!(hand.thickness_mm, None, "a thickness was supplied by something");
        assert_eq!(hand.underside_z_mm(18.0), None, "an underside was invented with no thickness");
    }

    #[test]
    fn an_absent_thickness_is_expressible_and_reaches_the_host_as_null() {
        // The type the catalogue offers must be able to SAY "the page did not
        // state one". A required f64 would force the next such entry to have a
        // thickness invented for it — and this number now decides whether a cut
        // is called sacrificial or called a strike on the frame.
        let unsourced = SpoilboardSpec {
            id: "test-only-no-thickness",
            label: "a board whose page gave no thickness",
            size_x_mm: 1200.0,
            size_y_mm: 600.0,
            thickness_mm: None,
            material: "MDF",
            source: "https://example.invalid/",
            read_on: "2026-08-11",
            note: "constructed in this test only",
        };
        let b = unsourced.install_at(0.0, 0.0);
        assert_eq!(b.thickness_mm, None);
        assert_eq!(b.underside_z_mm(18.0), None, "absence was filled in on the way through");

        // The payload has to carry the distinction and explain it, or a picker
        // renders a blank that reads as zero or as nothing-to-know.
        let json = catalogue_json();
        assert!(
            json.contains("why_thickness_may_be_null"),
            "the payload does not tell the host what a null thickness means: {json}"
        );
        assert!(
            json.contains("It means UNKNOWN") && json.contains("does NOT mean thick enough"),
            "the payload must refuse the 'thick enough' reading in terms, not just omit a \
             number: {json}"
        );
        // The four shipped entries all have a sourced thickness today, so the
        // JSON carries numbers. The control is that the SERIALISER can express
        // the absent case at all — a host that never sees a null cannot be
        // blamed for rendering one wrong.
        let payload = serde_json::to_string(&serde_json::json!({
            "thickness_mm": unsourced.thickness_mm
        }))
        .expect("serialise");
        assert!(payload.contains("null"), "an absent thickness did not serialise as null");
    }

    #[test]
    fn the_contested_sizes_are_absent_by_name() {
        // A negative control on the sourcing rule itself. If someone later adds
        // a round 900 or an unsourced 2700 MDF, this goes red and the reason is
        // in `NOT_SHIPPED`.
        for s in catalogue() {
            let dims = (s.size_x_mm, s.size_y_mm);
            assert_ne!(dims, (600.0, 900.0), "{} ships the unsourced handy-panel size", s.id);
            assert_ne!(dims, (900.0, 600.0), "{} ships the unsourced handy-panel size", s.id);
            assert_ne!(dims, (1200.0, 900.0), "{} ships the unsourced handy-panel size", s.id);
            assert!(
                !(s.material == "MDF" && (dims == (2700.0, 1200.0) || dims == (1200.0, 2700.0))),
                "{} ships 2700x1200 MDF, which our own research grades GENERIC",
                s.id
            );
        }
    }

    #[test]
    fn the_catalogue_json_carries_the_provenance_to_the_host() {
        // The picker must be able to show WHERE a number came from. A UI that
        // can only show a size is a UI that cannot tell a measured board from an
        // invented one.
        let json = catalogue_json();
        for s in catalogue() {
            assert!(json.contains(s.id), "{} missing from the payload", s.id);
            assert!(json.contains(s.read_on), "{} read date missing from the payload", s.id);
        }
        assert!(json.contains("position_required"));
    }
}
