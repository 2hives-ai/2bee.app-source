//! Multi-material in the G-code stage (lane M4B): which filament prints which path, the order in which a layer is
//! printed, the Bambu tool change (`change_filament_gcode` with every placeholder Orca provides, `M620/M621` macros,
//! retract / lift / travel around them) and the prime tower pieces (`wipe_tower.rs`) placed in the layer exactly where
//! `GCode::process_layer` + `WipeTowerIntegration::append_tcr` place them.
//!
//! SCOPE (see `wipe_tower.rs` for the tower): ONE extruder carrying any number of filaments (the X2D AMS case:
//! `filament_map = 1,1,...`). Filaments on both X2D extruders (nozzle change / ramming) are REFUSED.
//!
//! TYPES THE CALLER FILLS (no change to `types.rs`): `GcodeOptions::multi = Some(MultiMaterial { path_filament, .. })`, a side
//! table parallel to `plans[layer].paths[i]` giving the 0-based filament of every path (and optionally its object).
//!
//! Child module of `gcode`: it uses the generator's private writer state directly.

use super::*;
use super::wipe_tower::{self as wt, Tcr, TowerLayer, TowerOutput, WipeTowerCfg};
use crate::motion::plan::Island;

/// An object as the G-code names it (`; printing object NAME id:ID copy 0`, `unique label id`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ObjectLabel {
    pub name: String,
    pub object_id: u32,
    pub label_id: u32,
}

/// Side table that tells the G-code stage which filament (and object) prints every path.
///
/// Why a side table and not a field of `ExtPath`: `types.rs` is shared and frozen. `path_filament[l][i]` is the filament
/// of `plans[l].paths[i]` (0-based, an index into the per-filament vectors of the config: `filament_type`, `nozzle_temperature`,
/// ...). The table must have exactly the shape of the plans handed to `generate` (layers that are empty are dropped by
/// `generate`; the table is trimmed with them).
#[derive(Clone, Debug, Default)]
pub struct MultiMaterial {
    pub path_filament: Vec<Vec<usize>>,
    /// Object of every path (index into `objects`); `None` = every path belongs to `GcodeOptions::object_*`.
    pub path_object: Option<Vec<Vec<usize>>>,
    pub objects: Vec<ObjectLabel>,
    /// Tower corner on the bed (mm) when the caller arranged it; default = `wipe_tower_x/y` of the config.
    pub tower_pos: Option<[f64; 2]>,
    /// Number of filaments of the print; default = length of the per-filament vectors of the config.
    pub filament_count: Option<usize>,
}

impl MultiMaterial {
    fn used_filaments(&self) -> Vec<usize> {
        let mut v: Vec<usize> = self.path_filament.iter().flatten().copied().collect();
        v.sort_unstable();
        v.dedup();
        v
    }
}

pub(super) struct Prepared {
    pub settings: Option<Settings>,
    pub opts: GcodeOptions,
    pub initial_filament: usize,
}

/// Align the side table with the kept layers and decide whether this is a multi-material print.
pub(super) fn prepare_options(cfg: &Settings, opts: &GcodeOptions, keep: &[usize], kept: &[LayerPlan]) -> Result<Option<Prepared>, FdmError> {
    let Some(m) = &opts.multi else { return Ok(None) };
    let sub_rows = |t: &Vec<Vec<usize>>, what: &str| -> Result<Vec<Vec<usize>>, FdmError> {
        let mut out = Vec::with_capacity(keep.len());
        for (k, &i) in keep.iter().enumerate() {
            let row = t.get(i).ok_or_else(|| FdmError::Geometry(format!("MultiMaterial.{} has no row for layer {} (table has {} rows)", what, i, t.len())))?;
            if row.len() != kept[k].paths.len() {
                return Err(FdmError::Geometry(format!("MultiMaterial.{} row {} has {} entries but the layer has {} paths", what, i, row.len(), kept[k].paths.len())));
            }
            out.push(row.clone());
        }
        Ok(out)
    };
    let mut sub = MultiMaterial { path_filament: sub_rows(&m.path_filament, "path_filament")?, path_object: None, objects: m.objects.clone(), tower_pos: m.tower_pos, filament_count: m.filament_count };
    if let Some(po) = &m.path_object { sub.path_object = Some(sub_rows(po, "path_object")?); }
    let used = sub.used_filaments();
    let max_used = used.last().copied().unwrap_or(0);
    let nfil = m.filament_count.unwrap_or(0).max(cfg.len_of("filament_type")).max(max_used + 1);
    sub.filament_count = Some(nfil);
    let mut o = opts.clone();
    if used.len() <= 1 {
        let f = used.first().copied().unwrap_or(0);
        o.multi = None;
        let settings = if nfil > 1 { Some(cfg.for_filament(f)) } else { None };
        return Ok(Some(Prepared { settings, opts: o, initial_filament: f }));
    }
    o.multi = Some(sub);
    Ok(Some(Prepared { settings: None, opts: o, initial_filament: 0 }))
}

// ---------------------------------------------------------------------------------------------------------------
// tool ordering (ToolOrdering / ToolOrderUtils)
// ---------------------------------------------------------------------------------------------------------------

fn next_permutation(v: &mut [usize]) -> bool {
    if v.len() < 2 { return false; }
    let mut i = v.len() - 1;
    while i > 0 && v[i - 1] >= v[i] { i -= 1; }
    if i == 0 { v.reverse(); return false; }
    let mut j = v.len() - 1;
    while v[j] <= v[i - 1] { j -= 1; }
    v.swap(i - 1, j);
    v[i..].reverse();
    true
}

fn change_count(a: &[usize], b: &[usize], start: Option<usize>) -> i32 {
    let mut count = 0;
    let mut prev = start;
    for seq in [a, b] {
        for &e in seq {
            if let Some(p) = prev { if p != e { count += 1; } }
            prev = Some(e);
        }
    }
    count
}

/// `solve_extruder_order_with_forcast`: the order of this layer's filaments that minimises the flush of this layer plus the
/// best follow-up in the next layer (all permutations of both).
fn solve_order_forecast(w: &[Vec<f32>], curr: &[usize], next: &[usize], start: Option<usize>) -> Vec<usize> {
    let mut cur: Vec<usize> = curr.to_vec(); cur.sort_unstable();
    let mut nxt: Vec<usize> = next.to_vec(); nxt.sort_unstable();
    let mut best_cost = f32::MAX;
    let mut best_change = i32::MAX;
    let mut best_seq: Vec<usize> = Vec::new();
    loop {
        let mut prev1 = start;
        let mut curr_cost = 0.0f32;
        for &c in &cur { if let Some(p) = prev1 { curr_cost += w[p][c]; } prev1 = Some(c); }
        if !(curr_cost > best_cost) {
            loop {
                let mut prev2 = prev1;
                let mut total_cost = curr_cost;
                let total_change = change_count(&cur, &nxt, start);
                for &n in &nxt { if let Some(p) = prev2 { total_cost += w[p][n]; } prev2 = Some(n); }
                if total_cost < best_cost || (total_cost == best_cost && total_change < best_change) {
                    best_cost = total_cost; best_seq = cur.clone(); best_change = total_change;
                }
                if !next_permutation(&mut nxt) { break; }
            }
        }
        if !next_permutation(&mut cur) { break; }
    }
    best_seq
}

/// `solve_extruder_order`: shortest Hamiltonian path from `start` (dynamic programming over subsets).
fn solve_order_dp(w: &[Vec<f32>], all: &[usize], start: Option<usize>) -> Vec<usize> {
    let mut ext: Vec<usize> = all.to_vec();
    let mut added = false;
    let start_id = match start {
        Some(s) => {
            if let Some(p) = ext.iter().position(|&e| e == s) { ext.swap(0, p); } else { ext.insert(0, s); added = true; }
            s
        }
        None => ext[0],
    };
    let n = ext.len();
    let its = 1usize << n;
    let mut cache = vec![vec![f32::from_bits(0x4effffff); n]; its];
    let mut prev = vec![vec![-1i32; n]; its];
    cache[1][0] = 0.0;
    for state in 0..its {
        if state & 1 == 0 { continue; }
        for target in 0..n {
            if state >> target & 1 == 0 { continue; }
            for mid in 0..n {
                if state >> mid & 1 == 0 { continue; }
                let tmp = cache[state - (1 << target)][mid] + w[ext[mid]][ext[target]];
                if cache[state][target] > tmp { cache[state][target] = tmp; prev[state][target] = mid as i32; }
            }
        }
    }
    let fs = its - 1;
    let mut cost = f32::MAX; let mut fd = 0usize;
    for dst in 0..n { if ext[dst] != start_id && cost > cache[fs][dst] { cost = cache[fs][dst]; fd = dst; } }
    let mut path = Vec::new();
    let (mut st, mut pt) = (fs, fd as i32);
    while pt != -1 { path.push(ext[pt as usize]); let mid = prev[st][pt as usize]; st -= 1 << pt; pt = mid; }
    if added { path.pop(); }
    path.reverse();
    path
}

/// `get_extruders_order`
fn extruders_order(w: &[Vec<f32>], curr: &[usize], next: &[usize], start: Option<usize>) -> Vec<usize> {
    if curr.len() <= 1 { return curr.to_vec(); }
    let use_forecast = curr.len() <= 5 && next.len() <= 5;
    if use_forecast { solve_order_forecast(w, curr, next, start) } else { solve_order_dp(w, curr, start) }
}

/// Tool order of every layer. Layer 0 keeps the ascending order (Orca decides the first layer before reordering); the others
/// minimise the flush starting from the filament the previous layer ended with.
pub fn tool_orders(layer_sets: &[Vec<usize>], flush: &[Vec<f32>]) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = Vec::with_capacity(layer_sets.len());
    let mut curr: Option<usize> = None;
    for (li, set) in layer_sets.iter().enumerate() {
        let mut sorted = set.clone(); sorted.sort_unstable();
        let seq = if li == 0 { sorted.clone() } else {
            let mut next = layer_sets.get(li + 1).cloned().unwrap_or_default(); next.sort_unstable();
            extruders_order(flush, &sorted, &next, curr)
        };
        if let Some(&l) = seq.last() { curr = Some(l); }
        out.push(seq);
    }
    out
}

/// `fill_wipe_tower_partitions`: tool changes still to come at or above every layer; the tower stands where this is > 0.
pub fn tower_layers(orders: &[Vec<usize>]) -> Vec<bool> {
    let mut parts: Vec<i64> = Vec::with_capacity(orders.len());
    let mut last: Option<usize> = None;
    for e in orders {
        let mut p = e.len() as i64;
        if let Some(&first) = e.first() {
            if last.is_none() || last == Some(first) { p -= 1; }
            last = e.last().copied();
        }
        parts.push(p);
    }
    for i in (0..orders.len().saturating_sub(1)).rev() { parts[i] = parts[i].max(parts[i + 1]); }
    parts.iter().map(|&p| p > 0).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// the multi-material context of a generator run
// ---------------------------------------------------------------------------------------------------------------

pub(super) struct MmCtx {
    pub nfil: usize,
    pub fil_s: Vec<Settings>,
    pub fil_p: Vec<Params>,
    pub orders: Vec<Vec<usize>>,
    pub tower: TowerOutput,
    pub tower_of_layer: Vec<Option<usize>>,
    pub cur: usize,
    pub first_tool: usize,
    pub translation: [f32; 2],
    /// tower outline box (first layer incl. brim) in BED coordinates, for the approach route
    pub bbx_bed: [[f32; 2]; 2],
    pub toolchange_count: i64,
    /// signed E (mm) written while each filament was loaded
    pub used_e: Vec<f64>,
    pub e_mark: f64,
    pub used_filaments: Vec<usize>,
    pub tower_cfg: WipeTowerCfg,
    /// [layer][filament] -> the sub-plan of that filament
    pub plans_f: Vec<Vec<LayerPlan>>,
    pub objects_f: Vec<Vec<Vec<usize>>>, // unused placeholder for per-object grouping
}

fn check_add_eol(s: &mut String) { if !s.is_empty() && !s.ends_with('\n') { s.push('\n'); } }

fn f32v(v: f64) -> V { V::Dbl(v) }

impl<'a> Gen<'a> {
    /// Per-filament settings view (`GCode::FILAMENT_CONFIG`): the current filament's collapsed settings, or the plain settings.
    pub(super) fn fs(&self) -> &Settings {
        match &self.mm { Some(m) => &m.fil_s[m.cur], None => self.s }
    }

    fn capture<F: FnOnce(&mut Self)>(&mut self, f: F) -> String {
        let saved = std::mem::take(&mut self.out);
        f(self);
        std::mem::replace(&mut self.out, saved)
    }

    /// Account the signed E written since the last mark to the filament currently loaded.
    fn mm_flush_usage(&mut self) {
        let abs = self.absolute_e;
        if let Some(m) = self.mm.as_mut() {
            m.used_e[m.cur] += abs - m.e_mark;
            m.e_mark = abs;
        }
    }

    /// Switch the generator's per-filament parameters (speeds, retraction, flow, temperatures) to filament `f`.
    pub(super) fn set_filament(&mut self, f: usize) {
        self.mm_flush_usage();
        let (bed_first, bed) = (self.p.bed_temp_first, self.p.bed_temp);
        let m = self.mm.as_mut().unwrap();
        m.cur = f;
        self.p = m.fil_p[f].clone();
        self.p.bed_temp_first = bed_first;
        self.p.bed_temp = bed;
    }

    /// Everything that has to be known before the layers are written: filament sub-plans, tool order, tower.
    pub(super) fn mm_prepare(&mut self, plans: &[LayerPlan]) -> Result<(), FdmError> {
        let Some(table) = self.o.multi.as_ref() else { return Ok(()) };
        let s = self.s;
        let nfil = table.filament_count.unwrap_or(1).max(1);
        // --- refuse what the port does not cover ---------------------------------------------------------
        if s.has("filament_map") {
            let maps = s.elements("filament_map");
            let used = table.used_filaments();
            let mut ext: Vec<String> = used.iter().map(|&f| maps.get(f).cloned().unwrap_or_else(|| maps.first().cloned().unwrap_or_default())).collect();
            ext.sort(); ext.dedup();
            if ext.len() > 1 {
                return Err(FdmError::Unsupported(format!("multi-material across both X2D extruders (filament_map = {}): nozzle change / ramming is not ported; put every filament on one extruder", maps.join(","))));
            }
        }
        if !self.p.relative_e { return Err(FdmError::Unsupported("multi-material needs relative extruder distances (M83)".into())); }
        if s.has("print_sequence") && s.text("print_sequence") == "by object" { return Err(FdmError::Unsupported("print_sequence by object".into())); }
        if s.flag("spiral_mode") { return Err(FdmError::Unsupported("spiral vase with several filaments".into())); }
        // --- per-filament settings and parameters ------------------------------------------------------------
        let fil_s: Vec<Settings> = (0..nfil).map(|f| s.for_filament(f)).collect();
        let fil_p: Vec<Params> = fil_s.iter().map(|fs| { let mut p = Params::new(fs); p.bed_temp_first = self.p.bed_temp_first; p.bed_temp = self.p.bed_temp; p }).collect();
        // --- sub-plans per layer and filament -------------------------------------------------------------------
        let n = plans.len();
        let mut plans_f: Vec<Vec<LayerPlan>> = Vec::with_capacity(n);
        let mut sets: Vec<Vec<usize>> = Vec::with_capacity(n);
        for (li, pl) in plans.iter().enumerate() {
            let row = &table.path_filament[li];
            let mut per: Vec<LayerPlan> = (0..nfil).map(|_| LayerPlan { z: pl.z, h: pl.h, paths: Vec::new() }).collect();
            let mut set: Vec<usize> = Vec::new();
            for (pi, p) in pl.paths.iter().enumerate() {
                let f = row[pi];
                if f >= nfil { return Err(FdmError::Geometry(format!("path_filament[{}][{}] = {} but the print has {} filaments", li, pi, f, nfil))); }
                per[f].paths.push(p.clone());
                if p.pts.len() >= 2 && !set.contains(&f) { set.push(f); }
            }
            set.sort_unstable();
            plans_f.push(per);
            sets.push(set);
        }
        // --- tower configuration ---------------------------------------------------------------------------------
        let mut tcfg = WipeTowerCfg::from_settings(s, nfil)?;
        if let Some(tp) = table.tower_pos { tcfg.pos = [tp[0] as f32, tp[1] as f32]; }
        let orders = tool_orders(&sets, &tcfg.flush);
        let has_tower = tower_layers(&orders);
        let first_tool = orders.first().and_then(|o| o.first()).copied().unwrap_or(0);
        // --- plan the tower exactly as Print::_make_wipe_tower does --------------------------------------------------
        let mut tl: Vec<TowerLayer> = Vec::new();
        let mut tower_of_layer: Vec<Option<usize>> = vec![None; n];
        let mut last_z = 0.0f64;
        for li in 0..n {
            if !has_tower[li] { continue; }
            tower_of_layer[li] = Some(tl.len());
            tl.push(TowerLayer { z: plans[li].z as f32, h: (plans[li].z - last_z) as f32, order: orders[li].clone() });
            last_z = plans[li].z;
        }
        let bed = parse_bed(s);
        let (bmin, bmax) = geo::bbox(&bed).unwrap_or(([0.0, 0.0], [256.0, 256.0]));
        let tower;
        let bbx_bed;
        let translation;
        if tl.is_empty() {
            tower = TowerOutput::default();
            bbx_bed = [[0.0; 2]; 2];
            translation = [0.0, 0.0];
        } else {
            let (out, wtw) = wt::build_tower(tcfg.clone(), &tl, first_tool, [bmin[0] as f32, bmin[1] as f32], [bmax[0] as f32, bmax[1] as f32]);
            translation = [tcfg.pos[0] + out.rib_offset[0], tcfg.pos[1] + out.rib_offset[1]];
            let bb = wtw.outer_bbox();
            bbx_bed = [[bb[0][0] + translation[0], bb[0][1] + translation[1]], [bb[1][0] + translation[0], bb[1][1] + translation[1]]];
            tower = out;
        }
        for note in &tower.notes { self.issue(note.clone()); }
        self.mm = Some(MmCtx {
            nfil, fil_s, fil_p, orders, tower, tower_of_layer, cur: first_tool, first_tool, translation, bbx_bed, toolchange_count: 0,
            used_e: vec![0.0; nfil], e_mark: 0.0, used_filaments: table.used_filaments(), tower_cfg: tcfg, plans_f, objects_f: Vec::new(),
        });
        // the print starts on the first filament of layer 0
        let (bf, b) = (self.p.bed_temp_first, self.p.bed_temp);
        self.p = self.mm.as_ref().unwrap().fil_p[first_tool].clone();
        self.p.bed_temp_first = bf; self.p.bed_temp = b;
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// tool change: WipeTowerIntegration::append_tcr
// ---------------------------------------------------------------------------------------------------------------

/// `WipeTowerIntegration::generate_path_to_wipe_tower`: waypoints from `start` to the tower entry `end` that go round the
/// tower's (inflated) outline box instead of across the printed wall. All coordinates are bed mm.
fn path_to_wipe_tower(start: P2, end: P2, avoid: [[f64; 2]; 2], bed: &[P2]) -> Vec<P2> {
    let alpha = 2.0; // wipe_tower_routing_clearance
    let inner = [[avoid[0][0] - alpha, avoid[0][1] - alpha], [avoid[1][0] + alpha, avoid[1][1] + alpha]];
    let width = inner[1][0] - inner[0][0];
    let mut v = [1.0f64, 0.0];
    if (end[0] - inner[0][0]).abs() < width / 2.0 { v = [-1.0, 0.0]; }
    // corners (BoundingBox::polygon order: min, (max.x,min.y), max, (min.x,max.y))
    let pts = [inner[0], [inner[1][0], inner[0][1]], inner[1], [inner[0][0], inner[1][1]]];
    let inside_bed = |p: P2| -> bool {
        if bed.len() < 3 { return true; }
        let mut poly = bed.to_vec();
        if geo::signed_area(&poly) < 0.0 { poly.reverse(); }
        geo::in_ring(p, &poly)
    };
    if !pts.iter().all(|&p| inside_bed(p)) { return vec![end]; }
    let ray = |a: P2, v1: P2, b: P2, c: P2| -> Option<P2> {
        let v2 = geo::sub(c, b);
        let denom = geo::cross(v1, v2);
        if denom.abs() < 1e-4 { return None; }
        let v12 = geo::sub(a, b);
        let na = geo::cross(v2, v12);
        let nb = geo::cross(v1, v12);
        let (t1, t2) = (na / denom, nb / denom);
        if t1 >= 0.0 && t2 >= 0.0 && t2 <= 1.0 { Some([a[0] + t1 * v1[0], a[1] + t1 * v1[1]]) } else { None }
    };
    let mut inter0: Option<(usize, P2)> = None;
    for i in 0..4 {
        if let Some(p) = ray(end, v, pts[i], pts[(i + 1) % 4]) { inter0 = Some((i, p)); break; }
    }
    let Some((i0, p0)) = inter0 else { return vec![end] };
    // second intersection of start->p0 with the outline
    let seg_inter = |a: P2, b: P2, c: P2, d: P2| -> Option<P2> {
        let r = geo::sub(b, a); let s = geo::sub(d, c);
        let den = geo::cross(r, s);
        if den.abs() < 1e-12 { return None; }
        let t = geo::cross(geo::sub(c, a), s) / den;
        let u = geo::cross(geo::sub(c, a), r) / den;
        if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) { Some([a[0] + t * r[0], a[1] + t * r[1]]) } else { None }
    };
    let mut inter1: Option<(usize, P2)> = None;
    for i in 0..4 {
        if i == i0 { continue; }
        if let Some(p) = seg_inter(start, p0, pts[i], pts[(i + 1) % 4]) { inter1 = Some((i, p)); break; }
    }
    let mut res: Vec<P2> = Vec::new();
    match inter1 {
        None => res.push(p0),
        Some((i1, p1)) => {
            let calc = |is_add: bool| -> (Vec<P2>, f64) {
                let n = 4usize;
                let beg = if is_add { (i1 + 1) % n } else { i1 };
                let endi = if is_add { i0 } else { (i0 + 1) % n };
                let mut i = beg;
                let mut path = vec![p1];
                let mut len = { let d = geo::sub(p1, pts[beg]); d[0] * d[0] + d[1] * d[1] };
                while i != endi {
                    let ni = if is_add { (i + 1) % n } else { (i + n - 1) % n };
                    let d = geo::sub(pts[i], pts[ni]);
                    len += d[0] * d[0] + d[1] * d[1];
                    path.push(pts[i]);
                    i = ni;
                }
                path.push(pts[endi]);
                path.push(p0);
                let d = geo::sub(p0, pts[endi]);
                len += d[0] * d[0] + d[1] * d[1];
                (path, len)
            };
            let (a, la) = calc(true);
            let (b, lb) = calc(false);
            res.extend(if la < lb { a } else { b });
        }
    }
    res.push(end);
    res
}

fn last_xy_in(gcode: &str) -> (Option<f64>, Option<f64>) {
    let (mut x, mut y) = (None, None);
    for l in gcode.lines() {
        let t = l.trim_start();
        if t.len() > 5 && (t.starts_with("G0 ") || t.starts_with("G1 ") || t.starts_with("G2 ") || t.starts_with("G3 ")) {
            let body = t.split(';').next().unwrap_or("");
            for w in body.split_whitespace() {
                if let Some(v) = w.strip_prefix('X') { if let Ok(f) = v.parse::<f64>() { x = Some(f); } }
                if let Some(v) = w.strip_prefix('Y') { if let Ok(f) = v.parse::<f64>() { y = Some(f); } }
            }
        }
    }
    (x, y)
}

fn macro_changes_tool(gcode: &str, id: usize) -> bool {
    gcode.lines().any(|l| {
        let t = l.trim_start();
        if !t.starts_with('T') { return false; }
        let digits: String = t[1..].chars().take_while(|c| c.is_ascii_digit()).collect();
        !digits.is_empty() && digits.parse::<usize>().ok() == Some(id)
    })
}

impl<'a> Gen<'a> {
    fn auto_lift_type(&self) -> Lift {
        match self.p.z_hop_kind { ZHopKind::Auto | ZHopKind::Spiral | ZHopKind::Slope => Lift::Spiral, _ => Lift::Normal }
    }

    /// `GCode::retract(toolchange = true, ...)`: the same retraction logic with `retract_length_toolchange`.
    fn retract_for_toolchange(&mut self, lift: Lift, instantly: bool) {
        let s = &self.mm.as_ref().unwrap().fil_s[self.mm.as_ref().unwrap().cur];
        let len = { let k = if s.has("filament_retract_length_toolchange") && s.raw("filament_retract_length_toolchange") != Some("nil") && !s.raw("filament_retract_length_toolchange").unwrap_or("").is_empty() { "filament_retract_length_toolchange" } else { "retract_length_toolchange" }; s.num(k) };
        let extra = { let k = if s.has("filament_retract_restart_extra_toolchange") && s.raw("filament_retract_restart_extra_toolchange") != Some("nil") && !s.raw("filament_retract_restart_extra_toolchange").unwrap_or("").is_empty() { "filament_retract_restart_extra_toolchange" } else { "retract_restart_extra_toolchange" }; s.num(k) };
        let (sl, se) = (self.p.retract_len, self.p.restart_extra);
        self.p.retract_len = len;
        self.p.restart_extra = extra;
        let needs_lift_old = self.p.retract_len;
        let _ = needs_lift_old;
        self.gen_retract(lift, instantly, None);
        self.p.retract_len = sl;
        self.p.restart_extra = se;
    }

    /// Emit one piece of prime tower (`tcr`) in the layer: the tool change to `new_f` (when this piece changes the tool),
    /// the tower G-code with the three custom G-code placeholders resolved, and the retraction that closes it.
    pub(super) fn emit_tcr(&mut self, tcr: &Tcr, new_f: usize, base: &BTreeMap<String, Extra>) -> Result<(), FdmError> {
        let (tr, old_f, first_layer_idx) = { let m = self.mm.as_ref().unwrap(); (m.translation, m.cur, self.layer_index) };
        let to_bed = |p: [f32; 2]| -> P2 { [(p[0] + tr[0]) as f64, (p[1] + tr[1]) as f64] };
        let start_bed = to_bed(tcr.start_pos);
        let end_bed = to_bed(tcr.end_pos);
        let tcs_bed = if tcr.is_tool_change { to_bed(tcr.tool_change_start_pos) } else { start_bed };
        let tcr_text = wt::post_process(&tcr.gcode, tcr.start_pos, tr);
        let layer_z = tcr.print_z as f64;
        let is_first_layer = self.on_first_layer();
        // 1. a wall/fill piece printed BEFORE the change: go to the tower first
        if tcr.is_finish_first {
            self.gen_retract(Lift::Normal, false, None);
            self.travel_to(start_bed, Feature::Custom, None);
            self.gen_unretract();
        }
        if !tcr.gcode.contains("[change_filament_gcode]") {
            // a wall / fill piece with no tool change in it
            self.account_tower_e(&tcr_text, old_f, old_f);
            self.out.push_str(&tcr_text);
            self.pos[0] = end_bed[0]; self.pos[1] = end_bed[1];
            self.last_pos = end_bed;
            self.last_pos_defined = true;
            self.pos_clear = true;
            self.wipe_path = tcr.wipe_path.iter().map(|p| to_bed(*p)).collect();
            self.wipe_enable = true;
            let lt = self.auto_lift_type();
            self.gen_retract(lt, true, None);
            return Ok(());
        }
        // 2. end G-code of the filament that leaves, then the toolchange retraction (text order: retract, labels, end gcode)
        let mut end_gcode = String::new();
        {
            let m = self.mm.as_ref().unwrap();
            let fe = m.fil_s[old_f].text_at("filament_end_gcode", 0);
            if !fe.is_empty() {
                let extra: Vec<(&str, Extra)> = vec![
                    ("current_filament_id", Extra::Scalar(V::Int(old_f as i64))), ("current_nozzle_id", Extra::Scalar(V::Int(0))),
                    ("layer_num", Extra::Scalar(V::Int(self.layer_index))), ("layer_z", Extra::Scalar(f32v(layer_z))),
                ];
                end_gcode = self.expand("filament_end_gcode", &fe, &extra, base);
                check_add_eol(&mut end_gcode);
            }
        }
        let lift = self.auto_lift_type();
        let mut retract_txt = self.capture(|g| g.retract_for_toolchange(lift, true));
        check_add_eol(&mut retract_txt);
        let labels = self.capture(|g| g.add_object_labels());
        let end_filament_gcode_str = format!("{}{}{}", retract_txt, labels, end_gcode);
        // 3. change_filament_gcode
        let cfg_cg = self.s.text("change_filament_gcode");
        let mut toolchange_str = String::new();
        let mut wipe_next_start = String::new();
        let mut need_travel_after = false;
        if !cfg_cg.is_empty() {
            let (extras, purge_len) = self.change_filament_vars(tcr, old_f, new_f, tcs_bed, layer_z);
            let ex: Vec<(&str, Extra)> = extras.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
            let mut txt = self.expand("change_filament_gcode", &cfg_cg, &ex, base);
            check_add_eol(&mut txt);
            txt.push_str(";_FORCE_RESUME_FAN_SPEED\n");
            self.pos_clear = false;
            if let Some(z) = last_z_in(&txt) { self.pos[2] = z; }
            toolchange_str = txt;
            need_travel_after = true;
            let _ = purge_len;
        }
        if !macro_changes_tool(&toolchange_str, new_f) {
            toolchange_str.push_str(&format!("T{}{}\n", new_f, if self.p.comments { " ; change extruder" } else { "" }));
        }
        // `writer().toolchange(new)`: from here on the writer (retraction, speeds, z-hop) is the NEW filament
        self.set_filament(new_f);
        if need_travel_after {
            let avoid = self.s.flag("prime_tower_skip_points");
            if !avoid {
                wipe_next_start = self.capture(|g| g.travel_to(tcs_bed, Feature::Custom, None));
                check_add_eol(&mut wipe_next_start);
            } else {
                let (lx, ly) = last_xy_in(&toolchange_str);
                let last = [lx.unwrap_or(0.0), ly.unwrap_or(self.pos[1])];
                let bb = self.mm.as_ref().unwrap().bbx_bed;
                let avoid_box = [[bb[0][0] as f64, bb[0][1] as f64], [bb[1][0] as f64, bb[1][1] as f64]];
                let bed = self.p.printable_area.clone();
                let path = path_to_wipe_tower(last, tcs_bed, avoid_box, &bed);
                for (i, p) in path.iter().enumerate() {
                    if i + 1 == path.len() {
                        wipe_next_start = self.capture(|g| g.travel_to(*p, Feature::Custom, None));
                        check_add_eol(&mut wipe_next_start);
                        break;
                    }
                    let t = self.capture(|g| g.travel_to(*p, Feature::Custom, None));
                    toolchange_str.push_str(&t);
                    check_add_eol(&mut toolchange_str);
                }
                self.last_pos = tcs_bed;
            }
        }
        // 4. unretract on the new filament, then its start G-code
        let mut unretract_txt = self.capture(|g| g.gen_unretract());
        check_add_eol(&mut unretract_txt);
        let mut start_gcode = String::new();
        {
            let fsg = self.mm.as_ref().unwrap().fil_s[new_f].text_at("filament_start_gcode", 0);
            if !fsg.is_empty() {
                let extra: Vec<(&str, Extra)> = vec![
                    ("filament_extruder_id", Extra::Scalar(V::Int(new_f as i64))), ("current_filament_id", Extra::Scalar(V::Int(new_f as i64))),
                    ("current_nozzle_id", Extra::Scalar(V::Int(0))), ("layer_num", Extra::Scalar(V::Int(self.layer_index))),
                ];
                start_gcode = self.expand("filament_start_gcode", &fsg, &extra, base);
                check_add_eol(&mut start_gcode);
            }
        }
        let start_filament_gcode_str = format!("{}{}{}", start_gcode, wipe_next_start, unretract_txt);
        // 5. splice the three blocks into the tower text
        let mut piece = String::with_capacity(tcr_text.len() + 4096);
        for l in tcr_text.split_inclusive('\n') {
            match l.trim_end_matches('\n') {
                "[filament_end_gcode]" => piece.push_str(&end_filament_gcode_str),
                "[change_filament_gcode]" => piece.push_str(&toolchange_str),
                "[filament_start_gcode]" => piece.push_str(&start_filament_gcode_str),
                _ => piece.push_str(l),
            }
        }
        if tcr.initial_tool != tcr.new_tool || tcr.is_tool_change { self.mm.as_mut().unwrap().toolchange_count += 1; }
        // E written inside the tower text counts for the filament that is loaded where it is written
        self.account_tower_e(&piece, old_f, new_f);
        let _ = first_layer_idx;
        let _ = is_first_layer;
        self.out.push_str(&piece);
        // 6. a phony move to the end position, the wipe path for the following retraction
        self.pos[0] = end_bed[0]; self.pos[1] = end_bed[1];
        self.last_pos = end_bed;
        self.last_pos_defined = true;
        self.pos_clear = true;
        self.wipe_path = tcr.wipe_path.iter().map(|p| to_bed(*p)).collect();
        self.wipe_enable = true;
        let lt = self.auto_lift_type();
        self.gen_retract(lt, true, None);
        Ok(())
    }

    /// Signed E of the tower text -> usage of the filament that is loaded at that point (before / after the change macro).
    fn account_tower_e(&mut self, piece: &str, old_f: usize, new_f: usize) {
        let mut before = true;
        let mut e_old = 0.0f64; let mut e_new = 0.0f64;
        let mut in_vflush = false;
        for l in piece.lines() {
            let t = l.trim_start();
            if t.starts_with("T") && t[1..].chars().next().map_or(false, |c| c.is_ascii_digit()) && t[1..].trim_start_matches(|c: char| c.is_ascii_digit()).trim_start().starts_with('H') { before = false; }
            if t.starts_with("; VFLUSH_START") { in_vflush = true; continue; }
            if t.starts_with("; VFLUSH_END") { in_vflush = false; continue; }
            if let Some(rest) = t.strip_prefix(";VG1 ") {
                // virtual flush extrusion (between VFLUSH_START/END) of the filament loaded after the change: counts as used filament
                if in_vflush {
                    for w in rest.split_whitespace() { if let Some(v) = w.strip_prefix('E') { if let Ok(e) = v.parse::<f64>() { if before { e_old += e; } else { e_new += e; } } } }
                }
                continue;
            }
            if !(t.starts_with("G1 ") || t.starts_with("G2 ") || t.starts_with("G3 ")) { continue; }
            let body = t.split(';').next().unwrap_or("");
            for w in body.split_whitespace() {
                if let Some(v) = w.strip_prefix('E') {
                    if let Ok(e) = v.parse::<f64>() { if before { e_old += e; } else { e_new += e; } }
                }
            }
        }
        // the text goes through `self.out`, not the writer: keep the writer's E bookkeeping in step
        self.mm_flush_usage();
        let m = self.mm.as_mut().unwrap();
        m.used_e[old_f] += e_old;
        m.used_e[new_f] += e_new;
        self.absolute_e += 0.0;
    }

    /// The placeholders `WipeTowerIntegration::append_tcr` hands to `change_filament_gcode`.
    fn change_filament_vars(&mut self, tcr: &Tcr, old_f: usize, new_f: usize, start_bed: P2, layer_z: f64) -> (Vec<(String, Extra)>, f32) {
        let s = self.s;
        let m = self.mm.as_ref().unwrap();
        let first_layer = self.layer_index == 0;
        let num = |v: i64| Extra::Scalar(V::Int(v));
        let dbl = |v: f64| Extra::Scalar(V::Dbl(v));
        let sf = |f: usize, k: &str| -> f64 { m.fil_s[f].num(k) };
        let temp = |f: usize| -> i64 { if first_layer { sf(f, "nozzle_temperature_initial_layer") as i64 } else { sf(f, "nozzle_temperature") as i64 } };
        let area_new = (std::f64::consts::PI / 4.0 * sf(new_f, "filament_diameter").powi(2)) as f32;
        let purge_volume: f32 = if tcr.purge_volume < 1e-4 { 0.0 } else { tcr.purge_volume.max(100.0) };
        let purge_length: f32 = purge_volume / area_new;
        let e_feed = |f: usize| -> i64 { let v = (60.0 * sf(f, "filament_max_volumetric_speed") as f32 as f64 / area_new as f64) as i64; if v == 0 { 100 } else { v } };
        let old_e_feed = e_feed(old_f);
        let new_e_feed = e_feed(new_f);
        let nfil = m.nfil;
        let (mut fv, mut ft, mut fc): (Vec<V>, Vec<V>, Vec<V>) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..nfil {
            let mut v = sf(i, "filament_flush_volumetric_speed");
            if v == 0.0 { v = sf(i, "filament_max_volumetric_speed"); }
            fv.push(V::Dbl(v));
            let mut t = sf(i, "filament_flush_temp") as i64;
            if t == 0 { t = s.num_at("nozzle_temperature_range_high", i) as i64; }
            ft.push(V::Int(t));
            fc.push(V::Dbl(if tcr.is_contact || self.layer_index == 0 { 0.0 } else { sf(i, "filament_cooling_before_tower") }));
        }
        let outer_w = { let a = m.fil_s[new_f].abs("outer_wall_line_width", self.p.nozzle); if a > 0.0 { a } else { self.p.nozzle } };
        let ow_speed = (m.fil_p[new_f].outer_speed * skirt::rect_mm3(outer_w, self.p.layer_height)).min(m.fil_p[new_f].max_vol_speed);
        let relv = |k: &str| -> f64 { m.fil_s[old_f].num_at(k, old_f) };
        let relv_new = |k: &str| -> f64 { m.fil_s[new_f].num_at(k, new_f) };
        let wt_min = [m.bbx_bed[0][0], m.bbx_bed[0][1]];
        let wt_max = [m.bbx_bed[1][0], m.bbx_bed[1][1]];
        let avoid_x = { let (l, r, d) = (100.0f32, 250.0f32, 110.0f32); let a = wt_max[0] + 3.0; let b = wt_min[0] - 3.0; if a > l && a < r { a } else if b > l && b < r { b } else { d } };
        let flush_count = ((purge_volume / 135.0).round() as i64).min(4);
        let mut v: Vec<(String, Extra)> = vec![
            ("previous_extruder".into(), num(old_f as i64)), ("next_extruder".into(), num(new_f as i64)),
            ("current_hotend".into(), num(-1)), ("next_hotend".into(), num(-1)),
            ("current_nozzle_id".into(), num(0)), ("next_nozzle_id".into(), num(0)),
            ("current_filament_id".into(), num(old_f as i64)), ("next_filament_id".into(), num(new_f as i64)),
            ("old_extruder_variant".into(), Extra::Scalar(V::Str(s.text_at("printer_extruder_variant", 0)))),
            ("new_extruder_variant".into(), Extra::Scalar(V::Str(s.text_at("printer_extruder_variant", 0)))),
            ("layer_num".into(), num(self.layer_index)), ("layer_z".into(), dbl(tcr.print_z as f64)), ("toolchange_z".into(), dbl(layer_z)),
            ("outer_wall_volumetric_speed".into(), dbl(ow_speed)),
            ("max_layer_z".into(), dbl(self.max_layer_z)),
            ("relative_e_axis".into(), Extra::Scalar(V::Bool(self.p.relative_e))),
            ("toolchange_count".into(), num(m.toolchange_count + 1)),
            ("fan_speed".into(), num(0)),
            ("old_retract_length".into(), dbl(m.fil_p[old_f].retract_len)), ("new_retract_length".into(), dbl(m.fil_p[new_f].retract_len)),
            ("filament_retract_length_nc".into(), dbl(m.fil_s[old_f].num("filament_retract_length_nc").max(0.0))),
            ("old_retract_length_toolchange".into(), dbl(relv("retract_length_toolchange"))), ("new_retract_length_toolchange".into(), dbl(relv_new("retract_length_toolchange"))),
            ("new_extruder_retracted_length".into(), dbl(self.retracted)),
            ("old_filament_temp".into(), num(temp(old_f))), ("new_filament_temp".into(), num(temp(new_f))),
            ("x_after_toolchange".into(), dbl(start_bed[0])), ("y_after_toolchange".into(), dbl(start_bed[1])), ("z_after_toolchange".into(), dbl(self.pos[2])),
            ("first_flush_volume".into(), dbl((purge_length / 2.0) as f64)), ("second_flush_volume".into(), dbl((purge_length / 2.0) as f64)),
            ("old_filament_e_feedrate".into(), num(old_e_feed)), ("new_filament_e_feedrate".into(), num(new_e_feed)),
            ("travel_point_1_x".into(), dbl(54.0)), ("travel_point_1_y".into(), dbl(0.0)),
            ("travel_point_2_x".into(), dbl(54.0)), ("travel_point_2_y".into(), dbl(0.0)),
            ("travel_point_3_x".into(), dbl(54.0)), ("travel_point_3_y".into(), dbl(245.0)),
            ("flush_volumetric_speeds".into(), Extra::Vector(fv)), ("flush_temperatures".into(), Extra::Vector(ft)), ("filament_cooling_before_tower".into(), Extra::Vector(fc)),
            ("flush_length".into(), dbl(purge_length as f64)),
            ("wipe_avoid_perimeter".into(), Extra::Scalar(V::Bool(s.flag("prime_tower_skip_points")))), ("wipe_avoid_pos_x".into(), dbl(avoid_x as f64)),
            ("is_prime_tower_interface".into(), Extra::Scalar(V::Bool(tcr.is_contact))),
            ("filament_tower_interface_purge_volume".into(), dbl(m.fil_s[new_f].num("filament_tower_interface_purge_volume"))),
            ("filament_tower_interface_print_temp".into(), num({ let t = m.fil_s[new_f].num("filament_tower_interface_print_temp") as i64; if t == -1 { m.fil_s[new_f].num("nozzle_temperature_range_high") as i64 } else { t } })),
            ("wipe_tower_center_pos_x".into(), dbl(start_bed[0] + if start_bed[0] < ((wt_min[0] + wt_max[0]) / 2.0) as f64 { -2.0 } else { 2.0 })),
            ("wipe_tower_center_pos_y".into(), dbl(start_bed[1])), ("wipe_tower_center_pos_valid".into(), Extra::Scalar(V::Bool(true))),
            ("has_wipe_tower".into(), Extra::Scalar(V::Bool(true))),
        ];
        // flush_length_1..4
        let unit = if flush_count > 0 { purge_length / flush_count as f32 } else { 0.0 };
        for k in 0..4 { v.push((format!("flush_length_{}", k + 1), dbl(if (k as i64) < flush_count { unit as f64 } else { 0.0 }))); }
        (v, purge_length)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// the layer
// ---------------------------------------------------------------------------------------------------------------

impl<'a> Gen<'a> {
    /// `GCode::process_layer` for a multi-material layer: for every filament in tool order [skirt] [tower piece / tool change]
    /// [that filament's objects].
    pub(super) fn process_layer_mm(&mut self, li: usize, plan: &LayerPlan, islands_f: &[(Vec<Island>, Island)], sup_f: &[Vec<Stroke>],
                                   skirt_loops: &[Stroke], brim: &[Stroke], base: &BTreeMap<String, Extra>) -> Result<(), FdmError> {
        let (first_layer, lift) = self.begin_layer(li, plan, base);
        let order = self.mm.as_ref().unwrap().orders[li].clone();
        let tower_k = self.mm.as_ref().unwrap().tower_of_layer[li];
        let mut tool_idx = 0usize;
        let nseg = order.len();
        for (k, &f) in order.iter().enumerate() {
            let is_last = k + 1 == nseg;
            if k == 0 { self.print_skirt(li, plan, skirt_loops, first_layer); }
            let cur = self.mm.as_ref().unwrap().cur;
            if let Some(tk) = tower_k {
                if f != cur || is_last {
                    let tcr = {
                        let m = self.mm.as_ref().unwrap();
                        m.tower.layers[tk].get(tool_idx).cloned()
                    };
                    let Some(tcr) = tcr else { return Err(FdmError::Geometry(format!("wipe tower generation failed: layer {} has no tower piece number {}", li, tool_idx))) };
                    tool_idx += 1;
                    self.emit_tcr(&tcr, f, base)?;
                }
            } else if f != cur {
                // no tower on this layer (cannot happen: a change needs a partition) -> a bare tool change
                let t = format!("T{}\n", f);
                self.out.push_str(&t);
                self.set_filament(f);
            }
            let brim_here: &[Stroke] = if k == 0 { brim } else { &[] };
            let (isl, extra) = &islands_f[f];
            self.print_objects(li, plan, isl, extra, brim_here, first_layer, sup_f[f].clone());
        }
        self.end_layer(plan, lift, base);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// start / end of the file
// ---------------------------------------------------------------------------------------------------------------

/// `Print::first_layer_wipe_tower_corners`: the tower's corners plus its stabilisation-cone circle, bed mm.
pub(super) fn tower_hull_points(m: &MmCtx, s: &Settings) -> Vec<P2> {
    if m.tower.layers.is_empty() { return Vec::new(); }
    let bb = m.bbx_bed;
    let (width, depth) = ((bb[1][0] - bb[0][0]) as f64, (bb[1][1] - bb[0][1]) as f64);
    // Orca: pt0 = bbx.min + rib_offset (+ tower position) == the outline box corner in bed coordinates
    let p0 = [bb[0][0] as f64, bb[0][1] as f64];
    let mut pts = vec![p0, [p0[0] + width, p0[1]], [p0[0] + width, p0[1] + depth], [p0[0], p0[1] + depth]];
    let center = [(pts[0][0] + pts[2][0]) / 2.0, (pts[0][1] + pts[2][1]) / 2.0];
    let angle = s.num("wipe_tower_cone_angle");
    let height = m.tower.height as f64;
    let r0 = (angle / 2.0).to_radians().tan() * height;
    let fake_width = 0.66 * s.num("prime_tower_width");
    let diag = (fake_width / 2.0).hypot(m.tower.depth as f64 / 2.0);
    let mut support_scale = 1.0;
    if r0 > diag {
        let w = fake_width;
        let sin = 0.5 * m.tower.depth as f64 / diag;
        let tan = m.tower.depth as f64 / w;
        let t = (r0 - diag) * sin;
        support_scale = (w / 2.0 + t / tan + t * tan) / (w / 2.0);
    }
    let r = r0 + m.tower.brim_width as f64;
    let mut a = 0.0f64;
    while a < 2.0 * std::f64::consts::PI {
        pts.push([center[0] + r * a.cos() / support_scale, center[1] + r * a.sin()]);
        a += std::f64::consts::PI / 20.0;
    }
    pts
}

impl<'a> Gen<'a> {
    /// `; filament used [mm] = a, b` ... for every filament (shared extruder: signed E written while the filament was loaded).
    pub(super) fn mm_stats(&mut self) -> String {
        self.mm_flush_usage();
        let m = self.mm.as_ref().unwrap();
        let (mut mm_, mut cm3, mut g, mut cost) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut tmm, mut tcm3, mut tg, mut tcost) = (0.0, 0.0, 0.0, 0.0);
        for f in 0..m.nfil {
            let d = m.fil_s[f].num("filament_diameter");
            let area = std::f64::consts::PI * d * d / 4.0;
            let used = m.used_e[f];
            let c = used * area * 0.001;
            let gr = c * m.fil_s[f].num("filament_density");
            let co = gr * m.fil_s[f].num("filament_cost") * 0.001;
            mm_.push(format!("{:.2}", used)); cm3.push(format!("{:.2}", c)); g.push(format!("{:.2}", gr)); cost.push(format!("{:.2}", co));
            tmm += used; tcm3 += c; tg += gr; tcost += co;
        }
        self.st.filament_mm = tmm; self.st.filament_cm3 = tcm3; self.st.filament_g = tg; self.st.filament_cost = tcost;
        format!("; filament used [mm] = {}\n; filament used [cm3] = {}\n; filament used [g] = {}\n; filament cost = {}\n", mm_.join(", "), cm3.join(", "), g.join(", "), cost.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ref_text(name: &str) -> Option<String> {
        let dir = std::env::var("FDM_M4B_REF").unwrap_or_else(|_| "/tmp/fdm-m4b/ref".into());
        std::fs::read_to_string(format!("{}/{}/plate_1.gcode", dir, name)).ok()
    }

    /// Orca's own paths (tower paths dropped) with the filament of every path decided by the object they lie in.
    fn roundtrip(name: &str, nfil: usize) -> Option<(Vec<LayerPlan>, MultiMaterial, Settings, String)> {
        let txt = ref_text(name)?;
        let s = Settings::from_config_block(&txt);
        let mut plans = crate::motion::testutil::plans_from_gcode(&txt);
        // object x ranges from layer 0: paths before the first tower path are filament 0, after it filament 1
        let mut ranges: Vec<[f64; 2]> = vec![[1e9, -1e9]; nfil];
        let mut cur = 0usize;
        for p in &plans[0].paths {
            if p.feature == Feature::Skirt || p.feature == Feature::Brim { continue; }
            if p.feature == Feature::PrimeTower { if cur + 1 < nfil && ranges[cur][0] < 1e8 { cur += 1; } continue; }
            for q in &p.pts { ranges[cur][0] = ranges[cur][0].min(q.x); ranges[cur][1] = ranges[cur][1].max(q.x); }
        }
        let mut table: Vec<Vec<usize>> = Vec::new();
        for pl in plans.iter_mut() {
            pl.paths.retain(|p| p.feature != Feature::PrimeTower && p.feature != Feature::Skirt && p.feature != Feature::Brim);
            let row: Vec<usize> = pl.paths.iter().map(|p| {
                let x = p.pts[0].x;
                (0..nfil).min_by(|&a, &b| {
                    let d = |k: usize| if x < ranges[k][0] { ranges[k][0] - x } else if x > ranges[k][1] { x - ranges[k][1] } else { 0.0 };
                    d(a).partial_cmp(&d(b)).unwrap()
                }).unwrap()
            }).collect();
            table.push(row);
        }
        let mm = MultiMaterial { path_filament: table, filament_count: Some(nfil), ..Default::default() };
        Some((plans, mm, s, txt))
    }

    #[test]
    fn orders_and_partitions() {
        let flush = vec![vec![0.0, 17.0, 25.0], vec![25.0, 0.0, 30.0], vec![25.0, 5.0, 0.0]];
        let sets = vec![vec![0, 1], vec![0, 1], vec![2], vec![1, 2]];
        let o = tool_orders(&sets, &flush);
        assert_eq!(o[0], vec![0, 1]);
        assert_eq!(o[1], vec![1, 0]);
        let t = tower_layers(&o);
        assert!(t.iter().all(|&b| b));
    }

    #[test]
    fn two_filament_roundtrip() {
        let name = std::env::var("FDM_M4B_CASE").unwrap_or_else(|_| "v1".into());
        let Some((plans, mm, s, _txt)) = roundtrip(&name, 2) else { eprintln!("PENDING: no reference {}", name); return; };
        let mut opts = GcodeOptions::default();
        opts.roundtrip = true;
        opts.multi = Some(mm);
        let out = generate(&plans, &s, &opts).expect("generate");
        std::fs::write(format!("/tmp/fdm-m4b/out_{}.gcode", name), &out.gcode).unwrap();
        eprintln!("issues: {:?}", out.issues);
        eprintln!("stats: {:?}", out.stats.retractions);
    }
}

#[cfg(test)]
mod time_tests {
    use super::*;
    #[test]
    fn estimator_on_orca_multi_material_file() {
        let dir = std::env::var("FDM_M4B_REF").unwrap_or_else(|_| "/tmp/fdm-m4b/ref".into());
        let Ok(txt) = std::fs::read_to_string(format!("{}/v1/plate_1.gcode", dir)) else { eprintln!("PENDING"); return; };
        let s = Settings::from_config_block(&txt);
        let est = crate::motion::time::estimate(&txt, &s);
        let (m, t) = crate::motion::time::parse_header_times(&txt).unwrap();
        eprintln!("EST on orca file: model {:.0} total {:.0}  (header says {:.0} / {:.0})", est.model_s, est.total_s, m, t);
    }
}
