//! twobee-fdm: FDM slicing core. One module per lane; see `fdm/README.md` for the ownership table.
//! Shared data types live in `types`; every other module is a set of pure functions over them.
pub mod types;
pub mod config;   // lane 1: Orca CONFIG_BLOCK + preset JSON -> Config
pub mod mesh;     // lane 1: STL parse, placement
pub mod slice;    // lane 1: mesh -> layers
pub mod elfoot;   // elephant foot compensation (Orca slice_volumes)
pub mod geom;     // lane 1: boolean / offset / hatch over types::Polys (i_overlay)
pub mod walls;    // lane 2: classic walls, gap fill, thin walls
pub mod arachne;  // lane 2: variable-width walls
pub mod surfaces; // lane 3: top/bottom/solid/bridge/overhang classification
pub mod effects;  // lane 7: ironing, fuzzy skin, spiral vase, surface patterns
pub mod infill;   // lane 4: sparse infill patterns + connections
pub mod supports; // lane 6: normal/tree supports, raft
pub mod motion;   // lane 5: seam, travel, retraction, skirt/brim, machine G-code, time
pub mod gcode;    // lane 5: path list -> G-code text
pub mod gcode_parse; // lane 8: G-code text -> per-feature statistics
pub mod parity;   // lane 8: compare two statistics sets
pub mod pipeline; // lead: wires the lanes together
pub mod arrange;  // M4a: Orca arrange port for multi-object jobs
pub mod preflight; // lane 9: pre-print report (what the user must know / set up)
pub mod improve;   // lane 9: opt-in improvements over the Orca-parity path (autoconfig, path optimisation, orientation)
pub mod quality;  // lane 11: BETTER/SAME/WORSE proof machinery vs Orca (see DIVERGENCES.md)
