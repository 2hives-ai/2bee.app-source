//! Feeds and speeds — one formula, one place.
//!
//! ```text
//! feed [mm/min] = rpm * flutes * chipload [mm/tooth]
//! ```
//!
//! # 🔴 A CLAMP IS NOT A SAFETY CONTROL. IT MOVES THE DANGER.
//!
//! This module's header used to say the formula is *"deliberately NOT clamped to
//! the machine here: clamping is the caller's decision, and silently reducing a
//! feed hides a bad tool/rpm pairing instead of reporting it"*. The first half
//! was right for the wrong reason and the second half was right for the right
//! one, and the measurement that settled it is worth keeping:
//!
//! ```text
//! ⌀12 2F end mill, plywood, DEFAULT machine (max_feed_mm_min = 6000):
//!   uncapped   24,000 rpm x 2 x 0.30mm      = 14,400 mm/min
//!   clamped                                 =  6,000 mm/min   <- what shipped
//!   delivered chip  6000 / (24,000 x 2)     =  0.125 mm/tooth
//!   that tool's own declared minimum        =  0.150 mm/tooth
//! ```
//!
//! **The clamp put the program below the cutter's own rated chip and said
//! nothing.** A thin chip does not cut, it rubs: heat, a burnt glue line, a
//! packed flute, a dulled cutter. So the safety control was the thing that
//! created the unsafe program.
//!
//! The arithmetic is the whole argument. `feed = rpm x flutes x chip`, so
//! holding `feed` at the ceiling while `rpm` stays put can only come out of
//! `chip`. **To obey a feed ceiling and keep the chip, the rpm has to come
//! down** — the throughput falls and the cut does not change. For the case
//! above that is `6000 / (2 x 0.30)` = **10,000 rpm**, inside the tool's window
//! (min 8,000) and the machine's (min 6,000). And when the required rpm is below
//! the spindle's floor there is no speed that is both runnable and in-window, so
//! the honest answer is a refusal, not the nearest number.
//!
//! # What this module is, and is not
//!
//! It is **material-blind on purpose.** The caller passes the chip per tooth it
//! wants *after* the material factor, so there is one place that knows about
//! materials ([`crate::tools`]) and one that knows about arithmetic (here).
//!
//! It **decides nothing about a job.** It answers "what happens to this pairing
//! against this ceiling" and returns the answer as a value with its own
//! sentence. `recommend.rs` is what acts on it.
//!
//! ⚠ Every number this module reasons about — the tool's chipload window, the
//! machine's `max_feed_mm_min` — is **unsourced** (`docs/materials-research.md`
//! §3.2, §3.4). That is why the below-window case is a **note** and only the
//! no-runnable-speed case is a **refusal**: refusing on an invented window would
//! be a false red built on the same sand as the false green.

use crate::types::Tool;

pub fn feed_from_chipload(t: &Tool, rpm: f64) -> f64 {
    rpm * t.flutes as f64 * t.chipload_mm
}

pub fn chipload_from_feed(t: &Tool, rpm: f64, feed_mm_min: f64) -> f64 {
    let denom = rpm * t.flutes as f64;
    if denom > 0.0 {
        feed_mm_min / denom
    } else {
        0.0
    }
}

// ===========================================================================
//  Where the delivered chip actually landed
// ===========================================================================

/// Where the chip an emitted program *delivers* sits against the cutter's own
/// rated window.
///
/// 🔴 Three answers, not a boolean, because **the two ways out of the window
/// are different physical failures** and an operator who is told only "out of
/// window" cannot act. Above it, the cutter is overloaded and can snap. Below
/// it, the cutter rubs instead of cutting and burns — which is the failure a
/// naive feed clamp *creates*, and the one nobody was looking for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChipVerdict {
    InWindow { chip_mm: f64 },
    /// Rubbing rather than cutting.
    Below { chip_mm: f64, min_mm: f64 },
    /// Overloaded.
    Above { chip_mm: f64, max_mm: f64 },
}

impl ChipVerdict {
    pub fn in_window(&self) -> bool {
        matches!(self, Self::InWindow { .. })
    }

    pub fn chip_mm(&self) -> f64 {
        match self {
            Self::InWindow { chip_mm } | Self::Below { chip_mm, .. } | Self::Above { chip_mm, .. } => {
                *chip_mm
            }
        }
    }

    /// The whole sentence, because this is what the operator reads. Empty for
    /// the in-window case — the same convention as [`crate::tools::ShankFit`],
    /// so a host cannot write `why || "fine"` and have a blank read as an
    /// answer.
    pub fn why(&self) -> String {
        match self {
            Self::InWindow { .. } => String::new(),
            Self::Below { chip_mm, min_mm } => format!(
                "the emitted feed delivers {chip_mm:.3}mm of chip per tooth, BELOW this cutter's \
                 own declared minimum of {min_mm:.3}mm. A chip that thin does not cut, it rubs: \
                 the heat goes into the cutter and the work instead of into the chip, which burns \
                 the edge, packs the flute and dulls the tool. Take the spindle DOWN (or the feed \
                 up) until the chip is back in the window — the two are one decision"
            ),
            Self::Above { chip_mm, max_mm } => format!(
                "the emitted feed delivers {chip_mm:.3}mm of chip per tooth, ABOVE this cutter's \
                 own declared maximum of {max_mm:.3}mm. That is more material per tooth than the \
                 flute was rated to take"
            ),
        }
    }
}

/// Where the chip an emitted `rpm`/`feed` pair actually delivers sits against
/// the tool's rated window.
///
/// 🔴 This takes the EMITTED numbers, never the intended ones. Asking it what
/// the plan meant to do would make it green about the plan — the defect this
/// lane has now shipped five times.
pub fn chip_verdict(t: &Tool, rpm: f64, feed_mm_min: f64) -> ChipVerdict {
    let chip_mm = chipload_from_feed(t, rpm, feed_mm_min);
    if chip_mm < t.chipload_min_mm {
        ChipVerdict::Below { chip_mm, min_mm: t.chipload_min_mm }
    } else if chip_mm > t.chipload_max_mm {
        ChipVerdict::Above { chip_mm, max_mm: t.chipload_max_mm }
    } else {
        ChipVerdict::InWindow { chip_mm }
    }
}

/// True when the derived chipload sits inside the tool's rated window.
///
/// ⚠ Kept as the boolean form because it is re-exported and because a caller
/// that only needs a yes/no should not have to match three variants — but it is
/// **derived from [`chip_verdict`]** rather than reimplementing the comparison.
/// Two copies of a machining rule is one rule that runs once.
pub fn chipload_in_window(t: &Tool, rpm: f64, feed_mm_min: f64) -> bool {
    chip_verdict(t, rpm, feed_mm_min).in_window()
}

// ===========================================================================
//  A feed ceiling, obeyed without thinning the chip
// ===========================================================================

/// What a machine's feed ceiling did to one tool/rpm pairing.
///
/// 🔴 **There is deliberately no variant carrying a reduced feed at an unchanged
/// rpm.** That shape — `feed.min(ceiling)` — is the defect measured in this
/// module's header, and the way to stop it coming back is to make it
/// inexpressible rather than to write a comment asking people not to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FeedResolution {
    /// The ceiling did not bind. Nothing was changed.
    Clear { rpm: f64, feed_mm_min: f64 },
    /// The ceiling bound, and the **spindle came down** so the chip per tooth is
    /// the one that was asked for. Throughput falls; the cut does not change.
    ///
    /// `chip_if_clamped_mm` is what the naive `feed.min(ceiling)` would have
    /// delivered instead. It is carried rather than recomputed in the message
    /// because a sentence that re-derives its own number from a flute count it
    /// assumed is a sentence that will be wrong on a 1- or 3-flute cutter.
    RpmReducedToHoldTheChip {
        rpm: f64,
        feed_mm_min: f64,
        rpm_before: f64,
        uncapped_feed_mm_min: f64,
        chip_if_clamped_mm: f64,
    },
    /// 🔴 There is no speed that both runs on this spindle and holds the chip:
    /// the rpm that would be needed is below the floor of the tool or of the
    /// spindle. **No number is returned** — the caller must refuse.
    NoSpeedHoldsTheChip {
        rpm_required: f64,
        rpm_floor: f64,
        ceiling_mm_min: f64,
        chip_mm: f64,
    },
}

impl FeedResolution {
    /// The pair to emit, or `None` when there is no runnable answer.
    pub fn rpm_feed(&self) -> Option<(f64, f64)> {
        match self {
            Self::Clear { rpm, feed_mm_min }
            | Self::RpmReducedToHoldTheChip { rpm, feed_mm_min, .. } => Some((*rpm, *feed_mm_min)),
            Self::NoSpeedHoldsTheChip { .. } => None,
        }
    }

    /// Empty when nothing was changed — a note that always speaks is a note
    /// nobody reads.
    pub fn why(&self) -> String {
        match self {
            Self::Clear { .. } => String::new(),
            Self::RpmReducedToHoldTheChip {
                rpm,
                feed_mm_min,
                rpm_before,
                uncapped_feed_mm_min,
                chip_if_clamped_mm,
            } => format!(
                "this pairing wants {uncapped_feed_mm_min:.0}mm/min and the machine's feed \
                 ceiling is {feed_mm_min:.0}mm/min, so the SPINDLE came down from \
                 {rpm_before:.0} to {rpm:.0}rpm rather than the chip. Clamping the feed alone \
                 would have thinned the chip to {chip_if_clamped_mm:.3}mm per tooth and said \
                 nothing; holding the chip costs throughput and nothing else"
            ),
            Self::NoSpeedHoldsTheChip { rpm_required, rpm_floor, ceiling_mm_min, chip_mm } => {
                format!(
                    "holding {chip_mm:.3}mm of chip per tooth under a {ceiling_mm_min:.0}mm/min \
                     feed ceiling needs {rpm_required:.0}rpm, and the slowest this tool can be \
                     turned on this spindle is {rpm_floor:.0}rpm. There is no speed that is both \
                     runnable and in this cutter's window, so this is refused rather than run \
                     under-chipped"
                )
            }
        }
    }
}

/// Obey a machine's feed ceiling **without thinning the chip**.
///
/// * `rpm` — the speed already capped by the tool, the spindle and the material.
/// * `chip_mm` — the chip per tooth being aimed for, material factor already
///   applied. This module never asks what the material is.
/// * `ceiling_mm_min` — `machine.max_feed_mm_min`.
/// * `rpm_floor` — `max(tool.rpm_min, machine.spindle_min_rpm)`; the slowest
///   this pairing can actually be turned.
///
/// A non-positive ceiling means **nobody declared one**, and that is not a
/// ceiling of zero — it is no ceiling, reported as [`FeedResolution::Clear`].
/// Treating an undeclared limit as `0` would refuse every job on a machine that
/// simply did not fill the field in, which is the `Absent ≠ safe` rule pointing
/// the other way for once: here, absent means unconstrained and the constraint
/// is the thing that was missing.
pub fn resolve_feed(
    t: &Tool,
    rpm: f64,
    chip_mm: f64,
    ceiling_mm_min: f64,
    rpm_floor: f64,
) -> FeedResolution {
    let flutes = t.flutes as f64;
    let wanted = rpm * flutes * chip_mm;
    if ceiling_mm_min <= 0.0 || wanted <= ceiling_mm_min {
        return FeedResolution::Clear { rpm, feed_mm_min: wanted };
    }
    // feed = rpm * flutes * chip, solved for the rpm that lands exactly on the
    // ceiling with the chip unchanged.
    let denom = flutes * chip_mm;
    if denom <= 0.0 {
        // A tool with no flutes or no chip cannot have a feed derived at all;
        // this is a tool-definition fault (`ToolFault::ZeroFlutes`) and is
        // reported by the validator, not invented around here.
        return FeedResolution::Clear { rpm, feed_mm_min: wanted };
    }
    let rpm_required = ceiling_mm_min / denom;
    if rpm_required < rpm_floor {
        return FeedResolution::NoSpeedHoldsTheChip {
            rpm_required,
            rpm_floor,
            ceiling_mm_min,
            chip_mm,
        };
    }
    FeedResolution::RpmReducedToHoldTheChip {
        rpm: rpm_required,
        feed_mm_min: ceiling_mm_min,
        rpm_before: rpm,
        uncapped_feed_mm_min: wanted,
        // What `feed.min(ceiling)` at the UNREDUCED rpm would have delivered —
        // the defect, computed so the note can name it.
        chip_if_clamped_mm: chipload_from_feed(t, rpm, ceiling_mm_min),
    }
}

// ===========================================================================
//  A feed the operator TYPED
// ===========================================================================

/// What to do with a feed the caller **pinned**, against the machine's ceiling.
///
/// 🔴 **There is no variant carrying a reduced number, and that is the whole
/// design.** An operator who typed a feed and got a quieter one has been
/// overruled without being told, and the program on the controller no longer
/// matches what they asked for. A pinned feed above the ceiling is a
/// contradiction between two declarations, and only the person who made both of
/// them can resolve it — so this refuses and names both numbers.
///
/// ⚠ This is the one rule in this module with **no production caller yet**, and
/// it is named here rather than left to be discovered. Pinned feeds are read in
/// `core/src/job.rs`'s material pass (`if op.params.feed_mm_min <= 0.0 { … }`),
/// which is outside this module's lane; the ask is recorded with the change that
/// added this function. It is written as a type with no reducing arm precisely
/// so that whoever wires it **cannot** wire it as a clamp by accident.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PinnedFeed {
    /// The typed feed is within the ceiling. Emit it unchanged.
    Runnable { feed_mm_min: f64 },
    /// 🔴 The typed feed exceeds the declared ceiling. **Refuse** — never reduce.
    AboveCeiling { pinned_mm_min: f64, ceiling_mm_min: f64 },
}

impl PinnedFeed {
    pub fn why(&self) -> String {
        match self {
            Self::Runnable { .. } => String::new(),
            Self::AboveCeiling { pinned_mm_min, ceiling_mm_min } => format!(
                "a feed of {pinned_mm_min:.0}mm/min was typed for this operation and this machine \
                 declares a ceiling of {ceiling_mm_min:.0}mm/min. Both are declarations and they \
                 contradict each other, so this is REFUSED rather than quietly run at \
                 {ceiling_mm_min:.0}: a program that is slower than the one asked for is a program \
                 the operator did not write. Change the feed or change the machine's ceiling"
            ),
        }
    }
}

/// A feed the caller typed, judged against the machine's ceiling. Never reduced.
///
/// A non-positive `pinned_mm_min` means **nothing was pinned** (this repo's
/// convention: `0.0` = derive) and a non-positive ceiling means none was
/// declared; both come back `Runnable` with the number as given.
pub fn pinned_feed(pinned_mm_min: f64, ceiling_mm_min: f64) -> PinnedFeed {
    if pinned_mm_min > 0.0 && ceiling_mm_min > 0.0 && pinned_mm_min > ceiling_mm_min {
        PinnedFeed::AboveCeiling { pinned_mm_min, ceiling_mm_min }
    } else {
        PinnedFeed::Runnable { feed_mm_min: pinned_mm_min }
    }
}

// ===========================================================================
//  THE PLUNGE — a cutting feed on the Z axis
// ===========================================================================

/// The built-in plunge feed, named so it can be pointed at rather than quoted.
///
/// 🔴 **UNSOURCED.** It is `OperationParams::default().plunge_mm_min`, it has no
/// citation anywhere in the corpus, and no output of this program has ever cut
/// anything. It is named here for one purpose: so that
/// [`PlungeFeed::AboveCeiling`]'s sentence can tell an operator *"you may be
/// looking at a number this repo invented, not one you typed"* — which is the
/// difference between a refusal they can act on and one that blames them for
/// our default.
///
/// ⚠ It is deliberately NOT used as a fallback anywhere. A constant that is
/// both the default and the thing the message cites is one value answering two
/// questions.
pub const BUILT_IN_PLUNGE_MM_MIN: f64 = 300.0;

/// A plunge feed judged against the machine's ceiling.
///
/// 🔴 **A PLUNGE IS CUTTING, so it is under the cutting ceiling** — and there
/// is deliberately no arm carrying a reduced number, for the same reason
/// [`PinnedFeed`] has none. `plunge.min(ceiling)` would be a quieter program
/// than the one asked for, emitted without saying so.
///
/// ⚠ **Why this is not just [`PinnedFeed`] under another name.** The refusal
/// has to say something `PinnedFeed` cannot: `plunge_mm_min` has **no
/// "derive one" sentinel**. `feed_mm_min` uses `0.0` to mean *derive*, so a
/// non-zero value there is unambiguously a declaration; `plunge_mm_min` ships
/// at [`BUILT_IN_PLUNGE_MM_MIN`] and a typed 300 is byte-identical to a
/// defaulted one. So the sentence must not claim to know which it is looking
/// at — it names both possibilities and the field to set. That is the honest
/// form of the objection *"refusing would misattribute an invented default as a
/// declaration"*: the misattribution is in the WORDS, not in the refusal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PlungeFeed {
    /// Inside the ceiling. Emit it unchanged.
    Runnable { plunge_mm_min: f64 },
    /// 🔴 The plunge exceeds the declared ceiling. **Refuse** — never reduce.
    AboveCeiling { plunge_mm_min: f64, ceiling_mm_min: f64 },
}

impl PlungeFeed {
    pub fn why(&self) -> String {
        match self {
            Self::Runnable { .. } => String::new(),
            Self::AboveCeiling { plunge_mm_min, ceiling_mm_min } => {
                let default_note = if (*plunge_mm_min - BUILT_IN_PLUNGE_MM_MIN).abs() < 1e-9 {
                    format!(
                        " ⚠ {BUILT_IN_PLUNGE_MM_MIN:.0}mm/min is ALSO this crate's built-in \
                         plunge default and it is unsourced, so if you did not type it, that is \
                         what you are looking at — a number nobody declared, refused against a \
                         ceiling you did."
                    )
                } else {
                    String::new()
                };
                format!(
                    "the plunge for this operation is {plunge_mm_min:.0}mm/min and this machine \
                     declares a feed ceiling of {ceiling_mm_min:.0}mm/min. A PLUNGE IS A CUTTING \
                     MOVE — the tool is being driven into solid stock on the one part of it that \
                     has no cutting edge — so it is under the cutting ceiling, and this is \
                     REFUSED rather than quietly run at {ceiling_mm_min:.0}: the controller would \
                     clamp it to its own $110-112 without saying so, and the program would then \
                     cut at a rate the plan never modelled.{default_note} Set `op.plunge_mm_min` \
                     at or below {ceiling_mm_min:.0}, or raise the machine's ceiling"
                )
            }
        }
    }
}

/// A plunge feed against the machine's ceiling. Never reduced.
///
/// A non-positive ceiling means none was declared — the same `absent means
/// unconstrained` reading as [`resolve_feed`]. A non-positive plunge is left to
/// the caller: it is a tool/parameter fault, not a ceiling question, and
/// inventing a verdict for it here would be this module answering something it
/// was not asked.
pub fn plunge_feed(plunge_mm_min: f64, ceiling_mm_min: f64) -> PlungeFeed {
    if plunge_mm_min > 0.0 && ceiling_mm_min > 0.0 && plunge_mm_min > ceiling_mm_min {
        PlungeFeed::AboveCeiling { plunge_mm_min, ceiling_mm_min }
    } else {
        PlungeFeed::Runnable { plunge_mm_min }
    }
}

// ===========================================================================
//  WHAT THE CEILING GOVERNS — the exemption, written down
// ===========================================================================

/// What an emitted `F` word is FOR, and therefore whether
/// `machine.max_feed_mm_min` governs it.
///
/// 🔴 **This type exists so that an exemption cannot be invisible.** Two feed
/// words used to escape the ceiling: a plunge and a probe seek. One was a
/// defect and one is a decision, and from the outside — an `F300.0` and an
/// `F200.0` sitting under a declared 250 — **they looked identical.** An
/// exemption nobody can see is indistinguishable from a leak, so the decision is
/// a variant with its reason attached rather than a number that happens to be
/// larger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedRole {
    /// The tool is in material. **Under the ceiling**, with no exceptions —
    /// lateral or axial, derived or typed.
    ///
    /// ⚠ A plunge is Cutting. It is the most loaded move an end mill makes: the
    /// centre of the tool has no cutting edge and is being driven into solid
    /// stock. "It is only Z" is not an exemption, it is a harder cut.
    Cutting,
    /// 🔴 **EXEMPT, BY DECISION, WITH A REASON.** A `G38.2` probing move.
    ///
    /// It is exempt because it is **not a cut and cannot be resolved like one**:
    ///
    /// 1. **The spindle is off.** `post_grblhal` emits `M5` before any probing
    ///    motion and says why — a probe with the spindle turning has its edge
    ///    sweeping the plate, so contact fires early at a radius that is not the
    ///    radius. With `rpm = 0` there is no chip per tooth, and
    ///    [`resolve_feed`]'s entire mechanism — hold the chip by taking the
    ///    spindle down — has nothing to trade.
    /// 2. **Nothing is being removed.** The ceiling exists so that a commanded
    ///    feed the machine cannot deliver does not silently become a different
    ///    *cut*. A probe has no cut to be wrong about.
    /// 3. **The clamp direction fails safe.** If grblHAL clamps a probe seek to
    ///    its own `$110–$112`, `G38.2` still stops on the probe input; the seek
    ///    simply takes longer. And the reading itself is taken on the SLOW pass
    ///    (`machine.probe_feed`, 25mm/min by default), not on the seek.
    ///
    /// ⚠ **This is still an exemption from the CUTTING ceiling and not a ceiling
    /// of its own** — but the residual it used to name is no longer open, and
    /// the sentence is corrected rather than deleted because a stale 🔴 lies
    /// exactly like a stale ✅.
    ///
    /// It read: *"`probe_seek_feed` and `probe_feed` are checked against nothing
    /// today — `post_grblhal::probe_travel_errors` validates the two probe
    /// DISTANCES and no feed — so a probe seek declared at 5,000mm/min emits and
    /// no control says a word."* True when written (2026-08-11), false since:
    /// [`probe_feed_faults`] now judges both feeds and `post_grblhal` refuses on
    /// them beside the distances. The 5,000 case was reproduced at the emitted
    /// program before and after — a control build emitted
    /// `G38.2 Z-30.000 F5000.0` at exit 0 with an empty stderr; the same
    /// machine now refuses with 0 bytes on all six job doors.
    ///
    /// 🔴 **AND THERE IS NO `--plant` FOR IT, WHICH IS A GAP AND NOT A
    /// DECISION.** A plant was written, driven and watched red, then reverted:
    /// registering one obliges `gates/slicer_gate_check.mjs` to carry a literal
    /// `'--plant', '<name>'` invocation (gate PLANT limb 2) and an entry with no
    /// consuming gate fails limb 1, so a half-registered plant turns a HARD gate
    /// red. `gates/` was outside the boundary of the change that added this, so
    /// the standing controls here are `cargo test` — **which this file's own
    /// plant contract says is not evidence that a control still bites.** A
    /// `--plant` plus a PROBE limb is the follow-up.
    ///
    /// 🔴 **What it is NOT, so the correction does not overstate coverage:**
    /// those checks are the two feeds against **each other** and against the
    /// machine's **own declared rapid rate**. There is still no bound on a probe
    /// seek against the touch plate's **overtravel**, which is the quantity that
    /// actually decides whether a probe stops on contact or drives through it —
    /// and [`probe_feed_faults`] carries the derivation of why no such number is
    /// invented here.
    Probing,
}

impl FeedRole {
    /// Empty for [`FeedRole::Cutting`] — the same convention as
    /// [`ChipVerdict::why`] and [`crate::tools::ShankFit::why`], so a host
    /// cannot print a blank and have it read as an answer that was given.
    pub fn why_exempt(self) -> String {
        match self {
            Self::Cutting => String::new(),
            Self::Probing => "a G38.2 probing move, which is NOT under the cutting feed ceiling: \
                              the spindle is off (M5 is emitted before every probe), nothing is \
                              being removed, and there is no chip per tooth for the ceiling to \
                              be traded against. If the controller clamps it to its own \
                              $110-112 the probe still stops on contact and merely takes \
                              longer, and the reading is taken on the slow pass \
                              (`machine.probe_feed`), not on this one. ⚠ This is an EXEMPTION \
                              from the cutting ceiling, not a ceiling of its own — the probe \
                              feeds have their OWN checks (feeds::probe_feed_faults: each \
                              against the other, and both against the machine's declared rapid \
                              rate), and nothing anywhere bounds a seek against the touch \
                              plate's overtravel"
                .into(),
        }
    }
}

/// Classify one line of emitted G-code by what its feed word is for.
///
/// 🔴 **It lives in the core and not in a host.** The rule *"a G38.2 is not a
/// cut"* is a machining fact, and a host that re-derived it would be the second
/// copy — the shape that put the travel-fit rule into TypeScript a second time
/// and wrong in a way no gate could see. The CLI's feed-limit report calls this;
/// so does anything else that reads back an emitted program.
///
/// Lines with no feed word classify as [`FeedRole::Cutting`]; the caller is
/// expected to have found an `F` before asking, and defaulting an unrecognised
/// line to *exempt* is the direction that hides a leak.
pub fn feed_role_of_line(line: &str) -> FeedRole {
    // Comments are stripped by the caller in the CLI, but a stray `( ... )` here
    // must not make a probing line look like a cut, so match on the bare word.
    let up = line.trim_start().to_ascii_uppercase();
    // G38.2 / G38.3 / G38.4 / G38.5 — every probing form grblHAL accepts.
    if up.starts_with("G38.") || up.contains(" G38.") {
        return FeedRole::Probing;
    }
    FeedRole::Cutting
}

/// One line of emitted G-code with its comments removed.
///
/// 🔴 `(` NESTS AND `;` ONLY COUNTS OUTSIDE IT. Both consumers of this crate's
/// feed readers used to strip comments themselves and they disagreed: the CLI
/// split on `;` BEFORE handling parens, so a `;` inside a `( … )` comment
/// truncated the line and the two readers gave different answers for the same
/// program. A comment does not span lines in G-code, so an unclosed `(`
/// swallows this line and no more.
pub fn strip_comments(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth = 0usize;
    for c in line.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => break,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Every `F` word on ONE comment-stripped line, in order.
///
/// 🔴 ONE SCANNER FOR THE TWO THAT SHIP. This lane had a display reader here and
/// a **safety** reader in `cli`'s feed-ceiling backstop, and they differed on the
/// two syntaxes below — the one that mattered being the safety reader, where the
/// miss is physical rather than visual: an over-ceiling cutting feed written as
/// `G1X1F5000` walked past the backstop **silently** while the operator's
/// summary showed it correctly. Both now call this.
///
/// ⚠ **SEVEN MORE EXIST, AND THREE OF THEM SHIP** — recounted 2026-08-28 after the
/// first version of this paragraph said "four, and they are ALL `#[cfg(test)]`".
/// That was wrong in the direction that matters: the word *all* tells the next
/// reader the product is single-sourced and only the tests are not, so they stop
/// grepping — which is the exact harm this paragraph was rewritten to prevent,
/// committed inside the rewrite.
///
/// * **`fixture.rs::hd_words` — SHIPS, and it is the SAFETY one.** The
///   hold-down check's own reader. It had the same adjacency defect and failed
///   WORSE: it DROPPED an unparsable word instead of pushing NaN, so a block it
///   could not read looked like a block with fewer words — no removal modelled,
///   and nothing in `unread` for the suppression path. Fixed 2026-08-28, one
///   hour after `block_words`, because fixing only the first had WIDENED the
///   drift that function's own header warns about.
/// * **`job.rs::summarize_program` — SHIPS.** Reads `F` through `block_words`,
///   which is not the `strip_prefix('F')` shape, which is why the grep behind
///   the first count could not see it. **A census must be counted by hand,
///   including the callers that do not match the shape it was derived from.**
///   It was blind to `F 5000` — the value parsed as `NaN`, `is_finite()`
///   rejected it, and the PREVIOUS feed silently governed the run-time estimate.
///   Fixed the same day; `block_words` now skips whitespace for every word.
///   ⚠ It still filters `f > 0.0`, which is the OPPOSITE convention to this
///   file's — a deliberate difference (an estimate cannot divide by zero) and
///   one that must be re-decided, not inherited, if it ever reports rather than
///   estimates.
/// * Four `#[cfg(test)]`: `fixtures.rs::feeds_in_gcode` (splits on `(` only, so
///   `( note ) G1 X1 F1200` yields NOTHING), `job.rs` ×2, and
///   `post_grblhal.rs::text_state`. Blindness there is in the tests that guard
///   the post's own feed output, not in the product.
/// * **`web/src/RunTab.tsx::words` — SHIPS, to the browser.** Reads every word
///   including `F`, for the Run tab's sender. It cannot call this function —
///   it is TypeScript and the wasm exports no line-level reader — so what is
///   shared is the RULE, plus a **table of cases both readers are run against**:
///   `web/tests/word-scan-cases.json`, read by
///   [`tests::both_readers_of_this_dialect_answer_the_shared_case_table_alike`]
///   and by `web/tests/run-words.test.ts`.
///
///   🔴 **THIS LINE CLAIMED THAT TEST FOR A DAY BEFORE IT EXISTED.** It read
///   *"restated there with a test comparing the two"*; there was no such test,
///   and when one was written the two readers disagreed on **five of seventeen**
///   cases — `X1.2.3` (browser `1.2`, a plausible DEPTH, against the core's
///   refusal), `X10-20`, `XY10`, `X-` and `X`. Every one is a block grblHAL
///   refuses, and in every one the browser gave the confident answer. A stated
///   coverage claim is worse than a stated gap: nobody re-checks the first.
///   It was also omitted from the previous count even though the very next
///   commit called it *"a third reader of the dialect"*.
/// * **Outside this crate, and NOT a test:** `gates/slicer_gate_check.mjs`'s
///   `/F([\d.]+)/`. Unanchored, no sign, no spaced form — and when it misses,
///   the measurement it feeds returns `null`, so the gate loses a limb quietly.
///   Named because the previous two versions of this paragraph each stated a
///   count that was wrong about the tree, and both times the miss was outside
///   the shape the count had been grepped from. **The scope of this list is
///   every reader of an `F` word anywhere in the lane, not every reader in
///   `core/`.**
///
/// ⚠ **THE COUNT HAS BEEN WRONG FOUR TIMES, ALWAYS UNDERSTATED, AND ALWAYS
/// BECAUSE THE MISS WAS OUTSIDE THE GREP SHAPE THE COUNT WAS DERIVED FROM.**
/// Count it by hand, and count `web/` and `gates/` as well as `core/` — the
/// scope of this list is every reader of an `F` word anywhere in the lane.
///
/// ⚠ `block_words` shares this function's VALUE scan (`word_value_at`) and not
/// its `prev_ok` clause, so `XF10` is `('X', NaN), ('F', 10)` there and `[]`
/// here. Recorded rather than unified: `block_words` splits every word for the
/// estimator and cannot adopt a rule written for `F` alone without a pass over
/// the others.
///
/// What it accepts, and every clause is a real grblHAL behaviour:
///
/// * **whitespace is not significant** — `G1X1F1200` and `X1.5F1200` are valid
///   blocks, and a reader that requires a separator reads a different language
///   from the one it claims to.
/// * **a spaced value** — `F 1200`.
/// * **a sign** — grbl's own `read_float` accepts a leading `+`.
/// * **a letter always starts a word**, so `XF10` is not a feed.
///
/// Values are returned as parsed, INCLUDING zero and negative. `F0` on a motion
/// block is `error:22` — a halt with the tool down — and dropping it would
/// render that program as one with no feeds at all. Dropping a value is the one
/// direction that hides a defect.
/// The numeric value of one G-code word, starting at the byte AFTER its letter.
///
/// 🔴 ONE RULE, BECAUSE RE-TYPING IT IS HOW THE READERS DRIFT. Three readers of
/// this dialect ship, and on 2026-08-28 a commit whose stated purpose was
/// CLOSING that drift re-authored this scan by hand in `fixture.rs::hd_words`
/// and introduced a new divergence in the same edit: it accepted a sign
/// ANYWHERE in the run, so `G1 X10-20` gave `X = 10` in the estimator and `NaN`
/// in the hold-down reader. Same program, two answers.
///
/// The rule: optional whitespace, then an optional single leading sign, then
/// digits and dots. Whitespace because it is not significant to grblHAL's
/// parser; a leading `+` because grbl's own `read_float` accepts one.
///
/// Returns the value and the index one past its last byte. `None` when there is
/// no number there at all — the caller decides whether that is a NaN word to be
/// named or a letter to be skipped, because the two readers want different
/// answers to that and only that.
pub fn word_value_at(bytes: &[u8], after_letter: usize) -> Option<(f64, usize)> {
    let mut j = after_letter;
    while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
        j += 1;
    }
    let start = j;
    if j < bytes.len() && (bytes[j] == b'-' || bytes[j] == b'+') {
        j += 1;
    }
    while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
        j += 1;
    }
    if j == start {
        return None;
    }
    /* 🔴 A VALUE ENDS WHERE A NEW WORD CAN BEGIN, AND NOWHERE ELSE — see
     * [`can_follow_a_value`]. Without this clause the scan stopped at the
     * offending byte and RETURNED WHAT IT HAD, so `X10-20` read as `X = 10`
     * with `-20` silently discarded. */
    if j < bytes.len() && !can_follow_a_value(bytes[j]) {
        return None;
    }
    let text: String = bytes[start..j].iter().map(|b| *b as char).collect();
    Some((text.parse::<f64>().unwrap_or(f64::NAN), j))
}

/// The bytes that may legally terminate a word's value.
///
/// 🔴 THIS IS THE CLAUSE THAT DECIDES WHICH READER WON. Unifying the three
/// scanners closed a divergence — `G1 X10-20` gave `X = 10` in the estimator and
/// `NaN` in the hold-down reader — and the FIRST unification closed it by
/// adopting the estimator's answer, silently, in the reader `fixture.rs`'s own
/// header calls *the safety one*. The commit body stated the divergence and
/// never said which side it took. **A unification is a ruling**, and an
/// unstated ruling defaults to whichever branch the author happened to type.
///
/// grblHAL's parser is the tie-breaker and it REFUSES: after a value it expects
/// a word letter or whitespace, so `X10-20` is `error:20` and the block never
/// runs. Reading it as `X = 10` invents a motion the machine would not make. So
/// the scan refuses too, the caller names the word, and the block is not
/// modelled — which is the direction that costs an operator a `—` instead of a
/// number that is wrong.
///
/// ⚠ It also means `X1.2.3` and `X10-20` are now named ALIKE. Before, one was
/// `NaN` and the other was a confident `10`, and nothing said why two blocks the
/// controller rejects identically were read differently.
///
/// `(` and `;` are here because `feed_role_of_line` is documented to tolerate an
/// unstripped comment, so this scan must not red on one either.
fn can_follow_a_value(b: u8) -> bool {
    b.is_ascii_alphabetic()
        || b == b' '
        || b == b'\t'
        || b == b'\r'
        || b == b'('
        || b == b')'
        || b == b';'
}

pub fn feed_words_on_line(code: &str) -> Vec<f64> {
    let up = code.to_ascii_uppercase();
    let bytes = up.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'F' {
            i += 1;
            continue;
        }
        let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphabetic();
        match word_value_at(bytes, i + 1) {
            Some((v, j)) => {
                if prev_ok && v.is_finite() {
                    out.push(v);
                }
                i = j.max(i + 1);
            }
            None => i += 1,
        }
    }
    out
}

/// Every distinct **cutting** feed commanded by an emitted program, in the order
/// it first appears, mm/min.
///
/// 🔴 READ FROM THE PROGRAM, AND THE ROLE RULE STAYS IN THE CORE. A host that
/// wants to show the operator "what feed is this job running at" was, until
/// 2026-08-28, walking `Report::render` — the PLAN, one step before the bytes —
/// and dropping every drilling feed with it, because a canned cycle renders as
/// `kind: 'drill'` and the host's filter did not name it. The obvious repair,
/// re-deriving the answer in TypeScript, would have put
/// [`feed_role_of_line`]'s rule in a second place: a `G38.2` probe seek is not
/// a cut, and a host that does not know that displays `F200.0` as the cutting
/// feed of a job whose finishing pass is slower. That rule is in this crate
/// **precisely so a host does not become the second copy**, so the whole
/// question is answered here and the host displays the answer.
///
/// ⚠ WHAT THIS IS NOT. It is the set of feeds the program COMMANDS, not the
/// feeds the machine will achieve: grblHAL clamps to `$110–$112` and ramps
/// through every corner, neither of which is in the file. And `F` is modal in
/// G-code, so a feed commanded once governs every cutting move after it — the
/// ORDER here is first-appearance, and the list is deliberately not summarised
/// to a maximum, because "the fastest number in the file" and "the feed this
/// job cuts at" are different claims and a single figure cannot tell a reader
/// which one it is being given.
pub fn cutting_feeds_in_program(gcode: &str) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for raw in gcode.lines() {
        let code = strip_comments(raw);
        if matches!(feed_role_of_line(&code), FeedRole::Probing) {
            continue;
        }
        for v in feed_words_on_line(&code) {
            if !out.iter().any(|x| (x - v).abs() < 1e-9) {
                out.push(v);
            }
        }
    }
    out
}

// ===========================================================================
//  THE TWO PROBE FEEDS — the exemption is not a licence
// ===========================================================================

/// The built-in rapid rate, named so it can be pointed at rather than quoted.
///
/// 🔴 **UNSOURCED, and the corpus says so in its own words.**
/// `docs/materials-research.md` §3.4 lists `rapid_mm_min` = 3,000 as
/// **INVENTED**, and item 15 of its unsourced list records that the controller
/// settings it stands in for — `$110`/`$111`/`$112` — are *"not obtainable
/// before the machine is commissioned"*.
///
/// It is named here for exactly the purpose [`BUILT_IN_PLUNGE_MM_MIN`] serves:
/// so that [`ProbeFeedFault::AboveRapidRate`]'s sentence can tell an operator
/// *"the limit you are being refused against may be a number this repo invented,
/// not one you typed"*. **It is deliberately not used as a fallback anywhere** —
/// a constant that is both the default and the thing the message cites is one
/// value answering two questions.
pub const BUILT_IN_RAPID_MM_MIN: f64 = 3_000.0;

/// What is wrong with the two probe feeds — judged against **each other** and
/// against the machine's **own declared rapid rate**, and against nothing else.
///
/// # 🔴 WHY THERE IS NO ABSOLUTE PROBING CEILING HERE
///
/// A runaway probe seek is a real physical failure and it is worth stating
/// plainly: a `G38.2` descends until the tip closes a circuit, and **the feed is
/// what decides whether the machine stops ON contact or drives THROUGH it.** The
/// distance travelled after the switch fires is `v² / 2a`, so bounding a seek
/// honestly needs two quantities — the device's **overtravel budget** and the
/// machine's **acceleration**. **This model holds neither, and neither is
/// sourceable today:**
///
/// * **Overtravel.** [`crate::types::TouchPlate`] carries a top thickness and a
///   wall and no travel at all. The only place the corpus records the quantity
///   is a UI catalogue note on a wireless setter — *"plunger travel 0.95 mm"*
///   against *"5.0 mm the wired setters allow"* — a **5x spread**, which is the
///   same shape of spread that made `Machine::touch_plate_mm` a refusal rather
///   than a default.
/// * **Acceleration.** `$120`–`$122` for our controller are item 15 of
///   `docs/materials-research.md`'s unsourced list, recorded there as **not
///   obtainable before the machine is commissioned**.
///
/// ⚠ **And the number that LOOKS like a source is the trap.**
/// `probe_seek_feed` / `probe_feed` ship at 200 / 25 attributed to grblHAL, and
/// §3.4 of that same document records the attribution as **UNVERIFIED** (item
/// 14). Even if it held, **a default is not a limit.** Promoting 200 to a
/// ceiling would be the `touch_plate_mm` mistake in a new field, and
/// [`crate::drill::DECLARED`] is deliberately empty for exactly this reason: the
/// formula is known and no value is sourced, so **no value is written.**
///
/// ⇒ **So nothing below is invented.** Every arm is either two declarations put
/// next to each other, or a fact read out of grblHAL's own source and quoted
/// with it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProbeFeedFault {
    /// 🔴 The value is not a rate at all — non-finite, zero or negative. The two
    /// halves fail in **opposite directions at the controller**, and only one of
    /// them fails loudly, which is why the sentence branches.
    NotAFeed { field: &'static str, value: f64 },
    /// 🔴 The slow re-probe is not slower than the seek, so the second pass
    /// measures nothing the first did not.
    ///
    /// ⚠ **This is the one check here that needs no number from anywhere** — it
    /// is a property of the pair, and it stays true whatever the right absolute
    /// bound turns out to be.
    SlowPassNotSlower { seek_mm_min: f64, slow_mm_min: f64 },
    /// 🔴 A probe feed above the machine's own declared rapid rate. Not a
    /// probing limit — the **machine's** limit, which a probe is no more exempt
    /// from than any other motion.
    AboveRapidRate { field: &'static str, value: f64, rapid_mm_min: f64 },
}

impl ProbeFeedFault {
    /// The whole sentence. There is no empty arm: every variant of this enum IS
    /// a fault, so unlike [`ChipVerdict::why`] there is no state for a blank to
    /// be mistaken for.
    pub fn why(&self) -> String {
        match self {
            Self::NotAFeed { field, value } => {
                let what = if !value.is_finite() {
                    format!(
                        "is {value}, which is not a number. It would be written verbatim into the \
                         F word of a G38.2 block, and a word that is not a number must never be \
                         streamed to a controller — the same rule that refuses a non-finite \
                         coordinate before a single byte of program is written"
                    )
                } else if *value < 0.0 {
                    format!(
                        "is {value:.1}mm/min, and a negative F word is rejected by the controller \
                         outright — grblHAL `gcode.c`, `[3. Set feed rate]`: \
                         `if(gc_block.values.f < 0.0f) RETURN(Status_NegativeValue);` (read \
                         2026-08-11). The program would halt part-way through the probe with the \
                         Z datum unset"
                    )
                } else {
                    format!(
                        "is {value:.1}mm/min, and a ZERO probe feed is the WORSE of the two \
                         because the controller does NOT reject it. grblHAL's undefined-feed-rate \
                         check sits in the G93 (inverse-time) branch only; in G94 the parser \
                         simply carries the value, so `F0.0` reaches the planner, and \
                         `plan_compute_profile_nominal_speed` ends \
                         `return nominal_speed > MINIMUM_FEED_RATE ? nominal_speed : \
                         MINIMUM_FEED_RATE;` with `#define MINIMUM_FEED_RATE 1.0f // (mm/min)` \
                         (config.h, read 2026-08-11). A 30mm seek then takes half an hour and \
                         reads at the machine as a hang, not as an error"
                    )
                };
                format!(
                    "`machine.{field}` {what}. A probe feed is the rate the tip approaches a \
                     fixed metal object at; set it to a rate you would stand next to"
                )
            }
            Self::SlowPassNotSlower { seek_mm_min, slow_mm_min } => format!(
                "the slow re-probe (`machine.probe_feed`, {slow_mm_min:.1}mm/min) is NOT slower \
                 than the seek (`machine.probe_seek_feed`, {seek_mm_min:.1}mm/min), and the \
                 second pass is the one the datum is actually read on. The two-pass shape exists \
                 because the fast pass is not trusted to stop where it touched — so a re-probe at \
                 or above the seek rate measures nothing the seek did not, and the Z0 that every \
                 coordinate in this program is written against is taken at a rate already judged \
                 too fast to take it at. That is a FALSE DATUM, which is the silent failure: the \
                 operator gets a number, not an alarm. This needs no threshold to be wrong — it \
                 is the two declared numbers next to each other — so it is REFUSED. Lower \
                 `machine.probe_feed` below `machine.probe_seek_feed`"
            ),
            Self::AboveRapidRate { field, value, rapid_mm_min } => {
                let default_note = if (*rapid_mm_min - BUILT_IN_RAPID_MM_MIN).abs() < 1e-9 {
                    format!(
                        " ⚠ {BUILT_IN_RAPID_MM_MIN:.0}mm/min is ALSO this crate's built-in rapid \
                         default and it is unsourced (`docs/materials-research.md` §3.4 calls it \
                         INVENTED), so if you did not type it, the limit you are being refused \
                         against is a number nobody declared."
                    )
                } else {
                    String::new()
                };
                format!(
                    "`machine.{field}` is {value:.1}mm/min and this machine declares a rapid rate \
                     of {rapid_mm_min:.1}mm/min. A probe feed above the machine's own maximum \
                     motion rate is NOT the rate that will run: grblHAL's planner clamps every \
                     non-rapid block to it — `plan_compute_profile_nominal_speed`: \
                     `if(nominal_speed > block->rapid_rate) nominal_speed = block->rapid_rate;`, \
                     with `block->rapid_rate` derived from the axis maxima $110-$112 (read \
                     2026-08-11) — so the figure in the file and the rate at the machine are \
                     different, silently. Both are declarations and they contradict each other, \
                     so this is REFUSED rather than emitted as a number nobody will \
                     get.{default_note} Set `machine.{field}` at or below {rapid_mm_min:.0}, or \
                     declare this machine's real rapid rate. ⚠ Passing this bound is NOT a \
                     statement that the feed is safe: `rapid_mm_min` is one scalar where \
                     $110-$112 are per-axis and Z is usually the slowest, and NOTHING here bounds \
                     a seek against the touch plate's overtravel — see `ProbeFeedFault`'s header \
                     for why no such number is invented"
                )
            }
        }
    }
}

/// The two probe feeds, judged. Empty means nothing was found — and the header
/// of [`ProbeFeedFault`] says exactly how much that does and does not cover.
///
/// * `rapid_mm_min` — `machine.rapid_mm_min`. Non-positive or non-finite means
///   **nobody declared one**, which is not a rapid of zero: the same `absent
///   means unconstrained` reading [`resolve_feed`] and [`plunge_feed`] give an
///   absent ceiling.
///
/// 🔴 **A value that is not a number suppresses the DERIVED complaints about
/// it.** Comparing `NaN` or `-5` against anything produces a second sentence
/// caused entirely by the first, and an operator reading three faults where
/// there is one defect starts skimming them.
pub fn probe_feed_faults(
    seek_mm_min: f64,
    slow_mm_min: f64,
    rapid_mm_min: f64,
) -> Vec<ProbeFeedFault> {
    let fields = [("probe_seek_feed", seek_mm_min), ("probe_feed", slow_mm_min)];
    let mut v: Vec<ProbeFeedFault> = fields
        .iter()
        .filter(|(_, value)| !value.is_finite() || *value <= 0.0)
        .map(|(field, value)| ProbeFeedFault::NotAFeed { field, value: *value })
        .collect();
    if !v.is_empty() {
        return v;
    }

    if slow_mm_min >= seek_mm_min {
        v.push(ProbeFeedFault::SlowPassNotSlower { seek_mm_min, slow_mm_min });
    }

    if rapid_mm_min.is_finite() && rapid_mm_min > 0.0 {
        for (field, value) in fields {
            if value > rapid_mm_min {
                v.push(ProbeFeedFault::AboveRapidRate { field, value, rapid_mm_min });
            }
        }
    }

    v
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_value_the_controller_would_reject_is_refused_not_truncated() {
        /* 🔴 THIS TEST ASSERTED THE WRONG ANSWER FOR ONE DAY, AND SAID SO
         * CONFIDENTLY. It was named `the_three_shipping_readers_agree_on_a_sign_
         * mid_word` and asserted `X10-20 == 10.0` — the readers did agree, and
         * the thing they agreed on was a motion the machine will never make.
         * grblHAL answers `error:20` and runs no part of that block; reading it
         * as a 10 mm move invents one. A control and its test can agree
         * perfectly and both be wrong, and the giveaway here was that the
         * unification never STATED which of the two answers it adopted.
         *
         * The old divergence: `hd_words` accepted a sign anywhere in the run and
         * the other two accepted one only as the first character, so `G1 X10-20`
         * read as X=10 in the estimator and X=NaN in the HOLD-DOWN reader. All
         * three now call `word_value_at` — and it refuses, which is the safety
         * reader's answer, not the estimator's. */
        assert_eq!(
            super::word_value_at(b"X10-20", 1),
            None,
            "a value run terminated by a byte that cannot start a word is not a value"
        );
        // ...and it is now named the SAME WAY as the other block grblHAL rejects
        // identically. Before, one was NaN and the other a confident 10.
        assert_eq!(super::word_value_at(b"X10*20", 1), None);

        // The refusal must not spread to the forms grblHAL ACCEPTS. `X10Y20` is
        // two words with no separator and is valid; a false red here would make
        // every emitted block unreadable, which is the expensive direction.
        assert_eq!(super::word_value_at(b"X10Y20", 1).map(|(v, _)| v), Some(10.0));
        assert_eq!(super::word_value_at(b"X10 Y20", 1).map(|(v, _)| v), Some(10.0));
        assert_eq!(super::word_value_at(b"X10", 1).map(|(v, _)| v), Some(10.0));
        assert_eq!(super::word_value_at(b"X10\r", 1).map(|(v, _)| v), Some(10.0));
        assert_eq!(super::word_value_at(b"X10(c)", 1).map(|(v, _)| v), Some(10.0));
        assert_eq!(super::word_value_at(b"X10;c", 1).map(|(v, _)| v), Some(10.0));

        // A LEADING sign is part of the value; grbl's own read_float takes `+`.
        assert_eq!(super::word_value_at(b"Z-2.5", 1).map(|(v, _)| v), Some(-2.5));
        assert_eq!(super::word_value_at(b"Z+5", 1).map(|(v, _)| v), Some(5.0));
        // Whitespace is not significant to grblHAL's parser.
        assert_eq!(super::word_value_at(b"F 600", 1).map(|(v, _)| v), Some(600.0));
        // Nothing numeric at all is NONE — the caller decides what that means,
        // and the two readers deliberately want different answers.
        assert_eq!(super::word_value_at(b"XY", 1), None);
        assert_eq!(super::word_value_at(b"X", 1), None);
        // Unparsable-but-numeric-looking is NaN, never a silent omission.
        assert!(super::word_value_at(b"X1.2.3", 1).is_some_and(|(v, _)| v.is_nan()));
    }

    /// The browser's `RunTab::words` scans this same dialect and cannot share
    /// this code. 🔴 **`word_value_at`'s census claimed a test comparing the two
    /// existed for a day before one did**, and when it was written the readers
    /// disagreed on five inputs. This is the Rust half; `web/tests/
    /// run-words.test.ts` is the other, and both read the SAME file.
    #[test]
    fn both_readers_of_this_dialect_answer_the_shared_case_table_alike() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/tests/word-scan-cases.json");
        /* 🔴 A MISSING TABLE MUST NOT READ AS A PASS. The obvious shape here is
         * `if let Ok(text) = read_to_string(..)`, which turns a renamed or
         * deleted table into a silent green — a check that cannot run reports
         * PENDING, never PASS, and a unit test has no PENDING. */
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("the shared case table is unreadable at {path}: {e}"));
        let doc: serde_json::Value = serde_json::from_str(&text).expect("the case table is JSON");
        let cases = doc["cases"].as_array().expect("`cases` is an array");
        assert!(
            cases.len() >= 17,
            "the shared case table lost cases: {}",
            cases.len()
        );
        assert!(
            cases.iter().any(|c| c.get("wasDivergent").is_some()),
            "the table no longer holds a case the two readers once disagreed on, which is the \
             only kind that can catch them drifting apart again"
        );

        for case in cases {
            let line = case["line"].as_str().expect("every case has a line");
            let expect: Vec<(char, Option<f64>)> = case["words"]
                .as_array()
                .expect("every case lists its words")
                .iter()
                .map(|w| {
                    let letter = w[0].as_str().unwrap().chars().next().unwrap();
                    (letter, w[1].as_f64())
                })
                .collect();

            // The core's scan, driven exactly as `block_words` drives it.
            let bare = super::strip_comments(line).to_ascii_uppercase();
            let b = bare.as_bytes();
            let mut got: Vec<(char, Option<f64>)> = Vec::new();
            let mut i = 0usize;
            while i < b.len() {
                let c = b[i] as char;
                if c.is_ascii_alphabetic() {
                    match super::word_value_at(b, i + 1) {
                        Some((v, j)) if v.is_finite() => {
                            got.push((c, Some(v)));
                            i = j.max(i + 1);
                        }
                        Some((_, j)) => {
                            got.push((c, None));
                            i = j.max(i + 1);
                        }
                        None => {
                            got.push((c, None));
                            i += 1;
                        }
                    }
                } else {
                    i += 1;
                }
            }
            assert_eq!(
                got,
                expect,
                "\"{line}\" — the core reads it differently from the browser.{}",
                case.get("wasDivergent")
                    .and_then(|d| d.as_str())
                    .map(|d| format!(" This case exists because: {d}"))
                    .unwrap_or_default()
            );
        }
    }

    #[test]
    fn a_probe_seek_is_not_a_cutting_feed() {
        // 🔴 THE WHOLE REASON THIS LIVES IN THE CORE. A host re-deriving "which
        // F words are cuts" in TypeScript would display F200 — a G38.2 seek —
        // as the cutting feed of a job whose finishing pass is slower.
        let g = "G38.2 Z-30.000 F200.0\nG1 X10 F3600.0\nG38.2 Z-4.000 F25.0\n";
        assert_eq!(super::cutting_feeds_in_program(g), vec![3600.0]);
    }

    #[test]
    fn a_feed_inside_a_comment_is_not_a_feed() {
        // This post writes the program name and the tool line through `( … )`,
        // and a tool may legitimately be named after a feed.
        let g = "( plate F9999 )\n( tool: End Mill F600 roughing )\nG1 X1 F1200\n; F4242\n";
        assert_eq!(super::cutting_feeds_in_program(g), vec![1200.0]);
    }

    #[test]
    fn every_distinct_cutting_feed_is_kept_in_first_appearance_order_and_deduped() {
        // A LIST, not a maximum: "the fastest number in the file" and "the feed
        // this job cuts at" are different claims, and a single figure cannot
        // tell a reader which one it is being handed.
        let g = "G1 X1 F300\nG1 X2 F3600\nG1 X3 F300\nG1 X4 F1800\n";
        assert_eq!(super::cutting_feeds_in_program(g), vec![300.0, 3600.0, 1800.0]);
    }

    #[test]
    fn an_f_that_is_not_a_word_is_not_a_feed() {
        // 🔴 THIS COMMENT SAID THE OPPOSITE OF THE CODE UNTIL 2026-08-28, and it
        // sat directly on top of its own counter-example. It read *"a coordinate
        // that happens to end in F is not a feed"* while the corpus line below,
        // `G1 X1.5F1200`, now yields 1200 — and the test asserted only that 900
        // is present and 10 absent, so the case the comment was wrong about was
        // the one thing it declined to check. A reader restoring the old rule to
        // satisfy that sentence would have been endorsed by it.
        //
        // The rule is: a LETTER always starts a word in G-code. `XF10` is not a
        // feed because `X` is a letter; `X1.5F1200` is one, because whitespace
        // and digits are not word boundaries to grblHAL's parser.
        let g = "G1 XF10\nG1 X1.5F1200\nG1 X2 F900\n";
        let got = super::cutting_feeds_in_program(g);
        assert!(got.contains(&900.0), "a real feed word must be read: {got:?}");
        assert!(!got.contains(&10.0), "`XF10` is not a feed: {got:?}");
        // The counter-example the old comment was wrong about, now asserted.
        assert!(got.contains(&1200.0), "`X1.5F1200` IS a feed: {got:?}");
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn a_commanded_zero_is_a_commanded_feed_and_is_NOT_dropped() {
        // 🔴 THIS TEST'S NEIGHBOUR ARGUED THIS IN PROSE WHILE THE CODE DID THE
        // OPPOSITE. `F0` on a cutting line is answered by grblHAL with
        // `error:22` — a halt with the tool down — and dropping it rendered that
        // program as "not commanded", i.e. as a job with no feeds at all.
        // Dropping a value is the one direction that hides a defect, and the
        // sibling `S` reader in the web panel states the same rule and obeys it.
        assert_eq!(super::cutting_feeds_in_program("G1 X1 F0\n"), vec![0.0]);
        assert_eq!(super::cutting_feeds_in_program("G1 X1 F0\nG1 X2 F1200\n"), vec![0.0, 1200.0]);
    }

    #[test]
    fn a_negative_feed_reaches_a_person_rather_than_vanishing() {
        // `F-100` is not a feed anyone meant. It must be visible, not silently
        // discarded by a digit scan — an impossible value that no host can show
        // is an impossible value nobody fixes.
        assert_eq!(super::cutting_feeds_in_program("G1 X1 F-100\n"), vec![-100.0]);
    }

    #[test]
    fn whitespace_is_not_significant_to_the_parser_and_must_not_be_to_this_reader() {
        // grblHAL ignores whitespace inside a block. The first version of this
        // rule required a non-alphanumeric before `F`, so BOTH of these — valid
        // programs — yielded no feed at all. Latent today because this post
        // always emits " F…", and a `pub` function that returns nothing on valid
        // input is a wrong answer waiting for a second producer.
        assert_eq!(super::cutting_feeds_in_program("G1X1F1200\n"), vec![1200.0]);
        assert_eq!(super::cutting_feeds_in_program("G1 X1.5F1200\n"), vec![1200.0]);
        assert_eq!(super::cutting_feeds_in_program("G1 X1 F 1200\n"), vec![1200.0]);
        // …and a letter still starts a word, so this is not a feed.
        assert!(super::cutting_feeds_in_program("G1 XF10\n").is_empty());
    }

    #[test]
    fn a_program_with_no_feed_at_all_answers_empty_not_zero() {
        // Empty is "not commanded". Zero is a commanded feed of zero, which is
        // a different and alarming fact, and a host must be able to tell them
        // apart to render the difference.
        assert!(super::cutting_feeds_in_program("G0 X1\nM5\nM30\n").is_empty());
        assert!(super::cutting_feeds_in_program("").is_empty());
    }

    #[test]
    fn the_real_emitted_program_agrees_with_the_rule() {
        // Driven through the actual fixture rather than a hand-written string,
        // so a change to the post that stops emitting F where this expects it
        // moves this test instead of sliding under it.
        let r = crate::fixtures::plan_report("plate", crate::fixtures::JobPlant::None, &Default::default(), 0.6)
            .expect("the plate fixture must plan");
        assert_eq!(
            r.cutting_feeds_mm_min,
            super::cutting_feeds_in_program(&r.gcode),
            "the report's field and the function must not be able to disagree"
        );
        assert!(!r.cutting_feeds_mm_min.is_empty(), "a cutting program commands a feed");
        // The probe seeks are in that program and must not be in this list.
        assert!(r.gcode.contains("G38.2"), "vacuity: the fixture must actually probe");
        assert!(
            !r.cutting_feeds_mm_min.iter().any(|f| *f == 200.0 || *f == 25.0),
            "a probe seek reached the cutting-feed list: {:?}",
            r.cutting_feeds_mm_min
        );
    }
    use super::*;

    fn tool(flutes: u32, chip: f64, min: f64, max: f64) -> Tool {
        Tool {
            flutes,
            chipload_mm: chip,
            chipload_min_mm: min,
            chipload_max_mm: max,
            rpm_min: 8_000.0,
            rpm_max: 24_000.0,
            ..Tool::default()
        }
    }

    /// The ⌀12 2F end mill exactly as `default_library()` ships it — the tool the
    /// measurement in this module's header was taken on.
    fn d12() -> Tool {
        Tool { diameter_mm: 12.0, ..tool(2, 0.30, 0.15, 0.50) }
    }

    /// The fork measured these five pairings against PUBLISHED manufacturer
    /// tables after a home-grown scaling rule was found over-feeding 2.1x at
    /// 19mm. They are kept as a regression corpus: if the formula drifts, these
    /// are the numbers that were true at a real machine.
    #[test]
    fn published_cutting_feeds() {
        let cases = [
            // (diameter, flutes, chipload, rpm, expected feed mm/min)
            (3.175, 2, 0.050, 18_000.0, 1_800.0),
            (4.0, 2, 0.070, 18_000.0, 2_520.0),
            (6.0, 2, 0.100, 18_000.0, 3_600.0),
            (8.0, 2, 0.210, 18_000.0, 7_560.0),
            (12.0, 2, 0.300, 18_000.0, 10_800.0),
        ];
        for (dia, flutes, cl, rpm, want) in cases {
            let t = Tool { diameter_mm: dia, flutes, chipload_mm: cl, ..Tool::default() };
            let got = feed_from_chipload(&t, rpm);
            assert!(
                (got - want).abs() < 1e-6,
                "D{dia} F{flutes} cl{cl} @{rpm}rpm: got {got}, want {want}"
            );
        }
    }

    #[test]
    fn chipload_round_trips() {
        let t = Tool { flutes: 2, chipload_mm: 0.1, ..Tool::default() };
        let f = feed_from_chipload(&t, 18_000.0);
        assert!((chipload_from_feed(&t, 18_000.0, f) - 0.1).abs() < 1e-12);
    }

    /// Negative control: the window check must actually reject. A predicate
    /// that is true for everything is the same as no check at all.
    #[test]
    fn window_rejects_out_of_range() {
        let t = tool(2, 0.10, 0.02, 0.30);
        assert!(chipload_in_window(&t, 18_000.0, 3_600.0)); // cl = 0.10, inside
        assert!(!chipload_in_window(&t, 18_000.0, 36_000.0)); // cl = 1.00, above
        assert!(!chipload_in_window(&t, 18_000.0, 180.0)); // cl = 0.005, below
    }

    /// 🔴 And the two ways out are DIFFERENT failures, so they are different
    /// answers. The boolean above cannot tell an overloaded flute from a rubbing
    /// one, and the operator's action is opposite in the two cases.
    #[test]
    fn the_two_ways_out_of_the_window_are_not_the_same_answer() {
        let t = tool(2, 0.10, 0.02, 0.30);
        match chip_verdict(&t, 18_000.0, 180.0) {
            ChipVerdict::Below { chip_mm, min_mm } => {
                assert!((chip_mm - 0.005).abs() < 1e-9);
                assert!((min_mm - 0.02).abs() < 1e-9);
            }
            other => panic!("a rubbing chip reported {other:?}"),
        }
        match chip_verdict(&t, 18_000.0, 36_000.0) {
            ChipVerdict::Above { chip_mm, max_mm } => {
                assert!((chip_mm - 1.0).abs() < 1e-9);
                assert!((max_mm - 0.30).abs() < 1e-9);
            }
            other => panic!("an overloaded flute reported {other:?}"),
        }
        // The sentences must be actable and must not read alike.
        assert!(chip_verdict(&t, 18_000.0, 180.0).why().contains("rubs"));
        assert!(chip_verdict(&t, 18_000.0, 36_000.0).why().contains("ABOVE"));
        // ...and an in-window verdict says NOTHING, so a blank cannot be read as
        // an answer that was given.
        assert_eq!(chip_verdict(&t, 18_000.0, 3_600.0).why(), "");
    }

    #[test]
    fn zero_rpm_does_not_divide_by_zero() {
        let t = Tool::default();
        assert_eq!(chipload_from_feed(&t, 0.0, 1_000.0), 0.0);
    }

    // --- the ceiling ------------------------------------------------------

    /// 🔴 THE PLANT, AND IT IS THE MEASUREMENT FROM THIS MODULE'S HEADER.
    /// `feed.min(ceiling)` on the ⌀12 at 24,000 rpm delivers 0.125mm of chip
    /// against a declared minimum of 0.150 — and this asserts that the naive
    /// clamp really does go out of window, so the fix below is not a fix to a
    /// problem nobody had.
    #[test]
    fn the_naive_clamp_puts_the_shipped_d12_below_its_own_rated_chip() {
        let t = d12();
        let naive = (24_000.0 * 2.0 * 0.30_f64).min(6_000.0);
        assert_eq!(naive, 6_000.0);
        match chip_verdict(&t, 24_000.0, naive) {
            ChipVerdict::Below { chip_mm, min_mm } => {
                assert!((chip_mm - 0.125).abs() < 1e-9, "chip {chip_mm}");
                assert!((min_mm - 0.15).abs() < 1e-9);
            }
            other => panic!("the naive clamp is supposed to be out of window; it reported {other:?}"),
        }
    }

    /// ...and the same pairing through `resolve_feed` holds the chip by taking
    /// the spindle down. 10,000 rpm is the figure `docs/materials-research.md`
    /// §4.1 derives for this exact case.
    #[test]
    fn a_binding_ceiling_takes_the_spindle_down_and_the_chip_stays_where_it_was() {
        let t = d12();
        let r = resolve_feed(&t, 24_000.0, 0.30, 6_000.0, 8_000.0);
        match r {
            FeedResolution::RpmReducedToHoldTheChip { rpm, feed_mm_min, rpm_before, .. } => {
                assert!((rpm - 10_000.0).abs() < 1e-9, "rpm {rpm}");
                assert!((feed_mm_min - 6_000.0).abs() < 1e-9);
                assert!((rpm_before - 24_000.0).abs() < 1e-9);
            }
            other => panic!("expected the spindle to come down, got {other:?}"),
        }
        // 🔴 The assertion that matters is not the rpm — it is the CHIP the
        // emitted pair delivers.
        let (rpm, feed) = r.rpm_feed().expect("this case is runnable");
        assert!(chip_verdict(&t, rpm, feed).in_window(), "{:?}", chip_verdict(&t, rpm, feed));
        assert!((chipload_from_feed(&t, rpm, feed) - 0.30).abs() < 1e-9);
    }

    #[test]
    fn a_ceiling_that_does_not_bind_changes_nothing_at_all() {
        // The negative control. A resolution that always "helps" is a
        // resolution that has moved every job it touched.
        let t = Tool { diameter_mm: 6.0, ..tool(2, 0.10, 0.05, 0.20) };
        let r = resolve_feed(&t, 24_000.0, 0.10, 6_000.0, 8_000.0);
        assert_eq!(r, FeedResolution::Clear { rpm: 24_000.0, feed_mm_min: 4_800.0 });
        assert_eq!(r.why(), "", "an untouched cut must say nothing");
    }

    #[test]
    fn an_undeclared_ceiling_is_no_ceiling_and_not_a_ceiling_of_zero() {
        let t = d12();
        let r = resolve_feed(&t, 24_000.0, 0.30, 0.0, 8_000.0);
        assert_eq!(r, FeedResolution::Clear { rpm: 24_000.0, feed_mm_min: 14_400.0 });
    }

    /// 🔴 The refusal. Drop the ceiling far enough and the rpm that would hold
    /// the chip is below the slowest this spindle turns — at which point there
    /// is no runnable in-window speed and NO NUMBER IS RETURNED.
    #[test]
    fn when_the_rpm_floor_blocks_it_there_is_no_number_at_all() {
        let t = d12();
        // 900 mm/min would need 900 / (2 * 0.30) = 1,500 rpm.
        let r = resolve_feed(&t, 24_000.0, 0.30, 900.0, 8_000.0);
        match r {
            FeedResolution::NoSpeedHoldsTheChip { rpm_required, rpm_floor, .. } => {
                assert!((rpm_required - 1_500.0).abs() < 1e-9, "{rpm_required}");
                assert!((rpm_floor - 8_000.0).abs() < 1e-9);
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert_eq!(r.rpm_feed(), None, "a refusal must not hand back a number to run");
        assert!(r.why().contains("no speed"), "{}", r.why());
    }

    /// 🔴 THE PROPERTY, NOT THE THREE EXAMPLES ABOVE. Over a spread of tools,
    /// speeds and ceilings: whenever `resolve_feed` returns a pair, that pair is
    /// at or under the ceiling AND delivers exactly the chip that was asked for.
    /// An implementation that clamped the feed would fail the second half on
    /// every binding case, and one that ignored the ceiling would fail the
    /// first.
    #[test]
    fn every_runnable_answer_obeys_the_ceiling_and_keeps_the_chip() {
        let mut binding = 0;
        for flutes in [1u32, 2, 3] {
            for chip in [0.02, 0.10, 0.30] {
                for rpm in [8_000.0, 18_000.0, 24_000.0] {
                    for ceiling in [0.0, 900.0, 2_000.0, 6_000.0, 50_000.0] {
                        let t = tool(flutes, chip, chip * 0.5, chip * 2.0);
                        let r = resolve_feed(&t, rpm, chip, ceiling, 6_000.0);
                        let Some((got_rpm, got_feed)) = r.rpm_feed() else { continue };
                        if ceiling > 0.0 {
                            assert!(
                                got_feed <= ceiling + 1e-6,
                                "f{flutes} c{chip} @{rpm} ceiling {ceiling}: emitted {got_feed}"
                            );
                        }
                        let delivered = chipload_from_feed(&t, got_rpm, got_feed);
                        assert!(
                            (delivered - chip).abs() < 1e-9,
                            "f{flutes} c{chip} @{rpm} ceiling {ceiling}: chip moved to {delivered}"
                        );
                        assert!(chip_verdict(&t, got_rpm, got_feed).in_window());
                        if matches!(r, FeedResolution::RpmReducedToHoldTheChip { .. }) {
                            binding += 1;
                        }
                    }
                }
            }
        }
        // ...and the corpus actually exercised the binding branch. A property
        // test that never reaches the case it is about is a green nobody earned.
        assert!(binding > 0, "no case in this corpus made the ceiling bind");
    }

    // --- a feed the operator typed ----------------------------------------

    /// 🔴 THE PLANT FOR THE THIRD DEFECT: a pinned feed silently reduced.
    /// `pinned_feed` must REFUSE, and the refusal must not carry the reduced
    /// number — because the moment it does, the caller will emit it.
    #[test]
    fn a_pinned_feed_over_the_ceiling_is_refused_and_never_quietly_reduced() {
        match pinned_feed(20_000.0, 900.0) {
            PinnedFeed::AboveCeiling { pinned_mm_min, ceiling_mm_min } => {
                assert!((pinned_mm_min - 20_000.0).abs() < 1e-9);
                assert!((ceiling_mm_min - 900.0).abs() < 1e-9);
            }
            other => panic!("a pinned feed above the ceiling was accepted: {other:?}"),
        }
        // The reason names BOTH declarations, or the operator cannot tell which
        // one to change.
        let why = pinned_feed(20_000.0, 900.0).why();
        assert!(why.contains("20000") && why.contains("900"), "{why}");
        assert!(why.contains("REFUSED"), "{why}");
    }

    #[test]
    fn a_pinned_feed_inside_the_ceiling_is_emitted_exactly_as_typed() {
        // The negative control, and the one that proves the rule is not "refuse
        // every pinned feed".
        assert_eq!(pinned_feed(800.0, 900.0), PinnedFeed::Runnable { feed_mm_min: 800.0 });
        // Nothing pinned, and no ceiling declared: both are absences, not zeros.
        assert_eq!(pinned_feed(0.0, 900.0), PinnedFeed::Runnable { feed_mm_min: 0.0 });
        assert_eq!(pinned_feed(20_000.0, 0.0), PinnedFeed::Runnable { feed_mm_min: 20_000.0 });
    }

    // --- the plunge -------------------------------------------------------

    /// 🔴 THE PLANT FOR THE FOURTH DEFECT, and it is the measurement from the
    /// emitted program. `job plate --config '{"machine":{"max_feed_mm_min":150},
    /// "op":{"feed_mm_min":100}}'` on a control binary built from HEAD emitted
    /// **22 `G1 Z` lines at F300.0** against a declared 150 — while the lateral
    /// feed obeyed it at F100 on the same run. `plunge_feed` must refuse the
    /// pairing that produced them.
    #[test]
    fn the_measured_plunge_that_escaped_the_ceiling_is_now_refused() {
        match plunge_feed(300.0, 150.0) {
            PlungeFeed::AboveCeiling { plunge_mm_min, ceiling_mm_min } => {
                assert!((plunge_mm_min - 300.0).abs() < 1e-9);
                assert!((ceiling_mm_min - 150.0).abs() < 1e-9);
            }
            other => panic!("the measured escape was accepted: {other:?}"),
        }
        let why = plunge_feed(300.0, 150.0).why();
        assert!(why.contains("300") && why.contains("150"), "{why}");
        assert!(why.contains("REFUSED"), "{why}");
        // It must say WHY a plunge is under a cutting ceiling at all, or the
        // next reader exempts it again on the same "it is only Z" reasoning.
        assert!(why.contains("CUTTING MOVE"), "{why}");
        // ...and it must not blame the operator for a number this crate
        // invented, while also not pretending to know they did not type it.
        assert!(why.contains("built-in plunge default"), "{why}");
        assert!(why.contains("unsourced"), "{why}");
    }

    /// The attribution is CONDITIONAL, and that is the whole care taken here: a
    /// plunge the operator plainly typed must not be excused as our default.
    #[test]
    fn a_plunge_that_is_not_the_built_in_default_is_not_blamed_on_the_default() {
        let why = plunge_feed(1_200.0, 150.0).why();
        assert!(why.contains("1200") && why.contains("150"), "{why}");
        assert!(
            !why.contains("built-in plunge default"),
            "a typed 1200 was excused as our 300 default: {why}"
        );
    }

    #[test]
    fn a_plunge_inside_the_ceiling_is_untouched_and_says_nothing() {
        // The negative control, and the one that proves the rule is not "refuse
        // every plunge".
        assert_eq!(plunge_feed(300.0, 6_000.0), PlungeFeed::Runnable { plunge_mm_min: 300.0 });
        assert_eq!(plunge_feed(300.0, 6_000.0).why(), "");
        // Exactly at the ceiling is not over it.
        assert_eq!(plunge_feed(300.0, 300.0), PlungeFeed::Runnable { plunge_mm_min: 300.0 });
        // An undeclared ceiling is no ceiling, not a ceiling of zero — the same
        // reading as `resolve_feed`.
        assert_eq!(plunge_feed(300.0, 0.0), PlungeFeed::Runnable { plunge_mm_min: 300.0 });
    }

    /// 🔴 The structural guarantee: no arm of `PlungeFeed` hands back a number
    /// different from the one it was given. This is what makes `plunge_feed`
    /// impossible to wire as a clamp, the same way `pinned_feed` is.
    #[test]
    fn no_arm_of_the_plunge_verdict_can_return_a_reduced_plunge() {
        for plunge in [0.0, 1.0, 150.0, 300.0, 301.0, 20_000.0] {
            for ceiling in [0.0, 150.0, 300.0, 6_000.0] {
                match plunge_feed(plunge, ceiling) {
                    PlungeFeed::Runnable { plunge_mm_min } => assert_eq!(
                        plunge_mm_min, plunge,
                        "a runnable plunge came back changed: {plunge} -> {plunge_mm_min}"
                    ),
                    PlungeFeed::AboveCeiling { plunge_mm_min, .. } => {
                        assert_eq!(plunge_mm_min, plunge)
                    }
                }
            }
        }
    }

    /// The constant the message cites has to BE the default it claims to be.
    /// If `OperationParams::default().plunge_mm_min` ever moves, the sentence
    /// starts citing a number that is no longer anybody's default — a derived
    /// constant in prose becoming another session's evidence.
    #[test]
    fn the_cited_built_in_plunge_is_the_actual_built_in_plunge() {
        assert_eq!(
            BUILT_IN_PLUNGE_MM_MIN,
            crate::types::OperationParams::default().plunge_mm_min,
            "the plunge refusal cites a default that is no longer the default"
        );
    }

    // --- what the ceiling governs -----------------------------------------

    /// 🔴 The exemption, asserted at REAL EMITTED LINES rather than at invented
    /// ones. Both strings below are verbatim from `job plate` output.
    #[test]
    fn a_probing_move_is_exempt_and_a_cutting_move_is_not() {
        assert_eq!(feed_role_of_line("G38.2 Z-30.000 F200.0"), FeedRole::Probing);
        assert_eq!(feed_role_of_line("G38.2 Z-4.000 F25.0"), FeedRole::Probing);
        assert_eq!(feed_role_of_line("G1 Z-0.400 F300.0"), FeedRole::Cutting);
        assert_eq!(feed_role_of_line("G1 Y70.000 F200.0"), FeedRole::Cutting);
        // Every probing form grblHAL accepts, not just the one we emit today.
        for g in ["G38.3", "G38.4", "G38.5"] {
            assert_eq!(feed_role_of_line(&format!("{g} Z-30.000 F200.0")), FeedRole::Probing, "{g}");
        }
        // A probe word that is not first on the line.
        assert_eq!(feed_role_of_line("G91 G38.2 Z-30.000 F200.0"), FeedRole::Probing);
        // 🔴 UNRECOGNISED DEFAULTS TO CUTTING. Defaulting the other way would
        // exempt anything the classifier has not met — absence reading as a
        // permission, which is the direction that hides a leak.
        assert_eq!(feed_role_of_line("M3 S18000"), FeedRole::Cutting);
        assert_eq!(feed_role_of_line(""), FeedRole::Cutting);
    }

    /// The exemption has to SAY something, and the non-exemption has to say
    /// nothing — a blank must not be readable as an answer that was given.
    #[test]
    fn only_the_exempt_role_carries_a_reason() {
        assert_eq!(FeedRole::Cutting.why_exempt(), "");
        let w = FeedRole::Probing.why_exempt();
        assert!(w.contains("G38.2"), "{w}");
        assert!(w.contains("spindle is off"), "{w}");
        // ...including the residual, so the exemption cannot be read as coverage.
        assert!(w.contains("not a ceiling of its own"), "{w}");
        // 🔴 AND IT MUST NO LONGER SAY THE PROBE FEEDS ARE UNCHECKED. That
        // sentence was true until `probe_feed_faults` landed; a stale red is as
        // expensive as a stale green and harder to find, because nobody
        // re-tests a blocker that names a reason.
        assert!(
            !w.contains("checks the probe feeds against anything today"),
            "the exemption still advertises a residual that is closed: {w}"
        );
        // ...and it must still name the residual that is genuinely OPEN, or the
        // correction has traded a stale red for a fresh overstatement.
        assert!(w.contains("overtravel"), "{w}");
    }

    // --- the probe feeds --------------------------------------------------

    /// 🔴 THE NEGATIVE CONTROL, AND IT COMES FIRST. Every machine this crate
    /// ships and every fixture built on it runs these three numbers. A check
    /// that fires on the shipped defaults is a check that gets switched off.
    #[test]
    fn the_shipped_defaults_produce_no_probe_feed_fault_at_all() {
        let m = crate::types::Machine::default();
        assert_eq!(
            probe_feed_faults(m.probe_seek_feed, m.probe_feed, m.rapid_mm_min),
            Vec::new(),
            "the shipped machine fails its own probe-feed check"
        );
    }

    /// 🔴 THE PLANT FOR THE FIFTH DEFECT, and it is the exact number the
    /// exemption named as the gap it did not cover: a `probe_seek_feed` of
    /// 5,000mm/min emitted, on a machine declaring a 3,000mm/min rapid, with no
    /// control saying a word.
    #[test]
    fn the_named_runaway_probe_seek_is_refused_against_the_machines_own_rapid() {
        let f = probe_feed_faults(5_000.0, 25.0, 3_000.0);
        assert_eq!(
            f,
            vec![ProbeFeedFault::AboveRapidRate {
                field: "probe_seek_feed",
                value: 5_000.0,
                rapid_mm_min: 3_000.0,
            }],
            "the named 5,000mm/min seek was accepted: {f:?}"
        );
        let why = f[0].why();
        // BOTH numbers, or the operator cannot tell which declaration to change.
        assert!(why.contains("5000") && why.contains("3000"), "{why}");
        assert!(why.contains("REFUSED"), "{why}");
        // The controller behaviour is QUOTED, not asserted — this is the whole
        // reason the arm exists rather than a threshold somebody picked.
        assert!(why.contains("block->rapid_rate"), "{why}");
        // ...and the bound must not be read as a probing limit.
        assert!(why.contains("overtravel"), "{why}");
    }

    /// The attribution is CONDITIONAL, exactly as the plunge refusal's is: a
    /// rapid rate the operator plainly typed must not be excused as our
    /// unsourced 3,000.
    #[test]
    fn a_rapid_that_is_not_the_built_in_default_is_not_blamed_on_the_default() {
        let f = probe_feed_faults(5_000.0, 25.0, 4_000.0);
        let why = f[0].why();
        assert!(why.contains("5000") && why.contains("4000"), "{why}");
        assert!(
            !why.contains("built-in rapid default"),
            "a typed 4000 was excused as our 3000 default: {why}"
        );
    }

    /// The constant the message cites has to BE the default it claims to be —
    /// the same guard the plunge refusal carries, for the same reason: a derived
    /// constant quoted in prose becomes another reader's evidence.
    #[test]
    fn the_cited_built_in_rapid_is_the_actual_built_in_rapid() {
        assert_eq!(
            BUILT_IN_RAPID_MM_MIN,
            crate::types::Machine::default().rapid_mm_min,
            "the probe-feed refusal cites a rapid that is no longer the default"
        );
    }

    /// 🔴 THE CHECK THAT NEEDS NO NUMBER FROM ANYWHERE. Two passes exist because
    /// the reading is taken on the second one; a re-probe that is not slower
    /// than the seek makes the second pass decoration and the datum a guess.
    #[test]
    fn a_reprobe_that_is_not_slower_than_the_seek_is_refused() {
        for (seek, slow) in [(200.0, 200.0), (200.0, 300.0), (25.0, 25.0)] {
            let f = probe_feed_faults(seek, slow, 6_000.0);
            assert!(
                f.contains(&ProbeFeedFault::SlowPassNotSlower {
                    seek_mm_min: seek,
                    slow_mm_min: slow
                }),
                "seek {seek} / re-probe {slow} was accepted: {f:?}"
            );
        }
        // The negative control, and the one that proves the rule is not "refuse
        // every probe": the shipped pair is 200 / 25 and it passes.
        assert_eq!(probe_feed_faults(200.0, 25.0, 6_000.0), Vec::new());

        let why = probe_feed_faults(200.0, 200.0, 6_000.0)[0].why();
        assert!(why.contains("probe_feed") && why.contains("probe_seek_feed"), "{why}");
        assert!(why.contains("REFUSED"), "{why}");
        // It has to name the physical failure, or the next reader relaxes it.
        assert!(why.contains("FALSE DATUM"), "{why}");
    }

    /// 🔴 A ZERO AND A NEGATIVE ARE DIFFERENT FAULTS AT THE CONTROLLER, and the
    /// zero is the dangerous one precisely because it is NOT rejected. Two
    /// sentences, and they must not read alike.
    #[test]
    fn a_probe_feed_that_is_not_a_feed_is_refused_and_zero_reads_differently_from_negative() {
        let zero = probe_feed_faults(0.0, 25.0, 3_000.0);
        assert_eq!(zero, vec![ProbeFeedFault::NotAFeed { field: "probe_seek_feed", value: 0.0 }]);
        let z = zero[0].why();
        assert!(z.contains("MINIMUM_FEED_RATE"), "the zero case must say what actually runs: {z}");
        assert!(z.contains("does NOT reject"), "{z}");

        let neg = probe_feed_faults(200.0, -5.0, 3_000.0);
        assert_eq!(neg, vec![ProbeFeedFault::NotAFeed { field: "probe_feed", value: -5.0 }]);
        let n = neg[0].why();
        assert!(n.contains("Status_NegativeValue"), "{n}");
        assert!(!n.contains("MINIMUM_FEED_RATE"), "the negative case borrowed the zero's story: {n}");

        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let f = probe_feed_faults(bad, 25.0, 3_000.0);
            assert_eq!(f.len(), 1, "{bad} produced {f:?}");
            assert!(f[0].why().contains("not a number"), "{}", f[0].why());
        }
    }

    /// A number that is not a number suppresses the DERIVED complaints about it.
    /// `NaN >= NaN` is false and `-5 > 3000` is false, so a naive implementation
    /// would look right here by luck — this asserts the intent, not the luck.
    #[test]
    fn a_value_that_is_not_a_feed_suppresses_the_comparisons_built_on_it() {
        // Both bad: two faults, and NOT a third about their ordering.
        let both = probe_feed_faults(0.0, 0.0, 3_000.0);
        assert_eq!(both.len(), 2, "{both:?}");
        assert!(
            both.iter().all(|f| matches!(f, ProbeFeedFault::NotAFeed { .. })),
            "a comparison was derived from a value that is not a feed: {both:?}"
        );
        // A slow pass of 0 would ALSO be "not slower than" nothing and would
        // ALSO be under any rapid — one defect, one sentence.
        let one = probe_feed_faults(200.0, 0.0, 100.0);
        assert_eq!(one.len(), 1, "{one:?}");
    }

    /// An undeclared rapid is NO rapid, not a rapid of zero — the same reading
    /// `resolve_feed` and `plunge_feed` give an absent ceiling. Refusing every
    /// probe on a machine that simply did not fill the field in would be a false
    /// red on the commonest configuration there is.
    #[test]
    fn an_undeclared_rapid_bounds_nothing() {
        for rapid in [0.0, -1.0, f64::NAN] {
            assert_eq!(
                probe_feed_faults(5_000.0, 25.0, rapid),
                Vec::new(),
                "an undeclared rapid ({rapid}) was read as a ceiling of zero"
            );
        }
    }

    /// 🔴 THE PROPERTY, NOT THE EXAMPLES ABOVE. Over a spread of feeds and
    /// rapids: an empty verdict implies every fact the arms are supposed to
    /// guarantee, in both directions.
    #[test]
    fn an_empty_probe_feed_verdict_implies_every_property_it_claims() {
        let feeds = [-5.0, 0.0, 1.0, 25.0, 200.0, 3_000.0, 5_000.0, f64::NAN];
        let rapids = [0.0, 100.0, 3_000.0, 6_000.0];
        let mut clean = 0;
        let mut faulted = 0;
        for seek in feeds {
            for slow in feeds {
                for rapid in rapids {
                    let f = probe_feed_faults(seek, slow, rapid);
                    if f.is_empty() {
                        clean += 1;
                        assert!(seek.is_finite() && seek > 0.0, "seek {seek} passed");
                        assert!(slow.is_finite() && slow > 0.0, "slow {slow} passed");
                        assert!(slow < seek, "re-probe {slow} >= seek {seek} passed");
                        if rapid > 0.0 {
                            assert!(seek <= rapid, "seek {seek} > rapid {rapid} passed");
                            assert!(slow <= rapid, "slow {slow} > rapid {rapid} passed");
                        }
                    } else {
                        faulted += 1;
                        // Every fault carries a sentence an operator can act on.
                        for x in &f {
                            assert!(!x.why().is_empty());
                        }
                    }
                }
            }
        }
        // ...and the corpus reached BOTH outcomes. A property test that never
        // sees a clean case, or never sees a fault, is a green nobody earned.
        assert!(clean > 0 && faulted > 0, "clean {clean}, faulted {faulted}");
    }

    /// 🔴 The structural guarantee, asserted rather than trusted to review: no
    /// arm of `PinnedFeed` hands back a runnable number that differs from the
    /// one that was typed. This is what makes `pinned_feed` impossible to wire
    /// as a clamp.
    #[test]
    fn no_arm_of_the_pinned_verdict_can_return_a_reduced_feed() {
        for pinned in [0.0, 1.0, 800.0, 900.0, 901.0, 20_000.0] {
            for ceiling in [0.0, 900.0, 6_000.0] {
                match pinned_feed(pinned, ceiling) {
                    PinnedFeed::Runnable { feed_mm_min } => assert_eq!(
                        feed_mm_min, pinned,
                        "a runnable pinned feed came back changed: {pinned} -> {feed_mm_min}"
                    ),
                    PinnedFeed::AboveCeiling { pinned_mm_min, .. } => {
                        assert_eq!(pinned_mm_min, pinned)
                    }
                }
            }
        }
    }
}
