//! Port of `GCode/CoolingBuffer.cpp`: per-layer slow-down for minimum layer time and fan control.
//!
//! The generator writes each layer's G-code with Orca's marker comments (`;_EXTRUDE_SET_SPEED`,
//! `;_EXTERNAL_PERIMETER`, `;_WIPE`, `;_EXTRUDE_END`, `;_OVERHANG_FAN_START/END`, `;_INTERNAL_BRIDGE_FAN_...`,
//! `;_SUPP_INTERFACE_FAN_...`, `;_IRONING_FAN_...`) and this module post-processes the text exactly like Orca:
//! it parses every G0/G1/G2/G3, computes the layer time, stretches adjustable extrusions (fastest first, down to
//! `slow_down_min_speed`) until `slow_down_layer_time`, emits `M106` fan commands from `fan_min_speed`/`fan_max_speed`
//! interpolated over the layer time, removes redundant `F` words and deletes the markers.
//!
//! Single-extruder only (the X2D lane prints one filament); the multi-extruder bucket logic is reduced to one bucket.

use super::settings::Settings;

const TYPE_EXTRUDE_END: u32 = 1 << 1;
const TYPE_OVERHANG_FAN_START: u32 = 1 << 2;
const TYPE_OVERHANG_FAN_END: u32 = 1 << 3;
const TYPE_G0: u32 = 1 << 4;
const TYPE_G1: u32 = 1 << 5;
const TYPE_ADJUSTABLE: u32 = 1 << 6;
const TYPE_EXTERNAL_PERIMETER: u32 = 1 << 7;
const TYPE_HAS_F: u32 = 1 << 8;
const TYPE_WIPE: u32 = 1 << 9;
const TYPE_G4: u32 = 1 << 10;
const TYPE_G92: u32 = 1 << 11;
const TYPE_G2: u32 = 1 << 12;
const TYPE_G3: u32 = 1 << 13;
const TYPE_FORCE_RESUME_FAN: u32 = 1 << 14;
const TYPE_SUPPORT_INTERFACE_FAN_START: u32 = 1 << 15;
const TYPE_SUPPORT_INTERFACE_FAN_END: u32 = 1 << 16;
const TYPE_INTERNAL_BRIDGE_FAN_START: u32 = 1 << 17;
const TYPE_INTERNAL_BRIDGE_FAN_END: u32 = 1 << 18;
const TYPE_IRONING_FAN_START: u32 = 1 << 19;
const TYPE_IRONING_FAN_END: u32 = 1 << 20;
const TYPE_SET_TOOL: u32 = 1 << 21;

const EPSILON: f32 = 1e-4;

#[derive(Clone, Debug)]
struct CoolingLine {
    ty: u32,
    start: usize,
    end: usize,
    length: f32,
    feedrate: f32,
    time: f32,
    time_max: f32,
    slowdown: bool,
    /// extruder (filament) a `T<n>` line switches to (TYPE_SET_TOOL)
    set_tool: usize,
}

impl CoolingLine {
    fn new(ty: u32, start: usize, end: usize) -> Self {
        CoolingLine { ty, start, end, length: 0.0, feedrate: 0.0, time: 0.0, time_max: 0.0, slowdown: false, set_tool: 0 }
    }
    fn adjustable_ext(&self, slowdown_external: bool) -> bool {
        (self.ty & TYPE_ADJUSTABLE) != 0 && ((self.ty & TYPE_EXTERNAL_PERIMETER) == 0 || slowdown_external) && self.time < self.time_max
    }
    fn adjustable(&self) -> bool { (self.ty & TYPE_ADJUSTABLE) != 0 && self.time < self.time_max }
}

#[derive(Default)]
struct Adj {
    cooling_slow_down_enabled: bool,
    slow_down_layer_time: f32,
    slow_down_min_speed: f32,
    dont_slow_down_outer_wall: bool,
    lines: Vec<CoolingLine>,
    n_lines_adjustable: usize,
    time_non_adjustable: f32,
    time_total: f32,
    time_maximum: f32,
    idx_line_begin: usize,
    idx_line_end: usize,
}

impl Adj {
    fn elapsed_time_total(&self) -> f32 { self.lines.iter().map(|l| l.time).sum() }
    fn maximum_time_after_slowdown(&self, ext: bool) -> f32 {
        let mut t = 0.0f32;
        for l in &self.lines {
            if l.adjustable_ext(ext) {
                if l.time_max == f32::MAX { return f32::MAX; }
                t += l.time_max;
            } else { t += l.time; }
        }
        t
    }
    fn adjustable_time(&self, ext: bool) -> f32 { self.lines.iter().filter(|l| l.adjustable_ext(ext)).map(|l| l.time).sum() }
    fn slowdown_to_minimum_feedrate(&mut self, ext: bool) -> f32 {
        let mut t = 0.0f32;
        for l in self.lines.iter_mut() {
            if l.adjustable_ext(ext) {
                l.slowdown = true;
                l.time = l.time_max;
                if l.time > 0.0 { l.feedrate = l.length / l.time; }
            }
            t += l.time;
        }
        self.time_total = t;
        t
    }
    fn slow_down_proportional(&mut self, factor: f32, ext: bool) -> f32 {
        let mut t = 0.0f32;
        for l in self.lines.iter_mut() {
            if l.adjustable_ext(ext) {
                l.slowdown = true;
                l.time = l.time_max.min(l.time * factor);
                if l.time > 0.0 { l.feedrate = l.length / l.time; }
            }
            t += l.time;
        }
        self.time_total = t;
        t
    }
    fn sort_lines_by_decreasing_feedrate(&mut self) {
        // std::sort in Orca is not stable; the comparator orders adjustable first, then by decreasing feedrate.
        self.lines.sort_by(|a, b| {
            let (a1, a2) = (a.adjustable(), b.adjustable());
            if a1 == a2 { b.feedrate.partial_cmp(&a.feedrate).unwrap_or(std::cmp::Ordering::Equal) } else if a1 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }
        });
        let mut n = 0;
        while n < self.lines.len() && self.lines[n].adjustable() { n += 1; }
        self.n_lines_adjustable = n;
        self.time_non_adjustable = self.lines[n..].iter().map(|l| l.time).sum();
    }
    fn time_stretch_when_slowing_down_to_feedrate(&self, min_feedrate: f32) -> f32 {
        let mut ts = 0.0f32;
        for i in 0..self.n_lines_adjustable {
            let l = &self.lines[i];
            if l.feedrate > min_feedrate { ts += l.time * (l.feedrate / min_feedrate - 1.0); }
        }
        ts
    }
    fn slow_down_to_feedrate(&mut self, min_feedrate: f32) {
        let mut t = 0.0f32;
        for i in 0..self.n_lines_adjustable {
            let l = &mut self.lines[i];
            if l.feedrate > min_feedrate {
                l.time *= (l.feedrate / min_feedrate).max(1.0);
                l.feedrate = min_feedrate;
                l.slowdown = true;
            }
            t += l.time;
        }
        self.time_total = t;
    }
}

fn new_feedrate_to_reach_time_stretch(adjs: &[&Adj], mut min_feedrate: f32, time_stretch: f32, max_iter: usize) -> f32 {
    let mut new_feedrate = min_feedrate;
    for _ in 0..max_iter {
        let mut nomin = 0.0f64;
        let mut denom = time_stretch as f64;
        for a in adjs {
            for i in 0..a.n_lines_adjustable {
                let l = &a.lines[i];
                if l.feedrate > min_feedrate { nomin += l.time as f64 * l.feedrate as f64; denom += l.time as f64; }
            }
        }
        if denom < 0.0 { return min_feedrate; }
        new_feedrate = (nomin / denom) as f32;
        if new_feedrate < min_feedrate + EPSILON { return new_feedrate; }
        let mut not_finished = false;
        'o: for a in adjs {
            for i in 0..a.n_lines_adjustable {
                let l = &a.lines[i];
                if l.feedrate > min_feedrate && l.feedrate < new_feedrate { not_finished = true; break 'o; }
            }
        }
        if !not_finished { return new_feedrate; }
        min_feedrate = new_feedrate;
    }
    new_feedrate
}

pub struct CoolingBuffer {
    pos: Vec<f32>, // x y z e f i j
    fan_speed: i32,
    additional_fan_speed: i32,
    current_fan_speed: i32,
    cfg: CoolCfg,
    /// multi-material: one cooling configuration per filament; `cfg` is the one of `cur_ext`
    cfgs: Vec<CoolCfg>,
    cur_ext: usize,
}

#[derive(Clone)]
struct CoolCfg {
    slow_down_for_layer_cooling: bool,
    slow_down_layer_time: f32,
    slow_down_min_speed: f32,
    dont_slow_down_outer_wall: bool,
    fan_min_speed: f32,
    fan_max_speed: f32,
    fan_cooling_layer_time: f32,
    overhang_fan_speed: i32,
    close_fan_the_first_x_layers: i32,
    full_fan_speed_layer: i32,
    reduce_fan_stop_start_freq: bool,
    additional_cooling_fan_speed: i32,
    auxiliary_fan: bool,
    initial_layer_fan_speed: i32,
    support_interface_fan_speed: i32,
    internal_bridge_fan_speed: i32,
    ironing_fan_speed: i32,
    part_cooling_fan_min_pwm: u32,
    use_relative_e: bool,
    travel_speed: f32,
    #[allow(dead_code)]
    flavor: String,
}

impl CoolCfg {
    fn from(c: &Settings) -> Self {
        CoolCfg {
            slow_down_for_layer_cooling: c.flag("slow_down_for_layer_cooling"),
            slow_down_layer_time: c.num("slow_down_layer_time") as f32,
            slow_down_min_speed: c.num("slow_down_min_speed") as f32,
            dont_slow_down_outer_wall: c.flag("dont_slow_down_outer_wall"),
            fan_min_speed: c.num("fan_min_speed") as f32,
            fan_max_speed: c.num("fan_max_speed") as f32,
            fan_cooling_layer_time: c.num("fan_cooling_layer_time") as f32,
            overhang_fan_speed: c.num("overhang_fan_speed") as i32,
            close_fan_the_first_x_layers: c.num("close_fan_the_first_x_layers") as i32,
            full_fan_speed_layer: c.num("full_fan_speed_layer") as i32,
            reduce_fan_stop_start_freq: c.flag("reduce_fan_stop_start_freq"),
            additional_cooling_fan_speed: c.num("additional_cooling_fan_speed") as i32,
            auxiliary_fan: c.flag("auxiliary_fan"),
            initial_layer_fan_speed: if c.has("initial_layer_fan_speed") { c.num("initial_layer_fan_speed") as i32 } else { -1 },
            support_interface_fan_speed: if c.has("support_material_interface_fan_speed") { c.num("support_material_interface_fan_speed") as i32 } else { -1 },
            internal_bridge_fan_speed: if c.has("internal_bridge_fan_speed") { c.num("internal_bridge_fan_speed") as i32 } else { -1 },
            ironing_fan_speed: if c.has("ironing_fan_speed") { c.num("ironing_fan_speed") as i32 } else { -1 },
            part_cooling_fan_min_pwm: c.num("part_cooling_fan_min_pwm").max(0.0) as u32,
            use_relative_e: c.flag("use_relative_e_distances"),
            travel_speed: c.num("travel_speed") as f32,
            flavor: if c.has("gcode_flavor") { c.text("gcode_flavor") } else { "marlin".into() },
        }
    }
}

/// `GCodeWriter::set_fan` (percent -> `M106 S<0..255>`).
pub fn set_fan(speed_pct: u32, min_pwm: u32, comments: bool) -> String {
    let mut speed = speed_pct;
    if speed > 0 && min_pwm > 0 && speed < min_pwm { speed = min_pwm; }
    if speed == 0 {
        format!("M106 S0{}\n", if comments { " ; disable fan" } else { "" })
    } else {
        format!("M106 S{}{}\n", (255.5 * speed as f64 / 100.0) as u32, if comments { " ; enable fan" } else { "" })
    }
}

pub fn set_additional_fan(speed_pct: u32, comments: bool) -> String {
    format!("M106 P2 S{}{}\n", (255.0 * speed_pct as f64 / 100.0) as i32, if comments { if speed_pct == 0 { " ; disable additional fan " } else { " ; enable additional fan " } } else { "" })
}

impl CoolingBuffer {
    pub fn new(c: &Settings, start_pos: [f64; 3]) -> Self {
        let cfg = CoolCfg::from(c);
        let mut pos = vec![0.0f32; 7];
        pos[0] = start_pos[0] as f32; pos[1] = start_pos[1] as f32; pos[2] = start_pos[2] as f32;
        pos[4] = cfg.travel_speed;
        CoolingBuffer { pos, fan_speed: -1, additional_fan_speed: -1, current_fan_speed: -1, cfg, cfgs: Vec::new(), cur_ext: 0 }
    }

    /// Multi-material buffer: `T<n>` lines switch the per-filament fan/cooling configuration (`change_extruder_set_fan`).
    /// The minimum-layer-time slow-down still uses the parameters of the filament the layer starts with (Orca stretches every
    /// extruder's adjustable moves jointly; approximation, documented in gcode_mm.rs).
    pub fn new_multi(c: &[Settings], start_pos: [f64; 3]) -> Self {
        let mut b = CoolingBuffer::new(&c[0], start_pos);
        b.cfgs = c.iter().map(CoolCfg::from).collect();
        b
    }

    /// Process one layer's G-code. `comments` = `gcode_comments` (fan command comments).
    pub fn process_layer(&mut self, gcode: &str, layer_id: usize, comments: bool) -> String {
        let (mut adj, ) = (self.parse_layer_gcode(gcode),);
        let layer_time = self.calculate_layer_slowdown(&mut adj);
        self.apply_layer_cooldown(gcode, layer_id, layer_time, &adj, comments)
    }

    fn parse_layer_gcode(&mut self, gcode: &str) -> Adj {
        let mut adj = Adj {
            cooling_slow_down_enabled: self.cfg.slow_down_for_layer_cooling,
            slow_down_layer_time: self.cfg.slow_down_layer_time,
            slow_down_min_speed: self.cfg.slow_down_min_speed,
            dont_slow_down_outer_wall: self.cfg.dont_slow_down_outer_wall,
            ..Default::default()
        };
        let mut active_speed_modifier: usize = usize::MAX;
        let mut layer_had_extrusion = false;
        let mut parse_ext = self.cur_ext;
        let bytes = gcode.as_bytes();
        let mut line_start = 0usize;
        while line_start < bytes.len() {
            let mut line_end = line_start;
            while line_end < bytes.len() && bytes[line_end] != b'\n' { line_end += 1; }
            let sline = &gcode[line_start..line_end];
            if line_end < bytes.len() { line_end += 1; }
            let mut line = CoolingLine::new(0, line_start, line_end);
            if sline.starts_with("G0 ") { line.ty = TYPE_G0; }
            else if sline.starts_with("G1 ") { line.ty = TYPE_G1; }
            else if sline.starts_with("G92 ") { line.ty = TYPE_G92; }
            else if sline.starts_with("G2 ") { line.ty = TYPE_G2; }
            else if sline.starts_with("G3 ") { line.ty = TYPE_G3; }
            if line.ty != 0 {
                let mut new_pos = self.pos.clone();
                let mut c = if sline.starts_with("G92 ") { 4 } else { 3 };
                let sb = sline.as_bytes();
                loop {
                    while c < sb.len() && (sb[c] == b' ' || sb[c] == b'\t') { c += 1; }
                    if c >= sb.len() || sb[c] == b';' { break; }
                    let ch = sb[c];
                    let axis: Option<usize> = match ch { b'X'..=b'Z' => Some((ch - b'X') as usize), b'E' => Some(3), b'F' => Some(4), b'I' => Some(5), b'J' => Some(6), _ => None };
                    if let Some(axis) = axis {
                        // atof of the following characters
                        let mut e = c + 1;
                        while e < sb.len() && !(sb[e] == b' ' || sb[e] == b'\t') { e += 1; }
                        let v: f32 = sline[c + 1..e].parse::<f32>().unwrap_or_else(|_| atof(&sline[c + 1..e]));
                        new_pos[axis] = v;
                        if axis == 4 {
                            new_pos[4] /= 60.0;
                            if (line.ty & TYPE_G92) == 0 { line.ty |= TYPE_HAS_F; }
                        } else if axis == 5 || axis == 6 {
                            new_pos[axis] += self.pos[axis - 5];
                        }
                    }
                    while c < sb.len() && sb[c] != b' ' && sb[c] != b'\t' { c += 1; }
                }
                let external_perimeter = sline.contains(";_EXTERNAL_PERIMETER");
                let wipe = sline.contains(";_WIPE");
                if external_perimeter { line.ty |= TYPE_EXTERNAL_PERIMETER; }
                if wipe { line.ty |= TYPE_WIPE; }
                if sline.contains(";_EXTRUDE_SET_SPEED") { layer_had_extrusion = true; }
                let mut adjust_external = true;
                if adj.dont_slow_down_outer_wall && external_perimeter { adjust_external = false; }
                if sline.contains(";_EXTRUDE_SET_SPEED") && !wipe && adjust_external {
                    line.ty |= TYPE_ADJUSTABLE;
                    active_speed_modifier = adj.lines.len();
                }
                if (line.ty & TYPE_G92) == 0 {
                    if self.cfg.use_relative_e { self.pos[3] = 0.0; }
                    let mut dif = [0.0f32; 4];
                    for i in 0..4 { dif[i] = new_pos[i] - self.pos[i]; }
                    let dxy2 = if (line.ty & (TYPE_G2 | TYPE_G3)) != 0 {
                        let d = arc_length(self.pos[0], self.pos[1], new_pos[0], new_pos[1], new_pos[5], new_pos[6], (line.ty & TYPE_G3) != 0);
                        d * d
                    } else { dif[0] * dif[0] + dif[1] * dif[1] };
                    let dxyz2 = dxy2 + dif[2] * dif[2];
                    if dxyz2 > 0.0 { line.length = dxyz2.sqrt(); }
                    else if dif[3].abs() > 0.0 { line.length = dif[3].abs(); }
                    line.feedrate = new_pos[4];
                    if line.length > 0.0 { line.time = line.length / line.feedrate; }
                    line.time_max = line.time;
                    if (line.ty & TYPE_ADJUSTABLE) != 0 || active_speed_modifier != usize::MAX {
                        line.time_max = if adj.slow_down_min_speed == 0.0 { f32::MAX } else { line.time.max(line.length / adj.slow_down_min_speed) };
                    }
                    if active_speed_modifier < adj.lines.len() && (line.ty & (TYPE_G1 | TYPE_G2 | TYPE_G3)) != 0 {
                        let sm = &mut adj.lines[active_speed_modifier];
                        sm.length += line.length;
                        sm.time += line.time;
                        if sm.time_max != f32::MAX {
                            if line.time_max == f32::MAX { sm.time_max = f32::MAX; } else { sm.time_max += line.time_max; }
                        }
                        line.ty = 0;
                    }
                }
                self.pos = new_pos;
            } else if sline.starts_with(";_EXTRUDE_END") {
                line.ty = TYPE_EXTRUDE_END;
                active_speed_modifier = usize::MAX;
            } else if sline.starts_with("T") && sline.len() > 1 && sline.as_bytes()[1].is_ascii_digit() {
                // multi-material: a tool change (single extruder: nothing to bucket)
                if !self.cfgs.is_empty() {
                    let digits: String = sline[1..].chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(n) = digits.parse::<usize>() {
                        if n < self.cfgs.len() && n != parse_ext { line.ty = TYPE_SET_TOOL; line.set_tool = n; parse_ext = n; }
                    }
                }
            } else if sline.starts_with(";_OVERHANG_FAN_START") { line.ty = TYPE_OVERHANG_FAN_START; }
            else if sline.starts_with(";_OVERHANG_FAN_END") { line.ty = TYPE_OVERHANG_FAN_END; }
            else if sline.starts_with(";_INTERNAL_BRIDGE_FAN_START") { line.ty = TYPE_INTERNAL_BRIDGE_FAN_START; }
            else if sline.starts_with(";_INTERNAL_BRIDGE_FAN_END") { line.ty = TYPE_INTERNAL_BRIDGE_FAN_END; }
            else if sline.starts_with(";_SUPP_INTERFACE_FAN_START") { line.ty = TYPE_SUPPORT_INTERFACE_FAN_START; }
            else if sline.starts_with(";_SUPP_INTERFACE_FAN_END") { line.ty = TYPE_SUPPORT_INTERFACE_FAN_END; }
            else if sline.starts_with(";_IRONING_FAN_START") { line.ty = TYPE_IRONING_FAN_START; }
            else if sline.starts_with(";_IRONING_FAN_END") { line.ty = TYPE_IRONING_FAN_END; }
            else if sline.starts_with("G4 ") {
                line.ty = TYPE_G4;
                let ps = sline[3..].find('S').map(|p| p + 3);
                let pp = sline[3..].find('P').map(|p| p + 3);
                // Orca (`CoolingBuffer.cpp`): `(pos_S > 0) ? atof(c_str()+pos_S+1) : (pos_P > 0) ? atof(..P..)*0.001 : 0`.
                // `pos_S` is a size_t, so `npos > 0` is TRUE when there is no `S`: the first branch is always taken and
                // `c_str() + npos + 1` wraps to `c_str()`, i.e. `atof("G4 P100")` = 0. A `G4 P<ms>` dwell therefore counts
                // as ZERO layer time in Orca (the `P` branch is dead code). Reproduced on purpose, not "fixed".
                let _ = pp;
                let t = match ps {
                    Some(p) => atof(&sline[p + 1..]),
                    None => 0.0,
                };
                line.time = t; line.time_max = t;
            } else if sline.starts_with(";_FORCE_RESUME_FAN_SPEED") { line.ty = TYPE_FORCE_RESUME_FAN; }
            if !layer_had_extrusion {
                line.time = 0.0; line.time_max = 0.0;
            }
            if line.ty != 0 { adj.lines.push(line); }
            line_start = line_end;
        }
        adj
    }

    fn calculate_layer_slowdown(&self, adj: &mut Adj) -> f32 {
        adj.time_total = adj.elapsed_time_total();
        adj.time_maximum = adj.maximum_time_after_slowdown(true);
        let mut elapsed_time_total0 = 0.0f32;
        if adj.cooling_slow_down_enabled && !adj.lines.is_empty() {
            adj.sort_lines_by_decreasing_feedrate();
            let total = elapsed_time_total0 + adj.time_total;
            let slow_down_layer_time = adj.slow_down_layer_time * 1.001;
            if total > slow_down_layer_time {
                // nothing to adjust
            } else {
                let max_time = elapsed_time_total0 + adj.time_maximum;
                if max_time > slow_down_layer_time {
                    extruder_range_slow_down_non_proportional(adj, slow_down_layer_time - total);
                } else {
                    adj.slowdown_to_minimum_feedrate(true);
                }
            }
            elapsed_time_total0 += adj.elapsed_time_total();
        } else {
            elapsed_time_total0 += adj.elapsed_time_total();
        }
        elapsed_time_total0
    }

    #[allow(unused_assignments)]
    fn apply_layer_cooldown(&mut self, gcode: &str, layer_id: usize, layer_time: f32, adj: &Adj, comments: bool) -> String {
        // lines sorted by position in the source G-code
        let mut lines: Vec<&CoolingLine> = adj.lines.iter().collect();
        lines.sort_by_key(|l| l.start);
        let mut new_gcode = String::with_capacity(gcode.len() * 2);
        let min_pwm = self.cfg.part_cooling_fan_min_pwm;
        let mut overhang_fan_control = false; let mut overhang_fan_speed = 0i32;
        let mut internal_bridge_fan_control = false; let mut internal_bridge_fan_speed = 0i32;
        let mut supp_interface_fan_control = false; let mut supp_interface_fan_speed = 0i32;
        let mut ironing_fan_control = false; let mut ironing_fan_speed = 0i32;

        // change_extruder_set_fan(true) (a macro: it assigns the fan locals above, once now and again at every tool change)
        macro_rules! change_extruder_set_fan { () => {{
            let c = &self.cfg;
            let fan_min_speed = c.fan_min_speed;
            let mut fan_speed_new: i32 = if c.reduce_fan_stop_start_freq { fan_min_speed as i32 } else { 0 };
            let mut additional_fan_speed_new = c.additional_cooling_fan_speed;
            let close_fan = c.close_fan_the_first_x_layers;
            let full_fan = c.full_fan_speed_layer;
            let init_fan = c.initial_layer_fan_speed;
            let has_override = init_fan >= 0 && close_fan <= 0;
            if has_override && layer_id == 0 {
                fan_speed_new = init_fan;
                overhang_fan_speed = init_fan; overhang_fan_control = false;
                internal_bridge_fan_speed = init_fan; internal_bridge_fan_control = false;
                supp_interface_fan_speed = init_fan; supp_interface_fan_control = false;
                ironing_fan_speed = init_fan; ironing_fan_control = false;
            } else if layer_id as i32 >= close_fan {
                let fan_max_speed = c.fan_max_speed;
                let slow_down_layer_time = c.slow_down_layer_time;
                let fan_cooling_layer_time = c.fan_cooling_layer_time;
                if layer_time < slow_down_layer_time {
                    fan_speed_new = fan_max_speed as i32;
                } else if layer_time < fan_cooling_layer_time {
                    let t = ((layer_time - slow_down_layer_time) / (fan_cooling_layer_time - slow_down_layer_time)) as f64;
                    fan_speed_new = ((t * fan_min_speed as f64 + (1.0 - t) * fan_max_speed as f64).floor() + 0.5) as i32;
                }
                overhang_fan_speed = c.overhang_fan_speed;
                if layer_id as i32 >= close_fan && (layer_id as i32) + 1 < full_fan {
                    if has_override && close_fan == 0 && full_fan > 1 {
                        let anchor = init_fan as f32;
                        let denom = (full_fan - 1) as f32;
                        let t = layer_id as f32 / denom;
                        fan_speed_new = ((anchor + t * (fan_speed_new as f32 - anchor) + 0.5) as i32).clamp(0, 255);
                        overhang_fan_speed = ((anchor + t * (overhang_fan_speed as f32 - anchor) + 0.5) as i32).clamp(0, 255);
                    } else {
                        let factor = ((layer_id as i32 + 1 - close_fan) as f32) / ((full_fan - close_fan) as f32);
                        fan_speed_new = ((fan_speed_new as f32 * factor + 0.5) as i32).clamp(0, 255);
                        overhang_fan_speed = ((overhang_fan_speed as f32 * factor + 0.5) as i32).clamp(0, 255);
                    }
                }
                supp_interface_fan_speed = c.support_interface_fan_speed;
                supp_interface_fan_control = supp_interface_fan_speed >= 0;
                overhang_fan_control = overhang_fan_speed > fan_speed_new;
                internal_bridge_fan_speed = c.internal_bridge_fan_speed;
                internal_bridge_fan_control = internal_bridge_fan_speed >= 0;
                if internal_bridge_fan_speed < 0 {
                    internal_bridge_fan_speed = overhang_fan_speed;
                    internal_bridge_fan_control = overhang_fan_control;
                }
                ironing_fan_speed = c.ironing_fan_speed;
                ironing_fan_control = ironing_fan_speed >= 0;
            } else {
                overhang_fan_control = false; overhang_fan_speed = 0; fan_speed_new = 0; additional_fan_speed_new = 0;
                supp_interface_fan_control = false; supp_interface_fan_speed = 0;
                internal_bridge_fan_control = false; internal_bridge_fan_speed = 0;
                ironing_fan_control = false; ironing_fan_speed = 0;
            }
            if fan_speed_new != self.fan_speed || self.current_fan_speed != fan_speed_new {
                self.fan_speed = fan_speed_new;
                self.current_fan_speed = fan_speed_new;
                new_gcode.push_str(&set_fan(fan_speed_new.max(0) as u32, min_pwm, comments));
            }
            if additional_fan_speed_new != self.additional_fan_speed {
                self.additional_fan_speed = additional_fan_speed_new;
                if c.auxiliary_fan { new_gcode.push_str(&set_additional_fan(additional_fan_speed_new.max(0) as u32, comments)); }
            }
        }}; }
        change_extruder_set_fan!();

        let mut pos = 0usize;
        let mut current_feedrate: i32 = 0;
        let (mut req_overhang, mut req_ibridge, mut req_supp, mut req_iron, mut req_resume) = (false, false, false, false, false);
        let mut need_set_fan = false;
        for line in lines {
            let (ls, le) = (line.start, line.end);
            if ls > pos { new_gcode.push_str(&gcode[pos..ls]); }
            if (line.ty & TYPE_SET_TOOL) != 0 {
                if line.set_tool != self.cur_ext && line.set_tool < self.cfgs.len() {
                    self.cur_ext = line.set_tool;
                    self.cfg = self.cfgs[self.cur_ext].clone();
                    change_extruder_set_fan!();
                }
                new_gcode.push_str(&gcode[ls..le]);
            } else if (line.ty & TYPE_OVERHANG_FAN_START) != 0 {
                if overhang_fan_control && !req_overhang { need_set_fan = true; req_overhang = true; }
            } else if (line.ty & TYPE_OVERHANG_FAN_END) != 0 {
                if overhang_fan_control && req_overhang { req_overhang = false; }
                need_set_fan = true;
            } else if (line.ty & TYPE_INTERNAL_BRIDGE_FAN_START) != 0 {
                if internal_bridge_fan_control && !req_ibridge { need_set_fan = true; req_ibridge = true; }
            } else if (line.ty & TYPE_INTERNAL_BRIDGE_FAN_END) != 0 {
                if internal_bridge_fan_control && req_ibridge { req_ibridge = false; }
                need_set_fan = true;
            } else if (line.ty & TYPE_SUPPORT_INTERFACE_FAN_START) != 0 {
                if supp_interface_fan_control && !req_supp { req_supp = true; need_set_fan = true; }
            } else if (line.ty & TYPE_SUPPORT_INTERFACE_FAN_END) != 0 && req_supp {
                if supp_interface_fan_control { req_supp = false; }
                need_set_fan = true;
            } else if (line.ty & TYPE_IRONING_FAN_START) != 0 {
                if ironing_fan_control && !req_iron { req_iron = true; need_set_fan = true; }
            } else if (line.ty & TYPE_IRONING_FAN_END) != 0 {
                if ironing_fan_control && req_iron { req_iron = false; }
                need_set_fan = true;
            } else if (line.ty & TYPE_FORCE_RESUME_FAN) != 0 {
                if self.fan_speed != -1 && !(req_overhang || req_ibridge || req_supp || req_iron || req_resume) {
                    req_resume = true; need_set_fan = true;
                }
                if self.additional_fan_speed != -1 && self.cfg.auxiliary_fan { new_gcode.push_str(&set_additional_fan(self.additional_fan_speed.max(0) as u32, comments)); }
            } else if (line.ty & TYPE_EXTRUDE_END) != 0 {
                // just remove this comment
            } else if (line.ty & (TYPE_ADJUSTABLE | TYPE_EXTERNAL_PERIMETER | TYPE_WIPE | TYPE_HAS_F)) != 0 {
                let src = &gcode[ls..le];
                let sb = src.as_bytes();
                // end = start of a comment or end of line
                let mut end = 0usize;
                while end < sb.len() && sb[end] != b';' { end += 1; }
                // F word
                let fpos_rel = src[2..].find(" F").map(|p| p + 2 + 2).unwrap_or(0);
                let new_feedrate: i32;
                let mut modify = false; let mut remove = false;
                let mut end_abs = end;
                new_feedrate = if line.slowdown { (60.0f64 * line.feedrate as f64 + 0.5).floor() as i32 } else { atoi(&src[fpos_rel..]) };
                if new_feedrate == current_feedrate {
                    if (line.ty & (TYPE_ADJUSTABLE | TYPE_EXTERNAL_PERIMETER | TYPE_WIPE)) != 0 || line.length == 0.0 {
                        end_abs = sb.len();
                    } else { remove = true; }
                } else if line.slowdown {
                    modify = true;
                } else {
                    new_gcode.push_str(&src[..end]);
                    current_feedrate = new_feedrate;
                }
                if modify || remove {
                    let mut fp = fpos_rel;
                    if modify {
                        new_gcode.push_str(&src[..fp]);
                        current_feedrate = new_feedrate;
                        new_gcode.push_str(&current_feedrate.to_string());
                    } else {
                        // roll back before the F word
                        let mut f = fp as isize - 2;
                        while f > 0 && (sb[f as usize] == b' ' || sb[f as usize] == b'\t') { f -= 1; }
                        let f = f as usize;
                        if f == 1 && sb[0] == b'G' && (sb[f] == b'1' || sb[f] == b'0') {
                            // only "G1" / "G0" would remain after removing the F part: Orca drops it
                        } else {
                            new_gcode.push_str(&src[..f + 1]);
                        }
                    }
                    // skip the non-whitespace of the F parameter up to comment or EOL
                    while fp < end_abs && sb[fp] != b' ' && sb[fp] != b';' && sb[fp] != b'\n' { fp += 1; }
                    if fp < end_abs {
                        new_gcode.push_str(&src[fp..end_abs]);
                    }
                    // (Orca also tests `new_gcode == "G1"` here, which cannot hold for accumulated output)
                }
                if end_abs < sb.len() {
                    if (line.ty & (TYPE_ADJUSTABLE | TYPE_EXTERNAL_PERIMETER | TYPE_WIPE)) != 0 {
                        let mut comment = src[end_abs..].to_string();
                        comment = comment.replace(";_EXTRUDE_SET_SPEED", "");
                        if (line.ty & TYPE_EXTERNAL_PERIMETER) != 0 { comment = comment.replace(";_EXTERNAL_PERIMETER", ""); }
                        if (line.ty & TYPE_WIPE) != 0 { comment = comment.replace(";_WIPE", ""); }
                        new_gcode.push_str(&comment);
                    } else {
                        new_gcode.push_str(&src[end_abs..]);
                    }
                }
            } else {
                new_gcode.push_str(&gcode[ls..le]);
            }
            if need_set_fan {
                let pm = min_pwm;
                if req_overhang { new_gcode.push_str(&set_fan(overhang_fan_speed.max(0) as u32, pm, comments)); self.current_fan_speed = overhang_fan_speed; }
                else if req_ibridge { new_gcode.push_str(&set_fan(internal_bridge_fan_speed.max(0) as u32, pm, comments)); self.current_fan_speed = internal_bridge_fan_speed; }
                else if req_supp { new_gcode.push_str(&set_fan(supp_interface_fan_speed.max(0) as u32, pm, comments)); self.current_fan_speed = supp_interface_fan_speed; }
                else if req_iron { new_gcode.push_str(&set_fan(ironing_fan_speed.max(0) as u32, pm, comments)); self.current_fan_speed = ironing_fan_speed; }
                else if req_resume && self.current_fan_speed != -1 { new_gcode.push_str(&set_fan(self.current_fan_speed.max(0) as u32, pm, comments)); req_resume = false; }
                else { new_gcode.push_str(&set_fan(self.fan_speed.max(0) as u32, pm, comments)); self.current_fan_speed = self.fan_speed; }
                need_set_fan = false;
            }
            pos = le;
        }
        if pos < gcode.len() { new_gcode.push_str(&gcode[pos..]); }
        new_gcode
    }
}

fn atof(s: &str) -> f32 {
    let t = s.trim_start();
    let mut e = 0;
    let b = t.as_bytes();
    while e < b.len() && (b[e].is_ascii_digit() || b[e] == b'.' || b[e] == b'-' || b[e] == b'+' || b[e] == b'e' || b[e] == b'E') { e += 1; }
    t[..e].parse::<f32>().unwrap_or(0.0)
}

fn atoi(s: &str) -> i32 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut e = 0;
    if e < b.len() && (b[e] == b'-' || b[e] == b'+') { e += 1; }
    while e < b.len() && b[e].is_ascii_digit() { e += 1; }
    t[..e].parse::<i32>().unwrap_or(0)
}

/// `ArcSegment::calc_arc_length`.
fn arc_length(sx: f32, sy: f32, ex: f32, ey: f32, cx: f32, cy: f32, ccw: bool) -> f32 {
    let r = ((sx - cx) * (sx - cx) + (sy - cy) * (sy - cy)).sqrt();
    let a0 = (sy - cy).atan2(sx - cx);
    let a1 = (ey - cy).atan2(ex - cx);
    let mut da = a1 - a0;
    if ccw { if da <= 0.0 { da += 2.0 * std::f32::consts::PI; } } else if da >= 0.0 { da -= 2.0 * std::f32::consts::PI; }
    if (sx - ex).abs() < 1e-6 && (sy - ey).abs() < 1e-6 { da = 2.0 * std::f32::consts::PI; }
    da.abs() * r
}

fn extruder_range_slow_down_non_proportional(adj: &mut Adj, mut time_stretch: f32) {
    // one extruder: by_min_print_speed = [adj]
    adj.idx_line_begin = 0;
    adj.idx_line_end = 0;
    let mut feedrate = 0.0f32;
    if adj.idx_line_begin < adj.n_lines_adjustable && adj.lines[adj.idx_line_begin].feedrate > feedrate { feedrate = adj.lines[adj.idx_line_begin].feedrate; }
    loop {
        adj.idx_line_end = adj.idx_line_begin;
        while adj.idx_line_end < adj.n_lines_adjustable && adj.lines[adj.idx_line_end].feedrate > feedrate - EPSILON { adj.idx_line_end += 1; }
        let mut feedrate_next = 0.0f32;
        if adj.idx_line_end < adj.n_lines_adjustable && adj.lines[adj.idx_line_end].feedrate > feedrate_next { feedrate_next = adj.lines[adj.idx_line_end].feedrate; }
        if adj.slow_down_min_speed == 0.0 {
            let time_adjustable = adj.adjustable_time(true);
            let rate = (time_adjustable + time_stretch) / time_adjustable;
            adj.slow_down_proportional(rate, true);
            return;
        } else {
            let mut feedrate_limit = feedrate_next.max(adj.slow_down_min_speed);
            let mut done = false;
            let time_stretch_max = adj.time_stretch_when_slowing_down_to_feedrate(feedrate_limit);
            if time_stretch_max >= time_stretch {
                feedrate_limit = new_feedrate_to_reach_time_stretch(&[&*adj], feedrate_limit, time_stretch, 20);
                done = true;
            } else { time_stretch -= time_stretch_max; }
            adj.slow_down_to_feedrate(feedrate_limit);
            if done { return; }
        }
        if feedrate_next == 0.0 { break; }
        adj.idx_line_begin = adj.idx_line_end;
        feedrate = feedrate_next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Settings {
        Settings::from_config_block("; slow_down_for_layer_cooling = 1\n; slow_down_layer_time = 12\n; slow_down_min_speed = 10\n; fan_min_speed = 30\n; fan_max_speed = 60\n; fan_cooling_layer_time = 30\n; overhang_fan_speed = 90\n; close_fan_the_first_x_layers = 3\n; reduce_fan_stop_start_freq = 1\n; use_relative_e_distances = 1\n; travel_speed = 1000,1000\n; auxiliary_fan = 0\n; full_fan_speed_layer = 0\n")
    }

    #[test]
    fn fan_off_first_layers_and_dedup_f() {
        let mut cb = CoolingBuffer::new(&cfg(), [0.0, 0.0, 0.0]);
        let layer = "; CHANGE_LAYER\nG1 X10 Y10 F60000\nG1 F3000;_EXTRUDE_SET_SPEED\nG1 X1020 Y10 E1\nG1 X1020 Y1020 E1\n;_EXTRUDE_END\nG1 X30 Y30 F60000\nG1 X40 Y40 F60000\n";
        let out = cb.process_layer(layer, 0, false);
        assert!(out.starts_with("M106 S0\n; CHANGE_LAYER"), "{}", out);
        assert!(out.contains("G1 F3000\n"), "{}", out);
        assert!(!out.contains(";_EXTRUDE"), "{}", out);
        // the second travel F is redundant and removed
        assert!(out.contains("G1 X30 Y30 F60000\nG1 X40 Y40\n"), "{}", out);
    }

    /// Orca counts a `G4 P<ms>` dwell as 0 s of layer time (size_t `npos > 0` quirk, see `parse_layer_gcode`); `G4 S<s>` counts.
    /// Two layers of identical moves, one with `G4 P20000` (20 s in the old port -> fan interpolation moved from the 60 % cap to
    /// the 30 % floor) and one with `G4 S20`.
    #[test]
    fn g4_p_dwell_counts_zero_like_orca_g4_s_counts() {
        let body = |dwell: &str| format!("G1 X0 Y0 F60000\nG1 F6000;_EXTRUDE_SET_SPEED\nG1 X40 Y0 E1\n;_EXTRUDE_END\n{dwell}");
        // 0.4 s of extrusion: 60 % (153) when no dwell time is counted; 20.4 s -> t=0.467 -> 46 % (117)
        let mut a = CoolingBuffer::new(&cfg(), [0.0, 0.0, 0.0]);
        let out_p = a.process_layer(&body("G4 P20000\n"), 5, false);
        assert!(out_p.contains("M106 S153"), "G4 P counts 0 s: {out_p}");
        let mut b = CoolingBuffer::new(&cfg(), [0.0, 0.0, 0.0]);
        let out_s = b.process_layer(&body("G4 S20\n"), 5, false);
        assert!(out_s.contains("M106 S117"), "G4 S counts: {out_s}");
    }

    /// Verified against Orca's own G-code (cube 20 mm, X2D profile): the last layer's chunk run through this buffer gives the
    /// fan value Orca wrote (S125 = 49 % <- layer time <= 18.6 s). 255.5*pct/100 truncation, floor(t*min+(1-t)*max)+0.5.
    #[test]
    fn fan_interpolation_values_match_orca_rounding() {
        for (lt_extrude_s, want) in [(18.3f32, "M106 S125"), (22.5, "M106 S107"), (13.0, "M106 S148"), (40.0, "M106 S76")] {
            let mut cb = CoolingBuffer::new(&cfg(), [0.0, 0.0, 0.0]);
            // 1000 mm at 1000/lt mm/s (> slow_down_min_speed 10) so the layer time is exactly lt, with one 60 mm/s-class feed
            let f = 1000.0 / lt_extrude_s * 60.0;
            let layer = format!("G1 X0 Y0 F60000\nG1 F{f:.3};_EXTRUDE_SET_SPEED\nG1 X1000 Y0 E1\n;_EXTRUDE_END\n");
            let out = cb.process_layer(&layer, 5, false);
            assert!(out.contains(want), "layer time {lt_extrude_s}: want {want}: {out}");
        }
    }

    #[test]
    fn short_layer_is_slowed_to_layer_time() {
        let mut cb = CoolingBuffer::new(&cfg(), [0.0, 0.0, 0.0]);
        // 40 mm at 100 mm/s = 0.4 s of extrusion; slow_down_layer_time 12 s, min speed 10 -> 40 mm / 10 = 4 s max
        let layer = "G1 X0 Y0 F60000\nG1 F6000;_EXTRUDE_SET_SPEED\nG1 X40 Y0 E1\n;_EXTRUDE_END\n";
        let out = cb.process_layer(layer, 5, false);
        assert!(out.contains("F600\n"), "slowed to the 10 mm/s floor: {}", out);
        assert!(out.contains("M106 S153"), "full fan for a short layer: {}", out); // 60% -> 255.5*0.6 = 153
    }
}
