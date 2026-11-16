//! quality::plants -- planted degradations (negative controls) as G-code text transforms.
//!
//! A metric that cannot be made to say WORSE by a planted defect cannot be trusted to say BETTER. Every plant
//! names the metrics it must degrade (`expects`); `controls::run` applies it to the REAL reference file and
//! checks the named metrics really moved to WORSE. Plants need relative E (M83) and refuse otherwise.
use crate::types::FdmError;

pub enum Edit { Keep, Set(f64), Remove }

fn fmt(v: f64) -> String {
    let s = format!("{:.5}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" { "0".into() } else { s.to_string() }
}

/// Rewrite the words of one G-code line. `f(letter, value)` decides per word. Comment suffix preserved.
pub fn edit_line(line: &str, f: &mut dyn FnMut(char, f64) -> Edit) -> String {
    let (code, comment) = match line.find(';') { Some(i) => (&line[..i], &line[i..]), None => (line, "") };
    let mut it = code.split_whitespace();
    let Some(cmd) = it.next() else { return line.to_string() };
    let mut out = String::from(cmd);
    for tok in it {
        let c = tok.chars().next().unwrap();
        match tok[1..].parse::<f64>() {
            Ok(v) if c.is_ascii_uppercase() => match f(c, v) {
                Edit::Keep => { out.push(' '); out.push_str(tok); }
                Edit::Set(n) => { out.push(' '); out.push(c); out.push_str(&fmt(n)); }
                Edit::Remove => {}
            },
            _ => { out.push(' '); out.push_str(tok); }
        }
    }
    if !comment.is_empty() { out.push(' '); out.push_str(comment); }
    out
}

fn word(line: &str, c: char) -> Option<f64> {
    let code = line.split(';').next().unwrap_or("");
    code.split_whitespace().skip(1).find(|t| t.starts_with(c)).and_then(|t| t[1..].parse().ok())
}
fn is_move(line: &str) -> bool { let c = line.split(';').next().unwrap_or("").trim_start(); c.starts_with("G1 ") || c.starts_with("G0 ") }
fn has(line: &str, c: char) -> bool { word(line, c).is_some() }

struct Walker { in_exec: bool, ended: bool, feat: String }
impl Walker {
    fn new() -> Self { Walker { in_exec: false, ended: false, feat: String::new() } }
    /// Feed a line; returns true when the line is inside the printing body.
    fn step(&mut self, line: &str) -> bool {
        let t = line.trim();
        if t.starts_with("; EXECUTABLE_BLOCK_START") { self.in_exec = true; return false; }
        if t.starts_with("; MACHINE_END_GCODE_START") || t.starts_with("; EXECUTABLE_BLOCK_END") { self.ended = true; }
        if let Some(r) = t.strip_prefix("; FEATURE:") { self.feat = r.trim().to_string(); }
        self.in_exec && !self.ended
    }
}

fn need_relative(text: &str) -> Result<(), FdmError> {
    if text.lines().any(|l| l.trim() == "M83" || l.trim().starts_with("M83 ")) { Ok(()) }
    else { Err(FdmError::Unsupported("plants need relative extrusion (M83)".into())) }
}

fn hashf(i: u64, salt: u64) -> f64 {
    let mut h = i.wrapping_mul(0x9E3779B97F4A7C15) ^ salt.wrapping_mul(0xD6E8FEB86659FD93);
    h ^= h >> 32; h = h.wrapping_mul(0xFF51AFD7ED558CCD); h ^= h >> 29;
    (h & 0xFFFFFF) as f64 / 0xFFFFFF as f64 * 2.0 - 1.0
}

fn map_lines(text: &str, mut f: impl FnMut(&mut Walker, usize, &str) -> Option<String>) -> String {
    let mut w = Walker::new();
    let mut out = String::with_capacity(text.len() + 1024);
    for (i, l) in text.lines().enumerate() {
        let inb = w.step(l);
        let r = if inb { f(&mut w, i, l) } else { None };
        match r { Some(s) => out.push_str(&s), None => out.push_str(l) }
        out.push('\n');
    }
    out
}

/// All X/Y +dx,+dy (default 0.001 mm = one G-code coordinate step): the false-positive control.
pub fn tiny_shift(text: &str, d: f64) -> Result<String, FdmError> {
    Ok(map_lines(text, |_, _, l| if is_move(l) && (has(l, 'X') || has(l, 'Y')) { Some(edit_line(l, &mut |c, v| match c { 'X' | 'Y' => Edit::Set(v + d), _ => Edit::Keep })) } else { None }))
}
/// Each outer-wall end point displaced by up to +-amp mm in X and Y (seeded).
pub fn jitter_walls(text: &str, amp: f64) -> Result<String, FdmError> {
    Ok(map_lines(text, |w, i, l| {
        if w.feat == "Outer wall" && is_move(l) && has(l, 'E') && has(l, 'X') {
            Some(edit_line(l, &mut |c, v| match c { 'X' => Edit::Set(v + amp * hashf(i as u64, 1)), 'Y' => Edit::Set(v + amp * hashf(i as u64, 2)), _ => Edit::Keep }))
        } else { None }
    }))
}
/// Whole outer wall displaced by dx in X.
pub fn shift_outer(text: &str, dx: f64) -> Result<String, FdmError> {
    Ok(map_lines(text, |w, _, l| {
        if w.feat == "Outer wall" && is_move(l) && has(l, 'E') && has(l, 'X') { Some(edit_line(l, &mut |c, v| if c == 'X' { Edit::Set(v + dx) } else { Edit::Keep })) } else { None }
    }))
}
/// Strip E from every extruding move of the named features (the path is still driven: it becomes a travel).
pub fn drop_features(text: &str, feats: &[&str]) -> Result<String, FdmError> {
    need_relative(text)?;
    Ok(map_lines(text, |w, _, l| {
        if feats.contains(&w.feat.as_str()) && is_move(l) && has(l, 'E') && (has(l, 'X') || has(l, 'Y')) && word(l, 'E').unwrap_or(0.0) > 0.0 {
            Some(edit_line(l, &mut |c, _| if c == 'E' { Edit::Remove } else { Edit::Keep }))
        } else { None }
    }))
}
/// E multiplied on the named features.
pub fn scale_e(text: &str, feats: &[&str], k: f64) -> Result<String, FdmError> {
    need_relative(text)?;
    Ok(map_lines(text, |w, _, l| {
        if feats.contains(&w.feat.as_str()) && is_move(l) && has(l, 'E') && word(l, 'E').unwrap_or(0.0) > 0.0 {
            Some(edit_line(l, &mut |c, v| if c == 'E' { Edit::Set(v * k) } else { Edit::Keep }))
        } else { None }
    }))
}
/// Feed rate multiplied on the named features (empty = everywhere in the body). Covers `G1 F..` lines and inline F.
pub fn scale_speed(text: &str, feats: &[&str], k: f64) -> Result<String, FdmError> {
    Ok(map_lines(text, |w, _, l| {
        if (feats.is_empty() || feats.contains(&w.feat.as_str())) && is_move(l) && has(l, 'F') {
            Some(edit_line(l, &mut |c, v| if c == 'F' { Edit::Set(v * k) } else { Edit::Keep }))
        } else { None }
    }))
}
/// M204 accelerations multiplied (S and P).
pub fn scale_accel(text: &str, k: f64) -> Result<String, FdmError> {
    Ok(map_lines(text, |_, _, l| {
        if l.trim_start().starts_with("M204") { Some(edit_line(l, &mut |c, v| if c == 'S' || c == 'P' { Edit::Set(v * k) } else { Edit::Keep })) } else { None }
    }))
}
/// A needless retract/unretract around every travel (XY move without E that follows an extrusion).
pub fn extra_retractions(text: &str, len: f64) -> Result<String, FdmError> {
    need_relative(text)?;
    let mut w = Walker::new();
    let mut out = String::new();
    let mut last_ext = false;
    for l in text.lines() {
        let inb = w.step(l);
        if inb && is_move(l) {
            let e = word(l, 'E');
            let ext = e.map_or(false, |v| v > 0.0) && (has(l, 'X') || has(l, 'Y'));
            let trav = e.is_none() && (has(l, 'X') || has(l, 'Y')) && !has(l, 'Z');
            if trav && last_ext {
                out.push_str(&format!("G1 E-{} F1800\n{}\nG1 E{} F1800\n", fmt(len), l, fmt(len)));
                last_ext = false;
                continue;
            }
            // an existing retraction (negative E) means this travel is already retracted: leave it alone
            if e.map_or(false, |v| v < 0.0) { last_ext = false; } else if ext { last_ext = true; }
        }
        out.push_str(l); out.push('\n');
    }
    Ok(out)
}
/// Every travel becomes a detour of `d` mm out and back.
pub fn travel_detour(text: &str, d: f64) -> Result<String, FdmError> {
    let mut w = Walker::new();
    let mut out = String::new();
    let mut last_ext = false;
    let mut pos = (0.0, 0.0);
    for l in text.lines() {
        let inb = w.step(l);
        if inb && is_move(l) {
            let ext = has(l, 'E') && word(l, 'E').unwrap_or(0.0) > 0.0 && (has(l, 'X') || has(l, 'Y'));
            let trav = !has(l, 'E') && (has(l, 'X') || has(l, 'Y')) && !has(l, 'Z');
            if trav && last_ext { out.push_str(&format!("G1 X{} Y{} F60000\n", fmt(pos.0 + d), fmt(pos.1))); }
            last_ext = ext;
        }
        if inb && is_move(l) { if let Some(x) = word(l, 'X') { pos.0 = x; } if let Some(y) = word(l, 'Y') { pos.1 = y; } }
        out.push_str(l); out.push('\n');
    }
    Ok(out)
}
/// No part cooling during bridges.
pub fn bridge_no_fan(text: &str) -> Result<String, FdmError> {
    let mut w = Walker::new();
    let mut out = String::new();
    for l in text.lines() {
        let inb = w.step(l);
        if inb && l.trim().starts_with("; FEATURE:") && w.feat == "Bridge" { out.push_str(l); out.push_str("\nM106 S0\n"); continue; }
        if inb && w.feat == "Bridge" {
            let t = l.trim_start();
            if t.starts_with("M106") && !t.contains(" P") { out.push_str("M106 S0\n"); continue; }
        }
        out.push_str(l); out.push('\n');
    }
    Ok(out)
}

/// Every `n`-th extruding move of the named features loses its E (periodic dropouts: many small voids, no big ones).
pub fn drop_nth(text: &str, feats: &[&str], n: usize) -> Result<String, FdmError> {
    need_relative(text)?;
    let mut k = 0usize;
    Ok(map_lines(text, |w, _, l| {
        if feats.contains(&w.feat.as_str()) && is_move(l) && has(l, 'E') && (has(l, 'X') || has(l, 'Y')) && word(l, 'E').unwrap_or(0.0) > 0.0 {
            k += 1;
            if k % n == 0 { return Some(edit_line(l, &mut |c, _| if c == 'E' { Edit::Remove } else { Edit::Keep })); }
        }
        None
    }))
}
/// A needless z lift (+0.6 mm) around every travel.
pub fn add_zhops(text: &str, dz: f64) -> Result<String, FdmError> {
    let mut w = Walker::new();
    let mut out = String::new();
    let mut last_ext = false;
    let mut z = 0.0;
    for l in text.lines() {
        let inb = w.step(l);
        if let Some(r) = l.strip_prefix("; Z_HEIGHT:") { z = r.trim().parse().unwrap_or(z); }
        if inb && is_move(l) {
            let ext = has(l, 'E') && word(l, 'E').unwrap_or(0.0) > 0.0 && (has(l, 'X') || has(l, 'Y'));
            let trav = !has(l, 'E') && (has(l, 'X') || has(l, 'Y')) && !has(l, 'Z');
            if trav && last_ext {
                out.push_str(&format!("G1 Z{} F1200\n{}\nG1 Z{} F1200\n", fmt(z + dz), l, fmt(z)));
                last_ext = false;
                continue;
            }
            last_ext = ext;
        }
        out.push_str(l); out.push('\n');
    }
    Ok(out)
}
/// Bridge extrusions stretched by `d` mm on each side of the bridge X-centre (longer unsupported spans).
pub fn widen_bridges(text: &str, d: f64) -> Result<String, FdmError> {
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    { let mut w = Walker::new(); for l in text.lines() { if w.step(l) && w.feat == "Bridge" && is_move(l) && has(l, 'E') { if let Some(x) = word(l, 'X') { lo = lo.min(x); hi = hi.max(x); } } } }
    if lo > hi { return Ok(text.to_string()); }
    let mid = (lo + hi) / 2.0;
    Ok(map_lines(text, |w, _, l| {
        if w.feat == "Bridge" && is_move(l) && has(l, 'E') && has(l, 'X') { Some(edit_line(l, &mut |c, v| if c == 'X' { Edit::Set(if v < mid { v - d } else { v + d }) } else { Edit::Keep })) } else { None }
    }))
}
/// Start each closed outer-wall loop at a pseudo-random vertex (the loop is the same circuit, started elsewhere).
pub fn scatter_seams(text: &str) -> Result<String, FdmError> {
    need_relative(text)?;
    let lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let mut out = lines.clone();
    let mut w = Walker::new();
    let (mut px, mut py) = (0.0, 0.0);
    let mut last_travel: Option<usize> = None;
    let mut i = 0;
    let mut loopn = 0u64;
    while i < lines.len() {
        let l = &lines[i];
        let inb = w.step(l);
        if inb && l.trim() == "; FEATURE: Outer wall" {
            // collect the contiguous extruding block after the header comments
            let mut j = i + 1;
            while j < lines.len() && !(is_move(&lines[j]) && has(&lines[j], 'E') && has(&lines[j], 'X')) {
                if is_move(&lines[j]) && (has(&lines[j], 'X') || has(&lines[j], 'Y')) { break; }
                j += 1;
            }
            let start = j;
            let mut pts: Vec<(f64, f64, String)> = vec![];
            while j < lines.len() && is_move(&lines[j]) && has(&lines[j], 'E') && has(&lines[j], 'X') && has(&lines[j], 'Y') && word(&lines[j], 'E').unwrap_or(0.0) > 0.0 {
                pts.push((word(&lines[j], 'X').unwrap(), word(&lines[j], 'Y').unwrap(), format!("{}", fmt(word(&lines[j], 'E').unwrap()))));
                j += 1;
            }
            let n = pts.len();
            if n >= 3 && last_travel.is_some() && (pts[n - 1].0 - px).hypot(pts[n - 1].1 - py) < 0.05 {
                loopn += 1;
                let k = 1 + ((hashf(loopn, 7) * 0.5 + 0.5) * (n as f64 - 1.0)).floor() as usize % (n - 1).max(1);
                let k = k.min(n - 1);
                // new travel target = P_k
                let t = last_travel.unwrap();
                let (tx, ty) = (pts[k - 1].0, pts[k - 1].1);
                out[t] = edit_line(&lines[t], &mut |c, _| match c { 'X' => Edit::Set(tx), 'Y' => Edit::Set(ty), _ => Edit::Keep });
                // segments k+1..n then 1..k  (segment s runs P_{s-1}->P_s with E_s; P_0 = P_n)
                let mut seq: Vec<usize> = ((k + 1)..=n).collect();
                seq.extend(1..=k);
                for (o, s) in seq.iter().enumerate() {
                    let (x, y, e) = &pts[s - 1];
                    out[start + o] = format!("G1 X{} Y{} E{}", fmt(*x), fmt(*y), e);
                }
            }
            i = j.max(i + 1);
            continue;
        }
        if inb && is_move(l) && (has(l, 'X') || has(l, 'Y')) {
            if let Some(x) = word(l, 'X') { px = x; } if let Some(y) = word(l, 'Y') { py = y; }
            if !has(l, 'E') && !has(l, 'Z') { last_travel = Some(i); } else { last_travel = None; }
        }
        i += 1;
    }
    Ok(out.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn edit_line_roundtrip() {
        assert_eq!(edit_line("G1 X10.5 Y2 E.6 F3000 ; c", &mut |_, _| Edit::Keep), "G1 X10.5 Y2 E.6 F3000 ; c");
        assert_eq!(edit_line("G1 X10 E.6", &mut |c, v| if c == 'X' { Edit::Set(v + 0.001) } else { Edit::Keep }), "G1 X10.001 E.6");
        assert_eq!(edit_line("G1 X10 E.6", &mut |c, _| if c == 'E' { Edit::Remove } else { Edit::Keep }), "G1 X10");
    }
}
