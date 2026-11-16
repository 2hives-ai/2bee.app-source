//! libslic3r `Flow` for the surfaces lane (Flow.cpp / Flow.hpp, LayerRegion::bridging_flow).
use std::f64::consts::PI;

/// Extra spacing between bridge threads, mm (BRIDGE_EXTRA_SPACING).
pub const BRIDGE_EXTRA_SPACING: f64 = 0.05;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Flow {
    pub width: f64,
    pub height: f64,
    pub spacing: f64,
    /// Round thread (bridge) instead of a rounded rectangle.
    pub bridge: bool,
}

/// Spacing of a rounded rectangle bead: w - h (1 - pi/4).
pub fn rect_spacing(w: f64, h: f64) -> f64 { w - h * (1.0 - 0.25 * PI) }

impl Flow {
    pub fn rect(width: f64, height: f64) -> Flow { Flow { width, height, spacing: rect_spacing(width, height), bridge: false } }
    /// Bridging thread of diameter `d`.
    pub fn bridging(d: f64) -> Flow { Flow { width: d, height: d, spacing: d + BRIDGE_EXTRA_SPACING, bridge: true } }
    /// Cross-section (mm^2) = extruded volume per mm of path.
    pub fn mm3_per_mm(&self) -> f64 {
        if self.bridge { self.width * self.width * 0.25 * PI } else { self.height * (self.width - self.height * (1.0 - 0.25 * PI)) }
    }
    /// Same flow with another line spacing (Flow::with_spacing): the width follows.
    pub fn with_spacing(&self, new_spacing: f64) -> Flow {
        let mut o = *self;
        if self.bridge {
            let gap = self.spacing - self.width;
            let d = new_spacing - gap;
            o.width = d;
            o.height = d;
        } else {
            o.width += new_spacing - self.spacing;
        }
        o.spacing = new_spacing;
        o
    }
    /// Flow::with_cross_section for a rounded-rectangle bead (area in mm^2).
    pub fn with_cross_section(&self, area_new: f64) -> Flow {
        let area = self.mm3_per_mm();
        let eps = 1e-4;
        if area_new > area + eps {
            let new_full_spacing = area_new / self.height;
            if new_full_spacing > self.spacing {
                let height = area_new / self.spacing;
                Flow { width: self.spacing + height * (1.0 - 0.25 * PI), height, spacing: self.spacing, bridge: false }
            } else {
                let w = (area / self.height) + self.height * (1.0 - 0.25 * PI);
                Flow { width: w, height: self.height, spacing: rect_spacing(w, self.height), bridge: false }
            }
        } else if area_new < area - eps {
            let width_new = self.width - (area - area_new) / self.height;
            if width_new > self.height {
                Flow { width: width_new, height: self.height, spacing: rect_spacing(width_new, self.height), bridge: false }
            } else {
                let d = (area_new / PI).sqrt();
                Flow { width: d, height: d, spacing: self.spacing, bridge: false }
            }
        } else { *self }
    }
    pub fn with_flow_ratio(&self, ratio: f64) -> Flow {
        if (ratio - 1.0).abs() < 1e-12 { *self } else { self.with_cross_section(self.mm3_per_mm() * ratio) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spacing_and_area() {
        let f = Flow::rect(0.42, 0.2);
        assert!((f.spacing - (0.42 - 0.2 * (1.0 - PI / 4.0))).abs() < 1e-12);
        assert!((f.mm3_per_mm() - 0.2 * f.spacing).abs() < 1e-12);
        let b = Flow::bridging(0.4);
        assert!((b.spacing - 0.45).abs() < 1e-12);
        assert!((b.mm3_per_mm() - PI * 0.04).abs() < 1e-12);
    }
    #[test]
    fn with_spacing_moves_width() {
        let f = Flow::rect(0.42, 0.2);
        let g = f.with_spacing(f.spacing + 0.01);
        assert!((g.width - 0.43).abs() < 1e-12);
    }
}
