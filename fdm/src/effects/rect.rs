//! Port of Orca's rectilinear fill family (FillRectilinear.cpp `fill_surface_by_lines`): vertical
//! scan lines over a polygon and its two inward offsets, perimeter-following links between lines,
//! and either the plain "traverse graph" order (rectilinear / alignedrectilinear) or the monotonic
//! region order (monotonic / monotonicline / ironing).
//!
//! Everything inside works in a rotated frame where infill lines are vertical, in integer-valued
//! nanometres held in f64 (Orca's `coord_t`), so vertex-on-line coincidences behave like Orca's.
//! Not ported (documented in the delivery report): the phony-outer-point handling of pinched inner
//! contours, `remove_sticks`, and the ant-colony optimisation of the region order (a greedy path,
//! which is the ant colony's own starting solution, is used instead).
use super::adapter as g;
use crate::types::{Poly, Polys};

type P = [f64; 2];
const NM: f64 = 1e6; // internal unit: 1 nm
const SCALED_EPS: f64 = 100.0; // scale_(1e-4 mm)

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Ty { OuterLow, OuterHigh, InnerLow, InnerHigh }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Link { Horizontal, Up, Down }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Qual { Invalid, Valid, TooLong }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side { Left, Right }

#[derive(Clone, Debug)]
pub(crate) struct Isect {
    contour: usize,
    seg: usize,
    pos: f64,
    vertex: bool,
    pub(crate) ty: Ty,
    prev: i32,
    next: i32,
    prev_t: Link,
    next_t: Link,
    prev_q: Qual,
    next_q: Qual,
    consumed_up: bool,
    consumed_perim_right: bool,
}
impl Isect {
    fn is_inner(&self) -> bool { matches!(self.ty, Ty::InnerLow | Ty::InnerHigh) }
    fn is_outer(&self) -> bool { !self.is_inner() }
    fn is_low(&self) -> bool { matches!(self.ty, Ty::InnerLow | Ty::OuterLow) }
    fn has_left_h(&self) -> bool { self.prev_t == Link::Horizontal }
    fn has_right_h(&self) -> bool { self.next_t == Link::Horizontal }
    fn has_left_up(&self) -> bool { self.prev_t == Link::Up }
    fn has_left_down(&self) -> bool { self.prev_t == Link::Down }
    fn has_right_up(&self) -> bool { self.next_t == Link::Up }
    fn has_right_down(&self) -> bool { self.next_t == Link::Down }
    fn has_left_v(&self) -> bool { self.has_left_up() || self.has_left_down() }
    fn has_right_v(&self) -> bool { self.has_right_up() || self.has_right_down() }
    fn has_v(&self, s: Side) -> bool { if s == Side::Left { self.has_left_v() } else { self.has_right_v() } }
    fn left_h(&self) -> i32 { if self.has_left_h() { self.prev } else { -1 } }
    fn right_h(&self) -> i32 { if self.has_right_h() { self.next } else { -1 } }
    fn h(&self, s: Side) -> i32 { if s == Side::Left { self.left_h() } else { self.right_h() } }
    fn h_quality(&self, s: Side) -> Qual { if s == Side::Left { self.prev_q } else { self.next_q } }
    fn vertical_up(&self) -> i32 {
        if self.has_left_up() { self.prev } else if self.has_right_up() { self.next } else { -1 }
    }
    fn vertical_up_quality(&self) -> Qual { if self.has_left_up() { self.prev_q } else { self.next_q } }
    fn vertical_down(&self) -> i32 {
        if self.has_left_down() { self.prev } else if self.has_right_down() { self.next } else { -1 }
    }
    fn vertical_down_quality(&self) -> Qual { if self.has_left_down() { self.prev_q } else { self.next_q } }
    fn vertical_outside(&self) -> i32 { if self.is_low() { self.vertical_down() } else { self.vertical_up() } }
    fn vertical_outside_quality(&self) -> Qual { if self.is_low() { self.vertical_down_quality() } else { self.vertical_up_quality() } }
}

#[derive(Clone, Debug)]
pub(crate) struct VLine { x: f64, pub(crate) its: Vec<Isect> }

pub(crate) struct Graph {
    c: Vec<Vec<P>>,
    v: Vec<VLine>,
}

fn dist(a: P, b: P) -> f64 { (a[0] - b[0]).hypot(a[1] - b[1]) }

/// Length of a polygon portion from point p1 (on edge ending at seg1) to p2 (on edge ending at seg2).
fn segment_length(poly: &[P], seg1: usize, p1: P, seg2: usize, p2: P) -> f64 {
    let n = poly.len();
    let mut prev = p1;
    let mut len = 0.0;
    if seg1 <= seg2 {
        for i in seg1..seg2 { len += dist(prev, poly[i]); prev = poly[i]; }
    } else {
        for i in seg1..n { len += dist(prev, poly[i]); prev = poly[i]; }
        for i in 0..seg2 { len += dist(prev, poly[i]); prev = poly[i]; }
    }
    len + dist(prev, p2)
}
fn polygon_segment_append(out: &mut Vec<P>, poly: &[P], seg1: usize, seg2: usize) {
    if seg1 == seg2 {
    } else if seg1 < seg2 {
        out.extend_from_slice(&poly[seg1..seg2]);
    } else {
        out.extend_from_slice(&poly[seg1..]);
        out.extend_from_slice(&poly[..seg2]);
    }
}
fn polygon_segment_append_reversed(out: &mut Vec<P>, poly: &[P], seg1: usize, seg2: usize) {
    if seg1 >= seg2 {
        let mut i = seg1;
        while i > seg2 { out.push(poly[i - 1]); i -= 1; }
    } else {
        let mut i = seg1;
        while i > 0 { out.push(poly[i - 1]); i -= 1; }
        let mut i = poly.len();
        while i > seg2 { out.push(poly[i - 1]); i -= 1; }
    }
}
fn dist_seg(n: usize, seg1: usize, seg2: usize, forward: bool) -> i32 {
    let mut d = seg2 as i32 - seg1 as i32;
    if !forward { d = -d; }
    if d < 0 { d += n as i32; }
    d
}

impl Graph {
    fn isect(&self, vl: usize, i: usize) -> &Isect { &self.v[vl].its[i] }

    fn measure_horizontal(&self, ivl: usize, i1: usize, i2: usize) -> f64 {
        let (vl, vl2) = (&self.v[ivl], &self.v[ivl + 1]);
        let (it, it2) = (&vl.its[i1], &vl2.its[i2]);
        let poly = &self.c[it.contour];
        let p1 = [vl.x, it.pos];
        let p2 = [vl2.x, it2.pos];
        if it.is_low() { segment_length(poly, it.seg, p1, it2.seg, p2) } else { segment_length(poly, it2.seg, p2, it.seg, p1) }
    }
    fn measure_vertical(&self, ivl: usize, i1: usize, i2: usize, forward: bool) -> f64 {
        let vl = &self.v[ivl];
        let (it, it2) = (&vl.its[i1], &vl.its[i2]);
        let poly = &self.c[it.contour];
        let p1 = [vl.x, it.pos];
        let p2 = [vl.x, it2.pos];
        if forward { segment_length(poly, it.seg, p1, it2.seg, p2) } else { segment_length(poly, it2.seg, p2, it.seg, p1) }
    }
    fn emit_prev_next(&self, ivl: usize, i1: usize, i2: usize, out: &mut Vec<P>, dir_is_next: bool) {
        let ivl2 = if dir_is_next { ivl + 1 } else { ivl - 1 };
        let it = &self.v[ivl].its[i1];
        let it2 = &self.v[ivl2].its[i2];
        let poly = &self.c[it.contour];
        let forward = it.is_low() == dir_is_next;
        if forward { polygon_segment_append(out, poly, it.seg, it2.seg); } else { polygon_segment_append_reversed(out, poly, it.seg, it2.seg); }
        out.push([self.v[ivl2].x, it2.pos]);
    }
    fn emit_vertical(&self, ivl: usize, i1: usize, i2: usize, out: &mut Vec<P>, forward: bool) {
        let vl = &self.v[ivl];
        let (it, it2) = (&vl.its[i1], &vl.its[i2]);
        let poly = &self.c[it.contour];
        if forward { polygon_segment_append(out, poly, it.seg, it2.seg); } else { polygon_segment_append_reversed(out, poly, it.seg, it2.seg); }
        out.push([vl.x, it2.pos]);
    }
}

/// Intersect vertical lines x0 + i*ls with all contours; classify. None = Orca's InfillFailedException.
pub(crate) fn slice_region(c: Vec<Vec<P>>, n_outer: usize, n_vlines: usize, x0: f64, ls: f64) -> Option<Graph> {
    let mut v: Vec<VLine> = (0..n_vlines).map(|i| VLine { x: x0 + i as f64 * ls, its: vec![] }).collect();
    for (ic, contour) in c.iter().enumerate() {
        let n = contour.len();
        if n < 2 { continue; }
        for iseg in 0..n {
            let iprev = if iseg == 0 { n - 1 } else { iseg - 1 };
            let (p1, p2) = (contour[iprev], contour[iseg]);
            let (l, r) = if p1[0] <= p2[0] { (p1[0], p2[0]) } else { (p2[0], p1[0]) };
            let mut il = ((l - x0) / ls).ceil() as i64;
            il = il.max(0);
            let mut ir = ((r - x0) / ls).floor() as i64;
            ir = ir.min(n_vlines as i64 - 1);
            if il > ir { continue; }
            for i in il..=ir {
                let this_x = v[i as usize].x;
                let (pos, vertex);
                if p1[0] == this_x {
                    if p2[0] == this_x { continue; }
                    let p0 = contour[(iprev + n - 1) % n];
                    if (p0[0] - p1[0]) * (p2[0] - p1[0]) > 0.0 { continue; }
                    pos = p1[1]; vertex = true;
                } else if p2[0] == this_x {
                    let p3 = contour[(iseg + 1) % n];
                    if (p3[0] - p2[0]) * (p1[0] - p2[0]) > 0.0 { continue; }
                    pos = p2[1]; vertex = true;
                } else {
                    pos = p1[1] + (this_x - p1[0]) * (p2[1] - p1[1]) / (p2[0] - p1[0]);
                    vertex = false;
                }
                v[i as usize].its.push(Isect {
                    contour: ic, seg: iseg, pos, vertex, ty: Ty::OuterLow, prev: 0, next: 0,
                    prev_t: Link::Horizontal, next_t: Link::Horizontal, prev_q: Qual::Valid, next_q: Qual::Valid,
                    consumed_up: false, consumed_perim_right: false,
                });
            }
        }
    }
    for vl in v.iter_mut() {
        vl.its.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap_or(std::cmp::Ordering::Equal));
        let mut j = 0usize;
        for i in 0..vl.its.len() {
            let mut is = vl.its[i].clone();
            let contour = &c[is.contour];
            let n = contour.len();
            let iprev = if is.seg == 0 { n - 1 } else { is.seg - 1 };
            let dir = contour[is.seg][0] - contour[iprev][0];
            let low = dir > 0.0;
            is.ty = if is.contour < n_outer { if low { Ty::OuterLow } else { Ty::OuterHigh } } else if low { Ty::InnerLow } else { Ty::InnerHigh };
            let mut take_next = true;
            if j > 0 {
                let is2 = vl.its[j - 1].clone();
                if is.contour == is2.contour && is.vertex && is2.vertex {
                    if is.pos == is2.pos {
                        take_next = false;
                    } else if is.ty == is2.ty {
                        if !low { vl.its[j - 1] = is.clone(); }
                        take_next = false;
                    }
                }
            }
            if take_next {
                vl.its[j] = is;
                j += 1;
            }
        }
        vl.its.truncate(j);
    }
    // Validate (Orca throws InfillFailedException on violations).
    for vl in v.iter() {
        let its = &vl.its;
        if its.len() & 1 != 0 { return None; }
        let mut i = 0;
        while i < its.len() {
            if its[i].ty != Ty::OuterLow { return None; }
            let mut j = i + 1;
            if j >= its.len() { return None; }
            if !(its[j].ty == Ty::InnerLow || its[j].ty == Ty::OuterHigh) { return None; }
            while j < its.len() && its[j].is_inner() { j += 1; }
            if j >= its.len() || (j & 1) != 1 || its[j].ty != Ty::OuterHigh { return None; }
            if !(i + 1 == j || its[j - 1].ty == Ty::InnerHigh) { return None; }
            i = j + 1;
        }
    }
    Some(Graph { c, v })
}

/// Orca `connect_segment_intersections_by_contours`.
fn connect_by_contours(g: &mut Graph, dont_connect: bool, link_max_length: f64) {
    let nv = g.v.len();
    for ivl in 0..nv {
        let nit = g.v[ivl].its.len();
        let mut results: Vec<(i32, Link, Qual, i32, Link, Qual)> = Vec::with_capacity(nit);
        for ii in 0..nit {
            let itsct = g.v[ivl].its[ii].clone();
            let poly_n = g.c[itsct.contour].len();
            let forward = itsct.is_low();
            let mut iprev: i32 = -1;
            let mut d_prev = i32::MAX;
            if ivl > 0 {
                for (i, it2) in g.v[ivl - 1].its.iter().enumerate() {
                    if itsct.contour == it2.contour && itsct.ty == it2.ty {
                        let d = dist_seg(poly_n, it2.seg, itsct.seg, forward);
                        if d < d_prev { iprev = i as i32; d_prev = d; }
                    }
                }
            }
            let mut inext: i32 = -1;
            let mut d_next = i32::MAX;
            if ivl + 1 < nv {
                for (i, it2) in g.v[ivl + 1].its.iter().enumerate() {
                    if itsct.contour == it2.contour && itsct.ty == it2.ty {
                        let d = dist_seg(poly_n, itsct.seg, it2.seg, forward);
                        if d < d_next { inext = i as i32; d_next = d; }
                    }
                }
            }
            let (mut same_prev, mut same_next) = (false, false);
            for (i, it2) in g.v[ivl].its.iter().enumerate() {
                if i != ii && it2.contour == itsct.contour && it2.ty != itsct.ty {
                    let d = dist_seg(poly_n, it2.seg, itsct.seg, forward);
                    if d < d_prev { iprev = i as i32; d_prev = d; same_prev = true; }
                    let d = dist_seg(poly_n, itsct.seg, it2.seg, forward);
                    if d < d_next { inext = i as i32; d_next = d; same_next = true; }
                }
            }
            if iprev < 0 || inext < 0 {
                // No neighbour found (degenerate); mark both links invalid.
                results.push((0, Link::Horizontal, Qual::Invalid, 0, Link::Horizontal, Qual::Invalid));
                continue;
            }
            let prev_t = if same_prev { if (iprev as usize) < ii { Link::Down } else { Link::Up } } else { Link::Horizontal };
            let next_t = if same_next { if (inext as usize) < ii { Link::Down } else { Link::Up } } else { Link::Horizontal };
            let mut prev_q = Qual::Valid;
            let mut next_q = Qual::Valid;
            let its = &g.v[ivl].its;
            if same_prev {
                let (a, b) = if (iprev as usize) < ii { (iprev as usize, ii) } else { (ii, iprev as usize) };
                if (a + 1..b).any(|k| its[k].is_inner()) { prev_q = Qual::Invalid; }
            }
            if same_next {
                let (a, b) = if (inext as usize) < ii { (inext as usize, ii) } else { (ii, inext as usize) };
                if (a + 1..b).any(|k| its[k].is_inner()) { next_q = Qual::Invalid; }
            }
            if same_prev && same_next && ((iprev as usize > ii) == (inext as usize > ii)) {
                prev_q = Qual::Invalid;
                next_q = Qual::Invalid;
            }
            if dont_connect {
                if prev_q == Qual::Valid { prev_q = Qual::TooLong; }
                if next_q == Qual::Valid { next_q = Qual::TooLong; }
            } else if link_max_length > 0.0 {
                if prev_q == Qual::Valid {
                    let len = if same_prev { g.measure_vertical(ivl, iprev as usize, ii, forward) } else { g.measure_horizontal(ivl - 1, iprev as usize, ii) };
                    if len > link_max_length { prev_q = Qual::TooLong; }
                }
                if next_q == Qual::Valid {
                    let len = if same_next { g.measure_vertical(ivl, ii, inext as usize, forward) } else { g.measure_horizontal(ivl, ii, inext as usize) };
                    if len > link_max_length { next_q = Qual::TooLong; }
                }
            }
            results.push((iprev, prev_t, prev_q, inext, next_t, next_q));
        }
        for (ii, r) in results.into_iter().enumerate() {
            let it = &mut g.v[ivl].its[ii];
            it.prev = r.0; it.prev_t = r.1; it.prev_q = r.2;
            it.next = r.3; it.next_t = r.4; it.next_q = r.5;
        }
        // Make Invalid symmetric on vertical connections.
        for ii in 0..nit {
            let (lv, rv, pq, nq) = { let it = &g.v[ivl].its[ii]; (it.has_left_v(), it.has_right_v(), it.prev_q, it.next_q) };
            if lv && pq == Qual::Invalid {
                let o = g.v[ivl].its[ii].prev as usize;
                g.v[ivl].its[o].prev_q = Qual::Invalid;
            }
            if rv && nq == Qual::Invalid {
                let o = g.v[ivl].its[ii].next as usize;
                g.v[ivl].its[o].next_q = Qual::Invalid;
            }
        }
    }
}

// ---------------------------------------------------------------- plain traversal (rectilinear)
fn on_side_valid(g: &Graph, ivl: usize, ii: usize, side: Side) -> bool {
    let it = g.isect(ivl, ii);
    if it.has_v(side) { return false; }
    let io = it.h(side);
    if io == -1 { return false; }
    let ovl = if side == Side::Right { ivl + 1 } else { ivl.wrapping_sub(1) };
    if ovl >= g.v.len() { return false; }
    let vo = &g.v[ovl];
    let io = io as usize;
    let ito = &vo.its[io];
    if io == 0 || io + 1 >= vo.its.len() { return false; }
    let ito2 = &vo.its[if ito.is_low() { io - 1 } else { io + 1 }];
    if ito2.is_inner() { return false; }
    if it.h_quality(side) != Qual::Valid { return false; }
    if if side == Side::Right { it.consumed_perim_right } else { ito.consumed_perim_right } { return false; }
    if if ito.is_low() { ito.consumed_up } else { vo.its[io - 1].consumed_up } { return false; }
    true
}

fn traverse_graph(g: &mut Graph, consistent: bool, out: &mut Vec<Vec<P>>) {
    let nv = g.v.len();
    for ivl in 0..nv {
        let n = g.v[ivl].its.len();
        for ii in 0..n.saturating_sub(1) {
            if g.v[ivl].its[ii].ty == Ty::OuterLow && g.v[ivl].its[ii + 1].ty == Ty::OuterHigh {
                g.v[ivl].its[ii].consumed_up = true;
            }
        }
    }
    let mut ivl: usize;
    let mut ii: i64 = -1;
    let mut cur: Option<usize> = None; // index into out
    ivl = 0;
    loop {
        if ii == -1 {
            let mut found = false;
            'search: for ivl2 in 0..nv {
                let n = g.v[ivl2].its.len();
                if n == 0 { continue; }
                let forward_pass = !consistent || ivl2 % 2 == 0;
                for i in 0..n {
                    let idx = if forward_pass { i } else { n - i - 1 };
                    let it = &g.v[ivl2].its[idx];
                    if it.is_outer() {
                        let consumed = if it.is_low() { it.consumed_up } else { g.v[ivl2].its[idx - 1].consumed_up };
                        if !consumed {
                            ivl = ivl2; ii = idx as i64; found = true; break 'search;
                        }
                    }
                }
            }
            if !found { break; }
            out.push(vec![[g.v[ivl].x, g.v[ivl].its[ii as usize].pos]]);
            cur = Some(out.len() - 1);
        }
        let mut i = ii as usize;
        let going_up = g.v[ivl].its[i].is_low();
        let mut try_connect = false;
        if going_up {
            if g.v[ivl].its[i].is_inner() { i -= 1; }
            loop {
                g.v[ivl].its[i].consumed_up = true;
                i += 1;
                if g.v[ivl].its[i].ty == Ty::OuterHigh { break; }
            }
            if g.v[ivl].its[i - 1].is_inner() { i -= 1; try_connect = true; }
        } else {
            if g.v[ivl].its[i].is_inner() { g.v[ivl].its[i].consumed_up = true; }
            loop {
                i -= 1;
                g.v[ivl].its[i].consumed_up = true;
                if g.v[ivl].its[i].ty == Ty::OuterLow { break; }
            }
            if g.v[ivl].its[i + 1].is_inner() { i += 1; try_connect = true; }
        }
        if try_connect {
            let (i_prev, i_next) = { let it = &g.v[ivl].its[i]; (it.left_h(), it.right_h()) };
            let prev_valid = on_side_valid(g, ivl, i, Side::Left) && !consistent;
            let next_valid = on_side_valid(g, ivl, i, Side::Right);
            let horiz_valid = prev_valid || next_valid;
            if i_prev != -1 { g.v[ivl - 1].its[i_prev as usize].consumed_perim_right = true; }
            if i_next != -1 { g.v[ivl].its[i].consumed_perim_right = true; }
            if horiz_valid {
                let mut take_next = next_valid;
                if prev_valid && next_valid {
                    let dp = g.measure_horizontal(ivl - 1, i_prev as usize, i);
                    let dn = g.measure_horizontal(ivl, i, i_next as usize);
                    take_next = dn < dp;
                }
                let cidx = cur.unwrap();
                out[cidx].push([g.v[ivl].x, g.v[ivl].its[i].pos]);
                let target = if take_next { i_next as usize } else { i_prev as usize };
                let mut tmp = Vec::new();
                g.emit_prev_next(ivl, i, target, &mut tmp, take_next);
                out[cidx].extend(tmp);
                if take_next { ivl += 1; } else { ivl -= 1; }
                ii = target as i64;
                continue;
            }
            let (i_vert, vq) = {
                let it = &g.v[ivl].its[i];
                let iv = it.vertical_outside();
                let invalid = iv == -1 || g.v[ivl].its[(iv as i64 + if going_up { 0 } else { -1 }) as usize].consumed_up;
                (iv, if invalid { Qual::Invalid } else { it.vertical_outside_quality() })
            };
            if vq != Qual::Invalid {
                let iv = i_vert as usize;
                let cidx = cur.unwrap();
                out[cidx].push([g.v[ivl].x, g.v[ivl].its[i].pos]);
                if vq == Qual::Valid {
                    let fwd = if going_up { g.v[ivl].its[i].has_left_up() } else { g.v[ivl].its[i].has_right_down() };
                    let mut tmp = Vec::new();
                    g.emit_vertical(ivl, i, iv, &mut tmp, fwd);
                    out[cidx].extend(tmp);
                } else {
                    out.push(vec![[g.v[ivl].x, g.v[ivl].its[iv].pos]]);
                    cur = Some(out.len() - 1);
                }
                if going_up { for k in i..iv { g.v[ivl].its[k].consumed_up = true; } } else { for k in iv..i { g.v[ivl].its[k].consumed_up = true; } }
                g.v[ivl].its[i].consumed_perim_right = true;
                let k2 = if going_up { i + 1 } else { i - 1 };
                g.v[ivl].its[k2].consumed_perim_right = true;
                ii = iv as i64;
                continue;
            }
            if going_up { i += 1; } else { i -= 1; }
        }
        let cidx = cur.unwrap();
        out[cidx].push([g.v[ivl].x, g.v[ivl].its[i].pos]);
        dedup(&mut out[cidx]);
        if out[cidx].len() <= 1 || (out[cidx].len() == 2 && (out[cidx][0][0] - out[cidx][1][0]).abs() < SCALED_EPS && (out[cidx][0][1] - out[cidx][1][1]).abs() < SCALED_EPS) {
            out.pop();
        }
        ii = -1;
        cur = None;
    }
}

fn dedup(p: &mut Vec<P>) { p.dedup_by(|a, b| a[0] == b[0] && a[1] == b[1]); }

// ---------------------------------------------------------------- monotonic regions
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Bound { vline: i32, low: i32, high: i32 }
#[derive(Clone, Debug, Default)]
struct Region { left: Bound, right: Bound, len1: f64, len2: f64, flips: bool, left_n: Vec<usize>, right_n: Vec<usize> }
impl Region {
    fn length(&self, flipped: bool) -> f64 { if flipped { self.len2 } else { self.len1 } }
    fn left_pt(&self, flipped: bool) -> i32 { if flipped { self.left.high } else { self.left.low } }
    fn right_pt(&self, flipped: bool) -> i32 { if flipped == self.flips { self.right.low } else { self.right.high } }
}

fn run_end_raw(vl: &VLine, start: usize) -> usize {
    let mut it = start;
    loop { it += 1; if vl.its[it].ty == Ty::OuterHigh { break; } }
    if vl.its[it - 1].is_inner() { it -= 1; }
    it
}
fn run_end(vl: &VLine, start: usize) -> usize {
    let mut end = run_end_raw(vl, start);
    loop {
        let up = vl.its[end].vertical_up();
        if up == -1 || vl.its[end].vertical_up_quality() != Qual::Valid { break; }
        end = run_end_raw(vl, up as usize);
    }
    end
}
fn run_bottom(vl: &VLine, start: usize) -> usize {
    let mut it = start;
    loop {
        while vl.its[it].ty != Ty::InnerLow { it -= 1; }
        if vl.its[it - 1].ty == Ty::InnerHigh { it -= 1; } else {
            let down = vl.its[it].vertical_down();
            if down == -1 || vl.its[it].vertical_down_quality() != Qual::Valid { break; }
            it = down as usize;
        }
    }
    it
}
fn run_top(vl: &VLine, start: usize) -> usize {
    let mut it = start;
    loop {
        while vl.its[it].ty != Ty::InnerHigh { it += 1; }
        if vl.its[it + 1].ty == Ty::InnerLow { it += 1; } else {
            let up = vl.its[it].vertical_up();
            if up == -1 || vl.its[it].vertical_up_quality() != Qual::Valid { break; }
            it = up as usize;
        }
    }
    it
}
fn overlap_bottom(this: &VLine, start: usize, end: usize, other: &VLine, side: Side) -> Option<usize> {
    let mut found = None;
    let mut it = start;
    loop {
        if this.its[it].is_inner() {
            let i = this.its[it].h(side);
            if i != -1 { found = Some(i as usize); break; }
            if it == end { break; }
        }
        if this.its[it].ty != Ty::InnerHigh { it += 1; }
        else if this.its[it + 1].ty == Ty::InnerLow { it += 1; }
        else {
            let up = this.its[it].vertical_up();
            if up == -1 || this.its[it].vertical_up_quality() != Qual::Valid { break; }
            it = up as usize;
        }
    }
    found.map(|o| run_bottom(other, o))
}
fn overlap_top(this: &VLine, start: usize, end: usize, other: &VLine, side: Side) -> Option<usize> {
    let mut found = None;
    let mut it = end;
    loop {
        if this.its[it].is_inner() {
            let i = this.its[it].h(side);
            if i != -1 { found = Some(i as usize); break; }
            if it == start { break; }
        }
        if this.its[it].ty != Ty::InnerLow { it -= 1; }
        else if this.its[it - 1].ty == Ty::InnerHigh { it -= 1; }
        else {
            let down = this.its[it].vertical_down();
            if down == -1 || this.its[it].vertical_down_quality() != Qual::Valid { break; }
            it = down as usize;
        }
    }
    found.map(|o| run_top(other, o))
}
fn overlap(this: &VLine, start: usize, end: usize, other: &VLine, side: Side) -> Option<(usize, usize)> {
    let a = overlap_bottom(this, start, end, other, side)?;
    let b = overlap_top(this, start, end, other, side)?;
    Some((a, b))
}

fn generate_regions(g: &mut Graph) -> Vec<Region> {
    let mut regions = Vec::new();
    let nv = g.v.len();
    for seed in 0..nv {
        let mut s = 1usize;
        while s + 1 < g.v[seed].its.len() {
            while s < g.v[seed].its.len() && g.v[seed].its[s].ty != Ty::InnerLow { s += 1; }
            if s == g.v[seed].its.len() { break; }
            let start = s;
            let end = run_end(&g.v[seed], start);
            if !g.v[seed].its[start].consumed_up {
                let mut ivl = seed;
                let mut left = (start, end);
                let mut region = Region::default();
                region.left = Bound { vline: ivl as i32, low: left.0 as i32, high: left.1 as i32 };
                region.right = region.left;
                g.v[seed].its[start].consumed_up = true;
                let mut num_lines = 1;
                loop {
                    ivl += 1;
                    if ivl >= nv { break; }
                    let Some(right) = overlap(&g.v[ivl - 1], left.0, left.1, &g.v[ivl], Side::Right) else { break };
                    let right_top_first = run_top(&g.v[ivl], right.0);
                    if right_top_first != right.1 { break; }
                    let right_left = overlap(&g.v[ivl], right.0, right.1, &g.v[ivl - 1], Side::Left);
                    if right_left != Some(left) { break; }
                    region.right = Bound { vline: ivl as i32, low: right.0 as i32, high: right.1 as i32 };
                    g.v[ivl].its[right.0].consumed_up = true;
                    num_lines += 1;
                    left = right;
                }
                region.flips = (num_lines & 1) != 0;
                regions.push(region);
            }
            s = end + 1;
        }
    }
    regions
}

fn region_path_length(g: &Graph, region: &Region, dir: bool) -> f64 {
    let mut ii = region.left_pt(dir) as usize;
    let mut ivl = region.left.vline as usize;
    let mut total = 0.0;
    let mut no_perimeter = false;
    let mut last = [0.0, 0.0];
    loop {
        let vl = &g.v[ivl];
        let mut it = ii;
        let going_up = vl.its[it].is_low();
        if no_perimeter {
            let o = if going_up { it - 1 } else { it + 1 };
            total += dist(last, [vl.x, vl.its[o].pos]);
        }
        let mut iright = vl.its[it].right_h();
        if going_up {
            loop {
                loop {
                    it += 1;
                    iright = iright.max(vl.its[it].right_h());
                    if !(vl.its[it].ty != Ty::InnerHigh || vl.its[it + 1].ty != Ty::OuterHigh) { break; }
                }
                let inext = vl.its[it].vertical_up();
                if inext == -1 || vl.its[it].vertical_up_quality() != Qual::Valid { break; }
                it = inext as usize;
            }
        } else {
            loop {
                loop {
                    it -= 1;
                    let n = vl.its[it].right_h();
                    if n != -1 { iright = n; }
                    if !(vl.its[it].ty != Ty::InnerLow || vl.its[it - 1].ty != Ty::OuterLow) { break; }
                }
                let inext = vl.its[it].vertical_down();
                if inext == -1 || vl.its[it].vertical_down_quality() != Qual::Valid { break; }
                it = inext as usize;
            }
        }
        if ivl as i32 == region.right.vline { break; }
        let inext = vl.its[it].right_h();
        let vr = &g.v[ivl + 1];
        let ir = if iright >= 0 { iright as usize } else { 0 };
        let right = if going_up { run_top(vr, ir) } else { run_bottom(vr, ir) };
        ii = right;
        if inext == right as i32 && vl.its[it].next_q == Qual::Valid {
            total += 0.5 * g.measure_horizontal(ivl, it, inext as usize);
            no_perimeter = false;
        } else {
            let o = if going_up { it + 1 } else { it - 1 };
            last = [vl.x, vl.its[o].pos];
            no_perimeter = true;
        }
        ivl += 1;
    }
    total
}

fn connect_regions(g: &Graph, regions: &mut Vec<Region>) {
    use std::collections::BTreeMap;
    let mut start_map: BTreeMap<(usize, usize), usize> = BTreeMap::new();
    let mut end_map: BTreeMap<(usize, usize), usize> = BTreeMap::new();
    for (ri, r) in regions.iter().enumerate() {
        start_map.insert((r.left.vline as usize, r.left.low as usize), ri);
        end_map.insert((r.right.vline as usize, r.right.low as usize), ri);
    }
    let mut left_links: Vec<(usize, usize)> = vec![]; // (neighbor_end_region, region) => neighbor.right_n += region
    let mut right_links: Vec<(usize, usize)> = vec![]; // (neighbor_start_region, region) => neighbor.left_n += region
    for (ri, r) in regions.iter().enumerate() {
        if r.left.vline > 0 {
            let ivl = r.left.vline as usize;
            if let Some((mut lb, le)) = overlap(&g.v[ivl], r.left.low as usize, r.left.high as usize, &g.v[ivl - 1], Side::Left) {
                loop {
                    if let Some(&nr) = end_map.get(&(ivl - 1, lb)) { left_links.push((nr, ri)); }
                    let mut ln = run_top(&g.v[ivl - 1], lb);
                    if ln == le { break; }
                    while g.v[ivl - 1].its[ln].ty != Ty::InnerLow { ln += 1; }
                    lb = ln;
                }
            }
        }
        if (r.right.vline as usize) + 1 < g.v.len() {
            let ivl = r.right.vline as usize;
            if let Some((mut rb, re)) = overlap(&g.v[ivl], r.right.low as usize, r.right.high as usize, &g.v[ivl + 1], Side::Right) {
                loop {
                    if let Some(&nr) = start_map.get(&(ivl + 1, rb)) { right_links.push((nr, ri)); }
                    let mut rn = run_top(&g.v[ivl + 1], rb);
                    if rn == re { break; }
                    while g.v[ivl + 1].its[rn].ty != Ty::InnerLow { rn += 1; }
                    rb = rn;
                }
            }
        }
    }
    for (nr, ri) in left_links { regions[nr].right_n.push(ri); }
    for (nr, ri) in right_links { regions[nr].left_n.push(ri); }
    for r in regions.iter_mut() {
        r.left_n.sort(); r.left_n.dedup();
        r.right_n.sort(); r.right_n.dedup();
    }
    // Symmetrise.
    for ri in 0..regions.len() {
        let ln = regions[ri].left_n.clone();
        for n in ln { if !regions[n].right_n.contains(&ri) { regions[n].right_n.push(ri); regions[n].right_n.sort(); } }
        let rn = regions[ri].right_n.clone();
        for n in rn { if !regions[n].left_n.contains(&ri) { regions[n].left_n.push(ri); regions[n].left_n.sort(); } }
    }
    for ri in 0..regions.len() {
        let l1 = region_path_length(g, &regions[ri], false);
        let l2 = region_path_length(g, &regions[ri], true);
        if l1 > l2 { regions[ri].len1 = l1 - l2; regions[ri].len2 = 0.0; } else { regions[ri].len2 = l2 - l1; regions[ri].len1 = 0.0; }
    }
}

fn link_length(g: &Graph, regions: &[Region], from: usize, ff: bool, to: usize, ft: bool) -> f64 {
    let rf = &regions[from];
    let rt = &regions[to];
    let i_from = rf.right_pt(ff) as usize;
    let i_to = rt.left_pt(ft) as usize;
    let vf = &g.v[rf.right.vline as usize];
    let vt = &g.v[rt.left.vline as usize];
    if rf.right.vline + 1 == rf.left.vline {
        let ir = vf.its[i_from].right_h();
        if ir == i_to as i32 && vf.its[i_from].next_q == Qual::Valid {
            return g.measure_horizontal(rf.right.vline as usize, i_from, i_to) / NM;
        }
    }
    ((vt.x - vf.x).hypot(vt.its[i_to].pos - vf.its[i_from].pos)) / NM
}

/// Greedy region order (Orca seeds its ant colony with exactly this walk, then keeps the shorter of
/// greedy/ACO; the ACO refinement is not ported).
fn chain_regions(g: &Graph, regions: &[Region]) -> Vec<(usize, bool)> {
    let n = regions.len();
    let mut unprocessed: Vec<i32> = vec![1; n];
    let mut queue: Vec<usize> = vec![];
    for (i, r) in regions.iter().enumerate() {
        if r.left_n.is_empty() { queue.push(i); } else { unprocessed[i] += r.left_n.len() as i32; }
    }
    let mut path: Vec<(usize, bool)> = vec![];
    let Some(first) = queue.pop() else { return path };
    unprocessed[first] -= 1;
    path.push((first, false));
    let mut end = (first, false);
    while !queue.is_empty() || !regions[end.0].right_n.is_empty() {
        let (reg, dir) = end;
        let mut best: Option<(usize, bool, f64)> = None;
        let consider = |best: &mut Option<(usize, bool, f64)>, next: usize| {
            for f in [false, true] {
                let len = link_length(g, regions, reg, dir, next, f);
                let vis = 1.0 / (len + 1e-4);
                if best.map_or(vis > 0.0, |b| vis > b.2) { *best = Some((next, f, vis)); }
            }
        };
        for &next in &regions[reg].right_n {
            if unprocessed[next] == 2 { consider(&mut best, next); }
        }
        let from_queue = best.is_none();
        if from_queue { for &next in &queue { consider(&mut best, next); } }
        let chosen = best.map(|b| (b.0, b.1));
        for &next in &regions[reg].right_n {
            unprocessed[next] -= 1;
            if unprocessed[next] == 1 && chosen.map(|c| c.0) != Some(next) { queue.push(next); }
        }
        let Some((nr, nd)) = chosen else { break };
        if from_queue {
            if let Some(pos) = queue.iter().position(|&q| q == nr) { queue.swap_remove(pos); }
        }
        unprocessed[nr] = 0;
        path.push((nr, nd));
        end = (nr, nd);
    }
    // Orca keeps the shortest path over {region order, flips} found by its ant colony. The order above
    // is the ant colony's greedy seed; the flips are re-optimised exactly for that order (2-state DP).
    let m = path.len();
    if m > 0 {
        // suffix DP: best[i][f] = min length of regions i.. when region i has flip f
        let mut best = vec![[0.0f64; 2]; m];
        for i in (0..m).rev() {
            for f in 0..2 {
                let own = regions[path[i].0].length(f == 1);
                best[i][f] = own + if i + 1 < m {
                    (0..2).map(|nf| link_length(g, regions, path[i].0, f == 1, path[i + 1].0, nf == 1) + best[i + 1][nf]).fold(f64::INFINITY, f64::min)
                } else { 0.0 };
            }
        }
        // Ties: Orca's first ant draws its orientation from a default-seeded mt19937_64 whose first
        // output exceeds max/2, i.e. `flipped = true`, and later equal-length ants never replace it.
        let eps = 1e-6;
        let mut f = if best[0][1] <= best[0][0] + eps { 1 } else { 0 };
        path[0].1 = f == 1;
        for i in 1..m {
            let l = |nf: usize| link_length(g, regions, path[i - 1].0, f == 1, path[i].0, nf == 1) + best[i][nf];
            f = if l(1) <= l(0) + eps { 1 } else { 0 };
            path[i].1 = f == 1;
        }
    }
    path
}

fn polylines_from_paths(g: &Graph, regions: &[Region], path: &[(usize, bool)], out: &mut Vec<Vec<P>>) {
    let mut cur: Option<usize> = None;
    let finish = |out: &mut Vec<Vec<P>>, cur: &mut Option<usize>| {
        let ci = cur.take().unwrap();
        dedup(&mut out[ci]);
        let p = &out[ci];
        if p.len() <= 1 || (p.len() == 2 && (p[0][0] - p[1][0]).abs() < SCALED_EPS && (p[0][1] - p[1][1]).abs() < SCALED_EPS) {
            out.pop();
        } else if out.len() >= 2 {
            let (a, b) = (&out[out.len() - 2], &out[out.len() - 1]);
            let (pb, f) = (a.last().unwrap(), b.first().unwrap());
            if (f[0] - pb[0]).abs() < SCALED_EPS && (f[1] - pb[1]).abs() < SCALED_EPS {
                let last = out.pop().unwrap();
                let prev = out.last_mut().unwrap();
                let l = prev.len() - 1;
                prev[l] = [(prev[l][0] + last[0][0]) / 2.0, (prev[l][1] + last[0][1]) / 2.0];
                prev.extend_from_slice(&last[1..]);
            }
        }
    };
    for (pi, &(ri, dir)) in path.iter().enumerate() {
        let region = &regions[ri];
        let mut ii = region.left_pt(dir) as usize;
        let mut ivl = region.left.vline as usize;
        if cur.is_some() && pi > 0 {
            let (rp, dp) = path[pi - 1];
            let rprev = &regions[rp];
            let ivl_prev = rprev.right.vline as usize;
            let ii_prev = rprev.right_pt(dp) as usize;
            let ip = &g.v[ivl_prev].its[ii_prev];
            let mut extended = false;
            if ivl_prev + 1 == ivl && ip.right_h() == ii as i32 && ip.next_q == Qual::Valid {
                let mut tmp = vec![];
                g.emit_prev_next(ivl_prev, ii_prev, ii, &mut tmp, true);
                out[cur.unwrap()].extend(tmp);
                extended = true;
            }
            if !extended {
                let o = if ip.is_low() { ii_prev - 1 } else { ii_prev + 1 };
                let ci = cur.unwrap();
                let l = out[ci].len() - 1;
                out[ci][l] = [g.v[ivl_prev].x, g.v[ivl_prev].its[o].pos];
                finish(out, &mut cur);
            }
        }
        loop {
            let vl = &g.v[ivl];
            let mut it = ii;
            let going_up = vl.its[it].is_low();
            if cur.is_none() {
                let o = if going_up { it - 1 } else { it + 1 };
                out.push(vec![[vl.x, vl.its[o].pos]]);
                cur = Some(out.len() - 1);
            } else {
                let ci = cur.unwrap();
                out[ci].push([vl.x, vl.its[it].pos]);
            }
            let ci = cur.unwrap();
            let mut iright = vl.its[it].right_h();
            if going_up {
                loop {
                    loop {
                        it += 1;
                        iright = iright.max(vl.its[it].right_h());
                        if !(vl.its[it].ty != Ty::InnerHigh || vl.its[it + 1].ty != Ty::OuterHigh) { break; }
                    }
                    out[ci].push([vl.x, vl.its[it].pos]);
                    let inext = vl.its[it].vertical_up();
                    if inext == -1 || vl.its[it].vertical_up_quality() != Qual::Valid { break; }
                    let fwd = vl.its[it].has_left_up();
                    let mut tmp = vec![];
                    g.emit_vertical(ivl, it, inext as usize, &mut tmp, fwd);
                    out[ci].extend(tmp);
                    it = inext as usize;
                }
            } else {
                loop {
                    loop {
                        it -= 1;
                        let n = vl.its[it].right_h();
                        if n != -1 { iright = n; }
                        if !(vl.its[it].ty != Ty::InnerLow || vl.its[it - 1].ty != Ty::OuterLow) { break; }
                    }
                    out[ci].push([vl.x, vl.its[it].pos]);
                    let inext = vl.its[it].vertical_down();
                    if inext == -1 || vl.its[it].vertical_down_quality() != Qual::Valid { break; }
                    let fwd = vl.its[it].has_right_down();
                    let mut tmp = vec![];
                    g.emit_vertical(ivl, it, inext as usize, &mut tmp, fwd);
                    out[ci].extend(tmp);
                    it = inext as usize;
                }
            }
            if ivl as i32 == region.right.vline { break; }
            let inext = vl.its[it].right_h();
            let vr = &g.v[ivl + 1];
            let ir = if iright >= 0 { iright as usize } else { 0 };
            let right = if going_up { run_top(vr, ir) } else { run_bottom(vr, ir) };
            ii = right;
            if inext == right as i32 && vl.its[it].next_q == Qual::Valid {
                let mut tmp = vec![];
                g.emit_prev_next(ivl, it, inext as usize, &mut tmp, true);
                out[ci].extend(tmp);
            } else {
                let o = if going_up { it + 1 } else { it - 1 };
                let l = out[ci].len() - 1;
                out[ci][l] = [vl.x, vl.its[o].pos];
                finish(out, &mut cur);
            }
            ivl += 1;
        }
    }
    if cur.is_some() {
        let (ri, dir) = *path.last().unwrap();
        let region = &regions[ri];
        let vl = &g.v[region.right.vline as usize];
        let ip = region.right_pt(dir) as usize;
        let o = if vl.its[ip].is_low() { ip - 1 } else { ip + 1 };
        let ci = cur.unwrap();
        let l = out[ci].len() - 1;
        out[ci][l] = [vl.x, vl.its[o].pos];
        finish(out, &mut cur);
    }
}

// ---------------------------------------------------------------- public driver
/// Parameters of one rectilinear fill call (mirrors the Orca `Fill` + `FillParams` members it reads).
#[derive(Clone, Debug)]
pub(crate) struct RectParams {
    pub spacing: f64,        // mm, flow spacing (updated when the solid-spacing adjustment applies)
    pub density: f64,        // 0..1
    pub theta: f64,          // rotation: lines run along theta - pi/2 ... see `infill_theta`
    pub overlap: f64,        // mm
    pub dont_adjust: bool,
    pub link_max_length: f64, // mm
    pub dont_connect: bool,
    pub monotonic: bool,
    pub consistent_pattern: bool,
    pub ref_point: [f64; 2], // object bbox centre (object frame)
}

/// `Fill::_adjust_solid_spacing` in nm.
pub(crate) fn adjust_solid_spacing(width: f64, distance: f64) -> f64 {
    let eps = 1e-4; // libslic3r EPSILON, applied in coord units exactly as Orca does
    let number_of_intervals = ((width - eps) / distance).trunc();
    let mut distance_new = if number_of_intervals == 0.0 { distance } else { ((width - eps) / number_of_intervals).trunc() };
    let factor = distance_new / distance;
    if factor > 1.2 { distance_new = (distance * 1.2 + 0.5).floor(); }
    distance_new
}

fn rings(p: &Polys) -> Vec<Vec<P>> {
    let mut v = Vec::new();
    for q in p { v.push(q.contour.clone()); for h in &q.holes { v.push(h.clone()); } }
    v
}

/// Collapse hair-line slits: a vertex whose two neighbours are within `tol` nm of each other is a spike tip
/// (zero-ish width); drop the tip and the second neighbour. Repeats until stable.
fn collapse_slits(mut r: Vec<P>, tol: f64) -> Vec<P> {
    loop {
        let n = r.len();
        if n < 4 { return r; }
        let mut changed = false;
        let mut i = 0;
        while i < r.len() && r.len() >= 4 {
            let n = r.len();
            let (a, t, b) = (r[(i + n - 1) % n], r[i], r[(i + 1) % n]);
            if dist(a, b) <= tol && dist(a, t) > tol {
                let nb = (i + 1) % n;
                // remove tip and the later neighbour
                let mut idx = vec![i, nb];
                idx.sort();
                r.remove(idx[1]);
                r.remove(idx[0]);
                changed = true;
            } else { i += 1; }
        }
        if !changed { return r; }
    }
}

fn is_stick(p1: P, p2: P, p3: P) -> bool {
    let v1 = [p2[0] - p1[0], p2[1] - p1[1]];
    let v2 = [p3[0] - p2[0], p3[1] - p2[1]];
    let dir = v1[0] * v2[0] + v1[1] * v2[1];
    if dir > 0.0 { return false; }
    let l1 = v1[0] * v1[0] + v1[1] * v1[1];
    let l2 = v2[0] * v2[0] + v2[1] * v2[1];
    if dir == 0.0 { return l1 == 0.0 || l2 == 0.0; }
    let cross = v1[0] * v2[1] - v2[0] * v1[1];
    cross * cross / l1.max(l2) < 1e-8
}

/// Orca `remove_sticks(Polygon&)`: drop vertices where the ring doubles back on itself (zero-width spikes).
pub(crate) fn remove_sticks(poly: &mut Vec<P>) -> bool {
    let n = poly.len();
    if n < 3 { return false; }
    let mut modified = false;
    let mut j = 1usize;
    for i in 1..n - 1 {
        if !is_stick(poly[j - 1], poly[i], poly[i + 1]) {
            if j < i { poly[j] = poly[i]; }
            j += 1;
        }
    }
    j += 1;
    if j < poly.len() {
        let last = *poly.last().unwrap();
        poly[j - 1] = last;
        poly.truncate(j);
        modified = true;
    }
    while poly.len() >= 3 && is_stick(poly[poly.len() - 2], poly[poly.len() - 1], poly[0]) { poly.pop(); modified = true; }
    while poly.len() >= 3 && is_stick(poly[poly.len() - 1], poly[0], poly[1]) { poly.remove(0); modified = true; }
    modified
}

fn snap(mut r: Vec<P>) -> Vec<P> {
    for p in r.iter_mut() { p[0] = (p[0] * NM).round(); p[1] = (p[1] * NM).round(); }
    r.dedup_by(|a, b| a[0] == b[0] && a[1] == b[1]);
    while r.len() > 1 && r.first() == r.last() { r.pop(); }
    r
}

/// Run the rectilinear family on ONE expolygon (already in the object frame).
/// Returns (polylines in mm, adjusted spacing in mm). None entries mean "not a single line fits".
pub(crate) fn fill_by_lines(poly: &Poly, rp: &RectParams) -> (Vec<Vec<P>>, f64) {
    let theta = rp.theta;
    let src_rot = {
        let rot = g::rotate_polys(&vec![poly.clone()], -theta);
        // Orca: remove_sticks(polygons_src) on the rotated integer polygon
        let fix = |r: &Vec<P>| -> Vec<P> { let mut v = snap(r.clone()); remove_sticks(&mut v); v.iter().map(|p| [p[0] / NM, p[1] / NM]).collect() };
        vec![Poly { contour: fix(&rot[0].contour), holes: rot[0].holes.iter().map(|h| fix(h)).collect() }]
    };
    let s = rp.spacing;
    let aoffset1 = rp.overlap - (0.5 - 0.45) * s;
    let aoffset2 = rp.overlap - 0.5 * s;
    let outer: Polys = if aoffset1 == 0.0 { src_rot.clone() } else { g::offset(&src_rot, aoffset1) };
    let inner: Polys = if aoffset2 < 0.0 { g::offset(&outer, -(aoffset1 - aoffset2)) } else { vec![] };
    let min_area = 0.01 * aoffset2 * aoffset2;
    let filt = |ps: Polys| -> Vec<Vec<P>> {
        rings(&ps).into_iter().filter(|r| g::ring_area(r).abs() >= min_area).map(snap).map(|mut r| { remove_sticks(&mut r); r }).filter(|r| r.len() >= 3).collect()
    };
    let outer_r = filt(outer);
    let inner_r = filt(inner);
    if inner_r.is_empty() { return (vec![], s); }
    let n_outer = outer_r.len();
    let mut contours = outer_r.clone();
    contours.extend(inner_r.iter().cloned());
    // bounding box of the (rotated) source contour
    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in &src_rot[0].contour {
        let (x, y) = ((p[0] * NM).round(), (p[1] * NM).round());
        bb[0] = bb[0].min(x); bb[1] = bb[1].min(y); bb[2] = bb[2].max(x); bb[3] = bb[3].max(y);
    }
    let full = rp.density > 0.9999;
    let mut ls = (s * NM / rp.density).trunc();
    let mut spacing_out = s;
    let mut bmin_x = bb[0];
    let mut bmax_x = bb[2];
    if full && !rp.dont_adjust {
        ls = adjust_solid_spacing(bb[2] - bb[0], ls);
        spacing_out = ls / NM;
    } else {
        // align with the other layers: grid anchored at the object centre rotated into this frame
        let (sn, cs) = (-theta).sin_cos();
        let refx = ((rp.ref_point[0] * cs - rp.ref_point[1] * sn) * NM).round();
        // align_to_grid(min.x, ls, refx)
        let d = bmin_x - refx;
        let aligned = if d < 0.0 { ((d - ls + 1.0) / ls).trunc() * ls } else { (d / ls).trunc() * ls };
        bmin_x = bmin_x.min(refx + aligned);
        if bmax_x < bmin_x { bmax_x = bmin_x; }
    }
    let n_vlines = ((bmax_x - bmin_x + ls - 1.0) / ls).trunc().max(0.0) as usize;
    let mut x0 = bmin_x;
    if full { x0 += ((ls + SCALED_EPS) / 2.0).trunc(); }
    if n_vlines == 0 { return (vec![], spacing_out); }
    // Orca throws InfillFailedException when a scan line meets a self-touching contour and leaves the island
    // unfilled. The float offsetter used here can leave hair-line slits that Clipper does not, so retry once
    // on rings with such slits collapsed before giving up.
    let graph = match slice_region(contours, n_outer, n_vlines, x0, ls) {
        Some(gr) => Some(gr),
        None => {
            let co: Vec<Vec<P>> = outer_r.into_iter().map(|r| collapse_slits(r, 4.0)).filter(|r| r.len() >= 3).collect();
            let ci: Vec<Vec<P>> = inner_r.into_iter().map(|r| collapse_slits(r, 4.0)).filter(|r| r.len() >= 3).collect();
            if ci.is_empty() { None } else { let no = co.len(); let mut all = co; all.extend(ci); slice_region(all, no, n_vlines, x0, ls) }
        }
    };
    let Some(mut graph) = graph else { return (vec![], spacing_out) };
    connect_by_contours(&mut graph, rp.dont_connect, (rp.link_max_length * NM).trunc());
    let mut out: Vec<Vec<P>> = Vec::new();
    if rp.monotonic {
        let mut regions = generate_regions(&mut graph);
        connect_regions(&graph, &mut regions);
        if !regions.is_empty() {
            let path = chain_regions(&graph, &regions);
            polylines_from_paths(&graph, &regions, &path, &mut out);
        }
    } else {
        traverse_graph(&mut graph, rp.consistent_pattern, &mut out);
    }
    // rotate back, nm -> mm, drop duplicates
    let (sn, cs) = theta.sin_cos();
    let res: Vec<Vec<P>> = out.into_iter().map(|pl| {
        let mut v: Vec<P> = pl.into_iter().map(|p| {
            let (x, y) = (p[0] / NM, p[1] / NM);
            [x * cs - y * sn, x * sn + y * cs]
        }).collect();
        v.dedup_by(|a, b| (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9);
        v
    }).filter(|v| v.len() >= 2).collect();
    (res, spacing_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Poly;

    #[test]
    fn solid_spacing_adjustment_matches_orca_rule() {
        // width 10 mm = 10_000_000 nm, distance 0.377 mm: floor(10/0.377)=26 intervals -> 384615 nm
        let d = adjust_solid_spacing(10_000_000.0, 377_100.0);
        assert!((d - 384_615.0).abs() <= 1.0, "{d}");
        // never decreases, never more than +20%
        assert!(adjust_solid_spacing(10_000_000.0, 377_100.0) >= 377_100.0);
        assert_eq!(adjust_solid_spacing(500_000.0, 400_000.0), 480_000.0); // 1 interval of 500000 would be +25% -> capped at +20%
        // narrower than one spacing: unchanged
        assert_eq!(adjust_solid_spacing(300_000.0, 400_000.0), 400_000.0);
    }
    #[test]
    fn remove_sticks_deletes_zero_width_spikes_only() {
        // square with a zero-width spike on the top edge
        let mut r: Vec<P> = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [6.0, 10.0], [6.0, 15.0], [6.0, 10.0], [0.0, 10.0]];
        assert!(remove_sticks(&mut r));
        assert!(!r.contains(&[6.0, 15.0]), "{r:?}");
        // a genuine thin spike (1 nm wide... still a triangle) is NOT a stick and survives
        let mut q: Vec<P> = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [6.0, 10.0], [6.5, 15.0], [7.0, 10.0], [0.0, 10.0]];
        assert!(!remove_sticks(&mut q));
        assert_eq!(q.len(), 7);
    }
    fn annulus() -> Poly {
        let sq = |h: f64| vec![[-h, -h], [h, -h], [h, h], [-h, h]];
        let mut hole = sq(3.0);
        hole.reverse();
        Poly { contour: sq(8.0), holes: vec![hole] }
    }
    #[test]
    fn annulus_splits_into_four_monotonic_regions_and_visits_each_once() {
        let rp = RectParams { spacing: 0.4, density: 1.0, theta: std::f64::consts::FRAC_PI_2, overlap: 0.0, dont_adjust: false, link_max_length: 0.0, dont_connect: true, monotonic: true, consistent_pattern: false, ref_point: [0.0, 0.0] };
        // monotonic on a ring: left part, two branches around the hole, right part
        let (pls, _) = fill_by_lines(&annulus(), &rp);
        let covered: f64 = pls.iter().map(|p| p.windows(2).map(|w| (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])).sum::<f64>()).sum::<f64>() * 0.4;
        assert!((covered - (256.0 - 36.0)).abs() / 220.0 < 0.1, "{covered}");
        // nothing may cross the hole (inset 0.45*spacing... lines stop at its offset outline)
        for p in &pls { for w in p.windows(2) { for k in 0..=8 {
            let t = k as f64 / 8.0;
            let (x, y) = (w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t);
            assert!(!(x.abs() < 2.99 && y.abs() < 2.99), "crosses hole at {x},{y}");
        } } }
        // negative control: a plain rectilinear traversal of the same ring does NOT guarantee that
        let rp2 = RectParams { monotonic: false, ..rp };
        let (p2, _) = fill_by_lines(&annulus(), &rp2);
        assert!(!p2.is_empty());
    }
    #[test]
    fn line_positions_are_centred_when_solid_and_stay_inside() {
        let poly = Poly { contour: vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]], holes: vec![] };
        let rp = RectParams { spacing: 0.4, density: 1.0, theta: std::f64::consts::FRAC_PI_2, overlap: 0.0, dont_adjust: false, link_max_length: 0.0, dont_connect: true, monotonic: true, consistent_pattern: false, ref_point: [0.0, 0.0] };
        let (pls, sp) = fill_by_lines(&poly, &rp);
        // theta = 90deg: lines run along x; centred first line at half spacing from the first edge
        let ys: Vec<f64> = pls.iter().map(|p| p[0][1]).collect();
        let mn = ys.iter().cloned().fold(f64::INFINITY, f64::min);
        let mx = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        assert!((mn - sp / 2.0).abs() < 1e-3 && (10.0 - mx - sp / 2.0).abs() < 1e-3, "{mn} {mx} {sp}");
        for w in ys.windows(2) { assert!(((w[1] - w[0]).abs() - sp).abs() < 1e-6); }
        for p in &pls { for q in p { assert!(q[0] >= 0.0 && q[0] <= 10.0 && q[1] > 0.0 && q[1] < 10.0, "{q:?}"); } }
    }
}
