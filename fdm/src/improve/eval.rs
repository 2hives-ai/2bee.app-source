//! Lane 9: evaluation harness (needs the local Orca server; without it every comparison is PENDING, never PASS).
use super::{orca, shapes};
use crate::{config::Config, gcode_parse, mesh::Mesh, preflight, slice};
use std::path::Path;

pub fn write_stl(path: &Path, soup: &[[f64; 9]]) {
    // admesh (Orca's STL reader) takes a binary file whose first bytes are all < 0x80 for ASCII: mark the header non-ASCII
    let mut b = vec![0u8; 80];
    b[0] = 0xB0;
    b.extend((soup.len() as u32).to_le_bytes());
    for t in soup {
        // real facet normals: admesh classifies an all-zero-normal file with only low bytes as ASCII and refuses it
        let u = [t[3] - t[0], t[4] - t[1], t[5] - t[2]]; let w = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-30);
        for k in 0..3 { b.extend(((n[k] / l) as f32).to_le_bytes()); }
        for v in t { b.extend((*v as f32).to_le_bytes()); } b.extend([0u8; 2]); }
    std::fs::write(path, b).expect("write stl");
}

/// Orca runs for a list of jobs, at most `conc` at a time. Result order = job order.
pub fn orca_batch(jobs: &[(std::path::PathBuf, Vec<(String, String)>)], cache: &Path, conc: usize) -> Vec<Result<String, String>> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out: std::sync::Mutex<Vec<Option<Result<String, String>>>> = std::sync::Mutex::new((0..jobs.len()).map(|_| None).collect());
    std::thread::scope(|s| {
        for _ in 0..conc.max(1) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if i >= jobs.len() { break; }
                let sets: Vec<(&str, &str)> = jobs[i].1.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
                let r = orca::slice(&jobs[i].0, &sets, Some(cache));
                out.lock().unwrap()[i] = Some(r);
            });
        }
    });
    out.into_inner().unwrap().into_iter().map(|o| o.unwrap()).collect()
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Conf { pub tp: u32, pub fp: u32, pub fneg: u32, pub tn: u32 }
impl Conf {
    pub fn add(&mut self, pred: bool, truth: bool) { match (pred, truth) { (true, true) => self.tp += 1, (true, false) => self.fp += 1, (false, true) => self.fneg += 1, (false, false) => self.tn += 1 } }
    pub fn n(&self) -> u32 { self.tp + self.fp + self.fneg + self.tn }
    pub fn precision(&self) -> Option<f64> { (self.tp + self.fp > 0).then(|| self.tp as f64 / (self.tp + self.fp) as f64) }
    pub fn recall(&self) -> Option<f64> { (self.tp + self.fneg > 0).then(|| self.tp as f64 / (self.tp + self.fneg) as f64) }
}
fn pr(v: Option<f64>) -> String { v.map_or("n/a (no positives)".into(), |x| format!("{:.0}%", x * 100.0)) }

pub fn eval_preflight(dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let cache = dir.join("orca"); std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let cases = shapes::cases();
    let mut jobs = vec![];
    for c in &cases {
        let p = dir.join(format!("{}.stl", c.name));
        write_stl(&p, &c.soup);
        jobs.push((p.clone(), vec![]));
        jobs.push((p.clone(), vec![("enable_support".to_string(), "1".to_string())]));
        jobs.push((p, vec![("wall_generator".to_string(), "arachne".to_string())]));
    }
    let res = orca_batch(&jobs, &cache, 3);
    let fallback: Option<String> = res.iter().find_map(|r| r.as_ref().ok().cloned());
    let mut out = String::new();
    out += &format!("{:<14} {:>7} {:>7} | {:>7} {:>7} | {:>8} {:>8} {:>6} | flags (pred/truth)\n", "case", "estG", "orcaG", "estMin", "orcaMdl", "ovl_mm2", "orca_sup", "span");
    let mut conf: std::collections::BTreeMap<&'static str, Conf> = Default::default();
    let mut pending = 0;
    let (mut g_err, mut t_err) = (vec![], vec![]);
    for (ci, c) in cases.iter().enumerate() {
        let base = &res[3 * ci];
        let sup = &res[3 * ci + 1];
        let ara = &res[3 * ci + 2];
        let (Ok(bg), Ok(sg)) = (base, sup) else {
            // Orca could not slice this case (e.g. it does not fit the bed): preflight still runs on the fallback config, comparisons are PENDING
            pending += 1;
            let mut cfg = Config::from_gcode(fallback.as_ref().ok_or("no baseline Orca G-code at all")?).map_err(|e| e.to_string())?;
            for (k, v) in &c.set { cfg.set(k, v); }
            let mut m = Mesh::from_soup(&c.soup).map_err(|e| e.to_string())?;
            m.place_on_bed(128.0, 128.0);
            let layers = slice::slice(&m, &cfg).map_err(|e| e.to_string())?.layers;
            let r = preflight::preflight(&m, &cfg, &layers);
            let f = &r.flags;
            if let Some(t) = c.truth.fits_bed { conf.entry("fits_bed").or_default().add(f.fits_bed, t); }
            out += &format!("{:<14} Orca comparison PENDING ({}); preflight fits_bed={} setup[0]={}\n", c.name, base.as_ref().err().or(sup.as_ref().err()).unwrap().chars().take(60).collect::<String>(), f.fits_bed, r.setup.first().cloned().unwrap_or_default());
            continue };
        let mut cfg = Config::from_gcode(bg).map_err(|e| e.to_string())?;
        for (k, v) in &c.set { cfg.set(k, v); }
        let mut m = Mesh::from_soup(&c.soup).map_err(|e| e.to_string())?;
        m.place_on_bed(128.0, 128.0);
        // layers: the slicer refuses a mesh that is too tall for nothing; too_tall is still sliceable
        let layers = match slice::slice(&m, &cfg) { Ok(r) => r.layers, Err(e) => { pending += 1; out += &format!("{:<14} PENDING: slice: {e}\n", c.name); continue } };
        let r = preflight::preflight(&m, &cfg, &layers);
        let bs = gcode_parse::parse(bg).map_err(|e| e.to_string())?;
        let ss = gcode_parse::parse(sg).map_err(|e| e.to_string())?;
        let sup_mm = ss.features.get("Support").map_or(0.0, |f| f.path_mm) + ss.features.get("Support interface").map_or(0.0, |f| f.path_mm);
        let (og, ot) = (bs.header.filament_g.unwrap_or(f64::NAN), bs.header.model_time_s.unwrap_or(f64::NAN) / 60.0);
        if c.set.is_empty() && og.is_finite() { g_err.push(r.estimate.filament_g / og - 1.0); t_err.push(r.estimate.time_min / ot - 1.0); }
        let f = &r.flags;
        let mut fl = String::new();
        let ho = c.name.starts_with("ho_");
        let mut chk = |name: &'static str, pred: bool, truth: Option<bool>| {
            if let Some(t) = truth { conf.entry(if ho { Box::leak(format!("[hold-out] {name}").into_boxed_str()) } else { name }).or_default().add(pred, t); if pred != t { fl += &format!(" {name}!"); } else if pred { fl += &format!(" {name}"); } }
        };
        chk("has_overhang", f.has_overhang, c.truth.overhang);
        chk("needs_support", f.needs_support, c.truth.needs_support);
        chk("bridge_over_limit", f.bridge_over_limit, c.truth.bridge_over_limit);
        chk("thin_unprintable", f.thin_unprintable, c.truth.thin_unprintable);
        chk("adhesion_high", f.adhesion_risk_high, c.truth.adhesion_high);
        chk("tall_slender", f.tall_slender, c.truth.tall_slender);
        chk("warp_high", f.warp_high, c.truth.warp_high);
        chk("fits_bed", f.fits_bed, c.truth.fits_bed);
        // second truth source for the overhang flag: does Orca actually emit support?
        conf.entry(if ho { "[hold-out] has_overhang_vs_orca_support" } else { "has_overhang_vs_orca_support" }).or_default().add(f.has_overhang, sup_mm > 1.0);
        if f.has_overhang != (sup_mm > 1.0) { fl += " has_overhang_vs_orca!"; }
        // third truth source for thin walls: did Orca extrude anything above the slab?
        if c.name.starts_with("wall") || c.name.starts_with("ho_wall") {
            if let Ok(ag) = ara {
                let ast = gcode_parse::parse(ag).map_err(|e| e.to_string())?;
                let printed_a = ast.layers.iter().any(|l| l.z > 1.5 && l.path_mm > 0.0);
                let mut acfg = cfg.clone(); acfg.set("wall_generator", "arachne");
                let ra = preflight::preflight(&m, &acfg, &layers);
                conf.entry(if ho { "[hold-out] thin_unprintable_arachne_vs_orca" } else { "thin_unprintable_arachne_vs_orca" }).or_default().add(ra.flags.thin_unprintable, !printed_a);
                if ra.flags.thin_unprintable == printed_a { fl += " thin_arachne_vs_orca!"; }
            }
            // the slab is 1 mm tall: any extrusion above z = 1.5 is the wall (the skirt is only 1 mm high)
            let printed = bs.layers.iter().any(|l| l.z > 1.5 && l.path_mm > 0.0);
            conf.entry(if ho { "[hold-out] thin_unprintable_vs_orca_output" } else { "thin_unprintable_vs_orca_output" }).or_default().add(f.thin_unprintable, !printed);
            if f.thin_unprintable == printed { fl += " thin_vs_orca!"; }
        }
        out += &format!("{:<14} {:>7.2} {:>7.2} | {:>7.1} {:>7.1} | {:>8.1} {:>8.0} {:>6.1} |{}\n", c.name, r.estimate.filament_g, og, r.estimate.time_min, ot, r.overhang.needs_support_area_mm2, sup_mm, r.bridges.max_span_mm, fl);
    }
    out += "\nflag precision/recall (population = cases whose truth is asserted; '!' above marks a miss)\n";
    for (k, c) in &conf { out += &format!("  {:<30} n={:<3} TP={} FP={} FN={} TN={}  precision {}  recall {}\n", k, c.n(), c.tp, c.fp, c.fneg, c.tn, pr(c.precision()), pr(c.recall())); }
    let mean = |v: &Vec<f64>| if v.is_empty() { f64::NAN } else { v.iter().sum::<f64>() / v.len() as f64 };
    let mabs = |v: &Vec<f64>| if v.is_empty() { f64::NAN } else { v.iter().map(|x| x.abs()).sum::<f64>() / v.len() as f64 };
    out += &format!("\nestimate vs Orca header over {} baseline cases: filament mean err {:+.1}% (mean |err| {:.1}%), time mean err {:+.1}% (mean |err| {:.1}%)\n", g_err.len(), 100.0 * mean(&g_err), 100.0 * mabs(&g_err), 100.0 * mean(&t_err), 100.0 * mabs(&t_err));
    if pending > 0 { out += &format!("PENDING cases: {pending} (Orca server or slicing unavailable)\n"); }
    Ok(out)
}

/// Preflight on real models next to what Orca actually did (baseline and with support enabled).
pub fn eval_models(models: &[std::path::PathBuf], cache: &Path, full: bool) -> Result<String, String> {
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let mut jobs = vec![];
    for p in models { jobs.push((p.clone(), vec![])); jobs.push((p.clone(), vec![("enable_support".to_string(), "1".to_string())])); }
    let res = orca_batch(&jobs, cache, 3);
    let mut out = String::new();
    for (i, p) in models.iter().enumerate() {
        let name = p.file_stem().unwrap().to_string_lossy().to_string();
        let Ok(bg) = &res[2 * i] else { out += &format!("{name}: PENDING ({})\n", res[2 * i].as_ref().err().unwrap()); continue };
        let sg_res = &res[2 * i + 1];
        let sg: &str = sg_res.as_deref().unwrap_or("");
        let cfg = Config::from_gcode(bg).map_err(|e| e.to_string())?;
        let mut m = Mesh::from_stl_file(p).map_err(|e| e.to_string())?;
        m.place_on_bed(128.0, 128.0);
        let t0 = std::time::Instant::now();
        let layers = slice::slice(&m, &cfg).map_err(|e| e.to_string())?.layers;
        let r = preflight::preflight(&m, &cfg, &layers);
        let dt = t0.elapsed().as_secs_f64();
        let bs = gcode_parse::parse(bg).map_err(|e| e.to_string())?;
        let ss = if sg.is_empty() { None } else { Some(gcode_parse::parse(sg).map_err(|e| e.to_string())?) };
        let sup = |s: &gcode_parse::Stats| s.features.get("Support").map_or(0.0, |f| f.path_mm) + s.features.get("Support interface").map_or(0.0, |f| f.path_mm);
        out += &format!("== {name}: {}x{}x{} mm, {} layers (slice+preflight {:.1}s)\n", r.bed.footprint[0].round(), r.bed.footprint[1].round(), r.bed.footprint[2].round(), layers.len(), dt);
        out += &format!("   filament est {:.2} g vs Orca {:.2} g | model time est {:.1} vs Orca {:.1} min\n", r.estimate.filament_g, bs.header.filament_g.unwrap_or(f64::NAN), r.estimate.time_min, bs.header.model_time_s.unwrap_or(f64::NAN) / 60.0);
        out += &format!("   overhang {:.1} mm2 (cantilever {:.1}, bridges {} max {:.1} mm) -> has_overhang={} needs_support={} | Orca support with enable_support=1: {}\n", r.overhang.needs_support_area_mm2, r.bridges.cantilever_area_mm2, r.bridges.count, r.bridges.max_span_mm, r.flags.has_overhang, r.flags.needs_support,
            match &ss { Some(s) => format!("{:.0} mm of path", sup(s)), None => format!("PENDING ({})", sg_res.as_ref().err().map(|e| e.chars().take(70).collect::<String>()).unwrap_or_default()) });
        out += &format!("   thin<{:.2}: {:.1} mm2 in {} layers (will_print={}); wall-only {:.1} mm2; smallest feature {:?} | first layer {:.0} mm2 risk {} | warp {} | mesh watertight {}\n", r.thin.unprintable_below_mm, r.thin.unprintable_area_mm2, r.thin.unprintable_layers, r.thin.will_print, r.thin.wall_only_area_mm2, r.thin.smallest_feature_mm, r.first_layer.contact_area_mm2, r.first_layer.risk, r.warp.risk, r.mesh_health.watertight);
        if full { out += &r.to_text(); }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------- autoconfig
use super::autoconfig::{autoconfig, AutoOptions, SettingsDelta};

#[derive(Clone, Debug, Default)]
pub struct Outcome { pub time_min: f64, pub g: f64, pub support_mm: f64, pub bridge_mm: f64, pub brim_mm: f64, pub layers: usize, pub wall_printed: bool, pub total_mm: f64, pub refused: Option<String> }
fn outcome(g: &Result<String, String>) -> Outcome {
    match g {
        Err(e) => Outcome { refused: Some(e.chars().take(60).collect()), ..Default::default() },
        Ok(t) => {
            let s = gcode_parse::parse(t).unwrap_or_default();
            let f = |n: &str| s.features.get(n).map_or(0.0, |x| x.path_mm);
            Outcome { time_min: s.header.model_time_s.unwrap_or(f64::NAN) / 60.0, g: s.header.filament_g.unwrap_or(f64::NAN), support_mm: f("Support") + f("Support interface"), bridge_mm: f("Bridge") + f("Internal Bridge"),
                brim_mm: f("Brim"), layers: s.layers.len(), wall_printed: s.layers.iter().any(|l| l.z > 1.5 && l.path_mm > 0.0), total_mm: s.features.values().map(|x| x.path_mm).sum(), refused: None }
        }
    }
}

fn ov(sets: &[(String, String)]) -> Vec<(String, String)> { sets.to_vec() }

pub fn eval_autoconfig(dir: &Path, only: &[&str]) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let cache = dir.join("orca"); std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let mut names: Vec<(String, std::path::PathBuf, Option<Vec<[f64; 9]>>)> = vec![];
    for c in shapes::cases() {
        if only.is_empty() || only.contains(&c.name) { if c.set.is_empty() { let p = dir.join(format!("{}.stl", c.name)); write_stl(&p, &c.soup); names.push((c.name.to_string(), p, Some(c.soup.clone()))); } }
    }
    let real = std::path::PathBuf::from("/home/gbacs/hives/2bee.farm/hardware/cad/stl/fleet/pnp_blinds_coupon0402_set.stl");
    if real.exists() && (only.is_empty() || only.contains(&"coupon0402")) { names.push(("coupon0402".into(), real, None)); }
    // phase 1: baseline (support off) and naive "support on"
    let mut jobs = vec![];
    for (_, p, _) in &names { jobs.push((p.clone(), vec![])); jobs.push((p.clone(), vec![("enable_support".to_string(), "1".to_string())])); }
    let r1 = orca_batch(&jobs, &cache, 3);
    // phase 2: deltas computed from each scenario's own config
    let mut deltas: Vec<(SettingsDelta, SettingsDelta)> = vec![];
    let mut jobs2 = vec![];
    for (i, (_, p, soup)) in names.iter().enumerate() {
        let mut pair = (SettingsDelta::default(), SettingsDelta::default());
        if let (Ok(a), Ok(b)) = (&r1[2 * i], &r1[2 * i + 1]) {
            let mut m = match soup { Some(s) => Mesh::from_soup(s).map_err(|e| e.to_string())?, None => Mesh::from_stl_file(p).map_err(|e| e.to_string())? };
            m.place_on_bed(128.0, 128.0);
            for (k, g) in [(0, a), (1, b)] {
                let cfg = Config::from_gcode(g).map_err(|e| e.to_string())?;
                let layers = slice::slice(&m, &cfg).map_err(|e| e.to_string())?.layers;
                let rep = preflight::preflight(&m, &cfg, &layers);
                let d = autoconfig(&rep, &cfg, &AutoOptions::default());
                if k == 0 { pair.0 = d } else { pair.1 = d }
            }
        }
        // C = base + delta(A); D = support-on + delta(B)
        let mut ca = pair.0.as_overrides();
        ca.sort();
        let mut cb = vec![("enable_support".to_string(), "1".to_string())];
        cb.extend(pair.1.as_overrides().into_iter().filter(|(k, _)| k != "enable_support"));
        if let Some(c) = pair.1.changes.iter().find(|c| c.key == "enable_support") { cb.retain(|(k, _)| k != "enable_support"); cb.push(("enable_support".into(), c.value.clone())); }
        jobs2.push((p.clone(), ov(&ca)));
        jobs2.push((p.clone(), ov(&cb)));
        deltas.push(pair);
    }
    let r2 = orca_batch(&jobs2, &cache, 3);
    let mut out = String::new();
    out += "autoconfig vs Orca (model time min / filament g / support path mm / brim path mm / thin wall printed)\n";
    out += &format!("{:<14} {:<22} {:>8} {:>7} {:>8} {:>7} {:>5} | delta(auto) changes\n", "case", "run", "time", "g", "support", "brim", "wall");
    let mut sum_time_on = (0.0, 0.0); let mut sum_g_on = (0.0, 0.0); let mut n_on = 0; let mut n_on_names: Vec<String> = vec![];
    for (i, (name, _, _)) in names.iter().enumerate() {
        let runs: [(&str, Outcome, String); 4] = [
            ("A base (support off)", outcome(&r1[2 * i]), String::new()),
            ("B naive support on", outcome(&r1[2 * i + 1]), String::new()),
            ("C auto on A", outcome(&r2[2 * i]), deltas[i].0.changes.iter().map(|c| format!("{}={}", c.key, c.value)).collect::<Vec<_>>().join(" ")),
            ("D auto on B", outcome(&r2[2 * i + 1]), deltas[i].1.changes.iter().map(|c| format!("{}={}", c.key, c.value)).collect::<Vec<_>>().join(" ")),
        ];
        for (lbl, o, d) in &runs {
            if let Some(e) = &o.refused { out += &format!("{:<14} {:<22} PENDING ({e})\n", name, lbl); continue; }
            out += &format!("{:<14} {:<22} {:>8.1} {:>7.2} {:>8.0} {:>7.0} {:>5} | {}\n", name, lbl, o.time_min, o.g, o.support_mm, o.brim_mm, if o.wall_printed { "yes" } else { "no" }, d);
        }
        // isolated support effect: for the cases where auto turns support OFF, compare naive-on (B) with off (A); nothing else differs between A and B
        let (a, b) = (&runs[0].1, &runs[1].1);
        if a.refused.is_none() && b.refused.is_none() && deltas[i].1.changes.iter().any(|c| c.key == "enable_support" && c.value == "0") {
            sum_time_on.0 += b.time_min; sum_time_on.1 += a.time_min; sum_g_on.0 += b.g; sum_g_on.1 += a.g; n_on += 1; n_on_names.push(name.clone());
        }
    }
    if n_on > 0 { out += &format!("\nsupport turned off by auto on {} cases that do not need it ({}), isolated effect (support-on -> support-off): model time {:.1} -> {:.1} min ({:+.0}%), filament {:.2} -> {:.2} g ({:+.0}%)\n", n_on, n_on_names.join(","), sum_time_on.0, sum_time_on.1, 100.0 * (sum_time_on.1 / sum_time_on.0 - 1.0), sum_g_on.0, sum_g_on.1, 100.0 * (sum_g_on.1 / sum_g_on.0 - 1.0)); }
    out += "\n--explain for t_overhang / wall_25 / tower5x50:\n";
    for want in ["t_overhang", "wall_25", "tower5x50"] { if let Some(i) = names.iter().position(|(n, _, _)| n == want) { out += &format!("[{want}]\n{}", deltas[i].0.explain()); } }
    let cleaned = orca::cleanup_scratch();
    out += &format!("(scratch presets removed: {cleaned})\n");
    Ok(out)
}

// ---------------------------------------------------------------------------------------------- pathopt
use super::{gcode_plan, pathopt};
use crate::types::Feature;

pub fn eval_pathopt(gcodes: &[std::path::PathBuf]) -> Result<String, String> {
    let mut out = String::new();
    for gp in gcodes {
        let text = std::fs::read_to_string(gp).map_err(|e| format!("{}: {e}", gp.display()))?;
        let name = gp.file_stem().unwrap().to_string_lossy().to_string();
        let cfg = Config::from_gcode(&text).map_err(|e| e.to_string())?;
        let stats = gcode_parse::parse(&text).map_err(|e| e.to_string())?;
        let rec = gcode_plan::plan_from_gcode(&text).map_err(|e| e.to_string())?;
        let model = pathopt::TravelModel {
            min_travel: cfg.f64("retraction_minimum_travel").unwrap_or(2.0),
            reduce_infill_retraction: cfg.bool_("reduce_infill_retraction").unwrap_or(true),
            island_gap: 1.0,
        };
        let t0 = std::time::Instant::now();
        let s0 = pathopt::travel_stats(&rec.plans, rec.start_xy, &model);
        let full = pathopt::optimize_travel(&rec.plans, rec.start_xy, &pathopt::PathOptOptions { model: model.clone(), reorder_islands: true, reorder_infill: true });
        let dt = t0.elapsed().as_secs_f64();
        let isl = pathopt::optimize_travel(&rec.plans, rec.start_xy, &pathopt::PathOptOptions { model: model.clone(), reorder_islands: true, reorder_infill: false });
        let inf = pathopt::optimize_travel(&rec.plans, rec.start_xy, &pathopt::PathOptOptions { model: model.clone(), reorder_islands: false, reorder_infill: true });
        let s1 = pathopt::travel_stats(&full, rec.start_xy, &model);
        let si = pathopt::travel_stats(&isl, rec.start_xy, &model);
        let sf = pathopt::travel_stats(&inf, rec.start_xy, &model);
        let proof = pathopt::verify_same_extrusion(&rec.plans, &full);
        let proof_i = pathopt::verify_same_extrusion(&rec.plans, &isl);
        let proof_f = pathopt::verify_same_extrusion(&rec.plans, &inf);
        let actual_travel: f64 = stats.layers.iter().map(|l| l.travel_mm).sum();
        let pct = |a: f64, b: f64| if a > 0.0 { 100.0 * (b / a - 1.0) } else { 0.0 };
        out += &format!("== {name}: {} layers, {} paths, {} islands (cluster gap {} mm)\n", s0.layers, s0.paths, s0.islands, model.island_gap);
        out += &format!("   Orca actual (G-code): retractions {} travel {:.0} mm   | model on Orca order: retractions {} travel {:.0} mm (model/actual: {:+.1}% retractions, {:+.1}% travel)\n",
            stats.retractions.count, actual_travel, s0.retractions, s0.travel_mm, pct(stats.retractions.count as f64, s0.retractions as f64), pct(actual_travel, s0.travel_mm));
        out += &format!("   lower bound on retractions (any order): {}   (min_travel {} mm, reduce_infill_retraction {})\n", s0.retraction_lower_bound, model.min_travel, model.reduce_infill_retraction);
        out += &format!("   optimized (islands+infill): retractions {} ({:+.1}% vs model-on-Orca, {:.0}% of the gap to the bound closed), travel {:.0} mm ({:+.1}%)  [{:.1}s]\n",
            s1.retractions, pct(s0.retractions as f64, s1.retractions as f64),
            100.0 * (s0.retractions as f64 - s1.retractions as f64) / ((s0.retractions as f64 - s0.retraction_lower_bound as f64).max(1.0)), s1.travel_mm, pct(s0.travel_mm, s1.travel_mm), dt);
        let fixed = pathopt::fixed_pair_retractions(&full, rec.start_xy, &model);
        out += &format!("   of the {} retractions left, {} sit between two paths whose order is fixed by the quality rules (walls, top/bottom, bridges); the rest ({}) is what ordering can still touch\n", s1.retractions, fixed, s1.retractions - fixed.min(s1.retractions));
        out += &format!("   islands only: retractions {} ({:+.1}%) travel {:.0} mm ({:+.1}%) | infill only: retractions {} ({:+.1}%) travel {:.0} mm ({:+.1}%)\n",
            si.retractions, pct(s0.retractions as f64, si.retractions as f64), si.travel_mm, pct(s0.travel_mm, si.travel_mm), sf.retractions, pct(s0.retractions as f64, sf.retractions as f64), sf.travel_mm, pct(s0.travel_mm, sf.travel_mm));
        out += &format!("   PROOF extruded segment multiset unchanged: full {} | islands-only {} | infill-only {}\n",
            match &proof { Ok(n) => format!("OK ({n} segments)"), Err(e) => format!("FAIL {e}") }, match &proof_i { Ok(n) => format!("OK ({n})"), Err(e) => format!("FAIL {e}") }, match &proof_f { Ok(n) => format!("OK ({n})"), Err(e) => format!("FAIL {e}") });
        // validate the retraction rule travel by travel against what Orca actually did (layer starts excluded: Orca retracts at the layer end)
        let dec = pathopt::model_decisions(&rec.plans, rec.start_xy, &model);
        let mut cf = Conf::default();
        let mut fp_tab: std::collections::BTreeMap<(&str, &str, &str), usize> = Default::default();
        for (li, pi, pred) in &dec {
            if *pi == 0 { continue; }
            let act = rec.retracted_before[*li][*pi];
            cf.add(*pred, act);
            if *pred && !act {
                let (pp, np) = (&rec.plans[*li].paths[*pi - 1], &rec.plans[*li].paths[*pi]);
                let dist = ((pp.pts[pp.pts.len() - 1].x - np.pts[0].x).hypot(pp.pts[pp.pts.len() - 1].y - np.pts[0].y)).max(0.0);
                *fp_tab.entry((pp.feature.orca_name(), np.feature.orca_name(), if dist < 5.0 { "2-5" } else if dist < 20.0 { "5-20" } else { ">20" })).or_default() += 1;
            }
        }
        let mut fpv: Vec<_> = fp_tab.into_iter().collect(); fpv.sort_by_key(|x| std::cmp::Reverse(x.1));
        for (k, n) in fpv.iter().take(8) { out += &format!("      model-only retraction: {:<22} -> {:<22} {:>5} mm  x{}\n", k.0, k.1, k.2, n); }
        let first_actual = rec.retracted_before.iter().filter(|r| r.first().copied().unwrap_or(false)).count();
        out += &format!("   retraction rule vs Orca, per travel inside layers (n={}): TP {} FP {} FN {} TN {} -> precision {} recall {}; layer starts with a retraction: {} of {}\n", cf.n(), cf.tp, cf.fp, cf.fneg, cf.tn, pr(cf.precision()), pr(cf.recall()), first_actual, rec.retracted_before.len());
        let (b0, b1) = (pathopt::retraction_breakdown(&rec.plans, rec.start_xy, &model), pathopt::retraction_breakdown(&full, rec.start_xy, &model));
        let mut keys: Vec<_> = b0.keys().chain(b1.keys()).cloned().collect(); keys.sort(); keys.dedup();
        keys.sort_by_key(|k| std::cmp::Reverse(b0.get(k).copied().unwrap_or(0)));
        out += "   retractions by (before -> after, same island): Orca order -> optimized\n";
        for k in keys.iter().take(9) { out += &format!("      {:<24} -> {:<24} {:<5} {:>4} -> {:>4}\n", k.0, k.1, if k.2 { "same" } else { "other" }, b0.get(k).copied().unwrap_or(0), b1.get(k).copied().unwrap_or(0)); }
        // seams: closed-ify Orca's outer-wall loops (gap < 1 mm) and compare Orca's start vertex with ours (polygon metric only)
        let mut orca_layers: Vec<Vec<(Vec<[f64; 2]>, usize)>> = vec![];
        let mut mine_layers: Vec<Vec<(Vec<[f64; 2]>, usize)>> = vec![];
        let mut prev_seams: Vec<[f64; 2]> = vec![]; let mut below: Vec<Vec<[f64; 2]>> = vec![];
        for l in &rec.plans {
            let (mut lo, mut lm, mut seams, mut rings) = (vec![], vec![], vec![], vec![]);
            for p in l.paths.iter().filter(|p| p.feature == Feature::OuterWall && p.pts.len() >= 6) {
                let (a, b) = (p.pts[0], p.pts[p.pts.len() - 1]);
                let closed = p.closed || (a.x - b.x).hypot(a.y - b.y) < 1.0;
                if !closed { continue; }
                let mut ring: Vec<[f64; 2]> = p.pts.iter().map(|q| [q.x, q.y]).collect();
                if !p.closed && ring.len() > 3 && (a.x - b.x).hypot(a.y - b.y) < 1e-6 { ring.pop(); }
                let cen = [ring.iter().map(|v| v[0]).sum::<f64>() / ring.len() as f64, ring.iter().map(|v| v[1]).sum::<f64>() / ring.len() as f64];
                let prev = prev_seams.iter().copied().min_by(|x, y| ((x[0] - cen[0]).hypot(x[1] - cen[1])).partial_cmp(&((y[0] - cen[0]).hypot(y[1] - cen[1]))).unwrap()).filter(|s| ring.iter().any(|v| (v[0] - s[0]).hypot(v[1] - s[1]) < 6.0));
                let k = pathopt::choose_seam(&ring, &below, prev, pathopt::SeamMode::Aligned);
                seams.push(ring[k]); lo.push((ring.clone(), 0usize)); lm.push((ring.clone(), k)); rings.push(ring);
            }
            if !rings.is_empty() { prev_seams = seams; below = rings; }
            orca_layers.push(lo); mine_layers.push(lm);
        }
        let (mo, mm) = (pathopt::seam_metrics(&orca_layers), pathopt::seam_metrics(&mine_layers));
        out += &format!("   seams (Orca outer-wall loops closed-ified, {} loops): Orca start: concave {:.0}% unsupported {:.0}% mean layer-to-layer jump {:.2} mm | aligned-concave: concave {:.0}% unsupported {:.0}% jump {:.2} mm  (polygon metric; rule: concave hides a seam)\n",
            mo.loops, 100.0 * mo.concave_share, 100.0 * mo.unsupported_share, mo.mean_jump_mm, 100.0 * mm.concave_share, 100.0 * mm.unsupported_share, mm.mean_jump_mm);
        // min layer time
        let spd = pathopt::SpeedTable::from_config(&cfg);
        let (_b, rep) = pathopt::balance_layer_time(&rec.plans, &spd, cfg.f64("slow_down_layer_time").unwrap_or(12.0), cfg.f64("slow_down_min_speed").unwrap_or(10.0));
        out += &format!("   min layer time ({}s): {} of {} layers short; slowdown added: uniform {:.0}s vs balanced {:.0}s; outer wall left at full speed in {} of {} short layers; {} unreachable\n",
            cfg.f64("slow_down_layer_time").unwrap_or(12.0), rep.short_layers, rep.layers, rep.added_s_uniform, rep.added_s_balanced, rep.outer_wall_untouched_layers, rep.short_layers, rep.unreachable_layers);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------- orient
use super::orient;

fn mesh_soup(m: &Mesh) -> Vec<[f64; 9]> { (0..m.tris.len()).map(|i| { let t = m.tri(i); [t[0][0], t[0][1], t[0][2], t[1][0], t[1][1], t[1][2], t[2][0], t[2][1], t[2][2]] }).collect() }

pub fn eval_orient(dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let cache = dir.join("orca"); std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    // (name, soup): the ORIGINAL pose as a user might export it
    let rot_x90 = orient::rotation_between([0., 0., 1.], [0., -1., 0.]);
    let t = shapes::cases().into_iter().find(|c| c.name == "t_overhang").unwrap().soup;
    let mush = shapes::cases().into_iter().find(|c| c.name == "mushroom").unwrap().soup;
    let br = shapes::cases().into_iter().find(|c| c.name == "bridge_20").unwrap().soup;
    let sl = shapes::cases().into_iter().find(|c| c.name == "slope_25").unwrap().soup;
    let tower = shapes::cases().into_iter().find(|c| c.name == "tower5x50").unwrap().soup;
    let lay = |s: &[[f64; 9]], r: &orient::Rot| -> Vec<[f64; 9]> { s.iter().map(|t| { let mut o = *t; for k in 0..3 { let v = orient::apply_rot(r, [t[k * 3], t[k * 3 + 1], t[k * 3 + 2]]); o[k * 3] = v[0]; o[k * 3 + 1] = v[1]; o[k * 3 + 2] = v[2]; } o }).collect() };
    let mut models: Vec<(String, Vec<[f64; 9]>)> = vec![("t_upright".into(), t.clone()), ("t_on_side".into(), lay(&t, &rot_x90)), ("mushroom_upright".into(), mush), ("bridge20_upright".into(), br), ("slope25_upright".into(), sl), ("tower5x50_upright".into(), tower)];
    // real model, already well oriented: the pose must be kept
    let real = std::path::PathBuf::from("/home/gbacs/hives/2bee.farm/hardware/cad/stl/fleet/pnp_blinds_coupon0402_set.stl");
    if let Ok(m) = Mesh::from_stl_file(&real) { models.push(("coupon0402 (real)".into(), mesh_soup(&m))); }
    // baseline config
    let base_stl = dir.join("cfg_cube.stl"); write_stl(&base_stl, &shapes::boxs(20., 20., 20.));
    let base_g = orca::slice(&base_stl, &[], Some(&cache))?;
    let cfg = Config::from_gcode(&base_g).map_err(|e| e.to_string())?;
    let mut out = String::from("orientation vs Orca (all runs: X2D 0.4, PETG; 'auto' = autoconfig delta computed from that pose; time = Orca model time)\n");
    out += &format!("{:<20} {:<34} {:>7} {:>7} {:>8} {:>6}  note\n", "model", "run", "time", "g", "support", "layers");
    for (name, soup) in &models {
        let m0 = Mesh::from_soup(soup).map_err(|e| e.to_string())?;
        let res = orient::orient(&m0, &cfg, &orient::OrientOptions::default()).map_err(|e| e.to_string())?;
        let mine = rotate_for_orca(&m0, &res.best.rot);
        let p0 = dir.join(format!("{}__as_exported.stl", name.replace(' ', "_")));
        let p1 = dir.join(format!("{}__our_pose.stl", name.replace(' ', "_")));
        write_stl(&p0, soup); write_stl(&p1, &mesh_soup(&mine));
        // delta for a pose = autoconfig(preflight of that pose)
        let delta_for = |mm: &Mesh| -> Result<SettingsDelta, String> {
            let mut m = mm.clone(); m.place_on_bed(128.0, 128.0);
            let layers = slice::slice(&m, &cfg).map_err(|e| e.to_string())?.layers;
            Ok(autoconfig(&preflight::preflight(&m, &cfg, &layers), &cfg, &AutoOptions::default()))
        };
        let d0 = delta_for(&m0)?; let d1 = delta_for(&mine)?;
        let sets = |d: &SettingsDelta| -> Vec<(String, String)> { d.as_overrides() };
        let run = |stl: &Path, tag: &str, s: &[(String, String)], orient_on: bool| -> Result<Outcome, String> {
            let s2: Vec<(&str, &str)> = s.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            let w = dir.join(format!("cli-{}-{tag}", name.replace(' ', "_")));
            let g = orca::cli_slice(stl, &w, &s2, orient_on);
            Ok(outcome(&g))
        };
        let on = vec![("enable_support".to_string(), "1".to_string())];
        let rows: Vec<(String, Outcome, String)> = vec![
            ("as exported, no support".into(), run(&p0, "a", &[], false)?, String::new()),
            ("as exported, support on".into(), run(&p0, "b", &on, false)?, String::new()),
            ("as exported + auto".into(), run(&p0, "c", &sets(&d0), false)?, d0.changes.iter().map(|c| format!("{}={}", c.key, c.value)).collect::<Vec<_>>().join(" ")),
            ("Orca --orient 1, support on".into(), run(&p0, "d", &on, true)?, String::new()),
            ("Orca --orient 1 + auto(as exported)".into(), run(&p0, "e", &sets(&d0), true)?, "".into()),
            ("our pose + auto".into(), run(&p1, "f", &sets(&d1), false)?, d1.changes.iter().map(|c| format!("{}={}", c.key, c.value)).collect::<Vec<_>>().join(" ")),
        ];
        for (lbl, o, note) in &rows {
            if let Some(e) = &o.refused { out += &format!("{:<20} {:<34} PENDING ({e})\n", name, lbl); continue; }
            out += &format!("{:<20} {:<34} {:>7.1} {:>7.2} {:>8.0} {:>6}  {}\n", name, lbl, o.time_min, o.g, o.support_mm, o.layers, note);
        }
        out += &format!("{:<20} orient: {}\n", name, res.reason);
    }
    Ok(out)
}
fn rotate_for_orca(m: &Mesh, r: &orient::Rot) -> Mesh { orient::rotate_mesh(m, r) }
