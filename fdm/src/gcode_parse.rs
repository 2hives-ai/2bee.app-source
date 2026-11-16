//! lane 8: G-code text -> statistics. Parses any Marlin / Bambu / Orca G-code (Orca's and ours) in one pass.
//!
//! Port and extension of `web-slicer/tools/compare.js` and `tools/layer_lines.js`. What is collected:
//! per FEATURE (`; FEATURE:` names) and per layer: extruded path length, E, move count, line widths seen
//! (`; LINE_WIDTH:`), speeds, retractions, z-hops, bounding box, layer z list, seam start points (first
//! extrusion of each outer-wall loop), fan commands, and the header values Orca writes (time estimates,
//! layer count, filament used mm / cm3 / g).
//!
//! Rules this parser holds itself to (same contract as the rest of the fdm gates):
//! * It REFUSES what it cannot read faithfully (inches, a file with no motion at all) instead of
//!   approximating: `Err(FdmError::Unsupported | Parse)`.
//! * Relative (M83) and absolute (M82) E, G90/G91, G92, and G2/G3 arcs (I/J or R, with P turns) are handled.
//! * Retraction accounting is by DEBT: a negative E opens/extends a retraction, a positive E pays the debt back
//!   first and only the remainder is extrusion. So a wipe-while-retracting move is not extrusion, and an
//!   unretract is not a path.
//! * It reports the SIZE of what it examined (`lines`, `motion_lines`, `extrusion_moves`) so a green over an
//!   empty population cannot hide.
use crate::types::FdmError;
use serde::Serialize;
use std::collections::BTreeMap;

/// Extruding-path width histogram bin: width in whole micrometres -> summed path length (mm).
pub type WidthHist = BTreeMap<u32, f64>;

#[derive(Clone, Debug, Default, Serialize)]
pub struct FeatureStats {
    /// XY path length of extruding moves (arc length for G2/G3), mm.
    pub path_mm: f64,
    /// Filament pushed by those moves, mm of filament (net of retraction debt payoff).
    pub e_mm: f64,
    pub moves: usize,
    pub arcs: usize,
    /// Number of distinct layers this feature appears in.
    pub layers: usize,
    /// Path length by `; LINE_WIDTH:` value (um bin). Moves with no width annotation are in `width_unknown_mm`.
    pub width_hist: WidthHist,
    pub width_unknown_mm: f64,
    pub width_min: Option<f64>,
    pub width_max: Option<f64>,
    /// Length-weighted mean width, mm.
    pub width_mean: Option<f64>,
    /// mm/s from `F`/60 at the time of each extruding move.
    pub speed_min: Option<f64>,
    pub speed_max: Option<f64>,
    /// Length-weighted mean speed, mm/s.
    pub speed_mean: Option<f64>,
    /// Filament cross-section implied by the data: e_mm * filament_area / path_mm, mm^2.
    pub xsec_mm2: Option<f64>,
    #[serde(skip)]
    speed_len: f64,
    #[serde(skip)]
    speed_sum: f64,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct RetractStats {
    pub count: usize,
    pub total_mm: f64,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct ZhopStats {
    pub count: usize,
    pub max_h: f64,
    pub total_h: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct FanCmd {
    /// Layer index the command was issued in; -1 = before the first layer change.
    pub layer: i64,
    /// `P` fan index; -1 = unspecified.
    pub p: i64,
    /// `S` value 0..255 (M107 = 0).
    pub s: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LayerStats {
    pub index: usize,
    pub z: f64,
    pub h: Option<f64>,
    pub path_mm: f64,
    pub e_mm: f64,
    pub moves: usize,
    pub path_by_feature: BTreeMap<String, f64>,
    pub retractions: RetractStats,
    pub zhops: ZhopStats,
    /// Start point of each outer-wall loop (first extrusion after a travel or a feature change).
    pub seams: Vec<[f64; 2]>,
    pub travel_mm: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Header {
    pub total_time_s: Option<f64>,
    pub model_time_s: Option<f64>,
    pub first_layer_time_s: Option<f64>,
    pub layer_count: Option<f64>,
    pub filament_mm: Option<f64>,
    pub filament_cm3: Option<f64>,
    pub filament_g: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Stats {
    /// Population size: how much input this was computed from.
    pub lines: usize,
    pub motion_lines: usize,
    pub extrusion_moves: usize,
    pub layers: Vec<LayerStats>,
    /// Aggregated over layers (the preamble / start G-code is NOT in here, see `preamble`).
    pub features: BTreeMap<String, FeatureStats>,
    /// Everything extruded before the first layer change (purge / prime lines), all features lumped.
    pub preamble: FeatureStats,
    pub preamble_retractions: RetractStats,
    pub retractions: RetractStats,
    pub zhops: ZhopStats,
    /// [xmin, ymin, zmin, xmax, ymax, zmax] over extruding moves inside layers, `Custom` feature excluded.
    pub bbox: Option<[f64; 6]>,
    pub fans: Vec<FanCmd>,
    pub header: Header,
    pub filament_diameter: f64,
    pub e_total_mm: f64,
    pub warnings: Vec<String>,
    /// Segments collected for `ParseOptions::collect` (not serialised).
    #[serde(skip)]
    pub segments: Vec<[f64; 4]>,
}

impl Stats {
    pub fn filament_area(&self) -> f64 {
        std::f64::consts::PI * self.filament_diameter * self.filament_diameter / 4.0
    }
    /// Total extruded filament volume inside layers (all features incl. Custom), cm^3, from E.
    pub fn volume_cm3(&self) -> f64 {
        let e: f64 = self.features.values().map(|f| f.e_mm).sum();
        e * self.filament_area() / 1000.0
    }
    pub fn z_list(&self) -> Vec<f64> {
        self.layers.iter().map(|l| l.z).collect()
    }
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ParseOptions {
    /// Collect XY segments (chord for arcs) of extruding moves of (layer index, feature name) into `Stats::segments`.
    pub collect: Option<(usize, String)>,
}

pub fn parse(text: &str) -> Result<Stats, FdmError> {
    parse_with(text, &ParseOptions::default())
}

const POW10: [f64; 16] = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/// Exact fast path for plain decimals (`-12.3450`, `7`): at most 15 significant digits means the digit string is an
/// integer below 2^53 (exact in an f64), and dividing by an exactly representable power of ten is ONE correctly
/// rounded IEEE operation, so the result is bit-identical to `str::parse::<f64>` (Clinger's fast path). Anything
/// else (exponent, sign `+`, leading/trailing `.`, > 15 digits, inf/nan) returns None and goes to the std parser.
#[inline]
fn fast_decimal(b: &[u8]) -> Option<f64> {
    let (neg, mut i) = match b.first() { Some(b'-') => (true, 1), _ => (false, 0) };
    let mut m: u64 = 0;
    let mut nd = 0usize;
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() { m = m * 10 + (b[i] - b'0') as u64; i += 1; nd += 1; if nd > 15 { return None; } }
    if i == start { return None; }
    let mut frac = 0usize;
    if i < b.len() {
        if b[i] != b'.' { return None; }
        i += 1;
        let fs = i;
        while i < b.len() && b[i].is_ascii_digit() { m = m * 10 + (b[i] - b'0') as u64; i += 1; nd += 1; if nd > 15 { return None; } }
        if i != b.len() || i == fs { return None; }
        frac = i - fs;
    }
    let v = if frac == 0 { m as f64 } else { m as f64 / POW10[frac] };
    Some(if neg { -v } else { v })
}

fn num(s: &str) -> Option<f64> {
    let s = s.trim();
    if let Some(v) = fast_decimal(s.as_bytes()) {
        return Some(v);
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// "1d 2h 3m 4s" -> seconds.
pub fn parse_duration(s: &str) -> Option<f64> {
    let mut tot = 0.0;
    let mut any = false;
    for tok in s.split_whitespace() {
        let unit = tok.chars().last()?;
        let v = num(&tok[..tok.len() - unit.len_utf8()])?;
        tot += v * match unit {
            'd' => 86400.0,
            'h' => 3600.0,
            'm' => 60.0,
            's' => 1.0,
            _ => return None,
        };
        any = true;
    }
    any.then_some(tot)
}

fn norm_angle(a: f64) -> f64 {
    let two = 2.0 * std::f64::consts::PI;
    let mut r = a % two;
    if r < 0.0 {
        r += two;
    }
    r
}

/// Arc geometry for G2 (cw) / G3 (ccw). Returns (length of XY arc, sweep, centre, radius).
fn arc_geom(x0: f64, y0: f64, x1: f64, y1: f64, i: Option<f64>, j: Option<f64>, r: Option<f64>, p: f64, cw: bool) -> Option<(f64, f64, [f64; 2], f64)> {
    let tau = 2.0 * std::f64::consts::PI;
    let (cx, cy);
    if i.is_some() || j.is_some() {
        cx = x0 + i.unwrap_or(0.0);
        cy = y0 + j.unwrap_or(0.0);
    } else if let Some(rr) = r {
        let (dx, dy) = (x1 - x0, y1 - y0);
        let d = dx.hypot(dy);
        if d < 1e-12 {
            return None;
        }
        let h = (rr * rr - d * d / 4.0).max(0.0).sqrt();
        let (mx, my) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let (px, py) = (-dy / d, dx / d);
        let c1 = [mx + h * px, my + h * py];
        let c2 = [mx - h * px, my - h * py];
        // R>0: the minor arc (sweep <= pi); R<0: the major arc.
        let sweep_for = |c: [f64; 2]| {
            let a0 = (y0 - c[1]).atan2(x0 - c[0]);
            let a1 = (y1 - c[1]).atan2(x1 - c[0]);
            if cw { norm_angle(a0 - a1) } else { norm_angle(a1 - a0) }
        };
        let want_minor = rr > 0.0;
        let c = if (sweep_for(c1) <= std::f64::consts::PI + 1e-9) == want_minor { c1 } else { c2 };
        cx = c[0];
        cy = c[1];
    } else {
        return None;
    }
    let rad = (x0 - cx).hypot(y0 - cy);
    if rad < 1e-9 {
        return None;
    }
    let a0 = (y0 - cy).atan2(x0 - cx);
    let a1 = (y1 - cy).atan2(x1 - cx);
    let same = (x1 - x0).hypot(y1 - y0) < 1e-9;
    let mut sweep = if cw { norm_angle(a0 - a1) } else { norm_angle(a1 - a0) };
    if same {
        sweep = tau * p.max(1.0);
    } else if p > 1.0 {
        sweep += tau * (p - 1.0).floor();
    }
    Some((rad * sweep, sweep, [cx, cy], rad))
}

fn arc_bbox(x0: f64, y0: f64, x1: f64, y1: f64, c: [f64; 2], rad: f64, sweep: f64, cw: bool) -> [f64; 4] {
    let mut b = [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)];
    let a0 = (y0 - c[1]).atan2(x0 - c[0]);
    for k in 0..4 {
        let ang = k as f64 * std::f64::consts::FRAC_PI_2;
        let d = if cw { norm_angle(a0 - ang) } else { norm_angle(ang - a0) };
        if d <= sweep + 1e-12 {
            let (px, py) = (c[0] + rad * ang.cos(), c[1] + rad * ang.sin());
            b = [b[0].min(px), b[1].min(py), b[2].max(px), b[3].max(py)];
        }
    }
    b
}

struct Run<'a> {
    opts: &'a ParseOptions,
    st: Stats,
    // machine state
    x: f64,
    y: f64,
    z: f64,
    e_pos: f64,
    e_relative: bool,
    xyz_relative: bool,
    f_mm_min: f64,
    debt: f64,
    // layer / annotation state
    cur: Option<LayerStats>,
    // Feature interning (lane 10): every distinct feature name gets a small id when its `; FEATURE:` comment is
    // read, and the per-move accumulation indexes plain Vecs instead of doing 3-4 BTreeMap<String,_> lookups per
    // move. The BTreeMaps in `Stats` are materialised at layer close / end of parse. Every sum is accumulated
    // in the same order as before, so every float is bit-identical.
    fid: usize,
    names: Vec<String>,
    /// (is outer-wall-like, is "Custom") per id
    fflags: Vec<(bool, bool)>,
    facc: Vec<FeatureStats>,
    ftouched: Vec<bool>,
    /// per-layer path length by id, whether the id has a move in the layer, and whether `layers` was already counted
    lpath: Vec<f64>,
    lhas: Vec<bool>,
    lseen: Vec<bool>,
    width: Option<f64>,
    base_z: Option<f64>,
    in_hop: bool,
    hop_peak: f64,
    outer_open: bool,
}

impl<'a> Run<'a> {
    fn fstats(&mut self) -> &mut FeatureStats {
        if self.cur.is_some() {
            self.ftouched[self.fid] = true;
            &mut self.facc[self.fid]
        } else {
            &mut self.st.preamble
        }
    }

    fn set_feature(&mut self, name: &str) {
        let id = match self.names.iter().position(|n| n == name) {
            Some(i) => i,
            None => {
                self.names.push(name.to_string());
                self.fflags.push((name == "Outer wall" || name == "Overhang wall" || name == "External perimeter", name == "Custom"));
                self.facc.push(FeatureStats::default());
                self.ftouched.push(false);
                self.lpath.push(0.0);
                self.lhas.push(false);
                self.lseen.push(false);
                self.names.len() - 1
            }
        };
        self.fid = id;
    }

    fn close_layer(&mut self) {
        if let Some(mut l) = self.cur.take() {
            for id in 0..self.names.len() {
                if self.lhas[id] {
                    l.path_by_feature.insert(self.names[id].clone(), self.lpath[id]);
                    self.lhas[id] = false;
                    self.lpath[id] = 0.0;
                }
            }
            if l.z.is_nan() {
                l.z = self.z;
            }
            self.st.retractions.count += l.retractions.count;
            self.st.retractions.total_mm += l.retractions.total_mm;
            self.st.zhops.count += l.zhops.count;
            self.st.zhops.total_h += l.zhops.total_h;
            self.st.zhops.max_h = self.st.zhops.max_h.max(l.zhops.max_h);
            self.st.layers.push(l);
        }
    }

    fn open_layer(&mut self) {
        self.close_layer();
        self.cur = Some(LayerStats { index: self.st.layers.len(), z: f64::NAN, ..Default::default() });
        self.base_z = None;
        self.in_hop = false;
        self.hop_peak = 0.0;
        self.outer_open = false;
        self.lseen.iter_mut().for_each(|x| *x = false);
    }

    fn comment(&mut self, c: &str) {
        let c = c.trim();
        if c == "CHANGE_LAYER" || c == "LAYER_CHANGE" {
            self.open_layer();
        } else if let Some(v) = c.strip_prefix("Z_HEIGHT:").or_else(|| c.strip_prefix("Z:")) {
            if let (Some(z), Some(l)) = (num(v), self.cur.as_mut()) {
                if l.z.is_nan() {
                    l.z = z;
                    self.base_z = Some(z);
                }
            }
        } else if let Some(v) = c.strip_prefix("LAYER_HEIGHT:").or_else(|| c.strip_prefix("HEIGHT:")) {
            if let (Some(h), Some(l)) = (num(v), self.cur.as_mut()) {
                l.h = Some(h);
            }
        } else if let Some(v) = c.strip_prefix("FEATURE:").or_else(|| c.strip_prefix("TYPE:")) {
            self.set_feature(v.trim());
        } else if let Some(v) = c.strip_prefix("LINE_WIDTH:").or_else(|| c.strip_prefix("WIDTH:")) {
            self.width = num(v);
        } else {
            self.header_comment(c);
        }
    }

    fn header_comment(&mut self, c: &str) {
        let h = &mut self.st.header;
        for part in c.split(';') {
            let p = part.trim();
            if let Some(v) = p.strip_prefix("model printing time:") {
                h.model_time_s = parse_duration(v).or(h.model_time_s);
            } else if let Some(v) = p.strip_prefix("total estimated time:") {
                h.total_time_s = parse_duration(v).or(h.total_time_s);
            } else if p.starts_with("estimated first layer printing time") {
                if let Some(i) = p.find('=') {
                    h.first_layer_time_s = parse_duration(&p[i + 1..]).or(h.first_layer_time_s);
                }
            } else if let Some(v) = p.strip_prefix("total layer number:") {
                h.layer_count = num(v).or(h.layer_count);
            } else if let Some(v) = p.strip_prefix("filament used [mm]") {
                h.filament_mm = v.trim_start_matches([' ', '=', ':']).split(',').next().and_then(num).or(h.filament_mm);
            } else if let Some(v) = p.strip_prefix("filament used [cm3]") {
                h.filament_cm3 = v.trim_start_matches([' ', '=', ':']).split(',').next().and_then(num).or(h.filament_cm3);
            } else if let Some(v) = p.strip_prefix("filament used [g]") {
                h.filament_g = v.trim_start_matches([' ', '=', ':']).split(',').next().and_then(num).or(h.filament_g);
            } else if let Some(v) = p.strip_prefix("filament_diameter") {
                let v = v.trim_start_matches([' ', '=', ':']);
                if let Some(d) = v.split(',').next().and_then(num) {
                    if d > 0.5 && d < 5.0 && self.st.filament_diameter == 0.0 {
                        self.st.filament_diameter = d;
                    }
                }
            }
        }
    }

    fn bbox_add(&mut self, custom: bool, b: [f64; 4], z: f64) {
        if custom || self.cur.is_none() {
            return;
        }
        let cur = self.st.bbox.get_or_insert([b[0], b[1], z, b[2], b[3], z]);
        cur[0] = cur[0].min(b[0]);
        cur[1] = cur[1].min(b[1]);
        cur[2] = cur[2].min(z);
        cur[3] = cur[3].max(b[2]);
        cur[4] = cur[4].max(b[3]);
        cur[5] = cur[5].max(z);
    }

    fn do_extrude(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, len: f64, e: f64, is_arc: bool, bb: [f64; 4]) {
        let speed = self.f_mm_min / 60.0;
        let width = self.width;
        let z = self.z;
        let id = self.fid;
        let (is_outer, is_custom) = self.fflags[id];
        // seam: first extrusion of an outer-wall loop
        if self.cur.is_some() && is_outer && !self.outer_open {
            if let Some(l) = self.cur.as_mut() {
                l.seams.push([x0, y0]);
            }
        }
        self.outer_open = is_outer;
        if self.base_z.is_none() {
            self.base_z = Some(z);
            if let Some(l) = self.cur.as_mut() {
                if l.z.is_nan() {
                    l.z = z;
                }
            }
        }
        if let Some(l) = self.cur.as_mut() {
            l.path_mm += len;
            l.e_mm += e;
            l.moves += 1;
            self.lpath[id] += len; // starts at 0.0 each layer, like the old entry().or_insert(0.0)
            self.lhas[id] = true;
        }
        let in_layer = self.cur.is_some();
        let new_in_layer = in_layer && !self.lseen[id];
        if new_in_layer {
            self.lseen[id] = true;
        }
        {
            let fs = if in_layer {
                self.ftouched[id] = true;
                &mut self.facc[id]
            } else {
                &mut self.st.preamble
            };
            fs.path_mm += len;
            fs.e_mm += e;
            fs.moves += 1;
            if is_arc {
                fs.arcs += 1;
            }
            if new_in_layer {
                fs.layers += 1;
            }
            match width {
                Some(w) if w > 0.0 => *fs.width_hist.entry((w * 1000.0).round() as u32).or_insert(0.0) += len,
                _ => fs.width_unknown_mm += len,
            }
            fs.speed_min = Some(fs.speed_min.map_or(speed, |v| v.min(speed)));
            fs.speed_max = Some(fs.speed_max.map_or(speed, |v| v.max(speed)));
            fs.speed_len += len;
            fs.speed_sum += len * speed;
        }
        self.st.extrusion_moves += 1;
        self.bbox_add(is_custom, bb, z);
        if let (Some((li, ft)), Some(l)) = (&self.opts.collect, self.cur.as_ref()) {
            if l.index == *li && *ft == self.names[id] {
                self.st.segments.push([x0, y0, x1, y1]);
            }
        }
    }

    /// Apply an E delta to the retraction debt model. Returns the part that is real extrusion.
    fn e_delta(&mut self, de: f64) -> f64 {
        const EPS: f64 = 1e-9;
        if de < -EPS {
            let amount = -de;
            let bucket = if let Some(l) = self.cur.as_mut() { &mut l.retractions } else { &mut self.st.preamble_retractions };
            if self.debt <= EPS {
                bucket.count += 1;
            }
            bucket.total_mm += amount;
            self.debt += amount;
            0.0
        } else if de > EPS {
            if self.debt > EPS {
                let pay = self.debt.min(de);
                self.debt -= pay;
                de - pay
            } else {
                de
            }
        } else {
            0.0
        }
    }

    /// A z-hop is counted when it COMPLETES (the nozzle comes back down to the layer z): a lift that never
    /// returns (end G-code park move) is not a hop.
    fn z_move(&mut self, nz: f64) {
        self.z = nz;
        let Some(base) = self.base_z else { return };
        if nz > base + 0.01 {
            self.in_hop = true;
            self.hop_peak = self.hop_peak.max(nz - base);
        } else if self.in_hop {
            self.in_hop = false;
            let peak = std::mem::take(&mut self.hop_peak);
            if let Some(l) = self.cur.as_mut() {
                l.zhops.count += 1;
                l.zhops.total_h += peak;
                l.zhops.max_h = l.zhops.max_h.max(peak);
            }
        }
    }
}

pub fn parse_with(text: &str, opts: &ParseOptions) -> Result<Stats, FdmError> {
    let mut r = Run {
        opts,
        st: Stats::default(),
        x: 0.0,
        y: 0.0,
        z: 0.0,
        e_pos: 0.0,
        e_relative: false,
        xyz_relative: false,
        f_mm_min: 0.0,
        debt: 0.0,
        cur: None,
        fid: 0,
        names: vec!["Custom".to_string()],
        fflags: vec![(false, true)],
        facc: vec![FeatureStats::default()],
        ftouched: vec![false],
        lpath: vec![0.0],
        lhas: vec![false],
        lseen: vec![false],
        width: None,
        base_z: None,
        in_hop: false,
        hop_peak: 0.0,
        outer_open: false,
    };
    for raw in text.lines() {
        r.st.lines += 1;
        let (code, comment) = match raw.find(';') {
            Some(i) => (&raw[..i], Some(&raw[i + 1..])),
            None => (raw, None),
        };
        if let Some(c) = comment {
            r.comment(c);
        }
        let code = code.trim();
        if code.is_empty() {
            continue;
        }
        let mut toks = code.split_ascii_whitespace();
        let cmd = toks.next().unwrap_or("");
        // no per-line uppercase copy: the letter is compared as an uppercased byte, the digits need no case folding
        let letter = cmd.as_bytes().first().map_or(0u8, |b| b.to_ascii_uppercase());
        let rest = cmd.get(1..).unwrap_or("");
        let cn: i64 = rest.trim_start_matches('0').parse().unwrap_or(if rest.chars().all(|c| c == '0') && !rest.is_empty() { 0 } else { -1 });
        let mut w: [Option<f64>; 26] = [None; 26];
        for t in toks {
            let t = t.as_bytes();
            if t.is_empty() || !t[0].is_ascii_alphabetic() {
                continue;
            }
            let k = (t[0].to_ascii_uppercase() - b'A') as usize;
            w[k] = std::str::from_utf8(&t[1..]).ok().and_then(num);
        }
        let g = |c: char| w[(c as u8 - b'A') as usize];
        match (letter, cn) {
            (b'G', 20) => return Err(FdmError::Unsupported("G20 (inches) is not supported by the parity parser".into())),
            (b'G', 90) => r.xyz_relative = false,
            (b'G', 91) => r.xyz_relative = true,
            (b'M', 82) => r.e_relative = false,
            (b'M', 83) => r.e_relative = true,
            (b'G', 92) => {
                if let Some(e) = g('E') {
                    r.e_pos = e;
                }
                if let Some(v) = g('X') {
                    r.x = v;
                }
                if let Some(v) = g('Y') {
                    r.y = v;
                }
                if let Some(v) = g('Z') {
                    r.z = v;
                }
            }
            (b'M', 106) => {
                let s = g('S').unwrap_or(255.0);
                let p = g('P').map(|v| v as i64).unwrap_or(-1);
                let layer = r.cur.as_ref().map_or(-1, |l| l.index as i64);
                r.st.fans.push(FanCmd { layer, p, s });
            }
            (b'M', 107) => {
                let layer = r.cur.as_ref().map_or(-1, |l| l.index as i64);
                r.st.fans.push(FanCmd { layer, p: g('P').map(|v| v as i64).unwrap_or(-1), s: 0.0 });
            }
            (b'G', 0) | (b'G', 1) | (b'G', 2) | (b'G', 3) => {
                r.st.motion_lines += 1;
                if let Some(f) = g('F') {
                    r.f_mm_min = f;
                }
                let rel = r.xyz_relative;
                let (x0, y0) = (r.x, r.y);
                let nx = g('X').map_or(x0, |v| if rel { x0 + v } else { v });
                let ny = g('Y').map_or(y0, |v| if rel { y0 + v } else { v });
                let nz = g('Z').map_or(r.z, |v| if rel { r.z + v } else { v });
                let de = match g('E') {
                    Some(e) => {
                        if r.e_relative || r.xyz_relative {
                            e
                        } else {
                            let d = e - r.e_pos;
                            r.e_pos = e;
                            d
                        }
                    }
                    None => 0.0,
                };
                if g('E').is_some() && (r.e_relative || r.xyz_relative) {
                    r.e_pos += de;
                }
                // geometry of the XY part
                let mut len = (nx - x0).hypot(ny - y0);
                let mut is_arc = false;
                let mut bb = [x0.min(nx), y0.min(ny), x0.max(nx), y0.max(ny)];
                if cn == 2 || cn == 3 {
                    let cw = cn == 2;
                    match arc_geom(x0, y0, nx, ny, g('I'), g('J'), g('R'), g('P').unwrap_or(1.0), cw) {
                        Some((alen, sweep, c, rad)) => {
                            len = alen;
                            is_arc = true;
                            bb = arc_bbox(x0, y0, nx, ny, c, rad, sweep, cw);
                        }
                        None => {
                            r.st.warnings.push(format!("line {}: arc without usable centre/radius, treated as a chord", r.st.lines));
                        }
                    }
                }
                let xy_move = len > 1e-9;
                let extr = r.e_delta(de);
                r.st.e_total_mm += extr;
                if xy_move && extr > 1e-9 {
                    r.do_extrude(x0, y0, nx, ny, len, extr, is_arc, bb);
                } else {
                    if extr > 1e-9 {
                        // E-only push (prime, unretract surplus): count it as filament but not as a path.
                        r.fstats().e_mm += extr;
                        if let Some(l) = r.cur.as_mut() {
                            l.e_mm += extr;
                        }
                    }
                    if xy_move {
                        r.outer_open = false;
                        if let Some(l) = r.cur.as_mut() {
                            l.travel_mm += len;
                        }
                    }
                }
                r.x = nx;
                r.y = ny;
                if (nz - r.z).abs() > 1e-9 {
                    r.z_move(nz);
                }
            }
            _ => {}
        }
    }
    r.close_layer();
    for (i, n) in r.names.iter().enumerate() {
        if r.ftouched[i] {
            r.st.features.insert(n.clone(), std::mem::take(&mut r.facc[i]));
        }
    }
    let mut st = r.st;
    if st.motion_lines == 0 {
        return Err(FdmError::Parse("no G0/G1/G2/G3 motion lines: not G-code, or empty".into()));
    }
    if st.filament_diameter == 0.0 {
        st.filament_diameter = 1.75;
        st.warnings.push("filament_diameter not found in the file, assumed 1.75".into());
    }
    let area = st.filament_area();
    let fin = |f: &mut FeatureStats| {
        let tot: f64 = f.width_hist.values().sum();
        if tot > 0.0 {
            f.width_min = f.width_hist.keys().next().map(|k| *k as f64 / 1000.0);
            f.width_max = f.width_hist.keys().next_back().map(|k| *k as f64 / 1000.0);
            f.width_mean = Some(f.width_hist.iter().map(|(k, l)| *k as f64 / 1000.0 * l).sum::<f64>() / tot);
        }
        if f.speed_len > 0.0 {
            f.speed_mean = Some(f.speed_sum / f.speed_len);
        }
        if f.path_mm > 0.0 {
            f.xsec_mm2 = Some(f.e_mm * area / f.path_mm);
        }
    };
    for f in st.features.values_mut() {
        fin(f);
    }
    fin(&mut st.preamble);
    for l in &mut st.layers {
        if l.z.is_nan() {
            l.z = 0.0;
        }
    }
    if let Some(n) = st.header.layer_count {
        if n as usize != st.layers.len() {
            st.warnings.push(format!("header says {} layers, {} layer changes counted", n, st.layers.len()));
        }
    }
    Ok(st)
}

/// Port of `tools/layer_lines.js`: for one layer + feature, a histogram of segment directions (whole degrees
/// folded into [0,180)) with total length and the median gap between parallel lines of that direction.
#[derive(Clone, Debug, Serialize)]
pub struct DirStat {
    pub angle_deg: i32,
    pub segs: usize,
    pub total_mm: f64,
    pub median_gap: Option<f64>,
}

pub fn direction_histogram(text: &str, layer: usize, feature: &str) -> Result<Vec<DirStat>, FdmError> {
    let st = parse_with(text, &ParseOptions { collect: Some((layer, feature.to_string())) })?;
    let mut dirs: BTreeMap<i32, Vec<[f64; 4]>> = BTreeMap::new();
    for s in &st.segments {
        let mut a = ((s[3] - s[1]).atan2(s[2] - s[0]).to_degrees()).round() as i32;
        if a < 0 {
            a += 180;
        }
        if a >= 180 {
            a -= 180;
        }
        dirs.entry(a).or_default().push(*s);
    }
    let mut out = Vec::new();
    for (a, ss) in dirs {
        if ss.len() < 3 {
            continue;
        }
        let r = (a as f64).to_radians();
        let mut offs: Vec<f64> = ss.iter().map(|s| -r.sin() * s[0] + r.cos() * s[1]).collect();
        offs.sort_by(|p, q| p.partial_cmp(q).unwrap());
        let mut gaps: Vec<f64> = offs.windows(2).map(|w| w[1] - w[0]).filter(|g| *g > 0.3).collect();
        gaps.sort_by(|p, q| p.partial_cmp(q).unwrap());
        out.push(DirStat {
            angle_deg: a,
            segs: ss.len(),
            total_mm: ss.iter().map(|s| (s[2] - s[0]).hypot(s[3] - s[1])).sum(),
            median_gap: gaps.get(gaps.len() / 2).copied(),
        });
    }
    Ok(out)
}

#[cfg(test)]
const GOLDEN_SYNTH_HASH: u64 = 0xe8cd3daa81639afd;
#[cfg(test)]
mod tests {
    use super::*;

    /// The fast decimal path must be bit-identical to the std parser (it is only ever allowed to decline).
    #[test]
    fn fast_decimal_is_bit_identical_to_std_parse() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
        let (mut taken, mut declined) = (0u32, 0u32);
        for _ in 0..400_000 {
            let r = next();
            let int_digits = 1 + (r % 8) as usize;
            let frac_digits = ((r >> 8) % 9) as usize;
            let mut s = String::new();
            if (r >> 20) & 1 == 1 { s.push('-'); }
            for k in 0..int_digits { s.push((b'0' + ((next() >> 3) % 10) as u8) as char); let _ = k; }
            if frac_digits > 0 { s.push('.'); for _ in 0..frac_digits { s.push((b'0' + ((next() >> 5) % 10) as u8) as char); } }
            let want = s.parse::<f64>().unwrap();
            match fast_decimal(s.as_bytes()) {
                Some(got) => { taken += 1; assert_eq!(got.to_bits(), want.to_bits(), "{s}"); }
                None => declined += 1,
            }
        }
        // shapes that must be declined or equal, never wrong
        for s in ["-0", "0.0", "-0.0", "1e3", ".5", "5.", "+5", "-", "", "1.2.3", "12345678901234567890", "0.1234567890123456789", "inf", "nan", "00012.50"] {
            if let Some(got) = fast_decimal(s.as_bytes()) { assert_eq!(got.to_bits(), s.parse::<f64>().unwrap().to_bits(), "{s}"); }
        }
        assert_eq!(fast_decimal(b"-0").unwrap().to_bits(), (-0.0f64).to_bits());
        assert!(taken > 300_000, "fast path must actually be exercised (taken {taken}, declined {declined})");
    }

    /// Serialised statistics of a fixed synthetic file, hashed: frozen from the pre-optimisation parser.
    #[test]
    fn stats_golden_hash_unchanged_by_optimisation() {
        let g = crate::parity::synthetic_gcode(12, 20.0);
        let st = parse(&g).unwrap();
        let mut h: u64 = 0xcbf29ce484222325;
        for b in serde_json::to_string(&st.to_json()).unwrap().bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
        assert_eq!(h, GOLDEN_SYNTH_HASH, "parser output changed vs the pre-optimisation parser");
    }

    const SQUARE: &str = "; filament_diameter = 1.75\n; total layer number: 2\nM83\nG1 E5 F300\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; LAYER_HEIGHT: 0.2\n\
G1 E-.4 F1800\nG1 X10 Y10 F9000\nG1 Z.6\nG1 Z.2\nG1 E.4 F1800\n; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 F3600\n\
G1 X20 Y10 E.5\nG1 X20 Y20 E.5\nG1 X10 Y20 E.5\nG1 X10 Y10 E.5\n; CHANGE_LAYER\n; Z_HEIGHT: 0.4\n; LAYER_HEIGHT: 0.2\nG1 X10 Y10 Z.4 F9000\n; FEATURE: Outer wall\nG1 X20 Y10 E.5 F3600\nM106 S255\n";

    #[test]
    fn square_basic() {
        let s = parse(SQUARE).unwrap();
        assert_eq!(s.layers.len(), 2);
        let f = &s.features["Outer wall"];
        assert!((f.path_mm - 50.0).abs() < 1e-9, "{}", f.path_mm);
        assert!((f.e_mm - 2.5).abs() < 1e-9);
        assert_eq!(f.width_min, Some(0.42));
        assert_eq!(f.width_hist.get(&420).copied().map(|v| (v - 50.0).abs() < 1e-9), Some(true));
        assert!((f.speed_mean.unwrap() - 60.0).abs() < 1e-9);
        assert_eq!(s.retractions.count, 1);
        assert!((s.retractions.total_mm - 0.4).abs() < 1e-9);
        assert_eq!(s.zhops.count, 1);
        assert!((s.zhops.max_h - 0.4).abs() < 1e-9);
        assert_eq!(s.layers[0].seams, vec![[10.0, 10.0]]);
        assert_eq!(s.layers[1].seams.len(), 1);
        assert_eq!(s.fans.len(), 1);
        assert_eq!(s.preamble.e_mm, 5.0);
        assert_eq!(s.z_list(), vec![0.2, 0.4]);
        let b = s.bbox.unwrap();
        assert_eq!([b[0], b[1], b[3], b[4]], [10.0, 10.0, 20.0, 20.0]);
    }

    #[test]
    fn absolute_e_matches_relative() {
        let rel = parse(SQUARE).unwrap();
        // same program in absolute E: M82 and running sums
        let abs = "; filament_diameter = 1.75\nM82\nG92 E0\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nG1 E-.4 F1800\nG1 X10 Y10 F9000\nG1 E0\n\
; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 X20 Y10 E.5 F3600\nG1 X20 Y20 E1\nG1 X10 Y20 E1.5\nG1 X10 Y10 E2\n";
        let a = parse(abs).unwrap();
        assert!((a.features["Outer wall"].path_mm - 40.0).abs() < 1e-9);
        assert!((a.features["Outer wall"].e_mm - 2.0).abs() < 1e-9);
        assert_eq!(a.retractions.count, 1);
        assert_eq!(rel.layers.len(), 2);
    }

    #[test]
    fn arcs_length_and_bbox() {
        // quarter circle r=10 ccw from (10,0) to (0,10), centre origin
        let g = "G90\nM83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; FEATURE: Inner wall\nG1 X10 Y0 F6000\nG3 X0 Y10 I-10 J0 E1\n\
G2 X10 Y0 I0 J-10 E1\n";
        let s = parse(g).unwrap();
        let f = &s.features["Inner wall"];
        assert!((f.path_mm - 2.0 * 10.0 * std::f64::consts::FRAC_PI_2).abs() < 1e-9, "{}", f.path_mm);
        assert_eq!(f.arcs, 2);
        let b = s.bbox.unwrap();
        assert!((b[3] - 10.0).abs() < 1e-9 && (b[4] - 10.0).abs() < 1e-9);
        // R form agrees with I/J form
        let r = "M83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; FEATURE: Inner wall\nG1 X10 Y0 F6000\nG3 X0 Y10 R10 E1\n";
        let sr = parse(r).unwrap();
        assert!((sr.features["Inner wall"].path_mm - 10.0 * std::f64::consts::FRAC_PI_2).abs() < 1e-6);
        // full circle with P1 and Z only (helical lift) is a travel, not an extrusion
        let full = "M83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nG1 X5 Y0 F600\nG3 Z.6 I-1 J0 P1 F6000\n";
        let sf = parse(full).unwrap();
        assert_eq!(sf.extrusion_moves, 0);
    }

    #[test]
    fn retract_debt_wipe_is_not_extrusion() {
        // retract 0.4 as two pieces (second one during an XY wipe move), unretract 0.4
        let g = "M83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; FEATURE: Outer wall\nG1 X0 Y0 F600\nG1 X5 Y0 E1\nG1 E-.2\nG1 X6 Y0 E-.2\nG1 X20 Y0\nG1 E.4\nG1 X21 Y0 E.1\n";
        let s = parse(g).unwrap();
        assert_eq!(s.retractions.count, 1, "wipe continuation must not open a second retraction");
        assert!((s.retractions.total_mm - 0.4).abs() < 1e-9);
        assert!((s.features["Outer wall"].path_mm - 6.0).abs() < 1e-9, "{}", s.features["Outer wall"].path_mm);
        assert!((s.features["Outer wall"].e_mm - 1.1).abs() < 1e-9);
    }

    #[test]
    fn header_values() {
        let g = "; model printing time: 1h 15m 2s; total estimated time: 1h 19m 45s\n; estimated first layer printing time (normal mode) = 4m 42s\n\
; total layer number: 61\nG1 X1 Y1 E1\n; filament used [mm] = 7226.15\n; filament used [cm3] = 17.38\n; filament used [g] = 21.73\n";
        let s = parse(g).unwrap();
        assert_eq!(s.header.total_time_s, Some(4785.0));
        assert_eq!(s.header.model_time_s, Some(4502.0));
        assert_eq!(s.header.first_layer_time_s, Some(282.0));
        assert_eq!(s.header.layer_count, Some(61.0));
        assert_eq!(s.header.filament_mm, Some(7226.15));
        assert_eq!(s.header.filament_cm3, Some(17.38));
        assert_eq!(s.header.filament_g, Some(21.73));
        assert_eq!(parse_duration("1d 2h"), Some(93600.0));
    }

    #[test]
    fn refuses_inches_and_empty() {
        assert!(matches!(parse("G20\nG1 X1 E1\n"), Err(FdmError::Unsupported(_))));
        assert!(matches!(parse("; just a comment\n"), Err(FdmError::Parse(_))));
    }

    #[test]
    fn direction_hist() {
        let mut g = String::from("M83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; FEATURE: Sparse infill\nG1 X0 Y0 F600\n");
        for i in 0..5 {
            let y = i as f64 * 2.0;
            g += &format!("G1 X0 Y{y} F9000\nG1 X10 Y{y} E1\n");
        }
        let h = direction_histogram(&g, 0, "Sparse infill").unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].angle_deg, 0);
        assert!((h[0].median_gap.unwrap() - 2.0).abs() < 1e-9);
    }
}
