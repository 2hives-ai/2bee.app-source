//! Part marking — a single-stroke font and the toolpaths that cut it.
//!
//! # Why this is not cosmetic
//!
//! A hive cut-pack is 36 near-identical plywood blanks. Once they are off the
//! machine and in a stack, an unmarked panel is indistinguishable from three
//! others that differ by a 6 mm rebate. The schools module makes this worse, not
//! better: students sort the parts.
//!
//! Marking is therefore an OPERATION with a depth and a feed, not a label — and
//! it is cut with the same tool-radius reasoning as everything else. A
//! single-stroke ("engraving") font is used because the tool centre follows the
//! stroke directly: an outline font would need the glyph offset by the tool
//! radius, and at these sizes that closes every counter in the letter.

use crate::geometry::{Contour, Vertex};

/// Strokes for one glyph in a unit box: `(x0, y0, x1, y1)`, each 0.0..1.0.
type Strokes = &'static [(f64, f64, f64, f64)];

/// Single-stroke glyphs. Uppercase, digits, and the few marks a part ID needs.
///
/// Deliberately plain: this has to stay legible at 6 mm tall cut with a 3 mm
/// cutter, where any flourish closes up into a blob.
fn glyph(c: char) -> Option<Strokes> {
    Some(match c.to_ascii_uppercase() {
        '0' => &[(0.0, 0.0, 1.0, 0.0), (1.0, 0.0, 1.0, 1.0), (1.0, 1.0, 0.0, 1.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 1.0)],
        '1' => &[(0.3, 0.8, 0.5, 1.0), (0.5, 1.0, 0.5, 0.0), (0.2, 0.0, 0.8, 0.0)],
        '2' => &[(0.0, 0.8, 0.5, 1.0), (0.5, 1.0, 1.0, 0.8), (1.0, 0.8, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0)],
        '3' => &[(0.0, 1.0, 1.0, 1.0), (1.0, 1.0, 0.5, 0.55), (0.5, 0.55, 1.0, 0.25), (1.0, 0.25, 0.5, 0.0), (0.5, 0.0, 0.0, 0.15)],
        '4' => &[(0.75, 0.0, 0.75, 1.0), (0.75, 1.0, 0.0, 0.35), (0.0, 0.35, 1.0, 0.35)],
        '5' => &[(1.0, 1.0, 0.0, 1.0), (0.0, 1.0, 0.0, 0.55), (0.0, 0.55, 0.8, 0.55), (0.8, 0.55, 1.0, 0.3), (1.0, 0.3, 0.5, 0.0), (0.5, 0.0, 0.0, 0.15)],
        '6' => &[(1.0, 0.85, 0.5, 1.0), (0.5, 1.0, 0.0, 0.6), (0.0, 0.6, 0.0, 0.2), (0.0, 0.2, 0.5, 0.0), (0.5, 0.0, 1.0, 0.2), (1.0, 0.2, 1.0, 0.45), (1.0, 0.45, 0.0, 0.5)],
        '7' => &[(0.0, 1.0, 1.0, 1.0), (1.0, 1.0, 0.35, 0.0)],
        '8' => &[(0.5, 0.55, 0.0, 0.78), (0.0, 0.78, 0.5, 1.0), (0.5, 1.0, 1.0, 0.78), (1.0, 0.78, 0.5, 0.55), (0.5, 0.55, 0.0, 0.25), (0.0, 0.25, 0.5, 0.0), (0.5, 0.0, 1.0, 0.25), (1.0, 0.25, 0.5, 0.55)],
        '9' => &[(0.0, 0.15, 0.5, 0.0), (0.5, 0.0, 1.0, 0.4), (1.0, 0.4, 1.0, 0.8), (1.0, 0.8, 0.5, 1.0), (0.5, 1.0, 0.0, 0.8), (0.0, 0.8, 0.0, 0.55), (0.0, 0.55, 1.0, 0.5)],
        'A' => &[(0.0, 0.0, 0.5, 1.0), (0.5, 1.0, 1.0, 0.0), (0.18, 0.35, 0.82, 0.35)],
        'B' => &[(0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 0.75, 1.0), (0.75, 1.0, 1.0, 0.78), (1.0, 0.78, 0.0, 0.55), (0.0, 0.55, 1.0, 0.25), (1.0, 0.25, 0.75, 0.0), (0.75, 0.0, 0.0, 0.0)],
        'C' => &[(1.0, 0.85, 0.6, 1.0), (0.6, 1.0, 0.0, 0.7), (0.0, 0.7, 0.0, 0.3), (0.0, 0.3, 0.6, 0.0), (0.6, 0.0, 1.0, 0.15)],
        'D' => &[(0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 0.6, 1.0), (0.6, 1.0, 1.0, 0.65), (1.0, 0.65, 1.0, 0.35), (1.0, 0.35, 0.6, 0.0), (0.6, 0.0, 0.0, 0.0)],
        'E' => &[(1.0, 1.0, 0.0, 1.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, 0.52, 0.75, 0.52)],
        'F' => &[(1.0, 1.0, 0.0, 1.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.52, 0.75, 0.52)],
        'G' => &[(1.0, 0.85, 0.6, 1.0), (0.6, 1.0, 0.0, 0.7), (0.0, 0.7, 0.0, 0.3), (0.0, 0.3, 0.6, 0.0), (0.6, 0.0, 1.0, 0.25), (1.0, 0.25, 1.0, 0.5), (1.0, 0.5, 0.55, 0.5)],
        'H' => &[(0.0, 0.0, 0.0, 1.0), (1.0, 0.0, 1.0, 1.0), (0.0, 0.52, 1.0, 0.52)],
        'I' => &[(0.2, 1.0, 0.8, 1.0), (0.5, 1.0, 0.5, 0.0), (0.2, 0.0, 0.8, 0.0)],
        'J' => &[(1.0, 1.0, 1.0, 0.25), (1.0, 0.25, 0.6, 0.0), (0.6, 0.0, 0.15, 0.15)],
        'K' => &[(0.0, 0.0, 0.0, 1.0), (1.0, 1.0, 0.0, 0.45), (0.25, 0.58, 1.0, 0.0)],
        'L' => &[(0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0)],
        'M' => &[(0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 0.5, 0.45), (0.5, 0.45, 1.0, 1.0), (1.0, 1.0, 1.0, 0.0)],
        'N' => &[(0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 1.0, 0.0), (1.0, 0.0, 1.0, 1.0)],
        'O' => &[(0.5, 1.0, 0.0, 0.72), (0.0, 0.72, 0.0, 0.28), (0.0, 0.28, 0.5, 0.0), (0.5, 0.0, 1.0, 0.28), (1.0, 0.28, 1.0, 0.72), (1.0, 0.72, 0.5, 1.0)],
        'P' => &[(0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 0.75, 1.0), (0.75, 1.0, 1.0, 0.78), (1.0, 0.78, 0.75, 0.55), (0.75, 0.55, 0.0, 0.55)],
        'Q' => &[(0.5, 1.0, 0.0, 0.72), (0.0, 0.72, 0.0, 0.28), (0.0, 0.28, 0.5, 0.0), (0.5, 0.0, 1.0, 0.28), (1.0, 0.28, 1.0, 0.72), (1.0, 0.72, 0.5, 1.0), (0.6, 0.28, 1.0, 0.0)],
        'R' => &[(0.0, 0.0, 0.0, 1.0), (0.0, 1.0, 0.75, 1.0), (0.75, 1.0, 1.0, 0.78), (1.0, 0.78, 0.75, 0.55), (0.75, 0.55, 0.0, 0.55), (0.45, 0.55, 1.0, 0.0)],
        'S' => &[(1.0, 0.85, 0.5, 1.0), (0.5, 1.0, 0.0, 0.78), (0.0, 0.78, 1.0, 0.28), (1.0, 0.28, 0.5, 0.0), (0.5, 0.0, 0.0, 0.15)],
        'T' => &[(0.0, 1.0, 1.0, 1.0), (0.5, 1.0, 0.5, 0.0)],
        'U' => &[(0.0, 1.0, 0.0, 0.25), (0.0, 0.25, 0.5, 0.0), (0.5, 0.0, 1.0, 0.25), (1.0, 0.25, 1.0, 1.0)],
        'V' => &[(0.0, 1.0, 0.5, 0.0), (0.5, 0.0, 1.0, 1.0)],
        'W' => &[(0.0, 1.0, 0.25, 0.0), (0.25, 0.0, 0.5, 0.6), (0.5, 0.6, 0.75, 0.0), (0.75, 0.0, 1.0, 1.0)],
        'X' => &[(0.0, 1.0, 1.0, 0.0), (0.0, 0.0, 1.0, 1.0)],
        'Y' => &[(0.0, 1.0, 0.5, 0.5), (1.0, 1.0, 0.5, 0.5), (0.5, 0.5, 0.5, 0.0)],
        'Z' => &[(0.0, 1.0, 1.0, 1.0), (1.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0)],
        '-' => &[(0.1, 0.52, 0.9, 0.52)],
        '.' => &[(0.45, 0.0, 0.55, 0.0)],
        '/' => &[(0.0, 0.0, 1.0, 1.0)],
        ' ' => &[],
        _ => return None,
    })
}

/// Which characters can be marked. A caller that needs to know BEFORE cutting
/// (so it can rename a part rather than discover a blank on the workpiece) asks
/// here.
pub fn unsupported_chars(text: &str) -> Vec<char> {
    let mut v: Vec<char> = text.chars().filter(|c| glyph(*c).is_none()).collect();
    v.sort_unstable();
    v.dedup();
    v
}

/// Turn text into open contours, ready to be cut on-line.
///
/// `height_mm` is the cap height. Characters advance at 0.75 of the height plus
/// a 0.25 gap, which keeps a 6 mm mark readable without the letters touching.
///
/// 🔴 An unmappable character produces NOTHING for that character rather than a
/// placeholder box. A box would look like a deliberate mark and a part would be
/// mis-identified; an absence is at least visibly an absence. The caller is
/// expected to have asked `unsupported_chars` first.
pub fn text_contours(text: &str, x: f64, y: f64, height_mm: f64) -> Vec<Contour> {
    let w = height_mm * 0.75;
    let advance = w + height_mm * 0.25;
    let mut out = Vec::new();
    let mut cx = x;
    for ch in text.chars() {
        if let Some(strokes) = glyph(ch) {
            for (x0, y0, x1, y1) in strokes {
                out.push(Contour::open(vec![
                    Vertex::line(cx + x0 * w, y + y0 * height_mm),
                    Vertex::line(cx + x1 * w, y + y1 * height_mm),
                ]));
            }
        }
        cx += advance;
    }
    out
}

/// Width the text will occupy.
pub fn text_width(text: &str, height_mm: f64) -> f64 {
    let w = height_mm * 0.75;
    let advance = w + height_mm * 0.25;
    if text.is_empty() {
        0.0
    } else {
        advance * (text.chars().count() as f64 - 1.0) + w
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_and_letters_produce_strokes() {
        for ch in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars() {
            let c = text_contours(&ch.to_string(), 0.0, 0.0, 6.0);
            assert!(!c.is_empty(), "'{ch}' produced no strokes");
        }
    }

    #[test]
    fn every_stroke_stays_inside_its_own_cell() {
        // A glyph that overruns its box collides with its neighbour and the mark
        // becomes unreadable at exactly the size it is needed.
        for ch in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-./".chars() {
            for c in text_contours(&ch.to_string(), 0.0, 0.0, 6.0) {
                for v in &c.verts {
                    assert!(v.x >= -1e-9 && v.x <= 4.5 + 1e-9, "'{ch}' x={} out of cell", v.x);
                    assert!(v.y >= -1e-9 && v.y <= 6.0 + 1e-9, "'{ch}' y={} out of cell", v.y);
                }
            }
        }
    }

    #[test]
    fn an_unmappable_character_is_reported_and_marks_nothing() {
        // 🔴 A placeholder box would look like a deliberate mark and a part
        // would be mis-identified.
        assert_eq!(unsupported_chars("PANEL-1"), Vec::<char>::new());
        assert_eq!(unsupported_chars("PANEL#1"), vec!['#']);
        let c = text_contours("#", 0.0, 0.0, 6.0);
        assert!(c.is_empty(), "an unmappable character drew something");
    }

    #[test]
    fn text_advances_and_the_width_matches_what_was_drawn() {
        let t = "AB";
        let cs = text_contours(t, 10.0, 20.0, 6.0);
        let maxx = cs
            .iter()
            .flat_map(|c| c.verts.iter())
            .map(|v| v.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let minx = cs
            .iter()
            .flat_map(|c| c.verts.iter())
            .map(|v| v.x)
            .fold(f64::INFINITY, f64::min);
        assert!((minx - 10.0).abs() < 1e-9);
        assert!(
            (maxx - minx - text_width(t, 6.0)).abs() < 1e-6,
            "drawn width {} against reported {}",
            maxx - minx,
            text_width(t, 6.0)
        );
    }

    #[test]
    fn a_space_advances_without_marking() {
        let a = text_contours("A A", 0.0, 0.0, 6.0);
        let b = text_contours("AA", 0.0, 0.0, 6.0);
        assert_eq!(a.len(), b.len(), "the space drew strokes");
        let wa = text_width("A A", 6.0);
        let wb = text_width("AA", 6.0);
        assert!(wa > wb, "the space did not advance");
    }
}
