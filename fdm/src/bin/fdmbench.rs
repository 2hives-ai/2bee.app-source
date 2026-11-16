//! `fdmbench`: wall time / allocations / peak RSS per stage, and the determinism proof (hash of every
//! output bit, compared across thread counts). Std only.
//!
//!   fdmbench [--threads 1,2,24] [--models cube,ring,sphere,torus,trays] [--tris 200000]
//!            [--gcode FILE.gcode[,FILE2]] [--gcode-mb 60] [--reps 1]
//! Exit 0 = every hash equal across thread counts; 1 = a MISMATCH (parallel != serial); 2 = could not run.
#[path = "../bench.rs"]
mod bench;
use bench::*;
use std::time::Instant;
use twobee_fdm::{geom, gcode_parse, mesh::Mesh, parity, slice};

#[global_allocator]
static A: CountingAlloc = CountingAlloc;

const FLEET: &str = "/home/gbacs/hives/2bee.farm/hardware/cad/stl/fleet";

fn arg(args: &[String], k: &str) -> Option<String> { args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned()) }

fn row(name: &str, secs: f64, allocs: u64, bytes: u64, hash: u64) {
    println!("  {name:<28} {secs:>9.4} s  allocs {allocs:>10}  alloc {:>9.1} MB  rssPeak {:>7.1} MB  hash {hash:016x}",
        bytes as f64 / 1048576.0, peak_rss_kb().unwrap_or(0) as f64 / 1024.0);
}

/// geom ops on the real layer regions; returns a hash of every output.
fn geom_stage(layers: &[twobee_fdm::types::Layer], threads: usize) -> u64 {
    let one = |_: usize, l: &twobee_fdm::types::Layer| -> u64 {
        let mut h = Fnv::new();
        let a = geom::offset(&l.region, -0.42);
        let b = geom::offset(&a, -0.45);
        let c = geom::diff(&a, &b);
        let o = geom::offset(&b, 0.1);
        let u = geom::union(&c, &o);
        hash_polys(&mut h, &a); hash_polys(&mut h, &b); hash_polys(&mut h, &c); hash_polys(&mut h, &u);
        for line in geom::hatch(&b, 45.0, 0.9, 0.0) { for p in line { h.f(p[0]); h.f(p[1]); } }
        h.0
    };
    let hs: Vec<u64> = slice::par_map(layers, threads, one);
    let mut h = Fnv::new(); for x in hs { h.u64(x); } h.0
}

/// Per-operation breakdown of the geom stage (serial, same ops as `geom_stage`).
fn geom_breakdown(layers: &[twobee_fdm::types::Layer]) {
    let mut t = [0.0f64; 6];
    let mut n = [0u64; 6];
    let (mut tb, mut maxdev, mut cnt_mismatch) = (0.0f64, 0.0f64, 0usize);
    let mut lap = |i: usize, t0: Instant, t: &mut [f64; 6], n: &mut [u64; 6]| { t[i] += t0.elapsed().as_secs_f64(); n[i] += 1; };
    for l in layers {
        let t0 = Instant::now(); let a = geom::offset(&l.region, -0.42); lap(0, t0, &mut t, &mut n);
        let t0 = Instant::now(); let b = geom::offset(&a, -0.45); lap(1, t0, &mut t, &mut n);
        let t0 = Instant::now(); let c = geom::diff(&a, &b); lap(2, t0, &mut t, &mut n);
        let t0 = Instant::now(); let o = geom::offset(&b, 0.1); lap(3, t0, &mut t, &mut n);
        let t0 = Instant::now(); let u = geom::union(&c, &o); lap(4, t0, &mut t, &mut n);
        let t0 = Instant::now(); let hh = geom::hatch(&b, 45.0, 0.9, 0.0); lap(5, t0, &mut t, &mut n);
        std::hint::black_box((&u, &hh));
        let t0 = Instant::now(); let hb = geom::hatch_batched(&b, 45.0, 0.9, 0.0); tb += t0.elapsed().as_secs_f64();
        if hb.len() != hh.len() { cnt_mismatch += 1; } else { for (x, y) in hb.iter().zip(&hh) { for k in 0..2 { for c in 0..2 { maxdev = maxdev.max((x[k][c] - y[k][c]).abs()); } } } }
    }
    println!("    op hatch_batched(opt-in, NOT bit-identical) {:>9.4} s total; segment-count mismatches {cnt_mismatch}, max coordinate deviation vs hatch {maxdev:.3e} mm", tb);
    for (i, nm) in ["offset(-0.42)", "offset(-0.45)", "diff", "offset(+0.1)", "union", "hatch(45,0.9)"].iter().enumerate() {
        println!("    op {nm:<14} {:>9.4} s total  {:>9.1} us/layer", t[i], t[i] / n[i].max(1) as f64 * 1e6);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ncpu = std::thread::available_parallelism().map_or(1, |n| n.get());
    let threads: Vec<usize> = arg(&args, "--threads").map(|s| s.split(',').filter_map(|x| x.parse().ok()).collect()).unwrap_or_else(|| vec![1, 2, ncpu]);
    let tris: usize = arg(&args, "--tris").and_then(|s| s.parse().ok()).unwrap_or(200_000);
    let models = arg(&args, "--models").unwrap_or_else(|| "cube,ring,sphere,torus,trays".into());
    let mut mismatches = 0;
    let reps: usize = arg(&args, "--reps").and_then(|s| s.parse().ok()).unwrap_or(1);
    println!("fdmbench: cpus {ncpu}, thread counts {threads:?}, target dense tris {tris}, best-of {reps}, loadavg(1m) {} (machine is shared)", loadavg());

    let mut stls: Vec<(String, Vec<u8>)> = vec![];
    for m in models.split(',') {
        match m {
            "cube" => stls.push(("cube20".into(), parity::stl_cube(20.0, 0.0))),
            "ring" => stls.push(("ring20".into(), parity::stl_cube(20.0, 8.0))),
            "sphere" => stls.push((format!("sphere{}k", tris / 1000), sphere_stl(tris, 40.0))),
            "torus" => stls.push((format!("torus{}k", tris / 1000), torus_stl(tris, 30.0, 10.0))),
            "trays" => for n in ["12", "16", "8emb", "8paper", "coupon0402"] {
                let p = format!("{FLEET}/pnp_blinds_{n}_set.stl");
                match std::fs::read(&p) { Ok(b) => stls.push((format!("pnp_{n}_set"), b)), Err(e) => eprintln!("SKIP {p}: {e}") }
            },
            _ => {}
        }
    }
    let mut cfg = twobee_fdm::config::Config::new();
    for (k, v) in [("layer_height", "0.2"), ("initial_layer_print_height", "0.2"), ("min_layer_height", "0.07")] { cfg.set(k, v); }
    for (name, bytes) in &stls {
        println!("\n== {name}  ({} bytes)", bytes.len());
        let (m, s, a, b) = best_of(reps, || Mesh::from_stl(bytes).expect("stl"));
        row("load (parse+weld)", s, a, b, m.tris.len() as u64);
        let mut m = m;
        let (rep, s, a, b) = best_of(reps, || m.validate());
        row("validate", s, a, b, rep.open_edges as u64);
        let (_, s, a, b) = timed(|| m.place_on_bed(138.25, 128.0));
        row("place_on_bed", s, a, b, 0);
        println!("  tris {} verts {} watertight {}", m.tris.len(), m.verts.len(), rep.is_watertight());
        let (mn, mx) = m.bbox();
        let specs = slice::stack_from_config(&cfg, mx[2]).expect("stack");
        let _ = mn;
        let mut hs = vec![];
        for &t in &threads {
            let (r, s, a, b) = best_of(reps, || slice::slice_mesh_threads(&m, &specs, slice::SliceOptions::default(), t));
            let h = hash_slice(&r);
            row(&format!("slice_mesh t={t} ({} layers)", r.layers.len()), s, a, b, h);
            let (g, s, a, b) = best_of(reps, || geom_stage(&r.layers, t));
            row(&format!("geom ops t={t}"), s, a, b, g);
            if t == threads[0] && std::env::var("FDMBENCH_BREAKDOWN").is_ok() { geom_breakdown(&r.layers); }
            hs.push((h, g));
        }
        if hs.iter().any(|x| *x != hs[0]) { println!("  !! MISMATCH across thread counts: {hs:x?}"); mismatches += 1; } else { println!("  == identical across thread counts {threads:?}"); }
    }

    if let Some(g) = arg(&args, "--gcode") {
        let mb: usize = arg(&args, "--gcode-mb").and_then(|s| s.parse().ok()).unwrap_or(60);
        let parts: Vec<String> = g.split(',').filter_map(|p| std::fs::read_to_string(p).map_err(|e| eprintln!("SKIP {p}: {e}")).ok()).collect();
        let text = repeat_to_size(&parts, mb);
        let mbs = text.len() as f64 / 1048576.0;
        println!("\n== gcode {mbs:.1} MB, {} lines", text.lines().count());
        let (c, s, a, b) = best_of(reps, || twobee_fdm::config::Config::from_gcode(&text).expect("config"));
        row(&format!("config::from_gcode ({} keys)", c.len()), s, a, b, c.len() as u64);
        let (st, s, a, b) = best_of(reps, || gcode_parse::parse(&text).expect("parse"));
        row(&format!("gcode_parse ({:.1} MB/s)", mbs / s), s, a, b, hash_stats(&st));
        let (_, c, w) = best_cpu(reps, || gcode_parse::parse(&text).expect("parse"));
        println!("  gcode_parse CPU-time best-of-{reps}: {c:.4} s cpu ({:.1} MB/s cpu), wall of that run {w:.4} s", mbs / c);
        let (r, s, a, b) = best_of(reps, || parity::compare(&st, &st, &parity::Options::default()));
        row("parity::compare (same,same)", s, a, b, r.to_json().to_string().len() as u64);
        let t0 = Instant::now();
        let (r2, s, a, b) = best_of(reps, || parity::compare_text(&text, &text, &parity::Options::default()).expect("cmp"));
        row(&format!("compare_text 2x parse ({:.1} MB/s)", 2.0 * mbs / s), s, a, b, r2.to_json().to_string().len() as u64);
        let _ = t0;
    }
    if let Some(p) = peak_rss_kb() { println!("\nloadavg(1m) at end {}; peak RSS (whole run) {:.1} MB", loadavg(), p as f64 / 1024.0); }
    std::process::exit(if mismatches > 0 { 1 } else { 0 });
}
