//! Lane 1: Orca settings -> typed `Config`.
//!
//! Two sources feed one `Config` (a raw `key -> string` map, exactly the form Orca prints in the
//! `CONFIG_BLOCK` of its G-code):
//!  * `Config::from_gcode*` parses the `; CONFIG_BLOCK_START .. ; CONFIG_BLOCK_END` of an Orca G-code;
//!  * `Config::from_presets` loads Orca preset JSON (user + system), flattens the `inherits` chain
//!    (a missing parent is an ERROR) and reduces the per-extruder-variant arrays the way Orca does.
//!
//! Unknown keys are kept. Every accessor records the key it read; `unread_keys()` lists the rest, so a
//! setting that no lane consumed is visible rather than silently ignored.
use crate::types::FdmError;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type Result<T, E = FdmError> = std::result::Result<T, E>;

fn perr<T>(s: impl Into<String>) -> Result<T, FdmError> { Err(FdmError::Parse(s.into())) }

/// A value that is either an absolute number or a percentage of some base (`15%`, `120%`,
/// `15% of line width`). `base` keeps the trailing words (e.g. `"of line width"`), empty if none.
#[derive(Clone, Debug, PartialEq)]
pub struct FloatOrPercent { pub value: f64, pub percent: bool, pub base: String }
impl FloatOrPercent {
    /// Absolute value; a percentage is applied to `base_value`.
    pub fn resolve(&self, base_value: f64) -> f64 { if self.percent { base_value * self.value / 100.0 } else { self.value } }
}

/// Which extruder variant each extruder uses, to reduce Orca's variant arrays
/// (`Direct Drive Standard`, `Direct Drive High Flow`, `Bowden Standard`, `Bowden High Flow`).
#[derive(Clone, Debug)]
pub struct ExtruderSetup {
    /// Variant of extruder 0, 1, ... (one entry per extruder, in extruder order).
    pub variants: Vec<String>,
    /// Variant a filament preset is reduced to (the extruder that prints it).
    pub filament_variant: String,
}
impl Default for ExtruderSetup {
    /// X2D 0.4 nozzle, Standard flow: left Direct Drive, right Bowden; filament on the left extruder.
    fn default() -> Self {
        ExtruderSetup { variants: vec!["Direct Drive Standard".into(), "Bowden Standard".into()], filament_variant: "Direct Drive Standard".into() }
    }
}

/// BambuStudio-era preset keys that Orca reads under a newer name. Applied to the PRESETS only, before Orca's compiled
/// defaults are filled in, so a preset value is never shadowed by a default of the new name.
/// 2026-11-12 (review round 4, P0): BBL filament presets set `chamber_temperatures` (ASA X2D: 65); the engine and the
/// X2D templates read `chamber_temperature`, and the defaults file supplied `chamber_temperature = 0`. ASA, ABS, PC and
/// PA then printed with M141 S0 and the start G-code's cooling branch (chamber fan on, exhaust autocooling).
pub const LEGACY_ALIASES: &[(&str, &str)] = &[("chamber_temperatures", "chamber_temperature")];

/// Orca `PrintConfigDef::handle_legacy` (libslic3r/PrintConfig.cpp), the renames and value rewrites, applied to EACH
/// preset file's keys as it is read, so a child's old-name value overrides its parent's new-name value as in Orca.
/// `None` = Orca drops the key (its default then applies).
/// 🔴 bughunt 2026-11-15: only `chamber_temperatures` was translated. An older user preset carrying `bridge_fan_speed`,
/// `cooling`, `wall_infill_order`, `support_material_angle`, `sparse_infill_anchor`, `initial_layer_flow_ratio`, ... lost
/// that value with exit 0 and printed on the default (e.g. overhang fan or layer-cooling slowdown off).
/// Not ported: `different_settings_to_system` (UI bookkeeping), the `ignore` list and the `has()` check (an unknown
/// key stays in the map and shows in `unread_keys`).
pub fn handle_legacy(key: &str, value: &str) -> Option<(String, String)> {
    let v = value.to_string();
    let filament_id = |new: &str| Some((new.to_string(), if value == "1" { "0".to_string() } else { v.clone() }));
    let r = |new: &str| Some((new.to_string(), v.clone()));
    let val = |new: &str| Some((key.to_string(), new.to_string()));
    match key {
        "curr_bed_type" if value == "SuperTack Plate" => val("Supertack Plate"),
        "enable_wipe_tower" => r("enable_prime_tower"),
        "wipe_tower_width" => r("prime_tower_width"),
        "wiping_volume" => r("prime_volume"),
        "wipe_tower_brim_width" => r("prime_tower_brim_width"),
        "tool_change_gcode" => r("change_filament_gcode"),
        "bridge_fan_speed" => r("overhang_fan_speed"),
        "infill_extruder" | "sparse_infill_filament" => filament_id("sparse_infill_filament_id"),
        "solid_infill_extruder" | "solid_infill_filament" => filament_id("internal_solid_filament_id"),
        "top_solid_infill_filament" => filament_id("top_surface_filament_id"),
        "bottom_solid_infill_filament" => filament_id("bottom_surface_filament_id"),
        "perimeter_extruder" | "wall_filament" | "wall_filament_id" | "outer_wall_filament" => filament_id("outer_wall_filament_id"),
        "inner_wall_filament" => filament_id("inner_wall_filament_id"),
        "wipe_tower_extruder" => r("wipe_tower_filament"),
        "support_material_extruder" => r("support_filament"),
        "support_material_interface_extruder" => r("support_interface_filament"),
        "support_material_angle" => r("support_angle"),
        "support_material_enforce_layers" => r("enforce_support_layers"),
        "initial_layer_print_height" | "initial_layer_speed" | "internal_solid_infill_speed" | "top_surface_speed"
        | "support_interface_speed" | "outer_wall_speed" | "support_object_xy_distance" if value.contains('%') => None,
        "inherits_cummulative" => r("inherits_group"),
        "compatible_printers_condition_cummulative" => r("compatible_machine_expression_group"),
        "compatible_prints_condition_cummulative" => r("compatible_process_expression_group"),
        "cooling" => r("slow_down_for_layer_cooling"),
        "timelapse_no_toolhead" => r("timelapse_type"),
        "timelapse_type" if value == "2" => val("0"),
        "support_type" if value == "normal" => val("normal(manual)"),
        "support_type" if value == "tree" => val("tree(manual)"),
        "support_type" if value == "hybrid(auto)" => val("tree(auto)"),
        "support_base_pattern" if value == "none" => val("hollow"),
        "tree_support_wall_count" if value == "-1" => val("0"),
        "overhang_fan_threshold" if value == "5%" => val("10%"),
        "wall_infill_order" => Some(("wall_sequence".to_string(), match value {
            "inner wall/outer wall/infill" | "infill/inner wall/outer wall" => "inner wall/outer wall".to_string(),
            "outer wall/inner wall/infill" | "infill/outer wall/inner wall" => "outer wall/inner wall".to_string(),
            "inner-outer-inner wall/infill" => "inner-outer-inner wall".to_string(),
            _ => v.clone(),
        })),
        "nozzle_volume_type" | "default_nozzle_volume_type" | "printer_extruder_variant" | "print_extruder_variant"
        | "filament_extruder_variant" | "extruder_variant_list" => val(&value.replace("Normal", "Standard").replace("Big Traffic", "High Flow")),
        "extruder_type" => val(&value.replace("DirectDrive", "Direct Drive")),
        "enable_power_loss_recovery" => val(match value.to_ascii_lowercase().as_str() { "1" | "true" => "enable", "0" | "false" => "disable", _ => value }),
        "ensure_vertical_shell_thickness" => val(match value { "1" => "ensure_all", "0" => "ensure_moderate", _ => value }),
        "rotate_solid_infill_direction" => Some(("solid_infill_rotate_template".to_string(), match value { "1" => "0,90".to_string(), "0" => "0".to_string(), _ => v.clone() })),
        "sparse_infill_anchor" => r("infill_anchor"),
        "sparse_infill_anchor_max" => r("infill_anchor_max"),
        "chamber_temperatures" => r("chamber_temperature"),
        "thumbnail_size" => r("thumbnails"),
        "top_one_wall_type" if value != "none" => Some(("only_one_wall_top".to_string(), "1".to_string())),
        "initial_layer_flow_ratio" => r("bottom_solid_infill_flow_ratio"),
        "ironing_direction" => r("ironing_angle"),
        "ironing_angle" if value.starts_with('-') => val("0"),
        "counterbole_hole_bridging" => r("counterbore_hole_bridging"),
        "draft_shield" if value == "limited" => val("disabled"),
        "sparse_infill_pattern" | "top_surface_pattern" | "bottom_surface_pattern" | "internal_solid_infill_pattern"
        | "ironing_pattern" | "support_ironing_pattern" if value == "zig-zag" => val("rectilinear"),
        "filament_map_mode" if value == "Auto" => val("Auto For Flush"),
        "prime_tower_rib_wall" => if value == "1" { Some(("wipe_tower_wall_type".to_string(), "rib".to_string())) } else { None },
        "prime_tower_extra_rib_length" => r("wipe_tower_extra_rib_length"),
        "prime_tower_rib_width" => r("wipe_tower_rib_width"),
        "prime_tower_fillet_wall" => r("wipe_tower_fillet_wall"),
        "extruder_clearance_max_radius" => r("extruder_clearance_radius"),
        "machine_switch_extruder_time" => r("machine_tool_change_time"),
        "wall_direction" if value == "auto" => val("ccw"),
        _ => Some((key.to_string(), v)),
    }
}

fn legacy_aliases(map: &mut BTreeMap<String, String>) {
    for (old, new) in LEGACY_ALIASES {
        if let Some(v) = map.get(*old).cloned() { map.entry((*new).to_string()).or_insert(v); }
    }
}

#[derive(Debug, Default)]
pub struct Config {
    map: BTreeMap<String, String>,
    read: Mutex<BTreeSet<String>>,
}
impl Clone for Config {
    fn clone(&self) -> Self { Config { map: self.map.clone(), read: Mutex::new(self.read.lock().unwrap().clone()) } }
}

// ------------------------------------------------------------------ text helpers
/// Split a list value on `sep`, honouring double quotes (`"a,b",c` -> two items). Quotes are stripped.
fn split_list(v: &str, seps: &[char]) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut inq = false;
    let mut prev_bs = false;
    for ch in v.chars() {
        if ch == '"' && !prev_bs { inq = !inq; prev_bs = false; continue; }
        if !inq && seps.contains(&ch) { out.push(std::mem::take(&mut cur)); prev_bs = false; continue; }
        prev_bs = ch == '\\' && !prev_bs;
        cur.push(ch);
    }
    out.push(cur);
    out
}

fn unquote(v: &str) -> &str {
    let t = v.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') && !t[1..t.len() - 1].contains('"') { &t[1..t.len() - 1] } else { t }
}

fn unescape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() { Some('n') => o.push('\n'), Some('t') => o.push('\t'), Some('"') => o.push('"'), Some('\\') => o.push('\\'), Some(x) => { o.push('\\'); o.push(x) } None => o.push('\\') }
        } else { o.push(c) }
    }
    o
}

fn parse_f64(s: &str) -> Option<f64> { s.trim().parse::<f64>().ok().filter(|v| v.is_finite()) }

fn parse_fp(s: &str) -> Option<FloatOrPercent> {
    let t = s.trim();
    if let Some(i) = t.find('%') {
        let value = parse_f64(&t[..i])?;
        Some(FloatOrPercent { value, percent: true, base: t[i + 1..].trim().to_string() })
    } else { Some(FloatOrPercent { value: parse_f64(t)?, percent: false, base: String::new() }) }
}

impl Config {
    pub fn new() -> Self { Config::default() }
    pub fn from_map(map: BTreeMap<String, String>) -> Self { Config { map, read: Mutex::new(BTreeSet::new()) } }

    // -------------------------------------------------------------- G-code CONFIG_BLOCK
    /// Parse the CONFIG_BLOCK of an Orca G-code text. Errors when the block is missing or unterminated.
    pub fn from_gcode(text: &str) -> Result<Config, FdmError> {
        let mut map = BTreeMap::new();
        let (mut started, mut ended) = (false, false);
        // Orca writes the block at the END of a (possibly 100 MB) file: jump to the first line that is exactly the
        // start marker with a substring search instead of trimming and comparing every G-code line before it.
        // Same line the old loop stopped at (first line whose trim() equals the marker); the marker line itself is
        // then consumed below exactly as before.
        const START: &str = "; CONFIG_BLOCK_START";
        let mut from = 0usize;
        let mut body = "";
        while let Some(i) = text[from..].find(START) {
            let at = from + i;
            let ls = text[..at].rfind('\n').map_or(0, |p| p + 1);
            let le = text[at..].find('\n').map_or(text.len(), |p| at + p);
            if text[ls..le].trim() == START { started = true; body = &text[le..]; break; }
            from = at + START.len();
        }
        for line in body.lines() {
            let l = line.trim_end_matches('\r');
            if l.trim() == "; CONFIG_BLOCK_END" { ended = true; break; }
            let Some(rest) = l.strip_prefix("; ") else { continue };
            let Some((k, v)) = rest.split_once(" = ").or_else(|| rest.strip_suffix(" =").map(|k| (k, ""))) else { continue };
            map.insert(k.trim().to_string(), v.to_string());
        }
        if !started { return perr("no '; CONFIG_BLOCK_START' in G-code"); }
        if !ended { return perr("'; CONFIG_BLOCK_START' without '; CONFIG_BLOCK_END' (truncated G-code?)"); }
        if map.is_empty() { return perr("CONFIG_BLOCK is empty"); }
        Ok(Config::from_map(map))
    }
    pub fn from_gcode_file(path: &Path) -> Result<Config, FdmError> {
        let t = std::fs::read(path).map_err(|e| FdmError::Parse(format!("{}: {e}", path.display())))?;
        Config::from_gcode(&String::from_utf8_lossy(&t))
    }

    // -------------------------------------------------------------- raw access
    pub fn len(&self) -> usize { self.map.len() }
    pub fn is_empty(&self) -> bool { self.map.is_empty() }
    pub fn contains(&self, key: &str) -> bool { self.map.contains_key(key) }
    pub fn keys(&self) -> impl Iterator<Item = &String> { self.map.keys() }
    pub fn raw_map(&self) -> &BTreeMap<String, String> { &self.map }
    /// Override / add a raw value (e.g. a CLI `--set`). Does not touch the read tracker.
    pub fn set(&mut self, key: &str, value: &str) { self.map.insert(key.to_string(), value.to_string()); }

    fn touch(&self, key: &str) { self.read.lock().unwrap().insert(key.to_string()); }
    /// Raw value text, marking the key as read.
    pub fn raw(&self, key: &str) -> Option<&str> {
        let v = self.map.get(key)?;
        self.touch(key);
        Some(v.as_str())
    }
    /// Keys no accessor ever read, sorted. Call at the end of a run to see ignored settings.
    pub fn unread_keys(&self) -> Vec<String> {
        let r = self.read.lock().unwrap();
        self.map.keys().filter(|k| !r.contains(*k)).cloned().collect()
    }
    /// Explicitly mark keys as consciously unused (so they stop appearing in `unread_keys`).
    pub fn mark_read(&self, keys: &[&str]) { for k in keys { self.touch(k); } }
    /// Mark as read here every key `other` has read: a per-object copy of this config reads on its own tracker, and
    /// without this the plate-wide `unread_keys` would list keys that the object's planning did read.
    pub fn absorb_reads(&self, other: &Config) {
        let theirs: Vec<String> = other.read.lock().unwrap().iter().cloned().collect();
        let mut mine = self.read.lock().unwrap();
        for k in theirs { mine.insert(k); }
    }

    fn need(&self, key: &str) -> Result<&str, FdmError> { match self.raw(key) { Some(v) => Ok(v), None => perr(format!("missing config key '{key}'")) } }

    // -------------------------------------------------------------- scalar accessors
    /// String value with surrounding quotes removed (escapes untouched).
    pub fn str(&self, key: &str) -> Result<String, FdmError> { Ok(unquote(self.need(key)?).to_string()) }
    /// Text value: quotes removed and `\n` `\t` `\"` `\\` unescaped (G-code templates).
    pub fn text(&self, key: &str) -> Result<String, FdmError> { Ok(unescape(unquote(self.need(key)?))) }
    /// Enum value (the string Orca writes, e.g. `grid`, `outer_only`).
    pub fn enum_(&self, key: &str) -> Result<String, FdmError> { self.str(key) }
    /// Scalar float; for a per-extruder list the first element.
    pub fn f64(&self, key: &str) -> Result<f64> { self.f64_at(key, 0) }
    /// Per-extruder float; an index past the end falls back to element 0 (Orca's `get_at`).
    pub fn f64_at(&self, key: &str, idx: usize) -> Result<f64> {
        let v = self.need(key)?;
        let l = split_list(v, &[',']);
        let s = l.get(idx).or_else(|| l.first()).map(|s| s.as_str()).unwrap_or("");
        parse_f64(s).ok_or_else(|| FdmError::Parse(format!("config '{key}' = '{v}': element {idx} is not a number")))
    }
    pub fn i64(&self, key: &str) -> Result<i64> { self.i64_at(key, 0) }
    pub fn i64_at(&self, key: &str, idx: usize) -> Result<i64> {
        let x = self.f64_at(key, idx)?;
        if x.fract() != 0.0 { return perr(format!("config '{key}' = {x} is not an integer")); }
        Ok(x as i64)
    }
    pub fn usize(&self, key: &str) -> Result<usize> {
        let x = self.i64(key)?;
        usize::try_from(x).map_err(|_| FdmError::Parse(format!("config '{key}' = {x} is negative")))
    }
    /// Boolean: `1`/`0`/`true`/`false` (per-extruder list: first element).
    pub fn bool_(&self, key: &str) -> Result<bool> { self.bool_at(key, 0) }
    pub fn bool_at(&self, key: &str, idx: usize) -> Result<bool> {
        let v = self.need(key)?;
        let l = split_list(v, &[',']);
        match l.get(idx).or_else(|| l.first()).map(|s| s.trim()).unwrap_or("") {
            "1" | "true" => Ok(true), "0" | "false" => Ok(false),
            o => perr(format!("config '{key}' = '{v}': '{o}' is not a boolean")),
        }
    }
    /// `15%`, `15% of line width`, `0.4` ... (per-extruder: element `idx`).
    pub fn float_or_percent(&self, key: &str) -> Result<FloatOrPercent> { self.float_or_percent_at(key, 0) }
    pub fn float_or_percent_at(&self, key: &str, idx: usize) -> Result<FloatOrPercent> {
        let v = self.need(key)?;
        let l = split_list(v, &[',']);
        let s = l.get(idx).or_else(|| l.first()).map(|s| s.as_str()).unwrap_or("");
        parse_fp(s).ok_or_else(|| FdmError::Parse(format!("config '{key}' = '{v}': '{s}' is not a number or percentage")))
    }
    /// Percentage as a plain number (`15%` -> 15.0). Errors on a non-percent value (refuse, not guess).
    pub fn percent(&self, key: &str) -> Result<f64> {
        let p = self.float_or_percent(key)?;
        if p.percent { Ok(p.value) } else { perr(format!("config '{key}' is not a percentage")) }
    }

    // -------------------------------------------------------------- lists
    /// Comma list of floats (`50,50`). Empty value -> empty list.
    pub fn f64_list(&self, key: &str) -> Result<Vec<f64>> {
        let v = self.need(key)?;
        if v.trim().is_empty() { return Ok(vec![]); }
        split_list(v, &[',']).iter().map(|s| parse_f64(s).ok_or_else(|| FdmError::Parse(format!("config '{key}' = '{v}': '{s}' is not a number")))).collect()
    }
    /// Comma list of strings, quotes stripped. Variant lists (`"A";"B"`) use `;` -> see `str_list_semi`.
    pub fn str_list(&self, key: &str) -> Result<Vec<String>> {
        let v = self.need(key)?;
        if v.trim().is_empty() { return Ok(vec![]); }
        Ok(split_list(v, &[',']))
    }
    pub fn str_list_semi(&self, key: &str) -> Result<Vec<String>> {
        let v = self.need(key)?;
        if v.trim().is_empty() { return Ok(vec![]); }
        Ok(split_list(v, &[';']))
    }
    /// List of points `x,y` pairs separated by `x`-style `;`? Orca prints bed_shape as `0x0,256x0,...`.
    pub fn points(&self, key: &str) -> Result<Vec<[f64; 2]>> {
        let v = self.need(key)?;
        let mut out = vec![];
        for p in v.split(',').filter(|s| !s.trim().is_empty()) {
            let (a, b) = p.trim().split_once('x').ok_or_else(|| FdmError::Parse(format!("config '{key}': '{p}' is not 'XxY'")))?;
            match (parse_f64(a), parse_f64(b)) { (Some(a), Some(b)) => out.push([a, b]), _ => return perr(format!("config '{key}': '{p}' is not 'XxY'")) }
        }
        Ok(out)
    }

    /// Copy every key this Config lacks from `base` (e.g. the CONFIG_BLOCK of a reference Orca G-code, which
    /// carries Orca's compiled defaults that presets leave out). Returns how many keys were added.
    pub fn fill_missing(&mut self, base: &Config) -> usize {
        let mut n = 0;
        for (k, v) in &base.map { if !self.map.contains_key(k) { self.map.insert(k.clone(), v.clone()); n += 1; } }
        n
    }

    // -------------------------------------------------------------- presets
    /// Load machine + process + filament presets (names as in the Orca UI), flatten `inherits`,
    /// reduce variant arrays and merge into one Config. Filament keys do not clash with process keys
    /// in Orca; if one did, process/machine would win and it is reported through the error path below.
    pub fn from_presets(dirs: &PresetDirs, machine: &str, process: &str, filament: &str, ext: &ExtruderSetup) -> Result<Config, FdmError> {
        let mut map = BTreeMap::new();
        for (kind, name) in [(PresetKind::Machine, machine), (PresetKind::Process, process), (PresetKind::Filament, filament)] {
            let fp = dirs.load(kind, name)?;
            for (k, v) in fp.to_raw(ext)? {
                if let Some(old) = map.get(&k) {
                    if old != &v { return perr(format!("key '{k}' set to different values by two preset kinds ('{old}' vs '{v}' from {kind:?} '{name}')")); }
                }
                map.insert(k, v);
            }
        }
        legacy_aliases(&mut map);
        Ok(Config::from_map(map))
    }
}

// ====================================================================== presets
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresetKind { Machine, Process, Filament }
impl PresetKind {
    fn dir(self) -> &'static str { match self { PresetKind::Machine => "machine", PresetKind::Process => "process", PresetKind::Filament => "filament" } }
    fn variant_key(self) -> &'static str {
        match self { PresetKind::Machine => "printer_extruder_variant", PresetKind::Process => "print_extruder_variant", PresetKind::Filament => "filament_extruder_variant" }
    }
}

/// Where presets live. `root` is the OrcaSlicer config dir (default `~/.config/OrcaSlicer`).
#[derive(Clone, Debug)]
pub struct PresetDirs { pub root: PathBuf, pub user: String }
impl PresetDirs {
    pub fn default_orca() -> Result<PresetDirs> {
        let home = std::env::var_os("HOME").ok_or_else(|| FdmError::Parse("HOME not set".into()))?;
        Ok(PresetDirs { root: PathBuf::from(home).join(".config/OrcaSlicer"), user: "default".into() })
    }
    fn vendors(&self) -> Vec<String> {
        // BBL first, then the shared library, then the rest alphabetically (deterministic).
        let mut v: Vec<String> = std::fs::read_dir(self.root.join("system")).into_iter().flatten().flatten()
            .filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect();
        v.sort();
        let pri = |s: &String| match s.as_str() { "BBL" => 0, "OrcaFilamentLibrary" => 1, _ => 2 };
        v.sort_by_key(pri);
        v
    }
    /// Candidate directories in lookup order: user, then each system vendor (preferring `prefer_vendor`).
    fn search(&self, kind: PresetKind, prefer: Option<&str>) -> Vec<(String, PathBuf)> {
        let mut out = vec![("user".to_string(), self.root.join("user").join(&self.user).join(kind.dir()))];
        let mut vs = self.vendors();
        if let Some(p) = prefer { if let Some(i) = vs.iter().position(|v| v == p) { let x = vs.remove(i); vs.insert(0, x); } }
        for v in vs { let p = self.root.join("system").join(&v).join(kind.dir()); out.push((v, p)); }
        out
    }
    /// Locate `name`: file `<name>.json`, else a JSON in the same dir whose `"name"` equals it.
    fn find(&self, kind: PresetKind, name: &str, prefer: Option<&str>) -> Option<(String, PathBuf)> {
        for (origin, dir) in self.search(kind, prefer) {
            let f = dir.join(format!("{name}.json"));
            if f.is_file() { return Some((origin, f)); }
        }
        for (origin, dir) in self.search(kind, prefer) {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
            files.sort();
            for f in files {
                if let Ok(t) = std::fs::read_to_string(&f) {
                    if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&t) {
                        if o.get("name").and_then(Value::as_str) == Some(name) { return Some((origin, f)); }
                    }
                }
            }
        }
        None
    }

    /// Load a preset with its whole `inherits` chain flattened (parent first, child overrides).
    pub fn load(&self, kind: PresetKind, name: &str) -> Result<FlatPreset> {
        let mut chain: Vec<(String, Value)> = Vec::new();
        let mut want = name.to_string();
        let mut prefer: Option<String> = None;
        loop {
            if chain.iter().any(|(n, _)| *n == want) { return perr(format!("inherits cycle at '{want}'")); }
            let Some((origin, path)) = self.find(kind, &want, prefer.as_deref()) else {
                return perr(format!("{:?} preset '{want}' not found (looked in user/{} and system/*/{}); chain so far: {}", kind, self.user, kind.dir(), chain.iter().map(|c| c.0.as_str()).collect::<Vec<_>>().join(" <- ")));
            };
            let t = std::fs::read_to_string(&path).map_err(|e| FdmError::Parse(format!("{}: {e}", path.display())))?;
            let v: Value = serde_json::from_str(&t).map_err(|e| FdmError::Parse(format!("{}: {e}", path.display())))?;
            if !v.is_object() { return perr(format!("{}: not a JSON object", path.display())); }
            let parent = v.get("inherits").and_then(Value::as_str).unwrap_or("").to_string();
            if origin != "user" { prefer = Some(origin); }
            chain.push((want.clone(), v));
            if parent.is_empty() { break; }
            want = parent;
        }
        let names: Vec<String> = chain.iter().map(|c| c.0.clone()).collect();
        let mut full_variants: Option<Vec<String>> = None;
        for (_, v) in &chain {
            if let Some(Value::Array(a)) = v.get(kind.variant_key()) {
                let l: Vec<String> = a.iter().filter_map(|e| e.as_str().map(String::from)).collect();
                if full_variants.as_ref().map_or(true, |f| l.len() > f.len()) { full_variants = Some(l); }
            }
        }
        let mut map: BTreeMap<String, PVal> = BTreeMap::new();
        for (_, v) in chain.into_iter().rev() {
            let Value::Object(o) = v else { unreachable!() };
            for (k, x) in o {
                if k == "inherits" { continue; }
                let pv = match x {
                    Value::String(s) => PVal::S(s),
                    Value::Array(a) => PVal::L(a.into_iter().map(|e| match e { Value::String(s) => Ok(s), other => perr(format!("key '{k}': non-string list element {other}")) }).collect::<Result<Vec<_>>>()?),
                    Value::Number(n) => PVal::S(n.to_string()),
                    Value::Bool(b) => PVal::S((b as i32).to_string()),
                    other => return perr(format!("key '{k}': unsupported JSON value {other}")),
                };
                // Orca (ConfigBase::load_from_json): a string value goes through handle_legacy with its value; an array
                // only has its KEY translated (handle_legacy sees an empty value), its elements are kept as they are.
                let (k, pv) = match pv {
                    PVal::S(s) => {
                        // the two side effects load_from_json adds for these old values
                        if k == "support_type" && s == "hybrid(auto)" { map.insert("support_style".into(), PVal::S("tree_hybrid".into())); }
                        if k == "wall_infill_order" && s.starts_with("infill/") { map.insert("is_infill_first".into(), PVal::S("1".into())); }
                        match handle_legacy(&k, &s) { Some((nk, nv)) => (nk, PVal::S(nv)), None => continue }
                    }
                    PVal::L(l) => match handle_legacy(&k, "") { Some((nk, _)) => (nk, PVal::L(l)), None => continue },
                };
                map.insert(k, pv);
            }
        }
        Ok(FlatPreset { kind, name: name.to_string(), chain: names, map, full_variants })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PVal { S(String), L(Vec<String>) }

/// A preset with its inherit chain merged. `chain[0]` is the preset itself, last is the root.
#[derive(Clone, Debug)]
pub struct FlatPreset { pub kind: PresetKind, pub name: String, pub chain: Vec<String>, pub map: BTreeMap<String, PVal>, pub full_variants: Option<Vec<String>> }
/// Orca's cstyle escaping for multi-line text values.
/// Orca `escape_strings_cstyle` (libslic3r/Config.cpp): elements joined with ';', an element quoted only when it
/// holds a space, ';', tab, backslash, '"', CR or LF (or is the only element and empty); inside quotes `\\`, `\"`,
/// `\n`, `\r` are escaped. This is how a ConfigOptionStrings value appears in Orca's CONFIG_BLOCK.
fn escape_strings_cstyle(strs: &[String]) -> String {
    let mut out = String::new();
    for (j, s) in strs.iter().enumerate() {
        if j > 0 { out.push(';'); }
        let quote = (strs.len() == 1 && s.is_empty()) || s.contains([' ', ';', '\t', '\\', '"', '\r', '\n']);
        if !quote { out.push_str(s); continue; }
        out.push('"');
        for c in s.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                c => out.push(c),
            }
        }
        out.push('"');
    }
    out
}

fn esc(s: &str) -> String { if s.contains(['\n', '\r', '\\']) { s.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r") } else { s.to_string() } }

/// Orca's per-variant option sets (OrcaSlicer src/libslic3r/PrintConfig.cpp: print_options_with_variant,
/// filament_options_with_variant, printer_options_with_variant_1 / _2). Returns the number of values per variant
/// (2 for the machine-limit keys, stored as (normal, silent) pairs), or None for a key that is not per-variant.
fn variant_stride(kind: PresetKind, key: &str) -> Option<usize> {
    const PRINT: &[&str] = &["initial_layer_speed", "initial_layer_infill_speed", "outer_wall_speed", "inner_wall_speed", "small_perimeter_speed",
        "small_perimeter_threshold", "sparse_infill_speed", "internal_solid_infill_speed", "top_surface_speed", "enable_overhang_speed",
        "overhang_1_4_speed", "overhang_2_4_speed", "overhang_3_4_speed", "overhang_4_4_speed", "slowdown_for_curled_perimeters", "bridge_speed",
        "internal_bridge_speed", "gap_infill_speed", "support_speed", "support_interface_speed", "travel_speed", "travel_speed_z",
        "initial_layer_travel_speed", "default_acceleration", "bridge_acceleration", "travel_acceleration", "initial_layer_travel_acceleration",
        "initial_layer_acceleration", "outer_wall_acceleration", "inner_wall_acceleration", "sparse_infill_acceleration",
        "internal_solid_infill_acceleration", "top_surface_acceleration", "default_jerk", "outer_wall_jerk", "inner_wall_jerk", "infill_jerk",
        "top_surface_jerk", "initial_layer_jerk", "travel_jerk", "initial_layer_travel_jerk", "default_junction_deviation", "print_extruder_id",
        "top_solid_infill_flow_ratio"];
    const FILAMENT: &[&str] = &["filament_flow_ratio", "filament_max_volumetric_speed", "filament_ramming_volumetric_speed",
        "filament_pre_cooling_temperature", "filament_ramming_travel_time", "filament_ramming_volumetric_speed_nc", "filament_pre_cooling_temperature_nc",
        "filament_ramming_travel_time_nc", "filament_retract_length_nc", "filament_preheat_temperature_delta", "filament_retraction_length",
        "filament_z_hop", "filament_z_hop_types", "filament_retract_lift_above", "filament_retract_lift_below", "filament_retract_lift_enforce",
        "filament_retract_restart_extra", "filament_retract_length_toolchange", "filament_retract_restart_extra_toolchange", "filament_retraction_speed",
        "filament_deretraction_speed", "filament_retraction_minimum_travel", "filament_retract_when_changing_layer", "filament_wipe",
        "filament_wipe_distance", "filament_retract_before_wipe", "filament_retract_after_wipe", "filament_long_retractions_when_cut",
        "filament_retraction_distances_when_cut", "long_retractions_when_ec", "retraction_distances_when_ec", "nozzle_temperature_initial_layer",
        "nozzle_temperature", "filament_flush_volumetric_speed", "filament_flush_temp", "filament_cooling_before_tower", "volumetric_speed_coefficients",
        "filament_adaptive_volumetric_speed", "filament_ironing_flow", "filament_ironing_spacing", "filament_ironing_inset", "filament_ironing_speed",
        "enable_pressure_advance", "pressure_advance", "adaptive_pressure_advance", "adaptive_pressure_advance_model",
        "adaptive_pressure_advance_overhangs", "adaptive_pressure_advance_bridges", "fan_min_speed", "fan_max_speed", "additional_cooling_fan_speed",
        "filament_minimal_purge_on_wipe_tower", "filament_multitool_ramming", "filament_multitool_ramming_volume", "filament_multitool_ramming_flow",
        "nozzle_temperature_range_low", "nozzle_temperature_range_high", "activate_air_filtration", "activate_air_filtration_during_print",
        "activate_air_filtration_on_completion", "during_print_exhaust_fan_speed", "complete_print_exhaust_fan_speed"];
    const PRINTER_1: &[&str] = &["nozzle_volume", "retraction_length", "z_hop", "travel_slope", "retract_lift_above", "retract_lift_below",
        "retract_lift_enforce", "z_hop_types", "retraction_speed", "deretraction_speed", "retraction_minimum_travel", "retract_when_changing_layer",
        "wipe", "wipe_distance", "retract_before_wipe", "retract_after_wipe", "retract_length_toolchange", "retract_restart_extra",
        "retract_restart_extra_toolchange", "long_retractions_when_cut", "retraction_distances_when_cut", "nozzle_type", "printer_extruder_id",
        "hotend_cooling_rate", "hotend_heating_rate", "nozzle_flush_dataset"];
    const PRINTER_2: &[&str] = &["machine_max_acceleration_x", "machine_max_acceleration_y", "machine_max_acceleration_z", "machine_max_acceleration_e",
        "machine_max_acceleration_extruding", "machine_max_acceleration_retracting", "machine_max_acceleration_travel", "machine_max_speed_x",
        "machine_max_speed_y", "machine_max_speed_z", "machine_max_speed_e", "machine_max_jerk_x", "machine_max_jerk_y", "machine_max_jerk_z",
        "machine_max_jerk_e", "machine_max_junction_deviation"];
    match kind {
        PresetKind::Process => PRINT.contains(&key).then_some(1),
        PresetKind::Filament => FILAMENT.contains(&key).then_some(1),
        PresetKind::Machine => if PRINTER_1.contains(&key) { Some(1) } else if PRINTER_2.contains(&key) { Some(2) } else { None },
    }
}

impl FlatPreset {
    /// Render to Orca's CONFIG_BLOCK text form: variant arrays reduced to the active extruders, other
    /// lists comma-joined. Metadata keys (`from`, `type`, `instantiation`, `setting_id`, `version`,
    /// `is_custom_defined`) are dropped; `name` is dropped (Orca writes `<kind>_settings_id`).
    pub fn to_raw(&self, ext: &ExtruderSetup) -> Result<BTreeMap<String, String>> {
        let vkey = self.kind.variant_key();
        // The full variant list is the longest one seen in the chain: a user preset may override the key
        // with only its own variant while still inheriting the full-width arrays from the system parent.
        let variants: Option<&Vec<String>> = self.full_variants.as_ref();
        let targets: Vec<String> = match self.kind { PresetKind::Filament => vec![ext.filament_variant.clone()], _ => ext.variants.clone() };
        let mut out = BTreeMap::new();
        // 🔴 A STRING-VECTOR option (filament_start_gcode, filament_end_gcode, ...) is written the way Orca writes
        // it: each element quoted, joined with ';'. It was joined with ',' and left bare until 2026-11-14, and the
        // reader (motion::settings::split_vector) reads a bare string vector up to the next ';' after dropping a
        // leading ';'. So `; filament start gcode\nM106 P3 S200 ; exhaust fan\nM142 ...` ran as a bare
        // `filament start gcode` line sent to the printer, then M106, and everything after the inline comment
        // (M142 here; heater-off and fan lines in an end G-code) was silently dropped.
        // Elements arrive UNESCAPED; this is the one place they are escaped.
        let join = |k: &str, elems: Vec<String>| -> String {
            if crate::motion::settings::opt_kind(k) == (crate::motion::settings::OptKind::Str, true) {
                escape_strings_cstyle(&elems)
            } else {
                elems.iter().map(|x| esc(x)).collect::<Vec<_>>().join(",")
            }
        };
        for (k, v) in &self.map {
            if matches!(k.as_str(), "from" | "type" | "instantiation" | "setting_id" | "version" | "is_custom_defined" | "name" | "filament_id" | "base_id" | "description") { continue; }
            let s = match v {
                PVal::S(s) => esc(s),
                PVal::L(l) => {
                    if k == vkey {
                        targets.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(";")
                    } else if let (Some(stride), Some(vs)) = (variant_stride(self.kind, k), variants.filter(|vs| vs.len() > 1)) {
                        // Only Orca's per-variant keys are reduced (PrintConfig.cpp print_/filament_options_with_variant,
                        // printer_options_with_variant_1, and _2 = (normal, silent) PAIRS per variant). A list that merely
                        // has as many entries as there are variants (a 4-corner printable_area on a 4-variant machine) is
                        // NOT a per-variant value: reducing it turned the X2D bed into '0x0,256x256' (measured 2026-10-16).
                        if l.len() == stride && vs.len() > 1 {
                            // one value set for every variant (an older or hand-written preset): Orca repeats it per extruder
                            join(k, (0..targets.len()).flat_map(|_| l.iter().cloned()).collect::<Vec<_>>())
                        } else {
                        if l.len() != vs.len() * stride {
                            return perr(format!("{:?} preset '{}': key '{k}' has {} value(s), expected {} ({} variant(s) x {stride})", self.kind, self.name, l.len(), vs.len() * stride, vs.len()));
                        }
                        let mut picked = Vec::new();
                        for t in &targets {
                            let Some(i) = vs.iter().position(|x| x == t) else { return perr(format!("{:?} preset '{}': variant '{t}' not in {vkey} {:?}", self.kind, self.name, vs)); };
                            for j in 0..stride { picked.push(l[i * stride + j].clone()); }
                        }
                        join(k, picked)
                        }
                    } else if k == "extruder_printable_area" {
                        // ConfigOptionPointsGroups: one point list per extruder, groups separated by '#' in the CONFIG_BLOCK
                        l.iter().map(|x| x.trim().to_string()).collect::<Vec<_>>().join("#")
                    } else { join(k, l.iter().map(|x| x.trim_end().to_string()).collect::<Vec<_>>()) }
                }
            };
            out.insert(k.clone(), s);
        }
        // Orca records the preset name in <kind>_settings_id.
        let id = match self.kind { PresetKind::Machine => "printer_settings_id", PresetKind::Process => "print_settings_id", PresetKind::Filament => "filament_settings_id" };
        let nm = if self.kind == PresetKind::Filament { format!("\"{}\"", self.name) } else { self.name.clone() };
        out.insert(id.to_string(), nm);
        Ok(out)
    }
}

// ====================================================================== tests
#[cfg(test)]
mod tests {
    #[test]
    fn a_string_vector_survives_to_raw_and_the_reader_whole() {
        // 🔴 Joined with ',' and unquoted until 2026-11-14: the reader dropped the leading ';' and stopped at the next
        // one, so a filament start G-code ran as a bare `filament start gcode` line and lost every line after an inline
        // comment (here M142).
        let g = "; filament start gcode\nM106 P3 S200 ; exhaust fan\nM142 P1 R35 S40\n".to_string();
        let raw = escape_strings_cstyle(&[g.clone()]);
        assert!(raw.starts_with('"') && raw.ends_with('"'), "{raw}");
        let back = crate::motion::settings::split_vector(&raw, true);
        assert_eq!(back, vec!["; filament start gcode\\nM106 P3 S200 ; exhaust fan\\nM142 P1 R35 S40\\n".to_string()], "{raw}");
        // Orca's form for plain elements: bare, ';'-joined; quoted only when needed.
        assert_eq!(escape_strings_cstyle(&["PLA".into(), "PETG".into()]), "PLA;PETG");
        assert_eq!(escape_strings_cstyle(&["a b".into(), "q\"x".into()]), "\"a b\";\"q\\\"x\"");
        assert_eq!(escape_strings_cstyle(&[String::new()]), "\"\"");
    }

    #[test]
    fn config_block_found_after_decoys_and_crlf() {
        let t = "G1 X1\r\n; CONFIG_BLOCK_START_NOT\n;; CONFIG_BLOCK_START\nx ; CONFIG_BLOCK_START\n   ; CONFIG_BLOCK_START  \r\n; a = 1\r\n; b =\n; CONFIG_BLOCK_END\n; c = 3\n";
        let c = Config::from_gcode(t).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c.raw("a"), Some("1"));
        assert_eq!(c.raw("b"), Some(""));
        assert!(Config::from_gcode("; CONFIG_BLOCK_START_X\n; a = 1\n").is_err());
        assert!(Config::from_gcode("; CONFIG_BLOCK_START\n; a = 1\n").is_err()); // unterminated
    }
    use super::*;
    const G: &str = "; HEADER\nG1 X1\n; CONFIG_BLOCK_START\n; bridge_speed = 50,50\n; sparse_infill_density = 15%\n; x = 15% of line width\n; wall_loops = 2\n; enable_arc_fitting = 1\n; sparse_infill_pattern = grid\n; start = \"G1 X1\\nG1 Y2\"\n; list = \"a,b\",c\n; empty = \n; unknown_key = 7\n; bed_shape = 0x0,256x0,256x256\n; CONFIG_BLOCK_END\nG1 X2\n";
    #[test] fn parse_block() {
        let c = Config::from_gcode(G).unwrap();
        assert_eq!(c.len(), 11);
        assert_eq!(c.f64_list("bridge_speed").unwrap(), vec![50.0, 50.0]);
        assert_eq!(c.f64_at("bridge_speed", 5).unwrap(), 50.0);
        assert_eq!(c.percent("sparse_infill_density").unwrap(), 15.0);
        let p = c.float_or_percent("x").unwrap();
        assert!(p.percent && p.value == 15.0 && p.base == "of line width" && (p.resolve(0.4) - 0.06).abs() < 1e-12);
        assert_eq!(c.usize("wall_loops").unwrap(), 2);
        assert!(c.bool_("enable_arc_fitting").unwrap());
        assert_eq!(c.enum_("sparse_infill_pattern").unwrap(), "grid");
        assert_eq!(c.text("start").unwrap(), "G1 X1\nG1 Y2");
        assert_eq!(c.str_list("list").unwrap(), vec!["a,b", "c"]);
        assert!(c.f64_list("empty").unwrap().is_empty());
        assert_eq!(c.points("bed_shape").unwrap().len(), 3);
        assert!(c.f64("nope").is_err());
        assert!(c.bool_("wall_loops").is_err());
        assert!(c.percent("wall_loops").is_err());
    }
    #[test] fn unread_tracking() {
        let c = Config::from_gcode(G).unwrap();
        let _ = c.f64("bridge_speed");
        let u = c.unread_keys();
        assert!(u.contains(&"unknown_key".to_string()) && !u.contains(&"bridge_speed".to_string()));
        c.mark_read(&["unknown_key"]);
        assert!(!c.unread_keys().contains(&"unknown_key".to_string()));
    }
    #[test] fn truncated_and_missing_block() {
        assert!(Config::from_gcode("G1 X1\n").is_err());
        assert!(Config::from_gcode("; CONFIG_BLOCK_START\n; a = 1\n").is_err());
    }
    fn tmp_dirs(tag: &str) -> PresetDirs {
        let root = std::env::temp_dir().join(format!("fdm-l1-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["user/default/process", "system/BBL/process"] { std::fs::create_dir_all(root.join(d)).unwrap(); }
        PresetDirs { root, user: "default".into() }
    }
    fn w(d: &PresetDirs, p: &str, s: &str) { std::fs::write(d.root.join(p), s).unwrap(); }
    #[test] fn inherits_flatten_and_variants() {
        let d = tmp_dirs("a");
        w(&d, "system/BBL/process/root.json", r#"{"name":"root","print_extruder_variant":["Direct Drive Standard","Direct Drive High Flow","Bowden Standard","Bowden High Flow"],"bridge_speed":["50","60","70","80"],"wall_loops":"2","layer_height":"0.2"}"#);
        w(&d, "system/BBL/process/mid.json", r#"{"name":"mid","inherits":"root","wall_loops":"3"}"#);
        w(&d, "user/default/process/mine.json", r#"{"name":"mine","inherits":"mid","layer_height":"0.16","foo_unknown":"1"}"#);
        let fp = d.load(PresetKind::Process, "mine").unwrap();
        assert_eq!(fp.chain, vec!["mine", "mid", "root"]);
        let raw = fp.to_raw(&ExtruderSetup::default()).unwrap();
        assert_eq!(raw["wall_loops"], "3");
        assert_eq!(raw["layer_height"], "0.16");
        assert_eq!(raw["bridge_speed"], "50,70");
        assert_eq!(raw["foo_unknown"], "1");
        assert_eq!(raw["print_extruder_variant"], "\"Direct Drive Standard\";\"Bowden Standard\"");
    }
    #[test] fn a_filament_start_gcode_reaches_the_reader_whole_through_to_raw() {
        // 🔴 Until 2026-11-14 to_raw joined a string vector with ',' unquoted, and Settings read the start G-code up to
        // its first inline ';': `filament start gcode` ran as a bare line and M142 was lost.
        let d = tmp_dirs("fsg");
        std::fs::create_dir_all(d.root.join("user/default/filament")).unwrap();
        w(&d, "user/default/filament/f.json", r#"{"name":"f","filament_type":["PLA"],"filament_start_gcode":["; filament start gcode\nM106 P3 S200 ; exhaust fan\nM142 P1 R35 S40\n"]}"#);
        let raw = d.load(PresetKind::Filament, "f").unwrap().to_raw(&ExtruderSetup::default()).unwrap();
        let mut st = crate::motion::settings::Settings::default();
        for (k, v) in &raw { st.set(k, v); }
        // (trailing whitespace of a list element is trimmed by to_raw, as before)
        assert_eq!(st.text_at("filament_start_gcode", 0), "; filament start gcode\nM106 P3 S200 ; exhaust fan\nM142 P1 R35 S40", "raw {:?}", raw["filament_start_gcode"]);
        assert_eq!(raw["filament_type"], "PLA");
    }
    /// Only Orca's per-variant keys are reduced. Measured 2026-10-16 on the real X2D machine preset: a 4-corner
    /// printable_area on a 4-variant machine came out as '0x0,256x256', the (normal, silent) machine limits were not
    /// reduced at all, and the two extruder areas were joined with ',' instead of '#'.
    #[test] fn machine_variant_reduction_follows_orcas_key_sets() {
        let d = tmp_dirs("m");
        std::fs::create_dir_all(d.root.join("system/BBL/machine")).unwrap();
        w(&d, "system/BBL/machine/x.json", r#"{"name":"x","printer_extruder_variant":["Direct Drive Standard","Direct Drive High Flow","Bowden Standard","Bowden High Flow"],
            "printable_area":["0x0","256x0","256x256","0x256 "],"machine_max_speed_e":["30","30","31","31","120","120","121","121"],
            "retraction_length":["0.8","0.9","1.8","1.9"],"extruder_printable_area":["0x0,256x0,256x256,0x256","20.5x0,256x0,256x256,20.5x256"],"nozzle_diameter":["0.4","0.4"]}"#);
        let raw = d.load(PresetKind::Machine, "x").unwrap().to_raw(&ExtruderSetup::default()).unwrap();
        assert_eq!(raw["printable_area"], "0x0,256x0,256x256,0x256");
        assert_eq!(raw["machine_max_speed_e"], "30,30,120,120");
        assert_eq!(raw["retraction_length"], "0.8,1.8");
        assert_eq!(raw["extruder_printable_area"], "0x0,256x0,256x256,0x256#20.5x0,256x0,256x256,20.5x256");
        assert_eq!(raw["nozzle_diameter"], "0.4,0.4");
    }
    #[test] fn missing_parent_is_error() {
        let d = tmp_dirs("b");
        w(&d, "user/default/process/orphan.json", r#"{"name":"orphan","inherits":"does not exist"}"#);
        let e = d.load(PresetKind::Process, "orphan").unwrap_err().to_string();
        assert!(e.contains("does not exist"), "{e}");
        assert!(d.load(PresetKind::Process, "nope").is_err());
    }
    #[test] fn inherits_cycle_is_error() {
        let d = tmp_dirs("c");
        w(&d, "user/default/process/a.json", r#"{"name":"a","inherits":"b"}"#);
        w(&d, "user/default/process/b.json", r#"{"name":"b","inherits":"a"}"#);
        assert!(d.load(PresetKind::Process, "a").is_err());
    }
    /// Real-data check: user process + filament presets resolve through the system chain, and the
    /// process/filament values agree with an Orca G-code CONFIG_BLOCK. Other agents slice with `--set`
    /// overrides on the same server, so the job with the FEWEST disagreements (of the newest 40 pnp-coupon
    /// jobs) is used and at most 5 unexplained keys are tolerated. PENDING (printed) when this machine has
    /// no Orca config or no such job.
    #[test] fn real_presets_vs_orca_block() {
        let Ok(d) = PresetDirs::default_orca() else { eprintln!("PENDING real_presets: no HOME"); return };
        let mut jobs: Vec<PathBuf> = std::fs::read_dir("/tmp/web-slicer-jobs").into_iter().flatten().flatten().map(|e| e.path().join("plate_1.gcode")).filter(|p| p.is_file()).collect();
        jobs.sort_by_key(|p| std::cmp::Reverse(p.metadata().and_then(|m| m.modified()).ok()));
        let allowed = ["enable_prime_tower", "enable_filament_ramming", "filament_dev_ams_drying_ams_limitations", "auxiliary_fan"];
        let norm = |s: &str| split_list(s, &[',']).iter().map(|x| parse_f64(x).map(|f| f.to_string()).unwrap_or(x.trim().to_string())).collect::<Vec<_>>().join(",");
        let mut best: Option<(Vec<String>, usize, PathBuf)> = None;
        for job in jobs.into_iter().take(200) {
            let Ok(block) = Config::from_gcode_file(&job) else { continue };
            let Ok(ps) = block.str("print_settings_id") else { continue };
            if !ps.ends_with("pnp coupon") { continue; }
            let fs_ = block.str("filament_settings_id").unwrap();
            let (Ok(pp), Ok(fp)) = (d.load(PresetKind::Process, &ps), d.load(PresetKind::Filament, &fs_)) else { continue };
            assert!(pp.chain.len() >= 2, "{:?}", pp.chain);
            let (mut checked, mut bad) = (0, vec![]);
            for fpre in [&pp, &fp] {
                for (k, v) in fpre.to_raw(&ExtruderSetup::default()).unwrap() {
                    if k.ends_with("_settings_id") || k.contains("gcode") || k == "extruder_colour" || allowed.contains(&k.as_str()) { continue; }
                    let Some(b) = block.raw_map().get(&k) else { continue };
                    checked += 1;
                    if norm(unquote(&v)) != norm(unquote(b)) { bad.push(format!("{k}: preset '{v}' block '{b}'")); }
                }
            }
            if best.as_ref().map_or(true, |b| bad.len() < b.0.len()) { best = Some((bad, checked, job)); }
            if best.as_ref().unwrap().0.is_empty() || best.as_ref().unwrap().0.len() <= 1 { break; }
        }
        let Some((bad, checked, job)) = best else { eprintln!("PENDING real_presets: no pnp-coupon reference job loadable here"); return };
        eprintln!("real_presets: {checked} process/filament keys vs {} -> {} differ {:?}", job.display(), bad.len(), bad);
        assert!(checked > 200, "population examined too small: {checked}");
        assert!(bad.len() <= 5, "{bad:?}");
    }
}

#[cfg(test)]
mod legacy_alias_tests {
    use super::*;
    #[test]
    fn orca_legacy_keys_reach_their_new_names_and_a_child_old_key_overrides_a_parent_new_key() {
        // bughunt 2026-11-15: only chamber_temperatures was translated; an old user preset lost these values silently.
        let d = std::env::temp_dir().join(format!("fdm-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let w = |rel: &str, body: &str| { let p = d.join(rel); std::fs::create_dir_all(p.parent().unwrap()).unwrap(); std::fs::write(p, body).unwrap(); };
        w("system/BBL/process/root.json", r#"{"name":"root","overhang_fan_speed":"0","slow_down_for_layer_cooling":"0","wall_sequence":"inner wall/outer wall"}"#);
        w("user/default/process/old.json", r#"{"name":"old","inherits":"root","bridge_fan_speed":"100","cooling":"1",
            "wall_infill_order":"infill/outer wall/inner wall","support_type":"tree","sparse_infill_anchor":"400%",
            "initial_layer_speed":"50%","prime_tower_rib_wall":"0","support_material_angle":["30"]}"#);
        let dirs = PresetDirs { root: d.clone(), user: "default".into() };
        let fp = dirs.load(PresetKind::Process, "old").unwrap();
        let get = |k: &str| fp.map.get(k).cloned();
        assert_eq!(get("overhang_fan_speed"), Some(PVal::S("100".into())));
        assert_eq!(get("slow_down_for_layer_cooling"), Some(PVal::S("1".into())));
        assert_eq!(get("wall_sequence"), Some(PVal::S("outer wall/inner wall".into())));
        assert_eq!(get("is_infill_first"), Some(PVal::S("1".into())));
        assert_eq!(get("support_type"), Some(PVal::S("tree(manual)".into())));
        assert_eq!(get("infill_anchor"), Some(PVal::S("400%".into())));
        assert_eq!(get("support_angle"), Some(PVal::L(vec!["30".into()])));
        for gone in ["bridge_fan_speed", "cooling", "wall_infill_order", "sparse_infill_anchor", "initial_layer_speed", "prime_tower_rib_wall", "wipe_tower_wall_type", "support_material_angle"] {
            assert!(get(gone).is_none(), "{gone} still present");
        }
        let _ = std::fs::remove_dir_all(&d);
    }
    #[test]
    fn chamber_temperatures_feeds_chamber_temperature() {
        let mut m = BTreeMap::new();
        m.insert("chamber_temperatures".to_string(), "65".to_string());
        legacy_aliases(&mut m);
        assert_eq!(m.get("chamber_temperature").map(String::as_str), Some("65"));
        // a defaults file filled in AFTER must not shadow it
        let mut c = Config::from_map(m);
        let mut d = BTreeMap::new();
        d.insert("chamber_temperature".to_string(), "0".to_string());
        c.fill_missing(&Config::from_map(d));
        assert_eq!(c.raw("chamber_temperature"), Some("65"));
    }
    #[test]
    fn an_explicit_new_key_wins_over_the_old_one() {
        let mut m = BTreeMap::new();
        m.insert("chamber_temperatures".to_string(), "65".to_string());
        m.insert("chamber_temperature".to_string(), "50".to_string());
        legacy_aliases(&mut m);
        assert_eq!(m.get("chamber_temperature").map(String::as_str), Some("50"));
    }
}
