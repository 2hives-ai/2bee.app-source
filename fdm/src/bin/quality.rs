//! `quality`: prove (or refuse to prove) that our G-code is better than OrcaSlicer's.
//!
//!   quality orca.gcode ours.gcode --mesh x.stl [--json] [--no-controls] [--cell 0.05] [--noise-runs 4] [--offset x,y]
//!   quality orca.gcode --mesh x.stl            controls only: planted degradations + false-positive controls on Orca's own file
//!
//! Rule: a deviation from Orca is a FAIL until proven BETTER (see `twobee_fdm::quality` for conditions (a)-(f)).
//! Exit codes (the fleet's contract): 0 = PASS (SAME, or PROVEN BETTER with no regression),
//! 1 = FAIL (any WORSE / unproven BETTER / an instrument defect found by a negative control),
//! 2 = could not run (PENDING: unreadable file, mesh does not match the G-code, layer stacks differ ...).
use std::process::exit;
use twobee_fdm::mesh::Mesh;
use twobee_fdm::quality::*;

fn pending(msg: &str) -> ! { eprintln!("PENDING: {msg}"); exit(2) }

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut files = vec![];
    let (mut mesh_p, mut json, mut controls) = (None, false, true);
    let mut opt = Opt::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--mesh" => { i += 1; mesh_p = args.get(i).cloned(); }
            "--json" => json = true,
            "--no-controls" => controls = false,
            "--cell" => { i += 1; opt.cell = args.get(i).and_then(|s| s.parse().ok()).unwrap_or_else(|| pending("--cell needs a number")); }
            "--noise-runs" => { i += 1; opt.noise_runs = args.get(i).and_then(|s| s.parse().ok()).unwrap_or_else(|| pending("--noise-runs needs an integer")); }
            "--offset" => { i += 1; let v: Vec<f64> = args.get(i).map(|s| s.split(',').filter_map(|x| x.parse().ok()).collect()).unwrap_or_default(); if v.len() != 2 { pending("--offset x,y"); } opt.offset = Some([v[0], v[1]]); }
            "-h" | "--help" => { println!("quality orca.gcode [ours.gcode] --mesh x.stl [--json] [--no-controls] [--cell mm] [--noise-runs n] [--offset x,y]"); exit(0) }
            f if !f.starts_with("--") => files.push(f.to_string()),
            o => pending(&format!("unknown option {o}")),
        }
        i += 1;
    }
    if files.is_empty() || files.len() > 2 { pending("usage: quality orca.gcode [ours.gcode] --mesh x.stl"); }
    let mesh_p = mesh_p.unwrap_or_else(|| pending("--mesh is required (the sliced contour is the ground truth for fidelity and coverage)"));
    let read = |p: &str| std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|e| pending(&format!("{p}: {e}")));
    let orca_t = read(&files[0]);
    let ours_t = files.get(1).map(|p| read(p));
    let mesh = Mesh::from_stl_file(std::path::Path::new(&mesh_p)).unwrap_or_else(|e| pending(&format!("{mesh_p}: {e}")));

    let ocfg = twobee_fdm::config::Config::from_gcode(&orca_t).unwrap_or_else(|e| pending(&format!("reference G-code: {e}")));
    let lim = Lim::from_cfg(&ocfg).unwrap_or_else(|e| pending(&e.to_string()));
    let (oprep, oa) = analyze_text(&orca_t, &mesh, &lim, &opt).unwrap_or_else(|e| pending(&format!("reference: {e}")));
    let mut o2 = opt.clone();
    o2.offset = None;
    let (ua, controls_only) = match &ours_t {
        Some(t) => {
            let (uprep, ua) = analyze_text(t, &mesh, &lim, &o2).unwrap_or_else(|e| pending(&format!("ours: {e}")));
            // (d) same layer stack
            let (zo, zu): (Vec<f64>, Vec<f64>) = (oprep.parsed.layers.iter().map(|l| l.z).collect(), uprep.parsed.layers.iter().map(|l| l.z).collect());
            if zo.len() != zu.len() || zo.iter().zip(&zu).any(|(a, b)| (a - b).abs() > 1e-4) {
                pending(&format!("layer stacks differ (orca {} layers, ours {}): not the same slicing settings, nothing is comparable", zo.len(), zu.len()));
            }
            (ua, false)
        }
        None => (oa.clone(), true),
    };
    let rows = compare(&oa, &ua);
    let settings = if controls_only { Settings::Verified(0) } else { check_settings(&oa, &ua) };
    let creport = if controls { run_controls(&orca_t, &mesh, &lim, &opt, &oa, &oprep) } else { ControlReport { false_positive_ok: false, ..Default::default() } };
    let ov = overall(&rows, &settings, &creport.controlled, creport.false_positive_ok);
    let defect = !creport.missed.is_empty() || (controls && !creport.false_positive_ok);

    if json {
        let mut j = to_json(&rows, &ov, &settings, &creport);
        j["instrument_defect"] = serde_json::json!(defect);
        j["align_err_mm"] = serde_json::json!([oa.align_err_mm, ua.align_err_mm]);
        println!("{}", serde_json::to_string_pretty(&j).unwrap());
    } else {
        println!("quality: reference {}  vs  {}", files[0], files.get(1).map(|s| s.as_str()).unwrap_or("(controls only: ours := a copy of the reference)"));
        println!("  mesh {mesh_p}  layers {}  alignment offset ({:.3}, {:.3}) mm  outer-wall error vs contour: orca {:.4} mm, ours {:.4} mm  cell {} mm  noise runs {}", oa.layers, oa.offset[0], oa.offset[1], oa.align_err_mm, ua.align_err_mm, opt.cell, opt.noise_runs);
        println!("  limits taken from the reference CONFIG_BLOCK: flow {} mm3/s, accel {} mm/s2, jerk {} mm/s, min layer time {} s", lim.flow_max, lim.acc_max, lim.jerk, lim.min_layer_time);
        println!("  settings (d): {:?}", settings);
        if let (Some(h), Some(t)) = (oa.header_time_s, oa.metrics.get("print_time_s").and_then(|m| m.v)) { println!("  estimator calibration: Orca header model time {h:.0} s vs our estimator on Orca's file {t:.0} s ({:+.1}%)", 100.0 * (t - h) / h); }
        println!();
        print!("{}", render_table(&rows, &creport.controlled));
        if !controls_only {
            println!("\nWHERE THE NUMBERS COME FROM (diagnostic)");
            for (who, a) in [("orca", &oa), ("ours", &ua)] { for (k, v) in &a.notes { println!("  {who} {k}: {v}"); } }
        }
        println!();
        if controls { print!("{}", render_controls(&creport)); println!(); }
        match &ov {
            Overall::Fail(v) | Overall::Unproven(v) => { println!("VERDICT: {}", ov.label()); for x in v { println!("  - {x}"); } }
            _ => println!("VERDICT: {}", ov.label()),
        }
        if defect { println!("INSTRUMENT DEFECT: a negative control did not behave; no BETTER claim can be accepted from this run."); }
    }
    let code = if defect { 1 } else { ov.exit_code() };
    exit(code)
}
