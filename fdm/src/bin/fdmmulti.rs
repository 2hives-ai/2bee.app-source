//! fdmmulti reference.gcode out.gcode a.stl[:F][@X,Y] b.stl[:F][@X,Y] ...
//!   F = 0-based filament slot (default 0); @X,Y = fixed bed centre in mm (all objects or none; none = Orca-style arrange)
//! Several objects, several filaments, one plate, one pipeline run (arranged like Orca).
use twobee_fdm::pipeline::{self, JobObject, JobOptions};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 { eprintln!("usage: fdmmulti reference.gcode out.gcode a.stl[:F] [b.stl[:F] ...]"); std::process::exit(2); }
    let reff = std::fs::read(&a[1]).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|e| { eprintln!("cannot read {}: {e}", a[1]); std::process::exit(2) });
    let objs: Vec<JobObject> = a[3..].iter().map(|arg| {
        let (arg, at) = match arg.rsplit_once('@') {
            Some((r, xy)) => {
                let v: Vec<f64> = xy.split(',').filter_map(|t| t.parse().ok()).collect();
                if v.len() != 2 { eprintln!("bad placement {xy:?}: want X,Y"); std::process::exit(2) }
                (r.to_string(), Some(pipeline::ObjPlacement { rotate_z_deg: 0.0, center: [v[0], v[1]] }))
            }
            None => (arg.clone(), None),
        };
        let (path, fil) = match arg.rsplit_once(':') {
            Some((p, f)) if f.parse::<usize>().is_ok() => (p.to_string(), f.parse().unwrap()),
            _ => (arg.clone(), 0usize),
        };
        let stl = std::fs::read(&path).unwrap_or_else(|e| { eprintln!("cannot read {path}: {e}"); std::process::exit(2) });
        let name = std::path::Path::new(&path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(path);
        JobObject { name, stl, placement: at, filament_index: fil, overrides: Vec::new() }
    }).collect();
    match pipeline::slice_job(&objs, &reff, &JobOptions::default()) {
        Ok(o) => {
            std::fs::write(&a[2], &o.gcode).unwrap_or_else(|e| { eprintln!("cannot write {}: {e}", a[2]); std::process::exit(2) });
            let tc = o.gcode.lines().filter(|l| l.starts_with("M620 S")).count();
            eprintln!("fdmmulti: {} objects, {} layers, {} tool-change macro(s), {} issue(s)", o.objects.len(), o.layers, tc, o.issues.len());
            for s in &o.objects { eprintln!("  object {} {} centre ({:.2}, {:.2})", s.print_position, s.name, s.center[0], s.center[1]); }
            for i in o.issues.iter().take(8) { eprintln!("  issue: {i}"); }
        }
        Err(e) => { eprintln!("fdmmulti: REFUSED: {e}"); std::process::exit(3); }
    }
}
