//! Geometry intake — DXF, SVG, and STL as a Z-section.
//!
//! # The rule this module is built around
//!
//! 🔴 **An entity this parser does not understand is REPORTED, never skipped.**
//! A dropped entity is a part cut without a feature: the outline is right, the
//! program looks right, and the hole is simply not there. That is precisely the
//! documented failure of `build_nest.py`, and it is silent by construction —
//! nothing downstream can notice a feature that was never mentioned.
//!
//! So every parse returns both the contours it built AND a list of what it
//! could not handle, and the caller is made to look at the second list.

use std::collections::HashMap;

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use crate::geometry::{Contour, Part, Vertex};

/// Embedded Noto Sans font (OFL-1.1 license). Used to render DXF TEXT/MTEXT
/// entities into vector outlines. 512KB, acceptable for a CAM tool.
static FONT_BYTES: &[u8] = include_bytes!("../assets/noto-sans.ttf");

/// Render a text string into closed contour pieces.
///
/// Each character becomes one or more closed contours (the glyph outlines),
/// positioned at the text's insertion point, scaled to `height_mm`, and
/// rotated by `rotation_deg` (counter-clockwise, DXF convention).
///
/// Returns an empty Vec if the font cannot be loaded or the string is empty.
fn render_text_outlines(
    text: &str,
    x: f64,
    y: f64,
    height_mm: f64,
    rotation_deg: f64,
) -> Vec<Piece> {
    let font = match FontRef::try_from_slice(FONT_BYTES) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let scale = PxScale::from(height_mm as f32);
    let scaled = font.as_scaled(scale);
    let angle = rotation_deg.to_radians();
    let cos_a = angle.cos() as f64;
    let sin_a = angle.sin() as f64;

    let mut pieces = Vec::new();
    let mut cursor_x = 0.0_f64;

    for ch in text.chars() {
        if ch == '\n' || ch == '\r' {
            cursor_x = 0.0;
            continue;
        }
        let glyph_id = font.glyph_id(ch);
        if glyph_id == font.glyph_id('\0') {
            // Missing glyph — advance by a space width
            cursor_x += height_mm * 0.5;
            continue;
        }

        // Get the glyph outline (unscaled — we scale manually via transform)
        if let Some(outline) = font.outline(glyph_id) {
            let contours = outline_to_pieces(&outline.curves, x, y, cursor_x, 0.0, cos_a, sin_a);
            pieces.extend(contours);
        }

        // Advance cursor
        cursor_x += scaled.h_advance(glyph_id) as f64;
    }

    pieces
}

/// Convert ab_glyph outline curves into closed contour Pieces.
///
/// ab_glyph stores curves as a flat `Vec<OutlineCurve>` where each curve
/// includes both endpoints. Contour boundaries are detected by discontinuities
/// between consecutive curve endpoints.
fn outline_to_pieces(
    curves: &[ab_glyph::OutlineCurve],
    origin_x: f64,
    origin_y: f64,
    offset_x: f64,
    offset_y: f64,
    cos_a: f64,
    sin_a: f64,
) -> Vec<Piece> {
    let mut pieces = Vec::new();
    let mut current_verts: Vec<Vertex> = Vec::new();
    let mut last_end: Option<(f64, f64)> = None;

    for curve in curves {
        let (start, end, mid_points) = match curve {
            ab_glyph::OutlineCurve::Line(p0, p1) => {
                ((p0.x as f64, p0.y as f64), (p1.x as f64, p1.y as f64), vec![])
            }
            ab_glyph::OutlineCurve::Quad(p0, p1, p2) => {
                ((p0.x as f64, p0.y as f64), (p2.x as f64, p2.y as f64),
                 vec![(p1.x as f64, p1.y as f64)])
            }
            ab_glyph::OutlineCurve::Cubic(p0, p1, p2, p3) => {
                ((p0.x as f64, p0.y as f64), (p3.x as f64, p3.y as f64),
                 vec![(p1.x as f64, p1.y as f64), (p2.x as f64, p2.y as f64)])
            }
        };

        // Detect contour boundary: if start doesn't match previous end, start new contour
        let discontinuity = match last_end {
            Some((lx, ly)) => (start.0 - lx).abs() > 0.01 || (start.1 - ly).abs() > 0.01,
            None => true,
        };
        if discontinuity && !current_verts.is_empty() {
            close_contour(&mut current_verts, &mut pieces);
        }

        // Add start point if this is the first curve in a contour
        if current_verts.is_empty() {
            let (rx, ry) = transform_glyph_pt(start.0, start.1, origin_x, origin_y, offset_x, offset_y, cos_a, sin_a);
            current_verts.push(Vertex::line(rx, ry));
        }

        // Flatten curves to line segments
        if mid_points.is_empty() {
            // Line
            let (rx, ry) = transform_glyph_pt(end.0, end.1, origin_x, origin_y, offset_x, offset_y, cos_a, sin_a);
            current_verts.push(Vertex::line(rx, ry));
        } else if mid_points.len() == 1 {
            // Quadratic Bézier
            let (sx, sy) = start;
            let (cx, cy) = mid_points[0];
            let (ex, ey) = end;
            for i in 1..=8 {
                let t = i as f64 / 8.0;
                let t1 = 1.0 - t;
                let gx = t1*t1*sx + 2.0*t1*t*cx + t*t*ex;
                let gy = t1*t1*sy + 2.0*t1*t*cy + t*t*ey;
                let (rx, ry) = transform_glyph_pt(gx, gy, origin_x, origin_y, offset_x, offset_y, cos_a, sin_a);
                current_verts.push(Vertex::line(rx, ry));
            }
        } else {
            // Cubic Bézier
            let (sx, sy) = start;
            let (c1x, c1y) = mid_points[0];
            let (c2x, c2y) = mid_points[1];
            let (ex, ey) = end;
            for i in 1..=8 {
                let t = i as f64 / 8.0;
                let t1 = 1.0 - t;
                let gx = t1*t1*t1*sx + 3.0*t1*t1*t*c1x + 3.0*t1*t*t*c2x + t*t*t*ex;
                let gy = t1*t1*t1*sy + 3.0*t1*t1*t*c1y + 3.0*t1*t*t*c2y + t*t*t*ey;
                let (rx, ry) = transform_glyph_pt(gx, gy, origin_x, origin_y, offset_x, offset_y, cos_a, sin_a);
                current_verts.push(Vertex::line(rx, ry));
            }
        }

        last_end = Some(end);
    }

    // Close the last contour
    if !current_verts.is_empty() {
        close_contour(&mut current_verts, &mut pieces);
    }

    pieces
}

/// Close a contour and add it to pieces if it has enough vertices.
fn close_contour(verts: &mut Vec<Vertex>, pieces: &mut Vec<Piece>) {
    if verts.len() >= 3 {
        // Close the contour by matching the last point to the first
        let first = verts[0];
        let last = verts[verts.len() - 1];
        if (first.x - last.x).abs() > 0.01 || (first.y - last.y).abs() > 0.01 {
            verts.push(Vertex::line(first.x, first.y));
        }
        pieces.push(Piece { verts: std::mem::take(verts), closed: true });
    } else {
        verts.clear();
    }
}

/// Transform a glyph point from glyph space to world space.
///
/// ab_glyph: Y-down (positive Y = below baseline).
/// DXF: Y-up. We flip Y and apply rotation + translation.
fn transform_glyph_pt(
    gx: f64,
    gy: f64,
    origin_x: f64,
    origin_y: f64,
    offset_x: f64,
    offset_y: f64,
    cos_a: f64,
    sin_a: f64,
) -> (f64, f64) {
    let lx = gx + offset_x;
    let ly = -gy + offset_y; // flip Y: ab_glyph Y-down → DXF Y-up
    let rx = lx * cos_a - ly * sin_a;
    let ry = lx * sin_a + ly * cos_a;
    (origin_x + rx, origin_y + ry)
}

#[derive(Clone, Debug, Default)]
pub struct Imported {
    pub contours: Vec<Contour>,
    /// Scale applied to reach millimetres, and where it came from. Reported
    /// because a silently-assumed unit is how an inch drawing becomes a part
    /// 25.4x too small — with a perfectly plausible-looking outline.
    pub unit_note: String,
    /// Entities the parser met and could not turn into geometry. Never empty
    /// because "nothing went wrong" — empty means nothing was skipped.
    pub unsupported: Vec<String>,
    /// Contours that did not close. An unclosed outline cannot be profiled, and
    /// silently closing it invents an edge the drawing never had.
    pub open_contours: usize,
}

fn nearly(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

fn same_point(a: (f64, f64), b: (f64, f64), tol: f64) -> bool {
    nearly(a.0, b.0, tol) && nearly(a.1, b.1, tol)
}

/// A piece of geometry before chaining: a run of vertices with a start and end.
///
/// `pub(crate)` because [`crate::mesh`] produces these too — one segment per
/// triangle crossing the section plane. There is one chainer in this core and
/// every intake path goes through it; a second implementation would be a second
/// set of tolerance bugs to find.
#[derive(Clone, Debug)]
pub(crate) struct Piece {
    pub(crate) verts: Vec<Vertex>,
    pub(crate) closed: bool,
}

impl Piece {
    fn start(&self) -> (f64, f64) {
        (self.verts[0].x, self.verts[0].y)
    }
    fn end(&self) -> (f64, f64) {
        let v = self.verts[self.verts.len() - 1];
        (v.x, v.y)
    }
    fn reversed(&self) -> Piece {
        let mut c = Contour { verts: self.verts.clone(), closed: false };
        c.reverse();
        Piece { verts: c.verts, closed: self.closed }
    }
}

/// Join open pieces end-to-end into closed loops where they meet.
///
/// A DXF from a CAD package is usually a soup of separate LINE and ARC
/// entities; the loops only exist implicitly, in the coincidence of endpoints.
/// A mesh section is the same soup for the same reason — one loose segment per
/// triangle that crossed the plane — so [`crate::mesh`] calls this and does not
/// grow its own.
pub(crate) fn chain(pieces: Vec<Piece>, tol: f64) -> (Vec<Contour>, usize) {
    let mut out = Vec::new();
    let mut open_count = 0;
    let mut pool: Vec<Piece> = Vec::new();

    for p in pieces {
        if p.closed {
            out.push(Contour { verts: p.verts, closed: true });
        } else {
            pool.push(p);
        }
    }

    while let Some(seed) = pool.pop() {
        let mut run = seed;
        loop {
            let head = run.start();
            let tail = run.end();
            if same_point(head, tail, tol) && run.verts.len() > 2 {
                break;
            }
            // Find a piece continuing from either end, in either direction.
            let found = pool.iter().position(|q| {
                same_point(q.start(), tail, tol)
                    || same_point(q.end(), tail, tol)
                    || same_point(q.end(), head, tol)
                    || same_point(q.start(), head, tol)
            });
            let Some(i) = found else { break };
            let q = pool.remove(i);
            if same_point(q.start(), tail, tol) {
                run.verts.extend(q.verts[1..].iter().cloned());
            } else if same_point(q.end(), tail, tol) {
                let qr = q.reversed();
                run.verts.extend(qr.verts[1..].iter().cloned());
            } else if same_point(q.end(), head, tol) {
                let mut v = q.verts.clone();
                v.pop();
                v.extend(run.verts.iter().cloned());
                run.verts = v;
            } else {
                let qr = q.reversed();
                let mut v = qr.verts.clone();
                v.pop();
                v.extend(run.verts.iter().cloned());
                run.verts = v;
            }
        }

        let closed = same_point(run.start(), run.end(), tol) && run.verts.len() > 2;
        if closed {
            // Drop the duplicated closing vertex; a closed Contour implies it.
            let mut v = run.verts;
            if v.len() > 1 {
                v.pop();
            }
            out.push(Contour { verts: v, closed: true });
        } else {
            open_count += 1;
            out.push(Contour { verts: run.verts, closed: false });
        }
    }

    (out, open_count)
}

/// Bulge for an arc from `a0` to `a1` (radians, CCW positive).
fn bulge_for_sweep(sweep: f64) -> f64 {
    (sweep / 4.0).tan()
}

/// A DXF arc, as two vertices with a bulge. Split at 180 degrees, because a
/// Evaluate a B-spline at parameter `t` using de Boor's algorithm.
///
/// `degree` is the spline degree (typically 3 for cubic).
/// `knots` is the knot vector.
/// `ctrl` is the control points as (x, y) pairs.
///
/// Returns the (x, y) point on the curve at parameter `t`.
fn de_boor(degree: usize, knots: &[f64], ctrl: &[(f64, f64)], t: f64) -> (f64, f64) {
    let n = ctrl.len();
    // Find the knot span: largest i where knots[i] <= t < knots[i+1]
    let mut span = degree;
    for i in degree..n {
        if t < knots[i + 1] {
            span = i;
            break;
        }
    }
    // Clamp to valid range
    if span >= n {
        span = n - 1;
    }
    // de Boor recursion
    let mut d: Vec<(f64, f64)> = ctrl[span - degree..=span].to_vec();
    for r in 1..=degree {
        for j in (r..=degree).rev() {
            let i = span - degree + j;
            let denom = knots[i + degree + 1 - r] - knots[i];
            if denom.abs() < 1e-12 {
                continue;
            }
            let alpha = (t - knots[i]) / denom;
            d[j] = (
                (1.0 - alpha) * d[j - 1].0 + alpha * d[j].0,
                (1.0 - alpha) * d[j - 1].1 + alpha * d[j].1,
            );
        }
    }
    d[degree]
}

/// Parse a DXF SPLINE entity into a Piece.
///
/// DXF SPLINE uses B-spline representation: degree, knot vector, control points.
/// The curve is evaluated at enough points to flatten within `tol_mm` of the
/// analytic curve. A clamped uniform knot vector is assumed (the standard case).
///
/// Returns `None` if the spline is degenerate (fewer than 2 control points).
fn parse_dxf_spline(
    degree: usize,
    knots: Vec<f64>,
    ctrl: Vec<(f64, f64)>,
    tol_mm: f64,
) -> Option<Piece> {
    if ctrl.len() < 2 || knots.len() < ctrl.len() + degree + 1 {
        return None;
    }
    // Evaluate at a uniform parameter spacing. The number of samples is chosen
    // so that the chord error stays below tol_mm. For a cubic, the error
    // scales as ~L^2 / (8R) where L is chord length and R is curvature radius.
    // We use a conservative initial sampling and add points where needed.
    let t_min = knots[degree];
    let t_max = knots[ctrl.len()];
    if (t_max - t_min).abs() < 1e-12 {
        return None;
    }
    // Initial sampling: at least 4 points per control point, minimum 16.
    let n_samples = (ctrl.len() * 4).max(16);
    let step = (t_max - t_min) / n_samples as f64;
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(n_samples + 1);
    for i in 0..=n_samples {
        let t = t_min + step * i as f64;
        let t_clamped = t.min(t_max); // avoid floating-point overshoot
        pts.push(de_boor(degree, &knots, &ctrl, t_clamped));
    }
    // Adaptive refinement: add midpoints where chord error exceeds tol_mm.
    // This is the same approach as the cubic flattener but for polyline segments.
    let mut refined: Vec<(f64, f64)> = Vec::with_capacity(pts.len() * 2);
    refined.push(pts[0]);
    for w in pts.windows(2) {
        let (p0, p1) = (w[0], w[1]);
        let mid_t = (t_min + step * (refined.len() as f64 - 0.5)).min(t_max);
        let mid_pt = de_boor(degree, &knots, &ctrl, mid_t);
        // Chord midpoint
        let chord_mid = ((p0.0 + p1.0) * 0.5, (p0.1 + p1.1) * 0.5);
        let err = ((mid_pt.0 - chord_mid.0).powi(2) + (mid_pt.1 - chord_mid.1).powi(2)).sqrt();
        if err > tol_mm {
            refined.push(mid_pt);
        }
        refined.push(p1);
    }
    Some(Piece {
        verts: refined.iter().map(|&(x, y)| Vertex::line(x, y)).collect(),
        closed: false,
    })
}

/// Parse a DXF ELLIPSE entity into a Piece.
///
/// DXF ELLIPSE: center (cx, cy), major axis endpoint (rel to center), ratio,
/// start parameter, end parameter (in radians, 0 = major axis direction).
///
/// An ellipse with ratio == 1 is a circle. An ellipse with start ≈ 0 and
/// end ≈ 2π is a full ellipse (becomes a closed contour).
fn parse_dxf_ellipse(
    cx: f64,
    cy: f64,
    mx: f64,
    my: f64,
    ratio: f64,
    start_param: f64,
    end_param: f64,
    tol_mm: f64,
) -> Option<Piece> {
    let major_len = (mx * mx + my * my).sqrt();
    if major_len < 1e-12 || ratio < 1e-12 {
        return None;
    }
    let minor_len = major_len * ratio;
    // Rotation angle of the major axis
    let angle = my.atan2(mx);
    let cos_a = angle.cos();
    let sin_a = angle.sin();

    // Parametric ellipse: x(t) = cx + major*cos(t)*cos(a) - minor*sin(t)*sin(a)
    //                        y(t) = cy + major*cos(t)*sin(a) + minor*sin(t)*cos(a)
    let ellipse_pt = |t: f64| -> (f64, f64) {
        let ct = t.cos();
        let st = t.sin();
        (
            cx + major_len * ct * cos_a - minor_len * st * sin_a,
            cy + major_len * ct * sin_a + minor_len * st * cos_a,
        )
    };

    let t0 = start_param;
    let mut t1 = end_param;
    // Ensure we go in the positive direction
    if t1 <= t0 {
        t1 += std::f64::consts::TAU;
    }
    let sweep = t1 - t0;

    // Adaptive sampling: start with a coarse grid and refine where needed.
    let n_init = (sweep / 0.1).ceil().max(8.0) as usize;
    let step = sweep / n_init as f64;
    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(n_init + 1);
    for i in 0..=n_init {
        pts.push(ellipse_pt(t0 + step * i as f64));
    }

    // Refine where chord error exceeds tolerance
    let mut refined: Vec<(f64, f64)> = Vec::with_capacity(pts.len() * 2);
    refined.push(pts[0]);
    for (idx, w) in pts.windows(2).enumerate() {
        let (p0, p1) = (w[0], w[1]);
        let mid_t = t0 + step * (idx as f64 + 0.5);
        let mid_pt = ellipse_pt(mid_t);
        let chord_mid = ((p0.0 + p1.0) * 0.5, (p0.1 + p1.1) * 0.5);
        let err = ((mid_pt.0 - chord_mid.0).powi(2) + (mid_pt.1 - chord_mid.1).powi(2)).sqrt();
        if err > tol_mm {
            refined.push(mid_pt);
        }
        refined.push(p1);
    }

    Some(Piece {
        verts: refined.iter().map(|&(x, y)| Vertex::line(x, y)).collect(),
        closed: false,
    })
}

/// bulge of exactly a half turn is the limit of the encoding and a full circle
/// has no single start point.
fn arc_piece(cx: f64, cy: f64, r: f64, start_deg: f64, end_deg: f64) -> Piece {
    let a0 = start_deg.to_radians();
    let mut a1 = end_deg.to_radians();
    while a1 <= a0 {
        a1 += std::f64::consts::TAU;
    }
    let sweep = a1 - a0;
    let halves = (sweep / std::f64::consts::PI).ceil().max(1.0) as usize;
    let step = sweep / halves as f64;
    let mut verts = Vec::with_capacity(halves + 1);
    for i in 0..=halves {
        let a = a0 + step * i as f64;
        let bulge = if i < halves { bulge_for_sweep(step) } else { 0.0 };
        verts.push(Vertex { x: cx + r * a.cos(), y: cy + r * a.sin(), bulge });
    }
    Piece { verts, closed: false }
}

/// A DXF block definition: its base point and the pieces it contains.
struct DxfBlock {
    base_x: f64,
    base_y: f64,
    pieces: Vec<Piece>,
    /// Entity type names inside this block that the reader does not model.
    ///
    /// 🔴 THE TOP-LEVEL LOOP NAMED THESE AND THE BLOCK LOOP DID NOT (fixed
    /// 2026-08-29). `parse_dxf`'s entity dispatch ends in
    /// `other => out.unsupported.push("{other} is not supported and was NOT
    /// imported")`; `parse_block_entities` ended in `_ => {}` with the comment
    /// *"Other entities in blocks are silently skipped"*. Blocks are exactly
    /// where a CAD tool puts a repeated feature, so the entity most likely to
    /// appear many times in one drawing was the one class this reader dropped
    /// without a word — gate F1's whole subject, one level of nesting down.
    unsupported: Vec<String>,
}

/// Parse the BLOCKS section of a DXF to collect block definitions.
///
/// Each BLOCK has a name (group code 2), a base point (10/20), and entities
/// that are parsed with the same rules as the ENTITIES section.
/* 🔴 REPORTS A MALFORMED BASE POINT INSTEAD OF PLACING IT AT THE ORIGIN.
 *
 * A BLOCK's group 10/20 is its base point — the anchor every INSERT of that
 * block is positioned against. `v.parse().unwrap_or(0.0)` turned an unparseable
 * base into (0, 0), which does not lose one vertex: it SHIFTS EVERY INSERT of
 * that block by the base it should have had. A sub-assembly lands somewhere the
 * drawing never put it, and every downstream check sees a coherent outline.
 *
 * ⚠ Distinguished from the 15 legitimate `get("NN").unwrap_or(0.0)` sites in
 * this file, which default an ABSENT optional field and are DXF-correct. Here
 * the text is present and will not parse.
 *
 * The second return value is routed into `Imported::unsupported` by the single
 * caller, alongside the existing "LINE with missing coordinates" reports.
 * Behaviour is unchanged — still 0.0 — so nothing that imports today breaks. */
fn parse_dxf_blocks(lines: &[&str], tol: f64) -> (HashMap<String, DxfBlock>, Vec<String>) {
    let mut block_problems: Vec<String> = Vec::new();
    let mut blocks: HashMap<String, DxfBlock> = HashMap::new();
    let mut i = 0usize;
    let mut in_blocks = false;

    while i + 1 < lines.len() {
        let code = lines[i];
        let value = lines[i + 1];
        i += 2;

        if code == "2" && value == "BLOCKS" {
            in_blocks = true;
            continue;
        }
        if code == "0" && value == "ENDSEC" {
            in_blocks = false;
            continue;
        }
        if !in_blocks || code != "0" {
            continue;
        }

        // We're at a 0-code inside the BLOCKS section.
        if value == "BLOCK" {
            // Collect this block's header pairs and entity pairs until ENDBLK.
            let mut name: Option<String> = None;
            let mut base = (0.0_f64, 0.0_f64);
            let mut pairs: Vec<(String, String)> = Vec::new();
            let mut in_header = true;
            while i + 1 < lines.len() {
                let c = lines[i];
                let v = lines[i + 1];
                i += 2;
                if c == "0" && (v == "ENDBLK" || v == "BLOCK") {
                    // End of this block (or start of next — back up)
                    if v == "BLOCK" {
                        i -= 2; // re-process this BLOCK header
                    }
                    break;
                }
                if c == "0" {
                    // First 0-code entity ends the header
                    in_header = false;
                }
                if in_header {
                    if c == "2" && name.is_none() {
                        name = Some(v.to_string());
                    } else if c == "10" || c == "20" {
                        match v.trim().parse::<f64>() {
                            Ok(n) => {
                                if c == "10" {
                                    base.0 = n;
                                } else {
                                    base.1 = n;
                                }
                            }
                            Err(_) => block_problems.push(format!(
                                "BLOCK `{}` base point group {c} carries `{}`, which is not a \
                                 number — it was read as 0.0, so EVERY INSERT of this block is \
                                 offset by the base it should have had.",
                                name.clone().unwrap_or_else(|| "<unnamed>".into()),
                                v.trim().chars().take(24).collect::<String>()
                            )),
                        }
                    }
                }
                pairs.push((c.to_string(), v.to_string()));
            }
            if let Some(n) = name {
                let (pieces, unsupported) = parse_block_entities(&pairs, tol);
                blocks.insert(n, DxfBlock { base_x: base.0, base_y: base.1, pieces, unsupported });
            }
        }
        // Any other 0-code (ENDBLK, etc.) is skipped
    }
    (blocks, block_problems)
}

/// Parse entities within a block definition (same rules as ENTITIES section),
/// plus the entity types it could not read — see [`DxfBlock::unsupported`].
fn parse_block_entities(pairs: &[(String, String)], tol: f64) -> (Vec<Piece>, Vec<String>) {
    // Reassemble into the line-based format the entity parser expects.
    // The pairs are already collected; we just need to iterate through them
    // and parse entities. But since the entity parser works on a flat list of
    // (code, value) pairs grouped by 0-codes, we need a different approach.
    //
    // For simplicity, we parse the block's entities directly from the pairs.
    let mut pieces: Vec<Piece> = Vec::new();
    let mut unsupported: Vec<String> = Vec::new();
    let mut i = 0;
    while i < pairs.len() {
        let (ref code, ref value) = pairs[i];
        i += 1;
        if code != "0" {
            continue;
        }
        // Collect this entity's pairs
        let mut entity_pairs: Vec<&(String, String)> = Vec::new();
        while i < pairs.len() && pairs[i].0 != "0" {
            entity_pairs.push(&pairs[i]);
            i += 1;
        }
        let get = |c: &str| -> Option<f64> {
            entity_pairs.iter().find(|(k, _)| k == c).and_then(|(_, v)| v.parse::<f64>().ok())
        };
        let all = |c: &str| -> Vec<f64> {
            entity_pairs
                .iter()
                .filter(|(k, _)| k == c)
                .filter_map(|(_, v)| v.parse::<f64>().ok())
                .collect()
        };
        match value.as_str() {
            "LINE" => {
                if let (Some(x1), Some(y1), Some(x2), Some(y2)) =
                    (get("10"), get("20"), get("11"), get("21"))
                {
                    pieces.push(Piece {
                        verts: vec![Vertex::line(x1, y1), Vertex::line(x2, y2)],
                        closed: false,
                    });
                }
            }
            "LWPOLYLINE" => {
                let xs = all("10");
                let ys = all("20");
                let bulges = all("42");
                let flags: Vec<i64> = entity_pairs
                    .iter()
                    .filter(|(k, _)| k == "70")
                    .filter_map(|(_, v)| v.parse::<i64>().ok())
                    .collect();
                let closed = flags.first().map_or(false, |f| f & 1 != 0);
                if xs.len() >= 2 && xs.len() == ys.len() {
                    let mut verts = Vec::with_capacity(xs.len());
                    for (k, (&x, &y)) in xs.iter().zip(ys.iter()).enumerate() {
                        let bulge = if k < bulges.len() { bulges[k] } else { 0.0 };
                        verts.push(Vertex { x, y, bulge });
                    }
                    pieces.push(Piece { verts, closed });
                }
            }
            "ARC" => {
                if let (Some(cx), Some(cy), Some(r), Some(sa), Some(ea)) =
                    (get("10"), get("20"), get("40"), get("50"), get("51"))
                {
                    if r > 1e-12 {
                        pieces.push(arc_piece(cx, cy, r, sa, ea));
                    }
                }
            }
            "CIRCLE" => {
                if let (Some(cx), Some(cy), Some(r)) = (get("10"), get("20"), get("40")) {
                    if r > 1e-12 {
                        let n = ((r / tol).ceil() as usize).max(16);
                        let mut verts = Vec::with_capacity(n);
                        for k in 0..n {
                            let a = std::f64::consts::TAU * k as f64 / n as f64;
                            verts.push(Vertex::line(cx + r * a.cos(), cy + r * a.sin()));
                        }
                        pieces.push(Piece { verts, closed: true });
                    }
                }
            }
            "SPLINE" => {
                let degree = get("71").map(|d| d as usize).unwrap_or(3);
                let knots = all("40");
                let ctrl_x = all("10");
                let ctrl_y = all("20");
                if ctrl_x.len() == ctrl_y.len() && ctrl_x.len() >= 2 {
                    let ctrl: Vec<(f64, f64)> = ctrl_x.into_iter().zip(ctrl_y).collect();
                    if let Some(piece) = parse_dxf_spline(degree, knots, ctrl, tol) {
                        pieces.push(piece);
                    }
                }
            }
            "ELLIPSE" => {
                if let (Some(cx), Some(cy), Some(mx), Some(my), Some(ratio)) =
                    (get("10"), get("20"), get("11"), get("21"), get("40"))
                {
                    let start = get("41").unwrap_or(0.0);
                    let end = get("42").unwrap_or(std::f64::consts::TAU);
                    if let Some(piece) = parse_dxf_ellipse(cx, cy, mx, my, ratio, start, end, tol) {
                        pieces.push(piece);
                    }
                }
            }
            // Structural markers, not geometry: they end things rather than
            // draw them, and naming them would be noise on every block.
            "ENDBLK" | "SEQEND" | "ATTDEF" | "ATTRIB" => {}
            other => {
                // NAMED, never silently skipped. The top-level entity loop has
                // always done this; this loop did not, and blocks are where a
                // CAD tool puts a repeated feature.
                if !other.is_empty() && !unsupported.iter().any(|u| u == other) {
                    unsupported.push(other.to_string());
                }
            }
        }
    }
    (pieces, unsupported)
}

/// Say — on every import, in the notes that reach the screen — that a text
/// entity became CUTTABLE GEOMETRY.
///
/// # 🔴 Measured 2026-08-29, and the silence was the defect
///
/// A DXF holding one plate and one `TEXT` label imported as **"2 part(s)"**, and
/// the label — the single letter `A` — was planned as `drawing/part2` and
/// profiled at **Z-18.0**, clean through an 18 mm sheet. A drawing with an
/// ordinary title block has its title machined out of the material.
///
/// ⚠ **AND THIS IS NOT SIMPLY A BUG TO DELETE, WHICH IS WHY THE FIX IS A NOTE
/// AND NOT A REFUSAL.** Cutting letters out of ply is a real job; so is a title
/// block that must never be touched. **The drawing does not say which**, this
/// tool cannot tell them apart, and two existing tests assert that TEXT produces
/// contours — so silently dropping it would take a genuine capability away as
/// surely as silently cutting it destroys a sheet.
///
/// What was actually wrong is that the choice was made in SILENCE. So the import
/// says what it did, names the string, counts the outlines, and says what to do
/// if that was not wanted. The same rule the mesh path follows: the word
/// *section* and the Z it was taken at ride on every import rather than being
/// left for the operator to infer.
///
/// The fork itself — cut / engrave / ignore, and on what signal (a layer name?
/// an operator switch?) — is a product decision and is filed as TODO #152, not
/// taken here.
///
/// # 🔴 WHAT THIS WARNING CANNOT SEE, and it is the case that matters
///
/// `cad` answered the routed question on 2026-08-29 and corrected the premise of
/// it. Two facts, both measured by them and cross-checked here:
///
/// 1. **The file this was found on is not a cut file.** `hive_box_prototype.dxf`
///    was written by `ezdxf` (`$LASTSAVEDBY`, confirmed) — a hand-built drawing
///    sheet, and the only `.dxf` in `export/`. **1 of the 93 DXFs under
///    `hardware/cad` carries TEXT/MTEXT/DIMENSION, and it is that one.**
/// 2. **An OpenSCAD `text()` is ALREADY GEOMETRY by the time it reaches DXF.**
///    It arrives as `LWPOLYLINE` outlines, *indistinguishable from a cut path*.
///    `cad`'s real `_wcnc` exports carry **zero TEXT entities and one layer** —
///    OpenSCAD's DXF export has no layer control.
///
/// ⇒ **This warning is silent on exactly the files that matter.** It keys on the
/// TEXT/MTEXT/DIMENSION entity types; a nest exported from OpenSCAD with its
/// part labels on has none of them, and `cad`'s own gate REQUIRES those labels.
/// They measured 342 `LWPOLYLINE` with labels against 230 without — **112 glyph
/// outlines** that would enter a cut file as ordinary geometry.
///
/// ⚠ **And there is no sound way to detect that from here.** "Many small closed
/// contours" is a heuristic that would refuse real small parts, which is the
/// guessing this module exists to refuse. The control lives in `cad`'s export
/// (`-D show_labels=false`, plus a gate on the entity count) and it does not
/// exist yet — `render_fleet.py` emits only binstl today.
///
/// So this warning is **necessary and not sufficient**, and saying which is the
/// whole point of writing it down here rather than only in a ticket: it protects
/// the hand-exported drawing sheet, and it cannot protect the nest.
fn text_cut_warning(out: &mut Imported, kind: &str, text: &str, outlines: usize) {
    out.unsupported.push(format!(
        "🔴 {kind} '{text}' was imported as {outlines} CUTTABLE outline(s) — it will be machined \
         like any other geometry, at full depth, not engraved. If that is a label, a title block \
         or a dimension rather than something you want cut out, remove it from the drawing or put \
         it on a layer you do not export. This tool cannot tell a sign from a caption"
    ));
}

/// Transform and append block pieces for an INSERT entity.
/// Place a block's geometry for one INSERT.
///
/// # 🔴 What the bulge does under a MIRROR and under a NON-UNIFORM scale
/// (both fixed 2026-08-29)
///
/// A `bulge` is `tan(sweep / 4)`: a shape factor, not a length. Under a UNIFORM
/// scale it is genuinely invariant, and the old comment saying so was right
/// about the case it was thinking of. It was carried through unchanged in two
/// cases where it is not:
///
/// * **A MIRROR reverses the arc's direction.** Keeping the sign leaves the arc
///   bulging the WRONG WAY — a fillet that curves out where it should curve in.
/// * **A NON-UNIFORM scale turns a circular arc into an ELLIPTICAL one**, which
///   a bulge cannot express at all.
///
/// Measured on a 40 mm square with one quarter-arc side (`bulge = 0.4142`),
/// inserted at several scales. **A mirror must preserve area:**
///
/// ```text
/// sx= 1 sy= 1  |area| = 1828.31   baseline
/// sx=-1 sy= 1  |area| = 1371.69   <- WRONG, and 456.62 is exactly 2x the arc segment
/// sx= 1 sy=-1  |area| = 1371.69   <- same, the other axis
/// sx= 2 sy= 1  |area| = 4113.24   <- WRONG, should be 3656.62 (2 x baseline)
/// sx= 2 sy= 2  |area| = 7313.24   correct, 4 x baseline
/// ```
///
/// Both produced a real closed contour with **no note of any kind**.
///
/// The mirror is fixed exactly — negate the bulge. The non-uniform case cannot
/// be: it is refused by name, and **only when a bulge is actually present**,
/// because straight segments scale non-uniformly without any trouble and
/// refusing them would take a working case away.
fn apply_insert(
    block: &DxfBlock,
    ix: f64,
    iy: f64,
    sx: f64,
    sy: f64,
    rotation_deg: f64,
    pieces_out: &mut Vec<Piece>,
    problems: &mut Vec<String>,
) {
    // A mirror on exactly one axis reverses the winding, and with it the
    // direction of every arc.
    let mirrored = sx * sy < 0.0;
    let non_uniform = (sx.abs() - sy.abs()).abs() > 1e-9;
    let angle = rotation_deg.to_radians();
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    for piece in &block.pieces {
        // 🔴 A NON-UNIFORM scale turns a circular arc into an ELLIPTICAL one and
        // a bulge cannot express that. Refused by name — and ONLY when a bulge
        // is actually present, because straight segments scale non-uniformly
        // without any trouble and refusing those would take a working case away.
        if non_uniform && piece.verts.iter().any(|v| v.bulge.abs() > 1e-12) {
            let note = format!(
                "INSERT scales this block non-uniformly (x{sx}, y{sy}) and it contains an ARC — \
                 a non-uniform scale makes a circular arc ELLIPTICAL, which a DXF bulge cannot \
                 represent, so the arc would come through as a circle of the wrong shape. That \
                 piece was NOT imported. Explode the block, or scale it equally on both axes"
            );
            if !problems.contains(&note) {
                problems.push(note);
            }
            continue;
        }
        let verts: Vec<Vertex> = piece
            .verts
            .iter()
            .map(|v| {
                // Relative to block base
                let dx = v.x - block.base_x;
                let dy = v.y - block.base_y;
                // Scale
                let sx_dx = dx * sx;
                let sy_dy = dy * sy;
                // Rotate
                let rx = sx_dx * cos_a - sy_dy * sin_a;
                let ry = sx_dx * sin_a + sy_dy * cos_a;
                // Translate
                Vertex {
                    x: ix + rx,
                    y: iy + ry,
                    // Invariant under a UNIFORM scale; NEGATED by a mirror,
                    // which reverses the sweep. See this function's header for
                    // the measured areas.
                    bulge: if mirrored { -v.bulge } else { v.bulge },
                }
            })
            .collect();
        pieces_out.push(Piece {
            verts,
            closed: piece.closed,
        });
    }
}

/// Parse the ENTITIES section of a DXF.
///
/// Supports LINE, LWPOLYLINE (bulges included), POLYLINE/VERTEX, ARC, CIRCLE,
/// SPLINE, ELLIPSE, and INSERT (block references). Anything else is listed in
/// `unsupported`.
pub fn parse_dxf(text: &str, tol: f64) -> Imported {
    let mut out = Imported::default();
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).collect();

    // $INSUNITS says what the drawing's numbers mean. 1 = inches, 4 = mm.
    //
    // 🔴 When it is ABSENT the units are unknown, and "unknown" is not "mm".
    // Assuming millimetres silently is how an inch drawing imports 25.4x small:
    // every dimension is wrong by the same factor, so the shape looks perfect
    // and only a ruler on the finished part disagrees. The assumption is made
    // (there is nothing else to do) but it is REPORTED, every time.
    let mut scale = 1.0_f64;
    out.unit_note = "no $INSUNITS in the drawing — millimetres ASSUMED, not read".into();
    for w in lines.windows(4) {
        if w[1] == "$INSUNITS" && w[2] == "70" {
            match w[3].trim().parse::<i32>() {
                Ok(1) => {
                    scale = 25.4;
                    out.unit_note = "$INSUNITS = inches; scaled by 25.4".into();
                }
                Ok(4) => {
                    scale = 1.0;
                    out.unit_note = "$INSUNITS = millimetres".into();
                }
                Ok(other) => {
                    out.unit_note =
                        format!("$INSUNITS = {other}, which is not inches or millimetres — \
                                 millimetres ASSUMED");
                }
                Err(_) => {}
            }
            break;
        }
    }

    // Parse BLOCKS section first, so INSERT entities can resolve them.
    let (blocks, block_problems) = parse_dxf_blocks(&lines, tol);
    // A malformed BLOCK base point offsets every INSERT of that block — see the
    // note on parse_dxf_blocks. Reported through the same channel the entity
    // readers already use, so it reaches the operator rather than the log.
    out.unsupported.extend(block_problems);

    // DXF is (group code, value) pairs on alternating lines.
    let mut i = 0usize;
    let mut in_entities = false;
    let mut pieces: Vec<Piece> = Vec::new();
    // Index into `pieces` of the POLYLINE currently accepting VERTEX records,
    // or `None` when no POLYLINE is open. See the VERTEX arm for why this is not
    // `pieces.last_mut()`.
    let mut open_polyline: Option<usize> = None;

    while i + 1 < lines.len() {
        let code = lines[i];
        let value = lines[i + 1];
        i += 2;

        if code == "2" && value == "ENTITIES" {
            in_entities = true;
            continue;
        }
        if code == "0" && value == "ENDSEC" {
            in_entities = false;
            continue;
        }
        if !in_entities || code != "0" {
            continue;
        }

        // Collect this entity's pairs up to the next 0-code.
        let mut pairs: Vec<(String, String)> = Vec::new();
        while i + 1 < lines.len() && lines[i] != "0" {
            pairs.push((lines[i].to_string(), lines[i + 1].to_string()));
            i += 2;
        }
        let get = |c: &str| -> Option<f64> {
            pairs.iter().find(|(k, _)| k == c).and_then(|(_, v)| v.parse::<f64>().ok())
        };
        let all = |c: &str| -> Vec<f64> {
            pairs
                .iter()
                .filter(|(k, _)| k == c)
                .filter_map(|(_, v)| v.parse::<f64>().ok())
                .collect()
        };

        match value {
            "LINE" => {
                let (Some(x1), Some(y1), Some(x2), Some(y2)) =
                    (get("10"), get("20"), get("11"), get("21"))
                else {
                    out.unsupported.push("LINE with missing coordinates".into());
                    continue;
                };
                pieces.push(Piece {
                    verts: vec![Vertex::line(x1, y1), Vertex::line(x2, y2)],
                    closed: false,
                });
            }
            "LWPOLYLINE" => {
                let xs = all("10");
                let ys = all("20");
                // 🔴 Bulges are SPARSE in a DXF — code 42 appears only on the
                // vertices that carry one, so bulge[k] does NOT correspond to
                // vertex[k]. Zipping them positionally silently reassigns every
                // arc in the drawing to the wrong segment. They are matched by
                // scanning the pair list in order instead.
                let mut bulges = vec![0.0; xs.len()];
                {
                    // A vertex is written as 10 (x), 20 (y), then optionally
                    // 42 (bulge). So by the time a 42 appears, the vertex it
                    // belongs to is the one just COMPLETED — index
                    // `seen - 1`, not `seen`. Using `seen` puts every arc one
                    // segment late, which on a symmetric part is invisible and
                    // on any other part cuts the wrong corner round.
                    let mut seen = 0usize;
                    for (k, v) in &pairs {
                        match k.as_str() {
                            "20" => seen += 1,
                            "42" => {
                                if let (Ok(b), true) = (v.parse::<f64>(), seen > 0) {
                                    if seen - 1 < bulges.len() {
                                        bulges[seen - 1] = b;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                let closed = get("70").map(|f| (f as i64) & 1 == 1).unwrap_or(false);
                if xs.len() != ys.len() || xs.len() < 2 {
                    out.unsupported.push(format!("LWPOLYLINE with {} points", xs.len()));
                    continue;
                }
                let verts: Vec<Vertex> = (0..xs.len())
                    .map(|k| Vertex { x: xs[k], y: ys[k], bulge: bulges[k] })
                    .collect();
                pieces.push(Piece { verts, closed });
            }
            "POLYLINE" => {
                // The vertices follow as separate VERTEX entities; the loop
                // above will meet them next. The header alone carries the
                // closed flag, which is picked up by SEQEND handling below.
                //
                // 🔴 AND IT CARRIES MUCH MORE THAN THAT, WHICH WAS IGNORED UNTIL
                // 2026-08-29. Code 70 is a bit field and only bit 1 (closed) was
                // read. Bits 8, 16 and 64 say the entity is a **3D polyline**, a
                // **polygon mesh** or a **polyface mesh** — whose VERTEX records
                // are mesh data (positions and face indices), NOT a planar
                // outline. Reading them as one produces a real closed contour of
                // a shape that does not exist.
                //
                // Measured: a polyface mesh (`70 = 65`, i.e. 64|1) with five
                // vertices imported as a closed outline and emitted **10,399
                // bytes of runnable G-code, `ok: true`, with nothing anywhere
                // saying it was a mesh**. The only reason a first probe looked
                // safe is that its coordinates happened to fall outside the
                // machine's travel — caught by the travel check, for the wrong
                // reason and by luck.
                let flags = get("70").map(|f| f as i64).unwrap_or(0);
                const IS_3D_POLYLINE: i64 = 8;
                const IS_POLYGON_MESH: i64 = 16;
                const IS_POLYFACE_MESH: i64 = 64;
                let kind = if flags & IS_POLYFACE_MESH != 0 {
                    Some("a POLYFACE MESH")
                } else if flags & IS_POLYGON_MESH != 0 {
                    Some("a POLYGON MESH")
                } else if flags & IS_3D_POLYLINE != 0 {
                    Some("a 3D POLYLINE")
                } else {
                    None
                };
                if let Some(what) = kind {
                    // Named and dropped, never flattened. The vertices exist and
                    // are readable, which is exactly the trap: projecting them
                    // to XY yields a plausible outline of nothing.
                    out.unsupported.push(format!(
                        "POLYLINE flag 70={flags} marks {what}, whose vertices are mesh data \
                         rather than a planar outline — it was NOT imported. Reading them as a \
                         contour produces a real closed shape that is not in the drawing, and it \
                         posts and cuts like any other. Export the profile as a 2D polyline, or \
                         section the solid via the mesh path (`import --format stl --z`)"
                    ));
                    open_polyline = None;
                    continue;
                }
                open_polyline = Some(pieces.len());
                pieces.push(Piece { verts: Vec::new(), closed: flags & 1 == 1 });
            }
            "VERTEX" => {
                let (Some(x), Some(y)) = (get("10"), get("20")) else { continue };
                let b = get("42").unwrap_or(0.0);
                // 🔴 ONLY into the POLYLINE that opened, and `pieces.last_mut()`
                // was not that. A VERTEX with no POLYLINE before it — a
                // malformed file, or one whose POLYLINE this reader just
                // refused — appended itself to whatever piece happened to be
                // last, silently turning an unrelated ARC or LINE into a
                // different shape.
                if let Some(i) = open_polyline {
                    pieces[i].verts.push(Vertex { x, y, bulge: b });
                } else {
                    let note = "a VERTEX appeared with no POLYLINE open — it was NOT imported. \
                                Appending it to the previous entity would silently change that \
                                entity's shape"
                        .to_string();
                    if !out.unsupported.contains(&note) {
                        out.unsupported.push(note);
                    }
                }
            }
            "SEQEND" => {
                // The vertex list is finished; a later stray VERTEX belongs to nothing.
                open_polyline = None;
            }
            "ARC" => {
                let (Some(cx), Some(cy), Some(r), Some(a0), Some(a1)) =
                    (get("10"), get("20"), get("40"), get("50"), get("51"))
                else {
                    out.unsupported.push("ARC with missing parameters".into());
                    continue;
                };
                pieces.push(arc_piece(cx, cy, r, a0, a1));
            }
            "CIRCLE" => {
                let (Some(cx), Some(cy), Some(r)) = (get("10"), get("20"), get("40")) else {
                    out.unsupported.push("CIRCLE with missing parameters".into());
                    continue;
                };
                out.contours.push(Contour::circle(cx, cy, r));
            }
            "SPLINE" => {
                let degree = get("71").map(|d| d as usize).unwrap_or(3);
                let knots: Vec<f64> = all("40");
                let ctrl_xs = all("10");
                let ctrl_ys = all("20");
                let ctrl: Vec<(f64, f64)> = ctrl_xs.into_iter().zip(ctrl_ys).collect();
                match parse_dxf_spline(degree, knots, ctrl, tol) {
                    Some(piece) if piece.verts.len() >= 2 => pieces.push(piece),
                    _ => out.unsupported.push("SPLINE with insufficient data and was NOT imported".into()),
                }
            }
            "ELLIPSE" => {
                let (Some(cx), Some(cy), Some(mx), Some(my), Some(ratio)) =
                    (get("10"), get("20"), get("11"), get("21"), get("40"))
                else {
                    out.unsupported.push("ELLIPSE with missing parameters".into());
                    continue;
                };
                let start_param = get("41").unwrap_or(0.0);
                let end_param = get("42").unwrap_or(std::f64::consts::TAU);
                match parse_dxf_ellipse(cx, cy, mx, my, ratio, start_param, end_param, tol) {
                    Some(piece) if piece.verts.len() >= 2 => pieces.push(piece),
                    _ => out.unsupported.push("ELLIPSE with insufficient data and was NOT imported".into()),
                }
            }
            "INSERT" => {
                let Some(ref block_name) = pairs.iter().find(|(k, _)| k == "2").map(|(_, v)| v.clone())
                else {
                    out.unsupported.push("INSERT with missing block name".into());
                    continue;
                };
                match blocks.get(block_name) {
                    Some(block) => {
                        let ix = get("10").unwrap_or(0.0);
                        let iy = get("20").unwrap_or(0.0);
                        let sx = get("41").unwrap_or(1.0);
                        let sy = get("42").unwrap_or(1.0);
                        let rotation = get("50").unwrap_or(0.0);
                        apply_insert(block, ix, iy, sx, sy, rotation, &mut pieces, &mut out.unsupported);
                        // What that block could not read reaches the operator
                        // HERE, at the INSERT that placed it — qualified by the
                        // block name, because "SOLID is not supported" is not
                        // actionable and "block 'HINGE' contains SOLID" is. One
                        // note per (block, entity type) even if the block is
                        // inserted many times: the fact is about the block.
                        for u in &block.unsupported {
                            let note = format!(
                                "block '{block_name}' contains {u}, which is not supported and was NOT imported —                                  the part is missing whatever that entity drew, everywhere this block is placed"
                            );
                            if !out.unsupported.contains(&note) {
                                out.unsupported.push(note);
                            }
                        }
                    }
                    None => {
                        out.unsupported.push(format!(
                            "INSERT references block '{block_name}' which was NOT found in the BLOCKS section"
                        ));
                    }
                }
            }
            "TEXT" => {
                let text_str = pairs.iter().find(|(k, _)| k == "1").map(|(_, v)| v.as_str()).unwrap_or("");
                let tx = get("10").unwrap_or(0.0);
                let ty = get("20").unwrap_or(0.0);
                let height = get("40").unwrap_or(2.5); // default 2.5mm if unspecified
                let rotation = get("50").unwrap_or(0.0);
                if text_str.is_empty() {
                    out.unsupported.push("TEXT with empty string — skipped".into());
                } else if height < 1e-6 {
                    out.unsupported.push("TEXT with zero height — skipped".into());
                } else {
                    let rendered = render_text_outlines(text_str, tx, ty, height, rotation);
                    if rendered.is_empty() {
                        out.unsupported.push(format!(
                            "TEXT '{text_str}' could not be rendered (font unavailable?) — NOT imported"
                        ));
                    } else {
                        text_cut_warning(&mut out, "TEXT", text_str, rendered.len());
                        pieces.extend(rendered);
                    }
                }
            }
            "MTEXT" => {
                // MTEXT: text string is in group code 1 (first line) and
                // code 3 (continuation lines). Strip formatting codes ({\f...}, etc.)
                let mut text_str = String::new();
                for (k, v) in &pairs {
                    if k == "1" || k == "3" {
                        text_str.push_str(v);
                    }
                }
                // Strip MTEXT formatting codes: {\f...}, {\H...}, {\C...}, etc.
                let cleaned = strip_mtext_formatting(&text_str);
                let tx = get("10").unwrap_or(0.0);
                let ty = get("20").unwrap_or(0.0);
                let height = get("40").unwrap_or(2.5);
                let rotation = get("50").unwrap_or(0.0);
                if cleaned.trim().is_empty() {
                    out.unsupported.push("MTEXT with empty string after formatting removal — skipped".into());
                } else if height < 1e-6 {
                    out.unsupported.push("MTEXT with zero height — skipped".into());
                } else {
                    let rendered = render_text_outlines(&cleaned, tx, ty, height, rotation);
                    if rendered.is_empty() {
                        out.unsupported.push(format!(
                            "MTEXT could not be rendered (font unavailable?) — NOT imported"
                        ));
                    } else {
                        text_cut_warning(&mut out, "MTEXT", &cleaned, rendered.len());
                        pieces.extend(rendered);
                    }
                }
            }
            "HATCH" => {
                let (hatch_pieces, hatch_problems) = parse_hatch_pairs(&pairs, tol);
                // Named whether or not anything was read: a HATCH that produced
                // SOME of its boundary is the dangerous case, because the result
                // is a real outline of a shape the drawing does not contain.
                out.unsupported.extend(hatch_problems);
                if hatch_pieces.is_empty() {
                    out.unsupported.push("HATCH with no parseable boundary paths — skipped".into());
                } else {
                    pieces.extend(hatch_pieces);
                }
            }
            "DIMENSION" => {
                // DIMENSION is annotation: dimension lines, extension lines, arrows.
                // For CAM, only the text content matters (it could be engraved).
                // Render the text at the text midpoint position.
                let dim_text = pairs.iter().find(|(k, _)| k == "1").map(|(_, v)| v.as_str());
                let measurement = get("42").map(|m| format!("{m:.3}"));
                let text = match dim_text {
                    Some(t) if !t.is_empty() && t != "<>" => t.to_string(),
                    _ => measurement.unwrap_or_default(),
                };
                if !text.is_empty() {
                    // Text midpoint is at 11/21; definition points at 10/20 and 13/23
                    let tx = get("11").unwrap_or(get("10").unwrap_or(0.0));
                    let ty = get("21").unwrap_or(get("20").unwrap_or(0.0));
                    let height = get("40").unwrap_or(2.5);
                    let rotation = get("50").unwrap_or(0.0);
                    let rendered = render_text_outlines(&text, tx, ty, height, rotation);
                    if !rendered.is_empty() {
                        // ⚠ A DIMENSION is annotation BY DEFINITION — nobody
                        // draws one meaning to cut it — so this one is the least
                        // ambiguous of the three and the note says so.
                        text_cut_warning(&mut out, "DIMENSION text", &text, rendered.len());
                        pieces.extend(rendered);
                    }
                }
            }
            "ENDSEC" | "EOF" => {}
            other => {
                if !other.is_empty() {
                    out.unsupported.push(format!("{other} is not supported and was NOT imported"));
                }
            }
        }
    }

    let pieces: Vec<Piece> = pieces.into_iter().filter(|p| p.verts.len() >= 2).collect();
    let (mut chained, open) = chain(pieces, tol);
    out.contours.append(&mut chained);
    out.open_contours = open;
    if (scale - 1.0).abs() > 1e-12 {
        for c in &mut out.contours {
            for v in &mut c.verts {
                v.x *= scale;
                v.y *= scale;
                // Bulge is a RATIO (tan of a quarter of the sweep angle), so it
                // is scale-invariant. Multiplying it would open every arc out.
            }
        }
    }
    out
}

/// Parse a subset of SVG: `rect`, `circle`, `ellipse`, `polygon`, `polyline`,
/// and `path` with M/L/H/V/C/Q/S/T/A/Z flattened to `tol`.
///
/// ⚠ SVG's Y axis points DOWN. Every imported point is flipped about
/// `height_mm` so the result is in machine coordinates. Importing without the
/// flip mirrors every part, which is invisible on a symmetric outline and
/// wrong on every asymmetric one.
/// The height of the SVG's OWN coordinate space, and the Y it flips about.
///
/// # 🔴 THIS USED TO BE THE WORKPIECE'S HEIGHT (fixed 2026-08-29)
///
/// SVG's Y axis points down and the machine's points up, so an import has to
/// flip. It flipped about the caller's `stock.size_y_mm` — a number that has
/// nothing to do with the drawing. **Change the workpiece and the part moves.**
///
/// Measured on `gates/fixtures/plate.svg` (which declares `height="900"`), same
/// drawing, same cutter, only the workpiece height changed:
///
/// ```text
/// stock 600x900  -> ok, 9452 bytes, Y in [ 47.0, 173.0]
/// stock 600x950  -> ok, 9492 bytes, Y in [ 97.0, 223.0]   <- 50mm out, SILENTLY
/// stock 600x700  ->      Y in [-153.0, -27.0]             <- off the workpiece
/// ```
///
/// The 950 case is the dangerous one: `ok: true`, no refusal, no note, a
/// complete and plausible program for a part 50mm from where the drawing puts
/// it. Nothing downstream can notice — being in the wrong place is not a
/// property any check downstream reads.
///
/// ⚠ **Gate F1 could not see it**, and it is the third time this shape has come
/// up this week: `plate.svg` declares `height="900"` and the reference workpiece
/// is 900 tall, so on the only SVG the gate has ever read the wrong number and
/// the right one are the same number. A control tested only where right and
/// wrong agree is untested.
///
/// The drawing's coordinate space is the `viewBox` when there is one (user units
/// are defined by it, and its `minY` shifts the origin), otherwise the `height`
/// attribute. `None` means the file declares neither — see the refusal in
/// [`parse_svg`], which does not guess.
fn svg_flip_height(text: &str) -> Option<f64> {
    let tag = text.split('<').skip(1).find(|raw| {
        raw.split('>').next().unwrap_or("").split_whitespace().next().unwrap_or("") == "svg"
    })?;
    let tag = tag.split('>').next().unwrap_or("");
    let attr = |name: &str| -> Option<String> {
        let pat = format!("{name}=\"");
        let i = tag.find(&pat)? + pat.len();
        let rest = &tag[i..];
        let j = rest.find('"')?;
        Some(rest[..j].trim().to_string())
    };
    // `viewBox` first: it DEFINES the user-unit space the geometry is written
    // in, and `height` may be a physical size in different units entirely
    // (`height="210mm" viewBox="0 0 100 50"` is an ordinary pairing).
    if let Some(vb) = attr("viewBox") {
        let n: Vec<f64> = vb
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|t| !t.is_empty())
            .filter_map(|t| t.parse::<f64>().ok())
            .collect();
        if n.len() == 4 && n[3].is_finite() && n[3] > 0.0 {
            // minY + height: the bottom edge of the user-unit box.
            return Some(n[1] + n[3]);
        }
    }
    let h = attr("height")?;
    // Strip a unit suffix. `px` and an absent suffix are user units 1:1; a
    // physical suffix without a viewBox is a scale question this reader does
    // not answer, and it is reported by `parse_svg` rather than assumed away.
    let num: String = h.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    num.parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0)
}

/// `height_mm` is the WORKPIECE height and is no longer used for the Y flip —
/// see [`svg_flip_height`] for what replaced it and why. It is kept in the
/// signature because every caller has one to give and because removing it would
/// silently change what a future caller passes; it is deliberately unused.
pub fn parse_svg(text: &str, _height_mm: f64, tol: f64) -> Imported {
    let mut out = Imported::default();
    out.unit_note = "SVG user units treated as millimetres".into();
    let mut pieces: Vec<Piece> = Vec::new();

    let Some(flip_h) = svg_flip_height(text) else {
        out.unsupported.push(
            "this SVG declares neither a `viewBox` nor a usable `height` on its <svg> element, so \
             the drawing's own coordinate space is unknown — it was NOT imported. SVG's Y axis \
             points DOWN and the machine's points UP, so the import has to flip about the \
             drawing's height; without one, any value is a guess, and a guess MOVES THE PART \
             while every contour still looks correct"
                .into(),
        );
        return out;
    };
    let fy = |y: f64| flip_h - y;

    let attr = |tag: &str, name: &str| -> Option<f64> {
        let pat = format!("{name}=\"");
        let i = tag.find(&pat)? + pat.len();
        let rest = &tag[i..];
        let j = rest.find('"')?;
        rest[..j].trim().parse::<f64>().ok()
    };
    let attr_s = |tag: &str, name: &str| -> Option<String> {
        let pat = format!("{name}=\"");
        let i = tag.find(&pat)? + pat.len();
        let rest = &tag[i..];
        let j = rest.find('"')?;
        Some(rest[..j].to_string())
    };

    // 🔴 A `transform` MOVES THE PART, AND THIS READER DOES NOT READ ONE
    // (2026-08-29). Nothing in this file has ever parsed `transform=`. An SVG
    // carrying `<g transform="translate(50,20)">` — which is what every drawing
    // tool emits for a moved or rotated group — was imported with the transform
    // SILENTLY IGNORED, so every child landed at its untransformed coordinates.
    //
    // That is not a dropped feature, it is a WRONG PART: the contours are real
    // contours, they post, simulate and gate green, and they are in the wrong
    // place. Nothing downstream can notice.
    //
    // So the whole import is REFUSED and the reason is named. ⚠ Refusing the
    // DOCUMENT rather than the element is deliberate: a transform on a `<g>`
    // applies to its children, and this parser walks tags FLATLY with no nesting
    // model — it cannot tell which elements a group's transform covers. Skipping
    // only the tag that carries the attribute would drop the group and import
    // its children misplaced, which is the same wrong part with a note attached.
    //
    // ⚠ NOT COVERED BY GATE F1, and that is why it survived: `gates/fixtures/
    // plate.svg` uses `<rect>`, `<circle>` and `<svg>` and carries no transform,
    // so right and wrong agreed on the only SVG the gate has ever read.
    if let Some(t) = text.split('<').skip(1).find_map(|raw| {
        let tag = raw.split('>').next().unwrap_or("");
        attr_s(tag, "transform").map(|v| {
            (tag.split_whitespace().next().unwrap_or("?").to_string(), v)
        })
    }) {
        let (elem, value) = t;
        out.unsupported.push(format!(
            "SVG `transform` is NOT read by this importer, and `<{elem}>` carries              `transform=\"{value}\"` — the drawing was NOT imported. Ignoring it would place every              affected contour at its untransformed coordinates: real geometry in the wrong place,              which posts, simulates and cuts a plausible-looking wrong part. Flatten the transforms              in the drawing tool (Inkscape: Edit > Preferences > Behaviour > Transforms > Store              transformation: Optimized, then move the objects), or export as DXF"
        ));
        return out;
    }

    for raw in text.split('<').skip(1) {
        let tag = raw.split('>').next().unwrap_or("");
        let name = tag.split_whitespace().next().unwrap_or("");
        match name {
            // Real geometry, and it was in the silent catch-all until
            // 2026-08-29 — a `<line>` is exactly the shape a drawing tool emits
            // for a construction edge or an open profile.
            "line" => {
                let (Some(x1), Some(y1), Some(x2), Some(y2)) =
                    (attr(tag, "x1"), attr(tag, "y1"), attr(tag, "x2"), attr(tag, "y2"))
                else {
                    out.unsupported.push("line with missing x1/y1/x2/y2 — NOT imported".into());
                    continue;
                };
                pieces.push(Piece {
                    verts: vec![Vertex::line(x1, fy(y1)), Vertex::line(x2, fy(y2))],
                    closed: false,
                });
            }
            "rect" => {
                let (Some(x), Some(y), Some(w), Some(h)) =
                    (attr(tag, "x"), attr(tag, "y"), attr(tag, "width"), attr(tag, "height"))
                else {
                    out.unsupported.push("rect with missing attributes".into());
                    continue;
                };
                // Flip: the SVG rect's top edge becomes the bottom.
                out.contours.push(Contour::rect(x, fy(y + h), w, h));
            }
            "circle" => {
                let (Some(cx), Some(cy), Some(r)) =
                    (attr(tag, "cx"), attr(tag, "cy"), attr(tag, "r"))
                else {
                    out.unsupported.push("circle with missing attributes".into());
                    continue;
                };
                out.contours.push(Contour::circle(cx, fy(cy), r));
            }
            "ellipse" => {
                let (Some(cx), Some(cy), Some(rx), Some(ry)) =
                    (attr(tag, "cx"), attr(tag, "cy"), attr(tag, "rx"), attr(tag, "ry"))
                else {
                    out.unsupported.push("ellipse with missing attributes".into());
                    continue;
                };
                if rx < 1e-12 || ry < 1e-12 {
                    out.unsupported.push("ellipse with zero radius".into());
                    continue;
                }
                if (rx - ry).abs() < 1e-9 {
                    out.contours.push(Contour::circle(cx, fy(cy), rx));
                } else {
                    // Parametric ellipse: x = cx + rx*cos(t), y = cy + ry*sin(t).
                    // Sample adaptively so chord error stays below tol.
                    let n_init = ((rx.max(ry) / tol).ceil() as usize).max(16);
                    let step = std::f64::consts::TAU / n_init as f64;
                    let ellipse_pt = |t: f64| (cx + rx * t.cos(), cy + ry * t.sin());
                    let mut pts: Vec<(f64, f64)> = Vec::with_capacity(n_init + 1);
                    for k in 0..=n_init {
                        pts.push(ellipse_pt(step * k as f64));
                    }
                    // Adaptive refinement
                    let mut refined: Vec<(f64, f64)> = Vec::with_capacity(pts.len() * 2);
                    refined.push(pts[0]);
                    for w in pts.windows(2) {
                        let (p0, p1) = (w[0], w[1]);
                        let mid = ellipse_pt(step * (refined.len() as f64 - 0.5));
                        let chord_mid = ((p0.0 + p1.0) * 0.5, (p0.1 + p1.1) * 0.5);
                        let err = ((mid.0 - chord_mid.0).powi(2)
                            + (mid.1 - chord_mid.1).powi(2))
                        .sqrt();
                        if err > tol {
                            refined.push(mid);
                        }
                        refined.push(p1);
                    }
                    let contour = Contour {
                        verts: refined.iter().map(|&(x, y)| Vertex::line(x, fy(y))).collect(),
                        closed: true,
                    };
                    out.contours.push(contour);
                }
            }
            "polygon" | "polyline" => {
                let Some(pts) = attr_s(tag, "points") else {
                    out.unsupported.push(format!("{name} with no points"));
                    continue;
                };
                let nums: Vec<f64> = pts
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .filter(|s| !s.is_empty())
                    .filter_map(|s| s.parse::<f64>().ok())
                    .collect();
                if nums.len() < 4 {
                    out.unsupported.push(format!("{name} with {} numbers", nums.len()));
                    continue;
                }
                let verts: Vec<Vertex> =
                    nums.chunks(2).map(|c| Vertex::line(c[0], fy(c[1]))).collect();
                if name == "polygon" {
                    out.contours.push(Contour::closed(verts));
                } else {
                    pieces.push(Piece { verts, closed: false });
                }
            }
            "path" => {
                let Some(d) = attr_s(tag, "d") else {
                    out.unsupported.push("path with no d attribute".into());
                    continue;
                };
                match parse_path(&d, &fy, tol) {
                    Ok(p) if p.verts.len() >= 2 => {
                        if p.tolerance_unmet {
                            // NOT a "not imported" — the geometry is here, and
                            // that is exactly why it has to be said out loud. A
                            // chord coarser than the tolerance the caller asked
                            // for is a wrong profile that renders perfectly, and
                            // on an inside curve it is a gouge into the finished
                            // edge. Only reachable with a tolerance no
                            // subdivision can meet (0, negative, non-finite).
                            out.unsupported.push(format!(
                                "path: a cubic could not be flattened to within {tol}mm at the \
                                 subdivision cap ({MAX_SPLIT_DEPTH} levels) — it WAS imported and \
                                 its chords may exceed that tolerance"
                            ));
                        }
                        if p.closed {
                            out.contours.push(Contour::closed(p.verts));
                        } else {
                            pieces.push(Piece { verts: p.verts, closed: false });
                        }
                    }
                    Ok(_) => out.unsupported.push("path with fewer than 2 points".into()),
                    Err(cmd) => out.unsupported.push(format!(
                        "path command '{cmd}' is not supported — the path was NOT imported"
                    )),
                }
            }
            // Structure, metadata and closing tags: they carry no geometry of
            // their own, so naming them would put a note on every drawing and a
            // warning that always fires is a warning nobody reads.
            "svg" | "g" | "defs" | "title" | "desc" | "metadata" | "style" | "script"
            | "clipPath" | "mask" | "pattern" | "marker" | "symbol" | "linearGradient"
            | "radialGradient" | "stop" | "filter" | "namedview" | "" => {}
            other => {
                // NAMED, never silently skipped — the same rule the DXF entity
                // loop has always followed, and which this loop did not.
                if !other.starts_with('/')
                    && !other.starts_with('!')
                    && !other.starts_with('?')
                    && !other.contains(':')
                {
                    let note = format!(
                        "<{other}> is not supported and was NOT imported — the part is missing \
                         whatever that element drew"
                    );
                    if !out.unsupported.contains(&note) {
                        out.unsupported.push(note);
                    }
                }
            }
        }
    }

    let (mut chained, open) = chain(pieces, tol);
    out.contours.append(&mut chained);
    out.open_contours = open;
    out
}

/// How many times a cubic may be halved before the flattener gives up.
///
/// 14 levels is 16 384 chords on the worst branch. Nothing real reaches it: a
/// quarter-circle of R=2700mm — a curve the width of the largest contested sheet basis
/// — needs about 256 chords at the shipping 0.02mm, which is depth 8. The cap
/// exists so a tolerance of 0 or a NaN coordinate cannot spin the recursion
/// instead of returning, and when it fires the caller is TOLD (see
/// [`ParsedPath::tolerance_unmet`]) rather than handed a quietly coarse profile.
const MAX_SPLIT_DEPTH: u32 = 14;

/// A path, plus the one thing about it a caller must not be allowed to assume.
struct ParsedPath {
    verts: Vec<Vertex>,
    closed: bool,
    /// True when a cubic hit [`MAX_SPLIT_DEPTH`] with its error bound still
    /// above the requested tolerance. The points are real geometry either way;
    /// what is not true in that case is *"within tolerance"*, and that is the
    /// half a downstream reader would otherwise assume.
    tolerance_unmet: bool,
}

/// The largest distance a chord can be from the cubic it replaces.
///
/// Exact, not a heuristic. Write the chord `L(t) = (1-t)p0 + t*p3` in the same
/// cubic Bernstein basis as the curve and its control points are
/// `q1 = p0 + (p3-p0)/3` and `q2 = p0 + 2(p3-p0)/3`, so
///
/// ```text
/// B(t) - L(t) = 3(1-t)^2 t (p1 - q1) + 3(1-t) t^2 (p2 - q2)
/// ```
///
/// The two Bernstein weights sum to `3t(1-t)`, whose maximum on [0,1] is `3/4`
/// at `t = 1/2`. So the deviation can never exceed `0.75 * max(|p1-q1|,|p2-q2|)`
/// — an upper bound, which is the direction a safety check has to err in.
fn cubic_chord_error_bound(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    p3: (f64, f64),
) -> f64 {
    let dx = p3.0 - p0.0;
    let dy = p3.1 - p0.1;
    let q1 = (p0.0 + dx / 3.0, p0.1 + dy / 3.0);
    let q2 = (p0.0 + 2.0 * dx / 3.0, p0.1 + 2.0 * dy / 3.0);
    let d1 = ((p1.0 - q1.0).powi(2) + (p1.1 - q1.1).powi(2)).sqrt();
    let d2 = ((p2.0 - q2.0).powi(2) + (p2.1 - q2.1).powi(2)).sqrt();
    0.75 * d1.max(d2)
}

/// Flatten a cubic into chords that stay within `tol_mm` of the analytic curve.
/// Pushes every point EXCEPT `p0` (the caller already emitted it) and INCLUDING
/// `p3`. Returns false if the subdivision cap was hit with the bound still over
/// tolerance.
///
/// 🔴 **What this replaces, and why a bigger constant would not have fixed it.**
/// Until 2026-08-09 this was a loop of **16 segments, hard-coded**, in a function
/// that was handed a tolerance and never read it. A fixed count is *scale-blind*:
/// the chord error of a cubic grows with the square of the curve's size, so the
/// same 16 chords that hold a 6mm fillet to 0.008mm let a curve spanning a
/// 1200mm workpiece wander far off the drawing. Measured against the shipping
/// `IMPORT_TOL_MM = 0.02mm` (2026-08-09, worst deviation of the 16-chord
/// polyline from the analytic curve):
///
/// | curve | 16 chords | vs 0.02mm |
/// |---|---|---|
/// | quarter-circle R=6mm (a small radius) | 0.0078mm | inside |
/// | quarter-circle R=20mm (a fillet) | 0.0259mm | 1.3x over |
/// | quarter-circle R=100mm (a 200mm rounded corner) | 0.1296mm | 6.5x over |
/// | quarter-circle R=300mm | 0.3887mm | 19x over |
/// | S-curve across a 1200mm workpiece | 2.1056mm | **105x over** |
///
/// The physical failure: the part is cut to a profile nobody drew. On an inside
/// curve the polyline cuts *through* the analytic edge, so the error lands as a
/// gouge in the finished surface — and it renders perfectly at every step, which
/// is why it needed a number rather than an eyeball.
fn flatten_cubic(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    p3: (f64, f64),
    tol_mm: f64,
    depth: u32,
    out: &mut Vec<(f64, f64)>,
) -> bool {
    let e = cubic_chord_error_bound(p0, p1, p2, p3);
    if !e.is_finite() {
        // A NaN/infinite control point. Subdividing it forever produces 16 384
        // NaNs instead of one; emit the chord and let the downstream geometry
        // checks meet the bad number once.
        out.push(p3);
        return true;
    }
    if e <= tol_mm {
        out.push(p3);
        return true;
    }
    if depth >= MAX_SPLIT_DEPTH {
        out.push(p3);
        return false;
    }
    // de Casteljau at t = 1/2. Halving is what makes the bound shrink ~4x per
    // level, so the recursion terminates for any tolerance above zero.
    let mid = |a: (f64, f64), b: (f64, f64)| ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5);
    let a = mid(p0, p1);
    let b = mid(p1, p2);
    let c = mid(p2, p3);
    let d = mid(a, b);
    let f = mid(b, c);
    let g = mid(d, f);
    let left = flatten_cubic(p0, a, d, g, tol_mm, depth + 1, out);
    let right = flatten_cubic(g, f, c, p3, tol_mm, depth + 1, out);
    left && right
}

/// Minimal SVG path parser. Curves are flattened **to `tol_mm`**; unsupported
/// commands are reported by name rather than ignored.
fn parse_path(
    d: &str,
    fy: &dyn Fn(f64) -> f64,
    tol_mm: f64,
) -> Result<ParsedPath, char> {
    let mut verts: Vec<Vertex> = Vec::new();
    let mut closed = false;
    let mut tolerance_unmet = false;
    let mut cur = (0.0_f64, 0.0_f64);
    let mut start = (0.0_f64, 0.0_f64);
    // For S/s (smooth cubic): the second control point of the previous C or S.
    // For T/t (smooth quadratic): the control point of the previous Q or T.
    // Reset to None when a different command intervenes.
    let mut last_cubic_cp: Option<(f64, f64)> = None;
    let mut last_quad_cp: Option<(f64, f64)> = None;

    let toks: Vec<String> = {
        let mut v = Vec::new();
        let mut num = String::new();
        for ch in d.chars() {
            if ch.is_ascii_alphabetic() {
                if !num.trim().is_empty() {
                    v.push(num.trim().to_string());
                }
                num.clear();
                v.push(ch.to_string());
            } else if ch == ',' || ch.is_whitespace() {
                if !num.trim().is_empty() {
                    v.push(num.trim().to_string());
                }
                num.clear();
            } else if ch == '-' && !num.is_empty() && !num.ends_with('e') && !num.ends_with('E') {
                v.push(num.trim().to_string());
                num.clear();
                num.push(ch);
            } else {
                num.push(ch);
            }
        }
        if !num.trim().is_empty() {
            v.push(num.trim().to_string());
        }
        v
    };

    let mut i = 0usize;
    let mut cmd = ' ';
    while i < toks.len() {
        if toks[i].chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            cmd = toks[i].chars().next().unwrap();
            i += 1;
        }
        let num = |k: usize| -> f64 { toks.get(k).and_then(|s| s.parse().ok()).unwrap_or(0.0) };
        match cmd {
            'M' | 'L' | 'm' | 'l' => {
                let (mut x, mut y) = (num(i), num(i + 1));
                i += 2;
                if cmd.is_lowercase() {
                    x += cur.0;
                    y += cur.1;
                }
                cur = (x, y);
                if cmd.eq_ignore_ascii_case(&'M') && verts.is_empty() {
                    start = cur;
                }
                verts.push(Vertex::line(x, fy(y)));
                if cmd == 'M' {
                    cmd = 'L';
                } else if cmd == 'm' {
                    cmd = 'l';
                }
                last_cubic_cp = None;
                last_quad_cp = None;
            }
            'H' | 'h' => {
                let mut x = num(i);
                i += 1;
                if cmd == 'h' {
                    x += cur.0;
                }
                cur = (x, cur.1);
                verts.push(Vertex::line(cur.0, fy(cur.1)));
                last_cubic_cp = None;
                last_quad_cp = None;
            }
            'V' | 'v' => {
                let mut y = num(i);
                i += 1;
                if cmd == 'v' {
                    y += cur.1;
                }
                cur = (cur.0, y);
                verts.push(Vertex::line(cur.0, fy(cur.1)));
                last_cubic_cp = None;
                last_quad_cp = None;
            }
            'C' | 'c' => {
                // Flattened. A cubic is not an arc, so it cannot become a bulge
                // without changing the shape; flattening is honest and the
                // block-rate gate is what keeps the sampling sane.
                let mut p = [(0.0, 0.0); 3];
                for (k, slot) in p.iter_mut().enumerate() {
                    let (mut x, mut y) = (num(i + k * 2), num(i + k * 2 + 1));
                    if cmd == 'c' {
                        x += cur.0;
                        y += cur.1;
                    }
                    *slot = (x, y);
                }
                i += 6;
                let p0 = cur;
                let mut pts: Vec<(f64, f64)> = Vec::new();
                // Flattened to the caller's tolerance, in SVG space; the Y flip
                // is a reflection, so it moves no point relative to any other
                // and the deviation measured here is the deviation that ships.
                if !flatten_cubic(p0, p[0], p[1], p[2], tol_mm, 0, &mut pts) {
                    tolerance_unmet = true;
                }
                for (x, y) in pts {
                    verts.push(Vertex::line(x, fy(y)));
                }
                cur = p[2];
                last_cubic_cp = Some(p[1]);
                last_quad_cp = None;
            }
            'Q' | 'q' => {
                // SVG quadratic Bézier: cx cy x y (2 control points, 4 numbers).
                // Elevated to a cubic and flattened with the existing engine.
                // Quadratic P0,P1,P2 → cubic P0, P0+2/3(P1-P0), P2+2/3(P1-P2), P2.
                let (mut cx, mut cy) = (num(i), num(i + 1));
                let (mut ex, mut ey) = (num(i + 2), num(i + 3));
                i += 4;
                if cmd == 'q' {
                    cx += cur.0;
                    cy += cur.1;
                    ex += cur.0;
                    ey += cur.1;
                }
                let p0 = cur;
                let cp1 = (p0.0 + 2.0 / 3.0 * (cx - p0.0), p0.1 + 2.0 / 3.0 * (cy - p0.1));
                let cp2 = (ex + 2.0 / 3.0 * (cx - ex), ey + 2.0 / 3.0 * (cy - ey));
                let p3 = (ex, ey);
                let mut pts: Vec<(f64, f64)> = Vec::new();
                if !flatten_cubic(p0, cp1, cp2, p3, tol_mm, 0, &mut pts) {
                    tolerance_unmet = true;
                }
                for (x, y) in pts {
                    verts.push(Vertex::line(x, fy(y)));
                }
                cur = p3;
                last_quad_cp = Some((cx, cy));
                last_cubic_cp = None;
            }
            'S' | 's' => {
                // SVG smooth cubic Bézier: the first control point is the
                // reflection of the previous C/S second control point about
                // the current point. If the previous command wasn't C or S,
                // the first control point equals the current point.
                let (mut cx2, mut cy2) = (num(i), num(i + 1));
                let (mut ex, mut ey) = (num(i + 2), num(i + 3));
                i += 4;
                if cmd == 's' {
                    cx2 += cur.0;
                    cy2 += cur.1;
                    ex += cur.0;
                    ey += cur.1;
                }
                let cp1 = match last_cubic_cp {
                    Some((lx, ly)) => (2.0 * cur.0 - lx, 2.0 * cur.1 - ly),
                    None => cur,
                };
                let p0 = cur;
                let cp2 = (cx2, cy2);
                let p3 = (ex, ey);
                let mut pts: Vec<(f64, f64)> = Vec::new();
                if !flatten_cubic(p0, cp1, cp2, p3, tol_mm, 0, &mut pts) {
                    tolerance_unmet = true;
                }
                for (x, y) in pts {
                    verts.push(Vertex::line(x, fy(y)));
                }
                cur = p3;
                last_cubic_cp = Some(cp2);
                last_quad_cp = None;
            }
            'T' | 't' => {
                // SVG smooth quadratic Bézier: the control point is the
                // reflection of the previous Q/T control point about the
                // current point. If the previous command wasn't Q or T,
                // the control point equals the current point.
                let (mut ex, mut ey) = (num(i), num(i + 1));
                i += 2;
                if cmd == 't' {
                    ex += cur.0;
                    ey += cur.1;
                }
                let (cx, cy) = match last_quad_cp {
                    Some((lx, ly)) => (2.0 * cur.0 - lx, 2.0 * cur.1 - ly),
                    None => cur,
                };
                let p0 = cur;
                // Elevate quadratic to cubic: P0,P1,P2 → P0, P0+2/3(P1-P0), P2+2/3(P1-P2), P2
                let cp1 = (p0.0 + 2.0 / 3.0 * (cx - p0.0), p0.1 + 2.0 / 3.0 * (cy - p0.1));
                let cp2 = (ex + 2.0 / 3.0 * (cx - ex), ey + 2.0 / 3.0 * (cy - ey));
                let p3 = (ex, ey);
                let mut pts: Vec<(f64, f64)> = Vec::new();
                if !flatten_cubic(p0, cp1, cp2, p3, tol_mm, 0, &mut pts) {
                    tolerance_unmet = true;
                }
                for (x, y) in pts {
                    verts.push(Vertex::line(x, fy(y)));
                }
                cur = p3;
                last_quad_cp = Some((cx, cy));
                last_cubic_cp = None;
            }
            'A' | 'a' => {
                // SVG elliptical arc: rx ry x-rotation large-arc sweep x y
                let rx = num(i).abs();
                let ry = num(i + 1).abs();
                let x_rot = num(i + 2).to_radians();
                let large_arc = num(i + 3) != 0.0;
                let sweep = num(i + 4) != 0.0;
                let (mut ex, mut ey) = (num(i + 5), num(i + 6));
                i += 7;
                if cmd == 'a' {
                    ex += cur.0;
                    ey += cur.1;
                }
                // Degenerate: endpoint == start → no arc
                if (ex - cur.0).abs() < 1e-12 && (ey - cur.1).abs() < 1e-12 {
                    cur = (ex, ey);
                    continue;
                }
                // Degenerate: zero radii → straight line
                if rx < 1e-12 || ry < 1e-12 {
                    cur = (ex, ey);
                    verts.push(Vertex::line(ex, fy(ey)));
                    continue;
                }
                // Convert endpoint parameterization to center parameterization.
                // F.6.5 in SVG spec.
                let cos_r = x_rot.cos();
                let sin_r = x_rot.sin();
                let dx = (cur.0 - ex) * 0.5;
                let dy = (cur.1 - ey) * 0.5;
                let x1p = cos_r * dx + sin_r * dy;
                let y1p = -sin_r * dx + cos_r * dy;
                let rx_sq = rx * rx;
                let ry_sq = ry * ry;
                let x1p_sq = x1p * x1p;
                let y1p_sq = y1p * y1p;
                // Correct radii if needed (F.6.6)
                let lambda = x1p_sq / rx_sq + y1p_sq / ry_sq;
                let (rx, ry) = if lambda > 1.0 {
                    let s = lambda.sqrt();
                    (rx * s, ry * s)
                } else {
                    (rx, ry)
                };
                let rx_sq = rx * rx;
                let ry_sq = ry * ry;
                let x1p_sq = x1p * x1p;
                let y1p_sq = y1p * y1p;
                let num = rx_sq * ry_sq - rx_sq * y1p_sq - ry_sq * x1p_sq;
                let denom = rx_sq * y1p_sq + ry_sq * x1p_sq;
                let sq = if denom.abs() < 1e-12 {
                    0.0
                } else {
                    (num / denom).max(0.0).sqrt()
                };
                let sign = if large_arc == sweep { -1.0 } else { 1.0 };
                let cxp = sign * sq * rx * y1p / ry;
                let cyp = sign * -sq * ry * x1p / rx;
                let cx = cos_r * cxp - sin_r * cyp + (cur.0 + ex) * 0.5;
                let cy = sin_r * cxp + cos_r * cyp + (cur.1 + ey) * 0.5;
                // Angle calculations (F.6.5)
                let angle = |ux: f64, uy: f64, vx: f64, vy: f64| -> f64 {
                    let n = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
                    if n < 1e-12 {
                        return 0.0;
                    }
                    let cos_a = ((ux * vx + uy * vy) / n).clamp(-1.0, 1.0);
                    let cross = ux * vy - uy * vx;
                    let a = cos_a.acos();
                    if cross < 0.0 { -a } else { a }
                };
                let theta1 = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
                let mut dtheta = angle(
                    (x1p - cxp) / rx,
                    (y1p - cyp) / ry,
                    (-x1p - cxp) / rx,
                    (-y1p - cyp) / ry,
                ) % std::f64::consts::TAU;
                if !sweep && dtheta > 0.0 {
                    dtheta -= std::f64::consts::TAU;
                } else if sweep && dtheta < 0.0 {
                    dtheta += std::f64::consts::TAU;
                }
                // Sample the arc. The number of segments is chosen so chord
                // error stays below tolerance. For an arc of sweep θ on an
                // ellipse with semi-minor b, error ≈ b(1 - cos(θ/2n)).
                let b = ry.min(rx);
                let abs_dtheta = dtheta.abs();
                let n_segs = if b < 1e-12 {
                    1
                } else {
                    let cos_err = 1.0 - tol_mm / b;
                    if cos_err <= 0.0 {
                        (abs_dtheta / 0.5).ceil().max(1.0) as usize
                    } else {
                        let half_angle = cos_err.acos().max(0.01);
                        (abs_dtheta / (2.0 * half_angle)).ceil().max(1.0) as usize
                    }
                };
                let step = dtheta / n_segs as f64;
                for k in 0..n_segs {
                    let angle = theta1 + step * k as f64;
                    let cos_a = angle.cos();
                    let sin_a = angle.sin();
                    let px = cos_r * rx * cos_a - sin_r * ry * sin_a + cx;
                    let py = sin_r * rx * cos_a + cos_r * ry * sin_a + cy;
                    verts.push(Vertex::line(px, fy(py)));
                }
                // Endpoint
                verts.push(Vertex::line(ex, fy(ey)));
                cur = (ex, ey);
                last_cubic_cp = None;
                last_quad_cp = None;
            }
            'Z' | 'z' => {
                closed = true;
                cur = start;
                last_cubic_cp = None;
                last_quad_cp = None;
                i += 1;
                if i >= toks.len() {
                    break;
                }
            }
            other => return Err(other),
        }
        if cmd == 'Z' || cmd == 'z' {
            break;
        }
    }
    Ok(ParsedPath { verts, closed, tolerance_unmet })
}

/// Intake for a file whose format is decided by its **CONTENT**.
///
/// 🔴 **Never by the extension.** An extension is a claim made by whoever named
/// the file, and here a wrong claim changes what gets cut rather than merely
/// failing: the specific case this guards is a **binary STL whose 80-byte header
/// begins with the text `solid`**, which is common and which any
/// first-five-characters sniff calls an ASCII STL. See
/// [`crate::mesh::binary_triangle_count`] — the discriminator is the file's
/// length arithmetic, not its first word.
///
/// `z_section_mm` applies to meshes only, and it is not a detail:
///
/// 🔴 **An STL is a 3D triangle mesh; this core is 2.5D profile/pocket CAM.**
/// A mesh can only enter as a **SECTION** at one Z — a flat slice — which the
/// existing operations can cut. There is no 3D surfacing here and this is not a
/// step toward it. A user who imports a 3D part expecting surfacing and silently
/// Parse DXF HATCH boundary paths into Piece contours.
///
/// A HATCH entity contains one or more boundary paths. Each path is composed
/// of edges (LINE, ARC, ELLIPSE, SPLINE). The edges are parsed using the
/// same geometry as standalone entities and chained into contours.
///
/// The fill pattern (hatching lines) is ignored — only the boundary geometry
/// is extracted, which is what a CNC router cares about.
///
/// # 🔴 A PARTLY-READ HATCH IS NAMED, 2026-08-28
///
/// This returned only the pieces, and closed with the comment *"If we found
/// fewer paths than declared, don't warn — just use what we got."* The DXF
/// STATES how many boundary paths a HATCH has (group code 91) and how many
/// edges each path has (code 93); both counts were parsed into variables that
/// nothing ever read — the compiler had been warning about all three for as
/// long as they existed.
///
/// So a HATCH whose boundary this parser cannot fully follow — a block
/// reference, an edge type it does not model, a truncated file — produced
/// SOME of its outline and reported nothing, and a partial boundary is a part
/// missing a feature. That is gate F1's whole subject arriving one entity
/// along, and the empty case beside it was already named while the partial one
/// was not: `HATCH with no parseable boundary paths` has been reported since
/// the branch was written.
///
/// The counts are now compared and the shortfall is returned as a problem the
/// caller pushes into `Imported::unsupported`. ⚠ It does NOT refuse: a HATCH is
/// usually annotation, and refusing every drawing that carries one would be a
/// worse trade than naming it. Naming is the floor; the operator decides.
fn parse_hatch_pairs(pairs: &[(String, String)], tol: f64) -> (Vec<Piece>, Vec<String>) {
    let mut problems: Vec<String> = Vec::new();
    /* 🔴 A COORDINATE THAT IS PRESENT AND UNPARSEABLE IS NOT A ZERO.
     *
     * These sites read `value.parse().unwrap_or(0.0)` — the group code IS in the
     * file and its text failed to parse — so a corrupt X became a real vertex at
     * the ORIGIN, the edge count still reconciled, and the toolpath carried a
     * move to (0, 0). On a machine that is a cut or a rapid across the bed to a
     * corner nobody put there.
     *
     * ⚠ The existing declared-vs-found check below cannot see this: it compares
     * group code 93's declared edge count against edges READ, and a malformed
     * edge still increments the count. It catches edges that vanish, not edges
     * that arrive wrong.
     *
     * ⚠ DISTINGUISHED FROM THE 15 LEGITIMATE `get("NN").unwrap_or(0.0)` SITES in
     * this file, which default an ABSENT optional field and are DXF-correct — a
     * missing bulge really is 0.0. The defect is only where the text exists.
     *
     * Behaviour is unchanged (still 0.0) so no import that works today breaks;
     * what changes is that the file now SAYS so instead of importing silently. */
    let num = |v: &str, code: &str, problems: &mut Vec<String>| -> f64 {
        match v.trim().parse::<f64>() {
            Ok(n) => n,
            Err(_) => {
                problems.push(format!(
                    "HATCH group code {code} carries `{}`, which is not a number — it was read as \
                     0.0, so this outline has a vertex at the ORIGIN that the drawing does not. \
                     The edge COUNT still reconciles, so nothing else here can see it.",
                    v.trim().chars().take(24).collect::<String>()
                ));
                0.0
            }
        }
    };
    // Collect all integer values for a given group code, in order.
    let all_int = |c: &str| -> Vec<i64> {
        pairs
            .iter()
            .filter(|(k, _)| k == c)
            .filter_map(|(_, v)| v.parse::<i64>().ok())
            .collect()
    };
    // Number of boundary paths
    let num_paths = all_int("91").first().copied().unwrap_or(0) as usize;

    // We iterate through the pairs looking for path/edge structure.
    // Group code 92 marks a new path, 93 marks number of edges, 72 marks edge type.
    let mut all_pieces: Vec<Piece> = Vec::new();
    // `path_idx` counts the paths SEEN, `declared_edges` the edges the file says
    // each path holds, `found_edges` the edges actually turned into geometry.
    // All three are compared at the end — see the header for why they used to be
    // computed and discarded.
    let mut path_idx = 0usize;
    let mut declared_edges = 0usize;
    let mut found_edges = 0usize;
    let mut current_edge_type: i64 = 0;
    let mut current_path_pieces: Vec<Piece> = Vec::new();

    // Collect edges by iterating through pairs sequentially.
    // We track state: which path we're in, how many edges expected, current edge type.
    let mut i = 0;
    while i < pairs.len() {
        let (ref code, ref val) = pairs[i];
        i += 1;

        match code.as_str() {
            "92" => {
                // New boundary path — flush previous path's pieces
                if !current_path_pieces.is_empty() {
                    all_pieces.extend(chain_hatch_edges(&current_path_pieces, tol));
                    current_path_pieces.clear();
                }
                path_idx += 1;
            }
            "93" => {
                // Number of edges this path DECLARES. Accumulated across paths and
                // compared with what was read.
                declared_edges += val.parse::<usize>().unwrap_or(0);
            }
            "72" => {
                // Edge type: 1=line, 2=circular arc, 3=elliptic arc, 4=spline
                current_edge_type = val.parse().unwrap_or(0);
            }
            "10" if current_edge_type == 1 => {
                // LINE edge: 10/20 = start, 11/21 = end
                let x1: f64 = num(val, "10", &mut problems);
                let y1 = find_next_val(&pairs, i, "20").unwrap_or(0.0);
                let x1e = find_next_val(&pairs, i, "11").unwrap_or(0.0);
                let y1e = find_next_val(&pairs, i, "21").unwrap_or(0.0);
                current_path_pieces.push(Piece {
                    verts: vec![Vertex::line(x1, y1), Vertex::line(x1e, y1e)],
                    closed: false,
                });
                found_edges += 1;
            }
            "10" if current_edge_type == 2 => {
                // ARC edge: 10/20 = center, 40 = radius, 50 = start angle, 51 = end angle
                let cx: f64 = num(val, "10", &mut problems);
                let cy = find_next_val(&pairs, i, "20").unwrap_or(0.0);
                let r = find_next_val(&pairs, i, "40").unwrap_or(0.0);
                let sa = find_next_val(&pairs, i, "50").unwrap_or(0.0);
                let ea = find_next_val(&pairs, i, "51").unwrap_or(0.0);
                if r > 1e-12 {
                    current_path_pieces.push(arc_piece(cx, cy, r, sa, ea));
                    found_edges += 1;
                }
            }
            "10" if current_edge_type == 3 => {
                // ELLIPSE edge: 10/20 = center, 11/21 = major axis endpoint,
                // 40 = ratio, 41 = start param, 42 = end param
                let cx: f64 = num(val, "10", &mut problems);
                let cy = find_next_val(&pairs, i, "20").unwrap_or(0.0);
                let mx = find_next_val(&pairs, i, "11").unwrap_or(0.0);
                let my = find_next_val(&pairs, i, "21").unwrap_or(0.0);
                let ratio = find_next_val(&pairs, i, "40").unwrap_or(1.0);
                let start_param = find_next_val(&pairs, i, "41").unwrap_or(0.0);
                let end_param = find_next_val(&pairs, i, "42").unwrap_or(std::f64::consts::TAU);
                if let Some(piece) = parse_dxf_ellipse(cx, cy, mx, my, ratio, start_param, end_param, tol) {
                    current_path_pieces.push(piece);
                    found_edges += 1;
                }
            }
            "71" if current_edge_type == 4 => {
                // SPLINE edge: 71 = degree (comes before knots/ctrl points)
                // The spline data follows: 40=knots, 10/20=ctrl points
                // We need to collect all the spline data from subsequent pairs.
                let degree = val.parse::<usize>().unwrap_or(3);
                let mut knots: Vec<f64> = Vec::new();
                let mut ctrl_x: Vec<f64> = Vec::new();
                let mut ctrl_y: Vec<f64> = Vec::new();
                let mut j = i;
                while j < pairs.len() {
                    let (ref c2, ref v2) = pairs[j];
                    match c2.as_str() {
                        "40" => knots.push(num(v2, "40", &mut problems)),
                        "10" => ctrl_x.push(num(v2, "10", &mut problems)),
                        "20" => ctrl_y.push(num(v2, "20", &mut problems)),
                        "72" | "92" | "93" | "97" => break, // next edge or next path
                        _ => {}
                    }
                    j += 1;
                }
                let ctrl: Vec<(f64, f64)> = ctrl_x.into_iter().zip(ctrl_y).collect();
                if let Some(piece) = parse_dxf_spline(degree, knots, ctrl, tol) {
                    current_path_pieces.push(piece);
                    found_edges += 1;
                }
            }
            _ => {} // Other codes are ignored
        }
    }

    // Flush the last path
    if !current_path_pieces.is_empty() {
        all_pieces.extend(chain_hatch_edges(&current_path_pieces, tol));
    }

    // What the FILE said it contained, against what came out. Both numbers were
    // already being parsed and neither was read.
    if num_paths > 0 && path_idx < num_paths {
        problems.push(format!(
            "HATCH declares {num_paths} boundary path(s) (DXF group code 91) and only {path_idx} \
             were read — the missing {} are NOT in the imported outline. A partial boundary is a \
             part missing a feature, and it looks exactly like a complete one downstream. Common \
             causes: the boundary is a block reference, or it uses an edge type this reader does \
             not model",
            num_paths - path_idx
        ));
    }
    if declared_edges > 0 && found_edges < declared_edges {
        problems.push(format!(
            "HATCH boundary paths declare {declared_edges} edge(s) in total (DXF group code 93) \
             and {found_edges} were read — {} edge(s) are missing from the imported outline",
            declared_edges - found_edges
        ));
    }

    (all_pieces, problems)
}

/// Find the next value for a given group code starting from position `from` in pairs.
/// Returns the first match, or None if not found before the next 0-code or end.
fn find_next_val(pairs: &[(String, String)], from: usize, code: &str) -> Option<f64> {
    for (k, v) in pairs.iter().skip(from) {
        if k == code {
            return v.parse().ok();
        }
        if k == "0" {
            break; // next entity
        }
    }
    None
}

/// Chain hatch edge pieces into closed contours.
///
/// HATCH boundary paths are closed by definition. We chain the edge pieces
/// (same as `chain()` for DXF/SVG imports) and force-close any open chains.
/// Returns the contours as Pieces for inclusion in the import.
fn chain_hatch_edges(pieces: &[Piece], tol: f64) -> Vec<Piece> {
    let pieces_vec: Vec<Piece> = pieces.to_vec();
    let (mut chained, _open) = chain(pieces_vec, tol);
    // Hatch boundaries are closed — force-close any open chains
    let mut result = Vec::new();
    for contour in &mut chained {
        if !contour.closed && contour.verts.len() >= 2 {
            let first = contour.verts[0];
            let last = contour.verts[contour.verts.len() - 1];
            if (first.x - last.x).abs() > 0.01 || (first.y - last.y).abs() > 0.01 {
                contour.verts.push(Vertex::line(first.x, first.y));
            }
            contour.closed = true;
        }
        // Accept contours with 2+ vertices (bulge-encoded arcs may have only 2)
        if contour.verts.len() >= 2 {
            result.push(Piece {
                verts: contour.verts.clone(),
                closed: contour.closed,
            });
        }
    }
    result
}

/// Strip MTEXT formatting codes from a text string.
///
/// MTEXT uses `{\fArial|b1|i0|c0|p2;...}`, `{\H...}`, `{\C...}`, `{\A1;...}`,
/// `\P` (paragraph break), `~` (non-breaking space), etc. This strips all
/// formatting and returns plain text.
fn strip_mtext_formatting(text: &str) -> String {
    let mut out = String::new();
    let mut skip_to_semicolon = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if skip_to_semicolon {
            if ch == ';' {
                skip_to_semicolon = false;
            }
            continue;
        }
        match ch {
            '{' => {
                // Skip directive content up to the first `;` inside this brace group.
                // MTEXT directives are like {\fArial|b1;i0|c0|p2;content} where the
                // first semicolon ends the font name, and subsequent `|`-separated
                // parts end at later semicolons. We skip everything up to the LAST
                // semicolon that's part of the directive (heuristic: skip to `;`).
                // This works for {\f...}, {\H...}, {\C...}, etc.
                skip_to_semicolon = true;
            }
            '}' => {} // end of brace group — already handled by skip_to_semicolon
            '\\' => {
                match chars.peek() {
                    Some('P') => { chars.next(); out.push('\n'); }
                    Some('L') => { chars.next(); out.push('\n'); }
                    Some('l' | 'o' | 'O' | 'p') => { chars.next(); } // skip
                    Some('\\') => { chars.next(); out.push('\\'); }
                    Some('{') => { chars.next(); out.push('{'); }
                    Some('}') => { chars.next(); out.push('}'); }
                    Some('~') => { chars.next(); out.push('\u{00A0}'); }
                    Some(&c) if "fFhHcCtTqQaAsSwWkK".contains(c) => {
                        // Skip formatting directive: \X... until ;
                        chars.next();
                        while let Some(&next) = chars.peek() {
                            chars.next();
                            if next == ';' {
                                break;
                            }
                        }
                    }
                    Some(';') => { chars.next(); } // empty escape
                    _ => { chars.next(); } // unknown — skip the escape char
                }
            }
            '~' => out.push('\u{00A0}'),
            _ => {
                out.push(ch);
            }
        }
    }
    out
}

/// receives a flat section cuts a plausible-looking WRONG part, so the returned
/// `unit_note` names the section and the Z on every mesh import.
pub fn parse_bytes(data: &[u8], height_mm: f64, z_section_mm: f64, tol: f64) -> Imported {
    if crate::mesh::looks_like_stl(data) {
        return crate::mesh::parse_stl_section(data, z_section_mm, tol);
    }
    if crate::mesh::looks_like_3mf(data) {
        return crate::mesh::parse_3mf_section(data, z_section_mm, tol);
    }
    let Ok(text) = std::str::from_utf8(data) else {
        let mut out = Imported::default();
        // Named rather than guessed at. Handing binary to the DXF reader
        // produces an empty import that reads exactly like a valid empty
        // drawing, which is the silent-drop failure this module exists to stop.
        out.unsupported.push(
            "the file is binary and is not an STL or 3MF — it was NOT imported (DXF, SVG and OBJ are text)".into(),
        );
        return out;
    };
    // STEP is detected BEFORE OBJ/SVG/DXF so that it can be REFUSED BY NAME.
    // Letting it fall through to the DXF reader returns an empty import, which
    // is indistinguishable from a valid empty drawing — the silent-drop failure
    // this module exists to stop. See `mesh::refuse_step` for why there is no
    // longer a reader behind this branch.
    if crate::mesh::looks_like_step(text) {
        return crate::mesh::refuse_step();
    }
    // OBJ is detected by content (v + f lines), not by extension.
    // Check before SVG/DXF because an OBJ file could contain "<svg" in a comment.
    if crate::mesh::looks_like_obj(text) {
        return crate::mesh::parse_obj_section(text, z_section_mm, tol);
    }
    if text.contains("<svg") {
        parse_svg(text, height_mm, tol)
    } else {
        parse_dxf(text, tol)
    }
}

/// Sort imported contours into parts: the largest enclosing loop is the outer,
/// anything inside it is a hole.
///
/// 🔴 The hierarchy is the whole point. A flat list of loops has no way to say
/// "this circle is a hole in that plate", and a CAM that guesses will cut the
/// hole as a separate part.
pub fn to_parts(imported: &Imported, name_prefix: &str) -> Vec<Part> {
    let closed: Vec<&Contour> = imported.contours.iter().filter(|c| c.closed).collect();
    let mut with_area: Vec<(f64, &Contour)> = closed
        .iter()
        .map(|c| (c.signed_area().abs(), *c))
        .filter(|(a, _)| *a > 1e-9)
        .collect();
    with_area.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

    let mut parts: Vec<Part> = Vec::new();
    let mut used = vec![false; with_area.len()];

    for i in 0..with_area.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let outer = with_area[i].1.clone();
        let ob = outer.bounds();
        let mut part = Part::new(format!("{name_prefix}{}", parts.len() + 1), outer);
        for j in (i + 1)..with_area.len() {
            if used[j] {
                continue;
            }
            let (Some(o), Some(inner)) = (ob, with_area[j].1.bounds()) else { continue };
            // Containment by bounding box. Exact containment needs a
            // point-in-polygon test per candidate; for the flat parts this
            // toolchain cuts, a bbox test has never been the limiting factor —
            // and where it would be, the parts overlap and the drawing is
            // ambiguous anyway.
            if inner.0 >= o.0 && inner.1 >= o.1 && inner.2 <= o.2 && inner.3 <= o.3 {
                used[j] = true;
                part = part.with_hole(with_area[j].1.clone());
            }
        }
        parts.push(part);
    }
    parts
}

#[cfg(test)]
mod tests {

    /// 🔴 A MALFORMED BLOCK BASE POINT IS REPORTED, NOT PLACED AT THE ORIGIN.
    ///
    /// The base point anchors every INSERT of that block, so a silent 0.0 does
    /// not lose a vertex — it SHIFTS THE WHOLE SUB-ASSEMBLY by the base it
    /// should have had, and every downstream check still sees a coherent
    /// outline. ⚠ Both directions, because a notice that fires on every import
    /// stops being read.
    #[test]
    fn a_malformed_block_base_point_is_reported_and_a_good_one_is_not() {
        let dxf = |x: &str| -> String {
            format!(
                "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nWIDGET\n10\n{x}\n20\n0.0\n\
                 0\nLINE\n10\n0.0\n20\n0.0\n11\n10.0\n21\n0.0\n0\nENDBLK\n\
                 0\nENDSEC\n0\nEOF\n"
            )
        };

        let bad = parse_dxf(&dxf("not-a-number"), 0.01);
        assert!(
            bad.unsupported.iter().any(|u| u.contains("base point") && u.contains("EVERY INSERT")),
            "a corrupt BLOCK base point imported silently: {:?}",
            bad.unsupported
        );

        let good = parse_dxf(&dxf("5.0"), 0.01);
        assert!(
            !good.unsupported.iter().any(|u| u.contains("base point")),
            "a VALID base point was reported as malformed — the notice would fire on every import \
             and stop being read: {:?}",
            good.unsupported
        );
    }

    /// 🔴 A PRESENT-BUT-UNPARSEABLE COORDINATE IS REPORTED, NOT SILENTLY ZEROED.
    ///
    /// `value.parse().unwrap_or(0.0)` turned a corrupt X into a real vertex at
    /// the ORIGIN. The edge COUNT still reconciled — group code 93's declared
    /// total against edges read — because a malformed edge still increments the
    /// count, so the existing check could not see it. On a machine that vertex
    /// is a move to (0, 0) across the bed.
    ///
    /// ⚠ Both directions: a GOOD coordinate must report nothing, or the notice
    /// fires on every import and stops being read.
    #[test]
    fn a_malformed_hatch_coordinate_is_reported_and_a_good_one_is_not() {
        let pairs = |x: &str| -> Vec<(String, String)> {
            vec![
                ("92", "1"), ("93", "1"), ("72", "1"),
                ("10", x), ("20", "0.0"), ("11", "10.0"), ("21", "0.0"),
            ]
            .into_iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
        };

        let (_, problems) = parse_hatch_pairs(&pairs("not-a-number"), 0.01);
        assert!(
            problems.iter().any(|p| p.contains("not a number") && p.contains("ORIGIN")),
            "a corrupt HATCH coordinate imported silently: {problems:?}"
        );

        let (_, clean) = parse_hatch_pairs(&pairs("5.0"), 0.01);
        assert!(
            !clean.iter().any(|p| p.contains("not a number")),
            "a VALID coordinate was reported as malformed — the notice would fire on every \
             import and stop being read: {clean:?}"
        );
    }

    use super::*;

    /// A HATCH declaring TWO boundary paths and carrying only one, and declaring
    /// four edges while carrying two. Both shortfalls must be NAMED.
    ///
    /// 🔴 Before 2026-08-28 this imported one square and said nothing: the
    /// declared counts (group codes 91 and 93) were parsed into variables the
    /// compiler had been reporting as unused, and the function closed with the
    /// comment *"If we found fewer paths than declared, don't warn — just use
    /// what we got."* A partial boundary is a part missing a feature and it
    /// looks exactly like a complete one downstream.
    const SHORT_HATCH_DXF: &str = "\
0\nSECTION\n2\nENTITIES\n\
0\nHATCH\n91\n2\n\
92\n1\n93\n4\n\
72\n1\n10\n0.0\n20\n0.0\n11\n10.0\n21\n0.0\n\
72\n1\n10\n10.0\n20\n0.0\n11\n10.0\n21\n10.0\n\
0\nENDSEC\n0\nEOF\n";

    /// A block holding one LINE the reader understands and one SOLID it does
    /// not, inserted twice.
    const BLOCK_WITH_UNREADABLE_DXF: &str = "\
0\nSECTION\n2\nBLOCKS\n\
0\nBLOCK\n2\nHINGE\n10\n0.0\n20\n0.0\n\
0\nLINE\n10\n0.0\n20\n0.0\n11\n10.0\n21\n0.0\n\
0\nSOLID\n10\n0.0\n20\n0.0\n11\n5.0\n21\n5.0\n\
0\nENDBLK\n\
0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n\
0\nINSERT\n2\nHINGE\n10\n0.0\n20\n0.0\n\
0\nINSERT\n2\nHINGE\n10\n50.0\n20\n0.0\n\
0\nENDSEC\n0\nEOF\n";

    /// A POLYLINE flagged as a mesh, with vertices that read perfectly well as a
    /// closed 2D outline — which is the trap.
    fn mesh_polyline_dxf(flag70: i64) -> String {
        let mut s = String::from("0\nSECTION\n2\nENTITIES\n");
        s.push_str(&format!("0\nPOLYLINE\n70\n{flag70}\n"));
        for (x, y) in [(100.0, 100.0), (300.0, 100.0), (300.0, 250.0), (100.0, 250.0), (180.0, 160.0)] {
            s.push_str(&format!("0\nVERTEX\n10\n{x:.1}\n20\n{y:.1}\n"));
        }
        s.push_str("0\nSEQEND\n0\nENDSEC\n0\nEOF\n");
        s
    }

    /// A 40mm square whose first side is a quarter arc (`bulge = tan(90/4)`),
    /// wrapped in a block and INSERTed at the given scale.
    fn arc_block_insert(sx: f64, sy: f64) -> String {
        format!(
            "0\nSECTION\n2\nBLOCKS\n\
0\nBLOCK\n2\nARCBLK\n10\n0.0\n20\n0.0\n\
0\nLWPOLYLINE\n70\n1\n10\n0.0\n20\n0.0\n42\n0.4142\n10\n40.0\n20\n0.0\n10\n40.0\n20\n40.0\n10\n0.0\n20\n40.0\n\
0\nENDBLK\n0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n\
0\nINSERT\n2\nARCBLK\n10\n100.0\n20\n100.0\n41\n{sx}\n42\n{sy}\n\
0\nENDSEC\n0\nEOF\n"
        )
    }

    fn insert_area(sx: f64, sy: f64) -> f64 {
        parse_dxf(&arc_block_insert(sx, sy), 0.01)
            .contours
            .iter()
            .map(|c| c.signed_area().abs())
            .sum()
    }

    #[test]
    fn a_mirrored_insert_preserves_area_because_the_bulge_reverses_with_it() {
        // 🔴 A `bulge` is `tan(sweep / 4)` — a shape factor — and it was carried
        // through a mirror unchanged, leaving the arc bulging the WRONG WAY: a
        // fillet curving out where it should curve in. MEASURED before the fix,
        // and a mirror MUST preserve area:
        //
        //   sx= 1 sy= 1  |area| = 1828.31   baseline
        //   sx=-1 sy= 1  |area| = 1371.69   <- 456.62 out, exactly 2x the segment
        //   sx= 1 sy=-1  |area| = 1371.69   <- same, other axis
        //
        // No note of any kind on either.
        let base = insert_area(1.0, 1.0);
        assert!(base > 1000.0, "the block did not import: {base}");
        for (sx, sy) in [(-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
            let got = insert_area(sx, sy);
            assert!(
                (got - base).abs() < 1e-6,
                "INSERT mirrored (x{sx}, y{sy}) gave |area| {got:.2} against the unmirrored \
                 {base:.2}. A mirror cannot change area — the arc is bulging the wrong way, which \
                 is a real closed contour of a part nobody drew"
            );
        }
        // A UNIFORM scale is the case the old comment was right about.
        assert!(
            (insert_area(2.0, 2.0) - base * 4.0).abs() < 1e-6,
            "a uniform 2x scale must give 4x the area"
        );
    }

    #[test]
    fn a_non_uniform_insert_refuses_an_arc_and_still_takes_straight_lines() {
        // A non-uniform scale makes a circular arc ELLIPTICAL, which a bulge
        // cannot express. Measured before the fix: sx=2 sy=1 gave |area| 4113.24
        // where 2x the baseline is 3656.62 — the arc stayed circular. Silent.
        let r = parse_dxf(&arc_block_insert(2.0, 1.0), 0.01);
        assert!(
            r.contours.is_empty(),
            "a non-uniformly scaled arc was imported as a circle of the wrong shape"
        );
        assert!(
            r.unsupported.iter().any(|u| u.contains("non-uniformly") && u.contains("ARC")),
            "the refusal must name the scale AND the arc: {:?}",
            r.unsupported
        );

        // Specificity: straight segments scale non-uniformly without trouble, so
        // a block with no bulges must still import. A refusal that caught every
        // non-uniform INSERT would take a working case away.
        let square = "0\nSECTION\n2\nBLOCKS\n\
0\nBLOCK\n2\nSQ\n10\n0.0\n20\n0.0\n\
0\nLWPOLYLINE\n70\n1\n10\n0.0\n20\n0.0\n10\n40.0\n20\n0.0\n10\n40.0\n20\n40.0\n10\n0.0\n20\n40.0\n\
0\nENDBLK\n0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n\
0\nINSERT\n2\nSQ\n10\n100.0\n20\n100.0\n41\n2.0\n42\n1.0\n\
0\nENDSEC\n0\nEOF\n";
        let plain = parse_dxf(square, 0.01);
        assert!(
            !plain.contours.is_empty(),
            "a straight-sided block was refused for a non-uniform scale it handles fine: {:?}",
            plain.unsupported
        );
        let a: f64 = plain.contours.iter().map(|c| c.signed_area().abs()).sum();
        assert!(
            (a - 40.0 * 2.0 * 40.0).abs() < 1e-6,
            "the stretched square should be 80x40 = 3200, got {a:.2}"
        );
    }

    #[test]
    fn an_arc_sweeps_the_way_dxf_says_including_past_180_and_through_zero() {
        // ⚠ A CLEAN RESULT, KEPT ANYWAY. Probed 2026-08-29 expecting the two
        // classic arc bugs — a sweep that wraps through 0 degrees, and one over
        // 180 that a single bulge cannot hold. Neither is present: the reader
        // splits a >180 arc into two <=180 segments, which is correct and was
        // briefly mistaken for a defect by reading only the FIRST bulge (135
        // where 270 was expected) before summing them.
        //
        // It is written down because F1's `plate.dxf` contains no ARC at all, so
        // nothing in the gate suite would notice either case regressing — and a
        // correct behaviour with no test is one refactor from being an incorrect
        // one. DXF arcs sweep COUNTERCLOCKWISE from code 50 to code 51.
        for (a0, a1, expect) in [
            (0.0, 90.0, 90.0),
            (350.0, 10.0, 20.0),   // wraps through zero
            (90.0, 0.0, 270.0),    // the long way round, needs splitting
            (0.0, 350.0, 350.0),   // nearly a full turn
        ] {
            let dxf = format!(
                "0\nSECTION\n2\nENTITIES\n0\nARC\n10\n50.0\n20\n50.0\n40\n20.0\n50\n{a0}\n51\n{a1}\n0\nENDSEC\n0\nEOF\n"
            );
            let r = parse_dxf(&dxf, 0.01);
            let total: f64 = r
                .contours
                .iter()
                .flat_map(|c| c.verts.iter())
                .map(|v| 4.0 * v.bulge.atan().to_degrees())
                .sum();
            assert!(
                (total - expect).abs() < 1e-6,
                "ARC {a0} -> {a1} swept {total:.3} degrees, expected {expect}. Summed over EVERY \
                 bulge, because a sweep over 180 is split into two segments and reading one of \
                 them reports half the arc"
            );
        }
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // 🔴 ABOVE `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line
    // directly above a cited function to decide whether it is a test at all.
    #[allow(non_snake_case)]
    #[test]
    fn a_bulge_on_the_CLOSING_segment_is_not_dropped() {
        // ⚠ Also clean, also kept. The wrap-around segment (last vertex back to
        // the first) is where a polyline reader most commonly loses a bulge, and
        // the failure is silent: a rounded corner comes through square, the part
        // still closes, and nothing downstream can tell. F1's fixture has no
        // bulge anywhere.
        let square_side = 40.0;
        let plain = square_side * square_side;
        let with_arc = |bulge_on_last: bool| {
            let mut s = String::from("0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n70\n1\n");
            let pts = [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)];
            for (i, (x, y)) in pts.iter().enumerate() {
                s.push_str(&format!("10\n{x:.1}\n20\n{y:.1}\n"));
                let carries = if bulge_on_last { i == pts.len() - 1 } else { i == 0 };
                if carries {
                    s.push_str("42\n0.4142\n");
                }
            }
            s.push_str("0\nENDSEC\n0\nEOF\n");
            parse_dxf(&s, 0.01)
                .contours
                .iter()
                .map(|c| c.signed_area().abs())
                .sum::<f64>()
        };
        let on_last = with_arc(true);
        let on_first = with_arc(false);
        assert!(
            (on_last - on_first).abs() < 1e-6,
            "a bulge on the CLOSING segment gave area {on_last:.2} and the same bulge on the first \
             segment gave {on_first:.2} — the wrap-around arc was dropped, which comes through as \
             a square corner where the drawing has a round one"
        );
        assert!(
            on_last > plain + 100.0,
            "neither placement produced an arc at all: {on_last:.2} against a plain square {plain:.2}"
        );
    }

    #[test]
    fn a_dxf_polyline_that_is_actually_a_mesh_is_refused_not_read_as_an_outline() {
        // 🔴 MEASURED BEFORE THE FIX: a polyface mesh (`70 = 65`, i.e. 64|1)
        // placed inside the sheet imported as a closed outline and emitted
        // **10,399 bytes of runnable G-code, ok: true**, with nothing anywhere
        // saying it was a mesh. Code 70 is a BIT FIELD and only bit 1 (closed)
        // was ever read; bits 8/16/64 say the VERTEX records are mesh data —
        // positions and face indices — and not a planar outline.
        //
        // ⚠ The first probe of this looked safe only because its coordinates
        // fell outside the machine's travel. It was caught by the travel check,
        // for the wrong reason and by luck — which is why the fixture here sits
        // well inside the sheet.
        for (flag, what) in [(64 | 1, "POLYFACE MESH"), (16 | 1, "POLYGON MESH"), (8 | 1, "3D POLYLINE")] {
            let r = parse_dxf(&mesh_polyline_dxf(flag), 0.01);
            assert!(
                r.contours.is_empty(),
                "70={flag} ({what}) produced {} contour(s) — mesh vertices read as an outline is a \
                 real closed shape that is not in the drawing, and it posts and cuts like any other",
                r.contours.len()
            );
            assert!(
                r.unsupported.iter().any(|u| u.contains(what) && u.contains("NOT imported")),
                "70={flag} must be NAMED as {what}: {:?}",
                r.unsupported
            );
        }

        // Specificity: an ordinary closed 2D polyline still imports. A refusal
        // that catches every POLYLINE would take the commonest entity in DXF
        // out of the tool.
        let plain = parse_dxf(&mesh_polyline_dxf(1), 0.01);
        assert!(
            !plain.contours.is_empty(),
            "an ordinary closed 2D POLYLINE (70=1) was refused: {:?}",
            plain.unsupported
        );
    }

    #[test]
    fn a_stray_vertex_does_not_graft_itself_onto_the_previous_entity() {
        // `pieces.last_mut()` appended a VERTEX to whatever piece happened to be
        // last, so a VERTEX with no POLYLINE open — a malformed file, or one
        // whose POLYLINE was just refused — silently changed an unrelated
        // entity's shape.
        let dxf = "0\nSECTION\n2\nENTITIES\n\
0\nARC\n10\n50.0\n20\n50.0\n40\n20.0\n50\n0.0\n51\n90.0\n\
0\nVERTEX\n10\n999.0\n20\n999.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.01);
        assert!(
            r.unsupported.iter().any(|u| u.contains("VERTEX") && u.contains("no POLYLINE")),
            "the orphan VERTEX must be named: {:?}",
            r.unsupported
        );
        // And it must not have reached the arc: 999,999 is far outside it.
        // `open_contours` is a COUNT, so the closed set is what can be inspected
        // — and the arc plus a grafted vertex is exactly what would close.
        for c in &r.contours {
            assert!(
                !c.verts.iter().any(|v| v.x > 900.0 || v.y > 900.0),
                "the orphan VERTEX was grafted onto another entity: {:?}",
                c.verts
            );
        }
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // 🔴 ABOVE `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line
    // directly above a cited function to decide whether it is a test at all.
    #[allow(non_snake_case)]
    #[test]
    fn the_svg_y_flip_uses_the_DRAWING_height_not_the_workpiece_height() {
        // 🔴 MEASURED BEFORE THE FIX, `gates/fixtures/plate.svg` (height="900"),
        // same drawing and same cutter, only the WORKPIECE height changed:
        //
        //   stock 600x900 -> ok, 9452 bytes, Y in [ 47.0, 173.0]
        //   stock 600x950 -> ok, 9492 bytes, Y in [ 97.0, 223.0]  <- 50mm out
        //   stock 600x700 ->     Y in [-153.0, -27.0]             <- off the sheet
        //
        // The 950 case is the dangerous one: `ok: true`, no refusal, no note, a
        // complete plausible program for a part 50mm from where the drawing puts
        // it. Change the workpiece and the part moved.
        //
        // Gate F1 could not see it: `plate.svg` declares height="900" and the
        // reference workpiece is 900 tall, so the wrong number and the right one
        // were the same number on the only SVG the gate has ever read.
        let svg = r#"<svg width="200" height="120"><rect x="10" y="20" width="40" height="30"/></svg>"#;

        // The workpiece argument is varied across values that are nothing like
        // the drawing's height. The geometry must not move by any of them.
        let base: Vec<(f64, f64)> = parse_svg(svg, 120.0, 0.01).contours[0]
            .verts
            .iter()
            .map(|v| (v.x, v.y))
            .collect();
        assert!(!base.is_empty(), "the rect did not import");
        for workpiece_h in [1.0, 120.0, 300.0, 4000.0] {
            let got: Vec<(f64, f64)> = parse_svg(svg, workpiece_h, 0.01).contours[0]
                .verts
                .iter()
                .map(|v| (v.x, v.y))
                .collect();
            assert_eq!(
                got, base,
                "the imported geometry MOVED when the workpiece height changed to {workpiece_h} — \
                 the Y flip is reading the workpiece instead of the drawing, so changing the sheet \
                 moves the part while every contour still looks correct"
            );
        }

        // And it flips about the DRAWING's height: svg y=20 with height=120
        // must land at machine y=100.
        assert!(
            base.iter().any(|(_, y)| (*y - 100.0).abs() < 1e-9),
            "the flip is not about the drawing's own height: {base:?}"
        );
    }

    #[test]
    fn an_svg_with_no_declared_coordinate_space_is_refused_rather_than_guessed() {
        // Neither `viewBox` nor `height`: the drawing's own space is unknown, so
        // any flip value is a guess — and a guess MOVES THE PART while every
        // contour still looks correct. Refused by name instead.
        let r = parse_svg(r#"<svg><rect x="10" y="20" width="40" height="30"/></svg>"#, 120.0, 0.01);
        assert!(r.contours.is_empty(), "geometry was imported from a guess");
        assert!(
            r.unsupported.iter().any(|u| u.contains("viewBox") && u.contains("NOT imported")),
            "the refusal must name what is missing: {:?}",
            r.unsupported
        );
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // 🔴 ABOVE `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line
    // directly above a cited function to decide whether it is a test at all.
    #[allow(non_snake_case)]
    #[test]
    fn a_viewBox_defines_the_coordinate_space_and_beats_a_physical_height() {
        // `height="210mm" viewBox="0 0 100 50"` is an ordinary pairing: the
        // geometry is written in the viewBox's user units, and the height is a
        // physical size in different units entirely. Reading `height` there
        // would flip about 210 and put the part 160 units away.
        let svg = r#"<svg width="297mm" height="210mm" viewBox="0 0 100 50"><rect x="10" y="10" width="20" height="10"/></svg>"#;
        let r = parse_svg(svg, 999.0, 0.01);
        assert!(!r.contours.is_empty(), "the rect did not import: {:?}", r.unsupported);
        let ys: Vec<f64> = r.contours[0].verts.iter().map(|v| v.y).collect();
        assert!(
            ys.iter().any(|y| (*y - 40.0).abs() < 1e-9),
            "svg y=10 in a 50-tall viewBox must flip to 40, got {ys:?} — the reader used the \
             physical height instead of the user-unit space"
        );
    }

    #[test]
    fn an_svg_transform_is_refused_because_this_reader_does_not_apply_one() {
        // 🔴 Before 2026-08-29 this imported the rect at its UNTRANSFORMED
        // coordinates and said nothing. `transform=` is parsed nowhere in this
        // file, so a `<g transform="translate(...)">` — what every drawing tool
        // emits for a moved group — produced real contours in the wrong place:
        // they post, simulate and gate green, and cut a plausible wrong part.
        let svg = "<svg width=\"200\" height=\"100\">\
<g transform=\"translate(50,20)\">\
<rect x=\"10\" y=\"10\" width=\"40\" height=\"30\"/>\
</g></svg>";
        let r = parse_svg(svg, 100.0, 0.01);
        assert!(
            r.contours.is_empty(),
            "a drawing whose transforms cannot be applied must import NOTHING, not geometry at \
             the wrong coordinates: {} contour(s)",
            r.contours.len()
        );
        let said = r.unsupported.join(" | ");
        assert!(
            said.contains("transform") && said.contains("NOT imported"),
            "the refusal must name `transform` and say nothing was imported: {:?}",
            r.unsupported
        );
        assert!(
            said.contains("translate(50,20)"),
            "the refusal must quote the transform it found, so the operator can locate it: {:?}",
            r.unsupported
        );
    }

    #[test]
    fn an_svg_with_no_transform_still_imports_and_a_line_is_geometry_now() {
        // Specificity: the refusal must not fire on an ordinary drawing. And
        // `<line>` was in the silent catch-all until 2026-08-29 — it is the
        // shape a drawing tool emits for an open profile or a construction edge.
        let svg = "<svg width=\"200\" height=\"100\">\
<rect x=\"10\" y=\"10\" width=\"40\" height=\"30\"/>\
<line x1=\"0\" y1=\"0\" x2=\"60\" y2=\"0\"/>\
</svg>";
        let r = parse_svg(svg, 100.0, 0.01);
        assert!(
            !r.unsupported.iter().any(|u| u.contains("transform")),
            "an ordinary drawing was refused for a transform it does not have: {:?}",
            r.unsupported
        );
        assert!(
            !r.contours.is_empty() || r.open_contours > 0,
            "the rect and the line produced no geometry at all"
        );
    }

    #[test]
    fn an_unknown_svg_element_is_named_and_a_structural_one_is_not() {
        let svg = "<svg width=\"200\" height=\"100\">\
<defs><title>t</title></defs>\
<rect x=\"10\" y=\"10\" width=\"40\" height=\"30\"/>\
<image href=\"x.png\" x=\"0\" y=\"0\" width=\"10\" height=\"10\"/>\
</svg>";
        let r = parse_svg(svg, 100.0, 0.01);
        let said = r.unsupported.join(" | ");
        assert!(
            said.contains("<image>"),
            "an element carrying content this reader cannot use must be NAMED: {:?}",
            r.unsupported
        );
        for structural in ["<svg>", "<defs>", "<title>", "</g>"] {
            assert!(
                !said.contains(structural),
                "{structural} carries no geometry — naming it would put a note on every drawing, \
                 and a warning that always fires is a warning nobody reads: {:?}",
                r.unsupported
            );
        }
    }

    #[test]
    fn an_entity_inside_a_block_that_cannot_be_read_is_named_at_the_insert() {
        // 🔴 Before 2026-08-29 this imported the LINE and said NOTHING about the
        // SOLID. The top-level entity loop has always ended in
        // `other => "{other} is not supported and was NOT imported"`; the BLOCK
        // loop ended in `_ => {}` under the comment "Other entities in blocks
        // are silently skipped". Blocks are exactly where a CAD tool puts a
        // repeated feature, so the entity most likely to appear many times in
        // one drawing was the one class dropped without a word.
        let r = parse_dxf(BLOCK_WITH_UNREADABLE_DXF, 0.01);
        let said = r.unsupported.join(" | ");
        assert!(
            said.contains("HINGE") && said.contains("SOLID"),
            "the unreadable entity must be named WITH ITS BLOCK — \"SOLID is not supported\" is \
             not actionable and \"block 'HINGE' contains SOLID\" is: {:?}",
            r.unsupported
        );
        assert!(
            said.contains("NOT imported"),
            "the note must say the geometry is missing, not merely that a type is unknown: {:?}",
            r.unsupported
        );
        // The fact is about the BLOCK, so inserting it twice must not say it
        // twice — a note repeated per placement trains people to skim them.
        assert_eq!(
            r.unsupported.iter().filter(|u| u.contains("SOLID")).count(),
            1,
            "the same block defect was reported once per INSERT: {:?}",
            r.unsupported
        );
        // And the geometry it COULD read still arrives, twice.
        assert!(
            !r.contours.is_empty() || r.open_contours > 0,
            "naming the unreadable entity must not cost the readable one"
        );
    }

    #[test]
    fn a_block_this_reader_fully_understands_says_nothing() {
        // Specificity. `ENDBLK`/`SEQEND`/`ATTDEF`/`ATTRIB` are structural
        // markers, not geometry — a reader that reported them would emit a note
        // on every block in every drawing, and a warning that always fires is a
        // warning nobody reads.
        let clean = "\
0\nSECTION\n2\nBLOCKS\n\
0\nBLOCK\n2\nTAB\n10\n0.0\n20\n0.0\n\
0\nLINE\n10\n0.0\n20\n0.0\n11\n10.0\n21\n0.0\n\
0\nENDBLK\n\
0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n\
0\nINSERT\n2\nTAB\n10\n0.0\n20\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(clean, 0.01);
        assert!(
            !r.unsupported.iter().any(|u| u.contains("block '")),
            "a block this reader fully understands must produce no note: {:?}",
            r.unsupported
        );
    }

    #[test]
    fn a_hatch_that_declares_more_than_it_carries_is_named_not_silently_shortened() {
        let r = parse_dxf(SHORT_HATCH_DXF, 0.01);
        let said = r.unsupported.join(" | ");
        assert!(
            said.contains("boundary path(s)") && said.contains("NOT in the imported outline"),
            "the missing boundary path must be NAMED with both counts: {:?}",
            r.unsupported
        );
        assert!(
            said.contains("edge(s) in total"),
            "the missing edges must be NAMED too — the two counts are separate facts and only \
             reporting one of them leaves the other silent: {:?}",
            r.unsupported
        );
    }

    #[test]
    fn a_hatch_that_carries_what_it_declares_says_nothing() {
        // Specificity, not just sensitivity: a check that fires on a complete
        // HATCH is a check people learn to ignore. One path, two edges, both
        // declared and both read.
        let full = "\
0\nSECTION\n2\nENTITIES\n\
0\nHATCH\n91\n1\n\
92\n1\n93\n2\n\
72\n1\n10\n0.0\n20\n0.0\n11\n10.0\n21\n0.0\n\
72\n1\n10\n10.0\n20\n0.0\n11\n10.0\n21\n10.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(full, 0.01);
        assert!(
            !r.unsupported.iter().any(|u| u.contains("HATCH declares")),
            "a HATCH that carries what it declares must produce no shortfall note: {:?}",
            r.unsupported
        );
    }

    const PLATE_DXF: &str = "\
0\nSECTION\n2\nENTITIES\n\
0\nLINE\n10\n0.0\n20\n0.0\n11\n100.0\n21\n0.0\n\
0\nLINE\n10\n100.0\n20\n0.0\n11\n100.0\n21\n50.0\n\
0\nLINE\n10\n100.0\n20\n50.0\n11\n0.0\n21\n50.0\n\
0\nLINE\n10\n0.0\n20\n50.0\n11\n0.0\n21\n0.0\n\
0\nCIRCLE\n10\n25.0\n20\n25.0\n40\n5.0\n\
0\nCIRCLE\n10\n75.0\n20\n25.0\n40\n5.0\n\
0\nENDSEC\n0\nEOF\n";

    #[test]
    fn a_dxf_line_soup_chains_into_one_closed_outline() {
        let r = parse_dxf(PLATE_DXF, 0.01);
        assert!(r.unsupported.is_empty(), "{:?}", r.unsupported);
        assert_eq!(r.open_contours, 0, "the outline did not close");
        let closed: Vec<&Contour> = r.contours.iter().filter(|c| c.closed).collect();
        assert_eq!(closed.len(), 3, "expected 1 outline + 2 circles, got {}", closed.len());
    }

    #[test]
    fn holes_become_holes_and_not_separate_parts() {
        // 🔴 The failure this prevents: two circles imported as their own parts,
        // cut as discs, and the plate cut with no holes.
        let r = parse_dxf(PLATE_DXF, 0.01);
        let parts = to_parts(&r, "part");
        assert_eq!(parts.len(), 1, "expected one part, got {}", parts.len());
        assert_eq!(parts[0].inners.len(), 2, "the holes were not attached to the plate");
        assert!(parts[0].outer.signed_area() > 0.0);
        assert!(parts[0].inners.iter().all(|h| h.signed_area() < 0.0));
    }

    #[test]
    fn an_unsupported_entity_is_reported_by_name_not_dropped() {
        // 🔴 The whole reason this module returns two lists.
        let dxf = "0\nSECTION\n2\nENTITIES\n0\nSPLINE\n10\n0.0\n20\n0.0\n0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.01);
        assert_eq!(r.contours.len(), 0);
        assert_eq!(r.unsupported.len(), 1);
        assert!(r.unsupported[0].contains("SPLINE"), "{:?}", r.unsupported);
        assert!(r.unsupported[0].contains("NOT imported"));
    }

    #[test]
    fn an_unclosed_outline_is_counted_not_silently_closed() {
        let dxf = "0\nSECTION\n2\nENTITIES\n\
0\nLINE\n10\n0.0\n20\n0.0\n11\n100.0\n21\n0.0\n\
0\nLINE\n10\n100.0\n20\n0.0\n11\n100.0\n21\n50.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.01);
        assert_eq!(r.open_contours, 1, "an open chain was reported as closed");
    }

    #[test]
    fn a_dxf_arc_survives_as_an_arc() {
        // A quarter arc must come back with a bulge, not as a chord: this is
        // what keeps G2/G3 alive through the whole pipeline.
        let dxf =
            "0\nSECTION\n2\nENTITIES\n0\nARC\n10\n0.0\n20\n0.0\n40\n10.0\n50\n0.0\n51\n90.0\n0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.01);
        let arcs: usize = r
            .contours
            .iter()
            .map(|c| c.verts.iter().filter(|v| v.bulge.abs() > 1e-9).count())
            .sum();
        assert!(arcs >= 1, "the arc was flattened to a line on import");
    }

    #[test]
    fn lwpolyline_bulges_land_on_the_right_vertices() {
        // 🔴 Bulges are SPARSE in a DXF — only the vertices that have one carry
        // a code 42. Zipping the 42s positionally against the 10s puts every arc
        // on the wrong segment, which is invisible on a symmetric shape.
        let dxf = "0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n70\n1\n\
10\n0.0\n20\n0.0\n\
10\n10.0\n20\n0.0\n42\n0.5\n\
10\n10.0\n20\n10.0\n\
10\n0.0\n20\n10.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.01);
        let c = r.contours.iter().find(|c| c.closed).expect("no closed polyline");
        assert_eq!(c.verts.len(), 4);
        assert!((c.verts[1].bulge - 0.5).abs() < 1e-9, "bulge landed on vertex {:?}",
                c.verts.iter().map(|v| v.bulge).collect::<Vec<_>>());
        assert!(c.verts[0].bulge.abs() < 1e-9);
        assert!(c.verts[2].bulge.abs() < 1e-9);
    }

    #[test]
    fn an_inch_drawing_is_scaled_and_a_unitless_one_says_so() {
        // 🔴 The silent version of this defect makes every dimension wrong by
        // the same factor, so the shape is perfect and only a ruler disagrees.
        let inches = "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n\
0\nLWPOLYLINE\n70\n1\n10\n0.0\n20\n0.0\n10\n1.0\n20\n0.0\n10\n1.0\n20\n1.0\n10\n0.0\n20\n1.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(inches, 0.01);
        assert!(r.unit_note.contains("inches"), "{}", r.unit_note);
        let (x0, _, x1, _) = r.contours[0].bounds().unwrap();
        assert!((x1 - x0 - 25.4).abs() < 1e-6, "a 1 inch square imported as {}mm", x1 - x0);

        // No $INSUNITS: mm is assumed, and the assumption is stated.
        let r2 = parse_dxf(PLATE_DXF, 0.01);
        assert!(r2.unit_note.contains("ASSUMED"), "the assumption was silent: {}", r2.unit_note);
    }

    #[test]
    fn scaling_does_not_open_out_the_arcs() {
        // Bulge is a ratio. Scaling it as if it were a length turns every arc
        // into a different arc, which is invisible next to a scaled outline.
        let inches = "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n1\n0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n10\n1.0\n20\n1.0\n40\n0.5\n0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(inches, 0.01);
        let c = &r.contours[0];
        assert!(c.verts.iter().all(|v| (v.bulge.abs() - 1.0).abs() < 1e-9), "bulges were scaled");
        let (x0, _, x1, _) = c.bounds().unwrap();
        assert!((x1 - x0 - 25.4).abs() < 1e-6, "1 inch circle imported as {}mm across", x1 - x0);
    }

    #[test]
    fn svg_y_axis_is_flipped_into_machine_coordinates() {
        // 🔴 SVG's Y points DOWN. Importing without the flip mirrors every part,
        // which is invisible on a symmetric outline and wrong on every other one.
        let svg = r#"<svg height="100"><rect x="10" y="20" width="30" height="40"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.01);
        assert_eq!(r.contours.len(), 1);
        let (x0, y0, x1, y1) = r.contours[0].bounds().unwrap();
        assert!((x0 - 10.0).abs() < 1e-9 && (x1 - 40.0).abs() < 1e-9);
        // Top edge at SVG y=20 is 80 from the bottom; the rect spans 40..80.
        assert!((y0 - 40.0).abs() < 1e-9, "y0 {y0}");
        assert!((y1 - 80.0).abs() < 1e-9, "y1 {y1}");
    }

    #[test]
    fn svg_shapes_and_paths_import() {
        let svg = r#"<svg height="100">
          <circle cx="50" cy="50" r="10"/>
          <polygon points="0,0 20,0 20,20 0,20"/>
          <path d="M 5 5 L 15 5 L 15 15 Z"/>
        </svg>"#;
        let r = parse_svg(svg, 100.0, 0.01);
        assert!(r.unsupported.is_empty(), "{:?}", r.unsupported);
        assert_eq!(r.contours.iter().filter(|c| c.closed).count(), 3);
    }

    #[test]
    fn the_dispatch_reads_the_content_and_not_the_extension() {
        // 🔴 The case that makes this content-sniffed rather than name-sniffed:
        // a BINARY STL whose 80-byte header begins with the text "solid". Named
        // `part.stl` or `part.dxf` or nothing at all, it must reach the SECTION
        // path — routing it to the DXF reader yields an empty drawing, which
        // reads downstream exactly like a part with no features.
        let mut stl = vec![0u8; 80];
        stl[..5].copy_from_slice(b"solid");
        stl.extend_from_slice(&1u32.to_le_bytes());
        for _ in 0..3 {
            stl.extend_from_slice(&0f32.to_le_bytes()); // normal
        }
        for v in [[0.0f32, 0.0, 0.0], [10.0, 0.0, 5.0], [0.0, 10.0, 5.0]] {
            for k in 0..3 {
                stl.extend_from_slice(&v[k].to_le_bytes());
            }
        }
        stl.extend_from_slice(&0u16.to_le_bytes());
        let r = parse_bytes(&stl, 100.0, 2.5, 0.01);
        assert!(
            r.unit_note.contains("SECTION") && r.unit_note.contains("2.500"),
            "a mesh did not reach the section path: {}",
            r.unit_note
        );

        // And the text formats still land where they did.
        assert!(parse_bytes(PLATE_DXF.as_bytes(), 100.0, 0.0, 0.01).contours.len() >= 3);
        let svg = r#"<svg height="100"><circle cx="50" cy="50" r="10"/></svg>"#;
        assert_eq!(parse_bytes(svg.as_bytes(), 100.0, 0.0, 0.01).contours.len(), 1);
    }

    // ---- curve flattening -------------------------------------------------
    //
    // 🔴 These exist because `FUNCTIONAL-SPEC.md` F2 accepts SVG on *"curves
    // within tolerance of the analytic shape"* and, until 2026-08-09, the
    // tolerance was not a quantity the code had: `parse_path` was handed a
    // `tol` and flattened every cubic at a hard-coded 16 segments. Nothing
    // anywhere compared a flattened point to the curve it came from.
    //
    // ⚠ The measurement below is deliberately the SHIPPING one — it goes in
    // through `parse_svg`, the door a real drawing arrives by, not through
    // `flatten_cubic`. A helper can be right while the path a caller uses is
    // wrong.

    /// The analytic cubic, in SVG space.
    fn analytic_cubic(
        p0: (f64, f64),
        p1: (f64, f64),
        p2: (f64, f64),
        p3: (f64, f64),
        t: f64,
    ) -> (f64, f64) {
        let mt = 1.0 - t;
        (
            mt * mt * mt * p0.0 + 3.0 * mt * mt * t * p1.0 + 3.0 * mt * t * t * p2.0 + t * t * t * p3.0,
            mt * mt * mt * p0.1 + 3.0 * mt * mt * t * p1.1 + 3.0 * mt * t * t * p2.1 + t * t * t * p3.1,
        )
    }

    fn dist_to_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l2 = dx * dx + dy * dy;
        if l2 <= 0.0 {
            return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
        }
        let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0);
        ((p.0 - (a.0 + t * dx)).powi(2) + (p.1 - (a.1 + t * dy)).powi(2)).sqrt()
    }

    /// Import one open cubic through `parse_svg` and return
    /// `(worst deviation from the analytic curve in mm, chord count)`.
    ///
    /// Only one direction of the Hausdorff distance is needed: every vertex the
    /// flattener emits is a de Casteljau split point, so it lies exactly ON the
    /// curve and the polyline->curve direction is zero by construction. What can
    /// go wrong is the curve bulging away from the chords, which is this one.
    fn worst_flattening_deviation_mm(
        p0: (f64, f64),
        p1: (f64, f64),
        p2: (f64, f64),
        p3: (f64, f64),
        tol: f64,
    ) -> (f64, usize) {
        let height = 4000.0;
        let d = format!(
            "M {} {} C {} {} {} {} {} {}",
            p0.0, p0.1, p1.0, p1.1, p2.0, p2.1, p3.0, p3.1
        );
        let svg = format!("<svg height=\"{height}\"><path d=\"{d}\"/></svg>");
        let r = parse_svg(&svg, height, tol);
        assert_eq!(r.contours.len(), 1, "the cubic did not import as one contour");
        // Back out of machine coordinates into SVG space so the comparison is
        // against the curve as written in the drawing.
        let poly: Vec<(f64, f64)> =
            r.contours[0].verts.iter().map(|v| (v.x, height - v.y)).collect();
        assert!(poly.len() >= 2, "a cubic imported as {} point(s)", poly.len());

        let mut worst: f64 = 0.0;
        const SAMPLES: usize = 20_001;
        for k in 0..SAMPLES {
            let t = k as f64 / (SAMPLES - 1) as f64;
            let q = analytic_cubic(p0, p1, p2, p3, t);
            let mut best = f64::INFINITY;
            for w in poly.windows(2) {
                best = best.min(dist_to_segment(q, w[0], w[1]));
            }
            worst = worst.max(best);
        }
        (worst, poly.len() - 1)
    }

    #[test]
    fn a_flattened_cubic_stays_within_the_import_tolerance() {
        // 🔴 The physical failure: a curve flattened coarser than the operator
        // believes is a part cut to a profile nobody drew, and on an INSIDE
        // curve the chords cut through the analytic edge — a gouge in the
        // finished surface. It renders perfectly at every step.
        //
        // Every case below is measured against the 16-segment flattening this
        // replaced, so the numbers say what the defect actually was rather than
        // asserting an improvement in the abstract:
        //
        //   quarter-circle R=6mm       n=16 -> 0.0078mm  (the only one inside)
        //   quarter-circle R=20mm      n=16 -> 0.0259mm  1.3x over 0.02
        //   quarter-circle R=100mm     n=16 -> 0.1296mm  6.5x over
        //   quarter-circle R=300mm     n=16 -> 0.3887mm   19x over
        //   S-curve, 1200mm span       n=16 -> 2.1056mm  105x over
        let cases: [(&str, (f64, f64), (f64, f64), (f64, f64), (f64, f64)); 6] = [
            ("quarter-circle R=6mm", (0.0, 0.0), (3.314, 0.0), (6.0, 2.686), (6.0, 6.0)),
            ("quarter-circle R=20mm", (0.0, 0.0), (11.046, 0.0), (20.0, 8.954), (20.0, 20.0)),
            ("quarter-circle R=100mm", (0.0, 0.0), (55.228, 0.0), (100.0, 44.772), (100.0, 100.0)),
            ("quarter-circle R=300mm", (0.0, 0.0), (165.7, 0.0), (300.0, 134.3), (300.0, 300.0)),
            ("S-curve, 1200mm span", (0.0, 0.0), (400.0, 300.0), (800.0, -300.0), (1200.0, 0.0)),
            ("shallow arc, 600mm span", (0.0, 0.0), (200.0, 40.0), (400.0, 40.0), (600.0, 0.0)),
        ];
        // 0.02 is the shipping value (cli/src/main.rs, fixtures.rs). The other
        // two prove the flattening RESPONDS to the argument rather than landing
        // inside 0.02 by luck — a fixed count would pass a loose tolerance on a
        // small curve and tell you nothing.
        for tol in [0.2, 0.02, 0.002] {
            for (name, p0, p1, p2, p3) in cases {
                let (dev, chords) = worst_flattening_deviation_mm(p0, p1, p2, p3, tol);
                assert!(
                    dev <= tol,
                    "{name} at tol {tol}mm: worst deviation {dev:.5}mm over {chords} chords \
                     — the flattened polyline is not the curve the drawing specified"
                );
            }
        }
    }

    #[test]
    fn tightening_the_tolerance_buys_chords_and_a_loose_one_does_not_pay_for_them() {
        // A fixed count is the defect, not the number — so it is not enough that
        // the deviation is small; it has to MOVE with the argument. This is the
        // limb that a "raise 16 to 512" non-fix passes the test above with and
        // fails here, and it is also the limb that catches a flattener that just
        // recurses to the cap every time.
        let (p0, p1, p2, p3) =
            ((0.0, 0.0), (400.0, 300.0), (800.0, -300.0), (1200.0, 0.0));
        let (_, coarse) = worst_flattening_deviation_mm(p0, p1, p2, p3, 0.5);
        let (_, ship) = worst_flattening_deviation_mm(p0, p1, p2, p3, 0.02);
        let (_, fine) = worst_flattening_deviation_mm(p0, p1, p2, p3, 0.001);
        assert!(
            coarse < ship && ship < fine,
            "chord counts did not respond to the tolerance: 0.5mm->{coarse}, \
             0.02mm->{ship}, 0.001mm->{fine}"
        );
        // And a small curve must not be paying a big curve's price. A 6mm
        // quarter-circle is inside 0.02mm at 16 chords; asking for the same
        // tolerance must not spend hundreds.
        let (_, small) =
            worst_flattening_deviation_mm((0.0, 0.0), (3.314, 0.0), (6.0, 2.686), (6.0, 6.0), 0.02);
        assert!(small <= 16, "a 6mm fillet cost {small} chords at 0.02mm");
    }

    #[test]
    fn a_relative_cubic_is_flattened_against_the_same_tolerance() {
        // `c` shares the flattener with `C` but not the coordinate arithmetic,
        // and a relative curve is the one an exporter emits by default.
        //
        // ⚠ The first version of this test started at `M 0 0`, where relative
        // and absolute coincide — so it passed with the relative offset deleted
        // entirely. It was VACUOUS and only the negative control said so. The
        // start point is non-zero on purpose; do not move it back.
        let tol = 0.02;
        let abs = r#"<svg height="4000"><path d="M 100 50 C 265.7 50 400 184.3 400 350"/></svg>"#;
        let rel = r#"<svg height="4000"><path d="M 100 50 c 165.7 0 300 134.3 300 300"/></svg>"#;
        let a = parse_svg(abs, 4000.0, tol);
        let b = parse_svg(rel, 4000.0, tol);
        assert_eq!(a.contours.len(), 1);
        assert_eq!(b.contours.len(), 1);
        assert_eq!(
            a.contours[0].verts.len(),
            b.contours[0].verts.len(),
            "the same curve written relative flattened to a different point count"
        );
        for (p, q) in a.contours[0].verts.iter().zip(b.contours[0].verts.iter()) {
            assert!(
                (p.x - q.x).abs() < 1e-9 && (p.y - q.y).abs() < 1e-9,
                "relative cubic diverged from the absolute one at ({}, {}) vs ({}, {})",
                p.x, p.y, q.x, q.y
            );
        }
    }

    #[test]
    fn svg_path_h_and_v_move_only_their_own_axis() {
        // 🔴 `H`/`V` were implemented and covered by NOTHING. The failure they
        // fail into is silent: a horizontal command that also touches Y skews
        // one edge of a rectangle, which is a part that will not seat and a
        // drawing that looks right.
        let tol = 0.01;
        // Absolute, and the relative spelling of the same box. Machine Y is
        // 100 - svg_y, so svg y=10 -> 90 and y=30 -> 70.
        for d in [
            "M 10 10 H 50 V 30 H 10 Z",
            "M 10 10 h 40 v 20 h -40 z",
        ] {
            let svg = format!("<svg height=\"100\"><path d=\"{d}\"/></svg>");
            let r = parse_svg(&svg, 100.0, tol);
            assert!(r.unsupported.is_empty(), "{d}: {:?}", r.unsupported);
            let c = r.contours.iter().find(|c| c.closed).unwrap_or_else(|| {
                panic!("{d}: H/V did not produce a closed contour")
            });
            let got: Vec<(f64, f64)> = c.verts.iter().map(|v| (v.x, v.y)).collect();
            let want = [(10.0, 90.0), (50.0, 90.0), (50.0, 70.0), (10.0, 70.0)];
            assert_eq!(got.len(), want.len(), "{d}: got {got:?}");
            for (g, w) in got.iter().zip(want.iter()) {
                assert!(
                    (g.0 - w.0).abs() < 1e-9 && (g.1 - w.1).abs() < 1e-9,
                    "{d}: got {got:?}, want {want:?}"
                );
            }
        }
    }

    #[test]
    fn an_unimplemented_path_command_is_refused_by_name_not_flattened() {
        // An unimplemented command (R is not a valid SVG path command) must be
        // named and NOT imported, because a curve silently treated as a line is
        // a curve replaced by its chord with nothing said.
        let svg = r#"<svg height="100"><path d="M 0 0 R 50 100 100 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.01);
        assert_eq!(r.contours.len(), 0, "an unimplemented command was imported anyway");
        assert!(
            r.unsupported.iter().any(|u| u.contains('R') && u.contains("NOT imported")),
            "{:?}",
            r.unsupported
        );
    }

    #[test]
    fn a_tolerance_no_subdivision_can_meet_is_reported_not_silently_missed() {
        // The cap has to be reachable and it has to SPEAK. A chord coarser than
        // the tolerance asked for is a wrong profile that renders perfectly;
        // the one thing that must never happen is it passing as "within
        // tolerance" because the recursion quietly gave up.
        let svg = r#"<svg height="100"><path d="M 0 0 C 400 300 800 -300 1200 0"/></svg>"#;
        let r = parse_svg(svg, 4000.0, 0.0);
        assert!(!r.contours.is_empty(), "the geometry was dropped as well");
        assert!(
            r.unsupported.iter().any(|u| u.contains("subdivision cap") && u.contains("WAS imported")),
            "the subdivision cap fired and said nothing: {:?}",
            r.unsupported
        );
        // And the ordinary case must NOT report it — a warning on every import
        // is a warning nobody reads.
        let ok = parse_svg(svg, 4000.0, 0.02);
        assert!(ok.unsupported.is_empty(), "a met tolerance still warned: {:?}", ok.unsupported);
    }

    #[test]
    fn an_unsupported_path_command_is_named() {
        // An unsupported command must be named so an operator can fix it in CAD.
        let svg = r#"<svg height="100"><path d="M 0 0 R 10 10 20 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.01);
        assert!(r.unsupported.iter().any(|u| u.contains('R')), "{:?}", r.unsupported);
    }

    #[test]
    fn svg_arc_command_imports() {
        // A 90° arc from (0,0) to (20,0) with radius 10, sweep flag 1.
        let svg = r#"<svg height="100"><path d="M 0 0 A 10 10 0 0 1 20 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.02);
        assert!(r.unsupported.is_empty(), "arc should not be unsupported: {:?}", r.unsupported);
        assert!(r.contours.len() >= 1, "should produce at least one contour");
        // The arc should have more than 2 points (it's curved)
        let total_verts: usize = r.contours.iter().map(|c| c.verts.len()).sum();
        assert!(total_verts >= 3, "arc should produce multiple points, got {}", total_verts);
    }

    #[test]
    fn svg_quadratic_command_imports() {
        // Q: control (10,20), endpoint (20,0). A simple curve from (0,0).
        let svg = r#"<svg height="100"><path d="M 0 0 Q 10 20 20 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.02);
        assert!(r.unsupported.is_empty(), "Q should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "Q should produce contours");
        let total_verts: usize = r.contours.iter().map(|c| c.verts.len()).sum();
        assert!(total_verts >= 3, "Q should produce multiple points, got {}", total_verts);
    }

    #[test]
    fn dxf_spline_imports() {
        // A simple cubic spline with 4 control points and 8 knots.
        // Knot values use group code 40, control points use 10/20.
        let dxf = "\
0\nSECTION\n2\nENTITIES\n0\nSPLINE\n71\n3\n72\n8\n73\n4\n\
40\n0.0\n40\n0.0\n40\n0.0\n40\n0.0\n40\n1.0\n40\n1.0\n40\n1.0\n40\n1.0\n\
10\n0.0\n20\n0.0\n10\n13.3\n20\n26.7\n10\n26.7\n20\n26.7\n10\n40.0\n20\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.is_empty(), "spline should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "spline should produce contours");
    }

    #[test]
    fn dxf_ellipse_imports() {
        // A full ellipse: center (50,50), major axis (20,0), ratio 0.5, full sweep.
        let dxf = "\
0\nSECTION\n2\nENTITIES\n0\nELLIPSE\n10\n50.0\n20\n50.0\n\
11\n20.0\n21\n0.0\n40\n0.5\n41\n0.0\n42\n6.283185307179586\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.is_empty(), "ellipse should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "ellipse should produce contours");
    }

    #[test]
    fn svg_smooth_cubic_imports() {
        // S (smooth cubic): first control point is reflected from previous C.
        // M 0,0 C 0,20 20,20 20,0 S 40,-20 40,0 — a symmetric S-curve.
        let svg = r#"<svg height="100"><path d="M 0 0 C 0 20 20 20 20 0 S 40 -20 40 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.02);
        assert!(r.unsupported.is_empty(), "S should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "S should produce contours");
        let total_verts: usize = r.contours.iter().map(|c| c.verts.len()).sum();
        assert!(total_verts >= 4, "S should produce multiple points, got {}", total_verts);
    }

    #[test]
    fn svg_smooth_quadratic_imports() {
        // T (smooth quadratic): control point is reflected from previous Q.
        // M 0,0 Q 10,20 20,0 T 40,0 — a smooth continuation.
        let svg = r#"<svg height="100"><path d="M 0 0 Q 10 20 20 0 T 40 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.02);
        assert!(r.unsupported.is_empty(), "T should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "T should produce contours");
        let total_verts: usize = r.contours.iter().map(|c| c.verts.len()).sum();
        assert!(total_verts >= 4, "T should produce multiple points, got {}", total_verts);
    }

    #[test]
    fn svg_smooth_cubic_without_previous_c_reflects_to_current() {
        // S after M (no previous C): first control point = current point.
        // This degenerates to a quadratic, which is still a valid curve.
        let svg = r#"<svg height="100"><path d="M 0 0 S 10 20 20 0"/></svg>"#;
        let r = parse_svg(svg, 100.0, 0.02);
        assert!(r.unsupported.is_empty(), "S after M should work: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "S after M should produce contours");
    }

    #[test]
    fn dxf_insert_resolves_block_reference() {
        // A block "mysquare" with a 10x10 square, then an INSERT at (50, 50).
        let dxf = "\
0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nmysquare\n10\n0.0\n20\n0.0\n\
0\nLWPOLYLINE\n90\n4\n70\n1\n\
10\n0.0\n20\n0.0\n\
10\n10.0\n20\n0.0\n\
10\n10.0\n20\n10.0\n\
10\n0.0\n20\n10.0\n\
0\nENDBLK\n\
0\nENDSEC\n\
0\nSECTION\n2\nENTITIES\n\
0\nINSERT\n2\nmysquare\n10\n50.0\n20\n50.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.is_empty(), "INSERT should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "INSERT should produce contours");
        // The square should be translated to (50,50)
        let min_x = r.contours.iter().flat_map(|c| c.verts.iter()).map(|v| v.x).fold(f64::INFINITY, f64::min);
        let min_y = r.contours.iter().flat_map(|c| c.verts.iter()).map(|v| v.y).fold(f64::INFINITY, f64::min);
        assert!(min_x >= 49.9, "square should be translated to x>=50, got {}", min_x);
        assert!(min_y >= 49.9, "square should be translated to y>=50, got {}", min_y);
    }

    #[test]
    fn dxf_insert_missing_block_is_reported() {
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nINSERT\n2\nnonexistent\n10\n0.0\n20\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.iter().any(|u| u.contains("nonexistent") && u.contains("NOT found")),
            "{:?}", r.unsupported);
    }

    #[test]
    fn dxf_text_imports() {
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nTEXT\n1\nHello\n10\n50.0\n20\n50.0\n40\n5.0\n50\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        // ⚠ WAS `unsupported.is_empty()`. The geometry still imports — that is
        // this test's subject and it is unchanged — but the import now SAYS the
        // outlines will be CUT (see `text_cut_warning`). Asserting the note here
        // keeps it from being dropped by someone tidying "spurious" warnings.
        assert_eq!(r.unsupported.len(), 1, "expected only the cut warning: {:?}", r.unsupported);
        assert!(
            r.unsupported[0].contains("CUTTABLE") && r.unsupported[0].contains("Hello"),
            "the warning must name the string that will be cut: {:?}",
            r.unsupported
        );
        assert!(!r.contours.is_empty(), "TEXT should produce contours");
        // The text should be positioned near (50, 50)
        let min_x = r.contours.iter().flat_map(|c| c.verts.iter()).map(|v| v.x).fold(f64::INFINITY, f64::min);
        assert!(min_x >= 49.0, "text should be near x=50, got {}", min_x);
    }

    #[test]
    fn dxf_mtext_imports() {
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nMTEXT\n1\n{\\fArial|b1|i0|c0|p2;World}\n10\n100.0\n20\n100.0\n40\n10.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert_eq!(r.unsupported.len(), 1, "expected only the cut warning: {:?}", r.unsupported);
        assert!(r.unsupported[0].contains("CUTTABLE"), "{:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "MTEXT should produce contours");
    }

    #[test]
    fn mtext_formatting_is_stripped() {
        // Font directive: \f font name | properties ; content
        assert_eq!(strip_mtext_formatting("{\\fArial|b1|i0|c0|p2;Hello}"), "Hello");
        assert_eq!(strip_mtext_formatting("Plain text"), "Plain text");
        assert_eq!(strip_mtext_formatting("Line1\\PLine2"), "Line1\nLine2");
        // Nested: \f sets font, then \H sets height for "Big"
        assert_eq!(strip_mtext_formatting("{\\fArial;{\\H2x;Big}}"), "Big");
        assert_eq!(strip_mtext_formatting("A~B"), "A\u{00A0}B");
        // Directive with pipe-separated properties, semicolon ends it
        assert_eq!(strip_mtext_formatting("{\\fArial|b1;Content}"), "Content");
    }

    #[test]
    fn dxf_text_empty_string_is_reported() {
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nTEXT\n1\n\n10\n0.0\n20\n0.0\n40\n5.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.iter().any(|u| u.contains("empty string")),
            "{:?}", r.unsupported);
    }

    #[test]
    fn dxf_hatch_with_line_boundary_imports() {
        // A HATCH entity with 4 LINE edges forming a 10x10 square.
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nHATCH\n\
91\n1\n\
92\n0\n\
93\n4\n\
72\n1\n10\n0.0\n20\n0.0\n11\n10.0\n21\n0.0\n\
72\n1\n10\n10.0\n20\n0.0\n11\n10.0\n21\n10.0\n\
72\n1\n10\n10.0\n20\n10.0\n11\n0.0\n21\n10.0\n\
72\n1\n10\n0.0\n20\n10.0\n11\n0.0\n21\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.is_empty(), "HATCH should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "HATCH should produce contours");
        let closed: Vec<_> = r.contours.iter().filter(|c| c.closed).collect();
        assert!(!closed.is_empty(), "HATCH boundary should be closed");
    }

    #[test]
    fn dxf_hatch_with_arc_boundary_imports() {
        // A HATCH with a circular arc boundary (full circle).
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nHATCH\n\
91\n1\n\
92\n0\n\
93\n1\n\
72\n2\n10\n50.0\n20\n50.0\n40\n20.0\n50\n0.0\n51\n360.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.is_empty(), "HATCH with arc should not be unsupported: {:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "HATCH with arc should produce contours");
    }

    #[test]
    fn dxf_hatch_empty_is_reported() {
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nHATCH\n\
91\n0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(r.unsupported.iter().any(|u| u.contains("no parseable boundary")),
            "{:?}", r.unsupported);
    }

    #[test]
    fn dxf_dimension_with_custom_text_imports() {
        // DIMENSION with custom text "100mm" at position (50, 50).
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nDIMENSION\n1\n100mm\n10\n0.0\n20\n0.0\n11\n50.0\n21\n50.0\n13\n100.0\n23\n0.0\n40\n5.0\n50\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(
            r.unsupported.iter().all(|u| u.contains("CUTTABLE")),
            "the only note on a DIMENSION should be that its text will be CUT: {:?}",
            r.unsupported
        );
        assert!(!r.contours.is_empty(), "DIMENSION should produce contours");
    }

    #[test]
    fn dxf_dimension_with_auto_measurement_imports() {
        // DIMENSION with empty text (use <> placeholder) — falls back to measurement value.
        let dxf = "\
0\nSECTION\n2\nENTITIES\n\
0\nDIMENSION\n1\n<>\n10\n0.0\n20\n0.0\n11\n50.0\n21\n50.0\n13\n100.0\n23\n0.0\n40\n5.0\n42\n42.0\n50\n0.0\n\
0\nENDSEC\n0\nEOF\n";
        let r = parse_dxf(dxf, 0.02);
        assert!(
            r.unsupported.iter().all(|u| u.contains("CUTTABLE")),
            "the only note on a DIMENSION should be that its text will be CUT: {:?}",
            r.unsupported
        );
        assert!(!r.contours.is_empty(), "DIMENSION with measurement should produce contours");
    }
}
