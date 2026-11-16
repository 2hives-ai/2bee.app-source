//! Faithful port of ClipperLib 6.4.2 as shipped with OrcaSlicer 2.5.0-dev (`deps_src/clipper/clipper.cpp`), restricted to what
//! the infill lane needs: open-path intersection (`intersection_pl`), closed boolean union / difference to `Paths` and to a
//! `PolyTree`, and `ClipperOffset` (miter / round / square joins).
//!
//! Why it exists: libslic3r's sparse infill output is decided by integer details of Clipper -- the order in which clipped
//! infill lines come out, which end of a line is the first, which vertex a contracted contour starts at -- and
//! `connect_infill` / the G-code path planner break ties by exactly that order. A float re-implementation cannot reproduce
//! it, so this module follows the C++ line by line (arena indices instead of pointers, `NIL` = nullptr). Behaviour that
//! depends on `std::sort` stability uses `super::stdsort` (libstdc++'s introsort).
use super::stdsort::std_sort;
use std::collections::BinaryHeap;

pub type IP = [i64; 2];
const NIL: usize = usize::MAX;
const UNASSIGNED: i32 = -1;
const SKIP: i32 = -2;
const HORIZONTAL: f64 = -1.0e40;
const ES_LEFT: u8 = 1;
const ES_RIGHT: u8 = 2;
pub const PT_SUBJECT: u8 = 0;
pub const PT_CLIP: u8 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClipType { Intersection, Union, Difference, Xor }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FillType { EvenOdd, NonZero, Positive, Negative }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JoinType { Square, Round, Miter }
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EndType { ClosedPolygon, ClosedLine, OpenButt, OpenSquare, OpenRound }

fn fround(a: f64) -> f64 { if a == 0.49999999999999994 { 0.0 } else { (a + 0.5).floor() } }
fn round_i(v: f64) -> i64 { fround(v) as i64 }

#[derive(Clone, Copy, Debug)]
struct TEdge {
    bot: IP, curr: IP, top: IP, dx: f64,
    poly_typ: u8, side: u8, wind_delta: i32, wind_cnt: i32, wind_cnt2: i32, out_idx: i32,
    next: usize, prev: usize, next_in_lml: usize, next_in_ael: usize, prev_in_ael: usize, next_in_sel: usize, prev_in_sel: usize,
}
#[derive(Clone, Copy)]
struct OutPt { idx: i32, pt: IP, next: usize, prev: usize }
#[derive(Clone, Copy)]
struct OutRec { idx: i32, is_hole: bool, is_open: bool, first_left: usize, poly_nd: usize, pts: usize, bottom_pt: usize }
#[derive(Clone, Copy)]
struct LocalMin { y: i64, left: usize, right: usize }
#[derive(Clone, Copy)]
struct Join { op1: usize, op2: usize, off_pt: IP }
#[derive(Clone, Copy)]
struct IntersectNode { e1: usize, e2: usize, pt: IP }

/// Output tree (`PolyTree`). Node 0 is the root.
#[derive(Clone)]
pub struct PolyNode { pub contour: Vec<IP>, pub childs: Vec<usize>, pub parent: usize, pub index: usize, pub is_open: bool }
impl PolyNode { fn new() -> PolyNode { PolyNode { contour: Vec::new(), childs: Vec::new(), parent: NIL, index: 0, is_open: false } } }
#[derive(Clone)]
pub struct PolyTree { pub nodes: Vec<PolyNode> }
impl PolyTree {
    pub fn new() -> PolyTree { PolyTree { nodes: vec![PolyNode::new()] } }
    fn add_child(&mut self, parent: usize, child: usize) {
        let cnt = self.nodes[parent].childs.len();
        self.nodes[parent].childs.push(child);
        self.nodes[child].parent = parent;
        self.nodes[child].index = cnt;
    }
    pub fn root_childs(&self) -> &[usize] { &self.nodes[0].childs }
    /// `PolyTree::RemoveOutermostPolygon`.
    pub fn remove_outermost_polygon(&mut self) {
        if self.nodes[0].childs.len() == 1 && !self.nodes[self.nodes[0].childs[0]].childs.is_empty() {
            let outer = self.nodes[0].childs[0];
            let outer_childs = self.nodes[outer].childs.clone();
            let outer_parent = self.nodes[outer].parent;
            self.nodes[0].childs[0] = outer_childs[0];
            self.nodes[outer_childs[0]].parent = outer_parent;
            for &c in &outer_childs[1..] { self.add_child(0, c); }
        } else {
            self.nodes[0].childs.clear();
        }
    }
}

// ---- geometry helpers ---------------------------------------------------------------------------------------------
fn slopes_equal4(dx1: i64, dy1: i64, dx2: i64, dy2: i64) -> bool { (dy1 as i128) * (dx2 as i128) == (dx1 as i128) * (dy2 as i128) }
fn slopes_equal3(p1: IP, p2: IP, p3: IP) -> bool { slopes_equal4(p1[0] - p2[0], p1[1] - p2[1], p2[0] - p3[0], p2[1] - p3[1]) }
fn slopes_equal_pts4(p1: IP, p2: IP, p3: IP, p4: IP) -> bool { slopes_equal4(p1[0] - p2[0], p1[1] - p2[1], p3[0] - p4[0], p3[1] - p4[1]) }
fn get_dx(p1: IP, p2: IP) -> f64 { if p1[1] == p2[1] { HORIZONTAL } else { (p2[0] - p1[0]) as f64 / (p2[1] - p1[1]) as f64 } }
fn is_horizontal(e: &TEdge) -> bool { e.dx == HORIZONTAL }
fn top_x(e: &TEdge, cy: i64) -> i64 {
    if cy == e.top[1] { e.top[0] } else { e.bot[0] + round_i(e.dx * (cy - e.bot[1]) as f64) }
}
fn horz_segments_overlap(mut a1: i64, mut b1: i64, mut a2: i64, mut b2: i64) -> bool {
    if a1 > b1 { std::mem::swap(&mut a1, &mut b1); }
    if a2 > b2 { std::mem::swap(&mut a2, &mut b2); }
    a1 < b2 && a2 < b1
}
fn pt2_is_between(p1: IP, p2: IP, p3: IP) -> bool {
    if p1 == p3 || p1 == p2 || p3 == p2 { false }
    else if p1[0] != p3[0] { (p2[0] > p1[0]) == (p2[0] < p3[0]) }
    else { (p2[1] > p1[1]) == (p2[1] < p3[1]) }
}
pub fn path_area(poly: &[IP]) -> f64 {
    let n = poly.len();
    if n < 3 { return 0.0; }
    let mut a = 0.0;
    let mut j = n - 1;
    for i in 0..n { a += (poly[j][0] as f64 + poly[i][0] as f64) * (poly[j][1] as f64 - poly[i][1] as f64); j = i; }
    -a * 0.5
}
pub fn orientation(poly: &[IP]) -> bool { path_area(poly) >= 0.0 }

fn point_in_polygon_cross(a: IP, b: IP, pt: IP) -> f64 {
    (a[0] - pt[0]) as f64 * (b[1] - pt[1]) as f64 - (b[0] - pt[0]) as f64 * (a[1] - pt[1]) as f64
}

fn intersect_point(e1: &TEdge, e2: &TEdge) -> IP {
    let mut ip: IP = [0, 0];
    if e1.dx == e2.dx {
        ip[1] = e1.curr[1];
        ip[0] = top_x(e1, ip[1]);
        return ip;
    }
    let mut y: i64;
    if e1.dx == 0.0 {
        ip[0] = e1.bot[0];
        y = if is_horizontal(e2) { e2.bot[1] } else { round_i(ip[0] as f64 / e2.dx + e2.bot[1] as f64 - (e2.bot[0] as f64 / e2.dx)) };
    } else if e2.dx == 0.0 {
        ip[0] = e2.bot[0];
        y = if is_horizontal(e1) { e1.bot[1] } else { round_i(ip[0] as f64 / e1.dx + e1.bot[1] as f64 - (e1.bot[0] as f64 / e1.dx)) };
    } else {
        let b1 = e1.bot[0] as f64 - e1.bot[1] as f64 * e1.dx;
        let b2 = e2.bot[0] as f64 - e2.bot[1] as f64 * e2.dx;
        let q = (b2 - b1) / (e1.dx - e2.dx);
        y = round_i(q);
        ip[0] = if e1.dx.abs() < e2.dx.abs() { round_i(e1.dx * q + b1) } else { round_i(e2.dx * q + b2) };
    }
    ip[1] = y;
    if y < e1.top[1] || y < e2.top[1] {
        let t = if e1.top[1] > e2.top[1] { e1 } else { e2 };
        ip[1] = t.top[1];
        y = ip[1];
        let pick = if e1.dx.abs() < e2.dx.abs() { e1 } else { e2 };
        ip[0] = top_x(pick, ip[1]);
    }
    if y > e1.curr[1] {
        ip[1] = e1.curr[1];
        let pick = if e1.dx.abs() > e2.dx.abs() { e2 } else { e1 };
        ip[0] = top_x(pick, ip[1]);
    }
    ip
}

/// `ClipperBase` + `Clipper`.
pub struct Clipper {
    edges: Vec<TEdge>,
    minima: Vec<LocalMin>,
    preserve_collinear: bool,
    has_open_paths: bool,
    outs: Vec<OutRec>,
    pts: Vec<OutPt>,
    joins: Vec<Join>,
    ghost_joins: Vec<Join>,
    intersect_list: Vec<IntersectNode>,
    clip_type: ClipType,
    scanbeam: BinaryHeap<i64>,
    maxima: Vec<i64>,
    active: usize,
    sorted: usize,
    clip_fill: FillType,
    subj_fill: FillType,
    reverse_output: bool,
    using_polytree: bool,
    strict_simple: bool,
}

impl Clipper {
    pub fn new() -> Clipper {
        Clipper { edges: Vec::new(), minima: Vec::new(), preserve_collinear: false, has_open_paths: false, outs: Vec::new(), pts: Vec::new(), joins: Vec::new(),
            ghost_joins: Vec::new(), intersect_list: Vec::new(), clip_type: ClipType::Intersection, scanbeam: BinaryHeap::new(), maxima: Vec::new(),
            active: NIL, sorted: NIL, clip_fill: FillType::EvenOdd, subj_fill: FillType::EvenOdd, reverse_output: false, using_polytree: false, strict_simple: false }
    }
    pub fn strictly_simple(&mut self, v: bool) { self.strict_simple = v; }
    pub fn reverse_solution(&mut self, v: bool) { self.reverse_output = v; }

    // ---- ClipperBase ------------------------------------------------------------------------------------------------
    pub fn add_paths(&mut self, paths: &[Vec<IP>], poly_typ: u8, closed: bool) -> bool {
        let mut res = false;
        for p in paths { if self.add_path(p, poly_typ, closed) { res = true; } }
        res
    }
    pub fn add_path(&mut self, pg: &[IP], poly_typ: u8, closed: bool) -> bool {
        if pg.is_empty() { return false; }
        let mut high_i = pg.len() as isize - 1;
        if closed { while high_i > 0 && pg[high_i as usize] == pg[0] { high_i -= 1; } }
        while high_i > 0 && pg[high_i as usize] == pg[high_i as usize - 1] { high_i -= 1; }
        if (closed && high_i < 2) || (!closed && high_i < 1) { return false; }
        let high_i = high_i as usize;
        let base = self.edges.len();
        for _ in 0..=high_i {
            self.edges.push(TEdge { bot: [0, 0], curr: [0, 0], top: [0, 0], dx: 0.0, poly_typ: 0, side: 0, wind_delta: 0, wind_cnt: 0, wind_cnt2: 0, out_idx: UNASSIGNED,
                next: NIL, prev: NIL, next_in_lml: NIL, next_in_ael: NIL, prev_in_ael: NIL, next_in_sel: NIL, prev_in_sel: NIL });
        }
        let ok = self.add_path_internal(pg, high_i, poly_typ, closed, base);
        // (the C++ keeps the edge array only on success; leaving unused edges in the arena is harmless)
        ok
    }

    fn init_edge(&mut self, e: usize, e_next: usize, e_prev: usize, pt: IP) {
        self.edges[e] = TEdge { bot: [0, 0], curr: pt, top: [0, 0], dx: 0.0, poly_typ: 0, side: 0, wind_delta: 0, wind_cnt: 0, wind_cnt2: 0, out_idx: UNASSIGNED,
            next: e_next, prev: e_prev, next_in_lml: NIL, next_in_ael: NIL, prev_in_ael: NIL, next_in_sel: NIL, prev_in_sel: NIL };
    }
    fn init_edge2(&mut self, e: usize, pt: u8) {
        let nxt = self.edges[e].next;
        let ncurr = self.edges[nxt].curr;
        let ed = &mut self.edges[e];
        if ed.curr[1] >= ncurr[1] { ed.bot = ed.curr; ed.top = ncurr; } else { ed.top = ed.curr; ed.bot = ncurr; }
        let dy = ed.top[1] - ed.bot[1];
        ed.dx = if dy == 0 { HORIZONTAL } else { (ed.top[0] - ed.bot[0]) as f64 / dy as f64 };
        ed.poly_typ = pt;
    }
    fn remove_edge(&mut self, e: usize) -> usize {
        let (p, n) = (self.edges[e].prev, self.edges[e].next);
        self.edges[p].next = n;
        self.edges[n].prev = p;
        self.edges[e].prev = NIL;
        n
    }
    fn reverse_horizontal(&mut self, e: usize) {
        let ed = &mut self.edges[e];
        let t = ed.top[0];
        ed.top[0] = ed.bot[0];
        ed.bot[0] = t;
    }

    fn find_next_loc_min(&mut self, mut e: usize) -> usize {
        loop {
            while self.edges[e].bot != self.edges[self.edges[e].prev].bot || self.edges[e].curr == self.edges[e].top { e = self.edges[e].next; }
            if !is_horizontal(&self.edges[e]) && !is_horizontal(&self.edges[self.edges[e].prev]) { break; }
            while is_horizontal(&self.edges[self.edges[e].prev]) { e = self.edges[e].prev; }
            let e2 = e;
            while is_horizontal(&self.edges[e]) { e = self.edges[e].next; }
            if self.edges[e].top[1] == self.edges[self.edges[e].prev].bot[1] { continue; }
            if self.edges[self.edges[e2].prev].bot[0] < self.edges[e].bot[0] { e = e2; }
            break;
        }
        e
    }

    fn process_bound(&mut self, mut e: usize, next_is_forward: bool) -> usize {
        let mut result = e;
        if self.edges[e].out_idx == SKIP {
            if next_is_forward {
                while self.edges[e].top[1] == self.edges[self.edges[e].next].bot[1] { e = self.edges[e].next; }
                while e != result && is_horizontal(&self.edges[e]) { e = self.edges[e].prev; }
            } else {
                while self.edges[e].top[1] == self.edges[self.edges[e].prev].bot[1] { e = self.edges[e].prev; }
                while e != result && is_horizontal(&self.edges[e]) { e = self.edges[e].next; }
            }
            if e == result {
                result = if next_is_forward { self.edges[e].next } else { self.edges[e].prev };
            } else {
                e = if next_is_forward { self.edges[result].next } else { self.edges[result].prev };
                let y = self.edges[e].bot[1];
                self.edges[e].wind_delta = 0;
                result = self.process_bound(e, next_is_forward);
                self.minima.push(LocalMin { y, left: NIL, right: e });
            }
            return result;
        }
        let mut e_start;
        if is_horizontal(&self.edges[e]) {
            e_start = if next_is_forward { self.edges[e].prev } else { self.edges[e].next };
            if is_horizontal(&self.edges[e_start]) {
                if self.edges[e_start].bot[0] != self.edges[e].bot[0] && self.edges[e_start].top[0] != self.edges[e].bot[0] { self.reverse_horizontal(e); }
            } else if self.edges[e_start].bot[0] != self.edges[e].bot[0] { self.reverse_horizontal(e); }
        }
        e_start = e;
        if next_is_forward {
            while self.edges[result].top[1] == self.edges[self.edges[result].next].bot[1] && self.edges[self.edges[result].next].out_idx != SKIP { result = self.edges[result].next; }
            if is_horizontal(&self.edges[result]) && self.edges[self.edges[result].next].out_idx != SKIP {
                let mut horz = result;
                while is_horizontal(&self.edges[self.edges[horz].prev]) { horz = self.edges[horz].prev; }
                if self.edges[self.edges[horz].prev].top[0] > self.edges[self.edges[result].next].top[0] { result = self.edges[horz].prev; }
            }
            while e != result {
                let nx = self.edges[e].next;
                self.edges[e].next_in_lml = nx;
                if is_horizontal(&self.edges[e]) && e != e_start && self.edges[e].bot[0] != self.edges[self.edges[e].prev].top[0] { self.reverse_horizontal(e); }
                e = self.edges[e].next;
            }
            if is_horizontal(&self.edges[e]) && e != e_start && self.edges[e].bot[0] != self.edges[self.edges[e].prev].top[0] { self.reverse_horizontal(e); }
            result = self.edges[result].next;
        } else {
            while self.edges[result].top[1] == self.edges[self.edges[result].prev].bot[1] && self.edges[self.edges[result].prev].out_idx != SKIP { result = self.edges[result].prev; }
            if is_horizontal(&self.edges[result]) && self.edges[self.edges[result].prev].out_idx != SKIP {
                let mut horz = result;
                while is_horizontal(&self.edges[self.edges[horz].next]) { horz = self.edges[horz].next; }
                if self.edges[self.edges[horz].next].top[0] == self.edges[self.edges[result].prev].top[0] || self.edges[self.edges[horz].next].top[0] > self.edges[self.edges[result].prev].top[0] { result = self.edges[horz].next; }
            }
            while e != result {
                let pv = self.edges[e].prev;
                self.edges[e].next_in_lml = pv;
                if is_horizontal(&self.edges[e]) && e != e_start && self.edges[e].bot[0] != self.edges[self.edges[e].next].top[0] { self.reverse_horizontal(e); }
                e = self.edges[e].prev;
            }
            if is_horizontal(&self.edges[e]) && e != e_start && self.edges[e].bot[0] != self.edges[self.edges[e].next].top[0] { self.reverse_horizontal(e); }
            result = self.edges[result].prev;
        }
        result
    }

    fn add_path_internal(&mut self, pg: &[IP], high_i: usize, poly_typ: u8, closed: bool, base: usize) -> bool {
        if !closed && poly_typ == PT_CLIP { panic!("AddPath: Open paths must be subject."); }
        let ix = |i: usize| base + i;
        self.edges[ix(1)].curr = pg[1];
        self.init_edge(ix(0), ix(1), ix(high_i), pg[0]);
        self.init_edge(ix(high_i), ix(0), ix(high_i - 1), pg[high_i]);
        for i in (1..high_i).rev() { self.init_edge(ix(i), ix(i + 1), ix(i - 1), pg[i]); }
        let mut e_start = ix(0);
        // 2. Remove duplicate vertices, and (when closed) collinear edges
        let mut e = e_start;
        let mut e_loop_stop = e_start;
        loop {
            let en = self.edges[e].next;
            if self.edges[e].curr == self.edges[en].curr && (closed || en != e_start) {
                if e == en { break; }
                if e == e_start { e_start = en; }
                e = self.remove_edge(e);
                e_loop_stop = e;
                continue;
            }
            if self.edges[e].prev == self.edges[e].next { break; }
            else if closed && slopes_equal3(self.edges[self.edges[e].prev].curr, self.edges[e].curr, self.edges[self.edges[e].next].curr)
                && (!self.preserve_collinear || !pt2_is_between(self.edges[self.edges[e].prev].curr, self.edges[e].curr, self.edges[self.edges[e].next].curr)) {
                if e == e_start { e_start = self.edges[e].next; }
                e = self.remove_edge(e);
                e = self.edges[e].prev;
                e_loop_stop = e;
                continue;
            }
            e = self.edges[e].next;
            if e == e_loop_stop || (!closed && self.edges[e].next == e_start) { break; }
        }
        if (!closed && e == self.edges[e].next) || (closed && self.edges[e].prev == self.edges[e].next) { return false; }
        if !closed {
            self.has_open_paths = true;
            let p = self.edges[e_start].prev;
            self.edges[p].out_idx = SKIP;
        }
        // 3. second stage of edge initialization
        let mut is_flat = true;
        e = e_start;
        loop {
            self.init_edge2(e, poly_typ);
            e = self.edges[e].next;
            if is_flat && self.edges[e].curr[1] != self.edges[e_start].curr[1] { is_flat = false; }
            if e == e_start { break; }
        }
        // 4. add edge bounds to the LocalMinima list
        if is_flat {
            if closed { return false; }
            let p = self.edges[e].prev;
            self.edges[p].out_idx = SKIP;
            let loc_min_y = self.edges[e].bot[1];
            let right = e;
            self.edges[right].side = ES_RIGHT;
            self.edges[right].wind_delta = 0;
            loop {
                if self.edges[e].bot[0] != self.edges[self.edges[e].prev].top[0] { self.reverse_horizontal(e); }
                if self.edges[self.edges[e].next].out_idx == SKIP { break; }
                let nx = self.edges[e].next;
                self.edges[e].next_in_lml = nx;
                e = nx;
            }
            self.minima.push(LocalMin { y: loc_min_y, left: NIL, right });
            return true;
        }
        let mut e_min = NIL;
        if self.edges[self.edges[e].prev].bot == self.edges[self.edges[e].prev].top { e = self.edges[e].next; }
        loop {
            e = self.find_next_loc_min(e);
            if e == e_min { break; }
            else if e_min == NIL { e_min = e; }
            let ep = self.edges[e].prev;
            let (mut lb, mut rb, left_forward);
            if self.edges[e].dx < self.edges[ep].dx { lb = ep; rb = e; left_forward = false; } else { lb = e; rb = ep; left_forward = true; }
            let y = self.edges[e].bot[1];
            if !closed { self.edges[lb].wind_delta = 0; }
            else if self.edges[lb].next == rb { self.edges[lb].wind_delta = -1; }
            else { self.edges[lb].wind_delta = 1; }
            self.edges[rb].wind_delta = -self.edges[lb].wind_delta;
            e = self.process_bound(lb, left_forward);
            if self.edges[e].out_idx == SKIP { e = self.process_bound(e, left_forward); }
            let mut e2 = self.process_bound(rb, !left_forward);
            if self.edges[e2].out_idx == SKIP { e2 = self.process_bound(e2, !left_forward); }
            if self.edges[lb].out_idx == SKIP { lb = NIL; }
            else if self.edges[rb].out_idx == SKIP { rb = NIL; }
            self.minima.push(LocalMin { y, left: lb, right: rb });
            if !left_forward { e = e2; }
        }
        true
    }

    fn base_reset(&mut self) {
        if self.minima.is_empty() { return; }
        std_sort(&mut self.minima, |a, b| a.y < b.y);
        for i in 0..self.minima.len() {
            let lm = self.minima[i];
            if lm.left != NIL { let e = &mut self.edges[lm.left]; e.curr = e.bot; e.side = ES_LEFT; e.out_idx = UNASSIGNED; }
            if lm.right != NIL { let e = &mut self.edges[lm.right]; e.curr = e.bot; e.side = ES_RIGHT; e.out_idx = UNASSIGNED; }
        }
    }

    /// `ClipperBase::GetBounds`: (left, top, right, bottom).
    pub fn get_bounds(&self) -> (i64, i64, i64, i64) {
        if self.minima.is_empty() { return (0, 0, 0, 0); }
        let first = self.edges[self.minima[0].left].bot;
        let (mut left, mut top, mut right, mut bottom) = (first[0], first[1], first[0], first[1]);
        for lm in &self.minima {
            bottom = bottom.max(self.edges[lm.left].bot[1]);
            let mut e = lm.left;
            loop {
                let bottom_e = e;
                while self.edges[e].next_in_lml != NIL {
                    if self.edges[e].bot[0] < left { left = self.edges[e].bot[0]; }
                    if self.edges[e].bot[0] > right { right = self.edges[e].bot[0]; }
                    e = self.edges[e].next_in_lml;
                }
                left = left.min(self.edges[e].bot[0]);
                right = right.max(self.edges[e].bot[0]);
                left = left.min(self.edges[e].top[0]);
                right = right.max(self.edges[e].top[0]);
                top = top.min(self.edges[e].top[1]);
                if bottom_e == lm.left { e = lm.right; } else { break; }
            }
        }
        (left, top, right, bottom)
    }

    // ---- Clipper ----------------------------------------------------------------------------------------------------
    fn is_even_odd_fill(&self, e: usize) -> bool {
        let ed = &self.edges[e];
        if ed.poly_typ == PT_SUBJECT { self.subj_fill == FillType::EvenOdd } else { self.clip_fill == FillType::EvenOdd }
    }
    fn is_even_odd_alt_fill(&self, e: usize) -> bool {
        let ed = &self.edges[e];
        if ed.poly_typ == PT_SUBJECT { self.clip_fill == FillType::EvenOdd } else { self.subj_fill == FillType::EvenOdd }
    }

    fn set_winding_count(&mut self, edge: usize) {
        let mut e = self.edges[edge].prev_in_ael;
        let pt = self.edges[edge].poly_typ;
        while e != NIL && (self.edges[e].poly_typ != pt || self.edges[e].wind_delta == 0) { e = self.edges[e].prev_in_ael; }
        if e == NIL {
            if self.edges[edge].wind_delta == 0 {
                let pft = if pt == PT_SUBJECT { self.subj_fill } else { self.clip_fill };
                self.edges[edge].wind_cnt = if pft == FillType::Negative { -1 } else { 1 };
            } else {
                self.edges[edge].wind_cnt = self.edges[edge].wind_delta;
            }
            self.edges[edge].wind_cnt2 = 0;
            e = self.active;
        } else if self.edges[edge].wind_delta == 0 && self.clip_type != ClipType::Union {
            self.edges[edge].wind_cnt = 1;
            self.edges[edge].wind_cnt2 = self.edges[e].wind_cnt2;
            e = self.edges[e].next_in_ael;
        } else if self.is_even_odd_fill(edge) {
            if self.edges[edge].wind_delta == 0 {
                let mut inside = true;
                let mut e2 = self.edges[e].prev_in_ael;
                while e2 != NIL {
                    if self.edges[e2].poly_typ == self.edges[e].poly_typ && self.edges[e2].wind_delta != 0 { inside = !inside; }
                    e2 = self.edges[e2].prev_in_ael;
                }
                self.edges[edge].wind_cnt = if inside { 0 } else { 1 };
            } else {
                self.edges[edge].wind_cnt = self.edges[edge].wind_delta;
            }
            self.edges[edge].wind_cnt2 = self.edges[e].wind_cnt2;
            e = self.edges[e].next_in_ael;
        } else {
            let (ewc, ewd) = (self.edges[e].wind_cnt, self.edges[e].wind_delta);
            let ed_wd = self.edges[edge].wind_delta;
            if ewc * ewd < 0 {
                if ewc.abs() > 1 {
                    if ewd * ed_wd < 0 { self.edges[edge].wind_cnt = ewc; } else { self.edges[edge].wind_cnt = ewc + ed_wd; }
                } else {
                    self.edges[edge].wind_cnt = if ed_wd == 0 { 1 } else { ed_wd };
                }
            } else if ed_wd == 0 {
                self.edges[edge].wind_cnt = if ewc < 0 { ewc - 1 } else { ewc + 1 };
            } else if ewd * ed_wd < 0 {
                self.edges[edge].wind_cnt = ewc;
            } else {
                self.edges[edge].wind_cnt = ewc + ed_wd;
            }
            self.edges[edge].wind_cnt2 = self.edges[e].wind_cnt2;
            e = self.edges[e].next_in_ael;
        }
        if self.is_even_odd_alt_fill(edge) {
            while e != edge {
                if self.edges[e].wind_delta != 0 { self.edges[edge].wind_cnt2 = if self.edges[edge].wind_cnt2 == 0 { 1 } else { 0 }; }
                e = self.edges[e].next_in_ael;
            }
        } else {
            while e != edge {
                self.edges[edge].wind_cnt2 += self.edges[e].wind_delta;
                e = self.edges[e].next_in_ael;
            }
        }
    }

    fn is_contributing(&self, edge: usize) -> bool {
        let ed = &self.edges[edge];
        let (pft, pft2) = if ed.poly_typ == PT_SUBJECT { (self.subj_fill, self.clip_fill) } else { (self.clip_fill, self.subj_fill) };
        match pft {
            FillType::EvenOdd => { if ed.wind_delta == 0 && ed.wind_cnt != 1 { return false; } }
            FillType::NonZero => { if ed.wind_cnt.abs() != 1 { return false; } }
            FillType::Positive => { if ed.wind_cnt != 1 { return false; } }
            FillType::Negative => { if ed.wind_cnt != -1 { return false; } }
        }
        match self.clip_type {
            ClipType::Intersection => match pft2 {
                FillType::EvenOdd | FillType::NonZero => ed.wind_cnt2 != 0,
                FillType::Positive => ed.wind_cnt2 > 0,
                FillType::Negative => ed.wind_cnt2 < 0,
            },
            ClipType::Union => match pft2 {
                FillType::EvenOdd | FillType::NonZero => ed.wind_cnt2 == 0,
                FillType::Positive => ed.wind_cnt2 <= 0,
                FillType::Negative => ed.wind_cnt2 >= 0,
            },
            ClipType::Difference => {
                if ed.poly_typ == PT_SUBJECT {
                    match pft2 {
                        FillType::EvenOdd | FillType::NonZero => ed.wind_cnt2 == 0,
                        FillType::Positive => ed.wind_cnt2 <= 0,
                        FillType::Negative => ed.wind_cnt2 >= 0,
                    }
                } else {
                    match pft2 {
                        FillType::EvenOdd | FillType::NonZero => ed.wind_cnt2 != 0,
                        FillType::Positive => ed.wind_cnt2 > 0,
                        FillType::Negative => ed.wind_cnt2 < 0,
                    }
                }
            }
            ClipType::Xor => {
                if ed.wind_delta == 0 {
                    match pft2 {
                        FillType::EvenOdd | FillType::NonZero => ed.wind_cnt2 == 0,
                        FillType::Positive => ed.wind_cnt2 <= 0,
                        FillType::Negative => ed.wind_cnt2 >= 0,
                    }
                } else { true }
            }
        }
    }

    fn add_local_min_poly(&mut self, e1: usize, e2: usize, pt: IP) -> usize {
        let result;
        let (e, prev_e);
        if is_horizontal(&self.edges[e2]) || self.edges[e1].dx > self.edges[e2].dx {
            result = self.add_out_pt(e1, pt);
            self.edges[e2].out_idx = self.edges[e1].out_idx;
            self.edges[e1].side = ES_LEFT;
            self.edges[e2].side = ES_RIGHT;
            e = e1;
            prev_e = if self.edges[e].prev_in_ael == e2 { self.edges[e2].prev_in_ael } else { self.edges[e].prev_in_ael };
        } else {
            result = self.add_out_pt(e2, pt);
            self.edges[e1].out_idx = self.edges[e2].out_idx;
            self.edges[e1].side = ES_RIGHT;
            self.edges[e2].side = ES_LEFT;
            e = e2;
            prev_e = if self.edges[e].prev_in_ael == e1 { self.edges[e1].prev_in_ael } else { self.edges[e].prev_in_ael };
        }
        if prev_e != NIL && self.edges[prev_e].out_idx >= 0 && self.edges[prev_e].top[1] < pt[1] && self.edges[e].top[1] < pt[1] {
            let x_prev = top_x(&self.edges[prev_e], pt[1]);
            let x_e = top_x(&self.edges[e], pt[1]);
            if x_prev == x_e && self.edges[e].wind_delta != 0 && self.edges[prev_e].wind_delta != 0
                && slopes_equal_pts4([x_prev, pt[1]], self.edges[prev_e].top, [x_e, pt[1]], self.edges[e].top) {
                let out_pt = self.add_out_pt(prev_e, pt);
                self.joins.push(Join { op1: result, op2: out_pt, off_pt: self.edges[e].top });
            }
        }
        result
    }

    fn add_local_max_poly(&mut self, e1: usize, e2: usize, pt: IP) {
        self.add_out_pt(e1, pt);
        if self.edges[e2].wind_delta == 0 { self.add_out_pt(e2, pt); }
        if self.edges[e1].out_idx == self.edges[e2].out_idx {
            self.edges[e1].out_idx = UNASSIGNED;
            self.edges[e2].out_idx = UNASSIGNED;
        } else if self.edges[e1].out_idx < self.edges[e2].out_idx { self.append_polygon(e1, e2); }
        else { self.append_polygon(e2, e1); }
    }

    fn add_edge_to_sel(&mut self, edge: usize) {
        if self.sorted == NIL {
            self.sorted = edge;
            self.edges[edge].prev_in_sel = NIL;
            self.edges[edge].next_in_sel = NIL;
        } else {
            self.edges[edge].next_in_sel = self.sorted;
            self.edges[edge].prev_in_sel = NIL;
            let s = self.sorted;
            self.edges[s].prev_in_sel = edge;
            self.sorted = edge;
        }
    }
    fn copy_ael_to_sel(&mut self) {
        let mut e = self.active;
        self.sorted = e;
        while e != NIL {
            self.edges[e].prev_in_sel = self.edges[e].prev_in_ael;
            self.edges[e].next_in_sel = self.edges[e].next_in_ael;
            e = self.edges[e].next_in_ael;
        }
    }

    fn e2_inserts_before_e1(&self, e1: usize, e2: usize) -> bool {
        let (a, b) = (&self.edges[e1], &self.edges[e2]);
        if b.curr[0] == a.curr[0] {
            if b.top[1] > a.top[1] { b.top[0] < top_x(a, b.top[1]) } else { a.top[0] > top_x(b, a.top[1]) }
        } else { b.curr[0] < a.curr[0] }
    }

    fn insert_edge_into_ael(&mut self, edge: usize, mut start_edge: usize) {
        if self.active == NIL {
            self.edges[edge].prev_in_ael = NIL;
            self.edges[edge].next_in_ael = NIL;
            self.active = edge;
        } else if start_edge == NIL && self.e2_inserts_before_e1(self.active, edge) {
            self.edges[edge].prev_in_ael = NIL;
            self.edges[edge].next_in_ael = self.active;
            let a = self.active;
            self.edges[a].prev_in_ael = edge;
            self.active = edge;
        } else {
            if start_edge == NIL { start_edge = self.active; }
            while self.edges[start_edge].next_in_ael != NIL && !self.e2_inserts_before_e1(self.edges[start_edge].next_in_ael, edge) { start_edge = self.edges[start_edge].next_in_ael; }
            self.edges[edge].next_in_ael = self.edges[start_edge].next_in_ael;
            let n = self.edges[start_edge].next_in_ael;
            if n != NIL { self.edges[n].prev_in_ael = edge; }
            self.edges[edge].prev_in_ael = start_edge;
            self.edges[start_edge].next_in_ael = edge;
        }
    }

    fn insert_local_minima_into_ael(&mut self, bot_y: i64) {
        while !self.minima.is_empty() && self.minima.last().unwrap().y == bot_y {
            let lm = self.minima.pop().unwrap();
            let (lb, rb) = (lm.left, lm.right);
            let mut op1 = NIL;
            if lb == NIL {
                self.insert_edge_into_ael(rb, NIL);
                self.set_winding_count(rb);
                if self.is_contributing(rb) { op1 = self.add_out_pt(rb, self.edges[rb].bot); }
            } else if rb == NIL {
                self.insert_edge_into_ael(lb, NIL);
                self.set_winding_count(lb);
                if self.is_contributing(lb) { op1 = self.add_out_pt(lb, self.edges[lb].bot); }
                self.scanbeam.push(self.edges[lb].top[1]);
            } else {
                self.insert_edge_into_ael(lb, NIL);
                self.insert_edge_into_ael(rb, lb);
                self.set_winding_count(lb);
                self.edges[rb].wind_cnt = self.edges[lb].wind_cnt;
                self.edges[rb].wind_cnt2 = self.edges[lb].wind_cnt2;
                if self.is_contributing(lb) { op1 = self.add_local_min_poly(lb, rb, self.edges[lb].bot); }
                self.scanbeam.push(self.edges[lb].top[1]);
            }
            if rb != NIL {
                if is_horizontal(&self.edges[rb]) {
                    self.add_edge_to_sel(rb);
                    let n = self.edges[rb].next_in_lml;
                    if n != NIL { self.scanbeam.push(self.edges[n].top[1]); }
                } else {
                    self.scanbeam.push(self.edges[rb].top[1]);
                }
            }
            if lb == NIL || rb == NIL { continue; }
            if op1 != NIL && is_horizontal(&self.edges[rb]) && !self.ghost_joins.is_empty() && self.edges[rb].wind_delta != 0 {
                for gi in 0..self.ghost_joins.len() {
                    let jr = self.ghost_joins[gi];
                    if horz_segments_overlap(self.pts[jr.op1].pt[0], jr.off_pt[0], self.edges[rb].bot[0], self.edges[rb].top[0]) {
                        self.joins.push(Join { op1: jr.op1, op2: op1, off_pt: jr.off_pt });
                    }
                }
            }
            let lb_prev = self.edges[lb].prev_in_ael;
            if self.edges[lb].out_idx >= 0 && lb_prev != NIL && self.edges[lb_prev].curr[0] == self.edges[lb].bot[0] && self.edges[lb_prev].out_idx >= 0
                && slopes_equal_pts4(self.edges[lb_prev].bot, self.edges[lb_prev].top, self.edges[lb].curr, self.edges[lb].top)
                && self.edges[lb].wind_delta != 0 && self.edges[lb_prev].wind_delta != 0 {
                let op2 = self.add_out_pt(lb_prev, self.edges[lb].bot);
                self.joins.push(Join { op1, op2, off_pt: self.edges[lb].top });
            }
            if self.edges[lb].next_in_ael != rb {
                let rb_prev = self.edges[rb].prev_in_ael;
                if self.edges[rb].out_idx >= 0 && self.edges[rb_prev].out_idx >= 0
                    && slopes_equal_pts4(self.edges[rb_prev].curr, self.edges[rb_prev].top, self.edges[rb].curr, self.edges[rb].top)
                    && self.edges[rb].wind_delta != 0 && self.edges[rb_prev].wind_delta != 0 {
                    let op2 = self.add_out_pt(rb_prev, self.edges[rb].bot);
                    self.joins.push(Join { op1, op2, off_pt: self.edges[rb].top });
                }
                let mut e = self.edges[lb].next_in_ael;
                if e != NIL {
                    while e != rb {
                        let mut c = self.edges[lb].curr;
                        self.intersect_edges(rb, e, &mut c);
                        e = self.edges[e].next_in_ael;
                    }
                }
            }
        }
    }

    fn delete_from_ael(&mut self, e: usize) {
        let ap = self.edges[e].prev_in_ael;
        let an = self.edges[e].next_in_ael;
        if ap == NIL && an == NIL && e != self.active { return; }
        if ap != NIL { self.edges[ap].next_in_ael = an; } else { self.active = an; }
        if an != NIL { self.edges[an].prev_in_ael = ap; }
        self.edges[e].next_in_ael = NIL;
        self.edges[e].prev_in_ael = NIL;
    }
    fn delete_from_sel(&mut self, e: usize) {
        let sp = self.edges[e].prev_in_sel;
        let sn = self.edges[e].next_in_sel;
        if sp == NIL && sn == NIL && e != self.sorted { return; }
        if sp != NIL { self.edges[sp].next_in_sel = sn; } else { self.sorted = sn; }
        if sn != NIL { self.edges[sn].prev_in_sel = sp; }
        self.edges[e].next_in_sel = NIL;
        self.edges[e].prev_in_sel = NIL;
    }

    fn swap_side_outidx(&mut self, e1: usize, e2: usize) {
        let (s1, s2) = (self.edges[e1].side, self.edges[e2].side);
        self.edges[e1].side = s2; self.edges[e2].side = s1;
        let (o1, o2) = (self.edges[e1].out_idx, self.edges[e2].out_idx);
        self.edges[e1].out_idx = o2; self.edges[e2].out_idx = o1;
    }

    fn intersect_edges(&mut self, e1: usize, e2: usize, pt: &mut IP) {
        let e1c = self.edges[e1].out_idx >= 0;
        let e2c = self.edges[e2].out_idx >= 0;
        // open-path handling
        if self.edges[e1].wind_delta == 0 || self.edges[e2].wind_delta == 0 {
            if self.edges[e1].wind_delta == 0 && self.edges[e2].wind_delta == 0 { return; }
            else if self.edges[e1].poly_typ == self.edges[e2].poly_typ && self.edges[e1].wind_delta != self.edges[e2].wind_delta && self.clip_type == ClipType::Union {
                if self.edges[e1].wind_delta == 0 {
                    if e2c {
                        self.add_out_pt(e1, *pt);
                        if e1c { self.edges[e1].out_idx = UNASSIGNED; }
                    }
                } else if e1c {
                    self.add_out_pt(e2, *pt);
                    if e2c { self.edges[e2].out_idx = UNASSIGNED; }
                }
            } else if self.edges[e1].poly_typ != self.edges[e2].poly_typ {
                if self.edges[e1].wind_delta == 0 && self.edges[e2].wind_cnt.abs() == 1 && (self.clip_type != ClipType::Union || self.edges[e2].wind_cnt2 == 0) {
                    self.add_out_pt(e1, *pt);
                    if e1c { self.edges[e1].out_idx = UNASSIGNED; }
                } else if self.edges[e2].wind_delta == 0 && self.edges[e1].wind_cnt.abs() == 1 && (self.clip_type != ClipType::Union || self.edges[e1].wind_cnt2 == 0) {
                    self.add_out_pt(e2, *pt);
                    if e2c { self.edges[e2].out_idx = UNASSIGNED; }
                }
            }
            return;
        }
        // update winding counts
        if self.edges[e1].poly_typ == self.edges[e2].poly_typ {
            if self.is_even_odd_fill(e1) {
                let old = self.edges[e1].wind_cnt;
                self.edges[e1].wind_cnt = self.edges[e2].wind_cnt;
                self.edges[e2].wind_cnt = old;
            } else {
                if self.edges[e1].wind_cnt + self.edges[e2].wind_delta == 0 { self.edges[e1].wind_cnt = -self.edges[e1].wind_cnt; }
                else { self.edges[e1].wind_cnt += self.edges[e2].wind_delta; }
                if self.edges[e2].wind_cnt - self.edges[e1].wind_delta == 0 { self.edges[e2].wind_cnt = -self.edges[e2].wind_cnt; }
                else { self.edges[e2].wind_cnt -= self.edges[e1].wind_delta; }
            }
        } else {
            if !self.is_even_odd_fill(e2) { self.edges[e1].wind_cnt2 += self.edges[e2].wind_delta; }
            else { self.edges[e1].wind_cnt2 = if self.edges[e1].wind_cnt2 == 0 { 1 } else { 0 }; }
            if !self.is_even_odd_fill(e1) { self.edges[e2].wind_cnt2 -= self.edges[e1].wind_delta; }
            else { self.edges[e2].wind_cnt2 = if self.edges[e2].wind_cnt2 == 0 { 1 } else { 0 }; }
        }
        let (e1_ft, e1_ft2) = if self.edges[e1].poly_typ == PT_SUBJECT { (self.subj_fill, self.clip_fill) } else { (self.clip_fill, self.subj_fill) };
        let (e2_ft, e2_ft2) = if self.edges[e2].poly_typ == PT_SUBJECT { (self.subj_fill, self.clip_fill) } else { (self.clip_fill, self.subj_fill) };
        let wc = |ft: FillType, v: i32| -> i64 { match ft { FillType::Positive => v as i64, FillType::Negative => -(v as i64), _ => (v as i64).abs() } };
        let e1_wc = wc(e1_ft, self.edges[e1].wind_cnt);
        let e2_wc = wc(e2_ft, self.edges[e2].wind_cnt);
        if e1c && e2c {
            if (e1_wc != 0 && e1_wc != 1) || (e2_wc != 0 && e2_wc != 1) || (self.edges[e1].poly_typ != self.edges[e2].poly_typ && self.clip_type != ClipType::Xor) {
                self.add_local_max_poly(e1, e2, *pt);
            } else {
                self.add_out_pt(e1, *pt);
                self.add_out_pt(e2, *pt);
                self.swap_side_outidx(e1, e2);
            }
        } else if e1c {
            if e2_wc == 0 || e2_wc == 1 {
                self.add_out_pt(e1, *pt);
                self.swap_side_outidx(e1, e2);
            }
        } else if e2c {
            if e1_wc == 0 || e1_wc == 1 {
                self.add_out_pt(e2, *pt);
                self.swap_side_outidx(e1, e2);
            }
        } else if (e1_wc == 0 || e1_wc == 1) && (e2_wc == 0 || e2_wc == 1) {
            let e1_wc2 = wc(e1_ft2, self.edges[e1].wind_cnt2);
            let e2_wc2 = wc(e2_ft2, self.edges[e2].wind_cnt2);
            if self.edges[e1].poly_typ != self.edges[e2].poly_typ {
                self.add_local_min_poly(e1, e2, *pt);
            } else if e1_wc == 1 && e2_wc == 1 {
                match self.clip_type {
                    ClipType::Intersection => { if e1_wc2 > 0 && e2_wc2 > 0 { self.add_local_min_poly(e1, e2, *pt); } }
                    ClipType::Union => { if e1_wc2 <= 0 && e2_wc2 <= 0 { self.add_local_min_poly(e1, e2, *pt); } }
                    ClipType::Difference => {
                        let pt1 = self.edges[e1].poly_typ;
                        if (pt1 == PT_CLIP && e1_wc2 > 0 && e2_wc2 > 0) || (pt1 == PT_SUBJECT && e1_wc2 <= 0 && e2_wc2 <= 0) { self.add_local_min_poly(e1, e2, *pt); }
                    }
                    ClipType::Xor => { self.add_local_min_poly(e1, e2, *pt); }
                }
            } else {
                let (s1, s2) = (self.edges[e1].side, self.edges[e2].side);
                self.edges[e1].side = s2; self.edges[e2].side = s1;
            }
        }
    }

    fn set_hole_state(&mut self, e: usize, outrec: usize) {
        let mut e2 = self.edges[e].prev_in_ael;
        let mut e_tmp = NIL;
        while e2 != NIL {
            if self.edges[e2].out_idx >= 0 && self.edges[e2].wind_delta != 0 {
                if e_tmp == NIL { e_tmp = e2; }
                else if self.edges[e_tmp].out_idx == self.edges[e2].out_idx { e_tmp = NIL; }
            }
            e2 = self.edges[e2].prev_in_ael;
        }
        if e_tmp == NIL {
            self.outs[outrec].first_left = NIL;
            self.outs[outrec].is_hole = false;
        } else {
            let fl = self.edges[e_tmp].out_idx as usize;
            self.outs[outrec].first_left = fl;
            self.outs[outrec].is_hole = !self.outs[fl].is_hole;
        }
    }

    fn area_op(&self, op: usize) -> f64 {
        if op == NIL { return 0.0; }
        let start = op;
        let mut op = op;
        let mut a = 0.0;
        loop {
            let p = self.pts[op].prev;
            a += (self.pts[p].pt[0] + self.pts[op].pt[0]) as f64 * (self.pts[p].pt[1] - self.pts[op].pt[1]) as f64;
            op = self.pts[op].next;
            if op == start { break; }
        }
        a * 0.5
    }

    fn first_is_bottom_pt(&self, b1: usize, b2: usize) -> bool {
        let pts = &self.pts;
        let mut p = pts[b1].prev;
        while pts[p].pt == pts[b1].pt && p != b1 { p = pts[p].prev; }
        let dx1p = get_dx(pts[b1].pt, pts[p].pt).abs();
        p = pts[b1].next;
        while pts[p].pt == pts[b1].pt && p != b1 { p = pts[p].next; }
        let dx1n = get_dx(pts[b1].pt, pts[p].pt).abs();
        p = pts[b2].prev;
        while pts[p].pt == pts[b2].pt && p != b2 { p = pts[p].prev; }
        let dx2p = get_dx(pts[b2].pt, pts[p].pt).abs();
        p = pts[b2].next;
        while pts[p].pt == pts[b2].pt && p != b2 { p = pts[p].next; }
        let dx2n = get_dx(pts[b2].pt, pts[p].pt).abs();
        if dx1p.max(dx1n) == dx2p.max(dx2n) && dx1p.min(dx1n) == dx2p.min(dx2n) {
            self.area_op(b1) > 0.0
        } else {
            (dx1p >= dx2p && dx1p >= dx2n) || (dx1n >= dx2p && dx1n >= dx2n)
        }
    }

    fn get_bottom_pt(&self, mut pp: usize) -> usize {
        let pts = &self.pts;
        let mut dups = NIL;
        let mut p = pts[pp].next;
        while p != pp {
            if pts[p].pt[1] > pts[pp].pt[1] {
                pp = p;
                dups = NIL;
            } else if pts[p].pt[1] == pts[pp].pt[1] && pts[p].pt[0] <= pts[pp].pt[0] {
                if pts[p].pt[0] < pts[pp].pt[0] {
                    dups = NIL;
                    pp = p;
                } else if pts[p].next != pp && pts[p].prev != pp { dups = p; }
            }
            p = pts[p].next;
        }
        if dups != NIL {
            while dups != p {
                if !self.first_is_bottom_pt(p, dups) { pp = dups; }
                dups = pts[dups].next;
                while pts[dups].pt != pts[pp].pt { dups = pts[dups].next; }
            }
        }
        pp
    }

    fn get_lowermost_rec(&mut self, r1: usize, r2: usize) -> usize {
        if self.outs[r1].bottom_pt == NIL { self.outs[r1].bottom_pt = self.get_bottom_pt(self.outs[r1].pts); }
        if self.outs[r2].bottom_pt == NIL { self.outs[r2].bottom_pt = self.get_bottom_pt(self.outs[r2].pts); }
        let o1 = self.outs[r1].bottom_pt;
        let o2 = self.outs[r2].bottom_pt;
        let (p1, p2) = (self.pts[o1].pt, self.pts[o2].pt);
        if p1[1] > p2[1] { r1 }
        else if p1[1] < p2[1] { r2 }
        else if p1[0] < p2[0] { r1 }
        else if p1[0] > p2[0] { r2 }
        else if self.pts[o1].next == o1 { r2 }
        else if self.pts[o2].next == o2 { r1 }
        else if self.first_is_bottom_pt(o1, o2) { r1 }
        else { r2 }
    }

    fn outrec1_right_of_outrec2(&self, mut r1: usize, r2: usize) -> bool {
        loop {
            r1 = self.outs[r1].first_left;
            if r1 == r2 { return true; }
            if r1 == NIL { return false; }
        }
    }

    fn get_out_rec(&self, idx: i32) -> usize {
        let mut o = idx as usize;
        while o != self.outs[o].idx as usize { o = self.outs[o].idx as usize; }
        o
    }

    fn reverse_poly_pt_links(&mut self, pp: usize) {
        if pp == NIL { return; }
        let mut pp1 = pp;
        loop {
            let pp2 = self.pts[pp1].next;
            self.pts[pp1].next = self.pts[pp1].prev;
            self.pts[pp1].prev = pp2;
            pp1 = pp2;
            if pp1 == pp { break; }
        }
    }

    fn append_polygon(&mut self, e1: usize, e2: usize) {
        let r1 = self.edges[e1].out_idx as usize;
        let r2 = self.edges[e2].out_idx as usize;
        let hole_state_rec;
        if self.outrec1_right_of_outrec2(r1, r2) { hole_state_rec = r2; }
        else if self.outrec1_right_of_outrec2(r2, r1) { hole_state_rec = r1; }
        else { hole_state_rec = self.get_lowermost_rec(r1, r2); }
        let p1_lft = self.outs[r1].pts;
        let p1_rt = self.pts[p1_lft].prev;
        let p2_lft = self.outs[r2].pts;
        let p2_rt = self.pts[p2_lft].prev;
        if self.edges[e1].side == ES_LEFT {
            if self.edges[e2].side == ES_LEFT {
                self.reverse_poly_pt_links(p2_lft);
                self.pts[p2_lft].next = p1_lft;
                self.pts[p1_lft].prev = p2_lft;
                self.pts[p1_rt].next = p2_rt;
                self.pts[p2_rt].prev = p1_rt;
                self.outs[r1].pts = p2_rt;
            } else {
                self.pts[p2_rt].next = p1_lft;
                self.pts[p1_lft].prev = p2_rt;
                self.pts[p2_lft].prev = p1_rt;
                self.pts[p1_rt].next = p2_lft;
                self.outs[r1].pts = p2_lft;
            }
        } else if self.edges[e2].side == ES_RIGHT {
            self.reverse_poly_pt_links(p2_lft);
            self.pts[p1_rt].next = p2_rt;
            self.pts[p2_rt].prev = p1_rt;
            self.pts[p2_lft].next = p1_lft;
            self.pts[p1_lft].prev = p2_lft;
        } else {
            self.pts[p1_rt].next = p2_lft;
            self.pts[p2_lft].prev = p1_rt;
            self.pts[p1_lft].prev = p2_rt;
            self.pts[p2_rt].next = p1_lft;
        }
        self.outs[r1].bottom_pt = NIL;
        if hole_state_rec == r2 {
            if self.outs[r2].first_left != r1 { self.outs[r1].first_left = self.outs[r2].first_left; }
            self.outs[r1].is_hole = self.outs[r2].is_hole;
        }
        self.outs[r2].pts = NIL;
        self.outs[r2].bottom_pt = NIL;
        self.outs[r2].first_left = r1;
        let ok_idx = self.edges[e1].out_idx;
        let obsolete_idx = self.edges[e2].out_idx;
        self.edges[e1].out_idx = UNASSIGNED;
        self.edges[e2].out_idx = UNASSIGNED;
        let mut e = self.active;
        while e != NIL {
            if self.edges[e].out_idx == obsolete_idx {
                self.edges[e].out_idx = ok_idx;
                self.edges[e].side = self.edges[e1].side;
                break;
            }
            e = self.edges[e].next_in_ael;
        }
        self.outs[r2].idx = self.outs[r1].idx;
    }

    fn create_out_rec(&mut self) -> usize {
        let idx = self.outs.len() as i32;
        self.outs.push(OutRec { idx, is_hole: false, is_open: false, first_left: NIL, poly_nd: NIL, pts: NIL, bottom_pt: NIL });
        idx as usize
    }

    fn add_out_pt(&mut self, e: usize, pt: IP) -> usize {
        if self.edges[e].out_idx < 0 {
            let r = self.create_out_rec();
            self.outs[r].is_open = self.edges[e].wind_delta == 0;
            let new_op = self.pts.len();
            self.pts.push(OutPt { idx: self.outs[r].idx, pt, next: new_op, prev: new_op });
            self.outs[r].pts = new_op;
            if !self.outs[r].is_open { self.set_hole_state(e, r); }
            self.edges[e].out_idx = self.outs[r].idx;
            new_op
        } else {
            let r = self.edges[e].out_idx as usize;
            let op = self.outs[r].pts;
            let to_front = self.edges[e].side == ES_LEFT;
            if to_front && pt == self.pts[op].pt { return op; }
            else if !to_front && pt == self.pts[self.pts[op].prev].pt { return self.pts[op].prev; }
            let new_op = self.pts.len();
            let op_prev = self.pts[op].prev;
            self.pts.push(OutPt { idx: self.outs[r].idx, pt, next: op, prev: op_prev });
            self.pts[op_prev].next = new_op;
            self.pts[op].prev = new_op;
            if to_front { self.outs[r].pts = new_op; }
            new_op
        }
    }

    fn get_last_out_pt(&self, e: usize) -> usize {
        let r = self.edges[e].out_idx as usize;
        if self.edges[e].side == ES_LEFT { self.outs[r].pts } else { self.pts[self.outs[r].pts].prev }
    }

    fn process_horizontals(&mut self) {
        let mut h = self.sorted;
        while h != NIL {
            self.delete_from_sel(h);
            self.process_horizontal(h);
            h = self.sorted;
        }
    }

    fn is_maxima(&self, e: usize, y: i64) -> bool { e != NIL && self.edges[e].top[1] == y && self.edges[e].next_in_lml == NIL }
    fn is_intermediate(&self, e: usize, y: i64) -> bool { self.edges[e].top[1] == y && self.edges[e].next_in_lml != NIL }
    fn get_maxima_pair(&self, e: usize) -> usize {
        let n = self.edges[e].next;
        let p = self.edges[e].prev;
        if self.edges[n].top == self.edges[e].top && self.edges[n].next_in_lml == NIL { n }
        else if self.edges[p].top == self.edges[e].top && self.edges[p].next_in_lml == NIL { p }
        else { NIL }
    }
    fn get_maxima_pair_ex(&self, e: usize) -> usize {
        let r = self.get_maxima_pair(e);
        if r != NIL && (self.edges[r].out_idx == SKIP || (self.edges[r].next_in_ael == self.edges[r].prev_in_ael && !is_horizontal(&self.edges[r]))) { return NIL; }
        r
    }

    fn swap_positions_in_ael(&mut self, e1: usize, e2: usize) {
        if self.edges[e1].next_in_ael == self.edges[e1].prev_in_ael || self.edges[e2].next_in_ael == self.edges[e2].prev_in_ael { return; }
        if self.edges[e1].next_in_ael == e2 {
            let next = self.edges[e2].next_in_ael;
            if next != NIL { self.edges[next].prev_in_ael = e1; }
            let prev = self.edges[e1].prev_in_ael;
            if prev != NIL { self.edges[prev].next_in_ael = e2; }
            self.edges[e2].prev_in_ael = prev;
            self.edges[e2].next_in_ael = e1;
            self.edges[e1].prev_in_ael = e2;
            self.edges[e1].next_in_ael = next;
        } else if self.edges[e2].next_in_ael == e1 {
            let next = self.edges[e1].next_in_ael;
            if next != NIL { self.edges[next].prev_in_ael = e2; }
            let prev = self.edges[e2].prev_in_ael;
            if prev != NIL { self.edges[prev].next_in_ael = e1; }
            self.edges[e1].prev_in_ael = prev;
            self.edges[e1].next_in_ael = e2;
            self.edges[e2].prev_in_ael = e1;
            self.edges[e2].next_in_ael = next;
        } else {
            let next = self.edges[e1].next_in_ael;
            let prev = self.edges[e1].prev_in_ael;
            self.edges[e1].next_in_ael = self.edges[e2].next_in_ael;
            let n1 = self.edges[e1].next_in_ael;
            if n1 != NIL { self.edges[n1].prev_in_ael = e1; }
            self.edges[e1].prev_in_ael = self.edges[e2].prev_in_ael;
            let p1 = self.edges[e1].prev_in_ael;
            if p1 != NIL { self.edges[p1].next_in_ael = e1; }
            self.edges[e2].next_in_ael = next;
            let n2 = self.edges[e2].next_in_ael;
            if n2 != NIL { self.edges[n2].prev_in_ael = e2; }
            self.edges[e2].prev_in_ael = prev;
            let p2 = self.edges[e2].prev_in_ael;
            if p2 != NIL { self.edges[p2].next_in_ael = e2; }
        }
        if self.edges[e1].prev_in_ael == NIL { self.active = e1; }
        else if self.edges[e2].prev_in_ael == NIL { self.active = e2; }
    }

    fn swap_positions_in_sel(&mut self, e1: usize, e2: usize) {
        if self.edges[e1].next_in_sel == NIL && self.edges[e1].prev_in_sel == NIL { return; }
        if self.edges[e2].next_in_sel == NIL && self.edges[e2].prev_in_sel == NIL { return; }
        if self.edges[e1].next_in_sel == e2 {
            let next = self.edges[e2].next_in_sel;
            if next != NIL { self.edges[next].prev_in_sel = e1; }
            let prev = self.edges[e1].prev_in_sel;
            if prev != NIL { self.edges[prev].next_in_sel = e2; }
            self.edges[e2].prev_in_sel = prev;
            self.edges[e2].next_in_sel = e1;
            self.edges[e1].prev_in_sel = e2;
            self.edges[e1].next_in_sel = next;
        } else if self.edges[e2].next_in_sel == e1 {
            let next = self.edges[e1].next_in_sel;
            if next != NIL { self.edges[next].prev_in_sel = e2; }
            let prev = self.edges[e2].prev_in_sel;
            if prev != NIL { self.edges[prev].next_in_sel = e1; }
            self.edges[e1].prev_in_sel = prev;
            self.edges[e1].next_in_sel = e2;
            self.edges[e2].prev_in_sel = e1;
            self.edges[e2].next_in_sel = next;
        } else {
            let next = self.edges[e1].next_in_sel;
            let prev = self.edges[e1].prev_in_sel;
            self.edges[e1].next_in_sel = self.edges[e2].next_in_sel;
            let n1 = self.edges[e1].next_in_sel;
            if n1 != NIL { self.edges[n1].prev_in_sel = e1; }
            self.edges[e1].prev_in_sel = self.edges[e2].prev_in_sel;
            let p1 = self.edges[e1].prev_in_sel;
            if p1 != NIL { self.edges[p1].next_in_sel = e1; }
            self.edges[e2].next_in_sel = next;
            let n2 = self.edges[e2].next_in_sel;
            if n2 != NIL { self.edges[n2].prev_in_sel = e2; }
            self.edges[e2].prev_in_sel = prev;
            let p2 = self.edges[e2].prev_in_sel;
            if p2 != NIL { self.edges[p2].next_in_sel = e2; }
        }
        if self.edges[e1].prev_in_sel == NIL { self.sorted = e1; }
        else if self.edges[e2].prev_in_sel == NIL { self.sorted = e2; }
    }

    /// (left_to_right, left, right)
    fn get_horz_direction(&self, h: usize) -> (bool, i64, i64) {
        let e = &self.edges[h];
        if e.bot[0] < e.top[0] { (true, e.bot[0], e.top[0]) } else { (false, e.top[0], e.bot[0]) }
    }

    fn update_edge_into_ael(&mut self, e: &mut usize) {
        let lml = self.edges[*e].next_in_lml;
        if lml == NIL { panic!("UpdateEdgeIntoAEL: invalid call"); }
        self.edges[lml].out_idx = self.edges[*e].out_idx;
        let ael_prev = self.edges[*e].prev_in_ael;
        let ael_next = self.edges[*e].next_in_ael;
        if ael_prev != NIL { self.edges[ael_prev].next_in_ael = lml; } else { self.active = lml; }
        if ael_next != NIL { self.edges[ael_next].prev_in_ael = lml; }
        self.edges[lml].side = self.edges[*e].side;
        self.edges[lml].wind_delta = self.edges[*e].wind_delta;
        self.edges[lml].wind_cnt = self.edges[*e].wind_cnt;
        self.edges[lml].wind_cnt2 = self.edges[*e].wind_cnt2;
        *e = lml;
        self.edges[*e].curr = self.edges[*e].bot;
        self.edges[*e].prev_in_ael = ael_prev;
        self.edges[*e].next_in_ael = ael_next;
        if !is_horizontal(&self.edges[*e]) { self.scanbeam.push(self.edges[*e].top[1]); }
    }

    fn process_horizontal(&mut self, start_edge: usize) {
        let mut horz_edge = start_edge;
        let is_open = self.edges[horz_edge].wind_delta == 0;
        let (mut l2r, mut horz_left, mut horz_right) = self.get_horz_direction(horz_edge);
        let mut e_last_horz = horz_edge;
        let mut e_max_pair = NIL;
        while self.edges[e_last_horz].next_in_lml != NIL && is_horizontal(&self.edges[self.edges[e_last_horz].next_in_lml]) { e_last_horz = self.edges[e_last_horz].next_in_lml; }
        if self.edges[e_last_horz].next_in_lml == NIL { e_max_pair = self.get_maxima_pair(e_last_horz); }
        let mut max_it: usize = 0;
        let mut max_rit: isize = -1;
        if !self.maxima.is_empty() {
            if l2r {
                max_it = 0;
                while max_it < self.maxima.len() && self.maxima[max_it] <= self.edges[horz_edge].bot[0] { max_it += 1; }
                if max_it < self.maxima.len() && self.maxima[max_it] >= self.edges[e_last_horz].top[0] { max_it = self.maxima.len(); }
            } else {
                max_rit = self.maxima.len() as isize - 1;
                while max_rit >= 0 && self.maxima[max_rit as usize] > self.edges[horz_edge].bot[0] { max_rit -= 1; }
                if max_rit >= 0 && self.maxima[max_rit as usize] <= self.edges[e_last_horz].top[0] { max_rit = -1; }
            }
        }
        let mut op1 = NIL;
        loop {
            let is_last_horz = horz_edge == e_last_horz;
            let mut e = if l2r { self.edges[horz_edge].next_in_ael } else { self.edges[horz_edge].prev_in_ael };
            while e != NIL {
                if !self.maxima.is_empty() {
                    if l2r {
                        while max_it < self.maxima.len() && self.maxima[max_it] < self.edges[e].curr[0] {
                            if self.edges[horz_edge].out_idx >= 0 && !is_open { let y = self.edges[horz_edge].bot[1]; let x = self.maxima[max_it]; self.add_out_pt(horz_edge, [x, y]); }
                            max_it += 1;
                        }
                    } else {
                        while max_rit >= 0 && self.maxima[max_rit as usize] > self.edges[e].curr[0] {
                            if self.edges[horz_edge].out_idx >= 0 && !is_open { let y = self.edges[horz_edge].bot[1]; let x = self.maxima[max_rit as usize]; self.add_out_pt(horz_edge, [x, y]); }
                            max_rit -= 1;
                        }
                    }
                }
                if (l2r && self.edges[e].curr[0] > horz_right) || (!l2r && self.edges[e].curr[0] < horz_left) { break; }
                if self.edges[e].curr[0] == self.edges[horz_edge].top[0] && self.edges[horz_edge].next_in_lml != NIL && self.edges[e].dx < self.edges[self.edges[horz_edge].next_in_lml].dx { break; }
                if self.edges[horz_edge].out_idx >= 0 && !is_open {
                    op1 = self.add_out_pt(horz_edge, self.edges[e].curr);
                    let mut e_next_horz = self.sorted;
                    while e_next_horz != NIL {
                        if self.edges[e_next_horz].out_idx >= 0 && horz_segments_overlap(self.edges[horz_edge].bot[0], self.edges[horz_edge].top[0], self.edges[e_next_horz].bot[0], self.edges[e_next_horz].top[0]) {
                            let op2 = self.get_last_out_pt(e_next_horz);
                            self.joins.push(Join { op1: op2, op2: op1, off_pt: self.edges[e_next_horz].top });
                        }
                        e_next_horz = self.edges[e_next_horz].next_in_sel;
                    }
                    self.ghost_joins.push(Join { op1, op2: NIL, off_pt: self.edges[horz_edge].bot });
                }
                if e == e_max_pair && is_last_horz {
                    if self.edges[horz_edge].out_idx >= 0 { self.add_local_max_poly(horz_edge, e_max_pair, self.edges[horz_edge].top); }
                    self.delete_from_ael(horz_edge);
                    self.delete_from_ael(e_max_pair);
                    return;
                }
                if l2r {
                    let mut pt = [self.edges[e].curr[0], self.edges[horz_edge].curr[1]];
                    self.intersect_edges(horz_edge, e, &mut pt);
                } else {
                    let mut pt = [self.edges[e].curr[0], self.edges[horz_edge].curr[1]];
                    self.intersect_edges(e, horz_edge, &mut pt);
                }
                let e_next = if l2r { self.edges[e].next_in_ael } else { self.edges[e].prev_in_ael };
                self.swap_positions_in_ael(horz_edge, e);
                e = e_next;
            }
            let hn = self.edges[horz_edge].next_in_lml;
            if hn == NIL || !is_horizontal(&self.edges[hn]) { break; }
            self.update_edge_into_ael(&mut horz_edge);
            if self.edges[horz_edge].out_idx >= 0 { self.add_out_pt(horz_edge, self.edges[horz_edge].bot); }
            let (a, b, c) = self.get_horz_direction(horz_edge);
            l2r = a; horz_left = b; horz_right = c;
        }
        if self.edges[horz_edge].out_idx >= 0 && op1 == NIL {
            op1 = self.get_last_out_pt(horz_edge);
            let mut e_next_horz = self.sorted;
            while e_next_horz != NIL {
                if self.edges[e_next_horz].out_idx >= 0 && horz_segments_overlap(self.edges[horz_edge].bot[0], self.edges[horz_edge].top[0], self.edges[e_next_horz].bot[0], self.edges[e_next_horz].top[0]) {
                    let op2 = self.get_last_out_pt(e_next_horz);
                    self.joins.push(Join { op1: op2, op2: op1, off_pt: self.edges[e_next_horz].top });
                }
                e_next_horz = self.edges[e_next_horz].next_in_sel;
            }
            self.ghost_joins.push(Join { op1, op2: NIL, off_pt: self.edges[horz_edge].top });
        }
        if self.edges[horz_edge].next_in_lml != NIL {
            if self.edges[horz_edge].out_idx >= 0 {
                op1 = self.add_out_pt(horz_edge, self.edges[horz_edge].top);
                self.update_edge_into_ael(&mut horz_edge);
                if self.edges[horz_edge].wind_delta == 0 { return; }
                let e_prev = self.edges[horz_edge].prev_in_ael;
                let e_next = self.edges[horz_edge].next_in_ael;
                let hb = self.edges[horz_edge].bot;
                if e_prev != NIL && self.edges[e_prev].curr[0] == hb[0] && self.edges[e_prev].curr[1] == hb[1] && self.edges[e_prev].wind_delta != 0
                    && (self.edges[e_prev].out_idx >= 0 && self.edges[e_prev].curr[1] > self.edges[e_prev].top[1]
                        && slopes_equal_pts4(self.edges[horz_edge].top, self.edges[horz_edge].bot, self.edges[e_prev].top, self.edges[e_prev].bot)) {
                    let op2 = self.add_out_pt(e_prev, hb);
                    self.joins.push(Join { op1, op2, off_pt: self.edges[horz_edge].top });
                } else if e_next != NIL && self.edges[e_next].curr[0] == hb[0] && self.edges[e_next].curr[1] == hb[1] && self.edges[e_next].wind_delta != 0
                    && self.edges[e_next].out_idx >= 0 && self.edges[e_next].curr[1] > self.edges[e_next].top[1]
                    && slopes_equal_pts4(self.edges[horz_edge].top, self.edges[horz_edge].bot, self.edges[e_next].top, self.edges[e_next].bot) {
                    let op2 = self.add_out_pt(e_next, hb);
                    self.joins.push(Join { op1, op2, off_pt: self.edges[horz_edge].top });
                }
            } else {
                self.update_edge_into_ael(&mut horz_edge);
            }
        } else {
            if self.edges[horz_edge].out_idx >= 0 { self.add_out_pt(horz_edge, self.edges[horz_edge].top); }
            self.delete_from_ael(horz_edge);
        }
    }

    fn process_intersections(&mut self, top_y: i64) -> bool {
        if self.active == NIL { return true; }
        self.build_intersect_list(top_y);
        let il = self.intersect_list.len();
        if il == 0 { return true; }
        if il == 1 || self.fixup_intersection_order() {
            for i in 0..self.intersect_list.len() {
                let n = self.intersect_list[i];
                let mut pt = n.pt;
                self.intersect_edges(n.e1, n.e2, &mut pt);
                self.swap_positions_in_ael(n.e1, n.e2);
            }
            self.intersect_list.clear();
        } else {
            return false;
        }
        self.sorted = NIL;
        true
    }

    fn build_intersect_list(&mut self, top_y: i64) {
        if self.active == NIL { return; }
        let mut e = self.active;
        self.sorted = e;
        while e != NIL {
            self.edges[e].prev_in_sel = self.edges[e].prev_in_ael;
            self.edges[e].next_in_sel = self.edges[e].next_in_ael;
            let x = top_x(&self.edges[e], top_y);
            self.edges[e].curr[0] = x;
            e = self.edges[e].next_in_ael;
        }
        loop {
            let mut is_modified = false;
            e = self.sorted;
            while self.edges[e].next_in_sel != NIL {
                let e_next = self.edges[e].next_in_sel;
                if self.edges[e].curr[0] > self.edges[e_next].curr[0] {
                    let mut pt = intersect_point(&self.edges[e], &self.edges[e_next]);
                    if pt[1] < top_y { pt = [top_x(&self.edges[e], top_y), top_y]; }
                    self.intersect_list.push(IntersectNode { e1: e, e2: e_next, pt });
                    self.swap_positions_in_sel(e, e_next);
                    is_modified = true;
                } else {
                    e = e_next;
                }
            }
            let p = self.edges[e].prev_in_sel;
            if p != NIL { self.edges[p].next_in_sel = NIL; } else { break; }
            if !is_modified { break; }
        }
        self.sorted = NIL;
    }

    fn edges_adjacent(&self, n: &IntersectNode) -> bool {
        self.edges[n.e1].next_in_sel == n.e2 || self.edges[n.e1].prev_in_sel == n.e2
    }

    fn fixup_intersection_order(&mut self) -> bool {
        self.copy_ael_to_sel();
        std_sort(&mut self.intersect_list, |a, b| b.pt[1] < a.pt[1]);
        let cnt = self.intersect_list.len();
        for i in 0..cnt {
            if !self.edges_adjacent(&self.intersect_list[i]) {
                let mut j = i + 1;
                while j < cnt && !self.edges_adjacent(&self.intersect_list[j]) { j += 1; }
                if j == cnt { return false; }
                self.intersect_list.swap(i, j);
            }
            let n = self.intersect_list[i];
            self.swap_positions_in_sel(n.e1, n.e2);
        }
        true
    }

    fn do_maxima(&mut self, e: usize) {
        let e_max_pair = self.get_maxima_pair_ex(e);
        if e_max_pair == NIL {
            if self.edges[e].out_idx >= 0 { self.add_out_pt(e, self.edges[e].top); }
            self.delete_from_ael(e);
            return;
        }
        let mut e_next = self.edges[e].next_in_ael;
        while e_next != NIL && e_next != e_max_pair {
            let mut t = self.edges[e].top;
            self.intersect_edges(e, e_next, &mut t);
            self.swap_positions_in_ael(e, e_next);
            e_next = self.edges[e].next_in_ael;
        }
        if self.edges[e].out_idx == UNASSIGNED && self.edges[e_max_pair].out_idx == UNASSIGNED {
            self.delete_from_ael(e);
            self.delete_from_ael(e_max_pair);
        } else if self.edges[e].out_idx >= 0 && self.edges[e_max_pair].out_idx >= 0 {
            if self.edges[e].out_idx >= 0 { self.add_local_max_poly(e, e_max_pair, self.edges[e].top); }
            self.delete_from_ael(e);
            self.delete_from_ael(e_max_pair);
        } else if self.edges[e].wind_delta == 0 {
            if self.edges[e].out_idx >= 0 {
                self.add_out_pt(e, self.edges[e].top);
                self.edges[e].out_idx = UNASSIGNED;
            }
            self.delete_from_ael(e);
            if self.edges[e_max_pair].out_idx >= 0 {
                self.add_out_pt(e_max_pair, self.edges[e].top);
                self.edges[e_max_pair].out_idx = UNASSIGNED;
            }
            self.delete_from_ael(e_max_pair);
        } else {
            panic!("DoMaxima error");
        }
    }

    fn process_edges_at_top_of_scanbeam(&mut self, top_y: i64) {
        let mut e = self.active;
        while e != NIL {
            let mut is_maxima_edge = self.is_maxima(e, top_y);
            if is_maxima_edge {
                let e_max_pair = self.get_maxima_pair_ex(e);
                is_maxima_edge = e_max_pair == NIL || !is_horizontal(&self.edges[e_max_pair]);
            }
            if is_maxima_edge {
                if self.strict_simple { self.maxima.push(self.edges[e].top[0]); }
                let e_prev = self.edges[e].prev_in_ael;
                self.do_maxima(e);
                e = if e_prev == NIL { self.active } else { self.edges[e_prev].next_in_ael };
            } else {
                if self.is_intermediate(e, top_y) && is_horizontal(&self.edges[self.edges[e].next_in_lml]) {
                    self.update_edge_into_ael(&mut e);
                    if self.edges[e].out_idx >= 0 { self.add_out_pt(e, self.edges[e].bot); }
                    self.add_edge_to_sel(e);
                } else {
                    let x = top_x(&self.edges[e], top_y);
                    self.edges[e].curr[0] = x;
                    self.edges[e].curr[1] = top_y;
                }
                if self.strict_simple {
                    let e_prev = self.edges[e].prev_in_ael;
                    if self.edges[e].out_idx >= 0 && self.edges[e].wind_delta != 0 && e_prev != NIL && self.edges[e_prev].out_idx >= 0
                        && self.edges[e_prev].curr[0] == self.edges[e].curr[0] && self.edges[e_prev].wind_delta != 0 {
                        let pt = self.edges[e].curr;
                        let op = self.add_out_pt(e_prev, pt);
                        let op2 = self.add_out_pt(e, pt);
                        self.joins.push(Join { op1: op, op2, off_pt: pt });
                    }
                }
                e = self.edges[e].next_in_ael;
            }
        }
        self.maxima.sort();
        self.process_horizontals();
        self.maxima.clear();
        e = self.active;
        while e != NIL {
            if self.is_intermediate(e, top_y) {
                let mut op = NIL;
                if self.edges[e].out_idx >= 0 { op = self.add_out_pt(e, self.edges[e].top); }
                self.update_edge_into_ael(&mut e);
                let e_prev = self.edges[e].prev_in_ael;
                let e_next = self.edges[e].next_in_ael;
                let eb = self.edges[e].bot;
                if e_prev != NIL && self.edges[e_prev].curr[0] == eb[0] && self.edges[e_prev].curr[1] == eb[1] && op != NIL
                    && self.edges[e_prev].out_idx >= 0 && self.edges[e_prev].curr[1] > self.edges[e_prev].top[1]
                    && slopes_equal_pts4(self.edges[e].curr, self.edges[e].top, self.edges[e_prev].curr, self.edges[e_prev].top)
                    && self.edges[e].wind_delta != 0 && self.edges[e_prev].wind_delta != 0 {
                    let op2 = self.add_out_pt(e_prev, eb);
                    self.joins.push(Join { op1: op, op2, off_pt: self.edges[e].top });
                } else if e_next != NIL && self.edges[e_next].curr[0] == eb[0] && self.edges[e_next].curr[1] == eb[1] && op != NIL
                    && self.edges[e_next].out_idx >= 0 && self.edges[e_next].curr[1] > self.edges[e_next].top[1]
                    && slopes_equal_pts4(self.edges[e].curr, self.edges[e].top, self.edges[e_next].curr, self.edges[e_next].top)
                    && self.edges[e].wind_delta != 0 && self.edges[e_next].wind_delta != 0 {
                    let op2 = self.add_out_pt(e_next, eb);
                    self.joins.push(Join { op1: op, op2, off_pt: self.edges[e].top });
                }
            }
            e = self.edges[e].next_in_ael;
        }
    }

    fn fixup_out_polyline(&mut self, r: usize) {
        let mut pp = self.outs[r].pts;
        let mut last_pp = self.pts[pp].prev;
        while pp != last_pp {
            pp = self.pts[pp].next;
            if self.pts[pp].pt == self.pts[self.pts[pp].prev].pt {
                if pp == last_pp { last_pp = self.pts[pp].prev; }
                let tmp = self.pts[pp].prev;
                let nx = self.pts[pp].next;
                self.pts[tmp].next = nx;
                self.pts[nx].prev = tmp;
                pp = tmp;
            }
        }
        if pp == self.pts[pp].prev { self.outs[r].pts = NIL; }
    }

    fn fixup_out_polygon(&mut self, r: usize) {
        let mut last_ok = NIL;
        self.outs[r].bottom_pt = NIL;
        let mut pp = self.outs[r].pts;
        let preserve_col = self.preserve_collinear || self.strict_simple;
        loop {
            let (ppp, ppn) = (self.pts[pp].prev, self.pts[pp].next);
            if ppp == pp || ppp == ppn {
                self.outs[r].pts = NIL;
                return;
            }
            if self.pts[pp].pt == self.pts[ppn].pt || self.pts[pp].pt == self.pts[ppp].pt
                || (slopes_equal3(self.pts[ppp].pt, self.pts[pp].pt, self.pts[ppn].pt)
                    && (!preserve_col || !pt2_is_between(self.pts[ppp].pt, self.pts[pp].pt, self.pts[ppn].pt))) {
                last_ok = NIL;
                self.pts[ppp].next = ppn;
                self.pts[ppn].prev = ppp;
                pp = ppp;
            } else if pp == last_ok { break; }
            else {
                if last_ok == NIL { last_ok = pp; }
                pp = ppn;
            }
        }
        self.outs[r].pts = pp;
    }

    fn point_count(&self, pts: usize) -> usize {
        if pts == NIL { return 0; }
        let mut result = 0;
        let mut p = pts;
        loop {
            result += 1;
            p = self.pts[p].next;
            if p == pts { break; }
        }
        result
    }

    fn build_result(&self) -> Vec<Vec<IP>> {
        let mut polys = Vec::new();
        for r in &self.outs {
            if r.pts == NIL { continue; }
            let mut p = self.pts[r.pts].prev;
            let cnt = self.point_count(p);
            if cnt < 2 { continue; }
            let mut pg = Vec::with_capacity(cnt);
            for _ in 0..cnt {
                pg.push(self.pts[p].pt);
                p = self.pts[p].prev;
            }
            polys.push(pg);
        }
        polys
    }

    fn build_result2(&mut self, tree: &mut PolyTree) {
        *tree = PolyTree::new();
        for ri in 0..self.outs.len() {
            let cnt = self.point_count(self.outs[ri].pts);
            if (self.outs[ri].is_open && cnt < 2) || (!self.outs[ri].is_open && cnt < 3) { continue; }
            let fl = self.outs[ri].first_left;
            if fl != NIL && (self.outs[ri].is_hole == self.outs[fl].is_hole || self.outs[fl].pts == NIL) {
                let mut orfl = fl;
                while orfl != NIL && (self.outs[orfl].is_hole == self.outs[ri].is_hole || self.outs[orfl].pts == NIL) { orfl = self.outs[orfl].first_left; }
                self.outs[ri].first_left = orfl;
            }
            let mut node = PolyNode::new();
            let mut op = self.pts[self.outs[ri].pts].prev;
            for _ in 0..cnt {
                node.contour.push(self.pts[op].pt);
                op = self.pts[op].prev;
            }
            tree.nodes.push(node);
            self.outs[ri].poly_nd = tree.nodes.len() - 1;
        }
        for ri in 0..self.outs.len() {
            let nd = self.outs[ri].poly_nd;
            if nd == NIL { continue; }
            if self.outs[ri].is_open {
                tree.nodes[nd].is_open = true;
                tree.add_child(0, nd);
            } else if self.outs[ri].first_left != NIL && self.outs[self.outs[ri].first_left].poly_nd != NIL {
                let parent = self.outs[self.outs[ri].first_left].poly_nd;
                tree.add_child(parent, nd);
            } else {
                tree.add_child(0, nd);
            }
        }
    }

    // ---- joins ------------------------------------------------------------------------------------------------------
    fn dup_out_pt(&mut self, out_pt: usize, insert_after: bool) -> usize {
        let result = self.pts.len();
        let (pt, idx) = (self.pts[out_pt].pt, self.pts[out_pt].idx);
        if insert_after {
            let nx = self.pts[out_pt].next;
            self.pts.push(OutPt { idx, pt, next: nx, prev: out_pt });
            self.pts[nx].prev = result;
            self.pts[out_pt].next = result;
        } else {
            let pv = self.pts[out_pt].prev;
            self.pts.push(OutPt { idx, pt, next: out_pt, prev: pv });
            self.pts[pv].next = result;
            self.pts[out_pt].prev = result;
        }
        result
    }

    fn join_horz(&mut self, mut op1: usize, mut op1b: usize, mut op2: usize, mut op2b: usize, pt: IP, discard_left: bool) -> bool {
        let dir1_l2r = !(self.pts[op1].pt[0] > self.pts[op1b].pt[0]);
        let dir2_l2r = !(self.pts[op2].pt[0] > self.pts[op2b].pt[0]);
        if dir1_l2r == dir2_l2r { return false; }
        if dir1_l2r {
            while self.pts[self.pts[op1].next].pt[0] <= pt[0] && self.pts[self.pts[op1].next].pt[0] >= self.pts[op1].pt[0] && self.pts[self.pts[op1].next].pt[1] == pt[1] { op1 = self.pts[op1].next; }
            if discard_left && self.pts[op1].pt[0] != pt[0] { op1 = self.pts[op1].next; }
            op1b = self.dup_out_pt(op1, !discard_left);
            if self.pts[op1b].pt != pt {
                op1 = op1b;
                self.pts[op1].pt = pt;
                op1b = self.dup_out_pt(op1, !discard_left);
            }
        } else {
            while self.pts[self.pts[op1].next].pt[0] >= pt[0] && self.pts[self.pts[op1].next].pt[0] <= self.pts[op1].pt[0] && self.pts[self.pts[op1].next].pt[1] == pt[1] { op1 = self.pts[op1].next; }
            if !discard_left && self.pts[op1].pt[0] != pt[0] { op1 = self.pts[op1].next; }
            op1b = self.dup_out_pt(op1, discard_left);
            if self.pts[op1b].pt != pt {
                op1 = op1b;
                self.pts[op1].pt = pt;
                op1b = self.dup_out_pt(op1, discard_left);
            }
        }
        if dir2_l2r {
            while self.pts[self.pts[op2].next].pt[0] <= pt[0] && self.pts[self.pts[op2].next].pt[0] >= self.pts[op2].pt[0] && self.pts[self.pts[op2].next].pt[1] == pt[1] { op2 = self.pts[op2].next; }
            if discard_left && self.pts[op2].pt[0] != pt[0] { op2 = self.pts[op2].next; }
            op2b = self.dup_out_pt(op2, !discard_left);
            if self.pts[op2b].pt != pt {
                op2 = op2b;
                self.pts[op2].pt = pt;
                op2b = self.dup_out_pt(op2, !discard_left);
            }
        } else {
            while self.pts[self.pts[op2].next].pt[0] >= pt[0] && self.pts[self.pts[op2].next].pt[0] <= self.pts[op2].pt[0] && self.pts[self.pts[op2].next].pt[1] == pt[1] { op2 = self.pts[op2].next; }
            if !discard_left && self.pts[op2].pt[0] != pt[0] { op2 = self.pts[op2].next; }
            op2b = self.dup_out_pt(op2, discard_left);
            if self.pts[op2b].pt != pt {
                op2 = op2b;
                self.pts[op2].pt = pt;
                op2b = self.dup_out_pt(op2, discard_left);
            }
        }
        if dir1_l2r == discard_left {
            self.pts[op1].prev = op2;
            self.pts[op2].next = op1;
            self.pts[op1b].next = op2b;
            self.pts[op2b].prev = op1b;
        } else {
            self.pts[op1].next = op2;
            self.pts[op2].prev = op1;
            self.pts[op1b].prev = op2b;
            self.pts[op2b].next = op1b;
        }
        true
    }

    fn get_overlap(a1: i64, a2: i64, b1: i64, b2: i64) -> Option<(i64, i64)> {
        let (left, right);
        if a1 < a2 {
            if b1 < b2 { left = a1.max(b1); right = a2.min(b2); } else { left = a1.max(b2); right = a2.min(b1); }
        } else if b1 < b2 { left = a2.max(b1); right = a1.min(b2); } else { left = a2.max(b2); right = a1.min(b1); }
        if left < right { Some((left, right)) } else { None }
    }

    fn join_points(&mut self, ji: usize, out_rec1: usize, out_rec2: usize) -> bool {
        let j = self.joins[ji];
        let mut op1 = j.op1;
        let mut op2 = j.op2;
        let mut op1b;
        let mut op2b;
        let is_horiz = self.pts[j.op1].pt[1] == j.off_pt[1];
        if is_horiz && j.off_pt == self.pts[j.op1].pt && j.off_pt == self.pts[j.op2].pt {
            if out_rec1 != out_rec2 { return false; }
            op1b = self.pts[j.op1].next;
            while op1b != op1 && self.pts[op1b].pt == j.off_pt { op1b = self.pts[op1b].next; }
            let reverse1 = self.pts[op1b].pt[1] > j.off_pt[1];
            op2b = self.pts[j.op2].next;
            while op2b != op2 && self.pts[op2b].pt == j.off_pt { op2b = self.pts[op2b].next; }
            let reverse2 = self.pts[op2b].pt[1] > j.off_pt[1];
            if reverse1 == reverse2 { return false; }
            if reverse1 {
                op1b = self.dup_out_pt(op1, false);
                op2b = self.dup_out_pt(op2, true);
                self.pts[op1].prev = op2;
                self.pts[op2].next = op1;
                self.pts[op1b].next = op2b;
                self.pts[op2b].prev = op1b;
                self.joins[ji].op1 = op1;
                self.joins[ji].op2 = op1b;
                return true;
            } else {
                op1b = self.dup_out_pt(op1, true);
                op2b = self.dup_out_pt(op2, false);
                self.pts[op1].next = op2;
                self.pts[op2].prev = op1;
                self.pts[op1b].prev = op2b;
                self.pts[op2b].next = op1b;
                self.joins[ji].op1 = op1;
                self.joins[ji].op2 = op1b;
                return true;
            }
        } else if is_horiz {
            op1b = op1;
            while self.pts[self.pts[op1].prev].pt[1] == self.pts[op1].pt[1] && self.pts[op1].prev != op1b && self.pts[op1].prev != op2 { op1 = self.pts[op1].prev; }
            while self.pts[self.pts[op1b].next].pt[1] == self.pts[op1b].pt[1] && self.pts[op1b].next != op1 && self.pts[op1b].next != op2 { op1b = self.pts[op1b].next; }
            if self.pts[op1b].next == op1 || self.pts[op1b].next == op2 { return false; }
            op2b = op2;
            while self.pts[self.pts[op2].prev].pt[1] == self.pts[op2].pt[1] && self.pts[op2].prev != op2b && self.pts[op2].prev != op1b { op2 = self.pts[op2].prev; }
            while self.pts[self.pts[op2b].next].pt[1] == self.pts[op2b].pt[1] && self.pts[op2b].next != op2 && self.pts[op2b].next != op1 { op2b = self.pts[op2b].next; }
            if self.pts[op2b].next == op2 || self.pts[op2b].next == op1 { return false; }
            let Some((left, right)) = Self::get_overlap(self.pts[op1].pt[0], self.pts[op1b].pt[0], self.pts[op2].pt[0], self.pts[op2b].pt[0]) else { return false };
            let (pt, discard_left_side);
            if self.pts[op1].pt[0] >= left && self.pts[op1].pt[0] <= right {
                pt = self.pts[op1].pt; discard_left_side = self.pts[op1].pt[0] > self.pts[op1b].pt[0];
            } else if self.pts[op2].pt[0] >= left && self.pts[op2].pt[0] <= right {
                pt = self.pts[op2].pt; discard_left_side = self.pts[op2].pt[0] > self.pts[op2b].pt[0];
            } else if self.pts[op1b].pt[0] >= left && self.pts[op1b].pt[0] <= right {
                pt = self.pts[op1b].pt; discard_left_side = self.pts[op1b].pt[0] > self.pts[op1].pt[0];
            } else {
                pt = self.pts[op2b].pt; discard_left_side = self.pts[op2b].pt[0] > self.pts[op2].pt[0];
            }
            self.joins[ji].op1 = op1;
            self.joins[ji].op2 = op2;
            return self.join_horz(op1, op1b, op2, op2b, pt, discard_left_side);
        } else {
            op1b = self.pts[op1].next;
            while self.pts[op1b].pt == self.pts[op1].pt && op1b != op1 { op1b = self.pts[op1b].next; }
            let reverse1 = self.pts[op1b].pt[1] > self.pts[op1].pt[1] || !slopes_equal3(self.pts[op1].pt, self.pts[op1b].pt, j.off_pt);
            if reverse1 {
                op1b = self.pts[op1].prev;
                while self.pts[op1b].pt == self.pts[op1].pt && op1b != op1 { op1b = self.pts[op1b].prev; }
                if self.pts[op1b].pt[1] > self.pts[op1].pt[1] || !slopes_equal3(self.pts[op1].pt, self.pts[op1b].pt, j.off_pt) { return false; }
            }
            op2b = self.pts[op2].next;
            while self.pts[op2b].pt == self.pts[op2].pt && op2b != op2 { op2b = self.pts[op2b].next; }
            let reverse2 = self.pts[op2b].pt[1] > self.pts[op2].pt[1] || !slopes_equal3(self.pts[op2].pt, self.pts[op2b].pt, j.off_pt);
            if reverse2 {
                op2b = self.pts[op2].prev;
                while self.pts[op2b].pt == self.pts[op2].pt && op2b != op2 { op2b = self.pts[op2b].prev; }
                if self.pts[op2b].pt[1] > self.pts[op2].pt[1] || !slopes_equal3(self.pts[op2].pt, self.pts[op2b].pt, j.off_pt) { return false; }
            }
            if op1b == op1 || op2b == op2 || op1b == op2b || (out_rec1 == out_rec2 && reverse1 == reverse2) { return false; }
            if reverse1 {
                op1b = self.dup_out_pt(op1, false);
                op2b = self.dup_out_pt(op2, true);
                self.pts[op1].prev = op2;
                self.pts[op2].next = op1;
                self.pts[op1b].next = op2b;
                self.pts[op2b].prev = op1b;
                self.joins[ji].op1 = op1;
                self.joins[ji].op2 = op1b;
                return true;
            } else {
                op1b = self.dup_out_pt(op1, true);
                op2b = self.dup_out_pt(op2, false);
                self.pts[op1].next = op2;
                self.pts[op2].prev = op1;
                self.pts[op1b].prev = op2b;
                self.pts[op2b].next = op1b;
                self.joins[ji].op1 = op1;
                self.joins[ji].op2 = op1b;
                return true;
            }
        }
    }

    fn point_in_polygon_op(&self, pt: IP, start: usize) -> i32 {
        let mut result = 0;
        let mut op = start;
        loop {
            let nx = self.pts[op].next;
            let (p, n) = (self.pts[op].pt, self.pts[nx].pt);
            if n[1] == pt[1] && (n[0] == pt[0] || (p[1] == pt[1] && ((n[0] > pt[0]) == (p[0] < pt[0])))) { return -1; }
            if (p[1] < pt[1]) != (n[1] < pt[1]) {
                if p[0] >= pt[0] {
                    if n[0] > pt[0] { result = 1 - result; }
                    else {
                        let d = point_in_polygon_cross(p, n, pt);
                        if d == 0.0 { return -1; }
                        if (d > 0.0) == (n[1] > p[1]) { result = 1 - result; }
                    }
                } else if n[0] > pt[0] {
                    let d = point_in_polygon_cross(p, n, pt);
                    if d == 0.0 { return -1; }
                    if (d > 0.0) == (n[1] > p[1]) { result = 1 - result; }
                }
            }
            op = nx;
            if op == start { break; }
        }
        result
    }

    fn poly2_contains_poly1(&self, out_pt1: usize, out_pt2: usize) -> bool {
        let mut op = out_pt1;
        loop {
            let res = self.point_in_polygon_op(self.pts[op].pt, out_pt2);
            if res >= 0 { return res > 0; }
            op = self.pts[op].next;
            if op == out_pt1 { break; }
        }
        true
    }

    fn parse_first_left(&self, mut fl: usize) -> usize {
        while fl != NIL && self.outs[fl].pts == NIL { fl = self.outs[fl].first_left; }
        fl
    }
    fn fixup_first_lefts1(&mut self, old: usize, new: usize) {
        for i in 0..self.outs.len() {
            let fl = self.parse_first_left(self.outs[i].first_left);
            if self.outs[i].pts != NIL && fl == old && self.poly2_contains_poly1(self.outs[i].pts, self.outs[new].pts) { self.outs[i].first_left = new; }
        }
    }
    fn fixup_first_lefts2(&mut self, inner: usize, outer: usize) {
        let orfl = self.outs[outer].first_left;
        for i in 0..self.outs.len() {
            if self.outs[i].pts == NIL || i == outer || i == inner { continue; }
            let fl = self.parse_first_left(self.outs[i].first_left);
            if fl != orfl && fl != inner && fl != outer { continue; }
            if self.poly2_contains_poly1(self.outs[i].pts, self.outs[inner].pts) { self.outs[i].first_left = inner; }
            else if self.poly2_contains_poly1(self.outs[i].pts, self.outs[outer].pts) { self.outs[i].first_left = outer; }
            else if self.outs[i].first_left == inner || self.outs[i].first_left == outer { self.outs[i].first_left = orfl; }
        }
    }
    fn fixup_first_lefts3(&mut self, old: usize, new: usize) {
        for i in 0..self.outs.len() {
            let fl = self.parse_first_left(self.outs[i].first_left);
            if self.outs[i].pts != NIL && fl == old { self.outs[i].first_left = new; }
        }
    }

    fn update_out_pt_idxs(&mut self, r: usize) {
        let start = self.outs[r].pts;
        let idx = self.outs[r].idx;
        let mut op = start;
        loop {
            self.pts[op].idx = idx;
            op = self.pts[op].prev;
            if op == start { break; }
        }
    }

    fn join_common_edges(&mut self) {
        let mut ji = 0;
        while ji < self.joins.len() {
            let join = self.joins[ji];
            let mut out_rec1 = self.get_out_rec(self.pts[join.op1].idx);
            let mut out_rec2 = self.get_out_rec(self.pts[join.op2].idx);
            ji += 1;
            let jidx = ji - 1;
            if self.outs[out_rec1].pts == NIL || self.outs[out_rec2].pts == NIL { continue; }
            if self.outs[out_rec1].is_open || self.outs[out_rec2].is_open { continue; }
            let hole_state_rec;
            if out_rec1 == out_rec2 { hole_state_rec = out_rec1; }
            else if self.outrec1_right_of_outrec2(out_rec1, out_rec2) { hole_state_rec = out_rec2; }
            else if self.outrec1_right_of_outrec2(out_rec2, out_rec1) { hole_state_rec = out_rec1; }
            else { hole_state_rec = self.get_lowermost_rec(out_rec1, out_rec2); }
            if !self.join_points(jidx, out_rec1, out_rec2) { continue; }
            let join = self.joins[jidx];
            if out_rec1 == out_rec2 {
                self.outs[out_rec1].pts = join.op1;
                self.outs[out_rec1].bottom_pt = NIL;
                out_rec2 = self.create_out_rec();
                self.outs[out_rec2].pts = join.op2;
                self.update_out_pt_idxs(out_rec2);
                if self.poly2_contains_poly1(self.outs[out_rec2].pts, self.outs[out_rec1].pts) {
                    self.outs[out_rec2].is_hole = !self.outs[out_rec1].is_hole;
                    self.outs[out_rec2].first_left = out_rec1;
                    if self.using_polytree { self.fixup_first_lefts2(out_rec2, out_rec1); }
                    if (self.outs[out_rec2].is_hole ^ self.reverse_output) == (self.area_op(self.outs[out_rec2].pts) > 0.0) { let p = self.outs[out_rec2].pts; self.reverse_poly_pt_links(p); }
                } else if self.poly2_contains_poly1(self.outs[out_rec1].pts, self.outs[out_rec2].pts) {
                    self.outs[out_rec2].is_hole = self.outs[out_rec1].is_hole;
                    self.outs[out_rec1].is_hole = !self.outs[out_rec2].is_hole;
                    self.outs[out_rec2].first_left = self.outs[out_rec1].first_left;
                    self.outs[out_rec1].first_left = out_rec2;
                    if self.using_polytree { self.fixup_first_lefts2(out_rec1, out_rec2); }
                    if (self.outs[out_rec1].is_hole ^ self.reverse_output) == (self.area_op(self.outs[out_rec1].pts) > 0.0) { let p = self.outs[out_rec1].pts; self.reverse_poly_pt_links(p); }
                } else {
                    self.outs[out_rec2].is_hole = self.outs[out_rec1].is_hole;
                    self.outs[out_rec2].first_left = self.outs[out_rec1].first_left;
                    if self.using_polytree { self.fixup_first_lefts1(out_rec1, out_rec2); }
                }
            } else {
                self.outs[out_rec2].pts = NIL;
                self.outs[out_rec2].bottom_pt = NIL;
                self.outs[out_rec2].idx = self.outs[out_rec1].idx;
                self.outs[out_rec1].is_hole = self.outs[hole_state_rec].is_hole;
                if hole_state_rec == out_rec2 { self.outs[out_rec1].first_left = self.outs[out_rec2].first_left; }
                self.outs[out_rec2].first_left = out_rec1;
                if self.using_polytree { self.fixup_first_lefts3(out_rec2, out_rec1); }
            }
        }
    }

    fn do_simple_polygons(&mut self) {
        let mut i = 0;
        while i < self.outs.len() {
            let r = i;
            i += 1;
            let mut op = self.outs[r].pts;
            if op == NIL || self.outs[r].is_open { continue; }
            loop {
                let mut op2 = self.pts[op].next;
                while op2 != self.outs[r].pts {
                    if self.pts[op].pt == self.pts[op2].pt && self.pts[op2].next != op && self.pts[op2].prev != op {
                        let op3 = self.pts[op].prev;
                        let op4 = self.pts[op2].prev;
                        self.pts[op].prev = op4;
                        self.pts[op4].next = op;
                        self.pts[op2].prev = op3;
                        self.pts[op3].next = op2;
                        self.outs[r].pts = op;
                        let r2 = self.create_out_rec();
                        self.outs[r2].pts = op2;
                        self.update_out_pt_idxs(r2);
                        if self.poly2_contains_poly1(self.outs[r2].pts, self.outs[r].pts) {
                            self.outs[r2].is_hole = !self.outs[r].is_hole;
                            self.outs[r2].first_left = r;
                            if self.using_polytree { self.fixup_first_lefts2(r2, r); }
                        } else if self.poly2_contains_poly1(self.outs[r].pts, self.outs[r2].pts) {
                            self.outs[r2].is_hole = self.outs[r].is_hole;
                            self.outs[r].is_hole = !self.outs[r2].is_hole;
                            self.outs[r2].first_left = self.outs[r].first_left;
                            self.outs[r].first_left = r2;
                            if self.using_polytree { self.fixup_first_lefts2(r, r2); }
                        } else {
                            self.outs[r2].is_hole = self.outs[r].is_hole;
                            self.outs[r2].first_left = self.outs[r].first_left;
                            if self.using_polytree { self.fixup_first_lefts1(r, r2); }
                        }
                        op2 = op;
                    }
                    op2 = self.pts[op2].next;
                }
                op = self.pts[op].next;
                if op == self.outs[r].pts { break; }
            }
        }
    }

    // ---- Execute ----------------------------------------------------------------------------------------------------
    fn reset(&mut self) {
        self.base_reset();
        self.scanbeam.clear();
        self.maxima.clear();
        self.active = NIL;
        self.sorted = NIL;
        for lm in self.minima.iter().rev() { self.scanbeam.push(lm.y); }
    }

    fn execute_internal(&mut self) -> bool {
        self.reset();
        if self.minima.is_empty() { return true; }
        let mut succeeded = true;
        let mut bot_y = *self.scanbeam.peek().unwrap();
        loop { self.scanbeam.pop(); if self.scanbeam.peek() != Some(&bot_y) { break; } }
        loop {
            self.insert_local_minima_into_ael(bot_y);
            self.process_horizontals();
            self.ghost_joins.clear();
            if self.scanbeam.is_empty() { break; }
            let top_y = *self.scanbeam.peek().unwrap();
            loop { self.scanbeam.pop(); if self.scanbeam.peek() != Some(&top_y) { break; } }
            succeeded = self.process_intersections(top_y);
            if !succeeded { break; }
            self.process_edges_at_top_of_scanbeam(top_y);
            bot_y = top_y;
            if self.scanbeam.is_empty() && self.minima.is_empty() { break; }
        }
        if succeeded {
            for i in 0..self.outs.len() {
                if self.outs[i].pts != NIL && !self.outs[i].is_open && (self.outs[i].is_hole ^ self.reverse_output) == (self.area_op(self.outs[i].pts) > 0.0) {
                    let p = self.outs[i].pts;
                    self.reverse_poly_pt_links(p);
                }
            }
            self.join_common_edges();
            for i in 0..self.outs.len() {
                if self.outs[i].pts != NIL {
                    if self.outs[i].is_open { self.fixup_out_polyline(i); } else { self.fixup_out_polygon(i); }
                }
            }
            if self.strict_simple { self.do_simple_polygons(); }
        }
        self.joins.clear();
        self.ghost_joins.clear();
        succeeded
    }

    /// `Execute(clipType, Paths&, subjFill, clipFill)`; panics (like the C++ throws) if open paths were added.
    pub fn execute_paths(&mut self, clip_type: ClipType, subj_fill: FillType, clip_fill: FillType) -> Option<Vec<Vec<IP>>> {
        if self.has_open_paths { panic!("Error: PolyTree struct is needed for open path clipping."); }
        self.subj_fill = subj_fill;
        self.clip_fill = clip_fill;
        self.clip_type = clip_type;
        self.using_polytree = false;
        if !self.execute_internal() { return None; }
        Some(self.build_result())
    }

    pub fn execute_tree(&mut self, clip_type: ClipType, subj_fill: FillType, clip_fill: FillType) -> Option<PolyTree> {
        self.subj_fill = subj_fill;
        self.clip_fill = clip_fill;
        self.clip_type = clip_type;
        self.using_polytree = true;
        if !self.execute_internal() { return None; }
        let mut t = PolyTree::new();
        self.build_result2(&mut t);
        Some(t)
    }
}

// ---- ClipperOffset ------------------------------------------------------------------------------------------------------
const PI: f64 = 3.141592653589793238;
const TWO_PI: f64 = PI * 2.0;
const DEF_ARC_TOLERANCE: f64 = 0.25;

struct OffsetNode { contour: Vec<IP>, join: JoinType, end: EndType }

pub struct ClipperOffset {
    pub miter_limit: f64,
    pub arc_tolerance: f64,
    pub shortest_edge_length: f64,
    nodes: Vec<OffsetNode>,
    lowest: (isize, usize),
    dest_polys: Vec<Vec<IP>>,
    src_poly: Vec<IP>,
    dest_poly: Vec<IP>,
    normals: Vec<[f64; 2]>,
    delta: f64, sin_a: f64, sin: f64, cos: f64, miter_lim: f64, steps_per_rad: f64,
}

fn get_unit_normal(p1: IP, p2: IP) -> [f64; 2] {
    if p2[0] == p1[0] && p2[1] == p1[1] { return [0.0, 0.0]; }
    let mut dx = (p2[0] - p1[0]) as f64;
    let mut dy = (p2[1] - p1[1]) as f64;
    let f = 1.0 / (dx * dx + dy * dy).sqrt();
    dx *= f;
    dy *= f;
    [dy, -dx]
}

impl ClipperOffset {
    pub fn new(miter_limit: f64, arc_tolerance: f64, shortest_edge_length: f64) -> ClipperOffset {
        ClipperOffset { miter_limit, arc_tolerance, shortest_edge_length, nodes: Vec::new(), lowest: (-1, 0), dest_polys: Vec::new(), src_poly: Vec::new(),
            dest_poly: Vec::new(), normals: Vec::new(), delta: 0.0, sin_a: 0.0, sin: 0.0, cos: 0.0, miter_lim: 0.0, steps_per_rad: 0.0 }
    }

    pub fn add_path(&mut self, path: &[IP], join: JoinType, end: EndType) {
        let mut high_i = path.len() as isize - 1;
        if high_i < 0 { return; }
        let has_short = self.shortest_edge_length > 0.0;
        let short2 = if has_short { self.shortest_edge_length * self.shortest_edge_length } else { 0.0 };
        if end == EndType::ClosedLine || end == EndType::ClosedPolygon {
            while high_i > 0 {
                let hi = high_i as usize;
                let same = if has_short {
                    let dx = (path[hi][0] - path[0][0]) as f64;
                    let dy = (path[hi][1] - path[0][1]) as f64;
                    dx * dx + dy * dy < short2
                } else { path[0] == path[hi] };
                if !same { break; }
                high_i -= 1;
            }
        }
        let mut contour: Vec<IP> = Vec::with_capacity(high_i as usize + 1);
        contour.push(path[0]);
        let (mut j, mut k) = (0usize, 0usize);
        for i in 1..=(high_i as usize) {
            let same = if has_short {
                let dx = (path[i][0] - contour[j][0]) as f64;
                let dy = (path[i][1] - contour[j][1]) as f64;
                dx * dx + dy * dy < short2
            } else { contour[j] == path[i] };
            if same { continue; }
            j += 1;
            contour.push(path[i]);
            if path[i][1] > contour[k][1] || (path[i][1] == contour[k][1] && path[i][0] < contour[k][0]) { k = j; }
        }
        if end == EndType::ClosedPolygon && j < 2 { return; }
        self.nodes.push(OffsetNode { contour, join, end });
        if end != EndType::ClosedPolygon { return; }
        let ni = self.nodes.len() - 1;
        if self.lowest.0 < 0 {
            self.lowest = (ni as isize, k);
        } else {
            let ip = self.nodes[self.lowest.0 as usize].contour[self.lowest.1];
            let c = self.nodes[ni].contour[k];
            if c[1] > ip[1] || (c[1] == ip[1] && c[0] < ip[0]) { self.lowest = (ni as isize, k); }
        }
    }

    fn fix_orientations(&mut self) {
        if self.lowest.0 >= 0 && !orientation(&self.nodes[self.lowest.0 as usize].contour) {
            for n in self.nodes.iter_mut() {
                if n.end == EndType::ClosedPolygon || (n.end == EndType::ClosedLine && orientation(&n.contour)) { n.contour.reverse(); }
            }
        } else {
            for n in self.nodes.iter_mut() {
                if n.end == EndType::ClosedLine && !orientation(&n.contour) { n.contour.reverse(); }
            }
        }
    }

    /// `Execute(Paths&, delta)`.
    pub fn execute(&mut self, delta: f64) -> Vec<Vec<IP>> {
        self.fix_orientations();
        self.do_offset(delta);
        let mut clpr = Clipper::new();
        clpr.add_paths(&self.dest_polys, PT_SUBJECT, true);
        if delta > 0.0 {
            clpr.execute_paths(ClipType::Union, FillType::Positive, FillType::Positive).unwrap_or_default()
        } else {
            let (l, t, r, b) = clpr.get_bounds();
            let outer = vec![[l - 10, b + 10], [r + 10, b + 10], [r + 10, t - 10], [l - 10, t - 10]];
            clpr.add_path(&outer, PT_SUBJECT, true);
            clpr.reverse_solution(true);
            let mut sol = clpr.execute_paths(ClipType::Union, FillType::Negative, FillType::Negative).unwrap_or_default();
            if !sol.is_empty() { sol.remove(0); }
            sol
        }
    }

    fn do_offset(&mut self, delta: f64) {
        self.dest_polys.clear();
        self.delta = delta;
        if delta > -1.0e-20 && delta < 1.0e-20 {
            for n in &self.nodes { if n.end == EndType::ClosedPolygon { self.dest_polys.push(n.contour.clone()); } }
            return;
        }
        self.miter_lim = if self.miter_limit > 2.0 { 2.0 / (self.miter_limit * self.miter_limit) } else { 0.5 };
        let y = if self.arc_tolerance <= 0.0 { DEF_ARC_TOLERANCE }
            else if self.arc_tolerance > delta.abs() * DEF_ARC_TOLERANCE { delta.abs() * DEF_ARC_TOLERANCE }
            else { self.arc_tolerance };
        let mut steps = PI / (1.0 - y / delta.abs()).acos();
        if steps > delta.abs() * PI { steps = delta.abs() * PI; }
        self.sin = (TWO_PI / steps).sin();
        self.cos = (TWO_PI / steps).cos();
        self.steps_per_rad = steps / TWO_PI;
        if delta < 0.0 { self.sin = -self.sin; }
        for ni in 0..self.nodes.len() {
            self.src_poly = self.nodes[ni].contour.clone();
            let (jt, et) = (self.nodes[ni].join, self.nodes[ni].end);
            let len = self.src_poly.len();
            if len == 0 || (delta <= 0.0 && (len < 3 || et != EndType::ClosedPolygon)) { continue; }
            self.dest_poly.clear();
            if len == 1 {
                if jt == JoinType::Round {
                    let (mut x, mut yy) = (1.0f64, 0.0f64);
                    let mut j = 1i64;
                    while (j as f64) <= steps {
                        self.dest_poly.push([round_i(self.src_poly[0][0] as f64 + x * delta), round_i(self.src_poly[0][1] as f64 + yy * delta)]);
                        let x2 = x;
                        x = x * self.cos - self.sin * yy;
                        yy = x2 * self.sin + yy * self.cos;
                        j += 1;
                    }
                } else {
                    let (mut x, mut yy) = (-1.0f64, -1.0f64);
                    for _ in 0..4 {
                        self.dest_poly.push([round_i(self.src_poly[0][0] as f64 + x * delta), round_i(self.src_poly[0][1] as f64 + yy * delta)]);
                        if x < 0.0 { x = 1.0; } else if yy < 0.0 { yy = 1.0; } else { x = -1.0; }
                    }
                }
                self.dest_polys.push(self.dest_poly.clone());
                continue;
            }
            self.normals.clear();
            for j in 0..len - 1 { self.normals.push(get_unit_normal(self.src_poly[j], self.src_poly[j + 1])); }
            if et == EndType::ClosedLine || et == EndType::ClosedPolygon { self.normals.push(get_unit_normal(self.src_poly[len - 1], self.src_poly[0])); }
            else { let n = self.normals[len - 2]; self.normals.push(n); }
            if et == EndType::ClosedPolygon {
                let mut k = len - 1;
                for j in 0..len { self.offset_point(j, &mut k, jt); }
                self.dest_polys.push(self.dest_poly.clone());
            } else {
                panic!("ClipperOffset: only closed polygons are ported");
            }
        }
    }

    fn offset_point(&mut self, j: usize, k: &mut usize, jt: JoinType) {
        let (nk, nj) = (self.normals[*k], self.normals[j]);
        self.sin_a = nk[0] * nj[1] - nj[0] * nk[1];
        if (self.sin_a * self.delta).abs() < 1.0 {
            let cos_a = nk[0] * nj[0] + nj[1] * nk[1];
            if cos_a > 0.0 {
                self.dest_poly.push([round_i(self.src_poly[j][0] as f64 + nk[0] * self.delta), round_i(self.src_poly[j][1] as f64 + nk[1] * self.delta)]);
                return;
            }
        } else if self.sin_a > 1.0 { self.sin_a = 1.0; }
        else if self.sin_a < -1.0 { self.sin_a = -1.0; }
        if self.sin_a * self.delta < 0.0 {
            self.dest_poly.push([round_i(self.src_poly[j][0] as f64 + nk[0] * self.delta), round_i(self.src_poly[j][1] as f64 + nk[1] * self.delta)]);
            self.dest_poly.push(self.src_poly[j]);
            self.dest_poly.push([round_i(self.src_poly[j][0] as f64 + nj[0] * self.delta), round_i(self.src_poly[j][1] as f64 + nj[1] * self.delta)]);
        } else {
            match jt {
                JoinType::Miter => {
                    let r = 1.0 + (nj[0] * nk[0] + nj[1] * nk[1]);
                    if r >= self.miter_lim { self.do_miter(j, *k, r); } else { self.do_square(j, *k); }
                }
                JoinType::Square => self.do_square(j, *k),
                JoinType::Round => self.do_round(j, *k),
            }
        }
        *k = j;
    }

    fn do_square(&mut self, j: usize, k: usize) {
        let (nk, nj) = (self.normals[k], self.normals[j]);
        let dx = (self.sin_a.atan2(nk[0] * nj[0] + nk[1] * nj[1]) / 4.0).tan();
        let s = self.src_poly[j];
        self.dest_poly.push([round_i(s[0] as f64 + self.delta * (nk[0] - nk[1] * dx)), round_i(s[1] as f64 + self.delta * (nk[1] + nk[0] * dx))]);
        self.dest_poly.push([round_i(s[0] as f64 + self.delta * (nj[0] + nj[1] * dx)), round_i(s[1] as f64 + self.delta * (nj[1] - nj[0] * dx))]);
    }

    fn do_miter(&mut self, j: usize, k: usize, r: f64) {
        let (nk, nj) = (self.normals[k], self.normals[j]);
        let q = self.delta / r;
        let s = self.src_poly[j];
        self.dest_poly.push([round_i(s[0] as f64 + (nk[0] + nj[0]) * q), round_i(s[1] as f64 + (nk[1] + nj[1]) * q)]);
    }

    fn do_round(&mut self, j: usize, k: usize) {
        let (nk, nj) = (self.normals[k], self.normals[j]);
        let a = self.sin_a.atan2(nk[0] * nj[0] + nk[1] * nj[1]);
        let steps = std::cmp::max(round_i(self.steps_per_rad * a.abs()), 1);
        let (mut x, mut y) = (nk[0], nk[1]);
        let s = self.src_poly[j];
        for _ in 0..steps {
            self.dest_poly.push([round_i(s[0] as f64 + x * self.delta), round_i(s[1] as f64 + y * self.delta)]);
            let x2 = x;
            x = x * self.cos - self.sin * y;
            y = x2 * self.sin + y * self.cos;
        }
        self.dest_poly.push([round_i(s[0] as f64 + nj[0] * self.delta), round_i(s[1] as f64 + nj[1] * self.delta)]);
    }
}

// ---- libslic3r ClipperUtils equivalents --------------------------------------------------------------------------------
/// libslic3r `ExPolygon`: contour CCW, holes CW, integer nm coordinates.
#[derive(Clone, Debug, Default)]
pub struct ExPoly { pub contour: Vec<IP>, pub holes: Vec<Vec<IP>> }

/// `PolyTreeToExPolygons`.
pub fn tree_to_expolygons(tree: &PolyTree) -> Vec<ExPoly> {
    fn rec(tree: &PolyTree, n: usize, out: &mut Vec<ExPoly>) {
        let node = &tree.nodes[n];
        let mut ex = ExPoly { contour: node.contour.clone(), holes: Vec::with_capacity(node.childs.len()) };
        let mut later: Vec<usize> = Vec::new();
        for &c in &node.childs {
            ex.holes.push(tree.nodes[c].contour.clone());
            for &g in &tree.nodes[c].childs { later.push(g); }
        }
        out.push(ex);
        // The C++ appends the contour's expolygon first and then recurses into every grandchild in order.
        for g in later { rec(tree, g, out); }
    }
    let mut out = Vec::new();
    for &c in tree.root_childs() { rec(tree, c, &mut out); }
    out
}

fn clipper_do_paths(clip_type: ClipType, subject: &[Vec<IP>], clip: &[Vec<IP>], fill: FillType) -> Vec<Vec<IP>> {
    let mut c = Clipper::new();
    c.add_paths(subject, PT_SUBJECT, true);
    c.add_paths(clip, PT_CLIP, true);
    c.execute_paths(clip_type, fill, fill).unwrap_or_default()
}

fn clipper_union_tree(paths: &[Vec<IP>], fill: FillType) -> PolyTree {
    let mut c = Clipper::new();
    c.add_paths(paths, PT_SUBJECT, true);
    c.execute_tree(ClipType::Union, fill, fill).unwrap_or_else(PolyTree::new)
}

/// `offset_expolygon_inner`: returns the raw (not yet united) paths of one offset ExPolygon.
fn offset_expolygon_inner(ex: &ExPoly, delta: f32, join: JoinType, miter_limit: f64) -> Vec<Vec<IP>> {
    let delta_d = delta as f64;
    // `std::abs(delta * ClipperOffsetShortestEdgeFactor)`: float * double -> double
    let shortest = (delta_d * 0.005).abs();
    let mut contours;
    {
        let mut co = ClipperOffset::new(2.0, 0.25, shortest);
        if join == JoinType::Round { co.arc_tolerance = miter_limit; } else { co.miter_limit = miter_limit; }
        co.add_path(&ex.contour, join, EndType::ClosedPolygon);
        contours = co.execute(delta_d);
    }
    if contours.is_empty() { return Vec::new(); }
    if ex.holes.is_empty() { return contours; }
    let mut holes: Vec<Vec<IP>> = Vec::new();
    for h in &ex.holes {
        let mut co = ClipperOffset::new(2.0, 0.25, shortest);
        if join == JoinType::Round { co.arc_tolerance = miter_limit; } else { co.miter_limit = miter_limit; }
        co.add_path(h, join, EndType::ClosedPolygon);
        let out2 = co.execute(-delta_d);
        holes.extend(out2);
    }
    if holes.is_empty() { return contours; }
    if delta < 0.0 {
        let output = clipper_do_paths(ClipType::Difference, &contours, &holes, FillType::NonZero);
        if !output.is_empty() { output } else { Vec::new() }
    } else {
        for h in holes.iter_mut() { h.reverse(); }
        contours.extend(holes);
        contours
    }
}

/// `offset(ExPolygon, float delta, join, miterLimit)` as Paths (contours then holes, not united).
pub fn offset_expolygon_paths(ex: &ExPoly, delta: f32, join: JoinType, miter_limit: f64) -> Vec<Vec<IP>> { offset_expolygon_inner(ex, delta, join, miter_limit) }

/// `offset_ex(ExPolygons, float delta, jtMiter, miterLimit=3)`: each ExPolygon offset on its own, then united into a PolyTree.
pub fn offset_ex(expolygons: &[ExPoly], delta: f32, join: JoinType, miter_limit: f64) -> Vec<ExPoly> {
    let mut output: Vec<Vec<IP>> = Vec::new();
    for ex in expolygons { output.extend(offset_expolygon_inner(ex, delta, join, miter_limit)); }
    let tree = clipper_union_tree(&output, FillType::NonZero);
    tree_to_expolygons(&tree)
}

/// `intersection_pl(Polylines&&, ExPolygons)`: ClipperLib open-path intersection, PolyTree output (`PolyTreeToPolylines`).
pub fn intersection_pl(lines: &[Vec<IP>], clip: &[ExPoly]) -> Vec<Vec<IP>> {
    let mut c = Clipper::new();
    c.add_paths(lines, PT_SUBJECT, false);
    for ex in clip {
        c.add_path(&ex.contour, PT_CLIP, true);
        for h in &ex.holes { c.add_path(h, PT_CLIP, true); }
    }
    let tree = c.execute_tree(ClipType::Intersection, FillType::NonZero, FillType::NonZero).unwrap_or_else(PolyTree::new);
    fn rec(tree: &PolyTree, n: usize, out: &mut Vec<Vec<IP>>) {
        if !tree.nodes[n].contour.is_empty() { out.push(tree.nodes[n].contour.clone()); }
        for &c in &tree.nodes[n].childs { rec(tree, c, out); }
    }
    let mut out = Vec::new();
    rec(&tree, 0, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sq(x0: i64, y0: i64, x1: i64, y1: i64) -> Vec<IP> { vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }
    #[test]
    fn offset_square_inward() {
        let ex = ExPoly { contour: sq(0, 0, 10_000_000, 10_000_000), holes: vec![] };
        let r = offset_ex(&[ex], -1_000_000.0, JoinType::Miter, 3.0);
        assert_eq!(r.len(), 1);
        let mut c = r[0].contour.clone();
        c.sort();
        assert_eq!(c, vec![[1_000_000, 1_000_000], [1_000_000, 9_000_000], [9_000_000, 1_000_000], [9_000_000, 9_000_000]]);
    }
    #[test]
    fn offset_square_with_hole() {
        let mut hole = sq(4_000_000, 4_000_000, 6_000_000, 6_000_000);
        hole.reverse();
        let ex = ExPoly { contour: sq(0, 0, 10_000_000, 10_000_000), holes: vec![hole] };
        let r = offset_ex(&[ex], -500_000.0, JoinType::Miter, 3.0);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].holes.len(), 1);
    }
    #[test]
    fn open_line_clip() {
        let clip = ExPoly { contour: sq(0, 0, 10_000_000, 10_000_000), holes: vec![] };
        let lines = vec![vec![[5_000_000, -5_000_000], [5_000_000, 15_000_000]], vec![[-5_000_000, 3_000_000], [15_000_000, 3_000_000]]];
        let r = intersection_pl(&lines, &[clip]);
        assert_eq!(r.len(), 2);
        // every output line lies inside the square and is cut at the border
        for l in &r { assert_eq!(l.len(), 2); }
        let ys: Vec<i64> = r.iter().map(|l| l[0][1]).collect();
        assert!(ys.contains(&10_000_000) || ys.contains(&0) || ys.contains(&3_000_000));
    }
}
