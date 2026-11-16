//! quality::parse -- G-code text -> per-move segment list with everything the quality metrics need.
//!
//! This is deliberately a SECOND parser, not `gcode_parse` (lane 8): `gcode_parse` aggregates per feature
//! and discards the per-move state the quality metrics need (accel in force, fan in force, extrusion share of
//! each move, path/loop identity, arc continuation). Instrument independence is the point: a defect in one
//! parser must not be shared by the gate that judges the other. The two are cross-checked in `tests`
//! (path length per feature must agree) and by the bin's `--selftest`.
//!
//! Conventions held (same contract as the rest of fdm): refuse what it cannot read faithfully
//! (inches, no layer markers, no motion); relative (M83) and absolute (M82) E, G90/G91, G92; G2/G3 arcs with I/J;
//! retraction by DEBT (a negative E opens a retraction, a positive E pays the debt first and only the
//! remainder is extrusion).
use crate::config::Config;
use crate::types::FdmError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum QF { Outer, Inner, Overhang, Sparse, InternalSolid, Top, Bottom, InternalBridge, Bridge, Gap, Skirt, Brim,
    Support, SupportInterface, SupportTransition, Ironing, PrimeTower, Custom, Other }
impl QF {
    pub fn from_name(s: &str) -> QF {
        match s.trim() {
            "Outer wall" => QF::Outer, "Inner wall" => QF::Inner, "Overhang wall" => QF::Overhang,
            "Sparse infill" => QF::Sparse, "Internal solid infill" => QF::InternalSolid, "Top surface" => QF::Top,
            "Bottom surface" => QF::Bottom, "Internal Bridge" => QF::InternalBridge, "Bridge" => QF::Bridge,
            "Gap infill" => QF::Gap, "Skirt" => QF::Skirt, "Brim" => QF::Brim, "Support" => QF::Support,
            "Support interface" => QF::SupportInterface, "Support transition" => QF::SupportTransition,
            "Ironing" => QF::Ironing, "Prime tower" => QF::PrimeTower, "Custom" => QF::Custom, _ => QF::Other,
        }
    }
    /// Extrusion that is part of the part itself (the population the coverage / fidelity metrics judge).
    /// Skirt/brim/support/ironing/prime tower/custom are deliberately NOT part of the model.
    pub fn is_model(self) -> bool {
        matches!(self, QF::Outer | QF::Inner | QF::Overhang | QF::Sparse | QF::InternalSolid | QF::Top | QF::Bottom
            | QF::InternalBridge | QF::Bridge | QF::Gap)
    }
    pub fn is_exterior_wall(self) -> bool { matches!(self, QF::Outer | QF::Overhang) }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind { Extrude, Travel, Wipe }

/// One straight piece of motion (an arc is chopped into chords of <= 5 um sagitta).
#[derive(Clone, Copy, Debug)]
pub struct Seg {
    pub layer: i32,
    pub feat: QF,
    pub kind: Kind,
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub z: f64,
    /// annotated `; LINE_WIDTH:` (0 when none seen)
    pub w: f64,
    /// layer height in force
    pub h: f64,
    /// commanded feed, mm/s
    pub speed: f64,
    /// net extruded filament, mm (after retraction-debt payoff); 0 for non-extruding
    pub e: f64,
    /// acceleration in force: print for extrusion, travel otherwise (mm/s^2; 0 = never set)
    pub accel: f64,
    /// part-cooling fan 0..255 in force
    pub fan: f64,
    /// extrusion path id (consecutive extruding segments of one feature with no stop between)
    pub path: u32,
    /// true for the 2nd.. chord of an arc (a junction INSIDE an arc is not a corner)
    pub arc_cont: bool,
}
impl Seg {
    pub fn len(&self) -> f64 { (self.b[0] - self.a[0]).hypot(self.b[1] - self.a[1]) }
}

/// One block for the time estimator: any XY or E-only move.
#[derive(Clone, Copy, Debug)]
pub struct Blk { pub layer: i32, pub len: f64, pub v: f64, pub acc: f64, pub dir: [f64; 2], pub fixed_t: f64 }

#[derive(Clone, Debug, Default)]
pub struct LayerInfo { pub z: f64, pub h: f64 }

#[derive(Clone, Debug)]
pub struct Parsed {
    pub segs: Vec<Seg>,
    pub blks: Vec<Blk>,
    pub layers: Vec<LayerInfo>,
    pub cfg: Option<Config>,
    pub retract_layers: Vec<i32>,
    pub zhop_layers: Vec<i32>,
    pub filament_d: f64,
    pub header_model_time_s: Option<f64>,
    pub header_total_time_s: Option<f64>,
    pub header_filament_mm: Option<f64>,
    pub lines: usize,
    pub motion_lines: usize,
    pub extrusion_segs: usize,
    pub warnings: Vec<String>,
}

fn num(s: &str) -> Option<f64> { s.trim().parse::<f64>().ok() }

fn parse_time(s: &str) -> Option<f64> {
    // "23m 11s", "1h 2m 3s", "1d 2h 3m 4s"
    let mut t = 0.0;
    let mut any = false;
    for tok in s.split_whitespace() {
        let (n, u) = tok.split_at(tok.len().saturating_sub(1));
        let v = num(n)?;
        t += v * match u { "d" => 86400.0, "h" => 3600.0, "m" => 60.0, "s" => 1.0, _ => return None };
        any = true;
    }
    if any { Some(t) } else { None }
}

pub fn parse(text: &str) -> Result<Parsed, FdmError> {
    let mut p = Parsed { segs: vec![], blks: vec![], layers: vec![], cfg: Config::from_gcode(text).ok(), retract_layers: vec![],
        zhop_layers: vec![], filament_d: 1.75, header_model_time_s: None, header_total_time_s: None, header_filament_mm: None,
        lines: 0, motion_lines: 0, extrusion_segs: 0, warnings: vec![] };
    if let Some(c) = &p.cfg { if let Ok(d) = c.f64("filament_diameter") { if d > 0.0 { p.filament_d = d; } } }
    // header
    for l in text.lines().take(40) {
        if let Some(r) = l.strip_prefix("; model printing time: ") {
            let (a, b) = r.split_once("; total estimated time: ").unwrap_or((r, ""));
            p.header_model_time_s = parse_time(a.trim());
            p.header_total_time_s = parse_time(b.trim());
        }
        if let Some(r) = l.strip_prefix("; filament_diameter: ") { if let Some(d) = num(r) { if d > 0.0 { p.filament_d = d; } } }
    }
    let area = std::f64::consts::PI * p.filament_d * p.filament_d / 4.0;
    let _ = area;

    let (mut x, mut y, mut z, mut e_abs) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut abs_xyz, mut abs_e) = (true, false);
    let mut f = 0.0f64; // mm/min
    let mut layer: i32 = -1;
    let (mut acc_print, mut acc_travel) = (0.0f64, 0.0f64);
    let mut fan = 0.0f64;
    let mut feat = QF::Custom;
    let mut width = 0.0f64;
    let mut lh = 0.0f64;
    let mut pending_layer_z: Option<f64> = None;
    let mut debt = 0.0f64;
    let mut path_id: u32 = 0;
    let mut in_path = false;
    let mut ended = false;
    let mut in_exec = false;
    let mut saw_layer = false;
    let mut cfg_block = false;

    for raw in text.lines() {
        p.lines += 1;
        let line = raw.trim_end_matches('\r');
        let (code, comment) = match line.find(';') { Some(i) => (&line[..i], Some(&line[i + 1..])), None => (line, None) };
        if let Some(c) = comment {
            let c = c.trim_start();
            if code.trim().is_empty() {
                if c.starts_with("CONFIG_BLOCK_START") { cfg_block = true; }
                if c.starts_with("CONFIG_BLOCK_END") { cfg_block = false; }
                if c.starts_with("EXECUTABLE_BLOCK_START") { in_exec = true; }
                if c.starts_with("MACHINE_END_GCODE_START") || c.starts_with("EXECUTABLE_BLOCK_END") { ended = true; }
                if cfg_block || !in_exec { /* header/config comments carry no motion state */ }
                else if let Some(r) = c.strip_prefix("FEATURE:") { feat = QF::from_name(r); in_path = false; }
                else if let Some(r) = c.strip_prefix("LINE_WIDTH:") { width = num(r).unwrap_or(width); }
                else if c.starts_with("CHANGE_LAYER") && !ended { layer += 1; saw_layer = true; in_path = false; pending_layer_z = Some(f64::NAN); if layer == 0 { debt = 0.0; } }
                else if let Some(r) = c.strip_prefix("Z_HEIGHT:") { if !ended { if let Some(v) = num(r) { pending_layer_z = Some(v); } } }
                else if let Some(r) = c.strip_prefix("LAYER_HEIGHT:") {
                    if let Some(v) = num(r) {
                        lh = v;
                        if !ended && pending_layer_z.is_some() {
                            let zz = pending_layer_z.take().unwrap();
                            if zz.is_finite() { p.layers.push(LayerInfo { z: zz, h: v }); }
                            else { p.warnings.push(format!("layer {layer}: LAYER_HEIGHT without Z_HEIGHT")); p.layers.push(LayerInfo { z: f64::NAN, h: v }); }
                        }
                    }
                }
                else if c.starts_with("WIPE_START") || c.starts_with("WIPE_END") { in_path = false; }
            }
        }
        let code = code.trim();
        if code.is_empty() || cfg_block { continue; }
        let mut it = code.split_whitespace();
        let cmd = it.next().unwrap();
        let mut w: [Option<f64>; 26] = [None; 26];
        let is_gm = matches!(cmd.as_bytes()[0], b'G' | b'M');
        if !is_gm { continue; }
        for tok in it {
            let b = tok.as_bytes()[0];
            if b.is_ascii_uppercase() { w[(b - b'A') as usize] = num(&tok[1..]).or(Some(f64::NAN)); }
        }
        let g = |c: u8| w[(c - b'A') as usize].filter(|v| !v.is_nan());
        match cmd {
            "G90" => { abs_xyz = true; }
            "G91" => { abs_xyz = false; }
            "M82" => { abs_e = true; }
            "M83" => { abs_e = false; }
            "G20" => return Err(FdmError::Unsupported("G20 (inches) G-code".into())),
            "G92" => { if let Some(v) = g(b'E') { e_abs = v; } if let Some(v) = g(b'Z') { z = v; } if let Some(v) = g(b'X') { x = v; } if let Some(v) = g(b'Y') { y = v; } }
            "M106" => {
                let pidx = g(b'P');
                if pidx.is_none() || pidx == Some(1.0) { fan = g(b'S').unwrap_or(255.0); }
            }
            "M107" => { fan = 0.0; }
            "M204" => {
                if let Some(s) = g(b'S') { acc_print = s; acc_travel = s; }
                if let Some(v) = g(b'P') { acc_print = v; }
                if let Some(v) = g(b'T') { acc_travel = v; }
            }
            "G0" | "G1" | "G2" | "G3" => {
                if let Some(v) = g(b'F') { f = v; }
                if ended || !in_exec { // keep the position model right, but make no segments
                    let (nx, ny) = if abs_xyz { (g(b'X').unwrap_or(x), g(b'Y').unwrap_or(y)) } else { (x + g(b'X').unwrap_or(0.0), y + g(b'Y').unwrap_or(0.0)) };
                    let nz = if abs_xyz { g(b'Z').unwrap_or(z) } else { z + g(b'Z').unwrap_or(0.0) };
                    if cmd == "G0" || cmd == "G1" { x = nx; y = ny; }
                    z = nz;
                    if let Some(ev) = g(b'E') { if abs_e { e_abs = ev; } }
                    continue;
                }
                p.motion_lines += 1;
                let arc = cmd == "G2" || cmd == "G3";
                let (nx, ny) = if abs_xyz { (g(b'X').unwrap_or(x), g(b'Y').unwrap_or(y)) } else { (x + g(b'X').unwrap_or(0.0), y + g(b'Y').unwrap_or(0.0)) };
                let nz = if abs_xyz { g(b'Z').unwrap_or(z) } else { z + g(b'Z').unwrap_or(0.0) };
                let de = match g(b'E') { Some(ev) => if abs_e { let d = ev - e_abs; e_abs = ev; d } else { ev }, None => 0.0 };
                let speed = f / 60.0;
                // retraction debt
                let mut e_eff = 0.0;
                if de < 0.0 {
                    if debt <= 1e-9 && layer >= 0 { p.retract_layers.push(layer); }
                    debt += -de;
                } else if de > 0.0 {
                    let pay = debt.min(de);
                    debt -= pay;
                    e_eff = de - pay;
                }
                // geometry (chords)
                let mut pts: Vec<[f64; 2]> = vec![[x, y]];
                let mut pure_lift = false;
                if arc {
                    let (i, j) = (g(b'I'), g(b'J'));
                    if i.is_none() && j.is_none() { return Err(FdmError::Unsupported("G2/G3 in R form".into())); }
                    let (cx, cy) = (x + i.unwrap_or(0.0), y + j.unwrap_or(0.0));
                    let r = (x - cx).hypot(y - cy);
                    let a0 = (y - cy).atan2(x - cx);
                    let no_xy = g(b'X').is_none() && g(b'Y').is_none();
                    let turns = g(b'P').unwrap_or(1.0).max(1.0);
                    let a1 = (ny - cy).atan2(nx - cx);
                    let cw = cmd == "G2";
                    let mut sweep = if cw { a0 - a1 } else { a1 - a0 };
                    while sweep <= 1e-12 { sweep += 2.0 * std::f64::consts::PI; }
                    if no_xy || (nx - x).hypot(ny - y) < 1e-9 { sweep = 2.0 * std::f64::consts::PI; }
                    sweep += (turns - 1.0) * 2.0 * std::f64::consts::PI;
                    if no_xy && de == 0.0 { pure_lift = true; }
                    if r > 1e-9 && !pure_lift {
                        let step = if r > 0.005 { 2.0 * (1.0 - 0.005 / r).clamp(-1.0, 1.0).acos() } else { 1.0 };
                        let n = ((sweep / step.max(1e-3)).ceil() as usize).clamp(1, 4096);
                        for k in 1..=n {
                            let t = sweep * k as f64 / n as f64;
                            let a = if cw { a0 - t } else { a0 + t };
                            pts.push([cx + r * a.cos(), cy + r * a.sin()]);
                        }
                        if let Some(l) = pts.last_mut() { if !no_xy { *l = [nx, ny]; } }
                    }
                } else if (nx - x).hypot(ny - y) > 0.0 { pts.push([nx, ny]); }
                let xy_len: f64 = pts.windows(2).map(|q| (q[1][0] - q[0][0]).hypot(q[1][1] - q[0][1])).sum();
                // z-hop bookkeeping (any up-move above the layer's z)
                let lz = p.layers.last().map(|l| l.z).unwrap_or(f64::NAN);
                if layer >= 0 && lz.is_finite() && nz > lz + 0.02 && nz > z + 1e-6 && e_eff == 0.0 { p.zhop_layers.push(layer); }
                if layer >= 0 && xy_len > 0.0 {
                    let extruding = e_eff > 1e-9;
                    let kind = if extruding { Kind::Extrude } else if de < 0.0 { Kind::Wipe } else { Kind::Travel };
                    let tot = xy_len;
                    let acc = if extruding { acc_print } else { acc_travel };
                    if !extruding { in_path = false; } else if !in_path { path_id += 1; in_path = true; }
                    let (mut sx, mut sy) = (x, y);
                    for (k, q) in pts.windows(2).enumerate() {
                        let l = (q[1][0] - q[0][0]).hypot(q[1][1] - q[0][1]);
                        if l <= 0.0 { continue; }
                        let seg = Seg { layer, feat, kind, a: [sx, sy], b: q[1], z: nz, w: width, h: if lh > 0.0 { lh } else { 0.0 },
                            speed, e: e_eff * l / tot, accel: acc, fan, path: if extruding { path_id } else { 0 }, arc_cont: arc && k > 0 };
                        if extruding { p.extrusion_segs += 1; }
                        p.segs.push(seg);
                        p.blks.push(Blk { layer, len: l, v: speed.max(1e-3), acc: if acc > 0.0 { acc } else { 1000.0 }, dir: [(q[1][0] - q[0][0]) / l, (q[1][1] - q[0][1]) / l], fixed_t: 0.0 });
                        sx = q[1][0]; sy = q[1][1];
                    }
                } else if layer >= 0 && de != 0.0 {
                    // E-only move (retract / unretract / prime): a stop in the planner
                    in_path = false;
                    p.blks.push(Blk { layer, len: 0.0, v: 1.0, acc: 1000.0, dir: [0.0, 0.0], fixed_t: if speed > 0.0 { de.abs() / speed } else { 0.0 } });
                } else if layer >= 0 && (nz - z).abs() > 0.0 {
                    in_path = false;
                    p.blks.push(Blk { layer, len: 0.0, v: 1.0, acc: 1000.0, dir: [0.0, 0.0], fixed_t: if speed > 0.0 { (nz - z).abs() / speed } else { 0.0 } });
                }
                if !pure_lift || arc == false { x = nx; y = ny; } else { x = nx; y = ny; }
                z = nz;
            }
            _ => {}
        }
        let _ = abs_xyz;
    }
    if !saw_layer { return Err(FdmError::Parse("no '; CHANGE_LAYER' markers: cannot attribute motion to layers".into())); }
    if p.extrusion_segs == 0 { return Err(FdmError::Parse("no extruding motion inside any layer".into())); }
    // fill any layer-height holes on segments (Orca writes LAYER_HEIGHT after Z_HEIGHT, before motion)
    for s in p.segs.iter_mut() {
        if s.h <= 0.0 { if let Some(l) = p.layers.get(s.layer as usize) { s.h = l.h; } }
        else if let Some(l) = p.layers.get(s.layer as usize) { s.h = l.h; }
    }
    if p.layers.iter().any(|l| !l.z.is_finite()) { return Err(FdmError::Parse("a layer has no Z_HEIGHT".into())); }
    p.header_filament_mm = None;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn tiny() -> String {
        let mut s = String::from("; HEADER_BLOCK_START\n; filament_diameter: 1.75\n; HEADER_BLOCK_END\n; EXECUTABLE_BLOCK_START\nM83\n");
        for l in 0..2 {
            let z = 0.2 * (l + 1) as f64;
            s += &format!("; CHANGE_LAYER\n; Z_HEIGHT: {z}\n; LAYER_HEIGHT: 0.2\nM204 S1000\nG1 X0 Y0 F6000\n; FEATURE: Outer wall\n; LINE_WIDTH: 0.42\nG1 F3000\nG1 X10 Y0 E0.5\nG1 X10 Y10 E0.5\nG1 E-0.8 F1800\nG1 X0 Y10 F6000\nG1 E0.8 F1800\nG1 X0 Y0 E0.5 F3000\n");
        }
        s + "; EXECUTABLE_BLOCK_END\n"
    }
    #[test] fn parses_layers_and_retraction_debt() {
        let p = parse(&tiny()).unwrap();
        assert_eq!(p.layers.len(), 2);
        assert_eq!(p.retract_layers.len(), 2);
        let ext: Vec<_> = p.segs.iter().filter(|s| s.kind == Kind::Extrude).collect();
        assert_eq!(ext.len(), 6);
        // the unretract (+0.8) pays the whole debt: not extrusion
        assert!(ext.iter().all(|s| (s.e - 0.5).abs() < 1e-9));
        assert!((ext[0].speed - 50.0).abs() < 1e-9 && ext[0].accel == 1000.0 && (ext[0].w - 0.42).abs() < 1e-9);
    }
    #[test] fn start_gcode_retraction_debt_does_not_swallow_layer_zero() {
        // measured on Orca's mushroom file: a 3 mm retract in the start G-code (primed later by a macro, not a G1)
        // swallowed the whole first-layer skirt and both walls as 'debt payoff' until the debt was spent.
        let g = "; EXECUTABLE_BLOCK_START\nM83\nG1 E-3 F1800\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; LAYER_HEIGHT: 0.2\nG1 X0 Y0 F6000\n; FEATURE: Skirt\nG1 X10 Y0 E0.5 F3000\n";
        let p = parse(g).unwrap();
        assert_eq!(p.segs.iter().filter(|s| s.kind == Kind::Extrude).count(), 1);
        assert_eq!(p.retract_layers.len(), 0, "a retraction before the first layer is not counted inside layers");
    }
    #[test] fn refuses_without_layers() {
        assert!(parse("G1 X1 Y1 E1\n").is_err());
    }
    #[test] fn arcs_have_the_right_length() {
        let g = "; EXECUTABLE_BLOCK_START\nM83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\n; LAYER_HEIGHT: 0.2\nG1 X10 Y0 F6000\nG3 X-10 Y0 I-10 J0 E1 F3000\n";
        let p = parse(g).unwrap();
        let l: f64 = p.segs.iter().filter(|s| s.kind == Kind::Extrude).map(|s| s.len()).sum();
        assert!((l - std::f64::consts::PI * 10.0).abs() < 0.01, "{l}");
    }
}
