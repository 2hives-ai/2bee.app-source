//! Integer-exact `FillRectilinear::fill_surface_by_multilines` (grid, triangles, tri-hexagon, cubic, quarter cubic, lateral
//! lattice / honeycomb): `ExPolygonWithOffset`, `slice_region_by_vertical_lines`, `make_fill_lines`, Clipper contraction
//! and clipping, then `connect_infill`. Everything runs on libslic3r's integer grid in the object frame (origin = object
//! centre), with the same float/double mixes as the C++, so that line order, line direction and every tie come out as in
//! OrcaSlicer.
use super::clipper::{self, ExPoly, JoinType, IP};
use super::gx::P;
use super::stdsort::std_sort;
use crate::types::Poly;

const SCALED_EPSILON: i64 = 100;

/// Object frame: integer nm, origin at the object's bounding-box centre (`PrintObject::center_offset`).
#[derive(Clone, Copy, Debug)]
pub struct Frame { pub sx: i64, pub sy: i64 }
impl Frame {
    pub fn new(origin: P) -> Frame { Frame { sx: (origin[0] * 1e6).round() as i64, sy: (origin[1] * 1e6).round() as i64 } }
    pub fn to_obj(&self, p: P) -> IP { [(p[0] * 1e6).round() as i64 - self.sx, (p[1] * 1e6).round() as i64 - self.sy] }
    pub fn to_mm(&self, q: IP) -> P { [(q[0] + self.sx) as f64 / 1e6, (q[1] + self.sy) as f64 / 1e6] }
}

fn dedup_ring(r: Vec<IP>) -> Vec<IP> {
    let mut out: Vec<IP> = Vec::with_capacity(r.len());
    for p in r { if out.last() != Some(&p) { out.push(p); } }
    while out.len() > 1 && out.first() == out.last() { out.pop(); }
    out
}

/// Region polygon (mm) -> libslic3r ExPolygon (contour CCW, holes CW), integer object frame.
pub fn poly_to_iex(poly: &Poly, fr: &Frame) -> ExPoly {
    let mut c = dedup_ring(poly.contour.iter().map(|&p| fr.to_obj(p)).collect());
    if !clipper::orientation(&c) { c.reverse(); }
    let mut holes = Vec::new();
    for h in &poly.holes {
        let mut r = dedup_ring(h.iter().map(|&p| fr.to_obj(p)).collect());
        if r.len() < 3 { continue; }
        if clipper::orientation(&r) { r.reverse(); }
        holes.push(r);
    }
    ExPoly { contour: c, holes }
}

pub fn iex_to_poly(ex: &ExPoly, fr: &Frame) -> Poly {
    Poly { contour: ex.contour.iter().map(|&q| fr.to_mm(q)).collect(), holes: ex.holes.iter().map(|h| h.iter().map(|&q| fr.to_mm(q)).collect()).collect() }
}

pub fn rot_pt(p: IP, cos_a: f64, sin_a: f64) -> IP {
    let (x, y) = (p[0] as f64, p[1] as f64);
    [(cos_a * x - sin_a * y).round() as i64, (cos_a * y + sin_a * x).round() as i64]
}
pub fn rotate_ring(r: &mut [IP], angle: f64) {
    let (c, s) = (angle.cos(), angle.sin());
    for p in r.iter_mut() { *p = rot_pt(*p, c, s); }
}

// ---- Polygon::remove_sticks -----------------------------------------------------------------------------------------
fn is_stick(p1: IP, p2: IP, p3: IP) -> bool {
    let v1 = [p2[0] - p1[0], p2[1] - p1[1]];
    let v2 = [p3[0] - p2[0], p3[1] - p2[1]];
    let dir = v1[0] * v2[0] + v1[1] * v2[1];
    if dir > 0 { return false; }
    let l2_1 = (v1[0] as f64) * (v1[0] as f64) + (v1[1] as f64) * (v1[1] as f64);
    let l2_2 = (v2[0] as f64) * (v2[0] as f64) + (v2[1] as f64) * (v2[1] as f64);
    if dir == 0 { return l2_1 == 0.0 || l2_2 == 0.0; }
    let cross = (v1[0] as f64) * (v2[1] as f64) - (v2[0] as f64) * (v1[1] as f64);
    let dist2 = cross * cross / l2_1.max(l2_2);
    dist2 < 1e-4 * 1e-4 // EPSILON = 1e-4
}
fn remove_sticks_poly(poly: &mut Vec<IP>) -> bool {
    let mut modified = false;
    let mut j = 1usize;
    let n = poly.len();
    let mut i = 1usize;
    while i + 1 < n {
        if !is_stick(poly[j - 1], poly[i], poly[i + 1]) {
            if j < i { poly[j] = poly[i]; }
            j += 1;
        }
        i += 1;
    }
    j += 1;
    if j < poly.len() {
        poly[j - 1] = *poly.last().unwrap();
        poly.truncate(j);
        modified = true;
    }
    while poly.len() >= 3 && is_stick(poly[poly.len() - 2], poly[poly.len() - 1], poly[0]) { poly.pop(); modified = true; }
    while poly.len() >= 3 && is_stick(poly[poly.len() - 1], poly[0], poly[1]) { poly.remove(0); }
    modified
}
fn remove_sticks_polys(polys: &mut Vec<Vec<IP>>) -> bool {
    let mut modified = false;
    let mut j = 0usize;
    for i in 0..polys.len() {
        modified |= remove_sticks_poly(&mut polys[i]);
        if polys[i].len() >= 3 {
            if j < i { polys.swap(i, j); }
            j += 1;
        }
    }
    polys.truncate(j);
    modified
}
fn remove_dup_points(pts: &mut Vec<IP>) {
    if pts.is_empty() { return; }
    let mut j = 0usize;
    for i in 1..pts.len() {
        if pts[j] != pts[i] { j += 1; if j < i { pts[j] = pts[i]; } }
    }
    pts.truncate(j + 1);
}

/// `ExPolygonWithOffset` restricted to what `make_fill_lines` needs (`aoffset2 == 0`: only OUTER contours).
#[derive(Clone)]
pub struct ExWithOffset { pub src: ExPoly, pub outer: Vec<Vec<IP>> }
impl ExWithOffset {
    pub fn new(expolygon: &ExPoly, aoffset1: i64) -> ExWithOffset {
        let mut src = expolygon.clone();
        // remove_sticks(ExPolygon&) = remove_sticks(contour) || remove_sticks(holes)
        if !remove_sticks_poly(&mut src.contour) { remove_sticks_polys(&mut src.holes); }
        let mut outer: Vec<Vec<IP>> = if aoffset1 == 0 {
            std::iter::once(src.contour.clone()).chain(src.holes.iter().cloned()).collect()
        } else {
            clipper::offset_expolygon_paths(&src, aoffset1 as f32, JoinType::Miter, 3.0)
        };
        remove_sticks_polys(&mut outer);
        for c in outer.iter_mut() { remove_dup_points(c); }
        ExWithOffset { src, outer }
    }
    pub fn rotated(&self, angle: f64) -> ExWithOffset {
        let mut o = self.clone();
        rotate_ring(&mut o.src.contour, angle);
        for h in o.src.holes.iter_mut() { rotate_ring(h, angle); }
        for p in o.outer.iter_mut() { rotate_ring(p, angle); }
        o
    }
    pub fn bbox_src(&self) -> (IP, IP) { extents(&self.src.contour) }
}
pub fn extents(pts: &[IP]) -> (IP, IP) {
    let mut lo = [i64::MAX, i64::MAX];
    let mut hi = [i64::MIN, i64::MIN];
    for p in pts { for k in 0..2 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } }
    (lo, hi)
}

#[derive(Clone, Copy)]
struct Inter { contour: usize, seg: usize, pos_p: i64, pos_q: u32, low: bool }
impl Inter {
    fn pos(&self) -> i64 {
        let mut p = self.pos_p;
        if p < 0 { p -= (self.pos_q >> 1) as i64; } else { p += (self.pos_q >> 1) as i64; }
        p / self.pos_q as i64
    }
    fn less(&self, o: &Inter) -> bool { (self.pos_p as i128) * (o.pos_q as i128) < (o.pos_p as i128) * (self.pos_q as i128) }
}
pub struct VLine { pub pos: i64, inters: Vec<Inter> }

/// `slice_region_by_vertical_lines` for OUTER contours only. `None` = libslic3r would throw `InfillFailedException`.
fn slice_region_by_vertical_lines(pwo: &ExWithOffset, n_vlines: usize, x0: i64, line_spacing: i64) -> Option<Vec<VLine>> {
    let mut segs: Vec<VLine> = (0..n_vlines).map(|i| VLine { pos: x0 + i as i64 * line_spacing, inters: Vec::new() }).collect();
    for (ic, contour) in pwo.outer.iter().enumerate() {
        let n = contour.len();
        if n < 2 { continue; }
        for iseg in 0..n {
            let iprev = if iseg == 0 { n } else { iseg } - 1;
            let p1 = contour[iprev];
            let p2 = contour[iseg];
            let (mut l, mut r) = (p1[0], p2[0]);
            if l > r { std::mem::swap(&mut l, &mut r); }
            let mut il = ((l - x0) / line_spacing) as i32;
            while il as i64 * line_spacing + x0 < l as i64 { il += 1; }
            il = il.max(0);
            let mut ir = ((r - x0 + line_spacing) / line_spacing) as i32;
            while ir as i64 * line_spacing + x0 > r as i64 { ir -= 1; }
            ir = ir.min(segs.len() as i32 - 1);
            if il > ir { continue; }
            for i in il..=ir {
                let this_x = segs[i as usize].pos;
                let mut is = Inter { contour: ic, seg: iseg, pos_p: 0, pos_q: 1, low: false };
                if p1[0] == this_x {
                    if p2[0] == this_x { continue; }
                    let p0 = contour[(iprev + n - 1) % n];
                    if (p0[0] - p1[0]) * (p2[0] - p1[0]) > 0 { continue; }
                    is.pos_p = p1[1];
                    is.pos_q = 1;
                } else if p2[0] == this_x {
                    let p3 = contour[(iseg + 1) % n];
                    if (p3[0] - p2[0]) * (p1[0] - p2[0]) > 0 { continue; }
                    is.pos_p = p2[1];
                    is.pos_q = 1;
                } else {
                    if p2[0] > p1[0] { is.pos_p = this_x - p1[0]; is.pos_q = (p2[0] - p1[0]) as u32; }
                    else { is.pos_p = p1[0] - this_x; is.pos_q = (p1[0] - p2[0]) as u32; }
                    is.pos_p *= p2[1] - p1[1];
                    is.pos_p += p1[1] * is.pos_q as i64;
                }
                segs[i as usize].inters.push(is);
            }
        }
    }
    for sil in segs.iter_mut() {
        std_sort(&mut sil.inters, |a, b| a.less(b));
        let mut j = 0usize;
        for i in 0..sil.inters.len() {
            let mut is = sil.inters[i];
            let contour = &pwo.outer[is.contour];
            let n = contour.len();
            let iprev = (is.seg + n - 1) % n;
            let dir = contour[is.seg][0] - contour[iprev][0];
            let low = dir > 0;
            is.low = low;
            sil.inters[i] = is;
            let mut take_next = true;
            if j > 0 {
                let is2 = sil.inters[j - 1];
                if is.contour == is2.contour && is.pos_q == 1 && is2.pos_q == 1 {
                    if is.pos_p == is2.pos_p {
                        take_next = false;
                    } else if is.low == is2.low {
                        if low { /* keep the first */ } else { sil.inters[j - 1] = sil.inters[i]; }
                        take_next = false;
                    }
                }
            }
            if take_next {
                if j < i { sil.inters[j] = sil.inters[i]; }
                j += 1;
            }
        }
        sil.inters.truncate(j);
    }
    // verification (the C++ throws InfillFailedException => the whole fill is dropped)
    for sil in &segs {
        if sil.inters.len() & 1 != 0 { return None; }
        let mut i = 0;
        while i < sil.inters.len() {
            if !sil.inters[i].low { return None; }
            let j = i + 1;
            if j >= sil.inters.len() || sil.inters[j].low { return None; }
            i = j + 1;
        }
    }
    Some(segs)
}

/// `make_fill_lines`.
#[allow(clippy::too_many_arguments)]
fn make_fill_lines(pwo: &ExWithOffset, mut refpt: IP, angle: f64, x_margin: i64, line_spacing: i64, pattern_shift: i64, fill_lines: &mut Vec<Vec<IP>>) -> bool {
    let (mut bb_min, mut bb_max) = pwo.bbox_src();
    let x_min = bb_min[0] + x_margin;
    let x_max = bb_max[0] - x_margin;
    let pattern_shift_scaled = pattern_shift % line_spacing;
    refpt[0] -= if pattern_shift_scaled >= 0 { pattern_shift_scaled } else { line_spacing + pattern_shift_scaled };
    // bounding_box.merge(align_to_grid(bounding_box.min, Point(ls, ls), refpt))
    let align = |coord: i64, spacing: i64, base: i64| -> i64 {
        let c = coord - base;
        let aligned = if c < 0 { ((c - spacing + 1) / spacing) * spacing } else { (c / spacing) * spacing };
        base + aligned
    };
    let ap = [align(bb_min[0], line_spacing, refpt[0]), align(bb_min[1], line_spacing, refpt[1])];
    for k in 0..2 { bb_min[k] = bb_min[k].min(ap[k]); bb_max[k] = bb_max[k].max(ap[k]); }
    let n_vlines = ((bb_max[0] - bb_min[0] + line_spacing - 1) / line_spacing) as usize;
    let (cos_a, sin_a) = (angle.cos(), angle.sin());
    let Some(segs) = slice_region_by_vertical_lines(pwo, n_vlines, bb_min[0], line_spacing) else { return false };
    for vline in &segs {
        if vline.pos >= x_min {
            if vline.pos > x_max { break; }
            let mut it = 0;
            while it + 1 < vline.inters.len() {
                let (lo, hi) = (&vline.inters[it], &vline.inters[it + 1]);
                let (a, b) = ([vline.pos, lo.pos()], [vline.pos, hi.pos()]);
                if angle == 0.0 { fill_lines.push(vec![a, b]); }
                else { fill_lines.push(vec![rot_pt(a, cos_a, sin_a), rot_pt(b, cos_a, sin_a)]); }
                it += 2;
            }
        }
    }
    true
}

/// One `SweepParams` ({angle_base, pattern_shift}, both `float` in libslic3r).
#[derive(Clone, Copy, Debug)]
pub struct SweepF { pub angle: f32, pub shift: f32 }

/// Parameters of one `Fill` object (everything libslic3r's `fill_surface_by_multilines` reads), in libslic3r's types.
pub struct MlParams {
    /// `Fill::spacing` (double from a float flow spacing).
    pub spacing: f64,
    /// `FillParams::density` (float, already the sparse density; divided by the sweep count inside).
    pub density: f32,
    pub multiline: i32,
    /// `Fill::angle` (float radians).
    pub angle: f32,
    /// `_layer_angle(layer_id / thickness_layers)` for this pattern.
    pub layer_angle: f32,
    /// `Fill::bounding_box` (object frame, ints).
    pub bbox: (IP, IP),
    pub anchor: f32,
    pub anchor_max: f32,
}

/// `FillRectilinear::fill_surface_by_multilines` on one ExPolygon in the object frame. Returns polylines in libslic3r order.
pub fn fill_by_multilines_int(ex: &ExPoly, p: &MlParams, sweeps: &[SweepF]) -> Vec<Vec<IP>> {
    let scale_ = |x: f64| x / 1e-6;
    let density = ((p.density as f64) / sweeps.len() as f64) as f32;
    // ExPolygonWithOffset poly_with_offset_base(expolygon, 0, float(scale_(overlap + 0.5 * multiline * spacing)))
    let aoffset1 = (scale_(0.5 * p.multiline as f64 * p.spacing) as f32) as i64;
    let base = ExWithOffset::new(ex, aoffset1);
    if base.outer.is_empty() { return Vec::new(); }
    let line_width = scale_(p.spacing) as i64;
    let line_spacing = (scale_(p.spacing) * p.multiline as f64 / density as f64) as i64;
    // _infill_direction
    let mut out_angle: f32 = p.angle;
    out_angle += p.layer_angle;
    out_angle += (std::f64::consts::PI / 2.0) as f32;
    let center: IP = [(p.bbox.0[0] + p.bbox.1[0]) / 2, (p.bbox.0[1] + p.bbox.1[1]) / 2];
    let mut fill_lines: Vec<Vec<IP>> = Vec::new();
    for sw in sweeps {
        let angle: f32 = out_angle + sw.angle;
        let rot = base.rotated(-(angle as f64));
        let (c, s) = ((-(angle as f64)).cos(), (-(angle as f64)).sin());
        let refpt = rot_pt(center, c, s);
        if !make_fill_lines(&rot, refpt, angle as f64, line_width + SCALED_EPSILON, line_spacing, scale_(sw.shift as f64) as i64, &mut fill_lines) { return Vec::new(); }
    }
    // (multiline_fill is the identity for multiline == 1)
    if p.multiline > 1 { return Vec::new(); }
    // contracted = offset_ex(expolygon, -float(scale_(0.5 * spacing)))
    let contracted = clipper::offset_ex(std::slice::from_ref(ex), -(scale_(0.5 * p.spacing) as f32), JoinType::Miter, 3.0);
    let isect: Vec<ExPoly> = if contracted.is_empty() { vec![ex.clone()] } else { contracted };
    let fill_lines = clipper::intersection_pl(&fill_lines, &isect);
    if fill_lines.is_empty() { return Vec::new(); }
    let boundary: Vec<Vec<IP>> = isect.iter().flat_map(|e| std::iter::once(e.contour.clone()).chain(e.holes.iter().cloned())).collect();
    if p.anchor_max < 0.05 {
        // dont_connect: chain_polylines(...) -- ported by the caller (needs the exact greedy chainer)
        return super::chainpl::chain_polylines_int(fill_lines);
    }
    super::connect::connect_nm_pub(fill_lines, &boundary, scale_(p.spacing), scale_(p.anchor as f64), scale_(p.anchor_max as f64))
}
