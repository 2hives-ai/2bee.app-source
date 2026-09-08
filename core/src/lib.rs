//! 2bee.app CAM core — 2.5D subtractive machining.
//!
//! Copyright (C) 2026 2BEE FARM PTY LTD.
//! Licensed under the GNU Affero General Public License v3 or later.
//! Portions derived from the 2bee CNC fork of OrcaSlicer (AGPL-3.0), itself
//! derived from PrusaSlicer/Slic3r.
//!
//! # Shape of this crate
//!
//! ```text
//!   geometry  ->  toolpath (controller-agnostic)  ->  post  ->  dialect G-code
//! ```
//!
//! Nothing in [`types`] may assume a controller. Everything controller-specific
//! lives in a post module, so a second dialect is a new file and not a rewrite.
//!
//! The same crate compiles native (for the gate harness and the CLI) and to
//! `wasm32-unknown-unknown` (for the browser worker). **They must be the same
//! code**: a gate that exercises a different build than the product ships is
//! not a gate.

pub mod drill;
pub mod engrave;
pub mod feeds;
pub mod fixtures;
pub mod fixture;
pub mod geometry;
pub mod import;
pub mod job;
pub mod layout;
pub mod mesh;
pub mod optimise;
pub mod placement;
pub mod pocket;
pub mod post;
pub mod post_grblhal;
pub mod recommend;
pub mod rect_profile;
pub mod sim;
pub mod spoilboards;
pub mod tech;
pub mod toolpath;
pub mod tools;
pub mod types;

pub use feeds::{
    chip_verdict, chipload_from_feed, chipload_in_window, feed_from_chipload, pinned_feed,
    resolve_feed, ChipVerdict, FeedResolution, PinnedFeed,
};
pub use post_grblhal::{
    check_emitted_z_ceiling, check_machine_limits, post_grblhal, PostOptions, PostResult,
};
pub use types::*;

/// Semantic version of the G-code contract this core emits.
///
/// Bump when the emitted dialect changes in a way that a golden file would
/// notice. The gate prints it, so a golden-file mismatch names its own cause.
pub const GCODE_CONTRACT_VERSION: &str = "1.0.0";

/// Fingerprint of the SOURCE this core was compiled from — 12 hex chars.
///
/// Computed by `build.rs` over the contents of every `.rs` file under
/// `core/src`, and re-computed whenever any of them changes. Both hosts export
/// it (`2bee-slice buildid` and the wasm's `build_id()`), and **gate K3 asserts
/// they are equal**.
///
/// 🔴 It exists because gate I1 cannot see a STALE WASM. I1 compares one
/// program's bytes across the two hosts; two hosts running the same OLD core
/// agree perfectly. This constant is the thing that differs when one of them was
/// not rebuilt — it is a currency check, not a parity check, and they are
/// different questions.
///
/// It is NOT a version. Do not print it as one, do not put it in a filename,
/// and do not compare it across machines expecting a match to mean anything more
/// than "the same `core/src` bytes went in".
pub const BUILD_ID: &str = env!("TWOBEE_CORE_BUILD_ID");
