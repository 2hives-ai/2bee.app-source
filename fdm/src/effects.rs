//! Lane 7: surface effects. Every module here is a set of pure functions over `types`; the pipeline owns
//! the per-layer state (region classification, previous-layer outlines, seam choice) and calls them.
//!
//! * [`patterns`]  top / bottom / solid surface fills as Orca's Fill classes make them: `monotonic`,
//!   `monotonicline`, `rectilinear`, `alignedrectilinear`, `concentric`, `hilbertcurve`, `archimedeanchords`,
//!   `octagramspiral`. Entry points: [`patterns::fill_surface`] (full control) and [`patterns::surface_pattern`]
//!   (`region, angle, spacing, pattern -> polylines`). `rect` (crate-private) is the shared rectilinear/monotonic core
//!   (port of `FillRectilinear::fill_surface_by_lines`).
//! * [`ironing`]   `Layer::make_ironing`: areas to iron + the monotonic/concentric fill, as `Feature::Ironing` paths.
//! * [`fuzzy`]     fuzzy skin (classic/perlin/billow/ridgedmulti/voronoi/ripple noise, displacement/extrusion/combined).
//! * [`spiral`]    spiral vase (`SpiralVase::process_layer` on the wall loop: Z ramp, start/finish flow ramp, smoothing).
//! * [`wallpost`]  wall_sequence ordering (incl. inner-outer-inner), first-layer/topmost one-wall rules,
//!                 inner-wall cut-out under the top fill, wall_direction / overhang_reverse, thin-wall helpers.
//! * [`overhang`]  slowdown for overhangs: per-point speed profile of a wall against the previous layer outline.
//!
//! Coordinates: millimetres, f64, the OBJECT frame (Orca slices around the object bbox centre; the rotation
//! origin and the pattern reference point of the fills are that centre). Geometry kernel: `crate::geom`.
pub mod adapter;
pub mod fuzzy;
pub mod ironing;
pub mod overhang;
pub mod patterns;
pub(crate) mod rect;
pub mod spiral;
pub mod wallpost;
