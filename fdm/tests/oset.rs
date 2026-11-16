//! `fdmslice --oset N:key=value` (per-object settings, founder 2026-11-13: "the variables should be assigned to 1
//! object"). Runs the real binary in presets mode, the way tools/print3d-bridge does (--defaults + --auto-walls), and
//! asserts on the EMITTED G-code: the wall loops each object actually got, counted from its moves, not from a setting.
//! Needs the X2D Orca presets (~/.config/OrcaSlicer or FDM_ORCA_CONFIG) and the bridge's defaults file; without them
//! the slicing tests print `PENDING:` and return (the refusal tests still run: they are refused before any preset is read
//! only where stated).
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

const MACHINE: &str = "Bambu Lab X2D 0.4 nozzle";
const PROCESS: &str = "0.20mm Standard @BBL X2D";
const FILAMENT: &str = "Generic PLA @BBL X2D 0.4 nozzle";

fn config_dir() -> Option<PathBuf> {
    let d = std::env::var("FDM_ORCA_CONFIG").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(format!("{}/.config/OrcaSlicer", std::env::var("HOME").unwrap_or_default())));
    d.join("system/BBL/machine").join(format!("{MACHINE}.json")).is_file().then_some(d)
}
fn defaults() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/print3d-bridge/orca-defaults-x2d.config") }

fn cube_stl(e: f32) -> Vec<u8> {
    let v = [[0.0, 0.0, 0.0], [e, 0.0, 0.0], [e, e, 0.0], [0.0, e, 0.0], [0.0, 0.0, e], [e, 0.0, e], [e, e, e], [0.0, e, e]];
    let f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)];
    let mut b = vec![0u8; 80];
    b.extend_from_slice(&(f.len() as u32).to_le_bytes());
    for &(i, j, k) in &f {
        b.extend_from_slice(&[0u8; 12]);
        for &t in &[i, j, k] { for c in v[t] { b.extend_from_slice(&c.to_le_bytes()); } }
        b.extend_from_slice(&[0u8; 2]);
    }
    b
}

struct Run { code: i32, stdout: String, stderr: String, gcode: Option<String>, report: Option<serde_json::Value> }

fn run(tag: &str, cfgdir: &PathBuf, extra: &[&str]) -> Run {
    let dir = std::env::temp_dir().join(format!("fdm-oset-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let stl = dir.join("cube.stl");
    std::fs::write(&stl, cube_stl(20.0)).unwrap();
    let (out, rep) = (dir.join("o.gcode"), dir.join("r.json"));
    let mut c = Command::new(env!("CARGO_BIN_EXE_fdmslice"));
    c.args(["--presets", "--machine", MACHINE, "--process", PROCESS, "--filament", FILAMENT, "--config-dir"]).arg(cfgdir)
        .arg("--defaults").arg(defaults()).args(extra).arg("--auto-walls").arg("--out").arg(&out).arg("--report").arg(&rep)
        .arg(format!("{}@100,128", stl.display())).arg(format!("{}@150,128", stl.display()));
    let o = c.output().unwrap();
    let r = Run {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        gcode: std::fs::read_to_string(&out).ok(),
        report: std::fs::read_to_string(&rep).ok().and_then(|t| serde_json::from_str(&t).ok()),
    };
    let _ = std::fs::remove_dir_all(&dir);
    r
}

/// Wall loops per object on layer `li`, counted from the emitted moves: every wall ring of a cube has one vertical
/// left edge at its own X, so the loops are the distinct X values of wall extrusion endpoints on the left half that
/// occur at least twice (both ends of that edge). Object ids are the `; printing object <name> id:N` blocks.
fn wall_loops_on_layer(g: &str, li: usize) -> BTreeMap<usize, usize> {
    let layer = g.split("; CHANGE_LAYER").nth(li).expect("layer");
    let (mut obj, mut feat, mut x): (Option<usize>, String, f64) = (None, String::new(), 0.0);
    let mut xs: BTreeMap<usize, Vec<f64>> = BTreeMap::new();
    let num = |l: &str, k: char| l.split_whitespace().find_map(|w| w.strip_prefix(k).and_then(|v| v.parse::<f64>().ok()));
    for l in layer.lines() {
        if let Some(r) = l.strip_prefix("; printing object ") { obj = r.rsplit_once(" id:").and_then(|(_, t)| t.split_whitespace().next()).and_then(|n| n.parse().ok()); continue; }
        if l.starts_with("; stop printing object ") && l.contains(" copy ") { obj = None; }
        if let Some(f) = l.strip_prefix("; FEATURE: ") { feat = f.trim().to_string(); }
        if l.starts_with("G1 ") {
            let nx = num(l, 'X').unwrap_or(x);
            if let (Some(o), Some(e)) = (obj, num(l, 'E')) { if e > 0.0 && (feat == "Outer wall" || feat == "Inner wall") { xs.entry(o).or_default().push(nx); } }
            x = nx;
        }
    }
    xs.into_iter().map(|(o, v)| {
        let cx = (v.iter().cloned().fold(f64::MAX, f64::min) + v.iter().cloned().fold(f64::MIN, f64::max)) / 2.0;
        let mut c: BTreeMap<i64, usize> = BTreeMap::new();
        for t in v.iter().filter(|t| **t < cx - 3.0) { *c.entry((t * 100.0).round() as i64).or_default() += 1; }
        (o, c.values().filter(|n| **n >= 2).count())
    }).collect()
}

#[test]
fn oset_wall_loops_reaches_only_its_object_and_wins_over_auto_walls() {
    let Some(cd) = config_dir() else { eprintln!("PENDING: no X2D Orca presets (FDM_ORCA_CONFIG / ~/.config/OrcaSlicer)"); return; };
    let base = run("base", &cd, &[]);
    assert_eq!(base.code, 0, "{:?}", base.report);
    let r = run("oset", &cd, &["--oset", "1:wall_loops=4"]);
    assert_eq!(r.code, 0, "{:?}", r.report);
    let (g, g0) = (r.gcode.unwrap(), base.gcode.unwrap());
    for li in [5, 20, 50] {
        let w0 = wall_loops_on_layer(&g0, li);
        let w = wall_loops_on_layer(&g, li);
        assert_eq!(w.get(&1), Some(&4), "layer {li}: object 1 must print exactly 4 wall loops under --auto-walls, got {w:?}");
        assert_eq!(w.get(&0), w0.get(&0), "layer {li}: object 0 must print what it prints without --oset");
        assert_ne!(w0.get(&1), Some(&4), "control: without --oset object 1 is not already at 4 loops ({w0:?})");
    }
    // the file says so, and the report states what was applied, per object
    assert!(g.contains("; object 1 (cube.stl) planned with its own: wall_loops = 4\n"), "header note missing");
    assert!(!g0.contains("planned with its own"));
    let objs = r.report.unwrap()["objects"].as_array().unwrap().clone();
    let ov = |i: u64| objs.iter().find(|o| o["input_index"] == i).unwrap()["overrides"].clone();
    assert_eq!(ov(1), serde_json::json!({ "wall_loops": "4" }));
    assert_eq!(ov(0), serde_json::json!({}));
}

#[test]
fn oset_refusals_exit_2_and_write_nothing() {
    let Some(cd) = config_dir() else { eprintln!("PENDING: no X2D Orca presets (FDM_ORCA_CONFIG / ~/.config/OrcaSlicer)"); return; };
    for (tag, args, why) in [
        // a whole-number value, so only the KEY check can refuse it (layer_height=0.1 was refused by the value check
        // and stayed refused with layer_height planted into the allowed keys: that case proved nothing)
        ("key", vec!["--oset", "0:enable_support=1"], "enable_support"),
        ("index", vec!["--oset", "2:wall_loops=3"], "2 model"),
        ("value", vec!["--oset", "0:wall_loops=three"], "wall_loops"),
        ("shape", vec!["--oset", "wall_loops=3"], "N:key=value"),
        ("zero", vec!["--oset", "1:sparse_infill_density=0%"], "zero and non-zero"),
    ] {
        let r = run(tag, &cd, &args);
        assert_eq!(r.code, 2, "{tag}: exit {}", r.code);
        assert!(r.stdout.is_empty(), "{tag}: stdout {:?}", r.stdout);
        assert!(r.gcode.is_none() && r.report.is_none(), "{tag}: something was written");
        assert!(r.stderr.contains(why), "{tag}: the refusal must name {why:?}: {:?}", r.stderr);
    }
}

#[test]
fn oset_density_that_stays_non_zero_is_applied_to_its_object() {
    let Some(cd) = config_dir() else { eprintln!("PENDING: no X2D Orca presets (FDM_ORCA_CONFIG / ~/.config/OrcaSlicer)"); return; };
    let r = run("dens", &cd, &["--oset", "0:sparse_infill_density=40%"]);
    assert_eq!(r.code, 0, "{:?}", r.report);
    let g = r.gcode.unwrap();
    // more infill in object 0 than in object 1 on a mid layer: sparse infill extrusion (E) summed per object
    let layer = g.split("; CHANGE_LAYER").nth(30).unwrap();
    let (mut obj, mut feat) = (None::<usize>, String::new());
    let mut e: BTreeMap<usize, f64> = BTreeMap::new();
    for l in layer.lines() {
        if let Some(rr) = l.strip_prefix("; printing object ") { obj = rr.rsplit_once(" id:").and_then(|(_, t)| t.split_whitespace().next()).and_then(|n| n.parse().ok()); continue; }
        if l.starts_with("; stop printing object ") && l.contains(" copy ") { obj = None; }
        if let Some(f) = l.strip_prefix("; FEATURE: ") { feat = f.trim().to_string(); }
        if let (Some(o), true) = (obj, l.starts_with("G1 ") && feat == "Sparse infill") {
            if let Some(v) = l.split_whitespace().find_map(|w| w.strip_prefix('E').and_then(|v| v.parse::<f64>().ok())) { if v > 0.0 { *e.entry(o).or_default() += v; } }
        }
    }
    let (e0, e1) = (e.get(&0).copied().unwrap_or(0.0), e.get(&1).copied().unwrap_or(0.0));
    assert!(e1 > 0.0 && e0 > 1.8 * e1, "object 0 (40 %) must extrude far more sparse infill than object 1 (plate 15 %): {e0:.3} vs {e1:.3}");
}
