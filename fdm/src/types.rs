//! Shared types. Millimetres and f64 everywhere (same convention as twobee-cam). Lanes may ADD
//! helper methods in their own module via extension traits but must not change these definitions;
//! ask the lead (ticket/message) if a field is missing.

/// A closed ring, counter-clockwise for outer contours and clockwise for holes. No repeated closing point.
pub type Ring = Vec<[f64; 2]>;

/// One filled region: an outer contour plus holes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Poly {
    pub contour: Ring,
    pub holes: Vec<Ring>,
}
/// A set of disjoint filled regions (an "ExPolygons" in libslic3r terms).
pub type Polys = Vec<Poly>;

/// Orca's `; FEATURE:` names (the strings Orca writes into its G-code), the contract for comparison.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Feature {
    OuterWall, InnerWall, OverhangWall, SparseInfill, InternalSolidInfill, TopSurface, BottomSurface,
    InternalBridge, Bridge, GapInfill, Skirt, Brim, Support, SupportInterface, SupportTransition,
    Ironing, PrimeTower, Custom,
}
impl Feature {
    pub fn orca_name(self) -> &'static str {
        match self {
            Feature::OuterWall => "Outer wall", Feature::InnerWall => "Inner wall", Feature::OverhangWall => "Overhang wall",
            Feature::SparseInfill => "Sparse infill", Feature::InternalSolidInfill => "Internal solid infill",
            Feature::TopSurface => "Top surface", Feature::BottomSurface => "Bottom surface",
            Feature::InternalBridge => "Internal Bridge", Feature::Bridge => "Bridge", Feature::GapInfill => "Gap infill",
            Feature::Skirt => "Skirt", Feature::Brim => "Brim", Feature::Support => "Support",
            Feature::SupportInterface => "Support interface", Feature::SupportTransition => "Support transition",
            Feature::Ironing => "Ironing", Feature::PrimeTower => "Prime tower", Feature::Custom => "Custom",
        }
    }
}

/// One sliced layer. `z` is the TOP of the layer; the slice plane was at `z - h/2`.
#[derive(Clone, Debug, Default)]
pub struct Layer {
    pub index: usize,
    pub z: f64,
    pub h: f64,
    pub region: Polys,
}

/// A point on an extrusion path with its own bead width (constant for classic walls, varying for Arachne).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PathPt { pub x: f64, pub y: f64, pub w: f64 }

/// One continuous extrusion (or, with `travel_only`, a move). Lanes produce these; `gcode` consumes them.
#[derive(Clone, Debug)]
pub struct ExtPath {
    pub feature: Feature,
    pub pts: Vec<PathPt>,
    pub closed: bool,
    pub layer_h: f64,
    /// mm/s requested for this path; 0.0 = let the motion lane pick from the config by feature.
    pub speed: f64,
    /// Mark an extrusion as a bridge/overhang so the motion lane can apply fan/speed rules.
    pub flow_ratio: f64,
}

/// Everything produced for one layer, in print order.
#[derive(Clone, Debug, Default)]
pub struct LayerPlan { pub z: f64, pub h: f64, pub paths: Vec<ExtPath> }

/// Errors: refuse, never approximate silently (same rule as twobee-cam).
#[derive(Debug)]
pub enum FdmError { Parse(String), Unsupported(String), Geometry(String) }
impl std::fmt::Display for FdmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { FdmError::Parse(s) => write!(f, "parse: {s}"), FdmError::Unsupported(s) => write!(f, "unsupported: {s}"), FdmError::Geometry(s) => write!(f, "geometry: {s}") }
    }
}
impl std::error::Error for FdmError {}
