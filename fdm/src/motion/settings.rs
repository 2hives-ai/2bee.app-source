//! `Settings`: the motion/G-code lane's read-only view of an Orca configuration.
//!
//! The lane-1 `Config` type was not available while this lane was built, so this lane reads the one
//! interchange format that is already ground truth: the `; key = value` CONFIG_BLOCK that OrcaSlicer
//! appends to every G-code file (every resolved setting, as serialized by `ConfigOption::serialize`).
//! `Settings::from_config_block` accepts a whole G-code file (or just the block), `Settings::from_pairs`
//! accepts anything the lead's `Config` can enumerate.
//!
//! Variant columns: Orca stores per-nozzle-variant options as comma lists ("Direct Drive Standard,
//! Direct Drive High Flow"); for the X2D 0.4 Standard nozzle the live column is 0, which is what
//! `num`, `flag` and `text` read (`get_at(0)`). Machine limits are (normal, silent) x variant strides of
//! 2 (see `GCodeWriter::apply_print_config`); `machine_limit` reads stride-2 offset 0.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use super::optdefs::OPT_TYPES;

/// Parsed `key -> raw serialized value` map. Deterministic (BTreeMap) iteration, sorted like Orca's block.
/// `read` records every key `raw` returned, so the G-code stage's reads reach `Config::unread_keys` (`read_keys`).
#[derive(Debug, Default)]
pub struct Settings {
    map: BTreeMap<String, String>,
    read: Mutex<BTreeSet<String>>,
}
impl Clone for Settings {
    fn clone(&self) -> Self { Settings { map: self.map.clone(), read: Mutex::new(self.read.lock().unwrap().clone()) } }
}

/// Value type of an Orca option, from `PrintConfig.cpp` (see `optdefs.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptKind { Float, Int, Bool, Str, Percent, FloatOrPercent, Enum, Point, Unknown }

pub fn opt_kind(key: &str) -> (OptKind, bool) {
    match OPT_TYPES.binary_search_by(|(k, _)| (*k).cmp(key)) {
        Ok(i) => match OPT_TYPES[i].1 {
            'F' => (OptKind::Float, false), 'f' => (OptKind::Float, true),
            'I' => (OptKind::Int, false), 'i' => (OptKind::Int, true),
            'B' => (OptKind::Bool, false), 'b' => (OptKind::Bool, true),
            'S' => (OptKind::Str, false), 's' => (OptKind::Str, true),
            'P' => (OptKind::Percent, false), 'p' => (OptKind::Percent, true),
            'Q' => (OptKind::FloatOrPercent, false), 'q' => (OptKind::FloatOrPercent, true),
            'E' => (OptKind::Enum, false), 'e' => (OptKind::Enum, true),
            'T' => (OptKind::Point, false), 't' => (OptKind::Point, true),
            _ => (OptKind::Unknown, true),
        },
        Err(_) => (OptKind::Unknown, false),
    }
}

/// Undo `escape_string_cstyle`: `\n`, `\r`, `\\`, `\"`.
pub fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Split a serialized vector option into its elements. String vectors are `"a";"b"` (quoted, `;`
/// separated); everything else is plain `a,b,c`. Quoted elements are returned still escaped but unquoted.
pub fn split_vector(raw: &str, is_string_vec: bool) -> Vec<String> {
    if is_string_vec {
        let mut out = Vec::new();
        let b: Vec<char> = raw.chars().collect();
        let mut i = 0;
        while i < b.len() {
            if b[i] == '"' {
                let mut s = String::new();
                i += 1;
                while i < b.len() && b[i] != '"' {
                    if b[i] == '\\' && i + 1 < b.len() { s.push(b[i]); s.push(b[i + 1]); i += 2; continue; }
                    s.push(b[i]);
                    i += 1;
                }
                i += 1;
                out.push(s);
            } else if b[i] == ';' || b[i] == ' ' {
                i += 1;
            } else {
                let mut s = String::new();
                while i < b.len() && b[i] != ';' { s.push(b[i]); i += 1; }
                out.push(s);
            }
        }
        if out.is_empty() { out.push(String::new()); }
        out
    } else {
        raw.split(',').map(|s| s.trim().to_string()).collect()
    }
}

impl Settings {
    pub fn new() -> Self { Self::default() }

    pub fn from_pairs<I: IntoIterator<Item = (String, String)>>(it: I) -> Self {
        Settings { map: it.into_iter().collect(), read: Mutex::default() }
    }

    /// Adapter from lane 1's `Config` (its raw `key -> serialized value` map is exactly the CONFIG_BLOCK form).
    pub fn from_config(c: &crate::config::Config) -> Self {
        Settings::from_pairs(c.raw_map().iter().map(|(k, v)| (k.clone(), v.clone())))
    }

    /// Parse the `; CONFIG_BLOCK_START` .. `; CONFIG_BLOCK_END` block of an Orca G-code file. If the text has no
    /// block markers the whole text is scanned for `; key = value` lines (the last occurrence of a key wins,
    /// as in Orca's own G-code viewer).
    pub fn from_config_block(text: &str) -> Self {
        let mut map = BTreeMap::new();
        let (start, end) = match text.find("; CONFIG_BLOCK_START") {
            Some(s) => (s, text[s..].find("; CONFIG_BLOCK_END").map(|e| s + e).unwrap_or(text.len())),
            None => (0, text.len()),
        };
        for line in text[start..end].lines() {
            let Some(rest) = line.strip_prefix("; ") else { continue };
            let Some(eq) = rest.find(" = ") else {
                // "; key =" (empty value)
                if let Some(k) = rest.strip_suffix(" =") {
                    if !k.contains(' ') { map.insert(k.to_string(), String::new()); }
                }
                continue;
            };
            let k = &rest[..eq];
            if k.is_empty() || k.contains(' ') { continue; }
            map.insert(k.to_string(), rest[eq + 3..].to_string());
        }
        Settings { map, read: Mutex::default() }
    }

    pub fn set(&mut self, k: &str, v: &str) { self.map.insert(k.to_string(), v.to_string()); }
    pub fn has(&self, k: &str) -> bool { self.map.contains_key(k) }
    pub fn raw(&self, k: &str) -> Option<&str> {
        let v = self.map.get(k)?;
        let mut r = self.read.lock().unwrap();
        if !r.contains(k) { r.insert(k.to_string()); }
        Some(v.as_str())
    }
    /// Keys `raw` has returned (for `Config::mark_read`). `iter`, `keys` and `to_config_block` do not count as reads.
    pub fn read_keys(&self) -> Vec<String> { self.read.lock().unwrap().iter().cloned().collect() }
    pub fn len(&self) -> usize { self.map.len() }
    pub fn is_empty(&self) -> bool { self.map.is_empty() }
    pub fn keys(&self) -> impl Iterator<Item = &String> { self.map.keys() }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &String)> { self.map.iter() }

    /// Elements of a vector option (a scalar option is a one-element vector).
    pub fn elements(&self, k: &str) -> Vec<String> {
        let Some(raw) = self.raw(k) else { return Vec::new() };
        let (kind, vec) = opt_kind(k);
        if kind == OptKind::Str && vec { return split_vector(raw, true); }
        if kind == OptKind::Str || kind == OptKind::Enum && !vec { return vec![raw.to_string()]; }
        if kind == OptKind::Point || kind == OptKind::Unknown && raw.contains('"') { return vec![raw.to_string()]; }
        split_vector(raw, false)
    }

    pub fn len_of(&self, k: &str) -> usize { self.elements(k).len() }

    fn element(&self, k: &str, i: usize) -> Option<String> {
        let e = self.elements(k);
        if e.is_empty() { return None; }
        // ConfigOptionVector::get_at: out-of-range falls back to the first element.
        Some(if i < e.len() { e[i].clone() } else { e[0].clone() })
    }

    fn parse_num(s: &str) -> f64 {
        let t = s.trim().trim_end_matches('%');
        t.parse::<f64>().unwrap_or(0.0)
    }

    /// `get_at(0)` as a number; percent strings drop the `%` (use `abs_at` to resolve ratios).
    pub fn num(&self, k: &str) -> f64 { self.num_at(k, 0) }
    pub fn num_at(&self, k: &str, i: usize) -> f64 { self.element(k, i).map(|s| Self::parse_num(&s)).unwrap_or(0.0) }
    pub fn num_or(&self, k: &str, d: f64) -> f64 { if self.has(k) { self.num(k) } else { d } }
    pub fn int(&self, k: &str) -> i64 { self.num(k).round() as i64 }
    pub fn flag(&self, k: &str) -> bool { self.flag_at(k, 0) }
    pub fn flag_at(&self, k: &str, i: usize) -> bool {
        self.element(k, i).map(|s| { let t = s.trim(); t == "1" || t.eq_ignore_ascii_case("true") }).unwrap_or(false)
    }
    pub fn is_percent_at(&self, k: &str, i: usize) -> bool { self.element(k, i).map(|s| s.trim().ends_with('%')).unwrap_or(false) }

    /// Absolute value of a FloatOrPercent element; percent values are `value * ratio_over / 100`.
    pub fn abs_at(&self, k: &str, i: usize, ratio_over: f64) -> f64 {
        match self.element(k, i) {
            None => 0.0,
            Some(s) => {
                let v = Self::parse_num(&s);
                if s.trim().ends_with('%') { v * ratio_over / 100.0 } else { v }
            }
        }
    }
    pub fn abs(&self, k: &str, ratio_over: f64) -> f64 { self.abs_at(k, 0, ratio_over) }

    /// Unquoted, unescaped string value (scalar string options and the first element of string vectors).
    pub fn text(&self, k: &str) -> String { self.text_at(k, 0) }
    pub fn text_at(&self, k: &str, i: usize) -> String {
        let (kind, vec) = opt_kind(k);
        let raw = match self.raw(k) { Some(r) => r, None => return String::new() };
        if kind == OptKind::Str && !vec || kind == OptKind::Unknown && !raw.contains(',') || kind == OptKind::Enum && !vec {
            let r = raw.trim();
            if r.len() >= 2 && r.starts_with('"') && r.ends_with('"') { return unescape(&r[1..r.len() - 1]); }
            return unescape(r);
        }
        self.element(k, i).map(|s| unescape(&s)).unwrap_or_default()
    }

    /// Machine limit for the "normal" mode of the live variant. Stride-2 options
    /// (`printer_options_with_variant_2`) carry (normal, silent) per variant.
    pub fn machine_limit(&self, k: &str) -> f64 { self.num_at(k, 0) }

    /// All `Settings` keys that are in the CONFIG_BLOCK serialization order (sorted, like Orca).
    pub fn to_config_block(&self) -> String {
        let mut s = String::from("; CONFIG_BLOCK_START\n");
        for (k, v) in &self.map {
            if v.is_empty() { s.push_str(&format!("; {} = \n", k)); } else { s.push_str(&format!("; {} = {}\n", k, v)); }
        }
        s.push_str("; CONFIG_BLOCK_END\n");
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_through_raw_reach_the_config_read_tracker() {
        // bughunt 2026-11-15: the G-code stage's reads never reached Config, so `unreadKeys` counted them as ignored.
        let c = crate::config::Config::from_gcode("; CONFIG_BLOCK_START\n; retraction_length = 0.8\n; never_used = 1\n; CONFIG_BLOCK_END\n").unwrap();
        let s = Settings::from_config(&c);
        assert!(s.read_keys().is_empty());
        let _ = s.to_config_block();
        assert!(s.read_keys().is_empty(), "writing the config block is not a read");
        assert!((s.num("retraction_length") - 0.8).abs() < 1e-12);
        assert_eq!(s.read_keys(), vec!["retraction_length".to_string()]);
        c.mark_read(&s.read_keys().iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(c.unread_keys(), vec!["never_used".to_string()]);
    }

    #[test]
    fn parses_block_and_vectors() {
        let t = "; HEADER\n; CONFIG_BLOCK_START\n; default_acceleration = 10000,1000\n; bridge_acceleration = 50%,50%\n; filament_start_gcode = \"; a\\nb\"\n; wipe = 0,0\n; empty = \n; CONFIG_BLOCK_END\nG1 X1\n; not_a_key = 3\n";
        let s = Settings::from_config_block(t);
        assert_eq!(s.num("default_acceleration"), 10000.0);
        assert_eq!(s.num_at("default_acceleration", 1), 1000.0);
        assert_eq!(s.abs("bridge_acceleration", 5000.0), 2500.0);
        assert_eq!(s.text("filament_start_gcode"), "; a\nb");
        assert!(!s.flag("wipe"));
        assert!(s.has("empty"));
        assert!(!s.has("not_a_key"));
    }
}
