//! Lane 9: thin client for the local Orca slicing server (curl; no HTTP dependency). Used by the evaluation
//! harness only; the library paths never call it.
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SERVER: &str = "http://127.0.0.1:8765";
pub const PROCESS: &str = "0.20mm Standard @BBL X2D - pnp coupon";
pub const FILAMENT: &str = "Green PETG 1.75 @coupon 235";
pub const BED: &str = "Textured PEI Plate";

/// Characters the server accepts in a `set=` value (its regexp `[\w .,%/@+-]*`). Anything else (e.g. `normal(auto)`) goes through a scratch preset.
pub fn server_safe(v: &str) -> bool { v.chars().all(|c| c.is_alphanumeric() || c == '_' || " .,%/@+-".contains(c)) }

fn user_process_dir() -> PathBuf { PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/OrcaSlicer/user/default/process") }

/// Remove every scratch preset this module created (`l9-scratch-*.json`). Called at the end of every evaluation run.
pub fn cleanup_scratch() -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(user_process_dir()) { for e in rd.flatten() { let nm = e.file_name().to_string_lossy().to_string(); if nm.starts_with("l9-scratch") && nm.ends_with(".json") && std::fs::remove_file(e.path()).is_ok() { n += 1; } } }
    n
}

/// Write a scratch process preset: the pnp coupon preset plus `over` (values the `set=` channel cannot carry). Returns its name.
fn scratch_preset(over: &[(&str, &str)]) -> Result<String, String> {
    let dir = user_process_dir();
    let base: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{PROCESS}.json"))).map_err(|e| format!("process preset: {e}"))?).map_err(|e| e.to_string())?;
    let mut key = String::new(); for (k, v) in over { key += &format!("{k}={v};"); }
    let name = format!("l9-scratch-{:012x}", fnv(&key) & 0xffffffffffff);
    let mut j = base;
    j["name"] = name.clone().into(); j["print_settings_id"] = name.clone().into(); j["inherits"] = PROCESS.into();
    for (k, v) in over { j[*k] = (*v).into(); }
    std::fs::write(dir.join(format!("{name}.json")), serde_json::to_string_pretty(&j).unwrap()).map_err(|e| e.to_string())?;
    Ok(name)
}

pub fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() { if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { o.push(b as char) } else { o += &format!("%{b:02X}") } }
    o
}

fn fnv(s: &str) -> u64 { let mut h = 0xcbf29ce484222325u64; for b in s.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); } h }

/// Slice `stl` with Orca and return the G-code text. Results are cached under `cache` keyed by the STL bytes + overrides
/// (`cache = None` disables). Err = could not run (server down, rejected): the caller must report PENDING, not PASS.
pub fn slice(stl: &Path, sets: &[(&str, &str)], cache: Option<&Path>) -> Result<String, String> {
    let bytes = std::fs::read(stl).map_err(|e| format!("{}: {e}", stl.display()))?;
    let mut key = format!("{}|{}|{}|{}|{}", stl.file_name().unwrap().to_string_lossy(), bytes.len(), PROCESS, FILAMENT, BED);
    for (k, v) in sets { key += &format!("|{k}={v}"); }
    for b in bytes.iter().step_by(97) { key.push((b'a' + (b % 26)) as char); }
    let cpath: Option<PathBuf> = cache.map(|d| d.join(format!("{}-{:016x}.gcode", stl.file_stem().unwrap().to_string_lossy(), fnv(&key))));
    if let Some(p) = &cpath { if let Ok(t) = std::fs::read_to_string(p) { if t.contains("CONFIG_BLOCK_END") { return Ok(t); } } }
    let (safe, unsafe_): (Vec<(&str, &str)>, Vec<(&str, &str)>) = sets.iter().cloned().partition(|(_, v)| server_safe(v));
    let process = if unsafe_.is_empty() { PROCESS.to_string() } else { scratch_preset(&unsafe_)? };
    let mut url = format!("{SERVER}/api/slice?process={}&filament={}&bed={}&name={}", urlenc(&process), urlenc(FILAMENT), urlenc(BED), urlenc(&stl.file_name().unwrap().to_string_lossy()));
    for (k, v) in &safe { url += &format!("&set={}", urlenc(&format!("{k}={v}"))); }
    let out = Command::new("curl").args(["-s", "-m", "900", "--data-binary", &format!("@{}", stl.display()), &url]).output().map_err(|e| format!("curl: {e}"))?;
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    let j: serde_json::Value = serde_json::from_str(&body).map_err(|_| format!("Orca server reply is not JSON: {}", body.chars().take(200).collect::<String>()))?;
    if j.get("ok").and_then(|v| v.as_bool()) == Some(false) { return Err(format!("Orca refused: {}", j.get("error").and_then(|v| v.as_str()).unwrap_or("?"))); }
    let id = j.get("id").and_then(|v| v.as_str()).ok_or_else(|| format!("Orca server gave no job id: {}", body.chars().take(300).collect::<String>()))?;
    let g = std::fs::read_to_string(format!("/tmp/web-slicer-jobs/{id}/plate_1.gcode")).map_err(|e| format!("job {id}: {e}"))?;
    if let Some(p) = &cpath { let _ = std::fs::write(p, &g); }
    Ok(g)
}

/// Run the Orca CLI directly (not through the server) in `work`, with process overrides of ANY value (no character restriction) and
/// optionally Orca's own auto-orient (`--orient 1`). Settings templates are taken from a finished server job (`process.json`/`filament.json`
/// already flattened for the pnp coupon preset). Returns the G-code text.
pub fn cli_slice(stl: &Path, work: &Path, sets: &[(&str, &str)], orient: bool) -> Result<String, String> {
    let template = std::fs::read_dir("/tmp/web-slicer-jobs").map_err(|e| e.to_string())?.flatten().map(|e| e.path()).find(|d| {
        std::fs::read_to_string(d.join("process.json")).map_or(false, |t| t.contains("\"print_settings_id\":\"0.20mm Standard @BBL X2D - pnp coupon\"")) && d.join("filament.json").exists()
    }).ok_or("no finished server job to take process.json/filament.json from (slice anything through the server first)")?;
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let mut p: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(template.join("process.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for (k, v) in sets { p[*k] = (*v).into(); }
    std::fs::write(work.join("process.json"), p.to_string()).map_err(|e| e.to_string())?;
    std::fs::copy(template.join("filament.json"), work.join("filament.json")).map_err(|e| e.to_string())?;
    let home = std::env::var("HOME").unwrap_or_default();
    let machine = format!("{home}/.config/OrcaSlicer/system/BBL/machine/Bambu Lab X2D 0.4 nozzle.json");
    let _ = std::fs::remove_file(work.join("plate_1.gcode"));
    let out = Command::new(format!("{home}/build/OrcaSlicer/build/package/bin/orca-slicer")).env("LC_ALL", "C")
        .args(["--load-settings", &format!("{machine};{}", work.join("process.json").display()), "--load-filaments", &work.join("filament.json").display().to_string(),
            "--orient", if orient { "1" } else { "0" }, "--arrange", "1", "--slice", "0", "--export-3mf", "job.gcode.3mf", "--outputdir", &work.display().to_string(), &stl.display().to_string()])
        .output().map_err(|e| format!("orca-slicer: {e}"))?;
    std::fs::read_to_string(work.join("plate_1.gcode")).map_err(|_| format!("Orca CLI produced no G-code (exit {:?}): {}", out.status.code(), String::from_utf8_lossy(&out.stdout).lines().rev().take(3).collect::<Vec<_>>().join(" | ")))
}
