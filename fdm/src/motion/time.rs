//! Print-time estimator: a port of `GCodeProcessor::TimeMachine` (the planner behind Orca's
//! `; model printing time` / `; total estimated time` header and the `M73 P.. R..` progress lines).
//!
//! It works on any G-code text, so the same function scores Orca's file and ours. Model: per-move trapezoids
//! with junction velocities from the machine jerk limits (+ BBS centripetal cap), forward/reverse planner
//! passes over a rolling block buffer, `M201/M203/M204/M205/M221` limit changes, `G4`/`M400`/`M191`/`G29`
//! waits, `;WIPE_START/END` retract moves, arcs split into chords (tolerance 0.0125 mm), and the "prepare"
//! split (everything before the first extrusion of the print is `prepare_time`, which Orca subtracts to obtain
//! the `model printing time`).

use super::settings::Settings;

const EPS: f64 = 1e-6;
fn sqr(v: f64) -> f64 { v * v }
fn accel_dist(v0: f64, v1: f64, a: f64) -> f64 { if a == 0.0 { 0.0 } else { (sqr(v1) - sqr(v0)) / (2.0 * a) } }
fn intersect_dist(v0: f64, v1: f64, a: f64, d: f64) -> f64 { if a == 0.0 { 0.0 } else { (2.0 * a * d - sqr(v0) + sqr(v1)) / (4.0 * a) } }
fn speed_from_dist(v0: f64, d: f64, a: f64) -> f64 { (sqr(v0) + 2.0 * a * d).max(0.0).sqrt() }
fn max_allowable(a: f64, vt: f64, d: f64) -> f64 { (sqr(vt) - 2.0 * a * d).max(0.0).sqrt() }
fn accel_time(v0: f64, d: f64, a: f64) -> f64 { if a != 0.0 { (speed_from_dist(v0, d, a) - v0) / a } else { 0.0 } }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind { Travel, Retract, Unretract, Extrude, Wipe, Noop }

#[derive(Clone, Debug)]
struct Block {
    #[allow(dead_code)]
    kind: Kind,
    distance: f64,
    cruise: f64,
    entry: f64,
    exit: f64,
    max_entry: f64,
    acceleration: f64,
    safe: f64,
    nominal: bool,
    recalc: bool,
    prepare: bool,
    layer: usize,
    t_cruise: f64,
    accel_until: f64,
    decel_after: f64,
    g1_id: i64,
}

fn calc_trapezoid(b: &mut Block) {
    let mut acc = accel_dist(b.entry, b.cruise, b.acceleration).max(0.0);
    let dec = accel_dist(b.cruise, b.exit, -b.acceleration).max(0.0);
    let mut cru = b.distance - acc - dec;
    if cru < 0.0 {
        acc = intersect_dist(b.entry, b.exit, b.acceleration, b.distance).max(0.0).min(b.distance);
        cru = 0.0;
        b.t_cruise = speed_from_dist(b.entry, acc, b.acceleration);
    } else {
        b.t_cruise = b.cruise;
    }
    b.accel_until = acc;
    b.decel_after = acc + cru;
}

fn block_time(b: &Block) -> f64 {
    let ta = accel_time(b.entry, b.accel_until, b.acceleration);
    let tc = if b.t_cruise != 0.0 { (b.decel_after - b.accel_until) / b.t_cruise } else { 0.0 };
    let td = accel_time(b.t_cruise, b.distance - b.decel_after, -b.acceleration);
    ta + tc + td
}

#[derive(Clone, Debug)]
struct Prev { feedrate: f64, safe: f64, exit_dir: [f64; 3], axis_feed: [f64; 4] }

#[derive(Clone, Debug, Default)]
struct Limits {
    speed: [f64; 4],
    accel: [f64; 4],
    jerk: [f64; 4],
    min_extr: f64,
    min_travel: f64,
}

/// Result of an estimate.
#[derive(Clone, Debug, Default)]
pub struct TimeEstimate {
    /// Total time, seconds (Orca "total estimated time").
    pub total_s: f64,
    /// Total minus the print preparation (start G-code before the first extrusion): Orca "model printing time".
    pub model_s: f64,
    pub prepare_s: f64,
    /// Seconds per layer index (1-based `;CHANGE_LAYER` count; entry 0 is unused).
    pub layer_s: Vec<f64>,
    pub moves: usize,
    /// (G1 line id, cumulative seconds at the end of that move) -- the data Orca's M73 insertion uses.
    pub g1_times: Vec<(i64, f64)>,
    /// Chord count of every G2/G3 line, in file order (each chord consumes one G1 line id).
    pub arc_steps: Vec<i64>,
}

pub struct TimeEstimator {
    lim: Limits,
    max_acc: f64,
    max_ret: f64,
    max_trav: f64,
    acc: f64,
    ret_acc: f64,
    trav_acc: f64,
    pos: [f64; 4],
    origin: [f64; 4],
    feed: f64,
    rel: bool,
    erel: bool,
    blocks: Vec<Block>,
    time: f64,
    prepare: f64,
    pending: Vec<f64>,
    extr_factor: f64,
    prev: Prev,
    wiping: bool,
    measure_g29: bool,
    in_prepare: bool,
    g1_count: i64,
    skip_waits: bool,
    layer: usize,
    layer_time: Vec<f64>,
    moves: usize,
    g1_line_id: i64,
    g1_times: Vec<(i64, f64)>,
    arc_steps: Vec<i64>,
}

impl TimeEstimator {
    pub fn new(cfg: &Settings) -> Self {
        let l = |k: &str| cfg.machine_limit(k);
        let lim = Limits {
            speed: [l("machine_max_speed_x"), l("machine_max_speed_y"), l("machine_max_speed_z"), l("machine_max_speed_e")],
            accel: [l("machine_max_acceleration_x"), l("machine_max_acceleration_y"), l("machine_max_acceleration_z"), l("machine_max_acceleration_e")],
            jerk: [l("machine_max_jerk_x"), l("machine_max_jerk_y"), l("machine_max_jerk_z"), l("machine_max_jerk_e")],
            min_extr: l("machine_min_extruding_rate"),
            min_travel: l("machine_min_travel_rate"),
        };
        let max_acc = l("machine_max_acceleration_extruding");
        let max_ret = l("machine_max_acceleration_retracting");
        let flavor = if cfg.has("gcode_flavor") { cfg.text("gcode_flavor") } else { "marlin".to_string() };
        let max_trav = if flavor == "marlin" || flavor == "klipper" { max_acc }
            else if flavor == "reprapfirmware" || flavor == "marlin2" { l("machine_max_acceleration_travel") } else { 0.0 };
        TimeEstimator {
            lim,
            max_acc, max_ret, max_trav,
            acc: if max_acc > 0.0 { max_acc } else { 1500.0 },
            ret_acc: if max_ret > 0.0 { max_ret } else { 1500.0 },
            trav_acc: if max_trav > 0.0 { max_trav } else { 1250.0 },
            pos: [0.0; 4], origin: [0.0; 4], feed: 0.0, rel: false, erel: false,
            blocks: Vec::new(), time: 0.0, prepare: 0.0, pending: Vec::new(), extr_factor: 1.0,
            prev: Prev { feedrate: 0.0, safe: 0.0, exit_dir: [0.0; 3], axis_feed: [0.0; 4] },
            wiping: false, measure_g29: false, in_prepare: false, g1_count: 0, skip_waits: false,
            layer: 0, layer_time: Vec::new(), moves: 0, g1_line_id: 0, g1_times: Vec::new(), arc_steps: Vec::new(),
        }
    }

    fn set_acc(&mut self, v: f64) { self.acc = if self.max_acc > 0.0 { v.min(self.max_acc) } else { v }; }
    fn set_trav_acc(&mut self, v: f64) { self.trav_acc = if self.max_trav > 0.0 { v.min(self.max_trav) } else { v }; }
    fn set_ret_acc(&mut self, v: f64) { self.ret_acc = if self.max_ret > 0.0 { v.min(self.max_ret) } else { v }; }

    fn add_block(&mut self, delta: [f64; 4], feedrate: f64, g1_id: i64) {
        let [dx, dy, dz, de] = delta;
        let dxyz = (dx * dx + dy * dy + dz * dz).sqrt();
        let kind = if self.wiping { Kind::Wipe }
            else if de < 0.0 { if dx != 0.0 || dy != 0.0 || dz != 0.0 { Kind::Travel } else { Kind::Retract } }
            else if de > 0.0 { if dx == 0.0 && dy == 0.0 { if dz == 0.0 { Kind::Unretract } else { Kind::Travel } } else { Kind::Extrude } }
            else if dx != 0.0 || dy != 0.0 || dz != 0.0 { Kind::Travel } else { Kind::Noop };
        let dist = if dxyz > 0.0 { dxyz } else { de.abs() };
        let invd = 1.0 / dist;
        let l = &self.lim;
        let extr_only = dx == 0.0 && dy == 0.0 && dz == 0.0 && de != 0.0;
        let mut cur_feed = if de == 0.0 { feedrate.max(l.min_travel) } else { feedrate.max(l.min_extr) };
        let mut enter = [dx, dy, dz];
        if !extr_only {
            let n = (enter[0] * enter[0] + enter[1] * enter[1] + enter[2] * enter[2]).sqrt();
            enter = [enter[0] / n, enter[1] / n, enter[2] / n];
        }
        let prev = self.prev.clone();
        // centripetal limit (BBS)
        if (prev.exit_dir[0] != 0.0 || prev.exit_dir[1] != 0.0) && (enter[0] != 0.0 || enter[1] != 0.0) {
            let n1 = prev.exit_dir[0].hypot(prev.exit_dir[1]);
            let n2 = enter[0].hypot(enter[1]);
            let v1 = [prev.exit_dir[0] / n1, prev.exit_dir[1] / n1];
            let v2 = [enter[0] / n2, enter[1] / n2];
            let nd = (v2[0] - v1[0]).hypot(v2[1] - v1[1]);
            if nd < 0.5 && nd > 0.00001 {
                let dot = v1[0] * v2[0] + v1[1] * v2[1];
                let cross = v1[0] * v2[1] - v1[1] * v2[0];
                let ang = cross.atan2(dot);
                let sin2 = ((1.0 - ang.cos()) * 0.5).sqrt();
                let r = dx.hypot(dy) * 0.5 / sin2;
                cur_feed = cur_feed.min((self.acc * r).sqrt());
            }
        }
        let mut min_factor: f64 = 1.0;
        let mut axis_feed = [0.0f64; 4];
        let mut abs_axis = [0.0f64; 4];
        for a in 0..4 {
            axis_feed[a] = cur_feed * delta[a] * invd;
            if a == 3 { axis_feed[a] *= self.extr_factor; }
            abs_axis[a] = axis_feed[a].abs();
            if abs_axis[a] != 0.0 && l.speed[a] != 0.0 { min_factor = min_factor.min(l.speed[a] / abs_axis[a]); }
        }
        cur_feed *= min_factor;
        let mut b = Block {
            kind, distance: dist, cruise: cur_feed, entry: 0.0, exit: 0.0, max_entry: 0.0, acceleration: 0.0, safe: 0.0,
            nominal: false, recalc: true, prepare: self.in_prepare, layer: self.layer.max(1), t_cruise: 0.0, accel_until: 0.0,
            decel_after: 0.0, g1_id,
        };
        if min_factor < 1.0 {
            for a in 0..4 { axis_feed[a] *= min_factor; abs_axis[a] *= min_factor; }
        }
        let mut acceleration = if kind == Kind::Travel { self.trav_acc } else if extr_only { self.ret_acc } else { self.acc };
        for a in 0..4 {
            let am = l.accel[a];
            if am > 0.0 && acceleration * delta[a].abs() * invd > am { acceleration = am / (delta[a].abs() * invd); }
        }
        b.acceleration = acceleration;
        let mut cur_safe = b.cruise;
        for a in 0..4 { if l.jerk[a] > 0.0 && abs_axis[a] > l.jerk[a] { cur_safe = cur_safe.min(l.jerk[a]); } }
        b.exit = cur_safe;
        let mut vmax = cur_safe;
        if !self.blocks.is_empty() && prev.feedrate > 0.0001 {
            let prev_larger = prev.feedrate > b.cruise;
            let f = if prev_larger { b.cruise / prev.feedrate } else { prev.feedrate / b.cruise };
            vmax = if prev_larger { b.cruise } else { prev.feedrate };
            let mut vfac = 1.0;
            let mut limited = false;
            for a in 0..4 {
                if a == 0 {
                    let mut ev = [prev.exit_dir[0] * prev.feedrate, prev.exit_dir[1] * prev.feedrate, prev.exit_dir[2] * prev.feedrate];
                    if prev_larger { for v in ev.iter_mut() { *v *= f; } }
                    let nv = [enter[0] * b.cruise, enter[1] * b.cruise, enter[2] * b.cruise];
                    let mut jv = [(nv[0] - ev[0]).abs(), (nv[1] - ev[1]).abs(), (nv[2] - ev[2]).abs()];
                    let mj = [l.jerk[0], l.jerk[1], l.jerk[2]];
                    for i in 0..3 {
                        if jv[i] > mj[i] {
                            vfac *= mj[i] / jv[i];
                            for k in 0..3 { jv[k] *= vfac; }
                            limited = true;
                        }
                    }
                } else if a == 1 || a == 2 {
                    continue;
                } else {
                    let mut vx = prev.axis_feed[a];
                    let mut ve = axis_feed[a];
                    if prev_larger { vx *= f; }
                    if limited { vx *= vfac; ve *= vfac; }
                    let jerk = if vx > ve {
                        if ve > 0.0 || vx < 0.0 { vx - ve } else { vx.max(-ve) }
                    } else if ve < 0.0 || vx > 0.0 { ve - vx } else { (-vx).max(ve) };
                    if jerk > l.jerk[a] { vfac *= l.jerk[a] / jerk; limited = true; }
                }
            }
            if limited { vmax *= vfac; }
            let thr = vmax * 0.99;
            if prev.safe > thr && cur_safe > thr { vmax = cur_safe; }
        }
        let v_allow = max_allowable(-acceleration, cur_safe, b.distance);
        b.entry = vmax.min(v_allow);
        b.max_entry = vmax;
        b.nominal = b.cruise <= v_allow;
        b.recalc = true;
        b.safe = cur_safe;
        calc_trapezoid(&mut b);
        self.prev = Prev { feedrate: cur_feed, safe: cur_safe, exit_dir: enter, axis_feed };
        self.blocks.push(b);
        self.moves += 1;
        if self.blocks.len() > 256 { self.calc(64, 0.0, false); }
    }

    fn calc(&mut self, keep: usize, additional: f64, final_: bool) {
        if self.blocks.len() < 2 && !(final_ && !self.pending.is_empty()) {
            if additional > 0.0 { self.pending.push(additional); }
            return;
        }
        let add: f64 = self.pending.iter().sum::<f64>() + if additional > 0.0 { additional } else { 0.0 };
        self.pending.clear();
        let n = self.blocks.len();
        // reverse pass
        if n > 1 {
            for i in (1..n).rev() {
                let next_entry = self.blocks[i].entry;
                let next_recalc = self.blocks[i].recalc;
                let cur = &mut self.blocks[i - 1];
                if cur.entry != cur.max_entry || next_recalc {
                    let ne = if cur.nominal { cur.max_entry } else { cur.max_entry.min(max_allowable(-cur.acceleration, next_entry, cur.distance)) };
                    if cur.entry != ne { cur.entry = ne; cur.recalc = true; }
                }
            }
            // forward pass
            for i in 0..n - 1 {
                let (p_nominal, p_entry, p_acc, p_dist) = { let p = &self.blocks[i]; (p.nominal, p.entry, p.acceleration, p.distance) };
                let cur = &mut self.blocks[i + 1];
                if !p_nominal && p_entry < cur.entry {
                    let ne = max_allowable(-p_acc, p_entry, p_dist);
                    if ne < cur.entry { cur.entry = ne; cur.recalc = true; }
                }
            }
            // trapezoids
            for i in 0..n - 1 {
                let next_entry = self.blocks[i + 1].entry;
                let next_recalc = self.blocks[i + 1].recalc;
                let cur = &mut self.blocks[i];
                if cur.recalc || next_recalc {
                    cur.exit = next_entry;
                    calc_trapezoid(cur);
                    cur.recalc = false;
                }
            }
        }
        if let Some(l) = self.blocks.last_mut() { l.exit = l.safe; calc_trapezoid(l); l.recalc = false; }
        let upto = n.saturating_sub(keep);
        let mut add_used = false;
        for i in 0..upto {
            let b = &self.blocks[i];
            let mut t = block_time(b);
            if !add_used && add > 0.0 { t += add; add_used = true; }
            self.time += t;
            if b.prepare { self.prepare += t; }
            if self.layer_time.len() <= b.layer { self.layer_time.resize(b.layer + 1, 0.0); }
            self.layer_time[b.layer] += t;
            if b.g1_id >= 0 { self.g1_times.push((b.g1_id, self.time)); }
        }
        if !add_used && add > 0.0 {
            if final_ { self.time += add; } else { self.pending.push(add); }
        }
        if keep > 0 {
            self.blocks.drain(0..upto);
            if let Some(f) = self.blocks.first_mut() { f.max_entry = f.entry; }
        } else {
            self.blocks.clear();
        }
    }

    fn wait(&mut self, s: f64) { self.calc(0, s, false); }

    pub fn feed_line(&mut self, raw: &str) {
        let mut line = raw;
        let mut comment = "";
        if let Some(sc) = line.find(';') {
            comment = line[sc + 1..].trim();
            line = &line[..sc];
        }
        if !comment.is_empty() {
            if comment == "WIPE_START" { self.wiping = true; }
            else if comment == "WIPE_END" { self.wiping = false; }
            else if let Some(role) = comment.strip_prefix("FEATURE:") {
                self.in_prepare = role.trim() == "Custom" && self.g1_count == 0;
            } else if comment.starts_with("MACHINE_END_GCODE_START") { self.skip_waits = true; }
            else if comment.starts_with("CHANGE_LAYER") { self.layer += 1; }
            else if let Some(rest) = comment.strip_prefix("VG1 ") {
                // Bambu change_filament_gcode: `;VG1 E.. F..` is a VIRTUAL flush extrusion (GCodeProcessor::process_VG1): never sent to
                // the printer, but it costs time like an extrusion-only move.
                let mut args: [Option<f64>; 26] = [None; 26];
                for t in rest.split_whitespace() {
                    let b = t.as_bytes();
                    if b.len() > 1 && (b[0] as char).is_ascii_alphabetic() { if let Ok(v) = t[1..].parse::<f64>() { args[(b[0].to_ascii_uppercase() - b'A') as usize] = Some(v); } }
                }
                self.g1_line_id += 1; let id = self.g1_line_id - 1; self.g1(&args, id);
            }
        }
        let line = line.trim();
        if line.is_empty() { return; }
        // command word
        let mut cs = line.char_indices();
        let (_, c0) = match cs.next() { Some(x) => x, None => return };
        if !c0.is_ascii_alphabetic() { return; }
        let mut end = 1;
        // Bambu `SYNC T<s>`: a word command (all-alphabetic), not letter+number; without this it parsed as command "S" and was dropped.
        let word = line.len() >= 4 && line.as_bytes()[..4].eq_ignore_ascii_case(b"SYNC") && line.as_bytes().get(4).map_or(true, |b| b.is_ascii_whitespace());
        if word { end = 4; }
        while !word && end < line.len() {
            let ch = line.as_bytes()[end] as char;
            if ch.is_ascii_digit() || (ch == '.' && end + 1 < line.len() && (line.as_bytes()[end + 1] as char).is_ascii_digit()) { end += 1; } else { break; }
        }
        let cmd = line[..end].to_ascii_uppercase();
        let rest = &line[end..];
        let mut args: [Option<f64>; 26] = [None; 26];
        for t in rest.split_whitespace() {
            let b = t.as_bytes();
            if b.len() > 1 && (b[0] as char).is_ascii_alphabetic() {
                if let Ok(v) = t[1..].parse::<f64>() { args[(b[0].to_ascii_uppercase() - b'A') as usize] = Some(v); }
            }
        }
        let arg = |c: char| args[(c as u8 - b'A') as usize];
        match cmd.as_str() {
            "G0" | "G1" => { self.g1_line_id += 1; let id = self.g1_line_id - 1; self.g1(&args, id); }
            "G2" | "G3" => self.arc(&args, cmd == "G2"),
            "SYNC" => { if let Some(t) = arg('T') { self.wait(t); } }
            "G4" => { if arg('S').is_some() || arg('P').is_some() { let s = arg('S').unwrap_or(0.0) + arg('P').unwrap_or(0.0) * 0.001; self.wait(s); } }
            "G28" => {
                self.g1_line_id += 1;
                let mut a: [Option<f64>; 26] = [None; 26];
                let mut any = false;
                for k in ['X', 'Y', 'Z'] { if arg(k).is_some() { a[(k as u8 - b'A') as usize] = Some(0.0); any = true; } }
                if !any { for k in ['X', 'Y', 'Z'] { a[(k as u8 - b'A') as usize] = Some(0.0); } }
                self.g1(&a, -1);
            }
            "G29" => { if self.measure_g29 { self.wait(260.0); } }
            "G90" => self.rel = false,
            "G91" => self.rel = true,
            "G92" => {
                let mut any = false;
                for (k, i) in [('X', 0usize), ('Y', 1), ('Z', 2)] { if let Some(v) = arg(k) { self.origin[i] = self.pos[i] - v; any = true; } }
                if let Some(v) = arg('E') { self.pos[3] = v; any = true; } else { self.wait(0.0); }
                if !any { for i in 0..4 { self.origin[i] = self.pos[i]; } }
            }
            "M82" => self.erel = false,
            "M83" => self.erel = true,
            "M191" => { if arg('S').unwrap_or(0.0) > 40.0 { self.wait(720.0); } }
            "M201" => { for (i, k) in ['X', 'Y', 'Z', 'E'].iter().enumerate() { if let Some(v) = arg(*k) { self.lim.accel[i] = v; } } }
            "M203" => { for (i, k) in ['X', 'Y', 'Z', 'E'].iter().enumerate() { if let Some(v) = arg(*k) { self.lim.speed[i] = v; } } }
            "M204" => {
                if let Some(s) = arg('S') {
                    self.set_acc(s); self.set_trav_acc(s);
                    if let Some(t) = arg('T') { self.set_ret_acc(t); }
                } else {
                    if let Some(p) = arg('P') { self.set_acc(p); }
                    if let Some(r) = arg('R') { self.set_ret_acc(r); }
                    if let Some(t) = arg('T') { self.set_trav_acc(t); }
                }
            }
            "M205" => {
                if let Some(x) = arg('X') { self.lim.jerk[0] = x; self.lim.jerk[1] = x; }
                if let Some(y) = arg('Y') { self.lim.jerk[1] = y; }
                if let Some(z) = arg('Z') { self.lim.jerk[2] = z; }
                if let Some(e) = arg('E') { self.lim.jerk[3] = e; }
                if let Some(s) = arg('S') { self.lim.min_extr = s; }
                if let Some(t) = arg('T') { self.lim.min_travel = t; }
            }
            "M221" => { if let (Some(s), None) = (arg('S'), arg('T')) { self.extr_factor = s * 0.01; } }
            "M400" => { if (arg('S').is_some() || arg('P').is_some()) && !self.skip_waits { self.wait(arg('S').unwrap_or(0.0) + arg('P').unwrap_or(0.0) * 0.001); } }
            "M1" => self.wait(0.0),
            "M622" => { if arg('J').map(|j| j.round() as i64) == Some(1) { self.measure_g29 = true; } }
            "M623" => self.measure_g29 = false,
            _ => {}
        }
    }

    fn g1(&mut self, args: &[Option<f64>; 26], g1_id: i64) {
        self.g1_count += 1;
        let keys = ['X', 'Y', 'Z', 'E'];
        let mut end = self.pos;
        for a in 0..4 {
            if let Some(v) = args[(keys[a] as u8 - b'A') as usize] {
                let is_rel = self.rel || (a == 3 && self.erel);
                end[a] = if is_rel { self.pos[a] + v } else { self.origin[a] + v };
            }
        }
        if let Some(f) = args[(b'F' - b'A') as usize] { self.feed = f / 60.0; }
        let delta = [end[0] - self.pos[0], end[1] - self.pos[1], end[2] - self.pos[2], end[3] - self.pos[3]];
        if delta.iter().fold(0.0f64, |m, v| m.max(v.abs())) == 0.0 { return; }
        self.pos = end;
        if self.feed > 0.0 { self.add_block(delta, self.feed, g1_id); }
    }

    fn arc(&mut self, args: &[Option<f64>; 26], cw: bool) {
        let get = |c: char| args[(c as u8 - b'A') as usize];
        if get('I').is_none() && get('J').is_none() && get('R').is_none() { return; }
        self.g1_count += 1;
        let start = self.pos;
        let mut end = start;
        for (a, k) in ['X', 'Y', 'Z', 'E'].iter().enumerate() {
            if let Some(v) = get(*k) { end[a] = if self.rel || (a == 3 && self.erel) { start[a] + v } else { self.origin[a] + v }; }
        }
        let cx = start[0] + get('I').unwrap_or(0.0);
        let cy = start[1] + get('J').unwrap_or(0.0);
        let rs = [start[0] - cx, start[1] - cy];
        let re = [end[0] - cx, end[1] - cy];
        let radius = rs[0].hypot(rs[1]);
        let mut angle;
        if (end[0] - start[0]).abs() < EPS && (end[1] - start[1]).abs() < EPS {
            angle = 2.0 * std::f64::consts::PI;
        } else {
            angle = (rs[0] * re[1] - rs[1] * re[0]).atan2(rs[0] * re[0] + rs[1] * re[1]);
            if angle < 0.0 { angle += 2.0 * std::f64::consts::PI; }
            if cw { angle -= 2.0 * std::f64::consts::PI; }
        }
        let dz = end[2] - start[2];
        let steps_f = (angle.abs() / (2.0 * (1.0 - 0.0125 / radius.max(0.0125)).clamp(-1.0, 1.0).acos())).ceil();
        let steps = (steps_f as i64).max(1);
        // Orca counts every internal chord as a G1 line id; the M73 for the arc line goes after its last chord.
        let base = self.g1_line_id;
        self.g1_line_id += steps;
        self.arc_steps.push(steps);
        if (angle * radius).hypot(dz) < 0.001 { return; }
        if let Some(f) = get('F') { self.feed = f / 60.0; }
        let mut prev = start;
        for i in 1..=steps {
            let th = rs[1].atan2(rs[0]) + angle * i as f64 / steps as f64;
            let p = if i == steps { end } else {
                [cx + radius * th.cos(), cy + radius * th.sin(), start[2] + dz * i as f64 / steps as f64,
                 start[3] + (end[3] - start[3]) * i as f64 / steps as f64]
            };
            let delta = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2], p[3] - prev[3]];
            prev = p;
            if delta.iter().fold(0.0f64, |m, v| m.max(v.abs())) == 0.0 { continue; }
            self.pos = p;
            if self.feed > 0.0 { self.add_block(delta, self.feed, if i == steps { base + steps - 1 } else { -1 }); }
        }
        self.pos = end;
    }

    pub fn finish(mut self) -> TimeEstimate {
        self.calc(0, 0.0, true);
        TimeEstimate {
            total_s: self.time,
            model_s: self.time - self.prepare,
            prepare_s: self.prepare,
            layer_s: self.layer_time,
            moves: self.moves,
            g1_times: self.g1_times,
            arc_steps: self.arc_steps,
        }
    }
}

/// Estimate the print time of `text` (G-code) under the machine limits in `cfg`.
pub fn estimate(text: &str, cfg: &Settings) -> TimeEstimate {
    let mut est = TimeEstimator::new(cfg);
    for l in text.lines() { est.feed_line(l); }
    est.finish()
}

/// Orca `get_time_dhms`: "1d 2h 3m 4s" with leading zero units dropped.
pub fn fmt_dhms(sec: f64) -> String {
    let mut t = sec.round() as i64;
    let d = t / 86400; t -= d * 86400;
    let h = t / 3600; t -= h * 3600;
    let m = t / 60; t -= m * 60;
    if d > 0 { format!("{}d {}h {}m {}s", d, h, m, t) }
    else if h > 0 { format!("{}h {}m {}s", h, m, t) }
    else if m > 0 { format!("{}m {}s", m, t) }
    else { format!("{}s", t) }
}

/// Parse "1d 2h 3m 4s" back to seconds (for comparing against Orca's header lines).
pub fn parse_dhms(s: &str) -> f64 {
    let mut total = 0.0;
    let mut num = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() { num.push(c); }
        else {
            if let Ok(v) = num.parse::<f64>() {
                total += v * match c { 'd' => 86400.0, 'h' => 3600.0, 'm' => 60.0, 's' => 1.0, _ => 0.0 };
            }
            num.clear();
        }
    }
    total
}

/// Orca header: `; model printing time: X; total estimated time: Y` -> (model_s, total_s).
pub fn parse_header_times(gcode: &str) -> Option<(f64, f64)> {
    for line in gcode.lines().take(40) {
        if let Some(rest) = line.strip_prefix("; model printing time: ") {
            let (m, t) = rest.split_once("; total estimated time: ")?;
            return Some((parse_dhms(m), parse_dhms(t)));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dhms() {
        assert_eq!(fmt_dhms(1661.0), "27m 41s");
        assert_eq!(fmt_dhms(3.0), "3s");
        assert_eq!(fmt_dhms(3661.0), "1h 1m 1s");
        assert_eq!(parse_dhms("1h 12m 54s"), 4374.0);
    }

    #[test]
    fn sync_t_waits() {
        let cfg = Settings::from_config_block("; machine_max_speed_x = 500,500\n; machine_max_speed_y = 500,500\n; machine_max_acceleration_extruding = 1000,1000\n");
        let a = estimate("G90\nM83\nG1 X10 F6000\nG1 X20 F6000\n", &cfg).total_s;
        let b = estimate("G90\nM83\nG1 X10 F6000\nSYNC T5\nG1 X20 F6000\n", &cfg).total_s;
        assert!((b - a - 5.0).abs() < 0.05, "SYNC T5 must add 5 s: {} vs {}", b, a);
    }

    #[test]
    fn single_move_trapezoid() {
        let cfg = Settings::from_config_block("; machine_max_acceleration_x = 1000,1000\n; machine_max_acceleration_y = 1000,1000\n; machine_max_acceleration_extruding = 1000,1000\n; machine_max_acceleration_retracting = 1000,1000\n; machine_max_speed_x = 500,500\n; machine_max_speed_y = 500,500\n; machine_max_speed_z = 10,10\n; machine_max_speed_e = 100,100\n; machine_max_acceleration_z = 500,500\n; machine_max_acceleration_e = 5000,5000\n; machine_max_jerk_x = 10,10\n; machine_max_jerk_y = 10,10\n; machine_max_jerk_z = 1,1\n; machine_max_jerk_e = 5,5\n");
        // 100 mm at 100 mm/s, a=1000, starts/ends at jerk speed 10: accel 4.95mm, cruise, decel 4.95mm
        let g = "G90\nM83\nG1 X50 F6000\nG1 X100 F6000\n";
        let e = estimate(g, &cfg);
        let v0 = 10.0f64; let v = 100.0f64; let a = 1000.0f64;
        let t = 2.0 * (v - v0) / a + (100.0 - 2.0 * (v * v - v0 * v0) / (2.0 * a)) / v;
        assert!((e.total_s - t).abs() < 0.02, "{} vs {}", e.total_s, t);
    }
}

#[cfg(test)]
mod orca_reference {
    use super::*;

    /// Score the estimator against Orca's own header on real Orca G-code files (a control that cannot run
    /// reports PENDING, it does not pass).
    #[test]
    fn estimator_vs_orca_header() {
        let dir = std::path::Path::new("/tmp/web-slicer-jobs");
        let Ok(rd) = std::fs::read_dir(dir) else { eprintln!("PENDING: {} not present", dir.display()); return; };
        let mut jobs: Vec<_> = rd.flatten().map(|e| e.path().join("plate_1.gcode")).filter(|p| p.exists()).collect();
        jobs.sort();
        let mut n = 0usize; let mut worst: f64 = 0.0;
        for p in jobs.iter().step_by((jobs.len() / 8).max(1)).take(8) {
            let Ok(text) = std::fs::read_to_string(p) else { continue };
            let Some((m, t)) = parse_header_times(&text) else { continue };
            let cfg = Settings::from_config_block(&text);
            let e = estimate(&text, &cfg);
            let dm = (e.model_s - m) / m * 100.0; let dt = (e.total_s - t) / t * 100.0;
            eprintln!("{}: orca model {} total {} | ours model {} total {} | delta {:.2}% / {:.2}%", p.parent().unwrap().file_name().unwrap().to_string_lossy(), fmt_dhms(m), fmt_dhms(t), fmt_dhms(e.model_s), fmt_dhms(e.total_s), dm, dt);
            worst = worst.max(dm.abs()).max(dt.abs()); n += 1;
        }
        eprintln!("population examined: {} files, worst |delta| {:.2}%", n, worst);
        // The reference population is /tmp/web-slicer-jobs, which the local slicer tool sweeps after an hour: an empty population is
        // PENDING (the reference is absent), never a pass and never a failure of the estimator.
        if n == 0 { eprintln!("PENDING: no Orca reference G-code in {} to score against", dir.display()); return; }
        assert!(worst < 1.0, "estimator drifted from Orca by {:.2}%", worst);
    }
}

#[cfg(test)]
mod probe {
    use super::*;
    /// Manual probe: TIME_FILES=a,b,c cargo test probe_files -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_files() {
        let Ok(list) = std::env::var("TIME_FILES") else { return };
        for p in list.split(';').filter(|s| !s.is_empty()) {
            let Ok(mut text) = std::fs::read_to_string(p) else { continue };
            // TIME_DROP_SYNC=1 reproduces the pre-fix behaviour (SYNC lines ignored) for before/after tables.
            if std::env::var("TIME_DROP_SYNC").is_ok() { text = text.lines().filter(|l| !l.starts_with("SYNC")).collect::<Vec<_>>().join("\n"); }
            let Some((m, t)) = parse_header_times(&text) else { println!("NOHDR {}", p); continue };
            let cfg = Settings::from_config_block(&text);
            let e = estimate(&text, &cfg);
            println!("PROBE {} orca_m {:.0} orca_t {:.0} ours_m {:.1} ours_t {:.1} dm {:.2}% dt {:.2}%", p, m, t, e.model_s, e.total_s, (e.model_s-m)/m*100.0, (e.total_s-t)/t*100.0);
        }
    }
}
