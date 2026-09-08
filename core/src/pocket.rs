//! Pocket clearing — remove ALL the material inside a boundary, not just its
//! outline.
//!
//! 🔴 The defect this module exists to prevent: cutting one lap around a pocket
//! and calling it cleared. A 40x40 pocket with a 6mm cutter leaves a 28x28
//! island standing, and the G-code looks perfectly reasonable.

use cavalier_contours::polyline::{
    BooleanOp, PlineCreation, PlineSource, PlineSourceMut, PlineVertex, Polyline,
};

use crate::geometry::{Contour, Vertex};

fn to_pline(c: &Contour) -> Polyline {
    let mut p = Polyline::with_capacity(c.verts.len(), c.closed);
    for v in &c.verts {
        p.add(v.x, v.y, v.bulge);
    }
    p
}

fn from_pline(p: &Polyline) -> Contour {
    Contour {
        verts: p
            .iter_vertexes()
            .map(|v: PlineVertex<f64>| Vertex { x: v.x, y: v.y, bulge: v.bulge })
            .collect(),
        closed: p.is_closed(),
    }
}

/// Subtract `holes` from `region`, returning **every** boundary of the result —
/// the outer loops AND the interior hole loops.
///
/// 🔴 `BooleanResult` splits its output: `pos_plines` carries the outer
/// boundaries and `neg_plines` carries the holes. Reading only `pos_plines`
/// returns a plate-with-a-pocket as a plain plate — the hole vanishes and the
/// result *looks* right, because the outline is right.
///
/// That is the identical failure mode `build_nest.py` is documented to have
/// ("drops internal holes", gate P8), reproduced inside our own boolean helper.
/// It was found because a pocket correctly removed from a keep region still
/// reported 10,449 gouged cells: the caller could not tell the middle was not
/// material, since nothing ever told it there was a hole.
///
/// Callers that need to distinguish outer from hole can use the winding: an
/// outer boundary is counter-clockwise, a hole clockwise.
///
/// ⚠ That is true because this function ENFORCES it. The library returns both
/// sets wound counter-clockwise, so a caller reading the raw result and
/// believing the usual convention would classify every hole as material. The
/// normalisation below is what makes the sentence above safe to rely on.
pub fn subtract(region: &Contour, holes: &[Contour]) -> Vec<Contour> {
    let mut current = vec![to_pline(region)];
    let mut hole_loops: Vec<Polyline> = Vec::new();
    for h in holes {
        let hp = to_pline(h);
        let mut next = Vec::new();
        for c in &current {
            let r = c.boolean(&hp, BooleanOp::Not);
            for set in r.pos_plines {
                next.push(set.pline);
            }
            for set in r.neg_plines {
                hole_loops.push(set.pline);
            }
        }
        current = next;
        if current.is_empty() {
            break;
        }
    }
    let mut out: Vec<Contour> = current.iter().map(from_pline).collect();
    for c in &mut out {
        c.normalise_winding(true);
    }
    for h in hole_loops.iter().map(from_pline) {
        let mut h = h;
        h.normalise_winding(false);
        out.push(h);
    }
    out
}

/// Concentric clearing passes for a pocket.
///
/// `boundary` is the finished pocket wall; `islands` are regions that must be
/// left standing. Returns loops from the wall inward, each already offset to
/// the TOOL CENTRE — grblHAL has no cutter compensation, so nothing downstream
/// applies a radius.
///
/// `stepover` is the radial engagement per pass. It is **clamped to the tool
/// diameter**: a stepover wider than the tool leaves uncut ridges between
/// passes, which is the same defect as not clearing at all, only harder to see.
pub fn clearing_loops(
    boundary: &Contour,
    islands: &[Contour],
    tool_r: f64,
    stepover_mm: f64,
    finish_allowance_mm: f64,
) -> Vec<Contour> {
    if tool_r <= 0.0 {
        return Vec::new();
    }
    let step = stepover_mm.clamp(0.05, tool_r * 2.0);

    // First pass: the wall, offset inward by the tool radius plus any finish
    // allowance we are choosing to leave on.
    let mut frontier = boundary.offset(-(tool_r + finish_allowance_mm));
    // Islands grow by the same radius so the tool centre never crosses them.
    let grown: Vec<Contour> =
        islands.iter().flat_map(|i| i.offset(tool_r + finish_allowance_mm)).collect();

    let mut out: Vec<Contour> = Vec::new();
    let mut guard = 0;
    while !frontier.is_empty() {
        guard += 1;
        // A pocket cannot need more passes than its half-diagonal / step. The
        // guard is a runaway backstop, not a limit anyone should hit; if it
        // trips, the offset is not converging and that is a bug, not a pocket.
        if guard > 10_000 {
            break;
        }
        let mut kept = Vec::new();
        for f in &frontier {
            let pieces = if grown.is_empty() { vec![f.clone()] } else { subtract(f, &grown) };
            for p in pieces {
                if p.verts.len() >= 2 {
                    kept.push(p);
                }
            }
        }
        if kept.is_empty() {
            break;
        }
        out.extend(kept.iter().cloned());

        // Terminate only when nothing could still be standing INSIDE the ring
        // we just cut. A ring whose smallest dimension is <= one tool diameter
        // is fully swept by the tool travelling it; anything wider still has
        // material in the middle.
        let smallest = kept
            .iter()
            .filter_map(|c| c.bounds())
            .map(|(x0, y0, x1, y1)| (x1 - x0).min(y1 - y0))
            .fold(f64::INFINITY, f64::min);
        if smallest <= tool_r * 2.0 + 1e-9 {
            break;
        }

        // Next ring inward. 🔴 If a full step overshoots and returns nothing,
        // that does NOT mean the pocket is clear — it means the last step was
        // too big and left a nub the tool never swept. A 40x40 pocket at 4.5mm
        // stepover with a 6mm cutter ends on a 7mm ring and leaves exactly
        // 1x1mm standing, which looks like a finished program. Step down until
        // something is produced rather than declaring victory on an empty
        // offset.
        let mut next: Vec<Contour> = kept.iter().flat_map(|c| c.offset(-step)).collect();
        if next.is_empty() {
            let mut s = step * 0.5;
            while s >= 0.05 {
                next = kept.iter().flat_map(|c| c.offset(-s)).collect();
                if !next.is_empty() {
                    break;
                }
                s *= 0.5;
            }
        }
        frontier = next;
    }
    out
}

/// True when the leftover material between the innermost clearing pass and the
/// pocket centre is small enough to have been cut.
///
/// This is the check that catches "outlined, not cleared". It is deliberately
/// crude — a real answer needs the material-removal simulation (gate P9) — but
/// it catches the whole-island case that the simulation is not yet here to see.
pub fn residual_island_mm(boundary: &Contour, loops: &[Contour], tool_r: f64) -> f64 {
    let Some((bx0, by0, bx1, by1)) = boundary.bounds() else {
        return 0.0;
    };
    if loops.is_empty() {
        // Nothing was cut at all: the whole pocket is residual.
        return (bx1 - bx0).min(by1 - by0);
    }
    // The innermost loop's smallest dimension bounds what can still be standing
    // inside it, less what the tool sweeps.
    let innermost = loops
        .iter()
        .filter_map(|c| c.bounds())
        .map(|(x0, y0, x1, y1)| (x1 - x0).min(y1 - y0))
        .fold(f64::INFINITY, f64::min);
    (innermost - tool_r * 2.0).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pocket_is_cleared_not_outlined() {
        // 🔴 P2. One lap of a 40x40 pocket with a 6mm cutter leaves 28x28
        // standing. Clearing must leave nothing a tool could still remove.
        let pocket = Contour::rect(0.0, 0.0, 40.0, 40.0);
        let loops = clearing_loops(&pocket, &[], 3.0, 4.5, 0.0);
        assert!(loops.len() > 1, "only {} loop(s) — that is an outline, not clearing", loops.len());
        let residual = residual_island_mm(&pocket, &loops, 3.0);
        assert!(residual <= 1e-6, "{residual:.3}mm of material left standing in the pocket");
    }

    #[test]
    fn outlining_alone_fails_the_residual_check() {
        // Negative control for the check itself: if a single lap PASSED, the
        // check above would be decoration.
        let pocket = Contour::rect(0.0, 0.0, 40.0, 40.0);
        let one_lap = pocket.offset(-3.0);
        let residual = residual_island_mm(&pocket, &one_lap, 3.0);
        assert!(residual > 20.0, "a single lap must show a large residual, got {residual:.3}");
    }

    #[test]
    fn an_island_is_left_standing() {
        // A pocket with a boss in the middle: the boss must survive, and the
        // ring around it must still be cleared.
        let pocket = Contour::rect(0.0, 0.0, 60.0, 60.0);
        let island = Contour::rect(25.0, 25.0, 10.0, 10.0);
        let loops = clearing_loops(&pocket, &[island], 3.0, 4.0, 0.0);
        assert!(!loops.is_empty());
        // No cutting loop may pass within the tool radius of the island.
        for c in &loops {
            for v in &c.verts {
                let inside_island =
                    v.x > 22.5 && v.x < 37.5 && v.y > 22.5 && v.y < 37.5;
                assert!(!inside_island, "a pass at ({}, {}) cuts into the island", v.x, v.y);
            }
        }
    }

    /// Does a LEGITIMATE island read as residual? It does — and both halves of
    /// that are now ASSERTED, because the answer is what scopes the production
    /// check. See the body: this was a print-only test until 2026-09-08.
    /// `residual_island_mm` takes no island list, so before wiring it into the
    /// production path this has to be known — a check that fires on a boss the
    /// operator asked for is a false red, and a false red is the failure mode
    /// nobody guards against because it looks like diligence.
    #[test]
    fn measure_what_a_legitimate_island_reports_as_residual() {
        let pocket = Contour::rect(0.0, 0.0, 60.0, 60.0);
        let island = Contour::rect(25.0, 25.0, 10.0, 10.0);
        let loops = clearing_loops(&pocket, &[island], 3.0, 4.0, 0.0);
        let residual = residual_island_mm(&pocket, &loops, 3.0);
        let clear = clearing_loops(&Contour::rect(0.0, 0.0, 60.0, 60.0), &[], 3.0, 4.0, 0.0);
        let residual_clear = residual_island_mm(&Contour::rect(0.0, 0.0, 60.0, 60.0), &clear, 3.0);

        /* 🔴 THIS TEST ONLY PRINTED UNTIL 2026-09-08 — it measured both numbers
         * and asserted NOTHING, which is a check that cannot fail: exactly the
         * shape this lane spent two days hunting in the gates. It is now a guard
         * on the reasoning that SCOPED the production check in fixtures.rs.
         *
         * The scoping argument is: `residual_island_mm` takes no island list, so
         * a declared boss reads as residual, so the production check may only run
         * where no islands are passed. Both halves of that must stay true. */
        assert!(
            residual > 1.0,
            "a LEGITIMATE 10x10 island no longer reads as residual ({residual:.3}mm). The \
             production check in fixtures.rs is scoped to island-free call sites BECAUSE of this \
             — if it has stopped being true, that scoping is now unnecessary caution or, worse, \
             the residual function has changed meaning."
        );
        assert!(
            residual_clear <= 1e-6,
            "a properly cleared pocket with NO island reports {residual_clear:.3}mm of residual — \
             the production check would false-red on every clean pocket."
        );
    }

    #[test]
    fn a_pocket_narrower_than_the_tool_produces_nothing() {
        let slot = Contour::rect(0.0, 0.0, 40.0, 4.0);
        let loops = clearing_loops(&slot, &[], 3.0, 4.0, 0.0);
        assert!(loops.is_empty(), "a 4mm pocket was cleared with a 6mm tool");
    }

    #[test]
    fn stepover_wider_than_the_tool_is_clamped() {
        // A 20mm stepover with a 6mm cutter would leave ridges. It is clamped
        // to the diameter, so the pass count must match the clamped value.
        let pocket = Contour::rect(0.0, 0.0, 60.0, 60.0);
        let wild = clearing_loops(&pocket, &[], 3.0, 20.0, 0.0);
        let clamped = clearing_loops(&pocket, &[], 3.0, 6.0, 0.0);
        assert_eq!(wild.len(), clamped.len(), "stepover was not clamped to the tool diameter");
    }

    #[test]
    fn finish_allowance_leaves_material_on_the_wall() {
        let pocket = Contour::rect(0.0, 0.0, 60.0, 60.0);
        let rough = clearing_loops(&pocket, &[], 3.0, 4.0, 0.5);
        let (x0, _, x1, _) = rough[0].bounds().unwrap();
        // Tool centre sits radius + allowance in from the wall.
        assert!((x0 - 3.5).abs() < 1e-6, "first pass at x {x0}, expected 3.5");
        assert!((x1 - 56.5).abs() < 1e-6, "first pass at x {x1}, expected 56.5");
    }
}

#[cfg(test)]
mod subtract_tests {
    use super::*;

    #[test]
    fn subtracting_an_interior_hole_yields_the_hole_loop_too() {
        // A 200x120 plate with a 60x60 pocket cut out of the middle is a region
        // WITH A HOLE. The boolean must report both boundaries, or a downstream
        // point-in-region test has no way to know the middle is not material.
        let outer = Contour::rect(0.0, 0.0, 200.0, 120.0);
        let hole = Contour::rect(70.0, 30.0, 60.0, 60.0);
        let r = subtract(&outer, &[hole]);
        eprintln!("loops: {}", r.len());
        for (i, c) in r.iter().enumerate() {
            eprintln!("  loop {i}: area {:.1} bounds {:?}", c.signed_area(), c.bounds());
        }
        assert_eq!(r.len(), 2, "expected an outer boundary AND a hole loop, got {}", r.len());
        // The hole must be there, and wound opposite to the outer.
        let outer = r.iter().find(|c| c.signed_area() > 0.0).expect("no outer loop");
        let hole = r.iter().find(|c| c.signed_area() < 0.0).expect("the hole loop was dropped");
        assert!((outer.signed_area() - 24_000.0).abs() < 1.0);
        assert!((hole.signed_area().abs() - 3_600.0).abs() < 1.0, "hole area {}", hole.signed_area());
    }
}
