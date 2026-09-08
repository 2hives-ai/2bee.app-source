//! Contours, parts, and arc-preserving offsetting.
//!
//! # Why bulge, and not a polygon
//!
//! A contour vertex carries a **bulge**: `tan(theta/4)` of the arc sweeping to
//! the next vertex, `0` for a straight segment. That is what lets an arc survive
//! the offset and come out the far side as a `G2`/`G3` rather than a hundred
//! tiny `G1`s. A polygon representation would discard it at the door, and gate
//! G10 (block rate) exists because that discarding is what floods the planner.
//!
//! # Winding
//!
//! Closed contours are stored **counter-clockwise for material, clockwise for
//! holes**. `normalise_winding()` enforces it on import; nothing downstream may
//! assume a caller got it right.
//!
//! ⚠ This is NOT the same as `cavalier_contours`' offset sign — that library
//! offsets to the *left of travel*, which is inward for a CCW loop, the
//! opposite of ours. The flip lives in exactly one place ([`Contour::offset`])
//! and is pinned by tests that measure bounds. An earlier version of this
//! comment claimed the two conventions agreed; they do not, and the first two
//! offset tests failed because of it.

use cavalier_contours::polyline::{
    PlineCreation, PlineSource, PlineSourceMut, PlineVertex, Polyline,
};

/// A vertex on a contour. `bulge` is `tan(theta/4)` of the arc to the NEXT
/// vertex; `0.0` is a straight segment. Positive bulge sweeps counter-clockwise.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vertex {
    pub x: f64,
    pub y: f64,
    pub bulge: f64,
}

impl Vertex {
    pub const fn line(x: f64, y: f64) -> Self {
        Self { x, y, bulge: 0.0 }
    }
    pub const fn arc(x: f64, y: f64, bulge: f64) -> Self {
        Self { x, y, bulge }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Contour {
    pub verts: Vec<Vertex>,
    pub closed: bool,
}

impl Contour {
    pub fn closed(verts: Vec<Vertex>) -> Self {
        Self { verts, closed: true }
    }
    pub fn open(verts: Vec<Vertex>) -> Self {
        Self { verts, closed: false }
    }

    /// An axis-aligned rectangle, counter-clockwise.
    pub fn rect(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self::closed(vec![
            Vertex::line(x, y),
            Vertex::line(x + w, y),
            Vertex::line(x + w, y + h),
            Vertex::line(x, y + h),
        ])
    }

    /// A full circle as two 180° arcs — the standard bulge encoding. A circle
    /// expressed as one vertex has no start point and cannot be offset.
    pub fn circle(cx: f64, cy: f64, r: f64) -> Self {
        Self::closed(vec![
            Vertex::arc(cx - r, cy, 1.0),
            Vertex::arc(cx + r, cy, 1.0),
        ])
    }

    /// A rectangle with radiused corners, counter-clockwise.
    pub fn rounded_rect(x: f64, y: f64, w: f64, h: f64, r: f64) -> Self {
        if r <= 0.0 {
            return Self::rect(x, y, w, h);
        }
        let r = r.min(w * 0.5).min(h * 0.5);
        // bulge for a 90 degree arc = tan(90/4 deg) = tan(22.5 deg)
        let b = (std::f64::consts::FRAC_PI_8).tan();
        Self::closed(vec![
            Vertex::line(x + r, y),
            Vertex::arc(x + w - r, y, b),
            Vertex::line(x + w, y + r),
            Vertex::arc(x + w, y + h - r, b),
            Vertex::line(x + w - r, y + h),
            Vertex::arc(x + r, y + h, b),
            Vertex::line(x, y + h - r),
            Vertex::arc(x, y + r, b),
        ])
    }

    pub fn is_empty(&self) -> bool {
        self.verts.len() < 2
    }

    /// Two vertices closer together than this describe the SAME point, so the
    /// segment between them has zero length.
    ///
    /// It is `cavalier_contours`' own `pos_equal_eps` default, deliberately and
    /// not by coincidence: that library's `parallel_offset` carries a
    /// `debug_assert!` that its input contains no repeat position within this
    /// tolerance, and anything it would call a repeat must be removed before it
    /// gets there. A looser value here would leave a "repeat" the library still
    /// sees; a tighter one would leave one this module no longer sees. The two
    /// numbers have to be the same number.
    pub const POS_EQUAL_EPS: f64 = 1e-5;

    /// Drop vertices that repeat the position of the vertex before them,
    /// including — on a closed contour — a final vertex that repeats the first.
    /// Returns how many were dropped.
    ///
    /// # 🔴 Why this is a DROP and not a refusal
    ///
    /// A repeated vertex describes a segment of **zero length**. A zero-length
    /// segment removes no material at any tool radius, at any depth, in any
    /// direction — so removing it cannot change a single coordinate of what is
    /// cut, and the test above this one asserts exactly that by offsetting the
    /// same rectangle written both ways and comparing the loops vertex by
    /// vertex. There is no machining intent to lose, which is the whole
    /// condition under which this lane allows a silent drop.
    ///
    /// It is also not an exotic input: **a closed `LWPOLYLINE` whose last vertex
    /// repeats its first is how a great many DXF writers close a loop**,
    /// including the one that produced `hardware/cad/export/hive_box_prototype.dxf`.
    /// Refusing it would refuse our own upstream generator's ordinary output,
    /// and a refusal a user cannot act on gets worked around rather than fixed.
    ///
    /// # 🔴 What is NOT dropped
    ///
    /// A contour that is *nothing but* zero-length segments is a **point**, not
    /// a contour, and that IS a fact about the drawing. This function reduces it
    /// to a single vertex; [`Contour::offset`] then returns nothing and
    /// [`crate::toolpath::plan_profile`] refuses it BY NAME. "Redundant vertex"
    /// and "feature that does not exist" are different facts and only the first
    /// is safe to swallow.
    ///
    /// # ⚠ The bulge must NOT be transferred backwards
    ///
    /// `cavalier_contours`' own `remove_repeat_pos` drops the repeat and moves
    /// its bulge onto the vertex it kept. That is right in the middle of a
    /// polyline — where the kept vertex then owns the segment to the next real
    /// point — and WRONG on the wrap-around pair of a closed contour, where the
    /// bulge being transferred belongs to the zero-length closing segment and
    /// would overwrite the last real fillet with a straight chord. So the
    /// interior case keeps the LATER vertex (with its own bulge) and the wrap
    /// case keeps the FIRST, leaving the preceding arc alone.
    pub fn dedupe_positions(&mut self) -> usize {
        let before = self.verts.len();
        if before < 2 {
            return 0;
        }
        let same = |a: &Vertex, b: &Vertex| {
            (a.x - b.x).hypot(a.y - b.y) <= Self::POS_EQUAL_EPS
        };

        let mut out: Vec<Vertex> = Vec::with_capacity(before);
        for v in std::mem::take(&mut self.verts) {
            match out.last() {
                // The segment LEAVING the earlier vertex has zero length, so it
                // is the earlier vertex's bulge that is meaningless. Keep the
                // later one, which owns the segment to the next real point.
                Some(p) if same(p, &v) => {
                    out.pop();
                    out.push(v);
                }
                _ => out.push(v),
            }
        }
        // The wrap-around segment of a closed contour. Here the FIRST vertex is
        // kept — see the bulge note above.
        if self.closed {
            while out.len() >= 2 && same(&out[out.len() - 1], &out[0]) {
                out.pop();
            }
        }
        self.verts = out;
        before - self.verts.len()
    }

    /// The number of vertices that would survive [`Contour::dedupe_positions`] —
    /// i.e. how many DISTINCT points this contour actually has. `< 2` means it
    /// is a point, not a path.
    pub fn distinct_vertex_count(&self) -> usize {
        let mut c = self.clone();
        c.dedupe_positions();
        c.verts.len()
    }

    /// Signed area. Positive = counter-clockwise. Uses the polyline's own
    /// area so arc segments contribute their circular-segment area, which a
    /// shoelace over the vertices alone would silently omit.
    pub fn signed_area(&self) -> f64 {
        if self.verts.len() < 2 {
            return 0.0;
        }
        self.to_pline().area()
    }

    /// Force counter-clockwise (`material`) or clockwise (`hole`) winding.
    pub fn normalise_winding(&mut self, counter_clockwise: bool) {
        if !self.closed || self.verts.len() < 2 {
            return;
        }
        let ccw = self.signed_area() > 0.0;
        if ccw != counter_clockwise {
            self.reverse();
        }
    }

    /// Reverse traversal direction. A bulge belongs to the segment that FOLLOWS
    /// its vertex, so reversing is not just reversing the vertex list — the
    /// bulges have to move back one place and change sign. Getting this wrong
    /// turns every arc inside out and is invisible until the part is cut.
    pub fn reverse(&mut self) {
        let n = self.verts.len();
        if n < 2 {
            return;
        }
        let old = self.verts.clone();
        self.verts.reverse();
        for i in 0..n {
            // After reversing, the segment leaving new vertex i is the old
            // segment that ARRIVED at it, i.e. the one owned by its old
            // predecessor, traversed backwards.
            let old_idx = n - 1 - i;
            let src = if self.closed {
                (old_idx + n - 1) % n
            } else if old_idx == 0 {
                // Open contour: the last new vertex ends the path, no segment.
                self.verts[i].bulge = 0.0;
                continue;
            } else {
                old_idx - 1
            };
            self.verts[i].bulge = -old[src].bulge;
        }
    }

    /// 🔴 THE ONE DOOR FROM THIS MODULE'S CONTOUR MODEL INTO
    /// `cavalier_contours`, AND THEREFORE THE ONE PLACE THE ZERO-LENGTH-SEGMENT
    /// DEFECT HAS TO BE STOPPED.
    ///
    /// `parallel_offset` derives each offset segment from the direction of the
    /// segment it offsets: `line_v.unit_perp()`, which is
    /// `perp().normalize()`, which is `scale(1.0 / length())`. On a zero-length
    /// segment that is `0.0 * (1.0 / 0.0)` — **NaN in both components** — and
    /// the resulting loop comes back with NaN vertices. Those then flow into the
    /// toolpath, past every bound (see [`crate::types::Toolpath::recompute_bounds`]),
    /// and out as `G1 XNaN YNaN`.
    ///
    /// The library knows this is invalid input and says so: `parallel_offset`
    /// opens with `debug_assert!(polyline.remove_repeat_pos(..).is_none(),
    /// "bug: input assumed to not have repeat position vertexes")`. ⚠ **That
    /// assertion is compiled out of a release build** — which is what the CLI,
    /// the gates and the WASM worker all ship — so the only build that ever
    /// complained was the one nobody cuts with.
    ///
    /// Every question this module asks the library — area, length, bounds,
    /// offset — goes through here, so cleaning the polyline at this single point
    /// covers all four rather than only the one that was observed failing.
    fn to_pline(&self) -> Polyline {
        let mut clean = self.clone();
        clean.dedupe_positions();
        let mut p = Polyline::with_capacity(clean.verts.len(), clean.closed);
        for v in &clean.verts {
            p.add(v.x, v.y, v.bulge);
        }
        p
    }

    fn from_pline(p: &Polyline) -> Self {
        Self {
            verts: p
                .iter_vertexes()
                .map(|v: PlineVertex<f64>| Vertex { x: v.x, y: v.y, bulge: v.bulge })
                .collect(),
            closed: p.is_closed(),
        }
    }

    /// Offset by `delta` mm. **Positive grows the material outward, negative
    /// eats into it** — for a contour in the winding this module normalises to
    /// (CCW = material, CW = hole). That is OUR convention and it is chosen to
    /// match how a machinist speaks: "leave 0.2 on" is positive.
    ///
    /// 🔴 It is the OPPOSITE of `cavalier_contours::parallel_offset`, which
    /// offsets to the LEFT of travel — inward for a CCW loop. The sign is
    /// flipped here, in one place, deliberately: a library's convention leaking
    /// into CAM parameters is how a "grow by the tool radius" ends up cutting
    /// the part undersize by a full diameter. The tests below pin the direction
    /// by measured bounds, not by reading the docs.
    ///
    /// Returns **all** resulting loops: an offset can split one contour into
    /// several (a dumbbell shape pinched in the middle) or eliminate it
    /// entirely (a slot narrower than the tool). Both outcomes are facts the
    /// caller must handle — an empty result is NOT an error here, but silently
    /// treating it as "nothing to cut" IS a defect, so the caller is made to
    /// look at it.
    pub fn offset(&self, delta: f64) -> Vec<Contour> {
        if self.verts.len() < 2 {
            return Vec::new();
        }
        self.to_pline()
            .parallel_offset(-delta)
            .iter()
            .map(Self::from_pline)
            .collect()
    }

    /// Recognise a full circle: two vertices, both half-turn bulges. Returns
    /// `(cx, cy, r)`.
    ///
    /// Used to decide whether a hole should be DRILLED rather than contoured —
    /// a bore the size of the cutter has no contour to follow.
    pub fn as_circle(&self) -> Option<(f64, f64, f64)> {
        if self.verts.len() != 2 || !self.closed {
            return None;
        }
        let (a, b) = (self.verts[0], self.verts[1]);
        if (a.bulge.abs() - 1.0).abs() > 1e-6 || (b.bulge.abs() - 1.0).abs() > 1e-6 {
            return None;
        }
        let cx = (a.x + b.x) * 0.5;
        let cy = (a.y + b.y) * 0.5;
        let r = ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt() * 0.5;
        Some((cx, cy, r))
    }

    /// Axis-aligned bounds, arcs included.
    pub fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let p = self.to_pline();
        p.extents().map(|e| (e.min_x, e.min_y, e.max_x, e.max_y))
    }

    /// Total path length, arcs measured as arcs.
    pub fn path_length(&self) -> f64 {
        self.to_pline().path_length()
    }
}

/// A machinable part: one outer boundary plus any number of interior holes.
///
/// 🔴 The holes are the point. A nested outline WITHOUT them looks
/// correct and cuts parts with no rabbets and no holes — see gate P8.
#[derive(Clone, Debug, Default)]
pub struct Part {
    pub name: String,
    pub outer: Contour,
    pub inners: Vec<Contour>,
}

impl Part {
    pub fn new(name: impl Into<String>, outer: Contour) -> Self {
        let mut outer = outer;
        outer.normalise_winding(true);
        Self { name: name.into(), outer, inners: Vec::new() }
    }

    pub fn with_hole(mut self, mut hole: Contour) -> Self {
        hole.normalise_winding(false);
        self.inners.push(hole);
        self
    }

    pub fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        self.outer.bounds()
    }

    /// Apply a nest transform: rotate about the part's own origin, then
    /// translate. Applied to the **full** geometry, holes included.
    pub fn transform(&mut self, rot_rad: f64, dx: f64, dy: f64) {
        let (s, c) = rot_rad.sin_cos();
        let apply = |v: &mut Vertex| {
            let (x, y) = (v.x, v.y);
            v.x = x * c - y * s + dx;
            v.y = x * s + y * c + dy;
            // Bulge is rotation-invariant: it encodes sweep, not orientation.
        };
        self.outer.verts.iter_mut().for_each(apply);
        for h in &mut self.inners {
            h.verts.iter_mut().for_each(apply);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-6;

    /// The same rectangle, written the way a DXF writer writes it: the closing
    /// vertex repeats the first.
    fn rect_with_a_closing_duplicate() -> Contour {
        Contour::closed(vec![
            Vertex::line(0.0, 0.0),
            Vertex::line(100.0, 0.0),
            Vertex::line(100.0, 60.0),
            Vertex::line(0.0, 60.0),
            Vertex::line(0.0, 0.0),
        ])
    }

    /// 🔴 Answering `cad`'s question directly: their `DUPCLOSE` gate catches the
    /// **closing** duplicate only, and they asked which of the remaining
    /// degenerate cases we absorb. A mid-ring duplicate is the one they said
    /// *"would still reach you and we would not catch it"*.
    ///
    /// It reaches us and it is absorbed — `dedupe_positions` compares each vertex
    /// against the one before it, so ANY consecutive repeat goes, wherever it sits
    /// in the ring. Their gate and this drop are complementary, not redundant: they
    /// stop it entering a shipped DXF, we stop it reaching the offsetter from any
    /// other writer.
    ///
    /// ⚠ And our tolerance is the LOOSER of the two by four orders of magnitude —
    /// `POS_EQUAL_EPS` is 1e-5mm against their `DUP_TOL` of 1e-9mm. So a
    /// near-duplicate that passes their gate as "distinct" is still collapsed here.
    /// That asymmetry is the safe direction and it is asserted below, not assumed:
    /// a gate upstream that is stricter than the consumer's tolerance would leave
    /// a band of inputs that pass inspection and still divide by ~zero.
    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn a_duplicate_in_the_MIDDLE_of_a_ring_is_absorbed_too_not_just_the_closing_one() {
        let clean = Contour::rect(0.0, 0.0, 100.0, 60.0);

        // The repeat sits between two real corners — nowhere near the wrap pair.
        let mut mid = Contour::closed(vec![
            Vertex::line(0.0, 0.0),
            Vertex::line(100.0, 0.0),
            Vertex::line(100.0, 0.0), // <- zero-length segment, mid-ring
            Vertex::line(100.0, 60.0),
            Vertex::line(0.0, 60.0),
        ]);
        assert_eq!(mid.dedupe_positions(), 1, "the mid-ring repeat was not dropped");

        let a = clean.offset(3.0);
        let b = mid.offset(3.0);
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), a.len(), "mid-ring duplicate changed the loop count");
        for loop_ in &b {
            for v in &loop_.verts {
                assert!(
                    v.x.is_finite() && v.y.is_finite(),
                    "a mid-ring duplicate produced a non-finite offset vertex: {v:?}"
                );
            }
        }
    }

    /// The tolerance boundary, stated as a checked property so nobody "tidies"
    /// `POS_EQUAL_EPS` down to match cad's 1e-9 and re-opens the band between them.
    #[test]
    fn a_near_duplicate_inside_our_eps_is_collapsed_even_though_it_is_not_bit_identical() {
        // 1e-9mm apart: BELOW our eps, and exactly the size cad's gate treats as
        // still-distinct. A segment this short is a division by ~zero to the
        // offsetter, so being "not identical" is no protection at all.
        let mut near = Contour::closed(vec![
            Vertex::line(0.0, 0.0),
            Vertex::line(100.0, 0.0),
            Vertex::line(100.0 + 1e-9, 0.0),
            Vertex::line(100.0, 60.0),
            Vertex::line(0.0, 60.0),
        ]);
        assert_eq!(
            near.dedupe_positions(),
            1,
            "a vertex 1e-9mm from its neighbour survived — that is a zero-length \
             segment as far as the offsetter's normalisation is concerned"
        );
    }

    #[test]
    fn a_repeated_vertex_offsets_to_the_same_loop_as_the_clean_contour() {
        // 🔴 THE DEFECT, at its source. `cavalier_contours::parallel_offset`
        // normalises each segment direction — `unit_perp()` is
        // `perp().normalize()` and `normalize()` is `scale(1/length())`. On a
        // ZERO-LENGTH segment that is `0 * (1/0)` = NaN in both components, so
        // the offset loop comes back carrying NaN vertices. In a debug build
        // cavalier's own `debug_assert!(remove_repeat_pos(..).is_none())` fires;
        // in RELEASE — which is what the CLI, the gates and the WASM ship — the
        // assertion is compiled out and the NaN travels all the way to
        // `G1 XNaN YNaN`.
        //
        // The property asserted is the one that matters physically: a repeated
        // vertex describes a segment of zero length, which removes no material
        // at any tool radius, so the CUT must be identical to the cut of the
        // same rectangle written without it.
        let clean = Contour::rect(0.0, 0.0, 100.0, 60.0);
        let dup = rect_with_a_closing_duplicate();

        let a = clean.offset(3.0);
        let b = dup.offset(3.0);
        assert_eq!(a.len(), 1, "clean contour: {} loops", a.len());
        assert_eq!(b.len(), 1, "duplicated contour: {} loops", b.len());
        for v in &b[0].verts {
            assert!(
                v.x.is_finite() && v.y.is_finite() && v.bulge.is_finite(),
                "the offset produced a non-finite vertex {v:?} — a zero-length segment was \
                 normalised by its own length"
            );
        }
        assert_eq!(
            a[0].verts.len(),
            b[0].verts.len(),
            "the duplicate changed the offset loop: {:?} vs {:?}",
            a[0].verts,
            b[0].verts
        );
        for (x, y) in a[0].verts.iter().zip(b[0].verts.iter()) {
            assert!(
                (x.x - y.x).abs() < EPS && (x.y - y.y).abs() < EPS && (x.bulge - y.bulge).abs() < EPS,
                "the duplicate moved a vertex: {x:?} vs {y:?}"
            );
        }
    }

    #[test]
    fn dropping_a_closing_duplicate_does_not_eat_the_arc_before_it() {
        // ⚠ The trap in the obvious implementation. `cavalier_contours`' own
        // `remove_repeat_pos` drops the repeat and TRANSFERS its bulge onto the
        // vertex it kept. Doing that on the wrap-around pair of a closed contour
        // would overwrite the last real arc's bulge with the closing vertex's
        // (zero) one — turning the final fillet into a straight chord, which is
        // a wrong part rather than a crash and therefore harder to notice.
        let mut rr = Contour::rounded_rect(0.0, 0.0, 60.0, 40.0, 8.0);
        let arcs_before = rr.verts.iter().filter(|v| v.bulge.abs() > 1e-12).count();
        let first = rr.verts[0];
        rr.verts.push(Vertex::line(first.x, first.y));
        rr.closed = true;

        assert!(
            (rr.signed_area() - Contour::rounded_rect(0.0, 0.0, 60.0, 40.0, 8.0).signed_area())
                .abs()
                < 1e-6,
            "the closing duplicate changed the enclosed area"
        );
        let out = rr.offset(2.0);
        assert_eq!(out.len(), 1);
        for v in &out[0].verts {
            assert!(v.x.is_finite() && v.y.is_finite() && v.bulge.is_finite(), "non-finite {v:?}");
        }
        let arcs_after = out[0].verts.iter().filter(|v| v.bulge.abs() > 1e-12).count();
        assert!(
            arcs_after >= arcs_before,
            "a fillet was lost dropping the closing vertex: {arcs_before} arcs in, {arcs_after} out"
        );
    }

    #[test]
    fn a_contour_that_is_only_one_point_offsets_to_nothing() {
        // Two vertices at the same place is not a contour, it is a point. It
        // must come back as NOTHING so the caller refuses it — not as a loop of
        // NaN, which every downstream check reads as a real path.
        let point = Contour::closed(vec![Vertex::line(25.0, 25.0), Vertex::line(25.0, 25.0)]);
        let out = point.offset(3.0);
        assert!(out.is_empty(), "a single point produced {} offset loop(s)", out.len());
    }

    #[test]
    fn rect_is_counter_clockwise_and_has_the_right_area() {
        let r = Contour::rect(0.0, 0.0, 10.0, 5.0);
        assert!((r.signed_area() - 50.0).abs() < EPS, "area {}", r.signed_area());
    }

    #[test]
    fn circle_area_uses_the_arc_not_the_chord() {
        // Two vertices only. A shoelace over them gives ZERO — which is exactly
        // the failure this test exists to catch.
        let c = Contour::circle(0.0, 0.0, 10.0);
        assert_eq!(c.verts.len(), 2);
        let want = std::f64::consts::PI * 100.0;
        assert!((c.signed_area() - want).abs() < 1e-3, "area {} want {want}", c.signed_area());
    }

    #[test]
    fn rounded_rect_area_is_between_the_square_and_the_inscribed_shape() {
        let rr = Contour::rounded_rect(0.0, 0.0, 40.0, 20.0, 5.0);
        let square = 40.0 * 20.0;
        let corners_removed = square - (4.0 - std::f64::consts::PI) * 25.0;
        assert!((rr.signed_area() - corners_removed).abs() < 1e-3);
    }

    #[test]
    fn reverse_flips_winding_and_preserves_area_magnitude() {
        let mut c = Contour::rounded_rect(0.0, 0.0, 40.0, 20.0, 5.0);
        let a0 = c.signed_area();
        c.reverse();
        let a1 = c.signed_area();
        assert!(a0 > 0.0 && a1 < 0.0, "winding did not flip: {a0} -> {a1}");
        assert!((a0 + a1).abs() < 1e-6, "area magnitude changed: {a0} vs {a1}");
    }

    #[test]
    fn reverse_twice_is_the_identity() {
        // A bulge belongs to the FOLLOWING segment, so a naive reverse corrupts
        // arcs. Round-tripping is the cheapest way to catch that.
        let mut c = Contour::rounded_rect(1.0, 2.0, 40.0, 20.0, 5.0);
        let orig = c.clone();
        c.reverse();
        c.reverse();
        for (a, b) in orig.verts.iter().zip(c.verts.iter()) {
            assert!(
                (a.x - b.x).abs() < EPS && (a.y - b.y).abs() < EPS && (a.bulge - b.bulge).abs() < EPS,
                "vertex changed across a double reverse: {a:?} vs {b:?}"
            );
        }
    }

    #[test]
    fn offset_outward_grows_a_rectangle_by_exactly_the_delta() {
        let r = Contour::rect(10.0, 10.0, 100.0, 50.0);
        let out = r.offset(3.0);
        assert_eq!(out.len(), 1, "expected one loop, got {}", out.len());
        let (minx, miny, maxx, maxy) = out[0].bounds().unwrap();
        assert!((minx - 7.0).abs() < EPS, "minx {minx}");
        assert!((miny - 7.0).abs() < EPS, "miny {miny}");
        assert!((maxx - 113.0).abs() < EPS, "maxx {maxx}");
        assert!((maxy - 63.0).abs() < EPS, "maxy {maxy}");
    }

    #[test]
    fn offset_keeps_arcs_as_arcs() {
        // The whole reason this library was chosen. If the offset returns only
        // zero bulges, every curve became a polyline and gate G10 will bite.
        let rr = Contour::rounded_rect(0.0, 0.0, 60.0, 40.0, 8.0);
        let out = rr.offset(3.0);
        assert_eq!(out.len(), 1);
        let arcs = out[0].verts.iter().filter(|v| v.bulge.abs() > 1e-9).count();
        assert!(arcs >= 4, "offset produced {arcs} arc segments — curves were polylined");
    }

    #[test]
    fn a_slot_narrower_than_the_tool_offsets_to_nothing() {
        // Negative control for the "uncuttable feature" class: a 4mm slot with a
        // 6mm cutter must NOT come back as a tiny path that would be cut anyway.
        let slot = Contour::rect(0.0, 0.0, 40.0, 4.0);
        let out = slot.offset(-3.0);
        assert!(out.is_empty(), "a 4mm slot survived a 6mm tool: {} loops", out.len());
    }

    #[test]
    fn part_transform_moves_holes_with_the_outline() {
        // 🔴 P8: a nest that transforms only the outline cuts a part with no
        // holes and it LOOKS correct.
        let mut p = Part::new("plate", Contour::rect(0.0, 0.0, 100.0, 50.0))
            .with_hole(Contour::circle(50.0, 25.0, 5.0));
        p.transform(0.0, 200.0, 300.0);
        let (hx0, hy0, hx1, hy1) = p.inners[0].bounds().unwrap();
        assert!((hx0 - 245.0).abs() < 1e-3 && (hx1 - 255.0).abs() < 1e-3, "hole x {hx0}..{hx1}");
        assert!((hy0 - 320.0).abs() < 1e-3 && (hy1 - 330.0).abs() < 1e-3, "hole y {hy0}..{hy1}");
    }

    #[test]
    fn part_normalises_hole_winding_opposite_to_the_outer() {
        let p = Part::new("plate", Contour::rect(0.0, 0.0, 100.0, 50.0))
            .with_hole(Contour::circle(50.0, 25.0, 5.0));
        assert!(p.outer.signed_area() > 0.0, "outer must be CCW");
        assert!(p.inners[0].signed_area() < 0.0, "hole must be CW");
    }
}
