//! Process technology — the seam a second process arrives through.
//!
//! # Why this exists before there is a second technology
//!
//! Only [`Technology::Cnc`] is implemented. This module is here anyway, because
//! the alternative is worse: if the CNC assumptions stay implicit, adding
//! additive later means finding every place that quietly assumed a spindle, and
//! those places are invisible to grep precisely because they never ask.
//!
//! The OrcaSlicer fork learned this from the other side. Its `PrinterTechnology`
//! enum was intact and SLA was a working existence proof, so `ptCNC` had a
//! shape to follow — and the fork's own notes still warn that the ~113 sites
//! which *branch* on technology are the floor, not the estimate: "the dangerous
//! ones don't ask".
//!
//! So the rule here is: **anything that is true of subtractive machining and
//! not of every process is asked for through this enum, not assumed.** Today
//! every answer is the CNC one. That is fine. What matters is that the question
//! is being asked at all, and that [`crate::post::Post`] makes a second answer
//! a new file rather than a rewrite.

/// A fabrication process.
///
/// ⚠ **Append, never renumber or reorder.** These values are serialised into
/// saved jobs, and a reordered enum silently re-labels every stored job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Technology {
    /// Subtractive machining. The only implemented technology.
    Cnc,
    /// Fused deposition. **Declared, not implemented** — see `README.md`
    /// "Scope". Every method below returns the additive answer so the seam can
    /// be exercised and tested; nothing generates an FDM toolpath.
    Fdm,
}

impl Technology {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cnc => "CNC",
            Self::Fdm => "FDM",
        }
    }

    pub fn implemented(self) -> bool {
        matches!(self, Self::Cnc)
    }

    /// Does the process remove material from a workpiece that already exists?
    ///
    /// This is the question behind most of the CNC-only checks: workpiece depth,
    /// spoilboard clearance, tabs, work holding, tool-radius compensation. None
    /// of them mean anything for a process that builds material up.
    pub fn is_subtractive(self) -> bool {
        matches!(self, Self::Cnc)
    }

    /// Is there a rotating cutter whose speed and direction matter?
    pub fn uses_spindle(self) -> bool {
        matches!(self, Self::Cnc)
    }

    /// Is material pushed through a nozzle, with an axis to track it?
    pub fn uses_extruder(self) -> bool {
        matches!(self, Self::Fdm)
    }

    /// Are heaters part of the process?
    pub fn uses_heaters(self) -> bool {
        matches!(self, Self::Fdm)
    }

    /// Words that must NOT appear in this technology's output.
    ///
    /// 🔴 The ban is SCOPED, not global. Gate G2 bans extruder words because an
    /// FFF word in a CNC program is a command the controller may obey — but the
    /// fix when additive arrives is to ask the technology, never to delete the
    /// ban. A global list would have to be emptied to make room for the second
    /// process, and emptying it removes the protection from the first.
    ///
    /// Returned as `(regex-ish token, why it is banned)` so a gate can report
    /// the reason rather than just the match.
    pub fn banned_output(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Cnc => &[
                (r"\bE-?\d", "extruder E word"),
                (r"\bM10[4-9]\b", "temperature M-code"),
                (r"\bM14[01]\b", "bed temperature"),
                (r"\bM10[6-7]\b", "part-cooling fan"),
                (r"\bG4[12]\b", "cutter comp — absent from grblHAL core"),
                (r"\bT\d+\s*M6\b", "automatic tool change — this machine has none"),
            ],
            Self::Fdm => &[
                (r"\bM3\b", "spindle start has no meaning on an extruder"),
                (r"\bG8[123]\b", "canned drill cycle"),
                (r"\bG4[12]\b", "cutter compensation"),
            ],
        }
    }

    /// Codes this technology's output is expected to contain.
    pub fn required_output(self) -> &'static [&'static str] {
        match self {
            Self::Cnc => &["G17", "G21", "G90", "G54", "G94", "G40"],
            Self::Fdm => &["G21", "G90"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cnc_is_implemented_and_says_so() {
        // 🔴 The one claim this module must never get wrong. A technology that
        // reports itself implemented while nothing generates its toolpaths is a
        // green that means "unchecked".
        assert!(Technology::Cnc.implemented());
        assert!(!Technology::Fdm.implemented());
    }

    #[test]
    fn the_two_technologies_disagree_about_the_machine() {
        // If these ever returned the same answers the enum would be decoration.
        assert!(Technology::Cnc.uses_spindle() && !Technology::Fdm.uses_spindle());
        assert!(Technology::Fdm.uses_extruder() && !Technology::Cnc.uses_extruder());
        assert!(Technology::Cnc.is_subtractive() && !Technology::Fdm.is_subtractive());
        assert!(Technology::Fdm.uses_heaters() && !Technology::Cnc.uses_heaters());
    }

    #[test]
    fn each_technology_bans_the_other_ones_words() {
        // The property that makes the ban survivable when a second process
        // arrives: CNC bans extruder words, FDM bans spindle words. Neither list
        // has to be emptied to make room for the other.
        let cnc: Vec<&str> = Technology::Cnc.banned_output().iter().map(|(w, _)| *w).collect();
        let fdm: Vec<&str> = Technology::Fdm.banned_output().iter().map(|(w, _)| *w).collect();
        assert!(cnc.iter().any(|w| w.contains("E-?")), "CNC does not ban the E word");
        assert!(fdm.iter().any(|w| w.contains("M3")), "FDM does not ban the spindle");
        assert!(!cnc.is_empty() && !fdm.is_empty());
    }

    #[test]
    fn every_banned_word_carries_its_reason() {
        // A gate that can only say "banned word found" sends the reader to grep.
        for t in [Technology::Cnc, Technology::Fdm] {
            for (w, why) in t.banned_output() {
                assert!(!w.is_empty() && why.len() > 5, "{} has a bare ban: {w}", t.as_str());
            }
        }
    }
}
