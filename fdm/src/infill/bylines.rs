//! Port of `FillRectilinear::fill_surface_by_lines` (non-monotonic path): vertical infill lines, cut by the
//! polygon (OUTER) and linked along a half-bead-inset contour (INNER) into zig-zag polylines.
//! Used by rectilinear, aligned rectilinear, zig-zag and cross-zag sparse infill.
//! libslic3r/Fill/FillRectilinear.cpp: slice_region_by_vertical_lines, connect_segment_intersections_by_contours,
//! traverse_graph_generate_polylines. Integer nm arithmetic like the original.
use super::gx::{self, P};
use super::Ctx;
use crate::types::Poly;

const NM: f64 = 1e6;
const EPS_NM: i64 = 100; // SCALED_EPSILON
type IP = [i64; 2];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ty { Unknown, OuterLow, OuterHigh, InnerLow, InnerHigh }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Link { Horizontal, Up, Down }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Quality { Invalid, Valid, TooLong }

#[derive(Clone, Debug)]
struct SI {
    i_contour: usize,
    i_segment: usize,
    pos_p: i64,
    pos_q: u32,
    prev_on_contour: i32,
    next_on_contour: i32,
    ty: Ty,
    prev_type: Link,
    next_type: Link,
    prev_quality: Quality,
    next_quality: Quality,
    consumed_vertical_up: bool,
    consumed_perimeter_right: bool,
}
impl SI {
    fn new() -> SI {
        SI { i_contour: 0, i_segment: 0, pos_p: 0, pos_q: 1, prev_on_contour: 0, next_on_contour: 0, ty: Ty::Unknown, prev_type: Link::Horizontal, next_type: Link::Horizontal,
             prev_quality: Quality::Valid, next_quality: Quality::Valid, consumed_vertical_up: false, consumed_perimeter_right: false }
    }
    fn pos(&self) -> i64 {
        let mut p = self.pos_p;
        if p < 0 { p -= (self.pos_q >> 1) as i64; } else { p += (self.pos_q >> 1) as i64; }
        p / self.pos_q as i64
    }
    fn is_inner(&self) -> bool { matches!(self.ty, Ty::InnerLow | Ty::InnerHigh) }
    fn is_outer(&self) -> bool { matches!(self.ty, Ty::OuterLow | Ty::OuterHigh) }
    fn is_low(&self) -> bool { matches!(self.ty, Ty::InnerLow | Ty::OuterLow) }
    fn has_left_horizontal(&self) -> bool { self.prev_type == Link::Horizontal }
    fn has_right_horizontal(&self) -> bool { self.next_type == Link::Horizontal }
    fn has_left_vertical_up(&self) -> bool { self.prev_type == Link::Up }
    fn has_left_vertical_down(&self) -> bool { self.prev_type == Link::Down }
    fn has_left_vertical(&self) -> bool { self.has_left_vertical_up() || self.has_left_vertical_down() }
    fn has_right_vertical_up(&self) -> bool { self.next_type == Link::Up }
    fn has_right_vertical_down(&self) -> bool { self.next_type == Link::Down }
    fn has_right_vertical(&self) -> bool { self.has_right_vertical_up() || self.has_right_vertical_down() }
    fn left_horizontal(&self) -> i32 { if self.has_left_horizontal() { self.prev_on_contour } else { -1 } }
    fn right_horizontal(&self) -> i32 { if self.has_right_horizontal() { self.next_on_contour } else { -1 } }
    fn left_vertical(&self) -> i32 { if self.has_left_vertical() { self.prev_on_contour } else { -1 } }
    fn right_vertical(&self) -> i32 { if self.has_right_vertical() { self.next_on_contour } else { -1 } }
    fn left_vertical_up(&self) -> i32 { if self.has_left_vertical_up() { self.prev_on_contour } else { -1 } }
    fn left_vertical_down(&self) -> i32 { if self.has_left_vertical_down() { self.prev_on_contour } else { -1 } }
    fn right_vertical_up(&self) -> i32 { if self.has_right_vertical_up() { self.next_on_contour } else { -1 } }
    fn right_vertical_down(&self) -> i32 { if self.has_right_vertical_down() { self.next_on_contour } else { -1 } }
    fn vertical_up(&self) -> i32 { if self.has_left_vertical_up() { self.left_vertical_up() } else { self.right_vertical_up() } }
    fn vertical_up_quality(&self) -> Quality { if self.has_left_vertical_up() { self.prev_quality } else { self.next_quality } }
    fn vertical_down(&self) -> i32 { if self.has_left_vertical_down() { self.left_vertical_down() } else { self.right_vertical_down() } }
    fn vertical_down_quality(&self) -> Quality { if self.has_left_vertical_down() { self.prev_quality } else { self.next_quality } }
    fn vertical_outside(&self) -> i32 { if self.is_low() { self.vertical_down() } else { self.vertical_up() } }
    fn vertical_outside_quality(&self) -> Quality { if self.is_low() { self.vertical_down_quality() } else { self.vertical_up_quality() } }
    fn horizontal(&self, right: bool) -> i32 { if right { self.right_horizontal() } else { self.left_horizontal() } }
    fn has_vertical_side(&self, right: bool) -> bool { if right { self.has_right_vertical() } else { self.has_left_vertical() } }
    fn horizontal_quality(&self, right: bool) -> Quality { if right { self.next_quality } else { self.prev_quality } }
    fn less(&self, o: &SI) -> bool { (self.pos_p as i128) * (o.pos_q as i128) < (o.pos_p as i128) * (self.pos_q as i128) }
}

struct SIL { pos: i64, intersections: Vec<SI> }

struct Contours { polys: Vec<Vec<IP>>, n_outer: usize }
impl Contours {
    fn is_outer(&self, i: usize) -> bool { i < self.n_outer }
    fn contour(&self, i: usize) -> &Vec<IP> { &self.polys[i] }
}

fn to_ip(p: P) -> IP { [(p[0] * NM).round() as i64, (p[1] * NM).round() as i64] }
fn rot_ip(p: IP, a: f64) -> IP {
    let (s, c) = (a.sin(), a.cos());
    let (x, y) = (p[0] as f64, p[1] as f64);
    [(c * x - s * y).round() as i64, (s * x + c * y).round() as i64]
}
fn dedup_ring(mut v: Vec<IP>) -> Vec<IP> {
    v.dedup();
    while v.len() > 1 && v[0] == v[v.len() - 1] { v.pop(); }
    v
}

fn segment_length(poly: &[IP], seg1: usize, p1: IP, seg2: usize, p2: IP) -> f64 {
    let d = |a: IP, b: IP| (((a[0] - b[0]) as f64).powi(2) + ((a[1] - b[1]) as f64).powi(2)).sqrt();
    let mut prev = p1;
    let mut len = 0.0;
    if seg1 <= seg2 {
        for i in seg1..seg2 { len += d(prev, poly[i]); prev = poly[i]; }
    } else {
        for i in seg1..poly.len() { len += d(prev, poly[i]); prev = poly[i]; }
        for i in 0..seg2 { len += d(prev, poly[i]); prev = poly[i]; }
    }
    len + d(prev, p2)
}
fn polygon_segment_append(out: &mut Vec<IP>, poly: &[IP], seg1: usize, seg2: usize) {
    if seg1 == seg2 {}
    else if seg1 < seg2 { out.extend_from_slice(&poly[seg1..seg2]); }
    else { out.extend_from_slice(&poly[seg1..]); out.extend_from_slice(&poly[..seg2]); }
}
fn polygon_segment_append_reversed(out: &mut Vec<IP>, poly: &[IP], seg1: usize, seg2: usize) {
    if seg1 >= seg2 { let mut i = seg1; while i > seg2 { out.push(poly[i - 1]); i -= 1; } }
    else {
        let mut i = seg1; while i > 0 { out.push(poly[i - 1]); i -= 1; }
        let mut i = poly.len(); while i > seg2 { out.push(poly[i - 1]); i -= 1; }
    }
}
fn distance_of_segments(poly_len: usize, seg1: usize, seg2: usize, forward: bool) -> i32 {
    let mut d = seg2 as i32 - seg1 as i32;
    if !forward { d = -d; }
    if d < 0 { d += poly_len as i32; }
    d
}

fn slice_region_by_vertical_lines(cs: &Contours, n_vlines: usize, x0: i64, line_spacing: i64) -> Result<Vec<SIL>, String> {
    let mut segs: Vec<SIL> = (0..n_vlines).map(|i| SIL { pos: x0 + i as i64 * line_spacing, intersections: Vec::new() }).collect();
    for ic in 0..cs.polys.len() {
        let contour = cs.contour(ic);
        let n = contour.len();
        if n < 2 { continue; }
        for is in 0..n {
            let ip = if is == 0 { n } else { is } - 1;
            let (p1, p2) = (contour[ip], contour[is]);
            let (mut l, mut r) = (p1[0], p2[0]);
            if l > r { std::mem::swap(&mut l, &mut r); }
            let mut il = ((l - x0) / line_spacing) as i64;
            while il * line_spacing + x0 < l { il += 1; }
            il = il.max(0);
            let mut ir = ((r - x0 + line_spacing) / line_spacing) as i64;
            while ir * line_spacing + x0 > r { ir -= 1; }
            ir = ir.min(segs.len() as i64 - 1);
            if il > ir { continue; }
            for i in il..=ir {
                let this_x = segs[i as usize].pos;
                let mut s = SI::new();
                s.i_contour = ic;
                s.i_segment = is;
                if p1[0] == this_x {
                    if p2[0] == this_x { continue; }
                    let p0 = contour[(ip + n - 1) % n];
                    if (p0[0] - p1[0]) as i128 * (p2[0] - p1[0]) as i128 > 0 { continue; }
                    s.pos_p = p1[1];
                    s.pos_q = 1;
                } else if p2[0] == this_x {
                    let p3 = contour[(is + 1) % n];
                    if (p3[0] - p2[0]) as i128 * (p1[0] - p2[0]) as i128 > 0 { continue; }
                    s.pos_p = p2[1];
                    s.pos_q = 1;
                } else {
                    if p2[0] > p1[0] { s.pos_p = this_x - p1[0]; s.pos_q = (p2[0] - p1[0]) as u32; }
                    else { s.pos_p = p1[0] - this_x; s.pos_q = (p1[0] - p2[0]) as u32; }
                    s.pos_p *= p2[1] - p1[1];
                    s.pos_p += p1[1] * s.pos_q as i64;
                }
                segs[i as usize].intersections.push(s);
            }
        }
    }
    for sil in segs.iter_mut() {
        sil.intersections.sort_by(|a, b| if a.less(b) { std::cmp::Ordering::Less } else if b.less(a) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal });
        let mut j = 0usize;
        for i in 0..sil.intersections.len() {
            let ic = sil.intersections[i].i_contour;
            let contour = cs.contour(ic);
            let is = sil.intersections[i].i_segment;
            let ip = (if is == 0 { contour.len() } else { is }) - 1;
            let dir = contour[is][0] - contour[ip][0];
            let low = dir > 0;
            sil.intersections[i].ty = if cs.is_outer(ic) { if low { Ty::OuterLow } else { Ty::OuterHigh } } else if low { Ty::InnerLow } else { Ty::InnerHigh };
            let mut take_next = true;
            if j > 0 {
                let cur = sil.intersections[i].clone();
                let is2 = sil.intersections[j - 1].clone();
                if ic == is2.i_contour && cur.pos_q == 1 && is2.pos_q == 1 {
                    if cur.pos_p == is2.pos_p { take_next = false; }
                    else if cur.ty == is2.ty {
                        if !low { sil.intersections[j - 1] = cur; }
                        take_next = false;
                    }
                }
            }
            if take_next {
                if j < i { sil.intersections[j] = sil.intersections[i].clone(); }
                j += 1;
            }
        }
        sil.intersections.truncate(j);
    }
    // verification (InfillFailedException when broken)
    for sil in &segs {
        let it = &sil.intersections;
        if it.len() & 1 != 0 { return Err("odd number of intersections".into()); }
        let mut i = 0;
        while i < it.len() {
            if it[i].ty != Ty::OuterLow { return Err("expected OUTER_LOW".into()); }
            let mut j = i + 1;
            if j >= it.len() { return Err("truncated".into()); }
            if !(it[j].ty == Ty::InnerLow || it[j].ty == Ty::OuterHigh) { return Err("bad sequence".into()); }
            while j < it.len() && it[j].is_inner() { j += 1; }
            if j >= it.len() || j & 1 != 1 || it[j].ty != Ty::OuterHigh { return Err("bad run".into()); }
            if !(i + 1 == j || it[j - 1].ty == Ty::InnerHigh) { return Err("bad inner high".into()); }
            i = j + 1;
        }
    }
    Ok(segs)
}

fn connect_segment_intersections(cs: &Contours, segs: &mut Vec<SIL>, dont_connect: bool, link_max_length: i64) {
    for iv in 0..segs.len() {
        let n_int = segs[iv].intersections.len();
        for ii in 0..n_int {
            let itsct = segs[iv].intersections[ii].clone();
            let poly = cs.contour(itsct.i_contour);
            let forward = itsct.is_low();
            let (mut iprev, mut d_prev) = (-1i32, i32::MAX);
            if iv > 0 {
                for (i, it2) in segs[iv - 1].intersections.iter().enumerate() {
                    if itsct.i_contour == it2.i_contour && itsct.ty == it2.ty {
                        let d = distance_of_segments(poly.len(), it2.i_segment, itsct.i_segment, forward);
                        if d < d_prev { iprev = i as i32; d_prev = d; }
                    }
                }
            }
            let (mut inext, mut d_next) = (-1i32, i32::MAX);
            if iv + 1 < segs.len() {
                for (i, it2) in segs[iv + 1].intersections.iter().enumerate() {
                    if itsct.i_contour == it2.i_contour && itsct.ty == it2.ty {
                        let d = distance_of_segments(poly.len(), itsct.i_segment, it2.i_segment, forward);
                        if d < d_next { inext = i as i32; d_next = d; }
                    }
                }
            }
            let (mut same_prev, mut same_next) = (false, false);
            for (i, it2) in segs[iv].intersections.iter().enumerate() {
                if i != ii && it2.i_contour == itsct.i_contour && it2.ty != itsct.ty {
                    let d = distance_of_segments(poly.len(), it2.i_segment, itsct.i_segment, forward);
                    if d < d_prev { iprev = i as i32; d_prev = d; same_prev = true; }
                    let d = distance_of_segments(poly.len(), itsct.i_segment, it2.i_segment, forward);
                    if d < d_next { inext = i as i32; d_next = d; same_next = true; }
                }
            }
            let (mut prev_quality, mut next_quality) = (Quality::Valid, Quality::Valid);
            let prev_type = if same_prev { if iprev < ii as i32 { Link::Down } else { Link::Up } } else { Link::Horizontal };
            let next_type = if same_next { if inext < ii as i32 { Link::Down } else { Link::Up } } else { Link::Horizontal };
            if same_prev {
                let (mut a, mut b) = (ii as i32, iprev);
                if a > b { std::mem::swap(&mut a, &mut b); }
                for k in a + 1..b { if segs[iv].intersections[k as usize].is_inner() { prev_quality = Quality::Invalid; break; } }
            }
            if same_next {
                let (mut a, mut b) = (ii as i32, inext);
                if a > b { std::mem::swap(&mut a, &mut b); }
                for k in a + 1..b { if segs[iv].intersections[k as usize].is_inner() { next_quality = Quality::Invalid; break; } }
            }
            if same_prev && same_next && ((iprev > ii as i32) == (inext > ii as i32)) {
                prev_quality = Quality::Invalid;
                next_quality = Quality::Invalid;
            }
            if dont_connect {
                if prev_quality == Quality::Valid { prev_quality = Quality::TooLong; }
                if next_quality == Quality::Valid { next_quality = Quality::TooLong; }
            } else if link_max_length > 0 {
                let lml = link_max_length as f64;
                if prev_quality == Quality::Valid {
                    let l = if same_prev { measure_vertical(cs, &segs[iv], iprev as usize, ii, forward) } else { measure_horizontal(cs, segs, iv - 1, iprev as usize, ii) };
                    if l > lml { prev_quality = Quality::TooLong; }
                }
                if next_quality == Quality::Valid {
                    let l = if same_next { measure_vertical(cs, &segs[iv], ii, inext as usize, forward) } else { measure_horizontal(cs, segs, iv, ii, inext as usize) };
                    if l > lml { next_quality = Quality::TooLong; }
                }
            }
            let s = &mut segs[iv].intersections[ii];
            s.prev_on_contour = iprev; s.prev_type = prev_type; s.next_on_contour = inext; s.next_type = next_type;
            s.prev_quality = prev_quality; s.next_quality = next_quality;
        }
        // make Invalid symmetric on vertical connections
        for ii in 0..n_int {
            let it = segs[iv].intersections[ii].clone();
            if it.has_left_vertical() && it.prev_quality == Quality::Invalid {
                let k = it.left_vertical() as usize;
                segs[iv].intersections[k].prev_quality = Quality::Invalid;
            }
            if it.has_right_vertical() && it.next_quality == Quality::Invalid {
                let k = it.right_vertical() as usize;
                segs[iv].intersections[k].next_quality = Quality::Invalid;
            }
        }
    }
}

fn measure_horizontal(cs: &Contours, segs: &[SIL], iv: usize, i1: usize, i2: usize) -> f64 {
    let (vl, vl2) = (&segs[iv], &segs[iv + 1]);
    let (it, it2) = (&vl.intersections[i1], &vl2.intersections[i2]);
    let poly = cs.contour(it.i_contour);
    let p1 = [vl.pos, it.pos()];
    let p2 = [vl2.pos, it2.pos()];
    if it.is_low() { segment_length(poly, it.i_segment, p1, it2.i_segment, p2) } else { segment_length(poly, it2.i_segment, p2, it.i_segment, p1) }
}
fn measure_vertical(cs: &Contours, vl: &SIL, i1: usize, i2: usize, forward: bool) -> f64 {
    let (it, it2) = (&vl.intersections[i1], &vl.intersections[i2]);
    let poly = cs.contour(it.i_contour);
    let p1 = [vl.pos, it.pos()];
    let p2 = [vl.pos, it2.pos()];
    if forward { segment_length(poly, it.i_segment, p1, it2.i_segment, p2) } else { segment_length(poly, it2.i_segment, p2, it.i_segment, p1) }
}

fn on_prev_next_vertical_line_valid(segs: &[SIL], iv: usize, ii: usize, right: bool) -> bool {
    let vl_this = &segs[iv];
    let it_this = &vl_this.intersections[ii];
    if it_this.has_vertical_side(right) { return false; }
    let io = it_this.horizontal(right);
    if io == -1 { return false; }
    let vl_other = &segs[if right { iv + 1 } else { iv - 1 }];
    let io = io as usize;
    let it_other = &vl_other.intersections[io];
    let it_other2 = &vl_other.intersections[if it_other.is_low() { io - 1 } else { io + 1 }];
    if it_other2.is_inner() { return false; }
    if it_this.horizontal_quality(right) != Quality::Valid { return false; }
    if if right { it_this.consumed_perimeter_right } else { it_other.consumed_perimeter_right } { return false; }
    if if it_other.is_low() { it_other.consumed_vertical_up } else { vl_other.intersections[io - 1].consumed_vertical_up } { return false; }
    true
}

#[allow(clippy::too_many_arguments)]
fn emit_perimeter_prev_next(cs: &Contours, segs: &[SIL], iv: usize, i_inner_contour: usize, ii: usize, ii2: usize, out: &mut Vec<IP>, dir_is_next: bool) {
    let ivo = if dir_is_next { iv + 1 } else { iv - 1 };
    let itsct = &segs[iv].intersections[ii];
    let itsct2 = &segs[ivo].intersections[ii2];
    let poly = cs.contour(i_inner_contour);
    let forward = itsct.is_low() == dir_is_next;
    if forward { polygon_segment_append(out, poly, itsct.i_segment, itsct2.i_segment); } else { polygon_segment_append_reversed(out, poly, itsct.i_segment, itsct2.i_segment); }
    out.push([segs[ivo].pos, itsct2.pos()]);
}
fn emit_perimeter_on_vertical(cs: &Contours, segs: &[SIL], iv: usize, i_inner_contour: usize, ii: usize, ii2: usize, out: &mut Vec<IP>, forward: bool) {
    let il = &segs[iv];
    let (itsct, itsct2) = (&il.intersections[ii], &il.intersections[ii2]);
    let poly = cs.contour(i_inner_contour);
    if forward { polygon_segment_append(out, poly, itsct.i_segment, itsct2.i_segment); } else { polygon_segment_append_reversed(out, poly, itsct.i_segment, itsct2.i_segment); }
    out.push([il.pos, itsct2.pos()]);
}

fn traverse(cs: &Contours, segs: &mut Vec<SIL>, consistent: bool, out: &mut Vec<Vec<IP>>) {
    // outer-only chords are consumed from the start
    for iv in 0..segs.len() {
        let n = segs[iv].intersections.len();
        for ii in 0..n.saturating_sub(1) {
            if segs[iv].intersections[ii].ty == Ty::OuterLow && segs[iv].intersections[ii + 1].ty == Ty::OuterHigh {
                segs[iv].intersections[ii].consumed_vertical_up = true;
            }
        }
    }
    let mut iv: usize = 0;
    let mut ii: i32 = -1;
    let mut cur: Option<usize> = None; // index into `out`
    loop {
        if ii == -1 {
            let mut found = false;
            'search: for iv2 in 0..segs.len() {
                let n = segs[iv2].intersections.len();
                if n == 0 { continue; }
                let forward_pass = !consistent || iv2 % 2 == 0;
                for i in 0..n {
                    let idx = if forward_pass { i } else { n - i - 1 };
                    let it = &segs[iv2].intersections[idx];
                    if it.is_outer() {
                        let consumed = if it.is_low() { it.consumed_vertical_up } else { segs[iv2].intersections[idx - 1].consumed_vertical_up };
                        if !consumed { iv = iv2; ii = idx as i32; found = true; break 'search; }
                    }
                }
            }
            if !found { break; }
            out.push(vec![[segs[iv].pos, segs[iv].intersections[ii as usize].pos()]]);
            cur = Some(out.len() - 1);
        }
        let ci = cur.unwrap();
        let going_up = segs[iv].intersections[ii as usize].is_low();
        let mut try_connect = false;
        if going_up {
            if segs[iv].intersections[ii as usize].is_inner() { ii -= 1; }
            loop {
                segs[iv].intersections[ii as usize].consumed_vertical_up = true;
                ii += 1;
                if segs[iv].intersections[ii as usize].ty == Ty::OuterHigh { break; }
            }
            if segs[iv].intersections[ii as usize - 1].is_inner() {
                ii -= 1;
                try_connect = true;
            }
        } else {
            if segs[iv].intersections[ii as usize].is_inner() { segs[iv].intersections[ii as usize].consumed_vertical_up = true; }
            loop {
                ii -= 1;
                segs[iv].intersections[ii as usize].consumed_vertical_up = true;
                if segs[iv].intersections[ii as usize].ty == Ty::OuterLow { break; }
            }
            if segs[iv].intersections[ii as usize + 1].is_inner() {
                ii += 1;
                try_connect = true;
            }
        }
        if try_connect {
            let it = segs[iv].intersections[ii as usize].clone();
            let i_prev = it.left_horizontal();
            let i_next = it.right_horizontal();
            let prev_valid = iv > 0 && on_prev_next_vertical_line_valid(segs, iv, ii as usize, false) && !consistent;
            let next_valid = iv + 1 < segs.len() && on_prev_next_vertical_line_valid(segs, iv, ii as usize, true);
            let horizontal_valid = prev_valid || next_valid;
            if i_prev != -1 { segs[iv - 1].intersections[i_prev as usize].consumed_perimeter_right = true; }
            if i_next != -1 { segs[iv].intersections[ii as usize].consumed_perimeter_right = true; }
            if horizontal_valid {
                let mut take_next = next_valid;
                if prev_valid && next_valid {
                    let dp = measure_horizontal(cs, segs, iv - 1, i_prev as usize, ii as usize);
                    let dn = measure_horizontal(cs, segs, iv, ii as usize, i_next as usize);
                    take_next = dn < dp;
                }
                out[ci].push([segs[iv].pos, it.pos()]);
                let target = if take_next { i_next } else { i_prev } as usize;
                emit_perimeter_prev_next(cs, segs, iv, it.i_contour, ii as usize, target, &mut out[ci], take_next);
                if take_next { iv += 1; ii = i_next; } else { iv -= 1; ii = i_prev; }
                continue;
            }
            let i_vertical = it.vertical_outside();
            let vq = if i_vertical == -1 || segs[iv].intersections[(i_vertical + if going_up { 0 } else { -1 }) as usize].consumed_vertical_up { Quality::Invalid } else { it.vertical_outside_quality() };
            if vq != Quality::Invalid {
                out[ci].push([segs[iv].pos, it.pos()]);
                let mut ci2 = ci;
                if vq == Quality::Valid {
                    let fwd = if going_up { it.has_left_vertical_up() } else { it.has_right_vertical_down() };
                    emit_perimeter_on_vertical(cs, segs, iv, it.i_contour, ii as usize, i_vertical as usize, &mut out[ci], fwd);
                } else {
                    out.push(vec![[segs[iv].pos, segs[iv].intersections[i_vertical as usize].pos()]]);
                    ci2 = out.len() - 1;
                }
                cur = Some(ci2);
                if going_up { for k in ii..i_vertical { segs[iv].intersections[k as usize].consumed_vertical_up = true; } }
                else { for k in i_vertical..ii { segs[iv].intersections[k as usize].consumed_vertical_up = true; } }
                segs[iv].intersections[ii as usize].consumed_perimeter_right = true;
                let nk = if going_up { ii + 1 } else { ii - 1 };
                segs[iv].intersections[nk as usize].consumed_perimeter_right = true;
                ii = i_vertical;
                continue;
            }
            ii = if going_up { ii + 1 } else { ii - 1 };
        }
        // finish
        let it = &segs[iv].intersections[ii as usize];
        let point_last = [segs[iv].pos, it.pos()];
        out[ci].push(point_last);
        out[ci].dedup();
        let pl = &out[ci];
        if pl.len() <= 1 || (pl.len() == 2 && (pl[0][0] - pl[1][0]).abs() < EPS_NM && (pl[0][1] - pl[1][1]).abs() < EPS_NM) {
            out.remove(ci);
        }
        ii = -1;
        cur = None;
    }
}

/// `fill_surface_by_lines` for one ExPolygon. `layer_angle` is the pattern's `_layer_angle`; `consistent` selects the
/// zig-zag family (whole-object bbox, forward-only connections); `horiz_move` is the cross-zag shift (mm).
pub fn fill_by_lines(poly: &Poly, cx: &Ctx, layer_angle: f64, consistent: bool, horiz_move: f64, dont_adjust_full: bool) -> Result<Vec<Vec<P>>, String> {
    const INFILL_OVERLAP_OVER_SPACING: f64 = 0.45;
    let spacing = cx.spacing;
    let o = cx.origin;
    let angle = cx.direction_angle(layer_angle); // rotate_vector.first
    let center = [cx.center[0] - o[0], cx.center[1] - o[1]];
    let line_spacing = (spacing * NM / cx.density).trunc() as i64;
    // ExPolygonWithOffset (angle = -rotate_vector.first)
    let shifted = Poly { contour: poly.contour.iter().map(|p| [p[0] - o[0], p[1] - o[1]]).collect(), holes: poly.holes.iter().map(|h| h.iter().map(|p| [p[0] - o[0], p[1] - o[1]]).collect()).collect() };
    let rot = |p: P| -> IP { rot_ip(to_ip(p), -angle) };
    let rotated = Poly { contour: shifted.contour.iter().map(|&p| { let r = rot(p); [r[0] as f64 / NM, r[1] as f64 / NM] }).collect(), holes: shifted.holes.iter().map(|h| h.iter().map(|&p| { let r = rot(p); [r[0] as f64 / NM, r[1] as f64 / NM] }).collect()).collect() };
    let src = vec![rotated];
    let off1 = -(0.5 - INFILL_OVERLAP_OVER_SPACING) * spacing;
    let off2 = -0.5 * spacing;
    let outer = gx::offset(&src, off1);
    let inner = gx::offset(&outer, -(off1 - off2));
    let mut polys: Vec<Vec<IP>> = Vec::new();
    for r in gx::rings(&outer) { let v = dedup_ring(r.iter().map(|&p| to_ip(p)).collect()); if v.len() >= 3 { polys.push(v); } }
    let n_outer = polys.len();
    for r in gx::rings(&inner) { let v = dedup_ring(r.iter().map(|&p| to_ip(p)).collect()); if v.len() >= 3 { polys.push(v); } }
    if polys.len() == n_outer { return Ok(Vec::new()); } // not a single infill line fits
    let cs = Contours { polys, n_outer };
    // bounding boxes
    let mut bb_src = ([i64::MAX; 2], [i64::MIN; 2]);
    for p in &src[0].contour { let q = to_ip(*p); for k in 0..2 { bb_src.0[k] = bb_src.0[k].min(q[k]); bb_src.1[k] = bb_src.1[k].max(q[k]); } }
    let mut bb = bb_src;
    let _ = dont_adjust_full;
    // refpt in the rotated frame
    let refpt = rot_ip(to_ip(center), -angle);
    if consistent {
        // extended_object_bounding_box in the rotated frame is built in object space (unrotated), see below
        let (olo, ohi) = match cx.c.object_bbox { Some((l, h)) => ([l[0] - o[0], l[1] - o[1]], [h[0] - o[0], h[1] - o[1]]), None => { let (l, h) = gx::bbox_pts(poly.contour.iter()).unwrap(); ([l[0] - o[0], l[1] - o[1]], [h[0] - o[0], h[1] - o[1]]) } };
        let c = [((olo[0] + ohi[0]) / 2.0 * NM).trunc(), ((olo[1] + ohi[1]) / 2.0 * NM).trunc()];
        let (mut lo, mut hi) = ([olo[0] * NM - c[0], olo[1] * NM - c[1]], [ohi[0] * NM - c[0], ohi[1] * NM - c[1]]);
        // merge(Point(min.y, min.x)), merge(Point(max.y, max.x))
        let (l2, h2) = ([lo[0].min(lo[1]), lo[1].min(lo[0])], [hi[0].max(hi[1]), hi[1].max(hi[0])]);
        lo = l2; hi = h2;
        let s2 = 2f64.sqrt();
        bb = ([(lo[0] * s2 + c[0]).trunc() as i64, (lo[1] * s2 + c[1]).trunc() as i64], [(hi[0] * s2 + c[0]).trunc() as i64, (hi[1] * s2 + c[1]).trunc() as i64]);
    }
    // pattern alignment: bounding_box.merge(align_to_grid(bb.min, (ls, ls), refpt))
    let al = |v: i64, base: i64| -> i64 { let d = v - base; base + if d < 0 { ((d - line_spacing + 1) / line_spacing) * line_spacing } else { (d / line_spacing) * line_spacing } };
    let a = [al(bb.0[0], refpt[0]), al(bb.0[1], refpt[1])];
    bb.0 = [bb.0[0].min(a[0]), bb.0[1].min(a[1])];
    bb.1 = [bb.1[0].max(a[0]), bb.1[1].max(a[1])];
    let mut n_vlines = ((bb.1[0] - bb.0[0] + line_spacing - 1) / line_spacing) as usize;
    let mut x0 = bb.0[0];
    let horiz = (horiz_move * NM) as f64;
    let gap_line = (horiz / line_spacing as f64) as i64;
    if gap_line % 2 == 0 { x0 += (horiz as i64) - gap_line * line_spacing; } else { x0 += (horiz as i64) - (gap_line - 1) * line_spacing; n_vlines += 1; }
    let mut segs = slice_region_by_vertical_lines(&cs, n_vlines, x0, line_spacing)?;
    let link_max_length = if cx.density > 0.8 { (3.0 * spacing * NM) as i64 } else { 0 };
    connect_segment_intersections(&cs, &mut segs, cx.anchor_max < 0.05, link_max_length);
    let mut out: Vec<Vec<IP>> = Vec::new();
    traverse(&cs, &mut segs, consistent, &mut out);
    // rotate back, remove duplicate points
    let mut res = Vec::new();
    for pl in out {
        let mut v: Vec<IP> = pl.into_iter().map(|p| rot_ip(p, angle)).collect();
        v.dedup();
        if v.len() < 2 { continue; }
        res.push(v.into_iter().map(|p| [p[0] as f64 / NM + o[0], p[1] as f64 / NM + o[1]]).collect());
    }
    Ok(res)
}

/// `sample_grid_pattern(expolygon, spacing, global_bounding_box)`: points every `spacing` along vertical lines
/// spaced `spacing` apart, starting at the global bbox min x (used by the lightning distance field). Integer nm.
pub fn sample_grid_pattern(poly: &Poly, spacing_nm: i64, bbox_min_x: i64, bbox_width: i64) -> Result<Vec<IP>, String> {
    let ring = |r: &Vec<P>| -> Vec<IP> { dedup_ring(r.iter().map(|&p| to_ip(p)).collect()) };
    let mut polys: Vec<Vec<IP>> = vec![ring(&poly.contour)];
    for h in &poly.holes { polys.push(ring(h)); }
    polys.retain(|p| p.len() >= 3);
    let n = polys.len();
    let cs = Contours { polys, n_outer: n };
    let n_vlines = ((bbox_width + spacing_nm - 1) / spacing_nm).max(0) as usize;
    let segs = slice_region_by_vertical_lines(&cs, n_vlines, bbox_min_x, spacing_nm)?;
    let mut out = Vec::new();
    for sil in &segs {
        let mut i = 0;
        while i + 1 < sil.intersections.len() {
            let (a, b) = (sil.intersections[i].pos(), sil.intersections[i + 1].pos());
            let mut y = a - (a % spacing_nm) - spacing_nm;
            while y < b { if y > a { out.push([sil.pos, y]); } y += spacing_nm; }
            i += 2;
        }
    }
    Ok(out)
}
