//! Refusals for settings and placements that produced a wrong or unsafe X2D program (bug hunt 2026-11-14). Each
//! case runs the real `fdmslice` in presets mode, the way tools/print3d-bridge does, and has a control that slices.
//! Needs the X2D Orca presets (~/.config/OrcaSlicer or FDM_ORCA_CONFIG); without them each test prints `PENDING:`.
use std::path::PathBuf;
use std::process::Command;

const MACHINE: &str = "Bambu Lab X2D 0.4 nozzle";
const PROCESS: &str = "0.20mm Standard @BBL X2D";
const FILAMENT: &str = "Bambu PLA Basic @BBL X2D 0.4 nozzle";

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

/// (exit code, stderr+stdout) of one 20 mm cube at `at`.
fn run(tag: &str, cfgdir: &PathBuf, at: &str, sets: &[&str]) -> (i32, String) {
    let dir = std::env::temp_dir().join(format!("fdm-refuse-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let stl = dir.join("cube.stl");
    std::fs::write(&stl, cube_stl(20.0)).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_fdmslice"));
    c.args(["--presets", "--machine", MACHINE, "--process", PROCESS, "--filament", FILAMENT, "--config-dir"]).arg(cfgdir)
        .arg("--defaults").arg(defaults());
    for s in sets { c.arg("--set").arg(s); }
    c.arg("--out").arg(dir.join("o.gcode")).arg("--report").arg(dir.join("r.json")).arg(format!("{}@{at}", stl.display()));
    let o = c.output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (o.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&o.stderr), String::from_utf8_lossy(&o.stdout)))
}

#[test]
fn a_brim_that_leaves_the_bed_is_refused_and_one_that_fits_is_not() {
    // 🔴 A cube 0.5 mm from the plate corner passed check_bed (mesh only) and its 5 mm brim went to X/Y -3.94, after the
    // X2D start G-code had turned soft endstops off.
    let Some(d) = config_dir() else { eprintln!("PENDING: no X2D Orca presets"); return; };
    let brim = ["brim_type=outer_only", "brim_width=5"];
    let (code, out) = run("brim-edge", &d, "10.5,10.5", &brim);
    assert_ne!(code, 0, "a brim off the bed was sliced: {out}");
    assert!(out.contains("skirt/brim reaches"), "{out}");
    let (code, out) = run("brim-mid", &d, "128,128", &brim);
    assert_eq!(code, 0, "control: the same brim mid-plate must slice: {out}");
}

#[test]
fn absolute_e_and_a_spiral_vase_with_unforced_settings_are_refused() {
    // 🔴 use_relative_e_distances=0 wrote M82 and then relative deltas; spiral_mode with the preset's 2 walls
    // spiralised only the top layer, starting its flow at 0 %.
    let Some(d) = config_dir() else { eprintln!("PENDING: no X2D Orca presets"); return; };
    let (code, out) = run("abs-e", &d, "128,128", &["use_relative_e_distances=0"]);
    assert_ne!(code, 0, "absolute E was sliced: {out}");
    assert!(out.contains("use_relative_e_distances"), "{out}");
    let (code, out) = run("spiral", &d, "128,128", &["spiral_mode=1"]);
    assert_ne!(code, 0, "a spiral vase with 2 walls was sliced: {out}");
    assert!(out.contains("wall_loops"), "{out}");
    let (code, out) = run("spiral-ok", &d, "128,128", &["spiral_mode=1", "wall_loops=1", "top_shell_layers=0", "sparse_infill_density=0%"]);
    assert_eq!(code, 0, "control: a vase with the forced settings must slice: {out}");
}
