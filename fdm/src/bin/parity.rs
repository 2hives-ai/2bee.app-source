//! `parity`: the OrcaSlicer parity gate for twobee-fdm.
//!
//!   parity orca.gcode ours.gcode [--json] [--tol 3,10] [--all] [--no-seam-pos] [--include-custom] [--skip a,b] [--plant]
//!   parity --matrix [--models cube,ring,coupon0402|all] [--only key1,key2|baseline] [--quick] [--fresh]
//!                   [--conc N] [--json] [--tol 3,10] [--save-dir DIR] [--plant]
//!   parity --selftest
//!
//! Exit codes (the fleet's contract): 0 = every case PASS/WARN over a non-empty population,
//! 1 = at least one FAIL, 2 = could not fully run (PENDING: ours not wired, Orca server down, empty population).
//!
//! Std + serde_json only. HTTP is `curl`. "Ours" comes from `ours_gcode()` below: until the lead wires
//! `crate::pipeline::slice_gcode` into that one function, or sets `FDM_OURS_CMD`, every case is PENDING.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use twobee_fdm::gcode_parse::{parse, Stats};
use twobee_fdm::parity::*;

const SERVER_DEFAULT: &str = "http://127.0.0.1:8765";
const PROC: &str = "0.20mm Standard @BBL X2D - pnp coupon";
const FIL: &str = "Green PETG 1.75 @coupon 235";
const BED: &str = "Textured PEI Plate";
const MAX_CONC: usize = 3;

// ------------------------------------------------------------------------------------------------ "ours"

enum Ours {
    Gcode(String),
    /// Could not run (not wired, refused as unsupported): PENDING.
    Pending(String),
    /// Ran and broke: FAIL.
    Error(String),
}

/// THE ONE HOOK for our pipeline. When `twobee_fdm::pipeline::slice_gcode` exists, replace the final
/// `Ours::Pending(..)` with a call that turns (`stl`, Orca's resolved CONFIG_BLOCK in `orca_gcode`) into G-code and map
/// `FdmError::Unsupported(_)` -> `Ours::Pending`, any other error -> `Ours::Error`.
/// Until then `FDM_OURS_CMD` (a shell command with `{stl}` `{orca}` `{out}` placeholders; exit 2 = cannot run,
/// other nonzero = error) lets the JS prototype or any binary stand in:
///   FDM_OURS_CMD='node /home/gbacs/build/web-slicer/tools/slice.js {stl} {orca} {out}'
fn ours_gcode(stl: &Path, orca_gcode_path: &Path, scratch: &Path, _stl_bytes: &[u8], _orca_gcode: &str) -> Ours {
    if let Ok(tpl) = std::env::var("FDM_OURS_CMD") {
        let out = scratch.with_extension("ours.gcode");
        let _ = std::fs::remove_file(&out);
        let cmd = tpl.replace("{stl}", &stl.to_string_lossy()).replace("{orca}", &orca_gcode_path.to_string_lossy()).replace("{out}", &out.to_string_lossy());
        return match Command::new("sh").arg("-c").arg(&cmd).output() {
            Err(e) => Ours::Pending(format!("FDM_OURS_CMD could not start: {e}")),
            Ok(o) => match o.status.code() {
                Some(0) => match std::fs::read_to_string(&out) {
                    Ok(g) => Ours::Gcode(g),
                    Err(e) => Ours::Error(format!("FDM_OURS_CMD exited 0 but wrote no readable {}: {e}", out.display())),
                },
                Some(2) => Ours::Pending(format!("FDM_OURS_CMD reported it cannot run: {}", tail(&o.stderr))),
                c => Ours::Error(format!("FDM_OURS_CMD exit {c:?}: {}", tail(&o.stderr))),
            },
        };
    }
    Ours::Pending("pipeline::slice_gcode not wired into ours_gcode() and FDM_OURS_CMD unset".into())
}

fn tail(b: &[u8]) -> String {
    let s = String::from_utf8_lossy(b);
    let l: Vec<&str> = s.lines().rev().take(2).collect();
    l.into_iter().rev().collect::<Vec<_>>().join(" / ")
}

// ------------------------------------------------------------------------------------------------ orca client

fn url_encode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o += &format!("%{b:02X}");
        }
    }
    o
}

fn fnv(parts: &[&[u8]]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in p.iter().chain(&[0xffu8]) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

fn work_dir() -> PathBuf {
    std::env::var("FDM_PARITY_DIR").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir().join("fdm-parity"))
}

enum OrcaRes {
    Ok { path: PathBuf },
    Err { msg: String, infra: bool },
}

fn orca_slice(model: &str, stl: &Path, stl_bytes: &[u8], sets: &[(&str, &str)], fresh: bool) -> OrcaRes {
    let server = std::env::var("SLICER_URL").unwrap_or_else(|_| SERVER_DEFAULT.to_string());
    let setkv = sets.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("\n");
    let cache = work_dir().join("cache");
    let _ = std::fs::create_dir_all(&cache);
    let key = fnv(&[stl_bytes, PROC.as_bytes(), FIL.as_bytes(), BED.as_bytes(), setkv.as_bytes()]);
    let cf = cache.join(format!("{key}.gcode"));
    if !fresh && cf.exists() {
        return OrcaRes::Ok { path: cf };
    }
    let mut url = format!("{server}/api/slice?process={}&filament={}&bed={}&name={}.stl", url_encode(PROC), url_encode(FIL), url_encode(BED), url_encode(model));
    for (k, v) in sets {
        url += &format!("&set={}", url_encode(&format!("{k}={v}")));
    }
    let out = Command::new("curl").args(["-sS", "-m", "900", "-X", "POST", "--data-binary"]).arg(format!("@{}", stl.display())).arg(&url).output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        Ok(o) => return OrcaRes::Err { msg: format!("curl failed ({:?}): {}", o.status.code(), tail(&o.stderr)), infra: true },
        Err(e) => return OrcaRes::Err { msg: format!("curl could not start: {e}"), infra: true },
    };
    let j: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(j) => j,
        Err(e) => return OrcaRes::Err { msg: format!("server reply is not JSON ({e}): {}", String::from_utf8_lossy(&out.stdout).chars().take(120).collect::<String>()), infra: true },
    };
    if j["ok"].as_bool() != Some(true) {
        let log = j["log"].as_str().map(|l| l.lines().rev().take(2).collect::<Vec<_>>().join(" / ")).unwrap_or_default();
        return OrcaRes::Err { msg: format!("Orca refused: {} {}", j["error"].as_str().unwrap_or("unknown"), log), infra: false };
    }
    let Some(id) = j["id"].as_str() else { return OrcaRes::Err { msg: "reply has no job id".into(), infra: true } };
    let jobs = std::env::var("SLICER_JOBS_DIR").unwrap_or_else(|_| "/tmp/web-slicer-jobs".into());
    let gp = Path::new(&jobs).join(id).join("plate_1.gcode");
    match std::fs::copy(&gp, &cf) {
        Ok(_) => OrcaRes::Ok { path: cf },
        Err(e) => OrcaRes::Err { msg: format!("G-code unreadable at {}: {e}", gp.display()), infra: true },
    }
}

fn motion_hash(g: &str) -> String {
    let v: Vec<&[u8]> = g.lines().filter(|l| l.starts_with('G') || l.starts_with('M')).map(|l| l.as_bytes()).collect();
    fnv(&v)
}

static BASELINES: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());

fn baseline_hash(model: &str, stl: &(PathBuf, Vec<u8>), fresh: bool) -> Option<String> {
    if let Some((_, h)) = BASELINES.lock().unwrap().iter().find(|(n, _)| n == model) {
        return h.clone();
    }
    let h = match orca_slice(model, &stl.0, &stl.1, &[], fresh) {
        OrcaRes::Ok { path } => std::fs::read_to_string(path).ok().map(|t| motion_hash(&t)),
        _ => None,
    };
    BASELINES.lock().unwrap().push((model.to_string(), h.clone()));
    h
}

// ------------------------------------------------------------------------------------------------ negative control

struct Control {
    caught: bool,
    base_pct: Option<f64>,
    planted_pct: Option<f64>,
    detail: String,
    cannot_run: bool,
}

/// Plant +15 % wall length in a copy of OUR G-code; the gate must turn FAIL on the wall rows and must have moved by
/// at least 8 percentage points relative to the unplanted comparison (so a case that already failed does not
/// count as "caught").
fn plant_control(orca: &Stats, ours_text: &str, opts: &Options) -> Control {
    let base_stats = match parse(ours_text) {
        Ok(s) => s,
        Err(e) => return Control { caught: false, base_pct: None, planted_pct: None, detail: format!("ours unreadable: {e}"), cannot_run: true },
    };
    if !base_stats.features.contains_key("Outer wall") || !orca.features.contains_key("Outer wall") {
        return Control { caught: false, base_pct: None, planted_pct: None, detail: "no Outer wall feature on one side: the plant has nothing to bite".into(), cannot_run: true };
    }
    let planted = plant_wall_scale(ours_text, 1.15);
    let pst = match parse(&planted) {
        Ok(s) => s,
        Err(e) => return Control { caught: false, base_pct: None, planted_pct: None, detail: format!("planted copy unreadable: {e}"), cannot_run: true },
    };
    let base = compare(orca, &base_stats, opts);
    let pl = compare(orca, &pst, opts);
    let get = |r: &Report| r.row("feature:Outer wall", "path_mm").and_then(|x| x.pct.map(|p| (p, x.status)));
    let (b, p) = (get(&base), get(&pl));
    let (bp, pp) = (b.map(|x| x.0), p.map(|x| x.0));
    let caught = matches!((b, p), (Some(b), Some(p)) if p.1 == Status::Fail && p.0 - b.0 >= 8.0) && pl.verdict == Status::Fail;
    Control { caught, base_pct: bp, planted_pct: pp, detail: format!("Outer wall path_mm: unplanted {:+.1}% -> planted {:+.1}%, planted verdict {}", bp.unwrap_or(f64::NAN), pp.unwrap_or(f64::NAN), pl.verdict.label()), cannot_run: false }
}

// ------------------------------------------------------------------------------------------------ args

#[derive(Default)]
struct Args {
    pos: Vec<String>,
    flags: BTreeMap<String, Option<String>>,
}
impl Args {
    fn has(&self, k: &str) -> bool {
        self.flags.contains_key(k)
    }
    fn val(&self, k: &str) -> Option<&str> {
        self.flags.get(k).and_then(|v| v.as_deref())
    }
}
fn parse_args() -> Result<Args, String> {
    const WITH_VAL: &[&str] = &["tol", "models", "only", "conc", "save-dir", "skip"];
    const BOOL: &[&str] = &["json", "matrix", "selftest", "quick", "fresh", "plant", "all", "no-seam-pos", "include-custom", "list"];
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        if let Some(k) = x.strip_prefix("--") {
            if WITH_VAL.contains(&k) {
                let v = it.next().ok_or(format!("--{k} needs a value"))?;
                a.flags.insert(k.into(), Some(v));
            } else if BOOL.contains(&k) {
                a.flags.insert(k.into(), None);
            } else {
                return Err(format!("unknown flag --{k}"));
            }
        } else {
            a.pos.push(x);
        }
    }
    Ok(a)
}

fn options(a: &Args) -> Result<Options, String> {
    let mut o = Options::default();
    if let Some(t) = a.val("tol") {
        let p: Vec<f64> = t.split(',').filter_map(|x| x.trim().parse().ok()).collect();
        if p.len() != 2 || p[0] <= 0.0 || p[1] < p[0] {
            return Err(format!("--tol wants 'pass,warn' percentages with 0 < pass <= warn, got '{t}'"));
        }
        o.tol = Tol { pass: p[0], warn: p[1] };
    }
    o.judge_seam_pos = !a.has("no-seam-pos");
    o.include_custom = a.has("include-custom");
    if let Some(s) = a.val("skip") {
        o.skip = s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    }
    Ok(o)
}

// ------------------------------------------------------------------------------------------------ modes

fn read(p: &str) -> Result<String, String> {
    std::fs::read_to_string(p).map_err(|e| format!("cannot read {p}: {e}"))
}

fn mode_pair(a: &Args) -> i32 {
    if a.pos.len() != 2 {
        eprintln!("usage: parity orca.gcode ours.gcode [--json] [--tol 3,10] [--all] [--plant]  |  parity --matrix ...  |  parity --selftest");
        return 2;
    }
    let opts = match options(a) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let (ot, ut) = match (read(&a.pos[0]), read(&a.pos[1])) {
        (Ok(x), Ok(y)) => (x, y),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let (os, us) = match (parse(&ot), parse(&ut)) {
        (Ok(x), Ok(y)) => (x, y),
        (Err(e), _) => {
            eprintln!("orca file: {e}");
            return 2;
        }
        (_, Err(e)) => {
            eprintln!("our file: {e}");
            return 2;
        }
    };
    if a.has("plant") {
        let c = plant_control(&os, &ut, &opts);
        if a.has("json") {
            println!("{}", serde_json::json!({"control": "plant +15% wall length", "caught": c.caught, "unplanted_outer_wall_pct": c.base_pct, "planted_outer_wall_pct": c.planted_pct, "cannot_run": c.cannot_run, "detail": c.detail}));
        } else {
            println!("NEGATIVE CONTROL plant +15% wall length in a copy of our G-code\n  {}\n  -> {}", c.detail, if c.cannot_run { "PENDING (control could not run)" } else if c.caught { "CAUGHT (gate went FAIL, as it must)" } else { "MISSED (the gate did NOT fail: the gate is broken)" });
        }
        return if c.cannot_run { 2 } else if c.caught { 0 } else { 1 };
    }
    let rep = compare(&os, &us, &opts);
    if a.has("json") {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({"report": rep.to_json(), "orca": os.to_json(), "ours": us.to_json()})).unwrap_or_default());
    } else {
        print!("{}", render_table(&rep, a.has("all")));
    }
    rep.exit_code()
}

struct Case {
    model_idx: usize,
    var: Variation,
}

fn mode_matrix(a: &Args) -> i32 {
    let opts_base = match options(a) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let json = a.has("json");
    // models
    let models: Vec<Model> = match a.val("models") {
        None => default_models(),
        Some("all") => all_models(),
        Some(list) => {
            let all = all_models();
            let mut v = Vec::new();
            for n in list.split(',') {
                match all.iter().find(|m| m.name == n.trim()) {
                    Some(m) => v.push(m.clone()),
                    None => {
                        eprintln!("unknown model '{n}' (known: {})", all.iter().map(|m| m.name).collect::<Vec<_>>().join(","));
                        return 2;
                    }
                }
            }
            v
        }
    };
    // variations (baseline + list), filtered
    let only: Option<Vec<String>> = a.val("only").map(|s| s.split(',').map(|x| x.trim().to_string()).collect());
    let mut vars: Vec<Variation> = vec![Variation::baseline()];
    vars.extend(variations());
    let quick = a.has("quick");
    vars.retain(|v| {
        if v.sets.is_empty() {
            only.as_ref().map_or(true, |o| o.iter().any(|x| x == "baseline"))
        } else {
            only.as_ref().map_or(true, |o| o.iter().any(|x| v.matches(x))) && (!quick || is_quick(&v.name))
        }
    });
    let conc = a.val("conc").and_then(|c| c.parse::<usize>().ok()).unwrap_or(MAX_CONC).clamp(1, MAX_CONC);
    let plant = a.has("plant");
    if a.has("list") {
        for v in &vars {
            println!("{}", v.name);
        }
        println!("{} variations x {} models", vars.len(), models.len());
        return 0;
    }
    let population = vars.len() * models.len();
    if let Some(o) = &only {
        let known = variations();
        for t in o {
            if t != "baseline" && !known.iter().any(|v| v.matches(t)) {
                eprintln!("warning: --only token '{t}' matches no variation key");
            }
        }
    }
    eprintln!("matrix: {} variations x {} models = {} cases; Orca/ours concurrency cap {} (hard max {}){}", vars.len(), models.len(), population, conc, MAX_CONC, if plant { "; NEGATIVE CONTROL mode (+15% wall plant on every ours)" } else { "" });
    if population == 0 {
        let s = MatrixSummary::new(vars.len(), models.len(), vec![]);
        if json {
            println!("{}", serde_json::to_string_pretty(&s.to_json()).unwrap_or_default());
        } else {
            println!("population = 0 cases: PENDING (nothing was compared; a green over zero cases is not a pass)");
        }
        return s.exit_code();
    }
    // materialise model STLs
    let wd = work_dir();
    let _ = std::fs::create_dir_all(&wd);
    let mut stls: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    for m in &models {
        let (p, bytes) = match &m.src {
            ModelSrc::Cube { size, hole } => {
                let bytes = stl_cube(*size, *hole);
                let p = wd.join(format!("mk_{}.stl", m.name));
                if let Err(e) = std::fs::write(&p, &bytes) {
                    eprintln!("cannot write {}: {e}", p.display());
                    return 2;
                }
                (p, bytes)
            }
            ModelSrc::TBar => {
                let bytes = stl_tbar();
                let p = wd.join("mk_tbar.stl");
                if let Err(e) = std::fs::write(&p, &bytes) {
                    eprintln!("cannot write {}: {e}", p.display());
                    return 2;
                }
                (p, bytes)
            }
            ModelSrc::File(f) => {
                let p = Path::new(fleet_dir()).join(f);
                match std::fs::read(&p) {
                    Ok(b) => (p, b),
                    Err(e) => {
                        eprintln!("model missing: {}: {e}", p.display());
                        return 2;
                    }
                }
            }
        };
        stls.push((p, bytes));
    }
    let cases: Vec<Case> = vars.iter().flat_map(|v| (0..models.len()).map(move |mi| Case { model_idx: mi, var: v.clone() })).collect();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<(CaseResult, Option<Control>)>>> = Mutex::new((0..cases.len()).map(|_| None).collect());
    let save_dir = a.val("save-dir").map(PathBuf::from);
    if let Some(d) = &save_dir {
        let _ = std::fs::create_dir_all(d);
    }
    let fresh = a.has("fresh");
    std::thread::scope(|sc| {
        for _ in 0..conc {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= cases.len() {
                    break;
                }
                let c = &cases[i];
                let r = run_case(c, &models[c.model_idx], &stls[c.model_idx], &opts_base, fresh, plant, save_dir.as_deref(), i);
                if !json {
                    eprintln!("[{:>3}/{}] {:<8} {:<11} {:<40} {}", i + 1, cases.len(), r.0.verdict.label(), models[c.model_idx].name, r.0.variation, r.0.detail);
                }
                results.lock().unwrap()[i] = Some(r);
            });
        }
    });
    let all: Vec<(CaseResult, Option<Control>)> = results.into_inner().unwrap().into_iter().flatten().collect();
    if plant {
        return report_plant_matrix(&all, population, json);
    }
    let cr: Vec<CaseResult> = all.into_iter().map(|x| x.0).collect();
    let summary = MatrixSummary::new(vars.len(), models.len(), cr);
    if json {
        // keep the file small: full per-row reports only for cases that are not clean
        let mut v = summary.to_json();
        if let Some(cs) = v["cases"].as_array_mut() {
            for c in cs {
                if c["verdict"] == "Pass" {
                    c["report"] = serde_json::Value::Null;
                }
            }
        }
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
    } else {
        println!("\n{:<8} {:<11} {:<40} {}", "verdict", "model", "variation", "detail");
        for c in &summary.cases {
            println!("{:<8} {:<11} {:<40} {}", if c.orca_error { "ORCA-ERR" } else { c.verdict.label() }, c.model, c.variation, c.detail);
        }
        println!(
            "\nPOPULATION {} variations x {} models = {} cases ({} evaluated)\nPASS {}  WARN {}  FAIL {}  PENDING {}  ORCA-ERROR {}  NOOP-VARIATIONS {}\nVERDICT {}  (exit {})",
            summary.variations, summary.models, summary.population, summary.cases.len(), summary.pass, summary.warn, summary.fail, summary.pending, summary.orca_error, summary.noop, summary.verdict(), summary.exit_code()
        );
    }
    summary.exit_code()
}

#[allow(clippy::too_many_arguments)]
fn run_case(c: &Case, m: &Model, stl: &(PathBuf, Vec<u8>), base: &Options, fresh: bool, plant: bool, save: Option<&Path>, idx: usize) -> (CaseResult, Option<Control>) {
    let vname = c.var.name.clone();
    let mk = |verdict, detail: String, orca_error, report| (CaseResult { model: m.name.into(), variation: vname.clone(), verdict, detail, orca_error, noop: false, report }, None);
    let orca_path = match orca_slice(m.name, &stl.0, &stl.1, &c.var.sets, fresh) {
        OrcaRes::Ok { path } => path,
        OrcaRes::Err { msg, infra } => return mk(Status::Pending, format!("{}{msg}", if infra { "ORCA INFRA: " } else { "" }), true, None),
    };
    let orca_text = match std::fs::read_to_string(&orca_path) {
        Ok(t) => t,
        Err(e) => return mk(Status::Pending, format!("cannot read Orca G-code: {e}"), true, None),
    };
    let orca_stats = match parse(&orca_text) {
        Ok(s) => s,
        Err(e) => return mk(Status::Pending, format!("Orca G-code unreadable by the parser: {e}"), true, None),
    };
    let noop = !c.var.sets.is_empty() && baseline_hash(m.name, stl, fresh).map_or(false, |h| motion_hash(&orca_text) == h);
    let mk = |verdict, detail: String, orca_error, report| {
        let (mut r, c) = mk(verdict, detail, orca_error, report);
        if noop {
            r.noop = true;
            r.detail += " [NOOP: Orca output identical to baseline]";
        }
        (r, c)
    };
    let scratch = work_dir().join(format!("case{idx}"));
    let ours_text = match ours_gcode(&stl.0, &orca_path, &scratch, &stl.1, &orca_text) {
        Ours::Gcode(g) => g,
        Ours::Pending(why) => return mk(Status::Pending, format!("ours not available: {why}"), false, None),
        Ours::Error(e) => return mk(Status::Fail, format!("OUR ENGINE ERROR: {e}"), false, None),
    };
    let mut opts = base.clone();
    if c.var.is_random_seam() {
        opts.judge_seam_pos = false;
    }
    if let Some(d) = save {
        let _ = std::fs::write(d.join(format!("{}-{}-orca.gcode", m.name, vname.replace(['=', ' ', '/', '%'], "_"))), &orca_text);
        let _ = std::fs::write(d.join(format!("{}-{}-ours.gcode", m.name, vname.replace(['=', ' ', '/', '%'], "_"))), &ours_text);
    }
    if plant {
        let ctl = plant_control(&orca_stats, &ours_text, &opts);
        let (v, d) = if ctl.cannot_run { (Status::Pending, format!("control could not run: {}", ctl.detail)) } else if ctl.caught { (Status::Pass, format!("plant CAUGHT: {}", ctl.detail)) } else { (Status::Fail, format!("plant MISSED: {}", ctl.detail)) };
        let (r, _) = mk(v, d, false, None);
        return (r, Some(ctl));
    }
    let us = match parse(&ours_text) {
        Ok(s) => s,
        Err(e) => return mk(Status::Fail, format!("OUR G-code unreadable: {e}"), false, None),
    };
    let rep = compare(&orca_stats, &us, &opts);
    let detail = match rep.worst_row() {
        Some(w) => format!("worst {}/{} {}{}", w.group, w.metric, w.pct.map_or("".into(), |p| format!("{p:+.1}% ")), if w.status == Status::Pass { String::new() } else { format!("[{}] {}", w.status.label(), w.note) }),
        None => "no judged rows".into(),
    };
    let rep_kept = if rep.verdict == Status::Pass { None } else { Some(rep.clone()) };
    mk(rep.verdict, detail, false, rep_kept)
}

fn report_plant_matrix(all: &[(CaseResult, Option<Control>)], population: usize, json: bool) -> i32 {
    let ran: Vec<&Control> = all.iter().filter_map(|x| x.1.as_ref()).filter(|c| !c.cannot_run).collect();
    let caught = ran.iter().filter(|c| c.caught).count();
    let missed = ran.len() - caught;
    let cannot = population - ran.len();
    if json {
        println!("{}", serde_json::json!({"control": "plant +15% wall length", "population": population, "caught": caught, "missed": missed, "could_not_run": cannot}));
    } else {
        println!("\nNEGATIVE CONTROL (+15% wall length planted in a copy of every 'ours')\nPOPULATION {population}   CAUGHT {caught}   MISSED {missed}   COULD NOT RUN {cannot}");
    }
    if missed > 0 {
        1
    } else if cannot > 0 || caught == 0 {
        2
    } else {
        0
    }
}

fn mode_selftest() -> i32 {
    let mut ok = true;
    let mut check = |name: &str, pass: bool, detail: String| {
        println!("{:<4} {name}  {detail}", if pass { "ok" } else { "BAD" });
        ok &= pass;
    };
    let g = synthetic_gcode(8, 20.0);
    let o = Options::default();
    let r = compare_text(&g, &g, &o).unwrap();
    check("identical files -> PASS over a non-empty population", r.verdict == Status::Pass && r.population.judged_rows > 20, format!("judged rows {}", r.population.judged_rows));
    let planted = plant_wall_scale(&g, 1.15);
    let r = compare_text(&g, &planted, &o).unwrap();
    check("NEGATIVE CONTROL +15% wall length -> FAIL", r.verdict == Status::Fail && r.row("feature:Outer wall", "path_mm").map(|x| x.status) == Some(Status::Fail), format!("outer wall {:+.1}%", r.row("feature:Outer wall", "path_mm").and_then(|x| x.pct).unwrap_or(f64::NAN)));
    let ctl = plant_control(&parse(&g).unwrap(), &g, &o);
    check("plant_control catches the plant", ctl.caught, ctl.detail);
    let r = compare_text(&g, &plant_drop_feature(&g, "Sparse infill"), &o).unwrap();
    check("feature missing in ours -> FAIL (never skipped)", r.row("feature:Sparse infill", "path_mm").map(|x| x.status) == Some(Status::Fail), String::new());
    let r = compare_text(&g, &plant_z_shift(&g, 0.05), &o).unwrap();
    check("layer z shifted 0.05 -> FAIL", r.row("layers", "z_max_abs_diff").map(|x| x.status) == Some(Status::Fail), String::new());
    let nowidth: String = g.lines().filter(|l| !l.starts_with("; LINE_WIDTH")).map(|l| format!("{l}\n")).collect();
    let r = compare_text(&g, &nowidth, &o).unwrap();
    check("ours without LINE_WIDTH -> PENDING, never PASS", r.verdict == Status::Pending && r.exit_code() == 2, format!("verdict {}", r.verdict.label()));
    let e = MatrixSummary::new(0, 3, vec![]);
    check("empty matrix population -> PENDING exit 2", e.exit_code() == 2 && e.verdict() == "PENDING", format!("population {}", e.population));
    println!("{}", if ok { "SELFTEST OK" } else { "SELFTEST FAILED" });
    if ok { 0 } else { 1 }
}

fn main() {
    let a = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let code = if a.has("selftest") {
        mode_selftest()
    } else if a.has("matrix") || a.has("list") {
        mode_matrix(&a)
    } else {
        mode_pair(&a)
    };
    std::process::exit(code);
}
