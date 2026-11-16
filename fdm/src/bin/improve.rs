//! `improve`: lane 9 evaluation harness.
//!   improve preflight <model.stl> <orca.gcode>   (config comes from the CONFIG_BLOCK of any Orca G-code) [--json]
use std::path::Path;
use twobee_fdm::{config::Config, mesh::Mesh, preflight, slice};

fn load(stl: &str, gcode: &str) -> Result<(Mesh, Config, Vec<twobee_fdm::types::Layer>), String> {
    let cfg = Config::from_gcode_file(Path::new(gcode)).map_err(|e| e.to_string())?;
    let mut m = Mesh::from_stl_file(Path::new(stl)).map_err(|e| e.to_string())?;
    m.place_on_bed(128.0, 128.0);
    let r = slice::slice(&m, &cfg).map_err(|e| e.to_string())?;
    Ok((m, cfg, r.layers))
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let json = a.iter().any(|x| x == "--json");
    let pos: Vec<&String> = a.iter().filter(|x| !x.starts_with("--")).collect();
    match pos.first().map(|s| s.as_str()) {
        Some("preflight") if pos.len() >= 3 => {
            let (m, cfg, layers) = match load(pos[1], pos[2]) { Ok(x) => x, Err(e) => { eprintln!("PENDING: {e}"); std::process::exit(2) } };
            let t = std::time::Instant::now();
            let r = preflight::preflight(&m, &cfg, &layers);
            if json { println!("{}", serde_json::to_string_pretty(&r.to_json()).unwrap()); } else { print!("{}", r.to_text()); }
            eprintln!("({:.2}s, {} layers)", t.elapsed().as_secs_f64(), layers.len());
        }
        Some("eval-preflight") => {
            let dir = pos.get(1).map(|s| s.as_str()).unwrap_or("/tmp/fdm-l9-eval");
            match twobee_fdm::improve::eval::eval_preflight(Path::new(dir)) { Ok(t) => print!("{t}"), Err(e) => { eprintln!("PENDING: {e}"); std::process::exit(2) } }
        }
        Some("eval-models") if pos.len() >= 2 => {
            let ms: Vec<std::path::PathBuf> = pos[1..].iter().map(|s| std::path::PathBuf::from(s.as_str())).collect();
            match twobee_fdm::improve::eval::eval_models(&ms, Path::new("/tmp/fdm-l9/eval-models"), a.iter().any(|x| x == "--full")) { Ok(t) => print!("{t}"), Err(e) => { eprintln!("PENDING: {e}"); std::process::exit(2) } }
        }
        Some("eval-autoconfig") => {
            let dir = pos.get(1).map(|s| s.as_str()).unwrap_or("/tmp/fdm-l9/eval-auto");
            let only: Vec<&str> = a.iter().filter(|x| x.starts_with("--only=")).flat_map(|x| x[7..].split(',').collect::<Vec<_>>()).collect();
            match twobee_fdm::improve::eval::eval_autoconfig(Path::new(dir), &only) { Ok(t) => print!("{t}"), Err(e) => { twobee_fdm::improve::orca::cleanup_scratch(); eprintln!("PENDING: {e}"); std::process::exit(2) } }
        }
        Some("eval-pathopt") if pos.len() >= 2 => {
            let g: Vec<std::path::PathBuf> = pos[1..].iter().map(|s| std::path::PathBuf::from(s.as_str())).collect();
            match twobee_fdm::improve::eval::eval_pathopt(&g) { Ok(t) => print!("{t}"), Err(e) => { eprintln!("PENDING: {e}"); std::process::exit(2) } }
        }
        Some("eval-orient") => {
            let dir = pos.get(1).map(|s| s.as_str()).unwrap_or("/tmp/fdm-l9/eval-orient");
            match twobee_fdm::improve::eval::eval_orient(Path::new(dir)) { Ok(t) => print!("{t}"), Err(e) => { eprintln!("PENDING: {e}"); std::process::exit(2) } }
        }
        Some("bridge-dirs") if pos.len() >= 2 => {
            let text = std::fs::read_to_string(pos[1]).unwrap();
            let st = twobee_fdm::gcode_parse::parse(&text).unwrap();
            for l in &st.layers {
                for f in ["Bridge", "Internal Bridge"] {
                    if l.path_by_feature.get(f).copied().unwrap_or(0.0) > 5.0 {
                        let h = twobee_fdm::gcode_parse::direction_histogram(&text, l.index, f).unwrap();
                        let top: Vec<String> = h.iter().filter(|d| d.total_mm > 5.0).map(|d| format!("{}deg x{} {:.0}mm", d.angle_deg, d.segs, d.total_mm)).collect();
                        println!("layer {} z={} {}: {}", l.index, l.z, f, top.join(" | "));
                    }
                }
            }
        }
        Some("thin-debug") if pos.len() >= 4 => {
            let (m, cfg, layers) = load(pos[1], pos[2]).unwrap();
            let z: f64 = pos[3].parse().unwrap();
            let _ = (&m, &cfg);
            let l = layers.iter().min_by(|a, b| (a.z - z).abs().partial_cmp(&(b.z - z).abs()).unwrap()).unwrap();
            let w = 0.42;
            let thin = twobee_fdm::geom::diff(&l.region, &twobee_fdm::geom::opening(&l.region, 0.5 * w));
            println!("layer z={} region area {:.1} thin area {:.1} comps {}", l.z, twobee_fdm::geom::area(&l.region), twobee_fdm::geom::area(&thin), thin.len());
            let mut v: Vec<(f64, [f64; 4])> = thin.iter().map(|q| (twobee_fdm::geom::area(&vec![q.clone()]), twobee_fdm::geom::bbox(&vec![q.clone()]).unwrap())).collect();
            v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            for (a, b) in v.iter().take(8) { println!("  area {a:.2} bbox {b:.1?} size {:.2} x {:.2}", b[2] - b[0], b[3] - b[1]); }
        }
        _ => { eprintln!("usage: improve preflight <stl> <orca.gcode> [--json] | improve eval-preflight [dir]"); std::process::exit(2) }
    }
}
